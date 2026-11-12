import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createOpenShellInstallationConfiguration } from "../helpers/openshell-kubernetes-real.mjs";
import { verifyOpenShellPushNegotiation } from "../helpers/openshell-git-push-negotiation.mjs";
import { runDocker, image, imageTestOptions } from "../helpers/runtime-image-startup.mjs";
import { managedMcpInstalls } from "../../apps/controller/src/drivers/plugin/managed-catalog.ts";
import { managedGoogleInstall } from "../../apps/controller/src/drivers/plugin/google-workspace/install.ts";
import { routeStore } from "../fixtures/openshell-git-route-store.mjs";
import { openShellWorkspaceChartResources } from "../fixtures/openshell-workspace-chart.mjs";
import { ConfigurationValidationError as SharedConfigurationValidationError } from "../../packages/contracts/src/index.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { resolveGitHubRepositoryBinding } from "../../apps/controller/src/drivers/repo/github/access/registry.ts";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import {
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
import { inspectOpenShellCodexCommand } from "../fixtures/openshell-codex-command.ts";
import {
  captureOpenShellHarness,
  providerEndpointFixture,
  tlsPinnedWorkspaceSetupCode,
} from "../fixtures/kubernetes-provider-endpoint.mjs";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import {
  assertNoManagedMcpRouteOverlap,
  managedMcpNetwork,
  managedMcpProviderEndpoint,
} from "../../apps/controller/src/drivers/sandbox/openshell-managed-mcp-policy.ts";
import { openShellEgressConfiguration } from "../../apps/controller/src/drivers/egress-proxy/openshell.ts";
import { formatStartupConfigurationFailure } from "../../apps/controller/src/startup-failure.ts";
import { ProtectedExecutionDriver } from "../../apps/controller/src/drivers/compute/protected-execution-driver.ts";
import {
  GrpcOpenShellGatewayClient,
  normalizeServiceUrl,
  OpenShellProviderAlreadyExistsError,
  OpenShellSandboxAlreadyExistsError,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { serviceTarget } from "../../apps/controller/src/drivers/sandbox/openshell-service-transport.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import {
  ConfigurationHarnessError,
  DependencyUnavailableError,
  SandboxGatewayUnauthorizedError,
  SandboxRevisionUnsupportedError,
  SandboxWorkspaceSetupRefusedError,
  ScopeViolationError,
  TransientDependencyError,
} from "../../packages/occ/src/index.ts";
import { loadInstallationFile } from "../helpers/installation-file.ts";
import {
  WORKSPACE_DEFAULTS,
  WORKSPACE_DEFAULTS_ID,
} from "../../packages/contracts/src/workspace-defaults.mjs";
import { conformanceKubernetesOptions } from "../helpers/kubernetes-compute.mjs";
import {
  admitRevisionHarness,
  labelSelectorLabels,
} from "../helpers/kubernetes-routed-scenarios.mjs";
import {
  bindReservedPortInProcess,
  reservedPortArgs,
  reservePort,
} from "../helpers/available-port.ts";
import { harnessTlsFixture } from "../helpers/harness-tls.mjs";
import { listen } from "../helpers/listen.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { createSandboxProviderProfileChecks } from "./sandbox-driver-provider-profiles-cases.ts";
import { createSandboxCredentialContractChecks } from "./sandbox-driver-credential-contract-cases.ts";
import { createCredentialGatewayContexts } from "./sandbox-driver-credential-fixture.ts";
import { createSandboxHarnessLifecycleChecks } from "./sandbox-driver-harness-lifecycle-cases.ts";
import { createSandboxCodexHarnessChecks } from "./sandbox-driver-codex-harness-cases.ts";
import { createCredentialWithdrawalChecks } from "./sandbox-driver-credential-withdrawal-cases.ts";
import { assertManagedMcpProjection } from "./sandbox-driver-managed-mcp-rules-cases.ts";
import { createSandboxStartupGuardChecks } from "./sandbox-driver-startup-guard-cases.ts";
import {
  verifySharedBackendComposition,
  verifyDedicatedHarnessSelection,
  verifyWorkspaceWrapperDiagnostics,
  verifyManagedNamespaceRejectsMutation,
  verifyOperatorPolicyDrift,
  verifyOperatorAliasesRejected,
  prepareStockWorkspaceChart,
  verifyProtectedGatewayAdmission,
} from "./sandbox-driver-startup-composition-cases.ts";
import {
  verifySandboxAdoptionRefusals,
  prepareGatewayReplayFixture,
  verifyConcurrentReplayAndExhaustion,
} from "./sandbox-driver-gateway-replay-cases.ts";
import {
  verifyGoogleAdmissionRefusals,
  verifySlackLivePolicyAndDetach,
} from "./sandbox-driver-provider-policy-cases.ts";
import {
  prepareNativeHeldFailure,
  verifyNativeHeldFailureWithdrawal,
} from "./sandbox-driver-native-exposure-cases.ts";
import { verifyDedicatedCodexStartup } from "./sandbox-driver-native-harness-assertions.ts";
import {
  verifyRevisionProviderRetention,
  verifyForeignSandboxAnnotations,
} from "./sandbox-driver-revision-observation-cases.ts";
import {
  verifyInitialWorkspaceAdmission,
  verifyMainWorkspaceMount,
} from "./sandbox-driver-workspace-admission-cases.ts";
import { verifyOperatorWorkspaceChart } from "./sandbox-driver-operator-chart-case.ts";
import {
  verifyProtectedStartupRefusals,
  verifyProtectedChartListenerRefusals,
} from "./sandbox-driver-protected-startup-guard-cases.ts";
import { callCount, storedSandbox } from "./sandbox-driver-gateway-response-fixture.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";
import {
  buildEndpointInstallation,
  makeStructuralRefusal,
} from "./sandbox-driver-installation-fixture.ts";
import {
  buildSandboxInstallation,
  rejectsAtStartup,
} from "./sandbox-driver-startup-installation-fixture.ts";
import { verifyEndpointAdmission } from "./sandbox-driver-endpoint-admission-case.ts";
import { verifySandboxDriverHarnessObservation } from "./sandbox-driver-harness-observation-cases.ts";
import { registerSandboxDriverNamespaceGatewayCleanupCases } from "./sandbox-driver-namespace-gateway-cleanup-cases.ts";
import { completeWorkspaceRevision } from "./sandbox-driver-revision-fixture.ts";
import { registerSandboxDriverWorkspaceRenewalCases } from "./sandbox-driver-workspace-renewal-cases.ts";
import { registerSandboxDriverWorkspaceExpiryCases } from "./sandbox-driver-workspace-expiry-cases.ts";
import { registerSandboxDriverPreparerCleanupCases } from "./sandbox-driver-preparer-cleanup-cases.ts";
import { registerSandboxDriverNativePreparationCases } from "./sandbox-driver-native-preparation-cases.ts";
import { verifySandboxScratchStorage } from "./sandbox-driver-scratch-storage-case.ts";

const harnessLifecycleChecks = createSandboxHarnessLifecycleChecks({
  chmod,
  mkdtemp,
  nativeWorkerEntrypoint: NATIVE_WORKER_ENTRYPOINT,
  reservedPortArgs,
  rm,
  stat,
  tmpdir,
  codexRequirements,
  dedicatedRevision,
  harnessRuntimeCommand,
  harnessService,
  namespaceContext,
  openShellDriver,
  runtimeSandboxFixture,
  storedSandbox,
});
const codexHarnessChecks = createSandboxCodexHarnessChecks({
  agentRuntimeEntrypoint: AGENT_RUNTIME_ENTRYPOINT,
  backendFor,
  codexRequirements,
  conformanceKubernetesOptions,
  dedicatedRevision,
  harnessRuntimeCommand,
  namespaceContext,
  openShellDriver,
  runtimeSandboxFixture,
  sandboxInstallation,
  workspaceGatewayClient,
});

function credentialWithdrawalChecks() {
  return createCredentialWithdrawalChecks({
    OpenShellCredentialRefreshDriver,
    conformanceKubernetesOptions,
    credentialGatewayOverProviders,
    kubernetesObjectClient,
    openShellDriver,
    rejectsAtStartup,
    runtimeSandboxFixture,
    sandboxInstallation,
    structuralRefusal,
  });
}
function sandboxStartupGuardChecks() {
  return createSandboxStartupGuardChecks({
    conformanceKubernetesOptions,
    controllerRequire,
    invalidValue,
    kubernetesObjectClient,
    namespaceContext,
    openShellDriver,
    ownedWorkspace,
    rejectsAtStartup,
    runtimeSandboxFixture,
    sandboxOf,
    sandboxRecord,
  });
}

const controllerRequire = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);
const { KubernetesObjectApi } = controllerRequire("@kubernetes/client-node");
const { ObjectSerializer } = controllerRequire("@kubernetes/client-node/dist/serializer.js");

function sandboxInstallation() {
  return buildSandboxInstallation();
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

const structuralRefusal = (path, keyword, code = "INVALID_VALUE") => [
  ...makeStructuralRefusal(path, keyword, code),
];

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
    harness: {
      id: harnessId,
      version: "1.0.0",
      mode: "dedicated",
      overrides: {},
      configuration: {},
    },
    sandboxDriverId: driver.id,
  };
  const nodeSetup = {
    url: nodeSetupUrl(revision, context),
    bootstrapToken: "one-shot-node-setup",
    expiresAtMs: Date.now() + 600_000,
    tlsFingerprint: "ab".repeat(32),
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
  await verifySharedBackendComposition({
    t,
    sandboxInstallation,
    OpenShellCredentialGatewayDriver,
  });
});

test("startup pairs the Credential Refresh Driver with its gateway on one OpenShell Backend", async (t) => {
  await credentialWithdrawalChecks().pairsCredentialRefreshWithGateway(t);
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
    /requires TLS with bearerTokenFile or mtls authentication, or insecureTransport: network-policy/,
  );
  // TLS alone is not enough; the gateway must also authenticate OCC.
  const tlsOnly = sandboxInstallation();
  tlsOnly.backend[0].configuration = { endpoint: "https://openshell-gateway.openshell.svc:8080" };
  await assert.rejects(load(tlsOnly), /requires TLS with bearerTokenFile or mtls authentication/);

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
  await assert.rejects(load(tlsOnly), /requires TLS with bearerTokenFile or mtls authentication/);

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

  const mtls = sandboxInstallation();
  mtls.backend[0].configuration = {
    endpoint: "https://openshell-gateway.openshell.svc:8080",
    auth: {
      mode: "mtls",
      certificatePath: "/etc/openclaw/openshell/tls.crt",
      privateKeyPath: "/etc/openclaw/openshell/tls.key",
    },
  };
  await load(mtls);
  for (const change of [
    { privateKeyPath: undefined },
    { certificatePath: "relative.crt" },
    { path: "/unexpected" },
  ]) {
    const invalid = structuredClone(mtls);
    Object.assign(invalid.backend[0].configuration.auth, change);
    await assert.rejects(load(invalid), /configuration.auth/);
  }
  mtls.backend[0].configuration.endpoint = "http://openshell-gateway.openshell.svc:8080";
  mtls.backend[0].configuration.insecureTransport = "network-policy";
  await assert.rejects(load(mtls), /mtls requires HTTPS/);

  // Every gateway call's deadline stays within the registration fence.
  const slow = sandboxInstallation();
  slow.backend[0].configuration.requestTimeoutMs = 60_000;
  await assert.rejects(load(slow), /requestTimeoutMs must be between 1000 and 30000 ms/);
});

test("OpenShell configures only the selected dedicated Harness runtime", () => {
  const driver = openShellDriver(workspaceGatewayClient());
  verifyDedicatedHarnessSelection({
    configureAgent: (configuration, id, mode = "dedicated") =>
      driver.configureAgent(configuration, { id, version: "1.0.0", mode }),
  });
});

// Native OpenClaw's private workspace preparation needs userNamespaces: false and at most one
// operator-mode ServiceAccount, and it runs only after a dedicated deploy has stopped its
// predecessors. Agent save and deploy admission call configureAgent, so they refuse those
// settings first (findings 2334, 2346).
test("OpenShell refuses dedicated OpenClaw on settings its workspace preparation refuses", () => {
  const configuration = { agents: { defaults: { model: "openai/gpt-5" } } };
  const harness = (id) => ({ id, version: "1.0.0", mode: "dedicated" });
  const userNamespaces =
    "Dedicated OpenClaw needs kubernetes.userNamespaces: false in the OpenShell Sandbox Driver configuration. Select Codex, or ask an operator to set it.";
  const accounts =
    "Dedicated OpenClaw needs at most one ServiceAccount in gateway.operatorWorkspaceResources of the OpenShell Sandbox Driver configuration. Select Codex, or ask an operator to remove the others.";
  const serviceAccount = (name) => ({
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: { name },
  });
  const role = {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "Role",
    metadata: { name: "r" },
  };
  for (const [settings, message] of [
    [(options) => delete options.kubernetes.userNamespaces, userNamespaces],
    [(options) => (options.kubernetes.userNamespaces = true), userNamespaces],
    [
      (options) =>
        (options.gateway.operatorWorkspaceResources = [serviceAccount("a"), serviceAccount("b")]),
      accounts,
    ],
    // Control: one ServiceAccount beside other resources still prepares.
    [(options) => (options.gateway.operatorWorkspaceResources = [serviceAccount("a"), role])],
  ]) {
    const options = sandboxInstallation().drivers.sandbox.configuration;
    settings(options);
    const driver = openShellDriver(workspaceGatewayClient(), options);
    assert.deepEqual(driver.supportsHarnessExecutionMode.openclaw, {
      embedded: { supported: false },
      dedicated:
        message === undefined ? { supported: true } : { supported: false, reason: message },
    });
    assert.throws(() => {
      driver.supportsHarnessExecutionMode.openclaw.dedicated.supported = false;
    }, TypeError);
    // A caller's later mutation cannot change the constructed Driver's support decision.
    options.kubernetes.userNamespaces = !options.kubernetes.userNamespaces;
    if (message === undefined) {
      assert.ok(driver.configureAgent(configuration, harness("openclaw")));
    } else {
      assert.throws(
        () => driver.configureAgent(configuration, harness("openclaw")),
        (error) => {
          // workspace-setup-api.test.mjs proves the API's 400 with these messages.
          assert.ok(error instanceof ConfigurationHarnessError);
          assert.equal(error.message, message);
          return true;
        },
      );
    }
    // Codex never runs the preparation, so it is still admitted.
    assert.ok(driver.configureAgent(configuration, harness("codex")).plugins.entries.codex);
  }
});

test("OpenShell pins an explicit main Agent workspace to the Sandbox data mount", () => {
  verifyMainWorkspaceMount({
    driver: openShellDriver(workspaceGatewayClient()),
    readGatewayWorkspace: (configured, harness) => {
      const compute = createKubernetesComputeDriver(
        conformanceKubernetesOptions({ gatewayTrustedProxyCidrs: ["127.0.0.1/32"] }),
      );
      return compute.gatewayConfiguration({
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
      }).workspace;
    },
  });
});

test("OpenShell admits initial files only for its projected main workspace", () => {
  const options = sandboxInstallation().drivers.sandbox.configuration;
  options.kubernetes.sandboxDataMount.mountPath = "/sandbox/custom-workspace";
  verifyInitialWorkspaceAdmission(openShellDriver(workspaceGatewayClient(), options));
});

const negotiatedGoogleGuard = () => ({
  kind: 4,
  configured_name: "oce-plugin-requests",
  implementation_name: "oce/managed-plugin-requests",
  implementation_version: managedGoogleInstall.releaseSha256,
  protocol_major: 1,
  supported_capabilities: ["openshell.supervisor-middleware.contract"],
  required_capabilities: ["openshell.supervisor-middleware.contract"],
});

const managedSlackInstall = managedMcpInstalls.find(({ id }) => id === "occ-plugin:slack@1.0.0");

// Model OpenShell's effective wire policy after attaching a Slack provider. The saved
// Sandbox keeps its original uncredentialed launch rule.
function admitSlackProvider(policy, ref) {
  const providerName = "_provider_" + ref.replaceAll("-", "_");
  const route = policy.network_policies["oce-slack-mcp"];
  route.endpoints[0].provider_credentialed = true;
  route.endpoints[0].mcp._strict_tool_names = "strict_tool_names";
  policy.network_policies[providerName] = {
    name: providerName,
    binaries: [{ path: "/usr/local/bin/node" }],
    endpoints: [
      {
        host: "mcp.slack.com",
        port: 443,
        path: "/mcp",
        protocol: "mcp",
        enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
        mcp: { strict_tool_names: true, versions: [...managedSlackInstall.mcpVersions] },
        rules: [{ allow: { method: "ping" } }],
        provider_credentialed: true,
      },
    ],
  };
}

test("a selected Google account keeps its request guard alongside an independently bound Slack MCP server", async () => {
  assert.ok(managedSlackInstall);
  const registration = "oce-plugin-requests";
  const configuration = sandboxInstallation().drivers.sandbox.configuration;
  configuration.gateway.managedPluginMiddleware = "https://authority.test:443";
  const client = workspaceGatewayClient();
  const driver = openShellDriver(client, configuration);
  const { context, revision, requirements } = runtimeSandboxFixture(driver, {
    harnessId: "openclaw",
  });
  const sourceId = "cs_00000000-0000-4000-8000-000000000005";
  const slackId = "cs_00000000-0000-4000-8000-000000000006";
  revision.plugins = {
    driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
    plugins: {
      [managedGoogleInstall.id]: {
        enabled: true,
        driverPolicy: {
          releaseSha256: managedGoogleInstall.releaseSha256,
          credentials: { account: sourceId },
        },
      },
      [managedSlackInstall.id]: {
        enabled: true,
        driverPolicy: {
          releaseSha256: managedSlackInstall.releaseSha256,
          credentials: { account: slackId },
          toolNames: ["slack_search_public"],
        },
      },
    },
  };
  const gateway = credentialGatewayOverProviders({
    toolBinaries: [managedGoogleInstall.binaryPath, "/usr/local/bin/node"],
    refresh: true,
  });
  gateway.client.getGatewayInfo = async () => ({ extensions: [negotiatedGoogleGuard()] });
  const googleSource = {
    ...gateway.source(sourceId, context.namespace.id),
    type: "oauth2-refresh-token",
    config: {
      host: "gmail.googleapis.com",
      path: "/gmail/v1/users/me/messages",
      token_url: "https://oauth2.googleapis.com/token",
      scope: "https://www.googleapis.com/auth/gmail.readonly",
      client_id: "test-client",
      env_var: "GOG_ACCESS_TOKEN",
      binary: managedGoogleInstall.binaryPath,
    },
  };
  const slackSource = {
    ...gateway.source(slackId, context.namespace.id),
    type: "bearer-token",
    secrets: { token: { kind: "secret", id: "sec_slack", namespaceId: context.namespace.id } },
    config: { protocol: "mcp", host: "mcp.slack.com", path: "/mcp", env_var: "SLACK_MCP_TOKEN" },
  };
  const register = (source, secrets) =>
    gateway.driver.registerSource(
      { ...context, source },
      { type: source.type, config: source.config, secrets },
    );
  await register(googleSource, {});
  await register(slackSource, { token: "synthetic-slack-bearer" });
  requirements.credentialAttachments = await gateway.driver.attachForRevision({
    ...context,
    revision,
    sources: [googleSource, slackSource],
  });
  const [{ requestScope }, slack] = requirements.credentialAttachments;
  const provision = () => driver.provisionHarness({ ...context, revision, requirements });
  let created;
  let observedGuard = true;
  const credentialedHosts = new Set();
  let endpoint = configuration.gateway.managedPluginMiddleware;
  const provider = "_provider_" + openShellProviderName(sourceId).replaceAll("-", "_");
  const providerRule = {
    name: provider,
    binaries: [{ path: managedGoogleInstall.binaryPath }],
    endpoints: [
      {
        host: "gmail.googleapis.com",
        port: 443,
        path: "/gmail/v1/users/me/messages",
        protocol: "rest",
        enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
        access: "NETWORK_ACCESS_PRESET_READ_WRITE",
        provider_credentialed: true,
      },
    ],
  };
  const independentProvider = {
    name: "_provider_independent",
    binaries: [{ path: "/usr/bin/curl" }],
    endpoints: [{ host: "independent.example", ports: [8443], provider_credentialed: true }],
  };
  client.createSandbox = async ({ name, workspace, labels, annotations, spec }) => {
    created = { name, workspace, labels, annotations, spec, serviceUrls: {} };
    return created;
  };
  client.getSandbox = async () => created;
  client.getSandboxConfig = async (workspace) => {
    const policy = structuredClone(created.spec.policy);
    const routes = policy.network_policies;
    if (created.spec.providers.includes(openShellProviderName(sourceId))) {
      for (const ep of routes["oce-google-requests"].endpoints) {
        if (credentialedHosts.has(ep.host)) {
          ep.provider_credentialed = true;
        }
      }
      routes[provider] = providerRule;
    }
    admitSlackProvider(policy, slack.ref);
    routes[independentProvider.name] = independentProvider;
    if (!observedGuard) {
      policy.network_middlewares = {};
    }
    return {
      workspace,
      policy_source: 1,
      configuration_admitted: true,
      policy_validation_failure_mode: "fail_closed",
      extension_authentication_enabled: true,
      supervisor_middleware_services: [
        {
          name: registration,
          grpc_endpoint: endpoint,
          audience: "urn:openshell:extension:middleware:" + registration,
        },
      ],
      policy,
    };
  };
  await verifyGoogleAdmissionRefusals({
    ensureNamespace: () => driver.ensureNamespace(context),
    provisionWithoutCredentials: () =>
      driver.provisionHarness({
        ...context,
        revision,
        requirements: { ...requirements, credentialAttachments: [] },
      }),
    client,
    provision,
    getCreated: () => created,
    negotiatedGoogleGuard,
    setPolicy: (policy) => {
      revision.sandboxPolicy = policy;
    },
    clearPolicy: () => {
      Reflect.deleteProperty(revision, "sandboxPolicy");
    },
  });
  await provision();
  assert.ok(created.spec.providers.includes(openShellProviderName(sourceId)));
  assert.ok(created.spec.providers.includes(slack.ref));
  const slackNetwork = created.spec.policy.network_policies["oce-slack-mcp"];
  assert.deepEqual(slackNetwork.endpoints[0].rules.at(-1), {
    allow: { method: "tools/call", params: { name: { glob: "slack_search_public" } } },
  });
  assert.equal(created.spec.environment.OPENCLAW_MANAGED_CREDENTIAL_ENV, "GOG_ACCESS_TOKEN");
  assert.equal(created.spec.environment.GOG_ACCESS_TOKEN, undefined);
  const guard = created.spec.policy.network_middlewares[registration];
  assert.equal(guard.config.fields.binding_id.stringValue, managedGoogleInstall.releaseSha256);
  assert.equal(guard.on_error, "fail_closed");
  assert.deepEqual(guard.endpoints.include, ["gmail.googleapis.com", "www.googleapis.com"]);
  const rule = created.spec.policy.network_policies["oce-google-requests"];
  assert.deepEqual(rule.binaries, [{ path: managedGoogleInstall.binaryPath }]);
  assert.deepEqual(rule.endpoints[0].rules[0].allow, {
    method: "GET",
    path: "/gmail/v1/users/me/messages",
  });
  assert.deepEqual(
    rule.endpoints[1].rules.map(({ allow }) => allow.path),
    ["/discovery/v1/apis", "/discovery/v1/apis/gmail/v1/rest"],
  );
  independentProvider.endpoints[0].host = "gmail.googleapis.com";
  await assert.rejects(provision, /Another credential provider uses a guarded Google host/);
  independentProvider.endpoints[0].host = "independent.example";
  providerRule.endpoints[0].path = "/**";
  await assert.rejects(provision, /exact Google provider route/);
  providerRule.endpoints[0].path = "/gmail/v1/users/me/messages";
  endpoint = "https://other.test:443";
  await assert.rejects(provision, /has not admitted.*request guard/);
  endpoint = configuration.gateway.managedPluginMiddleware;
  observedGuard = false;
  await assert.rejects(provision, /has not admitted.*request guard/);
  observedGuard = true;

  // For a host-wide source, stock OpenShell also marks the matching operation
  // endpoint credentialed in GetSandboxConfig. The saved CreateSandbox spec stays raw.
  requestScope.path = "/**";
  providerRule.endpoints[0].path = "/**";
  created = undefined;
  await assert.rejects(provision, /pinned Google request routes/);
  credentialedHosts.add(requestScope.host);
  await provision();
  assert.ok(
    created.spec.policy.network_policies["oce-google-requests"].endpoints.every(
      (ep) => ep.provider_credentialed === undefined,
    ),
  );
  credentialedHosts.add("www.googleapis.com");
  await assert.rejects(provision, /pinned Google request routes/);
  credentialedHosts.delete("www.googleapis.com");

  // The worker dispatches the same admitted revision without the withdrawn tool source.
  revision.credentialSources = [
    { sourceId, credentialGatewayId: "openshell", sourceType: "oauth2-refresh-token" },
    { sourceId: slackId, credentialGatewayId: "openshell", sourceType: "bearer-token" },
  ];
  requirements.credentialAttachments = await gateway.driver.attachForRevision({
    ...context,
    revision,
    sources: [slackSource],
  });
  await assert.rejects(provision, /exact AgentRevision ownership and content/);
  // OpenShell's detach removes the provider from a standing Sandbox. Its immutable launch
  // environment and policy still describe the original request. It can be safely adopted.
  created.spec.providers = created.spec.providers.filter(
    (ref) => ref !== openShellProviderName(sourceId),
  );
  await provision();
  created = undefined;
  await provision();
  assert.ok(created.spec.providers.includes(slack.ref));
  assert.deepEqual(created.spec.policy.network_policies["oce-slack-mcp"], slackNetwork);
  assert.ok(!created.spec.providers.includes(openShellProviderName(sourceId)));
  assert.equal(created.spec.environment.OPENCLAW_MANAGED_CREDENTIAL_ENV, undefined);
  assert.equal(created.spec.policy.network_middlewares?.[registration], undefined);
  assert.equal(created.spec.policy.network_policies["oce-google-requests"], undefined);
});

test("OpenShell builds managed MCP rules for the declared endpoint and upstream tool name", () => {
  const endpoint = { host: "mcp.tools.example", port: 8443, path: "/api/mcp" };
  const install = {
    runtimeName: "inventory",
    endpoint,
    binaryPath: "/opt/inventory/bin/client",
    mcpVersions: ["2025-11-25"],
  };
  const provider = managedMcpProviderEndpoint(install);
  const network = managedMcpNetwork(install, ["read_inventory"]);
  assertManagedMcpProjection({ endpoint, install, provider, network });
  const policyWith = (port) => ({
    [network.name]: network,
    other: { endpoints: [{ host: "*.tools.example", ports: [port] }] },
  });
  assert.doesNotThrow(() =>
    assertNoManagedMcpRouteOverlap(policyWith(443), install, [network.name]),
  );
  assert.throws(
    () => assertNoManagedMcpRouteOverlap(policyWith(endpoint.port), install, [network.name]),
    /overlaps the credentialed managed MCP endpoint/,
  );
});

test("OpenShell limits a Slack connection to the revision's exact MCP tools and recovers after detach", async () => {
  assert.ok(managedSlackInstall);
  const client = workspaceGatewayClient();
  const driver = openShellDriver(client);
  const { context, revision, requirements } = runtimeSandboxFixture(driver, {
    harnessId: "openclaw",
  });
  const sourceId = "cs_00000000-0000-4000-8000-000000000091";
  const ref = openShellProviderName(sourceId);
  const routeName = "oce-slack-mcp";
  const broadGrant = {
    id: "slack-bypass",
    host: "*.slack.com",
    ports: [{ from: 443, to: 443 }],
    binary: "/usr/bin/curl",
  };
  const selection = {
    enabled: true,
    driverPolicy: {
      releaseSha256: managedSlackInstall.releaseSha256,
      credentials: { account: sourceId },
      toolNames: ["slack_search_public", "slack_search_emojis"],
    },
  };
  revision.plugins = {
    driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
    plugins: { [managedSlackInstall.id]: selection },
  };
  requirements.credentialAttachments = [
    {
      sourceId,
      ref,
      requestScope: {
        host: "mcp.slack.com",
        port: 443,
        path: "/mcp",
        scopes: ["search:read.public"],
      },
    },
  ];
  requirements.environment.push({ name: "SLACK_MCP_TOKEN", value: "arbitrary-unbound-value" });
  let created;
  let broadenEffective = false;
  let updateCount = 0;
  client.createSandbox = async ({ name, workspace, labels, annotations, spec }) => {
    created = {
      name,
      workspace,
      labels,
      annotations,
      spec: structuredClone(spec),
      serviceUrls: {},
      resourceVersion: "1",
    };
    return created;
  };
  client.getSandbox = async () => created;
  client.updatePolicy = async () => {
    updateCount++;
  };
  client.getSandboxConfig = async (workspace) => {
    const policy = structuredClone(created.spec.policy);
    admitSlackProvider(policy, ref);
    if (broadenEffective) {
      policy.network_policies.unexpected = { endpoints: [{ host: "mcp.slack.com", port: 443 }] };
    }
    return {
      workspace,
      policy_source: 1,
      configuration_admitted: true,
      policy_validation_failure_mode: "fail_closed",
      policy,
    };
  };
  const provision = () => driver.provisionHarness({ ...context, revision, requirements });
  await driver.ensureNamespace(context);
  revision.sandboxPolicy = { defaults: {}, additions: [broadGrant] };
  await assert.rejects(provision, /overlaps the credentialed managed MCP endpoint/);
  assert.equal(created, undefined);
  revision.sandboxPolicy = { defaults: {}, additions: [] };
  const plugins = revision.plugins;
  delete revision.plugins;
  await provision();
  assert.deepEqual(created.spec.policy.network_policies[routeName].endpoints[0].rules, [
    { allow: { method: "ping" } },
  ]);
  assert.ok(created.spec.providers.includes(ref));
  created = undefined;
  revision.plugins = plugins;
  revision.credentialSources = [{ sourceId }];
  const requestScope = requirements.credentialAttachments[0].requestScope;
  requestScope.port = 8443;
  await assert.rejects(
    provision,
    /requires its reviewed OpenShell provider and an isolated endpoint/,
  );
  assert.equal(created, undefined);
  requestScope.port = 443;
  await provision();
  const route = created.spec.policy.network_policies[routeName];
  assert.equal(route.endpoints[0].protocol, "mcp");
  assert.deepEqual(route.endpoints[0].ports, [443]);
  assert.deepEqual(route.endpoints[0].rules, [
    { allow: { method: "ping" } },
    { allow: { method: "initialize" } },
    { allow: { method: "notifications/initialized" } },
    { allow: { method: "tools/list" } },
    { allow: { method: "tools/call", params: { name: { glob: "slack_search_public" } } } },
    { allow: { method: "tools/call", params: { name: { glob: "slack_search_emojis" } } } },
  ]);
  assert.equal(created.spec.environment.SLACK_MCP_TOKEN, undefined);
  assert.equal(created.spec.policy.network_middlewares, undefined);

  const snapshot = {
    driverId: driver.id,
    implementation: driver.implementation,
    defaults: {},
    additions: [broadGrant],
  };
  await verifySlackLivePolicyAndDetach({
    admitStandardPolicy: () => {
      revision.executionAdmission = { mode: "standard" };
    },
    detachCredentials: () => {
      requirements.credentialAttachments = [];
    },
    applyBroadPolicy: () =>
      driver.applyNetworkPolicy(
        { ...context, revision },
        { snapshot, expectedProviderVersion: "1", operationId: "slack-policy-update" },
      ),
    applyUnrelatedPolicy: () =>
      driver.applyNetworkPolicy(
        { ...context, revision },
        {
          snapshot: { ...snapshot, additions: [{ ...broadGrant, host: "docs.example.test" }] },
          expectedProviderVersion: "1",
          operationId: "unrelated-policy-update",
        },
      ),
    provision,
    getUpdateCount: () => updateCount,
    setBroadenEffective: (value) => {
      broadenEffective = value;
    },
    getCreated: () => created,
    setCreated: (value) => {
      created = value;
    },
    ref,
    route,
    routeName,
  });
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
  configuration.kubernetes.agentResourceOverrides = [
    {
      namespaceId: namespaceContext().namespace.id,
      agentId: "agt_00000000-0000-4000-8000-000000000003",
      requests: {},
      limits: {},
      runtimeClassName: "openshell-skipper",
    },
  ];
  configuration.policy.filesystem = {
    includeWorkdir: false,
    readOnly: ["/app"],
    readWrite: ["/var/tmp/openclaw"],
  };
  const driver = openShellDriver(gatewayClient, configuration);
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
  assert.equal(preparation.runtimeClassName, "openshell-skipper");
  assert.equal(preparation.automountServiceAccountToken, false);
  assert.equal(preparation.securityContext.runAsUser, 10001);
  assert.deepEqual(preparation.containers[0].securityContext.capabilities, { drop: ["ALL"] });

  assert.equal(sandbox.revisionId, revision.id);
  assert.equal(requests.length, 1);
  const template = requests[0].spec.template;
  const pod = template.driver_config.fields.kubernetes.structValue.fields.pod;
  assert.equal(template.runtime_class_name, "openshell-skipper");
  assert.equal(pod.structValue.fields.runtime_class_name.stringValue, "openshell-skipper");
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
  await credentialWithdrawalChecks().confirmsCredentialWithdrawalWithWorkspace();
});

test("OpenShell withdrawal preserves cancellation before provider lookup", async (t) => {
  await credentialWithdrawalChecks().preservesWithdrawalCancellationBeforeProviderLookup(t);
});

// Finding 1642: a native worker that holds a failed model check never connects its node.
// Compute asks for the Codex bearer-passthrough exposure (APP_SERVER_PORT with the
// APP_TOKEN_SHA verifier) so it can read that held failure; the raw token never arrives.
test("OpenShell exposes a native OpenClaw worker's held-failure port when Compute asks for it", async () => {
  let storedSandbox;
  let createdServiceUrl = "http://native.example.test:9443/";
  let exposedService;
  const { requests, gatewayClient, service, driver, context, revision, exposing } =
    await prepareNativeHeldFailure({
      openShellDriver,
      runtimeSandboxFixture,
      getStoredSandbox: () => storedSandbox,
      setStoredSandbox: (value) => {
        storedSandbox = value;
      },
      getCreatedServiceUrl: () => createdServiceUrl,
      getExposedService: () => exposedService,
    });

  const { verifyNativeExposureCredentialBoundary } =
    await import("./sandbox-driver-native-held-failure-cases.ts");
  await verifyNativeExposureCredentialBoundary({
    driver,
    context,
    revision,
    exposing,
    requests,
    unsupportedError: SandboxRevisionUnsupportedError,
  });

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
  await verifyNativeHeldFailureWithdrawal({
    requests,
    gatewayClient,
    service,
    driver,
    context,
    revision,
    exposing,
    exposed,
    getExposedService: () => exposedService,
    setExposedService: (value) => {
      exposedService = value;
    },
    resetStoredSandbox: () => {
      storedSandbox = undefined;
    },
  });
});

test("OpenShell native startup creates private temporary state without changing the supervisor temporary directory", async () => {
  await harnessLifecycleChecks.createsPrivateNativeTemporaryState();
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
  const context = namespaceContext();
  const options = sandboxOf(sandboxInstallation());
  const selectedAgent = "agt_00000000-0000-4000-8000-000000000003";
  options.kubernetes.agentResources = {
    requests: { cpu: "1", memory: "1Gi", "example.com/gpu": "1" },
    limits: { cpu: "2", memory: "2Gi", "example.com/gpu": "1" },
  };
  options.kubernetes.agentResourceOverrides = [
    {
      namespaceId: "ns_00000000-0000-4000-8000-000000000002",
      agentId: selectedAgent,
      requests: { cpu: "4" },
      limits: { cpu: "4" },
    },
    {
      namespaceId: context.namespace.id,
      agentId: selectedAgent,
      requests: { cpu: "88", memory: "344Gi" },
      limits: { cpu: "90", memory: "352Gi" },
    },
  ];
  const driver = openShellDriver(gatewayClient, options);
  const revision = dedicatedRevision(driver, context, "000000000003");
  const provision = (environment = [], target = revision, owner = driver) =>
    owner.provisionHarness({
      ...context,
      revision: target,
      requirements: codexRequirements(target, environment),
    });

  const first = await provision();
  const name = first.resourceName;
  assert.deepEqual(
    calls.map(([call]) => call),
    ["getSandbox", "createSandbox"],
  );
  const agentResources = (sandbox) =>
    sandbox.spec.template.driver_config.fields.kubernetes.structValue.fields.containers.structValue
      .fields.agent.structValue.fields.resources.structValue.fields;
  const resources = (sandbox, section) =>
    Object.fromEntries(
      Object.entries(agentResources(sandbox)[section].structValue.fields).map(([name, value]) => [
        name,
        value.stringValue,
      ]),
    );
  const saved = sandboxes.get(name);
  assert.deepEqual(resources(saved, "requests"), {
    cpu: "88",
    memory: "344Gi",
    "example.com/gpu": "1",
    "ephemeral-storage": "256Mi",
  });
  assert.deepEqual(resources(saved, "limits"), {
    cpu: "90",
    memory: "352Gi",
    "example.com/gpu": "1",
    "ephemeral-storage": "1Gi",
  });
  const other = await provision([], dedicatedRevision(driver, context, "000000000004"));
  const otherTemplate = sandboxes.get(other.resourceName).spec.template;
  assert.equal(otherTemplate.runtime_class_name, "openshell-sandbox");
  assert.deepEqual(resources(sandboxes.get(other.resourceName), "requests"), {
    cpu: "1",
    memory: "1Gi",
    "example.com/gpu": "1",
    "ephemeral-storage": "256Mi",
  });
  assert.deepEqual(resources(sandboxes.get(other.resourceName), "limits"), {
    cpu: "2",
    memory: "2Gi",
    "example.com/gpu": "1",
    "ephemeral-storage": "1Gi",
  });
  // Restarting the controller with different sizing cannot adopt the stale Sandbox.
  const changedOptions = structuredClone(options);
  changedOptions.kubernetes.agentResourceOverrides[1].limits.cpu = "89";
  const changed = openShellDriver(gatewayClient, changedOptions);
  calls.length = 0;
  await assert.rejects(
    provision([], revision, changed),
    /without exact AgentRevision ownership and content/,
  );
  assert.deepEqual(calls, [["getSandbox", name, calls[0][2]]]);

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
  await verifySandboxAdoptionRefusals({ sandboxes, services, name, revision, provision });
});

test("OpenShell has the gateway restart an exited Harness and still adopts Sandboxes created without that policy", async () => {
  await harnessLifecycleChecks.restartsExitedHarnessAndAdoptsLegacySandboxes();
});

test("OpenShell moves a revision's create to a fresh request_id after the gateway refuses the old one", async () => {
  // OpenShell admits a request_id before running CreateSandbox and leaves it unresolved
  // forever if the handler errors, so reusing the revision UUID would never provision.
  let handlerError;
  let refuseEverything;
  let onRefusal;
  let holdHandler;
  let reachedHold;
  const replayState = {
    get handlerError() {
      return handlerError;
    },
    set handlerError(value) {
      handlerError = value;
    },
    get refuseEverything() {
      return refuseEverything;
    },
    set refuseEverything(value) {
      refuseEverything = value;
    },
    get onRefusal() {
      return onRefusal;
    },
    set onRefusal(value) {
      onRefusal = value;
    },
    get holdHandler() {
      return holdHandler;
    },
    set holdHandler(value) {
      holdHandler = value;
    },
    get reachedHold() {
      return reachedHold;
    },
    set reachedHold(value) {
      reachedHold = value;
    },
  };
  const { gatewayClient, sandboxes, provision, trace, id0 } = await prepareGatewayReplayFixture({
    openShellDriver,
    prepareProvision: (driver) => {
      const context = namespaceContext();
      const revision = dedicatedRevision(driver, context, "000000000004");
      return (target = driver) =>
        target.provisionHarness({
          ...context,
          revision,
          requirements: codexRequirements(revision),
        });
    },
    harnessService,
    storedSandbox,
    replayState,
  });

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
  await verifyConcurrentReplayAndExhaustion({ sandboxes, provision, trace, first, replayState });
});

test("OpenShell rejects raw app-server tokens as a permanent revision failure", async () => {
  await codexHarnessChecks.rejectRawAppServerTokens();
});

test("OpenShell rejects projected Agent identity before gateway mutation", async () => {
  await codexHarnessChecks.rejectProjectedAgentIdentity();
});

test("OpenShell Harness endpoints expose only the Backend public CA", async (t) => {
  await codexHarnessChecks.exposeOnlyBackendPublicCa(t);
});

test("OpenShell provisions dedicated Codex with bearer passthrough and provider files", async (t) => {
  const {
    driver,
    gatewayClient,
    compute,
    context,
    revision,
    runtimeManifest,
    codexConfig,
    nodeSetup,
    routeHost,
    spec,
    environment,
  } = await verifyDedicatedCodexStartup({
    t,
    sandboxInstallation: () => {
      const installation = sandboxInstallation();
      // Exercise the real-runtime fixture's policy: an incomplete filesystem override
      // makes OpenShell enrich the policy and advance its version during startup.
      installation.drivers.sandbox.configuration.policy = createOpenShellInstallationConfiguration({
        authentication: {},
        platformNamespace: "openclaw-system",
        gatewayImage: "gateway-fixture",
        codexImage: "codex-fixture",
        cluster: { name: "fixture" },
      }).drivers.sandbox.configuration.policy;
      return installation;
    },
    openShellDriver,
    runtimeSandboxFixture,
    conformanceKubernetesOptions,
    KubernetesComputeDriver,
  });
  assert.ok(spec.providers.includes(`oce-cs-${"b".repeat(24)}`));
  const runtimeProvider = spec.providers.find((name) => name.startsWith("oce-runtime-"));
  assert.ok(runtimeProvider);
  const { verifyDedicatedCodexProviderFiles } =
    await import("./sandbox-driver-dedicated-codex-provider-cases.ts");
  verifyDedicatedCodexProviderFiles({
    gatewayClient,
    runtimeProvider,
    runtimeManifest,
    codexConfig,
    nodeSetup,
  });
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

test("OpenShell keeps scratch separate from its durable data mount", async () => {
  await verifySandboxScratchStorage({ openShellDriver, runtimeSandboxFixture });
});

test("OpenShell holds withdrawn Codex authentication after a Harness restart", async (t) => {
  await codexHarnessChecks.holdWithdrawnCodexAuthentication(t);
});

// The command budget applies after Compute adds the workspace verifier and
// OpenShell adds links, setup wait and any account bootstrap to CreateSandbox.
test("OpenShell composes immutable commands from admitted Compute revisions", async (t) => {
  for (const [loginMode, hasSetup, admitted] of [
    ["codex_pat", true, true],
    ["codex_pat", false, true],
    ["codex_pat", true, false],
    ["codex_pat", false, false],
    ["chatgptAuthTokens", true, true],
  ]) {
    await t.test(`${loginMode}, setup ${hasSetup}, new admission ${admitted}`, async (t) => {
      const fixture = providerEndpointFixture({
        servicePrincipalCredentials: { mode: "disabled" },
        revisionOverrides: {
          id: "rev_2c9250cd-6aa2-4493-a73e-2422ec6c1537",
          agentId: "agt_9bee809d-62ec-4d41-b68d-25ead74b3a4d",
          servicePrincipalId: "spn_02aa5adc-0b5c-417d-b8d4-1a1de5157809",
        },
      });
      const { driver: compute, revision, sandbox } = fixture;
      const capture = captureOpenShellHarness(fixture, sandbox);
      const source = {
        id: "cs_324fc26c-59b3-43e0-b057-53fce26a2f19",
        namespaceId: revision.namespaceId,
        type: loginMode === "codex_pat" ? "codex-pat" : "codex-oauth",
        name: "fixture source",
        config: {},
        secrets: {},
        ownerCapability: "credential_gateway",
        driverId: "openshell-credentials",
        state: "ready",
        createdAt: revision.createdAt,
      };
      const ref = openShellProviderName(source.id);
      revision.harnessAuth = {
        method: "credential_source",
        sourceId: source.id,
        sourceType: source.type,
        credentialGatewayId: source.driverId,
        loginMode,
      };
      compute.credentialGatewayDriver = {
        id: source.driverId,
        capability: "credential_gateway",
        implementation: "openshell",
        listSourceTypes: async () => [
          { type: source.type, harnessAuth: { loginMode, modelProvider: "openai" } },
        ],
        attachForRevision: async () => [
          {
            sourceId: source.id,
            ref,
            ...(loginMode === "chatgptAuthTokens" && {
              externalChatgptAuth: {
                accessTokenPlaceholder: `openshell:resolve:env:s${"1".repeat(64)}_CODEX_ACCESS_TOKEN`,
                accountId: "fixture-account",
                planType: "business",
              },
            }),
          },
        ],
      };
      revision.configuration = capture.openshell.configureAgent(
        revision.configuration,
        revision.harness,
      );
      admitRevisionHarness(compute, revision);
      if (!admitted) {
        // Pre-upgrade PAT revisions did not save a Compute admission.
        delete revision.compute.admission;
      }
      const workspaceSetup = {
        id: "workspace-setup-1f8d6823-aa87-4cba-ae3e-62352e892d12",
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        defaultsId: WORKSPACE_DEFAULTS_ID,
        completed: false,
        files: { ...WORKSPACE_DEFAULTS, "AGENTS.md": "Private initial Agent instructions\n" },
      };
      const context = {
        harnessAuth: { ...revision.harnessAuth, source },
        ...(hasSetup && { workspaceSetup }),
      };
      const createSetup = compute.nodeEnrollment.createSetup;
      compute.nodeEnrollment.createSetup = async (url, nodeUrl) => {
        const setup = await createSetup(url, nodeUrl);
        return { ...setup, setupCode: tlsPinnedWorkspaceSetupCode(nodeUrl, setup.expiresAtMs) };
      };

      await fixture.prepare(undefined, context);
      fixture.setGatewayServing();
      // Let the real Compute enrollment write the Agent-owned Secret.
      const provision = (input = context) =>
        assert.rejects(fixture.prepare(undefined, input), (error) => error === capture.provisioned);
      await provision();
      const { name, spec } = capture.request;
      const { loader, supervisor, codex } = inspectOpenShellCodexCommand(t, spec.command, {
        compact: admitted && (hasSetup || loginMode === "codex_pat"),
        current: admitted,
      });
      if (!admitted) {
        // Stock 0.1.6 Compute and OpenShell at 4d68b3b7 render these exact commands.
        // Revisions with initial setup embed that release's workspace verifier.
        assert.equal(
          createHash("sha256").update(JSON.stringify(spec.command)).digest("hex"),
          hasSetup
            ? "b491545115bb907a872b0fe34b56cfc850dd684cd495ec280bb86e4a3f1cf3bc"
            : "a0d8025d10aeb7dbf26ca8271ad2cecb0eacb3ef1cd0bfafbf22ce251d9bd1fa",
        );
      }
      assert.equal((loader + supervisor).includes(".oce-workspace-setup.json"), hasSetup);
      if (hasSetup) {
        assert.match(supervisor, new RegExp(workspaceSetup.id));
        assert.doesNotMatch(supervisor, /Private initial Agent instructions/);
      }
      assert.equal(
        codex.includes("unsupported_l7_protocol"),
        admitted && loginMode === "codex_pat",
      );
      assert.equal(spec.environment.CODEX_LOGIN_MODE, loginMode);
      assert.equal(
        spec.environment.OCE_CODEX_CREDENTIAL_SOURCE,
        loginMode === "codex_pat" ? "1" : undefined,
      );
      assert.equal(
        (loader + supervisor).includes("OCE_CODEX_CHATGPT_ACCOUNT"),
        loginMode === "chatgptAuthTokens",
      );

      if (!admitted && hasSetup) {
        // Completing setup keeps the legacy Sandbox adoptable, while even one
        // byte of command drift in its stored spec must be refused.
        await provision({
          ...context,
          workspaceSetup: { ...workspaceSetup, files: {}, completed: true },
        });
        capture.gateway.sandboxes.get(name).spec.command[7] += " ";
        await assert.rejects(
          fixture.prepare(undefined, context),
          /without exact AgentRevision ownership and content/,
        );
      }
    });
  }
});

for (const harnessId of ["codex", "openclaw"]) {
  test(`OpenShell delivers ${harnessId} initial workspace files privately after supervisor readiness`, async (t) => {
    const gatewayClient = workspaceGatewayClient();
    const driver = openShellDriver(gatewayClient);
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
    let executionError;
    gatewayClient.execSandbox = async (request) => {
      executions.push(request);
      if (executionError !== undefined) {
        throw executionError;
      }
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
    await assert.rejects(provision(), {
      message: "OpenShell workspace initialization failed (initializer exit 1).",
    });
    for (const [status, stage] of [
      [3, "native setup failed"],
      [4, "native setup timed out"],
    ]) {
      exitCode = status;
      await assert.rejects(provision(), {
        message: `OpenShell workspace initialization failed (${stage}; initializer exit ${status}).`,
      });
    }
    // Only the protocol's numeric status is public; error text can contain private files.
    executionError = Object.assign(new Error("private native output"), { grpcStatus: 14 });
    await assert.rejects(provision(), {
      message: "OpenShell workspace initialization failed (gRPC status 14).",
    });
    executionError.grpcStatus = "private native output";
    await assert.rejects(provision(), {
      message: "OpenShell workspace initialization failed.",
    });
    executionError = undefined;
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

    await t.test("setup wrapper preserves initializer diagnostics", async (t) => {
      await verifyWorkspaceWrapperDiagnostics({ t, execution, setup });
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
          const root = await temporaryDirectory(t, "openshell-workspace-setup-");
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
                  // The concurrent initializer containers share these test-owned mounts on SELinux.
                  "--volume",
                  `${workspace}:/sandbox/enterprise:z`,
                  "--volume",
                  `${home}:/sandbox/.openclaw-runtime/home:z`,
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

function prepareRevisionObservationProvision(driver) {
  const { context, revision, requirements } = runtimeSandboxFixture(driver);
  return () => driver.provisionHarness({ ...context, revision, requirements });
}

test("OpenShell retains the revision provider when Sandbox creation has an unknown outcome", async () => {
  await verifyRevisionProviderRetention({
    openShellDriver,
    prepareProvision: prepareRevisionObservationProvision,
    storedSandbox,
    callCount,
  });
});

registerSandboxDriverWorkspaceRenewalCases({
  openShellDriver,
  runtimeSandboxFixture,
  callCount,
});

test("OpenShell rejects unexpected annotations on an existing Sandbox", async () => {
  await verifyForeignSandboxAnnotations({
    openShellDriver,
    prepareProvision: prepareRevisionObservationProvision,
  });
});

registerSandboxDriverWorkspaceExpiryCases({
  openShellDriver,
  runtimeSandboxFixture,
  storedSandbox,
  harnessService,
  callCount,
});

test("OpenShell rejects unsupported or foreign Codex runtime providers before Sandbox creation", async (t) => {
  await sandboxStartupGuardChecks().rejectsUnsupportedOrForeignRuntimeProviders(t);
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
});

test("OpenShell operator mode owns workspace chart resources around the Workspace lifecycle", () =>
  verifyOperatorWorkspaceChart({ openShellDriver, namespaceContext, kubernetesObjectClient }));

test("OpenShell managed mode fails before mutating Kubernetes or the Gateway", async () => {
  await verifyManagedNamespaceRejectsMutation({
    sandboxInstallation,
    openShellDriver,
    namespaceContext,
    kubernetesObjectClient,
  });
});

// The wait slept a whole poll interval past its deadline: timeoutMs 30000 with pollIntervalMs
// 600000 checked again only after ten minutes (finding 2324).
test("OpenShell gateway readiness checks once more at its deadline, not a poll interval later", async () => {
  const configuration = sandboxInstallation().drivers.sandbox.configuration;
  configuration.gateway.readiness = {
    serviceName: "openshell-gateway",
    podSelector: { "app.kubernetes.io/name": "openshell" },
    // The first check must finish before the deadline, or the wait throws after one check. With 50 ms
    // a CPU-starved runner sometimes finished it too late; 1 s leaves room and stays inside the 10 s abort.
    timeoutMs: 1_000,
    pollIntervalMs: 600_000,
  };
  const gatewayClient = workspaceGatewayClient();
  const driver = openShellDriver(gatewayClient, configuration);
  const context = namespaceContext();
  const kubernetes = kubernetesObjectClient([]);
  kubernetes.read = async (resource) => resource;
  let podLists = 0;
  kubernetes.list = async () => {
    podLists += 1;
    return { items: [{ status: { conditions: [{ type: "Ready", status: "False" }] } }] };
  };
  context.kubernetes = kubernetes;
  // A wait that sleeps the whole poll interval is aborted here instead of after ten minutes.
  context.signal = AbortSignal.timeout(10_000);

  await assert.rejects(driver.ensureNamespace(context), /OpenShell gateway Pod is not ready\./);
  // A timer can wake a millisecond before Date.now() reaches the deadline, adding a check.
  assert.ok(podLists >= 2, "one check at the start and another at the deadline");
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
  await sandboxStartupGuardChecks().refusesControllerIdentity();
});

// Each test below changes settings of a valid installation, and startup refuses each change.
const sandboxOf = (c) => c.drivers.sandbox.configuration;

// The gateway refuses these in CreateSandbox, which runs only after a dedicated deploy has
// stopped its predecessors, so startup applies the same rules (findings 2331-2333).
const invalidValue = (path, message) => [{ path, code: "INVALID_VALUE", message }];

// A non-object ingress rule cannot be mapped for the client; startup names the field instead of
// the apply failing later.
test("startup refuses NetworkPolicy ingress rules that are not objects", async (t) => {
  await sandboxStartupGuardChecks().refusesNonObjectNetworkPolicyIngress(t);
});

/**
 * The OpenShell Credential Gateway over a recording provider store. Each provider's labels say
 * which credential source owns it; the gateway may act only on its own source's provider.
 * Kept beside the OpenShell Sandbox cases: both members come from one OpenShell Backend.
 */
function credentialGatewayOverProviders({
  keepDeleted = false,
  toolBinaries,
  refresh = false,
} = {}) {
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
          drivers: {
            credential_gateway: "credential-gateway-openshell",
            ...(refresh && { credential_refresh: "credential-refresh-openshell" }),
          },
          client: {
            clientForNamespace: () => client,
            credentialClientForNamespace: () => client,
            placement: () => undefined,
          },
        },
      },
    );
  const driver = driverWith({ toolBinaries });
  const { source, context, revisionContext } = createCredentialGatewayContexts(driver.id);
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
    context,
    revisionContext,
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

const providerProfileChecks = createSandboxProviderProfileChecks({
  credentialGatewayOverProviders,
  ready,
  ScopeViolationError,
});
const credentialContractChecks = createSandboxCredentialContractChecks({
  credentialGatewayOverProviders,
  ready,
  structuralRefusal,
});

async function ready(operation) {
  assert.deepEqual(await operation, { state: "ready" });
}

test("Codex PAT profiles restrict native startup and plugin routes", async () => {
  await providerProfileChecks.restrictCodexPatNativeStartupAndPluginRoutes();
});

test("each Codex PAT source gets its own provider profile, stable across replays", async () => {
  await providerProfileChecks.keepCodexPatProviderProfilesDistinctAcrossReplays();
});

test("the OpenShell Credential Gateway acts only on its own source's provider", async () => {
  await providerProfileChecks.restrictGatewayToItsOwnedProvider();
});

test("OpenShell preserves the main-era owned profile lifecycle without a migration", async () => {
  await providerProfileChecks.preserveOwnedProfileLifecycle();
});

test("OpenShell main-era interrupted registration survives restart without replaying credentials", async () => {
  await providerProfileChecks.resumeInterruptedRegistrationWithoutCredentialReplay();
});

test("OpenShell main-era cleanup resumes after provider deletion without losing another source", async () => {
  await providerProfileChecks.resumeCleanupWithoutLosingAnotherSource();
});

test("OpenShell concurrent registrations preserve the first provider's credentials", async () => {
  await providerProfileChecks.preserveFirstProviderCredentialsDuringConcurrentRegistration();
});

test("OpenShell rejects a foreign provider appearing after preflight without erasing the profile", async () => {
  await providerProfileChecks.rejectForeignProviderAfterPreflight();
});

test("OpenShell registration does not adopt an unknown provider create outcome", async () => {
  await providerProfileChecks.rejectUnknownProviderCreateOutcome();
});

test("the OpenShell Credential Gateway never attaches a source of another Namespace", async () => {
  await providerProfileChecks.rejectCrossNamespaceAttachment();
});

test("the OpenShell Credential Gateway refuses an empty secret before creating a provider", async () => {
  await providerProfileChecks.rejectEmptySecretBeforeProviderCreation();
});

test("OpenShell credential source removal fails while the provider survives deletion", async () => {
  await providerProfileChecks.failRemovalWhenProviderSurvivesDeletion();
});

test("Google requires an OAuth source whose effective binary list is exactly the pinned executable", async () => {
  const pinned = managedGoogleInstall.binaryPath;
  const other = "/usr/bin/curl";
  const sourceId = "cs_00000000-0000-4000-8000-0000000000e9";
  const config = {
    host: "gmail.googleapis.com",
    path: "/gmail/v1/users/me/messages",
    token_url: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    client_id: "test-client",
    env_var: "GOG_ACCESS_TOKEN",
  };
  for (const [list, binary, acceptable] of [
    [[pinned], undefined, true],
    [[pinned, other, "/opt/tools/*"], pinned, true],
    [[pinned, other], undefined, false],
  ]) {
    const f = credentialGatewayOverProviders({ toolBinaries: list, refresh: true });
    const context = f.context(sourceId);
    const source = {
      ...context.source,
      type: "oauth2-refresh-token",
      config: { ...config, ...(binary && { binary }) },
    };
    const register = (config) =>
      f.driver.registerSource({ ...context, source }, { type: source.type, config, secrets: {} });
    for (const invalid of ["/tmp/other", "/opt/tools/*"]) {
      await assert.rejects(
        register({ ...source.config, binary: invalid }),
        /installation toolBinaries/,
      );
    }
    assert.deepEqual(f.profileWrites, []);
    await register(source.config);
    assert.deepEqual(
      f.profiles.get(openShellProviderName(sourceId)).binaries,
      binary ? [binary] : list,
    );
    const attachment = f.revisionContext([source]);
    attachment.revision.plugins = {
      driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
      plugins: {
        [managedGoogleInstall.id]: {
          enabled: true,
          driverPolicy: {
            releaseSha256: managedGoogleInstall.releaseSha256,
            credentials: { account: sourceId },
          },
        },
      },
    };
    if (acceptable) {
      const service = negotiatedGoogleGuard();
      f.client.getGatewayInfo = async () => ({ extensions: [service] });
      service.implementation_version = "old-release";
      await assert.rejects(f.driver.attachForRevision(attachment), /has not negotiated/);
      Object.assign(service, negotiatedGoogleGuard());
      assert.deepEqual(await f.driver.attachForRevision(attachment), [
        {
          sourceId,
          ref: openShellProviderName(sourceId),
          requestScope: {
            host: "gmail.googleapis.com",
            port: 443,
            path: "/gmail/v1/users/me/messages",
            scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
          },
        },
      ]);
    } else {
      await assert.rejects(
        f.driver.attachForRevision(attachment),
        /grant only the pinned Google executable/,
      );
    }
    assert.deepEqual(
      f.profileWrites.map(([operation]) => operation),
      ["import"],
    );
  }
});

test("a Slack MCP source stays independent and cannot acquire a broad REST credential route", async () => {
  const f = credentialGatewayOverProviders({
    toolBinaries: ["/usr/bin/curl", "/usr/local/bin/node"],
  });
  const sourceId = "cs_00000000-0000-4000-8000-000000000092";
  const context = f.context(sourceId);
  const config = {
    protocol: "mcp",
    host: "mcp.slack.com",
    path: "/mcp",
    env_var: "SLACK_MCP_TOKEN",
  };
  const source = {
    ...context.source,
    type: "bearer-token",
    config,
    secrets: { token: { kind: "secret", id: "sec_mcp", namespaceId: context.namespace.id } },
  };
  const sourceContext = { ...context, source };
  const register = (config) =>
    f.driver.registerSource(sourceContext, {
      type: source.type,
      config,
      secrets: { token: "synthetic-slack-bearer" },
    });
  await assert.rejects(register({ ...config, path: "/**" }), /reviewed settings/);
  await assert.rejects(register({ ...config, protocol: "rest" }), /reviewed settings/);
  assert.deepEqual(f.profileWrites, []);
  await register(config);
  const ref = openShellProviderName(sourceId);
  const profile = f.profiles.get(ref);
  assert.deepEqual(profile.binaries, ["/usr/local/bin/node"]);
  assert.equal(profile.endpoints[0].protocol, "mcp");
  assert.equal(profile.endpoints[0].access, undefined);
  assert.deepEqual(profile.endpoints[0].rules, [{ allow: { method: "ping" } }]);
  assert.deepEqual(await f.driver.attachForRevision(f.revisionContext([source])), [
    {
      sourceId,
      ref,
      requestScope: {
        host: "mcp.slack.com",
        port: 443,
        path: "/mcp",
        scopes: [],
      },
    },
  ]);
  const legacy = {
    ...source,
    id: "cs_00000000-0000-4000-8000-000000000093",
    config: { ...config, env_var: "LEGACY_SLACK_TOKEN" },
  };
  delete legacy.config.protocol;
  await assert.rejects(
    f.driver.attachForRevision(f.revisionContext([source, legacy])),
    /conflicts with another credential for its host/,
  );
});

test("the OpenShell bearer-token type exists only with toolBinaries and validates its endpoint", async () => {
  await credentialContractChecks.validatesBearerTokenTypeAndEndpoint();
});

test("narrowing OpenShell toolBinaries narrows existing bearer-token sources on update and deployment", async () => {
  await credentialContractChecks.narrowsExistingBearerTokenSources();
});

test("an OpenShell profile write that lost a race to the same profile still attaches", async () => {
  await credentialContractChecks.attachesAfterMatchingProfileRace();
});

test("an OpenShell bearer-token source stays deletable after toolBinaries is removed", async () => {
  await credentialContractChecks.removesBearerTokenSourceWithoutToolBinaries();
});

test("OpenShell observes the Codex Harness through its exact bearer-passthrough service", async () => {
  await verifySandboxDriverHarnessObservation({
    openShellDriver,
    runtimeSandboxFixture,
    sandboxInstallation,
    TransientDependencyError,
  });
});

test("OpenShell startup admits exactly the endpoints both consumers can parse and dial", async (t) => {
  // Each consumer parses the endpoint once per gateway call: the gRPC path through its
  // service URL normalization, the service transport through its connect target.
  const consumers = {
    grpc: (endpoint) => normalizeServiceUrl("http://service.example.test/", endpoint),
    service: (endpoint) =>
      serviceTarget({ endpoint, requestTimeoutMs: 1000 }, "http://service.example.test/"),
  };
  await verifyEndpointAdmission(t, buildEndpointInstallation, consumers);
});

// These codecs test the stock/product boundary, not installed supervisor capabilities.
test("stock OpenShell v0.1.5 cannot carry OCE readiness-extension evidence", async () => {
  const loader = controllerRequire("@grpc/proto-loader");
  const options = { keepCase: true, longs: String, enums: String, defaults: false };
  const stock = await loader.load(
    join(import.meta.dirname, "../fixtures/openshell-v0.1.5-wire.proto"),
    options,
  );
  const product = await loader.load(
    join(
      import.meta.dirname,
      "../../apps/controller/src/drivers/sandbox/proto/openshell-gateway.proto",
    ),
    options,
  );
  const message = "openshell.v1.ProviderReadinessStatus";
  const { verifyStockReadinessEvidence } =
    await import("./sandbox-driver-stock-readiness-cases.ts");
  verifyStockReadinessEvidence(product[message], stock[message]);
  const policyStatus = "openshell.v1.GetSandboxPolicyStatusResponse";
  const enforcement = {
    sandbox_id: "sandbox-one",
    enforced_capabilities: ["test-only-capability"],
  };
  const policyEvidence = {
    active_version: 1,
    loaded_enforcement: enforcement,
    loaded_policy_observation: { source_policy_hash: "policy-one", enforcement },
  };
  const policyBytes = product[policyStatus].serialize(policyEvidence);
  assert.deepEqual(product[policyStatus].deserialize(policyBytes), policyEvidence);
  const stockPolicy = stock[policyStatus].deserialize(policyBytes);
  assert.deepEqual(stockPolicy, { active_version: 1 });
  assert.deepEqual(product[policyStatus].deserialize(stock[policyStatus].serialize(stockPolicy)), {
    active_version: 1,
  });
  const spec = "openshell.v1.SandboxSpec";
  const epoch = { provider_attachment_epoch: "epoch-one" };
  const specBytes = product[spec].serialize(epoch);
  assert.deepEqual(product[spec].deserialize(specBytes), epoch);
  const stockSpec = stock[spec].deserialize(specBytes);
  assert.deepEqual(stockSpec, {});
  assert.deepEqual(product[spec].deserialize(stock[spec].serialize(stockSpec)), {});
});

test("installation refuses OpenShell repository credentials before reading session or provider inputs", async (t) => {
  const configuration = sandboxInstallation();
  const id = "repository-credentials";
  configuration.backend.push({
    id: "github-primary",
    type: "github",
    configuration: { registryPath: "/absent/repositories.json" },
    drivers: { repo: id },
  });
  configuration.repository = {
    id,
    configuration: { sessionDurationSeconds: 600 },
    preparedGitHub: {
      custodyKeyPath: "/absent/custody",
      privateKeyPath: "/absent/app-key.pem",
    },
  };
  await assert.rejects(
    loadInstallationFile(t, configuration),
    /repository requires explicitly selected protected Git delivery/,
  );
});

test("observed-hook preview recognizes a released Codex through its authenticated WebSocket", async (t) => {
  const token = "fixture-preview-transport";
  let acknowledged = false;
  let serving = true;
  let status = 400;
  let upgrades = 0;
  // Native Codex answers ordinary HTTP with 400 after its launch endpoint closes.
  // Real HTTP/WebSocket transport proves this Driver check; the recorded release is its input.
  const server = createServer((_request, response) => {
    response.writeHead(status);
    response.end("WebSocket upgrade required");
  });
  server.on("upgrade", (request, socket) => {
    upgrades++;
    socket.on("error", () => {});
    if (!serving || request.headers.authorization !== `Bearer ${token}`) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const accept = createHash("sha1")
      .update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
  });
  // listen() closes the server when the test ends, after destroying every connection,
  // including the upgraded sockets the HTTP server no longer tracks.
  const port = await listen(t, server);
  const transport = new GrpcOpenShellGatewayClient({ endpoint: `http://127.0.0.1:${port}` });
  t.after(() => transport.close());
  const gateway = workspaceGatewayClient();
  gateway.getServiceDocument = (...args) => transport.getServiceDocument(...args);
  gateway.serviceWebSocketHandshake = (...args) => transport.serviceWebSocketHandshake(...args);
  gateway.getService = async (_workspace, sandbox, name) =>
    harnessService(sandbox, name, "http://preview--codex.openshell.test/");
  gateway.getSandbox = async () => ({ id: "preview-sandbox" });
  const git = {
    configuration: { observedHookPreviewWorkspace: namespaceContext().namespace.name },
    overlappingPolicy: () => undefined,
    previewReleased: () => acknowledged,
  };
  const driver = new OpenShellSandboxDriver(sandboxInstallation().drivers.sandbox.configuration, {
    id: "openshell-sandbox",
    backend: backendFor(gateway),
    openShellGit: git,
  });
  const { context, revision, requirements } = runtimeSandboxFixture(driver);
  revision.executionAdmission = { version: 6, mode: "protected" };
  const registry = {
    version: 1,
    backendId: "github-primary",
    providerInstanceId: "github-com-primary",
    appId: "12345",
    githubInstallationId: "67890",
    maximumDurationSeconds: 600,
    repositories: [],
    installationAccess: {
      repositoryRef: "installation",
      namespaces: [{ namespaceId: revision.namespaceId, accessMode: "installation" }],
    },
  };
  revision.repositoryCredentials = {
    driver: { id: "repository", implementation: "github" },
    deadlineWallMs: Date.now() + 600000,
    bindings: [
      resolveGitHubRepositoryBinding(registry, {
        namespaceId: revision.namespaceId,
        repositoryRef: "installation",
        profile: "github-installation",
      }),
    ],
  };
  const plan = {
    id: randomUUID(),
    generation: 1,
    routes: [],
    driver: { id: driver.id, implementation: "openshell", configurationId: "a".repeat(64) },
    execution: {
      installationId: "ins_fixture",
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      servicePrincipalId: "sp_fixture",
      revisionId: revision.id,
      executionId: randomUUID(),
    },
    repositoryGit: revision.repositoryCredentials,
    repositoryGitAuthorization: "request-hook-observed",
  };
  revision.egressPlan = plan;
  const input = { ...context, revision, requirements, transportToken: token };
  const installation = { plan, sandboxId: "preview-sandbox" };
  const release = () => assert.fail("an acknowledged release must never be sent again");
  // A serving socket without a receipt, or a receipt without an authenticated socket, stays pending.
  assert.equal(await driver.observeHeldRepositoryGitPreview(input), undefined);
  await assert.rejects(driver.enrollHarness(input, installation, release), /Cannot verify/);
  acknowledged = true;
  serving = false;
  assert.equal(await driver.observeHeldRepositoryGitPreview(input), undefined);
  await assert.rejects(driver.enrollHarness(input, installation, release), /Cannot verify/);
  serving = true;
  // Only a closed launch endpoint may fall back to the acknowledged serving socket.
  for (status of [400, 404, 403, 503, 204]) {
    const allowed = status === 400 || status === 404;
    let before = upgrades;
    assert.equal(
      await driver.observeHeldRepositoryGitPreview(input),
      allowed ? "installed" : undefined,
      `observation status ${status}`,
    );
    assert.equal(upgrades - before, allowed ? 1 : 0, `observation upgrades for ${status}`);
    before = upgrades;
    if (allowed) {
      await driver.enrollHarness(input, installation, release);
    } else {
      await assert.rejects(driver.enrollHarness(input, installation, release), /Cannot verify/);
    }
    assert.equal(upgrades - before, allowed ? 1 : 0, `enrollment upgrades for ${status}`);
  }
});

test("OpenShell refuses repository provision and enrollment before any gateway or release call", async () => {
  const gateway = workspaceGatewayClient();
  const driver = openShellDriver(gateway);
  const refusal = { code: "SANDBOX_REPOSITORY_RECIPIENT_UNVERIFIED" };
  let releases = 0;
  for (const select of [
    ({ revision }) => (revision.repositoryCredentials = {}),
    ({ requirements }) => (requirements.repositorySession = {}),
    ({ requirements: { environment } }) =>
      environment.push({ name: "OPENCLAW_REPOSITORY_ENROLLMENT", value: "{}" }),
  ]) {
    const { context, revision, requirements } = runtimeSandboxFixture(driver);
    const input = { ...context, revision, requirements };
    select(input);
    await assert.rejects(driver.provisionHarness(input), refusal);
    await assert.rejects(
      driver.enrollHarness(input, {}, () => releases++),
      refusal,
    );
    assert.equal(releases, 0);
    assert.deepEqual(gateway.calls, []);
  }
});

// These cases invoke the production Driver over controlled Kubernetes/Gateway
// transports. They prove cleanup selection, fencing and completion ordering, not
// Kubernetes garbage collection, filesystem isolation, or live Pod termination.
async function orphanedNativePreparation({
  scratch = false,
  dataMountPath = "/sandbox/enterprise",
} = {}) {
  const gateway = workspaceGatewayClient();
  gateway.deleteSandbox = async () => gateway.calls.push(["deleteSandbox"]);
  const configuration = sandboxInstallation().drivers.sandbox.configuration;
  configuration.kubernetes.userNamespaces = false;
  configuration.kubernetes.sandboxDataMount.mountPath = dataMountPath;
  const driver = openShellDriver(gateway, configuration);
  const fixture = runtimeSandboxFixture(driver, { harnessId: "openclaw" });
  fixture.revision = completeWorkspaceRevision(fixture.revision, fixture.requirements);
  // Revision cleanup confirms an absent Sandbox through the Workspace ensureNamespace created.
  const { name, id } = fixture.context.namespace;
  gateway.workspaces.set(name, ownedWorkspace(name, id));
  const { revision, requirements, prepared } = fixture;
  if (scratch) {
    requirements.workspaceMounts.push({
      claimName: "operator-scratch",
      subPath: "scratch",
      mountPath: "/sandbox/scratch",
      readOnly: false,
    });
  }
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

registerSandboxDriverNativePreparationCases(orphanedNativePreparation);

registerSandboxDriverPreparerCleanupCases({
  orphanedNativePreparation,
  labelSelectorLabels,
});

test("OpenShell verifies operator NetworkPolicy from actual KubernetesObjectApi deserialization", async () => {
  const configuration = sandboxInstallation().drivers.sandbox.configuration;
  const policy = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: "operator-ingress" },
    spec: {
      podSelector: { matchLabels: { app: "sandbox" } },
      policyTypes: ["Ingress"],
      ingress: [
        {
          from: [{ podSelector: { matchLabels: { app: "worker" } } }],
          ports: [{ protocol: "TCP", port: 8080 }],
        },
      ],
    },
  };
  configuration.gateway.networkPolicyResources = [policy];
  const gatewayClient = workspaceGatewayClient();
  const driver = new OpenShellSandboxDriver(configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gatewayClient),
    operatorOwnedKubernetesResources: true,
  });
  const context = namespaceContext();
  const api = new KubernetesObjectApi();
  const metadata = {
    ...policy.metadata,
    namespace: context.namespace.name,
    labels: {
      "app.kubernetes.io/managed-by": "openclaw-enterprise",
      "openclaw.dev/namespace": context.namespace.id,
    },
    annotations: { "openclaw.dev/namespace-id": context.namespace.id },
  };
  let wire = { ...structuredClone(policy), metadata };
  // Replace transport only: read() still resolves the resource and processes the SDK response.
  api.apiVersionResourceCache = {
    v1: { resources: [{ name: "namespaces", kind: "Namespace", namespaced: false }] },
    "networking.k8s.io/v1": {
      resources: [{ name: "networkpolicies", kind: "NetworkPolicy", namespaced: true }],
    },
  };
  const { createConfiguration, ServerConfiguration } = controllerRequire("@kubernetes/client-node");
  api.configuration = createConfiguration({
    baseServer: new ServerConfiguration("http://127.0.0.1:9", {}),
  });
  api.requestPromise = async (request) => {
    const value = request.getUrl().includes("/networkpolicies/")
      ? wire
      : { apiVersion: "v1", kind: "Namespace", metadata: { name: context.namespace.name } };
    return api.processResponse({
      httpStatusCode: 200,
      headers: { "content-type": "application/json" },
      body: { text: async () => JSON.stringify(value) },
    });
  };
  context.kubernetes = api;
  const observed = await api.read(wire);
  await verifyOperatorPolicyDrift({
    observed,
    driver,
    context,
    gatewayClient,
    callCount,
    policy,
    metadata,
    setWire: (value) => {
      wire = value;
    },
  });

  // Configuration is a wire manifest: an SDK-only alias is refused at startup, before any
  // comparison could repair it into a match.
  await verifyOperatorAliasesRejected({
    configuration,
    gatewayClient,
    backendFor,
    SharedConfigurationValidationError,
  });

  // Match the API server's omission of empty rule lists without admitting an
  // allow-all rule or a change to which Pods/directions the policy isolates.
  const denyConfiguration = structuredClone(configuration);
  const denyPolicy = {
    ...policy,
    spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"], ingress: [], egress: [] },
  };
  denyConfiguration.gateway.networkPolicyResources = [denyPolicy];
  const denyDriver = new OpenShellSandboxDriver(denyConfiguration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gatewayClient),
    operatorOwnedKubernetesResources: true,
  });
  wire = { ...structuredClone(denyPolicy), metadata };
  delete wire.spec.ingress;
  delete wire.spec.egress;
  await denyDriver.ensureNamespace(context);
  for (const changed of [
    { ingress: [{}] },
    { egress: [{}] },
    { policyTypes: ["Ingress"] },
    { podSelector: { matchLabels: { app: "other" } } },
  ]) {
    wire = { ...denyPolicy, metadata, spec: { ...denyPolicy.spec, ...changed } };
    await assert.rejects(
      denyDriver.ensureNamespace(context),
      /Operator workspace resource does not match/,
    );
  }
});

/**
 * A real KubernetesObjectApi for `discovery` ({ apiVersion: [[kind, plural]] }) whose HTTP
 * transport records each request and echoes its body. The SDK's request serialization stays
 * real, so `applied` holds exactly what the API server would receive.
 */
function recordingObjectApi(discovery) {
  const { createConfiguration, ServerConfiguration } = controllerRequire("@kubernetes/client-node");
  const api = new KubernetesObjectApi(
    createConfiguration({ baseServer: new ServerConfiguration("http://127.0.0.1:9", {}) }),
  );
  api.apiVersionResourceCache = Object.fromEntries(
    Object.entries(discovery).map(([apiVersion, kinds]) => [
      apiVersion,
      { resources: kinds.map(([kind, name]) => ({ name, kind, namespaced: true })) },
    ]),
  );
  const applied = [];
  api.requestPromise = async (request) => {
    applied.push([request.getHttpMethod(), JSON.parse(request.getBody())]);
    return api.processResponse({
      httpStatusCode: 200,
      headers: { "content-type": "application/json" },
      body: { text: async () => request.getBody() },
    });
  };
  return { api, applied };
}

// Finding 3110: KubernetesObjectApi serializes ingress sources only from its `_from` alias, so the
// wire `from` of a workspace-chart policy was dropped and the rule lost its source restriction.
test("OpenShell operator mode applies NetworkPolicy ingress sources through the SDK serializer", async () => {
  const configuration = sandboxInstallation().drivers.sandbox.configuration;
  // The stock OpenShell workspace chart's SSH policy as occ dev renders it, in wire form.
  const ingress = [
    {
      from: [
        {
          namespaceSelector: {
            matchLabels: { "kubernetes.io/metadata.name": "openshell-system" },
          },
          podSelector: { matchLabels: { "app.kubernetes.io/instance": "openshell-gateway" } },
        },
      ],
      ports: [{ protocol: "TCP", port: 2222 }],
    },
  ];
  const policy = (name) => ({
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name },
    spec: {
      podSelector: { matchLabels: { "openshell.ai/managed-by": "openshell" } },
      policyTypes: ["Ingress"],
      ingress: structuredClone(ingress),
    },
  });
  // A provider CRD that is also named NetworkPolicy has no SDK model: the client sends it as
  // written, so renaming its `from` would make the API server drop the field.
  const crdIngress = [{ action: "Allow", ...structuredClone(ingress[0]) }];
  const crdPolicy = {
    apiVersion: "crd.antrea.io/v1beta1",
    kind: "NetworkPolicy",
    metadata: { name: "provider-crd-ingress" },
    spec: {
      appliedTo: [{ podSelector: { matchLabels: { "openshell.ai/managed-by": "openshell" } } }],
      ingress: structuredClone(crdIngress),
    },
  };
  configuration.gateway.operatorWorkspaceResources = [policy("openshell-workspace-sandbox-ssh")];
  configuration.gateway.networkPolicyResources = [policy("provider-ingress"), crdPolicy];
  const gatewayClient = workspaceGatewayClient();
  const driver = openShellDriver(gatewayClient, configuration);
  const context = namespaceContext();
  const { api, applied } = recordingObjectApi({
    "networking.k8s.io/v1": [["NetworkPolicy", "networkpolicies"]],
    "crd.antrea.io/v1beta1": [["NetworkPolicy", "networkpolicies"]],
  });
  context.kubernetes = api;

  await driver.ensureNamespace(context);
  // Both lists reach the API server with their source restriction intact; the CRD body keeps
  // its wire `from` and carries no `_from`.
  assert.deepEqual(
    applied.map(([method, body]) => [method, body.metadata.name, body.spec.ingress]),
    [
      ["PATCH", "openshell-workspace-sandbox-ssh", ingress],
      ["PATCH", "provider-ingress", ingress],
      ["PATCH", "provider-crd-ingress", crdIngress],
    ],
  );
  assert.equal(callCount(gatewayClient, "createWorkspace"), 1);
  // The operator's configuration stays the wire manifest it supplied.
  assert.deepEqual(configuration.gateway.operatorWorkspaceResources[0].spec.ingress, ingress);
});

// Finding 3111: the client's typed serializer drops every key its model lacks, at any depth, and
// the wire name of a renamed field. Startup names the exact field instead of letting the apply
// widen a rule: a misspelled selector key would otherwise be sent as `{}`, which selects all Pods.
test("startup refuses operator Kubernetes fields the client would not send as written", async (t) => {
  await sandboxStartupGuardChecks().refusesUnsentKubernetesFields(t);
});

// Finding 3111 controls: what the client already applies exactly as written still starts and is
// applied unchanged. The stock chart covers the four workspace kinds; the provider policy holds
// value forms the typed serializer passes through (int-or-string, null, empty lists and objects).
test("OpenShell startup admits and applies the stock workspace chart exactly as written", async (t) => {
  const { chart, forms, crd, installation } = await prepareStockWorkspaceChart({
    t,
    sandboxInstallation,
    sandboxOf,
    openShellWorkspaceChartResources,
  });

  const driver = openShellDriver(workspaceGatewayClient(), sandboxOf(installation));
  const context = namespaceContext();
  const { api, applied } = recordingObjectApi({
    v1: [["ServiceAccount", "serviceaccounts"]],
    "rbac.authorization.k8s.io/v1": [
      ["Role", "roles"],
      ["RoleBinding", "rolebindings"],
    ],
    "networking.k8s.io/v1": [["NetworkPolicy", "networkpolicies"]],
    "crd.antrea.io/v1beta1": [["NetworkPolicy", "networkpolicies"]],
  });
  context.kubernetes = api;
  await driver.ensureNamespace(context);
  // Each body is the manifest plus only the namespace and ownership metadata the Driver adds.
  const owned = (resource) => ({
    ...resource,
    metadata: {
      ...resource.metadata,
      namespace: context.namespace.name,
      labels: {
        ...resource.metadata.labels,
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace": context.namespace.id,
      },
      annotations: { "openclaw.dev/namespace-id": context.namespace.id },
    },
  });
  assert.deepEqual(
    applied,
    [...chart, forms, crd].map((resource) => ["PATCH", owned(resource)]),
  );
});

for (const kind of ["Role", "RoleBinding"]) {
  test(`OpenShell verifies operator ${kind} from actual KubernetesObjectApi deserialization`, async () => {
    const context = namespaceContext();
    const role = {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      metadata: { name: "workspace-reader" },
      rules: [{ apiGroups: [""], resources: ["pods"], verbs: ["get"] }],
    };
    const binding = {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: { name: "workspace-reader" },
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: role.metadata.name },
      subjects: [
        { kind: "ServiceAccount", name: "openshell-sandbox", namespace: context.namespace.name },
      ],
    };
    const resource = kind === "Role" ? role : binding;
    const configuration = sandboxInstallation().drivers.sandbox.configuration;
    configuration.gateway.operatorWorkspaceResources = [resource];
    const gatewayClient = workspaceGatewayClient();
    const driver = new OpenShellSandboxDriver(configuration, {
      id: "openshell-sandbox",
      implementation: "openshell",
      backend: backendFor(gatewayClient),
      operatorOwnedKubernetesResources: true,
    });
    const metadata = {
      ...resource.metadata,
      namespace: context.namespace.name,
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace": context.namespace.id,
      },
      annotations: { "openclaw.dev/namespace-id": context.namespace.id },
    };
    let wire = { ...structuredClone(resource), metadata };
    let addUnknown = false;
    const { createConfiguration, ServerConfiguration, V1PolicyRule, RbacV1Subject } =
      controllerRequire("@kubernetes/client-node");
    const api = new KubernetesObjectApi(
      createConfiguration({
        baseServer: new ServerConfiguration("http://127.0.0.1:9", {}),
      }),
    );
    api.apiVersionResourceCache = {
      v1: { resources: [{ name: "namespaces", kind: "Namespace", namespaced: false }] },
      "rbac.authorization.k8s.io/v1": {
        resources: [
          { name: "roles", kind: "Role", namespaced: true },
          { name: "rolebindings", kind: "RoleBinding", namespaced: true },
        ],
      },
    };
    // Keep read() and SDK deserialization real; only replace the HTTP transport.
    api.requestPromise = async (request) => {
      const isResource = request.getUrl().includes("/rbac.authorization.k8s.io/");
      const observed = await api.processResponse({
        httpStatusCode: 200,
        headers: { "content-type": "application/json" },
        body: {
          text: async () =>
            JSON.stringify(
              isResource
                ? wire
                : {
                    apiVersion: "v1",
                    kind: "Namespace",
                    metadata: { name: context.namespace.name },
                  },
            ),
        },
      });
      if (isResource && addUnknown) {
        // Preserve future/extension fields that reach the comparison boundary.
        (kind === "Role" ? observed.rules[0] : observed.subjects[0]).unexpected = true;
      }
      return observed;
    };
    context.kubernetes = api;
    const observed = await api.read(wire);
    assert.ok(
      kind === "Role"
        ? observed.rules[0] instanceof V1PolicyRule
        : observed.subjects[0] instanceof RbacV1Subject,
    );
    await driver.ensureNamespace(context);
    assert.equal(callCount(gatewayClient, "createWorkspace"), 1);

    // Every increase or change in RBAC authority must fail before Gateway access.
    const mutations =
      kind === "Role"
        ? [
            (value) => {
              value.rules[0].verbs.push("delete");
            },
            (value) => {
              value.rules[0].resources.push("secrets");
            },
            (value) => {
              value.rules.push({ apiGroups: [""], resources: ["secrets"], verbs: ["get"] });
            },
          ]
        : [
            (value) => {
              value.subjects[0].name = "different-account";
            },
            (value) => {
              value.subjects.push({
                kind: "ServiceAccount",
                name: "extra-account",
                namespace: context.namespace.name,
              });
            },
            (value) => {
              value.roleRef.name = "different-role";
            },
          ];
    const callsBeforeRefusals = gatewayClient.calls.length;
    for (const mutate of mutations) {
      wire = { ...structuredClone(resource), metadata };
      mutate(wire);
      await assert.rejects(
        driver.ensureNamespace(context),
        /Operator workspace resource does not match/,
      );
    }
    wire = { ...structuredClone(resource), metadata };
    addUnknown = true;
    await assert.rejects(
      driver.ensureNamespace(context),
      /Operator workspace resource does not match/,
    );
    assert.equal(gatewayClient.calls.length, callsBeforeRefusals);
    assert.deepEqual(configuration.gateway.operatorWorkspaceResources, [resource]);
  });
}

// Production configuration and Sandbox provisioning, with controlled gateway observations.
// This proves the join and fail-closed lifecycle, not an installed stock supervisor or GitHub.
test(
  "configured protected OpenShell Git admits only the selected execution and network policy",
  { timeout: 30000 },
  async (t) => {
    const tls = await harnessTlsFixture(t);
    const keys = generateKeyPairSync("ed25519");
    const publicKeyPath = join(tls.directory, "gateway-public.pem");
    await writeFile(publicKeyPath, keys.publicKey.export({ type: "spki", format: "pem" }));
    const { loadYaml } = controllerRequire("@kubernetes/client-node");
    const fragment = loadYaml(
      await readFile(
        new URL(
          "../../deploy/examples/repository-credentials/openshell.fragment.yaml",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const configuration = sandboxInstallation();
    configuration.drivers.sandbox.configuration.kubernetes.sandboxDataMount.mountPath =
      "/sandbox/repository";
    configuration.drivers.compute.configuration.network.providerHarness = {
      namespace: "openshell-system",
      podLabels: { app: "openshell-gateway" },
      address: "10.43.0.50",
      port: 8080,
    };
    configuration.backend[0].configuration = {
      endpoint: "https://gateway.example.test:8443",
      auth: { mode: "bearerTokenFile", path: "/unused/operator-token" },
    };
    const registry = {
      version: 1,
      backendId: "github-primary",
      providerInstanceId: "github-primary",
      appId: "123",
      githubInstallationId: "456",
      maximumDurationSeconds: 3600,
      repositories: [
        {
          repositoryRef: "source",
          repositoryId: "42",
          repository: "example/project",
          namespaces: [
            {
              namespaceId: namespaceContext().namespace.id,
              profiles: ["git-write"],
              transport: "git-and-draft-pr",
              pullRequestBase: "main",
              pushRefAllowlist: ["refs/heads/review/task"],
            },
          ],
        },
      ],
    };
    const registryPath = join(tls.directory, "registry.json");
    await writeFile(registryPath, JSON.stringify(registry), { mode: 0o600 });
    configuration.backend.push({
      id: "github-primary",
      type: "github",
      configuration: { registryPath },
      drivers: { repo: "repository-credentials" },
    });
    configuration.repository = {
      ...fragment.repository,
      id: "repository-credentials",
      configuration: { sessionDurationSeconds: 600 },
    };
    // The Git worker binds its authority on this port in-process, well after the configuration
    // names it. Hold the port until then, so a test running in parallel cannot take it.
    const authorityPort = await reservePort();
    t.after(() => authorityPort.release());
    await bindReservedPortInProcess(authorityPort);
    const { port } = authorityPort;
    configuration.repository.openShell.authority = {
      ...fragment.repository.openShell.authority,
      host: "127.0.0.1",
      port,
      certificatePath: tls.certPath,
      privateKeyPath: tls.keyPath,
      issuerPublicKeyPath: publicKeyPath,
      issuer: "https://gateway.example.test",
      audience: "online-authorizer",
      keyId: "gateway-key",
    };
    const gateway = workspaceGatewayClient();
    let repositoryGatewayVersion = "0.1.5";
    gateway.getGatewayInfo = async () => ({
      gateway_version: repositoryGatewayVersion,
      extensions: [{ configured_name: "oce-prepared-git", kind: 4, protocol_major: 1 }],
    });
    const originalGetWorkspace = gateway.getWorkspace;
    gateway.getWorkspace = async (name) => {
      const workspace = await originalGetWorkspace(name);
      // Preserve absence after deletion; adding fixture identity must not resurrect a Workspace.
      return workspace === undefined ? undefined : { ...workspace, name, id: "workspace-id" };
    };
    const originalImportProfile = gateway.importProviderProfile;
    gateway.importProviderProfile = async (workspace, profile) => {
      await originalImportProfile(workspace, profile);
      const stored = gateway.profiles.get(profile.id);
      stored.definition = {
        inference_capable: false,
        credentials: profile.credentials?.map((c) => ({
          name: c.name,
          env_vars: c.envVars,
          required: c.required,
          stable_placeholder: c.stablePlaceholder,
          auth_style: c.authStyle,
          header_name: c.headerName,
        })),
        binaries: profile.binaries?.map((path) => ({ path })),
        endpoints: profile.endpoints?.map((endpoint) => ({
          ...endpoint,
          enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
          access: "NETWORK_ACCESS_PRESET_READ_WRITE",
        })),
      };
    };
    const originalCreateProvider = gateway.createProvider;
    gateway.createProvider = async (request) => {
      const provider = await originalCreateProvider(request);
      Object.assign(provider, {
        id: request.name + "-id",
        workspace: request.workspace,
        profileWorkspace: request.workspace,
      });
      return provider;
    };
    const specCodec = controllerRequire("@grpc/proto-loader").loadSync(
      fileURLToPath(
        new URL(
          "../../apps/controller/src/drivers/sandbox/proto/openshell-gateway.proto",
          import.meta.url,
        ),
      ),
      { keepCase: true, longs: String, enums: String, defaults: false, oneofs: true },
    )["openshell.v1.SandboxSpec"];
    const sandboxes = gateway.sandboxes;
    let created;
    gateway.createSandbox = async (request) => {
      created = request;
      const sandbox = storedSandbox(request, {
        spec: specCodec.deserialize(specCodec.serialize(request.spec)),
        id: "sandbox-id",
        phase: "SANDBOX_PHASE_READY",
        restartCount: 0,
      });
      sandboxes.set(request.name, sandbox);
      return sandbox;
    };
    gateway.getSandbox = async ({ name }) => sandboxes.get(name);
    gateway.getService = async (_workspace, sandbox, service) =>
      harnessService(sandbox, service, sandboxes.get(sandbox)?.serviceUrls[""]);
    gateway.getSandboxProviderStatus = async (workspace, sandbox, provider) => {
      const now = new Date().toISOString();
      const desired = {
        sandboxId: "sandbox-id",
        sandbox,
        providerId: provider + "-id",
        providerResourceVersion: "1",
        attachmentEpoch: "epoch-one",
        providerEnvRevision: "1",
        configRevision: "1",
        policyHash: "policy-one",
      };
      return {
        state: "PROVIDER_READINESS_STATE_READY",
        evaluatedTime: now,
        observedTime: now,
        networkInstanceId: "network-one",
        receipt: { workspace, provider, desired },
        observed: {
          ...desired,
          sessionId: "supervisor-one",
          sequence: "1",
          credentialsInstalled: true,
          policyActive: true,
          launchEnvironmentInstalled: true,
          processInstanceId: "process-one",
          reason: "",
        },
      };
    };
    // Select the same driver through both typed capabilities with the extended gateway mock.
    // This does not establish stock signed-send or live-reduction support. No broker configuration,
    // generic exchange service, issuer call or second Git lifecycle is needed to load it.
    const gitId = configuration.drivers.sandbox.id;
    configuration.backend[0].drivers.credential_proxy = gitId;
    configuration.drivers.credential_proxy = { id: gitId, configuration: {} };
    // A native broker peer left in Compute after a switch to protected Git would make every
    // stop, retire and delete list repository material Secrets the chart no longer lets the
    // worker list (finding 2212). Startup, and so the chart's upgrade check, refuses it.
    await verifyProtectedStartupRefusals(
      configuration,
      (candidate) =>
        loadInstallationFile(t, candidate, { createOpenShellBackend: () => backendFor(gateway) }),
      formatStartupConfigurationFailure,
    );
    // The chart routes openshellGit.port to the worker Pod's address, so a worker listener on
    // loopback, on another port, or without the chart listener is refused at startup and in the
    // upgrade check, not at the first Git request (finding 2213). This test binds the listener
    // on loopback itself, so its own load declares no chart listener.
    await verifyProtectedChartListenerRefusals(port, (declared) =>
      loadInstallationFile(t, configuration, {
        createOpenShellBackend: () => backendFor(gateway),
        environment: { OCC_OPENSHELL_GIT_PORT: declared, OCC_EGRESS_AUTHORITY_PORT: "disabled" },
      }),
    );
    const protectedGit = await loadInstallationFile(t, configuration, {
      createOpenShellBackend: () => backendFor(gateway),
    });
    const owner = protectedGit.protectedDriver;
    assert.equal(owner.require("sandbox"), protectedGit.sandboxDriver);
    assert.equal(owner.require("credential_proxy"), protectedGit.proxyDriver);
    assert.equal(protectedGit.repositoryOwner.controlSocket, undefined);
    assert.equal(protectedGit.nativeRepositorySender, undefined);
    assert.equal(protectedGit.egressAuthority, undefined);
    // Release labels do not qualify the sender; runtime proof still gates material.
    await verifyProtectedGatewayAdmission({
      signal: t.signal,
      setGatewayVersion: (version) => {
        repositoryGatewayVersion = version;
      },
      sourceControl: protectedGit.proxyDriver.sourceControl,
      validateRepositoryCredentials: (harness) =>
        protectedGit.computeDriver.validateRepositoryCredentials(
          harness,
          protectedGit.sandboxDriver.id,
        ),
    });
    const { context, revision, requirements } = runtimeSandboxFixture(protectedGit.sandboxDriver);
    // Revision execution starts in an existing, owned Workspace. Its deletion must remain observable.
    gateway.workspaces.set(openShellWorkspaceName(context.namespace), {
      ...ownedWorkspace(openShellWorkspaceName(context.namespace), context.namespace.id),
      id: "workspace-id",
    });
    const auth = {
      method: "credential_source",
      sourceId: "cs_test",
      sourceType: "openai",
      credentialGatewayId: protectedGit.credentialGatewayDriver.id,
      loginMode: requirements.loginMode,
    };
    const inferenceProvider = openShellProviderName(auth.sourceId);
    requirements.credentialAttachments = [{ sourceId: auth.sourceId, ref: inferenceProvider }];
    gateway.providers.set(inferenceProvider, {
      name: inferenceProvider,
      id: "inference-provider-id",
      type: "inference-profile",
      profileWorkspace: openShellWorkspaceName(context.namespace),
      config: {},
      labels: {},
      resourceVersion: "1",
    });
    gateway.profiles.set("inference-profile", {
      id: "inference-profile",
      resourceVersion: "1",
      definition: {
        credentials: [{ env_vars: ["MODEL_API_KEY"] }],
        endpoints: [{ host: "api.openai.com", port: 443 }],
      },
    });
    revision.repositoryCredentials = {
      driver: { id: "repository-credentials", implementation: "github" },
      deadlineWallMs: Date.now() + 600000,
      bindings: [
        resolveGitHubRepositoryBinding(registry, {
          namespaceId: revision.namespaceId,
          repositoryRef: "source",
          profile: "git-write",
        }),
      ],
    };
    // Exercise production composition through the admitted v5 online Sandbox spec. Only the selected
    // model source survives Git; the runtime-files provider cannot stand in for that source.
    await t.test(
      "protected Sandbox accepts only the separately admitted model alongside Git",
      async (subtest) => {
        const git = protectedGit.sandboxDriver.openShellGit;
        const proxy = protectedGit.proxyDriver;
        const sandbox = protectedGit.sandboxDriver;
        const revisionId = "rev_" + randomUUID();
        const plan = {
          id: randomUUID(),
          generation: 1,
          execution: {
            revisionId,
            namespaceId: revision.namespaceId,
            installationId: "sandbox-installation",
            agentId: revision.agentId,
            servicePrincipalId: "sandbox-principal",
            executionId: randomUUID().replaceAll("-", ""),
          },
          routes: [],
          driver: owner.ref,
          harnessCredentialSource: auth,
          repositoryGit: revision.repositoryCredentials,
          repositoryGitAuthorization: "online-request",
          sandboxDriverId: sandbox.id,
          egressDriverId: proxy.id,
        };
        const rev = {
          ...revision,
          id: revisionId,
          harnessAuth: auth,
          egressPlan: plan,
          executionAdmission: { version: 5, mode: "protected" },
        };
        rev.configuration = createHarnessConfiguration("codex", "gpt-5");
        rev.harness.configuration = protectedGit.computeDriver.resolveHarnessConfiguration(
          rev.harness,
          auth,
          rev.configuration,
        );
        const ctx = { ...context, plan, revision: rev };
        protectedGit.computeDriver.validateExecutionAdmission(rev, owner);
        assert.match(
          protectedGit.computeDriver.admitRevision(rev),
          /^model-provider:v1:[a-f0-9]{64}:openshell-codex-launch:v1:protected-codex-no-connection-retry:v1$/,
        );
        protectedGit.computeDriver.validateRepositoryCredentials(rev.harness, sandbox.id);
        // Preparation accepts the configured facilities independently of the release label.
        await new ProtectedExecutionDriver(owner).configure(ctx);
        // Finding 2204: a git-read binding maps to no delivery profile. Preparation never checks
        // its counterpart as an ordinary egress plan; it refuses the plan with its own code.
        const readGit = {
          ...revision.repositoryCredentials,
          bindings: [{ ...revision.repositoryCredentials.bindings[0], profile: "git-read" }],
        };
        const { repositoryGitAuthorization: _online, ...readFields } = plan;
        const readPlan = { ...readFields, repositoryGit: readGit };
        const readRevision = {
          ...rev,
          repositoryCredentials: readGit,
          egressPlan: readPlan,
          executionAdmission: { version: 4, mode: "protected" },
        };
        const readCtx = { ...ctx, plan: readPlan, revision: readRevision };
        for (const prepare of [
          () => new ProtectedExecutionDriver(owner).configure(readCtx),
          () => proxy.configureRevision(readCtx),
        ]) {
          await assert.rejects(prepare(), {
            name: "RepositoryGitProfileUnsupportedError",
            code: "REPOSITORY_GIT_PROFILE_UNSUPPORTED",
          });
        }
        const qualifiedWiring = (c) => ({
          plan: c.plan,
          configuration: openShellEgressConfiguration(c.plan, proxy.options),
        });
        const proxyWiring = await proxy.configureRevision(ctx);
        const required = structuredClone({ ...requirements, proxyWiring });
        const { harnessEgressEnrollment } =
          await import("../../apps/controller/src/drivers/compute/egress-enrollment.ts");
        required.files[0].content = JSON.stringify({
          kind: "codex",
          selections: {},
          providerTools: "none",
          egressEnrollment: harnessEgressEnrollment(plan),
        });
        for (const credentialAttachments of [
          [],
          [{ sourceId: "cs_other", ref: inferenceProvider }],
          [{ sourceId: auth.sourceId, ref: openShellProviderName("other") }],
          [
            ...required.credentialAttachments,
            { sourceId: "extra", ref: openShellProviderName("extra") },
          ],
        ]) {
          await assert.rejects(
            sandbox.provisionHarness({
              ...ctx,
              requirements: { ...required, credentialAttachments },
            }),
            /only the admitted Harness credential attachment/,
          );
          assert.equal(
            created,
            undefined,
            "a refused credential attachment cannot start a Sandbox",
          );
        }
        try {
          await git.start(
            {
              readOpenShellMaterial: async () => undefined,
              authorizeOnlineRequest: async () => ({ kind: "denied", reason: "unavailable" }),
            },
            undefined,
            routeStore(),
          );
          // v4 promised a send cutoff. The online sender must refuse that revision before creation.
          const exactRevision = structuredClone(rev);
          exactRevision.executionAdmission.version = 4;
          delete exactRevision.egressPlan.repositoryGitAuthorization;
          const exact = { ...context, plan: exactRevision.egressPlan, revision: exactRevision };
          const exactWiring = qualifiedWiring(exact);
          await assert.rejects(
            sandbox.provisionHarness({
              ...exact,
              requirements: { ...required, proxyWiring: exactWiring },
            }),
            /requires one explicitly admitted GitHub binding and its dedicated Codex execution/,
          );
          assert.equal(created, undefined, "the online sender cannot take over a v4 execution");
          // The Git worker has bound its authority port since it started.
          await authorityPort.release();
          const result = await sandbox.provisionHarness({ ...ctx, requirements: required });
          const cold = sandbox.standingGitExecution(ctx);
          assert.equal(cold.continuity.model, inferenceProvider);
          assert.equal(
            sandbox.standingGitExecution({
              ...ctx,
              revision: { ...rev, harnessAuth: { method: "runtime" } },
            }),
            undefined,
          );
          const spec = created.spec;
          assert.ok(spec.providers.includes(inferenceProvider));
          assert.equal(spec.providers.filter((p) => p.startsWith("oce-git-")).length, 1);
          assert.deepEqual(Object.keys(spec.policy.network_policies), [
            "workspace-node-enrollment",
          ]);
          assert.equal(spec.environment.OPENAI_API_KEY, undefined);
          assert.equal(spec.environment.GITHUB_TOKEN, undefined);
          // Check the final launch environment, after all provider and Sandbox
          // composition, rather than only the Git runtime's intermediate result.
          const gitEnvironment = Object.fromEntries(
            Object.entries(spec.environment).filter(([name]) => name.startsWith("GIT_")),
          );
          const trust = spawnSync("git", ["config", "--get-all", "safe.directory"], {
            env: { ...gitEnvironment, GIT_CONFIG_NOSYSTEM: "1", HOME: "/nonexistent" },
            encoding: "utf8",
          });
          assert.equal(trust.status, 0, trust.stderr);
          assert.equal(trust.stdout.trim(), sandbox.options.kubernetes.sandboxDataMount.mountPath);
          await subtest.test("Git negotiates shared history before pushing", async (gitTest) => {
            await verifyOpenShellPushNegotiation(gitTest, gitEnvironment);
          });
          await subtest.test(
            "Git trusts only the selected root-owned workspace",
            imageTestOptions,
            async () => {
              await runDocker([
                "run",
                "--rm",
                "--pull=never",
                "--network=none",
                "--read-only",
                "--user=0:0",
                "--security-opt=no-new-privileges",
                "--tmpfs=/sandbox:rw,exec,nosuid,nodev,mode=755",
                "--tmpfs=/tmp:rw,nosuid,nodev,mode=1777",
                "--mount",
                `type=bind,src=${fileURLToPath(new URL("../fixtures/openshell-git-workspace.cjs", import.meta.url))},dst=/proof.cjs,readonly`,
                "--entrypoint=node",
                image,
                "/proof.cjs",
                JSON.stringify({
                  workspace: sandbox.options.kubernetes.sandboxDataMount.mountPath,
                  environment: gitEnvironment,
                }),
              ]);
            },
          );
          assert.deepEqual(result.proxyWiring.plan, plan);
          const collisionConfiguration = structuredClone(
            configuration.drivers.sandbox.configuration,
          );
          collisionConfiguration.policy.networkPolicies.push({
            name: "overlap",
            endpoints: [{ host: "*.github.com", ports: [443] }],
            binaries: [{ path: "/usr/bin/curl" }],
          });
          // Finding 2131: an overlapping policy fails the Installation at startup, naming the
          // policy, instead of the first Agent deploy.
          const collision = () =>
            new OpenShellSandboxDriver(collisionConfiguration, {
              id: sandbox.id,
              backend: backendFor(gateway),
              openShellGit: git,
            });
          for (const host of [
            "*.github.com",
            "api.github.com",
            "github.com",
            "codeload.github.com",
            "uploads.github.com",
          ]) {
            collisionConfiguration.policy.networkPolicies.at(-1).endpoints[0].host = host;
            assert.throws(
              collision,
              {
                message:
                  "OpenShell Git reaches github.com and its subdomains only through its middleware route; remove those hosts from sandbox network policy overlap.",
              },
              host,
            );
          }
          // Finding 2145: an IP-address host may lead to GitHub too, so it is refused outright.
          for (const host of ["140.82.112.3", "[2606:50c0:8000::154]", "140.82.112.0/20"]) {
            collisionConfiguration.policy.networkPolicies.at(-1).endpoints[0].host = host;
            assert.throws(
              collision,
              {
                message: `OpenShell Git reaches GitHub only through its middleware route, and an IP address may lead there; use a DNS name instead of ${host} in sandbox network policy overlap.`,
              },
              host,
            );
          }
          // The same policy is fine without the Git route.
          const routeless = new OpenShellSandboxDriver(collisionConfiguration, {
            id: sandbox.id,
            backend: backendFor(gateway),
          });

          // Finding 2144: an Agent network grant must not open a route beside the middleware either,
          // on any port. Admission refuses it for a repository-bound Agent, naming the grant.
          const allowed = {
            id: "docs",
            binary: "/usr/bin/curl",
            host: "objects.githubusercontent.com",
            ports: [{ from: 443, to: 443 }],
          };
          const repositoryScope = { repositoryCredentials: true };
          assert.deepEqual(
            sandbox.admitNetworkPolicy([allowed], 2, undefined, repositoryScope).additions,
            [allowed],
          );
          for (const [host, port] of [
            ["github.com", 22],
            ["api.github.com", 443],
            ["*.github.com", 443],
            // Finding 2148: GitHub's other front ends under github.com skip the middleware too.
            ["ssh.github.com", 443],
            ["codeload.github.com", 443],
          ]) {
            const direct = {
              ...allowed,
              id: "git-direct",
              host,
              ports: [{ from: port, to: port }],
            };
            assert.throws(
              () => sandbox.admitNetworkPolicy([allowed, direct], 2, undefined, repositoryScope),
              {
                name: "SandboxNetworkPolicyConflictError",
                message: `OpenShell Git reaches github.com and its subdomains only through its middleware route, so an Agent with a repository binding cannot also allow them: remove network grant git-direct (${host}).`,
              },
              host,
            );
            // Without a repository binding, or without the Git route, the grant is admitted.
            assert.equal(sandbox.admitNetworkPolicy([direct], 2).additions[0].host, host);
            assert.equal(
              routeless.admitNetworkPolicy([direct], 2, undefined, repositoryScope).additions[0]
                .host,
              host,
            );
          }
          // Finding 2145: an IP-address grant may reach GitHub, so it is refused with its own message;
          // without the Git route it stays an ordinary grant.
          for (const host of ["140.82.112.3", "*.82.112.3", "0x8c.0x52.0x70.0x3", "2354212867"]) {
            const address = { ...allowed, id: "git-address", host };
            assert.throws(
              () => sandbox.admitNetworkPolicy([allowed, address], 2, undefined, repositoryScope),
              {
                name: "SandboxNetworkPolicyConflictError",
                message: `OpenShell Git reaches GitHub only through its middleware route, and an IP address may lead there, so an Agent with a repository binding cannot allow one: remove network grant git-address (${host}).`,
              },
              host,
            );
            assert.equal(sandbox.admitNetworkPolicy([address], 2).additions[0].host, host);
          }
          // Revision defaults get the same check; the Driver's own policies were checked at startup.
          const defaults = sandbox.admitNetworkPolicy([], 1).defaults;
          assert.throws(
            () =>
              sandbox.admitNetworkPolicy(
                [],
                1,
                { ...defaults, mirror: { name: "mirror", endpoints: [{ host: "github.com" }] } },
                repositoryScope,
              ),
            /remove sandbox network policy mirror \(github\.com\)\.$/,
          );
          for (const host of ["2606:50c0:8000::154", "[2606:50c0:8000::154]", "140.82.112.0/20"]) {
            assert.throws(
              () =>
                sandbox.admitNetworkPolicy(
                  [],
                  1,
                  { ...defaults, mirror: { name: "mirror", endpoints: [{ host }] } },
                  repositoryScope,
                ),
              {
                name: "SandboxNetworkPolicyConflictError",
                message: `OpenShell Git reaches GitHub only through its middleware route, and an IP address may lead there, so an Agent with a repository binding cannot allow one: remove sandbox network policy mirror (${host}).`,
              },
              host,
            );
          }
          // Backstop at provisioning: a revision admitted with such a grant never gets a Sandbox.
          const direct = {
            ...allowed,
            id: "git-direct",
            host: "github.com",
            ports: [{ from: 443, to: 443 }],
          };
          const bypassRevision = {
            ...rev,
            id: "rev_00000000-0000-4000-8000-000000002144",
            sandboxPolicy: {
              driverId: sandbox.id,
              implementation: sandbox.implementation,
              version: 2,
              defaults,
              additions: [direct],
            },
          };
          const createdBefore = created;
          await assert.rejects(
            sandbox.provisionHarness({ ...ctx, revision: bypassRevision, requirements: required }),
            {
              name: "SandboxRevisionUnsupportedError",
              code: "SANDBOX_HARNESS_UNSUPPORTED",
              message: /Protected execution keeps only its protected egress policy/,
            },
          );
          assert.equal(created, createdBefore, "no Sandbox is created");
          await assert.rejects(
            sandbox.provisionHarness({
              ...ctx,
              revision: {
                ...bypassRevision,
                sandboxPolicy: {
                  ...bypassRevision.sandboxPolicy,
                  additions: [{ ...direct, id: "git-address", host: "140.82.112.3" }],
                },
              },
              requirements: required,
            }),
            {
              name: "SandboxRevisionUnsupportedError",
              code: "SANDBOX_HARNESS_UNSUPPORTED",
              message: /Protected execution keeps only its protected egress policy/,
            },
          );
          assert.equal(created, createdBefore, "no Sandbox is created for an IP-address grant");
          // Backstop at live application: the running Git Sandbox's policy is never widened.
          const getSandbox = gateway.getSandbox;
          const updatePolicy = gateway.updatePolicy;
          let policyUpdates = 0;
          gateway.getSandbox = async ({ name }) => ({
            ...sandboxes.get(name),
            resourceVersion: "1",
          });
          gateway.updatePolicy = async () => {
            policyUpdates++;
          };
          try {
            await assert.rejects(
              sandbox.applyNetworkPolicy(
                { namespace: ctx.namespace, revision: rev, signal: AbortSignal.timeout(2_000) },
                {
                  snapshot: { ...bypassRevision.sandboxPolicy },
                  expectedProviderVersion: "1",
                  operationId: randomUUID(),
                },
              ),
              {
                name: "SandboxNetworkPolicyConflictError",
                message: /remove network grant git-direct/,
              },
            );
            await assert.rejects(
              sandbox.applyNetworkPolicy(
                { namespace: ctx.namespace, revision: rev, signal: AbortSignal.timeout(2_000) },
                {
                  snapshot: {
                    ...bypassRevision.sandboxPolicy,
                    additions: [{ ...direct, id: "git-address", host: "140.82.112.3" }],
                  },
                  expectedProviderVersion: "1",
                  operationId: randomUUID(),
                },
              ),
              {
                name: "SandboxNetworkPolicyConflictError",
                message:
                  /IP address may lead there.*: remove network grant git-address \(140\.82\.112\.3\)\.$/,
              },
            );
            assert.equal(policyUpdates, 0);
          } finally {
            gateway.getSandbox = getSandbox;
            gateway.updatePolicy = updatePolicy;
          }

          // Finding 2206: the revision's Git provider and its profile go with its Sandbox. Left
          // behind, they kept the Namespace's Workspace forever: OpenShell refuses DeleteWorkspace
          // while a Sandbox, provider or provider profile remains (the fake gateway does too).
          const gitProvider = spec.providers.find((p) => p.startsWith("oce-git-"));
          const leftBehind = {
            provider: structuredClone(gateway.providers.get(gitProvider)),
            profile: structuredClone(gateway.profiles.get(gitProvider)),
          };
          assert.ok(leftBehind.provider && leftBehind.profile);
          // A same-name provider without the revision's owner fingerprint is refused, not deleted.
          gateway.providers.get(gitProvider).labels = {
            "openclaw.dev/prepared-git-binding": "0".repeat(48),
          };
          await assert.rejects(sandbox.cleanup({ ...ctx, revision: rev }), {
            name: "OpenShellPreparedGitProviderError",
          });
          assert.ok(gateway.providers.has(gitProvider) && gateway.profiles.has(gitProvider));
          gateway.providers.set(gitProvider, structuredClone(leftBehind.provider));
          // The same for its profile: the provider goes, the profile stays.
          gateway.profiles.get(gitProvider).annotations = {
            "openclaw.dev/prepared-git-binding": "0".repeat(48),
          };
          await assert.rejects(sandbox.cleanup({ ...ctx, revision: rev }), {
            name: "OpenShellPreparedGitProviderError",
          });
          assert.ok(!gateway.providers.has(gitProvider) && gateway.profiles.has(gitProvider));
          gateway.profiles.set(gitProvider, structuredClone(leftBehind.profile));
          await sandbox.cleanup({ ...ctx, revision: rev });
          assert.equal(gateway.sandboxes.has(created.name), false);
          assert.equal(gateway.providers.has(gitProvider), false, "Git provider deleted");
          assert.equal(gateway.profiles.has(gitProvider), false, "Git provider profile deleted");
          assert.deepEqual([...gateway.providers.keys()], [inferenceProvider]);

          // The operator withdrew the Namespace's grant from the registry and restarted the
          // controller, a usual reason for a revision to stop. The restarted worker cannot derive
          // the Git provider's name from the revision's scope any more; the Sandbox's own
          // provider list, read before its deletion, names it.
          const withdrawnId = "rev_" + randomUUID();
          const withdrawnPlan = {
            ...plan,
            id: randomUUID(),
            execution: {
              ...plan.execution,
              revisionId: withdrawnId,
              executionId: randomUUID().replaceAll("-", ""),
            },
          };
          const withdrawnRev = { ...rev, id: withdrawnId, egressPlan: withdrawnPlan };
          const withdrawnCtx = { ...context, plan: withdrawnPlan, revision: withdrawnRev };
          const withdrawnRequired = structuredClone({
            ...requirements,
            proxyWiring: qualifiedWiring(withdrawnCtx),
          });
          withdrawnRequired.files[0].content = JSON.stringify({
            kind: "codex",
            selections: {},
            providerTools: "none",
            egressEnrollment: harnessEgressEnrollment(withdrawnPlan),
          });
          await sandbox.provisionHarness({ ...withdrawnCtx, requirements: withdrawnRequired });
          const withdrawnProvider = created.spec.providers.find((p) => p.startsWith("oce-git-"));
          assert.ok(withdrawnProvider !== gitProvider && gateway.providers.has(withdrawnProvider));
          const revokedRegistry = structuredClone(registry);
          revokedRegistry.repositories[0].namespaces[0].namespaceId =
            "ns_00000000-0000-4000-8000-000000000999";
          const revokedPath = join(tls.directory, "registry-revoked.json");
          await writeFile(revokedPath, JSON.stringify(revokedRegistry), { mode: 0o600 });
          const revoked = structuredClone(configuration);
          revoked.backend.find(({ id }) => id === "github-primary").configuration.registryPath =
            revokedPath;
          const restarted = await loadInstallationFile(t, revoked, {
            createOpenShellBackend: () => backendFor(gateway),
          });
          // A same-name profile another owner annotated is kept (the provider's own, renamed).
          gateway.profiles.get(withdrawnProvider).annotations = {
            "openclaw.dev/prepared-git-binding": "0".repeat(48),
          };
          await restarted.sandboxDriver.cleanup(withdrawnCtx);
          assert.equal(gateway.sandboxes.has(created.name), false);
          assert.equal(gateway.providers.has(withdrawnProvider), false, "provider deleted");
          assert.equal(gateway.profiles.has(withdrawnProvider), true, "foreign profile kept");
          gateway.profiles.delete(withdrawnProvider);

          // A revision cleaned up before this fix left its Git provider and profile behind.
          // Namespace cleanup deletes them before the Workspace, but only objects whose owner
          // label matches the name a preparation derives from it: a provider without it, or a
          // profile another owner annotated, is kept, and OpenShell keeps refusing the Workspace.
          gateway.providers.set(gitProvider, leftBehind.provider);
          gateway.profiles.set(gitProvider, leftBehind.profile);
          const foreign = "oce-git-" + "0".repeat(32);
          gateway.providers.set(foreign, { ...leftBehind.provider, name: foreign, type: foreign });
          const owner = "1".repeat(48);
          const reused = "oce-git-" + owner.slice(0, 32);
          gateway.providers.set(reused, {
            ...leftBehind.provider,
            name: reused,
            type: reused,
            labels: { "openclaw.dev/prepared-git-binding": owner },
          });
          gateway.profiles.set(reused, { ...leftBehind.profile, id: reused });
          // A profile whose provider is already gone: a CreateProvider reply was lost, or an
          // earlier pass failed between the two deletes. Only a listing finds it.
          const orphan = "oce-github-installation-" + "2".repeat(32);
          gateway.profiles.set(orphan, {
            ...leftBehind.profile,
            id: orphan,
            annotations: { "openclaw.dev/prepared-git-binding": "2".repeat(48) },
          });
          // The model source's provider belongs to the Credential Gateway, which withdraws it.
          gateway.providers.delete(inferenceProvider);
          gateway.profiles.delete("inference-profile");
          const workspace = openShellWorkspaceName(ctx.namespace);
          gateway.workspaces.set(workspace, ownedWorkspace(workspace, ctx.namespace.id));
          const namespaceCleanup = { ...ctx, revision: undefined };
          await assert.rejects(sandbox.cleanup(namespaceCleanup), {
            code: 9,
            details: `workspace '${workspace}' still contains resources: provider, provider profile`,
          });
          assert.deepEqual([...gateway.providers.keys()], [foreign]);
          assert.deepEqual([...gateway.profiles.keys()], [reused]);
          gateway.providers.delete(foreign);
          gateway.profiles.delete(reused);
          await sandbox.cleanup(namespaceCleanup);
          assert.equal(gateway.workspaces.has(workspace), false, "Workspace deleted");
        } finally {
          await git.close();
        }
      },
    );
  },
);

registerSandboxDriverNamespaceGatewayCleanupCases({
  KubernetesObjectApi,
  sandboxInstallation,
  openShellDriver,
});
