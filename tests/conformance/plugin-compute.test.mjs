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
      toolDefaults: { approval: "approve" },
      ...overrides,
    },
  };
}

function codexSelection(overrides = {}) {
  return {
    "codex-plugin:linear@openai-curated-remote": {
      enabled: true,
      toolDefaults: { approval: "native" },
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
      skills: [],
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
    Date,
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

test("compute serializes selected Codex plugins for startup-time resolution", () => {
  const state = codexLinearPluginState({ toolDefaults: { approval: "native", reviewer: "auto" } });
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

test("Codex runtime helper installs selected remote plugins before readiness", async () => {
  const state = codexLinearPluginState({ toolDefaults: { approval: "native", reviewer: "auto" } });
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
              default_tools_approval_mode: "auto",
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
      assert.deepEqual(params, {});
      return codexConfigReadResponse({ approvals_reviewer: "auto_review" });
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
    toolDefaults: { enabled: false, approval: "prompt", reviewer: "human" },
    tools: { [CODEX_LINEAR_APP_ID + "/list_issues"]: { enabled: true, approval: "approve" } },
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
  const state = codexLinearPluginState({ toolDefaults: { approval: "native", reviewer: "auto" } });
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
          toolDefaults: { approval: "native" },
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
            return { __rawMessage: response(requestId) };
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

      assert.equal(result.error.diagnostic, undefined);
    });
  }
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
        toolDefaults: { approval: "native" },
      },
      "codex-plugin:asana@openai-curated-remote": {
        enabled: false,
        toolDefaults: { approval: "native" },
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

test("Codex runtime helper checks every effective nested tool and account policy before readiness", async (t) => {
  for (const scenario of [
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
      defaults: { approval: "prompt" },
      tools: { extra: { enabled: true } },
      rejects: true,
    },
    {
      name: "stricter unexpected approval also conflicts",
      defaults: { enabled: true, approval: "approve" },
      tools: { extra: { approval_mode: "prompt" } },
      rejects: true,
    },
  ]) {
    await t.test(scenario.name, async () => {
      const defaults = scenario.defaults ?? { enabled: false, approval: "prompt" };
      const state = codexLinearPluginState({ toolDefaults: defaults });
      const runtime = { manifest: pluginRuntimeSpecForRevision(revision({ plugins: state })) };
      // A second native layer can contribute descendants absent from the user
      // config OCE replaces. Return that merged readback through the real startup helper.
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
            return { status: "ok", version: "nested-policy" };
          }
          if (method === "config/read") {
            return codexConfigReadResponse({
              default_tools_enabled: defaults.enabled ?? null,
              default_tools_approval_mode: defaults.approval,
              tools: scenario.tools,
              links: scenario.links,
            });
          }
          throw new Error(`unexpected request ${method}`);
        },
        { captureError: true },
      );
      if (scenario.rejects) {
        assert.match(result.error?.message ?? "", /effective (tool|account) policy conflicts/);
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
  }, /embedded OpenClaw Harness/);
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
      namespace,
    ),
    data: { deviceId: Buffer.from("fixture-node").toString("base64") },
  };
}

test("embedded plugin preparation applies runtime egress before gateway readiness", async () => {
  const driver = createKubernetesComputeDriver(kubernetesOptions());
  const embedded = revision({
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    compute: { id: driver.id, implementation: driver.implementation },
    plugins: openClawPluginState(),
  });
  const namespace = kubernetesNamespaceName(tenant.id);
  const tenantOwnership = { namespaceId: tenant.id };
  const defaultPolicies = new Map(
    driver
      .networkPolicies(tenantOwnership, namespace)
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
  driver.resolveNamespace = async () => ({ name: namespace, external: false });
  driver.get = async (kind, name, target) =>
    kind === "Secret"
      ? credentialObjects.get(`${target}:${name}`)
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
      return credentialObjects.get(`${target}:${name}`);
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
  });
  assert.deepEqual(reconciled[runtimePolicyIndex].spec.egress[0].ports, [
    { protocol: "TCP", port: 443 },
  ]);

  const dedicatedDriver = dedicatedPluginDriver();
  const dedicated = revision({
    compute: { id: dedicatedDriver.id, implementation: dedicatedDriver.implementation },
    plugins: codexLinearPluginState({ toolDefaults: { approval: "native", reviewer: "auto" } }),
  });
  useRoutedGateway(dedicated);
  const dedicatedNamespace = kubernetesNamespaceName(dedicated.namespaceId);
  const dedicatedTenantOwnership = { namespaceId: dedicated.namespaceId };
  const dedicatedDefaultPolicies = new Map(
    dedicatedDriver
      .networkPolicies(dedicatedTenantOwnership, dedicatedNamespace)
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
      cp,
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
  dedicatedDriver.resolveNamespace = async () => ({ name: dedicatedNamespace, external: false });
  dedicatedDriver.get = async (kind, name, target) =>
    kind === "Secret"
      ? credentialObjects.get(`${target}:${name}`)
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
      return credentialObjects.get(`${target}:${name}`);
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
          () => driver.pluginRuntimeStatus(candidate, namespace, "gateway", []),
          DependencyUnavailableError,
        );
      } else {
        const status = await driver.pluginRuntimeStatus(candidate, namespace, "gateway", []);
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

  const observed = await driver.safeRuntimeFailureObservation(candidate, namespace);

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
  const scenarios = [
    { name: "failed login", loginStatus: 1 },
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
      name: "fatal top-level error despite assistant output",
      events: [started, assistant, { type: "error", message: "authentication failed" }, completed],
    },
    {
      name: "failed turn",
      events: [
        started,
        assistant,
        { type: "turn.failed", error: { message: "authentication failed" } },
      ],
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
        const sandbox = {
          URL,
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
                  if (nativeCalls === 1 && scenario.pat) {
                    assert.equal(command, "codex");
                    assert.deepEqual(Array.from(args), [
                      "-c",
                      "cli_auth_credentials_store=file",
                      "login",
                      "--with-access-token",
                    ]);
                    assert.equal(options.input, "at-fixture-token");
                  }
                  if (nativeCalls === 2) {
                    assert.equal(sandbox.process.env.CODEX_ACCESS_TOKEN, undefined);
                    assert.equal(sandbox.process.env.OPENAI_API_KEY, undefined);
                    assert.equal(sandbox.process.env.CODEX_CHATGPT_WORKSPACE_ID, undefined);
                  }
                  // Substitute only native process output; execute the production
                  // login/probe parser and readiness control flow unmodified.
                  return nativeCalls === 1
                    ? { status: scenario.loginStatus ?? 0 }
                    : {
                        status: scenario.probeStatus ?? 0,
                        stdout: scenario.events.map((event) => JSON.stringify(event)).join("\n"),
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
        assert.equal(nativeCalls, scenario.loginStatus === 1 ? 1 : 2);
        assert.ok(statusHandler);
        const runtimeStatus = readRuntimeStatusFromHandler(statusHandler);
        assert.equal(runtimeStatus.revisionId, revisionId);
        assert.equal(runtimeStatus.container, "agent");
        assert.equal(runtimeStatus.podUid, "pod-runtime-auth-gate");
        if (scenario.ready) {
          assert.equal(appServerStarts, 1);
          assert.deepEqual(diagnostics, []);
          assert.equal(idleTimers.length, 0);
          assert.equal(readFileSync(marker, "utf8"), "ready\n");
          assert.equal(runtimeStatus.runtimeFailure, undefined);
        } else {
          assert.equal(appServerStarts, 0);
          assert.deepEqual(diagnostics, ["Harness model authentication probe failed."]);
          assert.equal(idleTimers.length, 1);
          assert.equal(typeof idleTimers[0].callback, "function");
          assert.ok(idleTimers[0].delay > 0);
          assert.equal(existsSync(marker), false);
          assert.equal(runtimeStatus.runtimeFailure.component, "agent");
          assert.equal(
            runtimeStatus.runtimeFailure.check,
            scenario.loginStatus === 1 ? "login" : "model-probe",
          );
          assert.equal(
            runtimeStatus.runtimeFailure.code,
            scenario.loginStatus === 1 ? "LOGIN_FAILED" : "MODEL_PROBE_FAILED",
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
      plugins: codexLinearPluginState({ toolDefaults: { approval: "native", reviewer: "auto" } }),
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

test("Codex gateway supervisor applies broker-only bridge runtime without selected plugins", async () => {
  const revisionId = "revision-plugin-compute-1";
  const runtime = pluginRuntimeSpecForRevision(revision({ plugins: codexNoPluginState() }), {
    host: "git.oce.svc",
    domains: { "github.com": "allow", "*.oce.svc": "deny" },
  });
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
            throw new Error("broker-only bridge must not run native plugin installers");
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
  assert.deepEqual(effective.plugins.entries.codex.config.appServer.networkProxy, {
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
  });
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
    kubernetesNamespaceName(tenant.id),
    "openclaw-enterprise/agent-fixture:local",
    "agent-plugin-compute",
    "agent",
    {},
    "info",
    undefined,
    false,
    undefined,
    driver.harnessAuthForRevision(
      candidate,
      harnessAuthContext(candidate),
      kubernetesGatewayNamespaceName(tenant.id),
    ),
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

test("Kubernetes dedicated Codex gateway mounts broker-only runtime without plugin selections", async () => {
  const driver = createKubernetesComputeDriver(kubernetesOptions());
  const runtime = pluginRuntimeSpecForRevision(revision({ plugins: codexNoPluginState() }), {
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
    "oce-plugin-compute",
    "openclaw-enterprise/gateway-fixture:local",
    "gateway-plugin-compute",
    "gateway",
    {},
    "info",
    driver.gatewayConfiguration(revision(), undefined, "oce-plugin-compute"),
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
    "oce-plugin-compute",
    "openclaw-enterprise/gateway-fixture:local",
    "gateway-plugin-compute",
    "gateway",
    {},
    "info",
    driver.gatewayConfiguration(candidate, undefined, "oce-plugin-compute"),
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
      "oce-plugin-compute",
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
      .networkPolicies(tenantOwnership, namespace)
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
      cp,
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
  driver.resolveNamespace = async () => ({ name: namespace, external: false });
  driver.get = async (kind, name, target) =>
    kind === "Secret"
      ? credentialObjects.get(`${target}:${name}`)
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
      return credentialObjects.get(`${target}:${name}`);
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
          namespace,
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
              namespace,
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
        namespace,
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
      plugins: codexLinearPluginState({ toolDefaults: { approval: "native", reviewer: "auto" } }),
    }),
  );
  const deployment = driver.deployment(
    "gateway-plugin-compute-rev",
    {
      namespaceId: tenant.id,
      agentId: agent.id,
      revisionId: "revision-plugin-compute-1",
    },
    "oce-plugin-compute",
    "openclaw-enterprise/gateway-fixture:local",
    "gateway-plugin-compute",
    "gateway",
    {},
    "info",
    driver.gatewayConfiguration(revision(), undefined, "oce-plugin-compute"),
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
