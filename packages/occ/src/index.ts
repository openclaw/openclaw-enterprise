import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type {
  Agent,
  InitialWorkspaceFiles,
  AgentDeploymentDiagnostics,
  AgentRevision,
  AgentRuntimeCredentialsInput,
  AgentRuntimeCredentialStatus,
  AccessBinding,
  AuthorizationDecision,
  AuthorizationRequest,
  ComputeDriver,
  ComputeLifecycleHooks,
  Configuration,
  ConfigurationDriver,
  CredentialGatewayDriver,
  CredentialSource,
  CredentialSourceMetadata,
  CredentialSourceStatus,
  CredentialSourceType,
  AuditEvent,
  Driver,
  DriverCapability,
  HarnessDescriptor,
  HarnessExecutionMode,
  IAMDriver,
  Installation,
  InstallationDeploymentInventory,
  Namespace,
  NamespaceDeleteResult,
  NamespaceEnsureResult,
  LoggingLevel,
  OpenClawConfigurationDocument,
  ManagedIAMResourceKind,
  Permission,
  Preset,
  PresetTemplate,
  PermissionAction,
  PluginDesiredSelection,
  PluginDesiredState,
  PluginApprovers,
  PluginCatalogEntry,
  PluginCatalogPage,
  PluginDriver,
  ChannelDriver,
  ChannelDirectoryResult,
  ChannelDirectoryLookupInput,
  PluginRevisionState,
  BackendDefinition,
  BackendRef,
  RepositoryBindingRequest,
  RepositoryBindingSelection,
  RepositoryOption,
  RepoDriver,
  RepositoryCredentialResolution,
  RepositoryRevisionState,
  RevisionHarnessDescriptor,
  ResourceKind,
  ResourceRef,
  Role,
  RuntimeDiagnosticCheck,
  SandboxDriver,
  SandboxFacet,
  Secret,
  SecretBindings,
  SecretReference,
  SecretDriver,
  SecretMetadata,
  ServiceAccount,
  ServiceAccountCredential,
  ServiceAccountDriver,
  HarnessAuthBinding,
  HarnessAuthSnapshot,
} from "@openclaw-enterprise/contracts";
import {
  normalizeInitialWorkspaceFiles,
  normalizeWorkspaceDefaultsId,
  DRIVER_CAPABILITIES,
  RESOURCE_KINDS,
  SANDBOX_FACETS,
  admitLoggingConfiguration,
  normalizeLoggingLevel,
  normalizePluginDesiredState,
  normalizePluginApprovers,
  normalizePresetTemplate,
  presetTemplateDefaults,
  PresetValidationError,
  normalizeSecretBindings,
  normalizeHarnessAuthBinding,
  freezeAgentRevision,
} from "@openclaw-enterprise/contracts";
import { asRecord, immutableCopy, isNonEmptyString } from "@openclaw-enterprise/utils";
import {
  AgentDeletingError,
  AuthorizationDeniedError,
  DependencyUnavailableError,
  DriverSelectionError,
  ModelDiscoveryError,
  PluginDiscoveryError,
  ChannelDirectoryError,
  NamespaceNotEmptyError,
  NamespaceNotReadyError,
  NotImplementedError,
  PluginPolicyValidationError,
  RepositoryOptionsUnavailableError,
  ResourceConflictError,
  ScopeViolationError,
} from "./errors.ts";
import {
  assertConfiguredBackend,
  backendDefinitionMap,
  validateBackendDefinitions,
  validateSelectedBackendDrivers,
  validateServiceAccountBackendBinding,
} from "./backends.ts";
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
  deploymentWarningsForWork,
  type DeploymentStatusResult,
} from "./state/controller-work.ts";
import { PostgresCommitOutcomeUnknownError } from "./state/postgres-state.ts";
import { WorkClaimLostError, type ClaimedWork } from "./state/postgres-work-queue.ts";
import {
  validAdmittedRepositoryBindings,
  validRepositoryRevisionState,
} from "./state/repository-credential-state.ts";
import {
  canonicalProvisioningJson,
  normalizeProvisioningConfiguration,
  normalizeProvisioningHarnessAuth,
  normalizeProvisioningWorkspace,
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
  type ProvisioningEffectReceipt,
  type ProvisioningEffectTarget,
} from "./provisioning-effects.ts";
import type {
  AgentProvisioningCheckpoint,
  AgentProvisioningRecord,
} from "./state/agent-provisioning.ts";

export {
  AgentDeletingError,
  AuthorizationDeniedError,
  DependencyUnavailableError,
  DriverSelectionError,
  ModelDiscoveryError,
  PluginDiscoveryError,
  ChannelDirectoryError,
  NamespaceNotEmptyError,
  NamespaceNotReadyError,
  NotImplementedError,
  PluginPolicyValidationError,
  RepositoryOptionsUnavailableError,
  ResourceConflictError,
  ScopeViolationError,
} from "./errors.ts";
export {
  backendDefinitionMap,
  validateBackendDefinitions,
  validateSelectedBackendDrivers,
  validateServiceAccountBackendBinding,
} from "./backends.ts";
export {
  provisioningEffectReceipt,
  provisioningPendingEffect,
  settleProvisioningEffect,
  type ProvisioningEffectReceipt,
  type ProvisioningEffectKind,
  type ProvisioningEffectTarget,
  type ProvisioningPendingEffect,
} from "./provisioning-effects.ts";
export {
  InMemoryPlatformState,
  type AgentReadRepository,
  type AgentRepository,
  type AgentRevisionReadRepository,
  type AgentRevisionRepository,
  type InMemoryPlatformStateOptions,
  type InstallationReadRepository,
  type InstallationRepository,
  type NamespaceReadRepository,
  type NamespaceRepository,
  type PlatformAuditRepository,
  type PlatformAuditSink,
  type PlatformOperation,
  type PlatformOperationRepository,
  type PlatformReadView,
  type PlatformStateStore,
  type PlatformUnitOfWork,
  type ServiceAccountReadRepository,
  type ServiceAccountRepository,
  type TransactionalAuditWriter,
} from "./state/platform-state.ts";
export { createPostgresPool } from "./state/postgres-pool.ts";
export type {
  RepositoryRevisionOwner,
  RepositorySessionAttempt,
  RepositorySessionPhase,
  RepositorySessionReadRepository,
  RepositorySessionRepository,
} from "./ports/repository-sessions.ts";
export {
  PostgresPlatformState,
  PostgresPlatformStateStore,
  type PersistedNativeIAMState,
  type PostgresClient,
  type PostgresPlatformStateOptions,
  type PostgresPool,
} from "./state/postgres-state.ts";
export {
  PostgresWorkQueue,
  WorkClaimLostError,
  isRepositoryCleanupWork,
  isRepositoryRuntimeRetirementWork,
  type ClaimedWork,
  type ClaimRequest,
  type ControllerWork,
  type ControllerWorkState,
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
export {
  validateRuntimeFailureEvidence,
  type DeploymentStatus,
  type DeploymentStatusError,
  type DeploymentStatusResult,
  type PluginDeploymentWarning,
  type RuntimeFailureEvidence,
} from "./state/controller-work.ts";
export {
  type AgentProvisioningConfigurationInput,
  type AgentProvisioningProgress,
  type ProvisionAgentInput,
  type ProvisionAgentResult,
} from "./agent-provisioning.ts";
export type {
  AgentProvisioningRecord,
  AgentProvisioningRepository,
  AgentProvisioningStatus,
} from "./state/agent-provisioning.ts";

export const BOOTSTRAP_DEFAULT_NAMESPACE_NAME = "default";

export interface ControllerOptions {
  readonly authorize?: (
    request: AuthorizationRequest,
  ) => AuthorizationDecision | Promise<AuthorizationDecision>;
  readonly now?: () => Date;
  readonly createId?: (kind: ResourceKind) => string;
  readonly state?: PlatformStateStore;
  readonly recordOperations?: boolean;
  readonly backends?: readonly BackendDefinition[];
  readonly defaultPresets?: readonly Pick<Preset, "name" | "template">[];
  readonly loggingLevel?: LoggingLevel;
  readonly configuredServiceAccountDriverId?: string;
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
  readonly executionMode?: HarnessExecutionMode;
  readonly plugins?: PluginDesiredState;
  readonly pluginApprovers?: PluginApprovers;
  readonly repositoryBindings?: readonly RepositoryBindingRequest[];
}

export interface UpdateAgentInput {
  readonly namespaceId: string;
  readonly agentId: string;
  readonly configurationId: string;
  readonly backendId?: string | null;
  readonly harnessAuth?: HarnessAuthBinding | null;
  readonly executionMode?: HarnessExecutionMode;
  readonly plugins?: PluginDesiredState;
  readonly pluginApprovers?: PluginApprovers | null;
  readonly repositoryBindings?: readonly RepositoryBindingRequest[];
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

export type HarnessResolver = (
  harnessId: string,
  executionMode: HarnessExecutionMode,
) => HarnessDescriptor | undefined;

export interface CreatePresetInput {
  readonly namespaceId: string;
  readonly name: string;
  readonly template: PresetTemplate;
}

export interface UpdatePresetInput {
  readonly namespaceId: string;
  readonly presetId: string;
  readonly name?: string;
  readonly template?: PresetTemplate;
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
}

export interface DeployAgentInput {
  readonly namespaceId: string;
  readonly agentId: string;
}

export interface DeployAgentAuthorization {
  readonly request: Readonly<AuthorizationRequest>;
  readonly decision: Readonly<AuthorizationDecision>;
}

export interface AuthorizedAgentDeployment {
  readonly revision: Readonly<AgentRevision>;
  readonly authorization: Readonly<DeployAgentAuthorization>;
}

export interface ActiveAgentRevisionSelection {
  readonly agent: Readonly<Agent>;
  readonly revision: Readonly<AgentRevision>;
}

export type ReconciliationOperation = PlatformOperation;

export type AgentProvisioningWorkerOutcome =
  | { readonly outcome: "succeeded"; readonly revisionId: string }
  | { readonly outcome: "retry" | "permanent"; readonly code: string };

export interface AgentProvisioningWorkerOptions {
  readonly runEffect?: <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<T>;
}

interface RegisteredDriver {
  readonly driver: Driver;
  readonly capability: DriverCapability;
  readonly id: string;
  readonly implementation: string;
}

type DriverByCapability = {
  iam: IAMDriver;
  configuration: ConfigurationDriver;
  service_account: ServiceAccountDriver;
  secret: SecretDriver;
  sandbox: SandboxDriver;
  compute: ComputeDriver;
  plugin: PluginDriver;
  channel: ChannelDriver;
  repo: RepoDriver;
  credential_gateway: CredentialGatewayDriver;
};
type DriverFor<Capability extends DriverCapability> = DriverByCapability[Capability];

/** Bounds each synchronous Credential Gateway call made while serving an API request. */
const CREDENTIAL_GATEWAY_TIMEOUT_MS = 30_000;
/**
 * A Credential Gateway must finish any effect of an aborted registration within
 * CREDENTIAL_GATEWAY_TIMEOUT_MS after the abort. Until this long after `createdAt`, an absent
 * gateway copy does not prove that no late create is still in flight, so the record is kept.
 */
const CREDENTIAL_REGISTRATION_FENCE_MS = 2 * CREDENTIAL_GATEWAY_TIMEOUT_MS + 10_000;

const COMPUTE_LIFECYCLE_PHASES = [
  "afterNamespacePrepared",
  "beforeWorkloadStart",
  "beforeWorkloadStop",
  "beforeNamespaceDelete",
] as const satisfies readonly (keyof ComputeLifecycleHooks)[];

const RUNTIME_DIAGNOSTIC_IDENTIFIER = /^[A-Za-z0-9._~:@-]{1,64}$/u;
const RUNTIME_DIAGNOSTIC_TIMESTAMP =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$/u;

function validRuntimeDiagnosticIdentifier(value: unknown): value is string {
  return typeof value === "string" && RUNTIME_DIAGNOSTIC_IDENTIFIER.test(value);
}

function validRuntimeDiagnosticTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !RUNTIME_DIAGNOSTIC_TIMESTAMP.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

/** Rejects unknown and missing catalog fields before any Credential Gateway effect. */
function credentialSourceFieldsMatch(
  kind: "config" | "secrets",
  specs: CredentialSourceType["config"],
  values: Readonly<Record<string, unknown>>,
): void {
  const known = new Set(specs.map((spec) => spec.name));
  for (const field of Object.keys(values)) {
    if (!known.has(field)) {
      throw new ScopeViolationError(
        `The credential source ${kind} field ${field} is not supported.`,
      );
    }
  }
  for (const spec of specs) {
    if (spec.required && values[spec.name] === undefined) {
      throw new ScopeViolationError(
        `The credential source ${kind} field ${spec.name} is required.`,
      );
    }
  }
}

function validName(value: unknown): value is string {
  return isNonEmptyString(value) && value.length <= 200;
}

type PluginDiscoveryCredential =
  | { readonly accessToken: string; readonly secretRef?: never }
  | { readonly accessToken?: never; readonly secretRef: SecretReference }
  | { readonly accessToken?: never; readonly secretRef?: never };

function capability(value: unknown): value is DriverCapability {
  return typeof value === "string" && DRIVER_CAPABILITIES.some((candidate) => candidate === value);
}

function driverHasCapabilityContract(driver: Driver): boolean {
  const candidate = driver as unknown as Record<string, unknown>;
  if (driver.capability === "iam") {
    return (
      typeof candidate.lookupIdentity === "function" &&
      typeof candidate.authorize === "function" &&
      [
        "listNamespaceRoles",
        "getNamespaceRole",
        "createNamespaceRole",
        "deleteNamespaceRole",
        "listNamespaceAccessBindings",
        "getNamespaceAccessBinding",
        "createNamespaceAccessBinding",
        "deleteNamespaceAccessBinding",
      ].every(
        (operation) =>
          candidate[operation] === undefined || typeof candidate[operation] === "function",
      )
    );
  }
  if (driver.capability === "configuration") {
    return ["create", "read", "update", "delete", "validate"].every(
      (operation) => typeof candidate[operation] === "function",
    );
  }
  if (driver.capability === "secret") {
    return (
      ["create", "update", "delete", "resolve"].every(
        (operation) => typeof candidate[operation] === "function",
      ) &&
      (candidate.withValue === undefined || typeof candidate.withValue === "function")
    );
  }
  if (driver.capability === "credential_gateway") {
    return [
      "listSourceTypes",
      "registerSource",
      "updateSource",
      "rotateSource",
      "sourceStatus",
      "removeSource",
      "attachForRevision",
      "attachmentStatus",
      "withdraw",
    ].every((operation) => typeof candidate[operation] === "function");
  }
  if (driver.capability === "service_account") {
    return ["create", "createCredential", "delete"].every(
      (operation) => typeof candidate[operation] === "function",
    );
  }
  if (driver.capability === "sandbox") {
    return (
      sandboxFacets(candidate.facets) &&
      (candidate.configureAgent === undefined || typeof candidate.configureAgent === "function") &&
      (candidate.ensureNamespace === undefined ||
        typeof candidate.ensureNamespace === "function") &&
      (candidate.provisionHarness === undefined ||
        typeof candidate.provisionHarness === "function") &&
      typeof candidate.cleanup === "function"
    );
  }
  if (driver.capability === "plugin") {
    return typeof candidate.listCatalog === "function";
  }
  if (driver.capability === "channel") {
    return typeof candidate.lookupDirectory === "function";
  }
  if (driver.capability === "repo") {
    return (
      ["listOptions", "resolve", "open", "status", "close"].every(
        (operation) => typeof candidate[operation] === "function",
      ) &&
      typeof candidate.maintenanceIntervalMs === "number" &&
      Number.isFinite(candidate.maintenanceIntervalMs) &&
      candidate.maintenanceIntervalMs > 0
    );
  }
  return (
    typeof candidate.ensureNamespace === "function" &&
    typeof candidate.deleteNamespace === "function" &&
    typeof candidate.prepareRevision === "function" &&
    typeof candidate.retireRevision === "function" &&
    (candidate.getRuntimeImages === undefined ||
      typeof candidate.getRuntimeImages === "function") &&
    (candidate.resolveSandboxNamespace === undefined ||
      typeof candidate.resolveSandboxNamespace === "function") &&
    (candidate.getAgentRuntimeCredentialStatus === undefined ||
      typeof candidate.getAgentRuntimeCredentialStatus === "function") &&
    (candidate.provisionAgentRuntimeCredentials === undefined ||
      typeof candidate.provisionAgentRuntimeCredentials === "function") &&
    (candidate.diagnoseAgentDeployment === undefined ||
      typeof candidate.diagnoseAgentDeployment === "function") &&
    (candidate.deleteAgentRuntimeCredentials === undefined ||
      typeof candidate.deleteAgentRuntimeCredentials === "function")
  );
}

function sandboxFacets(value: unknown): value is readonly SandboxFacet[] {
  if (!Array.isArray(value) || value.length === 0) {
    return false;
  }
  const seen = new Set<string>();
  const allowed = new Set<string>(SANDBOX_FACETS);
  for (const facet of value) {
    if (typeof facet !== "string" || !allowed.has(facet) || seen.has(facet)) {
      return false;
    }
    seen.add(facet);
  }
  return true;
}

function driverHasValidLifecycleHooks(driver: Driver): boolean {
  const hooks: unknown = driver.computeLifecycleHooks;
  if (hooks === undefined) {
    return true;
  }
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    return false;
  }

  const candidate = hooks as Record<string, unknown>;
  const phases: readonly string[] = COMPUTE_LIFECYCLE_PHASES;
  const keys = Object.keys(candidate);
  return (
    keys.length > 0 &&
    keys.every((key) => phases.includes(key) && typeof candidate[key] === "function")
  );
}

function frozenValues(value: unknown): Readonly<OpenClawConfigurationDocument> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ScopeViolationError("Configuration values must be a JSON object.");
  }
  return immutableCopy(value as OpenClawConfigurationDocument);
}

function configuredRuntime(value: unknown): string | undefined {
  const runtimeValue = asRecord(value)?.agentRuntime;
  if (runtimeValue === undefined) {
    return undefined;
  }
  const runtime = asRecord(runtimeValue);
  if (runtime === undefined || (runtime.id !== "openclaw" && runtime.id !== "codex")) {
    throw new ScopeViolationError("The configured model Harness runtime identity is unsupported.");
  }
  return runtime.id;
}

function configuredModels(value: unknown): readonly string[] {
  if (value === undefined) {
    return [];
  }
  const configured = asRecord(value);
  const fallbacks = configured?.fallbacks;
  if (fallbacks !== undefined && !Array.isArray(fallbacks)) {
    throw new ScopeViolationError("Configured Agent model fallbacks must be an array.");
  }
  const model = typeof value === "string" ? value : configured?.primary;
  const models = [model, ...(fallbacks ?? [])].map((selected) => {
    if (
      !isNonEmptyString(selected) ||
      !selected.includes("/") ||
      selected.startsWith("/") ||
      selected.endsWith("/")
    ) {
      throw new ScopeViolationError(
        "The configured Agent model must identify its provider and model.",
      );
    }
    return selected;
  });
  if (models.some((selected) => selected.split("/", 2)[0] !== models[0]!.split("/", 2)[0])) {
    throw new ScopeViolationError("Configured model fallbacks must retain the primary provider.");
  }
  return models;
}

function matchingSelectableModels(
  value: Readonly<Record<string, unknown>> | undefined,
  selectedModel: string | undefined,
): boolean {
  if (value === undefined || selectedModel === undefined) {
    return false;
  }
  const selectedRuntime = configuredRuntime(value[selectedModel]);
  return Object.entries(value).every(
    ([model, policy]) =>
      model === selectedModel ||
      (selectedRuntime !== undefined &&
        model.split("/", 2)[0] === selectedModel.split("/", 2)[0] &&
        configuredRuntime(policy) === selectedRuntime),
  );
}

function providerModelEntry(
  provider: Readonly<Record<string, unknown>>,
  model: string,
): Readonly<Record<string, unknown>> | undefined {
  const configured = provider.models;
  if (configured === undefined) {
    return undefined;
  }
  if (!Array.isArray(configured)) {
    throw new ScopeViolationError("Configured provider models must be a native model array.");
  }
  const matches = configured.filter((candidate) => {
    const value = asRecord(candidate);
    return value?.id === model || value?.id === model.split("/", 2)[1];
  });
  if (matches.length > 1) {
    throw new ScopeViolationError("The selected provider model Harness policy is ambiguous.");
  }
  return asRecord(matches[0]);
}

/** Resolve native model policy without treating ignored whole-agent runtime pins as authoritative. */
export function resolveConfiguredHarnessId(
  values: Readonly<OpenClawConfigurationDocument>,
): string {
  const agents = asRecord(values.agents);
  const defaults = asRecord(agents?.defaults);
  const entries = asRecord(agents?.entries);
  if (agents?.list !== undefined && (!Array.isArray(agents.list) || agents.list.length > 0)) {
    throw new ScopeViolationError("Configured Agent lists are unsupported.");
  }
  const providerConfigurations = asRecord(asRecord(values.models)?.providers);
  const defaultSelection = configuredModels(defaults?.model);
  const defaultModels = asRecord(defaults?.models);
  const candidates: Array<{ model: string; entry?: Readonly<Record<string, unknown>> }> =
    defaultSelection.map((model) => ({ model }));

  for (const value of Object.values(entries ?? {})) {
    const entry = asRecord(value);
    if (entry === undefined) {
      throw new ScopeViolationError("The configured Agent runtime entry is invalid.");
    }
    const selection = entry.model === undefined ? defaultSelection : configuredModels(entry.model);
    const model = selection[0];
    if (model === undefined) {
      throw new ScopeViolationError("The configured Agent runtime model cannot be resolved.");
    }
    if (candidates[0] !== undefined && model !== candidates[0].model) {
      throw new ScopeViolationError("Configured Agent entries must match the primary model.");
    }
    const models = asRecord(entry.models);
    if (entry.models !== undefined && !matchingSelectableModels(models, model)) {
      throw new ScopeViolationError("Configured selectable models must match the primary model.");
    }
    candidates.push(...selection.map((model) => ({ model, entry })));
  }

  if (
    defaults?.models !== undefined &&
    !matchingSelectableModels(defaultModels, candidates[0]?.model)
  ) {
    throw new ScopeViolationError("Configured selectable models must match the primary model.");
  }

  for (const [providerId, value] of Object.entries(providerConfigurations ?? {})) {
    const provider = asRecord(value);
    if (provider === undefined) {
      throw new ScopeViolationError("The configured Agent model provider is invalid.");
    }
    if (provider.models === undefined) {
      continue;
    }
    if (!Array.isArray(provider.models)) {
      throw new ScopeViolationError("Configured provider models must be a native model array.");
    }
    if (
      provider.models.some((value) => {
        const model = asRecord(value)?.id;
        return !candidates.some(
          (candidate) =>
            candidate.model.split("/", 2)[0] === providerId &&
            (model === candidate.model || model === candidate.model.split("/", 2)[1]),
        );
      })
    ) {
      throw new ScopeViolationError(
        "Configured selectable provider models must match the primary model.",
      );
    }
  }

  if (candidates.length === 0) {
    return "openclaw";
  }
  const resolved = new Set<string>();
  const plugins = asRecord(asRecord(values.plugins)?.entries);

  for (const candidate of candidates) {
    const providerId = candidate.model.split("/", 2)[0]!;
    const provider = asRecord(providerConfigurations?.[providerId]);
    const providerModel =
      provider === undefined ? undefined : providerModelEntry(provider, candidate.model);
    const entryModels = asRecord(candidate.entry?.models);
    const policies = new Set(
      [entryModels?.[candidate.model], defaultModels?.[candidate.model], providerModel, provider]
        .map(configuredRuntime)
        .filter((runtime): runtime is string => runtime !== undefined),
    );
    if (policies.size > 1) {
      throw new ScopeViolationError("The selected model has conflicting Harness runtime policies.");
    }
    const selected = [...policies][0];
    if (
      selected === undefined &&
      (providerId === "openai" ||
        providerId === "codex" ||
        provider !== undefined ||
        plugins?.[providerId] !== undefined)
    ) {
      throw new ScopeViolationError(
        "The configured Agent model requires an explicit supported Harness runtime.",
      );
    }
    const codexPlugin = asRecord(plugins?.codex);
    const codexPluginConfiguration = asRecord(codexPlugin?.config);
    const codexAppServer = asRecord(codexPluginConfiguration?.appServer);
    if (
      selected === "codex" &&
      providerId !== "codex" &&
      !(
        providerId === "openai" &&
        codexPlugin?.enabled === true &&
        codexAppServer?.transport === "websocket"
      )
    ) {
      throw new ScopeViolationError("The Codex Harness requires the native codex model provider.");
    }
    resolved.add(selected ?? "openclaw");
  }

  if (resolved.size !== 1) {
    throw new ScopeViolationError(
      "The configured Agent models select conflicting Harness runtimes.",
    );
  }
  return [...resolved][0]!;
}

function validExecutionMode(value: unknown): value is HarnessExecutionMode {
  return value === "embedded" || value === "dedicated";
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
    ![...displayName].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    }) &&
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

function normalizeAgentPluginApprovers(
  approvers: PluginApprovers | undefined,
): PluginApprovers | undefined {
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

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function validChannelDirectoryResult(value: unknown): value is ChannelDirectoryResult {
  const result = asRecord(value);
  const bounded = (candidate: unknown, maxLength: number): candidate is string =>
    typeof candidate === "string" &&
    candidate.length > 0 &&
    candidate.length <= maxLength &&
    !hasControlCharacters(candidate);
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

export class OpenClawController {
  readonly installation: Readonly<Installation>;

  private readonly authorization?: ControllerOptions["authorize"];
  private readonly clock: () => Date;
  private readonly identifier?: ControllerOptions["createId"];
  private readonly state: PlatformStateStore;
  private readonly transactionContext = new AsyncLocalStorage<PlatformUnitOfWork>();
  private readonly provisioningContext = new AsyncLocalStorage<ClaimedWork>();
  private readonly mutationRollbacks = new AsyncLocalStorage<(() => Promise<void>)[]>();
  private readonly shouldRecordOperations: boolean;
  private readonly registry = new Map<string, RegisteredDriver>();
  private readonly selections = new Map<DriverCapability, RegisteredDriver>();
  private readonly backends: readonly BackendDefinition[];
  private readonly defaultPresets: readonly Pick<Preset, "name" | "template">[];
  private readonly loggingLevel: LoggingLevel;
  private readonly backendMap: ReadonlyMap<string, BackendDefinition>;
  private readonly configuredServiceAccountDriverId: string | undefined;

  constructor(installation: Installation, options: ControllerOptions = {}) {
    if (!isNonEmptyString(installation.id) || !validName(installation.name)) {
      throw new ScopeViolationError("The controller requires one valid server-owned Installation.");
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
    this.authorization = options.authorize;
    this.clock = options.now ?? (() => new Date());
    this.identifier = options.createId;
    this.state = options.state ?? new InMemoryPlatformState();
    this.shouldRecordOperations = options.recordOperations ?? true;
    this.backends = validateBackendDefinitions(options.backends ?? []);
    this.defaultPresets = immutableCopy(options.defaultPresets ?? []);
    const presetNames = new Set<string>();
    for (const preset of this.defaultPresets) {
      if (!validName(preset.name) || presetNames.has(preset.name)) {
        throw new PresetValidationError("Default Presets require distinct valid names.");
      }
      presetNames.add(preset.name);
    }
    this.loggingLevel = normalizeLoggingLevel(options.loggingLevel);
    this.backendMap = backendDefinitionMap(this.backends);
    if (
      options.configuredServiceAccountDriverId !== undefined &&
      !isNonEmptyString(options.configuredServiceAccountDriverId)
    ) {
      throw new ScopeViolationError("The configured ServiceAccount Driver ID is invalid.");
    }
    this.configuredServiceAccountDriverId = options.configuredServiceAccountDriverId;
  }

  registerDriver(driver: Driver): Driver {
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
    const key = this.driverKey(driver.capability, driver.id);
    if (this.registry.has(key)) {
      throw new DriverSelectionError(
        "A Driver is already registered for this exact capability and identity.",
      );
    }
    this.registry.set(
      key,
      Object.freeze({
        driver,
        capability: driver.capability,
        id: driver.id,
        implementation: driver.implementation,
      }),
    );
    return driver;
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
    return this.applyDriverSelection(selectedCapability, selected);
  }

  selectedDriver<Capability extends DriverCapability>(
    selectedCapability: Capability,
  ): DriverFor<Capability> {
    if (!capability(selectedCapability)) {
      throw new DriverSelectionError("The requested Driver capability is invalid.");
    }
    const selected = this.selections.get(selectedCapability);
    if (!selected || !this.unchangedDriver(selected)) {
      throw new DriverSelectionError(
        "The selected Driver is unavailable or no longer matches its capability.",
      );
    }
    return selected.driver as DriverFor<Capability>;
  }

  async validateBackendConfiguration(): Promise<void> {
    validateSelectedBackendDrivers(
      this.backends,
      Object.fromEntries(
        [...this.selections.entries()].map(([capability, selection]) => [
          capability,
          selection.driver,
        ]),
      ),
    );
  }

  async getInstallation(principalId: string): Promise<Readonly<Installation>> {
    await this.authorize(principalId, "read", {
      kind: "installation",
      id: this.installation.id,
    });
    if (!this.selections.has("plugin")) {
      return this.installation;
    }
    const driver = this.pluginDriver();
    return immutableCopy({
      ...this.installation,
      capabilities: {
        ...this.installation.capabilities,
        ...(driver.discoverCatalog && driver.getCatalogPlugin
          ? { pluginDiscovery: { credential: driver.discoveryCredential ?? "required" } }
          : {}),
        pluginPolicies: {
          driver: { id: driver.id, implementation: driver.implementation },
          ...driver.policyCapabilities,
        },
      },
    });
  }

  async getInstallationDeploymentInventory(
    principalId: string,
  ): Promise<Readonly<InstallationDeploymentInventory>> {
    await this.authorize(principalId, "administer", {
      kind: "installation",
      id: this.installation.id,
    });
    return this.read(async (state) => {
      const deploymentsInProgress = new Set<string>();
      for (const operation of await state.operations.list()) {
        if (operation.kind !== "agent_revision") {
          continue;
        }
        const work = await state.operations.findWork(
          `agent_revision:${operation.resourceId}:reconcile`,
        );
        if (
          work === undefined ||
          work.namespaceId !== operation.namespaceId ||
          work.revisionId !== operation.resourceId ||
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
            });
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
      return Object.freeze({
        installationId: this.installation.id,
        namespaces: Object.freeze(namespaces),
      });
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
    if (!isNonEmptyString(namespaceId)) {
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    }
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
    if (input.name !== undefined && !validName(input.name)) {
      throw new ScopeViolationError("The IAM Role name is invalid.");
    }
    const namespace = await this.admitIAMPolicyOperation(principalId, input.namespaceId);
    const driver = this.iamPolicyDriver("createNamespaceRole");
    return this.mutate((state) =>
      this.iamPolicyOperation(() =>
        driver.createNamespaceRole!(
          { policy: state.iamPolicy },
          {
            id: `role_${crypto.randomUUID()}`,
            namespaceId: namespace.id,
            ...(input.name === undefined ? {} : { name: input.name }),
            permissions,
          },
        ),
      ),
    );
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

  async deleteIAMRole(principalId: string, namespaceId: string, roleId: string): Promise<void> {
    if (!isNonEmptyString(roleId)) {
      throw new ScopeViolationError("The exact IAM Role identity is missing.");
    }
    const namespace = await this.admitIAMPolicyOperation(principalId, namespaceId);
    const driver = this.iamPolicyDriver("deleteNamespaceRole");
    const deleted = await this.mutate((state) =>
      this.iamPolicyOperation(() =>
        driver.deleteNamespaceRole!({ policy: state.iamPolicy }, namespace.id, roleId),
      ),
    );
    if (!deleted) {
      throw new ScopeViolationError("The IAM Role does not belong to the exact Namespace.");
    }
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

  async createIAMAccessBinding(
    principalId: string,
    input: CreateIAMAccessBindingInput,
  ): Promise<Readonly<AccessBinding>> {
    if (input.subjectKind !== "identity" || !isNonEmptyString(input.subjectId)) {
      throw new ScopeViolationError("The IAM AccessBinding subject is invalid.");
    }
    if (!isNonEmptyString(input.roleId)) {
      throw new ScopeViolationError("The IAM AccessBinding Role is invalid.");
    }
    this.assertNamespacePolicyResourceKind(input.resourceKind);
    if (!isNonEmptyString(input.resourceId)) {
      throw new ScopeViolationError("The IAM AccessBinding resource is invalid.");
    }
    const namespace = await this.admitIAMPolicyOperation(principalId, input.namespaceId);
    await this.authorize(principalId, "read", {
      kind: input.resourceKind,
      id: input.resourceId,
      namespaceId: namespace.id,
    });
    await this.verifyNamespacePolicyResource(namespace.id, input.resourceKind, input.resourceId);
    const driver = this.iamPolicyDriver("createNamespaceAccessBinding");
    return this.mutate((state) =>
      this.iamPolicyOperation(() =>
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
      ),
    );
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

  async deleteIAMAccessBinding(
    principalId: string,
    namespaceId: string,
    bindingId: string,
  ): Promise<void> {
    if (!isNonEmptyString(bindingId)) {
      throw new ScopeViolationError("The exact IAM AccessBinding identity is missing.");
    }
    const namespace = await this.admitIAMPolicyOperation(principalId, namespaceId);
    const driver = this.iamPolicyDriver("deleteNamespaceAccessBinding");
    const deleted = await this.mutate((state) =>
      this.iamPolicyOperation(() =>
        driver.deleteNamespaceAccessBinding!({ policy: state.iamPolicy }, namespace.id, bindingId),
      ),
    );
    if (!deleted) {
      throw new ScopeViolationError(
        "The IAM AccessBinding does not belong to the exact Namespace.",
      );
    }
  }

  async listAgents(principalId: string, namespaceId: string): Promise<readonly Readonly<Agent>[]> {
    const namespace = await this.getNamespace(principalId, namespaceId);
    return this.read(async (state) => {
      const readable: Readonly<Agent>[] = [];
      for (const agent of await state.agents.listAgents(namespace.id)) {
        if (
          await this.canRead(principalId, {
            kind: "agent",
            id: agent.id,
            namespaceId: namespace.id,
          })
        ) {
          readable.push(agent);
        }
      }
      return Object.freeze(readable);
    });
  }

  async listRepositoryOptions(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<RepositoryOption>[]> {
    const namespace = await this.read((state) => this.exactNamespace(state, namespaceId));
    if (namespace.status !== "provisioning" && namespace.status !== "ready") {
      throw new ResourceConflictError("The Namespace does not accept new Agents.");
    }
    await this.authorize(principalId, "create", {
      kind: "agent",
      id: namespace.id,
      namespaceId: namespace.id,
    });
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
    } catch {
      throw new RepositoryOptionsUnavailableError(
        "The selected Compute Driver cannot support repository options with this composition.",
      );
    }
    let driver: RepoDriver;
    try {
      driver = this.selectedDriver("repo");
    } catch {
      throw new RepositoryOptionsUnavailableError(
        "The selected repository credential Driver is unavailable.",
      );
    }
    let options: readonly RepositoryOption[];
    try {
      options = driver.listOptions({ namespaceId: namespace.id });
    } catch {
      throw new DependencyUnavailableError(
        "The selected repository credential Driver could not list repository options.",
      );
    }
    const selected = this.selections.get("repo");
    if (
      !Array.isArray(options) ||
      options.length > 128 ||
      !options.every(validRepositoryOption) ||
      new Set(options.map((option) => option.repositoryRef)).size !== options.length ||
      selected?.driver !== driver ||
      !this.unchangedDriver(selected)
    ) {
      throw new DependencyUnavailableError(
        "The selected repository credential Driver returned invalid repository options.",
      );
    }
    return immutableCopy(options);
  }

  async getAgent(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<Readonly<Agent>> {
    return this.getAuthorizedAgent(principalId, namespaceId, agentId, "read");
  }

  /** Resolve an opaque address before the caller authorizes the exact Agent operation. */
  async resolveAgentReference(
    matches: (agent: Pick<Agent, "id" | "namespaceId">) => boolean,
  ): Promise<Pick<Agent, "id" | "namespaceId"> | undefined> {
    return this.read(async (state) => {
      let selected: Pick<Agent, "id" | "namespaceId"> | undefined;
      for (const namespace of await state.namespaces.listNamespaces()) {
        for (const agent of await state.agents.listAgents(namespace.id)) {
          if (agent.namespaceId !== namespace.id || !matches(agent)) {
            continue;
          }
          if (selected !== undefined) {
            return undefined;
          }
          selected = { id: agent.id, namespaceId: agent.namespaceId };
        }
      }
      return selected;
    });
  }

  async getAdministerableAgent(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<Readonly<Agent>> {
    return this.getAuthorizedAgent(principalId, namespaceId, agentId, "administer");
  }

  private async getAuthorizedAgent(
    principalId: string,
    namespaceId: string,
    agentId: string,
    action: PermissionAction,
  ): Promise<Readonly<Agent>> {
    if (!isNonEmptyString(namespaceId)) {
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    }
    if (!isNonEmptyString(agentId)) {
      throw new ScopeViolationError("The exact Agent identity is missing.");
    }
    await this.authorize(principalId, action, {
      kind: "agent",
      id: agentId,
      namespaceId,
    });
    return this.read(async (state) => {
      const namespace = await this.exactNamespace(state, namespaceId);
      const agent = await state.agents.findAgent(namespace.id, agentId);
      if (!agent) {
        throw new ScopeViolationError(
          "The Agent does not belong to the exact Installation and Namespace.",
        );
      }
      return agent;
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
      const namespace = await this.exactNamespace(state, namespaceId);
      const agent = await state.agents.findAgent(namespace.id, agentId);
      if (!agent) {
        throw new ScopeViolationError(
          "The Agent does not belong to the exact Installation and Namespace.",
        );
      }
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
      await this.lockNamespace(state, namespaceId);
      await this.guardAgentProvisioning(state, namespaceId, agentId);
      const { namespace, agent, driver } = await this.admitAgentRuntimeCredentialProvisioning(
        principalId,
        namespaceId,
        agentId,
      );
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
  ): Promise<Readonly<ProvisionAgentResult>> {
    const requestId = requireProvisioningRequestId(input.requestId);
    if (!validName(input.name)) {
      throw new ScopeViolationError("The Agent name is invalid.");
    }
    const configurationInput = normalizeProvisioningConfiguration(input.configuration);
    const harnessAuth = normalizeProvisioningHarnessAuth(input.harnessAuth ?? null);
    const executionMode = input.executionMode ?? "embedded";
    if (!validExecutionMode(executionMode)) {
      throw new ScopeViolationError("The Agent Harness execution mode is invalid.");
    }
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
    compute.validateAgentProvisioning({ executionMode, configuration: configurationInput.values });
    if (harnessAuth === null || harnessAuth.method === "runtime") {
      throw new ScopeViolationError(
        "Agent provisioning requires dedicated Harness authentication.",
      );
    }
    const acceptedInput = Object.freeze({
      requestId,
      namespaceId: input.namespaceId,
      name: input.name,
      configuration: configurationInput,
      ...(workspace.initialWorkspaceFiles === undefined
        ? {}
        : { initialWorkspaceFiles: workspace.initialWorkspaceFiles }),
      ...(workspace.workspaceDefaultsId === undefined
        ? {}
        : { workspaceDefaultsId: workspace.workspaceDefaultsId }),
      ...(backendId === undefined ? {} : { backendId }),
      harnessAuth,
      executionMode,
      ...(plugins === undefined ? {} : { plugins }),
      ...(pluginApprovers === undefined ? {} : { pluginApprovers }),
      ...(input.repositoryBindings === undefined
        ? {}
        : { repositoryBindings: input.repositoryBindings }),
    });
    const requestFingerprintHex = createHash("sha256")
      .update(canonicalProvisioningJson(acceptedInput))
      .digest("hex");
    return this.mutate(async (state) => {
      const namespace = await this.lockNamespace(state, input.namespaceId);
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      const replay = await state.provisioning.findByRequest(namespace.id, principalId, requestId);
      if (replay !== undefined) {
        if (replay.requestFingerprint !== requestFingerprintHex) {
          throw new ResourceConflictError(
            "The Agent provisioning request ID has a different plan.",
          );
        }
        await this.authorizeProvisioningRecord(state, principalId, replay);
        const work = await state.operations.findWork(replay.workId);
        return Object.freeze({ provisioning: provisioningProgress(replay, work) });
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
      this.validatePluginPolicies(plugins, pluginApprovers);
      await this.authorizeProvisioningSecretSources(
        state,
        principalId,
        namespace.id,
        configurationInput.secretBindings,
        harnessAuth,
      );
      await configurationDriver.validate({
        id: "cfg_00000000-0000-4000-8000-000000000000",
        namespaceId: namespace.id,
        kind: "agent",
        generation: 1,
        values: configurationInput.values,
        ...(configurationInput.secretBindings === undefined
          ? {}
          : { secretBindings: configurationInput.secretBindings }),
        createdAt: this.timestamp(),
      });
      const repositoryBindings = this.repositoryBindingSelections(
        namespace.id,
        input.repositoryBindings,
      );
      const record = await state.provisioning.create({
        workId,
        namespaceId: namespace.id,
        actorId: principalId,
        requestId,
        requestFingerprint: requestFingerprintHex,
        plan: {
          name: input.name,
          configuration: configurationInput,
          harnessAuth,
          executionMode,
          ...(backendId === undefined ? {} : { backendId }),
          ...(plugins === undefined ? {} : { plugins }),
          ...(pluginApprovers === undefined ? {} : { pluginApprovers }),
          ...(repositoryBindings === undefined ? {} : { repositoryBindings }),
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
      });
      await this.authorizeProvisioningRecord(state, principalId, record.record);
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
      return Object.freeze({ provisioning: provisioningProgress(record.record) });
    });
  }

  async getAgentProvisioning(
    principalId: string,
    namespaceId: string,
    workId: string,
  ): Promise<Readonly<ProvisionAgentResult>> {
    return this.mutate(async (state) => {
      const record = await this.exactProvisioningWork(state, principalId, namespaceId, workId);
      const work = await state.operations.findWork(record.workId);
      if (work === undefined) {
        throw new DependencyUnavailableError("The provisioning work is unavailable.");
      }
      return Object.freeze({ provisioning: provisioningProgress(record, work) });
    });
  }

  async retryAgentProvisioning(
    principalId: string,
    namespaceId: string,
    workId: string,
  ): Promise<Readonly<ProvisionAgentResult>> {
    return this.mutate(async (state) => {
      const namespace = await this.lockNamespace(state, namespaceId);
      const record = await this.exactProvisioningWork(state, principalId, namespace.id, workId);
      if (record.actorId !== principalId) {
        throw new AuthorizationDeniedError("Only the initiating actor can retry provisioning.");
      }
      const agent =
        record.agentId === undefined
          ? undefined
          : await state.agents.lockAgent(namespace.id, record.agentId);
      if (namespace.status !== "ready") {
        throw new ResourceConflictError("The Agent lifecycle does not allow provisioning retry.");
      }
      if (
        agent !== undefined &&
        (agent.status !== "active" || agent.desiredRuntimeState !== "stopped")
      ) {
        throw new ResourceConflictError("The Agent lifecycle does not allow provisioning retry.");
      }
      if (
        record.status === "cancelled" ||
        record.revisionId !== undefined ||
        (record.agentId !== undefined &&
          (await state.revisions.listRevisions(namespaceId, record.agentId)).length !== 0)
      ) {
        throw new ResourceConflictError(
          "Provisioning cannot retry after cancellation or deployment handoff.",
        );
      }
      await this.authorizeProvisioningRecord(state, principalId, record);
      if (record.status === "queued" || record.status === "running") {
        const work = await state.operations.findWork(record.workId);
        return Object.freeze({ provisioning: provisioningProgress(record, work) });
      }
      const retried = await state.provisioning.retryByWorkId(namespaceId, workId, principalId);
      const work = await state.operations.findWork(record.workId);
      return Object.freeze({ provisioning: provisioningProgress(retried, work) });
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
      record = await this.checkpointAgentProvisioning(claim, {
        completedPhase: record.completedPhase,
        status: "running",
      });
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
          throw new ResourceConflictError(
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
          status: "succeeded",
          revisionId: revision.id,
        });
        return revision;
      });
      return Object.freeze({ outcome: "succeeded" as const, revisionId: revision.id });
    } catch (error) {
      if (error instanceof WorkClaimLostError) {
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
        !(error instanceof DependencyUnavailableError) &&
        (error instanceof ScopeViolationError ||
          error instanceof ResourceConflictError ||
          error instanceof AuthorizationDeniedError ||
          error instanceof AgentDeletingError ||
          error instanceof NamespaceNotReadyError)
      ) {
        code = "PROVISIONING_REJECTED";
      }
      const disposition =
        code === "PROVISIONING_DEPENDENCY_UNAVAILABLE" || code === "PROVISIONING_OUTCOME_UNKNOWN"
          ? "retry"
          : "permanent";
      const authorizationDenied =
        error instanceof AuthorizationDeniedError && !(error instanceof DependencyUnavailableError);
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
              ...current.progress,
              error: { code, message: "Agent provisioning could not complete." },
            },
          },
          {
            disposition,
            code,
            message: "Agent provisioning could not complete.",
          },
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
        outcome: disposition,
        code,
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
      const namespace = await this.exactNamespace(state, namespaceId);
      const agent = await state.agents.findAgent(namespace.id, agentId);
      if (!agent) {
        throw new ScopeViolationError(
          "The Agent does not belong to the exact Installation and Namespace.",
        );
      }
      return { namespace, agent, revision };
    });
    const driver = this.diagnosticsComputeDriver();
    if (
      driver.id !== revision.compute.id ||
      driver.implementation !== revision.compute.implementation
    ) {
      throw new DependencyUnavailableError("The deployment's Compute Driver is unavailable.");
    }
    let diagnostics: AgentDeploymentDiagnostics;
    try {
      diagnostics = await driver.diagnoseAgentDeployment!(binding);
    } catch {
      // Native Driver failures can contain private runtime or credential details.
      throw new DependencyUnavailableError("Runtime diagnostics are unavailable.");
    }
    return this.deploymentDiagnostics(diagnostics, revision.id);
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

  async listServiceAccounts(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<ServiceAccount>[]> {
    const namespace = await this.getNamespace(principalId, namespaceId);
    return this.read(async (state) => {
      const readable: Readonly<ServiceAccount>[] = [];
      for (const account of await state.serviceAccounts.listServiceAccounts(namespace.id)) {
        if (
          await this.canRead(principalId, {
            kind: "service_account",
            id: account.id,
            namespaceId: namespace.id,
          })
        ) {
          readable.push(account);
        }
      }
      return Object.freeze(readable);
    });
  }

  async listRevisions(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<readonly Readonly<AgentRevision>[]> {
    const agent = await this.getAgent(principalId, namespaceId, agentId);
    return this.read(async (state) => {
      const readable: Readonly<AgentRevision>[] = [];
      for (const revision of await state.revisions.listRevisions(agent.namespaceId, agent.id)) {
        if (
          await this.canRead(principalId, {
            kind: "agent_revision",
            id: revision.id,
            namespaceId: agent.namespaceId,
          })
        ) {
          readable.push(revision);
        }
      }
      return Object.freeze(readable);
    });
  }

  async getRevision(
    principalId: string,
    namespaceId: string,
    agentId: string,
    revisionId: string,
  ): Promise<Readonly<AgentRevision>> {
    if (!isNonEmptyString(namespaceId)) {
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    }
    if (!isNonEmptyString(agentId)) {
      throw new ScopeViolationError("The exact Agent identity is missing.");
    }
    if (!isNonEmptyString(revisionId)) {
      throw new ScopeViolationError("The exact AgentRevision identity is missing.");
    }
    return this.read(async (state) => {
      const namespace = await this.exactNamespace(state, namespaceId);
      const agent = await state.agents.findAgent(namespace.id, agentId);
      if (!agent) {
        throw new ScopeViolationError(
          "The Agent does not belong to the exact Installation and Namespace.",
        );
      }
      await this.authorize(principalId, "read", {
        kind: "agent_revision",
        id: revisionId,
        namespaceId: namespace.id,
      });
      const revision = await state.revisions.findRevision(namespace.id, agent.id, revisionId);
      if (!revision) {
        throw new ScopeViolationError(
          "The AgentRevision does not belong to the exact Agent and Namespace.",
        );
      }
      return revision;
    });
  }

  async getDeploymentStatus(
    principalId: string,
    namespaceId: string,
    agentId: string,
    deploymentId: string,
  ): Promise<DeploymentStatusResult> {
    const revision = await this.getRevision(principalId, namespaceId, agentId, deploymentId);
    return this.read(async (state) => {
      const idempotencyKey = `agent_revision:${revision.id}:reconcile`;
      const work = await state.operations.findWork(idempotencyKey);
      if (
        work === undefined ||
        work.namespaceId !== revision.namespaceId ||
        work.agentId !== revision.agentId ||
        work.revisionId !== revision.id
      ) {
        throw new DependencyUnavailableError(
          "The deployment reconciliation record is unavailable.",
        );
      }
      return Object.freeze({
        deploymentId: revision.id,
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        status: controllerWorkDeploymentStatus(work, this.clock()),
        error: deploymentErrorForWork(work),
        warnings: deploymentWarningsForWork(work),
      });
    });
  }

  async getReadableActiveAgentRevision(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<ActiveAgentRevisionSelection> {
    return this.getAuthorizedActiveAgentRevision(principalId, namespaceId, agentId, "read");
  }

  async getOperableActiveAgentRevision(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<ActiveAgentRevisionSelection> {
    return this.getAuthorizedActiveAgentRevision(principalId, namespaceId, agentId, "operate");
  }

  async getAdministerableActiveAgentRevision(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<ActiveAgentRevisionSelection> {
    return this.getAuthorizedActiveAgentRevision(principalId, namespaceId, agentId, "administer");
  }

  private async getAuthorizedActiveAgentRevision(
    principalId: string,
    namespaceId: string,
    agentId: string,
    action: PermissionAction,
  ): Promise<ActiveAgentRevisionSelection> {
    if (!isNonEmptyString(namespaceId)) {
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    }
    if (!isNonEmptyString(agentId)) {
      throw new ScopeViolationError("The exact Agent identity is missing.");
    }
    await this.authorize(principalId, action, {
      kind: "agent",
      id: agentId,
      namespaceId,
    });
    return this.read(async (state) => {
      const namespace = await this.exactNamespace(state, namespaceId);
      const agent = await state.agents.findAgent(namespace.id, agentId);
      if (!agent) {
        throw new ScopeViolationError(
          "The Agent does not belong to the exact Installation and Namespace.",
        );
      }
      if (action === "operate" && agent.status !== "active") {
        throw new AgentDeletingError();
      }
      if (action === "operate" && agent.desiredRuntimeState !== "running") {
        throw new ResourceConflictError(
          "The Agent workspace is not writable while it is stopping.",
        );
      }
      if (!isNonEmptyString(agent.activeRevisionId)) {
        if (action === "administer" && agent.desiredRuntimeState === "stopped") {
          throw new ResourceConflictError("A stopped Agent has no active gateway revision.");
        }
        throw new DependencyUnavailableError("The Agent has no active gateway revision.");
      }
      const revision = await state.revisions.findRevision(
        namespace.id,
        agent.id,
        agent.activeRevisionId,
      );
      if (!revision) {
        throw new DependencyUnavailableError("The active Agent revision is unavailable.");
      }
      return Object.freeze({ agent, revision });
    });
  }

  async createNamespace(
    principalId: string,
    input: CreateNamespaceInput,
  ): Promise<Readonly<Namespace>> {
    if (!validName(input.name)) {
      throw new ScopeViolationError("The Namespace name is invalid.");
    }
    return this.mutate(async (state) => {
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
          throw new ResourceConflictError(
            "Existing namespace adoption requires the bundled Kubernetes Compute Driver.",
          );
        }
        if (
          compute.implementation !== "occ/kubernetes" &&
          compute.implementation !== "kubernetes-local"
        ) {
          throw new ResourceConflictError(
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
      await this.ensureNamespaceDefaultPresets(state, principalId, namespace);
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

  /** Apply trusted Installation defaults without replacing Namespace-owned copies. */
  async initializeDefaultPresets(principalId: string): Promise<void> {
    if (this.defaultPresets.length === 0) {
      return;
    }
    await this.mutate(async (state) => {
      await this.authorize(principalId, "administer", {
        kind: "installation",
        id: this.installation.id,
      });
      const namespaces = [...(await state.namespaces.listNamespaces())].sort((a, b) =>
        a.id.localeCompare(b.id),
      );
      for (const namespace of namespaces) {
        const current = await state.namespaces.lockNamespace(namespace.id);
        if (current && ["provisioning", "ready"].includes(current.status)) {
          await this.ensureNamespaceDefaultPresets(state, principalId, current);
        }
      }
    });
  }

  private async ensureNamespaceDefaultPresets(
    state: PlatformUnitOfWork,
    principalId: string,
    namespace: Readonly<Namespace>,
  ): Promise<void> {
    if (this.defaultPresets.length === 0) {
      return;
    }
    const existing = new Set(
      (await state.presets.listPresets(namespace.id)).map((preset) => preset.name),
    );
    for (const preset of this.defaultPresets) {
      if (existing.has(preset.name)) {
        continue;
      }
      await this.authorize(principalId, "create", {
        kind: "preset",
        id: namespace.id,
        namespaceId: namespace.id,
      });
      const template = await this.admitPresetTemplate(preset.template, namespace.id);
      const created = await state.presets.createPreset({
        id: this.nextIdentifier("preset"),
        namespaceId: namespace.id,
        name: preset.name,
        template,
        createdAt: this.timestamp(),
      });
      await state.audit.append({
        id: `aud_${crypto.randomUUID()}`,
        installationId: this.installation.id,
        namespaceId: namespace.id,
        occurredAt: this.timestamp(),
        kind: "mutation",
        actorId: principalId,
        source: "occ",
        action: "openclaw.presets.create",
        resource: { kind: "preset", id: created.id, namespaceId: namespace.id },
        outcome: "success",
        details: { source: "installation-defaults" },
      });
    }
  }

  async createPreset(principalId: string, input: CreatePresetInput): Promise<Readonly<Preset>> {
    if (!validName(input.name)) {
      throw new PresetValidationError("The Preset name is invalid.");
    }
    return this.mutate(async (state) => {
      const namespace = await this.lockNamespace(state, input.namespaceId);
      await this.authorize(principalId, "create", {
        kind: "preset",
        id: namespace.id,
        namespaceId: namespace.id,
      });
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      const template = await this.admitPresetTemplate(input.template, namespace.id);
      return state.presets.createPreset({
        id: this.nextIdentifier("preset"),
        namespaceId: namespace.id,
        name: input.name,
        template,
        createdAt: this.timestamp(),
      });
    });
  }

  async listPresets(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<Preset>[]> {
    return this.read(async (state) => {
      const namespace = await this.exactNamespace(state, namespaceId);
      const readable: Readonly<Preset>[] = [];
      for (const preset of await state.presets.listPresets(namespace.id)) {
        if (
          await this.canRead(principalId, {
            kind: "preset",
            id: preset.id,
            namespaceId: namespace.id,
          })
        ) {
          readable.push(preset);
        }
      }
      return Object.freeze(readable);
    });
  }

  async getPreset(
    principalId: string,
    namespaceId: string,
    presetId: string,
  ): Promise<Readonly<Preset>> {
    await this.authorize(principalId, "read", { kind: "preset", id: presetId, namespaceId });
    return this.read(async (state) => {
      await this.exactNamespace(state, namespaceId);
      const preset = await state.presets.findPreset(namespaceId, presetId);
      if (!preset) {
        throw new ScopeViolationError("The Preset does not belong to the exact Namespace.");
      }
      return preset;
    });
  }

  async updatePreset(principalId: string, input: UpdatePresetInput): Promise<Readonly<Preset>> {
    if (input.name !== undefined && !validName(input.name)) {
      throw new PresetValidationError("The Preset name is invalid.");
    }
    return this.mutate(async (state) => {
      const namespace = await this.lockNamespace(state, input.namespaceId);
      await this.authorize(principalId, "update", {
        kind: "preset",
        id: input.presetId,
        namespaceId: namespace.id,
      });
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      if (!(await state.presets.lockPreset(namespace.id, input.presetId))) {
        throw new ScopeViolationError("The Preset does not belong to the exact Namespace.");
      }
      const template =
        input.template === undefined
          ? undefined
          : await this.admitPresetTemplate(input.template, namespace.id);
      const updated = await state.presets.updatePreset(namespace.id, input.presetId, {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(template === undefined ? {} : { template }),
      });
      if (!updated) {
        throw new ResourceConflictError("The Preset changed during update.");
      }
      return updated;
    });
  }

  async deletePreset(principalId: string, namespaceId: string, presetId: string): Promise<void> {
    return this.mutate(async (state) => {
      const namespace = await this.lockNamespace(state, namespaceId);
      await this.authorize(principalId, "delete", {
        kind: "preset",
        id: presetId,
        namespaceId: namespace.id,
      });
      if (!(await state.presets.lockPreset(namespace.id, presetId))) {
        throw new ScopeViolationError("The Preset does not belong to the exact Namespace.");
      }
      for (const binding of await state.iamPolicy.listAccessBindings(namespace.id)) {
        if (binding.resourceKind === "preset" && binding.resourceId === presetId) {
          await state.iamPolicy.deleteAccessBinding(namespace.id, binding.id);
        }
      }
      if (!(await state.presets.deletePreset(namespace.id, presetId))) {
        throw new ResourceConflictError("The Preset changed during deletion.");
      }
    });
  }

  private async admitPresetTemplate(
    input: PresetTemplate,
    namespaceId: string,
  ): Promise<PresetTemplate> {
    const template = normalizePresetTemplate(input, namespaceId);
    const values = presetTemplateDefaults(template).configuration?.values;
    if (values !== undefined) {
      const driver = this.configurationDriver();
      if (!driver.validateValues) {
        throw new DependencyUnavailableError(
          "The selected Configuration Driver cannot validate Preset values.",
        );
      }
      // Validation owns native credential rules; Preset CRUD never creates runtime resources.
      await driver.validateValues(values);
    }
    return template;
  }

  async createSecret(
    principalId: string,
    input: CreateSecretInput,
  ): Promise<Readonly<SecretMetadata>> {
    this.validateSecretValue(input.value);
    if (!validName(input.name)) {
      throw new ScopeViolationError("The Secret name is invalid.");
    }
    return this.mutate(async (state) => {
      const namespace = await this.lockNamespace(state, input.namespaceId);
      await this.authorize(principalId, "create", {
        kind: "secret",
        id: namespace.id,
        namespaceId: namespace.id,
      });
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
      return this.secretMetadata(secret);
    });
  }

  async readSecret(
    principalId: string,
    namespaceId: string,
    secretId: string,
  ): Promise<Readonly<SecretMetadata>> {
    await this.authorize(principalId, "read", { kind: "secret", id: secretId, namespaceId });
    return this.read(async (state) => {
      await this.exactNamespace(state, namespaceId);
      const secret = await state.secrets.findSecret(namespaceId, secretId);
      if (!secret) {
        throw new ScopeViolationError("The Secret does not belong to the exact Namespace.");
      }
      return this.secretMetadata(secret);
    });
  }

  async listSecrets(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<SecretMetadata>[]> {
    return this.read(async (state) => {
      const namespace = await this.exactNamespace(state, namespaceId);
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

  async updateSecret(
    principalId: string,
    input: UpdateSecretInput,
  ): Promise<Readonly<SecretMetadata>> {
    this.validateSecretValue(input.value);
    return this.mutate(async (state) => {
      const namespace = await this.lockNamespace(state, input.namespaceId);
      await this.authorize(principalId, "update", {
        kind: "secret",
        id: input.secretId,
        namespaceId: namespace.id,
      });
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      const secret = await state.secrets.lockSecret(namespace.id, input.secretId);
      if (!secret) {
        throw new ScopeViolationError("The Secret does not belong to the exact Namespace.");
      }
      const driver = this.secretDriver(secret.driverId);
      // No prior value is read or retained for rollback. Success means stored, not delivered.
      await this.secretOperation(() => driver.update(secret, input.value));
      return this.secretMetadata(secret);
    });
  }

  async deleteSecret(principalId: string, namespaceId: string, secretId: string): Promise<void> {
    return this.mutate(async (state) => {
      const namespace = await this.lockNamespace(state, namespaceId);
      await this.authorize(principalId, "delete", {
        kind: "secret",
        id: secretId,
        namespaceId: namespace.id,
      });
      const secret = await state.secrets.lockSecret(namespace.id, secretId);
      if (!secret) {
        throw new ScopeViolationError("The Secret does not belong to the exact Namespace.");
      }
      if (await state.secrets.hasReferences(namespace.id, secret.id)) {
        throw new ResourceConflictError(
          "A Configuration, active revision, or pending deployment still references the Secret.",
        );
      }
      const driver = this.secretDriver(secret.driverId);
      await this.secretOperation(() => driver.delete(secret));
      if (!(await state.secrets.deleteSecret(namespace.id, secret.id))) {
        throw new ResourceConflictError("The Secret changed during deletion.");
      }
    });
  }

  /**
   * Registration records the source as `registering` before the gateway write, so an uncertain
   * gateway outcome always leaves a record an operator can list and delete. `audit` builds the
   * success event, committed with the transition to `ready`.
   */
  async createCredentialSource(
    principalId: string,
    input: CreateCredentialSourceInput,
    audit?: (source: Readonly<CredentialSourceMetadata>) => AuditEvent,
  ): Promise<Readonly<CredentialSourceMetadata & { readonly status?: CredentialSourceStatus }>> {
    this.assertCredentialSourceTransactionBoundary();
    if (!validName(input.name)) {
      throw new ScopeViolationError("The credential source name is invalid.");
    }
    const config = Object.freeze({ ...(input.config ?? {}) });
    const secretRefs = Object.freeze({ ...(input.secrets ?? {}) });
    const { namespace, gateway, source, values } = await this.mutate(async (state) => {
      const locked = await this.lockNamespace(state, input.namespaceId);
      await this.authorize(principalId, "create", {
        kind: "credential_source",
        id: locked.id,
        namespaceId: locked.id,
      });
      if (locked.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      const selected = this.credentialGatewayDriver();
      const type = await this.credentialSourceType(selected, input.type);
      credentialSourceFieldsMatch("config", type.config, config);
      credentialSourceFieldsMatch("secrets", type.secrets, secretRefs);
      const read: Record<string, string> = {};
      for (const [field, reference] of Object.entries(secretRefs)) {
        if (reference.namespaceId !== locked.id) {
          throw new ScopeViolationError("Credential source Secrets cannot cross Namespaces.");
        }
        await this.authorize(principalId, "operate", reference);
        const secret = await state.secrets.lockSecret(locked.id, reference.id);
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
        read[field] = await this.secretOperation(() => withValue(secret, async (value) => value));
      }
      const registering = await state.credentialSources.createCredentialSource(
        Object.freeze({
          id: this.nextIdentifier("credential_source"),
          namespaceId: locked.id,
          name: input.name,
          type: type.type,
          config,
          secrets: secretRefs,
          driverId: selected.id,
          state: "registering",
          createdAt: this.timestamp(),
        }),
      );
      return { namespace: locked, gateway: selected, source: registering, values: read };
    });
    const placed = await this.credentialNamespace(namespace);
    let status: CredentialSourceStatus;
    // A returned result means every gateway effect of this attempt has finished; a throw does not.
    let terminal = false;
    try {
      status = await this.credentialGatewayOperation(() =>
        gateway.registerSource(
          {
            namespace: placed,
            source,
            signal: AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS),
          },
          { type: source.type, config, secrets: values },
        ),
      );
      terminal = true;
      if (status.state === "failed" || status.state === "absent") {
        throw new DependencyUnavailableError("The Credential Gateway did not store the source.");
      }
    } catch (error) {
      await this.abandonCredentialRegistration(placed, gateway, source, terminal);
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
      // A concurrent deletion won; remove the copy this registration may have stored after it.
      await this.abandonCredentialRegistration(placed, gateway, source, true);
      throw new ResourceConflictError("The credential source changed during registration.");
    }
    return this.credentialSourceMetadata(ready, status);
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
  ): Promise<void> {
    let removed = true;
    try {
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
      if (!found) {
        throw new ScopeViolationError(
          "The credential source does not belong to the exact Namespace.",
        );
      }
      return { namespace: exact, source: found };
    });
    let status: CredentialSourceStatus;
    try {
      const gateway = this.credentialGatewayDriver(source.driverId);
      status = await gateway.sourceStatus({
        namespace: await this.credentialNamespace(namespace),
        source,
        signal: AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS),
      });
    } catch {
      status = { state: "failed", reason: "The Credential Gateway status is unavailable." };
    }
    return this.credentialSourceMetadata(source, status);
  }

  async listCredentialSources(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<CredentialSourceMetadata>[]> {
    return this.read(async (state) => {
      const namespace = await this.exactNamespace(state, namespaceId);
      const readable: Readonly<CredentialSourceMetadata>[] = [];
      for (const source of await state.credentialSources.listCredentialSources(namespace.id)) {
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
   * which keeps the Namespace nonempty and blocks new bindings in the meantime.
   */
  async deleteCredentialSource(
    principalId: string,
    namespaceId: string,
    credentialSourceId: string,
    audit?: () => AuditEvent,
  ): Promise<void> {
    this.assertCredentialSourceTransactionBoundary();
    const { namespace, source } = await this.mutate(async (state) => {
      const locked = await this.lockNamespace(state, namespaceId);
      await this.authorize(principalId, "delete", {
        kind: "credential_source",
        id: credentialSourceId,
        namespaceId: locked.id,
      });
      const found = await state.credentialSources.lockCredentialSource(
        locked.id,
        credentialSourceId,
      );
      if (!found) {
        throw new ScopeViolationError(
          "The credential source does not belong to the exact Namespace.",
        );
      }
      if (await state.credentialSources.hasReferences(locked.id, found.id)) {
        throw new ResourceConflictError(
          "An Agent, active revision, or pending deployment still references the credential source.",
        );
      }
      const deleting =
        found.state === "deleting"
          ? found
          : await state.credentialSources.markCredentialSourceDeleting(locked.id, found.id);
      if (deleting === undefined) {
        throw new ResourceConflictError("The credential source changed during deletion.");
      }
      return { namespace: locked, source: deleting };
    });
    const gateway = this.credentialGatewayDriver(source.driverId);
    const placed = await this.credentialNamespace(namespace);
    await this.credentialGatewayOperation(() =>
      gateway.removeSource({
        namespace: placed,
        source,
        signal: AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS),
      }),
    );
    if (this.clock().getTime() < Date.parse(source.createdAt) + CREDENTIAL_REGISTRATION_FENCE_MS) {
      throw new DependencyUnavailableError(
        "The credential source registration may still be completing; retry the deletion shortly.",
      );
    }
    // The success event commits with the final removal, so a completed deletion is always audited.
    await this.mutate(async (state) => {
      await this.lockNamespace(state, namespace.id);
      if (!(await state.credentialSources.deleteCredentialSource(namespace.id, source.id))) {
        throw new ResourceConflictError("The credential source changed during deletion.");
      }
      if (audit !== undefined) {
        await state.audit.append(audit());
      }
    });
  }

  async createConfiguration(
    principalId: string,
    input: CreateConfigurationInput,
  ): Promise<Readonly<Configuration>> {
    if (input.kind !== "agent") {
      throw new ScopeViolationError("The Configuration kind must identify an Agent.");
    }
    const values = frozenValues(input.values);
    return this.mutate(async (state) => {
      const namespace = await this.lockNamespace(state, input.namespaceId);
      if (namespace.status !== "provisioning" && namespace.status !== "ready") {
        throw new ResourceConflictError("The Namespace does not accept new Configurations.");
      }
      await this.authorize(principalId, "create", {
        kind: "configuration",
        id: namespace.id,
        namespaceId: namespace.id,
      });
      if (namespace.existingNamespace !== undefined && namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      const secretBindings = this.bindings(input.secretBindings);
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
      await driver.validate(configuration);
      const metadata = await state.configurations.createConfiguration({
        id: configuration.id,
        namespaceId: namespace.id,
        kind: configuration.kind,
        generation: configuration.generation,
        ...(Object.keys(secretBindings).length === 0 ? {} : { secretBindings }),
        createdAt: configuration.createdAt,
      });
      const result = await this.driverOperation(() => driver.create(configuration));
      this.registerRollback(async () =>
        driver.delete({ id: configuration.id, namespaceId: configuration.namespaceId }),
      );
      return this.exactConfiguration(result, metadata);
    });
  }

  async createServiceAccount(
    principalId: string,
    input: CreateServiceAccountInput,
  ): Promise<Readonly<ServiceAccount>> {
    if (!validName(input.name)) {
      throw new ScopeViolationError("The ServiceAccount name is invalid.");
    }
    return this.mutate(async (state) => {
      const namespace = await this.exactNamespace(state, input.namespaceId);
      if (namespace.status !== "provisioning" && namespace.status !== "ready") {
        throw new ResourceConflictError("The Namespace does not accept new ServiceAccounts.");
      }
      await this.authorize(principalId, "create", {
        kind: "service_account",
        id: namespace.id,
        namespaceId: namespace.id,
      });
      const account = await state.serviceAccounts.createServiceAccount({
        id: this.nextIdentifier("service_account"),
        namespaceId: namespace.id,
        name: input.name,
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
      const namespace = await this.exactNamespace(state, namespaceId);
      await this.authorize(principalId, "update", {
        kind: "service_account",
        id: serviceAccountId,
        namespaceId: namespace.id,
      });
      const account = await state.serviceAccounts.lockServiceAccount(
        namespace.id,
        serviceAccountId,
      );
      if (account === undefined) {
        throw new ScopeViolationError("The ServiceAccount does not belong to the exact Namespace.");
      }
      if (account.credential !== undefined) {
        throw new ResourceConflictError("The ServiceAccount already has a credential.");
      }
      const driver = this.serviceAccountDriver();
      if (driver === undefined) {
        throw new DependencyUnavailableError("The selected ServiceAccount Driver is unavailable.");
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
        throw new ResourceConflictError("The ServiceAccount credential changed during its update.");
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
      const namespace = await this.exactNamespace(state, namespaceId);
      await this.authorize(principalId, "update", {
        kind: "service_account",
        id: serviceAccountId,
        namespaceId: namespace.id,
      });
      const account = await state.serviceAccounts.lockServiceAccount(
        namespace.id,
        serviceAccountId,
      );
      if (account === undefined) {
        throw new ScopeViolationError("The ServiceAccount does not belong to the exact Namespace.");
      }
      if (account.credential?.kind === "access_token" || credential.kind === "access_token") {
        throw new ResourceConflictError(
          "A managed ServiceAccount credential cannot be manually updated.",
        );
      }
      const updated = await state.serviceAccounts.updateCredential(
        namespace.id,
        account.id,
        credential,
      );
      if (updated === undefined) {
        throw new ResourceConflictError("The ServiceAccount credential changed during its update.");
      }
      return updated;
    });
  }

  async deleteServiceAccount(
    principalId: string,
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<void> {
    this.serviceAccountIdentity(namespaceId, serviceAccountId);
    return this.mutate(async (state) => {
      const namespace = await this.lockNamespace(state, namespaceId);
      await this.authorize(principalId, "delete", {
        kind: "service_account",
        id: serviceAccountId,
        namespaceId: namespace.id,
      });
      const account = await state.serviceAccounts.lockServiceAccount(
        namespace.id,
        serviceAccountId,
      );
      if (account === undefined) {
        throw new ScopeViolationError("The ServiceAccount does not belong to the exact Namespace.");
      }
      if (await state.serviceAccounts.hasReferences(namespace.id, account.id)) {
        throw new ResourceConflictError(
          "An Agent draft, active revision, or pending deployment still references the exact ServiceAccount.",
        );
      }
      const driver = this.serviceAccountDriver();
      if (account.credential?.kind === "access_token" && driver === undefined) {
        throw new DependencyUnavailableError("The selected ServiceAccount Driver is unavailable.");
      }
      if (driver !== undefined) {
        await this.driverOperation(() => driver.delete(account), "ServiceAccount");
      }
      if (!(await state.serviceAccounts.deleteServiceAccount(namespace.id, account.id))) {
        throw new ResourceConflictError("The ServiceAccount changed during deletion.");
      }
    });
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

  async updateConfiguration(
    principalId: string,
    input: UpdateConfigurationInput,
  ): Promise<Readonly<Configuration>> {
    this.configurationIdentity(input.namespaceId, input.configurationId);
    if (Object.hasOwn(input, "kind")) {
      throw new ScopeViolationError("The Configuration kind cannot be changed.");
    }
    const values = frozenValues(input.values);
    return this.mutate(async (state) => {
      const namespace = await this.lockNamespace(state, input.namespaceId);
      await this.authorize(principalId, "update", {
        kind: "configuration",
        id: input.configurationId,
        namespaceId: namespace.id,
      });
      const driver = this.configurationDriver();
      const metadata = await state.configurations.lockConfiguration(
        namespace.id,
        input.configurationId,
      );
      if (!metadata) {
        throw new ScopeViolationError("The Configuration does not belong to the exact Namespace.");
      }
      await this.guardProvisioningConfiguration(state, namespace.id, input.configurationId);
      const previous = this.exactConfiguration(
        await this.driverOperation(() =>
          driver.read({ id: metadata.id, namespaceId: namespace.id }),
        ),
        metadata,
      );
      const secretBindings = this.bindings(
        input.secretBindings === undefined ? metadata.secretBindings : input.secretBindings,
      );
      await this.authorizeBindings(state, principalId, namespace.id, secretBindings);
      const advanced = await state.configurations.advanceConfigurationGeneration(
        namespace.id,
        metadata.id,
        metadata.generation,
        secretBindings,
      );
      if (!advanced) {
        throw new ResourceConflictError("The Configuration generation changed during its update.");
      }
      const configuration: Configuration = Object.freeze({
        id: advanced.id,
        namespaceId: advanced.namespaceId,
        kind: advanced.kind,
        generation: advanced.generation,
        values,
        createdAt: advanced.createdAt,
      });
      await driver.validate(configuration);
      const updated = await this.driverOperation(() => driver.update(configuration));
      this.registerRollback(async () => {
        await driver.update(previous);
      });
      return this.exactConfiguration(updated, advanced);
    });
  }

  async deleteConfiguration(
    principalId: string,
    namespaceId: string,
    configurationId: string,
  ): Promise<void> {
    this.configurationIdentity(namespaceId, configurationId);
    return this.mutate(async (state) => {
      const namespace = await this.lockNamespace(state, namespaceId);
      await this.authorize(principalId, "delete", {
        kind: "configuration",
        id: configurationId,
        namespaceId: namespace.id,
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
        throw new ResourceConflictError("An Agent still references the exact Configuration.");
      }
      const previous = this.exactConfiguration(
        await this.driverOperation(() =>
          driver.read({ id: configuration.id, namespaceId: namespace.id }),
        ),
        configuration,
      );
      await this.driverOperation(() =>
        driver.delete({ id: configuration.id, namespaceId: namespace.id }),
      );
      this.registerRollback(async () => {
        await driver.create(previous);
      });
      if (!(await state.configurations.deleteConfiguration(namespace.id, configuration.id))) {
        throw new ResourceConflictError("The Configuration changed during deletion.");
      }
    });
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
      throw new NotImplementedError("Model discovery is unavailable. Enter a model ID manually.");
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
    input: PluginDiscoveryCredential & { readonly cursor?: string; readonly q?: string },
    signal?: AbortSignal,
  ): Promise<PluginCatalogPage> {
    await this.authorize(principalId, "create", { kind: "agent", id: namespaceId, namespaceId });
    await this.read((state) => this.exactNamespace(state, namespaceId));
    return this.withPluginDiscoveryCredential(principalId, namespaceId, input, () => {
      const driver = this.pluginDriver();
      if (!driver.discoverCatalog) {
        throw new NotImplementedError(
          "agent_plugins.discovery",
          "Plugin discovery is unavailable.",
        );
      }
      return (accessToken) => {
        if (accessToken === undefined && driver.discoveryCredential !== "none") {
          throw new PluginDiscoveryError("credentials_rejected");
        }
        return driver.discoverCatalog!(
          {
            ...(accessToken === undefined ? {} : { accessToken }),
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
            ...(input.q === undefined ? {} : { q: input.q }),
          },
          signal,
        );
      };
    });
  }

  async lookupChannelDirectory(
    principalId: string,
    namespaceId: string,
    input: LookupChannelDirectoryInput,
    signal?: AbortSignal,
  ): Promise<ChannelDirectoryResult> {
    const ids = input.ids;
    const bounded = (value: unknown, max: number, allowEmpty = false): value is string =>
      typeof value === "string" &&
      (allowEmpty || value.length > 0) &&
      value.length <= max &&
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
              id.length > 200 ||
              hasControlCharacters(id),
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
              validationError: new ResourceConflictError(
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
    input: PluginDiscoveryCredential & { readonly pluginId: string },
    signal?: AbortSignal,
  ): Promise<PluginCatalogEntry> {
    await this.authorize(principalId, "create", { kind: "agent", id: namespaceId, namespaceId });
    await this.read((state) => this.exactNamespace(state, namespaceId));
    return this.withPluginDiscoveryCredential(principalId, namespaceId, input, () => {
      const driver = this.pluginDriver();
      if (!driver.getCatalogPlugin) {
        throw new NotImplementedError(
          "agent_plugins.discovery",
          "Plugin tool discovery is unavailable.",
        );
      }
      return (accessToken) => {
        if (accessToken === undefined && driver.discoveryCredential !== "none") {
          throw new PluginDiscoveryError("credentials_rejected");
        }
        return driver.getCatalogPlugin!(
          { ...(accessToken === undefined ? {} : { accessToken }), pluginId: input.pluginId },
          signal,
        );
      };
    });
  }

  private async withPluginDiscoveryCredential<T>(
    principalId: string,
    namespaceId: string,
    credential: PluginDiscoveryCredential,
    prepareDiscovery: () => (accessToken: string | undefined) => Promise<T>,
    validateCurrent?: () => Promise<void>,
  ): Promise<T> {
    const source = credential.secretRef;
    if (source !== undefined) {
      if (source.kind !== "secret" || source.namespaceId !== namespaceId) {
        throw new ScopeViolationError("Secret references cannot cross Namespaces.");
      }
      await this.authorize(principalId, "operate", source);
    }
    // Do not reveal Driver support before authorization or read a value for unsupported discovery.
    const discover = prepareDiscovery();
    // Keep both upstream errors and accidentally echoed credential material out of responses.
    const invoke = async (
      accessToken: string | undefined,
    ): Promise<{ value: T } | { error: PluginDiscoveryError } | { validationError: unknown }> => {
      try {
        await validateCurrent?.();
      } catch (error) {
        // Return authorization and binding errors through the Secret callback so
        // secretOperation only sanitizes backend failures, not these exact checks.
        return { validationError: error };
      }
      try {
        const value = await discover(accessToken);
        const serialized = JSON.stringify(value);
        const encodedToken =
          accessToken === undefined ? undefined : JSON.stringify(accessToken).slice(1, -1);
        if (
          serialized === undefined ||
          (encodedToken !== undefined &&
            (encodedToken.length === 0 || serialized.includes(encodedToken)))
        ) {
          throw new PluginDiscoveryError("invalid_response");
        }
        return { value };
      } catch (error) {
        return {
          error: new PluginDiscoveryError(
            error instanceof PluginDiscoveryError ? error.reason : "unavailable",
          ),
        };
      }
    };

    let outcome: { value: T } | { error: PluginDiscoveryError } | { validationError: unknown };
    if (credential.accessToken !== undefined) {
      outcome = await invoke(credential.accessToken);
    } else if (credential.secretRef !== undefined) {
      const source = credential.secretRef;
      const secret = await this.read(async (state) => {
        const found = await state.secrets.findSecret(namespaceId, source.id);
        if (!found) {
          throw new ScopeViolationError("The Secret does not belong to the exact Namespace.");
        }
        return found;
      });
      const driver = this.secretDriver(secret.driverId);
      if (!driver.withValue) {
        throw new DependencyUnavailableError(
          "The selected Secret Driver cannot use credentials for discovery.",
        );
      }
      // No platform transaction is held over backend or provider I/O; each request reads the current value.
      outcome = await this.secretOperation(() => driver.withValue!(secret, invoke));
    } else {
      outcome = await invoke(undefined);
    }
    if ("error" in outcome) {
      throw outcome.error;
    }
    if ("validationError" in outcome) {
      throw outcome.validationError;
    }
    return outcome.value;
  }

  async getSavedAgentPluginPolicyCapabilities(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ) {
    const resource = { kind: "agent" as const, id: agentId, namespaceId };
    await this.authorize(principalId, "read", resource);
    await this.authorize(principalId, "update", resource);
    return this.read(async (state) => {
      const namespace = await this.exactNamespace(state, namespaceId);
      const agent = await state.agents.findAgent(namespace.id, agentId);
      if (agent === undefined) {
        throw new ScopeViolationError(
          "The Agent does not belong to the exact Installation and Namespace.",
        );
      }
      if (agent.status !== "active") {
        throw new AgentDeletingError();
      }
      const driver = this.pluginDriver();
      return immutableCopy({
        driver: { id: driver.id, implementation: driver.implementation },
        ...driver.policyCapabilities,
        discoveryCredential: driver.discoveryCredential ?? "required",
      });
    });
  }

  async discoverSavedAgentPlugins(
    principalId: string,
    namespaceId: string,
    agentId: string,
    input: { readonly cursor?: string; readonly q?: string },
    signal?: AbortSignal,
  ): Promise<PluginCatalogPage> {
    return this.withSavedAgentPluginCredential(principalId, namespaceId, agentId, () => {
      const driver = this.pluginDriver();
      if (!driver.discoverCatalog) {
        throw new NotImplementedError(
          "agent_plugins.discovery",
          "Plugin discovery is unavailable.",
        );
      }
      return (accessToken) =>
        driver.discoverCatalog!(
          { ...(accessToken === undefined ? {} : { accessToken }), ...input },
          signal,
        );
    });
  }

  async discoverSavedAgentPluginDetails(
    principalId: string,
    namespaceId: string,
    agentId: string,
    input: { readonly pluginId: string },
    signal?: AbortSignal,
  ): Promise<PluginCatalogEntry> {
    return this.withSavedAgentPluginCredential(principalId, namespaceId, agentId, () => {
      const driver = this.pluginDriver();
      if (!driver.getCatalogPlugin) {
        throw new NotImplementedError(
          "agent_plugins.discovery",
          "Plugin tool discovery is unavailable.",
        );
      }
      return (accessToken) =>
        driver.getCatalogPlugin!(
          { ...(accessToken === undefined ? {} : { accessToken }), pluginId: input.pluginId },
          signal,
        );
    });
  }

  private async withSavedAgentPluginCredential<T>(
    principalId: string,
    namespaceId: string,
    agentId: string,
    prepareDiscovery: () => (accessToken: string | undefined) => Promise<T>,
  ): Promise<T> {
    const first = await this.boundAgentPluginSecret(principalId, namespaceId, agentId);
    if (first === undefined) {
      return this.withPluginDiscoveryCredential(principalId, namespaceId, {}, prepareDiscovery);
    }
    return this.withPluginDiscoveryCredential(
      principalId,
      namespaceId,
      { secretRef: { kind: "secret", id: first.id, namespaceId } },
      prepareDiscovery,
      async () => {
        // The backend read crosses an async boundary. Recheck the Agent binding
        // and both grants immediately before calling the external plugin service.
        const current = await this.boundAgentPluginSecret(principalId, namespaceId, agentId);
        if (
          current === undefined ||
          current.id !== first.id ||
          current.driverId !== first.driverId ||
          current.backendRef.uid !== first.backendRef.uid ||
          current.backendRef.name !== first.backendRef.name ||
          current.backendRef.namespaceName !== first.backendRef.namespaceName ||
          current.backendRef.key !== first.backendRef.key
        ) {
          throw new ResourceConflictError(
            "The Agent's plugin credential changed. Refresh and retry.",
          );
        }
      },
    );
  }

  private async boundAgentPluginSecret(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<Readonly<Secret> | undefined> {
    const resource = { kind: "agent" as const, id: agentId, namespaceId };
    await this.authorize(principalId, "read", resource);
    await this.authorize(principalId, "update", resource);
    return this.read(async (state) => {
      const namespace = await this.exactNamespace(state, namespaceId);
      const agent = await state.agents.findAgent(namespace.id, agentId);
      if (agent === undefined) {
        throw new ScopeViolationError(
          "The Agent does not belong to the exact Installation and Namespace.",
        );
      }
      if (agent.status !== "active") {
        throw new AgentDeletingError();
      }
      // Credential-free discovery still requires the exact active Agent and caller's edit grants.
      if (this.pluginDriver().discoveryCredential === "none") {
        if (agent.executionMode !== "dedicated") {
          throw new NotImplementedError(
            "agent_plugins.saved_discovery",
            "Saved plugin discovery requires a dedicated Agent.",
          );
        }
        return undefined;
      }
      const binding = this.harnessAuthBinding(agent.harnessAuth);
      if (agent.executionMode !== "dedicated" || binding?.method !== "codex_pat") {
        throw new NotImplementedError(
          "agent_plugins.saved_discovery",
          "Stored plugin discovery requires a dedicated Agent with a Service Accounts Secret.",
        );
      }
      if (binding.source.namespaceId !== namespace.id) {
        throw new ScopeViolationError("The Agent's plugin credential crosses Namespaces.");
      }
      await this.authorize(principalId, "operate", binding.source);
      await this.authorize(agent.servicePrincipalId, "operate", binding.source);
      const secret = await state.secrets.findSecret(namespace.id, binding.source.id);
      if (secret === undefined) {
        throw new ScopeViolationError("The Agent's plugin credential is unavailable.");
      }
      return secret;
    });
  }

  async createAgent(principalId: string, input: CreateAgentInput): Promise<Readonly<Agent>> {
    if (!validName(input.name)) {
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
    const executionMode = input.executionMode ?? "embedded";
    if (!validExecutionMode(executionMode)) {
      throw new ScopeViolationError("The Agent Harness execution mode is invalid.");
    }
    const backendId = this.backendId(input.backendId);
    const plugins = normalizeAgentPlugins(input.plugins);
    const pluginApprovers = normalizeAgentPluginApprovers(input.pluginApprovers);
    return this.mutate(async (state) => {
      const namespace = await this.lockNamespace(state, input.namespaceId);
      if (namespace.status !== "provisioning" && namespace.status !== "ready") {
        throw new ResourceConflictError("The Namespace does not accept new Agents.");
      }
      const target: ResourceRef = {
        kind: "agent",
        id: namespace.id,
        namespaceId: namespace.id,
      };
      await this.authorize(principalId, "create", target);
      await this.authorize(principalId, "read", {
        kind: "configuration",
        id: input.configurationId,
        namespaceId: namespace.id,
      });
      const configuration = await state.configurations.findConfiguration(
        namespace.id,
        input.configurationId,
      );
      if (!configuration || configuration.kind !== "agent") {
        throw new ScopeViolationError(
          "The Agent Configuration must belong to the exact Namespace and configure an Agent.",
        );
      }
      await this.guardProvisioningConfiguration(state, namespace.id, input.configurationId);
      await this.authorizeHarnessAuthSource(state, principalId, namespace.id, harnessAuth);
      this.validatePluginPolicies(plugins, pluginApprovers);
      const agentId = this.nextIdentifier("agent");
      await this.authorizeBindings(
        state,
        principalId,
        namespace.id,
        this.bindings(configuration.secretBindings),
      );
      const repositoryBindings = this.repositoryBindingSelections(
        namespace.id,
        input.repositoryBindings,
      );

      const agent = await state.agents.createAgent({
        id: agentId,
        namespaceId: namespace.id,
        name: input.name,
        configurationId: input.configurationId,
        backendId,
        harnessAuth,
        executionMode,
        ...(plugins === undefined ? {} : { plugins }),
        ...(pluginApprovers === undefined ? {} : { pluginApprovers }),
        ...(repositoryBindings === undefined ? {} : { repositoryBindings }),
        servicePrincipalId: `service-agent-${agentId}`,
        desiredRuntimeState: "stopped",
        status: "active",
        createdAt: this.timestamp(),
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

  async updateAgent(principalId: string, input: UpdateAgentInput): Promise<Readonly<Agent>> {
    if (!isNonEmptyString(input.agentId)) {
      throw new ScopeViolationError("The exact Agent identity is missing.");
    }
    if (!isNonEmptyString(input.configurationId)) {
      throw new ScopeViolationError("The exact Agent Configuration identity is missing.");
    }
    const requestedAuth =
      input.harnessAuth === undefined ? undefined : this.harnessAuthBinding(input.harnessAuth);
    if (input.executionMode !== undefined && !validExecutionMode(input.executionMode)) {
      throw new ScopeViolationError("The Agent Harness execution mode is invalid.");
    }
    const plugins = normalizeAgentPlugins(input.plugins);
    const pluginApprovers =
      input.pluginApprovers === null ? null : normalizeAgentPluginApprovers(input.pluginApprovers);
    return this.mutate(async (state) => {
      const namespace = await this.lockNamespace(state, input.namespaceId);
      const agent = await state.agents.lockAgent(namespace.id, input.agentId);
      if (!agent) {
        throw new ScopeViolationError(
          "The Agent does not belong to the exact Installation and Namespace.",
        );
      }
      await this.authorize(principalId, "update", {
        kind: "agent",
        id: agent.id,
        namespaceId: namespace.id,
      });
      if (agent.status !== "active") {
        throw new AgentDeletingError();
      }
      await this.authorize(principalId, "read", {
        kind: "configuration",
        id: input.configurationId,
        namespaceId: namespace.id,
      });
      const configuration = await state.configurations.findConfiguration(
        namespace.id,
        input.configurationId,
      );
      if (!configuration || configuration.kind !== "agent") {
        throw new ScopeViolationError(
          "The Agent Configuration must belong to the exact Namespace and configure an Agent.",
        );
      }
      await this.guardAgentProvisioning(state, namespace.id, agent.id);
      await this.guardProvisioningConfiguration(state, namespace.id, input.configurationId);
      const previousAuth = this.harnessAuthBinding(agent.harnessAuth);
      await this.authorizeHarnessAuthSource(state, principalId, namespace.id, previousAuth);
      if (requestedAuth !== undefined) {
        await this.authorizeHarnessAuthSource(state, principalId, namespace.id, requestedAuth);
      }
      const secretBindings = this.bindings(configuration.secretBindings);
      await this.authorizeBindings(state, principalId, namespace.id, secretBindings);
      const backendId = this.backendId(input.backendId, agent.backendId);
      const repositoryBindings =
        input.repositoryBindings === undefined
          ? undefined
          : (this.repositoryBindingSelections(namespace.id, input.repositoryBindings) ?? []);
      this.validatePluginPolicies(
        plugins ?? agent.plugins,
        pluginApprovers === null ? undefined : (pluginApprovers ?? agent.pluginApprovers),
      );
      const updated = await state.agents.updateConfiguration(
        namespace.id,
        agent.id,
        input.configurationId,
        input.executionMode,
        requestedAuth,
        input.backendId === undefined ? undefined : backendId,
        plugins,
        repositoryBindings,
        pluginApprovers,
      );
      if (!updated) {
        throw new ResourceConflictError("The Agent Configuration changed during its update.");
      }
      return updated;
    });
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
  ): Promise<Readonly<AuthorizedAgentDeployment>> {
    if (!isNonEmptyString(input.agentId)) {
      throw new ScopeViolationError("The exact Agent identity is missing.");
    }
    return this.mutate(async (state) => {
      const namespace = await this.lockNamespace(state, input.namespaceId);
      const agent = await state.agents.findAgent(namespace.id, input.agentId);
      if (!agent) {
        throw new ScopeViolationError(
          "The Agent does not belong to the exact Installation and Namespace.",
        );
      }
      const authorization = await this.authorize(principalId, "deploy", {
        kind: "agent",
        id: agent.id,
        namespaceId: namespace.id,
      });
      await this.guardAgentProvisioning(state, namespace.id, agent.id, true);
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

      const lockedAgent = await state.agents.lockAgent(namespace.id, agent.id);
      if (!lockedAgent || !isNonEmptyString(lockedAgent.servicePrincipalId)) {
        throw new ScopeViolationError(
          "The Agent or its service principal does not belong to the exact Namespace.",
        );
      }
      if (lockedAgent.status !== "active") {
        throw new AgentDeletingError();
      }
      const backendId = this.backendId(lockedAgent.backendId);
      if (sandbox !== undefined && lockedAgent.executionMode !== "dedicated") {
        throw new ScopeViolationError(
          "The selected Sandbox Driver supports only dedicated Harness execution.",
        );
      }
      this.assertCredentialGatewayDelivery(lockedAgent.harnessAuth);
      const harnessAuth = await this.admitHarnessAuth(state, principalId, lockedAgent);
      const credentialSourceType = await this.admittedCredentialSourceType(harnessAuth, sandbox);
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
        await this.authorize(lockedAgent.servicePrincipalId, "operate", {
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
      const configurationDriver = this.configurationDriver();
      const configuration = this.exactConfiguration(
        await this.driverOperation(() =>
          configurationDriver.read({ id: metadata.id, namespaceId: namespace.id }),
        ),
        metadata,
      );
      const sandboxConfiguration =
        sandbox?.configureAgent !== undefined
          ? frozenValues(sandbox.configureAgent(frozenValues(configuration.values)))
          : configuration.values;
      const admittedConfiguration = frozenValues(
        compute.runtimeLogging === "driver"
          ? sandboxConfiguration
          : admitLoggingConfiguration(sandboxConfiguration, this.loggingLevel),
      );
      await configurationDriver.validate({ ...configuration, values: admittedConfiguration });
      if (!validExecutionMode(lockedAgent.executionMode)) {
        throw new ScopeViolationError("The persisted Agent Harness execution mode is invalid.");
      }
      const configuredHarnessId = resolveConfiguredHarnessId(admittedConfiguration);
      const approvedHarness = resolveHarness(configuredHarnessId, lockedAgent.executionMode);
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
      if (
        (approvedHarness.id === "openclaw" && lockedAgent.executionMode !== "embedded") ||
        (approvedHarness.id === "codex" && lockedAgent.executionMode !== "dedicated") ||
        (approvedHarness.id !== "openclaw" && approvedHarness.id !== "codex")
      ) {
        throw new ScopeViolationError("The selected Harness does not support this execution mode.");
      }
      if (compute.validateHarnessAuth === undefined) {
        throw new DependencyUnavailableError(
          "The selected Compute Driver does not support Harness authentication bindings.",
        );
      }
      try {
        compute.validateHarnessAuth(
          { ...approvedHarness, mode: lockedAgent.executionMode },
          harnessAuth,
          admittedConfiguration,
          configuration.secretBindings,
          credentialSourceType,
        );
      } catch {
        throw new ResourceConflictError(
          "The selected Compute Driver cannot deliver this Harness authentication binding to the configured model and topology.",
        );
      }
      const pluginState =
        lockedAgent.plugins === undefined || Object.keys(lockedAgent.plugins).length === 0
          ? undefined
          : (() => {
              const driver = this.pluginDriver();
              driver.validatePolicies(lockedAgent.plugins, lockedAgent.pluginApprovers);
              return immutableCopy({
                driver: { id: driver.id, implementation: driver.implementation },
                plugins: lockedAgent.plugins,
              } satisfies PluginRevisionState);
            })();
      const previous = await state.revisions.listRevisions(namespace.id, lockedAgent.id);
      const createdAt = this.timestamp();
      const repositoryCredentials = this.admitRepositoryCredentials(
        lockedAgent,
        compute,
        { ...approvedHarness, mode: lockedAgent.executionMode },
        sandbox?.id,
        Date.parse(createdAt),
      );
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
            throw new ResourceConflictError(
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
      const revision = await state.revisions.createRevision(
        freezeAgentRevision({
          id: this.nextIdentifier("agent_revision"),
          namespaceId: namespace.id,
          agentId: lockedAgent.id,
          revision: previous.length + 1,
          backendId,
          configurationId: configuration.id,
          configurationKind: configuration.kind,
          configurationGeneration: configuration.generation,
          configuration: admittedConfiguration,
          harness: {
            id: approvedHarness.id,
            version: approvedHarness.version,
            mode: lockedAgent.executionMode,
          },
          compute: { id: compute.id, implementation: compute.implementation },
          ...(sandbox === undefined ? {} : { sandboxDriverId: sandbox.id }),
          ...(secretDriver === undefined
            ? {}
            : { secretDriverId: secretDriver.id, secretBindings }),
          ...(pluginState === undefined ? {} : { plugins: pluginState }),
          ...(lockedAgent.pluginApprovers === undefined
            ? {}
            : { pluginApprovers: lockedAgent.pluginApprovers }),
          ...(repositoryCredentials === undefined ? {} : { repositoryCredentials }),
          harnessAuth,
          servicePrincipalId: lockedAgent.servicePrincipalId,
          createdAt,
        }),
      );
      const running = await state.agents.transitionAgentDesiredRuntimeState(
        namespace.id,
        lockedAgent.id,
        lockedAgent.desiredRuntimeState,
        "running",
      );
      if (running === undefined) {
        throw new ResourceConflictError("The Agent lifecycle changed during deployment.");
      }
      await this.record(state, {
        kind: "agent_revision",
        action: "reconcile",
        namespaceId: namespace.id,
        resourceId: revision.id,
        actorId: principalId,
      });
      return Object.freeze({ revision, authorization });
    });
  }

  async stopAgent(
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
      await this.lockNamespace(state, namespaceId);
      const agent = await state.agents.lockAgent(namespaceId, agentId);
      if (agent === undefined) {
        throw new ScopeViolationError(
          "The Agent does not belong to the exact Installation and Namespace.",
        );
      }
      await this.authorize(principalId, "operate", {
        kind: "agent",
        id: agent.id,
        namespaceId: agent.namespaceId,
      });
      if (agent.status === "deleting") {
        return agent;
      }
      await state.provisioning.cancelByAgent(namespaceId, agentId, {
        code: "PROVISIONING_CANCELLED",
        message: "Provisioning was cancelled by Stop.",
      });
      const stopped = await state.agents.transitionAgentDesiredRuntimeState(
        namespaceId,
        agentId,
        agent.desiredRuntimeState,
        "stopped",
      );
      if (stopped === undefined) {
        throw new ResourceConflictError("The Agent lifecycle changed during stop.");
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
   * Begin logical deletion of one exact, authorized, empty Namespace.
   * Driver effects remain deferred to handleNamespaceLifecycle().
   */
  async deleteNamespace(principalId: string, namespaceId: string): Promise<Readonly<Namespace>> {
    if (!isNonEmptyString(namespaceId)) {
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    }
    return this.mutate(async (state) => {
      const namespace = await state.namespaces.lockNamespace(namespaceId);
      if (!namespace) {
        throw new ScopeViolationError(
          "The Namespace does not belong to the server-owned Installation.",
        );
      }
      await this.authorize(principalId, "delete", {
        kind: "namespace",
        id: namespace.id,
        namespaceId: namespace.id,
      });
      if (namespace.status === "deleting") {
        return namespace;
      }
      if (await state.namespaces.hasAgents(namespace.id)) {
        throw new NamespaceNotEmptyError();
      }
      if (await state.namespaces.hasPresets(namespace.id)) {
        throw new NamespaceNotEmptyError();
      }
      if (await state.namespaces.hasConfigurations(namespace.id)) {
        throw new NamespaceNotEmptyError();
      }
      if (await state.namespaces.hasSecrets(namespace.id)) {
        throw new NamespaceNotEmptyError();
      }
      if (await state.namespaces.hasCredentialSources(namespace.id)) {
        throw new NamespaceNotEmptyError();
      }
      if (await state.namespaces.hasServiceAccounts(namespace.id)) {
        throw new NamespaceNotEmptyError();
      }
      if (await state.provisioning.hasPendingNamespaceProvisioning(namespace.id)) {
        throw new NamespaceNotEmptyError();
      }
      const deleting = await state.namespaces.transitionNamespaceStatus(
        namespace.id,
        ["provisioning", "ready", "failed"],
        "deleting",
      );
      if (!deleting) {
        throw new ResourceConflictError("The Namespace lifecycle changed during deletion.");
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
      await this.authorize(principalId, "delete", {
        kind: "agent",
        id: agent.id,
        namespaceId: namespace.id,
      });
      await state.provisioning.cancelByAgent(namespace.id, agent.id, {
        code: "PROVISIONING_CANCELLED",
        message: "Provisioning was cancelled by deletion.",
      });
      // Deletion ends delivery ownership immediately, including never-deployed Agents.
      await state.workspaceSetups.delete(namespace.id, agent.id);
      // Keep in-flight teardown idempotent. The original caller can explicitly
      // retry terminal work after repairing the dependency or permission failure.
      if (agent.status === "deleting") {
        const workId = `agent:${agent.id}:reconcile:deleted`;
        const work = await state.operations.findWork(workId);
        if (work?.state === "failed_permanent") {
          if (work.actorId !== principalId) {
            throw new AuthorizationDeniedError("Only the initiating actor can retry deletion.");
          }
          if (
            !(await state.operations.retryFailedAgentDeletion(namespace.id, agent.id, principalId))
          ) {
            throw new ResourceConflictError("The Agent deletion work changed during retry.");
          }
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
            details: {
              workId,
              previousAttemptCount: work.attemptCount,
              previousReasonCode: work.reasonCode,
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
        throw new ResourceConflictError("The Agent runtime state changed during deletion.");
      }
      const deleting = await state.agents.transitionAgentStatus(
        namespace.id,
        agent.id,
        "active",
        "deleting",
      );
      if (!deleting) {
        throw new ResourceConflictError("The Agent lifecycle changed during deletion.");
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
    if (!isNonEmptyString(namespaceId)) {
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    }
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
        result = await compute.deleteNamespace(namespace);
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
        await this.appendLifecycleAudit(
          state,
          actorId,
          current,
          compute,
          deleted ? "success" : "failure",
          {
            namespaceDeleted: result.namespaceDeleted,
            ...(result.failure === undefined ? {} : { failure: result.failure }),
          },
        );
        return updated;
      });
    }

    let result;
    try {
      result = await compute.ensureNamespace(namespace);
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
    const active = this.transactionContext.getStore();
    if (active) {
      return work(active);
    }

    const rollbacks: (() => Promise<void>)[] = [];
    try {
      return await this.state.transact(async (state) =>
        this.transactionContext.run(state, () =>
          this.mutationRollbacks.run(rollbacks, async () => {
            const existing = await state.installations.getInstallation();
            if (!existing) {
              await state.installations.createInstallation(this.installation);
            } else if (existing.id !== this.installation.id) {
              throw new ScopeViolationError(
                "The controller state belongs to another Installation.",
              );
            }
            return work(state);
          }),
        ),
      );
    } catch (error) {
      if (error instanceof PostgresCommitOutcomeUnknownError) {
        throw error;
      }
      let rollbackFailed = false;
      for (const rollback of rollbacks.reverse()) {
        try {
          await rollback();
        } catch {
          rollbackFailed = true;
        }
      }
      if (rollbackFailed) {
        throw new DependencyUnavailableError(
          "A Driver could not roll back a failed resource mutation.",
        );
      }
      throw error;
    }
  }

  /** Compensate a Driver side effect if the owning resource transaction fails. */
  registerRollback(rollback: () => Promise<void>): void {
    const rollbacks = this.mutationRollbacks.getStore();
    if (rollbacks === undefined || this.transactionContext.getStore() === undefined) {
      throw new DependencyUnavailableError("The platform mutation transaction is unavailable.");
    }
    rollbacks.push(rollback);
  }

  pendingOperations(): readonly Readonly<ReconciliationOperation>[] {
    if (this.state instanceof InMemoryPlatformState) {
      return this.state.pendingOperations();
    }
    return Object.freeze([]);
  }

  private async authorize(
    principalId: string,
    action: AuthorizationRequest["action"],
    resource: ResourceRef,
  ): Promise<Readonly<DeployAgentAuthorization>> {
    const authorization = await this.authorizationDecision(principalId, action, resource);
    if (!authorization.decision.allowed) {
      throw new AuthorizationDeniedError(
        isNonEmptyString(authorization.decision.reason)
          ? authorization.decision.reason
          : "The exact operation was denied.",
        authorization.decision.evidence,
        { action, resource },
      );
    }
    return authorization;
  }

  private async canRead(principalId: string, resource: ResourceRef): Promise<boolean> {
    return (await this.authorizationDecision(principalId, "read", resource)).decision.allowed;
  }

  private authorizationAuthority(principalId: string): IAMDriver {
    if (!isNonEmptyString(principalId)) {
      throw new AuthorizationDeniedError("The acting identity is unavailable.");
    }
    try {
      return this.selectedDriver("iam");
    } catch {
      throw new DependencyUnavailableError("The selected authorization Driver is unavailable.");
    }
  }

  private async authorizationDecision(
    principalId: string,
    action: AuthorizationRequest["action"],
    resource: ResourceRef,
  ): Promise<Readonly<DeployAgentAuthorization>> {
    const selected = this.authorizationAuthority(principalId);
    const request = Object.freeze({
      principalId,
      action,
      resource: Object.freeze({ ...resource }),
    });
    let decision: AuthorizationDecision;
    try {
      decision = this.authorization
        ? await this.authorization(request)
        : await selected.authorize(request);
    } catch {
      throw new DependencyUnavailableError(
        "The selected authorization Driver could not verify the operation.",
      );
    }
    const snapshotIds = (entries: unknown): readonly string[] | undefined => {
      if (!Array.isArray(entries)) {
        return undefined;
      }
      const result: string[] = [];
      const length = entries.length;
      for (let index = 0; index < length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(entries, index)) {
          return undefined;
        }
        const id: unknown = entries[index];
        if (!isNonEmptyString(id)) {
          return undefined;
        }
        result.push(id);
      }
      return Object.freeze(result);
    };
    const allowed = decision?.allowed;
    const reason = decision?.reason;
    const driverId = decision?.driverId;
    const evidence = decision?.evidence;
    const identityId = evidence?.identityId;
    const groupIds = snapshotIds(evidence?.groupIds);
    const bindingIds = snapshotIds(evidence?.bindingIds);
    const roleIds = snapshotIds(evidence?.roleIds);
    const restrictionIds = snapshotIds(evidence?.restrictionIds);
    if (
      typeof allowed !== "boolean" ||
      !isNonEmptyString(driverId) ||
      !evidence ||
      (identityId !== undefined && !isNonEmptyString(identityId)) ||
      !groupIds ||
      !bindingIds ||
      !roleIds ||
      !restrictionIds
    ) {
      throw new DependencyUnavailableError(
        "The selected authorization Driver returned an invalid decision.",
      );
    }
    if (driverId !== selected.id || this.authorizationAuthority(principalId) !== selected) {
      throw new DependencyUnavailableError("The authorization decision belongs to another Driver.");
    }
    const snapshot = Object.freeze({
      allowed,
      reason,
      driverId,
      evidence: Object.freeze({
        ...(identityId === undefined ? {} : { identityId }),
        groupIds,
        bindingIds,
        roleIds,
        restrictionIds,
      }),
    });
    return Object.freeze({ request, decision: snapshot });
  }

  private async exactNamespace(
    state: PlatformReadView,
    namespaceId: string,
  ): Promise<Readonly<Namespace>> {
    if (!isNonEmptyString(namespaceId)) {
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    }
    const namespace = await state.namespaces.findNamespace(namespaceId);
    if (!namespace) {
      throw new ScopeViolationError(
        "The Namespace does not belong to the server-owned Installation.",
      );
    }
    return namespace;
  }

  private async lockNamespace(
    state: PlatformUnitOfWork,
    namespaceId: string,
  ): Promise<Readonly<Namespace>> {
    if (!isNonEmptyString(namespaceId)) {
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    }
    const namespace = await state.namespaces.lockNamespace(namespaceId);
    if (!namespace) {
      throw new ScopeViolationError(
        "The Namespace does not belong to the server-owned Installation.",
      );
    }
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
      this.secretDriver(secret.driverId);
      secrets.set(secret.id, secret);
    }
    return Object.freeze([...secrets.values()]);
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
    if (binding.method === "api_key" || binding.method === "codex_pat") {
      if (binding.source.namespaceId !== namespaceId) {
        throw new ScopeViolationError("Harness authentication sources cannot cross Namespaces.");
      }
      await this.authorize(principalId, "operate", binding.source);
      const source = await state.secrets.lockSecret(namespaceId, binding.source.id);
      if (source === undefined) {
        throw new ScopeViolationError("The Harness Secret does not belong to the exact Namespace.");
      }
      this.secretDriver(source.driverId);
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
      if (source === undefined || source.state !== "ready") {
        throw new ScopeViolationError(
          "The Harness credential source is unavailable in the exact Namespace.",
        );
      }
      this.credentialGatewayDriver(source.driverId);
    } else {
      await this.authorize(principalId, "read", {
        kind: "service_account",
        namespaceId,
        id: binding.serviceAccountId,
      });
      await this.exactServiceAccount(state, namespaceId, binding.serviceAccountId);
    }
  }

  private async authorizeProvisioningRecord(
    state: PlatformUnitOfWork,
    principalId: string,
    record: Readonly<AgentProvisioningRecord>,
  ): Promise<void> {
    const namespaceId = record.namespaceId;
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
    compute.validateAgentProvisioning({
      executionMode: plan.executionMode,
      configuration: plan.configuration.values,
    });
    await this.authorizeProvisioningSecretSources(
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
    // TODO(credential-gateway provisioning): admit credential sources in guided provisioning
    // plans; until then those Agents are created first and deployed through deployAgent.
    if (binding.method === "credential_source") {
      throw new ResourceConflictError(
        "Agent provisioning does not yet support credential-source Harness authentication.",
      );
    }
    const backendId = this.backendId(record.plan.backendId as BackendRef | undefined);
    const agent =
      record.agentId === undefined
        ? undefined
        : await state.agents.findAgent(namespaceId, record.agentId);
    if (record.agentId !== undefined && agent === undefined) {
      throw new ScopeViolationError("The provisioning Agent is unavailable.");
    }
    const secretDriver =
      binding.method === "api_key" || binding.method === "codex_pat"
        ? this.secretDriver()
        : undefined;
    const auth: HarnessAuthSnapshot =
      binding.method === "api_key" || binding.method === "codex_pat"
        ? { ...binding, secretDriverId: secretDriver!.id }
        : agent === undefined
          ? await this.serviceAccountHarnessAuthSnapshot(state, namespaceId, backendId, binding)
          : await this.admitHarnessAuth(state, principalId, { ...agent, harnessAuth: binding });
    const configuration =
      this.sandboxDriver()?.configureAgent?.(plan.configuration.values) ??
      plan.configuration.values;
    const harness = {
      id: resolveConfiguredHarnessId(configuration),
      version: "provisioning",
      mode: plan.executionMode,
    };
    if (compute.validateHarnessAuth === undefined) {
      throw new DependencyUnavailableError(
        "The Compute Driver cannot validate Harness authentication.",
      );
    }
    try {
      compute.validateHarnessAuth(harness, auth, configuration, plan.configuration.secretBindings);
    } catch {
      throw new ResourceConflictError(
        "The configured model, authentication, or channel bindings cannot be provisioned.",
      );
    }
    this.validatePluginPolicies(
      normalizeAgentPlugins(record.plan.plugins as PluginDesiredState | undefined),
      normalizeAgentPluginApprovers(record.plan.pluginApprovers as PluginApprovers | undefined),
    );
    if (agent !== undefined) {
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
  ): Promise<Readonly<AgentProvisioningRecord>> {
    if (!isNonEmptyString(workId)) {
      throw new ScopeViolationError("The exact provisioning work identity is missing.");
    }
    await this.exactNamespace(state, namespaceId);
    const record = await state.provisioning.findByWorkId(workId);
    if (record === undefined || record.namespaceId !== namespaceId) {
      throw new ScopeViolationError(
        "The provisioning work does not belong to the exact Namespace.",
      );
    }
    if (record.actorId !== principalId) {
      throw new AuthorizationDeniedError("Only the initiating actor can read provisioning status.");
    }
    await this.authorizeProvisioningRecord(state, principalId, record);
    return record;
  }

  private async guardAgentProvisioning(
    state: PlatformReadView,
    namespaceId: string,
    agentId: string,
    handoff = false,
  ): Promise<void> {
    const record = await state.provisioning.findByAgent(namespaceId, agentId);
    if (record === undefined) {
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
      (record.status === "failed" && record.revisionId === undefined) ||
      (record.status === "cancelled" && this.provisioningHasUnresolvedEffect(record))
    ) {
      throw new ResourceConflictError(
        "The Agent is reserved for provisioning. Stop or delete it, or retry its failed provisioning request.",
      );
    }
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
      (readOnly
        ? this.provisioningBefore(record, "configuration")
        : this.provisioningBefore(record, "configuration") ||
          record.status === "queued" ||
          record.status === "running" ||
          (record.status === "failed" && record.revisionId === undefined) ||
          (record.status === "cancelled" && this.provisioningHasUnresolvedEffect(record)))
    ) {
      throw new ResourceConflictError(
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
        throw new ResourceConflictError("The Agent lifecycle changed during provisioning.");
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

  private async inspectProvisioningConfigurationEffect(
    workId: string,
    record: Readonly<AgentProvisioningRecord>,
    effect: ProvisioningEffectTarget & { readonly kind: "configuration" },
    configuration: Configuration,
    driver: ConfigurationDriver,
    runEffect: <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<T>,
  ): Promise<Readonly<AgentProvisioningRecord>> {
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
      if (recovered === undefined) {
        throw new DependencyUnavailableError(
          "The pending Configuration provisioning effect outcome is unknown.",
        );
      }
      return this.settleProvisioningEffect(workId, record, effect);
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
    const configuration: Configuration = {
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
          current = await this.inspectProvisioningConfigurationEffect(
            claim.idempotencyKey,
            current,
            effect,
            configuration,
            driver,
            runEffect,
          );
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
      if (!isNonEmptyString(name) || !validName(name)) {
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
      );
      const workspace = normalizeProvisioningWorkspace(
        planRecord.initialWorkspaceFiles,
        planRecord.workspaceDefaultsId,
      );
      const existingMetadata = await state.configurations.lockConfiguration(
        namespace.id,
        configurationId,
      );
      const metadata =
        existingMetadata ??
        (await state.configurations.createConfiguration({
          id: configurationId,
          namespaceId: namespace.id,
          kind: "agent",
          generation: configuration.generation,
          ...(plan.configuration.secretBindings === undefined
            ? {}
            : { secretBindings: plan.configuration.secretBindings }),
          createdAt: configuration.createdAt,
        }));
      const agentId = current.agentId ?? this.nextIdentifier("agent");
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
          executionMode: plan.executionMode,
          ...(plugins === undefined ? {} : { plugins }),
          ...(pluginApprovers === undefined ? {} : { pluginApprovers }),
          ...(repositoryBindings === undefined ? {} : { repositoryBindings }),
          servicePrincipalId: `service-agent-${agentId}`,
          desiredRuntimeState: "stopped",
          status: "active",
          createdAt: this.timestamp(),
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
      await this.ensureAgentSecretOperateGrants(state, namespace.id, agent, grantSources);
      return this.commitProvisioningCheckpoint(state, claim, {
        completedPhase: "configuration",
        status: "running",
        agentId,
        configurationId: metadata.id,
        progress: {},
      });
    });
  }

  private provisioningPlan(record: Readonly<AgentProvisioningRecord>): {
    readonly configuration: AgentProvisioningConfigurationInput;
    readonly harnessAuth: HarnessAuthBinding | null;
    readonly executionMode: HarnessExecutionMode;
  } {
    const plan = asRecord(record.plan);
    const configuration = normalizeProvisioningConfiguration(plan?.configuration);
    const executionMode = plan?.executionMode;
    if (!validExecutionMode(executionMode)) {
      throw new ScopeViolationError("The provisioning execution mode is invalid.");
    }
    return {
      configuration,
      harnessAuth: normalizeProvisioningHarnessAuth(plan?.harnessAuth ?? null),
      executionMode,
    };
  }

  private async provisioningGrantSources(
    state: PlatformUnitOfWork,
    namespaceId: string,
    input: {
      readonly secretBindings?: SecretBindings;
      readonly harnessAuth: HarnessAuthBinding | null;
    },
  ): Promise<readonly Secret[]> {
    const ids = new Set<string>();
    for (const binding of Object.values(input.secretBindings ?? {})) {
      ids.add(binding.source.id);
    }
    if (input.harnessAuth?.method === "api_key" || input.harnessAuth?.method === "codex_pat") {
      ids.add(input.harnessAuth.source.id);
    }
    const secrets: Secret[] = [];
    for (const id of ids) {
      const secret = await state.secrets.lockSecret(namespaceId, id);
      if (secret === undefined) {
        throw new ScopeViolationError("Agent provisioning Secret grant source is unavailable.");
      }
      secrets.push(secret);
    }
    return Object.freeze(secrets);
  }

  private async ensureAgentSecretOperateGrants(
    state: PlatformUnitOfWork,
    namespaceId: string,
    agent: Readonly<Agent>,
    secrets: readonly Secret[],
  ): Promise<void> {
    if (secrets.length === 0) {
      return;
    }
    const driver = this.iamPolicyDriver("createNamespaceAccessBinding");
    if (driver.namespacePolicyTransaction !== "platform-unit-of-work") {
      throw new DependencyUnavailableError(
        "The selected IAM Driver does not support provisioning policy transactions.",
      );
    }
    const roleId = `role_${namespaceId}_agent_secret_operate`;
    const existingRole = await state.iamPolicy.getRole(namespaceId, roleId);
    if (
      existingRole !== undefined &&
      (existingRole.namespaceId !== namespaceId ||
        existingRole.permissions.length !== 1 ||
        existingRole.permissions[0]?.action !== "operate" ||
        existingRole.permissions[0]?.resourceKind !== "secret")
    ) {
      throw new ResourceConflictError(
        "The provisioning Role does not have the exact Namespace and Secret permission.",
      );
    }
    if (existingRole === undefined) {
      await this.iamPolicyOperation(() =>
        driver.createNamespaceRole!(
          { policy: state.iamPolicy },
          {
            id: roleId,
            namespaceId,
            name: "Agent Secret operate",
            permissions: [{ action: "operate", resourceKind: "secret" }],
          },
        ),
      );
    }
    const bindings = await state.iamPolicy.listAccessBindings(namespaceId);
    for (const secret of secrets) {
      const exists = bindings.some(
        (binding) =>
          binding.subjectKind === "identity" &&
          binding.subjectId === agent.servicePrincipalId &&
          binding.roleId === roleId &&
          binding.resourceKind === "secret" &&
          binding.resourceId === secret.id,
      );
      if (exists) {
        continue;
      }
      await this.iamPolicyOperation(() =>
        driver.createNamespaceAccessBinding!(
          { policy: state.iamPolicy },
          {
            id: `binding_${agent.id}_${secret.id}_operate`,
            namespaceId,
            subjectKind: "identity",
            subjectId: agent.servicePrincipalId,
            roleId,
            resourceKind: "secret",
            resourceId: secret.id,
          },
        ),
      );
    }
  }

  private async authorizeProvisioningSecretSources(
    state: PlatformUnitOfWork,
    principalId: string,
    namespaceId: string,
    bindings: SecretBindings | undefined,
    harnessAuth: HarnessAuthBinding | null,
  ): Promise<void> {
    for (const binding of Object.values(bindings ?? {})) {
      await this.authorizeProvisioningSecretSource(state, principalId, namespaceId, binding.source);
    }
    if (harnessAuth?.method === "api_key" || harnessAuth?.method === "codex_pat") {
      await this.authorizeProvisioningSecretSource(
        state,
        principalId,
        namespaceId,
        harnessAuth.source,
      );
    } else if (harnessAuth?.method === "chatgpt_service_account") {
      await this.authorize(principalId, "read", {
        kind: "service_account",
        namespaceId,
        id: harnessAuth.serviceAccountId,
      });
      await this.exactServiceAccount(state, namespaceId, harnessAuth.serviceAccountId);
    }
  }

  private async authorizeProvisioningSecretSource(
    state: PlatformUnitOfWork,
    principalId: string,
    namespaceId: string,
    source: SecretReference,
  ): Promise<void> {
    if (source.namespaceId !== namespaceId) {
      throw new ScopeViolationError("Secret references cannot cross Namespaces.");
    }
    await this.authorize(principalId, "operate", source);
    const secret = await state.secrets.lockSecret(namespaceId, source.id);
    if (secret === undefined) {
      throw new ScopeViolationError("The Secret does not belong to the exact Namespace.");
    }
    this.secretDriver(secret.driverId);
  }

  private async serviceAccountHarnessAuthSnapshot(
    state: PlatformUnitOfWork,
    namespaceId: string,
    backendId: BackendRef,
    binding: Extract<HarnessAuthBinding, { readonly method: "chatgpt_service_account" }>,
  ): Promise<HarnessAuthSnapshot> {
    const account = await state.serviceAccounts.lockServiceAccount(
      namespaceId,
      binding.serviceAccountId,
    );
    if (account?.credential?.kind !== "access_token") {
      throw new ResourceConflictError(
        "ChatGPT Harness authentication requires an issued account access-token credential.",
      );
    }
    const backendBinding = await state.serviceAccounts.findServiceAccountBackendBinding(
      namespaceId,
      binding.serviceAccountId,
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
  ): Promise<HarnessAuthSnapshot> {
    const binding = this.harnessAuthBinding(agent.harnessAuth);
    if (binding === null) {
      throw new ResourceConflictError(
        "Deployment requires an explicit Harness authentication binding.",
      );
    }
    await this.authorizeHarnessAuthSource(state, principalId, agent.namespaceId, binding);
    if (binding.method === "runtime") {
      return immutableCopy(binding);
    }
    if (binding.method === "api_key" || binding.method === "codex_pat") {
      await this.authorize(agent.servicePrincipalId, "operate", binding.source);
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
      return immutableCopy({ ...binding, secretDriverId: driver.id });
    }
    if (binding.method === "credential_source") {
      await this.authorize(agent.servicePrincipalId, "operate", {
        kind: "credential_source",
        namespaceId: agent.namespaceId,
        id: binding.sourceId,
      });
      const source = await state.credentialSources.lockCredentialSource(
        agent.namespaceId,
        binding.sourceId,
      );
      if (source === undefined || source.state !== "ready") {
        throw new ScopeViolationError("The Harness credential source is unavailable.");
      }
      const gateway = this.credentialGatewayDriver(source.driverId);
      const type = await this.credentialSourceType(gateway, source.type);
      if (type.harnessAuth === undefined) {
        throw new ResourceConflictError(
          "The credential source type cannot authenticate a Harness.",
        );
      }
      return immutableCopy({
        method: "credential_source" as const,
        sourceId: source.id,
        credentialGatewayId: gateway.id,
        sourceType: source.type,
        loginMode: type.harnessAuth.loginMode,
      });
    }
    const account = await state.serviceAccounts.lockServiceAccount(
      agent.namespaceId,
      binding.serviceAccountId,
    );
    if (account?.credential?.kind !== "access_token") {
      throw new ResourceConflictError(
        "ChatGPT Harness authentication requires an issued account access-token credential.",
      );
    }
    const backendBinding = await state.serviceAccounts.findServiceAccountBackendBinding(
      agent.namespaceId,
      binding.serviceAccountId,
    );
    validateServiceAccountBackendBinding(this.backendMap, agent.backendId, backendBinding);
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

  /** A selected Credential Gateway replaces Secret-backed model delivery; no env fallback. */
  private assertCredentialGatewayDelivery(binding: HarnessAuthBinding | null): void {
    if (
      this.selections.has("credential_gateway") &&
      binding !== null &&
      binding.method !== "credential_source" &&
      binding.method !== "runtime"
    ) {
      throw new ResourceConflictError(
        "The selected Credential Gateway requires credential-source Harness authentication.",
      );
    }
  }

  /** Credential sources are injected by the paired Sandbox, so one must be selected. */
  private async admittedCredentialSourceType(
    auth: HarnessAuthSnapshot,
    sandbox: SandboxDriver | undefined,
  ): Promise<CredentialSourceType | undefined> {
    if (auth.method === "credential_source") {
      if (sandbox === undefined) {
        throw new ResourceConflictError(
          "Credential-source Harness authentication requires a selected Sandbox Driver.",
        );
      }
      return this.credentialSourceType(
        this.credentialGatewayDriver(auth.credentialGatewayId),
        auth.sourceType,
      );
    }
    return undefined;
  }

  private validateSecretValue(value: unknown): asserts value is string {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.includes("\u0000") ||
      /[\uD800-\uDFFF]/u.test(value) ||
      Buffer.byteLength(value, "utf8") > 65_536
    ) {
      throw new ScopeViolationError(
        "The Secret value must be nonempty UTF-8, without NUL, and at most 65536 bytes.",
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
      const namespace = await this.lockNamespace(state, namespaceId);
      const agent = await state.agents.lockAgent(namespace.id, agentId);
      if (!agent) {
        throw new ScopeViolationError(
          "The Agent does not belong to the exact Installation and Namespace.",
        );
      }
      await this.authorize(principalId, "read", {
        kind: "agent",
        id: agent.id,
        namespaceId: namespace.id,
      });
      await this.authorize(principalId, "operate", {
        kind: "agent",
        id: agent.id,
        namespaceId: namespace.id,
      });
      if (agent.status !== "active") {
        throw new AgentDeletingError();
      }
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      if ((await state.revisions.listRevisions(namespace.id, agent.id)).length > 0) {
        throw new ResourceConflictError(
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

  private validRuntimeDiagnosticCheck(value: RuntimeDiagnosticCheck): RuntimeDiagnosticCheck {
    const state = value?.state;
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !validRuntimeDiagnosticIdentifier(value.component) ||
      !validRuntimeDiagnosticIdentifier(value.check) ||
      (state !== "succeeded" && state !== "failed" && state !== "unknown") ||
      (value.checkedAt !== null && !validRuntimeDiagnosticTimestamp(value.checkedAt)) ||
      (value.code !== undefined && !validRuntimeDiagnosticIdentifier(value.code))
    ) {
      throw new DependencyUnavailableError(
        "The selected compute Driver returned invalid runtime diagnostic evidence.",
      );
    }
    return Object.freeze({
      component: value.component,
      check: value.check,
      state,
      checkedAt: value.checkedAt,
      ...(value.code === undefined ? {} : { code: value.code }),
    });
  }

  private deploymentDiagnostics(
    diagnostics: AgentDeploymentDiagnostics,
    revisionId: string,
  ): Readonly<AgentDeploymentDiagnostics> {
    if (
      typeof diagnostics !== "object" ||
      diagnostics === null ||
      Array.isArray(diagnostics) ||
      diagnostics.revisionId !== revisionId ||
      !validRuntimeDiagnosticTimestamp(diagnostics.observedAt) ||
      !Array.isArray(diagnostics.checks) ||
      diagnostics.checks.length > 32
    ) {
      throw new DependencyUnavailableError(
        "The selected compute Driver returned invalid runtime diagnostics.",
      );
    }
    return Object.freeze({
      revisionId: diagnostics.revisionId,
      observedAt: diagnostics.observedAt,
      checks: Object.freeze(
        diagnostics.checks.map((check) => this.validRuntimeDiagnosticCheck(check)),
      ),
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
    return this.credentialGatewayOperation(() => resolve.call(compute, namespace));
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
      throw new ScopeViolationError(
        "The selected Credential Gateway does not support this source type.",
      );
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
      config: source.config,
      secrets: source.secrets,
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

  /** Runtime credential driver errors can contain secret bytes; never propagate them. */
  private async runtimeCredentialOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch {
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

  private assertNamespacePolicyResourceKind(kind: ResourceKind): void {
    if (
      kind !== "agent" &&
      kind !== "agent_revision" &&
      kind !== "configuration" &&
      kind !== "credential_source" &&
      kind !== "preset" &&
      kind !== "secret" &&
      kind !== "service_account"
    ) {
      throw new ScopeViolationError("IAM policy APIs require an exact Namespace resource target.");
    }
  }

  private iamRolePermissions(permissions: readonly Permission[]): readonly Permission[] {
    if (!Array.isArray(permissions) || permissions.length === 0 || permissions.length > 64) {
      throw new ScopeViolationError("IAM Roles require one or more supported Permissions.");
    }
    const seen = new Set<string>();
    return Object.freeze(
      permissions.map((permission) => {
        if (
          typeof permission !== "object" ||
          permission === null ||
          Array.isArray(permission) ||
          !["create", "read", "update", "delete", "deploy", "operate", "administer"].includes(
            permission.action,
          ) ||
          !RESOURCE_KINDS.includes(permission.resourceKind)
        ) {
          throw new ScopeViolationError("IAM Role Permissions are invalid.");
        }
        this.assertNamespacePolicyResourceKind(permission.resourceKind);
        const key = `${permission.action}\u0000${permission.resourceKind}`;
        if (seen.has(key)) {
          throw new ScopeViolationError("IAM Role Permissions contain duplicates.");
        }
        seen.add(key);
        return Object.freeze({
          action: permission.action,
          resourceKind: permission.resourceKind,
        });
      }),
    );
  }

  private async verifyNamespacePolicyResource(
    namespaceId: string,
    resourceKind: ResourceKind,
    resourceId: string,
  ): Promise<void> {
    await this.read(async (state) => {
      if (resourceKind === "agent") {
        if ((await state.agents.findAgent(namespaceId, resourceId)) === undefined) {
          throw new ScopeViolationError("The IAM target Agent does not belong to the Namespace.");
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
        throw new ScopeViolationError(
          "The IAM target AgentRevision does not belong to the Namespace.",
        );
      }
      if (resourceKind === "preset") {
        if ((await state.presets.findPreset(namespaceId, resourceId)) === undefined) {
          throw new ScopeViolationError("The IAM target Preset does not belong to the Namespace.");
        }
        return;
      }
      if (resourceKind === "configuration") {
        if ((await state.configurations.findConfiguration(namespaceId, resourceId)) === undefined) {
          throw new ScopeViolationError(
            "The IAM target Configuration does not belong to the Namespace.",
          );
        }
        return;
      }
      if (resourceKind === "secret") {
        if ((await state.secrets.findSecret(namespaceId, resourceId)) === undefined) {
          throw new ScopeViolationError("The IAM target Secret does not belong to the Namespace.");
        }
        return;
      }
      if (resourceKind === "credential_source") {
        if (
          (await state.credentialSources.findCredentialSource(namespaceId, resourceId)) ===
          undefined
        ) {
          throw new ScopeViolationError(
            "The IAM target credential source does not belong to the Namespace.",
          );
        }
        return;
      }
      if ((await state.serviceAccounts.findServiceAccount(namespaceId, resourceId)) === undefined) {
        throw new ScopeViolationError(
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
    if (!isNonEmptyString(namespaceId)) {
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    }
    if (!isNonEmptyString(configurationId)) {
      throw new ScopeViolationError("The exact Configuration identity is missing.");
    }
  }

  private serviceAccountIdentity(namespaceId: string, serviceAccountId: string): void {
    if (!isNonEmptyString(namespaceId)) {
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    }
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

  private validatePluginPolicies(
    plugins: PluginDesiredState | undefined,
    pluginApprovers?: PluginApprovers,
  ): void {
    if (
      (plugins !== undefined && Object.keys(plugins).length > 0) ||
      (pluginApprovers !== undefined && pluginApprovers.length > 0)
    ) {
      this.pluginDriver().validatePolicies(plugins ?? {}, pluginApprovers);
    }
  }

  private pluginDriver(): PluginDriver {
    try {
      return this.selectedDriver("plugin");
    } catch {
      throw new NotImplementedError(
        "agent_plugins.driver",
        "No selected Plugin Driver can represent Agent plugin configuration.",
      );
    }
  }

  private resolveRepositoryBindings(
    namespaceId: string,
    bindings: readonly RepositoryBindingRequest[] | undefined,
  ):
    | {
        readonly driver: RepoDriver;
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
    let driver: RepoDriver;
    try {
      driver = this.selectedDriver("repo");
    } catch {
      throw new DependencyUnavailableError(
        "The selected repository credential Driver is unavailable.",
      );
    }
    let resolution: RepositoryCredentialResolution;
    try {
      resolution = driver.resolve(immutableCopy({ namespaceId, bindings }));
    } catch {
      throw new ScopeViolationError(
        "The requested repository selections are not approved for this Namespace.",
      );
    }
    const selected = this.selections.get("repo");
    if (
      !resolution ||
      !validAdmittedRepositoryBindings(resolution.bindings) ||
      !Number.isSafeInteger(resolution.sessionDurationSeconds) ||
      resolution.sessionDurationSeconds <= 0 ||
      selected?.driver !== driver ||
      !this.unchangedDriver(selected)
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
          (requested.get(binding.repositoryRef) !== undefined &&
            requested.get(binding.repositoryRef) !== binding.profile) ||
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
    return { driver, resolution: immutableCopy(resolution) };
  }

  private repositoryBindingSelections(
    namespaceId: string,
    bindings: readonly RepositoryBindingRequest[] | undefined,
  ): readonly RepositoryBindingSelection[] | undefined {
    const resolved = this.resolveRepositoryBindings(namespaceId, bindings);
    return resolved === undefined
      ? undefined
      : immutableCopy(
          resolved.resolution.bindings.map(({ repositoryRef, profile }) => ({
            repositoryRef,
            profile,
          })),
        );
  }

  private admitRepositoryCredentials(
    agent: Readonly<Agent>,
    compute: ComputeDriver,
    harness: RevisionHarnessDescriptor,
    sandboxDriverId: string | undefined,
    admittedAtWallMs: number,
  ): RepositoryRevisionState | undefined {
    const resolved = this.resolveRepositoryBindings(agent.namespaceId, agent.repositoryBindings);
    if (resolved === undefined) {
      return undefined;
    }
    if (compute.validateRepositoryCredentials === undefined) {
      throw new DependencyUnavailableError(
        "The selected Compute Driver does not support repository credentials.",
      );
    }
    try {
      compute.validateRepositoryCredentials(harness, sandboxDriverId);
    } catch {
      throw new ResourceConflictError(
        "The selected Compute Driver cannot deliver repository credentials to this Harness topology.",
      );
    }
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

  private currentHarness(
    configuration: Readonly<OpenClawConfigurationDocument>,
    agent: Readonly<Agent>,
    resolveHarness: HarnessResolver,
  ) {
    const configuredHarnessId = resolveConfiguredHarnessId(configuration);
    const harness = resolveHarness(configuredHarnessId, agent.executionMode);
    if (
      harness === undefined ||
      !isNonEmptyString(harness.id) ||
      !isNonEmptyString(harness.version)
    ) {
      throw new DependencyUnavailableError("The selected Harness runtime is not approved.");
    }
    if (harness.id !== configuredHarnessId) {
      throw new ScopeViolationError("The approved Harness does not match the native runtime.");
    }
    return Object.freeze({ id: harness.id, version: harness.version, mode: agent.executionMode });
  }

  private async currentAgentConfiguration(
    state: PlatformReadView,
    namespace: Readonly<Namespace>,
    agent: Readonly<Agent>,
  ): Promise<Readonly<Configuration>> {
    const metadata = await state.configurations.findConfiguration(
      namespace.id,
      agent.configurationId,
    );
    if (!metadata || metadata.kind !== "agent") {
      throw new ScopeViolationError(
        "The Agent Configuration must belong to the exact Namespace and configure an Agent.",
      );
    }
    const driver = this.configurationDriver();
    return this.exactConfiguration(
      await this.driverOperation(() => driver.read({ id: metadata.id, namespaceId: namespace.id })),
      metadata,
    );
  }

  private async driverOperation<T>(
    operation: () => Promise<T>,
    capability: "Configuration" | "ServiceAccount" = "Configuration",
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
      values: frozenValues(configuration.values),
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
    const lifecycleDrivers = this.lifecycleDrivers(proposed);
    const compute = proposed.get("compute");
    if (compute !== undefined) {
      if (!this.unchangedDriver(compute)) {
        throw new DriverSelectionError("The selected compute Driver identity has changed.");
      }
      const selectedCompute = compute.driver as ComputeDriver;
      if (typeof selectedCompute.setLifecycleDrivers === "function") {
        selectedCompute.setLifecycleDrivers(lifecycleDrivers);
      } else if (lifecycleDrivers.length > 0) {
        throw new DriverSelectionError(
          "The selected compute Driver cannot accept selected lifecycle Drivers.",
        );
      }
    }

    this.selections.set(selectedCapability, selected);
    return selected.driver as DriverFor<Capability>;
  }

  private lifecycleDrivers(
    selections: ReadonlyMap<DriverCapability, RegisteredDriver>,
  ): readonly Driver[] {
    const drivers: Driver[] = [];
    for (const [selectedCapability, selected] of selections) {
      if (selectedCapability === "compute") {
        continue;
      }
      if (!this.unchangedDriver(selected)) {
        throw new DriverSelectionError(
          "A selected lifecycle Driver no longer matches its registered identity.",
        );
      }
      if (selected.driver.computeLifecycleHooks !== undefined) {
        drivers.push(selected.driver);
      }
    }
    return Object.freeze(drivers);
  }

  private unchangedDriver(selected: RegisteredDriver): boolean {
    return (
      selected.driver.id === selected.id &&
      selected.driver.capability === selected.capability &&
      selected.driver.implementation === selected.implementation &&
      driverHasCapabilityContract(selected.driver)
    );
  }

  private async read<T>(work: (state: PlatformReadView) => Promise<T>): Promise<T> {
    const active = this.transactionContext.getStore();
    return active ? work(active) : this.state.read(work);
  }

  private assertCredentialSourceTransactionBoundary(): void {
    // Async descendants can retain the borrowed unit after its transaction has ended.
    if (this.transactionContext.getStore() !== undefined) {
      throw new ResourceConflictError(
        "Credential source registration and deletion cannot run in a controller transaction.",
      );
    }
  }

  private async mutate<T>(work: (state: PlatformUnitOfWork) => Promise<T>): Promise<T> {
    const active = this.transactionContext.getStore();
    return active ? work(active) : this.transact(work);
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
      await state.operations.append(operation);
    }
  }
}
export { PostgresMetricsSnapshot } from "./state/postgres-metrics.ts";
export type { PlatformMetricsSnapshot } from "./state/postgres-metrics.ts";
