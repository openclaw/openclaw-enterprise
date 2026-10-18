import type {
  OpenClawConfigurationDocument,
  PluginCatalogEntry,
  PluginDesiredState,
} from "@openclaw-enterprise/contracts";
import { agentEntryMessage } from "@openclaw-enterprise/occ";
import { asRecord } from "@openclaw-enterprise/utils";

/** An enabled selection the Configuration denies, and the deny settings that block it. */
export interface DeniedOpenClawSelection {
  readonly pluginId: string;
  /** Whether the refusal names top-level `tools.deny`. */
  readonly global: boolean;
  /** The `agents.entries` key whose `tools.deny` the refusal names, if any. */
  readonly entry?: string;
}

type CatalogTool = NonNullable<PluginCatalogEntry["tools"]>[number];

/**
 * Returns the first enabled OpenClaw plugin selection whose every tool top-level `tools.deny`,
 * the sole roster entry's `agents.entries.<id>.tools.deny`, or both together block, or that a
 * roster entry's deny-all list leaves without any tool. OpenClaw applies each deny list before any allowlist, and
 * an entry matches a tool by `*`, a `*` glob, the tool's name, its plugin's ID, or
 * `group:plugins`. Such a selection leaves the plugin nothing to offer. With a deny-all list,
 * the allowlist entry the translator adds for the plugin leaves no callable tool, so every
 * turn fails (findings 508, 1848). Callers name the settings, never their entries. Native
 * aliases and renames (`bash`, `apply-patch`, ...) never name a catalog tool: the catalog
 * refuses reserved names.
 *
 * The pinned OpenClaw Gateway resolves an Agent's tool policy from its own entry's `tools`
 * only (resolveAgentConfig), never merged with `agents.defaults`, whose schema has no `tools`;
 * Configuration saves refuse `agents.list`. With no roster, or an empty one, the implicit main
 * Agent has no entry policy. With one entry, every session runs as that entry, so its list
 * counts like `tools.deny`. With several (agents.ownership "explicit"), each session names its
 * Agent: denying a plugin to some of them is a valid setup, but an entry whose list denies
 * every tool (`*`) fails every turn of its sessions once a plugin is selected.
 */
export function deniedOpenClawSelection(
  catalog: readonly PluginCatalogEntry[],
  selections: PluginDesiredState,
  configuration: Readonly<OpenClawConfigurationDocument>,
): DeniedOpenClawSelection | undefined {
  const document = asRecord(configuration);
  const globalPatterns = denyPatterns(asRecord(document?.tools)?.deny);
  const roster = Object.entries(asRecord(asRecord(document?.agents)?.entries) ?? {}).map(
    ([key, entry]) => ({ key, patterns: denyPatterns(asRecord(asRecord(entry)?.tools)?.deny) }),
  );
  const entries =
    roster.length === 1
      ? roster
      : roster.filter(({ patterns }) => patterns.some((pattern) => /^\*+$/.test(pattern)));
  if (globalPatterns.length === 0 && entries.every(({ patterns }) => patterns.length === 0)) {
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
    const byGlobal = (tool: CatalogTool) => denies(globalPatterns, tool);
    const globalBlocks = tools.every(byGlobal);
    // Name each list that blocks every tool on its own, or both when only together they do.
    for (const { key, patterns } of entries) {
      const byEntry = (tool: CatalogTool) => denies(patterns, tool);
      if (tools.every(byEntry)) {
        return { pluginId, global: globalBlocks, entry: key };
      }
      if (!globalBlocks && tools.every((tool) => byGlobal(tool) || byEntry(tool))) {
        return { pluginId, global: true, entry: key };
      }
    }
    if (globalBlocks) {
      return { pluginId, global: true };
    }
  }
  return undefined;
}

/** The refusal for a denied selection: it names the deny settings, never their entries. */
export function openClawToolDenialMessage({
  pluginId,
  global,
  entry,
}: DeniedOpenClawSelection): string {
  const fix = (entries: string) =>
    `every tool of plugin ${pluginId}; remove the matching deny ${entries} or deselect the plugin.`;
  if (entry === undefined) {
    return `Configuration setting tools.deny blocks ${fix("entry")}`;
  }
  return agentEntryMessage(entry, (path) =>
    global
      ? `Configuration settings tools.deny and ${path}.tools.deny block ${fix("entries")}`
      : `Configuration setting ${path}.tools.deny blocks ${fix("entry")}`,
  );
}

function denyPatterns(deny: unknown): readonly string[] {
  return Array.isArray(deny)
    ? deny
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0)
    : [];
}

function denies(patterns: readonly string[], tool: CatalogTool): boolean {
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
