import type { OpenClawConfigurationDocument } from "@openclaw-enterprise/contracts";
import { asRecord } from "@openclaw-enterprise/utils";

import {
  ConfigurationHarnessError,
  configurationSettingMessage,
  keyedSettingPath,
  ModelProviderSettingError,
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
 * a list (`providerModelsListError`); other provider settings stay the runtime's to validate.
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
    if (models === undefined) {
      continue;
    }
    if (!Array.isArray(models)) {
      throw providerModelsListError(providerName);
    }
    for (const [index, model] of models.entries()) {
      const modelSettings = asRecord(model);
      if (modelSettings !== undefined) {
        validateSettings(modelSettings, [...path, "models", index], false);
      }
    }
  }
}

// RFC 9110 field-name token. A name outside it (whitespace, zero-width or non-ASCII
// lookalikes) is not a header any HTTP client sends, so it is refused rather than matched.
const HTTP_FIELD_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Whether `name` is a valid HTTP field name (an RFC 9110 token). */
export function isHttpFieldName(name: string): boolean {
  return HTTP_FIELD_NAME.test(name);
}

// A header whose last hyphen- or underscore-separated word names a credential: Authorization,
// Proxy-Authorization, x-auth-token, cookie, x-client-secret, x-credentials, x-passphrase,
// x-signature, x-bearer and the like, singular or plural. Vendors and gateways each pick their
// own credential header, so a fixed list would miss the next one; matching the last word keeps
// names such as x-token-id or x-auth-mode, which carry no credential, out. A trailing number
// word, as in x-hub-signature-256, is skipped.
const CREDENTIAL_HEADER_WORD =
  /(?:^|[-_])(?:auth|authorization|bearer|cookies?|credentials?|passcode|passphrase|passwords?|secrets?|signatures?|tokens?)(?:[-_]\d+)?$/i;
// Any name ending in `key` or `keys` is a credential too (x-api-key, apikey, x-auth-key,
// dd-application-key, x-portkey-virtual-key, a bare key): vendors name keys too freely to
// list. A key's id or name (x-api-key-id) ends in another word.
const CREDENTIAL_HEADER_KEY = /keys?(?:[-_]\d+)?$/i;
// Keys that name no credential: an idempotency key and a cache key.
const NON_CREDENTIAL_KEY = /(?:^|[-_])(?:cache|idempoten(?:cy|t))[-_]?keys?(?:[-_]\d+)?$/i;

/** Whether a model provider header with this name carries a credential. */
export function isCredentialHeaderName(name: string): boolean {
  return (
    CREDENTIAL_HEADER_WORD.test(name) ||
    (CREDENTIAL_HEADER_KEY.test(name) && !NON_CREDENTIAL_KEY.test(name))
  );
}
