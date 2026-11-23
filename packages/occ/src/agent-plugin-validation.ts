import { isDeepStrictEqual } from "node:util";
import {
  normalizePluginApprovers,
  normalizePluginDesiredState,
  pluginRuntimeHarnessRequirement,
  type StoredCredentialSource,
  type HarnessAuthBinding,
  type OpenClawConfigurationDocument,
  type PluginApprovers,
  type PluginDesiredState,
  type PluginDriver,
  type PluginDriverIdentity,
  type PluginCredentialSource,
  type RevisionHarnessDescriptor,
} from "@openclaw-enterprise/contracts";
import { resolveConfiguredHarnessId } from "./configured-harness.ts";
import {
  ConfigurationHarnessError,
  PluginPolicyValidationError,
  ResourceStateConflictError,
} from "./errors.ts";
import {
  credentialSourceMetadata,
  oauthCredentialSourceMetadata,
} from "./credential-source-metadata.ts";
import type { PlatformReadView } from "./ports/platform-read-view.ts";

interface AgentPluginValidationDependencies {
  readonly pluginDriver: (harnessId: string, forConfiguration: boolean) => PluginDriver;
  readonly computeImplementation: () => string;
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
): void {
  try {
    driver.validatePolicies(plugins ?? {}, approvers);
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
  state: PlatformReadView,
  driver: PluginDriver | undefined,
  plugins: PluginDesiredState | undefined,
  sources: readonly StoredCredentialSource[],
  harnessAuth?: HarnessAuthBinding | null,
): Promise<void> {
  if (plugins && Object.keys(plugins).length) {
    await driver?.credentials?.validate(
      plugins,
      await pluginCredentialSources(state, sources),
      harnessAuth?.method === "credential_source" ? harnessAuth.sourceId : undefined,
    );
  }
}

/** Only canonical, Template-backed Sources can qualify for a managed plugin slot. */
export async function pluginCredentialSources(
  state: PlatformReadView,
  sources: readonly StoredCredentialSource[],
): Promise<readonly PluginCredentialSource[]> {
  const choices: PluginCredentialSource[] = [];
  for (const source of sources) {
    if (
      source.ownerCapability !== "token_service" ||
      source.state !== "ready" ||
      !source.connectionTemplateId ||
      (source.type === "oauth2-refresh-token" &&
        (source.consent.kind !== "connection_template" ||
          source.consent.revokedAt !== undefined ||
          source.consent.revocationRequestedBy !== undefined))
    ) {
      continue;
    }
    const template = await state.connectionTemplates.findConnectionTemplate(
      source.connectionTemplateId,
    );
    if (
      !template ||
      (template.namespaceId !== undefined && template.namespaceId !== source.namespaceId)
    ) {
      continue;
    }
    try {
      const metadata =
        source.type === "static"
          ? credentialSourceMetadata(source)
          : await oauthCredentialSourceMetadata(state, source);
      choices.push({ ...metadata, currentTemplate: template.current });
    } catch (error) {
      if (!(error instanceof ResourceStateConflictError)) {
        throw error;
      }
    }
  }
  return choices;
}

export function createAgentPluginValidation(dependencies: AgentPluginValidationDependencies) {
  async function validateAgentPlugins(
    plugins: PluginDesiredState | undefined,
    approvers: PluginApprovers | undefined,
    readValues: () =>
      Readonly<OpenClawConfigurationDocument> | Promise<Readonly<OpenClawConfigurationDocument>>,
    previous?: {
      readonly plugins?: PluginDesiredState;
      readonly pluginDriver?: PluginDriverIdentity;
    },
    source: "request" | "stored" = "request",
  ): Promise<PluginDriver | undefined> {
    const hasSelections = plugins !== undefined && Object.keys(plugins).length > 0;
    if (!hasSelections && !approvers?.length) {
      return undefined;
    }
    const values = await readValues();
    const driver = dependencies.pluginDriver(resolveConfiguredHarnessId(values), true);
    if (hasSelections) {
      pluginOwner(driver, previous);
    }
    validatePluginSettings(driver, plugins, approvers, values, source);
    return driver;
  }

  function validatePluginPlacement(
    driver: PluginDriver,
    plugins: PluginDesiredState | undefined,
    harness: Readonly<Pick<RevisionHarnessDescriptor, "id" | "mode">>,
  ): void {
    if (plugins === undefined || Object.keys(plugins).length === 0) {
      return;
    }
    driver.validatePlacement?.(plugins, harness, dependencies.computeImplementation());
    const required = pluginRuntimeHarnessRequirement(driver.implementation, harness);
    if (required !== undefined) {
      throw new ConfigurationHarnessError(
        `The Installation's Plugin Driver runs plugins only in ${required}: remove the Agent's plugins, or change its Configuration or execution mode to a Harness that runs them.`,
      );
    }
  }

  return { validateAgentPlugins, validatePluginPlacement };
}
