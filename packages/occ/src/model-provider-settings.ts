import type {
  ConfigurationValidationOptions,
  OpenClawConfigurationDocument,
} from "@openclaw-enterprise/contracts";
import { asRecord, numericLastLabel } from "@openclaw-enterprise/utils";

import { environmentReference, environmentReferenceNames } from "./environment-references.ts";
import {
  ConfigurationHarnessError,
  configurationSettingMessage,
  keyedSettingPath,
  ModelProviderSettingError,
  quotedSettingKey,
} from "./errors.ts";

/**
 * Model API adapter ids the pinned OpenClaw runtime accepts: `MODEL_DATA_APIS` in
 * openclaw/openclaw `packages/llm-core/src/model-data.ts` at the `OPENCLAW_COMMIT` in
 * `deploy/runtime/Dockerfile`. Update this list when that pin changes.
 */
const RUNTIME_MODEL_APIS: readonly string[] = Object.freeze([
  "openai-completions",
  "openai-responses",
  "openai-chatgpt-responses",
  "anthropic-messages",
  "google-generative-ai",
  "google-interactions",
  "google-vertex",
  "github-copilot",
  "bedrock-converse-stream",
  "ollama",
  "pi-messages",
  "azure-openai-responses",
]);

const pointer = (...segments: readonly (string | number)[]): string =>
  segments
    .map((segment) => `/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`)
    .join("");

const holdsEnvironmentReference = (value: unknown): boolean =>
  typeof value === "string" && environmentReferenceNames(value).length > 0;

// Text its writer fills in later: `unresolved` locates an unfilled Preset variable's text.
type Unresolved = NonNullable<ConfigurationValidationOptions["unresolved"]>;

// An http(s) URL must write exactly two slashes after its scheme (a backslash reads as a slash).
// The URL parser treats them as optional: `https:/v1` and `https:v1` parse with `v1` as the host
// (finding 1259), and an empty authority (`https:///v1`, as an empty Preset variable for the
// host renders it) with the first path segment as the host (finding 1256).
const isRuntimeUrl = (value: unknown): boolean => {
  const url = typeof value === "string" && URL.canParse(value) ? new URL(value) : undefined;
  return (
    (url?.protocol === "http:" || url?.protocol === "https:") &&
    /^[\0- ]*https?:[/\\]{2}(?![/\\])/i.test(String(value).replaceAll(/[\t\n\r]/g, ""))
  );
};

// Whether a baseUrl that holds an environment reference writes exactly two slashes after a literal
// http(s) scheme, as `isRuntimeUrl` requires (finding 1259): `https:${HOST}/v1` is refused, though
// the URL parser would read it filled, and so is a fallback that renders `https:/v1` or
// `https:///v1`. The runtime fills the reference before it parses the URL, so the text after the
// slashes is its to check. `literals` is one rendering of the text around the references and any
// Preset variables.
function writesSchemeSlashes(literals: readonly string[]): boolean {
  const [first = ""] = literals.map((literal) => literal.replaceAll(/[\t\n\r]/g, ""));
  const scheme = /^[\0- ]*https?:/i.exec(first);
  return scheme === null || /^[/\\]{2}(?![/\\])/.test(first.slice(scheme[0].length));
}

// Whether a baseUrl's text, as written up to its first variable, starts with an http(s) scheme
// followed by one or no slash (`https:/v1`, `https:v1`, `https:${HOST}`, `https:{{ vars.host }}`),
// so its refusal can say the `//` is missing (finding 1285). An empty authority (`https:///v1`)
// keeps the general message.
const missesSchemeSlashes = (first: string): boolean =>
  /^[\0- ]*https?:(?![/\\]{2})/i.test(first.replaceAll(/[\t\n\r]/g, ""));

/**
 * Whether a refused baseUrl fails only because its host ends in a numeric or 0x label, which the
 * URL parser reads as an IPv4 address and refuses unless the host is one (`https://api.123/v1`,
 * `https://999.1.2.3/v1`), so its refusal can say so (finding 1346): with that label a name, the
 * same text is accepted. `literals` is the text around a Preset's unfilled variables, each filled
 * as `fillsAsRuntimeUrl` fills it with a name. Other refusals keep the general message.
 */
function refusedForNumericLastLabel(literals: readonly string[]): boolean {
  const [first = "", ...rest] = literals.map((literal) => literal.replaceAll(/[\t\n\r]/g, ""));
  const start = first.slice(first.search(/[^\0- ]|$/));
  const scheme = /^https?:/i.exec(start)?.[0];
  if (scheme === undefined) {
    return false;
  }
  // The URL parser also trims trailing C0 controls and spaces.
  let text = scheme + fillUrl([start.slice(scheme.length), ...rest], "x");
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) <= 0x20) {
    end -= 1;
  }
  text = text.slice(0, end);
  // An http(s) authority ends at a slash, backslash, query or fragment; its host follows the last
  // `@` and ends at the port's colon.
  const [, before = "", host = ""] =
    /^(https?:[/\\]{2}(?:[^/\\?#]*@)?)([^/\\?#:]*)/i.exec(text) ?? [];
  const name = host.endsWith(".") ? host.slice(0, -1) : host;
  const label = name.slice(name.lastIndexOf(".") + 1);
  return (
    numericLastLabel(host) &&
    isRuntimeUrl(
      `${before}${name.slice(0, name.length - label.length)}x${host.slice(name.length)}${text.slice(before.length + host.length)}`,
    )
  );
}

// Where a variable sits in a baseUrl with a literal http(s) scheme, and the one token it stands
// for there: a host name or number, an empty port (or `:port` after an IPv6 address), an IPv6
// address (the whole bracketed address, whatever literal text surrounds the variable in it), or
// path text.
type UrlPart = "slashes" | "host" | "port" | "brackets" | "path";

/**
 * Whether a baseUrl that waits on variables (`literals`, the text around them) can be filled as
 * an http(s) URL, in time linear in its length. The URL parser ignores tabs and newlines and
 * trims leading C0 controls and spaces, as here.
 * - When a variable comes before the scheme's colon, it completes the scheme or is the whole URL,
 *   and may end in `#` after which any text parses, so the URL is refused only when its literal
 *   start begins no `http` or `https` scheme.
 * - Otherwise a scheme other than http(s) is refused, and each variable is filled with the token
 *   for where it sits, so text around it that no host, port or path admits (a space in the host,
 *   letters after the port) is refused. A variable that would have to supply a delimiter, such as
 *   a bracket or a slash, to make the URL parse is refused too: fill it at the launch instead.
 * `hostToken` is tried as a name and as a number, since a numeric last label makes the whole
 * host an IPv4 address (`{{ vars.net }}.1`) and a name's labels need not be numeric.
 */
function fillsAsRuntimeUrl(literals: readonly string[]): boolean {
  const [first = "", ...rest] = literals.map((literal) => literal.replaceAll(/[\t\n\r]/g, ""));
  const start = first.slice(first.search(/[^\0- ]|$/));
  const colon = start.indexOf(":");
  if (colon === -1) {
    return "https".startsWith(start.toLowerCase());
  }
  const scheme = start.slice(0, colon + 1);
  if (!/^https?:$/i.test(scheme)) {
    return false;
  }
  const after = [start.slice(colon + 1), ...rest];
  return ["x", "1"].some((hostToken) => isRuntimeUrl(scheme + fillUrl(after, hostToken)));
}

// The text after an http(s) scheme's colon with each variable between `literals` filled.
function fillUrl(literals: readonly string[], hostToken: string, slashesToken = hostToken): string {
  const tokens: Readonly<Record<Exclude<UrlPart, "brackets">, string>> = {
    slashes: slashesToken,
    host: hostToken,
    port: "",
    path: "x",
  };
  let text = "";
  let part: UrlPart = "slashes";
  // Where the open bracket is in `text`, and whether a variable sits in the brackets.
  let bracket = -1;
  let filledBrackets = false;
  for (const [index, literal] of literals.entries()) {
    // The variable before this literal.
    if (index > 0) {
      if (part === "brackets") {
        filledBrackets = true;
      } else {
        text += tokens[part];
        part = part === "slashes" ? "host" : part;
      }
    }
    for (const character of literal) {
      if (part === "slashes" && character !== "/" && character !== "\\") {
        part = "host";
      }
      if (part === "host" || part === "port") {
        if ("/\\?#".includes(character)) {
          part = "path";
        } else if (character === "@") {
          part = "host";
        } else if (character === ":") {
          part = "port";
        } else if (character === "[" && part === "host") {
          part = "brackets";
          bracket = text.length;
          filledBrackets = false;
        }
      } else if (part === "brackets" && character === "]") {
        // Only a port may follow the address, so a variable there is one (`[::1]{{ vars.port }}`).
        part = "port";
        if (filledBrackets) {
          text = `${text.slice(0, bracket + 1)}::1`;
        }
      }
      text += character;
    }
  }
  return text;
}

// `literals` with each unescaped environment reference in them split out as one more variable:
// the runtime fills it before it uses the value. A reference with a `:-fallback` for whose index
// among those `fallback` is true is its fallback text instead, as the runtime renders it when the
// variable is unset. `split.fallbacks` counts the references with a fallback.
function splitEnvironmentReferences(
  literals: readonly string[],
  fallback: (index: number) => boolean,
): string[] & { fallbacks: number } {
  const split = Object.assign([""], { fallbacks: 0 });
  for (const [index, literal] of literals.entries()) {
    if (index > 0) {
      split.push("");
    }
    let position = 0;
    for (const match of literal.matchAll(environmentReference)) {
      split[split.length - 1] += literal.slice(position, match.index);
      if (match[1] !== undefined) {
        split[split.length - 1] += match[0];
      } else if (match[2] !== undefined && fallback(split.fallbacks++)) {
        split[split.length - 1] += match[2];
      } else {
        split.push("");
      }
      position = match.index + match[0].length;
    }
    split[split.length - 1] += literal.slice(position);
  }
  return split;
}

/**
 * Whether a URL carries a user name or password: a credential in the URL (finding 1244). On a
 * Preset save, `literals` is the text around its unfilled variables (`unresolved`), and an
 * environment reference is a variable too (or its `:-fallback` text, as the runtime renders it
 * when unset), so the URL need not parse as written (finding 1250).
 * - Each variable is filled with the token for where it sits, as for the baseUrl rule, so literal
 *   text before an `@` in the authority, or a variable that is the whole user name or password,
 *   is found whatever fills the host, the port or the path. A variable right after the scheme's
 *   colon is also tried empty, as the slashes may follow it.
 * - A variable before the scheme's colon fills the scheme; one that leads the URL with no colon
 *   after it fills a scheme and a host.
 * - The authority is also read as the URL parser does, with each variable a letter: the last `@`
 *   before its end splits off userinfo, whatever brackets surround it, and a backslash ends it
 *   only on a special scheme (either way when a variable fills the scheme). A literal port that
 *   only a variable supplying an `@` could make parse (`user:pass{{ vars.host }}`) counts too.
 * A whole reference or variable is no credential: it is checked once filled. Nor is an all-digit
 * password a variable could turn a port into (`{{ vars.u }}:4242{{ vars.host }}`). A special
 * scheme with no slashes then an `@` after an empty variable reads as userinfo
 * (`https:{{ vars.host }}/v1@beta`).
 */
export function urlHoldsUserinfo(value: string, literals: readonly string[] = [value]): boolean {
  return environmentRenderings(literals).some(holdsUserinfo);
}

// `literals` as the runtime may render its environment references: every reference set, every
// fallback rendered, and each of the first `alone` fallbacks alone with the rest set. Each
// rendering reads the whole text, so all of them cost time quadratic in its length (finding 1265).
// `writesSchemeSlashes` reads only the text before the first variable, which rendering a later
// fallback alone leaves as when every reference is set (fallbacks are numbered in order), so it
// needs only the first fallback alone (`alone` 1).
function environmentRenderings(literals: readonly string[], alone = Infinity): string[][] {
  const { fallbacks } = splitEnvironmentReferences(literals, () => false);
  return [
    () => false,
    () => true,
    ...Array.from(
      { length: Math.min(fallbacks, alone) },
      (_, only) => (index: number) => index === only,
    ),
  ].map((fallback) => splitEnvironmentReferences(literals, fallback));
}

function holdsUserinfo(literals: readonly string[]): boolean {
  const [head = "", ...tail] = literals.map((literal) => literal.replaceAll(/[\t\n\r]/g, ""));
  const parts = [head.slice(head.search(/[^\0- ]|$/)), ...tail];
  // The scheme ends at the first colon that comes before any slash, query, fragment or `@`.
  const index = parts.findIndex((part) => /[:/\\?#@]/.test(part));
  const part = parts[index] ?? "";
  const at = part.search(/[:/\\?#@]/);
  let scheme: string;
  let rest: string[];
  if (part[at] === ":") {
    scheme = index === 0 ? part.slice(0, at + 1) : "";
    rest = [part.slice(at + 1), ...parts.slice(index + 1)];
  } else if (index !== 0 && parts.length > 1) {
    // A variable leads the URL: an origin, or a scheme and the start of a host.
    scheme = "";
    rest = [`//${parts[0]}`, ...parts.slice(1)];
  } else {
    return false;
  }
  let parsed = false;
  const fills = [
    ["x", "x"],
    ["1", "1"],
  ];
  // A variable right after the scheme's colon may be empty, with the slashes after it.
  if (rest[0] === "") {
    fills.push(["x", ""]);
  }
  for (const [hostToken = "x", slashesToken] of fills) {
    const text = (scheme || "https:") + fillUrl(rest, hostToken, slashesToken);
    if (URL.canParse(text)) {
      const url = new URL(text);
      if (url.username !== "" || url.password !== "") {
        return true;
      }
      parsed = true;
    }
  }
  // The authority as the URL parser reads it: a special scheme also ends it at a backslash. A
  // scheme a variable fills (empty here) may be either.
  const authority = (text: string, special: boolean): string =>
    text
      .slice(text.search(special ? /[^/\\]|$/ : /[^/]|$/))
      .split(special ? /[/\\?#]/ : /[/?#]/, 1)[0] ?? "";
  const special = /^(?:https?|wss?|ftp|file):$/i.test(scheme);
  const port = (text: string, each: boolean): string | undefined =>
    /^(?:\[[^\]]*\]|[^:[\]]*):(.*)$/.exec(authority(text, each))?.[1];
  return (scheme === "" ? [true, false] : [special]).some((each) => {
    const written = authority(rest.join("x"), each);
    const sign = written.lastIndexOf("@");
    if (sign !== -1) {
      return !["", ":"].includes(written.slice(0, sign));
    }
    const filled = port(fillUrl(rest, "x"), each);
    return !parsed && rest.length > 1 && filled !== undefined && /\D/.test(filled);
  });
}

function validateSettings(
  settings: Record<string, unknown>,
  path: readonly (string | number)[],
  provider: boolean,
  unresolved: Unresolved,
  unresolvedType: ConfigurationValidationOptions["unresolvedType"],
) {
  const { baseUrl, api } = settings;
  // A number or boolean variable that is the whole baseUrl or api fills it with no string, which
  // fails every launch (finding 1257).
  for (const field of ["baseUrl", "api"] as const) {
    const type = unresolvedType?.([...path, field]);
    if (type !== undefined && type !== "string") {
      throw new ModelProviderSettingError(pointer(...path, field), field);
    }
  }
  // The runtime resolves an environment reference before it validates the value.
  const environment = holdsEnvironmentReference;
  // On a provider, the runtime treats a blank baseUrl as unset and uses a built-in
  // provider's default endpoint; a model's baseUrl must be a nonempty URL.
  const unsetBaseUrl = provider && typeof baseUrl === "string" && baseUrl.trim() === "";
  if (Object.hasOwn(settings, "baseUrl") && !unsetBaseUrl) {
    const literals = unresolved([...path, "baseUrl"]);
    if (
      environment(baseUrl)
        ? !environmentRenderings(literals ?? [String(baseUrl)], 1).every(writesSchemeSlashes)
        : literals === undefined
          ? !isRuntimeUrl(baseUrl)
          : !fillsAsRuntimeUrl(literals)
    ) {
      // A value that is not a string is refused for its type, whatever text it would make.
      const [first = typeof baseUrl === "string" ? baseUrl : ""] = literals ?? [];
      throw new ModelProviderSettingError(
        pointer(...path, "baseUrl"),
        missesSchemeSlashes(first)
          ? "baseUrlSlashes"
          : typeof baseUrl === "string" &&
              !environment(baseUrl) &&
              refusedForNumericLastLabel(literals ?? [baseUrl])
            ? "baseUrlNumericHost"
            : "baseUrl",
      );
    }
  }
  // An api that waits on a variable names no adapter until it is filled.
  if (
    Object.hasOwn(settings, "api") &&
    !environment(api) &&
    unresolved([...path, "api"]) === undefined
  ) {
    if (typeof api !== "string" || !RUNTIME_MODEL_APIS.includes(api)) {
      throw new ModelProviderSettingError(pointer(...path, "api"), "api");
    }
  }
}

/** The requirement in `providerModelsListError`, for rules that build their own error. */
export const PROVIDER_MODELS_LIST = "must be an array of model entries";

/**
 * The refusal for a `models.providers.<key>.models` that is not a list. OpenClaw accepts only
 * a list there, and the credential rules walk only a list, so a record of model rows would
 * carry their credentials past every rule. Configuration writes and Kubernetes Compute's
 * credential rule refuse it with this message.
 */
export function providerModelsListError(key: string): ConfigurationHarnessError {
  return new ConfigurationHarnessError(
    configurationSettingMessage(
      `${keyedSettingPath("models.providers", key)}.models`,
      PROVIDER_MODELS_LIST,
    ),
  );
}

/**
 * A saved model provider `baseUrl` or `api` that the runtime cannot use otherwise fails
 * only at deployment, as an unexplained startup model check failure. Configuration writes
 * check both on each provider and on each of its models, and refuse a `models` that is not
 * a list (`providerModelsListError`), and header names that are not HTTP field names; other
 * provider settings stay the runtime's to validate. Preset saves pass `unresolved` for their
 * unfilled variables, which the Configuration a Preset creates is checked with.
 */
export function validateModelProviderSettings(
  values: OpenClawConfigurationDocument,
  { unresolved = () => undefined, unresolvedType }: ConfigurationValidationOptions = {},
): void {
  const providers = asRecord(asRecord(values.models)?.providers);
  for (const [providerName, provider] of Object.entries(providers ?? {})) {
    const settings = asRecord(provider);
    if (settings === undefined) {
      continue;
    }
    const path = ["models", "providers", providerName] as const;
    const setting = keyedSettingPath("models.providers", providerName);
    validateSettings(settings, path, true, unresolved, unresolvedType);
    const models = settings.models;
    // The list first, as the Kubernetes rule does, so both name the same setting.
    if (models !== undefined && !Array.isArray(models)) {
      throw providerModelsListError(providerName);
    }
    validateHeaderNames(settings, path, setting, unresolved);
    for (const [index, model] of (Array.isArray(models) ? models : []).entries()) {
      const modelSettings = asRecord(model);
      if (modelSettings !== undefined) {
        validateSettings(
          modelSettings,
          [...path, "models", index],
          false,
          unresolved,
          unresolvedType,
        );
        validateHeaderNames(
          modelSettings,
          [...path, "models", index],
          `${setting}.models.${index}`,
          unresolved,
        );
      }
    }
  }
}

/**
 * The requirement for a model provider header name that is not an HTTP field name. It names the
 * header, as the credential header refusal does, so a name a Preset variable filled is found
 * (finding 1218), but only up to its first invalid character and at most 23 characters: a value
 * pasted into the name ("Authorization: Bearer …", or a bare token and a newline) is never
 * echoed whole (finding 1222), and the cut shows where the name went wrong. On a Preset save,
 * `literals` is the text around the name's unfilled variables, whose placeholders are shown as
 * written. A name whose first character is invalid is named by that character's code point
 * instead of an empty quote (finding 1251).
 */
export function invalidHeaderNameRequirement(
  name: string,
  literals: readonly string[] = [name],
): string {
  let shown = "";
  let rest = name;
  for (const [index, literal] of literals.entries()) {
    if (index > 0) {
      const placeholder = /^\{\{ vars\.[^}]*\}\}/.exec(rest)?.[0] ?? "";
      shown += placeholder;
      rest = rest.slice(placeholder.length);
    }
    const valid = HTTP_FIELD_NAME_START.exec(literal)?.[0] ?? "";
    if (valid.length < literal.length) {
      if (shown === "" && valid === "") {
        const point = literal.codePointAt(0) ?? 0;
        return `must use valid HTTP header names, not one that starts with U+${point.toString(16).toUpperCase().padStart(4, "0")}`;
      }
      return `must use valid HTTP header names, not ${quotedSettingKey(`${shown}${valid}…`, 24)}`;
    }
    shown += valid;
    rest = rest.slice(literal.length);
  }
  return `must use valid HTTP header names, not ${quotedSettingKey(shown, 24)}`;
}

// Every Compute refuses a header name no HTTP client sends (`"x-api-key "`, a lookalike), so a
// literal under it is never stored where the credential rules would not recognize it. The
// Kubernetes rule refuses it with the same message.
function validateHeaderNames(
  settings: Record<string, unknown>,
  path: readonly (string | number)[],
  setting: string,
  unresolved: Unresolved,
): void {
  for (const [headersPath, headersSetting, headers] of [
    [[...path, "headers"], `${setting}.headers`, settings.headers],
    [
      [...path, "request", "headers"],
      `${setting}.request.headers`,
      asRecord(settings.request)?.headers,
    ],
  ] as const) {
    const invalid = Object.keys(asRecord(headers) ?? {}).find(
      (name) => !isAdmittedHeaderName(name, { unresolved }, headersPath),
    );
    if (invalid !== undefined) {
      throw new ConfigurationHarnessError(
        configurationSettingMessage(
          headersSetting,
          invalidHeaderNameRequirement(invalid, unresolved([...headersPath, invalid], true)),
        ),
      );
    }
  }
}

// RFC 9110 field-name token. A name outside it (whitespace, zero-width or non-ASCII
// lookalikes) is not a header any HTTP client sends, so it is refused rather than matched.
const HTTP_FIELD_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HTTP_FIELD_NAME_START = /^[!#$%&'*+.^_`|~0-9A-Za-z-]*/;

/** Whether `name` is a valid HTTP field name (an RFC 9110 token). */
export function isHttpFieldName(name: string): boolean {
  return HTTP_FIELD_NAME.test(name);
}

/**
 * Whether a model provider header name passes the header name rule: a valid HTTP field name. On a
 * Preset save, a name that holds an unfilled variable (`unresolved`, at `headers`, the path of its
 * headers object) is checked with a stand-in for each variable, so the text around it must be
 * valid too (finding 1221), and checked again once filled. Every Compute and Kubernetes
 * Compute's credential rule use it, so a Preset saves alike on both.
 */
export function isAdmittedHeaderName(
  name: string,
  { unresolved }: ConfigurationValidationOptions = {},
  headers: readonly (string | number)[] = [],
): boolean {
  const literals = unresolved?.([...headers, name], true);
  return isHttpFieldName(literals === undefined ? name : literals.join("x"));
}

// A header whose last hyphen-, underscore- or dot-separated word names a credential:
// Authorization, Authentication, Proxy-Authorization, x-auth-token, cookie, x-client-secret,
// x-credentials, x-passphrase, x-signature, x-bearer, X-JWT-Assertion, x-otp, x-pin, x-pwd,
// x-vercel-protection-bypass and the like, in the singular or the plurals listed. Vendors and gateways each pick their own
// credential header, so a fixed list would miss the next one; matching the whole last word
// keeps names such as x-token-id, x-auth-mode, X-Passthrough or X-Pinned-Version, which carry
// no credential, out.
// Up to two trailing algorithm words and a trailing version word, as in x-hub-signature-256,
// X-Signature-Ed25519, X-HMAC-SHA256, X-Signature-RS256 or x-api-key-v2, are skipped.
const CREDENTIAL_HEADER_SUFFIX = String.raw`(?:[-_.](?:sha[-_.]?\d+|[ehpr]s\d{3}|ed25519|ed448|rsa|ecdsa|md5|blake2[bs]?)){0,2}(?:[-_.]v?\d+)?$`;
const CREDENTIAL_HEADER_WORD = new RegExp(
  String.raw`(?:^|[-_.])(?:assertions?|auths?|authentications?|authorizations?|bearers?|cookies?|credentials?|hmacs?|jwts?|licen[cs]es?|otps?|pass|passcode|passphrase|passwords?|pin|protection[-_.]bypass|pwd|secrets?|signatures?|tokens?)` +
    CREDENTIAL_HEADER_SUFFIX,
  "i",
);
// Any name ending in `key` or `keys` is a credential too (x-api-key, apikey, x-auth-key,
// dd-application-key, x-portkey-virtual-key, a bare key): vendors name keys too freely to
// list. A version glued to the key (x-api-key2, x-api-keyv2) is skipped too. A key's id or name
// (x-api-key-id) ends in another word.
const CREDENTIAL_HEADER_KEY = new RegExp(
  String.raw`(?:key(?:v?\d+)?|keys)` + CREDENTIAL_HEADER_SUFFIX,
  "i",
);
// Keys that name no credential: idempotency, cache, deduplication, partition, shard and sort
// keys. A request or routing key can be a credential (an events API routing key is), so it is
// refused like any other key.
const NON_CREDENTIAL_KEY = new RegExp(
  String.raw`(?:^|[-_.])(?:cache|dedup(?:e|lication)?|idempoten(?:cy|t)|partition|shard|sort)[-_.]?(?:key(?:v?\d+)?|keys)` +
    CREDENTIAL_HEADER_SUFFIX,
  "i",
);

const marksCredential = (name: string): boolean =>
  CREDENTIAL_HEADER_WORD.test(name) ||
  (CREDENTIAL_HEADER_KEY.test(name) && !NON_CREDENTIAL_KEY.test(name));

/**
 * Whether a model provider header with this name carries a credential. On a Preset save, a name
 * that holds an unfilled variable (`unresolved`, at `headers`, the path of its headers object) is
 * also matched as the literal text around its variables, as filled empty, so
 * `Authorization{{ vars.suffix }}` names a credential at save (finding 1244), and is matched again
 * once filled. A variable glued to a credential word (`X-Token{{ vars.suffix }}`) counts too.
 */
export function isCredentialHeaderName(
  name: string,
  { unresolved }: ConfigurationValidationOptions = {},
  headers: readonly (string | number)[] = [],
): boolean {
  const literals = unresolved?.([...headers, name], true);
  return marksCredential(name) || (literals !== undefined && marksCredential(literals.join("")));
}
