import type {
  ConfigurationValidationOptions,
  OpenClawConfigurationDocument,
} from "@openclaw-enterprise/contracts";
import { asRecord, isNonEmptyString, splitModelRef } from "@openclaw-enterprise/utils";

import { agentEntryMessage, ConfigurationHarnessError, modelProviderMessage } from "./errors.ts";
import { providerModelsListError } from "./model-provider-settings.ts";

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

// Builds a refusal that names a model selection: agents.defaults.model or an agents.entries model.
type SelectionMessage = (rest: string) => string;

const defaultModelMessage: SelectionMessage = (rest) =>
  `Configuration setting agents.defaults.model${rest}`;

const entryModelMessage =
  (key: string): SelectionMessage =>
  (rest) =>
    agentEntryMessage(key, (path) => `Configuration setting ${path}.model${rest}`);

function isModelReference(selected: unknown): selected is string {
  return (
    isNonEmptyString(selected) &&
    selected.includes("/") &&
    !selected.startsWith("/") &&
    !selected.endsWith("/")
  );
}

// A fallback keeps the primary model's provider. Named, never echoed (finding 1298).
function requirePrimaryProvider(models: readonly string[], setting: SelectionMessage): void {
  const primaryProvider = splitModelRef(models[0]!).provider;
  if (models.some((selected) => splitModelRef(selected).provider !== primaryProvider)) {
    throw new ConfigurationHarnessError(
      setting(".fallbacks must use the primary model's provider."),
    );
  }
}

/**
 * The fallback rule of resolveConfiguredHarnessId alone, over every well-formed selection. Every
 * deployment refuses a fallback on another provider, so Configuration save (through
 * requireDeployableRoster), Preset save and Agent save refuse it too, even where another model
 * policy rule leaves the rest to deployment (finding 1298). On a Preset save
 * (`options.unresolved`), a reference whose provider waits on an unfilled variable (no `/` before
 * the first one) is checked once filled, on the Configuration a launch creates (finding 1305).
 */
export function requireFallbackProviders(
  values: Readonly<OpenClawConfigurationDocument>,
  { unresolved }: ConfigurationValidationOptions = {},
): void {
  const agents = asRecord(values.agents);
  const selections: [unknown, readonly string[], SelectionMessage][] = [
    [asRecord(agents?.defaults)?.model, ["agents", "defaults", "model"], defaultModelMessage],
    ...Object.entries(asRecord(agents?.entries) ?? {}).map(
      ([key, entry]): [unknown, readonly string[], SelectionMessage] => [
        asRecord(entry)?.model,
        ["agents", "entries", key, "model"],
        entryModelMessage(key),
      ],
    ),
  ];
  const writtenProvider = (
    selected: unknown,
    path: readonly (string | number)[],
  ): selected is string => {
    const literals = unresolved?.(path);
    return isModelReference(selected) && (literals === undefined || literals[0]!.includes("/"));
  };
  for (const [value, at, setting] of selections) {
    const selection = asRecord(value);
    if (
      writtenProvider(selection?.primary, [...at, "primary"]) &&
      Array.isArray(selection.fallbacks)
    ) {
      requirePrimaryProvider(
        [
          selection.primary,
          ...selection.fallbacks.filter((selected: unknown, index: number): selected is string =>
            writtenProvider(selected, [...at, "fallbacks", index]),
          ),
        ],
        setting,
      );
    }
  }
}

function configuredModels(value: unknown, setting: SelectionMessage): readonly string[] {
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
    if (!isModelReference(selected)) {
      throw new ConfigurationHarnessError(
        "The configured Agent model must identify its provider and model as <provider>/<model>, such as openai/gpt-5.1 or codex/gpt-5.1.",
      );
    }
    return selected;
  });
  requirePrimaryProvider(models, setting);
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

// A provider catalog's rows keyed by id, built once per resolution so that looking up each
// selected model costs the same however long the catalog is (finding 1316). A row names a model
// by its complete ref or by the remainder after the provider (always shorter).
type CatalogIndex = ReadonlyMap<string, readonly Readonly<Record<string, unknown>>[]>;

function catalogIndex(rows: readonly unknown[]): CatalogIndex {
  const index = new Map<string, Readonly<Record<string, unknown>>[]>();
  for (const value of rows) {
    const row = asRecord(value);
    if (typeof row?.id === "string") {
      const listed = index.get(row.id);
      if (listed === undefined) {
        index.set(row.id, [row]);
      } else {
        listed.push(row);
      }
    }
  }
  return index;
}

function providerModelEntry(
  providerId: string,
  provider: Readonly<Record<string, unknown>>,
  model: string,
  catalogs: Map<string, CatalogIndex>,
): Readonly<Record<string, unknown>> | undefined {
  const configured = provider.models;
  if (configured === undefined) {
    return undefined;
  }
  if (!Array.isArray(configured)) {
    throw providerModelsListError(providerId);
  }
  let index = catalogs.get(providerId);
  if (index === undefined) {
    index = catalogIndex(configured);
    catalogs.set(providerId, index);
  }
  const { id } = splitModelRef(model);
  const complete = index.get(model) ?? [];
  const remainder = (id === undefined ? undefined : index.get(id)) ?? [];
  if (complete.length + remainder.length > 1) {
    throw new ConfigurationHarnessError(
      modelProviderMessage(
        providerId,
        (path) =>
          `Configuration setting ${path}.models lists the selected model more than once: keep one entry.`,
      ),
    );
  }
  return complete[0] ?? remainder[0];
}

/**
 * The agents shape rules resolveConfiguredHarnessId checks first. They hold for every topology,
 * so Configuration create and update check them too (requireDeployableRoster).
 */
export function requireAgentsShape(values: Readonly<OpenClawConfigurationDocument>): void {
  // A non-object agents, agents.defaults, agents.entries or entry would otherwise read as absent
  // and surface as an unrelated model-policy refusal.
  const agents = asRecord(values.agents);
  if (values.agents !== undefined && agents === undefined) {
    throw new ConfigurationHarnessError("Configuration setting agents must be an object.");
  }
  if (agents?.defaults !== undefined && asRecord(agents.defaults) === undefined) {
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
  for (const [key, value] of Object.entries(entries ?? {})) {
    if (asRecord(value) === undefined) {
      throw new ConfigurationHarnessError(
        agentEntryMessage(key, (path) => `Configuration setting ${path} must be an object.`),
      );
    }
  }
}

/** Resolve native model policy without treating ignored whole-agent runtime pins as authoritative. */
export function resolveConfiguredHarnessId(
  values: Readonly<OpenClawConfigurationDocument>,
): string {
  // Shape refusals come first.
  requireAgentsShape(values);
  const agents = asRecord(values.agents);
  const defaults = asRecord(agents?.defaults);
  const entries = asRecord(agents?.entries);
  const providerConfigurations = asRecord(asRecord(values.models)?.providers);
  const defaultSelection = configuredModels(defaults?.model, defaultModelMessage);
  const defaultModels = asRecord(defaults?.models);
  // The candidates are every model of every selection, in document order: agents.defaults' and
  // each agents.entries entry's, with the entry whose `models` policy applies to them. An entry
  // without its own model shares the defaults' list instead of copying it, so the work stays in
  // step with the document's size (finding 1316).
  const selections: Array<{
    models: readonly string[];
    entry?: Readonly<Record<string, unknown>>;
  }> = [{ models: defaultSelection }];
  // The first candidate: every selection's primary must be this one.
  let primary = defaultSelection[0];

  for (const [key, value] of Object.entries(entries ?? {})) {
    // requireAgentsShape refused every entry that is not an object.
    const entry = asRecord(value)!;
    const selection =
      entry.model === undefined
        ? defaultSelection
        : configuredModels(entry.model, entryModelMessage(key));
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
    if (primary !== undefined && model !== primary) {
      throw new ConfigurationHarnessError(
        agentEntryMessage(
          key,
          (path) =>
            `Configuration setting ${path}.model must select the same primary model as agents.defaults.model and the other agents.entries.`,
        ),
      );
    }
    primary ??= model;
    const models = asRecord(entry.models);
    if (entry.models !== undefined && !matchingSelectableModels(models, model)) {
      throw new ConfigurationHarnessError(
        agentEntryMessage(key, (path) => `Configuration setting ${path}.models ${selectableRule}`),
      );
    }
    selections.push({ models: selection, entry });
  }

  if (defaults?.models !== undefined && !matchingSelectableModels(defaultModels, primary)) {
    throw new ConfigurationHarnessError(
      primary === undefined
        ? "Configuration setting agents.defaults.models needs a primary model: set agents.defaults.model or an agents.entries model."
        : `Configuration setting agents.defaults.models ${selectableRule}`,
    );
  }

  // The catalog ids that name each provider's candidates (complete ref or remainder), so each
  // catalog row is checked in constant time.
  const catalogIds = new Map<string, Set<string>>();
  for (const models of new Set(selections.map(({ models }) => models))) {
    for (const model of models) {
      const { provider, id } = splitModelRef(model);
      const ids = catalogIds.get(provider) ?? new Set<string>();
      catalogIds.set(provider, ids.add(model).add(id!));
    }
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
      throw providerModelsListError(providerId);
    }
    const ids = catalogIds.get(providerId);
    if (
      provider.models.some((value) => {
        const id = asRecord(value)?.id;
        return !(typeof id === "string" && ids?.has(id) === true);
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

  if (primary === undefined) {
    return "openclaw";
  }
  const resolved = new Set<string>();
  const plugins = asRecord(asRecord(values.plugins)?.entries);
  const catalogs = new Map<string, CatalogIndex>();

  // The Harness one candidate selects; refusals name no candidate.
  const resolveCandidate = (model: string, entryPolicy: unknown): string => {
    const providerId = splitModelRef(model).provider;
    const provider = asRecord(providerConfigurations?.[providerId]);
    const providerModel =
      provider === undefined
        ? undefined
        : providerModelEntry(providerId, provider, model, catalogs);
    const policies = new Set(
      [entryPolicy, defaultModels?.[model], providerModel, provider]
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
    return selected ?? "openclaw";
  };

  // A candidate depends only on its model and the entry's policy for it, so one that repeats an
  // earlier one is skipped: the earlier one resolved the same way. The defaults come first, so an
  // entry that shares their list adds only the models its own `models` policy names, in the
  // defaults' order.
  const position = new Map<string, number>();
  defaultSelection.forEach((model, index) => {
    if (!position.has(model)) {
      position.set(model, index);
    }
  });
  const resolvedModels = new Set<string>();
  for (const { models, entry } of selections) {
    const entryModels = asRecord(entry?.models);
    const candidates =
      entry !== undefined && models === defaultSelection
        ? Object.keys(entryModels ?? {})
            .filter((model) => position.has(model))
            .sort((left, right) => position.get(left)! - position.get(right)!)
        : models;
    for (const model of candidates) {
      const entryPolicy = entryModels?.[model];
      if (entryPolicy === undefined) {
        if (resolvedModels.has(model)) {
          continue;
        }
        resolvedModels.add(model);
      }
      resolved.add(resolveCandidate(model, entryPolicy));
    }
  }

  if (resolved.size !== 1) {
    throw new ConfigurationHarnessError(
      "The configured Agent models select conflicting Harness runtimes.",
    );
  }
  return [...resolved][0]!;
}
