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
      readonly kind: "alsoAllow";
      /** The sole roster entry whose `tools.alsoAllow` drops the plugin's grant. */
      readonly entry: string;
    };

type CatalogTool = NonNullable<PluginCatalogEntry["tools"]>[number];

interface DenyList extends OpenClawToolPolicySetting {
  readonly patterns: readonly string[];
}

// The pinned Gateway's built-in profiles whose allowlist names core tools only; `full` allows
// `*`, and an unknown profile adds no profile step (resolveCoreToolProfilePolicy).
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
 * the primary model (resolveConfiguredHarnessId), so the check uses it. A fallback model may
 * match another key; it runs only when the primary fails, so it is not checked.
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
 * add tools then removes the plugin, so it is refused; an entry `tools.allow` that leaves the
 * plugin out is a deliberate restriction and is not.
 */
export function deniedOpenClawSelection(
  catalog: readonly PluginCatalogEntry[],
  selections: PluginDesiredState,
  configuration: Readonly<OpenClawConfigurationDocument>,
): DeniedOpenClawSelection | undefined {
  const document = asRecord(configuration);
  const model = primaryModel(document);
  const globalTools = asRecord(document?.tools);
  const globalLists = toolDenyLists(globalTools, model, {});
  const rosterEntries = Object.entries(asRecord(asRecord(document?.agents)?.entries) ?? {});
  const roster = rosterEntries.map(([key, entry]) => ({
    key,
    lists: toolDenyLists(asRecord(asRecord(entry)?.tools), model, { entry: key }),
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
        return { pluginId, kind: "deny", lists: blocking.lists.map(setting) };
      }
    }
    if (global !== undefined) {
      return { pluginId, kind: "deny", lists: global.lists.map(setting) };
    }
    if (
      shadowingEntry !== undefined &&
      !tools.some((tool) => matches(shadowingEntry.patterns, tool))
    ) {
      return { pluginId, kind: "alsoAllow", entry: shadowingEntry.key };
    }
  }
  return undefined;
}

/** The refusal for a denied selection: it names the settings, never their entries. */
export function openClawToolDenialMessage(denied: DeniedOpenClawSelection): string {
  const { pluginId } = denied;
  if (denied.kind === "alsoAllow") {
    return fitted(
      [`${keyedSettingPath("agents.entries", denied.entry)}.tools.alsoAllow`],
      (path) =>
        `Configuration setting ${path} replaces tools.alsoAllow under a tool profile, which hides every tool of plugin ${pluginId}; add the plugin to that list or deselect the plugin.`,
    );
  }
  const several = denied.lists.length > 1;
  return fitted(
    denied.lists.map(({ entry, provider }) => `${toolsPath(entry, provider)}.deny`),
    (paths) =>
      `Configuration ${several ? "settings" : "setting"} ${paths} ${several ? "block" : "blocks"} every tool of plugin ${pluginId}; remove the matching deny ${several ? "entries" : "entry"} or deselect the plugin.`,
  );
}

function toolsPath(entry: string | undefined, provider: string | undefined): string {
  const tools =
    entry === undefined ? "tools" : `${keyedSettingPath("agents.entries", entry)}.tools`;
  return provider === undefined ? tools : keyedSettingPath(`${tools}.byProvider`, provider);
}

// The HTTP error contract caps messages at 256 characters. Paths share what the text leaves,
// shortest first, so a long key is cut with … and a short path stays whole.
const MESSAGE_CAP = 256;

function fitted(paths: readonly string[], render: (paths: string) => string): string {
  const join = (shown: readonly string[]) =>
    shown.length === 1 ? shown[0]! : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)!}`;
  const full = render(join(paths));
  if (Array.from(full).length <= MESSAGE_CAP) {
    return full;
  }
  let budget = MESSAGE_CAP - Array.from(render(join(paths.map(() => "")))).length;
  const shown = [...paths];
  const order = paths
    .map((path, index) => ({ index, characters: Array.from(path) }))
    .sort((left, right) => left.characters.length - right.characters.length);
  order.forEach(({ index, characters }, position) => {
    const share = Math.max(1, Math.floor(budget / (order.length - position)));
    shown[index] =
      characters.length <= share ? paths[index]! : `${characters.slice(0, share - 1).join("")}…`;
    budget -= Math.min(characters.length, share);
  });
  return render(join(shown));
}

/**
 * The deny lists of one `tools` object that hold an entry: its own `deny`, then the `deny` of
 * the `byProvider` policy the primary model selects.
 */
function toolDenyLists(
  tools: Readonly<Record<string, unknown>> | undefined,
  model: PrimaryModel | undefined,
  at: { readonly entry?: string },
): DenyList[] {
  const lists: DenyList[] = [{ ...at, patterns: policyPatterns(tools?.deny) }];
  const provider = providerPolicy(tools?.byProvider, model);
  if (provider !== undefined) {
    lists.push({ ...at, provider: provider.key, patterns: policyPatterns(provider.policy.deny) });
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

interface PrimaryModel {
  readonly provider: string;
  readonly id: string;
}

/**
 * The provider and model ID OpenClaw resolves from the primary model reference (parseModelRef):
 * agents.defaults.model, else the first agents.entries model, which admission requires to match.
 * Both parts are lowercased, as the `byProvider` lookup compares them.
 */
function primaryModel(
  document: Readonly<Record<string, unknown>> | undefined,
): PrimaryModel | undefined {
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
    return { provider: "openrouter", id: "auto" };
  }
  const slash = trimmed.indexOf("/");
  const provider = trimmed.slice(0, Math.max(slash, 0)).trim().toLowerCase();
  const id = trimmed
    .slice(slash + 1)
    .trim()
    .toLowerCase();
  return slash < 0 || provider.length === 0 || id.length === 0 ? undefined : { provider, id };
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
 * The `byProvider` policy the primary model selects (resolveProviderToolPolicyEntry): the
 * `provider/model` key, else the `provider` key. Keys that normalize alike keep the first one
 * written in normalized form, else the first one.
 */
function providerPolicy(
  byProvider: unknown,
  model: PrimaryModel | undefined,
): { readonly key: string; readonly policy: Readonly<Record<string, unknown>> } | undefined {
  const entries = asRecord(byProvider);
  if (entries === undefined || model === undefined) {
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
  const match =
    lookup.get(`${providerPolicyKey(model.provider)}/${model.id}`) ??
    lookup.get(providerPolicyKey(model.provider));
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
