import {
  type AgentRevision,
  type PluginDesiredState,
  validPluginRevisionState,
  validPluginApprovers,
} from "@openclaw-enterprise/contracts";

export const PLUGIN_RUNTIME_DIRECTORY = "/etc/openclaw/plugin-runtime";
export const PLUGIN_RUNTIME_MANIFEST = "runtime.json";
export const PLUGIN_RUNTIME_CODEX_CONFIG = "config.toml";
export const PLUGIN_RUNTIME_ENVIRONMENT = "OPENCLAW_PLUGIN_RUNTIME_JSON";
export const PLUGIN_RUNTIME_MANIFEST_ENVIRONMENT = "OPENCLAW_PLUGIN_RUNTIME_MANIFEST";
export const PLUGIN_RUNTIME_CODEX_CONFIG_ENVIRONMENT = "OPENCLAW_PLUGIN_CODEX_CONFIG_TOML";
export const PLUGIN_RUNTIME_READY_MARKER_ENVIRONMENT = "OPENCLAW_PLUGIN_READY_MARKER";
export const PLUGIN_RUNTIME_READY_MARKER = "/tmp/openclaw-plugin-runtime-ready";

const MAX_DOCKER_PLUGIN_RUNTIME_BYTES = 64 * 1024;
const CODEX_NO_PLUGIN_CONFIG_TOML = `[features]
apps = false
plugins = false
remote_plugin = false

[apps._default]
enabled = false
`;
const CODEX_SELECTED_PLUGIN_CONFIG_TOML = `[features]
apps = true
plugins = true
remote_plugin = true

[apps._default]
enabled = false
`;

export interface CodexRepositoryBrokerNetworkPolicy {
  readonly host: string;
  readonly domains: Readonly<Record<string, "allow" | "deny">>;
}

export type PluginRuntimeSpec =
  | {
      readonly kind: "openclaw";
      readonly selections: PluginDesiredState;
      readonly pluginApprovers?: AgentRevision["pluginApprovers"];
    }
  | {
      readonly kind: "codex";
      readonly selections: PluginDesiredState;
      readonly pluginApprovers?: AgentRevision["pluginApprovers"];
      readonly repositoryBrokerNetworkPolicy?: CodexRepositoryBrokerNetworkPolicy;
    };

function validateDriverMatchesRuntime(
  revision: Readonly<AgentRevision>,
  runtime: PluginRuntimeSpec,
): void {
  if (runtime.kind === "codex") {
    if (!(
      (revision.harness.id === "codex" && revision.harness.mode === "dedicated") ||
      (revision.harness.id === "openclaw" && revision.harness.mode === "embedded")
    )) {
      throw new Error(
        "Codex plugin runtime artifacts require a dedicated Codex Harness or embedded OpenClaw Harness.",
      );
    }
    if (revision.plugins?.driver.implementation !== "occ/codex-plugin") {
      throw new Error("Codex plugin runtime artifacts require the Codex PluginDriver.");
    }
    return;
  }
  if (
    revision.harness.id !== "openclaw" ||
    (revision.harness.mode !== "embedded" && revision.harness.mode !== "dedicated")
  ) {
    throw new Error("OpenClaw plugin runtime artifacts require an OpenClaw Harness.");
  }
  if (revision.plugins?.driver.implementation !== "occ/openclaw-plugin") {
    throw new Error("OpenClaw plugin runtime artifacts require the OpenClaw PluginDriver.");
  }
}

function pluginFreeRuntimeForRevision(
  revision: Readonly<AgentRevision>,
  repositoryBrokerNetworkPolicy?: CodexRepositoryBrokerNetworkPolicy,
): PluginRuntimeSpec | undefined {
  if (!validPluginApprovers(revision.pluginApprovers)) {
    throw new Error("AgentRevision plugin approvers are invalid.");
  }
  if (revision.harness.id === "codex" && revision.harness.mode === "dedicated") {
    return {
      kind: "codex",
      selections: {},
      ...(revision.pluginApprovers === undefined
        ? {}
        : { pluginApprovers: revision.pluginApprovers }),
      ...(repositoryBrokerNetworkPolicy === undefined ? {} : { repositoryBrokerNetworkPolicy }),
    };
  }
  if (repositoryBrokerNetworkPolicy !== undefined) {
    throw new Error("Repository credential broker network policy requires Codex plugin runtime.");
  }
  if (
    revision.pluginApprovers !== undefined &&
    revision.harness.id === "openclaw" &&
    (revision.harness.mode === "embedded" || revision.harness.mode === "dedicated")
  ) {
    return { kind: "openclaw", selections: {}, pluginApprovers: revision.pluginApprovers };
  }
  return undefined;
}

export function pluginRuntimeSpecForRevision(
  revision: Readonly<AgentRevision>,
  repositoryBrokerNetworkPolicy?: CodexRepositoryBrokerNetworkPolicy,
): PluginRuntimeSpec | undefined {
  const state = revision.plugins;
  if (state === undefined) {
    return pluginFreeRuntimeForRevision(revision, repositoryBrokerNetworkPolicy);
  }
  if (!validPluginRevisionState(state) || !validPluginApprovers(revision.pluginApprovers)) {
    throw new Error("AgentRevision plugin selections are invalid.");
  }
  if (
    repositoryBrokerNetworkPolicy !== undefined &&
    state.driver.implementation !== "occ/codex-plugin"
  ) {
    throw new Error("Repository credential broker network policy requires the Codex PluginDriver.");
  }
  const runtime: PluginRuntimeSpec =
    state.driver.implementation === "occ/codex-plugin"
      ? {
          kind: "codex",
          selections: state.plugins,
          pluginApprovers: revision.pluginApprovers,
          ...(repositoryBrokerNetworkPolicy === undefined ? {} : { repositoryBrokerNetworkPolicy }),
        }
      : { kind: "openclaw", selections: state.plugins, pluginApprovers: revision.pluginApprovers };
  validateDriverMatchesRuntime(revision, runtime);
  return runtime;
}

function codexConfigurationToml(runtime: PluginRuntimeSpec): string | undefined {
  if (runtime.kind !== "codex") {
    return undefined;
  }
  return Object.keys(runtime.selections).length === 0
    ? CODEX_NO_PLUGIN_CONFIG_TOML
    : CODEX_SELECTED_PLUGIN_CONFIG_TOML;
}

export function pluginRuntimeConfigMapData(
  runtime: PluginRuntimeSpec,
): Readonly<Record<string, string>> {
  const codexConfig = codexConfigurationToml(runtime);
  return Object.freeze({
    [PLUGIN_RUNTIME_MANIFEST]: JSON.stringify(runtimeManifest(runtime)),
    ...(codexConfig === undefined ? {} : { [PLUGIN_RUNTIME_CODEX_CONFIG]: codexConfig }),
  });
}

export function pluginRuntimeEnvironment(
  runtime: PluginRuntimeSpec,
): Readonly<Record<string, string>> {
  const codexConfig = codexConfigurationToml(runtime);
  const manifest = runtimeManifest(runtime);
  const encoded = JSON.stringify({
    manifest,
    ...(codexConfig === undefined ? {} : { codexConfigurationToml: codexConfig }),
  });
  if (Buffer.byteLength(encoded, "utf8") > MAX_DOCKER_PLUGIN_RUNTIME_BYTES) {
    throw new Error("Docker plugin runtime artifacts exceed the environment delivery limit.");
  }
  return { [PLUGIN_RUNTIME_ENVIRONMENT]: encoded };
}

function runtimeManifest(runtime: PluginRuntimeSpec): Readonly<Record<string, unknown>> {
  return {
    kind: runtime.kind,
    selections: runtime.selections,
    ...(runtime.pluginApprovers === undefined ? {} : { pluginApprovers: runtime.pluginApprovers }),
    ...(runtime.kind === "codex" && runtime.repositoryBrokerNetworkPolicy !== undefined
      ? { repositoryBrokerNetworkPolicy: runtime.repositoryBrokerNetworkPolicy }
      : {}),
  };
}
