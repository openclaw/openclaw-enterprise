import type { AgentProvisioningReadRepository } from "./agent-provisioning.ts";
import type { AgentReadRepository, AgentRevisionReadRepository } from "./agent-reads.ts";
import type { SandboxPolicyReadRepository, WorkspaceSetupReadRepository } from "./agents.ts";
import type { AuthenticationStateReadRepository } from "./authentication-states.ts";
import type { ConfigurationReadRepository } from "./configurations.ts";
import type { ConnectionTemplateReadRepository } from "./connection-templates.ts";
import type { CredentialSourceReadRepository } from "./credential-sources.ts";
import type { InstallationReadRepository } from "./installations.ts";
import type { NamespaceReadRepository } from "./namespaces.ts";
import type { PlatformOperationReadRepository } from "./platform-operations.ts";
import type { PresetReadRepository } from "./presets.ts";
import type { RepositorySessionReadRepository } from "./repository-sessions.ts";
import type { SavedConnectionReadRepository } from "./saved-connections.ts";
import type { SecretReadRepository } from "./secrets.ts";
import type { ServiceAccountReadRepository } from "./service-accounts.ts";
import type { IAMPolicyReadRepository } from "@openclaw-enterprise/contracts";
import { bindRepository } from "./repository-factory.ts";
import type { RepositoryTransactionLifetime } from "./transaction.ts";

export interface PlatformReadView {
  readonly sandboxPolicies: SandboxPolicyReadRepository;
  readonly installations: InstallationReadRepository;
  readonly namespaces: NamespaceReadRepository;
  readonly configurations: ConfigurationReadRepository;
  readonly connectionTemplates: ConnectionTemplateReadRepository;
  readonly savedConnections: SavedConnectionReadRepository;
  readonly presets: PresetReadRepository;
  readonly authenticationStates: AuthenticationStateReadRepository;
  readonly secrets: SecretReadRepository;
  readonly credentialSources: CredentialSourceReadRepository;
  readonly serviceAccounts: ServiceAccountReadRepository;
  readonly agents: AgentReadRepository;
  readonly workspaceSetups: WorkspaceSetupReadRepository;
  readonly revisions: AgentRevisionReadRepository;
  readonly iamPolicy: IAMPolicyReadRepository;
  readonly repositorySessions: RepositorySessionReadRepository;
  readonly provisioning: AgentProvisioningReadRepository;
  readonly operations: PlatformOperationReadRepository;
}

export const platformReadMethods = {
  sandboxPolicies: ["find"],
  operations: [
    "list",
    "findWork",
    "findWorkByKeys",
    "findWorkAttempt",
    "hasRepositoryExecutionRedeployRequired",
    "hasOutstandingCredentialWithdrawalWork",
  ],
  installations: ["findInstallation", "getInstallation"],
  namespaces: ["findNamespace", "listNamespaces"],
  configurations: ["findConfiguration"],
  presets: ["findPreset", "listPresets", "listPresetSummaries"],
  connectionTemplates: [
    "findConnectionTemplate",
    "listConnectionTemplates",
    "hasOtherConnectionIssuer",
    "countNamespaceConnectionTemplates",
    "findOAuthConnectionTemplateVersion",
    "listOAuthClientCleanups",
    "listOAuthClients",
    "countNamespaceOAuthClients",
    "findOAuthClient",
  ],
  savedConnections: [
    "findTokenCustody",
    "listDueConnectionTokens",
    "findSavedConnection",
    "listNamespaceConnections",
    "listRevokingConnections",
  ],
  authenticationStates: ["findDevice"],
  secrets: ["findSecret", "listSecrets", "listReferences"],
  credentialSources: [
    "findEgressInstallation",
    "findRevisionEgressInstallation",
    "listCredentialPolicyReductions",
    "isEgressMaterialRejected",
    "findCredentialSource",
    "listCredentialSources",
    "findCredentialWithdrawal",
    "listCredentialWithdrawals",
  ],
  serviceAccounts: [
    "findServiceAccount",
    "listServiceAccounts",
    "findServiceAccountBackendBinding",
  ],
  workspaceSetups: ["find"],
  agents: [
    "findPredecessorReplacement",
    "findAgent",
    "listAgents",
    "hasAgentNamed",
    "findAgentForBrowsing",
    "listAgentsForBrowsing",
    "listAgentReferences",
  ],
  revisions: [
    "findFirstDeploymentReceipt",
    "findRevision",
    "listRevisions",
    "findRevisionForBrowsing",
    "listRevisionsForBrowsing",
    "listRevisionMetadata",
    "pageRevisionSummaries",
  ],
  iamPolicy: [
    "listRoles",
    "getRole",
    "listAccessBindings",
    "getAccessBinding",
    "listRestrictionsTargeting",
    "listServicePrincipals",
    "getServicePrincipal",
    "listConfiguredPolicy",
  ],
  repositorySessions: [
    "findStandingExecution",
    "listStandingApprovals",
    "findStandingApproval",
    "findAttempt",
    "findBrokerReceipt",
    "findBrokerReceiptBySession",
    "listRevisionAttempts",
    "listNamespaceAttempts",
  ],
  provisioning: [
    "findByWorkId",
    "findWithWork",
    "hasPendingNamespaceProvisioning",
    "findByAgent",
    "findByConfiguration",
    "findByRequest",
  ],
} as const satisfies {
  [Name in keyof PlatformReadView]: readonly (keyof PlatformReadView[Name])[];
};

/** The explicit outward projection shares one transaction lifetime. */
export function createPlatformReadView(
  repositories: PlatformReadView,
  lifetime: RepositoryTransactionLifetime,
): PlatformReadView {
  const methods = platformReadMethods;
  const bind = <Repository extends object, Key extends keyof Repository>(
    repository: Repository,
    keys: readonly Key[],
  ) => bindRepository(repository, lifetime, keys);
  return Object.freeze({
    sandboxPolicies: Object.freeze({
      ...bind(repositories.sandboxPolicies, methods.sandboxPolicies),
      ...(repositories.sandboxPolicies.supportsRepositoryNetworkPolicy === true
        ? { supportsRepositoryNetworkPolicy: true as const }
        : {}),
    }),
    operations: bind(repositories.operations, methods.operations),
    installations: bind(repositories.installations, methods.installations),
    namespaces: bind(repositories.namespaces, methods.namespaces),
    configurations: bind(repositories.configurations, methods.configurations),
    presets: bind(repositories.presets, methods.presets),
    connectionTemplates: bind(repositories.connectionTemplates, methods.connectionTemplates),
    savedConnections: bind(repositories.savedConnections, methods.savedConnections),
    authenticationStates: bind(repositories.authenticationStates, methods.authenticationStates),
    secrets: bind(repositories.secrets, methods.secrets),
    credentialSources: bind(repositories.credentialSources, methods.credentialSources),
    serviceAccounts: bind(repositories.serviceAccounts, methods.serviceAccounts),
    workspaceSetups: bind(repositories.workspaceSetups, methods.workspaceSetups),
    agents: bind(repositories.agents, methods.agents),
    revisions: bind(repositories.revisions, methods.revisions),
    iamPolicy: bind(repositories.iamPolicy, methods.iamPolicy),
    repositorySessions: bind(repositories.repositorySessions, methods.repositorySessions),
    provisioning: bind(repositories.provisioning, methods.provisioning),
  });
}
