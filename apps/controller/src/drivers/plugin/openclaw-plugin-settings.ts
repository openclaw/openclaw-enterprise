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

import { pluginRuntimeTranslator } from "./runtime-translator.ts";

/** A Configuration plugin setting the Gateway refuses beside a selected catalog plugin. */
export interface OpenClawPluginSettingConflict {
  readonly pluginId: string;
  readonly setting: string;
  readonly rule: string;
  readonly step: string;
}

// The entrypoint's gatewayServesPublicOrigin without its auth mode test: Kubernetes Compute always
// renders trusted-proxy auth, so only these Configuration values decide it there. No Compute
// writes gateway.publicOrigin or gateway.controlUi.allowedOrigins.
function listsGatewayPublicOrigin(configuration: Readonly<OpenClawConfigurationDocument>): boolean {
  const gateway = asRecord(configuration.gateway);
  const origin = gateway?.publicOrigin;
  const allowedOrigins = asRecord(gateway?.controlUi)?.allowedOrigins;
  return (
    typeof origin === "string" &&
    /^https:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/.test(origin) &&
    Array.isArray(allowedOrigins) &&
    allowedOrigins.includes(origin)
  );
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
 * plugin's exact key whose JSON differs from the one it writes. An exact copy passes: `{"enabled":
 * false}` for a disabled selection, and `{"enabled":true}` for an enabled one while the Gateway
 * serves no public origin. Any other entry is refused, including both copies where the Gateway
 * can serve one (listsGatewayPublicOrigin): the entrypoint then writes `{"enabled":true,"config":
 * ...}`, and PostgreSQL's jsonb stores `config` first, so the stored copy never matches. That
 * over-refuses only `{"enabled":true}` on Docker Compute with password auth, which serves no
 * public origin. Kubernetes Compute refuses the key's other spellings at Configuration save
 * (refuseKubernetesPluginEntryKeyVariants). Selections name a plugin by catalog ID or by its
 * native ID alone.
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
      const enabled = selection?.enabled === true;
      const publicOrigin =
        enabled &&
        pluginRuntimeTranslator.openClawManagedEntryConfig(nativeId) !== undefined &&
        listsGatewayPublicOrigin(configuration);
      // Accepting `{"enabled":true}` is safe only while no plugin failures (pluginWarnings) reach
      // an openclaw Gateway before its first check, or the entrypoint writes `{"enabled":false}`.
      const copy = JSON.stringify({ enabled });
      if (publicOrigin || JSON.stringify(entries[nativeId]) !== copy) {
        return {
          pluginId,
          setting: keyedSettingPath("plugins.entries", nativeId),
          rule: publicOrigin ? "must be unset" : `must be unset or ${copy}`,
          step: publicOrigin
            ? "OCE writes that entry from the selection and gateway.publicOrigin; remove it or deselect the plugin"
            : "OCE writes that entry from the selection; remove it or deselect the plugin",
        };
      }
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
