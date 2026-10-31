// How the OpenClaw runtime reads environment references in its configuration, at the
// commit in `deploy/runtime/openclaw-source.json`. Update this module when that pin changes.
// The Console also serves this module (`console-assets.ts`): keep it free of imports and of
// TypeScript syntax that type stripping cannot erase.

// The runtime resolves `${VAR}` and `${VAR:-fallback}` environment references (uppercase
// names) before it validates its configuration, so a value that holds one is left to it. Its
// `$${VAR}` escape renders a literal `${VAR}` and resolves nothing, so text that holds only
// escapes is checked as written. This follows OpenClaw's `containsEnvVarReference`
// (`src/config/env-substitution.ts`).
export const environmentReference = /\$(\$)?\{[A-Z_][A-Z0-9_]*(?::-([^${}]*))?\}/g;

/**
 * The variable names the runtime substitutes in `text`, in order: an escape names none. With
 * `fallbacks: false`, only those of references without a `:-fallback`, which fail the runtime's
 * config load when the variable is unset.
 */
export const environmentReferenceNames = (text: string, { fallbacks = true } = {}): string[] =>
  [...text.matchAll(environmentReference)]
    .filter(
      ([, escaped, fallback]) => escaped === undefined && (fallbacks || fallback === undefined),
    )
    .map(([reference]) => reference.slice(2, reference.search(/[:}]/)));

/**
 * The variable `text` names when it is exactly one `${NAME}` reference the runtime substitutes,
 * with no fallback and nothing else, not even spaces; otherwise undefined. The runtime replaces
 * such a value with the variable NAME when it loads its configuration, so a reader of SecretRefs
 * can read it as the environment SecretRef to NAME.
 */
export function wholeEnvironmentReferenceName(text: string): string | undefined {
  const [first] = text.matchAll(environmentReference);
  // An escape (`$${NAME}`) names no variable, so `environmentReferenceNames` returns none for it.
  return first?.[0] === text && first[2] === undefined
    ? environmentReferenceNames(text)[0]
    : undefined;
}

/**
 * The first `${` in `text` that is not a reference the runtime substitutes, up to the `}` that
 * ends it, if any: a lowercase name, `${VAR-text}`, a fallback that holds `$` or `{`, or an
 * unclosed `${`. The runtime keeps that text as written. A `$${` is an escape and never counts,
 * though the runtime also keeps `$${name}` as written when the name is not one it substitutes.
 */
export function unsubstitutedReference(text: string): string | undefined {
  const masked = text.replaceAll(environmentReference, (reference) =>
    "\0".repeat(reference.length),
  );
  const start = masked.search(/(?<!\$)\$\{/);
  if (start === -1) {
    return undefined;
  }
  const end = text.indexOf("}", start + 2);
  return text.slice(start, end === -1 ? undefined : end + 1);
}

// The runtime also reads a whole secret-input value `$NAME` (trimmed) as an environment
// SecretRef: `ENV_SECRET_SHORTHAND_RE` and `parseEnvTemplateSecretRef` in
// `src/config/types.secrets.ts`. Other fields keep that text as written.
const secretInputShorthand = /^\$([A-Z][A-Z0-9_]{0,127})$/;

/** The variable a secret-input value names with the `$NAME` shorthand, if it is one. */
export const secretInputShorthandName = (text: string): string | undefined =>
  secretInputShorthand.exec(text.trim())?.[1];

// Control, format, line and paragraph separator characters and lone surrogates show as ?.
export const shownSettingKey = (key: string): string =>
  key.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|\p{Cs}/gu, "?");

/**
 * A submitted key a message names, such as a header name, in double quotes: characters
 * keyedSettingPath hides show as ?, and a key longer than `limit` code points is cut with …,
 * so the message keeps its cap (`limit` is at least 1). Use it only for keys that are not secrets.
 */
export function quotedSettingKey(key: string, limit: number): string {
  const characters = Array.from(shownSettingKey(key));
  return JSON.stringify(
    characters.length <= limit
      ? characters.join("")
      : `${characters.slice(0, limit - 1).join("")}…`,
  );
}

// OpenClaw's SecretRef grammar (`src/secrets/ref-contract.ts`): the sources, the provider alias
// and the id of an env or store SecretRef.
const SECRET_REF_SOURCES = ["env", "file", "exec", "store"];
const SECRET_PROVIDER_ALIAS = /^[a-z][a-z0-9_-]{0,63}$/;
const ENV_SECRET_REF_ID = /^[A-Z][A-Z0-9_]{0,127}$/;

const asObject = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

/**
 * A variable, id or provider alias as a refusal shows it: as written when short and plain, else
 * quoted and cut, so a message keeps its cap and never echoes control characters.
 */
export const shownSecretName = (name: string): string =>
  /^[A-Za-z0-9_]{1,32}$/.test(name) ? name : quotedSettingKey(name, 32);

// Whether a refusal's step may offer `name` as a value to write: shownSecretName shows it whole,
// and it is short enough that the message keeps its 256-character cap with the longest names
// beside it.
const offerable = (name: string): boolean => Array.from(name).length <= 20;

// The provider alias OpenClaw reads a `source` SecretRef on by default: secrets.defaults.<source>
// (trimmed), else "default". Only env and store have a built-in provider on it. Undefined when the
// alias holds an environment reference: the runtime substitutes it before it reads the alias, so
// the alias is not known until then and readers leave what depends on it to the runtime.
const defaultSecretProvider = (secrets: unknown, source: string): string | undefined => {
  const alias = asObject(asObject(secrets)?.defaults)?.[source];
  if (typeof alias !== "string" || alias.trim() === "") {
    return "default";
  }
  return environmentReferenceNames(alias).length > 0 ? undefined : alias.trim();
};

/**
 * The first secrets.defaults setting OpenClaw's config check refuses, as the setting and why, or
 * undefined. Its schema (`SecretsConfigSchema` in `src/config/zod-schema.core.ts`) takes
 * secrets.defaults only as an object of env, file, exec and store aliases, each in the provider
 * alias grammar (no padding, no upper case), so the Gateway exits with code 78 at every start on
 * anything else, whatever the Compute (finding 3064). An alias that holds an environment reference
 * is left to the runtime, which substitutes it before that check. The schema sets no grammar on
 * secrets.providers keys: a SecretRef cannot name one that breaks it (`secretInputReference`).
 */
export function secretProviderDefaultsProblem(
  secrets: unknown,
): { readonly setting: string; readonly requirement: string } | undefined {
  const defaults = asObject(secrets)?.defaults;
  if (defaults === undefined) {
    return undefined;
  }
  const aliases = asObject(defaults);
  if (aliases === undefined) {
    return {
      setting: "secrets.defaults",
      requirement: "must be an object that names a provider alias for env, file, exec or store",
    };
  }
  for (const [source, alias] of Object.entries(aliases)) {
    if (!SECRET_REF_SOURCES.includes(source)) {
      return {
        setting: "secrets.defaults",
        requirement: `holds ${quotedSettingKey(source, 32)}, which OpenClaw refuses: name only env, file, exec or store`,
      };
    }
    if (typeof alias === "string" && environmentReferenceNames(alias).length > 0) {
      continue;
    }
    if (typeof alias !== "string" || !SECRET_PROVIDER_ALIAS.test(alias)) {
      // Offer the alias trimmed and lowercased when that fits the grammar and is offerable.
      const fixed = typeof alias === "string" ? alias.trim().toLowerCase() : "";
      const step =
        SECRET_PROVIDER_ALIAS.test(fixed) && offerable(fixed)
          ? `use ${shownSecretName(fixed)}, or remove it`
          : "remove it";
      return {
        setting: `secrets.defaults.${source}`,
        requirement: `${typeof alias === "string" ? `is ${shownSecretName(alias)}, ` : "is "}not a provider alias OpenClaw reads (a-z, 0-9, _ and -, from a lowercase letter, at most 64 characters): ${step}`,
      };
    }
  }
  return undefined;
}

// Why OpenClaw cannot read a SecretRef, and the one next step that fixes it (finding 3067).
interface Unreadable {
  readonly problem: string;
  readonly step: string;
}

const requirementText = ({ problem, step }: Unreadable): string => `${problem}: ${step}`;

// The step that puts a `source` SecretRef on its default provider alias, `add` for a ref without
// a provider: by name when the alias is known and offerable, else by the setting that names it.
function defaultProviderStep(source: string, alias: string | undefined, add = false): string {
  if (alias !== undefined && offerable(alias)) {
    return `${add ? "add" : "use"} provider ${shownSecretName(alias)}`;
  }
  return add
    ? `add the provider secrets.defaults.${source} names`
    : `use the secrets.defaults.${source} alias`;
}

function providerlessUnreadable(source: string, secrets: unknown): Unreadable {
  const problem = "is a SecretRef without a provider";
  if (!["env", "store"].includes(source)) {
    return { problem, step: `add a provider that secrets.providers configures for ${source}` };
  }
  const alias = defaultSecretProvider(secrets, source);
  return { problem, step: defaultProviderStep(source, alias, true) };
}

/**
 * Why OpenClaw cannot read a SecretRef on a `provider` that is not the source's built-in one
 * (`builtIn` false) or that breaks the alias grammar, with the step that fixes it: the default
 * alias, or configuring the provider for the source. A ref on provider "default" while
 * secrets.defaults.<source> names another alias says so (finding 3067).
 */
function providerUnreadable(provider: string, source: string, secrets: unknown): Unreadable {
  const shown = shownSecretName(provider);
  const hasDefault = ["env", "store"].includes(source);
  const alias = hasDefault ? defaultSecretProvider(secrets, source) : undefined;
  if (!SECRET_PROVIDER_ALIAS.test(provider)) {
    return {
      problem: `uses secret provider ${shown}, not a provider alias OpenClaw reads`,
      step: hasDefault
        ? defaultProviderStep(source, alias)
        : "use a-z, 0-9, _ and -, from a lowercase letter",
    };
  }
  if (provider === "default" && alias !== undefined && alias !== "default") {
    return {
      problem: `uses secret provider default, but secrets.defaults.${source} names ${shownSecretName(alias)}`,
      step: `use ${offerable(alias) ? `provider ${shownSecretName(alias)}` : "that provider"}`,
    };
  }
  return {
    problem: `uses secret provider ${shown}, not configured for ${source}`,
    step: hasDefault
      ? `${defaultProviderStep(source, alias)}, or add it to secrets.providers`
      : "add it to secrets.providers",
  };
}

// secrets.providers.<provider> as a refusal shows it: a long alias is quoted and cut, so the
// message keeps its cap.
const shownProviderSetting = (provider: string): string =>
  Array.from(provider).length <= 32
    ? `secrets.providers.${provider}`
    : `secrets.providers[${quotedSettingKey(provider, 32)}]`;

// The id example a refusal offers for an env or store id OpenClaw refuses: trimmed, upper-cased,
// other characters as _, when that fits the grammar and is offerable.
function secretIdExample(id: string): string | undefined {
  const example = id
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_");
  return ENV_SECRET_REF_ID.test(example) && offerable(example) ? example : undefined;
}

export type SecretInputReference =
  // The variable the Gateway reads from its environment. `unset`: why OpenClaw cannot read a
  // whole `${NAME}` that it keeps as an env SecretRef because NAME is unset at startup, without a
  // step: the caller names the binding that sets NAME.
  | { readonly variable: string; readonly unset?: string }
  // Why OpenClaw cannot read the reference at all, which ends startup, then ": " and the step
  // that fixes it (`problem` and `step` apart).
  | ({ readonly requirement: string } & Unreadable);

const readable = (unreadable: Unreadable): SecretInputReference => ({
  requirement: requirementText(unreadable),
  ...unreadable,
});

/**
 * How OpenClaw reads a secret-input value at startup, or undefined when it keeps the value as
 * written (a reference inside other text, a `${NAME:-fallback}`, any other object). `secrets` is
 * the Configuration's. The `$NAME` shorthand is an env SecretRef on the default env provider alias
 * (`secrets.defaults.env`, else "default"; `parseEnvTemplateSecretRef`). A whole `${NAME}` with no
 * fallback (padded too, finding 3046) is one only while NAME is unset: config loading substitutes a
 * set NAME first and records the path as resolved, so no SecretRef is read there
 * (`substituteString`, `getAuthoredConfigSecretRef`); a `${_NAME}` is only substituted. OpenClaw
 * refuses a SecretRef object without a provider (`collectCanonicalSecretInputAssignment`), a
 * provider alias that breaks its grammar or that `secrets.providers` does not configure for the
 * ref's source (only env and store have a built-in default alias: `resolveConfiguredProvider`), an
 * env or store id that breaks its grammar (`normalizeAndGroupSecretRefs` trims the id, so a padded
 * one then fails as "Secret resolution made no progress") and an id a configured env provider's
 * `allowlist` omits. A default alias that holds an environment reference is known only once the
 * runtime substitutes it, so what depends on it is left to the runtime.
 */
export function secretInputReference(
  value: unknown,
  secrets: unknown,
): SecretInputReference | undefined {
  const text = typeof value === "string" ? value : undefined;
  const substituted = text === undefined ? undefined : wholeEnvironmentReferenceName(text.trim());
  if (substituted !== undefined && !ENV_SECRET_REF_ID.test(substituted)) {
    return { variable: substituted };
  }
  const template = substituted ?? (text === undefined ? undefined : secretInputShorthandName(text));
  const object = template === undefined ? asObject(value) : undefined;
  const source = template === undefined ? object?.source : "env";
  const id = template ?? object?.id;
  if (
    typeof source !== "string" ||
    !SECRET_REF_SOURCES.includes(source) ||
    typeof id !== "string" ||
    id.trim() === ""
  ) {
    return undefined;
  }
  const provider =
    template === undefined ? object?.provider : defaultSecretProvider(secrets, "env");
  // A template on a default env alias the runtime substitutes reads the variable on an alias
  // known only then.
  if (template !== undefined && provider === undefined) {
    return { variable: template };
  }
  if (provider === undefined) {
    return readable(providerlessUnreadable(source, secrets));
  }
  if (
    (object !== undefined && Object.keys(object).length !== 3) ||
    typeof provider !== "string" ||
    provider.trim() === ""
  ) {
    return undefined;
  }
  const configured = asObject(asObject(asObject(secrets)?.providers)?.[provider]);
  // Whether the provider is the source's built-in one; undefined when the default alias that
  // decides it holds an environment reference, so its provider and allowlist checks are left to
  // the runtime.
  let builtIn: boolean | undefined = false;
  if (configured?.source !== source && ["env", "store"].includes(source)) {
    const alias = defaultSecretProvider(secrets, source);
    builtIn = alias === undefined ? undefined : provider === alias;
  }
  const unreadable = (): Unreadable | undefined => {
    if (
      !SECRET_PROVIDER_ALIAS.test(provider) ||
      (builtIn === false && configured?.source !== source)
    ) {
      return providerUnreadable(provider, source, secrets);
    }
    if (["env", "store"].includes(source) && !ENV_SECRET_REF_ID.test(id)) {
      const example = secretIdExample(id);
      return {
        problem: `references ${shownSecretName(id)}, not ${source === "env" ? "an" : "a"} ${source} id OpenClaw reads`,
        step: `use ${example ?? "A-Z, 0-9 and _, from a letter"}`,
      };
    }
    const allowlist = builtIn === false ? configured?.allowlist : undefined;
    if (source === "env" && Array.isArray(allowlist) && !allowlist.includes(id)) {
      return {
        problem: `references ${shownSecretName(id)}, which ${shownProviderSetting(provider)}.allowlist omits`,
        step: "add it to that allowlist",
      };
    }
    return undefined;
  };
  const requirement = unreadable();
  if (substituted !== undefined) {
    return requirement === undefined
      ? { variable: id }
      : { variable: id, unset: requirement.problem };
  }
  if (requirement !== undefined) {
    return readable(requirement);
  }
  return source === "env" ? { variable: id } : undefined;
}

/**
 * The environment SecretRef to the Gateway password every Compute generates, on the default env
 * provider alias of `secrets` (the Configuration's): the value Enable gateway password access
 * writes and refusals offer. An alias that breaks OpenClaw's grammar is not offered.
 */
export function generatedGatewayPasswordReference(secrets: unknown): {
  readonly source: "env";
  readonly provider: string;
  readonly id: "OPENCLAW_GATEWAY_PASSWORD";
} {
  const alias = defaultSecretProvider(secrets, "env");
  return {
    source: "env",
    provider: alias !== undefined && SECRET_PROVIDER_ALIAS.test(alias) ? alias : "default",
    id: "OPENCLAW_GATEWAY_PASSWORD",
  };
}

/**
 * Why OpenClaw cannot read the gateway.auth.password object `password` with the Configuration's
 * `secrets`, or undefined for one it reads and for a value that is not an object (a literal or a
 * `${NAME}`, which the callers check). Every Compute runs the Gateway in password or trusted-proxy
 * auth mode, where OpenClaw resolves the password at every start (`passwordCanWin` in
 * `src/gateway/credential-planner.ts`) with those `secrets`, so this holds on every Compute. Its
 * config check takes only a string or a strict {source, provider, id} with a provider there
 * (`SecretInputSchema`), so any other object stops the Gateway with exit code 78 (findings 3061,
 * 3062); it exits on a SecretRef it cannot read while its configuration validates (finding 3057;
 * `secretInputReference`). A file or exec id is left to OpenClaw's own check. Each refusal ends
 * with the step that fixes it; `step: false` leaves that step out of a reference OpenClaw would
 * not read, for a caller that offers its own fix (SSH Compute's rendered reference).
 */
export function gatewayPasswordRequirement(
  password: unknown,
  secrets: unknown,
  { step = true }: { readonly step?: boolean } = {},
): string | undefined {
  const reference = asObject(password);
  if (reference === undefined) {
    return undefined;
  }
  const { source, provider, id } = reference;
  if (
    typeof source !== "string" ||
    !SECRET_REF_SOURCES.includes(source) ||
    typeof id !== "string" ||
    id.trim() === ""
  ) {
    const example = generatedGatewayPasswordReference(secrets);
    return `is not a SecretRef OpenClaw reads: use {source: "env", provider: "${example.provider}", id: "${example.id}"}`;
  }
  if (Object.keys(reference).some((key) => !["source", "provider", "id"].includes(key))) {
    return "holds keys other than source, provider and id, which OpenClaw refuses: remove them";
  }
  // A null, blank or non-text provider names none, as a missing one does.
  if (typeof provider !== "string" || provider.trim() === "") {
    return requirementText(providerlessUnreadable(source, secrets));
  }
  const read = secretInputReference(reference, secrets);
  if (read === undefined || !("requirement" in read)) {
    return undefined;
  }
  return step ? read.requirement : read.problem;
}
