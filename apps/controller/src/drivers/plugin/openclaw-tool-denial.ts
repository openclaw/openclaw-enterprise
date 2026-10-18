import type {
  OpenClawConfigurationDocument,
  PluginCatalogEntry,
  PluginDesiredState,
} from "@openclaw-enterprise/contracts";
import { asRecord } from "@openclaw-enterprise/utils";

const OCC_DRIVER_ID = "occ-plugin";

/**
 * Returns the first enabled OpenClaw plugin selection whose every tool the Configuration's
 * `tools.deny` blocks. OpenClaw applies the deny list before any allowlist, and an entry
 * matches a tool by `*`, a `*` glob, the tool's name, its plugin's ID, or `group:plugins`.
 * Such a selection leaves the plugin nothing to offer. With a deny-all list, the allowlist
 * entry the translator adds for the plugin leaves no callable tool, so every turn fails
 * (finding 508). Callers name the setting, never its entries.
 */
export function deniedOpenClawSelection(
  catalog: readonly PluginCatalogEntry[],
  selections: PluginDesiredState,
  configuration: Readonly<OpenClawConfigurationDocument>,
): string | undefined {
  const deny = asRecord(asRecord(configuration)?.tools)?.deny;
  if (!Array.isArray(deny)) {
    return undefined;
  }
  const patterns = deny
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  const denied = (tool: string, owner: string): boolean =>
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
  for (const [pluginId, selection] of Object.entries(selections)) {
    if (selection?.enabled !== true) {
      continue;
    }
    const nativeId = pluginId.startsWith(`${OCC_DRIVER_ID}:`)
      ? pluginId.slice(OCC_DRIVER_ID.length + 1)
      : pluginId;
    const tools = catalog.find((entry) => entry.id === `${OCC_DRIVER_ID}:${nativeId}`)?.tools;
    if (
      Array.isArray(tools) &&
      tools.length > 0 &&
      tools.every((tool) => denied(tool.id, nativeId))
    ) {
      return pluginId;
    }
  }
  return undefined;
}
