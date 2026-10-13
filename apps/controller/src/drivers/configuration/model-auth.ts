import type {
  ConfigurationValidationOptions,
  OpenClawConfigurationDocument,
} from "@openclaw-enterprise/contracts";
import {
  environmentReference,
  isCredentialHeaderName,
  ModelCredentialValueError,
  urlHoldsUserinfo,
} from "@openclaw-enterprise/occ";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";

export class ConfigurationValidationError extends Error {}

// A setting's location, as `options.unresolved` takes it: a list index is a number.
type SettingPath = readonly (string | number)[];

const pointer = (...segments: readonly (string | number)[]): string =>
  segments
    .map((segment) => `/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`)
    .join("");

const urlCredentialMessage = (path: string): string =>
  `Configuration field ${path} carries a user name or password in the URL. Remove it, or make the whole URL a \${NAME} reference.`;

// Proxy environment variables, in any case (`HTTPS_PROXY`, `all_proxy`, `npm_config_proxy`).
// `NO_PROXY` lists hosts, not a proxy.
const PROXY_ENVIRONMENT = /^(?!no_proxy$)(?:\w*_)?proxy$/i;

const urlCostMessage = (path: string): string =>
  `Configuration field ${path}, with the URLs and environment values before it, holds too many URLs or \${NAME} references to check for a user name or password. Shorten these values, or make each whole value a \${NAME} reference.`;

// The most work `environmentUrls` and the userinfo checks may do on one document's URL fields and
// environment values, in characters read (each rendering of each URL counts): about 0.1 s for
// each check of a document.
const URL_CHECK_BUDGET = 1 << 22;

// The work `urlHoldsUserinfo` does on `literals`: it renders the text three times plus once per
// `${VAR:-fallback}` reference, and reads it whole each time (finding 1265). Each unfilled Preset
// variable between literals costs about as much as a dozen characters in every rendering.
function userinfoWork(literals: readonly string[]): number {
  const text = literals.join("\0");
  let fallbacks = 0;
  for (const [, escaped, fallback] of text.matchAll(environmentReference)) {
    fallbacks += escaped === undefined && fallback !== undefined ? 1 : 0;
  }
  return (text.length + 12 * literals.length) * (3 + fallbacks);
}

// Each URL `value` may hold, from its scheme to the end of its authority, where `\0` marks an
// unfilled Preset variable; `undefined` when checking them would exceed the budget. URL parsers
// (WHATWG's, Python's) drop tabs and newlines, and read userinfo after a special scheme with one
// slash or none (`https:u:pw@host`). A candidate is a colon with two slashes after it, or one
// after a scheme that ends in `http(s)`, `ws(s)` or `ftp` or holds a variable or `${VAR}`
// reference (each also between the colon and the slashes), with no space after it. References
// are read as the runtime reads them (`environmentReference`; `$${VAR}` is literal text). A
// candidate inside the authority of one already returned is part of it, unless it sits in a
// reference whose fallback could end that authority. A backslash does not end an authority here:
// WHATWG parsers read it as a slash after a special scheme, but Python and curl read it as part
// of the userinfo, so each URL is also checked with it percent-encoded. `spent` carries the work
// done on the document so far.
function environmentUrls(value: string, spent: { work: number }): string[] | undefined {
  const text = value.replaceAll(/[\t\n\r]/g, "");
  // Each reference, by its start and by its end; `inside` marks the start of the one at each
  // index, and `count` how many start before it.
  const after = new Map<number, number>();
  const before = new Map<number, number>();
  const inside = new Int32Array(text.length + 1).fill(-1);
  const count = new Int32Array(text.length + 2);
  for (const { index, 0: reference, 1: escaped } of text.matchAll(environmentReference)) {
    if (escaped === undefined) {
      after.set(index, index + reference.length);
      before.set(index + reference.length, index);
      inside.fill(index, index + 1, index + reference.length);
      count[index + 1] = 1;
    }
  }
  for (let index = 1; index < count.length; index += 1) {
    count[index] = (count[index] ?? 0) + (count[index - 1] ?? 0);
  }
  let work = spent.work + text.length;
  const skip = (from: number): [number, number] => {
    let index = from;
    let slashes = 0;
    for (;;) {
      const end = after.get(index);
      if (end !== undefined) {
        index = end;
      } else if (text[index] === "\0") {
        index += 1;
      } else if (text[index] === "/" || text[index] === "\\") {
        index += 1;
        slashes += 1;
      } else {
        return [index, slashes];
      }
    }
  };
  // Whether a reference's text holds a character in `ends`, read once per reference and pattern.
  const endsIn = new Map<string, boolean>();
  const holdsEnd = (reference: number, ends: RegExp): boolean => {
    const key = `${ends.source}${reference}`;
    const known = endsIn.get(key);
    if (known !== undefined) {
      return known;
    }
    const found = ends.test(text.slice(reference, after.get(reference)));
    endsIn.set(key, found);
    return found;
  };
  const spans: [number, number][] = [];
  let covered = { from: 0, to: 0, ends: /["/?#]/ };
  for (const { index: colon } of text.matchAll(/:/g)) {
    let start = colon;
    for (;;) {
      const reference = before.get(start);
      if (reference !== undefined) {
        start = reference;
      } else if (start > 0 && /[\w+.\-\0]/.test(text[start - 1] ?? "")) {
        start -= 1;
      } else {
        break;
      }
    }
    const scheme = text.slice(start, colon);
    const variable = /\0/.test(scheme) || count[colon] !== count[start];
    const special = /(?:^|[^A-Za-z0-9+.])(?:https?|wss?|ftp)$/i.test(scheme);
    const [authority, slashes] = skip(colon + 1);
    work += authority - start;
    if (slashes < 2 && (!(variable || special) || text[colon + 1] === " ")) {
      continue;
    }
    const reference = inside[colon] ?? -1;
    if (
      colon >= covered.from &&
      authority < covered.to &&
      (reference === -1 || !holdsEnd(reference, covered.ends))
    ) {
      continue;
    }
    // A double quote ends a URL inside JSON text. A `file` URL, checked only as written (it sends
    // no credentials, and Windows paths fill it with backslashes), also ends at a backslash.
    const ends = /^file$/i.test(scheme) ? /["/?#\\]/ : /["/?#]/;
    let end = authority;
    while (end < text.length) {
      const skipped = after.get(end);
      if (skipped !== undefined) {
        end = skipped;
      } else if (ends.test(text[end] ?? "")) {
        break;
      } else {
        end += 1;
      }
    }
    end = Math.min(end + 1, text.length);
    // Each of the two checks renders every fallback in the URL, so its cost grows with each
    // reference.
    work += 2 * (end - start) * (3 + (count[end] ?? 0) - (count[start] ?? 0));
    if (work > URL_CHECK_BUDGET) {
      return undefined;
    }
    covered = { from: authority, to: end - 1, ends };
    spans.push([start, end]);
  }
  spent.work = work;
  return spans.map(([start, end]) => text.slice(start, end));
}

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
 * network proxy and speech and Talk provider proxies.
 */
export function validateModelCredentialReferences(
  values: OpenClawConfigurationDocument,
  {
    stored = false,
    ...options
  }: { readonly stored?: boolean } & ConfigurationValidationOptions = {},
): void {
  const validateReference = (value: unknown, path: string, authorizationHeader = false): void => {
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
    const reference = asRecord(value);
    if (
      reference &&
      Object.keys(reference).length === 3 &&
      [reference.source, reference.provider, reference.id].every(isNonEmptyString)
    ) {
      return;
    }
    throw new ModelCredentialValueError(path);
  };
  // The work the userinfo checks have done on this document: each URL field and environment value
  // is charged before it is checked, and one past the budget is refused as too costly to check.
  const spent = { work: 0 };
  // The refusal names the field, never its value. A Preset save passes `unresolved`, the text
  // around each unfilled variable at that path.
  const refuseUrlUserinfo = (
    path: readonly (string | number)[],
    value: unknown,
    schemeless = false,
  ): void => {
    if (typeof value !== "string") {
      return;
    }
    const [head = "", ...tail] = options.unresolved?.(path) ?? [value];
    const withScheme =
      schemeless && !/^[\0- ]*[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(head)
        ? [`http://${head}`, ...tail]
        : undefined;
    spent.work += userinfoWork([head, ...tail]) + (withScheme ? userinfoWork(withScheme) : 0);
    if (spent.work > URL_CHECK_BUDGET) {
      throw new ModelCredentialValueError(pointer(...path), urlCostMessage);
    }
    if (
      urlHoldsUserinfo(value, [head, ...tail]) ||
      (withScheme !== undefined && urlHoldsUserinfo(value, withScheme))
    ) {
      throw new ModelCredentialValueError(pointer(...path), urlCredentialMessage);
    }
  };
  // Every URL an environment value holds is checked, whatever the variable's name (finding
  // 1262): pip, npm, git and Go send the userinfo in `PIP_INDEX_URL`, `npm_config_registry`,
  // `GIT_CONFIG_VALUE_0` or `GOPROXY` as Basic auth, and a list such as `GOPROXY` holds several.
  // A proxy variable is also read from its start, without a scheme as http.
  const refuseEnvironmentUserinfo = (path: SettingPath, value: unknown, proxy: boolean): void => {
    if (typeof value !== "string") {
      return;
    }
    // `\0` stands for each unfilled variable: a process environment cannot hold one. A proxy
    // without a scheme is read as http.
    const text = (options.unresolved?.(path) ?? [value]).join("\0");
    const urls = environmentUrls(
      proxy && !/^[\0- ]*[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text) ? `http://${text}` : text,
      spent,
    );
    if (urls === undefined) {
      throw new ModelCredentialValueError(pointer(...path), urlCostMessage);
    }
    if (proxy) {
      refuseUrlUserinfo(path, value, true);
    }
    for (const url of urls) {
      if (
        urlHoldsUserinfo(value, url.split("\0")) ||
        (!/^file:/i.test(url) && urlHoldsUserinfo(value, url.replaceAll("\\", "%5C").split("\0")))
      ) {
        throw new ModelCredentialValueError(pointer(...path), urlCredentialMessage);
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
      const request = asRecord(row?.request);
      for (const [headersPath, headers] of [
        [[...path, "headers"], row?.headers],
        [[...path, "request", "headers"], request?.headers],
      ] as const) {
        for (const [name, value] of Object.entries(asRecord(headers) ?? {})) {
          if (isCredentialHeaderName(name, options, headersPath)) {
            // Some gateways carry the bearer token in an Authentication header. On a Preset save,
            // the text around a name's variables is matched too, as for the credential rule.
            const literal = options.unresolved?.([...headersPath, name], true)?.join("");
            validateReference(
              value,
              pointer(...headersPath, name),
              [name, literal].some(
                (text) =>
                  text !== undefined && /auth(?:entication|orization)(?:[-_.]v?\d+)?$/i.test(text),
              ),
            );
          }
        }
      }
      // OpenClaw's request.auth credential slots: the authorization-bearer token and the
      // header mode's value.
      const auth = asRecord(request?.auth);
      validateReference(auth?.token, pointer(...path, "request", "auth", "token"));
      validateReference(auth?.value, pointer(...path, "request", "auth", "value"));
      // The client certificate, key and passphrase for the model endpoint and for its proxy.
      const proxy = asRecord(request?.proxy);
      for (const [tlsPath, tls] of [
        [[...path, "request", "tls"], asRecord(request?.tls)],
        [[...path, "request", "proxy", "tls"], asRecord(proxy?.tls)],
      ] as const) {
        for (const field of ["cert", "key", "passphrase"]) {
          validateReference(tls?.[field], pointer(...tlsPath, field));
        }
      }
      // A proxy URL with userinfo is a credential (undici sends it as Proxy-Authorization), and
      // so is a model endpoint's (fetch refuses a URL that holds one), even where a variable
      // or an environment reference fills its host or port (finding 1250).
      refuseUrlUserinfo([...path, "baseUrl"], row?.baseUrl);
      refuseUrlUserinfo([...path, "request", "proxy", "url"], proxy?.url);
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
    // TTS blocks: the Gateway's, each Agent's, Discord voice's (and its accounts'), voice-call's
    // and its numbers'. Each holds `providers` and personas that hold them too.
    const keyed = (path: readonly string[], each: readonly string[]): [SettingPath, unknown][] =>
      Object.entries(at(values, path) ?? {}).map(([key, settings]) => [
        [...path, key, ...each],
        get(settings, each),
      ]);
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
      }
    }
    // Every other environment map OpenClaw starts a process with (findings 1260, 1261): a
    // skill's, an internal hook's, a provider's local service, an exec secret provider's, the
    // Docker sandbox's (default and per Agent) and the install policy's exec check.
    const keyedEnvironments = (path: readonly string[], each: readonly string[]) => {
      for (const [key, settings] of Object.entries(at(values, path) ?? {})) {
        environments.push([[...path, key, ...each], at(settings, each)]);
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
    for (const [prefix, settings] of environments) {
      for (const [name, value] of Object.entries(settings ?? {})) {
        const literal = options.unresolved?.([...prefix, name], true)?.join("");
        refuseEnvironmentUserinfo(
          [...prefix, name],
          value,
          [name, literal].some((text) => text !== undefined && PROXY_ENVIRONMENT.test(text)),
        );
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
