import type {
  OpenClawConfigurationDocument,
  PluginDesiredState,
} from "@openclaw-enterprise/contracts";
import {
  configurationSettingMessage,
  keyedSettingPath,
  pluginPolicyId,
} from "@openclaw-enterprise/occ";
import { asRecord } from "@openclaw-enterprise/utils";

/** A Configuration plugin setting the Gateway refuses beside a selected catalog plugin. */
export interface OpenClawPluginSettingConflict {
  readonly pluginId: string;
  readonly setting: string;
  readonly rule: string;
  readonly step: string;
}

/**
 * The first Configuration plugin setting the Gateway entrypoint refuses for an OpenClaw catalog
 * plugin the Agent selects (`assertNoOpenClawPluginConfigConflict` in the shared plugin runtime
 * helpers, which Kubernetes and Docker Compute run before OpenClaw starts), or undefined. The
 * entrypoint writes each selected plugin's `plugins.entries.<nativeId>` from the selection and,
 * for an enabled selection, exits at every start when `plugins.enabled` is false, `plugins.deny`
 * names the plugin, or a non-empty `plugins.allow` leaves it out. It compares the trimmed,
 * lowercased IDs, as OpenClaw does (pluginPolicyId; no built-in alias names a catalog plugin) and
 * ignores blank list items. It also exits when the Configuration already holds an entry at that
 * plugin's exact key other than the one it writes; this refuses any entry there, since only a copy
 * of the entry OCE writes would pass and the selection already writes it. Kubernetes Compute
 * refuses the key's other spellings at Configuration save (refuseKubernetesPluginEntryKeyVariants).
 * Selections name a plugin by catalog ID or by its native ID alone.
 */
export function openClawPluginSettingConflict(
  selections: PluginDesiredState,
  configuration: Readonly<OpenClawConfigurationDocument>,
  catalogIds: readonly string[],
  catalogPrefix: string,
): OpenClawPluginSettingConflict | undefined {
  const plugins = asRecord(configuration.plugins);
  if (plugins === undefined) {
    return undefined;
  }
  const policyIds = (value: unknown): (string | undefined)[] =>
    Array.isArray(value) ? value.map(pluginPolicyId).filter((id) => id !== "") : [];
  const allow = policyIds(plugins.allow);
  const deny = policyIds(plugins.deny);
  const entries = asRecord(plugins.entries);
  for (const [pluginId, selection] of Object.entries(selections)) {
    const nativeId = pluginId.startsWith(catalogPrefix)
      ? pluginId.slice(catalogPrefix.length)
      : pluginId;
    if (!catalogIds.includes(nativeId)) {
      continue;
    }
    if (selection?.enabled === true) {
      if (plugins.enabled === false) {
        return {
          pluginId,
          setting: "plugins.enabled",
          rule: "must not be false",
          step: "remove it or deselect the plugin",
        };
      }
      if (deny.includes(nativeId)) {
        return {
          pluginId,
          setting: "plugins.deny",
          rule: `must not list ${nativeId}`,
          step: "remove that item or deselect the plugin",
        };
      }
      if (allow.length > 0 && !allow.includes(nativeId)) {
        return {
          pluginId,
          setting: "plugins.allow",
          rule: `must list ${nativeId}`,
          step: "add it or deselect the plugin",
        };
      }
    }
    if (entries !== undefined && Object.hasOwn(entries, nativeId)) {
      return {
        pluginId,
        setting: keyedSettingPath("plugins.entries", nativeId),
        rule: "must be unset",
        step: "OCE writes this entry from the selection, so remove it or deselect the plugin",
      };
    }
  }
  return undefined;
}

/** The refusal for a conflict, within the API's message cap (configurationSettingMessage). */
export function openClawPluginSettingMessage(conflict: OpenClawPluginSettingConflict): string {
  return configurationSettingMessage(
    conflict.setting,
    `${conflict.rule} while the Agent selects plugin ${conflict.pluginId}, or the Gateway does not start: ${conflict.step}`,
  );
}
