import type { AgentAutomationRepository } from "./agent-automations.ts";
import type { EgressSendReceiptRepository } from "../egress-send-receipts.ts";
import type { AgentProvisioningRepository } from "./agent-provisioning.ts";
import type {
  AgentRepository,
  AgentRevisionRepository,
  SandboxPolicyRepository,
  WorkspaceSetupRepository,
} from "./agents.ts";
import type { AuthenticationStateRepository } from "./authentication-states.ts";
import type { ConfigurationRepository } from "./configurations.ts";
import type { ConnectionTemplateRepository } from "./connection-templates.ts";
import type { CredentialSourceRepository } from "./credential-sources.ts";
import type { InstallationRepository } from "./installations.ts";
import type { NamespaceRepository } from "./namespaces.ts";
import type { PlatformOperationRepository } from "./platform-operations.ts";
import type { PlatformReadView } from "./platform-read-view.ts";
import type { PresetRepository } from "./presets.ts";
import type { RepositorySessionRepository } from "./repository-sessions.ts";
import type { SavedConnectionRepository } from "./saved-connections.ts";
import type { SecretRepository } from "./secrets.ts";
import type { ServiceAccountRepository } from "./service-accounts.ts";
import type {
  AuditEvent,
  IAMPolicyRepository,
  PreparedTokenCurrentProof,
} from "@openclaw-enterprise/contracts";
import { bindRepository } from "./repository-factory.ts";
import type { RepositoryTransactionLifetime } from "./transaction.ts";

export interface PlatformAuditRepository {
  append(event: AuditEvent): Promise<void>;
  list(): Promise<readonly Readonly<AuditEvent>[]>;
}

export interface PlatformUnitOfWork extends PlatformReadView {
  readonly agentAutomations: AgentAutomationRepository;
  readonly preparedTokenProof: PreparedTokenCurrentProof;
  readonly egressSendReceipts: EgressSendReceiptRepository;
  readonly sandboxPolicies: SandboxPolicyRepository;
  readonly installations: InstallationRepository;
  readonly namespaces: NamespaceRepository;
  readonly configurations: ConfigurationRepository;
  readonly connectionTemplates: ConnectionTemplateRepository;
  readonly savedConnections: SavedConnectionRepository;
  readonly presets: PresetRepository;
  readonly authenticationStates: AuthenticationStateRepository;
  readonly secrets: SecretRepository;
  readonly credentialSources: CredentialSourceRepository;
  readonly serviceAccounts: ServiceAccountRepository;
  readonly agents: AgentRepository;
  readonly workspaceSetups: WorkspaceSetupRepository;
  readonly revisions: AgentRevisionRepository;
  readonly iamPolicy: IAMPolicyRepository;
  readonly repositorySessions: RepositorySessionRepository;
  readonly provisioning: AgentProvisioningRepository;
  readonly audit: PlatformAuditRepository;
  readonly operations: PlatformOperationRepository;
}

/** The explicit outward projection shares one transaction lifetime. */
export function bindPlatformUnitOfWork(
  repositories: PlatformUnitOfWork,
  lifetime: RepositoryTransactionLifetime,
): PlatformUnitOfWork {
  return Object.freeze({
    agentAutomations: bindRepository(repositories.agentAutomations, lifetime, [
      "find",
      "list",
      "create",
      "bind",
    ]),
    preparedTokenProof: bindRepository(repositories.preparedTokenProof, lifetime, ["current"]),
    egressSendReceipts: bindRepository(repositories.egressSendReceipts, lifetime, [
      "find",
      "insert",
      "save",
      "authorize",
    ]),
    sandboxPolicies: bindRepository(repositories.sandboxPolicies, lifetime, ["find", "save"]),
    installations: bindRepository(repositories.installations, lifetime, [
      "findInstallation",
      "getInstallation",
      "createInstallation",
      "selectTokenServiceInstance",
      "holdPrincipalAccount",
      "holdAuthenticationSession",
      "holdIAMConfiguration",
    ]),
    namespaces: bindRepository(repositories.namespaces, lifetime, [
      "findNamespace",
      "listNamespaces",
      "createNamespace",
      "lockNamespace",
      "hasAgents",
      "hasConfigurations",
      "listConfigurationIds",
      "hasPresets",
      "hasServiceAccounts",
      "hasSecrets",
      "hasCredentialSources",
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
    presets: bindRepository(repositories.presets, lifetime, [
      "findPreset",
      "listPresets",
      "listPresetSummaries",
      "createPreset",
      "lockPreset",
      "updatePreset",
      "deletePreset",
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
      "lockConnectionTemplate",
      "setOAuthClientCleanup",
      "lockOAuthClient",
      "lockOAuthClientForCleanup",
      "createOAuthClient",
      "deleteOAuthClient",
      "createConnectionTemplate",
      "updateConnectionTemplate",
      "deleteConnectionTemplate",
    ]),
    savedConnections: bindRepository(repositories.savedConnections, lifetime, [
      "findTokenCustody",
      "listDueConnectionTokens",
      "createTokenCustody",
      "recordTokenSchedule",
      "findSavedConnection",
      "listNamespaceConnections",
      "listRevokingConnections",
      "createSavedConnection",
      "requestConnectionRevocation",
      "confirmConnectionRevocation",
      "deleteSavedConnection",
    ]),
    authenticationStates: bindRepository(repositories.authenticationStates, lifetime, [
      "findDevice",
      "create",
      "replaceDevice",
      "consumeOAuth",
      "expire",
    ]),
    secrets: bindRepository(repositories.secrets, lifetime, [
      "findSecret",
      "listSecrets",
      "listReferences",
      "lockSecret",
      "createSecret",
      "deleteSecret",
      "hasReferences",
    ]),
    credentialSources: bindRepository(repositories.credentialSources, lifetime, [
      "findEgressInstallation",
      "findRevisionEgressInstallation",
      "listCredentialPolicyReductions",
      "isEgressMaterialRejected",
      "findCredentialSource",
      "listCredentialSources",
      "lockCredentialSource",
      "createCredentialSource",
      "markCredentialSourceDeleting",
      "markCredentialSourceReady",
      "setCredentialSourceRegistrationDispatch",
      "updateCredentialSourceConfig",
      "replaceCredentialSourceSecrets",
      "recordEgressInstallation",
      "retireEgressInstallation",
      "saveCredentialPolicyReduction",
      "rejectEgressMaterial",
      "admitEgressSource",
      "deleteCredentialSource",
      "hasReferences",
      "findBlockingReference",
      "findCredentialWithdrawal",
      "listCredentialWithdrawals",
      "requestCredentialWithdrawal",
      "reassignCredentialWithdrawal",
      "recordCredentialWithdrawalAttempt",
      "markCredentialWithdrawalRevoked",
    ]),
    serviceAccounts: bindRepository(repositories.serviceAccounts, lifetime, [
      "findServiceAccount",
      "listServiceAccounts",
      "findServiceAccountBackendBinding",
      "createServiceAccount",
      "lockServiceAccount",
      "updateCredential",
      "deleteServiceAccount",
      "hasReferences",
      "findIssuedCredentialBinding",
    ]),
    workspaceSetups: bindRepository(repositories.workspaceSetups, lifetime, [
      "find",
      "create",
      "complete",
      "delete",
    ]),
    agents: bindRepository(repositories.agents, lifetime, [
      "findPredecessorReplacement",
      "recordPredecessorReplacement",
      "findAgentForBrowsing",
      "listAgentsForBrowsing",
      "findAgent",
      "listAgents",
      "hasAgentNamed",
      "listAgentReferences",
      "createAgent",
      "lockAgent",
      "updateConfiguration",
      "setSandboxPolicyEditing",
      "compareAndSetActiveRevision",
      "compareAndClearActiveRevision",
      "transitionAgentDesiredRuntimeState",
      "transitionAgentStatus",
    ]),
    revisions: bindRepository(repositories.revisions, lifetime, [
      "findFirstDeploymentReceipt",
      "findRevisionForBrowsing",
      "listRevisionsForBrowsing",
      "findRevision",
      "listRevisions",
      "listRevisionMetadata",
      "pageRevisionSummaries",
      "createRevision",
    ]),
    iamPolicy: bindRepository(repositories.iamPolicy, lifetime, [
      "listRoles",
      "getRole",
      "createRole",
      "deleteRole",
      "listAccessBindings",
      "getAccessBinding",
      "listRestrictionsTargeting",
      "createAccessBinding",
      "deleteAccessBinding",
      "listServicePrincipals",
      "getServicePrincipal",
      "createServicePrincipal",
      "listConfiguredPolicy",
      "putConfiguredRole",
      "deleteConfiguredRole",
      "createConfiguredGroup",
      "deleteConfiguredGroup",
      "createOCCBinding",
      "deleteConfiguredBinding",
    ]),
    repositorySessions: bindRepository(repositories.repositorySessions, lifetime, [
      "findStandingExecution",
      "listStandingApprovals",
      "findStandingApproval",
      "recordStandingExecution",
      "approveStanding",
      "revokeStanding",
      "withdrawFinite",

      "findAttempt",
      "findBrokerReceipt",
      "findBrokerReceiptBySession",
      "listRevisionAttempts",
      "listNamespaceAttempts",
      "createAttempt",
      "advanceAttempt",
      "lockAttempt",
      "createBrokerReceipt",
      "advanceBrokerReceipt",
      "fenceBrokerReceipt",
    ]),
    provisioning: bindRepository(repositories.provisioning, lifetime, [
      "findByWorkId",
      "findWithWork",
      "hasPendingNamespaceProvisioning",
      "findByAgent",
      "findByConfiguration",
      "findByRequest",
      "create",
      "beginEffect",
      "checkpoint",
      "recordFailure",
      "settleEffect",
      "cancel",
      "cancelByAgent",
      "settleAbandonedEffect",
      "retryByWorkId",
      "releaseConfiguration",
    ]),
    audit: bindRepository(repositories.audit, lifetime, ["append", "list"]),
    operations: bindRepository(repositories.operations, lifetime, [
      "append",
      "list",
      "findWork",
      "findWorkByKeys",
      "findWorkAttempt",
      "hasRepositoryExecutionRedeployRequired",
      "hasOutstandingCredentialWithdrawalWork",
      "retryFailedAgentDeletion",
      "retryFailedNamespaceDeletion",
      "expediteCredentialWithdrawalWork",
    ]),
  });
}
