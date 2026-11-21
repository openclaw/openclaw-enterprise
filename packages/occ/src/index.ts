import {
  reconcileNamespaceLifecycle,
  selectedNamespaceLifecycle,
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
  CONFIGURED_IAM_ID_PREFIXES,
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
import { InstalledDriver } from "./installed-driver.ts";
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
import type { DriverByCapability } from "@openclaw-enterprise/contracts";
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
import { deploymentDiagnostics, withHarnessDiagnostic } from "./deployment-diagnostics.ts";
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
  AgentRuntimeHarnessStatus,
  AgentHarnessStatusRead,
  ComputeAgentRevisionBinding,
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
  CredentialSourceDeviceAuthorization,
  CredentialSourceDeviceAuthorizationResult,
  HarnessExecutionMode,
  IAMConfiguredPolicy,
  IAMConfiguredPolicyChanges,
  IAMDriver,
  Installation,
  InstallationCapabilities,
  InstallationDeploymentInventory,
  RepositoryWorkerRestartDisposition,
  Namespace,
  NamespaceDeleteResult,
  NamespaceEnsureResult,
  LoggingLevel,
  OpenClawConfigurationDocument,
  ManagedIAMResourceKind,
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
  SandboxHarnessLostCode,
  Secret,
  SecretBindings,
  SecretReference,
  SecretConsumers,
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
  HARNESS_EXECUTION_MODES,
  isName,
  NAME_RULE,
  normalizeInitialWorkspaceFiles,
  normalizeWorkspaceDefaultsId,
  PERMISSION_ACTIONS,
  isSupportedPermission,
  RESOURCE_KINDS,
  normalizeLoggingLevel,
  normalizePluginDesiredState,
  normalizePluginApprovers,
  normalizeSecretBindings,
  isSecretHarnessAuth,
  isServiceAccountHarnessAuth,
  freezeAgentRevision,
} from "@openclaw-enterprise/contracts";
import {
  asRecord,
  hasControlCharacter,
  immutableCopy,
  isNonEmptyString,
} from "@openclaw-enterprise/utils";
import { type ModelPolicyAgent, resolveConfiguredHarnessId } from "./configured-harness.ts";
import { workMatchesRevision, type ClaimedWork } from "./controller-work.ts";
import {
  createAgentQueries,
  type AgentRevisionListPage,
  type ActiveAgentRevisionSelection,
} from "./agent-queries.ts";
import { requireDeployableRoster, withAgentIdentityName } from "./openclaw-roster.ts";
import {
  capability,
  driverHasCapabilityContract,
  driverHasValidLifecycleHooks,
} from "./driver-contract.ts";
import {
  AGENT_NAME_CONFLICT,
  AgentCredentialSourceBindingError,
  AgentDeletingError,
  BrowserAuthorizationError,
  AuthorizationDeniedError,
  CallerStateDeniedError,
  DeletionRetryOwnedError,
  AuditAppendUnavailableError,
  DependencyUnavailableError,
  RuntimeDiagnosticsTransportError,
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
  CredentialProxyRepositoryOnlyError,
  CredentialSourceConfigError,
  CredentialSourceDriverError,
  CredentialSourceTypeNotOfferedError,
  CredentialSourceUnprotectedError,
  CredentialWithdrawalInProgressError,
  CredentialWithdrawalNotFoundError,
  IAMAccessBindingRoleError,
  IAMPolicyValidationError,
  keyedSettingPath,
  ModelProviderSettingError,
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
  RuntimeLogsError,
  ScopeViolationError,
  TokenServiceRegistrationRefusedError,
  SecretBindingDriverError,
  ServiceAccountBackendBindingError,
  ServiceAccountDriverNotConfiguredError,
  SecretBindingValidationError,
  SecretDriverOwnershipError,
  SecretReferencedError,
  SecretStorageDriverError,
  SecretValueError,
  WorkClaimLostError,
} from "./errors.ts";
import {
  refuseUndeployableConfigurationValues,
  validateConfigurationSettings,
} from "./configuration-settings.ts";
import { enabledChannelEntries, requireChannelSecretBindings } from "./channel-secret-bindings.ts";
import { validateModelProviderSettings } from "./model-provider-settings.ts";
import {
  admitsOpenClawExecutionMode,
  agentRuntimeConfiguration,
  createSavedAgentTopologyValidator,
  requireDedicatedNativeSupport,
  requireSandboxExecutionMode,
  requireSandboxOpenClawMode,
  resolveAgentHarness,
  validateAgentHarnessAuth,
  validateComputeAgentProvisioning,
  validateRepositoryTopology,
  validateWorkspaceSetupTopology,
  type HarnessResolver,
} from "./agent-harness-topology.ts";
import {
  createHarnessAuthOperations,
  harnessAuthBinding,
  plannedHarnessAuth,
  requireCredentialSourceSandbox,
  SERVICE_ACCOUNT_CROSS_NAMESPACE,
  type PlannedSecretHarnessAuth,
} from "./harness-auth.ts";
import { freezeConfigurationValues } from "./configuration-settings.ts";

export type { HarnessResolver } from "./agent-harness-topology.ts";
export type { PlannedSecretHarnessAuth } from "./harness-auth.ts";
import {
  describedAgentRuntime,
  readDriverRuntimeLogs,
  runtimeLogOperation,
  withSandboxLogSource,
} from "./runtime-logs/driver-read.ts";
import type {
  RuntimeLogCursorCodec,
  RuntimeLogPage,
  RuntimeLogQuery,
  RuntimeLogViewAdmission,
} from "./runtime-logs/index.ts";
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
import {
  InMemoryPlatformState,
  type PlatformReadView,
  type PlatformOperation,
  type PlatformStateStore,
  type PlatformUnitOfWork,
} from "./state/platform-state.ts";
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
  PROVISIONING_DEPLOYMENT_PENDING,
  provisioningProgress,
  requireProvisioningRequestId,
  type ProvisionAgentInput,
  type ProvisionAgentResult,
  type AgentProvisioningConfigurationInput,
} from "./agent-provisioning.ts";
import {
  provisioningEffectReceipt as readProvisioningEffectReceipt,
  provisioningPendingEffect,
  settleProvisioningEffect as buildProvisioningEffectSettlement,
  unrecordedProvisioningConfiguration,
  withUnrecordedProvisioningConfiguration,
  withoutUnrecordedProvisioningConfiguration,
  type ProvisioningEffectReceipt,
  type ProvisioningEffectTarget,
} from "./provisioning-effects.ts";
import type {
  AgentProvisioningCheckpoint,
  AgentProvisioningRecord,
} from "./state/agent-provisioning.ts";

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
export {
  provisioningEffectReceipt,
  provisioningPendingEffect,
  type ProvisioningEffectReceipt,
  type ProvisioningEffectTarget,
  type ProvisioningPendingEffect,
} from "./provisioning-effects.ts";
export {
  InMemoryPlatformState,
  type PredecessorReplacement,
  type AgentRevisionReadRepository,
  type InMemoryPlatformStateOptions,
  type PlatformAuditSink,
  type PlatformOperation,
  type ConnectionTokenCustody,
  type PlatformReadView,
  type PlatformStateStore,
  type PlatformUnitOfWork,
  type ServiceAccountReadRepository,
} from "./state/platform-state.ts";
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
export {
  PostgresWorkQueue,
  repositoryWithdrawalStateSql,
  type ClaimRequest,
  type EnqueueWork,
  type PermanentFailure,
  type PostgresQueryClient,
  type PostgresWorkQueueOptions,
  type RecoveryRequest,
  type RecoverySummary,
  type RetryableFailure,
  type WorkClaim,
  type WorkResult,
} from "./state/postgres-work-queue.ts";
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
export type { AgentProvisioningRecord } from "./state/agent-provisioning.ts";

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

/** The Agent action that admitted a runtime log read, recorded on its access audit event. */
export interface RuntimeLogReadGrant {
  readonly action: "read_logs" | "administer";
}

/**
 * Runs an authorized caller's runtime Driver reads; the API applies its per-caller rate
 * limit and replica concurrency limit here, after authorization.
 */
export type RuntimeLogReadAdmission = <T>(read: () => Promise<T>) => Promise<T>;

export class AgentAuditDisclosureUnavailableError extends DependencyUnavailableError {
  constructor() {
    super("The Agent audit disclosure record is unavailable.");
  }
}

/**
 * The Installation `iam` configuration (RFC-0026), with the configuration's own names. OCC writes
 * each Role, Group, and binding as an ordinary IAM row with a configured ID prefix.
 */
export interface InstallationIAMConfiguration {
  readonly roles: readonly {
    readonly id: string;
    readonly permissions: readonly Permission[];
  }[];
  /** Groups that each account created through `POST /api/auth/accounts` joins. */
  readonly defaultUserGroups: readonly string[];
  /** The configured Role that OCC binds to each creator on what it creates. */
  readonly ownerRole?: string;
  readonly roleBindings: readonly {
    readonly group: string;
    readonly role: string;
    readonly scope: "installation" | { readonly namespace: string };
  }[];
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

/** The result of a ServiceAccount deletion. */
export interface ServiceAccountDeletion {
  readonly removedAccessBindings: readonly RemovedAccessBinding[];
  /**
   * Set only when a forced deletion removed an account whose issued access token no
   * ServiceAccount Driver could revoke. The token itself is never read. Its Backend binding
   * is absent when OCC has no record of it.
   */
  readonly unrevokedCredential?: {
    readonly backendId?: string;
    readonly workspaceId?: string;
    /** The provider account the credential belongs to; the provider revokes by both IDs. */
    readonly externalAccountId?: string;
    readonly credentialId?: string;
  };
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

export interface CreateServiceAccountInput {
  readonly namespaceId: string;
  readonly name: string;
}

export interface CreateSecretInput {
  readonly namespaceId: string;
  readonly name: string;
  readonly value: string;
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

export interface UpdateSecretInput {
  readonly namespaceId: string;
  readonly secretId: string;
  readonly value: string;
}

export interface CreateConfigurationInput {
  readonly namespaceId: string;
  readonly kind: Configuration["kind"];
  readonly values: Readonly<OpenClawConfigurationDocument>;
  readonly secretBindings?: SecretBindings;
}

export interface CreateIAMRoleInput {
  readonly namespaceId: string;
  readonly name?: string;
  readonly permissions: readonly Permission[];
}

export interface CreateIAMAccessBindingInput {
  readonly namespaceId: string;
  readonly subjectKind: "identity";
  readonly subjectId: string;
  readonly roleId: string;
  readonly resourceKind: ResourceKind;
  readonly resourceId: string;
}

export interface UpdateConfigurationInput {
  readonly namespaceId: string;
  readonly configurationId: string;
  readonly values: Readonly<OpenClawConfigurationDocument>;
  readonly secretBindings?: SecretBindings;
  /** Refuses the update unless the Configuration is still at this generation. */
  readonly expectedGeneration?: number;
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

export type AgentProvisioningWorkerOutcome =
  | { readonly outcome: "succeeded"; readonly revisionId: string }
  | {
      /** `pending` waits out a settle window without spending an attempt. */
      readonly outcome: "retry" | "permanent" | "pending";
      readonly code: string;
      /** A Compute refusal's reason for the operator log; status keeps the fixed text. */
      readonly reason?: string;
      /**
       * For the operator log: a Configuration the refused job wrote but never recorded, which
       * its Driver could not delete. Nothing references it any more.
       */
      readonly orphanedConfigurationId?: string;
    };

export interface AgentProvisioningWorkerOptions {
  readonly runEffect?: <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<T>;
}

interface RegisteredDriver {
  readonly harnessId?: string;
  readonly owner?: InstalledDriver;
  readonly driver: Driver;
  readonly capability: DriverCapability;
  readonly id: string;
  readonly implementation: string;
}

type DriverFor<Capability extends DriverCapability> = DriverByCapability[Capability];

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
// Bounds the Sandbox Driver's Harness record read that runs beside Compute diagnostics.
const HARNESS_OBSERVATION_TIMEOUT_MS = 10_000;
const REPOSITORY_RESTART_OBSERVATION_TIMEOUT_MS = 10_000;
const HARNESS_LOST_CODES: ReadonlySet<string> = new Set<SandboxHarnessLostCode>([
  "SANDBOX_MISSING",
  "SANDBOX_DELETING",
  "SANDBOX_STOPPED",
  "SANDBOX_FAILED",
  "HARNESS_EXITED",
]);

/**
 * A Credential Gateway must finish any effect of an aborted registration within
 * CREDENTIAL_GATEWAY_TIMEOUT_MS after the abort. Until this long after `createdAt`, an absent
 * gateway copy does not prove that no late create is still in flight, so the record is kept.
 */
const CREDENTIAL_REGISTRATION_FENCE_MS = 2 * CREDENTIAL_GATEWAY_TIMEOUT_MS + 10_000;
/**
 * How long after a provisioning Configuration create was recorded an absent Configuration may
 * still be a late create in flight (finding 911). The Kubernetes Driver gives up on a write after
 * 10 s, and the API server ends a request it accepted within its request timeout (60 s by
 * default), so a create that has not appeared 90 s after the effect began (database clock) is
 * sent again. A late original then meets an existing ConfigMap and fails AlreadyExists.
 */
const PROVISIONING_CONFIGURATION_SETTLE_MS = 90_000;

/**
 * How far a stored Configuration may run ahead of its record and still count as a leftover of
 * failed writes (finding 1396). Each failed update whose compensation could not run adds one, and
 * update advances the record once per skipped generation, so the bound also caps that work.
 * A document further ahead fails closed, as any other mismatch does.
 */
const MAX_CONFIGURATION_LEFTOVER_LEAD = 100;

/**
 * The most references a Secret read or delete examines. Each one costs authorization work,
 * so the bound keeps both the response and the IAM work small. Delete makes those decisions
 * while it holds the Namespace and Secret locks, so the bound also limits that lock window.
 */
const SECRET_CONSUMER_LIMIT = 50;
/**
 * The IDs of one kind that a NAMESPACE_NOT_EMPTY conflict examines and may name. Each costs
 * one read decision while deletion holds the Namespace lock, so the bound limits that work.
 */
const NAMESPACE_NOT_EMPTY_ID_LIMIT = 20;
const SECRET_CONSUMER_KINDS = Object.freeze([
  "agents",
  "configurations",
  "credentialSources",
  "provisioningRequests",
] as const);
type SecretReferenceKind = Awaited<
  ReturnType<PlatformReadView["secrets"]["listReferences"]>
>["references"][number]["kind"];
const SECRET_CONSUMER_FIELDS: Readonly<
  Record<SecretReferenceKind, (typeof SECRET_CONSUMER_KINDS)[number]>
> = Object.freeze({
  agent: "agents",
  configuration: "configurations",
  credential_source: "credentialSources",
  provisioning_request: "provisioningRequests",
});

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
 * Names as many unsupported Permissions as fit the 256-character error message contract; a
 * Role of 64 Permissions can hold far more than fit.
 */
function unsupportedPermissionsMessage(unsupported: readonly string[]): string {
  return fittedList(
    "No operation checks these Permissions, so they would grant nothing: ",
    unsupported,
    ". See the per-kind actions in the permissions reference.",
  );
}

/**
 * Renders `prefix`, as many `items` as fit and `suffix` within the 256-character
 * ErrorResponse.message cap, so the guidance after a long list is never cut off.
 * At least one item is always shown.
 */
function fittedList(prefix: string, items: readonly string[], suffix: string): string {
  const render = (shown: number): string => {
    const more = items.length - shown;
    return `${prefix}${items.slice(0, shown).join(", ")}${more === 0 ? "" : ` and ${more} more`}${suffix}`;
  };
  let shown = items.length;
  while (shown > 1 && render(shown).length > 256) {
    shown -= 1;
  }
  return render(shown);
}

/**
 * A pending provisioning Configuration create is not visible yet but may still be in flight, so
 * the attempt defers for the rest of the settle window instead of spending a retry (finding 911).
 */
class ProvisioningConfigurationSettlingError extends DependencyUnavailableError {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super("The pending Configuration provisioning effect outcome is unknown.");
    this.retryAfterMs = retryAfterMs;
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

/**
 * The provisioning status message for a worker failure. Only the shared duplicate-name,
 * Compute refusal, Secret Driver ownership, missing ChatGPT Backend, repository and Credential
 * Proxy texts and the
 * plugin-policy, native-support and Configuration Harness refusals pass through; other error
 * messages stay internal. Those refusals name only Installation configuration, the work's own
 * plugin selection and settings in its own Configuration, and HTTP returns them verbatim. The
 * status contract caps `error.message` at 256 characters.
 */
function provisioningFailureMessage(code: string, error: unknown): string {
  if (code === "PROVISIONING_REJECTED") {
    if (
      (error instanceof ResourceStateConflictError && error.message === AGENT_NAME_CONFLICT) ||
      // Fixed, id-free text naming the Credential Proxy refusal (finding 2360).
      error instanceof CredentialProxyRepositoryOnlyError ||
      error instanceof CredentialSourceUnprotectedError ||
      error instanceof ComputeGatewaySettingError ||
      error instanceof ComputeProvisioningRefusedError ||
      // Fixed, id-free text that names the fix (save replacement Secrets, submit a new request).
      error instanceof SecretDriverOwnershipError ||
      // Fixed, id-free texts naming the missing or mismatched ChatGPT Backend.
      error instanceof ServiceAccountDriverNotConfiguredError ||
      error instanceof ServiceAccountBackendBindingError ||
      // Fixed, id-free text naming the missing repository settings (finding 2362).
      error instanceof RepositoryDriverNotConfiguredError ||
      // Fixed, id-free repository and protected admission texts (finding 2536): a Compute
      // Driver without repository credentials, selections the request or the queued work holds
      // that are not (or no longer) approved, and a Credential Proxy that cannot start the Agent.
      error instanceof ComputeRepositoryCredentialsUnsupportedError ||
      error instanceof RepositoryBindingSelectionError ||
      error instanceof SavedRepositorySelectionError ||
      error instanceof CredentialProxyAdmissionError
    ) {
      return error.message;
    }
    if (
      error instanceof PluginPolicyValidationError ||
      error instanceof NativeWorkerSupportError ||
      error instanceof ConfigurationHarnessError ||
      error instanceof ModelProviderSettingError
    ) {
      // A Configuration refusal can name a submitted key; status stores the message as is.
      const characters = Array.from(error.message.replace(/[\p{Cc}\p{Cf}]|\p{Cs}/gu, "?"));
      return characters.length <= 256
        ? characters.join("")
        : `${characters.slice(0, 255).join("")}…`;
    }
  }
  return "Agent provisioning could not complete.";
}

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

/** Resource kinds that Namespace IAM Roles and AccessBindings may name. */
const NAMESPACE_POLICY_RESOURCE_KINDS: ReadonlySet<ResourceKind> = new Set<ResourceKind>([
  "namespace",
  "agent",
  "agent_revision",
  "configuration",
  "credential_source",
  "sandbox_policy",
  "preset",
  "secret",
  "service_account",
]);

/**
 * Why an Agent has no per-Agent network policy (D774): the policy view, validate, save, apply
 * and the editing switch all give the same sentence. Without a Sandbox Driver there is no
 * Sandbox at all, so the cause is the Installation's selection, not a Driver capability.
 */
/**
 * Why the Namespace policy API refuses `create` Permissions. `create` is authorized against
 * the Namespace collection, never an existing resource, and this API binds only exact
 * resources, so such a Permission could never take effect through it. Role creation and
 * binding creation share the reason so their refusals stay consistent.
 */
const NAMESPACE_POLICY_CREATE_REASON =
  "Create is checked on the Namespace, and this API binds only exact resources";

/**
 * Refuses an AccessBinding whose Role cannot take effect on the binding's target, so a
 * policy write never reports success for a grant that IAM evaluation drops. Role creation
 * already refuses `create` Permissions; this check still covers stored Roles that predate
 * that refusal. A Role with no Permission for the target's kind grants nothing there.
 * Roles that also name other kinds stay valid: one Role may be bound to several targets.
 */
function assertAccessBindingRoleApplies(role: Readonly<Role>, resourceKind: ResourceKind): void {
  const label = (permission: Readonly<Permission>) =>
    `${permission.resourceKind}:${permission.action}`;
  const creates = role.permissions.filter((permission) => permission.action === "create");
  if (creates.length > 0) {
    throw new IAMAccessBindingRoleError(
      fittedList(
        `Role ${role.id} has Permissions this API cannot bind: `,
        creates.map(label),
        `. ${NAMESPACE_POLICY_CREATE_REASON}; bind a Role without them.`,
      ),
    );
  }
  if (!role.permissions.some((permission) => permission.resourceKind === resourceKind)) {
    throw new IAMAccessBindingRoleError(
      fittedList(
        `Role ${role.id} grants nothing on the ${resourceKind} target: its Permissions (`,
        role.permissions.map(label),
        `) apply only to other kinds; bind it to one of those or add ${resourceKind} Permissions.`,
      ),
    );
  }
}

// A rule about the request alone, checked before any ServiceAccount grant or lookup, so the text
// is the same whether the named account exists (finding 2536).
/**
 * Rejects requested Secret references (bindings and Harness authentication) that name
 * another Namespace. It compares only the request against its route Namespace, so it
 * reveals nothing about other Namespaces and can run before any Secret lookup.
 */
function rejectCrossNamespaceSecretSources(
  namespaceId: string,
  secretBindings: SecretBindings | undefined,
  harnessAuth: HarnessAuthBinding | null | undefined,
): void {
  const sources = Object.values(secretBindings ?? {}).map(({ source }) => source);
  if (isSecretHarnessAuth(harnessAuth)) {
    sources.push(harnessAuth.source);
  }
  if (sources.some((source) => source.namespaceId !== namespaceId)) {
    throw new SecretBindingValidationError("Secret references cannot cross Namespaces.");
  }
}

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
          !controller.unchangedDriver(identity)
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
  private readonly iamConfiguration?: InstallationIAMConfiguration;
  private readonly authorization?: ControllerOptions["authorize"];
  private readonly deviceLoginCipher: ReturnType<typeof deviceAuthorizationCipher> | undefined;
  private readonly clock: () => Date;
  private readonly identifier?: ControllerOptions["createId"];
  private readonly state: PlatformStateStore;
  private readonly agentAuditState: ControllerOptions["agentAuditState"];
  private readonly authority: ControllerAuthority;
  private readonly transactions: ControllerTransactions;
  private readonly requestAuditId = new AsyncLocalStorage<string>();
  private readonly provisioningContext = new AsyncLocalStorage<ClaimedWork>();
  private readonly shouldRecordOperations: boolean;
  private readonly nativeWorkers: NativeWorkerSupportSource | undefined;
  private readonly credentialProxyCapacity: CredentialProxyCapacity;
  private readonly registry = new Map<string, RegisteredDriver>();
  private readonly pluginDiscovery: ReturnType<typeof createPluginDiscovery>;
  private tokenServiceInstance: Readonly<TokenServiceInstance> | undefined;
  private readonly preparedTokens: TokenService | undefined;
  private readonly selections = new Map<DriverCapability, RegisteredDriver>();
  private readonly namespaceLifecycleBindings: readonly NamespaceLifecycleBinding[];
  private pluginRegistrations: readonly RegisteredDriver[] = [];
  private readonly backends: readonly BackendDefinition[];
  private readonly presets: ReturnType<
    typeof createPresetOperations<PlatformReadView, PlatformUnitOfWork>
  >;
  private readonly loggingLevel: LoggingLevel;
  private readonly harnessAuthOperations: ReturnType<typeof createHarnessAuthOperations>;
  private readonly validateSavedAgentTopology: ReturnType<typeof createSavedAgentTopologyValidator>;
  private readonly backendMap: ReadonlyMap<string, BackendDefinition>;
  private readonly configuredServiceAccountDriverId: string | undefined;

  constructor(installation: Installation, options: ControllerOptions = {}) {
    this.namespaceLifecycleBindings = options.namespaceLifecycleBindings ?? [];
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
    if (options.iamConfiguration !== undefined) {
      this.iamConfiguration = options.iamConfiguration;
    }
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
      harnessAuthBinding: (value) => harnessAuthBinding(value),
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
    if (options.authenticationStateEncryptionSecret) {
      this.deviceLoginCipher = deviceAuthorizationCipher(
        options.authenticationStateEncryptionSecret,
      );
    }
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
      hasPluginDrivers: () => this.pluginRegistrations.length > 0,
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
    this.harnessAuthOperations = createHarnessAuthOperations({
      authority: this.authority,
      authorizeBoundCredentialSources: (principalId, namespaceId, sources) =>
        this.authorizeBoundCredentialSources(principalId, namespaceId, sources),
      backends: this.backendMap,
      exactServiceAccount: (state, namespaceId, id) =>
        this.exactServiceAccount(state, namespaceId, id),
      ownedSecretDriver: (driverId, failure) => this.ownedSecretDriver(driverId, failure),
      secretDriver: (id) => this.secretDriver(id),
      secretOperation: (operation) => this.secretOperation(operation),
      isManagedTokenServiceSource,
      hasCredentialGateway: () => this.selections.has("credential_gateway"),
      assertCredentialGatewaySelected: () => this.assertCredentialGatewaySelected(),
      ownedTokenServiceDriver: (id) => this.ownedTokenServiceDriver(id),
      ownedCredentialGatewayDriver: (source) => this.ownedCredentialGatewayDriver(source),
      credentialGatewayDriver: (id) => this.credentialGatewayDriver(id),
      credentialSourceType: (driver, type) => this.credentialSourceType(driver, type),
      hasServiceAccountDriver: () =>
        this.selections.has("service_account") ||
        this.configuredServiceAccountDriverId !== undefined,
      serviceAccountDriverId: () => this.serviceAccountDriverId(),
      sandboxDriver: () => this.sandboxDriver(),
      agentRuntimeConfiguration: (values, harness, compute, sandbox) =>
        this.agentRuntimeConfiguration(values, harness, compute, sandbox),
    });
    this.validateSavedAgentTopology = createSavedAgentTopologyValidator({
      sandboxDriver: () => this.sandboxDriver(),
      selectedCompute: () => this.selections.get("compute")?.driver as ComputeDriver | undefined,
      validatePluginPlacement: (driver, plugins, harness) =>
        this.validatePluginPlacement(driver, plugins, harness),
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
    this.configuredServiceAccountDriverId = options.configuredServiceAccountDriverId;
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
    const owner = driver instanceof InstalledDriver ? driver : undefined;
    const views = owner ? owner.capabilities.map((key) => owner.require(key)) : [driver as Driver];
    const entries = views.map((view) => this.driverRegistrationEntry(view, owner));
    if (
      owner &&
      [...this.registry.values()].some((entry) => entry.owner?.ref.id === owner.ref.id)
    ) {
      throw new DriverSelectionError(
        "A Driver is already registered for this installation identity.",
      );
    }
    // Check every capability and conflict before exposing any part of this registration.
    for (const [key, entry] of entries) {
      this.registry.set(key, entry);
    }
    return driver;
  }

  /** Install one trusted catalog per Harness family. */
  installPluginDrivers(drivers: readonly PluginDriver[]): void {
    const registrations = drivers.map((driver) => this.driverRegistrationEntry(driver));
    if (
      new Set(drivers.map((driver) => driver.harnessId)).size !== drivers.length ||
      new Set(drivers.map((driver) => driver.id)).size !== drivers.length
    ) {
      throw new DriverSelectionError(
        "Each Plugin Driver must have a distinct identity and Harness.",
      );
    }
    this.selectPluginRegistrations(registrations.map(([, entry]) => entry));
    for (const [key, entry] of registrations) {
      this.registry.set(key, entry);
    }
  }

  private selectPluginRegistrations(entries: readonly RegisteredDriver[]): void {
    this.applyLifecycleDrivers(this.selections, entries);
    this.pluginRegistrations = entries;
  }

  /** Register one configured owner, then select its exact capability views. */
  installDriver(owner: InstalledDriver, select: readonly DriverCapability[]): void {
    const views = select.map((key) => owner.require(key));
    this.registerDriver(owner);
    for (const view of views) {
      this.selectDriver(view.capability, view.id);
    }
  }

  private driverRegistrationEntry(
    driver: Driver,
    owner?: InstalledDriver,
  ): [string, RegisteredDriver] {
    if (
      !driver ||
      !isNonEmptyString(driver.id) ||
      !isNonEmptyString(driver.implementation) ||
      !capability(driver.capability) ||
      !driverHasCapabilityContract(driver) ||
      !driverHasValidLifecycleHooks(driver)
    ) {
      throw new DriverSelectionError("The Driver does not satisfy its exact capability contract.");
    }
    if (
      driver.capability === "repo" &&
      this.installationRepositoryAdmission?.policyMode === "built-in"
    ) {
      throw new DriverSelectionError(
        "Built-in repository policy cannot be combined with a registered Repo Driver.",
      );
    }
    const key = this.driverKey(driver.capability, driver.id);
    if (this.registry.has(key)) {
      throw new DriverSelectionError(
        "A Driver is already registered for this exact capability and identity.",
      );
    }
    if (driver.capability === "sandbox" && (driver as SandboxDriver).networkPolicy !== undefined) {
      this.configurations.resolve("sandbox", driver.id, "agent", "sandbox-network-policy");
    }
    return [
      key,
      Object.freeze({
        driver,
        ...(driver.capability === "plugin"
          ? { harnessId: (driver as PluginDriver).harnessId }
          : {}),
        capability: driver.capability,
        id: driver.id,
        implementation: driver.implementation,
        ...(owner && { owner }),
      }),
    ];
  }

  selectDriver<Capability extends DriverCapability>(
    selectedCapability: Capability,
    driverId: string,
  ): DriverFor<Capability> {
    if (!capability(selectedCapability) || !isNonEmptyString(driverId)) {
      throw new DriverSelectionError(
        "The Driver capability or implementation identity is invalid.",
      );
    }
    const selected = this.registry.get(this.driverKey(selectedCapability, driverId));
    if (!selected || !this.unchangedDriver(selected)) {
      throw new DriverSelectionError(
        "No registered Driver matches the exact selected capability and identity.",
      );
    }
    if (selectedCapability === "plugin") {
      this.selectPluginRegistrations([selected]);
      return selected.driver as DriverFor<Capability>;
    }
    return this.applyDriverSelection(selectedCapability, selected);
  }

  selectedDriver<Capability extends DriverCapability>(
    selectedCapability: Capability,
  ): DriverFor<Capability> {
    if (!capability(selectedCapability)) {
      throw new DriverSelectionError("The requested Driver capability is invalid.");
    }
    const selected =
      selectedCapability === "plugin" && this.pluginRegistrations.length === 1
        ? this.pluginRegistrations[0]
        : this.selections.get(selectedCapability);
    if (!selected || !this.unchangedDriver(selected)) {
      throw new DriverSelectionError(
        "The selected Driver is unavailable or no longer matches its capability.",
      );
    }
    return selected.driver as DriverFor<Capability>;
  }

  private selectedProxyOwner(): InstalledDriver {
    const proxy = this.selections.get("credential_proxy");
    const sandbox = this.selections.get("sandbox");
    const owner = proxy?.owner;
    if (
      !owner ||
      owner !== sandbox?.owner ||
      owner.require("sandbox") !== sandbox.driver ||
      owner.require("credential_proxy") !== proxy.driver
    ) {
      throw new DriverSelectionError(
        "Protected execution requires Sandbox and Credential Proxy from the same registered Driver.",
      );
    }
    return owner;
  }

  async validateBackendConfiguration(): Promise<void> {
    const delivery = this.selections.get("credential_proxy_delivery");
    if (
      delivery !== undefined &&
      (!delivery.owner ||
        delivery.owner !== this.selections.get("sandbox")?.owner ||
        delivery.owner.require("credential_proxy_delivery") !== delivery.driver)
    ) {
      throw new DriverSelectionError(
        "Credential delivery and Sandbox must come from the same registered Driver.",
      );
    }
    const selected = Object.fromEntries(
      [...this.selections.entries()].map(([capability, selection]) => [
        capability,
        selection.driver,
      ]),
    );
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
      this.selections.has("credential_proxy") ? this.selectedProxyOwner() : undefined,
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

  private async capabilities(): Promise<InstallationCapabilities> {
    // openclaw lists the execution modes admission accepts for OpenClaw; an empty list means
    // none (#2670), and sandboxDriverUnavailable says that is an outage, not the Installation's
    // shape (finding 1624). nativeWorkers promises that dedicated native OpenClaw can be
    // admitted, so it is reported only when that mode is listed (finding 1608).
    const {
      nativeWorkers: _unchecked,
      openclaw: _derived,
      pluginCatalogs: _catalogs,
      ...declared
    } = this.installation.capabilities ?? {};
    const openclaw = this.openClawExecutionModes();
    const nativeWorkers = openclaw.executionModes.includes("dedicated")
      ? this.nativeWorkers
      : undefined;
    const gatewayTypes = this.selections.has("credential_gateway")
      ? await this.credentialGatewayOperation(() =>
          this.credentialGatewayDriver().listSourceTypes({
            signal: AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS),
          }),
        )
      : undefined;
    const protectedTypes = this.protectedSourceTypes().map(({ type }) => type);
    const types = [
      ...protectedTypes,
      ...(gatewayTypes ?? []).filter(
        (type) =>
          !protectedTypes.some((p) => p.type === type.type) &&
          (this.ordinaryCredentialGatewayAllowed(type) || this.staticSourceTypeAvailable(type)),
      ),
    ];
    const capabilities = {
      ...declared,
      ...(nativeWorkers === undefined ? {} : { nativeWorkers: { support: nativeWorkers } }),
      openclaw,
      ...(gatewayTypes || types.length ? { credentialSources: { types } } : {}),
    };
    const catalogs = this.enabledPluginDrivers().map((driver) => ({
      harnessId: driver.harnessId,
      pluginPolicies: {
        driver: { id: driver.id, implementation: driver.implementation },
        ...driver.policyCapabilities,
      },
      ...(driver.discoverCatalog && driver.getCatalogPlugin
        ? { pluginDiscovery: { credential: driver.discoveryCredential ?? "required" } }
        : {}),
    }));
    return {
      ...capabilities,
      ...(catalogs.length > 0 ? { pluginCatalogs: catalogs } : {}),
    };
  }

  /**
   * The OpenClaw execution modes this Installation's Sandbox Driver and runtime let an Agent
   * deploy. A selected Sandbox Driver that is unavailable admits none until it returns.
   */
  private openClawExecutionModes(): {
    executionModes: HarnessExecutionMode[];
    settingRefusals?: Partial<Record<HarnessExecutionMode, string>>;
    sandboxDriverUnavailable?: true;
  } {
    let sandbox: SandboxDriver | undefined;
    try {
      sandbox = this.sandboxDriver();
    } catch (error) {
      if (error instanceof DependencyUnavailableError) {
        return { executionModes: [], sandboxDriverUnavailable: true };
      }
      throw error;
    }
    const executionModes: HarnessExecutionMode[] = [];
    const settingRefusals: Partial<Record<HarnessExecutionMode, string>> = {};
    for (const mode of HARNESS_EXECUTION_MODES) {
      const admission = admitsOpenClawExecutionMode(sandbox, mode, this.nativeWorkers);
      if (admission === true) {
        executionModes.push(mode);
      } else if (
        mode === "dedicated" &&
        admission instanceof ConfigurationHarnessError &&
        sandbox?.supportsHarnessExecutionMode.openclaw[mode].reason !== undefined
      ) {
        // A Sandbox Driver that provisions dedicated OpenClaw but whose settings refuse it: say
        // which setting, in admission's own words (finding 2373).
        settingRefusals[mode] = admission.message;
      }
    }
    return {
      executionModes,
      ...(Object.keys(settingRefusals).length ? { settingRefusals } : {}),
    };
  }

  async getInstallationDeploymentInventory(
    principalId: string,
  ): Promise<Readonly<InstallationDeploymentInventory>> {
    const before = await this.deploymentInventorySnapshot(principalId);
    const computeSelection = this.selections.get("compute");
    const sandboxSelection = this.selections.get("sandbox");
    let compute: ComputeDriver | undefined;
    try {
      compute = this.selectedDriver("compute");
    } catch {
      // An unavailable implementation cannot supply positive restart evidence.
      compute = undefined;
    }
    const signal = AbortSignal.timeout(REPOSITORY_RESTART_OBSERVATION_TIMEOUT_MS);
    const dispositions = new Map<string, RepositoryWorkerRestartDisposition>();
    // Owner reads must not retain the State transaction or mutate repository custody.
    for (const [revisionId, revision] of before.revisions) {
      dispositions.set(
        revisionId,
        await this.observeRepositoryWorkerRestart(compute, revision, signal),
      );
    }
    // Reauthorize the whole fleet, including newly active Agents and pending deployments.
    // This detects changed selection; it does not replace exclusive maintenance ownership.
    const after = await this.deploymentInventorySnapshot(principalId);
    if (
      !isDeepStrictEqual(before, after) ||
      computeSelection !== this.selections.get("compute") ||
      sandboxSelection !== this.selections.get("sandbox") ||
      (compute !== undefined &&
        computeSelection !== undefined &&
        !this.unchangedDriver(computeSelection))
    ) {
      throw new DependencyUnavailableError(
        "The Agent deployment inventory changed during repository observation. Read it again.",
      );
    }
    return Object.freeze({
      ...after.inventory,
      namespaces: Object.freeze(
        after.inventory.namespaces.map((namespace) =>
          Object.freeze({
            ...namespace,
            agents: Object.freeze(
              namespace.agents.map((agent) => {
                const repositoryWorkerRestart =
                  agent.activeRevisionId === undefined
                    ? undefined
                    : dispositions.get(agent.activeRevisionId);
                return Object.freeze({
                  ...agent,
                  ...(repositoryWorkerRestart === undefined ? {} : { repositoryWorkerRestart }),
                });
              }),
            ),
          }),
        ),
      ),
    });
  }

  private async observeRepositoryWorkerRestart(
    compute: ComputeDriver | undefined,
    revision: Readonly<AgentRevision> | undefined,
    signal: AbortSignal,
  ): Promise<RepositoryWorkerRestartDisposition> {
    if (
      signal.aborted ||
      revision === undefined ||
      compute?.id !== revision.compute.id ||
      compute.implementation !== revision.compute.implementation ||
      compute.repositoryWorkerRestartDisposition === undefined
    ) {
      return "unknown";
    }
    let aborted: (() => void) | undefined;
    try {
      const result = await Promise.race([
        compute.repositoryWorkerRestartDisposition(revision, signal),
        new Promise<"unknown">((resolve) => {
          aborted = () => resolve("unknown");
          signal.addEventListener("abort", aborted, { once: true });
        }),
      ]);
      return result === "original-worker-required" ||
        result === "reverification-supported" ||
        result === "not-applicable"
        ? result
        : "unknown";
    } catch {
      return "unknown";
    } finally {
      if (aborted !== undefined) {
        signal.removeEventListener("abort", aborted);
      }
    }
  }

  private async deploymentInventorySnapshot(principalId: string) {
    await this.authorize(principalId, "administer", {
      kind: "installation",
      id: this.installation.id,
    });
    return this.read(async (state) => {
      const revisions = new Map<string, Readonly<AgentRevision> | undefined>();
      const deploymentsInProgress = new Set<string>();
      // Credential withdrawal targets an active revision without deploying it.
      const deployments = (await state.operations.list())
        .filter(
          (operation) =>
            operation.kind === "agent_revision" && operation.target !== "credentials_withdrawn",
        )
        .map(({ namespaceId, resourceId }) => ({
          namespaceId,
          revisionId: resourceId,
          key: `agent_revision:${resourceId}:reconcile`,
        }));
      const workByKey = await state.operations.findWorkByKeys(deployments.map(({ key }) => key));
      for (const { namespaceId, revisionId, key } of deployments) {
        const work = workByKey.get(key);
        if (
          work === undefined ||
          work.namespaceId !== namespaceId ||
          work.revisionId !== revisionId ||
          !isNonEmptyString(work.agentId)
        ) {
          throw new DependencyUnavailableError("The Agent deployment inventory is incomplete.");
        }
        if (work.state === "queued" || work.state === "claimed") {
          deploymentsInProgress.add(`${work.namespaceId}\u0000${work.agentId}`);
        }
      }

      const namespaces = [];
      for (const namespace of await state.namespaces.listNamespaces()) {
        await this.authorize(principalId, "read", {
          kind: "namespace",
          id: namespace.id,
          namespaceId: namespace.id,
        });
        const agents = [];
        for (const agent of await state.agents.listAgents(namespace.id)) {
          await this.authorize(principalId, "read", {
            kind: "agent",
            id: agent.id,
            namespaceId: namespace.id,
          });
          const deploymentInProgress = deploymentsInProgress.has(
            `${namespace.id}\u0000${agent.id}`,
          );
          if (
            agent.status === "active" &&
            agent.desiredRuntimeState === "running" &&
            agent.activeRevisionId !== undefined &&
            !deploymentInProgress
          ) {
            await this.authorize(principalId, "deploy", {
              kind: "agent",
              id: agent.id,
              namespaceId: namespace.id,
            });
            await this.authorize(principalId, "read", {
              kind: "agent_revision",
              id: agent.activeRevisionId,
              namespaceId: namespace.id,
              parentAgentId: agent.id,
            });
            const revision = await state.revisions.findRevisionForBrowsing(
              namespace.id,
              agent.id,
              agent.activeRevisionId,
            );
            revisions.set(
              agent.activeRevisionId,
              revision !== undefined &&
                !("configurationReadError" in revision) &&
                revision.id === agent.activeRevisionId &&
                revision.namespaceId === namespace.id &&
                revision.agentId === agent.id
                ? revision
                : undefined,
            );
          }
          agents.push(
            Object.freeze({
              id: agent.id,
              status: agent.status,
              desiredRuntimeState: agent.desiredRuntimeState,
              executionMode: agent.executionMode,
              ...(agent.activeRevisionId === undefined
                ? {}
                : { activeRevisionId: agent.activeRevisionId }),
              deploymentInProgress,
            }),
          );
        }
        namespaces.push(
          Object.freeze({
            id: namespace.id,
            status: namespace.status,
            agents: Object.freeze(agents),
          }),
        );
      }
      return {
        inventory: Object.freeze({
          installationId: this.installation.id,
          namespaces: Object.freeze(namespaces),
        }),
        revisions,
      };
    });
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
    const namespace = await this.admitIAMPolicyOperation(principalId, namespaceId);
    const driver = this.iamPolicyDriver("listNamespaceRoles");
    return this.read((state) =>
      this.iamPolicyOperation(() =>
        driver.listNamespaceRoles!({ policy: state.iamPolicy }, namespace.id),
      ),
    );
  }

  async createIAMRole(principalId: string, input: CreateIAMRoleInput): Promise<Readonly<Role>> {
    const permissions = this.iamRolePermissions(input.permissions);
    if (input.name !== undefined && !isName(input.name)) {
      throw new IAMPolicyValidationError("/name", "The IAM Role name is invalid.");
    }
    const namespace = await this.admitIAMPolicyOperation(principalId, input.namespaceId);
    const driver = this.iamPolicyDriver("createNamespaceRole");
    return this.mutate(async (state) => {
      await this.holdIAMPolicyAuthority(state, principalId, namespace.id);
      return this.iamPolicyOperation(() =>
        driver.createNamespaceRole!(
          { policy: state.iamPolicy },
          {
            id: `role_${crypto.randomUUID()}`,
            namespaceId: namespace.id,
            ...(input.name === undefined ? {} : { name: input.name }),
            permissions,
          },
        ),
      );
    });
  }

  async getIAMRole(
    principalId: string,
    namespaceId: string,
    roleId: string,
  ): Promise<Readonly<Role>> {
    if (!isNonEmptyString(roleId)) {
      throw new ScopeViolationError("The exact IAM Role identity is missing.");
    }
    const namespace = await this.admitIAMPolicyOperation(principalId, namespaceId);
    const driver = this.iamPolicyDriver("getNamespaceRole");
    const role = await this.read((state) =>
      this.iamPolicyOperation(() =>
        driver.getNamespaceRole!({ policy: state.iamPolicy }, namespace.id, roleId),
      ),
    );
    if (role === undefined) {
      throw new ScopeViolationError("The IAM Role does not belong to the exact Namespace.");
    }
    return role;
  }

  // Returns the removed Role so the caller can audit what was deleted.
  async deleteIAMRole(
    principalId: string,
    namespaceId: string,
    roleId: string,
  ): Promise<Readonly<Role>> {
    if (!isNonEmptyString(roleId)) {
      throw new ScopeViolationError("The exact IAM Role identity is missing.");
    }
    const namespace = await this.admitIAMPolicyOperation(principalId, namespaceId);
    const reader = this.iamPolicyDriver("getNamespaceRole");
    const driver = this.iamPolicyDriver("deleteNamespaceRole");
    const deleted = await this.mutate(async (state) => {
      await this.holdIAMPolicyAuthority(state, principalId, namespace.id);
      return this.iamPolicyOperation(async () => {
        const role = await reader.getNamespaceRole!(
          { policy: state.iamPolicy },
          namespace.id,
          roleId,
        );
        if (
          role === undefined ||
          !(await driver.deleteNamespaceRole!({ policy: state.iamPolicy }, namespace.id, roleId))
        ) {
          return undefined;
        }
        return role;
      });
    });
    if (deleted === undefined) {
      throw new ScopeViolationError("The IAM Role does not belong to the exact Namespace.");
    }
    return deleted;
  }

  async listIAMAccessBindings(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<AccessBinding>[]> {
    const namespace = await this.admitIAMPolicyOperation(principalId, namespaceId);
    const driver = this.iamPolicyDriver("listNamespaceAccessBindings");
    return this.read((state) =>
      this.iamPolicyOperation(() =>
        driver.listNamespaceAccessBindings!({ policy: state.iamPolicy }, namespace.id),
      ),
    );
  }

  /**
   * Configured Group IDs that each account created through the API joins: none when the
   * selected IAM Driver does not hold configured policy in this State.
   */
  get defaultUserGroupIds(): readonly string[] {
    const groups = this.iamConfiguration?.defaultUserGroups ?? [];
    if (groups.length === 0 || this.occBindingDriver("applyConfiguredPolicy") === undefined) {
      return Object.freeze([]);
    }
    return Object.freeze(groups.map(configuredGroupId));
  }

  async createIAMAccessBinding(
    principalId: string,
    input: CreateIAMAccessBindingInput,
  ): Promise<Readonly<AccessBinding>> {
    if (input.subjectKind !== "identity" || !isNonEmptyString(input.subjectId)) {
      throw new IAMPolicyValidationError("/subjectId", "The IAM AccessBinding subject is invalid.");
    }
    if (!isNonEmptyString(input.roleId)) {
      throw new IAMPolicyValidationError("/roleId", "The IAM AccessBinding Role is invalid.");
    }
    this.assertNamespacePolicyResourceKind(input.resourceKind);
    if (!isNonEmptyString(input.resourceId)) {
      throw new IAMPolicyValidationError(
        "/resourceId",
        "The IAM AccessBinding resource is invalid.",
      );
    }
    const namespace = await this.admitIAMPolicyOperation(principalId, input.namespaceId);
    await this.authorize(principalId, "read", {
      kind: input.resourceKind,
      id: input.resourceId,
      namespaceId: namespace.id,
    });
    await this.verifyNamespacePolicyResource(namespace.id, input.resourceKind, input.resourceId);
    const driver = this.iamPolicyDriver("createNamespaceAccessBinding");
    const roles = this.iamPolicyDriver("getNamespaceRole");
    return this.mutate(async (state) => {
      await this.holdIAMPolicyAuthority(state, principalId, namespace.id, {
        kind: input.resourceKind,
        id: input.resourceId,
        namespaceId: namespace.id,
      });
      const role = await this.iamPolicyOperation(() =>
        roles.getNamespaceRole!({ policy: state.iamPolicy }, namespace.id, input.roleId),
      );
      if (role !== undefined) {
        assertAccessBindingRoleApplies(role, input.resourceKind);
      }
      return this.iamPolicyOperation(() =>
        driver.createNamespaceAccessBinding!(
          { policy: state.iamPolicy },
          {
            id: `binding_${crypto.randomUUID()}`,
            namespaceId: namespace.id,
            subjectKind: "identity",
            subjectId: input.subjectId,
            roleId: input.roleId,
            resourceKind: input.resourceKind as ManagedIAMResourceKind,
            resourceId: input.resourceId,
          },
        ),
      );
    });
  }

  async getIAMAccessBinding(
    principalId: string,
    namespaceId: string,
    bindingId: string,
  ): Promise<Readonly<AccessBinding>> {
    if (!isNonEmptyString(bindingId)) {
      throw new ScopeViolationError("The exact IAM AccessBinding identity is missing.");
    }
    const namespace = await this.admitIAMPolicyOperation(principalId, namespaceId);
    const driver = this.iamPolicyDriver("getNamespaceAccessBinding");
    const binding = await this.read((state) =>
      this.iamPolicyOperation(() =>
        driver.getNamespaceAccessBinding!({ policy: state.iamPolicy }, namespace.id, bindingId),
      ),
    );
    if (binding === undefined) {
      throw new ScopeViolationError(
        "The IAM AccessBinding does not belong to the exact Namespace.",
      );
    }
    return binding;
  }

  // Returns the removed AccessBinding so the caller can audit who lost access.
  async deleteIAMAccessBinding(
    principalId: string,
    namespaceId: string,
    bindingId: string,
  ): Promise<Readonly<AccessBinding>> {
    if (!isNonEmptyString(bindingId)) {
      throw new ScopeViolationError("The exact IAM AccessBinding identity is missing.");
    }
    const namespace = await this.admitIAMPolicyOperation(principalId, namespaceId);
    const reader = this.iamPolicyDriver("getNamespaceAccessBinding");
    const driver = this.iamPolicyDriver("deleteNamespaceAccessBinding");
    const deleted = await this.mutate(async (state) => {
      await this.holdIAMPolicyAuthority(state, principalId, namespace.id);
      return this.iamPolicyOperation(async () => {
        const binding = await reader.getNamespaceAccessBinding!(
          { policy: state.iamPolicy },
          namespace.id,
          bindingId,
        );
        if (
          binding === undefined ||
          !(await driver.deleteNamespaceAccessBinding!(
            { policy: state.iamPolicy },
            namespace.id,
            bindingId,
          ))
        ) {
          return undefined;
        }
        return binding;
      });
    });
    if (deleted === undefined) {
      throw new ScopeViolationError(
        "The IAM AccessBinding does not belong to the exact Namespace.",
      );
    }
    return deleted;
  }

  async listIAMServicePrincipals(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<ServicePrincipal>[]> {
    const namespace = await this.admitIAMPolicyOperation(principalId, namespaceId);
    const driver = this.iamPolicyDriver("listNamespaceServicePrincipals");
    return this.read((state) =>
      this.iamPolicyOperation(() =>
        driver.listNamespaceServicePrincipals!({ policy: state.iamPolicy }, namespace.id),
      ),
    );
  }

  async getIAMServicePrincipal(
    principalId: string,
    namespaceId: string,
    servicePrincipalId: string,
  ): Promise<Readonly<ServicePrincipal>> {
    if (!isNonEmptyString(servicePrincipalId)) {
      throw new ScopeViolationError("The exact ServicePrincipal identity is missing.");
    }
    const namespace = await this.admitIAMPolicyOperation(principalId, namespaceId);
    const driver = this.iamPolicyDriver("getNamespaceServicePrincipal");
    const found = await this.read((state) =>
      this.iamPolicyOperation(() =>
        driver.getNamespaceServicePrincipal!(
          { policy: state.iamPolicy },
          namespace.id,
          servicePrincipalId,
        ),
      ),
    );
    if (found === undefined) {
      throw new ScopeViolationError("The ServicePrincipal does not belong to the exact Namespace.");
    }
    return found;
  }

  /**
   * Creates a non-Agent ServicePrincipal fixed to one Namespace. It holds no grant until an
   * AccessBinding names it, and its keys are issued through the service-key route.
   */
  async createIAMServicePrincipal(
    principalId: string,
    namespaceId: string,
  ): Promise<Readonly<ServicePrincipal>> {
    const namespace = await this.admitIAMPolicyOperation(principalId, namespaceId);
    const driver = this.iamPolicyDriver("createNamespaceServicePrincipal");
    return this.mutate(async (state) => {
      await this.holdIAMPolicyAuthority(state, principalId, namespace.id);
      return this.iamPolicyOperation(() =>
        driver.createNamespaceServicePrincipal!(
          { policy: state.iamPolicy },
          { id: `spn_${crypto.randomUUID()}`, namespaceId: namespace.id },
        ),
      );
    });
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
    const agent = await this.getAgent(principalId, namespaceId, agentId);
    if (!agent.activeRevisionId) {
      return { status: "undeployed" as const, images: [] };
    }
    const { revision } = await this.getReadableActiveAgentRevision(
      principalId,
      namespaceId,
      agentId,
    );
    const driver = this.selectedDriver("compute");
    if (
      driver.id !== revision.compute.id ||
      driver.implementation !== revision.compute.implementation
    ) {
      throw new DependencyUnavailableError("The active revision's Compute Driver is unavailable.");
    }
    if (!driver.getRuntimeImages) {
      return { status: "unsupported" as const, images: [] };
    }
    // Driver I/O runs outside the state read transaction and after exact Agent authorization.
    try {
      const images = await driver.getRuntimeImages(revision);
      return { status: "observed" as const, images };
    } catch {
      throw new DependencyUnavailableError("Runtime image metadata is unavailable.");
    }
  }

  /**
   * The Sandbox Driver's record of the running Agent's active dedicated Harness Sandbox, read
   * on request with Agent `read`, as runtime images are. A lost Sandbox is not recovered
   * (finding 2152), so this is what tells a reader that the Agent needs a new deployment.
   * Observation never fails the read: a record OCC cannot read is `unknown`, never `lost`.
   */
  async getAgentHarnessStatus(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<Readonly<AgentHarnessStatusRead>> {
    const agent = await this.getAgent(principalId, namespaceId, agentId);
    const unobserved = Object.freeze({ status: "unobserved" as const });
    const revisionId = agent.activeRevisionId;
    // Only a running Agent's active revision is expected to have a serving Sandbox.
    if (
      agent.status !== "active" ||
      agent.desiredRuntimeState !== "running" ||
      !isNonEmptyString(revisionId)
    ) {
      return unobserved;
    }
    const unknown = Object.freeze({
      status: "observed" as const,
      revisionId,
      harness: Object.freeze({ state: "unknown" as const, code: "UNAVAILABLE" as const }),
    });
    const binding = await this.read(async (state) => {
      const namespace = await this.exactNamespace(state, namespaceId);
      const revision = await state.revisions.findRevision(namespace.id, agent.id, revisionId);
      return revision === undefined ? undefined : { namespace, agent, revision };
    });
    if (binding === undefined) {
      return unknown;
    }
    if (
      binding.revision.harness.mode !== "dedicated" ||
      binding.revision.sandboxDriverId === undefined
    ) {
      return unobserved;
    }
    let compute: ComputeDriver;
    try {
      compute = this.selectedDriver("compute");
    } catch {
      return unknown;
    }
    if (
      compute.id !== binding.revision.compute.id ||
      compute.implementation !== binding.revision.compute.implementation
    ) {
      return unknown;
    }
    const harness = await this.observedHarness(
      compute,
      binding,
      AbortSignal.timeout(HARNESS_OBSERVATION_TIMEOUT_MS),
    );
    return harness === undefined
      ? unobserved
      : Object.freeze({ status: "observed" as const, revisionId, harness });
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
    this.harnessAuthOperations.assertCredentialGatewayDelivery(harnessAuth);
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
      this.harnessAuthOperations.requireSavedHarnessAuth(
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

  async processAgentProvisioning(
    claim: ClaimedWork,
    resolveHarness: HarnessResolver,
    options: AgentProvisioningWorkerOptions = {},
  ): Promise<Readonly<AgentProvisioningWorkerOutcome>> {
    if (!isNonEmptyString(claim.idempotencyKey) || !isNonEmptyString(claim.claimToken)) {
      throw new ScopeViolationError("Agent provisioning requires an exact claimed work item.");
    }
    if (typeof resolveHarness !== "function") {
      throw new DependencyUnavailableError("The selected Harness descriptor is unavailable.");
    }
    const runEffect =
      options.runEffect ??
      (<T>(operation: (signal: AbortSignal) => Promise<T>) =>
        operation(new AbortController().signal));
    let record = await this.read((state) => state.provisioning.findByWorkId(claim.idempotencyKey));
    if (record === undefined) {
      return Object.freeze({ outcome: "permanent" as const, code: "PROVISIONING_WORK_NOT_FOUND" });
    }
    if (record.status === "succeeded" && record.revisionId !== undefined) {
      return Object.freeze({ outcome: "succeeded" as const, revisionId: record.revisionId });
    }
    if (record.status === "cancelled") {
      return Object.freeze({ outcome: "permanent" as const, code: "PROVISIONING_CANCELLED" });
    }
    if (record.status === "failed") {
      return Object.freeze({ outcome: "permanent" as const, code: "PROVISIONING_FAILED" });
    }
    try {
      if (record.revisionId !== undefined) {
        return await this.observeProvisioningDeployment(claim, record);
      }
      // Inspect an external write that an earlier attempt left unsettled before this attempt's
      // first fence, so a permanent refusal fails the work instead of retrying it as an unknown
      // outcome (finding 815). reconcileProvisioningEffect says why that order is safe.
      record = await this.reconcileProvisioningEffect(record, runEffect);
      record = await this.checkpointAgentProvisioning(claim, {
        completedPhase: record.completedPhase,
        status: "running",
      });
      if (await this.deleteMarkedProvisioningConfiguration(record, runEffect)) {
        record = await this.checkpointAgentProvisioning(claim, {
          completedPhase: record.completedPhase,
          status: "running",
          progress: withoutUnrecordedProvisioningConfiguration(record.progress),
        });
      }
      if (this.provisioningBefore(record, "configuration")) {
        record = await this.processAgentProvisioningConfiguration(claim, record, runEffect);
      }
      if (this.provisioningBefore(record, "transport")) {
        if (record.agentId === undefined) {
          throw new ScopeViolationError("The Agent provisioning record has no Agent.");
        }
        const effect = { kind: "transport" as const, targetId: record.agentId };
        let pendingTransport = record;
        if (this.provisioningEffectReceipt(pendingTransport, effect) === undefined) {
          const { namespace, agent, driver } = await this.admitAgentRuntimeCredentialProvisioning(
            record.actorId,
            record.namespaceId,
            record.agentId,
          );
          if (this.provisioningPendingEffectMatches(pendingTransport, effect)) {
            pendingTransport = await this.inspectProvisioningTransportEffect(
              claim.idempotencyKey,
              pendingTransport,
              effect,
              namespace,
              agent,
              driver,
              runEffect,
            );
          } else {
            pendingTransport = await this.beginProvisioningEffect(claim, effect);
            await runEffect(async () => {
              const transportResult = await this.runtimeCredentialOperation(() =>
                driver.provisionAgentRuntimeCredentials!({ namespace, agent }, {}),
              );
              pendingTransport = await this.settleProvisioningEffect(
                claim.idempotencyKey,
                pendingTransport,
                effect,
              );
              return transportResult;
            });
          }
        }
        record = await this.checkpointAgentProvisioning(claim, {
          completedPhase: "transport",
          status: "running",
          progress: {},
        });
      }
      const revision = await this.mutate(async (state) => {
        const current = await state.provisioning.findByWorkId(claim.idempotencyKey);
        if (
          current === undefined ||
          current.status === "cancelled" ||
          current.status === "failed" ||
          current.agentId === undefined
        ) {
          throw new ResourceStateConflictError(
            "The Agent provisioning lifecycle changed before handoff.",
          );
        }
        await this.fenceAgentProvisioning(state, claim);
        const revision = await this.provisioningContext.run(claim, () =>
          this.deployAgent(
            current.actorId,
            { namespaceId: current.namespaceId, agentId: current.agentId! },
            resolveHarness,
          ),
        );
        await this.commitProvisioningCheckpoint(state, claim, {
          completedPhase: "handoff",
          status: "running",
          revisionId: revision.id,
        });
        return revision;
      });
      return await this.observeProvisioningDeployment(claim, {
        ...record,
        completedPhase: "handoff",
        revisionId: revision.id,
      });
    } catch (error) {
      if (
        error instanceof WorkClaimLostError ||
        error instanceof AuditAppendUnavailableError ||
        error instanceof PostgresCommitOutcomeUnknownError
      ) {
        throw error;
      }
      const observed = await this.read((state) =>
        state.provisioning.findByWorkId(claim.idempotencyKey),
      );
      if (observed?.status === "succeeded" && observed.revisionId !== undefined) {
        return Object.freeze({ outcome: "succeeded" as const, revisionId: observed.revisionId });
      }
      if (observed?.status === "cancelled") {
        return Object.freeze({ outcome: "permanent" as const, code: "PROVISIONING_CANCELLED" });
      }
      let code = "PROVISIONING_DEPENDENCY_UNAVAILABLE";
      if (
        observed?.progress.pendingEffect !== undefined &&
        readProvisioningEffectReceipt(observed) === undefined
      ) {
        code = "PROVISIONING_OUTCOME_UNKNOWN";
      } else if (
        // A Secret stored through a Secret Driver the Installation no longer selects is
        // refused the same way on every attempt, as request, status and retry answer it
        // with a fixed 503. A missing or unusable driver stays a retryable outage.
        error instanceof SecretDriverOwnershipError ||
        (!(error instanceof DependencyUnavailableError) &&
          (error instanceof ScopeViolationError ||
            error instanceof ResourceConflictError ||
            error instanceof AuthorizationDeniedError ||
            error instanceof AgentDeletingError ||
            error instanceof NamespaceNotReadyError ||
            // An Installation change (Plugin Driver, runtime image) refuses the stored plan
            // the same way on every attempt, as HTTP retry does with a 400. A Compute plan
            // refusal arrives as a ResourceConflictError (409) and is rejected the same way.
            error instanceof PluginPolicyValidationError ||
            error instanceof NativeWorkerSupportError ||
            // Deployment refuses a model provider setting a rule tightened after the request
            // was queued; every attempt would (finding 1549).
            error instanceof ModelProviderSettingError))
      ) {
        code = "PROVISIONING_REJECTED";
      }
      const deferMs =
        error instanceof ProvisioningConfigurationSettlingError ? error.retryAfterMs : undefined;
      const disposition =
        deferMs !== undefined && code === "PROVISIONING_OUTCOME_UNKNOWN"
          ? "defer"
          : code === "PROVISIONING_DEPENDENCY_UNAVAILABLE" ||
              code === "PROVISIONING_OUTCOME_UNKNOWN"
            ? "retry"
            : "permanent";
      const authorizationDenied =
        error instanceof AuthorizationDeniedError && !(error instanceof DependencyUnavailableError);
      const message = provisioningFailureMessage(code, error);
      // A refusal deletes the Configuration it wrote but never recorded. The job first forgets
      // the write and marks it for deletion, under its claim, so neither a retry nor a crash can
      // trust a receipt for a deleted document; the refusal then drops the mark only once the
      // delete has succeeded. A delete that fails, or never runs, leaves the mark: the next
      // attempt deletes it before writing another, and a refusal deletes it too (finding 1399).
      const unrecorded =
        disposition === "permanent"
          ? await this.mutate(async (state) => {
              const current = await state.provisioning.findByWorkId(claim.idempotencyKey);
              if (current === undefined) {
                throw new WorkClaimLostError();
              }
              const written = await this.unrecordedProvisioningConfiguration(state, current);
              if (written === undefined) {
                return this.markedProvisioningConfiguration(state, current);
              }
              await this.commitProvisioningCheckpoint(state, claim, {
                completedPhase: current.completedPhase,
                status: "running",
                progress: withUnrecordedProvisioningConfiguration(current.progress, written.id),
              });
              return this.provisioningConfiguration(current, written.id);
            })
          : undefined;
      const orphanedConfigurationId =
        unrecorded === undefined
          ? undefined
          : await this.deleteUnrecordedProvisioningConfiguration(unrecorded);
      await this.mutate(async (state) => {
        const current = await state.provisioning.findByWorkId(claim.idempotencyKey);
        if (current === undefined) {
          throw new WorkClaimLostError();
        }
        record = await state.provisioning.recordFailure(
          claim,
          {
            completedPhase: current.completedPhase,
            progress: {
              ...(unrecorded !== undefined && orphanedConfigurationId === undefined
                ? withoutUnrecordedProvisioningConfiguration(current.progress)
                : current.progress),
              error: { code, message },
            },
          },
          disposition === "defer"
            ? { disposition, code, message, delayMs: deferMs! }
            : { disposition, code, message },
        );
        await state.audit.append({
          id: `aud_${crypto.randomUUID()}`,
          installationId: this.installation.id,
          namespaceId: current.namespaceId,
          occurredAt: this.timestamp(),
          kind: authorizationDenied ? "authorization_denial" : "mutation",
          actorId: current.actorId,
          source: "occ",
          action: "openclaw.agents.provision.failure",
          resource: {
            kind: "agent",
            namespaceId: current.namespaceId,
            id: current.agentId ?? current.workId,
          },
          outcome: authorizationDenied ? "denied" : "failure",
          ...(authorizationDenied
            ? {
                reasonCode: "AUTHORIZATION_DENIED",
                ...(error.authorization === undefined
                  ? {}
                  : { authorization: { principalId: current.actorId, ...error.authorization } }),
              }
            : {}),
          details: { workId: current.workId, phase: current.completedPhase, code },
        });
      });
      return Object.freeze({
        outcome: disposition === "defer" ? ("pending" as const) : disposition,
        code,
        ...(error instanceof ComputeProvisioningRefusedError ? { reason: error.reason } : {}),
        ...(orphanedConfigurationId === undefined ? {} : { orphanedConfigurationId }),
      });
    }
  }

  async diagnoseAgentDeployment(
    principalId: string,
    namespaceId: string,
    agentId: string,
    deploymentId: string,
  ): Promise<Readonly<AgentDeploymentDiagnostics>> {
    const revision = await this.getRevision(principalId, namespaceId, agentId, deploymentId);
    await this.authorize(principalId, "operate", {
      kind: "agent",
      id: agentId,
      namespaceId,
    });
    await this.authorize(principalId, "read", {
      kind: "agent",
      id: agentId,
      namespaceId,
    });
    const binding = await this.read(async (state) => {
      const { namespace, agent } = await this.exactAgent(state, namespaceId, agentId);
      return { namespace, agent, revision };
    });
    const driver = this.diagnosticsComputeDriver();
    if (
      driver.id !== revision.compute.id ||
      driver.implementation !== revision.compute.implementation
    ) {
      throw new DependencyUnavailableError("The deployment's Compute Driver is unavailable.");
    }
    // Runs beside Compute's collection; it never throws and stops when Compute fails.
    const observation = new AbortController();
    const harness = this.observedHarness(
      driver,
      binding,
      AbortSignal.any([observation.signal, AbortSignal.timeout(HARNESS_OBSERVATION_TIMEOUT_MS)]),
    );
    let collected: AgentDeploymentDiagnostics;
    try {
      collected = await driver.diagnoseAgentDeployment!(binding);
    } catch (error) {
      observation.abort();
      if (error instanceof RuntimeDiagnosticsTransportError) {
        throw new RuntimeDiagnosticsTransportError();
      }
      // Native Driver failures can contain private runtime or credential details.
      throw new DependencyUnavailableError("Runtime diagnostics are unavailable.");
    }
    let diagnostics: Readonly<AgentDeploymentDiagnostics>;
    try {
      diagnostics = deploymentDiagnostics(collected, revision.id);
    } catch (error) {
      observation.abort();
      throw error;
    }
    const observed = await harness;
    if (observed === undefined) {
      return diagnostics;
    }
    return withHarnessDiagnostic(diagnostics, observed, this.clock().toISOString());
  }

  /**
   * Tier 1: Pod status, restarts, Events and log sources (Agent operate + read).
   * `admitRead` wraps the Driver reads and runs only after authorization, so a caller's
   * rate or concurrency limit never answers before a denial (which is audited).
   */
  async describeAgentRuntime(
    principalId: string,
    namespaceId: string,
    agentId: string,
    deploymentId: string,
    signal?: AbortSignal,
    admitRead: RuntimeLogReadAdmission = (read) => read(),
  ): Promise<Readonly<AgentRuntimeDescription>> {
    const { binding, driver } = await this.runtimeLogTarget(
      principalId,
      namespaceId,
      agentId,
      deploymentId,
      "operate",
    );
    return admitRead(() =>
      runtimeLogOperation(signal, async (deadline) => {
        const [described, harness] = await Promise.all([
          describedAgentRuntime(driver, binding, deadline),
          this.observedHarness(driver, binding, deadline),
        ]);
        const description = withSandboxLogSource(described, () =>
          this.sandboxLogDriver(driver, binding.revision),
        );
        return harness === undefined ? description : Object.freeze({ ...description, harness });
      }),
    );
  }

  /**
   * Tier 2: one bounded, redacted page of container output (Agent `read_logs` or
   * `administer`, plus `read`). `admitView` writes the view audit event before the first
   * Driver log read and names the action that admitted the caller.
   */
  async readAgentRuntimeLogs(
    principalId: string,
    namespaceId: string,
    agentId: string,
    deploymentId: string,
    query: RuntimeLogQuery,
    requested: {
      readonly codec: RuntimeLogCursorCodec;
      readonly admitView: (
        admission: RuntimeLogViewAdmission,
        grant: RuntimeLogReadGrant,
      ) => Promise<void>;
      readonly signal?: AbortSignal;
      /** Wraps the Driver reads once the caller is authorized; see describeAgentRuntime. */
      readonly admitRead?: RuntimeLogReadAdmission;
    },
  ): Promise<Readonly<RuntimeLogPage>> {
    const { binding, driver, grant } = await this.runtimeLogTarget(
      principalId,
      namespaceId,
      agentId,
      deploymentId,
      "logs",
    );
    const admitRead = requested.admitRead ?? ((read) => read());
    return admitRead(() =>
      readDriverRuntimeLogs(principalId, agentId, driver, binding, query, () => ({
        codec: requested.codec,
        ...(requested.signal === undefined ? {} : { signal: requested.signal }),
        admitView: async (admission: RuntimeLogViewAdmission) => {
          try {
            await requested.admitView(admission, grant!);
          } catch {
            throw new RuntimeLogsError("RUNTIME_LOGS_AUDIT_UNAVAILABLE");
          }
        },
        resolveSandboxLogDriver: () => this.sandboxLogDriver(driver, binding.revision),
        clock: () => this.clock(),
      })),
    );
  }

  /**
   * The selected Sandbox Driver, when it provisioned this revision and exposes its log,
   * and Compute can name the placement the Sandbox was provisioned in.
   */
  private sandboxLogDriver(
    compute: ComputeDriver,
    revision: Readonly<AgentRevision>,
  ): SandboxDriver | undefined {
    const sandbox = this.revisionSandboxDriver(compute, revision);
    return typeof sandbox?.readSandboxLogs === "function" ? sandbox : undefined;
  }

  /** The selected Sandbox Driver that provisioned this revision, in a placement Compute names. */
  private revisionSandboxDriver(
    compute: ComputeDriver,
    revision: Readonly<AgentRevision>,
  ): SandboxDriver | undefined {
    if (
      revision.sandboxDriverId === undefined ||
      typeof compute.resolveSandboxNamespace !== "function" ||
      !this.selections.has("sandbox")
    ) {
      return undefined;
    }
    let sandbox: SandboxDriver;
    try {
      sandbox = this.selectedDriver("sandbox");
    } catch {
      return undefined;
    }
    return sandbox.id === revision.sandboxDriverId ? sandbox : undefined;
  }

  /**
   * The dedicated Harness Sandbox as its Sandbox Driver records it, or undefined when the
   * Driver keeps no such record. Never throws: an unreadable record is `unknown`, and Driver
   * error text is not returned.
   */
  private async observedHarness(
    compute: ComputeDriver,
    binding: ComputeAgentRevisionBinding,
    signal: AbortSignal,
  ): Promise<AgentRuntimeHarnessStatus | undefined> {
    const sandbox = this.revisionSandboxDriver(compute, binding.revision);
    if (
      binding.revision.harness.mode !== "dedicated" ||
      typeof sandbox?.observeHarness !== "function"
    ) {
      return undefined;
    }
    const unavailable = Object.freeze({ state: "unknown" as const, code: "UNAVAILABLE" as const });
    let observed: unknown;
    try {
      const namespace = await compute.resolveSandboxNamespace!.call(compute, binding.namespace);
      observed = await sandbox.observeHarness(
        Object.freeze({ namespace, revision: binding.revision, signal }),
      );
    } catch {
      return unavailable;
    }
    const state = asRecord(observed)?.state;
    const code = asRecord(observed)?.code;
    if (state === "starting" && code === "HARNESS_RESTARTING") {
      const exitCode = asRecord(observed)?.exitCode;
      const restarts = asRecord(observed)?.restarts;
      // Only bounded integers are reported; a malformed restart reads as a plain start.
      if (
        typeof exitCode === "number" &&
        Number.isSafeInteger(exitCode) &&
        exitCode >= -2_147_483_648 &&
        exitCode <= 2_147_483_647 &&
        typeof restarts === "number" &&
        Number.isSafeInteger(restarts) &&
        restarts >= 1 &&
        restarts <= 4_294_967_295
      ) {
        return Object.freeze({ state, code, exitCode, restarts });
      }
    }
    if (state === "running" || state === "starting" || state === "unknown") {
      return Object.freeze({ state });
    }
    if (state === "lost" && typeof code === "string" && HARNESS_LOST_CODES.has(code)) {
      // A stopped Agent, a retired revision, or a candidate before its Sandbox exists has
      // no Sandbox by design (or one being removed), so only the running Agent's active
      // revision reports its absence as lost. A stopped, failed or exited Sandbox record
      // is OpenShell's own terminal state and is reported for any revision.
      const expected =
        binding.agent.desiredRuntimeState === "running" &&
        binding.agent.activeRevisionId === binding.revision.id;
      return expected || (code !== "SANDBOX_MISSING" && code !== "SANDBOX_DELETING")
        ? Object.freeze({ state, code: code as SandboxHarnessLostCode })
        : Object.freeze({ state: "unknown" as const });
    }
    return unavailable;
  }

  private async runtimeLogTarget(
    principalId: string,
    namespaceId: string,
    agentId: string,
    deploymentId: string,
    tier: "operate" | "logs",
  ): Promise<{
    binding: ComputeAgentRevisionBinding;
    driver: ComputeDriver;
    grant?: RuntimeLogReadGrant;
  }> {
    const agent: ResourceRef = { kind: "agent", id: agentId, namespaceId };
    let authorizedRevision: Readonly<AgentRevision> | undefined;
    let grant: RuntimeLogReadGrant | undefined;
    if (tier === "operate") {
      authorizedRevision = await this.getRevision(principalId, namespaceId, agentId, deploymentId);
      await this.authorize(principalId, "operate", agent);
    } else {
      if (!isNonEmptyString(namespaceId) || !isNonEmptyString(agentId)) {
        throw new ScopeViolationError("The exact Agent identity is missing.");
      }
      if (!isNonEmptyString(deploymentId)) {
        throw new ScopeViolationError("The exact AgentRevision identity is missing.");
      }
      // Log text is delegated per Agent: `read_logs` (or `administer`) plus `read` on the
      // exact Agent admit every revision of that Agent, so a new deployment does not
      // revoke a log reader. The revision is still resolved within that exact Agent.
      grant = await this.authorizeRuntimeLogRead(principalId, agent);
    }
    await this.authorize(principalId, "read", agent);
    const binding = await this.read(async (state) => {
      const namespace = await this.exactNamespace(state, namespaceId);
      const agent = await state.agents.findAgent(namespace.id, agentId);
      if (!agent) {
        throw new ScopeViolationError(
          "The Agent does not belong to the exact Installation and Namespace.",
        );
      }
      const revision =
        authorizedRevision ??
        (await state.revisions.findRevision(namespace.id, agent.id, deploymentId));
      if (!revision) {
        throw new ScopeViolationError(
          "The AgentRevision does not belong to the exact Agent and Namespace.",
        );
      }
      return { namespace, agent, revision };
    });
    const revision = binding.revision;
    let driver: ComputeDriver;
    try {
      driver = this.selectedDriver("compute");
    } catch {
      throw new RuntimeLogsError("RUNTIME_LOGS_UNAVAILABLE");
    }
    if (
      driver.id !== revision.compute.id ||
      driver.implementation !== revision.compute.implementation
    ) {
      throw new RuntimeLogsError("RUNTIME_LOGS_UNAVAILABLE");
    }
    // The operator owns runtime logging for Drivers that declare it; OCC never reads it.
    if (driver.runtimeLogging === "driver" || typeof driver.describeAgentRuntime !== "function") {
      throw new NotImplementedError(
        "describeAgentRuntime",
        "The selected Compute Driver does not expose runtime status or logs.",
      );
    }
    return { binding, driver, ...(grant === undefined ? {} : { grant }) };
  }

  /**
   * Log text needs the delegable `read_logs` or, as before it existed, `administer`. A
   * Restriction on `read_logs` denies outright; the `administer` path cannot bypass it.
   */
  private async authorizeRuntimeLogRead(
    principalId: string,
    agent: ResourceRef,
  ): Promise<RuntimeLogReadGrant> {
    const delegated = await this.authorizationDecision(principalId, "read_logs", agent);
    if (delegated.decision.allowed) {
      return Object.freeze({ action: "read_logs" });
    }
    if (delegated.decision.evidence.restrictionIds.length === 0) {
      const administer = await this.authorizationDecision(principalId, "administer", agent);
      if (administer.decision.allowed) {
        return Object.freeze({ action: "administer" });
      }
    }
    throw new AuthorizationDeniedError(
      isNonEmptyString(delegated.decision.reason)
        ? delegated.decision.reason
        : "The exact operation was denied.",
      delegated.decision.evidence,
      { action: "read_logs", resource: agent },
      principalId,
    );
  }

  async getServiceAccount(
    principalId: string,
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<Readonly<ServiceAccount>> {
    this.serviceAccountIdentity(namespaceId, serviceAccountId);
    await this.authorize(principalId, "read", {
      kind: "service_account",
      id: serviceAccountId,
      namespaceId,
    });
    return this.read(async (state) => {
      const namespace = await this.exactNamespace(state, namespaceId);
      return this.exactServiceAccount(state, namespace.id, serviceAccountId);
    });
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
    const namespace = await this.getNamespace(principalId, namespaceId);
    return this.read(async (state) =>
      this.readableListRows(
        principalId,
        namespace.id,
        "service_account",
        await state.serviceAccounts.listServiceAccounts(namespace.id),
      ),
    );
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

  private async observeProvisioningDeployment(
    claim: ClaimedWork,
    record: Readonly<AgentProvisioningRecord>,
  ): Promise<Readonly<AgentProvisioningWorkerOutcome>> {
    const revisionId = record.revisionId;
    if (revisionId === undefined) {
      throw new ScopeViolationError("The initial deployment revision is unavailable.");
    }
    return this.mutate(async (state) => {
      const work = await state.operations.findWork(`agent_revision:${revisionId}:reconcile`);
      if (
        work === undefined ||
        work.namespaceId !== record.namespaceId ||
        work.agentId !== record.agentId ||
        work.revisionId !== revisionId
      ) {
        throw new DependencyUnavailableError("The initial deployment work is unavailable.");
      }
      const status = controllerWorkDeploymentStatus(work, this.clock());
      if (status === "succeeded") {
        await this.commitProvisioningCheckpoint(state, claim, {
          completedPhase: "handoff",
          status: "succeeded",
          revisionId,
          progress: {},
        });
        return Object.freeze({ outcome: "succeeded" as const, revisionId });
      }
      const deploymentError = deploymentErrorForWork(work);
      // Stopping the first rollout is the owner's choice, not a fault to correct.
      const error =
        deploymentError?.code === "REVISION_STOPPED"
          ? Object.freeze({
              code: "REVISION_STOPPED",
              message: "The Agent was stopped before its first deployment finished.",
            })
          : deploymentError;
      const pending = status !== "failed";
      const code = pending
        ? PROVISIONING_DEPLOYMENT_PENDING
        : (error?.code ?? "PROVISIONING_DEPLOYMENT_FAILED");
      const message = pending
        ? "Waiting for the initial deployment to complete."
        : (error?.message ?? "The initial deployment failed.");
      await state.provisioning.recordFailure(
        claim,
        {
          completedPhase: "handoff",
          revisionId,
          progress: { ...record.progress, ...(error === null ? {} : { error }) },
        },
        pending
          ? { disposition: "defer", code, message, delayMs: 1000 }
          : { disposition: "permanent", code, message },
      );
      if (!pending) {
        await state.audit.append({
          id: `aud_${crypto.randomUUID()}`,
          installationId: this.installation.id,
          namespaceId: record.namespaceId,
          occurredAt: this.timestamp(),
          kind: "mutation",
          actorId: record.actorId,
          source: "occ",
          action: "openclaw.agents.provision.failure",
          resource: { kind: "agent", namespaceId: record.namespaceId, id: record.agentId! },
          outcome: "failure",
          details: { workId: record.workId, phase: "handoff", revisionId, code },
        });
      }
      return Object.freeze({
        outcome: pending ? ("pending" as const) : ("permanent" as const),
        code,
      });
    });
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

  /**
   * The IAM Driver that writes configured policy, Owner bindings, and deploy-time grants, or
   * undefined when it has no such member or
   * this controller's State is not where its policy lives: decisions from the `authorize`
   * option, or a Native IAM Driver that reads another store. Only the Driver's own policy
   * source can hold bindings it will read.
   */
  private occBindingDriver(
    method: "createOwnerBinding" | "applyConfiguredPolicy" | "createNamespaceAccessBinding",
  ): IAMDriver | undefined {
    if (this.authorization !== undefined) {
      return undefined;
    }
    const driver = this.selectedDriver("iam");
    if (
      driver[method] === undefined ||
      (driver instanceof NativeIAMDriver &&
        !NativeIAMDriver.usesStateForAuthorization(driver, driver.authorize, this.state))
    ) {
      return undefined;
    }
    if (driver.namespacePolicyTransaction !== "platform-unit-of-work") {
      throw new DependencyUnavailableError(
        "Configured IAM policy requires transactional IAM Driver support.",
      );
    }
    return driver;
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

  /**
   * The creator of a resource gets the configured Owner Role on it, in the creating unit
   * (RFC-0026): Namespace-wide for a Namespace, exact for anything else. Without `ownerRole`,
   * OCC writes no Owner binding.
   */
  private async bindCreator(
    state: PlatformUnitOfWork,
    principalId: string,
    resource: ResourceRef & { readonly namespaceId: string },
  ): Promise<void> {
    const ownerRole = this.iamConfiguration?.ownerRole;
    if (ownerRole === undefined) {
      return;
    }
    const driver = this.occBindingDriver("createOwnerBinding");
    if (driver === undefined) {
      return;
    }
    const binding = await this.iamPolicyOperation(() =>
      driver.createOwnerBinding!(
        { policy: state.iamPolicy },
        {
          id: `binding_owner_${resource.id}`,
          namespaceId: resource.namespaceId,
          principalId,
          roleId: configuredRoleId(ownerRole),
          ...(resource.kind === "namespace"
            ? {}
            : { resourceKind: resource.kind, resourceId: resource.id }),
        },
      ),
    );
    await this.auditBinding(state, principalId, binding, resource, { reason: "creator" });
  }

  /**
   * The configured policy that OCC writes: each Role and Group with its configured ID, and each
   * Group binding in its scope. A binding that names a Namespace is written for each of
   * `namespaces` with that name.
   */
  private configuredPolicy(namespaces: readonly Readonly<Namespace>[]): IAMConfiguredPolicy {
    const configuration = this.iamConfiguration;
    if (configuration === undefined) {
      return Object.freeze({ roles: [], groups: [], bindings: [] });
    }
    const groupNames = new Set([
      ...configuration.defaultUserGroups,
      ...configuration.roleBindings.map((binding) => binding.group),
    ]);
    const bindings: AccessBinding[] = [];
    for (const { group, role, scope } of configuration.roleBindings) {
      const namespaceIds =
        scope === "installation"
          ? [undefined]
          : namespaces
              .filter((namespace) => namespace.name === scope.namespace)
              .map((namespace) => namespace.id);
      for (const namespaceId of namespaceIds) {
        bindings.push({
          id: configuredBindingId(group, role, namespaceId),
          ...(namespaceId === undefined ? {} : { namespaceId }),
          subjectKind: "group",
          subjectId: configuredGroupId(group),
          roleId: configuredRoleId(role),
        });
      }
    }
    return Object.freeze({
      roles: configuration.roles.map((role) => ({
        id: configuredRoleId(role.id),
        name: role.id,
        permissions: role.permissions,
      })),
      groups: [...groupNames].map((name) => ({ id: configuredGroupId(name), name })),
      bindings,
    });
  }

  /**
   * Writes the configured Group bindings that name a Namespace OCC just created, in the unit that
   * creates it. The creator's authority fence holds the IAM configuration lock shared.
   */
  private async applyConfiguredPolicy(
    state: PlatformUnitOfWork,
    actorId: string,
    namespace: Readonly<Namespace>,
  ): Promise<void> {
    const driver = this.occBindingDriver("applyConfiguredPolicy");
    if (driver === undefined || this.iamConfiguration === undefined) {
      return;
    }
    const changes = await this.iamPolicyOperation(() =>
      driver.applyConfiguredPolicy!(
        { policy: state.iamPolicy },
        { policy: this.configuredPolicy([namespace]), namespaceId: namespace.id },
      ),
    );
    await this.auditConfiguredPolicy(state, actorId, changes, "namespace_create");
  }

  /** Audits each change that applying the configured policy made. */
  private async auditConfiguredPolicy(
    state: PlatformUnitOfWork,
    actorId: string,
    changes: IAMConfiguredPolicyChanges,
    reason: "installation_configuration" | "namespace_create",
  ): Promise<void> {
    const installation: ResourceRef = { kind: "installation", id: this.installation.id };
    const bindingResource = (binding: Readonly<AccessBinding>): ResourceRef =>
      binding.namespaceId === undefined
        ? installation
        : { kind: "namespace", id: binding.namespaceId, namespaceId: binding.namespaceId };
    for (const binding of changes.bindings.deleted) {
      await this.auditBinding(state, actorId, binding, bindingResource(binding), {
        reason,
        deleted: true,
      });
    }
    for (const binding of changes.bindings.created) {
      await this.auditBinding(state, actorId, binding, bindingResource(binding), { reason });
    }
    const policyChanges: [string, Record<string, unknown>][] = [
      ...changes.roles.created.map((role): [string, Record<string, unknown>] => [
        "openclaw.iam.roles.create",
        { roleId: role.id, permissions: role.permissions },
      ]),
      ...changes.roles.updated.map((role): [string, Record<string, unknown>] => [
        "openclaw.iam.roles.update",
        { roleId: role.id, permissions: role.permissions },
      ]),
      ...changes.roles.deleted.map((roleId): [string, Record<string, unknown>] => [
        "openclaw.iam.roles.delete",
        { roleId },
      ]),
      ...changes.groups.created.map((groupId): [string, Record<string, unknown>] => [
        "openclaw.iam.groups.create",
        { groupId },
      ]),
      ...changes.groups.deleted.map((groupId): [string, Record<string, unknown>] => [
        "openclaw.iam.groups.delete",
        { groupId },
      ]),
    ];
    for (const [action, details] of policyChanges) {
      await state.audit.append({
        id: `aud_${crypto.randomUUID()}`,
        installationId: this.installation.id,
        occurredAt: this.timestamp(),
        kind: "mutation",
        actorId,
        source: "occ",
        action,
        resource: installation,
        outcome: "success",
        details: { ...details, reason },
      });
    }
  }

  private async auditBinding(
    state: PlatformUnitOfWork,
    actorId: string,
    binding: Readonly<AccessBinding>,
    resource: ResourceRef,
    details: { readonly reason: string; readonly deleted?: boolean },
  ): Promise<void> {
    await state.audit.append({
      id: `aud_${crypto.randomUUID()}`,
      installationId: this.installation.id,
      ...(resource.namespaceId === undefined ? {} : { namespaceId: resource.namespaceId }),
      occurredAt: this.timestamp(),
      kind: "mutation",
      actorId,
      source: "occ",
      action:
        details.deleted === true
          ? "openclaw.iam.access_bindings.delete"
          : "openclaw.iam.access_bindings.create",
      resource,
      outcome: "success",
      details: {
        bindingId: binding.id,
        subjectKind: binding.subjectKind,
        subjectId: binding.subjectId,
        roleId: binding.roleId,
        reason: details.reason,
      },
    });
  }

  /**
   * Makes the configured Roles, Groups, and Group bindings in IAM policy match the `iam`
   * configuration. The composition calls it at startup, and Installation bootstrap calls it once
   * the Installation exists. It holds the IAM configuration lock exclusively, so a write of
   * durable authority commits wholly before or after it. Owner bindings, deploy-time grants, and
   * Group memberships stay when the configuration changes.
   */
  async applyIAMConfiguration(): Promise<void> {
    const driver = this.occBindingDriver("applyConfiguredPolicy");
    if (driver === undefined) {
      return;
    }
    await this.mutate(async (state) => {
      await state.installations.holdIAMConfiguration("exclusive");
      const namespaces = await state.namespaces.listNamespaces();
      const available = namespaces.filter(
        (namespace) => namespace.status === "provisioning" || namespace.status === "ready",
      );
      const desired = this.configuredPolicy(available);
      // A Namespace that cannot take new policy now, such as a failed one, keeps the configured
      // bindings it has that the configuration still lists; Namespace deletion removes them with
      // the rest of its policy.
      const listed = new Set(this.configuredPolicy(namespaces).bindings.map(({ id }) => id));
      const availableIds = new Set(available.map((namespace) => namespace.id));
      const kept = (await state.iamPolicy.listConfiguredPolicy()).bindings.filter(
        (binding) =>
          binding.namespaceId !== undefined &&
          !availableIds.has(binding.namespaceId) &&
          listed.has(binding.id),
      );
      const policy: IAMConfiguredPolicy = {
        ...desired,
        bindings: [...desired.bindings, ...kept],
      };
      const changes = await this.iamPolicyOperation(() =>
        driver.applyConfiguredPolicy!({ policy: state.iamPolicy }, { policy }),
      );
      await this.auditConfiguredPolicy(
        state,
        this.installation.id,
        changes,
        "installation_configuration",
      );
    });
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
    if (configurationId === undefined) {
      this.namespaceIdentity(namespaceId);
    } else {
      this.configurationIdentity(namespaceId, configurationId);
    }
    await this.authorize(principalId, configurationId === undefined ? "create" : "update", {
      kind: "configuration",
      id: configurationId ?? namespaceId,
      namespaceId,
    });
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
    validateModelProviderSettings(values, options);
    validateConfigurationSettings(values, options);
    requireDeployableRoster(values, options, agent);
    this.validateComputeConfiguration(values, options);
    if (secretBindings !== undefined) {
      this.requireBundledChannelBindings(values, secretBindings);
    }
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
    const implementation = this.selections.get("compute")?.driver.implementation;
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
    const compute = this.selections.get("compute")?.driver as ComputeDriver | undefined;
    compute?.validateConfiguration?.(values, options);
  }

  async createSecret(
    principalId: string,
    input: CreateSecretInput,
  ): Promise<Readonly<SecretMetadata>> {
    this.validateSecretValue(input.value);
    if (!isName(input.name)) {
      throw new ScopeViolationError("The Secret name is invalid.");
    }
    this.namespaceIdentity(input.namespaceId);
    return this.mutate(async (state) => {
      await this.holdAuthority(state);
      const target: ResourceRef = {
        kind: "secret",
        id: input.namespaceId,
        namespaceId: input.namespaceId,
      };
      await this.authorize(principalId, "create", target);
      const namespace = await this.lockNamespace(state, input.namespaceId);
      // AccessBinding deletes hold this lock: authorize again so a revocation that committed
      // while this write waited stops it before it leaves a durable Owner binding or grant.
      await this.authorize(principalId, "create", target);
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      const driver = this.secretDriver();
      const identity = {
        id: this.nextIdentifier("secret"),
        namespaceId: namespace.id,
        name: input.name,
      };
      const backendRef = await this.secretOperation(() => driver.create(identity, input.value));
      const secret: Secret = {
        ...identity,
        driverId: driver.id,
        backendRef,
        createdAt: this.timestamp(),
      };
      // Compensate only a known failed OCC transaction, never an unknown COMMIT outcome.
      this.registerRollback(() => this.secretOperation(() => driver.delete(secret)));
      await state.secrets.createSecret(secret);
      await this.bindCreator(state, principalId, {
        kind: "secret",
        id: secret.id,
        namespaceId: namespace.id,
      });
      return this.secretMetadata(secret);
    });
  }

  async readSecret(
    principalId: string,
    namespaceId: string,
    secretId: string,
  ): Promise<Readonly<SecretDetail>> {
    await this.authorize(principalId, "read", { kind: "secret", id: secretId, namespaceId });
    return this.read(async (state) => {
      await this.exactNamespace(state, namespaceId);
      const secret = await state.secrets.findSecret(namespaceId, secretId);
      if (!secret) {
        throw new ScopeViolationError("The Secret does not belong to the exact Namespace.");
      }
      return Object.freeze({
        ...this.secretMetadata(secret),
        consumers: await this.secretConsumers(state, principalId, namespaceId, secret.id),
      });
    });
  }

  async listSecrets(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<SecretMetadata>[]> {
    const namespace = await this.getNamespace(principalId, namespaceId);
    return this.read(async (state) => {
      const readable: Readonly<SecretMetadata>[] = [];
      for (const secret of await state.secrets.listSecrets(namespace.id)) {
        if (
          await this.canRead(principalId, {
            kind: "secret",
            id: secret.id,
            namespaceId: namespace.id,
          })
        ) {
          readable.push(this.secretMetadata(secret));
        }
      }
      return Object.freeze(readable);
    });
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
    const namespace = await this.getNamespace(principalId, namespaceId);
    return this.read(async (state) => {
      const readable: string[] = [];
      let unreadableCount = 0;
      for (const secret of await state.secrets.listSecrets(namespace.id)) {
        const resource: ResourceRef = { kind: "secret", id: secret.id, namespaceId: namespace.id };
        const read = await this.canRead(principalId, resource);
        if (!read && !unreadableAmong.has(secret.id)) {
          continue;
        }
        if ((await this.authorizationDecision(principalId, "operate", resource)).decision.allowed) {
          continue;
        }
        if (read) {
          readable.push(secret.id);
        } else {
          unreadableCount += 1;
        }
      }
      return { readable: Object.freeze(readable.sort()), unreadableCount };
    });
  }

  async updateSecret(
    principalId: string,
    input: UpdateSecretInput,
  ): Promise<Readonly<SecretMetadata>> {
    this.validateSecretValue(input.value);
    this.namespaceIdentity(input.namespaceId);
    return this.mutate(async (state) => {
      await this.authorize(principalId, "update", {
        kind: "secret",
        id: input.secretId,
        namespaceId: input.namespaceId,
      });
      const namespace = await this.lockNamespace(state, input.namespaceId);
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      const secret = await state.secrets.lockSecret(namespace.id, input.secretId);
      if (!secret) {
        throw new ScopeViolationError("The Secret does not belong to the exact Namespace.");
      }
      const driver = this.ownedSecretDriver(
        secret.driverId,
        () => new SecretStorageDriverError("update"),
      );
      // No prior value is read or retained for rollback. Success means stored, not delivered.
      await this.secretOperation(() => driver.update(secret, input.value));
      return this.secretMetadata(secret);
    });
  }

  /** Returns the AccessBindings removed with the Secret, for its deletion audit. */
  async deleteSecret(
    principalId: string,
    namespaceId: string,
    secretId: string,
  ): Promise<readonly RemovedAccessBinding[]> {
    this.namespaceIdentity(namespaceId);
    return this.mutate(async (state) => {
      const namespace = await this.lockNamespaceForPolicyDelete(state, principalId, {
        kind: "secret",
        id: secretId,
        namespaceId,
      });
      const secret = await state.secrets.lockSecret(namespace.id, secretId);
      if (!secret) {
        throw new ScopeViolationError("The Secret does not belong to the exact Namespace.");
      }
      const consumers = await this.secretConsumers(state, principalId, namespace.id, secret.id);
      if (
        consumers.unreadable > 0 ||
        SECRET_CONSUMER_KINDS.some((kind) => consumers[kind].length > 0)
      ) {
        throw new SecretReferencedError(consumers);
      }
      const removed = await accessBindingsTargeting(state, namespace.id, "secret", secret.id);
      const driver = this.ownedSecretDriver(
        secret.driverId,
        () => new SecretStorageDriverError("delete"),
      );
      await this.secretOperation(() => driver.delete(secret));
      if (!(await state.secrets.deleteSecret(namespace.id, secret.id))) {
        throw new ResourceStateConflictError("The Secret changed during deletion.");
      }
      return removed;
    });
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
    const owner = this.selections.get("credential_proxy")?.owner;
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
        this.selections.get("credential_proxy")?.owner !== owner ||
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
    if (!this.selections.has("credential_proxy")) {
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
          previous && this.selections.has("credential_proxy")
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
    if (input.kind !== "agent") {
      throw new ScopeViolationError("The Configuration kind must identify an Agent.");
    }
    const values = freezeConfigurationValues(input.values);
    this.namespaceIdentity(input.namespaceId);
    return this.mutate(async (state) => {
      await this.holdAuthority(state);
      const target: ResourceRef = {
        kind: "configuration",
        id: input.namespaceId,
        namespaceId: input.namespaceId,
      };
      await this.authorize(principalId, "create", target);
      const namespace = await this.lockNamespace(state, input.namespaceId);
      // AccessBinding deletes hold this lock: authorize again so a revocation that committed
      // while this write waited stops it before it leaves a durable Owner binding or grant.
      await this.authorize(principalId, "create", target);
      // Checked after authorization: the conflict names the Namespace state.
      if (namespace.status !== "provisioning" && namespace.status !== "ready") {
        throw new ResourceStateConflictError("The Namespace does not accept new Configurations.");
      }
      if (namespace.existingNamespace !== undefined && namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      const secretBindings = normalizeRequestSecretBindings(input.secretBindings);
      rejectCrossNamespaceSecretSources(namespace.id, secretBindings, undefined);
      await this.authorizeBindings(state, principalId, namespace.id, secretBindings);
      const driver = this.configurationDriver();
      const configuration: Configuration = Object.freeze({
        id: this.nextIdentifier("configuration"),
        namespaceId: namespace.id,
        kind: input.kind,
        generation: 1,
        values,
        createdAt: this.timestamp(),
      });
      // A document too large to store is refused before the content rules walk it (finding 1317).
      await driver.validateSize?.(values);
      this.validateConfigurationContent(values, undefined, secretBindings);
      await driver.validate(configuration);
      const metadata = await state.configurations.createConfiguration({
        id: configuration.id,
        namespaceId: namespace.id,
        kind: configuration.kind,
        generation: configuration.generation,
        ...(Object.keys(secretBindings).length === 0 ? {} : { secretBindings }),
        createdAt: configuration.createdAt,
      });
      await this.bindCreator(state, principalId, {
        kind: "configuration",
        id: metadata.id,
        namespaceId: namespace.id,
      });
      // Registered before the write: a create that applied but answered with an error (a
      // timeout, a lost response) would otherwise leave a ConfigMap without metadata (finding
      // 916). The rollback deletes only this exact Configuration (identity, generation, creation
      // time and values); an absent one means the create never applied, and a Driver that cannot
      // inspect it is compensated only after a create it saw succeed.
      let created = false;
      this.registerRollback(async () => {
        if (driver.inspectExact === undefined) {
          if (!created) {
            return;
          }
        } else if (
          (await this.driverOperation(() => driver.inspectExact!(configuration))) === undefined
        ) {
          return;
        }
        await this.driverOperation(() =>
          driver.delete({ id: configuration.id, namespaceId: configuration.namespaceId }),
        );
      });
      const result = await this.driverOperation(() => driver.create(configuration));
      created = true;
      return this.exactConfiguration(result, metadata);
    });
  }

  async createServiceAccount(
    principalId: string,
    input: CreateServiceAccountInput,
  ): Promise<Readonly<ServiceAccount>> {
    if (!isName(input.name)) {
      throw new ScopeViolationError("The ServiceAccount name is invalid.");
    }
    this.namespaceIdentity(input.namespaceId);
    return this.mutate(async (state) => {
      await this.holdAuthority(state);
      const target: ResourceRef = {
        kind: "service_account",
        id: input.namespaceId,
        namespaceId: input.namespaceId,
      };
      await this.authorize(principalId, "create", target);
      const namespace = await this.lockNamespace(state, input.namespaceId);
      // AccessBinding deletes hold this lock: authorize again so a revocation that committed
      // while this write waited stops it before it leaves a durable Owner binding or grant.
      await this.authorize(principalId, "create", target);
      // Checked after authorization: the conflict names the Namespace state.
      if (namespace.status !== "provisioning" && namespace.status !== "ready") {
        throw new ResourceStateConflictError("The Namespace does not accept new ServiceAccounts.");
      }
      const account = await state.serviceAccounts.createServiceAccount({
        id: this.nextIdentifier("service_account"),
        namespaceId: namespace.id,
        name: input.name,
      });
      await this.bindCreator(state, principalId, {
        kind: "service_account",
        id: account.id,
        namespaceId: namespace.id,
      });
      const driver = this.serviceAccountDriver();
      if (driver !== undefined) {
        await this.driverOperation(() => driver.create(account), "ServiceAccount");
      }
      return account;
    });
  }

  async createServiceAccountCredential(
    principalId: string,
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<Readonly<ServiceAccount>> {
    this.serviceAccountIdentity(namespaceId, serviceAccountId);
    return this.mutate(async (state) => {
      await this.authorize(principalId, "update", {
        kind: "service_account",
        id: serviceAccountId,
        namespaceId,
      });
      const namespace = await this.exactNamespace(state, namespaceId);
      const account = await state.serviceAccounts.lockServiceAccount(
        namespace.id,
        serviceAccountId,
      );
      if (account === undefined) {
        throw new ScopeViolationError("The ServiceAccount does not belong to the exact Namespace.");
      }
      if (account.credential !== undefined) {
        throw new ResourceStateConflictError("The ServiceAccount already has a credential.");
      }
      const driver = this.serviceAccountDriver();
      if (driver === undefined) {
        throw new ServiceAccountDriverNotConfiguredError("issue");
      }
      const credential = await this.driverOperation(
        () => driver.createCredential(account),
        "ServiceAccount",
      );
      if (credential?.kind !== "access_token") {
        throw new DependencyUnavailableError(
          "The ServiceAccount Driver returned an unsupported credential.",
        );
      }
      const updated = await state.serviceAccounts.updateCredential(
        namespace.id,
        account.id,
        credential,
      );
      if (updated === undefined) {
        throw new ResourceStateConflictError(
          "The ServiceAccount credential changed during its update.",
        );
      }
      return updated;
    });
  }

  async updateServiceAccountCredential(
    principalId: string,
    namespaceId: string,
    serviceAccountId: string,
    credential: ServiceAccountCredential,
  ): Promise<Readonly<ServiceAccount>> {
    this.serviceAccountIdentity(namespaceId, serviceAccountId);
    return this.mutate(async (state) => {
      await this.authorize(principalId, "update", {
        kind: "service_account",
        id: serviceAccountId,
        namespaceId,
      });
      const namespace = await this.exactNamespace(state, namespaceId);
      const account = await state.serviceAccounts.lockServiceAccount(
        namespace.id,
        serviceAccountId,
      );
      if (account === undefined) {
        throw new ScopeViolationError("The ServiceAccount does not belong to the exact Namespace.");
      }
      if (account.credential?.kind === "access_token" || credential.kind === "access_token") {
        throw new ResourceStateConflictError(
          "A managed ServiceAccount credential cannot be manually updated.",
        );
      }
      const updated = await state.serviceAccounts.updateCredential(
        namespace.id,
        account.id,
        credential,
      );
      if (updated === undefined) {
        throw new ResourceStateConflictError(
          "The ServiceAccount credential changed during its update.",
        );
      }
      return updated;
    });
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
    this.serviceAccountIdentity(namespaceId, serviceAccountId);
    return this.mutate(async (state) => {
      const namespace = await this.lockNamespaceForPolicyDelete(state, principalId, {
        kind: "service_account",
        id: serviceAccountId,
        namespaceId,
      });
      const account = await state.serviceAccounts.lockServiceAccount(
        namespace.id,
        serviceAccountId,
      );
      if (account === undefined) {
        throw new ScopeViolationError("The ServiceAccount does not belong to the exact Namespace.");
      }
      if (await state.serviceAccounts.hasReferences(namespace.id, account.id)) {
        throw new ResourceStateConflictError(
          "An Agent draft, active revision, pending deployment, or pending Agent provisioning request still references the ServiceAccount. Remove those references, or let provisioning finish, first.",
        );
      }
      // Decided once, on the locked account row: Driver selection is fixed when the API
      // starts, and issuance takes the same row lock, so no token can appear after this read.
      const driver = this.serviceAccountDriver();
      let unrevokedCredential: ServiceAccountDeletion["unrevokedCredential"];
      if (account.credential?.kind === "access_token" && driver === undefined) {
        // Only the Backend's Driver can revoke the issued token, so deletion waits for it
        // unless the caller forces it. Only the worker sets a configured Driver id, so the API
        // always answers the 409 (or forces).
        if (this.configuredServiceAccountDriverId !== undefined) {
          throw new DependencyUnavailableError(
            "The selected ServiceAccount Driver is unavailable.",
          );
        }
        if (options.force !== true) {
          throw new ServiceAccountDriverNotConfiguredError("delete");
        }
        const binding = await state.serviceAccounts.findIssuedCredentialBinding(
          namespace.id,
          account.id,
        );
        await this.deleteUnrevokedCredentialSecret(account, account.credential);
        unrevokedCredential = binding === undefined ? {} : { ...binding };
      }
      if (driver !== undefined) {
        await this.driverOperation(() => driver.delete(account), "ServiceAccount");
      }
      const removed = await accessBindingsTargeting(
        state,
        namespace.id,
        "service_account",
        account.id,
      );
      if (!(await state.serviceAccounts.deleteServiceAccount(namespace.id, account.id))) {
        throw new ResourceStateConflictError("The ServiceAccount changed during deletion.");
      }
      return {
        removedAccessBindings: removed,
        ...(unrevokedCredential === undefined ? {} : { unrevokedCredential }),
      };
    });
  }

  /**
   * A forced deletion still removes OCC's copy of the unrevoked token: the account-owned
   * Secret the ChatGPT Driver would have removed after revoking it. The Compute Driver that
   * stored it owns that Secret; one without the operation never stored account tokens.
   */
  private async deleteUnrevokedCredentialSecret(
    account: Readonly<ServiceAccount>,
    credential: ServiceAccountCredential,
  ): Promise<void> {
    const compute = this.selectedDriver("compute");
    const deleteSecret = compute.deleteServiceAccountCredential?.bind(compute);
    if (deleteSecret === undefined) {
      return;
    }
    await this.driverOperation(
      () =>
        deleteSecret({
          namespaceId: account.namespaceId,
          serviceAccountId: account.id,
          secretRef: credential.secretRef,
        }),
      "Compute",
    );
  }

  async getConfiguration(
    principalId: string,
    namespaceId: string,
    configurationId: string,
  ): Promise<Readonly<Configuration>> {
    this.configurationIdentity(namespaceId, configurationId);
    await this.authorize(principalId, "read", {
      kind: "configuration",
      id: configurationId,
      namespaceId,
    });
    const driver = this.configurationDriver();
    return this.read(async (state) => {
      const namespace = await this.exactNamespace(state, namespaceId);
      const metadata = await state.configurations.findConfiguration(namespace.id, configurationId);
      if (!metadata) {
        throw new ScopeViolationError("The Configuration does not belong to the exact Namespace.");
      }
      await this.guardProvisioningConfiguration(state, namespace.id, configurationId, true);
      const configuration = await this.driverOperation(() =>
        driver.read({ id: metadata.id, namespaceId: namespace.id }),
      );
      return this.exactConfiguration(configuration, metadata);
    });
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
    this.configurationIdentity(namespaceId, configurationId);
    await this.authorize(principalId, "read", {
      kind: "configuration",
      id: configurationId,
      namespaceId,
    });
    return this.read(async (state) => {
      const namespace = await this.exactNamespace(state, namespaceId);
      const metadata = await state.configurations.findConfiguration(namespace.id, configurationId);
      if (!metadata) {
        throw new ScopeViolationError("The Configuration does not belong to the exact Namespace.");
      }
      return Object.freeze(
        Object.fromEntries(
          Object.entries(this.bindings(metadata.secretBindings)).map(([name, { source }]) => [
            name,
            source,
          ]),
        ),
      );
    });
  }

  async updateConfiguration(
    principalId: string,
    input: UpdateConfigurationInput,
  ): Promise<Readonly<Configuration>> {
    this.configurationIdentity(input.namespaceId, input.configurationId);
    if (Object.hasOwn(input, "kind")) {
      throw new ScopeViolationError("The Configuration kind cannot be changed.");
    }
    const values = freezeConfigurationValues(input.values);
    return this.mutate(async (state) => {
      await this.authorize(principalId, "update", {
        kind: "configuration",
        id: input.configurationId,
        namespaceId: input.namespaceId,
      });
      const namespace = await this.lockNamespace(state, input.namespaceId);
      const driver = this.configurationDriver();
      const metadata = await state.configurations.lockConfiguration(
        namespace.id,
        input.configurationId,
      );
      if (!metadata) {
        throw new ScopeViolationError("The Configuration does not belong to the exact Namespace.");
      }
      await this.guardProvisioningConfiguration(state, namespace.id, input.configurationId);
      // Compared under the row lock, so a save that read an older generation cannot replace a
      // newer one (finding 1505).
      if (
        input.expectedGeneration !== undefined &&
        input.expectedGeneration !== metadata.generation
      ) {
        throw new ConfigurationGenerationConflictError();
      }
      const previous = await this.lockedConfiguration(driver, metadata);
      let secretBindings: SecretBindings;
      if (input.secretBindings === undefined) {
        secretBindings = this.bindings(metadata.secretBindings);
      } else {
        secretBindings = normalizeRequestSecretBindings(input.secretBindings);
        rejectCrossNamespaceSecretSources(namespace.id, secretBindings, undefined);
      }
      await this.authorizeBindings(state, principalId, namespace.id, secretBindings);
      let advanced = await state.configurations.advanceConfigurationGeneration(
        namespace.id,
        metadata.id,
        metadata.generation,
        secretBindings,
      );
      // A stored document ahead of the record holds content that was never recorded. The
      // replacement skips past every generation it went through, one advance at a time (the
      // record moves by exactly one per write), so no number names two documents.
      while (advanced && advanced.generation <= previous.generation) {
        advanced = await state.configurations.advanceConfigurationGeneration(
          namespace.id,
          metadata.id,
          advanced.generation,
          secretBindings,
        );
      }
      if (!advanced) {
        throw new ResourceStateConflictError(
          "The Configuration generation changed during its update.",
        );
      }
      const configuration: Configuration = Object.freeze({
        id: advanced.id,
        namespaceId: advanced.namespaceId,
        kind: advanced.kind,
        generation: advanced.generation,
        values,
        createdAt: advanced.createdAt,
      });
      // A document too large to store is refused before the content rules walk it (finding 1317).
      await driver.validateSize?.(values);
      // A stored Configuration that predates these rules still reads, and deployment refuses it
      // as before; only a replacement that keeps the refused value fails. That includes a channel
      // reference left without a binding by either half of the update: its values, or bindings
      // it replaced (finding 2319).
      this.validateConfigurationContent(values, undefined, secretBindings);
      await driver.validate(configuration);
      // Registered before the write: a replace that applied but answered with an error (a
      // timeout, a lost response) would otherwise leave the stored Configuration one generation
      // ahead of the rolled-back metadata (finding 911). A write that never applied is left alone,
      // and so is a stored generation another update committed after the lock was released. A
      // replacement of a leftover ahead of the record restores that leftover, which a retry can
      // replace again (finding 1396).
      this.registerRollback(async () => {
        const stored = await driver.read({ id: previous.id, namespaceId: previous.namespaceId });
        if (
          stored.generation === configuration.generation &&
          (await this.configurationRecordUnchanged(metadata))
        ) {
          await driver.update(previous);
        }
      });
      const updated = await this.driverOperation(() => driver.update(configuration));
      return this.exactConfiguration(updated, advanced);
    });
  }

  async deleteConfiguration(
    principalId: string,
    namespaceId: string,
    configurationId: string,
  ): Promise<readonly RemovedAccessBinding[]> {
    this.configurationIdentity(namespaceId, configurationId);
    return this.mutate(async (state) => {
      const namespace = await this.lockNamespaceForPolicyDelete(state, principalId, {
        kind: "configuration",
        id: configurationId,
        namespaceId,
      });
      const driver = this.configurationDriver();
      const configuration = await state.configurations.lockConfiguration(
        namespace.id,
        configurationId,
      );
      if (!configuration) {
        throw new ScopeViolationError("The Configuration does not belong to the exact Namespace.");
      }
      const agents = await state.agents.listAgents(namespace.id);
      if (agents.some((agent) => agent.configurationId === configuration.id)) {
        throw new ResourceStateConflictError(
          "An Agent still references the Configuration. Delete the Agent or select another Configuration first.",
        );
      }
      // A provisioning record references the Configuration it created. Once its Agent has
      // succeeded and selects another Configuration (checked above), the record releases it.
      if (
        (await state.provisioning.findByConfiguration(namespace.id, configuration.id)) !==
          undefined &&
        !(await state.provisioning.releaseConfiguration(namespace.id, configuration.id))
      ) {
        throw new ResourceStateConflictError(
          "An Agent provisioning request that has not succeeded still references the Configuration. Let it finish or retry it, or delete the Agent it provisioned, first.",
        );
      }
      // A record whose document a failed delete already removed has nothing left to delete or
      // restore (finding 1396); only a Driver that confirms the absence lets it go.
      const previous = await this.lockedConfiguration(driver, configuration).catch(
        async (error: unknown) => {
          if (await this.configurationAbsent(driver, configuration)) {
            return undefined;
          }
          throw error;
        },
      );
      if (previous !== undefined) {
        // Registered before the write: a delete that applied but answered with an error would
        // otherwise leave the metadata without its ConfigMap (finding 916). The rollback
        // recreates the previous Configuration only when it is gone and its record is still the
        // one locked here; one still stored exactly means the delete never applied, and a record
        // another request deleted or changed in the meantime is that request's (finding 945). A
        // Driver that cannot inspect it is compensated only after a delete it saw succeed.
        let deleted = false;
        this.registerRollback(async () => {
          if (driver.inspectExact === undefined) {
            if (!deleted) {
              return;
            }
          } else if (
            (await this.driverOperation(() => driver.inspectExact!(previous))) !== undefined
          ) {
            return;
          }
          if (await this.configurationRecordUnchanged(configuration)) {
            await this.driverOperation(() => driver.create(previous));
          }
        });
        await this.driverOperation(() =>
          driver.delete({ id: configuration.id, namespaceId: namespace.id }),
        );
        deleted = true;
      }
      const removed = await accessBindingsTargeting(
        state,
        namespace.id,
        "configuration",
        configuration.id,
      );
      if (!(await state.configurations.deleteConfiguration(namespace.id, configuration.id))) {
        throw new ResourceStateConflictError("The Configuration changed during deletion.");
      }
      return removed;
    });
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
    if (!this.selections.has("credential_gateway") || !this.selections.has("credential_refresh")) {
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
    const refresh = this.selections.has("credential_refresh")
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
      !this.selections.has("credential_refresh") ||
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
    if (!this.selections.has("credential_proxy")) {
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
    const harnessAuth = harnessAuthBinding(input.harnessAuth ?? null);
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
      await this.harnessAuthOperations.authorizeHarnessAuthSource(
        state,
        principalId,
        namespace.id,
        harnessAuth,
      );
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
        resolveHarness,
        {
          executionMode,
          harnessAuth: () =>
            this.harnessAuthOperations.savedHarnessAuthSnapshot(state, namespace.id, harnessAuth),
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
    const harnessAuth = plannedHarnessAuth(input.harnessAuth ?? null);
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
      const values = freezeConfigurationValues(input.configuration.values);
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
        resolveHarness,
        {
          executionMode,
          harnessAuth: async () =>
            this.harnessAuthOperations.plannedHarnessAuthSnapshot(namespace.id, harnessAuth),
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
      input.harnessAuth === undefined ? undefined : harnessAuthBinding(input.harnessAuth);
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
      const previousAuth = harnessAuthBinding(agent.harnessAuth);
      // Every update needs the caller's grant on each source the Agent binds now, but not a
      // usable record: after a Secret Driver or Credential Gateway change, an update must still
      // be able to replace or drop what the new driver does not own. Only what the update
      // binds is looked up, and deploy admission rechecks every bound source.
      // A denial here says it is for the current Harness authentication, which an update that
      // replaces it also needs (finding D763).
      await this.harnessAuthOperations
        .authorizeBoundHarnessAuth(principalId, namespace.id, previousAuth)
        .catch((error: unknown) => {
          throw QualifiedAuthorizationDeniedError.qualify(error, "current_harness_auth");
        });
      await this.authorizeBoundCredentialSources(
        principalId,
        namespace.id,
        agent.credentialSources ?? [],
      );
      if (requestedAuth !== undefined) {
        rejectCrossNamespaceSecretSources(namespace.id, undefined, requestedAuth);
        await this.harnessAuthOperations.authorizeHarnessAuthSource(
          state,
          principalId,
          namespace.id,
          requestedAuth,
        );
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
        resolveHarness,
        {
          executionMode: input.executionMode ?? agent.executionMode,
          harnessAuth: () =>
            this.harnessAuthOperations.savedHarnessAuthSnapshot(
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
    driver = this.selections.get("channel")?.driver as ChannelDriver | undefined,
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
    const configuration = this.selections.get("configuration");
    const channel = this.selections.get("channel");
    if (
      configuration?.driver !== prepared.configurationDriver ||
      !this.unchangedDriver(configuration) ||
      channel?.driver !== prepared.channel ||
      (channel !== undefined && !this.unchangedDriver(channel)) ||
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
    if (this.selections.get("channel") === undefined) {
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
    const channel = this.selections.has("channel") ? this.selectedDriver("channel") : undefined;
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
    const owners = [...this.selections.values(), ...this.pluginRegistrations].map((selected) => {
      if (!this.unchangedDriver(selected)) {
        throw new DriverSelectionError("A selected Namespace lifecycle Driver changed identity.");
      }
      return selected.owner ?? selected.driver;
    });
    return reconcileNamespaceLifecycle(
      this.selectedDriver("compute"),
      selectedNamespaceLifecycle(owners, this.namespaceLifecycleBindings),
      namespace,
      target,
      signal,
      record,
    );
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

  /**
   * The current references to a Secret, named only where the caller may read the
   * referencing resource; the rest are counted. One reference query examines at most
   * SECRET_CONSUMER_LIMIT references. Each costs one `read` decision, except a pending
   * provisioning request: one record read, then, for its own actor only, the decisions its
   * status read makes. Identical decisions are made once per call.
   */
  private async secretConsumers(
    state: Pick<PlatformReadView, "secrets" | "provisioning">,
    principalId: string,
    namespaceId: string,
    secretId: string,
  ): Promise<Readonly<SecretConsumers>> {
    const page = await state.secrets.listReferences(namespaceId, secretId, SECRET_CONSUMER_LIMIT);
    const named: Record<(typeof SECRET_CONSUMER_KINDS)[number], string[]> = {
      agents: [],
      configurations: [],
      credentialSources: [],
      provisioningRequests: [],
    };
    let unreadable = 0;
    const decisions = new Map<string, boolean>();
    const allowed = async (
      action: AuthorizationRequest["action"],
      resource: ResourceRef,
    ): Promise<boolean> => {
      const key = JSON.stringify([action, resource.kind, resource.namespaceId, resource.id]);
      let decision = decisions.get(key);
      if (decision === undefined) {
        decision = (await this.authorizationDecision(principalId, action, resource)).decision
          .allowed;
        decisions.set(key, decision);
      }
      return decision;
    };
    for (const reference of page.references) {
      const readable =
        reference.kind === "provisioning_request"
          ? await this.canReadProvisioningRequest(
              state,
              principalId,
              namespaceId,
              reference.id,
              allowed,
            )
          : await allowed("read", { kind: reference.kind, id: reference.id, namespaceId });
      if (!readable) {
        unreadable += 1;
        continue;
      }
      named[SECRET_CONSUMER_FIELDS[reference.kind]].push(reference.id);
    }
    return Object.freeze({
      agents: Object.freeze(named.agents),
      configurations: Object.freeze(named.configurations),
      credentialSources: Object.freeze(named.credentialSources),
      provisioningRequests: Object.freeze(named.provisioningRequests),
      unreadable,
      truncated: page.truncated,
    });
  }

  /**
   * Whether the caller may read a pending provisioning request: only its initiating actor,
   * holding the grants that its status read checks (`authorizeProvisioningRecord`). The plan
   * checks that a status read also runs are admission, not authorization, so they are skipped;
   * a stored plan that no longer parses is not named.
   */
  private async canReadProvisioningRequest(
    state: Pick<PlatformReadView, "provisioning">,
    principalId: string,
    namespaceId: string,
    workId: string,
    allowed: (action: AuthorizationRequest["action"], resource: ResourceRef) => Promise<boolean>,
  ): Promise<boolean> {
    const record = await state.provisioning.findByWorkId(workId);
    if (
      record === undefined ||
      record.namespaceId !== namespaceId ||
      record.actorId !== principalId
    ) {
      return false;
    }
    let plan: ReturnType<OpenClawController["provisioningPlan"]>;
    try {
      plan = this.provisioningPlan(record);
    } catch (error) {
      if (error instanceof DependencyUnavailableError) {
        throw error;
      }
      return false;
    }
    const harnessAuth = plan.harnessAuth;
    const checks: [AuthorizationRequest["action"], ResourceRef][] = [
      ["create", { kind: "agent", namespaceId, id: namespaceId }],
      ["create", { kind: "configuration", namespaceId, id: namespaceId }],
      ["administer", { kind: "installation", id: this.installation.id }],
      ...(record.agentId === undefined
        ? []
        : (["read", "operate", "deploy"] as const).map(
            (action): [AuthorizationRequest["action"], ResourceRef] => [
              action,
              { kind: "agent", namespaceId, id: record.agentId as string },
            ],
          )),
      ...(record.configurationId === undefined
        ? []
        : (["read", "update"] as const).map(
            (action): [AuthorizationRequest["action"], ResourceRef] => [
              action,
              { kind: "configuration", namespaceId, id: record.configurationId as string },
            ],
          )),
      ...Object.values(plan.configuration.secretBindings ?? {}).map(
        (binding): [AuthorizationRequest["action"], ResourceRef] => ["operate", binding.source],
      ),
      ...(isSecretHarnessAuth(harnessAuth)
        ? [["operate", harnessAuth.source] as [AuthorizationRequest["action"], ResourceRef]]
        : []),
      ...(harnessAuth?.method === "credential_source"
        ? [
            ["operate", { kind: "credential_source", namespaceId, id: harnessAuth.sourceId }] as [
              AuthorizationRequest["action"],
              ResourceRef,
            ],
          ]
        : []),
      ...(isServiceAccountHarnessAuth(harnessAuth)
        ? [
            ["read", { kind: "service_account", namespaceId, id: harnessAuth.source.id }] as [
              AuthorizationRequest["action"],
              ResourceRef,
            ],
          ]
        : []),
    ];
    for (const [action, resource] of checks) {
      if (!(await allowed(action, resource))) {
        return false;
      }
    }
    return true;
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

  /**
   * Authorizes a delete that also removes IAM policy, then locks its Namespace. The first
   * check runs before any lookup, so a caller without the grant gets the same audited denial
   * whether or not the target exists. The second runs under the Namespace lock, which orders
   * it after a concurrent revocation, as holdIAMPolicyAuthority does for policy writes.
   */
  private async lockNamespaceForPolicyDelete(
    state: PlatformUnitOfWork,
    principalId: string,
    target: ResourceRef & { readonly namespaceId: string },
  ): Promise<Readonly<Namespace>> {
    await this.authorize(principalId, "delete", target);
    const namespace = await this.lockNamespace(state, target.namespaceId);
    await this.authorize(principalId, "delete", target);
    return namespace;
  }

  private bindings(input: unknown): SecretBindings {
    try {
      return normalizeSecretBindings(input);
    } catch {
      throw new ScopeViolationError(
        "Secret bindings require supported exact sources and non-reserved environment destinations.",
      );
    }
  }

  /** Called under the Namespace lock, also taken by deletion and assignment. */
  private async authorizeBindings(
    state: PlatformUnitOfWork,
    principalId: string,
    namespaceId: string,
    bindings: SecretBindings,
  ): Promise<readonly Secret[]> {
    const secrets = new Map<string, Secret>();
    for (const { source } of Object.values(bindings)) {
      if (source.namespaceId !== namespaceId) {
        throw new ScopeViolationError("Secret references cannot cross Namespaces.");
      }
      await this.authorize(principalId, "operate", source);
      const secret = await state.secrets.lockSecret(namespaceId, source.id);
      if (!secret) {
        throw new ScopeViolationError("The Secret does not belong to the exact Namespace.");
      }
      this.ownedSecretDriver(secret.driverId, () => new SecretBindingDriverError());
      secrets.set(secret.id, secret);
    }
    return Object.freeze([...secrets.values()]);
  }

  /** Namespace lock serializes binding, source deletion, and admission. */
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
    if (!this.selections.has("credential_gateway")) {
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
        !this.selections.has("credential_proxy")
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
      this.harnessAuthOperations.assertCredentialGatewayDelivery(binding);
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
      requireCredentialSourceSandbox(this.sandboxDriver());
    } else if (isSecretHarnessAuth(binding)) {
      auth = this.harnessAuthOperations.secretHarnessAuthSnapshot(binding);
    } else if (agent !== undefined) {
      [auth, credentialSourceType] = await this.harnessAuthOperations.admitHarnessAuth(
        state,
        principalId,
        {
          ...agent,
          harnessAuth: binding,
        },
      );
    } else if (binding.method === "credential_source") {
      [auth, credentialSourceType] =
        await this.harnessAuthOperations.credentialSourceHarnessAuthSnapshot(
          state,
          namespaceId,
          binding,
        );
    } else {
      auth = await this.harnessAuthOperations.serviceAccountHarnessAuthSnapshot(
        state,
        namespaceId,
        backendId,
        binding,
      );
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
      this.harnessAuthOperations.requireCredentialSourceDrivers(auth, sandbox);
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

  /** Callers hold the Namespace lock. */
  private async guardAgentProvisioning(
    state: PlatformUnitOfWork,
    namespaceId: string,
    agentId: string,
    handoff = false,
  ): Promise<void> {
    const record = await state.provisioning.findByAgent(namespaceId, agentId);
    if (record === undefined || record.revisionId !== undefined) {
      return;
    }
    const claim = handoff ? this.provisioningContext.getStore() : undefined;
    if (claim?.idempotencyKey === record.workId && record.status === "running") {
      return;
    }
    if (
      record.status === "queued" ||
      record.status === "running" ||
      this.provisioningBefore(record, "configuration") ||
      (record.status === "failed" && record.revisionId === undefined)
    ) {
      throw new ResourceStateConflictError(
        "The Agent is reserved for provisioning. Stop or delete it, or retry its failed provisioning request.",
      );
    }
    if (record.status === "cancelled" && this.provisioningHasUnresolvedEffect(record)) {
      await this.settleAbandonedProvisioningEffect(state, namespaceId, agentId);
    }
  }

  /**
   * A cancelled job never runs again, so nothing else settles the runtime-credential write it
   * left pending, and without this its stopped Agent could only be deleted (finding 1384). Once
   * the claim that began the write has lapsed (at once if no worker held it when Stop cancelled
   * the job), its worker has stopped issuing requests, so this settles it under the Namespace and
   * Agent locks, as Agent deletion does. A request already sent may still land; that is safe
   * because the write creates only absent Secrets, and deploy admission checks the runtime
   * credentials and creates missing ones. Inside the lease the Agent stays reserved; with
   * conflicting or malformed evidence it can only be deleted.
   */
  private async settleAbandonedProvisioningEffect(
    state: PlatformUnitOfWork,
    namespaceId: string,
    agentId: string,
  ): Promise<void> {
    const agent = await state.agents.lockAgent(namespaceId, agentId);
    if (agent?.status !== "active") {
      throw new AgentDeletingError();
    }
    const current =
      (await state.provisioning.settleAbandonedEffect(namespaceId, agentId)) ??
      (await state.provisioning.findByAgent(namespaceId, agentId));
    if (
      current === undefined ||
      current.revisionId !== undefined ||
      !this.provisioningHasUnresolvedEffect(current)
    ) {
      return;
    }
    const pending = provisioningPendingEffect(current);
    // Only a well-formed write still inside its cancelled claim's lease settles by waiting.
    if (
      pending?.kind === "transport" &&
      pending.ownerPresent &&
      current.progress.effectReceipt === undefined &&
      current.progress.cancelledClaimExpiresAt !== undefined
    ) {
      throw new ResourceStateConflictError(
        "The Agent's cancelled provisioning may still be writing its runtime credentials. Try again in a few seconds, or delete the Agent.",
      );
    }
    throw new ResourceStateConflictError(
      "The Agent's cancelled provisioning left a runtime-credential write that cannot be settled. Delete the Agent.",
    );
  }

  private async guardProvisioningConfiguration(
    state: PlatformReadView,
    namespaceId: string,
    configurationId: string,
    readOnly = false,
  ): Promise<void> {
    const record = await state.provisioning.findByConfiguration(namespaceId, configurationId);
    if (
      record !== undefined &&
      record.revisionId === undefined &&
      (readOnly
        ? this.provisioningBefore(record, "configuration")
        : this.provisioningBefore(record, "configuration") ||
          record.status === "queued" ||
          record.status === "running" ||
          (record.status === "failed" && record.revisionId === undefined) ||
          (record.status === "cancelled" && this.provisioningHasUnresolvedEffect(record)))
    ) {
      throw new ResourceStateConflictError(
        "The Configuration is reserved for provisioning and is not available for this operation.",
      );
    }
  }

  private provisioningBefore(
    record: Pick<AgentProvisioningRecord, "completedPhase">,
    phase: AgentProvisioningCheckpoint["completedPhase"],
  ): boolean {
    const order = ["admitted", "configuration", "transport", "handoff"];
    return order.indexOf(record.completedPhase) < order.indexOf(phase);
  }

  private provisioningHasUnresolvedEffect(record: Readonly<AgentProvisioningRecord>): boolean {
    const hasRawPending = record.progress.pendingEffect !== undefined;
    const hasRawReceipt = record.progress.effectReceipt !== undefined;
    if (!hasRawPending && !hasRawReceipt) {
      return false;
    }
    const pending = provisioningPendingEffect(record);
    const receipt = readProvisioningEffectReceipt(record);
    // Malformed effect evidence stays fail-closed because the worker cannot prove
    // whether an external write completed.
    if ((hasRawPending && pending === undefined) || (hasRawReceipt && receipt === undefined)) {
      return true;
    }
    if (pending === undefined) {
      return false;
    }
    if (!pending.ownerPresent || receipt === undefined) {
      return true;
    }
    return (
      receipt.kind !== pending.kind ||
      receipt.owner !== pending.owner ||
      receipt.targetId !== pending.targetId
    );
  }

  private async checkpointAgentProvisioning(
    claim: ClaimedWork,
    checkpoint: AgentProvisioningCheckpoint,
  ): Promise<Readonly<AgentProvisioningRecord>> {
    return this.mutate(async (state) => {
      await this.fenceAgentProvisioning(state, claim);
      return this.commitProvisioningCheckpoint(state, claim, checkpoint);
    });
  }

  private async commitProvisioningCheckpoint(
    state: PlatformUnitOfWork,
    claim: ClaimedWork,
    checkpoint: AgentProvisioningCheckpoint,
  ): Promise<Readonly<AgentProvisioningRecord>> {
    const record = await state.provisioning.checkpoint(claim, checkpoint);
    await state.audit.append({
      id: `aud_${crypto.randomUUID()}`,
      installationId: this.installation.id,
      namespaceId: record.namespaceId,
      occurredAt: this.timestamp(),
      kind: "mutation",
      actorId: record.actorId,
      source: "occ",
      action: "openclaw.agents.provision.checkpoint",
      resource: {
        kind: "agent",
        namespaceId: record.namespaceId,
        id: record.agentId ?? record.namespaceId,
      },
      outcome: "success",
      details: {
        workId: record.workId,
        phase: record.completedPhase,
        ...(record.revisionId === undefined ? {} : { revisionId: record.revisionId }),
      },
    });
    return record;
  }

  private async fenceAgentProvisioning(
    state: PlatformUnitOfWork,
    claim: ClaimedWork,
  ): Promise<Readonly<AgentProvisioningRecord>> {
    const record = await state.provisioning.findByWorkId(claim.idempotencyKey);
    if (record === undefined) {
      throw new WorkClaimLostError();
    }
    // Hold the IAM configuration lock so a configuration change that revokes the requester's
    // Group binding commits before this check or after the Owner bindings provisioning writes.
    // Take it before the Namespace lock: applying the configuration holds it exclusively and
    // then locks each Namespace it writes a configured binding into.
    await state.installations.holdIAMConfiguration("shared");
    const namespace = await this.lockNamespace(state, record.namespaceId);
    if (namespace.status !== "ready") {
      throw new NamespaceNotReadyError();
    }
    if (record.agentId !== undefined) {
      const agent = await state.agents.lockAgent(namespace.id, record.agentId);
      if (
        agent === undefined ||
        agent.status !== "active" ||
        agent.desiredRuntimeState !== "stopped"
      ) {
        throw new ResourceStateConflictError("The Agent lifecycle changed during provisioning.");
      }
    }
    await this.authorizeProvisioningRecord(state, record.actorId, record);
    return state.provisioning.checkpoint(claim, {
      completedPhase: record.completedPhase,
      status: "running",
    });
  }

  private async beginProvisioningEffect(
    claim: ClaimedWork,
    effect: ProvisioningEffectTarget,
  ): Promise<Readonly<AgentProvisioningRecord>> {
    return this.mutate(async (state) => {
      await this.fenceAgentProvisioning(state, claim);
      return state.provisioning.beginEffect(claim, effect);
    });
  }

  private async settleProvisioningEffect(
    workId: string,
    record: Readonly<AgentProvisioningRecord>,
    effect: ProvisioningEffectTarget,
  ): Promise<Readonly<AgentProvisioningRecord>> {
    const pending = provisioningPendingEffect(record);
    if (pending?.owner === undefined) {
      throw new ResourceConflictError("The Agent provisioning effect owner is unavailable.");
    }
    const progress = buildProvisioningEffectSettlement(record, {
      ...effect,
      owner: pending.owner,
    });
    const receipt = progress.effectReceipt;
    if (
      receipt === undefined ||
      receipt === null ||
      typeof receipt !== "object" ||
      Array.isArray(receipt)
    ) {
      throw new ResourceConflictError("The Agent provisioning effect receipt is invalid.");
    }
    return this.mutate((state) =>
      state.provisioning.settleEffect(workId, receipt as ProvisioningEffectReceipt),
    );
  }

  private provisioningEffectReceipt(
    record: Readonly<AgentProvisioningRecord>,
    effect: ProvisioningEffectTarget,
  ): ProvisioningEffectReceipt | undefined {
    const receipt = readProvisioningEffectReceipt(record);
    if (receipt === undefined || receipt.kind !== effect.kind) {
      return undefined;
    }
    if (effect.targetId !== undefined && receipt.targetId !== effect.targetId) {
      return undefined;
    }
    return receipt;
  }

  private provisioningPendingEffectMatches(
    record: Readonly<AgentProvisioningRecord>,
    effect: ProvisioningEffectTarget,
  ): boolean {
    const pending = provisioningPendingEffect(record);
    if (
      pending === undefined ||
      !pending.targetMatches ||
      !pending.ownerPresent ||
      pending.kind !== effect.kind
    ) {
      return false;
    }
    return effect.targetId === undefined || pending.targetId === effect.targetId;
  }

  /** Settles the pending Configuration create once observed; undefined while it is absent. */
  private async inspectProvisioningConfigurationEffect(
    workId: string,
    record: Readonly<AgentProvisioningRecord>,
    effect: ProvisioningEffectTarget & { readonly kind: "configuration" },
    configuration: Configuration,
    driver: ConfigurationDriver,
    runEffect: <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<T>,
  ): Promise<Readonly<AgentProvisioningRecord> | undefined> {
    if (!this.provisioningPendingEffectMatches(record, effect)) {
      throw new DependencyUnavailableError(
        "The pending Configuration provisioning effect outcome is unknown.",
      );
    }
    if (driver.inspectExact === undefined) {
      throw new DependencyUnavailableError(
        "The Configuration Driver does not support exact provisioning recovery.",
      );
    }
    return runEffect(async () => {
      const recovered = await this.driverOperation(() => driver.inspectExact!(configuration));
      return recovered === undefined
        ? undefined
        : this.settleProvisioningEffect(workId, record, effect);
    });
  }

  /**
   * Sends a pending Configuration create again when it is still absent after its settle window
   * (finding 911): a create that never reached the API server is otherwise never resent, and the
   * work retries as an unknown outcome until attempts run out. Inside the window the attempt
   * defers without spending a retry. The resend keeps the pending effect, its owner and target,
   * so the Namespace still waits for it; it follows a fresh fence, as the first send did, and
   * writes the same deterministic Configuration with create-if-absent semantics. If it fails
   * (AlreadyExists, or a lost response), an earlier send may have landed after all: the exact
   * inspection, which checks identity, generation, creation time and values, decides whether
   * the effect settles, and a conflict it reports replaces the create's error. The window is
   * measured from the first send only (the pending effect cannot be replaced), so a later
   * attempt resends at once and relies on create-if-absent and that inspection alone. An effect
   * recorded before its start was stamped keeps waiting.
   */
  private async resendProvisioningConfigurationEffect(
    claim: ClaimedWork,
    record: Readonly<AgentProvisioningRecord>,
    effect: ProvisioningEffectTarget & { readonly kind: "configuration" },
    configuration: Configuration,
    driver: ConfigurationDriver,
    runEffect: <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<T>,
  ): Promise<Readonly<AgentProvisioningRecord>> {
    const startedAt = provisioningPendingEffect(record)?.startedAt;
    if (startedAt === undefined) {
      throw new DependencyUnavailableError(
        "The pending Configuration provisioning effect outcome is unknown.",
      );
    }
    // The fence stamps updated_at on the database clock, the clock that stamped startedAt.
    const fenced = await this.mutate((state) => this.fenceAgentProvisioning(state, claim));
    if (!this.provisioningPendingEffectMatches(fenced, effect)) {
      throw new DependencyUnavailableError(
        "The pending Configuration provisioning effect outcome is unknown.",
      );
    }
    const remainingMs =
      startedAt.getTime() + PROVISIONING_CONFIGURATION_SETTLE_MS - fenced.updatedAt.getTime();
    if (remainingMs > 0) {
      throw new ProvisioningConfigurationSettlingError(
        Math.min(Math.ceil(remainingMs), PROVISIONING_CONFIGURATION_SETTLE_MS),
      );
    }
    return runEffect(async () => {
      try {
        await this.driverOperation(() => driver.createExact!(configuration));
      } catch (error) {
        const landed = await this.driverOperation(() => driver.inspectExact!(configuration));
        if (landed === undefined) {
          throw error;
        }
      }
      return this.settleProvisioningEffect(claim.idempotencyKey, fenced, effect);
    });
  }

  private async inspectProvisioningTransportEffect(
    workId: string,
    record: Readonly<AgentProvisioningRecord>,
    effect: ProvisioningEffectTarget & { readonly kind: "transport" },
    namespace: Readonly<Namespace>,
    agent: Readonly<Agent>,
    driver: ComputeDriver,
    runEffect: <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<T>,
  ): Promise<Readonly<AgentProvisioningRecord>> {
    if (!this.provisioningPendingEffectMatches(record, effect)) {
      throw new DependencyUnavailableError(
        "The pending transport provisioning effect outcome is unknown.",
      );
    }
    if (driver.getAgentRuntimeCredentialStatus === undefined) {
      throw new DependencyUnavailableError(
        "The Compute Driver does not support exact provisioning recovery.",
      );
    }
    return runEffect(async () => {
      const status = await this.runtimeCredentialOperation(() =>
        driver.getAgentRuntimeCredentialStatus!({ namespace, agent }),
      );
      if (!this.runtimeCredentialStatus(status).transportConfigured) {
        throw new DependencyUnavailableError(
          "The pending transport provisioning effect outcome is unknown.",
        );
      }
      return this.settleProvisioningEffect(workId, record, effect);
    });
  }

  /**
   * The Configuration a failing job wrote through its Driver but never recorded (finding 1395).
   * The write settled, then the Configuration step's transaction refused (a duplicate Agent name,
   * for example) and rolled back the record, or a later fence refused the job before that step
   * ran again. Nothing else deletes that document. A write that has not settled, a job past its
   * Configuration step, a Configuration record with the ID, or a write made through a Driver the
   * Installation no longer selects leaves it alone.
   */
  private async unrecordedProvisioningConfiguration(
    state: PlatformUnitOfWork,
    record: Readonly<AgentProvisioningRecord>,
  ): Promise<Readonly<{ id: string; namespaceId: string }> | undefined> {
    if (!this.provisioningBefore(record, "configuration") || record.configurationId !== undefined) {
      return undefined;
    }
    const receipt = readProvisioningEffectReceipt(record);
    const pending = provisioningPendingEffect(record);
    if (
      receipt?.kind !== "configuration" ||
      pending?.kind !== "configuration" ||
      pending.owner !== receipt.owner ||
      pending.targetId !== receipt.targetId ||
      !this.provisioningConfigurationDriverSelected(record)
    ) {
      return undefined;
    }
    if (
      (await state.configurations.findConfiguration(record.namespaceId, receipt.targetId)) !==
      undefined
    ) {
      return undefined;
    }
    return Object.freeze({ id: receipt.targetId, namespaceId: record.namespaceId });
  }

  /** Whether the accepted plan names the Configuration Driver the Installation selects. */
  private provisioningConfigurationDriverSelected(
    record: Readonly<AgentProvisioningRecord>,
  ): boolean {
    return (
      this.selections.has("configuration") &&
      asRecord(record.plan.drivers)?.configuration === this.configurationDriver().id
    );
  }

  /**
   * The Configuration an earlier refusal of this job marked for deletion but did not finish
   * deleting: its delete failed, or the worker lost its claim first (finding 1399). A
   * Configuration record with the ID, or a Driver the accepted plan no longer names, leaves it
   * alone.
   */
  private async markedProvisioningConfiguration(
    state: PlatformReadView,
    record: Readonly<AgentProvisioningRecord>,
  ): Promise<Configuration | undefined> {
    const configurationId = unrecordedProvisioningConfiguration(record.progress);
    if (
      configurationId === undefined ||
      !this.provisioningConfigurationDriverSelected(record) ||
      (await state.configurations.findConfiguration(record.namespaceId, configurationId)) !==
        undefined
    ) {
      return undefined;
    }
    return this.provisioningConfiguration(record, configurationId);
  }

  /**
   * Deletes a Configuration the job wrote but never recorded, through the Driver call
   * Configuration deletion uses. Nothing references it: the job forgot it when it marked it, and
   * its ID is unique to the job. It is inspected first, so a document already gone (an applied
   * delete whose response was lost) is not an error.
   */
  private async removeUnrecordedProvisioningConfiguration(
    configuration: Configuration,
  ): Promise<void> {
    const driver = this.configurationDriver();
    if (driver.inspectExact === undefined) {
      throw new DependencyUnavailableError(
        "The Configuration Driver does not support exact provisioning recovery.",
      );
    }
    if ((await this.driverOperation(() => driver.inspectExact!(configuration))) !== undefined) {
      await this.driverOperation(() =>
        driver.delete({ id: configuration.id, namespaceId: configuration.namespaceId }),
      );
    }
  }

  /**
   * A refusal's delete of its unrecorded or marked Configuration, once the mark has committed.
   * A failed delete keeps the refusal as it is, leaves the mark, and returns the ID for the
   * operator log.
   */
  private async deleteUnrecordedProvisioningConfiguration(
    configuration: Configuration,
  ): Promise<string | undefined> {
    try {
      await this.removeUnrecordedProvisioningConfiguration(configuration);
      return undefined;
    } catch {
      return configuration.id;
    }
  }

  /**
   * Deletes the marked Configuration after this attempt's first fence and before it writes
   * another, so the mark is never dropped with the document still stored. A failed delete fails
   * the attempt and keeps the mark. Returns whether the job had a mark to drop.
   */
  private async deleteMarkedProvisioningConfiguration(
    record: Readonly<AgentProvisioningRecord>,
    runEffect: <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<T>,
  ): Promise<boolean> {
    if (unrecordedProvisioningConfiguration(record.progress) === undefined) {
      return false;
    }
    if (!this.provisioningConfigurationDriverSelected(record)) {
      // The fence refuses this first; never let a new write replace the mark.
      throw new DependencyUnavailableError("The selected Configuration Driver is unavailable.");
    }
    const marked = await this.read((state) => this.markedProvisioningConfiguration(state, record));
    if (marked !== undefined) {
      await runEffect(() => this.removeUnrecordedProvisioningConfiguration(marked));
    }
    return true;
  }

  /** The Configuration that provisioning writes through the Configuration Driver. */
  private provisioningConfiguration(
    record: Readonly<AgentProvisioningRecord>,
    configurationId: string,
  ): Configuration {
    const plan = this.provisioningPlan(record);
    return {
      id: configurationId,
      namespaceId: record.namespaceId,
      kind: "agent",
      generation: 1,
      values: plan.configuration.values,
      ...(plan.configuration.secretBindings === undefined
        ? {}
        : { secretBindings: plan.configuration.secretBindings }),
      createdAt: record.createdAt.toISOString(),
    };
  }

  /**
   * Settles the external write that an earlier attempt dispatched but did not record, by
   * inspecting its exact target, before this attempt's first fence. A fence that then refuses
   * the work for good (plugin policy, native worker support, Secret Driver ownership, a
   * lifecycle or authority change) fails it as rejected with its own message, instead of
   * retrying it as PROVISIONING_OUTCOME_UNKNOWN until attempts run out. A settled effect also
   * stops holding the Namespace, which waits for unsettled ones before it can be deleted.
   *
   * Inspecting before the fence is safe: the earlier attempt dispatched the write only after its
   * own fence passed; this reads only the target it recorded, through the Driver the accepted
   * plan names (another selected Driver is left to the fence, which then retries the work); and
   * settling records what it observed for that exact pending kind, owner and target (a pending
   * effect replaced meanwhile settles nothing), as Agent deletion does for cancelled work.
   * Nothing is written outside OCC before the fence. A write it cannot observe stays pending for
   * the fenced step: a transport write retries, and a Configuration create may be resent after
   * its settle window. Other work, and work whose effect is already settled, is unchanged.
   */
  private async reconcileProvisioningEffect(
    record: Readonly<AgentProvisioningRecord>,
    runEffect: <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<T>,
  ): Promise<Readonly<AgentProvisioningRecord>> {
    const pending = provisioningPendingEffect(record);
    if (
      pending === undefined ||
      !this.provisioningPendingEffectMatches(record, pending) ||
      this.provisioningEffectReceipt(record, pending) !== undefined
    ) {
      return record;
    }
    const drivers = asRecord(record.plan.drivers);
    if (pending.kind === "configuration") {
      const driver = this.configurationDriver();
      if (drivers?.configuration !== driver.id) {
        return record;
      }
      // An absent write is left to the fenced Configuration step, which may resend it.
      return (
        (await this.inspectProvisioningConfigurationEffect(
          record.workId,
          record,
          { kind: "configuration", targetId: pending.targetId },
          this.provisioningConfiguration(record, pending.targetId),
          driver,
          runEffect,
        )) ?? record
      );
    }
    const driver = this.runtimeCredentialComputeDriver("provision");
    if (drivers?.compute !== driver.id) {
      return record;
    }
    const { namespace, agent } = await this.read(async (state) => {
      const namespace = await state.namespaces.findNamespace(record.namespaceId);
      return {
        namespace,
        agent:
          namespace === undefined
            ? undefined
            : await state.agents.findAgent(namespace.id, pending.targetId),
      };
    });
    if (namespace === undefined || agent === undefined) {
      return record;
    }
    return this.inspectProvisioningTransportEffect(
      record.workId,
      record,
      { kind: "transport", targetId: pending.targetId },
      namespace,
      agent,
      driver,
      runEffect,
    );
  }

  private async processAgentProvisioningConfiguration(
    claim: ClaimedWork,
    record: Readonly<AgentProvisioningRecord>,
    runEffect: <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<T>,
  ): Promise<Readonly<AgentProvisioningRecord>> {
    const plan = this.provisioningPlan(record);
    const pending = provisioningPendingEffect(record);
    const receipt = readProvisioningEffectReceipt(record);
    const configurationId =
      record.configurationId ??
      (receipt?.kind === "configuration" ? receipt.targetId : undefined) ??
      (pending?.kind === "configuration" ? pending.targetId : undefined) ??
      this.nextIdentifier("configuration");
    const configuration = this.provisioningConfiguration(record, configurationId);
    const driver = this.configurationDriver();
    if (driver.createExact === undefined || driver.inspectExact === undefined) {
      throw new DependencyUnavailableError(
        "The Configuration Driver does not support exact provisioning recovery.",
      );
    }
    const effect = { kind: "configuration" as const, targetId: configurationId };
    let current = record;
    if (this.provisioningEffectReceipt(current, effect) === undefined) {
      const metadata = await this.read((state) =>
        state.configurations.findConfiguration(record.namespaceId, configurationId),
      );
      if (metadata === undefined) {
        if (this.provisioningPendingEffectMatches(current, effect)) {
          current =
            (await this.inspectProvisioningConfigurationEffect(
              claim.idempotencyKey,
              current,
              effect,
              configuration,
              driver,
              runEffect,
            )) ??
            (await this.resendProvisioningConfigurationEffect(
              claim,
              current,
              effect,
              configuration,
              driver,
              runEffect,
            ));
        } else {
          current = await this.beginProvisioningEffect(claim, effect);
          await runEffect(async () => {
            const created = await this.driverOperation(() => driver.createExact!(configuration));
            current = await this.settleProvisioningEffect(claim.idempotencyKey, current, effect);
            return created;
          });
        }
      }
    }

    return this.mutate(async (state) => {
      current = await this.fenceAgentProvisioning(state, claim);
      if (!this.provisioningBefore(current, "configuration")) {
        return current;
      }
      const namespace = await this.lockNamespace(state, current.namespaceId);
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      const planRecord = asRecord(current.plan);
      if (planRecord === undefined) {
        throw new ScopeViolationError("The provisioning plan is invalid.");
      }
      const name = planRecord?.name;
      if (!isName(name)) {
        throw new ScopeViolationError("The provisioning Agent name is invalid.");
      }
      if (plan.harnessAuth === null || plan.harnessAuth.method === "runtime") {
        throw new ScopeViolationError(
          "Agent provisioning requires dedicated Harness authentication.",
        );
      }
      const backendId = this.backendId(planRecord.backendId as BackendRef | undefined);
      const plugins = normalizeAgentPlugins(
        planRecord.plugins as Readonly<Record<string, PluginDesiredSelection>> | undefined,
      );
      const pluginApprovers = normalizeAgentPluginApprovers(
        planRecord.pluginApprovers as PluginApprovers | undefined,
      );
      const repositoryBindings = this.repositoryBindingSelections(
        namespace.id,
        planRecord.repositoryBindings as readonly RepositoryBindingRequest[] | undefined,
        "saved",
        this.installationRepositoryAdmission,
      );
      const repositoryAccess = normalizedRepositoryAccess(
        planRecord.repositoryAccess,
        repositoryBindings,
      );
      const workspace = normalizeProvisioningWorkspace(
        planRecord.initialWorkspaceFiles,
        planRecord.workspaceDefaultsId,
      );
      const existingMetadata = await state.configurations.lockConfiguration(
        namespace.id,
        configurationId,
      );
      let metadata = existingMetadata;
      if (metadata === undefined) {
        metadata = await state.configurations.createConfiguration({
          id: configurationId,
          namespaceId: namespace.id,
          kind: "agent",
          generation: configuration.generation,
          ...(plan.configuration.secretBindings === undefined
            ? {}
            : { secretBindings: plan.configuration.secretBindings }),
          createdAt: configuration.createdAt,
        });
        // The person who requested provisioning creates its resources and owns them.
        await this.bindCreator(state, record.actorId, {
          kind: "configuration",
          id: metadata.id,
          namespaceId: namespace.id,
        });
      }
      const agentId =
        current.agentId ??
        (isNonEmptyString(planRecord.reservedAgentId)
          ? planRecord.reservedAgentId
          : this.nextIdentifier("agent"));
      let agent = await state.agents.lockAgent(namespace.id, agentId);
      const createdAgent = agent === undefined;
      if (agent === undefined) {
        agent = await state.agents.createAgent({
          id: agentId,
          namespaceId: namespace.id,
          name,
          configurationId: metadata.id,
          backendId,
          harnessAuth: plan.harnessAuth,
          // Guided provisioning has one model source; store it in the canonical
          // list so the same binding and withdrawal invariants govern deployment.
          ...(plan.harnessAuth.method === "credential_source"
            ? { credentialSources: [{ sourceId: plan.harnessAuth.sourceId }] }
            : {}),
          executionMode: plan.executionMode,
          gatewayManagedMode: plan.gatewayManagedMode,
          ...(plugins === undefined ? {} : { plugins }),
          ...(validPluginDriverIdentity(planRecord.pluginDriver)
            ? { pluginDriver: planRecord.pluginDriver }
            : {}),
          ...(pluginApprovers === undefined ? {} : { pluginApprovers }),
          ...(repositoryBindings === undefined ? {} : { repositoryBindings }),
          ...(repositoryAccess === undefined ? {} : { repositoryAccess }),
          servicePrincipalId: `service-agent-${agentId}`,
          desiredRuntimeState: "stopped",
          status: "active",
          createdAt: this.timestamp(),
        });
        await this.bindCreator(state, record.actorId, {
          kind: "agent",
          id: agent.id,
          namespaceId: namespace.id,
        });
      }
      if (createdAgent && workspace.initialWorkspaceFiles !== undefined) {
        await state.workspaceSetups.create({
          id: crypto.randomUUID(),
          namespaceId: namespace.id,
          agentId,
          ...(workspace.workspaceDefaultsId === undefined
            ? {}
            : { defaultsId: workspace.workspaceDefaultsId }),
          files: workspace.initialWorkspaceFiles,
          completed: false,
        });
      }
      const grantSources = await this.provisioningGrantSources(state, namespace.id, {
        ...(plan.configuration.secretBindings === undefined
          ? {}
          : { secretBindings: plan.configuration.secretBindings }),
        harnessAuth: plan.harnessAuth,
      });
      await this.ensureAgentOperateGrants(state, namespace.id, agent, grantSources);
      return this.commitProvisioningCheckpoint(state, claim, {
        completedPhase: "configuration",
        status: "running",
        agentId,
        configurationId: metadata.id,
        progress: {},
      });
    });
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
    const compute = this.selections.get("compute")?.driver as ComputeDriver | undefined;
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

  private async provisioningGrantSources(
    state: PlatformUnitOfWork,
    namespaceId: string,
    input: {
      readonly secretBindings?: SecretBindings;
      readonly harnessAuth: HarnessAuthBinding | null;
    },
  ): Promise<readonly (SecretReference | CredentialSourceReference)[]> {
    const ids = new Set<string>();
    for (const binding of Object.values(input.secretBindings ?? {})) {
      ids.add(binding.source.id);
    }
    if (isSecretHarnessAuth(input.harnessAuth)) {
      ids.add(input.harnessAuth.source.id);
    }
    const sources: (SecretReference | CredentialSourceReference)[] = [];
    for (const id of ids) {
      const secret = await state.secrets.lockSecret(namespaceId, id);
      if (secret === undefined) {
        throw new ScopeViolationError("Agent provisioning Secret grant source is unavailable.");
      }
      sources.push({ kind: "secret", namespaceId, id: secret.id });
    }
    if (input.harnessAuth?.method === "credential_source") {
      const source = await state.credentialSources.lockCredentialSource(
        namespaceId,
        input.harnessAuth.sourceId,
      );
      if (source === undefined || source.state !== "ready") {
        throw new ScopeViolationError("Agent provisioning credential source is unavailable.");
      }
      sources.push({ kind: "credential_source", namespaceId, id: source.id });
    }
    return Object.freeze(sources);
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
      await this.harnessAuthOperations.authorizeHarnessAuthSource(
        state,
        principalId,
        namespaceId,
        harnessAuth,
      );
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

  private validateSecretValue(value: unknown): asserts value is string {
    const message =
      "The Secret value must be nonempty UTF-8, without NUL, and at most 65536 bytes.";
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.includes("\u0000") ||
      /[\uD800-\uDFFF]/u.test(value)
    ) {
      throw new SecretValueError("INVALID_VALUE", message);
    }
    if (Buffer.byteLength(value, "utf8") > 65_536) {
      throw new SecretValueError("TOO_LONG", message);
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

  private secretMetadata(secret: Secret): Readonly<SecretMetadata> {
    return immutableCopy({
      id: secret.id,
      namespaceId: secret.namespaceId,
      name: secret.name,
      ref: { kind: "secret", namespaceId: secret.namespaceId, id: secret.id },
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
    if (!this.selections.has("credential_refresh")) {
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
      !this.selections.has("credential_proxy") ||
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
      !this.selections.has("credential_gateway")
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
    if (!this.selections.has("credential_proxy")) {
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
    if (!this.selections.has("credential_proxy")) {
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

  private diagnosticsComputeDriver(): ComputeDriver {
    let driver: ComputeDriver;
    try {
      driver = this.selectedDriver("compute");
    } catch {
      throw new DependencyUnavailableError("The selected compute Driver is unavailable.");
    }
    if (typeof driver.diagnoseAgentDeployment !== "function") {
      throw new DependencyUnavailableError(
        "The selected compute Driver does not support runtime diagnostics.",
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
    let driver: IAMDriver;
    try {
      driver = this.selectedDriver("iam");
    } catch {
      throw new DependencyUnavailableError("The selected IAM Driver is unavailable.");
    }
    if (typeof driver[method] !== "function") {
      throw new DependencyUnavailableError(
        "The selected IAM Driver does not support Namespace policy management.",
      );
    }
    return driver;
  }

  private async iamPolicyOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ResourceConflictError || error instanceof ScopeViolationError) {
        throw error;
      }
      throw new DependencyUnavailableError(
        "The IAM policy operation failed or its outcome is unknown.",
      );
    }
  }

  private async admitIAMPolicyOperation(
    principalId: string,
    namespaceId: string,
  ): Promise<Readonly<Namespace>> {
    if (!isNonEmptyString(namespaceId)) {
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    }
    await this.authorize(principalId, "administer", {
      kind: "installation",
      id: this.installation.id,
    });
    await this.authorize(principalId, "read", {
      kind: "namespace",
      id: namespaceId,
      namespaceId,
    });
    return this.read((state) => this.exactNamespace(state, namespaceId));
  }

  /**
   * Re-checks the admitted actor inside the policy write's transaction and holds that
   * authority until COMMIT. The shared IAM configuration fence comes before the Namespace
   * lock, so a configured read grant cannot change between authorization and COMMIT. The
   * Namespace lock orders this write with other policy writes and deletion there; the
   * account hold does the same for a disable. The actor's Installation
   * grants have no runtime writer that removes them.
   */
  private async holdIAMPolicyAuthority(
    state: PlatformUnitOfWork,
    principalId: string,
    namespaceId: string,
    target?: ResourceRef,
  ): Promise<void> {
    await this.holdAuthority(state);
    await this.lockNamespace(state, namespaceId);
    await this.holdNamespacePolicyActor(state, principalId);
    await this.authorize(principalId, "administer", {
      kind: "installation",
      id: this.installation.id,
    });
    await this.authorize(principalId, "read", { kind: "namespace", id: namespaceId, namespaceId });
    if (target !== undefined) {
      await this.authorize(principalId, "read", target);
    }
  }

  /** Called with the policy writer's Namespace lock; hold the acting account through commit. */
  private async holdNamespacePolicyActor(
    state: PlatformUnitOfWork,
    principalId: string,
  ): Promise<void> {
    if (this.selectedDriver("iam").namespacePolicyTransaction !== "platform-unit-of-work") {
      throw new DependencyUnavailableError(
        "Namespace policy mutations require transactional IAM Driver support.",
      );
    }
    if (!(await state.installations.holdPrincipalAccount(principalId))) {
      throw new CallerStateDeniedError("The acting account is disabled.");
    }
  }

  private assertNamespacePolicyResourceKind(kind: ResourceKind): void {
    if (!NAMESPACE_POLICY_RESOURCE_KINDS.has(kind)) {
      throw new IAMPolicyValidationError(
        "/resourceKind",
        "IAM policy APIs require an exact Namespace resource target.",
      );
    }
  }

  private iamRolePermissions(permissions: readonly Permission[]): readonly Permission[] {
    if (!Array.isArray(permissions) || permissions.length === 0 || permissions.length > 64) {
      throw new IAMPolicyValidationError(
        "/permissions",
        "IAM Roles require 1 to 64 supported Permissions.",
      );
    }
    const seen = new Set<string>();
    const unsupported: string[] = [];
    const checked = permissions.map((permission, index) => {
      if (
        typeof permission !== "object" ||
        permission === null ||
        Array.isArray(permission) ||
        !PERMISSION_ACTIONS.includes(permission.action) ||
        !RESOURCE_KINDS.includes(permission.resourceKind)
      ) {
        throw new IAMPolicyValidationError(
          `/permissions/${index}`,
          "IAM Role Permissions are invalid.",
        );
      }
      if (!NAMESPACE_POLICY_RESOURCE_KINDS.has(permission.resourceKind)) {
        throw new IAMPolicyValidationError(
          `/permissions/${index}/resourceKind`,
          `Namespace IAM Roles cannot grant ${permission.resourceKind} Permissions.`,
        );
      }
      if (permission.resourceKind === "namespace" && permission.action !== "read") {
        throw new IAMPolicyValidationError(
          `/permissions/${index}/action`,
          "Namespace IAM Roles support only namespace:read on the Namespace itself.",
        );
      }
      const key = `${permission.action}\u0000${permission.resourceKind}`;
      if (seen.has(key)) {
        throw new IAMPolicyValidationError(
          `/permissions/${index}`,
          `IAM Role Permissions contain ${permission.resourceKind}:${permission.action} more than once.`,
        );
      }
      seen.add(key);
      if (!isSupportedPermission(permission)) {
        unsupported.push(`${permission.resourceKind}:${permission.action}`);
      }
      return Object.freeze({
        action: permission.action,
        resourceKind: permission.resourceKind,
      });
    });
    if (unsupported.length > 0) {
      throw new IAMPolicyValidationError(
        "/permissions",
        unsupportedPermissionsMessage(unsupported),
      );
    }
    // A create Permission would be stored and then refused by every binding request
    // (assertAccessBindingRoleApplies), so the Role is refused here instead.
    const firstCreate = checked.findIndex((permission) => permission.action === "create");
    if (firstCreate !== -1) {
      throw new IAMPolicyValidationError(
        `/permissions/${firstCreate}/action`,
        fittedList(
          "Namespace IAM Roles cannot grant create Permissions: ",
          checked
            .filter((permission) => permission.action === "create")
            .map((permission) => `${permission.resourceKind}:create`),
          `. ${NAMESPACE_POLICY_CREATE_REASON}; omit them from the Role.`,
        ),
      );
    }
    return Object.freeze(checked);
  }

  private async verifyNamespacePolicyResource(
    namespaceId: string,
    resourceKind: ResourceKind,
    resourceId: string,
  ): Promise<void> {
    await this.read(async (state) => {
      if (resourceKind === "namespace") {
        if (resourceId !== namespaceId) {
          throw new IAMPolicyValidationError(
            "/resourceId",
            "A namespace target must be the Namespace in the request path.",
          );
        }
        await this.exactNamespace(state, namespaceId);
        return;
      }
      if (resourceKind === "agent") {
        if ((await state.agents.findAgent(namespaceId, resourceId)) === undefined) {
          throw new IAMPolicyValidationError(
            "/resourceId",
            "The IAM target Agent does not belong to the Namespace.",
          );
        }
        return;
      }
      if (resourceKind === "sandbox_policy") {
        const agentId = `agt_${resourceId.slice(4)}`;
        const policy = await state.sandboxPolicies.find(namespaceId, agentId);
        if (policy?.id !== resourceId) {
          throw new IAMPolicyValidationError(
            "/resourceId",
            "The SandboxPolicy does not belong to the Namespace.",
          );
        }
        return;
      }
      if (resourceKind === "agent_revision") {
        const agents = await state.agents.listAgents(namespaceId);
        for (const agent of agents) {
          if (
            (await state.revisions.findRevision(namespaceId, agent.id, resourceId)) !== undefined
          ) {
            return;
          }
        }
        throw new IAMPolicyValidationError(
          "/resourceId",
          "The IAM target AgentRevision does not belong to the Namespace.",
        );
      }
      if (resourceKind === "preset") {
        if ((await state.presets.findPreset(namespaceId, resourceId)) === undefined) {
          throw new IAMPolicyValidationError(
            "/resourceId",
            "The IAM target Preset does not belong to the Namespace.",
          );
        }
        return;
      }
      if (resourceKind === "configuration") {
        if ((await state.configurations.findConfiguration(namespaceId, resourceId)) === undefined) {
          throw new IAMPolicyValidationError(
            "/resourceId",
            "The IAM target Configuration does not belong to the Namespace.",
          );
        }
        return;
      }
      if (resourceKind === "secret") {
        if ((await state.secrets.findSecret(namespaceId, resourceId)) === undefined) {
          throw new IAMPolicyValidationError(
            "/resourceId",
            "The IAM target Secret does not belong to the Namespace.",
          );
        }
        return;
      }
      if (resourceKind === "credential_source") {
        if (
          (await state.credentialSources.findCredentialSource(namespaceId, resourceId)) ===
          undefined
        ) {
          throw new IAMPolicyValidationError(
            "/resourceId",
            "The IAM target credential source does not belong to the Namespace.",
          );
        }
        return;
      }
      if ((await state.serviceAccounts.findServiceAccount(namespaceId, resourceId)) === undefined) {
        throw new IAMPolicyValidationError(
          "/resourceId",
          "The IAM target ServiceAccount does not belong to the Namespace.",
        );
      }
    });
  }

  /** Secret SDK error bodies can contain request bytes; never propagate their message or cause. */
  private async secretOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ResourceConflictError) {
        throw new ResourceConflictError(
          "The Secret backend identity or concurrency precondition conflicts.",
        );
      }
      if (error instanceof ScopeViolationError) {
        throw new ScopeViolationError("The Secret backend ownership could not be verified.");
      }
      throw new DependencyUnavailableError(
        "The Secret storage operation failed or its outcome is unknown.",
      );
    }
  }

  private configurationIdentity(namespaceId: string, configurationId: string): void {
    this.namespaceIdentity(namespaceId);
    if (!isNonEmptyString(configurationId)) {
      throw new ScopeViolationError("The exact Configuration identity is missing.");
    }
  }

  private namespaceIdentity(namespaceId: string): void {
    namespaceIdentity(namespaceId);
  }

  private serviceAccountIdentity(namespaceId: string, serviceAccountId: string): void {
    this.namespaceIdentity(namespaceId);
    if (!isNonEmptyString(serviceAccountId)) {
      throw new ScopeViolationError("The exact ServiceAccount identity is missing.");
    }
  }

  private async exactServiceAccount(
    state: PlatformReadView,
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<Readonly<ServiceAccount>> {
    const account = await state.serviceAccounts.findServiceAccount(namespaceId, serviceAccountId);
    if (account === undefined) {
      throw new ScopeViolationError("The ServiceAccount does not belong to the exact Namespace.");
    }
    return account;
  }

  private configurationDriver(): ConfigurationDriver {
    try {
      return this.selectedDriver("configuration");
    } catch {
      throw new DependencyUnavailableError("The selected Configuration Driver is unavailable.");
    }
  }

  private serviceAccountDriver(): ServiceAccountDriver | undefined {
    if (!this.selections.has("service_account")) {
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
    if (!this.selections.has("sandbox")) {
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
      sandbox: this.selections.get("sandbox")?.implementation,
      gateway: this.selections.get("credential_gateway")?.implementation,
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

  // The Configuration an Agent save names, read from the Configuration Driver at most once and
  // only when a check needs its values.
  private savedConfigurationReader(
    metadata: Pick<
      Configuration,
      "id" | "namespaceId" | "kind" | "generation" | "createdAt" | "secretBindings"
    >,
  ): () => Promise<Readonly<Configuration>> {
    let read: Promise<Readonly<Configuration>> | undefined;
    return () => {
      read ??= (async () => {
        const driver = this.configurationDriver();
        return this.exactConfiguration(
          await this.driverOperation(() =>
            driver.read({ id: metadata.id, namespaceId: metadata.namespaceId }),
          ),
          metadata,
        );
      })();
      return read;
    };
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
    return capability === "plugin"
      ? this.pluginRegistrations.some((entry) => entry.id === id)
      : this.selections.get(capability)?.id === id;
  }

  private enabledPluginDrivers(): readonly PluginDriver[] {
    return this.pluginRegistrations.map((entry) => {
      if (!this.unchangedDriver(entry)) {
        throw new DependencyUnavailableError("A configured Plugin Driver is unavailable.");
      }
      return entry.driver as PluginDriver;
    });
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
      this.installationRepositoryAdmission?.policyMode === "built-in" || this.selections.has("repo")
    );
  }

  private repositoryPermissionOwner(admission: InstallationRepositoryAdmission | undefined) {
    if (admission?.policyMode === "built-in") {
      const identity = this.builtInRepositoryDriver;
      if (
        identity === undefined ||
        identity.driver !== admission.policy ||
        !this.unchangedDriver(identity)
      ) {
        return undefined;
      }
      return {
        driver: admission.policy,
        admission,
        unchanged: () => this.unchangedDriver(identity),
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
        const selected = this.selections.get("repo");
        return selected?.driver === driver && this.unchangedDriver(selected);
      },
    };
  }

  private selectedStandingRepositoryAdmission(): InstallationRepositoryAdmission | undefined {
    const admission = this.installationRepositoryAdmission;
    return admission?.policyMode === "built-in" ||
      admission?.policy === this.selections.get("repo")?.driver
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

  /**
   * Compensations run after the failed transaction's ROLLBACK released its row locks, so another
   * request may have deleted or updated the Configuration in between (finding 945). A
   * compensation restores the previous document only while the record is still the one the
   * failed request locked; otherwise that later write owns the backend state. A state read that
   * fails counts as unchanged: the failure is usually the same outage that failed the request,
   * when no other request can commit either, and skipping would leave the metadata without its
   * ConfigMap (finding 916).
   */
  private async configurationRecordUnchanged(
    expected: Pick<Configuration, "id" | "namespaceId" | "generation" | "createdAt">,
  ): Promise<boolean> {
    const current = await this.read((state) =>
      state.configurations.findConfiguration(expected.namespaceId, expected.id),
    ).catch(() => "unreadable" as const);
    if (current === "unreadable") {
      return true;
    }
    return (
      current !== undefined &&
      current.generation === expected.generation &&
      current.createdAt === expected.createdAt
    );
  }

  /**
   * The stored Configuration behind a record that update or delete holds locked. A failed update
   * whose compensation could not run (a crash, a lost COMMIT acknowledgement that hid a rollback,
   * or a compensation read that failed in the same outage) leaves the stored document one
   * generation ahead of the record, and each such failure during recovery one more (finding
   * 1396). The record lock keeps other requests out, so a document up to
   * MAX_CONFIGURATION_LEFTOVER_LEAD generations ahead is a leftover, not a write in flight; it is
   * returned at its own generation, for update to replace and delete to remove. Another
   * request's compensation runs without the lock, but the Kubernetes Driver refuses a replace
   * that does not move the generation by exactly one from the document it read, or whose
   * resource version changed since, so the later of two writes fails and rolls back. Reads and
   * deploys keep refusing the leftover, so unrecorded content is never served or recorded.
   */
  private async lockedConfiguration(
    driver: ConfigurationDriver,
    record: Pick<
      Configuration,
      "id" | "namespaceId" | "kind" | "generation" | "createdAt" | "secretBindings"
    >,
  ): Promise<Readonly<Configuration>> {
    const stored = await this.driverOperation(() =>
      driver.read({ id: record.id, namespaceId: record.namespaceId }),
    );
    const lead = Number.isSafeInteger(stored?.generation)
      ? stored.generation - record.generation
      : 0;
    return this.exactConfiguration(
      stored,
      lead > 0 && lead <= MAX_CONFIGURATION_LEFTOVER_LEAD
        ? { ...record, generation: stored.generation }
        : record,
    );
  }

  /**
   * Whether the Driver confirms that nothing is stored for a record: a failed delete whose
   * compensation could not run leaves the record without its document (finding 1396). Only exact
   * inspection tells absence from an unreachable backend: it answers undefined only when nothing
   * is stored, and any stored document answers or conflicts with the placeholder values. A Driver
   * without it, or one that fails, does not confirm absence.
   */
  private async configurationAbsent(
    driver: ConfigurationDriver,
    record: Pick<Configuration, "id" | "namespaceId" | "kind" | "generation" | "createdAt">,
  ): Promise<boolean> {
    if (driver.inspectExact === undefined) {
      return false;
    }
    const placeholder: Configuration = {
      id: record.id,
      namespaceId: record.namespaceId,
      kind: record.kind,
      generation: record.generation,
      values: {},
      createdAt: record.createdAt,
    };
    try {
      return (await driver.inspectExact(placeholder)) === undefined;
    } catch {
      return false;
    }
  }

  private exactConfiguration(
    configuration: Configuration,
    expected: Pick<
      Configuration,
      "id" | "namespaceId" | "kind" | "generation" | "createdAt" | "secretBindings"
    >,
  ): Readonly<Configuration> {
    if (
      !configuration ||
      configuration.id !== expected.id ||
      configuration.namespaceId !== expected.namespaceId ||
      configuration.kind !== expected.kind ||
      configuration.generation !== expected.generation ||
      configuration.createdAt !== expected.createdAt
    ) {
      throw new DependencyUnavailableError(
        "The Configuration Driver returned a resource outside its exact ownership scope.",
      );
    }
    return Object.freeze({
      id: expected.id,
      namespaceId: expected.namespaceId,
      kind: expected.kind,
      generation: expected.generation,
      values: freezeConfigurationValues(configuration.values),
      ...(expected.secretBindings === undefined
        ? {}
        : { secretBindings: this.bindings(expected.secretBindings) }),
      createdAt: expected.createdAt,
    });
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

  private driverKey(selectedCapability: DriverCapability, driverId: string): string {
    return `${selectedCapability}\u0000${driverId}`;
  }

  private backendId(value: BackendRef | undefined, preserve?: BackendRef): BackendRef {
    const backendId = value === undefined ? (preserve ?? null) : value;
    const backend = assertConfiguredBackend(this.backendMap, backendId, "Backend");
    if (backend !== undefined && backend.type !== "chatgpt") {
      throw new ScopeViolationError("The Agent Backend must support its Harness association.");
    }
    return backendId;
  }

  private applyDriverSelection<Capability extends DriverCapability>(
    selectedCapability: Capability,
    selected: RegisteredDriver,
  ): DriverFor<Capability> {
    const proposed = new Map(this.selections);
    proposed.set(selectedCapability, selected);
    this.applyLifecycleDrivers(proposed, this.pluginRegistrations);
    this.selections.set(selectedCapability, selected);
    return selected.driver as DriverFor<Capability>;
  }

  private applyLifecycleDrivers(
    proposed: ReadonlyMap<DriverCapability, RegisteredDriver>,
    plugins: readonly RegisteredDriver[],
  ): void {
    const namespaceParticipants = selectedNamespaceLifecycle(
      [...proposed.values(), ...plugins].map((entry) => entry.owner ?? entry.driver),
      this.namespaceLifecycleBindings,
    );
    const lifecycleDrivers = this.lifecycleDrivers(proposed, plugins);
    const compute = proposed.get("compute");
    if (compute !== undefined) {
      if (!this.unchangedDriver(compute)) {
        throw new DriverSelectionError("The selected compute Driver identity has changed.");
      }
      const selectedCompute = compute.driver as ComputeDriver;
      if (
        namespaceParticipants.some(({ hooks }) => hooks.deleteNamespace !== undefined) &&
        typeof selectedCompute.checkNamespaceDeletion !== "function"
      ) {
        throw new DriverSelectionError(
          "Namespace cleanup requires Compute deletion eligibility checks.",
        );
      }
      if (typeof selectedCompute.setLifecycleDrivers === "function") {
        selectedCompute.setLifecycleDrivers(lifecycleDrivers);
      } else if (lifecycleDrivers.length > 0) {
        throw new DriverSelectionError(
          "The selected compute Driver cannot accept selected lifecycle Drivers.",
        );
      }
    }
  }

  private lifecycleDrivers(
    selections: ReadonlyMap<DriverCapability, RegisteredDriver>,
    plugins: readonly RegisteredDriver[],
  ): readonly Driver[] {
    const drivers = new Set<Driver>();
    for (const selected of [...selections.values(), ...plugins]) {
      if (selected.capability === "compute") {
        continue;
      }
      if (!this.unchangedDriver(selected)) {
        throw new DriverSelectionError(
          "A selected lifecycle Driver no longer matches its registered identity.",
        );
      }
      const lifecycle = selected.owner ? selected.owner.lifecycleDriver : selected.driver;
      if (lifecycle?.computeLifecycleHooks !== undefined) {
        drivers.add(lifecycle);
      }
    }
    return Object.freeze([...drivers]);
  }

  private unchangedDriver(selected: RegisteredDriver): boolean {
    return (
      (!selected.owner || selected.owner.require(selected.capability) === selected.driver) &&
      selected.driver.id === selected.id &&
      selected.driver.capability === selected.capability &&
      selected.driver.implementation === selected.implementation &&
      (selected.capability !== "plugin" ||
        (selected.driver as PluginDriver).harnessId === selected.harnessId) &&
      driverHasCapabilityContract(selected.driver)
    );
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

function configuredRoleId(id: string): string {
  return `${CONFIGURED_IAM_ID_PREFIXES.role}${id}`;
}

function configuredGroupId(name: string): string {
  return `${CONFIGURED_IAM_ID_PREFIXES.group}${name}`;
}

/** A configured Group binding's ID: a digest, because configured names may contain `_`. */
function configuredBindingId(group: string, role: string, namespaceId: string | undefined): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([group, role, namespaceId ?? null]))
    .digest("hex")
    .slice(0, 32);
  return `${CONFIGURED_IAM_ID_PREFIXES.binding}${digest}`;
}

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
