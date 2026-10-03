import type { OpenClawConfigurationDocument } from "@openclaw-enterprise/contracts";
import { asRecord } from "@openclaw-enterprise/utils";

import { ModelProviderSettingError } from "./errors.ts";

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

// The runtime resolves `${VAR}` and `${VAR:-fallback}` environment references (uppercase
// names) before it validates its configuration, so a value that holds one is left to it.
const environmentReference = /\$\{[A-Z_][A-Z0-9_]*(?::-[^${}]*)?\}/;

function validateSettings(
  settings: Record<string, unknown>,
  path: readonly (string | number)[],
  provider: boolean,
) {
  const { baseUrl, api } = settings;
  // On a provider, the runtime treats a blank baseUrl as unset and uses a built-in
  // provider's default endpoint; a model's baseUrl must be a nonempty URL.
  const unsetBaseUrl = provider && typeof baseUrl === "string" && baseUrl.trim() === "";
  if (
    Object.hasOwn(settings, "baseUrl") &&
    !unsetBaseUrl &&
    !(typeof baseUrl === "string" && environmentReference.test(baseUrl))
  ) {
    const url = typeof baseUrl === "string" && URL.canParse(baseUrl) ? new URL(baseUrl) : undefined;
    if (url?.protocol !== "http:" && url?.protocol !== "https:") {
      throw new ModelProviderSettingError(pointer(...path, "baseUrl"), "baseUrl");
    }
  }
  if (
    Object.hasOwn(settings, "api") &&
    !(typeof api === "string" && environmentReference.test(api))
  ) {
    if (typeof api !== "string" || !RUNTIME_MODEL_APIS.includes(api)) {
      throw new ModelProviderSettingError(pointer(...path, "api"), "api");
    }
  }
}

/**
 * A saved model provider `baseUrl` or `api` that the runtime cannot use otherwise fails
 * only at deployment, as an unexplained startup model check failure. Configuration writes
 * check both on each provider and on each of its models; other provider settings stay
 * the runtime's to validate.
 */
export function validateModelProviderSettings(values: OpenClawConfigurationDocument): void {
  const providers = asRecord(asRecord(values.models)?.providers);
  for (const [providerName, provider] of Object.entries(providers ?? {})) {
    const settings = asRecord(provider);
    if (settings === undefined) {
      continue;
    }
    const path = ["models", "providers", providerName] as const;
    validateSettings(settings, path, true);
    const models = settings.models;
    if (!Array.isArray(models)) {
      continue;
    }
    for (const [index, model] of models.entries()) {
      const modelSettings = asRecord(model);
      if (modelSettings !== undefined) {
        validateSettings(modelSettings, [...path, "models", index], false);
      }
    }
  }
}
