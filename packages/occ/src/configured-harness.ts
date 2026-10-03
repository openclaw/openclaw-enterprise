import type { OpenClawConfigurationDocument } from "@openclaw-enterprise/contracts";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";

import { ConfigurationHarnessError } from "./errors.ts";

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
        "The configured Agent model must identify its provider and model.",
      );
    }
    return selected;
  });
  if (models.some((selected) => selected.split("/", 2)[0] !== models[0]!.split("/", 2)[0])) {
    throw new ConfigurationHarnessError(
      "Configured model fallbacks must retain the primary provider.",
    );
  }
  return models;
}

function matchingSelectableModels(
  value: Readonly<Record<string, unknown>> | undefined,
  selectedModel: string | undefined,
): boolean {
  if (value === undefined || selectedModel === undefined) {
    return false;
  }
  const selectedRuntime = configuredRuntime(value[selectedModel]);
  return Object.entries(value).every(
    ([model, policy]) =>
      model === selectedModel ||
      (selectedRuntime !== undefined &&
        model.split("/", 2)[0] === selectedModel.split("/", 2)[0] &&
        configuredRuntime(policy) === selectedRuntime),
  );
}

function providerModelEntry(
  provider: Readonly<Record<string, unknown>>,
  model: string,
): Readonly<Record<string, unknown>> | undefined {
  const configured = provider.models;
  if (configured === undefined) {
    return undefined;
  }
  if (!Array.isArray(configured)) {
    throw new ConfigurationHarnessError("Configured provider models must be a native model array.");
  }
  const matches = configured.filter((candidate) => {
    const value = asRecord(candidate);
    return value?.id === model || value?.id === model.slice(model.indexOf("/") + 1);
  });
  if (matches.length > 1) {
    throw new ConfigurationHarnessError("The selected provider model Harness policy is ambiguous.");
  }
  return asRecord(matches[0]);
}

/** Resolve native model policy without treating ignored whole-agent runtime pins as authoritative. */
export function resolveConfiguredHarnessId(
  values: Readonly<OpenClawConfigurationDocument>,
): string {
  const agents = asRecord(values.agents);
  const defaults = asRecord(agents?.defaults);
  const entries = asRecord(agents?.entries);
  if (agents?.list !== undefined && (!Array.isArray(agents.list) || agents.list.length > 0)) {
    throw new ConfigurationHarnessError("Configured Agent lists are unsupported.");
  }
  const providerConfigurations = asRecord(asRecord(values.models)?.providers);
  const defaultSelection = configuredModels(defaults?.model);
  const defaultModels = asRecord(defaults?.models);
  const candidates: Array<{ model: string; entry?: Readonly<Record<string, unknown>> }> =
    defaultSelection.map((model) => ({ model }));

  for (const value of Object.values(entries ?? {})) {
    const entry = asRecord(value);
    if (entry === undefined) {
      throw new ConfigurationHarnessError("The configured Agent runtime entry is invalid.");
    }
    const selection = entry.model === undefined ? defaultSelection : configuredModels(entry.model);
    const model = selection[0];
    if (model === undefined) {
      throw new ConfigurationHarnessError("The configured Agent runtime model cannot be resolved.");
    }
    if (candidates[0] !== undefined && model !== candidates[0].model) {
      throw new ConfigurationHarnessError("Configured Agent entries must match the primary model.");
    }
    const models = asRecord(entry.models);
    if (entry.models !== undefined && !matchingSelectableModels(models, model)) {
      throw new ConfigurationHarnessError(
        "Configured selectable models must match the primary model.",
      );
    }
    candidates.push(...selection.map((model) => ({ model, entry })));
  }

  if (
    defaults?.models !== undefined &&
    !matchingSelectableModels(defaultModels, candidates[0]?.model)
  ) {
    throw new ConfigurationHarnessError(
      "Configured selectable models must match the primary model.",
    );
  }

  for (const [providerId, value] of Object.entries(providerConfigurations ?? {})) {
    const provider = asRecord(value);
    if (provider === undefined) {
      throw new ConfigurationHarnessError("The configured Agent model provider is invalid.");
    }
    if (provider.models === undefined) {
      continue;
    }
    if (!Array.isArray(provider.models)) {
      throw new ConfigurationHarnessError(
        "Configured provider models must be a native model array.",
      );
    }
    if (
      provider.models.some((value) => {
        const model = asRecord(value)?.id;
        return !candidates.some(
          (candidate) =>
            candidate.model.split("/", 2)[0] === providerId &&
            (model === candidate.model ||
              model === candidate.model.slice(candidate.model.indexOf("/") + 1)),
        );
      })
    ) {
      throw new ConfigurationHarnessError(
        "Configured selectable provider models must match the primary model.",
      );
    }
  }

  if (candidates.length === 0) {
    return "openclaw";
  }
  const resolved = new Set<string>();
  const plugins = asRecord(asRecord(values.plugins)?.entries);

  for (const candidate of candidates) {
    const providerId = candidate.model.split("/", 2)[0]!;
    const provider = asRecord(providerConfigurations?.[providerId]);
    const providerModel =
      provider === undefined ? undefined : providerModelEntry(provider, candidate.model);
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
