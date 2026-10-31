import {
  type ConfigurationValidationOptions,
  isAllowedSecretBindingDestination,
  type OpenClawConfigurationDocument,
} from "@openclaw-enterprise/contracts";
import {
  enabledChannelEntries,
  invalidHeaderNameRequirement,
  isAdmittedHeaderName,
  isCredentialHeaderName,
  keyedSettingPath,
  PROVIDER_MODELS_LIST,
  quotedSettingKey,
  secretInputShorthandName,
  wholeEnvironmentReferenceName,
} from "@openclaw-enterprise/occ";
import { asRecord, splitModelRef } from "@openclaw-enterprise/utils";
import type { HarnessAuthMethodRule } from "../harness-auth-method.ts";

/**
 * Kubernetes Compute rules on the caller's own Configuration that preparation or the Gateway
 * entrypoint would otherwise apply only after a dedicated deployment stopped its predecessors
 * (`requiresStoppedPredecessors`; nothing rolls back). Deployment admission and provisioning
 * (`validateHarnessAuth`, `kubernetesGatewayConfigurationDocument`) and preparation call the
 * same functions, so the refusal names the setting while the running revision still serves.
 * Each error names the setting and what is accepted, never the submitted value.
 *
 * Rules that hold on every topology (`validateConfiguration`) also run when a Configuration is
 * saved, provisioned or set as Preset defaults, so they refuse the content where it is written.
 */
type SettingError = (setting: string, requirement: string) => Error;

export const OPENCLAW_GATEWAY_PASSWORD = "OPENCLAW_GATEWAY_PASSWORD";

/**
 * Whether `gateway.auth` uses the Gateway password Compute generates. Any other password,
 * a literal or another environment variable, is refused: the Gateway reads only
 * OPENCLAW_GATEWAY_PASSWORD from its transport Secret.
 */
export function usesGatewayPasswordEnvironment(
  auth: Readonly<Record<string, unknown>>,
  createError: SettingError,
): boolean {
  if (auth.password === undefined) {
    return false;
  }
  const reference = asRecord(auth.password);
  if (reference?.source !== "env" || reference.id !== OPENCLAW_GATEWAY_PASSWORD) {
    throw createError(
      "gateway.auth.password",
      `must be the environment reference {source: "env", id: "${OPENCLAW_GATEWAY_PASSWORD}"}, whose value Kubernetes Compute generates`,
    );
  }
  return true;
}

/**
 * A Gateway that hosts the Agent's workspace node needs the file-transfer plugin. The Gateway
 * entrypoint keeps its own copy of this rule (`requireWorkspaceNodePlugins` in
 * runtime-entrypoints.ts) and exits on it at every start; a parity test pins the two. A
 * `plugins.deny` that is not a list also stops that copy (or the Gateway's own schema).
 */
export function requireWorkspaceNodePlugins(
  configuration: Readonly<OpenClawConfigurationDocument>,
  createError: SettingError,
): void {
  const plugins = asRecord(configuration.plugins);
  const deny = plugins?.deny;
  if (deny !== undefined && deny !== null && !Array.isArray(deny)) {
    throw createError("plugins.deny", "must be a list");
  }
  const requirement = "the Agent's workspace node requires the file-transfer plugin";
  if (Array.isArray(deny) && deny.includes("file-transfer")) {
    throw createError("plugins.deny", `must not list file-transfer: ${requirement}`);
  }
  if (asRecord(asRecord(plugins?.entries)?.["file-transfer"])?.enabled === false) {
    throw createError("plugins.entries.file-transfer.enabled", `must not be false: ${requirement}`);
  }
}

/**
 * Enabled channels need a dedicated Agent workload and an Installation channel runtime
 * (`runtime.channels`: isolated credentials and a reviewed proxy). `providers` lists the
 * enabled channel providers, in Configuration order.
 */
export function requireChannelTopology(
  providers: readonly string[],
  topology: { readonly embedded: boolean; readonly channelRuntime: boolean },
  createError: SettingError,
): void {
  const [provider] = providers;
  if (provider === undefined) {
    return;
  }
  if (topology.embedded) {
    throw createError(
      `channels.${provider}`,
      "is enabled, but channels require a dedicated Agent workload",
    );
  }
  if (!topology.channelRuntime) {
    throw createError(
      `channels.${provider}`,
      "is enabled, but this Installation has no channel runtime: enabled channels require isolated credentials and a reviewed proxy",
    );
  }
}

// Kubernetes Compute sets the APP_SERVER_ variables only in a Dedicated Codex Gateway, and a
// Secret binding cannot target them (a reserved prefix).
const CODEX_APP_SERVER_VARIABLE = /^APP_SERVER_/i;

/**
 * The plugin secret inputs that stop the OpenClaw Gateway at startup when their reference is
 * unset, for each plugin the runtime image ships with any: the `configContracts.secretInputs`
 * paths without an `ownerKind` in `extensions/<id>/openclaw.plugin.json` at the commit in
 * `deploy/runtime/openclaw-source.json` (`*` matches each key). OpenClaw resolves those for no
 * runtime owner and ends startup with "required secrets are unavailable". An input with an
 * `ownerKind` (beam, imap) only makes its owner unavailable, and the Gateway skips an entry for a
 * plugin the image does not ship. Update this list when that pin or the image's plugins change.
 */
const GATEWAY_REQUIRED_PLUGIN_SECRET_INPUTS: Readonly<
  Record<string, readonly (readonly string[])[]>
> = {
  codex: [
    ["appServer", "authToken"],
    ["appServer", "headers", "*"],
  ],
  google: [["webSearch", "headers", "*"]],
};

// Variables an embedded Gateway may receive without a binding that a Secret binding may also name:
// the Pod's HOSTNAME, the image's YARN_VERSION, Compute's repository broker GIT_SSL_CAINFO and
// Kubernetes service links.
const RUNTIME_VARIABLE =
  /^(?:HOSTNAME|YARN_VERSION|GIT_SSL_CAINFO)$|_SERVICE_(?:HOST|PORT)(?:_|$)|_PORT(?:_|$)/;

// The variable a secret-input value reads as an environment SecretRef, if any: a whole `${NAME}`
// with no fallback, the `$NAME` shorthand or an env SecretRef object. OpenClaw keeps a reference
// inside other text as written, and a fallback replaces an unset name, so neither stops it.
function secretInputVariable(value: unknown): string | undefined {
  const reference = asRecord(value);
  const name =
    typeof value === "string"
      ? (wholeEnvironmentReferenceName(value) ?? secretInputShorthandName(value))
      : reference?.source === "env"
        ? reference.id
        : undefined;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

// Each value at `keys` below `value`, with its setting path; `*` matches every key of an object.
function settingValues(
  value: unknown,
  keys: readonly string[],
  path: string,
): (readonly [string, unknown])[] {
  if (keys.length === 0) {
    return [[path, value]];
  }
  const record = asRecord(value);
  const [key, ...rest] = keys;
  if (record === undefined) {
    return [];
  }
  return (key === "*" ? Object.keys(record) : [key!])
    .filter((name) => Object.hasOwn(record, name))
    .flatMap((name) => settingValues(record[name], rest, keyedSettingPath(path, name)));
}

/**
 * An embedded Gateway starts only if every Gateway-required secret input of an active plugin
 * (`GATEWAY_REQUIRED_PLUGIN_SECRET_INPUTS`) resolves; otherwise it exits at every start and the
 * deployment waits for its convergence deadline (findings 3040, 3041). Refuses the first such
 * reference to a variable the Gateway would lack: an APP_SERVER_ variable, which only a Dedicated
 * Codex Gateway receives, and, when `bound` is given, a name a Secret binding could set but
 * `bound` says nothing sets. `bound` answers for the Configuration's bindings and what the
 * Installation adds at launch; Agent save, which knows neither, passes none. Other reserved names
 * pass: Compute or the image may set them. OpenClaw skips the secret inputs of an entry whose
 * `enabled` is false, of a denied plugin and of `plugins.enabled: false`, and so does this rule.
 */
export function requireEmbeddedPluginSecretInputs(
  configuration: Readonly<OpenClawConfigurationDocument>,
  bound: ((name: string) => boolean) | undefined,
  createError: SettingError,
): void {
  const plugins = asRecord(configuration.plugins);
  const entries = asRecord(plugins?.entries);
  if (plugins?.enabled === false || entries === undefined) {
    return;
  }
  // OpenClaw matches plugin IDs in entries and deny trimmed and lowercased.
  const policyId = (name: unknown): string | undefined =>
    typeof name === "string" ? name.trim().toLowerCase() : undefined;
  const denied = Array.isArray(plugins?.deny) ? plugins.deny.map(policyId) : [];
  for (const [key, value] of Object.entries(entries)) {
    const id = policyId(key)!;
    const entry = asRecord(value);
    if (
      !Object.hasOwn(GATEWAY_REQUIRED_PLUGIN_SECRET_INPUTS, id) ||
      entry === undefined ||
      entry.enabled === false ||
      denied.includes(id)
    ) {
      continue;
    }
    const path = keyedSettingPath("plugins.entries", key);
    const disable = `remove ${path} or set its enabled to false`;
    for (const [setting, value] of GATEWAY_REQUIRED_PLUGIN_SECRET_INPUTS[id]!.flatMap((keys) =>
      settingValues(entry.config, keys, `${path}.config`),
    )) {
      const name = secretInputVariable(value);
      if (name === undefined) {
        continue;
      }
      const shown = /^[A-Za-z0-9_]{1,32}$/.test(name) ? name : quotedSettingKey(name, 32);
      if (CODEX_APP_SERVER_VARIABLE.test(name)) {
        throw createError(
          setting,
          `references ${shown}, which only a Dedicated Codex Agent receives: on an embedded Agent, ${disable}`,
        );
      }
      if (
        bound !== undefined &&
        isAllowedSecretBindingDestination(name) &&
        !RUNTIME_VARIABLE.test(name) &&
        !bound(name)
      ) {
        throw createError(
          setting,
          `references ${shown} without a Configuration Secret binding: bind ${shown} in secretBindings, or ${disable}`,
        );
      }
    }
  }
}

/**
 * The enabled `channels.<provider>` entries, in Configuration order (enabledChannelEntries).
 * Every provider must be one Kubernetes Compute runs (`supported`).
 */
export function enabledChannelProviders(
  configuration: Readonly<OpenClawConfigurationDocument>,
  supported: readonly string[],
  createError: SettingError,
): string[] {
  const enabled = enabledChannelEntries(configuration);
  for (const provider of enabled) {
    if (!supported.includes(provider)) {
      throw createError(
        keyedSettingPath("channels", provider),
        `is not a supported channel: use ${supported.join(" or ")}, or set its enabled to false`,
      );
    }
  }
  return enabled;
}

const HARNESS_BINDING = "model credentials come from the Agent's Harness authentication binding";
// Every OPENAI_*/ANTHROPIC_* name is reserved, credential or not (for example a base URL).
const PROVIDER_ENVIRONMENT =
  "the Agent's Harness authentication binding owns model provider environment";
const MODEL_CREDENTIAL_ENVIRONMENT =
  /^(?:OPENAI_|ANTHROPIC_|OCE_MODEL_API_KEY$|CODEX_(?:ACCESS_TOKEN|CHATGPT_WORKSPACE_ID|LOGIN_MODE)$)/i;
// The refusal names the header, so it explains itself whatever word the rule matched; never its
// value. A header name is not a secret. A long one is cut so the message fits its cap.
const credentialHeaderRequirement = (name: string): string =>
  `must not set the credential header ${quotedSettingKey(name, 40)} (its name marks a credential): ${HARNESS_BINDING}`;

/** A location in the Configuration document, as `options.unresolved` takes it. */
type SettingLocation = readonly (string | number)[];

/** A model selection OpenClaw honors: the setting that holds it and its value as written. */
interface ModelSelection {
  readonly setting: string;
  /** Where the reference sits (a `models` policy key: the path ends in the key). */
  readonly path: SettingLocation;
  readonly reference: unknown;
  /**
   * A model policy selector, which may name a wildcard or an alias: a key of an `agents.*.models`
   * policy map (`key`, alias targets and the older allowlist) or an entry of
   * `agents.*.modelPolicy.allow` (`allow`, the explicit allowlist for `/model`, session
   * overrides and `--model`).
   */
  readonly policy?: "key" | "allow";
  /**
   * The media or voice setting that holds it: OpenClaw calls these models directly as fixed
   * capability references, not as chat models.
   */
  readonly capability?: string;
}

/**
 * The reference that replaces `reference`; `policy` marks a model policy selector. Media and
 * voice models are never passed: Dedicated Codex, the one caller, refuses them.
 */
export type ModelSelectionRewrite = (reference: string, policy: boolean) => string;

// Settings under agents.defaults and each agents.entries entry that select a model in the pinned
// OpenClaw Gateway's config schema. The Gateway refuses the ones an entry does not accept.
const AGENT_MODEL_SETTINGS: readonly (readonly string[])[] = [
  ["model"],
  ["utilityModel"],
  ["decisionModel"],
  ["imageModel"],
  ["pdfModel"],
  ["subagents", "model"],
  ["heartbeat", "model"],
  ["compaction", "model"],
  ["tools", "exec", "reviewer", "model"],
  ["tts", "summaryModel"],
];
// Media and voice models: OpenClaw calls them directly as fixed capability references
// (generation, speech, transcription), not through the chat model catalog.
const AGENT_CAPABILITY_MODEL_SETTINGS: readonly (readonly string[])[] = [
  ["voiceModel"],
  ["mediaModels", "image"],
  ["mediaModels", "video"],
  ["mediaModels", "music"],
];
const ROOT_MODEL_SETTINGS: readonly (readonly string[])[] = [
  ["tools", "exec", "reviewer", "model"],
  ["tts", "summaryModel"],
  ["hooks", "gmail", "model"],
];

// The keys of an agents.defaults or agents.entries entry under which a model setting sits.
const SCOPE_MODEL_KEYS: ReadonlySet<string> = new Set([
  ...[...AGENT_MODEL_SETTINGS, ...AGENT_CAPABILITY_MODEL_SETTINGS].map(([key]) => key!),
  "models",
  "modelPolicy",
]);

/** Where a selection sits in the document, so a projection can replace it. */
type Assign = (value: unknown) => void;

/**
 * Every model selection in the Configuration: the agents.defaults and agents.entries.* model
 * settings (model, subagents, image, PDF, voice, media, utility, decision, heartbeat,
 * compaction, reviewer and TTS summary models), their `models` policy keys and
 * `modelPolicy.allow` entries, hook models and channels.modelByChannel. A primary/fallbacks
 * object yields its primary and each fallback; a value of another shape is yielded as written,
 * so a rule can refuse it by name.
 *
 * With `rewrite`, each string reference except a media or voice model is also replaced in place
 * by what `rewrite` returns (a policy map keeps its key order); other values are left as written.
 */
function modelSelections(
  configuration: Readonly<OpenClawConfigurationDocument>,
  rewrite?: ModelSelectionRewrite,
): ModelSelection[] {
  const selections: ModelSelection[] = [];
  // The reference that replaces a string one `rewrite` changes; undefined keeps the value.
  const visit = (selection: ModelSelection): string | undefined => {
    selections.push(selection);
    if (
      rewrite === undefined ||
      typeof selection.reference !== "string" ||
      selection.capability !== undefined
    ) {
      return undefined;
    }
    const next = rewrite(selection.reference, selection.policy !== undefined);
    return next === selection.reference ? undefined : next;
  };
  const add = (
    setting: string,
    at: SettingLocation,
    value: unknown,
    assign: Assign,
    capability?: string,
  ): void => {
    if (value === undefined || value === null) {
      return;
    }
    const kind = capability === undefined ? {} : { capability };
    const selection = asRecord(value);
    if (typeof value === "string" || selection === undefined) {
      const next = visit({ setting, path: at, reference: value, ...kind });
      if (next !== undefined) {
        assign(next);
      }
      return;
    }
    if (selection.primary !== undefined) {
      const next = visit({
        setting: `${setting}.primary`,
        path: [...at, "primary"],
        reference: selection.primary,
        ...kind,
      });
      if (next !== undefined) {
        selection.primary = next;
      }
    }
    const fallbacks = selection.fallbacks;
    if (Array.isArray(fallbacks)) {
      const next = fallbacks.map((reference: unknown, index) =>
        reference === undefined
          ? undefined
          : visit({
              setting: `${setting}.fallbacks`,
              path: [...at, "fallbacks", index],
              reference,
              ...kind,
            }),
      );
      if (next.some((reference) => reference !== undefined)) {
        selection.fallbacks = fallbacks.map(
          (reference: unknown, index) => next[index] ?? reference,
        );
      }
    } else if (fallbacks !== undefined) {
      // Fallbacks that are not a list are yielded as null: no list item is a reference.
      visit({
        setting: `${setting}.fallbacks`,
        path: [...at, "fallbacks"],
        reference: null,
        ...kind,
      });
    }
  };
  const addAt = (
    path: string,
    at: SettingLocation,
    record: Record<string, unknown> | undefined,
    keys: readonly string[],
    capability = false,
  ) => {
    // The object that holds the setting. An absent setting yields nothing (`add`): it is skipped
    // before its names are built, so a large roster of Agents without it stays cheap (finding
    // 1321).
    let parent = asRecord(record);
    for (let index = 0; parent !== undefined && index < keys.length - 1; index += 1) {
      parent = asRecord(parent[keys[index]!]);
    }
    const owner = parent;
    const key = keys[keys.length - 1];
    const value = key === undefined ? undefined : owner?.[key];
    if (owner !== undefined && key !== undefined && value !== undefined && value !== null) {
      const setting = [path, ...keys].filter(Boolean).join(".");
      add(
        setting,
        [...at, ...keys],
        value,
        (next) => {
          owner[key] = next;
        },
        capability ? setting : undefined,
      );
    }
  };
  // The model settings of agents.defaults or one agents.entries entry, `scope`. A key read here
  // belongs in SCOPE_MODEL_KEYS, or an entry that holds only it is skipped.
  const addScope = (path: string, at: SettingLocation, scope: Record<string, unknown>): void => {
    for (const keys of AGENT_MODEL_SETTINGS) {
      addAt(path, at, scope, keys);
    }
    for (const keys of AGENT_CAPABILITY_MODEL_SETTINGS) {
      addAt(path, at, scope, keys, true);
    }
    const policies = asRecord(scope.models);
    if (policies !== undefined) {
      const keys = Object.keys(policies);
      const next = keys.map((reference) =>
        visit({
          setting: `${path}.models`,
          path: [...at, "models", reference],
          reference,
          policy: "key",
        }),
      );
      if (next.some((reference) => reference !== undefined)) {
        scope.models = Object.fromEntries(
          keys.map((key, index) => [next[index] ?? key, policies[key]]),
        );
      }
    }
    // OpenClaw's explicit allowlist for /model, session overrides and --model (finding 1306).
    const modelPolicy = asRecord(scope.modelPolicy);
    const allow = modelPolicy?.allow;
    const allowSetting = `${path}.modelPolicy.allow`;
    const allowAt = [...at, "modelPolicy", "allow"];
    if (Array.isArray(allow)) {
      const next = allow.map((reference: unknown, index) =>
        visit({ setting: allowSetting, path: [...allowAt, index], reference, policy: "allow" }),
      );
      if (modelPolicy !== undefined && next.some((reference) => reference !== undefined)) {
        modelPolicy.allow = allow.map((reference: unknown, index) => next[index] ?? reference);
      }
    } else if (allow !== undefined) {
      // An allowlist that is not a list is yielded as null, as fallbacks are.
      visit({ setting: allowSetting, path: allowAt, reference: null, policy: "allow" });
    }
  };
  const agents = asRecord(configuration.agents);
  const defaults = asRecord(agents?.defaults);
  if (defaults !== undefined) {
    addScope("agents.defaults", ["agents", "defaults"], defaults);
  }
  for (const [id, entry] of Object.entries(asRecord(agents?.entries) ?? {})) {
    const scope = asRecord(entry);
    // An entry that holds no model setting yields nothing. It is skipped before its names are
    // built, so a large roster of Agents without one stays cheap (finding 1321).
    if (scope !== undefined && Object.keys(scope).some((key) => SCOPE_MODEL_KEYS.has(key))) {
      addScope(keyedSettingPath("agents.entries", id), ["agents", "entries", id], scope);
    }
  }
  const root = configuration as Record<string, unknown>;
  for (const keys of ROOT_MODEL_SETTINGS) {
    addAt("", [], root, keys);
  }
  const mappings = asRecord(configuration.hooks)?.mappings;
  (Array.isArray(mappings) ? mappings : []).forEach((mapping, index) => {
    const record = asRecord(mapping);
    if (record !== undefined) {
      const at = ["hooks", "mappings", index, "model"];
      add(`hooks.mappings.${index}.model`, at, record.model, (value) => {
        record.model = value;
      });
    }
  });
  const byChannel = asRecord(asRecord(configuration.channels)?.modelByChannel) ?? {};
  for (const [channel, value] of Object.entries(byChannel)) {
    const path = keyedSettingPath("channels.modelByChannel", channel);
    const models = asRecord(value);
    if (models === undefined) {
      continue;
    }
    for (const [key, model] of Object.entries(models)) {
      add(path, ["channels", "modelByChannel", channel, key], model, (next) => {
        models[key] = next;
      });
    }
  }
  return selections;
}

/**
 * Replace, in place, every model selection `requireSelectedModelProvider` checks with what
 * `rewrite` returns, so a projection of the admitted document covers the same settings.
 */
export function rewriteModelSelections(
  configuration: OpenClawConfigurationDocument,
  rewrite: ModelSelectionRewrite,
): void {
  modelSelections(configuration, rewrite);
}

/**
 * Whether the provider of the model reference at `path` (a policy key: `key`) waits on an
 * unfilled Preset variable: no `/` precedes the first one.
 */
export function providerWaitsOnVariable(
  options: ConfigurationValidationOptions | undefined,
  path: SettingLocation,
  key = false,
): boolean {
  const literals = options?.unresolved?.(path, key);
  return literals !== undefined && !literals[0]?.includes("/");
}

/**
 * Every model selection names `provider`, the one the Agent's Harness authentication binding
 * serves (finding 1291): a reference elsewhere would make the Gateway request another provider
 * directly. OpenClaw's `openrouter:auto` and `openrouter:free` name the openrouter provider
 * (`splitModelRef`, finding 1310). Any other bare name passes: OpenClaw resolves it through an
 * alias on a policy key checked here, or to a configured provider's model, whose apiKey Harness
 * admission refuses. On `dedicatedCodex`, which qualifies each policy selector (`models` keys and
 * `modelPolicy.allow` entries), a selector must be provider/model, and media and voice models are
 * refused: OpenClaw calls them directly as capability references, and Codex serves only chat
 * models (finding 1306). Refusals name the setting, never the reference. On a Preset save
 * (`options.unresolved`), a reference whose provider waits on an unfilled variable is checked
 * once filled, on the Configuration a launch creates; one whose provider is written is checked
 * here.
 */
export function requireSelectedModelProvider(
  configuration: Readonly<OpenClawConfigurationDocument>,
  provider: string,
  dedicatedCodex: boolean,
  createError: SettingError,
  options?: ConfigurationValidationOptions,
): void {
  const requirement = `${provider}/<model>, the provider of the Agent's Harness authentication binding`;
  for (const { setting, path, reference, policy, capability } of modelSelections(configuration)) {
    // An empty value selects nothing, as an empty selection elsewhere.
    if (dedicatedCodex && capability !== undefined && reference !== "") {
      throw createError(
        capability,
        "must be unset: Dedicated Codex serves chat models only, not media or voice models",
      );
    }
    // A number or boolean variable that is the whole reference fills it with no string, which
    // every launch refuses (as finding 1257 for a baseUrl). A key is always text.
    const type = policy === "key" ? undefined : options?.unresolvedType?.(path);
    if (typeof reference !== "string" || (type !== undefined && type !== "string")) {
      throw createError(setting, "must be provider/model references");
    }
    if (providerWaitsOnVariable(options, path, policy === "key")) {
      continue;
    }
    const { provider: selected, id } = splitModelRef(reference);
    if (id === undefined && !(policy !== undefined && dedicatedCodex)) {
      continue;
    }
    if (id === undefined || selected !== provider || id === "") {
      throw createError(
        setting,
        policy === "key" ? `keys must select ${requirement}` : `must select ${requirement}`,
      );
    }
  }
}

/**
 * Model credentials reach the runtime only through the Agent's Harness authentication binding,
 * on every topology, so the Configuration must not carry its own: no `auth` profiles, no
 * model credential environment variables, and on any model provider or its models no
 * credential header (in `headers` or `request.headers`) and no `request.auth` credential.
 * Header names must be valid HTTP field names, so a lookalike cannot slip past the match; on a
 * Preset save, a name that waits on an unfilled variable (`options.unresolved`) is checked with a
 * stand-in for it, matched as a credential header as the text around it, and checked again once
 * filled, as on every Compute. (The provider apiKey rule depends on the Harness the model policy
 * selects; validateConfiguration and Harness authentication admission run it, on every provider.)
 */
export function requireHarnessCredentialBinding(
  configuration: Readonly<OpenClawConfigurationDocument>,
  createError: SettingError,
  options?: ConfigurationValidationOptions,
): void {
  if (Object.keys(asRecord(configuration.auth) ?? {}).length > 0) {
    throw createError("auth", `must be empty: ${HARNESS_BINDING}`);
  }
  const env = asRecord(configuration.env);
  for (const [parent, values] of [
    ["env", env],
    ["env.vars", asRecord(env?.vars)],
  ] as const) {
    const name = Object.keys(values ?? {}).find((key) => MODEL_CREDENTIAL_ENVIRONMENT.test(key));
    if (name !== undefined) {
      throw createError(keyedSettingPath(parent, name), `must not be set: ${PROVIDER_ENVIRONMENT}`);
    }
  }
  for (const [provider, value] of Object.entries(
    asRecord(asRecord(configuration.models)?.providers) ?? {},
  )) {
    const row = asRecord(value);
    const path = keyedSettingPath("models.providers", provider);
    // A record of model rows would hide their headers from this walk; OpenClaw accepts only a
    // list, and Configuration writes refuse anything else with the same message.
    if (row?.models !== undefined && !Array.isArray(row.models)) {
      throw createError(`${path}.models`, PROVIDER_MODELS_LIST);
    }
    const at = ["models", "providers", provider];
    const rows: [string, readonly (string | number)[], unknown][] = [
      [path, at, row],
      ...(Array.isArray(row?.models) ? row.models : []).map(
        (model, index): [string, readonly (string | number)[], unknown] => [
          `${path}.models.${index}`,
          [...at, "models", index],
          model,
        ],
      ),
    ];
    for (const [setting, modelAt, model] of rows) {
      const request = asRecord(asRecord(model)?.request);
      for (const [headersSetting, headersAt, headers] of [
        [`${setting}.headers`, [...modelAt, "headers"], asRecord(model)?.headers],
        [`${setting}.request.headers`, [...modelAt, "request", "headers"], request?.headers],
      ] as const) {
        for (const name of Object.keys(asRecord(headers) ?? {})) {
          if (!isAdmittedHeaderName(name, options, headersAt)) {
            throw createError(
              headersSetting,
              invalidHeaderNameRequirement(name, options?.unresolved?.([...headersAt, name], true)),
            );
          }
          if (isCredentialHeaderName(name, options, headersAt)) {
            throw createError(headersSetting, credentialHeaderRequirement(name));
          }
        }
      }
      // OpenClaw's request.auth modes authorization-bearer and header carry a credential;
      // provider-default keeps the provider's own authentication, which the binding supplies.
      const auth = asRecord(request?.auth);
      if (
        request?.auth !== undefined &&
        !(auth?.mode === "provider-default" && Object.keys(auth).length === 1)
      ) {
        throw createError(
          `${setting}.request.auth`,
          `must be unset or {mode: "provider-default"}: ${HARNESS_BINDING}`,
        );
      }
    }
  }
}

/** The Harness topologies Kubernetes Compute runs. */
export type KubernetesHarnessTopology =
  "embedded OpenClaw" | "Dedicated OpenClaw" | "Dedicated Codex";

// The Harness authentication methods Kubernetes Compute delivers to each topology. What a
// method also needs from the Installation (credential_source needs its paired Sandbox)
// is checked after this, with a fixed refusal.
const HARNESS_AUTH_METHODS: Readonly<Record<KubernetesHarnessTopology, readonly string[]>> = {
  "embedded OpenClaw": ["api_key"],
  "Dedicated OpenClaw": ["api_key", "credential_source"],
  "Dedicated Codex": ["api_key", "codex_pat", "credential_source"],
};

/** The `requireHarnessAuthMethod` rule for an Agent's topology on Kubernetes Compute. */
export function kubernetesHarnessAuthMethods(
  topology: KubernetesHarnessTopology,
): HarnessAuthMethodRule {
  return {
    compute: "Kubernetes Compute",
    topology,
    accepted: HARNESS_AUTH_METHODS[topology],
    // Codex runs only dedicated, so its execution mode is not a fix.
    fix: topology === "Dedicated Codex" ? "harnessAuth" : "harnessAuth or executionMode",
  };
}
