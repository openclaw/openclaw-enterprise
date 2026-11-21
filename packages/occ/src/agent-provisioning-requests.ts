import { createHash } from "node:crypto";

import {
  CONTROLLER_WORK_AUDIT_ACTIONS,
  isName,
  isSecretHarnessAuth,
  isServiceAccountHarnessAuth,
  validPluginDriverIdentity,
  type Agent,
  type AuditEvent,
  type BackendRef,
  type ComputeDriver,
  type ConfigurationDriver,
  type CredentialSource,
  type CredentialSourceType,
  type HarnessAuthBinding,
  type HarnessAuthSnapshot,
  type HarnessExecutionMode,
  type IAMDriver,
  type Namespace,
  type OpenClawConfigurationDocument,
  type PluginApprovers,
  type PluginDesiredState,
  type PluginDriver,
  type PluginDriverIdentity,
  type RepositoryAccess,
  type RepositoryBindingRequest,
  type RepositoryBindingSelection,
  type RevisionHarnessDescriptor,
  type SandboxDriver,
  type SecretBindings,
  type SecretReference,
  type ServiceAccount,
} from "@openclaw-enterprise/contracts";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";

import {
  requireSandboxExecutionMode,
  requireSandboxOpenClawMode,
  validateComputeAgentProvisioning,
  validateRepositoryTopology,
  validateWorkspaceSetupTopology,
} from "./agent-harness-topology.ts";
import {
  requireCredentialSourceSandbox,
  SERVICE_ACCOUNT_CROSS_NAMESPACE,
  type createHarnessAuthOperations,
} from "./harness-auth.ts";
import {
  canonicalProvisioningJson,
  normalizeGatewayManagedMode,
  normalizeProvisioningConfiguration,
  normalizeProvisioningHarnessAuth,
  normalizeProvisioningWorkspace,
  parseProvisioningPlan,
  provisioningProgress,
  requireProvisioningRequestId,
  validExecutionMode,
  type AgentProvisioningConfigurationInput,
  type AgentProvisioningDeploymentProgress,
  type ProvisionAgentInput,
  type ProvisionAgentResult,
} from "./agent-provisioning.ts";
import type { AgentProvisioningRecord } from "./ports/agent-provisioning.ts";
import { resolveConfiguredHarnessId } from "./configured-harness.ts";
import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import { workMatchesRevision, type ControllerWork } from "./controller-work.ts";
import {
  CallerStateDeniedError,
  ConfigurationHarnessError,
  DependencyUnavailableError,
  NamespaceNotReadyError,
  ResourceStateConflictError,
  ScopeViolationError,
  SecretBindingValidationError,
} from "./errors.ts";
import type { PlatformReadView } from "./ports/platform-read-view.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";

interface ProvisioningRequestDependencies {
  readonly installationId: () => string;
  readonly clock: () => Date;
  readonly timestamp: () => string;
  readonly nextIdentifier: (kind: "agent") => string;
  readonly requestAuditId: () => string | undefined;
  readonly backendId: (value: BackendRef | undefined) => BackendRef;
  readonly exactServiceAccount: (
    state: PlatformReadView,
    namespaceId: string,
    serviceAccountId: string,
  ) => Promise<Readonly<ServiceAccount>>;
  readonly refuseTakenAgentName: (
    state: Pick<PlatformReadView, "agents">,
    namespaceId: string,
    name: string,
  ) => Promise<void>;
  readonly deploymentProgressForWork: (
    work: Readonly<ControllerWork>,
    attempt?: Awaited<ReturnType<PlatformReadView["operations"]["findWorkAttempt"]>>,
  ) => AgentProvisioningDeploymentProgress;
  readonly transactions: Pick<ControllerTransactions, "read" | "transact">;
  readonly authority: Pick<
    ControllerAuthority,
    "authorize" | "canRead" | "authorizeAgentPrincipal"
  >;
  readonly namespace: {
    namespaceIdentity(namespaceId: string): void;
    exactNamespace(state: PlatformReadView, namespaceId: string): Promise<Readonly<Namespace>>;
    lockNamespace(state: PlatformUnitOfWork, namespaceId: string): Promise<Readonly<Namespace>>;
  };
  readonly drivers: {
    compute(): ComputeDriver;
    configuration(): ConfigurationDriver;
    sandbox(): SandboxDriver | undefined;
    iam(): IAMDriver;
    ownedSecretDriver(driverId: string): void;
  };
  readonly configuration: {
    validateChannelCredentials(
      principalId: string,
      namespaceId: string,
      configuration: AgentProvisioningConfigurationInput,
      authorizeUse: () => Promise<void>,
    ): Promise<void>;
    validateContent(
      values: OpenClawConfigurationDocument,
      bindings: SecretBindings,
      mode: HarnessExecutionMode,
    ): void;
    resolveHarness(
      values: Readonly<OpenClawConfigurationDocument>,
      mode: HarnessExecutionMode,
    ): string;
  };
  readonly harness: () => Pick<
    ReturnType<typeof createHarnessAuthOperations>,
    | "admitHarnessAuth"
    | "assertCredentialGatewayDelivery"
    | "authorizeHarnessAuthSource"
    | "requireCredentialSourceDrivers"
    | "requireSavedHarnessAuth"
    | "secretHarnessAuthSnapshot"
    | "credentialSourceHarnessAuthSnapshot"
    | "serviceAccountHarnessAuthSnapshot"
  >;
  readonly plugins: {
    normalizeAgentPlugins(plugins: PluginDesiredState | undefined): PluginDesiredState | undefined;
    normalizeAgentPluginApprovers(value: unknown): PluginApprovers | undefined;
    validateAgentPlugins(
      plugins: PluginDesiredState | undefined,
      approvers: PluginApprovers | undefined,
      readValues: () =>
        Readonly<OpenClawConfigurationDocument> | Promise<Readonly<OpenClawConfigurationDocument>>,
      previous?: {
        readonly plugins?: PluginDesiredState;
        readonly pluginDriver?: PluginDriverIdentity;
      },
      source?: "request" | "stored",
    ): Promise<PluginDriver | undefined>;
    validatePluginCredentialSources(
      driver: PluginDriver | undefined,
      plugins: PluginDesiredState | undefined,
      sources: readonly CredentialSource[],
    ): Promise<void>;
    validatePluginPlacement(
      driver: PluginDriver,
      plugins: PluginDesiredState | undefined,
      harness: Readonly<Pick<RevisionHarnessDescriptor, "id" | "mode">>,
    ): void;
    pluginOwner(
      driver: PluginDriver,
      previous?: {
        readonly plugins?: PluginDesiredState;
        readonly pluginDriver?: PluginDriverIdentity;
      },
    ): PluginDriverIdentity;
  };
  readonly repository: {
    admitRepositoryCredentials(
      agent: Readonly<Agent>,
      compute: ComputeDriver,
      harness: RevisionHarnessDescriptor,
      sandboxDriverId: string | undefined,
      admittedAtWallMs: number,
    ): unknown;
    repositorySettings(
      namespaceId: string,
      input: {
        readonly repositoryBindings?: readonly RepositoryBindingRequest[];
        readonly repositoryAccess?: RepositoryAccess;
      },
    ): {
      repositoryBindings: readonly RepositoryBindingSelection[] | undefined;
      repositoryAccess?: RepositoryAccess;
    };
    validateRepositoryBrokerNetworkProxy(
      harness: Readonly<Pick<RevisionHarnessDescriptor, "id" | "mode">>,
      configuration: Readonly<OpenClawConfigurationDocument>,
      sandbox: SandboxDriver | undefined,
    ): void;
  };
  readonly topology: {
    rejectCrossNamespaceSecretSources(
      namespaceId: string,
      secretBindings: SecretBindings | undefined,
      harnessAuth: HarnessAuthBinding | null | undefined,
    ): void;
    requireDedicatedNativeSupport(
      harness: Readonly<Pick<RevisionHarnessDescriptor, "id" | "mode">>,
      sandbox: SandboxDriver | undefined,
      options: {
        runtimeImage: boolean;
        stored: boolean;
        configuration: Readonly<OpenClawConfigurationDocument>;
      },
    ): void;
  };
}

export function createProvisioningRequests(dependencies: ProvisioningRequestDependencies) {
  const {
    transactions,
    authority,
    drivers,
    configuration,
    namespace: namespaceScope,
    harness: harnessAuthAccess,
    plugins: pluginPolicy,
    repository,
    topology,
  } = dependencies;

  async function provisionAgent(
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
    await authorizeProvisioningRequest(principalId, input.namespaceId);
    const requestId = requireProvisioningRequestId(input.requestId);
    if (!isName(input.name)) {
      throw new ScopeViolationError("The Agent name is invalid.");
    }
    const originalConfiguration = normalizeProvisioningConfiguration(input.configuration);
    const harnessAuth = normalizeProvisioningHarnessAuth(input.harnessAuth ?? null);
    const executionMode = input.executionMode ?? "embedded";
    if (!validExecutionMode(executionMode)) {
      throw new ScopeViolationError("The Agent Harness execution mode is invalid.");
    }
    const gatewayManagedMode = normalizeGatewayManagedMode(input.gatewayManagedMode, true);
    const backendId = dependencies.backendId(input.backendId);
    const plugins = pluginPolicy.normalizeAgentPlugins(input.plugins);
    const pluginApprovers = pluginPolicy.normalizeAgentPluginApprovers(input.pluginApprovers);
    const workspace = normalizeProvisioningWorkspace(
      input.initialWorkspaceFiles,
      input.workspaceDefaultsId,
    );
    const compute = drivers.compute();
    const configurationDriver = drivers.configuration();
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
    harnessAuthAccess().assertCredentialGatewayDelivery(harnessAuth);
    const acceptedInput = Object.freeze({
      requestId,
      namespaceId: input.namespaceId,
      name: input.name,
      configuration: originalConfiguration,
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
    async function validateContent(configurationInput: AgentProvisioningConfigurationInput) {
      await configurationDriver.validateSize?.(configurationInput.values);
      configuration.validateContent(
        configurationInput.values,
        configurationInput.secretBindings ?? {},
        executionMode,
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
        createdAt: dependencies.timestamp(),
      });
    }

    async function prepareNewRequest(
      originalConfiguration: AgentProvisioningConfigurationInput,
      harnessAuth: HarnessAuthBinding,
    ) {
      let configurationInput = originalConfiguration;
      let reservedAgentId: string | undefined;
      if (configurationPreparation !== undefined) {
        reservedAgentId = dependencies.nextIdentifier("agent");
        configurationInput = normalizeProvisioningConfiguration({
          ...configurationInput,
          values: configurationPreparation.prepare(
            { id: reservedAgentId, namespaceId: input.namespaceId },
            configurationInput.values,
          ),
        });
      }
      // A replay is checked against the current Installation by authorizeProvisioningRecord.
      harnessAuthAccess().requireSavedHarnessAuth(
        input.namespaceId,
        compute,
        executionMode,
        harnessAuth,
        configurationInput.values,
      );
      validateComputeAgentProvisioning(compute, executionMode, configurationInput.values);
      // Reject foreign references before channel validation can report them as a scope miss.
      topology.rejectCrossNamespaceSecretSources(
        input.namespaceId,
        configurationInput.secretBindings,
        harnessAuth,
      );
      // Before the Channel Driver, which reads only an env SecretRef: it would answer a channel
      // credential reference form these rules name (an unbound name, `$NAME`, a fallback, other
      // text) with its generic binding refusal (finding 2506). Admission repeats them below.
      await validateContent(configurationInput);
      await configuration.validateChannelCredentials(
        principalId,
        input.namespaceId,
        configurationInput,
        () => authorizeProvisioningRequest(principalId, input.namespaceId),
      );
      return { configurationInput, reservedAgentId };
    }

    const replay = await transactions.read((state) =>
      state.provisioning.findByRequest(input.namespaceId, principalId, requestId),
    );
    // Reserve identity before preparing values, but expose agentId only after the Agent exists.
    // The request fingerprint covers the original input and preparation choice, so retries
    // reuse the saved plan even if Installation routing changes.
    const prepared =
      replay === undefined
        ? await prepareNewRequest(originalConfiguration, harnessAuth)
        : { configurationInput: originalConfiguration, reservedAgentId: undefined };
    const { configurationInput, reservedAgentId } = prepared;
    return transactions.transact(async (state) => {
      const namespace = await namespaceScope.lockNamespace(state, input.namespaceId);
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
        await authorizeProvisioningRecord(state, principalId, replay);
        const work = await state.operations.findWork(replay.workId);
        const result = await provisioningResultForWork(state, principalId, replay, work);
        if (auditEvent) {
          await state.audit.append(auditEvent(result));
        }
        return result;
      }

      const workId = `agent-provisioning:${createHash("sha256")
        .update(`${namespace.id}\0${principalId}\0${requestId}`)
        .digest("hex")
        .slice(0, 32)}`;

      await authority.authorize(principalId, "create", {
        kind: "agent",
        id: namespace.id,
        namespaceId: namespace.id,
      });
      await authority.authorize(principalId, "create", {
        kind: "configuration",
        id: namespace.id,
        namespaceId: namespace.id,
      });
      const driver = await pluginPolicy.validateAgentPlugins(
        plugins,
        pluginApprovers,
        () => configurationInput.values,
      );
      // Provisioning creates the Agent before it has tool sources. Bind the account
      // on the saved Agent after the initial install.
      await pluginPolicy.validatePluginCredentialSources(driver, plugins, []);
      await authorizeProvisioningSources(
        state,
        principalId,
        namespace.id,
        configurationInput.secretBindings,
        harnessAuth,
      );
      await validateContent(configurationInput);
      const { repositoryBindings, repositoryAccess } = repository.repositorySettings(
        namespace.id,
        input,
      );
      // Refuse repository bindings the topology cannot deliver, with Agent create's 409, before
      // queueing work the worker's admission would refuse (finding 1145). Unlike Agent save, a
      // Compute Driver without repository support is refused here too: deployment would be.
      // authorizeProvisioningRecord repeats this check for the stored record, after the Harness
      // authentication check; this copy also runs where no durable record can be stored.
      if (repositoryBindings !== undefined && repositoryBindings.length > 0) {
        validateRepositoryTopology(
          compute,
          {
            id: configuration.resolveHarness(configurationInput.values, executionMode),
            version: "provisioning",
            mode: executionMode,
          },
          drivers.sandbox()?.id,
        );
      }
      // Plugins the Plugin Driver cannot run in this Harness, as Agent save refuses them;
      // authorizeProvisioningRecord repeats this check for the stored record.
      if (driver) {
        pluginPolicy.validatePluginPlacement(driver, plugins, {
          id: configuration.resolveHarness(configurationInput.values, executionMode),
          mode: executionMode,
        });
      }
      // A Codex network proxy that blocks the repository credential broker, as Agent save refuses
      // it; authorizeProvisioningRecord repeats this check for the stored record.
      if (repositoryBindings !== undefined && repositoryBindings.length > 0) {
        repository.validateRepositoryBrokerNetworkProxy(
          {
            id: configuration.resolveHarness(configurationInput.values, executionMode),
            mode: executionMode,
          },
          configurationInput.values,
          drivers.sandbox(),
        );
      }
      // The worker's Agent create refuses a taken name; refuse it here instead of accepting work
      // that can only fail (finding 2420). Under the Namespace lock that Agent create also takes.
      // Like the preflight and Agent create, the 409 comes after the plan's other checks, so a
      // rename never uncovers a different refusal. A request admitted alongside with the same
      // name still fails in its job.
      await dependencies.refuseTakenAgentName(state, namespace.id, input.name);
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
              ? { pluginDriver: pluginPolicy.pluginOwner(driver) }
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
              iam: drivers.iam().id,
            },
          },
        },
        dependencies.requestAuditId(),
      );
      await authorizeProvisioningRecord(state, principalId, record.record, {
        admission: true,
      });
      await state.audit.append({
        id: `aud_${crypto.randomUUID()}`,
        installationId: dependencies.installationId(),
        namespaceId: namespace.id,
        occurredAt: dependencies.timestamp(),
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

  async function getAgentProvisioning(
    principalId: string,
    namespaceId: string,
    workId: string,
  ): Promise<Readonly<ProvisionAgentResult>> {
    await authorizeProvisioningRequest(principalId, namespaceId);
    return transactions.transact(async (state) => {
      const { record, work } = await exactProvisioningWork(state, principalId, namespaceId, workId);
      if (work === undefined) {
        throw new DependencyUnavailableError("The provisioning work is unavailable.");
      }
      return provisioningResultForWork(state, principalId, record, work);
    });
  }

  async function retryAgentProvisioning(
    principalId: string,
    namespaceId: string,
    workId: string,
  ): Promise<Readonly<ProvisionAgentResult>> {
    await authorizeProvisioningRequest(principalId, namespaceId);
    return transactions.transact(async (state) => {
      const namespace = await namespaceScope.lockNamespace(state, namespaceId);
      const { record, work: observed } = await exactProvisioningWork(
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
      await authorizeProvisioningRecord(state, principalId, record);
      if (record.status === "queued" || record.status === "running") {
        return Object.freeze({
          provisioning: provisioningProgress(record, observed, dependencies.clock()),
        });
      }
      const retried = await state.provisioning.retryByWorkId(namespaceId, workId, principalId);
      const requestId = dependencies.requestAuditId();
      if (requestId !== undefined) {
        await state.audit.append({
          id: `aud_${crypto.randomUUID()}`,
          installationId: dependencies.installationId(),
          namespaceId,
          occurredAt: dependencies.timestamp(),
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
      return Object.freeze({
        provisioning: provisioningProgress(retried, work, dependencies.clock()),
      });
    });
  }

  async function provisioningResultForWork(
    state: PlatformReadView,
    principalId: string,
    record: Readonly<AgentProvisioningRecord>,
    work: ControllerWork | undefined,
  ): Promise<Readonly<ProvisionAgentResult>> {
    const now = dependencies.clock();
    const deploymentProgress = await provisioningDeploymentProgress(
      state,
      principalId,
      record,
      work,
    );
    return Object.freeze({
      provisioning: provisioningProgress(record, work, now, deploymentProgress),
    });
  }

  /**
   * The initial deployment's progress for a job waiting on it after handoff (finding 1634).
   * The provisioning read does not check `agent_revision:read`, which the deployment read
   * needs, so a caller without it gets undefined and the job reports only its own deferral.
   */
  async function provisioningDeploymentProgress(
    state: PlatformReadView,
    principalId: string,
    record: Readonly<AgentProvisioningRecord>,
    work: { readonly state: string } | undefined,
  ): Promise<AgentProvisioningDeploymentProgress | undefined> {
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
      !(await authority.canRead(principalId, {
        kind: "agent_revision",
        id: revisionId,
        namespaceId: record.namespaceId,
        parentAgentId: record.agentId,
      }))
    ) {
      return undefined;
    }
    return dependencies.deploymentProgressForWork(
      deployment,
      deployment.state === "queued" || deployment.state === "claimed"
        ? await state.operations.findWorkAttempt(key)
        : undefined,
    );
  }

  /**
   * The provisioning grants that need only the requested Namespace. Status and retry check them
   * before any lookup, so a caller without them gets the same audited denial whether or not the
   * Namespace or work item exists.
   */
  async function authorizeProvisioningRequest(
    principalId: string,
    namespaceId: string,
  ): Promise<void> {
    namespaceScope.namespaceIdentity(namespaceId);
    await authority.authorize(principalId, "create", {
      kind: "agent",
      namespaceId,
      id: namespaceId,
    });
    await authority.authorize(principalId, "create", {
      kind: "configuration",
      namespaceId,
      id: namespaceId,
    });
    await authority.authorize(principalId, "administer", {
      kind: "installation",
      id: dependencies.installationId(),
    });
  }

  async function authorizeProvisioningRecord(
    state: PlatformUnitOfWork,
    principalId: string,
    record: Readonly<AgentProvisioningRecord>,
    {
      statusRead,
      admission = false,
    }: { readonly statusRead?: "status" | "retry"; readonly admission?: boolean } = {},
  ): Promise<void> {
    const namespaceId = record.namespaceId;
    await authorizeProvisioningRequest(principalId, namespaceId);
    if (record.agentId !== undefined) {
      for (const action of ["read", "operate", "deploy"] as const) {
        await authority.authorize(principalId, action, {
          kind: "agent",
          namespaceId,
          id: record.agentId,
        });
      }
    }
    if (record.configurationId !== undefined) {
      for (const action of ["read", "update"] as const) {
        await authority.authorize(principalId, action, {
          kind: "configuration",
          namespaceId,
          id: record.configurationId,
        });
      }
    }
    const plan = parseProvisioningPlan(record);
    if (drivers.iam().namespacePolicyTransaction !== "platform-unit-of-work") {
      throw new DependencyUnavailableError(
        "Agent provisioning requires transactional Namespace policy management.",
      );
    }
    const acceptedDrivers = asRecord(record.plan.drivers);
    const compute = drivers.compute();
    const configurationDriver = drivers.configuration();
    if (
      acceptedDrivers?.compute !== compute.id ||
      acceptedDrivers.configuration !== configurationDriver.id ||
      acceptedDrivers.iam !== drivers.iam().id ||
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
      await assertProvisioningSourcesExist(state, namespaceId, plan);
    }
    await authorizeProvisioningSources(
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
      harnessAuthAccess().assertCredentialGatewayDelivery(binding);
    }
    const backendId = dependencies.backendId(record.plan.backendId as BackendRef | undefined);
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
        await authority.authorizeAgentPrincipal(principalId, agent, "operate", {
          kind: "credential_source",
          namespaceId,
          id: binding.sourceId,
        });
      }
      requireCredentialSourceSandbox(drivers.sandbox());
    } else if (isSecretHarnessAuth(binding)) {
      auth = harnessAuthAccess().secretHarnessAuthSnapshot(binding);
    } else if (agent !== undefined) {
      [auth, credentialSourceType] = await harnessAuthAccess().admitHarnessAuth(
        state,
        principalId,
        {
          ...agent,
          harnessAuth: binding,
        },
      );
    } else if (binding.method === "credential_source") {
      [auth, credentialSourceType] = await harnessAuthAccess().credentialSourceHarnessAuthSnapshot(
        state,
        namespaceId,
        binding,
      );
    } else {
      auth = await harnessAuthAccess().serviceAccountHarnessAuthSnapshot(
        state,
        namespaceId,
        backendId,
        binding,
      );
    }
    const harness = {
      id: configuration.resolveHarness(plan.configuration.values, plan.executionMode),
      version: "provisioning",
      mode: plan.executionMode,
    };
    const sandbox = drivers.sandbox();
    if (auth !== undefined) {
      harnessAuthAccess().requireCredentialSourceDrivers(auth, sandbox);
    }
    // Runtime image native worker support is admission for writes (replay, retry, the worker), like
    // the plugin policy below: a status read still reports the stored work after the image loses it.
    topology.requireDedicatedNativeSupport(harness, sandbox, {
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
    const effectiveConfiguration = statusRead
      ? plan.configuration.values
      : (sandbox?.configureAgent?.(plan.configuration.values, harness) ??
        plan.configuration.values);
    if (resolveConfiguredHarnessId(effectiveConfiguration) !== harness.id) {
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
          effectiveConfiguration,
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
        validateWorkspaceSetupTopology(compute, harness, effectiveConfiguration, sandbox?.id);
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
      const plugins = pluginPolicy.normalizeAgentPlugins(
        record.plan.plugins as PluginDesiredState | undefined,
      );
      const driver = await pluginPolicy.validateAgentPlugins(
        plugins,
        pluginPolicy.normalizeAgentPluginApprovers(
          record.plan.pluginApprovers as PluginApprovers | undefined,
        ),
        () => effectiveConfiguration,
        {
          ...(plugins && { plugins }),
          ...(validPluginDriverIdentity(record.plan.pluginDriver)
            ? { pluginDriver: record.plan.pluginDriver }
            : {}),
        },
        "stored",
      );
      if (driver) {
        pluginPolicy.validatePluginPlacement(driver, plugins, harness);
      }
      const repositoryBindings = asRecord(record.plan)?.repositoryBindings;
      if (Array.isArray(repositoryBindings) && repositoryBindings.length > 0) {
        repository.validateRepositoryBrokerNetworkProxy(harness, effectiveConfiguration, sandbox);
      }
    }
    // Retry keeps this admission before its lifecycle checks; status only reads saved progress.
    if (agent !== undefined && statusRead !== "status") {
      repository.admitRepositoryCredentials(
        agent,
        compute,
        harness,
        drivers.sandbox()?.id,
        dependencies.clock().getTime(),
      );
    }
  }

  async function exactProvisioningWork(
    state: PlatformUnitOfWork,
    principalId: string,
    namespaceId: string,
    workId: string,
    operation: "status" | "retry" = "status",
  ) {
    if (!isNonEmptyString(workId)) {
      throw new ScopeViolationError("The exact provisioning work identity is missing.");
    }
    await namespaceScope.exactNamespace(state, namespaceId);
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
    await authorizeProvisioningRecord(state, principalId, found.record, {
      statusRead: operation,
    });
    return found;
  }

  async function assertProvisioningSourcesExist(
    state: PlatformUnitOfWork,
    namespaceId: string,
    plan: ReturnType<typeof parseProvisioningPlan>,
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

  async function authorizeProvisioningSources(
    state: PlatformUnitOfWork,
    principalId: string,
    namespaceId: string,
    bindings: SecretBindings | undefined,
    harnessAuth: HarnessAuthBinding | null,
  ): Promise<void> {
    for (const binding of Object.values(bindings ?? {})) {
      await authorizeProvisioningSecretSource(state, principalId, namespaceId, binding.source);
    }
    if (isSecretHarnessAuth(harnessAuth)) {
      await authorizeProvisioningSecretSource(state, principalId, namespaceId, harnessAuth.source);
    } else if (harnessAuth?.method === "credential_source") {
      await harnessAuthAccess().authorizeHarnessAuthSource(
        state,
        principalId,
        namespaceId,
        harnessAuth,
      );
    } else if (isServiceAccountHarnessAuth(harnessAuth)) {
      if (harnessAuth.source.namespaceId !== namespaceId) {
        throw new SecretBindingValidationError(SERVICE_ACCOUNT_CROSS_NAMESPACE);
      }
      await authority.authorize(principalId, "read", {
        kind: "service_account",
        namespaceId,
        id: harnessAuth.source.id,
      });
      await dependencies.exactServiceAccount(state, namespaceId, harnessAuth.source.id);
    }
  }

  async function authorizeProvisioningSecretSource(
    state: PlatformUnitOfWork,
    principalId: string,
    namespaceId: string,
    source: SecretReference,
  ): Promise<void> {
    if (source.namespaceId !== namespaceId) {
      throw new SecretBindingValidationError("Secret references cannot cross Namespaces.");
    }
    await authority.authorize(principalId, "operate", source);
    const secret = await state.secrets.lockSecret(namespaceId, source.id);
    if (secret === undefined) {
      throw new ScopeViolationError("The Secret does not belong to the exact Namespace.");
    }
    drivers.ownedSecretDriver(secret.driverId);
  }

  return {
    provisionAgent,
    getAgentProvisioning,
    retryAgentProvisioning,
    authorizeProvisioningRecord,
  };
}
