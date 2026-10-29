import type { CredentialInputRead, VersionedSecretValue } from "./credential-proxy.ts";
import type { Driver } from "./driver.ts";
import type { Secret, SecretBackendRef, SecretIdentity } from "./index.ts";

export interface SecretDriver extends Driver {
  readonly capability: "secret";
  create(identity: SecretIdentity, value: string): Promise<SecretBackendRef>;
  update(secret: Secret, value: string): Promise<void>;
  /** Replace an exact current value atomically; used to fence device authorization exchanges. */
  compareAndSwap?(secret: Secret, expected: string, value: string): Promise<boolean>;
  delete(secret: Secret): Promise<void>;
  /** Authoritative, versioned read confined to trusted credential resolution. */
  readCredentialInput?(input: CredentialInputRead): Promise<VersionedSecretValue>;
  /** Verify live exact ownership and return only safe projection identity. */
  resolve(secret: Secret): Promise<SecretBackendRef>;
  /** Verify live ownership and use the current value only within a transient server-side operation. */
  withValue?<T>(secret: Secret, use: (value: string) => Promise<T>): Promise<T>;
}
