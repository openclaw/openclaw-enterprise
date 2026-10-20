import type {
  ConfigurationValidationOptions,
  OpenClawConfigurationDocument,
} from "@openclaw-enterprise/contracts";
import { asRecord, isNonEmptyString, splitModelRef } from "@openclaw-enterprise/utils";

import {
  agentEntryMessage,
  ConfigurationHarnessError,
  configurationSettingMessage,
  keyedSettingPath,
  modelProviderMessage,
} from "./errors.ts";
import { providerModelsListError } from "./model-provider-settings.ts";

/**
 * OpenClaw's Claude Code CLI backend. It is a model-scoped agent runtime of the embedded
 * OpenClaw Harness, not a Harness of its own: the Gateway process spawns the Claude Code
 * binary for each turn. Upstream calls it `claude-cli`.
 */
export const CLAUDE_CLI_AGENT_RUNTIME_ID = "claude-cli";

const SUPPORTED_AGENT_RUNTIME_IDS: ReadonlySet<string> = new Set([
  "openclaw",
  "codex",
  CLAUDE_CLI_AGENT_RUNTIME_ID,
]);

/** The Harness that executes a configured agent runtime. */
export function harnessIdForAgentRuntime(agentRuntimeId: string): string {
  return agentRuntimeId === CLAUDE_CLI_AGENT_RUNTIME_ID ? "openclaw" : agentRuntimeId;
}

/**
 * Whether any model policy in the document names the Claude Code agent runtime. A lenient
 * read for Compute, which renders an already admitted document: resolveConfiguredAgentRuntimeId
 * has refused a document whose policies conflict or name another provider, so one such policy
 * means the Gateway spawns Claude Code.
 */
export function selectsClaudeCodeRuntime(values: Readonly<OpenClawConfigurationDocument>): boolean {
  const namesClaudeCode = (policy: unknown): boolean =>
    asRecord(asRecord(policy)?.agentRuntime)?.id === CLAUDE_CLI_AGENT_RUNTIME_ID;
  const modelPolicies = (host: unknown): unknown[] =>
    Object.values(asRecord(asRecord(host)?.models) ?? {});
  const agents = asRecord(values.agents);
  const providers = Object.values(asRecord(asRecord(values.models)?.providers) ?? {});
  return [
    ...modelPolicies(agents?.defaults),
    ...Object.values(asRecord(agents?.entries) ?? {}).flatMap(modelPolicies),
    ...providers,
    ...providers.flatMap((provider) => {
      const rows = asRecord(provider)?.models;
      return Array.isArray(rows) ? rows : [];
    }),
  ].some(namesClaudeCode);
}

// The OpenClaw capability each Claude Code native tool carries in the pinned Anthropic plugin
// (projectClaudeNativeToolAuthority): Read and Grep read, Write write, Edit edit, WebFetch
// web_fetch, WebSearch web_search. The pinned Gateway gates those native calls by its exec
// security setting and plugin hooks only, never by the Configuration's tool policy, which it
// applies to OpenClaw's own tools (finding 2142). Bash is host-owned: OpenClaw removes it and
// routes shell work through its exec tool, so exec and process policy still holds. A
// sender-restricted turn (toolsBySender) already runs with no native tools at all.
const CLAUDE_CODE_NATIVE_CAPABILITIES: readonly string[] = [
  "read",
  "write",
  "edit",
  "web_fetch",
  "web_search",
];
// The pinned catalog's groups holding one of them (buildCoreToolGroupMap): group:openclaw
// holds only the tools flagged includeInOpenClawGroup, so web_fetch and web_search.
const CLAUDE_CODE_NATIVE_GROUPS: Readonly<Record<string, readonly string[]>> = {
  "group:fs": ["read", "write", "edit"],
  "group:web": ["web_fetch", "web_search"],
  "group:openclaw": ["web_fetch", "web_search"],
};
// The pinned built-in profiles that allow none of them; coding and full allow all five, and an
// unknown profile adds no profile step.
const NATIVE_FREE_TOOL_PROFILES: ReadonlySet<string> = new Set(["minimal", "messaging"]);
const CLAUDE_CODE_TOOL_POLICY_REFUSAL =
  "restricts Claude Code's native file or web tools, which the Claude Code agent runtime ignores: remove the restriction or use the default agent runtime";

/** The native capabilities a tool policy list names: by name, `*` glob, or catalog group. */
function nativeCapabilitiesNamed(list: unknown): Set<string> {
  const named = new Set<string>();
  for (const value of Array.isArray(list) ? list : []) {
    if (typeof value !== "string") {
      continue;
    }
    const entry = value.trim().toLowerCase();
    const group = CLAUDE_CODE_NATIVE_GROUPS[entry];
    if (group !== undefined) {
      group.forEach((capability) => named.add(capability));
    } else if (!entry.includes("*")) {
      if (CLAUDE_CODE_NATIVE_CAPABILITIES.includes(entry)) {
        named.add(entry);
      }
    } else {
      const pattern = new RegExp(
        `^${entry.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
      );
      CLAUDE_CODE_NATIVE_CAPABILITIES.filter((capability) => pattern.test(capability)).forEach(
        (capability) => named.add(capability),
      );
    }
  }
  return named;
}

const namesEveryNativeCapability = (list: unknown): boolean =>
  nativeCapabilitiesNamed(list).size === CLAUDE_CODE_NATIVE_CAPABILITIES.length;

/** A `tools` object or one of its `byProvider` entries, with the setting path that names it. */
interface ToolPolicyScope {
  readonly tools: Readonly<Record<string, unknown>> | undefined;
  readonly path: string;
}

/**
 * A Claude Code tool policy the runtime would ignore. Unlike other Harness refusals, which a
 * draft may still resolve, it is a complete setting, so Configuration save refuses it too.
 */
export class ClaudeCodeToolPolicyError extends ConfigurationHarnessError {}

/**
 * Refuses a Claude Code Configuration whose tool policy would restrict a native capability the
 * runtime cannot restrict, so an Agent never runs with a policy it silently ignores. Deny lists
 * naming only OpenClaw tools, such as `exec` and `process`, stay valid.
 *
 * The pinned pipeline (resolveEffectiveToolPolicy) applies each deny and allow list as its own
 * step: top-level `tools`, its `byProvider` entry, and the same two of the Agent's
 * `agents.entries` entry. A deny list naming a native capability, or a nonempty allowlist that
 * leaves one out, is refused. The profile step takes the entry's `profile` and `alsoAllow`, each
 * falling back to the top-level one (and likewise for the `byProvider` profile step), so it is
 * resolved per entry, or once without a roster: `minimal` or `messaging` is refused unless that
 * `alsoAllow` adds every native capability back. Every `byProvider` key for `anthropic` or an
 * `anthropic/<model>` counts, selected or not, because admission cannot know which one the
 * Gateway's model normalization picks (as in openclaw-tool-denial.ts). Sandbox tool policy is
 * not checked.
 */
function requireEnforceableClaudeCodeToolPolicy(
  values: Readonly<OpenClawConfigurationDocument>,
): void {
  const refuse = (setting: string): never => {
    throw new ClaudeCodeToolPolicyError(
      configurationSettingMessage(setting, CLAUDE_CODE_TOOL_POLICY_REFUSAL),
    );
  };
  const anthropicScopes = (scope: ToolPolicyScope): ToolPolicyScope[] =>
    Object.entries(asRecord(scope.tools?.byProvider) ?? {})
      .filter(([key]) => {
        const provider = key.trim().toLowerCase();
        return provider === "anthropic" || provider.startsWith("anthropic/");
      })
      .map(([key, value]) => ({
        tools: asRecord(value),
        path: keyedSettingPath(`${scope.path}.byProvider`, key),
      }));
  const listSteps = (scope: ToolPolicyScope) => {
    if (nativeCapabilitiesNamed(scope.tools?.deny).size > 0) {
      refuse(`${scope.path}.deny`);
    }
    const allow = scope.tools?.allow;
    if (Array.isArray(allow) && allow.length > 0 && !namesEveryNativeCapability(allow)) {
      refuse(`${scope.path}.allow`);
    }
  };
  const profileStep = (
    entry: ToolPolicyScope | undefined,
    fallback: ToolPolicyScope | undefined,
  ) => {
    const owner = typeof entry?.tools?.profile === "string" ? entry : fallback;
    const profile = owner?.tools?.profile;
    if (
      typeof profile === "string" &&
      NATIVE_FREE_TOOL_PROFILES.has(profile.trim().toLowerCase()) &&
      !namesEveryNativeCapability(entry?.tools?.alsoAllow ?? fallback?.tools?.alsoAllow)
    ) {
      refuse(`${owner!.path}.profile`);
    }
  };
  const providerProfileSteps = (
    entries: readonly ToolPolicyScope[],
    fallbacks: readonly ToolPolicyScope[],
  ) => {
    for (const entry of entries.length > 0 ? entries : [undefined]) {
      for (const fallback of fallbacks.length > 0 ? fallbacks : [undefined]) {
        profileStep(entry, fallback);
      }
    }
  };

  const global: ToolPolicyScope = { tools: asRecord(values.tools), path: "tools" };
  const globalProviders = anthropicScopes(global);
  [global, ...globalProviders].forEach(listSteps);
  const roster = Object.entries(asRecord(asRecord(values.agents)?.entries) ?? {});
  if (roster.length === 0) {
    profileStep(undefined, global);
    providerProfileSteps([], globalProviders);
  }
  for (const [key, value] of roster) {
    const entry: ToolPolicyScope = {
      tools: asRecord(asRecord(value)?.tools),
      path: `${keyedSettingPath("agents.entries", key)}.tools`,
    };
    const entryProviders = anthropicScopes(entry);
    [entry, ...entryProviders].forEach(listSteps);
    profileStep(entry, global);
    providerProfileSteps(entryProviders, globalProviders);
  }
}

function configuredRuntime(value: unknown): string | undefined {
  const runtimeValue = asRecord(value)?.agentRuntime;
  if (runtimeValue === undefined) {
    return undefined;
  }
  const runtime = asRecord(runtimeValue);
  if (
    runtime === undefined ||
    typeof runtime.id !== "string" ||
    !SUPPORTED_AGENT_RUNTIME_IDS.has(runtime.id)
  ) {
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

/**
 * The fallback rule of resolveConfiguredHarnessId alone, over every well-formed selection. Every
 * deployment refuses a fallback on another provider, so Configuration save (through
 * requireDeployableRoster), Preset save and Agent save refuse it too, even where another model
 * policy rule leaves the rest to deployment (finding 1298). OpenClaw's `openrouter:auto` and
 * `openrouter:free` count as openrouter references (finding 1320). On a Preset save
 * (`options.unresolved`), a reference whose provider waits on an unfilled variable (no `/` before
 * the first one, as in `openrouter:{{ vars.kind }}`) is checked once filled, on the Configuration
 * a launch creates (finding 1305).
 */
export function requireFallbackProviders(
  values: Readonly<OpenClawConfigurationDocument>,
  { unresolved }: ConfigurationValidationOptions = {},
): void {
  const agents = asRecord(values.agents);
  const selections: [unknown, readonly string[], SelectionMessage][] = [
    [asRecord(agents?.defaults)?.model, ["agents", "defaults", "model"], defaultModelMessage],
  ];
  // An entry without its own model has nothing to check here; skipping it keeps a large roster
  // cheap (finding 1321).
  for (const [key, entry] of Object.entries(asRecord(agents?.entries) ?? {})) {
    const model = asRecord(entry)?.model;
    if (model !== undefined) {
      selections.push([model, ["agents", "entries", key, "model"], entryModelMessage(key)]);
    }
  }
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
  return harnessIdForAgentRuntime(resolveConfiguredAgentRuntimeId(values));
}

/**
 * The agent runtime every candidate selects: `openclaw`, `codex`, or `claude-cli` (Claude Code
 * executing under the embedded OpenClaw Harness). resolveConfiguredHarnessId maps it to the
 * Harness; Compute reads it to prepare the runtime the Gateway spawns.
 */
export function resolveConfiguredAgentRuntimeId(
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
    // Upstream routes `anthropic/<model>` through its Claude Code CLI backend; any other
    // provider has no such backend, so the policy would select a runtime that cannot run.
    if (selected === CLAUDE_CLI_AGENT_RUNTIME_ID && providerId !== "anthropic") {
      throw new ConfigurationHarnessError(
        "The Claude Code agent runtime requires the native anthropic model provider.",
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
  const runtime = [...resolved][0]!;
  if (runtime === CLAUDE_CLI_AGENT_RUNTIME_ID) {
    requireEnforceableClaudeCodeToolPolicy(values);
  }
  return runtime;
}
