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
 * waits on a variable is found as on Kubernetes Compute (`isCredentialHeaderName`).
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
      for (const [urlPath, url] of [
        [[...path, "baseUrl"], row?.baseUrl],
        [[...path, "request", "proxy", "url"], proxy?.url],
      ] as const) {
        // A proxy URL with userinfo is a credential (undici sends it as Proxy-Authorization), and
        // so is a model endpoint's (fetch refuses a URL that holds one), even where a variable
        // or an environment reference fills its host or port (finding 1250).
        if (typeof url === "string" && urlHoldsUserinfo(url, options.unresolved?.(urlPath))) {
          throw new ModelCredentialValueError(pointer(...urlPath), urlCredentialMessage);
        }
      }
    }
  }
  const env = asRecord(values.env);
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
