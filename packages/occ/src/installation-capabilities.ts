import { admitsOpenClawExecutionMode } from "./agent-harness-topology.ts";
import type {
  CredentialSourceType,
  HarnessExecutionMode,
  Installation,
  InstallationCapabilities,
  PluginDriver,
  SandboxDriver,
  TokenServiceDriver,
} from "@openclaw-enterprise/contracts";
import { HARNESS_EXECUTION_MODES } from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import { ConfigurationHarnessError, DependencyUnavailableError } from "./errors.ts";
import type { NativeWorkerSupportSource } from "./native-worker-support.ts";
import { exactNamespace, namespaceIdentity } from "./resource-scope.ts";

interface InstallationCapabilityDependencies {
  readonly protectedSourceTypes: () => readonly CredentialSourceType[];
  readonly enabledPluginDrivers: () => readonly PluginDriver[];
  readonly sandboxDriver: () => SandboxDriver | undefined;
  readonly tokenServiceDriver: () => TokenServiceDriver | undefined;
  readonly modelCredentialSourcePresets: () => InstallationCapabilities["modelCredentialSourcePresets"];
}

async function readInstallationCapabilities(
  installation: Readonly<Installation>,
  nativeWorkerSupport: NativeWorkerSupportSource | undefined,
  dependencies: InstallationCapabilityDependencies,
): Promise<InstallationCapabilities> {
  // Report dedicated native worker support only when admission allows that execution mode.
  // sandboxDriverUnavailable distinguishes a temporary outage from an unsupported mode.
  const {
    nativeWorkers: _unchecked,
    openclaw: _derived,
    pluginCatalogs: _catalogs,
    deviceAuthorization: _deviceAuthorization,
    modelCredentialSourcePresets: _modelCredentialSourcePresets,
    ...declared
  } = installation.capabilities ?? {};
  const openclaw = openClawExecutionModes(nativeWorkerSupport, dependencies.sandboxDriver);
  const nativeWorkers = openclaw.executionModes.includes("dedicated")
    ? nativeWorkerSupport
    : undefined;
  const types = dependencies.protectedSourceTypes();
  const capabilities = {
    ...declared,
    ...(nativeWorkers === undefined ? {} : { nativeWorkers: { support: nativeWorkers } }),
    openclaw,
    ...(types.length > 0 ? { credentialSources: { types } } : {}),
  };
  const catalogs = dependencies.enabledPluginDrivers().map((driver) => ({
    harnessId: driver.harnessId,
    pluginPolicies: {
      driver: { id: driver.id, implementation: driver.implementation },
      ...driver.policyCapabilities,
    },
    ...(driver.discoverCatalog && driver.getCatalogPlugin
      ? { pluginDiscovery: { credential: driver.discoveryCredential ?? "required" } }
      : {}),
  }));
  const owner = dependencies.tokenServiceDriver();
  const deviceAuthorization =
    typeof owner?.startDeviceAuthorization === "function" &&
    typeof owner.pollDeviceAuthorization === "function";
  const modelCredentialSourcePresets = dependencies.modelCredentialSourcePresets();
  return {
    ...capabilities,
    ...(modelCredentialSourcePresets?.length ? { modelCredentialSourcePresets } : {}),
    ...(deviceAuthorization ? { deviceAuthorization: true as const } : {}),
    ...(catalogs.length > 0 ? { pluginCatalogs: catalogs } : {}),
  };
}

/**
 * The OpenClaw execution modes this Installation's Sandbox Driver and runtime let an Agent
 * deploy. A selected Sandbox Driver that is unavailable admits none until it returns.
 */
function openClawExecutionModes(
  nativeWorkerSupport: NativeWorkerSupportSource | undefined,
  sandboxDriver: InstallationCapabilityDependencies["sandboxDriver"],
): {
  executionModes: HarnessExecutionMode[];
  settingRefusals?: Partial<Record<HarnessExecutionMode, string>>;
  sandboxDriverUnavailable?: true;
} {
  let sandbox: SandboxDriver | undefined;
  try {
    sandbox = sandboxDriver();
  } catch (error) {
    if (error instanceof DependencyUnavailableError) {
      return { executionModes: [], sandboxDriverUnavailable: true };
    }
    throw error;
  }
  const executionModes: HarnessExecutionMode[] = [];
  const settingRefusals: Partial<Record<HarnessExecutionMode, string>> = {};
  for (const mode of HARNESS_EXECUTION_MODES) {
    const admission = admitsOpenClawExecutionMode(sandbox, mode, nativeWorkerSupport);
    if (admission === true) {
      executionModes.push(mode);
    } else if (
      mode === "dedicated" &&
      admission instanceof ConfigurationHarnessError &&
      sandbox?.supportsHarnessExecutionMode.openclaw[mode].reason !== undefined
    ) {
      // Report the admission message when a Sandbox setting prevents dedicated execution.
      settingRefusals[mode] = admission.message;
    }
  }
  return {
    executionModes,
    ...(Object.keys(settingRefusals).length ? { settingRefusals } : {}),
  };
}

interface InstallationCapabilityQueryDependencies extends InstallationCapabilityDependencies {
  readonly installation: Readonly<Installation>;
  readonly nativeWorkers: NativeWorkerSupportSource | undefined;
  readonly authority: Pick<ControllerAuthority, "authorize">;
  readonly transactions: Pick<ControllerTransactions, "read">;
}

export function createInstallationCapabilityQueries(
  dependencies: InstallationCapabilityQueryDependencies,
) {
  const readCapabilities = () =>
    readInstallationCapabilities(
      dependencies.installation,
      dependencies.nativeWorkers,
      dependencies,
    );

  async function getInstallation(principalId: string): Promise<Readonly<Installation>> {
    await dependencies.authority.authorize(principalId, "read", {
      kind: "installation",
      id: dependencies.installation.id,
    });
    return immutableCopy({ ...dependencies.installation, capabilities: await readCapabilities() });
  }

  /**
   * The capabilities Agent creation in a Namespace needs, for a caller who may create Agents
   * there but cannot read the Installation, such as a Default user (RFC-0026). Browser access
   * is available to resource owners; guided provisioning still requires Installation administration.
   */
  async function getNamespaceAgentCapabilities(
    principalId: string,
    namespaceId: string,
  ): Promise<Readonly<Omit<InstallationCapabilities, "agentProvisioning">>> {
    namespaceIdentity(namespaceId);
    await dependencies.authority.authorize(principalId, "create", {
      kind: "agent",
      namespaceId,
      id: namespaceId,
    });
    await dependencies.transactions.read((state) => exactNamespace(state, namespaceId));
    const { agentProvisioning: _administratorOnly, ...capabilities } = await readCapabilities();
    return immutableCopy(capabilities);
  }

  return { getInstallation, getNamespaceAgentCapabilities };
}
