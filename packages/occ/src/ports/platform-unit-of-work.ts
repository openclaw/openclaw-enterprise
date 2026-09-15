import { bindRepository } from "./repository-factory.ts";
import type { RepositoryTransactionLifetime } from "./transaction.ts";
import type { PlatformUnitOfWork } from "../state/platform-state.ts";

/** The explicit outward projection shares one transaction lifetime. */
export function bindPlatformUnitOfWork(
  repositories: PlatformUnitOfWork,
  lifetime: RepositoryTransactionLifetime,
): PlatformUnitOfWork {
  return Object.freeze({
    installations: bindRepository(repositories.installations, lifetime, [
      "findInstallation",
      "getInstallation",
      "createInstallation",
    ]),
    namespaces: bindRepository(repositories.namespaces, lifetime, [
      "findNamespace",
      "listNamespaces",
      "createNamespace",
      "lockNamespace",
      "hasAgents",
      "hasConfigurations",
      "hasServiceAccounts",
      "hasSecrets",
      "transitionNamespaceStatus",
      "markNamespaceDeleted",
    ]),
    configurations: bindRepository(repositories.configurations, lifetime, [
      "findConfiguration",
      "createConfiguration",
      "lockConfiguration",
      "advanceConfigurationGeneration",
      "deleteConfiguration",
    ]),
    secrets: bindRepository(repositories.secrets, lifetime, [
      "findSecret",
      "lockSecret",
      "createSecret",
      "deleteSecret",
      "hasReferences",
    ]),
    serviceAccounts: bindRepository(repositories.serviceAccounts, lifetime, [
      "findServiceAccount",
      "listServiceAccounts",
      "findServiceAccountProviderBinding",
      "createServiceAccount",
      "lockServiceAccount",
      "updateCredential",
      "deleteServiceAccount",
      "hasReferences",
    ]),
    agents: bindRepository(repositories.agents, lifetime, [
      "findAgent",
      "listAgents",
      "createAgent",
      "lockAgent",
      "updateConfiguration",
      "compareAndSetActiveRevision",
    ]),
    revisions: bindRepository(repositories.revisions, lifetime, [
      "findRevision",
      "listRevisions",
      "createRevision",
    ]),
    audit: bindRepository(repositories.audit, lifetime, ["append", "list"]),
    operations: bindRepository(repositories.operations, lifetime, ["append", "list"]),
  });
}
