import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

test("runtime source arguments reject missing, malformed, and conflicting identity", async (t) => {
  const directory = await temporaryDirectory(t, "openclaw-source-");
  const manifest = join(directory, "source.json");
  const source = {
    commit: "a".repeat(40),
    sourceArchiveSha256: "b".repeat(64),
    buildTimestamp: "2026-01-02T03:04:05Z",
  };
  const values = {
    OPENCLAW_COMMIT: source.commit,
    OPENCLAW_SOURCE_SHA256: source.sourceArchiveSha256,
    OPENCLAW_BUILD_TIMESTAMP: source.buildTimestamp,
  };
  const run = (command: string, env: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, ["scripts/lib/openclaw-source.mjs", command, manifest], {
      encoding: "utf8",
      env: { ...process.env, ...values, ...env },
    });

  // The same executable supplies host build arguments and guards the Docker download.
  const missing = run("build-args");
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /ENOENT/);
  await writeFile(manifest, JSON.stringify(source));
  const argumentsResult = run("build-args");
  assert.equal(argumentsResult.status, 0, argumentsResult.stderr);
  assert.equal(
    argumentsResult.stdout,
    `OPENCLAW_COMMIT=${source.commit}\nOPENCLAW_SOURCE_SHA256=${source.sourceArchiveSha256}\nOPENCLAW_BUILD_TIMESTAMP=${source.buildTimestamp}\n`,
  );
  const accepted = run("verify");
  assert.equal(accepted.status, 0, accepted.stderr);
  for (const key of Object.keys(values)) {
    for (const value of [undefined, "conflicting-value"]) {
      const refused = run("verify", { [key]: value });
      assert.notEqual(refused.status, 0);
      assert.ok(refused.stderr.includes(`${key} must match`), refused.stderr);
    }
  }

  // Corrupt input must not emit partial arguments that a caller could accidentally use.
  for (const bytes of [
    "{",
    JSON.stringify({ ...source, commit: "main" }),
    JSON.stringify({ ...source, sourceArchiveSha256: "" }),
    JSON.stringify({ ...source, buildTimestamp: "2026-02-30T03:04:05Z" }),
    JSON.stringify({ commit: source.commit }),
    JSON.stringify({ ...source, override: true }),
  ]) {
    await writeFile(manifest, bytes);
    const refused = run("build-args");
    assert.notEqual(refused.status, 0);
    assert.equal(refused.stdout, "");
  }
});
