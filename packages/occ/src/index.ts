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
  validateRepositoryBrokerNetworkProxy,
} from "./repository-policy.ts";

export {
  postgresPreparedGitHubProof,
  preparedGitHubLive,
  preparedGitHubRejectedMaterialMatch,
  readPreparedGitHubMetadata,
} from "./state/prepared-github-state.ts";
export type { PreparedGitHubMetadataAdmission } from "./state/prepared-github-state.ts";

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
import type { TokenService, EgressRef } from "@openclaw-enterprise/contracts";
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
import { AgentRuntimeCredentials, runtimeCredentialsInput } from "./agent-runtime-credentials.ts";
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
  SandboxPolicyRecommendations,
} from "@openclaw-enterprise/contracts";
import { validateSandboxNetworkGrants } from "@openclaw-enterprise/contracts";
import { createSandboxPolicyOperations } from "./sandbox-policy.ts";
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
  ConfigurationValidationOptions,
  CredentialGatewayDriver,
  SavedConnection,
  OAuthRefreshTokenRegistration,
  OAuthAccountRef,
  OAuthConnectionClient,
  OAuthClient,
  ConnectionTemplate,
  CredentialSourceReference,
  SourceRegistrationInput,
  SourceProviderPresetId,
  CredentialSourceMetadata,
  CredentialSourceStatus,
  CredentialWithdrawalStatus,
  AuditEvent,
  Driver,
  DriverCapability,
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
  PluginCatalogEntry,
  PluginCatalogPage,
  PluginDriver,
  ChannelDirectoryResult,
  BackendDefinition,
  RepositoryOptions,
  RevisionHarnessDescriptor,
  ResourceKind,
  ResourceRef,
  Role,
  SandboxDriver,
  SecretBindings,
  SecretDetail,
  SecretMetadata,
  ServiceAccount,
  ServiceAccountCredential,
  ServicePrincipal,
} from "@openclaw-enterprise/contracts";
import { isName, NAME_RULE, normalizeLoggingLevel } from "@openclaw-enterprise/contracts";
import { immutableCopy, isNonEmptyString } from "@openclaw-enterprise/utils";

import type { ClaimedWork } from "./controller-work.ts";
import {
  createAgentQueries,
  type AgentRevisionListPage,
  type ActiveAgentRevisionSelection,
} from "./agent-queries.ts";
import { createDeploymentChannelChecks } from "./deployment-channels.ts";
import { createAgentDeploymentAdmission } from "./agent-deployment-admission.ts";
import { createDeploymentRequests } from "./agent-deployment-requests.ts";
import type {
  AuthorizedAgentDeployment,
  DeployAgentInput,
  FirstDeploymentIntent,
} from "./deployment-authorization.ts";

export type {
  AuthorizedAgentDeployment,
  DeployAgentInput,
  FirstDeploymentIntent,
} from "./deployment-authorization.ts";
import {
  createAgentDraftOperations,
  type AgentConfigurationPreparation,
  type CreateAgentInput,
  type UpdateAgentInput,
  type ValidateAgentCreateInput,
} from "./agent-drafts.ts";
import {
  createAgentPluginValidation,
  normalizeAgentPluginApprovers,
  pluginOwner,
  validatePluginCredentialSources,
} from "./agent-plugin-validation.ts";

export type {
  CreateAgentInput,
  UpdateAgentInput,
  ValidateAgentCreateInput,
} from "./agent-drafts.ts";
import { DriverRegistry, type DriverFor } from "./driver-registry.ts";
import { driverOperation } from "./driver-operation.ts";
import { readDeploymentInventory } from "./deployment-inventory.ts";
import { SetupDiscovery, type LookupChannelDirectoryInput } from "./setup-discovery.ts";
import { createInstallationCapabilityQueries } from "./installation-capabilities.ts";
import {
  AgentDeletingError,
  DependencyUnavailableError,
  ConfigurationHarnessError,
  configurationSettingMessage,
  NamespaceNotReadyError,
  NotImplementedError,
  ResourceStateConflictError,
  ScopeViolationError,
  PostgresCommitOutcomeUnknownError,
} from "./errors.ts";
import {
  createAgentCredentialWithdrawal,
  type AgentCredentialSourceInput,
} from "./agent-credential-withdrawal.ts";
import { createAgentTermination } from "./agent-termination.ts";
import { enabledChannelEntries, requireChannelSecretBindings } from "./channel-secret-bindings.ts";
import {
  admitsOpenClawExecutionMode,
  agentRuntimeConfiguration,
  createModelPolicyAgent,
  createSavedAgentTopologyValidator,
  type HarnessResolver,
} from "./agent-harness-topology.ts";
import { createHarnessAuthOperations } from "./harness-auth.ts";

export type { HarnessResolver } from "./agent-harness-topology.ts";
export type { PlannedSecretHarnessAuth } from "./harness-auth.ts";
import type { RuntimeLogPage, RuntimeLogQuery } from "./runtime-logs/index.ts";
import {
  nativeWorkerSupportSource,
  type NativeWorkerSupport,
  type NativeWorkerSupportSource,
} from "./native-worker-support.ts";
import {
  backendDefinitionMap,
  resolveAgentBackendId,
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
  createAgentCredentialAccess,
  type AgentCredentialAccess,
} from "./agent-credential-access.ts";
import { exactNamespace, lockNamespace, namespaceIdentity } from "./resource-scope.ts";

export type {
  AuthorityFence,
  AuthorizationSnapshot as DeployAgentAuthorization,
} from "./controller-authority.ts";
import { InMemoryPlatformState } from "./state/platform-state.ts";

import type { PlatformOperation } from "./ports/platform-operations.ts";
import type { PlatformStateStore } from "./ports/platform-state-store.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";
import type { DeploymentStatusResult } from "./controller-work.ts";
import { type ProvisionAgentInput, type ProvisionAgentResult } from "./agent-provisioning.ts";

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

export type { FirstDeploymentReceipt } from "@openclaw-enterprise/contracts";

export type ReconciliationOperation = PlatformOperation;

// The bundled Kubernetes Compute Driver's implementations: the Installation default and the
// Driver's own default.
const BUNDLED_KUBERNETES_COMPUTE: ReadonlySet<string> = new Set([
  "occ/kubernetes",
  "kubernetes-local",
]);
/** Only a claimed server-side consent attempt may operate on its still-pending source. */
const PENDING_CONNECTION: unique symbol = Symbol("pending-connection");

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
  private readonly modelPolicyAgent: ReturnType<typeof createModelPolicyAgent>;
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
  private readonly deploymentChannels: ReturnType<typeof createDeploymentChannelChecks>;
  private readonly deploymentRequests: ReturnType<typeof createDeploymentRequests>;
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
      timestamp: this.resourceValues.timestamp,
    });
    this.secretOperations = createSecretOperations(this.installation.id, {
      transactions: this.transactions,
      authority: this.authority,
      bindCreator: this.iamPolicy.bindCreator,
      getNamespace: (principalId, namespaceId) => this.getNamespace(principalId, namespaceId),
      lockNamespaceForPolicyDelete: this.iamPolicy.lockNamespaceForPolicyDelete,
      selectDriver: () => this.selectedDriver("secret"),
      nextIdentifier: this.resourceValues.nextIdentifier,
      timestamp: this.resourceValues.timestamp,
      registerRollback: (compensate) => this.registerRollback(compensate),
    });
    this.egressAdmission = createCredentialEgressAdmission({
      installationId: () => this.installation.id,
      authorize: (principalId, action, resource) =>
        this.authority.authorize(principalId, action, resource),
      hasProxy: () => this.drivers.hasSelection("credential_proxy"),
      proxyDriver: () => this.selectedDriver("credential_proxy"),
      proxyRegistrationOwner: () => this.drivers.selection("credential_proxy")?.owner,
      selectedProxyOwner: () => this.drivers.selectedProxyOwner(),
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
        this.provisioningWorker.guardProvisioningConfiguration(state, namespaceId, id, readOnly),
      selectDriver: () => this.selectedDriver("configuration"),
      validateComputeConfiguration: (values, options) =>
        this.validateComputeConfiguration(values, options),
      requireBundledChannelBindings: (values, secretBindings) =>
        this.requireBundledChannelBindings(values, secretBindings),
      ownedSecretDriver: this.secretOperations.ownedSecretDriver,
      bindCreator: this.iamPolicy.bindCreator,
      nextIdentifier: this.resourceValues.nextIdentifier,
      timestamp: this.resourceValues.timestamp,
    });
    const deviceCipher = options.authenticationStateEncryptionSecret
      ? deviceAuthorizationCipher(options.authenticationStateEncryptionSecret)
      : undefined;
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
      egressAdmission: this.egressAdmission,
      hasCredentialProxy: () => this.drivers.hasSelection("credential_proxy"),
      allowsOrdinaryCredentialGateway: () =>
        this.drivers.selectedProxyOwner().allowsOrdinaryCredentialGateway(),
      record: (state, operation) => this.workRecorder.record(state, operation),
      resolveConfiguration: (capability, driverId, scope, key) =>
        this.configurations.resolve(capability, driverId, scope, key),
      hasSandboxSelection: () => this.drivers.hasSelection("sandbox"),
      selectSandbox: () => this.selectedDriver("sandbox"),
      selectedCompute: () => this.selectedDriver("compute"),
      timestamp: this.resourceValues.timestamp,
    });
    this.agentQueries = createAgentQueries({
      transactions: this.transactions,
      authority: this.authority,
      getNamespace: (principalId, namespaceId) => this.getNamespace(principalId, namespaceId),
      selectCompute: () => this.selectedDriver("compute"),
      clock: this.resourceValues.now,
    });
    this.backends = validateBackendDefinitions(options.backends ?? []);
    this.presets = createPresetOperations(options, {
      installationId: this.installation.id,
      transactions: this.transactions,
      authority: this.authority,
      bindCreator: this.iamPolicy.bindCreator,
      getNamespace: (principalId, namespaceId) => this.getNamespace(principalId, namespaceId),
      nextPresetId: () => this.resourceValues.nextIdentifier("preset"),
      timestamp: this.resourceValues.timestamp,
      configurationDriver: this.configurationOperations.selectedDriver,
      validateConfigurationContent: this.configurationOperations.validateConfigurationContent,
      validateAgentBackend: (backendId) => resolveAgentBackendId(this.backendMap, backendId),
      drivers: this.drivers,
      normalizeAgentPluginApprovers,
    });
    this.namespaces = createNamespaceOperations({
      installationId: this.installation.id,
      transactions: this.transactions,
      authority: this.authority,
      iamPolicy: this.iamPolicy,
      presets: this.presets,
      record: (state, operation) => this.workRecorder.record(state, operation),
      observeLifecycle: (namespace, target, signal, record) =>
        this.observeNamespaceLifecycle(namespace, target, signal, record),
      selectedCompute: () => this.selectedDriver("compute"),
      selectedIAMId: () => this.selectedDriver("iam").id,
      allocateNamespaceId: () => this.resourceValues.nextIdentifier("namespace"),
      requireAdoptionSupport: () => this.requireNamespaceAdoptionSupport(),
      timestamp: this.resourceValues.timestamp,
      requestAuditId: () => this.requestAuditId.getStore(),
    });
    this.credentialSourceOperations = createCredentialSourceOperations({
      transactions: this.transactions,
      authority: this.authority,
      sourceDrivers: this.credentialSourceDrivers,
      egressAdmission: this.egressAdmission,
      hasProxy: () => this.drivers.hasSelection("credential_proxy"),
      assertCredentialSourceOwnerSelected:
        this.credentialSourceDrivers.assertCredentialSourceOwnerSelected,
      secretDriver: this.secretOperations.secretDriver,
      secretOperation,
      getNamespace: (principalId, namespaceId) => this.getNamespace(principalId, namespaceId),
      bindCreator: this.iamPolicy.bindCreator,
      nextSourceId: () => this.resourceValues.nextIdentifier("credential_source"),
      timestamp: this.resourceValues.timestamp,
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
    this.deviceAuthorization = createDeviceAuthorizationFlow({
      installationId: this.installation.id,
      cipher: deviceCipher,
      gatewayTimeoutMs: CREDENTIAL_GATEWAY_TIMEOUT_MS,
      nextSessionId: () => this.resourceValues.nextIdentifier("secret"),
      timestamp: this.resourceValues.timestamp,
      transactions: this.transactions,
      authority: this.authority,
      authorizeScope: (principalId, namespaceId, agentId) =>
        this.authorizeDeviceAuthorizationScope(principalId, namespaceId, agentId),
      hasDriver: (capability) => this.drivers.hasSelection(capability),
      credentialGatewayDriver: this.credentialSourceDrivers.credentialGatewayDriver,
      credentialRefreshDriver: this.credentialSourceDrivers.credentialRefreshDriver,
      credentialGatewayOperation,
      credentialSourceContext: this.credentialSourceOperations.credentialSourceContext,
      authorizedCredentialSource: this.credentialSourceOperations.authorizedCredentialSource,
      createSource: (principalId, input, audit, registrationAudit) =>
        this.createCredentialSource(principalId, input, audit, registrationAudit),
      credentialSourceMetadata: credentialSourceMetadata,
    });
    this.managedCredentialSources = createManagedCredentialSources(
      {
        transactions: this.transactions,
        authority: this.authority,
        sourceDrivers: this.credentialSourceDrivers,
        assertCredentialSourceOwnerSelected:
          this.credentialSourceDrivers.assertCredentialSourceOwnerSelected,
        bindCreator: this.iamPolicy.bindCreator,
        lockNamespaceForPolicyDelete: this.iamPolicy.lockNamespaceForPolicyDelete,
        selectedTokenServiceDriver: () => this.selectedDriver("token_service"),
        clock: this.resourceValues.now,
        timestamp: this.resourceValues.timestamp,
        nextSourceId: () => this.resourceValues.nextIdentifier("credential_source"),
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
    this.modelPolicyAgent = createModelPolicyAgent(
      this.sandboxPolicyOperations.sandboxDriver,
      this.nativeWorkers,
    );
    this.agentCredentialAccess = createAgentCredentialAccess({
      authority: this.authority,
      iamPolicy: this.iamPolicy,
      drivers: this.drivers,
      installationId: this.installation.id,
      timestamp: this.resourceValues.timestamp,
      isManagedTokenServiceSource,
      assertCredentialSourceOwnerSelected:
        this.credentialSourceDrivers.assertCredentialSourceOwnerSelected,
      requireTokenServiceOwner: (instanceId) => {
        this.managedCredentialSources.ownedTokenServiceDriver(instanceId);
      },
      credentialSourceOwner: (source) => this.credentialSourceDrivers.credentialSourceOwner(source),
      offersProtectedType: (type) =>
        this.egressAdmission.protectedSourceTypes().some((offer) => offer.type.type === type),
      credentialSourceType: (driver, type) =>
        this.credentialSourceDrivers.credentialSourceType(driver, type),
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
        this.iamPolicy.holdNamespacePolicyActor(state, principalId),
      transactions: this.transactions,
      getUpdatableAgent: (principalId, namespaceId, agentId) =>
        this.agentQueries.getAuthorizedAgent(principalId, namespaceId, agentId, "update"),
      timestamp: this.resourceValues.timestamp,
      requestAuditId: () => this.requestAuditId.getStore(),
    });
    this.agentPlugins = createAgentPluginValidation({
      pluginDriver: (harnessId, forConfiguration) =>
        this.drivers.pluginDriver(harnessId, forConfiguration),
      computeImplementation: () => this.selectedDriver("compute").implementation,
      sandboxImplementation: () => this.drivers.selection("sandbox")?.implementation,
      credentialGatewayImplementation: () =>
        this.drivers.selection("credential_gateway")?.implementation,
    });
    this.pluginDiscovery = createPluginDiscovery({
      transactions: this.transactions,
      authority: this.authority,
      authorizedCredentialSource: this.credentialSourceOperations.authorizedCredentialSource,
      credentialGatewayOperation,
      sourceReader: pluginSourceReader,
      secretDriver: this.secretOperations.secretDriver,
      readConfiguration: (metadata) =>
        this.configurationOperations.savedConfigurationReader(metadata)(),
      modelPolicyAgent: this.modelPolicyAgent,
      pluginDriver: (harnessId) => this.drivers.pluginDriver(harnessId),
      assertPluginOwner: pluginOwner,
      validatePluginPlacement: (driver, plugins, harness) =>
        this.agentPlugins.validatePluginPlacement(driver, plugins, harness),
    });
    this.validateSavedAgentTopology = createSavedAgentTopologyValidator({
      sandboxDriver: this.sandboxPolicyOperations.sandboxDriver,
      selectedCompute: () => this.drivers.selection("compute")?.driver as ComputeDriver | undefined,
      validatePluginPlacement: (driver, plugins, harness) =>
        this.agentPlugins.validatePluginPlacement(driver, plugins, harness),
      validateRepositoryBrokerNetworkProxy,
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
          ? credentialGatewayOperation(() =>
              this.credentialSourceDrivers.credentialGatewayDriver().listSourceTypes({
                signal: AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS),
              }),
            )
          : undefined,
      protectedSourceTypes: () =>
        this.egressAdmission.protectedSourceTypes().map(({ type }) => type),
      allowsGatewaySourceType: (type) =>
        this.egressAdmission.ordinaryCredentialGatewayAllowed(type) ||
        this.egressAdmission.staticSourceTypeAvailable(type),
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
      clock: this.resourceValues.now,
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
        this.provisioningWorker.guardAgentProvisioning(state, namespaceId, agentId),
      selectCompute: () => this.selectedDriver("compute"),
    });
    this.connectionAdministration = createConnectionAdministration({
      installationId: this.installation.id,
      transactions: this.transactions,
      authority: this.authority,
      secretDriver: this.secretOperations.secretDriver,
      now: this.resourceValues.now,
      timestamp: this.resourceValues.timestamp,
    });
    this.savedConnections = createSavedConnections({
      read: this.transactions.read,
      transact: this.transactions.transact,
      authorize: this.authority.authorize,
      canRead: this.authority.canRead,
      holdAuthority: this.authority.holdAuthority,
      iamPolicyDriver: (method) => this.iamPolicy.iamPolicyDriver(method),
      iamPolicyOperation,
      connectionTokenIssuer: () => this.connectionTokenIssuer(),
      tokenService: () => this.tokenService(),
      secretDriver: this.secretOperations.secretDriver,
      withOAuthClientSecret: (client, use) => this.withOAuthClientSecret(client, use),
      retireCredentialSourceMaterial: (namespace, source) =>
        this.managedCredentialSources.retireCredentialSourceMaterial(namespace, source, undefined),
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
      nextIdentifier: this.resourceValues.nextIdentifier,
      timestamp: this.resourceValues.timestamp,
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
      nextIdentifier: this.resourceValues.nextIdentifier,
    });
    this.harnessAuthOperations = createHarnessAuthOperations({
      authority: this.authority,
      authorizeBoundCredentialSources: (principalId, namespaceId, sources) =>
        this.agentCredentialAccess.authorizeBoundCredentialSources(
          principalId,
          namespaceId,
          sources,
        ),
      backends: this.backendMap,
      secrets: this.secretOperations,
      isManagedTokenServiceSource,
      hasCredentialGateway: () => this.drivers.hasSelection("credential_gateway"),
      assertCredentialGatewaySelected: this.credentialSourceDrivers.assertCredentialGatewaySelected,
      ownedTokenServiceDriver: (id) => this.managedCredentialSources.ownedTokenServiceDriver(id),
      ownedCredentialGatewayDriver: (source) =>
        this.credentialSourceDrivers.ownedCredentialGatewayDriver(source),
      credentialGatewayDriver: (id) => this.credentialSourceDrivers.credentialGatewayDriver(id),
      credentialSourceType: (driver, type) =>
        this.credentialSourceDrivers.credentialSourceType(driver, type),
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
        this.provisioningWorker.guardAgentProvisioning(state, namespaceId, agentId),
      guardProvisioningConfiguration: (state, namespaceId, id) =>
        this.provisioningWorker.guardProvisioningConfiguration(state, namespaceId, id),
      backendId: (value, preserve) => resolveAgentBackendId(this.backendMap, value, preserve),
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
      installationId: this.installation.id,
      selectedCompute: () => this.drivers.selection("compute")?.driver as ComputeDriver | undefined,
      refuseRepositoryNetworkOverlap: (actorId, policy) =>
        this.sandboxPolicyOperations.refuseRepositoryNetworkOverlap(actorId, policy),
      bindCreator: this.iamPolicy.bindCreator,
      nextAgentId: () => this.resourceValues.nextIdentifier("agent"),
      timestamp: this.resourceValues.timestamp,
    });

    this.deploymentChannels = createDeploymentChannelChecks({
      transactions: this.transactions,
      authority: this.authority,
      drivers: this.drivers,
      selectedChannel: () => this.selectedDriver("channel"),
      configurationDriver: this.configurationOperations.selectedDriver,
      driverOperation,
      requireBundledChannelBindings: (values, bindings) =>
        this.requireBundledChannelBindings(values, bindings),
      ownedSecretDriver: this.secretOperations.ownedSecretDriver,
      sameSecretBackend,
    });

    this.provisioningRequests = createProvisioningRequests({
      installationId: () => this.installation.id,
      resourceValues: this.resourceValues,
      requestAuditId: () => this.requestAuditId.getStore(),
      backendId: (value) => resolveAgentBackendId(this.backendMap, value),
      transactions: this.transactions,
      authority: this.authority,
      runtimeCredentials: this.runtimeCredentials,
      settings: this.configurationOperations,
      sandboxPolicy: this.sandboxPolicyOperations,
      secrets: this.secretOperations,
      selectedIAM: () => this.selectedDriver("iam"),
      channels: this.deploymentChannels,
      modelPolicyAgent: this.modelPolicyAgent,
      harness: this.harnessAuthOperations,
      plugins: this.agentPlugins,
      repository: this.repositoryPolicy,
      nativeWorkers: this.nativeWorkers,
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
      backendId: (ref) => resolveAgentBackendId(this.backendMap, ref),
      repository: this.repositoryPolicy,
      hasConfigurationDriver: () => this.drivers.hasSelection("configuration"),
      configuration: this.configurationOperations,
      runtimeCredentials: this.runtimeCredentials,
      deploy: (principalId, input, resolveHarness) =>
        this.deployAgent(principalId, input, resolveHarness),
    });
    const admitDeployment = createAgentDeploymentAdmission({
      transactions: this.transactions,
      authority: this.authority,
      channels: this.deploymentChannels,
      harnessAuth: this.harnessAuthOperations,
      repositoryPolicy: this.repositoryPolicy,
      sandboxPolicy: this.sandboxPolicyOperations,
      plugins: this.agentPlugins,
      enabledPluginDrivers: () => this.drivers.enabledPluginDrivers(),
      pluginDriver: (harnessId, forConfiguration) =>
        this.drivers.pluginDriver(harnessId, forConfiguration),
      selectedCompute: () => this.selectedDriver("compute"),
      sandboxDriver: this.sandboxPolicyOperations.sandboxDriver,
      nativeWorkers: this.nativeWorkers,
      loggingLevel: this.loggingLevel,
      provisioningWorker: this.provisioningWorker,
      backendId: (requested) => resolveAgentBackendId(this.backendMap, requested),
      configurationDriver: this.configurationOperations.selectedDriver,
      configuration: this.configurationOperations,
      driverOperation,
      modelPolicyAgent: this.modelPolicyAgent,
      credentialAccess: this.agentCredentialAccess,
      secretDriver: this.secretOperations.secretDriver,
      validateComputeConfiguration: (values) => this.validateComputeConfiguration(values),
      validateRepositoryBrokerNetworkProxy,
      timestamp: this.resourceValues.timestamp,
      nextIdentifier: this.resourceValues.nextIdentifier,
      egress: this.egressAdmission,
      selectedProxyOwner: () => this.drivers.selectedProxyOwner(),
      workRecorder: this.workRecorder,
    });
    this.deploymentRequests = createDeploymentRequests({
      installationId: this.installation.id,
      authority: this.authority,
      transactions: this.transactions,
      channels: this.deploymentChannels,
      selectedCompute: () => this.selectedDriver("compute"),
      configuration: this.configurationOperations,
      admitDeployment,
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

  async validateBackendConfiguration(): Promise<void> {
    const selected = this.drivers.backendDrivers();
    const builtInRepository = this.repositoryPolicy.builtInBackendDriver();
    if (builtInRepository !== undefined) {
      selected.repo = builtInRepository;
    }
    validateSelectedBackendDrivers(
      this.backends,
      selected,
      this.drivers.hasSelection("credential_proxy") ? this.drivers.selectedProxyOwner() : undefined,
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
      runtimeCredentialsInput(input),
    );
  }

  private readonly provisioningRequests: ReturnType<typeof createProvisioningRequests>;

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
        clock: () => this.resourceValues.now(),
        timestamp: () => this.resourceValues.timestamp(),
        inTransaction: this.transactions.hasContext,
        readSnapshot: (work) => this.state.read(work),
        transact: (work) => this.transact(work),
        lockNamespace: (state, namespaceId) => lockNamespace(state, namespaceId),
        proxyDriver: () => this.selectedDriver("credential_proxy"),
        selectedProxyOwner: () => this.drivers.selectedProxyOwner(),
        secretDriver: this.secretOperations.secretDriver,
        computeDriver: () => this.selectedDriver("compute"),
        credentialPlacement: this.credentialSourceDrivers.credentialPlacement,
        credentialNamespace: this.credentialSourceDrivers.credentialNamespace,
        credentialGatewayOperation,
        authorizationAuthority: (principalId) => this.authority.authorizationAuthority(principalId),
        authorizationDecision: (principalId, resource, authority, authorize) =>
          this.authority.authorizationDecision(
            principalId,
            "operate",
            resource,
            authority,
            authorize,
          ),
        authorizeUse: (principalId, resource) =>
          this.authority.authorize(principalId, "operate", resource),
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

  private readonly credentialSourceDrivers = createCredentialSourceDrivers({
    selectedDriver: (capability) => this.selectedDriver(capability),
    hasSelection: (capability) => this.drivers.hasSelection(capability),
    selectedProxyOwner: () => this.drivers.selectedProxyOwner(),
  });

  private readonly egressAdmission: ReturnType<typeof createCredentialEgressAdmission>;

  /** Bind the configured adapter to the actual durable credential store before use. */
  async activateTokenServiceInstance(driverId: string, storeIdentity: string): Promise<string> {
    return this.managedCredentialSources.activateTokenServiceInstance(driverId, storeIdentity);
  }

  currentTokenServiceInstanceId(): string {
    return this.managedCredentialSources.currentTokenServiceInstanceId();
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
    await this.transactions.read(async (state) => {
      const namespace = await exactNamespace(state, namespaceId);
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

  async recoverAgentFirstDeployment(
    principalId: string,
    input: DeployAgentInput,
    intent: FirstDeploymentIntent,
  ): Promise<Readonly<FirstDeploymentReceipt> | null> {
    return this.deploymentRequests.recoverAgentFirstDeployment(principalId, input, intent);
  }

  async deployAgentFirst(
    principalId: string,
    input: DeployAgentInput,
    intent: FirstDeploymentIntent,
    resolveHarness: HarnessResolver,
    auditEvent?: (result: Readonly<AuthorizedAgentDeployment>) => AuditEvent,
  ): Promise<Readonly<FirstDeploymentReceipt>> {
    return this.deploymentRequests.deployAgentFirst(
      principalId,
      input,
      intent,
      resolveHarness,
      auditEvent,
    );
  }

  async deployAgent(
    principalId: string,
    input: DeployAgentInput,
    resolveHarness: HarnessResolver,
  ): Promise<Readonly<AgentRevision>> {
    return (await this.deployAgentWithAuthorization(principalId, input, resolveHarness)).revision;
  }

  async deployAgentWithAuthorization(
    principalId: string,
    input: DeployAgentInput,
    resolveHarness: HarnessResolver,
    auditEvent?: (result: Readonly<AuthorizedAgentDeployment>) => AuditEvent,
  ): Promise<Readonly<AuthorizedAgentDeployment>> {
    return this.deploymentRequests.deployAgentWithAuthorization(
      principalId,
      input,
      resolveHarness,
      auditEvent,
    );
  }

  private readonly agentCredentialWithdrawal = createAgentCredentialWithdrawal({
    namespaceIdentity: (namespaceId) => namespaceIdentity(namespaceId),
    now: () => this.resourceValues.now(),
    timestamp: () => this.resourceValues.timestamp(),
    record: (state, operation) => this.workRecorder.record(state, operation),
    transactions: {
      read: (work) => this.transactions.read(work),
      transact: (work) => this.transactions.transact(work),
    },
    authority: {
      authorize: (principalId, action, target) =>
        this.authority.authorize(principalId, action, target),
    },
    lockNamespace: (state, namespaceId) => lockNamespace(state, namespaceId),
    exactNamespace: (state, namespaceId) => exactNamespace(state, namespaceId),
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
    timestamp: () => this.resourceValues.timestamp(),
    record: (state, operation) => this.workRecorder.record(state, operation),
    transactions: { transact: (work) => this.transactions.transact(work) },
    authority: {
      authorize: (principalId, action, target) =>
        this.authority.authorize(principalId, action, target),
      authorizationDecision: (principalId, action, target) =>
        this.authority.authorizationDecision(principalId, action, target),
      holdAuthority: (state) => this.authority.holdAuthority(state),
    },
    lockNamespace: (state, namespaceId) => lockNamespace(state, namespaceId),
    now: () => this.resourceValues.now(),
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

  private agentRuntimeConfiguration(
    values: Readonly<OpenClawConfigurationDocument>,
    harness: RevisionHarnessDescriptor,
    compute: ComputeDriver,
    sandbox: SandboxDriver | undefined,
  ): OpenClawConfigurationDocument {
    return agentRuntimeConfiguration(values, harness, compute, sandbox, this.loggingLevel);
  }
}
export { PostgresMetricsSnapshot } from "./state/postgres-metrics.ts";
export type { PlatformMetricsSnapshot } from "./state/postgres-metrics.ts";
