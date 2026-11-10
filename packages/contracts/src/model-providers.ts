import { ConnectionTemplateValidationError } from "./connection-templates.ts";

export type InferenceProtocol = "openai-responses" | "openai-completions";

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

/** A private receiver the Installation administrator selects when creating a template version. */
export type InferencePrivatePeerInput =
  | { readonly kind: "private_ipv4"; readonly address: string }
  | { readonly kind: "kubernetes_service"; readonly namespace: string; readonly name: string };

/** Service identity and ports observed by Compute before a credential owner approves the version. */
export type InferencePrivatePeer =
  | Extract<InferencePrivatePeerInput, { kind: "private_ipv4" }>
  | (Extract<InferencePrivatePeerInput, { kind: "kubernetes_service" }> & {
      readonly uid: string;
      readonly address: string;
      readonly targetPort: number;
      readonly podSelector: Readonly<Record<string, string>>;
    });

/** The version pins where the credential owner approved sending the key. */
export interface StaticKeyGrant {
  readonly privatePeer?: InferencePrivatePeer;
  readonly connectionTemplateId: string;
  readonly connectionTemplateVersion: number;
  readonly baseUrl: string;
  readonly protocol: InferenceProtocol;
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
  if (
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      url.hostname,
    )
  ) {
    throw new ConnectionTemplateValidationError(
      "baseUrl",
      "Choose an exact DNS host for inference.",
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
