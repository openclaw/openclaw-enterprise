import { AsyncLocalStorage } from "node:async_hooks";
import type {
  Agent,
  AgentRevision,
  AgentRuntimeCredentialsInput,
  AgentRuntimeCredentialStatus,
  AuthorizationDecision,
  AuthorizationRequest,
  ComputeDriver,
  ComputeLifecycleHooks,
  Configuration,
  ConfigurationDriver,
  Driver,
  DriverCapability,
  HarnessDescriptor,
  HarnessExecutionMode,
  IAMDriver,
  Installation,
  Namespace,
  NamespaceDeleteResult,
  NamespaceEnsureResult,
  LoggingLevel,
  OpenClawConfigurationDocument,
  PermissionAction,
  PluginDesiredState,
  PluginDriver,
  PluginRevisionState,
  ProviderDefinition,
  ProviderRef,
  ResourceKind,
  ResourceRef,
  SandboxDriver,
  SandboxFacet,
  Secret,
  SecretBindings,
  SecretDriver,
  SecretMetadata,
  ServiceAccount,
  ServiceAccountCredential,
  ServiceAccountDriver,
  HarnessAuthBinding,
  HarnessAuthSnapshot,
} from "@openclaw-enterprise/contracts";
import {
  DRIVER_CAPABILITIES,
  SANDBOX_FACETS,
  admitLoggingConfiguration,
  normalizeLoggingLevel,
  normalizePluginDesiredState,
  normalizeSecretBindings,
  normalizeHarnessAuthBinding,
  freezeAgentRevision,
} from "@openclaw-enterprise/contracts";
import { asRecord, immutableCopy, isNonEmptyString } from "@openclaw-enterprise/utils";
import {
  AuthorizationDeniedError,
  DependencyUnavailableError,
  DriverSelectionError,
  NamespaceNotEmptyError,
  NamespaceNotReadyError,
  NotImplementedError,
  ResourceConflictError,
  ScopeViolationError,
} from "./errors.ts";
import {
  assertConfiguredProvider,
  providerDefinitionMap,
  validateProviderDefinitions,
  validateSelectedProviderDrivers,
  validateServiceAccountProviderBinding,
} from "./providers.ts";
import {
  InMemoryPlatformState,
  type PlatformReadView,
  type PlatformOperation,
  type PlatformStateStore,
  type PlatformUnitOfWork,
} from "./state/platform-state.ts";
import { PostgresCommitOutcomeUnknownError } from "./state/postgres-state.ts";

export {
  AuthorizationDeniedError,
  DependencyUnavailableError,
  DriverSelectionError,
  NamespaceNotEmptyError,
  NamespaceNotReadyError,
  NotImplementedError,
  ResourceConflictError,
  ScopeViolationError,
} from "./errors.ts";
export {
  providerDefinitionMap,
  validateProviderDefinitions,
  validateSelectedProviderDrivers,
  validateServiceAccountProviderBinding,
} from "./providers.ts";
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

export const BOOTSTRAP_DEFAULT_NAMESPACE_NAME = "default";

export interface ControllerOptions {
  readonly authorize?: (
    request: AuthorizationRequest,
  ) => AuthorizationDecision | Promise<AuthorizationDecision>;
  readonly now?: () => Date;
  readonly createId?: (kind: ResourceKind) => string;
  readonly state?: PlatformStateStore;
  readonly recordOperations?: boolean;
  readonly providers?: readonly ProviderDefinition[];
  readonly loggingLevel?: LoggingLevel;
}

export interface CreateNamespaceInput {
  readonly name: string;
  readonly existingNamespace?: string;
}

export interface CreateAgentInput {
  readonly namespaceId: string;
  readonly name: string;
  readonly configurationId: string;
  readonly providerId?: string | null;
  readonly harnessAuth?: HarnessAuthBinding | null;
  readonly executionMode?: HarnessExecutionMode;
  readonly plugins?: PluginDesiredState;
}

export interface UpdateAgentInput {
  readonly namespaceId: string;
  readonly agentId: string;
  readonly configurationId: string;
  readonly providerId?: string | null;
  readonly harnessAuth?: HarnessAuthBinding | null;
  readonly executionMode?: HarnessExecutionMode;
  readonly plugins?: PluginDesiredState;
}

export interface CreateServiceAccountInput {
  readonly namespaceId: string;
  readonly name: string;
}

export type HarnessResolver = (
  harnessId: string,
  executionMode: HarnessExecutionMode,
) => HarnessDescriptor | undefined;

export interface CreateSecretInput {
  readonly namespaceId: string;
  readonly name: string;
  readonly value: string;
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

export interface ActiveAgentRevisionSelection {
  readonly agent: Readonly<Agent>;
  readonly revision: Readonly<AgentRevision>;
}

export type ReconciliationOperation = PlatformOperation;

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
};
type DriverFor<Capability extends DriverCapability> = DriverByCapability[Capability];

const COMPUTE_LIFECYCLE_PHASES = [
  "afterNamespacePrepared",
  "beforeWorkloadStart",
  "beforeWorkloadStop",
  "beforeNamespaceDelete",
] as const satisfies readonly (keyof ComputeLifecycleHooks)[];

function validName(value: unknown): value is string {
  return isNonEmptyString(value) && value.length <= 200;
}

function capability(value: unknown): value is DriverCapability {
  return typeof value === "string" && DRIVER_CAPABILITIES.some((candidate) => candidate === value);
}

function driverHasCapabilityContract(driver: Driver): boolean {
  const candidate = driver as unknown as Record<string, unknown>;
  if (driver.capability === "iam")
    return (
      typeof candidate.lookupIdentity === "function" && typeof candidate.authorize === "function"
    );
  if (driver.capability === "configuration")
    return ["create", "read", "update", "delete", "validate"].every(
      (operation) => typeof candidate[operation] === "function",
    );
  if (driver.capability === "secret")
    return ["create", "update", "delete", "resolve"].every(
      (operation) => typeof candidate[operation] === "function",
    );
  if (driver.capability === "service_account")
    return ["create", "createCredential", "delete"].every(
      (operation) => typeof candidate[operation] === "function",
    );
  if (driver.capability === "sandbox")
    return (
      sandboxFacets(candidate.facets) &&
      (candidate.configureAgent === undefined || typeof candidate.configureAgent === "function") &&
      (candidate.ensureNamespace === undefined ||
        typeof candidate.ensureNamespace === "function") &&
      (candidate.provisionHarness === undefined ||
        typeof candidate.provisionHarness === "function") &&
      typeof candidate.cleanup === "function"
    );
  if (driver.capability === "plugin") return typeof candidate.listCatalog === "function";
  return (
    typeof candidate.ensureNamespace === "function" &&
    typeof candidate.deleteNamespace === "function" &&
    typeof candidate.prepareRevision === "function" &&
    typeof candidate.retireRevision === "function" &&
    (candidate.getAgentRuntimeCredentialStatus === undefined ||
      typeof candidate.getAgentRuntimeCredentialStatus === "function") &&
    (candidate.provisionAgentRuntimeCredentials === undefined ||
      typeof candidate.provisionAgentRuntimeCredentials === "function")
  );
}

function sandboxFacets(value: unknown): value is readonly SandboxFacet[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const seen = new Set<string>();
  const allowed = new Set<string>(SANDBOX_FACETS);
  for (const facet of value) {
    if (typeof facet !== "string" || !allowed.has(facet) || seen.has(facet)) return false;
    seen.add(facet);
  }
  return true;
}

function driverHasValidLifecycleHooks(driver: Driver): boolean {
  const hooks: unknown = driver.computeLifecycleHooks;
  if (hooks === undefined) return true;
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) return false;

  const candidate = hooks as Record<string, unknown>;
  const phases: readonly string[] = COMPUTE_LIFECYCLE_PHASES;
  const keys = Object.keys(candidate);
  return (
    keys.length > 0 &&
    keys.every((key) => phases.includes(key) && typeof candidate[key] === "function")
  );
}

function frozenValues(value: unknown): Readonly<OpenClawConfigurationDocument> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ScopeViolationError("Configuration values must be a JSON object.");
  return immutableCopy(value as OpenClawConfigurationDocument);
}

function configuredRuntime(value: unknown): string | undefined {
  const runtimeValue = asRecord(value)?.agentRuntime;
  if (runtimeValue === undefined) return undefined;
  const runtime = asRecord(runtimeValue);
  if (runtime === undefined || (runtime.id !== "openclaw" && runtime.id !== "codex"))
    throw new ScopeViolationError("The configured model Harness runtime identity is unsupported.");
  return runtime.id;
}

function configuredModels(value: unknown): readonly string[] {
  if (value === undefined) return [];
  const configured = asRecord(value);
  const fallbacks = configured?.fallbacks;
  if (fallbacks !== undefined && !Array.isArray(fallbacks))
    throw new ScopeViolationError("Configured Agent model fallbacks must be an array.");
  const model = typeof value === "string" ? value : configured?.primary;
  const models = [model, ...(fallbacks ?? [])].map((selected) => {
    if (
      !isNonEmptyString(selected) ||
      !selected.includes("/") ||
      selected.startsWith("/") ||
      selected.endsWith("/")
    )
      throw new ScopeViolationError(
        "The configured Agent model must identify its provider and model.",
      );
    return selected;
  });
  if (models.some((selected) => selected.split("/", 2)[0] !== models[0]!.split("/", 2)[0]))
    throw new ScopeViolationError("Configured model fallbacks must retain the primary provider.");
  return models;
}

function matchingSelectableModels(
  value: Readonly<Record<string, unknown>> | undefined,
  selectedModel: string | undefined,
): boolean {
  if (value === undefined || selectedModel === undefined) return false;
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
  if (configured === undefined) return undefined;
  if (!Array.isArray(configured))
    throw new ScopeViolationError("Configured provider models must be a native model array.");
  const matches = configured.filter((candidate) => {
    const value = asRecord(candidate);
    return value?.id === model || value?.id === model.split("/", 2)[1];
  });
  if (matches.length > 1)
    throw new ScopeViolationError("The selected provider model Harness policy is ambiguous.");
  return asRecord(matches[0]);
}

/** Resolve native model policy without treating ignored whole-agent runtime pins as authoritative. */
export function resolveConfiguredHarnessId(
  values: Readonly<OpenClawConfigurationDocument>,
): string {
  const agents = asRecord(values.agents);
  const defaults = asRecord(agents?.defaults);
  const entries = asRecord(agents?.entries);
  if (agents?.list !== undefined && (!Array.isArray(agents.list) || agents.list.length > 0))
    throw new ScopeViolationError("Configured Agent lists are unsupported.");
  const providerConfigurations = asRecord(asRecord(values.models)?.providers);
  const defaultSelection = configuredModels(defaults?.model);
  const defaultModels = asRecord(defaults?.models);
  const candidates: Array<{ model: string; entry?: Readonly<Record<string, unknown>> }> =
    defaultSelection.map((model) => ({ model }));

  for (const value of Object.values(entries ?? {})) {
    const entry = asRecord(value);
    if (entry === undefined)
      throw new ScopeViolationError("The configured Agent runtime entry is invalid.");
    const selection = entry.model === undefined ? defaultSelection : configuredModels(entry.model);
    const model = selection[0];
    if (model === undefined)
      throw new ScopeViolationError("The configured Agent runtime model cannot be resolved.");
    if (candidates[0] !== undefined && model !== candidates[0].model)
      throw new ScopeViolationError("Configured Agent entries must match the primary model.");
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
    if (provider === undefined)
      throw new ScopeViolationError("The configured Agent model provider is invalid.");
    if (provider.models === undefined) continue;
    if (!Array.isArray(provider.models))
      throw new ScopeViolationError("Configured provider models must be a native model array.");
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

  if (candidates.length === 0) return "openclaw";
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
    if (policies.size > 1)
      throw new ScopeViolationError("The selected model has conflicting Harness runtime policies.");
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
    )
      throw new ScopeViolationError("The Codex Harness requires the native codex model provider.");
    resolved.add(selected ?? "openclaw");
  }

  if (resolved.size !== 1)
    throw new ScopeViolationError(
      "The configured Agent models select conflicting Harness runtimes.",
    );
  return [...resolved][0]!;
}

function validExecutionMode(value: unknown): value is HarnessExecutionMode {
  return value === "embedded" || value === "dedicated";
}

function invalidPluginRequest(message: string): never {
  throw new ScopeViolationError(message);
}

function normalizeAgentPlugins(
  plugins: PluginDesiredState | undefined,
): PluginDesiredState | undefined {
  return normalizePluginDesiredState(plugins, invalidPluginRequest);
}

export class OpenClawController {
  readonly installation: Readonly<Installation>;

  private readonly authorization?: ControllerOptions["authorize"];
  private readonly clock: () => Date;
  private readonly identifier?: ControllerOptions["createId"];
  private readonly state: PlatformStateStore;
  private readonly transactionContext = new AsyncLocalStorage<PlatformUnitOfWork>();
  private readonly mutationRollbacks = new AsyncLocalStorage<(() => Promise<void>)[]>();
  private readonly shouldRecordOperations: boolean;
  private readonly registry = new Map<string, RegisteredDriver>();
  private readonly selections = new Map<DriverCapability, RegisteredDriver>();
  private readonly providers: readonly ProviderDefinition[];
  private readonly loggingLevel: LoggingLevel;
  private readonly providerMap: ReadonlyMap<string, ProviderDefinition>;

  constructor(installation: Installation, options: ControllerOptions = {}) {
    if (!isNonEmptyString(installation.id) || !validName(installation.name))
      throw new ScopeViolationError("The controller requires one valid server-owned Installation.");
    if (
      !isNonEmptyString(installation.createdAt) ||
      Number.isNaN(Date.parse(installation.createdAt))
    )
      throw new ScopeViolationError("The server-owned Installation has an invalid creation time.");
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
    this.providers = validateProviderDefinitions(options.providers ?? []);
    this.loggingLevel = normalizeLoggingLevel(options.loggingLevel);
    this.providerMap = providerDefinitionMap(this.providers);
  }

  registerDriver(driver: Driver): Driver {
    if (
      !driver ||
      !isNonEmptyString(driver.id) ||
      !isNonEmptyString(driver.implementation) ||
      !capability(driver.capability) ||
      !driverHasCapabilityContract(driver) ||
      !driverHasValidLifecycleHooks(driver)
    )
      throw new DriverSelectionError("The Driver does not satisfy its exact capability contract.");
    const key = this.driverKey(driver.capability, driver.id);
    if (this.registry.has(key))
      throw new DriverSelectionError(
        "A Driver is already registered for this exact capability and identity.",
      );
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
    if (!capability(selectedCapability) || !isNonEmptyString(driverId))
      throw new DriverSelectionError(
        "The Driver capability or implementation identity is invalid.",
      );
    const selected = this.registry.get(this.driverKey(selectedCapability, driverId));
    if (!selected || !this.unchangedDriver(selected))
      throw new DriverSelectionError(
        "No registered Driver matches the exact selected capability and identity.",
      );
    return this.applyDriverSelection(selectedCapability, selected);
  }

  selectedDriver<Capability extends DriverCapability>(
    selectedCapability: Capability,
  ): DriverFor<Capability> {
    if (!capability(selectedCapability))
      throw new DriverSelectionError("The requested Driver capability is invalid.");
    const selected = this.selections.get(selectedCapability);
    if (!selected || !this.unchangedDriver(selected))
      throw new DriverSelectionError(
        "The selected Driver is unavailable or no longer matches its capability.",
      );
    return selected.driver as DriverFor<Capability>;
  }

  async validateProviderConfiguration(): Promise<void> {
    validateSelectedProviderDrivers(this.providers, this.selections.get("service_account")?.driver);
  }

  async getInstallation(principalId: string): Promise<Readonly<Installation>> {
    await this.authorize(principalId, "read", {
      kind: "installation",
      id: this.installation.id,
    });
    return this.installation;
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
        )
          readable.push(namespace);
      }
      return Object.freeze(readable);
    });
  }

  async getNamespace(principalId: string, namespaceId: string): Promise<Readonly<Namespace>> {
    if (!isNonEmptyString(namespaceId))
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    await this.authorize(principalId, "read", {
      kind: "namespace",
      id: namespaceId,
      namespaceId,
    });
    return this.read(async (state) => this.exactNamespace(state, namespaceId));
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
        )
          readable.push(agent);
      }
      return Object.freeze(readable);
    });
  }

  async getAgent(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<Readonly<Agent>> {
    if (!isNonEmptyString(namespaceId))
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    if (!isNonEmptyString(agentId))
      throw new ScopeViolationError("The exact Agent identity is missing.");
    await this.authorize(principalId, "read", {
      kind: "agent",
      id: agentId,
      namespaceId,
    });
    return this.read(async (state) => {
      const namespace = await this.exactNamespace(state, namespaceId);
      const agent = await state.agents.findAgent(namespace.id, agentId);
      if (!agent)
        throw new ScopeViolationError(
          "The Agent does not belong to the exact Installation and Namespace.",
        );
      return agent;
    });
  }

  async getAgentRuntimeCredentialStatus(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<Readonly<AgentRuntimeCredentialStatus>> {
    if (!isNonEmptyString(namespaceId))
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    if (!isNonEmptyString(agentId))
      throw new ScopeViolationError("The exact Agent identity is missing.");
    await this.authorize(principalId, "read", {
      kind: "agent",
      id: agentId,
      namespaceId,
    });
    return this.read(async (state) => {
      const namespace = await this.exactNamespace(state, namespaceId);
      const agent = await state.agents.findAgent(namespace.id, agentId);
      if (!agent)
        throw new ScopeViolationError(
          "The Agent does not belong to the exact Installation and Namespace.",
        );
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
    if (!isNonEmptyString(namespaceId))
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    if (!isNonEmptyString(agentId))
      throw new ScopeViolationError("The exact Agent identity is missing.");
    return this.mutate(async (state) => {
      const namespace = await this.lockNamespace(state, namespaceId);
      const agent = await state.agents.lockAgent(namespace.id, agentId);
      if (!agent)
        throw new ScopeViolationError(
          "The Agent does not belong to the exact Installation and Namespace.",
        );
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
      if (namespace.status !== "ready") throw new NamespaceNotReadyError();
      if ((await state.revisions.listRevisions(namespace.id, agent.id)).length > 0)
        throw new ResourceConflictError(
          "Runtime credentials can be provisioned only before the Agent has historical revisions.",
        );
      const driver = this.runtimeCredentialComputeDriver("provision");
      return this.runtimeCredentialStatus(
        await this.runtimeCredentialOperation(() =>
          driver.provisionAgentRuntimeCredentials!({ namespace, agent }, credentials),
        ),
      );
    });
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
        )
          readable.push(account);
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
        )
          readable.push(revision);
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
    if (!isNonEmptyString(namespaceId))
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    if (!isNonEmptyString(agentId))
      throw new ScopeViolationError("The exact Agent identity is missing.");
    if (!isNonEmptyString(revisionId))
      throw new ScopeViolationError("The exact AgentRevision identity is missing.");
    return this.read(async (state) => {
      const namespace = await this.exactNamespace(state, namespaceId);
      const agent = await state.agents.findAgent(namespace.id, agentId);
      if (!agent)
        throw new ScopeViolationError(
          "The Agent does not belong to the exact Installation and Namespace.",
        );
      await this.authorize(principalId, "read", {
        kind: "agent_revision",
        id: revisionId,
        namespaceId: namespace.id,
      });
      const revision = await state.revisions.findRevision(namespace.id, agent.id, revisionId);
      if (!revision)
        throw new ScopeViolationError(
          "The AgentRevision does not belong to the exact Agent and Namespace.",
        );
      return revision;
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

  private async getAuthorizedActiveAgentRevision(
    principalId: string,
    namespaceId: string,
    agentId: string,
    action: PermissionAction,
  ): Promise<ActiveAgentRevisionSelection> {
    if (!isNonEmptyString(namespaceId))
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    if (!isNonEmptyString(agentId))
      throw new ScopeViolationError("The exact Agent identity is missing.");
    await this.authorize(principalId, action, {
      kind: "agent",
      id: agentId,
      namespaceId,
    });
    return this.read(async (state) => {
      const namespace = await this.exactNamespace(state, namespaceId);
      const agent = await state.agents.findAgent(namespace.id, agentId);
      if (!agent)
        throw new ScopeViolationError(
          "The Agent does not belong to the exact Installation and Namespace.",
        );
      if (!isNonEmptyString(agent.activeRevisionId))
        throw new DependencyUnavailableError("The Agent has no active gateway revision.");
      const revision = await state.revisions.findRevision(
        namespace.id,
        agent.id,
        agent.activeRevisionId,
      );
      if (!revision)
        throw new DependencyUnavailableError("The active Agent revision is unavailable.");
      return Object.freeze({ agent, revision });
    });
  }

  async createNamespace(
    principalId: string,
    input: CreateNamespaceInput,
  ): Promise<Readonly<Namespace>> {
    if (!validName(input.name)) throw new ScopeViolationError("The Namespace name is invalid.");
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
        )
          throw new ResourceConflictError(
            "Existing namespace adoption requires the bundled Kubernetes Compute Driver.",
          );
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

  async createSecret(
    principalId: string,
    input: CreateSecretInput,
  ): Promise<Readonly<SecretMetadata>> {
    this.validateSecretValue(input.value);
    if (!validName(input.name)) throw new ScopeViolationError("The Secret name is invalid.");
    return this.mutate(async (state) => {
      const namespace = await this.lockNamespace(state, input.namespaceId);
      await this.authorize(principalId, "create", {
        kind: "secret",
        id: namespace.id,
        namespaceId: namespace.id,
      });
      if (namespace.status !== "ready") throw new NamespaceNotReadyError();
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
      if (!secret)
        throw new ScopeViolationError("The Secret does not belong to the exact Namespace.");
      return this.secretMetadata(secret);
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
      if (namespace.status !== "ready") throw new NamespaceNotReadyError();
      const secret = await state.secrets.lockSecret(namespace.id, input.secretId);
      if (!secret)
        throw new ScopeViolationError("The Secret does not belong to the exact Namespace.");
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
      if (!secret)
        throw new ScopeViolationError("The Secret does not belong to the exact Namespace.");
      if (await state.secrets.hasReferences(namespace.id, secret.id))
        throw new ResourceConflictError(
          "A Configuration, active revision, or pending deployment still references the Secret.",
        );
      const driver = this.secretDriver(secret.driverId);
      await this.secretOperation(() => driver.delete(secret));
      if (!(await state.secrets.deleteSecret(namespace.id, secret.id)))
        throw new ResourceConflictError("The Secret changed during deletion.");
    });
  }

  async createConfiguration(
    principalId: string,
    input: CreateConfigurationInput,
  ): Promise<Readonly<Configuration>> {
    if (input.kind !== "agent")
      throw new ScopeViolationError("The Configuration kind must identify an Agent.");
    const values = frozenValues(input.values);
    return this.mutate(async (state) => {
      const namespace = await this.lockNamespace(state, input.namespaceId);
      if (namespace.status !== "provisioning" && namespace.status !== "ready")
        throw new ResourceConflictError("The Namespace does not accept new Configurations.");
      await this.authorize(principalId, "create", {
        kind: "configuration",
        id: namespace.id,
        namespaceId: namespace.id,
      });
      if (namespace.existingNamespace !== undefined && namespace.status !== "ready")
        throw new NamespaceNotReadyError();
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
    if (!validName(input.name))
      throw new ScopeViolationError("The ServiceAccount name is invalid.");
    return this.mutate(async (state) => {
      const namespace = await this.exactNamespace(state, input.namespaceId);
      if (namespace.status !== "provisioning" && namespace.status !== "ready")
        throw new ResourceConflictError("The Namespace does not accept new ServiceAccounts.");
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
      if (driver !== undefined)
        await this.driverOperation(() => driver.create(account), "ServiceAccount");
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
      if (account === undefined)
        throw new ScopeViolationError("The ServiceAccount does not belong to the exact Namespace.");
      if (account.credential !== undefined)
        throw new ResourceConflictError("The ServiceAccount already has a credential.");
      const driver = this.serviceAccountDriver();
      if (driver === undefined)
        throw new DependencyUnavailableError("The selected ServiceAccount Driver is unavailable.");
      const credential = await this.driverOperation(
        () => driver.createCredential(account),
        "ServiceAccount",
      );
      if (credential?.kind !== "access_token")
        throw new DependencyUnavailableError(
          "The ServiceAccount Driver returned an unsupported credential.",
        );
      const updated = await state.serviceAccounts.updateCredential(
        namespace.id,
        account.id,
        credential,
      );
      if (updated === undefined)
        throw new ResourceConflictError("The ServiceAccount credential changed during its update.");
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
      if (account === undefined)
        throw new ScopeViolationError("The ServiceAccount does not belong to the exact Namespace.");
      if (account.credential?.kind === "access_token" || credential.kind === "access_token")
        throw new ResourceConflictError(
          "A managed ServiceAccount credential cannot be manually updated.",
        );
      const updated = await state.serviceAccounts.updateCredential(
        namespace.id,
        account.id,
        credential,
      );
      if (updated === undefined)
        throw new ResourceConflictError("The ServiceAccount credential changed during its update.");
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
      if (account === undefined)
        throw new ScopeViolationError("The ServiceAccount does not belong to the exact Namespace.");
      if (await state.serviceAccounts.hasReferences(namespace.id, account.id))
        throw new ResourceConflictError(
          "An Agent draft, active revision, or pending deployment still references the exact ServiceAccount.",
        );
      const driver = this.serviceAccountDriver();
      if (account.credential?.kind === "access_token" && driver === undefined)
        throw new DependencyUnavailableError("The selected ServiceAccount Driver is unavailable.");
      if (driver !== undefined)
        await this.driverOperation(() => driver.delete(account), "ServiceAccount");
      if (!(await state.serviceAccounts.deleteServiceAccount(namespace.id, account.id)))
        throw new ResourceConflictError("The ServiceAccount changed during deletion.");
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
      if (!metadata)
        throw new ScopeViolationError("The Configuration does not belong to the exact Namespace.");
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
    if (Object.hasOwn(input, "kind"))
      throw new ScopeViolationError("The Configuration kind cannot be changed.");
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
      if (!metadata)
        throw new ScopeViolationError("The Configuration does not belong to the exact Namespace.");
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
      if (!advanced)
        throw new ResourceConflictError("The Configuration generation changed during its update.");
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
      if (!configuration)
        throw new ScopeViolationError("The Configuration does not belong to the exact Namespace.");
      const agents = await state.agents.listAgents(namespace.id);
      if (agents.some((agent) => agent.configurationId === configuration.id))
        throw new ResourceConflictError("An Agent still references the exact Configuration.");
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
      if (!(await state.configurations.deleteConfiguration(namespace.id, configuration.id)))
        throw new ResourceConflictError("The Configuration changed during deletion.");
    });
  }

  async createAgent(principalId: string, input: CreateAgentInput): Promise<Readonly<Agent>> {
    if (!validName(input.name)) throw new ScopeViolationError("The Agent name is invalid.");
    if (!isNonEmptyString(input.configurationId))
      throw new ScopeViolationError("The exact Agent Configuration identity is missing.");
    this.rejectLegacyAgentAuth(input);
    const harnessAuth = this.harnessAuthBinding(input.harnessAuth ?? null);
    const executionMode = input.executionMode ?? "embedded";
    if (!validExecutionMode(executionMode))
      throw new ScopeViolationError("The Agent Harness execution mode is invalid.");
    const providerId = this.providerId(input.providerId);
    const plugins = normalizeAgentPlugins(input.plugins);
    return this.mutate(async (state) => {
      const namespace = await this.lockNamespace(state, input.namespaceId);
      if (namespace.status !== "provisioning" && namespace.status !== "ready")
        throw new ResourceConflictError("The Namespace does not accept new Agents.");
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
      if (!configuration || configuration.kind !== "agent")
        throw new ScopeViolationError(
          "The Agent Configuration must belong to the exact Namespace and configure an Agent.",
        );
      await this.authorizeHarnessAuthSource(state, principalId, namespace.id, harnessAuth);
      const agentId = this.nextIdentifier("agent");
      await this.authorizeBindings(
        state,
        principalId,
        namespace.id,
        this.bindings(configuration.secretBindings),
      );

      const agent = await state.agents.createAgent({
        id: agentId,
        namespaceId: namespace.id,
        name: input.name,
        configurationId: input.configurationId,
        providerId,
        harnessAuth,
        executionMode,
        ...(plugins === undefined ? {} : { plugins }),
        servicePrincipalId: `service-agent-${agentId}`,
        desiredRuntimeState: "stopped",
        createdAt: this.timestamp(),
      });
      return agent;
    });
  }

  async updateAgent(principalId: string, input: UpdateAgentInput): Promise<Readonly<Agent>> {
    if (!isNonEmptyString(input.agentId))
      throw new ScopeViolationError("The exact Agent identity is missing.");
    if (!isNonEmptyString(input.configurationId))
      throw new ScopeViolationError("The exact Agent Configuration identity is missing.");
    this.rejectLegacyAgentAuth(input);
    const requestedAuth =
      input.harnessAuth === undefined ? undefined : this.harnessAuthBinding(input.harnessAuth);
    if (input.executionMode !== undefined && !validExecutionMode(input.executionMode))
      throw new ScopeViolationError("The Agent Harness execution mode is invalid.");
    const plugins = normalizeAgentPlugins(input.plugins);
    return this.mutate(async (state) => {
      const namespace = await this.lockNamespace(state, input.namespaceId);
      const agent = await state.agents.lockAgent(namespace.id, input.agentId);
      if (!agent)
        throw new ScopeViolationError(
          "The Agent does not belong to the exact Installation and Namespace.",
        );
      await this.authorize(principalId, "update", {
        kind: "agent",
        id: agent.id,
        namespaceId: namespace.id,
      });
      await this.authorize(principalId, "read", {
        kind: "configuration",
        id: input.configurationId,
        namespaceId: namespace.id,
      });
      const configuration = await state.configurations.findConfiguration(
        namespace.id,
        input.configurationId,
      );
      if (!configuration || configuration.kind !== "agent")
        throw new ScopeViolationError(
          "The Agent Configuration must belong to the exact Namespace and configure an Agent.",
        );
      this.rejectLegacyAgentAuth(agent);
      const previousAuth = this.harnessAuthBinding(agent.harnessAuth);
      await this.authorizeHarnessAuthSource(state, principalId, namespace.id, previousAuth);
      if (requestedAuth !== undefined) {
        await this.authorizeHarnessAuthSource(state, principalId, namespace.id, requestedAuth);
      }
      const secretBindings = this.bindings(configuration.secretBindings);
      await this.authorizeBindings(state, principalId, namespace.id, secretBindings);
      const providerId = this.providerId(input.providerId, agent.providerId);
      const updated = await state.agents.updateConfiguration(
        namespace.id,
        agent.id,
        input.configurationId,
        input.executionMode,
        requestedAuth,
        input.providerId === undefined ? undefined : providerId,
        plugins,
      );
      if (!updated)
        throw new ResourceConflictError("The Agent Configuration changed during its update.");
      return updated;
    });
  }

  async deployAgent(
    principalId: string,
    input: DeployAgentInput,
    resolveHarness: HarnessResolver,
  ): Promise<Readonly<AgentRevision>> {
    if (!isNonEmptyString(input.agentId))
      throw new ScopeViolationError("The exact Agent identity is missing.");
    return this.mutate(async (state) => {
      const namespace = await this.lockNamespace(state, input.namespaceId);
      const agent = await state.agents.findAgent(namespace.id, input.agentId);
      if (!agent)
        throw new ScopeViolationError(
          "The Agent does not belong to the exact Installation and Namespace.",
        );
      await this.authorize(principalId, "deploy", {
        kind: "agent",
        id: agent.id,
        namespaceId: namespace.id,
      });
      if (namespace.status !== "ready") throw new NamespaceNotReadyError();
      if (typeof resolveHarness !== "function")
        throw new DependencyUnavailableError("The selected Harness descriptor is unavailable.");

      let compute: ComputeDriver;
      try {
        compute = this.selectedDriver("compute");
      } catch {
        throw new DependencyUnavailableError("The selected compute Driver is unavailable.");
      }
      const sandbox = this.sandboxDriver();

      const lockedAgent = await state.agents.lockAgent(namespace.id, agent.id);
      if (!lockedAgent || !isNonEmptyString(lockedAgent.servicePrincipalId))
        throw new ScopeViolationError(
          "The Agent or its service principal does not belong to the exact Namespace.",
        );
      const providerId = this.providerId(lockedAgent.providerId);
      if (sandbox !== undefined && lockedAgent.executionMode !== "dedicated")
        throw new ScopeViolationError(
          "The selected Sandbox Driver supports only dedicated Harness execution.",
        );
      this.rejectLegacyAgentAuth(lockedAgent);
      const harnessAuth = await this.admitHarnessAuth(state, principalId, lockedAgent);
      await this.authorize(principalId, "read", {
        kind: "configuration",
        id: lockedAgent.configurationId,
        namespaceId: namespace.id,
      });
      const metadata = await state.configurations.lockConfiguration(
        namespace.id,
        lockedAgent.configurationId,
      );
      if (!metadata || metadata.kind !== "agent")
        throw new ScopeViolationError(
          "The Agent Configuration must belong to the exact Namespace and configure an Agent.",
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
        )
          throw new DependencyUnavailableError("The Secret backend identity changed.");
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
      if (!validExecutionMode(lockedAgent.executionMode))
        throw new ScopeViolationError("The persisted Agent Harness execution mode is invalid.");
      const configuredHarnessId = resolveConfiguredHarnessId(admittedConfiguration);
      const approvedHarness = resolveHarness(configuredHarnessId, lockedAgent.executionMode);
      if (
        approvedHarness === undefined ||
        !isNonEmptyString(approvedHarness.id) ||
        !isNonEmptyString(approvedHarness.version)
      ) {
        throw new DependencyUnavailableError("The selected Harness runtime is not approved.");
      }
      if (approvedHarness.id !== configuredHarnessId)
        throw new ScopeViolationError("The approved Harness does not match the native runtime.");
      if (
        (approvedHarness.id === "openclaw" && lockedAgent.executionMode !== "embedded") ||
        (approvedHarness.id === "codex" && lockedAgent.executionMode !== "dedicated") ||
        (approvedHarness.id !== "openclaw" && approvedHarness.id !== "codex")
      ) {
        throw new ScopeViolationError("The selected Harness does not support this execution mode.");
      }
      if (compute.validateHarnessAuth === undefined)
        throw new DependencyUnavailableError(
          "The selected Compute Driver does not support Harness authentication bindings.",
        );
      try {
        compute.validateHarnessAuth(
          { ...approvedHarness, mode: lockedAgent.executionMode },
          harnessAuth,
          admittedConfiguration,
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
              return immutableCopy({
                driver: { id: driver.id, implementation: driver.implementation },
                plugins: lockedAgent.plugins,
              } satisfies PluginRevisionState);
            })();
      const previous = await state.revisions.listRevisions(namespace.id, lockedAgent.id);
      const revision = await state.revisions.createRevision(
        freezeAgentRevision({
          id: this.nextIdentifier("agent_revision"),
          namespaceId: namespace.id,
          agentId: lockedAgent.id,
          revision: previous.length + 1,
          providerId,
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
          harnessAuth,
          servicePrincipalId: lockedAgent.servicePrincipalId,
          createdAt: this.timestamp(),
        }),
      );
      const running = await state.agents.transitionAgentDesiredRuntimeState(
        namespace.id,
        lockedAgent.id,
        lockedAgent.desiredRuntimeState,
        "running",
      );
      if (running === undefined)
        throw new ResourceConflictError("The Agent lifecycle changed during deployment.");
      await this.record(state, {
        kind: "agent_revision",
        action: "reconcile",
        namespaceId: namespace.id,
        resourceId: revision.id,
        actorId: principalId,
      });
      return revision;
    });
  }

  async stopAgent(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<Readonly<Agent>> {
    if (!isNonEmptyString(namespaceId))
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    if (!isNonEmptyString(agentId))
      throw new ScopeViolationError("The exact Agent identity is missing.");
    return this.mutate(async (state) => {
      await this.lockNamespace(state, namespaceId);
      const agent = await state.agents.lockAgent(namespaceId, agentId);
      if (agent === undefined)
        throw new ScopeViolationError(
          "The Agent does not belong to the exact Installation and Namespace.",
        );
      await this.authorize(principalId, "operate", {
        kind: "agent",
        id: agent.id,
        namespaceId: agent.namespaceId,
      });
      const stopped = await state.agents.transitionAgentDesiredRuntimeState(
        namespaceId,
        agentId,
        agent.desiredRuntimeState,
        "stopped",
      );
      if (stopped === undefined)
        throw new ResourceConflictError("The Agent lifecycle changed during stop.");
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
    if (!isNonEmptyString(namespaceId))
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    return this.mutate(async (state) => {
      const namespace = await state.namespaces.lockNamespace(namespaceId);
      if (!namespace)
        throw new ScopeViolationError(
          "The Namespace does not belong to the server-owned Installation.",
        );
      await this.authorize(principalId, "delete", {
        kind: "namespace",
        id: namespace.id,
        namespaceId: namespace.id,
      });
      if (namespace.status === "deleting") return namespace;
      if (await state.namespaces.hasAgents(namespace.id)) throw new NamespaceNotEmptyError();
      if (await state.namespaces.hasConfigurations(namespace.id))
        throw new NamespaceNotEmptyError();
      if (await state.namespaces.hasSecrets(namespace.id)) throw new NamespaceNotEmptyError();
      if (await state.namespaces.hasServiceAccounts(namespace.id))
        throw new NamespaceNotEmptyError();
      const deleting = await state.namespaces.transitionNamespaceStatus(
        namespace.id,
        ["provisioning", "ready", "failed"],
        "deleting",
      );
      if (!deleting)
        throw new ResourceConflictError("The Namespace lifecycle changed during deletion.");
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
   * Execute one deterministic Namespace lifecycle attempt for a claimed work item.
   * This is a reusable conformance harness, not a polling production worker.
   */
  async handleNamespaceLifecycle(
    actorId: string,
    namespaceId: string,
    target: "ready" | "deleted",
  ): Promise<Readonly<Namespace> | undefined> {
    if (!isNonEmptyString(actorId))
      throw new ScopeViolationError("The lifecycle actor is missing.");
    if (!isNonEmptyString(namespaceId))
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    if (target !== "ready" && target !== "deleted")
      throw new ScopeViolationError("The Namespace lifecycle target is invalid.");
    const namespace = await this.mutate((state) =>
      state.namespaces.lockNamespace(namespaceId, {
        includeDeleted: true,
      }),
    );
    if (!namespace || namespace.deletedAt !== undefined) return undefined;
    if (target === "ready" && namespace.status !== "provisioning") return namespace;
    if (target === "deleted" && namespace.status !== "deleting") return namespace;

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
        if (!current || current.deletedAt !== undefined) return undefined;
        if (current.status !== "deleting") return current;
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
      if (!current) return undefined;
      if (current.status !== "provisioning") return current;
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
    if (active) return work(active);

    const rollbacks: (() => Promise<void>)[] = [];
    try {
      return await this.state.transact(async (state) =>
        this.transactionContext.run(state, () =>
          this.mutationRollbacks.run(rollbacks, async () => {
            const existing = await state.installations.getInstallation();
            if (!existing) await state.installations.createInstallation(this.installation);
            else if (existing.id !== this.installation.id)
              throw new ScopeViolationError(
                "The controller state belongs to another Installation.",
              );
            return work(state);
          }),
        ),
      );
    } catch (error) {
      if (error instanceof PostgresCommitOutcomeUnknownError) throw error;
      let rollbackFailed = false;
      for (const rollback of rollbacks.reverse()) {
        try {
          await rollback();
        } catch {
          rollbackFailed = true;
        }
      }
      if (rollbackFailed)
        throw new DependencyUnavailableError(
          "A Driver could not roll back a failed resource mutation.",
        );
      throw error;
    }
  }

  /** Compensate a Driver side effect if the owning resource transaction fails. */
  registerRollback(rollback: () => Promise<void>): void {
    const rollbacks = this.mutationRollbacks.getStore();
    if (rollbacks === undefined || this.transactionContext.getStore() === undefined)
      throw new DependencyUnavailableError("The platform mutation transaction is unavailable.");
    rollbacks.push(rollback);
  }

  pendingOperations(): readonly Readonly<ReconciliationOperation>[] {
    if (this.state instanceof InMemoryPlatformState) return this.state.pendingOperations();
    return Object.freeze([]);
  }

  private async authorize(
    principalId: string,
    action: AuthorizationRequest["action"],
    resource: ResourceRef,
  ): Promise<void> {
    const decision = await this.authorizationDecision(principalId, action, resource);
    if (!decision.allowed)
      throw new AuthorizationDeniedError(
        isNonEmptyString(decision.reason) ? decision.reason : "The exact operation was denied.",
        decision.evidence,
        { action, resource },
      );
  }

  private async canRead(principalId: string, resource: ResourceRef): Promise<boolean> {
    return (await this.authorizationDecision(principalId, "read", resource)).allowed;
  }

  private authorizationAuthority(principalId: string): IAMDriver {
    if (!isNonEmptyString(principalId))
      throw new AuthorizationDeniedError("The acting identity is unavailable.");
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
  ): Promise<AuthorizationDecision> {
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
    if (
      !decision ||
      typeof decision.allowed !== "boolean" ||
      !isNonEmptyString(decision.driverId) ||
      !decision.evidence ||
      (decision.evidence.identityId !== undefined &&
        !isNonEmptyString(decision.evidence.identityId)) ||
      !["groupIds", "bindingIds", "roleIds", "restrictionIds"].every((key) => {
        const entries = decision.evidence[key as keyof typeof decision.evidence];
        return Array.isArray(entries) && entries.every(isNonEmptyString);
      })
    )
      throw new DependencyUnavailableError(
        "The selected authorization Driver returned an invalid decision.",
      );
    if (decision.driverId !== selected.id || this.authorizationAuthority(principalId) !== selected)
      throw new DependencyUnavailableError("The authorization decision belongs to another Driver.");
    return decision;
  }

  private async exactNamespace(
    state: PlatformReadView,
    namespaceId: string,
  ): Promise<Readonly<Namespace>> {
    if (!isNonEmptyString(namespaceId))
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    const namespace = await state.namespaces.findNamespace(namespaceId);
    if (!namespace)
      throw new ScopeViolationError(
        "The Namespace does not belong to the server-owned Installation.",
      );
    return namespace;
  }

  private async lockNamespace(
    state: PlatformUnitOfWork,
    namespaceId: string,
  ): Promise<Readonly<Namespace>> {
    if (!isNonEmptyString(namespaceId))
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    const namespace = await state.namespaces.lockNamespace(namespaceId);
    if (!namespace)
      throw new ScopeViolationError(
        "The Namespace does not belong to the server-owned Installation.",
      );
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
      if (source.namespaceId !== namespaceId)
        throw new ScopeViolationError("Secret references cannot cross Namespaces.");
      await this.authorize(principalId, "operate", source);
      const secret = await state.secrets.lockSecret(namespaceId, source.id);
      if (!secret)
        throw new ScopeViolationError("The Secret does not belong to the exact Namespace.");
      this.secretDriver(secret.driverId);
      secrets.set(secret.id, secret);
    }
    return Object.freeze([...secrets.values()]);
  }

  private rejectLegacyAgentAuth(value: object): void {
    if (Object.hasOwn(value, "serviceAccountId"))
      throw new ScopeViolationError(
        "Agent.serviceAccountId is no longer supported; select harnessAuth explicitly.",
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
    if (binding === null || binding.method === "runtime") return;
    if (binding.method === "api_key") {
      if (binding.source.namespaceId !== namespaceId)
        throw new ScopeViolationError("Harness authentication sources cannot cross Namespaces.");
      await this.authorize(principalId, "operate", binding.source);
      const source = await state.secrets.lockSecret(namespaceId, binding.source.id);
      if (source === undefined)
        throw new ScopeViolationError("The Harness Secret does not belong to the exact Namespace.");
      this.secretDriver(source.driverId);
    } else {
      await this.authorize(principalId, "read", {
        kind: "service_account",
        namespaceId,
        id: binding.serviceAccountId,
      });
      await this.exactServiceAccount(state, namespaceId, binding.serviceAccountId);
    }
  }

  private async admitHarnessAuth(
    state: PlatformUnitOfWork,
    principalId: string,
    agent: Readonly<Agent>,
  ): Promise<HarnessAuthSnapshot> {
    const binding = this.harnessAuthBinding(agent.harnessAuth);
    if (binding === null)
      throw new ResourceConflictError(
        "Deployment requires an explicit Harness authentication binding.",
      );
    await this.authorizeHarnessAuthSource(state, principalId, agent.namespaceId, binding);
    if (binding.method === "runtime") return immutableCopy(binding);
    if (binding.method === "api_key") {
      await this.authorize(agent.servicePrincipalId, "operate", binding.source);
      const source = await state.secrets.lockSecret(agent.namespaceId, binding.source.id);
      if (source === undefined) throw new ScopeViolationError("The Harness Secret is unavailable.");
      const driver = this.secretDriver(source.driverId);
      const resolved = await this.secretOperation(() => driver.resolve(source));
      if (
        Object.keys(source.backendRef).some(
          (key) =>
            resolved[key as keyof typeof resolved] !==
            source.backendRef[key as keyof typeof source.backendRef],
        )
      )
        throw new DependencyUnavailableError("The Harness Secret backend identity changed.");
      return immutableCopy({ ...binding, secretDriverId: driver.id });
    }
    const account = await state.serviceAccounts.lockServiceAccount(
      agent.namespaceId,
      binding.serviceAccountId,
    );
    if (account?.credential?.kind !== "access_token")
      throw new ResourceConflictError(
        "ChatGPT Harness authentication requires an issued account access-token credential.",
      );
    const providerBinding = await state.serviceAccounts.findServiceAccountProviderBinding(
      agent.namespaceId,
      binding.serviceAccountId,
    );
    validateServiceAccountProviderBinding(this.providerMap, agent.providerId, providerBinding);
    const driver = this.serviceAccountDriver();
    if (providerBinding === undefined || driver?.id !== providerBinding.driverId)
      throw new DependencyUnavailableError(
        "The Harness ServiceAccount Driver does not match the admitted Provider.",
      );
    return immutableCopy({
      ...binding,
      credential: { kind: "access_token" as const, secretRef: account.credential.secretRef },
      providerBinding,
    });
  }

  private validateSecretValue(value: unknown): asserts value is string {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.includes("\u0000") ||
      /[\uD800-\uDFFF]/u.test(value) ||
      Buffer.byteLength(value, "utf8") > 65_536
    )
      throw new ScopeViolationError(
        "The Secret value must be nonempty UTF-8, without NUL, and at most 65536 bytes.",
      );
  }

  private validateRuntimeCredentialValue(value: unknown): asserts value is string {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.includes("\u0000") ||
      /[\uD800-\uDFFF]/u.test(value) ||
      Buffer.byteLength(value, "utf8") > 65_536
    )
      throw new ScopeViolationError(
        "Agent runtime credential values must be nonempty UTF-8, without NUL, and at most 65536 bytes.",
      );
  }

  private runtimeCredentialsInput(
    input: AgentRuntimeCredentialsInput,
  ): AgentRuntimeCredentialsInput {
    const candidate = asRecord(input);
    if (candidate === undefined)
      throw new ScopeViolationError("Agent runtime credentials must be a JSON object.");
    const keys = Object.keys(candidate);
    if (!keys.every((key) => key === "slack"))
      throw new ScopeViolationError("Agent runtime credentials contain unsupported fields.");
    let slack: AgentRuntimeCredentialsInput["slack"];
    if (candidate.slack !== undefined) {
      const slackCandidate = asRecord(candidate.slack);
      if (
        slackCandidate === undefined ||
        !["appToken", "botToken"].every((key) => Object.hasOwn(slackCandidate, key)) ||
        !Object.keys(slackCandidate).every((key) => key === "appToken" || key === "botToken")
      )
        throw new ScopeViolationError("Agent Slack runtime credentials are invalid.");
      this.validateRuntimeCredentialValue(slackCandidate.appToken);
      this.validateRuntimeCredentialValue(slackCandidate.botToken);
      slack = {
        appToken: slackCandidate.appToken,
        botToken: slackCandidate.botToken,
      };
    }
    return Object.freeze({
      ...(slack === undefined ? {} : { slack: Object.freeze(slack) }),
    });
  }

  private runtimeCredentialStatus(
    status: AgentRuntimeCredentialStatus,
  ): Readonly<AgentRuntimeCredentialStatus> {
    if (
      status === undefined ||
      typeof status.transportConfigured !== "boolean" ||
      typeof status.slackConfigured !== "boolean"
    )
      throw new DependencyUnavailableError(
        "The selected compute Driver returned invalid runtime credential metadata.",
      );
    return Object.freeze({
      transportConfigured: status.transportConfigured,
      slackConfigured: status.slackConfigured,
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
      if (expectedId !== undefined && driver.id !== expectedId)
        throw new Error("Driver identity mismatch.");
      return driver;
    } catch {
      throw new DependencyUnavailableError(
        "The selected Secret Driver is unavailable or does not own this Secret.",
      );
    }
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
    if (typeof method !== "function")
      throw new DependencyUnavailableError(
        "The selected compute Driver does not support Agent runtime credentials.",
      );
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

  /** Secret SDK error bodies can contain request bytes; never propagate their message or cause. */
  private async secretOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ResourceConflictError)
        throw new ResourceConflictError(
          "The Secret backend identity or concurrency precondition conflicts.",
        );
      if (error instanceof ScopeViolationError)
        throw new ScopeViolationError("The Secret backend ownership could not be verified.");
      throw new DependencyUnavailableError(
        "The Secret storage operation failed or its outcome is unknown.",
      );
    }
  }

  private configurationIdentity(namespaceId: string, configurationId: string): void {
    if (!isNonEmptyString(namespaceId))
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    if (!isNonEmptyString(configurationId))
      throw new ScopeViolationError("The exact Configuration identity is missing.");
  }

  private serviceAccountIdentity(namespaceId: string, serviceAccountId: string): void {
    if (!isNonEmptyString(namespaceId))
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    if (!isNonEmptyString(serviceAccountId))
      throw new ScopeViolationError("The exact ServiceAccount identity is missing.");
  }

  private async exactServiceAccount(
    state: PlatformReadView,
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<Readonly<ServiceAccount>> {
    const account = await state.serviceAccounts.findServiceAccount(namespaceId, serviceAccountId);
    if (account === undefined)
      throw new ScopeViolationError("The ServiceAccount does not belong to the exact Namespace.");
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
    if (!this.selections.has("service_account")) return undefined;
    try {
      return this.selectedDriver("service_account");
    } catch {
      throw new DependencyUnavailableError("The selected ServiceAccount Driver is unavailable.");
    }
  }

  private sandboxDriver(): SandboxDriver | undefined {
    if (!this.selections.has("sandbox")) return undefined;
    try {
      return this.selectedDriver("sandbox");
    } catch {
      throw new DependencyUnavailableError("The selected Sandbox Driver is unavailable.");
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
    )
      throw new DependencyUnavailableError("The selected Harness runtime is not approved.");
    if (harness.id !== configuredHarnessId)
      throw new ScopeViolationError("The approved Harness does not match the native runtime.");
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
    if (!metadata || metadata.kind !== "agent")
      throw new ScopeViolationError(
        "The Agent Configuration must belong to the exact Namespace and configure an Agent.",
      );
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
      )
        throw error;
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
    )
      throw new DependencyUnavailableError(
        "The Configuration Driver returned a resource outside its exact ownership scope.",
      );
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
      service_account: "sa",
      secret: "sec",
      agent: "agt",
      agent_revision: "rev",
    };
    const result = this.identifier
      ? this.identifier(kind)
      : `${prefixes[kind]}_${crypto.randomUUID()}`;
    if (!isNonEmptyString(result))
      throw new ScopeViolationError("The server generated an invalid resource identity.");
    return result;
  }

  private timestamp(): string {
    const now = this.clock();
    if (!(now instanceof Date) || Number.isNaN(now.getTime()))
      throw new ScopeViolationError("The controller clock returned an invalid timestamp.");
    return now.toISOString();
  }

  private driverKey(selectedCapability: DriverCapability, driverId: string): string {
    return `${selectedCapability}\u0000${driverId}`;
  }

  private providerId(value: ProviderRef | undefined, preserve?: ProviderRef): ProviderRef {
    const providerId = value === undefined ? (preserve ?? null) : value;
    assertConfiguredProvider(this.providerMap, providerId, "Provider");
    return providerId;
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
      if (!this.unchangedDriver(compute))
        throw new DriverSelectionError("The selected compute Driver identity has changed.");
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
      if (selectedCapability === "compute") continue;
      if (!this.unchangedDriver(selected))
        throw new DriverSelectionError(
          "A selected lifecycle Driver no longer matches its registered identity.",
        );
      if (selected.driver.computeLifecycleHooks !== undefined) drivers.push(selected.driver);
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

  private async mutate<T>(work: (state: PlatformUnitOfWork) => Promise<T>): Promise<T> {
    const active = this.transactionContext.getStore();
    return active ? work(active) : this.transact(work);
  }

  private validateLifecycleScope(result: unknown, namespace: Readonly<Namespace>): void {
    const candidate = result as {
      readonly namespaceId?: unknown;
    };
    if (!candidate || candidate.namespaceId !== namespace.id)
      throw new DependencyUnavailableError(
        "The compute Driver returned lifecycle evidence for another Namespace.",
      );
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
    )
      throw new DependencyUnavailableError(
        "The compute Driver returned invalid Namespace readiness evidence.",
      );
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
    )
      throw new DependencyUnavailableError(
        "The compute Driver returned invalid Namespace deletion evidence.",
      );
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
    if (this.shouldRecordOperations) await state.operations.append(operation);
  }
}
