import type {
  ConfigurationValidationOptions,
  OpenClawConfigurationDocument,
} from "@openclaw-enterprise/contracts";
import { asRecord, isNonEmptyString, splitModelRef } from "@openclaw-enterprise/utils";

import { canSpell } from "./configuration-settings.ts";
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

// OpenClaw's `openrouter:auto` or `openrouter:free`, which `splitModelRef` reads as the openrouter
// provider's, though it has no slash. A reference with a slash is isModelReference's to judge:
// `splitModelRef` gives `codex/` an id too.
function isOpenRouterSelector(selected: unknown): selected is string {
  return (
    isNonEmptyString(selected) &&
    !selected.includes("/") &&
    splitModelRef(selected).id !== undefined
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

// A model selection's path in the document and the refusal that names it.
type ModelSelection = [value: unknown, at: readonly (string | number)[], setting: SelectionMessage];

// Every model selection deployment reads, in its order: agents.defaults.model, then each
// agents.entries entry's own. An entry without its own model has nothing to check here; skipping
// it keeps a large roster cheap (finding 1321).
function modelSelections(values: Readonly<OpenClawConfigurationDocument>): ModelSelection[] {
  const agents = asRecord(values.agents);
  const selections: ModelSelection[] = [
    [asRecord(agents?.defaults)?.model, ["agents", "defaults", "model"], defaultModelMessage],
  ];
  for (const [key, entry] of Object.entries(asRecord(agents?.entries) ?? {})) {
    const model = asRecord(entry)?.model;
    if (model !== undefined) {
      selections.push([model, ["agents", "entries", key, "model"], entryModelMessage(key)]);
    }
  }
  return selections;
}

/**
 * The models a selection names, primary first: a string is the primary alone, an object its
 * `primary` and `fallbacks`. Refuses fallbacks that are not a list and a model `accepts` refuses,
 * given the model and its index. Deployment (configuredModels) and every save
 * (requireModelSelections) read a selection through this one function, so both refuse the same
 * selections with the same text (finding 1828).
 */
function selectedModels(
  value: unknown,
  setting: SelectionMessage,
  accepts: (selected: unknown, index: number) => boolean,
): readonly unknown[] {
  const configured = asRecord(value);
  const fallbacks = configured?.fallbacks;
  if (fallbacks !== undefined && !Array.isArray(fallbacks)) {
    throw new ConfigurationHarnessError(setting(".fallbacks must be an array."));
  }
  const models = [typeof value === "string" ? value : configured?.primary, ...(fallbacks ?? [])];
  models.forEach((selected, index) => {
    if (!accepts(selected, index)) {
      throw new ConfigurationHarnessError(
        setting(
          " must name each model as <provider>/<model>, such as openai/gpt-5.1 or codex/gpt-5.1.",
        ),
      );
    }
  });
  return models;
}

// The path of a selection's model `index`, 0 for the primary: the selection itself when it is a
// string.
function selectedModelPath(
  value: unknown,
  at: readonly (string | number)[],
  index: number,
): readonly (string | number)[] {
  if (index > 0) {
    return [...at, "fallbacks", index - 1];
  }
  return typeof value === "string" ? at : [...at, "primary"];
}

// On a Preset save, whether a key of the selection object waits on a variable that a filling can
// make `primary`, as in {"{{ vars.key }}": "openai/gpt-5.1"}: its model is checked once filled.
function primaryWaitsOnKey(
  value: unknown,
  at: readonly (string | number)[],
  unresolved: NonNullable<ConfigurationValidationOptions["unresolved"]>,
): boolean {
  return Object.keys(asRecord(value) ?? {}).some((key) => {
    const literals = unresolved([...at, key], true);
    return literals !== undefined && canSpell(literals, "primary");
  });
}

// On a Preset save, whether some filling of a model reference that waits on an unfilled variable
// (`literals`, the text around each one) makes a <provider>/<model> reference: not when its
// written text starts or ends with a slash, nor when a number or boolean variable is the whole
// reference (`type`), which fills it with no string.
function fillsAsModelReference(literals: readonly string[], type: string | undefined): boolean {
  return (
    (type === undefined || type === "string") &&
    !literals[0]!.startsWith("/") &&
    !literals[literals.length - 1]!.endsWith("/")
  );
}

/**
 * The fallback rule of resolveConfiguredHarnessId alone, for one well-formed selection. Every
 * deployment refuses a fallback on another provider, so Configuration save (through
 * requireDeployableRoster), Preset save and Agent save refuse it too, even where another model
 * policy rule leaves the rest to deployment (finding 1298). OpenClaw's `openrouter:auto` and
 * `openrouter:free` count as openrouter references (finding 1320): saves refuse them earlier, as
 * models without a slash (finding 1828), so this reading names a fallback only for Agent save's
 * check of a stored Configuration. On a Preset save
 * (`options.unresolved`), a reference whose provider waits on an unfilled variable (no `/` before
 * the first one, as in `openrouter:{{ vars.kind }}`) is checked once filled, on the Configuration
 * a launch creates (finding 1305).
 */
function requireSelectionFallbackProviders(
  [value, at, setting]: ModelSelection,
  { unresolved }: ConfigurationValidationOptions,
): void {
  // OpenClaw's `openrouter:auto` and `openrouter:free` selectors name the openrouter provider
  // without a slash (`splitModelRef`), so they are checked as the other references are (finding
  // 1320), as a fallback and as the primary.
  const writtenProvider = (
    selected: unknown,
    path: readonly (string | number)[],
  ): selected is string => {
    const literals = unresolved?.(path);
    return (
      (isModelReference(selected) || isOpenRouterSelector(selected)) &&
      (literals === undefined || literals[0]!.includes("/"))
    );
  };
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

// requireSelectionFallbackProviders over every selection: Agent save's check of its Configuration.
export function requireFallbackProviders(
  values: Readonly<OpenClawConfigurationDocument>,
  options: ConfigurationValidationOptions = {},
): void {
  for (const selection of modelSelections(values)) {
    requireSelectionFallbackProviders(selection, options);
  }
}

/**
 * The model selection rules of resolveConfiguredHarnessId that hold for every topology, in its
 * order within each selection: its fallbacks are a list, each model a <provider>/<model>
 * reference, and each fallback on the primary model's provider. Every deployment refuses a
 * selection that breaks one, so Preset save refuses it too, with the deployment's text
 * (requireDeployableRoster; finding 1828); the other saves run these rules within
 * requireConsistentModelPolicy. On a Preset save, a model that waits on an unfilled variable, or
 * a primary that a variable key can supply, is checked as far as its written text goes, and in
 * full on the Configuration a launch creates.
 */
export function requireModelSelections(
  values: Readonly<OpenClawConfigurationDocument>,
  options: ConfigurationValidationOptions = {},
): void {
  const { unresolved, unresolvedType } = options;
  for (const selection of modelSelections(values)) {
    const [value, at, setting] = selection;
    if (value !== undefined) {
      selectedModels(value, setting, (selected, index) => {
        const path = selectedModelPath(value, at, index);
        const literals = unresolved?.(path);
        if (literals !== undefined) {
          return fillsAsModelReference(literals, unresolvedType?.(path));
        }
        return (
          isModelReference(selected) ||
          (index === 0 &&
            selected === undefined &&
            unresolved !== undefined &&
            primaryWaitsOnKey(value, at, unresolved))
        );
      });
    }
    requireSelectionFallbackProviders(selection, options);
  }
}

function configuredModels(value: unknown, setting: SelectionMessage): readonly string[] {
  if (value === undefined) {
    return [];
  }
  const models = selectedModels(value, setting, isModelReference) as readonly string[];
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
 * The provider catalog rule of resolveConfiguredHarnessId: each row of a
 * models.providers.<provider>.models list names a primary or fallback model of `selections`, by
 * its complete ref or the remainder after the provider. Deployment checks it on every Harness,
 * before it resolves one, so Configuration save runs it too (requireConsistentModelPolicy;
 * finding 3019).
 */
function requireSelectedCatalogRows(
  providerConfigurations: Readonly<Record<string, unknown>> | undefined,
  selections: Iterable<readonly string[]>,
): void {
  // The catalog ids that name each provider's candidates (complete ref or remainder), so each
  // catalog row is checked in constant time.
  const catalogIds = new Map<string, Set<string>>();
  for (const models of new Set(selections)) {
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

/**
 * resolveConfiguredHarnessId's rules, in its order, for deployment and, as a `draft`, for
 * Configuration save (requireConsistentModelPolicy). A draft skips only the rules that a document
 * still missing a setting breaks: an agents.entries entry without a model while
 * agents.defaults.model is unset, agents.defaults.models with no primary model, and a model
 * without the explicit Harness runtime its provider needs. Deployment refuses those. Every other
 * rule refuses a value the document sets, so a draft refuses it too, with deployment's text and in
 * deployment's order (finding 3020). A draft resolves no Harness when it leaves one to
 * deployment.
 */
function resolveModelPolicy(
  values: Readonly<OpenClawConfigurationDocument>,
  draft: boolean,
): string | undefined {
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
      if (draft) {
        // The draft selects no model for this entry yet: deployment names the missing one.
        continue;
      }
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

  if (
    defaults?.models !== undefined &&
    !(draft && primary === undefined) &&
    !matchingSelectableModels(defaultModels, primary)
  ) {
    throw new ConfigurationHarnessError(
      primary === undefined
        ? "Configuration setting agents.defaults.models needs a primary model: set agents.defaults.model or an agents.entries model."
        : `Configuration setting agents.defaults.models ${selectableRule}`,
    );
  }

  requireSelectedCatalogRows(
    providerConfigurations,
    selections.map(({ models }) => models),
  );

  if (primary === undefined) {
    return draft ? undefined : "openclaw";
  }
  const resolved = new Set<string>();
  const plugins = asRecord(asRecord(values.plugins)?.entries);
  const catalogs = new Map<string, CatalogIndex>();

  // The Harness one candidate selects; refusals name no candidate. A draft leaves a candidate
  // without its required runtime to deployment.
  const resolveCandidate = (model: string, entryPolicy: unknown): string | undefined => {
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
      if (draft) {
        return undefined;
      }
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
      const harness = resolveCandidate(model, entryPolicy);
      if (harness !== undefined) {
        resolved.add(harness);
      }
    }
  }

  // Deployment resolves every candidate. A draft that left each one to deployment resolves none.
  if (resolved.size > 1 || (!draft && resolved.size === 0)) {
    throw new ConfigurationHarnessError(
      "The configured Agent models select conflicting Harness runtimes.",
    );
  }
  return [...resolved][0];
}

/** Resolve native model policy without treating ignored whole-agent runtime pins as authoritative. */
export function resolveConfiguredHarnessId(
  values: Readonly<OpenClawConfigurationDocument>,
): string {
  return resolveModelPolicy(values, false)!;
}

/**
 * Refuses, when a Configuration is saved, a model policy that every deployment refuses because
 * the document sets conflicting values, with deployment's text and in deployment's order: the
 * agents shape, each selection's form and fallback provider, an entry primary other than the
 * defaults', agents.*.models that break the selectable rule, a provider catalog row that names no
 * selected model (finding 3019), a selected model listed twice in its catalog, conflicting runtime
 * policies, an unsupported runtime id, a Codex runtime on another provider than codex, and models
 * that select different runtimes (finding 3020). A draft without a model, or a model without its
 * required runtime, still saves; deployment refuses it. None of these rules reads Installation or
 * Harness state.
 */
export function requireConsistentModelPolicy(
  values: Readonly<OpenClawConfigurationDocument>,
): void {
  resolveModelPolicy(values, true);
}
