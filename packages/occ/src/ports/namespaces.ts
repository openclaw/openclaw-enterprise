import type { Namespace, NamespaceStatus } from "@openclaw-enterprise/contracts";

export interface NamespaceReadRepository {
  findNamespace(namespaceId: string): Promise<Readonly<Namespace> | undefined>;
  listNamespaces(): Promise<readonly Readonly<Namespace>[]>;
}

export interface PersistedNamespace extends Namespace {
  readonly deletedAt?: string;
}

export interface NamespaceRepository extends NamespaceReadRepository {
  createNamespace(namespace: Namespace): Promise<Readonly<Namespace>>;
  lockNamespace(
    namespaceId: string,
    options?: { readonly includeDeleted?: boolean },
  ): Promise<Readonly<PersistedNamespace> | undefined>;
  hasAgents(namespaceId: string): Promise<boolean>;
  hasConfigurations(namespaceId: string): Promise<boolean>;
  /** IDs of the Namespace's Configurations, oldest first; nothing else lists them. */
  listConfigurationIds(namespaceId: string): Promise<readonly string[]>;
  hasPresets(namespaceId: string): Promise<boolean>;
  hasServiceAccounts(namespaceId: string): Promise<boolean>;
  hasSecrets(namespaceId: string): Promise<boolean>;
  hasCredentialSources(namespaceId: string): Promise<boolean>;
  transitionNamespaceStatus(
    namespaceId: string,
    expected: NamespaceStatus | readonly NamespaceStatus[],
    next: NamespaceStatus,
  ): Promise<Readonly<PersistedNamespace> | undefined>;
  markNamespaceDeleted(
    namespaceId: string,
    deletedAt: string,
  ): Promise<Readonly<PersistedNamespace> | undefined>;
}
