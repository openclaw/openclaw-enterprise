import { asRecord, deepFreeze, immutableCopy } from "@openclaw-enterprise/utils";
import {
  type JSONSchema,
  type PluginCatalogEntry,
  type PluginToolCatalogEntry,
  type PluginCatalogPage,
  type PluginDriver,
  type PluginDesiredState,
  type PluginPolicyCapabilities,
  type PluginDriverContext,
  type PluginDriverIdentity,
} from "@openclaw-enterprise/contracts";
import {
  NotImplementedError,
  PluginDiscoveryError,
  PluginPolicyValidationError,
  ScopeViolationError,
} from "@openclaw-enterprise/occ";
import {
  openClawCatalogEntries,
  validatePolicies,
  type CodexPluginCatalogReader,
} from "./runtime-translator.ts";
import { NativeCodexPluginCatalogReader } from "./stdio-catalog-reader.ts";
import { discoverHostedPlugins, getHostedPlugin } from "./hosted-catalog.ts";

type ConfigurationRecord = Readonly<Record<string, unknown>>;

interface PluginDriverSelection {
  readonly id?: string;
  readonly implementation?: string;
}

type BundledCatalogEntry = PluginCatalogEntry;

export class PluginValidationError extends ScopeViolationError {}

const OCC_DRIVER_ID = "occ-plugin";
const OCC_IMPLEMENTATION = "occ/openclaw-plugin";
const CODEX_DRIVER_ID = "codex-plugin";
const CODEX_IMPLEMENTATION = "occ/codex-plugin";

const EMPTY_CONFIGURATION_SCHEMA: JSONSchema = deepFreeze({
  type: "object",
  additionalProperties: false,
  properties: {},
});

const CODEX_CONFIGURATION_SCHEMA: JSONSchema = deepFreeze({
  type: "object",
  additionalProperties: false,
  properties: {
    catalogSource: { type: "string", enum: ["hosted", "openai-curated"] },
    codexExecutable: { type: "string", minLength: 1 },
    codexHome: { type: "string", minLength: 1 },
    requestTimeoutMs: { type: "integer", minimum: 1, maximum: 60_000 },
  },
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

// Entries use recorded marketplace identities; account access and tools remain unknown.
// Releases with unsupported skills or local components must not be selectable.
const CURATED_UNSUPPORTED =
  "The recorded plugin release requires skills or local components that OCE does not support.";
const LINEAR_APP_ID = "asdk_app_69a089a326dc8191b32a3f2553f5be2c";
const LINEAR_TOOLS: readonly PluginToolCatalogEntry[] = deepFreeze([
  {
    id: `${LINEAR_APP_ID}/linear.create_attachment`,
    ownerId: LINEAR_APP_ID,
    name: "Create attachment (deprecated)",
    description: "Create a Linear attachment from provided file content.",
    writes: true,
  },
  {
    id: `${LINEAR_APP_ID}/linear.create_issue_label`,
    ownerId: LINEAR_APP_ID,
    name: "Create issue label (deprecated)",
    description: "Create a Linear issue label.",
    writes: true,
  },
  {
    id: `${LINEAR_APP_ID}/linear.delete_attachment`,
    ownerId: LINEAR_APP_ID,
    name: "Delete attachment",
    description: "Delete a Linear attachment.",
    writes: true,
    destructive: true,
  },
  {
    id: `${LINEAR_APP_ID}/linear.delete_comment`,
    ownerId: LINEAR_APP_ID,
    name: "Delete comment",
    description: "Delete a Linear comment.",
    writes: true,
    destructive: true,
  },
  {
    id: `${LINEAR_APP_ID}/linear.delete_customer`,
    ownerId: LINEAR_APP_ID,
    name: "Delete customer",
    description: "Delete a Linear customer.",
    writes: true,
    destructive: true,
  },
  {
    id: `${LINEAR_APP_ID}/linear.delete_customer_need`,
    ownerId: LINEAR_APP_ID,
    name: "Delete customer need",
    description: "Archive a Linear customer need.",
    writes: true,
    destructive: true,
  },
  {
    id: `${LINEAR_APP_ID}/linear.delete_status_update`,
    ownerId: LINEAR_APP_ID,
    name: "Delete status update",
    description: "Delete a Linear project or initiative status update.",
    writes: true,
    destructive: true,
  },
  {
    id: `${LINEAR_APP_ID}/linear.extract_images`,
    ownerId: LINEAR_APP_ID,
    name: "Extract images",
    description: "Extract image attachments from Linear markdown content.",
    writes: false,
  },
  {
    id: `${LINEAR_APP_ID}/linear.fetch`,
    ownerId: LINEAR_APP_ID,
    name: "Fetch",
    description: "Fetch a Linear issue, project, initiative, or document by ID.",
    writes: false,
  },
  {
    id: `${LINEAR_APP_ID}/linear.get_attachment`,
    ownerId: LINEAR_APP_ID,
    name: "Get attachment",
    description: "Get a Linear attachment by ID.",
    writes: false,
  },
  {
    id: `${LINEAR_APP_ID}/linear.get_document`,
    ownerId: LINEAR_APP_ID,
    name: "Get document",
    description: "Get a Linear document by ID or slug.",
    writes: false,
  },
  {
    id: `${LINEAR_APP_ID}/linear.get_initiative`,
    ownerId: LINEAR_APP_ID,
    name: "Get initiative",
    description: "Get a Linear initiative by ID.",
    writes: false,
  },
  {
    id: `${LINEAR_APP_ID}/linear.get_issue`,
    ownerId: LINEAR_APP_ID,
    name: "Get issue",
    description: "Get a Linear issue by ID.",
    writes: false,
  },
  {
    id: `${LINEAR_APP_ID}/linear.get_issue_status`,
    ownerId: LINEAR_APP_ID,
    name: "Get issue status",
    description: "Get a Linear issue status by name or ID.",
    writes: false,
  },
  {
    id: `${LINEAR_APP_ID}/linear.get_milestone`,
    ownerId: LINEAR_APP_ID,
    name: "Get milestone",
    description: "Get a Linear project milestone by ID or name.",
    writes: false,
  },
  {
    id: `${LINEAR_APP_ID}/linear.get_project`,
    ownerId: LINEAR_APP_ID,
    name: "Get project",
    description: "Get a Linear project by ID.",
    writes: false,
  },
  {
    id: `${LINEAR_APP_ID}/linear.get_status_updates`,
    ownerId: LINEAR_APP_ID,
    name: "Get status updates",
    description: "List or get Linear project and initiative status updates.",
    writes: false,
  },
  {
    id: `${LINEAR_APP_ID}/linear.get_team`,
    ownerId: LINEAR_APP_ID,
    name: "Get team",
    description: "Get a Linear team by ID.",
    writes: false,
  },
  {
    id: `${LINEAR_APP_ID}/linear.get_user`,
    ownerId: LINEAR_APP_ID,
    name: "Get user",
    description: "Get a Linear user by ID.",
    writes: false,
  },
  {
    id: `${LINEAR_APP_ID}/linear.list_comments`,
    ownerId: LINEAR_APP_ID,
    name: "List comments",
    description:
      "List comments for a Linear issue, project, initiative, document, milestone, or status update.",
    writes: false,
  },
  {
    id: `${LINEAR_APP_ID}/linear.list_customers`,
    ownerId: LINEAR_APP_ID,
    name: "List customers",
    description: "List Linear customers.",
    writes: false,
  },
  {
    id: `${LINEAR_APP_ID}/linear.list_cycles`,
    ownerId: LINEAR_APP_ID,
    name: "List cycles",
    description: "List Linear cycles for a team.",
    writes: false,
  },
  {
    id: `${LINEAR_APP_ID}/linear.list_documents`,
    ownerId: LINEAR_APP_ID,
    name: "List documents",
    description: "List Linear documents.",
    writes: false,
  },
  {
    id: `${LINEAR_APP_ID}/linear.list_initiatives`,
    ownerId: LINEAR_APP_ID,
    name: "List initiatives",
    description: "List Linear initiatives.",
    writes: false,
  },
  {
    id: `${LINEAR_APP_ID}/linear.list_issue_labels`,
    ownerId: LINEAR_APP_ID,
    name: "List issue labels",
    description: "List Linear issue labels.",
    writes: false,
  },
  {
    id: `${LINEAR_APP_ID}/linear.list_issue_statuses`,
    ownerId: LINEAR_APP_ID,
    name: "List issue statuses",
    description: "List Linear issue statuses for a team.",
    writes: false,
  },
  {
    id: `${LINEAR_APP_ID}/linear.list_issues`,
    ownerId: LINEAR_APP_ID,
    name: "List issues",
    description: "List Linear issues.",
    writes: false,
  },
  {
    id: `${LINEAR_APP_ID}/linear.list_milestones`,
    ownerId: LINEAR_APP_ID,
    name: "List project milestones",
    description: "List Linear project milestones.",
    writes: false,
  },
  {
    id: `${LINEAR_APP_ID}/linear.list_project_labels`,
    ownerId: LINEAR_APP_ID,
    name: "List project labels",
    description: "List Linear project labels.",
    writes: false,
  },
  {
    id: `${LINEAR_APP_ID}/linear.list_projects`,
    ownerId: LINEAR_APP_ID,
    name: "List projects",
    description: "List Linear projects.",
    writes: false,
  },
  {
    id: `${LINEAR_APP_ID}/linear.list_teams`,
    ownerId: LINEAR_APP_ID,
    name: "List teams",
    description: "List Linear teams.",
    writes: false,
  },
  {
    id: `${LINEAR_APP_ID}/linear.list_users`,
    ownerId: LINEAR_APP_ID,
    name: "List users",
    description: "List Linear users.",
    writes: false,
  },
  {
    id: `${LINEAR_APP_ID}/linear.save_comment`,
    ownerId: LINEAR_APP_ID,
    name: "Save comment",
    description: "Create or update a Linear comment.",
    writes: true,
    destructive: true,
  },
  {
    id: `${LINEAR_APP_ID}/linear.save_customer`,
    ownerId: LINEAR_APP_ID,
    name: "Save customer",
    description: "Create or update a Linear customer.",
    writes: true,
    destructive: true,
  },
  {
    id: `${LINEAR_APP_ID}/linear.save_customer_need`,
    ownerId: LINEAR_APP_ID,
    name: "Save customer need",
    description: "Create or update a Linear customer need.",
    writes: true,
    destructive: true,
  },
  {
    id: `${LINEAR_APP_ID}/linear.save_initiative`,
    ownerId: LINEAR_APP_ID,
    name: "Save initiative",
    description: "Create or update a Linear initiative.",
    writes: true,
    destructive: true,
  },
  {
    id: `${LINEAR_APP_ID}/linear.save_issue`,
    ownerId: LINEAR_APP_ID,
    name: "Save issue",
    description: "Create or update a Linear issue.",
    writes: true,
    destructive: true,
  },
  {
    id: `${LINEAR_APP_ID}/linear.save_milestone`,
    ownerId: LINEAR_APP_ID,
    name: "Save milestone",
    description: "Create or update a Linear project milestone.",
    writes: true,
    destructive: true,
  },
  {
    id: `${LINEAR_APP_ID}/linear.save_project`,
    ownerId: LINEAR_APP_ID,
    name: "Save project",
    description: "Create or update a Linear project.",
    writes: true,
    destructive: true,
  },
  {
    id: `${LINEAR_APP_ID}/linear.save_status_update`,
    ownerId: LINEAR_APP_ID,
    name: "Save status update",
    description: "Create or update a Linear project or initiative status update.",
    writes: true,
    destructive: true,
  },
  {
    id: `${LINEAR_APP_ID}/linear.search`,
    ownerId: LINEAR_APP_ID,
    name: "Search",
    description: "Search Linear issues, projects, initiatives, documents, and customers.",
    writes: false,
  },
  {
    id: `${LINEAR_APP_ID}/linear.search_documentation`,
    ownerId: LINEAR_APP_ID,
    name: "Search documentation",
    description: "Search Linear documentation.",
    writes: false,
  },
]);

const OPENAI_CURATED_CATALOG: readonly BundledCatalogEntry[] = deepFreeze([
  {
    id: "codex-plugin:linear@openai-curated-remote",
    remoteId: "plugin_asdk_app_69a089a326dc8191b32a3f2553f5be2c",
    name: "Linear",
    description: "Plan and build products",
    websiteUrl: "https://linear.app/",
    privacyPolicyUrl: "https://linear.app/privacy",
    termsOfServiceUrl: "https://linear.app/terms",
    tools: LINEAR_TOOLS,
  },
  {
    id: "codex-plugin:slack@openai-curated-remote",
    remoteId: "plugin_asdk_app_69a1d78e929881919bba0dbda1f6436d",
    name: "Slack",
    description: "Read and manage Slack",
    websiteUrl: "https://slack.com/",
    privacyPolicyUrl: "https://slack.com/privacy-policy",
    termsOfServiceUrl: "https://slack.com/terms-of-service/user",
    selectableWithoutTools: true,
    tools: null,
  },
  {
    id: "codex-plugin:github@openai-curated-remote",
    remoteId: "plugin_connector_1p_1a69035c238881919c4190932b2df699",
    name: "GitHub",
    description: "Triage PRs, issues, CI, and publish flows",
    websiteUrl: "https://github.com/",
    privacyPolicyUrl:
      "https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement",
    termsOfServiceUrl:
      "https://docs.github.com/en/site-policy/github-terms/github-terms-of-service",
    selectableWithoutTools: true,
    tools: null,
  },
  {
    id: "codex-plugin:notion@openai-curated-remote",
    remoteId: "plugin_asdk_app_69c18c28f1188191bf5b8445c4ab0a2e",
    name: "Notion",
    description: "Notion docs and workflows",
    websiteUrl: "https://www.notion.so/",
    privacyPolicyUrl: "https://www.notion.com/help/privacy",
    termsOfServiceUrl: "https://www.notion.so/legal/terms-of-use",
    available: false,
    unavailableReason: CURATED_UNSUPPORTED,
    tools: null,
  },
  {
    id: "codex-plugin:figma@openai-curated-remote",
    remoteId: "plugin_connector_68df038e0ba48191908c8434991bbac2",
    name: "Figma",
    description: "Create designs, ship to code",
    websiteUrl: "https://www.figma.com",
    privacyPolicyUrl: "https://www.figma.com/legal/privacy/",
    termsOfServiceUrl: "https://www.figma.com/legal/tos/",
    available: false,
    unavailableReason: CURATED_UNSUPPORTED,
    tools: null,
  },
  {
    id: "codex-plugin:canva@openai-curated-remote",
    remoteId: "plugin_connector_68df33b1a2d081918778431a9cfca8ba",
    name: "Canva",
    description: "Create, review, edit designs",
    websiteUrl: "https://www.canva.com",
    privacyPolicyUrl: "https://www.canva.com/policies/privacy-policy/",
    termsOfServiceUrl: "https://www.canva.com/policies/terms-of-use/",
    available: false,
    unavailableReason: CURATED_UNSUPPORTED,
    tools: null,
  },
  {
    id: "codex-plugin:datadog@openai-curated-remote",
    remoteId: "plugin_asdk_app_69e8c7f174a08191a28b6da96c8062c4",
    name: "Datadog",
    description: "Query and visualize data",
    websiteUrl: "https://www.datadoghq.com",
    privacyPolicyUrl: "https://www.datadoghq.com/legal/privacy/",
    termsOfServiceUrl: "https://www.datadoghq.com/legal/terms/2024-10-25/",
    selectableWithoutTools: true,
    tools: null,
  },
  {
    id: "codex-plugin:sentry@openai-curated-remote",
    remoteId: "plugins~Plugin_051b067fbd20819195157b75a34efe0a",
    name: "Sentry",
    description: "Inspect recent Sentry issues and events",
    websiteUrl: "https://sentry.io/",
    privacyPolicyUrl: "https://sentry.io/privacy/",
    termsOfServiceUrl: "https://sentry.io/terms/",
    available: false,
    unavailableReason: CURATED_UNSUPPORTED,
    tools: null,
  },
  {
    id: "codex-plugin:app-69312da8e4dc81919370cb86fd172b6c@openai-curated-remote",
    remoteId: "plugin_asdk_app_69312da8e4dc81919370cb86fd172b6c",
    name: "Adobe",
    description: "Design, combine, and edit",
    websiteUrl: "https://www.adobe.com",
    privacyPolicyUrl: "https://www.adobe.com/privacy/policy.html",
    termsOfServiceUrl: "https://www.adobe.com/legal/terms.html",
    available: false,
    unavailableReason: CURATED_UNSUPPORTED,
    tools: null,
  },
  {
    id: "codex-plugin:app-68e01e8c1c2081918b4567a0b959d3ff@openai-curated-remote",
    remoteId: "plugin_asdk_app_68e01e8c1c2081918b4567a0b959d3ff",
    name: "Coursera Learning",
    description: "Learn and practice skills",
    websiteUrl: "https://www.coursera.org",
    privacyPolicyUrl: "https://www.coursera.org/about/privacy",
    termsOfServiceUrl: "https://www.coursera.org/about/terms",
    selectableWithoutTools: true,
    tools: null,
  },
  {
    id: "codex-plugin:google-contacts@openai-curated-remote",
    remoteId: "plugin_connector_1p_c97194162860819190a6f840a61b9889",
    name: "Google Contacts",
    description: "Reference saved contact details",
    websiteUrl: "https://contacts.google.com",
    privacyPolicyUrl: "https://policies.google.com/privacy",
    termsOfServiceUrl: "https://policies.google.com/terms",
    selectableWithoutTools: true,
    tools: null,
  },
]);
const CURATED_SETUP = deepFreeze({
  message:
    "This catalog does not verify workspace access, app connections, or tool availability. Configure the Agent's credentials and app access before deployment.",
  links: [
    { label: "Manage workspace plugins", url: "https://chatgpt.com/admin/plugins?catalog=GLOBAL" },
    {
      label: "OCE plugin setup",
      url: "https://github.com/openclaw/openclaw-enterprise/blob/main/docs/reference/drivers/plugin-bundled.md#selection-and-catalogs",
    },
  ],
});

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PluginValidationError(`${path} must be a nonempty string.`);
  }
  return value;
}

function validateEmptyConfiguration(configuration: unknown, name: string): void {
  const value = asRecord(configuration);
  if (value === undefined) {
    throw new PluginValidationError(`${name} configuration must be one object.`);
  }
  const keys = Object.keys(value);
  if (keys.length > 0) {
    throw new PluginValidationError(`${name} configuration does not accept options.`);
  }
}

function validateCodexConfiguration(configuration: unknown): {
  catalogSource: "hosted" | "openai-curated";
  reader: ConstructorParameters<typeof NativeCodexPluginCatalogReader>[0] | undefined;
} {
  const value = asRecord(configuration);
  if (value === undefined) {
    throw new PluginValidationError("Codex Plugin Driver configuration must be one object.");
  }
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!["catalogSource", "codexExecutable", "codexHome", "requestTimeoutMs"].includes(key)) {
      throw new PluginValidationError(`Codex Plugin Driver configuration.${key} is unsupported.`);
    }
  }
  const catalogSource = value.catalogSource === undefined ? "hosted" : value.catalogSource;
  if (catalogSource !== "hosted" && catalogSource !== "openai-curated") {
    throw new PluginValidationError("catalogSource must be hosted or openai-curated.");
  }
  if (
    value.codexExecutable === undefined &&
    value.codexHome === undefined &&
    value.requestTimeoutMs === undefined
  ) {
    return { catalogSource, reader: undefined };
  }
  const codexExecutable = requiredString(value.codexExecutable, "codexExecutable");
  const codexHome = requiredString(value.codexHome, "codexHome");
  const requestTimeoutMs = value.requestTimeoutMs;
  if (
    requestTimeoutMs !== undefined &&
    (!Number.isSafeInteger(requestTimeoutMs) ||
      (requestTimeoutMs as number) < 1 ||
      (requestTimeoutMs as number) > 60_000)
  ) {
    throw new PluginValidationError("requestTimeoutMs must be between 1 and 60000.");
  }
  return {
    catalogSource,
    reader: {
      codexExecutable,
      codexHome,
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs: requestTimeoutMs as number }),
    },
  };
}

function sameDriver(left: PluginDriverIdentity, right: PluginDriverIdentity): boolean {
  return left.id === right.id && left.implementation === right.implementation;
}

function ensureHarness(context: PluginDriverContext, mode: "embedded" | "dedicated"): void {
  if (context.harness.mode !== mode) {
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

  protected validate(kind: "codex" | "openclaw", selections: PluginDesiredState): void {
    try {
      validatePolicies(kind, selections);
    } catch (error) {
      const field =
        error instanceof Error && "policyField" in error ? error.policyField : undefined;
      throw new PluginPolicyValidationError(
        field === "toolDefaults.reviewer" || field === "tools[id].reviewer" ? field : undefined,
      );
    }
  }

  protected catalog(catalog: readonly BundledCatalogEntry[]): readonly PluginCatalogEntry[] {
    return immutableCopy(catalog) as readonly PluginCatalogEntry[];
  }
}

export class OCCPluginDriver extends BundledPluginDriverBase implements PluginDriver {
  static readonly configurationSchema = EMPTY_CONFIGURATION_SCHEMA;
  readonly policyCapabilities: PluginPolicyCapabilities = deepFreeze({
    toolDefaults: { enabled: true, approval: ["native", "approve"], reviewer: [] },
    tools: { enabled: true, approval: ["native", "approve"], reviewer: [] },
    driverPolicySchema: EMPTY_CONFIGURATION_SCHEMA,
  });

  validatePolicies(selections: PluginDesiredState): void {
    this.validate("openclaw", selections);
  }

  static validateConfiguration(configuration: unknown): void {
    validateEmptyConfiguration(configuration, "OpenClaw Plugin Driver");
  }

  constructor(configuration: ConfigurationRecord = {}, selection: PluginDriverSelection = {}) {
    OCCPluginDriver.validateConfiguration(configuration);
    super(selection, { id: OCC_DRIVER_ID, implementation: OCC_IMPLEMENTATION });
  }

  async listCatalog(context: PluginDriverContext): Promise<readonly PluginCatalogEntry[]> {
    ensureHarness(context, "embedded");
    return this.catalog(OCC_CATALOG);
  }
}

export class CodexPluginDriver extends BundledPluginDriverBase implements PluginDriver {
  static readonly configurationSchema = CODEX_CONFIGURATION_SCHEMA;
  // TODO: gate prompt on enforceable session constraints before this draft ships.
  // A permissive native session can bypass app-level review despite translation.
  readonly policyCapabilities: PluginPolicyCapabilities = deepFreeze({
    toolDefaults: {
      enabled: true,
      approval: ["native", "prompt", "approve"],
      reviewer: ["human", "auto"],
    },
    tools: { enabled: true, approval: ["native", "prompt", "approve"], reviewer: [] },
    driverPolicySchema: CODEX_POLICY_SCHEMA,
  });

  validatePolicies(selections: PluginDesiredState): void {
    this.validate("codex", selections);
  }
  private readonly catalogReader: CodexPluginCatalogReader | undefined;
  private readonly catalogSource: "hosted" | "openai-curated";
  readonly discoveryCredential: "required" | "none";

  static validateConfiguration(configuration: unknown): void {
    validateCodexConfiguration(configuration);
  }

  async discoverCatalog(
    input: { readonly accessToken?: string; readonly cursor?: string },
    signal?: AbortSignal,
  ): Promise<PluginCatalogPage> {
    if (this.catalogSource === "openai-curated") {
      if (input.cursor !== undefined) {
        throw new PluginDiscoveryError("invalid_response");
      }
      return {
        plugins: this.catalog(OPENAI_CURATED_CATALOG),
        nextCursor: null,
        setup: CURATED_SETUP,
      };
    }
    if (input.accessToken === undefined) {
      throw new PluginDiscoveryError("credentials_rejected");
    }
    return discoverHostedPlugins(
      {
        accessToken: input.accessToken,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      },
      signal,
    );
  }

  async getCatalogPlugin(
    input: { readonly accessToken?: string; readonly pluginId: string },
    signal?: AbortSignal,
  ): Promise<PluginCatalogEntry> {
    if (this.catalogSource === "openai-curated") {
      const entry = OPENAI_CURATED_CATALOG.find((plugin) => plugin.remoteId === input.pluginId);
      if (!entry) {
        throw new PluginDiscoveryError("invalid_response");
      }
      return this.catalog([entry])[0]!;
    }
    if (input.accessToken === undefined) {
      throw new PluginDiscoveryError("credentials_rejected");
    }
    return getHostedPlugin({ accessToken: input.accessToken, pluginId: input.pluginId }, signal);
  }

  constructor(
    configuration: ConfigurationRecord = {},
    selection: PluginDriverSelection = {},
    catalogReader?: CodexPluginCatalogReader,
  ) {
    const discovery = validateCodexConfiguration(configuration);
    super(selection, { id: CODEX_DRIVER_ID, implementation: CODEX_IMPLEMENTATION });
    this.catalogSource = discovery.catalogSource;
    this.discoveryCredential = discovery.catalogSource === "openai-curated" ? "none" : "required";
    this.catalogReader =
      catalogReader ??
      (discovery.reader === undefined
        ? undefined
        : new NativeCodexPluginCatalogReader(discovery.reader));
  }

  async listCatalog(context: PluginDriverContext): Promise<readonly PluginCatalogEntry[]> {
    ensureHarness(context, "dedicated");
    if (this.catalogSource === "openai-curated") {
      return this.catalog(OPENAI_CURATED_CATALOG);
    }
    if (this.catalogReader === undefined) {
      throw notImplemented(
        "codex-plugin-catalog-discovery",
        "Codex plugin catalog discovery requires configured codexExecutable and codexHome.",
      );
    }
    return this.catalog(await this.catalogReader.listCatalog(context.signal));
  }
}
