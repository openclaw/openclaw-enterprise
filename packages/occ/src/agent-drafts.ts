import {
  describePluginBindings,
  selectedPluginBindings,
  pluginSourceIds,
  validatePluginRequestAuthority,
  type SelectedPluginBinding,
} from "./plugin-credential-bindings.ts";
import type { IAMPolicyOperations } from "./iam-policy-operations.ts";
import {
  storedSecretBindings,
  rejectCrossNamespaceSecretSources,
} from "./configuration-operations.ts";
import { isManagedTokenServiceSource } from "./credential-source-metadata.ts";
import {
  isName,
  normalizeInitialWorkspaceFiles,
  normalizeWorkspaceDefaultsId,
  type Agent,
  type AgentCredentialSourceBinding,
  type BackendRef,
  type Configuration,
  type ConfigurationDriver,
  type StoredCredentialSource,
  type HarnessAuthBinding,
  type HarnessExecutionMode,
  type InitialWorkspaceFiles,
  type Namespace,
  type OpenClawConfigurationDocument,
  type PluginApprovers,
  type PluginDesiredState,
  type PluginDriver,
  type RepositoryAccess,
  type RepositoryBindingRequest,
  type ResourceRef,
  type SecretBindings,
  type ComputeDriver,
} from "@openclaw-enterprise/contracts";
import { isNonEmptyString } from "@openclaw-enterprise/utils";
import {
  assertHarnessSourceListed,
  parseAgentCredentialSources,
  type AgentCredentialAccess,
} from "./agent-credential-access.ts";
import {
  GATEWAY_MANAGED_MODE_UNSUPPORTED,
  type HarnessResolver,
  type createSavedAgentTopologyValidator,
} from "./agent-harness-topology.ts";
import {
  normalizeAgentPlugins,
  normalizeAgentPluginApprovers,
  pluginOwner,
  validatePluginCredentialSources,
  type createAgentPluginValidation,
} from "./agent-plugin-validation.ts";
import { freezeConfigurationValues } from "./configuration-settings.ts";
import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import { normalizeGatewayManagedMode, validExecutionMode } from "./agent-provisioning.ts";
import {
  AGENT_NAME_CONFLICT,
  AgentDeletingError,
  ConfigurationGenerationConflictError,
  QualifiedAuthorizationDeniedError,
  ResourceStateConflictError,
  ScopeViolationError,
  ConfigurationHarnessError,
} from "./errors.ts";
import {
  harnessAuthBinding,
  plannedHarnessAuth,
  type PlannedSecretHarnessAuth,
  type createHarnessAuthOperations,
} from "./harness-auth.ts";
import type { PlatformReadView } from "./ports/platform-read-view.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";
import type {
  RepositoryStandingApprovalChange,
  createRepositoryPolicyOperations,
} from "./repository-policy.ts";
import { exactNamespace, lockNamespace, namespaceIdentity } from "./resource-scope.ts";
import { normalizeRequestSecretBindings } from "./agent-provisioning.ts";

type ConfigurationRecord = NonNullable<
  Awaited<ReturnType<PlatformReadView["configurations"]["findConfiguration"]>>
>;

export interface AgentConfigurationPreparation {
  readonly expectedGeneration: number;
  readonly prepare: (
    agent: Pick<Agent, "id" | "namespaceId">,
    values: Readonly<OpenClawConfigurationDocument>,
  ) => Readonly<OpenClawConfigurationDocument>;
}

interface AgentDraftDependencies {
  readonly authority: Pick<ControllerAuthority, "authorize" | "holdAuthority">;
  readonly transactions: Pick<ControllerTransactions, "read" | "transact">;
  readonly harnessAuth: Pick<
    ReturnType<typeof createHarnessAuthOperations>,
    | "authorizeBoundHarnessAuth"
    | "authorizeHarnessAuthSource"
    | "savedHarnessAuthSnapshot"
    | "plannedHarnessAuthSnapshot"
  >;
  readonly repositoryPolicy: Pick<
    ReturnType<typeof createRepositoryPolicyOperations>,
    "repositorySettings" | "reconcileAgentBindings"
  >;
  readonly validateSavedAgentTopology: ReturnType<typeof createSavedAgentTopologyValidator>;
  readonly pluginDrivers: () => readonly PluginDriver[];
  readonly validateAgentPlugins: ReturnType<
    typeof createAgentPluginValidation
  >["validateAgentPlugins"];
  readonly guardAgentProvisioning: (
    state: PlatformUnitOfWork,
    namespaceId: string,
    agentId: string,
  ) => Promise<void>;
  readonly guardProvisioningConfiguration: (
    state: PlatformReadView,
    namespaceId: string,
    id: string,
  ) => Promise<void>;
  readonly backendId: (value: BackendRef | undefined, preserve?: BackendRef) => BackendRef;
  readonly credentialAccess: Pick<
    AgentCredentialAccess,
    | "authorizeBoundCredentialSources"
    | "authorizeAgentCredentialSources"
    | "authorizePluginCredentialSources"
    | "grantSelectedPluginSources"
  >;
  readonly authorizeBindings: (
    state: PlatformUnitOfWork,
    principalId: string,
    namespaceId: string,
    bindings: SecretBindings,
  ) => Promise<unknown>;
  readonly configurationDriver: () => ConfigurationDriver;
  readonly validateConfigurationContent: (
    values: OpenClawConfigurationDocument,
    bindings: SecretBindings | undefined,
  ) => void;
  readonly savedConfigurationReader: (
    record: ConfigurationRecord,
  ) => () => Promise<Readonly<Configuration>>;
  readonly updatePreparedConfiguration: (
    principalId: string,
    input: {
      namespaceId: string;
      configurationId: string;
      expectedGeneration: number;
      values: Readonly<OpenClawConfigurationDocument>;
    },
  ) => Promise<Readonly<Configuration>>;
  readonly installationId: string;
  readonly selectedCompute: () => ComputeDriver | undefined;
  readonly refuseRepositoryNetworkOverlap: (
    principalId: string,
    policy: Awaited<ReturnType<PlatformReadView["sandboxPolicies"]["find"]>>,
  ) => Promise<void>;
  readonly bindCreator: IAMPolicyOperations["bindCreator"];
  readonly nextAgentId: () => string;
  readonly timestamp: () => string;
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

export interface UpdateAgentInput {
  readonly repositoryStandingApproval?: RepositoryStandingApprovalChange;
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

export async function refuseTakenAgentName(
  state: Pick<PlatformReadView, "agents">,
  namespaceId: string,
  name: string,
): Promise<void> {
  if (await state.agents.hasAgentNamed(namespaceId, name)) {
    throw new ResourceStateConflictError(AGENT_NAME_CONFLICT);
  }
}

function requireNamespaceAcceptsAgents(namespace: Pick<Namespace, "status">): void {
  if (namespace.status !== "provisioning" && namespace.status !== "ready") {
    throw new ResourceStateConflictError("The Namespace does not accept new Agents.");
  }
}

export function createAgentDraftOperations(dependencies: AgentDraftDependencies) {
  async function validatePluginSelection(
    state: PlatformReadView,
    principalId: string,
    namespaceId: string,
    driver: PluginDriver | undefined,
    plugins: PluginDesiredState | undefined,
    harnessAuth: HarnessAuthBinding | null | undefined,
    resolveSource: (sourceId: string) => Promise<Readonly<StoredCredentialSource> | undefined>,
    resolved: readonly StoredCredentialSource[] = [],
  ): Promise<readonly SelectedPluginBinding[]> {
    const selected = selectedPluginBindings(driver, plugins);
    const plugin = await dependencies.credentialAccess.authorizePluginCredentialSources(
      state,
      principalId,
      namespaceId,
      selected,
      resolveSource,
      resolved,
    );
    await validatePluginCredentialSources(driver, plugins, plugin.sources, harnessAuth);
    if (selected.length > 0) {
      const descriptions = await describePluginBindings(driver, plugins, selected, plugin.sources);
      validatePluginRequestAuthority(descriptions, plugin.templates);
    }
    return selected;
  }

  async function readAgentConfiguration(
    state: PlatformReadView,
    principalId: string,
    namespaceId: string,
    configurationId: string,
  ): Promise<ConfigurationRecord> {
    await dependencies.authority.authorize(principalId, "read", {
      kind: "configuration",
      id: configurationId,
      namespaceId,
    });
    const configuration = await state.configurations.findConfiguration(
      namespaceId,
      configurationId,
    );
    if (!configuration || configuration.kind !== "agent") {
      throw new ScopeViolationError(
        "The Agent Configuration must belong to the exact Namespace and configure an Agent.",
      );
    }
    return configuration;
  }

  async function prepareBrowserConfiguration(
    state: PlatformUnitOfWork,
    principalId: string,
    namespaceId: string,
    agentId: string,
    configuration: ConfigurationRecord,
    preparation: AgentConfigurationPreparation,
  ): Promise<ConfigurationRecord> {
    await dependencies.authority.authorize(principalId, "update", {
      kind: "configuration",
      id: configuration.id,
      namespaceId: namespaceId,
    });
    if (configuration.generation !== preparation.expectedGeneration) {
      throw new ConfigurationGenerationConflictError();
    }
    // The Namespace lock serializes Agent creation and Configuration replacement. A
    // caller must not change another Agent's shared Configuration as a create side effect.
    const existingAgents = await state.agents.listAgents(namespaceId);
    if (existingAgents.some((agent) => agent.configurationId === configuration.id)) {
      throw new ResourceStateConflictError(
        "Browser access setup requires a Configuration that no Agent references.",
      );
    }
    const previous = await dependencies.savedConfigurationReader(configuration)();
    const prepared = await dependencies.updatePreparedConfiguration(principalId, {
      namespaceId: namespaceId,
      configurationId: configuration.id,
      expectedGeneration: preparation.expectedGeneration,
      values: preparation.prepare({ id: agentId, namespaceId: namespaceId }, previous.values),
    });
    return { ...configuration, generation: prepared.generation };
  }

  /**
   * A new Agent's managed mode defaults to whether the selected Compute Driver enforces it, so
   * an Agent on SSH Compute (or a Driver that does not declare support) is saved deployable
   * instead of failing at its first deploy (finding 2676). The default needs no Installation
   * administer: there is no enforcement to opt out of. Without a selected Compute it is on.
   */
  function gatewayManagedModeSupported(): boolean {
    const compute = dependencies.selectedCompute();
    return compute === undefined || compute.supportsGatewayManagedMode === true;
  }

  // Agent save refuses a managed mode the selected Compute Driver cannot apply, with deploy's
  // message, so it fails at save rather than at the next deploy (finding 2676).
  function requireGatewayManagedModeSupport(gatewayManagedMode: boolean): void {
    if (gatewayManagedMode && !gatewayManagedModeSupported()) {
      throw new ConfigurationHarnessError(GATEWAY_MANAGED_MODE_UNSUPPORTED);
    }
  }

  async function authorizeGatewayManagedModeChange(
    principalId: string,
    required: boolean,
  ): Promise<void> {
    if (required) {
      // The denial names gatewayManagedMode: the rest of the request needs no Installation grant
      // (finding 2691).
      await dependencies.authority
        .authorize(principalId, "administer", {
          kind: "installation",
          id: dependencies.installationId,
        })
        .catch((error: unknown) => {
          throw QualifiedAuthorizationDeniedError.qualify(error, "gateway_managed_mode");
        });
    }
  }

  async function createAgent(
    principalId: string,
    input: CreateAgentInput,
    resolveHarness?: HarnessResolver,
    configurationPreparation?: AgentConfigurationPreparation,
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
    const credentialSources = parseAgentCredentialSources(input.credentialSources);
    const executionMode = input.executionMode ?? "embedded";
    if (!validExecutionMode(executionMode)) {
      throw new ScopeViolationError("The Agent Harness execution mode is invalid.");
    }
    const gatewayManagedMode = normalizeGatewayManagedMode(
      input.gatewayManagedMode,
      gatewayManagedModeSupported(),
    );
    const plugins = normalizeAgentPlugins(input.plugins);
    const pluginApprovers = normalizeAgentPluginApprovers(input.pluginApprovers);
    namespaceIdentity(input.namespaceId);
    return dependencies.transactions.transact(async (state) => {
      await dependencies.authority.holdAuthority(state);
      const target: ResourceRef = {
        kind: "agent",
        id: input.namespaceId,
        namespaceId: input.namespaceId,
      };
      await dependencies.authority.authorize(principalId, "create", target);
      await authorizeGatewayManagedModeChange(principalId, input.gatewayManagedMode === false);
      requireGatewayManagedModeSupport(gatewayManagedMode);
      const namespace = await lockNamespace(state, input.namespaceId);
      // AccessBinding deletes hold this lock: authorize again so a revocation that committed
      // while this write waited stops it before it leaves a durable Owner binding or grant.
      await dependencies.authority.authorize(principalId, "create", target);
      const backendId = dependencies.backendId(input.backendId);
      // Checked after authorization: the conflict names the Namespace state.
      requireNamespaceAcceptsAgents(namespace);
      const existingConfiguration = await readAgentConfiguration(
        state,
        principalId,
        namespace.id,
        input.configurationId,
      );
      await dependencies.guardProvisioningConfiguration(
        state,
        namespace.id,
        existingConfiguration.id,
      );
      rejectCrossNamespaceSecretSources(namespace.id, undefined, harnessAuth);
      await dependencies.harnessAuth.authorizeHarnessAuthSource(
        state,
        principalId,
        namespace.id,
        harnessAuth,
      );
      const sources = await dependencies.credentialAccess.authorizeAgentCredentialSources(
        state,
        principalId,
        namespace.id,
        credentialSources ?? [],
        harnessAuth,
      );
      const agentId = dependencies.nextAgentId();
      await dependencies.authorizeBindings(
        state,
        principalId,
        namespace.id,
        storedSecretBindings(existingConfiguration.secretBindings),
      );
      const configuration =
        configurationPreparation === undefined
          ? existingConfiguration
          : await prepareBrowserConfiguration(
              state,
              principalId,
              namespace.id,
              agentId,
              existingConfiguration,
              configurationPreparation,
            );
      const savedConfiguration = dependencies.savedConfigurationReader(configuration);
      const driver = await dependencies.validateAgentPlugins(
        plugins,
        pluginApprovers,
        async () => (await savedConfiguration()).values,
      );
      const selected = await validatePluginSelection(
        state,
        principalId,
        namespace.id,
        driver,
        plugins,
        harnessAuth,
        (sourceId) => state.credentialSources.lockCredentialSource(namespace.id, sourceId),
        sources,
      );
      const { repositoryBindings, repositoryAccess } =
        dependencies.repositoryPolicy.repositorySettings(namespace.id, input);
      await dependencies.validateSavedAgentTopology(
        resolveHarness,
        {
          executionMode,
          harnessAuth: () =>
            dependencies.harnessAuth.savedHarnessAuthSnapshot(state, namespace.id, harnessAuth),
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
        configurationId: configuration.id,
        backendId,
        harnessAuth,
        ...(credentialSources === undefined || credentialSources.length === 0
          ? {}
          : { credentialSources }),
        executionMode,
        gatewayManagedMode,
        ...(plugins === undefined ? {} : { plugins }),
        ...(driver && plugins && Object.keys(plugins).length
          ? { pluginDriver: pluginOwner(driver) }
          : {}),
        ...(pluginApprovers === undefined ? {} : { pluginApprovers }),
        ...(repositoryBindings === undefined ? {} : { repositoryBindings }),
        ...(repositoryAccess === undefined ? {} : { repositoryAccess }),
        servicePrincipalId: `service-agent-${agentId}`,
        desiredRuntimeState: "stopped",
        status: "active",
        createdAt: dependencies.timestamp(),
      });
      await dependencies.credentialAccess.grantSelectedPluginSources(
        state,
        principalId,
        agent,
        pluginSourceIds(selected),
      );
      await dependencies.bindCreator(state, principalId, {
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

  async function validateAgentCreate(
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
    namespaceIdentity(input.namespaceId);
    await dependencies.authority.authorize(principalId, "create", {
      kind: "agent",
      id: input.namespaceId,
      namespaceId: input.namespaceId,
    });
    await authorizeGatewayManagedModeChange(
      principalId,
      normalizeGatewayManagedMode(input.gatewayManagedMode, true) === false,
    );
    requireGatewayManagedModeSupport(
      normalizeGatewayManagedMode(input.gatewayManagedMode, gatewayManagedModeSupported()),
    );
    await dependencies.transactions.read(async (state) => {
      const namespace = await exactNamespace(state, input.namespaceId);
      requireNamespaceAcceptsAgents(namespace);
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
      const configurationDriver = dependencies.configurationDriver();
      // Use one unsaved Configuration for Driver admission and Agent topology checks.
      const configuration: Configuration = Object.freeze({
        id: "cfg_00000000-0000-4000-8000-000000000000",
        namespaceId: namespace.id,
        kind: "agent",
        generation: 1,
        values,
        createdAt: dependencies.timestamp(),
      });
      await configurationDriver.validateSize?.(values);
      dependencies.validateConfigurationContent(values, secretBindings);
      await configurationDriver.validate(configuration);
      const driver = await dependencies.validateAgentPlugins(
        plugins,
        pluginApprovers,
        () => values,
      );
      rejectCrossNamespaceSecretSources(
        namespace.id,
        undefined,
        harnessAuth === null || "source" in harnessAuth ? harnessAuth : null,
      );
      await validatePluginSelection(
        state,
        principalId,
        namespace.id,
        driver,
        plugins,
        harnessAuth?.method === "credential_source" ? harnessAuth : null,
        (sourceId) => state.credentialSources.findCredentialSource(namespace.id, sourceId),
      );
      await dependencies.validateSavedAgentTopology(
        resolveHarness,
        {
          executionMode,
          harnessAuth: async () =>
            dependencies.harnessAuth.plannedHarnessAuthSnapshot(namespace.id, harnessAuth),
          repositoryBindings: undefined,
          workspaceSetup: initialWorkspaceFiles !== undefined,
          plugins,
          pluginDriver: driver,
        },
        async () => configuration,
      );
      // After `agent:create` in this Namespace, as create's 409 reveals the name (errors.ts).
      if (input.name !== undefined) {
        await refuseTakenAgentName(state, namespace.id, input.name);
      }
    });
  }

  async function updateAgent(
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
    const requestedSources = parseAgentCredentialSources(input.credentialSources);
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
    namespaceIdentity(input.namespaceId);
    return dependencies.transactions.transact(async (state) => {
      if (input.repositoryStandingApproval !== undefined) {
        await dependencies.authority.holdAuthority(state);
      }
      const target = { kind: "agent", id: input.agentId, namespaceId: input.namespaceId } as const;
      await dependencies.authority.authorize(principalId, "update", target);
      const namespace = await lockNamespace(state, input.namespaceId);
      // Namespace IAM writes share this lock. Use the policy after any writer ahead of us.
      await dependencies.authority.authorize(principalId, "update", target);
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
        await authorizeGatewayManagedModeChange(
          principalId,
          gatewayManagedMode !== agent.gatewayManagedMode,
        );
        requireGatewayManagedModeSupport(gatewayManagedMode);
      }
      const configuration = await readAgentConfiguration(
        state,
        principalId,
        namespace.id,
        configurationId,
      );
      await dependencies.guardAgentProvisioning(state, namespace.id, agent.id);
      await dependencies.guardProvisioningConfiguration(state, namespace.id, configurationId);
      const previousAuth = harnessAuthBinding(agent.harnessAuth);
      // Every update needs the caller's grant on each source the Agent binds now, but not a
      // usable record: after a Secret Driver or Credential Gateway change, an update must still
      // be able to replace or drop what the new driver does not own. Only what the update
      // binds is looked up, and deploy admission rechecks every bound source.
      // A denial here says it is for the current Harness authentication, which an update that
      // replaces it also needs (finding D763).
      await dependencies.harnessAuth
        .authorizeBoundHarnessAuth(principalId, namespace.id, previousAuth)
        .catch((error: unknown) => {
          throw QualifiedAuthorizationDeniedError.qualify(error, "current_harness_auth");
        });
      await dependencies.credentialAccess.authorizeBoundCredentialSources(
        principalId,
        namespace.id,
        agent.credentialSources ?? [],
      );
      if (requestedAuth !== undefined) {
        rejectCrossNamespaceSecretSources(namespace.id, undefined, requestedAuth);
        await dependencies.harnessAuth.authorizeHarnessAuthSource(
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
          : await dependencies.credentialAccess.authorizeAgentCredentialSources(
              state,
              principalId,
              namespace.id,
              requestedSources,
              auth,
            );
      if (requestedSources === undefined && requestedAuth !== undefined) {
        const retained = agent.credentialSources ?? [];
        assertHarnessSourceListed(retained, requestedAuth);
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
      const secretBindings = storedSecretBindings(configuration.secretBindings);
      await dependencies.authorizeBindings(state, principalId, namespace.id, secretBindings);
      const savedConfiguration = dependencies.savedConfigurationReader(configuration);
      const selections = plugins ?? agent.plugins;
      const driver = await dependencies.validateAgentPlugins(
        selections,
        pluginApprovers === null ? undefined : (pluginApprovers ?? agent.pluginApprovers),
        async () => (await savedConfiguration()).values,
        agent,
        plugins === undefined ? "stored" : "request",
      );
      let selectedPluginIds: readonly string[] = [];
      if (plugins !== undefined && agent.plugins && Object.keys(agent.plugins).length > 0) {
        const previousDriver = dependencies
          .pluginDrivers()
          .find(
            ({ id, implementation }) =>
              id === agent.pluginDriver?.id && implementation === agent.pluginDriver.implementation,
          );
        if (!previousDriver) {
          throw new ConfigurationHarnessError("The Agent's saved Plugin Driver is unavailable.");
        }
        const previous = selectedPluginBindings(previousDriver, agent.plugins);
        await dependencies.credentialAccess.authorizeBoundCredentialSources(
          principalId,
          namespace.id,
          pluginSourceIds(previous).map((sourceId) => ({ sourceId })),
        );
      }
      if (plugins !== undefined || sources !== undefined) {
        if (sources === undefined) {
          sources = await dependencies.credentialAccess.authorizeAgentCredentialSources(
            state,
            principalId,
            namespace.id,
            agent.credentialSources ?? [],
            auth,
          );
        }
        const selected = await validatePluginSelection(
          state,
          principalId,
          namespace.id,
          driver,
          selections,
          auth,
          (sourceId) => state.credentialSources.lockCredentialSource(namespace.id, sourceId),
          sources,
        );
        selectedPluginIds = pluginSourceIds(selected);
      }
      const backendId = dependencies.backendId(input.backendId, agent.backendId);
      const repositoryChange =
        input.repositoryBindings !== undefined || input.repositoryAccess !== undefined;
      const settings = repositoryChange
        ? dependencies.repositoryPolicy.repositorySettings(namespace.id, input)
        : undefined;
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
      await dependencies.validateSavedAgentTopology(
        resolveHarness,
        {
          executionMode: input.executionMode ?? agent.executionMode,
          harnessAuth: () =>
            dependencies.harnessAuth.savedHarnessAuthSnapshot(
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
        await dependencies.refuseRepositoryNetworkOverlap(
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
            ? pluginOwner(driver, agent)
            : null,
      );
      if (!updated) {
        throw new ResourceStateConflictError("The Agent Configuration changed during its update.");
      }
      if (plugins !== undefined) {
        await dependencies.credentialAccess.grantSelectedPluginSources(
          state,
          principalId,
          updated,
          selectedPluginIds,
        );
      }
      await dependencies.repositoryPolicy.reconcileAgentBindings(
        state,
        principalId,
        agent,
        updated,
        repositoryBindings !== undefined,
        input.repositoryStandingApproval,
      );
      return updated;
    });
  }

  return { createAgent, validateAgentCreate, updateAgent };
}
