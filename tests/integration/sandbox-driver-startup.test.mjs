import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import { createKubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { OpenShellCredentialRefreshDriver } from "../../apps/controller/src/drivers/credential-refresh/openshell.ts";
import { RUNTIME_WRAPPER_COMMAND } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import {
  OpenShellProviderAlreadyExistsError,
  OpenShellRequestReplayRefusedError,
  OpenShellSandboxAlreadyExistsError,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import {
  CredentialSourceRevisionError,
  SandboxRevisionUnsupportedError,
  ScopeViolationError,
} from "../../packages/occ/src/index.ts";
import { createInstallationDriverConfiguration as installation } from "../helpers/installation-driver-configuration.mjs";
import { loadInstallationFile } from "../helpers/installation-file.mjs";
import {
  WORKSPACE_DEFAULTS,
  WORKSPACE_DEFAULTS_ID,
} from "../../packages/contracts/src/workspace-defaults.mjs";
import { conformanceKubernetesOptions } from "../helpers/kubernetes-compute.mjs";

const controllerRequire = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);
const { KubernetesObjectApi } = controllerRequire("@kubernetes/client-node");

function sandboxInstallation() {
  const configuration = installation();
  configuration.drivers.compute.configuration.servicePrincipalCredentials = { mode: "disabled" };
  configuration.backend = [
    {
      id: "openshell",
      type: "openshell",
      configuration: {
        serviceName: "openshell-gateway",
        port: 50051,
        insecureTransport: "network-policy",
      },
      drivers: { sandbox: "openshell-sandbox", credential_gateway: "openshell-credentials" },
    },
  ];
  configuration.drivers.credential_gateway = {
    id: "openshell-credentials",
    configuration: { binaries: ["/app/bin/model-client"] },
  };
  configuration.drivers.sandbox = {
    id: "openshell-sandbox",
    configuration: {
      gateway: {
        workspaceMode: "operator",
      },
      kubernetes: {
        runtimeClassName: "openshell-sandbox",
        serviceAccount: { mode: "gatewayConfigured" },
        sandboxDataMount: {
          subPath: "workspace",
          mountPath: "/sandbox/enterprise",
          readOnly: false,
        },
      },
      policy: {
        process: { runAsUser: "1000", runAsGroup: "1000" },
        networkPolicies: [
          {
            name: "model-egress",
            endpoints: [{ host: "api.openai.com", ports: [443] }],
            binaries: [{ path: "/app/bin/model-client" }],
          },
        ],
      },
    },
  };
  return configuration;
}

function backendFor(gatewayClient) {
  return {
    id: "openshell",
    drivers: { sandbox: "openshell-sandbox", credential_gateway: "openshell-credentials" },
    client: new OpenShellGateway({ serviceName: "openshell-gateway" }, { gatewayClient }),
  };
}

function harnessRuntimeCommand(program) {
  return [...RUNTIME_WRAPPER_COMMAND, ...nodeProgramArguments(program)];
}

function workspaceGatewayClient(seed = [], events = []) {
  const workspaces = new Map(seed.map((workspace) => [workspace.name, structuredClone(workspace)]));
  const profiles = new Map();
  const providers = new Map();
  const calls = [];
  return {
    calls,
    profiles,
    providers,
    workspaces,
    async health() {
      calls.push(["health"]);
      events.push(["gateway", "health"]);
    },
    async getWorkspace(name) {
      calls.push(["getWorkspace", name]);
      events.push(["gateway", "getWorkspace", name]);
      return workspaces.get(name);
    },
    async createWorkspace(name, labels) {
      calls.push(["createWorkspace", name, structuredClone(labels)]);
      events.push(["gateway", "createWorkspace", name]);
      const workspace = { name, labels: structuredClone(labels), phase: "WORKSPACE_PHASE_ACTIVE" };
      workspaces.set(name, workspace);
      return workspace;
    },
    async deleteWorkspace(name) {
      calls.push(["deleteWorkspace", name]);
      events.push(["gateway", "deleteWorkspace", name]);
      workspaces.delete(name);
    },
    async createSandbox() {
      throw new Error("Sandbox creation is outside this Namespace lifecycle scenario.");
    },
    async getSandbox() {
      return undefined;
    },
    async getService() {
      return undefined;
    },
    async deleteSandbox() {},
    async getProviderProfile(_workspace, id) {
      return profiles.get(id);
    },
    async importProviderProfile(_workspace, profile) {
      profiles.set(profile.id, {
        id: profile.id,
        resourceVersion: "1",
        annotations: structuredClone(profile.annotations),
        profile: structuredClone(profile),
      });
    },
    async updateProviderProfile(_workspace, profile) {
      profiles.set(profile.id, {
        id: profile.id,
        resourceVersion: "2",
        annotations: structuredClone(profile.annotations),
        profile: structuredClone(profile),
      });
    },
    async deleteProviderProfile(_workspace, id) {
      profiles.delete(id);
    },
    async createProvider(request) {
      calls.push(["createProvider", structuredClone(request)]);
      if (providers.has(request.name)) {
        throw new Error(`Provider ${request.name} already exists.`);
      }
      const provider = {
        name: request.name,
        type: request.type,
        labels: structuredClone(request.labels),
        config: structuredClone(request.config ?? {}),
        resourceVersion: "1",
      };
      providers.set(request.name, provider);
      return provider;
    },
    async getProvider(_workspace, name) {
      return providers.get(name);
    },
    async listProviders() {
      return [...providers.values()];
    },
    async deleteProvider(_workspace, name) {
      providers.delete(name);
    },
    async updateProviderCredentials(_workspace, name, credentials) {
      calls.push(["updateProviderCredentials", name, structuredClone(credentials)]);
    },
    async updateProviderConfig(_workspace, name, config, expectedResourceVersion) {
      calls.push(["updateProviderConfig", name, structuredClone(config), expectedResourceVersion]);
      const provider = providers.get(name);
      assert.ok(provider, `Provider ${name} must exist before an update.`);
      assert.equal(provider.resourceVersion, expectedResourceVersion);
      const updated = {
        ...provider,
        config: { ...provider.config, ...structuredClone(config) },
        resourceVersion: String(Number(provider.resourceVersion) + 1),
      };
      providers.set(name, updated);
      return updated;
    },
    close() {},
  };
}

function kubernetesObjectClient(events) {
  const client = Object.create(KubernetesObjectApi.prototype);
  client.patch = async (resource) => {
    events.push([
      "kubernetes",
      "patch",
      resource.kind,
      resource.metadata.name,
      resource.metadata.namespace,
    ]);
    return resource;
  };
  client.delete = async (resource) => {
    events.push([
      "kubernetes",
      "delete",
      resource.kind,
      resource.metadata.name,
      resource.metadata.namespace,
    ]);
  };
  return client;
}

function namespaceContext(name = "oce-123456789012345") {
  return {
    namespace: {
      id: "ns_00000000-0000-4000-8000-000000000001",
      name,
      status: "ready",
      createdAt: "2026-09-23T00:00:00.000Z",
    },
    kubernetes: {},
    signal: new AbortController().signal,
  };
}

function codexRequirements(revision, environment = []) {
  return {
    loginMode: "api_key",
    image: "codex-runtime@sha256:synthetic",
    command: harnessRuntimeCommand('console.error("codex runtime");'),
    serviceAccountName: "agent-codex",
    serviceAccountToken: {
      audience: "openclaw-enterprise",
      expirationSeconds: 900,
      mountPath: "/var/run/secrets/openclaw-enterprise",
      path: "token",
      readOnly: true,
    },
    workspaceMounts: [
      {
        claimName: "harness-workspace-codex",
        subPath: "workspace",
        mountPath: "/home/node/workspace",
        readOnly: false,
      },
    ],
    credentialAttachments: [],
    environment: [
      { name: "APP_SERVER_PORT", value: "8080" },
      { name: "APP_TOKEN_SHA", value: "a".repeat(64) },
      ...environment,
    ],
    files: [
      {
        name: "runtime.json",
        content: JSON.stringify({ kind: "codex", selections: {} }),
        environmentVariable: "OPENCLAW_PLUGIN_RUNTIME_MANIFEST",
      },
      {
        name: "config.toml",
        content: "[features]\nplugins = false\n",
        environmentVariable: "OPENCLAW_PLUGIN_CODEX_CONFIG_TOML",
      },
    ],
    labels: { "openclaw.dev/revision": revision.id },
  };
}

function codexSandboxFixture(
  driver,
  {
    runtimeManifest = JSON.stringify({ kind: "codex", selections: {} }),
    codexConfig = "[features]\nplugins = false\n",
    files,
  } = {},
) {
  const context = namespaceContext();
  const revision = {
    id: "rev_00000000-0000-4000-8000-000000000003",
    namespaceId: context.namespace.id,
    agentId: "agt_00000000-0000-4000-8000-000000000003",
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    sandboxDriverId: driver.id,
  };
  const nodeSetup = {
    url: "wss://gateway.example.test/node",
    bootstrapToken: "one-shot-node-setup",
    expiresAtMs: Date.now() + 600_000,
    tlsFingerprint: "sha256:test",
  };
  const setupCode = Buffer.from(JSON.stringify(nodeSetup)).toString("base64url");
  const kubernetes = Object.create(KubernetesObjectApi.prototype);
  kubernetes.read = async ({ metadata }) => ({
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      ...metadata,
      labels: {
        "openclaw.dev/namespace": context.namespace.id,
        "openclaw.dev/agent": revision.agentId,
      },
    },
    data: { setupCode: Buffer.from(setupCode).toString("base64") },
  });
  context.kubernetes = kubernetes;
  const requirements = {
    loginMode: "api_key",
    image: "codex-runtime@sha256:synthetic",
    command: harnessRuntimeCommand('console.error("codex runtime");'),
    workspaceMounts: [
      {
        claimName: "harness-workspace-codex",
        subPath: "workspace",
        mountPath: "/home/node/workspace",
        readOnly: false,
      },
      {
        claimName: "harness-workspace-codex",
        subPath: "workspace-node-codex",
        mountPath: "/home/node/.openclaw-node",
        readOnly: false,
      },
      {
        claimName: "harness-workspace-codex",
        subPath: "codex-sessions",
        mountPath: "/home/node/.codex/sessions",
        readOnly: false,
      },
    ],
    credentialAttachments: [{ sourceId: "cs_test", ref: `oce-cs-${"b".repeat(24)}` }],
    environment: [
      { name: "HOME", value: "/home/node" },
      { name: "CODEX_HOME", value: "/home/node/.codex" },
      { name: "OPENCLAW_NODE_STATE_DIR", value: "/home/node/.openclaw-node" },
      { name: "OPENCLAW_WORKSPACE_DIR", value: "/home/node/workspace" },
      {
        name: "OPENCLAW_NODE_CA_PEM",
        value: "-----BEGIN CERTIFICATE-----\npublic-ca\n-----END CERTIFICATE-----\n",
      },
      { name: "APP_SERVER_PORT", value: "8080" },
      { name: "APP_TOKEN_SHA", value: "a".repeat(64) },
      {
        name: "OPENCLAW_NODE_SETUP_CODE",
        valueFrom: { secretKeyRef: { name: "workspace-node", key: "setupCode" } },
      },
    ],
    files: files ?? [
      {
        name: "runtime.json",
        content: runtimeManifest,
        environmentVariable: "OPENCLAW_PLUGIN_RUNTIME_MANIFEST",
      },
      {
        name: "config.toml",
        content: codexConfig,
        environmentVariable: "OPENCLAW_PLUGIN_CODEX_CONFIG_TOML",
      },
    ],
    labels: { "openclaw.dev/revision": revision.id },
  };
  return { context, revision, requirements, runtimeManifest, codexConfig, nodeSetup };
}

test("startup constructs the bundled OpenShell SandboxDriver before constructing Kubernetes Compute", async (t) => {
  const createdDriver = await loadInstallationFile(t, sandboxInstallation());

  assert.equal(createdDriver.installation.drivers.sandbox.id, "openshell-sandbox");
  assert.equal(createdDriver.installation.drivers.sandbox.implementation, "openshell");
  assert.ok(createdDriver.sandboxDriver instanceof OpenShellSandboxDriver);
  assert.equal(createdDriver.sandboxDriver.id, "openshell-sandbox");
  assert.deepEqual(createdDriver.sandboxDriver.facets, ["networking", "filesystem", "process"]);

  const pool = new pg.Pool({ connectionString: "postgresql://127.0.0.1:1/occ" });
  t.after(async () => pool.end());
  assert.doesNotThrow(() =>
    createControllerWorker({
      pool,
      mode: "production",
      drivers: createdDriver,
      emit: () => {},
    }),
  );
});

test("startup composes both OpenShell members from one Backend", async (t) => {
  // An explicit hard_requirement composes like the omitted default above.
  const configuration = sandboxInstallation();
  configuration.drivers.sandbox.configuration.policy.landlockCompatibility = "hard_requirement";
  const createdDriver = await loadInstallationFile(t, configuration);

  assert.ok(createdDriver.credentialGatewayDriver instanceof OpenShellCredentialGatewayDriver);
  assert.equal(createdDriver.credentialGatewayDriver.id, "openshell-credentials");
  assert.equal(createdDriver.installation.drivers.credential_gateway.implementation, "openshell");
  assert.deepEqual(createdDriver.installation.backend[0].drivers, {
    sandbox: createdDriver.sandboxDriver.id,
    credential_gateway: createdDriver.credentialGatewayDriver.id,
  });
});

test("startup pairs the Credential Refresh Driver with its gateway on one OpenShell Backend", async (t) => {
  const refreshing = () => {
    const configuration = sandboxInstallation();
    configuration.backend[0].drivers.credential_refresh = "openshell-refresh";
    configuration.drivers.credential_refresh = { id: "openshell-refresh", configuration: {} };
    configuration.drivers.credential_gateway.configuration.toolBinaries = ["/usr/bin/curl"];
    return configuration;
  };
  const createdDriver = await loadInstallationFile(t, refreshing());
  assert.ok(createdDriver.credentialRefreshDriver instanceof OpenShellCredentialRefreshDriver);
  assert.deepEqual(createdDriver.installation.backend[0].drivers, {
    sandbox: "openshell-sandbox",
    credential_gateway: "openshell-credentials",
    credential_refresh: "openshell-refresh",
  });
  // The gateway offers refresh types only when its Backend can mint their tokens.
  const signal = AbortSignal.timeout(2_000);
  const offered = await createdDriver.credentialGatewayDriver.listSourceTypes({ signal });
  assert.deepEqual(
    offered
      .filter(({ rotation }) => rotation === "refresh")
      .map(({ type }) => type)
      .sort(),
    ["codex-oauth", "oauth2-client-credentials", "oauth2-refresh-token"],
  );
  const withoutRefresh = sandboxInstallation();
  withoutRefresh.drivers.credential_gateway.configuration.toolBinaries = ["/usr/bin/curl"];
  const staticOnly = await loadInstallationFile(t, withoutRefresh);
  assert.deepEqual(
    (await staticOnly.credentialGatewayDriver.listSourceTypes({ signal })).map(({ type }) => type),
    ["openai", "bearer-token"],
  );

  // Refresh state lives on the gateway's provider records, so the roles cannot be split.
  const unselected = refreshing();
  delete unselected.drivers.credential_refresh;
  await assert.rejects(
    loadInstallationFile(t, unselected),
    /drivers\.credential_refresh must match the selected drivers\.credential_refresh\.id/,
  );
  const undeclared = refreshing();
  delete undeclared.backend[0].drivers.credential_refresh;
  await assert.rejects(
    loadInstallationFile(t, undeclared),
    /drivers\.credential_refresh must match the selected drivers\.credential_refresh\.id/,
  );
  const withoutGateway = refreshing();
  delete withoutGateway.drivers.credential_gateway;
  await assert.rejects(
    loadInstallationFile(t, withoutGateway),
    /drivers\.credential_refresh requires drivers\.credential_gateway/,
  );
  const configured = refreshing();
  configured.drivers.credential_refresh.configuration = { interval: 60 };
  await assert.rejects(loadInstallationFile(t, configured), /configuration/);
});

test("startup rejects an OpenShell Backend whose members are not both selected", async (t) => {
  const missingGateway = sandboxInstallation();
  delete missingGateway.drivers.credential_gateway;
  await assert.rejects(
    loadInstallationFile(t, missingGateway),
    /drivers\.credential_gateway must match the selected drivers\.credential_gateway\.id/,
  );

  const foreignSandbox = sandboxInstallation();
  foreignSandbox.backend[0].drivers.sandbox = "another-sandbox";
  await assert.rejects(
    loadInstallationFile(t, foreignSandbox),
    /drivers\.sandbox must match the selected bundled OpenShell drivers\.sandbox\.id/,
  );

  // Connection settings belong to the Backend; the Sandbox rejects them instead of ignoring them.
  const legacyEndpoint = sandboxInstallation();
  legacyEndpoint.drivers.sandbox.configuration.gateway.endpoint = "http://127.0.0.1:1";
  await assert.rejects(
    loadInstallationFile(t, legacyEndpoint),
    /OpenShell gateway option endpoint belongs to the openshell Backend/,
  );
});

test("startup requires protected OpenShell transport or an explicit NetworkPolicy boundary", async (t) => {
  const load = (configuration) => loadInstallationFile(t, configuration);
  // Credential registration sends resolved values, so plain or unauthenticated transport
  // must be declared rather than accepted by default.
  const undeclared = sandboxInstallation();
  delete undeclared.backend[0].configuration.insecureTransport;
  await assert.rejects(
    load(undeclared),
    /requires TLS with bearerTokenFile authentication, or insecureTransport: network-policy/,
  );
  // TLS alone is not enough; the gateway must also authenticate OCC.
  const tlsOnly = sandboxInstallation();
  tlsOnly.backend[0].configuration = { endpoint: "https://openshell-gateway.openshell.svc:8080" };
  await assert.rejects(load(tlsOnly), /requires TLS with bearerTokenFile authentication/);

  const protectedTransport = sandboxInstallation();
  protectedTransport.backend[0].configuration = {
    endpoint: "https://openshell-gateway.openshell.svc:8080",
    auth: { mode: "bearerTokenFile", path: "/etc/openclaw/openshell/token" },
  };
  await load(protectedTransport);

  // Export credentials use a separate operator identity; they cannot make an
  // otherwise unauthenticated ordinary RPC connection count as protected.
  const operatorTls = {
    certificatePath: "/etc/openclaw/openshell/operator.crt",
    privateKeyPath: "/etc/openclaw/openshell/operator.key",
  };
  protectedTransport.backend[0].configuration.operatorTls = operatorTls;
  await load(protectedTransport);
  tlsOnly.backend[0].configuration.operatorTls = operatorTls;
  await assert.rejects(load(tlsOnly), /requires TLS with bearerTokenFile authentication/);

  for (const invalid of [
    { certificatePath: operatorTls.certificatePath },
    { ...operatorTls, privateKeyPath: "operator.key" },
  ]) {
    protectedTransport.backend[0].configuration.operatorTls = invalid;
    await assert.rejects(load(protectedTransport), /operatorTls requires absolute/);
  }
  protectedTransport.backend[0].configuration.operatorTls = operatorTls;
  const plaintextOperator = sandboxInstallation();
  plaintextOperator.backend[0].configuration.operatorTls = operatorTls;
  await assert.rejects(load(plaintextOperator), /operatorTls requires a direct HTTPS/);

  // The declaration is only for unprotected transport, so it cannot mask a protected setup.
  protectedTransport.backend[0].configuration.insecureTransport = "network-policy";
  await assert.rejects(load(protectedTransport), /insecureTransport is only for unprotected/);

  // Every gateway call's deadline stays within the registration fence.
  const slow = sandboxInstallation();
  slow.backend[0].configuration.requestTimeoutMs = 60_000;
  await assert.rejects(load(slow), /requestTimeoutMs must be between 1000 and 30000 ms/);
});

test("OpenShell configures only the selected dedicated Harness runtime", () => {
  const driver = new OpenShellSandboxDriver(sandboxInstallation().drivers.sandbox.configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(workspaceGatewayClient()),
  });
  const configuration = {
    agents: { defaults: { model: "openai/gpt-5" } },
  };
  assert.deepEqual(
    driver.configureAgent(configuration, {
      id: "openclaw",
      version: "1.0.0",
      mode: "dedicated",
    }),
    { agents: { defaults: { model: "openai/gpt-5", workspace: "/sandbox/enterprise" } } },
  );
  assert.deepEqual(configuration, { agents: { defaults: { model: "openai/gpt-5" } } });

  const codex = driver.configureAgent(configuration, {
    id: "codex",
    version: "1.0.0",
    mode: "dedicated",
  });
  assert.equal(codex.plugins.entries.codex.config.appServer.sandbox, "danger-full-access");
  assert.throws(
    () =>
      driver.configureAgent(configuration, {
        id: "openclaw",
        version: "1.0.0",
        mode: "embedded",
      }),
    /supports only dedicated Harness revisions/,
  );
});

test("OpenShell pins an explicit main Agent workspace to the Sandbox data mount", () => {
  const driver = new OpenShellSandboxDriver(sandboxInstallation().drivers.sandbox.configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(workspaceGatewayClient()),
  });
  const harness = { id: "openclaw", version: "1.0.0", mode: "dedicated" };
  const configuration = {
    agents: {
      defaults: { model: "openai/gpt-5", workspace: "/home/node/.openclaw/workspace" },
      entries: {
        main: { model: "openai/gpt-5", workspace: "/home/node/elsewhere" },
        helper: { workspace: "/sandbox/enterprise/helper" },
      },
    },
  };
  const configured = driver.configureAgent(configuration, harness);
  assert.deepEqual(configured.agents, {
    defaults: { model: "openai/gpt-5", workspace: "/sandbox/enterprise" },
    entries: {
      main: { model: "openai/gpt-5", workspace: "/sandbox/enterprise" },
      helper: { workspace: "/sandbox/enterprise/helper" },
    },
  });
  assert.equal(configuration.agents.entries.main.workspace, "/home/node/elsewhere");
  // Status reads rerun the hook on stored work, so pinning must be idempotent.
  assert.deepEqual(driver.configureAgent(configured, harness), configured);
  // OpenClaw resolves entry keys case-insensitively, and an entry without a path is pinned too.
  assert.deepEqual(
    driver.configureAgent({ agents: { entries: { Main: {} } } }, harness).agents.entries,
    { Main: { workspace: "/sandbox/enterprise" } },
  );
  assert.throws(
    () => driver.configureAgent({ agents: { entries: { main: "/home/node/elsewhere" } } }, harness),
    /OpenShell main Agent entry/,
  );

  // The admitted revision's Gateway workspace is the mount the Harness and file transfer use.
  const compute = createKubernetesComputeDriver(
    conformanceKubernetesOptions({ gatewayTrustedProxyCidrs: ["127.0.0.1/32"] }),
  );
  assert.equal(
    compute.gatewayConfiguration({
      id: "rev_00000000-0000-4000-8000-000000000001",
      namespaceId: "ns_00000000-0000-4000-8000-000000000001",
      agentId: "agt_00000000-0000-4000-8000-000000000001",
      revision: 1,
      configurationId: "cfg_main_workspace",
      configurationKind: "agent",
      configurationGeneration: 1,
      configuration: {
        ...configured,
        logging: { level: "info", consoleLevel: "info", consoleStyle: "json" },
        diagnostics: { otel: { logs: false } },
      },
      harness,
    }).workspace,
    "/sandbox/enterprise",
  );
});

test("OpenShell provisions native OpenClaw without exposing an inbound Harness service", async () => {
  const requests = [];
  const gatewayClient = workspaceGatewayClient();
  gatewayClient.createSandbox = async (request) => {
    requests.push(request);
    return {
      name: request.name,
      labels: request.labels,
      serviceUrls: {},
    };
  };
  const configuration = sandboxInstallation().drivers.sandbox.configuration;
  configuration.policy.filesystem = {
    includeWorkdir: false,
    readOnly: ["/app"],
    readWrite: ["/var/tmp/openclaw"],
  };
  const driver = new OpenShellSandboxDriver(configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gatewayClient),
  });
  const context = namespaceContext();
  const revisionId = "rev_00000000-0000-4000-8000-000000000001";
  const revision = {
    id: revisionId,
    namespaceId: context.namespace.id,
    agentId: "agt_00000000-0000-4000-8000-000000000001",
    harness: { id: "openclaw", version: "1.0.0", mode: "dedicated" },
    sandboxDriverId: driver.id,
  };
  const labels = {
    "app.kubernetes.io/managed-by": "openclaw-enterprise",
    "openclaw.dev/agent": revision.agentId,
    "openclaw.dev/revision": revision.id,
    "openclaw.dev/workload-role": "agent",
  };
  const command = harnessRuntimeCommand('console.error("native runtime");');
  const sandbox = await driver.provisionHarness({
    ...context,
    revision,
    requirements: {
      loginMode: "api_key",
      image: "openclaw-runtime@sha256:synthetic",
      command,
      workspaceMounts: [
        {
          claimName: "harness-workspace-native-openclaw",
          subPath: "workspace",
          mountPath: "/home/node/workspace",
          readOnly: false,
        },
        {
          claimName: "harness-workspace-native-openclaw",
          subPath: "workspace-node-native-openclaw",
          mountPath: "/home/node/.openclaw-node",
          readOnly: false,
        },
      ],
      credentialAttachments: [],
      environment: [{ name: "TMPDIR", value: "/tmp/openclaw-native-worker" }],
      labels,
    },
  });

  assert.equal(sandbox.revisionId, revisionId);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].serviceExposures, []);
  assert.deepEqual(
    requests[0].spec.command.slice(0, RUNTIME_WRAPPER_COMMAND.length),
    RUNTIME_WRAPPER_COMMAND,
  );
  assert.notEqual(requests[0].spec.command[RUNTIME_WRAPPER_COMMAND.length], command.at(-2));
  assert.match(
    requests[0].spec.command[RUNTIME_WRAPPER_COMMAND.length],
    /OpenShell workspace link conflicts/,
  );
  assert.deepEqual(requests[0].labels, labels);
  assert.equal(requests[0].spec.environment.TMPDIR, "/tmp");
  assert.equal(requests[0].spec.policy.filesystem.include_workdir, false);
  assert.deepEqual(requests[0].spec.policy.filesystem.read_only, ["/app"]);
  assert.ok(requests[0].spec.policy.filesystem.read_write.includes("/var/tmp/openclaw"));
  assert.ok(requests[0].spec.policy.filesystem.read_write.includes("/tmp"));
  assert.equal(requests[0].spec.policy.filesystem.read_only.includes("/bin"), false);
  // The real Gateway receives this mode with the Sandbox request; a weaker
  // Landlock setting could let a ready Harness run without filesystem policy.
  assert.equal(requests[0].spec.policy.landlock.compatibility, "hard_requirement");
});

test("OpenShell adopts its revision's existing Sandbox instead of re-sending CreateSandbox", async () => {
  // The gateway's request_id replay refuses a changed spec and forgets a create after
  // 24 h, so a reconcile pass must find the existing Sandbox rather than create again.
  const gatewayClient = workspaceGatewayClient();
  const sandboxes = new Map();
  const services = new Map();
  const calls = [];
  let createError;
  gatewayClient.getSandbox = async ({ name, workspace }) => {
    calls.push(["getSandbox", name, workspace]);
    return sandboxes.get(name);
  };
  gatewayClient.getService = async (workspace, sandbox, service) => {
    calls.push(["getService", sandbox, workspace, service]);
    const url = services.get(sandbox);
    return url === undefined
      ? undefined
      : {
          sandbox,
          name: service,
          targetPort: 8080,
          authorizationMode: 2,
          advertisedUrl: url,
          url,
        };
  };
  gatewayClient.createSandbox = async (request) => {
    calls.push(["createSandbox", request.name, request.requestId]);
    const sandbox = {
      name: request.name,
      workspace: request.workspace,
      labels: request.labels,
      annotations: { ...request.annotations, "internal.openshell.ai/runtime-identity": "opaque" },
      spec: request.spec,
      serviceUrls: { "": `http://${request.workspace}--${request.name}.openshell.test/` },
    };
    sandboxes.set(request.name, sandbox);
    services.set(request.name, sandbox.serviceUrls[""]);
    if (createError !== undefined) {
      throw createError;
    }
    return sandbox;
  };
  const driver = new OpenShellSandboxDriver(sandboxInstallation().drivers.sandbox.configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gatewayClient),
  });
  const context = namespaceContext();
  const revision = {
    id: "rev_00000000-0000-4000-8000-000000000003",
    namespaceId: context.namespace.id,
    agentId: "agt_00000000-0000-4000-8000-000000000003",
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    sandboxDriverId: driver.id,
  };
  const provision = (environment = [], target = revision) =>
    driver.provisionHarness({
      ...context,
      revision: target,
      requirements: codexRequirements(revision, environment),
    });

  const first = await provision();
  const name = first.resourceName;
  assert.deepEqual(
    calls.map(([call]) => call),
    ["getSandbox", "createSandbox"],
  );
  // A later pass with a different spec rejects the stale Sandbox and never creates.
  calls.length = 0;
  await assert.rejects(
    provision([{ name: "CUSTOM_SETTING", value: "changed" }]),
    /without exact AgentRevision ownership and content/,
  );
  assert.deepEqual(calls, [["getSandbox", name, calls[0][2]]]);

  // ALREADY_EXISTS (a create that outlived its 24 h replay record) adopts this revision's Sandbox.
  sandboxes.clear();
  services.clear();
  createError = new OpenShellSandboxAlreadyExistsError(name);
  calls.length = 0;
  assert.deepEqual(await provision(), first);
  assert.deepEqual(
    calls.map(([call]) => call),
    ["getSandbox", "createSandbox", "getSandbox", "getService"],
  );
  createError = undefined;

  // The real client decodes with `oneofs: true`, which adds a virtual `_field` marker for each
  // set proto3 optional field. A gateway that reports one must still be adopted.
  const decoded = sandboxes.get(name);
  sandboxes.set(name, {
    ...decoded,
    spec: {
      ...decoded.spec,
      template: { ...decoded.spec.template, _user_namespaces: "user_namespaces" },
    },
  });
  assert.deepEqual(await provision(), first);
  sandboxes.set(name, decoded);

  // Another revision's Sandbox, or one without its Harness service, is never adopted.
  sandboxes.set(name, {
    ...sandboxes.get(name),
    annotations: { ...sandboxes.get(name).annotations, "openclaw.dev/revision-id": "rev_other" },
  });
  await assert.rejects(provision(), /without exact AgentRevision ownership and content/);
  sandboxes.set(name, {
    ...sandboxes.get(name),
    annotations: { ...sandboxes.get(name).annotations, "openclaw.dev/revision-id": revision.id },
  });
  // A Sandbox on its way out is never adopted as this revision's Harness.
  for (const [phase, message] of [
    ["SANDBOX_PHASE_DELETING", /is being deleted; it can be created again once deletion finishes/],
    ["SANDBOX_PHASE_STOPPED", /has stopped; remove the stale Sandbox/],
    ["SANDBOX_PHASE_COMPLETED", /has stopped; remove the stale Sandbox/],
  ]) {
    sandboxes.set(name, { ...sandboxes.get(name), phase });
    await assert.rejects(provision(), message);
  }
  sandboxes.set(name, { ...sandboxes.get(name), phase: "SANDBOX_PHASE_READY" });
  services.delete(name);
  await assert.rejects(provision(), /exists without its exact bearer-passthrough Harness service/);
});

test("OpenShell moves a revision's create to a fresh request_id after the gateway refuses the old one", async () => {
  // OpenShell admits a request_id before running CreateSandbox and leaves it unresolved
  // forever if the handler errors, so reusing the revision UUID would never provision.
  const gatewayClient = workspaceGatewayClient();
  const sandboxes = new Map();
  const admissions = new Map();
  const calls = [];
  let handlerError;
  let refuseEverything;
  let onRefusal;
  let holdHandler;
  let nextId = 0;
  const refused = (reason) => new OpenShellRequestReplayRefusedError(reason, reason);
  gatewayClient.getSandbox = async ({ name }) => {
    calls.push(["getSandbox"]);
    return sandboxes.get(name);
  };
  gatewayClient.getService = async (_workspace, sandbox, service) => {
    calls.push(["getService"]);
    const url = sandboxes.get(sandbox)?.serviceUrls[""];
    return url === undefined
      ? undefined
      : {
          sandbox,
          name: service,
          targetPort: 8080,
          authorizationMode: 2,
          advertisedUrl: url,
          url,
        };
  };
  gatewayClient.createSandbox = async (request) => {
    calls.push(["createSandbox", request.requestId]);
    const payload = JSON.stringify({ ...request, requestId: undefined });
    const admitted = admissions.get(request.requestId);
    let refusal;
    if (refuseEverything !== undefined) {
      refusal = refused(refuseEverything);
    } else if (admitted !== undefined) {
      if (admitted.payload !== payload) {
        refusal = refused("REQUEST_ID_PAYLOAD_MISMATCH");
      } else if (admitted.sandboxId === undefined) {
        refusal = refused("REQUEST_OUTCOME_UNCERTAIN");
      } else if (sandboxes.get(request.name)?.id !== admitted.sandboxId) {
        refusal = refused("REQUEST_REPLAY_UNAVAILABLE");
      } else {
        return sandboxes.get(request.name);
      }
    }
    if (refusal !== undefined) {
      onRefusal?.(request);
      onRefusal = undefined;
      throw refusal;
    }
    admissions.set(request.requestId, { payload });
    if (handlerError !== undefined) {
      const error = handlerError;
      handlerError = undefined;
      throw error;
    }
    if (holdHandler !== undefined) {
      const held = holdHandler;
      holdHandler = undefined;
      await held;
    }
    // OpenShell keeps Sandbox names unique per Workspace.
    if (sandboxes.has(request.name)) {
      throw new OpenShellSandboxAlreadyExistsError(request.name);
    }
    const sandbox = {
      id: `sandbox-${nextId++}`,
      name: request.name,
      workspace: request.workspace,
      labels: request.labels,
      annotations: request.annotations,
      spec: request.spec,
      serviceUrls: { "": `http://${request.workspace}--${request.name}.openshell.test/` },
    };
    sandboxes.set(request.name, sandbox);
    admissions.get(request.requestId).sandboxId = sandbox.id;
    return sandbox;
  };
  const driverFor = () =>
    new OpenShellSandboxDriver(sandboxInstallation().drivers.sandbox.configuration, {
      id: "openshell-sandbox",
      implementation: "openshell",
      backend: backendFor(gatewayClient),
    });
  const driver = driverFor();
  const context = namespaceContext();
  const revision = {
    id: "rev_00000000-0000-4000-8000-000000000004",
    namespaceId: context.namespace.id,
    agentId: "agt_00000000-0000-4000-8000-000000000004",
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    sandboxDriverId: driver.id,
  };
  const provision = (target = driver) =>
    target.provisionHarness({
      ...context,
      revision,
      requirements: codexRequirements(revision),
    });
  const trace = () => {
    const seen = calls.map(([call, id]) => (id === undefined ? call : `${call}:${id}`));
    calls.length = 0;
    return seen;
  };
  const id0 = "00000000-0000-4000-8000-000000000004";

  // A create that errors server-side leaves its request_id unresolved.
  handlerError = new Error("provider 'model' not found");
  await assert.rejects(provision(), /provider 'model' not found/);
  assert.deepEqual(trace(), ["getSandbox", `createSandbox:${id0}`]);

  // The next pass sees the refusal and no Sandbox, then creates with the next request_id.
  const first = await provision();
  const [, refusedCreate, , freshCreate] = trace();
  assert.equal(refusedCreate, `createSandbox:${id0}`);
  const id1 = freshCreate.slice("createSandbox:".length);
  assert.match(id1, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(id1, id0);
  assert.equal(sandboxes.size, 1);

  // Each failing pass spends at most one new request_id.
  sandboxes.clear();
  handlerError = new Error("compute driver unavailable");
  await assert.rejects(provision(), /compute driver unavailable/);
  const failed = trace();
  assert.deepEqual(failed.slice(0, 4), [
    "getSandbox",
    `createSandbox:${id0}`,
    "getSandbox",
    `createSandbox:${id1}`,
  ]);
  assert.equal(failed.length, 6);
  const id2 = failed[5].slice("createSandbox:".length);

  // A restarted controller derives the same request_ids; a deleted Sandbox whose create
  // succeeded (REQUEST_REPLAY_UNAVAILABLE) is replaced under the next one.
  const restarted = driverFor();
  assert.deepEqual(await provision(restarted), first);
  const recreated = trace();
  assert.deepEqual(recreated, [
    "getSandbox",
    `createSandbox:${id0}`,
    "getSandbox",
    `createSandbox:${id1}`,
    "getSandbox",
    `createSandbox:${id2}`,
    "getSandbox",
    recreated[7],
  ]);
  assert.equal(sandboxes.size, 1);
  assert.equal(new Set(recreated.filter((call) => call.startsWith("createSandbox"))).size, 4);

  // The live Sandbox is adopted without any create.
  assert.deepEqual(await provision(), first);
  assert.deepEqual(trace(), ["getSandbox", "getService"]);

  // A refused request_id whose earlier call creates the Sandbox meanwhile is adopted;
  // no further request_id is tried.
  sandboxes.clear();
  onRefusal = (request) => {
    sandboxes.set(request.name, {
      id: "sandbox-late",
      name: request.name,
      workspace: request.workspace,
      labels: request.labels,
      annotations: request.annotations,
      spec: request.spec,
      serviceUrls: { "": `http://${request.workspace}--${request.name}.openshell.test/` },
    });
  };
  assert.deepEqual(await provision(), first);
  assert.deepEqual(trace(), ["getSandbox", `createSandbox:${id0}`, "getSandbox", "getService"]);

  // Two concurrent passes: the later one is refused the held request_id, advances, and
  // creates; the held create then loses the name and adopts the same Sandbox.
  sandboxes.clear();
  let release;
  holdHandler = new Promise((resolve) => {
    release = resolve;
  });
  const held = provision();
  for (let turn = 0; holdHandler !== undefined; turn++) {
    if (turn === 1000) {
      assert.fail("the first pass never reached CreateSandbox");
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(await provision(), first);
  release();
  assert.deepEqual(await held, first);
  assert.equal(sandboxes.size, 1);
  const creates = trace().filter((call) => call.startsWith("createSandbox"));
  // The held pass walks to request_id X; the other walks the same IDs, is refused X, and
  // creates under the next one, Y.
  const walked = (creates.length - 1) / 2;
  assert.deepEqual(creates.slice(walked, -1), creates.slice(0, walked));
  assert.equal(new Set(creates).size, walked + 1);

  // The request_ids are bounded; exhausting them never creates a Sandbox.
  sandboxes.clear();
  refuseEverything = "REQUEST_OUTCOME_UNCERTAIN";
  await assert.rejects(provision(), /refused all 16 create request IDs .*deploy a new revision/);
  const exhausted = trace().filter((call) => call.startsWith("createSandbox"));
  assert.equal(exhausted.length, 16);
  assert.equal(new Set(exhausted).size, 16);
  assert.equal(sandboxes.size, 0);
  // Every ID refused as unreplayable also points at the gateway's key material.
  refuseEverything = "REQUEST_REPLAY_UNAVAILABLE";
  await assert.rejects(provision(), /refused all 16 .*key material is readable/);
  assert.equal(sandboxes.size, 0);
});

test("OpenShell rejects raw app-server tokens as a permanent revision failure", async () => {
  const gatewayClient = workspaceGatewayClient();
  gatewayClient.createSandbox = async () => {
    throw new Error("OpenShell must not receive a Sandbox it cannot configure.");
  };
  const driver = new OpenShellSandboxDriver(sandboxInstallation().drivers.sandbox.configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gatewayClient),
  });
  const context = namespaceContext();
  const revision = {
    id: "rev_00000000-0000-4000-8000-000000000002",
    namespaceId: context.namespace.id,
    agentId: "agt_00000000-0000-4000-8000-000000000002",
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    sandboxDriverId: driver.id,
  };
  const provision = (harness) =>
    driver.provisionHarness({
      ...context,
      revision: { ...revision, harness },
      requirements: codexRequirements(revision, [
        {
          name: "APP_SERVER_TOKEN",
          valueFrom: { secretKeyRef: { name: "agent-codex-token", key: "token" } },
        },
      ]),
    });

  await assert.rejects(provision(revision.harness), (error) => {
    assert.ok(error instanceof SandboxRevisionUnsupportedError, String(error));
    assert.equal(error.code, "SANDBOX_SECRET_ENVIRONMENT_UNSUPPORTED");
    assert.match(error.message, /cannot receive APP_SERVER_TOKEN/);
    return true;
  });
  await assert.rejects(provision({ id: "codex", version: "1.0.0", mode: "embedded" }), (error) => {
    assert.ok(error instanceof SandboxRevisionUnsupportedError, String(error));
    assert.equal(error.code, "SANDBOX_HARNESS_UNSUPPORTED");
    return true;
  });
});

test("OpenShell rejects projected Agent identity before gateway mutation", async () => {
  const gatewayClient = workspaceGatewayClient();
  const driver = new OpenShellSandboxDriver(sandboxInstallation().drivers.sandbox.configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gatewayClient),
  });
  const { context, revision, requirements } = codexSandboxFixture(driver);
  requirements.workloadIdentity = {
    serviceAccountName: "agent-codex",
    token: {
      audience: "openclaw-enterprise",
      expirationSeconds: 900,
      mountPath: "/var/run/secrets/openclaw-enterprise",
      path: "token",
      readOnly: true,
    },
  };

  await assert.rejects(driver.provisionHarness({ ...context, revision, requirements }), (error) => {
    assert.ok(error instanceof SandboxRevisionUnsupportedError, String(error));
    assert.equal(error.code, "SANDBOX_HARNESS_UNSUPPORTED");
    assert.match(error.message, /cannot preserve an Agent ServiceAccount/);
    return true;
  });
  assert.deepEqual(gatewayClient.calls, []);
});

test("OpenShell provisions dedicated Codex with bearer passthrough and provider files", async () => {
  const requests = [];
  let getServiceCalls = 0;
  let storedSandbox;
  const withProtobufKinds = (value) => {
    if (Array.isArray(value)) {
      return value.map(withProtobufKinds);
    }
    if (value === null || typeof value !== "object") {
      return value;
    }
    const normalized = Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, withProtobufKinds(entry)]),
    );
    const kind = [
      "nullValue",
      "numberValue",
      "stringValue",
      "boolValue",
      "structValue",
      "listValue",
    ].find((key) => Object.hasOwn(normalized, key));
    return kind === undefined ? normalized : { ...normalized, kind };
  };
  const gatewayClient = workspaceGatewayClient();
  gatewayClient.createSandbox = async (request) => {
    requests.push(structuredClone(request));
    storedSandbox = {
      name: request.name,
      workspace: request.workspace,
      labels: structuredClone(request.labels),
      annotations: {
        ...structuredClone(request.annotations),
        "internal.openshell.ai/auth-epoch": "1",
        "internal.openshell.ai/runtime-generation": "runtime-generation",
      },
      spec: {
        ...structuredClone(request.spec),
        template: {
          ...structuredClone(request.spec.template),
          driver_config: withProtobufKinds(request.spec.template.driver_config),
        },
      },
      serviceUrls: {},
    };
    return {
      ...storedSandbox,
      serviceUrls: { "": "http://codex.example.test" },
    };
  };
  gatewayClient.getSandbox = async () => storedSandbox;
  gatewayClient.getService = async () => {
    getServiceCalls++;
    return {
      sandbox: storedSandbox.name,
      name: "",
      targetPort: 8080,
      authorizationMode: "SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH",
      advertisedUrl: "http://codex.example.test:8080/",
      url: "http://codex.example.test",
    };
  };
  const driver = new OpenShellSandboxDriver(sandboxInstallation().drivers.sandbox.configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gatewayClient),
  });
  const { context, revision, requirements, runtimeManifest, codexConfig, nodeSetup } =
    codexSandboxFixture(driver);

  await driver.ensureNamespace(context);
  await driver.provisionHarness({ ...context, revision, requirements });
  await driver.provisionHarness({ ...context, revision, requirements });
  assert.deepEqual(await driver.harnessEndpoint({ ...context, revision, requirements }), {
    url: "ws://codex.example.test:8080/",
    workspaceRoot: "/sandbox/enterprise",
  });

  assert.equal(requests.length, 1);
  assert.equal(getServiceCalls, 2);
  assert.equal(requests[0].spec.tty, undefined);
  assert.equal(requests[0].spec.template.annotations, undefined);
  assert.deepEqual(requests[0].serviceExposures, [
    { service: "", targetPort: 8080, authorizationMode: "bearer_passthrough" },
  ]);
  assert.equal(requests[0].spec.environment.APP_TOKEN_SHA, "a".repeat(64));
  assert.equal(requests[0].spec.environment.APP_SERVER_TOKEN, undefined);
  assert.equal(requests[0].spec.environment.OPENCLAW_NODE_SETUP_CODE, undefined);
  assert.equal(requests[0].spec.environment.OPENCLAW_NODE_CA_PEM, undefined);
  assert.equal(requests[0].spec.environment.HOME, "/sandbox/.openclaw-runtime/home");
  assert.equal(requests[0].spec.environment.TMPDIR, "/tmp");
  assert.equal(requests[0].spec.environment.CODEX_HOME, "/sandbox/.openclaw-runtime/home/.codex");
  const nodeStateDirectory = requests[0].spec.environment.OPENCLAW_NODE_STATE_DIR;
  assert.match(nodeStateDirectory, /^\/sandbox\/\.openclaw-mounts\/[a-f0-9]{16}\/state$/u);
  assert.equal(requests[0].spec.environment.OPENCLAW_WORKSPACE_DIR, "/sandbox/enterprise");
  const kubernetesDriver =
    requests[0].spec.template.driver_config.fields.kubernetes.structValue.fields;
  const agentContainer = kubernetesDriver.containers.structValue.fields.agent.structValue.fields;
  assert.deepEqual(
    agentContainer.resources.structValue.fields.requests.structValue.fields["ephemeral-storage"],
    { stringValue: "256Mi" },
  );
  assert.deepEqual(
    agentContainer.resources.structValue.fields.limits.structValue.fields["ephemeral-storage"],
    { stringValue: "1Gi" },
  );
  assert.equal(
    agentContainer.volume_mounts.listValue.values.some(
      ({ structValue }) => structValue.fields.mount_path?.stringValue === "/home/node/workspace",
    ),
    false,
  );
  const runtimeMount = agentContainer.volume_mounts.listValue.values.find(
    ({ structValue }) =>
      structValue.fields.mount_path?.stringValue === "/sandbox/.openclaw-runtime",
  )?.structValue.fields;
  assert.ok(runtimeMount, "OpenShell requires a writable runtime root mount.");
  assert.match(runtimeMount.sub_path.stringValue, /^openshell-runtime-[a-f0-9]{16}$/);
  assert.equal(runtimeMount.read_only.boolValue, false);
  assert.ok(
    agentContainer.volume_mounts.listValue.values.some(({ structValue }) =>
      /^\/sandbox\/\.openclaw-mounts\/[a-f0-9]{16}$/u.test(
        structValue.fields.mount_path?.stringValue ?? "",
      ),
    ),
  );
  assert.ok(
    agentContainer.volume_mounts.listValue.values.some(
      ({ structValue }) =>
        `${structValue.fields.mount_path?.stringValue}/state` === nodeStateDirectory &&
        structValue.fields.read_only?.boolValue === false,
    ),
    "the node-state environment must name a process-owned child of its real writable PVC mount",
  );
  assert.equal(
    agentContainer.volume_mounts.listValue.values.some(({ structValue }) =>
      (structValue.fields.mount_path?.stringValue ?? "").startsWith("/sandbox/.openclaw-runtime/"),
    ),
    false,
  );
  assert.match(
    requests[0].spec.command[RUNTIME_WRAPPER_COMMAND.length],
    /\/sandbox\/\.openclaw-runtime\/home\/\.codex\/sessions/,
  );
  assert.match(
    requests[0].spec.command[RUNTIME_WRAPPER_COMMAND.length],
    /\/sandbox\/\.openclaw-mounts\/[a-f0-9]{16}/,
  );
  assert.doesNotMatch(
    requests[0].spec.command[RUNTIME_WRAPPER_COMMAND.length],
    /\.openclaw-node/,
    "node state must not use a symlink because OpenClaw atomically replaces files below it",
  );
  assert.ok(requests[0].spec.policy.filesystem.read_write.includes("/sandbox/.openclaw-runtime"));
  assert.ok(requests[0].spec.policy.filesystem.read_write.includes("/sandbox/enterprise"));
  assert.ok(requests[0].spec.policy.filesystem.read_write.includes("/tmp"));
  assert.ok(requests[0].spec.policy.filesystem.read_write.includes("/dev/null"));
  assert.deepEqual(requests[0].spec.policy.filesystem.read_only, [
    "/bin",
    "/usr",
    "/lib",
    "/proc",
    "/dev/urandom",
    "/etc",
    "/var/log",
    "/app",
  ]);
  assert.ok(requests[0].spec.providers.includes(`oce-cs-${"b".repeat(24)}`));
  const runtimeProvider = requests[0].spec.providers.find((name) =>
    name.startsWith("oce-runtime-"),
  );
  assert.ok(runtimeProvider);
  assert.deepEqual(gatewayClient.providers.get(runtimeProvider).config, {
    runtime_json: runtimeManifest,
    config_toml: codexConfig,
    node_ca_pem: "-----BEGIN CERTIFICATE-----\npublic-ca\n-----END CERTIFICATE-----\n",
    node_setup_json: JSON.stringify({
      url: nodeSetup.url,
      bootstrapToken: nodeSetup.bootstrapToken,
      expiresAtMs: nodeSetup.expiresAtMs,
      tlsFingerprint: nodeSetup.tlsFingerprint,
    }),
  });
  const providerCreate = gatewayClient.calls.find(([operation]) => operation === "createProvider");
  assert.deepEqual(providerCreate[1].credentials, {});
  assert.deepEqual(providerCreate[1].credentialExpirationTimes, {});
  const runtimeProfile = gatewayClient.profiles.get("oce-codex-runtime").profile;
  // OpenShell v0.1.3-pre.2 hashes protobuf maps without canonical ordering. Keeping
  // ownership and content identity in one entry prevents startup revision churn.
  assert.deepEqual(Object.keys(runtimeProfile.annotations), ["openclaw.dev/managed-by"]);
  assert.match(
    runtimeProfile.annotations["openclaw.dev/managed-by"],
    /^openclaw-enterprise:[a-f0-9]{64}$/,
  );
  assert.deepEqual(runtimeProfile.files, [
    {
      path: "runtime.json",
      content: "{{config.runtime_json}}",
      environmentVariable: "OPENCLAW_PLUGIN_RUNTIME_MANIFEST",
    },
    {
      path: "config.toml",
      content: "{{config.config_toml}}",
      environmentVariable: "OPENCLAW_PLUGIN_CODEX_CONFIG_TOML",
    },
    {
      path: "node-setup.json",
      content: "{{config.node_setup_json}}",
      environmentVariable: "OPENCLAW_NODE_SETUP_ENVELOPE",
    },
    {
      path: "node-ca.pem",
      content: "{{config.node_ca_pem}}",
      environmentVariable: "OPENCLAW_NODE_CA_PATH",
    },
  ]);
  // A wss setup URL keeps TLS end to end to the Gateway route the node's CA pins;
  // OpenShell must not terminate it, so the rule binds only binary, host, and port.
  assert.deepEqual(requests[0].spec.policy.network_policies["workspace-node-enrollment"], {
    name: "workspace-node-enrollment",
    binaries: [{ path: "/usr/local/bin/node" }],
    endpoints: [
      {
        host: "gateway.example.test",
        ports: [443],
        tls: "NETWORK_TLS_MODE_SKIP",
        enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
      },
    ],
  });

  await driver.cleanup({ ...context, revision });
  assert.equal(gatewayClient.providers.has(runtimeProvider), false);
  assert.equal(gatewayClient.profiles.has("oce-codex-runtime"), true);

  await driver.cleanup(context);
  assert.equal(gatewayClient.profiles.has("oce-codex-runtime"), false);
});

test("OpenShell delivers initial workspace files privately after supervisor readiness", async (t) => {
  const gatewayClient = workspaceGatewayClient();
  const driver = new OpenShellSandboxDriver(sandboxInstallation().drivers.sandbox.configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gatewayClient),
  });
  const { context, revision, requirements } = codexSandboxFixture(driver);
  const setup = {
    id: "initial-workspace",
    namespaceId: revision.namespaceId,
    agentId: revision.agentId,
    defaultsId: WORKSPACE_DEFAULTS_ID,
    completed: false,
    files: { ...WORKSPACE_DEFAULTS, "AGENTS.md": "Private initial Agent instructions\n" },
  };
  requirements.workspaceSetup = {
    id: setup.id,
    defaultsId: setup.defaultsId,
    secretKeyRef: { name: "workspace-setup", key: "setup.json" },
  };
  const readNodeSecret = context.kubernetes.read;
  let foreign = false;
  context.kubernetes.read = async (request) =>
    request.metadata.name !== "workspace-setup"
      ? readNodeSecret(request)
      : {
          apiVersion: "v1",
          kind: "Secret",
          metadata: {
            ...request.metadata,
            labels: {
              "openclaw.dev/namespace": revision.namespaceId,
              "openclaw.dev/agent": foreign ? "another-agent" : revision.agentId,
            },
          },
          data: { "setup.json": Buffer.from(JSON.stringify(setup)).toString("base64") },
        };
  let sandbox;
  gatewayClient.createSandbox = async (request) => {
    sandbox = {
      ...structuredClone(request),
      phase: "SANDBOX_PHASE_PROVISIONING",
      serviceUrls: { "": "http://codex.example.test" },
    };
    return sandbox;
  };
  gatewayClient.getSandbox = async () => sandbox;
  gatewayClient.getService = async () => ({
    targetPort: 8080,
    authorizationMode: "SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH",
    url: "http://codex.example.test",
  });
  const executions = [];
  let exitCode = 0;
  gatewayClient.execSandbox = async (request) => {
    executions.push(request);
    return exitCode;
  };
  const provision = () => driver.provisionHarness({ ...context, revision, requirements });

  await provision();
  assert.equal(executions.length, 0, "private initialization waits for supervisor readiness");
  sandbox.phase = "SANDBOX_PHASE_READY";
  await provision();
  const execution = executions[0];
  assert.deepEqual(JSON.parse(execution.stdin), setup);
  assert.equal(execution.environment.OPENCLAW_WORKSPACE_DIR, "/sandbox/enterprise");
  assert.equal(JSON.stringify(execution.command).includes(setup.files["AGENTS.md"]), false);
  assert.equal(JSON.stringify(sandbox).includes(setup.files["AGENTS.md"]), false);
  assert.equal(
    JSON.stringify([...gatewayClient.providers.values()]).includes(setup.files["AGENTS.md"]),
    false,
  );

  // Failed initialization and foreign Secret ownership must never report successful delivery.
  exitCode = 1;
  await assert.rejects(provision(), /workspace initialization failed/);
  foreign = true;
  const before = executions.length;
  await assert.rejects(provision(), /workspace initialization failed/);
  assert.equal(executions.length, before);

  await t.test(
    "native initializer serializes retries and preserves later edits",
    {
      skip: process.env.OCC_TEST_RUNTIME_IMAGE
        ? false
        : "Set OCC_TEST_RUNTIME_IMAGE to the pinned native runtime.",
    },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "openshell-workspace-setup-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const workspace = join(root, "workspace");
      const home = join(root, "home");
      await mkdir(workspace);
      await mkdir(home);
      // Execute the exact command produced by provisionHarness with the real native CLI.
      // Only transport is substituted here; the separate live Sandbox proof covers the relay.
      const execute = (input) =>
        new Promise((resolve, reject) => {
          const child = spawn(
            "docker",
            [
              "run",
              "--rm",
              "--interactive",
              "--pull=never",
              "--network",
              "none",
              "--cap-drop",
              "ALL",
              "--security-opt",
              "no-new-privileges",
              "--user",
              `${process.getuid()}:${process.getgid()}`,
              "--volume",
              `${workspace}:/sandbox/enterprise`,
              "--volume",
              `${home}:/sandbox/.openclaw-runtime/home`,
              ...Object.entries(execution.environment).flatMap(([key, value]) => [
                "--env",
                `${key}=${value}`,
              ]),
              "--entrypoint",
              execution.command[0],
              process.env.OCC_TEST_RUNTIME_IMAGE,
              ...execution.command.slice(1),
            ],
            { stdio: ["pipe", "ignore", "pipe"] },
          );
          let error = "";
          child.stderr.on("data", (chunk) => {
            error += chunk;
          });
          child.on("error", reject);
          child.on("close", (code) =>
            code === 0 ? resolve() : reject(new Error(`Native setup exited ${code}: ${error}`)),
          );
          child.stdin.end(input);
        });
      await Promise.all([execute(execution.stdin), execute(execution.stdin)]);
      assert.equal(await readFile(join(workspace, "AGENTS.md"), "utf8"), setup.files["AGENTS.md"]);
      assert.equal(
        JSON.parse(await readFile(join(workspace, ".oce-workspace-setup.json"), "utf8")).id,
        setup.id,
      );
      await writeFile(join(workspace, "AGENTS.md"), "User edit after initialization\n");
      await execute(execution.stdin);
      assert.equal(
        await readFile(join(workspace, "AGENTS.md"), "utf8"),
        "User edit after initialization\n",
      );
      const { files: _files, ...completed } = setup;
      await execute(JSON.stringify({ ...completed, completed: true }));
    },
  );
});

test("OpenShell retains the revision provider when Sandbox creation has an unknown outcome", async () => {
  let sandboxCreates = 0;
  const gatewayClient = workspaceGatewayClient();
  gatewayClient.createSandbox = async (request) => {
    sandboxCreates++;
    if (sandboxCreates === 1) {
      throw new Error("CreateSandbox deadline exceeded");
    }
    return {
      name: request.name,
      workspace: request.workspace,
      labels: request.labels,
      annotations: request.annotations,
      spec: request.spec,
      serviceUrls: { "": "http://codex.example.test" },
    };
  };
  const driver = new OpenShellSandboxDriver(sandboxInstallation().drivers.sandbox.configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gatewayClient),
  });
  const { context, revision, requirements } = codexSandboxFixture(driver);

  await assert.rejects(
    driver.provisionHarness({ ...context, revision, requirements }),
    /deadline exceeded/,
  );
  const [runtimeProvider] = [...gatewayClient.providers.keys()];
  assert.match(runtimeProvider, /^oce-runtime-/);

  await driver.provisionHarness({ ...context, revision, requirements });

  assert.equal(sandboxCreates, 2);
  assert.equal(
    gatewayClient.calls.filter(([operation]) => operation === "createProvider").length,
    1,
  );
  assert.equal(
    gatewayClient.calls.filter(([operation]) => operation === "updateProviderCredentials").length,
    0,
  );
  assert.equal(gatewayClient.providers.has(runtimeProvider), true);
});

test("OpenShell reconciles renewed workspace-node setup into its revision provider", async () => {
  let storedSandbox;
  const gatewayClient = workspaceGatewayClient();
  gatewayClient.createSandbox = async (request) => {
    storedSandbox = {
      name: request.name,
      workspace: request.workspace,
      labels: structuredClone(request.labels),
      annotations: structuredClone(request.annotations),
      spec: structuredClone(request.spec),
      serviceUrls: {},
    };
    return { ...storedSandbox, serviceUrls: { "": "http://codex.example.test:8080/" } };
  };
  gatewayClient.getSandbox = async () => storedSandbox;
  gatewayClient.getService = async () => ({
    sandbox: storedSandbox.name,
    name: "",
    targetPort: 8080,
    authorizationMode: "SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH",
    advertisedUrl: "http://codex.example.test:8080/",
    url: "http://codex.example.test:8080/",
  });
  const driver = new OpenShellSandboxDriver(sandboxInstallation().drivers.sandbox.configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gatewayClient),
  });
  const { context, revision, requirements } = codexSandboxFixture(driver);
  const provision = () => driver.provisionHarness({ ...context, revision, requirements });

  await provision();
  const [runtimeProviderName] = [...gatewayClient.providers.keys()];
  const initialProvider = gatewayClient.providers.get(runtimeProviderName);
  const initialSetup = JSON.parse(initialProvider.config.node_setup_json);
  gatewayClient.providers.set(runtimeProviderName, {
    ...initialProvider,
    config: {
      ...initialProvider.config,
      node_setup_json: JSON.stringify({ ...initialSetup, expiresAtMs: Date.now() - 1 }),
    },
  });
  const renewedSetup = {
    ...initialSetup,
    bootstrapToken: "renewed-node-setup",
    expiresAtMs: Date.now() + 600_000,
  };
  const renewedCode = Buffer.from(JSON.stringify(renewedSetup)).toString("base64url");
  context.kubernetes.read = async ({ metadata }) => ({
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      ...metadata,
      labels: {
        "openclaw.dev/namespace": context.namespace.id,
        "openclaw.dev/agent": revision.agentId,
      },
    },
    data: { setupCode: Buffer.from(renewedCode).toString("base64") },
  });

  // A retry must update the revision-owned provider rather than strand the
  // revision after Compute replaces its expired setup Secret.
  await provision();
  const updates = gatewayClient.calls.filter(([operation]) => operation === "updateProviderConfig");
  assert.deepEqual(updates, [
    [
      "updateProviderConfig",
      runtimeProviderName,
      { node_setup_json: JSON.stringify(renewedSetup) },
      "1",
    ],
  ]);
  assert.equal(
    gatewayClient.providers.get(runtimeProviderName).config.node_setup_json,
    JSON.stringify(renewedSetup),
  );
  assert.equal(
    gatewayClient.calls.filter(([operation]) => operation === "createProvider").length,
    1,
  );

  // Renewal authority covers only the setup envelope. It must not repair or
  // conceal drift in the revision's immutable runtime files.
  const renewedProvider = gatewayClient.providers.get(runtimeProviderName);
  gatewayClient.providers.set(runtimeProviderName, {
    ...renewedProvider,
    config: { ...renewedProvider.config, runtime_json: '{"kind":"foreign"}' },
  });
  await assert.rejects(provision(), /without exact AgentRevision ownership and content/);
  assert.equal(
    gatewayClient.calls.filter(([operation]) => operation === "updateProviderConfig").length,
    1,
  );
});

test("OpenShell rejects unexpected annotations on an existing Sandbox", async () => {
  let storedSandbox;
  const gatewayClient = workspaceGatewayClient();
  gatewayClient.createSandbox = async (request) => {
    storedSandbox = {
      name: request.name,
      workspace: request.workspace,
      labels: structuredClone(request.labels),
      annotations: {
        ...structuredClone(request.annotations),
        "example.test/foreign-owner": "foreign",
      },
      spec: structuredClone(request.spec),
      serviceUrls: {},
    };
    return { ...storedSandbox, serviceUrls: { "": "http://codex.example.test" } };
  };
  gatewayClient.getSandbox = async () => storedSandbox;
  const driver = new OpenShellSandboxDriver(sandboxInstallation().drivers.sandbox.configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gatewayClient),
  });
  const { context, revision, requirements } = codexSandboxFixture(driver);

  await driver.provisionHarness({ ...context, revision, requirements });
  await assert.rejects(
    driver.provisionHarness({ ...context, revision, requirements }),
    /without exact AgentRevision ownership and content/,
  );
});

test("OpenShell rejects malformed or expired node setup before gateway mutation", async (t) => {
  for (const [name, setupCode, expected] of [
    ["malformed", "not-a-setup-code", /malformed setup envelope/],
    [
      "expired",
      Buffer.from(
        JSON.stringify({
          url: "wss://gateway.example.test/node",
          bootstrapToken: "expired-token",
          expiresAtMs: Date.now() - 1,
        }),
      ).toString("base64url"),
      /expired or has no bounded expiry/,
    ],
  ]) {
    await t.test(name, async () => {
      const gatewayClient = workspaceGatewayClient();
      const driver = new OpenShellSandboxDriver(
        sandboxInstallation().drivers.sandbox.configuration,
        {
          id: "openshell-sandbox",
          implementation: "openshell",
          backend: backendFor(gatewayClient),
        },
      );
      const { context, revision, requirements } = codexSandboxFixture(driver);
      const originalRead = context.kubernetes.read;
      context.kubernetes.read = async (request) => {
        const secret = await originalRead(request);
        return { ...secret, data: { setupCode: Buffer.from(setupCode).toString("base64") } };
      };

      await assert.rejects(
        driver.provisionHarness({ ...context, revision, requirements }),
        expected,
      );
      assert.deepEqual(gatewayClient.calls, []);
    });
  }
});

test("OpenShell rejects unsupported or foreign Codex runtime providers before Sandbox creation", async (t) => {
  const scenarios = [
    {
      name: "missing managed file",
      mutate({ requirements }) {
        requirements.files = requirements.files.slice(0, 1);
      },
      expected: /requires its exact bounded plugin-runtime files/,
    },
    {
      name: "oversized managed file",
      fixture: { codexConfig: "x".repeat(65_537) },
      expected: /requires its exact bounded plugin-runtime files/,
    },
    {
      name: "selected plugin",
      fixture: {
        runtimeManifest: JSON.stringify({
          kind: "codex",
          selections: { slack: { enabled: true } },
        }),
      },
      expected: /does not yet support selected plugins or repository credentials/,
    },
    {
      name: "foreign provider collision",
      foreignProvider: true,
      expected: /without exact AgentRevision ownership and content/,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      let sandboxCreates = 0;
      const gatewayClient = workspaceGatewayClient();
      gatewayClient.createSandbox = async () => {
        sandboxCreates++;
        throw new Error("an invalid runtime provider must not reach Sandbox creation");
      };
      if (scenario.foreignProvider) {
        gatewayClient.createProvider = async (request) => ({
          name: request.name,
          type: request.type,
          labels: { ...request.labels, "openclaw.dev/agent-id": "agt_foreign" },
          config: structuredClone(request.config),
        });
      }
      const driver = new OpenShellSandboxDriver(
        sandboxInstallation().drivers.sandbox.configuration,
        {
          id: "openshell-sandbox",
          implementation: "openshell",
          backend: backendFor(gatewayClient),
        },
      );
      const fixture = codexSandboxFixture(driver, scenario.fixture);
      scenario.mutate?.(fixture);

      await assert.rejects(
        driver.provisionHarness({
          ...fixture.context,
          revision: fixture.revision,
          requirements: fixture.requirements,
        }),
        (error) => {
          assert.match(String(error), scenario.expected);
          return true;
        },
      );
      assert.equal(sandboxCreates, 0);
    });
  }
});

test("OpenShell Namespace lifecycle creates, adopts, and deletes its exact operator Workspace", async () => {
  const gatewayClient = workspaceGatewayClient();
  const driver = new OpenShellSandboxDriver(sandboxInstallation().drivers.sandbox.configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gatewayClient),
  });
  const context = namespaceContext();

  // A retry must adopt the same owned Workspace instead of creating a second boundary.
  await driver.ensureNamespace(context);
  await driver.ensureNamespace(context);
  assert.deepEqual(gatewayClient.workspaces.get(context.namespace.name), {
    name: context.namespace.name,
    labels: {
      "app.kubernetes.io/managed-by": "openclaw-enterprise",
      "openclaw.dev/namespace-id": context.namespace.id,
    },
    phase: "WORKSPACE_PHASE_ACTIVE",
  });
  assert.equal(
    gatewayClient.calls.filter(([operation]) => operation === "createWorkspace").length,
    1,
  );

  // A lost delete response can leave an owned Workspace terminating; retry must converge.
  gatewayClient.workspaces.get(context.namespace.name).phase = "WORKSPACE_PHASE_TERMINATING";
  await driver.cleanup(context);
  assert.equal(gatewayClient.workspaces.has(context.namespace.name), false);
  assert.deepEqual(gatewayClient.calls.at(-1), ["deleteWorkspace", context.namespace.name]);
});

test("OpenShell operator mode owns workspace chart resources around the Workspace lifecycle", async () => {
  const events = [];
  const configuration = sandboxInstallation().drivers.sandbox.configuration;
  configuration.gateway.operatorWorkspaceResources = [
    {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: { name: "openshell-sandbox" },
    },
  ];
  const gatewayClient = workspaceGatewayClient([], events);
  const driver = new OpenShellSandboxDriver(configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gatewayClient),
  });
  const context = namespaceContext();
  context.kubernetes = kubernetesObjectClient(events);

  // The Gateway must not observe a Workspace until its operator-mode RBAC and
  // ServiceAccount resources have converged in the Compute-owned namespace.
  await driver.ensureNamespace(context);
  assert.deepEqual(events, [
    ["kubernetes", "patch", "ServiceAccount", "openshell-sandbox", context.namespace.name],
    ["gateway", "health"],
    ["gateway", "getWorkspace", context.namespace.name],
    ["gateway", "createWorkspace", context.namespace.name],
  ]);

  events.length = 0;
  await driver.cleanup(context);
  assert.deepEqual(events, [
    ["gateway", "getWorkspace", context.namespace.name],
    ["gateway", "deleteWorkspace", context.namespace.name],
    ["kubernetes", "delete", "ServiceAccount", "openshell-sandbox", context.namespace.name],
  ]);
});

test("OpenShell managed mode fails before mutating Kubernetes or the Gateway", async () => {
  const events = [];
  const configuration = sandboxInstallation().drivers.sandbox.configuration;
  configuration.gateway.workspaceMode = "managed";
  configuration.gateway.operatorWorkspaceResources = [
    {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: { name: "must-not-be-applied" },
    },
  ];
  const gatewayClient = workspaceGatewayClient();
  const driver = new OpenShellSandboxDriver(configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gatewayClient),
  });
  const context = namespaceContext();
  context.kubernetes = kubernetesObjectClient(events);

  await assert.rejects(
    driver.ensureNamespace(context),
    /managed workspace mode is not implemented; cannot ensure a Namespace/,
  );
  assert.deepEqual(events, []);
  assert.deepEqual(gatewayClient.calls, []);
});

test("OpenShell Namespace cleanup refuses a same-name foreign Workspace", async () => {
  const context = namespaceContext();
  const gatewayClient = workspaceGatewayClient([
    {
      name: context.namespace.name,
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace-id": "ns_foreign",
      },
      phase: "WORKSPACE_PHASE_ACTIVE",
    },
  ]);
  const driver = new OpenShellSandboxDriver(sandboxInstallation().drivers.sandbox.configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gatewayClient),
  });

  await assert.rejects(driver.cleanup(context), /without exact OCC Namespace ownership/);
  assert.equal(gatewayClient.workspaces.has(context.namespace.name), true);
  assert.equal(
    gatewayClient.calls.some(([operation]) => operation === "deleteWorkspace"),
    false,
  );
});

test("startup rejects invalid bundled OpenShell configuration before invoking an injected factory", async (t) => {
  const configuration = sandboxInstallation();
  configuration.drivers.sandbox.configuration.unsupported = true;
  let invokedFactory = false;
  const options = {
    createSandboxDriver() {
      invokedFactory = true;
      throw new Error("An injected factory must not bypass provider configuration validation.");
    },
  };

  await assert.rejects(
    loadInstallationFile(t, configuration, options),
    /drivers\.sandbox\.configuration does not match its Driver configuration schema/,
  );
  assert.equal(invokedFactory, false);
  // Control: the same factory is reached once the configuration is valid.
  await assert.rejects(loadInstallationFile(t, sandboxInstallation(), options), /injected factory/);
  assert.equal(invokedFactory, true);
});

test("startup rejects OpenShell network values outside the v0.1 protocol enums", async (t) => {
  const configuration = sandboxInstallation();
  configuration.drivers.sandbox.configuration.policy.networkPolicies[0].endpoints[0].tls =
    "inspect";

  await assert.rejects(
    loadInstallationFile(t, configuration),
    /OpenShell network policy model-egress TLS mode must be one of: skip, terminate/,
  );
});

test("startup refuses OpenShell filesystem modes that can weaken containment", async (t) => {
  for (const mode of ["best_effort", "hard-requirement"]) {
    const configuration = sandboxInstallation();
    configuration.drivers.sandbox.configuration.policy.landlockCompatibility = mode;

    await assert.rejects(
      loadInstallationFile(t, configuration),
      /OpenShell policy\.landlockCompatibility must be hard_requirement or omitted/,
    );
  }
});

test("startup rejects OpenShell network policies without binary identities", async (t) => {
  const configuration = sandboxInstallation();
  configuration.drivers.sandbox.configuration.policy.networkPolicies[0].binaries = [];

  await assert.rejects(
    loadInstallationFile(t, configuration),
    /OpenShell network policy model-egress requires at least one binary path/,
  );
});

test("startup rejects inherited OpenShell network enum property names", async (t) => {
  const cases = [
    ["tls", "toString", /TLS mode must be one of: skip, terminate/],
    ["enforcement", "constructor", /enforcement mode must be one of: enforce, audit/],
    ["access", "__proto__", /access preset must be one of: read_only, read_write, full/],
  ];

  for (const [field, value, expected] of cases) {
    const configuration = sandboxInstallation();
    configuration.drivers.sandbox.configuration.policy.networkPolicies[0].endpoints[0][field] =
      value;
    await assert.rejects(loadInstallationFile(t, configuration), expected);
  }
});

test("startup rejects the deprecated OpenShell passthrough spelling", async (t) => {
  const configuration = sandboxInstallation();
  configuration.drivers.sandbox.configuration.policy.networkPolicies[0].endpoints[0].tls =
    "passthrough";

  await assert.rejects(
    loadInstallationFile(t, configuration),
    /OpenShell network policy model-egress TLS mode must be one of: skip, terminate/,
  );
});

test("startup rejects the removed per-Sandbox OpenShell ServiceAccount mode", async (t) => {
  const configuration = sandboxInstallation();
  configuration.drivers.sandbox.configuration.kubernetes.serviceAccount.mode = "driverConfig";

  await assert.rejects(
    loadInstallationFile(t, configuration),
    /OpenShell serviceAccount mode must be gatewayConfigured/,
  );
});

test("startup rejects an invalid OpenShell gateway readiness wait", async (t) => {
  const configuration = sandboxInstallation();
  configuration.drivers.sandbox.configuration.gateway.readiness = {
    serviceName: "openshell-gateway",
    podSelector: { "app.kubernetes.io/name": "openshell" },
    timeoutMs: 0,
  };

  await assert.rejects(
    loadInstallationFile(t, configuration),
    /OpenShell gateway readiness timeout must be a positive safe integer/,
  );
});

/**
 * The OpenShell Credential Gateway over a recording provider store. Each provider's labels say
 * which credential source owns it; the gateway may act only on its own source's provider.
 * Kept beside the OpenShell Sandbox cases: both members come from one OpenShell Backend.
 */
function credentialGatewayOverProviders({ keepDeleted = false, toolBinaries } = {}) {
  const providers = new Map();
  const profiles = new Map();
  const deletedProfiles = [];
  const profileWrites = [];
  const calls = [];
  let resourceVersion = 0;
  const client = {
    async getProviderProfile(_workspace, id) {
      return profiles.get(id);
    },
    async importProviderProfile(_workspace, profile) {
      profileWrites.push(["import", profile.id]);
      profiles.set(profile.id, { ...profile, resourceVersion: String(++resourceVersion) });
    },
    // Like OpenShell, an update applies only over the version the writer last read.
    async updateProviderProfile(_workspace, profile, expectedResourceVersion) {
      profileWrites.push(["update", profile.id]);
      if (profiles.get(profile.id)?.resourceVersion !== expectedResourceVersion) {
        throw new Error("provider profile was modified concurrently");
      }
      profiles.set(profile.id, { ...profile, resourceVersion: String(++resourceVersion) });
    },
    async deleteProviderProfile(_workspace, id) {
      deletedProfiles.push(id);
      profiles.delete(id);
    },
    async createProvider(provider) {
      calls.push(["createProvider", provider.name]);
      if (providers.has(provider.name)) {
        throw new OpenShellProviderAlreadyExistsError(provider.name);
      }
      providers.set(provider.name, { ...provider });
    },
    async getProvider(_workspace, name) {
      return providers.get(name);
    },
    async listProviders() {
      return [...providers.values()];
    },
    async updateProviderCredentials(_workspace, name, credentials) {
      calls.push(["updateProviderCredentials", name]);
      providers.set(name, { ...providers.get(name), credentials });
    },
    async deleteProvider(_workspace, name) {
      calls.push(["deleteProvider", name]);
      if (!keepDeleted) {
        providers.delete(name);
      }
    },
  };
  // Another controller configuration over the same OpenShell store, as after a config change.
  const driverWith = ({ binaries = ["/usr/local/bin/codex"], toolBinaries } = {}) =>
    new OpenShellCredentialGatewayDriver(
      { binaries, ...(toolBinaries === undefined ? {} : { toolBinaries }) },
      {
        backend: {
          drivers: { credential_gateway: "credential-gateway-openshell" },
          client: { clientForNamespace: () => client },
        },
      },
    );
  const driver = driverWith({ toolBinaries });
  const namespace = { id: "ns_00000000-0000-4000-8000-0000000000aa", name: "placed-tenant" };
  const signal = new AbortController().signal;
  const source = (id, namespaceId = namespace.id) => ({
    id,
    namespaceId,
    name: "openai",
    type: "openai",
    config: {},
    secrets: {},
    driverId: driver.id,
    state: "ready",
  });
  return {
    calls,
    client,
    deletedProfiles,
    driver,
    driverWith,
    profileWrites,
    profiles,
    providers,
    source,
    context: (id) => ({ namespace, source: source(id), signal }),
    revisionContext: (sources) => ({
      namespace,
      revision: { harness: { id: "codex", mode: "dedicated" } },
      sources,
      signal,
    }),
    input: (apiKey = "synthetic-openai-key") => ({
      type: "openai",
      config: {},
      secrets: { api_key: apiKey },
    }),
  };
}

test("the OpenShell Credential Gateway acts only on its own source's provider", async () => {
  const { calls, context, driver, input, providers, revisionContext, source } =
    credentialGatewayOverProviders();
  const owner = "cs_00000000-0000-4000-8000-0000000000b1";
  const other = "cs_00000000-0000-4000-8000-0000000000b2";
  assert.deepEqual(await driver.registerSource(context(owner), input()), { state: "ready" });
  const [stored] = providers.values();
  assert.equal(stored.labels["openclaw.dev/credential-source-id"], owner);
  // Another source's provider stored under this source's name: same manager and type, other id.
  providers.set(stored.name, {
    ...stored,
    labels: { ...stored.labels, "openclaw.dev/credential-source-id": other },
  });
  calls.length = 0;
  await assert.rejects(driver.registerSource(context(owner), input()), ScopeViolationError);
  await assert.rejects(
    driver.updateSource(context(owner), input("replacement")),
    ScopeViolationError,
  );
  assert.equal((await driver.sourceStatus(context(owner))).state, "failed");
  await assert.rejects(driver.removeSource(context(owner)), ScopeViolationError);
  await assert.rejects(
    driver.attachForRevision(revisionContext([source(owner)])),
    /provider for a bound credential source is unavailable/,
  );
  // Only the replayed create reached the store, and it was refused; nothing was overwritten.
  assert.deepEqual(
    calls.map(([operation]) => operation),
    ["createProvider"],
  );
  assert.deepEqual(providers.get(stored.name).credentials, stored.credentials);
});

test("the OpenShell Credential Gateway never attaches a source of another Namespace", async () => {
  const { context, driver, input, revisionContext, source } = credentialGatewayOverProviders();
  const owner = "cs_00000000-0000-4000-8000-0000000000c1";
  await driver.registerSource(context(owner), input());
  // The provider is genuinely owned, so only the Namespace check can refuse.
  const foreign = source(owner, "ns_00000000-0000-4000-8000-0000000000ff");
  await assert.rejects(
    driver.attachForRevision(revisionContext([foreign])),
    (error) =>
      error instanceof ScopeViolationError &&
      error.message === "The credential source is not owned by this gateway.",
  );
  assert.equal((await driver.attachForRevision(revisionContext([source(owner)]))).length, 1);
});

test("the OpenShell Credential Gateway refuses an empty secret before creating a provider", async () => {
  const { calls, context, driver, input, providers } = credentialGatewayOverProviders();
  await assert.rejects(
    driver.registerSource(context("cs_00000000-0000-4000-8000-0000000000d1"), input("")),
    ScopeViolationError,
  );
  assert.deepEqual(calls, []);
  assert.equal(providers.size, 0);
});

test("OpenShell credential source removal fails while the provider survives deletion", async () => {
  const { context, driver, input, providers } = credentialGatewayOverProviders({
    keepDeleted: true,
  });
  const owner = "cs_00000000-0000-4000-8000-0000000000e1";
  await driver.registerSource(context(owner), input());
  await assert.rejects(driver.removeSource(context(owner)), /was not deleted/);
  assert.equal(providers.size, 1);
});

test("the OpenShell bearer-token type exists only with toolBinaries and validates its endpoint", async () => {
  const modelOnly = credentialGatewayOverProviders();
  assert.deepEqual(
    (await modelOnly.driver.listSourceTypes({})).map(({ type }) => type),
    ["openai"],
  );
  const tokenInput = (config) => ({ type: "bearer-token", config, secrets: { token: "t0ken" } });
  const endpoint = { host: "api.example.com", env_var: "EXAMPLE_TOKEN" };
  await assert.rejects(
    modelOnly.driver.registerSource(
      modelOnly.context("cs_00000000-0000-4000-8000-0000000000f0"),
      tokenInput(endpoint),
    ),
    /does not support this type/,
  );
  assert.throws(
    () =>
      new OpenShellCredentialGatewayDriver(
        { binaries: ["/usr/local/bin/codex"], toolBinaries: ["bin/curl"] },
        {
          backend: {
            drivers: { credential_gateway: "credential-gateway-openshell" },
            client: { clientForNamespace: () => ({}) },
          },
        },
      ),
    /toolBinaries must be a nonempty list of absolute paths/,
  );

  const { calls, context, deletedProfiles, driver, profiles, providers } =
    credentialGatewayOverProviders({ toolBinaries: ["/usr/bin/curl"] });
  assert.deepEqual(
    (await driver.listSourceTypes({})).map(({ type }) => type),
    ["openai", "bearer-token"],
  );
  // Every invalid endpoint or placeholder variable is refused before any gateway effect.
  for (const config of [
    { ...endpoint, host: "10.0.0.1" },
    { ...endpoint, host: "API.example.com" },
    { ...endpoint, host: "https://api.example.com" },
    { ...endpoint, port: "0" },
    { ...endpoint, port: "443x" },
    { ...endpoint, port: "65536" },
    { ...endpoint, path: "v1/**" },
    { ...endpoint, path: "/v1?all" },
    { ...endpoint, env_var: "example_token" },
    { ...endpoint, env_var: "OPENAI_API_KEY" },
    { ...endpoint, env_var: "PATH" },
    { ...endpoint, env_var: "OPENCLAW_TOKEN" },
    { ...endpoint, env_var: "CODEX_TOKEN" },
    { host: "api.example.com" },
  ]) {
    await assert.rejects(
      driver.registerSource(context("cs_00000000-0000-4000-8000-0000000000f1"), tokenInput(config)),
      ScopeViolationError,
      JSON.stringify(config),
    );
  }
  assert.deepEqual(calls, []);
  assert.equal(profiles.size, 0);

  // Each bearer-token source owns a profile that only the tool binaries may use, at its endpoint.
  const first = "cs_00000000-0000-4000-8000-0000000000f2";
  const second = "cs_00000000-0000-4000-8000-0000000000f3";
  assert.deepEqual(await driver.registerSource(context(first), tokenInput(endpoint)), {
    state: "ready",
  });
  const provider = [...providers.values()].find(
    ({ labels }) => labels["openclaw.dev/credential-source-id"] === first,
  );
  const profile = profiles.get(provider.type);
  assert.ok(profile, "the provider's type names its own profile");
  assert.equal(profile.id, provider.name);
  assert.deepEqual(profile.binaries, ["/usr/bin/curl"]);
  assert.equal(profile.inferenceCapable, false);
  assert.deepEqual(profile.endpoints, [
    { host: "api.example.com", port: 443, path: "/**", protocol: "rest" },
  ]);
  assert.deepEqual(
    profile.credentials.map(({ name, envVars, authStyle, headerName }) => ({
      name,
      envVars,
      authStyle,
      headerName,
    })),
    [
      {
        name: "token",
        envVars: ["EXAMPLE_TOKEN"],
        authStyle: "bearer",
        headerName: "authorization",
      },
    ],
  );
  // The model profile stays limited to the Harness binaries.
  await driver.registerSource(context("cs_00000000-0000-4000-8000-0000000000f4"), {
    type: "openai",
    config: {},
    secrets: { api_key: "synthetic-openai-key" },
  });
  assert.deepEqual(profiles.get("oce-openai").binaries, ["/usr/local/bin/codex"]);

  // Two sources on one revision cannot share a placeholder variable.
  await driver.registerSource(context(second), tokenInput(endpoint));
  const bearer = (id) => ({
    ...context(id).source,
    type: "bearer-token",
    config: endpoint,
  });
  const { namespace, signal } = context(first);
  const revision = { harness: { id: "codex", mode: "dedicated" } };
  await assert.rejects(
    driver.attachForRevision({
      namespace,
      revision,
      sources: [bearer(first), bearer(second)],
      signal,
    }),
    (error) => {
      // A permanent refusal: the worker fails the deployment instead of retrying it.
      assert.ok(error instanceof CredentialSourceRevisionError, String(error));
      assert.equal(error.code, "CREDENTIAL_SOURCE_ENVIRONMENT_CONFLICT");
      assert.match(error.message, /use the same environment variable/);
      return true;
    },
  );
  assert.equal(
    (await driver.attachForRevision({ namespace, revision, sources: [bearer(first)], signal }))
      .length,
    1,
  );
  // A provider of another type under this source's name and labels is not this source's.
  providers.set(provider.name, { ...provider, type: "oce-openai" });
  assert.equal(
    (await driver.sourceStatus({ namespace, source: bearer(first), signal })).state,
    "failed",
  );
  providers.set(provider.name, provider);

  // Removing a source removes its own profile, while another source of the type remains.
  await driver.removeSource({ namespace, source: bearer(first), signal });
  assert.deepEqual(deletedProfiles, [provider.name]);
  assert.equal(profiles.has(provider.name), false);
  assert.equal(profiles.size, 2);
  // The shared model profile stays while another model source still uses it.
  await driver.registerSource(context("cs_00000000-0000-4000-8000-0000000000f5"), {
    type: "openai",
    config: {},
    secrets: { api_key: "synthetic-openai-key" },
  });
  await driver.removeSource(context("cs_00000000-0000-4000-8000-0000000000f4"));
  assert.deepEqual(deletedProfiles, [provider.name]);
  assert.equal(profiles.has("oce-openai"), true);
});

/** A bearer-token source of the recording store, registered under `driver`. */
function bearerTokenSources(gateway) {
  const { context } = gateway;
  const endpoint = { host: "api.example.com", env_var: "EXAMPLE_TOKEN" };
  const bearer = (id, env_var = endpoint.env_var) => ({
    ...context(id).source,
    type: "bearer-token",
    config: { ...endpoint, env_var },
  });
  const { namespace, signal } = context("cs_00000000-0000-4000-8000-000000000000");
  const sourceContext = (source) => ({ namespace, source, signal });
  const input = (source, token = "t0ken") => ({
    type: source.type,
    config: source.config,
    secrets: { token },
  });
  const revisionContext = (sources) => ({
    namespace,
    revision: { harness: { id: "codex", mode: "dedicated" } },
    sources,
    signal,
  });
  const providerOf = (source) =>
    [...gateway.providers.values()].find(
      ({ labels }) => labels["openclaw.dev/credential-source-id"] === source.id,
    );
  const register = async (driver, source) =>
    assert.deepEqual(await driver.registerSource(sourceContext(source), input(source)), {
      state: "ready",
    });
  return { bearer, input, providerOf, register, revisionContext, sourceContext };
}

test("narrowing OpenShell toolBinaries narrows existing bearer-token sources on update and deployment", async () => {
  const gateway = credentialGatewayOverProviders({
    toolBinaries: ["/usr/bin/curl", "/usr/bin/python3"],
  });
  const { driver, driverWith, profileWrites, profiles } = gateway;
  const { bearer, input, providerOf, register, revisionContext, sourceContext } =
    bearerTokenSources(gateway);
  const updated = bearer("cs_00000000-0000-4000-8000-000000000101", "UPDATED_TOKEN");
  const deployed = bearer("cs_00000000-0000-4000-8000-000000000102", "DEPLOYED_TOKEN");
  await register(driver, updated);
  await register(driver, deployed);
  const profileOf = (source) => profiles.get(providerOf(source).type);
  assert.deepEqual(profileOf(updated).binaries, ["/usr/bin/curl", "/usr/bin/python3"]);
  assert.deepEqual(profileOf(deployed).binaries, ["/usr/bin/curl", "/usr/bin/python3"]);

  // The operator drops python3. Status reads never write the profile.
  const narrowed = driverWith({ toolBinaries: ["/usr/bin/curl"] });
  profileWrites.length = 0;
  assert.equal((await narrowed.sourceStatus(sourceContext(updated))).state, "ready");
  assert.deepEqual(profileWrites, []);

  // Updating a source's token rewrites its profile to the current list.
  assert.deepEqual(await narrowed.updateSource(sourceContext(updated), input(updated, "n3w")), {
    state: "ready",
  });
  assert.deepEqual(profileOf(updated).binaries, ["/usr/bin/curl"]);
  assert.deepEqual(profileOf(deployed).binaries, ["/usr/bin/curl", "/usr/bin/python3"]);

  // Deploying a revision rewrites each attached source's profile.
  assert.equal((await narrowed.attachForRevision(revisionContext([deployed]))).length, 1);
  assert.deepEqual(profileOf(deployed).binaries, ["/usr/bin/curl"]);
  assert.deepEqual(
    profileWrites.map(([operation]) => operation),
    ["update", "update"],
  );

  // An unchanged configuration writes nothing.
  profileWrites.length = 0;
  await narrowed.updateSource(sourceContext(updated), input(updated));
  await narrowed.attachForRevision(revisionContext([updated, deployed]));
  assert.deepEqual(profileWrites, []);

  // The shared model profile follows the Harness binaries the same way.
  const model = "cs_00000000-0000-4000-8000-000000000103";
  await narrowed.registerSource(gateway.context(model), gateway.input());
  const retargeted = driverWith({
    binaries: ["/opt/codex/bin/codex"],
    toolBinaries: ["/usr/bin/curl"],
  });
  await retargeted.attachForRevision(revisionContext([gateway.source(model)]));
  assert.deepEqual(profiles.get("oce-openai").binaries, ["/opt/codex/bin/codex"]);
});

test("an OpenShell profile write that lost a race to the same profile still attaches", async () => {
  const gateway = credentialGatewayOverProviders({ toolBinaries: ["/usr/bin/curl"] });
  const { client, driverWith, profiles } = gateway;
  const { bearer, providerOf, register, revisionContext } = bearerTokenSources(gateway);
  const source = bearer("cs_00000000-0000-4000-8000-000000000111");
  await register(gateway.driver, source);
  const profileId = providerOf(source).type;
  const read = client.getProviderProfile;
  const narrowed = driverWith({ toolBinaries: ["/usr/bin/wget"] });
  const other = driverWith({ toolBinaries: ["/usr/bin/curl", "/usr/bin/wget"] });

  // Another deployment with the same configuration writes between this read and write: the
  // stale version is refused, and the stored profile is already the one this writer wanted.
  client.getProviderProfile = async (workspace, id) => {
    const stale = await read(workspace, id);
    client.getProviderProfile = read;
    await narrowed.attachForRevision(revisionContext([source]));
    return stale;
  };
  assert.equal((await narrowed.attachForRevision(revisionContext([source]))).length, 1);
  assert.deepEqual(profiles.get(profileId).binaries, ["/usr/bin/wget"]);

  // A concurrent writer that stored another profile is not mistaken for success.
  const curlOnly = driverWith({ toolBinaries: ["/usr/bin/curl"] });
  client.getProviderProfile = async (workspace, id) => {
    const stale = await read(workspace, id);
    client.getProviderProfile = read;
    await curlOnly.attachForRevision(revisionContext([source]));
    return stale;
  };
  await assert.rejects(other.attachForRevision(revisionContext([source])), /modified concurrently/);
  assert.deepEqual(profiles.get(profileId).binaries, ["/usr/bin/curl"]);
});

test("an OpenShell bearer-token source stays deletable after toolBinaries is removed", async () => {
  const gateway = credentialGatewayOverProviders({ toolBinaries: ["/usr/bin/curl"] });
  const { deletedProfiles, driverWith, profiles } = gateway;
  const { bearer, input, providerOf, register, revisionContext, sourceContext } =
    bearerTokenSources(gateway);
  const source = bearer("cs_00000000-0000-4000-8000-000000000121");
  await register(gateway.driver, source);
  const profileId = providerOf(source).type;

  const modelOnly = driverWith();
  // The type is gone for new registrations, updates and deployments.
  await assert.rejects(
    modelOnly.registerSource(
      sourceContext(bearer("cs_00000000-0000-4000-8000-000000000122")),
      input(source),
    ),
    /does not support this type/,
  );
  await assert.rejects(
    modelOnly.updateSource(sourceContext(source), input(source)),
    /does not support this type/,
  );
  await assert.rejects(
    modelOnly.attachForRevision(revisionContext([source])),
    /does not support this type/,
  );
  // The existing source still reports its state and can be removed with its own profile.
  assert.equal((await modelOnly.sourceStatus(sourceContext(source))).state, "ready");
  await modelOnly.removeSource(sourceContext(source));
  assert.equal(providerOf(source), undefined);
  assert.deepEqual(deletedProfiles, [profileId]);
  assert.equal(profiles.has(profileId), false);
  // Removal is idempotent once the provider is gone.
  await modelOnly.removeSource(sourceContext(source));
});

test("OpenShell observes the Codex Harness through its exact bearer-passthrough service", async () => {
  const service = {
    sandbox: "",
    name: "",
    targetPort: 8080,
    authorizationMode: "SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH",
    advertisedUrl: "http://codex.example.test:8080/",
    url: "http://codex.example.test:9443/",
  };
  const gatewayClient = workspaceGatewayClient();
  const observed = [];
  let document = { status: 502 };
  let handshake = false;
  gatewayClient.getService = async (_workspace, sandbox, name) => {
    observed.push(["getService", sandbox, name]);
    return service === undefined ? undefined : { ...service, sandbox };
  };
  gatewayClient.getServiceDocument = async (url, path, bearer) => {
    observed.push(["getServiceDocument", url, path, bearer]);
    return document;
  };
  gatewayClient.serviceWebSocketHandshake = async (url, bearer) => {
    observed.push(["serviceWebSocketHandshake", url, bearer]);
    return handshake;
  };
  const driver = new OpenShellSandboxDriver(sandboxInstallation().drivers.sandbox.configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gatewayClient),
  });
  const { context, revision, requirements } = codexSandboxFixture(driver);
  const statusContext = { ...context, revision, requirements, transportToken: "transport-token" };

  // Nothing listens yet: a refused handshake and OpenShell's own 502 mean starting.
  assert.deepEqual(await driver.harnessStatus(statusContext), { state: "starting" });
  const sandboxName = observed[0][1];
  assert.deepEqual(observed, [
    ["getService", sandboxName, ""],
    ["serviceWebSocketHandshake", "http://codex.example.test:9443/", "transport-token"],
    [
      "getServiceDocument",
      "http://codex.example.test:9443/",
      "/openclaw/runtime/status",
      "transport-token",
    ],
  ]);

  // A serving app-server is never sent a plain request.
  handshake = true;
  observed.length = 0;
  assert.deepEqual(await driver.harnessStatus(statusContext), { state: "serving" });
  assert.deepEqual(
    observed.map(([operation]) => operation),
    ["getService", "serviceWebSocketHandshake"],
  );
  handshake = false;

  // A held failure refuses the upgrade; it is returned unvalidated for Compute.
  const runtimeFailure = {
    component: "agent",
    check: "model-probe",
    checkedAt: "2026-10-08T13:00:00.000Z",
    code: "MODEL_PROBE_FAILED",
  };
  document = { status: 200, json: { runtimeFailure } };
  observed.length = 0;
  assert.deepEqual(await driver.harnessStatus(statusContext), {
    state: "failed",
    runtimeFailure,
  });
  assert.equal(observed.length, 3);
  // Only a 200 status document with a runtime failure counts; anything else is starting.
  for (const other of [
    { status: 404, json: { runtimeFailure } },
    { status: 200, json: { error: "x" } },
    { status: 200, json: ["runtimeFailure"] },
    { status: 200 },
  ]) {
    document = other;
    assert.deepEqual(await driver.harnessStatus(statusContext), { state: "starting" });
  }

  // The same exactness as harnessEndpoint: wrong port, mode, or a missing service fail closed.
  for (const changed of [
    { targetPort: 8081 },
    { authorizationMode: "SERVICE_AUTHORIZATION_MODE_STRIP" },
  ]) {
    Object.assign(service, changed);
    await assert.rejects(driver.harnessStatus(statusContext), /exact Codex bearer-passthrough/);
    Object.assign(service, { targetPort: 8080, authorizationMode: 2 });
  }
  await assert.rejects(
    driver.harnessStatus({
      ...statusContext,
      revision: { ...revision, harness: { id: "openclaw", version: "1.0.0", mode: "dedicated" } },
    }),
    /only for dedicated Codex revisions/,
  );
  // Another Sandbox Driver's revision, or a deferred managed Workspace, is refused before the
  // Harness is observed.
  observed.length = 0;
  await assert.rejects(
    driver.harnessStatus({ ...statusContext, revision: { ...revision, sandboxDriverId: "other" } }),
    /another Sandbox Driver/,
  );
  const managedConfiguration = sandboxInstallation().drivers.sandbox.configuration;
  managedConfiguration.gateway.workspaceMode = "managed";
  const managed = new OpenShellSandboxDriver(managedConfiguration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gatewayClient),
  });
  await assert.rejects(
    managed.harnessStatus(statusContext),
    /managed workspace mode is not implemented; cannot observe a Harness/,
  );
  assert.deepEqual(observed, []);
});
