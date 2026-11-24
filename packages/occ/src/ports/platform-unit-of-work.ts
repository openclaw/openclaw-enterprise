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
import { platformReadMethods, type PlatformReadView } from "./platform-read-view.ts";
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
    preparedTokenProof: bindRepository(repositories.preparedTokenProof, lifetime, ["current"]),
    egressSendReceipts: bindRepository(repositories.egressSendReceipts, lifetime, [
      "find",
      "insert",
      "save",
      "authorize",
    ]),
    sandboxPolicies: Object.freeze({
      ...bindRepository(repositories.sandboxPolicies, lifetime, [
        ...platformReadMethods.sandboxPolicies,
        "save",
      ]),
      ...(repositories.sandboxPolicies.supportsRepositoryNetworkPolicy === true
        ? { supportsRepositoryNetworkPolicy: true as const }
        : {}),
    }),
    installations: bindRepository(repositories.installations, lifetime, [
      ...platformReadMethods.installations,
      "createInstallation",
      "selectTokenServiceInstance",
      "holdPrincipalAccount",
      "holdAuthenticationSession",
      "holdIAMConfiguration",
    ]),
    namespaces: bindRepository(repositories.namespaces, lifetime, [
      ...platformReadMethods.namespaces,
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
      ...platformReadMethods.configurations,
      "createConfiguration",
      "lockConfiguration",
      "advanceConfigurationGeneration",
      "deleteConfiguration",
    ]),
    presets: bindRepository(repositories.presets, lifetime, [
      ...platformReadMethods.presets,
      "createPreset",
      "lockPreset",
      "updatePreset",
      "deletePreset",
    ]),
    connectionTemplates: bindRepository(repositories.connectionTemplates, lifetime, [
      ...platformReadMethods.connectionTemplates,
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
      ...platformReadMethods.savedConnections,
      "createTokenCustody",
      "recordTokenSchedule",
      "createSavedConnection",
      "requestConnectionRevocation",
      "confirmConnectionRevocation",
      "deleteSavedConnection",
    ]),
    authenticationStates: bindRepository(repositories.authenticationStates, lifetime, [
      ...platformReadMethods.authenticationStates,
      "create",
      "replaceDevice",
      "consumeOAuth",
      "expire",
    ]),
    secrets: bindRepository(repositories.secrets, lifetime, [
      ...platformReadMethods.secrets,
      "lockSecret",
      "createSecret",
      "deleteSecret",
      "hasReferences",
    ]),
    credentialSources: bindRepository(repositories.credentialSources, lifetime, [
      ...platformReadMethods.credentialSources,
      "lockCredentialSource",
      "createCredentialSource",
      "markCredentialSourceDeleting",
      "markCredentialSourceReady",
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
      "requestCredentialWithdrawal",
      "reassignCredentialWithdrawal",
      "recordCredentialWithdrawalAttempt",
      "markCredentialWithdrawalRevoked",
    ]),
    serviceAccounts: bindRepository(repositories.serviceAccounts, lifetime, [
      ...platformReadMethods.serviceAccounts,
      "createServiceAccount",
      "lockServiceAccount",
      "updateCredential",
      "deleteServiceAccount",
      "hasReferences",
      "findIssuedCredentialBinding",
    ]),
    workspaceSetups: bindRepository(repositories.workspaceSetups, lifetime, [
      ...platformReadMethods.workspaceSetups,
      "create",
      "complete",
      "delete",
    ]),
    agents: bindRepository(repositories.agents, lifetime, [
      ...platformReadMethods.agents,
      "recordPredecessorReplacement",
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
      ...platformReadMethods.revisions,
      "createRevision",
    ]),
    iamPolicy: bindRepository(repositories.iamPolicy, lifetime, [
      ...platformReadMethods.iamPolicy,
      "createRole",
      "deleteRole",
      "createAccessBinding",
      "deleteAccessBinding",
      "createServicePrincipal",
      "putConfiguredRole",
      "deleteConfiguredRole",
      "createConfiguredGroup",
      "deleteConfiguredGroup",
      "createOCCBinding",
      "deleteConfiguredBinding",
    ]),
    repositorySessions: bindRepository(repositories.repositorySessions, lifetime, [
      ...platformReadMethods.repositorySessions,
      "recordStandingExecution",
      "approveStanding",
      "revokeStanding",
      "withdrawFinite",
      "createAttempt",
      "advanceAttempt",
      "lockAttempt",
      "createBrokerReceipt",
      "advanceBrokerReceipt",
      "fenceBrokerReceipt",
    ]),
    provisioning: bindRepository(repositories.provisioning, lifetime, [
      ...platformReadMethods.provisioning,
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
      ...platformReadMethods.operations,
      "append",
      "retryFailedAgentDeletion",
      "retryFailedNamespaceDeletion",
      "expediteCredentialWithdrawalWork",
    ]),
  });
}
