import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("runtime assembly preserves executable assets and links while excluding development files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-assets-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "source");
  const output = join(directory, "output");
  const files = {
    "package.json": '{"packageManager":"pnpm@12.4.2","dependencies":{"dep":"1.0.0"}}',
    "pnpm-lock.yaml": `lockfileVersion: '9.0'

packages:
  '@openai/codex@0.156.0':
    resolution: {integrity: sha512-codex}
  '@openai/codex-linux-arm64@0.156.0':
    resolution: {integrity: sha512-codexlinuxarm}
  '@openai/codex-linux-x64@0.156.0':
    resolution: {integrity: sha512-codexlinux}
`,
    "dist/index.js": "export const ready = true;\n",
    "openclaw.mjs":
      'import { ready } from "./node-compile-cache.mjs"; process.stdout.write(ready);\n',
    "node-compile-cache.mjs": 'export const ready = "runtime-ready";\n',
    "extensions/slack/skills/slack/SKILL.md": "Slack runtime skill",
    "extensions/slack/src/client.test.ts": "development test",
    "extensions/slack/__tests__/fixture.json": "{}",
    "docs/help.md": "Runtime help",
    "docs/images/screenshot.png": "image bytes",
    "qa/scenario.json": "{}",
    "src/server.ts": "development source",
    "dist/extensions/codex/package.json": '{"dependencies":{"@openai/codex":"0.156.0"}}',
    "node_modules/codex/bin.js": "#!/usr/bin/env node\n",
    "node_modules/.pnpm/@openai+codex@0.156.0/node_modules/@openai/codex/package.json":
      '{"name":"@openai/codex","version":"0.156.0","optionalDependencies":{"@openai/codex-linux-x64":"0.156.0"}}',
    "node_modules/.pnpm/@openai+codex@0.156.0/node_modules/@openai/codex-linux-arm64/package.json":
      '{"name":"@openai/codex-linux-arm64","version":"0.156.0"}',
    "node_modules/.pnpm/@openai+codex@0.156.0/node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex":
      "#!/usr/bin/env node\nconsole.log('codex-cli 0.156.0');\n",
    "node_modules/.pnpm/@openai+codex@0.156.0/node_modules/@openai/codex-linux-x64/package.json":
      '{"name":"@openai/codex-linux-x64","version":"0.156.0"}',
    "node_modules/.pnpm/@openai+codex@0.156.0/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex":
      "#!/usr/bin/env node\nconsole.log('codex-cli 0.156.0');\n",
    LICENSE: "license notice",
    "node_modules/.pnpm/dep@1.0.0/node_modules/dep/package.json":
      '{"name":"dep","version":"1.0.0"}',
    "node_modules/.pnpm/dep@2.0.0/node_modules/dep/package.json":
      '{"name":"dep","version":"2.0.0","optionalDependencies":{"optional":"1.0.0"}}',
    "node_modules/.pnpm/optional@1.0.0/node_modules/optional/package.json":
      '{"name":"optional","version":"1.0.0"}',
    "node_modules/.pnpm/unused@1.0.0/node_modules/unused/package.json":
      '{"name":"unused","version":"1.0.0"}',
    "extensions/slack/package.json": '{"dependencies":{"dep":"2.0.0"}}',
    "extensions/.npmignore": "*.test.ts",
  };
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), bytes, {
      mode: name.endsWith("bin.js") || name.endsWith("/codex") ? 0o755 : 0o644,
    });
  }
  await mkdir(join(root, "node_modules/.bin"));
  await symlink("../codex/bin.js", join(root, "node_modules/.bin/codex"));
  await mkdir(join(root, "node_modules/@openai"), { recursive: true });
  await symlink(
    "../.pnpm/@openai+codex@0.156.0/node_modules/@openai/codex",
    join(root, "node_modules/@openai/codex"),
  );
  await symlink(
    "../.pnpm/@openai+codex@0.156.0/node_modules/@openai/codex-linux-arm64",
    join(root, "node_modules/@openai/codex-linux-arm64"),
  );
  await symlink(
    "../.pnpm/@openai+codex@0.156.0/node_modules/@openai/codex-linux-x64",
    join(root, "node_modules/@openai/codex-linux-x64"),
  );
  await symlink(".pnpm/dep@1.0.0/node_modules/dep", join(root, "node_modules/dep"));
  await mkdir(join(root, "extensions/slack/node_modules"));
  await symlink(
    "../../../node_modules/.pnpm/dep@2.0.0/node_modules/dep",
    join(root, "extensions/slack/node_modules/dep"),
  );
  await symlink(
    "../../optional@1.0.0/node_modules/optional",
    join(root, "node_modules/.pnpm/dep@2.0.0/node_modules/optional"),
  );
  const sourceAlias = join(directory, "source-alias");
  await symlink(root, sourceAlias, "dir");
  execFileSync(
    process.execPath,
    ["scripts/build-runtime-assets.mjs", "package", sourceAlias, output],
    {
      env: { ...process.env, GIT_COMMIT: "a".repeat(40) },
    },
  );
  for (const name of [
    "src",
    "qa",
    "docs/images",
    "extensions/slack/src/client.test.ts",
    "extensions/slack/__tests__",
    "node_modules/.pnpm/unused@1.0.0/node_modules/unused/package.json",
  ]) {
    await assert.rejects(readFile(join(root, name)), { code: "ENOENT" });
  }
  const contents = await readFile(join(output, "contents.json"));
  // The pinned upstream launcher imports this sibling before loading dist.
  assert.equal(
    execFileSync(process.execPath, [join(root, "openclaw.mjs")], { encoding: "utf8" }),
    "runtime-ready",
  );
  const manifest = JSON.parse(contents);
  for (const name of [
    "node_modules/.pnpm/dep@1.0.0/node_modules/dep/package.json",
    "node_modules/.pnpm/dep@2.0.0/node_modules/dep/package.json",
    "node_modules/.pnpm/optional@1.0.0/node_modules/optional/package.json",
    "dist/index.js",
    "docs/help.md",
    "extensions/slack/skills/slack/SKILL.md",
    "LICENSE",
  ]) {
    assert.equal(await readFile(join(root, name), "utf8"), files[name]);
    assert.equal(
      manifest.find((entry) => entry.path === name).sha256,
      createHash("sha256").update(files[name]).digest("hex"),
    );
  }
  assert.equal(manifest.find((entry) => entry.path === "node_modules/codex/bin.js").mode, 0o755);
  assert.equal(await readlink(join(root, "node_modules/.bin/codex")), "../codex/bin.js");
  assert.equal(
    manifest.find((entry) => entry.path === "node_modules/.bin/codex").link,
    "../codex/bin.js",
  );
  const provenance = JSON.parse(await readFile(join(output, "provenance.json"), "utf8"));
  assert.equal(
    provenance.runtimeContentsSha256,
    createHash("sha256").update(contents).digest("hex"),
  );
  assert.equal(provenance.codex.version, "0.156.0");
  assert.equal(Object.hasOwn(provenance, "codexPatchSha256"), false);
  assert.equal(Object.hasOwn(provenance, "codexVersion"), false);
});
