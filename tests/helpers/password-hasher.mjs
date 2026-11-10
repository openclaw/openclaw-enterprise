// The fixtures' password hasher and the controller constructors that use it. Tests build a
// controller through these wrappers, not the product's constructors, so this module alone
// decides how fixtures hash passwords.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createControllerAuth as createControllerAuthWith,
  createPostgresControllerAuth as createPostgresControllerAuthWith,
  scryptPasswordHasher,
} from "../../apps/controller/src/auth/index.ts";

export { scryptPasswordHasher };

const TEST_HASH_LABEL = "test-sha256";
const scryptVerifications = new Map();

function testDigest(salt, password) {
  return createHash("sha256")
    .update(`${salt}\0${password.normalize("NFKC")}`)
    .digest();
}

/**
 * The fixtures' password hasher: one salted SHA-256 instead of a ~0.1 CPU-s scrypt, for tests
 * that do not exercise hashing cost or format. Its hashes are `test-sha256:<salt>:<digest>`,
 * which the controller's scrypt hasher refuses (the key never matches), so a test hash can
 * never sign in to a controller composed without this hasher. It verifies any other stored
 * hash with the real scrypt hasher, so fixtures may sign in to accounts that a production
 * entry point (scripts/bootstrap-installation.mjs, hashLocalPassword) wrote. Those results are
 * remembered per hash and password for the process: a fixture signs its bootstrap
 * administrator in many times, and scrypt gives the same answer every time.
 *
 * Tests whose subject is the hash cost, timing or stored format pass `scryptPasswordHasher`
 * instead (postgres-password-sign-in-limit; postgres-password-default checks the default).
 */
export const testPasswordHasher = Object.freeze({
  async hash(password) {
    const salt = randomBytes(16).toString("hex");
    return `${TEST_HASH_LABEL}:${salt}:${testDigest(salt, password).toString("hex")}`;
  },
  async verify({ hash, password }) {
    const [label, salt, key, ...rest] = hash.split(":");
    if (label !== TEST_HASH_LABEL) {
      const remembered = `${hash}\0${password}`;
      if (!scryptVerifications.has(remembered)) {
        scryptVerifications.set(remembered, scryptPasswordHasher.verify({ hash, password }));
      }
      return scryptVerifications.get(remembered);
    }
    if (!salt || !key || rest.length > 0 || !/^[0-9a-f]{64}$/.test(key)) {
      return false;
    }
    return timingSafeEqual(testDigest(salt, password), Buffer.from(key, "hex"));
  },
});

// The fixtures' controller constructors: the product's, with `testPasswordHasher` unless the
// caller passes a `passwordHasher`. Test files and helpers import these instead of the
// product's so one module chooses the fixtures' hasher.

export function createControllerAuth(options) {
  return createControllerAuthWith({ passwordHasher: testPasswordHasher, ...options });
}

export function createPostgresControllerAuth(options) {
  return createPostgresControllerAuthWith({ passwordHasher: testPasswordHasher, ...options });
}

export async function composeProduction(config, dependencies = {}) {
  const { composeProduction: compose } =
    await import("../../apps/controller/src/composition/production.ts");
  return compose(config, { passwordHasher: testPasswordHasher, ...dependencies });
}

export async function composePostgresDevelopment(
  config,
  options,
  serviceAccountDriverFactory,
  dependencies = {},
) {
  const { composePostgresDevelopment: compose } =
    await import("../../apps/controller/src/composition/development-postgres.ts");
  return compose(config, options, serviceAccountDriverFactory, {
    passwordHasher: testPasswordHasher,
    ...dependencies,
  });
}
