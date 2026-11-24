// Agent save, provisioning and deploy admission refuse a Configuration plugin setting the Gateway
// entrypoint refuses for an OpenClaw catalog plugin the Agent selects (finding 3091).
// `setting` is plugins.enabled, plugins.deny, plugins.allow or a plugins.entries key as the
// message shows it; `rule` is what it must satisfy; `pluginId` is the selection's key; `step` is
// the fix.
export const managedPluginSettingRefusal = (
  setting: string,
  rule: string,
  pluginId: string,
  step: string,
): string =>
  `Configuration setting ${setting} ${rule} while the Agent selects plugin ${pluginId}, or the Gateway does not start: ${step}.`;
// Configuration save, Agent save and deploy admission refuse a models.providers key that OpenClaw
// applies to another key: one with surrounding whitespace, or another spelling of openai, anthropic
// or codex (finding 3097). `path` is the setting as the message shows it, such as
// models.providers.OpenAI or models.providers[" openai"]; `name` is the key OCE checks.
export const providerKeyVariantRefusal = (path: string, name: string): string =>
  `Configuration setting ${path} must be named ${JSON.stringify(name)}: OpenClaw applies it to that provider's entry, the one OCE checks. Move these settings there if that key exists, else rename this key.`;
// Configuration save, Agent save and deploy admission refuse OpenClaw's $include directive anywhere
// in the document (finding 3078). `path` is the setting as the message shows it, such as $include
// or gateway.auth.$include.
export const configIncludeRefusal = (path: string): string =>
  `Configuration setting ${path} is not supported: OpenClaw would merge settings from another file that OCE does not check. Write those settings in the Configuration instead.`;
// Where the deploying Agent runs neither runtime for the model (an embedded Agent with a
// codex/<model> model, where the Installation approves Codex only for dedicated execution and
// embedded OpenClaw runs no codex/<model> model), deploy names this next step instead of an offer
// (finding 3037). `target` is "it" for one setting, or "both" for two that conflict.
export const noRunnableRuntime = (target: "it" | "both"): string =>
  `set ${target} to codex on a dedicated Agent, or select a model of another provider`;
export const runtimeIdRequiredNextStep = (policy: string): string =>
  `Configuration setting ${policy}.agentRuntime.id is required for the selected model: ${noRunnableRuntime("it")}.`;
// Deploy, and Agent save given the deploy route's Harness resolver, of an embedded Agent whose
// Configuration selects the Codex Harness, which the Installation approves only for dedicated
// execution.
export const CODEX_NEEDS_DEDICATED =
  "The Configuration selects the Codex Harness, which needs dedicated execution; this Agent uses embedded execution. Change the Agent's execution mode or its Configuration.";
export const runtimeOfOtherModels = (runtime: "openclaw" | "codex"): string =>
  `${runtime}, the runtime the other selected models use`;
export const BOTH_RUNTIMES = "set both to openclaw or both to codex, or remove one";
export const CODEX_MODEL_ONLY = "select a codex/<model> model";
export const selectableModelsNotObject = (parent: string): string =>
  `Configuration setting ${parent} must be an object keyed by model ref, such as {"openai/gpt-5.1": {"agentRuntime": {"id": "openclaw"}}}.`;
// `offer` as for runtimeIdRequired, or the runtime other settings or the listed models select.
export const selectablePrimaryRuntimeRequired = (primaryPolicy: string, offer: string): string =>
  `Configuration setting ${primaryPolicy}.agentRuntime.id is required when other models are listed beside the primary model: set it to ${offer}.`;
export const selectablePrimaryRuntimeNextStep = (primaryPolicy: string): string =>
  `Configuration setting ${primaryPolicy}.agentRuntime.id is required when other models are listed beside the primary model: ${noRunnableRuntime("it")}.`;
export const runtimeOfPrimaryElsewhere = (runtime: "openclaw" | "codex"): string =>
  `${runtime}, the runtime other settings select for the primary model`;
export const runtimeOfListedModels = (runtime: "openclaw" | "codex"): string =>
  `${runtime}, the runtime the listed models use`;
export const runtimeOfEntries = (runtime: "openclaw" | "codex"): string =>
  `${runtime}, the runtime agents.entries select for the model`;
export const selectableModelRuntimeMismatch = (
  policy: string,
  runtime: "openclaw" | "codex",
): string =>
  `Configuration setting ${policy}.agentRuntime.id must be ${runtime}, the primary model's runtime: set it, or remove the model.`;
// A version record with no recorded startup failure (agents/deployment-evidence.mts).
export const NO_PERSISTED_STARTUP_FAILURE = "No persisted startup failure.";
// Diagnostics hints (agents/deployment-diagnostics.mts): the runtime did not answer, and the
// version's recorded failure to resolve first.
export const DIAGNOSTICS_RUNTIME_UNAVAILABLE =
  "UNAVAILABLE means the runtime did not answer, so these checks could not run. The gateway is usually stopped, still starting, or failed to start.";
export const diagnosticsRecordedFailure = (code: string): string =>
  `This version's recorded deployment failed with ${code}; resolve that first. These checks do not test model credentials, so they cannot confirm or clear that failure.`;
// `source` is the requested log source, or "such" when none is known.
export const runtimeLogSourceUnavailable = (source: "agent" | "sandbox" | "such"): string =>
  `This Agent version has no ${source} log source. Every version has gateway; only a Dedicated Agent has agent, and only a version deployed with a Sandbox Driver has sandbox.`;
