import assert from "node:assert/strict";
import test from "node:test";

import { scryptPasswordHasher, testPasswordHasher } from "./password-hasher.ts";

test("fixture hashes cannot overlap production scrypt hashes", async () => {
  const password = "format-boundary";
  // Known-answer vector: scrypt(password, "test-sha256", N=16384, r=16, p=1,
  // dkLen=64) gives the middle field; SHA-256(middle + NUL + password) gives
  // the final field. Production reads the first two fields; the fixture must
  // reject this correctly digested but noncanonical fixture salt.
  const hash =
    "test-sha256:c97d450f7da1552ffadc86732e3ff60523e38b4204ec492f9e3026732ad9676ba91eccb93a0e7be9d270be9b13df1e060d09179f3ed470e6ab8cfe23fc377c1b:43f255da4e14691f7e3af54f6ff57adbdb5284e0b8b92f6959e28a6158b1fd98";

  assert.equal(await scryptPasswordHasher.verify({ hash, password }), true);
  assert.equal(await testPasswordHasher.verify({ hash, password }), false);
});

test("cached scrypt results belong to an exact hash and password pair", async () => {
  const password = "first\0second";
  const hash = await scryptPasswordHasher.hash(password);
  const malformed = { hash: `${hash}\0first`, password: "second" };

  // These pairs collide if the cache joins its inputs with a NUL delimiter.
  assert.equal(await scryptPasswordHasher.verify(malformed), false);
  assert.equal(await testPasswordHasher.verify({ hash, password }), true);
  assert.equal(await testPasswordHasher.verify(malformed), false);
});
