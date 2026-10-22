import { ConfigurationValidationError as SharedConfigurationValidationError } from "../../packages/contracts/src/index.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import {
  createOpenShellBackend,
  OpenShellGateway,
  openShellProviderName,
  openShellWorkspaceName,
} from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import {
  createKubernetesComputeDriver,
  KubernetesComputeDriver,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { OpenShellCredentialRefreshDriver } from "../../apps/controller/src/drivers/credential-refresh/openshell.ts";
import {
  AGENT_RUNTIME_ENTRYPOINT,
  NATIVE_WORKER_ENTRYPOINT,
  RUNTIME_WRAPPER_COMMAND,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import {
  normalizeServiceUrl,
  OpenShellProviderAlreadyExistsError,
  OpenShellRequestReplayRefusedError,
  OpenShellSandboxAlreadyExistsError,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import {
  OpenShellServiceTransportError,
  serviceTarget,
} from "../../apps/controller/src/drivers/sandbox/openshell-service-transport.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import {
  CredentialSourceConfigError,
  CredentialSourceRevisionError,
  DependencyUnavailableError,
  SandboxGatewayUnauthorizedError,
  SandboxRevisionUnsupportedError,
  SandboxWorkspaceSetupRefusedError,
  ScopeViolationError,
  TransientDependencyError,
} from "../../packages/occ/src/index.ts";
import { createInstallationDriverConfiguration as installation } from "../helpers/installation-driver-configuration.mjs";
import { loadInstallationFile } from "../helpers/installation-file.mjs";
import {
  WORKSPACE_DEFAULTS,
  WORKSPACE_DEFAULTS_ID,
} from "../../packages/contracts/src/workspace-defaults.mjs";
import { conformanceKubernetesOptions } from "../helpers/kubernetes-compute.mjs";
import { availablePort } from "../helpers/available-port.mjs";

const controllerRequire = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);
const { KubernetesObjectApi } = controllerRequire("@kubernetes/client-node");
const { ObjectSerializer } = controllerRequire("@kubernetes/client-node/dist/serializer.js");

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
        userNamespaces: false,
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
  const storeProfile = (profile, resourceVersion) =>
    profiles.set(profile.id, {
      id: profile.id,
      resourceVersion,
      annotations: structuredClone(profile.annotations),
      profile: structuredClone(profile),
    });
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
      storeProfile(profile, "1");
    },
    async updateProviderProfile(_workspace, profile) {
      storeProfile(profile, "2");
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

function openShellDriver(gatewayClient, configuration) {
  return new OpenShellSandboxDriver(
    configuration ?? sandboxInstallation().drivers.sandbox.configuration,
    { id: "openshell-sandbox", implementation: "openshell", backend: backendFor(gatewayClient) },
  );
}

/** A dedicated Codex revision on `driver`; `n` is the 12-digit tail of its ids. */
function dedicatedRevision(driver, context, n) {
  return {
    id: `rev_00000000-0000-4000-8000-${n}`,
    namespaceId: context.namespace.id,
    agentId: `agt_00000000-0000-4000-8000-${n}`,
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    sandboxDriverId: driver.id,
  };
}

/** A Workspace labelled as the one OCC owns for `namespaceId`. */
function ownedWorkspace(name, namespaceId) {
  const labels = {
    "app.kubernetes.io/managed-by": "openclaw-enterprise",
    "openclaw.dev/namespace-id": namespaceId,
  };
  return { name, labels, phase: "WORKSPACE_PHASE_ACTIVE" };
}

/** The gateway's record of a created Sandbox, serving its Harness at a per-Sandbox URL. */
function storedSandbox(request, fields = {}) {
  const url = `http://${request.workspace}--${request.name}.openshell.test/`;
  return {
    name: request.name,
    workspace: request.workspace,
    labels: request.labels,
    annotations: request.annotations,
    spec: request.spec,
    serviceUrls: { "": url },
    ...fields,
  };
}

/** A live Sandbox record by name, as GetSandbox reports one without its Harness service. */
function sandboxRecord(name, workspace) {
  return storedSandbox(
    { name, workspace, labels: {}, annotations: {}, spec: {} },
    { serviceUrls: {} },
  );
}

/** The Codex Harness's bearer-passthrough service at `url`, or none. */
function harnessService(sandbox, name, url) {
  return url === undefined
    ? undefined
    : { sandbox, name, targetPort: 8080, authorizationMode: 2, advertisedUrl: url, url };
}

function callCount(gatewayClient, operation) {
  return gatewayClient.calls.filter(([called]) => called === operation).length;
}

function codexPlugin(appServer) {
  return {
    plugins: { allow: ["codex"], entries: { codex: { enabled: true, config: { appServer } } } },
  };
}

const structuralRefusal = (path, keyword, code = "INVALID_VALUE") => [
  { path, code, message: `Configuration does not satisfy ${keyword}.` },
];

/** Startup refuses the installation `change` makes to a fresh `base()` with `expected`. */
async function rejectsAtStartup(t, change, expected, base = sandboxInstallation) {
  const configuration = base();
  change(configuration);
  if (expected instanceof RegExp) {
    await assert.rejects(loadInstallationFile(t, configuration), expected);
    return;
  }
  await assert.rejects(loadInstallationFile(t, configuration), (error) => {
    assert.ok(error instanceof SharedConfigurationValidationError);
    assert.deepEqual(error.error.details, expected);
    return true;
  });
}

/** An installation whose OpenShell Backend dials `endpoint` over a declared NetworkPolicy. */
function endpointInstallation(endpoint) {
  const configuration = sandboxInstallation();
  configuration.backend[0].configuration = { endpoint, insecureTransport: "network-policy" };
  return configuration;
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

// Controlled Kubernetes transport: verifies the production preparation manifest and
// ordering only. The real k3d case must prove filesystem effects and Pod termination.
function nativePreparationClient(context) {
  const client = Object.create(KubernetesObjectApi.prototype);
  const prepared = [];
  let deployment;
  const read = context.kubernetes.read?.bind(context.kubernetes);
  client.read = async (resource) => {
    if (resource.kind === "Namespace") {
      return { ...resource };
    }
    if (resource.kind === "Deployment") {
      if (deployment === undefined) {
        throw { code: 404 };
      }
      // Use the same decoder as KubernetesObjectApi.read, including nested SDK models.
      return ObjectSerializer.deserialize(JSON.parse(JSON.stringify(deployment)), "V1Deployment");
    }
    return read(resource);
  };
  client.create = async (resource) => {
    prepared.push(structuredClone(resource));
    deployment = {
      ...resource,
      metadata: { ...resource.metadata, uid: "preparation-uid", generation: 1 },
      status: { availableReplicas: 1, observedGeneration: 1 },
    };
    return ObjectSerializer.deserialize(JSON.parse(JSON.stringify(deployment)), "V1Deployment");
  };
  client.delete = async (resource, _pretty, _dryRun, _grace, _orphan, propagation, body) => {
    assert.equal(resource.kind, "Deployment");
    assert.equal(propagation, "Foreground");
    assert.equal(body.preconditions.uid, "preparation-uid");
    deployment = undefined;
  };
  client.list = async () => ({ items: [] });
  context.kubernetes = client;
  return prepared;
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

function runtimeSandboxFixture(
  driver,
  {
    harnessId = "codex",
    runtimeManifest = JSON.stringify({ kind: "codex", selections: {} }),
    codexConfig = "[features]\nplugins = false\n",
    files,
    nodeSetupUrl = () => "wss://gateway.example.test/node",
  } = {},
) {
  const context = namespaceContext();
  const revision = {
    id: "rev_00000000-0000-4000-8000-000000000003",
    namespaceId: context.namespace.id,
    agentId: "agt_00000000-0000-4000-8000-000000000003",
    harness: { id: harnessId, version: "1.0.0", mode: "dedicated" },
    sandboxDriverId: driver.id,
  };
  const nodeSetup = {
    url: nodeSetupUrl(revision, context),
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
    image: "openclaw-runtime@sha256:synthetic",
    command: harnessRuntimeCommand('console.error("harness runtime");'),
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
      ...(harnessId === "codex"
        ? [
            {
              claimName: "harness-workspace-codex",
              subPath: "codex-sessions",
              mountPath: "/home/node/.codex/sessions",
              readOnly: false,
            },
          ]
        : []),
    ],
    credentialAttachments: [{ sourceId: "cs_test", ref: `oce-cs-${"b".repeat(24)}` }],
    environment: [
      { name: "HOME", value: "/home/node" },
      ...(harnessId === "codex" ? [{ name: "CODEX_HOME", value: "/home/node/.codex" }] : []),
      { name: "NODE_PATH", value: "/home/node_modules" },
      { name: "OPENCLAW_NODE_STATE_DIR", value: "/home/node/.openclaw-node" },
      { name: "OPENCLAW_WORKSPACE_DIR", value: "/home/node/workspace" },
      {
        name: "OPENCLAW_NODE_CA_PEM",
        value: "-----BEGIN CERTIFICATE-----\npublic-ca\n-----END CERTIFICATE-----\n",
      },
      ...(harnessId === "codex"
        ? [
            { name: "APP_SERVER_PORT", value: "8080" },
            { name: "APP_TOKEN_SHA", value: "a".repeat(64) },
          ]
        : []),
      {
        name: "OPENCLAW_NODE_SETUP_CODE",
        valueFrom: { secretKeyRef: { name: "workspace-node", key: "setupCode" } },
      },
    ],
    files:
      files ??
      (harnessId === "codex"
        ? [
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
          ]
        : []),
    labels: { "openclaw.dev/revision": revision.id },
  };
  const prepared = harnessId === "openclaw" ? nativePreparationClient(context) : [];
  return { context, revision, requirements, runtimeManifest, codexConfig, nodeSetup, prepared };
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
    createControllerWorker({ pool, mode: "production", drivers: createdDriver, emit: () => {} }),
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
  // The issuer replaces a refresh token on use, so an update must not re-send the recorded one.
  assert.deepEqual(
    offered.flatMap(({ type, secrets }) =>
      secrets
        .filter(({ issuerRotated }) => issuerRotated === true)
        .map(({ name }) => `${type}.${name}`),
    ),
    ["oauth2-refresh-token.refresh_token"],
  );
  const withoutRefresh = sandboxInstallation();
  withoutRefresh.drivers.credential_gateway.configuration.toolBinaries = ["/usr/bin/curl"];
  const staticOnly = await loadInstallationFile(t, withoutRefresh);
  assert.deepEqual(
    (await staticOnly.credentialGatewayDriver.listSourceTypes({ signal })).map(({ type }) => type),
    ["openai", "codex-pat", "bearer-token"],
  );

  // Refresh state lives on the gateway's provider records, so the roles cannot be split.
  const unpaired =
    /drivers\.credential_refresh must match the selected drivers\.credential_refresh\.id/;
  for (const [change, expected] of [
    [(c) => delete c.drivers.credential_refresh, unpaired],
    [(c) => delete c.backend[0].drivers.credential_refresh, unpaired],
    [
      (c) => delete c.drivers.credential_gateway,
      /drivers\.credential_refresh requires drivers\.credential_gateway/,
    ],
    [
      (c) => (c.drivers.credential_refresh.configuration = { interval: 60 }),
      structuralRefusal("", "additionalProperties", "UNKNOWN_FIELD"),
    ],
  ]) {
    await rejectsAtStartup(t, change, expected, refreshing);
  }
});

test("startup identifies the rejected Credential Gateway executable", (t) =>
  rejectsAtStartup(
    t,
    (c) => {
      c.drivers.credential_gateway.configuration.toolBinaries = ["bin/curl"];
    },
    structuralRefusal("/toolBinaries/0", "pattern", "INVALID_FORMAT"),
  ));

test("startup rejects an OpenShell Backend whose members are not both selected", async (t) => {
  await rejectsAtStartup(
    t,
    (c) => delete c.drivers.credential_gateway,
    /drivers\.credential_gateway must match the selected drivers\.credential_gateway\.id/,
  );
  await rejectsAtStartup(
    t,
    (c) => (c.backend[0].drivers.sandbox = "another-sandbox"),
    /drivers\.sandbox must match the selected bundled OpenShell drivers\.sandbox\.id/,
  );
  // Connection settings belong to the Backend; the Sandbox rejects them instead of ignoring them.
  await rejectsAtStartup(
    t,
    (c) => (c.drivers.sandbox.configuration.gateway.endpoint = "http://127.0.0.1:1"),
    structuralRefusal("/gateway", "additionalProperties", "UNKNOWN_FIELD"),
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
  // URI schemes are case-insensitive; both gateway transports parse the protocol before
  // choosing TLS. Startup must admit the same protected connection, including operator TLS.
  for (const scheme of ["https", "HTTPS", "hTtPs"]) {
    protectedTransport.backend[0].configuration.endpoint = `${scheme}://openshell-gateway.openshell.svc:8080`;
    delete protectedTransport.backend[0].configuration.operatorTls;
    await load(protectedTransport);
    protectedTransport.backend[0].configuration.operatorTls = operatorTls;
    await load(protectedTransport);
  }
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
  const driver = openShellDriver(workspaceGatewayClient());
  const configuration = { agents: { defaults: { model: "openai/gpt-5" } } };
  const harness = (id, mode = "dedicated") => ({ id, version: "1.0.0", mode });
  assert.deepEqual(driver.configureAgent(configuration, harness("openclaw")), {
    agents: { defaults: { model: "openai/gpt-5", workspace: "/sandbox/enterprise" } },
  });
  assert.deepEqual(configuration, { agents: { defaults: { model: "openai/gpt-5" } } });

  const codex = driver.configureAgent(configuration, harness("codex"));
  assert.deepEqual(codex.plugins.entries.codex.config.appServer, {
    sandbox: "danger-full-access",
    approvalsReviewer: "user",
  });
  assert.throws(
    () => driver.configureAgent(configuration, harness("openclaw", "embedded")),
    /supports only dedicated Harness revisions/,
  );
});

test("OpenShell pins the Codex sandbox and approval reviewer while preserving other app-server settings", () => {
  const driver = openShellDriver(workspaceGatewayClient());
  const harness = { id: "codex", version: "1.0.0", mode: "dedicated" };
  for (const approvalsReviewer of [undefined, "auto_review", "guardian_subagent", "user"]) {
    const appServer = {
      mode: "guardian",
      approvalPolicy: "on-request",
      sandbox: "read-only",
      transport: "websocket",
      url: "${APP_SERVER_URL}",
      authToken: "${APP_SERVER_TOKEN}",
      ...(approvalsReviewer === undefined ? {} : { approvalsReviewer }),
    };
    const configuration = codexPlugin(appServer);
    const configured = driver.configureAgent(configuration, harness);
    assert.deepEqual(configured.plugins.entries.codex.config.appServer, {
      mode: "guardian",
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
      transport: "websocket",
      url: "${APP_SERVER_URL}",
      authToken: "${APP_SERVER_TOKEN}",
      approvalsReviewer: "user",
    });
    assert.equal(configuration.plugins.entries.codex.config.appServer, appServer);
    assert.equal(appServer.sandbox, "read-only");
    // Status reads rerun the hook on stored work, so the pin must be idempotent.
    assert.deepEqual(driver.configureAgent(configured, harness), configured);
  }
});

test("OpenShell drops the Codex network proxy so it cannot replace full access", () => {
  const driver = openShellDriver(workspaceGatewayClient());
  const harness = { id: "codex", version: "1.0.0", mode: "dedicated" };
  // The Standard Codex Preset's shape: an enabled proxy in the bridge wins over the
  // full-access profile and selects a restricted profile OpenShell cannot run.
  const networkProxy = {
    enabled: true,
    mode: "limited",
    allowLocalBinding: false,
    domains: { "registry.npmjs.org": "allow" },
  };
  for (const proxy of [networkProxy, { enabled: false }, { readOnlyPaths: ["/app"] }]) {
    const appServer = Object.freeze({
      mode: "guardian",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "user",
      networkProxy: proxy,
    });
    const configured = driver.configureAgent(codexPlugin(appServer), harness);
    assert.deepEqual(configured.plugins.entries.codex.config.appServer, {
      mode: "guardian",
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
    });
    // Status reads rerun the hook on stored work, so dropping must be idempotent.
    assert.deepEqual(driver.configureAgent(configured, harness), configured);
  }
});

test("OpenShell pins an explicit main Agent workspace to the Sandbox data mount", () => {
  const driver = openShellDriver(workspaceGatewayClient());
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

  // The setup snapshot retains the admitted Harness mount. Compute separately
  // projects a local logical workspace into a dedicated Codex Gateway's ConfigMap.
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

test("OpenShell admits initial files only for its projected main workspace", () => {
  const options = sandboxInstallation().drivers.sandbox.configuration;
  options.kubernetes.sandboxDataMount.mountPath = "/sandbox/custom-workspace";
  const driver = new OpenShellSandboxDriver(options, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(workspaceGatewayClient()),
  });
  for (const id of ["codex", "openclaw"]) {
    const harness = { id, version: "1.0.0", mode: "dedicated" };
    // OCC projects configuration before admission; both Harnesses must use the same
    // operator-selected mount as the private initializer, even with omitted settings.
    const configured = driver.configureAgent({}, harness);
    assert.equal(configured.agents.defaults.workspace, "/sandbox/custom-workspace");
    assert.doesNotThrow(() => driver.validateWorkspaceSetup(harness, configured));
    const explicit = driver.configureAgent(
      { agents: { entries: { Main: { workspace: "/home/node/elsewhere" } } } },
      harness,
    );
    assert.equal(explicit.agents.entries.Main.workspace, "/sandbox/custom-workspace");
    assert.doesNotThrow(() => driver.validateWorkspaceSetup(harness, explicit));
    // Admission must still refuse a snapshot that does not use the initialized mount,
    // or a roster whose other Agent cannot consume the four main-Agent setup files.
    assert.throws(
      () =>
        driver.validateWorkspaceSetup(harness, {
          agents: { defaults: { workspace: "/sandbox/other" } },
        }),
      /agents.defaults.workspace.*must be \/sandbox\/custom-workspace/,
    );
    assert.throws(
      () =>
        driver.validateWorkspaceSetup(
          harness,
          driver.configureAgent(
            {
              agents: { entries: { main: {}, helper: {} } },
            },
            harness,
          ),
        ),
      /agents.entries.*must hold only main/,
    );
    assert.throws(
      () => driver.validateWorkspaceSetup({ ...harness, mode: "embedded" }, configured),
      /require a dedicated/,
    );
  }
});

test("OpenShell provisions native OpenClaw without exposing an inbound Harness service", async () => {
  const requests = [];
  let storedSandbox;
  const gatewayClient = workspaceGatewayClient();
  gatewayClient.createSandbox = async (request) => {
    requests.push(request);
    storedSandbox = {
      name: request.name,
      workspace: request.workspace,
      labels: structuredClone(request.labels),
      annotations: structuredClone(request.annotations),
      spec: structuredClone(request.spec),
      serviceUrls: {},
    };
    return storedSandbox;
  };
  gatewayClient.getSandbox = async () => storedSandbox;
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
  const { context, revision, requirements, nodeSetup, prepared } = runtimeSandboxFixture(driver, {
    harnessId: "openclaw",
  });
  const command = requirements.command;
  await driver.ensureNamespace(context);
  // A denied preparer must leave the native Sandbox absent and retryable.
  const create = context.kubernetes.create;
  context.kubernetes.create = async () => {
    throw new Error("preparation forbidden");
  };
  await assert.rejects(
    driver.provisionHarness({ ...context, revision, requirements }),
    /preparation forbidden/,
  );
  assert.equal(requests.length, 0);
  context.kubernetes.create = create;
  const sandbox = await driver.provisionHarness({ ...context, revision, requirements });
  await driver.provisionHarness({ ...context, revision, requirements });
  assert.equal(prepared.length, 1, "an adopted Sandbox must not recreate its PVC writer");
  const preparation = prepared[0].spec.template.spec;
  assert.equal(preparation.automountServiceAccountToken, false);
  assert.equal(preparation.securityContext.runAsUser, 10001);
  assert.deepEqual(preparation.containers[0].securityContext.capabilities, { drop: ["ALL"] });

  assert.equal(sandbox.revisionId, revision.id);
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
  assert.deepEqual(requests[0].labels, requirements.labels);
  assert.equal(requests[0].spec.environment.TMPDIR, "/tmp");
  assert.equal(requests[0].spec.policy.filesystem.include_workdir, false);
  assert.deepEqual(requests[0].spec.policy.filesystem.read_only, ["/app"]);
  assert.ok(requests[0].spec.policy.filesystem.read_write.includes("/var/tmp/openclaw"));
  assert.ok(requests[0].spec.policy.filesystem.read_write.includes("/tmp"));
  assert.equal(requests[0].spec.policy.filesystem.read_only.includes("/bin"), false);
  // The real Gateway receives this mode with the Sandbox request; a weaker
  // Landlock setting could let a ready Harness run without filesystem policy.
  assert.equal(requests[0].spec.policy.landlock.compatibility, "hard_requirement");
  assert.equal(requests[0].spec.environment.OPENCLAW_NODE_SETUP_CODE, undefined);
  assert.equal(requests[0].spec.environment.OPENCLAW_NODE_CA_PEM, undefined);
  assert.equal(requests[0].spec.environment.OPENAI_API_KEY, undefined);
  assert.equal(requests[0].spec.environment.OPENCLAW_WORKSPACE_DIR, "/sandbox/enterprise");
  assert.match(
    requests[0].spec.environment.OPENCLAW_NODE_STATE_DIR,
    /^\/sandbox\/\.openclaw-mounts\/[a-f0-9]{16}\/state$/u,
  );
  const runtimeProvider = requests[0].spec.providers.find((name) =>
    name.startsWith("oce-runtime-"),
  );
  assert.ok(runtimeProvider, "the native node must receive its enrollment provider");
  assert.deepEqual(gatewayClient.providers.get(runtimeProvider).config, {
    node_setup_json: JSON.stringify(nodeSetup),
    node_ca_pem: "-----BEGIN CERTIFICATE-----\npublic-ca\n-----END CERTIFICATE-----\n",
  });
  const profile = gatewayClient.profiles.get("oce-openclaw-runtime").profile;
  assert.deepEqual(profile.files, [
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
  assert.deepEqual(
    requests[0].spec.policy.network_policies["workspace-node-enrollment"].endpoints,
    [
      {
        host: "gateway.example.test",
        ports: [443],
        tls: "NETWORK_TLS_MODE_SKIP",
        enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
      },
    ],
  );
  await driver.cleanup({ ...context, revision });
  assert.equal(gatewayClient.providers.has(runtimeProvider), false);
  assert.equal(gatewayClient.profiles.has("oce-openclaw-runtime"), true);
  await driver.cleanup(context);
  assert.equal(gatewayClient.profiles.has("oce-openclaw-runtime"), false);
});

// Finding 1676: OpenShell answers NOT_FOUND for a Sandbox this identity may not see exactly as
// for one that is gone (GetSandbox and DeleteSandbox alike), so a stop, retirement or deletion
// records the Sandbox removed only once OpenShell confirms it: a present Sandbox is deleted, an
// absent one counts as gone only after GetWorkspace (which keeps PERMISSION_DENIED) answers, a
// refusal on any call fails with SANDBOX_GATEWAY_UNAUTHORIZED, and a missing Workspace or a
// gateway that does not answer fails closed with its own class. Nothing is deleted on any of them.
test("OpenShell revision cleanup records a Sandbox removed only once OpenShell confirms it", async () => {
  const gatewayClient = workspaceGatewayClient();
  const driver = openShellDriver(gatewayClient);
  const { context, revision } = runtimeSandboxFixture(driver);
  const { name: workspace, id: namespaceId } = context.namespace;
  gatewayClient.workspaces.set(workspace, ownedWorkspace(workspace, namespaceId));
  let present = sandboxRecord("sb-live", workspace);
  const reads = [];
  const deletions = [];
  const workspaceReads = [];
  gatewayClient.getSandbox = async (request) => {
    reads.push(request.name);
    return present;
  };
  gatewayClient.deleteSandbox = async (request) => {
    deletions.push(request.name);
  };
  const getWorkspace = gatewayClient.getWorkspace;
  gatewayClient.getWorkspace = async (name) => {
    workspaceReads.push(name);
    return getWorkspace(name);
  };
  const cleanup = () => driver.cleanup({ ...context, revision });
  // grpc-js ServiceError shape, as unary() passes PERMISSION_DENIED (7) and UNAUTHENTICATED (16).
  const refusal = (code, details) =>
    Object.assign(new Error(`${code} refused: ${details}`), { code, details });
  // UNAUTHENTICATED is transient (the worker retries it within its budget), PERMISSION_DENIED
  // is not (finding 1694); both carry the code.
  const unauthorized = (operation, transient = false) =>
    assert.rejects(operation(), (error) => {
      assert.ok(error instanceof SandboxGatewayUnauthorizedError, String(error));
      assert.equal(error.code, "SANDBOX_GATEWAY_UNAUTHORIZED");
      assert.equal(error.transient, transient);
      assert.match(error.message, /cannot be confirmed removed/);
      return true;
    });

  // A present Sandbox is deleted by its revision-derived name; no Workspace read is needed.
  await cleanup();
  assert.equal(reads.length, 1);
  assert.match(reads[0], /^sb-[a-f0-9]{16}$/u);
  assert.deepEqual(deletions, reads);
  assert.deepEqual(workspaceReads, []);
  // An absent one is gone once the Workspace read passes and a second read still finds none,
  // with no DeleteSandbox.
  present = undefined;
  await cleanup();
  assert.deepEqual(workspaceReads, [workspace]);
  assert.equal(reads.length, 3);
  assert.deepEqual(deletions, reads.slice(0, 1));
  // Finding 1692: GetWorkspace proves the role now, not at the first read, so a role restored
  // between them would confirm a live Sandbox gone. A Sandbox the second read finds is deleted
  // instead; a refusal on that read is the same lost identity, and nothing is recorded.
  const answers = (...values) => {
    const queue = [...values];
    gatewayClient.getSandbox = async (request) => {
      reads.push(request.name);
      const answer = queue.length === 0 ? present : queue.shift();
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
    };
  };
  answers(undefined, sandboxRecord("sb-live", workspace));
  await cleanup();
  assert.deepEqual(workspaceReads, [workspace, workspace]);
  assert.equal(reads.length, 5);
  assert.deepEqual(deletions, [reads[0], reads[0]]);
  answers(undefined, refusal(7, "sandbox"));
  await unauthorized(cleanup);
  assert.deepEqual(deletions, [reads[0], reads[0]]);
  answers();
  // The identity is refused on the Workspace read: the Sandbox may be live and hidden.
  for (const code of [7, 16]) {
    gatewayClient.getWorkspace = async () => {
      throw refusal(code, "workspace");
    };
    await unauthorized(cleanup, code === 16);
  }
  // The identity is refused on the Sandbox read itself (an expired token fails every call).
  gatewayClient.getWorkspace = getWorkspace;
  gatewayClient.getSandbox = async () => {
    throw refusal(16, "token expired");
  };
  await unauthorized(cleanup, true);
  assert.deepEqual(workspaceReads, [workspace, workspace, workspace]);
  // OpenShell reports no Workspace: nothing proves the Sandbox gone, so cleanup fails closed.
  gatewayClient.getSandbox = async () => undefined;
  gatewayClient.getWorkspace = async () => undefined;
  await assert.rejects(cleanup(), /reports no Workspace .* cannot be confirmed removed/);
  // A gateway that does not answer keeps its class, so the worker retries the idempotent stop.
  const unanswered = new DependencyUnavailableError(
    "OpenShell GetWorkspace failed with gRPC status 14.",
  );
  gatewayClient.getWorkspace = async () => {
    throw unanswered;
  };
  await assert.rejects(cleanup(), (error) => error === unanswered);
  gatewayClient.getWorkspace = getWorkspace;
  // A Sandbox that is present but refused on the delete: the same code, nothing recorded.
  gatewayClient.getSandbox = async () => sandboxRecord("sb-live", workspace);
  gatewayClient.deleteSandbox = async () => {
    throw refusal(7, "sandbox:delete");
  };
  await unauthorized(cleanup);
  // A Sandbox removed between the read and the delete answers NOT_FOUND, which the client
  // reports unconfirmed; that failure keeps its class, and the next pass's read confirms it.
  const unconfirmed = new Error(
    "OpenShell DeleteSandbox did not find the Sandbox, so the deletion is unconfirmed.",
  );
  gatewayClient.deleteSandbox = async () => {
    throw unconfirmed;
  };
  await assert.rejects(cleanup(), (error) => error === unconfirmed);
  assert.deepEqual(deletions, [reads[0], reads[0]]);
  // The runtime provider is removed only after the Sandbox's state is confirmed.
  assert.equal(
    gatewayClient.calls.some(([method]) => method === "deleteProvider"),
    false,
  );

  // The same refusal on CreateSandbox: OpenShell keeps PERMISSION_DENIED there, so a Sandbox
  // hidden from the identity is neither adopted nor created over, and the deployment fails with
  // the code instead of spending its attempts on a generic failure.
  const requirements = runtimeSandboxFixture(driver).requirements;
  gatewayClient.getSandbox = async () => undefined;
  gatewayClient.createSandbox = async () => {
    throw refusal(7, "sandbox:create");
  };
  await assert.rejects(driver.provisionHarness({ ...context, revision, requirements }), (error) => {
    assert.ok(error instanceof SandboxGatewayUnauthorizedError, String(error));
    assert.equal(error.transient, false);
    assert.match(error.message, /cannot be created or adopted/);
    return true;
  });
});

// Finding 1676, credential path: a credential withdrawal that reports `absent` settles as
// withdrawn, so a Sandbox hidden from the identity (GetSandbox and DetachSandboxProvider answer
// NOT_FOUND for it) must not read as absent while it keeps resolving the credential. The gateway
// confirms absence through GetWorkspace and fails a refusal with SANDBOX_GATEWAY_UNAUTHORIZED.
test("the OpenShell Credential Gateway reports a withdrawal absent only once the Workspace confirms it", async () => {
  const { client, driver, context } = credentialGatewayOverProviders();
  const sourceId = "cs_00000000-0000-4000-8000-0000000000c1";
  const { namespace, signal } = context(sourceId);
  const workspace = openShellWorkspaceName(namespace);
  const provider = openShellProviderName(sourceId);
  const sandbox = "sb-credential";
  let visibleWorkspace = { name: workspace, labels: {}, phase: "WORKSPACE_PHASE_ACTIVE" };
  let listed;
  let detachAnswer;
  // Answers for the next detaches and Sandbox reads, ahead of `detachAnswer` and `listed`.
  const detachAnswers = [];
  const sandboxAnswers = [];
  const calls = [];
  client.getWorkspace = async (name) => {
    calls.push(["getWorkspace", name]);
    return visibleWorkspace;
  };
  client.getSandbox = async (request) => {
    calls.push(["getSandbox", request.name]);
    const providers = sandboxAnswers.length === 0 ? listed : sandboxAnswers.shift();
    return providers === undefined ? undefined : { name: sandbox, spec: { providers } };
  };
  client.detachSandboxProvider = async (_workspace, name, detached) => {
    calls.push(["detachSandboxProvider", name, detached]);
    return detachAnswers.length === 0 ? detachAnswer : detachAnswers.shift();
  };
  // The receipts the status reads name: each settles the detach it follows.
  const receipts = [];
  client.getSandboxProviderStatus = async (_workspace, _sandbox, _provider, _signal, receiptId) => {
    receipts.push(receiptId);
    return { state: "PROVIDER_READINESS_STATE_REVOKED" };
  };
  const withdraw = (recheck) =>
    driver.withdraw({
      namespace,
      revision: { harness: { id: "codex", mode: "dedicated" } },
      sandbox: { resourceName: sandbox },
      sourceId,
      signal,
      ...(recheck ? { recheck: true } : {}),
    });
  const refusal = (code) => Object.assign(new Error(`${code} refused`), { code, details: "ws" });
  const unauthorized = (recheck, transient = false) =>
    assert.rejects(withdraw(recheck), (error) => {
      assert.ok(error instanceof SandboxGatewayUnauthorizedError, String(error));
      assert.equal(error.code, "SANDBOX_GATEWAY_UNAUTHORIZED");
      assert.equal(error.transient, transient);
      assert.match(error.message, /credential of Sandbox .* cannot be confirmed withdrawn/);
      return true;
    });

  // A detach receipt revokes without any Workspace read.
  detachAnswer = { receiptId: "receipt-1" };
  assert.deepEqual(await withdraw(false), { sourceId, state: "revoked" });
  assert.deepEqual(calls, [["detachSandboxProvider", sandbox, provider]]);
  // A detach that finds no Sandbox is absent only once the Workspace answers and a second
  // Sandbox read still finds none.
  calls.length = 0;
  detachAnswer = undefined;
  assert.deepEqual(await withdraw(false), { sourceId, state: "absent" });
  assert.deepEqual(calls, [
    ["detachSandboxProvider", sandbox, provider],
    ["getWorkspace", workspace],
    ["getSandbox", sandbox],
  ]);
  // Finding 1692: a Sandbox that second read finds (a role restored between the detach and
  // GetWorkspace) is detached again, not recorded absent; a detach that misses it again is
  // unconfirmed, so the worker retries, and a refusal on the second read carries the code.
  calls.length = 0;
  listed = [provider];
  receipts.length = 0;
  detachAnswers.push(undefined, { receiptId: "receipt-restored" });
  assert.deepEqual(await withdraw(false), { sourceId, state: "revoked" });
  assert.deepEqual(calls, [
    ["detachSandboxProvider", sandbox, provider],
    ["getWorkspace", workspace],
    ["getSandbox", sandbox],
    ["detachSandboxProvider", sandbox, provider],
  ]);
  assert.deepEqual(receipts, ["receipt-restored"]);
  detachAnswers.push(undefined, undefined);
  await assert.rejects(
    withdraw(false),
    /GetSandbox finds Sandbox .* but DetachSandboxProvider did not, so the credential .* cannot be confirmed withdrawn/,
  );
  assert.equal(detachAnswers.length, 0);
  const sandboxRead = client.getSandbox;
  client.getSandbox = async () => {
    throw refusal(16);
  };
  await unauthorized(false, true);
  client.getSandbox = sandboxRead;
  // Outside a recheck only a receipt revokes: a restored Sandbox that does not list the provider
  // is detached all the same.
  calls.length = 0;
  receipts.length = 0;
  listed = ["operator-static"];
  detachAnswers.push(undefined, { receiptId: "receipt-unlisted" });
  assert.deepEqual(await withdraw(false), { sourceId, state: "revoked" });
  assert.deepEqual(calls, [
    ["detachSandboxProvider", sandbox, provider],
    ["getWorkspace", workspace],
    ["getSandbox", sandbox],
    ["detachSandboxProvider", sandbox, provider],
  ]);
  assert.deepEqual(receipts, ["receipt-unlisted"]);
  listed = [provider];
  // A refusal on the receipt's status read carries the code too.
  const statusRead = client.getSandboxProviderStatus;
  client.getSandboxProviderStatus = async () => {
    throw refusal(7);
  };
  detachAnswers.push({ receiptId: "receipt-refused" });
  await unauthorized(false);
  client.getSandboxProviderStatus = statusRead;
  listed = undefined;
  for (const code of [7, 16]) {
    client.getWorkspace = async () => {
      throw refusal(code);
    };
    await unauthorized(false, code === 16);
  }
  client.getWorkspace = async () => undefined;
  await assert.rejects(withdraw(false), /reports no Workspace .* cannot be confirmed withdrawn/);
  // The refusal on the detach itself carries the same code.
  client.getWorkspace = async (name) => {
    calls.push(["getWorkspace", name]);
    return visibleWorkspace;
  };
  client.detachSandboxProvider = async () => {
    throw refusal(7);
  };
  await unauthorized(false);
  // A recheck reads the Sandbox first: a listed provider is detached again, a Sandbox without it
  // is revoked, and a missing one is absent only with the Workspace's confirmation.
  calls.length = 0;
  client.detachSandboxProvider = async (_workspace, name, detached) => {
    calls.push(["detachSandboxProvider", name, detached]);
    return { receiptId: "receipt-2" };
  };
  listed = ["operator-static", provider];
  assert.deepEqual(await withdraw(true), { sourceId, state: "revoked" });
  listed = ["operator-static"];
  assert.deepEqual(await withdraw(true), { sourceId, state: "revoked" });
  listed = undefined;
  assert.deepEqual(await withdraw(true), { sourceId, state: "absent" });
  assert.deepEqual(calls, [
    ["getSandbox", sandbox],
    ["detachSandboxProvider", sandbox, provider],
    ["getSandbox", sandbox],
    ["getSandbox", sandbox],
    ["getWorkspace", workspace],
    ["getSandbox", sandbox],
  ]);
  // A recheck whose second read finds the Sandbox without the provider is revoked, no detach;
  // one that lists it is detached again.
  calls.length = 0;
  sandboxAnswers.push(undefined, ["operator-static"]);
  assert.deepEqual(await withdraw(true), { sourceId, state: "revoked" });
  sandboxAnswers.push(undefined, ["operator-static", provider]);
  assert.deepEqual(await withdraw(true), { sourceId, state: "revoked" });
  assert.deepEqual(calls, [
    ["getSandbox", sandbox],
    ["getWorkspace", workspace],
    ["getSandbox", sandbox],
    ["getSandbox", sandbox],
    ["getWorkspace", workspace],
    ["getSandbox", sandbox],
    ["detachSandboxProvider", sandbox, provider],
  ]);
  client.getWorkspace = async () => {
    throw refusal(16);
  };
  await unauthorized(true, true);
  client.getSandbox = async () => {
    throw refusal(7);
  };
  await unauthorized(true);
});

// Finding 1642: a native worker that holds a failed model check never connects its node.
// Compute asks for the Codex bearer-passthrough exposure (APP_SERVER_PORT with the
// APP_TOKEN_SHA verifier) so it can read that held failure; the raw token never arrives.
test("OpenShell exposes a native OpenClaw worker's held-failure port when Compute asks for it", async () => {
  const requests = [];
  let storedSandbox;
  const gatewayClient = workspaceGatewayClient();
  let createdServiceUrl = "http://native.example.test:9443/";
  gatewayClient.createSandbox = async (request) => {
    requests.push(request);
    storedSandbox = {
      name: request.name,
      workspace: request.workspace,
      labels: structuredClone(request.labels),
      annotations: structuredClone(request.annotations),
      spec: structuredClone(request.spec),
      // Like the real client: an exposure always comes back with its URL.
      serviceUrls: request.serviceExposures.length === 0 ? {} : { "": createdServiceUrl },
    };
    return storedSandbox;
  };
  gatewayClient.getSandbox = async () => storedSandbox;
  const service = {
    sandbox: "",
    name: "",
    targetPort: 18790,
    authorizationMode: "SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH",
    advertisedUrl: "http://native.example.test:18790/",
    url: "http://native.example.test:9443/",
  };
  let exposedService = undefined;
  gatewayClient.getService = async (_workspace, sandbox, name) =>
    exposedService === undefined ? undefined : { ...exposedService, sandbox, name };
  const driver = openShellDriver(gatewayClient);
  const { context, revision, requirements } = runtimeSandboxFixture(driver, {
    harnessId: "openclaw",
  });
  const exposing = (environment) => ({
    ...requirements,
    environment: [...requirements.environment, ...environment],
  });
  await driver.ensureNamespace(context);

  // The exposure needs the verifier, and never the raw token, exactly like Codex.
  for (const [environment, message] of [
    [[{ name: "APP_SERVER_PORT", value: "18790" }], /requires one literal APP_TOKEN_SHA verifier/],
    [
      [
        { name: "APP_SERVER_PORT", value: "18790" },
        { name: "APP_TOKEN_SHA", value: "b".repeat(64) },
        {
          name: "APP_SERVER_TOKEN",
          valueFrom: { secretKeyRef: { name: "agent-token", key: "token" } },
        },
      ],
      /cannot receive APP_SERVER_TOKEN/,
    ],
  ]) {
    await assert.rejects(
      driver.provisionHarness({ ...context, revision, requirements: exposing(environment) }),
      (error) => {
        assert.ok(error instanceof SandboxRevisionUnsupportedError, String(error));
        assert.equal(error.code, "SANDBOX_SECRET_ENVIRONMENT_UNSUPPORTED");
        assert.match(error.message, message);
        return true;
      },
    );
  }
  assert.equal(requests.length, 0);

  const exposed = exposing([
    { name: "APP_SERVER_PORT", value: "18790" },
    { name: "APP_TOKEN_SHA", value: "b".repeat(64) },
  ]);
  // The created exposure's URL is validated on the create pass, as for Codex.
  createdServiceUrl = "ftp://native.example.test/";
  await assert.rejects(
    driver.provisionHarness({ ...context, revision, requirements: exposed }),
    /Harness service URL must be an HTTP origin/,
  );
  requests.length = 0;
  storedSandbox = undefined;
  createdServiceUrl = "http://native.example.test:9443/";
  const sandbox = await driver.provisionHarness({ ...context, revision, requirements: exposed });
  assert.equal(sandbox.revisionId, revision.id);
  assert.equal(requests.length, 1);
  // The worker's transport port, not Codex's app-server port.
  assert.deepEqual(requests[0].serviceExposures, [
    { service: "", targetPort: 18790, authorizationMode: "bearer_passthrough" },
  ]);
  assert.equal(requests[0].spec.environment.APP_SERVER_PORT, "18790");
  assert.equal(requests[0].spec.environment.APP_TOKEN_SHA, "b".repeat(64));
  assert.equal(requests[0].spec.environment.APP_SERVER_TOKEN, undefined);
  assert.equal(requests[0].spec.environment.OPENAI_API_KEY, undefined);
  // Adoption needs the exact exposure: a lost or mismatched service fails closed,
  // like Codex, since the spec match proves the Sandbox was created with it.
  for (const lost of [undefined, { ...service, targetPort: 8081 }]) {
    exposedService = lost;
    await assert.rejects(
      driver.provisionHarness({ ...context, revision, requirements: exposed }),
      /exists without its exact bearer-passthrough Harness service/,
    );
  }
  exposedService = service;
  await driver.provisionHarness({ ...context, revision, requirements: exposed });
  assert.equal(requests.length, 1);
  // The exposure is for Compute's status read only: no inbound Harness endpoint.
  await assert.rejects(
    driver.harnessEndpoint({ ...context, revision, requirements: exposed }),
    /only for dedicated Codex revisions/,
  );
  // A projected APP_SERVER_PORT asks for no exposure (finding 1661): it is refused as a
  // secretKeyRef variable, not for a missing verifier, before any gateway call.
  await assert.rejects(
    driver.provisionHarness({
      ...context,
      revision,
      requirements: exposing([
        { name: "APP_SERVER_PORT", valueFrom: { secretKeyRef: { name: "ports", key: "port" } } },
      ]),
    }),
    (error) => {
      assert.ok(error instanceof SandboxRevisionUnsupportedError, String(error));
      assert.match(error.message, /cannot receive secretKeyRef environment APP_SERVER_PORT/);
      return true;
    },
  );
  assert.equal(requests.length, 1);

  // Finding 1657: the exposure serves Compute's read only until the worker's node enrolls.
  // OpenShell routes it without authenticating the caller, so once nothing of Compute's
  // listens there it goes, and a Sandbox adopted after enrollment is without it.
  const deletions = [];
  let deletion = async () => {
    exposedService = undefined;
  };
  gatewayClient.deleteService = async (workspace, sandboxName, name) => {
    deletions.push([workspace, sandboxName, name]);
    await deletion();
  };
  const enrolled = { ...context, revision, requirements: exposed, workspaceNodeEnrolled: true };
  // The gateway does not confirm the delete: adoption fails closed, the service stays.
  deletion = async () => {
    throw new Error("OpenShell DeleteService did not confirm deletion.");
  };
  await assert.rejects(driver.provisionHarness(enrolled), /did not confirm deletion/);
  assert.deepEqual(deletions, [[requests[0].workspace, requests[0].name, ""]]);
  assert.notEqual(exposedService, undefined);
  deletion = async () => {
    exposedService = undefined;
  };
  await driver.provisionHarness(enrolled);
  assert.equal(deletions.length, 2);
  assert.equal(exposedService, undefined);
  // Absent after enrollment is the steady state: no delete, no complaint, no create.
  await driver.provisionHarness(enrolled);
  assert.equal(deletions.length, 2);
  assert.equal(requests.length, 1);
  // Before enrollment the same absence stays an anomaly.
  await assert.rejects(
    driver.provisionHarness({ ...context, revision, requirements: exposed }),
    /exists without its exact bearer-passthrough Harness service/,
  );
  // A Sandbox created again after enrollment (the stale one was removed) carries the
  // exposure its immutable request names and loses it in the same pass.
  storedSandbox = undefined;
  exposedService = service;
  await driver.provisionHarness(enrolled);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].serviceExposures, requests[0].serviceExposures);
  assert.equal(deletions.length, 3);
  assert.equal(exposedService, undefined);
  // The enrolling pass withdraws it directly, once; a Codex Harness keeps its transport.
  exposedService = service;
  await driver.withdrawHarnessExposure(enrolled);
  assert.equal(deletions.length, 4);
  assert.equal(exposedService, undefined);
  await driver.withdrawHarnessExposure(enrolled);
  assert.equal(deletions.length, 4);
  exposedService = service;
  deletion = async () => {
    throw new Error("OpenShell DeleteService did not confirm deletion.");
  };
  await assert.rejects(driver.withdrawHarnessExposure(enrolled), /did not confirm deletion/);
  assert.notEqual(exposedService, undefined);
  assert.equal(deletions.length, 5);
  await assert.rejects(
    driver.withdrawHarnessExposure({
      ...enrolled,
      revision: { ...revision, harness: { id: "codex", version: "1.0.0", mode: "dedicated" } },
    }),
    (error) => {
      assert.ok(error instanceof SandboxRevisionUnsupportedError, String(error));
      assert.equal(error.code, "SANDBOX_HARNESS_UNSUPPORTED");
      assert.match(error.message, /keeps its exposure as the Gateway transport/);
      return true;
    },
  );
  await assert.rejects(
    driver.withdrawHarnessExposure({
      ...enrolled,
      revision: { ...revision, sandboxDriverId: "other" },
    }),
    /another Sandbox Driver/,
  );
  assert.equal(deletions.length, 5);
  // Finding 1670: OpenShell answers NOT_FOUND for a Sandbox this identity may not see exactly
  // as for one that is gone, so an absent service is "withdrawn" only once a Workspace read the
  // identity still passes confirms it (GetWorkspace keeps PERMISSION_DENIED). A refusal there
  // fails closed with its own code, a missing Workspace fails closed too, a gateway that does
  // not answer keeps its class, and no deletion is attempted on any of them.
  exposedService = undefined;
  const getWorkspace = gatewayClient.getWorkspace;
  const workspaceReads = [];
  gatewayClient.getWorkspace = async (name) => {
    workspaceReads.push(name);
    return getWorkspace(name);
  };
  await driver.withdrawHarnessExposure(enrolled);
  await driver.provisionHarness(enrolled);
  assert.deepEqual(workspaceReads, [requests[0].workspace, requests[0].workspace]);
  assert.equal(deletions.length, 5);
  // grpc-js ServiceError shape: PERMISSION_DENIED (7) and UNAUTHENTICATED (16).
  for (const [code, name] of [
    [7, "PERMISSION_DENIED"],
    [16, "UNAUTHENTICATED"],
  ]) {
    gatewayClient.getWorkspace = async () => {
      throw Object.assign(new Error(`${code} ${name}: workspace`), { code, details: "workspace" });
    };
    for (const withdraw of [
      () => driver.withdrawHarnessExposure(enrolled),
      () => driver.provisionHarness(enrolled),
    ]) {
      await assert.rejects(withdraw(), (error) => {
        assert.ok(error instanceof SandboxGatewayUnauthorizedError, String(error));
        assert.equal(error.code, "SANDBOX_GATEWAY_UNAUTHORIZED");
        assert.equal(error.transient, code === 16);
        assert.match(error.message, /cannot be confirmed withdrawn/);
        return true;
      });
    }
  }
  gatewayClient.getWorkspace = async () => undefined;
  await assert.rejects(
    driver.withdrawHarnessExposure(enrolled),
    /reports no Workspace .* cannot be confirmed withdrawn/,
  );
  const unansweredWorkspace = new DependencyUnavailableError(
    "OpenShell GetWorkspace failed with gRPC status 14.",
  );
  gatewayClient.getWorkspace = async () => {
    throw unansweredWorkspace;
  };
  await assert.rejects(
    driver.withdrawHarnessExposure(enrolled),
    (error) => error === unansweredWorkspace,
  );
  assert.equal(deletions.length, 5);
  gatewayClient.getWorkspace = getWorkspace;
  // The same lost or expired identity answers on the first read (an expired token fails every
  // call as UNAUTHENTICATED) or on the delete itself: those fail with the code too, instead of
  // spending attempts as a generic failure, and nothing is confirmed.
  const serviceRead = gatewayClient.getService;
  gatewayClient.getService = async () => {
    throw Object.assign(new Error("16 UNAUTHENTICATED: token expired"), {
      code: 16,
      details: "token expired",
    });
  };
  for (const withdraw of [
    () => driver.withdrawHarnessExposure(enrolled),
    () => driver.provisionHarness(enrolled),
  ]) {
    await assert.rejects(withdraw(), (error) => {
      assert.ok(error instanceof SandboxGatewayUnauthorizedError, String(error));
      assert.equal(error.code, "SANDBOX_GATEWAY_UNAUTHORIZED");
      assert.equal(error.transient, true);
      return true;
    });
  }
  gatewayClient.getService = serviceRead;
  exposedService = service;
  const serviceDelete = gatewayClient.deleteService;
  gatewayClient.deleteService = async () => {
    throw Object.assign(new Error("7 PERMISSION_DENIED: workspace"), {
      code: 7,
      details: "workspace",
    });
  };
  await assert.rejects(
    driver.withdrawHarnessExposure(enrolled),
    (error) => error instanceof SandboxGatewayUnauthorizedError,
  );
  gatewayClient.deleteService = serviceDelete;
  exposedService = undefined;
  assert.equal(deletions.length, 5);
  // Finding 1692: GetWorkspace proves the role now, not at the first read, so a role restored
  // between them would confirm a live service withdrawn. The service is read again after
  // GetWorkspace: one that read finds is deleted, a refusal there carries the code, and only a
  // service still missing counts as withdrawn.
  gatewayClient.getWorkspace = async (name) => {
    workspaceReads.push(name);
    return getWorkspace(name);
  };
  const serviceAnswers = [];
  gatewayClient.getService = async (...args) => {
    const answer = serviceAnswers.length === 0 ? serviceRead(...args) : serviceAnswers.shift();
    if (answer instanceof Error) {
      throw answer;
    }
    return answer;
  };
  exposedService = service;
  deletion = async () => {
    exposedService = undefined;
  };
  serviceAnswers.push(undefined);
  await driver.withdrawHarnessExposure(enrolled);
  assert.equal(workspaceReads.length, 3);
  assert.equal(deletions.length, 6);
  assert.equal(exposedService, undefined);
  exposedService = service;
  serviceAnswers.push(
    undefined,
    Object.assign(new Error("7 PERMISSION_DENIED: workspace"), { code: 7, details: "workspace" }),
  );
  await assert.rejects(
    driver.withdrawHarnessExposure(enrolled),
    (error) => error instanceof SandboxGatewayUnauthorizedError,
  );
  assert.equal(deletions.length, 6);
  assert.notEqual(exposedService, undefined);
  exposedService = undefined;
  serviceAnswers.push(undefined);
  await driver.withdrawHarnessExposure(enrolled);
  assert.equal(workspaceReads.length, 5);
  assert.equal(deletions.length, 6);
  gatewayClient.getService = serviceRead;
  gatewayClient.getWorkspace = getWorkspace;
  // Nothing is observed through a withdrawn exposure, and nothing is asked of the gateway.
  const getService = gatewayClient.getService;
  gatewayClient.getService = async () => assert.fail("an enrolled worker is not observed");
  await assert.rejects(
    driver.harnessStatus({ ...enrolled, transportToken: "transport-token" }),
    /node has enrolled; its Harness exposure is withdrawn/,
  );
  gatewayClient.getService = getService;
});

test("OpenShell native startup creates private temporary state without changing the supervisor temporary directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oce-native-temporary-"));
  try {
    const supervisorTemporary = join(directory, "supervisor");
    await mkdir(supervisorTemporary);
    await chmod(supervisorTemporary, 0o777);
    const gateway = workspaceGatewayClient();
    let request;
    gateway.createSandbox = async (value) => {
      request = value;
      return { name: value.name, serviceUrls: {} };
    };
    const driver = new OpenShellSandboxDriver(sandboxInstallation().drivers.sandbox.configuration, {
      id: "openshell-sandbox",
      implementation: "openshell",
      backend: backendFor(gateway),
    });
    const fixture = runtimeSandboxFixture(driver, { harnessId: "openclaw" });
    // Execute the actual native startup through its filesystem-initialization phase.
    // Image assets and model execution belong to the separate real-runtime proof.
    const assetBoundary = NATIVE_WORKER_ENTRYPOINT.indexOf("initializeRuntimeAssets();");
    assert.ok(assetBoundary > 0);
    fixture.requirements.command = harnessRuntimeCommand(
      `${NATIVE_WORKER_ENTRYPOINT.slice(0, assetBoundary)}\nprocess.exit(0);`,
    );
    await driver.provisionHarness({
      ...fixture.context,
      revision: fixture.revision,
      requirements: fixture.requirements,
    });
    const result = spawnSync(
      process.execPath,
      request.spec.command.slice(RUNTIME_WRAPPER_COMMAND.length - 1),
      {
        encoding: "utf8",
        timeout: 5_000,
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          TMPDIR: supervisorTemporary,
          OPENCLAW_NATIVE_INFERENCE_CONFIG: "{}",
          OPENCLAW_NODE_STATE_DIR: join(directory, "state"),
          OPENCLAW_NODE_SETUP_CODE: "controlled-filesystem-phase",
          OPENCLAW_WORKSPACE_DIR: join(directory, "workspace"),
          OPENCLAW_NATIVE_WORKER_CAPACITY: "1",
          OPENCLAW_RUNTIME_STATUS_PORT: String(await availablePort({ host: "0.0.0.0" })),
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const temporary = await stat(join(directory, "tmp"));
    assert.equal(temporary.uid, process.getuid());
    assert.equal(temporary.mode & 0o7777, 0o700);
    assert.equal((await stat(supervisorTemporary)).mode & 0o7777, 0o777);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
    return harnessService(sandbox, service, services.get(sandbox));
  };
  gatewayClient.createSandbox = async (request) => {
    calls.push(["createSandbox", request.name, request.requestId]);
    // The gateway adds its own internal annotation, which adoption must not read as foreign.
    const annotations = {
      ...request.annotations,
      "internal.openshell.ai/runtime-identity": "opaque",
    };
    const sandbox = storedSandbox(request, { annotations });
    sandboxes.set(request.name, sandbox);
    services.set(request.name, sandbox.serviceUrls[""]);
    if (createError !== undefined) {
      throw createError;
    }
    return sandbox;
  };
  const driver = openShellDriver(gatewayClient);
  const context = namespaceContext();
  const revision = dedicatedRevision(driver, context, "000000000003");
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

test("OpenShell has the gateway restart an exited Harness and still adopts Sandboxes created without that policy", async () => {
  // Finding 1029: with no policy OpenShell persists NEVER, and an exited Harness stays down until
  // the Agent is deployed again. A signalled Harness exits 0, so only ALWAYS restarts it.
  const gatewayClient = workspaceGatewayClient();
  const sandboxes = new Map();
  const creates = [];
  gatewayClient.getSandbox = async ({ name }) => sandboxes.get(name);
  gatewayClient.getService = async (_workspace, sandbox, service) =>
    harnessService(sandbox, service, sandboxes.get(sandbox)?.serviceUrls[""]);
  gatewayClient.createSandbox = async (request) => {
    creates.push(request);
    const sandbox = storedSandbox(request, { annotations: { ...request.annotations } });
    sandboxes.set(request.name, sandbox);
    return sandbox;
  };
  const driver = openShellDriver(gatewayClient);
  const context = namespaceContext();
  const revision = dedicatedRevision(driver, context, "000000001029");
  const provision = () =>
    driver.provisionHarness({ ...context, revision, requirements: codexRequirements(revision) });

  const first = await provision();
  assert.equal(creates.length, 1);
  assert.equal(creates[0].spec.restart_policy, "SANDBOX_RESTART_POLICY_ALWAYS");

  // The gateway reports the stored policy by enum name, or by number from an older decoder.
  // A Sandbox stored before the policy existed (NEVER, or unset) is still this revision's own.
  const stored = sandboxes.get(first.resourceName);
  for (const policy of [
    "SANDBOX_RESTART_POLICY_ALWAYS",
    3,
    "SANDBOX_RESTART_POLICY_NEVER",
    1,
    "SANDBOX_RESTART_POLICY_UNSPECIFIED",
    0,
    undefined,
  ]) {
    const { restart_policy: _omitted, ...spec } = stored.spec;
    sandboxes.set(first.resourceName, {
      ...stored,
      spec: policy === undefined ? spec : { ...spec, restart_policy: policy },
    });
    assert.deepEqual(await provision(), first, `adopts a Sandbox stored with ${String(policy)}`);
  }
  // OCC never asks for ON_FAILURE, so a Sandbox stored with it is not this revision's.
  for (const policy of ["SANDBOX_RESTART_POLICY_ON_FAILURE", 2]) {
    sandboxes.set(first.resourceName, {
      ...stored,
      spec: { ...stored.spec, restart_policy: policy },
    });
    await assert.rejects(provision(), /without exact AgentRevision ownership and content/);
  }
  assert.equal(creates.length, 1);
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
  let reachedHold;
  let nextId = 0;
  const refused = (reason) => new OpenShellRequestReplayRefusedError(reason, reason);
  gatewayClient.getSandbox = async ({ name }) => {
    calls.push(["getSandbox"]);
    return sandboxes.get(name);
  };
  gatewayClient.getService = async (_workspace, sandbox, service) => {
    calls.push(["getService"]);
    return harnessService(sandbox, service, sandboxes.get(sandbox)?.serviceUrls[""]);
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
      reachedHold();
      await held;
    }
    // OpenShell keeps Sandbox names unique per Workspace.
    if (sandboxes.has(request.name)) {
      throw new OpenShellSandboxAlreadyExistsError(request.name);
    }
    const sandbox = storedSandbox(request, { id: `sandbox-${nextId++}` });
    sandboxes.set(request.name, sandbox);
    admissions.get(request.requestId).sandboxId = sandbox.id;
    return sandbox;
  };
  const driver = openShellDriver(gatewayClient);
  const context = namespaceContext();
  const revision = dedicatedRevision(driver, context, "000000000004");
  const provision = (target = driver) =>
    target.provisionHarness({ ...context, revision, requirements: codexRequirements(revision) });
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
  const restarted = openShellDriver(gatewayClient);
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
    sandboxes.set(request.name, storedSandbox(request, { id: "sandbox-late" }));
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
  const reached = new Promise((resolve) => {
    reachedHold = resolve;
  });
  const held = provision();
  // Wait for the first pass to take the hold, or to end without reaching it.
  await Promise.race([reached, held]);
  assert.equal(holdHandler, undefined, "the first pass never reached CreateSandbox");
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
  const driver = openShellDriver(gatewayClient);
  const context = namespaceContext();
  const revision = dedicatedRevision(driver, context, "000000000002");
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
  const { context, revision, requirements } = runtimeSandboxFixture(driver);
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
    return { ...storedSandbox, serviceUrls: { "": "http://codex.example.test" } };
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
  const options = sandboxInstallation().drivers.sandbox.configuration;
  // The advertised workspace, Harness environment, and writable mount must agree even
  // when an operator chooses a path other than the development default.
  options.kubernetes.sandboxDataMount.mountPath = "/sandbox/custom-workspace";
  const driver = openShellDriver(gatewayClient, options);
  // Same-cluster Compute with the in-cluster Envoy route hostname the k3d OpenShell
  // profile uses; the node's setup URL is the one Compute derives for that route.
  const routeHost = "occ-gateway-0123456789ab.envoy-gateway-system.svc.cluster.local";
  const computeOptions = conformanceKubernetesOptions({
    gatewayTrustedProxyCidrs: ["127.0.0.1/32"],
    runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
  });
  // Routing derives the Gateway client peer from the Envoy namespace.
  delete computeOptions.network.gatewayClients;
  const compute = new KubernetesComputeDriver(
    {
      ...computeOptions,
      gatewayRouting: {
        hostname: routeHost,
        gatewayName: "oce-agent-gateways",
        gatewayNamespace: "openclaw-system",
        envoyNamespace: "envoy-gateway-system",
      },
    },
    { sandboxDriver: driver },
  );
  const { context, revision, requirements, runtimeManifest, codexConfig, nodeSetup } =
    runtimeSandboxFixture(driver, {
      nodeSetupUrl: (target, { namespace }) =>
        compute.workspaceNodeConnectionUrl(
          target,
          { name: namespace.name, plane: "execution" },
          compute.getGatewayEndpoint(target),
        ),
    });
  // Account fields are opaque claims, even when their text resembles a Harness path.
  const account = {
    accountId: "workspace/home/node/account",
    planType: "business",
    userId: "user/home/node/identity",
    accountUserId: "account-user/home/node/identity",
    email: "dev/home/node/alice@example.test",
    isFedramp: false,
  };
  const accountJson = JSON.stringify(account);
  revision.harnessAuth = {
    method: "credential_source",
    sourceId: "cs_00000000-0000-4000-8000-000000000001",
    credentialGatewayId: "openshell-credentials",
    sourceType: "codex-oauth",
    loginMode: "chatgptAuthTokens",
  };
  requirements.credentialAttachments[0] = {
    ...requirements.credentialAttachments[0],
    sourceId: revision.harnessAuth.sourceId,
    externalChatgptAuth: {
      accessTokenPlaceholder: `openshell:resolve:env:s${"1".repeat(64)}_CODEX_ACCESS_TOKEN`,
      ...account,
    },
  };
  requirements.loginMode = revision.harnessAuth.loginMode;
  requirements.environment.push(
    { name: "CODEX_LOGIN_MODE", value: requirements.loginMode },
    ...compute.credentialSourceEnvironment(revision, requirements.credentialAttachments),
  );
  assert.match(nodeSetup.url, new RegExp(`^wss://${routeHost.replaceAll(".", "\\.")}/`));

  await driver.ensureNamespace(context);
  await driver.provisionHarness({ ...context, revision, requirements });
  await driver.provisionHarness({ ...context, revision, requirements });
  assert.deepEqual(await driver.harnessEndpoint({ ...context, revision, requirements }), {
    url: "ws://codex.example.test:8080/",
    workspaceRoot: "/sandbox/custom-workspace",
    codexPermissionProfile: ":danger-full-access",
  });

  assert.equal(requests.length, 1);
  assert.equal(getServiceCalls, 2);
  const [{ spec }] = requests;
  const environment = spec.environment;
  assert.equal(spec.tty, undefined);
  assert.equal(spec.template.annotations, undefined);
  assert.deepEqual(requests[0].serviceExposures, [
    { service: "", targetPort: 8080, authorizationMode: "bearer_passthrough" },
  ]);
  assert.equal(environment.APP_TOKEN_SHA, "a".repeat(64));
  assert.equal(environment.APP_SERVER_TOKEN, undefined);
  assert.equal(environment.OPENCLAW_NODE_SETUP_CODE, undefined);
  assert.equal(environment.OPENCLAW_NODE_CA_PEM, undefined);
  assert.equal(environment.HOME, "/sandbox/.openclaw-runtime/home");
  assert.equal(environment.TMPDIR, "/tmp");
  assert.equal(environment.CODEX_HOME, "/sandbox/.openclaw-runtime/home/.codex");
  assert.equal(environment.NODE_PATH, "/home/node_modules");
  assert.equal(environment.OCE_CODEX_CHATGPT_ACCOUNT, accountJson);
  const nodeStateDirectory = environment.OPENCLAW_NODE_STATE_DIR;
  assert.match(nodeStateDirectory, /^\/sandbox\/\.openclaw-mounts\/[a-f0-9]{16}\/state$/u);
  assert.equal(environment.OPENCLAW_WORKSPACE_DIR, "/sandbox/custom-workspace");
  const kubernetesDriver = spec.template.driver_config.fields.kubernetes.structValue.fields;
  const agentContainer = kubernetesDriver.containers.structValue.fields.agent.structValue.fields;
  assert.deepEqual(
    agentContainer.resources.structValue.fields.requests.structValue.fields["ephemeral-storage"],
    { stringValue: "256Mi" },
  );
  assert.deepEqual(
    agentContainer.resources.structValue.fields.limits.structValue.fields["ephemeral-storage"],
    { stringValue: "1Gi" },
  );
  const mounts = agentContainer.volume_mounts.listValue.values.map(
    ({ structValue }) => structValue,
  );
  const mountPaths = mounts.map(({ fields }) => fields.mount_path?.stringValue ?? "");
  assert.equal(mountPaths.includes("/home/node/workspace"), false);
  const runtimeMount = mounts[mountPaths.indexOf("/sandbox/.openclaw-runtime")]?.fields;
  assert.ok(runtimeMount, "OpenShell requires a writable runtime root mount.");
  assert.match(runtimeMount.sub_path.stringValue, /^openshell-runtime-[a-f0-9]{16}$/);
  assert.equal(runtimeMount.read_only.boolValue, false);
  assert.ok(mountPaths.some((path) => /^\/sandbox\/\.openclaw-mounts\/[a-f0-9]{16}$/u.test(path)));
  assert.ok(
    mounts.some(
      ({ fields }) =>
        `${fields.mount_path?.stringValue}/state` === nodeStateDirectory &&
        fields.read_only?.boolValue === false,
    ),
    "the node-state environment must name a process-owned child of its real writable PVC mount",
  );
  assert.equal(
    mountPaths.some((path) => path.startsWith("/sandbox/.openclaw-runtime/")),
    false,
  );
  const script = spec.command[RUNTIME_WRAPPER_COMMAND.length];
  assert.match(script, /\/sandbox\/\.openclaw-runtime\/home\/\.codex\/sessions/);
  assert.match(script, /\/sandbox\/\.openclaw-mounts\/[a-f0-9]{16}/);
  assert.doesNotMatch(
    script,
    /\.openclaw-node/,
    "node state must not use a symlink because OpenClaw atomically replaces files below it",
  );
  for (const path of [
    "/sandbox/.openclaw-runtime",
    "/sandbox/custom-workspace",
    "/tmp",
    "/dev/null",
  ]) {
    assert.ok(spec.policy.filesystem.read_write.includes(path), path);
  }
  assert.deepEqual(spec.policy.filesystem.read_only, [
    "/bin",
    "/usr",
    "/lib",
    "/proc",
    "/dev/urandom",
    "/etc",
    "/var/log",
    "/app",
  ]);
  assert.ok(spec.providers.includes(`oce-cs-${"b".repeat(24)}`));
  const runtimeProvider = spec.providers.find((name) => name.startsWith("oce-runtime-"));
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
  // One annotation identifies the owner and the managed content.
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
  assert.deepEqual(spec.policy.network_policies["workspace-node-enrollment"], {
    name: "workspace-node-enrollment",
    binaries: [{ path: "/usr/local/bin/node" }],
    endpoints: [
      {
        host: routeHost,
        ports: [443],
        tls: "NETWORK_TLS_MODE_SKIP",
        enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
      },
    ],
  });

  // Each turn the Gateway writes a native hook credential through Codex into the directory
  // Compute renders, which the Harness entrypoint creates under its HOME. Hook commands
  // then call the Gateway route on the host and port the node rule above admits.
  const relay = compute.gatewayNativeHookRelayConfiguration(revision, {}).plugins.entries.codex
    .config.appServer.nativeHookRelay;
  assert.equal(relay.credentialDirectory, `${environment.HOME}/.oce-native-hooks`);
  const callback = new URL(relay.url);
  const [nodeEndpoint] = spec.policy.network_policies["workspace-node-enrollment"].endpoints;
  assert.equal(callback.protocol, "https:");
  assert.equal(callback.hostname, nodeEndpoint.host);
  assert.deepEqual([Number(callback.port || 443)], nodeEndpoint.ports);

  await driver.cleanup({ ...context, revision });
  assert.equal(gatewayClient.providers.has(runtimeProvider), false);
  assert.equal(gatewayClient.profiles.has("oce-codex-runtime"), true);

  await driver.cleanup(context);
  assert.equal(gatewayClient.profiles.has("oce-codex-runtime"), false);
});

test("OpenShell holds withdrawn Codex authentication after a Harness restart", async (t) => {
  const gatewayClient = workspaceGatewayClient();
  let sandbox;
  gatewayClient.createSandbox = async (request) => {
    sandbox = {
      ...structuredClone(request),
      phase: "SANDBOX_PHASE_READY",
      serviceUrls: { "": "http://codex.example.test" },
    };
    return sandbox;
  };
  gatewayClient.getSandbox = async () => sandbox;
  const driver = new OpenShellSandboxDriver(sandboxInstallation().drivers.sandbox.configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gatewayClient),
  });
  const { context, revision, requirements } = runtimeSandboxFixture(driver);
  const compute = new KubernetesComputeDriver(
    conformanceKubernetesOptions({ gatewayTrustedProxyCidrs: ["127.0.0.1/32"] }),
    { sandboxDriver: driver },
  );
  revision.harnessAuth = {
    method: "credential_source",
    sourceId: "cs_00000000-0000-4000-8000-000000000001",
    credentialGatewayId: "openshell-credentials",
    sourceType: "codex-oauth",
    loginMode: "chatgptAuthTokens",
  };
  requirements.credentialAttachments[0] = {
    ...requirements.credentialAttachments[0],
    sourceId: revision.harnessAuth.sourceId,
    externalChatgptAuth: {
      accessTokenPlaceholder: "openshell:resolve:env:CODEX_ACCESS_TOKEN",
      accountId: "withdrawn-account",
      planType: "business",
    },
  };
  const transportToken = "withdrawn-harness-transport";
  const port = await availablePort({ host: "0.0.0.0" });
  requirements.loginMode = "chatgptAuthTokens";
  requirements.command = harnessRuntimeCommand(AGENT_RUNTIME_ENTRYPOINT);
  requirements.workspaceMounts = requirements.workspaceMounts.slice(0, 1);
  requirements.environment.push(
    { name: "CODEX_LOGIN_MODE", value: requirements.loginMode },
    ...compute.credentialSourceEnvironment(revision, requirements.credentialAttachments),
  );
  requirements.environment.find(({ name }) => name === "APP_SERVER_PORT").value = String(port);
  requirements.environment.find(({ name }) => name === "APP_TOKEN_SHA").value = createHash("sha256")
    .update(transportToken)
    .digest("hex");
  await driver.provisionHarness({ ...context, revision, requirements });

  const root = await mkdtemp(join(tmpdir(), "openshell-withdrawn-auth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, "codex");
  await mkdir(codexHome);
  const authPath = join(codexHome, "auth.json");
  const previousAuth = JSON.stringify({
    auth_mode: "chatgptAuthTokens",
    OPENAI_API_KEY: null,
    tokens: {
      access_token: "withdrawn-placeholder",
      id_token: "fixture-account-metadata",
      refresh_token: "",
      account_id: "withdrawn-account",
    },
    last_refresh: new Date().toISOString(),
  });
  await writeFile(authPath, previousAuth, { mode: 0o600 });

  // Exercise the actual Driver command and launcher. The upstream client only
  // captures provisioning. Compute supplies the normal generic placeholder, but
  // a withdrawn OpenShell provider supplies no override. Retaining that placeholder
  // in the Sandbox spec would make this real command exit before its held failure.
  // Private paths substitute for the Sandbox's writable mounts.
  const environment = {
    ...sandbox.spec.environment,
    PATH: dirname(process.execPath),
    HOME: root,
    CODEX_HOME: codexHome,
    OPENCLAW_WORKSPACE_DIR: join(root, "workspace"),
  };
  const command = ["-e", ...sandbox.spec.command.slice(RUNTIME_WRAPPER_COMMAND.length)];
  const child = spawn(process.execPath, command, {
    env: environment,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => {
    child.kill("SIGTERM");
    await exited;
  });
  const statusUrl = `http://127.0.0.1:${port}/openclaw/runtime/status`;
  const deadline = Date.now() + 5_000;
  let unauthenticated;
  // The failure log precedes the asynchronous listen callback. Wait for an actual
  // HTTP response before asserting the held endpoint's authentication behavior.
  while (unauthenticated === undefined) {
    assert.equal(
      child.exitCode,
      null,
      `Harness exited instead of holding authentication: ${errors}`,
    );
    assert.ok(Date.now() < deadline, `Harness did not expose authentication failure: ${errors}`);
    if (errors.includes("Harness model authentication probe failed.")) {
      unauthenticated = await fetch(statusUrl, {
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      }).catch(() => undefined);
    }
    if (unauthenticated === undefined) {
      await delay(20);
    }
  }
  assert.equal(unauthenticated.status, 401);
  const response = await fetch(statusUrl, {
    headers: { Authorization: `Bearer ${transportToken}` },
  });
  assert.equal(response.status, 200);
  const { runtimeFailure } = await response.json();
  assert.equal(runtimeFailure.component, "agent");
  assert.equal(runtimeFailure.check, "login");
  assert.equal(runtimeFailure.code, "AUTHENTICATION_FAILED");
  assert.equal(sandbox.spec.environment.CODEX_ACCESS_TOKEN, undefined);
  assert.deepEqual(JSON.parse(sandbox.spec.environment.OCE_CODEX_CHATGPT_ACCOUNT), {
    accountId: "withdrawn-account",
    planType: "business",
  });
  assert.equal(
    child.exitCode,
    null,
    "A withdrawal must hold the Harness, not restart its canonical process.",
  );
  assert.equal(
    await readFile(authPath, "utf8"),
    previousAuth,
    "Cached authentication must not be rewritten or used.",
  );
  assert.doesNotMatch(
    errors,
    /codex\.model_probe|withdrawn-placeholder|withdrawn-harness-transport/,
  );

  // Only absent material is recoverable by holding. A supplied unbound alias
  // or invalid account metadata remains an explicit startup configuration error.
  for (const [invalid, expected] of [
    [
      { CODEX_ACCESS_TOKEN: "openshell:resolve:env:CODEX_ACCESS_TOKEN" },
      /refresh-managed credential binding/,
    ],
    [
      {
        CODEX_ACCESS_TOKEN: `openshell:resolve:env:s${"1".repeat(64)}_CODEX_ACCESS_TOKEN`,
        OCE_CODEX_CHATGPT_ACCOUNT: "{}",
      },
      /account metadata is unavailable/,
    ],
  ]) {
    const rejected = spawnSync(process.execPath, command, {
      env: { ...environment, ...invalid },
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, expected);
    assert.equal(await readFile(authPath, "utf8"), previousAuth);
  }
});

for (const harnessId of ["codex", "openclaw"]) {
  test(`OpenShell delivers ${harnessId} initial workspace files privately after supervisor readiness`, async (t) => {
    const gatewayClient = workspaceGatewayClient();
    const driver = new OpenShellSandboxDriver(sandboxInstallation().drivers.sandbox.configuration, {
      id: "openshell-sandbox",
      implementation: "openshell",
      backend: backendFor(gatewayClient),
    });
    const { context, revision, requirements, prepared } = runtimeSandboxFixture(driver, {
      harnessId,
    });
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
        serviceUrls: harnessId === "codex" ? { "": "http://codex.example.test" } : {},
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
    assert.equal(prepared.length, harnessId === "openclaw" ? 1 : 0);
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
    // A refusal (the runner's exit status 2) repeats on every retry, so Compute fails the
    // deployment at once with WORKSPACE_SETUP_REFUSED (finding 1708).
    exitCode = 2;
    await assert.rejects(provision(), (error) => {
      assert.ok(error instanceof SandboxWorkspaceSetupRefusedError, String(error));
      assert.equal(error.code, "WORKSPACE_SETUP_REFUSED");
      assert.equal(error.message, "OpenShell workspace initialization refused.");
      return true;
    });
    foreign = true;
    const before = executions.length;
    await assert.rejects(provision(), /workspace initialization failed/);
    assert.equal(executions.length, before);

    await t.test("the setup wrapper passes the runner's refusal status through", async (t) => {
      const root = await mkdtemp(join(tmpdir(), "openshell-workspace-wrapper-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const workspace = join(root, "workspace");
      await mkdir(workspace);
      const wrapped = (payload, environment = {}) =>
        spawnSync(process.execPath, ["-e", execution.command[2]], {
          input: JSON.stringify(payload),
          encoding: "utf8",
          timeout: 60_000,
          env: {
            ...process.env,
            HOME: root,
            OPENCLAW_STATE_DIR: join(root, "state"),
            OPENCLAW_WORKSPACE_DIR: workspace,
            OPENCLAW_EXECUTABLE: join(root, "absent-runtime.mjs"),
            ...environment,
          },
        }).status;
      // A completed setup whose workspace has no record refuses on every retry.
      const { files: _files, ...record } = setup;
      assert.equal(wrapped({ ...record, completed: true }), 2);
      // A missing runtime may be back on a retry; a workspace path the wrapper rejects exits 1.
      assert.equal(wrapped(setup), 1);
      assert.equal(wrapped(setup, { OPENCLAW_WORKSPACE_DIR: "relative" }), 1);
    });

    if (harnessId === "codex") {
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
          assert.equal(
            await readFile(join(workspace, "AGENTS.md"), "utf8"),
            setup.files["AGENTS.md"],
          );
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
    }
  });
}

test("OpenShell retains the revision provider when Sandbox creation has an unknown outcome", async () => {
  let sandboxCreates = 0;
  const gatewayClient = workspaceGatewayClient();
  gatewayClient.createSandbox = async (request) => {
    sandboxCreates++;
    if (sandboxCreates === 1) {
      throw new Error("CreateSandbox deadline exceeded");
    }
    return storedSandbox(request, { serviceUrls: { "": "http://codex.example.test" } });
  };
  const driver = new OpenShellSandboxDriver(sandboxInstallation().drivers.sandbox.configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gatewayClient),
  });
  const { context, revision, requirements } = runtimeSandboxFixture(driver);

  await assert.rejects(
    driver.provisionHarness({ ...context, revision, requirements }),
    /deadline exceeded/,
  );
  const [runtimeProvider] = [...gatewayClient.providers.keys()];
  assert.match(runtimeProvider, /^oce-runtime-/);

  await driver.provisionHarness({ ...context, revision, requirements });

  assert.equal(sandboxCreates, 2);
  assert.equal(callCount(gatewayClient, "createProvider"), 1);
  assert.equal(callCount(gatewayClient, "updateProviderCredentials"), 0);
  assert.equal(gatewayClient.providers.has(runtimeProvider), true);
});

for (const harnessId of ["codex", "openclaw"]) {
  test(`OpenShell reconciles renewed ${harnessId} workspace-node setup into its revision provider`, async () => {
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
      return {
        ...storedSandbox,
        serviceUrls: harnessId === "codex" ? { "": "http://codex.example.test:8080/" } : {},
      };
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
    const { context, revision, requirements } = runtimeSandboxFixture(driver, { harnessId });
    const provision = () => driver.provisionHarness({ ...context, revision, requirements });

    await provision();
    const [runtimeProviderName] = [...gatewayClient.providers.keys()];
    const initialProvider = gatewayClient.providers.get(runtimeProviderName);
    assert.ok(initialProvider, "the Harness must receive a revision-owned enrollment provider");
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
    const updates = gatewayClient.calls.filter(
      ([operation]) => operation === "updateProviderConfig",
    );
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
      config: { ...renewedProvider.config, node_ca_pem: "foreign-ca" },
    });
    await assert.rejects(provision(), /without exact AgentRevision ownership and content/);
    assert.equal(
      gatewayClient.calls.filter(([operation]) => operation === "updateProviderConfig").length,
      1,
    );
  });
}

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
  const { context, revision, requirements } = runtimeSandboxFixture(driver);

  await driver.provisionHarness({ ...context, revision, requirements });
  await assert.rejects(
    driver.provisionHarness({ ...context, revision, requirements }),
    /without exact AgentRevision ownership and content/,
  );
});

for (const harnessId of ["codex", "openclaw"]) {
  test(`OpenShell rejects malformed or expired ${harnessId} node setup before gateway mutation`, async (t) => {
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
        const { context, revision, requirements } = runtimeSandboxFixture(driver, { harnessId });
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
}

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
      const fixture = runtimeSandboxFixture(driver, scenario.fixture);
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
  const driver = openShellDriver(gatewayClient);
  const context = namespaceContext();

  // A retry must adopt the same owned Workspace instead of creating a second boundary.
  await driver.ensureNamespace(context);
  await driver.ensureNamespace(context);
  assert.deepEqual(
    gatewayClient.workspaces.get(context.namespace.name),
    ownedWorkspace(context.namespace.name, context.namespace.id),
  );
  assert.equal(callCount(gatewayClient, "createWorkspace"), 1);

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
    { apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "openshell-sandbox" } },
  ];
  const gatewayClient = workspaceGatewayClient([], events);
  const driver = openShellDriver(gatewayClient, configuration);
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
    { apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "must-not-be-applied" } },
  ];
  const gatewayClient = workspaceGatewayClient();
  const driver = openShellDriver(gatewayClient, configuration);
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
    ownedWorkspace(context.namespace.name, "ns_foreign"),
  ]);

  await assert.rejects(
    openShellDriver(gatewayClient).cleanup(context),
    /without exact OCC Namespace ownership/,
  );
  assert.equal(gatewayClient.workspaces.has(context.namespace.name), true);
  assert.equal(callCount(gatewayClient, "deleteWorkspace"), 0);
});

// OpenShell answers a controller identity it cannot authenticate (UNAUTHENTICATED) or that lacks
// a permission (PERMISSION_DENIED) with a gRPC status the gateway client passes through raw. Read
// as an HTTP status, it was retryable and logged "HTTP status 7" (finding 1390): the Namespace
// work spent its attempts on a refusal only an operator can fix. The OpenShell Sandbox Driver now
// names the refusal, and Compute fails the Namespace step at once with that reason.
test("OpenShell Namespace steps fail at once when OpenShell refuses the controller identity", async () => {
  const grpc = controllerRequire("@grpc/grpc-js");
  // The grpc-js error shape unary() rejects with for these codes.
  const grpcError = (name, details) =>
    Object.assign(new Error(`${grpc.status[name]} ${name}: ${details}`), {
      code: grpc.status[name],
      details,
      metadata: new grpc.Metadata(),
    });
  // A gateway whose `step` throws `error`, over an owned Workspace for `namespace` if given.
  const failing = (step, error, namespace) => {
    const seed = namespace === undefined ? [] : [ownedWorkspace(namespace.name, namespace.id)];
    const gatewayClient = workspaceGatewayClient(seed);
    gatewayClient[step] = async () => {
      throw error;
    };
    return gatewayClient;
  };
  const refusal = (name) => `OpenShell refused the controller gateway identity with gRPC ${name}.`;
  const keeps = (error, message) => (thrown) => {
    assert.equal(thrown, error, message);
    return true;
  };

  for (const [step, name] of [
    ["health", "UNAUTHENTICATED"],
    ["createWorkspace", "PERMISSION_DENIED"],
  ]) {
    const raw = grpcError(name, "refused");
    await assert.rejects(openShellDriver(failing(step, raw)).ensureNamespace(namespaceContext()), {
      name: "SandboxNamespaceRefusedError",
      message: refusal(name),
      cause: raw,
    });
  }
  {
    const context = namespaceContext();
    const denied = grpcError("PERMISSION_DENIED", "workspace:delete");
    await assert.rejects(
      openShellDriver(failing("deleteWorkspace", denied, context.namespace)).cleanup(context),
      { name: "SandboxNamespaceRefusedError", message: refusal("PERMISSION_DENIED") },
    );
  }
  // Revision cleanup is not a Namespace step: a refusal there fails closed with the revision
  // code SANDBOX_GATEWAY_UNAUTHORIZED (finding 1676), and a non-identity error keeps its class.
  {
    const raw = grpcError("PERMISSION_DENIED", "sandbox:delete");
    const gatewayClient = failing("deleteSandbox", raw);
    gatewayClient.getSandbox = async () => sandboxRecord("sb-present", "oce-present");
    const driver = openShellDriver(gatewayClient);
    const { context, revision } = runtimeSandboxFixture(driver);
    await assert.rejects(driver.cleanup({ ...context, revision }), (error) => {
      assert.ok(error instanceof SandboxGatewayUnauthorizedError, String(error));
      assert.equal(error.code, "SANDBOX_GATEWAY_UNAUTHORIZED");
      assert.equal(error.cause, raw);
      return true;
    });
    const busy = grpcError("RESOURCE_EXHAUSTED", "rate limit");
    gatewayClient.deleteSandbox = async () => {
      throw busy;
    };
    await assert.rejects(driver.cleanup({ ...context, revision }), keeps(busy));
  }
  // Other passed-through codes keep their error: FAILED_PRECONDITION names a Workspace state and
  // RESOURCE_EXHAUSTED a rate limit or busy admission workers, neither of them the identity.
  for (const name of ["FAILED_PRECONDITION", "RESOURCE_EXHAUSTED"]) {
    const passedThrough = grpcError(name, "not an identity refusal");
    const gatewayClient = failing("createWorkspace", passedThrough);
    await assert.rejects(
      openShellDriver(gatewayClient).ensureNamespace(namespaceContext()),
      keeps(passedThrough, name),
    );
  }
  // A Workspace removed between Namespace cleanup's read and its provider listing answers
  // NOT_FOUND. Cleanup keeps that error: it names a missing Workspace, not the identity.
  {
    const context = namespaceContext();
    const missing = grpcError("NOT_FOUND", "workspace not found");
    const gatewayClient = failing("listProviders", missing, context.namespace);
    await assert.rejects(openShellDriver(gatewayClient).cleanup(context), keeps(missing));
  }

  // Through Compute: the Kubernetes steps before the Sandbox Driver are stubbed, so the
  // Namespace result comes from Compute's own classification of what the Sandbox Driver threw.
  const tenant = namespaceContext().namespace;
  const placement = { name: tenant.name, plane: "execution" };
  const compute = (gatewayClient) => {
    const driver = new KubernetesComputeDriver(
      conformanceKubernetesOptions({ gatewayTrustedProxyCidrs: ["10.42.0.0/16"] }),
      { sandboxDriver: openShellDriver(gatewayClient) },
    );
    const observed = {
      metadata: { name: tenant.name, uid: "namespace-uid", labels: {}, annotations: {} },
      status: { phase: "Active" },
    };
    Object.assign(driver, {
      apiClients: Promise.resolve({ objects: kubernetesObjectClient([]) }),
      resolveNamespace: async () => ({ name: placement, external: false }),
      reconcile: async () => {},
      getNamespace: async () => structuredClone(observed),
      verifyNamespaceOwnership: () => {},
      prepareNamespaceInfrastructure: async () => {},
      ensureGatewayNamespace: async () => true,
    });
    return driver;
  };
  // A refused identity fails at once. A refusal Compute cannot classify stays retryable, with a
  // fixed reason and no "HTTP status 9" or "HTTP status 8": a rate limit clears by itself.
  for (const [name, failure, reason] of [
    ["PERMISSION_DENIED", "permanent", refusal("PERMISSION_DENIED")],
    ["UNAUTHENTICATED", "permanent", refusal("UNAUTHENTICATED")],
    ["FAILED_PRECONDITION", "retryable", "Namespace preparation failed."],
    ["RESOURCE_EXHAUSTED", "retryable", "Namespace preparation failed."],
  ]) {
    const gatewayClient = failing("createWorkspace", grpcError(name, "workspace:create"));
    assert.deepEqual(await compute(gatewayClient).ensureNamespace(tenant), {
      namespaceId: tenant.id,
      namespaceReady: false,
      failure,
      reason,
    });
  }
  // Namespace deletion fails at once too, and keeps the Kubernetes namespace.
  const expired = grpcError("UNAUTHENTICATED", "token expired");
  const deleting = compute(failing("deleteWorkspace", expired, tenant));
  deleting.deleteGatewayNamespace = async () => assert.fail("cleanup must fail first");
  assert.deepEqual(await deleting.deleteNamespace({ ...tenant, status: "deleting" }), {
    namespaceId: tenant.id,
    namespaceDeleted: false,
    failure: "permanent",
  });
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

  await assert.rejects(loadInstallationFile(t, configuration, options), (error) => {
    assert.ok(error instanceof SharedConfigurationValidationError);
    assert.deepEqual(
      error.error.details,
      structuralRefusal("", "additionalProperties", "UNKNOWN_FIELD"),
    );
    return true;
  });
  assert.equal(invokedFactory, false);
  // Control: the same factory is reached once the configuration is valid.
  await assert.rejects(loadInstallationFile(t, sandboxInstallation(), options), /injected factory/);
  assert.equal(invokedFactory, true);
});

// Each test below changes settings of a valid installation, and startup refuses each change.
const TLS_MODE = structuralRefusal("/policy/networkPolicies/0/endpoints/0/tls", "enum");
const LANDLOCK = structuralRefusal("/policy/landlockCompatibility", "const");

const sandboxOf = (c) => c.drivers.sandbox.configuration;
const policiesOf = (c) => sandboxOf(c).policy.networkPolicies;
const endpointOf = (c) => policiesOf(c)[0].endpoints[0];
const readinessWait = {
  serviceName: "openshell-gateway",
  podSelector: { "app.kubernetes.io/name": "openshell" },
};

test("startup rejects OpenShell network values outside the v0.1 protocol enums", (t) =>
  rejectsAtStartup(t, (c) => (endpointOf(c).tls = "inspect"), TLS_MODE));

test("startup refuses OpenShell filesystem modes that can weaken containment", async (t) => {
  for (const mode of ["best_effort", "hard-requirement"]) {
    await rejectsAtStartup(t, (c) => (sandboxOf(c).policy.landlockCompatibility = mode), LANDLOCK);
  }
});

test("startup rejects OpenShell network policies without binary identities", (t) =>
  rejectsAtStartup(
    t,
    (c) => (policiesOf(c)[0].binaries = []),
    structuralRefusal("/policy/networkPolicies/0/binaries", "minItems"),
  ));

test("startup rejects duplicate OpenShell network policy names", async (t) => {
  for (const [name, expected] of [
    [
      "model-egress",
      [
        {
          path: "/policy/networkPolicies/1/name",
          code: "INVALID_VALUE",
          message: "Network policy names must be unique.",
        },
      ],
    ],
    [
      "workspace-node-enrollment",
      [
        {
          path: "/policy/networkPolicies/1/name",
          code: "INVALID_VALUE",
          message: "This policy name is reserved for platform networking.",
        },
      ],
    ],
  ]) {
    await rejectsAtStartup(t, (c) => policiesOf(c).push({ ...policiesOf(c)[0], name }), expected);
  }
});

test("startup rejects inherited OpenShell network enum property names", async (t) => {
  for (const [field, value] of [
    ["tls", "toString"],
    ["enforcement", "constructor"],
    ["access", "__proto__"],
  ]) {
    await rejectsAtStartup(
      t,
      (c) => (endpointOf(c)[field] = value),
      structuralRefusal(`/policy/networkPolicies/0/endpoints/0/${field}`, "enum"),
    );
  }
});

test("startup rejects the deprecated OpenShell passthrough spelling", (t) =>
  rejectsAtStartup(t, (c) => (endpointOf(c).tls = "passthrough"), TLS_MODE));

test("startup rejects the removed per-Sandbox OpenShell ServiceAccount mode", (t) =>
  rejectsAtStartup(
    t,
    (c) => (sandboxOf(c).kubernetes.serviceAccount.mode = "driverConfig"),
    structuralRefusal("/kubernetes/serviceAccount/mode", "const"),
  ));

test("startup rejects an invalid OpenShell gateway readiness wait", async (t) => {
  for (const [readiness, expected] of [
    [
      { ...readinessWait, timeoutMs: 0 },
      structuralRefusal("/gateway/readiness/timeoutMs", "minimum"),
    ],
    [
      { ...readinessWait },
      [
        {
          path: "/gateway/readiness/timeoutMs",
          code: "REQUIRED",
          message: "This configuration field is required.",
        },
      ],
    ],
  ]) {
    await rejectsAtStartup(t, (c) => (sandboxOf(c).gateway.readiness = readiness), expected);
  }
});

test("shipped startup names a rejected OpenShell policy without logging its name", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "occ-policy-name-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const template = sandboxInstallation().drivers.sandbox.configuration.policy.networkPolicies[0];
  const planted = "planted-policy-token";

  function start(policies) {
    const configuration = sandboxInstallation();
    configuration.drivers.sandbox.configuration.policy.networkPolicies = policies;
    const path = join(directory, "installation.yaml");
    return writeFile(path, JSON.stringify(configuration), "utf8").then(() =>
      spawnSync(process.execPath, ["apps/controller/src/server.mjs"], {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "development",
          OCC_HOST: "127.0.0.1",
          OCC_PORT: "18081",
          OCC_CONFIG_PATH: path,
        },
        encoding: "utf8",
        timeout: 20_000,
      }),
    );
  }

  function diagnostic(server) {
    assert.equal(server.status, 1, server.stderr);
    const event = server.stderr
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line))
      .find((line) => line.event === "startup-error");
    assert.ok(event, server.stderr);
    return event;
  }

  const duplicate = await start([
    { ...template, name: planted },
    { ...template, name: planted },
  ]);
  const duplicateEvent = diagnostic(duplicate);
  assert.equal(duplicateEvent.code, "DRIVER_CONFIGURATION_INVALID");
  assert.deepEqual(duplicateEvent.details, [
    {
      path: "/policy/networkPolicies/1/name",
      code: "INVALID_VALUE",
      message: "Network policy names must be unique.",
    },
  ]);
  assert.equal(duplicateEvent.reason, undefined);
  assert.equal(`${duplicate.stdout}${duplicate.stderr}`.includes(planted), false);

  const reserved = await start([
    { ...template, name: "model-egress" },
    { ...template, name: "workspace-node-enrollment" },
  ]);
  const reservedEvent = diagnostic(reserved);
  assert.equal(reservedEvent.code, "DRIVER_CONFIGURATION_INVALID");
  assert.deepEqual(reservedEvent.details, [
    {
      path: "/policy/networkPolicies/1/name",
      code: "INVALID_VALUE",
      message: "This policy name is reserved for platform networking.",
    },
  ]);
  assert.equal(reservedEvent.reason, undefined);
  assert.equal(`${reserved.stdout}${reserved.stderr}`.includes("workspace-node-enrollment"), false);
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
      // Pinned OpenShell imports use MustCreate; they cannot overwrite a collision.
      if (profiles.has(profile.id)) {
        throw new Error("provider profile already exists");
      }
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
          client: { clientForNamespace: () => client, placement: () => undefined },
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
    // Main stored only the digest annotation; provider ownership and profile content stay.
    unmark: (id) => {
      const { annotations } = profiles.get(id);
      const digest = { "openclaw.dev/profile-digest": annotations["openclaw.dev/profile-digest"] };
      profiles.set(id, { ...profiles.get(id), annotations: digest });
      return profiles.get(id);
    },
  };
}

async function ready(operation) {
  assert.deepEqual(await operation, { state: "ready" });
}

test("Codex PAT profiles admit native startup without granting the whole backend", async () => {
  const { context, driver, profiles } = credentialGatewayOverProviders();
  const source = context("cs_00000000-0000-4000-8000-0000000000c1");
  await driver.registerSource(
    { ...source, source: { ...source.source, type: "codex-pat" } },
    { type: "codex-pat", config: {}, secrets: { access_token: "synthetic-codex-pat" } },
  );
  const [profile] = profiles.values();
  // These are the pinned Codex dependency's startup, turn and usage-recovery routes. A broader backend
  // or WHAM wildcard would release this credential to unrelated account APIs.
  assert.deepEqual(profile.endpoints, [
    {
      host: "auth.openai.com",
      port: 443,
      protocol: "rest",
      path: "/api/accounts/v1/user-auth-credential/whoami",
    },
    { host: "chatgpt.com", port: 443, protocol: "rest", path: "/backend-api/codex/**" },
    { host: "chatgpt.com", port: 443, protocol: "rest", path: "/backend-api/wham/config/bundle" },
    { host: "chatgpt.com", port: 443, protocol: "rest", path: "/backend-api/wham/accounts/check" },
    { host: "chatgpt.com", port: 443, protocol: "rest", path: "/backend-api/wham/settings/user" },
    { host: "chatgpt.com", port: 443, protocol: "rest", path: "/backend-api/wham/usage" },
  ]);
  assert.deepEqual(profile.binaries, ["/usr/local/bin/codex"]);
});

test("each Codex PAT source gets its own provider profile, stable across replays", async () => {
  const { context, driver, profileWrites, profiles, providers } = credentialGatewayOverProviders();
  const register = (id) => {
    const owner = context(id);
    return driver.registerSource(
      { ...owner, source: { ...owner.source, type: "codex-pat" } },
      { type: "codex-pat", config: {}, secrets: { access_token: `synthetic-pat-${id}` } },
    );
  };
  const sources = [
    "cs_00000000-0000-4000-8000-0000000000c2",
    "cs_00000000-0000-4000-8000-0000000000c3",
  ];
  for (const id of sources) {
    await ready(register(id));
  }
  // Each provider's type names a profile of its own, so one PAT's routes never bind another's.
  const profileIds = sources.map((id) => {
    const provider = [...providers.values()].find(
      ({ labels }) => labels["openclaw.dev/credential-source-id"] === id,
    );
    assert.equal(profiles.get(provider.type)?.id, provider.name, id);
    return provider.type;
  });
  // Exactly two profiles: no source shares a profile with the other.
  assert.deepEqual([...profiles.keys()].sort(), [...profileIds].sort());
  // Replaying a source's registration reuses its profile instead of minting another.
  profileWrites.length = 0;
  await ready(register(sources[0]));
  assert.equal(providers.size, 2);
  assert.deepEqual([...profiles.keys()].sort(), [...profileIds].sort());
  assert.deepEqual(profileWrites, []);
});

test("the OpenShell Credential Gateway acts only on its own source's provider", async () => {
  const {
    calls,
    context,
    driver,
    input,
    profiles,
    profileWrites,
    providers,
    revisionContext,
    source,
  } = credentialGatewayOverProviders();
  const owner = "cs_00000000-0000-4000-8000-0000000000b1";
  const other = "cs_00000000-0000-4000-8000-0000000000b2";
  await ready(driver.registerSource(context(owner), input()));
  const [stored] = providers.values();
  assert.equal(stored.labels["openclaw.dev/credential-source-id"], owner);
  // Another source's provider stored under this source's name: same manager and type, other id.
  providers.set(stored.name, {
    ...stored,
    labels: { ...stored.labels, "openclaw.dev/credential-source-id": other },
  });
  // The colliding profile differs from the requested endpoint, so reconciliation would write.
  const foreignProfile = {
    ...profiles.get(stored.name),
    endpoints: [{ host: "foreign.example.test", port: 443, path: "/v1/**", protocol: "rest" }],
    annotations: { "openclaw.dev/profile-digest": "foreign-digest" },
  };
  profiles.set(stored.name, structuredClone(foreignProfile));
  calls.length = 0;
  profileWrites.length = 0;
  const requested = { ...input(), config: { base_url: "https://requested.example.test/v1" } };
  await assert.rejects(driver.registerSource(context(owner), requested), ScopeViolationError);
  assert.deepEqual(
    profiles.get(stored.name),
    foreignProfile,
    "foreign profile contents and version stay unchanged",
  );
  assert.deepEqual(profileWrites, []);
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
  // Ownership refusal happens before any provider or profile mutation.
  assert.deepEqual(calls, []);
  assert.deepEqual(providers.get(stored.name).credentials, stored.credentials);
});

test("OpenShell preserves the main-era owned profile lifecycle without a migration", async () => {
  const f = credentialGatewayOverProviders();
  const context = f.context("cs_main-era");
  const otherContext = f.context("cs_main-era-other");
  for (const owner of [context, otherContext]) {
    await f.driver.registerSource(owner, f.input("original-key"));
  }
  [...f.profiles.keys()].forEach(f.unmark);
  const [provider, otherProvider] = f.providers.values();
  const original = structuredClone(f.profiles.get(provider.name));
  const otherProfile = structuredClone(f.profiles.get(otherProvider.name));
  f.profileWrites.length = 0;
  const restarted = f.driverWith();
  await ready(restarted.sourceStatus(context));
  assert.deepEqual(await restarted.attachForRevision(f.revisionContext([context.source])), [
    { sourceId: context.source.id, ref: provider.name },
  ]);
  await ready(restarted.updateSource(context, f.input("rotated-key")));
  await ready(f.driverWith().registerSource(context, f.input("replay-key")));
  assert.equal(f.providers.get(provider.name).credentials.OPENAI_API_KEY, "rotated-key");
  assert.deepEqual(f.profiles.get(provider.name), original);
  assert.deepEqual(f.profileWrites, [], "unchanged main-era profiles need no marker-only write");

  // A normal binary-policy change reconciles the owned profile using its resource version.
  const narrowed = f.driverWith({ binaries: ["/opt/codex"] });
  await narrowed.attachForRevision(f.revisionContext([context.source]));
  assert.deepEqual(f.profiles.get(provider.name).binaries, ["/opt/codex"]);
  assert.notEqual(f.profiles.get(provider.name).resourceVersion, original.resourceVersion);
  assert.deepEqual(f.profiles.get(otherProvider.name), otherProfile);
  assert.deepEqual(f.providers.get(otherProvider.name), otherProvider);
  await narrowed.removeSource(context);
  assert.equal(f.providers.has(provider.name), false);
  assert.equal(f.profiles.has(provider.name), false);
  assert.deepEqual(f.profiles.get(otherProvider.name), otherProfile);

  // Deletion also works directly on an unmarked profile, without a prior reconciliation.
  await f.driverWith().removeSource(otherContext);
  await f.driverWith().removeSource(otherContext);
  assert.equal(f.providers.size, 0);
  assert.equal(f.profiles.size, 0);
});

test("OpenShell main-era interrupted registration survives restart without replaying credentials", async () => {
  const f = credentialGatewayOverProviders();
  const context = f.context("cs_owned-retry");
  const create = f.client.createProvider;
  const unavailable = new Error("create provider unavailable");
  f.client.createProvider = async () => {
    throw unavailable;
  };
  // The import succeeded but provider creation did not. Main can resume without new annotations.
  await assert.rejects(
    f.driver.registerSource(context, f.input()),
    (error) => error === unavailable,
  );
  assert.equal(f.profiles.size, 1);
  assert.equal(f.providers.size, 0);
  [...f.profiles.keys()].forEach(f.unmark);
  f.client.createProvider = create;
  f.profileWrites.length = 0;
  const restarted = f.driverWith();
  await ready(restarted.registerSource(context, f.input("first-key")));
  await ready(restarted.registerSource(context, f.input("retry-key")));
  assert.deepEqual(f.profileWrites, []);
  const [provider] = f.providers.values();
  assert.equal(provider.credentials.OPENAI_API_KEY, "first-key");
  // Owned reconciliation still applies new binary configuration through registration.
  await f.driverWith({ binaries: ["/opt/codex"] }).registerSource(context, f.input("retry-key"));
  assert.deepEqual(f.profiles.get(provider.name).binaries, ["/opt/codex"]);
  assert.equal(f.providers.get(provider.name).credentials.OPENAI_API_KEY, "first-key");
  // Legacy cleanup can remove this orphan, and repeated deletion stays idempotent.
  f.providers.delete(provider.name);
  await restarted.removeSource(context);
  await restarted.removeSource(context);
  assert.equal(f.profiles.size, 0);
});

test("OpenShell main-era cleanup resumes after provider deletion without losing another source", async () => {
  const f = credentialGatewayOverProviders();
  const context = f.context("cs_interrupted-delete");
  const other = f.context("cs_delete-survivor");
  await f.driver.registerSource(context, f.input());
  await f.driver.registerSource(other, f.input("other-key"));
  const [provider, survivor] = f.providers.values();
  const unmarked = f.unmark(provider.name);
  const survivorProfile = structuredClone(f.profiles.get(survivor.name));
  const deleteProfile = f.client.deleteProviderProfile;
  const crash = new Error("controller stopped before deleting profile");
  f.client.deleteProviderProfile = async () => {
    throw crash;
  };
  // Provider deletion has committed when the process loses the profile deletion attempt.
  await assert.rejects(f.driver.removeSource(context), (error) => error === crash);
  assert.equal(f.providers.has(provider.name), false);
  assert.deepEqual(f.profiles.get(provider.name), unmarked);
  f.client.deleteProviderProfile = deleteProfile;
  await f.driverWith().removeSource(context);
  assert.equal(f.profiles.has(provider.name), false);
  assert.deepEqual(f.providers.get(survivor.name), survivor);
  assert.deepEqual(f.profiles.get(survivor.name), survivorProfile);
});

test("OpenShell concurrent registrations preserve the first provider's credentials", async () => {
  const f = credentialGatewayOverProviders();
  const context = f.context("cs_concurrent-registration");
  const read = f.client.getProviderProfile;
  // Both registrations observe profile absence. Import's create-only contract refuses
  // the stale writer; readback recognizes the already stored configuration.
  f.client.getProviderProfile = async (...args) => {
    const stale = await read(...args);
    f.client.getProviderProfile = read;
    await f.driverWith().registerSource(context, f.input("winner-key"));
    return stale;
  };
  await ready(f.driver.registerSource(context, f.input("retry-key")));
  assert.equal(f.providers.size, 1);
  assert.equal(f.profiles.size, 1);
  assert.equal([...f.providers.values()][0].credentials.OPENAI_API_KEY, "winner-key");
});

test("OpenShell rejects a foreign provider appearing after preflight without erasing the profile", async () => {
  const f = credentialGatewayOverProviders();
  const context = f.context("cs_provider-race");
  const create = f.client.createProvider;
  let foreign;
  f.client.createProvider = async (provider) => {
    // Separate RPCs leave a window after profile import. The final duplicate check is required.
    foreign = {
      ...provider,
      labels: { ...provider.labels, "openclaw.dev/credential-source-id": "cs_other" },
    };
    f.providers.set(provider.name, foreign);
    return create(provider);
  };
  await assert.rejects(f.driver.registerSource(context, f.input()), ScopeViolationError);
  await assert.rejects(f.driver.removeSource(context), ScopeViolationError);
  assert.deepEqual([...f.providers.values()], [foreign]);
  assert.equal(f.profiles.size, 1, "a separate profile import cannot be rolled back atomically");
  assert.deepEqual(f.deletedProfiles, []);
});

test("OpenShell registration does not adopt an unknown provider create outcome", async () => {
  const f = credentialGatewayOverProviders();
  const context = f.context("cs_unknown-create");
  const create = f.client.createProvider;
  const failure = new Error("transport lost after provider create");
  f.client.createProvider = async (provider) => {
    await create(provider);
    throw failure;
  };
  // Even a persisted owned provider cannot turn an unknown create outcome into success.
  await assert.rejects(f.driver.registerSource(context, f.input()), (error) => error === failure);
  assert.equal(f.providers.size, 1);
  assert.equal(f.calls.length, 1);
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
    ["openai", "codex-pat"],
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
    (error) => {
      assert.ok(error instanceof SharedConfigurationValidationError);
      assert.deepEqual(
        error.error.details,
        structuralRefusal("/toolBinaries/0", "pattern", "INVALID_FORMAT"),
      );
      return true;
    },
  );

  const { calls, context, deletedProfiles, driver, input, profiles, providers } =
    credentialGatewayOverProviders({ toolBinaries: ["/usr/bin/curl"] });
  assert.deepEqual(
    (await driver.listSourceTypes({})).map(({ type }) => type),
    ["openai", "codex-pat", "bearer-token"],
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
      CredentialSourceConfigError,
      JSON.stringify(config),
    );
  }
  assert.deepEqual(calls, []);
  assert.equal(profiles.size, 0);

  // Each bearer-token source owns a profile that only the tool binaries may use, at its endpoint.
  const first = "cs_00000000-0000-4000-8000-0000000000f2";
  const second = "cs_00000000-0000-4000-8000-0000000000f3";
  await ready(driver.registerSource(context(first), tokenInput(endpoint)));
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
  // A model source owns its profile too, limited to the Harness binaries.
  const profileOf = (sourceId) =>
    profiles.get(
      [...providers.values()].find(
        ({ labels }) => labels["openclaw.dev/credential-source-id"] === sourceId,
      )?.type,
    );
  const model = "cs_00000000-0000-4000-8000-0000000000f4";
  await driver.registerSource(context(model), input());
  assert.equal(profileOf(model).inferenceCapable, true);
  assert.deepEqual(profileOf(model).binaries, ["/usr/local/bin/codex"]);
  assert.equal(profiles.has("oce-openai"), false, "no profile is shared between sources");

  // Two sources on one revision cannot share a placeholder variable.
  await driver.registerSource(context(second), tokenInput(endpoint));
  const bearer = (id) => ({ ...context(id).source, type: "bearer-token", config: endpoint });
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
  // Removing one model source removes only its profile; the other model source keeps its own.
  const secondModel = "cs_00000000-0000-4000-8000-0000000000f5";
  await driver.registerSource(context(secondModel), input());
  const modelProfile = profileOf(model).id;
  const secondModelProfile = profileOf(secondModel).id;
  assert.notEqual(modelProfile, secondModelProfile);
  await driver.removeSource(context(model));
  assert.deepEqual(deletedProfiles, [provider.name, modelProfile]);
  assert.equal(profiles.has(secondModelProfile), true);
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
  const register = (driver, source) =>
    ready(driver.registerSource(sourceContext(source), input(source)));
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
  await ready(narrowed.updateSource(sourceContext(updated), input(updated, "n3w")));
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

  // A model source's profile follows the Harness binaries the same way.
  const model = "cs_00000000-0000-4000-8000-000000000103";
  await narrowed.registerSource(gateway.context(model), gateway.input());
  const retargeted = driverWith({
    binaries: ["/opt/codex/bin/codex"],
    toolBinaries: ["/usr/bin/curl"],
  });
  await retargeted.attachForRevision(revisionContext([gateway.source(model)]));
  assert.deepEqual(profileOf(gateway.source(model)).binaries, ["/opt/codex/bin/codex"]);
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
  const { context, revision, requirements } = runtimeSandboxFixture(driver);
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

  // A held failure answers the upgrade 503; it is returned unvalidated for Compute.
  const runtimeFailure = {
    component: "agent",
    check: "model-probe",
    checkedAt: "2026-10-08T13:00:00.000Z",
    code: "MODEL_PROBE_FAILED",
  };
  document = { status: 200, json: { runtimeFailure } };
  observed.length = 0;
  assert.deepEqual(await driver.harnessStatus(statusContext), { state: "failed", runtimeFailure });
  assert.equal(observed.length, 3);
  // Only a 200 status document with a runtime failure counts; anything else is starting.
  for (const other of [
    { status: 404, json: { runtimeFailure } },
    { status: 503, json: { runtimeFailure } },
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
  // A dedicated OpenClaw worker (finding 1642) is observed through the same exposure, with
  // the same exactness: wrong port or a missing service fail closed.
  const nativeContext = {
    ...statusContext,
    revision: { ...revision, harness: { id: "openclaw", version: "1.0.0", mode: "dedicated" } },
  };
  document = { status: 200, json: { runtimeFailure } };
  assert.deepEqual(await driver.harnessStatus(nativeContext), { state: "failed", runtimeFailure });
  Object.assign(service, { targetPort: 8081 });
  await assert.rejects(
    driver.harnessStatus(nativeContext),
    /exact OpenClaw worker bearer-passthrough/,
  );
  Object.assign(service, { targetPort: 8080 });
  const getService = gatewayClient.getService;
  gatewayClient.getService = async () => undefined;
  observed.length = 0;
  await assert.rejects(
    driver.harnessStatus(nativeContext),
    /exact OpenClaw worker bearer-passthrough/,
  );
  await assert.rejects(driver.harnessStatus(statusContext), /exact Codex bearer-passthrough/);
  assert.deepEqual(observed, []);
  gatewayClient.getService = getService;
  await assert.rejects(
    driver.harnessStatus({
      ...statusContext,
      revision: { ...revision, harness: { id: "other", version: "1.0.0", mode: "dedicated" } },
    }),
    /only for dedicated Codex or OpenClaw revisions/,
  );
  await assert.rejects(driver.harnessEndpoint(nativeContext), /only for dedicated Codex revisions/);
  // Finding 1658: a gateway that does not answer, over its service listener or over gRPC, is
  // no evidence about the Harness. The read is a transient dependency failure the worker
  // rechecks until the deadline without spending attempts, with the transport's own reason.
  // Refusals, invalid answers and the gateway's own transient classes keep their classes.
  document = { status: 200, json: { runtimeFailure } };
  for (const [fail, reason] of [
    [
      () =>
        (gatewayClient.serviceWebSocketHandshake = async () => {
          throw new OpenShellServiceTransportError("timeout");
        }),
      "timeout",
    ],
    [
      () =>
        (gatewayClient.getServiceDocument = async () => {
          throw new OpenShellServiceTransportError("unreachable");
        }),
      "unreachable",
    ],
    [
      () =>
        (gatewayClient.getService = async () => {
          throw new DependencyUnavailableError("OpenShell GetService failed with gRPC status 14.");
        }),
      "unavailable",
    ],
  ]) {
    const restore = {
      serviceWebSocketHandshake: gatewayClient.serviceWebSocketHandshake,
      getServiceDocument: gatewayClient.getServiceDocument,
      getService: gatewayClient.getService,
    };
    fail();
    for (const target of [statusContext, nativeContext]) {
      await assert.rejects(driver.harnessStatus(target), (error) => {
        assert.ok(error instanceof TransientDependencyError, String(error));
        assert.equal(error.dependency, "sandbox_gateway");
        assert.equal(error.reason, reason);
        assert.equal(error.code, "SANDBOX_GATEWAY_UNAVAILABLE");
        assert.ok(error.cause instanceof DependencyUnavailableError);
        return true;
      });
    }
    Object.assign(gatewayClient, restore);
  }
  const transient = new TransientDependencyError("sandbox_admission", "unavailable", "limit");
  const refused = new Error("OpenShell GetService refused: PERMISSION_DENIED");
  for (const thrown of [transient, refused]) {
    const getService = gatewayClient.getService;
    gatewayClient.getService = async () => {
      throw thrown;
    };
    await assert.rejects(driver.harnessStatus(statusContext), (error) => error === thrown);
    gatewayClient.getService = getService;
  }
  assert.deepEqual(await driver.harnessStatus(statusContext), { state: "failed", runtimeFailure });
  // Another Sandbox Driver's revision, or a deferred managed Workspace, is refused before the
  // Harness is observed.
  observed.length = 0;
  await assert.rejects(
    driver.harnessStatus({ ...statusContext, revision: { ...revision, sandboxDriverId: "other" } }),
    /another Sandbox Driver/,
  );
  const managedConfiguration = sandboxInstallation().drivers.sandbox.configuration;
  managedConfiguration.gateway.workspaceMode = "managed";
  const managed = openShellDriver(gatewayClient, managedConfiguration);
  await assert.rejects(
    managed.harnessStatus(statusContext),
    /managed workspace mode is not implemented; cannot observe a Harness/,
  );
  assert.deepEqual(observed, []);
});

test("OpenShell startup admits exactly the endpoints both consumers can parse and dial", async (t) => {
  // Each consumer parses the endpoint once per gateway call: the gRPC path through its
  // service URL normalization, the service transport through its connect target.
  const consumers = {
    grpc: (endpoint) => normalizeServiceUrl("http://service.example.test/", endpoint),
    service: (endpoint) =>
      serviceTarget({ endpoint, requestTimeoutMs: 1000 }, "http://service.example.test/"),
  };
  const throws = (parse, endpoint) => {
    try {
      parse(endpoint);
      return false;
    } catch {
      return true;
    }
  };
  // [form, admitted]: one row per shape, each spelled bare, http:// and https:// where it applies.
  const rows = [
    ["gateway.example.test:8080", true],
    ["gateway.example.test:1", true],
    ["gateway.example.test:65535", true],
    ["gateway.example.test:080", true],
    ["127.0.0.1:8080", true],
    ["192.168.1.1:8080", true],
    ["http://192.168.1.1:8080", true],
    ["[::1]:8080", true],
    ["gateway.example.test:0", false],
    ["gateway.example.test:00", false],
    ["gateway.example.test:65536", false],
    ["gateway.example.test:99999", false],
    ["1.2.3.999:8080", false],
    ["gate%way.example.test:8080", false],
    ["[::1]:0", false],
    ["[::1]:65536", false],
    ["gateway.example.test?x:8080", false],
    ["user@gateway.example.test:8080", false],
    // An empty userinfo hides a colon before the host.
    [":@gateway.example.test:8080", false],
    ["http://gateway.example.test", true],
    ["http://gateway.example.test:8080", true],
    ["http://[::1]:8080", true],
    ["http://gateway.example.test:0", false],
    ["http://gateway.example.test:65536", false],
    ["http://1.2.3.999:8080", false],
    ["http://gate%way.example.test:8080", false],
    // An origin carries no path.
    ["http://gateway.example.test:8080/grpc", false],
    ["https://gateway.example.test", true],
    ["https://gateway.example.test:8443", true],
    ["https://[::1]:8443", true],
    ["https://gateway.example.test:0", false],
    ["https://gateway.example.test:65536", false],
    ["https://1.2.3.999:8443", false],
  ];
  const failing = (endpoint) =>
    Object.entries(consumers)
      .filter(([, parse]) => throws(parse, endpoint))
      .map(([name]) => name);
  for (const [endpoint, admitted] of rows) {
    const configuration = endpointInstallation(endpoint);
    const failedConsumers = failing(endpoint);
    if (admitted) {
      await loadInstallationFile(t, configuration);
      assert.deepEqual(failedConsumers, [], `${endpoint}: admitted but a consumer throws`);
    } else {
      await assert.rejects(
        loadInstallationFile(t, configuration),
        /configuration\.endpoint must be host:port or an http or https origin, with a port from 1 to 65535/,
        endpoint,
      );
    }
    // Startup never admits what either consumer would throw on at first use.
    if (failedConsumers.length > 0) {
      assert.equal(admitted, false, `${endpoint}: ${failedConsumers.join(", ")} throws`);
    }
  }
  for (const endpoint of [
    "http://192.168.1:8080",
    "192.168.1:8080",
    "2130706433:8080",
    "http://0177.0.0.1:8080",
    "http://127.1:8080",
  ]) {
    await assert.rejects(
      loadInstallationFile(t, endpointInstallation(endpoint)),
      /configuration\.endpoint IPv4 host must be four decimal octets from 0 to 255 with no leading zeros/,
      endpoint,
    );
    assert.deepEqual(failing(endpoint).sort(), ["grpc", "service"], endpoint);
  }
});

test("OpenShell startup admits bracketed IPv6 endpoints the native gRPC consumer can reach", async (t) => {
  const grpc = controllerRequire("@grpc/grpc-js");
  const loader = controllerRequire("@grpc/proto-loader");
  const proto = await loader.load(
    join(import.meta.dirname, "../fixtures/openshell-v0.1.5-wire.proto"),
    { keepCase: true, enums: String },
  );
  const OpenShell = grpc.loadPackageDefinition(proto).openshell.v1.OpenShell;
  const server = new grpc.Server();
  let healthCalls = 0;
  server.addService(OpenShell.service, {
    Health(_call, callback) {
      healthCalls += 1;
      callback(null, { status: "SERVICE_STATUS_HEALTHY" });
    },
  });
  // A real IPv6 listener and the native SDK establish address compatibility, not live OpenShell.
  const port = await new Promise((resolve, reject) =>
    server.bindAsync("[::1]:0", grpc.ServerCredentials.createInsecure(), (error, value) =>
      error ? reject(error) : resolve(value),
    ),
  );
  t.after(() => new Promise((resolve) => server.tryShutdown(resolve)));
  for (const endpoint of [`[::1]:${port}`, `http://[::1]:${port}`]) {
    const runtime = await loadInstallationFile(t, endpointInstallation(endpoint));
    const backend = createOpenShellBackend(runtime.installation.backend[0]);
    try {
      await backend.client.clientForNamespace("ipv6-tenant").health(AbortSignal.timeout(2000));
    } finally {
      backend.client.close();
    }
  }
  assert.equal(healthCalls, 2);
  for (const endpoint of [
    "[::1]:0",
    "[::1]:65536",
    "[::1]:999999",
    "[not-an-ip]:8080",
    "[127.0.0.1]:8080",
    "[::1:8080",
    "::1]:8080",
    "[::1]:8080/",
    "[::1]:8080?query",
  ]) {
    await assert.rejects(
      loadInstallationFile(t, endpointInstallation(endpoint)),
      /configuration.endpoint must be host:port or an http or https origin/,
      endpoint,
    );
  }
  // Node's isIP accepts a zoned literal, but WHATWG URL (the http:// form and the service
  // transport) refuses it, so both forms refuse a zone ID with one reason.
  for (const endpoint of [
    "[fe80::1%eth0]:8080",
    "http://[fe80::1%eth0]:8080",
    "http://[fe80::1%25eth0]:8080",
    "https://[fe80::1%eth0]:8443",
    "[::1%]:8080",
  ]) {
    await assert.rejects(
      loadInstallationFile(t, endpointInstallation(endpoint)),
      /configuration\.endpoint must not include an IPv6 zone ID/,
      endpoint,
    );
  }
  for (const endpoint of [
    "gateway.example.test:8080",
    "127.0.0.1:8080",
    "http://gateway.example.test",
    "http://127.0.0.1:80",
  ]) {
    await loadInstallationFile(t, endpointInstallation(endpoint));
  }
});

// These cases invoke the production Driver over controlled Kubernetes/Gateway
// transports. They prove cleanup selection, fencing and completion ordering, not
// Kubernetes garbage collection, filesystem isolation, or live Pod termination.
async function orphanedNativePreparation() {
  const gateway = workspaceGatewayClient();
  gateway.deleteSandbox = async () => gateway.calls.push(["deleteSandbox"]);
  const configuration = sandboxInstallation().drivers.sandbox.configuration;
  configuration.kubernetes.userNamespaces = false;
  const driver = new OpenShellSandboxDriver(configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gateway),
  });
  const fixture = runtimeSandboxFixture(driver, { harnessId: "openclaw" });
  // Revision cleanup confirms an absent Sandbox through the Workspace ensureNamespace created.
  const { name, id } = fixture.context.namespace;
  gateway.workspaces.set(name, ownedWorkspace(name, id));
  const { revision, requirements, prepared } = fixture;
  const api = fixture.context.kubernetes;
  const create = api.create;
  // The API stored the real manifest, but the response never reached the Driver.
  api.create = async (resource) => {
    await create(resource);
    throw new Error("preparation create response lost");
  };
  await assert.rejects(
    driver.provisionHarness({ ...fixture.context, revision, requirements }),
    /preparation create response lost/,
  );
  assert.equal(gateway.providers.size, 1);
  assert.equal(
    gateway.calls.some(([method]) => method === "deleteSandbox"),
    false,
  );
  const resource = prepared[0];
  const deployment = await api.read(resource);
  const context = { ...fixture.context, revision };
  return { driver, gateway, api, resource, deployment, context, requirements };
}

test("OpenShell resumes an SDK-decoded preparer after losing its create response", async () => {
  const { driver, gateway, api, resource, context, requirements } =
    await orphanedNativePreparation();
  api.create = async () => assert.fail("a retry must adopt the existing preparer");
  let sandboxCreates = 0;
  gateway.createSandbox = async (request) => {
    await assert.rejects(api.read(resource), (error) => error.code === 404);
    sandboxCreates++;
    return { name: request.name, serviceUrls: {} };
  };

  // The original response was lost, not the Deployment. Reconciliation must verify
  // its SDK-decoded content, finish preparation, and remove the writer before launch.
  const sandbox = await driver.provisionHarness({ ...context, requirements });
  assert.equal(sandbox.revisionId, context.revision.id);
  assert.equal(sandboxCreates, 1);
  assert.equal(gateway.providers.size, 1);
});

test("OpenShell preparer adoption still rejects changed SDK-decoded security content", async (t) => {
  for (const scenario of [
    {
      name: "container privilege",
      change: (template) => {
        template.spec.containers[0].securityContext.allowPrivilegeEscalation = true;
      },
    },
    {
      name: "PVC group identity",
      change: (template) => {
        template.spec.securityContext.fsGroup = 1000;
      },
    },
    {
      name: "cleanup Pod selector",
      change: (template) => {
        template.metadata.labels["openclaw.dev/revision"] = "foreign";
      },
    },
  ]) {
    await t.test(scenario.name, async () => {
      const { driver, gateway, api, resource, deployment, context, requirements } =
        await orphanedNativePreparation();
      scenario.change(deployment.spec.template);
      const read = api.read;
      api.read = async (target) => (target.kind === "Deployment" ? deployment : read(target));
      api.create = async () => assert.fail("a foreign preparer must not be replaced");
      api.delete = async () => assert.fail("a foreign preparer must not be deleted");
      gateway.createSandbox = async () => assert.fail("a foreign preparer must prevent launch");
      await assert.rejects(
        driver.provisionHarness({ ...context, requirements }),
        /foreign workspace preparation Deployment/,
      );
      assert.equal((await api.read(resource)).metadata.uid, deployment.metadata.uid);
    });
  }
});

test("OpenShell revision cleanup removes an orphaned preparer before its provider and replays safely", async () => {
  const { driver, gateway, api, resource, context } = await orphanedNativePreparation();
  const remove = api.delete;
  let deletions = 0;
  api.delete = async (...args) => {
    assert.equal(gateway.providers.size, 1, "runtime provider must survive until the writer stops");
    assert.equal(
      gateway.calls.some(([method]) => method === "deleteSandbox"),
      false,
    );
    assert.equal(args[0].metadata.name, resource.metadata.name);
    assert.equal(args[0].metadata.namespace, context.namespace.name);
    deletions++;
    await remove(...args);
  };
  await driver.cleanup(context);
  await assert.rejects(api.read(resource), (error) => error.code === 404);
  assert.equal(gateway.providers.size, 0);
  await driver.cleanup(context);
  assert.equal(deletions, 1, "a replay must not delete another resource");
});

test("OpenShell preparer cleanup retries after a delete response is lost", async () => {
  const { driver, gateway, api, resource, context } = await orphanedNativePreparation();
  const remove = api.delete;
  const failure = new Error("preparation delete response lost");
  api.delete = async (...args) => {
    await remove(...args);
    throw failure;
  };
  await assert.rejects(driver.cleanup(context), (error) => error === failure);
  await assert.rejects(api.read(resource), (error) => error.code === 404);
  assert.equal(gateway.providers.size, 1);
  // The next pass must finish without requiring a Deployment or a create receipt.
  api.delete = async () => assert.fail("deleted preparation must not be deleted again");
  await driver.cleanup(context);
  assert.equal(gateway.providers.size, 0);
});

test("OpenShell preparer cleanup rejects foreign ownership and missing UIDs before deletion", async (t) => {
  const changes = [
    ...[
      "app.kubernetes.io/managed-by",
      "openclaw.dev/namespace",
      "openclaw.dev/agent",
      "openclaw.dev/revision",
      "openclaw.dev/workload-role",
    ].map((label) => ({
      name: label,
      change: (metadata) => {
        metadata.labels[label] = "foreign";
      },
      error: /foreign workspace preparation/,
    })),
    {
      name: "namespace",
      change: (metadata) => {
        metadata.namespace = "foreign";
      },
      error: /foreign workspace preparation/,
    },
    {
      name: "name",
      change: (metadata) => {
        metadata.name = "foreign";
      },
      error: /foreign workspace preparation/,
    },
    {
      name: "missing UID",
      change: (metadata) => {
        delete metadata.uid;
      },
      error: /Deployment UID/,
    },
  ];
  for (const scenario of changes) {
    await t.test(scenario.name, async () => {
      const { driver, gateway, api, deployment, context } = await orphanedNativePreparation();
      scenario.change(deployment.metadata);
      api.read = async () => structuredClone(deployment);
      api.delete = async () => assert.fail("foreign or unfenced Deployment must not be deleted");
      await assert.rejects(driver.cleanup(context), scenario.error);
      assert.equal(gateway.providers.size, 1);
      assert.equal(
        gateway.calls.some(([method]) => method === "deleteSandbox"),
        false,
      );
    });
  }
});

test("OpenShell preparer cleanup preserves a same-name UID replacement", async () => {
  const { driver, gateway, api, deployment, context } = await orphanedNativePreparation();
  const conflict = Object.assign(new Error("UID precondition failed"), { code: 409 });
  api.delete = async (_resource, _pretty, _dryRun, _grace, _orphan, propagation, body) => {
    assert.equal(propagation, "Foreground");
    assert.equal(body.preconditions.uid, deployment.metadata.uid);
    // Kubernetes refuses deletion after the resource is replaced between GET and DELETE.
    deployment.metadata.uid = "replacement-uid";
    throw conflict;
  };
  await assert.rejects(driver.cleanup(context), (error) => error === conflict);
  assert.equal(deployment.metadata.uid, "replacement-uid");
  assert.equal(gateway.providers.size, 1);
});

test("OpenShell preparer cleanup rejects a replacement observed while waiting for deletion", async () => {
  const { driver, gateway, api, deployment, context } = await orphanedNativePreparation();
  api.delete = async () => {
    deployment.metadata.uid = "replacement-uid";
  };
  api.read = async () => structuredClone(deployment);
  await assert.rejects(driver.cleanup(context), /Deployment changed/);
  assert.equal(gateway.providers.size, 1);
});

test("OpenShell preparer cleanup tolerates a concurrent delete but waits for lingering Pods", async (t) => {
  for (const missingDeployment of [false, true]) {
    await t.test(
      missingDeployment ? "Deployment already absent" : "foreground deletion",
      async () => {
        const { driver, gateway, api, resource, deployment, context } =
          await orphanedNativePreparation();
        const remove = api.delete;
        if (missingDeployment) {
          await remove(resource, undefined, undefined, undefined, undefined, "Foreground", {
            preconditions: { uid: deployment.metadata.uid },
          });
          api.delete = async () => assert.fail("an absent Deployment must not be deleted");
        } else {
          api.delete = async (...args) => {
            await remove(...args);
            throw { code: 404 };
          };
        }
        let observations = 0;
        api.list = async (version, kind, namespace, _pretty, _exact, _export, _field, selector) => {
          assert.equal(version, "v1");
          assert.equal(kind, "Pod");
          assert.equal(namespace, context.namespace.name);
          assert.deepEqual(
            Object.fromEntries(selector.split(",").map((entry) => entry.split("="))),
            deployment.metadata.labels,
          );
          assert.equal(gateway.providers.size, 1);
          assert.equal(
            gateway.calls.some(([method]) => method === "deleteSandbox"),
            false,
          );
          observations++;
          // A Pod carrying deletionTimestamp can still write; readiness is irrelevant.
          return {
            items:
              observations === 1
                ? [{ metadata: { deletionTimestamp: "2026-10-12T00:00:00Z" } }]
                : [],
          };
        };
        await driver.cleanup(context);
        assert.equal(observations, 2);
        assert.equal(gateway.providers.size, 0);
      },
    );
  }
});

test("OpenShell preparer cleanup waits for the Deployment even when no Pods are listed", async () => {
  const { driver, gateway, api, deployment, context } = await orphanedNativePreparation();
  let reads = 0;
  api.read = async () => {
    if (++reads <= 2) {
      return structuredClone(deployment);
    }
    throw { code: 404 };
  };
  api.delete = async () => {
    deployment.metadata.deletionTimestamp = "2026-10-12T00:00:00Z";
  };
  api.list = async () => {
    assert.equal(gateway.providers.size, 1);
    return { items: [] };
  };
  await driver.cleanup(context);
  assert.equal(reads, 3);
  assert.equal(gateway.providers.size, 0);
});

test("OpenShell preparer cleanup preserves retryable work on cancellation and transport errors", async (t) => {
  for (const stage of [
    "cancelled before cleanup",
    "cancelled while waiting",
    "read",
    "delete",
    "list",
  ]) {
    await t.test(stage, async () => {
      const { driver, gateway, api, context } = await orphanedNativePreparation();
      const abort = new AbortController();
      context.signal = abort.signal;
      const failure = new Error("cleanup interrupted");
      if (stage === "cancelled before cleanup") {
        abort.abort(failure);
        api.delete = async () => assert.fail("cancellation must prevent mutation");
      } else if (stage === "cancelled while waiting") {
        api.list = async () => {
          abort.abort(failure);
          return { items: [{}] };
        };
      } else {
        api[stage] = async () => {
          throw failure;
        };
      }
      await assert.rejects(driver.cleanup(context), (error) => error === failure);
      assert.equal(gateway.providers.size, 1);
      assert.equal(
        gateway.calls.some(([method]) => method === "deleteSandbox"),
        false,
      );
    });
  }
});
