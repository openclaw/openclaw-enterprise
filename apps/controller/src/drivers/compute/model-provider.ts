import { nativeOpenAiModelSelections } from "../native-openai-catalog.ts";
import type {
  OpenClawConfigurationDocument,
  RevisionHarnessDescriptor,
} from "@openclaw-enterprise/contracts";
import {
  ConfigurationHarnessError,
  keyedSettingPath,
  StoredCredentialSourceConfigError,
} from "@openclaw-enterprise/occ";
import { asRecord } from "@openclaw-enterprise/utils";
import { normalizeOpenAiBaseUrl, openAiBaseUrlRewritesIpv4 } from "../openai-endpoint.ts";

export const MODEL_PROVIDER_REFERENCE_REQUIREMENT =
  "must not hold an environment or Secret reference: the startup model check on Kubernetes gets only the Harness credential";

// The setting under `setting` (`value`'s path) that holds a `${` or is a SecretRef, if any.
export function modelProviderReferenceSetting(value: unknown, setting: string): string | undefined {
  if (typeof value === "string") {
    return value.includes("${") ? setting : undefined;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = modelProviderReferenceSetting(item, `${setting}.${index}`);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  if (typeof record.source === "string" && typeof record.id === "string") {
    return setting;
  }
  for (const [key, item] of Object.entries(record)) {
    const found = modelProviderReferenceSetting(item, keyedSettingPath(setting, key));
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

export interface ModelProviderConfiguration {
  readonly protocol: "openai-responses" | "openai-completions";
  readonly baseUrl: string;
  readonly supportsStandaloneWebSearch?: boolean;
}

export const DEFAULT_MODEL_BASE_URL = "https://api.openai.com/v1";

/** Kubernetes owns this closed, nonsecret Harness settings contract. */
export function normalizeHarnessSettings(
  value: unknown,
): Readonly<{ modelProvider?: ModelProviderConfiguration }> {
  const settings = asRecord(value);
  if (!settings || Object.keys(settings).some((key) => key !== "modelProvider")) {
    throw new ConfigurationHarnessError("Harness settings contain unsupported fields.");
  }
  if (!Object.hasOwn(settings, "modelProvider")) {
    return {};
  }
  const provider = asRecord(settings.modelProvider);
  const baseUrl =
    typeof provider?.baseUrl === "string" ? normalizeOpenAiBaseUrl(provider.baseUrl) : undefined;
  if (
    !provider ||
    Object.keys(provider).some(
      (key) => !["protocol", "baseUrl", "supportsStandaloneWebSearch"].includes(key),
    ) ||
    (provider.protocol !== "openai-responses" && provider.protocol !== "openai-completions") ||
    typeof provider.baseUrl !== "string" ||
    (provider.supportsStandaloneWebSearch !== undefined &&
      typeof provider.supportsStandaloneWebSearch !== "boolean") ||
    baseUrl === undefined ||
    openAiBaseUrlRewritesIpv4(provider.baseUrl)
  ) {
    throw new ConfigurationHarnessError(
      "Harness modelProvider requires a supported protocol, HTTPS /v1 baseUrl, and optional boolean supportsStandaloneWebSearch.",
    );
  }
  return {
    modelProvider: {
      protocol: provider.protocol,
      baseUrl,
      supportsStandaloneWebSearch: provider.supportsStandaloneWebSearch === true,
    },
  };
}

/** Saved settings never consult Installation defaults, including after a restart. */
export function savedModelProvider(settings: unknown): ModelProviderConfiguration | undefined {
  const normalized = normalizeHarnessSettings(settings);
  const supplied = asRecord(settings)!;
  const provider = asRecord(supplied.modelProvider);
  const expected = asRecord(normalized.modelProvider);
  if (
    expected &&
    (!provider || Object.keys(expected).some((key) => provider[key] !== expected[key]))
  ) {
    throw new ConfigurationHarnessError("Saved Harness settings are not normalized.");
  }
  return normalized.modelProvider;
}

export function modelProviderBaseUrl(provider?: ModelProviderConfiguration): string {
  const endpoint = normalizeOpenAiBaseUrl(provider?.baseUrl ?? DEFAULT_MODEL_BASE_URL);
  if (endpoint === undefined) {
    throw new Error("Invalid model provider endpoint.");
  }
  return endpoint;
}

/** Authorization can refuse a destination, but cannot choose a different route. */
export function requireModelSourceDestination(
  config: Readonly<Record<string, string>>,
  provider?: ModelProviderConfiguration,
): void {
  if (config.base_url !== undefined) {
    throw new StoredCredentialSourceConfigError("base_url");
  }
  const authorized = normalizeOpenAiBaseUrl(config.authorized_base_url ?? DEFAULT_MODEL_BASE_URL);
  if (authorized === undefined || authorized !== modelProviderBaseUrl(provider)) {
    throw new StoredCredentialSourceConfigError("authorized_base_url");
  }
}

/** Translate the selected provider without allowing native settings to override its route. */
export function modelProviderConfiguration(
  configuration: OpenClawConfigurationDocument,
  harness: RevisionHarnessDescriptor,
  provider?: ModelProviderConfiguration,
): OpenClawConfigurationDocument {
  const models = asRecord(configuration.models);
  const providers = asRecord(models?.providers);
  const selections = nativeOpenAiModelSelections(configuration);
  if (harness.id === "openclaw" && selections?.[0]?.provider !== "openai") {
    return configuration;
  }
  if (
    harness.id === "codex" &&
    provider !== undefined &&
    provider.protocol !== "openai-responses"
  ) {
    throw new ConfigurationHarnessError(
      "Codex requires runtime.modelProvider.protocol to be openai-responses.",
    );
  }
  if (harness.id === "codex") {
    return configuration;
  }
  const endpoint = modelProviderBaseUrl(provider);
  const native = asRecord(providers?.openai);
  const probeProvider = { ...native };
  delete probeProvider.apiKey;
  const reference = modelProviderReferenceSetting(probeProvider, "models.providers.openai");
  if (reference !== undefined) {
    throw new ConfigurationHarnessError(
      `Configuration setting ${reference} ${MODEL_PROVIDER_REFERENCE_REQUIREMENT}.`,
    );
  }
  // Embedded OpenClaw retains the whole catalogue, including subagent/model-switch rows.
  // Dedicated native rendering emits only the selected rows.
  let entries: readonly unknown[];
  if (harness.mode === "embedded") {
    entries = Array.isArray(native?.models) ? native.models : [];
  } else {
    entries =
      selections?.flatMap((selection) =>
        selection.matches.length === 1 ? selection.matches.map(({ entry }) => entry) : [],
      ) ?? [];
  }
  for (const value of [native, ...entries]) {
    const entry = asRecord(value);
    if (
      entry?.baseUrl !== undefined &&
      (typeof entry.baseUrl !== "string" ||
        ![endpoint, DEFAULT_MODEL_BASE_URL].includes(normalizeOpenAiBaseUrl(entry.baseUrl) ?? ""))
    ) {
      throw new ConfigurationHarnessError(
        "OpenAI model baseUrl must match the resolved Harness modelProvider.baseUrl.",
      );
    }
    if (provider !== undefined && entry?.api !== undefined && entry.api !== provider.protocol) {
      throw new ConfigurationHarnessError(
        "OpenAI model api must match the resolved Harness modelProvider.protocol.",
      );
    }
  }
  if (harness.id !== "openclaw" || provider === undefined) {
    return configuration;
  }
  return {
    ...configuration,
    models: {
      ...models,
      providers: {
        ...providers,
        openai: {
          ...native,
          api: provider.protocol,
          baseUrl: endpoint,
          ...(Array.isArray(native?.models)
            ? {
                models: native.models.map((value) => {
                  const entry = asRecord(value);
                  return typeof entry?.baseUrl === "string" &&
                    normalizeOpenAiBaseUrl(entry.baseUrl) === DEFAULT_MODEL_BASE_URL
                    ? { ...entry, baseUrl: endpoint }
                    : value;
                }),
              }
            : {}),
        },
      },
    },
  } as OpenClawConfigurationDocument;
}
