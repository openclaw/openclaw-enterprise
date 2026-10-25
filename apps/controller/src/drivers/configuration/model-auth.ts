import type {
  ConfigurationValidationOptions,
  OpenClawConfigurationDocument,
} from "@openclaw-enterprise/contracts";
import {
  configurationSettingMessage,
  environmentReference,
  invalidHeaderNameRequirement,
  isAdmittedHeaderName,
  isCredentialHeaderName,
  keyedSettingPath,
  ModelCredentialValueError,
  refuseLiteralGatewayPassword,
  secretInputShorthandName,
} from "@openclaw-enterprise/occ";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";
import { createUrlCredentialChecks } from "./url-credentials.ts";

export class ConfigurationValidationError extends Error {}

// A setting's location, as `options.unresolved` takes it: a list index is a number.
type SettingPath = readonly (string | number)[];

const pointer = (...segments: readonly (string | number)[]): string =>
  segments
    .map((segment) => `/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`)
    .join("");

// Proxy environment variables, in any case (`HTTPS_PROXY`, `all_proxy`, `npm_config_proxy`).
// `NO_PROXY` lists hosts, not a proxy.
const PROXY_ENVIRONMENT = /^(?!no_proxy$)(?:\w*_)?proxy$/i;

// git reads `GIT_CONFIG_VALUE_<n>` as the value of the config key `GIT_CONFIG_KEY_<n>` names.
const GIT_CONFIG_SLOT = /^GIT_CONFIG_(KEY|VALUE)_(\d+)$/i;
// The git config sections whose `proxy` key git and curl read as a proxy URL (`http.proxy`,
// `http.<url>.proxy`, `remote.<name>.proxy`), and `https.`, which git ignores but users write.
// `core.gitProxy` names a command, not a URL.
const GIT_PROXY_SECTIONS = ["http.", "https.", "remote."];

/**
 * Whether the git config key `key` can name a proxy, in any case, where each `\0` stands for text
 * a variable or reference may fill: it starts with a proxy section and ends in `.proxy`. Text a
 * variable fills can complete both ends.
 */
function namesGitProxy(key: string): boolean {
  const text = key.toLowerCase();
  const pieces = text.split("\0");
  if (pieces.length === 1) {
    return GIT_PROXY_SECTIONS.some(
      (section) =>
        text.startsWith(section) && text.endsWith(".proxy") && text.length >= section.length + 5,
    );
  }
  const first = pieces[0] ?? "";
  const last = pieces.at(-1) ?? "";
  return (
    (last.endsWith(".proxy") || ".proxy".endsWith(last)) &&
    GIT_PROXY_SECTIONS.some((section) => first.startsWith(section) || section.startsWith(first))
  );
}

// One shell-quoted word of `GIT_CONFIG_PARAMETERS`, where `'\''` and `'\!'` quote `'` and `!`.
const QUOTED = String.raw`'((?:[^']|'\\[!']')*)'`;
// Its `'key'='value'` and `'key=value'` pairs, as `git -c` writes them.
const GIT_CONFIG_PARAMETER = new RegExp(`${QUOTED}(?:=${QUOTED})?`, "g");
const unquote = (word: string): string => word.replaceAll(/'\\([!'])'/g, "$1");

/** The `[key, value]` pairs of `GIT_CONFIG_PARAMETERS` text. */
function gitConfigParameters(text: string): [string, string][] {
  return [...text.matchAll(GIT_CONFIG_PARAMETER)].map(([, word = "", value]) => {
    if (value !== undefined) {
      return [unquote(word), unquote(value)];
    }
    const pair = unquote(word);
    const equals = pair.indexOf("=");
    return equals === -1 ? [pair, ""] : [pair.slice(0, equals), pair.slice(equals + 1)];
  });
}

// A credential header outside `models.providers` (MCP servers, memory search, media models, web
// fetch, OpenTelemetry export, edge auth), a key and a media query option outside it: none is
// the Agent's model credential.
const credentialHeaderMessage = (path: string): string =>
  `Configuration field ${path} holds a credential value inline, where a reference is required. Make the header value a \${NAME} reference, or Bearer \${NAME} for an Authorization header.`;
const credentialKeyMessage = (path: string): string =>
  `Configuration field ${path} holds a credential value inline, where a reference is required. Make the value a \${NAME} reference or a SecretRef.`;
// A key slot's value that holds a reference the runtime substitutes, but not as the whole value:
// the `$NAME` form, a `${NAME:-fallback}`, or a `${NAME}` with other text, spaces or references
// (findings 2493, 2503). The message names the form and never the text, which may hold the
// credential, and names the setting as Configuration save's channel rules do
// (`channels.slack.botToken`); any other value keeps credentialKeyMessage.
function referenceFormMessage(value: unknown): ((path: string) => string) | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const references = [...value.matchAll(environmentReference)].filter(
    ([, escaped]) => escaped === undefined,
  );
  const requirement =
    secretInputShorthandName(value) !== undefined
      ? "holds a $NAME value, where a credential reference is required. Write it as one ${NAME} reference, or a SecretRef"
      : references.some(([, , fallback]) => fallback !== undefined)
        ? "holds a ${NAME:-…} fallback, which would replace a missing credential. Make the value one ${NAME} reference without a fallback, or a SecretRef"
        : references.length > 0
          ? "holds a ${NAME} reference with other text, spaces or references. Make the value exactly one ${NAME} reference, or a SecretRef"
          : undefined;
  return requirement === undefined
    ? undefined
    : (path) => configurationSettingMessage(settingPath(path), requirement);
}
// The Configuration setting a JSON pointer names, such as `channels.slack.botToken`.
function settingPath(path: string): string {
  const [first = "", ...keys] = path
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  return keys.reduce((parent, key) => keyedSettingPath(parent, key), first);
}
// A media query option that counts tokens rather than carrying one.
const TOKEN_COUNT_OPTION =
  /(?:^|[-_.])(?:max|min|num|total|context|input|output|completion)[-_.]?tokens?$/i;
const credentialOptionMessage = (path: string): string =>
  `Configuration field ${path} holds a credential value inline, where a reference is required. Make the option value a \${NAME} reference.`;

// OpenClaw's rule for the settings of plugins and channels (`isSensitiveConfigPath` in the pinned
// src/config/sensitive-paths.ts), matched against each key: a name that ends in "token" or names
// a password, secret, API key, encryption or private key, or a service account. A key that names
// the file, path, directory or environment variable a credential is read from (`secretFile`,
// `apiKeyEnv`) holds no credential itself.
const SENSITIVE_SETTING =
  /token$|password|secret|api.?key|encrypt.?key|private.?key|serviceaccount(?:ref)?$/i;
const CREDENTIAL_LOCATION_SETTING = /(?:file|path|dir|env)$/i;
// A Google Chat service account may also be an inline JSON object, a credential too.
const SERVICE_ACCOUNT_SETTING = /serviceaccount$/i;
// Settings the pinned OpenClaw's bundled plugin and channel manifests mark sensitive (`uiHints`,
// `configContracts.secretInputs`) whose key the rule misses, as dotted paths under
// `plugins.entries.<id>.config` or `channels.<id>` (`*` for any key). A `headers` map (Codex's
// `appServer.headers`, Comfy's) follows the credential header rule. acpx's `mcpServers.*.env.*` is
// an environment map, which keeps the rules every environment map has (finding 1309 follow-up).
const SENSITIVE_MANIFEST_SETTINGS: Readonly<Record<string, readonly string[]>> = {
  "plugins/voice-call": ["telnyx.publicKey"],
  "channels/synology-chat": [
    "incomingUrl",
    "webhookUrl",
    "accounts.*.incomingUrl",
    "accounts.*.webhookUrl",
  ],
};

const isSecretRef = (value: unknown): boolean => {
  const reference = asRecord(value);
  return (
    reference !== undefined &&
    Object.keys(reference).length === 3 &&
    [reference.source, reference.provider, reference.id].every(isNonEmptyString)
  );
};

// The provider headers refused as literals before the 2026-10-12 notice.
const STORED_CREDENTIAL_HEADER = /^(?:authorization|api-key|x-api-key)$/i;

/**
 * Known native model credential slots must store unresolved references, never values.
 *
 * `stored` checks a document read back from storage: only the slots refused before the
 * 2026-10-12 notice (the provider `apiKey`, its `authorization`, `api-key` and `x-api-key`
 * headers, and the model credential environment); no release stored a literal there, so the
 * Driver refuses to read one. A document an older release saved with a literal in a slot
 * refused since still reads, so its operator can see and replace it; every write and
 * deployment checks all slots. A Preset save passes `unresolved`, so a credential header name that
 * waits on a variable is found as on Kubernetes Compute (`isCredentialHeaderName`). Writes also
 * refuse a user name or password in a native URL (`urlHoldsUserinfo`): model and proxy URLs,
 * channel proxies, MCP server URLs, a URL in any environment value of any environment map, Codex's
 * network proxy and speech and Talk provider proxies. MCP server credential headers hold references
 * too, and so do the other key and header slots the Gateway sends: memory search, media
 * understanding requests, speech and Talk provider keys, web fetch and OpenTelemetry headers, skill
 * keys and the cron webhook token, as do the other slots OpenClaw marks sensitive: Gateway, hooks,
 * sandbox SSH and storage secrets, and the sensitive settings of channels and plugins (writes
 * only).
 */
export function validateModelCredentialReferences(
  values: OpenClawConfigurationDocument,
  {
    stored = false,
    ...options
  }: { readonly stored?: boolean } & ConfigurationValidationOptions = {},
): void {
  const validateReference = (
    value: unknown,
    path: string,
    authorizationHeader = false,
    message?: (path: string) => string,
  ): void => {
    if (value === undefined || value === null) {
      return;
    }
    if (typeof value === "string" && /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)) {
      return;
    }
    if (
      authorizationHeader &&
      typeof value === "string" &&
      /^Bearer \$\{[A-Za-z_][A-Za-z0-9_]*\}$/i.test(value)
    ) {
      return;
    }
    if (isSecretRef(value)) {
      return;
    }
    throw new ModelCredentialValueError(
      path,
      message === credentialKeyMessage ? (referenceFormMessage(value) ?? message) : message,
    );
  };
  // Whether a header named `name` in the headers object at `headersPath` carries a credential, and
  // whether it may hold `Bearer ${NAME}`: some gateways carry the bearer token in an
  // Authentication header. On a Preset save, the text around a name's variables is matched too,
  // as for the credential rule.
  const credentialHeader = (
    headersPath: readonly (string | number)[],
    name: string,
  ): { readonly authorization: boolean } | undefined => {
    if (!isCredentialHeaderName(name, options, headersPath)) {
      return undefined;
    }
    const literal = options.unresolved?.([...headersPath, name], true)?.join("");
    return {
      authorization: [name, literal].some(
        (text) => text !== undefined && /auth(?:entication|orization)(?:[-_.]v?\d+)?$/i.test(text),
      ),
    };
  };
  const { refuseUrlUserinfo, refuseEnvironmentUserinfo, refuseProxyUserinfo } =
    createUrlCredentialChecks(
      (path) => options.unresolved?.(path),
      (path, reason) => {
        throw new ModelCredentialValueError(pointer(...path), reason);
      },
    );

  // Each credential header in the headers object at `headersPath` must hold a reference. Outside
  // `models.providers`, whose names the model provider settings check, `message` is passed and a
  // name that is not an HTTP field name (`"Authorization "`, a lookalike) is refused too: the
  // credential rule would not recognize a literal under it, which would reach the ConfigMap.
  const refuseCredentialHeaders = (
    headersPath: SettingPath,
    headers: unknown,
    message?: (path: string) => string,
  ): void => {
    for (const [name, value] of Object.entries(asRecord(headers) ?? {})) {
      if (message && !isAdmittedHeaderName(name, options, headersPath)) {
        const requirement = invalidHeaderNameRequirement(
          name,
          options.unresolved?.([...headersPath, name], true),
        );
        throw new ModelCredentialValueError(
          pointer(...headersPath),
          (path) => `Configuration field ${path} ${requirement}.`,
        );
      }
      const credential = credentialHeader(headersPath, name);
      if (credential) {
        validateReference(value, pointer(...headersPath, name), credential.authorization, message);
      }
    }
  };
  // The credential slots of a provider request OpenClaw sends: a model provider's and each of its
  // models', and a media understanding entry's (`tools.media`), which share the request shape.
  // Outside `models.providers` the refusals name no model credential (`headerMessage`,
  // `keyMessage`).
  const refuseRequestCredentials = (
    path: SettingPath,
    row: Record<string, unknown> | undefined,
    headerMessage?: (path: string) => string,
    keyMessage?: (path: string) => string,
  ): void => {
    const request = asRecord(row?.request);
    refuseCredentialHeaders([...path, "headers"], row?.headers, headerMessage);
    refuseCredentialHeaders([...path, "request", "headers"], request?.headers, headerMessage);
    // OpenClaw's request.auth credential slots: the authorization-bearer token and the header
    // mode's value.
    const auth = asRecord(request?.auth);
    validateReference(auth?.token, pointer(...path, "request", "auth", "token"), false, keyMessage);
    validateReference(auth?.value, pointer(...path, "request", "auth", "value"), false, keyMessage);
    // The client certificate, key and passphrase for the endpoint and for its proxy.
    const proxy = asRecord(request?.proxy);
    for (const [tlsPath, tls] of [
      [[...path, "request", "tls"], asRecord(request?.tls)],
      [[...path, "request", "proxy", "tls"], asRecord(proxy?.tls)],
    ] as const) {
      for (const field of ["cert", "key", "passphrase"]) {
        validateReference(tls?.[field], pointer(...tlsPath, field), false, keyMessage);
      }
    }
    // A proxy URL with userinfo is a credential (undici sends it as Proxy-Authorization), and so
    // is an endpoint's (fetch refuses a URL that holds one), even where a variable or an
    // environment reference fills its host or port (finding 1250).
    refuseUrlUserinfo([...path, "baseUrl"], row?.baseUrl);
    refuseUrlUserinfo([...path, "request", "proxy", "url"], proxy?.url);
    // A media entry's `providerOptions.<provider>` go into the request's query string, where a
    // provider such as Google reads its key: an option named as a credential, in any case or
    // camelCase, holds a reference. A token count (`max_tokens`, `maxOutputTokens`) names none,
    // as OpenClaw's own sensitive-key rule allows.
    for (const [provider, settings] of Object.entries(asRecord(row?.providerOptions) ?? {})) {
      const optionsPath = [...path, "providerOptions", provider];
      for (const [option, value] of Object.entries(asRecord(settings) ?? {})) {
        const words = option.replaceAll(/([a-z0-9])([A-Z])/g, "$1-$2");
        if (
          !TOKEN_COUNT_OPTION.test(words) &&
          (isCredentialHeaderName(option, options, optionsPath) || isCredentialHeaderName(words))
        ) {
          validateReference(value, pointer(...optionsPath, option), false, credentialOptionMessage);
        }
      }
    }
  };
  // The settings of one plugin or channel, `owner` (a `SENSITIVE_MANIFEST_SETTINGS` key), at
  // `root` (finding 1309). A string under a sensitive key, or in a list under one, holds a
  // `${NAME}` reference. Under a sensitive key a SecretRef passes and any other object is read key
  // by key, each child judged by its own name, except a service account, refused whole. OpenClaw
  // refuses other shapes there, so it never reads them. A `headers` map follows the credential
  // header rule, and an `env` map keeps the environment rules above. A number or boolean
  // (`requireToken: true`) passes.
  const refuseSensitiveSettings = (root: SettingPath, settings: unknown, owner: string): void => {
    const manifest = (SENSITIVE_MANIFEST_SETTINGS[owner] ?? []).map((field) => field.split("."));
    const marked = (relative: SettingPath): boolean =>
      manifest.some(
        (field) =>
          field.length === relative.length &&
          field.every((segment, index) => segment === "*" || segment === relative[index]),
      );
    const pending: [SettingPath, unknown, boolean][] = [[[], settings, false]];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      const [relative, value, sensitive] = next;
      const path = [...root, ...relative];
      const key = relative.at(-1);
      if (typeof value === "string") {
        if (sensitive) {
          validateReference(value, pointer(...path), false, credentialKeyMessage);
        }
        continue;
      }
      // Each child is queued last to first, so the first refused setting in the document is named.
      if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index -= 1) {
          pending.push([[...relative, index], value[index], sensitive]);
        }
        continue;
      }
      const record = asRecord(value);
      if (record === undefined || (sensitive && isSecretRef(record))) {
        continue;
      }
      if (sensitive && typeof key === "string" && SERVICE_ACCOUNT_SETTING.test(key)) {
        validateReference(record, pointer(...path), false, credentialKeyMessage);
      }
      if (key === "headers") {
        refuseCredentialHeaders(path, record, credentialHeaderMessage);
        continue;
      }
      if (key === "env") {
        continue;
      }
      for (const [name, child] of Object.entries(record).reverse()) {
        const at = [...relative, name];
        pending.push([
          at,
          child,
          (SENSITIVE_SETTING.test(name) && !CREDENTIAL_LOCATION_SETTING.test(name)) || marked(at),
        ]);
      }
    }
  };

  const providers = asRecord(asRecord(values.models)?.providers);
  for (const [providerName, provider] of Object.entries(providers ?? {})) {
    const config = asRecord(provider);
    const providerPath = ["models", "providers", providerName] as const;
    validateReference(config?.apiKey, pointer(...providerPath, "apiKey"));
    if (stored) {
      for (const [name, value] of Object.entries(asRecord(config?.headers) ?? {})) {
        if (STORED_CREDENTIAL_HEADER.test(name)) {
          validateReference(
            value,
            pointer(...providerPath, "headers", name),
            /authorization$/i.test(name),
          );
        }
      }
      continue;
    }
    // A model's index is a number, as in the paths `options.unresolved` locates text by.
    const rows: [readonly (string | number)[], Record<string, unknown> | undefined][] = [
      [providerPath, config],
      ...(Array.isArray(config?.models) ? config.models : []).map(
        (model, index): [readonly (string | number)[], Record<string, unknown> | undefined] => [
          [...providerPath, "models", index],
          asRecord(model),
        ],
      ),
    ];
    for (const [path, row] of rows) {
      refuseRequestCredentials(path, row);
    }
  }
  const env = asRecord(values.env);
  if (!stored) {
    // The other native URLs a password can ride in (finding 1255): the Gateway's egress proxy,
    // every channel's proxy and its accounts', and MCP server URLs, on the Gateway and on nodes.
    refuseUrlUserinfo(["proxy", "proxyUrl"], asRecord(values.proxy)?.proxyUrl);
    for (const [channel, settings] of Object.entries(asRecord(values.channels) ?? {})) {
      const config = asRecord(settings);
      refuseUrlUserinfo(["channels", channel, "proxy"], config?.proxy);
      for (const [account, accountSettings] of Object.entries(asRecord(config?.accounts) ?? {})) {
        refuseUrlUserinfo(
          ["channels", channel, "accounts", account, "proxy"],
          asRecord(accountSettings)?.proxy,
        );
      }
    }
    // The environment (HTTPS_PROXY, PIP_INDEX_URL, ...) reaches the Gateway and every process it
    // starts, and an MCP server's `env` its stdio process (finding 1259). Clients such as curl
    // and git read a proxy without a scheme as http. On a Preset save, a name that waits on a
    // variable is matched as the text around it (`{{ vars.scheme }}_PROXY`), as for credential
    // header names.
    const environments: [readonly string[], Record<string, unknown> | undefined][] = [
      [["env"], env],
      [["env", "vars"], asRecord(env?.vars)],
    ];
    for (const at of [["mcp"], ["nodeHost", "mcp"]]) {
      const mcp = at.reduce<Record<string, unknown> | undefined>(
        (parent, key) => asRecord(parent?.[key]),
        values,
      );
      for (const [server, settings] of Object.entries(asRecord(mcp?.servers) ?? {})) {
        refuseUrlUserinfo([...at, "servers", server, "url"], asRecord(settings)?.url);
        // An MCP server's credential headers hold references, as a model provider's do (finding
        // 1278): OpenClaw marks these headers sensitive.
        refuseCredentialHeaders(
          [...at, "servers", server, "headers"],
          asRecord(settings)?.headers,
          credentialHeaderMessage,
        );
        environments.push([[...at, "servers", server, "env"], asRecord(asRecord(settings)?.env)]);
      }
    }
    // The proxy URLs plugins read (finding 1259): Codex's network proxy, the acpx plugin's MCP
    // server environments, and a speech provider's `proxy` (Microsoft's) in every TTS block and
    // Talk provider.
    const plugins = asRecord(asRecord(values.plugins)?.entries);
    const get = (parent: unknown, keys: readonly string[]): unknown =>
      keys.reduce((value, key) => asRecord(value)?.[key], parent);
    const at = (parent: unknown, keys: readonly string[]) => asRecord(get(parent, keys));
    const codex = ["codex", "config", "appServer", "networkProxy"];
    for (const field of ["proxyUrl", "socksUrl"]) {
      refuseUrlUserinfo(["plugins", "entries", ...codex, field], get(plugins, [...codex, field]));
    }
    const acpx = ["acpx", "config", "mcpServers"];
    for (const [server, settings] of Object.entries(at(plugins, acpx) ?? {})) {
      environments.push([
        ["plugins", "entries", ...acpx, server, "env"],
        asRecord(asRecord(settings)?.env),
      ]);
    }
    // The entries of the keyed map at `path`, listed once: several rules below read each Agent in
    // agents.entries, and a large roster must not be listed for each (finding 1321).
    const listed = new Map<string, [string, unknown][]>();
    const children = (path: readonly string[]): [string, unknown][] => {
      const name = path.join(".");
      let found = listed.get(name);
      if (found === undefined) {
        found = Object.entries(at(values, path) ?? {});
        listed.set(name, found);
      }
      return found;
    };
    // Each key's setting at `each`. A key without one has nothing to check and is skipped, so a
    // large roster of Agents without the setting costs a lookup each (finding 1321).
    const keyed = (path: readonly string[], each: readonly string[]): [SettingPath, unknown][] => {
      const found: [SettingPath, unknown][] = [];
      for (const [key, settings] of children(path)) {
        const value = get(settings, each);
        if (value !== undefined) {
          found.push([[...path, key, ...each], value]);
        }
      }
      return found;
    };
    // TTS blocks: the Gateway's, each Agent's, Discord voice's (and its accounts'), voice-call's
    // and its numbers'. Each holds `providers` and personas that hold them too.
    const voiceCall = ["plugins", "entries", "voice-call", "config"];
    const discord = ["channels", "discord"];
    const tts: [SettingPath, unknown][] = [
      [["tts"], values.tts],
      ...keyed(["agents", "entries"], ["tts"]),
      [[...discord, "voice", "tts"], get(values, [...discord, "voice", "tts"])],
      ...keyed([...discord, "accounts"], ["voice", "tts"]),
      [[...voiceCall, "tts"], get(values, [...voiceCall, "tts"])],
      ...keyed([...voiceCall, "numbers"], ["tts"]),
    ];
    const providerBlocks: [SettingPath, unknown][] = [
      ...tts.flatMap(([path, block]): [SettingPath, unknown][] => [
        [path, block],
        ...Object.entries(at(block, ["personas"]) ?? {}).map(
          ([persona, settings]): [SettingPath, unknown] => [
            [...path, "personas", persona],
            settings,
          ],
        ),
      ]),
      [["talk"], values.talk],
      [["talk", "realtime"], get(values, ["talk", "realtime"])],
    ];
    for (const [path, block] of providerBlocks) {
      for (const [provider, settings] of Object.entries(at(block, ["providers"]) ?? {})) {
        refuseUrlUserinfo([...path, "providers", provider, "proxy"], asRecord(settings)?.proxy);
        // The speech or Talk provider's key, which OpenClaw marks sensitive (finding 1307).
        validateReference(
          asRecord(settings)?.apiKey,
          pointer(...path, "providers", provider, "apiKey"),
          false,
          credentialKeyMessage,
        );
      }
    }
    // The other key and header slots OpenClaw sends a provider (finding 1307): the memory search
    // embedding endpoint's (the Gateway's and each Agent's), every media understanding entry's
    // request (`tools.media.models` and each capability's defaults; the per-capability `models`
    // lists older OpenClaw releases read, which Doctor moves, are checked too, since a literal
    // there still reaches the ConfigMap), web fetch, OpenTelemetry export and remote Gateway edge
    // auth headers, a skill's key and the cron webhook's bearer token. These hold references, as
    // a model provider's do.
    const searches: [SettingPath, unknown][] = [
      [["memory", "search"], get(values, ["memory", "search"])],
      ...keyed(["agents", "entries"], ["memory", "search"]),
    ];
    for (const [path, search] of searches) {
      const remote = at(search, ["remote"]);
      validateReference(
        remote?.apiKey,
        pointer(...path, "remote", "apiKey"),
        false,
        credentialKeyMessage,
      );
      refuseCredentialHeaders(
        [...path, "remote", "headers"],
        remote?.headers,
        credentialHeaderMessage,
      );
      refuseUrlUserinfo([...path, "remote", "baseUrl"], remote?.baseUrl);
    }
    const entries = (path: SettingPath, list: unknown): [SettingPath, unknown][] =>
      Array.isArray(list) ? list.map((row, index) => [[...path, index], row]) : [];
    const media = ["tools", "media"];
    const mediaRequests: [SettingPath, unknown][] = [
      ...entries([...media, "models"], get(values, [...media, "models"])),
      ...["image", "audio", "video"].flatMap((capability): [SettingPath, unknown][] => [
        [[...media, capability], get(values, [...media, capability])],
        ...entries([...media, capability, "models"], get(values, [...media, capability, "models"])),
      ]),
    ];
    for (const [path, row] of mediaRequests) {
      refuseRequestCredentials(path, asRecord(row), credentialHeaderMessage, credentialKeyMessage);
    }
    for (const path of [
      ["tools", "web", "fetch", "headers"],
      ["diagnostics", "otel", "headers"],
      ["gateway", "remote", "edgeAuth"],
    ]) {
      refuseCredentialHeaders(path, get(values, path), credentialHeaderMessage);
    }
    for (const [path, apiKey] of keyed(["skills", "entries"], ["apiKey"])) {
      validateReference(apiKey, pointer(...path), false, credentialKeyMessage);
    }
    validateReference(
      get(values, ["cron", "webhookToken"]),
      pointer("cron", "webhookToken"),
      false,
      credentialKeyMessage,
    );
    // The other slots the pinned OpenClaw schema registers sensitive (finding 1309): the Gateway's
    // inbound auth (the password keeps the message that names the reference Compute fills) and
    // remote auth, the Control UI's GitHub token, the hooks endpoint and Gmail push tokens, sandbox
    // SSH key material (default and per Agent) and each storage location's encryption passphrase.
    // OpenClaw reads a `${NAME}` reference in every one, and a SecretRef where the slot takes one.
    // A hook mapping's `sessionKey`, also registered, is a routing key (often a template), not a
    // credential, and stays as written. The Gateway password also takes `{source: "env", id}`
    // with no provider, the form Kubernetes Compute requires (`usesGatewayPasswordEnvironment`);
    // every other slot takes OpenClaw's SecretRef, whose provider is required. Saves refuse a
    // literal password first (validateConfigurationSettings), but deployment does not run that:
    // this call is what refuses a stored document that predates the rule, with the same message.
    refuseLiteralGatewayPassword(values);
    const sensitiveSlots: [SettingPath, unknown][] = [
      ...[
        ["gateway", "auth", "token"],
        ["gateway", "remote", "token"],
        ["gateway", "remote", "password"],
        ["gateway", "controlUi", "github", "token"],
        ["hooks", "token"],
        ["hooks", "gmail", "pushToken"],
      ].map((path): [SettingPath, unknown] => [path, get(values, path)]),
      ...["identityData", "certificateData", "knownHostsData"].flatMap(
        (field): [SettingPath, unknown][] => [
          [
            ["agents", "defaults", "sandbox", "ssh", field],
            get(values, ["agents", "defaults", "sandbox", "ssh", field]),
          ],
          ...keyed(["agents", "entries"], ["sandbox", "ssh", field]),
        ],
      ),
      ...keyed(["storage", "locations"], ["encryption", "passphrase"]),
    ];
    for (const [path, value] of sensitiveSlots) {
      validateReference(value, pointer(...path), false, credentialKeyMessage);
    }
    // Channel and plugin settings have no schema OCC can read, so their keys are matched as
    // OpenClaw matches plugin-owned fields (`isSensitiveConfigPath`), with the fields bundled
    // manifests mark sensitive that the rule misses (`SENSITIVE_MANIFEST_SETTINGS`).
    for (const [channel, settings] of Object.entries(asRecord(values.channels) ?? {})) {
      refuseSensitiveSettings(["channels", channel], settings, `channels/${channel}`);
    }
    for (const [plugin, settings] of Object.entries(plugins ?? {})) {
      refuseSensitiveSettings(
        ["plugins", "entries", plugin, "config"],
        asRecord(settings)?.config,
        `plugins/${plugin}`,
      );
    }
    // Every other environment map OpenClaw starts a process with (findings 1260, 1261): a
    // skill's, an internal hook's, a provider's local service, an exec secret provider's, the
    // Docker sandbox's (default and per Agent) and the install policy's exec check.
    const keyedEnvironments = (path: readonly string[], each: readonly string[]) => {
      for (const [key, settings] of children(path)) {
        const environment = at(settings, each);
        if (environment !== undefined) {
          environments.push([[...path, key, ...each], environment]);
        }
      }
    };
    keyedEnvironments(["skills", "entries"], ["env"]);
    keyedEnvironments(["hooks", "internal", "entries"], ["env"]);
    keyedEnvironments(["models", "providers"], ["localService", "env"]);
    keyedEnvironments(["secrets", "providers"], ["env"]);
    keyedEnvironments(["agents", "entries"], ["sandbox", "docker", "env"]);
    for (const path of [
      ["agents", "defaults", "sandbox", "docker", "env"],
      ["security", "installPolicy", "exec", "env"],
    ]) {
      environments.push([path, at(values, path)]);
    }
    // A `GIT_CONFIG_VALUE_<n>` whose `GIT_CONFIG_KEY_<n>` names a proxy is a proxy too, read
    // without a scheme as http: git and curl send its userinfo as Proxy-Authorization (finding
    // 1276). Keys pair across the maps OpenClaw merges into one environment: `env`, `env.vars` and
    // every skill's (the Gateway's process), and the Docker sandbox defaults' with each Agent's.
    // On a Preset save, a key or name that waits on a variable is matched as the text around it
    // (`namesGitProxy`), and a name that waits on one pairs with every index; so does a key's
    // `${VAR}` reference, which may render any text.
    const merged = (prefix: SettingPath): "process" | "defaults" | "agent" | undefined =>
      prefix[0] === "env" || prefix[0] === "skills"
        ? "process"
        : prefix[0] === "agents" && prefix.includes("docker")
          ? prefix[1] === "defaults"
            ? "defaults"
            : "agent"
          : undefined;
    const slots = environments.map(([prefix, settings]) =>
      Object.entries(settings ?? {}).map(([name, value]) => {
        const literal = options.unresolved?.([...prefix, name], true)?.join("");
        const proxy = [name, literal].some(
          (text) => text !== undefined && PROXY_ENVIRONMENT.test(text.trim()),
        );
        // OpenClaw trims a variable's name. A name that waits on a variable has no known index,
        // and no known kind unless the text around it names one.
        const [, kind = "", index] = GIT_CONFIG_SLOT.exec(name.trim()) ?? [];
        const text = literal?.trim().toUpperCase();
        const unknown = text?.startsWith("GIT_CONFIG") === true;
        const key = kind.toUpperCase() === "KEY" || (unknown && !text.includes("VALUE"));
        return {
          name,
          value,
          proxy,
          index: literal === undefined ? index : undefined,
          key,
          gitValue: kind.toUpperCase() === "VALUE" || (unknown && !text.includes("KEY")),
          parameters: literal === undefined && /^GIT_CONFIG_PARAMETERS$/i.test(name.trim()),
        };
      }),
    );
    // The indices of each map's keys that name a proxy (`undefined` for any index).
    const proxyKeys = environments.map(([prefix], position) => {
      const keys = new Set<string | undefined>();
      for (const { name, value, index, key } of slots[position] ?? []) {
        if (!key || typeof value !== "string") {
          continue;
        }
        const text = (options.unresolved?.([...prefix, name]) ?? [value])
          .join("\0")
          .replaceAll(environmentReference, (reference: string, escaped?: string) =>
            escaped === undefined ? "\0" : reference.slice(1),
          );
        if (namesGitProxy(text)) {
          keys.add(index);
        }
      }
      return keys;
    });
    const union = (...groups: string[]) =>
      new Set(
        environments.flatMap(([prefix], position) =>
          groups.includes(merged(prefix) ?? "") ? [...(proxyKeys[position] ?? [])] : [],
        ),
      );
    const gateway = union("process");
    const defaults = union("defaults");
    const sandbox = union("defaults", "agent");
    for (const [position, [prefix]] of environments.entries()) {
      const own = proxyKeys[position] ?? new Set();
      const group = merged(prefix);
      const paired =
        group === "process"
          ? [gateway]
          : group === "defaults"
            ? [sandbox]
            : group === "agent"
              ? [defaults, own]
              : [own];
      for (const { name, value, proxy, index, gitValue, parameters } of slots[position] ?? []) {
        const path = [...prefix, name];
        refuseEnvironmentUserinfo(
          path,
          value,
          proxy ||
            (gitValue &&
              paired.some(
                (keys) =>
                  keys.has(undefined) || (index === undefined ? keys.size > 0 : keys.has(index)),
              )),
        );
        // `git -c` pairs: each value whose key names a proxy.
        if (parameters && typeof value === "string") {
          const text = (options.unresolved?.(path) ?? [value]).join("\0");
          for (const [key, setting] of gitConfigParameters(text)) {
            if (namesGitProxy(key.replaceAll(environmentReference, "\0"))) {
              refuseProxyUserinfo(path, value, setting);
            }
          }
        }
      }
    }
  }
  for (const [prefix, settings] of [
    [["env"], env],
    [["env", "vars"], asRecord(env?.vars)],
  ] as const) {
    for (const [name, value] of Object.entries(settings ?? {})) {
      if (
        [
          "OPENAI_API_KEY",
          "ANTHROPIC_API_KEY",
          "ANTHROPIC_AUTH_TOKEN",
          "CODEX_ACCESS_TOKEN",
        ].includes(name)
      ) {
        validateReference(value, pointer(...prefix, name));
      }
    }
  }
}
