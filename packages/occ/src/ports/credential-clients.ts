import type { CredentialClient } from "@openclaw-enterprise/contracts";

/** Private custody ownership; client metadata returned to callers excludes this field. */
export type StoredCredentialClient = CredentialClient & {
  readonly credentialServiceInstanceId?: string;
};

export interface CredentialClientReadRepository {
  list(): Promise<readonly Readonly<StoredCredentialClient>[]>;
  countNamespace(namespaceId: string): Promise<number>;
  find(id: string): Promise<Readonly<StoredCredentialClient> | undefined>;
  listCleanups(limit: number): Promise<readonly string[]>;
}

export interface CredentialClientRepository extends CredentialClientReadRepository {
  lock(id: string): Promise<Readonly<StoredCredentialClient> | undefined>;
  lockForCleanup(
    id: string,
    dueOnly: boolean,
  ): Promise<Readonly<StoredCredentialClient> | undefined>;
  setCleanup(id: string, cleanupAfter: string | null): Promise<void>;
  create(
    client: StoredCredentialClient,
    cleanupAfter?: string,
  ): Promise<Readonly<StoredCredentialClient>>;
  /** False while an Agent draft, Source or pending OAuth consent still names the Client. */
  delete(id: string, retainForCleanup?: boolean): Promise<boolean>;
}
