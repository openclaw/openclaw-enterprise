import assert from "node:assert/strict";
import { createHash, scryptSync } from "node:crypto";
import test from "node:test";

import { scryptPasswordHasher, testPasswordHasher } from "./password-hasher.ts";

test("fixture hashes cannot overlap production scrypt hashes", async () => {
  const password = "format-boundary";
  const salt = scryptSync(password, "test-sha256", 64, {
    N: 16384,
    r: 16,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  }).toString("hex");
  const digest = createHash("sha256").update(`${salt}\0${password}`).digest("hex");
  const hash = `test-sha256:${salt}:${digest}`;

  // The production dependency reads the first two fields; the fixture must reject
  // this correctly digested but noncanonical fixture salt.
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
