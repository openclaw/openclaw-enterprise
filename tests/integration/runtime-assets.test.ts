import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readOpenclawSource } from "../../scripts/lib/openclaw-source.ts";
import {
  parseRuntimeDownloadClientSelection,
  readRuntimeDownloadClients,
} from "../../scripts/lib/runtime-download-clients.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";
import { GATEWAY_RESTART_RESUME_SCOPE } from "../../apps/controller/src/drivers/compute/runtime-startup.ts";

type RuntimeAsset =
  { path: string; link: string } | { path: string; size: number; mode: number; sha256: string };

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
}

function parseInventory(contents: string): ReadonlyMap<string, RuntimeAsset> {
  const inventory: unknown = JSON.parse(contents);
  assert.ok(Array.isArray(inventory), "Expected a runtime asset inventory");
  const entries: readonly unknown[] = inventory;
  const assets = new Map<string, RuntimeAsset>();
  for (const entry of entries) {
    assertRecord(entry);
    const { path, link, size, mode, sha256 } = entry;
    assert.ok(typeof path === "string" && !assets.has(path), "Expected a unique inventory path");
    if (typeof link === "string") {
      assets.set(path, { path, link });
    } else {
      assert.ok(
        typeof size === "number" && typeof mode === "number" && typeof sha256 === "string",
        `Expected file metadata for ${path}`,
      );
      assets.set(path, { path, size, mode, sha256 });
    }
  }
  return assets;
}

test("final image inventory measures selected native download clients and rejects invalid executables", async (t) => {
  const directory = await temporaryDirectory(t, "runtime-clients-");
  const root = join(directory, "image");

  const added = "/opt/tools/bin/downloader";
  const selection = parseRuntimeDownloadClientSelection(JSON.stringify([added]));
  for (const invalid of [
    [added, added],
    ["/usr/bin/curl"],
    ["/opt/tools/../bin/downloader"],
    ["opt/tools/bin/downloader"],
  ]) {
    assert.throws(
      () => parseRuntimeDownloadClientSelection(JSON.stringify(invalid)),
      /Invalid or duplicate/,
    );
  }

  const curl = join(root, "usr/bin/curl");
  const http = join(root, "usr/lib/apt/methods/http");
  const https = join(root, "usr/lib/apt/methods/https");
  const node = join(root, "usr/local/bin/node");
  const additional = join(root, added);
  await assert.rejects(readRuntimeDownloadClients(selection, root), { code: "ENOENT" });
  // The fixture header lets the test distinguish native and foreign binaries without running either.
  const native = Buffer.alloc(64);
  native.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  native.writeUInt16LE(3, 16);
  const machine = process.arch === "arm64" ? 183 : 62;
  native.writeUInt16LE(machine, 18);
  for (const path of [curl, http, node, additional]) {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, native, { mode: 0o755 });
  }
  await symlink("http", https);

  const digest = createHash("sha256").update(native).digest("hex");
  assert.deepEqual(await readRuntimeDownloadClients(selection, root), {
    "/usr/bin/curl": { resolvedBinary: "/usr/bin/curl", binarySha256: digest },
    "/usr/lib/apt/methods/http": {
      resolvedBinary: "/usr/lib/apt/methods/http",
      binarySha256: digest,
    },
    "/usr/lib/apt/methods/https": {
      resolvedBinary: "/usr/lib/apt/methods/http",
      binarySha256: digest,
    },
    "/usr/local/bin/node": { resolvedBinary: "/usr/local/bin/node", binarySha256: digest },
    [added]: { resolvedBinary: added, binarySha256: digest },
  });

  await chmod(additional, 0o644);
  await assert.rejects(readRuntimeDownloadClients(selection, root), /must be an executable file/);
  await chmod(additional, 0o755);
  await writeFile(additional, "#!/bin/sh\n");
  await assert.rejects(readRuntimeDownloadClients(selection, root), /Expected a native .* ELF/);
  native.writeUInt16LE(machine === 183 ? 62 : 183, 18);
  await writeFile(additional, native);
  await assert.rejects(readRuntimeDownloadClients(selection, root), /Expected a native .* ELF/);

  await rm(additional);
  await symlink(curl, additional);
  await assert.rejects(
    readRuntimeDownloadClients(selection, root),
    /resolves to an unexpected path/,
  );
  await rm(additional);
  const outside = join(directory, "outside");
  await writeFile(outside, native, { mode: 0o755 });
  await symlink(outside, additional);
  await assert.rejects(readRuntimeDownloadClients(selection, root), /resolves outside the image/);
});

test("Google packaging refuses substituted ClawHub skill bytes before installing the CLI", async (t) => {
  const directory = await temporaryDirectory(t, "runtime-google-");
  const upstream = join(directory, "upstream.md");
  await writeFile(upstream, "Changed instructions under the same ClawHub version.\n");
  const google = new URL("../../apps/controller/plugins/oce-google-workspace/", import.meta.url);
  await symlink(new URL("skills/", google), join(directory, "skills"), "dir");
  const manifest: unknown = JSON.parse(
    await readFile(new URL("ai.openclaw.oce/release.json", google), "utf8"),
  );
  assertRecord(manifest);
  assertRecord(manifest.clawhub);
  assertRecord(manifest.artifacts);
  const artifact = manifest.artifacts["linux-amd64"];
  assertRecord(artifact);
  manifest.clawhub.sourceUrl = pathToFileURL(upstream).href;
  artifact.url = pathToFileURL(join(directory, "unreachable-archive")).href;
  await writeFile(join(directory, "release.json"), JSON.stringify(manifest));
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../../deploy/runtime/google/install-gog.mts", import.meta.url)),
      directory,
      "linux-amd64",
      directory,
      fileURLToPath(new URL("../../scripts/ci/download-pinned.sh", import.meta.url)),
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checksum did NOT match/);
  await assert.rejects(readFile(join(directory, "gog")), { code: "ENOENT" });
});

test("runtime assembly preserves executable assets and links while excluding development files", async (t) => {
  const directory = await temporaryDirectory(t, "runtime-assets-");
  const root = join(directory, "source");
  const output = join(directory, "output");
  const files = {
    "package.json": '{"packageManager":"pnpm@12.4.2","dependencies":{"dep":"1.0.0"}}',
    "pnpm-lock.yaml": `lockfileVersion: '9.0'

packages:
  '@openai/codex@0.158.0':
    resolution: {integrity: sha512-codex}
  '@openai/codex-linux-arm64@0.158.0':
    resolution: {integrity: sha512-codexlinuxarm}
  '@openai/codex-linux-x64@0.158.0':
    resolution: {integrity: sha512-codexlinux}
`,
    "dist/index.js": "export const ready = true;\n",
    "openclaw.mjs":
      'import { ready } from "./node-runtime-recovery.mjs"; process.stdout.write(ready);\n',
    "node-runtime-recovery.mjs": 'export { ready } from "./node-runtime-env.mjs";\n',
    "node-runtime-env.mjs": 'export { ready } from "./node-compile-cache.mjs";\n',
    "node-compile-cache.mjs": 'export const ready = "runtime-ready";\n',
    "extensions/slack/skills/slack/SKILL.md": "Slack runtime skill",
    "extensions/slack/src/client.test.ts": "development test",
    "extensions/slack/__tests__/fixture.json": "{}",
    "docs/help.md": "Runtime help",
    "docs/images/screenshot.png": "image bytes",
    "qa/scenario.json": "{}",
    "src/server.ts": "development source",
    "dist/extensions/codex/package.json": '{"dependencies":{"@openai/codex":"0.158.0"}}',
    "node_modules/codex/bin.js": { bytes: "#!/usr/bin/env node\n", mode: 0o755 },
    "node_modules/.pnpm/@openai+codex@0.158.0/node_modules/@openai/codex/package.json":
      '{"name":"@openai/codex","version":"0.158.0","optionalDependencies":{"@openai/codex-linux-x64":"0.158.0"}}',
    "node_modules/.pnpm/@openai+codex@0.158.0/node_modules/@openai/codex-linux-arm64/package.json":
      '{"name":"@openai/codex-linux-arm64","version":"0.158.0"}',
    "node_modules/.pnpm/@openai+codex@0.158.0/node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex":
      {
        bytes: "#!/usr/bin/env node\nconsole.log('codex-cli 0.158.0');\n",
        mode: 0o755,
      },
    "node_modules/.pnpm/@openai+codex@0.158.0/node_modules/@openai/codex-linux-x64/package.json":
      '{"name":"@openai/codex-linux-x64","version":"0.158.0"}',
    "node_modules/.pnpm/@openai+codex@0.158.0/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex":
      {
        bytes: "#!/usr/bin/env node\nconsole.log('codex-cli 0.158.0');\n",
        mode: 0o755,
      },
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
  for (const [name, file] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, typeof file === "string" ? file : file.bytes, { mode: 0o644 });
    // The executable mode must survive a restrictive umask in the test runner.
    if (typeof file !== "string") {
      await chmod(path, file.mode);
    }
  }
  await mkdir(join(root, "node_modules/.bin"));
  await symlink("../codex/bin.js", join(root, "node_modules/.bin/codex"));
  await mkdir(join(root, "node_modules/@openai"), { recursive: true });
  await symlink(
    "../.pnpm/@openai+codex@0.158.0/node_modules/@openai/codex",
    join(root, "node_modules/@openai/codex"),
  );
  await symlink(
    "../.pnpm/@openai+codex@0.158.0/node_modules/@openai/codex-linux-arm64",
    join(root, "node_modules/@openai/codex-linux-arm64"),
  );
  await symlink(
    "../.pnpm/@openai+codex@0.158.0/node_modules/@openai/codex-linux-x64",
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
  // This assembly fixture has its own identity; it is not an upstream source checkout.
  const sourceManifest = join(directory, "openclaw-source.json");
  const sourceIdentity = {
    commit: "a".repeat(40),
    sourceArchiveSha256: "b".repeat(64),
    buildTimestamp: "2026-01-01T00:00:00Z",
  };
  await writeFile(sourceManifest, JSON.stringify(sourceIdentity));
  // Refuse stale metadata before pruning the input tree or writing provenance.
  const refused = spawnSync(
    process.execPath,
    ["scripts/build-runtime-assets.ts", "package", sourceAlias, output, sourceManifest],
    { encoding: "utf8", env: { ...process.env, GIT_COMMIT: "c".repeat(40) } },
  );
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /GIT_COMMIT must match the OpenClaw source manifest/);
  assert.equal(await readFile(join(root, "src/server.ts"), "utf8"), files["src/server.ts"]);
  execFileSync(
    process.execPath,
    ["scripts/build-runtime-assets.ts", "package", sourceAlias, output, sourceManifest],
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
  const provenancePath = join(output, "provenance.json");
  // The launcher must retain transitive root-level imports before loading dist.
  assert.equal(
    execFileSync(process.execPath, [join(root, "openclaw.mjs")], { encoding: "utf8" }),
    "runtime-ready",
  );
  const inventory = parseInventory(contents.toString("utf8"));
  for (const name of [
    "node_modules/.pnpm/dep@1.0.0/node_modules/dep/package.json",
    "node_modules/.pnpm/dep@2.0.0/node_modules/dep/package.json",
    "node_modules/.pnpm/optional@1.0.0/node_modules/optional/package.json",
    "dist/index.js",
    "docs/help.md",
    "extensions/slack/skills/slack/SKILL.md",
    "LICENSE",
  ] as const) {
    assert.equal(await readFile(join(root, name), "utf8"), files[name]);
    const entry = inventory.get(name);
    assert.ok(entry && "sha256" in entry, `Missing file entry for ${name}`);
    assert.equal(entry.sha256, createHash("sha256").update(files[name]).digest("hex"));
  }
  const executable = inventory.get("node_modules/codex/bin.js");
  assert.ok(executable && "mode" in executable, "Missing Codex executable entry");
  assert.equal(executable.mode, 0o755);
  const launcher = inventory.get("node_modules/.bin/codex");
  assert.ok(launcher && "link" in launcher, "Missing Codex launcher symlink entry");
  assert.equal(await readlink(join(root, launcher.path)), "../codex/bin.js");
  assert.equal(launcher.link, "../codex/bin.js");

  const provenance: unknown = JSON.parse(await readFile(provenancePath, "utf8"));
  assertRecord(provenance);
  assertRecord(provenance.codex);
  const patches = provenance.patches;
  assertRecord(patches);
  assert.equal(provenance.commit, sourceIdentity.commit);
  assert.equal(provenance.sourceArchiveSha256, sourceIdentity.sourceArchiveSha256);
  assert.equal(
    provenance.runtimeContentsSha256,
    createHash("sha256").update(contents).digest("hex"),
  );
  assert.equal(provenance.codex.version, "0.158.0");
  assert.equal(Object.hasOwn(provenance, "downloadClients"), false);
  const nodeProvenance = join(directory, "node-provenance.json");
  await writeFile(
    nodeProvenance,
    JSON.stringify({
      architecture: process.arch,
      platform: process.platform,
      version: process.versions.node,
      sha256: createHash("sha256")
        .update(await readFile(process.execPath))
        .digest("hex"),
    }),
  );
  const unselected = spawnSync(
    process.execPath,
    ["scripts/build-runtime-assets.ts", "inventory", sourceAlias, output, nodeProvenance],
    { encoding: "utf8" },
  );
  assert.notEqual(unselected.status, 0);
  assert.match(unselected.stderr, /Runtime inventory requires the download client selection path/);
  const unchangedProvenance: unknown = JSON.parse(await readFile(provenancePath, "utf8"));
  assert.deepEqual(unchangedProvenance, provenance);
  assert.equal(Object.hasOwn(provenance, "codexPatchSha256"), false);
  assert.equal(Object.hasOwn(provenance, "codexVersion"), false);
  // Provenance must name every patch the image build applies, in order, so images with and
  // without a patch differ there (finding 2290: four applied patches were missing).
  const dockerfile = await readFile("deploy/runtime/Dockerfile", "utf8");
  const applied = [
    ...dockerfile.matchAll(
      /^COPY deploy\/runtime\/(\S+\.patch) \/tmp\/\1\nRUN echo '([a-f0-9]{64}) {2}\/tmp\/\1' \| sha256sum --check --strict \\\n\s+&& git apply /gm,
    ),
  ].map(([, file, sha256]): [string, string] => {
    assert.ok(file && sha256, "Expected an applied patch path and digest");
    return [file, sha256];
  });
  // Every patch kept beside the Dockerfile is copied, verified and applied in that form, and
  // each pinned hash is the file's own (a format the pattern misses fails here, not silently).
  const patchFiles = (await readdir("deploy/runtime")).filter((name) => name.endsWith(".patch"));
  assert.ok(patchFiles.length > 0);
  assert.deepEqual(applied.map(([file]) => file).sort(), patchFiles.sort());
  for (const [file, sha256] of applied) {
    const bytes = await readFile(join("deploy/runtime", file));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256, file);
  }
  assert.deepEqual(Object.entries(patches), applied);
  assert.equal(Object.hasOwn(provenance, "codexDependencyPinPatchSha256"), false);
  // The remaining per-patch fields keep their names and values.
  for (const [field, file] of [
    ["openclawBridgePatchSha256", "openclaw-codex-read-only-paths.patch"],
    [
      "openclawRequiredWorkerAuthorityRegressionPatchSha256",
      "openclaw-required-worker-authority-regression.patch",
    ],
  ] as const) {
    assert.equal(provenance[field], patches[file], field);
  }
});

// OCE sets GATEWAY_RESTART_RESUME_SCOPE on every Gateway to bound native recovery to its
// admitted lifecycle. The Kubernetes and Docker Drivers set the shared constant; the
// standalone SSH helper spells it out. A runtime patch adds the name until the pinned OpenClaw
// reads it; the patched tests run only in the manual image check. Record a pinned commit here
// only after checking that its own restart resume reads the name.
const NATIVE_RESTART_RESUME_SCOPE_COMMITS: readonly string[] = [];

test("the pinned runtime reads the Gateway restart-resume scope name OCE sets", async () => {
  const name = GATEWAY_RESTART_RESUME_SCOPE;
  const sshHelper = await readFile(
    "apps/controller/src/drivers/compute/ssh/remote-helper.cjs",
    "utf8",
  );
  assert.ok(
    sshHelper.includes(`\nEnvironment=${name}=\${revision.id}\n`),
    `SSH Compute must set ${name}`,
  );
  const patch = "openclaw-restart-resume-scope.patch";
  const dockerfile = await readFile("deploy/runtime/Dockerfile", "utf8");
  if (!dockerfile.includes(`COPY deploy/runtime/${patch} /tmp/${patch}\n`)) {
    // A pin bump dropped the patch: unless OpenClaw reads the name, a turn cut by stop resumes
    // at the next deployment again.
    const { commit } = await readOpenclawSource();
    assert.ok(
      NATIVE_RESTART_RESUME_SCOPE_COMMITS.includes(commit),
      `${patch} is no longer applied: check that OpenClaw ${commit} reads ${name}, then record the commit here`,
    );
    assert.doesNotMatch(dockerfile, /interrupted under scope/u);
    return;
  }
  // The patch's runtime lines, not only its tests, must read the name the Drivers set.
  let file = "";
  const runtimeLines: string[] = [];
  for (const line of (await readFile(join("deploy/runtime", patch), "utf8")).split("\n")) {
    if (line.startsWith("+++ b/")) {
      file = line.slice("+++ b/".length);
    } else if (line.startsWith("+") && file.startsWith("src/") && !file.endsWith(".test.ts")) {
      runtimeLines.push(line);
    }
  }
  assert.ok(
    runtimeLines.some((line) => line.includes(`"${name}"`)),
    `${patch} must read ${name}`,
  );
  assert.match(
    dockerfile.replace(/\\\n\s*/gu, " "),
    /session-restart-resume\.test\.ts\s+src\/config\/sessions\/session-entry-json\.test\.ts\s+-t "interrupted under scope\|keeps a graceful resume marker"/u,
  );
});
