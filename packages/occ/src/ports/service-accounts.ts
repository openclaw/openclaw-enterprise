import type { ServiceAccount } from "@openclaw-enterprise/contracts";

export interface ServiceAccountReadRepository {
  findServiceAccount(
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<Readonly<ServiceAccount> | undefined>;
  listServiceAccounts(namespaceId: string): Promise<readonly Readonly<ServiceAccount>[]>;
  findServiceAccountByCredentialSource(
    namespaceId: string,
    sourceId: string,
  ): Promise<Readonly<ServiceAccount> | undefined>;
  findServiceAccountBackendBinding(
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<
    | Readonly<{
        readonly backendId: string;
        readonly driverId: string;
        readonly workspaceId: string;
        readonly credentialIssued: boolean;
      }>
    | undefined
  >;
}

export interface ServiceAccountRepository extends ServiceAccountReadRepository {
  createServiceAccount(account: ServiceAccount): Promise<Readonly<ServiceAccount>>;
  lockServiceAccount(
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<Readonly<ServiceAccount> | undefined>;
  setCredentialSource(
    namespaceId: string,
    serviceAccountId: string,
    credentialSourceId: string,
  ): Promise<Readonly<ServiceAccount> | undefined>;
  deleteServiceAccount(namespaceId: string, serviceAccountId: string): Promise<boolean>;
  hasReferences(namespaceId: string, serviceAccountId: string): Promise<boolean>;
  /**
   * The Backend binding of an issued provider credential, for the audit record of a forced
   * deletion that cannot revoke it. Credential and upstream IDs otherwise stay private.
   */
  findIssuedCredentialBinding(
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<
    | Readonly<{
        readonly backendId: string;
        readonly workspaceId: string;
        readonly externalAccountId: string;
        readonly credentialId: string;
      }>
    | undefined
  >;
}
