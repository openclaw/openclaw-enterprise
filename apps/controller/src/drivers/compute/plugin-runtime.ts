import {
  type AgentRevision,
  assertExecutionAdmission,
  type PluginDesiredState,
  validPluginRevisionState,
  validPluginApprovers,
} from "@openclaw-enterprise/contracts";
import { codexApprovalPolicy } from "@openclaw-enterprise/occ";
import {
  type CodexPublicGithubRead,
  PUBLIC_GITHUB_READ_SKILL,
  publicGithubReadSkill,
} from "../repo/github/public-read/codex.ts";
import { harnessEgressEnrollment, type HarnessEgressEnrollment } from "./egress-enrollment.ts";

export const PLUGIN_RUNTIME_DIRECTORY = "/etc/openclaw/plugin-runtime";
export const PLUGIN_RUNTIME_MANIFEST = "runtime.json";
export const PLUGIN_RUNTIME_CODEX_CONFIG = "config.toml";
export const PLUGIN_RUNTIME_ENVIRONMENT = "OPENCLAW_PLUGIN_RUNTIME_JSON";
export const PLUGIN_RUNTIME_MANIFEST_ENVIRONMENT = "OPENCLAW_PLUGIN_RUNTIME_MANIFEST";
export const PLUGIN_RUNTIME_CODEX_CONFIG_ENVIRONMENT = "OPENCLAW_PLUGIN_CODEX_CONFIG_TOML";
export const PLUGIN_RUNTIME_READY_MARKER_ENVIRONMENT = "OPENCLAW_PLUGIN_READY_MARKER";
export const PLUGIN_RUNTIME_READY_MARKER = "/tmp/openclaw-plugin-runtime-ready";

const MAX_DOCKER_PLUGIN_RUNTIME_BYTES = 64 * 1024;
const CODEX_NO_PLUGIN_FEATURES_TOML = `[features]
apps = false
plugins = false
remote_plugin = false

[apps._default]
enabled = false
`;
const CODEX_SELECTED_PLUGIN_FEATURES_TOML = `[features]
apps = true
plugins = true
remote_plugin = true

[apps._default]
enabled = false
`;
const CODEX_PLUGIN_DEFAULTS_TOML = `
[plugins._default]
enabled = false
`;

export interface CodexRepositoryBrokerNetworkPolicy {
  readonly host: string;
  readonly domains: Readonly<Record<string, "allow" | "deny">>;
}

export interface CodexModelEndpoint {
  readonly baseUrl: string;
  readonly modelProvider: "openai-compatible";
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
      readonly approvalPolicy?: string | undefined;
      readonly pluginApprovers?: AgentRevision["pluginApprovers"];
      readonly repositoryBrokerNetworkPolicy?: CodexRepositoryBrokerNetworkPolicy;
      readonly publicGithubRead?: CodexPublicGithubRead;
      readonly modelEndpoint?: CodexModelEndpoint;
      readonly providerTools?: "none";
      readonly egressEnrollment?: HarnessEgressEnrollment;
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
  openaiBaseUrl?: string,
  publicGithubRead?: CodexPublicGithubRead,
): PluginRuntimeSpec | undefined {
  if (!validPluginApprovers(revision.pluginApprovers)) {
    throw new Error("AgentRevision plugin approvers are invalid.");
  }
  if (revision.harness.id === "codex" && revision.harness.mode === "dedicated") {
    return {
      kind: "codex",
      selections: {},
      approvalPolicy: codexSessionApprovalPolicy(revision),
      ...(revision.egressPlan === undefined
        ? {}
        : {
            providerTools: protectedProviderTools(revision),
            egressEnrollment: harnessEgressEnrollment(revision.egressPlan),
          }),
      ...(revision.pluginApprovers === undefined
        ? {}
        : { pluginApprovers: revision.pluginApprovers }),
      ...(openaiBaseUrl === undefined
        ? {}
        : { modelEndpoint: { baseUrl: openaiBaseUrl, modelProvider: "openai-compatible" } }),
      ...(repositoryBrokerNetworkPolicy === undefined ? {} : { repositoryBrokerNetworkPolicy }),
      ...(publicGithubRead === undefined ? {} : { publicGithubRead }),
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
  openaiBaseUrl?: string,
  publicGithubRead?: CodexPublicGithubRead,
): PluginRuntimeSpec | undefined {
  assertExecutionAdmission(revision);
  if (publicGithubRead !== undefined && revision.executionAdmission.mode !== "unprotected") {
    throw new Error("The public GitHub reader cannot be selected for protected execution.");
  }
  const state = revision.plugins;
  if (state === undefined) {
    return pluginFreeRuntimeForRevision(
      revision,
      repositoryBrokerNetworkPolicy,
      openaiBaseUrl,
      publicGithubRead,
    );
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
          approvalPolicy: codexSessionApprovalPolicy(revision),
          ...(revision.egressPlan === undefined
            ? {}
            : {
                providerTools: protectedProviderTools(revision),
                egressEnrollment: harnessEgressEnrollment(revision.egressPlan),
              }),
          pluginApprovers: revision.pluginApprovers,
          ...(openaiBaseUrl === undefined
            ? {}
            : { modelEndpoint: { baseUrl: openaiBaseUrl, modelProvider: "openai-compatible" } }),
          ...(repositoryBrokerNetworkPolicy === undefined ? {} : { repositoryBrokerNetworkPolicy }),
          ...(publicGithubRead === undefined ? {} : { publicGithubRead }),
        }
      : { kind: "openclaw", selections: state.plugins, pluginApprovers: revision.pluginApprovers };
  validateDriverMatchesRuntime(revision, runtime);
  return runtime;
}

function protectedProviderTools(revision: Readonly<AgentRevision>): "none" {
  const routes = revision.egressPlan?.routes;
  if (
    routes === undefined ||
    routes.some(({ binding: { grant } }) =>
      grant.kind === "inference"
        ? grant.providerTools !== "none"
        : grant.kind !== "prepared_scope" &&
          grant.kind !== "github_repository_metadata" &&
          grant.kind !== "credential_free_repository_metadata",
    )
  ) {
    throw new Error("Unsupported protected inference tool grant.");
  }
  return "none";
}

// The admission rule (codexApprovalPolicy), checked again on the revision being prepared.
function codexSessionApprovalPolicy(revision: Readonly<AgentRevision>): string | undefined {
  return codexApprovalPolicy(
    revision.configuration,
    (setting, requirement) => new Error(`Configuration setting ${setting} ${requirement}.`),
  );
}

function codexToml(
  runtime: Extract<PluginRuntimeSpec, { readonly kind: "codex" }>,
  approvalPolicy: string | undefined,
  pluginDefaults: boolean,
): string {
  const plugins = `${
    Object.keys(runtime.selections).length === 0
      ? CODEX_NO_PLUGIN_FEATURES_TOML
      : CODEX_SELECTED_PLUGIN_FEATURES_TOML
  }${pluginDefaults ? CODEX_PLUGIN_DEFAULTS_TOML : ""}`;
  const configuration =
    (runtime.providerTools === "none" ? 'web_search = "disabled"\n\n' : "") +
    (approvalPolicy === undefined
      ? plugins
      : `approval_policy = ${JSON.stringify(approvalPolicy)}\n\n${plugins}`);
  const endpoint = runtime.modelEndpoint;
  if (
    runtime.providerTools === "none" &&
    runtime.egressEnrollment?.inference === true &&
    endpoint === undefined
  ) {
    throw new Error("Protected inference requires an explicit normalized model endpoint.");
  }
  return endpoint === undefined
    ? configuration
    : `model_provider = ${JSON.stringify(endpoint.modelProvider)}\n\n${configuration}\n[model_providers.${endpoint.modelProvider}]\nname = "OpenAI-compatible"\nbase_url = ${JSON.stringify(endpoint.baseUrl)}\nwire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\n${runtime.providerTools === "none" ? "request_max_retries = 0\nstream_max_retries = 0\n" : ""}`;
}

/**
 * The session policy the pinned Gateway runs for a configured `appServer.approvalPolicy`
 * (see `apps/controller/src/gateway/codex-approval-policy.ts`). Native startup reads it before
 * the Gateway can create a session, so its reviewer checks see the same policy. The Gateway
 * runs `on-failure` as `on-request`; other choices, including incompatible ones that
 * readiness rejects, are kept.
 */
function nativeCodexApprovalPolicy(approvalPolicy: string | undefined): string | undefined {
  return approvalPolicy === "on-failure" ? "on-request" : approvalPolicy;
}

function codexConfigurationToml(runtime: PluginRuntimeSpec): string | undefined {
  return runtime.kind === "codex"
    ? codexToml(runtime, nativeCodexApprovalPolicy(runtime.approvalPolicy), true)
    : undefined;
}

function configMapData(
  runtime: PluginRuntimeSpec,
  codexConfig: string | undefined,
): Readonly<Record<string, string>> {
  return Object.freeze({
    [PLUGIN_RUNTIME_MANIFEST]: JSON.stringify(runtimeManifest(runtime)),
    ...(codexConfig === undefined ? {} : { [PLUGIN_RUNTIME_CODEX_CONFIG]: codexConfig }),
    ...(runtime.kind === "codex" && runtime.publicGithubRead !== undefined
      ? { [PUBLIC_GITHUB_READ_SKILL]: publicGithubReadSkill(runtime.publicGithubRead) }
      : {}),
  });
}

export function pluginRuntimeConfigMapData(
  runtime: PluginRuntimeSpec,
): Readonly<Record<string, string>> {
  return configMapData(runtime, codexConfigurationToml(runtime));
}

/**
 * The complete data earlier controllers rendered for this runtime, when it differs from
 * the current rendering. A revision's plugin-runtime ConfigMap is immutable, so one
 * prepared before a controller upgrade keeps the files its Pods mounted until the Agent
 * is deployed again. Only Codex `config.toml` changed: on 2026-10-09 #508 added the
 * `[plugins._default]` table and #1995 the native `approval_policy`, and on 2026-10-10
 * `on-failure` became `on-request` there.
 * TODO: remove once no Codex revision prepared before that last change can still be active;
 * deploying the Agent again replaces it.
 */
export function pluginRuntimeEarlierConfigMapData(
  runtime: PluginRuntimeSpec,
): readonly Readonly<Record<string, string>>[] {
  if (runtime.kind !== "codex") {
    return [];
  }
  const current = codexConfigurationToml(runtime);
  return [
    codexToml(runtime, runtime.approvalPolicy, true),
    codexToml(runtime, undefined, true),
    codexToml(runtime, undefined, false),
  ]
    .filter((config) => config !== current)
    .map((config) => configMapData(runtime, config));
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
    ...(runtime.kind === "codex" && runtime.egressEnrollment !== undefined
      ? { egressEnrollment: runtime.egressEnrollment }
      : {}),
    ...(runtime.kind === "codex" && runtime.providerTools !== undefined
      ? { providerTools: runtime.providerTools }
      : {}),
    ...(runtime.kind === "codex" && runtime.modelEndpoint !== undefined
      ? { modelEndpoint: runtime.modelEndpoint }
      : {}),
    ...(runtime.pluginApprovers === undefined ? {} : { pluginApprovers: runtime.pluginApprovers }),
    ...(runtime.kind === "codex" && runtime.repositoryBrokerNetworkPolicy !== undefined
      ? { repositoryBrokerNetworkPolicy: runtime.repositoryBrokerNetworkPolicy }
      : {}),
    ...(runtime.kind === "codex" && runtime.publicGithubRead !== undefined
      ? { publicGithubRead: runtime.publicGithubRead }
      : {}),
  };
}
