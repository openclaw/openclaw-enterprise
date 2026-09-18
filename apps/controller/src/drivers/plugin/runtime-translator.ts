import type {
  OpenClawConfigurationDocument,
  PluginCatalogEntry,
  PluginDesiredState,
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

export type CodexPluginCatalogReader = {
  listCatalog(signal?: AbortSignal): Promise<readonly PluginCatalogEntry[]>;
};

export function createPluginRuntimeTranslator() {
  const OCC_DRIVER_ID = "occ-plugin";
  const OCC_IMPLEMENTATION = "occ/openclaw-plugin";
  const CODEX_DRIVER_ID = "codex-plugin";
  const CODEX_IMPLEMENTATION = "occ/codex-plugin";
  const CODEX_MARKETPLACE = "openai-curated-remote";
  const OCC_DIFFS_VERSION = "2026.8.2";
  const OCC_DIFFS_INTEGRITY =
    "sha512-5VTDNEo7D3iOgRoL5C31JPTbA/EXQEFRuxOvLy67IMFmOajwroGsUMWeuKkmqzFbPNQxvn7GACDSr/5Vmpx3/g==";

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

  function pluginApprovalMode(selection: Record<string, unknown>): string {
    const mode = requiredString(selection.approvalMode, "Plugin approval mode");
    if (!["always", "auto", "never", "prompt"].includes(mode)) {
      throw new Error("Plugin approval mode is unsupported.");
    }
    return mode;
  }

  function reviewer(selection: Record<string, unknown>): string | undefined {
    const value = selection.approvalsReviewer;
    if (value === undefined) {
      return undefined;
    }
    if (value === "user" || value === "auto_review") {
      return value;
    }
    throw new Error("Plugin approvals reviewer is unsupported.");
  }

  function enabled(selection: Record<string, unknown>): boolean {
    const value = selection.enabled;
    if (value === undefined) {
      return true;
    }
    if (typeof value !== "boolean") {
      throw new Error("Plugin enabled must be a boolean.");
    }
    return value;
  }

  function enabledByPolicy(selection: Record<string, unknown>): boolean {
    return enabled(selection) && pluginApprovalMode(selection) !== "never";
  }

  function assertNoToolPolicy(selection: Record<string, unknown>): void {
    if (selection.destructiveActions !== undefined || selection.writes !== undefined) {
      throw new Error("Codex plugin category policy is unavailable at startup.");
    }
    if (selection.tools !== undefined) {
      throw new Error("Codex plugin tool policy is unavailable at startup.");
    }
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

  function assertCodexDetailRepresentable(
    selection: Record<string, unknown>,
    detail: Record<string, unknown>,
  ): void {
    const mode = pluginApprovalMode(selection);
    if (!["always", "auto", "never"].includes(mode)) {
      throw new Error("Codex plugin approval policy is unavailable at startup.");
    }
    if (mode === "always" && reviewer(selection) === "auto_review") {
      throw new Error("Codex AutoReview cannot represent always-approved plugin calls.");
    }
    assertNoToolPolicy(selection);
    detailVersion(detail);
    if (requiredArray(detail.apps, "Codex plugin detail apps").length === 0) {
      throw new Error("Codex plugin detail does not expose an app mapping.");
    }
    for (const field of ["appTemplates", "hooks", "skills", "mcpServers"]) {
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

  function codexOpenClawPluginEntry(
    selection: Record<string, unknown>,
    slug: string,
  ): Record<string, unknown> {
    return {
      enabled: enabledByPolicy(selection),
      marketplaceName: CODEX_MARKETPLACE,
      pluginName: slug,
      allow_destructive_actions: pluginApprovalMode(selection) === "always" ? true : "auto",
    };
  }

  function codexOpenClawConfiguration(selections: unknown): Record<string, unknown> | undefined {
    const selected = selectionEntries(selections);
    if (selected.length === 0) {
      return undefined;
    }
    return {
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: {
              codexPlugins: {
                enabled: true,
                allow_all_plugins: false,
                plugins: Object.fromEntries(
                  selected.map(([pluginId, selection]) => {
                    const slug = codexSlugFromNativeId(codexNativeIdFromPluginId(pluginId));
                    return [slug, codexOpenClawPluginEntry(selection, slug)];
                  }),
                ),
              },
            },
          },
        },
      },
    };
  }

  function codexRuntimeArtifact(
    selections: unknown,
    pluginReadResponses: readonly unknown[],
  ): Record<string, unknown> {
    const selected = selectionEntries(selections);
    if (selected.length === 0) {
      return { kind: "codex", configuration: CODEX_NO_PLUGIN_CONFIGURATION, installs: [] };
    }
    const byNativeId = detailsByNativeId(pluginReadResponses);
    const appEntries = new Map<string, Record<string, unknown>>();
    const installs: Record<string, unknown>[] = [];
    for (const [pluginId, selection] of selected) {
      const nativeId = codexNativeIdFromPluginId(pluginId);
      const detail = byNativeId.get(nativeId);
      if (detail === undefined) {
        throw new Error("Codex plugin detail did not contain the selected plugin.");
      }
      assertCodexDetailRepresentable(selection, detail);
      const pluginVersion = detailVersion(detail);
      const remotePluginId = detailRemotePluginId(detail);
      const enterprisePluginId = codexPluginId(nativeId);
      if (enabledByPolicy(selection)) {
        const reviewerValue = reviewer(selection);
        const defaultApprovalMode = pluginApprovalMode(selection) === "always" ? "approve" : "auto";
        for (const appId of appIds(detail)) {
          const existing = appEntries.get(appId);
          const requested = {
            enabled: true,
            default_tools_approval_mode: defaultApprovalMode,
            ...(reviewerValue === undefined ? {} : { approvals_reviewer: reviewerValue }),
          };
          const existingReviewer = existing?.approvals_reviewer;
          if (
            existing !== undefined &&
            (existingReviewer !== requested.approvals_reviewer ||
              existing.default_tools_approval_mode !== requested.default_tools_approval_mode)
          ) {
            throw new Error("Codex plugin app mappings require conflicting approval policy.");
          }
          appEntries.set(appId, requested);
        }
      }
      installs.push({
        pluginId: enterprisePluginId,
        nativeId,
        remotePluginId,
        version: pluginVersion,
        registry: CODEX_MARKETPLACE,
      });
    }
    return {
      kind: "codex",
      configuration: {
        ...CODEX_SELECTED_PLUGIN_BASE_CONFIGURATION,
        apps: {
          _default: { enabled: false },
          ...Object.fromEntries(appEntries),
        },
      },
      installs,
    };
  }

  function openClawRuntimeArtifact(selections: unknown): Record<string, unknown> {
    const entries: Record<string, unknown> = {};
    const installs: Record<string, unknown>[] = [];
    const alsoAllow: string[] = [];
    for (const [pluginId, selection] of selectionEntries(selections)) {
      const nativeId = pluginId.startsWith(OCC_DRIVER_ID + ":")
        ? pluginId.slice((OCC_DRIVER_ID + ":").length)
        : pluginId;
      if (nativeId !== "diffs") {
        throw new Error("Unknown OpenClaw plugin selection.");
      }
      if (reviewer(selection) !== undefined) {
        throw new Error("OpenClaw plugin reviewer selection is unsupported.");
      }
      const mode = pluginApprovalMode(selection);
      if (!["always", "never"].includes(mode)) {
        throw new Error("OpenClaw plugin approval policy is unsupported.");
      }
      if (selection.destructiveActions !== undefined || selection.writes !== undefined) {
        throw new Error("OpenClaw plugin category policy is unsupported.");
      }
      if (selection.tools !== undefined) {
        throw new Error("OpenClaw plugin tool policy is unavailable.");
      }
      entries[nativeId] = { enabled: enabledByPolicy(selection) };
      installs.push({
        pluginId: OCC_DRIVER_ID + ":" + nativeId,
        nativeId,
        packageName: "@openclaw/diffs",
        version: OCC_DIFFS_VERSION,
        integrity: OCC_DIFFS_INTEGRITY,
      });
      if (enabledByPolicy(selection)) {
        alsoAllow.push(nativeId);
      }
    }
    return {
      kind: "openclaw",
      configuration: {
        plugins: { entries },
        ...(alsoAllow.length === 0 ? {} : { tools: { alsoAllow } }),
      },
      installs,
    };
  }

  function openClawCatalogEntries(): readonly Record<string, unknown>[] {
    const pluginId = OCC_DRIVER_ID + ":diffs";
    return [
      {
        id: pluginId,
        name: "Diffs",
        tools: null,
      },
    ];
  }

  return {
    codexCatalogEntry,
    codexCatalogEntries,
    codexOpenClawConfiguration,
    codexReadParamsForSelections,
    codexRuntimeArtifact,
    openClawCatalogEntries,
    openClawRuntimeArtifact,
  };
}

export const PLUGIN_RUNTIME_TRANSLATOR_SOURCE = createPluginRuntimeTranslator.toString();

type Translator = ReturnType<typeof createPluginRuntimeTranslator>;

export const pluginRuntimeTranslator: Translator = createPluginRuntimeTranslator();

export function codexRuntimeArtifact(
  selections: PluginDesiredState,
  pluginReadResponses: readonly unknown[],
): PluginRuntimeResolvedArtifacts {
  return pluginRuntimeTranslator.codexRuntimeArtifact(
    selections,
    pluginReadResponses,
  ) as PluginRuntimeResolvedArtifacts;
}

export function codexOpenClawConfiguration(
  selections: PluginDesiredState,
): OpenClawConfigurationDocument | undefined {
  return pluginRuntimeTranslator.codexOpenClawConfiguration(selections) as
    OpenClawConfigurationDocument | undefined;
}

export function openClawRuntimeArtifact(
  selections: PluginDesiredState,
): PluginRuntimeResolvedArtifacts {
  return pluginRuntimeTranslator.openClawRuntimeArtifact(
    selections,
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
