import type { CredentialClient } from "@openclaw-enterprise/contracts";

/** Private custody ownership; client metadata returned to callers excludes this field. */
export type StoredCredentialClient = CredentialClient & {
  readonly tokenServiceInstanceId?: string;
};
