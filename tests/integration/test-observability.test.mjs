import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

test("observability launcher propagates preparation failure and removes its owned state", async (t) => {
  // Fail real preparation before cluster creation. This checks the actual local
  // entrypoint and cleanup, without a fake engine implementing the answer.
  const result = spawnSync(process.execPath, ["scripts/test-observability.mjs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENAI_API_KEY: "unused-model-credential-sentinel",
      OCC_HELM_BIN: "/nonexistent/observability-helm",
    },
    timeout: 30_000,
  });
  assert.equal(result.status, 1);
  const output = result.stdout + result.stderr;
  assert.match(output, /Running k3d-observability/);
  assert.ok(!output.includes("unused-model-credential-sentinel"));
  const results = result.stdout.match(/Results: (.+results\.json)/)?.[1];
  assert.ok(results);
  const directory = dirname(results);
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  await assert.rejects(access(join(directory, "state.json")), { code: "ENOENT" });
});

test("observability model turns fail credential preflight before provisioning", () => {
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  const result = spawnSync(process.execPath, ["scripts/test-observability.mjs", "--model-turns"], {
    encoding: "utf8",
    env,
    timeout: 30_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /OPENAI_API_KEY is required/);
  assert.ok(!result.stdout.includes("Results:"));
});
