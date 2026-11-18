import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createControllerAuth as createControllerAuthWith,
  createPostgresControllerAuth as createPostgresControllerAuthWith,
  scryptPasswordHasher,
  type PasswordHasher,
} from "../../apps/controller/src/auth/index.ts";
import type { composePostgresDevelopment as composePostgresDevelopmentWith } from "../../apps/controller/src/composition/development-postgres.ts";
import type { composeProduction as composeProductionWith } from "../../apps/controller/src/composition/production.ts";

export { scryptPasswordHasher };

type DevelopmentArgs = Parameters<typeof composePostgresDevelopmentWith>;
type ProductionArgs = Parameters<typeof composeProductionWith>;

const TEST_HASH_LABEL = "test-sha256";
const scryptVerifications = new Map<string, Promise<boolean>>();

function testDigest(salt: string, password: string) {
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
 * entry point (scripts/bootstrap-installation.ts, hashLocalPassword) wrote. Those results are
 * remembered per hash and password for the process: a fixture signs its bootstrap
 * administrator in many times, and scrypt gives the same answer every time.
 *
 * Tests whose subject is the hash cost, timing or stored format pass `scryptPasswordHasher`
 * instead (postgres-password-sign-in-limit; postgres-password-default checks the default).
 */
export const testPasswordHasher = Object.freeze<PasswordHasher>({
  async hash(password) {
    const salt = randomBytes(16).toString("hex");
    return `${TEST_HASH_LABEL}:${salt}:${testDigest(salt, password).toString("hex")}`;
  },
  async verify({ hash, password }) {
    const [label, salt, key, ...rest] = hash.split(":");
    if (label !== TEST_HASH_LABEL) {
      const cacheKey = JSON.stringify([hash, password]);
      const cached = scryptVerifications.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
      const verification = scryptPasswordHasher.verify({ hash, password });
      scryptVerifications.set(cacheKey, verification);
      return verification;
    }
    if (
      !salt ||
      !/^[0-9a-f]{32}$/.test(salt) ||
      !key ||
      rest.length > 0 ||
      !/^[0-9a-f]{64}$/.test(key)
    ) {
      return false;
    }
    return timingSafeEqual(testDigest(salt, password), Buffer.from(key, "hex"));
  },
});

export function createControllerAuth(options: Parameters<typeof createControllerAuthWith>[0]) {
  return createControllerAuthWith({ passwordHasher: testPasswordHasher, ...options });
}

export function createPostgresControllerAuth(
  options: Parameters<typeof createPostgresControllerAuthWith>[0],
) {
  return createPostgresControllerAuthWith({ passwordHasher: testPasswordHasher, ...options });
}

export async function composeProduction(
  config: ProductionArgs[0],
  dependencies: ProductionArgs[1] = {},
): ReturnType<typeof composeProductionWith> {
  const { composeProduction: compose } =
    await import("../../apps/controller/src/composition/production.ts");
  return compose(config, { passwordHasher: testPasswordHasher, ...dependencies });
}

export async function composePostgresDevelopment(
  config: DevelopmentArgs[0],
  options?: DevelopmentArgs[1],
  serviceAccountDriverFactory?: DevelopmentArgs[2],
  dependencies: DevelopmentArgs[3] = {},
): ReturnType<typeof composePostgresDevelopmentWith> {
  const { composePostgresDevelopment: compose } =
    await import("../../apps/controller/src/composition/development-postgres.ts");
  return compose(config, options, serviceAccountDriverFactory, {
    passwordHasher: testPasswordHasher,
    ...dependencies,
  });
}
