import type { CredentialInputRead, VersionedSecretValue } from "../credential-proxy/index.ts";
import type { Driver } from "../index.ts";
import type { Secret, SecretBackendRef, SecretIdentity } from "../../index.ts";

/** Stable private identity reserved by OCC before the backend receives secret material. */
export interface InstallationSecretRef {
  readonly installationId: string;
  readonly id: string;
}

export interface InstallationSecretStore {
  create(ref: InstallationSecretRef, value: string): Promise<void>;
  update(ref: InstallationSecretRef, value: string): Promise<void>;
  withValue<T>(ref: InstallationSecretRef, use: (value: string) => Promise<T>): Promise<T>;
  /** Cleanup also works when create succeeded but the response was lost. */
  delete(ref: InstallationSecretRef): Promise<void>;
}

export interface SecretDriver extends Driver {
  readonly installationSecrets?: InstallationSecretStore;
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
