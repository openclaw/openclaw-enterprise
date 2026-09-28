import type {
  OpenClawConfigurationDocument,
  PluginCatalogEntry,
  PluginApprovalMode,
  PluginDesiredState,
  PluginApprovers,
} from "@openclaw-enterprise/contracts";

export type OpenClawRuntimeResolvedArtifacts = {
  readonly kind: "openclaw";
  readonly configuration: OpenClawConfigurationDocument;
  readonly installs: readonly {
    readonly pluginId: string;
    readonly nativeId: string;
    readonly packageName: string;
    readonly version: string;
    readonly integrity?: string;
  }[];
};

export type CodexRuntimeResolvedArtifacts = {
  readonly kind: "codex";
  readonly configuration: OpenClawConfigurationDocument;
  readonly installs: readonly {
    readonly pluginId: string;
    readonly nativeId: string;
    readonly remotePluginId: string;
    readonly version: string;
    readonly registry: "openai-curated-remote";
  }[];
};

export type PluginRuntimeResolvedArtifacts =
  OpenClawRuntimeResolvedArtifacts | CodexRuntimeResolvedArtifacts;

type PluginRuntimeFailureInput = readonly { readonly pluginId: string }[];

export interface CodexRepositoryBrokerNetworkPolicy {
  readonly host: string;
  readonly domains: Readonly<Record<string, "allow" | "deny">>;
}

export type CodexPluginCatalogReader = {
  listCatalog(signal?: AbortSignal): Promise<readonly PluginCatalogEntry[]>;
};

type OpenClawPluginDescriptor = {
  readonly nativeId: string;
  readonly name: string;
  readonly packageName: string;
  readonly version: string;
  readonly integrity: string;
  readonly toolNames: readonly string[];
};

// Admission metadata comes from the integrity-pinned package's manifest and
// registration contract. Keep identities separate from policy translation.
const OPENCLAW_PLUGIN_CATALOG: readonly OpenClawPluginDescriptor[] = [
  {
    nativeId: "diffs",
    name: "Diffs",
    packageName: "@openclaw/diffs",
    version: "2026.8.2",
    integrity:
      "sha512-5VTDNEo7D3iOgRoL5C31JPTbA/EXQEFRuxOvLy67IMFmOajwroGsUMWeuKkmqzFbPNQxvn7GACDSr/5Vmpx3/g==",
    toolNames: ["diffs"],
  },
];

export function createPluginRuntimeTranslator(nativeCatalog: readonly OpenClawPluginDescriptor[]) {
  const OCC_DRIVER_ID = "occ-plugin";
  const CODEX_DRIVER_ID = "codex-plugin";
  const CODEX_MARKETPLACE = "openai-curated-remote";
  const CODEX_RUNTIME_READ_ONLY_PATHS = ["/app/node_modules/openclaw"];
  const CODEX_PLUGIN_READ_ONLY_PATHS = [
    ...CODEX_RUNTIME_READ_ONLY_PATHS,
    "/home/node/.openclaw/plugin-skills",
    "/home/node/openclaw-runtime-assets/plugin-skills",
  ];
  const CODEX_REPOSITORY_BROKER_READ_ONLY_PATHS = [
    ...CODEX_PLUGIN_READ_ONLY_PATHS,
    "/opt/oce/repository-credentials",
    "/run/oce/repository-credentials",
  ];

  // Native policy names are global: aliases/families can target core tools,
  // and another plugin's ID targets its entire tool inventory.
  const reservedPolicyNames = new Set(["bash", "apply-patch", "cron", "canvas", "update_plan"]);
  const toolNames = new Set<string>();
  for (const descriptor of nativeCatalog) {
    for (const name of [descriptor.nativeId, ...descriptor.toolNames]) {
      if (!/^[a-z][a-z0-9_-]*$/.test(name) || reservedPolicyNames.has(name)) {
        throw new Error("OpenClaw catalog requires literal canonical policy names.");
      }
    }
    for (const toolName of descriptor.toolNames) {
      if (
        toolNames.has(toolName) ||
        nativeCatalog.some((other) => other.nativeId === toolName && other !== descriptor)
      ) {
        throw new Error("OpenClaw catalog tool identities must be unambiguous.");
      }
      toolNames.add(toolName);
    }
  }

  const CODEX_NO_PLUGIN_CONFIGURATION = {
    features: {
      apps: false,
      plugins: false,
      remote_plugin: false,
    },
    apps: {
      _default: { enabled: false },
    },
    plugins: {},
  };

  const CODEX_SELECTED_PLUGIN_BASE_CONFIGURATION = {
    features: {
      apps: true,
      plugins: true,
      remote_plugin: true,
    },
    apps: {
      _default: { enabled: false },
    },
    plugins: {},
  };

  function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function requiredString(value: unknown, description: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(description + " is missing.");
    }
    return value;
  }

  function optionalString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
  }

  function array(value: unknown): readonly unknown[] {
    return Array.isArray(value) ? value : [];
  }

  function requiredArray(value: unknown, description: string): readonly unknown[] {
    if (!Array.isArray(value)) {
      throw new Error(description + " must be an array.");
    }
    return value;
  }

  function selectionEntries(selections: unknown): readonly [string, Record<string, unknown>][] {
    if (!isRecord(selections)) {
      throw new Error("Plugin selections must be an object.");
    }
    return Object.entries(selections).map(([pluginId, value]) => {
      if (!isRecord(value)) {
        throw new Error("Plugin selection must be an object.");
      }
      return [pluginId, value];
    });
  }

  function policyRecord(
    value: unknown,
    name: string,
    fields: readonly string[],
  ): Record<string, unknown> {
    if (!isRecord(value) || Object.keys(value).some((key) => !fields.includes(key))) {
      throw new Error(name + " contains unsupported policy fields.");
    }
    return value;
  }

  function toolPolicy(value: unknown): Record<string, unknown> {
    const policy = policyRecord(value, "Tool policy", [
      "enabled",
      "approval",
      "reviewer",
      "approvers",
    ]);
    if (policy.enabled !== undefined && typeof policy.enabled !== "boolean") {
      throw new Error("Tool enabled must be a boolean.");
    }
    if (
      policy.approval !== undefined &&
      !["provider_default", "all_actions", "write_actions", "none"].includes(
        policy.approval as string,
      )
    ) {
      throw new Error("Tool approval policy is unsupported.");
    }
    if (policy.reviewer !== undefined && !["human", "auto"].includes(policy.reviewer as string)) {
      throw new Error("Tool reviewer must be human or auto.");
    }
    if (policy.approvers !== undefined) {
      slackApprovers(policy.approvers);
    }
    return policy;
  }

  function slackApprovers(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > 64) {
      throw new Error("Plugin approvers must be a bounded list.");
    }
    const ids = value.map((entry) => {
      if (
        !isRecord(entry) ||
        Object.keys(entry).length !== 2 ||
        entry.channel !== "slack" ||
        typeof entry.id !== "string" ||
        !/^(?:[UW][A-Z0-9]+|team:T[A-Z0-9]+:user:[UW][A-Z0-9]+)$/i.test(entry.id)
      ) {
        throw new Error("Plugin approver must identify a Slack user.");
      }
      return entry.id;
    });
    if (new Set(ids).size !== ids.length) {
      throw new Error("Plugin approvers must be unique.");
    }
    return ids;
  }

  function defaults(selection: Record<string, unknown>): Record<string, unknown> {
    const policy = policyRecord(
      selection.toolDefaults === undefined ? {} : selection.toolDefaults,
      "Plugin tool defaults",
      ["enabled", "approval", "reviewer"],
    );
    return toolPolicy(policy);
  }

  function toolPolicies(
    selection: Record<string, unknown>,
  ): Record<string, Record<string, unknown>> {
    if (selection.tools !== undefined && !isRecord(selection.tools)) {
      throw new Error("Plugin tool policies must be an object.");
    }
    return Object.fromEntries(
      Object.entries(selection.tools ?? {}).map(([id, policy]) => [id, toolPolicy(policy)]),
    );
  }

  function driverPolicy(selection: Record<string, unknown>): Record<string, unknown> {
    return policyRecord(
      selection.driverPolicy === undefined ? {} : selection.driverPolicy,
      "Codex driver policy",
      ["destructiveEnabled"],
    );
  }

  function codexToolId(appId: string, name: string): string {
    return encodeURIComponent(appId) + "/" + encodeURIComponent(name);
  }

  function parseCodexToolId(id: string): { appId: string; name: string } {
    const parts = id.split("/");
    try {
      const appId = decodeURIComponent(parts[0] ?? "");
      const name = decodeURIComponent(parts[1] ?? "");
      if (parts.length === 2 && appId && name && codexToolId(appId, name) === id) {
        return { appId, name };
      }
    } catch {
      // Invalid escapes cannot identify a native app/tool pair.
    }
    throw new Error("Codex tool policy requires an observed scoped tool ID.");
  }

  function validatePolicies(
    kind: "codex" | "openclaw",
    selections: unknown,
    defaultApprovers?: unknown,
  ): void {
    if (defaultApprovers !== undefined) {
      slackApprovers(defaultApprovers);
    }
    for (const [pluginId, selection] of selectionEntries(selections)) {
      policyRecord(selection, "Plugin selection", [
        "enabled",
        "approvers",
        "toolDefaults",
        "tools",
        "driverPolicy",
      ]);
      if (typeof selection.enabled !== "boolean") {
        throw new Error("Plugin enabled must be a boolean.");
      }
      if (selection.approvers !== undefined) {
        slackApprovers(selection.approvers);
      }
      const toolDefaults = defaults(selection);
      const tools = toolPolicies(selection);
      if (Object.values(tools).some((tool) => tool.reviewer !== undefined)) {
        throw Object.assign(
          new Error("Per-tool reviewer selection is unsupported; omit tools[id].reviewer."),
          { policyField: "tools[id].reviewer" },
        );
      }
      if (kind === "openclaw" && toolDefaults.reviewer !== undefined) {
        throw Object.assign(
          new Error("This runtime does not support toolDefaults.reviewer; omit it to inherit."),
          { policyField: "toolDefaults.reviewer" },
        );
      }
      if (kind === "codex") {
        codexNativeIdFromPluginId(pluginId);
        const policy = driverPolicy(selection);
        if (
          policy.destructiveEnabled !== undefined &&
          typeof policy.destructiveEnabled !== "boolean"
        ) {
          throw new Error("Codex destructiveEnabled must be a boolean.");
        }
        if (toolDefaults.enabled !== undefined && policy.destructiveEnabled !== undefined) {
          throw new Error(
            "Omit toolDefaults.enabled when using Codex destructiveEnabled; native default enablement bypasses category filtering.",
          );
        }
        for (const id of Object.keys(tools)) {
          parseCodexToolId(id);
        }
      } else {
        const nativeId = pluginId.startsWith(OCC_DRIVER_ID + ":")
          ? pluginId.slice((OCC_DRIVER_ID + ":").length)
          : pluginId;
        const descriptor = nativeCatalog.find((entry) => entry.nativeId === nativeId);
        if (descriptor === undefined) {
          throw new Error("Unknown OpenClaw plugin selection.");
        }
        policyRecord(
          selection.driverPolicy === undefined ? {} : selection.driverPolicy,
          "OpenClaw driver policy",
          [],
        );
        for (const [id, policy] of Object.entries(tools)) {
          if (!descriptor.toolNames.includes(id)) {
            throw new Error("Unknown OpenClaw plugin tool selection.");
          }
          if (policy.approval === "all_actions" || policy.approval === "write_actions") {
            throw new Error("OpenClaw plugin " + policy.approval + " approval is unsupported.");
          }
        }
        if (toolDefaults.approval === "all_actions" || toolDefaults.approval === "write_actions") {
          throw new Error("OpenClaw plugin " + toolDefaults.approval + " approval is unsupported.");
        }
      }
    }
  }

  function codexApproval(approval: unknown): unknown {
    return (
      {
        provider_default: "auto",
        all_actions: "prompt",
        write_actions: "writes",
        none: "approve",
      } satisfies Record<PluginApprovalMode, string>
    )[approval as PluginApprovalMode];
  }

  function pluginApprovalOverlay(
    kind: "codex" | "openclaw",
    selections: unknown,
    defaultApprovers?: unknown,
  ): Record<string, unknown> {
    const plugins: Record<string, unknown> = {};
    for (const [pluginId, selection] of selectionEntries(selections)) {
      const key =
        kind === "codex"
          ? codexSlugFromNativeId(codexNativeIdFromPluginId(pluginId))
          : pluginId.startsWith(OCC_DRIVER_ID + ":")
            ? pluginId.slice((OCC_DRIVER_ID + ":").length)
            : pluginId;
      const tools = Object.fromEntries(
        Object.entries(toolPolicies(selection))
          .filter(([, policy]) => policy.approvers !== undefined)
          .map(([toolId, policy]) => [
            kind === "codex" ? toolId : encodeURIComponent(toolId),
            { approvers: slackApprovers(policy.approvers) },
          ]),
      );
      if (selection.approvers !== undefined || Object.keys(tools).length > 0) {
        plugins[key] = {
          ...(selection.approvers === undefined
            ? {}
            : { approvers: slackApprovers(selection.approvers) }),
          ...(Object.keys(tools).length === 0 ? {} : { tools }),
        };
      }
    }
    if (defaultApprovers === undefined && Object.keys(plugins).length === 0) {
      return {};
    }
    return {
      approvals: {
        plugin: {
          slack: {
            ...(defaultApprovers === undefined
              ? {}
              : { approvers: slackApprovers(defaultApprovers) }),
            ...(Object.keys(plugins).length === 0 ? {} : { plugins }),
          },
        },
      },
    };
  }

  function codexNeedsToolInventory(selections: unknown): boolean {
    return selectionEntries(selections).some(
      ([, selection]) =>
        selection.enabled === true && Object.keys(toolPolicies(selection)).length > 0,
    );
  }

  function codexPluginId(nativeId: string): string {
    return CODEX_DRIVER_ID + ":" + nativeId;
  }

  function codexNativeIdFromPluginId(pluginId: string): string {
    const prefixed = pluginId.startsWith(CODEX_DRIVER_ID + ":")
      ? pluginId.slice((CODEX_DRIVER_ID + ":").length)
      : pluginId;
    const suffix = "@" + CODEX_MARKETPLACE;
    if (!prefixed.endsWith(suffix)) {
      throw new Error("Codex plugin ID must identify the curated remote marketplace.");
    }
    return prefixed;
  }

  function codexSlugFromNativeId(nativeId: string): string {
    const suffix = "@" + CODEX_MARKETPLACE;
    if (!nativeId.endsWith(suffix)) {
      throw new Error("Codex plugin native ID must identify the curated remote marketplace.");
    }
    return nativeId.slice(0, -suffix.length);
  }

  function codexPluginSummary(summary: unknown): Record<string, unknown> {
    if (!isRecord(summary)) {
      throw new Error("Codex plugin summary is missing.");
    }
    return summary;
  }

  function codexSummaryNativeId(summary: Record<string, unknown>): string {
    return requiredString(summary.id, "Codex catalog plugin ID");
  }

  function codexSummaryRemotePluginId(summary: Record<string, unknown>): string {
    return requiredString(summary.remotePluginId, "Codex catalog remote plugin ID");
  }

  function codexSummaryDisplayName(summary: Record<string, unknown>): string {
    const pluginInterface = isRecord(summary.interface) ? summary.interface : undefined;
    return (
      optionalString(pluginInterface?.displayName) ??
      optionalString(summary.name) ??
      codexSlugFromNativeId(codexSummaryNativeId(summary))
    );
  }

  function codexCatalogEntry(summary: unknown): Record<string, unknown> {
    const record = codexPluginSummary(summary);
    const nativeId = codexSummaryNativeId(record);
    codexSlugFromNativeId(nativeId);
    const pluginId = codexPluginId(nativeId);
    return {
      id: pluginId,
      name: codexSummaryDisplayName(record),
      tools: null,
    };
  }

  function codexCatalogEntries(listResponse: unknown): readonly Record<string, unknown>[] {
    const response = isRecord(listResponse) ? listResponse : {};
    const marketplaces = array(response.marketplaces);
    const curated = marketplaces.find(
      (marketplace) => isRecord(marketplace) && marketplace.name === CODEX_MARKETPLACE,
    );
    if (!isRecord(curated)) {
      return [];
    }
    return array(curated.plugins).map(codexCatalogEntry);
  }

  function codexSummaryByNativeId(
    listResponse: unknown,
  ): ReadonlyMap<string, Record<string, unknown>> {
    const response = isRecord(listResponse) ? listResponse : {};
    const marketplaces = array(response.marketplaces);
    const entries = new Map<string, Record<string, unknown>>();
    for (const marketplace of marketplaces) {
      if (!isRecord(marketplace) || marketplace.name !== CODEX_MARKETPLACE) {
        continue;
      }
      for (const summary of array(marketplace.plugins)) {
        const record = codexPluginSummary(summary);
        entries.set(codexSummaryNativeId(record), record);
      }
    }
    return entries;
  }

  function codexReadParamsForSelections(
    selections: unknown,
    listResponse: unknown,
  ): readonly Record<string, string>[] {
    const byNativeId = codexSummaryByNativeId(listResponse);
    return selectionEntries(selections).map(([pluginId]) => {
      const nativeId = codexNativeIdFromPluginId(pluginId);
      const summary = byNativeId.get(nativeId);
      if (summary === undefined) {
        throw new Error("Codex plugin catalog did not contain the selected plugin.");
      }
      return {
        remoteMarketplaceName: CODEX_MARKETPLACE,
        pluginName: codexSummaryRemotePluginId(summary),
      };
    });
  }

  function detailRecord(value: unknown): Record<string, unknown> {
    const wrapped = isRecord(value) && isRecord(value.plugin) ? value.plugin : value;
    if (!isRecord(wrapped)) {
      throw new Error("Codex plugin detail is missing.");
    }
    return wrapped;
  }

  function detailSummary(detail: Record<string, unknown>): Record<string, unknown> {
    if (!isRecord(detail.summary)) {
      throw new Error("Codex plugin detail summary is missing.");
    }
    return detail.summary;
  }

  function detailRemotePluginId(detail: Record<string, unknown>): string {
    return codexSummaryRemotePluginId(detailSummary(detail));
  }

  function detailNativeId(detail: Record<string, unknown>): string {
    return codexSummaryNativeId(detailSummary(detail));
  }

  function detailsByNativeId(
    details: readonly unknown[],
  ): ReadonlyMap<string, Record<string, unknown>> {
    const byNativeId = new Map<string, Record<string, unknown>>();
    for (const detail of details.map(detailRecord)) {
      byNativeId.set(detailNativeId(detail), detail);
    }
    return byNativeId;
  }

  function detailVersion(detail: Record<string, unknown>): string {
    return requiredString(detailSummary(detail).version, "Codex plugin release version");
  }

  function assertCodexDetailRepresentable(detail: Record<string, unknown>): void {
    detailVersion(detail);
    if (requiredArray(detail.apps, "Codex plugin detail apps").length === 0) {
      throw new Error("Codex plugin detail does not expose an app mapping.");
    }
    // TODO: support app templates. For now, ignore their metadata and derive
    // enabled app IDs only from detail.apps.
    // Native Codex owns bundled skills; they do not grant app tool permissions.
    requiredArray(detail.skills, "Codex plugin detail skills");
    for (const field of ["hooks", "mcpServers"]) {
      if (requiredArray(detail[field], "Codex plugin detail " + field).length > 0) {
        throw new Error("Codex plugin detail exposes unsupported " + field + ".");
      }
    }
    if (detail.scheduledTasks !== undefined && detail.scheduledTasks !== null) {
      if (requiredArray(detail.scheduledTasks, "Codex plugin detail scheduledTasks").length > 0) {
        throw new Error("Codex plugin detail exposes unsupported scheduledTasks.");
      }
    }
  }

  function appIds(detail: Record<string, unknown>): readonly string[] {
    return requiredArray(detail.apps, "Codex plugin detail apps").map((app) => {
      if (!isRecord(app)) {
        throw new Error("Codex plugin app mapping is invalid.");
      }
      return requiredString(app.id, "Codex plugin app ID");
    });
  }

  function codexObservedTools(statuses: readonly unknown[]): readonly {
    appId: string;
    name: string;
    ids: readonly string[];
  }[] {
    const servers = statuses.filter((status) => isRecord(status) && status.name === "codex_apps");
    const server = servers[0];
    if (
      servers.length !== 1 ||
      !isRecord(server) ||
      !isRecord(server.tools) ||
      server.toolsError != null
    ) {
      throw new Error("Codex plugin tool inventory is unavailable.");
    }
    return Object.entries(server.tools)
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([key, tool]) => {
        if (!isRecord(tool) || !isRecord(tool._meta)) {
          return [];
        }
        const appId = optionalString(tool._meta.connector_id);
        if (appId === undefined) {
          return [];
        }
        const name = requiredString(tool.name, "Codex native tool name");
        if (key !== name) {
          throw new Error("Codex plugin tool identities are ambiguous.");
        }
        const ids = [codexToolId(appId, name)];
        const metadata = tool._meta._codex_apps;
        const resource = isRecord(metadata)
          ? optionalString(metadata.resource_uri)?.split("/")
          : undefined;
        // Hosted catalogs use action names; native names may have renamed or collision-suffixed prefixes.
        // Bind through the server's /connector/target/action metadata, never a guessed display prefix.
        if (
          resource?.length === 4 &&
          resource[0] === "" &&
          resource[1] === appId &&
          resource[2] &&
          resource[3]
        ) {
          ids.push(codexToolId(appId, resource[3]));
        }
        return [{ appId, name, ids }];
      });
  }

  function codexAppToolSettings(
    selection: Record<string, unknown>,
    ownedAppIds: readonly string[],
    statuses: readonly unknown[],
  ): ReadonlyMap<string, Record<string, unknown>> {
    const policies = Object.entries(toolPolicies(selection));
    if (policies.length === 0) {
      return new Map();
    }
    const observed = codexObservedTools(statuses).filter((tool) =>
      ownedAppIds.includes(tool.appId),
    );
    const byApp = new Map<string, [string, Record<string, unknown>][]>();
    for (const [id, policy] of policies.sort(([left], [right]) => left.localeCompare(right))) {
      const [tool, duplicate] = observed.filter((tool) => tool.ids.includes(id));
      if (tool === undefined) {
        throw new Error("Codex plugin tool policy references an unknown or unowned tool.");
      }
      if (duplicate !== undefined) {
        throw new Error("Codex plugin tool policy identity is ambiguous.");
      }
      const { appId, name } = tool;
      const entries = byApp.get(appId) ?? [];
      if (entries.some(([existing]) => existing === name)) {
        throw new Error("Codex plugin tool policies target the same native tool.");
      }
      entries.push([
        name,
        {
          ...(policy.enabled === undefined ? {} : { enabled: policy.enabled }),
          ...(policy.approval === undefined
            ? {}
            : { approval_mode: codexApproval(policy.approval) }),
        },
      ]);
      byApp.set(appId, entries);
    }
    // Shared apps compare serialized policies; catalog/native aliases must produce the same order.
    return new Map(
      [...byApp].map(([appId, tools]) => [
        appId,
        { tools: Object.fromEntries(tools.sort(([left], [right]) => left.localeCompare(right))) },
      ]),
    );
  }

  function codexInstallPlan(selections: unknown, pluginReadResponses: readonly unknown[]) {
    validatePolicies("codex", selections);
    const details = detailsByNativeId(pluginReadResponses);
    const appEnablement = new Map<string, boolean>();
    return selectionEntries(selections).map(([pluginId, selection]) => {
      const nativeId = codexNativeIdFromPluginId(pluginId);
      const detail = details.get(nativeId);
      if (detail === undefined) {
        throw new Error("Codex plugin detail did not contain the selected plugin.");
      }
      assertCodexDetailRepresentable(detail);
      for (const appId of appIds(detail)) {
        const requested = selection.enabled === true;
        const existing = appEnablement.get(appId);
        // A shared native app cannot isolate an enabled selection from a disabled one.
        if (existing !== undefined && existing !== requested) {
          throw new Error("Codex plugin app mappings require conflicting enablement.");
        }
        appEnablement.set(appId, requested);
      }
      return {
        pluginId,
        nativeId,
        remotePluginId: detailRemotePluginId(detail),
        version: detailVersion(detail),
        registry: CODEX_MARKETPLACE,
      };
    });
  }

  function failedPluginIdSet(failures: unknown): ReadonlySet<string> {
    if (!Array.isArray(failures)) {
      return new Set();
    }
    return new Set(
      failures
        .map((failure) => (isRecord(failure) ? failure.pluginId : undefined))
        .filter(
          (pluginId): pluginId is string => typeof pluginId === "string" && pluginId.length > 0,
        ),
    );
  }

  function selectionEnabledAfterFailures(
    pluginId: string,
    selection: Record<string, unknown>,
    failures: ReadonlySet<string>,
  ): boolean {
    return selection.enabled === true && !failures.has(pluginId);
  }

  function codexOpenClawPluginEntry(
    pluginId: string,
    selection: Record<string, unknown>,
    slug: string,
    failures: ReadonlySet<string>,
  ): Record<string, unknown> {
    return {
      enabled: selectionEnabledAfterFailures(pluginId, selection, failures),
      marketplaceName: CODEX_MARKETPLACE,
      pluginName: slug,
      // OC routes remaining native prompts; false also projects the native category default.
      allow_destructive_actions:
        driverPolicy(selection).destructiveEnabled === false ? false : "auto",
    };
  }

  function codexBrokerOpenClawConfiguration(policy: unknown): Record<string, unknown> | undefined {
    if (!isRecord(policy)) {
      return undefined;
    }
    const host = requiredString(policy.host, "Repository credential broker host");
    const domains = isRecord(policy.domains) ? policy.domains : {};
    for (const decision of Object.values(domains)) {
      if (decision !== "allow" && decision !== "deny") {
        throw new Error("Repository credential broker domains are invalid.");
      }
    }
    return {
      appServer: {
        networkProxy: {
          enabled: true,
          mode: "full",
          allowLocalBinding: true,
          readOnlyPaths: CODEX_REPOSITORY_BROKER_READ_ONLY_PATHS,
          domains: { ...domains, [host]: "allow" },
        },
      },
    };
  }

  function codexOpenClawConfiguration(
    selections: unknown,
    failures: unknown = [],
    repositoryBrokerNetworkPolicy: unknown = undefined,
    defaultApprovers?: unknown,
  ): Record<string, unknown> | undefined {
    validatePolicies("codex", selections, defaultApprovers);
    const selected = selectionEntries(selections);
    const brokerConfiguration = codexBrokerOpenClawConfiguration(repositoryBrokerNetworkPolicy);
    const failedPluginIds = failedPluginIdSet(failures);
    const pluginFilesystemConfiguration =
      brokerConfiguration !== undefined
        ? {}
        : {
            appServer: {
              networkProxy: {
                // The native sandbox helper is packaged here even without selected plugins.
                readOnlyPaths:
                  selected.length === 0
                    ? CODEX_RUNTIME_READ_ONLY_PATHS
                    : CODEX_PLUGIN_READ_ONLY_PATHS,
              },
            },
          };
    return {
      ...pluginApprovalOverlay("codex", selections, defaultApprovers),
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: {
              ...brokerConfiguration,
              ...pluginFilesystemConfiguration,
              ...(selected.length === 0
                ? {}
                : {
                    codexPlugins: {
                      enabled: true,
                      allow_all_plugins: false,
                      plugins: Object.fromEntries(
                        selected.map(([pluginId, selection]) => {
                          const slug = codexSlugFromNativeId(codexNativeIdFromPluginId(pluginId));
                          return [
                            slug,
                            codexOpenClawPluginEntry(pluginId, selection, slug, failedPluginIds),
                          ];
                        }),
                      ),
                    },
                  }),
            },
          },
        },
      },
    };
  }

  function codexRuntimeArtifact(
    selections: unknown,
    pluginReadResponses: readonly unknown[],
    failures: unknown = [],
    toolStatuses: readonly unknown[] = [],
  ): Record<string, unknown> {
    validatePolicies("codex", selections);
    const selected = selectionEntries(selections);
    if (selected.length === 0) {
      return { kind: "codex", configuration: CODEX_NO_PLUGIN_CONFIGURATION, installs: [] };
    }
    const byNativeId = detailsByNativeId(pluginReadResponses);
    const failedPluginIds = failedPluginIdSet(failures);
    const appEntries = new Map<string, Record<string, unknown>>();
    const disabledAppIds = new Set<string>();
    const installs = codexInstallPlan(selections, pluginReadResponses);
    for (const [pluginId, selection] of selected) {
      const nativeId = codexNativeIdFromPluginId(pluginId);
      const detail = byNativeId.get(nativeId);
      if (detail === undefined) {
        throw new Error("Codex plugin detail did not contain the selected plugin.");
      }
      assertCodexDetailRepresentable(detail);
      if (selectionEnabledAfterFailures(pluginId, selection, failedPluginIds)) {
        const policy = driverPolicy(selection);
        const toolDefaults = defaults(selection);
        const toolSettings = codexAppToolSettings(selection, appIds(detail), toolStatuses);
        for (const appId of appIds(detail)) {
          const existing = appEntries.get(appId);
          const requested = {
            enabled: true,
            default_tools_approval_mode: codexApproval(toolDefaults.approval ?? "provider_default"),
            ...(toolDefaults.enabled === undefined
              ? {}
              : { default_tools_enabled: toolDefaults.enabled }),
            ...(toolDefaults.reviewer === undefined
              ? {}
              : { approvals_reviewer: toolDefaults.reviewer === "human" ? "user" : "auto_review" }),
            ...(policy.destructiveEnabled === undefined
              ? {}
              : { destructive_enabled: policy.destructiveEnabled }),
            ...toolSettings.get(appId),
          };
          if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(requested)) {
            throw new Error("Codex plugin app mappings require conflicting approval policy.");
          }
          appEntries.set(appId, requested);
        }
      } else if (failedPluginIds.has(pluginId) && selection.enabled === true) {
        for (const appId of appIds(detail)) {
          disabledAppIds.add(appId);
        }
      }
    }
    return {
      kind: "codex",
      configuration: {
        ...CODEX_SELECTED_PLUGIN_BASE_CONFIGURATION,
        apps: {
          _default: { enabled: false },
          ...Object.fromEntries(
            [...disabledAppIds]
              .filter((appId) => !appEntries.has(appId))
              .map((appId) => [appId, { enabled: false }]),
          ),
          ...Object.fromEntries(appEntries),
        },
      },
      installs,
    };
  }

  function openClawRuntimeArtifact(
    selections: unknown,
    failures: unknown = [],
    defaultApprovers?: unknown,
  ): Record<string, unknown> {
    validatePolicies("openclaw", selections, defaultApprovers);
    const failedPluginIds = failedPluginIdSet(failures);
    const entries: Record<string, unknown> = {};
    const installs: Record<string, unknown>[] = [];
    const alsoAllow: string[] = [];
    const deny: string[] = [];
    for (const [pluginId, selection] of selectionEntries(selections)) {
      const nativeId = pluginId.startsWith(OCC_DRIVER_ID + ":")
        ? pluginId.slice((OCC_DRIVER_ID + ":").length)
        : pluginId;
      const descriptor = nativeCatalog.find((entry) => entry.nativeId === nativeId);
      if (descriptor === undefined) {
        throw new Error("Unknown OpenClaw plugin selection.");
      }
      const policies = toolPolicies(selection);
      const toolDefaults = defaults(selection);
      const deniedTools = descriptor.toolNames.filter((toolId) => {
        const policy = Object.hasOwn(policies, toolId) ? policies[toolId]! : {};
        return (policy.enabled ?? toolDefaults.enabled ?? true) === false;
      });
      const pluginEnabled = selectionEnabledAfterFailures(pluginId, selection, failedPluginIds);
      if (pluginEnabled) {
        deny.push(...deniedTools);
      }
      entries[nativeId] = {
        enabled: pluginEnabled,
      };
      installs.push({
        pluginId,
        nativeId,
        packageName: descriptor.packageName,
        version: descriptor.version,
        integrity: descriptor.integrity,
      });
      if (pluginEnabled) {
        alsoAllow.push(nativeId);
      }
    }
    // A deny matching an owner ID suppresses every tool it owns. Reject a
    // partial denial that would silently suppress an allowed sibling tool.
    for (const descriptor of nativeCatalog) {
      if (
        deny.includes(descriptor.nativeId) &&
        descriptor.toolNames.some((name) => !deny.includes(name))
      ) {
        throw new Error(
          "OpenClaw cannot express this per-tool denial without blocking sibling tools.",
        );
      }
    }
    return {
      kind: "openclaw",
      configuration: {
        ...pluginApprovalOverlay("openclaw", selections, defaultApprovers),
        plugins: { entries },
        ...(alsoAllow.length === 0
          ? {}
          : { tools: { alsoAllow, ...(deny.length === 0 ? {} : { deny }) } }),
      },
      installs,
    };
  }

  function openClawCatalogEntries(): readonly Record<string, unknown>[] {
    return nativeCatalog.map((entry) => ({
      id: OCC_DRIVER_ID + ":" + entry.nativeId,
      name: entry.name,
      tools: entry.toolNames.map((id) => ({ id, name: id, ownerId: entry.nativeId })),
    }));
  }

  return {
    codexCatalogEntry,
    codexCatalogEntries,
    codexOpenClawConfiguration,
    codexInstallPlan,
    codexNeedsToolInventory,
    validatePolicies,
    codexReadParamsForSelections,
    codexRuntimeArtifact,
    openClawCatalogEntries,
    openClawRuntimeArtifact,
  };
}

export const PLUGIN_RUNTIME_TRANSLATOR_SOURCE = `() => (${createPluginRuntimeTranslator.toString()})(${JSON.stringify(OPENCLAW_PLUGIN_CATALOG)})`;

type Translator = ReturnType<typeof createPluginRuntimeTranslator>;

export const pluginRuntimeTranslator: Translator =
  createPluginRuntimeTranslator(OPENCLAW_PLUGIN_CATALOG);

export function codexRuntimeArtifact(
  selections: PluginDesiredState,
  pluginReadResponses: readonly unknown[],
  failures: PluginRuntimeFailureInput = [],
  toolStatuses: readonly unknown[] = [],
): PluginRuntimeResolvedArtifacts {
  return pluginRuntimeTranslator.codexRuntimeArtifact(
    selections,
    pluginReadResponses,
    failures,
    toolStatuses,
  ) as PluginRuntimeResolvedArtifacts;
}

export function codexOpenClawConfiguration(
  selections: PluginDesiredState,
  failures: PluginRuntimeFailureInput = [],
  repositoryBrokerNetworkPolicy?: CodexRepositoryBrokerNetworkPolicy,
  defaultApprovers?: PluginApprovers,
): OpenClawConfigurationDocument | undefined {
  return pluginRuntimeTranslator.codexOpenClawConfiguration(
    selections,
    failures,
    repositoryBrokerNetworkPolicy,
    defaultApprovers,
  ) as OpenClawConfigurationDocument | undefined;
}

export function openClawRuntimeArtifact(
  selections: PluginDesiredState,
  failures: PluginRuntimeFailureInput = [],
  defaultApprovers?: PluginApprovers,
): PluginRuntimeResolvedArtifacts {
  return pluginRuntimeTranslator.openClawRuntimeArtifact(
    selections,
    failures,
    defaultApprovers,
  ) as PluginRuntimeResolvedArtifacts;
}

export function openClawCatalogEntries(): readonly PluginCatalogEntry[] {
  return pluginRuntimeTranslator.openClawCatalogEntries() as unknown as readonly PluginCatalogEntry[];
}

export function codexCatalogEntries(listResponse: unknown): readonly PluginCatalogEntry[] {
  return pluginRuntimeTranslator.codexCatalogEntries(
    listResponse,
  ) as unknown as readonly PluginCatalogEntry[];
}

export function codexRuntimeReadParams(
  selections: PluginDesiredState,
  listResponse: unknown,
): readonly Readonly<Record<string, string>>[] {
  return pluginRuntimeTranslator.codexReadParamsForSelections(selections, listResponse);
}

export function validatePolicies(
  kind: "codex" | "openclaw",
  selections: PluginDesiredState,
  defaultApprovers?: PluginApprovers,
): void {
  pluginRuntimeTranslator.validatePolicies(kind, selections, defaultApprovers);
}
