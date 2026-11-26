import assert from "node:assert/strict";
import type {
  Agent,
  Namespace,
  PluginDesiredSelection,
  PluginDesiredState,
  PluginDriverContext,
} from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";

const namespace: Namespace = Object.freeze({
  id: "ns_plugin",
  name: "Plugin conformance",
  status: "ready",
  createdAt: "2026-09-08T00:00:00.000Z",
});

const agent: Agent = Object.freeze({
  id: "agent_plugin",
  namespaceId: namespace.id,
  name: "Plugin agent",
  configurationId: "cfg_plugin",
  executionMode: "embedded",
  desiredRuntimeState: "running",
  status: "active",
  backendId: null,
  harnessAuth: null,
  gatewayManagedMode: false,
  servicePrincipalId: "sp_plugin",
  createdAt: namespace.createdAt,
});

export const linearPluginId = "codex-plugin:linear@openai-curated-remote";
export const calendarPluginId = "codex-plugin:google-calendar@openai-curated-remote";
export const thirdPluginId = "codex-plugin:third-plugin@openai-curated-remote";
export const thirdRemotePluginId = "opaque-third-123";

export function context(mode: Agent["executionMode"]): PluginDriverContext {
  return {
    namespace,
    agent: { ...agent, executionMode: mode },
    harness: { id: mode === "embedded" ? "openclaw" : "codex", version: "2026.9.0", mode },
    configuration: {},
    signal: AbortSignal.timeout(1_000),
  };
}

export function occSelection(overrides: Partial<PluginDesiredSelection> = {}) {
  return {
    "occ-plugin:diffs": {
      enabled: true,
      toolDefaults: { approval: "none" as const },
      ...overrides,
    },
  };
}

export function codexSelection(
  pluginId = linearPluginId,
  overrides: Partial<PluginDesiredSelection> = {},
): PluginDesiredState {
  return {
    [pluginId]: {
      enabled: true,
      toolDefaults: { approval: "provider_default" },
      ...overrides,
    },
  };
}

export function codexCatalogFixture() {
  return {
    marketplaces: [
      {
        name: "openai-internal-testing",
        plugins: [
          {
            id: "internal-only@openai-internal-testing",
            remotePluginId: "opaque-internal-only",
            interface: { displayName: "Internal Only" },
            version: "0.0.1",
          },
        ],
      },
      {
        name: "openai-curated-remote",
        plugins: [
          {
            id: "linear@openai-curated-remote",
            remotePluginId: "linear",
            interface: { displayName: "Linear" },
            version: "5.0.1",
          },
          {
            id: "google-calendar@openai-curated-remote",
            remotePluginId: "google-calendar",
            interface: { displayName: "Google Calendar" },
            version: "1.2.7",
          },
          {
            id: "third-plugin@openai-curated-remote",
            remotePluginId: thirdRemotePluginId,
            interface: { displayName: "Third Plugin" },
            version: "2.3.4",
          },
        ],
      },
    ],
  };
}

// Send deliberately malformed persisted selections through the public typed entry points.
export function unvalidatedPluginSelections(value: unknown): PluginDesiredState {
  return value as PluginDesiredState;
}

// Validate each object traversed on the way to an asserted native configuration value.
export function configurationObject(value: unknown, ...keys: string[]): Record<string, unknown> {
  let current = asRecord(value);
  assert.ok(current, "Expected a configuration object");
  for (const key of keys) {
    current = asRecord(current[key]);
    assert.ok(current, `Expected an object at configuration.${key}`);
  }
  return current;
}
