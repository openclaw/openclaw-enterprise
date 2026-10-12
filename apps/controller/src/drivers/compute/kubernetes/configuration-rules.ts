import type { OpenClawConfigurationDocument } from "@openclaw-enterprise/contracts";
import { keyedSettingPath } from "@openclaw-enterprise/occ";
import { asRecord, splitModelRef } from "@openclaw-enterprise/utils";

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

const IGNORED_CHANNEL_KEYS: readonly string[] = ["defaults", "modelByChannel"];

/**
 * The enabled `channels.<provider>` entries, in Configuration order. Every provider must be
 * one Kubernetes Compute runs (`supported`); a disabled entry is ignored.
 */
export function enabledChannelProviders(
  configuration: Readonly<OpenClawConfigurationDocument>,
  supported: readonly string[],
  createError: SettingError,
): string[] {
  const enabled: string[] = [];
  for (const [provider, channel] of Object.entries(asRecord(configuration.channels) ?? {})) {
    if (IGNORED_CHANNEL_KEYS.includes(provider) || asRecord(channel)?.enabled === false) {
      continue;
    }
    if (!supported.includes(provider)) {
      throw createError(
        keyedSettingPath("channels", provider),
        `is not a supported channel: use ${supported.join(" or ")}, or set its enabled to false`,
      );
    }
    enabled.push(provider);
  }
  return enabled;
}

const HARNESS_BINDING = "model credentials come from the Agent's Harness authentication binding";
// Every OPENAI_*/ANTHROPIC_* name is reserved, credential or not (for example a base URL).
const PROVIDER_ENVIRONMENT =
  "the Agent's Harness authentication binding owns model provider environment";
const MODEL_CREDENTIAL_ENVIRONMENT =
  /^(?:OPENAI_|ANTHROPIC_|CODEX_(?:ACCESS_TOKEN|CHATGPT_WORKSPACE_ID|LOGIN_MODE)$)/i;
const AUTHORIZATION_HEADER = /^(?:authorization|api-key|x-api-key)$/i;

/** Providers of the model references in agents.defaults.model and agents.entries.*.model. */
export function selectedModelProviders(
  configuration: Readonly<OpenClawConfigurationDocument>,
): Set<string> {
  const agents = asRecord(configuration.agents);
  const selections = [
    asRecord(agents?.defaults)?.model,
    ...Object.values(asRecord(agents?.entries) ?? {}).map((entry) => asRecord(entry)?.model),
  ];
  const providers = new Set<string>();
  for (const selection of selections) {
    const value = asRecord(selection);
    const models =
      typeof selection === "string"
        ? [selection]
        : [value?.primary, ...(Array.isArray(value?.fallbacks) ? value.fallbacks : [])];
    for (const model of models) {
      if (typeof model === "string") {
        providers.add(splitModelRef(model).provider);
      }
    }
  }
  return providers;
}

/**
 * Model credentials reach the runtime only through the Agent's Harness authentication binding,
 * on every topology, so the Configuration must not carry its own: no `auth` profiles, no
 * model credential environment variables, and no authorization header on a selected model
 * provider or its models. (The provider apiKey rule depends on the Harness, so it stays in
 * Harness authentication admission.)
 */
export function requireHarnessCredentialBinding(
  configuration: Readonly<OpenClawConfigurationDocument>,
  createError: SettingError,
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
  const providers = asRecord(asRecord(configuration.models)?.providers) ?? {};
  for (const provider of selectedModelProviders(configuration)) {
    const row = asRecord(providers[provider]);
    const path = keyedSettingPath("models.providers", provider);
    const rows: [string, unknown][] = [
      [path, row],
      ...(Array.isArray(row?.models) ? row.models : []).map((model, index): [string, unknown] => [
        `${path}.models.${index}`,
        model,
      ]),
    ];
    for (const [setting, model] of rows) {
      if (
        Object.keys(asRecord(asRecord(model)?.headers) ?? {}).some((name) =>
          AUTHORIZATION_HEADER.test(name),
        )
      ) {
        throw createError(
          `${setting}.headers`,
          `must not set an authorization header: ${HARNESS_BINDING}`,
        );
      }
    }
  }
}

/** The Harness topologies Kubernetes Compute runs. */
export type KubernetesHarnessTopology =
  "embedded OpenClaw" | "Dedicated OpenClaw" | "Dedicated Codex";

// The Harness authentication methods Kubernetes Compute delivers to each topology. What a
// method also needs from the Installation (oauth needs no Sandbox Driver, credential_source
// its paired Sandbox) is checked after this, with a fixed refusal.
const HARNESS_AUTH_METHODS: Readonly<Record<KubernetesHarnessTopology, readonly string[]>> = {
  "embedded OpenClaw": ["api_key"],
  "Dedicated OpenClaw": ["api_key", "credential_source"],
  "Dedicated Codex": ["api_key", "codex_pat", "oauth", "credential_source"],
};

/**
 * The Agent's Harness authentication method must be one Kubernetes Compute delivers to the
 * Agent's Harness topology. The rule depends only on the Agent (its binding and execution mode)
 * and the Configuration's Harness, so Agent save, provisioning and deployment refuse it with
 * the same message. `createError` names an Agent setting, not a Configuration one.
 */
export function requireHarnessAuthMethod(
  topology: KubernetesHarnessTopology,
  method: string,
  createError: SettingError,
): void {
  const accepted = HARNESS_AUTH_METHODS[topology];
  if (!accepted.includes(method)) {
    const list =
      accepted.length === 1
        ? accepted[0]
        : `${accepted.slice(0, -1).join(", ")} or ${accepted.at(-1)}`;
    // Codex runs only dedicated, so its execution mode is not a fix.
    const fix = topology === "Dedicated Codex" ? "harnessAuth" : "harnessAuth or executionMode";
    throw createError(
      "harnessAuth.method",
      `must be ${list} for ${topology} on Kubernetes Compute: change ${fix}`,
    );
  }
}
