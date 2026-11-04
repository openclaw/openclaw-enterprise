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
import { normalizeOpenAiBaseUrl } from "../openai-endpoint.ts";

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
  const entries =
    selections?.flatMap((selection) =>
      selection.matches.length === 1 ? selection.matches.map(({ entry }) => entry) : [],
    ) ?? [];
  for (const value of [native, ...entries]) {
    const entry = asRecord(value);
    if (
      entry?.baseUrl !== undefined &&
      (typeof entry.baseUrl !== "string" ||
        ![endpoint, DEFAULT_MODEL_BASE_URL].includes(normalizeOpenAiBaseUrl(entry.baseUrl) ?? ""))
    ) {
      throw new ConfigurationHarnessError(
        "OpenAI model baseUrl must match the Installation runtime.modelProvider.baseUrl.",
      );
    }
    if (provider !== undefined && entry?.api !== undefined && entry.api !== provider.protocol) {
      throw new ConfigurationHarnessError(
        "OpenAI model api must match the Installation runtime.modelProvider.protocol.",
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
