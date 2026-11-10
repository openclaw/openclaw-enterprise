import type {
  OpenClawConfigurationDocument,
  PluginCatalogEntry,
  PluginDesiredState,
} from "@openclaw-enterprise/contracts";
import { keyedSettingPath } from "@openclaw-enterprise/occ";
import { asRecord } from "@openclaw-enterprise/utils";

/**
 * A tool policy a refusal names: top-level `tools` without `entry`, else
 * `agents.entries.<entry>.tools`, narrowed to `byProvider.<provider>` when `provider` is set.
 */
export interface OpenClawToolPolicySetting {
  readonly entry?: string;
  readonly provider?: string;
}

/** An enabled selection the Configuration leaves without any tool, and why. */
export type DeniedOpenClawSelection =
  | {
      readonly pluginId: string;
      readonly kind: "deny";
      /** Each deny list the refusal names, in the order OpenClaw applies them. */
      readonly lists: readonly OpenClawToolPolicySetting[];
    }
  | {
      readonly pluginId: string;
      readonly kind: "entryDenyAll";
      /** The deny-all lists of one roster entry among several, in the order OpenClaw applies them. */
      readonly lists: readonly OpenClawToolPolicySetting[];
    }
  | {
      readonly pluginId: string;
      readonly kind: "alsoAllow";
      /** The sole roster entry whose `tools.alsoAllow` drops the plugin's grant. */
      readonly entry: string;
      /** The deny lists that block the plugin tools that list does name, if any. */
      readonly lists?: readonly OpenClawToolPolicySetting[];
    };

type CatalogTool = NonNullable<PluginCatalogEntry["tools"]>[number];

interface DenyList extends OpenClawToolPolicySetting {
  readonly patterns: readonly string[];
}

// The pinned Gateway's built-in profiles whose allowlist names core tools only; `full` allows
// `*`, and an unknown profile adds no profile step (resolveCoreToolProfilePolicy). A plugin's
// manifest can add its tools to a profile (toolMetadata profiles); no catalog plugin does, so a
// catalog plugin that starts to must update this check.
const RESTRICTIVE_PROFILES = new Set(["minimal", "coding", "messaging"]);

/**
 * Returns the first enabled OpenClaw plugin selection the Configuration leaves without any tool
 * in every turn of an Agent, or undefined.
 *
 * Deny lists: OpenClaw applies each as its own step, deny wins, before any allowlist. These are
 * top-level `tools.deny`, `tools.byProvider.<provider>.deny`, and the same two lists of the
 * Agent's `agents.entries` entry (tool-policy-pipeline). An entry matches a tool by `*`, a `*`
 * glob, the tool's name, its plugin's ID, or `group:plugins`. With a deny-all list, the
 * allowlist entry the translator adds for the plugin leaves no callable tool, so every turn
 * fails (findings 508, 1848, 1855). Callers name the settings, never their entries. Native
 * aliases and renames (`bash`, `apply-patch`, ...) never name a catalog tool: the catalog
 * refuses reserved names.
 *
 * Provider: a `byProvider` key is a provider (`openai`) or a provider and model
 * (`openai/gpt-5.1`), trimmed and lowercased; the model key wins over the provider key, and only
 * one of them applies (resolveProviderToolPolicyEntry). Every Agent of a Configuration shares
 * the primary model (resolveConfiguredHarnessId), so the check uses its provider. The Gateway
 * matches a model key against the model ID as provider manifests and plugins rewrite it
 * (normalizeModelRef: aliases, prefixes), which admission cannot know, so a `byProvider` object
 * with a model key for that provider is not checked at all: either key may apply. A fallback
 * runs only when the primary fails, so it is not checked.
 *
 * Roster: the pinned Gateway resolves an Agent's tool policy from its own entry's `tools` only
 * (resolveAgentConfig), never merged with `agents.defaults`, whose schema has no `tools`;
 * Configuration saves refuse `agents.list`. With no roster, or an empty one, the implicit main
 * Agent has no entry policy. With one entry, every session runs as that entry, so its lists
 * count like the top-level ones. With several (agents.ownership "explicit"), each session names
 * its Agent: denying a plugin to some of them is a valid setup, but an entry list that denies
 * every tool (`*`) fails every turn of its sessions once a plugin is selected.
 *
 * Profile grant: the translator grants the plugin through top-level `tools.alsoAllow`. Under a
 * built-in profile that lists core tools only, an entry's own `tools.alsoAllow` replaces the
 * top-level list at the profile step (resolveEffectiveToolPolicy), so with one entry none of
 * the plugin's tools reach any turn unless that list names them (finding 1857). A list meant to
 * add tools then removes the plugin, so it is refused, also when the deny lists block every
 * plugin tool it names: no tool survives both. An entry `tools.allow` that leaves the plugin out
 * is a deliberate restriction and is not refused.
 */
export function deniedOpenClawSelection(
  catalog: readonly PluginCatalogEntry[],
  selections: PluginDesiredState,
  configuration: Readonly<OpenClawConfigurationDocument>,
): DeniedOpenClawSelection | undefined {
  const document = asRecord(configuration);
  const provider = primaryProvider(document);
  const globalTools = asRecord(document?.tools);
  const globalLists = toolDenyLists(globalTools, provider, {});
  const rosterEntries = Object.entries(asRecord(asRecord(document?.agents)?.entries) ?? {});
  const roster = rosterEntries.map(([key, entry]) => ({
    key,
    lists: toolDenyLists(asRecord(asRecord(entry)?.tools), provider, { entry: key }),
  }));
  const entries =
    roster.length === 1
      ? roster
      : roster
          .map(({ key, lists }) => ({
            key,
            lists: lists.filter(({ patterns }) =>
              patterns.some((pattern) => /^\*+$/.test(pattern)),
            ),
          }))
          .filter(({ lists }) => lists.length > 0);
  const shadowingEntry = soleEntryShadowingGrant(globalTools, rosterEntries);
  if (
    globalLists.length === 0 &&
    entries.every(({ lists }) => lists.length === 0) &&
    shadowingEntry === undefined
  ) {
    return undefined;
  }
  for (const [pluginId, selection] of Object.entries(selections)) {
    if (selection?.enabled !== true) {
      continue;
    }
    // Selections name a plugin by catalog ID or by its native ID alone.
    const tools = catalog.find(
      (entry) => entry.id === pluginId || entry.id.endsWith(`:${pluginId}`),
    )?.tools;
    if (!Array.isArray(tools) || tools.length === 0) {
      continue;
    }
    const global = blockingLists(tools, globalLists);
    // A list that names an entry comes first, so the refusal points at the Agent it blocks,
    // unless it only adds to top-level lists that already block every tool together.
    for (const { lists } of entries) {
      const blocking = blockingLists(tools, [...globalLists, ...lists]);
      if (
        blocking?.lists.some(({ entry }) => entry !== undefined) === true &&
        (blocking.alone || global === undefined)
      ) {
        // With several entries only that entry's turns fail: the operator may want a tool-less
        // Agent, so the refusal says why it cannot run beside a plugin selection (finding 1860).
        if (roster.length > 1 && blocking.lists.every(({ entry }) => entry !== undefined)) {
          return { pluginId, kind: "entryDenyAll", lists: blocking.lists.map(setting) };
        }
        return { pluginId, kind: "deny", lists: blocking.lists.map(setting) };
      }
    }
    if (global !== undefined) {
      return { pluginId, kind: "deny", lists: global.lists.map(setting) };
    }
    if (shadowingEntry !== undefined) {
      // Only the tools the entry's list names pass the profile step; refused when the deny
      // lists, which then all apply, block each of them too.
      const named = tools.filter((tool) => matches(shadowingEntry.patterns, tool));
      const lists = [...globalLists, ...(entries[0]?.lists ?? [])].filter(({ patterns }) =>
        named.some((tool) => matches(patterns, tool)),
      );
      if (named.every((tool) => lists.some(({ patterns }) => matches(patterns, tool)))) {
        return {
          pluginId,
          kind: "alsoAllow",
          entry: shadowingEntry.key,
          ...(lists.length === 0 ? {} : { lists: lists.map(setting) }),
        };
      }
    }
  }
  return undefined;
}

/** The refusal for a denied selection: it names the settings, never their entries. */
export function openClawToolDenialMessage(denied: DeniedOpenClawSelection): string {
  const { pluginId } = denied;
  if (denied.kind === "alsoAllow") {
    const alsoAllow = { entry: denied.entry, suffix: "alsoAllow" };
    if (denied.lists === undefined || denied.lists.length === 0) {
      return fitted(
        [alsoAllow],
        (path) =>
          `Configuration setting ${path} overrides the plugin's tool grant under a tool profile, which hides every tool of plugin ${pluginId}; add the plugin to that list or deselect the plugin.`,
      );
    }
    return fitted(
      [alsoAllow, ...denied.lists.map((list) => ({ ...list, suffix: "deny" }))],
      (paths) =>
        `Configuration settings ${paths} together hide every tool of plugin ${pluginId}; name its tools in alsoAllow, remove the deny entries, or deselect the plugin.`,
    );
  }
  const several = denied.lists.length > 1;
  if (denied.kind === "entryDenyAll") {
    // OpenClaw counts the plugin's grant as an explicit allowlist, which a deny-all list
    // empties, so every turn of that Agent fails with "No callable tools remain". An entry
    // holds at most two lists, its tools.deny and then one byProvider list; when both deny
    // every tool, the second is named relative to the first so both fit the cap.
    return fitted(
      [{ ...denied.lists[0]!, suffix: "deny" }],
      (path) =>
        `Configuration setting ${path}${several ? " and its byProvider list deny" : " denies"} every tool, so every turn of that Agent fails with plugin ${pluginId} selected; remove "*"${several ? " from both" : ""} or move the Agent to a Configuration without plugins.`,
    );
  }
  return fitted(
    denied.lists.map((list) => ({ ...list, suffix: "deny" })),
    (paths) =>
      `Configuration ${several ? "settings" : "setting"} ${paths} ${several ? "block" : "blocks"} every tool of plugin ${pluginId}; remove the matching deny ${several ? "entries" : "entry"} or deselect the plugin.`,
  );
}

interface NamedSetting extends OpenClawToolPolicySetting {
  readonly suffix: string;
}

// The HTTP error contract caps messages at 256 characters. When the paths do not fit, every
// submitted key is cut with … to the longest length that fits, so each path keeps the setting
// it names (`.tools.deny`, `.byProvider[...].deny`, `.tools.alsoAllow`).
const MESSAGE_CAP = 256;

function fitted(settings: readonly NamedSetting[], render: (paths: string) => string): string {
  const message = (cut: (key: string) => string) => {
    const paths = settings.map(({ entry, provider, suffix }) => {
      const tools =
        entry === undefined ? "tools" : `${keyedSettingPath("agents.entries", cut(entry))}.tools`;
      const policy =
        provider === undefined ? tools : keyedSettingPath(`${tools}.byProvider`, cut(provider));
      return `${policy}.${suffix}`;
    });
    return render(
      paths.length === 1 ? paths[0]! : `${paths.slice(0, -1).join(", ")} and ${paths.at(-1)!}`,
    );
  };
  const fits = (text: string) => Array.from(text).length <= MESSAGE_CAP;
  const full = message((key) => key);
  if (fits(full)) {
    return full;
  }
  const cutTo = (limit: number) => (key: string) => {
    const characters = Array.from(key);
    return characters.length <= limit ? key : `${characters.slice(0, limit - 1).join("")}…`;
  };
  // The longest key length that fits, by bisection; 1 keeps only the … of each long key.
  let low = 1;
  let high = Math.max(
    ...settings.flatMap(({ entry, provider }) =>
      [entry, provider].filter((key) => key !== undefined).map((key) => Array.from(key).length),
    ),
  );
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(message(cutTo(middle)))) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  // Several long keys can leave no length that fits: cut the end, as the HTTP layer would.
  const cut = Array.from(message(cutTo(low)));
  return cut.length <= MESSAGE_CAP ? cut.join("") : `${cut.slice(0, MESSAGE_CAP - 1).join("")}…`;
}

/**
 * The deny lists of one `tools` object that hold an entry: its own `deny`, then the `deny` of
 * the `byProvider` policy the primary model's provider selects.
 */
function toolDenyLists(
  tools: Readonly<Record<string, unknown>> | undefined,
  provider: string | undefined,
  at: { readonly entry?: string },
): DenyList[] {
  const lists: DenyList[] = [{ ...at, patterns: policyPatterns(tools?.deny) }];
  const selected = providerPolicy(tools?.byProvider, provider);
  if (selected !== undefined) {
    lists.push({ ...at, provider: selected.key, patterns: policyPatterns(selected.policy.deny) });
  }
  return lists.filter(({ patterns }) => patterns.length > 0);
}

/**
 * The lists to name when they leave the plugin no tool: each one that blocks every tool on its
 * own, else every list that blocks some tool when only together they block all of them.
 */
function blockingLists(
  tools: readonly CatalogTool[],
  lists: readonly DenyList[],
): { readonly lists: readonly DenyList[]; readonly alone: boolean } | undefined {
  const alone = lists.filter(({ patterns }) => tools.every((tool) => matches(patterns, tool)));
  if (alone.length > 0) {
    return { lists: alone, alone: true };
  }
  if (!tools.every((tool) => lists.some(({ patterns }) => matches(patterns, tool)))) {
    return undefined;
  }
  return {
    lists: lists.filter(({ patterns }) => tools.some((tool) => matches(patterns, tool))),
    alone: false,
  };
}

function setting({ entry, provider }: DenyList): OpenClawToolPolicySetting {
  return {
    ...(entry === undefined ? {} : { entry }),
    ...(provider === undefined ? {} : { provider }),
  };
}

/**
 * The sole roster entry whose own `tools.alsoAllow` replaces the top-level grant under a profile
 * that lists core tools only (its own profile, else the top-level one).
 */
function soleEntryShadowingGrant(
  globalTools: Readonly<Record<string, unknown>> | undefined,
  roster: readonly [string, unknown][],
): { readonly key: string; readonly patterns: readonly string[] } | undefined {
  if (roster.length !== 1) {
    return undefined;
  }
  const [key, entry] = roster[0]!;
  const tools = asRecord(asRecord(entry)?.tools);
  const profile = tools?.profile ?? globalTools?.profile;
  if (
    !Array.isArray(tools?.alsoAllow) ||
    typeof profile !== "string" ||
    !RESTRICTIVE_PROFILES.has(profile)
  ) {
    return undefined;
  }
  return { key, patterns: policyPatterns(tools.alsoAllow) };
}

/**
 * The provider OpenClaw resolves from the primary model reference (parseModelRef, trimmed and
 * lowercased by normalizeProviderId): agents.defaults.model, else the first agents.entries
 * model, which admission requires to match.
 */
function primaryProvider(
  document: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const agents = asRecord(document?.agents);
  const selection =
    asRecord(agents?.defaults)?.model ??
    Object.values(asRecord(agents?.entries) ?? {})
      .map((entry) => asRecord(entry)?.model)
      .find((value) => value !== undefined);
  const reference = typeof selection === "string" ? selection : asRecord(selection)?.primary;
  if (typeof reference !== "string") {
    return undefined;
  }
  const trimmed = reference.trim();
  if (trimmed.toLowerCase() === "openrouter:auto") {
    return "openrouter";
  }
  const slash = trimmed.indexOf("/");
  const provider = trimmed.slice(0, Math.max(slash, 0)).trim().toLowerCase();
  return slash < 0 || provider.length === 0 || trimmed.slice(slash + 1).trim().length === 0
    ? undefined
    : provider;
}

/** OpenClaw's normalizeToolProviderPolicyKey: trimmed, lowercased, `provider[/model]`. */
function providerPolicyKey(key: string): string {
  const normalized = key.trim().toLowerCase();
  const slash = normalized.indexOf("/");
  if (slash <= 0) {
    return normalized;
  }
  const provider = normalized.slice(0, slash).trim();
  const modelId = normalized.slice(slash + 1);
  return modelId.length > 0 ? `${provider}/${modelId}` : provider;
}

/**
 * The `byProvider` policy the primary model's provider selects (resolveProviderToolPolicyEntry),
 * when no model key for that provider can take its place. Keys that normalize alike keep the
 * first one written in normalized form, else the first one.
 */
function providerPolicy(
  byProvider: unknown,
  primary: string | undefined,
): { readonly key: string; readonly policy: Readonly<Record<string, unknown>> } | undefined {
  const entries = asRecord(byProvider);
  if (entries === undefined || primary === undefined) {
    return undefined;
  }
  const lookup = new Map<
    string,
    { key: string; policy: Readonly<Record<string, unknown>>; canonical: boolean }
  >();
  for (const [key, value] of Object.entries(entries)) {
    const policy = asRecord(value);
    const normalized = providerPolicyKey(key);
    if (policy === undefined || normalized.length === 0) {
      continue;
    }
    const canonical = key.trim().toLowerCase() === normalized;
    const existing = lookup.get(normalized);
    if (existing === undefined || (canonical && !existing.canonical)) {
      lookup.set(normalized, { key, policy, canonical });
    }
  }
  // Which model key the Gateway matches depends on how it rewrites the model ID, so a
  // `byProvider` object with any model key for this provider decides nothing here.
  const provider = providerPolicyKey(primary);
  if ([...lookup.keys()].some((key) => key.startsWith(`${provider}/`))) {
    return undefined;
  }
  const match = lookup.get(provider);
  return match === undefined ? undefined : { key: match.key, policy: match.policy };
}

function policyPatterns(list: unknown): readonly string[] {
  return Array.isArray(list)
    ? list
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0)
    : [];
}

function matches(patterns: readonly string[], tool: CatalogTool): boolean {
  return patterns.some(
    (pattern) =>
      pattern === tool.id ||
      pattern === tool.ownerId ||
      pattern === "group:plugins" ||
      (pattern.includes("*") &&
        new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`).test(
          tool.id,
        )),
  );
}
