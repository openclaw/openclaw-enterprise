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
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  AGENT_RUNTIME_ENTRYPOINT,
  GATEWAY_RUNTIME_ENTRYPOINT,
  PLUGIN_RUNTIME_HELPERS,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { startupPhaseHelper } from "../../apps/controller/src/drivers/compute/runtime-startup.ts";
import {
  PLUGIN_RUNTIME_CODEX_CONFIG,
  PLUGIN_RUNTIME_CODEX_CONFIG_ENVIRONMENT,
  PLUGIN_RUNTIME_ENVIRONMENT,
  PLUGIN_RUNTIME_MANIFEST,
  PLUGIN_RUNTIME_MANIFEST_ENVIRONMENT,
  PLUGIN_RUNTIME_READY_MARKER_ENVIRONMENT,
  pluginRuntimeConfigMapData,
  pluginRuntimeEarlierConfigMapData,
  pluginRuntimeEnvironment,
  pluginRuntimeSpecForRevision,
} from "../../apps/controller/src/drivers/compute/plugin-runtime.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import { DependencyUnavailableError } from "../../packages/occ/src/errors.ts";

import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { runOpenClawRuntimeHelper } from "../helpers/plugin-runtime.mjs";
import { conformanceKubernetesOptions } from "../helpers/kubernetes-compute.mjs";

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

async function waitForCondition(description, condition, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
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

async function readReadyStatusFromHandler(handler) {
  let body = "";
  let status;
  await handler(
    { method: "GET", url: "/readyz" },
    {
      writeHead(value) {
        status = value;
      },
      end(chunk = "") {
        body += chunk;
      },
    },
  );
  return { status, body };
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
        namespaceName: kubernetesNamespaceName(tenant.id),
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
      mcpServers: options.mcpServers ?? [],
      scheduledTasks: [],
    },
  };
}

function codexConfigReadResponse(appConfig = {}, pluginEnabled = true) {
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
      plugins: {
        _default: { enabled: false },
        [CODEX_LINEAR_NATIVE_ID]: { enabled: pluginEnabled },
      },
    },
    origins: {},
  };
}

async function runCodexRuntimeHelper(runtime, handler, options = {}) {
  const requests = [];
  const sockets = [];
  const files = new Map(options.files ?? []);
  // options.refusedConnections models an app-server that is not listening yet.
  const refusedConnections = options.refusedConnections ?? 0;
  class FakeWebSocket {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.listeners = new Map();
      sockets.push(this);
      const refused = sockets.length <= refusedConnections;
      setTimeout(() => this.dispatch(refused ? "error" : "open", {}), 0);
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
  assert.match(data[PLUGIN_RUNTIME_CODEX_CONFIG], /^\[plugins\._default\]\nenabled = false/m);
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
    [
      revision({
        harness: { id: "openclaw", version: "1.0.0", mode: "dedicated" },
        pluginApprovers: [],
      }),
      [],
    ],
    [
      revision({
        harness: { id: "openclaw", version: "1.0.0", mode: "dedicated" },
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
  // Startup reviewer checks must see the session policy selected by the
  // gateway, before the gateway can start a native thread.
  assert.match(data[PLUGIN_RUNTIME_CODEX_CONFIG], /^approval_policy = "on-request"\n/);
  const manifest = JSON.parse(data[PLUGIN_RUNTIME_MANIFEST]);
  assert.deepEqual(manifest, {
    kind: "codex",
    selections: state.plugins,
  });
  assert.match(
    data[PLUGIN_RUNTIME_CODEX_CONFIG],
    /^\[features\]\napps = true\nplugins = true\nremote_plugin = true/m,
  );
  assert.match(data[PLUGIN_RUNTIME_CODEX_CONFIG], /^\[plugins\._default\]\nenabled = false/m);
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

test("Codex startup preserves explicit session approval choices and native defaults", () => {
  // Native startup gets the policy the pinned Gateway runs: it runs on-failure as on-request.
  // A reviewer request must never silently upgrade an incompatible session policy to
  // on-request; the native readiness check owns that rejection, and deployment refuses
  // untrusted and an omitted policy with an automatic reviewer before rendering.
  for (const [policy, native] of [
    ["on-request", "on-request"],
    ["on-failure", "on-request"],
    ["never", "never"],
    ["untrusted", "untrusted"],
    [undefined, undefined],
  ]) {
    const candidate = revision({ plugins: codexLinearPluginState() });
    candidate.configuration.plugins.entries.codex.config.appServer.approvalPolicy = policy;
    const runtime = pluginRuntimeSpecForRevision(candidate);
    const config = pluginRuntimeConfigMapData(runtime)[PLUGIN_RUNTIME_CODEX_CONFIG];
    if (native === undefined) {
      assert.doesNotMatch(config, /approval_policy/);
    } else {
      assert.ok(config.startsWith(`approval_policy = "${native}"\n\n[features]`), policy);
    }
    // Docker delivers the same file through the environment.
    const delivered = JSON.parse(pluginRuntimeEnvironment(runtime)[PLUGIN_RUNTIME_ENVIRONMENT]);
    assert.equal(delivered.codexConfigurationToml, config);
  }
  const malformed = revision();
  malformed.configuration.plugins.entries.codex.config.appServer.approvalPolicy = "invalid";
  assert.throws(
    () => pluginRuntimeSpecForRevision(malformed),
    /session approval policy is invalid/,
  );
});

test("Kubernetes keeps only the exact earlier Codex config of a selected-plugin revision", () => {
  const candidate = revision({ plugins: codexLinearPluginState() });
  const runtime = pluginRuntimeSpecForRevision(candidate);
  const current = pluginRuntimeConfigMapData(runtime);
  // The config.toml earlier controllers rendered for a selected-plugin Codex runtime:
  // before #508 without [plugins._default], before #1995 without approval_policy.
  const beforePluginDefaults = `[features]
apps = true
plugins = true
remote_plugin = true

[apps._default]
enabled = false
`;
  const beforeApprovalPolicy = `${beforePluginDefaults}
[plugins._default]
enabled = false
`;
  assert.equal(
    current[PLUGIN_RUNTIME_CODEX_CONFIG],
    `approval_policy = "on-request"\n\n${beforeApprovalPolicy}`,
  );
  // Only config.toml differs; the manifest that carries selections and approvers must match.
  assert.deepEqual(pluginRuntimeEarlierConfigMapData(runtime), [
    { ...current, [PLUGIN_RUNTIME_CODEX_CONFIG]: beforeApprovalPolicy },
    { ...current, [PLUGIN_RUNTIME_CODEX_CONFIG]: beforePluginDefaults },
  ]);
  // #1995 rendered on-failure as written; the Gateway runs it as on-request, which the
  // current rendering carries.
  const onFailure = revision({ plugins: codexLinearPluginState() });
  onFailure.configuration.plugins.entries.codex.config.appServer.approvalPolicy = "on-failure";
  const onFailureRuntime = pluginRuntimeSpecForRevision(onFailure);
  const onFailureCurrent = pluginRuntimeConfigMapData(onFailureRuntime);
  assert.deepEqual(onFailureCurrent, current);
  assert.deepEqual(pluginRuntimeEarlierConfigMapData(onFailureRuntime), [
    {
      ...current,
      [PLUGIN_RUNTIME_CODEX_CONFIG]: `approval_policy = "on-failure"\n\n${beforeApprovalPolicy}`,
    },
    { ...current, [PLUGIN_RUNTIME_CODEX_CONFIG]: beforeApprovalPolicy },
    { ...current, [PLUGIN_RUNTIME_CODEX_CONFIG]: beforePluginDefaults },
  ]);
  // OpenClaw plugin runtimes never had a Codex config, so nothing earlier is accepted.
  const openClaw = revision({
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    plugins: openClawPluginState(),
  });
  assert.deepEqual(pluginRuntimeEarlierConfigMapData(pluginRuntimeSpecForRevision(openClaw)), []);
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
        enabled: readCount > 2,
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
      if (params.edits.length === 1) {
        assert.deepEqual(params, {
          edits: [
            {
              keyPath: "plugins",
              mergeStrategy: "replace",
              value: {
                _default: { enabled: false },
                [CODEX_LINEAR_NATIVE_ID]: { enabled: true },
              },
            },
          ],
          reloadUserConfig: true,
        });
        return { status: "ok", version: "selected-plugins" };
      }
      assert.deepEqual(params, {
        edits: [
          { keyPath: "features.apps", mergeStrategy: "replace", value: true },
          { keyPath: "features.plugins", mergeStrategy: "replace", value: true },
          { keyPath: "features.remote_plugin", mergeStrategy: "replace", value: true },
          {
            keyPath: "apps",
            mergeStrategy: "replace",
            value: {
              _default: { enabled: false },
              [CODEX_LINEAR_APP_ID]: {
                enabled: true,
                default_tools_approval_mode: "writes",
                approvals_reviewer: "auto_review",
              },
            },
          },
          {
            keyPath: "plugins",
            mergeStrategy: "replace",
            value: {
              _default: { enabled: false },
              [CODEX_LINEAR_NATIVE_ID]: { enabled: true },
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
      "config/batchWrite",
      "initialize",
      "plugin/install",
      "initialize",
      "plugin/read",
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
      if (!params.edits.some((edit) => edit.keyPath === "apps")) {
        return { status: "ok", version: "selected-plugins" };
      }
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
  let apps;
  let plugins;
  let installed = false;
  const { requests } = await runCodexRuntimeHelper(runtime, (method, params) => {
    if (method === "initialize") {
      return { serverInfo: { name: "codex", version: "0.156.0" } };
    }
    if (method === "plugin/list") {
      return codexListResponse();
    }
    if (method === "plugin/read") {
      return codexReadResponse({
        installed,
        enabled: plugins?.[CODEX_LINEAR_NATIVE_ID]?.enabled === true,
      });
    }
    if (method === "plugin/install") {
      installed = true;
      return { authPolicy: "ON_USE", appsNeedingAuth: [] };
    }
    if (method === "mcpServerStatus/list") {
      assert.equal(installed, true, "tool discovery follows native installation");
      assert.equal(apps, undefined, "tool inventory precedes app grants");
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
        if (edit.keyPath === "apps") {
          apps = edit.value;
        }
        if (edit.keyPath === "plugins") {
          plugins = edit.value;
        }
      }
      assert.deepEqual(plugins, {
        _default: { enabled: false },
        [CODEX_LINEAR_NATIVE_ID]: { enabled: true },
      });
      if (apps === undefined) {
        return { status: "ok", version: "selected-plugins" };
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
      return { config: { ...codexConfigReadResponse().config, apps, plugins } };
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
  assert.equal(
    requests.filter(
      ({ method, params }) =>
        method === "config/batchWrite" && params.edits.some((edit) => edit.keyPath === "apps"),
    ).length,
    1,
  );
});

test("Codex runtime helper rejects incomplete or unbounded tool discovery before writing app policy", async (t) => {
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
          if (method === "config/batchWrite") {
            return { status: "ok", version: "selected-plugins" };
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
        result.requests.some(
          ({ method, params }) =>
            method === "config/batchWrite" && params.edits.some((edit) => edit.keyPath === "apps"),
        ),
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
        return codexConfigReadResponse(
          {
            enabled: false,
            default_tools_enabled: true,
            tools: { list_issues: { enabled: true, approval_mode: "approve" } },
            links: { account: { default_tools_approval_mode: "approve" } },
          },
          false,
        );
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
  const write = result.requests.find(
    (request) =>
      request.method === "config/batchWrite" &&
      request.params.edits.some((edit) => edit.keyPath === "apps"),
  );
  assert.ok(write);
  assert.deepEqual(
    write.params.edits.find((edit) => edit.keyPath === "apps")?.value[CODEX_LINEAR_APP_ID],
    { enabled: false },
  );
  assert.deepEqual(write.params.edits.find((edit) => edit.keyPath === "plugins")?.value, {
    _default: { enabled: false },
    [CODEX_LINEAR_NATIVE_ID]: { enabled: false },
  });
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
  let pluginEnabled = false;
  const result = await runCodexRuntimeHelper(
    runtime,
    (method, params) => {
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
        pluginEnabled =
          params.edits.find((edit) => edit.keyPath === "plugins")?.value[CODEX_LINEAR_NATIVE_ID]
            ?.enabled === true;
        return { status: "ok", version: "test-config-1" };
      }
      if (method === "plugin/install") {
        return {
          authPolicy: "ON_USE",
          appsNeedingAuth: pluginEnabled
            ? [
                {
                  id: CODEX_LINEAR_APP_ID,
                  name: "Linear",
                  category: null,
                },
              ]
            : [],
        };
      }
      if (method === "config/read") {
        return codexConfigReadResponse({ enabled: false }, false);
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
  assert.equal(pluginEnabled, false, "auth failures revoke the startup plugin grant");
});

test("Codex runtime helper disables curated plugins at once under API-key login", async () => {
  // Codex rejects the remote catalog for API-key logins, so a selected plugin
  // can never install: report it and serve without plugins instead of retrying.
  const runtime = {
    manifest: {
      kind: "codex",
      selections: {
        "codex-plugin:linear@openai-curated-remote": {
          enabled: true,
          toolDefaults: { approval: "provider_default" },
        },
        "codex-plugin:slack@openai-curated-remote": { enabled: false },
      },
    },
  };
  const disabledConfig = {
    config: {
      features: { apps: false, plugins: false, remote_plugin: false },
      apps: { _default: { enabled: false } },
      plugins: { _default: { enabled: false } },
    },
    origins: {},
  };
  const result = await runCodexRuntimeHelper(
    runtime,
    (method) => {
      if (method === "initialize") {
        return { serverInfo: { name: "codex", version: "0.149.0" } };
      }
      if (method === "config/read") {
        return disabledConfig;
      }
      if (method === "config/batchWrite") {
        return { status: "ok", version: "test-config-1" };
      }
      throw new Error(`unexpected request ${method}`);
    },
    { env: { CODEX_LOGIN_MODE: "api_key", OPENCLAW_PLUGIN_STATUS_PORT: "18791" } },
  );

  assert.deepEqual(plain(result.value), {
    successfulPluginIds: [],
    failures: [
      { pluginId: "codex-plugin:linear@openai-curated-remote", code: "PLUGIN_AUTH_REQUIRED" },
    ],
  });
  const calls = result.requests.filter((request) => request.method !== "initialize");
  assert.deepEqual(
    calls.map((request) => request.method),
    ["config/read", "config/batchWrite", "config/read"],
  );
  assert.deepEqual(calls[1].params.edits, [
    { keyPath: "features.apps", mergeStrategy: "replace", value: false },
    { keyPath: "features.plugins", mergeStrategy: "replace", value: false },
    { keyPath: "features.remote_plugin", mergeStrategy: "replace", value: false },
    { keyPath: "apps", mergeStrategy: "replace", value: { _default: { enabled: false } } },
    { keyPath: "plugins", mergeStrategy: "replace", value: { _default: { enabled: false } } },
  ]);

  const strict = await runCodexRuntimeHelper(
    runtime,
    (method) => {
      throw new Error(`unexpected request ${method}`);
    },
    { env: { CODEX_LOGIN_MODE: "api_key" }, captureError: true },
  );
  assert.match(String(strict.error?.message), /require a ChatGPT login/);
  assert.deepEqual(strict.requests, []);
});

test("Codex runtime helper waits for a late app-server before disabling API-key plugin selections", async () => {
  // D320: the Harness reached plugin setup before the Codex app-server accepted
  // connections; a single attempt failed the transport and restarted Codex forever.
  const runtime = {
    manifest: {
      kind: "codex",
      selections: {
        "codex-plugin:linear@openai-curated-remote": {
          enabled: true,
          toolDefaults: { approval: "provider_default" },
        },
      },
    },
  };
  const disabledConfig = {
    config: {
      features: { apps: false, plugins: false, remote_plugin: false },
      apps: { _default: { enabled: false } },
      plugins: { _default: { enabled: false } },
    },
    origins: {},
  };
  const handler = (method) => {
    if (method === "initialize") {
      return { serverInfo: { name: "codex", version: "0.149.0" } };
    }
    if (method === "config/read") {
      return disabledConfig;
    }
    if (method === "config/batchWrite") {
      return { status: "ok", version: "test-config-1" };
    }
    throw new Error(`unexpected request ${method}`);
  };
  const result = await runCodexRuntimeHelper(runtime, handler, {
    env: {
      CODEX_LOGIN_MODE: "api_key",
      OPENCLAW_PLUGIN_STATUS_PORT: "18791",
      OPENCLAW_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS: "5000",
    },
    refusedConnections: 2,
  });
  assert.equal(result.sockets.length, 5);
  assert.deepEqual(plain(result.value), {
    successfulPluginIds: [],
    failures: [
      { pluginId: "codex-plugin:linear@openai-curated-remote", code: "PLUGIN_AUTH_REQUIRED" },
    ],
  });
  assert.deepEqual(
    result.requests
      .filter((request) => request.method !== "initialize")
      .map((request) => request.method),
    ["config/read", "config/batchWrite", "config/read"],
  );

  const neverReady = await runCodexRuntimeHelper(runtime, handler, {
    env: { CODEX_LOGIN_MODE: "api_key", OPENCLAW_PLUGIN_STATUS_PORT: "18791" },
    refusedConnections: Number.POSITIVE_INFINITY,
    captureError: true,
  });
  assert.match(
    String(neverReady.error?.message),
    /plugin disable did not reach readiness: .*transport failed/,
  );
  assert.equal(neverReady.error?.startupCode, "PLUGIN_NOT_READY");
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
  assert.equal(result.error.startupCode, "PLUGIN_NOT_READY");
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
        assert.deepEqual(params.edits.find((edit) => edit.keyPath === "plugins")?.value, {
          _default: { enabled: false },
          [CODEX_LINEAR_NATIVE_ID]: { enabled: false },
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
            plugins: {
              _default: { enabled: false },
              [CODEX_LINEAR_NATIVE_ID]: { enabled: false },
            },
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
          request.params.edits.some(
            (edit) => edit.keyPath === "apps" && CODEX_LINEAR_APP_ID in edit.value,
          ),
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
      const appEdit = params.edits.find((edit) => edit.keyPath === "apps");
      if (appEdit !== undefined) {
        assert.deepEqual(appEdit.value, {
          _default: { enabled: false },
          [CODEX_LINEAR_APP_ID]: { enabled: true, default_tools_approval_mode: "auto" },
        });
      }
      assert.deepEqual(params.edits.find((edit) => edit.keyPath === "plugins")?.value, {
        _default: { enabled: false },
        [CODEX_LINEAR_NATIVE_ID]: { enabled: true },
        [CODEX_ASANA_NATIVE_ID]: { enabled: false },
      });
      return { status: "ok", version: "mixed-config-1" };
    }
    if (method === "config/read") {
      const response = codexConfigReadResponse();
      response.config.plugins[CODEX_ASANA_NATIVE_ID] = { enabled: false };
      return response;
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

test("a failed startup phase line carries only a fixed upper-case cause code", () => {
  const lines = [];
  vm.runInNewContext(
    `${startupPhaseHelper("agent")}
logStartupPhase("plugin-install", Date.now(), "failed", "PLUGIN_NOT_IN_CATALOG");
logStartupPhase("plugin-install", Date.now(), "failed", "catalog lacks linear");
logStartupPhase("plugin-install", Date.now(), "failed");
logStartupPhase("native-spawn", Date.now(), "ok", "PLUGIN_NOT_IN_CATALOG");`,
    { Date, JSON, console: { error: (line) => lines.push(JSON.parse(line)) } },
  );
  assert.deepEqual(
    lines.map(({ phase, outcome, code }) => [phase, outcome, code]),
    [
      ["plugin-install", "failed", "PLUGIN_NOT_IN_CATALOG"],
      ["plugin-install", "failed", undefined],
      ["plugin-install", "failed", undefined],
      ["native-spawn", "ok", undefined],
    ],
  );
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
    (error) => {
      assert.match(error.message, /catalog did not contain the selected plugin/);
      // The fixed code, not the message, is what the wrapper exports remotely.
      assert.equal(error.startupCode, "PLUGIN_NOT_IN_CATALOG");
      return true;
    },
  );
});

test("Codex runtime helper rejects catalog drift before app grants and readiness", async (t) => {
  const state = codexLinearPluginState();
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(revision({ plugins: state })),
  };
  for (const [name, installedDetail, error] of [
    [
      "app mapping",
      { apps: [{ id: "asdk_app_changed", name: "Linear", needsAuth: false }] },
      /installed app mapping does not match startup resolution/,
    ],
    ["MCP servers", { mcpServers: ["workspace"] }, /unsupported mcpServers/],
    [
      "version",
      { version: "5.0.2" },
      /installed release metadata does not match startup resolution/,
    ],
  ]) {
    await t.test(name, async () => {
      let readCount = 0;
      let policyWritten = false;
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
              // A post-install catalog read must still match the admitted capabilities.
              readCount += 1;
              return codexReadResponse(readCount === 1 ? {} : installedDetail);
            }
            if (method === "config/batchWrite") {
              policyWritten = params.edits.some((edit) => edit.keyPath === "apps");
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
        error,
      );
      assert.equal(policyWritten, false, "catalog details must be revalidated before app grants");
    });
  }
});

test("Codex runtime helper verifies defaults and rejects inherited unselected app or plugin enablement", async (t) => {
  const state = codexLinearPluginState();
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(revision({ plugins: state })),
  };
  for (const [table, id, policy] of [
    ["apps", "_default", { enabled: true }],
    ["plugins", "_default", { enabled: true }],
    ["apps", "unselected_app", { enabled: true }],
    ["apps", "unselected_app", {}],
    ["apps", "unselected_app", { enabled: false }],
    ["plugins", "unselected@openai-curated-remote", { enabled: true }],
    ["plugins", "unselected@openai-curated-remote", { mcp_servers: { example: {} } }],
    ["plugins", "unselected@openai-curated-remote", { enabled: false }],
  ]) {
    await t.test(`${table}.${id} ${JSON.stringify(policy)}`, async () => {
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
          if (method === "config/batchWrite") {
            return { status: "ok", version: "inherited-policy" };
          }
          if (method === "plugin/install") {
            return { authPolicy: "ON_USE", appsNeedingAuth: [] };
          }
          if (method === "config/read") {
            // Native config merges inherited entries with the replaced user tables.
            const response = codexConfigReadResponse();
            response.config[table][id] = policy;
            return response;
          }
          throw new Error(`unexpected request ${method}`);
        },
        { captureError: true },
      );
      if (
        policy.enabled === false ||
        (table === "plugins" && id !== "_default" && policy.enabled !== true)
      ) {
        assert.equal(result.error, undefined);
        assert.deepEqual(plain(result.value), {
          successfulPluginIds: ["codex-plugin:linear@openai-curated-remote"],
          failures: [],
        });
      } else {
        const unselectedError =
          table === "apps"
            ? /effective app policy conflicts/
            : /effective plugins configuration enables an unselected entry/;
        assert.match(
          result.error?.message ?? "",
          id === "_default"
            ? /effective config does not match admitted configuration/
            : unselectedError,
        );
        assert.equal(result.value, undefined, "unselected enablement must prevent readiness");
      }
    });
  }
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
  const cp = kubernetesNamespaceName(tenant.id);
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
    compute: { id: driver.id, implementation: driver.implementation },
    plugins: {
      ...codexLinearPluginState(),
      plugins: {
        ...codexSelection(),
        [`codex-plugin:${CODEX_ASANA_NATIVE_ID}`]: {
          enabled: true,
          toolDefaults: { approval: "provider_default" },
        },
      },
    },
  });
  const namespace = kubernetesNamespaceName(tenant.id);
  const pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "gateway-plugin-status",
      namespace: kubernetesNamespaceName(tenant.id),
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
    successfulPluginIds: [
      `codex-plugin:${CODEX_LINEAR_NATIVE_ID}`,
      `codex-plugin:${CODEX_ASANA_NATIVE_ID}`,
    ],
    failures: [],
  };
  // Gateway readiness requires the Harness's complete warning set, regardless of order.
  const warningReport = {
    ...readyReport,
    successfulPluginIds: [],
    failures: [
      { pluginId: `codex-plugin:${CODEX_ASANA_NATIVE_ID}`, code: "PLUGIN_INSTALL_FAILED" },
      { pluginId: `codex-plugin:${CODEX_LINEAR_NATIVE_ID}`, code: "PLUGIN_AUTH_REQUIRED" },
    ],
  };

  for (const [name, response, expected, expectedWarnings = []] of [
    ["missing proxy", Object.assign(new Error("not found"), { code: 404 }), "not-ready"],
    ["starting phase", { ...readyReport, phase: "starting" }, "not-ready"],
    ["wrong revision", { ...readyReport, revisionId: "another-revision" }, "rejects"],
    ["wrong container", { ...readyReport, container: "agent" }, "rejects"],
    ["malformed report", { ...readyReport, successfulPluginIds: "occ-plugin:diffs" }, "rejects"],
    ["ready", readyReport, readyReport],
    [
      "matching warnings in another order",
      { ...warningReport, failures: [...warningReport.failures].reverse() },
      warningReport,
      warningReport.failures,
    ],
    [
      "different warning code keeps the runtime unready",
      warningReport,
      "not-ready",
      [{ ...warningReport.failures[0], code: "PLUGIN_AUTH_REQUIRED" }, warningReport.failures[1]],
    ],
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
              expectedWarnings,
            ),
          DependencyUnavailableError,
        );
      } else {
        const status = await driver.pluginRuntimeStatus(
          candidate,
          { name: namespace, plane: "execution" },
          "gateway",
          expectedWarnings,
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

  // A model-probe cause crosses the runtime boundary only inside its closed
  // vocabulary. Anything else is dropped and the failure code still stands.
  const reports = [
    [{ kind: "PROBE_STATUS", detail: "rate_limit" }, "MODEL_PROBE_FAILED", true],
    [{ kind: "WRAPPER_ERROR" }, "MODEL_PROBE_FAILED", true],
    [{ kind: "PROCESS_EXIT", detail: "exit-1" }, "MODEL_PROBE_FAILED", true],
    [{ kind: "PROBE_STATUS", detail: "sk-fixture-credential" }, "MODEL_PROBE_FAILED", false],
    [{ kind: "PROCESS_EXIT", detail: "HTTP 404 model not found" }, "MODEL_PROBE_FAILED", false],
    [{ kind: "WRAPPER_ERROR", detail: "json" }, "MODEL_PROBE_FAILED", false],
    [{ kind: "PROVIDER_SAID", detail: "format" }, "MODEL_PROBE_FAILED", false],
    [{ kind: "PROBE_STATUS", detail: "format", text: "raw" }, "MODEL_PROBE_FAILED", false],
    ["PROBE_STATUS", "MODEL_PROBE_FAILED", false],
    [{ kind: "PROBE_STATUS", detail: "format" }, "AUTHENTICATION_FAILED", false],
  ];
  for (const [cause, code, kept] of reports) {
    failure.code = code;
    failure.cause = cause;
    const evidence = await driver.safeRuntimeFailureObservation(candidate, {
      name: namespace,
      plane: "execution",
    });
    const { cause: _reported, ...withoutCause } = failure;
    assert.deepEqual(evidence, kept ? failure : withoutCause, `${code} ${JSON.stringify(cause)}`);
  }
});

test("gateway runtime status maps native Slack channel status without provider data", async () => {
  const revisionId = "revision-plugin-compute-1";
  let statusHandler;
  let channelStatus;
  let channelStatusCalls = 0;
  let channelError;
  const transportError = new Error("connection refused");
  let holdChannelStatusResponse = false;
  let pendingChannelSignal;
  let rpcTimeout;
  let gatewayReadyStatus = 503;
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
        rpcTimeout = callback;
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
          get(_options, callback) {
            callback({ statusCode: gatewayReadyStatus, resume() {} });
            return { on() {}, destroy() {} };
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
      if (specifier === "openclaw/plugin-sdk/gateway-runtime") {
        return {
          isGatewayTransportError: (error) => error === transportError,
          // OpenClaw's predicate for a request refusal the Gateway answered (call.ts).
          isGatewayClientRequestError: (error) =>
            error instanceof Error &&
            error.name === "GatewayClientRequestError" &&
            typeof error.gatewayCode === "string" &&
            error.gatewayCode.length > 0 &&
            error.message.length > 0 &&
            typeof error.retryable === "boolean" &&
            (error.retryAfterMs === undefined ||
              (Number.isInteger(error.retryAfterMs) && error.retryAfterMs >= 0)),
          async callGatewayFromCli(method, options, params, { signal, sharedStateMode }) {
            assert.equal(sharedStateMode, "read-only");
            assert.equal(method, "channels.status");
            assert.deepEqual(plain(params), { channel: "slack", probe: true, timeoutMs: 5000 });
            channelStatusCalls += 1;
            pendingChannelSignal = signal;
            if (channelError) {
              throw channelError;
            }
            // A stuck transport must not hold the HTTP response or the next probe.
            if (holdChannelStatusResponse) {
              return new Promise(() => {});
            }
            return channelStatus;
          },
        };
      }
      if (specifier === "node:child_process") {
        return { spawn: () => ({ on() {}, kill() {} }) };
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
  assert.deepEqual(await readReadyStatusFromHandler(statusHandler), { status: 503, body: "" });
  gatewayReadyStatus = 200;
  assert.deepEqual(await readReadyStatusFromHandler(statusHandler), { status: 200, body: "" });
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
    {
      channels: { slack: { configured: false } },
      channelAccounts: { slack: [{ accountId: "default", configured: false }] },
      channelDefaultAccountId: { slack: "default" },
    },
    [
      { check: "configuration", state: "failed", code: "NOT_CONFIGURED" },
      { check: "authentication", state: "unknown", code: undefined },
      { check: "connectivity", state: "unknown", code: undefined },
    ],
    "disabled",
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
    { channels: [] },
    [
      { check: "configuration", state: "unknown", code: "INCOMPATIBLE_RESPONSE" },
      { check: "authentication", state: "unknown", code: "INCOMPATIBLE_RESPONSE" },
      { check: "connectivity", state: "unknown", code: "INCOMPATIBLE_RESPONSE" },
    ],
    "malformed live response",
  );

  // The shape of a refusal the Gateway answers (OpenClaw's GatewayClientRequestError).
  const gatewayRefusal = (gatewayCode, message) =>
    Object.assign(new Error(message), {
      name: "GatewayClientRequestError",
      gatewayCode,
      retryable: false,
    });
  for (const [error, code] of [
    [transportError, "UNAVAILABLE"],
    [new Error("RPC failed"), "PROBE_FAILED"],
    // Only the unknown-channel refusal for Slack itself means "no Slack channel".
    [gatewayRefusal("INVALID_REQUEST", "unknown channel: teams"), "PROBE_FAILED"],
    [gatewayRefusal("UNAVAILABLE", "unknown channel: slack"), "PROBE_FAILED"],
    [new Error("unknown channel: slack"), "PROBE_FAILED"],
  ]) {
    channelError = error;
    const diagnostics = await readRuntimeChannelChecksFromHandler(statusHandler);
    assert.deepEqual(
      diagnostics.checks.map(({ state, code }) => ({ state, code })),
      Array.from({ length: 3 }, () => ({ state: "unknown", code })),
    );
  }
  // The Gateway loads the Slack plugin only when the Configuration sets up a Slack channel,
  // so for an Agent without one it refuses channels.status as an unknown channel. That is
  // the documented NOT_CONFIGURED answer, not a failed probe.
  channelError = gatewayRefusal("INVALID_REQUEST", "unknown channel: slack");
  const withoutSlack = await readRuntimeChannelChecksFromHandler(statusHandler);
  assert.deepEqual(
    withoutSlack.checks.map(({ component, check, state, code }) => ({
      component,
      check,
      state,
      code,
    })),
    [
      { component: "gateway", check: "configuration", state: "failed", code: "NOT_CONFIGURED" },
      { component: "gateway", check: "authentication", state: "unknown", code: undefined },
      { component: "gateway", check: "connectivity", state: "unknown", code: undefined },
    ],
  );
  channelError = undefined;

  holdChannelStatusResponse = true;
  const timedOutRequest = readRuntimeChannelChecksFromHandler(statusHandler);
  await Promise.resolve();
  assert.equal(typeof rpcTimeout, "function");
  rpcTimeout();
  assert.equal(pendingChannelSignal.aborted, true);
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
  assert.ok(pendingChannelSignal);
  requestListeners.aborted();
  assert.equal(pendingChannelSignal.aborted, true);
  await abortedRequest;
  responseListeners.close?.();
  assert.equal(channelStatusCalls, 15);
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
      name: "verifier-only app server starts without exposing either token input",
      tokenVerifier: true,
      events: [started, assistant, completed],
      ready: true,
    },
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
      cause: { kind: "PROBE_STATUS", detail: "tool-event" },
      probeError: "ETIMEDOUT",
      events: [started, { type: "item.completed", item: { type: "command_execution" } }],
    },
    {
      name: "rejection followed by timeout is not retried",
      cause: { kind: "PROBE_STATUS", detail: "error-event" },
      probeError: "ETIMEDOUT",
      events: [{ type: "error", message: "authentication rejected" }],
    },
    {
      name: "malformed output followed by timeout is not retried",
      cause: { kind: "INVALID_OUTPUT", detail: "json" },
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
    {
      name: "external SIGKILL is not a timeout or retried",
      probeSignal: "SIGKILL",
      cause: { kind: "PROCESS_EXIT", detail: "signal-SIGKILL" },
    },
    {
      name: "malformed model output is not retried",
      probeOutput: "not-json",
      cause: { kind: "INVALID_OUTPUT", detail: "json" },
    },
    {
      name: "non-event model output is not retried",
      probeOutput: "null",
      cause: { kind: "INVALID_OUTPUT", detail: "shape" },
    },
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
      cause: { kind: "PROBE_STATUS", detail: "error-event" },
      events: [started, assistant, { type: "error", message: "authentication failed" }, completed],
    },
    {
      name: "reconnecting error with auth marker remains fatal",
      cause: { kind: "PROBE_STATUS", detail: "error-event" },
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
      cause: { kind: "PROBE_STATUS", detail: "error-event" },
      events: [started, assistant, completed, recoveredStreamError],
    },
    {
      name: "reconnecting error before the turn starts remains fatal",
      cause: { kind: "PROBE_STATUS", detail: "error-event" },
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
      cause: { kind: "PROBE_STATUS", detail: "error-event" },
    })),
    {
      name: "unbounded reconnecting errors remain fatal",
      cause: { kind: "PROBE_STATUS", detail: "error-event" },
      events: [
        started,
        ...Array.from({ length: 11 }, () => recoveredStreamError),
        assistant,
        completed,
      ],
    },
    {
      name: "failed turn",
      cause: { kind: "PROBE_STATUS", detail: "turn-failed" },
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
      cause: { kind: "PROBE_STATUS", detail: "turn-failed" },
      events: [
        started,
        { type: "turn.failed", error: { message: "unexpected status 503 Service Unavailable" } },
      ],
      probeStatus: 1,
    },
    {
      name: "completed turn without visible assistant",
      events: [started, advisory, completed],
      cause: { kind: "PROBE_STATUS", detail: "no-reply" },
    },
    {
      // Provider text that echoes the credential never reaches the cause.
      name: "provider text in a failed turn stays out of the cause",
      events: [
        started,
        {
          type: "turn.failed",
          error: {
            message: "unexpected status 400 Bad Request: model rejected for fixture-api-key",
          },
        },
      ],
      probeStatus: 1,
      cause: { kind: "PROBE_STATUS", detail: "turn-failed" },
    },
    {
      name: "tool event despite completed assistant turn",
      cause: { kind: "PROBE_STATUS", detail: "tool-event" },
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
      cause: { kind: "PROCESS_EXIT", detail: "exit-1" },
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
              ...(scenario.tokenVerifier
                ? { APP_TOKEN_SHA: sha256("fixture-transport-token") }
                : { APP_SERVER_TOKEN: "fixture-transport-token" }),
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
                    const loginEnvironment = options.env ?? sandbox.process.env;
                    assert.equal(Object.hasOwn(loginEnvironment, "APP_SERVER_TOKEN"), false);
                    assert.equal(Object.hasOwn(loginEnvironment, "APP_TOKEN_SHA"), false);
                    assert.equal(
                      loginEnvironment.CODEX_LOGIN_MODE,
                      sandbox.process.env.CODEX_LOGIN_MODE,
                    );
                    if (scenario.tokenVerifier) {
                      assert.equal(
                        sandbox.process.env.APP_TOKEN_SHA,
                        sha256("fixture-transport-token"),
                      );
                    } else {
                      assert.equal(sandbox.process.env.APP_SERVER_TOKEN, "fixture-transport-token");
                    }
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
                spawn(_command, args, options) {
                  assert.ok(args.includes("app-server"));
                  // Plugin reviewer validation must observe the admitted model, not a native default.
                  assert.ok(args.includes('model="gpt-4.1"'));
                  const tokenDigest = args[args.indexOf("--ws-token-sha256") + 1];
                  assert.equal(tokenDigest, sha256("fixture-transport-token"));
                  assert.equal(Object.hasOwn(options.env, "APP_SERVER_TOKEN"), false);
                  assert.equal(Object.hasOwn(options.env, "APP_TOKEN_SHA"), false);
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
          // Only a failed model probe carries a cause: a closed kind and a fixed
          // token, never native output, provider text or the credential.
          if (runtimeStatus.runtimeFailure.code === "MODEL_PROBE_FAILED") {
            assert.ok(scenario.cause, "every model-probe failure scenario names its cause");
          }
          assert.deepEqual(runtimeStatus.runtimeFailure.cause, scenario.cause);
          assert.deepEqual(probeDiagnostics.at(-1)?.cause, scenario.cause);
          assert.doesNotMatch(
            JSON.stringify(runtimeStatus) + JSON.stringify(probeDiagnostics),
            /fixture-api-key|at-fixture-token|Bad Request|Unauthorized|Unavailable|Reconnecting/,
          );
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
            spawn(command, args, options) {
              appServerSpawn = { command, args, options };
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
    // Node inherits the wrapper environment when spawn does not supply one.
    const childEnvironment = appServerSpawn.options.env ?? sandbox.process.env;
    assert.equal(Object.hasOwn(childEnvironment, "APP_SERVER_TOKEN"), false);
    assert.equal(childEnvironment.PATH, sandbox.process.env.PATH);
    assert.equal(sandbox.process.env.APP_SERVER_TOKEN, expectedToken);
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

// Runs the Kubernetes Codex Gateway wrapper against a real HTTP Harness peer
// status endpoint and a real readiness endpoint standing in for OpenClaw. Only
// process spawning and the filesystem are substituted.
async function startCodexGatewaySupervisor(
  t,
  {
    bindingDeviceId,
    writableConfig = false,
    savedFiles,
    initialPeerStatus,
    runtimeStatus = false,
    expectStart = true,
  } = {},
) {
  const peerHttp = await import("node:http");
  const configurationPath = writableConfig
    ? "/home/node/.openclaw/openclaw.json"
    : "/etc/openclaw/openclaw.json";
  const revisionId = "revision-plugin-compute-1";
  const initialFailure = {
    pluginId: "codex-plugin:linear@openai-curated-remote",
    code: "PLUGIN_AUTH_REQUIRED",
  };
  const fixture = {
    revisionId,
    initialFailure,
    peerStatus: {
      revisionId,
      container: "agent",
      startupId: "agent-startup-1",
      podUid: "agent-pod-1",
      phase: "ready",
      successfulPluginIds: [],
      failures: [initialFailure],
    },
    peerAvailable: true,
    peerRequests: 0,
    serving: true,
    readinessProbes: [],
    children: [],
    exits: [],
    intervals: [],
    logs: [],
    signalHandlers: {},
    statusHandler: undefined,
    files: new Map([
      [
        configurationPath,
        JSON.stringify({
          gateway: { port: 8080 },
          plugins: { installs: { keep: { source: "npm" } }, load: { paths: ["existing"] } },
          tools: { alsoAllow: ["existing-tool"] },
        }),
      ],
    ]),
  };
  if (writableConfig) {
    fixture.files.set("/etc/openclaw-managed/openclaw.json", fixture.files.get(configurationPath));
  }
  if (savedFiles !== undefined) {
    fixture.files = new Map(savedFiles);
  }
  if (initialPeerStatus !== undefined) {
    fixture.peerStatus = initialPeerStatus;
  }
  if (bindingDeviceId !== undefined) {
    fixture.files.set(
      "/home/node/workspace-node-binding/workspace-node.json",
      JSON.stringify({ revisionId, deviceId: bindingDeviceId }),
    );
  }
  const listen = async (handler) => {
    const server = peerHttp.createServer(handler);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return server.address().port;
  };
  const peerPort = await listen(async (request, response) => {
    assert.equal(request.url, "/openclaw/plugin-runtime/status");
    fixture.peerRequests++;
    if (fixture.peerGate !== undefined) {
      fixture.peerRequestPending = true;
      await fixture.peerGate;
    }
    if (!fixture.peerAvailable) {
      response.writeHead(503).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(fixture.peerStatus));
  });
  // The native Gateway's own readiness endpoint, answered only while serving.
  const gatewayPort = await listen((request, response) => {
    assert.equal(request.url, "/readyz");
    const live = fixture.children.at(-1);
    const status = fixture.serving && live?.exited === undefined ? 200 : 503;
    fixture.readinessProbes.push({ child: fixture.children.length, status });
    response.writeHead(status).end();
  });
  fixture.gatewayPort = gatewayPort;
  const sandbox = {
    AbortSignal,
    Buffer,
    JSON,
    URL,
    console: {
      error(value) {
        fixture.logs.push(value);
      },
    },
    fetch,
    process: {
      env: {
        APP_SERVER_TOKEN: "base-app-server-token",
        APP_SERVER_URL: `ws://127.0.0.1:${peerPort}`,
        HOME: "/home/node",
        OPENCLAW_AGENT_REVISION_ID: revisionId,
        OPENCLAW_CONFIG_PATH: configurationPath,
        OPENCLAW_GATEWAY_PORT: String(gatewayPort),
        OPENCLAW_PLUGIN_RUNTIME_JSON: JSON.stringify({
          manifest: pluginRuntimeSpecForRevision(
            revision({
              plugins: codexLinearPluginState({
                toolDefaults: { approval: "provider_default", reviewer: "auto" },
              }),
            }),
          ),
        }),
        OPENCLAW_PLUGIN_STATUS_CONTAINER: "gateway",
        OPENCLAW_PLUGIN_STATUS_PORT: String(peerPort),
        OPENCLAW_POD_UID: "gateway-pod-1",
        ...(bindingDeviceId === undefined
          ? {}
          : {
              OPENCLAW_WORKSPACE_NODE_PATH: "/home/node/workspace-node-binding/workspace-node.json",
            }),
        ...(bindingDeviceId === undefined && !runtimeStatus
          ? {}
          : {
              OPENCLAW_RUNTIME_STATUS_PORT: "18792",
              OPENCLAW_RUNTIME_STATUS_CONTAINER: "gateway",
            }),
      },
      on(signal, handler) {
        fixture.signalHandlers[signal] = handler;
      },
      exit(code) {
        fixture.exits.push(code);
      },
    },
    setInterval(callback) {
      fixture.intervals.push(callback);
      return { unref() {} };
    },
    clearInterval() {},
    setTimeout,
    clearTimeout,
    require(specifier) {
      if (specifier === "node:http") {
        return {
          createServer(handler) {
            fixture.statusHandler = handler;
            return { listen() {} };
          },
        };
      }
      if (specifier === "node:fs") {
        return {
          existsSync: (path) => fixture.files.has(path),
          mkdirSync() {},
          readFileSync(path) {
            if (!fixture.files.has(path)) {
              throw new Error(`Missing mocked file: ${path}`);
            }
            return fixture.files.get(path);
          },
          writeFileSync(path, data) {
            // A write that stops half-way, as a crash would leave the file.
            if (fixture.tearWrite?.(path)) {
              fixture.tearWrite = undefined;
              fixture.files.set(path, String(data).slice(0, -5));
              throw new Error("Interrupted write");
            }
            fixture.files.set(path, String(data));
          },
          renameSync(from, to) {
            const failure = fixture.failConfigWrite;
            if (to === configurationPath && failure !== undefined && --failure.remaining === 0) {
              fixture.failConfigWrite = undefined;
              if (failure.after) {
                fixture.files.set(to, fixture.files.get(from));
                fixture.files.delete(from);
              }
              throw new Error("Interrupted configuration replacement");
            }
            fixture.files.set(to, fixture.files.get(from));
            fixture.files.delete(from);
          },
          rmSync(path) {
            fixture.files.delete(path);
          },
        };
      }
      if (specifier === "node:child_process") {
        return {
          spawn(command, args) {
            assert.equal(command, "node");
            assert.deepEqual(plain(args), [
              "/app/openclaw.mjs",
              "gateway",
              "--port",
              String(gatewayPort),
            ]);
            const child = {
              token: sandbox.process.env.APP_SERVER_TOKEN,
              config: JSON.parse(fixture.files.get("/home/node/.openclaw/openclaw.json")),
              killed: [],
              exited: undefined,
              listeners: [],
              kill(signal) {
                this.killed.push(signal);
              },
              on(event, listener) {
                if (event === "exit") {
                  this.listeners.push(listener);
                }
              },
              exit(code, signal) {
                this.exited = { code, signal };
                for (const listener of this.listeners) {
                  listener(code, signal);
                }
              },
            };
            fixture.children.push(child);
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
  fixture.sandbox = sandbox;
  fixture.status = () => readStatusFromHandler(fixture.statusHandler);
  fixture.runtimeStatus = () => readRuntimeStatusFromHandler(fixture.statusHandler);
  fixture.token = (startupId) =>
    pluginAppServerToken("base-app-server-token", revisionId, startupId);
  // The peer poll is the last interval the wrapper registers.
  fixture.pollPeer = () => fixture.intervals.at(-1)();
  vm.runInNewContext(GATEWAY_RUNTIME_ENTRYPOINT, sandbox);
  if (expectStart) {
    await waitForCondition("gateway supervisor start", () => fixture.children.length === 1);
  }
  return fixture;
}

test("Codex gateway supervisor recovers a changed peer after restarting with its writable copy", async (t) => {
  const previous = await startCodexGatewaySupervisor(t, { writableConfig: true });
  const path = "/home/node/.openclaw/openclaw.json";
  const edited = JSON.parse(previous.files.get(path));
  edited.messages = { responsePrefix: "Native admin edit" };
  previous.files.set(path, JSON.stringify(edited));
  const gateway = await startCodexGatewaySupervisor(t, {
    writableConfig: true,
    savedFiles: previous.files,
    initialPeerStatus: {
      ...previous.peerStatus,
      startupId: "agent-startup-2",
      podUid: "agent-pod-2",
      successfulPluginIds: ["codex-plugin:linear@openai-curated-remote"],
      failures: [],
    },
  });
  assert.equal(gateway.children[0].config.messages.responsePrefix, "Native admin edit");
  assert.equal(
    gateway.children[0].config.plugins.entries.codex.config.codexPlugins.plugins.linear.enabled,
    true,
  );
  assert.equal(gateway.children[0].token, gateway.token("agent-startup-2"));
  assert.equal(gateway.status().phase, "ready");
  assert.deepEqual(gateway.exits, []);
});

for (const after of [false, true]) {
  test(`Codex gateway supervisor replays provenance after an interrupted bridge write (after=${after})`, async (t) => {
    const previous = await startCodexGatewaySupervisor(t, { writableConfig: true });
    const [first] = previous.children;
    previous.peerStatus = {
      ...previous.peerStatus,
      startupId: "agent-startup-2",
      podUid: "agent-pod-2",
      successfulPluginIds: ["codex-plugin:linear@openai-curated-remote"],
      failures: [],
    };
    previous.failConfigWrite = { remaining: 2, after };
    const respawn = previous.pollPeer();
    await waitForCondition("the stale Gateway stop", () => first.killed.length === 1);
    first.exit(null, "SIGTERM");
    await respawn;
    assert.deepEqual(previous.exits, [1]);
    const gateway = await startCodexGatewaySupervisor(t, {
      writableConfig: true,
      savedFiles: previous.files,
      initialPeerStatus: previous.peerStatus,
    });
    assert.equal(
      gateway.children[0].config.plugins.entries.codex.config.codexPlugins.plugins.linear.enabled,
      true,
    );
    assert.equal(gateway.status().phase, "ready");
    assert.deepEqual(gateway.exits, []);
  });
}

test("Codex gateway supervisor keeps its peer bridge record usable after an interrupted record write", async (t) => {
  const previous = await startCodexGatewaySupervisor(t, { writableConfig: true });
  const [first] = previous.children;
  const record = "/home/node/.openclaw/openclaw.json.oce-peer-bridge.json";
  const kept = previous.files.get(record);
  previous.peerStatus = {
    ...previous.peerStatus,
    startupId: "agent-startup-2",
    podUid: "agent-pod-2",
    successfulPluginIds: ["codex-plugin:linear@openai-curated-remote"],
    failures: [],
  };
  // The record is replaced through a pending file, so a crash mid-write leaves the old one.
  previous.tearWrite = (path) => path.startsWith(record);
  const respawn = previous.pollPeer();
  await waitForCondition("the stale Gateway stop", () => first.killed.length === 1);
  first.exit(null, "SIGTERM");
  await respawn;
  assert.deepEqual(previous.exits, [1]);
  assert.equal(previous.tearWrite, undefined, "the record write should have been interrupted");
  assert.equal(previous.files.get(record), kept);
  assert.equal(previous.files.has(`${record}.pending`), false);
  const gateway = await startCodexGatewaySupervisor(t, {
    writableConfig: true,
    savedFiles: previous.files,
    initialPeerStatus: previous.peerStatus,
  });
  assert.equal(
    gateway.children[0].config.plugins.entries.codex.config.codexPlugins.plugins.linear.enabled,
    true,
  );
  assert.equal(gateway.status().phase, "ready");
  assert.deepEqual(gateway.exits, []);
});

// The Pod-local bridge record survives container restarts, so an unusable one
// would fail every restart the same way until the Pod is replaced. The wrapper
// holds unready instead, names the file and the remedy, reports the failure on
// the runtime status port and keeps the record (removing it could overwrite
// native edits with a rebuilt bridge).
for (const [name, record, problem, snapshot = (text) => text] of [
  ["empty", () => "", "is unreadable"],
  ["truncated", (saved) => saved.slice(0, -5), "is unreadable"],
  ["null", () => "null", "does not match the admitted revision"],
  ["an array", () => "[]", "does not match the admitted revision"],
  [
    "another revision",
    (saved) => JSON.stringify({ ...JSON.parse(saved), revisionId: "another-revision" }),
    "does not match the admitted revision",
  ],
  [
    "another managed snapshot",
    (saved) => JSON.stringify({ ...JSON.parse(saved), sourceHash: "0".repeat(64) }),
    "does not match the admitted revision",
  ],
  [
    "another record version",
    (saved) => JSON.stringify({ ...JSON.parse(saved), version: 2 }),
    "does not match the admitted revision",
  ],
  [
    "missing its bridges",
    (saved) => JSON.stringify({ ...JSON.parse(saved), bridges: undefined }),
    "does not match the admitted revision",
  ],
  [
    "holding three bridges",
    (saved) => JSON.stringify({ ...JSON.parse(saved), bridges: [{}, {}, {}] }),
    "does not match the admitted revision",
  ],
  [
    "holding a bridge that is not an object",
    (saved) => JSON.stringify({ ...JSON.parse(saved), bridges: ["bridge"] }),
    "does not match the admitted revision",
  ],
  [
    // The record is intact, but the managed snapshot it was written for changed.
    "written for an earlier managed snapshot",
    (saved) => saved,
    "does not match the admitted revision",
    (snapshot) => JSON.stringify({ ...JSON.parse(snapshot), tools: { alsoAllow: [] } }),
  ],
]) {
  test(`Codex gateway supervisor holds with a named remedy for a peer bridge record that is ${name}`, async (t) => {
    const previous = await startCodexGatewaySupervisor(t, { writableConfig: true });
    const path = "/home/node/.openclaw/openclaw.json.oce-peer-bridge.json";
    let savedFiles = new Map(previous.files);
    savedFiles.set(path, record(savedFiles.get(path)));
    const managed = "/etc/openclaw-managed/openclaw.json";
    savedFiles.set(managed, snapshot(savedFiles.get(managed)));
    const saved = savedFiles.get(path);
    // A container restart in the same Pod starts again from the files the last one left.
    for (let restart = 0; restart < 2; restart++) {
      const gateway = await startCodexGatewaySupervisor(t, {
        writableConfig: true,
        savedFiles,
        runtimeStatus: true,
        expectStart: false,
      });
      savedFiles = gateway.files;
      // Longer than a loopback peer round trip: a wrapper that went on past the hold
      // would have asked its Harness peer by now.
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(gateway.peerRequests, 0, "the held wrapper never asks its Harness peer");
      assert.deepEqual(gateway.children, [], "OpenClaw must not start from an unusable record");
      assert.deepEqual(gateway.exits, [], "the wrapper holds rather than crash-looping");
      assert.equal(gateway.files.get(path), saved, "the record is kept for Pod replacement");
      assert.ok(
        gateway.logs.includes(
          `Gateway peer configuration record ${path} ${problem}. OpenClaw was not started. ` +
            "Delete the Pod to restore the managed configuration snapshot; native configuration " +
            "edits in this Pod are lost.",
        ),
        JSON.stringify(gateway.logs),
      );
      const phases = gateway.logs
        .filter((line) => typeof line === "string" && line.startsWith("{"))
        .map((line) => JSON.parse(line))
        .filter(({ event }) => event === "runtime.startup_phase")
        .map(({ phase, outcome, code }) => ({ phase, outcome, code }));
      assert.deepEqual(phases, [
        { phase: "peer-bridge-record", outcome: "failed", code: "PEER_BRIDGE_RECORD_UNUSABLE" },
      ]);
      const { runtimeFailure } = gateway.runtimeStatus();
      assert.equal(runtimeFailure.check, "peer-bridge-record");
      assert.equal(runtimeFailure.code, "UNAVAILABLE");
      assert.equal(gateway.status().phase, "starting");
      assert.equal((await readReadyStatusFromHandler(gateway.statusHandler)).status, 503);
      // The remedy deletes the Pod: termination ends the held wrapper at once.
      gateway.signalHandlers.SIGTERM();
      assert.deepEqual(gateway.exits, [0]);
    }
  });
}

test("Codex gateway supervisor preserves native edits when its initial config is writable", async (t) => {
  const gateway = await startCodexGatewaySupervisor(t, { writableConfig: true });
  const [first] = gateway.children;
  const path = "/home/node/.openclaw/openclaw.json";
  const edited = JSON.parse(gateway.files.get(path));
  edited.messages = { responsePrefix: "Native admin edit" };
  gateway.files.set(path, JSON.stringify(edited));
  await gateway.pollPeer();
  assert.equal(gateway.children.length, 1, "the same peer keeps its native process and edits");
  gateway.peerStatus = {
    ...gateway.peerStatus,
    startupId: "agent-startup-2",
    podUid: "agent-pod-2",
    successfulPluginIds: ["codex-plugin:linear@openai-curated-remote"],
    failures: [],
  };
  const respawn = gateway.pollPeer();
  await waitForCondition("the stale Gateway stop", () => first.killed.length === 1);
  first.exit(null, "SIGTERM");
  await respawn;
  assert.equal(
    gateway.children.length,
    2,
    JSON.stringify({
      state: gateway.files.get(path + ".oce-peer-bridge.json"),
      logs: gateway.logs,
    }),
  );
  const replacement = gateway.children[1];
  assert.equal(replacement.config.messages.responsePrefix, "Native admin edit");
  assert.equal(
    replacement.config.plugins.entries.codex.config.codexPlugins.plugins.linear.enabled,
    true,
  );
  assert.equal(replacement.token, gateway.token("agent-startup-2"));
  assert.equal(gateway.status().phase, "ready");
  assert.deepEqual(gateway.exits, []);
});

test("Codex gateway supervisor refuses a native edit back to an older generated bridge", async (t) => {
  const gateway = await startCodexGatewaySupervisor(t, { writableConfig: true });
  const [first] = gateway.children;
  const path = "/home/node/.openclaw/openclaw.json";
  const oldBridge = first.config.plugins.entries.codex.config.codexPlugins;
  gateway.peerStatus = {
    ...gateway.peerStatus,
    startupId: "agent-startup-2",
    podUid: "agent-pod-2",
    successfulPluginIds: ["codex-plugin:linear@openai-curated-remote"],
    failures: [],
  };
  const recovery = gateway.pollPeer();
  await waitForCondition("the first Gateway stop", () => first.killed.length === 1);
  first.exit(null, "SIGTERM");
  await recovery;
  const edited = JSON.parse(gateway.files.get(path));
  edited.plugins.entries.codex.config.codexPlugins = oldBridge;
  gateway.files.set(path, JSON.stringify(edited));
  const replacement = gateway.children[1];
  gateway.peerStatus = {
    ...gateway.peerStatus,
    startupId: "agent-startup-3",
    podUid: "agent-pod-3",
  };
  const refused = gateway.pollPeer();
  await waitForCondition("the replacement Gateway stop", () => replacement.killed.length === 1);
  replacement.exit(null, "SIGTERM");
  await refused;
  assert.equal(gateway.children.length, 2);
  assert.deepEqual(gateway.exits, [1]);
  assert.equal(
    JSON.parse(gateway.files.get(path)).plugins.entries.codex.config.codexPlugins.plugins.linear
      .enabled,
    false,
  );
});

test("Codex gateway supervisor retains refusal of a native-edited managed bridge", async (t) => {
  const gateway = await startCodexGatewaySupervisor(t, { writableConfig: true });
  const [first] = gateway.children;
  const path = "/home/node/.openclaw/openclaw.json";
  const edited = JSON.parse(gateway.files.get(path));
  edited.plugins.entries.codex.config.codexPlugins.plugins.linear.name = "Native edit";
  gateway.files.set(path, JSON.stringify(edited));
  gateway.peerStatus = {
    ...gateway.peerStatus,
    startupId: "agent-startup-2",
    podUid: "agent-pod-2",
    successfulPluginIds: ["codex-plugin:linear@openai-curated-remote"],
    failures: [],
  };
  const respawn = gateway.pollPeer();
  await waitForCondition("the stale Gateway stop", () => first.killed.length === 1);
  first.exit(null, "SIGTERM");
  await respawn;
  assert.equal(gateway.children.length, 1, "an operator edit cannot be overwritten by recovery");
  assert.equal(
    JSON.parse(gateway.files.get(path)).plugins.entries.codex.config.codexPlugins.plugins.linear
      .name,
    "Native edit",
  );
  assert.deepEqual(gateway.exits, [1]);
  // The record lists only bridges the wrapper generated. Were the operator's bridge in it, the
  // container restart that follows would treat the edit as generated and overwrite it.
  const { bridges } = JSON.parse(gateway.files.get(`${path}.oce-peer-bridge.json`));
  assert.equal(bridges.length, 1);
  assert.equal(bridges[0].plugins.linear.enabled, true, "the bridge generated for the new peer");
  assert.notEqual(bridges[0].plugins.linear.name, "Native edit");
});

test("Codex gateway supervisor respawns OpenClaw in place for a changed Harness peer", async (t) => {
  const gateway = await startCodexGatewaySupervisor(t);
  const [first] = gateway.children;
  assert.equal(first.token, gateway.token("agent-startup-1"));
  assert.equal(
    first.config.plugins.entries.codex.config.codexPlugins.plugins.linear.enabled,
    false,
  );
  assert.equal(gateway.status().phase, "ready");

  // The Harness restarted with a new startup and its plugin now authorized.
  gateway.peerStatus = {
    ...gateway.peerStatus,
    startupId: "agent-startup-2",
    podUid: "agent-pod-2",
    successfulPluginIds: ["codex-plugin:linear@openai-curated-remote"],
    failures: [],
  };
  gateway.serving = false;
  const respawn = gateway.pollPeer();
  await waitForCondition("the stale Gateway stop", () => first.killed.length === 1);
  assert.deepEqual(first.killed, ["SIGTERM"]);
  // Readiness drops before anything else, and nothing new starts while the
  // stale process (holding the old credential) is still running.
  assert.equal(gateway.status().phase, "starting");
  assert.deepEqual(gateway.status().failures, [gateway.initialFailure]);
  assert.equal(gateway.children.length, 1);

  first.exit(null, "SIGTERM");
  await waitForCondition("the respawned Gateway", () => gateway.children.length === 2);
  const second = gateway.children[1];
  assert.equal(second.token, gateway.token("agent-startup-2"));
  assert.equal(
    second.config.plugins.entries.codex.config.codexPlugins.plugins.linear.enabled,
    true,
  );
  // Spawned but not yet serving: still unready. The second refused probe shows
  // that the supervisor handled the first one and kept waiting.
  await waitForCondition(
    "two refused readiness probes of the respawned Gateway",
    () =>
      gateway.readinessProbes.filter(({ child, status }) => child === 2 && status === 503).length >=
      2,
    10_000,
  );
  assert.equal(gateway.status().phase, "starting");

  gateway.serving = true;
  await respawn;
  const ready = gateway.status();
  assert.equal(ready.phase, "ready");
  assert.deepEqual(ready.failures, []);
  assert.deepEqual(gateway.exits, [], "the wrapper, and so the container, keeps running");
  assert.deepEqual(second.killed, []);

  // An unchanged peer changes nothing.
  await gateway.pollPeer();
  assert.equal(gateway.children.length, 2);
  assert.deepEqual(second.killed, []);

  // An exit of the respawned process that no respawn asked for is still the container's.
  second.exit(1, null);
  assert.deepEqual(gateway.exits, [1]);
});

test("Codex gateway supervisor keeps OpenClaw when the same Harness returns after a status outage", async (t) => {
  const gateway = await startCodexGatewaySupervisor(t);
  const [first] = gateway.children;
  gateway.peerAvailable = false;
  const poll = gateway.pollPeer();
  await waitForCondition("readiness to drop", () => gateway.status().phase === "starting");
  gateway.peerAvailable = true;
  await poll;
  assert.equal(gateway.status().phase, "ready");
  assert.deepEqual(first.killed, [], "the Gateway's credential is still valid");
  assert.equal(gateway.children.length, 1);
  assert.deepEqual(gateway.exits, []);
});

test("Codex gateway supervisor exits when OpenClaw crashes during a peer status outage", async (t) => {
  const gateway = await startCodexGatewaySupervisor(t);
  const [first] = gateway.children;
  gateway.peerAvailable = false;
  const poll = gateway.pollPeer();
  await waitForCondition("readiness to drop", () => gateway.status().phase === "starting");

  // A status outage must not hide the running Gateway's own failure.
  first.exit(1, null);
  const exitsAfterCrash = [...gateway.exits];
  // process.exit is captured by this fixture, so release the pending peer wait.
  gateway.peerAvailable = true;
  await poll;
  assert.deepEqual(exitsAfterCrash, [1]);
});

test("Codex gateway supervisor forwards container termination during a peer status outage", async (t) => {
  const gateway = await startCodexGatewaySupervisor(t);
  const [first] = gateway.children;
  gateway.peerAvailable = false;
  const poll = gateway.pollPeer();
  await waitForCondition("readiness to drop", () => gateway.status().phase === "starting");

  gateway.signalHandlers.SIGTERM();
  assert.deepEqual(first.killed, ["SIGTERM"]);
  first.exit(null, "SIGTERM");
  assert.deepEqual(gateway.exits, [0]);
  gateway.peerAvailable = true;
  await poll;
  assert.equal(gateway.children.length, 1);
});

test("Codex gateway supervisor re-applies the workspace node binding on respawn", async (t) => {
  const deviceId = "a".repeat(64);
  const gateway = await startCodexGatewaySupervisor(t, { bindingDeviceId: deviceId });
  const [first] = gateway.children;
  assert.deepEqual(first.config.plugins.entries["file-transfer"].config.workspaces.main, {
    nodeId: deviceId,
    remoteRoot: "/home/node/workspace",
  });
  gateway.peerStatus = { ...gateway.peerStatus, startupId: "agent-startup-2" };
  const respawn = gateway.pollPeer();
  await waitForCondition("the stale Gateway stop", () => first.killed.length === 1);
  first.exit(null, "SIGTERM");
  await respawn;
  const second = gateway.children[1];
  assert.deepEqual(second.config.plugins.entries["file-transfer"].config.workspaces.main, {
    nodeId: deviceId,
    remoteRoot: "/home/node/workspace",
  });
  assert.ok(second.config.gateway.nodes.commands.allow.includes("file.fetch"));
  // The new process must acknowledge the node itself before the controller sees it.
  assert.equal(gateway.runtimeStatus().workspaceNodeId, undefined);
  assert.equal(gateway.status().phase, "ready");
  assert.deepEqual(gateway.exits, []);
});

test("Codex gateway supervisor rejects changed plugin successes while its replacement starts", async (t) => {
  const gateway = await startCodexGatewaySupervisor(t);
  const first = gateway.children[0];
  gateway.peerStatus = {
    ...gateway.peerStatus,
    startupId: "agent-startup-2",
    failures: [],
    successfulPluginIds: ["codex-plugin:linear@openai-curated-remote"],
  };
  gateway.serving = false;
  const respawn = gateway.pollPeer();
  await waitForCondition("the stale Gateway stop", () => first.killed.length === 1);
  first.exit(null, "SIGTERM");
  await waitForCondition("the replacement Gateway", () => gateway.children.length === 2);
  const replacement = gateway.children[1];
  try {
    // Same peer identity and failure set, but its reported success set changed.
    gateway.peerStatus = { ...gateway.peerStatus, successfulPluginIds: [] };
    gateway.serving = true;
    await respawn;
    assert.equal(gateway.status().phase, "starting");
    assert.deepEqual(replacement.killed, ["SIGTERM"]);
    assert.ok(
      gateway.logs.some((line) => {
        try {
          const entry = JSON.parse(line);
          return entry.phase === "peer-verification-changed" && entry.outcome === "failed";
        } catch {
          return false;
        }
      }),
    );
  } finally {
    replacement.exit(null, "SIGTERM");
  }
  assert.deepEqual(gateway.exits, [1]);
});

for (const [changedField, change] of [
  ["startup", { startupId: "agent-startup-3" }],
  ["pod", { podUid: "agent-pod-3" }],
  ["plugin failure set", { failures: [] }],
]) {
  test(`Codex gateway supervisor rejects a changed ${changedField} while its replacement starts`, async (t) => {
    const gateway = await startCodexGatewaySupervisor(t);
    const first = gateway.children[0];
    gateway.peerStatus = { ...gateway.peerStatus, startupId: "agent-startup-2" };
    gateway.serving = false;
    const respawn = gateway.pollPeer();
    await waitForCondition("the stale Gateway stop", () => first.killed.length === 1);
    first.exit(null, "SIGTERM");
    await waitForCondition("the replacement Gateway", () => gateway.children.length === 2);
    gateway.peerStatus = { ...gateway.peerStatus, ...change };
    gateway.serving = true;
    await respawn;

    const replacement = gateway.children[1];
    assert.equal(gateway.status().phase, "starting");
    assert.deepEqual(replacement.killed, ["SIGTERM"]);
    assert.ok(
      gateway.logs.some((line) => {
        try {
          const entry = JSON.parse(line);
          return entry.phase === "peer-verification-changed" && entry.outcome === "failed";
        } catch {
          return false;
        }
      }),
    );
    replacement.exit(null, "SIGTERM");
    assert.deepEqual(gateway.exits, [1]);
  });
}

test("Codex gateway supervisor fails closed if peer status disappears during replacement startup", async (t) => {
  const gateway = await startCodexGatewaySupervisor(t);
  const first = gateway.children[0];
  gateway.peerStatus = { ...gateway.peerStatus, startupId: "agent-startup-2" };
  gateway.serving = false;
  const respawn = gateway.pollPeer();
  await waitForCondition("the stale Gateway stop", () => first.killed.length === 1);
  first.exit(null, "SIGTERM");
  await waitForCondition("the replacement Gateway", () => gateway.children.length === 2);
  gateway.peerAvailable = false;
  gateway.serving = true;
  await respawn;

  const replacement = gateway.children[1];
  assert.equal(gateway.status().phase, "starting");
  assert.deepEqual(replacement.killed, ["SIGTERM"]);
  replacement.exit(null, "SIGTERM");
  assert.deepEqual(gateway.exits, [1]);
});

for (const termination of ["crash", "SIGTERM", "SIGINT"]) {
  test(`Codex gateway supervisor handles ${termination} while verifying the replacement peer`, async (t) => {
    const gateway = await startCodexGatewaySupervisor(t);
    const first = gateway.children[0];
    gateway.peerStatus = { ...gateway.peerStatus, startupId: "agent-startup-2" };
    gateway.serving = false;
    const respawn = gateway.pollPeer();
    await waitForCondition("the stale Gateway stop", () => first.killed.length === 1);
    first.exit(null, "SIGTERM");
    await waitForCondition("the replacement Gateway", () => gateway.children.length === 2);
    let releasePeer;
    gateway.peerGate = new Promise((resolve) => {
      releasePeer = resolve;
    });
    gateway.serving = true;
    await waitForCondition("the peer verification request", () => gateway.peerRequestPending);

    const replacement = gateway.children[1];
    try {
      if (termination !== "crash") {
        gateway.signalHandlers[termination]();
        assert.deepEqual(replacement.killed, [termination]);
        replacement.exit(null, termination);
      } else {
        replacement.exit(1, null);
      }
    } finally {
      releasePeer();
    }
    await respawn;
    assert.equal(gateway.status().phase, "starting");
    assert.deepEqual(gateway.exits, [termination === "SIGTERM" ? 0 : 1]);
    assert.equal(gateway.children.length, 2);
  });
}

test("Codex gateway supervisor bounds respawn retries and falls back to a container restart", async (t) => {
  const gateway = await startCodexGatewaySupervisor(t);
  gateway.peerStatus = { ...gateway.peerStatus, startupId: "agent-startup-2" };
  gateway.serving = false;
  const respawn = gateway.pollPeer();
  await waitForCondition("the stale Gateway stop", () => gateway.children[0].killed.length === 1);
  gateway.children[0].exit(null, "SIGTERM");
  // Every respawned process dies before it serves.
  for (let attempt = 1; attempt <= 3; attempt++) {
    // Retries back off by 1 s, then 2 s.
    const deadline = Date.now() + 5_000;
    while (gateway.children.length !== attempt + 1) {
      assert.ok(Date.now() < deadline, `respawn attempt ${attempt} did not start`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    gateway.children[attempt].exit(1, null);
    assert.equal(gateway.status().phase, "starting");
    assert.deepEqual(gateway.exits, [], "a respawn retry does not end the wrapper");
  }
  await respawn;
  assert.equal(gateway.children.length, 4);
  assert.deepEqual(gateway.exits, [1]);
  assert.equal(gateway.status().phase, "starting");
});

test("Codex gateway supervisor stops respawning a Gateway whose Harness keeps changing", async (t) => {
  const gateway = await startCodexGatewaySupervisor(t);
  for (let change = 2; change <= 6; change++) {
    const current = gateway.children.at(-1);
    gateway.peerStatus = { ...gateway.peerStatus, startupId: `agent-startup-${change}` };
    const respawn = gateway.pollPeer();
    await waitForCondition("the stale Gateway stop", () => current.killed.length === 1);
    current.exit(null, "SIGTERM");
    await respawn;
    assert.equal(gateway.status().phase, "ready");
  }
  assert.equal(gateway.children.length, 6);
  assert.deepEqual(gateway.exits, []);
  // A sixth change within the window: the kubelet's backoff takes over.
  const last = gateway.children.at(-1);
  gateway.peerStatus = { ...gateway.peerStatus, startupId: "agent-startup-7" };
  await gateway.pollPeer();
  assert.deepEqual(last.killed, ["SIGTERM"]);
  assert.equal(gateway.status().phase, "starting");
  last.exit(null, "SIGTERM");
  assert.deepEqual(gateway.exits, [1]);
  assert.equal(gateway.children.length, 6);
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
      name: kubernetesNamespaceName(tenant.id),
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
  assert.deepEqual(container.readinessProbe, {
    httpGet: { path: "/readyz", port: "plugin-status" },
    periodSeconds: 2,
  });
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
  const cp = kubernetesNamespaceName(tenant.id);
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
