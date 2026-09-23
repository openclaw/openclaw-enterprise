import { bindRepository } from "./repository-factory.ts";
import type { RepositoryTransactionLifetime } from "./transaction.ts";
import type { PlatformReadView } from "../state/platform-state.ts";

/** The explicit outward projection shares one transaction lifetime. */
export function createPlatformReadView(
  repositories: PlatformReadView,
  lifetime: RepositoryTransactionLifetime,
): PlatformReadView {
  return Object.freeze({
    operations: bindRepository(repositories.operations, lifetime, ["list", "findWork"]),
    installations: bindRepository(repositories.installations, lifetime, [
      "findInstallation",
      "getInstallation",
    ]),
    namespaces: bindRepository(repositories.namespaces, lifetime, [
      "findNamespace",
      "listNamespaces",
    ]),
    configurations: bindRepository(repositories.configurations, lifetime, ["findConfiguration"]),
    presets: bindRepository(repositories.presets, lifetime, ["findPreset", "listPresets"]),
    secrets: bindRepository(repositories.secrets, lifetime, ["findSecret", "listSecrets"]),
    serviceAccounts: bindRepository(repositories.serviceAccounts, lifetime, [
      "findServiceAccount",
      "listServiceAccounts",
      "findServiceAccountProviderBinding",
    ]),
    workspaceSetups: bindRepository(repositories.workspaceSetups, lifetime, ["find"]),
    agents: bindRepository(repositories.agents, lifetime, ["findAgent", "listAgents"]),
    revisions: bindRepository(repositories.revisions, lifetime, ["findRevision", "listRevisions"]),
    iamPolicy: bindRepository(repositories.iamPolicy, lifetime, [
      "listRoles",
      "getRole",
      "listAccessBindings",
      "getAccessBinding",
    ]),
    repositorySessions: bindRepository(repositories.repositorySessions, lifetime, [
      "findAttempt",
      "listRevisionAttempts",
      "listNamespaceAttempts",
    ]),
  });
}
