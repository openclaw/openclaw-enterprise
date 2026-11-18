import { requireManagedCredentialRuntime } from "./managed-runtime.ts";
import { type ErrorDetail } from "@openclaw-enterprise/contracts";
import {
  CODEX_PLUGIN_DRIVER_IMPLEMENTATION,
  OPENCLAW_PLUGIN_DRIVER_IMPLEMENTATION,
  requireConfiguration,
} from "@openclaw-enterprise/contracts";
import {
  managedCliCredentialBindings,
  managedInstalls,
  managedPluginCredentials,
  managedMcpCredentialBindings,
} from "./managed-catalog.ts";
import { deepFreeze, immutableCopy } from "@openclaw-enterprise/utils";
import {
  type JSONSchema,
  type RevisionHarnessDescriptor,
  type PluginCatalogEntry,
  type PluginCatalogPage,
  type PluginDiscoveryAuthentication,
  type PluginDriver,
  type PluginDesiredState,
  type PluginApprovers,
  type PluginPolicyCapabilities,
  type PluginDriverContext,
  type PluginDriverIdentity,
  type OpenClawConfigurationDocument,
} from "@openclaw-enterprise/contracts";
import {
  ConfigurationHarnessError,
  NotImplementedError,
  PluginPolicyValidationError,
  resolveConfiguredHarnessId,
  ScopeViolationError,
} from "@openclaw-enterprise/occ";
import {
  hasAliasedSelections,
  openClawCatalogEntries,
  openClawManagedPluginIds,
  validatePolicies,
} from "./runtime-translator.ts";
import { discoverHostedPlugins, getHostedPlugin } from "./hosted-catalog.ts";
import { deniedOpenClawSelection, openClawToolDenialMessage } from "./openclaw-tool-denial.ts";
import {
  openClawPluginSettingConflict,
  openClawPluginSettingMessage,
} from "./openclaw-plugin-settings.ts";
import { validateCodexAutomaticReviewerPolicy } from "../../gateway/codex-approval-policy.ts";

type ConfigurationRecord = Readonly<Record<string, unknown>>;

interface PluginDriverSelection {
  readonly id?: string;
  readonly implementation?: string;
}

type BundledCatalogEntry = PluginCatalogEntry;

export class PluginValidationError extends ScopeViolationError {}

// Whether the Configuration's models select the OpenClaw Harness. A model policy no deployment
// accepts is the Configuration's own refusal, named by the rules that check it.
function openClawHarnessConfiguration(
  configuration: Readonly<OpenClawConfigurationDocument>,
): boolean {
  try {
    return resolveConfiguredHarnessId(configuration) === "openclaw";
  } catch (error) {
    if (error instanceof ConfigurationHarnessError) {
      return false;
    }
    throw error;
  }
}

const OCC_DRIVER_ID = "occ-plugin";
const OCC_IMPLEMENTATION = OPENCLAW_PLUGIN_DRIVER_IMPLEMENTATION;
const CODEX_DRIVER_ID = "codex-plugin";
const CODEX_IMPLEMENTATION = CODEX_PLUGIN_DRIVER_IMPLEMENTATION;

const EMPTY_CONFIGURATION_SCHEMA: JSONSchema = deepFreeze({
  type: "object",
  additionalProperties: false,
  properties: {},
});

const CODEX_POLICY_SCHEMA: JSONSchema = deepFreeze({
  type: "object",
  additionalProperties: false,
  properties: {
    destructiveEnabled: {
      type: "boolean",
      title: "Destructive tools",
      description:
        "Whether destructive tools are enabled by default. Explicit tool enablement overrides this default. Leave toolDefaults.enabled unset when using this setting.",
    },
  },
});

const OCC_CATALOG: readonly BundledCatalogEntry[] = deepFreeze(openClawCatalogEntries());

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PluginValidationError(`${path} must be a nonempty string.`);
  }
  return value;
}

function sameDriver(left: PluginDriverIdentity, right: PluginDriverIdentity): boolean {
  return left.id === right.id && left.implementation === right.implementation;
}

function ensureHarness(
  context: PluginDriverContext,
  harnessId: string,
  mode: "embedded" | "dedicated",
): void {
  if (context.harness.id !== harnessId || context.harness.mode !== mode) {
    throw notImplemented(
      "plugin-harness-mismatch",
      "The selected Plugin Driver does not match the Harness.",
    );
  }
}

function notImplemented(operation: string, message: string): NotImplementedError {
  return new NotImplementedError(operation, message);
}

class BundledPluginDriverBase {
  readonly capability = "plugin" as const;
  readonly id: string;
  readonly implementation: string;

  protected constructor(selection: PluginDriverSelection, defaults: PluginDriverIdentity) {
    this.id = requiredString(selection.id ?? defaults.id, "Plugin Driver ID");
    this.implementation = selection.implementation ?? defaults.implementation;
    if (!sameDriver(this, defaults)) {
      throw new PluginValidationError("Unsupported bundled Plugin Driver identity.");
    }
  }

  protected validate(
    kind: "codex" | "openclaw",
    selections: PluginDesiredState,
    defaultApprovers?: PluginApprovers,
  ): void {
    try {
      validatePolicies(kind, selections, defaultApprovers);
    } catch (error) {
      const field =
        error instanceof Error && "policyField" in error ? error.policyField : undefined;
      if (field === "pluginId") {
        const pluginId =
          error instanceof Error && "pluginId" in error && typeof error.pluginId === "string"
            ? error.pluginId
            : undefined;
        throw new PluginPolicyValidationError("unknownPlugin", this.id, pluginId);
      }
      throw new PluginPolicyValidationError(
        field === "toolDefaults.reviewer" ||
          field === "tools[id].reviewer" ||
          field === "conflictingEnablementDefaults"
          ? field
          : undefined,
      );
    }
    // Admission-only, like the Codex approvers check: revisions admitted before this
    // check keep rendering unchanged. An Agent or in-flight provisioning record that
    // holds both keys is refused at its next create replay, update, deploy, or resume.
    if (hasAliasedSelections(kind, selections)) {
      throw new PluginPolicyValidationError("aliasedPlugin");
    }
  }

  protected catalog(catalog: readonly BundledCatalogEntry[]): readonly PluginCatalogEntry[] {
    return immutableCopy(catalog) as readonly PluginCatalogEntry[];
  }
}

function splitOpenClawSelections(selections: PluginDesiredState) {
  const managed = managedInstalls.filter(({ id }) => Object.hasOwn(selections, id));
  const native = { ...selections };
  for (const { id } of managed) {
    delete native[id];
  }
  return { managed, native };
}

export class OCCPluginDriver extends BundledPluginDriverBase implements PluginDriver {
  readonly harnessId = "openclaw" as const;
  readonly discoveryCredential = "none" as const;
  readonly credentials = managedPluginCredentials;
  static readonly configurationSchema = EMPTY_CONFIGURATION_SCHEMA;
  readonly policyCapabilities: PluginPolicyCapabilities = deepFreeze({
    policyScopeByPlugin: Object.fromEntries(
      managedInstalls.map((pkg) => [pkg.id, pkg.policyScope]),
    ),
    approvers: { agent: true, plugin: true, tools: true },
    toolDefaults: { enabled: true, approval: ["provider_default", "none"], reviewer: [] },
    tools: { enabled: true, approval: ["provider_default", "none"], reviewer: [] },
    driverPolicySchema: EMPTY_CONFIGURATION_SCHEMA,
  });

  validatePolicies(selections: PluginDesiredState, defaultApprovers?: PluginApprovers): void {
    const { managed, native } = splitOpenClawSelections(selections);
    this.validate("openclaw", native, defaultApprovers);
    for (const pkg of managed) {
      const policy = selections[pkg.id]!;
      if (
        typeof policy.enabled !== "boolean" ||
        Object.keys(policy).some((key) => key !== "enabled" && key !== "driverPolicy")
      ) {
        throw new ConfigurationHarnessError(
          `The ${pkg.entry.name} package supports enablement and an optional credential slot.`,
        );
      }
    }
    managedCliCredentialBindings(selections);
    managedMcpCredentialBindings(selections);
  }

  static validateConfiguration(): readonly ErrorDetail[] {
    return [];
  }

  constructor(configuration: ConfigurationRecord = {}, selection: PluginDriverSelection = {}) {
    requireConfiguration(OCCPluginDriver, configuration);
    super(selection, { id: OCC_DRIVER_ID, implementation: OCC_IMPLEMENTATION });
  }

  async listCatalog(context: PluginDriverContext): Promise<readonly PluginCatalogEntry[]> {
    const packages = managedInstalls.filter(
      ({ placement }) =>
        context.harness.id === placement.harnessId && context.harness.mode === placement.mode,
    );
    if (packages.length > 0) {
      return this.catalog(packages.map((pkg) => pkg.entry));
    }
    ensureHarness(context, this.harnessId, "embedded");
    return this.catalog(OCC_CATALOG);
  }

  async discoverCatalog(input: {
    readonly q?: string;
    readonly cursor?: string;
  }): Promise<PluginCatalogPage> {
    const q = input.q?.toLowerCase() ?? "";
    const plugins = input.cursor
      ? []
      : managedInstalls
          .map((pkg) => pkg.entry)
          .filter(({ id, name, description }) =>
            [id, name, description].some((value) => value.toLowerCase().includes(q)),
          );
    return { plugins: this.catalog(plugins), nextCursor: null };
  }

  async getCatalogPlugin(input: { readonly pluginId: string }): Promise<PluginCatalogEntry> {
    const pkg = managedInstalls.find(({ id }) => id === input.pluginId);
    if (!pkg) {
      // An unknown ID is the caller's error (finding 2790); name the versioned package ID
      // when the caller left out the version and exactly one package matches.
      const versioned = managedInstalls.filter(({ id }) => id.startsWith(`${input.pluginId}@`));
      throw new PluginPolicyValidationError(
        "unknownPlugin",
        this.id,
        input.pluginId,
        versioned.length === 1 ? versioned[0]!.id : undefined,
      );
    }
    return this.catalog([pkg.entry])[0]!;
  }

  validatePlacement(
    selections: PluginDesiredState,
    harness: Readonly<Pick<RevisionHarnessDescriptor, "id" | "mode">>,
    computeImplementation: string,
    credentialRuntime?: {
      readonly sandbox: string | undefined;
      readonly gateway: string | undefined;
    },
  ): void {
    const { managed, native } = splitOpenClawSelections(selections);
    const [nativeId] = Object.keys(native);
    if (managed.length > 0 && nativeId !== undefined) {
      const names = managed.map(({ entry }) => entry.name).join(", ");
      throw new ConfigurationHarnessError(
        `Select ${nativeId} on an embedded OpenClaw Agent. Use a dedicated OpenClaw Agent for ${names}.`,
      );
    }
    for (const { placement, entry } of managed) {
      if (harness.id !== placement.harnessId || harness.mode !== placement.mode) {
        throw new ConfigurationHarnessError(`${entry.name} requires a dedicated OpenClaw Agent.`);
      }
      if (!placement.computeImplementations.includes(computeImplementation)) {
        throw new ConfigurationHarnessError(`${entry.name} requires Kubernetes Compute.`);
      }
    }
    requireManagedCredentialRuntime(
      selections,
      credentialRuntime?.sandbox,
      credentialRuntime?.gateway,
    );
  }

  validateAgentConfiguration(
    selections: PluginDesiredState,
    configuration: Readonly<OpenClawConfigurationDocument>,
  ): void {
    // The Gateway refuses these settings at every start, before any turn (finding 3091). These
    // plugins run only in an OpenClaw Harness: for another, placement refuses the selection
    // (validatePluginPlacement) and is the refusal to name, since a Codex Configuration's
    // plugins.allow, for example, always leaves them out.
    const conflict = openClawHarnessConfiguration(configuration)
      ? openClawPluginSettingConflict(
          selections,
          configuration,
          openClawManagedPluginIds(),
          `${OCC_DRIVER_ID}:`,
        )
      : undefined;
    if (conflict !== undefined) {
      throw new ConfigurationHarnessError(openClawPluginSettingMessage(conflict));
    }
    const denied = deniedOpenClawSelection(OCC_CATALOG, selections, configuration);
    if (denied !== undefined) {
      throw new ConfigurationHarnessError(openClawToolDenialMessage(denied));
    }
  }
}

export class CodexPluginDriver extends BundledPluginDriverBase implements PluginDriver {
  readonly harnessId = "codex" as const;
  static readonly configurationSchema = EMPTY_CONFIGURATION_SCHEMA;
  readonly discoveryCredential = "required" as const;
  // TODO: gate all_actions/write_actions on enforceable session constraints before this draft ships.
  // A permissive native session can bypass app-level review despite translation.
  readonly policyCapabilities: PluginPolicyCapabilities = deepFreeze({
    // TODO(policySubject): advertise plugin and tool approvers once upstream Codex plugin approval
    // requests carry policySubject. Until then OpenClaw's Slack resolver returns no approvers for a
    // subject-less request whenever approvals.plugin.slack.plugins is set, so only the Agent-wide
    // list can approve Codex plugin calls.
    approvers: { agent: true, plugin: false, tools: false },
    toolDefaults: {
      enabled: true,
      approval: ["provider_default", "all_actions", "write_actions", "none"],
      reviewer: ["human", "auto"],
    },
    tools: {
      enabled: true,
      approval: ["provider_default", "all_actions", "write_actions", "none"],
      reviewer: [],
    },
    driverPolicySchema: CODEX_POLICY_SCHEMA,
  });

  validatePolicies(selections: PluginDesiredState, defaultApprovers?: PluginApprovers): void {
    this.validate("codex", selections, defaultApprovers);
    // Admission-only check: runtime translation still renders already-admitted revisions unchanged.
    // TODO(policySubject): remove with the capability gate above.
    if (
      Object.values(selections).some(
        (selection) =>
          selection.approvers !== undefined ||
          Object.values(selection.tools ?? {}).some((tool) => tool.approvers !== undefined),
      )
    ) {
      throw new PluginPolicyValidationError("approvers");
    }
  }

  validateAgentConfiguration(
    selections: PluginDesiredState,
    configuration: Readonly<OpenClawConfigurationDocument>,
  ): void {
    validateCodexAutomaticReviewerPolicy(selections, configuration);
  }
  static validateConfiguration(): readonly ErrorDetail[] {
    return [];
  }

  async discoverCatalog(
    input: PluginDiscoveryAuthentication & { readonly cursor?: string; readonly q?: string },
    signal?: AbortSignal,
  ): Promise<PluginCatalogPage> {
    return discoverHostedPlugins(input, signal);
  }

  async getCatalogPlugin(
    input: PluginDiscoveryAuthentication & { readonly pluginId: string },
    signal?: AbortSignal,
  ): Promise<PluginCatalogEntry> {
    return getHostedPlugin(input, signal);
  }

  constructor(configuration: ConfigurationRecord = {}, selection: PluginDriverSelection = {}) {
    requireConfiguration(CodexPluginDriver, configuration);
    super(selection, { id: CODEX_DRIVER_ID, implementation: CODEX_IMPLEMENTATION });
  }

  // TODO: remove this unused method when the shared Plugin Driver contract drops listCatalog.
  async listCatalog(context: PluginDriverContext): Promise<readonly PluginCatalogEntry[]> {
    ensureHarness(context, this.harnessId, "dedicated");
    throw notImplemented(
      "codex-plugin-catalog-discovery",
      "Use authenticated Codex plugin discovery instead.",
    );
  }
}
