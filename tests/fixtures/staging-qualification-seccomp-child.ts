import assert from "node:assert/strict";
import test from "node:test";
import { reviewedCodexSeccompSecurityOptions } from "../helpers/runtime-image-startup.mjs";

test("runtime startup child consumes the reviewed Codex startup inputs", async () => {
  const profile = process.env.OCC_TEST_CODEX_SECCOMP_PROFILE;
  assert.ok(profile);
  assert.equal(process.env.OCC_TEST_STAGING_UNDECLARED, undefined);
  const version = process.env.OCC_TEST_STAGING_CODEX_VERSION;
  if (version === undefined) {
    assert.equal(process.env.OCC_TEST_PRODUCTION_IMAGE, undefined);
    assert.equal(process.env.EXPECTED_OCC_REVISION, undefined);
  } else {
    assert.equal(version, "0.163.0-alpha.2");
    assert.equal(process.env.OCC_TEST_PRODUCTION_IMAGE, `sha256:${"c".repeat(64)}`);
    assert.equal(process.env.EXPECTED_OCC_REVISION, "54bfa7fc1b99e362450beb5f9211e164991fa7b4");
  }
  assert.deepEqual(
    await reviewedCodexSeccompSecurityOptions({
      codexVersion: version,
    }),
    ["--security-opt", "no-new-privileges", "--security-opt", `seccomp=${profile}`],
  );
});
