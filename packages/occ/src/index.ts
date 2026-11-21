import {
  reconcileNamespaceLifecycle,
  type NamespaceLifecycleBinding,
  type NamespaceLifecycleEvidence,
} from "./namespace-lifecycle.ts";
import {
  createNamespaceOperations,
  type CreateNamespaceInput,
  type NamespaceOperations,
} from "./namespace-operations.ts";

export type { CreateNamespaceInput } from "./namespace-operations.ts";

export type {
  NamespaceLifecycleBinding,
  NamespaceLifecycleEvidence,
} from "./namespace-lifecycle.ts";
export { recognizedRuntimeFailureValues } from "./runtime-failure-cause.ts";
import {
  createConnectionAdministration,
  type CreateConnectionTemplateInput,
  type CreateOAuthClientInput,
  type DiscoverMcp,
  type UpdateConnectionTemplateInput,
} from "./connection-administration.ts";
import {
  CONNECTION_OPERATION_TIMEOUT_MS,
  createSavedConnections,
  type CompleteNamespaceConnectionInput,
  type StartNamespaceConnectionInput,
} from "./saved-oauth-connections.ts";

export type {
  CompleteNamespaceConnectionInput,
  StartNamespaceConnectionInput,
} from "./saved-oauth-connections.ts";

export type {
  CreateConnectionTemplateInput,
  CreateOAuthClientInput,
  UpdateConnectionTemplateInput,
} from "./connection-administration.ts";
import { NativeIAMDriver } from "@openclaw-enterprise/iam";
import {
  createIAMPolicyOperations,
  iamPolicyOperation,
  type CreateIAMAccessBindingInput,
  type CreateIAMRoleInput,
  type IAMPolicyOperations,
  type InstallationIAMConfiguration,
} from "./iam-policy-operations.ts";

export type {
  CreateIAMAccessBindingInput,
  CreateIAMRoleInput,
  InstallationIAMConfiguration,
} from "./iam-policy-operations.ts";

export { refreshPinnedOAuthGrant } from "./oauth-token-endpoint.ts";
export { reduceCredentialPolicy, isReducedCredentialPlan } from "./credential-policy-reduction.ts";
export { CredentialDeliveries } from "./state/credential-deliveries.ts";
export type { CredentialDeliveryKey } from "./state/credential-deliveries.ts";
export { CredentialDeliveryReductions } from "./state/credential-delivery-reductions.ts";
export type { CredentialDeliveryReduction } from "./state/credential-delivery-reductions.ts";
export {
  eligibleRepositoryApprovalScope,
  repositoryApprovalFingerprint,
} from "./repository-approval.ts";

import {
  createRepositoryPolicyOperations,
  type InstallationRepositoryAdmission,
  type RemoveStandingApprovalInput,
} from "./repository-policy.ts";

export {
  postgresPreparedGitHubProof,
  preparedGitHubLive,
  preparedGitHubRejectedMaterialMatch,
  readPreparedGitHubMetadata,
} from "./state/prepared-github-state.ts";
export type { PreparedGitHubMetadataAdmission } from "./state/prepared-github-state.ts";
import {
  assertExecutionAdmission,
  assertExecutionReleaseAllowed,
  codexProxiesRepositoryBroker,
  codexRepositoryBrokerNetworkProxy,
} from "@openclaw-enterprise/contracts";
import { EgressSendReceipts } from "./egress-send-receipts.ts";
import { createEgressAuthority } from "./credential-egress-authority.ts";
import {
  credentialSourceMetadata,
  isManagedTokenServiceSource,
} from "./credential-source-metadata.ts";
import {
  createCredentialSourceOperations,
  type CredentialSourceOperations,
  type CreateCredentialSourceInput,
  type RotateCredentialSourceInput,
  type UpdateCredentialSourceInput,
} from "./credential-source-operations.ts";

import {
  CREDENTIAL_GATEWAY_TIMEOUT_MS,
  createCredentialSourceDrivers,
  credentialGatewayOperation,
} from "./credential-source-drivers.ts";
import { createCredentialEgressAdmission } from "./credential-egress-admission.ts";
import type {
  ExecutionAdmission,
  ProxyPlan,
  TokenService,
  EgressRef,
} from "@openclaw-enterprise/contracts";
import {
  CredentialProxy,
  resolveCredentialProxyCapacity,
  type CredentialProxyCapacity,
} from "./credential-proxy.ts";
import type { EgressExchangeOwner } from "@openclaw-enterprise/contracts";

export type { AcceptedEgressAssociation, AuthorizedSend } from "@openclaw-enterprise/contracts";
export {
  CredentialProxy,
  resolveCredentialProxyCapacity,
  STREAM_LEASE_CEILING_MS,
  STREAM_LEASE_IDLE_MS,
  STREAM_LEASE_RECHECK_MS,
} from "./credential-proxy.ts";
export type { CredentialProxyCapacity } from "./credential-proxy.ts";
export type {
  CapturedEgressUse,
  EgressExchangeOwner,
  EgressPeer,
  EgressResolution,
  EgressSendDecision,
  EgressStreamLease,
  EgressStreamProgress,
} from "@openclaw-enterprise/contracts";
import {
  AgentRuntimeCredentials,
  runtimeCredentialOperation,
  runtimeCredentialStatus,
} from "./agent-runtime-credentials.ts";
import type { InstalledDriver } from "./installed-driver.ts";
import {
  createPresetOperations,
  type BundledPresetVersion,
  type CreatePresetInput,
  type DefaultPresetRefreshSkip,
  type SkippedDefaultPreset,
  type UpdatePresetInput,
} from "./preset-operations.ts";

export type {
  BundledPresetVersion,
  CreatePresetInput,
  DefaultPresetRefreshSkip,
  SkippedDefaultPreset,
  SkippedDefaultPresetCreation,
  SkippedDefaultPresetRefresh,
  UpdatePresetInput,
} from "./preset-operations.ts";

export { InstalledDriver } from "./installed-driver.ts";
import {
  DriverConfigurationRegistry,
  type DriverConfigurationRegistration,
} from "./configuration-registry.ts";

export { DriverConfigurationRegistry } from "./configuration-registry.ts";
export type { DriverConfigurationRegistration } from "./configuration-registry.ts";
import {
  type ConfigurationContext,
  type DriverConfigurationDescriptor,
  type ConfigurationResult,
} from "@openclaw-enterprise/contracts";
import type {
  SandboxPolicy,
  SandboxFacet,
  SandboxNetworkGrant,
  SandboxPolicySnapshot,
  SandboxPolicyRecommendations,
} from "@openclaw-enterprise/contracts";
import { validateSandboxNetworkGrants } from "@openclaw-enterprise/contracts";
import {
  checkedProtectedCodexArtifactPolicy,
  checkedSandboxPolicySnapshot,
  createSandboxPolicyOperations,
  unprotectedPolicyRevision,
} from "./sandbox-policy.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { createAgentAuditReader } from "./agent-audit-reader.ts";
import {
  createControllerWorkRecorder,
  type ControllerWorkRecorder,
} from "./controller-work-recorder.ts";
import {
  createControllerResourceValues,
  type ControllerResourceValues,
} from "./controller-resource-values.ts";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { RemovedAccessBinding } from "./iam-policy-cleanup.ts";
import {
  AgentRuntimeObservations,
  type RuntimeLogReadAdmission,
  type RuntimeLogReadRequest,
} from "./agent-runtime-observations.ts";
import {
  createPluginDiscovery,
  type ManagedMcpConnection,
  type ManagedMcpToolReader,
  type PluginDiscoveryCredential,
} from "./plugin-discovery.ts";
import { deviceAuthorizationCipher } from "./device-authorization.ts";
import {
  createDeviceAuthorizationFlow,
  type DeviceAuthorizationAudit,
} from "./device-authorization-flow.ts";
import type {
  Agent,
  AgentCredentialSourceBinding,
  AgentRead,
  AgentRevisionRead,
  AgentDeploymentDiagnostics,
  AgentRuntimeDescription,
  AgentHarnessStatusRead,
  AgentRevision,
  FirstDeploymentReceipt,
  AgentRuntimeCredentialsInput,
  AgentRuntimeCredentialStatus,
  AccessBinding,
  AuthorizationRequest,
  ComputeDriver,
  AgentChatCompletionsResolution,
  Configuration,
  ConfigurationDriver,
  ConfigurationValidationOptions,
  CredentialGatewayDriver,
  SavedConnection,
  OAuthRefreshTokenRegistration,
  OAuthAccountRef,
  OAuthConnectionClient,
  OAuthClient,
  ConnectionTemplate,
  CredentialRefreshDriver,
  CredentialSource,
  CredentialSourceReference,
  TokenServiceDriver,
  SourceRegistrationInput,
  SourceProviderPresetId,
  CredentialSourceMetadata,
  CredentialSourceSnapshot,
  CredentialSourceStatus,
  CredentialWithdrawalStatus,
  CredentialSourceType,
  AuditEvent,
  Driver,
  DriverCapability,
  HarnessExecutionMode,
  IAMDriver,
  Installation,
  InstallationCapabilities,
  InstallationDeploymentInventory,
  Namespace,
  NamespaceDeleteResult,
  NamespaceEnsureResult,
  LoggingLevel,
  OpenClawConfigurationDocument,
  Preset,
  PresetSummary,
  PresetDraftDefinition,
  PluginDesiredSelection,
  PluginApprovers,
  PluginCatalogEntry,
  PluginCatalogPage,
  PluginDriver,
  ChannelDriver,
  ChannelDirectoryResult,
  PluginRevisionState,
  BackendDefinition,
  BackendRef,
  RepositoryBindingRequest,
  RepositoryOptions,
  RepositoryRevisionState,
  RevisionHarnessDescriptor,
  ResourceKind,
  ResourceRef,
  Role,
  SandboxDriver,
  SecretBindings,
  SecretReference,
  SecretDetail,
  SecretMetadata,
  ServiceAccount,
  ServiceAccountCredential,
  ServicePrincipal,
  HarnessAuthBinding,
  HarnessAuthSnapshot,
} from "@openclaw-enterprise/contracts";
import {
  isName,
  NAME_RULE,
  normalizeLoggingLevel,
  freezeAgentRevision,
} from "@openclaw-enterprise/contracts";
import { asRecord, immutableCopy, isNonEmptyString } from "@openclaw-enterprise/utils";
import { type ModelPolicyAgent, resolveConfiguredHarnessId } from "./configured-harness.ts";
import type { ClaimedWork } from "./controller-work.ts";
import {
  createAgentQueries,
  type AgentRevisionListPage,
  type ActiveAgentRevisionSelection,
} from "./agent-queries.ts";
import { withAgentIdentityName } from "./openclaw-roster.ts";
import {
  createAgentDraftOperations,
  refuseTakenAgentName,
  type AgentConfigurationPreparation,
  type CreateAgentInput,
  type UpdateAgentInput,
  type ValidateAgentCreateInput,
} from "./agent-drafts.ts";
import {
  createAgentPluginValidation,
  normalizeAgentPlugins,
  normalizeAgentPluginApprovers,
  pluginOwner,
  validatePluginSettings,
  validatePluginCredentialSources,
} from "./agent-plugin-validation.ts";

export type {
  CreateAgentInput,
  UpdateAgentInput,
  ValidateAgentCreateInput,
} from "./agent-drafts.ts";
import { DriverRegistry, unchangedDriver, type DriverFor } from "./driver-registry.ts";
import { driverOperation } from "./driver-operation.ts";
import { readDeploymentInventory } from "./deployment-inventory.ts";
import { SetupDiscovery, type LookupChannelDirectoryInput } from "./setup-discovery.ts";
import { createInstallationCapabilityQueries } from "./installation-capabilities.ts";
import {
  AgentDeletingError,
  AuthorizationDeniedError,
  DependencyUnavailableError,
  ChannelCredentialError,
  ComputeGatewaySettingError,
  ConfigurationHarnessError,
  configurationSettingMessage,
  CredentialGatewayNotConfiguredError,
  NamespaceNotReadyError,
  NotImplementedError,
  ProvisioningSecretDriverError,
  QualifiedAuthorizationDeniedError,
  ResourceConflictError,
  ResourceStateConflictError,
  ProtectedExecutionNetworkPolicyError,
  ScopeViolationError,
  SecretBindingDriverError,
  SecretDriverOwnershipError,
  PostgresCommitOutcomeUnknownError,
} from "./errors.ts";
import {
  createAgentCredentialWithdrawal,
  type AgentCredentialSourceInput,
} from "./agent-credential-withdrawal.ts";
import { createAgentTermination } from "./agent-termination.ts";
import { refuseUndeployableConfigurationValues } from "./configuration-settings.ts";
import { enabledChannelEntries, requireChannelSecretBindings } from "./channel-secret-bindings.ts";
import {
  admitsOpenClawExecutionMode,
  agentRuntimeConfiguration,
  createSavedAgentTopologyValidator,
  requireDedicatedNativeSupport,
  requireSandboxExecutionMode,
  resolveAgentHarness,
  validateAgentHarnessAuth,
  validateWorkspaceSetupTopology,
  type HarnessResolver,
} from "./agent-harness-topology.ts";
import { createHarnessAuthOperations } from "./harness-auth.ts";
import { freezeConfigurationValues } from "./configuration-settings.ts";

export type { HarnessResolver } from "./agent-harness-topology.ts";
export type { PlannedSecretHarnessAuth } from "./harness-auth.ts";
import type { RuntimeLogPage, RuntimeLogQuery } from "./runtime-logs/index.ts";
import {
  nativeWorkerSupportSource,
  type NativeWorkerSupport,
  type NativeWorkerSupportSource,
} from "./native-worker-support.ts";
import {
  assertConfiguredBackend,
  backendDefinitionMap,
  validateBackendDefinitions,
  validateSelectedBackendDrivers,
} from "./backends.ts";
import {
  createManagedCredentialSources,
  type ManagedCredentialSources,
  type UpdateManagedCredentialSourceInput,
} from "./managed-credential-sources.ts";

export type { UpdateManagedCredentialSourceInput } from "./managed-credential-sources.ts";

import type { AgentAuditSelection, AgentAuditState } from "./ports/agent-audit.ts";
import {
  createControllerAuthority,
  type AuthorityFence,
  type AuthorizationTarget,
  type ControllerAuthority,
  type AuthorizationSnapshot as DeployAgentAuthorization,
  type ControllerAuthorizationOverride,
} from "./controller-authority.ts";
import {
  createControllerTransactions,
  type ControllerTransactions,
} from "./controller-transactions.ts";
import {
  parseAgentCredentialSources,
  assertHarnessSourceListed,
  createAgentCredentialAccess,
  type AgentCredentialAccess,
} from "./agent-credential-access.ts";
import { exactAgent, exactNamespace, lockNamespace, namespaceIdentity } from "./resource-scope.ts";

export type {
  AuthorityFence,
  AuthorizationSnapshot as DeployAgentAuthorization,
} from "./controller-authority.ts";
import { InMemoryPlatformState } from "./state/platform-state.ts";
import type { PlatformReadView } from "./ports/platform-read-view.ts";
import type { PlatformOperation } from "./ports/platform-operations.ts";
import type { PlatformStateStore } from "./ports/platform-state-store.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";
import type { DeploymentStatusResult } from "./controller-work.ts";
import { normalizedRepositoryAccess } from "./repository-credential-validation.ts";
import {
  canonicalProvisioningJson,
  parseProvisioningPlan,
  validExecutionMode,
  type AgentProvisioningConfigurationInput,
  type ProvisionAgentInput,
  type ProvisionAgentResult,
} from "./agent-provisioning.ts";

import type { AgentProvisioningRecord } from "./ports/agent-provisioning.ts";
import { createProvisioningRequests } from "./agent-provisioning-requests.ts";
import {
  createProvisioningWorker,
  type AgentProvisioningWorkerOptions,
  type AgentProvisioningWorkerOutcome,
} from "./agent-provisioning-worker.ts";
import {
  createSecretOperations,
  sameSecretBackend,
  secretOperation,
  type CreateSecretInput,
  type UpdateSecretInput,
} from "./secret-operations.ts";
import {
  createConfigurationOperations,
  exactConfiguration,
  rejectCrossNamespaceSecretSources,
  storedSecretBindings,
  type CreateConfigurationInput,
  type UpdateConfigurationInput,
} from "./configuration-operations.ts";

export type {
  CreateConfigurationInput,
  UpdateConfigurationInput,
} from "./configuration-operations.ts";
import {
  createServiceAccountOperations,
  exactServiceAccount,
  type CreateServiceAccountInput,
  type ServiceAccountDeletion,
} from "./service-account-operations.ts";

export {
  credentialWithdrawalCompanionRevisions,
  type AgentCredentialSourceInput,
} from "./agent-credential-withdrawal.ts";
export type { CreateSecretInput, UpdateSecretInput } from "./secret-operations.ts";
export type {
  CreateServiceAccountInput,
  ServiceAccountDeletion,
} from "./service-account-operations.ts";

export {
  accessBindingsRemovedWithAgent,
  removeNamespacePolicy,
  removedPolicyDetails,
  restrictionsRemovedWithAgent,
} from "./iam-policy-cleanup.ts";
export type { RemovedAccessBinding } from "./iam-policy-cleanup.ts";
export {
  OPERATION_REFUSAL_HINT_CODES,
  operationRefusalHintCode,
} from "./deployment-work-status.ts";
export type { OperationRefusalHintCode } from "./deployment-work-status.ts";
export {
  ActivationFailedError,
  ComputePreparationFailedError,
  RepositoryExecutionRequiresRedeployError,
  ActivationPendingError,
  agentEntryMessage,
  AgentCredentialSourceBindingError,
  AgentDeletingError,
  BrowserAuthorizationError,
  AgentPrincipalAuthorizationError,
  AuthorizationDeniedError,
  CallerStateDeniedError,
  DEDICATED_OPENCLAW_SANDBOX_REQUIRED,
  DedicatedOpenClawSandboxError,
  DeletionRetryOwnedError,
  DependencyUnavailableError,
  RuntimeDiagnosticsTransportError,
  PersistedStateInvalidError,
  DeviceAuthorizationScopeMismatchError,
  DeviceAuthorizationStartError,
  DriverSelectionError,
  ModelDiscoveryError,
  PluginDiscoveryError,
  ChannelDirectoryError,
  ChannelCredentialError,
  ComputeGatewaySettingError,
  ComputeProvisioningRefusedError,
  ConfigurationGenerationConflictError,
  ConfigurationHarnessError,
  ConfigurationSizeError,
  configurationSettingMessage,
  CredentialGatewayNotConfiguredError,
  CredentialProxyAdmissionError,
  CredentialProxyRepositoryOnlyError,
  CredentialSourceConfigError,
  CredentialSourceDriverError,
  CredentialSourceRegistrationConfigError,
  CredentialSourceRevisionError,
  CredentialSourceTypeNotOfferedError,
  CredentialSourceUnprotectedError,
  CredentialTokenUnsettledError,
  CredentialWithdrawalInProgressError,
  CredentialWithdrawalNotFoundError,
  CredentialWithdrawalRefusedError,
  GatewayPasswordValueError,
  HarnessAuthSecretDriverError,
  IAMAccessBindingRoleError,
  IAMPolicyValidationError,
  IAMRoleInUseError,
  keyedSettingPath,
  KubernetesSecretWriteForbiddenError,
  ModelCredentialValueError,
  ModelProviderSettingError,
  NamespaceNotEmptyError,
  NamespaceNotReadyError,
  NativeWorkerSupportError,
  NoActiveAgentRevisionError,
  NotImplementedError,
  PluginPolicyValidationError,
  ProvisioningSecretDriverError,
  QualifiedAuthorizationDeniedError,
  HiddenResourceAuthorizationDeniedError,
  quotedSettingKey,
  RepositoryBindingSelectionError,
  RepositoryGitProfileUnsupportedError,
  RepositoryGitSenderUnqualifiedError,
  RepositoryOptionsUnavailableError,
  RecoveryPasswordPolicyError,
  ResourceConflictError,
  ResourceStateConflictError,
  RetryLaterError,
  RuntimeCredentialsForbiddenByClusterError,
  RuntimeLogsError,
  RuntimeLogsForbiddenByClusterError,
  RuntimeLogsSandboxNotFoundError,
  SANDBOX_DELETION_UNCONFIRMED,
  SandboxGatewayUnauthorizedError,
  SandboxGatewayUnavailableError,
  SandboxNamespaceRefusedError,
  SandboxNamespacePendingError,
  ProtectedExecutionNetworkPolicyError,
  SandboxNetworkPolicyConflictError,
  SandboxRevisionUnsupportedError,
  SandboxRepositoryRecipientUnverifiedError,
  SandboxWorkspaceSetupRefusedError,
  RepositorySessionWithdrawnError,
  ScopeViolationError,
  TokenServiceSourceInputError,
  TokenServiceRegistrationRefusedError,
  SecretBindingDriverError,
  ServiceAccountBackendBindingError,
  ServiceAccountCredentialSecretExistsError,
  ServiceAccountDriverNotConfiguredError,
  SecretBindingValidationError,
  SecretDriverOwnershipError,
  SecretStorageDriverError,
  SecretValueError,
  StoredCredentialSourceConfigError,
  TransientDependencyError,
  WorkClaimLostError,
  type CodexPermissionDenial,
  type RuntimeLogsErrorCode,
} from "./errors.ts";
export {
  createRuntimeLogCursorCodec,
  maskRuntimeEventText,
  redactRuntimeLogText,
  RUNTIME_LOG_DEFAULT_TAIL_LINES,
  RUNTIME_LOG_MAX_TAIL_LINES,
  sanitizeRuntimeLogChunk,
  sanitizeSandboxLogLines,
  type RuntimeLogPage,
  type RuntimeLogQuery,
  type RuntimeLogViewAdmission,
  type SanitizedRuntimeLogRecord,
  validRuntimeLogFrontierTime,
} from "./runtime-logs/index.ts";
export {
  PINNED_OPENCLAW_RUNTIME_SUPPORTS_NATIVE_WORKERS,
  provisionsDedicatedOpenClaw,
  type NativeWorkerSupport,
} from "./native-worker-support.ts";
export {
  backendDefinitionMap,
  gatewayEndpointRewritesIpv4,
  validateBackendDefinitions,
  validateSelectedBackendDrivers,
  validateServiceAccountBackendBinding,
} from "./backends.ts";
export { provisioningEffectReceipt, provisioningPendingEffect } from "./provisioning-effects.ts";
export type {
  ProvisioningEffectReceipt,
  ProvisioningEffectTarget,
  ProvisioningPendingEffect,
} from "./ports/agent-provisioning.ts";
export { InMemoryPlatformState } from "./state/platform-state.ts";
export type { PredecessorReplacement, AgentRevisionReadRepository } from "./ports/agent-reads.ts";
export type { InMemoryPlatformStateOptions, PlatformAuditSink } from "./state/platform-state.ts";
export type { PlatformOperation } from "./ports/platform-operations.ts";
export type { ConnectionTokenCustody } from "./ports/saved-connections.ts";
export type { PlatformReadView } from "./ports/platform-read-view.ts";
export type { PlatformStateStore } from "./ports/platform-state-store.ts";
export type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";
export type { ServiceAccountReadRepository } from "./ports/service-accounts.ts";
export { resolveConfiguredHarnessId } from "./configured-harness.ts";
export { imageReferenceProblem } from "./image-reference.ts";
export type { ImageReferenceProblem } from "./image-reference.ts";
export { DEPLOYMENT_FAILURE_STEPS, deploymentFailureStep } from "./deployment-failure-steps.ts";
export { admitGatewaySecurityDefaults } from "./gateway-security-defaults.ts";
export { storedConfigurationProblem } from "./stored-configuration-rules.ts";
export type { StoredConfigurationRule } from "./stored-configuration-rules.ts";
export type { DeploymentFailureStep } from "./deployment-failure-steps.ts";
export {
  activePluginSecretInputs,
  codexPluginPolicyProblem,
  configIncludeProblem,
  environmentReference,
  environmentReferenceNames,
  gatewayPasswordRequirement,
  generatedGatewayPasswordReference,
  pluginEntryKeyVariantProblem,
  pluginPolicyId,
  pluginPolicyList,
  pluginSecretInputReference,
  secretInputReference,
  secretInputShorthandName,
  secretProviderDefaultsProblem,
  shownSecretName,
  TRUSTED_PROXY_IDENTITY,
  trustedProxyIdentitiesProblem,
  unreadablePluginSecretInput,
  unsubstitutedReference,
  wholeEnvironmentReferenceName,
  workspaceNodeGatewayPasswordProblem,
} from "./environment-references.ts";
export type { SecretInputReference } from "./environment-references.ts";
export {
  invalidHeaderNameRequirement,
  isAdmittedHeaderName,
  isCredentialHeaderName,
  isHttpFieldName,
  PROVIDER_MODELS_LIST,
  urlHoldsUserinfo,
} from "./model-provider-settings.ts";
export { requireOpenClawRoster } from "./openclaw-roster.ts";
export {
  enabledChannelEntries,
  requireChannelSecretBindings,
  slackAccountTargets,
} from "./channel-secret-bindings.ts";
export {
  CODEX_APPROVAL_POLICY_SETTING,
  codexApprovalPolicy,
  refuseLiteralGatewayPassword,
  refusePluginEntryKeyVariants,
  waitsOnVariable,
} from "./configuration-settings.ts";
export {
  AgentAuditDisclosureUnavailableError,
  AuditAppendUnavailableError,
  PostgresCommitOutcomeUnknownError,
} from "./errors.ts";
export {
  PostgresHumanAuthentication,
  UserAlreadyExistsError,
  knownDeviceAccountState,
} from "./state/human-authentication.ts";
export type {
  HumanAuthenticationActivation,
  HumanAuthenticationActivationHooks,
  PreparedPasswordAccount,
  HumanAuthenticationActor,
  HumanAuthenticationAccount,
  HumanAuthenticationRecovery,
  HumanAuthenticationProof,
  HumanAuthenticationSession,
} from "./state/human-authentication.ts";
export type { NativeBrowserAccess } from "./state/native-browser-access.ts";
export {
  HumanAuthenticationMaintenanceRefusedError,
  PostgresHumanAuthenticationMaintenance,
  WritersNotStoppedError,
} from "./state/human-authentication-maintenance.ts";
export { createPostgresPool } from "./state/postgres-pool.ts";
export type { AgentAuditState } from "./ports/agent-audit.ts";
export type {
  RepositoryBrokerReceipt,
  RepositorySessionAttempt,
  RepositorySessionPhase,
  RepositorySessionReadRepository,
  RepositorySessionRepository,
  RepositoryStandingApproval,
} from "./ports/repository-sessions.ts";
export {
  PostgresCertificateRejectedError,
  PostgresPlatformState,
  type PersistedNativeIAMState,
  type PostgresClient,
  type PostgresPlatformStateOptions,
  type PostgresPool,
} from "./state/postgres-state.ts";
export {
  isRepositoryCleanupWork,
  isRepositoryExpiryCleanupWork,
  isRepositoryRuntimeRetirementWork,
  repositoryCleanupRevisionId,
} from "./repository-withdrawal.ts";
export { PostgresWorkQueue, repositoryWithdrawalStateSql } from "./state/postgres-work-queue.ts";
export type {
  ClaimRequest,
  EnqueueWork,
  PermanentFailure,
  PostgresQueryClient,
  PostgresWorkQueueOptions,
  RecoveryRequest,
  RecoverySummary,
  RetryableFailure,
  WorkResult,
} from "./state/postgres-work-queue.ts";
export type { WorkClaim } from "./controller-work.ts";
export { CREDENTIAL_WITHDRAWAL_TARGET } from "./controller-work.ts";
export type { ClaimedWork, ControllerWork, ControllerWorkState } from "./controller-work.ts";
export {
  credentialWithdrawalWorkKey,
  isCredentialWithdrawalWork,
  revisionAdmittedBeforeWork,
} from "./controller-work.ts";
export type {
  DeploymentStatus,
  DeploymentStatusError,
  DeploymentStatusResult,
  PluginDeploymentWarning,
} from "./controller-work.ts";
export { controllerWorkDeploymentStatus } from "./deployment-work-status.ts";
export { runtimeFailureCause } from "./runtime-failure-cause.ts";
export { validateRuntimeFailureEvidence } from "./controller-work-result.ts";
export type { RuntimeFailureCause, RuntimeFailureEvidence } from "@openclaw-enterprise/contracts";
export type {
  ActiveAgentRevisionSelection,
  AgentRevisionListing,
  AgentRevisionListPage,
} from "./agent-queries.ts";
export { type AgentProvisioningProgress, type ProvisionAgentInput } from "./agent-provisioning.ts";
export type {
  AgentProvisioningWorkerOptions,
  AgentProvisioningWorkerOutcome,
} from "./agent-provisioning-worker.ts";
export type { AgentProvisioningRecord } from "./ports/agent-provisioning.ts";

export { createPostgresAuthBinding } from "./auth-persistence/postgres-auth-binding.ts";
export type {
  CoreSchemaRootV1,
  CoreResourceSchemaV1,
  AuthTableSchemaV1,
} from "./auth-persistence/core-schema-boundary-v1.ts";
export type {
  SchemaAuthAdapterOptionsV1,
  SchemaAuthBindingFactoryV1,
  SchemaAuthBoundaryV1,
  SchemaAuthPoolV1,
  SchemaAuthSchemaV1,
} from "./auth-persistence/schema-auth-boundary-v1.ts";

export const BOOTSTRAP_DEFAULT_NAMESPACE_NAME = "default";

export type { RuntimeLogReadGrant, RuntimeLogReadAdmission } from "./agent-runtime-observations.ts";

export interface ControllerOptions {
  /** Key material for sealed authentication-state payloads (device-login challenge and handle). */
  readonly authenticationStateEncryptionSecret?: string;
  readonly namespaceLifecycleBindings?: readonly NamespaceLifecycleBinding[] | undefined;
  /** Code-only composition binding for the bundled retained-source plugin reader. */
  readonly pluginSourceReader?: {
    readonly gateway: CredentialGatewayDriver;
    readonly withSourceToken: NonNullable<CredentialGatewayDriver["withSourceToken"]>;
  };
  readonly preparedTokens?: TokenService | undefined;
  readonly driverConfigurations?: readonly DriverConfigurationRegistration[];
  readonly sandboxNetworkPolicyCeiling?: readonly SandboxNetworkGrant[];
  /** Installation configuration `iam`; `applyIAMConfiguration` writes it to IAM policy. */
  readonly iamConfiguration?: InstallationIAMConfiguration;
  readonly authorize?: ControllerAuthorizationOverride;
  readonly now?: () => Date;
  readonly createId?: (kind: ResourceKind) => string;
  readonly state?: PlatformStateStore;
  readonly agentAuditState?: AgentAuditState<PlatformUnitOfWork>;
  readonly recordOperations?: boolean;
  readonly backends?: readonly BackendDefinition[];
  readonly defaultPresets?: readonly PresetDraftDefinition[];
  /**
   * Every shipped version of the bundled default Presets, current and superseded, loaded
   * whether or not `presets.includeDefaults` seeds them. Startup refreshes Namespace copies
   * still equal to a superseded version, and Namespace deletion treats any of them as
   * unmodified release content.
   */
  readonly bundledPresetVersions?: readonly BundledPresetVersion[];
  /**
   * Installation startup `presets.includeDefaults`. Only then are `defaultPresets` the bundled
   * defaults whose superseded copies startup refreshes; a `presets.files` entry never is, even
   * one that repeats a bundled file. Default: false.
   */
  readonly refreshBundledDefaultPresets?: boolean;
  readonly loggingLevel?: LoggingLevel;
  readonly configuredServiceAccountDriverId?: string;
  /** Installation startup `runtime.nativeWorkerSupport`; never set from the API. */
  readonly nativeWorkerSupport?: NativeWorkerSupport;
  /** Installation startup `drivers.credential_proxy.requestCapacity`; defaults when absent. */
  readonly credentialProxyCapacity?: CredentialProxyCapacity;
}

export type { LookupChannelDirectoryInput } from "./setup-discovery.ts";

export type {
  CreateCredentialSourceInput,
  RotateCredentialSourceInput,
  UpdateCredentialSourceInput,
} from "./credential-source-operations.ts";

export interface DeployAgentInput {
  readonly harnessOverrides?: Readonly<Record<string, unknown>> | undefined;
  readonly namespaceId: string;
  readonly agentId: string;
}

/** An exact first-admission intent. The key is nonsecret and scoped to the caller and Agent. */
export interface FirstDeploymentIntent {
  readonly key: string;
  readonly expectedConfigurationId: string;
  readonly expectedGeneration: number;
}

export type { FirstDeploymentReceipt } from "@openclaw-enterprise/contracts";

interface PreparedDeploymentChannels {
  readonly configuration: Readonly<Configuration>;
  readonly configurationDriver: ConfigurationDriver;
  readonly channel: ChannelDriver | undefined;
  readonly channelValidator: ChannelDriver["validateCredentials"];
}

interface FirstDeploymentGuard {
  readonly digest: string;
  readonly intent: FirstDeploymentIntent;
  readonly preparation:
    { readonly prepared: PreparedDeploymentChannels } | { readonly error: unknown };
}

export interface AuthorizedAgentDeployment {
  readonly revision: Readonly<AgentRevision>;
  readonly authorization: Readonly<DeployAgentAuthorization>;
}

export type ReconciliationOperation = PlatformOperation;

// The bundled Kubernetes Compute Driver's implementations: the Installation default and the
// Driver's own default.
const BUNDLED_KUBERNETES_COMPUTE: ReadonlySet<string> = new Set([
  "occ/kubernetes",
  "kubernetes-local",
]);
/** Only a claimed server-side consent attempt may operate on its still-pending source. */
const PENDING_CONNECTION: unique symbol = Symbol("pending-connection");

const GATEWAY_MANAGED_MODE_UNSUPPORTED =
  "Agent setting gatewayManagedMode is not supported by the selected Compute Driver.";

export class OpenClawController {
  /** @internal Bind the Installation's exact owner for fresh revision admission. */
  static forInstallation(
    installation: Installation,
    options: ControllerOptions,
    repositoryAdmission: InstallationRepositoryAdmission | undefined,
  ): OpenClawController {
    const controller = new OpenClawController(installation, options);
    controller.repositoryPolicy.bindInstallation(repositoryAdmission, controller.backends);
    return controller;
  }

  readonly installation: Readonly<Installation>;
  private readonly configurations = new DriverConfigurationRegistry();
  private readonly connectionAdministration: ReturnType<typeof createConnectionAdministration>;

  private readonly sandboxPolicyOperations: ReturnType<typeof createSandboxPolicyOperations>;
  private readonly iamPolicy: IAMPolicyOperations;
  private readonly agentCredentialAccess: AgentCredentialAccess;
  private readonly authorization?: ControllerOptions["authorize"];
  private readonly deviceAuthorization: ReturnType<typeof createDeviceAuthorizationFlow>;
  private readonly resourceValues: ControllerResourceValues;
  private readonly state: PlatformStateStore;
  private readonly readAgentAuditEvents: ReturnType<typeof createAgentAuditReader>;
  private readonly authority: ControllerAuthority;
  private readonly transactions: ControllerTransactions;
  private readonly credentialSourceOperations: CredentialSourceOperations;
  private readonly managedCredentialSources: ManagedCredentialSources<typeof PENDING_CONNECTION>;
  private readonly requestAuditId = new AsyncLocalStorage<string>();
  private readonly workRecorder: ControllerWorkRecorder;
  private readonly nativeWorkers: NativeWorkerSupportSource | undefined;
  private readonly installationCapabilityQueries: ReturnType<
    typeof createInstallationCapabilityQueries
  >;
  private readonly runtimeObservations: AgentRuntimeObservations;
  private readonly setupDiscovery: SetupDiscovery;
  private readonly runtimeCredentials: AgentRuntimeCredentials;
  private readonly credentialProxyCapacity: CredentialProxyCapacity;
  private readonly drivers: DriverRegistry;
  private readonly pluginDiscovery: ReturnType<typeof createPluginDiscovery>;
  private readonly preparedTokens: TokenService | undefined;
  private readonly namespaces: NamespaceOperations;
  private readonly backends: readonly BackendDefinition[];
  private readonly presets: ReturnType<typeof createPresetOperations>;
  private readonly secretOperations: ReturnType<typeof createSecretOperations>;
  private readonly serviceAccountOperations: ReturnType<typeof createServiceAccountOperations>;
  private readonly agentQueries: ReturnType<typeof createAgentQueries>;
  private readonly loggingLevel: LoggingLevel;
  private readonly agentDrafts: ReturnType<typeof createAgentDraftOperations>;
  private readonly agentPlugins: ReturnType<typeof createAgentPluginValidation>;
  private readonly harnessAuthOperations: ReturnType<typeof createHarnessAuthOperations>;
  private readonly validateSavedAgentTopology: ReturnType<typeof createSavedAgentTopologyValidator>;
  private readonly backendMap: ReadonlyMap<string, BackendDefinition>;
  private readonly repositoryPolicy: ReturnType<typeof createRepositoryPolicyOperations>;

  constructor(installation: Installation, options: ControllerOptions = {}) {
    this.drivers = new DriverRegistry({
      configurations: this.configurations,
      namespaceLifecycleBindings: options.namespaceLifecycleBindings ?? [],
      hasBuiltInRepositoryPolicy: () => this.repositoryPolicy.hasBuiltInRepositoryPolicy(),
    });
    if (!isNonEmptyString(installation.id)) {
      throw new ScopeViolationError("The controller requires one valid server-owned Installation.");
    }
    if (!isName(installation.name)) {
      throw new ScopeViolationError(
        `The stored Installation name breaks the Name rule: ${NAME_RULE}.`,
      );
    }
    if (
      !isNonEmptyString(installation.createdAt) ||
      Number.isNaN(Date.parse(installation.createdAt))
    ) {
      throw new ScopeViolationError("The server-owned Installation has an invalid creation time.");
    }
    this.installation = Object.freeze({
      id: installation.id,
      name: installation.name,
      createdAt: installation.createdAt,
    });
    validateSandboxNetworkGrants(
      options.sandboxNetworkPolicyCeiling ?? [],
      "/sandboxNetworkPolicyCeiling",
    );
    const sandboxNetworkPolicyCeiling = immutableCopy(options.sandboxNetworkPolicyCeiling ?? []);
    for (const registration of options.driverConfigurations ?? []) {
      this.configurations.register(registration);
    }
    this.authorization = options.authorize;
    this.preparedTokens = options.preparedTokens;
    const pluginSourceReader = options.pluginSourceReader;
    const now = options.now ?? (() => new Date());
    const createId = options.createId;
    this.resourceValues = createControllerResourceValues(
      () => Reflect.apply(now, this, []),
      createId ? (kind) => Reflect.apply(createId, this, [kind]) : undefined,
    );
    this.state = options.state ?? new InMemoryPlatformState();
    this.transactions = createControllerTransactions({
      platformState: this.state,
      installation: this.installation,
    });
    const authorizeOverride = this.authorization;
    this.authority = createControllerAuthority({
      selectedIAM: () => this.selectedDriver("iam"),
      authorizeOverride: authorizeOverride
        ? (request) => Reflect.apply(authorizeOverride, this, [request])
        : undefined,
    });
    this.iamPolicy = createIAMPolicyOperations({
      installationId: this.installation.id,
      configuration: options.iamConfiguration,
      authority: this.authority,
      transactions: this.transactions,
      selectedIAM: () => this.selectedDriver("iam"),
      hasAuthorizationOverride: this.authorization !== undefined,
      ownsPolicy: (driver) =>
        !(driver instanceof NativeIAMDriver) ||
        NativeIAMDriver.usesStateForAuthorization(driver, driver.authorize, this.state),
      timestamp: () => this.timestamp(),
    });
    this.secretOperations = createSecretOperations(this.installation.id, {
      transactions: this.transactions,
      authority: this.authority,
      bindCreator: this.iamPolicy.bindCreator,
      getNamespace: (principalId, namespaceId) => this.getNamespace(principalId, namespaceId),
      lockNamespaceForPolicyDelete: this.iamPolicy.lockNamespaceForPolicyDelete,
      selectDriver: () => this.selectedDriver("secret"),
      nextIdentifier: (kind) => this.nextIdentifier(kind),
      timestamp: () => this.timestamp(),
      registerRollback: (compensate) => this.registerRollback(compensate),
      provisioningPlan: (record) => this.provisioningPlan(record),
    });
    this.egressAdmission = createCredentialEgressAdmission({
      installationId: () => this.installation.id,
      authorize: (principalId, action, resource) => this.authorize(principalId, action, resource),
      hasProxy: () => this.drivers.hasSelection("credential_proxy"),
      proxyDriver: () => this.selectedDriver("credential_proxy"),
      proxyRegistrationOwner: () => this.drivers.selection("credential_proxy")?.owner,
      selectedProxyOwner: () => this.selectedProxyOwner(),
      hasGateway: () => this.drivers.hasSelection("credential_gateway"),
      sourceDrivers: this.credentialSourceDrivers,
      secretDriver: this.secretOperations.secretDriver,
      issuer: (ref) => this.preparedTokens?.issuer(ref),
    });
    this.configurationOperations = createConfigurationOperations({
      transactions: this.transactions,
      authority: this.authority,
      registerRollback: (compensate) => this.registerRollback(compensate),
      lockNamespaceForPolicyDelete: this.iamPolicy.lockNamespaceForPolicyDelete,
      guardProvisioningConfiguration: (state, namespaceId, id, readOnly) =>
        this.guardProvisioningConfiguration(state, namespaceId, id, readOnly),
      selectDriver: () => this.selectedDriver("configuration"),
      validateComputeConfiguration: (values, options) =>
        this.validateComputeConfiguration(values, options),
      requireBundledChannelBindings: (values, secretBindings) =>
        this.requireBundledChannelBindings(values, secretBindings),
      ownedSecretDriver: this.secretOperations.ownedSecretDriver,
      bindCreator: this.iamPolicy.bindCreator,
      nextIdentifier: (kind) => this.nextIdentifier(kind),
      timestamp: () => this.timestamp(),
    });
    this.deviceAuthorization = createDeviceAuthorizationFlow({
      installationId: this.installation.id,
      cipher: options.authenticationStateEncryptionSecret
        ? deviceAuthorizationCipher(options.authenticationStateEncryptionSecret)
        : undefined,
      gatewayTimeoutMs: CREDENTIAL_GATEWAY_TIMEOUT_MS,
      nextSessionId: () => this.nextIdentifier("secret"),
      timestamp: () => this.timestamp(),
      transactions: this.transactions,
      authority: this.authority,
      authorizeScope: (principalId, namespaceId, agentId) =>
        this.authorizeDeviceAuthorizationScope(principalId, namespaceId, agentId),
      hasDriver: (capability) => this.drivers.hasSelection(capability),
      credentialGatewayDriver: () => this.credentialGatewayDriver(),
      credentialRefreshDriver: () => this.credentialRefreshDriver(),
      credentialGatewayOperation: (operation) => this.credentialGatewayOperation(operation),
      credentialSourceContext: (namespaceId, id) => this.credentialSourceContext(namespaceId, id),
      authorizedCredentialSource: (principalId, namespaceId, id) =>
        this.authorizedCredentialSource(principalId, namespaceId, id),
      createSource: (principalId, input, audit, registrationAudit) =>
        this.createCredentialSource(principalId, input, audit, registrationAudit),
      credentialSourceMetadata: (source) => this.credentialSourceMetadata(source),
    });
    this.readAgentAuditEvents = createAgentAuditReader({
      installationId: this.installation.id,
      platformState: this.state,
      auditState: options.agentAuditState,
      authority: this.authority,
      hasAuthorizationOverride: this.authorization !== undefined,
    });
    this.workRecorder = createControllerWorkRecorder(
      this.requestAuditId,
      options.recordOperations ?? true,
    );
    this.sandboxPolicyOperations = createSandboxPolicyOperations({
      installationId: this.installation.id,
      ceiling: sandboxNetworkPolicyCeiling,
      authority: this.authority,
      transactions: this.transactions,
      protectedExecutionApplies: (state, agent, revision) =>
        this.protectedExecutionApplies(state, agent, revision),
      record: (state, operation) => this.record(state, operation),
      resolveConfiguration: (capability, driverId, scope, key) =>
        this.configurations.resolve(capability, driverId, scope, key),
      hasSandboxSelection: () => this.drivers.hasSelection("sandbox"),
      selectSandbox: () => this.selectedDriver("sandbox"),
      selectedCompute: () => this.selectedDriver("compute"),
      timestamp: () => this.timestamp(),
    });
    this.pluginDiscovery = createPluginDiscovery({
      transactions: this.transactions,
      authority: this.authority,
      authorizedCredentialSource: (principalId, namespaceId, sourceId) =>
        this.authorizedCredentialSource(principalId, namespaceId, sourceId),
      credentialGatewayOperation: (operation) => this.credentialGatewayOperation(operation),
      sourceReader: pluginSourceReader,
      secretDriver: this.secretOperations.secretDriver,
      readConfiguration: (metadata) =>
        this.configurationOperations.savedConfigurationReader(metadata)(),
      modelPolicyAgent: (executionMode) => this.modelPolicyAgent(executionMode),
      pluginDriver: (harnessId) => this.pluginDriver(harnessId),
      assertPluginOwner: pluginOwner,
      validatePluginPlacement: (driver, plugins, harness) =>
        this.agentPlugins.validatePluginPlacement(driver, plugins, harness),
    });
    this.agentQueries = createAgentQueries({
      transactions: this.transactions,
      authority: this.authority,
      getNamespace: (principalId, namespaceId) => this.getNamespace(principalId, namespaceId),
      selectCompute: () => this.selectedDriver("compute"),
      clock: () => this.clock(),
    });
    this.backends = validateBackendDefinitions(options.backends ?? []);
    this.presets = createPresetOperations(options, {
      installationId: this.installation.id,
      transactions: this.transactions,
      authority: this.authority,
      bindCreator: this.iamPolicy.bindCreator,
      getNamespace: (principalId, namespaceId) => this.getNamespace(principalId, namespaceId),
      nextPresetId: () => this.nextIdentifier("preset"),
      timestamp: () => this.timestamp(),
      configurationDriver: this.configurationOperations.selectedDriver,
      validateConfigurationContent: this.configurationOperations.validateConfigurationContent,
      validateAgentBackend: (backendId) => this.backendId(backendId),
      drivers: this.drivers,
      normalizeAgentPluginApprovers,
    });
    this.namespaces = createNamespaceOperations({
      installationId: this.installation.id,
      transactions: this.transactions,
      authority: this.authority,
      iamPolicy: this.iamPolicy,
      presets: this.presets,
      record: (state, operation) => this.record(state, operation),
      observeLifecycle: (namespace, target, signal, record) =>
        this.observeNamespaceLifecycle(namespace, target, signal, record),
      selectedCompute: () => this.selectedDriver("compute"),
      selectedIAMId: () => this.selectedDriver("iam").id,
      allocateNamespaceId: () => this.nextIdentifier("namespace"),
      requireAdoptionSupport: () => this.requireNamespaceAdoptionSupport(),
      timestamp: () => this.timestamp(),
      requestAuditId: () => this.requestAuditId.getStore(),
    });
    this.credentialSourceOperations = createCredentialSourceOperations({
      transactions: this.transactions,
      authority: this.authority,
      sourceDrivers: this.credentialSourceDrivers,
      egressAdmission: this.egressAdmission,
      hasProxy: () => this.drivers.hasSelection("credential_proxy"),
      assertCredentialSourceOwnerSelected: () => this.assertCredentialSourceOwnerSelected(),
      secretDriver: this.secretOperations.secretDriver,
      secretOperation,
      getNamespace: (principalId, namespaceId) => this.getNamespace(principalId, namespaceId),
      bindCreator: this.iamPolicy.bindCreator,
      nextSourceId: () => this.nextIdentifier("credential_source"),
      timestamp: () => this.timestamp(),
      tokenService: () => this.tokenService(),
      preparedIssuer: (ref) => this.preparedIssuer(ref),
      readConnectionStatus: (namespaceId, sourceId) =>
        this.connectionTokenIssuer().status(
          { kind: "oauth_refresh_token", namespaceId, sourceId },
          AbortSignal.timeout(CONNECTION_OPERATION_TIMEOUT_MS),
        ),
      maintainConnectionToken: (namespaceId, sourceId) =>
        this.maintainConnectionToken(namespaceId, sourceId),
    });
    this.managedCredentialSources = createManagedCredentialSources(
      {
        transactions: this.transactions,
        authority: this.authority,
        sourceDrivers: this.credentialSourceDrivers,
        assertCredentialSourceOwnerSelected: () => this.assertCredentialSourceOwnerSelected(),
        bindCreator: this.iamPolicy.bindCreator,
        lockNamespaceForPolicyDelete: this.iamPolicy.lockNamespaceForPolicyDelete,
        selectedTokenServiceDriver: () => this.selectedDriver("token_service"),
        clock: () => this.clock(),
        timestamp: () => this.timestamp(),
        nextSourceId: () => this.nextIdentifier("credential_source"),
        tokenServiceTimeoutMs: CONNECTION_OPERATION_TIMEOUT_MS,
        driverOperation: (operation) => driverOperation(operation, "TokenService"),
        isCommitOutcomeUnknown: (error) => error instanceof PostgresCommitOutcomeUnknownError,
        connectionTokenIssuer: () => this.connectionTokenIssuer(),
        preparedIssuer: (ref) => this.preparedIssuer(ref),
      },
      PENDING_CONNECTION,
    );
    this.loggingLevel = normalizeLoggingLevel(options.loggingLevel);
    if (
      options.nativeWorkerSupport !== undefined &&
      options.nativeWorkerSupport !== "custom-image"
    ) {
      throw new ScopeViolationError("The native worker support declaration is invalid.");
    }
    this.nativeWorkers = nativeWorkerSupportSource(options.nativeWorkerSupport);
    this.agentCredentialAccess = createAgentCredentialAccess({
      authority: this.authority,
      iamPolicy: this.iamPolicy,
      drivers: this.drivers,
      installationId: this.installation.id,
      timestamp: () => this.timestamp(),
      isManagedTokenServiceSource,
      assertCredentialSourceOwnerSelected: () => this.assertCredentialSourceOwnerSelected(),
      requireTokenServiceOwner: (instanceId) => {
        this.ownedTokenServiceDriver(instanceId);
      },
      credentialSourceOwner: (source) => this.credentialSourceOwner(source),
      offersProtectedType: (type) =>
        this.protectedSourceTypes().some((offer) => offer.type.type === type),
      credentialSourceType: (driver, type) => this.credentialSourceType(driver, type),
      validatePluginCredentialSources,
    });
    const capacity = resolveCredentialProxyCapacity(
      { ...options.credentialProxyCapacity },
      "Credential Proxy capacity",
    );
    if (capacity.faults) {
      throw new RangeError(capacity.faults.map((fault) => fault.message).join(" "));
    }
    this.credentialProxyCapacity = capacity.capacity;
    this.backendMap = backendDefinitionMap(this.backends);
    this.repositoryPolicy = createRepositoryPolicyOperations({
      drivers: this.drivers,
      selectedRepository: () => this.selectedDriver("repo"),
      selectedCompute: () => this.selectedDriver("compute"),
      backends: this.backendMap,
      sandboxDriver: this.sandboxPolicyOperations.sandboxDriver,
      authority: this.authority,
      holdNamespacePolicyActor: (state, principalId) =>
        this.holdNamespacePolicyActor(state, principalId),
      transactions: this.transactions,
      getUpdatableAgent: (principalId, namespaceId, agentId) =>
        this.agentQueries.getAuthorizedAgent(principalId, namespaceId, agentId, "update"),
      timestamp: () => this.timestamp(),
      requestAuditId: () => this.requestAuditId.getStore(),
    });
    this.agentPlugins = createAgentPluginValidation({
      pluginDriver: (harnessId, forConfiguration) => this.pluginDriver(harnessId, forConfiguration),
      computeImplementation: () => this.selectedDriver("compute").implementation,
      sandboxImplementation: () => this.drivers.selection("sandbox")?.implementation,
      credentialGatewayImplementation: () =>
        this.drivers.selection("credential_gateway")?.implementation,
    });
    this.validateSavedAgentTopology = createSavedAgentTopologyValidator({
      sandboxDriver: this.sandboxPolicyOperations.sandboxDriver,
      selectedCompute: () => this.drivers.selection("compute")?.driver as ComputeDriver | undefined,
      validatePluginPlacement: (driver, plugins, harness) =>
        this.agentPlugins.validatePluginPlacement(driver, plugins, harness),
      validateRepositoryBrokerNetworkProxy: (harness, values, sandbox) =>
        this.validateRepositoryBrokerNetworkProxy(harness, values, sandbox),
      loggingLevel: this.loggingLevel,
    });
    if (
      options.configuredServiceAccountDriverId !== undefined &&
      !isNonEmptyString(options.configuredServiceAccountDriverId)
    ) {
      throw new ScopeViolationError("The configured ServiceAccount Driver ID is invalid.");
    }
    const configuredServiceAccountDriverId = options.configuredServiceAccountDriverId;
    this.installationCapabilityQueries = createInstallationCapabilityQueries({
      installation: this.installation,
      nativeWorkers: this.nativeWorkers,
      authority: this.authority,
      transactions: this.transactions,
      sandboxDriver: this.sandboxPolicyOperations.sandboxDriver,
      admitOpenClawExecutionMode: admitsOpenClawExecutionMode,
      readGatewaySourceTypes: () =>
        this.drivers.hasSelection("credential_gateway")
          ? this.credentialGatewayOperation(() =>
              this.credentialGatewayDriver().listSourceTypes({
                signal: AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS),
              }),
            )
          : undefined,
      protectedSourceTypes: () => this.protectedSourceTypes().map(({ type }) => type),
      allowsGatewaySourceType: (type) =>
        this.ordinaryCredentialGatewayAllowed(type) || this.staticSourceTypeAvailable(type),
      enabledPluginDrivers: () => this.drivers.enabledPluginDrivers(),
    });
    this.runtimeObservations = new AgentRuntimeObservations({
      getAgent: (principalId, namespaceId, agentId) =>
        this.getAgent(principalId, namespaceId, agentId),
      getRevision: (principalId, namespaceId, agentId, deploymentId) =>
        this.getRevision(principalId, namespaceId, agentId, deploymentId),
      getReadableActiveAgentRevision: (principalId, namespaceId, agentId) =>
        this.getReadableActiveAgentRevision(principalId, namespaceId, agentId),
      transactions: this.transactions,
      authority: this.authority,
      selectCompute: () => this.selectedDriver("compute"),
      selectSandbox: () => this.selectedDriver("sandbox"),
      hasSandbox: () => this.drivers.hasSelection("sandbox"),
      clock: () => this.clock(),
    });
    this.setupDiscovery = new SetupDiscovery({
      installationId: this.installation.id,
      transactions: this.transactions,
      authority: this.authority,
      configurations: this.configurations,
      drivers: this.drivers,
      getAgentSandboxPolicy: (principalId, namespaceId, agentId, facet) =>
        this.getAgentSandboxPolicy(principalId, namespaceId, agentId, facet),
      selectCompute: () => this.selectedDriver("compute"),
      selectChannel: () => this.selectedDriver("channel"),
      secretDriver: this.secretOperations.secretDriver,
    });
    this.runtimeCredentials = new AgentRuntimeCredentials({
      transactions: this.transactions,
      authority: this.authority,
      guardAgentProvisioning: (state, namespaceId, agentId) =>
        this.guardAgentProvisioning(state, namespaceId, agentId),
      selectCompute: () => this.selectedDriver("compute"),
    });
    this.connectionAdministration = createConnectionAdministration({
      installationId: this.installation.id,
      transactions: this.transactions,
      authority: this.authority,
      secretDriver: this.secretOperations.secretDriver,
      now: () => this.clock(),
      timestamp: () => this.timestamp(),
    });
    this.savedConnections = createSavedConnections({
      read: this.transactions.read,
      transact: this.transactions.transact,
      authorize: this.authority.authorize,
      canRead: this.authority.canRead,
      holdAuthority: this.authority.holdAuthority,
      iamPolicyDriver: (method) => this.iamPolicyDriver(method),
      iamPolicyOperation,
      connectionTokenIssuer: () => this.connectionTokenIssuer(),
      tokenService: () => this.tokenService(),
      secretDriver: this.secretOperations.secretDriver,
      withOAuthClientSecret: (client, use) => this.withOAuthClientSecret(client, use),
      retireCredentialSourceMaterial: (namespace, source) =>
        this.retireCredentialSourceMaterial(namespace, source, undefined),
      discardPendingConnection: (principalId, namespaceId, sourceId) =>
        this.deleteCredentialSource(
          principalId,
          namespaceId,
          sourceId,
          undefined,
          PENDING_CONNECTION,
        ),
      finishConnectionRevocation: (namespaceId, sourceId) =>
        this.finishConnectionRevocation(namespaceId, sourceId),
      nextIdentifier: (kind) => this.nextIdentifier(kind),
      timestamp: () => this.timestamp(),
    });
    this.serviceAccountOperations = createServiceAccountOperations({
      transactions: this.transactions,
      authority: this.authority,
      bindCreator: this.iamPolicy.bindCreator,
      getNamespace: (principalId, namespaceId) => this.getNamespace(principalId, namespaceId),
      lockNamespaceForPolicyDelete: this.iamPolicy.lockNamespaceForPolicyDelete,
      hasSelection: () => this.drivers.hasSelection("service_account"),
      selectDriver: () => this.selectedDriver("service_account"),
      computeDriver: () => this.selectedDriver("compute"),
      configuredDriverId: configuredServiceAccountDriverId,
      nextIdentifier: (kind) => this.nextIdentifier(kind),
    });
    this.harnessAuthOperations = createHarnessAuthOperations({
      authority: this.authority,
      authorizeBoundCredentialSources: (principalId, namespaceId, sources) =>
        this.authorizeBoundCredentialSources(principalId, namespaceId, sources),
      backends: this.backendMap,
      secrets: this.secretOperations,
      isManagedTokenServiceSource,
      hasCredentialGateway: () => this.drivers.hasSelection("credential_gateway"),
      assertCredentialGatewaySelected: () => this.assertCredentialGatewaySelected(),
      ownedTokenServiceDriver: (id) => this.ownedTokenServiceDriver(id),
      ownedCredentialGatewayDriver: (source) => this.ownedCredentialGatewayDriver(source),
      credentialGatewayDriver: (id) => this.credentialGatewayDriver(id),
      credentialSourceType: (driver, type) => this.credentialSourceType(driver, type),
      serviceAccounts: this.serviceAccountOperations,
      sandboxDriver: this.sandboxPolicyOperations.sandboxDriver,
      agentRuntimeConfiguration: (values, harness, compute, sandbox) =>
        this.agentRuntimeConfiguration(values, harness, compute, sandbox),
    });
    this.agentDrafts = createAgentDraftOperations({
      authority: this.authority,
      transactions: this.transactions,
      harnessAuth: this.harnessAuthOperations,
      repositoryPolicy: this.repositoryPolicy,
      validateSavedAgentTopology: this.validateSavedAgentTopology,
      validateAgentPlugins: this.agentPlugins.validateAgentPlugins,
      guardAgentProvisioning: (state, namespaceId, agentId) =>
        this.guardAgentProvisioning(state, namespaceId, agentId),
      guardProvisioningConfiguration: (state, namespaceId, id) =>
        this.guardProvisioningConfiguration(state, namespaceId, id),
      backendId: (value, preserve) => this.backendId(value, preserve),
      credentialAccess: this.agentCredentialAccess,
      isManagedTokenServiceSource,
      bindings: storedSecretBindings,
      authorizeBindings: this.configurationOperations.authorizeBindings,
      rejectCrossNamespaceSecretSources,
      configurationDriver: this.configurationOperations.selectedDriver,
      validateConfigurationContent: (values, bindings) =>
        this.configurationOperations.validateConfigurationContent(values, undefined, bindings),
      savedConfigurationReader: this.configurationOperations.savedConfigurationReader,
      updatePreparedConfiguration: (actorId, input) => this.updateConfiguration(actorId, input),
      authorizeGatewayManagedModeChange: (actorId, required) =>
        this.authorizeGatewayManagedModeChange(actorId, required),
      requireGatewayManagedModeSupport: (enabled) => this.requireGatewayManagedModeSupport(enabled),
      gatewayManagedModeSupported: () => this.gatewayManagedModeSupported(),
      refuseRepositoryNetworkOverlap: (actorId, policy) =>
        this.sandboxPolicyOperations.refuseRepositoryNetworkOverlap(actorId, policy),
      bindCreator: this.iamPolicy.bindCreator,
      nextAgentId: () => this.nextIdentifier("agent"),
      timestamp: () => this.timestamp(),
    });
    this.provisioningWorker = createProvisioningWorker({
      installationId: () => this.installation.id,
      now: this.resourceValues.now,
      timestamp: this.resourceValues.timestamp,
      nextId: this.resourceValues.nextIdentifier,
      transactions: this.transactions,
      authorizeRecord: this.provisioningRequests.authorizeProvisioningRecord,
      bindCreator: this.iamPolicy.bindCreator,
      ensureAgentOperateGrants: this.agentCredentialAccess.ensureAgentOperateGrants,
      backendId: (ref) => this.backendId(ref),
      savedAgentOptions: (namespaceId, plan) =>
        this.provisioningSavedAgentOptions(namespaceId, plan),
      hasConfigurationDriver: () => this.drivers.hasSelection("configuration"),
      configuration: this.configurationOperations,
      runtimeCredentials: this.runtimeCredentials,
      deploy: (principalId, input, resolveHarness) =>
        this.deployAgent(principalId, input, resolveHarness),
    });
  }

  registerDriver<T extends Driver | InstalledDriver>(driver: T): T {
    return this.drivers.registerDriver(driver);
  }

  /** Install one trusted catalog per Harness family. */
  installPluginDrivers(drivers: readonly PluginDriver[]): void {
    this.drivers.installPluginDrivers(drivers);
  }

  /** Register one configured owner, then select its exact capability views. */
  installDriver(owner: InstalledDriver, select: readonly DriverCapability[]): void {
    const views = select.map((key) => owner.require(key));
    this.registerDriver(owner);
    for (const view of views) {
      this.selectDriver(view.capability, view.id);
    }
  }

  selectDriver<Capability extends DriverCapability>(
    selectedCapability: Capability,
    driverId: string,
  ): DriverFor<Capability> {
    return this.drivers.selectDriver(selectedCapability, driverId);
  }

  selectedDriver<Capability extends DriverCapability>(
    selectedCapability: Capability,
  ): DriverFor<Capability> {
    return this.drivers.selectedDriver(selectedCapability);
  }

  private selectedProxyOwner(): InstalledDriver {
    return this.drivers.selectedProxyOwner();
  }

  async validateBackendConfiguration(): Promise<void> {
    const selected = this.drivers.backendDrivers();
    const builtInRepository = this.repositoryPolicy.builtInBackendDriver();
    if (builtInRepository !== undefined) {
      selected.repo = builtInRepository;
    }
    validateSelectedBackendDrivers(
      this.backends,
      selected,
      this.drivers.hasSelection("credential_proxy") ? this.selectedProxyOwner() : undefined,
    );
  }

  async getInstallation(principalId: string): Promise<Readonly<Installation>> {
    return this.installationCapabilityQueries.getInstallation(principalId);
  }

  /**
   * The capabilities Agent creation in a Namespace needs, for a caller who may create Agents
   * there but cannot read the Installation, such as a Default user (RFC-0026).
   */
  async getNamespaceAgentCapabilities(
    principalId: string,
    namespaceId: string,
  ): Promise<Readonly<Omit<InstallationCapabilities, "agentProvisioning">>> {
    return this.installationCapabilityQueries.getNamespaceAgentCapabilities(
      principalId,
      namespaceId,
    );
  }

  async getInstallationDeploymentInventory(
    principalId: string,
  ): Promise<Readonly<InstallationDeploymentInventory>> {
    return readDeploymentInventory(
      {
        installationId: this.installation.id,
        authorize: this.authority.authorize,
        read: this.transactions.read,
        driverSelection: (capability) => this.drivers.selection(capability),
        selectCompute: () => this.selectedDriver("compute"),
      },
      principalId,
    );
  }

  async listNamespaces(principalId: string): Promise<readonly Readonly<Namespace>[]> {
    return this.namespaces.listNamespaces(principalId);
  }

  async getNamespace(principalId: string, namespaceId: string): Promise<Readonly<Namespace>> {
    return this.namespaces.getNamespace(principalId, namespaceId);
  }

  async listIAMRoles(principalId: string, namespaceId: string): Promise<readonly Readonly<Role>[]> {
    return this.iamPolicy.listIAMRoles(principalId, namespaceId);
  }

  async createIAMRole(principalId: string, input: CreateIAMRoleInput): Promise<Readonly<Role>> {
    return this.iamPolicy.createIAMRole(principalId, input);
  }

  async getIAMRole(
    principalId: string,
    namespaceId: string,
    roleId: string,
  ): Promise<Readonly<Role>> {
    return this.iamPolicy.getIAMRole(principalId, namespaceId, roleId);
  }

  // Returns the removed Role so the caller can audit what was deleted.
  async deleteIAMRole(
    principalId: string,
    namespaceId: string,
    roleId: string,
  ): Promise<Readonly<Role>> {
    return this.iamPolicy.deleteIAMRole(principalId, namespaceId, roleId);
  }

  async listIAMAccessBindings(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<AccessBinding>[]> {
    return this.iamPolicy.listIAMAccessBindings(principalId, namespaceId);
  }

  /**
   * Configured Group IDs that each account created through the API joins: none when the
   * selected IAM Driver does not hold configured policy in this State.
   */
  get defaultUserGroupIds(): readonly string[] {
    return this.iamPolicy.defaultUserGroupIds();
  }

  async createIAMAccessBinding(
    principalId: string,
    input: CreateIAMAccessBindingInput,
  ): Promise<Readonly<AccessBinding>> {
    return this.iamPolicy.createIAMAccessBinding(principalId, input);
  }

  async getIAMAccessBinding(
    principalId: string,
    namespaceId: string,
    bindingId: string,
  ): Promise<Readonly<AccessBinding>> {
    return this.iamPolicy.getIAMAccessBinding(principalId, namespaceId, bindingId);
  }

  // Returns the removed AccessBinding so the caller can audit who lost access.
  async deleteIAMAccessBinding(
    principalId: string,
    namespaceId: string,
    bindingId: string,
  ): Promise<Readonly<AccessBinding>> {
    return this.iamPolicy.deleteIAMAccessBinding(principalId, namespaceId, bindingId);
  }

  async listIAMServicePrincipals(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<ServicePrincipal>[]> {
    return this.iamPolicy.listIAMServicePrincipals(principalId, namespaceId);
  }

  async getIAMServicePrincipal(
    principalId: string,
    namespaceId: string,
    servicePrincipalId: string,
  ): Promise<Readonly<ServicePrincipal>> {
    return this.iamPolicy.getIAMServicePrincipal(principalId, namespaceId, servicePrincipalId);
  }

  /**
   * Creates a non-Agent ServicePrincipal fixed to one Namespace. It holds no grant until an
   * AccessBinding names it, and its keys are issued through the service-key route.
   */
  async createIAMServicePrincipal(
    principalId: string,
    namespaceId: string,
  ): Promise<Readonly<ServicePrincipal>> {
    return this.iamPolicy.createIAMServicePrincipal(principalId, namespaceId);
  }

  async listAgents(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<AgentRead>[]> {
    return this.agentQueries.listAgents(principalId, namespaceId);
  }

  async listRepositoryOptions(
    principalId: string,
    namespaceId: string,
    agentId?: string,
  ): Promise<Readonly<RepositoryOptions & { notConfigured?: true }>> {
    return this.repositoryPolicy.listRepositoryOptions(principalId, namespaceId, agentId);
  }

  async getAgent(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<Readonly<Agent>> {
    return this.agentQueries.getAuthorizedAgent(principalId, namespaceId, agentId, "read");
  }

  /** Resolve an opaque address before the caller authorizes the exact Agent operation. */
  async resolveAgentReference(
    matches: (agent: Pick<Agent, "id" | "namespaceId">) => boolean,
  ): Promise<Pick<Agent, "id" | "namespaceId"> | undefined> {
    return this.agentQueries.resolveAgentReference(matches);
  }

  /** Resolve stored ownership and authorize before consulting the selected Compute Driver. */
  async resolveAgentChat(
    principalId: string,
    agentId: string,
    namespaceScope?: string,
  ): Promise<{
    readonly agent: Readonly<Agent>;
    readonly revision?: Readonly<AgentRevision>;
    readonly endpoint: AgentChatCompletionsResolution;
  }> {
    return this.agentQueries.resolveAgentChat(principalId, agentId, namespaceScope);
  }

  async getAdministerableAgent(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<Readonly<Agent>> {
    return this.agentQueries.getAuthorizedAgent(principalId, namespaceId, agentId, "administer");
  }

  /** Select the native browser authority for this exact Agent through the selected IAM Driver. */
  async getAgentBrowserAccess(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<{ readonly agent: Readonly<Agent>; readonly mode: "admin" | "chat" }> {
    return this.agentQueries.getAuthorizedAgent(principalId, namespaceId, agentId, "browser");
  }

  async getBrowserAccessibleActiveAgentRevision(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<ActiveAgentRevisionSelection & { readonly mode: "admin" | "chat" }> {
    return this.agentQueries.getAuthorizedActiveAgentRevision(
      principalId,
      namespaceId,
      agentId,
      "browser",
    );
  }

  async getAgentForBrowsing(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<Readonly<AgentRead>> {
    return this.agentQueries.getAgentForBrowsing(principalId, namespaceId, agentId);
  }

  async listAgentAuditEvents(
    principalId: string,
    namespaceId: string,
    agentId: string,
    selection: AgentAuditSelection,
    holdSession: AuthorityFence,
    disclosure: (count: number, decision: DeployAgentAuthorization) => AuditEvent,
  ) {
    return this.readAgentAuditEvents(
      principalId,
      namespaceId,
      agentId,
      selection,
      holdSession,
      disclosure,
    );
  }

  async getAgentRuntimeImages(principalId: string, namespaceId: string, agentId: string) {
    return this.runtimeObservations.getAgentRuntimeImages(principalId, namespaceId, agentId);
  }

  async getAgentHarnessStatus(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<Readonly<AgentHarnessStatusRead>> {
    return this.runtimeObservations.getAgentHarnessStatus(principalId, namespaceId, agentId);
  }

  async getAgentRuntimeCredentialStatus(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<Readonly<AgentRuntimeCredentialStatus>> {
    return this.runtimeCredentials.getAgentRuntimeCredentialStatus(
      principalId,
      namespaceId,
      agentId,
    );
  }

  async provisionAgentRuntimeCredentials(
    principalId: string,
    namespaceId: string,
    agentId: string,
    input: AgentRuntimeCredentialsInput,
  ): Promise<Readonly<AgentRuntimeCredentialStatus>> {
    return this.runtimeCredentials.provisionAgentRuntimeCredentials(
      principalId,
      namespaceId,
      agentId,
      this.runtimeCredentialsInput(input),
    );
  }

  private readonly provisioningRequests = createProvisioningRequests({
    installationId: () => this.installation.id,
    clock: () => this.clock(),
    timestamp: () => this.timestamp(),
    nextIdentifier: (kind) => this.nextIdentifier(kind),
    requestAuditId: () => this.requestAuditId.getStore(),
    backendId: (value) => this.backendId(value),
    exactServiceAccount,
    refuseTakenAgentName,
    transactions: {
      read: (work) => this.read(work),
      transact: (work) => this.mutate(work),
    },
    authority: {
      authorize: (principalId, action, target) => this.authorize(principalId, action, target),
      canRead: (principalId, target) => this.canRead(principalId, target),
      authorizeAgentPrincipal: (callerId, agent, action, resource) =>
        this.authorizeAgentPrincipal(callerId, agent, action, resource),
    },
    namespace: {
      namespaceIdentity: (namespaceId) => this.namespaceIdentity(namespaceId),
      exactNamespace: (state, namespaceId) => this.exactNamespace(state, namespaceId),
      lockNamespace: (state, namespaceId) => this.lockNamespace(state, namespaceId),
    },
    drivers: {
      compute: () => this.runtimeCredentials.runtimeCredentialComputeDriver("provision"),
      configuration: () => this.configurationOperations.selectedDriver(),
      sandbox: () => this.sandboxPolicyOperations.sandboxDriver(),
      iam: () => this.selectedDriver("iam"),
      ownedSecretDriver: (driverId) =>
        this.secretOperations.ownedSecretDriver(
          driverId,
          () => new ProvisioningSecretDriverError(),
        ),
    },
    configuration: {
      validateChannelCredentials: (principalId, namespaceId, configuration, authorizeUse) =>
        this.validateChannelCredentials(
          principalId,
          namespaceId,
          configuration,
          () => new ProvisioningSecretDriverError(),
          undefined,
          authorizeUse,
        ),
      validateContent: (values, bindings, mode) =>
        this.configurationOperations.validateConfigurationContent(
          values,
          undefined,
          bindings,
          this.modelPolicyAgent(mode),
        ),
      resolveHarness: (values, mode) =>
        resolveConfiguredHarnessId(values, this.modelPolicyAgent(mode)),
    },
    harness: () => this.harnessAuthOperations,
    plugins: {
      normalizeAgentPlugins,
      normalizeAgentPluginApprovers,
      validateAgentPlugins: (plugins, approvers, readValues, previous, source) =>
        this.agentPlugins.validateAgentPlugins(plugins, approvers, readValues, previous, source),
      validatePluginCredentialSources: (driver, plugins, sources) =>
        validatePluginCredentialSources(driver, plugins, sources),
      validatePluginPlacement: (driver, plugins, harness) =>
        this.agentPlugins.validatePluginPlacement(driver, plugins, harness),
      pluginOwner: (driver, previous) => pluginOwner(driver, previous),
    },
    repository: {
      admitRepositoryCredentials: (agent, compute, harness, sandboxDriverId, admittedAtWallMs) =>
        this.repositoryPolicy.admitRepositoryCredentials(
          agent,
          compute,
          harness,
          sandboxDriverId,
          admittedAtWallMs,
        ),
      repositorySettings: (namespaceId, input) =>
        this.repositoryPolicy.repositorySettings(namespaceId, input),
      validateRepositoryBrokerNetworkProxy: (harness, configuration, sandbox) =>
        this.validateRepositoryBrokerNetworkProxy(harness, configuration, sandbox),
    },
    topology: {
      rejectCrossNamespaceSecretSources,
      requireDedicatedNativeSupport: (harness, sandbox, options) =>
        requireDedicatedNativeSupport(harness, sandbox, this.nativeWorkers, options),
    },
  });

  async provisionAgent(
    principalId: string,
    input: ProvisionAgentInput,
    auditEvent?: (result: Readonly<ProvisionAgentResult>) => AuditEvent,
    configurationPreparation?: {
      readonly key: string;
      readonly prepare: (
        agent: Pick<Agent, "id" | "namespaceId">,
        values: Readonly<OpenClawConfigurationDocument>,
      ) => Readonly<OpenClawConfigurationDocument>;
    },
  ): Promise<Readonly<ProvisionAgentResult>> {
    return this.provisioningRequests.provisionAgent(
      principalId,
      input,
      auditEvent,
      configurationPreparation,
    );
  }

  async getAgentProvisioning(
    principalId: string,
    namespaceId: string,
    workId: string,
  ): Promise<Readonly<ProvisionAgentResult>> {
    return this.provisioningRequests.getAgentProvisioning(principalId, namespaceId, workId);
  }

  async retryAgentProvisioning(
    principalId: string,
    namespaceId: string,
    workId: string,
  ): Promise<Readonly<ProvisionAgentResult>> {
    return this.provisioningRequests.retryAgentProvisioning(principalId, namespaceId, workId);
  }

  private readonly provisioningWorker: ReturnType<typeof createProvisioningWorker>;

  async processAgentProvisioning(
    claim: ClaimedWork,
    resolveHarness: HarnessResolver,
    options: AgentProvisioningWorkerOptions = {},
  ): Promise<Readonly<AgentProvisioningWorkerOutcome>> {
    return this.provisioningWorker.processAgentProvisioning(claim, resolveHarness, options);
  }

  private provisioningSavedAgentOptions(
    namespaceId: string,
    plan: Readonly<Record<string, unknown>>,
  ): Pick<Agent, "plugins" | "pluginApprovers" | "repositoryBindings" | "repositoryAccess"> {
    const plugins = normalizeAgentPlugins(
      plan.plugins as Readonly<Record<string, PluginDesiredSelection>> | undefined,
    );
    const pluginApprovers = normalizeAgentPluginApprovers(
      plan.pluginApprovers as PluginApprovers | undefined,
    );
    const repositoryBindings = this.repositoryPolicy.repositoryBindingSelections(
      namespaceId,
      plan.repositoryBindings as readonly RepositoryBindingRequest[] | undefined,
      "saved",
    );
    const repositoryAccess = normalizedRepositoryAccess(plan.repositoryAccess, repositoryBindings);
    return {
      ...(plugins === undefined ? {} : { plugins }),
      ...(pluginApprovers === undefined ? {} : { pluginApprovers }),
      ...(repositoryBindings === undefined ? {} : { repositoryBindings }),
      ...(repositoryAccess === undefined ? {} : { repositoryAccess }),
    };
  }

  async diagnoseAgentDeployment(
    principalId: string,
    namespaceId: string,
    agentId: string,
    deploymentId: string,
  ): Promise<Readonly<AgentDeploymentDiagnostics>> {
    return this.runtimeObservations.diagnoseAgentDeployment(
      principalId,
      namespaceId,
      agentId,
      deploymentId,
    );
  }

  async describeAgentRuntime(
    principalId: string,
    namespaceId: string,
    agentId: string,
    deploymentId: string,
    signal?: AbortSignal,
    admitRead: RuntimeLogReadAdmission = (read) => read(),
  ): Promise<Readonly<AgentRuntimeDescription>> {
    return this.runtimeObservations.describeAgentRuntime(
      principalId,
      namespaceId,
      agentId,
      deploymentId,
      signal,
      admitRead,
    );
  }

  async readAgentRuntimeLogs(
    principalId: string,
    namespaceId: string,
    agentId: string,
    deploymentId: string,
    query: RuntimeLogQuery,
    requested: RuntimeLogReadRequest,
  ): Promise<Readonly<RuntimeLogPage>> {
    return this.runtimeObservations.readAgentRuntimeLogs(
      principalId,
      namespaceId,
      agentId,
      deploymentId,
      query,
      requested,
    );
  }

  async getServiceAccount(
    principalId: string,
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<Readonly<ServiceAccount>> {
    return this.serviceAccountOperations.getServiceAccount(
      principalId,
      namespaceId,
      serviceAccountId,
    );
  }

  private readonly savedConnections: ReturnType<typeof createSavedConnections>;

  async listUsableConnectionTemplates(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<ConnectionTemplate>[]> {
    return this.savedConnections.listUsableConnectionTemplates(principalId, namespaceId);
  }

  async startNamespaceConnection(
    principalId: string,
    input: StartNamespaceConnectionInput,
    audit?: (credentialSourceId: string) => AuditEvent,
  ): Promise<{
    readonly credentialSourceId: string;
    readonly authorizationUrl: string;
    readonly expiresAt: string;
  }> {
    return this.savedConnections.startNamespaceConnection(principalId, input, audit);
  }

  async expireAuthenticationStates(limit: number): Promise<void> {
    return this.savedConnections.expireAuthenticationStates(limit);
  }

  async completeNamespaceConnection(
    principalId: string,
    input: CompleteNamespaceConnectionInput,
    audit?: (connection: Readonly<SavedConnection>) => AuditEvent,
    holdSession?: (unit: PlatformUnitOfWork) => Promise<void>,
  ): Promise<Readonly<SavedConnection>> {
    return this.savedConnections.completeNamespaceConnection(
      principalId,
      input,
      audit,
      holdSession,
    );
  }

  async listNamespaceConnections(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<SavedConnection>[]> {
    return this.savedConnections.listNamespaceConnections(principalId, namespaceId);
  }

  async disconnectNamespaceConnection(
    principalId: string,
    namespaceId: string,
    sourceId: string,
    audit?: AuditEvent,
  ): Promise<void> {
    return this.savedConnections.disconnectNamespaceConnection(
      principalId,
      namespaceId,
      sourceId,
      audit,
    );
  }

  async finishConnectionRevocation(namespaceId: string, sourceId: string): Promise<void> {
    return this.savedConnections.finishConnectionRevocation(namespaceId, sourceId);
  }

  private connectionTokenIssuer() {
    const issuer = this.preparedTokens?.issuer("oauth_refresh_token");
    if (!issuer) {
      throw new NotImplementedError(
        "connection_templates",
        "This Installation has no Token Service for browser connections.",
      );
    }
    return issuer;
  }

  /** Used by the installed Token Service to authenticate the original client on each renewal. */
  async resolveConnectionClient(
    reference: OAuthAccountRef,
    approval?: OAuthRefreshTokenRegistration["approval"],
  ): Promise<OAuthConnectionClient> {
    return this.savedConnections.resolveConnectionClient(reference, approval);
  }

  maintainConnectionToken(namespaceId: string, sourceId: string) {
    return this.savedConnections.maintainConnectionToken(namespaceId, sourceId);
  }

  async listConnectionTemplates(
    principalId: string,
  ): Promise<readonly Readonly<ConnectionTemplate>[]> {
    return this.connectionAdministration.listConnectionTemplates(principalId);
  }

  async getConnectionTemplate(
    principalId: string,
    templateId: string,
  ): Promise<Readonly<ConnectionTemplate>> {
    return this.connectionAdministration.getConnectionTemplate(principalId, templateId);
  }

  async discoverConnectionTemplate(
    principalId: string,
    input: { serverUrl: string; issuer?: string },
    discover: DiscoverMcp,
  ) {
    return this.connectionAdministration.discoverConnectionTemplate(principalId, input, discover);
  }

  async createConnectionTemplate(
    principalId: string,
    input: CreateConnectionTemplateInput,
    discover: DiscoverMcp,
    audit?: (id: string) => AuditEvent,
    holdSession?: (unit: PlatformUnitOfWork) => Promise<void>,
  ): Promise<Readonly<ConnectionTemplate>> {
    return this.connectionAdministration.createConnectionTemplate(
      principalId,
      input,
      discover,
      audit,
      holdSession,
    );
  }

  async updateConnectionTemplate(
    principalId: string,
    id: string,
    input: UpdateConnectionTemplateInput,
    discover: DiscoverMcp,
    audit?: AuditEvent,
    holdSession?: (unit: PlatformUnitOfWork) => Promise<void>,
  ) {
    return this.connectionAdministration.updateConnectionTemplate(
      principalId,
      id,
      input,
      discover,
      audit,
      holdSession,
    );
  }

  async deleteConnectionTemplate(
    principalId: string,
    id: string,
    audit?: AuditEvent,
    holdSession?: (unit: PlatformUnitOfWork) => Promise<void>,
  ) {
    return this.connectionAdministration.deleteConnectionTemplate(
      principalId,
      id,
      audit,
      holdSession,
    );
  }

  async listOAuthClients(principalId: string) {
    return this.connectionAdministration.listOAuthClients(principalId);
  }

  async createOAuthClient(
    principalId: string,
    input: CreateOAuthClientInput,
    audit?: (id: string) => AuditEvent,
    holdSession?: (unit: PlatformUnitOfWork) => Promise<void>,
  ) {
    return this.connectionAdministration.createOAuthClient(principalId, input, audit, holdSession);
  }

  async rotateOAuthClientSecret(
    principalId: string,
    id: string,
    clientSecret: string,
    audit?: AuditEvent,
    holdSession?: (unit: PlatformUnitOfWork) => Promise<void>,
  ) {
    return this.connectionAdministration.rotateOAuthClientSecret(
      principalId,
      id,
      clientSecret,
      audit,
      holdSession,
    );
  }

  async deleteOAuthClient(
    principalId: string,
    id: string,
    audit?: AuditEvent,
    holdSession?: (unit: PlatformUnitOfWork) => Promise<void>,
  ) {
    return this.connectionAdministration.deleteOAuthClient(principalId, id, audit, holdSession);
  }

  async cleanupOAuthClients(): Promise<void> {
    return this.connectionAdministration.cleanupOAuthClients();
  }

  /** Trusted, server-side OAuth operations resolve the current value at each use. */
  async withOAuthClientSecret<T>(
    client: Readonly<OAuthClient>,
    use: (secret: string | undefined) => Promise<T>,
  ): Promise<T> {
    return this.connectionAdministration.withOAuthClientSecret(client, use);
  }

  async listServiceAccounts(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<ServiceAccount>[]> {
    return this.serviceAccountOperations.listServiceAccounts(principalId, namespaceId);
  }

  /**
   * One page of the Agent's revisions the principal may read, newest first, as summaries: a
   * list never decodes a saved snapshot (finding 1323). The page holds up to `limit` readable
   * revisions numbered below `before`; unreadable ones are skipped. `nextBefore` names the
   * page's last revision, and only when an older revision was found readable when checked.
   */
  async listRevisions(
    principalId: string,
    namespaceId: string,
    agentId: string,
    page: { readonly before?: number; readonly limit: number } = { limit: 50 },
  ): Promise<Readonly<AgentRevisionListPage>> {
    return this.agentQueries.listRevisions(principalId, namespaceId, agentId, page);
  }

  async getRevision(
    principalId: string,
    namespaceId: string,
    agentId: string,
    revisionId: string,
  ): Promise<Readonly<AgentRevision>> {
    return this.agentQueries.getRevision(principalId, namespaceId, agentId, revisionId);
  }

  async getRevisionForBrowsing(
    principalId: string,
    namespaceId: string,
    agentId: string,
    revisionId: string,
  ): Promise<Readonly<AgentRevisionRead>> {
    return this.agentQueries.getRevisionForBrowsing(principalId, namespaceId, agentId, revisionId);
  }

  async getDeploymentStatus(
    principalId: string,
    namespaceId: string,
    agentId: string,
    deploymentId: string,
  ): Promise<DeploymentStatusResult> {
    return this.agentQueries.getDeploymentStatus(principalId, namespaceId, agentId, deploymentId);
  }

  async getReadableActiveAgentRevision(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<ActiveAgentRevisionSelection> {
    return this.agentQueries.getAuthorizedActiveAgentRevision(
      principalId,
      namespaceId,
      agentId,
      "read",
    );
  }

  async getOperableActiveAgentRevision(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<ActiveAgentRevisionSelection> {
    return this.agentQueries.getAuthorizedActiveAgentRevision(
      principalId,
      namespaceId,
      agentId,
      "operate",
    );
  }

  async getAdministerableActiveAgentRevision(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<ActiveAgentRevisionSelection> {
    return this.agentQueries.getAuthorizedActiveAgentRevision(
      principalId,
      namespaceId,
      agentId,
      "administer",
    );
  }

  private requireNamespaceAdoptionSupport(): void {
    let compute: ComputeDriver;
    try {
      compute = this.selectedDriver("compute");
    } catch {
      throw new ResourceStateConflictError(
        "Existing namespace adoption requires the bundled Kubernetes Compute Driver.",
      );
    }
    if (!BUNDLED_KUBERNETES_COMPUTE.has(compute.implementation)) {
      throw new ResourceStateConflictError(
        "Existing namespace adoption requires the bundled Kubernetes Compute Driver.",
      );
    }
  }

  async createNamespace(
    principalId: string,
    input: CreateNamespaceInput,
  ): Promise<Readonly<Namespace>> {
    return this.namespaces.createNamespace(principalId, input);
  }

  /**
   * Runs `work` with a fence that each transaction writing durable authority applies first: the
   * HTTP layer holds the caller's session through COMMIT, as Namespace policy writes do, so a
   * sign-out or account disable cannot commit in between (#2311).
   */
  withAuthorityFence<T>(fence: AuthorityFence, work: () => Promise<T>): Promise<T> {
    return this.authority.withAuthorityFence(fence, work);
  }

  /** Attach the server-generated HTTP request ID to any work this operation queues. */
  withRequestAuditId<T>(requestId: string, work: () => Promise<T>): Promise<T> {
    return this.workRecorder.withRequestAuditId(requestId, work);
  }

  private holdAuthority(state: PlatformUnitOfWork): Promise<void> {
    return this.authority.holdAuthority(state);
  }

  private applyConfiguredPolicy(
    state: PlatformUnitOfWork,
    actorId: string,
    namespace: Readonly<Namespace>,
  ): Promise<void> {
    return this.iamPolicy.applyConfiguredPolicy(state, actorId, namespace);
  }

  /**
   * Makes the configured Roles, Groups, and Group bindings in IAM policy match the `iam`
   * configuration. The composition calls it at startup, and Installation bootstrap calls it once
   * the Installation exists. It holds the IAM configuration lock exclusively, so a write of
   * durable authority commits wholly before or after it. Owner bindings, deploy-time grants, and
   * Group memberships stay when the configuration changes.
   */
  async applyIAMConfiguration(): Promise<void> {
    return this.iamPolicy.applyIAMConfiguration();
  }

  /** Apply trusted Installation defaults to ready and provisioning Namespaces. */
  async initializeDefaultPresets(
    principalId: string,
    options: { readonly skipRefusedRefresh?: DefaultPresetRefreshSkip } = {},
  ): Promise<readonly SkippedDefaultPreset[]> {
    return this.presets.initializeDefaultPresets(principalId, options);
  }

  async createPreset(principalId: string, input: CreatePresetInput): Promise<Readonly<Preset>> {
    return this.presets.createPreset(principalId, input);
  }

  async listPresets(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<PresetSummary>[]> {
    return this.presets.listPresets(principalId, namespaceId);
  }

  async getPreset(
    principalId: string,
    namespaceId: string,
    presetId: string,
  ): Promise<Readonly<Preset>> {
    return this.presets.getPreset(principalId, namespaceId, presetId);
  }

  /** Check the write grant before the HTTP layer reads the request body. */
  async authorizePresetWrite(
    principalId: string,
    namespaceId: string,
    presetId?: string,
  ): Promise<void> {
    return this.presets.authorizePresetWrite(principalId, namespaceId, presetId);
  }

  async updatePreset(principalId: string, input: UpdatePresetInput): Promise<Readonly<Preset>> {
    return this.presets.updatePreset(principalId, input);
  }

  /** Returns the AccessBindings removed with the Preset, for its deletion audit. */
  async deletePreset(
    principalId: string,
    namespaceId: string,
    presetId: string,
  ): Promise<readonly RemovedAccessBinding[]> {
    return this.presets.deletePreset(principalId, namespaceId, presetId);
  }

  private readonly configurationOperations: ReturnType<typeof createConfigurationOperations>;

  /**
   * The grant check that opens createConfiguration (no configurationId) or
   * updateConfiguration, alone. The HTTP layer runs it before it reads a write's body (up to
   * about 6 MiB), so a caller without the grant is refused without the body being buffered.
   * Both writes repeat it in their transaction, followed by the Secret binding checks.
   */
  async authorizeConfigurationWrite(
    principalId: string,
    namespaceId: string,
    configurationId?: string,
  ): Promise<void> {
    return this.configurationOperations.authorizeConfigurationWrite(
      principalId,
      namespaceId,
      configurationId,
    );
  }

  // On the bundled Kubernetes Compute, which delivers channel credentials only from bindings, the
  // channel credential rule its deployment admission applies (finding 2319).
  private requireBundledChannelBindings(
    values: OpenClawConfigurationDocument,
    secretBindings: SecretBindings,
  ): void {
    if (this.bundledKubernetesCompute()) {
      requireChannelSecretBindings(
        values,
        enabledChannelEntries(values),
        (name) => Object.hasOwn(secretBindings, name),
        (setting, requirement) =>
          new ConfigurationHarnessError(configurationSettingMessage(setting, requirement)),
      );
    }
  }

  // The bundled Kubernetes Compute Driver: OCC applies its documented facts that no Driver member
  // carries (existing namespace adoption, channel credentials delivered only from bindings).
  private bundledKubernetesCompute(): boolean {
    const implementation = this.drivers.selection("compute")?.driver.implementation;
    return implementation !== undefined && BUNDLED_KUBERNETES_COMPUTE.has(implementation);
  }

  // Configuration content every topology of the selected Compute Driver refuses is refused
  // where it is written (Configuration create and update, provisioning, Preset defaults), with
  // the Driver's ConfigurationHarnessError naming the setting. A stored Configuration that
  // predates a rule still reads; deployment refuses it with the same message.
  private validateComputeConfiguration(
    values: Readonly<OpenClawConfigurationDocument>,
    options?: ConfigurationValidationOptions,
  ): void {
    const compute = this.drivers.selection("compute")?.driver as ComputeDriver | undefined;
    compute?.validateConfiguration?.(values, options);
  }

  async createSecret(
    principalId: string,
    input: CreateSecretInput,
  ): Promise<Readonly<SecretMetadata>> {
    return this.secretOperations.createSecret(principalId, input);
  }

  async readSecret(
    principalId: string,
    namespaceId: string,
    secretId: string,
  ): Promise<Readonly<SecretDetail>> {
    return this.secretOperations.readSecret(principalId, namespaceId, secretId);
  }

  async listSecrets(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<SecretMetadata>[]> {
    return this.secretOperations.listSecrets(principalId, namespaceId);
  }

  /**
   * The IDs of the Namespace's Secrets the principal may read but not operate, sorted: an
   * advisory answer for clients that bind Secrets, which needs operate on each (finding 2453).
   * Each decision is the one binding makes. One read unit makes them all, so the selected IAM
   * Driver reads its policy once, not once per Secret; a false decision is an answer, not an
   * audited attempt. The caller checks Namespace read first.
   */
  async listSecretsOperateDenied(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly string[]> {
    return (await this.secretsOperateDenied(principalId, namespaceId, new Set())).readable;
  }

  /**
   * The Namespace's Secrets the principal may read but not operate (`readable`, sorted IDs), and
   * how many of its Secrets in `unreadableAmong` the principal may neither read nor operate
   * (`unreadableCount`): an advisory count for a client that deploys a draft binding them, which
   * needs operate on each (finding D756). The count names none, since the principal may not read
   * them. One read unit and one Secret scan; a false decision is an answer, not an audited
   * attempt. The caller checks Namespace read first.
   */
  async secretsOperateDenied(
    principalId: string,
    namespaceId: string,
    unreadableAmong: ReadonlySet<string>,
  ): Promise<{ readonly readable: readonly string[]; readonly unreadableCount: number }> {
    return this.secretOperations.secretsOperateDenied(principalId, namespaceId, unreadableAmong);
  }

  async updateSecret(
    principalId: string,
    input: UpdateSecretInput,
  ): Promise<Readonly<SecretMetadata>> {
    return this.secretOperations.updateSecret(principalId, input);
  }

  /** Returns the AccessBindings removed with the Secret, for its deletion audit. */
  async deleteSecret(
    principalId: string,
    namespaceId: string,
    secretId: string,
  ): Promise<readonly RemovedAccessBinding[]> {
    return this.secretOperations.deleteSecret(principalId, namespaceId, secretId);
  }

  /** Trusted composition only: public workloads never supply an identity verifier. */
  createCredentialProxy(exchangeOwner: EgressExchangeOwner): CredentialProxy {
    return new CredentialProxy(
      createEgressAuthority(exchangeOwner, {
        installationId: this.installation.id,
        clock: () => this.clock(),
        timestamp: () => this.timestamp(),
        inTransaction: this.transactions.hasContext,
        readSnapshot: (work) => this.state.read(work),
        transact: (work) => this.transact(work),
        lockNamespace: (state, namespaceId) => this.lockNamespace(state, namespaceId),
        proxyDriver: () => this.selectedDriver("credential_proxy"),
        selectedProxyOwner: () => this.selectedProxyOwner(),
        secretDriver: this.secretOperations.secretDriver,
        computeDriver: () => this.selectedDriver("compute"),
        credentialPlacement: this.credentialSourceDrivers.credentialPlacement,
        credentialNamespace: this.credentialSourceDrivers.credentialNamespace,
        credentialGatewayOperation,
        authorizationAuthority: (principalId) => this.authorizationAuthority(principalId),
        authorizationDecision: (principalId, resource, authority, authorize) =>
          this.authorizationDecision(principalId, "operate", resource, authority, authorize),
        authorizeUse: (principalId, resource) => this.authorize(principalId, "operate", resource),
        usesNativeAuthorization: (authority, authorize) =>
          !this.authorization &&
          NativeIAMDriver.usesStateForAuthorization(authority, authorize, this.state),
        currentCredentialSourceOwner: this.credentialSourceDrivers.currentCredentialSourceOwner,
        preparedTokens: this.preparedTokens,
        resolvePrepared: (key, options) =>
          this.tokenService().resolve(
            { kind: this.preparedIssuer(key.provider).tokenKind, key },
            options,
          ),
        receipts: new EgressSendReceipts(this.state),
      }),
      this.credentialProxyCapacity,
    );
  }

  private tokenService(): TokenService {
    if (!this.preparedTokens) {
      throw new DependencyUnavailableError("The Token Service is unavailable.");
    }
    return this.preparedTokens;
  }

  private preparedIssuer(provider: EgressRef) {
    const lifecycle = this.preparedTokens?.issuer(provider);
    if (!lifecycle) {
      throw new DependencyUnavailableError(
        "The admitted prepared credential issuer is not configured.",
      );
    }
    return lifecycle;
  }

  private async admitProxyPlan(
    state: PlatformUnitOfWork,
    agent: Readonly<Agent>,
    revisionId: string,
    configuration: OpenClawConfigurationDocument,
    sandboxDriverId?: string,
    repositoryGit?: RepositoryRevisionState,
    harnessAuth?: HarnessAuthSnapshot,
    harnessConfiguration?: Readonly<Record<string, unknown>>,
  ): Promise<{ plan: ProxyPlan; assertProvidersCurrent: () => void } | undefined> {
    return this.egressAdmission.admitProxyPlan(
      state,
      agent,
      revisionId,
      configuration,
      sandboxDriverId,
      repositoryGit,
      harnessAuth,
      harnessConfiguration,
    );
  }

  private readonly credentialSourceDrivers = createCredentialSourceDrivers({
    selectedDriver: (capability) => this.selectedDriver(capability),
    hasRefreshDriver: () => this.drivers.hasSelection("credential_refresh"),
    selectedProxyOwner: () => this.selectedProxyOwner(),
  });

  private readonly egressAdmission: ReturnType<typeof createCredentialEgressAdmission>;

  /** Bind the configured adapter to the actual durable credential store before use. */
  async activateTokenServiceInstance(driverId: string, storeIdentity: string): Promise<string> {
    return this.managedCredentialSources.activateTokenServiceInstance(driverId, storeIdentity);
  }

  currentTokenServiceInstanceId(): string {
    return this.managedCredentialSources.currentTokenServiceInstanceId();
  }

  private ownedTokenServiceDriver(instanceId?: string): TokenServiceDriver {
    return this.managedCredentialSources.ownedTokenServiceDriver(instanceId);
  }

  async createManagedCredentialSource(
    principalId: string,
    namespaceId: string,
    input: Omit<SourceRegistrationInput, "sourceRef" | "tokenServiceInstanceId"> & {
      readonly name: string;
      readonly providerPreset?: SourceProviderPresetId;
    },
    audit: (resource: CredentialSourceReference, phase?: "registration_started") => AuditEvent,
  ): Promise<Readonly<CredentialSourceMetadata>> {
    return this.managedCredentialSources.createManagedCredentialSource(
      principalId,
      namespaceId,
      input,
      audit,
    );
  }

  async updateManagedCredentialSource(
    principalId: string,
    ref: { readonly namespaceId: string; readonly credentialSourceId: string },
    input: UpdateManagedCredentialSourceInput,
    audit: (resource: CredentialSourceReference, phase?: "update_started") => AuditEvent,
    failureAudit: (reasonCode: string) => AuditEvent,
  ): Promise<Readonly<CredentialSourceMetadata>> {
    return this.managedCredentialSources.updateManagedCredentialSource(
      principalId,
      ref,
      input,
      audit,
      failureAudit,
    );
  }

  async authorizeCredentialSourceWrite(
    principalId: string,
    namespaceId: string,
    credentialSourceId?: string,
  ): Promise<void> {
    return this.credentialSourceOperations.authorizeCredentialSourceWrite(
      principalId,
      namespaceId,
      credentialSourceId,
    );
  }

  async createCredentialSource(
    principalId: string,
    input: CreateCredentialSourceInput,
    audit?: (source: Readonly<CredentialSourceMetadata>) => AuditEvent,
    registrationAudit?: (source: Readonly<CredentialSourceMetadata>) => AuditEvent,
  ): Promise<Readonly<CredentialSourceMetadata & { readonly status?: CredentialSourceStatus }>> {
    return this.credentialSourceOperations.createCredentialSource(
      principalId,
      input,
      audit,
      registrationAudit,
    );
  }

  async updateCredentialSource(
    principalId: string,
    input: UpdateCredentialSourceInput,
    failureAudit?: (reasonCode: string) => AuditEvent,
  ): Promise<Readonly<CredentialSourceMetadata & { readonly status?: CredentialSourceStatus }>> {
    return this.credentialSourceOperations.updateCredentialSource(principalId, input, failureAudit);
  }

  async rotateCredentialSource(
    principalId: string,
    input: RotateCredentialSourceInput,
    failureAudit?: (reasonCode: string) => AuditEvent,
    audit?: AuditEvent,
  ): Promise<Readonly<CredentialSourceMetadata & { readonly status?: CredentialSourceStatus }>> {
    return this.credentialSourceOperations.rotateCredentialSource(
      principalId,
      input,
      failureAudit,
      audit,
    );
  }

  async readCredentialSource(
    principalId: string,
    namespaceId: string,
    credentialSourceId: string,
  ): Promise<Readonly<CredentialSourceMetadata & { readonly status?: CredentialSourceStatus }>> {
    return this.credentialSourceOperations.readCredentialSource(
      principalId,
      namespaceId,
      credentialSourceId,
    );
  }

  async listCredentialSources(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<CredentialSourceMetadata>[]> {
    return this.credentialSourceOperations.listCredentialSources(principalId, namespaceId);
  }

  async deleteCredentialSource(
    principalId: string,
    namespaceId: string,
    credentialSourceId: string,
    audit?: (removedAccessBindings: readonly RemovedAccessBinding[]) => AuditEvent,
    connection?: typeof PENDING_CONNECTION,
  ): Promise<void> {
    return this.managedCredentialSources.deleteCredentialSource(
      principalId,
      namespaceId,
      credentialSourceId,
      audit,
      connection,
    );
  }

  async deleteManagedCredentialSource(
    principalId: string,
    namespaceId: string,
    credentialSourceId: string,
    audit: (removed: readonly RemovedAccessBinding[], phase?: "retirement_started") => AuditEvent,
  ): Promise<void> {
    return this.managedCredentialSources.deleteManagedCredentialSource(
      principalId,
      namespaceId,
      credentialSourceId,
      audit,
    );
  }

  private retireCredentialSourceMaterial(
    namespace: Readonly<Namespace>,
    source: Readonly<CredentialSource>,
    gateway: CredentialGatewayDriver | undefined,
  ): Promise<void> {
    return this.managedCredentialSources.retireCredentialSourceMaterial(namespace, source, gateway);
  }

  async createConfiguration(
    principalId: string,
    input: CreateConfigurationInput,
  ): Promise<Readonly<Configuration>> {
    return this.configurationOperations.createConfiguration(principalId, input);
  }

  async createServiceAccount(
    principalId: string,
    input: CreateServiceAccountInput,
  ): Promise<Readonly<ServiceAccount>> {
    return this.serviceAccountOperations.createServiceAccount(principalId, input);
  }

  async createServiceAccountCredential(
    principalId: string,
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<Readonly<ServiceAccount>> {
    return this.serviceAccountOperations.createServiceAccountCredential(
      principalId,
      namespaceId,
      serviceAccountId,
    );
  }

  async updateServiceAccountCredential(
    principalId: string,
    namespaceId: string,
    serviceAccountId: string,
    credential: ServiceAccountCredential,
  ): Promise<Readonly<ServiceAccount>> {
    return this.serviceAccountOperations.updateServiceAccountCredential(
      principalId,
      namespaceId,
      serviceAccountId,
      credential,
    );
  }

  /**
   * `force` matters only for an account holding an issued access token while this API selects
   * no ServiceAccount Driver (no ChatGPT Backend): instead of refusing, it removes the
   * account-owned token Secret and the account, and reports the token as unrevoked. With a
   * Driver selected, force is ignored and the token is revoked as usual, so a revocation that
   * can run is never skipped. Grants, the account lookup, and reference checks are unchanged.
   */
  async deleteServiceAccount(
    principalId: string,
    namespaceId: string,
    serviceAccountId: string,
    options: { readonly force?: boolean } = {},
  ): Promise<ServiceAccountDeletion> {
    return this.serviceAccountOperations.deleteServiceAccount(
      principalId,
      namespaceId,
      serviceAccountId,
      options,
    );
  }

  async getConfiguration(
    principalId: string,
    namespaceId: string,
    configurationId: string,
  ): Promise<Readonly<Configuration>> {
    return this.configurationOperations.getConfiguration(principalId, namespaceId, configurationId);
  }

  /**
   * The Secret each binding name of a Configuration binds now, from its record alone. Each save
   * of the Configuration authorizes Secret operate on every Secret it submits, or on every bound
   * Secret when it submits no bindings, so the caller-permissions answer checks these. Requires
   * Configuration read. Unlike getConfiguration it skips the provisioning guard, so it also
   * answers before provisioning has written the Configuration. That is safe: saves are refused
   * while the Agent is provisioning, so the answer enables no save, and the guard's 409 would
   * fail the whole caller-permissions answer.
   */
  async getConfigurationSecretBindingSources(
    principalId: string,
    namespaceId: string,
    configurationId: string,
  ): Promise<Readonly<Record<string, Readonly<ResourceRef>>>> {
    return this.configurationOperations.getConfigurationSecretBindingSources(
      principalId,
      namespaceId,
      configurationId,
    );
  }

  async updateConfiguration(
    principalId: string,
    input: UpdateConfigurationInput,
  ): Promise<Readonly<Configuration>> {
    return this.configurationOperations.updateConfiguration(principalId, input);
  }

  async deleteConfiguration(
    principalId: string,
    namespaceId: string,
    configurationId: string,
  ): Promise<readonly RemovedAccessBinding[]> {
    return this.configurationOperations.deleteConfiguration(
      principalId,
      namespaceId,
      configurationId,
    );
  }

  private async authorizeDeviceAuthorizationScope(
    principalId: string,
    namespaceId: string,
    agentId?: string,
  ): Promise<void> {
    if (agentId === undefined) {
      await this.authorize(principalId, "create", { kind: "agent", id: namespaceId, namespaceId });
    } else {
      const resource = { kind: "agent" as const, id: agentId, namespaceId };
      await this.authorize(principalId, "read", resource);
      await this.authorize(principalId, "update", resource);
    }
    await this.read(async (state) => {
      const namespace = await this.exactNamespace(state, namespaceId);
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      if (agentId !== undefined) {
        const agent = await state.agents.findAgent(namespaceId, agentId);
        if (agent === undefined) {
          throw new ScopeViolationError("The Agent does not belong to the exact Namespace.");
        }
        if (agent.status !== "active") {
          throw new AgentDeletingError();
        }
        if (agent.executionMode !== "dedicated") {
          throw new NotImplementedError(
            "agent_device_authorization",
            "Device login requires a dedicated Agent.",
          );
        }
      }
    });
  }

  private async authorizedCredentialSource(
    principalId: string,
    namespaceId: string,
    sourceId: string,
  ) {
    return this.credentialSourceOperations.authorizedCredentialSource(
      principalId,
      namespaceId,
      sourceId,
    );
  }

  private async credentialSourceContext(namespaceId: string, sourceId: string) {
    return this.credentialSourceOperations.credentialSourceContext(namespaceId, sourceId);
  }

  async startAgentDeviceAuthorization(
    principalId: string,
    namespaceId: string,
    harnessId: string,
    agentId?: string,
    audit?: DeviceAuthorizationAudit,
  ) {
    return this.deviceAuthorization.start(principalId, namespaceId, harnessId, agentId, audit);
  }

  async pollAgentDeviceAuthorization(
    principalId: string,
    namespaceId: string,
    sessionId: string,
    agentId?: string,
  ) {
    return this.deviceAuthorization.poll(principalId, namespaceId, sessionId, agentId);
  }

  async cancelAgentDeviceAuthorization(
    principalId: string,
    namespaceId: string,
    sessionId: string,
    agentId?: string,
  ): Promise<void> {
    return this.deviceAuthorization.cancel(principalId, namespaceId, sessionId, agentId);
  }

  async discoverAgentModels(
    principalId: string,
    namespaceId: string,
    input: {
      readonly provider: string;
      readonly authMethod: "api_key" | "codex_pat";
      readonly apiKey: string;
    },
  ) {
    return this.setupDiscovery.discoverAgentModels(principalId, namespaceId, input);
  }

  async discoverAgentPlugins(
    principalId: string,
    namespaceId: string,
    input: PluginDiscoveryCredential & {
      readonly harnessId: string;
      readonly cursor?: string;
      readonly q?: string;
    },
    signal?: AbortSignal,
  ): Promise<PluginCatalogPage> {
    return this.pluginDiscovery.discoverAgentPlugins(principalId, namespaceId, input, signal);
  }

  async lookupChannelDirectory(
    principalId: string,
    namespaceId: string,
    input: LookupChannelDirectoryInput,
    signal?: AbortSignal,
  ): Promise<ChannelDirectoryResult> {
    return this.setupDiscovery.lookupChannelDirectory(principalId, namespaceId, input, signal);
  }

  async discoverAgentPluginDetails(
    principalId: string,
    namespaceId: string,
    input: PluginDiscoveryCredential & { readonly harnessId: string; readonly pluginId: string },
    signal?: AbortSignal,
  ): Promise<PluginCatalogEntry> {
    return this.pluginDiscovery.discoverAgentPluginDetails(principalId, namespaceId, input, signal);
  }

  async getSavedAgentPluginPolicyCapabilities(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ) {
    return this.pluginDiscovery.getSavedAgentPluginPolicyCapabilities(
      principalId,
      namespaceId,
      agentId,
    );
  }

  async discoverSavedAgentPlugins(
    principalId: string,
    namespaceId: string,
    agentId: string,
    input: {
      readonly cursor?: string;
      readonly q?: string;
      readonly credentialSource?: CredentialSourceReference;
    },
    signal?: AbortSignal,
  ): Promise<PluginCatalogPage> {
    return this.pluginDiscovery.discoverSavedAgentPlugins(
      principalId,
      namespaceId,
      agentId,
      input,
      signal,
    );
  }

  async discoverSavedAgentPluginDetails(
    principalId: string,
    namespaceId: string,
    agentId: string,
    input: {
      readonly pluginId: string;
      readonly credentialSource?: CredentialSourceReference;
      readonly managedConnection?: ManagedMcpConnection;
    },
    signal?: AbortSignal,
    readMcpTools?: ManagedMcpToolReader,
  ): Promise<PluginCatalogEntry> {
    return this.pluginDiscovery.discoverSavedAgentPluginDetails(
      principalId,
      namespaceId,
      agentId,
      input,
      signal,
      readMcpTools,
    );
  }

  async discoverConfigurations(
    principalId: string,
    context: ConfigurationContext,
  ): Promise<readonly DriverConfigurationDescriptor[]> {
    return this.setupDiscovery.discoverConfigurations(principalId, context);
  }

  private async protectedExecutionApplies(
    state: PlatformReadView,
    agent: Readonly<Agent>,
    activeRevision: Readonly<AgentRevision> | undefined,
  ): Promise<boolean> {
    if (activeRevision !== undefined && !unprotectedPolicyRevision(activeRevision)) {
      return true;
    }
    if (!this.drivers.hasSelection("credential_proxy")) {
      return false;
    }
    if (
      !this.selectedProxyOwner().allowsOrdinaryCredentialGateway() ||
      (agent.repositoryBindings?.length ?? 0) > 0
    ) {
      return true;
    }
    return !(await this.ordinaryModelBinding(state, agent));
  }

  async validateAgentSandboxPolicy(
    principalId: string,
    namespaceId: string,
    agentId: string,
    facet: SandboxFacet,
    expectedVersion: number,
    additions: unknown,
  ): Promise<ConfigurationResult<{ readonly additions: readonly SandboxNetworkGrant[] }>> {
    return this.sandboxPolicyOperations.validateAgentSandboxPolicy(
      principalId,
      namespaceId,
      agentId,
      facet,
      expectedVersion,
      additions,
    );
  }

  async getAgentSandboxPolicy(
    principalId: string,
    namespaceId: string,
    agentId: string,
    facet: SandboxFacet,
  ) {
    return this.sandboxPolicyOperations.getAgentSandboxPolicy(
      principalId,
      namespaceId,
      agentId,
      facet,
    );
  }

  // TODO: Replace this temporary admission switch with the platform Guardrails primitive.
  async TEMPORARY_API_WILL_BREAK_IN_FUTURE_setAgentSandboxPolicyEditing(
    principalId: string,
    namespaceId: string,
    agentId: string,
    facet: SandboxFacet,
    enabled: boolean,
  ): Promise<Readonly<Agent>> {
    return this.sandboxPolicyOperations.setAgentSandboxPolicyEditing(
      principalId,
      namespaceId,
      agentId,
      facet,
      enabled,
    );
  }

  async updateAgentSandboxPolicy(
    principalId: string,
    namespaceId: string,
    agentId: string,
    facet: SandboxFacet,
    expectedVersion: number,
    additions: readonly SandboxNetworkGrant[],
  ): Promise<Readonly<SandboxPolicy>> {
    return this.sandboxPolicyOperations.updateAgentSandboxPolicy(
      principalId,
      namespaceId,
      agentId,
      facet,
      expectedVersion,
      additions,
    );
  }

  async applyAgentSandboxPolicy(
    principalId: string,
    namespaceId: string,
    agentId: string,
    facet: SandboxFacet,
    expectedVersion: number,
    revisionId: string,
    additions?: readonly SandboxNetworkGrant[],
  ): Promise<Readonly<SandboxPolicy>> {
    return this.sandboxPolicyOperations.applyAgentSandboxPolicy(
      principalId,
      namespaceId,
      agentId,
      facet,
      expectedVersion,
      revisionId,
      additions,
    );
  }

  async readAgentSandboxRecommendations(
    principalId: string,
    namespaceId: string,
    agentId: string,
    facet: SandboxFacet,
    revisionId: string,
    admitRead: (
      read: () => Promise<SandboxPolicyRecommendations>,
    ) => Promise<SandboxPolicyRecommendations>,
  ): Promise<SandboxPolicyRecommendations> {
    return this.sandboxPolicyOperations.readAgentSandboxRecommendations(
      principalId,
      namespaceId,
      agentId,
      facet,
      revisionId,
      admitRead,
    );
  }

  async createAgent(
    principalId: string,
    input: CreateAgentInput,
    resolveHarness?: HarnessResolver,
    configurationPreparation?: AgentConfigurationPreparation,
  ): Promise<Readonly<Agent>> {
    return this.agentDrafts.createAgent(
      principalId,
      input,
      resolveHarness,
      configurationPreparation,
    );
  }

  /**
   * Create Agent's preflight, for a Configuration the caller has not saved yet: createConfiguration's
   * content and Driver admission, then createAgent's checks of plugin selections and initial workspace files
   * against those values, with their messages, under createAgent's `agent:create` check. A
   * refusal is reported before the caller saves its Secret or Configuration. It writes nothing.
   * With `harnessAuth`, Agent save's Harness authentication check against the Compute Driver runs
   * too, so a refusal that depends only on the Agent's topology (finding 2391) is reported here.
   * With `configuration.secretBindings`, a foreign-Namespace reference or a channel credential
   * reference without a binding is refused as Configuration create would; the bound Secrets
   * are not read.
   * Checks that need saved resources (the bound Secrets, the Harness authentication source and
   * credential sources) or live repository policy stay with those writes.
   * With `name`, a name another Agent in the Namespace has is refused last, with create's 409
   * (finding 2420), so the form saves no Secret or Configuration for it. The check is advisory:
   * the store's unique name still refuses a create that races it.
   * `resolveHarness` as in createAgent.
   */
  async validateAgentCreate(
    principalId: string,
    input: ValidateAgentCreateInput,
    resolveHarness?: HarnessResolver,
  ): Promise<void> {
    return this.agentDrafts.validateAgentCreate(principalId, input, resolveHarness);
  }

  async listAgentStandingApprovals(principalId: string, namespaceId: string, agentId: string) {
    return this.repositoryPolicy.listAgentStandingApprovals(principalId, namespaceId, agentId);
  }

  /** A review projection only: it neither creates nor extends authority. */
  async listAgentStandingApprovalScopes(principalId: string, namespaceId: string, agentId: string) {
    return this.repositoryPolicy.listAgentStandingApprovalScopes(principalId, namespaceId, agentId);
  }

  /** Denial commits independently of configuration, provider availability or runtime cleanup. */
  async removeAgentStandingApproval(
    principalId: string,
    input: RemoveStandingApprovalInput,
  ): Promise<void> {
    return this.repositoryPolicy.removeAgentStandingApproval(principalId, input);
  }

  /**
   * `resolveHarness` (the deploy route's resolver) lets the save refuse a Harness/mode
   * mismatch and the Compute Driver's checks of the Agent against its Configuration, as
   * deployment would. Without it only the Sandbox execution-mode rule runs.
   */
  async updateAgent(
    principalId: string,
    input: UpdateAgentInput,
    resolveHarness?: HarnessResolver,
  ): Promise<Readonly<Agent>> {
    return this.agentDrafts.updateAgent(principalId, input, resolveHarness);
  }

  private normalizedHarnessOverrides(value: unknown): Readonly<Record<string, unknown>> {
    const overrides = value === undefined ? {} : asRecord(value);
    if (overrides === undefined) {
      throw new ConfigurationHarnessError("Harness overrides must be an object.");
    }
    let compute: ComputeDriver;
    try {
      compute = this.selectedDriver("compute");
    } catch {
      throw new DependencyUnavailableError("The selected compute Driver is unavailable.");
    }
    if (compute.normalizeHarnessOverrides === undefined) {
      if (Object.keys(overrides).length !== 0) {
        throw new ConfigurationHarnessError(
          "The selected Compute does not support Harness overrides.",
        );
      }
      return Object.freeze({});
    }
    return immutableCopy(compute.normalizeHarnessOverrides(overrides));
  }

  private captureFirstDeploymentRequest(
    principalId: string,
    input: DeployAgentInput,
    intent: FirstDeploymentIntent,
  ) {
    // Own the normalized request and intent before asynchronous work.
    const target = {
      namespaceId: input.namespaceId,
      agentId: input.agentId,
      harnessOverrides: this.normalizedHarnessOverrides(input.harnessOverrides),
    };
    const capturedIntent = intent && {
      key: intent.key,
      expectedConfigurationId: intent.expectedConfigurationId,
      expectedGeneration: intent.expectedGeneration,
    };
    if (
      !capturedIntent ||
      typeof capturedIntent.key !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/.test(capturedIntent.key) ||
      !Number.isSafeInteger(capturedIntent.expectedGeneration) ||
      capturedIntent.expectedGeneration < 1
    ) {
      throw new ScopeViolationError("Invalid first-deployment intent.");
    }
    if (!isNonEmptyString(target.agentId)) {
      throw new ScopeViolationError("The exact Agent identity is missing.");
    }
    this.configurationOperations.configurationIdentity(
      target.namespaceId,
      capturedIntent.expectedConfigurationId,
    );
    const digest = createHash("sha256")
      .update(
        JSON.stringify([
          "agent.deploy-first.v1",
          this.installation.id,
          principalId,
          target.namespaceId,
          target.agentId,
          capturedIntent.key,
          capturedIntent.expectedConfigurationId,
          capturedIntent.expectedGeneration,
          canonicalProvisioningJson(target.harnessOverrides),
        ]),
      )
      .digest("hex");
    return { target, intent: capturedIntent, digest };
  }

  private async authorizeFirstDeploymentReceipt(
    principalId: string,
    input: DeployAgentInput,
    intent: FirstDeploymentIntent,
  ): Promise<DeployAgentAuthorization> {
    const authorization = await this.authorize(principalId, "deploy", {
      kind: "agent",
      id: input.agentId,
      namespaceId: input.namespaceId,
    });
    await this.authorize(principalId, "read", {
      kind: "configuration",
      id: intent.expectedConfigurationId,
      namespaceId: input.namespaceId,
    });
    return authorization;
  }

  private async lookupFirstDeployment(
    state: PlatformReadView,
    principalId: string,
    input: DeployAgentInput,
    intent: FirstDeploymentIntent,
    digest: string,
  ) {
    await this.authorizeFirstDeploymentReceipt(principalId, input, intent);
    await this.exactNamespace(state, input.namespaceId);
    const agent = await state.agents.findAgent(input.namespaceId, input.agentId);
    if (!agent) {
      throw new ScopeViolationError("The Agent does not belong to the exact Namespace.");
    }
    const receipt = await state.revisions.findFirstDeploymentReceipt(
      input.namespaceId,
      input.agentId,
      digest,
    );
    return { agent, receipt };
  }

  async recoverAgentFirstDeployment(
    principalId: string,
    input: DeployAgentInput,
    intent: FirstDeploymentIntent,
  ): Promise<Readonly<FirstDeploymentReceipt> | null> {
    const {
      target,
      intent: capturedIntent,
      digest,
    } = this.captureFirstDeploymentRequest(principalId, input, intent);
    return this.read(
      async (state) =>
        (await this.lookupFirstDeployment(state, principalId, target, capturedIntent, digest))
          .receipt ?? null,
    );
  }

  async deployAgentFirst(
    principalId: string,
    input: DeployAgentInput,
    intent: FirstDeploymentIntent,
    resolveHarness: HarnessResolver,
    auditEvent?: (result: Readonly<AuthorizedAgentDeployment>) => AuditEvent,
  ): Promise<Readonly<FirstDeploymentReceipt>> {
    if (this.transactions.hasContext()) {
      throw new ResourceConflictError(
        "Guarded channel validation must run outside a controller transaction.",
      );
    }
    const {
      target,
      intent: capturedIntent,
      digest,
    } = this.captureFirstDeploymentRequest(principalId, input, intent);
    // Receipt, draft, and history must come from the same read snapshot. In
    // PostgreSQL this is one REPEATABLE READ transaction, before provider I/O.
    const initial = await this.read(async (state) => {
      const { agent, receipt } = await this.lookupFirstDeployment(
        state,
        principalId,
        target,
        capturedIntent,
        digest,
      );
      if (receipt !== undefined) {
        return { receipt };
      }
      if (agent.status !== "active") {
        throw new AgentDeletingError();
      }
      if (agent.configurationId !== capturedIntent.expectedConfigurationId) {
        throw new ResourceStateConflictError(
          "The Agent uses a different Configuration. Recover the original first-deployment receipt after an uncertain result, then review the current binding before deploying.",
        );
      }
      if ((await state.revisions.listRevisionMetadata(target.namespaceId, agent.id)).length !== 0) {
        throw new ResourceStateConflictError(
          "The Agent already has revision history. Recover the original first-deployment receipt after an uncertain result; use ordinary deploy only for an intentional later revision.",
        );
      }
      if (agent.desiredRuntimeState !== "stopped") {
        throw new ResourceStateConflictError(
          "The Agent is not stopped. Recover the original first-deployment receipt after an uncertain result and inspect deployment status before proceeding.",
        );
      }
      const metadata = await state.configurations.findConfiguration(
        target.namespaceId,
        capturedIntent.expectedConfigurationId,
      );
      if (!metadata || metadata.generation !== capturedIntent.expectedGeneration) {
        throw new ResourceStateConflictError(
          "The expected Configuration generation is unavailable. Recover the original first-deployment receipt after an uncertain result, then review the current Configuration before deploying.",
        );
      }
      return { metadata };
    });
    if (initial.receipt !== undefined) {
      return initial.receipt;
    }
    let preparation: FirstDeploymentGuard["preparation"];
    try {
      preparation = {
        prepared: await this.prepareDeploymentChannels(principalId, target, initial.metadata),
      };
    } catch (error) {
      // A concurrent matching admission wins over a fresh-only preparation failure.
      // Reauthorize and look up its receipt under the Agent lock before surfacing it.
      preparation = { error };
    }
    const result = await this.admitAgentDeployment(
      principalId,
      target,
      resolveHarness,
      auditEvent,
      {
        digest,
        intent: capturedIntent,
        preparation,
      },
    );
    if (!("revision" in result)) {
      return result;
    }
    const { revision } = result;
    return Object.freeze({
      revisionId: revision.id,
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      configurationId: revision.configurationId,
      configurationGeneration: revision.configurationGeneration,
      createdAt: revision.createdAt,
    });
  }

  async deployAgent(
    principalId: string,
    input: DeployAgentInput,
    resolveHarness: HarnessResolver,
  ): Promise<Readonly<AgentRevision>> {
    return (await this.deployAgentWithAuthorization(principalId, input, resolveHarness)).revision;
  }

  private async validateChannelCredentials(
    principalId: string,
    namespaceId: string,
    configuration: Pick<Configuration, "values" | "secretBindings">,
    driverFailure: () => SecretDriverOwnershipError,
    driver = this.drivers.selection("channel")?.driver as ChannelDriver | undefined,
    authorizeUse?: () => Promise<void>,
  ): Promise<void> {
    if (driver?.validateCredentials === undefined) {
      return undefined;
    }
    if (this.transactions.hasContext()) {
      throw new ResourceConflictError(
        "Channel validation must run outside a controller transaction.",
      );
    }
    const bindings = storedSecretBindings(configuration.secretBindings);
    await driver.validateCredentials(configuration.values, async (binding, path, validate) => {
      const source = bindings[binding]?.source;
      if (source === undefined) {
        throw new ChannelCredentialError("binding_required", path);
      }
      if (source.namespaceId !== namespaceId) {
        throw new ScopeViolationError("Secret references cannot cross Namespaces.");
      }
      await this.authorize(principalId, "operate", source);
      const secret = await this.read(async (state) => {
        await this.exactNamespace(state, namespaceId);
        return state.secrets.findSecret(namespaceId, source.id);
      });
      if (secret === undefined) {
        throw new ScopeViolationError("The Secret does not belong to the exact Namespace.");
      }
      const storage = this.secretOperations.ownedSecretDriver(secret.driverId, driverFailure);
      if (storage.withValue === undefined) {
        throw new ChannelCredentialError("unavailable", path);
      }
      await authorizeUse?.();
      await this.authorize(principalId, "operate", source);
      const outcome = await secretOperation(() =>
        storage.withValue!(secret, async (value) => {
          // Reauthorize after backend I/O and before sending a credential to its provider.
          try {
            await authorizeUse?.();
            await this.authorize(principalId, "operate", source);
            const current = await this.read(async (state) => {
              await this.exactNamespace(state, namespaceId);
              return state.secrets.findSecret(namespaceId, source.id);
            });
            if (
              current === undefined ||
              !sameSecretBackend(secret, current) ||
              this.secretOperations.ownedSecretDriver(current.driverId, driverFailure) !== storage
            ) {
              throw new ChannelCredentialError("unavailable", path);
            }
            await validate(value);
            return undefined;
          } catch (error) {
            return {
              error:
                error instanceof ChannelCredentialError || error instanceof AuthorizationDeniedError
                  ? error
                  : new ChannelCredentialError("unavailable", path),
            };
          }
        }),
      );
      if (outcome?.error !== undefined) {
        throw outcome.error;
      }
    });
  }

  private assertPreparedDeploymentDrivers(prepared: PreparedDeploymentChannels): void {
    const configuration = this.drivers.selection("configuration");
    const channel = this.drivers.selection("channel");
    if (
      configuration?.driver !== prepared.configurationDriver ||
      !unchangedDriver(configuration) ||
      channel?.driver !== prepared.channel ||
      (channel !== undefined && !unchangedDriver(channel)) ||
      prepared.channel?.validateCredentials !== prepared.channelValidator
    ) {
      throw new ResourceStateConflictError(
        "The selected Drivers changed after guarded validation.",
      );
    }
  }

  private async validateDeploymentChannels(
    principalId: string,
    input: DeployAgentInput,
  ): Promise<PreparedDeploymentChannels | undefined> {
    if (this.drivers.selection("channel") === undefined) {
      return undefined;
    }
    await this.authorize(principalId, "deploy", {
      kind: "agent",
      id: input.agentId,
      namespaceId: input.namespaceId,
    });
    const metadata = await this.read(async (state) => {
      const agent = await state.agents.findAgent(input.namespaceId, input.agentId);
      if (agent === undefined) {
        throw new ScopeViolationError("The Agent does not belong to the exact Namespace.");
      }
      await this.authorize(principalId, "read", {
        kind: "configuration",
        id: agent.configurationId,
        namespaceId: input.namespaceId,
      });
      return state.configurations.findConfiguration(input.namespaceId, agent.configurationId);
    });
    return this.prepareDeploymentChannels(principalId, input, metadata);
  }

  private async prepareDeploymentChannels(
    principalId: string,
    input: DeployAgentInput,
    metadata:
      | Readonly<
          Pick<
            Configuration,
            "id" | "namespaceId" | "kind" | "generation" | "createdAt" | "secretBindings"
          >
        >
      | undefined,
  ): Promise<PreparedDeploymentChannels> {
    if (metadata?.kind !== "agent") {
      throw new ScopeViolationError("The Agent Configuration is unavailable.");
    }
    const namespaceId = input.namespaceId;
    const agentId = input.agentId;
    const configurationId = metadata.id;
    const configurationDriver = this.configurationOperations.selectedDriver();
    const configuration = exactConfiguration(
      await driverOperation(() => configurationDriver.read(metadata)),
      metadata,
    );
    // Before the Channel Driver, which reads only an env SecretRef and answers any other channel
    // credential form with its generic binding refusal: the bundled Kubernetes channel rule, then
    // the Configuration Driver's rules, in save's order (finding 2520). Deployment applies them
    // again below. A stored Configuration that predates a rule gets the message its next save
    // would, as provisioning does (findings 2506, 2516).
    this.requireBundledChannelBindings(configuration.values, configuration.secretBindings ?? {});
    await configurationDriver.validate(configuration);
    const channel = this.drivers.hasSelection("channel")
      ? this.selectedDriver("channel")
      : undefined;
    const channelValidator = channel?.validateCredentials;
    await this.validateChannelCredentials(
      principalId,
      namespaceId,
      configuration,
      () => new SecretBindingDriverError(),
      channel,
      async () => {
        await this.authorize(principalId, "deploy", {
          kind: "agent",
          id: agentId,
          namespaceId,
        });
        await this.authorize(principalId, "read", {
          kind: "configuration",
          id: configurationId,
          namespaceId,
        });
      },
    );
    return { configuration, configurationDriver, channel, channelValidator };
  }

  async deployAgentWithAuthorization(
    principalId: string,
    input: DeployAgentInput,
    resolveHarness: HarnessResolver,
    auditEvent?: (result: Readonly<AuthorizedAgentDeployment>) => AuditEvent,
  ): Promise<Readonly<AuthorizedAgentDeployment>> {
    const captured = immutableCopy({
      ...input,
      harnessOverrides: this.normalizedHarnessOverrides(input.harnessOverrides),
    });
    return this.admitAgentDeployment(principalId, captured, resolveHarness, auditEvent);
  }

  private async admitAgentDeployment(
    principalId: string,
    input: DeployAgentInput & { harnessOverrides: Readonly<Record<string, unknown>> },
    resolveHarness: HarnessResolver,
    auditEvent?: (result: Readonly<AuthorizedAgentDeployment>) => AuditEvent,
  ): Promise<Readonly<AuthorizedAgentDeployment>>;
  private async admitAgentDeployment(
    principalId: string,
    input: DeployAgentInput & { harnessOverrides: Readonly<Record<string, unknown>> },
    resolveHarness: HarnessResolver,
    auditEvent: ((result: Readonly<AuthorizedAgentDeployment>) => AuditEvent) | undefined,
    first: FirstDeploymentGuard,
  ): Promise<Readonly<AuthorizedAgentDeployment> | Readonly<FirstDeploymentReceipt>>;
  private async admitAgentDeployment(
    principalId: string,
    input: DeployAgentInput & { harnessOverrides: Readonly<Record<string, unknown>> },
    resolveHarness: HarnessResolver,
    auditEvent?: (result: Readonly<AuthorizedAgentDeployment>) => AuditEvent,
    first?: FirstDeploymentGuard,
  ): Promise<Readonly<AuthorizedAgentDeployment> | Readonly<FirstDeploymentReceipt>> {
    if (!isNonEmptyString(input.agentId)) {
      throw new ScopeViolationError("The exact Agent identity is missing.");
    }
    const ordinaryPreparation =
      first === undefined ? await this.validateDeploymentChannels(principalId, input) : undefined;
    this.namespaceIdentity(input.namespaceId);
    return this.mutate(async (state) => {
      await this.holdAuthority(state);
      const target: ResourceRef = {
        kind: "agent",
        id: input.agentId,
        namespaceId: input.namespaceId,
      };
      await this.authorize(principalId, "deploy", target);
      const namespace = await this.lockNamespace(state, input.namespaceId);
      // AccessBinding deletes hold this lock: authorize again so a revocation that committed
      // while this deploy waited stops it before it writes Agent grants.
      let authorization = await this.authorize(principalId, "deploy", target);
      const agent = await state.agents.findAgent(namespace.id, input.agentId);
      if (!agent) {
        throw new ScopeViolationError(
          "The Agent does not belong to the exact Installation and Namespace.",
        );
      }
      if (first === undefined) {
        await this.guardAgentProvisioning(state, namespace.id, agent.id, true);
      }
      const lockedAgent = await state.agents.lockAgent(namespace.id, agent.id);
      if (!lockedAgent) {
        throw new ScopeViolationError("The Agent does not belong to the exact Namespace.");
      }
      let prepared = ordinaryPreparation;
      if (prepared !== undefined) {
        this.assertPreparedDeploymentDrivers(prepared);
        if (lockedAgent.configurationId !== prepared.configuration.id) {
          throw new ResourceStateConflictError(
            "The Agent Configuration changed after credential validation. Review the current binding before deploying.",
          );
        }
      }
      if (first !== undefined) {
        authorization = await this.authorizeFirstDeploymentReceipt(
          principalId,
          input,
          first.intent,
        );
        const receipt = await state.revisions.findFirstDeploymentReceipt(
          namespace.id,
          lockedAgent.id,
          first.digest,
        );
        if (receipt !== undefined) {
          return receipt;
        }
        if (lockedAgent.status !== "active") {
          throw new AgentDeletingError();
        }
        if ("error" in first.preparation) {
          throw first.preparation.error;
        }
        prepared = first.preparation.prepared;
        this.assertPreparedDeploymentDrivers(prepared);
        if (lockedAgent.configurationId !== first.intent.expectedConfigurationId) {
          throw new ResourceStateConflictError(
            "The Agent uses a different Configuration. Recover the original first-deployment receipt after an uncertain result, then review the current binding before deploying.",
          );
        }
        if (
          (await state.revisions.listRevisionMetadata(namespace.id, lockedAgent.id)).length !== 0
        ) {
          throw new ResourceStateConflictError(
            "The Agent already has revision history. Recover the original first-deployment receipt after an uncertain result; use ordinary deploy only for an intentional later revision.",
          );
        }
        if (lockedAgent.desiredRuntimeState !== "stopped") {
          throw new ResourceStateConflictError(
            "The Agent is not stopped. Recover the original first-deployment receipt after an uncertain result and inspect deployment status before proceeding.",
          );
        }
        if (
          prepared.configuration.id !== first.intent.expectedConfigurationId ||
          prepared.configuration.generation !== first.intent.expectedGeneration
        ) {
          throw new ResourceStateConflictError(
            "The expected Configuration generation is unavailable. Recover the original first-deployment receipt after an uncertain result, then review the current Configuration before deploying.",
          );
        }
      }
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      if (typeof resolveHarness !== "function") {
        throw new DependencyUnavailableError("The selected Harness descriptor is unavailable.");
      }

      let compute: ComputeDriver;
      try {
        compute = this.selectedDriver("compute");
      } catch {
        throw new DependencyUnavailableError("The selected compute Driver is unavailable.");
      }
      const sandbox = this.sandboxPolicyOperations.sandboxDriver();

      if (!isNonEmptyString(lockedAgent.servicePrincipalId)) {
        throw new ScopeViolationError(
          "The Agent or its service principal does not belong to the exact Namespace.",
        );
      }
      if (lockedAgent.status !== "active") {
        throw new AgentDeletingError();
      }
      const backendId = this.backendId(lockedAgent.backendId);
      if (!validExecutionMode(lockedAgent.executionMode)) {
        throw new ScopeViolationError("The persisted Agent Harness execution mode is invalid.");
      }
      requireSandboxExecutionMode(sandbox, lockedAgent.executionMode);
      this.harnessAuthOperations.assertCredentialGatewayDelivery(lockedAgent.harnessAuth);
      await this.authorize(principalId, "read", {
        kind: "configuration",
        id: lockedAgent.configurationId,
        namespaceId: namespace.id,
      });
      const metadata = await state.configurations.lockConfiguration(
        namespace.id,
        lockedAgent.configurationId,
      );
      if (!metadata || metadata.kind !== "agent") {
        throw new ScopeViolationError(
          "The Agent Configuration must belong to the exact Namespace and configure an Agent.",
        );
      }
      if (prepared !== undefined && metadata.generation !== prepared.configuration.generation) {
        throw new ResourceStateConflictError(
          first === undefined
            ? "The Configuration changed after credential validation. Review the current Configuration before deploying."
            : "The expected Configuration generation is unavailable. Recover the original first-deployment receipt after an uncertain result, then review the current Configuration before deploying.",
        );
      }
      const configurationDriver = this.configurationOperations.selectedDriver();
      const configuration = exactConfiguration(
        await driverOperation(() =>
          configurationDriver.read({ id: metadata.id, namespaceId: namespace.id }),
        ),
        metadata,
      );
      if (prepared !== undefined && !isDeepStrictEqual(configuration, prepared.configuration)) {
        throw new ResourceStateConflictError(
          first === undefined
            ? "The Configuration changed after credential validation. Review the current Configuration before deploying."
            : "The Configuration changed after credential validation. Recover the original first-deployment receipt after an uncertain result, then review the current Configuration before deploying.",
        );
      }
      if (first !== undefined) {
        await this.guardAgentProvisioning(state, namespace.id, agent.id, true);
      }
      const configuredHarnessId = resolveConfiguredHarnessId(
        configuration.values,
        this.modelPolicyAgent(lockedAgent.executionMode, resolveHarness),
      );
      const approvedHarness = resolveAgentHarness(
        resolveHarness,
        configuredHarnessId,
        lockedAgent.executionMode,
      );
      if (
        approvedHarness === undefined ||
        !isNonEmptyString(approvedHarness.id) ||
        !isNonEmptyString(approvedHarness.version)
      ) {
        throw new DependencyUnavailableError("The selected Harness runtime is not approved.");
      }
      if (approvedHarness.id !== configuredHarnessId) {
        throw new ScopeViolationError("The approved Harness does not match the native runtime.");
      }
      const requestedHarness = Object.freeze({
        ...approvedHarness,
        mode: lockedAgent.executionMode,
        overrides: input.harnessOverrides,
      });
      // Capability refusals precede Agent principal grants: a grant cannot make an unsupported
      // topology deployable, so the refusal the operator can act on must surface first. A
      // missing Sandbox Driver is a permanent 409 here; provisioning handoff reaches this only
      // after fenceAgentProvisioning applied the stored-work check, which stays a retryable 503.
      requireDedicatedNativeSupport(requestedHarness, sandbox, this.nativeWorkers, {
        configuration: configuration.values,
      });
      await this.grantDeployedAgentSources(
        state,
        principalId,
        lockedAgent,
        storedSecretBindings(metadata.secretBindings),
      );
      const [harnessAuth, credentialSourceType] = await this.harnessAuthOperations.admitHarnessAuth(
        state,
        principalId,
        lockedAgent,
      );
      const revisionHarness = immutableCopy({
        ...requestedHarness,
        configuration:
          compute.resolveHarnessConfiguration?.(
            requestedHarness,
            harnessAuth,
            configuration.values,
          ) ?? {},
      });
      this.harnessAuthOperations.requireCredentialSourceDrivers(harnessAuth, sandbox);
      const driver =
        lockedAgent.plugins && Object.keys(lockedAgent.plugins).length
          ? this.pluginDriver(revisionHarness.id, true)
          : undefined;
      const pluginState =
        driver && lockedAgent.plugins
          ? immutableCopy({
              driver: pluginOwner(driver, lockedAgent),
              plugins: lockedAgent.plugins,
            } satisfies PluginRevisionState)
          : undefined;
      const credentialSources = await this.admitCredentialSources(
        state,
        principalId,
        lockedAgent,
        sandbox,
        driver,
        revisionHarness,
        compute,
      );
      const secretBindings = storedSecretBindings(metadata.secretBindings);
      const sources = await this.configurationOperations.authorizeBindings(
        state,
        principalId,
        namespace.id,
        secretBindings,
      );
      const secretDriver =
        Object.keys(secretBindings).length === 0 ? undefined : this.secretOperations.secretDriver();
      for (const secret of sources) {
        await this.authorizeAgentPrincipal(principalId, lockedAgent, "operate", {
          kind: "secret",
          id: secret.id,
          namespaceId: namespace.id,
        });
        const resolved = await secretOperation(() => secretDriver!.resolve(secret));
        if (
          Object.keys(secret.backendRef).some(
            (key) =>
              resolved[key as keyof typeof resolved] !==
              secret.backendRef[key as keyof typeof secret.backendRef],
          )
        ) {
          throw new DependencyUnavailableError("The Secret backend identity changed.");
        }
      }
      const admittedConfiguration = this.agentRuntimeConfiguration(
        configuration.values,
        revisionHarness,
        compute,
        sandbox,
      );
      // The model provider settings, then the Compute rules, as on Configuration save, so a
      // stored Configuration that predates a rule gets the message its next save would. A
      // baseUrl or api the runtime cannot use would otherwise fail later, as an unexplained
      // model probe failure (finding 1549). Native workspace setup refuses an invalid bootstrap
      // setting only after the deployment starts (finding 2699); the Gateway refuses a setting
      // the pinned OpenClaw retired and does not start (finding 2709), and fails every turn in
      // OpenClaw's sandbox (finding 2767). The upgrade preflight runs the same values-only rules.
      refuseUndeployableConfigurationValues(configuration.values);
      this.validateComputeConfiguration(configuration.values);
      await configurationDriver.validate({ ...configuration, values: admittedConfiguration });
      if (resolveConfiguredHarnessId(admittedConfiguration) !== configuredHarnessId) {
        throw new ScopeViolationError(
          "A Sandbox Driver cannot change the selected Harness runtime.",
        );
      }
      validateAgentHarnessAuth(
        compute,
        revisionHarness,
        harnessAuth,
        admittedConfiguration,
        configuration.secretBindings,
        credentialSourceType,
      );
      // Every preparation attempt would refuse such a gateway setting and the deployment would
      // fail as an unavailable dependency, so refuse it here with the 409 provisioning answers.
      // Any other refusal stays with preparation, which checks the same document again.
      try {
        compute.validateGatewaySettings?.(admittedConfiguration);
      } catch (error) {
        if (
          error instanceof ComputeGatewaySettingError ||
          error instanceof DependencyUnavailableError
        ) {
          throw error;
        }
      }
      // Agent save checks pending initial workspace files against its Configuration; an Agent
      // stored before that check, or whose Configuration changed since, is refused here with the
      // same message instead of failing in preparation. A completed setup is checked too: every
      // deployment delivers it as the workspace's restart guard, and preparation applies the
      // same rule, where a refusal was retried until the deployment failed (finding 2286).
      const workspaceSetup = await state.workspaceSetups.find(namespace.id, lockedAgent.id);
      if (workspaceSetup !== undefined) {
        validateWorkspaceSetupTopology(
          compute,
          revisionHarness,
          admittedConfiguration,
          sandbox?.id,
        );
      }
      // Configuration saves can change the native settings independently of their Agents.
      if (driver && pluginState) {
        if (!this.enabledPluginDrivers().includes(driver)) {
          throw new ResourceStateConflictError("The plugin catalog changed. Refresh and retry.");
        }
        validatePluginSettings(
          driver,
          pluginState.plugins,
          lockedAgent.pluginApprovers,
          admittedConfiguration,
          "stored",
        );
        this.agentPlugins.validatePluginPlacement(driver, pluginState.plugins, revisionHarness);
      }
      // Decode every earlier revision: one that is unreadable refuses the deploy here (503,
      // nothing created), because the worker must decode them all to stop or retire them.
      const previous = await state.revisions.listRevisions(namespace.id, lockedAgent.id);
      const createdAt = this.timestamp();
      const resolvedRepositoryCredentials = this.repositoryPolicy.admitRepositoryCredentials(
        lockedAgent,
        compute,
        { ...approvedHarness, mode: lockedAgent.executionMode },
        sandbox?.id,
        Date.parse(createdAt),
      );
      if (resolvedRepositoryCredentials !== undefined) {
        this.validateRepositoryBrokerNetworkProxy(revisionHarness, admittedConfiguration, sandbox);
      }
      const repositoryCredentials = await this.repositoryPolicy.applyRepositoryStandingApproval(
        state,
        namespace.id,
        lockedAgent.id,
        resolvedRepositoryCredentials,
      );
      // PostgreSQL restamps createdAt on its own clock; the response carries the stored value.
      // The repository credential deadline above stays on this controller's clock.
      const revisionId = this.nextIdentifier("agent_revision");
      const proxyAdmission = await this.admitProxyPlan(
        state,
        lockedAgent,
        revisionId,
        admittedConfiguration,
        sandbox?.id,
        repositoryCredentials,
        harnessAuth,
        revisionHarness.configuration,
      );
      const egressPlan = proxyAdmission?.plan;
      let executionAdmission: ExecutionAdmission;
      if (egressPlan === undefined) {
        executionAdmission = { version: 2, mode: "unprotected" };
      } else {
        let version: 3 | 4 | 5 | 6 | 7 = 3;
        if (egressPlan.repositoryGit) {
          version = 4;
        }
        if (egressPlan.repositoryGitAuthorization === "online-request") {
          version = 5;
        }
        if (egressPlan.repositoryGitAuthorization === "request-hook-observed") {
          version = 6;
        }
        if (egressPlan.repositoryGit && egressPlan.policyReductionVersion === 2) {
          version = 7;
        }
        executionAdmission = { version, mode: "protected" };
      }
      const execution = { executionAdmission, ...(egressPlan === undefined ? {} : { egressPlan }) };
      assertExecutionAdmission(execution);
      try {
        if (compute.validateExecutionAdmission === undefined) {
          assertExecutionReleaseAllowed(execution);
        } else {
          const admission = { ...execution, harnessAuth, credentialSources, repositoryCredentials };
          compute.validateExecutionAdmission(admission, egressPlan && this.selectedProxyOwner());
        }
      } catch {
        throw new DependencyUnavailableError(
          "The selected Compute cannot admit this execution mode; protected release and old-reader fencing are unavailable.",
        );
      }
      const policy = await state.sandboxPolicies.find(namespace.id, lockedAgent.id);
      const policyScope = { repositoryCredentials: repositoryCredentials !== undefined };
      // Finding 2053: protected execution refuses Agent additions, never drops them. Only an
      // explicitly acknowledged artifact snapshot can accompany dedicated Codex repository
      // execution. The caller learns of saved additions only with SandboxPolicy read access.
      // Finding 2151: every refusal below that names saved additions (protected execution, the
      // ceiling, the Driver) comes after SandboxPolicy read, so a deployer without it learns nothing.
      const protectedExecution = execution.executionAdmission.mode === "protected";
      if (policy !== undefined && policy.additions.length > 0) {
        await this.authorize(principalId, "read", {
          kind: "sandbox_policy",
          id: policy.id,
          namespaceId: namespace.id,
        });
        if (protectedExecution) {
          throw new ProtectedExecutionNetworkPolicyError("deploy");
        }
      }
      let sandboxPolicy: SandboxPolicySnapshot | undefined;
      if (protectedExecution) {
        if (
          revisionHarness.id === "codex" &&
          revisionHarness.mode === "dedicated" &&
          repositoryCredentials !== undefined
        ) {
          sandboxPolicy = checkedProtectedCodexArtifactPolicy(sandbox, policy?.version ?? 1);
        }
      } else if ((policy?.additions.length ?? 0) > 0) {
        sandboxPolicy = this.sandboxPolicyOperations.admitAgentNetworkPolicy(
          policy!.additions,
          policy!.version,
          undefined,
          policyScope,
        );
      } else if (sandbox?.admitNetworkPolicy !== undefined) {
        sandboxPolicy = checkedSandboxPolicySnapshot(
          sandbox,
          [],
          policy?.version ?? 1,
          undefined,
          policyScope,
        );
      }
      if ((policy?.additions.length ?? 0) > 0 && sandboxPolicy === undefined) {
        throw new ResourceStateConflictError(
          "The selected Sandbox Driver cannot enforce this Agent's network policy.",
        );
      }
      if (compute.requiresAgentRuntimeCredentials === true) {
        if (
          compute.getAgentRuntimeCredentialStatus === undefined ||
          compute.provisionAgentRuntimeCredentials === undefined
        ) {
          throw new DependencyUnavailableError(
            "The selected Compute Driver cannot manage required Agent runtime credentials.",
          );
        }
        const binding = { namespace, agent: lockedAgent };
        const status = runtimeCredentialStatus(
          await runtimeCredentialOperation(() => compute.getAgentRuntimeCredentialStatus!(binding)),
        );
        if (!status.transportConfigured) {
          if (previous.length > 0) {
            throw new ResourceStateConflictError(
              "Agent runtime credentials are missing after a historical revision. Ask an operator to restore them before deploying.",
            );
          }
          for (const action of ["read", "operate"] as const) {
            await this.authorize(principalId, action, {
              kind: "agent",
              id: lockedAgent.id,
              namespaceId: namespace.id,
            });
          }
          // The Driver creates only missing owned Secrets; a failed admission can reuse them.
          proxyAdmission?.assertProvidersCurrent();
          const provisioned = runtimeCredentialStatus(
            await runtimeCredentialOperation(() =>
              compute.provisionAgentRuntimeCredentials!(binding, {}),
            ),
          );
          if (!provisioned.transportConfigured) {
            throw new DependencyUnavailableError(
              "The selected Compute Driver did not confirm Agent runtime credentials.",
            );
          }
        }
      }
      const revisionDraft: AgentRevision = {
        id: revisionId,
        ...execution,
        namespaceId: namespace.id,
        agentId: lockedAgent.id,
        revision: previous.length + 1,
        backendId,
        configurationId: configuration.id,
        configurationKind: configuration.kind,
        configurationGeneration: configuration.generation,
        // Admission checked the Configuration as written; a refusal names only its own settings.
        // The name then becomes the served Agent's OpenClaw display name.
        configuration: freezeConfigurationValues(
          withAgentIdentityName(admittedConfiguration, lockedAgent.name),
        ),
        gatewayManagedMode: lockedAgent.gatewayManagedMode,
        harness: revisionHarness,
        compute: { id: compute.id, implementation: compute.implementation },
        ...(sandbox === undefined ? {} : { sandboxDriverId: sandbox.id }),
        ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
        ...(secretDriver === undefined ? {} : { secretDriverId: secretDriver.id, secretBindings }),
        ...(pluginState === undefined ? {} : { plugins: pluginState }),
        ...(lockedAgent.pluginApprovers === undefined
          ? {}
          : { pluginApprovers: lockedAgent.pluginApprovers }),
        ...(repositoryCredentials === undefined ? {} : { repositoryCredentials }),
        harnessAuth,
        ...(credentialSources.length === 0 ? {} : { credentialSources }),
        servicePrincipalId: lockedAgent.servicePrincipalId,
        createdAt,
      };
      if (
        revisionDraft.gatewayManagedMode === true &&
        compute.supportsGatewayManagedMode !== true
      ) {
        throw new ConfigurationHarnessError(GATEWAY_MANAGED_MODE_UNSUPPORTED);
      }
      const computeAdmission = compute.admitRevision?.(freezeAgentRevision(revisionDraft));
      const admittedDraft = freezeAgentRevision({
        ...revisionDraft,
        compute: {
          ...revisionDraft.compute,
          ...(computeAdmission === undefined ? {} : { admission: computeAdmission }),
        },
      });
      const runtimeInputs = compute.snapshotRuntimeInputs?.(admittedDraft);
      const candidate = freezeAgentRevision({
        ...admittedDraft,
        compute: {
          ...admittedDraft.compute,
          ...(runtimeInputs === undefined ? {} : { runtimeInputs }),
        },
      });
      // Database locks do not freeze process-local selections across awaited Driver calls.
      if (prepared !== undefined) {
        this.assertPreparedDeploymentDrivers(prepared);
      }
      proxyAdmission?.assertProvidersCurrent();
      const revision = await state.revisions.createRevision(candidate, first?.digest);
      if (
        lockedAgent.activeRevisionId &&
        (lockedAgent.desiredRuntimeState === "stopped" ||
          compute.requiresStoppedPredecessors?.(revision) === true)
      ) {
        const replacement = await state.agents.findPredecessorReplacement(
          namespace.id,
          lockedAgent.id,
        );
        const predecessor = previous.find(({ id }) => id === lockedAgent.activeRevisionId);
        // Legacy replacement attempts may already have stopped the active pointer.
        // Only the first replacement, or a recorded boundary, proves it may still serve.
        const knownBoundary = replacement?.predecessorRevisionId === lockedAgent.activeRevisionId;
        const firstReplacement =
          predecessor !== undefined &&
          !previous.some(({ revision: number }) => number > predecessor.revision);
        if (lockedAgent.desiredRuntimeState === "stopped" || knownBoundary || firstReplacement) {
          await state.agents.recordPredecessorReplacement(namespace.id, lockedAgent.id, {
            predecessorRevisionId: lockedAgent.activeRevisionId,
            candidateRevisionId: revision.id,
            phase: lockedAgent.desiredRuntimeState === "stopped" ? "stopping" : "pre-stop",
          });
        }
      }
      const running = await state.agents.transitionAgentDesiredRuntimeState(
        namespace.id,
        lockedAgent.id,
        lockedAgent.desiredRuntimeState,
        "running",
      );
      if (running === undefined) {
        throw new ResourceStateConflictError("The Agent lifecycle changed during deployment.");
      }
      await this.record(state, {
        kind: "agent_revision",
        action: "reconcile",
        namespaceId: namespace.id,
        resourceId: revision.id,
        actorId: principalId,
      });
      const result = Object.freeze({ revision, authorization });
      if (auditEvent) {
        await state.audit.append(auditEvent(result));
      }
      return result;
    });
  }

  private readonly agentCredentialWithdrawal = createAgentCredentialWithdrawal({
    namespaceIdentity: (namespaceId) => this.namespaceIdentity(namespaceId),
    now: () => this.clock(),
    timestamp: () => this.timestamp(),
    record: (state, operation) => this.record(state, operation),
    transactions: {
      read: (work) => this.read(work),
      transact: (work) => this.mutate(work),
    },
    authority: {
      authorize: (principalId, action, target) => this.authorize(principalId, action, target),
    },
    lockNamespace: (state, namespaceId) => this.lockNamespace(state, namespaceId),
    exactNamespace: (state, namespaceId) => this.exactNamespace(state, namespaceId),
  });

  async withdrawAgentCredentialSource(
    principalId: string,
    input: AgentCredentialSourceInput,
  ): Promise<Readonly<CredentialWithdrawalStatus>> {
    return this.agentCredentialWithdrawal.withdrawAgentCredentialSource(principalId, input);
  }

  async readAgentCredentialWithdrawal(
    principalId: string,
    input: AgentCredentialSourceInput,
  ): Promise<Readonly<CredentialWithdrawalStatus>> {
    return this.agentCredentialWithdrawal.readAgentCredentialWithdrawal(principalId, input);
  }

  private readonly agentTermination = createAgentTermination({
    installationId: () => this.installation.id,
    requestAuditId: () => this.requestAuditId.getStore(),
    timestamp: () => this.timestamp(),
    record: (state, operation) => this.record(state, operation),
    transactions: { transact: (work) => this.mutate(work) },
    authority: {
      authorize: (principalId, action, target) => this.authorize(principalId, action, target),
      authorizationDecision: (principalId, action, target) =>
        this.authorizationDecision(principalId, action, target),
      holdAuthority: (state) => this.holdAuthority(state),
    },
    lockNamespace: (state, namespaceId) => this.lockNamespace(state, namespaceId),
    now: () => this.clock(),
  });

  async stopAgent(
    principalId: string,
    namespaceId: string,
    agentId: string,
    expectedActiveRevisionId?: string,
  ): Promise<Readonly<Agent>> {
    return this.agentTermination.stopAgent(
      principalId,
      namespaceId,
      agentId,
      expectedActiveRevisionId,
    );
  }

  /**
   * Begin or retry logical deletion of one exact, authorized, empty Namespace.
   * Driver effects remain deferred to handleNamespaceLifecycle().
   */
  async deleteNamespace(principalId: string, namespaceId: string): Promise<Readonly<Namespace>> {
    return this.namespaces.deleteNamespace(principalId, namespaceId);
  }

  async deleteAgent(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<Readonly<Agent>> {
    return this.agentTermination.deleteAgent(principalId, namespaceId, agentId);
  }

  /** Observe resources only; the caller owns authorization, claims, and status commits. */
  async observeNamespaceLifecycle(
    namespace: Readonly<Namespace>,
    target: "ready" | "deleted",
    signal: AbortSignal,
    record: (evidence: NamespaceLifecycleEvidence) => void | Promise<void>,
  ): Promise<NamespaceEnsureResult | NamespaceDeleteResult> {
    const { compute, participants } = this.drivers.namespaceLifecycle(() =>
      this.selectedDriver("compute"),
    );
    return reconcileNamespaceLifecycle(compute, participants, namespace, target, signal, record);
  }

  /**
   * Execute one deterministic Namespace lifecycle attempt for a claimed work item.
   * This is a reusable conformance harness, not a polling production worker.
   */
  async handleNamespaceLifecycle(
    actorId: string,
    namespaceId: string,
    target: "ready" | "deleted",
  ): Promise<Readonly<Namespace> | undefined> {
    return this.namespaces.handleNamespaceLifecycle(actorId, namespaceId, target);
  }

  /** Stage resources, reconciliation intents, and audit evidence as one unit. */
  async transact<T>(work: (state: PlatformUnitOfWork) => Promise<T>): Promise<T> {
    return this.transactions.transact(work);
  }

  /** Compensate a Driver side effect if the owning resource transaction fails. */
  registerRollback(rollback: () => Promise<void>): void {
    this.transactions.registerRollback(rollback);
  }

  pendingOperations(): readonly Readonly<ReconciliationOperation>[] {
    if (this.state instanceof InMemoryPlatformState) {
      return this.state.pendingOperations();
    }
    return Object.freeze([]);
  }

  private authorize(
    principalId: string,
    action: AuthorizationRequest["action"],
    target: AuthorizationTarget,
    selected?: IAMDriver,
    authorize?: IAMDriver["authorize"],
  ): Promise<Readonly<DeployAgentAuthorization>> {
    return this.authority.authorize(principalId, action, target, selected, authorize);
  }

  private authorizeAgentPrincipal(
    callerId: string,
    agent: Pick<Agent, "id" | "namespaceId" | "servicePrincipalId">,
    action: AuthorizationRequest["action"],
    resource: ResourceRef,
  ): Promise<void> {
    return this.authority.authorizeAgentPrincipal(callerId, agent, action, resource);
  }

  private canRead(principalId: string, target: AuthorizationTarget): Promise<boolean> {
    return this.authority.canRead(principalId, target);
  }

  private authorizationAuthority(principalId: string): IAMDriver {
    return this.authority.authorizationAuthority(principalId);
  }

  private authorizationDecision(
    principalId: string,
    action: AuthorizationRequest["action"],
    target: AuthorizationTarget,
    selected?: IAMDriver,
    authorize?: IAMDriver["authorize"],
  ): Promise<Readonly<DeployAgentAuthorization>> {
    return this.authority.authorizationDecision(principalId, action, target, selected, authorize);
  }

  private exactNamespace(
    state: PlatformReadView,
    namespaceId: string,
  ): Promise<Readonly<Namespace>> {
    return exactNamespace(state, namespaceId);
  }

  private exactAgent(
    state: PlatformReadView,
    namespaceId: string,
    agentId: string,
  ): Promise<{ namespace: Readonly<Namespace>; agent: Readonly<Agent> }> {
    return exactAgent(state, namespaceId, agentId);
  }

  private lockNamespace(
    state: PlatformUnitOfWork,
    namespaceId: string,
  ): Promise<Readonly<Namespace>> {
    return lockNamespace(state, namespaceId);
  }

  /** Namespace lock serializes binding, source deletion, and admission. */
  private agentCredentialSources(
    value: unknown,
  ): readonly AgentCredentialSourceBinding[] | undefined {
    return parseAgentCredentialSources(value);
  }

  private assertHarnessSourceListed(
    bindings: readonly AgentCredentialSourceBinding[],
    harnessAuth: HarnessAuthBinding | null | undefined,
  ): void {
    assertHarnessSourceListed(bindings, harnessAuth);
  }

  /**
   * An Installation property, so it is reported before any source lookup: whether a source
   * exists never changes the answer. Callers run it after the caller's `operate` check on the
   * exact source, so a caller without that grant still gets 403 first.
   */
  private assertCredentialGatewaySelected(): void {
    if (!this.drivers.hasSelection("credential_gateway")) {
      throw new CredentialGatewayNotConfiguredError();
    }
  }

  /**
   * The caller's grant on the Harness source an Agent already binds: Secret or credential
   * source `operate`, ServiceAccount `read`. Like `authorizeBoundCredentialSources`, it reads no
   * record, so it answers the same whether or not the source still exists or belongs to the
   * selected driver. A credential source is normally also listed; it is checked here in case a
   * stored row predates that rule.
   */
  /**
   * `operate` on each source an Agent already binds, so an update cannot swap out or drop a
   * source the caller may not use. It reads no record, so it answers the same whether or not the
   * source still exists, is ready, or belongs to the selected gateway.
   */
  private async authorizeBoundCredentialSources(
    principalId: string,
    namespaceId: string,
    bindings: readonly AgentCredentialSourceBinding[],
  ): Promise<void> {
    return this.agentCredentialAccess.authorizeBoundCredentialSources(
      principalId,
      namespaceId,
      bindings,
    );
  }

  private authorizeAgentCredentialSources(
    state: PlatformUnitOfWork,
    principalId: string,
    namespaceId: string,
    bindings: readonly AgentCredentialSourceBinding[],
    harnessAuth: HarnessAuthBinding | null | undefined,
  ): Promise<readonly CredentialSource[]> {
    return this.agentCredentialAccess.authorizeAgentCredentialSources(
      state,
      principalId,
      namespaceId,
      bindings,
      harnessAuth,
    );
  }

  private admitCredentialSources(
    state: PlatformUnitOfWork,
    principalId: string,
    agent: Readonly<Agent>,
    sandbox: SandboxDriver | undefined,
    driver: PluginDriver | undefined,
    harness: RevisionHarnessDescriptor,
    compute: ComputeDriver,
  ): Promise<readonly CredentialSourceSnapshot[]> {
    return this.agentCredentialAccess.admitCredentialSources(
      state,
      principalId,
      agent,
      sandbox,
      driver,
      harness,
      compute,
    );
  }

  private async guardAgentProvisioning(
    state: PlatformUnitOfWork,
    namespaceId: string,
    agentId: string,
    handoff = false,
  ): Promise<void> {
    return this.provisioningWorker.guardAgentProvisioning(state, namespaceId, agentId, handoff);
  }

  private async guardProvisioningConfiguration(
    state: PlatformReadView,
    namespaceId: string,
    configurationId: string,
    readOnly = false,
  ): Promise<void> {
    return this.provisioningWorker.guardProvisioningConfiguration(
      state,
      namespaceId,
      configurationId,
      readOnly,
    );
  }

  private provisioningPlan(record: Readonly<AgentProvisioningRecord>): {
    readonly configuration: AgentProvisioningConfigurationInput;
    readonly harnessAuth: HarnessAuthBinding | null;
    readonly executionMode: HarnessExecutionMode;
    readonly gatewayManagedMode: boolean;
  } {
    return parseProvisioningPlan(record);
  }

  /**
   * A new Agent's managed mode defaults to whether the selected Compute Driver enforces it, so
   * an Agent on SSH Compute (or a Driver that does not declare support) is saved deployable
   * instead of failing at its first deploy (finding 2676). The default needs no Installation
   * administer: there is no enforcement to opt out of. Without a selected Compute it is on.
   */
  private gatewayManagedModeSupported(): boolean {
    const compute = this.drivers.selection("compute")?.driver as ComputeDriver | undefined;
    return compute === undefined || compute.supportsGatewayManagedMode === true;
  }

  // Agent save refuses a managed mode the selected Compute Driver cannot apply, with deploy's
  // message, so it fails at save rather than at the next deploy (finding 2676).
  private requireGatewayManagedModeSupport(gatewayManagedMode: boolean): void {
    if (gatewayManagedMode && !this.gatewayManagedModeSupported()) {
      throw new ConfigurationHarnessError(GATEWAY_MANAGED_MODE_UNSUPPORTED);
    }
  }

  private async authorizeGatewayManagedModeChange(
    principalId: string,
    required: boolean,
  ): Promise<void> {
    if (required) {
      // The denial names gatewayManagedMode: the rest of the request needs no Installation grant
      // (finding 2691).
      await this.authorize(principalId, "administer", {
        kind: "installation",
        id: this.installation.id,
      }).catch((error: unknown) => {
        throw QualifiedAuthorizationDeniedError.qualify(error, "gateway_managed_mode");
      });
    }
  }

  /** Returns the AccessBindings it created; existing exact grants are kept. */
  private async ensureAgentOperateGrants(
    state: PlatformUnitOfWork,
    namespaceId: string,
    agent: Readonly<Agent>,
    sources: readonly (SecretReference | CredentialSourceReference)[],
  ): Promise<readonly Readonly<AccessBinding>[]> {
    return this.agentCredentialAccess.ensureAgentOperateGrants(state, namespaceId, agent, sources);
  }

  private grantDeployedAgentSources(
    state: PlatformUnitOfWork,
    principalId: string,
    agent: Readonly<Agent>,
    secretBindings: SecretBindings,
  ): Promise<void> {
    return this.agentCredentialAccess.grantDeployedAgentSources(
      state,
      principalId,
      agent,
      secretBindings,
    );
  }

  private runtimeCredentialsInput(
    input: AgentRuntimeCredentialsInput,
  ): AgentRuntimeCredentialsInput {
    const candidate = asRecord(input);
    if (candidate === undefined) {
      throw new ScopeViolationError("Agent runtime credentials must be a JSON object.");
    }
    const keys = Object.keys(candidate);
    if (keys.length !== 0) {
      throw new ScopeViolationError("Agent runtime credentials contain unsupported fields.");
    }
    return Object.freeze({});
  }

  private ownedCredentialGatewayDriver(source: CredentialSource): CredentialGatewayDriver {
    return this.credentialSourceDrivers.ownedCredentialGatewayDriver(source);
  }

  private credentialGatewayDriver(expectedId?: string): CredentialGatewayDriver {
    return this.credentialSourceDrivers.credentialGatewayDriver(expectedId);
  }

  private refreshDriverForSource(
    gateway: CredentialGatewayDriver,
    type: string,
  ): Promise<CredentialRefreshDriver | undefined> {
    return this.credentialSourceDrivers.refreshDriverForSource(gateway, type);
  }

  private credentialRefreshDriver(): CredentialRefreshDriver {
    return this.credentialSourceDrivers.credentialRefreshDriver();
  }

  private credentialGatewayOperation<T>(operation: () => Promise<T>): Promise<T> {
    return credentialGatewayOperation(operation);
  }

  private credentialNamespace(namespace: Readonly<Namespace>): Promise<Readonly<Namespace>> {
    return this.credentialSourceDrivers.credentialNamespace(namespace);
  }

  private ordinaryCredentialGatewayAllowed(type: CredentialSourceType): boolean {
    return this.egressAdmission.ordinaryCredentialGatewayAllowed(type);
  }

  private ordinaryModelBinding(
    state: PlatformReadView,
    agent: Readonly<Agent>,
    admitted?: HarnessAuthSnapshot,
  ): Promise<boolean> {
    return this.egressAdmission.ordinaryModelBinding(state, agent, admitted);
  }

  private staticSourceTypeAvailable(type: CredentialSourceType): boolean {
    return this.egressAdmission.staticSourceTypeAvailable(type);
  }

  private protectedSourceTypes() {
    return this.egressAdmission.protectedSourceTypes();
  }

  private assertCredentialSourceOwnerSelected(): void {
    if (!this.drivers.hasSelection("credential_proxy")) {
      this.assertCredentialGatewaySelected();
    }
  }

  private credentialSourceOwner(source: CredentialSource) {
    return this.credentialSourceDrivers.credentialSourceOwner(source);
  }

  private credentialSourceType(
    driver: CredentialGatewayDriver,
    type: string,
  ): Promise<CredentialSourceType> {
    return this.credentialSourceDrivers.credentialSourceType(driver, type);
  }

  private credentialSourceMetadata(
    source: Readonly<CredentialSource>,
    status?: CredentialSourceStatus,
  ): Readonly<CredentialSourceMetadata & { readonly status?: CredentialSourceStatus }> {
    return credentialSourceMetadata(source, status);
  }

  private iamPolicyDriver<Method extends keyof IAMDriver>(method: Method): IAMDriver {
    return this.iamPolicy.iamPolicyDriver(method);
  }

  private iamPolicyOperation<T>(operation: () => Promise<T>): Promise<T> {
    return iamPolicyOperation(operation);
  }

  private holdNamespacePolicyActor(state: PlatformUnitOfWork, principalId: string): Promise<void> {
    return this.iamPolicy.holdNamespacePolicyActor(state, principalId);
  }

  private namespaceIdentity(namespaceId: string): void {
    namespaceIdentity(namespaceId);
  }

  /**
   * The Agent a model policy refusal offers runtimes for: a dedicated Agent cannot run OpenClaw
   * where the Installation does not list dedicated OpenClaw (openClawExecutionModes), so its
   * refusals offer codex alone where Codex runs the model (finding 3036). With the deploy route's
   * `resolveHarness`, an embedded Agent cannot run Codex where the Installation approves the Codex
   * Harness only for dedicated execution (resolveAgentHarness refuses it), so its refusals offer
   * openclaw alone, or name the next step on a codex/<model> model (finding 3037). Callers without
   * that resolver (Agent provisioning, which Kubernetes Compute admits only for dedicated Agents,
   * and saved-Agent plugin discovery) keep every offer. Read only to word a refusal: an
   * unavailable Sandbox Driver keeps every offer too, and admission refuses it later.
   */
  private modelPolicyAgent(
    executionMode: HarnessExecutionMode,
    resolveHarness?: HarnessResolver,
  ): ModelPolicyAgent {
    return {
      codexRuns: () =>
        executionMode !== "embedded" ||
        resolveHarness?.("codex", "embedded")?.id === "codex" ||
        resolveHarness?.("codex", "dedicated")?.id !== "codex",
      openclawRuns: () => {
        if (executionMode !== "dedicated") {
          return true;
        }
        let sandbox: SandboxDriver | undefined;
        try {
          sandbox = this.sandboxPolicyOperations.sandboxDriver();
        } catch (error) {
          if (error instanceof DependencyUnavailableError) {
            return true;
          }
          throw error;
        }
        return admitsOpenClawExecutionMode(sandbox, executionMode, this.nativeWorkers) === true;
      },
    };
  }

  // An Agent with repository bindings reaches the repository credential broker through the
  // Codex network proxy in its Harness. Compute preparation refused a proxy setting that blocks
  // the broker only after a dedicated deployment stopped the running revision; Agent save,
  // provisioning and deployment refuse it first, with the rule preparation applies (finding
  // 2350). Preparation alone knows the broker host, from the prepared material, so it still
  // refuses a deny of that host. A Sandbox with its own repository path receives the material
  // from the worker instead and gets no broker policy.
  private validateRepositoryBrokerNetworkProxy(
    harness: Readonly<Pick<RevisionHarnessDescriptor, "id" | "mode">>,
    configuration: Readonly<OpenClawConfigurationDocument>,
    sandbox: SandboxDriver | undefined,
  ): void {
    if (sandbox?.repositoryAccess !== undefined || !codexProxiesRepositoryBroker(harness)) {
      return;
    }
    const proxy = codexRepositoryBrokerNetworkProxy(configuration);
    if ("refusal" in proxy) {
      throw new ConfigurationHarnessError(proxy.refusal);
    }
  }

  private agentRuntimeConfiguration(
    values: Readonly<OpenClawConfigurationDocument>,
    harness: RevisionHarnessDescriptor,
    compute: ComputeDriver,
    sandbox: SandboxDriver | undefined,
  ): OpenClawConfigurationDocument {
    return agentRuntimeConfiguration(values, harness, compute, sandbox, this.loggingLevel);
  }

  private configurationDriverSelected(capability: DriverCapability, id: string): boolean {
    return this.drivers.configurationDriverSelected(capability, id);
  }

  private enabledPluginDrivers(): readonly PluginDriver[] {
    return this.drivers.enabledPluginDrivers();
  }

  private pluginDriver(harnessId: string, selection = false): PluginDriver {
    return this.drivers.pluginDriver(harnessId, selection);
  }

  private clock(): Date {
    return this.resourceValues.now();
  }

  private nextIdentifier(kind: ResourceKind): string {
    return this.resourceValues.nextIdentifier(kind);
  }

  private timestamp(): string {
    return this.resourceValues.timestamp();
  }

  private backendId(value: BackendRef | undefined, preserve?: BackendRef): BackendRef {
    const backendId = value === undefined ? (preserve ?? null) : value;
    const backend = assertConfiguredBackend(this.backendMap, backendId, "Backend");
    if (backend !== undefined && backend.type !== "chatgpt") {
      throw new ScopeViolationError("The Agent Backend must support its Harness association.");
    }
    return backendId;
  }

  private read<T>(work: (state: PlatformReadView) => Promise<T>): Promise<T> {
    return this.transactions.read(work);
  }

  private requireIndependentMutation(operation: string): void {
    this.transactions.requireIndependentMutation(operation);
  }

  private mutate<T>(work: (state: PlatformUnitOfWork) => Promise<T>): Promise<T> {
    return this.transactions.transact(work);
  }

  private record(state: PlatformUnitOfWork, operation: ReconciliationOperation): Promise<void> {
    return this.workRecorder.record(state, operation);
  }
}
export { PostgresMetricsSnapshot } from "./state/postgres-metrics.ts";
export type { PlatformMetricsSnapshot } from "./state/postgres-metrics.ts";
