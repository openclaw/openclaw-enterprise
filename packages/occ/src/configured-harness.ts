import type {
  ConfigurationValidationOptions,
  OpenClawConfigurationDocument,
} from "@openclaw-enterprise/contracts";
import { asRecord, isNonEmptyString, splitModelRef } from "@openclaw-enterprise/utils";

import { canSpell } from "./configuration-settings.ts";
import {
  agentEntryMessage,
  ConfigurationHarnessError,
  configurationSettingMessage,
  configurationSettingsMessage,
  keyedSettingPath,
  modelProviderMessage,
  quotedSettingKey,
} from "./errors.ts";
import { providerModelsListError } from "./model-provider-settings.ts";

// The runtime a model policy selects. `policy` gives the setting path of the object that holds
// agentRuntime, such as agents.defaults.models["openai/gpt-5.1"]; it is built only for a refusal,
// so a large policy map stays cheap to read (finding 1316).
function configuredRuntime(value: unknown, policy: () => string): string | undefined {
  const runtimeValue = asRecord(value)?.agentRuntime;
  if (runtimeValue === undefined) {
    return undefined;
  }
  const runtime = asRecord(runtimeValue);
  if (runtime === undefined || (runtime.id !== "openclaw" && runtime.id !== "codex")) {
    throw new ConfigurationHarnessError(
      configurationSettingMessage(`${policy()}.agentRuntime.id`, "must be openclaw or codex"),
    );
  }
  return runtime.id;
}

// The runtime a policy sets, or undefined when it sets none or one configuredRuntime refuses: it
// reads a policy for an offer, so it never refuses one itself.
function policyRuntime(value: unknown): "openclaw" | "codex" | undefined {
  const id = asRecord(asRecord(value)?.agentRuntime)?.id;
  return id === "openclaw" || id === "codex" ? id : undefined;
}

// Whether Codex runs a model of a provider under this Configuration: a model of its own provider,
// or an openai model through the Codex plugin's WebSocket app server.
function codexRunsProvider(
  values: Readonly<OpenClawConfigurationDocument>,
): (providerId: string) => boolean {
  const codexPlugin = asRecord(asRecord(asRecord(values.plugins)?.entries)?.codex);
  const codexAppServer = asRecord(asRecord(codexPlugin?.config)?.appServer);
  return (providerId) =>
    providerId === "codex" ||
    (providerId === "openai" &&
      codexPlugin?.enabled === true &&
      codexAppServer?.transport === "websocket");
}

/**
 * Whether Codex runs the primary model of a Configuration that resolveConfiguredHarnessId
 * admitted, so a refusal can offer codex: every selected model shares the primary's provider. A
 * Configuration without a model has none to run.
 */
export function codexRunsPrimaryModel(values: Readonly<OpenClawConfigurationDocument>): boolean {
  const primary = modelSelections(values)
    .map(([selection]) =>
      typeof selection === "string" ? selection : asRecord(selection)?.primary,
    )
    .find(isModelReference);
  return primary !== undefined && codexRunsProvider(values)(splitModelRef(primary).provider);
}

/**
 * The Agent a deployment resolves the model policy for, which only its refusals' offers read.
 * `openclawRuns` is false for a dedicated Agent on an Installation that cannot run Dedicated
 * OpenClaw; `codexRuns` is false for an embedded Agent where the Installation approves the Codex
 * Harness only for dedicated execution. Each is read only when a refusal is built, and at most one
 * of them is false.
 */
export interface ModelPolicyAgent {
  readonly openclawRuns: () => boolean;
  readonly codexRuns: () => boolean;
}

// The next step a refusal names instead of a runtime where the deploying Agent runs neither for
// the model: an embedded Agent with a codex/<model> model, where the Installation approves Codex
// only for dedicated execution and embedded OpenClaw runs no codex/<model> model (finding 3037).
// `target` is "it" for one setting, or "both" for two that conflict.
const noRunnableRuntime = (target: "it" | "both") =>
  `set ${target} to codex on a dedicated Agent, or select a model of another provider`;

// The setting path of an agents.defaults.models or agents.entries.<id>.models policy for `model`.
const defaultModelPolicy = (model: string) => keyedSettingPath("agents.defaults.models", model);

const entryModelsPath = (key: string) => `${keyedSettingPath("agents.entries", key)}.models`;

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

/**
 * The refusal for an agents.defaults.models or agents.entries.<id>.models setting (`parent`,
 * holding `value`) that breaks the selectable rule, or undefined when it holds: an object keyed
 * by model ref, where a model other than the primary needs the primary's provider and the same
 * agentRuntime, set on both. The first model that breaks it, in document order, is named.
 * `primaryOffer` gives the remedy for the primary's missing runtime: the values to set it to, or
 * the next step where the deploying Agent runs none.
 */
function selectableModelsRefusal(
  parent: string,
  value: Readonly<Record<string, unknown>> | undefined,
  selectedModel: string,
  primaryOffer: (listed: Readonly<Record<string, unknown>>) => string,
): string | undefined {
  if (value === undefined) {
    return configurationSettingMessage(
      parent,
      'must be an object keyed by model ref, such as {"openai/gpt-5.1": {"agentRuntime": {"id": "openclaw"}}}',
    );
  }
  const selectedPolicy = () => keyedSettingPath(parent, selectedModel);
  const selectedRuntime = configuredRuntime(value[selectedModel], selectedPolicy);
  const selectedProvider = splitModelRef(selectedModel).provider;
  for (const [model, policy] of Object.entries(value)) {
    if (model === selectedModel) {
      continue;
    }
    if (selectedRuntime === undefined) {
      return configurationSettingMessage(
        `${selectedPolicy()}.agentRuntime.id`,
        `is required when other models are listed beside the primary model: ${primaryOffer(value)}`,
      );
    }
    const listed = () => keyedSettingPath(parent, model);
    if (splitModelRef(model).provider !== selectedProvider) {
      return configurationSettingMessage(
        listed(),
        `is not on the primary model's provider, ${quotedSettingKey(selectedProvider, 64)}: remove it, or list a model of that provider`,
      );
    }
    if (configuredRuntime(policy, listed) !== selectedRuntime) {
      return configurationSettingMessage(
        `${listed()}.agentRuntime.id`,
        `must be ${selectedRuntime}, the primary model's runtime: set it, or remove the model`,
      );
    }
  }
  return undefined;
}

// A provider catalog's rows keyed by id, built once per resolution so that looking up each
// selected model costs the same however long the catalog is (finding 1316). A row names a model
// by its complete ref or by the remainder after the provider (always shorter).
// Each row keeps its position in the list, so a refusal can name it.
type CatalogRow = readonly [row: Readonly<Record<string, unknown>>, position: number];

type CatalogIndex = ReadonlyMap<string, readonly CatalogRow[]>;

function catalogIndex(rows: readonly unknown[]): CatalogIndex {
  const index = new Map<string, CatalogRow[]>();
  rows.forEach((value, position) => {
    const row = asRecord(value);
    if (typeof row?.id === "string") {
      const listed = index.get(row.id);
      if (listed === undefined) {
        index.set(row.id, [[row, position]]);
      } else {
        listed.push([row, position]);
      }
    }
  });
  return index;
}

function providerModelEntry(
  providerId: string,
  provider: Readonly<Record<string, unknown>>,
  model: string,
  catalogs: Map<string, CatalogIndex>,
): CatalogRow | undefined {
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
      // With no model selected at all, no row can name one: the setting to set is the model,
      // not the row (dogfood-member-r67 catalog row 7).
      throw new ConfigurationHarnessError(
        modelProviderMessage(providerId, (path) =>
          catalogIds.size === 0
            ? `Configuration setting ${path}.models lists models, but no model is selected: set agents.defaults.model or an agents.entries model.`
            : `Configuration setting ${path}.models may list only entries whose id names a primary or fallback model set in agents.defaults.model or agents.entries.`,
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
  agent?: ModelPolicyAgent,
): string | undefined {
  // Shape refusals come first.
  requireAgentsShape(values);
  const agents = asRecord(values.agents);
  const defaults = asRecord(agents?.defaults);
  const entries = asRecord(agents?.entries);
  const providerConfigurations = asRecord(asRecord(values.models)?.providers);
  const plugins = asRecord(asRecord(values.plugins)?.entries);
  const codexRuns = codexRunsProvider(values);
  // The values a refusal offers for a runtime, which deployment then accepts: codex only where
  // Codex runs the model.
  const runtimeChoices = (providerId: string): ReadonlyArray<"openclaw" | "codex"> =>
    codexRuns(providerId) ? ["openclaw", "codex"] : ["openclaw"];
  // Of the runtimes an offer allows, the ones the deploying Agent can run: codex alone for an
  // Agent that cannot run OpenClaw, whose deployment refuses openclaw with the Dedicated OpenClaw
  // 409 (finding 3036); openclaw alone for an Agent that cannot run Codex, whose deployment
  // refuses codex as needing dedicated execution; none on a codex/<model> model there, whose
  // embedded openclaw deployment fails too (finding 3037). Only an offer of both narrows: an
  // offer of one runtime stays, as no runtime then deploys and deployment's refusal of it names
  // the next step. Configuration save has no Agent and keeps every offer.
  const runnable = (
    choices: ReadonlyArray<"openclaw" | "codex">,
    providerId: string,
  ): ReadonlyArray<"openclaw" | "codex"> => {
    if (agent === undefined || choices.length < 2) {
      return choices;
    }
    if (!agent.openclawRuns()) {
      return ["codex"];
    }
    if (!agent.codexRuns()) {
      return providerId === "codex" ? [] : ["openclaw"];
    }
    return choices;
  };
  // A missing runtime's remedy: the runtimes the Agent can run, or the next step when none.
  const setRuntime = (choices: ReadonlyArray<"openclaw" | "codex">, providerId: string) => {
    const runtimes = runnable(choices, providerId);
    return runtimes.length === 0 ? noRunnableRuntime("it") : `set it to ${runtimes.join(" or ")}`;
  };
  const defaultSelection = configuredModels(defaults?.model, defaultModelMessage);
  const defaultModels = asRecord(defaults?.models);
  // The runtime a provider catalog row or the provider sets for `model`, read without the
  // catalog's refusals, which deployment names later.
  const providerRuntime = (model: string) => {
    const { provider: providerId, id } = splitModelRef(model);
    const provider = asRecord(providerConfigurations?.[providerId]);
    const rows = Array.isArray(provider?.models) ? provider.models : [];
    const named = rows.filter((row) => {
      const rowId = asRecord(row)?.id;
      return rowId === model || (id !== undefined && rowId === id);
    });
    return (named.length === 1 ? policyRuntime(named[0]) : undefined) ?? policyRuntime(provider);
  };
  // What the selectable rule's refusal offers for the primary's missing runtime in a `models`
  // setting: the runtime another setting (`elsewhere`, then the provider) already selects for the
  // primary, else the one the models listed beside it use, so the other policies and the listed
  // models still hold once it is set.
  const primaryRuntimeOffer =
    (model: string, elsewhere: readonly unknown[]) =>
    (listed: Readonly<Record<string, unknown>>) => {
      const providerId = splitModelRef(model).provider;
      const choices = runtimeChoices(providerId);
      const selected = [...elsewhere.map(policyRuntime), providerRuntime(model)].find(
        (runtime) => runtime !== undefined,
      );
      if (selected !== undefined && choices.includes(selected)) {
        return `set it to ${selected}, the runtime other settings select for the primary model`;
      }
      const listedRuntime = Object.entries(listed)
        .filter(([other]) => other !== model && splitModelRef(other).provider === providerId)
        .map(([, policy]) => policyRuntime(policy))
        .find((runtime) => runtime !== undefined);
      if (listedRuntime !== undefined && choices.includes(listedRuntime)) {
        return `set it to ${listedRuntime}, the runtime the listed models use`;
      }
      return setRuntime(choices, providerId);
    };
  // The candidates are every model of every selection, in document order: agents.defaults' and
  // each agents.entries entry's, with the entry whose `models` policy applies to them. An entry
  // without its own model shares the defaults' list instead of copying it, so the work stays in
  // step with the document's size (finding 1316).
  const selections: Array<{
    models: readonly string[];
    entry?: Readonly<Record<string, unknown>>;
    key?: string;
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
    if (entry.models !== undefined) {
      const refusal = selectableModelsRefusal(
        entryModelsPath(key),
        asRecord(entry.models),
        model,
        primaryRuntimeOffer(model, [defaultModels?.[model]]),
      );
      if (refusal !== undefined) {
        throw new ConfigurationHarnessError(refusal);
      }
    }
    selections.push({ models: selection, entry, key });
  }

  if (defaults?.models !== undefined && !(draft && primary === undefined)) {
    if (primary === undefined) {
      throw new ConfigurationHarnessError(
        "Configuration setting agents.defaults.models needs a primary model: set agents.defaults.model or an agents.entries model.",
      );
    }
    const refusal = selectableModelsRefusal(
      "agents.defaults.models",
      defaultModels,
      primary,
      primaryRuntimeOffer(
        primary,
        Object.values(entries ?? {}).map((entry) => asRecord(asRecord(entry)?.models)?.[primary]),
      ),
    );
    if (refusal !== undefined) {
      throw new ConfigurationHarnessError(refusal);
    }
  }

  requireSelectedCatalogRows(
    providerConfigurations,
    selections.map(({ models }) => models),
  );

  if (primary === undefined) {
    return draft ? undefined : "openclaw";
  }
  const resolved = new Set<string>();
  const catalogs = new Map<string, CatalogIndex>();

  // The Harness one candidate selects. `entryKey` names the agents.entries entry whose `models`
  // policy for the model is `entryPolicy`, and `primaryModel` is the selection's primary. Each
  // refusal names the setting to change: the policy that selects the runtime, or, for a missing
  // runtime, a setting where it keeps the selectable rule (see that refusal). A draft leaves a
  // candidate without its required runtime to deployment (finding 3022).
  const resolveCandidate = (
    model: string,
    entryPolicy: unknown,
    entryKey: string | undefined,
    entrySetsPrimary: boolean,
    primaryModel: string,
  ): string | undefined => {
    const providerId = splitModelRef(model).provider;
    const provider = asRecord(providerConfigurations?.[providerId]);
    const providerModel =
      provider === undefined
        ? undefined
        : providerModelEntry(providerId, provider, model, catalogs);
    const providerPath = () => keyedSettingPath("models.providers", providerId);
    const entryPolicyPath = () => keyedSettingPath(entryModelsPath(entryKey!), model);
    // Each policy and its setting path, in precedence order. Every one is read before a conflict
    // is refused, so an unsupported runtime id anywhere is named first.
    const policies: Array<readonly [runtime: string, policy: () => string]> = [];
    for (const [value, policy] of [
      [entryPolicy, entryPolicyPath],
      [defaultModels?.[model], () => defaultModelPolicy(model)],
      [providerModel?.[0], () => `${providerPath()}.models[${providerModel![1]}]`],
      [provider, providerPath],
    ] as const) {
      const runtime = configuredRuntime(value, policy);
      if (runtime !== undefined) {
        policies.push([runtime, policy]);
      }
    }
    const [first, ...others] = policies;
    const conflicting = others.find(([runtime]) => runtime !== first![0]);
    // Every candidate must select the same runtime as an earlier one.
    const [earlier] = resolved;
    // For the defaults' candidates, the runtimes agents.entries policies set for the model: an
    // entry that resolves it later must agree. Read only for a refusal's offer.
    const entryRuntimes = () =>
      entryKey === undefined
        ? Object.values(entries ?? {}).map((entry) =>
            policyRuntime(asRecord(asRecord(entry)?.models)?.[model]),
          )
        : [];
    if (conflicting !== undefined) {
      // Offer only a runtime deployment then accepts: one Codex runs the model with, that the
      // policies not named, the entries' policies and an earlier candidate select too.
      const elsewhere = entryRuntimes();
      const allowed = runtimeChoices(providerId).filter(
        (runtime) =>
          (resolved.size !== 1 || runtime === earlier) &&
          policies.every(
            (policy) => policy === first || policy === conflicting || policy[0] === runtime,
          ) &&
          elsewhere.every((other) => other === undefined || other === runtime),
      );
      const accepted = runnable(allowed, providerId);
      const remedy =
        accepted.length === 1
          ? `set both to ${accepted[0]}, or remove the one set to ${accepted[0] === first![0] ? conflicting[0] : first![0]}`
          : accepted.length < allowed.length
            ? noRunnableRuntime("both")
            : "set both to openclaw or both to codex, or remove one";
      throw new ConfigurationHarnessError(
        configurationSettingsMessage(
          `${first![1]()}.agentRuntime.id`,
          `${conflicting[1]()}.agentRuntime.id`,
          (one, other) =>
            `Configuration settings ${one} (${first![0]}) and ${other} (${conflicting[0]}) conflict: ${remedy}.`,
        ),
      );
    }
    const selected = first?.[0];
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
      // Offer only a value deployment then accepts: the runtime an earlier candidate selected,
      // as every candidate must select the same one, and codex only where Codex runs the model.
      // The setting named keeps the selectable rule once it is set: the entry's `models` policy
      // when it lists the model or sets the primary's runtime; the defaults' when the model is
      // the primary or they set the primary's runtime; otherwise the primary's runtime comes
      // from the provider, so the model's catalog row, or the provider when it has none.
      let missing: string;
      if (entryPolicy !== undefined || entrySetsPrimary) {
        missing = entryPolicyPath();
      } else if (
        model === primaryModel ||
        policyRuntime(defaultModels?.[primaryModel]) !== undefined ||
        provider === undefined
      ) {
        missing = defaultModelPolicy(model);
      } else if (providerModel !== undefined) {
        missing = `${providerPath()}.models[${providerModel[1]}]`;
      } else {
        missing = providerPath();
      }
      const choices = runtimeChoices(providerId);
      const entryRuntime = entryRuntimes().find(
        (runtime) => runtime !== undefined && choices.includes(runtime),
      );
      throw new ConfigurationHarnessError(
        configurationSettingMessage(
          `${missing}.agentRuntime.id`,
          `is required for the selected model: ${
            resolved.size === 1
              ? `set it to ${earlier}, the runtime the other selected models use`
              : entryRuntime !== undefined
                ? `set it to ${entryRuntime}, the runtime agents.entries select for the model`
                : setRuntime(choices, providerId)
          }`,
        ),
      );
    }
    if (selected === "codex" && !codexRuns(providerId)) {
      // Offer only a next step the deploying Agent can take: a codex/<model> model where it
      // cannot run OpenClaw (finding 3036), openclaw where it cannot run Codex (finding 3037).
      let remedy = "select a codex/<model> model, or set it to openclaw";
      if (agent?.openclawRuns() === false) {
        remedy = "select a codex/<model> model";
      } else if (agent?.codexRuns() === false) {
        remedy = "set it to openclaw";
      }
      throw new ConfigurationHarnessError(
        configurationSettingMessage(
          `${first![1]()}.agentRuntime.id`,
          `selects codex for a model outside the codex provider: ${remedy}`,
        ),
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
  for (const { models, entry, key } of selections) {
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
      const harness = resolveCandidate(
        model,
        entryPolicy,
        key,
        policyRuntime(entryModels?.[models[0]!]) !== undefined,
        models[0]!,
      );
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

/**
 * Resolve native model policy without treating ignored whole-agent runtime pins as authoritative.
 * With the deploying `agent`, a refusal offers only runtimes that Agent can run; which documents
 * are refused does not depend on it.
 */
export function resolveConfiguredHarnessId(
  values: Readonly<OpenClawConfigurationDocument>,
  agent?: ModelPolicyAgent,
): string {
  return resolveModelPolicy(values, false, agent)!;
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
 * Harness state: a write that knows the one Agent the Configuration serves (Agent provisioning)
 * passes it, and only the refusals' offers read it.
 */
export function requireConsistentModelPolicy(
  values: Readonly<OpenClawConfigurationDocument>,
  agent?: ModelPolicyAgent,
): void {
  resolveModelPolicy(values, true, agent);
}
