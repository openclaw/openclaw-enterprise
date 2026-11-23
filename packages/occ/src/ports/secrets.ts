import type { Secret } from "@openclaw-enterprise/contracts";

/**
 * The current platform state that keeps a Secret from deletion. An Agent appears once,
 * whether its draft, active revision, or a pending deployment holds the reference.
 */
export type SecretReferenceKind =
  "agent" | "configuration" | "credential_source" | "provisioning_request";

export interface SecretReferenceEntry {
  readonly kind: SecretReferenceKind;
  readonly id: string;
}

/** At most `limit` references, ordered by kind then ID; `truncated` when more exist. */
export interface SecretReferencePage {
  readonly references: readonly Readonly<SecretReferenceEntry>[];
  readonly truncated: boolean;
}

export interface SecretReadRepository {
  findSecret(namespaceId: string, secretId: string): Promise<Readonly<Secret> | undefined>;
  listSecrets(namespaceId: string): Promise<readonly Readonly<Secret>[]>;
  listReferences(
    namespaceId: string,
    secretId: string,
    limit: number,
  ): Promise<Readonly<SecretReferencePage>>;
}

export interface SecretRepository extends SecretReadRepository {
  lockSecret(namespaceId: string, secretId: string): Promise<Readonly<Secret> | undefined>;
  createSecret(secret: Secret): Promise<Readonly<Secret>>;
  deleteSecret(namespaceId: string, secretId: string): Promise<boolean>;
  hasReferences(namespaceId: string, secretId: string): Promise<boolean>;
}
