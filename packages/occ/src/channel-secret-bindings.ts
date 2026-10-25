import type { OpenClawConfigurationDocument } from "@openclaw-enterprise/contracts";
import { asRecord } from "@openclaw-enterprise/utils";
import { keyedSettingPath, quotedSettingKey } from "./errors.ts";
import {
  environmentReferenceNames,
  secretInputShorthandName,
  unsubstitutedReference,
} from "./environment-references.ts";

type SettingError = (setting: string, requirement: string) => Error;

// `channels` keys that hold shared channel settings, not a provider.
const SHARED_CHANNEL_KEYS: readonly string[] = ["defaults", "modelByChannel"];

type FieldKeys = readonly (readonly string[])[];
type SecretInputFields = { readonly channel: FieldKeys; readonly account: FieldKeys };

const SLACK_SECRET_INPUTS: FieldKeys = [
  ["appToken"],
  ["botToken"],
  ["signingSecret"],
  ["userToken"],
  ["relay", "authToken"],
];

/**
 * The secret-input fields of the channels Kubernetes Compute supports, on the channel and on each
 * named account: `extensions/<channel>/src/secret-contract.ts` at the `OPENCLAW_COMMIT` in
 * `deploy/runtime/Dockerfile`. Update this list when that pin changes. The runtime reads a `$NAME`
 * value there as an environment SecretRef.
 */
const CHANNEL_SECRET_INPUTS: Readonly<Record<string, SecretInputFields>> = {
  slack: { channel: SLACK_SECRET_INPUTS, account: SLACK_SECRET_INPUTS },
  msteams: { channel: [["appPassword"]], account: [] },
};

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
 * A reference is an env SecretRef's `id`, each `${NAME}` the runtime substitutes in a string
 * without a `:-fallback`, and in a secret-input field (`CHANNEL_SECRET_INPUTS`) also a `${NAME}`
 * with one and a `$NAME` value (`environment-references.ts`): an unbound name is never set there,
 * so the fallback, often empty, would replace the credential. A secret-input field that holds a
 * `${` the runtime does not substitute, such as a lowercase name, is refused too: the runtime
 * would send that text as the credential (findings 2475-2477). Refuses the first such value,
 * naming its setting and the binding or text. Configuration save, provisioning and Agent create's
 * check (OCC) and Kubernetes deployment admission share this rule (finding 2319).
 */
export function requireChannelSecretBindings(
  configuration: Readonly<OpenClawConfigurationDocument>,
  providers: readonly string[],
  bound: (name: string) => boolean,
  createError: SettingError,
): void {
  const channels = asRecord(configuration.channels) ?? {};
  for (const provider of providers) {
    const refusal = channelReferenceRefusal(
      channels[provider],
      keyedSettingPath("channels", provider),
      [],
      Object.hasOwn(CHANNEL_SECRET_INPUTS, provider) ? CHANNEL_SECRET_INPUTS[provider] : undefined,
      bound,
    );
    if (refusal !== undefined) {
      throw createError(refusal.path, refusal.requirement);
    }
  }
}

const unboundRequirement = (name: string): string => {
  // Plain names show as written; any other env SecretRef id is quoted and shortened, so the
  // message keeps its cap.
  const written =
    name.length <= 32 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : quotedSettingKey(name, 32);
  return `references ${written} without a Configuration Secret binding: bind ${written} in secretBindings to an environment-backed Secret, or remove the reference`;
};

// The text the runtime keeps as written may be the credential itself, so the refusal shows it only
// when it is a lowercase `${name}`, the realistic mistake (finding 2485: a mixed-case token such
// as `${Zr9k…}` is never shown), or only the name of `${NAME-text}`; otherwise it names the form.
function unsubstitutedRequirement(literal: string): string {
  const bind = "bound to a Secret in secretBindings";
  if (/^\$\{[a-z_][a-z0-9_]{0,28}\}$/.test(literal)) {
    return `contains ${literal}, which the runtime does not substitute: use an uppercase \${NAME} ${bind}, or escape literal text as $\${NAME}`;
  }
  const name = /^\$\{([A-Z_][A-Z0-9_]{0,28})-/.exec(literal)?.[1];
  if (name !== undefined) {
    return `contains \${${name}-…}, which the runtime does not substitute: write a fallback as \${${name}:-text}, with ${name} ${bind}`;
  }
  return `contains a \${ the runtime does not substitute: use an uppercase \${NAME} ${bind}, or escape literal text as $\${NAME}`;
}

const sameKeys = (left: readonly (string | number)[], right: readonly string[]): boolean =>
  left.length === right.length && right.every((key, index) => left[index] === key);

// Whether `keys`, from the channel's root, name one of its secret-input fields: on the channel or
// on a named account (`accounts.<id>`).
function isSecretInput(
  keys: readonly (string | number)[],
  fields: SecretInputFields | undefined,
): boolean {
  return (
    fields !== undefined &&
    (fields.channel.some((field) => sameKeys(keys, field)) ||
      (keys[0] === "accounts" &&
        typeof keys[1] === "string" &&
        fields.account.some((field) => sameKeys(keys.slice(2), field))))
  );
}

function channelReferenceRefusal(
  value: unknown,
  path: string,
  keys: readonly (string | number)[],
  fields: SecretInputFields | undefined,
  bound: (name: string) => boolean,
): { readonly path: string; readonly requirement: string } | undefined {
  if (typeof value === "string") {
    const secretInput = isSecretInput(keys, fields);
    const literal = secretInput ? unsubstitutedReference(value) : undefined;
    if (literal !== undefined) {
      return { path, requirement: unsubstitutedRequirement(literal) };
    }
    const shorthand = secretInput ? secretInputShorthandName(value) : undefined;
    // Outside a credential, a fallback works without a binding (`${SLACK_MODE:-socket}`); in one
    // it would replace the unset name, often with an empty token.
    const name = [
      ...environmentReferenceNames(value, { fallbacks: secretInput }),
      ...(shorthand === undefined ? [] : [shorthand]),
    ].find((reference) => !bound(reference));
    return name === undefined ? undefined : { path, requirement: unboundRequirement(name) };
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const refusal = channelReferenceRefusal(
        item,
        `${path}[${index}]`,
        [...keys, index],
        fields,
        bound,
      );
      if (refusal !== undefined) {
        return refusal;
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
    return { path, requirement: unboundRequirement(record.id) };
  }
  for (const [key, item] of Object.entries(record)) {
    const refusal = channelReferenceRefusal(
      item,
      keyedSettingPath(path, key),
      [...keys, key],
      fields,
      bound,
    );
    if (refusal !== undefined) {
      return refusal;
    }
  }
  return undefined;
}
