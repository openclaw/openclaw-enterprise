import type { AgentAutomationReadRepository } from "./agent-automations.ts";
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
  readonly agentAutomations: AgentAutomationReadRepository;
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

/** The explicit outward projection shares one transaction lifetime. */
export function createPlatformReadView(
  repositories: PlatformReadView,
  lifetime: RepositoryTransactionLifetime,
): PlatformReadView {
  return Object.freeze({
    agentAutomations: bindRepository(repositories.agentAutomations, lifetime, ["find", "list"]),
    sandboxPolicies: Object.freeze({
      ...bindRepository(repositories.sandboxPolicies, lifetime, ["find"]),
      ...(repositories.sandboxPolicies.supportsRepositoryNetworkPolicy === true
        ? { supportsRepositoryNetworkPolicy: true as const }
        : {}),
    }),
    operations: bindRepository(repositories.operations, lifetime, [
      "list",
      "findWork",
      "findWorkByKeys",
      "findWorkAttempt",
      "hasRepositoryExecutionRedeployRequired",
      "hasOutstandingCredentialWithdrawalWork",
    ]),
    installations: bindRepository(repositories.installations, lifetime, [
      "findInstallation",
      "getInstallation",
    ]),
    namespaces: bindRepository(repositories.namespaces, lifetime, [
      "findNamespace",
      "listNamespaces",
    ]),
    configurations: bindRepository(repositories.configurations, lifetime, ["findConfiguration"]),
    presets: bindRepository(repositories.presets, lifetime, [
      "findPreset",
      "listPresets",
      "listPresetSummaries",
    ]),
    connectionTemplates: bindRepository(repositories.connectionTemplates, lifetime, [
      "findConnectionTemplate",
      "listConnectionTemplates",
      "hasOtherConnectionIssuer",
      "countNamespaceConnectionTemplates",
      "findOAuthConnectionTemplateVersion",
      "listOAuthClientCleanups",
      "listOAuthClients",
      "countNamespaceOAuthClients",
      "findOAuthClient",
    ]),
    savedConnections: bindRepository(repositories.savedConnections, lifetime, [
      "findTokenCustody",
      "listDueConnectionTokens",
      "findSavedConnection",
      "listNamespaceConnections",
      "listRevokingConnections",
    ]),
    authenticationStates: bindRepository(repositories.authenticationStates, lifetime, [
      "findDevice",
    ]),
    secrets: bindRepository(repositories.secrets, lifetime, [
      "findSecret",
      "listSecrets",
      "listReferences",
    ]),
    credentialSources: bindRepository(repositories.credentialSources, lifetime, [
      "findEgressInstallation",
      "findRevisionEgressInstallation",
      "listCredentialPolicyReductions",
      "isEgressMaterialRejected",
      "findCredentialSource",
      "listCredentialSources",
      "findCredentialWithdrawal",
      "listCredentialWithdrawals",
    ]),
    serviceAccounts: bindRepository(repositories.serviceAccounts, lifetime, [
      "findServiceAccount",
      "listServiceAccounts",
      "findServiceAccountBackendBinding",
    ]),
    workspaceSetups: bindRepository(repositories.workspaceSetups, lifetime, ["find"]),
    agents: bindRepository(repositories.agents, lifetime, [
      "findPredecessorReplacement",
      "findAgent",
      "listAgents",
      "hasAgentNamed",
      "findAgentForBrowsing",
      "listAgentsForBrowsing",
      "listAgentReferences",
    ]),
    revisions: bindRepository(repositories.revisions, lifetime, [
      "findFirstDeploymentReceipt",
      "findRevision",
      "listRevisions",
      "findRevisionForBrowsing",
      "listRevisionsForBrowsing",
      "listRevisionMetadata",
      "pageRevisionSummaries",
    ]),
    iamPolicy: bindRepository(repositories.iamPolicy, lifetime, [
      "listRoles",
      "getRole",
      "listAccessBindings",
      "getAccessBinding",
      "listRestrictionsTargeting",
      "listServicePrincipals",
      "getServicePrincipal",
      "listConfiguredPolicy",
    ]),
    repositorySessions: bindRepository(repositories.repositorySessions, lifetime, [
      "findStandingExecution",
      "listStandingApprovals",
      "findStandingApproval",

      "findAttempt",
      "findBrokerReceipt",
      "findBrokerReceiptBySession",
      "listRevisionAttempts",
      "listNamespaceAttempts",
    ]),
    provisioning: bindRepository(repositories.provisioning, lifetime, [
      "findByWorkId",
      "findWithWork",
      "hasPendingNamespaceProvisioning",
      "findByAgent",
      "findByConfiguration",
      "findByRequest",
    ]),
  });
}
