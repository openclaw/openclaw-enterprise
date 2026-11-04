import assert from "node:assert/strict";
import test from "node:test";
import { reviewedCodexSeccompSecurityOptions } from "../helpers/runtime-image-startup.mjs";

test("runtime startup child consumes the CI-prepared Codex seccomp profile", async () => {
  const profile = process.env.OCC_TEST_CODEX_SECCOMP_PROFILE;
  assert.ok(profile);
  assert.equal(process.env.OCC_TEST_STAGING_UNDECLARED, undefined);
  // Historical startup must receive the controller selected from the publication receipt.
  assert.equal(process.env.OCC_TEST_PRODUCTION_IMAGE, `sha256:${"c".repeat(64)}`);
  assert.deepEqual(
    await reviewedCodexSeccompSecurityOptions({
      codexVersion: process.env.OCC_TEST_STAGING_CODEX_VERSION,
    }),
    ["--security-opt", "no-new-privileges", "--security-opt", `seccomp=${profile}`],
  );
});
