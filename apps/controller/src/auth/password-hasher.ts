import { hashPassword, verifyPassword } from "better-auth/crypto";

/**
 * Hashes and verifies local account passwords. Every controller password hash goes through
 * one: Better Auth's sign-in and account preparation, the external-sign-in profile's
 * password endpoint (including its dummy hash for refused emails, which keeps timing even)
 * and `hashLocalPassword`.
 */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(input: { readonly hash: string; readonly password: string }): Promise<boolean>;
}

/**
 * The controller's production password hasher: Better Auth's node:crypto scrypt (N=16384,
 * r=16, p=1, 64-byte key, 16-byte random salt), stored as `<salt hex>:<key hex>`. Deployments
 * cannot replace it: no environment variable or configuration file selects a hasher, and the
 * production and development compositions read one only from their code-only dependencies
 * argument, which API startup never passes.
 */
export const scryptPasswordHasher: PasswordHasher = Object.freeze({
  hash: (password: string) => hashPassword(password),
  verify: (input: { readonly hash: string; readonly password: string }) =>
    verifyPassword({ hash: input.hash, password: input.password }),
});
