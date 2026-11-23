import {
  ConnectionTemplateValidationError,
  isApprovedDestinationHost,
  type ConnectionTemplateSettings,
} from "./connection-templates.ts";

export type InferenceProtocol = "openai-responses" | "openai-completions";

const modelSourcePresetIds = ["openai"] as const;
// "github" holds a repository token: a permitted use, but never a model credential.
const sourceProviderPresetIds = [...modelSourcePresetIds, "github"] as const;

/** An approved provider preset that OCC can associate with a credential source. */
export type SourceProviderPresetId = (typeof sourceProviderPresetIds)[number];

/** A preset whose Source may authenticate a model provider. */
export type ModelSourcePresetId = (typeof modelSourcePresetIds)[number];

export const SOURCE_PROVIDER_PRESET_CONFIG_KEY = "provider_preset";

export function isSourceProviderPresetId(value: unknown): value is SourceProviderPresetId {
  return typeof value === "string" && sourceProviderPresetIds.some((id) => id === value);
}

export function isModelSourcePresetId(value: unknown): value is ModelSourcePresetId {
  return typeof value === "string" && modelSourcePresetIds.some((id) => id === value);
}

export interface ModelProviderModel {
  readonly id: string;
  readonly name?: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly cost?: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  };
}

export interface ModelProviderSettings {
  readonly displayName: string;
  readonly baseUrl: string;
  readonly protocol: InferenceProtocol;
  readonly models: readonly ModelProviderModel[];
  readonly defaultModelId?: string;
  readonly connectionTemplateId: string;
}

export interface ModelProvider extends ModelProviderSettings {
  readonly id: string;
}

/** The API includes a fingerprint of the saved settings for conditional replacement. */
export interface ModelProviderView extends ModelProvider {
  readonly settingsFingerprint: string;
}

export function normalizeInferenceBaseUrl(value: string): string {
  // Reject URL parser rewrites before interpreting a credential destination.
  if (
    !/^https:\/\/[A-Za-z0-9.-]+(?::[1-9][0-9]{0,4})?(?:\/[A-Za-z0-9._~-]+)*\/v1\/?$/.test(value) ||
    value.split("/").some((segment) => segment === "." || segment === "..") ||
    !URL.canParse(value)
  ) {
    throw new ConnectionTemplateValidationError(
      "baseUrl",
      "Choose an exact HTTPS inference base URL ending in /v1.",
    );
  }
  const url = new URL(value);
  const originalHost = value.slice("https://".length).split(/[/:]/, 1)[0]?.toLowerCase();
  if (originalHost !== url.hostname || !isApprovedDestinationHost(url.hostname)) {
    throw new ConnectionTemplateValidationError(
      "baseUrl",
      "Choose an exact DNS host or private IPv4 address for inference.",
    );
  }
  return url.href.replace(/\/$/, "");
}

export function inferenceKeyDestination(baseUrl: string, protocol: InferenceProtocol) {
  const url = new URL(normalizeInferenceBaseUrl(baseUrl));
  if (protocol !== "openai-responses" && protocol !== "openai-completions") {
    throw new ConnectionTemplateValidationError(
      "protocol",
      "Choose a supported inference protocol.",
    );
  }
  return {
    method: "POST" as const,
    host: url.hostname,
    port: Number(url.port || 443),
    path: url.pathname + (protocol === "openai-responses" ? "/responses" : "/chat/completions"),
  };
}

/** A provider can use a static credential only for a request its template approves. */
export function modelProviderRequestApproved(
  provider: Pick<ModelProviderSettings, "baseUrl" | "protocol">,
  template: Readonly<ConnectionTemplateSettings>,
): boolean {
  if (template.mode !== "static_bearer") {
    return false;
  }
  const request = inferenceKeyDestination(provider.baseUrl, provider.protocol);
  return template.destinations.some((destination) => {
    if (
      destination.host !== request.host ||
      destination.port !== request.port ||
      destination.method !== request.method
    ) {
      return false;
    }
    if (!destination.path.endsWith("/**")) {
      return destination.path === request.path;
    }
    const prefix = destination.path.slice(0, -3);
    return request.path === prefix || request.path.startsWith(prefix + "/");
  });
}
