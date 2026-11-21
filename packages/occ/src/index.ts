import {
  reconcileNamespaceLifecycle,
  type NamespaceLifecycleBinding,
  type NamespaceLifecycleEvidence,
} from "./namespace-lifecycle.ts";

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

export type {
  CreateConnectionTemplateInput,
  CreateOAuthClientInput,
  UpdateConnectionTemplateInput,
} from "./connection-administration.ts";
import { exchangeAuthorizationCode, startBrowserAuthorization } from "./browser-authorization.ts";
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
import { isReducedCredentialPlan } from "./credential-policy-reduction.ts";

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
  eligibleRepositoryApprovalScope,
  repositoryApprovalFingerprint,
} from "./repository-approval.ts";

export {
  postgresPreparedGitHubProof,
  preparedGitHubLive,
  preparedGitHubRejectedMaterialMatch,
  readPreparedGitHubMetadata,
} from "./state/prepared-github-state.ts";
export type { PreparedGitHubMetadataAdmission } from "./state/prepared-github-state.ts";
import {
  CONTROLLER_WORK_AUDIT_ACTIONS,
  isOAuthScopeToken,
  isSourceProviderPresetId,
  ConnectionTemplateValidationError,
  MAX_AGENT_CREDENTIAL_SOURCES,
  assertExecutionAdmission,
  assertExecutionReleaseAllowed,
  credentialFreeMetadataGrant,
  isInstallationRepositoryProfile,
  repositoryGitDeliveryProfile,
  repositoryGitAuthorization,
  credentialFreeMetadataType,
  credentialSourceMatchesSnapshot,
  revisionCredentialSourceSnapshot,
  credentialFreeProviderRef,
  pluginRuntimeHarnessRequirement,
  codexProxiesRepositoryBroker,
  validPluginDriverIdentity,
  codexRepositoryBrokerNetworkProxy,
  SOURCE_PROVIDER_PRESET_CONFIG_KEY,
} from "@openclaw-enterprise/contracts";
import { EgressSendReceipts } from "./egress-send-receipts.ts";
import type {
  ExecutionAdmission,
  StaticEgressSource,
  ProxyPlan,
  EgressRefusal,
  EgressRoute,
  EgressSelectionEvidence,
  CredentialFreeEgressSource,
  PreparedTokenSource,
  PreparedTokenIssuer,
  TokenService,
  EgressRef,
  ProtectedEgressSource,
} from "@openclaw-enterprise/contracts";
import {
  CredentialProxy,
  supportsStaticCredentials,
  resolveCredentialProxyCapacity,
  type CredentialProxyCapacity,
  type ExchangeProvider,
} from "./credential-proxy.ts";
import type { EgressExchangeOwner, CapturedEgressUse } from "@openclaw-enterprise/contracts";

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
import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  accessBindingsTargeting,
  removeNamespacePolicy,
  removedPolicyDetails,
  type RemovedAccessBinding,
} from "./iam-policy-cleanup.ts";
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
import {
  cancelledDeviceAuthorization,
  deviceAuthorizationCipher,
  deviceAuthorizationScope,
  type DeviceAuthorizationSession,
} from "./device-authorization.ts";
import type {
  Agent,
  AgentCredentialSourceBinding,
  AgentRead,
  AgentRevisionRead,
  InitialWorkspaceFiles,
  AgentDeploymentDiagnostics,
  AgentRuntimeDescription,
  AgentHarnessStatusRead,
  AgentRevision,
  FirstDeploymentReceipt,
  AgentRuntimeCredentialsInput,
  AgentRuntimeCredentialStatus,
  AccessBinding,
  AuthorizationDecision,
  AuthorizationRequest,
  ComputeDriver,
  AgentChatCompletionsResolution,
  Configuration,
  ConfigurationDriver,
  ConfigurationValidationOptions,
  CredentialGatewayDriver,
  CredentialProviderDefinition,
  OAuthConnectionTemplateVersion,
  SavedConnection,
  OAuthRefreshTokenRegistration,
  OAuthConnectionStatus,
  OAuthAccountRef,
  OAuthConnectionClient,
  OAuthClient,
  ConnectionTemplate,
  CredentialRefreshDriver,
  CredentialRefreshStatus,
  CredentialSource,
  CredentialSourceReference,
  TokenServiceDriver,
  TokenServiceRegistration,
  SourceRegistrationInput,
  SourceUpdate,
  SourceProviderPresetId,
  CredentialSourceMetadata,
  CredentialSourceSnapshot,
  CredentialSourceStatus,
  CredentialWithdrawal,
  CredentialWithdrawalStatus,
  CredentialSourceType,
  AuditEvent,
  Driver,
  DriverCapability,
  HarnessDescriptor,
  CredentialSourceDeviceAuthorization,
  CredentialSourceDeviceAuthorizationResult,
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
  Permission,
  Preset,
  PresetSummary,
  PresetDraftDefinition,
  PluginDesiredSelection,
  PluginDesiredState,
  PluginApprovers,
  PluginCatalogEntry,
  PluginCatalogPage,
  PluginDriver,
  PluginDriverIdentity,
  ChannelDriver,
  ChannelDirectoryResult,
  ChannelDirectoryLookupInput,
  PluginRevisionState,
  BackendDefinition,
  BackendRef,
  RepositoryBindingRequest,
  RepositoryAccess,
  RepositoryBindingSelection,
  RepositoryOption,
  RepositoryOptions,
  RepositoryPolicyDriver,
  RepositoryCredentialResolution,
  RepositoryRevisionState,
  RevisionHarnessDescriptor,
  ResourceKind,
  ResourceRef,
  Role,
  SandboxDriver,
  Secret,
  SecretBindings,
  SecretReference,
  SecretDetail,
  SecretDriver,
  SecretMetadata,
  ServiceAccount,
  ServiceAccountCredential,
  ServiceAccountDriver,
  ServicePrincipal,
  HarnessAuthBinding,
  HarnessAuthSnapshot,
} from "@openclaw-enterprise/contracts";
import {
  isName,
  NAME_RULE,
  normalizeInitialWorkspaceFiles,
  normalizeWorkspaceDefaultsId,
  admitLoggingConfiguration,
  normalizeLoggingLevel,
  normalizePluginDesiredState,
  normalizePluginApprovers,
  normalizeHarnessAuthBinding,
  isSecretHarnessAuth,
  isServiceAccountHarnessAuth,
  type ServiceAccountReference,
  freezeAgentRevision,
} from "@openclaw-enterprise/contracts";
import {
  asRecord,
  hasControlCharacter,
  immutableCopy,
  isNonEmptyString,
} from "@openclaw-enterprise/utils";
import {
  codexRunsPrimaryModel,
  type ModelPolicyAgent,
  requireFallbackProviders,
  resolveConfiguredHarnessId,
} from "./configured-harness.ts";
import { workMatchesRevision, type ClaimedWork } from "./controller-work.ts";
import {
  createAgentQueries,
  type AgentRevisionListPage,
  type ActiveAgentRevisionSelection,
} from "./agent-queries.ts";
import { withAgentIdentityName } from "./openclaw-roster.ts";
import {
  DriverRegistry,
  unchangedDriver,
  type DriverFor,
  type RegisteredDriver,
} from "./driver-registry.ts";
import { readDeploymentInventory } from "./deployment-inventory.ts";
import { readInstallationCapabilities } from "./installation-capabilities.ts";
import {
  AGENT_NAME_CONFLICT,
  AgentCredentialSourceBindingError,
  AgentDeletingError,
  BrowserAuthorizationError,
  AuthorizationDeniedError,
  CallerStateDeniedError,
  DEDICATED_OPENCLAW_SANDBOX_REQUIRED,
  DedicatedOpenClawSandboxError,
  DeletionRetryOwnedError,
  DependencyUnavailableError,
  DeviceAuthorizationScopeMismatchError,
  DeviceAuthorizationStartError,
  DriverSelectionError,
  ModelDiscoveryError,
  ChannelDirectoryError,
  ChannelCredentialError,
  ComputeGatewaySettingError,
  ComputeProvisioningRefusedError,
  ComputeRepositoryCredentialsUnsupportedError,
  ConfigurationGenerationConflictError,
  ConfigurationHarnessError,
  configurationSettingMessage,
  CredentialGatewayNotConfiguredError,
  CredentialProxyAdmissionError,
  CredentialSourceConfigError,
  CredentialSourceDriverError,
  CredentialSourceTypeNotOfferedError,
  CredentialSourceUnprotectedError,
  CredentialWithdrawalInProgressError,
  CredentialWithdrawalNotFoundError,
  HarnessAuthSecretDriverError,
  keyedSettingPath,
  NamespaceNotEmptyError,
  NamespaceNotReadyError,
  NativeWorkerSupportError,
  NotImplementedError,
  PluginPolicyValidationError,
  ProvisioningSecretDriverError,
  QualifiedAuthorizationDeniedError,
  RepositoryBindingSelectionError,
  RepositoryGitProfileUnsupportedError,
  RepositoryOptionsUnavailableError,
  RepositoryDriverNotConfiguredError,
  RetryLaterError,
  SandboxRepositoryRecipientUnverifiedError,
  SavedRepositorySelectionError,
  ResourceConflictError,
  ResourceStateConflictError,
  ProtectedExecutionNetworkPolicyError,
  RuntimeCredentialsForbiddenByClusterError,
  ScopeViolationError,
  TokenServiceRegistrationRefusedError,
  ServiceAccountDriverNotConfiguredError,
  SecretBindingDriverError,
  SecretBindingValidationError,
  SecretDriverOwnershipError,
} from "./errors.ts";
import { admitGatewaySecurityDefaults } from "./gateway-security-defaults.ts";
import {
  refuseStoredConfigurationSettings,
  refuseUndeployableConfigurationValues,
} from "./configuration-settings.ts";
import { enabledChannelEntries, requireChannelSecretBindings } from "./channel-secret-bindings.ts";
import type { RuntimeLogPage, RuntimeLogQuery } from "./runtime-logs/index.ts";
import {
  nativeWorkerSupportSource,
  provisionsDedicatedOpenClaw,
  type NativeWorkerSupport,
  type NativeWorkerSupportSource,
} from "./native-worker-support.ts";
import {
  assertConfiguredBackend,
  backendDefinitionMap,
  validateBackendDefinitions,
  validateSelectedBackendDrivers,
  validateServiceAccountBackendBinding,
} from "./backends.ts";
import type { TokenServiceInstance } from "./ports/token-service.ts";
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
import {
  controllerWorkDeploymentStatus,
  deploymentErrorForWork,
  deploymentProgressForWork,
  deploymentStatusForWork,
  deploymentWarningsForWork,
  type DeploymentStatusResult,
} from "./state/controller-work.ts";
import { PostgresCommitOutcomeUnknownError } from "./state/postgres-state.ts";
import {
  validAdmittedRepositoryBindings,
  validRepositoryAccess,
  normalizedRepositoryAccess,
  validRepositoryRevisionState,
} from "./state/repository-credential-state.ts";
import {
  canonicalProvisioningJson,
  normalizeProvisioningConfiguration,
  normalizeProvisioningHarnessAuth,
  normalizeProvisioningWorkspace,
  normalizeRequestSecretBindings,
  provisioningProgress,
  requireProvisioningRequestId,
  type ProvisionAgentInput,
  type ProvisionAgentResult,
  type AgentProvisioningConfigurationInput,
} from "./agent-provisioning.ts";

import {
  createProvisioningWorker,
  type AgentProvisioningWorkerOptions,
  type AgentProvisioningWorkerOutcome,
  type HarnessResolver,
} from "./agent-provisioning-worker.ts";
import type { AgentProvisioningRecord } from "./ports/agent-provisioning.ts";
import {
  createSecretOperations,
  secretOperation,
  type CreateSecretInput,
  type UpdateSecretInput,
} from "./secret-operations.ts";
import {
  createConfigurationOperations,
  exactConfiguration,
  freezeConfigurationValues as frozenValues,
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
export { OPERATION_REFUSAL_HINT_CODES, operationRefusalHintCode } from "./state/controller-work.ts";
export type { OperationRefusalHintCode } from "./state/controller-work.ts";
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
export { PostgresCommitOutcomeUnknownError };
export { AuditAppendUnavailableError } from "./errors.ts";
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
  controllerWorkDeploymentStatus,
  credentialWithdrawalWorkKey,
  isCredentialWithdrawalWork,
  revisionAdmittedBeforeWork,
  runtimeFailureCause,
  validateRuntimeFailureEvidence,
  type DeploymentStatus,
  type DeploymentStatusError,
  type DeploymentStatusResult,
  type PluginDeploymentWarning,
  type RuntimeFailureCause,
  type RuntimeFailureEvidence,
} from "./state/controller-work.ts";
export type {
  ActiveAgentRevisionSelection,
  AgentRevisionListing,
  AgentRevisionListPage,
} from "./agent-queries.ts";
export { type AgentProvisioningProgress, type ProvisionAgentInput } from "./agent-provisioning.ts";
export type {
  AgentProvisioningWorkerOptions,
  AgentProvisioningWorkerOutcome,
  HarnessResolver,
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

export class AgentAuditDisclosureUnavailableError extends DependencyUnavailableError {
  constructor() {
    super("The Agent audit disclosure record is unavailable.");
  }
}

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

export interface CreateNamespaceInput {
  readonly name: string;
  readonly existingNamespace?: string;
}

export interface CreateAgentInput {
  readonly initialWorkspaceFiles?: InitialWorkspaceFiles;
  readonly workspaceDefaultsId?: string;
  readonly namespaceId: string;
  readonly name: string;
  readonly configurationId: string;
  readonly backendId?: string | null;
  readonly harnessAuth?: HarnessAuthBinding | null;
  readonly credentialSources?: readonly AgentCredentialSourceBinding[];
  readonly executionMode?: HarnessExecutionMode;
  readonly gatewayManagedMode?: boolean;
  readonly plugins?: PluginDesiredState;
  readonly pluginApprovers?: PluginApprovers;
  readonly repositoryBindings?: readonly RepositoryBindingRequest[];
  readonly repositoryAccess?: RepositoryAccess;
}

/** Create Agent's preflight input: an Agent create body with its Configuration inline, unsaved. */
export interface ValidateAgentCreateInput {
  readonly namespaceId: string;
  /** The name Agent create will use; absent skips the duplicate-name check. */
  readonly name?: string;
  readonly configuration: {
    readonly kind: "agent";
    readonly values: Readonly<OpenClawConfigurationDocument>;
    /**
     * The Secret bindings the caller will save with these values. Their Secrets are not read;
     * absent skips the check that each channel credential reference has a binding.
     */
    readonly secretBindings?: SecretBindings;
  };
  readonly initialWorkspaceFiles?: InitialWorkspaceFiles;
  readonly executionMode?: HarnessExecutionMode;
  readonly gatewayManagedMode?: boolean;
  readonly plugins?: PluginDesiredState;
  readonly pluginApprovers?: PluginApprovers;
  /**
   * The binding Agent create will name, or only the method of a Secret binding whose Secret the
   * caller saves next. Absent or null: Harness authentication is not checked.
   */
  readonly harnessAuth?: HarnessAuthBinding | PlannedSecretHarnessAuth | null;
}

/** A Secret-backed Harness authentication method whose Secret is not saved yet. */
export interface PlannedSecretHarnessAuth {
  readonly method: "api_key" | "codex_pat";
}

interface RemoveStandingApprovalInput {
  readonly namespaceId: string;
  readonly agentId: string;
  readonly approvalId: string;
  readonly expectedGeneration: number;
  readonly repositoryRef?: string;
}

export interface UpdateAgentInput {
  readonly repositoryStandingApproval?: {
    readonly repositoryRef: string;
    readonly approvalId: string;
  } & (
    | {
        readonly approved: true;
        readonly duration: "until-removed";
        readonly expectedScopeFingerprint: string;
      }
    | { readonly approved: false; readonly expectedGeneration: number }
  );
  readonly namespaceId: string;
  readonly agentId: string;
  readonly configurationId?: string;
  readonly backendId?: string | null;
  readonly harnessAuth?: HarnessAuthBinding | null;
  /** Replaces the Agent's non-model sources; an empty list removes them. */
  readonly credentialSources?: readonly AgentCredentialSourceBinding[];
  readonly executionMode?: HarnessExecutionMode;
  readonly gatewayManagedMode?: boolean;
  readonly plugins?: PluginDesiredState;
  readonly pluginApprovers?: PluginApprovers | null;
  readonly repositoryBindings?: readonly RepositoryBindingRequest[];
  readonly repositoryAccess?: RepositoryAccess;
}

export interface LookupChannelDirectoryInput {
  readonly secretId: string;
  readonly kind: ChannelDirectoryLookupInput["kind"];
  readonly query?: string;
  readonly cursor?: string;
  readonly ids?: readonly string[];
  readonly agentId?: string;
  readonly configurationId?: string;
}

export interface CreateCredentialSourceInput {
  readonly namespaceId: string;
  readonly name: string;
  readonly type: string;
  readonly config?: Readonly<Record<string, string>>;
  readonly secrets?: Readonly<Record<string, SecretReference>>;
}

export type UpdateManagedCredentialSourceInput =
  | (SourceUpdate & { readonly providerPreset?: SourceProviderPresetId | null })
  | {
      readonly providerPreset: SourceProviderPresetId | null;
      readonly secret?: never;
      readonly lifecycleConfig?: never;
    };

export interface AgentCredentialSourceInput {
  readonly namespaceId: string;
  readonly agentId: string;
  readonly credentialSourceId: string;
}

export interface StartNamespaceConnectionInput {
  readonly selectedScopes?: readonly string[];
  readonly sessionId: string;
  readonly namespaceId: string;
  readonly connectionTemplateId: string;
  /** The exact OCC callback URI, derived from trusted console configuration. */
  readonly redirectUri: string;
}

export interface CompleteNamespaceConnectionInput {
  readonly sessionId: string;
  readonly iss?: string;
  readonly state: string;
  /** Present on approval. */
  readonly code?: string;
  /** Present when the provider reports a refusal, such as `access_denied`. */
  readonly error?: string;
}

export interface UpdateCredentialSourceInput {
  readonly adoption?: "live";
  readonly authorityScope?: "execution";
  readonly namespaceId: string;
  readonly credentialSourceId: string;
  /**
   * Replacement references for the same fields; omit to re-send the current Secret values. A
   * field the catalog marks `issuerRotated` must name a different Secret than the recorded one.
   */
  readonly secrets?: Readonly<Record<string, SecretReference>>;
}

export interface RotateCredentialSourceInput {
  readonly namespaceId: string;
  readonly credentialSourceId: string;
}

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
/** Bounds each synchronous Credential Gateway call made while serving an API request. */
const CREDENTIAL_GATEWAY_TIMEOUT_MS = 30_000;
function credentialSourceRef(source: Readonly<CredentialSource>): CredentialSourceReference {
  return { kind: "credential_source", id: source.id, namespaceId: source.namespaceId };
}

function isManagedTokenServiceSource(
  source: Readonly<CredentialSource> | undefined,
): source is Readonly<
  CredentialSource & { ownerCapability: "token_service"; tokenServiceInstanceId: string }
> {
  return (
    source?.ownerCapability === "token_service" && typeof source.tokenServiceInstanceId === "string"
  );
}

function assertManagedSourceLifecycleSettings(settings: Readonly<Record<string, string>>): void {
  if (Object.hasOwn(settings, SOURCE_PROVIDER_PRESET_CONFIG_KEY)) {
    throw new ScopeViolationError("Provider preset approval is not a lifecycle setting.");
  }
}

function assertSourceProviderPreset(value: unknown): asserts value is SourceProviderPresetId {
  if (!isSourceProviderPresetId(value)) {
    throw new ScopeViolationError("Choose an approved source provider preset.");
  }
}

function managedSourceConfig(
  source: Readonly<CredentialSource>,
  input: UpdateManagedCredentialSourceInput,
): Readonly<Record<string, string>> {
  const config = { ...(input.lifecycleConfig?.settings ?? source.config) };
  const approved = source.config[SOURCE_PROVIDER_PRESET_CONFIG_KEY];
  if (input.lifecycleConfig !== undefined && approved !== undefined) {
    config[SOURCE_PROVIDER_PRESET_CONFIG_KEY] = approved;
  }
  if (input.providerPreset === null) {
    delete config[SOURCE_PROVIDER_PRESET_CONFIG_KEY];
  } else if (input.providerPreset !== undefined) {
    config[SOURCE_PROVIDER_PRESET_CONFIG_KEY] = input.providerPreset;
  }
  return config;
}

const CONNECTION_OPERATION_TIMEOUT_MS = 30_000;
const CONNECTION_SESSION_TTL_MS = 10 * 60 * 1000;
/** Only a claimed server-side consent attempt may operate on its still-pending source. */
const PENDING_CONNECTION: unique symbol = Symbol("pending-connection");
const MANAGED_SOURCE: unique symbol = Symbol("managed-source");
const CREDENTIAL_SOURCE_SECRETS_CROSS_NAMESPACES =
  "Credential source Secrets cannot cross Namespaces.";

/**
 * A Credential Gateway must finish any effect of an aborted registration within
 * CREDENTIAL_GATEWAY_TIMEOUT_MS after the abort. Until this long after `createdAt`, an absent
 * gateway copy does not prove that no late create is still in flight, so the record is kept.
 */
const CREDENTIAL_REGISTRATION_FENCE_MS = 2 * CREDENTIAL_GATEWAY_TIMEOUT_MS + 10_000;

/**
 * The IDs of one kind that a NAMESPACE_NOT_EMPTY conflict examines and may name. Each costs
 * one read decision while deletion holds the Namespace lock, so the bound limits that work.
 */
const NAMESPACE_NOT_EMPTY_ID_LIMIT = 20;

function connectionConsentScopes(
  version: Readonly<OAuthConnectionTemplateVersion>,
  selection?: readonly string[],
): readonly string[] {
  if (version.mode === "manual" && version.scopes.length) {
    if (selection !== undefined) {
      throw new ConnectionTemplateValidationError(
        "selectedScopes",
        "This connection template uses fixed scopes.",
      );
    }
    return version.scopes;
  }
  const selected = selection ?? [];
  const approved = new Set(version.scopes);
  const requested = new Set(selected);
  const required = version.observed?.requestedScopes ?? [];
  if (
    (approved.size > 0 && requested.size === 0) ||
    requested.size !== selected.length ||
    selected.some(
      (scope) => !isOAuthScopeToken(scope) || (approved.size > 0 && !approved.has(scope)),
    ) ||
    required.some((scope) => !requested.has(scope))
  ) {
    throw new ConnectionTemplateValidationError(
      "selectedScopes",
      "Include each scope required by the resource and choose valid scopes within any configured limit.",
    );
  }
  return selected;
}

function browserAuthorizationRequest(
  version: Readonly<OAuthConnectionTemplateVersion>,
  client: Readonly<OAuthClient>,
  redirectUri: string,
  selectedScopes: readonly string[],
) {
  return {
    oauthClientId: client.id,
    issuer: version.issuer,
    clientId: client.clientId,
    tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
    authorizationUrl: version.authorizationUrl,
    tokenUrl: version.tokenUrl,
    ...(version.mcp ? { resource: version.mcp.resource } : {}),
    scopes: selectedScopes,
    authorizationParameters: version.authorizationParameters,
    redirectUri,
  };
}

/**
 * Revisions other than `active` that may still run with the sources they were admitted with,
 * and so need their own withdrawal of a source withdrawn from the Agent: earlier revisions not
 * yet retired, newest first, then every later admitted revision, which may still deploy. The
 * worker publishes a revision as active before it retires the earlier ones, and completes the
 * deployment only after that, so until the active revision's deployment has activated it, its
 * predecessor keeps serving. The walk stops at the newest revision whose deployment succeeded,
 * which means it activated: the worker completes that work only after retiring everything
 * before it. The in-memory store reports all work as queued, so there the walk always reaches
 * the first revision.
 */
export async function credentialWithdrawalCompanionRevisions(
  state: { readonly operations: Pick<PlatformReadView["operations"], "findWork"> },
  revisions: readonly Readonly<AgentRevision>[],
  active: Readonly<AgentRevision>,
  now: Date,
): Promise<readonly Readonly<AgentRevision>[]> {
  const ordered = revisions
    .filter((candidate) => candidate.revision <= active.revision)
    .sort((left, right) => right.revision - left.revision);
  const companions: Readonly<AgentRevision>[] = [];
  for (const candidate of ordered) {
    if (candidate.id !== active.id) {
      companions.push(candidate);
    }
    const work = await state.operations.findWork(`agent_revision:${candidate.id}:reconcile`);
    if (
      work !== undefined &&
      work.namespaceId === candidate.namespaceId &&
      work.revisionId === candidate.id &&
      controllerWorkDeploymentStatus(work, now) === "succeeded"
    ) {
      break;
    }
  }
  companions.push(
    ...revisions
      .filter((candidate) => candidate.revision > active.revision)
      .sort((left, right) => left.revision - right.revision),
  );
  return companions;
}

function registeredCredentialProvider(
  providers: readonly CredentialProviderDefinition[],
  ref: EgressRef,
): CredentialProviderDefinition | "ambiguous" | undefined {
  const matches = providers.filter(
    (provider) => provider.ref.id === ref.id && provider.ref.generation === ref.generation,
  );
  if (matches.length > 1) {
    return "ambiguous";
  }
  return matches.length === 1 && isDeepStrictEqual(matches[0]!.ref, ref) ? matches[0] : undefined;
}

function matchesAdmittedSourceType(
  source: CredentialSource,
  provider: CredentialProviderDefinition,
) {
  return (
    source.egress?.adoption !== "live" ||
    (provider.sourceType.type === source.type && supportsStaticCredentials(provider.sourceType))
  );
}

/** The revision was admitted with the source, as its Harness authentication or in its list. */
function revisionHoldsCredentialSource(
  revision: Readonly<AgentRevision>,
  credentialSourceId: string,
): boolean {
  return (
    (revision.harnessAuth.method === "credential_source" &&
      revision.harnessAuth.sourceId === credentialSourceId) ||
    (revision.credentialSources ?? []).some(({ sourceId }) => sourceId === credentialSourceId)
  );
}

/** The source, binding and single permitted metadata operation must describe the same grant. */
function matchesCredentialFreeMetadataGrant(
  source: Readonly<CredentialSource>,
  route: EgressRoute,
) {
  const admitted = source.egress;
  const { binding } = route;
  if (
    source.type !== credentialFreeMetadataType ||
    admitted?.adoption !== "credential_free" ||
    !isDeepStrictEqual(admitted.key.provider, credentialFreeProviderRef) ||
    !isDeepStrictEqual(binding.source, admitted.key)
  ) {
    return false;
  }
  const grant = credentialFreeMetadataGrant(source.config);
  return (
    admitted.origin === source.config.origin &&
    route.origin === admitted.origin &&
    route.method === "GET" &&
    route.path === `/repos/${grant.repository}` &&
    grant.isolationId === binding.execution.agentId &&
    grant.isolationId === binding.isolationId &&
    isDeepStrictEqual(admitted.grant, grant) &&
    isDeepStrictEqual(binding.grant, grant) &&
    binding.grantHash === createHash("sha256").update(JSON.stringify(grant)).digest("hex")
  );
}

/** A name-based (version 5 layout) UUID, so a replayed registration step reuses its request ID. */
function credentialRefreshRequestId(sourceId: string, step: "configure" | "rotate"): string {
  const bytes = createHash("sha1")
    .update(`openclaw.credential_source.refresh:${sourceId}:${step}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A mint that did not produce a token is reported with the Driver's safe failure code. */
function assertRefreshMinted(status: CredentialRefreshStatus): void {
  if (status.state === "ready") {
    return;
  }
  const code = status.failureCode === undefined ? "" : ` (${status.failureCode})`;
  throw new DependencyUnavailableError(
    `The Credential Refresh Driver did not mint a token${code}.`,
  );
}

function assertCredentialGatewayHoldsSource(status: CredentialSourceStatus): void {
  if (status.state === "failed" || status.state === "absent") {
    throw new DependencyUnavailableError("The Credential Gateway did not update the source.");
  }
}

/**
 * Refuses an update that would re-send an issuer-rotated value from the Secret it came from:
 * the gateway may hold a newer one, and the issuer can reject the old one or revoke the grant.
 */
function refuseIssuerRotatedResend(
  type: Readonly<CredentialSourceType>,
  recorded: Readonly<Record<string, SecretReference>>,
  next: Readonly<Record<string, SecretReference>>,
): void {
  for (const { name, issuerRotated } of type.secrets) {
    if (
      issuerRotated === true &&
      recorded[name] !== undefined &&
      next[name]?.id === recorded[name].id
    ) {
      throw new ResourceStateConflictError(
        `The gateway may already hold a newer ${name} than the source's Secret, so the update must reference a new Secret, even if you replaced this Secret's value. Complete a new sign-in, store its ${name} in a new Secret, and update the source to reference that Secret.`,
      );
    }
  }
}

/**
 * Rejects unknown and missing catalog fields before any Credential Gateway effect. Callers hold
 * the source's grant and named its type, so the refusal names the type's catalog and the field
 * as a request error (finding 2536). The HTTP schema bounds field names; HTTP caps the message.
 */
function credentialSourceFieldsMatch(
  type: Readonly<CredentialSourceType>,
  group: "config" | "secrets",
  values: Readonly<Record<string, unknown>>,
): void {
  const specs = type[group];
  const known = new Set(specs.map((spec) => spec.name));
  const shown = (field: string) => keyedSettingPath(group, field);
  for (const field of Object.keys(values)) {
    if (!known.has(field)) {
      const allowed = specs.length === 0 ? "none" : specs.map((spec) => spec.name).join(", ");
      throw new CredentialSourceConfigError(
        field,
        `Credential source type ${type.type} has no field ${shown(field)}: remove it. Its ${group} fields: ${allowed}.`,
        group,
      );
    }
  }
  for (const spec of specs) {
    if (spec.required && values[spec.name] === undefined) {
      throw new CredentialSourceConfigError(
        spec.name,
        group === "secrets"
          ? `Credential source type ${type.type} requires ${shown(spec.name)}: add a reference to a Secret in this Namespace.`
          : `Credential source type ${type.type} requires ${shown(spec.name)}: add it.`,
        group,
      );
    }
  }
}

/**
 * Standing repository approval refusals (finding 2536). Agent update and deploy raise them after
 * the caller's grant on the Agent; approving needs Agent administer. None names an approval ID
 * or a repository, so a caller without Agent administer learns only that an approval blocks.
 */
const STANDING_APPROVAL_REFUSALS = Object.freeze({
  bindingLocked:
    "A standing repository approval holds this Agent's repository binding, so the binding cannot change. Remove the approval first (this needs Agent administer on the Agent), then save again.",
  oneBinding:
    "A standing repository approval needs exactly one repository binding on the Agent. Keep one binding, then approve again.",
  notPermitted:
    "Team policy does not permit this standing approval: it must last until removed and name one of the Agent's repository bindings that the Installation allows standing approval for. Ask an Installation administrator to allow it.",
  scopeChanged:
    "The standing approval scope changed since you reviewed it. Read the current scope from repository-approval-scopes, review it, then approve again with its scopeFingerprint as expectedScopeFingerprint.",
  deployOneBinding:
    "This Agent has a standing repository approval but not exactly one repository binding. Keep one binding, or remove the approval (this needs Agent administer on the Agent), then deploy again.",
  policyChanged:
    "This Agent's standing repository approval no longer matches team policy. Remove it (this needs Agent administer on the Agent) and approve the current scope again, or deploy after an Installation administrator restores the policy.",
});

/**
 * Prepared and credential-free sources hold a protected grant admitted once, at create
 * (finding 2536): an update or rotation cannot change it in place.
 */
const FIXED_PROTECTED_SOURCE_REFUSALS = Object.freeze({
  update:
    "This credential source holds a prepared or credential-free protected grant, which cannot change in place. Create a new source with the new values, bind it in place of this one, then delete this one.",
  rotate:
    "This credential source holds a prepared or credential-free protected grant, which is not rotated in place. To replace it, create a new source, bind it in place of this one, then delete this one.",
});

/** Product names for Harness ids that appear in caller-facing refusals. */
const HARNESS_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  codex: "Codex",
  openclaw: "OpenClaw",
});

function validExecutionMode(value: unknown): value is HarnessExecutionMode {
  return value === "embedded" || value === "dedicated";
}

const GATEWAY_MANAGED_MODE_UNSUPPORTED =
  "Agent setting gatewayManagedMode is not supported by the selected Compute Driver.";

function normalizeGatewayManagedMode(value: unknown, defaultValue?: boolean): boolean {
  const mode = value === undefined ? defaultValue : value;
  if (typeof mode !== "boolean") {
    throw new ScopeViolationError("The Agent Gateway managed mode must be a boolean.");
  }
  return mode;
}

// Agent save and deploy admission apply these rules to the same pair, with the same message.
function requireSandboxExecutionMode(
  sandbox: SandboxDriver | undefined,
  executionMode: HarnessExecutionMode,
): void {
  if (sandbox !== undefined && executionMode !== "dedicated") {
    throw new ConfigurationHarnessError(
      `The selected Sandbox Driver supports only dedicated Harness execution; this Agent uses ${executionMode} execution. Set executionMode to dedicated.`,
    );
  }
}

function requireSandboxOpenClawMode(
  sandbox: SandboxDriver | undefined,
  executionMode: HarnessExecutionMode,
): void {
  if (sandbox === undefined) {
    return;
  }
  const support = sandbox.supportsHarnessExecutionMode.openclaw[executionMode];
  if (!support.supported) {
    throw new ConfigurationHarnessError(
      support.reason ??
        `The selected Sandbox Driver does not support ${executionMode} OpenClaw execution. Select a supported Harness or ask an operator to change the Sandbox Driver.`,
    );
  }
}

/**
 * The Installation's approved Harness for the Configuration's runtime and the Agent's execution
 * mode, or undefined when none is approved. A Harness approved only for the other mode is a
 * request the caller can fix, not a missing dependency.
 */
function resolveAgentHarness(
  resolveHarness: HarnessResolver,
  configuredHarnessId: string,
  executionMode: HarnessExecutionMode,
): HarnessDescriptor | undefined {
  const approvedHarness = resolveHarness(configuredHarnessId, executionMode);
  const otherMode = executionMode === "dedicated" ? "embedded" : "dedicated";
  if (
    approvedHarness === undefined &&
    resolveHarness(configuredHarnessId, otherMode)?.id === configuredHarnessId
  ) {
    const harnessName = HARNESS_DISPLAY_NAMES[configuredHarnessId] ?? configuredHarnessId;
    throw new ConfigurationHarnessError(
      `The Configuration selects the ${harnessName} Harness, which needs ${otherMode} execution; this Agent uses ${executionMode} execution. Change the Agent's execution mode or its Configuration.`,
    );
  }
  return approvedHarness;
}

// Whether the Configuration selects a model for the default or any roster entry.
function selectsModel(values: Readonly<OpenClawConfigurationDocument>): boolean {
  const agents = asRecord(values.agents);
  return [asRecord(agents?.defaults), ...Object.values(asRecord(agents?.entries) ?? {})].some(
    (entry) => asRecord(entry)?.model !== undefined,
  );
}

// A Driver names unsupported Configuration content the caller owns; keep that message. Other
// refusals get this fixed text; the caller is already authorized for the Agent.
function validateAgentHarnessAuth(
  compute: ComputeDriver,
  ...input: Parameters<NonNullable<ComputeDriver["validateHarnessAuth"]>>
): void {
  if (compute.validateHarnessAuth === undefined) {
    throw new DependencyUnavailableError(
      "The selected Compute Driver does not support Harness authentication bindings.",
    );
  }
  try {
    compute.validateHarnessAuth(...input);
  } catch (error) {
    if (error instanceof ConfigurationHarnessError) {
      throw error;
    }
    throw new ResourceStateConflictError(
      "The selected Compute Driver cannot deliver this Harness authentication binding to the configured model and topology.",
    );
  }
}

function validateRepositoryTopology(
  compute: ComputeDriver,
  harness: RevisionHarnessDescriptor,
  sandboxDriverId: string | undefined,
): void {
  if (compute.validateRepositoryCredentials === undefined) {
    // An Installation property every attempt meets the same way, not an outage to retry
    // (finding 2536); RepositoryDriverNotConfiguredError words the sibling rule.
    throw new ComputeRepositoryCredentialsUnsupportedError();
  }
  try {
    compute.validateRepositoryCredentials(harness, sandboxDriverId);
  } catch (error) {
    throw new ResourceStateConflictError(
      error instanceof SandboxRepositoryRecipientUnverifiedError
        ? error.message
        : "The selected Compute Driver cannot deliver repository credentials to this Harness topology.",
    );
  }
}

// Preparation of every deployment applies the same rule; a Configuration setting keeps
// the Driver's message, which names it. With a Sandbox Driver selected every Agent runs in its
// Sandbox, and a Compute Driver that cannot deliver the files there says so (finding 1144).
function validateWorkspaceSetupTopology(
  compute: ComputeDriver,
  harness: RevisionHarnessDescriptor,
  configuration: Readonly<OpenClawConfigurationDocument>,
  sandboxDriverId: string | undefined,
): void {
  try {
    compute.validateWorkspaceSetup?.(harness, configuration, sandboxDriverId);
  } catch (error) {
    if (error instanceof ConfigurationHarnessError) {
      throw error;
    }
    // Kubernetes Compute refuses any Harness in a Sandbox first; a Driver that can deliver
    // into a Sandbox would need its own refusal text here.
    throw new ResourceStateConflictError(
      sandboxDriverId === undefined
        ? "The selected Compute Driver cannot deliver initial workspace files to this Agent."
        : "The selected Compute Driver cannot deliver initial workspace files to a Harness in the selected Sandbox. Use an Agent without initialWorkspaceFiles.",
    );
  }
}

// The Compute Driver refuses a plan it cannot provision (execution mode, gateway settings,
// routing). Report that as a refusal of this plan, as validateHarnessAuth does, so the API
// answers 409 rather than 500 and the worker does not retry a plan every attempt will refuse.
// A gateway setting in the caller's own Configuration keeps the Driver's reason, which names
// that setting; any other refusal gets fixed text and keeps its reason for the API log.
function validateComputeAgentProvisioning(
  compute: ComputeDriver,
  executionMode: HarnessExecutionMode,
  configuration: Readonly<OpenClawConfigurationDocument>,
): void {
  try {
    compute.validateAgentProvisioning?.({ executionMode, configuration });
  } catch (error) {
    if (
      error instanceof DependencyUnavailableError ||
      error instanceof ComputeGatewaySettingError
    ) {
      throw error;
    }
    throw new ComputeProvisioningRefusedError(error);
  }
}

// `configuration`, where the caller has the Agent's, lets the 409 offer codex when Codex runs its
// models (finding 3036).
function requireDedicatedNativeSupport(
  harness: Readonly<Pick<RevisionHarnessDescriptor, "id" | "mode">>,
  sandbox: SandboxDriver | undefined,
  nativeWorkers: NativeWorkerSupportSource | undefined,
  {
    runtimeImage = true,
    stored = false,
    configuration,
  }: {
    readonly runtimeImage?: boolean;
    readonly stored?: boolean;
    readonly configuration?: Readonly<OpenClawConfigurationDocument>;
  } = {},
): void {
  if (harness.id !== "openclaw" || harness.mode !== "dedicated") {
    return;
  }
  if (runtimeImage && nativeWorkers === undefined) {
    throw new NativeWorkerSupportError();
  }
  if (!provisionsDedicatedOpenClaw(sandbox)) {
    // A new request meets a fixed Installation shape: a permanent refusal (finding 1609). Stored
    // provisioning work waits for the Driver to return, as for any dependency outage.
    if (stored) {
      throw new DependencyUnavailableError(DEDICATED_OPENCLAW_SANDBOX_REQUIRED);
    }
    throw new DedicatedOpenClawSandboxError(
      configuration !== undefined && codexRunsPrimaryModel(configuration),
    );
  }
}

/**
 * Whether an OpenClaw Agent in this execution mode passes both save and deploy admission on this
 * Installation shape: true, or the refusal. It runs admission's own checks, so the Installation
 * capability built from it cannot disagree with them (#2670).
 */
function admitsOpenClawExecutionMode(
  sandbox: SandboxDriver | undefined,
  executionMode: HarnessExecutionMode,
  nativeWorkers: NativeWorkerSupportSource | undefined,
): true | Error {
  try {
    requireSandboxExecutionMode(sandbox, executionMode);
    requireDedicatedNativeSupport({ id: "openclaw", mode: executionMode }, sandbox, nativeWorkers);
    requireSandboxOpenClawMode(sandbox, executionMode);
    return true;
  } catch (error) {
    if (
      error instanceof ConfigurationHarnessError ||
      error instanceof NativeWorkerSupportError ||
      error instanceof DedicatedOpenClawSandboxError
    ) {
      return error;
    }
    throw error;
  }
}

function validRepositorySelector(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function validRepositoryOption(value: unknown): value is RepositoryOption {
  const option = asRecord(value);
  const displayName = option?.displayName;
  const allowedProfiles = option?.allowedProfiles;
  return (
    validRepositorySelector(option?.repositoryRef) &&
    isNonEmptyString(displayName) &&
    displayName.length <= 200 &&
    !hasControlCharacter(displayName) &&
    (option?.description === undefined ||
      (isNonEmptyString(option.description) &&
        Array.from(option.description).length <= 512 &&
        !hasControlCharacter(option.description))) &&
    Array.isArray(allowedProfiles) &&
    allowedProfiles.length >= 1 &&
    allowedProfiles.length <= 16 &&
    new Set(allowedProfiles).size === allowedProfiles.length &&
    allowedProfiles.every(validRepositorySelector)
  );
}

function invalidPluginRequest(): never {
  throw new PluginPolicyValidationError();
}

function normalizeAgentPlugins(
  plugins: PluginDesiredState | undefined,
): PluginDesiredState | undefined {
  return normalizePluginDesiredState(plugins, invalidPluginRequest);
}

function normalizeAgentPluginApprovers(approvers: unknown): PluginApprovers | undefined {
  return normalizePluginApprovers(approvers, invalidPluginRequest);
}

function sameSecretBackend(left: Secret, right: Secret): boolean {
  return (
    left.id === right.id &&
    left.namespaceId === right.namespaceId &&
    left.driverId === right.driverId &&
    left.backendRef.uid === right.backendRef.uid &&
    left.backendRef.name === right.backendRef.name &&
    left.backendRef.namespaceName === right.backendRef.namespaceName &&
    left.backendRef.key === right.backendRef.key
  );
}

function validChannelDirectoryResult(value: unknown): value is ChannelDirectoryResult {
  const result = asRecord(value);
  const bounded = (candidate: unknown, maxLength: number): candidate is string =>
    typeof candidate === "string" &&
    candidate.length > 0 &&
    candidate.length <= maxLength &&
    !hasControlCharacter(candidate);
  if (
    result === undefined ||
    !bounded(result.workspaceId, 200) ||
    (result.workspaceName !== undefined && !bounded(result.workspaceName, 200)) ||
    !Array.isArray(result.candidates) ||
    result.candidates.length > 100 ||
    (result.nextCursor !== undefined && !bounded(result.nextCursor, 2048)) ||
    typeof result.complete !== "boolean"
  ) {
    return false;
  }
  const ids = new Set<string>();
  for (const candidate of result.candidates) {
    const entry = asRecord(candidate);
    if (
      entry === undefined ||
      !bounded(entry.id, 200) ||
      !bounded(entry.name, 200) ||
      (entry.displayName !== undefined && !bounded(entry.displayName, 200)) ||
      ids.has(entry.id)
    ) {
      return false;
    }
    ids.add(entry.id);
  }
  return true;
}

// A rule about the request alone, checked before any ServiceAccount grant or lookup, so the text
// is the same whether the named account exists (finding 2536).
const SERVICE_ACCOUNT_CROSS_NAMESPACE =
  "Agent setting harnessAuth.source names a ServiceAccount in another Namespace. Harness authentication can use only a ServiceAccount in the Agent's own Namespace: select one from this Namespace.";

// Internal Installation composition only; the public Repo Driver contract is unchanged.
type InstallationRepositoryAdmission = Readonly<{
  policyMode?: "built-in";
  policy: RepositoryPolicyDriver & {
    listCatalog(input: { readonly namespaceId: string }): Promise<RepositoryOptions>;
    resolveBindings(input: {
      readonly namespaceId: string;
      readonly bindings: readonly RepositoryBindingRequest[];
    }): RepositoryCredentialResolution;
  };
  backendId: string;
}>;

export class OpenClawController {
  private installationRepositoryAdmission?: InstallationRepositoryAdmission;
  private builtInRepositoryDriver?: RegisteredDriver;

  /** @internal Bind the Installation's exact owner for fresh revision admission. */
  static forInstallation(
    installation: Installation,
    options: ControllerOptions,
    repositoryAdmission: InstallationRepositoryAdmission | undefined,
  ): OpenClawController {
    const controller = new OpenClawController(installation, options);
    if (
      repositoryAdmission === undefined &&
      controller.backends.some((backend) => "repo" in backend.drivers)
    ) {
      throw new DriverSelectionError(
        "The Installation requires an explicit repository admission owner.",
      );
    }
    if (repositoryAdmission !== undefined) {
      const backend = controller.backendMap.get(repositoryAdmission.backendId);
      if (backend?.type !== "github" || backend.drivers.repo !== repositoryAdmission.policy.id) {
        throw new DriverSelectionError("Repository admission must bind its exact owning Backend.");
      }
      if (
        repositoryAdmission.policyMode !== undefined &&
        repositoryAdmission.policyMode !== "built-in"
      ) {
        throw new DriverSelectionError("The repository policy mode is invalid.");
      }
      if (repositoryAdmission.policyMode === "built-in") {
        const policy = repositoryAdmission.policy;
        const identity: RegisteredDriver = Object.freeze({
          driver: policy,
          id: policy.id,
          capability: policy.capability,
          implementation: policy.implementation,
        });
        if (
          identity.capability !== "repo" ||
          !isNonEmptyString(identity.implementation) ||
          !unchangedDriver(identity)
        ) {
          throw new DriverSelectionError("The bound repository policy is unavailable.");
        }
        controller.builtInRepositoryDriver = identity;
      }
      controller.installationRepositoryAdmission = Object.freeze({ ...repositoryAdmission });
    }
    return controller;
  }

  readonly installation: Readonly<Installation>;
  private readonly configurations = new DriverConfigurationRegistry();
  private readonly connectionAdministration: ReturnType<typeof createConnectionAdministration>;

  private readonly sandboxPolicyOperations: ReturnType<typeof createSandboxPolicyOperations>;
  private readonly iamPolicy: IAMPolicyOperations;
  private readonly authorization?: ControllerOptions["authorize"];
  private readonly deviceLoginCipher: ReturnType<typeof deviceAuthorizationCipher> | undefined;
  private readonly clock: () => Date;
  private readonly identifier?: ControllerOptions["createId"];
  private readonly state: PlatformStateStore;
  private readonly agentAuditState: ControllerOptions["agentAuditState"];
  private readonly authority: ControllerAuthority;
  private readonly transactions: ControllerTransactions;
  private readonly requestAuditId = new AsyncLocalStorage<string>();
  private readonly shouldRecordOperations: boolean;
  private readonly nativeWorkers: NativeWorkerSupportSource | undefined;
  private readonly runtimeObservations: AgentRuntimeObservations;
  private readonly credentialProxyCapacity: CredentialProxyCapacity;
  private readonly drivers: DriverRegistry;
  private readonly pluginDiscovery: ReturnType<typeof createPluginDiscovery>;
  private tokenServiceInstance: Readonly<TokenServiceInstance> | undefined;
  private readonly preparedTokens: TokenService | undefined;
  private readonly backends: readonly BackendDefinition[];
  private readonly presets: ReturnType<
    typeof createPresetOperations<PlatformReadView, PlatformUnitOfWork>
  >;
  private readonly loggingLevel: LoggingLevel;
  private readonly backendMap: ReadonlyMap<string, BackendDefinition>;
  private readonly configuredServiceAccountDriverId: string | undefined;

  constructor(installation: Installation, options: ControllerOptions = {}) {
    this.drivers = new DriverRegistry({
      configurations: this.configurations,
      namespaceLifecycleBindings: options.namespaceLifecycleBindings ?? [],
      hasBuiltInRepositoryPolicy: () =>
        this.installationRepositoryAdmission?.policyMode === "built-in",
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
    this.sandboxPolicyOperations = createSandboxPolicyOperations({
      installationId: this.installation.id,
      ceiling: immutableCopy(options.sandboxNetworkPolicyCeiling ?? []),
      authorize: (principalId, action, target) => this.authorize(principalId, action, target),
      authorizationDecision: (principalId, action, target) =>
        this.authorizationDecision(principalId, action, target),
      exactNamespace: (state, namespaceId) => this.exactNamespace(state, namespaceId),
      lockNamespace: (state, namespaceId) => this.lockNamespace(state, namespaceId),
      read: (use) => this.read(use),
      mutate: (use) => this.mutate(use),
      protectedExecutionApplies: (state, agent, revision) =>
        this.protectedExecutionApplies(state, agent, revision),
      record: (state, operation) => this.record(state, operation),
      resolveConfiguration: (capability, driverId, scope, key) =>
        this.configurations.resolve(capability, driverId, scope, key),
      sandboxDriver: () => this.sandboxDriver(),
      selectedCompute: () => this.selectedDriver("compute"),
      timestamp: () => this.timestamp(),
    });
    for (const registration of options.driverConfigurations ?? []) {
      this.configurations.register(registration);
    }
    this.authorization = options.authorize;
    this.preparedTokens = options.preparedTokens;
    this.pluginDiscovery = createPluginDiscovery({
      read: (use) =>
        this.read((state) =>
          use({
            exactNamespace: (namespaceId) => this.exactNamespace(state, namespaceId),
            exactAgent: (namespaceId, agentId) => this.exactAgent(state, namespaceId, agentId),
            findConfiguration: (namespaceId, configurationId) =>
              state.configurations.findConfiguration(namespaceId, configurationId),
            findCredentialSource: (namespaceId, sourceId) =>
              state.credentialSources.findCredentialSource(namespaceId, sourceId),
            findSecret: (namespaceId, secretId) => state.secrets.findSecret(namespaceId, secretId),
          }),
        ),
      authorize: (principalId, action, resource) => this.authorize(principalId, action, resource),
      authorizationDecision: (principalId, action, resource) =>
        this.authorizationDecision(principalId, action, resource),
      canRead: (principalId, resource) => this.canRead(principalId, resource),
      authorizedCredentialSource: (principalId, namespaceId, sourceId) =>
        this.authorizedCredentialSource(principalId, namespaceId, sourceId),
      credentialGatewayOperation: (operation) => this.credentialGatewayOperation(operation),
      sourceReader: options.pluginSourceReader,
      secretDriver: (driverId) => this.secretDriver(driverId),
      secretOperation: (operation) => this.secretOperation(operation),
      readConfiguration: (metadata) => this.savedConfigurationReader(metadata)(),
      modelPolicyAgent: (executionMode) => this.modelPolicyAgent(executionMode),
      pluginDriver: (harnessId) => this.pluginDriver(harnessId),
      assertPluginOwner: (driver, agent) => this.pluginOwner(driver, agent),
      validatePluginPlacement: (driver, plugins, harness) =>
        this.validatePluginPlacement(driver, plugins, harness),
      harnessAuthBinding: (value) => this.harnessAuthBinding(value),
    });
    this.clock = options.now ?? (() => new Date());
    this.identifier = options.createId;
    this.state = options.state ?? new InMemoryPlatformState();
    this.transactions = createControllerTransactions({
      readSnapshot: (work) => this.state.read(work),
      runTransaction: (work) => this.state.transact(work),
      installation: this.installation,
      commitOutcomeUnknown: (error) => error instanceof PostgresCommitOutcomeUnknownError,
    });
    const authorizeOverride = this.authorization;
    this.authority = createControllerAuthority({
      selectedIAM: () => this.selectedDriver("iam"),
      authorizeOverride: authorizeOverride
        ? (request) => Reflect.apply(authorizeOverride, this, [request])
        : undefined,
    });
    this.configurationOperations = createConfigurationOperations({
      read: this.transactions.read,
      transact: this.transactions.transact,
      authorize: this.authority.authorize,
      registerRollback: (compensate) => this.registerRollback(compensate),
      holdAuthority: this.authority.holdAuthority,
      lockNamespaceForPolicyDelete: (state, principalId, target) =>
        this.lockNamespaceForPolicyDelete(state, principalId, target),
      guardProvisioningConfiguration: (state, namespaceId, id, readOnly) =>
        this.guardProvisioningConfiguration(state, namespaceId, id, readOnly),
      configurationDriver: () => this.configurationDriver(),
      validateComputeConfiguration: (values, options) =>
        this.validateComputeConfiguration(values, options),
      requireBundledChannelBindings: (values, secretBindings) =>
        this.requireBundledChannelBindings(values, secretBindings),
      ownedSecretDriver: (driverId, failure) => this.ownedSecretDriver(driverId, failure),
      bindCreator: (state, principalId, target) => this.bindCreator(state, principalId, target),
      nextIdentifier: (kind) => this.nextIdentifier(kind),
      timestamp: () => this.timestamp(),
      driverOperation: (operation) => this.driverOperation(operation),
    });
    if (options.authenticationStateEncryptionSecret) {
      this.deviceLoginCipher = deviceAuthorizationCipher(
        options.authenticationStateEncryptionSecret,
      );
    }
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
    this.agentAuditState = options.agentAuditState;
    this.shouldRecordOperations = options.recordOperations ?? true;
    this.backends = validateBackendDefinitions(options.backends ?? []);
    this.presets = createPresetOperations<PlatformReadView, PlatformUnitOfWork>(options, {
      installationId: this.installation.id,
      read: (work) => this.read(work),
      mutate: (work) => this.mutate(work),
      authorize: (principalId, action, target) => this.authorize(principalId, action, target),
      holdAuthority: (state) => this.holdAuthority(state),
      bindCreator: (state, principalId, resource) => this.bindCreator(state, principalId, resource),
      namespaceIdentity: (namespaceId) => this.namespaceIdentity(namespaceId),
      getNamespace: (principalId, namespaceId) => this.getNamespace(principalId, namespaceId),
      exactNamespace: (state, namespaceId) => this.exactNamespace(state, namespaceId),
      lockNamespace: (state, namespaceId) => this.lockNamespace(state, namespaceId),
      readablePresets: (principalId, namespaceId, rows) =>
        this.readableListRows(principalId, namespaceId, "preset", rows),
      nextPresetId: () => this.nextIdentifier("preset"),
      timestamp: () => this.timestamp(),
      configurationDriver: () => this.configurationDriver(),
      validateConfigurationContent: (values, validation) =>
        this.validateConfigurationContent(values, validation),
      validateAgentBackend: (backendId) => this.backendId(backendId),
      hasPluginDrivers: () => this.drivers.hasPluginDrivers(),
      enabledPluginDrivers: () => this.enabledPluginDrivers(),
      normalizeAgentPluginApprovers,
    });
    this.loggingLevel = normalizeLoggingLevel(options.loggingLevel);
    if (
      options.nativeWorkerSupport !== undefined &&
      options.nativeWorkerSupport !== "custom-image"
    ) {
      throw new ScopeViolationError("The native worker support declaration is invalid.");
    }
    this.nativeWorkers = nativeWorkerSupportSource(options.nativeWorkerSupport);
    const capacity = resolveCredentialProxyCapacity(
      { ...options.credentialProxyCapacity },
      "Credential Proxy capacity",
    );
    if (capacity.faults) {
      throw new RangeError(capacity.faults.map((fault) => fault.message).join(" "));
    }
    this.credentialProxyCapacity = capacity.capacity;
    this.backendMap = backendDefinitionMap(this.backends);
    if (
      options.configuredServiceAccountDriverId !== undefined &&
      !isNonEmptyString(options.configuredServiceAccountDriverId)
    ) {
      throw new ScopeViolationError("The configured ServiceAccount Driver ID is invalid.");
    }
    this.configuredServiceAccountDriverId = options.configuredServiceAccountDriverId;
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
    this.connectionAdministration = createConnectionAdministration({
      installationId: this.installation.id,
      authorizeAdministration: async (principalId) => {
        await this.authorize(principalId, "administer", {
          kind: "installation",
          id: this.installation.id,
        });
      },
      read: (work) => this.read(work),
      mutate: (work) => this.mutate(work),
      lockNamespace: (unit, namespaceId) => this.lockNamespace(unit, namespaceId),
      requireIndependentMutation: (operation) => this.requireIndependentMutation(operation),
      secretDriver: (expectedId) => this.secretDriver(expectedId),
      secretOperation: (operation) => this.secretOperation(operation),
      now: () => this.clock(),
      timestamp: () => this.timestamp(),
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
    const admission = this.installationRepositoryAdmission;
    if (admission?.policyMode === "built-in") {
      const owner = this.repositoryPermissionOwner(admission);
      if (owner === undefined) {
        throw new DriverSelectionError("The bound repository policy is unavailable.");
      }
      selected.repo = owner.driver;
    }
    validateSelectedBackendDrivers(
      this.backends,
      selected,
      this.drivers.hasSelection("credential_proxy") ? this.selectedProxyOwner() : undefined,
    );
  }

  async getInstallation(principalId: string): Promise<Readonly<Installation>> {
    await this.authorize(principalId, "read", {
      kind: "installation",
      id: this.installation.id,
    });
    return immutableCopy({ ...this.installation, capabilities: await this.capabilities() });
  }

  /**
   * The capabilities Agent creation in a Namespace needs, for a caller who may create Agents
   * there but cannot read the Installation, such as a Default user (RFC-0026). Browser access
   * is available to resource owners; guided provisioning still requires Installation administration.
   */
  async getNamespaceAgentCapabilities(
    principalId: string,
    namespaceId: string,
  ): Promise<Readonly<Omit<InstallationCapabilities, "agentProvisioning">>> {
    this.namespaceIdentity(namespaceId);
    await this.authorize(principalId, "create", { kind: "agent", namespaceId, id: namespaceId });
    await this.read((state) => this.exactNamespace(state, namespaceId));
    const { agentProvisioning: _administratorOnly, ...capabilities } = await this.capabilities();
    return immutableCopy(capabilities);
  }

  private capabilities(): Promise<InstallationCapabilities> {
    return readInstallationCapabilities(this.installation, this.nativeWorkers, {
      sandboxDriver: () => this.sandboxDriver(),
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
      enabledPluginDrivers: () => this.enabledPluginDrivers(),
    });
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
    this.authorizationAuthority(principalId);
    return this.read(async (state) => {
      const readable: Readonly<Namespace>[] = [];
      for (const namespace of await state.namespaces.listNamespaces()) {
        if (
          await this.canRead(principalId, {
            kind: "namespace",
            id: namespace.id,
            namespaceId: namespace.id,
          })
        ) {
          readable.push(namespace);
        }
      }
      return Object.freeze(readable);
    });
  }

  async getNamespace(principalId: string, namespaceId: string): Promise<Readonly<Namespace>> {
    this.namespaceIdentity(namespaceId);
    await this.authorize(principalId, "read", {
      kind: "namespace",
      id: namespaceId,
      namespaceId,
    });
    return this.read(async (state) => this.exactNamespace(state, namespaceId));
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

  private readonly agentQueries = createAgentQueries<PlatformReadView>({
    read: (query) => this.read(query),
    authorize: (principalId, action, target) => this.authorize(principalId, action, target),
    authorizationDecision: (principalId, action, target) =>
      this.authorizationDecision(principalId, action, target),
    canRead: (principalId, target) => this.canRead(principalId, target),
    namespaceIdentity: (namespaceId) => this.namespaceIdentity(namespaceId),
    getNamespace: (principalId, namespaceId) => this.getNamespace(principalId, namespaceId),
    exactNamespace: (state, namespaceId) => this.exactNamespace(state, namespaceId),
    exactAgent: (state, namespaceId, agentId) => this.exactAgent(state, namespaceId, agentId),
    readableAgents: (principalId, namespaceId, rows) =>
      this.readableListRows(principalId, namespaceId, "agent", rows),
    selectCompute: () => this.selectedDriver("compute"),
    clock: () => this.clock(),
    deploymentStatusForWork,
    deploymentErrorForWork,
    deploymentProgressForWork,
    deploymentWarningsForWork,
  });

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
    this.namespaceIdentity(namespaceId);
    if (agentId !== undefined) {
      const agent = await this.agentQueries.getAuthorizedAgent(
        principalId,
        namespaceId,
        agentId,
        "update",
      );
      if (agent.status !== "active") {
        throw new ResourceStateConflictError("The Agent does not accept repository changes.");
      }
    } else {
      await this.authorize(principalId, "create", {
        kind: "agent",
        id: namespaceId,
        namespaceId,
      });
    }
    const namespace = await this.read((state) => this.exactNamespace(state, namespaceId));
    // Checked after authorization: the conflict names the Namespace state.
    if (namespace.status !== "provisioning" && namespace.status !== "ready") {
      throw new ResourceStateConflictError("The Namespace does not accept new Agents.");
    }
    // No repository settings is a fixed Installation state, not an outage: answer no options
    // and say why, as Agent save names it (finding 2387).
    if (!this.repositoryConfigured) {
      return Object.freeze({ options: Object.freeze([]), notConfigured: true });
    }
    let compute: ComputeDriver;
    try {
      compute = this.selectedDriver("compute");
    } catch {
      throw new RepositoryOptionsUnavailableError(
        "The selected Compute Driver cannot support repository options.",
      );
    }
    if (compute.validateRepositoryCredentialSupport === undefined) {
      throw new RepositoryOptionsUnavailableError(
        "The selected Compute Driver cannot support repository options.",
      );
    }
    const sandboxDriverId = this.sandboxDriver()?.id;
    try {
      compute.validateRepositoryCredentialSupport(sandboxDriverId);
    } catch (error) {
      throw new RepositoryOptionsUnavailableError(
        error instanceof SandboxRepositoryRecipientUnverifiedError
          ? error.message
          : "The selected Compute Driver cannot support repository options with this composition.",
      );
    }
    const owner = this.repositoryPermissionOwner(this.installationRepositoryAdmission);
    if (owner === undefined) {
      throw new RepositoryOptionsUnavailableError(
        "The selected repository credential Driver is unavailable.",
      );
    }
    const { driver, admission } = owner;
    let result: RepositoryOptions;
    try {
      const input = { namespaceId: namespace.id };
      result = await (admission === undefined
        ? driver.listOptions(input)
        : admission.policy.listCatalog(input));
    } catch {
      throw new DependencyUnavailableError(
        "The selected repository credential Driver could not list repository options.",
      );
    }
    if (
      !result ||
      !Array.isArray(result.options) ||
      result.options.length > 1001 ||
      !result.options.every(validRepositoryOption) ||
      new Set(result.options.map((option) => option.repositoryRef)).size !==
        result.options.length ||
      !owner.unchanged()
    ) {
      throw new DependencyUnavailableError(
        "The selected repository credential Driver returned invalid repository options.",
      );
    }
    return immutableCopy(result);
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
    const state = this.agentAuditState;
    const driver = this.authorizationAuthority(principalId);
    const authorize = driver.authorize;
    if (
      state === undefined ||
      this.authorization !== undefined ||
      !state.supportsAuthorization(this.state, driver, authorize)
    ) {
      throw new NotImplementedError(
        "The selected State and IAM Driver do not support Agent audit.",
      );
    }
    const target = { kind: "agent", id: agentId, namespaceId } as const;
    return state.transact(this.installation.id, async (unit) => {
      await holdSession(unit);
      // An unauthorized caller cannot lock Agent or Namespace records. Recheck after
      // taking the locks so no policy change can commit between approval and disclosure.
      await this.authorize(principalId, "read_audit", target, driver, authorize);
      if (!(await state.holdResource(unit, this.installation.id, namespaceId, agentId))) {
        throw new ScopeViolationError(
          "The active Agent does not belong to the exact ready Namespace.",
        );
      }
      const decision = await this.authorize(principalId, "read_audit", target, driver, authorize);
      const entries = await state.list(unit, namespaceId, agentId, selection);
      const events = entries.slice(0, selection.limit);
      try {
        await unit.audit.append(disclosure(events.length, decision));
      } catch {
        throw new AgentAuditDisclosureUnavailableError();
      }
      await holdSession(unit);
      return { events, hasNextPage: entries.length > selection.limit };
    });
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
    if (!isNonEmptyString(namespaceId)) {
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    }
    if (!isNonEmptyString(agentId)) {
      throw new ScopeViolationError("The exact Agent identity is missing.");
    }
    await this.authorize(principalId, "read", {
      kind: "agent",
      id: agentId,
      namespaceId,
    });
    return this.read(async (state) => {
      const { namespace, agent } = await this.exactAgent(state, namespaceId, agentId);
      const driver = this.runtimeCredentialComputeDriver("status");
      return this.runtimeCredentialStatus(
        await this.runtimeCredentialOperation(() =>
          driver.getAgentRuntimeCredentialStatus!({ namespace, agent }),
        ),
      );
    });
  }

  async provisionAgentRuntimeCredentials(
    principalId: string,
    namespaceId: string,
    agentId: string,
    input: AgentRuntimeCredentialsInput,
  ): Promise<Readonly<AgentRuntimeCredentialStatus>> {
    const credentials = this.runtimeCredentialsInput(input);
    if (!isNonEmptyString(namespaceId)) {
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    }
    if (!isNonEmptyString(agentId)) {
      throw new ScopeViolationError("The exact Agent identity is missing.");
    }
    return this.mutate(async (state) => {
      const { namespace, agent, driver } = await this.admitAgentRuntimeCredentialProvisioning(
        principalId,
        namespaceId,
        agentId,
      );
      // After authorization: the provisioning reservation names the Agent's state.
      await this.guardAgentProvisioning(state, namespace.id, agent.id);
      return this.runtimeCredentialStatus(
        await this.runtimeCredentialOperation(() =>
          driver.provisionAgentRuntimeCredentials!({ namespace, agent }, credentials),
        ),
      );
    });
  }

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
    // Authorize the Namespace-level grants before reading the plan, as status and retry do: a
    // caller without them gets the same audited denial whatever the body says, and never a
    // validation answer about a Namespace they cannot provision in. A replay needs these too
    // (authorizeProvisioningRecord), so the order changes no authorized outcome.
    await this.authorizeProvisioningRequest(principalId, input.namespaceId);
    const requestId = requireProvisioningRequestId(input.requestId);
    if (!isName(input.name)) {
      throw new ScopeViolationError("The Agent name is invalid.");
    }
    let configurationInput = normalizeProvisioningConfiguration(input.configuration);
    const harnessAuth = normalizeProvisioningHarnessAuth(input.harnessAuth ?? null);
    const executionMode = input.executionMode ?? "embedded";
    if (!validExecutionMode(executionMode)) {
      throw new ScopeViolationError("The Agent Harness execution mode is invalid.");
    }
    const gatewayManagedMode = normalizeGatewayManagedMode(input.gatewayManagedMode, true);
    const backendId = this.backendId(input.backendId);
    const plugins = normalizeAgentPlugins(input.plugins);
    const pluginApprovers = normalizeAgentPluginApprovers(input.pluginApprovers);
    const workspace = normalizeProvisioningWorkspace(
      input.initialWorkspaceFiles,
      input.workspaceDefaultsId,
    );
    const compute = this.runtimeCredentialComputeDriver("provision");
    const configurationDriver = this.configurationDriver();
    if (
      compute.validateAgentProvisioning === undefined ||
      compute.getAgentRuntimeCredentialStatus === undefined ||
      configurationDriver.createExact === undefined ||
      configurationDriver.inspectExact === undefined
    ) {
      throw new DependencyUnavailableError(
        "The selected Drivers do not support Agent provisioning recovery.",
      );
    }
    // executionMode is optional and defaults to embedded; name the supported mode as a request
    // the caller can fix, before the Compute Driver refuses the plan.
    const provisioningModes = compute.agentProvisioning?.executionModes;
    if (provisioningModes !== undefined && !provisioningModes.includes(executionMode)) {
      throw new ConfigurationHarnessError(
        `Agent provisioning needs ${provisioningModes.join(" or ")} execution; this request uses ${executionMode} execution. Set executionMode.`,
      );
    }
    // A rule about the request body, checked after the Namespace grants: name it (400) instead
    // of hiding it as a scope miss.
    if (harnessAuth === null || harnessAuth.method === "runtime") {
      throw new SecretBindingValidationError(
        "Agent provisioning requires dedicated Harness authentication.",
      );
    }
    // A selected gateway owns model delivery for every dedicated Harness. Refuse
    // incompatible bindings before a job or external resource can be created.
    this.assertCredentialGatewayDelivery(harnessAuth);
    const acceptedInput = Object.freeze({
      requestId,
      namespaceId: input.namespaceId,
      name: input.name,
      configuration: configurationInput,
      ...(configurationPreparation === undefined
        ? {}
        : { configurationPreparation: configurationPreparation.key }),
      ...(workspace.initialWorkspaceFiles === undefined
        ? {}
        : { initialWorkspaceFiles: workspace.initialWorkspaceFiles }),
      ...(workspace.workspaceDefaultsId === undefined
        ? {}
        : { workspaceDefaultsId: workspace.workspaceDefaultsId }),
      ...(backendId === undefined ? {} : { backendId }),
      harnessAuth,
      executionMode,
      gatewayManagedMode,
      ...(plugins === undefined ? {} : { plugins }),
      ...(pluginApprovers === undefined ? {} : { pluginApprovers }),
      ...(input.repositoryBindings === undefined
        ? {}
        : { repositoryBindings: input.repositoryBindings }),
      ...(input.repositoryAccess === undefined ? {} : { repositoryAccess: input.repositoryAccess }),
    });
    const requestFingerprintHex = createHash("sha256")
      .update(canonicalProvisioningJson(acceptedInput))
      .digest("hex");
    // The Configuration rules Configuration save applies, for the plan's values and bindings. The
    // Configuration serves only this Agent, so its model policy refusals offer the runtimes this
    // Agent can run, as its admission's do (finding 3036).
    const validateContent = async () => {
      await configurationDriver.validateSize?.(configurationInput.values);
      this.validateConfigurationContent(
        configurationInput.values,
        undefined,
        configurationInput.secretBindings ?? {},
        this.modelPolicyAgent(executionMode),
      );
      await configurationDriver.validate({
        id: "cfg_00000000-0000-4000-8000-000000000000",
        namespaceId: input.namespaceId,
        kind: "agent",
        generation: 1,
        values: configurationInput.values,
        ...(configurationInput.secretBindings === undefined
          ? {}
          : { secretBindings: configurationInput.secretBindings }),
        createdAt: this.timestamp(),
      });
    };
    const replay = await this.read((state) =>
      state.provisioning.findByRequest(input.namespaceId, principalId, requestId),
    );
    // Reserve identity before preparing values, but expose agentId only after the Agent exists.
    // The request fingerprint covers the original input and preparation choice, so retries
    // reuse the saved plan even if Installation routing changes.
    let reservedAgentId: string | undefined;
    if (replay === undefined) {
      if (configurationPreparation !== undefined) {
        reservedAgentId = this.nextIdentifier("agent");
        configurationInput = normalizeProvisioningConfiguration({
          ...configurationInput,
          values: configurationPreparation.prepare(
            { id: reservedAgentId, namespaceId: input.namespaceId },
            configurationInput.values,
          ),
        });
      }
      // A replay is checked against the current Installation by authorizeProvisioningRecord.
      this.requireSavedHarnessAuth(
        input.namespaceId,
        compute,
        executionMode,
        harnessAuth,
        configurationInput.values,
      );
      validateComputeAgentProvisioning(compute, executionMode, configurationInput.values);
      // Reject foreign references before channel validation can report them as a scope miss.
      rejectCrossNamespaceSecretSources(
        input.namespaceId,
        configurationInput.secretBindings,
        harnessAuth,
      );
      // Before the Channel Driver, which reads only an env SecretRef: it would answer a channel
      // credential reference form these rules name (an unbound name, `$NAME`, a fallback, other
      // text) with its generic binding refusal (finding 2506). Admission repeats them below.
      await validateContent();
      await this.validateChannelCredentials(
        principalId,
        input.namespaceId,
        configurationInput,
        () => new ProvisioningSecretDriverError(),
        undefined,
        () => this.authorizeProvisioningRequest(principalId, input.namespaceId),
      );
    }
    return this.mutate(async (state) => {
      const namespace = await this.lockNamespace(state, input.namespaceId);
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      const replay = await state.provisioning.findByRequest(namespace.id, principalId, requestId);
      if (replay !== undefined) {
        if (replay.requestFingerprint !== requestFingerprintHex) {
          // The replay is keyed by this principal, so this names only the caller's own request.
          throw new ResourceStateConflictError(
            "The Agent provisioning request ID has a different plan.",
          );
        }
        await this.authorizeProvisioningRecord(state, principalId, replay);
        const work = await state.operations.findWork(replay.workId);
        const result = Object.freeze({
          provisioning: provisioningProgress(
            replay,
            work,
            this.clock(),
            await this.provisioningDeploymentProgress(state, principalId, replay, work),
          ),
        });
        if (auditEvent) {
          await state.audit.append(auditEvent(result));
        }
        return result;
      }

      const workId = `agent-provisioning:${createHash("sha256")
        .update(`${namespace.id}\0${principalId}\0${requestId}`)
        .digest("hex")
        .slice(0, 32)}`;

      await this.authorize(principalId, "create", {
        kind: "agent",
        id: namespace.id,
        namespaceId: namespace.id,
      });
      await this.authorize(principalId, "create", {
        kind: "configuration",
        id: namespace.id,
        namespaceId: namespace.id,
      });
      const driver = await this.validateAgentPlugins(
        plugins,
        pluginApprovers,
        () => configurationInput.values,
      );
      // Provisioning creates the Agent before it has tool sources. Bind the account
      // on the saved Agent after the initial install.
      await this.validatePluginCredentialSources(driver, plugins, []);
      await this.authorizeProvisioningSources(
        state,
        principalId,
        namespace.id,
        configurationInput.secretBindings,
        harnessAuth,
      );
      await validateContent();
      const { repositoryBindings, repositoryAccess } = this.repositorySettings(namespace.id, input);
      // Refuse repository bindings the topology cannot deliver, with Agent create's 409, before
      // queueing work the worker's admission would refuse (finding 1145). Unlike Agent save, a
      // Compute Driver without repository support is refused here too: deployment would be.
      // authorizeProvisioningRecord repeats this check for the stored record, after the Harness
      // authentication check; this copy also runs where no durable record can be stored.
      if (repositoryBindings !== undefined && repositoryBindings.length > 0) {
        validateRepositoryTopology(
          compute,
          {
            id: resolveConfiguredHarnessId(
              configurationInput.values,
              this.modelPolicyAgent(executionMode),
            ),
            version: "provisioning",
            mode: executionMode,
          },
          this.sandboxDriver()?.id,
        );
      }
      // Plugins the Plugin Driver cannot run in this Harness, as Agent save refuses them;
      // authorizeProvisioningRecord repeats this check for the stored record.
      if (driver) {
        this.validatePluginPlacement(driver, plugins, {
          id: resolveConfiguredHarnessId(
            configurationInput.values,
            this.modelPolicyAgent(executionMode),
          ),
          mode: executionMode,
        });
      }
      // A Codex network proxy that blocks the repository credential broker, as Agent save refuses
      // it; authorizeProvisioningRecord repeats this check for the stored record.
      if (repositoryBindings !== undefined && repositoryBindings.length > 0) {
        this.validateRepositoryBrokerNetworkProxy(
          {
            id: resolveConfiguredHarnessId(
              configurationInput.values,
              this.modelPolicyAgent(executionMode),
            ),
            mode: executionMode,
          },
          configurationInput.values,
          this.sandboxDriver(),
        );
      }
      // The worker's Agent create refuses a taken name; refuse it here instead of accepting work
      // that can only fail (finding 2420). Under the Namespace lock that Agent create also takes.
      // Like the preflight and Agent create, the 409 comes after the plan's other checks, so a
      // rename never uncovers a different refusal. A request admitted alongside with the same
      // name still fails in its job.
      await this.refuseTakenAgentName(state, namespace.id, input.name);
      const record = await state.provisioning.create(
        {
          workId,
          namespaceId: namespace.id,
          actorId: principalId,
          requestId,
          requestFingerprint: requestFingerprintHex,
          plan: {
            name: input.name,
            ...(reservedAgentId === undefined ? {} : { reservedAgentId }),
            configuration: configurationInput,
            harnessAuth,
            executionMode,
            gatewayManagedMode,
            ...(backendId === undefined ? {} : { backendId }),
            ...(plugins === undefined ? {} : { plugins }),
            ...(driver && plugins && Object.keys(plugins).length
              ? { pluginDriver: this.pluginOwner(driver) }
              : {}),
            ...(pluginApprovers === undefined ? {} : { pluginApprovers }),
            ...(repositoryBindings === undefined ? {} : { repositoryBindings }),
            ...(repositoryAccess === undefined ? {} : { repositoryAccess }),
            ...(workspace.initialWorkspaceFiles === undefined
              ? {}
              : { initialWorkspaceFiles: workspace.initialWorkspaceFiles }),
            ...(workspace.workspaceDefaultsId === undefined
              ? {}
              : { workspaceDefaultsId: workspace.workspaceDefaultsId }),
            drivers: {
              compute: compute.id,
              configuration: configurationDriver.id,
              iam: this.selectedDriver("iam").id,
            },
          },
        },
        this.requestAuditId.getStore(),
      );
      await this.authorizeProvisioningRecord(state, principalId, record.record, {
        admission: true,
      });
      await state.audit.append({
        id: `aud_${crypto.randomUUID()}`,
        installationId: this.installation.id,
        namespaceId: namespace.id,
        occurredAt: this.timestamp(),
        kind: "mutation",
        actorId: principalId,
        source: "occ",
        action: "openclaw.agents.provision",
        resource: { kind: "agent", namespaceId: namespace.id, id: namespace.id },
        outcome: "success",
        details: { workId },
      });
      const result = Object.freeze({ provisioning: provisioningProgress(record.record) });
      if (auditEvent) {
        await state.audit.append(auditEvent(result));
      }
      return result;
    });
  }

  async getAgentProvisioning(
    principalId: string,
    namespaceId: string,
    workId: string,
  ): Promise<Readonly<ProvisionAgentResult>> {
    await this.authorizeProvisioningRequest(principalId, namespaceId);
    return this.mutate(async (state) => {
      const { record, work } = await this.exactProvisioningWork(
        state,
        principalId,
        namespaceId,
        workId,
      );
      if (work === undefined) {
        throw new DependencyUnavailableError("The provisioning work is unavailable.");
      }
      return Object.freeze({
        provisioning: provisioningProgress(
          record,
          work,
          this.clock(),
          await this.provisioningDeploymentProgress(state, principalId, record, work),
        ),
      });
    });
  }

  /**
   * The initial deployment's progress for a job waiting on it after handoff (finding 1634).
   * The provisioning read does not check `agent_revision:read`, which the deployment read
   * needs, so a caller without it gets undefined and the job reports only its own deferral.
   */
  private async provisioningDeploymentProgress(
    state: PlatformReadView,
    principalId: string,
    record: Readonly<AgentProvisioningRecord>,
    work: { readonly state: string } | undefined,
  ): Promise<DeploymentStatusResult["progress"] | undefined> {
    const revisionId = record.revisionId;
    if (
      revisionId === undefined ||
      record.agentId === undefined ||
      (record.status !== "queued" && record.status !== "running") ||
      work === undefined ||
      work.state === "failed_permanent"
    ) {
      return undefined;
    }
    const key = `agent_revision:${revisionId}:reconcile`;
    const deployment = await state.operations.findWork(key);
    if (
      deployment === undefined ||
      !workMatchesRevision(deployment, {
        namespaceId: record.namespaceId,
        agentId: record.agentId,
        id: revisionId,
      }) ||
      !(await this.canRead(principalId, {
        kind: "agent_revision",
        id: revisionId,
        namespaceId: record.namespaceId,
        parentAgentId: record.agentId,
      }))
    ) {
      return undefined;
    }
    return deploymentProgressForWork(
      deployment,
      deployment.state === "queued" || deployment.state === "claimed"
        ? await state.operations.findWorkAttempt(key)
        : undefined,
    );
  }

  async retryAgentProvisioning(
    principalId: string,
    namespaceId: string,
    workId: string,
  ): Promise<Readonly<ProvisionAgentResult>> {
    await this.authorizeProvisioningRequest(principalId, namespaceId);
    return this.mutate(async (state) => {
      const namespace = await this.lockNamespace(state, namespaceId);
      const { record, work: observed } = await this.exactProvisioningWork(
        state,
        principalId,
        namespace.id,
        workId,
        "retry",
      );
      const agent =
        record.agentId === undefined
          ? undefined
          : await state.agents.lockAgent(namespace.id, record.agentId);
      if (namespace.status !== "ready") {
        throw new ResourceStateConflictError(
          "The Agent lifecycle does not allow provisioning retry.",
        );
      }
      if (
        agent !== undefined &&
        (agent.status !== "active" || agent.desiredRuntimeState !== "stopped")
      ) {
        throw new ResourceStateConflictError(
          "The Agent lifecycle does not allow provisioning retry.",
        );
      }
      if (
        record.status === "cancelled" ||
        record.revisionId !== undefined ||
        (record.agentId !== undefined &&
          (await state.revisions.listRevisionMetadata(namespaceId, record.agentId)).length !== 0)
      ) {
        throw new ResourceStateConflictError(
          "Provisioning cannot retry after cancellation or deployment handoff.",
        );
      }
      // Full admission, including the native support, plugin policy, Compute plan and Harness
      // authentication checks the status read skips.
      await this.authorizeProvisioningRecord(state, principalId, record);
      if (record.status === "queued" || record.status === "running") {
        return Object.freeze({
          provisioning: provisioningProgress(record, observed, this.clock()),
        });
      }
      const retried = await state.provisioning.retryByWorkId(namespaceId, workId, principalId);
      const requestId = this.requestAuditId.getStore();
      if (requestId !== undefined) {
        await state.audit.append({
          id: `aud_${crypto.randomUUID()}`,
          installationId: this.installation.id,
          namespaceId,
          occurredAt: this.timestamp(),
          kind: "mutation",
          actorId: principalId,
          source: "occ",
          action: CONTROLLER_WORK_AUDIT_ACTIONS.queued,
          resource:
            retried.agentId === undefined
              ? { kind: "namespace", id: namespaceId, namespaceId }
              : { kind: "agent", id: retried.agentId, namespaceId },
          outcome: "success",
          requestId,
          details: {
            workId: retried.workId,
            ...(retried.agentId === undefined ? {} : { agentId: retried.agentId }),
            reasonCode: "PROVISIONING_RETRY_REQUESTED",
          },
        });
      }
      const work = await state.operations.findWork(record.workId);
      return Object.freeze({ provisioning: provisioningProgress(retried, work, this.clock()) });
    });
  }

  private readonly provisioningWorker = createProvisioningWorker({
    installationId: () => this.installation.id,
    now: () => this.clock(),
    timestamp: () => this.timestamp(),
    nextId: (kind) => this.nextIdentifier(kind),
    transactions: {
      read: (read) => this.read(read),
      mutate: (mutate) => this.mutate(mutate),
      isCommitOutcomeUnknown: (error) => error instanceof PostgresCommitOutcomeUnknownError,
    },
    lockNamespace: (state, id) => this.lockNamespace(state, id),
    authorizeRecord: (state, principalId, record) =>
      this.authorizeProvisioningRecord(state, principalId, record),
    bindCreator: (state, principalId, resource) => this.bindCreator(state, principalId, resource),
    ensureAgentOperateGrants: (state, namespaceId, agent, sources) =>
      this.ensureAgentOperateGrants(state, namespaceId, agent, sources),
    parsePlan: (record) => this.provisioningPlan(record),
    backendId: (ref) => this.backendId(ref),
    savedAgentOptions: (namespaceId, plan) => this.provisioningSavedAgentOptions(namespaceId, plan),
    configurations: {
      hasSelection: () => this.drivers.hasSelection("configuration"),
      selected: () => this.configurationDriver(),
      run: (operation) => this.driverOperation(operation),
    },
    transport: {
      admit: (principalId, namespaceId, agentId) =>
        this.admitAgentRuntimeCredentialProvisioning(principalId, namespaceId, agentId),
      driver: () => this.runtimeCredentialComputeDriver("provision"),
      run: (operation) => this.runtimeCredentialOperation(operation),
      status: (status) => this.runtimeCredentialStatus(status),
    },
    deployment: {
      deploy: (principalId, input, resolveHarness) =>
        this.deployAgent(principalId, input, resolveHarness),
      status: controllerWorkDeploymentStatus,
      error: deploymentErrorForWork,
    },
  });

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
    const repositoryBindings = this.repositoryBindingSelections(
      namespaceId,
      plan.repositoryBindings as readonly RepositoryBindingRequest[] | undefined,
      "saved",
      this.installationRepositoryAdmission,
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

  async listUsableConnectionTemplates(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<ConnectionTemplate>[]> {
    await this.authorizeConnectionCreation(principalId, namespaceId);
    return this.read(async (state) => {
      await this.exactNamespace(state, namespaceId);
      const templates = await state.connectionTemplates.listConnectionTemplates();
      return templates.filter(
        (template) =>
          template.current.oauthClientId !== undefined &&
          (template.namespaceId === undefined || template.namespaceId === namespaceId),
      );
    });
  }

  private async authorizeConnectionCreation(
    principalId: string,
    namespaceId: string,
  ): Promise<void> {
    await this.authorize(principalId, "create", {
      kind: "credential_source",
      id: namespaceId,
      namespaceId,
    });
  }

  private async assertConnectionTemplateScope(
    templateId: string,
    namespaceId: string,
  ): Promise<void> {
    const template = await this.read((view) =>
      view.connectionTemplates.findConnectionTemplate(templateId),
    );
    if (!template || (template.namespaceId !== undefined && template.namespaceId !== namespaceId)) {
      throw new ScopeViolationError("The connection template is unavailable in this Namespace.");
    }
  }

  private async connectionClientForVersion(
    view: PlatformReadView,
    namespaceId: string,
    version: OAuthConnectionTemplateVersion,
  ) {
    const client = version.oauthClientId
      ? await view.connectionTemplates.findOAuthClient(version.oauthClientId)
      : undefined;
    if (
      !client ||
      (client.namespaceId !== undefined && client.namespaceId !== namespaceId) ||
      client.issuer !== version.issuer ||
      client.tokenUrl !== version.tokenUrl ||
      (version.revocationUrl !== undefined && client.revocationUrl !== version.revocationUrl)
    ) {
      throw new BrowserAuthorizationError("client_unavailable", "fix_configuration");
    }
    return client;
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
    const { namespaceId } = input;
    await this.authorizeConnectionCreation(principalId, namespaceId);
    return this.mutate(async (state) => {
      const namespace = await this.lockNamespace(state, namespaceId);
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      await this.authorizeConnectionCreation(principalId, namespaceId);
      this.assertConnectionTokenCustody();
      const template = await state.connectionTemplates.lockConnectionTemplate(
        input.connectionTemplateId,
      );
      if (
        !template ||
        (template.namespaceId !== undefined && template.namespaceId !== namespaceId)
      ) {
        throw new ScopeViolationError("The connection template does not exist.");
      }
      const version = template.current;
      const selectedScopes = connectionConsentScopes(version, input.selectedScopes);
      const client = await this.connectionClientForVersion(state, namespaceId, version);
      const createdAt = this.timestamp();
      const expiresAt = new Date(Date.parse(createdAt) + CONNECTION_SESSION_TTL_MS).toISOString();
      // Consent starts with one atomic reservation. There is no grant or worker provider to retire
      // if the browser closes. Only a successful exchange can hand material to the Token Service.
      const source = await state.credentialSources.createCredentialSource({
        id: this.nextIdentifier("credential_source"),
        namespaceId,
        name: `Connection ${crypto.randomUUID()}`,
        type: "oauth2-refresh-token",
        config: {
          connection_template_id: template.id,
          connection_template_version: String(version.version),
          oauth_client_id: client.id,
        },
        secrets: {},
        ownerCapability: "token_service",
        state: "registering",
        createdAt,
      });
      const started = startBrowserAuthorization(
        browserAuthorizationRequest(version, client, input.redirectUri, selectedScopes),
      );
      await state.authenticationStates.create({
        kind: "oauth_connection",
        id: createHash("sha256").update(started.state).digest("hex"),
        namespaceId,
        credentialSourceId: source.id,
        sessionId: input.sessionId,
        redirectUri: input.redirectUri,
        selectedScopes,
        pkceVerifier: started.pkceVerifier,
        issuerRequired: await state.connectionTemplates.hasOtherConnectionIssuer(version.issuer),
        actorId: principalId,
        connectionTemplateId: template.id,
        connectionTemplateVersion: version.version,
        createdAt,
        expiresAt,
      });
      if (audit) {
        await state.audit.append(audit(source.id));
      }
      return {
        credentialSourceId: source.id,
        authorizationUrl: started.authorizationUrl,
        expiresAt,
      };
    });
  }

  async expireAuthenticationStates(limit: number): Promise<void> {
    await this.mutate(async (state) => {
      const now = this.timestamp();
      for (const attempt of await state.authenticationStates.expire(now, limit)) {
        await state.credentialSources.deleteCredentialSource(
          attempt.namespaceId,
          attempt.credentialSourceId,
        );
      }
    });
  }

  async completeNamespaceConnection(
    principalId: string,
    input: CompleteNamespaceConnectionInput,
    audit?: (connection: Readonly<SavedConnection>) => AuditEvent,
    holdSession?: (unit: PlatformUnitOfWork) => Promise<void>,
  ): Promise<Readonly<SavedConnection>> {
    if (!isNonEmptyString(input.state)) {
      throw new BrowserAuthorizationError("missing_state", "retry");
    }
    const stateHash = createHash("sha256").update(input.state).digest("hex");
    const session = await this.mutate((state) =>
      state.authenticationStates.consumeOAuth(
        stateHash,
        principalId,
        input.sessionId,
        this.timestamp(),
      ),
    );
    if (!session) {
      throw new BrowserAuthorizationError("unknown_session", "retry");
    }
    const { namespaceId, credentialSourceId } = session;
    let exchangeStarted = false;
    let handoffStarted = false;
    let schedule: NonNullable<OAuthConnectionStatus["schedule"]>;
    let approved: Pick<
      SavedConnection,
      | "issuer"
      | "tokenUrl"
      | "mcpServerUrl"
      | "oauthClientId"
      | "clientId"
      | "destinations"
      | "resource"
      | "requestedScopes"
      | "grantedScopes"
    >;
    try {
      await this.authorizeConnectionCreation(principalId, namespaceId);
      await this.assertConnectionTemplateScope(session.connectionTemplateId, namespaceId);
      const version = await this.read((state) =>
        state.connectionTemplates.findOAuthConnectionTemplateVersion(
          session.connectionTemplateId,
          session.connectionTemplateVersion,
        ),
      );
      if (!version || (input.iss !== undefined && input.iss !== version.issuer)) {
        throw new BrowserAuthorizationError("issuer_mismatch", "fix_configuration");
      }
      if (input.error !== undefined || !isNonEmptyString(input.code)) {
        throw new BrowserAuthorizationError(
          input.error === "access_denied" ? "consent_denied" : "provider_error",
          "retry",
        );
      }
      // A shared redirect URI cannot identify the responding authorization server. A legacy
      // single-issuer deployment may omit iss until a second issuer has been configured.
      if (
        input.iss === undefined &&
        (session.issuerRequired ||
          (await this.read((state) =>
            state.connectionTemplates.hasOtherConnectionIssuer(version.issuer),
          )))
      ) {
        throw new BrowserAuthorizationError("issuer_required", "fix_configuration");
      }
      this.assertConnectionTokenCustody();
      const client = await this.mutate(async (view) => {
        const source = await view.credentialSources.findCredentialSource(
          namespaceId,
          credentialSourceId,
        );
        if (source?.state !== "registering" || source.ownerCapability !== "token_service") {
          throw new BrowserAuthorizationError("invalid_session", "retry");
        }
        const registration = await this.connectionClientForVersion(view, namespaceId, version);
        await holdSession?.(view);
        return registration;
      });
      const request = browserAuthorizationRequest(
        version,
        client,
        session.redirectUri,
        session.selectedScopes,
      );
      const signal = AbortSignal.timeout(CONNECTION_OPERATION_TIMEOUT_MS);
      const code = input.code;
      const grant = await this.withOAuthClientSecret(client, async (clientSecret) => {
        signal.throwIfAborted();
        exchangeStarted = true;
        return exchangeAuthorizationCode(request, session.pkceVerifier, code, clientSecret, signal);
      });
      handoffStarted = true;
      schedule = await this.acceptConnectionTokens(
        {
          kind: "oauth_refresh_token",
          namespaceId,
          sourceId: credentialSourceId,
          approval: {
            connectionTemplateId: session.connectionTemplateId,
            connectionTemplateVersion: session.connectionTemplateVersion,
            oauthClientId: client.id,
          },
          grant,
        },
        signal,
        holdSession,
      );
      approved = {
        issuer: version.issuer,
        tokenUrl: version.tokenUrl,
        oauthClientId: client.id,
        clientId: client.clientId,
        destinations: version.destinations,
        ...(version.mcp
          ? { resource: version.mcp.resource, mcpServerUrl: version.mcp.serverUrl }
          : {}),
        requestedScopes: session.selectedScopes,
        grantedScopes: grant.grantedScopes,
      };
    } catch (error) {
      // A network timeout may have spent the code. Keep the pending source for explicit
      // retirement; never retry that exchange. Definite refusals have no material to retire.
      if (!exchangeStarted || (!handoffStarted && error instanceof BrowserAuthorizationError)) {
        await this.mutate((state) =>
          state.credentialSources.deleteCredentialSource(namespaceId, credentialSourceId),
        );
      }
      throw error;
    }
    try {
      return await this.mutate(async (state) => {
        await holdSession?.(state);
        await this.holdAuthority(state);
        await this.lockNamespace(state, namespaceId);
        await this.authorizeConnectionCreation(principalId, namespaceId);
        await this.assertConnectionTemplateScope(session.connectionTemplateId, namespaceId);
        await this.grantConnectionOwner(state, namespaceId, principalId, credentialSourceId);
        const ready = await state.credentialSources.markCredentialSourceReady(
          namespaceId,
          credentialSourceId,
        );
        if (!ready) {
          throw new ResourceStateConflictError("The pending connection changed. Connect again.");
        }
        await state.savedConnections.recordTokenSchedule(namespaceId, credentialSourceId, {
          scheduledVersion: schedule.version,
          nextRefreshAt: schedule.nextRefreshAt,
          grantedScopes: schedule.grantedScopes,
        });
        const connection = await state.savedConnections.createSavedConnection({
          ...approved,
          namespaceId,
          credentialSourceId,
          ownerPrincipalId: principalId,
          connectionTemplateId: session.connectionTemplateId,
          connectionTemplateVersion: session.connectionTemplateVersion,
          createdAt: this.timestamp(),
        });
        if (audit) {
          await state.audit.append(audit(connection));
        }
        return connection;
      });
    } catch (error) {
      // The Token Service holds the grant. A commit with an uncertain
      // outcome is safe to retry: the internal pending-source delete refuses a ready account.
      await this.deleteCredentialSource(
        principalId,
        namespaceId,
        credentialSourceId,
        undefined,
        PENDING_CONNECTION,
      ).catch(() => undefined);
      throw error;
    }
  }

  async listNamespaceConnections(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<SavedConnection>[]> {
    await this.authorize(principalId, "read", { kind: "namespace", id: namespaceId, namespaceId });
    return this.read(async (state) => {
      const connections = await state.savedConnections.listNamespaceConnections(namespaceId);
      const visible: Readonly<SavedConnection>[] = [];
      for (const connection of connections) {
        if (
          await this.canRead(principalId, {
            kind: "credential_source",
            namespaceId,
            id: connection.credentialSourceId,
          })
        ) {
          visible.push({
            ...connection,
            destinations: await this.effectiveConnectionDestinations(state, connection),
          });
        }
      }
      return visible;
    });
  }

  private async effectiveConnectionDestinations(
    state: PlatformReadView,
    account: Readonly<SavedConnection>,
  ): Promise<SavedConnection["destinations"]> {
    const template = await state.connectionTemplates.findConnectionTemplate(
      account.connectionTemplateId,
    );
    if (!template || template.current.issuer !== account.issuer) {
      return [];
    }
    if (template.current.mode === "manual") {
      return account.mcpServerUrl === undefined && account.resource === undefined
        ? template.current.destinations
        : [];
    }
    if (
      !account.mcpServerUrl ||
      !account.resource ||
      template.current.mcp?.serverUrl !== account.mcpServerUrl ||
      template.current.mcp?.resource !== account.resource
    ) {
      return [];
    }
    return account.destinations;
  }

  private async grantConnectionOwner(
    state: PlatformUnitOfWork,
    namespaceId: string,
    principalId: string,
    sourceId: string,
  ): Promise<void> {
    const driver = this.iamPolicyDriver("createNamespaceAccessBinding");
    if (driver.namespacePolicyTransaction !== "platform-unit-of-work") {
      throw new DependencyUnavailableError(
        "The IAM Driver cannot grant connection access transactionally.",
      );
    }
    const roleId = `role_${namespaceId}_connection_owner`;
    const permissions: readonly Permission[] = [
      { resourceKind: "credential_source", action: "read" },
      { resourceKind: "credential_source", action: "operate" },
    ];
    const role = await state.iamPolicy.getRole(namespaceId, roleId);
    if (role === undefined) {
      const roleDriver = this.iamPolicyDriver("createNamespaceRole");
      await this.iamPolicyOperation(() =>
        roleDriver.createNamespaceRole!(
          { policy: state.iamPolicy },
          { id: roleId, namespaceId, name: "Connected account owner", permissions },
        ),
      );
    } else if (
      role.namespaceId !== namespaceId ||
      role.permissions.length !== permissions.length ||
      !permissions.every((required) =>
        role.permissions.some((existing) => isDeepStrictEqual(existing, required)),
      )
    ) {
      throw new ResourceConflictError(
        "The connected account owner Role requires exactly credential source read and operate.",
      );
    }
    await this.iamPolicyOperation(() =>
      driver.createNamespaceAccessBinding!(
        { policy: state.iamPolicy },
        {
          id: `binding_${sourceId}_connection_owner`,
          namespaceId,
          subjectKind: "identity",
          subjectId: principalId,
          roleId,
          resourceKind: "credential_source",
          resourceId: sourceId,
        },
      ),
    );
  }

  async disconnectNamespaceConnection(
    principalId: string,
    namespaceId: string,
    sourceId: string,
    audit?: AuditEvent,
  ): Promise<void> {
    await this.mutate(async (state) => {
      await this.lockNamespace(state, namespaceId);
      const connection = await state.savedConnections.findSavedConnection(namespaceId, sourceId);
      if (connection?.ownerPrincipalId !== principalId) {
        await this.authorize(principalId, "delete", {
          kind: "credential_source",
          namespaceId,
          id: sourceId,
        });
      }
      if (!connection) {
        throw new ScopeViolationError("The Namespace has no such connection.");
      }
      if (connection.revocationRequestedBy !== undefined) {
        return;
      }
      const source = await state.credentialSources.lockCredentialSource(namespaceId, sourceId);
      if (!source) {
        throw new ScopeViolationError("The connected source no longer exists.");
      }
      if (
        source.state !== "deleting" &&
        !(await state.credentialSources.markCredentialSourceDeleting(namespaceId, sourceId))
      ) {
        throw new ResourceStateConflictError("The connected source changed during revocation.");
      }
      await state.savedConnections.requestConnectionRevocation(namespaceId, sourceId, principalId);
      if (audit) {
        await state.audit.append(audit);
      }
    });
    await this.finishConnectionRevocation(namespaceId, sourceId);
  }

  async finishConnectionRevocation(namespaceId: string, sourceId: string): Promise<void> {
    const pending = await this.read(async (state) => {
      const account = await state.savedConnections.findSavedConnection(namespaceId, sourceId);
      if (account?.revocationRequestedBy === undefined) {
        return undefined;
      }
      const source = await state.credentialSources.findCredentialSource(namespaceId, sourceId);
      if (source?.state !== "deleting") {
        throw new ResourceStateConflictError("The connected source has no pending retirement.");
      }
      return { account, source, namespace: await this.exactNamespace(state, namespaceId) };
    });
    if (!pending) {
      return;
    }
    if (pending.account.revokedAt === undefined) {
      await this.retireCredentialSourceMaterial(pending.namespace, pending.source, undefined);
    }
    await this.mutate(async (state) => {
      await this.lockNamespace(state, namespaceId);
      const account = await state.savedConnections.findSavedConnection(namespaceId, sourceId);
      if (account?.revocationRequestedBy === undefined) {
        return;
      }
      if (!account.revokedAt) {
        await state.savedConnections.confirmConnectionRevocation(
          namespaceId,
          sourceId,
          this.timestamp(),
        );
      }
      if (await state.credentialSources.hasReferences(namespaceId, sourceId)) {
        return;
      }
      await state.credentialSources.deleteCredentialSource(namespaceId, sourceId);
    });
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

  private async acceptConnectionTokens(
    registration: OAuthRefreshTokenRegistration,
    signal: AbortSignal,
    holdSession?: (unit: PlatformUnitOfWork) => Promise<void>,
  ) {
    const issuer = this.connectionTokenIssuer();
    if (holdSession) {
      await this.mutate(holdSession);
    }
    const reference = await this.tokenService().register(registration, signal);
    const { schedule } = await issuer.status(reference, signal);
    if (!schedule) {
      throw new ResourceStateConflictError(
        "No eligible access token is prepared for this account.",
      );
    }
    return schedule;
  }

  /** Used by the installed Token Service to authenticate the original client on each renewal. */
  async resolveConnectionClient(
    { namespaceId, sourceId }: OAuthAccountRef,
    approval?: OAuthRefreshTokenRegistration["approval"],
  ): Promise<OAuthConnectionClient> {
    return this.read(async (view) => {
      let pinned = approval;
      if (pinned) {
        // Only the pending source that started consent can receive this grant. Another valid
        // template can select the same OAuth client but authorize a different resource.
        const source = await view.credentialSources.findCredentialSource(namespaceId, sourceId);
        if (
          source?.ownerCapability !== "token_service" ||
          source.state !== "registering" ||
          source.config.connection_template_id !== pinned.connectionTemplateId ||
          source.config.connection_template_version !== String(pinned.connectionTemplateVersion) ||
          source.config.oauth_client_id !== pinned.oauthClientId
        ) {
          throw new BrowserAuthorizationError("client_registration_mismatch", "fix_configuration");
        }
      } else {
        const saved = await view.savedConnections.findSavedConnection(namespaceId, sourceId);
        if (!saved || saved.revocationRequestedBy) {
          throw new BrowserAuthorizationError("client_unavailable", "fix_configuration");
        }
        pinned = saved;
      }
      const version = await view.connectionTemplates.findOAuthConnectionTemplateVersion(
        pinned.connectionTemplateId,
        pinned.connectionTemplateVersion,
      );
      if (!version || version.oauthClientId !== pinned.oauthClientId) {
        throw new BrowserAuthorizationError("client_unavailable", "fix_configuration");
      }
      const client = await this.connectionClientForVersion(view, namespaceId, version);
      return {
        registration: {
          oauthClientId: client.id,
          issuer: client.issuer,
          clientId: client.clientId,
          tokenUrl: client.tokenUrl,
          tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
          ...(version.mcp && { resource: version.mcp.resource }),
        },
        ...(client.tokenEndpointAuthMethod !== "none" && {
          readSecret: (signal: AbortSignal) =>
            this.withOAuthClientSecret(client, async (value) => {
              signal.throwIfAborted();
              if (value === undefined) {
                throw new BrowserAuthorizationError("client_unavailable", "fix_configuration");
              }
              return value;
            }),
        }),
      };
    });
  }

  maintainConnectionToken(namespaceId: string, sourceId: string) {
    return this.connectionTokenIssuer().maintain(
      { kind: "oauth_refresh_token", namespaceId, sourceId },
      AbortSignal.timeout(CONNECTION_OPERATION_TIMEOUT_MS),
    );
  }

  private assertConnectionTokenCustody(): void {
    this.connectionTokenIssuer();
    const secrets = this.secretDriver();
    if (!secrets.withValue || !secrets.compareAndSwap) {
      throw new NotImplementedError(
        "connection_templates",
        "The selected Secret Driver cannot store an OAuth grant.",
      );
    }
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

  async createNamespace(
    principalId: string,
    input: CreateNamespaceInput,
  ): Promise<Readonly<Namespace>> {
    if (!isName(input.name)) {
      throw new ScopeViolationError("The Namespace name is invalid.");
    }
    return this.mutate(async (state) => {
      await this.holdAuthority(state);
      const target: ResourceRef = {
        kind: "namespace",
        id: this.installation.id,
      };
      await this.authorize(principalId, "create", target);
      if (input.existingNamespace !== undefined) {
        await this.authorize(principalId, "administer", {
          kind: "installation",
          id: this.installation.id,
        });
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
      const namespace = await state.namespaces.createNamespace({
        id: this.nextIdentifier("namespace"),
        name: input.name,
        ...(input.existingNamespace === undefined
          ? {}
          : { existingNamespace: input.existingNamespace }),
        status: "provisioning",
        createdAt: this.timestamp(),
      });
      // The creator's Namespace-wide Owner grant lets the same unit create the default Presets.
      await this.bindCreator(state, principalId, {
        kind: "namespace",
        id: namespace.id,
        namespaceId: namespace.id,
      });
      // Configured Group bindings that name this Namespace, such as Agent creation in default.
      await this.applyConfiguredPolicy(state, principalId, namespace);
      await this.presets.ensureNamespaceDefaultPresets(state, principalId, namespace);
      await this.record(state, {
        kind: "namespace",
        action: "reconcile",
        target: "ready",
        namespaceId: namespace.id,
        resourceId: namespace.id,
        actorId: principalId,
      });
      return namespace;
    });
  }

  private occBindingDriver(
    method: "createOwnerBinding" | "applyConfiguredPolicy" | "createNamespaceAccessBinding",
  ): IAMDriver | undefined {
    return this.iamPolicy.occBindingDriver(method);
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
    return this.requestAuditId.run(requestId, work);
  }

  private holdAuthority(state: PlatformUnitOfWork): Promise<void> {
    return this.authority.holdAuthority(state);
  }

  private bindCreator(
    state: PlatformUnitOfWork,
    principalId: string,
    resource: ResourceRef & { readonly namespaceId: string },
  ): Promise<void> {
    return this.iamPolicy.bindCreator(state, principalId, resource);
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

  /**
   * The Configuration content rules every write runs, in one order, so a value one refuses is
   * refused, with the same message, wherever it is written: Configuration create and update,
   * Agent provisioning and Preset defaults (finding 1311). A Preset save passes `options`,
   * locating its unfilled variables. The model provider settings; the Codex approval policy and
   * a literal Gateway password; the agents shape, fallback provider and Gateway roster rules
   * (findings 1305 and 1308); then the selected Compute Driver's rules. A write that saves Secret
   * bindings with the values passes them: on the bundled Kubernetes Compute, which delivers
   * channel credentials only from bindings, a channel credential reference without one is then
   * refused with the rule its deployment admission applies (finding 2319). Agent provisioning,
   * whose Configuration serves only the new Agent, passes that `agent` for the model policy
   * refusals' offers (finding 3036).
   */
  private validateConfigurationContent(
    values: OpenClawConfigurationDocument,
    options?: ConfigurationValidationOptions,
    secretBindings?: SecretBindings,
    agent?: ModelPolicyAgent,
  ): void {
    return this.configurationOperations.validateConfigurationContent(
      values,
      options,
      secretBindings,
      agent,
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

  private readonly secretOperations = createSecretOperations(() => this.installation.id, {
    read: (work) => this.read(work),
    mutate: (work) => this.mutate(work),
    authorize: (principalId, action, target) => this.authorize(principalId, action, target),
    canRead: (principalId, target) => this.canRead(principalId, target),
    authorizationDecision: (principalId, action, target) =>
      this.authorizationDecision(principalId, action, target),
    holdAuthority: (state) => this.holdAuthority(state),
    bindCreator: (state, principalId, target) => this.bindCreator(state, principalId, target),
    namespaceIdentity: (namespaceId) => this.namespaceIdentity(namespaceId),
    getNamespace: (principalId, namespaceId) => this.getNamespace(principalId, namespaceId),
    exactNamespace: (state, namespaceId) => this.exactNamespace(state, namespaceId),
    lockNamespace: (state, namespaceId) => this.lockNamespace(state, namespaceId),
    lockNamespaceForPolicyDelete: (state, principalId, target) =>
      this.lockNamespaceForPolicyDelete(state, principalId, target),
    secretDriver: () => this.secretDriver(),
    ownedSecretDriver: (driverId, failure) => this.ownedSecretDriver(driverId, failure),
    nextIdentifier: (kind) => this.nextIdentifier(kind),
    timestamp: () => this.timestamp(),
    registerRollback: (compensate) => this.registerRollback(compensate),
    provisioningPlan: (record) => this.provisioningPlan(record),
  });

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
      {
        exchangeOwner,
        now: () => this.clock().getTime(),
        installation: (peer) =>
          this.state.read((state) =>
            state.credentialSources.findEgressInstallation(peer.sender.id, peer.sandboxId),
          ),
        provider: (route) => {
          const control = this.selectedDriver("credential_proxy").sourceControl;
          if (!isDeepStrictEqual(control.backend, route.binding.source.backend)) {
            return undefined;
          }
          return registeredCredentialProvider(control.providers, route.binding.source.provider);
        },
        classificationRefused: async (use, rule) => {
          const execution = use.route.binding.execution;
          if (
            this.transactions.hasContext() ||
            execution.installationId !== this.installation.id ||
            !isDeepStrictEqual(execution, use.installation.plan.execution)
          ) {
            throw new DependencyUnavailableError("Classification audit scope is unavailable.");
          }
          await this.transact((state) =>
            this.denyEgressUse(state, use, "unsupported_operation", undefined, undefined, rule),
          );
        },
        check: (use, material, stream, provider) =>
          this.checkEgressUse(use, material, stream, provider),
        read: async (source, lifetime, isProviderCurrent) => {
          const owner = this.selectedProxyOwner();
          const control = owner.require("credential_proxy").sourceControl;
          const secret = await this.state.read((state) =>
            state.secrets.findSecret(source.secret.namespaceId, source.secret.id),
          );
          if (lifetime.signal.aborted || !secret || secret.driverId !== source.secretDriver.id) {
            throw new DependencyUnavailableError("Selected credential material is unavailable.");
          }
          const driver = this.secretDriver(secret.driverId);
          if (!driver.readCredentialInput) {
            throw new DependencyUnavailableError("Versioned credential reading is unavailable.");
          }
          if (
            this.selectedProxyOwner() !== owner ||
            owner.require("credential_proxy").sourceControl !== control ||
            !isDeepStrictEqual(control.backend, source.key.backend) ||
            !isDeepStrictEqual(control.sender, source.sender) ||
            !isDeepStrictEqual(control.resolver, source.resolver) ||
            !isProviderCurrent()
          ) {
            throw new DependencyUnavailableError("Selected credential provider changed.");
          }
          return {
            ...(await driver.readCredentialInput({ secret, lifetime, retention: "none" })),
            materialId: secret.backendRef.uid,
          };
        },
        resolvePrepared: (key, options) =>
          this.tokenService().resolve(
            { kind: this.preparedIssuer(key.provider).tokenKind, key },
            options,
          ),
        authorizeSend: async (use, source, attempt, mintAuthorization, provider) => {
          if (this.transactions.hasContext()) {
            return { kind: "unavailable", code: "authority" };
          }
          const material = attempt.material;
          if (!material) {
            return { kind: "denied", code: "scope_mismatch" };
          }
          const execution = use.route.binding.execution;
          const deny = (code: Extract<EgressRefusal, { kind: "denied" }>["code"]) =>
            this.transact((state) => this.denyEgressUse(state, use, code, material));
          const driver = this.selectedDriver("credential_proxy");
          const verify = driver.verifyInstallation;
          const { compute, resolve } = this.credentialPlacement();
          // No policy/source locks and no one-second permit during trusted runtime I/O.
          const runtime = await this.state.read(async (state) => ({
            namespace: await state.namespaces.findNamespace(execution.namespaceId),
            revision: await state.revisions.findRevision(
              execution.namespaceId,
              execution.agentId,
              execution.revisionId,
            ),
            installed: await state.credentialSources.findEgressInstallation(
              use.peer.sender.id,
              use.peer.sandboxId,
            ),
          }));
          const remaining = Date.parse(use.request.deadlineAt) - this.clock().getTime();
          if (remaining <= 0) {
            return { kind: "deadline_exceeded" };
          }
          if (
            !runtime.namespace ||
            !runtime.revision ||
            !isDeepStrictEqual(runtime.installed, use.installation)
          ) {
            return deny("stale_configuration");
          }
          const { namespace, revision } = runtime;
          const verified = await Reflect.apply(verify, driver, [
            {
              namespace: await this.credentialGatewayOperation(() =>
                Reflect.apply(resolve, compute, [namespace]),
              ),
              revision,
              plan: use.installation.plan,
              signal: AbortSignal.timeout(Math.ceil(remaining)),
            },
            use.installation,
          ]);
          if (verified !== true) {
            return verified === false
              ? deny("stale_configuration")
              : { kind: "unavailable", code: "authority" };
          }
          const authority = this.authorizationAuthority(execution.servicePrincipalId);
          const authorize = authority.authorize;
          const decide = () =>
            this.authorizationDecision(
              execution.servicePrincipalId,
              "operate",
              {
                kind: "credential_source",
                namespaceId: execution.namespaceId,
                id: use.route.binding.source.source.id,
              },
              authority,
              authorize,
            );
          const native =
            !this.authorization &&
            NativeIAMDriver.usesStateForAuthorization(authority, authorize, this.state);
          const observed = native ? undefined : await decide();
          if (observed && !observed.decision.allowed) {
            return deny("unauthorized");
          }
          return this.transact(async (state) => {
            await this.lockNamespace(state, execution.namespaceId);
            const decision = observed ?? (await decide());
            await state.agents.lockAgent(execution.namespaceId, execution.agentId);
            const current = await this.checkEgressUseIn(
              state,
              use,
              material,
              undefined,
              { namespace, revision, decision: decision.decision },
              provider,
            );
            if (!("key" in current)) {
              return current;
            }
            if (
              !isDeepStrictEqual(current, source) ||
              this.selectedDriver("credential_proxy") !== driver ||
              driver.verifyInstallation !== verify ||
              this.selectedDriver("compute") !== compute ||
              compute.resolveSandboxNamespace !== resolve ||
              this.authorizationAuthority(execution.servicePrincipalId) !== authority ||
              authority.authorize !== authorize ||
              !provider.isCurrent()
            ) {
              return this.denyEgressUse(state, use, "stale_configuration", material);
            }
            const authorization = mintAuthorization();
            if ("kind" in authorization) {
              return authorization;
            }
            return EgressSendReceipts.authorizeIn(
              state.egressSendReceipts,
              use.peer.sender,
              attempt,
              authorization,
            );
          });
        },
        receipts: new EgressSendReceipts(this.state),
      },
      this.credentialProxyCapacity,
    );
  }

  private async checkEgressUse(
    use: CapturedEgressUse,
    material?: EgressSelectionEvidence,
    stream?: { readonly until: string },
    provider?: ExchangeProvider,
  ): Promise<ProtectedEgressSource | EgressRefusal> {
    // Never borrow an enclosing controller/IAM snapshot. The two RPCs each establish a new
    // platform unit and the native IAM Driver loads policy within that exact fresh unit.
    if (this.transactions.hasContext()) {
      return { kind: "unavailable", code: "authority" };
    }
    return this.transact((state) =>
      this.checkEgressUseIn(state, use, material, stream, undefined, provider),
    );
  }

  private async denyEgressUse(
    state: PlatformUnitOfWork,
    use: Pick<CapturedEgressUse, "id" | "route">,
    code: Extract<EgressRefusal, { kind: "denied" }>["code"],
    material?: EgressSelectionEvidence,
    stream?: { readonly until: string },
    classificationRule?: number,
  ): Promise<EgressRefusal> {
    const execution = use.route.binding.execution;
    await state.audit.append({
      id: `aud_${crypto.randomUUID()}`,
      installationId: this.installation.id,
      namespaceId: execution.namespaceId,
      occurredAt: this.timestamp(),
      kind: "authorization_denial",
      actorId: execution.servicePrincipalId,
      source: "occ",
      action: "openclaw.egress.authorize",
      resource: {
        kind: "credential_source",
        namespaceId: execution.namespaceId,
        id: use.route.binding.source.source.id,
      },
      outcome: "denied",
      details: {
        code,
        phase: stream
          ? "during_response"
          : material === undefined
            ? "before_access"
            : "before_send",
        requestId: use.id,
        revisionId: execution.revisionId,
        ...(classificationRule === undefined ? {} : { classificationRule }),
      },
    });
    return { kind: "denied", code };
  }

  private async checkEgressUseIn(
    state: PlatformUnitOfWork,
    use: CapturedEgressUse,
    material?: EgressSelectionEvidence,
    stream?: { readonly until: string },
    finalCheck?: {
      readonly namespace: Readonly<Namespace>;
      readonly revision: Readonly<AgentRevision>;
      readonly decision: AuthorizationDecision;
    },
    selectedProvider?: ExchangeProvider,
  ): Promise<ProtectedEgressSource | EgressRefusal> {
    const execution = use.route.binding.execution;
    const target = {
      kind: "credential_source" as const,
      namespaceId: execution.namespaceId,
      id: use.route.binding.source.source.id,
    };
    const deny = (code: Extract<EgressRefusal, { kind: "denied" }>["code"]) =>
      this.denyEgressUse(state, use, code, material, stream);
    if (
      execution.installationId !== this.installation.id ||
      !isDeepStrictEqual(execution, use.installation.plan.execution)
    ) {
      return deny("scope_mismatch");
    }
    const namespace = await state.namespaces.findNamespace(execution.namespaceId);
    const agent = await state.agents.findAgent(execution.namespaceId, execution.agentId);
    const revision = await state.revisions.findRevision(
      execution.namespaceId,
      execution.agentId,
      execution.revisionId,
    );
    const installed = await state.credentialSources.findEgressInstallation(
      use.peer.sender.id,
      use.peer.sandboxId,
    );
    if (
      !namespace ||
      namespace.status !== "ready" ||
      !agent ||
      agent.status !== "active" ||
      agent.desiredRuntimeState !== "running" ||
      agent.servicePrincipalId !== execution.servicePrincipalId ||
      !revision ||
      !isReducedCredentialPlan(revision.egressPlan, use.installation.plan) ||
      !isDeepStrictEqual(installed, use.installation)
    ) {
      return deny("withdrawn");
    }
    // A provisioned revision may probe before activation. It must still be the newest
    // admitted running revision; an older or superseded execution cannot keep using egress.
    if (
      agent.activeRevisionId !== execution.revisionId &&
      (await state.revisions.listRevisionMetadata(execution.namespaceId, execution.agentId)).at(-1)
        ?.id !== execution.revisionId
    ) {
      return deny("withdrawn");
    }
    const source = await state.credentialSources.lockCredentialSource(
      execution.namespaceId,
      target.id,
    );
    const withdrawal = await state.credentialSources.findCredentialWithdrawal(
      execution.namespaceId,
      execution.revisionId,
      target.id,
    );
    if (!source || source.state !== "ready" || withdrawal !== undefined) {
      return deny("withdrawn");
    }
    const admitted = source.egress;
    const driver = this.selectedDriver("credential_proxy");
    const control = driver.sourceControl;
    if (
      !admitted ||
      !this.currentCredentialSourceOwner(source, revision) ||
      !this.selectedProxyOwner().ownsProxyPlan(use.installation.plan) ||
      (use.installation.plan.policyReductionVersion !== undefined &&
        driver.policyReduction?.version !== use.installation.plan.policyReductionVersion) ||
      !isDeepStrictEqual(admitted.key, use.route.binding.source) ||
      !isDeepStrictEqual(admitted.key.backend, control.backend) ||
      !isDeepStrictEqual(admitted.sender, use.peer.sender) ||
      !isDeepStrictEqual(admitted.resolver, control.resolver) ||
      !isDeepStrictEqual(admitted.sender, control.sender)
    ) {
      return deny("stale_configuration");
    }
    // A leased response stream is bounded by its lease, not the operation deadline.
    const remaining = Date.parse(stream?.until ?? use.request.deadlineAt) - this.clock().getTime();
    if (remaining <= 0) {
      return { kind: "deadline_exceeded" };
    }
    // A stored installation is an immutable association, not a readiness lease.
    // The selected adapter rechecks the current authenticated runtime at both checks.
    if (
      finalCheck
        ? !isDeepStrictEqual(finalCheck.namespace, namespace) ||
          !isDeepStrictEqual(finalCheck.revision, revision)
        : !(await driver.verifyInstallation(
            {
              namespace: await this.credentialNamespace(namespace),
              revision,
              plan: use.installation.plan,
              signal: AbortSignal.timeout(Math.ceil(remaining)),
            },
            use.installation,
          ))
    ) {
      return deny("stale_configuration");
    }
    if (!selectedProvider?.isCurrent()) {
      return deny("stale_configuration");
    }
    const provider = selectedProvider.receiver;
    if (!matchesAdmittedSourceType(source, provider)) {
      return deny("stale_configuration");
    }
    try {
      const routes = Reflect.apply(selectedProvider.methods.routes, provider, [
        source,
        use.route.binding,
        revision.harness.configuration,
      ]);
      if (!routes.some((route) => isDeepStrictEqual(route, use.route))) {
        return deny("stale_configuration");
      }
    } catch {
      return deny("stale_configuration");
    }
    if (
      !isDeepStrictEqual(
        Reflect.apply(selectedProvider.methods.classify, provider, [use.route, use.request]),
        use.operation,
      ) ||
      !selectedProvider.isCurrent() ||
      !use.installation.plan.routes.some((route) => isDeepStrictEqual(route, use.route))
    ) {
      return deny("unsupported_operation");
    }
    try {
      if (finalCheck) {
        if (!finalCheck.decision.allowed) {
          return deny("unauthorized");
        }
      } else {
        await this.authorize(execution.servicePrincipalId, "operate", target);
      }
    } catch (error) {
      if (error instanceof AuthorizationDeniedError) {
        return deny("unauthorized");
      }
      throw error;
    }
    if (admitted.adoption === "credential_free") {
      const { binding } = use.route;
      if (
        use.operation.kind !== "credential_free_repository_metadata" ||
        !matchesCredentialFreeMetadataGrant(source, use.route) ||
        (material !== undefined &&
          !isDeepStrictEqual(material, {
            kind: "no_material_required",
            source: binding.source,
            binding: binding.binding,
            grantHash: binding.grantHash,
            isolationId: binding.isolationId,
          }))
      ) {
        return deny("scope_mismatch");
      }
      return admitted;
    }
    if (material?.kind === "no_material_required") {
      return deny("scope_mismatch");
    }
    if (admitted.adoption === "prepared") {
      const lifecycle = this.preparedTokens?.issuer(admitted.key.provider);
      if (!selectedProvider.isCurrent()) {
        return deny("stale_configuration");
      }
      const grant = Reflect.apply(selectedProvider.methods.normalizeGrant, provider, [
        [],
        source.config,
      ]);
      if (
        !lifecycle ||
        !isDeepStrictEqual(admitted, lifecycle.sourceFromRoute(use.route, control)) ||
        use.route.binding.grantHash !==
          createHash("sha256").update(JSON.stringify(grant)).digest("hex")
      ) {
        return deny("scope_mismatch");
      }
      if (material !== undefined) {
        const left = Date.parse(use.request.deadlineAt) - this.clock().getTime();
        if (
          material.kind !== (admitted.schemaVersion === 2 ? "prepared_github" : "prepared_token") ||
          left <= 0 ||
          material.grantHash !== use.route.binding.grantHash ||
          material.isolationId !== execution.agentId ||
          !isDeepStrictEqual(material.source, admitted.key) ||
          !isDeepStrictEqual(material.binding, use.route.binding.binding) ||
          (await state.credentialSources.isEgressMaterialRejected(material)) ||
          !(await state.preparedTokenProof.current(admitted, material, lifecycle.issuerAuthority, {
            signal: AbortSignal.timeout(Math.ceil(left)),
            deadlineAt: use.request.deadlineAt,
          }))
        ) {
          // Withdrawal was checked under the source lock. This selection could not be proved current.
          return deny("stale_configuration");
        }
      }
      return admitted;
    }
    if (material !== undefined) {
      const secret = await state.secrets.findSecret(
        admitted.secret.namespaceId,
        admitted.secret.id,
      );
      if (
        material.kind !== "static" ||
        !secret ||
        secret.driverId !== admitted.secretDriver.id ||
        secret.backendRef.uid !== material.materialId ||
        !isDeepStrictEqual(material.source, admitted.key) ||
        !isDeepStrictEqual(material.binding, use.route.binding.binding) ||
        !isDeepStrictEqual(material.secret, admitted.secret) ||
        !isDeepStrictEqual(material.secretDriver, admitted.secretDriver) ||
        material.adoption !== admitted.adoption ||
        material.materialRefId !== admitted.materialRefId ||
        material.grantHash !== use.route.binding.grantHash ||
        material.isolationId !== use.route.binding.isolationId ||
        material.retention !== "none" ||
        Date.parse(material.usableUntil) <= this.clock().getTime() ||
        (await state.credentialSources.isEgressMaterialRejected(material))
      ) {
        return deny("withdrawn");
      }
    }
    return admitted;
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

  private async admitPreparedTokenSource(
    lifecycle: Pick<PreparedTokenIssuer, "admission" | "provider">,
    state: PlatformUnitOfWork,
    principalId: string,
    namespaceId: string,
    sourceId: string,
    config: Readonly<Record<string, string>>,
    issuer: SecretReference,
  ): Promise<{ source: PreparedTokenSource; issuer: Readonly<Secret> }> {
    const control = this.selectedDriver("credential_proxy").sourceControl;
    const { origin, grant, schemaVersion } = lifecycle.admission(config);
    await this.authorize(principalId, "operate", {
      kind: "agent",
      namespaceId,
      id: grant.isolationId,
    });
    const agent = await state.agents.findAgent(namespaceId, grant.isolationId);
    // An Agent the caller may operate but that does not exist stays a 404. The refusals after it
    // concern an Agent the caller holds operate on, or the Secret reference the request sent, so
    // they name their cause (finding 2536).
    if (!agent) {
      throw new ScopeViolationError(
        "A prepared credential source requires an Agent in this Namespace.",
      );
    }
    this.assertProtectedSourceAgent(agent);
    if (issuer?.namespaceId !== namespaceId) {
      throw new SecretBindingValidationError(CREDENTIAL_SOURCE_SECRETS_CROSS_NAMESPACES);
    }
    if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/.test(origin)) {
      // The origin is the Installation's issuer setting, validated at startup.
      throw new ScopeViolationError(
        "A prepared credential source requires a trusted HTTPS origin.",
      );
    }
    await this.authorize(principalId, "operate", issuer);
    const secret = await state.secrets.lockSecret(namespaceId, issuer.id);
    if (!secret) {
      throw new ScopeViolationError("Prepared credential issuer material is unavailable.");
    }
    await control.assertAvailable(AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS));
    return {
      source: immutableCopy({
        key: {
          installationId: this.installation.id,
          namespaceId,
          source: { id: sourceId, generation: 1 },
          provider: lifecycle.provider,
          backend: control.backend,
        },
        sender: control.sender,
        resolver: control.resolver,
        origin,
        grant,
        schemaVersion,
        adoption: "prepared" as const,
        retention: "none" as const,
      }),
      issuer: secret,
    };
  }

  /**
   * A protected source names its Agent in `config.agent_id`, after the caller's operate grant on
   * it and its lookup, so a refusal may name the Agent's state (finding 2536).
   */
  private assertProtectedSourceAgent(agent: Readonly<Agent>): void {
    if (agent.status !== "active") {
      throw new AgentDeletingError();
    }
    if (agent.executionMode !== "dedicated") {
      throw new ResourceStateConflictError(
        "config.agent_id names an embedded Agent, and a protected credential source serves only a dedicated Agent. Name a dedicated Agent in this Namespace.",
      );
    }
  }

  private async admitCredentialFreeMetadata(
    state: PlatformUnitOfWork,
    principalId: string,
    namespaceId: string,
    sourceId: string,
    config: Readonly<Record<string, string>>,
  ): Promise<CredentialFreeEgressSource> {
    const control = this.selectedDriver("credential_proxy").sourceControl;
    const grant = credentialFreeMetadataGrant(config);
    const id = grant.isolationId;
    await this.authorize(principalId, "operate", { kind: "agent", namespaceId, id });
    const agent = await state.agents.findAgent(namespaceId, id);
    if (!agent) {
      throw new ScopeViolationError("Credential-free metadata requires this dedicated Agent.");
    }
    this.assertProtectedSourceAgent(agent);
    await control.assertAvailable(AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS));
    return immutableCopy({
      key: {
        installationId: this.installation.id,
        namespaceId,
        source: { id: sourceId, generation: 1 },
        provider: credentialFreeProviderRef,
        backend: control.backend,
      },
      sender: control.sender,
      resolver: control.resolver,
      origin: config.origin!,
      grant,
      schemaVersion: 3 as const,
      adoption: "credential_free" as const,
      retention: "none" as const,
    });
  }

  private staticEgressProvider(gatewayType: CredentialSourceType, previous?: EgressRef) {
    const type = gatewayType.type;
    const driver = this.selectedDriver("credential_proxy");
    const owner = this.drivers.selection("credential_proxy")?.owner;
    const control = driver.sourceControl;
    // A new admission uses catalog order. An existing approval names a specific registration.
    const resolve = () => {
      const ref =
        previous ?? control.providers.find((entry) => entry.sourceType.type === type)?.ref;
      return ref ? registeredCredentialProvider(control.providers, ref) : undefined;
    };
    const provider = resolve();
    if (provider === "ambiguous") {
      throw new ResourceStateConflictError(
        "The admitted credential provider has duplicate registrations. Ask an Installation administrator to resolve them.",
      );
    }
    if (!provider) {
      return undefined;
    }
    const ref = immutableCopy(provider.ref);
    // Catalog entries may be retained by their Drivers across asynchronous admission.
    const admittedGatewayType = immutableCopy(gatewayType);
    const admittedProviderType = immutableCopy(provider.sourceType);
    const { inject, normalizeConfig } = provider;
    const assertCurrent = () => {
      if (
        this.selectedDriver("credential_proxy") !== driver ||
        this.drivers.selection("credential_proxy")?.owner !== owner ||
        (owner !== undefined && owner.require("credential_proxy") !== driver) ||
        driver.sourceControl !== control ||
        resolve() !== provider ||
        !isDeepStrictEqual(gatewayType, admittedGatewayType) ||
        !isDeepStrictEqual(provider.sourceType, admittedProviderType) ||
        !isDeepStrictEqual(provider.ref, ref) ||
        provider.inject !== inject ||
        provider.normalizeConfig !== normalizeConfig
      ) {
        throw new ResourceStateConflictError(
          "The selected credential provider changed during admission. Check the Installation's provider configuration before retrying this credential-source request.",
        );
      }
      owner?.assertNewStaticProviderUse(ref);
    };
    return { provider, ref, inject, normalizeConfig, assertCurrent, gatewayType };
  }

  private async admitStaticEgressSource(
    state: PlatformUnitOfWork,
    principalId: string,
    namespaceId: string,
    sourceId: string,
    type: string,
    config: Readonly<Record<string, string>>,
    references: Readonly<Record<string, SecretReference>>,
    generation: number,
    selection: ReturnType<OpenClawController["staticEgressProvider"]>,
  ): Promise<StaticEgressSource> {
    const control = this.selectedDriver("credential_proxy").sourceControl;
    if (
      !selection ||
      selection.gatewayType.type !== type ||
      selection.provider.sourceType.type !== type ||
      !this.staticSourceLifecycleMatches(selection.gatewayType, selection.provider.sourceType) ||
      selection.provider.sourceType.secrets.length !== 1
    ) {
      // An Installation property about the type the request sent (finding 2536). The who comes
      // before the type list, so the 256-character cap never cuts it.
      throw new ResourceStateConflictError(
        `The selected Credential Proxy cannot protect ${type} sources. Ask an Installation administrator, or create a type it protects: ${control.providers.map((entry) => entry.sourceType.type).join(", ")}.`,
      );
    }
    const { provider, ref, inject, normalizeConfig, assertCurrent } = selection;
    const reference = references[provider.sourceType.secrets[0]!.name];
    assertCurrent();
    Reflect.apply(normalizeConfig, provider, [config]);
    // An Installation property: a Proxy that cannot serve the source refuses it before any
    // Secret is read (finding 2360).
    await control.assertAvailable(AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS));
    if (!reference) {
      throw new ScopeViolationError(
        "Protected source material must belong to the exact Namespace.",
      );
    }
    if (reference.namespaceId !== namespaceId) {
      // The reference the request sent, refused as the Credential Gateway path refuses it.
      throw new SecretBindingValidationError(CREDENTIAL_SOURCE_SECRETS_CROSS_NAMESPACES);
    }
    await this.authorize(principalId, "operate", reference);
    const secret = await state.secrets.lockSecret(namespaceId, reference.id);
    if (!secret) {
      throw new ScopeViolationError("Protected source material is unavailable.");
    }
    const secretDriver = this.secretDriver(secret.driverId);
    if (!secretDriver.readCredentialInput) {
      throw new DependencyUnavailableError(
        "Protected egress requires authoritative versioned Secret reads.",
      );
    }
    const signal = AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS);
    assertCurrent();
    const material = await secretDriver.readCredentialInput({
      secret,
      lifetime: {
        signal,
        deadlineAt: new Date(Date.now() + CREDENTIAL_GATEWAY_TIMEOUT_MS).toISOString(),
      },
      retention: "none",
    });
    // Validate format before committing the candidate, without retaining or exporting material.
    assertCurrent();
    Reflect.apply(inject, provider, [material.value]);
    assertCurrent();
    if (!material.version || !Number.isFinite(Date.parse(material.authoritativeObservedAt))) {
      throw new DependencyUnavailableError("The Secret Driver returned no version evidence.");
    }
    return immutableCopy({
      key: {
        installationId: this.installation.id,
        namespaceId,
        source: { id: sourceId, generation },
        backend: control.backend,
        provider: ref,
      },
      schemaVersion: 1 as const,
      adoption: "live" as const,
      materialRefId: crypto.randomUUID(),
      secret: reference,
      secretDriver: { id: secretDriver.id, generation: 1 },
      sender: control.sender,
      resolver: control.resolver,
      retention: "none" as const,
    });
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
    const sources: CredentialSource[] = [];
    let harnessCredentialSource: ProxyPlan["harnessCredentialSource"];
    for (const binding of agent.credentialSources ?? []) {
      const source = await state.credentialSources.findCredentialSource(
        agent.namespaceId,
        binding.sourceId,
      );
      if (source?.egress !== undefined) {
        sources.push(source);
      } else if (
        repositoryGit &&
        source?.state === "ready" &&
        harnessAuth?.method === "credential_source" &&
        source.id === harnessAuth.sourceId &&
        credentialSourceMatchesSnapshot(source, harnessAuth)
      ) {
        // admitHarnessAuth and admitCredentialSources already authorized this ordinary
        // Harness source. Bind its identity to release, without giving Git any model authority.
        harnessCredentialSource = harnessAuth;
      }
    }
    // Each refusal below is an Installation property or the Agent's saved bindings, after the
    // deploy grant and the authorization of every bound source: a retry never helps, so each is a
    // 409 with fixed text that names no source or repository (finding 2536).
    const installationAccess = isInstallationRepositoryProfile(repositoryGit?.bindings[0]?.profile);
    if (!this.drivers.hasSelection("credential_proxy")) {
      if (installationAccess) {
        throw new CredentialProxyAdmissionError("installationAccess");
      }
      if (sources.length > 0) {
        throw new CredentialProxyAdmissionError("sourcesWithoutProxy");
      }
      return undefined;
    }
    // Only a positively installed repository-only owner permits ordinary model delivery.
    // Source-free Agents and full/unknown profiles retain protected admission, including empty plans.
    if (
      sources.length === 0 &&
      repositoryGit === undefined &&
      harnessAuth !== undefined &&
      this.selectedProxyOwner().allowsOrdinaryCredentialGateway() &&
      (await this.ordinaryModelBinding(state, agent, harnessAuth))
    ) {
      return undefined;
    }
    const sourceCount = sources.length + (harnessCredentialSource ? 1 : 0);
    const owner = this.selectedProxyOwner();
    const driver = owner.require("credential_proxy");
    // Retirement is permanent; an unavailable counterpart cannot make this deployment retryable.
    for (const source of sources) {
      if (source.egress?.adoption === "live") {
        owner.assertNewStaticProviderUse(source.egress.key.provider);
      }
    }
    if ((agent.credentialSources?.length ?? 0) !== sourceCount) {
      throw new CredentialSourceUnprotectedError();
    }
    if (sourceCount > 1 && !repositoryGit && driver.policyReduction?.version !== 1) {
      throw new CredentialProxyAdmissionError("oneSource");
    }
    // Deploy refuses a selected Sandbox with another execution mode first
    // (requireSandboxExecutionMode), so this is an Installation without a Sandbox Driver.
    if (!sandboxDriverId || agent.executionMode !== "dedicated") {
      throw new CredentialProxyAdmissionError("dedicatedSandbox");
    }
    if (installationAccess) {
      owner.requireRepositoryGitTransport();
    }
    const gitProfile = repositoryGitDeliveryProfile(repositoryGit);
    if (repositoryGit !== undefined && gitProfile === undefined) {
      // Finding 2204: protected admission v4-v7 requires a mapped delivery profile, so
      // git-read, git-full or several bindings could never start. Refuse them by name before
      // reading the counterpart; its non-Git check would answer a generic 503 or admit a plan
      // that assertExecutionAdmission then rejects as an internal error.
      throw new RepositoryGitProfileUnsupportedError(repositoryGit.bindings.length);
    }
    const gitAuthorization = await repositoryGitAuthorization(
      driver.sourceControl,
      AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS),
      gitProfile,
    );
    if (gitAuthorization === "unavailable") {
      throw new DependencyUnavailableError(
        "The selected Credential Proxy did not confirm installation-wide repository access.",
      );
    }
    const reducibleGit =
      gitProfile !== undefined &&
      gitAuthorization === "exact-dispatch" &&
      driver.policyReduction?.version === 2;
    if (repositoryGit && sources.length && !reducibleGit) {
      throw new CredentialProxyAdmissionError("gitAlone");
    }
    if (reducibleGit && driver.policyReduction?.version === 2) {
      await driver.policyReduction.assertAvailable(
        AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS),
      );
    }
    let policyReductionVersion: ProxyPlan["policyReductionVersion"] = reducibleGit ? 2 : undefined;
    if (!repositoryGit && sources.length > 0 && driver.policyReduction?.version === 1) {
      policyReductionVersion = 1;
    }
    const selection = asRecord(asRecord(configuration.agents)?.defaults)?.model;
    const model = typeof selection === "string" ? selection : asRecord(selection)?.primary;
    if (
      sources.some((source) => source.egress?.adoption === "live") &&
      (typeof model !== "string" || !model.includes("/"))
    ) {
      // The caller holds read on the Agent's Configuration (deploy checked it), so the refusal
      // names the setting, as other Configuration Harness refusals do (finding 2536).
      throw new ConfigurationHarnessError(
        "Configuration setting agents.defaults.model must name a provider/model: a live-adopted credential source routes protected inference only to an explicit provider. Set it in the Agent's Configuration, then deploy again.",
      );
    }
    const modelId = typeof model === "string" ? model.slice(model.indexOf("/") + 1) : "";
    const execution = {
      installationId: this.installation.id,
      namespaceId: agent.namespaceId,
      agentId: agent.id,
      servicePrincipalId: agent.servicePrincipalId,
      revisionId,
      executionId: repositoryGit ? randomBytes(24).toString("base64url") : crypto.randomUUID(),
    };
    const control = driver.sourceControl;
    const requireProvider = (source: CredentialSource, expected?: CredentialProviderDefinition) => {
      const admitted = source.egress!;
      const provider = registeredCredentialProvider(control.providers, admitted.key.provider);
      if (
        provider === "ambiguous" ||
        (expected && provider !== expected) ||
        (provider && !matchesAdmittedSourceType(source, provider))
      ) {
        throw new ResourceStateConflictError(
          "The admitted credential provider changed or is incompatible. Ask an Installation administrator to restore its unique registration.",
        );
      }
      if (!provider || !isDeepStrictEqual(control.backend, admitted.key.backend)) {
        throw new DependencyUnavailableError("The admitted egress composition is unavailable.");
      }
      return provider;
    };
    const registrations = sources.map((source) => ({ source, provider: requireProvider(source) }));
    const routes = registrations.flatMap(({ source, provider }) => {
      const admitted = source.egress!;
      const grant = provider.normalizeGrant([modelId], source.config);
      let digestGrant = grant;
      if (source.type === credentialFreeMetadataType && admitted.adoption === "credential_free") {
        const canonical = credentialFreeMetadataGrant(source.config);
        if (!isDeepStrictEqual(grant, canonical)) {
          throw new ScopeViolationError(
            "Credential-free metadata grant does not match the source.",
          );
        }
        // Preserve the contracts digest without dropping any Driver-supplied grant fields.
        digestGrant = canonical;
      }
      return provider.routes(
        source,
        {
          binding: { id: crypto.randomUUID(), generation: 1 },
          execution,
          source: admitted.key,
          grant,
          grantHash: createHash("sha256").update(JSON.stringify(digestGrant)).digest("hex"),
          isolationId: agent.id,
        },
        harnessConfiguration,
      );
    });
    const plan: ProxyPlan = immutableCopy({
      id: crypto.randomUUID(),
      generation: 1,
      execution,
      sandboxDriverId,
      egressDriverId: driver.id,
      driver: owner.ref,
      ...(policyReductionVersion !== undefined && { policyReductionVersion }),
      ...(repositoryGit && { repositoryGit }),
      ...(repositoryGit &&
        (gitAuthorization === "online-request" || gitAuthorization === "request-hook-observed") && {
          repositoryGitAuthorization: gitAuthorization,
        }),
      ...(harnessCredentialSource && { harnessCredentialSource }),
      routes,
    });
    // The plan is durable; the receiver identities stay local to this admission.
    const assertProvidersCurrent = () => {
      if (registrations.length === 0) {
        return;
      }
      if (this.selectedProxyOwner() !== owner || driver.sourceControl !== control) {
        throw new ResourceStateConflictError(
          "The selected Credential Proxy changed during deployment.",
        );
      }
      for (const { source, provider } of registrations) {
        requireProvider(source, provider);
      }
    };
    return { plan, assertProvidersCurrent };
  }

  /** Bind the configured adapter to the actual durable credential store before use. */
  async activateTokenServiceInstance(driverId: string, storeIdentity: string): Promise<string> {
    if (!isNonEmptyString(driverId) || !isNonEmptyString(storeIdentity)) {
      throw new DriverSelectionError("The TokenService store identity is unavailable.");
    }
    const selected = await this.mutate((state) =>
      state.installations.selectTokenServiceInstance({
        id: crypto.randomUUID(),
        driverId,
        storeIdentity,
      }),
    );
    this.tokenServiceInstance = selected;
    return selected.id;
  }

  currentTokenServiceInstanceId(): string {
    if (!this.tokenServiceInstance) {
      throw new DependencyUnavailableError("The selected TokenService store is unavailable.");
    }
    return this.tokenServiceInstance.id;
  }

  private ownedTokenServiceDriver(instanceId?: string): TokenServiceDriver {
    let owner: TokenServiceDriver;
    try {
      owner = this.selectedDriver("token_service");
    } catch {
      throw new DependencyUnavailableError("The selected TokenService Driver is unavailable.");
    }
    const instance = this.tokenServiceInstance;
    if (
      !instance ||
      owner.id !== instance.driverId ||
      (instanceId !== undefined && instance.id !== instanceId)
    ) {
      throw new DependencyUnavailableError(
        "The selected TokenService instance does not own this registration.",
      );
    }
    return owner;
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
    this.requireIndependentMutation("Credential source creation");
    this.namespaceIdentity(namespaceId);
    let reservation:
      | {
          readonly owner: TokenServiceDriver;
          readonly ref: CredentialSourceReference;
          readonly instanceId: string;
        }
      | undefined;
    try {
      await this.mutate(async (state) => {
        await this.holdAuthority(state);
        const target = { kind: "credential_source" as const, id: namespaceId, namespaceId };
        await this.authorize(principalId, "create", target);
        const namespace = await this.lockNamespace(state, namespaceId);
        await this.authorize(principalId, "create", target);
        if (!isName(input.name)) {
          throw new ScopeViolationError("The credential source name is invalid.");
        }
        if (namespace.status !== "ready") {
          throw new NamespaceNotReadyError();
        }
        assertManagedSourceLifecycleSettings(input.lifecycleConfig.settings);
        if (input.providerPreset !== undefined) {
          assertSourceProviderPreset(input.providerPreset);
        }
        const owner = this.ownedTokenServiceDriver();
        const instanceId = this.currentTokenServiceInstanceId();
        const source = await state.credentialSources.createCredentialSource({
          id: this.nextIdentifier("credential_source"),
          namespaceId,
          name: input.name,
          type: input.lifecycleConfig.type,
          ownerCapability: "token_service",
          tokenServiceInstanceId: instanceId,
          state: "registering",
          config:
            input.providerPreset === undefined
              ? {}
              : { [SOURCE_PROVIDER_PRESET_CONFIG_KEY]: input.providerPreset },
          secrets: {},
          createdAt: this.timestamp(),
        });
        const ref = credentialSourceRef(source);
        await this.bindCreator(state, principalId, ref);
        // Custody can outlive an uncertain owner response, so commit attributable intent
        // with the source identity and creator binding before the owner can receive material.
        await state.audit.append(audit(ref, "registration_started"));
        reservation = { owner, ref, instanceId };
      });
    } catch (error) {
      const pending = reservation;
      if (!(error instanceof PostgresCommitOutcomeUnknownError) || pending === undefined) {
        throw error;
      }
      try {
        await this.mutate(async (state) => {
          await this.lockNamespace(state, namespaceId);
          const source = await state.credentialSources.lockCredentialSource(
            namespaceId,
            pending.ref.id,
          );
          if (source === undefined) {
            return;
          }
          if (
            !isManagedTokenServiceSource(source) ||
            source.tokenServiceInstanceId !== pending.instanceId ||
            source.state !== "registering" ||
            source.registration !== undefined ||
            source.registrationDispatchedAt !== undefined
          ) {
            throw new ResourceStateConflictError("The reservation changed before recovery.");
          }
          await state.credentialSources.deleteCredentialSource(namespaceId, source.id);
        });
      } catch {
        throw new DependencyUnavailableError(
          `The TokenService reservation ${pending.ref.id} could not be reconciled. Inspect that registration before retrying.`,
        );
      }
      throw error;
    }
    if (reservation === undefined) {
      throw new DependencyUnavailableError("The TokenService reservation is unavailable.");
    }
    const { owner, ref, instanceId } = reservation;

    let registration: TokenServiceRegistration | undefined;
    let registrationStarted = false;
    try {
      // Commit the dispatch claim before any external write. If this process stops during
      // the owner call, a different API process must still ask the owner to confirm removal.
      const claimed = await this.mutate((state) =>
        state.credentialSources.setCredentialSourceRegistrationDispatch(
          namespaceId,
          ref.id,
          this.timestamp(),
        ),
      );
      if (!claimed) {
        throw new ResourceStateConflictError("The credential source changed before registration.");
      }
      return await this.mutate(async (state) => {
        await this.holdAuthority(state);
        const namespace = await this.lockNamespace(state, namespaceId);
        if (namespace.status !== "ready") {
          throw new NamespaceNotReadyError();
        }
        const pending = await state.credentialSources.lockCredentialSource(namespaceId, ref.id);
        if (
          pending?.state !== "registering" ||
          pending.ownerCapability !== "token_service" ||
          pending.tokenServiceInstanceId !== instanceId
        ) {
          throw new ResourceStateConflictError(
            "The credential source changed before registration.",
          );
        }
        await this.authorize(principalId, "create", {
          kind: "credential_source",
          id: namespaceId,
          namespaceId,
        });
        this.ownedTokenServiceDriver(instanceId);
        // Leave both the owner call and a possibly late dependency write inside the
        // durable deletion fence. IAM or transaction acquisition may have stalled
        // since the claim committed; such a claim must not start a new owner write.
        const dispatchWindowEndsAt =
          Date.parse(pending.registrationDispatchedAt ?? "") +
          CREDENTIAL_REGISTRATION_FENCE_MS -
          2 * CONNECTION_OPERATION_TIMEOUT_MS;
        if (
          !Number.isFinite(dispatchWindowEndsAt) ||
          this.clock().getTime() > dispatchWindowEndsAt
        ) {
          throw new ResourceStateConflictError(
            "The credential source registration dispatch expired before the owner call.",
          );
        }
        registrationStarted = true;
        registration = await this.driverOperation(
          () =>
            owner.registerSource(
              {
                sourceRef: ref,
                tokenServiceInstanceId: instanceId,
                secret: input.secret,
                lifecycleConfig: input.lifecycleConfig,
              },
              AbortSignal.timeout(CONNECTION_OPERATION_TIMEOUT_MS),
            ),
          "TokenService",
        );
        this.ownedTokenServiceDriver(instanceId);
        const ready = await state.credentialSources.markCredentialSourceReady(
          namespaceId,
          ref.id,
          registration,
          { ...input.lifecycleConfig.settings, ...pending.config },
        );
        if (!isManagedTokenServiceSource(ready)) {
          throw new ResourceStateConflictError(
            "The credential source changed during registration.",
          );
        }
        const completed = audit(ref);
        await state.audit.append(
          input.providerPreset === undefined
            ? completed
            : {
                ...completed,
                details: { ...completed.details, providerPreset: input.providerPreset },
              },
        );
        return this.credentialSourceMetadata(ready);
      });
    } catch (error) {
      // A lost commit acknowledgement can leave a ready source. A concurrent DELETE may also
      // have claimed the reservation. Only the request that still owns it can compensate.
      const writeUnsent =
        !registrationStarted ||
        (registration === undefined && error instanceof TokenServiceRegistrationRefusedError);
      const recovery = await this.mutate(async (state) => {
        await this.lockNamespace(state, namespaceId);
        const source = await state.credentialSources.lockCredentialSource(namespaceId, ref.id);
        if (!isManagedTokenServiceSource(source) || source.tokenServiceInstanceId !== instanceId) {
          return { error };
        }
        if (source.state === "ready") {
          return { source: this.credentialSourceMetadata(source) };
        }
        if (source.state !== "registering") {
          // A DELETE between dispatch authorization and the owner call may already have
          // tried removal. Only this POST can attest that its single write was never sent.
          if (writeUnsent && source.registrationDispatchedAt) {
            await state.credentialSources.setCredentialSourceRegistrationDispatch(
              namespaceId,
              ref.id,
              undefined,
            );
          }
          return { error };
        }
        if (!writeUnsent) {
          await state.credentialSources.markCredentialSourceDeleting(namespaceId, ref.id);
          const receipt = registration;
          if (receipt === undefined) {
            // A dispatched write without a receipt may still arrive. A later DELETE
            // waits for the registration fence before the owner can settle absence.
            return {
              error: new DependencyUnavailableError(
                "The TokenService could not confirm credential source removal.",
              ),
            };
          }
          try {
            await this.driverOperation(
              () =>
                owner.removeSource(
                  {
                    sourceRef: ref,
                    tokenServiceInstanceId: instanceId,
                    registration: receipt,
                  },
                  AbortSignal.timeout(CONNECTION_OPERATION_TIMEOUT_MS),
                ),
              "TokenService",
            );
          } catch {
            // An absent object cannot settle a write whose acknowledgement was lost.
            // Commit the deleting state and report that the outcome still needs reconciliation.
            return {
              error: new DependencyUnavailableError(
                "The TokenService could not confirm credential source removal.",
              ),
            };
          }
        }
        // Either no write was issued or the recorded owner has confirmed removal.
        await state.credentialSources.deleteCredentialSource(namespaceId, ref.id);
        return { error };
      });
      if (recovery.source) {
        return recovery.source;
      }
      throw recovery.error;
    }
  }

  async updateManagedCredentialSource(
    principalId: string,
    ref: { readonly namespaceId: string; readonly credentialSourceId: string },
    input: UpdateManagedCredentialSourceInput,
    audit: (resource: CredentialSourceReference, phase?: "update_started") => AuditEvent,
    failureAudit: (reasonCode: string) => AuditEvent,
  ): Promise<Readonly<CredentialSourceMetadata>> {
    this.requireIndependentMutation("Credential source update");
    this.namespaceIdentity(ref.namespaceId);
    const resource: CredentialSourceReference = {
      kind: "credential_source",
      namespaceId: ref.namespaceId,
      id: ref.credentialSourceId,
    };
    let ownerUpdate: SourceUpdate | undefined;
    if (input.secret !== undefined) {
      ownerUpdate = {
        secret: input.secret,
        ...(input.lifecycleConfig === undefined ? {} : { lifecycleConfig: input.lifecycleConfig }),
      };
    } else if (input.lifecycleConfig !== undefined) {
      ownerUpdate = { lifecycleConfig: input.lifecycleConfig };
    }
    const authorizeUpdate = async (state: PlatformUnitOfWork, lockSource: boolean) => {
      await this.authorize(principalId, "update", resource);
      await this.holdAuthority(state);
      const namespace = await this.lockNamespace(state, ref.namespaceId);
      // AccessBinding revocation uses the same policy lock. A request that waited must reauthorize before custody changes.
      await this.authorize(principalId, "update", resource);
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      if (input.providerPreset !== undefined && input.providerPreset !== null) {
        assertSourceProviderPreset(input.providerPreset);
      }
      if (input.lifecycleConfig !== undefined) {
        assertManagedSourceLifecycleSettings(input.lifecycleConfig.settings);
      }
      if (ownerUpdate === undefined && input.providerPreset === undefined) {
        throw new ScopeViolationError(
          "A source update requires a provider preset or owner update.",
        );
      }
      const source = lockSource
        ? await state.credentialSources.lockCredentialSource(
            ref.namespaceId,
            ref.credentialSourceId,
          )
        : await state.credentialSources.findCredentialSource(
            ref.namespaceId,
            ref.credentialSourceId,
          );
      if (!source) {
        throw new ScopeViolationError(
          "The credential source does not belong to the exact Namespace.",
        );
      }
      if (
        !isManagedTokenServiceSource(source) ||
        source.state !== "ready" ||
        !source.registration
      ) {
        throw new ResourceStateConflictError(
          "This credential source cannot be updated through the selected TokenService.",
        );
      }
      const owner = this.ownedTokenServiceDriver(source.tokenServiceInstanceId);
      const presetChanges =
        input.providerPreset !== undefined &&
        (input.providerPreset ?? undefined) !== source.config[SOURCE_PROVIDER_PRESET_CONFIG_KEY];
      if (presetChanges && ownerUpdate !== undefined) {
        throw new ResourceStateConflictError(
          "Change the provider preset separately from credential material or lifecycle settings.",
        );
      }
      if (
        lockSource &&
        presetChanges &&
        (await state.credentialSources.hasReferences(ref.namespaceId, source.id))
      ) {
        // TODO(source preset replacement): permit bound changes after withdrawal and redeployment can replace the admitted authority.
        throw new ResourceStateConflictError("Provider preset changes require an unbound source.");
      }
      return { source, owner };
    };
    if (ownerUpdate === undefined) {
      return this.mutate(async (state) => {
        const { source } = await authorizeUpdate(state, true);
        const updated = await state.credentialSources.updateCredentialSourceConfig(
          ref.namespaceId,
          ref.credentialSourceId,
          managedSourceConfig(source, input),
        );
        if (!updated) {
          throw new ResourceStateConflictError("The credential source changed during update.");
        }
        const completed = audit(resource);
        await state.audit.append({
          ...completed,
          details: { ...completed.details, providerPreset: input.providerPreset },
        });
        return this.credentialSourceMetadata(updated);
      });
    }
    const materialUpdate = ownerUpdate;
    // An authorized intent must be durable before private custody can change. The effect
    // transaction rechecks authority and the exact source while holding both fences.
    await this.mutate(async (state) => {
      await authorizeUpdate(state, false);
      await state.audit.append(audit(resource, "update_started"));
    });
    return this.mutate(async (state) => {
      const { source, owner } = await authorizeUpdate(state, true);
      this.auditUncommittedCredentialEffect(failureAudit, "CREDENTIAL_SOURCE_UPDATE_FAILED");
      await this.driverOperation(
        () =>
          owner.updateSource(
            {
              sourceRef: resource,
              tokenServiceInstanceId: source.tokenServiceInstanceId,
              registration: source.registration!,
            },
            materialUpdate,
            AbortSignal.timeout(CONNECTION_OPERATION_TIMEOUT_MS),
          ),
        "TokenService",
      );
      const updated =
        input.lifecycleConfig === undefined && input.providerPreset === undefined
          ? source
          : await state.credentialSources.updateCredentialSourceConfig(
              ref.namespaceId,
              ref.credentialSourceId,
              managedSourceConfig(source, input),
            );
      if (!updated) {
        throw new ResourceStateConflictError("The credential source changed during update.");
      }
      const completed = audit(resource);
      await state.audit.append(
        input.providerPreset === undefined
          ? completed
          : {
              ...completed,
              details: { ...completed.details, providerPreset: input.providerPreset },
            },
      );
      return this.credentialSourceMetadata(updated);
    });
  }

  // TODO: Remove this staging-only check when managed Source HTTP handlers invoke the manager.
  async authorizeCredentialSourceWrite(
    principalId: string,
    namespaceId: string,
    credentialSourceId?: string,
  ): Promise<void> {
    this.namespaceIdentity(namespaceId);
    await this.authorize(principalId, credentialSourceId === undefined ? "create" : "update", {
      kind: "credential_source",
      id: credentialSourceId ?? namespaceId,
      namespaceId,
    });
  }

  /**
   * Registration records the source as `registering` before the gateway write, so an uncertain
   * gateway outcome always leaves a record an operator can list and delete. `audit` builds the
   * success event, committed with the transition to `ready`. `registrationAudit` records
   * the initial `registering` row before any external effect, for multi-step callers.
   */
  async createCredentialSource(
    principalId: string,
    input: CreateCredentialSourceInput,
    audit?: (source: Readonly<CredentialSourceMetadata>) => AuditEvent,
    registrationAudit?: (source: Readonly<CredentialSourceMetadata>) => AuditEvent,
  ): Promise<Readonly<CredentialSourceMetadata & { readonly status?: CredentialSourceStatus }>> {
    this.requireIndependentMutation("Credential source registration and deletion");
    if (!isName(input.name)) {
      throw new ScopeViolationError("The credential source name is invalid.");
    }
    const written = Object.freeze({ ...(input.config ?? {}) });
    const secretRefs = Object.freeze({ ...(input.secrets ?? {}) });
    this.namespaceIdentity(input.namespaceId);
    const registration = await this.mutate(async (state) => {
      await this.holdAuthority(state);
      const target: ResourceRef = {
        kind: "credential_source",
        id: input.namespaceId,
        namespaceId: input.namespaceId,
      };
      await this.authorize(principalId, "create", target);
      const locked = await this.lockNamespace(state, input.namespaceId);
      // AccessBinding deletes hold this lock: authorize again so a revocation that committed
      // while this write waited stops it before it leaves a durable Owner binding or grant.
      await this.authorize(principalId, "create", target);
      // An Installation property, so it is reported before any Namespace state.
      this.assertCredentialSourceOwnerSelected();
      const protectedType = this.protectedSourceTypes().find((p) => p.type.type === input.type);
      const selected = protectedType ? undefined : this.credentialGatewayDriver();
      if (locked.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      const type = protectedType?.type ?? (await this.credentialSourceType(selected!, input.type));
      credentialSourceFieldsMatch(type, "config", written);
      credentialSourceFieldsMatch(type, "secrets", secretRefs);
      // The Driver may return the configuration in the form it uses, such as a normalized URL:
      // the stored record, the response and the gateway then agree (finding 1292).
      const config = Object.freeze({
        ...(protectedType
          ? written
          : (selected!.validateSourceConfig({ type: type.type, config: written }) ?? written)),
      });
      credentialSourceFieldsMatch(type, "config", config);
      // TODO: Admit prepared refresh sources once their owner supports on-demand rotation.
      if (protectedType?.issuer && type.rotation === "refresh") {
        throw new NotImplementedError(
          "credential_source_refresh",
          "This prepared issuer does not support on-demand rotation. Use a Credential Gateway-owned refresh source instead.",
        );
      }
      const requiresStaticAdmission =
        !protectedType && !this.ordinaryCredentialGatewayAllowed(type);
      const staticSelection = requiresStaticAdmission ? this.staticEgressProvider(type) : undefined;
      if (
        requiresStaticAdmission &&
        !this.staticSourceLifecycleMatches(type, staticSelection?.provider.sourceType)
      ) {
        throw new ResourceStateConflictError(
          "The selected Credential Proxy cannot preserve this credential source's lifecycle.",
        );
      }
      const refreshDriver =
        type.rotation === "refresh" ? this.credentialRefreshDriver() : undefined;
      if (
        type.deviceAuthorization !== undefined &&
        (!refreshDriver?.startDeviceAuthorization || !refreshDriver.pollDeviceAuthorization)
      ) {
        throw new NotImplementedError(
          "agent_device_authorization",
          "Device login requires the selected Credential Refresh Driver's device authorization support.",
        );
      }
      const sourceId = this.nextIdentifier("credential_source");
      const prepared = protectedType?.issuer
        ? await this.admitPreparedTokenSource(
            protectedType.issuer,
            state,
            principalId,
            locked.id,
            sourceId,
            config,
            secretRefs[protectedType.issuer.issuerInput]!,
          )
        : undefined;
      let egress: CredentialSource["egress"] = prepared?.source;
      if (egress === undefined) {
        if (type.type === credentialFreeMetadataType) {
          egress = await this.admitCredentialFreeMetadata(
            state,
            principalId,
            locked.id,
            sourceId,
            config,
          );
        } else if (!this.ordinaryCredentialGatewayAllowed(type)) {
          egress = await this.admitStaticEgressSource(
            state,
            principalId,
            locked.id,
            sourceId,
            input.type,
            config,
            secretRefs,
            1,
            staticSelection,
          );
        }
      }
      let read: Record<string, string> = {};
      if (egress === undefined) {
        await this.authorizeCredentialSourceSecrets(principalId, locked.id, secretRefs);
        read = await this.readCredentialSourceSecrets(state, locked.id, secretRefs);
      }

      const registering = await state.credentialSources.createCredentialSource(
        Object.freeze({
          id: sourceId,
          ...(egress === undefined ? {} : { egress }),
          namespaceId: locked.id,
          name: input.name,
          type: type.type,
          config,
          secrets: secretRefs,
          ownerCapability: protectedType ? "credential_proxy" : "credential_gateway",
          driverId: protectedType ? protectedType.driver.id : selected!.id,
          state: "registering",
          createdAt: this.timestamp(),
        }),
      );
      await this.bindCreator(state, principalId, {
        kind: "credential_source",
        id: registering.id,
        namespaceId: locked.id,
      });
      if (registrationAudit !== undefined) {
        await state.audit.append(registrationAudit(this.credentialSourceMetadata(registering)));
      }
      return {
        namespace: locked,
        gateway: selected,
        refresh: refreshDriver,
        deferred: type.deviceAuthorization !== undefined,
        source: registering,
        issuer: prepared?.issuer,
        values: read,
      };
    });
    const { namespace, gateway, refresh, deferred, source, values, issuer } = registration;
    const config = source.config;
    // Fresh live admission reads the Secret directly and never creates a Gateway copy.
    const liveRegistrationWithoutWrite =
      source.egress?.adoption === "live" && refresh === undefined;
    const placed =
      gateway && !liveRegistrationWithoutWrite
        ? await this.credentialNamespace(namespace)
        : namespace;
    let status: CredentialSourceStatus;
    // A returned result means every gateway effect of this attempt has finished; a throw does not.
    let terminal = false;
    try {
      if (source.egress?.adoption === "prepared" && issuer) {
        await this.tokenService().register(
          {
            kind: this.preparedIssuer(source.egress.key.provider).tokenKind,
            source: source.egress,
            secret: issuer,
          },
          AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS),
        );
      }
      status =
        source.egress !== undefined
          ? { state: source.egress.adoption === "prepared" ? "pending" : "ready" }
          : await this.credentialGatewayOperation(() =>
              gateway!.registerSource(
                {
                  namespace: placed,
                  source,
                  signal: AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS),
                },
                // A refresh type's secrets are issuer material, held only by the refresh Driver.
                { type: source.type, config, secrets: refresh === undefined ? values : {} },
              ),
            );
      terminal = true;
      if (status.state === "failed" || status.state === "absent") {
        throw new DependencyUnavailableError("The Credential Gateway did not store the source.");
      }
      if (refresh !== undefined && deferred) {
        // A device grant does not exist until authorization completes. The source
        // is registered now; the Refresh Driver owns its later first mint.
        status = { ...status, refresh: { state: "pending" } };
      } else if (refresh !== undefined) {
        // A refresh type is usable only once the first token is minted. Registration happens
        // once per source ID, so its request IDs are stable for the gateway's replay window.
        terminal = false;
        const minted = await this.mintFirstRefreshToken(refresh, placed, source, config, values);
        // A definite mint outcome, even a failed one, leaves no refresh effect in flight.
        terminal = true;
        assertRefreshMinted(minted);
        status = { ...status, refresh: minted };
      }
    } catch (error) {
      if (source.egress?.adoption === "prepared") {
        // Unknown configure outcome stays visible and denied. DELETE withdraws the exact family without replay.
        await this.mutate((state) =>
          state.credentialSources.markCredentialSourceDeleting(source.namespaceId, source.id),
        );
        throw error;
      }
      if (gateway) {
        await this.abandonCredentialRegistration(placed, gateway, source, terminal, refresh);
      }
      throw error;
    }
    // A commit failure leaves the record `registering`; deleting it removes any stored copy.
    const ready = await this.mutate(async (state) => {
      await this.lockNamespace(state, namespace.id);
      const marked = await state.credentialSources.markCredentialSourceReady(
        namespace.id,
        source.id,
      );
      if (marked !== undefined && audit !== undefined) {
        await state.audit.append(audit(this.credentialSourceMetadata(marked)));
      }
      return marked;
    });
    if (ready === undefined) {
      // A concurrent deletion owns the prepared family withdrawal. It must not be reconfigured or replayed.
      if (gateway && source.egress?.adoption !== "prepared" && !liveRegistrationWithoutWrite) {
        await this.abandonCredentialRegistration(placed, gateway, source, true, refresh);
      }
      throw new ResourceStateConflictError("The credential source changed during registration.");
    }
    return this.credentialSourceMetadata(ready, status);
  }

  /** Configures a new source's refresh material, then forces and returns the first mint. */
  private async mintFirstRefreshToken(
    refresh: CredentialRefreshDriver,
    namespace: Readonly<Namespace>,
    source: Readonly<CredentialSource>,
    config: Readonly<Record<string, string>>,
    secrets: Readonly<Record<string, string>>,
  ): Promise<CredentialRefreshStatus> {
    const context = () => ({
      namespace,
      source,
      signal: AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS),
    });
    await this.credentialGatewayOperation(() =>
      refresh.configureRefresh(context(), {
        config,
        secrets,
        requestId: credentialRefreshRequestId(source.id, "configure"),
      }),
    );
    return this.credentialGatewayOperation(() =>
      refresh.rotate(context(), credentialRefreshRequestId(source.id, "rotate")),
    );
  }

  /** Authorize exact Secret references before inspecting private source bindings or reading values. */
  private async authorizeCredentialSourceSecrets(
    principalId: string,
    namespaceId: string,
    references: Readonly<Record<string, SecretReference>>,
  ): Promise<void> {
    // Reject a foreign reference before any authorization or Secret lookup, as Secret bindings do.
    if (Object.values(references).some((reference) => reference.namespaceId !== namespaceId)) {
      throw new SecretBindingValidationError(CREDENTIAL_SOURCE_SECRETS_CROSS_NAMESPACES);
    }
    for (const reference of Object.values(references)) {
      await this.authorize(principalId, "operate", reference);
    }
  }

  /** Read already-authorized Secret values for a single Credential Gateway call. */
  private async readCredentialSourceSecrets(
    state: PlatformUnitOfWork,
    namespaceId: string,
    references: Readonly<Record<string, SecretReference>>,
  ): Promise<Record<string, string>> {
    // Locked in Secret ID order, so two updates whose sources share Secrets cannot deadlock.
    const ordered = Object.entries(references).sort(([, left], [, right]) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
    const values: Record<string, string> = {};
    for (const [field, reference] of ordered) {
      const secret = await state.secrets.lockSecret(namespaceId, reference.id);
      if (secret === undefined) {
        throw new ScopeViolationError("The credential source Secret is unavailable.");
      }
      const secretDriver = this.secretDriver(secret.driverId);
      if (secretDriver.withValue === undefined) {
        throw new DependencyUnavailableError(
          "The selected Secret Driver cannot supply values to a Credential Gateway.",
        );
      }
      const withValue = secretDriver.withValue.bind(secretDriver);
      values[field] = await this.secretOperation(() => withValue(secret, async (value) => value));
    }
    return values;
  }

  /**
   * Pushes current, or replacement, Secret values to the gateway copy. The gateway calls run
   * under the source lock, which orders them against rotation, deletion, and Agent admission of
   * this source; they do not hold the Namespace lock, because a refresh type's calls wait on the
   * token issuer. A failed commit leaves the gateway newer, and repeating the same request
   * converges. Running Harness processes keep the previous value. `failureAudit` builds the event
   * committed on its own when the request fails after a gateway write began.
   */
  async updateCredentialSource(
    principalId: string,
    input: UpdateCredentialSourceInput,
    failureAudit?: (reasonCode: string) => AuditEvent,
  ): Promise<Readonly<CredentialSourceMetadata & { readonly status?: CredentialSourceStatus }>> {
    this.namespaceIdentity(input.namespaceId);
    return this.mutate(async (state) => {
      await this.authorize(principalId, "update", {
        kind: "credential_source",
        id: input.credentialSourceId,
        namespaceId: input.namespaceId,
      });
      const namespace = await this.exactNamespace(state, input.namespaceId);
      // Lock order matches Agent admission: the source, then the Secrets it reads. Admission
      // with a Secret-method harnessAuth locks that Secret first; if the same Secret also backs
      // this source, PostgreSQL ends the cycle by failing one request.
      const recorded = await state.credentialSources.lockCredentialSource(
        namespace.id,
        input.credentialSourceId,
      );
      const source = isManagedTokenServiceSource(recorded) ? undefined : recorded;
      if (source?.ownerCapability !== "token_service") {
        this.assertCredentialSourceOwnerSelected();
      }
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      if (!source) {
        throw new ScopeViolationError(
          "The credential source does not belong to the exact Namespace.",
        );
      }
      if (source.state !== "ready") {
        throw new ResourceStateConflictError("Only a ready credential source can be updated.");
      }
      if (source.ownerCapability === "token_service") {
        throw new ResourceStateConflictError(
          "Reconnect the account to replace its saved OAuth grant.",
        );
      }
      if (source.egress?.adoption === "prepared" || source.egress?.adoption === "credential_free") {
        // After the update grant and lookup: the caller may change this source (finding 2536).
        throw new ResourceStateConflictError(FIXED_PROTECTED_SOURCE_REFUSALS.update);
      }
      const gateway = this.ownedCredentialGatewayDriver(source);
      const type = await this.credentialSourceType(gateway, source.type);
      if (type.deviceAuthorization !== undefined) {
        // Device grants are held by the Refresh Driver, not recorded Secret references.
        // Reconfiguring from an empty reference set could revoke the active grant.
        throw new ResourceStateConflictError("Reconnect by creating a new device-login source.");
      }
      const secretRefs = Object.freeze({ ...(input.secrets ?? source.secrets) });
      credentialSourceFieldsMatch(type, "secrets", secretRefs);
      if (type.rotation === "refresh") {
        await this.authorizeCredentialSourceSecrets(principalId, namespace.id, secretRefs);
        refuseIssuerRotatedResend(type, source.secrets, secretRefs);
      }
      if (
        source.egress !== undefined ||
        input.adoption !== undefined ||
        input.authorityScope !== undefined
      ) {
        const previous = source.egress?.key.provider;
        const admitted =
          previous && this.drivers.hasSelection("credential_proxy")
            ? this.staticEgressProvider(type, previous)
            : undefined;
        if (!admitted && !(input.adoption === "live" && input.authorityScope === "execution")) {
          throw new ResourceStateConflictError(
            "Adopting a legacy or narrower source requires explicit live adoption and execution authority scope.",
          );
        }
        // The first cutover refuses bound sources. Keeping the legacy copy intact is safer
        // than replacing material before an exact replacement installation can be verified.
        // TODO(egress live cutover): admit and install a separate candidate for running bindings.
        if (await state.credentialSources.hasReferences(namespace.id, source.id)) {
          throw new ResourceStateConflictError(
            "Protected source changes require an unbound source.",
          );
        }
        const egress = await this.admitStaticEgressSource(
          state,
          principalId,
          namespace.id,
          source.id,
          source.type,
          source.config,
          secretRefs,
          (source.egress?.key.source.generation ?? 0) + 1,
          admitted ?? this.staticEgressProvider(type),
        );
        if (input.secrets !== undefined) {
          await state.credentialSources.replaceCredentialSourceSecrets(
            namespace.id,
            source.id,
            secretRefs,
          );
        }
        const updated = await state.credentialSources.admitEgressSource(
          namespace.id,
          source.id,
          source.egress?.key.source.generation ?? 0,
          egress,
        );
        if (!updated) {
          throw new ResourceStateConflictError("The protected source changed during admission.");
        }
        return this.credentialSourceMetadata(updated, { state: "ready" });
      }
      if (type.rotation !== "refresh") {
        await this.authorizeCredentialSourceSecrets(principalId, namespace.id, secretRefs);
      }
      const values = await this.readCredentialSourceSecrets(state, namespace.id, secretRefs);
      // The gateway sees Compute's runtime placement, the same Workspace as the paired Sandbox.
      const placed = await this.credentialNamespace(namespace);
      const context = () => ({
        namespace: placed,
        source,
        signal: AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS),
      });
      let status: CredentialSourceStatus;
      if (type.rotation === "refresh") {
        // A refresh type keeps no static value at the gateway: new material replaces the
        // refresh configuration, and the next mint proves it before OCC commits the references.
        const refresh = this.credentialRefreshDriver();
        status = await this.credentialGatewayOperation(() => gateway.sourceStatus(context()));
        assertCredentialGatewayHoldsSource(status);
        this.auditUncommittedCredentialEffect(failureAudit, "CREDENTIAL_REFRESH_UPDATE_FAILED");
        await this.credentialGatewayOperation(() =>
          refresh.configureRefresh(context(), {
            config: source.config,
            secrets: values,
            requestId: crypto.randomUUID(),
          }),
        );
        const minted = await this.credentialGatewayOperation(() =>
          refresh.rotate(context(), crypto.randomUUID()),
        );
        assertRefreshMinted(minted);
        status = { ...status, refresh: minted };
      } else {
        this.auditUncommittedCredentialEffect(failureAudit, "CREDENTIAL_GATEWAY_UPDATE_FAILED");
        status = await this.credentialGatewayOperation(() =>
          gateway.updateSource(context(), {
            type: source.type,
            config: source.config,
            secrets: values,
          }),
        );
        assertCredentialGatewayHoldsSource(status);
      }
      const updated =
        input.secrets === undefined
          ? source
          : await state.credentialSources.replaceCredentialSourceSecrets(
              namespace.id,
              source.id,
              secretRefs,
            );
      if (updated === undefined) {
        throw new ResourceStateConflictError("The credential source changed during the update.");
      }
      return this.credentialSourceMetadata(updated, status);
    });
  }

  /**
   * Forces one refresh of a refresh-type source, for incidents such as a suspected token leak.
   * It does not revoke the previous token at the issuer, and running Agents keep their stable
   * placeholder, so no redeploy follows. Like an update, it holds only the source lock while the
   * issuer answers. `failureAudit` builds the event committed on its own when the mint fails.
   */
  async rotateCredentialSource(
    principalId: string,
    input: RotateCredentialSourceInput,
    failureAudit?: (reasonCode: string) => AuditEvent,
    audit?: AuditEvent,
  ): Promise<Readonly<CredentialSourceMetadata & { readonly status?: CredentialSourceStatus }>> {
    this.namespaceIdentity(input.namespaceId);
    const ownsTransaction = !this.transactions.hasContext();
    const rotation = await this.mutate(async (state) => {
      await this.authorize(principalId, "update", {
        kind: "credential_source",
        id: input.credentialSourceId,
        namespaceId: input.namespaceId,
      });
      const namespace = await this.exactNamespace(state, input.namespaceId);
      // An Installation property, so it is reported before any Namespace or source state.
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      const source = await state.credentialSources.lockCredentialSource(
        namespace.id,
        input.credentialSourceId,
      );
      if (!source || isManagedTokenServiceSource(source)) {
        throw new ScopeViolationError(
          "The credential source does not belong to the exact Namespace.",
        );
      }
      if (source.state !== "ready") {
        throw new ResourceStateConflictError("Only a ready credential source can be rotated.");
      }
      if (source.ownerCapability === "token_service") {
        if (!ownsTransaction) {
          throw new ResourceConflictError(
            "Connected-account rotation must own its retry transaction.",
          );
        }
        // Commit the retry before contacting the issuer or gateway. An uncertain write is recoverable.
        await state.savedConnections.recordTokenSchedule(namespace.id, source.id, "due");
        return { managedSource: source };
      }
      this.assertCredentialSourceOwnerSelected();
      if (source.egress?.adoption === "prepared" || source.egress?.adoption === "credential_free") {
        throw new ResourceStateConflictError(FIXED_PROTECTED_SOURCE_REFUSALS.rotate);
      }
      const gateway = this.ownedCredentialGatewayDriver(source);
      const type = await this.credentialSourceType(gateway, source.type);
      if (type.rotation !== "refresh") {
        throw new ResourceStateConflictError(
          "Only a refresh-type credential source can be rotated; update a static source instead.",
        );
      }
      const refresh = this.credentialRefreshDriver();
      const placed = await this.credentialNamespace(namespace);
      const context = () => ({
        namespace: placed,
        source,
        signal: AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS),
      });
      this.auditUncommittedCredentialEffect(failureAudit, "CREDENTIAL_REFRESH_ROTATION_FAILED");
      const minted = await this.credentialGatewayOperation(() =>
        refresh.rotate(context(), crypto.randomUUID()),
      );
      assertRefreshMinted(minted);
      const status = await this.credentialGatewayOperation(() => gateway.sourceStatus(context()));
      if (audit) {
        await state.audit.append(audit);
      }
      return this.credentialSourceMetadata(source, { ...status, refresh: minted });
    });
    if ("managedSource" in rotation) {
      const source = rotation.managedSource;
      const failureCode = "CREDENTIAL_REFRESH_ROTATION_FAILED";
      let refresh: OAuthConnectionStatus | undefined;
      try {
        refresh = await this.maintainConnectionToken(source.namespaceId, source.id);
        if (!refresh) {
          throw new ResourceStateConflictError("The connected account was retired.");
        }
        const outcome = refresh.state === "ready" ? audit : failureAudit?.(failureCode);
        if (outcome) {
          await this.transact((unit) => unit.audit.append(outcome));
        }
      } catch (error) {
        if (failureAudit) {
          await this.transact((unit) => unit.audit.append(failureAudit(failureCode))).catch(
            () => undefined,
          );
        }
        throw error;
      }
      // Commit the new retry schedule and its audit even when no token was minted.
      assertRefreshMinted(refresh);
      return this.credentialSourceMetadata(source, { state: "ready", refresh });
    }
    return rotation;
  }

  /**
   * A gateway write cannot roll back with OCC's transaction, so a request that fails after one
   * began still records a failure event, in its own transaction once the request's has ended.
   * A commit whose outcome is unknown runs no rollback, so it records neither event.
   */
  private auditUncommittedCredentialEffect(
    failureAudit: ((reasonCode: string) => AuditEvent) | undefined,
    reasonCode: string,
  ): void {
    if (failureAudit === undefined) {
      return;
    }
    this.registerRollback(async () => {
      try {
        await this.transact(async (state) => {
          await state.audit.append(failureAudit(reasonCode));
        });
      } catch {
        // The request already failed; a lost failure event must not replace its error.
      }
    });
  }

  /**
   * Removes a failed registration's copy. The record is deleted only when the attempt is
   * terminal and removal succeeded; otherwise it stays `deleting` so DELETE can repeat removal
   * after any late gateway create.
   */
  private async abandonCredentialRegistration(
    namespace: Readonly<Namespace>,
    gateway: CredentialGatewayDriver,
    source: Readonly<CredentialSource>,
    terminal: boolean,
    refresh?: CredentialRefreshDriver,
  ): Promise<void> {
    let removed = true;
    try {
      if (refresh !== undefined) {
        await this.credentialGatewayOperation(() =>
          refresh.removeRefresh({
            namespace,
            source,
            signal: AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS),
          }),
        );
      }
      await this.credentialGatewayOperation(() =>
        gateway.removeSource({
          namespace,
          source,
          signal: AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS),
        }),
      );
    } catch {
      removed = false;
    }
    try {
      await this.mutate(async (state) => {
        await this.lockNamespace(state, source.namespaceId);
        await (removed && terminal
          ? state.credentialSources.deleteCredentialSource(source.namespaceId, source.id)
          : state.credentialSources.markCredentialSourceDeleting(source.namespaceId, source.id));
      });
    } catch {
      // The record stays visible in its last committed state; DELETE completes the cleanup.
    }
  }

  async readCredentialSource(
    principalId: string,
    namespaceId: string,
    credentialSourceId: string,
  ): Promise<Readonly<CredentialSourceMetadata & { readonly status?: CredentialSourceStatus }>> {
    await this.authorize(principalId, "read", {
      kind: "credential_source",
      id: credentialSourceId,
      namespaceId,
    });
    const { namespace, source } = await this.read(async (state) => {
      const exact = await this.exactNamespace(state, namespaceId);
      const found = await state.credentialSources.findCredentialSource(
        namespaceId,
        credentialSourceId,
      );
      if (!found || isManagedTokenServiceSource(found)) {
        throw new ScopeViolationError(
          "The credential source does not belong to the exact Namespace.",
        );
      }
      return { namespace: exact, source: found };
    });
    if (source.ownerCapability === "token_service") {
      const refresh = await this.connectionTokenIssuer().status(
        { kind: "oauth_refresh_token", namespaceId, sourceId: source.id },
        AbortSignal.timeout(CONNECTION_OPERATION_TIMEOUT_MS),
      );
      return this.credentialSourceMetadata(source, {
        state: source.state === "ready" ? refresh.state : "pending",
        refresh,
      });
    }
    if (source.egress !== undefined) {
      try {
        this.credentialSourceOwner(source);
      } catch {
        return this.credentialSourceMetadata(source, {
          state: "failed",
          reason:
            "The Driver that admitted this credential source is no longer selected or available.",
        });
      }
      // Configuration admission is not attachment readiness or proof of usable material.
      const prepared =
        source.egress.adoption !== "prepared" ||
        (source.state === "ready" &&
          (await this.preparedIssuer(source.egress.key.provider).ready(
            source.egress,
            AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS),
          )));
      return this.credentialSourceMetadata(source, {
        state: source.state === "ready" && prepared ? "ready" : "pending",
      });
    }
    let status: CredentialSourceStatus;
    try {
      const gateway = this.ownedCredentialGatewayDriver(source);
      const context = {
        namespace: await this.credentialNamespace(namespace),
        source,
        signal: AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS),
      };
      status = await gateway.sourceStatus(context);
      const refresh =
        status.state === "ready" || status.state === "pending"
          ? await this.refreshDriverForSource(gateway, source.type)
          : undefined;
      if (refresh !== undefined) {
        status = { ...status, refresh: await refresh.refreshStatus(context) };
      }
    } catch (error) {
      // After the grant and the lookup, so naming a driver change reveals nothing new.
      status = {
        state: "failed",
        reason:
          error instanceof CredentialSourceDriverError
            ? "A Credential Gateway Driver that is no longer selected registered the source."
            : "The Credential Gateway status is unavailable.",
      };
    }
    return this.credentialSourceMetadata(source, status);
  }

  async listCredentialSources(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<CredentialSourceMetadata>[]> {
    const namespace = await this.getNamespace(principalId, namespaceId);
    return this.read(async (state) => {
      const readable: Readonly<CredentialSourceMetadata>[] = [];
      for (const source of await state.credentialSources.listCredentialSources(namespace.id)) {
        if (isManagedTokenServiceSource(source)) {
          continue;
        }
        if (
          await this.canRead(principalId, {
            kind: "credential_source",
            id: source.id,
            namespaceId: namespace.id,
          })
        ) {
          readable.push(this.credentialSourceMetadata(source));
        }
      }
      return Object.freeze(readable);
    });
  }

  /**
   * Deletion is caller-retried: the record stays `deleting` until the gateway copy is gone,
   * which keeps the Namespace nonempty and blocks new bindings in the meantime. The record moves
   * to `deleting`, which is one-way, only once the selected gateway registered it, so a refusal
   * after a gateway change leaves the source as it was.
   */
  async deleteCredentialSource(
    principalId: string,
    namespaceId: string,
    credentialSourceId: string,
    audit?: (removedAccessBindings: readonly RemovedAccessBinding[]) => AuditEvent,
    connection?: typeof PENDING_CONNECTION,
  ): Promise<void> {
    return this.deleteRecordedCredentialSource(
      principalId,
      namespaceId,
      credentialSourceId,
      audit,
      connection,
    );
  }

  /** Internal retirement path for staged registrations. The serving API cannot select it. */
  async deleteManagedCredentialSource(
    principalId: string,
    namespaceId: string,
    credentialSourceId: string,
    audit: (removed: readonly RemovedAccessBinding[], phase?: "retirement_started") => AuditEvent,
  ): Promise<void> {
    return this.deleteRecordedCredentialSource(
      principalId,
      namespaceId,
      credentialSourceId,
      audit,
      MANAGED_SOURCE,
    );
  }

  private async deleteRecordedCredentialSource(
    principalId: string,
    namespaceId: string,
    credentialSourceId: string,
    audit?: (removed: readonly RemovedAccessBinding[], phase?: "retirement_started") => AuditEvent,
    connection?: typeof PENDING_CONNECTION | typeof MANAGED_SOURCE,
  ): Promise<void> {
    this.requireIndependentMutation("Credential source registration and deletion");
    this.namespaceIdentity(namespaceId);
    const { namespace, source, gateway } = await this.mutate(async (state) => {
      const locked =
        connection === PENDING_CONNECTION
          ? await this.lockNamespace(state, namespaceId)
          : await this.lockNamespaceForPolicyDelete(state, principalId, {
              kind: "credential_source",
              id: credentialSourceId,
              namespaceId,
            });
      const recorded = await state.credentialSources.lockCredentialSource(
        locked.id,
        credentialSourceId,
      );
      const found =
        connection !== MANAGED_SOURCE && isManagedTokenServiceSource(recorded)
          ? undefined
          : recorded;
      if (found?.ownerCapability !== "token_service") {
        this.assertCredentialSourceOwnerSelected();
      }
      if (!found || (connection === MANAGED_SOURCE && !isManagedTokenServiceSource(found))) {
        throw new ScopeViolationError(
          "The credential source does not belong to the exact Namespace.",
        );
      }
      if (found.ownerCapability === "token_service" && !isManagedTokenServiceSource(found)) {
        const saved = await state.savedConnections.findSavedConnection(
          namespaceId,
          credentialSourceId,
        );
        if (saved || (connection === PENDING_CONNECTION && found.state === "ready")) {
          throw new ResourceStateConflictError("Disconnect the saved account to retire its grant.");
        }
      }
      const blocking = await state.credentialSources.findBlockingReference(locked.id, found.id);
      if (blocking === "reference") {
        throw new ResourceStateConflictError(
          "An Agent, active revision, pending deployment, or provisioning request still references the credential source. Wait for provisioning to finish, or delete those Agents or deploy them without it, first.",
        );
      }
      if (blocking === "withdrawal_work") {
        // No active revision or pending work holds the source, so only waiting or Agent deletion helps.
        throw new CredentialWithdrawalInProgressError();
      }
      const owner =
        found.ownerCapability === "token_service" ? undefined : this.credentialSourceOwner(found);
      if (isManagedTokenServiceSource(found) && found.state === "ready") {
        // A ready source must remain usable if its recorded owner cannot perform retirement.
        this.ownedTokenServiceDriver(found.tokenServiceInstanceId);
      }
      const deleting =
        found.state === "deleting"
          ? found
          : await state.credentialSources.markCredentialSourceDeleting(locked.id, found.id);
      if (deleting === undefined) {
        throw new ResourceStateConflictError("The credential source changed during deletion.");
      }
      if (isManagedTokenServiceSource(deleting) && audit !== undefined) {
        // This attempt is attributable before private custody can be irreversibly retired.
        await state.audit.append(audit([], "retirement_started"));
      }
      return {
        namespace: locked,
        source: deleting,
        gateway: owner?.kind === "gateway" ? owner.driver : undefined,
      };
    });
    await this.retireCredentialSourceMaterial(namespace, source, gateway);
    const fenceMs =
      Date.parse(source.createdAt) + CREDENTIAL_REGISTRATION_FENCE_MS - this.clock().getTime();
    if (source.ownerCapability !== "token_service" && fenceMs > 0) {
      // After the delete grant and lookup; the text names only the wait (finding 2536).
      throw new RetryLaterError("registrationFence", fenceMs / 1000);
    }
    // The success event commits with the final removal, so a completed deletion is always audited.
    await this.mutate(async (state) => {
      await this.lockNamespace(state, namespace.id);
      const removed = await accessBindingsTargeting(
        state,
        namespace.id,
        "credential_source",
        source.id,
      );
      if (!(await state.credentialSources.deleteCredentialSource(namespace.id, source.id))) {
        throw new ResourceStateConflictError("The credential source changed during deletion.");
      }
      if (audit !== undefined) {
        await state.audit.append(audit(removed));
      }
    });
  }

  private async retireCredentialSourceMaterial(
    namespace: Readonly<Namespace>,
    source: Readonly<CredentialSource>,
    gateway: CredentialGatewayDriver | undefined,
  ): Promise<void> {
    if (isManagedTokenServiceSource(source)) {
      // The registration writer must claim dispatch while the source is registering. A
      // deleting reservation without that claim cannot have sent material to any owner.
      if (!source.registration && !source.registrationDispatchedAt) {
        return;
      }
      const owner = this.ownedTokenServiceDriver(source.tokenServiceInstanceId);
      if (!source.registration && source.registrationDispatchedAt) {
        const remaining =
          Date.parse(source.registrationDispatchedAt) +
          CREDENTIAL_REGISTRATION_FENCE_MS -
          this.clock().getTime();
        if (!Number.isFinite(remaining)) {
          throw new ResourceStateConflictError("The registration dispatch time is invalid.");
        }
        if (remaining > 0) {
          throw new RetryLaterError("registrationFence", remaining / 1000);
        }
      }
      await this.driverOperation(
        () =>
          owner.removeSource(
            {
              sourceRef: credentialSourceRef(source),
              tokenServiceInstanceId: source.tokenServiceInstanceId,
              ...(source.registration && { registration: source.registration }),
            },
            AbortSignal.timeout(CONNECTION_OPERATION_TIMEOUT_MS),
          ),
        "TokenService",
      );
      return;
    }
    if (source.ownerCapability === "token_service") {
      await this.connectionTokenIssuer().retire(
        { kind: "oauth_refresh_token", namespaceId: namespace.id, sourceId: source.id },
        AbortSignal.timeout(CONNECTION_OPERATION_TIMEOUT_MS),
      );
      return;
    }
    const placed = gateway ? await this.credentialNamespace(namespace) : namespace;
    const context = () => ({
      namespace: placed,
      source,
      signal: AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS),
    });
    if (source.egress?.adoption === "prepared") {
      await this.preparedIssuer(source.egress.key.provider).withdraw(
        source.egress,
        AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS),
      );
    } else if (gateway && source.egress?.adoption !== "credential_free") {
      const refresh = await this.refreshDriverForSource(gateway, source.type);
      if (refresh !== undefined) {
        await this.credentialGatewayOperation(() => refresh.removeRefresh(context()));
      }
      await this.credentialGatewayOperation(() => gateway.removeSource(context()));
    }
  }

  async createConfiguration(
    principalId: string,
    input: CreateConfigurationInput,
  ): Promise<Readonly<Configuration>> {
    return this.configurationOperations.createConfiguration(principalId, input);
  }

  private readonly serviceAccountOperations = createServiceAccountOperations({
    read: (work) => this.read(work),
    mutate: (work) => this.mutate(work),
    authorize: (principalId, action, target) => this.authorize(principalId, action, target),
    holdAuthority: (state) => this.holdAuthority(state),
    bindCreator: (state, principalId, target) => this.bindCreator(state, principalId, target),
    namespaceIdentity: (namespaceId) => this.namespaceIdentity(namespaceId),
    getNamespace: (principalId, namespaceId) => this.getNamespace(principalId, namespaceId),
    exactNamespace: (state, namespaceId) => this.exactNamespace(state, namespaceId),
    lockNamespace: (state, namespaceId) => this.lockNamespace(state, namespaceId),
    lockNamespaceForPolicyDelete: (state, principalId, target) =>
      this.lockNamespaceForPolicyDelete(state, principalId, target),
    readableListRows: (principalId, namespaceId, kind, rows) =>
      this.readableListRows(principalId, namespaceId, kind, rows),
    serviceAccountDriver: () => this.serviceAccountDriver(),
    computeDriver: () => this.selectedDriver("compute"),
    hasConfiguredDriver: () => this.configuredServiceAccountDriverId !== undefined,
    driverOperation: (operation, capability) => this.driverOperation(operation, capability),
    nextIdentifier: (kind) => this.nextIdentifier(kind),
  });

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
    await this.authorize(principalId, "operate", {
      kind: "credential_source",
      namespaceId,
      id: sourceId,
    });
    return this.credentialSourceContext(namespaceId, sourceId);
  }

  private async credentialSourceContext(namespaceId: string, sourceId: string) {
    const { namespace, source } = await this.read(async (state) => {
      const namespace = await this.exactNamespace(state, namespaceId);
      const source = await state.credentialSources.findCredentialSource(namespaceId, sourceId);
      if (namespace.status !== "ready" || source?.state !== "ready") {
        throw new ResourceStateConflictError(
          "The credential source is unavailable. Connect again.",
        );
      }
      return { namespace, source };
    });
    return {
      gateway: this.ownedCredentialGatewayDriver(source),
      context: {
        namespace: await this.credentialNamespace(namespace),
        source,
        signal: AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS),
      },
    };
  }

  async startAgentDeviceAuthorization(
    principalId: string,
    namespaceId: string,
    harnessId: string,
    agentId?: string,
    audit?: (
      source: Readonly<CredentialSourceMetadata>,
      phase: "source_registering" | "source_ready" | "session_pending",
    ) => AuditEvent,
  ) {
    await this.authorizeDeviceAuthorizationScope(principalId, namespaceId, agentId);
    // The source registration below checks credential source create again. Checking it here too
    // means a caller who can never start gets the 403 naming that grant, not the Driver-selection
    // 501, and no Gateway call (finding 2995).
    await this.authorize(principalId, "create", {
      kind: "credential_source",
      id: namespaceId,
      namespaceId,
    });
    if (
      !this.drivers.hasSelection("credential_gateway") ||
      !this.drivers.hasSelection("credential_refresh")
    ) {
      throw new NotImplementedError(
        "agent_device_authorization",
        "Device login needs a Credential Gateway and a Credential Refresh Driver, and this Installation does not select both. Ask an Installation administrator to select them; see the credential lifecycle guide.",
      );
    }
    const gateway = this.credentialGatewayDriver();
    const refresh = this.credentialRefreshDriver();
    const cipher = this.deviceLoginCipher;
    if (!refresh.startDeviceAuthorization || !refresh.pollDeviceAuthorization || !cipher) {
      throw new NotImplementedError(
        "agent_device_authorization",
        "Device authorization is unavailable for the selected Drivers.",
      );
    }
    const types = await this.credentialGatewayOperation(() =>
      gateway.listSourceTypes({ signal: AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS) }),
    );
    const supported = types.filter(
      (type) => type.rotation === "refresh" && type.deviceAuthorization?.harnessId === harnessId,
    );
    if (supported.length !== 1) {
      throw new NotImplementedError(
        "agent_device_authorization",
        "The Credential Gateway must provide one device-login source for this Harness.",
      );
    }
    // Persist the source before external login. Failed or abandoned attempts remain visible
    // in credential-source management; closing a login must never revoke an Agent's source.
    const source = await this.createCredentialSource(
      principalId,
      {
        namespaceId,
        name: `Device login ${crypto.randomUUID()}`,
        type: supported[0]!.type,
      },
      audit === undefined ? undefined : (source) => audit(source, "source_ready"),
      audit === undefined ? undefined : (source) => audit(source, "source_registering"),
    );
    const { context } = await this.credentialSourceContext(namespaceId, source.id);
    // Registration can outlive an IAM change; check the start authority again before provider I/O.
    await this.authorizeDeviceAuthorizationScope(principalId, namespaceId, agentId);
    await this.authorize(principalId, "create", {
      kind: "credential_source",
      id: namespaceId,
      namespaceId,
    });
    let started: CredentialSourceDeviceAuthorization;
    try {
      started = await refresh.startDeviceAuthorization(context);
    } catch (error) {
      throw error instanceof DeviceAuthorizationStartError
        ? error
        : new DeviceAuthorizationStartError("unavailable");
    }
    await this.authorizeDeviceAuthorizationScope(principalId, namespaceId, agentId);
    const { privateState, intervalSeconds, userCode, verificationUrl } = started;
    const expiresAt = new Date(started.expiresAt).toISOString();
    const sessionId = this.nextIdentifier("secret");
    const handle = { id: sessionId, namespaceId };
    const session: DeviceAuthorizationSession = {
      actorId: principalId,
      namespaceId,
      ...(agentId === undefined ? {} : { agentId }),
      harnessId,
      credentialGatewayId: gateway.id,
      credentialRefreshId: refresh.id,
      sourceId: source.id,
      phase: "pending",
      expiresAt,
      nextPollAt: new Date(Date.parse(this.timestamp()) + intervalSeconds * 1000).toISOString(),
      intervalSeconds,
    };
    const encrypted = cipher.seal(
      privateState,
      deviceAuthorizationScope(this.installation.id, sessionId, session, "provider_handle"),
    );
    const encryptedChallenge = cipher.seal(
      JSON.stringify({ verificationUrl, userCode }),
      deviceAuthorizationScope(this.installation.id, sessionId, session, "challenge"),
    );
    await this.mutate(async (state) => {
      await this.holdAuthority(state);
      const namespace = await this.lockNamespace(state, namespaceId);
      await this.authorize(principalId, "create", {
        kind: "credential_source",
        id: namespaceId,
        namespaceId,
      });
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      await state.authenticationStates.create({
        ...session,
        kind: "device_authorization",
        id: sessionId,
        version: 1,
        encryptedChallenge,
        privateState: encrypted,
      });
      if (audit !== undefined) {
        await state.audit.append(audit(source, "session_pending"));
      }
    });
    return {
      session: handle,
      status: "pending" as const,
      expiresAt,
      intervalSeconds,
      userCode,
      verificationUrl,
    };
  }

  private replaceDeviceAuthorization(
    id: string,
    version: number,
    session: DeviceAuthorizationSession,
  ) {
    return this.mutate((state) =>
      state.authenticationStates.replaceDevice(session.namespaceId, id, version, session),
    );
  }

  private async readAgentDeviceAuthorization(
    principalId: string,
    namespaceId: string,
    sessionId: string,
    agentId?: string,
  ) {
    await this.authorizeDeviceAuthorizationScope(principalId, namespaceId, agentId);
    const stored = await this.read((state) =>
      state.authenticationStates.findDevice(namespaceId, sessionId),
    );
    if (stored === undefined) {
      throw new ScopeViolationError("The login does not belong to the exact Namespace.");
    }
    if (stored.actorId !== principalId || stored.agentId !== agentId) {
      throw new DeviceAuthorizationScopeMismatchError();
    }
    return stored;
  }

  async pollAgentDeviceAuthorization(
    principalId: string,
    namespaceId: string,
    sessionId: string,
    agentId?: string,
  ) {
    const session = await this.readAgentDeviceAuthorization(
      principalId,
      namespaceId,
      sessionId,
      agentId,
    );
    const { version } = session;
    await this.authorize(principalId, "operate", {
      kind: "credential_source",
      namespaceId,
      id: session.sourceId,
    });
    if (
      session.phase === "cancelled" ||
      Date.parse(session.expiresAt) <= Date.parse(this.timestamp())
    ) {
      if (session.phase !== "cancelled") {
        // Expiry closes the login handle; the separately managed credential source survives.
        await this.replaceDeviceAuthorization(
          sessionId,
          version,
          cancelledDeviceAuthorization(session),
        );
      }
      throw new ResourceStateConflictError("Device login expired or was cancelled. Connect again.");
    }
    const { gateway, context } = await this.credentialSourceContext(namespaceId, session.sourceId);
    const refresh = this.drivers.hasSelection("credential_refresh")
      ? this.credentialRefreshDriver()
      : undefined;
    if (
      gateway.id !== session.credentialGatewayId ||
      refresh?.id !== session.credentialRefreshId ||
      !refresh.pollDeviceAuthorization
    ) {
      throw new ResourceStateConflictError("The login Driver changed. Connect again.");
    }
    const cipher = this.deviceLoginCipher;
    if (!cipher) {
      throw new NotImplementedError(
        "agent_device_authorization",
        "Device login session encryption is unavailable.",
      );
    }
    if (!session.encryptedChallenge) {
      throw new ResourceStateConflictError(
        "This login is no longer available in OCE. Connect again.",
      );
    }
    const challenge = JSON.parse(
      cipher.open(
        session.encryptedChallenge,
        deviceAuthorizationScope(this.installation.id, sessionId, session, "challenge"),
      ),
    ) as Pick<CredentialSourceDeviceAuthorization, "verificationUrl" | "userCode">;
    const response = (status: "pending" | "ready", expiresAt = session.expiresAt) => ({
      session: { id: sessionId, namespaceId },
      ...(status === "ready" ? { source: this.credentialSourceMetadata(context.source).ref } : {}),
      status,
      expiresAt,
      intervalSeconds: session.intervalSeconds,
      ...challenge,
    });
    if (session.phase === "ready") {
      return response("ready");
    }
    if (
      session.phase === "polling" ||
      Date.parse(session.nextPollAt) > Date.parse(this.timestamp())
    ) {
      return response("pending");
    }
    const { privateState, ...metadata } = session;
    if (!privateState) {
      throw new ResourceStateConflictError(
        "This login is no longer available in OCE. Connect again.",
      );
    }
    const handle = cipher.open(
      privateState,
      deviceAuthorizationScope(this.installation.id, sessionId, session, "provider_handle"),
    );
    if (
      !(await this.replaceDeviceAuthorization(sessionId, version, { ...session, phase: "polling" }))
    ) {
      return response("pending");
    }
    const claimedVersion = version + 1;
    let result: CredentialSourceDeviceAuthorizationResult;
    try {
      result = await refresh.pollDeviceAuthorization(context, handle);
    } catch (error) {
      // An uncertain external exchange is not replayed. The source remains visible for recovery.
      await this.replaceDeviceAuthorization(
        sessionId,
        claimedVersion,
        cancelledDeviceAuthorization(session),
      );
      throw new RetryLaterError("deviceLoginFailed", error);
    }
    await this.authorizeDeviceAuthorizationScope(principalId, namespaceId, agentId);
    const current = await this.authorizedCredentialSource(
      principalId,
      namespaceId,
      session.sourceId,
    );
    if (
      current.gateway.id !== session.credentialGatewayId ||
      !this.drivers.hasSelection("credential_refresh") ||
      this.credentialRefreshDriver().id !== session.credentialRefreshId
    ) {
      throw new ResourceStateConflictError("The login Driver changed. Connect again.");
    }
    if (Date.parse(session.expiresAt) <= Date.parse(this.timestamp())) {
      await this.replaceDeviceAuthorization(
        sessionId,
        claimedVersion,
        cancelledDeviceAuthorization(session),
      );
      throw new ResourceStateConflictError("Device login expired or was cancelled. Connect again.");
    }
    const next: DeviceAuthorizationSession =
      result.status === "pending"
        ? {
            ...session,
            phase: "pending",
            nextPollAt: new Date(
              Date.parse(this.timestamp()) + session.intervalSeconds * 1000,
            ).toISOString(),
          }
        : {
            ...metadata,
            phase: "ready",
            expiresAt: new Date(Date.parse(this.timestamp()) + 24 * 60 * 60 * 1000).toISOString(),
          };
    if (!(await this.replaceDeviceAuthorization(sessionId, claimedVersion, next))) {
      throw new ResourceStateConflictError("The login changed while completing. Connect again.");
    }
    return response(result.status, next.expiresAt);
  }

  async cancelAgentDeviceAuthorization(
    principalId: string,
    namespaceId: string,
    sessionId: string,
    agentId?: string,
  ): Promise<void> {
    const session = await this.readAgentDeviceAuthorization(
      principalId,
      namespaceId,
      sessionId,
      agentId,
    );
    const { version } = session;
    // Local discard must never revoke a shared upstream login session.
    if (
      !(await this.replaceDeviceAuthorization(
        sessionId,
        version,
        cancelledDeviceAuthorization(session),
      ))
    ) {
      throw new ResourceStateConflictError("The login session changed. Refresh and retry.");
    }
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
    await this.authorize(principalId, "create", { kind: "agent", id: namespaceId, namespaceId });
    await this.read((state) => this.exactNamespace(state, namespaceId));
    const driver = this.selectedDriver("compute");
    if (!driver.discoverHarnessModels) {
      throw new NotImplementedError(
        "agent_models.discovery",
        "Model discovery is unavailable. Enter a model ID manually.",
      );
    }
    // Discovery performs no platform writes and must not hold a transaction over provider I/O.
    try {
      return await driver.discoverHarnessModels(input);
    } catch (error) {
      throw new ModelDiscoveryError(
        error instanceof ModelDiscoveryError ? error.reason : "unavailable",
      );
    }
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
    const ids = input.ids;
    // Lengths count code points, as the API contract's JSON Schema maxLength does.
    const characters = (value: string): number => Array.from(value).length;
    const bounded = (value: unknown, max: number, allowEmpty = false): value is string =>
      typeof value === "string" &&
      (allowEmpty || value.length > 0) &&
      characters(value) <= max &&
      !value.includes("\u0000");
    if (
      !bounded(input.secretId, 200) ||
      (input.kind !== "users" && input.kind !== "channels") ||
      (input.query !== undefined && !bounded(input.query, 200, true)) ||
      (input.cursor !== undefined && !bounded(input.cursor, 2048)) ||
      (ids !== undefined &&
        (!Array.isArray(ids) ||
          ids.length === 0 ||
          ids.length > 20 ||
          ids.some(
            (id) =>
              typeof id !== "string" ||
              id.length === 0 ||
              characters(id) > 200 ||
              hasControlCharacter(id),
          ) ||
          new Set(ids).size !== ids.length ||
          input.query !== undefined ||
          input.cursor !== undefined)) ||
      (input.agentId !== undefined && !bounded(input.agentId, 200)) ||
      (input.configurationId !== undefined && !bounded(input.configurationId, 200)) ||
      (input.agentId !== undefined && input.configurationId !== undefined)
    ) {
      throw new ScopeViolationError("The channel directory lookup input is invalid.");
    }
    const first = await this.channelDirectorySecret(principalId, namespaceId, input);
    let driver: ChannelDriver;
    try {
      driver = this.selectedDriver("channel");
    } catch {
      throw new NotImplementedError(
        "channel_directory.lookup",
        "Channel directory lookup is unavailable.",
      );
    }
    if (!first.driver.withValue) {
      throw new DependencyUnavailableError(
        "The selected Secret Driver cannot use credentials for directory lookup.",
      );
    }
    const outcome = await this.secretOperation(() =>
      first.driver.withValue!(first.secret, async (token) => {
        if (!isNonEmptyString(token)) {
          return { error: new ChannelDirectoryError("invalid_response") };
        }
        try {
          // Recheck the exact target grant and Secret identity after backend I/O.
          const current = await this.channelDirectorySecret(principalId, namespaceId, input);
          if (!sameSecretBackend(first.secret, current.secret)) {
            return {
              validationError: new ResourceStateConflictError(
                "The channel directory credential changed. Refresh and retry.",
              ),
            };
          }
        } catch (error) {
          return { validationError: error };
        }
        try {
          const result = await driver.lookupDirectory(
            {
              token,
              kind: input.kind,
              ...(input.query === undefined ? {} : { query: input.query }),
              ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
              ...(ids === undefined ? {} : { ids }),
            },
            signal,
          );
          if (
            !validChannelDirectoryResult(result) ||
            (ids !== undefined &&
              (!result.complete ||
                result.nextCursor !== undefined ||
                result.candidates.some((candidate) => !ids.includes(candidate.id))))
          ) {
            return { error: new ChannelDirectoryError("invalid_response") };
          }
          const safeResult = {
            workspaceId: result.workspaceId,
            ...(result.workspaceName === undefined ? {} : { workspaceName: result.workspaceName }),
            candidates: result.candidates.map((candidate) => ({
              id: candidate.id,
              name: candidate.name,
              ...(candidate.displayName === undefined
                ? {}
                : { displayName: candidate.displayName }),
            })),
            ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
            complete: result.complete,
          };
          if (JSON.stringify(safeResult).includes(JSON.stringify(token).slice(1, -1))) {
            return { error: new ChannelDirectoryError("invalid_response") };
          }
          return { value: immutableCopy(safeResult) };
        } catch (error) {
          return {
            error: new ChannelDirectoryError(
              error instanceof ChannelDirectoryError ? error.reason : "unavailable",
            ),
          };
        }
      }),
    );
    if ("validationError" in outcome) {
      throw outcome.validationError;
    }
    if ("error" in outcome) {
      throw outcome.error;
    }
    return outcome.value;
  }

  private async channelDirectorySecret(
    principalId: string,
    namespaceId: string,
    input: LookupChannelDirectoryInput,
  ): Promise<{ readonly secret: Readonly<Secret>; readonly driver: SecretDriver }> {
    if (input.agentId !== undefined) {
      await this.authorize(principalId, "update", {
        kind: "agent",
        id: input.agentId,
        namespaceId,
      });
    } else if (input.configurationId !== undefined) {
      await this.authorize(principalId, "update", {
        kind: "configuration",
        id: input.configurationId,
        namespaceId,
      });
    } else {
      await this.authorize(principalId, "create", {
        kind: "agent",
        id: namespaceId,
        namespaceId,
      });
    }
    await this.authorize(principalId, "operate", {
      kind: "secret",
      id: input.secretId,
      namespaceId,
    });
    return this.read(async (state) => {
      const namespace = await this.exactNamespace(state, namespaceId);
      if (input.agentId !== undefined) {
        const agent = await state.agents.findAgent(namespace.id, input.agentId);
        if (agent === undefined) {
          throw new ScopeViolationError("The Agent does not belong to the exact Namespace.");
        }
        if (agent.status !== "active") {
          throw new AgentDeletingError();
        }
      } else if (input.configurationId !== undefined) {
        const configuration = await state.configurations.findConfiguration(
          namespace.id,
          input.configurationId,
        );
        if (configuration?.kind !== "agent") {
          throw new ScopeViolationError(
            "The Configuration does not belong to the exact Namespace.",
          );
        }
      }
      const secret = await state.secrets.findSecret(namespace.id, input.secretId);
      if (secret === undefined) {
        throw new ScopeViolationError("The Secret does not belong to the exact Namespace.");
      }
      return { secret, driver: this.secretDriver(secret.driverId) };
    });
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
    if (context.scope === "installation") {
      await this.authorize(principalId, "administer", {
        kind: "installation",
        id: this.installation.id,
      });
      return this.configurations
        .list("installation")
        .filter((entry) => this.configurationDriverSelected(entry.capability, entry.driverId))
        .map((entry) => ({
          capability: entry.capability,
          driverId: entry.driverId,
          implementation: entry.implementation,
          scope: entry.contribution.scope,
          key: entry.contribution.key,
          configurationSchema: entry.contribution.configurationSchema,
          ...(entry.startupConfiguration === undefined
            ? {}
            : { startupConfiguration: entry.startupConfiguration }),
          binding: entry.binding,
          actions: {},
        }));
    }
    if (context.scope !== "agent") {
      throw new ScopeViolationError("Unsupported configuration scope.");
    }
    const { namespaceId, agentId } = context;
    await this.authorize(principalId, "read", { kind: "agent", id: agentId, namespaceId });
    await this.read(async (state) => {
      await this.exactNamespace(state, namespaceId);
      if ((await state.agents.findAgent(namespaceId, agentId)) === undefined) {
        throw new ScopeViolationError("The Agent is unavailable in this Namespace.");
      }
    });
    const configurations: DriverConfigurationDescriptor[] = [];
    for (const entry of this.configurations.list("agent")) {
      if (!this.configurationDriverSelected(entry.capability, entry.driverId)) {
        continue;
      }
      if (entry.binding === "sandbox-policy") {
        const decision = await this.authorizationDecision(principalId, "read", {
          kind: "sandbox_policy",
          id: `sbp_${agentId.slice(4)}`,
          namespaceId,
        });
        if (!decision.decision.allowed) {
          continue;
        }
        const view = await this.getAgentSandboxPolicy(
          principalId,
          namespaceId,
          agentId,
          "networking",
        );
        if (view.configuration !== undefined) {
          configurations.push(view.configuration);
        }
      }
    }
    return configurations;
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
    configurationPreparation?: {
      readonly expectedGeneration: number;
      readonly prepare: (
        agent: Pick<Agent, "id" | "namespaceId">,
        values: Readonly<OpenClawConfigurationDocument>,
      ) => Readonly<OpenClawConfigurationDocument>;
    },
  ): Promise<Readonly<Agent>> {
    if (!isName(input.name)) {
      throw new ScopeViolationError("The Agent name is invalid.");
    }
    if (!isNonEmptyString(input.configurationId)) {
      throw new ScopeViolationError("The exact Agent Configuration identity is missing.");
    }
    let initialWorkspaceFiles: InitialWorkspaceFiles | undefined;
    let workspaceDefaultsId: string | undefined;
    try {
      initialWorkspaceFiles = normalizeInitialWorkspaceFiles(input.initialWorkspaceFiles);
      workspaceDefaultsId = normalizeWorkspaceDefaultsId(input.workspaceDefaultsId);
    } catch {
      throw new ScopeViolationError("The initial workspace setup input is invalid.");
    }
    const harnessAuth = this.harnessAuthBinding(input.harnessAuth ?? null);
    const credentialSources = this.agentCredentialSources(input.credentialSources);
    const executionMode = input.executionMode ?? "embedded";
    if (!validExecutionMode(executionMode)) {
      throw new ScopeViolationError("The Agent Harness execution mode is invalid.");
    }
    const gatewayManagedMode = normalizeGatewayManagedMode(
      input.gatewayManagedMode,
      this.gatewayManagedModeSupported(),
    );
    const plugins = normalizeAgentPlugins(input.plugins);
    const pluginApprovers = normalizeAgentPluginApprovers(input.pluginApprovers);
    this.namespaceIdentity(input.namespaceId);
    return this.mutate(async (state) => {
      await this.holdAuthority(state);
      const target: ResourceRef = {
        kind: "agent",
        id: input.namespaceId,
        namespaceId: input.namespaceId,
      };
      await this.authorize(principalId, "create", target);
      await this.authorizeGatewayManagedModeChange(principalId, input.gatewayManagedMode === false);
      this.requireGatewayManagedModeSupport(gatewayManagedMode);
      const namespace = await this.lockNamespace(state, input.namespaceId);
      // AccessBinding deletes hold this lock: authorize again so a revocation that committed
      // while this write waited stops it before it leaves a durable Owner binding or grant.
      await this.authorize(principalId, "create", target);
      const backendId = this.backendId(input.backendId);
      // Checked after authorization: the conflict names the Namespace state.
      if (namespace.status !== "provisioning" && namespace.status !== "ready") {
        throw new ResourceStateConflictError("The Namespace does not accept new Agents.");
      }
      await this.authorize(principalId, "read", {
        kind: "configuration",
        id: input.configurationId,
        namespaceId: namespace.id,
      });
      let configuration = await state.configurations.findConfiguration(
        namespace.id,
        input.configurationId,
      );
      if (!configuration || configuration.kind !== "agent") {
        throw new ScopeViolationError(
          "The Agent Configuration must belong to the exact Namespace and configure an Agent.",
        );
      }
      await this.guardProvisioningConfiguration(state, namespace.id, input.configurationId);
      rejectCrossNamespaceSecretSources(namespace.id, undefined, harnessAuth);
      await this.authorizeHarnessAuthSource(state, principalId, namespace.id, harnessAuth);
      const sources = await this.authorizeAgentCredentialSources(
        state,
        principalId,
        namespace.id,
        credentialSources ?? [],
        harnessAuth,
      );
      const agentId = this.nextIdentifier("agent");
      await this.authorizeBindings(
        state,
        principalId,
        namespace.id,
        this.bindings(configuration.secretBindings),
      );
      if (configurationPreparation !== undefined) {
        await this.authorize(principalId, "update", {
          kind: "configuration",
          id: configuration.id,
          namespaceId: namespace.id,
        });
        if (configuration.generation !== configurationPreparation.expectedGeneration) {
          throw new ConfigurationGenerationConflictError();
        }
        // The Namespace lock serializes Agent creation and Configuration replacement. A
        // caller must not change another Agent's shared Configuration as a create side effect.
        const existingAgents = await state.agents.listAgents(namespace.id);
        if (existingAgents.some((agent) => agent.configurationId === input.configurationId)) {
          throw new ResourceStateConflictError(
            "Browser access setup requires a Configuration that no Agent references.",
          );
        }
        const previous = await this.savedConfigurationReader(configuration)();
        const prepared = await this.updateConfiguration(principalId, {
          namespaceId: namespace.id,
          configurationId: configuration.id,
          expectedGeneration: configurationPreparation.expectedGeneration,
          values: configurationPreparation.prepare(
            { id: agentId, namespaceId: namespace.id },
            previous.values,
          ),
        });
        configuration = { ...configuration, generation: prepared.generation };
      }
      const savedConfiguration = this.savedConfigurationReader(configuration);
      const driver = await this.validateAgentPlugins(
        plugins,
        pluginApprovers,
        async () => (await savedConfiguration()).values,
      );
      await this.validatePluginCredentialSources(driver, plugins, sources, harnessAuth);
      const { repositoryBindings, repositoryAccess } = this.repositorySettings(namespace.id, input);
      await this.validateSavedAgentTopology(
        state,
        resolveHarness,
        {
          executionMode,
          harnessAuth: () => this.savedHarnessAuthSnapshot(state, namespace.id, harnessAuth),
          repositoryBindings,
          workspaceSetup: initialWorkspaceFiles !== undefined,
          plugins,
          pluginDriver: driver,
        },
        savedConfiguration,
      );

      const agent = await state.agents.createAgent({
        id: agentId,
        namespaceId: namespace.id,
        name: input.name,
        configurationId: input.configurationId,
        backendId,
        harnessAuth,
        ...(credentialSources === undefined || credentialSources.length === 0
          ? {}
          : { credentialSources }),
        executionMode,
        gatewayManagedMode,
        ...(plugins === undefined ? {} : { plugins }),
        ...(driver && plugins && Object.keys(plugins).length
          ? { pluginDriver: this.pluginOwner(driver) }
          : {}),
        ...(pluginApprovers === undefined ? {} : { pluginApprovers }),
        ...(repositoryBindings === undefined ? {} : { repositoryBindings }),
        ...(repositoryAccess === undefined ? {} : { repositoryAccess }),
        servicePrincipalId: `service-agent-${agentId}`,
        desiredRuntimeState: "stopped",
        status: "active",
        createdAt: this.timestamp(),
      });
      await this.bindCreator(state, principalId, {
        kind: "agent",
        id: agent.id,
        namespaceId: namespace.id,
      });
      if (initialWorkspaceFiles !== undefined) {
        await state.workspaceSetups.create({
          id: crypto.randomUUID(),
          namespaceId: namespace.id,
          agentId,
          ...(workspaceDefaultsId === undefined ? {} : { defaultsId: workspaceDefaultsId }),
          files: initialWorkspaceFiles,
          completed: false,
        });
      }
      return agent;
    });
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
    if (input.name !== undefined && !isName(input.name)) {
      throw new ScopeViolationError("The Agent name is invalid.");
    }
    let initialWorkspaceFiles: InitialWorkspaceFiles | undefined;
    try {
      initialWorkspaceFiles = normalizeInitialWorkspaceFiles(input.initialWorkspaceFiles);
    } catch {
      throw new ScopeViolationError("The initial workspace setup input is invalid.");
    }
    const executionMode = input.executionMode ?? "embedded";
    if (!validExecutionMode(executionMode)) {
      throw new ScopeViolationError("The Agent Harness execution mode is invalid.");
    }
    const plugins = normalizeAgentPlugins(input.plugins);
    const pluginApprovers = normalizeAgentPluginApprovers(input.pluginApprovers);
    const harnessAuth = this.plannedHarnessAuth(input.harnessAuth ?? null);
    this.namespaceIdentity(input.namespaceId);
    await this.authorize(principalId, "create", {
      kind: "agent",
      id: input.namespaceId,
      namespaceId: input.namespaceId,
    });
    await this.authorizeGatewayManagedModeChange(
      principalId,
      normalizeGatewayManagedMode(input.gatewayManagedMode, true) === false,
    );
    this.requireGatewayManagedModeSupport(
      normalizeGatewayManagedMode(input.gatewayManagedMode, this.gatewayManagedModeSupported()),
    );
    await this.read(async (state) => {
      const namespace = await this.exactNamespace(state, input.namespaceId);
      if (namespace.status !== "provisioning" && namespace.status !== "ready") {
        throw new ResourceStateConflictError("The Namespace does not accept new Agents.");
      }
      if (input.configuration?.kind !== "agent") {
        throw new ScopeViolationError("The Configuration kind must identify an Agent.");
      }
      const values = frozenValues(input.configuration.values);
      const secretBindings =
        input.configuration.secretBindings === undefined
          ? undefined
          : normalizeRequestSecretBindings(
              input.configuration.secretBindings,
              "/configuration/secretBindings",
            );
      // The form saves the Configuration first, so its content rules answer first, in
      // createConfiguration's order.
      rejectCrossNamespaceSecretSources(namespace.id, secretBindings, undefined);
      const configurationDriver = this.configurationDriver();
      // Use one unsaved Configuration for Driver admission and Agent topology checks.
      const configuration: Configuration = Object.freeze({
        id: "cfg_00000000-0000-4000-8000-000000000000",
        namespaceId: namespace.id,
        kind: "agent",
        generation: 1,
        values,
        createdAt: this.timestamp(),
      });
      await configurationDriver.validateSize?.(values);
      this.validateConfigurationContent(values, undefined, secretBindings);
      await configurationDriver.validate(configuration);
      const driver = await this.validateAgentPlugins(plugins, pluginApprovers, () => values);
      rejectCrossNamespaceSecretSources(
        namespace.id,
        undefined,
        harnessAuth === null || "source" in harnessAuth ? harnessAuth : null,
      );
      await this.validateSavedAgentTopology(
        state,
        resolveHarness,
        {
          executionMode,
          harnessAuth: async () => this.plannedHarnessAuthSnapshot(namespace.id, harnessAuth),
          repositoryBindings: undefined,
          workspaceSetup: initialWorkspaceFiles !== undefined,
          plugins,
          pluginDriver: driver,
        },
        async () => configuration,
      );
      // After `agent:create` in this Namespace, as create's 409 reveals the name (errors.ts).
      if (input.name !== undefined) {
        await this.refuseTakenAgentName(state, namespace.id, input.name);
      }
    });
  }

  /** Agent create's duplicate-name refusal, for callers authorized to create an Agent there. */
  private async refuseTakenAgentName(
    state: Pick<PlatformReadView, "agents">,
    namespaceId: string,
    name: string,
  ): Promise<void> {
    if (await state.agents.hasAgentNamed(namespaceId, name)) {
      throw new ResourceStateConflictError(AGENT_NAME_CONFLICT);
    }
  }

  async listAgentStandingApprovals(principalId: string, namespaceId: string, agentId: string) {
    await this.authorize(principalId, "administer", { kind: "agent", id: agentId, namespaceId });
    return this.read(async (state) => {
      await this.exactNamespace(state, namespaceId);
      if (!(await state.agents.findAgent(namespaceId, agentId))) {
        throw new ScopeViolationError("Agent does not belong to the exact Namespace.");
      }
      return (await state.repositorySessions.listStandingApprovals(namespaceId, agentId)).map(
        (approval) => ({
          id: approval.id,
          repositoryRef: approval.binding.repositoryRef,
          profile: approval.binding.profile,
          generation: approval.generation,
          scopeFingerprint: approval.scopeFingerprint,
          approvedBy: approval.approvedBy,
          createdAt: approval.createdAt,
          ...(approval.revokedAt ? { revokedAt: approval.revokedAt } : {}),
          status: approval.revokedAt ? ("removed" as const) : ("active" as const),
        }),
      );
    });
  }

  /** A review projection only: it neither creates nor extends authority. */
  async listAgentStandingApprovalScopes(principalId: string, namespaceId: string, agentId: string) {
    await this.authorize(principalId, "administer", { kind: "agent", id: agentId, namespaceId });
    return this.read(async (state) => {
      const agent = await state.agents.findAgent(namespaceId, agentId);
      if (!agent) {
        throw new ScopeViolationError("Agent does not belong to the exact Namespace.");
      }
      // TODO: support multiple independently approved bindings when session admission supports them.
      // Without a repository Driver nothing can be approved (finding 2362).
      if (agent.repositoryBindings?.length !== 1 || !this.repositoryConfigured) {
        return [];
      }
      const resolved = this.resolveRepositoryBindings(
        namespaceId,
        agent.repositoryBindings,
        "saved",
        this.selectedStandingRepositoryAdmission(),
      );
      return (resolved?.resolution.bindings ?? []).flatMap((binding) => {
        const scope = eligibleRepositoryApprovalScope(resolved!.driver, { namespaceId, binding });
        return scope
          ? [
              {
                repositoryRef: binding.repositoryRef,
                binding,
                scope,
                scopeFingerprint: repositoryApprovalFingerprint({
                  namespaceId,
                  agentId,
                  binding,
                  scope,
                }),
              },
            ]
          : [];
      });
    });
  }

  /** Denial commits independently of configuration, provider availability or runtime cleanup. */
  async removeAgentStandingApproval(
    principalId: string,
    input: RemoveStandingApprovalInput,
  ): Promise<void> {
    await this.authorize(principalId, "administer", {
      kind: "agent",
      id: input.agentId,
      namespaceId: input.namespaceId,
    });
    await this.mutate(async (state) => {
      await state.namespaces.lockNamespace(input.namespaceId, { includeDeleted: true });
      const agent = await state.agents.lockAgent(input.namespaceId, input.agentId);
      if (!agent) {
        throw new ScopeViolationError("Agent does not belong to the exact Namespace.");
      }
      await this.holdStandingApprovalAuthority(state, principalId, agent);
      await this.removeLockedStandingApproval(state, input);
    });
  }

  /** The caller holds the Namespace and Agent rows. Order the exact decision after those waits. */
  private async holdStandingApprovalAuthority(
    state: PlatformUnitOfWork,
    principalId: string,
    agent: Pick<Agent, "id" | "namespaceId">,
  ): Promise<void> {
    await this.holdNamespacePolicyActor(state, principalId);
    await this.authorize(principalId, "administer", {
      kind: "agent",
      id: agent.id,
      namespaceId: agent.namespaceId,
    });
  }

  private async removeLockedStandingApproval(
    state: PlatformUnitOfWork,
    input: RemoveStandingApprovalInput,
  ): Promise<void> {
    const approval = (
      await state.repositorySessions.listStandingApprovals(input.namespaceId, input.agentId)
    ).find((a) => a.id === input.approvalId);
    if (
      !approval ||
      (input.repositoryRef !== undefined && approval.binding.repositoryRef !== input.repositoryRef)
    ) {
      throw new ScopeViolationError(
        "Standing approval does not belong to the exact Agent and binding.",
      );
    }
    if (approval.revokedAt && approval.generation === input.expectedGeneration + 1) {
      return;
    }
    if (approval.revokedAt || approval.generation !== input.expectedGeneration) {
      throw new ResourceStateConflictError("Standing approval changed.");
    }
    await state.repositorySessions.revokeStanding(approval, this.timestamp());
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
    if (!isNonEmptyString(input.agentId)) {
      throw new ScopeViolationError("The exact Agent identity is missing.");
    }
    if (input.configurationId !== undefined && !isNonEmptyString(input.configurationId)) {
      throw new ScopeViolationError("The exact Agent Configuration identity is missing.");
    }
    if (input.configurationId === undefined && input.gatewayManagedMode === undefined) {
      throw new ScopeViolationError(
        "An Agent update must name a Configuration or Gateway managed mode.",
      );
    }
    const requestedAuth =
      input.harnessAuth === undefined ? undefined : this.harnessAuthBinding(input.harnessAuth);
    const requestedSources = this.agentCredentialSources(input.credentialSources);
    if (input.executionMode !== undefined && !validExecutionMode(input.executionMode)) {
      throw new ScopeViolationError("The Agent Harness execution mode is invalid.");
    }
    const gatewayManagedMode =
      input.gatewayManagedMode === undefined
        ? undefined
        : normalizeGatewayManagedMode(input.gatewayManagedMode);
    const plugins = normalizeAgentPlugins(input.plugins);
    const pluginApprovers =
      input.pluginApprovers === null ? null : normalizeAgentPluginApprovers(input.pluginApprovers);
    this.namespaceIdentity(input.namespaceId);
    return this.mutate(async (state) => {
      if (input.repositoryStandingApproval !== undefined) {
        await this.holdAuthority(state);
      }
      const target = { kind: "agent", id: input.agentId, namespaceId: input.namespaceId } as const;
      await this.authorize(principalId, "update", target);
      const namespace = await this.lockNamespace(state, input.namespaceId);
      // Namespace IAM writes share this lock. Use the policy after any writer ahead of us.
      await this.authorize(principalId, "update", target);
      const agent = await state.agents.lockAgent(namespace.id, input.agentId);
      if (!agent) {
        throw new ScopeViolationError(
          "The Agent does not belong to the exact Installation and Namespace.",
        );
      }
      if (agent.status !== "active") {
        throw new AgentDeletingError();
      }
      const configurationId = input.configurationId ?? agent.configurationId;
      if (gatewayManagedMode !== undefined) {
        await this.authorizeGatewayManagedModeChange(
          principalId,
          gatewayManagedMode !== agent.gatewayManagedMode,
        );
        this.requireGatewayManagedModeSupport(gatewayManagedMode);
      }
      await this.authorize(principalId, "read", {
        kind: "configuration",
        id: configurationId,
        namespaceId: namespace.id,
      });
      const configuration = await state.configurations.findConfiguration(
        namespace.id,
        configurationId,
      );
      if (!configuration || configuration.kind !== "agent") {
        throw new ScopeViolationError(
          "The Agent Configuration must belong to the exact Namespace and configure an Agent.",
        );
      }
      await this.guardAgentProvisioning(state, namespace.id, agent.id);
      await this.guardProvisioningConfiguration(state, namespace.id, configurationId);
      const previousAuth = this.harnessAuthBinding(agent.harnessAuth);
      // Every update needs the caller's grant on each source the Agent binds now, but not a
      // usable record: after a Secret Driver or Credential Gateway change, an update must still
      // be able to replace or drop what the new driver does not own. Only what the update
      // binds is looked up, and deploy admission rechecks every bound source.
      // A denial here says it is for the current Harness authentication, which an update that
      // replaces it also needs (finding D763).
      await this.authorizeBoundHarnessAuth(principalId, namespace.id, previousAuth).catch(
        (error: unknown) => {
          throw QualifiedAuthorizationDeniedError.qualify(error, "current_harness_auth");
        },
      );
      await this.authorizeBoundCredentialSources(
        principalId,
        namespace.id,
        agent.credentialSources ?? [],
      );
      if (requestedAuth !== undefined) {
        rejectCrossNamespaceSecretSources(namespace.id, undefined, requestedAuth);
        await this.authorizeHarnessAuthSource(state, principalId, namespace.id, requestedAuth);
      }
      const auth = requestedAuth === undefined ? previousAuth : requestedAuth;
      let sources =
        requestedSources === undefined
          ? undefined
          : await this.authorizeAgentCredentialSources(
              state,
              principalId,
              namespace.id,
              requestedSources,
              auth,
            );
      if (requestedSources === undefined && requestedAuth !== undefined) {
        const retained = agent.credentialSources ?? [];
        this.assertHarnessSourceListed(retained, requestedAuth);
        // Admission permits a managed TokenService source only as the Harness source, so
        // changing authentication can leave only the previous selection attached incorrectly.
        if (
          previousAuth?.method === "credential_source" &&
          (requestedAuth?.method !== "credential_source" ||
            requestedAuth.sourceId !== previousAuth.sourceId) &&
          retained.some(({ sourceId }) => sourceId === previousAuth.sourceId)
        ) {
          // Owner metadata is immutable and the Namespace fence excludes deletion. A
          // nonlocking read avoids taking a source lock after a newly selected Secret.
          const source = await state.credentialSources.findCredentialSource(
            namespace.id,
            previousAuth.sourceId,
          );
          if (isManagedTokenServiceSource(source)) {
            throw new ResourceStateConflictError(
              "This TokenService source must remain the selected Harness authentication source.",
            );
          }
        }
      }
      // Unlike the Agent's own bindings above, the named Configuration's Secret bindings get the
      // full check even when `configurationId` is unchanged: deploy needs them usable, and only a
      // Configuration write (or naming another Configuration) can replace them, so loosening this
      // would not unblock the Agent. SecretBindingDriverError names that fix.
      const secretBindings = this.bindings(configuration.secretBindings);
      await this.authorizeBindings(state, principalId, namespace.id, secretBindings);
      const savedConfiguration = this.savedConfigurationReader(configuration);
      const selections = plugins ?? agent.plugins;
      const driver = await this.validateAgentPlugins(
        selections,
        pluginApprovers === null ? undefined : (pluginApprovers ?? agent.pluginApprovers),
        async () => (await savedConfiguration()).values,
        agent,
        plugins === undefined ? "stored" : "request",
      );
      if (
        sources === undefined &&
        driver?.credentials &&
        plugins &&
        Object.values(plugins).some((p) => p.driverPolicy !== undefined)
      ) {
        sources = await this.authorizeAgentCredentialSources(
          state,
          principalId,
          namespace.id,
          agent.credentialSources ?? [],
          auth,
        );
      }
      if (sources !== undefined) {
        await this.validatePluginCredentialSources(driver, selections, sources, auth);
      }
      const backendId = this.backendId(input.backendId, agent.backendId);
      const repositoryChange =
        input.repositoryBindings !== undefined || input.repositoryAccess !== undefined;
      const settings = repositoryChange ? this.repositorySettings(namespace.id, input) : undefined;
      const repositoryBindings =
        settings === undefined ? undefined : (settings.repositoryBindings ?? []);
      const repositoryAccess =
        settings === undefined ? undefined : (settings.repositoryAccess ?? null);
      // The pair as it will be stored. A pending workspace setup is delivered by the first
      // deployment, so it is checked against the Configuration this update names. A completed
      // setup is delivered by every deployment, so it is checked when the update names another
      // Configuration or execution mode (finding 2296). An update that keeps both is not
      // checked, so an Agent broken by a later Configuration edit stays editable; deployment
      // refuses that pair.
      const workspaceSetup = await state.workspaceSetups.find(namespace.id, agent.id);
      const topologyChanged =
        configurationId !== agent.configurationId ||
        (input.executionMode !== undefined && input.executionMode !== agent.executionMode);
      await this.validateSavedAgentTopology(
        state,
        resolveHarness,
        {
          executionMode: input.executionMode ?? agent.executionMode,
          harnessAuth: () =>
            this.savedHarnessAuthSnapshot(
              state,
              namespace.id,
              requestedAuth === undefined ? previousAuth : requestedAuth,
            ),
          repositoryBindings: repositoryBindings ?? agent.repositoryBindings,
          workspaceSetup:
            workspaceSetup !== undefined && (!workspaceSetup.completed || topologyChanged),
          plugins: selections,
          pluginDriver: driver,
        },
        savedConfiguration,
      );
      // The reverse of the policy save's check: a binding added beside a saved grant that
      // reaches the repository hosts (finding 2144).
      if ((repositoryBindings ?? agent.repositoryBindings ?? []).length > 0) {
        await this.sandboxPolicyOperations.refuseRepositoryNetworkOverlap(
          principalId,
          await state.sandboxPolicies.find(namespace.id, agent.id),
        );
      }
      const updated = await state.agents.updateConfiguration(
        namespace.id,
        agent.id,
        configurationId,
        input.executionMode,
        requestedAuth,
        input.backendId === undefined ? undefined : backendId,
        plugins,
        repositoryBindings,
        pluginApprovers,
        repositoryAccess,
        requestedSources,
        gatewayManagedMode,
        plugins === undefined
          ? undefined
          : driver && Object.keys(plugins).length
            ? this.pluginOwner(driver, agent)
            : null,
      );
      if (!updated) {
        throw new ResourceStateConflictError("The Agent Configuration changed during its update.");
      }
      // Stop intent can be superseded before the active runtime is retired.
      // Removing a finite grant must remain irreversible throughout that interval.
      if (repositoryBindings !== undefined && agent.activeRevisionId) {
        const revision = await state.revisions.findRevision(
          namespace.id,
          agent.id,
          agent.activeRevisionId,
        );
        const admitted = revision?.repositoryCredentials;
        const selected = (
          bindings: readonly { repositoryRef: string; profile: string }[] | undefined,
          member: { repositoryRef: string; profile: string },
        ) =>
          bindings?.some(
            (binding) =>
              binding.repositoryRef === member.repositoryRef && binding.profile === member.profile,
          ) === true;
        if (
          admitted &&
          !admitted.standingApprovalId &&
          admitted.bindings.some(
            (member) =>
              selected(agent.repositoryBindings, member) &&
              !selected(updated.repositoryBindings, member),
          )
        ) {
          await state.repositorySessions.withdrawFinite(
            { namespaceId: namespace.id, agentId: agent.id, revisionId: revision!.id },
            this.timestamp(),
            this.requestAuditId.getStore(),
          );
        }
      }
      const activeApprovals = (
        await state.repositorySessions.listStandingApprovals(namespace.id, agent.id)
      ).filter((a) => !a.revokedAt);
      if (
        activeApprovals.length > 0 &&
        (updated.repositoryBindings?.length !== 1 ||
          activeApprovals.some(
            (a) =>
              a.binding.repositoryRef !== updated.repositoryBindings![0]!.repositoryRef ||
              a.binding.profile !== updated.repositoryBindings![0]!.profile,
          ))
      ) {
        // The caller holds update on the Agent. Like SecretReferencedError, the text says what
        // blocks without naming it: no approval ID, which only Agent administer reads.
        throw new ResourceStateConflictError(STANDING_APPROVAL_REFUSALS.bindingLocked);
      }
      if (input.repositoryStandingApproval !== undefined) {
        const requested = input.repositoryStandingApproval;
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(requested.approvalId)) {
          throw new ScopeViolationError("Invalid standing approval identity.");
        }
        await this.holdStandingApprovalAuthority(state, principalId, agent);
        if (requested.approved) {
          // TODO: admit independent sessions before enabling approval for multiple bindings.
          if (updated.repositoryBindings?.length !== 1) {
            throw new ResourceStateConflictError(STANDING_APPROVAL_REFUSALS.oneBinding);
          }
          const selected = updated.repositoryBindings?.find(
            (b) => b.repositoryRef === requested.repositoryRef,
          );
          // The request's own selections resolved above, so only saved ones can fail here.
          const resolved =
            selected &&
            this.resolveRepositoryBindings(
              namespace.id,
              [selected],
              "saved",
              this.selectedStandingRepositoryAdmission(),
            );
          const binding = resolved?.resolution.bindings[0];
          const scope =
            binding &&
            eligibleRepositoryApprovalScope(resolved!.driver, {
              namespaceId: namespace.id,
              binding,
            });
          if (requested.duration !== "until-removed" || !binding || !scope) {
            throw new ResourceStateConflictError(STANDING_APPROVAL_REFUSALS.notPermitted);
          }
          const scopeFingerprint = repositoryApprovalFingerprint({
            namespaceId: namespace.id,
            agentId: agent.id,
            binding,
            scope,
          });
          if (requested.expectedScopeFingerprint !== scopeFingerprint) {
            throw new ResourceStateConflictError(STANDING_APPROVAL_REFUSALS.scopeChanged);
          }
          await state.repositorySessions.approveStanding({
            id: requested.approvalId,
            namespaceId: namespace.id,
            agentId: agent.id,
            binding,
            scope,
            scopeFingerprint,
            approvedBy: principalId,
            createdAt: this.timestamp(),
          });
        } else {
          await this.removeLockedStandingApproval(state, {
            namespaceId: namespace.id,
            agentId: agent.id,
            approvalId: requested.approvalId,
            expectedGeneration: requested.expectedGeneration,
            repositoryRef: requested.repositoryRef,
          });
        }
      }
      return updated;
    });
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
    this.configurationIdentity(target.namespaceId, capturedIntent.expectedConfigurationId);
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
    const bindings = this.bindings(configuration.secretBindings);
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
      const storage = this.ownedSecretDriver(secret.driverId, driverFailure);
      if (storage.withValue === undefined) {
        throw new ChannelCredentialError("unavailable", path);
      }
      await authorizeUse?.();
      await this.authorize(principalId, "operate", source);
      const outcome = await this.secretOperation(() =>
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
              this.ownedSecretDriver(current.driverId, driverFailure) !== storage
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
    const configurationDriver = this.configurationDriver();
    const configuration = this.exactConfiguration(
      await this.driverOperation(() => configurationDriver.read(metadata)),
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
      const sandbox = this.sandboxDriver();

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
      this.assertCredentialGatewayDelivery(lockedAgent.harnessAuth);
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
      const configurationDriver = this.configurationDriver();
      const configuration = this.exactConfiguration(
        await this.driverOperation(() =>
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
        this.bindings(metadata.secretBindings),
      );
      const [harnessAuth, credentialSourceType] = await this.admitHarnessAuth(
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
      this.requireCredentialSourceDrivers(harnessAuth, sandbox);
      const driver =
        lockedAgent.plugins && Object.keys(lockedAgent.plugins).length
          ? this.pluginDriver(revisionHarness.id, true)
          : undefined;
      const pluginState =
        driver && lockedAgent.plugins
          ? immutableCopy({
              driver: this.pluginOwner(driver, lockedAgent),
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
      const secretBindings = this.bindings(metadata.secretBindings);
      const sources = await this.authorizeBindings(
        state,
        principalId,
        namespace.id,
        secretBindings,
      );
      const secretDriver =
        Object.keys(secretBindings).length === 0 ? undefined : this.secretDriver();
      for (const secret of sources) {
        await this.authorizeAgentPrincipal(principalId, lockedAgent, "operate", {
          kind: "secret",
          id: secret.id,
          namespaceId: namespace.id,
        });
        const resolved = await this.secretOperation(() => secretDriver!.resolve(secret));
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
        this.validatePluginSettings(
          driver,
          pluginState.plugins,
          lockedAgent.pluginApprovers,
          admittedConfiguration,
          "stored",
        );
        this.validatePluginPlacement(driver, pluginState.plugins, revisionHarness);
      }
      // Decode every earlier revision: one that is unreadable refuses the deploy here (503,
      // nothing created), because the worker must decode them all to stop or retire them.
      const previous = await state.revisions.listRevisions(namespace.id, lockedAgent.id);
      const createdAt = this.timestamp();
      let repositoryCredentials = this.admitRepositoryCredentials(
        lockedAgent,
        compute,
        { ...approvedHarness, mode: lockedAgent.executionMode },
        sandbox?.id,
        Date.parse(createdAt),
      );
      if (repositoryCredentials !== undefined) {
        this.validateRepositoryBrokerNetworkProxy(revisionHarness, admittedConfiguration, sandbox);
      }
      if (
        repositoryCredentials?.bindings.length !== 1 &&
        (await state.repositorySessions.listStandingApprovals(namespace.id, lockedAgent.id)).some(
          (a) => !a.revokedAt,
        )
      ) {
        throw new ResourceStateConflictError(STANDING_APPROVAL_REFUSALS.deployOneBinding);
      }
      if (repositoryCredentials?.bindings.length === 1) {
        const binding = repositoryCredentials.bindings[0]!;
        const approval = await state.repositorySessions.findStandingApproval(
          namespace.id,
          lockedAgent.id,
          binding.repositoryRef,
        );
        if (approval) {
          const resolved = this.resolveRepositoryBindings(
            namespace.id,
            [{ repositoryRef: binding.repositoryRef, profile: binding.profile }],
            "saved",
            this.installationRepositoryAdmission,
          )!;
          const scope = eligibleRepositoryApprovalScope(resolved.driver, {
            namespaceId: namespace.id,
            binding,
          });
          if (
            !scope ||
            !isDeepStrictEqual(resolved.resolution.bindings[0], binding) ||
            !isDeepStrictEqual(approval.binding, binding) ||
            !isDeepStrictEqual(approval.scope, scope)
          ) {
            throw new ResourceStateConflictError(STANDING_APPROVAL_REFUSALS.policyChanged);
          }
          repositoryCredentials = {
            ...repositoryCredentials,
            standingApprovalId: approval.id,
            standingApprovalGeneration: approval.generation,
            standingApprovalScopeFingerprint: approval.scopeFingerprint,
          };
        }
      }
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
        const status = this.runtimeCredentialStatus(
          await this.runtimeCredentialOperation(() =>
            compute.getAgentRuntimeCredentialStatus!(binding),
          ),
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
          const provisioned = this.runtimeCredentialStatus(
            await this.runtimeCredentialOperation(() =>
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
        configuration: frozenValues(withAgentIdentityName(admittedConfiguration, lockedAgent.name)),
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

  /**
   * Records a withdrawal of `credentialSourceId` from the Agent's active revision and queues
   * worker work to revoke it. Every admitted successor revision that holds the source gets its
   * own withdrawal too, so a deployment still in flight cannot attach it again, and so does
   * each predecessor that may still run until the active revision's deployment retires it.
   * A replay of a pending withdrawal makes the replaying operator its requester, so its next
   * attempt runs on their authority. It queues another attempt only when no earlier attempt is
   * still queued or running, and otherwise lets a queued one run now; a revoked withdrawal is
   * left unchanged. The response describes the active revision's withdrawal, or, once that is
   * revoked, a pending one of another revision that may still run with the source (see
   * readAgentCredentialWithdrawal).
   */
  async withdrawAgentCredentialSource(
    principalId: string,
    input: AgentCredentialSourceInput,
  ): Promise<Readonly<CredentialWithdrawalStatus>> {
    this.namespaceIdentity(input.namespaceId);
    if (!isNonEmptyString(input.agentId)) {
      throw new ScopeViolationError("The exact Agent identity is missing.");
    }
    return this.mutate(async (state) => {
      await this.authorize(principalId, "operate", {
        kind: "agent",
        id: input.agentId,
        namespaceId: input.namespaceId,
      });
      await this.lockNamespace(state, input.namespaceId);
      const agent = await state.agents.lockAgent(input.namespaceId, input.agentId);
      if (agent === undefined) {
        throw new ScopeViolationError(
          "The Agent does not belong to the exact Installation and Namespace.",
        );
      }
      const revision = await this.activeCredentialSourceRevision(state, agent, input);
      const withdrawal = await this.requestRevisionCredentialWithdrawal(
        state,
        principalId,
        revision,
        input.credentialSourceId,
      );
      const others = (
        await credentialWithdrawalCompanionRevisions(
          state,
          await state.revisions.listRevisions(agent.namespaceId, agent.id),
          revision,
          this.clock(),
        )
      ).filter((candidate) => revisionHoldsCredentialSource(candidate, input.credentialSourceId));
      const pendingOthers: Readonly<CredentialWithdrawal>[] = [];
      for (const other of others) {
        const recorded = await this.requestRevisionCredentialWithdrawal(
          state,
          principalId,
          other,
          input.credentialSourceId,
        );
        if (recorded.state === "pending") {
          pendingOthers.push(recorded);
        }
      }
      // Every pending withdrawal now has an attempt queued or running, either earlier or just
      // now. Like the read, this reflects the queue at commit: a claim that expired on its last
      // attempt counts until recoverStale fails it.
      const reported =
        withdrawal.state === "pending" ? withdrawal : (pendingOthers[0] ?? withdrawal);
      return credentialWithdrawalStatus(reported, reported.state === "pending");
    });
  }

  /**
   * Inserts or returns the revision's withdrawal of the source. A pending one makes the caller
   * its requester. Without outstanding work it queues an attempt; otherwise the queued attempt
   * runs now instead of at its scheduled time, so one chain still serves the withdrawal.
   */
  private async requestRevisionCredentialWithdrawal(
    state: PlatformUnitOfWork,
    principalId: string,
    revision: Readonly<AgentRevision>,
    credentialSourceId: string,
  ): Promise<Readonly<CredentialWithdrawal>> {
    let withdrawal = await state.credentialSources.requestCredentialWithdrawal(
      Object.freeze({
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        revisionId: revision.id,
        credentialSourceId,
        state: "pending",
        requestedBy: principalId,
        requestedAt: this.timestamp(),
      }),
    );
    if (withdrawal.state !== "pending") {
      return withdrawal;
    }
    // The worker rechecks `agent:operate` for the recorded requester. An earlier requester
    // may have lost it since, so the next attempt, queued now or earlier, runs on the authority
    // just checked by the caller; otherwise nobody could ever complete the withdrawal. The
    // request's own audit event records the caller; earlier events keep their actors.
    if (withdrawal.requestedBy !== principalId) {
      const reassigned = await state.credentialSources.reassignCredentialWithdrawal(
        withdrawal.namespaceId,
        withdrawal.revisionId,
        withdrawal.credentialSourceId,
        principalId,
      );
      if (reassigned === undefined) {
        throw new ResourceStateConflictError(
          "The credential withdrawal changed during the request.",
        );
      }
      withdrawal = reassigned;
    }
    // A queued attempt (a retry backing off, or a later series of the worker's recovery chain)
    // runs now rather than up to five minutes later. A running one reads the new requester
    // when it settles (the worker's finalizeCredentialWithdrawal).
    if (
      await state.operations.hasOutstandingCredentialWithdrawalWork(
        revision.namespaceId,
        revision.id,
      )
    ) {
      await state.operations.expediteCredentialWithdrawalWork(revision.namespaceId, revision.id);
      return withdrawal;
    }
    await this.record(state, {
      kind: "agent_revision",
      action: "reconcile",
      target: "credentials_withdrawn",
      namespaceId: revision.namespaceId,
      resourceId: revision.id,
      actorId: principalId,
      operationId: crypto.randomUUID(),
    });
    return withdrawal;
  }

  /**
   * A `pending` withdrawal has no outstanding work once its attempts ran out with no later
   * series queued (the chain ended, it awaits a replay, or maintenance has not re-queued it
   * yet), so `withdrawalInProgress` is read from the queue.
   *
   * The source is withdrawn from the Agent only once every revision that may still run with it
   * confirmed its own withdrawal, so the read reports the active revision's withdrawal unless
   * one of those revisions' tells more: first a `pending` one with no attempt outstanding, so
   * `withdrawalInProgress: false` on a `pending` read always means a replay is needed, then any
   * other `pending` one, so `revoked` means all of them are. `revisionId` names the revision
   * whose withdrawal is reported.
   */
  async readAgentCredentialWithdrawal(
    principalId: string,
    input: AgentCredentialSourceInput,
  ): Promise<Readonly<CredentialWithdrawalStatus>> {
    await this.authorize(principalId, "read", {
      kind: "agent",
      id: input.agentId,
      namespaceId: input.namespaceId,
    });
    return this.read(async (state) => {
      await this.exactNamespace(state, input.namespaceId);
      const agent = await state.agents.findAgent(input.namespaceId, input.agentId);
      if (agent === undefined) {
        throw new ScopeViolationError("The Agent does not belong to this Namespace.");
      }
      // After Agent read, these name what the Agent lacks, as the request route's 409 does; they
      // read only its active version's withdrawals, never the source (finding D762).
      if (agent.activeRevisionId === undefined) {
        throw new CredentialWithdrawalNotFoundError("no_active_version");
      }
      const withdrawal = await state.credentialSources.findCredentialWithdrawal(
        agent.namespaceId,
        agent.activeRevisionId,
        input.credentialSourceId,
      );
      if (withdrawal === undefined) {
        throw new CredentialWithdrawalNotFoundError("not_withdrawn");
      }
      const withdrawals = [withdrawal];
      const revisions = await state.revisions.listRevisions(agent.namespaceId, agent.id);
      const active = revisions.find(({ id }) => id === withdrawal.revisionId);
      const companions =
        active === undefined
          ? []
          : await credentialWithdrawalCompanionRevisions(state, revisions, active, this.clock());
      for (const companion of companions) {
        if (!revisionHoldsCredentialSource(companion, input.credentialSourceId)) {
          continue;
        }
        const recorded = await state.credentialSources.findCredentialWithdrawal(
          companion.namespaceId,
          companion.id,
          input.credentialSourceId,
        );
        if (recorded !== undefined) {
          withdrawals.push(recorded);
        }
      }
      let inProgress: Readonly<CredentialWithdrawalStatus> | undefined;
      for (const candidate of withdrawals) {
        if (candidate.state !== "pending") {
          continue;
        }
        const status = credentialWithdrawalStatus(
          candidate,
          await state.operations.hasOutstandingCredentialWithdrawalWork(
            candidate.namespaceId,
            candidate.revisionId,
          ),
        );
        if (!status.withdrawalInProgress) {
          return status;
        }
        inProgress ??= status;
      }
      return inProgress ?? credentialWithdrawalStatus(withdrawal, false);
    });
  }

  /** The active revision must hold the source as its Harness authentication or a non-model source. */
  private async activeCredentialSourceRevision(
    state: PlatformUnitOfWork,
    agent: Readonly<Agent>,
    input: AgentCredentialSourceInput,
  ): Promise<Readonly<AgentRevision>> {
    if (agent.status !== "active" || agent.activeRevisionId === undefined) {
      throw new ResourceStateConflictError(
        "The Agent has no active revision to withdraw the credential source from.",
      );
    }
    const revision = await state.revisions.findRevision(
      agent.namespaceId,
      agent.id,
      agent.activeRevisionId,
    );
    if (revision === undefined) {
      throw new ScopeViolationError("The Agent's active revision is unavailable.");
    }
    if (!revisionHoldsCredentialSource(revision, input.credentialSourceId)) {
      // After the Agent operate grant. The check reads only the revision's bindings, never the
      // source, so a missing source ID and one the caller cannot read answer alike (finding 2536).
      throw new ResourceStateConflictError(
        "The Agent's active version does not use this credential source, so there is nothing to withdraw. Withdraw a source that the deployed version uses.",
      );
    }
    return revision;
  }

  private async cancelProvisioningForAgent(
    state: PlatformUnitOfWork,
    principalId: string,
    agent: Pick<Agent, "id" | "namespaceId">,
    trigger: "stop" | "delete",
  ): Promise<void> {
    const reasonCode = "PROVISIONING_CANCELLED";
    const cancelled = await state.provisioning.cancelByAgent(agent.namespaceId, agent.id, {
      code: reasonCode,
      message:
        trigger === "stop"
          ? "Provisioning was cancelled because the Agent was stopped."
          : "Provisioning was cancelled because the Agent was deleted.",
    });
    const requestId = this.requestAuditId.getStore();
    // A recorded claim still needs a result if request audit was disabled after the claim.
    if (cancelled === undefined || (requestId === undefined && cancelled.attemptId === undefined)) {
      return;
    }
    await state.audit.append({
      id: `aud_${crypto.randomUUID()}`,
      installationId: this.installation.id,
      namespaceId: agent.namespaceId,
      occurredAt: this.timestamp(),
      kind: "mutation",
      actorId: principalId,
      source: "occ",
      action: CONTROLLER_WORK_AUDIT_ACTIONS.provisioningCancelled,
      resource: { kind: "agent", namespaceId: agent.namespaceId, id: agent.id },
      outcome: "success",
      ...(requestId === undefined ? {} : { requestId }),
      details: {
        workId: cancelled.workId,
        reasonCode,
        trigger,
        ...(cancelled.attemptId === undefined ? {} : { attemptId: cancelled.attemptId }),
      },
    });
  }

  async stopAgent(
    principalId: string,
    namespaceId: string,
    agentId: string,
    expectedActiveRevisionId?: string,
  ): Promise<Readonly<Agent>> {
    if (!isNonEmptyString(namespaceId)) {
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    }
    if (!isNonEmptyString(agentId)) {
      throw new ScopeViolationError("The exact Agent identity is missing.");
    }
    return this.mutate(async (state) => {
      const target = { kind: "agent", id: agentId, namespaceId } as const;
      if (expectedActiveRevisionId !== undefined) {
        await this.holdAuthority(state);
      }
      await this.authorize(principalId, "operate", target);
      await this.lockNamespace(state, namespaceId);
      const agent = await state.agents.lockAgent(namespaceId, agentId);
      if (expectedActiveRevisionId !== undefined) {
        await this.authorize(principalId, "operate", target);
      }
      if (agent === undefined) {
        throw new ScopeViolationError(
          "The Agent does not belong to the exact Installation and Namespace.",
        );
      }
      if (expectedActiveRevisionId !== undefined) {
        // Stop is Agent-wide. A queued successor need not have replaced the active pointer yet.
        const conflict = () =>
          new ResourceStateConflictError(
            "Stop requires the expected revision to be active, latest, and successfully deployed. Inspect the current Agent before stopping it.",
          );
        if (
          agent.status !== "active" ||
          agent.desiredRuntimeState !== "running" ||
          agent.activeRevisionId !== expectedActiveRevisionId
        ) {
          throw conflict();
        }
        const { revisions } = await state.revisions.pageRevisionSummaries(namespaceId, agentId, {
          limit: 1,
        });
        const latest = revisions[0];
        if (
          latest?.id !== expectedActiveRevisionId ||
          latest.namespaceId !== namespaceId ||
          latest.agentId !== agentId
        ) {
          throw conflict();
        }
        const work = await state.operations.findWork(`agent_revision:${latest.id}:reconcile`);
        if (
          !work ||
          !workMatchesRevision(work, latest) ||
          controllerWorkDeploymentStatus(work, this.clock()) !== "succeeded"
        ) {
          throw conflict();
        }
      }
      if (agent.status === "deleting") {
        return agent;
      }
      await this.cancelProvisioningForAgent(state, principalId, agent, "stop");
      const stopped = await state.agents.transitionAgentDesiredRuntimeState(
        namespaceId,
        agentId,
        agent.desiredRuntimeState,
        "stopped",
      );
      if (stopped === undefined) {
        throw new ResourceStateConflictError("The Agent lifecycle changed during stop.");
      }
      await this.record(state, {
        kind: "agent",
        action: "reconcile",
        target: "stopped",
        namespaceId,
        resourceId: agentId,
        actorId: principalId,
        operationId: crypto.randomUUID(),
      });
      return stopped;
    });
  }

  /**
   * Begin or retry logical deletion of one exact, authorized, empty Namespace.
   * Driver effects remain deferred to handleNamespaceLifecycle().
   */
  async deleteNamespace(principalId: string, namespaceId: string): Promise<Readonly<Namespace>> {
    this.namespaceIdentity(namespaceId);
    return this.mutate(async (state) => {
      const namespace = await this.lockNamespaceForPolicyDelete(state, principalId, {
        kind: "namespace",
        id: namespaceId,
        namespaceId,
      });
      // Keep in-flight teardown idempotent. The original caller can explicitly
      // retry terminal work after repairing the dependency or permission failure.
      // Another authorized caller can take over only once the initiating actor
      // no longer holds delete permission on this Namespace (for example, it
      // was offboarded), so terminal teardown is never stranded.
      if (namespace.status === "deleting") {
        const workId = `namespace:${namespace.id}:reconcile:deleted`;
        const work = await state.operations.findWork(workId);
        if (work?.state === "failed_permanent") {
          const takeover = work.actorId !== principalId;
          if (
            takeover &&
            (
              await this.authorizationDecision(work.actorId, "delete", {
                kind: "namespace",
                id: namespace.id,
                namespaceId: namespace.id,
              })
            ).decision.allowed
          ) {
            throw new DeletionRetryOwnedError(work.actorId, {
              kind: "namespace",
              id: namespace.id,
              namespaceId: namespace.id,
            });
          }
          if (
            !(await state.operations.retryFailedNamespaceDeletion(
              namespace.id,
              work.actorId,
              principalId,
            ))
          ) {
            throw new ResourceStateConflictError(
              "The Namespace deletion work changed during retry.",
            );
          }
          const requestId = this.requestAuditId.getStore();
          await state.audit.append({
            id: `aud_${crypto.randomUUID()}`,
            installationId: this.installation.id,
            namespaceId: namespace.id,
            occurredAt: this.timestamp(),
            kind: "mutation",
            actorId: principalId,
            source: "occ",
            action: "openclaw.namespaces.delete.retry",
            resource: { kind: "namespace", id: namespace.id, namespaceId: namespace.id },
            outcome: "success",
            ...(requestId === undefined ? {} : { requestId }),
            details: {
              workId,
              previousAttemptCount: work.attemptCount,
              previousReasonCode: work.reasonCode,
              ...(takeover ? { takeover: true, previousActorId: work.actorId } : {}),
            },
          });
        }
        return namespace;
      }
      // The 409 names remaining resources' IDs: Configurations have no list view, so the
      // error is the only place an operator can find what to delete. Namespace delete does
      // not grant child reads, so of the first IDs of each kind (as many as the response
      // carries) it names only those the caller may read, and counts the rest (finding 2724).
      const contents: string[] = [];
      const ids: Record<string, readonly string[]> = {};
      const counts: Record<string, number> = {};
      const remaining = async (
        kind: string,
        resourceKind: ResourceKind,
        resources: readonly { readonly id: string }[],
      ) => {
        contents.push(kind);
        counts[kind] = resources.length;
        const readable: string[] = [];
        for (const { id } of resources.slice(0, NAMESPACE_NOT_EMPTY_ID_LIMIT)) {
          // An authorization outage hides the ID rather than the conflict.
          const resource = { kind: resourceKind, id, namespaceId: namespace.id };
          if (await this.canRead(principalId, resource).catch(() => false)) {
            readable.push(id);
          }
        }
        ids[kind] = readable;
      };
      if (await state.namespaces.hasAgents(namespace.id)) {
        await remaining("Agents", "agent", await state.agents.listAgents(namespace.id));
      }
      const configurationIds = await state.namespaces.listConfigurationIds(namespace.id);
      if (configurationIds.length > 0) {
        await remaining(
          "Configurations",
          "configuration",
          configurationIds.map((id) => ({ id })),
        );
      }
      const presets = await state.presets.listPresets(namespace.id);
      const blockingPresets = presets.filter(
        (preset) => !this.presets.isUnmodifiedDefaultPreset(preset),
      );
      if (blockingPresets.length > 0) {
        await remaining("Presets", "preset", blockingPresets);
      }
      if (await state.namespaces.hasSecrets(namespace.id)) {
        await remaining("Secrets", "secret", await state.secrets.listSecrets(namespace.id));
      }
      if (await state.namespaces.hasCredentialSources(namespace.id)) {
        await remaining(
          "credential sources",
          "credential_source",
          await state.credentialSources.listCredentialSources(namespace.id),
        );
      }
      if (await state.namespaces.hasServiceAccounts(namespace.id)) {
        await remaining(
          "service accounts",
          "service_account",
          await state.serviceAccounts.listServiceAccounts(namespace.id),
        );
      }
      const templates = await state.connectionTemplates.countNamespaceConnectionTemplates(
        namespace.id,
      );
      const clients = await state.connectionTemplates.countNamespaceOAuthClients(namespace.id);
      if (clients > 0) {
        contents.push("OAuth clients");
        counts["OAuth clients"] = clients;
      }
      if (templates > 0) {
        contents.push("connection templates");
        counts["connection templates"] = templates;
      }
      if (await state.provisioning.hasPendingNamespaceProvisioning(namespace.id)) {
        contents.push("pending Agent provisioning");
      }
      if (contents.length > 0) {
        throw new NamespaceNotEmptyError(contents, ids, counts);
      }
      // Installation defaults were seeded by Namespace creation, so deletion removes
      // them only while they still match the defaults; edited copies block above.
      for (const preset of presets) {
        const removed = await this.presets.deletePresetInState(
          state,
          principalId,
          namespace.id,
          preset.id,
        );
        await state.audit.append({
          id: `aud_${crypto.randomUUID()}`,
          installationId: this.installation.id,
          namespaceId: namespace.id,
          occurredAt: this.timestamp(),
          kind: "mutation",
          actorId: principalId,
          source: "occ",
          action: "openclaw.presets.delete",
          resource: { kind: "preset", id: preset.id, namespaceId: namespace.id },
          outcome: "success",
          // Like a direct Preset delete, name the AccessBindings removed with it.
          details: {
            source: "namespace-deletion",
            ...(removed.length === 0 ? {} : { removedAccessBindings: removed }),
          },
        });
      }
      const deleting = await state.namespaces.transitionNamespaceStatus(
        namespace.id,
        ["provisioning", "ready", "failed"],
        "deleting",
      );
      if (!deleting) {
        throw new ResourceStateConflictError("The Namespace lifecycle changed during deletion.");
      }
      await this.record(state, {
        kind: "namespace",
        action: "reconcile",
        target: "deleted",
        namespaceId: deleting.id,
        resourceId: deleting.id,
        actorId: principalId,
      });
      return deleting;
    });
  }

  /**
   * Begin or retry deletion of an exact Agent. Teardown of its revisions and owned
   * runtime resources is asynchronous, so this transitions the Agent to
   * `deleting` and queues the work rather than removing anything here. The
   * Agent row and its revisions are removed only once teardown succeeds.
   */
  async deleteAgent(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<Readonly<Agent>> {
    if (!isNonEmptyString(namespaceId)) {
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    }
    if (!isNonEmptyString(agentId)) {
      throw new ScopeViolationError("The exact Agent identity is missing.");
    }
    return this.mutate(async (state) => {
      await this.authorize(principalId, "delete", {
        kind: "agent",
        id: agentId,
        namespaceId,
      });
      const namespace = await state.namespaces.lockNamespace(namespaceId);
      if (!namespace) {
        throw new ScopeViolationError(
          "The Namespace does not belong to the server-owned Installation.",
        );
      }
      const agent = await state.agents.lockAgent(namespace.id, agentId);
      if (!agent) {
        throw new ScopeViolationError("The Agent does not belong to the exact Namespace.");
      }
      await this.cancelProvisioningForAgent(state, principalId, agent, "delete");
      // Deletion ends delivery ownership immediately, including never-deployed Agents.
      await state.workspaceSetups.delete(namespace.id, agent.id);
      // Keep in-flight teardown idempotent. The original caller can explicitly
      // retry terminal work after repairing the dependency or permission failure.
      // Another authorized caller can take over only once the initiating actor
      // no longer holds delete permission on this Agent (for example, it was
      // offboarded), so terminal teardown is never stranded.
      if (agent.status === "deleting") {
        const workId = `agent:${agent.id}:reconcile:deleted`;
        const work = await state.operations.findWork(workId);
        if (work?.state === "failed_permanent") {
          const takeover = work.actorId !== principalId;
          if (
            takeover &&
            (
              await this.authorizationDecision(work.actorId, "delete", {
                kind: "agent",
                id: agent.id,
                namespaceId: namespace.id,
              })
            ).decision.allowed
          ) {
            throw new DeletionRetryOwnedError(work.actorId, {
              kind: "agent",
              id: agent.id,
              namespaceId: namespace.id,
            });
          }
          if (
            !(await state.operations.retryFailedAgentDeletion(
              namespace.id,
              agent.id,
              work.actorId,
              principalId,
            ))
          ) {
            throw new ResourceStateConflictError("The Agent deletion work changed during retry.");
          }
          const requestId = this.requestAuditId.getStore();
          await state.audit.append({
            id: `aud_${crypto.randomUUID()}`,
            installationId: this.installation.id,
            namespaceId: namespace.id,
            occurredAt: this.timestamp(),
            kind: "mutation",
            actorId: principalId,
            source: "occ",
            action: "openclaw.agents.delete.retry",
            resource: { kind: "agent", namespaceId: namespace.id, id: agent.id },
            outcome: "success",
            ...(requestId === undefined ? {} : { requestId }),
            details: {
              workId,
              previousAttemptCount: work.attemptCount,
              previousReasonCode: work.reasonCode,
              ...(takeover ? { takeover: true, previousActorId: work.actorId } : {}),
            },
          });
        }
        return agent;
      }
      const stopped = await state.agents.transitionAgentDesiredRuntimeState(
        namespace.id,
        agent.id,
        agent.desiredRuntimeState,
        "stopped",
      );
      if (!stopped) {
        throw new ResourceStateConflictError("The Agent runtime state changed during deletion.");
      }
      const deleting = await state.agents.transitionAgentStatus(
        namespace.id,
        agent.id,
        "active",
        "deleting",
      );
      if (!deleting) {
        throw new ResourceStateConflictError("The Agent lifecycle changed during deletion.");
      }
      await this.record(state, {
        kind: "agent",
        action: "reconcile",
        target: "deleted",
        namespaceId: namespace.id,
        resourceId: deleting.id,
        actorId: principalId,
      });
      return deleting;
    });
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
    if (!isNonEmptyString(actorId)) {
      throw new ScopeViolationError("The lifecycle actor is missing.");
    }
    this.namespaceIdentity(namespaceId);
    if (target !== "ready" && target !== "deleted") {
      throw new ScopeViolationError("The Namespace lifecycle target is invalid.");
    }
    const namespace = await this.mutate((state) =>
      state.namespaces.lockNamespace(namespaceId, {
        includeDeleted: true,
      }),
    );
    if (!namespace || namespace.deletedAt !== undefined) {
      return undefined;
    }
    if (target === "ready" && namespace.status !== "provisioning") {
      return namespace;
    }
    if (target === "deleted" && namespace.status !== "deleting") {
      return namespace;
    }

    let compute: ComputeDriver;
    try {
      compute = this.selectedDriver("compute");
    } catch {
      await this.recordLifecycleResult(actorId, namespace, undefined, "failure", {
        failure: "compute_driver_unavailable",
      });
      throw new DependencyUnavailableError("The selected compute Driver is unavailable.");
    }

    if (target === "deleted") {
      let result;
      try {
        result = await this.observeNamespaceLifecycle(
          namespace,
          "deleted",
          new AbortController().signal,
          (evidence) =>
            this.recordLifecycleResult(
              actorId,
              namespace,
              compute,
              evidence.outcome === "complete" ? "success" : "failure",
              { ...evidence },
            ),
        );
      } catch {
        await this.recordLifecycleResult(actorId, namespace, compute, "failure", {
          failure: "unavailable",
        });
        throw new DependencyUnavailableError("The compute Driver could not delete the Namespace.");
      }
      try {
        this.validateDeleteResult(result, namespace);
      } catch (error) {
        await this.recordLifecycleResult(actorId, namespace, compute, "failure", {
          failure: "invalid_driver_result",
        });
        throw error;
      }
      const deleted = result.namespaceDeleted && result.failure === undefined;
      return this.mutate(async (state) => {
        const current = await state.namespaces.lockNamespace(namespace.id, {
          includeDeleted: true,
        });
        if (!current || current.deletedAt !== undefined) {
          return undefined;
        }
        if (current.status !== "deleting") {
          return current;
        }
        const updated = deleted
          ? await state.namespaces.markNamespaceDeleted(current.id, this.timestamp())
          : current;
        const removedPolicy = deleted ? await removeNamespacePolicy(state, current.id) : undefined;
        await this.appendLifecycleAudit(
          state,
          actorId,
          current,
          compute,
          deleted ? "success" : "failure",
          {
            namespaceDeleted: result.namespaceDeleted,
            ...(result.failure === undefined ? {} : { failure: result.failure }),
            ...removedPolicyDetails(removedPolicy),
          },
        );
        return updated;
      });
    }

    let result;
    try {
      result = await this.observeNamespaceLifecycle(
        namespace,
        "ready",
        new AbortController().signal,
        (evidence) =>
          this.recordLifecycleResult(
            actorId,
            namespace,
            compute,
            evidence.outcome === "complete" ? "success" : "failure",
            { ...evidence },
          ),
      );
    } catch {
      await this.recordLifecycleResult(actorId, namespace, compute, "failure", {
        failure: "unavailable",
      });
      throw new DependencyUnavailableError("The compute Driver could not ensure the Namespace.");
    }
    try {
      this.validateEnsureResult(result, namespace);
    } catch (error) {
      await this.recordLifecycleResult(actorId, namespace, compute, "failure", {
        failure: "invalid_driver_result",
      });
      throw error;
    }
    const ready = result.namespaceReady && result.failure === undefined;
    return this.mutate(async (state) => {
      const current = await state.namespaces.lockNamespace(namespace.id);
      if (!current) {
        return undefined;
      }
      if (current.status !== "provisioning") {
        return current;
      }
      const next = ready ? "ready" : result.failure === "permanent" ? "failed" : "provisioning";
      const updated =
        next === current.status
          ? current
          : await state.namespaces.transitionNamespaceStatus(current.id, current.status, next);
      await this.appendLifecycleAudit(
        state,
        actorId,
        current,
        compute,
        ready ? "success" : "failure",
        {
          namespaceReady: result.namespaceReady,
          ...(result.failure === undefined ? {} : { failure: result.failure }),
        },
      );
      return updated ?? current;
    });
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

  private readableListRows<Row extends { readonly id: string }>(
    principalId: string,
    namespaceId: string,
    kind: "agent" | "service_account" | "preset",
    rows: readonly Row[],
  ): Promise<readonly Row[]> {
    return this.authority.readableListRows(principalId, namespaceId, kind, rows);
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

  private lockNamespaceForPolicyDelete(
    state: PlatformUnitOfWork,
    principalId: string,
    target: ResourceRef & { readonly namespaceId: string },
  ): Promise<Readonly<Namespace>> {
    return this.iamPolicy.lockNamespaceForPolicyDelete(state, principalId, target);
  }

  private bindings(input: unknown): SecretBindings {
    return storedSecretBindings(input);
  }

  /** Called under the Namespace lock, also taken by deletion and assignment. */
  private async authorizeBindings(
    state: PlatformUnitOfWork,
    principalId: string,
    namespaceId: string,
    bindings: SecretBindings,
  ): Promise<readonly Secret[]> {
    return this.configurationOperations.authorizeBindings(
      state,
      principalId,
      namespaceId,
      bindings,
    );
  }

  private harnessAuthBinding(value: unknown): HarnessAuthBinding | null {
    try {
      return normalizeHarnessAuthBinding(value);
    } catch {
      throw new ScopeViolationError("The Agent Harness authentication binding is invalid.");
    }
  }

  /** Namespace lock serializes binding, source deletion, and admission. */
  private async authorizeHarnessAuthSource(
    state: PlatformUnitOfWork,
    principalId: string,
    namespaceId: string,
    binding: HarnessAuthBinding | null,
  ): Promise<void> {
    if (binding === null || binding.method === "runtime") {
      return;
    }
    if (isSecretHarnessAuth(binding)) {
      if (binding.source.namespaceId !== namespaceId) {
        throw new ScopeViolationError("Harness authentication sources cannot cross Namespaces.");
      }
      await this.authorize(principalId, "operate", binding.source);
      const source = await state.secrets.lockSecret(namespaceId, binding.source.id);
      if (source === undefined) {
        throw new ScopeViolationError("The Harness Secret does not belong to the exact Namespace.");
      }
      this.ownedSecretDriver(source.driverId, () => new HarnessAuthSecretDriverError());
    } else if (binding.method === "credential_source") {
      await this.authorize(principalId, "operate", {
        kind: "credential_source",
        namespaceId,
        id: binding.sourceId,
      });
      const source = await state.credentialSources.lockCredentialSource(
        namespaceId,
        binding.sourceId,
      );
      if (!isManagedTokenServiceSource(source)) {
        this.assertCredentialGatewaySelected();
      }
      if (source === undefined || source.state !== "ready") {
        throw new ScopeViolationError(
          "The Harness credential source is unavailable in the exact Namespace.",
        );
      }
      if (isManagedTokenServiceSource(source)) {
        this.ownedTokenServiceDriver(source.tokenServiceInstanceId);
      } else {
        this.ownedCredentialGatewayDriver(source);
      }
    } else {
      if (binding.source.namespaceId !== namespaceId) {
        throw new SecretBindingValidationError(SERVICE_ACCOUNT_CROSS_NAMESPACE);
      }
      await this.authorize(principalId, "read", {
        kind: "service_account",
        namespaceId,
        id: binding.source.id,
      });
      await this.exactServiceAccount(state, namespaceId, binding.source.id);
    }
  }

  private agentCredentialSources(
    value: unknown,
  ): readonly AgentCredentialSourceBinding[] | undefined {
    if (value === undefined) {
      return undefined;
    }
    const seen = new Set<string>();
    if (!Array.isArray(value) || value.length > MAX_AGENT_CREDENTIAL_SOURCES) {
      throw new ScopeViolationError("The Agent credential sources are invalid.");
    }
    return Object.freeze(
      value.map((entry: unknown) => {
        if (
          typeof entry !== "object" ||
          entry === null ||
          Object.keys(entry).length !== 1 ||
          !isNonEmptyString((entry as { sourceId?: unknown }).sourceId) ||
          seen.has((entry as { sourceId: string }).sourceId)
        ) {
          throw new ScopeViolationError("The Agent credential sources are invalid.");
        }
        const sourceId = (entry as { sourceId: string }).sourceId;
        seen.add(sourceId);
        return Object.freeze({ sourceId });
      }),
    );
  }

  /** `credentialSources` lists every source; `harnessAuth` names the one the Harness uses. */
  private assertHarnessSourceListed(
    bindings: readonly AgentCredentialSourceBinding[],
    harnessAuth: HarnessAuthBinding | null | undefined,
  ): void {
    if (
      harnessAuth?.method === "credential_source" &&
      !bindings.some(({ sourceId }) => sourceId === harnessAuth.sourceId)
    ) {
      throw new AgentCredentialSourceBindingError();
    }
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
  private async authorizeBoundHarnessAuth(
    principalId: string,
    namespaceId: string,
    binding: HarnessAuthBinding | null,
  ): Promise<void> {
    if (binding === null || binding.method === "runtime") {
      return;
    }
    if (binding.method === "credential_source") {
      await this.authorizeBoundCredentialSources(principalId, namespaceId, [
        { sourceId: binding.sourceId },
      ]);
    } else if (isSecretHarnessAuth(binding)) {
      await this.authorize(principalId, "operate", {
        kind: "secret",
        namespaceId,
        id: binding.source.id,
      });
    } else {
      await this.authorize(principalId, "read", {
        kind: "service_account",
        namespaceId,
        id: binding.source.id,
      });
    }
  }

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
    for (const { sourceId } of bindings) {
      await this.authorize(principalId, "operate", {
        kind: "credential_source",
        namespaceId,
        id: sourceId,
      });
    }
  }

  /**
   * Namespace lock serializes binding, source deletion, and admission. The listing rule is
   * checked after every source authorization and lookup, so it never answers before a 403.
   */
  private async authorizeAgentCredentialSources(
    state: PlatformUnitOfWork,
    principalId: string,
    namespaceId: string,
    bindings: readonly AgentCredentialSourceBinding[],
    harnessAuth: HarnessAuthBinding | null | undefined,
  ): Promise<readonly CredentialSource[]> {
    const sources: CredentialSource[] = [];
    for (const { sourceId } of bindings) {
      await this.authorize(principalId, "operate", {
        kind: "credential_source",
        namespaceId,
        id: sourceId,
      });
      const source = await state.credentialSources.lockCredentialSource(namespaceId, sourceId);
      if (!isManagedTokenServiceSource(source)) {
        this.assertCredentialSourceOwnerSelected();
      }
      if (source === undefined || source.state !== "ready") {
        throw new ScopeViolationError(
          "The credential source is unavailable in the exact Namespace.",
        );
      }
      if (
        source.ownerCapability === "credential_proxy" &&
        !this.drivers.hasSelection("credential_proxy")
      ) {
        // An Installation change dropped the Proxy that owns this source, so Agent save and
        // deploy cannot bind it. The caller holds this source's operate grant, and the text names
        // no source (finding 2536); resolving the missing owner answered a 500.
        throw new CredentialProxyAdmissionError("sourcesWithoutProxy");
      }
      if (isManagedTokenServiceSource(source)) {
        this.ownedTokenServiceDriver(source.tokenServiceInstanceId);
        if (harnessAuth?.method !== "credential_source" || harnessAuth.sourceId !== source.id) {
          throw new ResourceStateConflictError(
            "This TokenService source must authenticate the selected Agent Harness.",
          );
        }
      } else {
        // TODO(Agent connection attachment): admit a saved account after verifying this Agent's grant.
        if (source.ownerCapability === "token_service") {
          throw new ResourceStateConflictError("This Agent has no grant for the saved account.");
        }
        this.credentialSourceOwner(source);
      }
      sources.push(source);
    }
    this.assertHarnessSourceListed(bindings, harnessAuth);
    return sources;
  }

  private async validatePluginCredentialSources(
    driver: PluginDriver | undefined,
    plugins: PluginDesiredState | undefined,
    sources: readonly CredentialSource[],
    harnessAuth?: HarnessAuthBinding | null,
  ): Promise<void> {
    if (plugins && Object.keys(plugins).length) {
      await driver?.credentials?.validate(
        plugins,
        sources,
        harnessAuth?.method === "credential_source" ? harnessAuth.sourceId : undefined,
      );
    }
  }

  /**
   * Freezes every source the Agent lists, including the one `harnessAuth` names. Each needs the
   * Agent principal's `operate` and a ready record; any catalog type may be listed.
   */
  private async admitCredentialSources(
    state: PlatformUnitOfWork,
    principalId: string,
    agent: Readonly<Agent>,
    sandbox: SandboxDriver | undefined,
    driver: PluginDriver | undefined,
    harness: RevisionHarnessDescriptor,
    compute: ComputeDriver,
  ): Promise<readonly CredentialSourceSnapshot[]> {
    const bindings = agent.credentialSources ?? [];
    if (bindings.length === 0) {
      await this.validatePluginCredentialSources(driver, agent.plugins, [], agent.harnessAuth);
      return [];
    }
    // A state refusal, so HTTP keeps the message instead of the generic "already exists".
    if (sandbox === undefined) {
      throw new ResourceStateConflictError(
        "Agent credential sources require a selected Sandbox Driver.",
      );
    }
    const sources = await this.authorizeAgentCredentialSources(
      state,
      principalId,
      agent.namespaceId,
      bindings,
      agent.harnessAuth,
    );
    await this.validatePluginCredentialSources(driver, agent.plugins, sources, agent.harnessAuth);
    const snapshots: CredentialSourceSnapshot[] = [];
    for (const { sourceId } of bindings) {
      await this.authorizeAgentPrincipal(principalId, agent, "operate", {
        kind: "credential_source",
        namespaceId: agent.namespaceId,
        id: sourceId,
      });
      const source = await state.credentialSources.lockCredentialSource(
        agent.namespaceId,
        sourceId,
      );
      if (source === undefined || source.state !== "ready") {
        throw new ScopeViolationError("The credential source is unavailable.");
      }
      compute.validateHarnessCredentialSources?.(harness, [source]);
      const owner = this.credentialSourceOwner(source);
      if (owner.kind === "proxy") {
        if (!this.protectedSourceTypes().some((p) => p.type.type === source.type)) {
          throw new CredentialSourceTypeNotOfferedError("proxy");
        }
        snapshots.push({ sourceId, credentialProxyId: owner.driver.id, sourceType: source.type });
      } else {
        await this.credentialSourceType(owner.driver, source.type);
        snapshots.push({ sourceId, credentialGatewayId: owner.driver.id, sourceType: source.type });
      }
    }
    return immutableCopy(snapshots);
  }

  /**
   * The provisioning grants that need only the requested Namespace. Status and retry check them
   * before any lookup, so a caller without them gets the same audited denial whether or not the
   * Namespace or work item exists.
   */
  private async authorizeProvisioningRequest(
    principalId: string,
    namespaceId: string,
  ): Promise<void> {
    this.namespaceIdentity(namespaceId);
    await this.authorize(principalId, "create", { kind: "agent", namespaceId, id: namespaceId });
    await this.authorize(principalId, "create", {
      kind: "configuration",
      namespaceId,
      id: namespaceId,
    });
    await this.authorize(principalId, "administer", {
      kind: "installation",
      id: this.installation.id,
    });
  }

  private async authorizeProvisioningRecord(
    state: PlatformUnitOfWork,
    principalId: string,
    record: Readonly<AgentProvisioningRecord>,
    {
      statusRead,
      admission = false,
    }: { readonly statusRead?: "status" | "retry"; readonly admission?: boolean } = {},
  ): Promise<void> {
    const namespaceId = record.namespaceId;
    await this.authorizeProvisioningRequest(principalId, namespaceId);
    if (record.agentId !== undefined) {
      for (const action of ["read", "operate", "deploy"] as const) {
        await this.authorize(principalId, action, {
          kind: "agent",
          namespaceId,
          id: record.agentId,
        });
      }
    }
    if (record.configurationId !== undefined) {
      for (const action of ["read", "update"] as const) {
        await this.authorize(principalId, action, {
          kind: "configuration",
          namespaceId,
          id: record.configurationId,
        });
      }
    }
    const plan = this.provisioningPlan(record);
    if (this.selectedDriver("iam").namespacePolicyTransaction !== "platform-unit-of-work") {
      throw new DependencyUnavailableError(
        "Agent provisioning requires transactional Namespace policy management.",
      );
    }
    const drivers = asRecord(record.plan.drivers);
    const compute = this.runtimeCredentialComputeDriver("provision");
    const configurationDriver = this.configurationDriver();
    if (
      drivers?.compute !== compute.id ||
      drivers.configuration !== configurationDriver.id ||
      drivers.iam !== this.selectedDriver("iam").id ||
      compute.validateAgentProvisioning === undefined ||
      compute.getAgentRuntimeCredentialStatus === undefined ||
      configurationDriver.createExact === undefined ||
      configurationDriver.inspectExact === undefined
    ) {
      throw new DependencyUnavailableError("The accepted provisioning Drivers are unavailable.");
    }
    // Compute plan validation is admission for writes (replay, retry, the worker), like the
    // plugin policy below: a status read still reports the stored work after an Installation
    // gateway or routing change makes the Compute Driver refuse the plan.
    if (!statusRead) {
      validateComputeAgentProvisioning(compute, plan.executionMode, plan.configuration.values);
    }
    if (record.status === "failed") {
      // A failed plan does not keep its credential sources from deletion; say which is gone.
      await this.assertProvisioningSourcesExist(state, namespaceId, plan);
    }
    await this.authorizeProvisioningSources(
      state,
      principalId,
      namespaceId,
      plan.configuration.secretBindings,
      plan.harnessAuth,
    );
    const binding = plan.harnessAuth;
    if (binding === null || binding.method === "runtime") {
      throw new ScopeViolationError(
        "Agent provisioning requires dedicated Harness authentication.",
      );
    }
    if (!statusRead) {
      this.assertCredentialGatewayDelivery(binding);
    }
    const backendId = this.backendId(record.plan.backendId as BackendRef | undefined);
    const agent =
      record.agentId === undefined
        ? undefined
        : await state.agents.findAgent(namespaceId, record.agentId);
    if (record.agentId !== undefined && agent === undefined) {
      throw new ScopeViolationError("The provisioning Agent is unavailable.");
    }
    let auth: HarnessAuthSnapshot | undefined;
    let credentialSourceType: CredentialSourceType | undefined;
    if (binding.method === "credential_source" && statusRead === "status") {
      // Source readiness and original Gateway ownership were checked above. Status needs
      // the Agent's current grant, but not the catalog snapshot used for write admission.
      if (agent !== undefined) {
        await this.authorizeAgentPrincipal(principalId, agent, "operate", {
          kind: "credential_source",
          namespaceId,
          id: binding.sourceId,
        });
      }
      this.requireCredentialSourceSandbox(this.sandboxDriver());
    } else if (isSecretHarnessAuth(binding)) {
      auth = this.secretHarnessAuthSnapshot(binding);
    } else if (agent !== undefined) {
      [auth, credentialSourceType] = await this.admitHarnessAuth(state, principalId, {
        ...agent,
        harnessAuth: binding,
      });
    } else if (binding.method === "credential_source") {
      [auth, credentialSourceType] = await this.credentialSourceHarnessAuthSnapshot(
        state,
        namespaceId,
        binding,
      );
    } else {
      auth = await this.serviceAccountHarnessAuthSnapshot(state, namespaceId, backendId, binding);
    }
    const harness = {
      id: resolveConfiguredHarnessId(
        plan.configuration.values,
        this.modelPolicyAgent(plan.executionMode),
      ),
      version: "provisioning",
      mode: plan.executionMode,
    };
    const sandbox = this.sandboxDriver();
    if (auth !== undefined) {
      this.requireCredentialSourceDrivers(auth, sandbox);
    }
    // Runtime image native worker support is admission for writes (replay, retry, the worker), like
    // the plugin policy below: a status read still reports the stored work after the image loses it.
    requireDedicatedNativeSupport(harness, sandbox, this.nativeWorkers, {
      runtimeImage: !statusRead,
      stored: !admission,
      configuration: plan.configuration.values,
    });
    // Static support and real Configuration transformation are write admission; status reads
    // must still report stored work after Installation settings change.
    if (!statusRead) {
      requireSandboxExecutionMode(sandbox, harness.mode);
      if (harness.id === "openclaw") {
        requireSandboxOpenClawMode(sandbox, harness.mode);
      }
    }
    const configuration = statusRead
      ? plan.configuration.values
      : (sandbox?.configureAgent?.(plan.configuration.values, harness) ??
        plan.configuration.values);
    if (resolveConfiguredHarnessId(configuration) !== harness.id) {
      throw new ScopeViolationError("A Sandbox Driver cannot change the selected Harness runtime.");
    }
    if (compute.validateHarnessAuth === undefined) {
      throw new DependencyUnavailableError(
        "The Compute Driver cannot validate Harness authentication.",
      );
    }
    // Harness authentication is admission for writes (replay, retry, the worker), like the
    // Compute plan check: a status read reports the stored work, including a failure that
    // names the refused setting, after a Driver change makes the check refuse the plan.
    if (!statusRead) {
      if (auth === undefined) {
        throw new DependencyUnavailableError("The Harness authentication snapshot is unavailable.");
      }
      try {
        compute.validateHarnessAuth(
          harness,
          auth,
          configuration,
          plan.configuration.secretBindings,
          credentialSourceType,
        );
      } catch (error) {
        // As in deployment, a Driver that names unsupported Configuration content the caller
        // owns keeps that message (a 400; the caller was authorized above).
        if (error instanceof ConfigurationHarnessError) {
          throw error;
        }
        throw new ResourceStateConflictError(
          "The configured model, authentication, or channel bindings cannot be provisioned.",
        );
      }
      if (asRecord(record.plan)?.initialWorkspaceFiles !== undefined) {
        validateWorkspaceSetupTopology(compute, harness, configuration, sandbox?.id);
      }
      // The request checks repository bindings before queueing (provisionAgent); retry and the
      // worker check them again until the Agent exists, when admitRepositoryCredentials does.
      const repositoryBindings = asRecord(record.plan)?.repositoryBindings;
      if (
        agent === undefined &&
        Array.isArray(repositoryBindings) &&
        repositoryBindings.length > 0
      ) {
        validateRepositoryTopology(compute, harness, sandbox?.id);
      }
    }
    // Plugin policy is admission for writes (replay, retry, the worker). A status read reports
    // the stored work, so an Installation Plugin Driver switch does not turn it into a 400.
    if (!statusRead) {
      const plugins = normalizeAgentPlugins(record.plan.plugins as PluginDesiredState | undefined);
      const driver = await this.validateAgentPlugins(
        plugins,
        normalizeAgentPluginApprovers(record.plan.pluginApprovers as PluginApprovers | undefined),
        () => configuration,
        {
          ...(plugins && { plugins }),
          ...(validPluginDriverIdentity(record.plan.pluginDriver)
            ? { pluginDriver: record.plan.pluginDriver }
            : {}),
        },
        "stored",
      );
      if (driver) {
        this.validatePluginPlacement(driver, plugins, harness);
      }
      const repositoryBindings = asRecord(record.plan)?.repositoryBindings;
      if (Array.isArray(repositoryBindings) && repositoryBindings.length > 0) {
        this.validateRepositoryBrokerNetworkProxy(harness, configuration, sandbox);
      }
    }
    // Retry keeps this admission before its lifecycle checks; status only reads saved progress.
    if (agent !== undefined && statusRead !== "status") {
      this.admitRepositoryCredentials(
        agent,
        compute,
        harness,
        this.sandboxDriver()?.id,
        this.clock().getTime(),
      );
    }
  }

  private async exactProvisioningWork(
    state: PlatformUnitOfWork,
    principalId: string,
    namespaceId: string,
    workId: string,
    operation: "status" | "retry" = "status",
  ) {
    if (!isNonEmptyString(workId)) {
      throw new ScopeViolationError("The exact provisioning work identity is missing.");
    }
    await this.exactNamespace(state, namespaceId);
    // The job and its queue row come from one statement: status derives from both.
    const found = await state.provisioning.findWithWork(workId);
    if (found === undefined || found.record.namespaceId !== namespaceId) {
      throw new ScopeViolationError(
        "The provisioning work does not belong to the exact Namespace.",
      );
    }
    if (found.record.actorId !== principalId) {
      throw new CallerStateDeniedError(
        operation === "retry"
          ? "Only the initiating actor can retry provisioning."
          : "Only the initiating actor can read provisioning status.",
      );
    }
    // Retry repeats the full check, native support, plugin policy, the Compute plan and Harness
    // authentication checks included, after its lifecycle checks.
    await this.authorizeProvisioningRecord(state, principalId, found.record, {
      statusRead: operation,
    });
    return found;
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

  private async assertProvisioningSourcesExist(
    state: PlatformUnitOfWork,
    namespaceId: string,
    plan: ReturnType<OpenClawController["provisioningPlan"]>,
  ): Promise<void> {
    const ids = Object.values(plan.configuration.secretBindings ?? {}).map(
      (binding) => binding.source.id,
    );
    const auth = plan.harnessAuth;
    if (isSecretHarnessAuth(auth)) {
      ids.push(auth.source.id);
    }
    for (const id of ids) {
      if ((await state.secrets.findSecret(namespaceId, id)) === undefined) {
        throw new ResourceStateConflictError(
          `Secret ${id}, which this provisioning request uses, was deleted. Submit a new Agent provisioning request.`,
        );
      }
    }
    if (
      auth?.method === "credential_source" &&
      (await state.credentialSources.findCredentialSource(namespaceId, auth.sourceId)) === undefined
    ) {
      throw new ResourceStateConflictError(
        `Credential source ${auth.sourceId}, which this provisioning request uses, was deleted. Submit a new Agent provisioning request.`,
      );
    }
    if (
      isServiceAccountHarnessAuth(auth) &&
      (await state.serviceAccounts.findServiceAccount(namespaceId, auth.source.id)) === undefined
    ) {
      throw new ResourceStateConflictError(
        `ServiceAccount ${auth.source.id}, which this provisioning request uses, was deleted. Submit a new Agent provisioning request.`,
      );
    }
  }

  private provisioningPlan(record: Readonly<AgentProvisioningRecord>): {
    readonly configuration: AgentProvisioningConfigurationInput;
    readonly harnessAuth: HarnessAuthBinding | null;
    readonly executionMode: HarnessExecutionMode;
    readonly gatewayManagedMode: boolean;
  } {
    const plan = asRecord(record.plan);
    let configuration: AgentProvisioningConfigurationInput;
    try {
      configuration = normalizeProvisioningConfiguration(plan?.configuration);
    } catch (error) {
      // A stored plan that no longer validates is not the caller's invalid request.
      if (error instanceof SecretBindingValidationError) {
        throw new ScopeViolationError("The accepted provisioning plan is no longer valid.");
      }
      throw error;
    }
    const executionMode = plan?.executionMode;
    if (!validExecutionMode(executionMode)) {
      throw new ScopeViolationError("The provisioning execution mode is invalid.");
    }
    return {
      configuration,
      harnessAuth: normalizeProvisioningHarnessAuth(plan?.harnessAuth ?? null),
      executionMode,
      gatewayManagedMode: normalizeGatewayManagedMode(plan?.gatewayManagedMode, true),
    };
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
    const created: Readonly<AccessBinding>[] = [];
    if (sources.length === 0) {
      return created;
    }
    const driver = this.iamPolicyDriver("createNamespaceAccessBinding");
    if (driver.namespacePolicyTransaction !== "platform-unit-of-work") {
      throw new DependencyUnavailableError(
        "The selected IAM Driver does not support provisioning policy transactions.",
      );
    }
    for (const resourceKind of ["secret", "credential_source"] as const) {
      const matching = sources.filter((source) => source.kind === resourceKind);
      if (matching.length === 0) {
        continue;
      }
      const displayName = resourceKind === "secret" ? "Secret" : "credential source";
      const roleId = `role_${namespaceId}_agent_${resourceKind}_operate`;
      const existingRole = await state.iamPolicy.getRole(namespaceId, roleId);
      if (
        existingRole !== undefined &&
        (existingRole.namespaceId !== namespaceId ||
          existingRole.permissions.length !== 1 ||
          existingRole.permissions[0]?.action !== "operate" ||
          existingRole.permissions[0]?.resourceKind !== resourceKind)
      ) {
        throw new ResourceConflictError(
          `The provisioning Role does not have the exact Namespace and ${displayName} permission.`,
        );
      }
      if (existingRole === undefined) {
        await this.iamPolicyOperation(() =>
          driver.createNamespaceRole!(
            { policy: state.iamPolicy },
            {
              id: roleId,
              namespaceId,
              name: `Agent ${displayName} operate`,
              permissions: [{ action: "operate", resourceKind }],
            },
          ),
        );
      }
      const bindings = await state.iamPolicy.listAccessBindings(namespaceId);
      for (const source of matching) {
        const exists = bindings.some(
          (binding) =>
            binding.subjectKind === "identity" &&
            binding.subjectId === agent.servicePrincipalId &&
            binding.roleId === roleId &&
            binding.resourceKind === resourceKind &&
            binding.resourceId === source.id,
        );
        if (exists) {
          continue;
        }
        created.push(
          await this.iamPolicyOperation(() =>
            driver.createNamespaceAccessBinding!(
              { policy: state.iamPolicy },
              {
                id: `binding_${agent.id}_${source.id}_operate`,
                namespaceId,
                subjectKind: "identity",
                subjectId: agent.servicePrincipalId,
                roleId,
                resourceKind,
                resourceId: source.id,
              },
            ),
          ),
        );
      }
    }
    return created;
  }

  /**
   * A caller allowed to deploy the Agent gives its ServicePrincipal the exact operate grant it
   * lacks on each referenced Secret and credential source that the caller can operate, in the
   * deploy unit (RFC-0026). A source the caller cannot operate gets no grant; the Agent principal
   * checks that follow then refuse the deploy.
   */
  private async grantDeployedAgentSources(
    state: PlatformUnitOfWork,
    principalId: string,
    agent: Readonly<Agent>,
    secretBindings: SecretBindings,
  ): Promise<void> {
    if (this.occBindingDriver("createNamespaceAccessBinding") === undefined) {
      return;
    }
    const referenced = new Map<string, SecretReference | CredentialSourceReference>();
    const add = (kind: "secret" | "credential_source", id: string): void => {
      referenced.set(`${kind}\u0000${id}`, { kind, namespaceId: agent.namespaceId, id });
    };
    for (const binding of Object.values(secretBindings)) {
      add("secret", binding.source.id);
    }
    if (isSecretHarnessAuth(agent.harnessAuth)) {
      add("secret", agent.harnessAuth.source.id);
    } else if (agent.harnessAuth?.method === "credential_source") {
      add("credential_source", agent.harnessAuth.sourceId);
    }
    for (const { sourceId } of agent.credentialSources ?? []) {
      add("credential_source", sourceId);
    }
    const missing: (SecretReference | CredentialSourceReference)[] = [];
    for (const source of referenced.values()) {
      const caller = (await this.authorizationDecision(principalId, "operate", source)).decision;
      if (!caller.allowed) {
        continue;
      }
      const current = await this.authorizationDecision(agent.servicePrincipalId, "operate", source);
      if (!current.decision.allowed) {
        missing.push(source);
      }
    }
    for (const binding of await this.ensureAgentOperateGrants(
      state,
      agent.namespaceId,
      agent,
      missing,
    )) {
      await state.audit.append({
        id: `aud_${crypto.randomUUID()}`,
        installationId: this.installation.id,
        namespaceId: agent.namespaceId,
        occurredAt: this.timestamp(),
        kind: "mutation",
        actorId: principalId,
        source: "occ",
        action: "openclaw.iam.access_bindings.create",
        resource: {
          kind: binding.resourceKind as "secret" | "credential_source",
          id: binding.resourceId as string,
          namespaceId: agent.namespaceId,
        },
        outcome: "success",
        details: {
          bindingId: binding.id,
          subjectKind: binding.subjectKind,
          subjectId: binding.subjectId,
          roleId: binding.roleId,
          reason: "agent_deploy",
          agentId: agent.id,
        },
      });
    }
  }

  private async authorizeProvisioningSources(
    state: PlatformUnitOfWork,
    principalId: string,
    namespaceId: string,
    bindings: SecretBindings | undefined,
    harnessAuth: HarnessAuthBinding | null,
  ): Promise<void> {
    for (const binding of Object.values(bindings ?? {})) {
      await this.authorizeProvisioningSecretSource(state, principalId, namespaceId, binding.source);
    }
    if (isSecretHarnessAuth(harnessAuth)) {
      await this.authorizeProvisioningSecretSource(
        state,
        principalId,
        namespaceId,
        harnessAuth.source,
      );
    } else if (harnessAuth?.method === "credential_source") {
      await this.authorizeHarnessAuthSource(state, principalId, namespaceId, harnessAuth);
    } else if (isServiceAccountHarnessAuth(harnessAuth)) {
      if (harnessAuth.source.namespaceId !== namespaceId) {
        throw new SecretBindingValidationError(SERVICE_ACCOUNT_CROSS_NAMESPACE);
      }
      await this.authorize(principalId, "read", {
        kind: "service_account",
        namespaceId,
        id: harnessAuth.source.id,
      });
      await this.exactServiceAccount(state, namespaceId, harnessAuth.source.id);
    }
  }

  private async authorizeProvisioningSecretSource(
    state: PlatformUnitOfWork,
    principalId: string,
    namespaceId: string,
    source: SecretReference,
  ): Promise<void> {
    if (source.namespaceId !== namespaceId) {
      throw new SecretBindingValidationError("Secret references cannot cross Namespaces.");
    }
    await this.authorize(principalId, "operate", source);
    const secret = await state.secrets.lockSecret(namespaceId, source.id);
    if (secret === undefined) {
      throw new ScopeViolationError("The Secret does not belong to the exact Namespace.");
    }
    this.ownedSecretDriver(secret.driverId, () => new ProvisioningSecretDriverError());
  }

  private async serviceAccountHarnessAuthSnapshot(
    state: PlatformUnitOfWork,
    namespaceId: string,
    backendId: BackendRef,
    binding: Extract<HarnessAuthBinding, { readonly source: ServiceAccountReference }>,
  ): Promise<HarnessAuthSnapshot> {
    const account = await state.serviceAccounts.lockServiceAccount(namespaceId, binding.source.id);
    if (account?.credential?.kind !== "access_token") {
      throw this.missingAccessTokenError();
    }
    const backendBinding = await state.serviceAccounts.findServiceAccountBackendBinding(
      namespaceId,
      binding.source.id,
    );
    validateServiceAccountBackendBinding(this.backendMap, backendId, backendBinding);
    const driverId = this.serviceAccountDriverId();
    if (backendBinding === undefined || driverId !== backendBinding.driverId) {
      throw new DependencyUnavailableError(
        "The Harness ServiceAccount Driver does not match the admitted Backend.",
      );
    }
    return immutableCopy({
      ...binding,
      credential: { kind: "access_token" as const, secretRef: account.credential.secretRef },
      backendBinding,
    });
  }

  private async admitHarnessAuth(
    state: PlatformUnitOfWork,
    principalId: string,
    agent: Readonly<Agent>,
  ): Promise<readonly [HarnessAuthSnapshot, CredentialSourceType?]> {
    const binding = this.harnessAuthBinding(agent.harnessAuth);
    if (binding === null) {
      throw new ResourceStateConflictError(
        "Deployment requires an explicit Harness authentication binding.",
      );
    }
    await this.authorizeHarnessAuthSource(state, principalId, agent.namespaceId, binding);
    if (binding.method === "runtime") {
      return [immutableCopy(binding)];
    }
    if (isSecretHarnessAuth(binding)) {
      await this.authorizeAgentPrincipal(principalId, agent, "operate", binding.source);
      const source = await state.secrets.lockSecret(agent.namespaceId, binding.source.id);
      if (source === undefined) {
        throw new ScopeViolationError("The Harness Secret is unavailable.");
      }
      const driver = this.secretDriver(source.driverId);
      const resolved = await this.secretOperation(() => driver.resolve(source));
      if (
        Object.keys(source.backendRef).some(
          (key) =>
            resolved[key as keyof typeof resolved] !==
            source.backendRef[key as keyof typeof source.backendRef],
        )
      ) {
        throw new DependencyUnavailableError("The Harness Secret backend identity changed.");
      }
      return [immutableCopy({ ...binding, secretDriverId: driver.id })];
    }
    if (binding.method === "credential_source") {
      await this.authorizeAgentPrincipal(principalId, agent, "operate", {
        kind: "credential_source",
        namespaceId: agent.namespaceId,
        id: binding.sourceId,
      });
      return this.credentialSourceHarnessAuthSnapshot(state, agent.namespaceId, binding);
    }
    const account = await state.serviceAccounts.lockServiceAccount(
      agent.namespaceId,
      binding.source.id,
    );
    if (account?.credential?.kind !== "access_token") {
      throw this.missingAccessTokenError();
    }
    const backendBinding = await state.serviceAccounts.findServiceAccountBackendBinding(
      agent.namespaceId,
      binding.source.id,
    );
    validateServiceAccountBackendBinding(this.backendMap, agent.backendId, backendBinding);
    const driverId = this.serviceAccountDriverId();
    if (backendBinding === undefined || driverId !== backendBinding.driverId) {
      throw new DependencyUnavailableError(
        "The Harness ServiceAccount Driver does not match the admitted Backend.",
      );
    }
    return [
      immutableCopy({
        ...binding,
        credential: { kind: "access_token" as const, secretRef: account.credential.secretRef },
        backendBinding,
      }),
    ];
  }

  private async credentialSourceHarnessAuthSnapshot(
    state: PlatformUnitOfWork,
    namespaceId: string,
    binding: Extract<HarnessAuthBinding, { readonly method: "credential_source" }>,
  ): Promise<readonly [HarnessAuthSnapshot, CredentialSourceType]> {
    const source = await state.credentialSources.lockCredentialSource(
      namespaceId,
      binding.sourceId,
    );
    if (source === undefined || source.state !== "ready") {
      throw new ScopeViolationError("The Harness credential source is unavailable.");
    }
    if (isManagedTokenServiceSource(source)) {
      // TODO: Replace this refusal when revision delivery can freeze and dispatch this owner.
      throw new ResourceStateConflictError(
        "Agent revision delivery for this TokenService source is not available. To deploy, select supported Harness authentication and remove this staged source from the Agent's credential sources.",
      );
    }
    const gateway = this.ownedCredentialGatewayDriver(source);
    const type = await this.credentialSourceType(gateway, source.type);
    if (type.harnessAuth === undefined) {
      throw new ResourceStateConflictError(
        "The credential source type cannot authenticate a Harness.",
      );
    }
    return immutableCopy([
      {
        method: "credential_source" as const,
        sourceId: source.id,
        credentialGatewayId: gateway.id,
        sourceType: source.type,
        loginMode: type.harnessAuth.loginMode,
      },
      type,
    ] as const);
  }

  /** A selected Credential Gateway replaces Secret-backed model delivery; no env fallback. */
  private assertCredentialGatewayDelivery(binding: HarnessAuthBinding | null): void {
    if (
      this.drivers.hasSelection("credential_gateway") &&
      binding !== null &&
      binding.method !== "credential_source" &&
      binding.method !== "runtime"
    ) {
      throw new ResourceStateConflictError(
        "The selected Credential Gateway requires credential-source Harness authentication.",
      );
    }
  }

  /** Credential sources require a paired Sandbox and their original Gateway. */
  private requireCredentialSourceDrivers(
    auth: HarnessAuthSnapshot,
    sandbox: SandboxDriver | undefined,
  ): void {
    if (auth.method === "credential_source") {
      this.requireCredentialSourceSandbox(sandbox);
      this.credentialGatewayDriver(auth.credentialGatewayId);
    }
  }

  private requireCredentialSourceSandbox(sandbox: SandboxDriver | undefined): void {
    if (sandbox === undefined) {
      throw new ResourceStateConflictError(
        "Credential-source Harness authentication requires a selected Sandbox Driver.",
      );
    }
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

  private runtimeCredentialStatus(
    status: AgentRuntimeCredentialStatus,
  ): Readonly<AgentRuntimeCredentialStatus> {
    if (status === undefined || typeof status.transportConfigured !== "boolean") {
      throw new DependencyUnavailableError(
        "The selected compute Driver returned invalid runtime credential metadata.",
      );
    }
    return Object.freeze({
      transportConfigured: status.transportConfigured,
    });
  }

  private async admitAgentRuntimeCredentialProvisioning(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<{
    readonly namespace: Readonly<Namespace>;
    readonly agent: Readonly<Agent>;
    readonly driver: ComputeDriver;
  }> {
    return this.mutate(async (state) => {
      await this.authorize(principalId, "read", {
        kind: "agent",
        id: agentId,
        namespaceId,
      });
      await this.authorize(principalId, "operate", {
        kind: "agent",
        id: agentId,
        namespaceId,
      });
      const namespace = await this.lockNamespace(state, namespaceId);
      const agent = await state.agents.lockAgent(namespace.id, agentId);
      if (!agent) {
        throw new ScopeViolationError(
          "The Agent does not belong to the exact Installation and Namespace.",
        );
      }
      if (agent.status !== "active") {
        throw new AgentDeletingError();
      }
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      if ((await state.revisions.listRevisionMetadata(namespace.id, agent.id)).length > 0) {
        throw new ResourceStateConflictError(
          "Runtime credentials can be provisioned only before the Agent has historical revisions.",
        );
      }
      return Object.freeze({
        namespace,
        agent,
        driver: this.runtimeCredentialComputeDriver("provision"),
      });
    });
  }

  /**
   * The selected Secret Driver when it owns a Secret the caller has already been granted and
   * looked up; otherwise the path's own SecretDriverOwnershipError, whose fixed message names
   * that path's fix. Call it only after the grant and the lookup, so it is no existence oracle.
   * No usable selected driver is an outage, not an ownership problem: it keeps the generic 503.
   */
  private ownedSecretDriver(
    driverId: string,
    failure: () => SecretDriverOwnershipError,
  ): SecretDriver {
    const driver = this.secretDriver();
    if (driver.id !== driverId) {
      throw failure();
    }
    return driver;
  }

  private secretDriver(expectedId?: string): SecretDriver {
    try {
      const driver = this.selectedDriver("secret");
      if (expectedId !== undefined && driver.id !== expectedId) {
        throw new Error("Driver identity mismatch.");
      }
      return driver;
    } catch {
      throw new DependencyUnavailableError(
        "The selected Secret Driver is unavailable or does not own this Secret.",
      );
    }
  }

  /**
   * The selected Credential Gateway Driver when it registered a source the caller has already
   * been granted and looked up; otherwise CredentialSourceDriverError, whose fixed message names
   * the fix. Call it only after the grant and the lookup, so it is no existence oracle. No usable
   * selected driver is an outage, not an ownership problem: it keeps the generic 503.
   */
  private ownedCredentialGatewayDriver(source: CredentialSource): CredentialGatewayDriver {
    const driver = this.credentialGatewayDriver();
    if (source.ownerCapability !== "credential_gateway" || driver.id !== source.driverId) {
      throw new CredentialSourceDriverError();
    }
    return driver;
  }

  private credentialGatewayDriver(expectedId?: string): CredentialGatewayDriver {
    try {
      const driver = this.selectedDriver("credential_gateway");
      if (expectedId !== undefined && driver.id !== expectedId) {
        throw new Error("Driver identity mismatch.");
      }
      return driver;
    } catch {
      throw new DependencyUnavailableError(
        "The selected Credential Gateway Driver is unavailable or does not own this source.",
      );
    }
  }

  /**
   * Reading and deleting an existing source must not depend on the current catalog: a source
   * stays observable and deletable after its type is no longer offered. An unoffered type
   * cannot be classified, so it gets no refresh call; without the role, the gateway's own
   * status and removal are all that is left.
   */
  private async refreshDriverForSource(
    gateway: CredentialGatewayDriver,
    type: string,
  ): Promise<CredentialRefreshDriver | undefined> {
    if (!this.drivers.hasSelection("credential_refresh")) {
      return undefined;
    }
    const catalog = await this.credentialGatewayOperation(() =>
      gateway.listSourceTypes({ signal: AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS) }),
    );
    return catalog.some((entry) => entry.type === type && entry.rotation === "refresh")
      ? this.credentialRefreshDriver()
      : undefined;
  }

  /** The refresh role is selectable only on the Credential Gateway's own Backend. */
  private credentialRefreshDriver(): CredentialRefreshDriver {
    try {
      return this.selectedDriver("credential_refresh");
    } catch {
      throw new DependencyUnavailableError(
        "The selected Credential Refresh Driver is unavailable for this refresh-type source.",
      );
    }
  }

  private async credentialGatewayOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ScopeViolationError || error instanceof ResourceConflictError) {
        throw error;
      }
      throw new DependencyUnavailableError(
        "The Credential Gateway operation failed or its outcome is unknown.",
      );
    }
  }

  /** Credential Gateways share the paired Sandbox's view, whose name is Compute's placement. */
  private async credentialNamespace(namespace: Readonly<Namespace>): Promise<Readonly<Namespace>> {
    const { compute, resolve } = this.credentialPlacement();
    return this.credentialGatewayOperation(() => Reflect.apply(resolve, compute, [namespace]));
  }

  private credentialPlacement() {
    let compute: ComputeDriver;
    try {
      compute = this.selectedDriver("compute");
    } catch {
      throw new DependencyUnavailableError("The selected compute Driver is unavailable.");
    }
    const resolve = compute.resolveSandboxNamespace;
    if (resolve === undefined) {
      throw new DependencyUnavailableError(
        "The selected Compute Driver cannot place Credential Gateway sources.",
      );
    }
    return { compute, resolve };
  }

  private ordinaryCredentialGatewayAllowed(type: CredentialSourceType): boolean {
    return (
      !this.drivers.hasSelection("credential_proxy") ||
      (this.selectedProxyOwner().allowsOrdinaryCredentialGateway() &&
        type.harnessAuth !== undefined &&
        this.staticSourceLifecycleMatches(type))
    );
  }

  /** The compatibility grant covers only the model Harness, never other bound sources. */
  private async ordinaryModelBinding(
    state: PlatformReadView,
    agent: Readonly<Agent>,
    admitted?: HarnessAuthSnapshot,
  ): Promise<boolean> {
    const auth = agent.harnessAuth;
    if (
      auth?.method !== "credential_source" ||
      agent.credentialSources?.length !== 1 ||
      agent.credentialSources[0]?.sourceId !== auth.sourceId ||
      !this.drivers.hasSelection("credential_gateway")
    ) {
      return false;
    }
    const source = await state.credentialSources.findCredentialSource(
      agent.namespaceId,
      auth.sourceId,
    );
    const gateway = this.credentialGatewayDriver();
    if (
      source?.state !== "ready" ||
      source.egress !== undefined ||
      source.ownerCapability !== "credential_gateway" ||
      source.driverId !== gateway.id
    ) {
      return false;
    }
    let type: CredentialSourceType;
    try {
      type = await this.credentialSourceType(gateway, source.type);
    } catch (error) {
      if (error instanceof CredentialSourceTypeNotOfferedError) {
        return false;
      }
      throw error;
    }
    if (type.harnessAuth === undefined || !this.staticSourceLifecycleMatches(type)) {
      return false;
    }
    const snapshot: HarnessAuthSnapshot = {
      method: "credential_source",
      sourceId: source.id,
      sourceType: source.type,
      credentialGatewayId: gateway.id,
      loginMode: type.harnessAuth.loginMode,
    };
    return admitted === undefined || isDeepStrictEqual(admitted, snapshot);
  }

  private staticSourceLifecycleMatches(
    type: CredentialSourceType,
    provider?: CredentialSourceType,
  ): boolean {
    return (
      supportsStaticCredentials(type) &&
      (provider === undefined || supportsStaticCredentials(provider))
    );
  }

  private staticSourceTypeAvailable(type: CredentialSourceType): boolean {
    try {
      const selection = this.staticEgressProvider(type);
      if (
        !selection ||
        !this.staticSourceLifecycleMatches(type, selection.provider.sourceType) ||
        selection.provider.sourceType.secrets.length !== 1
      ) {
        return false;
      }
      selection.assertCurrent();
      return true;
    } catch (error) {
      if (error instanceof ResourceStateConflictError) {
        return false;
      }
      throw error;
    }
  }

  /** A protected source is offered only by the selected pair and its installed lifecycle owner. */
  private protectedSourceTypes() {
    if (!this.drivers.hasSelection("credential_proxy")) {
      return [];
    }
    const driver = this.selectedProxyOwner().require("credential_proxy");
    return driver.sourceControl.providers.flatMap((provider) => {
      const issuer = this.preparedTokens?.issuer(provider.ref);
      return issuer || isDeepStrictEqual(provider.ref, credentialFreeProviderRef)
        ? [{ driver, type: provider.sourceType, issuer }]
        : [];
    });
  }

  private assertCredentialSourceOwnerSelected(): void {
    if (!this.drivers.hasSelection("credential_proxy")) {
      this.assertCredentialGatewaySelected();
    }
  }

  /** Resolve exactly the recorded capability, then check its Driver and protected backend. */
  private credentialSourceOwner(source: CredentialSource) {
    if (source.ownerCapability === "credential_proxy") {
      const driver = this.selectedProxyOwner().require("credential_proxy");
      if (
        source.driverId !== driver.id ||
        !source.egress ||
        !isDeepStrictEqual(source.egress.key.backend, driver.sourceControl.backend)
      ) {
        throw new DependencyUnavailableError(
          "The Credential Proxy that admitted the source is unavailable.",
        );
      }
      return { kind: "proxy" as const, driver };
    }
    return { kind: "gateway" as const, driver: this.ownedCredentialGatewayDriver(source) };
  }

  /** Recheck the immutable admission and its selected owner in the use or observation transaction. */
  private currentCredentialSourceOwner(source: CredentialSource, revision: AgentRevision): boolean {
    if (
      !credentialSourceMatchesSnapshot(
        source,
        revisionCredentialSourceSnapshot(revision, source.id),
      )
    ) {
      return false;
    }
    try {
      this.credentialSourceOwner(source);
      return true;
    } catch {
      return false;
    }
  }

  private async credentialSourceType(
    driver: CredentialGatewayDriver,
    type: string,
  ): Promise<CredentialSourceType> {
    const catalog = await this.credentialGatewayOperation(() =>
      driver.listSourceTypes({ signal: AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS) }),
    );
    const entry = catalog.find((candidate) => candidate.type === type);
    if (entry === undefined) {
      // Callers check the caller's grant and look up an existing source first. The catalog is
      // Installation configuration, so the refusal names the fix instead of a generic 404.
      throw new CredentialSourceTypeNotOfferedError();
    }
    return entry;
  }

  private credentialSourceMetadata(
    source: Readonly<CredentialSource>,
    status?: CredentialSourceStatus,
  ): Readonly<CredentialSourceMetadata & { readonly status?: CredentialSourceStatus }> {
    return Object.freeze({
      id: source.id,
      namespaceId: source.namespaceId,
      name: source.name,
      type: source.type,
      ownerCapability: source.ownerCapability,
      config: source.config,
      secrets: source.secrets,
      ...(source.egress === undefined
        ? {}
        : { egress: { adoption: source.egress.adoption, retention: source.egress.retention } }),
      state: source.state,
      ref: Object.freeze({
        kind: "credential_source" as const,
        id: source.id,
        namespaceId: source.namespaceId,
      }),
      ...(status === undefined ? {} : { status }),
    });
  }

  private runtimeCredentialComputeDriver(operation: "status" | "provision"): ComputeDriver {
    let driver: ComputeDriver;
    try {
      driver = this.selectedDriver("compute");
    } catch {
      throw new DependencyUnavailableError("The selected compute Driver is unavailable.");
    }
    const method =
      operation === "status"
        ? driver.getAgentRuntimeCredentialStatus
        : driver.provisionAgentRuntimeCredentials;
    if (typeof method !== "function") {
      throw new DependencyUnavailableError(
        "The selected compute Driver does not support Agent runtime credentials.",
      );
    }
    return driver;
  }

  /**
   * Runtime credential driver errors can contain secret bytes; never propagate them. A cluster
   * denial carries only fixed operation names and the Kubernetes namespace, so it passes.
   */
  private async runtimeCredentialOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof RuntimeCredentialsForbiddenByClusterError) {
        throw error;
      }
      throw new DependencyUnavailableError(
        "The Agent runtime credential operation failed or its outcome is unknown.",
      );
    }
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

  /** Secret SDK error bodies can contain request bytes; never propagate their message or cause. */
  private async secretOperation<T>(operation: () => Promise<T>): Promise<T> {
    return secretOperation(operation);
  }

  private configurationIdentity(namespaceId: string, configurationId: string): void {
    return this.configurationOperations.configurationIdentity(namespaceId, configurationId);
  }

  private namespaceIdentity(namespaceId: string): void {
    namespaceIdentity(namespaceId);
  }

  private async exactServiceAccount(
    state: PlatformReadView,
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<Readonly<ServiceAccount>> {
    return exactServiceAccount(state, namespaceId, serviceAccountId);
  }

  private configurationDriver(): ConfigurationDriver {
    try {
      return this.selectedDriver("configuration");
    } catch {
      throw new DependencyUnavailableError("The selected Configuration Driver is unavailable.");
    }
  }

  private serviceAccountDriver(): ServiceAccountDriver | undefined {
    if (!this.drivers.hasSelection("service_account")) {
      return undefined;
    }
    try {
      return this.selectedDriver("service_account");
    } catch {
      throw new DependencyUnavailableError("The selected ServiceAccount Driver is unavailable.");
    }
  }

  /**
   * Without a ChatGPT Backend no account can hold an access token, so that refusal names the
   * missing Backend. The API selects the Driver; the worker knows only its configured id.
   */
  private missingAccessTokenError(): ResourceConflictError {
    return this.drivers.hasSelection("service_account") ||
      this.configuredServiceAccountDriverId !== undefined
      ? new ResourceStateConflictError(
          "ChatGPT Harness authentication requires an issued account access-token credential.",
        )
      : new ServiceAccountDriverNotConfiguredError("deploy");
  }

  private serviceAccountDriverId(): string | undefined {
    const driver = this.serviceAccountDriver();
    if (
      driver !== undefined &&
      this.configuredServiceAccountDriverId !== undefined &&
      driver.id !== this.configuredServiceAccountDriverId
    ) {
      throw new DependencyUnavailableError(
        "The selected ServiceAccount Driver does not match Installation configuration.",
      );
    }
    return driver?.id ?? this.configuredServiceAccountDriverId;
  }

  private sandboxDriver(): SandboxDriver | undefined {
    if (!this.drivers.hasSelection("sandbox")) {
      return undefined;
    }
    try {
      return this.selectedDriver("sandbox");
    } catch {
      throw new DependencyUnavailableError("The selected Sandbox Driver is unavailable.");
    }
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
          sandbox = this.sandboxDriver();
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

  private async validateAgentPlugins(
    plugins: PluginDesiredState | undefined,
    approvers: PluginApprovers | undefined,
    readValues: () =>
      Readonly<OpenClawConfigurationDocument> | Promise<Readonly<OpenClawConfigurationDocument>>,
    previous?: {
      readonly plugins?: PluginDesiredState;
      readonly pluginDriver?: PluginDriverIdentity;
    },
    source: "request" | "stored" = "request",
  ): Promise<PluginDriver | undefined> {
    const hasSelections = plugins !== undefined && Object.keys(plugins).length > 0;
    if (!hasSelections && !approvers?.length) {
      return undefined;
    }
    const values = await readValues();
    const driver = this.pluginDriver(resolveConfiguredHarnessId(values), true);
    if (hasSelections) {
      this.pluginOwner(driver, previous);
    }
    this.validatePluginSettings(driver, plugins, approvers, values, source);
    return driver;
  }

  private validatePluginSettings(
    driver: PluginDriver,
    plugins: PluginDesiredState | undefined,
    approvers: PluginApprovers | undefined,
    values: Readonly<OpenClawConfigurationDocument>,
    source: "request" | "stored",
  ): void {
    try {
      driver.validatePolicies(plugins ?? {}, approvers);
    } catch (error) {
      if (source === "stored" && error instanceof PluginPolicyValidationError) {
        throw error.withoutRequestPath();
      }
      throw error;
    }
    if (plugins && Object.keys(plugins).length > 0) {
      try {
        driver.validateAgentConfiguration?.(plugins, values);
      } catch (error) {
        if (error instanceof ConfigurationHarnessError) {
          throw error;
        }
        throw new ResourceStateConflictError(
          "The selected Plugin Driver cannot run these plugin selections with this Configuration.",
        );
      }
    }
  }

  // Compute runs a bundled Plugin Driver's runtime only in the Harness it supports, and its
  // preparation refuses any other pair after a dedicated deployment stopped the running
  // revision. Agent save, provisioning and deployment refuse the pair first (finding 2348).
  private validatePluginPlacement(
    driver: PluginDriver,
    plugins: PluginDesiredState | undefined,
    harness: Readonly<Pick<RevisionHarnessDescriptor, "id" | "mode">>,
  ): void {
    if (plugins === undefined || Object.keys(plugins).length === 0) {
      return;
    }
    driver.validatePlacement?.(plugins, harness, this.selectedDriver("compute").implementation, {
      sandbox: this.drivers.selection("sandbox")?.implementation,
      gateway: this.drivers.selection("credential_gateway")?.implementation,
    });
    const required = pluginRuntimeHarnessRequirement(driver.implementation, harness);
    if (required !== undefined) {
      throw new ConfigurationHarnessError(
        `The Installation's Plugin Driver runs plugins only in ${required}: remove the Agent's plugins, or change its Configuration or execution mode to a Harness that runs them.`,
      );
    }
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

  private savedConfigurationReader(
    metadata: Pick<
      Configuration,
      "id" | "namespaceId" | "kind" | "generation" | "createdAt" | "secretBindings"
    >,
  ): () => Promise<Readonly<Configuration>> {
    return this.configurationOperations.savedConfigurationReader(metadata);
  }

  // Agent save runs deploy admission's checks of the Agent against its Configuration and the
  // Installation's Drivers, with the same messages, so a pair every deployment would refuse is
  // refused where it is written. A stored Agent that newly fails still reads, and deployment
  // refuses it as before; its next update must fix the pair. Checks that read live state stay
  // with deployment: an unapproved Harness runtime, and Harness authentication through a
  // ServiceAccount (issued credential) or a credential source (its state and type).
  private async validateSavedAgentTopology(
    state: PlatformReadView,
    resolveHarness: HarnessResolver | undefined,
    agent: {
      readonly executionMode: HarnessExecutionMode;
      /** The admission snapshot of the Agent's binding, if save can build one. */
      readonly harnessAuth: () => Promise<HarnessAuthSnapshot | undefined>;
      readonly repositoryBindings: readonly RepositoryBindingSelection[] | undefined;
      readonly workspaceSetup: boolean;
      readonly plugins: PluginDesiredState | undefined;
      readonly pluginDriver: PluginDriver | undefined;
    },
    readConfiguration: () => Promise<Readonly<Configuration>>,
  ): Promise<void> {
    const sandbox = this.sandboxDriver();
    requireSandboxExecutionMode(sandbox, agent.executionMode);
    const compute = this.drivers.selection("compute")?.driver as ComputeDriver | undefined;
    if (resolveHarness === undefined || compute === undefined) {
      return;
    }
    const configuration = await readConfiguration();
    // Deploy admission's rules for a stored Configuration that predates them (findings 2699, 2709,
    // 2767).
    refuseStoredConfigurationSettings(configuration.values);
    let configuredHarnessId: string;
    try {
      configuredHarnessId = resolveConfiguredHarnessId(configuration.values);
    } catch (error) {
      // A model selection that names no supported Harness is the Configuration's own fault,
      // not this Agent's; deployment refuses it with this message. Nothing below can run. A
      // fallback on another provider is refused here, by name, as the Harness rules below refuse
      // every other selection on another provider (finding 1298).
      if (error instanceof ConfigurationHarnessError) {
        requireFallbackProviders(configuration.values);
        return;
      }
      throw error;
    }
    const approved = resolveAgentHarness(resolveHarness, configuredHarnessId, agent.executionMode);
    if (approved?.id !== configuredHarnessId) {
      return;
    }
    const harness = Object.freeze({ ...approved, mode: agent.executionMode });
    if (agent.pluginDriver) {
      this.validatePluginPlacement(agent.pluginDriver, agent.plugins, harness);
    }
    const values = this.agentRuntimeConfiguration(configuration.values, harness, compute, sandbox);
    // A Configuration that selects no model yet is a draft: the binding has nothing to deliver
    // to, so deployment refuses that pair and save does not.
    const auth = selectsModel(configuration.values) ? await agent.harnessAuth() : undefined;
    if (auth !== undefined && compute.validateHarnessAuth !== undefined) {
      validateAgentHarnessAuth(compute, harness, auth, values, null);
    }
    if (
      agent.repositoryBindings !== undefined &&
      agent.repositoryBindings.length > 0 &&
      compute.validateRepositoryCredentials !== undefined
    ) {
      validateRepositoryTopology(compute, harness, sandbox?.id);
      this.validateRepositoryBrokerNetworkProxy(harness, values, sandbox);
    }
    if (agent.workspaceSetup) {
      validateWorkspaceSetupTopology(compute, harness, values, sandbox?.id);
    }
  }

  // The admission snapshot of a binding whose deploy-time admission adds no live state: the
  // operator-managed runtime, or a Secret (its record names the Secret Driver). Undefined for
  // every other binding, and for a Secret that is gone, which deployment refuses.
  private async savedHarnessAuthSnapshot(
    state: PlatformReadView,
    namespaceId: string,
    binding: HarnessAuthBinding | null,
  ): Promise<HarnessAuthSnapshot | undefined> {
    if (binding?.method === "runtime") {
      return binding;
    }
    if (binding === null || !isSecretHarnessAuth(binding)) {
      return undefined;
    }
    const source = await state.secrets.findSecret(namespaceId, binding.source.id);
    return source === undefined
      ? undefined
      : immutableCopy({ ...binding, secretDriverId: source.driverId });
  }

  private plannedHarnessAuth(value: unknown): HarnessAuthBinding | PlannedSecretHarnessAuth | null {
    const planned = asRecord(value);
    if (
      planned !== undefined &&
      Object.keys(planned).length === 1 &&
      (planned.method === "api_key" || planned.method === "codex_pat")
    ) {
      return Object.freeze({ method: planned.method });
    }
    return this.harnessAuthBinding(value);
  }

  // Create Agent's preflight snapshot: the operator-managed runtime as save takes it, and a Secret
  // binding as the selected Secret Driver would hold it, as provisioning builds it, without
  // reading the Secret (the preflight does not authorize its source). A Secret the caller saves
  // next has no ID yet; Agent save's checks read only its method and Secret Driver. Undefined
  // for every binding save cannot snapshot either.
  private plannedHarnessAuthSnapshot(
    namespaceId: string,
    binding: HarnessAuthBinding | PlannedSecretHarnessAuth | null,
  ): HarnessAuthSnapshot | undefined {
    if (binding?.method === "runtime") {
      return binding;
    }
    if (binding === null || binding.method === "credential_source") {
      return undefined;
    }
    if ("source" in binding) {
      return isSecretHarnessAuth(binding) ? this.secretHarnessAuthSnapshot(binding) : undefined;
    }
    const source: SecretReference = {
      kind: "secret",
      id: "sec_00000000-0000-4000-8000-000000000000",
      namespaceId,
    };
    return this.secretHarnessAuthSnapshot(
      binding.method === "api_key"
        ? { method: "api_key", source }
        : { method: "codex_pat", source },
    );
  }

  // Agent save's Harness authentication check for a provisioning request, ahead of the Compute
  // Driver's plan check. A refusal that names a setting, such as an Installation that cannot
  // place a dedicated Harness (finding 2395), then answers with save's and Create Agent's
  // preflight's 400 instead of the plan check's fixed 409. It uses the preflight's snapshot, which
  // needs no read, so it covers a Secret binding only. Admission repeats the full check with the
  // plan's Secret bindings, so every other binding, and a refusal that names nothing, gets
  // admission's answer in admission's order.
  private requireSavedHarnessAuth(
    namespaceId: string,
    compute: ComputeDriver,
    executionMode: HarnessExecutionMode,
    harnessAuth: HarnessAuthBinding,
    values: Readonly<OpenClawConfigurationDocument>,
  ): void {
    const auth = this.plannedHarnessAuthSnapshot(namespaceId, harnessAuth);
    if (auth === undefined || compute.validateHarnessAuth === undefined) {
      return;
    }
    let harnessId: string;
    try {
      harnessId = resolveConfiguredHarnessId(values);
    } catch {
      // A model selection that names no supported Harness: admission refuses it below.
      return;
    }
    const harness = { id: harnessId, version: "provisioning", mode: executionMode };
    try {
      compute.validateHarnessAuth(
        harness,
        auth,
        this.agentRuntimeConfiguration(values, harness, compute, this.sandboxDriver()),
        null,
      );
    } catch (error) {
      if (error instanceof ConfigurationHarnessError) {
        throw error;
      }
    }
  }

  // A Secret binding's snapshot as the selected Secret Driver holds it.
  private secretHarnessAuthSnapshot(
    binding: Extract<HarnessAuthBinding, { readonly source: SecretReference }>,
  ): HarnessAuthSnapshot {
    return immutableCopy({ ...binding, secretDriverId: this.secretDriver().id });
  }

  // The Configuration values a deployment admits for this Harness: the Sandbox Driver's view,
  // then the platform logging policy unless the Compute Driver owns logging.
  private agentRuntimeConfiguration(
    values: Readonly<OpenClawConfigurationDocument>,
    harness: RevisionHarnessDescriptor,
    compute: ComputeDriver,
    sandbox: SandboxDriver | undefined,
  ): OpenClawConfigurationDocument {
    if (harness.id === "openclaw") {
      requireSandboxOpenClawMode(sandbox, harness.mode);
    }
    const sandboxConfiguration =
      sandbox?.configureAgent !== undefined
        ? frozenValues(sandbox.configureAgent(frozenValues(values), harness))
        : values;
    // Every Compute Driver renders the Gateway's document from this snapshot.
    const securedConfiguration = admitGatewaySecurityDefaults(sandboxConfiguration);
    return frozenValues(
      compute.runtimeLogging === "driver"
        ? securedConfiguration
        : admitLoggingConfiguration(securedConfiguration, this.loggingLevel),
    );
  }

  private configurationDriverSelected(capability: DriverCapability, id: string): boolean {
    return this.drivers.configurationDriverSelected(capability, id);
  }

  private enabledPluginDrivers(): readonly PluginDriver[] {
    return this.drivers.enabledPluginDrivers();
  }

  private pluginDriver(harnessId: string, selection = false): PluginDriver {
    const drivers = this.enabledPluginDrivers();
    const driver = drivers.find((item) => item.harnessId === harnessId);
    if (!driver) {
      if (selection && drivers.length > 0) {
        throw new ConfigurationHarnessError(
          `No Plugin Driver is enabled for the ${harnessId} Harness. Remove the Agent's plugins or enable its catalog.`,
        );
      }
      throw new NotImplementedError(
        "agent_plugins.driver",
        "No selected Plugin Driver can represent Agent plugin configuration.",
      );
    }
    return driver;
  }

  /** Only a cleared Agent can start a selection owned by a different driver. */
  private pluginOwner(
    driver: PluginDriver,
    previous?: {
      readonly plugins?: PluginDesiredState;
      readonly pluginDriver?: PluginDriverIdentity;
    },
  ): PluginDriverIdentity {
    const identity = { id: driver.id, implementation: driver.implementation };
    if (
      previous?.plugins &&
      Object.keys(previous.plugins).length > 0 &&
      !isDeepStrictEqual(previous.pluginDriver, identity)
    ) {
      throw new ConfigurationHarnessError(
        "Clear the Agent's existing plugin selections before switching Plugin Drivers.",
      );
    }
    return identity;
  }

  private repositorySettings(
    namespaceId: string,
    input: {
      readonly repositoryBindings?: readonly RepositoryBindingRequest[];
      readonly repositoryAccess?: RepositoryAccess;
    },
  ): {
    repositoryBindings: readonly RepositoryBindingSelection[] | undefined;
    repositoryAccess?: RepositoryAccess;
  } {
    const resolve = (bindings: readonly RepositoryBindingRequest[] | undefined) =>
      this.repositoryBindingSelections(
        namespaceId,
        bindings,
        "request",
        this.installationRepositoryAdmission,
      );
    if (input.repositoryAccess === undefined) {
      return {
        repositoryBindings: resolve(input.repositoryBindings),
      };
    }
    if (input.repositoryBindings !== undefined || !validRepositoryAccess(input.repositoryAccess)) {
      throw new RepositoryBindingSelectionError(RepositoryBindingSelectionError.accessOrBindings);
    }
    const requested = input.repositoryAccess.repositories.map((entry) => ({
      repositoryRef: entry.repositoryRef,
      profile: entry.profile ?? input.repositoryAccess!.defaultProfile,
    }));
    const repositoryBindings = resolve(requested);
    return {
      repositoryBindings,
      repositoryAccess: normalizedRepositoryAccess(input.repositoryAccess, repositoryBindings)!,
    };
  }

  private get repositoryConfigured(): boolean {
    return (
      this.installationRepositoryAdmission?.policyMode === "built-in" ||
      this.drivers.hasSelection("repo")
    );
  }

  private repositoryPermissionOwner(admission: InstallationRepositoryAdmission | undefined) {
    if (admission?.policyMode === "built-in") {
      const identity = this.builtInRepositoryDriver;
      if (
        identity === undefined ||
        identity.driver !== admission.policy ||
        !unchangedDriver(identity)
      ) {
        return undefined;
      }
      return {
        driver: admission.policy,
        admission,
        unchanged: () => unchangedDriver(identity),
      };
    }
    let driver: RepositoryPolicyDriver;
    try {
      driver = this.selectedDriver("repo");
    } catch {
      return undefined;
    }
    if (admission !== undefined && admission.policy !== driver) {
      throw new DependencyUnavailableError("The bound repository admission owner is not selected.");
    }
    return {
      driver,
      admission,
      unchanged: () => {
        const selected = this.drivers.selection("repo");
        return selected?.driver === driver && unchangedDriver(selected);
      },
    };
  }

  private selectedStandingRepositoryAdmission(): InstallationRepositoryAdmission | undefined {
    const admission = this.installationRepositoryAdmission;
    return admission?.policyMode === "built-in" ||
      admission?.policy === this.drivers.selection("repo")?.driver
      ? admission
      : undefined;
  }

  /**
   * `origin` says whether the request sent `bindings` or they are saved state (an Agent's
   * bindings, or queued provisioning work): a selection the Driver refuses is a 400 about the
   * request, or a 409 about saved state the request did not send (finding 2536).
   */
  private resolveRepositoryBindings(
    namespaceId: string,
    bindings: readonly RepositoryBindingRequest[] | undefined,
    origin: "request" | "saved",
    admission?: InstallationRepositoryAdmission,
  ):
    | {
        readonly driver: RepositoryPolicyDriver;
        readonly resolution: RepositoryCredentialResolution;
      }
    | undefined {
    if (bindings === undefined) {
      return undefined;
    }
    if (!Array.isArray(bindings)) {
      throw new ScopeViolationError(
        "Repository bindings must be an array of repository selections.",
      );
    }
    if (bindings.length === 0) {
      return undefined;
    }
    if (!this.repositoryConfigured) {
      throw new RepositoryDriverNotConfiguredError();
    }
    const owner = this.repositoryPermissionOwner(admission);
    if (owner === undefined) {
      throw new DependencyUnavailableError(
        "The selected repository credential Driver is unavailable.",
      );
    }
    const { driver } = owner;
    let resolution: RepositoryCredentialResolution;
    try {
      const input = immutableCopy({ namespaceId, bindings });
      resolution =
        admission === undefined ? driver.resolve(input) : admission.policy.resolveBindings(input);
    } catch {
      // Every caller holds the Agent's or Namespace's grant, and the fixed text names no
      // repository or Driver reason, so it is a request or saved-state error, not a scope miss.
      throw origin === "request"
        ? new RepositoryBindingSelectionError(RepositoryBindingSelectionError.notApproved)
        : new SavedRepositorySelectionError();
    }
    if (
      !resolution ||
      !validAdmittedRepositoryBindings(resolution.bindings) ||
      !Number.isSafeInteger(resolution.sessionDurationSeconds) ||
      resolution.sessionDurationSeconds <= 0 ||
      !owner.unchanged()
    ) {
      throw new DependencyUnavailableError(
        "The selected repository credential Driver returned an invalid resolution.",
      );
    }
    const requested = new Map(
      bindings.map((binding) => [binding?.repositoryRef, binding?.profile]),
    );
    if (
      requested.size !== bindings.length ||
      resolution.bindings.length !== bindings.length ||
      resolution.bindings.some((binding) => {
        const backend = this.backendMap.get(binding.backendId);
        return (
          !requested.has(binding.repositoryRef) ||
          ((requested.get(binding.repositoryRef) !== undefined ||
            isInstallationRepositoryProfile(binding.profile)) &&
            requested.get(binding.repositoryRef) !== binding.profile) ||
          (admission !== undefined && binding.backendId !== admission.backendId) ||
          backend === undefined ||
          !("repo" in backend.drivers) ||
          backend.drivers.repo !== driver.id
        );
      })
    ) {
      throw new DependencyUnavailableError(
        "The repository credential resolution does not match the selected authority.",
      );
    }
    // Agent save and deploy admission both resolve here, so they refuse the same selections.
    if (
      resolution.bindings.length !== 1 &&
      resolution.bindings.some((binding) => isInstallationRepositoryProfile(binding.profile))
    ) {
      throw new RepositoryBindingSelectionError();
    }
    return { driver, resolution: immutableCopy(resolution) };
  }

  private repositoryBindingSelections(
    namespaceId: string,
    bindings: readonly RepositoryBindingRequest[] | undefined,
    origin: "request" | "saved" = "request",
    admission?: InstallationRepositoryAdmission,
  ): readonly RepositoryBindingSelection[] | undefined {
    const resolved = this.resolveRepositoryBindings(namespaceId, bindings, origin, admission);
    if (resolved === undefined || bindings === undefined) {
      return undefined;
    }
    const selections = new Map(
      resolved.resolution.bindings.map(({ repositoryRef, profile }) => [
        repositoryRef,
        { repositoryRef, profile },
      ]),
    );
    return immutableCopy(bindings.map(({ repositoryRef }) => selections.get(repositoryRef)!));
  }

  private admitRepositoryCredentials(
    agent: Readonly<Agent>,
    compute: ComputeDriver,
    harness: RevisionHarnessDescriptor,
    sandboxDriverId: string | undefined,
    admittedAtWallMs: number,
  ): RepositoryRevisionState | undefined {
    const resolved = this.resolveRepositoryBindings(
      agent.namespaceId,
      agent.repositoryBindings,
      "saved",
      this.installationRepositoryAdmission,
    );
    if (resolved === undefined) {
      return undefined;
    }
    validateRepositoryTopology(compute, harness, sandboxDriverId);
    const snapshot: RepositoryRevisionState = {
      driver: { id: resolved.driver.id, implementation: resolved.driver.implementation },
      deadlineWallMs: admittedAtWallMs + resolved.resolution.sessionDurationSeconds * 1000,
      bindings: resolved.resolution.bindings,
    };
    if (!validRepositoryRevisionState(snapshot)) {
      throw new DependencyUnavailableError(
        "The selected repository credential Driver returned an invalid admission snapshot.",
      );
    }
    return immutableCopy(snapshot);
  }

  private async driverOperation<T>(
    operation: () => Promise<T>,
    capability: "Configuration" | "ServiceAccount" | "Compute" | "TokenService" = "Configuration",
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof DependencyUnavailableError ||
        error instanceof ScopeViolationError ||
        error instanceof ResourceConflictError
      ) {
        throw error;
      }
      throw new DependencyUnavailableError(`The selected ${capability} Driver is unavailable.`);
    }
  }

  private exactConfiguration(
    configuration: Configuration,
    expected: Pick<
      Configuration,
      "id" | "namespaceId" | "kind" | "generation" | "createdAt" | "secretBindings"
    >,
  ): Readonly<Configuration> {
    return exactConfiguration(configuration, expected);
  }

  private nextIdentifier(kind: ResourceKind): string {
    const prefixes: Record<ResourceKind, string> = {
      installation: "ins",
      namespace: "ns",
      configuration: "cfg",
      preset: "pre",
      service_account: "sa",
      secret: "sec",
      agent: "agt",
      agent_revision: "rev",
      credential_source: "cs",
      sandbox_policy: "sbp",
    };
    const result = this.identifier
      ? this.identifier(kind)
      : `${prefixes[kind]}_${crypto.randomUUID()}`;
    if (!isNonEmptyString(result)) {
      throw new ScopeViolationError("The server generated an invalid resource identity.");
    }
    return result;
  }

  private timestamp(): string {
    const now = this.clock();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new ScopeViolationError("The controller clock returned an invalid timestamp.");
    }
    return now.toISOString();
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

  private validateLifecycleScope(result: unknown, namespace: Readonly<Namespace>): void {
    const candidate = result as {
      readonly namespaceId?: unknown;
    };
    if (!candidate || candidate.namespaceId !== namespace.id) {
      throw new DependencyUnavailableError(
        "The compute Driver returned lifecycle evidence for another Namespace.",
      );
    }
  }

  private validateEnsureResult(
    result: unknown,
    namespace: Readonly<Namespace>,
  ): asserts result is NamespaceEnsureResult {
    this.validateLifecycleScope(result, namespace);
    const candidate = result as Partial<NamespaceEnsureResult>;
    if (
      typeof candidate.namespaceReady !== "boolean" ||
      (candidate.failure !== undefined &&
        candidate.failure !== "retryable" &&
        candidate.failure !== "permanent")
    ) {
      throw new DependencyUnavailableError(
        "The compute Driver returned invalid Namespace readiness evidence.",
      );
    }
  }

  private validateDeleteResult(
    result: unknown,
    namespace: Readonly<Namespace>,
  ): asserts result is NamespaceDeleteResult {
    this.validateLifecycleScope(result, namespace);
    const candidate = result as Partial<NamespaceDeleteResult>;
    if (
      typeof candidate.namespaceDeleted !== "boolean" ||
      (candidate.failure !== undefined &&
        candidate.failure !== "retryable" &&
        candidate.failure !== "permanent")
    ) {
      throw new DependencyUnavailableError(
        "The compute Driver returned invalid Namespace deletion evidence.",
      );
    }
  }

  private async recordLifecycleResult(
    actorId: string,
    namespace: Readonly<Namespace>,
    compute: ComputeDriver | undefined,
    outcome: "success" | "failure",
    details: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.mutate((state) =>
      this.appendLifecycleAudit(state, actorId, namespace, compute, outcome, details),
    );
  }

  private async appendLifecycleAudit(
    state: PlatformUnitOfWork,
    actorId: string,
    namespace: Readonly<Namespace>,
    compute: ComputeDriver | undefined,
    outcome: "success" | "failure",
    details: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    let iamDriverId: string | undefined;
    try {
      iamDriverId = this.selectedDriver("iam").id;
    } catch {
      iamDriverId = undefined;
    }
    await state.audit.append({
      id: `aud_${crypto.randomUUID()}`,
      installationId: this.installation.id,
      namespaceId: namespace.id,
      occurredAt: this.timestamp(),
      kind: "mutation",
      actorId,
      source: "occ",
      action:
        namespace.status === "deleting"
          ? "openclaw.namespaces.lifecycle.delete"
          : "openclaw.namespaces.lifecycle.ensure",
      resource: {
        kind: "namespace",
        id: namespace.id,
        namespaceId: namespace.id,
      },
      ...(iamDriverId === undefined ? {} : { iamDriverId }),
      outcome,
      details: Object.freeze({
        ...(compute === undefined ? {} : { computeDriverId: compute.id }),
        ...details,
      }),
    });
  }

  private async record(
    state: PlatformUnitOfWork,
    operation: ReconciliationOperation,
  ): Promise<void> {
    if (this.shouldRecordOperations) {
      await state.operations.append(operation, this.requestAuditId.getStore());
    }
  }
}
export { PostgresMetricsSnapshot } from "./state/postgres-metrics.ts";
export type { PlatformMetricsSnapshot } from "./state/postgres-metrics.ts";

/** Keep internal reduction custody out of caller-visible withdrawal status. */
function credentialWithdrawalStatus(
  withdrawal: CredentialWithdrawal,
  withdrawalInProgress: boolean,
): Readonly<CredentialWithdrawalStatus> {
  return Object.freeze({
    namespaceId: withdrawal.namespaceId,
    agentId: withdrawal.agentId,
    revisionId: withdrawal.revisionId,
    credentialSourceId: withdrawal.credentialSourceId,
    state: withdrawal.state,
    requestedBy: withdrawal.requestedBy,
    requestedAt: withdrawal.requestedAt,
    ...(withdrawal.completedAt === undefined ? {} : { completedAt: withdrawal.completedAt }),
    ...(withdrawal.lastReason === undefined ? {} : { lastReason: withdrawal.lastReason }),
    ...(withdrawal.lastAttemptAt === undefined ? {} : { lastAttemptAt: withdrawal.lastAttemptAt }),
    withdrawalInProgress,
  });
}
