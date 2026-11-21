import { isDeepStrictEqual } from "node:util";
import {
  assertExecutionAdmission,
  assertExecutionReleaseAllowed,
  inferenceKeyDestination,
  isSourceProviderPresetId,
  SOURCE_PROVIDER_PRESET_CONFIG_KEY,
  validateDeploymentPolicy,
  type Agent,
  type AgentRevision,
  type AuditEvent,
  type BackendRef,
  type ComputeDriver,
  type Configuration,
  type ConfigurationDriver,
  type CredentialInjectionCapabilities,
  type CredentialProxyDriver,
  type CredentialSource,
  type DeploymentCredentialBinding,
  type DeploymentPolicy,
  type DeploymentRequestMatch,
  type ExecutionAdmission,
  type FirstDeploymentReceipt,
  type HarnessExecutionMode,
  type HarnessAuthSnapshot,
  type LoggingLevel,
  type Namespace,
  type ModelProviderSettings,
  type NetworkPolicyCapabilities,
  type OpenClawConfigurationDocument,
  type PluginDriver,
  type PluginRevisionState,
  type ResourceKind,
  type ResourceRef,
  type RevisionHarnessDescriptor,
  type SandboxDriver,
  type SandboxNetworkGrant,
  type StaticKeyTemplateValues,
  type SecretDriver,
} from "@openclaw-enterprise/contracts";
import { asRecord, immutableCopy, isNonEmptyString } from "@openclaw-enterprise/utils";
import { validExecutionMode } from "./agent-provisioning.ts";
import {
  authorizeFirstDeploymentReceipt,
  type AuthorizedAgentDeployment,
  type FirstDeploymentIntent,
  type NormalizedDeploymentInput,
} from "./deployment-authorization.ts";
import {
  agentRuntimeConfiguration,
  GATEWAY_MANAGED_MODE_UNSUPPORTED,
  requireDedicatedNativeSupport,
  requireSandboxExecutionMode,
  resolveAgentHarness,
  validateAgentHarnessAuth,
  validateWorkspaceSetupTopology,
  type HarnessResolver,
} from "./agent-harness-topology.ts";
import {
  pluginOwner,
  validatePluginSettings,
  type createAgentPluginValidation,
} from "./agent-plugin-validation.ts";
import {
  freezeConfigurationValues,
  refuseUndeployableConfigurationValues,
} from "./configuration-settings.ts";
import { resolveConfiguredHarnessId, type ModelPolicyAgent } from "./configured-harness.ts";
import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import type { ControllerWorkRecorder } from "./controller-work-recorder.ts";
import type { AgentCredentialAccess } from "./agent-credential-access.ts";
import {
  runtimeCredentialOperation,
  runtimeCredentialStatus,
} from "./agent-runtime-credentials.ts";
import type { createProvisioningWorker } from "./agent-provisioning-worker.ts";
import {
  exactConfiguration,
  storedSecretBindings,
  type createConfigurationOperations,
} from "./configuration-operations.ts";
import type { createCredentialEgressAdmission } from "./credential-egress-admission.ts";
import { credentialSourceRef, isManagedTokenServiceSource } from "./credential-source-metadata.ts";
import { secretOperation } from "./secret-operations.ts";
import type {
  createDeploymentChannelChecks,
  PreparedDeploymentChannels,
} from "./deployment-channels.ts";
import { executionAdmissionFor, prepareComputeRevision } from "./deployment-revision.ts";
import {
  AgentDeletingError,
  ComputeGatewaySettingError,
  ConfigurationHarnessError,
  DependencyUnavailableError,
  NamespaceNotReadyError,
  ResourceStateConflictError,
  ScopeViolationError,
} from "./errors.ts";
import type { createHarnessAuthOperations } from "./harness-auth.ts";
import type { InstalledDriver } from "./installed-driver.ts";
import type { NativeWorkerSupportSource } from "./native-worker-support.ts";
import { withAgentIdentityName } from "./openclaw-roster.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";
import type { createRepositoryPolicyOperations } from "./repository-policy.ts";
import { lockNamespace, namespaceIdentity } from "./resource-scope.ts";
import type { createSandboxPolicyOperations } from "./sandbox-policy.ts";

export interface FirstDeploymentGuard {
  readonly digest: string;
  readonly intent: FirstDeploymentIntent;
  readonly preparation:
    { readonly prepared: PreparedDeploymentChannels } | { readonly error: unknown };
}

/** A composition-owned, reviewed static credential profile for an explicitly selected model. */
export interface ModelCredentialPreset {
  readonly providerId: string;
  readonly provider: Pick<ModelProviderSettings, "baseUrl" | "protocol">;
  readonly template: StaticKeyTemplateValues;
  readonly projection: Extract<
    DeploymentCredentialBinding,
    { readonly consumer: { readonly kind: "model" } }
  >["projection"];
}

/** Only the selected enforcing implementations can attest to their process and policy support. */
export interface CredentialDeploymentCapabilities {
  readonly binary: string;
  readonly sandbox: NetworkPolicyCapabilities;
  readonly proxy: CredentialInjectionCapabilities;
}

interface PreparedModelCredentialDeployment {
  readonly source: Readonly<
    CredentialSource & { ownerCapability: "token_service"; tokenServiceInstanceId: string }
  >;
  readonly preset: ModelCredentialPreset;
  readonly capabilities: CredentialDeploymentCapabilities;
  readonly owner: InstalledDriver;
  readonly proxy: CredentialProxyDriver;
}

export interface DeploymentAdmissionDependencies {
  readonly transactions: Pick<ControllerTransactions, "transact">;
  readonly authority: Pick<
    ControllerAuthority,
    "authorize" | "authorizeAgentPrincipal" | "holdAuthority"
  >;
  readonly channels: Pick<
    ReturnType<typeof createDeploymentChannelChecks>,
    "validateDeploymentChannels" | "assertPreparedDeploymentDrivers"
  >;
  readonly harnessAuth: Pick<
    ReturnType<typeof createHarnessAuthOperations>,
    "assertCredentialGatewayDelivery" | "admitHarnessAuth" | "requireCredentialSourceDrivers"
  >;
  readonly repositoryPolicy: Pick<
    ReturnType<typeof createRepositoryPolicyOperations>,
    "admitRepositoryCredentials" | "applyRepositoryStandingApproval"
  >;
  readonly sandboxPolicy: Pick<
    ReturnType<typeof createSandboxPolicyOperations>,
    "admitDeploymentSnapshot"
  >;
  readonly plugins: Pick<ReturnType<typeof createAgentPluginValidation>, "validatePluginPlacement">;
  readonly enabledPluginDrivers: () => readonly PluginDriver[];
  readonly pluginDriver: (harnessId: string, byConfiguration: boolean) => PluginDriver;
  readonly selectedCompute: () => ComputeDriver;
  readonly sandboxDriver: () => SandboxDriver | undefined;
  readonly nativeWorkers: NativeWorkerSupportSource | undefined;
  readonly loggingLevel: LoggingLevel;
  readonly provisioningWorker: Pick<
    ReturnType<typeof createProvisioningWorker>,
    "guardAgentProvisioning"
  >;
  readonly backendId: (requested: BackendRef | undefined) => BackendRef;
  readonly configurationDriver: () => ConfigurationDriver;
  readonly configuration: Pick<
    ReturnType<typeof createConfigurationOperations>,
    "authorizeBindings"
  >;
  readonly driverOperation: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly modelPolicyAgent: (
    mode: HarnessExecutionMode,
    resolveHarness: HarnessResolver,
  ) => ModelPolicyAgent;
  readonly credentialAccess: Pick<
    AgentCredentialAccess,
    "grantDeployedAgentSources" | "admitCredentialSources"
  >;
  readonly secretDriver: () => SecretDriver;
  readonly validateComputeConfiguration: (values: Readonly<OpenClawConfigurationDocument>) => void;
  readonly validateRepositoryBrokerNetworkProxy: (
    harness: Readonly<Pick<RevisionHarnessDescriptor, "id" | "mode">>,
    configuration: Readonly<OpenClawConfigurationDocument>,
    sandbox: SandboxDriver | undefined,
  ) => void;
  readonly timestamp: () => string;
  readonly nextIdentifier: (kind: ResourceKind) => string;
  readonly egress: Pick<ReturnType<typeof createCredentialEgressAdmission>, "admitProxyPlan">;
  readonly selectedProxyOwner: () => InstalledDriver;
  readonly selectedCredentialDeliveryOwner: () => InstalledDriver;
  readonly ownedTokenServiceDriver: (instanceId: string) => unknown;
  readonly sandboxNetworkPolicyCeiling: readonly SandboxNetworkGrant[];
  readonly modelCredentialPreset:
    | ((input: {
        readonly presetId: string;
        readonly configuration: Readonly<Record<string, unknown>>;
        readonly harness: RevisionHarnessDescriptor;
      }) => ModelCredentialPreset | undefined)
    | undefined;
  readonly credentialDeploymentCapabilities:
    | ((input: {
        readonly sandbox: SandboxDriver;
        readonly proxy: CredentialProxyDriver;
      }) => CredentialDeploymentCapabilities | undefined)
    | undefined;
  readonly workRecorder: Pick<ControllerWorkRecorder, "record">;
}

export function createAgentDeploymentAdmission(dependencies: DeploymentAdmissionDependencies) {
  async function prepareModelCredentialDeployment(
    state: PlatformUnitOfWork,
    agent: Readonly<Agent>,
    auth: HarnessAuthSnapshot,
    harness: RevisionHarnessDescriptor,
    configuration: OpenClawConfigurationDocument,
    sandbox: SandboxDriver | undefined,
  ): Promise<PreparedModelCredentialDeployment | undefined> {
    if (auth.method !== "credential_source" || auth.tokenServiceInstanceId === undefined) {
      return undefined;
    }
    const source = await state.credentialSources.lockCredentialSource(
      agent.namespaceId,
      auth.sourceId,
    );
    if (
      !isManagedTokenServiceSource(source) ||
      source.state !== "ready" ||
      source.tokenServiceInstanceId !== auth.tokenServiceInstanceId ||
      source.type !== auth.sourceType
    ) {
      throw new ScopeViolationError("The Harness credential source is unavailable.");
    }
    const presetId = source.config[SOURCE_PROVIDER_PRESET_CONFIG_KEY];
    if (!isSourceProviderPresetId(presetId)) {
      throw new ResourceStateConflictError(
        "The Harness credential source has no permitted model provider preset.",
      );
    }
    let preset: ModelCredentialPreset | undefined;
    try {
      preset = dependencies.modelCredentialPreset?.({ presetId, configuration, harness });
    } catch {
      preset = undefined;
    }
    if (preset === undefined) {
      throw new ResourceStateConflictError(
        "The selected model has no matching approved source preset and explicit inference route.",
      );
    }
    if (sandbox === undefined || dependencies.credentialDeploymentCapabilities === undefined) {
      throw new ResourceStateConflictError(
        "The selected Sandbox and Credential Proxy have no qualified staged credential enforcement.",
      );
    }
    let owner: InstalledDriver | undefined;
    let proxy: CredentialProxyDriver | undefined;
    let capabilities: CredentialDeploymentCapabilities | undefined;
    try {
      owner = dependencies.selectedCredentialDeliveryOwner();
      proxy = owner.require("credential_proxy_delivery");
      if (owner.require("sandbox") === sandbox) {
        capabilities = dependencies.credentialDeploymentCapabilities({ sandbox, proxy });
      }
    } catch {
      capabilities = undefined;
    }
    if (
      owner === undefined ||
      proxy === undefined ||
      capabilities === undefined ||
      !capabilities.binary.startsWith("/")
    ) {
      throw new ResourceStateConflictError(
        "The selected Sandbox and Credential Proxy have no qualified staged credential enforcement.",
      );
    }
    return { source, preset, capabilities, owner, proxy };
  }

  function admitModelCredentialPolicy(
    { source, preset, capabilities, owner, proxy }: PreparedModelCredentialDeployment,
    networkGrants: readonly SandboxNetworkGrant[],
  ): NonNullable<AgentRevision["credentialDeployment"]> {
    const destination = inferenceKeyDestination(preset.provider.baseUrl, preset.provider.protocol);
    const request: DeploymentRequestMatch = {
      binary: capabilities.binary,
      host: destination.host,
      ports: [{ from: destination.port, to: destination.port }],
      requestPolicy: { type: "http", method: destination.method, path: destination.path },
    };
    const binding: DeploymentCredentialBinding = {
      bindingRef: "model",
      sourceRef: credentialSourceRef(source),
      consumer: { kind: "model", providerId: preset.providerId },
      projection: preset.projection,
    };
    const deployment: DeploymentPolicy = {
      networkAccessPolicy: {
        allowed: networkGrants.map(({ binary, host, ports }) => ({ binary, host, ports })),
      },
      bindings: [binding],
      injectionPolicies: [{ bindingRef: binding.bindingRef, allowedRequests: [request] }],
    };
    const details = validateDeploymentPolicy(deployment, {
      ceiling: dependencies.sandboxNetworkPolicyCeiling,
      sandbox: capabilities.sandbox,
      proxy: capabilities.proxy,
      targetMayHoldPlaceholders: true,
      authorityForBinding: (identity) =>
        identity.bindingRef === binding.bindingRef &&
        isDeepStrictEqual(identity.sourceRef, binding.sourceRef) &&
        isDeepStrictEqual(identity.consumer, binding.consumer)
          ? {
              destinations: preset.template.destinations,
              allowedRequests: [request],
              projection: preset.projection,
            }
          : undefined,
    });
    if (details.length) {
      throw new ResourceStateConflictError(
        "The staged model credential and network policy cannot be enforced.",
        details,
      );
    }
    return immutableCopy({ ...deployment, driver: owner.ref, proxyDriverId: proxy.id });
  }

  async function admitConfiguration(
    state: PlatformUnitOfWork,
    principalId: string,
    agent: Readonly<Agent>,
    prepared: PreparedDeploymentChannels | undefined,
    guarded: boolean,
  ) {
    await dependencies.authority.authorize(principalId, "read", {
      kind: "configuration",
      id: agent.configurationId,
      namespaceId: agent.namespaceId,
    });
    const metadata = await state.configurations.lockConfiguration(
      agent.namespaceId,
      agent.configurationId,
    );
    if (!metadata || metadata.kind !== "agent") {
      throw new ScopeViolationError(
        "The Agent Configuration must belong to the exact Namespace and configure an Agent.",
      );
    }
    if (prepared !== undefined && metadata.generation !== prepared.configuration.generation) {
      throw new ResourceStateConflictError(
        !guarded
          ? "The Configuration changed after credential validation. Review the current Configuration before deploying."
          : "The expected Configuration generation is unavailable. Recover the original first-deployment receipt after an uncertain result, then review the current Configuration before deploying.",
      );
    }
    const configurationDriver = dependencies.configurationDriver();
    const configuration = exactConfiguration(
      await dependencies.driverOperation(() =>
        configurationDriver.read({ id: metadata.id, namespaceId: agent.namespaceId }),
      ),
      metadata,
    );
    if (prepared !== undefined && !isDeepStrictEqual(configuration, prepared.configuration)) {
      throw new ResourceStateConflictError(
        !guarded
          ? "The Configuration changed after credential validation. Review the current Configuration before deploying."
          : "The Configuration changed after credential validation. Recover the original first-deployment receipt after an uncertain result, then review the current Configuration before deploying.",
      );
    }
    return { metadata, configuration, configurationDriver };
  }

  async function admitConfigurationSecrets(
    state: PlatformUnitOfWork,
    principalId: string,
    agent: Readonly<Agent>,
    metadataBindings: Configuration["secretBindings"],
  ) {
    const secretBindings = storedSecretBindings(metadataBindings);
    const sources = await dependencies.configuration.authorizeBindings(
      state,
      principalId,
      agent.namespaceId,
      secretBindings,
    );
    const secretDriver =
      Object.keys(secretBindings).length === 0 ? undefined : dependencies.secretDriver();
    for (const secret of sources) {
      await dependencies.authority.authorizeAgentPrincipal(principalId, agent, "operate", {
        kind: "secret",
        id: secret.id,
        namespaceId: agent.namespaceId,
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
    return { secretBindings, secretDriver };
  }

  async function ensureRuntimeCredentials(
    compute: ComputeDriver,
    principalId: string,
    namespace: Readonly<Namespace>,
    agent: Readonly<Agent>,
    priorRevisionCount: number,
    assertProvidersCurrent: () => void,
  ): Promise<void> {
    if (
      compute.getAgentRuntimeCredentialStatus === undefined ||
      compute.provisionAgentRuntimeCredentials === undefined
    ) {
      throw new DependencyUnavailableError(
        "The selected Compute Driver cannot manage required Agent runtime credentials.",
      );
    }
    const binding = { namespace, agent };
    const status = runtimeCredentialStatus(
      await runtimeCredentialOperation(() => compute.getAgentRuntimeCredentialStatus!(binding)),
    );
    if (!status.transportConfigured) {
      if (priorRevisionCount > 0) {
        throw new ResourceStateConflictError(
          "Agent runtime credentials are missing after a historical revision. Ask an operator to restore them before deploying.",
        );
      }
      for (const action of ["read", "operate"] as const) {
        await dependencies.authority.authorize(principalId, action, {
          kind: "agent",
          id: agent.id,
          namespaceId: namespace.id,
        });
      }
      // The Driver creates only missing owned Secrets; a failed admission can reuse them.
      assertProvidersCurrent();
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

  async function admitAgentDeployment(
    principalId: string,
    input: NormalizedDeploymentInput,
    resolveHarness: HarnessResolver,
    auditEvent?: (result: Readonly<AuthorizedAgentDeployment>) => AuditEvent,
  ): Promise<Readonly<AuthorizedAgentDeployment>>;
  async function admitAgentDeployment(
    principalId: string,
    input: NormalizedDeploymentInput,
    resolveHarness: HarnessResolver,
    auditEvent: ((result: Readonly<AuthorizedAgentDeployment>) => AuditEvent) | undefined,
    first: FirstDeploymentGuard,
  ): Promise<Readonly<AuthorizedAgentDeployment> | Readonly<FirstDeploymentReceipt>>;
  async function admitAgentDeployment(
    principalId: string,
    input: NormalizedDeploymentInput,
    resolveHarness: HarnessResolver,
    auditEvent?: (result: Readonly<AuthorizedAgentDeployment>) => AuditEvent,
    first?: FirstDeploymentGuard,
  ): Promise<Readonly<AuthorizedAgentDeployment> | Readonly<FirstDeploymentReceipt>> {
    if (!isNonEmptyString(input.agentId)) {
      throw new ScopeViolationError("The exact Agent identity is missing.");
    }
    const ordinaryPreparation =
      first === undefined
        ? await dependencies.channels.validateDeploymentChannels(principalId, input)
        : undefined;
    namespaceIdentity(input.namespaceId);
    return dependencies.transactions.transact(async (state) => {
      await dependencies.authority.holdAuthority(state);
      const target: ResourceRef = {
        kind: "agent",
        id: input.agentId,
        namespaceId: input.namespaceId,
      };
      await dependencies.authority.authorize(principalId, "deploy", target);
      const namespace = await lockNamespace(state, input.namespaceId);
      // AccessBinding deletes hold this lock: authorize again so a revocation that committed
      // while this deploy waited stops it before it writes Agent grants.
      let authorization = await dependencies.authority.authorize(principalId, "deploy", target);
      const agent = await state.agents.findAgent(namespace.id, input.agentId);
      if (!agent) {
        throw new ScopeViolationError(
          "The Agent does not belong to the exact Installation and Namespace.",
        );
      }
      if (first === undefined) {
        await dependencies.provisioningWorker.guardAgentProvisioning(
          state,
          namespace.id,
          agent.id,
          true,
        );
      }
      const lockedAgent = await state.agents.lockAgent(namespace.id, agent.id);
      if (!lockedAgent) {
        throw new ScopeViolationError("The Agent does not belong to the exact Namespace.");
      }
      let prepared = ordinaryPreparation;
      if (prepared !== undefined) {
        dependencies.channels.assertPreparedDeploymentDrivers(prepared);
        if (lockedAgent.configurationId !== prepared.configuration.id) {
          throw new ResourceStateConflictError(
            "The Agent Configuration changed after credential validation. Review the current binding before deploying.",
          );
        }
      }
      if (first !== undefined) {
        authorization = await authorizeFirstDeploymentReceipt(
          dependencies.authority,
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
        dependencies.channels.assertPreparedDeploymentDrivers(prepared);
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
        compute = dependencies.selectedCompute();
      } catch {
        throw new DependencyUnavailableError("The selected compute Driver is unavailable.");
      }
      const sandbox = dependencies.sandboxDriver();

      if (!isNonEmptyString(lockedAgent.servicePrincipalId)) {
        throw new ScopeViolationError(
          "The Agent or its service principal does not belong to the exact Namespace.",
        );
      }
      if (lockedAgent.status !== "active") {
        throw new AgentDeletingError();
      }
      const backendId = dependencies.backendId(lockedAgent.backendId);
      if (!validExecutionMode(lockedAgent.executionMode)) {
        throw new ScopeViolationError("The persisted Agent Harness execution mode is invalid.");
      }
      requireSandboxExecutionMode(sandbox, lockedAgent.executionMode);
      dependencies.harnessAuth.assertCredentialGatewayDelivery(lockedAgent.harnessAuth);
      const { metadata, configuration, configurationDriver } = await admitConfiguration(
        state,
        principalId,
        lockedAgent,
        prepared,
        first !== undefined,
      );
      if (first !== undefined) {
        await dependencies.provisioningWorker.guardAgentProvisioning(
          state,
          namespace.id,
          agent.id,
          true,
        );
      }
      const configuredHarnessId = resolveConfiguredHarnessId(
        configuration.values,
        dependencies.modelPolicyAgent(lockedAgent.executionMode, resolveHarness),
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
      requireDedicatedNativeSupport(requestedHarness, sandbox, dependencies.nativeWorkers, {
        configuration: configuration.values,
      });
      await dependencies.credentialAccess.grantDeployedAgentSources(
        state,
        principalId,
        lockedAgent,
        storedSecretBindings(metadata.secretBindings),
      );
      const [harnessAuth, credentialSourceType] = await dependencies.harnessAuth.admitHarnessAuth(
        state,
        principalId,
        lockedAgent,
      );
      const stagedModel = await prepareModelCredentialDeployment(
        state,
        lockedAgent,
        harnessAuth,
        requestedHarness,
        configuration.values,
        sandbox,
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
      if (stagedModel !== undefined) {
        const resolvedProvider = asRecord(revisionHarness.configuration?.modelProvider);
        let matches: boolean;
        try {
          matches =
            resolvedProvider?.protocol === stagedModel.preset.provider.protocol &&
            typeof resolvedProvider.baseUrl === "string" &&
            isDeepStrictEqual(
              inferenceKeyDestination(
                resolvedProvider.baseUrl,
                stagedModel.preset.provider.protocol,
              ),
              inferenceKeyDestination(
                stagedModel.preset.provider.baseUrl,
                stagedModel.preset.provider.protocol,
              ),
            );
        } catch {
          matches = false;
        }
        if (!matches) {
          throw new ResourceStateConflictError(
            "The frozen Harness model route does not match the admitted source preset.",
          );
        }
      }
      dependencies.harnessAuth.requireCredentialSourceDrivers(harnessAuth, sandbox);
      const driver =
        lockedAgent.plugins && Object.keys(lockedAgent.plugins).length
          ? dependencies.pluginDriver(revisionHarness.id, true)
          : undefined;
      const pluginState =
        driver && lockedAgent.plugins
          ? immutableCopy({
              driver: pluginOwner(driver, lockedAgent),
              plugins: lockedAgent.plugins,
            } satisfies PluginRevisionState)
          : undefined;
      const credentialSources = await dependencies.credentialAccess.admitCredentialSources(
        state,
        principalId,
        lockedAgent,
        sandbox,
        driver,
        revisionHarness,
        compute,
      );
      const { secretBindings, secretDriver } = await admitConfigurationSecrets(
        state,
        principalId,
        lockedAgent,
        metadata.secretBindings,
      );
      const admittedConfiguration = agentRuntimeConfiguration(
        configuration.values,
        revisionHarness,
        compute,
        sandbox,
        dependencies.loggingLevel,
      );
      // The model provider settings, then the Compute rules, as on Configuration save, so a
      // stored Configuration that predates a rule gets the message its next save would. A
      // baseUrl or api the runtime cannot use would otherwise fail later, as an unexplained
      // model probe failure (finding 1549). Native workspace setup refuses an invalid bootstrap
      // setting only after the deployment starts (finding 2699); the Gateway refuses a setting
      // the pinned OpenClaw retired and does not start (finding 2709), and fails every turn in
      // OpenClaw's sandbox (finding 2767). The upgrade preflight runs the same values-only rules.
      refuseUndeployableConfigurationValues(configuration.values);
      dependencies.validateComputeConfiguration(configuration.values);
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
        if (!dependencies.enabledPluginDrivers().includes(driver)) {
          throw new ResourceStateConflictError("The plugin catalog changed. Refresh and retry.");
        }
        validatePluginSettings(
          driver,
          pluginState.plugins,
          lockedAgent.pluginApprovers,
          admittedConfiguration,
          "stored",
        );
        dependencies.plugins.validatePluginPlacement(driver, pluginState.plugins, revisionHarness);
      }
      // Decode every earlier revision: one that is unreadable refuses the deploy here (503,
      // nothing created), because the worker must decode them all to stop or retire them.
      const previous = await state.revisions.listRevisions(namespace.id, lockedAgent.id);
      const createdAt = dependencies.timestamp();
      const resolvedRepositoryCredentials =
        dependencies.repositoryPolicy.admitRepositoryCredentials(
          lockedAgent,
          compute,
          { ...approvedHarness, mode: lockedAgent.executionMode },
          sandbox?.id,
          Date.parse(createdAt),
        );
      if (resolvedRepositoryCredentials !== undefined) {
        dependencies.validateRepositoryBrokerNetworkProxy(
          revisionHarness,
          admittedConfiguration,
          sandbox,
        );
      }
      const repositoryCredentials =
        await dependencies.repositoryPolicy.applyRepositoryStandingApproval(
          state,
          namespace.id,
          lockedAgent.id,
          resolvedRepositoryCredentials,
        );
      // PostgreSQL restamps createdAt on its own clock; the response carries the stored value.
      // The repository credential deadline above stays on this controller's clock.
      const revisionId = dependencies.nextIdentifier("agent_revision");
      const policy =
        stagedModel === undefined
          ? undefined
          : await state.sandboxPolicies.find(namespace.id, lockedAgent.id);
      if (policy !== undefined && policy.additions.length > 0) {
        await dependencies.authority.authorize(principalId, "read", {
          kind: "sandbox_policy",
          id: policy.id,
          namespaceId: namespace.id,
        });
      }
      if (
        stagedModel !== undefined &&
        (repositoryCredentials !== undefined || credentialSources.length !== 1)
      ) {
        throw new ResourceStateConflictError(
          "A staged model credential cannot share an execution with other credential delivery.",
        );
      }
      const credentialDeployment =
        stagedModel === undefined
          ? undefined
          : admitModelCredentialPolicy(stagedModel, policy?.additions ?? []);
      const proxyAdmission =
        credentialDeployment === undefined
          ? await dependencies.egress.admitProxyPlan(
              state,
              lockedAgent,
              revisionId,
              admittedConfiguration,
              sandbox?.id,
              repositoryCredentials,
              harnessAuth,
              revisionHarness.configuration,
            )
          : undefined;
      const egressPlan = proxyAdmission?.plan;
      const executionAdmission: ExecutionAdmission =
        credentialDeployment === undefined
          ? executionAdmissionFor(egressPlan)
          : { version: 8, mode: "standalone" };
      const execution = {
        executionAdmission,
        ...(egressPlan === undefined ? {} : { egressPlan }),
        ...(credentialDeployment === undefined ? {} : { credentialDeployment }),
      };
      assertExecutionAdmission(execution);
      try {
        if (compute.validateExecutionAdmission === undefined) {
          assertExecutionReleaseAllowed(execution);
        } else {
          const admission = { ...execution, harnessAuth, credentialSources, repositoryCredentials };
          compute.validateExecutionAdmission(
            admission,
            stagedModel?.owner ?? (egressPlan && dependencies.selectedProxyOwner()),
          );
        }
      } catch {
        throw new DependencyUnavailableError(
          "The selected Compute cannot admit this execution mode; protected release and old-reader fencing are unavailable.",
        );
      }
      const sandboxPolicy = await dependencies.sandboxPolicy.admitDeploymentSnapshot(
        state,
        principalId,
        lockedAgent,
        revisionHarness,
        sandbox,
        executionAdmission,
        repositoryCredentials !== undefined,
        stagedModel === undefined ? undefined : { policy },
      );
      if (compute.requiresAgentRuntimeCredentials === true) {
        await ensureRuntimeCredentials(
          compute,
          principalId,
          namespace,
          lockedAgent,
          previous.length,
          () => proxyAdmission?.assertProvidersCurrent(),
        );
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
      const candidate = prepareComputeRevision(compute, revisionDraft);
      // Database locks do not freeze process-local selections across awaited Driver calls.
      if (prepared !== undefined) {
        dependencies.channels.assertPreparedDeploymentDrivers(prepared);
      }
      if (stagedModel !== undefined) {
        dependencies.ownedTokenServiceDriver(stagedModel.source.tokenServiceInstanceId);
        let owner: InstalledDriver | undefined;
        try {
          owner = dependencies.selectedCredentialDeliveryOwner();
        } catch {
          // Process-local selections can change while awaited Driver work is in progress.
        }
        if (
          owner === undefined ||
          owner !== stagedModel.owner ||
          owner.require("sandbox") !== sandbox ||
          owner.require("credential_proxy_delivery") !== stagedModel.proxy
        ) {
          throw new DependencyUnavailableError(
            "The staged credential enforcing Drivers changed during admission.",
          );
        }
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
      await dependencies.workRecorder.record(state, {
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

  return admitAgentDeployment;
}
