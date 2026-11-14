import { InstalledDriver, installedDriverReference } from "@openclaw-enterprise/occ";
import { asRecord } from "@openclaw-enterprise/utils";
import { isDeepStrictEqual } from "node:util";
import type {
  ComputeDriver,
  ConfigurationDriver,
  DriverImplementation,
  DriverRegistration,
  IAMDriver,
  SandboxDriver,
} from "@openclaw-enterprise/contracts";
import type { NativeIAMStateStore } from "@openclaw-enterprise/iam";
import { currentComputeAbortSignal } from "../drivers/compute/operation-context.ts";
import type { SelectedDriverConfiguration } from "./installation-selection.ts";
import { InstallationFieldError, type ConfigurationRecord } from "./installation-fields.ts";
import { resolveDriverPackage } from "./driver-package-resolution.ts";
import { externalProtectedDriverSelection } from "./external-protected-driver-selection.ts";

interface ExternalDriverModule extends DriverImplementation {
  createDriver(options: {
    readonly id: string;
    readonly implementation: string;
    readonly configuration: ConfigurationRecord;
    readonly platformState?: NativeIAMStateStore;
    readonly getOperationAbortSignal?: () => AbortSignal | undefined;
  }): unknown;
}

interface LoadedDriverPackage {
  readonly module: ExternalDriverModule;
  readonly implementation: string;
}

export async function loadDriverPackage(
  selection: ConfigurationRecord,
  capability: "configuration" | "iam" | "compute" | "sandbox",
  packageRoot: string,
  allowFixtureTarball: boolean,
): Promise<LoadedDriverPackage | undefined> {
  const resolved = await resolveDriverPackage(
    selection,
    capability,
    packageRoot,
    allowFixtureTarball,
  );
  if (resolved === undefined) {
    return undefined;
  }
  const path = `drivers.${capability}`;
  let imported: unknown;
  try {
    imported = await import(resolved.entryUrl.href);
  } catch {
    throw new Error(`${path}.package failed to load its compiled Driver module.`);
  }
  const module = asRecord(imported);
  if (module === undefined) {
    throw new Error(`${path}.package exports must be one object.`);
  }
  if (
    typeof module.validateConfiguration !== "function" ||
    typeof module.createDriver !== "function"
  ) {
    throw new Error(`${path}.package must export Driver validation and a factory.`);
  }
  if (asRecord(module.configurationSchema) === undefined) {
    throw new Error(`${path}.configurationSchema must be one object.`);
  }
  return Object.freeze({
    module: module as unknown as ExternalDriverModule,
    implementation: resolved.implementation,
  });
}

export function createExternalDriver(
  implementation: ExternalDriverModule,
  selection: SelectedDriverConfiguration,
  capability: "configuration" | "iam" | "compute" | "sandbox",
  platformState?: NativeIAMStateStore,
): ConfigurationDriver | IAMDriver | ComputeDriver | SandboxDriver {
  if (capability === "iam" && typeof platformState?.loadNativeIAMState !== "function") {
    throw new Error("drivers.iam factory requires platform state.");
  }
  const created = asRecord(
    implementation.createDriver({
      id: selection.id,
      implementation: selection.implementation,
      configuration: selection.configuration,
      ...(platformState === undefined ? {} : { platformState }),
      ...(capability === "compute" ? { getOperationAbortSignal: currentComputeAbortSignal } : {}),
    }),
  );
  if (created === undefined) {
    throw new Error(`drivers.${capability} factory result must be one object.`);
  }
  if (
    created.capability !== capability ||
    created.id !== selection.id ||
    created.implementation !== selection.implementation
  ) {
    throw new Error(`drivers.${capability} factory returned an unselected Driver identity.`);
  }
  const methods =
    capability === "configuration"
      ? ["create", "read", "update", "delete", "validate"]
      : capability === "iam"
        ? ["lookupIdentity", "authorize"]
        : capability === "compute"
          ? [
              "ensureNamespace",
              "deleteNamespace",
              "prepareRevision",
              "stopRevision",
              "retireRevision",
            ]
          : ["cleanup"];
  if (methods.some((method) => typeof created[method] !== "function")) {
    throw new Error(`drivers.${capability} factory returned an invalid Driver contract.`);
  }
  if (
    capability === "sandbox" &&
    ((created.ensureNamespace !== undefined && typeof created.ensureNamespace !== "function") ||
      (created.provisionHarness !== undefined && typeof created.provisionHarness !== "function"))
  ) {
    throw new Error("drivers.sandbox factory returned invalid optional lifecycle hooks.");
  }
  if (
    capability === "compute" &&
    created.setLifecycleDrivers !== undefined &&
    typeof created.setLifecycleDrivers !== "function"
  ) {
    throw new Error("drivers.compute factory returned invalid lifecycle Driver wiring.");
  }
  return created as unknown as ConfigurationDriver | IAMDriver | ComputeDriver | SandboxDriver;
}

/** Load one package instance for the selected capabilities; the sandbox selection owns its configuration. */
export async function createExternalProtectedDriver(
  implementation: ExternalDriverModule,
  selection: SelectedDriverConfiguration,
  options: {
    // Composition that changes the installed authority must also change its durable identity.
    readonly repositoryAuthorityIdentity: string | undefined;
    readonly requireRepositoryGitTransport: boolean;
    readonly remoteConfiguration?: ConfigurationRecord;
  },
): Promise<InstalledDriver> {
  const { id, configuration } = selection;
  const { repositoryAuthorityIdentity, remoteConfiguration } = options;
  const ownerSelection = externalProtectedDriverSelection(selection, repositoryAuthorityIdentity);
  // Compare the values as well as the hash. A Driver could replace a plain
  // object with a value that has the same canonical JSON representation.
  const matchesRemoteConfiguration = () =>
    remoteConfiguration === undefined || isDeepStrictEqual(configuration, remoteConfiguration);
  const expectedRef =
    remoteConfiguration === undefined ? undefined : installedDriverReference(ownerSelection);
  const changedRemoteConfiguration = () =>
    new InstallationFieldError([
      {
        path: "/drivers/sandbox/configuration",
        code: "INVALID_VALUE",
        message: "The external Driver changed its configuration for a remote prepared Git issuer.",
      },
    ]);
  if (!matchesRemoteConfiguration()) {
    throw changedRemoteConfiguration();
  }
  const registration = asRecord(
    implementation.createDriver({ id, configuration, implementation: selection.implementation }),
  );
  let owner: InstalledDriver | undefined;
  try {
    if (!registration || !asRecord(registration.capabilities)) {
      throw new Error(
        "The selected package must return one Driver registration for Sandbox and Credential Proxy.",
      );
    }
    owner = new InstalledDriver(ownerSelection, registration as unknown as DriverRegistration);
    if (
      !matchesRemoteConfiguration() ||
      (expectedRef !== undefined && !isDeepStrictEqual(owner.ref, expectedRef))
    ) {
      throw changedRemoteConfiguration();
    }
    owner.require("sandbox");
    owner.require("credential_proxy");
    if (options.requireRepositoryGitTransport) {
      owner.requireRepositoryGitTransport();
    }
    return owner;
  } catch (error) {
    let cleanupFailure: { error: unknown } | undefined;
    try {
      if (owner !== undefined) {
        await owner.close();
      } else if (typeof registration?.close === "function") {
        await registration.close();
      }
    } catch (cleanupError) {
      cleanupFailure = { error: cleanupError };
    }
    if (cleanupFailure !== undefined) {
      throw new AggregateError(
        [error, cleanupFailure.error],
        "The external Driver registration was refused and its owner failed to close.",
        { cause: error },
      );
    }
    throw error;
  }
}
