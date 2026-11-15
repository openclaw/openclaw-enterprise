import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createRequire } from "node:module";
import vm from "node:vm";
import {
  type KubernetesComputeDriverOptions,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  admitLoggingConfiguration,
  type Agent,
  type AgentRevision,
  type ComputeRevisionContext,
  type HarnessAuthSnapshot,
  type Namespace,
  type OpenClawConfigurationValue,
  type PluginDesiredSelection,
  type PluginDesiredState,
  type PluginRevisionState,
} from "../../packages/contracts/src/index.ts";
import { readOpenclawSource } from "../../scripts/lib/openclaw-source.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { conformanceKubernetesOptions } from "../helpers/kubernetes-compute.mjs";
import { waitForResult } from "../helpers/wait-for.mjs";

export const CODEX_ASANA_NATIVE_ID = "asana@openai-curated-remote";
const PLUGIN_APP_SERVER_TOKEN_DOMAIN = "openclaw-plugin-runtime/app-server-token/v1";
export const nodeRequire: (specifier: string) => unknown = createRequire(import.meta.url);
export const gatewayRuntimeProvenance = JSON.stringify({
  source: "https://github.com/openclaw/openclaw",
  commit: (await readOpenclawSource()).commit,
});

export function plain(value: unknown): unknown {
  return parseJson(JSON.stringify(value));
}

export function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function shortHash(value: string) {
  return sha256(value).slice(0, 12);
}

export function pluginAppServerToken(baseToken: string, revisionId: string, startupId: string) {
  return createHmac("sha256", baseToken)
    .update(PLUGIN_APP_SERVER_TOKEN_DOMAIN)
    .update("\0")
    .update(revisionId)
    .update("\0")
    .update(startupId)
    .digest("hex");
}

export function waitForCondition<T>(
  description: string,
  condition: () => T | false | undefined | PromiseLike<T | false | undefined>,
  timeoutMs = 1_000,
): Promise<T> {
  return waitForResult(description, condition, { timeoutMs, intervalMs: 10 });
}

export const tenant: Namespace = {
  id: "ns_00000000-0000-4000-8000-000000000016",
  name: "Plugin compute tenant",
  status: "ready",
  createdAt: "2026-09-08T00:00:00.000Z",
};

export const agent: Agent = Object.freeze({
  id: "agent-plugin-compute",
  namespaceId: tenant.id,
  name: "Plugin compute agent",
  configurationId: "cfg_00000000-0000-4000-8000-000000000016",
  executionMode: "embedded",
  harnessAuth: null,
  backendId: null,
  gatewayManagedMode: true,
  desiredRuntimeState: "running",
  status: "active",
  servicePrincipalId: "service-principal-plugin-compute",
  createdAt: tenant.createdAt,
});

type HarnessSnapshot = AgentRevision["harness"];
type RevisionOverrides = Partial<
  Omit<AgentRevision, "configuration" | "harness" | "harnessAuth" | "pluginApprovers">
> & {
  configuration?: Record<string, OpenClawConfigurationValue>;
  harness?: Pick<HarnessSnapshot, "id" | "version" | "mode">;
  pluginApprovers?: AgentRevision["pluginApprovers"];
};

export function revision({
  harness,
  pluginApprovers,
  ...overrides
}: RevisionOverrides = {}): AgentRevision & {
  harnessAuth: Extract<HarnessAuthSnapshot, { method: "api_key" }>;
  configuration: Record<string, OpenClawConfigurationValue>;
} {
  const native = createHarnessConfiguration(harness?.id ?? "codex", "gpt-4.1");
  const { auth: _auth, ...gateway } = native.gateway;
  const configuration = { ...admitLoggingConfiguration({ ...native, gateway }, "info") };
  return {
    id: "revision-plugin-compute-1",
    executionAdmission: { version: 2, mode: "unprotected" },
    namespaceId: tenant.id,
    agentId: agent.id,
    revision: 1,
    backendId: null,
    configurationId: agent.configurationId,
    configurationKind: "agent",
    configurationGeneration: 1,
    gatewayManagedMode: true,
    configuration,
    harnessAuth: {
      method: "api_key",
      source: {
        kind: "secret",
        namespaceId: tenant.id,
        id: "sec_00000000-0000-4000-8000-000000000016",
      },
      secretDriverId: "secret-kubernetes",
    },
    harness: {
      ...(harness ?? { id: "codex", version: "1.0.0", mode: "dedicated" }),
      overrides: {},
      configuration: {},
    },
    ...(pluginApprovers === undefined ? {} : { pluginApprovers }),
    compute: { id: "compute-kubernetes", implementation: "kubernetes" },
    servicePrincipalId: agent.servicePrincipalId,
    secretDriverId: "secret-kubernetes",
    createdAt: tenant.createdAt,
    ...overrides,
  };
}

export function harnessAuthContext(candidate: ReturnType<typeof revision>): ComputeRevisionContext {
  return {
    secretEnvironment: [],
    harnessAuth: {
      ...candidate.harnessAuth,
      backendRef: {
        namespaceName: kubernetesNamespaceName(tenant.id),
        name: "plugin-model-key",
        key: "value",
        uid: "plugin-model-key-uid",
      },
    },
  };
}

export function occSelection(): PluginDesiredState {
  return {
    "occ-plugin:diffs": {
      enabled: true,
      toolDefaults: { approval: "none" },
    },
  };
}

export function codexSelection(
  overrides: Partial<PluginDesiredSelection> = {},
): PluginDesiredState {
  return {
    "codex-plugin:linear@openai-curated-remote": {
      enabled: true,
      toolDefaults: { approval: "provider_default" },
      ...overrides,
    },
  };
}

export function openClawPluginState(): PluginRevisionState {
  return {
    driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
    plugins: occSelection(),
  };
}

export function codexNoPluginState(): PluginRevisionState {
  return {
    driver: { id: "codex-plugin", implementation: "occ/codex-plugin" },
    plugins: {},
  };
}

export function codexLinearPluginState(
  overrides: Partial<PluginDesiredSelection> = {},
): PluginRevisionState {
  return {
    driver: { id: "codex-plugin", implementation: "occ/codex-plugin" },
    plugins: codexSelection(overrides),
  };
}

export function kubernetesOptions(
  overrides: Partial<KubernetesComputeDriverOptions> = {},
): KubernetesComputeDriverOptions {
  return {
    ...conformanceKubernetesOptions({
      gatewayTrustedProxyCidrs: ["10.42.0.0/16"],
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
        gatewayNodeSelector: { "openclaw.dev/plane": "control" },
      },
    }),
    ...overrides,
  };
}

export function required<T>(value: T | undefined): T {
  assert.ok(value !== undefined, "fixture observation is missing");
  return value;
}

export function record(value: unknown): Record<string, unknown> {
  assert.ok(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "expected an object",
  );
  return value as Record<string, unknown>;
}

export function text(value: unknown): string {
  assert.ok(typeof value === "string", "expected text");
  return value;
}

export function items(value: unknown): readonly unknown[] {
  assert.ok(Array.isArray(value), "expected an array");
  return value;
}

const parse: (value: string) => unknown = JSON.parse;

export function parseJson(value: string | undefined): unknown {
  return parse(required(value));
}

export const runGeneratedProgram: (source: string, sandbox: object) => unknown = vm.runInNewContext;

export function property(value: unknown, ...keys: string[]): unknown {
  for (const key of keys) {
    value = record(value)[key];
  }
  return value;
}
