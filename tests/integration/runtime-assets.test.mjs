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
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "dist/index.js": "export const ready = true;\n",
    "extensions/slack/skills/slack/SKILL.md": "Slack runtime skill",
    "extensions/slack/src/client.test.ts": "development test",
    "extensions/slack/__tests__/fixture.json": "{}",
    "docs/help.md": "Runtime help",
    "docs/images/screenshot.png": "image bytes",
    "qa/scenario.json": "{}",
    "src/server.ts": "development source",
    "node_modules/codex/bin.js": "#!/usr/bin/env node\n",
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
    await writeFile(join(root, name), bytes, { mode: name.endsWith("bin.js") ? 0o755 : 0o644 });
  }
  await mkdir(join(root, "node_modules/.bin"));
  await symlink("../codex/bin.js", join(root, "node_modules/.bin/codex"));
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
  const patch = join(directory, "codex.patch");
  await writeFile(patch, "reviewed dependency patch");
  execFileSync(
    process.execPath,
    ["scripts/build-runtime-assets.mjs", "package", root, output, patch],
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
  assert.equal(provenance.codexVersion, "0.156.0");
});
