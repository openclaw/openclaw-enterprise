import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import {
  createKubernetesComputeDriver,
  KubernetesComputeDriver,
  kubernetesNamespaceName,
  kubernetesGatewayNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  AGENT_RUNTIME_ENTRYPOINT,
  GATEWAY_RUNTIME_ENTRYPOINT,
  PLUGIN_RUNTIME_HELPERS,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  PLUGIN_RUNTIME_CODEX_CONFIG,
  PLUGIN_RUNTIME_CODEX_CONFIG_ENVIRONMENT,
  PLUGIN_RUNTIME_ENVIRONMENT,
  PLUGIN_RUNTIME_MANIFEST,
  PLUGIN_RUNTIME_MANIFEST_ENVIRONMENT,
  PLUGIN_RUNTIME_READY_MARKER_ENVIRONMENT,
  pluginRuntimeConfigMapData,
  pluginRuntimeEnvironment,
  pluginRuntimeSpecForRevision,
} from "../../apps/controller/src/drivers/compute/plugin-runtime.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import { DependencyUnavailableError } from "../../packages/occ/src/errors.ts";

import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { runOpenClawRuntimeHelper } from "../helpers/plugin-runtime.mjs";

const CODEX_LINEAR_NATIVE_ID = "linear@openai-curated-remote";
const CODEX_LINEAR_REMOTE_ID = "plugin_asdk_app_69a089a326dc8191b32a3f2553f5be2c";
const CODEX_LINEAR_APP_ID = "asdk_app_69a089a326dc8191b32a3f2553f5be2c";
const CODEX_LINEAR_VERSION = "5.0.1";
const CODEX_ASANA_NATIVE_ID = "asana@openai-curated-remote";
const CODEX_ASANA_REMOTE_ID = "plugin_asdk_app_asana";
const CODEX_ASANA_APP_ID = "asdk_app_asana";
const PLUGIN_APP_SERVER_TOKEN_DOMAIN = "openclaw-plugin-runtime/app-server-token/v1";
const nodeRequire = createRequire(import.meta.url);

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function shortHash(value) {
  return sha256(value).slice(0, 12);
}

function pluginAppServerToken(baseToken, revisionId, startupId) {
  return createHmac("sha256", baseToken)
    .update(PLUGIN_APP_SERVER_TOKEN_DOMAIN)
    .update("\0")
    .update(revisionId)
    .update("\0")
    .update(startupId)
    .digest("hex");
}

async function waitForCondition(description, condition) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const result = await condition();
    if (result !== undefined && result !== false) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${description}.`);
}

function readStatusFromHandler(handler, path = "/openclaw/plugin-runtime/status") {
  let body = "";
  handler(
    { method: "GET", url: path },
    {
      writeHead() {},
      end(chunk) {
        body += chunk;
      },
    },
  );
  return JSON.parse(body);
}

function readRuntimeStatusFromHandler(handler) {
  return readStatusFromHandler(handler, "/openclaw/runtime/status");
}

async function readStatusFromHandlerAsync(handler, path) {
  let body = "";
  await handler(
    { method: "GET", url: path, on() {}, off() {} },
    {
      writeHead() {},
      on() {},
      off() {},
      end(chunk) {
        body += chunk;
      },
    },
  );
  return JSON.parse(body);
}

async function readRuntimeChannelChecksFromHandler(handler) {
  return readStatusFromHandlerAsync(handler, "/openclaw/runtime/diagnostics");
}

const tenant = {
  id: "ns_00000000-0000-4000-8000-000000000016",
  name: "Plugin compute tenant",
  status: "ready",
  createdAt: "2026-09-08T00:00:00.000Z",
};

const agent = Object.freeze({
  id: "agent-plugin-compute",
  namespaceId: tenant.id,
  name: "Plugin compute agent",
  configurationId: "cfg_00000000-0000-4000-8000-000000000016",
  executionMode: "embedded",
  harnessAuth: null,
  servicePrincipalId: "service-principal-plugin-compute",
  createdAt: tenant.createdAt,
});

function context(mode) {
  return {
    namespace: tenant,
    agent: { ...agent, executionMode: mode },
    harness: { id: mode === "embedded" ? "openclaw" : "codex", version: "2026.9.0", mode },
    configuration: {},
    signal: AbortSignal.timeout(1_000),
  };
}

function revision(overrides = {}) {
  const native = createHarnessConfiguration(overrides.harness?.id ?? "codex", "gpt-4.1");
  delete native.gateway.auth;
  return {
    id: "revision-plugin-compute-1",
    namespaceId: tenant.id,
    agentId: agent.id,
    revision: 1,
    configurationId: agent.configurationId,
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration: admitLoggingConfiguration(native, "info"),
    harnessAuth: {
      method: "api_key",
      source: {
        kind: "secret",
        namespaceId: tenant.id,
        id: "sec_00000000-0000-4000-8000-000000000016",
      },
      secretDriverId: "secret-kubernetes",
    },
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    compute: { id: "compute-kubernetes", implementation: "kubernetes" },
    servicePrincipalId: agent.servicePrincipalId,
    secretDriverId: "secret-kubernetes",
    createdAt: tenant.createdAt,
    ...overrides,
  };
}

function harnessAuthContext(candidate) {
  return {
    harnessAuth: {
      ...candidate.harnessAuth,
      backendRef: {
        namespaceName: kubernetesGatewayNamespaceName(tenant.id),
        name: "plugin-model-key",
        key: "value",
        uid: "plugin-model-key-uid",
      },
    },
  };
}

function occSelection(overrides = {}) {
  return {
    "occ-plugin:diffs": {
      enabled: true,
      toolDefaults: { approval: "none" },
      ...overrides,
    },
  };
}

function codexSelection(overrides = {}) {
  return {
    "codex-plugin:linear@openai-curated-remote": {
      enabled: true,
      toolDefaults: { approval: "provider_default" },
      ...overrides,
    },
  };
}

function openClawPluginState() {
  return {
    driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
    plugins: occSelection(),
  };
}

function codexNoPluginState() {
  return {
    driver: { id: "codex-plugin", implementation: "occ/codex-plugin" },
    plugins: {},
  };
}

function codexLinearPluginState(overrides = {}) {
  return {
    driver: { id: "codex-plugin", implementation: "occ/codex-plugin" },
    plugins: codexSelection(overrides),
  };
}

function kubernetesOptions(overrides = {}) {
  const resources = {
    requests: { cpu: "100m", memory: "64Mi" },
    limits: { cpu: "250m", memory: "128Mi" },
  };
  return {
    authentication: {
      mode: "kubeconfig",
      kubeconfigPath: "/tmp/openclaw-enterprise-conformance/kubeconfig",
      context: "openclaw-enterprise-local",
    },
    images: {
      gateway: "openclaw-enterprise/gateway-fixture:local",
      agent: "openclaw-enterprise/agent-fixture:local",
      requireImmutableDigest: false,
    },
    resources: {
      gateway: resources,
      agent: resources,
      namespace: {
        quota: { pods: "10", "requests.cpu": "2", "requests.memory": "1Gi" },
        containerDefaults: resources,
      },
    },
    network: {
      dns: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
      gatewayPort: 8080,
      gatewayTrustedProxyCidrs: ["10.42.0.0/16"],
      gatewayClients: [
        { namespace: "openclaw-controller", podLabels: { "app.kubernetes.io/name": "controller" } },
      ],
    },
    servicePrincipalCredentials: { mode: "disabled" },
    runtime: {
      transportSecretPrefix: "transport",
      gatewayStorageClassName: "local-path",
      gatewayNodeSelector: { "openclaw.dev/plane": "control" },
    },
    ...overrides,
  };
}

function codexListResponse(options = {}) {
  const plugins = options.plugins ?? [
    {
      id: options.nativeId ?? CODEX_LINEAR_NATIVE_ID,
      remotePluginId: options.remotePluginId ?? CODEX_LINEAR_REMOTE_ID,
      name: options.name ?? "linear",
      source: { type: "remote" },
      installed: false,
      enabled: false,
      installPolicy: "AVAILABLE",
      authPolicy: "ON_USE",
      availability: "AVAILABLE",
      version: options.version ?? CODEX_LINEAR_VERSION,
      interface: null,
    },
  ];
  return {
    marketplaces: [
      {
        name: "openai-curated-remote",
        path: null,
        interface: null,
        plugins,
      },
    ],
    marketplaceLoadErrors: [],
    featuredPluginIds: [],
  };
}

function codexReadResponse(options = {}) {
  return {
    plugin: {
      marketplaceName: "openai-curated-remote",
      marketplacePath: null,
      summary: {
        id: options.nativeId ?? CODEX_LINEAR_NATIVE_ID,
        remotePluginId: options.remotePluginId ?? CODEX_LINEAR_REMOTE_ID,
        name: options.name ?? "linear",
        source: { type: "remote" },
        installed: options.installed ?? true,
        enabled: options.enabled ?? true,
        installPolicy: "AVAILABLE",
        authPolicy: "ON_USE",
        availability: "AVAILABLE",
        version: options.version ?? CODEX_LINEAR_VERSION,
        interface: null,
      },
      description: null,
      skills: options.skills ?? [],
      apps: options.apps ?? [{ id: CODEX_LINEAR_APP_ID, name: "Linear", needsAuth: false }],
      appTemplates: options.appTemplates ?? [],
      hooks: [],
      mcpServers: [],
      scheduledTasks: [],
    },
  };
}

function codexConfigReadResponse(appConfig = {}) {
  return {
    config: {
      approval_policy: "on-request",
      model: "test-model",
      features: { apps: true, plugins: true, remote_plugin: true },
      apps: {
        _default: { enabled: false },
        [CODEX_LINEAR_APP_ID]: {
          enabled: true,
          default_tools_approval_mode: "auto",
          ...appConfig,
        },
      },
      plugins: {},
    },
    origins: {},
  };
}

async function runCodexRuntimeHelper(runtime, handler, options = {}) {
  const requests = [];
  const sockets = [];
  const files = new Map(options.files ?? []);
  class FakeWebSocket {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.listeners = new Map();
      sockets.push(this);
      setTimeout(() => this.dispatch("open", {}), 0);
    }
    on(name, listener) {
      const existing = this.listeners.get(name) ?? [];
      existing.push(listener);
      this.listeners.set(name, existing);
      return this;
    }
    dispatch(name, event) {
      for (const listener of this.listeners.get(name) ?? []) {
        listener(event);
      }
    }
    send(raw) {
      const request = JSON.parse(raw);
      if (request.method === "initialized") {
        return;
      }
      requests.push({ method: request.method, params: request.params });
      Promise.resolve()
        .then(() => handler(request.method, request.params, request.id))
        .then(
          (result) => {
            if (result?.__rawMessage !== undefined) {
              this.dispatch(
                "message",
                Buffer.from(
                  typeof result.__rawMessage === "string"
                    ? result.__rawMessage
                    : JSON.stringify(result.__rawMessage),
                ),
              );
              return;
            }
            this.dispatch("message", Buffer.from(JSON.stringify({ id: request.id, result })));
          },
          (error) =>
            this.dispatch(
              "message",
              Buffer.from(
                JSON.stringify({ id: request.id, error: { code: -32000, message: error.message } }),
              ),
            ),
        );
    }
    close() {}
  }
  const sandbox = {
    JSON,
    Buffer,
    Date: options.Date ?? Date,
    WebSocket: FakeWebSocket,
    setTimeout,
    clearTimeout,
    process: {
      env: {
        APP_SERVER_PORT: "4321",
        APP_SERVER_TOKEN: "capability-token-test-value",
        CODEX_HOME: "/home/node/.codex",
        OPENCLAW_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS: "25",
        ...(options.env ?? {}),
      },
    },
    require(specifier) {
      if (specifier === "ws") {
        return FakeWebSocket;
      }
      if (specifier === "node:fs") {
        return {
          existsSync(path) {
            return files.has(path);
          },
          mkdirSync() {},
          readFileSync(path) {
            if (!files.has(path)) {
              throw new Error(`Missing mocked file: ${path}`);
            }
            return files.get(path);
          },
          writeFileSync(path, data) {
            files.set(path, String(data));
          },
        };
      }
      return nodeRequire(specifier);
    },
    result: {},
  };
  const completion = new Promise((resolve, reject) => {
    sandbox.result.resolve = resolve;
    sandbox.result.reject = reject;
  });
  try {
    vm.runInNewContext(
      `${PLUGIN_RUNTIME_HELPERS}
installCodexPlugins(
  ${JSON.stringify(runtime)},
  ${JSON.stringify(options.failures ?? [])}
).then(result.resolve, result.reject);`,
      sandbox,
    );
  } catch (error) {
    if (options.captureError === true) {
      return { requests, sockets, files, error };
    }
    throw error;
  }
  try {
    const value = await completion;
    return { requests, sockets, files, value };
  } catch (error) {
    if (options.captureError === true) {
      return { requests, sockets, files, error };
    }
    throw error;
  }
}

test("compute renders plugin-free Codex revisions with native default-deny plugin config", () => {
  const runtime = pluginRuntimeSpecForRevision(revision());
  assert.equal(runtime.kind, "codex");
  assert.deepEqual(runtime.selections, {});

  const data = pluginRuntimeConfigMapData(runtime);
  assert.deepEqual(JSON.parse(data[PLUGIN_RUNTIME_MANIFEST]), { kind: "codex", selections: {} });
  assert.match(
    data[PLUGIN_RUNTIME_CODEX_CONFIG],
    /^\[features\]\napps = false\nplugins = false\nremote_plugin = false/m,
  );
  assert.match(data[PLUGIN_RUNTIME_CODEX_CONFIG], /^\[apps\._default\]\nenabled = false/m);
});

test("plugin-free revisions apply explicit Slack approvers for configured Slack and keep unrelated approvals", () => {
  const rawSlackApprovers = [
    { channel: "slack", id: "U456" },
    { channel: "slack", id: "W789" },
  ];
  for (const [candidate, expectedApprovers] of [
    [revision({ pluginApprovers: [] }), []],
    [revision({ pluginApprovers: rawSlackApprovers }), ["U456", "W789"]],
    [
      revision({
        harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
        pluginApprovers: rawSlackApprovers,
      }),
      ["U456", "W789"],
    ],
  ]) {
    const runtime = pluginRuntimeSpecForRevision(candidate);
    assert.deepEqual(runtime.pluginApprovers, candidate.pluginApprovers);
    assert.deepEqual(JSON.parse(pluginRuntimeConfigMapData(runtime)[PLUGIN_RUNTIME_MANIFEST]), {
      kind: runtime.kind,
      selections: {},
      pluginApprovers: candidate.pluginApprovers,
    });
    const { files } = runOpenClawRuntimeHelper({ manifest: runtime }, [], {
      baseConfig: {
        channels: { slack: { enabled: true } },
        approvals: {
          exec: { enabled: true, mode: "session" },
        },
      },
    });
    const config = JSON.parse(files.get("/home/node/.openclaw/openclaw.json"));
    assert.deepEqual(config.approvals, {
      exec: { enabled: true, mode: "session" },
      plugin: { slack: { approvers: expectedApprovers } },
    });
  }
});

test("plugin-free Codex Gateway applies explicit Agent approvers at launch", async () => {
  const runtime = pluginRuntimeSpecForRevision(revision({ pluginApprovers: [] }));
  const { files } = await runOpenClawRuntimeHelper({ manifest: runtime }, [], {
    env: {
      APP_SERVER_URL: "ws://harness.example.test:18790",
      OPENCLAW_PLUGIN_RUNTIME_JSON: JSON.stringify({ manifest: runtime }),
    },
    baseConfig: {
      channels: { slack: { enabled: true } },
      approvals: { exec: { enabled: true, mode: "session" } },
    },
  });
  const config = JSON.parse(files.get("/home/node/.openclaw/openclaw.json"));
  assert.deepEqual(config.approvals, {
    exec: { enabled: true, mode: "session" },
    plugin: { slack: { approvers: [] } },
  });
});

test("plugin-free Codex runtime carries broker policy and Slack approvers together", () => {
  const repositoryBrokerNetworkPolicy = {
    host: "git.oce.svc",
    domains: { "github.com": "allow" },
  };
  const runtime = pluginRuntimeSpecForRevision(
    revision({ pluginApprovers: [] }),
    repositoryBrokerNetworkPolicy,
  );
  assert.deepEqual(JSON.parse(pluginRuntimeConfigMapData(runtime)[PLUGIN_RUNTIME_MANIFEST]), {
    kind: "codex",
    selections: {},
    pluginApprovers: [],
    repositoryBrokerNetworkPolicy,
  });
  const { files } = runOpenClawRuntimeHelper({ manifest: runtime }, [], {
    baseConfig: { channels: { slack: { enabled: true } } },
  });
  const config = JSON.parse(files.get("/home/node/.openclaw/openclaw.json"));
  assert.deepEqual(config.approvals.plugin.slack.approvers, []);
  assert.equal(
    config.plugins.entries.codex.config.appServer.networkProxy.domains["git.oce.svc"],
    "allow",
  );
});

test("compute consumes Codex no-plugin selections from the revision", () => {
  const state = codexNoPluginState();
  const runtime = pluginRuntimeSpecForRevision(revision({ plugins: state }));
  assert.equal(runtime.kind, "codex");
  assert.deepEqual(runtime.selections, {});

  const data = pluginRuntimeConfigMapData(runtime);
  assert.deepEqual(JSON.parse(data[PLUGIN_RUNTIME_MANIFEST]), { kind: "codex", selections: {} });
  assert.match(
    data[PLUGIN_RUNTIME_CODEX_CONFIG],
    /^\[features\]\napps = false\nplugins = false\nremote_plugin = false/m,
  );

  const docker = JSON.parse(pluginRuntimeEnvironment(runtime)[PLUGIN_RUNTIME_ENVIRONMENT]);
  assert.deepEqual(docker.manifest, JSON.parse(data[PLUGIN_RUNTIME_MANIFEST]));
  assert.equal(docker.codexConfigurationToml, data[PLUGIN_RUNTIME_CODEX_CONFIG]);
});

test("Codex runtime skips the plugin API when no plugins are selected", async () => {
  // A no-plugin Agent must reach readiness without the Codex plugin API, which a Sandbox
  // workload may not be able to reach. Salvaged from #146 by @sallyom.
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(revision({ plugins: codexNoPluginState() })),
  };
  const { requests, sockets } = await runCodexRuntimeHelper(runtime, (method) => {
    throw new Error(`unexpected request ${method}`);
  });

  assert.deepEqual(requests, []);
  assert.deepEqual(sockets, []);
});

test("compute serializes selected Codex plugins for startup-time resolution", () => {
  const state = codexLinearPluginState({
    toolDefaults: { approval: "provider_default", reviewer: "auto" },
  });
  const runtime = pluginRuntimeSpecForRevision(revision({ plugins: state }));

  assert.equal(runtime.kind, "codex");
  assert.deepEqual(runtime.selections, state.plugins);

  const data = pluginRuntimeConfigMapData(runtime);
  const manifest = JSON.parse(data[PLUGIN_RUNTIME_MANIFEST]);
  assert.deepEqual(manifest, {
    kind: "codex",
    selections: state.plugins,
  });
  assert.match(
    data[PLUGIN_RUNTIME_CODEX_CONFIG],
    /^\[features\]\napps = true\nplugins = true\nremote_plugin = true/m,
  );
  assert.doesNotMatch(
    data[PLUGIN_RUNTIME_CODEX_CONFIG],
    /asdk_app_69a089a326dc8191b32a3f2553f5be2c/,
  );
});

test("compute serializes selected OpenClaw plugins for startup-time resolution", () => {
  const state = openClawPluginState();
  const runtime = pluginRuntimeSpecForRevision(
    revision({
      harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
      plugins: state,
    }),
  );

  assert.deepEqual(runtime.selections, state.plugins);
  const data = pluginRuntimeConfigMapData(runtime);
  assert.deepEqual(Object.keys(data), [PLUGIN_RUNTIME_MANIFEST]);
  assert.deepEqual(JSON.parse(data[PLUGIN_RUNTIME_MANIFEST]), {
    kind: "openclaw",
    selections: state.plugins,
  });
});

test("Codex runtime helper installs a plugin with skills and applies write action approval without tool inventory", async () => {
  const state = codexLinearPluginState({
    toolDefaults: { approval: "write_actions", reviewer: "auto" },
  });
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(revision({ plugins: state })),
  };
  let readCount = 0;
  const { requests, sockets } = await runCodexRuntimeHelper(runtime, (method, params) => {
    if (method === "initialize") {
      return { serverInfo: { name: "codex", version: "0.149.0" } };
    }
    if (method === "plugin/list") {
      assert.deepEqual(params, {});
      return codexListResponse();
    }
    if (method === "plugin/read") {
      assert.deepEqual(params, {
        remoteMarketplaceName: "openai-curated-remote",
        pluginName: CODEX_LINEAR_REMOTE_ID,
      });
      readCount += 1;
      return codexReadResponse({
        installed: readCount > 1,
        enabled: readCount > 1,
        skills: [{ name: "linear-workflow" }],
        // Template-only IDs must not enter the concrete app policy written below.
        appTemplates: [
          {
            templateId: "workspace_template",
            name: "Workspace app",
            materializedAppIds: ["template_only_app"],
            reason: null,
          },
        ],
      });
    }
    if (method === "config/batchWrite") {
      assert.deepEqual(params, {
        edits: [
          { keyPath: "features.apps", mergeStrategy: "replace", value: true },
          { keyPath: "features.plugins", mergeStrategy: "replace", value: true },
          { keyPath: "features.remote_plugin", mergeStrategy: "replace", value: true },
          { keyPath: 'apps."_default"', mergeStrategy: "replace", value: { enabled: false } },
          {
            keyPath: `apps.${CODEX_LINEAR_APP_ID}`,
            mergeStrategy: "replace",
            value: {
              enabled: true,
              default_tools_approval_mode: "writes",
              approvals_reviewer: "auto_review",
            },
          },
        ],
        reloadUserConfig: true,
      });
      return { status: "ok", version: "test-config-1" };
    }
    if (method === "plugin/install") {
      assert.deepEqual(params, {
        remoteMarketplaceName: "openai-curated-remote",
        pluginName: CODEX_LINEAR_REMOTE_ID,
      });
      return { authPolicy: "ON_USE", appsNeedingAuth: [] };
    }
    if (method === "config/read") {
      assert.deepEqual(params, { cwd: "/home/node/workspace" });
      return codexConfigReadResponse({
        default_tools_approval_mode: "writes",
        approvals_reviewer: "auto_review",
      });
    }
    if (method === "configRequirements/read") {
      assert.deepEqual(params, {});
      return { requirements: null };
    }
    throw new Error(`unexpected request ${method}`);
  });

  assert.deepEqual(
    requests.map((request) => request.method),
    [
      "initialize",
      "plugin/list",
      "initialize",
      "plugin/read",
      "initialize",
      "plugin/install",
      "initialize",
      "config/read",
      "initialize",
      "config/batchWrite",
      "initialize",
      "plugin/read",
      "initialize",
      "config/read",
      "initialize",
      "configRequirements/read",
    ],
  );
  assert.equal(
    sockets.every(
      (socket) => socket.options.headers.Authorization === "Bearer capability-token-test-value",
    ),
    true,
  );
});

test("Codex startup explicitly denies inherited apps and replaces inherited approval exceptions", async () => {
  const state = codexLinearPluginState({ toolDefaults: { approval: "all_actions" } });
  const runtime = { manifest: pluginRuntimeSpecForRevision(revision({ plugins: state })) };
  let written = false;
  const result = await runCodexRuntimeHelper(runtime, (method, params) => {
    if (method === "initialize") {
      return { serverInfo: { name: "codex", version: "0.158.0" } };
    }
    if (method === "plugin/list") {
      return codexListResponse();
    }
    if (method === "plugin/read") {
      return codexReadResponse();
    }
    if (method === "plugin/install") {
      return { authPolicy: "ON_USE", appsNeedingAuth: [] };
    }
    if (method === "config/read") {
      // A lower-priority config can contribute an app through tool preferences.
      // Native AppConfig defaults its enabled field to true despite _default=false.
      const response = codexConfigReadResponse({
        default_tools_approval_mode: "prompt",
        tools: { "read issue": { enabled: null, approval_mode: written ? "prompt" : "approve" } },
        links: { account: { default_tools_approval_mode: written ? "prompt" : "approve" } },
      });
      response.config.apps.unselected = {
        enabled: !written,
        tools: { read: { approval_mode: "approve" } },
      };
      return response;
    }
    if (method === "config/batchWrite") {
      const edits = new Map(params.edits.map((edit) => [edit.keyPath, edit.value]));
      assert.equal(edits.get("apps.unselected.enabled"), false);
      assert.equal(
        edits.get(`apps.${CODEX_LINEAR_APP_ID}.tools."read issue".approval_mode`),
        "prompt",
      );
      assert.equal(
        edits.get(`apps.${CODEX_LINEAR_APP_ID}.links.account.default_tools_approval_mode`),
        "prompt",
      );
      assert.equal(
        edits.has(`apps.${CODEX_LINEAR_APP_ID}.tools."read issue".enabled`),
        false,
        "approval repair must not bypass annotation-based tool enablement",
      );
      written = true;
      return { status: "ok", version: "selection-policy" };
    }
    throw new Error(`unexpected request ${method}`);
  });
  assert.equal(written, true);
  assert.equal(result.error, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(result.value.failures)), []);
});

test("Codex runtime helper verifies explicit reviewers before readiness without constraining omission", async (t) => {
  for (const scenario of [
    {
      name: "auto with never",
      config: { approval_policy: "never" },
      error: /requires session approval/,
    },
    {
      name: "auto with untrusted",
      config: { approval_policy: "untrusted" },
      error: /requires session approval/,
    },
    {
      name: "auto with granular",
      config: {
        approval_policy: {
          granular: {
            sandbox_approval: true,
            rules: true,
            skill_approval: true,
            request_permissions: true,
            mcp_elicitations: true,
          },
        },
      },
    },
    {
      name: "managed reviewer exclusion",
      requirements: { allowedApprovalsReviewers: ["user"] },
      error: /managed requirements forbid/,
    },
    {
      name: "required model conflicts with human",
      reviewer: "human",
      app: { approvals_reviewer: "user" },
      config: { model: "provider/test-model" },
      requirements: { autoReview: { requiredOnModels: ["test-model"] } },
      error: /managed model requirements/,
    },
    {
      name: "unknown model cannot verify human",
      reviewer: "human",
      app: { approvals_reviewer: "user" },
      config: { model: null },
      requirements: { autoReview: { requiredOnModels: ["test-model"] } },
      error: /managed model requirements/,
    },
    {
      name: "unrelated requirements allow human",
      reviewer: "human",
      app: { approvals_reviewer: "user" },
      requirements: {
        allowedApprovalsReviewers: null,
        autoReview: { requiredOnModels: ["other-model"] },
      },
    },
    {
      name: "account reviewer conflicts",
      app: { links: { account: { approvals_reviewer: "user" } } },
      error: /effective app or account reviewer conflicts/,
    },
    {
      name: "app reviewer conflicts",
      app: { approvals_reviewer: "user" },
      error: /effective app or account reviewer conflicts/,
    },
    {
      name: "malformed requirements response",
      response: {},
      error: /reviewer requirements are unavailable/,
    },
    {
      name: "malformed reviewer allowlist",
      requirements: { allowedApprovalsReviewers: ["human"] },
      error: /reviewer requirements are invalid/,
    },
    {
      name: "omitted reviewer preserves native configuration",
      reviewer: null,
      config: { approval_policy: "never" },
    },
  ]) {
    await t.test(scenario.name, async () => {
      const reviewer = scenario.reviewer === undefined ? "auto" : scenario.reviewer;
      const state = codexLinearPluginState({
        ...(reviewer === null ? {} : { toolDefaults: { reviewer } }),
      });
      const runtime = { manifest: pluginRuntimeSpecForRevision(revision({ plugins: state })) };
      const result = await runCodexRuntimeHelper(
        runtime,
        (method, params) => {
          if (method === "initialize") {
            return { serverInfo: { name: "codex", version: "0.156.0" } };
          }
          if (method === "plugin/list") {
            return codexListResponse();
          }
          if (method === "plugin/read") {
            return codexReadResponse();
          }
          if (method === "plugin/install") {
            return { authPolicy: "ON_USE", appsNeedingAuth: [] };
          }
          if (method === "config/batchWrite") {
            return { status: "ok", version: "reviewer-config" };
          }
          if (method === "config/read") {
            const response = codexConfigReadResponse({
              approvals_reviewer: "auto_review",
              ...scenario.app,
            });
            return { config: { ...response.config, ...scenario.config }, origins: {} };
          }
          if (method === "configRequirements/read") {
            assert.deepEqual(params, {});
            return scenario.response ?? { requirements: scenario.requirements ?? null };
          }
          throw new Error(`unexpected request ${method}`);
        },
        { captureError: true },
      );
      if (scenario.error) {
        assert.match(result.error?.message ?? "", scenario.error);
        assert.equal(result.value, undefined, "unverifiable reviewer must prevent readiness");
      } else {
        assert.equal(result.error, undefined);
        assert.deepEqual(plain(result.value), {
          successfulPluginIds: ["codex-plugin:linear@openai-curated-remote"],
          failures: [],
        });
      }
      if (reviewer === null) {
        assert.equal(
          result.requests.some(({ method }) => method === "configRequirements/read"),
          false,
        );
      }
    });
  }
});

test("Codex runtime helper discovers tool policy after installation and before readiness", async () => {
  const state = codexLinearPluginState({
    toolDefaults: { enabled: false, approval: "all_actions", reviewer: "human" },
    tools: { [CODEX_LINEAR_APP_ID + "/list_issues"]: { enabled: true, approval: "none" } },
  });
  const runtime = { manifest: pluginRuntimeSpecForRevision(revision({ plugins: state })) };
  const apps = {};
  let installed = false;
  const { requests } = await runCodexRuntimeHelper(runtime, (method, params) => {
    if (method === "initialize") {
      return { serverInfo: { name: "codex", version: "0.156.0" } };
    }
    if (method === "plugin/list") {
      return codexListResponse();
    }
    if (method === "plugin/read") {
      return codexReadResponse({ installed, enabled: installed });
    }
    if (method === "plugin/install") {
      installed = true;
      return { authPolicy: "ON_USE", appsNeedingAuth: [] };
    }
    if (method === "mcpServerStatus/list") {
      assert.equal(installed, true, "tool discovery follows native installation");
      assert.equal(params.detail, "toolsAndAuthOnly");
      if (params.cursor === undefined) {
        return { data: [{ name: "unrelated", tools: {} }], nextCursor: "apps-page" };
      }
      assert.equal(params.cursor, "apps-page");
      return {
        data: [
          {
            name: "codex_apps",
            toolsError: null,
            tools: {
              list_issues: {
                name: "list_issues",
                inputSchema: { type: "object" },
                _meta: { connector_id: CODEX_LINEAR_APP_ID },
                annotations: { readOnlyHint: true, destructiveHint: false },
              },
              create_issue: {
                name: "create_issue",
                inputSchema: { type: "object" },
                _meta: { connector_id: CODEX_LINEAR_APP_ID },
                annotations: { readOnlyHint: false, destructiveHint: false },
              },
            },
          },
        ],
        nextCursor: null,
      };
    }
    if (method === "config/batchWrite") {
      for (const edit of params.edits) {
        if (edit.keyPath === 'apps."_default"') {
          apps._default = edit.value;
        }
        if (edit.keyPath === `apps.${CODEX_LINEAR_APP_ID}`) {
          apps[CODEX_LINEAR_APP_ID] = edit.value;
        }
      }
      assert.equal(apps._default.enabled, false, "discovery must not grant unselected apps");
      assert.equal(
        apps[CODEX_LINEAR_APP_ID]?.enabled,
        true,
        "the tool exception keeps the app enabled",
      );
      assert.equal(apps[CODEX_LINEAR_APP_ID].tools.list_issues.enabled, true);
      assert.equal(apps[CODEX_LINEAR_APP_ID].tools.list_issues.approval_mode, "approve");
      assert.equal(apps[CODEX_LINEAR_APP_ID].default_tools_enabled, false);
      assert.equal(apps[CODEX_LINEAR_APP_ID].default_tools_approval_mode, "prompt");
      assert.equal(apps[CODEX_LINEAR_APP_ID].tools.create_issue, undefined);
      return { status: "ok", version: "tool-policy" };
    }
    if (method === "config/read") {
      return { config: { ...codexConfigReadResponse().config, apps } };
    }
    if (method === "configRequirements/read") {
      assert.deepEqual(params, {});
      return { requirements: null };
    }
    throw new Error(`unexpected request ${method}`);
  });
  assert.deepEqual(
    requests.filter(({ method }) => method === "mcpServerStatus/list").map(({ params }) => params),
    [{ detail: "toolsAndAuthOnly" }, { detail: "toolsAndAuthOnly", cursor: "apps-page" }],
  );
});

test("Codex runtime helper rejects incomplete or unbounded tool discovery before writing policy", async (t) => {
  for (const [name, response, expected] of [
    ["invalid data", () => ({ data: {}, nextCursor: null }), /invalid pagination data/],
    ["invalid cursor", () => ({ data: [], nextCursor: 1 }), /invalid pagination data/],
    ["repeated cursor", () => ({ data: [], nextCursor: "repeat" }), /repeated cursor/],
    ["page limit", (page) => ({ data: [], nextCursor: String(page) }), /page limit/],
    [
      "native discovery error",
      () => ({
        data: [{ name: "codex_apps", tools: {}, toolsError: "tool listing failed" }],
        nextCursor: null,
      }),
      /tool inventory is unavailable/,
    ],
  ]) {
    await t.test(name, async () => {
      const state = codexLinearPluginState({
        tools: { [CODEX_LINEAR_APP_ID + "/list_issues"]: { enabled: false } },
      });
      const runtime = { manifest: pluginRuntimeSpecForRevision(revision({ plugins: state })) };
      let page = 0;
      const result = await runCodexRuntimeHelper(
        runtime,
        (method) => {
          if (method === "initialize") {
            return { serverInfo: { name: "codex", version: "0.156.0" } };
          }
          if (method === "plugin/list") {
            return codexListResponse();
          }
          if (method === "plugin/read") {
            return codexReadResponse();
          }
          if (method === "plugin/install") {
            return { authPolicy: "ON_USE", appsNeedingAuth: [] };
          }
          if (method === "mcpServerStatus/list") {
            return response(page++);
          }
          throw new Error(`unexpected request ${method}`);
        },
        { captureError: true },
      );
      assert.match(result.error?.message ?? "", expected);
      assert.equal(
        result.requests.some(({ method }) => method === "config/batchWrite"),
        false,
      );
    });
  }
});

test("Codex runtime helper reports plugin install warnings without retrying", async () => {
  const state = codexLinearPluginState({
    toolDefaults: { approval: "provider_default", reviewer: "auto" },
  });
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(revision({ plugins: state })),
  };
  let readCount = 0;
  const result = await runCodexRuntimeHelper(
    runtime,
    (method) => {
      if (method === "initialize") {
        return { serverInfo: { name: "codex", version: "0.149.0" } };
      }
      if (method === "plugin/list") {
        return codexListResponse();
      }
      if (method === "plugin/read") {
        readCount += 1;
        return codexReadResponse({ installed: readCount > 1, enabled: readCount > 1 });
      }
      if (method === "config/batchWrite") {
        return { status: "ok", version: "test-config-1" };
      }
      if (method === "plugin/install") {
        throw new Error("native install rejected");
      }
      if (method === "config/read") {
        // Native layers may retain overrides, but app disablement blocks every tool.
        return codexConfigReadResponse({
          enabled: false,
          default_tools_enabled: true,
          tools: { list_issues: { enabled: true, approval_mode: "approve" } },
          links: { account: { default_tools_approval_mode: "approve" } },
        });
      }
      throw new Error(`unexpected request ${method}`);
    },
    {
      env: {
        OPENCLAW_PLUGIN_STATUS_PORT: "18791",
      },
    },
  );

  assert.deepEqual(plain(result.value), {
    successfulPluginIds: [],
    failures: [
      {
        pluginId: "codex-plugin:linear@openai-curated-remote",
        code: "PLUGIN_INSTALL_FAILED",
      },
    ],
  });
  assert.equal(result.requests.filter((request) => request.method === "plugin/install").length, 1);
  const write = result.requests.find((request) => request.method === "config/batchWrite");
  assert.ok(write);
  assert.deepEqual(
    write.params.edits.find((edit) => edit.keyPath === `apps.${CODEX_LINEAR_APP_ID}`)?.value,
    { enabled: false },
  );
});

test("Codex runtime helper reports connector-auth warnings with the admitted key", async () => {
  const runtime = {
    manifest: {
      kind: "codex",
      selections: {
        "linear@openai-curated-remote": {
          enabled: true,
          toolDefaults: { approval: "provider_default" },
        },
      },
    },
  };
  const result = await runCodexRuntimeHelper(
    runtime,
    (method) => {
      if (method === "initialize") {
        return { serverInfo: { name: "codex", version: "0.149.0" } };
      }
      if (method === "plugin/list") {
        return codexListResponse();
      }
      if (method === "plugin/read") {
        return codexReadResponse();
      }
      if (method === "config/batchWrite") {
        return { status: "ok", version: "test-config-1" };
      }
      if (method === "plugin/install") {
        return {
          authPolicy: "ON_USE",
          appsNeedingAuth: [
            {
              id: CODEX_LINEAR_APP_ID,
              name: "Linear",
              category: null,
            },
          ],
        };
      }
      if (method === "config/read") {
        return codexConfigReadResponse({ enabled: false });
      }
      throw new Error(`unexpected request ${method}`);
    },
    {
      env: {
        OPENCLAW_PLUGIN_STATUS_PORT: "18791",
      },
    },
  );

  assert.deepEqual(plain(result.value), {
    successfulPluginIds: [],
    failures: [{ pluginId: "linear@openai-curated-remote", code: "PLUGIN_AUTH_REQUIRED" }],
  });
});

test("Codex runtime helper keeps malformed matching install responses generic", async (t) => {
  const state = codexLinearPluginState();
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(revision({ plugins: state })),
  };
  const malformedResponses = [
    ["malformed error object", (id) => ({ id, error: {} })],
    ["string error", (id) => ({ id, error: "native install rejected" })],
    [
      "result and error",
      (id) => ({
        id,
        result: { authPolicy: "ON_USE", appsNeedingAuth: [] },
        error: { code: -32000, message: "native install rejected" },
      }),
    ],
    ["null response", () => "null"],
    [
      "malformed apps needing auth",
      (id) => ({
        id,
        result: { authPolicy: "ON_USE", appsNeedingAuth: [{ id: CODEX_LINEAR_APP_ID }] },
      }),
    ],
  ];
  for (const [name, response] of malformedResponses) {
    await t.test(name, async () => {
      let now = 0;
      class FixtureDate extends Date {
        static now() {
          return now;
        }
      }
      const result = await runCodexRuntimeHelper(
        runtime,
        (method, _params, requestId) => {
          if (method === "initialize") {
            return { serverInfo: { name: "codex", version: "0.149.0" } };
          }
          if (method === "plugin/list") {
            return codexListResponse();
          }
          if (method === "plugin/read") {
            return codexReadResponse();
          }
          if (method === "config/batchWrite") {
            return { status: "ok", version: "test-config-1" };
          }
          if (method === "plugin/install") {
            now = 1;
            return { __rawMessage: response(requestId) };
          }
          throw new Error(`unexpected request ${method}`);
        },
        {
          captureError: true,
          Date: FixtureDate,
          env: {
            OPENCLAW_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS: "1",
          },
        },
      );

      assert.equal(result.error.diagnostic, undefined);
      assert.ok(result.requests.some((request) => request.method === "plugin/install"));
    });
  }
});

test("Codex runtime cannot report installation success when its deadline expires before the first attempt", async () => {
  let now = 0;
  class FixtureDate extends Date {
    static now() {
      return now++;
    }
  }
  const result = await runCodexRuntimeHelper(
    { manifest: pluginRuntimeSpecForRevision(revision({ plugins: codexLinearPluginState() })) },
    () => assert.fail("An expired installation must not contact the app-server"),
    {
      captureError: true,
      Date: FixtureDate,
      env: { OPENCLAW_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS: "1" },
    },
  );
  assert.match(result.error?.message ?? "", /did not reach readiness/);
  assert.equal(result.value, undefined);
  assert.deepEqual(result.requests, []);
});

test("Codex runtime helper keeps pre-install native uncertainty generic", async () => {
  const state = codexLinearPluginState();
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(revision({ plugins: state })),
  };
  const result = await runCodexRuntimeHelper(
    runtime,
    (method) => {
      if (method === "initialize") {
        return { serverInfo: { name: "codex", version: "0.149.0" } };
      }
      if (method === "plugin/list") {
        return codexListResponse();
      }
      if (method === "plugin/read") {
        throw new Error("catalog read unavailable");
      }
      throw new Error(`unexpected request ${method}`);
    },
    {
      captureError: true,
      env: {
        OPENCLAW_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS: "1",
      },
    },
  );

  assert.match(result.error.message, /did not reach readiness/);
  assert.equal(result.error.diagnostic, undefined);
});

test("Codex runtime keeps disabled selected plugins default-denied while preserving install identity", async () => {
  for (const [name, selectionOverride] of [["disabled", { enabled: false }]]) {
    const state = codexLinearPluginState(selectionOverride);
    const runtime = {
      manifest: pluginRuntimeSpecForRevision(revision({ plugins: state })),
    };
    let readCount = 0;
    const installRequests = [];
    const { requests, value } = await runCodexRuntimeHelper(runtime, (method, params) => {
      if (method === "initialize") {
        return { serverInfo: { name: "codex", version: "0.149.0" } };
      }
      if (method === "plugin/list") {
        return codexListResponse();
      }
      if (method === "plugin/read") {
        readCount += 1;
        return codexReadResponse({ installed: readCount > 1, enabled: readCount > 1 });
      }
      if (method === "config/batchWrite") {
        assert.deepEqual(params, {
          edits: [
            { keyPath: "features.apps", mergeStrategy: "replace", value: true },
            { keyPath: "features.plugins", mergeStrategy: "replace", value: true },
            { keyPath: "features.remote_plugin", mergeStrategy: "replace", value: true },
            { keyPath: 'apps."_default"', mergeStrategy: "replace", value: { enabled: false } },
          ],
          reloadUserConfig: true,
        });
        return { status: "ok", version: `${name}-config-1` };
      }
      if (method === "plugin/install") {
        installRequests.push(params);
        return { authPolicy: "ON_USE", appsNeedingAuth: [] };
      }
      if (method === "config/read") {
        return {
          config: {
            features: { apps: true, plugins: true, remote_plugin: true },
            apps: { _default: { enabled: false } },
            plugins: {},
          },
          origins: {},
        };
      }
      throw new Error(`unexpected request ${method}`);
    });

    assert.deepEqual(
      installRequests,
      selectionOverride.enabled === false
        ? []
        : [
            {
              remoteMarketplaceName: "openai-curated-remote",
              pluginName: CODEX_LINEAR_REMOTE_ID,
            },
          ],
    );
    assert.deepEqual(plain(value), {
      successfulPluginIds:
        selectionOverride.enabled === false ? [] : ["codex-plugin:linear@openai-curated-remote"],
      failures: [],
    });
    assert.equal(
      requests.some(
        (request) =>
          request.method === "config/batchWrite" &&
          request.params.edits.some((edit) => edit.keyPath === `apps.${CODEX_LINEAR_APP_ID}`),
      ),
      false,
    );

    const gatewayRuntime = {
      manifest: pluginRuntimeSpecForRevision(revision({ plugins: state })),
    };
    const { files } = runOpenClawRuntimeHelper(gatewayRuntime, []);
    const effective = JSON.parse(files.get("/home/node/.openclaw/openclaw.json"));
    const bridge = effective.plugins.entries.codex.config.codexPlugins;
    assert.equal(bridge.enabled, true);
    assert.equal(bridge.allow_all_plugins, false);
    assert.deepEqual(bridge.plugins.linear, {
      enabled: false,
      marketplaceName: "openai-curated-remote",
      pluginName: "linear",
      allow_destructive_actions: "auto",
    });
  }
});

test("Codex runtime installs and reports only enabled selections in mixed plugin sets", async () => {
  const state = {
    driver: { id: "codex-plugin", implementation: "occ/codex-plugin" },
    plugins: {
      "codex-plugin:linear@openai-curated-remote": {
        enabled: true,
        toolDefaults: { approval: "provider_default" },
      },
      "codex-plugin:asana@openai-curated-remote": {
        enabled: false,
        toolDefaults: { approval: "provider_default" },
      },
    },
  };
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(revision({ plugins: state })),
  };
  const installRequests = [];
  const { requests, value } = await runCodexRuntimeHelper(runtime, (method, params) => {
    if (method === "initialize") {
      return { serverInfo: { name: "codex", version: "0.149.0" } };
    }
    if (method === "plugin/list") {
      return codexListResponse({
        plugins: [
          {
            id: CODEX_LINEAR_NATIVE_ID,
            remotePluginId: CODEX_LINEAR_REMOTE_ID,
            name: "linear",
            source: { type: "remote" },
            installed: false,
            enabled: false,
            installPolicy: "AVAILABLE",
            authPolicy: "ON_USE",
            availability: "AVAILABLE",
            version: CODEX_LINEAR_VERSION,
            interface: null,
          },
          {
            id: CODEX_ASANA_NATIVE_ID,
            remotePluginId: CODEX_ASANA_REMOTE_ID,
            name: "asana",
            source: { type: "remote" },
            installed: false,
            enabled: false,
            installPolicy: "AVAILABLE",
            authPolicy: "ON_USE",
            availability: "AVAILABLE",
            version: "2.0.0",
            interface: null,
          },
        ],
      });
    }
    if (method === "plugin/read") {
      if (params.pluginName === CODEX_LINEAR_REMOTE_ID) {
        return codexReadResponse({
          installed: installRequests.length > 0,
          enabled: installRequests.length > 0,
        });
      }
      if (params.pluginName === CODEX_ASANA_REMOTE_ID) {
        return codexReadResponse({
          nativeId: CODEX_ASANA_NATIVE_ID,
          remotePluginId: CODEX_ASANA_REMOTE_ID,
          name: "asana",
          version: "2.0.0",
          installed: false,
          enabled: false,
          apps: [{ id: CODEX_ASANA_APP_ID, name: "Asana", needsAuth: false }],
        });
      }
    }
    if (method === "plugin/install") {
      installRequests.push(params);
      assert.equal(params.pluginName, CODEX_LINEAR_REMOTE_ID);
      return { authPolicy: "ON_USE", appsNeedingAuth: [] };
    }
    if (method === "config/batchWrite") {
      assert.deepEqual(params, {
        edits: [
          { keyPath: "features.apps", mergeStrategy: "replace", value: true },
          { keyPath: "features.plugins", mergeStrategy: "replace", value: true },
          { keyPath: "features.remote_plugin", mergeStrategy: "replace", value: true },
          { keyPath: 'apps."_default"', mergeStrategy: "replace", value: { enabled: false } },
          {
            keyPath: `apps.${CODEX_LINEAR_APP_ID}`,
            mergeStrategy: "replace",
            value: { enabled: true, default_tools_approval_mode: "auto" },
          },
        ],
        reloadUserConfig: true,
      });
      return { status: "ok", version: "mixed-config-1" };
    }
    if (method === "config/read") {
      return codexConfigReadResponse();
    }
    throw new Error(`unexpected request ${method}`);
  });

  assert.deepEqual(installRequests, [
    { remoteMarketplaceName: "openai-curated-remote", pluginName: CODEX_LINEAR_REMOTE_ID },
  ]);
  assert.deepEqual(plain(value), {
    successfulPluginIds: ["codex-plugin:linear@openai-curated-remote"],
    failures: [],
  });
  assert.deepEqual(
    requests
      .filter((request) => request.method === "plugin/install")
      .map((request) => request.params.pluginName),
    [CODEX_LINEAR_REMOTE_ID],
  );
});

test("Codex gateway bridge config writes through the runtime state directory without HOME", () => {
  const state = codexLinearPluginState();
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(revision({ plugins: state })),
  };

  // The production gateway image does not define HOME, so selected Codex plugins must
  // still publish their OpenClaw bridge overlay before the separate agent installs them.
  const { calls, files } = runOpenClawRuntimeHelper(runtime, [], {
    env: { HOME: undefined, OPENCLAW_STATE_DIR: "/gateway-state/state" },
  });

  assert.deepEqual(calls, []);
  const effective = JSON.parse(files.get("/gateway-state/state/openclaw.json"));
  assert.equal(effective.plugins.entries.codex.config.codexPlugins.enabled, true);
  assert.deepEqual(effective.plugins.entries.codex.config.codexPlugins.plugins.linear, {
    enabled: true,
    marketplaceName: "openai-curated-remote",
    pluginName: "linear",
    allow_destructive_actions: "auto",
  });
});

test("Codex runtime helper fails before readiness when catalog identity is absent", async () => {
  const state = codexLinearPluginState();
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(revision({ plugins: state })),
  };
  await assert.rejects(
    () =>
      runCodexRuntimeHelper(runtime, (method) => {
        if (method === "initialize") {
          return { serverInfo: { name: "codex", version: "0.149.0" } };
        }
        if (method === "plugin/list") {
          return codexListResponse({
            nativeId: "asana@openai-curated-remote",
            remotePluginId: "plugin_asdk_app_asana",
            name: "asana",
          });
        }
        throw new Error(`unexpected request ${method}`);
      }),
    /catalog did not contain the selected plugin/,
  );
});

test("Codex runtime helper fails before readiness when native app mapping drifts", async () => {
  const state = codexLinearPluginState();
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(revision({ plugins: state })),
  };
  let readCount = 0;
  await assert.rejects(
    () =>
      runCodexRuntimeHelper(runtime, (method, params) => {
        if (method === "initialize") {
          return { serverInfo: { name: "codex", version: "0.149.0" } };
        }
        if (method === "plugin/list") {
          return codexListResponse();
        }
        if (method === "plugin/read") {
          readCount += 1;
          return codexReadResponse({
            apps: [
              {
                id: readCount === 1 ? CODEX_LINEAR_APP_ID : "asdk_app_changed",
                name: "Linear",
                needsAuth: false,
              },
            ],
          });
        }
        if (method === "config/read") {
          return codexConfigReadResponse();
        }
        if (method === "config/batchWrite") {
          return { status: "ok", version: "test-config-1" };
        }
        if (method === "plugin/install") {
          assert.deepEqual(params, {
            remoteMarketplaceName: "openai-curated-remote",
            pluginName: CODEX_LINEAR_REMOTE_ID,
          });
          return { authPolicy: "ON_USE", appsNeedingAuth: [] };
        }
        throw new Error(`unexpected request ${method}`);
      }),
    /installed app mapping does not match startup resolution/,
  );
});

test("Codex runtime helper fails before readiness when native version drifts", async () => {
  const state = codexLinearPluginState();
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(revision({ plugins: state })),
  };
  let readCount = 0;
  await assert.rejects(
    () =>
      runCodexRuntimeHelper(runtime, (method) => {
        if (method === "initialize") {
          return { serverInfo: { name: "codex", version: "0.149.0" } };
        }
        if (method === "plugin/list") {
          return codexListResponse();
        }
        if (method === "plugin/read") {
          readCount += 1;
          return codexReadResponse({ version: readCount === 1 ? "5.0.1" : "5.0.2" });
        }
        if (method === "config/read") {
          return codexConfigReadResponse();
        }
        if (method === "config/batchWrite") {
          return { status: "ok", version: "test-config-1" };
        }
        if (method === "plugin/install") {
          return { authPolicy: "ON_USE", appsNeedingAuth: [] };
        }
        throw new Error(`unexpected request ${method}`);
      }),
    /installed release metadata does not match startup resolution/,
  );
});

test("Codex runtime helper fails before readiness when effective native app config drifts", async () => {
  const state = codexLinearPluginState();
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(revision({ plugins: state })),
  };
  await assert.rejects(
    () =>
      runCodexRuntimeHelper(runtime, (method) => {
        if (method === "initialize") {
          return { serverInfo: { name: "codex", version: "0.149.0" } };
        }
        if (method === "plugin/list") {
          return codexListResponse();
        }
        if (method === "plugin/read") {
          return codexReadResponse();
        }
        if (method === "config/batchWrite") {
          return { status: "ok", version: "test-config-1" };
        }
        if (method === "plugin/install") {
          return { authPolicy: "ON_USE", appsNeedingAuth: [] };
        }
        if (method === "config/read") {
          return {
            config: {
              features: { apps: true, plugins: true, remote_plugin: true },
              apps: { _default: { enabled: true } },
              plugins: {},
            },
            origins: {},
          };
        }
        throw new Error(`unexpected request ${method}`);
      }),
    /effective config does not match admitted configuration/,
  );
});

test("Codex runtime helper checks effective app, tool, and account policy before readiness", async (t) => {
  for (const scenario of [
    {
      name: "inherited app enablement bypasses requested destructive denial",
      defaults: { approval: "all_actions" },
      driverPolicy: { destructiveEnabled: false },
      app: { default_tools_enabled: true },
      rejects: true,
    },
    {
      name: "workspace layer overrides tool enablement",
      defaults: { approval: "all_actions" },
      workspaceApp: { default_tools_enabled: true },
      rejects: true,
    },
    {
      name: "unrequested app category restriction conflicts",
      app: { open_world_enabled: false },
      rejects: true,
    },
    {
      name: "explicit workspace categories match inherited native defaults",
      defaults: { approval: "all_actions" },
      workspaceApp: { destructive_enabled: true, open_world_enabled: true },
      global: { destructive_enabled: true, open_world_enabled: true },
    },
    {
      name: "explicit destructive denial rejects native enablement",
      defaults: { approval: "all_actions" },
      driverPolicy: { destructiveEnabled: false },
      app: { destructive_enabled: true },
      rejects: true,
      error: /effective config does not match admitted configuration/,
    },
    {
      name: "unrequested app tool exposure changes",
      app: { omit_tools_from: ["search"] },
      rejects: true,
    },
    {
      name: "inherited global category default conflicts",
      global: { destructive_enabled: false },
      rejects: true,
    },
    {
      name: "unselected app enabled despite global deny",
      otherApps: { unselected: { enabled: true } },
      rejects: true,
    },
    {
      name: "serialized defaults and inherited reviewers remain valid",
      app: {
        destructive_enabled: null,
        open_world_enabled: null,
        omit_tools_from: [],
        approvals_reviewer: "user",
      },
      global: {
        destructive_enabled: true,
        open_world_enabled: true,
        approvals_reviewer: "auto_review",
      },
      otherApps: { disabled: { enabled: false } },
      tools: {},
      links: { account: { approvals_reviewer: "auto_review", default_tools_approval_mode: null } },
    },
    { name: "extra enabled tool", tools: { extra: { enabled: true } }, rejects: true },
    { name: "extra approved tool", tools: { extra: { approval_mode: "approve" } }, rejects: true },
    {
      name: "conflict after matching tool",
      tools: { matching: { enabled: false }, extra: { approval_mode: "approve" } },
      rejects: true,
    },
    {
      name: "matching defaults and serialized nulls",
      tools: {
        matching: { enabled: false, approval_mode: "prompt" },
        empty: { enabled: null, approval_mode: null },
      },
    },
    {
      name: "account approval weakens default",
      links: { account: { default_tools_approval_mode: "approve", approvals_reviewer: null } },
      rejects: true,
    },
    {
      name: "conflict after matching account",
      links: {
        matching: { default_tools_approval_mode: "prompt" },
        extra: { default_tools_approval_mode: "approve" },
      },
      rejects: true,
    },
    {
      name: "matching account default",
      links: { account: { default_tools_approval_mode: "prompt" } },
    },
    { name: "null maps inherit", tools: null, links: null },
    {
      name: "unrequested enablement bypasses native category defaults",
      defaults: { approval: "all_actions" },
      tools: { extra: { enabled: true } },
      rejects: true,
    },
    {
      name: "stricter unexpected approval also conflicts",
      defaults: { enabled: true, approval: "none" },
      nativeApproval: "approve",
      tools: { extra: { approval_mode: "prompt" } },
      rejects: true,
    },
  ]) {
    await t.test(scenario.name, async () => {
      const defaults = scenario.defaults ?? { enabled: false, approval: "all_actions" };
      const state = codexLinearPluginState({
        toolDefaults: defaults,
        ...(scenario.driverPolicy === undefined ? {} : { driverPolicy: scenario.driverPolicy }),
      });
      const runtime = { manifest: pluginRuntimeSpecForRevision(revision({ plugins: state })) };
      // A second native layer can contribute descendants absent from the user
      // config OCE replaces. Return that merged readback through the real startup helper.
      const result = await runCodexRuntimeHelper(
        runtime,
        (method, params) => {
          if (method === "initialize") {
            return { serverInfo: { name: "codex", version: "0.156.0" } };
          }
          if (method === "plugin/list") {
            return codexListResponse();
          }
          if (method === "plugin/read") {
            return codexReadResponse();
          }
          if (method === "plugin/install") {
            return { authPolicy: "ON_USE", appsNeedingAuth: [] };
          }
          if (method === "config/batchWrite") {
            return { status: "ok", version: "nested-policy" };
          }
          if (method === "config/read") {
            const response = codexConfigReadResponse({
              default_tools_enabled: defaults.enabled ?? null,
              default_tools_approval_mode: scenario.nativeApproval ?? "prompt",
              ...(scenario.driverPolicy === undefined ? {} : { destructive_enabled: false }),
              tools: scenario.tools,
              links: scenario.links,
              ...scenario.app,
              // Codex includes project layers only when config/read receives cwd.
              ...(params.cwd === "/home/node/workspace" ? scenario.workspaceApp : {}),
            });
            Object.assign(response.config.apps._default, scenario.global);
            Object.assign(response.config.apps, scenario.otherApps);
            return response;
          }
          throw new Error(`unexpected request ${method}`);
        },
        { captureError: true },
      );
      if (scenario.rejects) {
        assert.match(
          result.error?.message ?? "",
          scenario.error ?? /effective (app|tool|account) policy conflicts/,
        );
        assert.equal(result.value, undefined, "conflicting nested policy must prevent readiness");
      } else {
        assert.equal(result.error, undefined);
        assert.deepEqual(plain(result.value), {
          successfulPluginIds: ["codex-plugin:linear@openai-curated-remote"],
          failures: [],
        });
      }
    });
  }
});

test("Codex runtime helper fails before readiness when selected plugin lacks app mapping", async () => {
  const state = codexLinearPluginState();
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(revision({ plugins: state })),
  };
  await assert.rejects(
    () =>
      runCodexRuntimeHelper(runtime, (method) => {
        if (method === "initialize") {
          return { serverInfo: { name: "codex", version: "0.149.0" } };
        }
        if (method === "plugin/list") {
          return codexListResponse();
        }
        if (method === "plugin/read") {
          return codexReadResponse({ apps: [] });
        }
        throw new Error(`unexpected request ${method}`);
      }),
    /does not expose an app mapping/,
  );
});

test("OpenClaw runtime helper rejects foreign OpenClaw plugin config before native install", () => {
  const state = openClawPluginState();
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(
      revision({ harness: { id: "openclaw", version: "1.0.0", mode: "embedded" }, plugins: state }),
    ),
  };
  const result = runOpenClawRuntimeHelper(runtime, [], {
    captureError: true,
    baseConfig: {
      gateway: { port: 8080 },
      plugins: { entries: { diffs: { enabled: false, source: "foreign" } } },
    },
  });

  assert.match(result.error.message, /configuration conflicts with managed plugin selections/);
  assert.deepEqual(result.calls, []);
  assert.equal(result.files.has("/home/node/.openclaw/openclaw.json"), false);
});

test("OpenClaw runtime helper keeps install signals generic", () => {
  const state = openClawPluginState();
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(
      revision({ harness: { id: "openclaw", version: "1.0.0", mode: "embedded" }, plugins: state }),
    ),
  };
  const result = runOpenClawRuntimeHelper(
    runtime,
    [{ status: null, signal: "SIGTERM", stdout: "", stderr: "" }],
    {
      captureError: true,
      env: {
        OPENCLAW_PLUGIN_STATUS_PORT: "18791",
      },
    },
  );

  assert.match(result.error.message, /OpenClaw plugin install failed/);
  assert.equal(result.error.diagnostic, undefined);
});

test("compute rejects plugin selections that target the wrong native runtime", async () => {
  await assert.rejects(async () => {
    const state = openClawPluginState();
    pluginRuntimeSpecForRevision(revision({ plugins: state }));
  }, /require an OpenClaw Harness/);
});

test("compute fails closed when Codex plugin selections are malformed", () => {
  assert.throws(
    () =>
      pluginRuntimeSpecForRevision(
        revision({
          plugins: {
            driver: { id: "codex-plugin", implementation: "occ/codex-plugin" },
            plugins: { "codex-plugin:linear@openai-curated-remote": null },
          },
        }),
      ),
    /plugin selections are invalid/,
  );
});

function dedicatedPluginDriver() {
  const configured = kubernetesOptions();
  const { gatewayClients, ...network } = configured.network;
  return new KubernetesComputeDriver(
    {
      ...configured,
      network: { ...network, gatewayTrustedProxyCidrs: ["10.42.0.0/16"] },
      gatewayRouting: {
        hostname: "agents.example.test",
        gatewayName: "gateway",
        gatewayNamespace: "system",
        envoyNamespace: "envoy",
      },
    },
    {
      nodeEnrollment: {
        async isConnected() {
          return true;
        },
      },
    },
  );
}

function useRoutedGateway(candidate) {
  candidate.configuration = structuredClone(candidate.configuration);
  candidate.configuration.gateway = {
    ...candidate.configuration.gateway,
    trustedProxies: ["10.42.0.0/16"],
    allowRealIpFallback: true,
    auth: {
      mode: "trusted-proxy",
      trustedProxy: { userHeader: "x-occ-identity", allowUsers: ["occ-workspace-files"] },
      identityScopes: { "occ-workspace-files": ["operator.admin"] },
    },
  };
}

function enrolledNodeSecret(driver, candidate, namespace) {
  return {
    ...driver.manifest(
      "v1",
      "Secret",
      driver.workspaceNodeName(candidate),
      driver.pluginRuntimeOwnership(candidate),
      { name: namespace, plane: "execution" },
    ),
    data: {
      deviceId: Buffer.from("fixture-node").toString("base64"),
      // A current setup code, as preparation keeps renewing it.
      expiresAtMs: Buffer.from(String(Date.now() + 600_000)).toString("base64"),
    },
  };
}

test("embedded plugin preparation applies runtime egress before gateway readiness", async () => {
  const driver = createKubernetesComputeDriver(kubernetesOptions());
  const rawSlackApprovers = [
    { channel: "slack", id: "U456" },
    { channel: "slack", id: "W789" },
  ];
  const embedded = revision({
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    compute: { id: driver.id, implementation: driver.implementation },
    plugins: openClawPluginState(),
    pluginApprovers: rawSlackApprovers,
  });
  const namespace = kubernetesNamespaceName(tenant.id);
  const tenantOwnership = { namespaceId: tenant.id };
  const defaultPolicies = new Map(
    driver
      .networkPolicies(tenantOwnership, { name: namespace, plane: "execution" })
      .map((policy) => [policy.metadata.name, policy]),
  );
  const configMaps = new Map();
  const reconciled = [];

  // This fresh Agent has no prior authentication-probe workloads to retire.
  const credentialObjects = new Map();
  const cp = kubernetesGatewayNamespaceName(tenant.id);
  credentialObjects.set(`${cp}:plugin-model-key`, {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "plugin-model-key", namespace: cp, uid: "plugin-model-key-uid" },
    data: { value: Buffer.from("fixture-model").toString("base64") },
  });
  driver.clients = async () => ({
    apps: { listNamespacedDeployment: async () => ({ items: [] }) },
    core: {
      createNamespacedSecret: async ({ body }) => {
        const observed = {
          ...body,
          metadata: { ...body.metadata, uid: `${body.metadata.name}-uid`, resourceVersion: "1" },
        };
        credentialObjects.set(`${body.metadata.namespace}:${body.metadata.name}`, observed);
        return observed;
      },
      createNamespacedConfigMap: async ({ body }) => {
        configMaps.set(body.metadata.name, {
          ...structuredClone(body),
          metadata: { ...body.metadata, uid: `${body.metadata.name}-uid` },
        });
        return {};
      },
      patchNamespacedConfigMap: async ({ name, body }) => {
        configMaps.set(name, {
          ...structuredClone(body),
          metadata: { ...body.metadata, uid: `${name}-uid` },
        });
        return {};
      },
      listNamespacedPod: async () => ({ apiVersion: "v1", kind: "PodList", items: [] }),
    },
  });
  driver.resolveNamespace = async () => ({
    name: { name: namespace, plane: "execution" },
    external: false,
  });
  driver.get = async (kind, name, target) =>
    kind === "Secret"
      ? credentialObjects.get(`${target.name}:${name}`)
      : kind === "Namespace"
        ? {
            ...(name === cp
              ? driver.gatewayNamespaceManifest(tenantOwnership)
              : driver.manifest("v1", "Namespace", name, tenantOwnership)),
            status: { phase: "Active" },
          }
        : undefined;
  driver.getOwned = async (kind, name, target) => {
    if (kind === "Secret" && name !== driver.workspaceNodeName(embedded)) {
      return credentialObjects.get(`${target.name}:${name}`);
    }
    if (kind === "NetworkPolicy") {
      return defaultPolicies.get(name);
    }
    if (kind === "ConfigMap") {
      return configMaps.get(name);
    }
    return undefined;
  };
  driver.reconcile = async (object) => {
    reconciled.push(structuredClone(object));
  };
  driver.gatewayReady = async () => true;

  const readiness = await driver.prepareRevision(embedded, harnessAuthContext(embedded));
  assert.deepEqual(readiness, {
    namespaceId: embedded.namespaceId,
    agentId: embedded.agentId,
    revisionId: embedded.id,
    ready: false,
  });
  const pluginRuntimeConfigMap = reconciled.find(
    ({ kind, metadata }) => kind === "ConfigMap" && metadata.name.startsWith("plugin-runtime-"),
  );
  assert.ok(pluginRuntimeConfigMap, "Kubernetes Compute must generate plugin runtime ConfigMap");
  assert.deepEqual(
    JSON.parse(pluginRuntimeConfigMap.data[PLUGIN_RUNTIME_MANIFEST]).pluginApprovers,
    rawSlackApprovers,
  );

  const runtimePolicyIndex = reconciled.findIndex(
    ({ kind, metadata }) =>
      kind === "NetworkPolicy" && metadata.name.startsWith("allow-agent-runtime-"),
  );
  const gatewayDeploymentIndex = reconciled.findIndex(
    ({ kind, metadata }) => kind === "Deployment" && metadata.name.startsWith("gateway-"),
  );
  assert.ok(runtimePolicyIndex >= 0);
  assert.ok(gatewayDeploymentIndex >= 0);
  assert.ok(runtimePolicyIndex < gatewayDeploymentIndex);
  assert.deepEqual(reconciled[runtimePolicyIndex].spec.podSelector.matchLabels, {
    "openclaw.dev/namespace": embedded.namespaceId,
    "openclaw.dev/workload-role": "gateway",
    "openclaw.dev/agent": embedded.agentId,
    "openclaw.dev/network-profile": "broad-egress-v1",
  });
  assert.deepEqual(reconciled[runtimePolicyIndex].spec.egress[0].ports, [
    { protocol: "TCP", port: 443 },
  ]);

  const dedicatedDriver = dedicatedPluginDriver();
  const dedicated = revision({
    compute: { id: dedicatedDriver.id, implementation: dedicatedDriver.implementation },
    plugins: codexLinearPluginState({
      toolDefaults: { approval: "provider_default", reviewer: "auto" },
    }),
  });
  useRoutedGateway(dedicated);
  const dedicatedNamespace = kubernetesNamespaceName(dedicated.namespaceId);
  const dedicatedTenantOwnership = { namespaceId: dedicated.namespaceId };
  const dedicatedDefaultPolicies = new Map(
    dedicatedDriver
      .networkPolicies(dedicatedTenantOwnership, { name: dedicatedNamespace, plane: "execution" })
      .map((policy) => [policy.metadata.name, policy]),
  );
  const dedicatedReconciled = [];

  const transportName = `transport-${shortHash(dedicated.agentId)}`;
  const transport = {
    ...dedicatedDriver.manifest(
      "v1",
      "Secret",
      transportName,
      { namespaceId: tenant.id, agentId: dedicated.agentId },
      { name: cp, plane: "execution" },
    ),
    type: "Opaque",
    data: { "app-server-token": Buffer.from("fixture-transport").toString("base64") },
  };
  transport.metadata.uid = "transport-uid";
  credentialObjects.set(`${cp}:${transportName}`, transport);
  dedicatedDriver.clients = async () => ({
    apps: { listNamespacedDeployment: async () => ({ items: [] }) },
    core: {
      createNamespacedSecret: async ({ body }) => {
        const observed = {
          ...body,
          metadata: { ...body.metadata, uid: `${body.metadata.name}-uid`, resourceVersion: "1" },
        };
        credentialObjects.set(`${body.metadata.namespace}:${body.metadata.name}`, observed);
        return observed;
      },
      replaceNamespacedSecret: async ({ body }) => {
        credentialObjects.set(`${body.metadata.namespace}:${body.metadata.name}`, body);
        return body;
      },
      createNamespacedConfigMap: async () => ({}),
      patchNamespacedConfigMap: async () => ({}),
      listNamespacedPod: async () => ({ apiVersion: "v1", kind: "PodList", items: [] }),
    },
  });
  dedicatedDriver.resolveNamespace = async () => ({
    name: { name: dedicatedNamespace, plane: "execution" },
    external: false,
  });
  dedicatedDriver.get = async (kind, name, target) =>
    kind === "Secret"
      ? credentialObjects.get(`${target.name}:${name}`)
      : kind === "Namespace"
        ? {
            ...(name === cp
              ? dedicatedDriver.gatewayNamespaceManifest(dedicatedTenantOwnership)
              : dedicatedDriver.manifest("v1", "Namespace", name, dedicatedTenantOwnership)),
            status: { phase: "Active" },
          }
        : undefined;
  dedicatedDriver.getOwned = async (kind, name, target) => {
    if (kind === "Secret" && name !== dedicatedDriver.workspaceNodeName(dedicated)) {
      return credentialObjects.get(`${target.name}:${name}`);
    }
    if (kind === "Secret") {
      return enrolledNodeSecret(dedicatedDriver, dedicated, dedicatedNamespace);
    }
    if (kind === "NetworkPolicy") {
      return dedicatedDefaultPolicies.get(name);
    }
    if (kind === "Deployment" && name.startsWith("agent-") && name.includes("-rev-")) {
      const reconciledDeployment = dedicatedReconciled.find(
        (object) => object.kind === "Deployment" && object.metadata?.name === name,
      );
      if (reconciledDeployment === undefined) {
        return undefined;
      }
      return {
        ...structuredClone(reconciledDeployment),
        metadata: { ...reconciledDeployment.metadata, generation: 1 },
        status: { observedGeneration: 1, readyReplicas: 1 },
      };
    }
    return undefined;
  };
  dedicatedDriver.reconcile = async (object) => {
    dedicatedReconciled.push(structuredClone(object));
  };
  dedicatedDriver.gatewayReady = async () => true;
  dedicatedDriver.pluginRuntimeStatus = async () => ({
    failures: [],
    successfulPluginIds: ["codex-plugin:linear@openai-curated-remote"],
  });

  const dedicatedReadiness = await dedicatedDriver.prepareRevision(
    dedicated,
    harnessAuthContext(dedicated),
  );
  assert.deepEqual(dedicatedReadiness, {
    namespaceId: dedicated.namespaceId,
    agentId: dedicated.agentId,
    revisionId: dedicated.id,
    ready: true,
  });
  const runtimeGatewayPolicyIndex = dedicatedReconciled.findIndex(
    ({ kind, metadata }) =>
      kind === "NetworkPolicy" && metadata.name.startsWith("allow-gateway-agent-"),
  );
  const runtimeAgentPolicyIndex = dedicatedReconciled.findIndex(
    ({ kind, metadata }) =>
      kind === "NetworkPolicy" && metadata.name.startsWith("allow-agent-runtime-"),
  );
  const statusGatewayPolicyIndex = dedicatedReconciled.findIndex(
    ({ kind, metadata }) =>
      kind === "NetworkPolicy" && metadata.name.startsWith("allow-plugin-status-gateway-"),
  );
  const statusAgentPolicyIndex = dedicatedReconciled.findIndex(
    ({ kind, metadata }) =>
      kind === "NetworkPolicy" && metadata.name.startsWith("allow-plugin-status-agent-"),
  );
  const dedicatedAgentServiceIndex = dedicatedReconciled.findIndex(
    ({ kind, metadata, spec }) =>
      kind === "Service" &&
      metadata.name.startsWith("agent-") &&
      spec.selector?.["openclaw.dev/revision"] === dedicated.id,
  );
  const dedicatedGatewayDeploymentIndex = dedicatedReconciled.findIndex(
    ({ kind, metadata }) => kind === "Deployment" && metadata.name.startsWith("gateway-"),
  );
  assert.ok(runtimeGatewayPolicyIndex >= 0);
  assert.ok(runtimeAgentPolicyIndex >= 0);
  assert.ok(statusGatewayPolicyIndex >= 0);
  assert.ok(statusAgentPolicyIndex >= 0);
  assert.ok(dedicatedAgentServiceIndex >= 0);
  assert.ok(dedicatedGatewayDeploymentIndex >= 0);
  assert.ok(runtimeGatewayPolicyIndex < dedicatedGatewayDeploymentIndex);
  assert.ok(runtimeAgentPolicyIndex < dedicatedGatewayDeploymentIndex);
  assert.ok(statusGatewayPolicyIndex < dedicatedGatewayDeploymentIndex);
  assert.ok(statusAgentPolicyIndex < dedicatedGatewayDeploymentIndex);
  assert.ok(dedicatedAgentServiceIndex < dedicatedGatewayDeploymentIndex);
  assert.deepEqual(dedicatedReconciled[runtimeGatewayPolicyIndex].metadata.namespace, cp);
  assert.deepEqual(dedicatedReconciled[runtimeGatewayPolicyIndex].spec.podSelector.matchLabels, {
    "openclaw.dev/namespace": dedicated.namespaceId,
    "openclaw.dev/workload-role": "gateway",
    "openclaw.dev/agent": dedicated.agentId,
    "openclaw.dev/network-profile": "broad-egress-v1",
  });
  assert.deepEqual(dedicatedReconciled[runtimeGatewayPolicyIndex].spec.egress[0].ports, [
    { protocol: "TCP", port: 18790 },
    { protocol: "TCP", port: 18791 },
  ]);
  assert.deepEqual(
    dedicatedReconciled[runtimeAgentPolicyIndex].metadata.namespace,
    dedicatedNamespace,
  );
  assert.deepEqual(dedicatedReconciled[runtimeAgentPolicyIndex].spec.podSelector.matchLabels, {
    "openclaw.dev/namespace": dedicated.namespaceId,
    "openclaw.dev/workload-role": "agent",
    "openclaw.dev/agent": dedicated.agentId,
    "openclaw.dev/revision": dedicated.id,
    "openclaw.dev/network-profile": "broad-egress-v1",
  });
  assert.deepEqual(dedicatedReconciled[runtimeAgentPolicyIndex].spec.ingress[0].ports, [
    { protocol: "TCP", port: 18790 },
    { protocol: "TCP", port: 18791 },
  ]);
});

test("Kubernetes plugin runtime status requires the exact ready Pod report", async (t) => {
  const driver = createKubernetesComputeDriver(kubernetesOptions());
  const candidate = revision({
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    compute: { id: driver.id, implementation: driver.implementation },
    plugins: openClawPluginState(),
  });
  const namespace = kubernetesNamespaceName(tenant.id);
  const pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "gateway-plugin-status",
      namespace,
      uid: "pod-plugin-status-1",
      labels: {
        "openclaw.dev/agent": candidate.agentId,
        "openclaw.dev/revision": candidate.id,
        "openclaw.dev/workload-role": "gateway",
      },
    },
  };
  const readyReport = {
    revisionId: candidate.id,
    container: "gateway",
    startupId: "startup-plugin-status-1",
    podUid: "pod-plugin-status-1",
    phase: "ready",
    successfulPluginIds: ["occ-plugin:diffs"],
    failures: [],
  };

  for (const [name, response, expected] of [
    ["missing proxy", Object.assign(new Error("not found"), { code: 404 }), "not-ready"],
    ["starting phase", { ...readyReport, phase: "starting" }, "not-ready"],
    ["wrong revision", { ...readyReport, revisionId: "another-revision" }, "rejects"],
    ["wrong container", { ...readyReport, container: "agent" }, "rejects"],
    ["malformed report", { ...readyReport, successfulPluginIds: "occ-plugin:diffs" }, "rejects"],
    ["ready", readyReport, readyReport],
  ]) {
    await t.test(name, async () => {
      driver.clients = async () => ({
        core: {
          listNamespacedPod: async () => ({ apiVersion: "v1", kind: "PodList", items: [pod] }),
          connectGetNamespacedPodProxyWithPath: async () => {
            if (response instanceof Error) {
              throw response;
            }
            return response;
          },
        },
      });
      if (expected === "rejects") {
        await assert.rejects(
          () =>
            driver.pluginRuntimeStatus(
              candidate,
              { name: namespace, plane: "execution" },
              "gateway",
              [],
            ),
          DependencyUnavailableError,
        );
      } else {
        const status = await driver.pluginRuntimeStatus(
          candidate,
          { name: namespace, plane: "execution" },
          "gateway",
          [],
        );
        assert.deepEqual(status, expected === "not-ready" ? undefined : expected);
      }
    });
  }
});

test("Kubernetes startup failure evidence requires the exact runtime Pod report", async () => {
  const driver = createKubernetesComputeDriver(kubernetesOptions());
  const candidate = revision({
    compute: { id: driver.id, implementation: driver.implementation },
    plugins: codexNoPluginState(),
  });
  const namespace = kubernetesNamespaceName(tenant.id);
  const pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "agent-runtime-status",
      namespace,
      uid: "pod-runtime-status-1",
      labels: {
        "openclaw.dev/agent": candidate.agentId,
        "openclaw.dev/revision": candidate.id,
        "openclaw.dev/workload-role": "agent",
      },
    },
    status: {
      containerStatuses: [{ name: "agent", containerID: "containerd://runtime-status-1" }],
    },
  };
  const failure = {
    component: "agent",
    check: "model-probe",
    checkedAt: "2026-09-20T12:00:00.000Z",
    code: "MODEL_PROBE_FAILED",
  };
  const requests = [];
  driver.clients = async () => ({
    core: {
      listNamespacedPod: async () => ({ apiVersion: "v1", kind: "PodList", items: [pod] }),
      connectGetNamespacedPodProxyWithPath: async (request) => {
        requests.push(request);
        return JSON.stringify({
          revisionId: candidate.id,
          container: "agent",
          podUid: "pod-runtime-status-1",
          runtimeFailure: failure,
        });
      },
    },
  });

  const observed = await driver.safeRuntimeFailureObservation(candidate, {
    name: namespace,
    plane: "execution",
  });

  assert.deepEqual(observed, failure);
  assert.deepEqual(requests, [
    {
      name: "agent-runtime-status:18791",
      namespace,
      path: "openclaw/runtime/status",
    },
  ]);
});

test("gateway runtime status maps native Slack channel status without provider data", async () => {
  const revisionId = "revision-plugin-compute-1";
  let statusHandler;
  let channelStatus;
  let channelStatusCalls = 0;
  let holdChannelStatusResponse = false;
  let pendingChannelStatusListeners;
  let childTimeout;
  const childKillSignals = [];
  const sandbox = {
    AbortController,
    AbortSignal,
    Buffer,
    JSON,
    URL,
    console: { error() {} },
    process: {
      env: {
        OPENCLAW_AGENT_REVISION_ID: revisionId,
        OPENCLAW_GATEWAY_PORT: "8080",
        OPENCLAW_RUNTIME_STATUS_CONTAINER: "gateway",
        OPENCLAW_RUNTIME_STATUS_PORT: "18791",
        OPENCLAW_POD_UID: "pod-gateway-status-1",
      },
      on() {},
      exit(code) {
        throw new Error(`unexpected process exit ${code}`);
      },
    },
    setInterval() {
      return { unref() {} };
    },
    setTimeout(callback, timeoutMs) {
      if (timeoutMs === 6000) {
        childTimeout = callback;
      }
      return { unref() {} };
    },
    clearTimeout() {},
    require(specifier) {
      if (specifier === "node:http") {
        return {
          createServer(handler) {
            statusHandler = handler;
            return { listen() {} };
          },
        };
      }
      if (specifier === "node:fs") {
        return {
          cpSync() {},
          existsSync() {
            return false;
          },
          lstatSync() {
            return { isDirectory: () => true };
          },
          mkdirSync() {},
          readFileSync() {
            throw new Error("unexpected file read");
          },
          readdirSync() {
            return [];
          },
          rmSync() {},
          writeFileSync() {},
        };
      }
      if (specifier === "node:child_process") {
        return {
          spawn(command, args) {
            if (args?.[1] !== "channels") {
              return { on() {}, kill() {} };
            }
            assert.equal(command, "node");
            assert.deepEqual(plain(args), [
              "/app/openclaw.mjs",
              "channels",
              "status",
              "--channel",
              "slack",
              "--json",
              "--probe",
              "--timeout",
              "5000",
            ]);
            channelStatusCalls += 1;
            const listeners = {};
            const child = {
              stdout: {
                on(event, listener) {
                  listeners["stdout:" + event] = listener;
                },
              },
              kill(signal) {
                childKillSignals.push(signal);
              },
              on(event, listener) {
                listeners[event] = listener;
              },
            };
            if (holdChannelStatusResponse) {
              pendingChannelStatusListeners = listeners;
            } else {
              queueMicrotask(() => {
                listeners["stdout:data"]?.(Buffer.from(JSON.stringify(channelStatus)));
                listeners.close?.(0, null);
              });
            }
            return child;
          },
        };
      }
      return nodeRequire(specifier);
    },
  };

  vm.runInNewContext(GATEWAY_RUNTIME_ENTRYPOINT, sandbox);
  await Promise.resolve();

  assert.ok(statusHandler);
  const ready = await readRuntimeStatusFromHandler(statusHandler);
  assert.equal(ready.revisionId, revisionId);
  assert.equal(channelStatusCalls, 0);
  const assertSlackDiagnostics = async (status, expected, description) => {
    channelStatus = status;
    const diagnostics = await readRuntimeChannelChecksFromHandler(statusHandler);
    assert.deepEqual(
      diagnostics.checks.map(({ component }) => component),
      ["gateway", "gateway", "gateway"],
      `${description} components`,
    );
    assert.deepEqual(
      diagnostics.checks.map(({ check, state, code }) => ({ check, state, code })),
      expected,
      description,
    );
  };

  await assertSlackDiagnostics(
    {
      channels: { slack: { configured: true, connected: true } },
      channelAccounts: {
        slack: [{ accountId: "default", configured: true, connected: true, probe: { ok: true } }],
      },
      channelDefaultAccountId: { slack: "default" },
    },
    [
      { check: "configuration", state: "succeeded", code: undefined },
      { check: "authentication", state: "succeeded", code: undefined },
      { check: "connectivity", state: "succeeded", code: undefined },
    ],
    "connected",
  );

  await assertSlackDiagnostics(
    { configOnly: true, configuredChannels: [] },
    [
      { check: "configuration", state: "failed", code: "NOT_CONFIGURED" },
      { check: "authentication", state: "unknown", code: undefined },
      { check: "connectivity", state: "unknown", code: undefined },
    ],
    "disabled",
  );

  await assertSlackDiagnostics(
    { gatewayReachable: false, configOnly: true, configuredChannels: ["slack"] },
    [
      { check: "configuration", state: "succeeded", code: undefined },
      { check: "authentication", state: "unknown", code: "UNAVAILABLE" },
      { check: "connectivity", state: "unknown", code: "UNAVAILABLE" },
    ],
    "configured but gateway unavailable",
  );

  for (const error of [
    "invalid_auth",
    "An API error occurred: invalid_auth; code: slack_webapi_platform_error; slack error: invalid_auth",
  ]) {
    await assertSlackDiagnostics(
      {
        channels: { slack: { configured: true } },
        channelAccounts: {
          slack: [{ accountId: "default", configured: true, probe: { ok: false, error } }],
        },
        channelDefaultAccountId: { slack: "default" },
      },
      [
        { check: "configuration", state: "succeeded", code: undefined },
        { check: "authentication", state: "failed", code: "AUTHENTICATION_FAILED" },
        { check: "connectivity", state: "unknown", code: "INCOMPATIBLE_RESPONSE" },
      ],
      `invalid auth ${error}`,
    );
  }

  await assertSlackDiagnostics(
    {
      channels: { slack: { configured: true, connected: true } },
      channelAccounts: {
        slack: [
          {
            accountId: "default",
            configured: true,
            connected: true,
            probe: { ok: false, error: "probe timed out after 5000ms" },
          },
        ],
      },
      channelDefaultAccountId: { slack: "default" },
    },
    [
      { check: "configuration", state: "succeeded", code: undefined },
      { check: "authentication", state: "unknown", code: "PROBE_FAILED" },
      { check: "connectivity", state: "succeeded", code: undefined },
    ],
    "probe timeout with connected transport",
  );

  await assertSlackDiagnostics(
    {
      channels: { slack: { configured: true, connected: true } },
      channelAccounts: {
        slack: [{ accountId: "secondary", configured: true, connected: true, probe: { ok: true } }],
      },
      channelDefaultAccountId: { slack: "missing-default" },
    },
    [
      { check: "configuration", state: "unknown", code: "INCOMPATIBLE_RESPONSE" },
      { check: "authentication", state: "unknown", code: "INCOMPATIBLE_RESPONSE" },
      { check: "connectivity", state: "unknown", code: "INCOMPATIBLE_RESPONSE" },
    ],
    "missing default account",
  );

  await assertSlackDiagnostics(
    { configOnly: true },
    [
      { check: "configuration", state: "unknown", code: "INCOMPATIBLE_RESPONSE" },
      { check: "authentication", state: "unknown", code: "INCOMPATIBLE_RESPONSE" },
      { check: "connectivity", state: "unknown", code: "INCOMPATIBLE_RESPONSE" },
    ],
    "malformed config fallback",
  );

  holdChannelStatusResponse = true;
  const timedOutRequest = readRuntimeChannelChecksFromHandler(statusHandler);
  await Promise.resolve();
  assert.equal(typeof childTimeout, "function");
  childTimeout();
  assert.deepEqual(childKillSignals.slice(-1), ["SIGTERM"]);
  pendingChannelStatusListeners.close?.(null, "SIGTERM");
  const timedOutDiagnostics = await timedOutRequest;
  assert.deepEqual(
    timedOutDiagnostics.checks.map(({ state, code }) => ({ state, code })),
    Array.from({ length: 3 }, () => ({ state: "unknown", code: "UNAVAILABLE" })),
  );

  const requestListeners = {};
  const responseListeners = {};
  const abortedRequest = statusHandler(
    {
      method: "GET",
      url: "/openclaw/runtime/diagnostics",
      on(event, listener) {
        requestListeners[event] = listener;
      },
      off() {},
    },
    {
      writeHead() {
        throw new Error("aborted response must not write headers");
      },
      end() {
        throw new Error("aborted response must not write a body");
      },
      on(event, listener) {
        responseListeners[event] = listener;
      },
      off() {},
    },
  );
  await Promise.resolve();
  assert.ok(pendingChannelStatusListeners);
  requestListeners.aborted();
  assert.deepEqual(childKillSignals.slice(-1), ["SIGTERM"]);
  pendingChannelStatusListeners.close?.(null, "SIGTERM");
  await abortedRequest;
  responseListeners.close?.();
  assert.equal(channelStatusCalls, 10);
});

test("Codex runtime gates startup and readiness on a successful native authentication turn", async (t) => {
  const started = { type: "turn.started" };
  const assistant = { type: "item.completed", item: { type: "agent_message", text: "READY" } };
  const completed = { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } };
  const advisory = {
    type: "item.completed",
    item: { type: "error", message: "Model catalog metadata unavailable" },
  };
  const recoveredStreamError = {
    type: "error",
    message: "Reconnecting... 1/3 stream disconnected before completion",
  };
  const recoveredRetryingSamplingError = {
    type: "error",
    message: "Reconnecting... 2/3 stream disconnected - retrying sampling request",
  };
  const scenarios = [
    {
      name: "delayed retry uses only the remaining budget",
      probeTimeouts: 2,
      retryDelayMs: 30500,
      expectedTimeouts: [30000, 500],
      failureCode: "MODEL_PROBE_TIMEOUT",
    },
    {
      name: "expired retry budget starts no process",
      probeTimeouts: 1,
      retryDelayMs: 32000,
      expiredBudget: true,
      failureCode: "MODEL_PROBE_TIMEOUT",
    },
    {
      name: "tool output followed by timeout is not retried",
      probeError: "ETIMEDOUT",
      events: [started, { type: "item.completed", item: { type: "command_execution" } }],
    },
    {
      name: "rejection followed by timeout is not retried",
      probeError: "ETIMEDOUT",
      events: [{ type: "error", message: "authentication rejected" }],
    },
    {
      name: "malformed output followed by timeout is not retried",
      probeError: "ETIMEDOUT",
      probeOutput: "not-json",
    },
    {
      name: "model timeout recovers on the second attempt",
      probeTimeouts: 1,
      events: [started, assistant, completed],
      ready: true,
    },
    {
      name: "model timeout exhausts two attempts",
      probeTimeouts: 2,
      failureCode: "MODEL_PROBE_TIMEOUT",
    },
    { name: "external SIGKILL is not a timeout or retried", probeSignal: "SIGKILL" },
    { name: "malformed model output is not retried", probeOutput: "not-json" },
    { name: "failed login", loginStatus: 1 },
    {
      name: "API-key login timeout is not retried",
      loginTimeouts: 1,
      loginAttempts: 1,
      loginFailed: true,
    },
    {
      name: "access-token spawn failure is not retried",
      pat: true,
      loginError: "ENOENT",
      loginFailed: true,
    },
    { name: "access-token login refusal is not retried", pat: true, loginStatus: 1 },
    {
      // Native text observed from codex-cli 0.154 with a revoked access token.
      name: "access-token login credential rejection is a deterministic authentication failure",
      pat: true,
      loginStatus: 1,
      loginStderr:
        "Error logging in with access token: personal access token metadata request failed with status 403 Forbidden\n",
      failureCode: "AUTHENTICATION_FAILED",
    },
    {
      name: "access-token login transport error remains a login failure",
      pat: true,
      loginStatus: 1,
      loginStderr:
        "Error logging in with access token: failed to request personal access token metadata: error sending request for url (https://auth.openai.com/)\n",
    },
    {
      name: "access-token login recovers one timeout before probing",
      pat: true,
      loginTimeouts: 1,
      events: [started, assistant, completed],
      ready: true,
    },
    { name: "access-token login stops after three timeouts", pat: true, loginTimeouts: 3 },
    {
      name: "service account token uses native access-token login before probe and clears credentials",
      pat: true,
      events: [started, assistant, completed],
      ready: true,
    },
    {
      name: "nonfatal advisory followed by completed assistant turn",
      events: [started, advisory, assistant, completed],
      ready: true,
    },
    {
      name: "recovered native stream error during active turn",
      events: [started, recoveredStreamError, assistant, completed],
      ready: true,
    },
    {
      name: "recovered native sampling retry error during active turn",
      events: [started, recoveredRetryingSamplingError, assistant, completed],
      ready: true,
    },
    {
      name: "fatal top-level error despite assistant output",
      events: [started, assistant, { type: "error", message: "authentication failed" }, completed],
    },
    {
      name: "reconnecting error with auth marker remains fatal",
      events: [
        started,
        {
          type: "error",
          message: "Reconnecting... 1/3 stream disconnected before completion after 401 auth",
        },
        assistant,
        completed,
      ],
    },
    {
      name: "recovered native stream error with provider detail during active turn",
      events: [
        started,
        {
          type: "error",
          message:
            "Reconnecting... 1/5 (stream disconnected before completion: connection reset by peer)",
        },
        assistant,
        completed,
      ],
      ready: true,
    },
    {
      name: "reconnecting error after completed turn remains fatal",
      events: [started, assistant, completed, recoveredStreamError],
    },
    {
      name: "reconnecting error before the turn starts remains fatal",
      events: [recoveredStreamError, started, assistant, completed],
    },
    ...[
      [
        "with auth detail",
        "Reconnecting... 1/3 stream disconnected before completion: 401 Unauthorized",
      ],
      [
        "with credential detail",
        "Reconnecting... 1/3 stream disconnected before completion: invalid credential",
      ],
      ["with an unknown reason", "Reconnecting... 1/3 request failed with status 500"],
      ["with trailing reason text", "Reconnecting... 1/3 stream disconnected before completionist"],
      ["not at the start", "Error: Reconnecting... 1/3 stream disconnected before completion"],
      ["past its retry limit", "Reconnecting... 4/3 stream disconnected before completion"],
      ["above the retry budget", "Reconnecting... 1/50 stream disconnected before completion"],
      ["with a zero attempt", "Reconnecting... 0/3 stream disconnected before completion"],
    ].map(([description, message]) => ({
      name: `reconnecting error ${description} remains fatal`,
      events: [started, { type: "error", message }, assistant, completed],
    })),
    {
      name: "unbounded reconnecting errors remain fatal",
      events: [
        started,
        ...Array.from({ length: 11 }, () => recoveredStreamError),
        assistant,
        completed,
      ],
    },
    {
      name: "failed turn",
      events: [
        started,
        assistant,
        { type: "turn.failed", error: { message: "authentication failed" } },
      ],
    },
    {
      // Native terminal event observed from codex-cli 0.154 with an invalid API key.
      name: "provider credential rejection is a deterministic authentication failure",
      events: [
        started,
        {
          type: "error",
          message: "unexpected status 401 Unauthorized: Incorrect API key provided",
        },
        {
          type: "turn.failed",
          error: { message: "unexpected status 401 Unauthorized: Incorrect API key provided" },
        },
      ],
      probeStatus: 1,
      failureCode: "AUTHENTICATION_FAILED",
    },
    {
      name: "provider server error is not an authentication failure",
      events: [
        started,
        { type: "turn.failed", error: { message: "unexpected status 503 Service Unavailable" } },
      ],
      probeStatus: 1,
    },
    { name: "completed turn without visible assistant", events: [started, advisory, completed] },
    {
      name: "tool event despite completed assistant turn",
      events: [
        started,
        {
          type: "item.completed",
          item: { type: "command_execution", command: "echo READY", exit_code: 0 },
        },
        assistant,
        completed,
      ],
    },
    {
      name: "nonzero native exit despite completed assistant turn",
      events: [started, assistant, completed],
      probeStatus: 1,
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, () => {
      const directory = mkdtempSync(join(tmpdir(), "openclaw-plugin-ready-"));
      const marker = join(directory, "ready");
      writeFileSync(marker, "stale\n", { mode: 0o600 });
      try {
        const diagnostics = [];
        const idleTimers = [];
        const revisionId = "revision-runtime-auth-gate";
        let statusHandler;
        let appServerStarts = 0;
        let nativeCalls = 0;
        let loginCalls = 0;
        let probeCalls = 0;
        let clock = 0;
        const retryTimers = [];
        const sandbox = {
          URL,
          setTimeout(callback, delay) {
            retryTimers.push({ callback, delay });
          },
          console: {
            error(message) {
              diagnostics.push(message);
            },
          },
          setInterval(callback, delay) {
            idleTimers.push({ callback, delay });
          },
          process: {
            env: {
              CODEX_HOME: join(directory, "codex"),
              CODEX_LOGIN_MODE: scenario.pat ? "codex_pat" : "api_key",
              ...(scenario.pat
                ? { CODEX_ACCESS_TOKEN: "at-fixture-token" }
                : { OPENAI_API_KEY: "fixture-api-key" }),
              OPENCLAW_HARNESS_MODEL: "codex/gpt-4.1",
              OPENCLAW_AGENT_REVISION_ID: revisionId,
              OPENCLAW_RUNTIME_STATUS_CONTAINER: "agent",
              OPENCLAW_RUNTIME_STATUS_PORT: "18791",
              OPENCLAW_POD_UID: "pod-runtime-auth-gate",
              OPENCLAW_PLUGIN_READY_MARKER: marker,
              APP_SERVER_TOKEN: "fixture-transport-token",
              APP_SERVER_PORT: "4500",
            },
            on() {},
            exit() {
              assert.fail("startup must either remain unready or start the app server");
            },
          },
          require(specifier) {
            if (specifier === "node:perf_hooks") {
              return { performance: { now: () => clock } };
            }
            if (specifier === "node:fs") {
              return {
                mkdirSync() {},
                mkdtempSync: () => mkdtempSync(join(directory, "probe-")),
                rmSync,
                readFileSync() {
                  throw new Error("no plugin runtime payload is configured");
                },
                writeFileSync,
              };
            }
            if (specifier === "node:http") {
              return {
                createServer(handler) {
                  statusHandler = handler;
                  return { listen() {} };
                },
              };
            }
            if (specifier === "node:child_process") {
              return {
                spawnSync(command, args, options) {
                  nativeCalls++;
                  const isLogin = args.includes("login");
                  if (isLogin) {
                    loginCalls++;
                  }
                  if (isLogin && scenario.pat) {
                    assert.equal(command, "codex");
                    assert.deepEqual(Array.from(args), [
                      "-c",
                      "cli_auth_credentials_store=file",
                      "login",
                      "--with-access-token",
                    ]);
                    assert.equal(options.input, "at-fixture-token");
                  }
                  if (!isLogin) {
                    assert.equal(sandbox.process.env.CODEX_ACCESS_TOKEN, undefined);
                    assert.equal(sandbox.process.env.OPENAI_API_KEY, undefined);
                    assert.equal(sandbox.process.env.CODEX_CHATGPT_WORKSPACE_ID, undefined);
                  }
                  // Substitute only native process output; execute the production
                  // login/probe parser and readiness control flow unmodified.
                  if (isLogin) {
                    if (scenario.loginError) {
                      return { status: null, error: { code: scenario.loginError } };
                    }
                    if (loginCalls <= (scenario.loginTimeouts ?? 0)) {
                      return { status: null, signal: "SIGKILL", error: { code: "ETIMEDOUT" } };
                    }
                    return {
                      status: scenario.loginStatus ?? 0,
                      ...(scenario.loginStderr ? { stderr: scenario.loginStderr } : {}),
                    };
                  }
                  probeCalls++;
                  assert.ok(options.timeout > 0 && options.timeout <= 30000);
                  if (scenario.expectedTimeouts) {
                    assert.equal(options.timeout, scenario.expectedTimeouts[probeCalls - 1]);
                  }
                  if (probeCalls <= (scenario.probeTimeouts ?? 0)) {
                    clock += options.timeout;
                    return { status: null, signal: "SIGKILL", error: { code: "ETIMEDOUT" } };
                  }
                  if (scenario.probeSignal) {
                    return { status: null, signal: scenario.probeSignal };
                  }
                  return {
                    status: scenario.probeStatus ?? 0,
                    ...(scenario.probeError ? { error: { code: scenario.probeError } } : {}),
                    stdout:
                      scenario.probeOutput ??
                      scenario.events.map((event) => JSON.stringify(event)).join("\n"),
                  };
                },
                spawn(_command, args) {
                  assert.ok(args.includes("app-server"));
                  appServerStarts++;
                  return { on() {}, kill() {} };
                },
              };
            }
            return nodeRequire(specifier);
          },
        };
        vm.runInNewContext(AGENT_RUNTIME_ENTRYPOINT, sandbox);
        if (scenario.probeTimeouts) {
          assert.equal(appServerStarts, 0);
          assert.equal(existsSync(marker), false);
          assert.equal(readRuntimeStatusFromHandler(statusHandler).runtimeFailure, undefined);
          assert.equal(retryTimers.length, 1);
          assert.equal(retryTimers[0].delay, 1000);
          clock += scenario.retryDelayMs ?? 1000;
          retryTimers[0].callback();
          assert.equal(retryTimers.length, 1, "exhaustion must not schedule another retry");
        } else {
          assert.equal(retryTimers.length, 0);
        }
        const loginFailed =
          scenario.loginFailed || scenario.loginStatus === 1 || scenario.loginTimeouts === 3;
        assert.equal(
          loginCalls,
          scenario.loginAttempts ?? Math.min((scenario.loginTimeouts ?? 0) + 1, 3),
        );
        assert.equal(
          nativeCalls,
          loginCalls +
            (loginFailed ? 0 : scenario.probeTimeouts && !scenario.expiredBudget ? 2 : 1),
        );
        const jsonDiagnostics = diagnostics
          .filter((message) => message.startsWith("{"))
          .map(JSON.parse);
        const probeDiagnostics = jsonDiagnostics.filter(
          ({ event }) => event !== "runtime.startup_phase",
        );
        const startupPhases = jsonDiagnostics.filter(
          ({ event }) => event === "runtime.startup_phase",
        );
        assert.equal(probeDiagnostics.length, probeCalls);
        for (const [index, diagnostic] of probeDiagnostics.entries()) {
          assert.equal(diagnostic.event, "codex.model_probe");
          assert.equal(diagnostic.attempt, index + 1);
          assert.ok(diagnostic.elapsedMs >= 0);
        }
        if (scenario.probeTimeouts) {
          assert.equal(probeDiagnostics[0].code, "MODEL_PROBE_TIMEOUT");
        }
        // Startup timing reports fixed phase names and outcomes only: no model,
        // provider, credential or path value can appear in these lines.
        assert.deepEqual(
          startupPhases.map(({ phase, outcome }) => [phase, outcome]),
          [
            ["codex-login", loginFailed ? "failed" : "ok"],
            ...(loginFailed ? [] : [["model-probe", scenario.ready ? "ok" : "failed"]]),
            ...(scenario.ready ? [["native-spawn", "ok"]] : []),
          ],
        );
        for (const phase of startupPhases) {
          assert.deepEqual(Object.keys(phase), [
            "event",
            "container",
            "phase",
            "outcome",
            "ms",
            "sinceStartMs",
          ]);
          assert.equal(phase.container, "agent");
          assert.ok(Number.isInteger(phase.ms) && phase.ms >= 0);
          assert.ok(phase.sinceStartMs >= phase.ms);
        }
        const failureMessages = diagnostics.filter((message) => !message.startsWith("{"));
        assert.ok(statusHandler);
        const runtimeStatus = readRuntimeStatusFromHandler(statusHandler);
        assert.equal(runtimeStatus.revisionId, revisionId);
        assert.equal(runtimeStatus.container, "agent");
        assert.equal(runtimeStatus.podUid, "pod-runtime-auth-gate");
        if (scenario.ready) {
          assert.equal(appServerStarts, 1);
          assert.deepEqual(failureMessages, []);
          assert.equal(probeDiagnostics.at(-1).code, "READY");
          assert.equal(idleTimers.length, 0);
          assert.equal(readFileSync(marker, "utf8"), "ready\n");
          assert.equal(runtimeStatus.runtimeFailure, undefined);
        } else {
          assert.equal(appServerStarts, 0);
          assert.deepEqual(failureMessages, ["Harness model authentication probe failed."]);
          assert.equal(idleTimers.length, 1);
          assert.equal(typeof idleTimers[0].callback, "function");
          assert.ok(idleTimers[0].delay > 0);
          assert.equal(existsSync(marker), false);
          assert.equal(runtimeStatus.runtimeFailure.component, "agent");
          assert.equal(runtimeStatus.runtimeFailure.check, loginFailed ? "login" : "model-probe");
          assert.equal(
            runtimeStatus.runtimeFailure.code,
            scenario.failureCode ?? (loginFailed ? "LOGIN_FAILED" : "MODEL_PROBE_FAILED"),
          );
          assert.match(runtimeStatus.runtimeFailure.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

test("Codex agent app-server uses a per-startup plugin status token", () => {
  const directory = mkdtempSync(join(tmpdir(), "oce-plugin-token-"));
  const marker = join(directory, "ready");
  const baseToken = "capability-token-test-value";
  const revisionId = "revision-plugin-compute-1";
  let statusHandler;
  let appServerSpawn;
  const files = new Map();
  try {
    const sandbox = {
      AbortSignal,
      Buffer,
      JSON,
      URL,
      console: { error() {} },
      process: {
        env: {
          PATH: process.env.PATH,
          APP_SERVER_PORT: "4321",
          APP_SERVER_TOKEN: baseToken,
          CODEX_HOME: join(directory, "codex-home"),
          CODEX_LOGIN_MODE: "api_key",
          OPENAI_API_KEY: "fixture-api-key",
          OPENCLAW_HARNESS_MODEL: "openai/gpt-5",
          OPENCLAW_AGENT_REVISION_ID: revisionId,
          OPENCLAW_PLUGIN_STATUS_CONTAINER: "agent",
          OPENCLAW_PLUGIN_STATUS_PORT: "18791",
          OPENCLAW_POD_UID: "pod-agent-token-1",
          OPENCLAW_PLUGIN_READY_MARKER: marker,
        },
        on() {},
        exit(code) {
          throw new Error(`unexpected process exit ${code}`);
        },
      },
      setTimeout() {
        return { unref() {} };
      },
      clearTimeout() {},
      require(specifier) {
        if (specifier === "node:http") {
          return {
            createServer(handler) {
              statusHandler = handler;
              return { listen() {} };
            },
          };
        }
        if (specifier === "node:fs") {
          return {
            existsSync(path) {
              return files.has(path);
            },
            mkdirSync() {},
            mkdtempSync,
            readFileSync(path) {
              if (!files.has(path)) {
                throw new Error(`Missing mocked file: ${path}`);
              }
              return files.get(path);
            },
            rmSync(path) {
              files.delete(path);
            },
            writeFileSync(path, data) {
              files.set(path, String(data));
            },
          };
        }
        if (specifier === "node:child_process") {
          let nativeCalls = 0;
          return {
            spawnSync() {
              nativeCalls += 1;
              return nativeCalls === 1
                ? { status: 0 }
                : {
                    status: 0,
                    stdout: [
                      { type: "thread.started" },
                      { type: "turn.started" },
                      {
                        type: "item.completed",
                        item: { type: "agent_message", text: "READY" },
                      },
                      { type: "turn.completed" },
                    ]
                      .map((event) => JSON.stringify(event))
                      .join("\n"),
                  };
            },
            spawn(command, args) {
              appServerSpawn = { command, args };
              return { on() {}, kill() {} };
            },
          };
        }
        return nodeRequire(specifier);
      },
    };

    vm.runInNewContext(AGENT_RUNTIME_ENTRYPOINT, sandbox);

    assert.ok(statusHandler);
    assert.equal(appServerSpawn.command, "codex");
    const status = readStatusFromHandler(statusHandler);
    assert.equal(status.revisionId, revisionId);
    assert.equal(status.container, "agent");
    assert.equal(status.podUid, "pod-agent-token-1");
    assert.match(status.startupId, /\S/);
    const expectedToken = pluginAppServerToken(baseToken, revisionId, status.startupId);
    const digestArgument =
      appServerSpawn.args[appServerSpawn.args.indexOf("--ws-token-sha256") + 1];
    assert.equal(digestArgument, sha256(expectedToken));
    assert.notEqual(digestArgument, sha256(baseToken));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// On a first dedicated deploy the Gateway starts alongside its Harness, and the
// agent Service lists the Harness only once it is ready. The Gateway waits for
// the Harness plugin status without a deadline: it neither exits nor reports
// ready until the Harness really reports.
test("Codex gateway supervisor waits for its Harness plugin status without a deadline", async () => {
  const revisionId = "revision-plugin-compute-1";
  const runtime = pluginRuntimeSpecForRevision(
    revision({
      plugins: codexLinearPluginState({
        toolDefaults: { approval: "provider_default", reviewer: "auto" },
      }),
    }),
  );
  const files = new Map([
    [
      "/etc/openclaw/openclaw.json",
      JSON.stringify({
        gateway: { port: 8080 },
        plugins: { installs: { keep: { source: "npm" } }, load: { paths: ["existing"] } },
        tools: { alsoAllow: ["existing-tool"] },
      }),
    ],
  ]);
  const peerStatus = {
    revisionId,
    container: "agent",
    startupId: "agent-startup-1",
    podUid: "agent-pod-1",
    phase: "ready",
    successfulPluginIds: ["codex-plugin:linear@openai-curated-remote"],
    failures: [],
  };
  // Harness not ready yet: no Service endpoint, then an unready status port,
  // then a Harness still installing its plugins.
  const unavailable = [
    () => Promise.reject(new TypeError("fetch failed")),
    () => Promise.resolve({ status: 503, json: async () => ({}) }),
    () =>
      Promise.resolve({ status: 200, json: async () => ({ ...peerStatus, phase: "starting" }) }),
  ];
  let peerReady = false;
  let fetches = 0;
  const waits = [];
  const errors = [];
  const exits = [];
  let now = 0;
  let statusHandler;
  let child;
  class FixtureDate extends Date {
    static now() {
      return now;
    }
  }
  const sandbox = {
    AbortSignal,
    Buffer,
    JSON,
    URL,
    Date: FixtureDate,
    console: { error: (message) => errors.push(message) },
    fetch(url) {
      assert.equal(
        String(url),
        "http://agent-fixture.harness.svc:18791/openclaw/plugin-runtime/status",
      );
      fetches++;
      if (peerReady) {
        return Promise.resolve({ status: 200, json: async () => peerStatus });
      }
      return unavailable[(fetches - 1) % unavailable.length]();
    },
    process: {
      env: {
        APP_SERVER_TOKEN: "base-app-server-token",
        APP_SERVER_URL: "ws://agent-fixture.harness.svc:4500",
        HOME: "/home/node",
        OPENCLAW_AGENT_REVISION_ID: revisionId,
        OPENCLAW_CONFIG_PATH: "/etc/openclaw/openclaw.json",
        OPENCLAW_GATEWAY_PORT: "8080",
        OPENCLAW_PLUGIN_RUNTIME_JSON: JSON.stringify({ manifest: runtime }),
        OPENCLAW_PLUGIN_STATUS_CONTAINER: "gateway",
        OPENCLAW_PLUGIN_STATUS_PORT: "18791",
        OPENCLAW_POD_UID: "gateway-pod-1",
      },
      on() {},
      exit(code) {
        exits.push(code);
      },
    },
    setInterval() {
      return { unref() {} };
    },
    setTimeout(callback, delay) {
      if (delay === 250) {
        waits.push(callback);
      }
      return { unref() {} };
    },
    clearTimeout() {},
    require(specifier) {
      if (specifier === "node:http") {
        return {
          createServer(handler) {
            statusHandler = handler;
            return { listen() {} };
          },
        };
      }
      if (specifier === "node:fs") {
        return {
          existsSync(path) {
            return files.has(path);
          },
          mkdirSync() {},
          readFileSync(path) {
            if (!files.has(path)) {
              throw new Error(`Missing mocked file: ${path}`);
            }
            return files.get(path);
          },
          writeFileSync(path, data) {
            files.set(path, String(data));
          },
        };
      }
      if (specifier === "node:child_process") {
        return {
          spawn() {
            child = { kill() {}, on() {} };
            return child;
          },
          spawnSync() {
            throw new Error("gateway bridge must not run native plugin installers for Codex peers");
          },
        };
      }
      return nodeRequire(specifier);
    },
  };

  vm.runInNewContext(GATEWAY_RUNTIME_ENTRYPOINT, sandbox);
  // Twelve failed reads, each ten minutes apart: far beyond the former 60 s deadline
  // and the controller's own 900 s convergence deadline.
  for (let attempt = 0; attempt < 12; attempt++) {
    await waitForCondition("the next peer status retry", () => waits.length > 0);
    assert.equal(child, undefined, "the Gateway must not start before its Harness reports");
    assert.equal(readStatusFromHandler(statusHandler).phase, "starting");
    now += 10 * 60_000;
    waits.shift()();
  }
  await waitForCondition("the next peer status retry", () => waits.length > 0);
  assert.equal(fetches, 13);
  assert.deepEqual(exits, [], "a slow Harness must not exit the Gateway supervisor");
  assert.equal(child, undefined);
  assert.equal(readStatusFromHandler(statusHandler).phase, "starting");
  // The wait reports why it is still waiting, never a token or the peer address.
  assert.ok(errors.length > 0);
  for (const message of errors) {
    assert.match(message, /^Waiting for Harness plugin runtime status: /);
    assert.doesNotMatch(message, /base-app-server-token|agent-fixture/);
  }

  peerReady = true;
  waits.shift()();
  await waitForCondition("gateway supervisor start", () => child);
  assert.equal(fetches, 14);
  assert.deepEqual(exits, []);
  const status = readStatusFromHandler(statusHandler);
  assert.equal(status.phase, "ready");
  assert.deepEqual(status.successfulPluginIds, peerStatus.successfulPluginIds);
  assert.equal(
    sandbox.process.env.APP_SERVER_TOKEN,
    pluginAppServerToken("base-app-server-token", revisionId, peerStatus.startupId),
  );
});

test("Codex gateway supervisor exits when the peer Agent plugin failure set changes", async () => {
  const peerHttp = await import("node:http");
  const revisionId = "revision-plugin-compute-1";
  const initialFailure = {
    pluginId: "codex-plugin:linear@openai-curated-remote",
    code: "PLUGIN_AUTH_REQUIRED",
  };
  let peerStatus = {
    revisionId,
    container: "agent",
    startupId: "agent-startup-1",
    podUid: "agent-pod-1",
    phase: "ready",
    successfulPluginIds: [],
    failures: [initialFailure],
  };
  const peerServer = peerHttp.createServer((request, response) => {
    assert.equal(request.url, "/openclaw/plugin-runtime/status");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(peerStatus));
  });
  await new Promise((resolve) => peerServer.listen(0, "127.0.0.1", resolve));
  const peerPort = peerServer.address().port;

  const runtime = pluginRuntimeSpecForRevision(
    revision({
      plugins: codexLinearPluginState({
        toolDefaults: { approval: "provider_default", reviewer: "auto" },
      }),
    }),
  );
  const files = new Map([
    [
      "/etc/openclaw/openclaw.json",
      JSON.stringify({
        gateway: { port: 8080 },
        plugins: { installs: { keep: { source: "npm" } }, load: { paths: ["existing"] } },
        tools: { alsoAllow: ["existing-tool"] },
      }),
    ],
  ]);
  const intervals = [];
  let statusHandler;
  let child;
  try {
    const sandbox = {
      AbortSignal,
      Buffer,
      JSON,
      URL,
      console: { error() {} },
      fetch,
      process: {
        env: {
          APP_SERVER_TOKEN: "base-app-server-token",
          APP_SERVER_URL: `ws://127.0.0.1:${peerPort}`,
          HOME: "/home/node",
          OPENCLAW_AGENT_REVISION_ID: revisionId,
          OPENCLAW_CONFIG_PATH: "/etc/openclaw/openclaw.json",
          OPENCLAW_GATEWAY_PORT: "8080",
          OPENCLAW_PLUGIN_RUNTIME_JSON: JSON.stringify({ manifest: runtime }),
          OPENCLAW_PLUGIN_STATUS_CONTAINER: "gateway",
          OPENCLAW_PLUGIN_STATUS_PORT: String(peerPort),
          OPENCLAW_POD_UID: "gateway-pod-1",
        },
        on() {},
        exit() {},
      },
      setInterval(callback) {
        intervals.push(callback);
        return { unref() {} };
      },
      setTimeout() {
        return { unref() {} };
      },
      clearTimeout() {},
      require(specifier) {
        if (specifier === "node:http") {
          return {
            createServer(handler) {
              statusHandler = handler;
              return { listen() {} };
            },
          };
        }
        if (specifier === "node:fs") {
          return {
            existsSync(path) {
              return files.has(path);
            },
            mkdirSync() {},
            readFileSync(path) {
              if (!files.has(path)) {
                throw new Error(`Missing mocked file: ${path}`);
              }
              return files.get(path);
            },
            writeFileSync(path, data) {
              files.set(path, String(data));
            },
          };
        }
        if (specifier === "node:child_process") {
          return {
            spawn(command, args) {
              assert.equal(command, "node");
              assert.deepEqual(plain(args), ["/app/openclaw.mjs", "gateway", "--port", "8080"]);
              child = {
                killed: [],
                kill(signal) {
                  this.killed.push(signal);
                },
                on() {},
              };
              return child;
            },
            spawnSync() {
              throw new Error(
                "gateway bridge must not run native plugin installers for Codex peers",
              );
            },
          };
        }
        return nodeRequire(specifier);
      },
    };

    vm.runInNewContext(GATEWAY_RUNTIME_ENTRYPOINT, sandbox);
    await waitForCondition("gateway supervisor start", () => child);
    assert.equal(intervals.length, 1);

    const effective = JSON.parse(files.get("/home/node/.openclaw/openclaw.json"));
    assert.equal(effective.plugins.entries.codex.config.codexPlugins.plugins.linear.enabled, false);
    assert.deepEqual(readStatusFromHandler(statusHandler).failures, [initialFailure]);

    peerStatus = {
      ...peerStatus,
      startupId: "agent-startup-2",
      podUid: "agent-pod-2",
      failures: [],
    };
    await intervals[0]();

    assert.deepEqual(child.killed, ["SIGTERM"]);
    const restarting = readStatusFromHandler(statusHandler);
    assert.equal(restarting.phase, "starting");
    assert.deepEqual(restarting.failures, [initialFailure]);
  } finally {
    await new Promise((resolve) => peerServer.close(resolve));
  }
});

for (const withBroker of [false, true]) {
  test(`Codex gateway supervisor applies plugin-free bridge runtime (broker=${withBroker})`, async () => {
    const revisionId = "revision-plugin-compute-1";
    const runtime = pluginRuntimeSpecForRevision(
      revision({ plugins: codexNoPluginState() }),
      withBroker
        ? {
            host: "git.oce.svc",
            domains: { "github.com": "allow", "*.oce.svc": "deny" },
          }
        : undefined,
    );
    const files = new Map([
      [
        "/etc/openclaw/openclaw.json",
        JSON.stringify({
          gateway: { port: 8080 },
          plugins: { entries: { codex: { enabled: true, config: { keep: true } } } },
        }),
      ],
    ]);
    const intervals = [];
    let statusHandler;
    let child;
    const sandbox = {
      AbortSignal,
      Buffer,
      JSON,
      URL,
      console: { error() {} },
      fetch,
      process: {
        env: {
          APP_SERVER_TOKEN: "base-app-server-token",
          HOME: "/home/node",
          OPENCLAW_AGENT_REVISION_ID: revisionId,
          OPENCLAW_CONFIG_PATH: "/etc/openclaw/openclaw.json",
          OPENCLAW_GATEWAY_PORT: "8080",
          OPENCLAW_PLUGIN_RUNTIME_JSON: JSON.stringify({ manifest: runtime }),
          OPENCLAW_PLUGIN_STATUS_CONTAINER: "gateway",
          OPENCLAW_PLUGIN_STATUS_PORT: "18791",
          OPENCLAW_POD_UID: "gateway-pod-1",
        },
        on() {},
        exit() {},
      },
      setInterval(callback) {
        intervals.push(callback);
        return { unref() {} };
      },
      setTimeout() {
        return { unref() {} };
      },
      clearTimeout() {},
      require(specifier) {
        if (specifier === "node:http") {
          return {
            createServer(handler) {
              statusHandler = handler;
              return { listen() {} };
            },
          };
        }
        if (specifier === "node:fs") {
          return {
            existsSync(path) {
              return files.has(path);
            },
            mkdirSync() {},
            readFileSync(path) {
              if (!files.has(path)) {
                throw new Error(`Missing mocked file: ${path}`);
              }
              return files.get(path);
            },
            writeFileSync(path, data) {
              files.set(path, String(data));
            },
          };
        }
        if (specifier === "node:child_process") {
          return {
            spawn(command, args) {
              assert.equal(command, "node");
              assert.deepEqual(plain(args), ["/app/openclaw.mjs", "gateway", "--port", "8080"]);
              child = { kill() {}, on() {} };
              return child;
            },
            spawnSync() {
              throw new Error("plugin-free bridge must not run native plugin installers");
            },
          };
        }
        return nodeRequire(specifier);
      },
    };

    vm.runInNewContext(GATEWAY_RUNTIME_ENTRYPOINT, sandbox);
    await waitForCondition("gateway supervisor start", () => child);
    assert.equal(intervals.length, 0);

    const effective = JSON.parse(files.get("/home/node/.openclaw/openclaw.json"));
    assert.equal(effective.plugins.entries.codex.config.keep, true);
    assert.equal(effective.plugins.entries.codex.config.codexPlugins, undefined);
    assert.deepEqual(
      effective.plugins.entries.codex.config.appServer.networkProxy,
      withBroker
        ? {
            enabled: true,
            mode: "full",
            allowLocalBinding: true,
            readOnlyPaths: [
              "/app/node_modules/openclaw",
              "/home/node/.openclaw/plugin-skills",
              "/home/node/openclaw-runtime-assets/plugin-skills",
              "/opt/oce/repository-credentials",
              "/run/oce/repository-credentials",
            ],
            domains: { "github.com": "allow", "*.oce.svc": "deny", "git.oce.svc": "allow" },
          }
        : { readOnlyPaths: ["/app/node_modules/openclaw"] },
    );
    const status = readStatusFromHandler(statusHandler);
    assert.deepEqual(status, {
      revisionId,
      container: "gateway",
      startupId: status.startupId,
      podUid: "gateway-pod-1",
      phase: "ready",
      successfulPluginIds: [],
      failures: [],
    });
  });
}

test("Kubernetes dedicated Codex agent mounts plugin-free runtime without plugin status auth", async () => {
  const driver = createKubernetesComputeDriver(kubernetesOptions());
  const candidate = revision({ plugins: codexNoPluginState() });
  const runtime = pluginRuntimeSpecForRevision(candidate);
  const deployment = driver.deployment(
    "agent-plugin-compute-rev",
    {
      namespaceId: tenant.id,
      agentId: agent.id,
      revisionId: "revision-plugin-compute-1",
    },
    { name: kubernetesNamespaceName(tenant.id), plane: "execution" },
    "openclaw-enterprise/agent-fixture:local",
    "agent-plugin-compute",
    "agent",
    {},
    "info",
    undefined,
    false,
    undefined,
    driver.harnessAuthForRevision(candidate, harnessAuthContext(candidate), {
      name: kubernetesGatewayNamespaceName(tenant.id),
      plane: "control",
    }),
    [],
    [],
    { name: "plugin-runtime-agent-plugin-compute", runtime },
  );

  const pod = deployment.spec.template.spec;
  assert.equal(
    pod.volumes.some((volume) => volume.configMap?.name === "plugin-runtime-agent-plugin-compute"),
    true,
  );
  const container = pod.containers[0];
  assert.equal(
    container.env.some((variable) => variable.name === PLUGIN_RUNTIME_MANIFEST_ENVIRONMENT),
    true,
  );
  assert.equal(
    container.env.some((variable) => variable.name === PLUGIN_RUNTIME_CODEX_CONFIG_ENVIRONMENT),
    true,
  );
  assert.equal(
    container.env.some((variable) => variable.name === PLUGIN_RUNTIME_READY_MARKER_ENVIRONMENT),
    true,
  );
  assert.deepEqual(
    container.env
      .filter((variable) =>
        [
          "OPENCLAW_AGENT_REVISION_ID",
          "OPENCLAW_RUNTIME_STATUS_CONTAINER",
          "OPENCLAW_RUNTIME_STATUS_PORT",
          "OPENCLAW_PLUGIN_STATUS_CONTAINER",
          "OPENCLAW_PLUGIN_STATUS_PORT",
        ].includes(variable.name),
      )
      .map((variable) => [variable.name, variable.value]),
    [
      ["OPENCLAW_AGENT_REVISION_ID", "revision-plugin-compute-1"],
      ["OPENCLAW_RUNTIME_STATUS_CONTAINER", "agent"],
      ["OPENCLAW_RUNTIME_STATUS_PORT", "18791"],
    ],
  );
  assert.deepEqual(
    container.ports.map((port) => [port.name, port.containerPort]),
    [
      ["websocket", 18790],
      ["plugin-status", 18791],
    ],
  );
});

for (const withBroker of [false, true]) {
  test(`Kubernetes dedicated Codex gateway mounts plugin-free runtime (broker=${withBroker})`, async () => {
    const driver = createKubernetesComputeDriver(kubernetesOptions());
    const runtime = pluginRuntimeSpecForRevision(
      revision({ plugins: codexNoPluginState() }),
      withBroker
        ? {
            host: "git.oce.svc",
            domains: {},
          }
        : undefined,
    );
    const deployment = driver.deployment(
      "gateway-plugin-compute-rev",
      {
        namespaceId: tenant.id,
        agentId: agent.id,
        revisionId: "revision-plugin-compute-1",
      },
      { name: "oce-plugin-compute", plane: "execution" },
      "openclaw-enterprise/gateway-fixture:local",
      "gateway-plugin-compute",
      "gateway",
      {},
      "info",
      driver.gatewayConfiguration(revision(), undefined, {
        name: "oce-plugin-compute",
        plane: "execution",
      }),
      false,
      undefined,
      undefined,
      [],
      [],
      { name: "plugin-runtime-gateway-plugin-compute", runtime },
    );

    const pod = deployment.spec.template.spec;
    assert.equal(
      pod.volumes.some(
        (volume) => volume.configMap?.name === "plugin-runtime-gateway-plugin-compute",
      ),
      true,
    );
    const container = pod.containers[0];
    assert.equal(
      container.env.some((variable) => variable.name === PLUGIN_RUNTIME_MANIFEST_ENVIRONMENT),
      true,
    );
    assert.equal(
      container.env.some((variable) => variable.name === PLUGIN_RUNTIME_CODEX_CONFIG_ENVIRONMENT),
      false,
    );
    assert.equal(
      container.env.some((variable) => variable.name === PLUGIN_RUNTIME_READY_MARKER_ENVIRONMENT),
      false,
    );
    assert.equal(
      container.env.some((variable) => variable.name === "OPENCLAW_PLUGIN_STATUS_CONTAINER"),
      false,
    );
  });
}

test("Kubernetes embedded OpenClaw gateway mounts broker-only Codex bridge runtime", async () => {
  const driver = createKubernetesComputeDriver(kubernetesOptions());
  const candidate = revision({
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    plugins: codexNoPluginState(),
  });
  const runtime = pluginRuntimeSpecForRevision(candidate, {
    host: "git.oce.svc",
    domains: {},
  });
  const deployment = driver.deployment(
    "gateway-plugin-compute-rev",
    {
      namespaceId: tenant.id,
      agentId: agent.id,
      revisionId: "revision-plugin-compute-1",
    },
    { name: "oce-plugin-compute", plane: "execution" },
    "openclaw-enterprise/gateway-fixture:local",
    "gateway-plugin-compute",
    "gateway",
    {},
    "info",
    driver.gatewayConfiguration(candidate, undefined, {
      name: "oce-plugin-compute",
      plane: "execution",
    }),
    true,
    candidate.servicePrincipalId,
    driver.harnessAuthForRevision(
      candidate,
      {
        harnessAuth: {
          ...candidate.harnessAuth,
          backendRef: {
            namespaceName: "oce-plugin-compute",
            name: "plugin-model-key",
            key: "value",
            uid: "plugin-model-key-uid",
          },
        },
      },
      { name: "oce-plugin-compute", plane: "execution" },
    ),
    [],
    [],
    { name: "plugin-runtime-gateway-plugin-compute", runtime },
  );

  const pod = deployment.spec.template.spec;
  assert.equal(
    pod.volumes.some(
      (volume) => volume.configMap?.name === "plugin-runtime-gateway-plugin-compute",
    ),
    true,
  );
  const container = pod.containers[0];
  assert.equal(
    container.env.some((variable) => variable.name === PLUGIN_RUNTIME_MANIFEST_ENVIRONMENT),
    true,
  );
  assert.equal(
    container.env.some((variable) => variable.name === PLUGIN_RUNTIME_CODEX_CONFIG_ENVIRONMENT),
    false,
  );
  assert.equal(
    container.env.some((variable) => variable.name === PLUGIN_RUNTIME_READY_MARKER_ENVIRONMENT),
    false,
  );
});

test("Kubernetes dedicated successor readiness preserves the stable Agent Service until activation", async () => {
  const driver = dedicatedPluginDriver();
  const predecessor = revision({
    id: "revision-plugin-compute-predecessor",
    revision: 1,
    compute: { id: driver.id, implementation: driver.implementation },
    plugins: codexNoPluginState(),
  });
  const candidate = revision({
    id: "revision-plugin-compute-successor",
    revision: 2,
    compute: { id: driver.id, implementation: driver.implementation },
    plugins: codexNoPluginState(),
  });
  useRoutedGateway(candidate);
  useRoutedGateway(predecessor);
  const namespace = kubernetesNamespaceName(tenant.id);
  const tenantOwnership = { namespaceId: tenant.id };
  const agentName = `agent-${shortHash(candidate.agentId)}`;
  const predecessorRevisionName = `${agentName}-rev-${shortHash(predecessor.id)}`;
  const defaultPolicies = new Map(
    driver
      .networkPolicies(tenantOwnership, { name: namespace, plane: "execution" })
      .map((policy) => [policy.metadata.name, policy]),
  );
  const reconciled = [];
  let candidateRevisionName;

  const credentialObjects = new Map();
  const cp = kubernetesGatewayNamespaceName(tenant.id);
  credentialObjects.set(`${cp}:plugin-model-key`, {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "plugin-model-key", namespace: cp, uid: "plugin-model-key-uid" },
    data: { value: Buffer.from("fixture-model").toString("base64") },
  });
  const transportName = `transport-${shortHash(candidate.agentId)}`;
  const transport = {
    ...driver.manifest(
      "v1",
      "Secret",
      transportName,
      { namespaceId: tenant.id, agentId: candidate.agentId },
      { name: cp, plane: "execution" },
    ),
    type: "Opaque",
    data: { "app-server-token": Buffer.from("fixture-transport").toString("base64") },
  };
  transport.metadata.uid = "transport-uid";
  credentialObjects.set(`${cp}:${transportName}`, transport);
  driver.clients = async () => ({
    apps: { listNamespacedDeployment: async () => ({ items: [] }) },
    core: {
      createNamespacedSecret: async ({ body }) => {
        const observed = {
          ...body,
          metadata: { ...body.metadata, uid: `${body.metadata.name}-uid`, resourceVersion: "1" },
        };
        credentialObjects.set(`${body.metadata.namespace}:${body.metadata.name}`, observed);
        return observed;
      },
      createNamespacedConfigMap: async () => ({}),
      patchNamespacedConfigMap: async () => ({}),
      listNamespacedPod: async () => ({ apiVersion: "v1", kind: "PodList", items: [] }),
    },
  });
  driver.resolveNamespace = async () => ({
    name: { name: namespace, plane: "execution" },
    external: false,
  });
  driver.get = async (kind, name, target) =>
    kind === "Secret"
      ? credentialObjects.get(`${target.name}:${name}`)
      : kind === "Namespace"
        ? {
            ...(name === cp
              ? driver.gatewayNamespaceManifest(tenantOwnership)
              : driver.manifest("v1", "Namespace", name, tenantOwnership)),
            status: { phase: "Active" },
          }
        : undefined;
  driver.getOwned = async (kind, name, target) => {
    if (kind === "Secret" && name !== driver.workspaceNodeName(candidate)) {
      return credentialObjects.get(`${target.name}:${name}`);
    }
    if (kind === "Secret") {
      return enrolledNodeSecret(driver, candidate, namespace);
    }
    if (kind === "NetworkPolicy") {
      return defaultPolicies.get(name);
    }
    if (kind === "Deployment" && name.startsWith("gateway-")) {
      return {
        ...driver.manifest(
          "apps/v1",
          "Deployment",
          name,
          { ...tenantOwnership, agentId: candidate.agentId },
          { name: namespace, plane: "execution" },
        ),
        metadata: {
          name,
          annotations: {
            "openclaw.dev/agent-revision": String(predecessor.revision),
            "openclaw.dev/agent-revision-id": predecessor.id,
          },
          generation: 1,
        },
        spec: {
          replicas: 1,
          template: {
            spec: {
              volumes: [
                {
                  name: "openclaw-configuration",
                  configMap: { name: "predecessor-config" },
                },
              ],
            },
          },
        },
        status: { observedGeneration: 1, readyReplicas: 1 },
      };
    }
    if (kind === "Deployment" && name.startsWith("agent-") && name.includes("-rev-")) {
      candidateRevisionName = name;
      const reconciledCandidate = reconciled.find(
        (object) => object.kind === "Deployment" && object.metadata?.name === name,
      );
      return {
        ...(reconciledCandidate === undefined
          ? driver.manifest(
              "apps/v1",
              "Deployment",
              name,
              {
                ...tenantOwnership,
                agentId: candidate.agentId,
                servicePrincipalId: candidate.servicePrincipalId,
                revisionId: candidate.id,
              },
              { name: namespace, plane: "execution" },
            )
          : structuredClone(reconciledCandidate)),
        metadata: { ...(reconciledCandidate?.metadata ?? { name }), generation: 1 },
        spec: { ...(reconciledCandidate?.spec ?? {}), replicas: 1 },
        status: { observedGeneration: 1, readyReplicas: 1 },
      };
    }
    if (kind === "Service" && name.startsWith("agent-")) {
      return driver.service(
        name,
        {
          ...tenantOwnership,
          agentId: candidate.agentId,
          servicePrincipalId: candidate.servicePrincipalId,
        },
        { name: namespace, plane: "execution" },
        { "app.kubernetes.io/name": predecessorRevisionName },
      );
    }
    return undefined;
  };
  driver.reconcile = async (object) => {
    reconciled.push(structuredClone(object));
  };
  driver.gatewayReady = async () => true;

  const readiness = await driver.prepareRevision(candidate, harnessAuthContext(candidate));
  assert.deepEqual(readiness, {
    namespaceId: candidate.namespaceId,
    agentId: candidate.agentId,
    revisionId: candidate.id,
    ready: true,
  });
  assert.equal(typeof candidateRevisionName, "string");
  assert.equal(
    reconciled.some(
      ({ kind, metadata, spec }) =>
        kind === "Service" &&
        metadata.name === agentName &&
        spec.selector?.["app.kubernetes.io/name"] === candidateRevisionName,
    ),
    false,
  );
});

test("Kubernetes dedicated Codex gateway mounts bridge runtime and prior plugin warnings", async () => {
  const driver = createKubernetesComputeDriver(kubernetesOptions());
  const runtime = pluginRuntimeSpecForRevision(
    revision({
      plugins: codexLinearPluginState({
        toolDefaults: { approval: "provider_default", reviewer: "auto" },
      }),
    }),
  );
  const deployment = driver.deployment(
    "gateway-plugin-compute-rev",
    {
      namespaceId: tenant.id,
      agentId: agent.id,
      revisionId: "revision-plugin-compute-1",
    },
    { name: "oce-plugin-compute", plane: "execution" },
    "openclaw-enterprise/gateway-fixture:local",
    "gateway-plugin-compute",
    "gateway",
    {},
    "info",
    driver.gatewayConfiguration(revision(), undefined, {
      name: "oce-plugin-compute",
      plane: "execution",
    }),
    false,
    undefined,
    undefined,
    [],
    [],
    { name: "plugin-runtime-gateway-plugin-compute", runtime },
    [{ pluginId: "codex-plugin:linear@openai-curated-remote", code: "PLUGIN_AUTH_REQUIRED" }],
  );

  const pod = deployment.spec.template.spec;
  assert.equal(
    pod.volumes.some(
      (volume) => volume.configMap?.name === "plugin-runtime-gateway-plugin-compute",
    ),
    true,
  );
  const container = pod.containers[0];
  assert.equal(
    container.env.some((variable) => variable.name === PLUGIN_RUNTIME_MANIFEST_ENVIRONMENT),
    true,
  );
  assert.equal(
    container.env.some((variable) => variable.name === PLUGIN_RUNTIME_CODEX_CONFIG_ENVIRONMENT),
    false,
  );
  assert.equal(
    container.env.some((variable) => variable.name === PLUGIN_RUNTIME_READY_MARKER_ENVIRONMENT),
    false,
  );
  assert.deepEqual(
    container.env
      .filter((variable) =>
        [
          "OPENCLAW_AGENT_REVISION_ID",
          "OPENCLAW_PLUGIN_STATUS_CONTAINER",
          "OPENCLAW_PLUGIN_STATUS_PORT",
          "OPENCLAW_PLUGIN_FAILURES_JSON",
        ].includes(variable.name),
      )
      .map((variable) => [variable.name, variable.value]),
    [
      ["OPENCLAW_AGENT_REVISION_ID", "revision-plugin-compute-1"],
      ["OPENCLAW_PLUGIN_STATUS_CONTAINER", "gateway"],
      ["OPENCLAW_PLUGIN_STATUS_PORT", "18791"],
      [
        "OPENCLAW_PLUGIN_FAILURES_JSON",
        JSON.stringify([
          {
            pluginId: "codex-plugin:linear@openai-curated-remote",
            code: "PLUGIN_AUTH_REQUIRED",
          },
        ]),
      ],
    ],
  );
  assert.deepEqual(
    container.ports.map((port) => [port.name, port.containerPort]),
    [
      ["http", 8080],
      ["plugin-status", 18791],
    ],
  );
});

test("Kubernetes plugin-free Codex gateway receives explicit Agent approvers", () => {
  const driver = createKubernetesComputeDriver(kubernetesOptions());
  for (const pluginApprovers of [undefined, []]) {
    const candidate = revision({ pluginApprovers });
    const runtime = pluginRuntimeSpecForRevision(candidate);
    const deployment = driver.deployment(
      "gateway-plugin-free",
      { namespaceId: tenant.id, agentId: agent.id, revisionId: candidate.id },
      { name: "oce-plugin-compute", plane: "execution" },
      "openclaw-enterprise/gateway-fixture:local",
      "gateway-plugin-compute",
      "gateway",
      {},
      "info",
      driver.gatewayConfiguration(candidate, undefined, {
        name: "oce-plugin-compute",
        plane: "execution",
      }),
      false,
      undefined,
      undefined,
      [],
      [],
      { name: "plugin-runtime-gateway-plugin-free", runtime },
    );
    const pod = deployment.spec.template.spec;
    assert.equal(
      pod.volumes.some((volume) => volume.configMap?.name === "plugin-runtime-gateway-plugin-free"),
      true,
    );
  }
});
