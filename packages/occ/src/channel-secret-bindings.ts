import type { OpenClawConfigurationDocument } from "@openclaw-enterprise/contracts";
import { asRecord } from "@openclaw-enterprise/utils";
import { keyedSettingPath, quotedSettingKey } from "./errors.ts";

type SettingError = (setting: string, requirement: string) => Error;

// `channels` keys that hold shared channel settings, not a provider.
const SHARED_CHANNEL_KEYS: readonly string[] = ["defaults", "modelByChannel"];

/**
 * The `channels.<provider>` entries a Configuration enables, in Configuration order: every key
 * but the shared settings, unless its `enabled` is `false`.
 */
export function enabledChannelEntries(
  configuration: Readonly<OpenClawConfigurationDocument>,
): string[] {
  return Object.entries(asRecord(configuration.channels) ?? {})
    .filter(
      ([provider, channel]) =>
        !SHARED_CHANNEL_KEYS.includes(provider) && asRecord(channel)?.enabled !== false,
    )
    .map(([provider]) => provider);
}

/**
 * Each listed channel's credential references (`${NAME}`, or an env SecretRef with that `id`)
 * need a Configuration Secret binding of that name where the Compute delivers channel
 * credentials only from bindings, as Kubernetes Compute does. Refuses the first reference
 * without one, naming its setting and the binding. Configuration save, provisioning and Agent
 * create's check (OCC) and Kubernetes deployment admission share this rule (finding 2319).
 */
export function requireChannelSecretBindings(
  configuration: Readonly<OpenClawConfigurationDocument>,
  providers: readonly string[],
  bound: (name: string) => boolean,
  createError: SettingError,
): void {
  const channels = asRecord(configuration.channels) ?? {};
  for (const provider of providers) {
    const unbound = unboundChannelReference(
      channels[provider],
      keyedSettingPath("channels", provider),
      bound,
    );
    if (unbound !== undefined) {
      // Plain names show as written; any other env SecretRef id is quoted and shortened, so
      // the message keeps its cap.
      const name =
        unbound.name.length <= 32 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(unbound.name)
          ? unbound.name
          : quotedSettingKey(unbound.name, 32);
      throw createError(
        unbound.path,
        `references ${name} without a Configuration Secret binding: bind ${name} in secretBindings to an environment-backed Secret, or remove the reference`,
      );
    }
  }
}

function unboundChannelReference(
  value: unknown,
  path: string,
  bound: (name: string) => boolean,
): { readonly path: string; readonly name: string } | undefined {
  if (typeof value === "string") {
    const name = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)?.[1];
    return name === undefined || bound(name) ? undefined : { path, name };
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const unbound = unboundChannelReference(item, `${path}[${index}]`, bound);
      if (unbound !== undefined) {
        return unbound;
      }
    }
    return undefined;
  }
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  if (
    record.source === "env" &&
    typeof record.id === "string" &&
    record.id.length > 0 &&
    !bound(record.id)
  ) {
    return { path, name: record.id };
  }
  for (const [key, item] of Object.entries(record)) {
    const unbound = unboundChannelReference(item, keyedSettingPath(path, key), bound);
    if (unbound !== undefined) {
      return unbound;
    }
  }
  return undefined;
}
