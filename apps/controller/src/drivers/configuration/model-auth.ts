import type { OpenClawConfigurationDocument } from "@openclaw-enterprise/contracts";
import { isCredentialHeaderName, ModelCredentialValueError } from "@openclaw-enterprise/occ";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";

export class ConfigurationValidationError extends Error {}

const pointer = (...segments: readonly string[]): string =>
  segments.map((segment) => `/${segment.replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");

/** Known native model credential slots must store unresolved references, never values. */
export function validateModelCredentialReferences(values: OpenClawConfigurationDocument): void {
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
