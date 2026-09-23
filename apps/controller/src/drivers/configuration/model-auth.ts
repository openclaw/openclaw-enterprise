import type { OpenClawConfigurationDocument } from "@openclaw-enterprise/contracts";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";

export class ConfigurationValidationError extends Error {}

/** Known native model credential slots must store unresolved references, never values. */
export function validateModelCredentialReferences(values: OpenClawConfigurationDocument): void {
  const validateReference = (value: unknown, authorizationHeader = false): void => {
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
    throw new ConfigurationValidationError(
      "Model credentials must use unresolved references; supply credential values through Harness authentication sources.",
    );
  };

  const providers = asRecord(asRecord(values.models)?.providers);
  for (const provider of Object.values(providers ?? {})) {
    const config = asRecord(provider);
    validateReference(config?.apiKey);
    for (const [name, value] of Object.entries(asRecord(config?.headers) ?? {})) {
      if (/^(?:authorization|api-key|x-api-key)$/i.test(name)) {
        validateReference(value, name.toLowerCase() === "authorization");
      }
    }
  }
  const env = asRecord(values.env);
  for (const settings of [env, asRecord(env?.vars)]) {
    for (const [name, value] of Object.entries(settings ?? {})) {
      if (
        [
          "OPENAI_API_KEY",
          "ANTHROPIC_API_KEY",
          "ANTHROPIC_AUTH_TOKEN",
          "CODEX_ACCESS_TOKEN",
        ].includes(name)
      ) {
        validateReference(value);
      }
    }
  }
}
