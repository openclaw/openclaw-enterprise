import type { OpenClawConfigurationDocument } from "@openclaw-enterprise/contracts";
import { asRecord } from "@openclaw-enterprise/utils";
import { keyedSettingPath, quotedSettingKey } from "./errors.ts";
import { environmentReferenceNames } from "./model-provider-settings.ts";

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
 * Each listed channel's credential references need a Configuration Secret binding of that name
 * where the Compute delivers channel credentials only from bindings, as Kubernetes Compute does.
 * A reference is an env SecretRef's `id`, or each `${NAME}` the runtime substitutes in a string
 * (`environmentReferenceNames`): anywhere in the text and also with a `:-fallback`, since an
 * unbound name is never set there and the fallback, often empty, always replaces it (finding
 * 2475). Refuses the first reference without one, naming its setting and the binding.
 * Configuration save, provisioning and Agent create's check (OCC) and Kubernetes deployment
 * admission share this rule (finding 2319).
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
    const name = environmentReferenceNames(value).find((reference) => !bound(reference));
    return name === undefined ? undefined : { path, name };
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
