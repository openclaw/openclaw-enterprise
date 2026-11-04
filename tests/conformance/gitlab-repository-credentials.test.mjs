import assert from "node:assert/strict";
import test from "node:test";

import { createGitLabStaticTokenOwner } from "../../apps/controller/src/drivers/repo/gitlab/credentials/static-token.ts";

test("the static token owner lends a zeroed copy and can be closed", async () => {
  // Assemble the synthetic token at runtime so the source contains no token-shaped literal.
  const raw = Buffer.from(["gl", "pat", "-synthetic-validation-token"].join(""));
  const owner = createGitLabStaticTokenOwner({ token: raw });
  assert.equal(owner.tokenClass, "personal");
  let lent;
  await owner.withToken(async (bytes) => {
    lent = bytes;
    assert.equal(Buffer.from(bytes).toString(), raw.toString());
    return bytes.length;
  });
  assert.ok(
    lent.every((byte) => byte === 0),
    "the lent copy must be zeroed after use",
  );
  owner.close();
  await assert.rejects(
    owner.withToken(async () => undefined),
    /authority-unavailable/,
  );
});
