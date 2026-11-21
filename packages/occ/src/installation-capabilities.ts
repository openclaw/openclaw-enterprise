import type {
  CredentialSourceType,
  HarnessExecutionMode,
  Installation,
  InstallationCapabilities,
  PluginDriver,
  SandboxDriver,
} from "@openclaw-enterprise/contracts";
import { HARNESS_EXECUTION_MODES } from "@openclaw-enterprise/contracts";
import { ConfigurationHarnessError, DependencyUnavailableError } from "./errors.ts";
import type { NativeWorkerSupportSource } from "./native-worker-support.ts";

interface InstallationCapabilityDependencies {
  readonly readGatewaySourceTypes: () => Promise<readonly CredentialSourceType[]> | undefined;
  readonly protectedSourceTypes: () => readonly CredentialSourceType[];
  readonly allowsGatewaySourceType: (sourceType: CredentialSourceType) => boolean;
  readonly enabledPluginDrivers: () => readonly PluginDriver[];
  readonly sandboxDriver: () => SandboxDriver | undefined;
  readonly admitOpenClawExecutionMode: (
    sandbox: SandboxDriver | undefined,
    executionMode: HarnessExecutionMode,
    nativeWorkerSupport: NativeWorkerSupportSource | undefined,
  ) => true | Error;
}

export async function readInstallationCapabilities(
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
    ...declared
  } = installation.capabilities ?? {};
  const openclaw = openClawExecutionModes(nativeWorkerSupport, dependencies);
  const nativeWorkers = openclaw.executionModes.includes("dedicated")
    ? nativeWorkerSupport
    : undefined;
  // Without a Gateway, read the remaining selections in the same turn.
  const gatewayTypeRead = dependencies.readGatewaySourceTypes();
  const gatewayTypes = gatewayTypeRead === undefined ? undefined : await gatewayTypeRead;
  const protectedTypes = dependencies.protectedSourceTypes();
  const types = [
    ...protectedTypes,
    ...(gatewayTypes ?? []).filter(
      (type) =>
        !protectedTypes.some((p) => p.type === type.type) &&
        dependencies.allowsGatewaySourceType(type),
    ),
  ];
  const capabilities = {
    ...declared,
    ...(nativeWorkers === undefined ? {} : { nativeWorkers: { support: nativeWorkers } }),
    openclaw,
    ...(gatewayTypes || types.length ? { credentialSources: { types } } : {}),
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
  return {
    ...capabilities,
    ...(catalogs.length > 0 ? { pluginCatalogs: catalogs } : {}),
  };
}

/**
 * The OpenClaw execution modes this Installation's Sandbox Driver and runtime let an Agent
 * deploy. A selected Sandbox Driver that is unavailable admits none until it returns.
 */
function openClawExecutionModes(
  nativeWorkerSupport: NativeWorkerSupportSource | undefined,
  dependencies: Pick<
    InstallationCapabilityDependencies,
    "sandboxDriver" | "admitOpenClawExecutionMode"
  >,
): {
  executionModes: HarnessExecutionMode[];
  settingRefusals?: Partial<Record<HarnessExecutionMode, string>>;
  sandboxDriverUnavailable?: true;
} {
  let sandbox: SandboxDriver | undefined;
  try {
    sandbox = dependencies.sandboxDriver();
  } catch (error) {
    if (error instanceof DependencyUnavailableError) {
      return { executionModes: [], sandboxDriverUnavailable: true };
    }
    throw error;
  }
  const executionModes: HarnessExecutionMode[] = [];
  const settingRefusals: Partial<Record<HarnessExecutionMode, string>> = {};
  for (const mode of HARNESS_EXECUTION_MODES) {
    const admission = dependencies.admitOpenClawExecutionMode(sandbox, mode, nativeWorkerSupport);
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
