import type {
  ConfigurationValidationOptions,
  OpenClawConfigurationDocument,
} from "@openclaw-enterprise/contracts";
import {
  isCredentialHeaderName,
  ModelCredentialValueError,
  urlHoldsUserinfo,
} from "@openclaw-enterprise/occ";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";

export class ConfigurationValidationError extends Error {}

const pointer = (...segments: readonly (string | number)[]): string =>
  segments
    .map((segment) => `/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`)
    .join("");

const urlCredentialMessage = (path: string): string =>
  `Configuration field ${path} carries a user name or password in the URL. Remove it, or make the whole URL a \${NAME} reference.`;

// Proxy environment variables, in any case (`HTTPS_PROXY`, `all_proxy`, `npm_config_proxy`).
// `NO_PROXY` lists hosts, not a proxy.
const PROXY_ENVIRONMENT = /^(?!no_proxy$)(?:\w*_)?proxy$/i;

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
 * channel proxies, MCP server URLs and proxy environment variables.
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
    if (
      urlHoldsUserinfo(value, [head, ...tail]) ||
      (schemeless &&
        !/^[\0- ]*[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(head) &&
        urlHoldsUserinfo(value, [`http://${head}`, ...tail]))
    ) {
      throw new ModelCredentialValueError(pointer(...path), urlCredentialMessage);
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
    for (const at of [["mcp"], ["nodeHost", "mcp"]]) {
      const mcp = at.reduce<Record<string, unknown> | undefined>(
        (parent, key) => asRecord(parent?.[key]),
        values,
      );
      for (const [server, settings] of Object.entries(asRecord(mcp?.servers) ?? {})) {
        refuseUrlUserinfo([...at, "servers", server, "url"], asRecord(settings)?.url);
      }
    }
    // Proxy environment (HTTPS_PROXY, http_proxy, ALL_PROXY, ...) reaches the Gateway and every
    // process it starts. Clients such as curl and git read a value without a scheme as http. On a
    // Preset save, a name that waits on a variable is matched as the text around it
    // (`{{ vars.scheme }}_PROXY`), as for credential header names.
    for (const [prefix, settings] of [
      [["env"], env],
      [["env", "vars"], asRecord(env?.vars)],
    ] as const) {
      for (const name of Object.keys(settings ?? {})) {
        const literal = options.unresolved?.([...prefix, name], true)?.join("");
        if ([name, literal].some((text) => text !== undefined && PROXY_ENVIRONMENT.test(text))) {
          refuseUrlUserinfo([...prefix, name], settings?.[name], true);
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
