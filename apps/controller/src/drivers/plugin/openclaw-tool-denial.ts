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
  /** The served `agents.entries` key whose `tools.deny` the refusal names, if any. */
  readonly entry?: string;
}

type Denied = (tool: string, owner: string) => boolean;

/**
 * Returns the first enabled OpenClaw plugin selection whose every tool the Configuration's
 * effective deny list blocks: top-level `tools.deny` together with the `tools.deny` of the
 * roster entry the Gateway serves. OpenClaw applies each deny list before any allowlist, and
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
 * Agent has no entry policy. With one entry, every session runs as that entry. With more than
 * one (agents.ownership "explicit"), each session names its Agent, so no single entry is
 * served and only `tools.deny` is checked.
 */
export function deniedOpenClawSelection(
  catalog: readonly PluginCatalogEntry[],
  selections: PluginDesiredState,
  configuration: Readonly<OpenClawConfigurationDocument>,
): DeniedOpenClawSelection | undefined {
  const document = asRecord(configuration);
  const globalDenied = denyMatcher(asRecord(document?.tools)?.deny);
  const served = servedEntry(document?.agents);
  const entryDenied = denyMatcher(asRecord(asRecord(served?.[1])?.tools)?.deny);
  if (globalDenied === undefined && entryDenied === undefined) {
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
    const byGlobal = (tool: (typeof tools)[number]) =>
      globalDenied?.(tool.id, tool.ownerId) === true;
    const byEntry = (tool: (typeof tools)[number]) => entryDenied?.(tool.id, tool.ownerId) === true;
    // Name the one list that blocks every tool on its own, else both.
    if (tools.every(byGlobal)) {
      return { pluginId, global: true };
    }
    if (tools.every(byEntry)) {
      return { pluginId, global: false, entry: served![0] };
    }
    if (tools.every((tool) => byGlobal(tool) || byEntry(tool))) {
      return { pluginId, global: true, entry: served![0] };
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

// The sole `agents.entries` entry, or undefined when the roster has none or several.
function servedEntry(agents: unknown): readonly [string, unknown] | undefined {
  const entries = Object.entries(asRecord(asRecord(agents)?.entries) ?? {});
  return entries.length === 1 ? entries[0] : undefined;
}

function denyMatcher(deny: unknown): Denied | undefined {
  if (!Array.isArray(deny)) {
    return undefined;
  }
  const patterns = deny
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (patterns.length === 0) {
    return undefined;
  }
  return (tool, owner) =>
    patterns.some(
      (pattern) =>
        pattern === tool ||
        pattern === owner ||
        pattern === "group:plugins" ||
        (pattern.includes("*") &&
          new RegExp(
            `^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`,
          ).test(tool)),
    );
}
