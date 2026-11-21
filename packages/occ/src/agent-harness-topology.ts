import {
  admitLoggingConfiguration,
  type ComputeDriver,
  type Configuration,
  type HarnessAuthSnapshot,
  type HarnessDescriptor,
  type HarnessExecutionMode,
  type LoggingLevel,
  type OpenClawConfigurationDocument,
  type PluginDesiredState,
  type PluginDriver,
  type RepositoryBindingSelection,
  type RevisionHarnessDescriptor,
  type SandboxDriver,
} from "@openclaw-enterprise/contracts";
import { asRecord } from "@openclaw-enterprise/utils";
import {
  codexRunsPrimaryModel,
  requireFallbackProviders,
  resolveConfiguredHarnessId,
  type ModelPolicyAgent,
} from "./configured-harness.ts";
import {
  ComputeGatewaySettingError,
  ComputeProvisioningRefusedError,
  ComputeRepositoryCredentialsUnsupportedError,
  ConfigurationHarnessError,
  DEDICATED_OPENCLAW_SANDBOX_REQUIRED,
  DedicatedOpenClawSandboxError,
  DependencyUnavailableError,
  NativeWorkerSupportError,
  ResourceStateConflictError,
  SandboxRepositoryRecipientUnverifiedError,
} from "./errors.ts";
import { admitGatewaySecurityDefaults } from "./gateway-security-defaults.ts";
import {
  freezeConfigurationValues,
  refuseStoredConfigurationSettings,
} from "./configuration-settings.ts";
import {
  provisionsDedicatedOpenClaw,
  type NativeWorkerSupportSource,
} from "./native-worker-support.ts";

interface AgentHarnessTopologyDependencies {
  readonly sandboxDriver: () => SandboxDriver | undefined;
  readonly selectedCompute: () => ComputeDriver | undefined;
  readonly validatePluginPlacement: (
    driver: PluginDriver,
    plugins: PluginDesiredState | undefined,
    harness: Readonly<Pick<RevisionHarnessDescriptor, "id" | "mode">>,
  ) => void;
  readonly validateRepositoryBrokerNetworkProxy: (
    harness: Readonly<Pick<RevisionHarnessDescriptor, "id" | "mode">>,
    values: Readonly<OpenClawConfigurationDocument>,
    sandbox: SandboxDriver | undefined,
  ) => void;
  readonly loggingLevel: LoggingLevel;
}

export type HarnessResolver = (
  harnessId: string,
  executionMode: HarnessExecutionMode,
) => HarnessDescriptor | undefined;

/** Product names for Harness ids that appear in caller-facing refusals. */
const HARNESS_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  codex: "Codex",
  openclaw: "OpenClaw",
});

// Agent save and deploy admission apply these rules to the same pair, with the same message.
export function requireSandboxExecutionMode(
  sandbox: SandboxDriver | undefined,
  executionMode: HarnessExecutionMode,
): void {
  if (sandbox !== undefined && executionMode !== "dedicated") {
    throw new ConfigurationHarnessError(
      `The selected Sandbox Driver supports only dedicated Harness execution; this Agent uses ${executionMode} execution. Set executionMode to dedicated.`,
    );
  }
}

export function requireSandboxOpenClawMode(
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
export function resolveAgentHarness(
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
export function selectsModel(values: Readonly<OpenClawConfigurationDocument>): boolean {
  const agents = asRecord(values.agents);
  return [asRecord(agents?.defaults), ...Object.values(asRecord(agents?.entries) ?? {})].some(
    (entry) => asRecord(entry)?.model !== undefined,
  );
}

// A Driver names unsupported Configuration content the caller owns; keep that message. Other
// refusals get this fixed text; the caller is already authorized for the Agent.
export function validateAgentHarnessAuth(
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

export function validateRepositoryTopology(
  compute: ComputeDriver,
  harness: RevisionHarnessDescriptor,
  sandboxDriverId: string | undefined,
): void {
  if (compute.validateRepositoryCredentials === undefined) {
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

// Preserve the Driver's diagnostic for unsupported Configuration settings.
export function validateWorkspaceSetupTopology(
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
    throw new ResourceStateConflictError(
      sandboxDriverId === undefined
        ? "The selected Compute Driver cannot deliver initial workspace files to this Agent."
        : "The selected Compute Driver cannot deliver initial workspace files to a Harness in the selected Sandbox. Use an Agent without initialWorkspaceFiles.",
    );
  }
}

// Preserve errors for a named setting or unavailable Driver. Other refusals are permanent.
export function validateComputeAgentProvisioning(
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

export function requireDedicatedNativeSupport(
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
    // Persisted provisioning work can retry when the required Driver returns.
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
export function admitsOpenClawExecutionMode(
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
export function createModelPolicyAgent(
  sandboxDriver: () => SandboxDriver | undefined,
  nativeWorkers: NativeWorkerSupportSource | undefined,
) {
  return function modelPolicyAgent(
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
          sandbox = sandboxDriver();
        } catch (error) {
          if (error instanceof DependencyUnavailableError) {
            return true;
          }
          throw error;
        }
        return admitsOpenClawExecutionMode(sandbox, executionMode, nativeWorkers) === true;
      },
    };
  };
}

export function agentRuntimeConfiguration(
  values: Readonly<OpenClawConfigurationDocument>,
  harness: RevisionHarnessDescriptor,
  compute: ComputeDriver,
  sandbox: SandboxDriver | undefined,
  loggingLevel: LoggingLevel,
): OpenClawConfigurationDocument {
  if (harness.id === "openclaw") {
    requireSandboxOpenClawMode(sandbox, harness.mode);
  }
  const sandboxConfiguration =
    sandbox?.configureAgent !== undefined
      ? freezeConfigurationValues(
          sandbox.configureAgent(freezeConfigurationValues(values), harness),
        )
      : values;
  // Every Compute Driver renders the Gateway's document from this snapshot.
  const securedConfiguration = admitGatewaySecurityDefaults(sandboxConfiguration);
  return freezeConfigurationValues(
    compute.runtimeLogging === "driver"
      ? securedConfiguration
      : admitLoggingConfiguration(securedConfiguration, loggingLevel),
  );
}

export function createSavedAgentTopologyValidator(dependencies: AgentHarnessTopologyDependencies) {
  async function validateSavedAgentTopology(
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
    const sandbox = dependencies.sandboxDriver();
    requireSandboxExecutionMode(sandbox, agent.executionMode);
    const compute = dependencies.selectedCompute();
    if (resolveHarness === undefined || compute === undefined) {
      return;
    }
    const configuration = await readConfiguration();
    // Apply deployment's rules when a draft uses a stored Configuration.
    refuseStoredConfigurationSettings(configuration.values);
    let configuredHarnessId: string;
    try {
      configuredHarnessId = resolveConfiguredHarnessId(configuration.values);
    } catch (error) {
      // Deployment reports an unsupported Harness. Save still rejects fallbacks
      // on another provider by name.
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
      dependencies.validatePluginPlacement(agent.pluginDriver, agent.plugins, harness);
    }
    const values = agentRuntimeConfiguration(
      configuration.values,
      harness,
      compute,
      sandbox,
      dependencies.loggingLevel,
    );
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
      dependencies.validateRepositoryBrokerNetworkProxy(harness, values, sandbox);
    }
    if (agent.workspaceSetup) {
      validateWorkspaceSetupTopology(compute, harness, values, sandbox?.id);
    }
  }

  return validateSavedAgentTopology;
}

export const GATEWAY_MANAGED_MODE_UNSUPPORTED =
  "Agent setting gatewayManagedMode is not supported by the selected Compute Driver.";
