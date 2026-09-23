import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";

import { createProvisioningInputProtector } from "../../packages/occ/src/provisioning-inputs.ts";

function key() {
  return randomBytes(32).toString("base64url");
}

function context(overrides = {}) {
  return {
    installationId: "ins_provisioning_inputs",
    namespaceId: "ns_provisioning_inputs",
    agentId: "agt_provisioning_inputs",
    workId: "work_provisioning_inputs",
    slot: "secret:provider-api-key",
    ...overrides,
  };
}

test("provisioning inputs seal values and bind them to the provisioning context", () => {
  const protector = createProvisioningInputProtector({
    primaryKeyId: "key-a",
    keys: [{ id: "key-a", material: key() }],
  });
  const value = `secret-${randomUUID()}`;
  const protectedInput = protector.protect(value, context());

  assert.equal(protectedInput.sealed.keyId, "key-a");
  assert.equal(protector.reveal(protectedInput.sealed, context()), value);
  assert.equal(JSON.stringify(protectedInput).includes(value), false);

  assert.throws(
    () => protector.reveal(protectedInput.sealed, context({ slot: "secret:other" })),
    /failed authentication/,
  );

  const tampered = {
    ...protectedInput.sealed,
    ciphertext: protectedInput.sealed.ciphertext.replace(/^./u, (char) =>
      char === "A" ? "B" : "A",
    ),
  };
  assert.throws(() => protector.reveal(tampered, context()), /failed authentication/);
});

test("provisioning input fingerprints support exact replay across key rotation", () => {
  const firstKey = key();
  const secondKey = key();
  const value = `rotated-${randomUUID()}`;
  const original = createProvisioningInputProtector({
    primaryKeyId: "key-a",
    keys: [{ id: "key-a", material: firstKey }],
  });
  const protectedInput = original.protect(value, context());

  const rotated = createProvisioningInputProtector({
    primaryKeyId: "key-b",
    keys: [
      { id: "key-a", material: firstKey },
      { id: "key-b", material: secondKey },
    ],
  });

  assert.equal(rotated.primaryKeyId, "key-b");
  assert.equal(rotated.reveal(protectedInput.sealed, context()), value);
  assert.equal(rotated.matchesFingerprint(value, context(), protectedInput.fingerprint), true);
  assert.deepEqual(
    rotated.fingerprint(value, context(), protectedInput.fingerprint.keyId),
    protectedInput.fingerprint,
  );

  const replacement = rotated.protect(value, context());
  assert.equal(replacement.sealed.keyId, "key-b");
  assert.equal(replacement.fingerprint.keyId, "key-b");
  assert.notEqual(replacement.fingerprint.digest, protectedInput.fingerprint.digest);
});

test("provisioning inputs fail closed when a retained key is unavailable", () => {
  const protectedInput = createProvisioningInputProtector({
    primaryKeyId: "key-a",
    keys: [{ id: "key-a", material: key() }],
  }).protect(`unavailable-${randomUUID()}`, context());

  const withoutRetainedKey = createProvisioningInputProtector({
    primaryKeyId: "key-b",
    keys: [{ id: "key-b", material: key() }],
  });

  assert.throws(
    () => withoutRetainedKey.reveal(protectedInput.sealed, context()),
    /key is unavailable/,
  );
  assert.throws(
    () => withoutRetainedKey.matchesFingerprint("anything", context(), protectedInput.fingerprint),
    /key is unavailable/,
  );
});
