import type { CredentialInputRead, VersionedSecretValue } from "../credential-proxy/index.ts";
import type { Driver } from "../index.ts";
import type { Secret, SecretBackendRef, SecretIdentity } from "../../index.ts";

/** Stable private identity reserved by OCC before the backend receives secret material. */
export interface PrivateSecretRef {
  readonly installationId: string;
  /** Opaque address that identifies the resource and its logical owner within the Installation. */
  readonly id: string;
}

export interface PrivateSecretStore {
  create(ref: PrivateSecretRef, value: string): Promise<void>;
  update(ref: PrivateSecretRef, value: string): Promise<void>;
  /** Replace the exact current private value atomically. */
  compareAndSwap(ref: PrivateSecretRef, expected: string, value: string): Promise<boolean>;
  withValue<T>(ref: PrivateSecretRef, use: (value: string) => Promise<T>): Promise<T>;
  /** Cleanup also works when create succeeded but the response was lost. */
  delete(ref: PrivateSecretRef): Promise<void>;
}

export interface SecretDriver extends Driver {
  readonly privateSecrets?: PrivateSecretStore;
  readonly capability: "secret";
  create(identity: SecretIdentity, value: string): Promise<SecretBackendRef>;
  update(secret: Secret, value: string): Promise<void>;
  /** Replace an exact current value atomically. */
  compareAndSwap?(secret: Secret, expected: string, value: string): Promise<boolean>;
  delete(secret: Secret): Promise<void>;
  /** Authoritative, versioned read confined to trusted credential resolution. */
  readCredentialInput?(input: CredentialInputRead): Promise<VersionedSecretValue>;
  /** Verify live exact ownership and return only safe projection identity. */
  resolve(secret: Secret): Promise<SecretBackendRef>;
  /** Verify live ownership and use the current value only within a transient server-side operation. */
  withValue?<T>(secret: Secret, use: (value: string) => Promise<T>): Promise<T>;
}
