import { isDeepStrictEqual } from "node:util";
import {
  normalizePluginApprovers,
  normalizePluginDesiredState,
  importedPluginDigest,
  pluginRuntimeHarnessRequirement,
  type CredentialSource,
  type HarnessAuthBinding,
  type InspectedPluginPackage,
  type OpenClawConfigurationDocument,
  type PluginApprovers,
  type PluginDesiredState,
  type PluginDriver,
  type PluginDriverIdentity,
  type RevisionHarnessDescriptor,
} from "@openclaw-enterprise/contracts";
import { resolveConfiguredHarnessId } from "./configured-harness.ts";
import {
  ConfigurationHarnessError,
  PluginPolicyValidationError,
  ResourceStateConflictError,
} from "./errors.ts";
import type { ControllerAuthority } from "./controller-authority.ts";
import type { PlatformReadView } from "./ports/platform-read-view.ts";

interface AgentPluginValidationDependencies {
  readonly authority: Pick<ControllerAuthority, "authorize">;
  readonly pluginDriver: (harnessId: string, forConfiguration: boolean) => PluginDriver;
  readonly computeImplementation: () => string;
  readonly sandboxImplementation: () => string | undefined;
  readonly credentialGatewayImplementation: () => string | undefined;
}

function invalidPluginRequest(): never {
  throw new PluginPolicyValidationError();
}

export function normalizeAgentPlugins(
  plugins: PluginDesiredState | undefined,
): PluginDesiredState | undefined {
  return normalizePluginDesiredState(plugins, invalidPluginRequest);
}

export function normalizeAgentPluginApprovers(approvers: unknown): PluginApprovers | undefined {
  return normalizePluginApprovers(approvers, invalidPluginRequest);
}

export function pluginOwner(
  driver: PluginDriver,
  previous?: {
    readonly plugins?: PluginDesiredState;
    readonly pluginDriver?: PluginDriverIdentity;
  },
): PluginDriverIdentity {
  const identity = { id: driver.id, implementation: driver.implementation };
  if (
    previous?.plugins &&
    Object.keys(previous.plugins).length > 0 &&
    !isDeepStrictEqual(previous.pluginDriver, identity)
  ) {
    throw new ConfigurationHarnessError(
      "Clear the Agent's existing plugin selections before switching Plugin Drivers.",
    );
  }
  return identity;
}

export function validatePluginSettings(
  driver: PluginDriver,
  plugins: PluginDesiredState | undefined,
  approvers: PluginApprovers | undefined,
  values: Readonly<OpenClawConfigurationDocument>,
  source: "request" | "stored",
  releases?: Readonly<Record<string, InspectedPluginPackage>>,
): void {
  try {
    driver.validatePolicies(plugins ?? {}, approvers, releases);
  } catch (error) {
    if (source === "stored" && error instanceof PluginPolicyValidationError) {
      throw error.withoutRequestPath();
    }
    throw error;
  }
  if (plugins && Object.keys(plugins).length > 0) {
    try {
      driver.validateAgentConfiguration?.(plugins, values);
    } catch (error) {
      if (error instanceof ConfigurationHarnessError) {
        throw error;
      }
      throw new ResourceStateConflictError(
        "The selected Plugin Driver cannot run these plugin selections with this Configuration.",
      );
    }
  }
}

export async function validatePluginCredentialSources(
  driver: PluginDriver | undefined,
  plugins: PluginDesiredState | undefined,
  sources: readonly CredentialSource[],
  harnessAuth?: HarnessAuthBinding | null,
  releases?: Readonly<Record<string, InspectedPluginPackage>>,
): Promise<void> {
  if (plugins && Object.keys(plugins).length) {
    await driver?.credentials?.validate(
      plugins,
      sources,
      harnessAuth?.method === "credential_source" ? harnessAuth.sourceId : undefined,
      releases,
    );
  }
}

export function createAgentPluginValidation(dependencies: AgentPluginValidationDependencies) {
  async function selectedNamespacePluginReleases(
    state: PlatformReadView,
    namespaceId: string,
    principalId: string,
    driver: PluginDriver,
    plugins: PluginDesiredState | undefined,
  ): Promise<Readonly<Record<string, InspectedPluginPackage>>> {
    const releases: Record<string, InspectedPluginPackage> = {};
    let authorized = false;
    for (const id of Object.keys(plugins ?? {})) {
      const digest = importedPluginDigest(id);
      if (!digest) {
        continue;
      }
      if (!authorized) {
        await dependencies.authority.authorize(principalId, "read", {
          kind: "namespace",
          id: namespaceId,
          namespaceId,
        });
        authorized = true;
      }
      const release = await state.pluginReleases.find(namespaceId, digest);
      if (!release || !driver.inspectPackage) {
        throw new ConfigurationHarnessError(
          "The imported plugin release is unavailable in this Namespace.",
        );
      }
      releases[id] = release;
    }
    return releases;
  }

  async function validateAgentPlugins(
    state: PlatformReadView,
    namespaceId: string,
    principalId: string,
    plugins: PluginDesiredState | undefined,
    approvers: PluginApprovers | undefined,
    readValues: () =>
      Readonly<OpenClawConfigurationDocument> | Promise<Readonly<OpenClawConfigurationDocument>>,
    previous?: {
      readonly plugins?: PluginDesiredState;
      readonly pluginDriver?: PluginDriverIdentity;
    },
    source: "request" | "stored" = "request",
  ): Promise<{
    driver: PluginDriver | undefined;
    releases: Readonly<Record<string, InspectedPluginPackage>> | undefined;
  }> {
    const hasSelections = plugins !== undefined && Object.keys(plugins).length > 0;
    if (!hasSelections && !approvers?.length) {
      return { driver: undefined, releases: undefined };
    }
    const values = await readValues();
    const driver = dependencies.pluginDriver(resolveConfiguredHarnessId(values), true);
    if (hasSelections) {
      pluginOwner(driver, previous);
    }
    const releases = await selectedNamespacePluginReleases(
      state,
      namespaceId,
      principalId,
      driver,
      plugins,
    );
    validatePluginSettings(driver, plugins, approvers, values, source, releases);
    return { driver, releases };
  }

  function validatePluginPlacement(
    driver: PluginDriver,
    plugins: PluginDesiredState | undefined,
    harness: Readonly<Pick<RevisionHarnessDescriptor, "id" | "mode">>,
  ): void {
    if (plugins === undefined || Object.keys(plugins).length === 0) {
      return;
    }
    driver.validatePlacement?.(plugins, harness, dependencies.computeImplementation(), {
      sandbox: dependencies.sandboxImplementation(),
      gateway: dependencies.credentialGatewayImplementation(),
    });
    const required = pluginRuntimeHarnessRequirement(driver.implementation, harness);
    if (required !== undefined) {
      throw new ConfigurationHarnessError(
        `The Installation's Plugin Driver runs plugins only in ${required}: remove the Agent's plugins, or change its Configuration or execution mode to a Harness that runs them.`,
      );
    }
  }

  return { validateAgentPlugins, validatePluginPlacement, selectedNamespacePluginReleases };
}
