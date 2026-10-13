import type { OpenClawConfigurationDocument } from "@openclaw-enterprise/contracts";
import { isCredentialHeaderName, ModelCredentialValueError } from "@openclaw-enterprise/occ";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";

export class ConfigurationValidationError extends Error {}

const pointer = (...segments: readonly string[]): string =>
  segments.map((segment) => `/${segment.replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");

const proxyCredentialMessage = (path: string): string =>
  `Configuration field ${path} carries a user name or password in the URL. Remove it, or make the whole URL a \${NAME} reference.`;

// A proxy URL with userinfo is a credential (undici sends it as Proxy-Authorization). A whole
// ${NAME} reference or an unparsable URL is left to the runtime.
function hasUrlCredentials(value: string): boolean {
  if (!URL.canParse(value)) {
    return false;
  }
  const url = new URL(value);
  return url.username !== "" || url.password !== "";
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
 * deployment checks all slots.
 */
export function validateModelCredentialReferences(
  values: OpenClawConfigurationDocument,
  { stored = false }: { readonly stored?: boolean } = {},
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
    const rows: [readonly string[], Record<string, unknown> | undefined][] = [
      [providerPath, config],
      ...(Array.isArray(config?.models) ? config.models : []).map(
        (model, index): [readonly string[], Record<string, unknown> | undefined] => [
          [...providerPath, "models", String(index)],
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
          if (isCredentialHeaderName(name)) {
            validateReference(value, pointer(...headersPath, name), /authorization$/i.test(name));
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
      if (typeof proxy?.url === "string" && hasUrlCredentials(proxy.url)) {
        throw new ModelCredentialValueError(
          pointer(...path, "request", "proxy", "url"),
          proxyCredentialMessage,
        );
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
