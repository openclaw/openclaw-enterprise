import type { OpenClawConfigurationDocument } from "@openclaw-enterprise/contracts";
import { asRecord, isNonEmptyString, splitModelRef } from "@openclaw-enterprise/utils";

import { agentEntryMessage, ConfigurationHarnessError, modelProviderMessage } from "./errors.ts";

function configuredRuntime(value: unknown): string | undefined {
  const runtimeValue = asRecord(value)?.agentRuntime;
  if (runtimeValue === undefined) {
    return undefined;
  }
  const runtime = asRecord(runtimeValue);
  if (runtime === undefined || (runtime.id !== "openclaw" && runtime.id !== "codex")) {
    throw new ConfigurationHarnessError(
      "The configured model Harness runtime identity is unsupported.",
    );
  }
  return runtime.id;
}

function configuredModels(value: unknown): readonly string[] {
  if (value === undefined) {
    return [];
  }
  const configured = asRecord(value);
  const fallbacks = configured?.fallbacks;
  if (fallbacks !== undefined && !Array.isArray(fallbacks)) {
    throw new ConfigurationHarnessError("Configured Agent model fallbacks must be an array.");
  }
  const model = typeof value === "string" ? value : configured?.primary;
  const models = [model, ...(fallbacks ?? [])].map((selected) => {
    if (
      !isNonEmptyString(selected) ||
      !selected.includes("/") ||
      selected.startsWith("/") ||
      selected.endsWith("/")
    ) {
      throw new ConfigurationHarnessError(
        "The configured Agent model must identify its provider and model as <provider>/<model>, such as openai/gpt-5.1 or codex/gpt-5.1.",
      );
    }
    return selected;
  });
  const primaryProvider = splitModelRef(models[0]!).provider;
  if (models.some((selected) => splitModelRef(selected).provider !== primaryProvider)) {
    throw new ConfigurationHarnessError(
      "Configured model fallbacks must retain the primary provider.",
    );
  }
  return models;
}

// The rule matchingSelectableModels enforces, for messages that name agents.*.models.
const selectableRule =
  "must be an object keyed by model ref: a model other than the primary needs the primary's provider and the same agentRuntime, set on both.";

function matchingSelectableModels(
  value: Readonly<Record<string, unknown>> | undefined,
  selectedModel: string | undefined,
): boolean {
  if (value === undefined || selectedModel === undefined) {
    return false;
  }
  const selectedRuntime = configuredRuntime(value[selectedModel]);
  const selectedProvider = splitModelRef(selectedModel).provider;
  return Object.entries(value).every(
    ([model, policy]) =>
      model === selectedModel ||
      (selectedRuntime !== undefined &&
        splitModelRef(model).provider === selectedProvider &&
        configuredRuntime(policy) === selectedRuntime),
  );
}

// A provider catalog ID is the complete model ref or the remainder after the provider.
function isCatalogModelId(id: unknown, reference: string): boolean {
  return id === reference || id === splitModelRef(reference).id;
}

const providerModelsArrayMessage = (path: string): string =>
  `Configuration setting ${path}.models must be an array of model entries.`;

function providerModelEntry(
  providerId: string,
  provider: Readonly<Record<string, unknown>>,
  model: string,
): Readonly<Record<string, unknown>> | undefined {
  const configured = provider.models;
  if (configured === undefined) {
    return undefined;
  }
  if (!Array.isArray(configured)) {
    throw new ConfigurationHarnessError(
      modelProviderMessage(providerId, providerModelsArrayMessage),
    );
  }
  const matches = configured.filter((candidate) =>
    isCatalogModelId(asRecord(candidate)?.id, model),
  );
  if (matches.length > 1) {
    throw new ConfigurationHarnessError(
      modelProviderMessage(
        providerId,
        (path) =>
          `Configuration setting ${path}.models lists the selected model more than once: keep one entry.`,
      ),
    );
  }
  return asRecord(matches[0]);
}

/** Resolve native model policy without treating ignored whole-agent runtime pins as authoritative. */
export function resolveConfiguredHarnessId(
  values: Readonly<OpenClawConfigurationDocument>,
): string {
  // Shape refusals come first: a non-object agents, agents.defaults or agents.entries would
  // otherwise read as absent and surface as an unrelated model-policy refusal below.
  const agents = asRecord(values.agents);
  if (values.agents !== undefined && agents === undefined) {
    throw new ConfigurationHarnessError("Configuration setting agents must be an object.");
  }
  const defaults = asRecord(agents?.defaults);
  if (agents?.defaults !== undefined && defaults === undefined) {
    throw new ConfigurationHarnessError("Configuration setting agents.defaults must be an object.");
  }
  const entries = asRecord(agents?.entries);
  if (agents?.entries !== undefined && entries === undefined) {
    throw new ConfigurationHarnessError(
      "Configuration setting agents.entries must be an object keyed by Agent ID.",
    );
  }
  if (agents?.list !== undefined && (!Array.isArray(agents.list) || agents.list.length > 0)) {
    throw new ConfigurationHarnessError(
      "Configuration setting agents.list is unsupported: remove it and configure each Agent under agents.entries, keyed by its Agent ID.",
    );
  }
  const providerConfigurations = asRecord(asRecord(values.models)?.providers);
  const defaultSelection = configuredModels(defaults?.model);
  const defaultModels = asRecord(defaults?.models);
  const candidates: Array<{ model: string; entry?: Readonly<Record<string, unknown>> }> =
    defaultSelection.map((model) => ({ model }));

  for (const [key, value] of Object.entries(entries ?? {})) {
    const entry = asRecord(value);
    if (entry === undefined) {
      throw new ConfigurationHarnessError(
        agentEntryMessage(key, (path) => `Configuration setting ${path} must be an object.`),
      );
    }
    const selection = entry.model === undefined ? defaultSelection : configuredModels(entry.model);
    const model = selection[0];
    if (model === undefined) {
      throw new ConfigurationHarnessError(
        agentEntryMessage(
          key,
          (path) =>
            `Configuration setting ${path}.model is required when agents.defaults.model is unset: set either one.`,
        ),
      );
    }
    if (candidates[0] !== undefined && model !== candidates[0].model) {
      throw new ConfigurationHarnessError(
        agentEntryMessage(
          key,
          (path) =>
            `Configuration setting ${path}.model must select the same primary model as agents.defaults.model and the other agents.entries.`,
        ),
      );
    }
    const models = asRecord(entry.models);
    if (entry.models !== undefined && !matchingSelectableModels(models, model)) {
      throw new ConfigurationHarnessError(
        agentEntryMessage(key, (path) => `Configuration setting ${path}.models ${selectableRule}`),
      );
    }
    candidates.push(...selection.map((model) => ({ model, entry })));
  }

  if (
    defaults?.models !== undefined &&
    !matchingSelectableModels(defaultModels, candidates[0]?.model)
  ) {
    throw new ConfigurationHarnessError(
      candidates[0] === undefined
        ? "Configuration setting agents.defaults.models needs a primary model: set agents.defaults.model or an agents.entries model."
        : `Configuration setting agents.defaults.models ${selectableRule}`,
    );
  }

  for (const [providerId, value] of Object.entries(providerConfigurations ?? {})) {
    const provider = asRecord(value);
    if (provider === undefined) {
      throw new ConfigurationHarnessError(
        modelProviderMessage(
          providerId,
          (path) => `Configuration setting ${path} must be an object.`,
        ),
      );
    }
    if (provider.models === undefined) {
      continue;
    }
    if (!Array.isArray(provider.models)) {
      throw new ConfigurationHarnessError(
        modelProviderMessage(providerId, providerModelsArrayMessage),
      );
    }
    if (
      provider.models.some((value) => {
        const id = asRecord(value)?.id;
        return !candidates.some(
          (candidate) =>
            splitModelRef(candidate.model).provider === providerId &&
            isCatalogModelId(id, candidate.model),
        );
      })
    ) {
      throw new ConfigurationHarnessError(
        modelProviderMessage(
          providerId,
          (path) =>
            `Configuration setting ${path}.models may list only entries whose id names a primary or fallback model set in agents.defaults.model or agents.entries.`,
        ),
      );
    }
  }

  if (candidates.length === 0) {
    return "openclaw";
  }
  const resolved = new Set<string>();
  const plugins = asRecord(asRecord(values.plugins)?.entries);

  for (const candidate of candidates) {
    const providerId = splitModelRef(candidate.model).provider;
    const provider = asRecord(providerConfigurations?.[providerId]);
    const providerModel =
      provider === undefined
        ? undefined
        : providerModelEntry(providerId, provider, candidate.model);
    const entryModels = asRecord(candidate.entry?.models);
    const policies = new Set(
      [entryModels?.[candidate.model], defaultModels?.[candidate.model], providerModel, provider]
        .map(configuredRuntime)
        .filter((runtime): runtime is string => runtime !== undefined),
    );
    if (policies.size > 1) {
      throw new ConfigurationHarnessError(
        "The selected model has conflicting Harness runtime policies.",
      );
    }
    const selected = [...policies][0];
    if (
      selected === undefined &&
      (providerId === "openai" ||
        providerId === "codex" ||
        provider !== undefined ||
        plugins?.[providerId] !== undefined)
    ) {
      throw new ConfigurationHarnessError(
        "The configured Agent model requires an explicit supported Harness runtime.",
      );
    }
    const codexPlugin = asRecord(plugins?.codex);
    const codexPluginConfiguration = asRecord(codexPlugin?.config);
    const codexAppServer = asRecord(codexPluginConfiguration?.appServer);
    if (
      selected === "codex" &&
      providerId !== "codex" &&
      !(
        providerId === "openai" &&
        codexPlugin?.enabled === true &&
        codexAppServer?.transport === "websocket"
      )
    ) {
      throw new ConfigurationHarnessError(
        "The Codex Harness requires the native codex model provider.",
      );
    }
    resolved.add(selected ?? "openclaw");
  }

  if (resolved.size !== 1) {
    throw new ConfigurationHarnessError(
      "The configured Agent models select conflicting Harness runtimes.",
    );
  }
  return [...resolved][0]!;
}
