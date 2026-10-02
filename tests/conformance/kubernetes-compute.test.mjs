import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { spawnSync } from "node:child_process";
import { inflateRawSync } from "node:zlib";
import test from "node:test";
import {
  AGENT_RUNTIME_ENTRYPOINT,
  AGENT_WITH_NODE_ENTRYPOINT,
  GATEWAY_RUNTIME_ENTRYPOINT,
  RUNTIME_WRAPPER_COMMAND,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import {
  createKubernetesComputeDriver,
  KubernetesComputeDriver,
  kubernetesNamespaceName,
  kubernetesGatewayNamespaceName,
  resolveKubernetesNamespace,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { ActivationPendingError, ConfigurationHarnessError } from "../../packages/occ/src/index.ts";
import {
  currentComputeAbortSignal,
  withComputeAbortSignal,
  withComputeWorkWaiting,
} from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";

const kubeconfigPath = "/tmp/openclaw-enterprise-conformance/kubeconfig";
const contextName = "openclaw-enterprise-local";
const tenant = {
  id: "ns_00000000-0000-4000-8000-000000000001",
  name: "Conformance tenant",
  status: "ready",
  createdAt: "2026-08-18T00:00:00.000Z",
};

const apiKeyAuth = {
  method: "api_key",
  source: {
    kind: "secret",
    namespaceId: tenant.id,
    id: "sec_00000000-0000-4000-8000-000000000001",
  },
  secretDriverId: "kubernetes-secret",
};

function authContext(revision, namespace = kubernetesGatewayNamespaceName(tenant.id)) {
  return {
    harnessAuth: ["api_key", "codex_pat", "oauth"].includes(revision.harnessAuth.method)
      ? {
          ...revision.harnessAuth,
          backendRef: {
            namespaceName: namespace,
            name: "occ-model-key",
            key: "value",
            uid: "model-secret-uid",
          },
        }
      : revision.harnessAuth,
  };
}

function preparedAuth(driver, namespace, embedded = false, harnessAuth = apiKeyAuth) {
  const revision = {
    namespaceId: tenant.id,
    harness: embedded
      ? { id: "openclaw", version: "1.0.0", mode: "embedded" }
      : { id: "codex", version: "1.0.0", mode: "dedicated" },
    harnessAuth,
    configuration: { agents: { defaults: { model: embedded ? "openai/gpt-5" : "codex/gpt-5" } } },
  };
  return driver.harnessAuthForRevision(revision, authContext(revision, namespace), {
    name: namespace,
    plane: "execution",
  });
}

function options(overrides = {}) {
  const resources = {
    requests: { cpu: "100m", memory: "64Mi" },
    limits: { cpu: "250m", memory: "128Mi" },
  };

  return {
    authentication: { mode: "kubeconfig", kubeconfigPath, context: contextName },
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
    ...overrides,
    ...(overrides.runtime === undefined
      ? {}
      : {
          runtime: { gatewayNodeSelector: { "oce-role": "control-plane" }, ...overrides.runtime },
        }),
  };
}

test("repository capability admits only configured Compute-owned native topologies", () => {
  const configured = options({
    runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
    network: {
      ...options().network,
      repositoryCredentials: {
        namespace: "repository-service",
        podLabels: { app: "repository" },
        port: 8443,
      },
    },
  });
  const driver = new KubernetesComputeDriver(configured);
  const dualCluster = new KubernetesComputeDriver({
    ...configured,
    gatewayRouting: {
      hostname: "gateway.example.test",
      gatewayName: "gateway",
      gatewayNamespace: "system",
      envoyNamespace: "envoy",
    },
    network: Object.fromEntries(
      Object.entries(configured.network).filter(([key]) => key !== "gatewayClients"),
    ),
    executionCluster: {
      authentication: {
        mode: "kubeconfig",
        kubeconfigPath: "/fixture/execution",
        context: "execution",
      },
      harnessRouting: {
        hostname: "harness.example.test",
        gatewayName: "harness",
        gatewayNamespace: "system",
        envoyNamespace: "envoy",
      },
      network: {
        dns: configured.network.dns,
        harnessEndpointCidrs: ["192.0.2.2/32"],
        gatewayEndpointCidrs: ["192.0.2.1/32"],
        pluginStatusProxySourceCidrs: ["192.0.2.2/32"],
      },
    },
  });
  assert.throws(
    () => dualCluster.validateRepositoryCredentialSupport(),
    /not supported by the experimental two-cluster profile/,
  );
  for (const [id, mode] of [
    ["openclaw", "embedded"],
    ["codex", "dedicated"],
  ]) {
    const harness = { id, mode, version: "1.0.0" };
    assert.doesNotThrow(() => driver.validateRepositoryCredentials(harness));
    assert.throws(
      () => driver.validateRepositoryCredentials(harness, "selected-sandbox"),
      /without a SandboxDriver/,
    );
    assert.throws(() =>
      new KubernetesComputeDriver({
        ...configured,
        runtime: undefined,
      }).validateRepositoryCredentials(harness),
    );
    assert.throws(() =>
      new KubernetesComputeDriver({
        ...configured,
        network: options().network,
      }).validateRepositoryCredentials(harness),
    );
    const sandboxDriver = { id: "sandbox", implementation: "sandbox", capability: "sandbox" };
    assert.throws(() =>
      new KubernetesComputeDriver(configured, { sandboxDriver }).validateRepositoryCredentials(
        harness,
      ),
    );
  }
  for (const [id, mode] of [
    ["codex", "embedded"],
    ["openclaw", "dedicated"],
    ["unknown", "dedicated"],
    ["codex", "unknown"],
  ]) {
    assert.throws(() => driver.validateRepositoryCredentials({ id, mode, version: "1.0.0" }));
  }
});

function digest(value, length = 12) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

const previousTenantNamespaceName = "oce-ns-00000000-0000-4000-8000-000000000001-89d99db2f971";
const previousPunctuatedNamespace = {
  id: "Very_Long.Namespace/With Mixed_CASE_and punctuation that truncates before hash suffix 1234567890",
  name: "oce-very-long-namespace-with-mixed-case-and-punctu-13352a1af7c0",
};

function defaultGatewayHostname(routing) {
  return `occ-gateway-${digest(`${routing.gatewayNamespace}/${routing.gatewayName}`)}.${routing.envoyNamespace}.svc`;
}

const gatewayRouting = {
  hostname: "agents.example.internal",
  gatewayName: "oce-agent-gateways",
  gatewayNamespace: "openclaw-system",
  envoyNamespace: "envoy-gateway-system",
};

// Linux rejects any exec argument or environment string above 128 KiB with
// E2BIG, so a workload that renders one never starts. Keep every rendered
// string at half that, whatever the runtime programs grow to.
const EXEC_STRING_BUDGET = 64 * 1024;

function assertExecStringsWithinBudget(objects) {
  for (const object of objects) {
    const pod = object.kind === "Pod" ? object.spec : object.spec?.template?.spec;
    for (const container of [...(pod?.initContainers ?? []), ...(pod?.containers ?? [])]) {
      const strings = [
        ...(container.command ?? []).map((value, index) => [`command[${index}]`, value]),
        ...(container.args ?? []).map((value, index) => [`args[${index}]`, value]),
        ...(container.env ?? [])
          .filter(({ value }) => value !== undefined)
          .map(({ name, value }) => [`env ${name}`, `${name}=${value}`]),
        ...["readinessProbe", "livenessProbe", "startupProbe"].flatMap((probe) =>
          (container[probe]?.exec?.command ?? []).map((value, index) => [
            `${probe} command[${index}]`,
            value,
          ]),
        ),
      ];
      for (const [field, value] of strings) {
        const size = Buffer.byteLength(value);
        assert.ok(
          size <= EXEC_STRING_BUDGET,
          `${object.kind} ${object.metadata.name} container ${container.name} ${field} is ` +
            `${size} bytes; the per-string budget is ${EXEC_STRING_BUDGET}`,
        );
      }
    }
  }
}

// Controller-rendered programs reach `node -e` compressed behind a fixed loader.
function containerProgram(container) {
  const [loader, ...pieces] = container.args;
  assert.equal(loader, nodeProgramArguments("")[0]);
  return inflateRawSync(Buffer.from(pieces.join(""), "base64")).toString("utf8");
}

function routedOptions(overrides = {}) {
  const configured = options();
  const { gatewayClients, ...network } = configured.network;
  return options({
    ...overrides,
    gatewayRouting: overrides.gatewayRouting ?? gatewayRouting,
    network: {
      ...network,
      ...(overrides.network ?? {}),
    },
  });
}

function routedRevision(driver, overrides = {}) {
  return {
    id: "revision-routed-1",
    namespaceId: tenant.id,
    agentId: "agent-routed",
    revision: 1,
    configurationId: "cfg_00000000-0000-4000-8000-000000000009",
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration: {
      agents: { defaults: { model: "codex/gpt-5" } },
      logging: {
        level: "info",
        consoleLevel: "info",
        consoleStyle: "json",
      },
      diagnostics: { otel: { logs: false } },
      gateway: {
        trustedProxies: ["10.42.0.0/16"],
        allowRealIpFallback: true,
        auth: {
          mode: "trusted-proxy",
          trustedProxy: {
            userHeader: "x-occ-identity",
            allowUsers: ["occ-workspace-files"],
          },
          identityScopes: { "occ-workspace-files": ["operator.admin"] },
        },
      },
    },
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    harnessAuth: apiKeyAuth,
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId: "service-principal-routed",
    createdAt: tenant.createdAt,
    ...overrides,
  };
}

test("gateway readiness waits for the updated replica to replace the old ready pod", async () => {
  const driver = new KubernetesComputeDriver(options());
  const namespace = { name: kubernetesNamespaceName(tenant.id), plane: "execution" };
  const ownership = { namespaceId: tenant.id, agentId: "agent-rollout" };
  const name = `gateway-${digest(ownership.agentId)}`;
  const deployment = driver.deployment(
    name,
    ownership,
    namespace,
    options().images.gateway,
    name,
    "gateway",
    {},
    "info",
  );
  deployment.metadata.generation = 2;
  deployment.status = {
    observedGeneration: 2,
    replicas: 2,
    updatedReplicas: 1,
    readyReplicas: 1,
  };
  const service = driver.service(name, ownership, namespace, {
    "app.kubernetes.io/name": name,
  });
  driver.apiClients = Promise.resolve({
    apps: { readNamespacedDeployment: async () => structuredClone(deployment) },
    core: { readNamespacedService: async () => structuredClone(service) },
    discovery: {
      listNamespacedEndpointSlice: async () => ({
        items: [
          {
            metadata: { labels: { "kubernetes.io/service-name": name } },
            endpoints: [{ conditions: { ready: true } }],
          },
        ],
      }),
    },
  });

  assert.equal(await driver.gatewayReady(ownership, name, namespace), false);
  deployment.status.replicas = 1;
  assert.equal(await driver.gatewayReady(ownership, name, namespace), true);
});

test("Kubernetes namespace names are deterministic, DNS-safe, distinct, and OpenShell-routable", () => {
  for (const id of ["Namespace_With.UPPERCASE!punctuation", "x".repeat(250), "---"]) {
    const name = kubernetesNamespaceName(id);
    const suffix = createHash("sha256").update(id).digest("hex").slice(0, 15);

    assert.equal(name, kubernetesNamespaceName(id));
    assert.match(name, /^oce-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
    assert.ok(name.length <= 19);
    assert.ok(name.endsWith(suffix));
  }

  // Distinct tenant identifiers retain distinct opaque placements.
  assert.notEqual(kubernetesNamespaceName("Team A"), kubernetesNamespaceName("Team-A"));
});

test("workspace node identity is Agent-scoped and only Agent deletion removes it", async () => {
  const driver = new KubernetesComputeDriver(
    routedOptions({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
      },
    }),
    { nodeEnrollment: {} },
  );
  const revision = routedRevision(driver);
  const replacement = { ...revision, id: "revision-routed-2", revision: 2 };
  // OpenClaw keeps each session on its recorded device, so a replacement
  // AgentRevision must reconnect as the same node rather than enroll a new one.
  assert.equal(driver.workspaceNodeName(replacement), driver.workspaceNodeName(revision));
  assert.deepEqual(
    driver.workspaceNodeOwnership(replacement),
    driver.workspaceNodeOwnership(revision),
  );
  assert.equal(driver.workspaceNodeOwnership(revision).revisionId, undefined);
  // A Harness change does not inherit another Harness kind's node.
  assert.notEqual(
    driver.workspaceNodeName({ ...revision, harness: { ...revision.harness, id: "codex" } }),
    driver.workspaceNodeName({ ...revision, harness: { ...revision.harness, id: "openclaw" } }),
  );
  const namespace = kubernetesNamespaceName(revision.namespaceId);
  const ownership = { namespaceId: revision.namespaceId, agentId: revision.agentId };
  const secrets = new Map(
    ["codex", "openclaw"].map((id, index) => {
      const name = driver.workspaceNodeName({ ...revision, harness: { id } });
      const secret = {
        ...driver.manifest("v1", "Secret", name, ownership, {
          name: namespace,
          plane: "execution",
        }),
        type: "Opaque",
      };
      secret.metadata.uid = `node-enrollment-uid-${index}`;
      return [name, secret];
    }),
  );
  const deleted = [];
  driver.apiClients = Promise.resolve({
    core: {
      async readNamespacedSecret({ name }) {
        if (!secrets.has(name)) {
          throw Object.assign(new Error("not found"), { statusCode: 404 });
        }
        return structuredClone(secrets.get(name));
      },
      async deleteNamespacedSecret(request) {
        deleted.push(request);
      },
    },
  });
  assert.equal(driver.retireWorkspaceNode, undefined);
  await driver.deleteWorkspaceNodes(revision.agentId, ownership, {
    name: namespace,
    plane: "execution",
  });
  assert.deepEqual(
    deleted,
    [...secrets.values()].map((secret) => ({
      name: secret.metadata.name,
      namespace,
      body: { preconditions: { uid: secret.metadata.uid } },
    })),
  );
  deleted.length = 0;
  const foreign = { ...ownership, agentId: "another-agent" };
  for (const [name, secret] of secrets) {
    secrets.set(name, {
      ...secret,
      metadata: {
        ...secret.metadata,
        ...driver.manifest("v1", "Secret", name, foreign, { name: namespace, plane: "execution" })
          .metadata,
      },
    });
  }
  await assert.rejects(
    driver.deleteWorkspaceNodes(revision.agentId, ownership, {
      name: namespace,
      plane: "execution",
    }),
    /Refusing unowned/,
  );
  assert.deepEqual(deleted, []);
  // Naming admits only the Harness kinds Agent deletion sweeps.
  assert.throws(
    () => driver.workspaceNodeName({ ...revision, harness: { id: "other" } }),
    /limited to Codex and OpenClaw/,
  );
});

test("retiring an upgraded revision removes its legacy node Secret and keeps the Agent node", async () => {
  const driver = new KubernetesComputeDriver(
    routedOptions({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
      },
    }),
    { nodeEnrollment: {} },
  );
  const revision = routedRevision(driver);
  const namespace = { name: kubernetesNamespaceName(revision.namespaceId), plane: "execution" };
  // Installations upgraded from revision-scoped enrollment still hold one
  // Secret per revision; the first replacement enrolls a new Agent device.
  const legacyName = `workspace-node-${digest(revision.agentId)}-${digest(revision.id)}`;
  const secret = (name, ownership, uid) => {
    const value = {
      ...driver.manifest("v1", "Secret", name, ownership, namespace),
      type: "Opaque",
    };
    value.metadata.uid = uid;
    return value;
  };
  const secrets = new Map([
    [legacyName, secret(legacyName, driver.pluginRuntimeOwnership(revision), "legacy-uid")],
    [
      driver.workspaceNodeName(revision),
      secret(driver.workspaceNodeName(revision), driver.workspaceNodeOwnership(revision), "agent"),
    ],
  ]);
  const deleted = [];
  driver.apiClients = Promise.resolve({
    core: {
      async readNamespacedSecret({ name }) {
        if (!secrets.has(name)) {
          throw Object.assign(new Error("not found"), { statusCode: 404 });
        }
        return structuredClone(secrets.get(name));
      },
      async deleteNamespacedSecret(request) {
        deleted.push([request.name, request.body.preconditions.uid]);
        secrets.delete(request.name);
      },
    },
  });
  driver.resolveNamespace = async () => ({ name: namespace, external: false });
  driver.getNamespace = async () => ({ metadata: {} });
  driver.verifyNamespaceOwnership = () => {};
  driver.verifyGatewayNamespace = () => {};
  driver.shutdownRevisionRuntime = async () => {};
  driver.removeRetiredGateway = async () => {};
  await driver.retireRevision(revision);
  assert.deepEqual(deleted, [[legacyName, "legacy-uid"]]);
  assert.equal(secrets.has(driver.workspaceNodeName(revision)), true);
  // A replayed retirement finds nothing left to delete.
  await driver.retireRevision(revision);
  assert.deepEqual(deleted, [[legacyName, "legacy-uid"]]);
});

test("preparation renews an expired workspace node setup and keeps the enrolled device", async () => {
  const setups = [];
  const driver = new KubernetesComputeDriver(
    routedOptions({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
      },
    }),
    {
      nodeEnrollment: {
        async createSetup() {
          setups.push("setup");
          return {
            setupId: `setup-${setups.length + 1}`,
            setupCode: `code-${setups.length + 1}`,
            expiresAtMs: Date.now() + 600_000,
          };
        },
      },
    },
  );
  const revision = routedRevision(driver);
  const namespace = { name: kubernetesNamespaceName(revision.namespaceId), plane: "execution" };
  const name = driver.workspaceNodeName(revision);
  const encode = (value) => Buffer.from(value, "utf8").toString("base64");
  const decode = (data) =>
    Object.fromEntries(
      Object.entries(data).map(([key, value]) => [key, Buffer.from(value, "base64").toString()]),
    );
  const deviceId = "a".repeat(64);
  // Enrolled on an earlier revision; the upstream native `connect --ephemeral`
  // entrypoint refuses a setup code past its embedded expiry.
  let secret = {
    ...driver.manifest("v1", "Secret", name, driver.workspaceNodeOwnership(revision), namespace),
    type: "Opaque",
    data: {
      setupId: encode("setup-1"),
      setupCode: encode("code-1"),
      expiresAtMs: encode("1"),
      deviceId: encode(deviceId),
    },
  };
  secret.metadata.uid = "enrolled-uid";
  secret.metadata.resourceVersion = "7";
  const writes = [];
  driver.reconcile = async () => {};
  driver.gatewayReady = async () => true;
  driver.apiClients = Promise.resolve({
    core: {
      async readNamespacedSecret() {
        return structuredClone(secret);
      },
      async replaceNamespacedSecret(request) {
        writes.push(["replace", request.name, request.body.metadata.resourceVersion]);
        secret = structuredClone(request.body);
      },
      async deleteNamespacedSecret(request) {
        writes.push(["delete", request.name]);
      },
      async createNamespacedSecret(request) {
        writes.push(["create", request.body.metadata.name]);
      },
    },
    networking: {
      async readNamespacedNetworkPolicy() {
        throw Object.assign(new Error("not found"), { statusCode: 404 });
      },
    },
  });
  const replacement = { ...revision, id: "revision-routed-2", revision: 2 };
  assert.deepEqual(await driver.prepareWorkspaceNode(replacement, namespace), { name });
  assert.deepEqual(writes, [["replace", name, "7"]]);
  assert.equal(setups.length, 1);
  const renewed = decode(secret.data);
  assert.equal(renewed.deviceId, deviceId);
  assert.equal(renewed.setupId, "setup-2");
  assert.equal(renewed.setupCode, "code-2");
  assert.ok(Number(renewed.expiresAtMs) > Date.now());
  assert.equal(secret.metadata.uid, "enrolled-uid");
  // A current setup is reused unchanged.
  writes.length = 0;
  assert.deepEqual(await driver.prepareWorkspaceNode(replacement, namespace), { name });
  assert.deepEqual(writes, []);
  assert.equal(setups.length, 1);
});

test("preparation records a device redeemed on an expired setup before renewing it", async () => {
  for (const redeemed of [true, false]) {
    const setups = [];
    const observed = [];
    const deviceId = "b".repeat(64);
    const driver = new KubernetesComputeDriver(
      routedOptions({
        runtime: {
          transportSecretPrefix: "transport",
          gatewayStorageClassName: "local-path",
        },
      }),
      {
        nodeEnrollment: {
          async createSetup() {
            setups.push("setup");
            return { setupId: "setup-b", setupCode: "code-b", expiresAtMs: Date.now() + 600_000 };
          },
          async observeSetup(_url, setupId) {
            observed.push(setupId);
            return redeemed ? { deviceId, connected: false } : undefined;
          },
        },
      },
    );
    const revision = routedRevision(driver);
    const namespace = { name: kubernetesNamespaceName(revision.namespaceId), plane: "execution" };
    const name = driver.workspaceNodeName(revision);
    const encode = (value) => Buffer.from(value, "utf8").toString("base64");
    // Setup A expired before readiness recorded the node that redeemed it.
    let secret = {
      ...driver.manifest("v1", "Secret", name, driver.workspaceNodeOwnership(revision), namespace),
      type: "Opaque",
      data: { setupId: encode("setup-a"), setupCode: encode("code-a"), expiresAtMs: encode("1") },
    };
    secret.metadata.resourceVersion = "3";
    const writes = [];
    driver.reconcile = async () => {};
    driver.gatewayReady = async () => true;
    driver.apiClients = Promise.resolve({
      core: {
        async readNamespacedSecret() {
          return structuredClone(secret);
        },
        async replaceNamespacedSecret(request) {
          writes.push(request.body.metadata.resourceVersion);
          secret = structuredClone(request.body);
        },
      },
      networking: {
        async readNamespacedNetworkPolicy() {
          throw Object.assign(new Error("not found"), { statusCode: 404 });
        },
      },
    });
    assert.deepEqual(await driver.prepareWorkspaceNode(revision, namespace), { name });
    assert.deepEqual(observed, ["setup-a"]);
    assert.deepEqual(writes, ["3"]);
    assert.equal(setups.length, 1);
    const data = Object.fromEntries(
      Object.entries(secret.data).map(([key, value]) => [
        key,
        Buffer.from(value, "base64").toString(),
      ]),
    );
    assert.equal(data.setupId, "setup-b");
    assert.equal(data.deviceId, redeemed ? deviceId : undefined);
  }
});

test("dedicated runtime rejects missing workspace transport before cluster access", async () => {
  const runtime = { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" };
  for (const [configuration, selection] of [
    [options({ runtime }), { nodeEnrollment: {} }],
    [routedOptions({ runtime }), {}],
  ]) {
    const driver = new KubernetesComputeDriver(configuration, selection);
    const revision = routedRevision(driver);
    let clusterReads = 0;
    driver.apiClients = Promise.resolve({
      core: {
        async listNamespace() {
          clusterReads++;
          throw new Error("unexpected cluster access");
        },
      },
    });
    for (const operation of ["prepareRevision", "activateRevision"]) {
      await assert.rejects(
        driver[operation](revision),
        /Dedicated Harness storage requires gateway routing and node enrollment/,
      );
    }
    assert.equal(clusterReads, 0);
  }
});

test("activation refuses a missing or foreign workspace node before changing the serving Gateway", async () => {
  const driver = new KubernetesComputeDriver(
    routedOptions({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
      },
      // The controller reads the Gateway's ack, so the node travels in the binding.
      network: { pluginStatusProxySourceCidrs: ["192.0.2.20/32"] },
    }),
    { nodeEnrollment: {} },
  );
  const revision = routedRevision(driver);
  revision.configuration = admitLoggingConfiguration(revision.configuration, "info");
  const namespace = kubernetesNamespaceName(revision.namespaceId);
  let secret;
  const policies = [
    ...driver.networkPolicies({ namespaceId: tenant.id }, { name: namespace, plane: "execution" }),
    ...driver.networkPolicies(
      { namespaceId: tenant.id },
      { name: kubernetesGatewayNamespaceName(tenant.id), plane: "control" },
    ),
  ];
  const gatewayName = `gateway-${digest(revision.agentId)}`;
  const gateway = driver.deployment(
    gatewayName,
    { namespaceId: tenant.id, agentId: revision.agentId },
    { name: kubernetesGatewayNamespaceName(tenant.id), plane: "control" },
    options().images.gateway,
    gatewayName,
    "gateway",
    {},
    "info",
    driver.gatewayConfiguration(revision, "previous-device", {
      name: kubernetesNamespaceName(tenant.id),
      plane: "execution",
    }),
  );
  assert.equal(
    gateway.spec.template.spec.containers[0].env.some(
      ({ name }) => name === "OPENCLAW_WORKSPACE_NODE_ID",
    ),
    false,
  );
  const binding = {
    ...driver.manifest(
      "v1",
      "ConfigMap",
      `gateway-${digest(revision.agentId)}-workspace-node`,
      { namespaceId: tenant.id, agentId: revision.agentId },
      { name: kubernetesGatewayNamespaceName(tenant.id), plane: "control" },
    ),
    data: {
      "workspace-node.json": JSON.stringify({
        revisionId: revision.id,
        deviceId: "previous-device",
      }),
    },
  };
  // Only Kubernetes reads are available: activation must reject before any write
  // or selecting a candidate Harness when its exact enrollment is unavailable.
  driver.apiClients = Promise.resolve({
    core: {
      async listNamespace() {
        return { items: [] };
      },
      async readNamespace({ name }) {
        return {
          ...(name === kubernetesGatewayNamespaceName(tenant.id)
            ? driver.gatewayNamespaceManifest({ namespaceId: tenant.id })
            : driver.manifest("v1", "Namespace", namespace, { namespaceId: tenant.id })),
          status: { phase: "Active" },
        };
      },
      async readNamespacedSecret() {
        if (secret === undefined) {
          throw Object.assign(new Error("not found"), { statusCode: 404 });
        }
        return structuredClone(secret);
      },
      // The serving Codex Gateway learned its node from the Agent-scoped binding,
      // not its pod spec.
      async readNamespacedConfigMap({ name }) {
        assert.equal(name, `gateway-${digest(revision.agentId)}-workspace-node`);
        return structuredClone(binding);
      },
    },
    apps: {
      async readNamespacedDeployment() {
        return structuredClone(gateway);
      },
    },
    networking: {
      async readNamespacedNetworkPolicy({ name, namespace: target }) {
        return structuredClone(
          policies.find(
            (policy) => policy.metadata.name === name && policy.metadata.namespace === target,
          ),
        );
      },
    },
  });
  await assert.rejects(
    driver.activateRevision(revision, authContext(revision)),
    /workspace node is not enrolled/,
  );
  // Losing enrollment metadata after activation must not switch document reads
  // back to the stale Gateway workspace on the next preparation pass.
  await assert.rejects(
    driver.prepareRevision(revision, authContext(revision)),
    /workspace node binding cannot change/,
  );
  secret = {
    ...driver.manifest(
      "v1",
      "Secret",
      driver.workspaceNodeName(revision),
      { namespaceId: revision.namespaceId, agentId: "another-agent" },
      { name: namespace, plane: "execution" },
    ),
    data: { deviceId: Buffer.from("previous-device").toString("base64") },
  };
  await assert.rejects(
    driver.activateRevision(revision, authContext(revision)),
    /ownership|another|revision|Refusing/i,
  );
  // The binding is controller-owned: one that names another Agent is refused,
  // not read.
  secret = undefined;
  binding.metadata = driver.manifest(
    "v1",
    "ConfigMap",
    binding.metadata.name,
    { namespaceId: tenant.id, agentId: "another-agent" },
    { name: kubernetesGatewayNamespaceName(tenant.id), plane: "control" },
  ).metadata;
  await assert.rejects(
    driver.prepareRevision(revision, authContext(revision)),
    /Refusing unowned Kubernetes ConfigMap gateway-[a-f0-9]{12}-workspace-node/,
  );
});

// A first dedicated Codex deploy with plugins, workspace node enrollment and
// gateway routing. Only transport observations are faked; startup order and
// readiness come from the real driver.
//
// With `clock` ({ now }), enrollment waits are simulated on that fake clock: an
// observation advances it by its whole wait, or to `state.pairAtMs` if the node
// pairs within the wait, and never sleeps.
function dedicatedFirstDeployFixture({ statusProxy = true, clock } = {}) {
  const state = {
    setupCalls: 0,
    connected: false,
    enrollmentAvailable: true,
    // The node OpenClaw reports applied through the wrapper's runtime status,
    // or the reason it has not.
    gatewayWorkspaceNodeId: undefined,
    gatewayWorkspaceNodeFailure: undefined,
    gatewayAppliesBinding: true,
    // When set, the node host pairs this long after its setup reaches the Harness.
    pairAfterSetupMs: undefined,
    // The wait each setup observation was given.
    observeWaits: [],
    // With a fake clock: when the node pairs, and when a waiting observation fails.
    pairAtMs: undefined,
    failAtMs: undefined,
    // With a fake clock: observe poll by poll, asking `stopWaiting` between reads.
    stepObservations: false,
  };
  const driver = new KubernetesComputeDriver(
    routedOptions({
      runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
      // The API server proxy can reach private status, so activation reads the
      // node OpenClaw applied.
      ...(statusProxy ? { network: { pluginStatusProxySourceCidrs: ["192.0.2.20/32"] } } : {}),
    }),
    {
      nodeEnrollment: {
        async createSetup() {
          state.setupCalls++;
          return { setupId: "setup-1", setupCode: "setup-code", expiresAtMs: Date.now() + 60000 };
        },
        async observeSetup(_url, _setupId, signal, options) {
          if (!state.enrollmentAvailable) {
            throw new Error("Gateway is restarting after the Harness replacement");
          }
          // Like the client: one connection, re-read until connected or the wait ends.
          state.observeWaits.push(options?.waitMs ?? 0);
          if (clock !== undefined && state.stepObservations) {
            // Like the client, poll by poll: read, then ask whether other Work
            // is waiting for the worker before the next read.
            const deadline = clock.now + (options?.waitMs ?? 0);
            for (;;) {
              if (state.pairAtMs !== undefined && state.pairAtMs <= clock.now) {
                state.connected = true;
              }
              if (
                state.connected ||
                clock.now + 250 > deadline ||
                (options?.stopWaiting !== undefined && (await options.stopWaiting()))
              ) {
                return state.connected ? { deviceId: "node-1", connected: true } : undefined;
              }
              clock.now += 250;
            }
          }
          if (clock !== undefined) {
            const deadline = clock.now + (options?.waitMs ?? 0);
            if (state.failAtMs !== undefined && state.failAtMs <= deadline) {
              clock.now = Math.max(clock.now, state.failAtMs);
              throw new Error("Gateway connection closed");
            }
            if (!state.connected && state.pairAtMs !== undefined && state.pairAtMs <= deadline) {
              clock.now = Math.max(clock.now, state.pairAtMs);
              state.connected = true;
            } else if (!state.connected) {
              clock.now = deadline;
            }
            return state.connected ? { deviceId: "node-1", connected: true } : undefined;
          }
          const deadline = Date.now() + (options?.waitMs ?? 0);
          while (!state.connected && Date.now() < deadline) {
            if (options?.stopWaiting !== undefined && (await options.stopWaiting())) {
              break;
            }
            signal.throwIfAborted();
            await new Promise((resolve) => setTimeout(resolve, 2));
          }
          return state.connected ? { deviceId: "node-1", connected: true } : undefined;
        },
        async isConnected() {
          return state.connected;
        },
      },
    },
  );
  if (clock === undefined) {
    // Short enough for tests; long enough that a pass sees a node pairing within it.
    driver.workspaceNodePairingWaitMs = 60;
  } else {
    driver.now = () => clock.now;
  }
  const revision = routedRevision(driver, {
    plugins: {
      driver: { id: "codex-plugin", implementation: "occ/codex-plugin" },
      plugins: {
        "codex-plugin:example": { enabled: true, toolDefaults: { approval: "provider_default" } },
      },
    },
  });
  const operatorSuppliedConfiguration = {
    ...revision.configuration,
    gateway: {
      bind: "lan",
      auth: { trustedProxy: { requiredHeaders: ["x-real-ip"], allowLoopback: false } },
    },
  };
  revision.configuration = admitLoggingConfiguration(operatorSuppliedConfiguration, "info");
  const namespace = kubernetesNamespaceName(tenant.id);
  const gatewayName = `gateway-${digest(revision.agentId)}`;
  const agentName = `agent-${digest(revision.agentId)}-rev-${digest(revision.id)}`;
  const objects = new Map();
  const templates = [];
  const key = (kind, name, target = namespace) =>
    `${kind}:${kind === "Namespace" ? "" : target}:${name}`;
  const save = (object) =>
    objects.set(
      key(object.kind, object.metadata.name, object.metadata.namespace),
      structuredClone(object),
    );
  const read = (kind, name, target = namespace) => {
    const value = objects.get(key(kind, name, target));
    if (!value) {
      throw Object.assign(new Error("not found"), { statusCode: 404 });
    }
    return structuredClone(value);
  };
  save({
    ...driver.manifest("v1", "Namespace", namespace, { namespaceId: tenant.id }),
    status: { phase: "Active" },
  });
  save({
    ...driver.gatewayNamespaceManifest({ namespaceId: tenant.id }),
    status: { phase: "Active" },
  });
  save({
    ...driver.manifest(
      "v1",
      "Secret",
      `transport-${digest(revision.agentId)}`,
      { namespaceId: tenant.id, agentId: revision.agentId },
      { name: kubernetesGatewayNamespaceName(tenant.id), plane: "control" },
    ),
    type: "Opaque",
    metadata: {
      ...driver.manifest(
        "v1",
        "Secret",
        `transport-${digest(revision.agentId)}`,
        { namespaceId: tenant.id, agentId: revision.agentId },
        { name: kubernetesGatewayNamespaceName(tenant.id), plane: "control" },
      ).metadata,
      uid: "transport-uid",
      resourceVersion: "1",
    },
    data: {
      "app-server-token": Buffer.from("test-transport").toString("base64"),
    },
  });
  save({
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: "occ-model-key",
      namespace: kubernetesGatewayNamespaceName(tenant.id),
      uid: "model-secret-uid",
    },
    data: { value: Buffer.from("fixture-model-key").toString("base64") },
  });
  for (const target of [
    { name: namespace, plane: "execution" },
    { name: kubernetesGatewayNamespaceName(tenant.id), plane: "control" },
  ]) {
    for (const policy of driver.networkPolicies({ namespaceId: tenant.id }, target)) {
      save(policy);
    }
  }
  // Only transport observations are supplied. Startup order and readiness use
  // the real driver; successful writes do not make a Deployment ready.
  const clients = { core: {}, apps: {}, networking: {}, objects: {}, discovery: {} };
  for (const [api, kinds] of [
    [clients.core, ["ConfigMap", "Secret", "Service", "ServiceAccount", "PersistentVolumeClaim"]],
    [clients.apps, ["Deployment"]],
    [clients.networking, ["NetworkPolicy"]],
  ]) {
    for (const kind of kinds) {
      api[`readNamespaced${kind}`] = async ({ name, namespace: target }) =>
        read(kind, name, target);
      const write = async ({ body }) => {
        const previous = objects.get(key(kind, body.metadata.name, body.metadata.namespace));
        const changed =
          kind === "Deployment" && JSON.stringify(previous?.spec) !== JSON.stringify(body.spec);
        const value = {
          ...previous,
          ...structuredClone(body),
          metadata: {
            ...previous?.metadata,
            ...body.metadata,
            uid: `${body.metadata.name}-uid`,
            resourceVersion: "1",
          },
        };
        if (kind === "Deployment") {
          const template = JSON.stringify(body.spec.template);
          if (template !== JSON.stringify(previous?.spec.template)) {
            // Each new pod template is a workload start: both use Recreate.
            templates.push({
              name: body.metadata.name,
              template: structuredClone(body.spec.template),
            });
          }
          value.metadata.generation = (previous?.metadata.generation ?? 0) + Number(changed);
          if (changed) {
            delete value.status;
          }
        }
        if (body.stringData) {
          value.data = Object.fromEntries(
            Object.entries(body.stringData).map(([name, value]) => [
              name,
              Buffer.from(value).toString("base64"),
            ]),
          );
        }
        save(value);
        return value;
      };
      api[`patchNamespaced${kind}`] = write;
      api[`createNamespaced${kind}`] = write;
      api[`replaceNamespaced${kind}`] = write;
    }
  }
  clients.core.listNamespace = async () => ({ items: [] });
  clients.core.readNamespace = async ({ name }) => read("Namespace", name);
  clients.objects.read = async (object) =>
    read(object.kind, object.metadata.name, object.metadata.namespace);
  clients.objects.patch = async (object) => {
    save(object);
    return object;
  };
  clients.discovery.listNamespacedEndpointSlice = async () => ({
    items: [
      {
        metadata: {
          labels: { "kubernetes.io/service-name": gatewayName },
          ownerReferences: [{ kind: "Service", name: gatewayName, uid: `${gatewayName}-uid` }],
        },
        endpoints: [{ conditions: { ready: true } }],
      },
    ],
  });
  clients.core.listNamespacedPod = async ({ labelSelector, namespace: requestedNamespace }) => {
    const labels = Object.fromEntries(labelSelector.split(",").map((entry) => entry.split("=")));
    const role = labels["openclaw.dev/workload-role"];
    return {
      items: [
        {
          apiVersion: "v1",
          kind: "Pod",
          metadata: {
            name: `${role}-pod`,
            namespace: requestedNamespace,
            uid: `${role}-uid`,
            labels,
          },
          ...(state.unschedulableRole === role
            ? {
                status: {
                  phase: "Pending",
                  conditions: [
                    {
                      type: "PodScheduled",
                      status: "False",
                      reason: "Unschedulable",
                      message: "0/1 nodes are available: 1 Insufficient memory.",
                    },
                  ],
                },
              }
            : {}),
        },
      ],
    };
  };
  // Annotation patches on running Pods: the kubelet syncs a Pod on this update
  // event, which refreshes its optional setup Secret volume at once.
  const podPatches = [];
  clients.core.patchNamespacedPod = async ({ name, namespace: target, body }) => {
    podPatches.push({ name, namespace: target, body: structuredClone(body) });
    if (
      name === "agent-pod" &&
      state.pairAfterSetupMs !== undefined &&
      body.metadata.annotations["openclaw.dev/workspace-node-setup"] !== undefined
    ) {
      // The setup file reaches the running Harness; its node host boots and pairs.
      setTimeout(() => {
        state.connected = true;
      }, state.pairAfterSetupMs);
    }
    const binding = objects.get(
      key("ConfigMap", `${gatewayName}-workspace-node`, kubernetesGatewayNamespaceName(tenant.id)),
    );
    if (name === "gateway-pod" && binding !== undefined && state.gatewayAppliesBinding) {
      // The kubelet refreshes the volume and the wrapper hot-applies the node.
      const { revisionId, deviceId } = JSON.parse(binding.data["workspace-node.json"]);
      if (revisionId === revision.id) {
        state.gatewayWorkspaceNodeId = deviceId;
      }
    }
    return body;
  };
  clients.core.connectGetNamespacedPodProxyWithPath = async ({ name, path }) => {
    const role = name.startsWith("agent-") ? "agent" : "gateway";
    if (path === "openclaw/runtime/status") {
      return {
        revisionId: revision.id,
        container: role,
        podUid: `${role}-uid`,
        ...(role === "gateway" && state.gatewayWorkspaceNodeId !== undefined
          ? { workspaceNodeId: state.gatewayWorkspaceNodeId }
          : {}),
        ...(role === "gateway" && state.gatewayWorkspaceNodeFailure !== undefined
          ? { workspaceNodeFailure: state.gatewayWorkspaceNodeFailure }
          : {}),
      };
    }
    return {
      revisionId: revision.id,
      container: role,
      podUid: `${role}-uid`,
      startupId: `${role}-startup`,
      phase: "ready",
      successfulPluginIds: ["codex-plugin:example"],
      failures: [],
    };
  };
  driver.apiClients = Promise.resolve(clients);
  const prepare = () => driver.prepareRevision(revision, authContext(revision));
  const markReady = (name) => {
    const object = read(
      "Deployment",
      name,
      name === gatewayName ? kubernetesGatewayNamespaceName(tenant.id) : namespace,
    );
    object.status = {
      observedGeneration: object.metadata.generation,
      replicas: 1,
      updatedReplicas: 1,
      readyReplicas: 1,
    };
    save(object);
  };
  return {
    state,
    driver,
    revision,
    namespace,
    gatewayName,
    agentName,
    objects,
    templates,
    podPatches,
    clients,
    key,
    save,
    read,
    prepare,
    markReady,
  };
}

// The node wiring a Deployment-backed Codex Harness renders from its first start.
function harnessNodeSetup(template) {
  const pod = template.spec;
  const [container] = pod.containers;
  return {
    environment: container.env
      .filter(({ name }) => name.startsWith("OPENCLAW_NODE_SETUP"))
      .map(({ name, value, valueFrom }) => ({ name, value, valueFrom })),
    volume: pod.volumes.find(({ name }) => name === "openclaw-node-setup"),
    mount: container.volumeMounts.find(({ name }) => name === "openclaw-node-setup"),
    command: container.command,
  };
}

test("dedicated startup initializes Harness plugins before enrolling its workspace node", async () => {
  const {
    state,
    driver,
    revision,
    namespace,
    gatewayName,
    agentName,
    objects,
    podPatches,
    key,
    read,
    prepare,
    markReady,
  } = dedicatedFirstDeployFixture();
  assert.equal((await prepare()).ready, false);
  // The first Harness template already carries the node wiring. The setup code
  // is not in its environment: one optional Secret item is mounted read-only,
  // so the Harness starts before the Secret exists.
  assert.deepEqual(harnessNodeSetup(read("Deployment", agentName).spec.template), {
    environment: [
      {
        name: "OPENCLAW_NODE_SETUP_PATH",
        value: "/run/openclaw-node-setup/setup-code",
        valueFrom: undefined,
      },
    ],
    volume: {
      name: "openclaw-node-setup",
      secret: {
        secretName: driver.workspaceNodeName(revision),
        optional: true,
        // Kubelet grants fsGroup read on Secret files, so 0400 would act as 0440.
        defaultMode: 0o440,
        items: [{ key: "setupCode", path: "setup-code" }],
      },
    },
    mount: {
      name: "openclaw-node-setup",
      mountPath: "/run/openclaw-node-setup",
      readOnly: true,
    },
    command: [...RUNTIME_WRAPPER_COMMAND],
  });
  // The node is named after the Agent, not after the revision's Pod (D85).
  assert.equal(
    read("Deployment", agentName).spec.template.spec.containers[0].env.find(
      ({ name }) => name === "OPENCLAW_NODE_DISPLAY_NAME",
    )?.value,
    `agent-${digest(revision.agentId)}-workspace`,
  );
  const renderedConfiguration = JSON.parse(
    read(
      "ConfigMap",
      `gateway-${digest(revision.agentId)}-rev-${digest(revision.id)}`,
      kubernetesGatewayNamespaceName(tenant.id),
    ).data["openclaw.json"],
  );
  assert.equal(renderedConfiguration.gateway.bind, "lan");
  assert.deepEqual(renderedConfiguration.gateway.trustedProxies, ["10.42.0.0/16"]);
  assert.equal(renderedConfiguration.gateway.allowRealIpFallback, true);
  assert.deepEqual(renderedConfiguration.gateway.auth, {
    mode: "trusted-proxy",
    trustedProxy: {
      requiredHeaders: ["x-real-ip"],
      allowLoopback: false,
      userHeader: "x-occ-identity",
      allowUsers: ["occ-workspace-files"],
    },
    identityScopes: { "occ-workspace-files": ["operator.admin"] },
  });
  assert.deepEqual(revision.configuration.gateway, {
    bind: "lan",
    auth: { trustedProxy: { requiredHeaders: ["x-real-ip"], allowLoopback: false } },
  });
  assert.equal(state.setupCalls, 0);
  // A first deploy creates the Gateway alongside the Harness. Its peer status read
  // goes through the agent Service, which already selects this revision's Harness;
  // endpoints list only ready pods, so the Gateway waits until the Harness reports.
  assert.ok(
    objects.has(key("Deployment", gatewayName, kubernetesGatewayNamespaceName(tenant.id))),
    "the first Gateway starts alongside the Harness",
  );
  assert.deepEqual(read("Service", `agent-${digest(revision.agentId)}`).spec.selector, {
    "openclaw.dev/network-profile": "broad-egress-v1",
    "openclaw.dev/namespace": revision.namespaceId,
    "openclaw.dev/agent": revision.agentId,
    "openclaw.dev/revision": revision.id,
    "openclaw.dev/workload-role": "agent",
    "app.kubernetes.io/name": agentName,
  });
  assert.ok(
    objects.has(key("Deployment", agentName)),
    "Harness can initialize plugins without the node",
  );
  const initialStrategy = read("Deployment", agentName).spec.strategy;
  assert.equal(
    initialStrategy?.type,
    "Recreate",
    "node enrollment must not switch an existing RollingUpdate Deployment to Recreate",
  );
  markReady(agentName);
  assert.equal((await prepare()).ready, false);
  assert.equal(state.setupCalls, 0, "enrollment waits for Gateway readiness");
  markReady(gatewayName);
  const harnessBeforeSetup = read("Deployment", agentName);
  assert.equal((await prepare()).ready, false, "running workloads alone are not node readiness");
  assert.equal(state.setupCalls, 1);
  const agent = read("Deployment", agentName);
  assert.deepEqual(agent.spec.strategy, initialStrategy);
  // The setup reaches the running Harness through its optional volume: creating
  // the Secret changes no pod template, so neither the Harness nor its Gateway restarts.
  assert.deepEqual(agent.spec.template, harnessBeforeSetup.spec.template);
  assert.equal(agent.metadata.generation, harnessBeforeSetup.metadata.generation);
  assert.deepEqual(
    podPatches.map(({ name, namespace: target, body }) => ({
      name,
      target,
      annotations: Object.keys(body.metadata.annotations),
    })),
    [{ name: "agent-pod", target: namespace, annotations: ["openclaw.dev/workspace-node-setup"] }],
  );
  const nodeSecretKey = key("Secret", driver.workspaceNodeName(revision));
  assert.deepEqual(Object.keys(objects.get(nodeSecretKey).data).sort(), [
    "expiresAtMs",
    "setupCode",
    "setupId",
  ]);
  // The recorded node id reaches the candidate Gateway through its Agent-scoped
  // binding and a Pod nudge in the same pass; its pod template does not change.
  const gatewayNamespace = kubernetesGatewayNamespaceName(tenant.id);
  const gatewayBeforeBinding = read("Deployment", gatewayName, gatewayNamespace);
  state.connected = true;
  assert.equal((await prepare()).ready, true);
  assert.equal(state.setupCalls, 1);
  // Once the device is recorded the node reconnects with its saved device
  // token. The setup code, readable by Codex in the same container, is removed.
  assert.deepEqual(Object.keys(objects.get(nodeSecretKey).data).sort(), [
    "deviceId",
    "expiresAtMs",
    "setupId",
  ]);
  // The removal nudges the running Harness Pod again, with a new value, so the
  // kubelet removes the file now instead of on its periodic resync.
  assert.equal(podPatches.length, 3);
  const [minted, removed] = podPatches
    .slice(0, 2)
    .map(({ body }) => body.metadata.annotations["openclaw.dev/workspace-node-setup"]);
  assert.notEqual(minted, removed);
  assert.equal(podPatches[1].name, "agent-pod");
  const gatewayAfterBinding = read("Deployment", gatewayName, gatewayNamespace);
  assert.deepEqual(gatewayAfterBinding.spec.template, gatewayBeforeBinding.spec.template);
  assert.equal(gatewayAfterBinding.metadata.generation, gatewayBeforeBinding.metadata.generation);
  const binding = read("ConfigMap", `${gatewayName}-workspace-node`, gatewayNamespace);
  assert.deepEqual(JSON.parse(binding.data["workspace-node.json"]), {
    revisionId: revision.id,
    deviceId: "node-1",
  });
  assert.equal(binding.immutable, undefined);
  assert.equal(binding.metadata.labels["openclaw.dev/agent"], revision.agentId);
  assert.deepEqual(
    podPatches.slice(2).map(({ name, namespace: target, body }) => ({
      name,
      target,
      annotations: Object.keys(body.metadata.annotations),
    })),
    [
      {
        name: "gateway-pod",
        target: gatewayNamespace,
        annotations: ["openclaw.dev/workspace-node-binding"],
      },
    ],
  );
  // A paired file-delivered node reconnects with its saved device token, so an
  // expired setup is not re-minted and the code does not come back.
  const paired = objects.get(nodeSecretKey);
  paired.data.expiresAtMs = Buffer.from(String(Date.now() - 1)).toString("base64");
  objects.set(nodeSecretKey, paired);
  // An unchanged binding is neither rewritten nor nudged again.
  assert.equal((await prepare()).ready, true);
  assert.equal(objects.get(nodeSecretKey).data.setupCode, undefined);
  assert.equal(state.setupCalls, 1, "a paired node needs no new setup");
  assert.equal(podPatches.length, 3);
  // The node supervisor embeds Codex; neither it nor an OpenShell Sandbox, which
  // carries the whole command in one environment variable, nears the exec limit.
  assertExecStringsWithinBudget(objects.values());
  const [harness] = read("Deployment", agentName).spec.template.spec.containers;
  const command = [...harness.command, ...harness.args];
  assert.equal(command[0], "/usr/bin/tini");
  assert.ok(Buffer.byteLength(JSON.stringify(command)) <= EXEC_STRING_BUDGET);
});

// Every Agent enrolled before file delivery has a recorded deviceId and an
// env-era setupCode in its Secret. The upgrade removes the leftover code without
// a new setup, and a Harness Pod that is gone (404) does not fail the pass.
test("an upgraded file-delivered node drops its leftover setup code and tolerates a missing Pod", async () => {
  const {
    state,
    driver,
    revision,
    namespace,
    objects,
    podPatches,
    clients,
    key,
    save,
    prepare,
    markReady,
    agentName,
    gatewayName,
  } = dedicatedFirstDeployFixture();
  const nodeName = driver.workspaceNodeName(revision);
  const encode = (value) => Buffer.from(value, "utf8").toString("base64");
  const manifest = driver.manifest(
    "v1",
    "Secret",
    nodeName,
    driver.workspaceNodeOwnership(revision),
    {
      name: namespace,
      plane: "execution",
    },
  );
  save({
    ...manifest,
    type: "Opaque",
    metadata: { ...manifest.metadata, uid: "node-uid", resourceVersion: "1" },
    data: {
      deviceId: encode("node-1"),
      setupCode: encode("env-era-code"),
      setupId: encode("setup-0"),
      expiresAtMs: encode(String(Date.now() - 1)),
    },
  });
  const nodeSecretReplaces = [];
  const replaceSecret = clients.core.replaceNamespacedSecret;
  clients.core.replaceNamespacedSecret = async (request) => {
    if (request.name === nodeName) {
      nodeSecretReplaces.push(Object.keys(request.body.data).sort());
    }
    return replaceSecret(request);
  };
  clients.core.patchNamespacedPod = async ({ name }) => {
    podPatches.push({ name });
    throw Object.assign(new Error("pods not found"), { code: 404 });
  };
  state.connected = true;
  let ready = false;
  for (let pass = 0; pass < 6 && !ready; pass++) {
    ready = (await prepare()).ready;
    for (const name of [agentName, gatewayName]) {
      // A workload that this pass has not started yet has nothing to mark.
      try {
        markReady(name);
      } catch (error) {
        assert.equal(error.statusCode, 404);
      }
    }
  }
  assert.equal(ready, true);
  assert.equal(state.setupCalls, 0, "a recorded device needs no new setup");
  assert.deepEqual(nodeSecretReplaces, [["deviceId", "expiresAtMs", "setupId"]]);
  assert.equal(objects.get(key("Secret", nodeName)).data.setupCode, undefined);
  assert.deepEqual(
    podPatches.map(({ name }) => name).filter((name) => name === "agent-pod"),
    ["agent-pod"],
    "the removal nudge ran once and its 404 was ignored",
  );
  // The Gateway binding nudge tolerates a missing Pod the same way.
  assert.deepEqual(
    podPatches.map(({ name }) => name).filter((name) => name === "gateway-pod"),
    ["gateway-pod"],
  );
});

// Ratchet for deploy time: every workload start of a first dedicated deploy
// repeats login, the model probe and plugin install, and every pending pass is a
// wait on a start. Lower these counts when a change removes a start or a pass;
// never raise them silently.
test("a first dedicated deploy pins its workload starts through activation", async () => {
  const {
    state,
    driver,
    revision,
    gatewayName,
    agentName,
    templates,
    podPatches,
    read,
    prepare,
    markReady,
  } = dedicatedFirstDeployFixture();
  const environment = (template) =>
    new Set(template.spec.containers[0].env.map(({ name }) => name));
  // Workloads become ready as soon as the controller waits on them, so every
  // pending pass below is a wait on a workload start, not on test timing.
  let pendingPasses = 0;
  const pass = async () => {
    const { ready } = await prepare();
    pendingPasses += Number(!ready);
    return ready;
  };
  assert.equal(
    await pass(),
    false,
    "the Harness starts with its node wiring, and the Gateway alongside it",
  );
  // Both start in the first pass (the Gateway Deployment is reconciled first).
  assert.deepEqual(
    templates.map(({ name }) => (name === agentName ? "harness" : name)),
    [gatewayName, "harness"],
  );
  markReady(agentName);
  markReady(gatewayName);
  // The setup reaches the running Harness through its volume and the node pairs
  // a moment later, without a workload start. The pass that delivered the setup
  // sees the pairing and completes: no pending pass once the workloads are ready.
  state.pairAfterSetupMs = 10;
  assert.equal(await pass(), true);
  assert.equal(pendingPasses, 1);
  // That pass also handed the node to the Gateway (binding plus one Pod nudge),
  // so the hot-apply overlaps the worker's commit and activation's own work.
  assert.equal(state.gatewayWorkspaceNodeId, "node-1");
  let statusReads = 0;
  const clients = await driver.apiClients;
  const proxy = clients.core.connectGetNamespacedPodProxyWithPath;
  clients.core.connectGetNamespacedPodProxyWithPath = async (request) => {
    if (request.path === "openclaw/runtime/status" && request.name.startsWith("gateway-")) {
      statusReads++;
    }
    return proxy(request);
  };
  await driver.activateRevision(revision, authContext(revision));
  assert.equal(statusReads, 1, "activation finds the Gateway's ack on its first read");
  assert.equal(state.setupCalls, 1);
  assert.equal(
    podPatches.filter(({ name }) => name === "gateway-pod").length,
    1,
    "the running Gateway Pod is nudged once, by preparation",
  );

  assert.deepEqual(
    templates.map(({ name }) => (name === agentName ? "harness" : name)),
    [gatewayName, "harness"],
  );
  const [gateway, harness] = templates.map(({ template }) => template);
  // Harness start 1 already runs the node supervisor; no setup code in its pod spec.
  assert.equal(environment(harness).has("OPENCLAW_NODE_SETUP_CODE"), false);
  assert.equal(environment(harness).has("OPENCLAW_NODE_SETUP_PATH"), true);
  // Gateway start 1 carries the optional binding volume from its first render;
  // the node id never enters its pod spec.
  assert.equal(environment(gateway).has("OPENCLAW_WORKSPACE_NODE_ID"), false);
  assert.equal(environment(gateway).has("OPENCLAW_WORKSPACE_NODE_PATH"), true);
  assert.deepEqual(
    gateway.spec.volumes.find(({ name }) => name === "openclaw-workspace-node"),
    {
      name: "openclaw-workspace-node",
      configMap: {
        name: `${gatewayName}-workspace-node`,
        items: [{ key: "workspace-node.json", path: "workspace-node.json" }],
        optional: true,
      },
    },
  );
  assert.deepEqual(
    read("Deployment", gatewayName, kubernetesGatewayNamespaceName(tenant.id)).spec.template,
    gateway,
  );
  // A Gateway respawns its OpenClaw process in place when its Harness peer
  // restarts (GATEWAY_RUNTIME_ENTRYPOINT peer poll). The Gateway starts alongside the
  // first Harness, whose status it waits for, and the Harness template never
  // changes afterwards, so there is no such restart.
  const inPodGatewayRestarts = templates.filter(({ name }) => name === agentName).slice(1).length;
  assert.equal(inPodGatewayRestarts, 0);
  assert.equal(templates.length + inPodGatewayRestarts, 2, "Harness 1 + Gateway 1");
});

// The pass that sees the node pair hands it to the Gateway. Activation still
// waits for the Gateway's own report of that node, and does not nudge again.
test("activation waits for the Gateway to report the node preparation handed it", async () => {
  const { state, driver, revision, gatewayName, agentName, podPatches, prepare, markReady } =
    dedicatedFirstDeployFixture();
  assert.equal((await prepare()).ready, false);
  markReady(agentName);
  markReady(gatewayName);
  state.connected = true;
  // The kubelet has not refreshed the binding volume yet.
  state.gatewayAppliesBinding = false;
  assert.equal((await prepare()).ready, true);
  assert.equal(state.gatewayWorkspaceNodeId, undefined);
  let statusReads = 0;
  const clients = await driver.apiClients;
  const proxy = clients.core.connectGetNamespacedPodProxyWithPath;
  clients.core.connectGetNamespacedPodProxyWithPath = async (request) => {
    if (request.path === "openclaw/runtime/status" && request.name.startsWith("gateway-")) {
      statusReads++;
      if (statusReads === 2) {
        state.gatewayWorkspaceNodeId = "node-1";
      }
    }
    return proxy(request);
  };
  await driver.activateRevision(revision, authContext(revision));
  assert.equal(statusReads, 2);
  assert.equal(podPatches.filter(({ name }) => name === "gateway-pod").length, 1);
});

// Activation that fails for want of the Gateway's ack is retried, and the worker
// is serial: a Gateway that never acks gets one bounded wait per binding across
// attempts, then a single read per attempt, like the pairing budget (D221).
test("an unacknowledged workspace node binding costs at most one bounded wait across activations", async () => {
  const clock = { now: 0 };
  const { state, driver, revision, gatewayName, agentName, prepare, markReady } =
    dedicatedFirstDeployFixture({ clock });
  driver.delay = async (ms) => {
    clock.now += ms;
  };
  assert.equal((await prepare()).ready, false);
  markReady(agentName);
  markReady(gatewayName);
  state.connected = true;
  state.gatewayAppliesBinding = false;
  assert.equal((await prepare()).ready, true);
  const attemptTimes = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const started = clock.now;
    await assert.rejects(driver.activateRevision(revision, authContext(revision)), (error) => {
      // D330: the worker records this wait under its own code.
      assert.ok(error instanceof ActivationPendingError);
      assert.equal(error.code, "WORKSPACE_NODE_BINDING_PENDING");
      assert.match(error.message, /has not applied its workspace node/);
      return true;
    });
    attemptTimes.push(clock.now - started);
  }
  assert.deepEqual(attemptTimes, [20_000, 0, 0, 0]);
  // A late ack is still seen by the next single read.
  state.gatewayWorkspaceNodeId = "node-1";
  await driver.activateRevision(revision, authContext(revision));
  assert.equal(clock.now, 20_000);
});

// A node that has not paired within the pass's wait leaves the pass pending; the
// wait starts only once the setup exists and the Gateway is ready.
test("a first dedicated deploy pass waits a bounded time for its node to pair", async () => {
  const { state, driver, gatewayName, agentName, objects, prepare, markReady } =
    dedicatedFirstDeployFixture();
  assert.equal((await prepare()).ready, false);
  markReady(agentName);
  assert.equal((await prepare()).ready, false);
  assert.deepEqual(state.observeWaits, [], "no enrollment call before the Gateway is ready");
  markReady(gatewayName);
  const started = Date.now();
  assert.equal((await prepare()).ready, false);
  assert.ok(Date.now() - started >= driver.workspaceNodePairingWaitMs);
  assert.deepEqual(state.observeWaits, [driver.workspaceNodePairingWaitMs]);
  assert.equal(
    [...objects.values()].some(
      (object) => object.kind === "ConfigMap" && object.metadata.name.endsWith("-workspace-node"),
    ),
    false,
    "no node is handed to the Gateway before it pairs",
  );
  state.connected = true;
  assert.equal((await prepare()).ready, true);
});

// A deploy whose Pods cannot be placed says so instead of a generic wait (D224),
// and one whose workloads are ready says it waits only for its node (D222).
test("a pending dedicated deploy reports an unschedulable Pod or an unpaired node", async () => {
  const clock = { now: 0 };
  const { state, gatewayName, agentName, prepare, markReady } = dedicatedFirstDeployFixture({
    clock,
  });
  state.unschedulableRole = "agent";
  const unschedulable = await prepare();
  assert.equal(unschedulable.ready, false);
  assert.equal(unschedulable.pendingReason, "WORKLOAD_UNSCHEDULABLE");
  state.unschedulableRole = undefined;
  const starting = await prepare();
  assert.equal(starting.ready, false);
  assert.equal(starting.pendingReason, undefined);
  markReady(agentName);
  markReady(gatewayName);
  const unpaired = await prepare();
  assert.equal(unpaired.ready, false);
  assert.equal(unpaired.pendingReason, "WORKSPACE_NODE_PENDING");
  state.connected = true;
  const ready = await prepare();
  assert.equal(ready.ready, true);
  assert.equal(ready.pendingReason, undefined);
});

// The worker is serial: every pass one Agent spends waiting for its node holds
// up every other Agent's deploy. A node that never pairs gets one bounded wait
// per setup, across all passes, then a single read per pass, as before #816 (D88).
test("an unpaired workspace node costs at most one bounded wait across passes", async () => {
  const clock = { now: 0 };
  const { state, driver, gatewayName, agentName, prepare, markReady } = dedicatedFirstDeployFixture(
    { clock },
  );
  assert.equal(driver.workspaceNodePairingWaitMs, 8_000);
  assert.equal((await prepare()).ready, false);
  markReady(agentName);
  markReady(gatewayName);
  const passTimes = [];
  for (let pass = 0; pass < 6; pass++) {
    const started = clock.now;
    assert.equal((await prepare()).ready, false);
    passTimes.push(clock.now - started);
  }
  assert.deepEqual(state.observeWaits, [8_000, 0, 0, 0, 0, 0]);
  assert.deepEqual(passTimes, [8_000, 0, 0, 0, 0, 0]);
  // A late pairing is still seen by the next single read.
  state.connected = true;
  assert.equal((await prepare()).ready, true);
  assert.equal(clock.now, 8_000);
});

// The normal first deploy keeps #816's fast path: the node pairs within the
// first ready pass's wait, which ends at the pairing, so no pass ends pending.
test("a node that pairs within its wait completes the pass that delivered its setup", async () => {
  const clock = { now: 0 };
  const { state, gatewayName, agentName, prepare, markReady } = dedicatedFirstDeployFixture({
    clock,
  });
  assert.equal((await prepare()).ready, false);
  markReady(agentName);
  markReady(gatewayName);
  state.pairAtMs = 3_000;
  assert.equal((await prepare()).ready, true);
  assert.deepEqual(state.observeWaits, [8_000]);
  assert.equal(clock.now, 3_000, "the pass ends as soon as the node pairs");
  assert.equal(state.gatewayWorkspaceNodeId, "node-1", "and hands the node to the Gateway");
});

// A partly spent budget carries over: a wait cut short (the Gateway restarted
// mid-wait) leaves the next pass only the rest of it.
test("a workspace node pairing budget carries over between passes", async () => {
  const clock = { now: 0 };
  const { state, gatewayName, agentName, prepare, markReady } = dedicatedFirstDeployFixture({
    clock,
  });
  assert.equal((await prepare()).ready, false);
  markReady(agentName);
  markReady(gatewayName);
  state.failAtMs = 5_000;
  await assert.rejects(prepare(), /Gateway connection closed/);
  state.failAtMs = undefined;
  assert.equal((await prepare()).ready, false);
  assert.equal((await prepare()).ready, false);
  assert.deepEqual(state.observeWaits, [8_000, 3_000, 0]);
  assert.equal(clock.now, 8_000);
});

test("a second Agent's deploy pass is not held up by another Agent's unpaired node", async () => {
  const clock = { now: 0 };
  const stuck = dedicatedFirstDeployFixture({ clock });
  const fresh = dedicatedFirstDeployFixture({ clock });
  for (const agent of [stuck, fresh]) {
    assert.equal((await agent.prepare()).ready, false);
    agent.markReady(agent.agentName);
    agent.markReady(agent.gatewayName);
  }
  // The stuck Agent's first ready pass spends its one wait.
  assert.equal((await stuck.prepare()).ready, false);
  assert.equal(clock.now, 8_000);
  // From here the single serial worker alternates between the two Agents. The
  // fresh Agent's node pairs 2 s after its first ready pass starts.
  fresh.state.pairAtMs = clock.now + 2_000;
  const freshStarts = [];
  let freshReady = false;
  for (let round = 0; round < 4; round++) {
    const before = clock.now;
    assert.equal((await stuck.prepare()).ready, false);
    assert.equal(clock.now, before, "the stuck Agent's pass does not wait again");
    if (!freshReady) {
      freshStarts.push(clock.now);
      freshReady = (await fresh.prepare()).ready;
    }
  }
  assert.equal(freshReady, true);
  assert.deepEqual(freshStarts, [8_000], "the fresh Agent pairs within its first ready pass");
  assert.equal(clock.now, 10_000);
  assert.deepEqual(stuck.state.observeWaits, [8_000, 0, 0, 0, 0]);
  assert.deepEqual(fresh.state.observeWaits, [8_000]);
});

// The worker is serial. A first deploy's pairing wait only saves a later pass,
// so it ends as soon as another Agent's Work is due: the pass ends pending, the
// other Agent's pass runs at once, and the first Agent's next pass spends the
// rest of its budget and still completes on the pairing (D221).
test("another Agent's due Work ends a first deploy's pairing wait at once", async () => {
  const clock = { now: 0 };
  const first = dedicatedFirstDeployFixture({ clock });
  const second = dedicatedFirstDeployFixture({ clock });
  for (const agent of [first, second]) {
    agent.state.stepObservations = true;
    assert.equal((await agent.prepare()).ready, false);
    agent.markReady(agent.agentName);
    agent.markReady(agent.gatewayName);
  }
  first.state.pairAtMs = 6_000;
  second.state.pairAtMs = 1_500;
  // The second Agent's Work comes due 1 s into the first Agent's pass.
  const secondDueAt = 1_000;
  const waiting = async () => clock.now >= secondDueAt;
  const firstPass = await withComputeWorkWaiting(waiting, () => first.prepare());
  assert.equal(firstPass.ready, false);
  assert.equal(firstPass.pendingReason, "WORKSPACE_NODE_PENDING");
  assert.equal(clock.now, secondDueAt, "the second Agent's pass starts when its Work is due");
  // Nothing else is waiting while the second Agent's pass runs: it keeps #816's
  // fast path and completes on its own pairing.
  const secondPass = await withComputeWorkWaiting(
    async () => false,
    () => second.prepare(),
  );
  assert.equal(secondPass.ready, true);
  assert.equal(clock.now, 1_500);
  assert.equal(second.state.gatewayWorkspaceNodeId, "node-1");
  // The first Agent's next pass waits out the rest of its 8 s budget and sees
  // its node pair at 6 s; the yielded second only cost what it actually waited.
  const firstRetry = await withComputeWorkWaiting(
    async () => false,
    () => first.prepare(),
  );
  assert.equal(firstRetry.ready, true);
  assert.equal(clock.now, 6_000);
  assert.deepEqual(first.state.observeWaits, [8_000, 7_000]);
  assert.equal(first.state.gatewayWorkspaceNodeId, "node-1");
});

// Activation's ack wait yields the same way: activation fails and is retried,
// and the yielded time is not taken from the binding's ack budget. Waiting
// never relaxes the ack check: a present ack is accepted on the first read and
// an invalid status is still refused (D221).
test("another Agent's due Work ends an activation's ack wait at once", async () => {
  const clock = { now: 0 };
  const { state, driver, revision, gatewayName, agentName, prepare, markReady } =
    dedicatedFirstDeployFixture({ clock });
  driver.delay = async (ms) => {
    clock.now += ms;
  };
  assert.equal((await prepare()).ready, false);
  markReady(agentName);
  markReady(gatewayName);
  state.connected = true;
  state.gatewayAppliesBinding = false;
  assert.equal((await prepare()).ready, true);
  const clients = await driver.apiClients;
  const proxy = clients.core.connectGetNamespacedPodProxyWithPath;
  let ackAtMs;
  let invalidStatus = false;
  clients.core.connectGetNamespacedPodProxyWithPath = async (request) => {
    if (ackAtMs !== undefined && clock.now >= ackAtMs) {
      state.gatewayWorkspaceNodeId = "node-1";
    }
    const status = await proxy(request);
    return invalidStatus && request.path === "openclaw/runtime/status"
      ? { ...status, revisionId: "another-revision" }
      : status;
  };
  const otherDueAt = clock.now + 500;
  const waiting = async () => clock.now >= otherDueAt;
  await assert.rejects(
    withComputeWorkWaiting(waiting, () => driver.activateRevision(revision, authContext(revision))),
    /has not applied its workspace node/,
  );
  assert.equal(clock.now, otherDueAt);
  invalidStatus = true;
  await assert.rejects(
    withComputeWorkWaiting(waiting, () => driver.activateRevision(revision, authContext(revision))),
    /Runtime status returned invalid data/,
  );
  invalidStatus = false;
  assert.equal(clock.now, otherDueAt);
  // With nothing waiting, the retry still has the rest of the 20 s budget and
  // sees an ack that arrives 3 s later.
  ackAtMs = clock.now + 3_000;
  await withComputeWorkWaiting(
    async () => false,
    () => driver.activateRevision(revision, authContext(revision)),
  );
  assert.equal(clock.now, otherDueAt + 3_000);
  // A present ack is accepted on the first read even with Work waiting.
  const before = clock.now;
  await withComputeWorkWaiting(
    async () => true,
    () => driver.activateRevision(revision, authContext(revision)),
  );
  assert.equal(clock.now, before);
});

test("activation fails with OpenClaw's reason when the Gateway cannot apply its workspace node", async () => {
  const { state, driver, revision, gatewayName, agentName, templates, prepare, markReady } =
    dedicatedFirstDeployFixture();
  assert.equal((await prepare()).ready, false);
  markReady(agentName);
  assert.equal((await prepare()).ready, false);
  markReady(gatewayName);
  state.connected = true;
  // The wrapper writes the node it is handed in this pass, but OpenClaw never
  // reports file-transfer loaded.
  state.gatewayAppliesBinding = false;
  assert.equal((await prepare()).ready, true);
  state.gatewayWorkspaceNodeFailure = {
    code: "RELOAD_NOT_CONFIRMED",
    checkedAt: "2026-09-29T12:00:00.000Z",
  };
  await assert.rejects(
    driver.activateRevision(revision, authContext(revision)),
    /gateway could not apply its workspace node \(RELOAD_NOT_CONFIRMED\)/,
  );
  // A malformed cause is refused, not trusted.
  state.gatewayWorkspaceNodeFailure = { code: "not a code" };
  await assert.rejects(
    driver.activateRevision(revision, authContext(revision)),
    /Runtime status returned invalid data/,
  );
  // Neither failure replaced the serving Gateway.
  assert.deepEqual(
    templates.map(({ name }) => (name === agentName ? "harness" : name)),
    [gatewayName, "harness"],
  );
});

// The start-count ratchet for installs without network.pluginStatusProxySourceCidrs.
// The second Gateway start is the price of omitting them: the development
// launcher sets them (internal/occdev status_proxy_k3d.go), so its first deploys
// take the single-start path pinned above.
test("without a status proxy a dedicated Codex Gateway keeps its workspace node in the pod spec", async () => {
  const {
    state,
    driver,
    revision,
    gatewayName,
    agentName,
    objects,
    templates,
    prepare,
    markReady,
  } = dedicatedFirstDeployFixture({ statusProxy: false });
  const environment = (template) =>
    Object.fromEntries(template.spec.containers[0].env.map(({ name, value }) => [name, value]));
  assert.equal((await prepare()).ready, false);
  markReady(agentName);
  assert.equal((await prepare()).ready, false);
  markReady(gatewayName);
  state.connected = true;
  assert.equal((await prepare()).ready, true);
  // The controller cannot read an ack, so the node is applied at Gateway start.
  await assert.rejects(
    driver.activateRevision(revision, authContext(revision)),
    /gateway is not ready/,
  );
  markReady(gatewayName);
  await driver.activateRevision(revision, authContext(revision));
  const gateways = templates.filter(({ name }) => name === gatewayName);
  assert.equal(gateways.length, 2, "activation replaces the Gateway once");
  assert.deepEqual(
    templates.map(({ name }) => (name === agentName ? "harness" : name)),
    [gatewayName, "harness", gatewayName],
    "Harness 1 + Gateway 2",
  );
  const activated = gateways.at(-1).template;
  assert.equal(environment(activated).OPENCLAW_WORKSPACE_NODE_ID, "node-1");
  assert.equal(environment(activated).OPENCLAW_WORKSPACE_NODE_PATH, undefined);
  assert.equal(
    activated.spec.volumes.some(({ name }) => name === "openclaw-workspace-node"),
    false,
  );
  assert.equal(
    [...objects.values()].some(
      (object) => object.kind === "ConfigMap" && object.metadata.name.endsWith("-workspace-node"),
    ),
    false,
  );
});

test("a dedicated redeploy keeps the agent Service on the serving revision until activation", async () => {
  const { state, driver, revision, gatewayName, agentName, templates, read, prepare, markReady } =
    dedicatedFirstDeployFixture();
  state.connected = true;
  assert.equal((await prepare()).ready, false);
  markReady(agentName);
  markReady(gatewayName);
  assert.equal((await prepare()).ready, true);
  await driver.activateRevision(revision, authContext(revision));
  const serviceName = `agent-${digest(revision.agentId)}`;
  const servingSelector = read("Service", serviceName).spec.selector;
  assert.equal(servingSelector["openclaw.dev/revision"], revision.id);
  const successor = { ...structuredClone(revision), id: "revision-routed-2", revision: 2 };
  const successorName = `agent-${digest(revision.agentId)}-rev-${digest(successor.id)}`;
  const gatewayTemplates = templates.filter(({ name }) => name === gatewayName).length;
  // The serving Gateway exists, so the successor's Harness starts alone and the
  // Service does not select it before it is ready.
  assert.equal((await driver.prepareRevision(successor, authContext(successor))).ready, false);
  assert.ok(templates.some(({ name }) => name === successorName));
  assert.equal(templates.filter(({ name }) => name === gatewayName).length, gatewayTemplates);
  assert.deepEqual(read("Service", serviceName).spec.selector, servingSelector);
  // After successor readiness the Service still stays put until activation:
  // "dedicated Harness Service selector satisfies the gateway policy during cutover".
});

test("dedicated replacement starts a candidate Gateway when the predecessor cannot enroll its workspace node", async () => {
  let setupCalls = 0;
  let connected = false;
  const driver = new KubernetesComputeDriver(
    routedOptions({
      runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
    }),
    {
      nodeEnrollment: {
        async createSetup() {
          setupCalls++;
          return { setupId: "setup-1", setupCode: "setup-code", expiresAtMs: Date.now() + 60000 };
        },
        async observeSetup() {
          const activeGateway = read("Deployment", gatewayName, gatewayNamespace);
          if (
            !gatewayEndpointsReady &&
            activeGateway.metadata.annotations?.["openclaw.dev/agent-revision-id"] ===
              oldRevision.id
          ) {
            throw new Error("gateway connection unavailable");
          }
          return connected ? { deviceId: "node-1", connected: true } : undefined;
        },
        async isConnected() {
          return connected;
        },
      },
    },
  );
  const oldRevision = routedRevision(driver, { id: "revision-routed-1", revision: 1 });
  const replacement = routedRevision(driver, { id: "revision-routed-2", revision: 2 });
  const namespace = kubernetesNamespaceName(tenant.id);
  const gatewayNamespace = kubernetesGatewayNamespaceName(tenant.id);
  const gatewayName = `gateway-${digest(replacement.agentId)}`;
  const agentName = `agent-${digest(replacement.agentId)}-rev-${digest(replacement.id)}`;
  const gatewayOwnership = { namespaceId: tenant.id, agentId: replacement.agentId };
  const objects = new Map();
  const key = (kind, name, target = namespace) =>
    `${kind}:${kind === "Namespace" ? "" : target}:${name}`;
  const save = (object) =>
    objects.set(
      key(object.kind, object.metadata.name, object.metadata.namespace),
      structuredClone(object),
    );
  const read = (kind, name, target = namespace) => {
    const value = objects.get(key(kind, name, target));
    if (!value) {
      throw Object.assign(new Error("not found"), { statusCode: 404 });
    }
    return structuredClone(value);
  };
  save({
    ...driver.manifest("v1", "Namespace", namespace, { namespaceId: tenant.id }),
    status: { phase: "Active" },
  });
  save({
    ...driver.gatewayNamespaceManifest({ namespaceId: tenant.id }),
    status: { phase: "Active" },
  });
  save({
    ...driver.manifest(
      "v1",
      "Secret",
      `transport-${digest(replacement.agentId)}`,
      gatewayOwnership,
      { name: gatewayNamespace, plane: "control" },
    ),
    type: "Opaque",
    metadata: {
      ...driver.manifest(
        "v1",
        "Secret",
        `transport-${digest(replacement.agentId)}`,
        gatewayOwnership,
        { name: gatewayNamespace, plane: "control" },
      ).metadata,
      uid: "transport-uid",
      resourceVersion: "1",
    },
    data: {
      "app-server-token": Buffer.from("test-transport").toString("base64"),
    },
  });
  save({
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: "occ-model-key",
      namespace: gatewayNamespace,
      uid: "model-secret-uid",
    },
    data: { value: Buffer.from("fixture-model-key").toString("base64") },
  });
  for (const target of [
    { name: namespace, plane: "execution" },
    { name: kubernetesGatewayNamespaceName(tenant.id), plane: "control" },
  ]) {
    for (const policy of driver.networkPolicies({ namespaceId: tenant.id }, target)) {
      save(policy);
    }
  }
  const predecessor = driver.deployment(
    gatewayName,
    gatewayOwnership,
    { name: gatewayNamespace, plane: "control" },
    options().images.gateway,
    gatewayName,
    "gateway",
    {},
    "info",
    driver.gatewayConfiguration(oldRevision, "previous-node", {
      name: namespace,
      plane: "execution",
    }),
  );
  predecessor.metadata.annotations["openclaw.dev/agent-revision"] = String(oldRevision.revision);
  predecessor.metadata.annotations["openclaw.dev/agent-revision-id"] = oldRevision.id;
  predecessor.metadata.generation = 1;
  predecessor.metadata.uid = `${gatewayName}-uid`;
  predecessor.status = {
    observedGeneration: 1,
    replicas: 1,
    updatedReplicas: 1,
    readyReplicas: 1,
  };
  save(predecessor);

  let candidateGatewayStarted = false;
  let gatewayEndpointsReady = true;
  const clients = { core: {}, apps: {}, networking: {}, objects: {}, discovery: {} };
  for (const [api, kinds] of [
    [clients.core, ["ConfigMap", "Secret", "Service", "ServiceAccount", "PersistentVolumeClaim"]],
    [clients.apps, ["Deployment"]],
    [clients.networking, ["NetworkPolicy"]],
  ]) {
    for (const kind of kinds) {
      api[`readNamespaced${kind}`] = async ({ name, namespace: target }) =>
        read(kind, name, target);
      const write = async ({ body }) => {
        const previous = objects.get(key(kind, body.metadata.name, body.metadata.namespace));
        const changed =
          kind === "Deployment" && JSON.stringify(previous?.spec) !== JSON.stringify(body.spec);
        const value = {
          ...previous,
          ...structuredClone(body),
          metadata: {
            ...previous?.metadata,
            ...body.metadata,
            uid: `${body.metadata.name}-uid`,
            resourceVersion: "1",
          },
        };
        if (kind === "Deployment") {
          value.metadata.generation = (previous?.metadata.generation ?? 0) + Number(changed);
          if (changed) {
            delete value.status;
          }
          if (
            body.metadata.name === gatewayName &&
            body.metadata.annotations?.["openclaw.dev/agent-revision-id"] === replacement.id
          ) {
            candidateGatewayStarted = true;
          }
        }
        if (body.stringData) {
          value.data = Object.fromEntries(
            Object.entries(body.stringData).map(([name, value]) => [
              name,
              Buffer.from(value).toString("base64"),
            ]),
          );
        }
        save(value);
        return value;
      };
      api[`patchNamespaced${kind}`] = write;
      api[`createNamespaced${kind}`] = write;
      api[`replaceNamespaced${kind}`] = write;
    }
  }
  clients.core.listNamespace = async () => ({ items: [] });
  clients.core.readNamespace = async ({ name }) => read("Namespace", name);
  clients.objects.read = async (object) =>
    read(object.kind, object.metadata.name, object.metadata.namespace);
  clients.objects.patch = async (object) => {
    save(object);
    return object;
  };
  clients.discovery.listNamespacedEndpointSlice = async () => ({
    items: gatewayEndpointsReady
      ? [
          {
            metadata: {
              labels: { "kubernetes.io/service-name": gatewayName },
              ownerReferences: [{ kind: "Service", name: gatewayName, uid: `${gatewayName}-uid` }],
            },
            endpoints: [{ conditions: { ready: true } }],
          },
        ]
      : [],
  });
  // The candidate Harness has no Pod until its Deployment exists; a setup
  // written before then reaches the Pod when it mounts the volume.
  const podPatches = [];
  clients.core.listNamespacedPod = async ({ namespace: target, labelSelector }) => ({
    items: objects.has(key("Deployment", agentName))
      ? [
          {
            metadata: {
              name: "candidate-harness",
              namespace: target,
              labels: Object.fromEntries(labelSelector.split(",").map((entry) => entry.split("="))),
            },
          },
        ]
      : [],
  });
  clients.core.patchNamespacedPod = async ({ name }) => {
    podPatches.push(name);
    return {};
  };
  driver.apiClients = Promise.resolve(clients);

  const prepare = () => driver.prepareRevision(replacement, authContext(replacement));
  const markReady = (name) => {
    const target = name === gatewayName ? gatewayNamespace : namespace;
    const object = read("Deployment", name, target);
    object.status = {
      observedGeneration: object.metadata.generation,
      replicas: 1,
      updatedReplicas: 1,
      readyReplicas: 1,
    };
    save(object);
  };

  assert.equal((await prepare()).ready, false);
  assert.equal(candidateGatewayStarted, false);
  assert.equal(setupCalls, 1);
  assert.deepEqual(podPatches, [], "the setup was written before the candidate Harness existed");
  const initiallyPreparedAgent = read("Deployment", agentName);
  assert.ok(
    initiallyPreparedAgent.spec.template.spec.containers[0].env.some(
      (variable) => variable.name === "OPENCLAW_NODE_SETUP_PATH",
    ),
  );
  markReady(agentName);

  assert.equal((await prepare()).ready, false);
  assert.equal(
    read("Deployment", gatewayName, gatewayNamespace).metadata.annotations[
      "openclaw.dev/agent-revision-id"
    ],
    oldRevision.id,
    "healthy predecessor keeps serving workspace-node enrollment while setup is pending",
  );
  assert.equal(candidateGatewayStarted, false);

  gatewayEndpointsReady = false;
  assert.equal((await prepare()).ready, false);
  assert.equal(
    read("Deployment", gatewayName, gatewayNamespace).metadata.annotations[
      "openclaw.dev/agent-revision-id"
    ],
    replacement.id,
  );
  markReady(gatewayName);
  gatewayEndpointsReady = true;

  assert.equal((await prepare()).ready, false);
  assert.equal(setupCalls, 1);
  // A candidate Gateway does not change the Harness it enrolls.
  assert.deepEqual(
    read("Deployment", agentName).spec.template,
    initiallyPreparedAgent.spec.template,
  );
  connected = true;
  assert.equal((await prepare()).ready, true);
  assert.equal(setupCalls, 1);
});

test("namespace resolver selects exact, secure external ownership using a transport-only fixture", async () => {
  const external = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: "customer-support",
      labels: {
        "app.kubernetes.io/managed-by": "helm",
        "openclaw.dev/namespace": tenant.id,
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/audit": "restricted",
        "pod-security.kubernetes.io/warn": "restricted",
      },
      annotations: {
        "openclaw.dev/namespace-id": tenant.id,
        "openclaw.dev/namespace-lifecycle": "external",
      },
    },
    status: { phase: "Active" },
  };
  // The fixture supplies Kubernetes response data only; the actual resolver makes every decision.
  const discover = (items, namespaceId = tenant.id) =>
    resolveKubernetesNamespace(
      {
        async listNamespace(request) {
          assert.equal(request.labelSelector, `openclaw.dev/namespace=${namespaceId}`);
          return { apiVersion: "v1", kind: "NamespaceList", items };
        },
      },
      namespaceId,
    );

  assert.deepEqual(await discover([external]), { name: "customer-support", external: true });
  assert.deepEqual(await discover([]), {
    name: kubernetesNamespaceName(tenant.id),
    external: false,
  });

  const managed = structuredClone(external);
  managed.metadata.name = kubernetesNamespaceName(tenant.id);
  managed.metadata.labels["app.kubernetes.io/managed-by"] = "openclaw-enterprise";
  delete managed.metadata.annotations["openclaw.dev/namespace-lifecycle"];
  assert.deepEqual(await discover([managed]), { name: managed.metadata.name, external: false });

  const upgraded = structuredClone(managed);
  upgraded.metadata.name = previousTenantNamespaceName;
  assert.deepEqual(await discover([upgraded]), { name: upgraded.metadata.name, external: false });

  const upgradedPunctuated = structuredClone(managed);
  upgradedPunctuated.metadata.name = previousPunctuatedNamespace.name;
  upgradedPunctuated.metadata.labels["openclaw.dev/namespace"] = previousPunctuatedNamespace.id;
  upgradedPunctuated.metadata.annotations["openclaw.dev/namespace-id"] =
    previousPunctuatedNamespace.id;
  assert.deepEqual(await discover([upgradedPunctuated], previousPunctuatedNamespace.id), {
    name: previousPunctuatedNamespace.name,
    external: false,
  });

  await assert.rejects(discover([external, structuredClone(external)]), /multiple/i);
  for (const [mutate, expected] of [
    [(item) => (item.metadata.name = ""), /unowned/i],
    [
      (item) => (item.metadata.annotations["openclaw.dev/namespace-id"] = "another-tenant"),
      /unowned/i,
    ],
    [
      (item) => delete item.metadata.annotations["openclaw.dev/namespace-lifecycle"],
      /external ownership/i,
    ],
    [
      (item) => {
        delete item.metadata.annotations["openclaw.dev/namespace-lifecycle"];
        item.metadata.labels["app.kubernetes.io/managed-by"] = "openclaw-enterprise";
        item.metadata.name = "oce-wrong-managed-name";
      },
      /external ownership/i,
    ],
    [
      (item) => {
        delete item.metadata.annotations["openclaw.dev/namespace-lifecycle"];
        item.metadata.name = previousTenantNamespaceName;
      },
      /external ownership/i,
    ],
    [
      (item) => (item.metadata.labels["pod-security.kubernetes.io/enforce"] = "baseline"),
      /restricted/i,
    ],
    [(item) => (item.status.phase = "Pending"), /active/i],
    [(item) => (item.metadata.deletionTimestamp = "2026-08-25T00:00:00Z"), /active/i],
  ]) {
    // Each rejection exercises the real resolver against malformed, ambiguous, or unsafe ownership.
    const invalid = structuredClone(external);
    mutate(invalid);
    await assert.rejects(discover([invalid]), expected);
  }
});

test("Kubernetes namespace deletion waits for Sandbox namespace cleanup", async () => {
  const calls = [];
  let cleanupAttempts = 0;
  let present = true;
  const namespaceName = previousTenantNamespaceName;
  const namespaceResource = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: namespaceName,
      uid: "namespace-cleanup-uid",
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace": tenant.id,
      },
      annotations: { "openclaw.dev/namespace-id": tenant.id },
    },
    status: { phase: "Active" },
  };
  const sandboxDriver = {
    id: "sandbox-namespace-cleanup",
    implementation: "test/namespace-cleanup",
    capability: "sandbox",
    facets: ["networking"],
    async cleanup(context) {
      assert.equal(context.revision, undefined);
      calls.push("sandbox-cleanup");
      assert.equal(context.namespace.id, tenant.id);
      assert.equal(context.namespace.name, namespaceName);
      cleanupAttempts += 1;
      if (cleanupAttempts === 1) {
        throw new Error("workspace remains nonempty");
      }
    },
  };
  const driver = new KubernetesComputeDriver(options(), { sandboxDriver });
  const notFound = () => Object.assign(new Error("Not found"), { code: 404 });
  driver.apiClients = Promise.resolve({
    core: {
      async listNamespace() {
        return { items: present ? [structuredClone(namespaceResource)] : [] };
      },
      async readNamespace({ name }) {
        if (!present || name !== namespaceName) {
          throw notFound();
        }
        return structuredClone(namespaceResource);
      },
      async deleteNamespace(request) {
        calls.push("kubernetes-delete");
        assert.equal(cleanupAttempts, 2);
        assert.deepEqual(request, {
          name: namespaceName,
          body: { preconditions: { uid: namespaceResource.metadata.uid } },
        });
        present = false;
      },
    },
    objects: {},
  });

  // A provider cleanup failure must leave the Kubernetes Namespace intact for a safe retry.
  assert.deepEqual(await driver.deleteNamespace({ ...tenant, status: "deleting" }), {
    namespaceId: tenant.id,
    namespaceDeleted: false,
    failure: "retryable",
  });
  assert.equal(present, true);
  assert.deepEqual(calls, ["sandbox-cleanup"]);

  assert.deepEqual(await driver.deleteNamespace({ ...tenant, status: "deleting" }), {
    namespaceId: tenant.id,
    namespaceDeleted: true,
  });
  assert.deepEqual(calls, ["sandbox-cleanup", "sandbox-cleanup", "kubernetes-delete"]);
});

test("explicit existing namespace adoption claims tenant identity only after security checks", async () => {
  const selection = { ...tenant, status: "provisioning", existingNamespace: "customer-support" };
  const prepared = () => ({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: selection.existingNamespace,
      resourceVersion: "7",
      labels: {
        "app.kubernetes.io/managed-by": "helm",
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/audit": "restricted",
        "pod-security.kubernetes.io/warn": "restricted",
      },
      annotations: { "openclaw.dev/namespace-lifecycle": "external", "example.dev/keep": "yes" },
    },
    status: { phase: "Active" },
  });
  const httpError = (statusCode) => Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });

  const run = async ({
    mutate,
    policies,
    conflict,
    forbiddenPolicies,
    claims,
    deleting,
    unselected,
    computeOptions = options(),
  } = {}) => {
    let observed = prepared();
    mutate?.(observed);
    const patches = [];
    const driver = createKubernetesComputeDriver(computeOptions);
    // The fixture supplies transport responses only; adoption, validation, and mutation order
    // are exercised through the production driver's real ensureNamespace implementation.
    driver.apiClients = Promise.resolve({
      core: {
        async listNamespace({ labelSelector }) {
          assert.equal(labelSelector, `openclaw.dev/namespace=${tenant.id}`);
          return { items: claims ?? [] };
        },
        async readNamespace({ name }) {
          if (name === kubernetesGatewayNamespaceName(tenant.id)) {
            throw httpError(404);
          }
          assert.equal(name, selection.existingNamespace);
          if (observed === undefined) {
            throw httpError(404);
          }
          return structuredClone(observed);
        },
        async patchNamespace(request) {
          patches.push(structuredClone(request));
          if (conflict !== undefined) {
            conflict(observed);
            throw httpError(409);
          }
          const metadata = request.body.metadata;
          observed.metadata = {
            ...observed.metadata,
            labels: { ...observed.metadata.labels, ...metadata.labels },
            annotations: { ...observed.metadata.annotations, ...metadata.annotations },
          };
        },
        async readNamespacedResourceQuota() {
          // Stop at the first namespaced infrastructure request after successful adoption.
          throw httpError(403);
        },
      },
      networking: {
        async listNamespacedNetworkPolicy({ namespace }) {
          assert.equal(namespace, selection.existingNamespace);
          if (forbiddenPolicies) {
            throw httpError(403);
          }
          return { items: policies ?? [] };
        },
      },
    });
    driver.executionApiClients = driver.apiClients;
    if (mutate === null) {
      observed = undefined;
    }
    const result = deleting
      ? await driver.deleteNamespace({ ...selection, status: "deleting" })
      : await driver.ensureNamespace(
          unselected ? { ...tenant, status: "provisioning" } : selection,
        );
    return { result, observed, patches };
  };

  const dual = await run({
    computeOptions: routedOptions({
      runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
      executionCluster: {
        authentication: { mode: "kubeconfig", kubeconfigPath, context: contextName },
        harnessRouting: {
          ...gatewayRouting,
          gatewayName: "harnesses",
          hostname: "harness.example.test",
        },
        network: {
          dns: options().network.dns,
          harnessEndpointCidrs: ["192.0.2.2/32"],
          gatewayEndpointCidrs: ["192.0.2.1/32"],
          pluginStatusProxySourceCidrs: ["192.0.2.2/32"],
        },
      },
    }),
  });
  assert.equal(
    dual.observed.metadata.labels["openclaw-enterprise.io/gateway"],
    digest(`${gatewayRouting.gatewayNamespace}/harnesses`),
  );
  const adopted = await run();
  assert.deepEqual(adopted.result, { namespaceId: tenant.id, namespaceReady: false });
  assert.deepEqual(adopted.patches, [
    {
      name: selection.existingNamespace,
      body: {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: {
          name: selection.existingNamespace,
          resourceVersion: "7",
          labels: { "openclaw.dev/namespace": tenant.id },
          annotations: { "openclaw.dev/namespace-id": tenant.id },
        },
      },
      fieldManager: "openclaw-enterprise-compute",
      force: false,
    },
  ]);
  assert.equal(adopted.observed.metadata.labels["app.kubernetes.io/managed-by"], "helm");
  assert.equal(adopted.observed.metadata.annotations["example.dev/keep"], "yes");
  assert.equal(
    adopted.observed.metadata.annotations["openclaw.dev/namespace-lifecycle"],
    "external",
  );

  const neverAdopted = await run({ deleting: true });
  assert.deepEqual(neverAdopted.result, { namespaceId: tenant.id, namespaceDeleted: true });
  assert.deepEqual(neverAdopted.patches, []);

  for (const mutate of [
    (namespace) => (namespace.metadata.labels["openclaw.dev/namespace"] = tenant.id),
    (namespace) => (namespace.metadata.annotations["openclaw.dev/namespace-id"] = tenant.id),
    (namespace) => (namespace.metadata.annotations["openclaw.dev/namespace-id"] = "ns_other"),
  ]) {
    const ambiguous = await run({ mutate, deleting: true });
    assert.deepEqual(ambiguous.result, {
      namespaceId: tenant.id,
      namespaceDeleted: false,
      failure: "permanent",
    });
    assert.deepEqual(ambiguous.patches, []);
  }

  const duplicateClaim = await run({ claims: [{ metadata: { name: "another-namespace" } }] });
  assert.equal(duplicateClaim.result.failure, "permanent");
  assert.deepEqual(duplicateClaim.patches, []);

  const implicitlyClaimedNamespace = prepared();
  implicitlyClaimedNamespace.metadata.labels["openclaw.dev/namespace"] = tenant.id;
  implicitlyClaimedNamespace.metadata.annotations["openclaw.dev/namespace-id"] = tenant.id;
  const implicitAdoption = await run({ claims: [implicitlyClaimedNamespace], unselected: true });
  assert.deepEqual(implicitAdoption.result, {
    namespaceId: tenant.id,
    namespaceReady: false,
    failure: "permanent",
  });
  assert.deepEqual(implicitAdoption.patches, []);

  for (const mutate of [
    null,
    (namespace) => delete namespace.metadata.annotations["openclaw.dev/namespace-lifecycle"],
    (namespace) => (namespace.metadata.labels["pod-security.kubernetes.io/enforce"] = "baseline"),
    (namespace) => (namespace.metadata.labels["openclaw.dev/namespace"] = "other-tenant"),
    (namespace) => (namespace.metadata.annotations["openclaw.dev/namespace-id"] = "ns_other"),
    (namespace) => (namespace.status.phase = "Terminating"),
    (namespace) => (namespace.metadata.deletionTimestamp = "2026-08-26T00:00:00.000Z"),
    (namespace) => delete namespace.metadata.resourceVersion,
  ]) {
    const rejected = await run({ mutate });
    assert.deepEqual(rejected.result, {
      namespaceId: tenant.id,
      namespaceReady: false,
      failure: "permanent",
    });
    assert.deepEqual(rejected.patches, []);
  }

  const foreignPolicies = await run({
    policies: [
      {
        kind: "NetworkPolicy",
        metadata: { name: "foreign", namespace: selection.existingNamespace },
      },
    ],
  });
  assert.equal(foreignPolicies.result.failure, "permanent");
  assert.deepEqual(foreignPolicies.patches, []);

  const inaccessible = await run({ forbiddenPolicies: true });
  assert.deepEqual(inaccessible.result, { namespaceId: tenant.id, namespaceReady: false });
  assert.deepEqual(inaccessible.patches, []);

  const competingTenant = await run({
    conflict(namespace) {
      namespace.metadata.labels["openclaw.dev/namespace"] = "another-tenant";
      namespace.metadata.annotations["openclaw.dev/namespace-id"] = "ns_another";
    },
  });
  assert.equal(competingTenant.result.failure, "permanent");
  assert.equal(competingTenant.patches.length, 1);

  const sameTenant = await run({
    conflict(namespace) {
      namespace.metadata.labels["openclaw.dev/namespace"] = tenant.id;
      namespace.metadata.annotations["openclaw.dev/namespace-id"] = tenant.id;
    },
  });
  assert.deepEqual(sameTenant.result, { namespaceId: tenant.id, namespaceReady: false });
  assert.equal(sameTenant.patches.length, 1);
});

test("dedicated Agent shared claims retain ownership inside an existing tenant namespace", () => {
  const driver = createKubernetesComputeDriver(options());
  const agentId = "agt_00000000-0000-4000-8000-000000000001";
  const ownership = { namespaceId: tenant.id, agentId };

  // Exercise the real PVC serializer against discovered placement, not a simulated cluster.
  const claim = driver.harnessWorkspaceClaim(agentId, ownership, {
    name: "customer-support",
    plane: "execution",
  });
  assert.equal(claim.metadata.namespace, "customer-support");
  assert.equal(claim.metadata.annotations["openclaw.dev/namespace-id"], tenant.id);
  assert.equal(claim.metadata.annotations["openclaw.dev/agent-id"], agentId);
  assert.deepEqual(claim.spec.accessModes, ["ReadWriteOnce"]);
  assert.equal(claim.spec.resources.requests.storage, "40Gi");
});

test("Namespace deletion removes only its owned Gateway target after data-plane loss", async () => {
  for (const external of [false, true]) {
    for (const foreign of [false, true]) {
      const calls = [];
      const driver = new KubernetesComputeDriver(options(), {
        lifecycleDrivers: [
          {
            id: "configuration-selected",
            capability: "configuration",
            implementation: "local-selected",
            computeLifecycleHooks: {
              async beforeNamespaceDelete() {
                calls.push("revoke");
              },
            },
          },
        ],
      });
      let gateway = driver.gatewayNamespaceManifest({ namespaceId: tenant.id });
      gateway.metadata.uid = "owned-gateway-namespace-uid";
      if (foreign) {
        gateway.metadata.annotations["openclaw.dev/namespace-id"] = "ns_other";
      }
      const target = gateway.metadata.name;
      // Exercise the actual delete lifecycle with an absent managed target or an
      // external namespace whose logical claim is gone. Never delete that external namespace.
      driver.apiClients = Promise.resolve({
        core: {
          async listNamespace() {
            return { items: [] };
          },
          async readNamespace({ name }) {
            if (name === target && gateway !== undefined) {
              return structuredClone(gateway);
            }
            if (external && name === "customer-support") {
              return { apiVersion: "v1", kind: "Namespace", metadata: { name } };
            }
            throw Object.assign(new Error("Not found"), { statusCode: 404 });
          },
          async deleteNamespace({ name, body }) {
            assert.equal(name, target);
            assert.equal(body.preconditions.uid, gateway.metadata.uid);
            calls.push("delete-gateway");
            gateway = undefined;
          },
        },
      });
      const result = await driver.deleteNamespace({
        ...tenant,
        status: "deleting",
        ...(external ? { existingNamespace: "customer-support" } : {}),
      });
      assert.deepEqual(result, {
        namespaceId: tenant.id,
        namespaceDeleted: !foreign,
        ...(foreign ? { failure: "permanent" } : {}),
      });
      assert.deepEqual(calls, foreign ? [] : ["revoke", "delete-gateway"]);
    }
  }
});

test("sandbox routing keeps generated HTML off the administrative origin and backend", () => {
  const driver = createKubernetesComputeDriver(
    routedOptions({
      runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
      gatewayRouting: {
        ...gatewayRouting,
        sandbox: { domain: "previews.example.test", publicPort: 9443 },
      },
    }),
  );
  const revision = routedRevision(driver);
  const document = driver.gatewaySandboxConfiguration(revision, revision.configuration);
  const origin = new URL(document.mcp.apps.sandboxOrigin);
  assert.equal(origin.protocol, "https:");
  assert.equal(origin.port, "9443");
  assert(origin.hostname.endsWith(".previews.example.test"));
  assert.notEqual(origin.hostname, gatewayRouting.hostname);
  assert.deepEqual(document.gateway, revision.configuration.gateway);
  const embeddedConfiguration = {
    ...revision.configuration,
    mcp: { apps: { sandboxOrigin: "https://embedded-preview.example.test" } },
  };
  assert.deepEqual(
    driver.gatewaySandboxConfiguration(
      { ...revision, harness: { ...revision.harness, mode: "embedded" } },
      embeddedConfiguration,
    ),
    embeddedConfiguration,
    "dedicated preview routing must not replace an Embedded Agent's native configuration",
  );
  assert.equal(
    driver.gatewaySandboxConfiguration({ ...revision, id: "replacement" }, revision.configuration)
      .mcp.apps.sandboxOrigin,
    origin.origin,
  );
  assert.notEqual(
    driver.gatewaySandboxConfiguration(
      { ...revision, agentId: "another-agent" },
      revision.configuration,
    ).mcp.apps.sandboxOrigin,
    origin.origin,
  );
  assert.throws(
    () =>
      driver.gatewaySandboxConfiguration(revision, {
        ...revision.configuration,
        mcp: { apps: { sandboxOrigin: "https://trusted-admin.example.test" } },
      }),
    /Compute-owned sandbox route/,
  );
  const ownership = { namespaceId: tenant.id, agentId: revision.agentId };
  const namespace = { name: kubernetesGatewayNamespaceName(tenant.id), plane: "control" };
  const service = driver.service("gateway-test", ownership, namespace, {});
  const route = driver.gatewayRoute(revision, ownership, namespace, service, "sandbox");
  assert.deepEqual(route.spec.hostnames, [origin.hostname]);
  assert.equal(route.spec.parentRefs[0].sectionName, "sandbox");
  const rule = route.spec.rules[0];
  assert.deepEqual(
    rule.matches.map((match) => match.method),
    ["GET", "HEAD"],
  );
  assert.equal(rule.backendRefs[0].port, document.mcp.apps.sandboxPort);
  assert.notEqual(
    rule.backendRefs[0].port,
    driver.gatewayRoute(revision, ownership, namespace, service).spec.rules[0].backendRefs[0].port,
  );
  const headers = rule.filters[0].requestHeaderModifier;
  for (const name of ["cookie", "authorization", "x-api-key", "x-occ-identity"]) {
    assert(headers.remove.includes(name));
    assert(!headers.set.some((header) => header.name === name));
  }
  assert(service.spec.ports.some((port) => port.port === rule.backendRefs[0].port));
  const disabled = createKubernetesComputeDriver(routedOptions());
  assert.equal(
    disabled.gatewayRoute(revision, ownership, namespace, service, "sandbox"),
    undefined,
  );
});

test("gateway routing derives stable endpoints and exact Envoy HTTPRoutes", async () => {
  const driver = createKubernetesComputeDriver(routedOptions());
  const revision = routedRevision(driver);
  const namespace = kubernetesNamespaceName(tenant.id);
  const name = `gateway-${digest(revision.agentId)}`;
  const ownership = { namespaceId: tenant.id, agentId: revision.agentId };
  const nodeEgress = driver.workspaceNodeNetworkPolicy(
    { namespaceId: tenant.id },
    { name: namespace, plane: "execution" },
  );
  assert.equal(nodeEgress.metadata.annotations["openclaw.dev/namespace-id"], tenant.id);
  assert.deepEqual(nodeEgress.spec, {
    podSelector: {
      matchLabels: {
        "openclaw.dev/workload-role": "agent",
        "openclaw.dev/network-profile": "broad-egress-v1",
      },
    },
    policyTypes: ["Egress"],
    egress: [
      {
        to: [
          {
            namespaceSelector: {
              matchLabels: { "kubernetes.io/metadata.name": gatewayRouting.envoyNamespace },
            },
            podSelector: {
              matchLabels: {
                "app.kubernetes.io/component": "proxy",
                "app.kubernetes.io/managed-by": "envoy-gateway",
                "app.kubernetes.io/name": "envoy",
                "gateway.envoyproxy.io/owning-gateway-namespace": gatewayRouting.gatewayNamespace,
                "gateway.envoyproxy.io/owning-gateway-name": gatewayRouting.gatewayName,
              },
            },
          },
        ],
        ports: [{ protocol: "TCP", port: 10443 }],
      },
    ],
  });
  const customPortDriver = createKubernetesComputeDriver(
    routedOptions({
      gatewayRouting: { ...gatewayRouting, envoyHttpsTargetPort: 11443 },
    }),
  );
  assert.deepEqual(
    customPortDriver.workspaceNodeNetworkPolicy(
      { namespaceId: tenant.id },
      { name: namespace, plane: "execution" },
    ).spec.egress[0].ports,
    [{ protocol: "TCP", port: 11443 }],
  );
  const service = driver.service(
    name,
    ownership,
    { name: namespace, plane: "execution" },
    {
      "app.kubernetes.io/name": name,
    },
  );
  service.metadata.uid = "gateway-service-uid";

  assert.equal(
    driver.getGatewayEndpoint(revision),
    `wss://${gatewayRouting.hostname}/namespaces/${tenant.id}/agents/${revision.agentId}`,
  );
  const alternateEndpointDriver = createKubernetesComputeDriver(
    routedOptions({ gatewayRouting: { ...gatewayRouting, endpointPort: 18443 } }),
  );
  const alternateEndpointRevision = routedRevision(alternateEndpointDriver);
  assert.equal(
    alternateEndpointDriver.getGatewayEndpoint(alternateEndpointRevision),
    `wss://${gatewayRouting.hostname}:18443/namespaces/${tenant.id}/agents/${alternateEndpointRevision.agentId}`,
  );
  assert.deepEqual(
    alternateEndpointDriver.gatewayRoute(
      alternateEndpointRevision,
      ownership,
      { name: namespace, plane: "execution" },
      service,
    ).spec.hostnames,
    [gatewayRouting.hostname],
  );

  const route = driver.gatewayRoute(
    revision,
    ownership,
    { name: namespace, plane: "execution" },
    service,
  );
  assert.equal(route.apiVersion, "gateway.networking.k8s.io/v1");
  assert.equal(route.kind, "HTTPRoute");
  assert.equal(route.metadata.name, name);
  assert.equal(route.metadata.namespace, namespace);
  assert.equal(route.metadata.labels["openclaw.dev/agent"], revision.agentId);
  assert.equal(
    route.metadata.annotations["openclaw.dev/agent-revision"],
    String(revision.revision),
  );
  assert.equal(route.metadata.annotations["openclaw.dev/agent-revision-id"], revision.id);
  assert.deepEqual(route.metadata.ownerReferences, [
    {
      apiVersion: "v1",
      kind: "Service",
      name,
      uid: "gateway-service-uid",
      controller: false,
      blockOwnerDeletion: false,
    },
  ]);
  assert.deepEqual(route.spec.hostnames, [gatewayRouting.hostname]);
  assert.deepEqual(route.spec.parentRefs, [
    {
      group: "gateway.networking.k8s.io",
      kind: "Gateway",
      namespace: gatewayRouting.gatewayNamespace,
      name: gatewayRouting.gatewayName,
      sectionName: "https",
    },
  ]);
  assert.deepEqual(route.spec.rules[0].matches, [
    { path: { type: "Exact", value: `/namespaces/${tenant.id}/agents/${revision.agentId}` } },
  ]);
  assert.deepEqual(route.spec.rules[1].matches, [
    { path: { type: "PathPrefix", value: `/namespaces/${tenant.id}/agents/${revision.agentId}/` } },
  ]);
  assert.deepEqual(route.spec.rules[0].backendRefs, [
    { group: "", kind: "Service", name, port: 8080 },
  ]);
  assert.deepEqual(route.spec.rules[1].backendRefs, [
    { group: "", kind: "Service", name, port: 8080 },
  ]);
  assert.deepEqual(route.spec.rules[0].filters, [
    {
      type: "URLRewrite",
      urlRewrite: { path: { type: "ReplaceFullPath", replaceFullPath: "/" } },
    },
    {
      type: "RequestHeaderModifier",
      requestHeaderModifier: {
        set: [
          { name: "x-occ-identity", value: "occ-workspace-files" },
          { name: "x-real-ip", value: "%DOWNSTREAM_DIRECT_REMOTE_ADDRESS_WITHOUT_PORT%" },
        ],
        remove: ["authorization", "cookie", "forwarded", "x-forwarded-for", "x-openclaw-scopes"],
      },
    },
  ]);
  assert.deepEqual(route.spec.rules[1].filters, [
    {
      type: "URLRewrite",
      urlRewrite: {
        path: { type: "ReplacePrefixMatch", replacePrefixMatch: "/" },
      },
    },
    route.spec.rules[0].filters[1],
  ]);

  // Node enrollment and worker admission authenticate inside OpenClaw, while
  // worker bundles use their own one-time bearer token instead of the administrative API key.
  const nodeRoute = driver.gatewayRoute(
    revision,
    ownership,
    { name: namespace, plane: "execution" },
    service,
    "node",
  );
  assert.equal(nodeRoute.spec.rules.length, 4);
  assert.deepEqual(nodeRoute.spec.rules[0].matches, [
    { path: { type: "Exact", value: `/namespaces/${tenant.id}/agents/${revision.agentId}/node` } },
  ]);
  const nodeHeaders = nodeRoute.spec.rules[0].filters.find(
    (filter) => filter.type === "RequestHeaderModifier",
  ).requestHeaderModifier;
  assert.equal(
    nodeHeaders.set.some(({ name }) => name === "x-occ-identity"),
    false,
  );
  for (const header of [
    "authorization",
    "cookie",
    "x-occ-identity",
    "x-api-key",
    "x-openclaw-scopes",
    "tailscale-user-login",
  ]) {
    assert.ok(nodeHeaders.remove.includes(header), `node route must strip ${header}`);
  }
  assert.deepEqual(nodeRoute.spec.rules[1], {
    matches: [
      {
        path: {
          type: "Exact",
          value: `/namespaces/${tenant.id}/agents/${revision.agentId}/node/__openclaw__/worker`,
        },
      },
    ],
    filters: [
      {
        type: "URLRewrite",
        urlRewrite: {
          path: { type: "ReplaceFullPath", replaceFullPath: "/__openclaw__/worker" },
        },
      },
      nodeRoute.spec.rules[0].filters[1],
    ],
    backendRefs: [{ group: "", kind: "Service", name, port: 8080 }],
  });
  for (const [rule, transferPath] of nodeRoute.spec.rules
    .slice(2)
    .map((rule, index) => [rule, ["worker-bundle/v1", "worker-transfer/v1"][index]])) {
    assert.deepEqual(rule.matches, [
      {
        path: {
          type: "PathPrefix",
          value: `/namespaces/${tenant.id}/agents/${revision.agentId}/node/__openclaw__/${transferPath}/`,
        },
      },
    ]);
    assert.deepEqual(rule.filters[0], {
      type: "URLRewrite",
      urlRewrite: {
        path: {
          type: "ReplacePrefixMatch",
          replacePrefixMatch: `/__openclaw__/${transferPath}/`,
        },
      },
    });
    const transferHeaders = rule.filters[1].requestHeaderModifier;
    assert.equal(transferHeaders.remove.includes("authorization"), false);
    for (const header of ["cookie", "x-occ-identity", "x-api-key", "x-openclaw-scopes"]) {
      assert.ok(transferHeaders.remove.includes(header), `transfer route must strip ${header}`);
    }
  }

  const ingress = driver
    .networkPolicies(ownership, { name: namespace, plane: "execution" })
    .find(({ metadata }) => metadata.name === "allow-gateway-ingress");
  assert.deepEqual(ingress.spec.ingress, [
    {
      from: [
        {
          namespaceSelector: {
            matchLabels: { "kubernetes.io/metadata.name": gatewayRouting.envoyNamespace },
          },
          podSelector: {
            matchLabels: {
              "gateway.envoyproxy.io/owning-gateway-namespace": gatewayRouting.gatewayNamespace,
              "gateway.envoyproxy.io/owning-gateway-name": gatewayRouting.gatewayName,
            },
          },
        },
      ],
      ports: [{ protocol: "TCP", port: 8080 }],
    },
  ]);

  const omittedHostnameRouting = {
    gatewayName: gatewayRouting.gatewayName,
    gatewayNamespace: gatewayRouting.gatewayNamespace,
    envoyNamespace: gatewayRouting.envoyNamespace,
  };
  const emptyHostnameRouting = { ...gatewayRouting, hostname: "" };
  const alternateNamespaceRouting = {
    ...omittedHostnameRouting,
    gatewayNamespace: "openclaw-alt",
  };
  const derivedOutputs = [];
  for (const routing of [omittedHostnameRouting, emptyHostnameRouting, alternateNamespaceRouting]) {
    const derivedDriver = createKubernetesComputeDriver(routedOptions({ gatewayRouting: routing }));
    const derivedRevision = routedRevision(derivedDriver);
    const expectedHostname = defaultGatewayHostname(routing);
    const endpoint = derivedDriver.getGatewayEndpoint(derivedRevision);
    const hostnames = derivedDriver.gatewayRoute(
      derivedRevision,
      ownership,
      { name: namespace, plane: "execution" },
      service,
    ).spec.hostnames;
    assert.equal(
      endpoint,
      `wss://${expectedHostname}/namespaces/${tenant.id}/agents/${derivedRevision.agentId}`,
    );
    assert.deepEqual(hostnames, [expectedHostname]);
    derivedOutputs.push({ endpoint, hostnames });
  }
  assert.notEqual(derivedOutputs[0].endpoint, derivedOutputs[2].endpoint);
  assert.notDeepEqual(derivedOutputs[0].hostnames, derivedOutputs[2].hostnames);

  const plainGateway = driver.deployment(
    name,
    ownership,
    { name: namespace, plane: "execution" },
    "openclaw-enterprise/gateway-fixture:local",
    name,
    "gateway",
    {},
    "info",
    driver.gatewayConfiguration(revision, undefined, {
      name: kubernetesNamespaceName(tenant.id),
      plane: "execution",
    }),
  );
  const plainPod = plainGateway.spec.template.spec;
  const plainEnvironment = Object.fromEntries(
    plainPod.containers[0].env.map((entry) => [entry.name, entry]),
  );
  assert.equal(plainEnvironment.OPENCLAW_CONFIG_PATH.value, "/etc/openclaw/openclaw.json");
  assert.deepEqual(
    plainPod.containers[0].volumeMounts.find(({ name }) => name === "openclaw-configuration"),
    { name: "openclaw-configuration", mountPath: "/etc/openclaw", readOnly: true },
  );
  assert.equal(plainPod.initContainers[0].args[0].includes("copyFileSync"), false);

  const runtimeDriver = createKubernetesComputeDriver(
    routedOptions({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
      },
    }),
  );
  const runtimeRevision = routedRevision(runtimeDriver);
  const runtimeName = `gateway-${digest(runtimeRevision.agentId)}`;
  const runtimeGateway = runtimeDriver.deployment(
    runtimeName,
    { namespaceId: tenant.id, agentId: runtimeRevision.agentId },
    { name: namespace, plane: "execution" },
    "openclaw-enterprise/gateway-fixture:local",
    runtimeName,
    "gateway",
    {},
    "info",
    runtimeDriver.gatewayConfiguration(runtimeRevision, undefined, {
      name: kubernetesNamespaceName(tenant.id),
      plane: "execution",
    }),
  );
  const runtimePod = runtimeGateway.spec.template.spec;
  const runtimeEnvironment = Object.fromEntries(
    runtimePod.containers[0].env.map((entry) => [entry.name, entry]),
  );
  assert.equal(runtimeEnvironment.OPENCLAW_CONFIG_PATH.value, "/etc/openclaw/openclaw.json");
  assert.deepEqual(
    runtimePod.containers[0].volumeMounts.find(({ name }) => name === "openclaw-configuration"),
    { name: "openclaw-configuration", mountPath: "/etc/openclaw", readOnly: true },
  );
  assert.equal(
    runtimePod.initContainers[0].volumeMounts.some(({ name }) => name === "openclaw-configuration"),
    false,
  );
  assert.equal(runtimePod.initContainers[0].args[0].includes("copyFileSync"), false);

  const nativeAdminRevision = routedRevision(runtimeDriver, {
    id: "revision-routed-native-admin",
    configuration: {
      ...runtimeRevision.configuration,
      gateway: {
        ...runtimeRevision.configuration.gateway,
        controlUi: {
          enabled: true,
          allowedOrigins: ["https://agent-routed.example.internal"],
        },
        auth: {
          ...runtimeRevision.configuration.gateway.auth,
          trustedProxy: {
            ...runtimeRevision.configuration.gateway.auth.trustedProxy,
            deviceAutoApprove: { enabled: true, scopes: ["operator.admin"] },
          },
        },
      },
    },
  });
  const nativeAdminGateway = runtimeDriver.deployment(
    runtimeName,
    { namespaceId: tenant.id, agentId: nativeAdminRevision.agentId },
    { name: namespace, plane: "execution" },
    "openclaw-enterprise/gateway-fixture:local",
    runtimeName,
    "gateway",
    {},
    "info",
    runtimeDriver.gatewayConfiguration(nativeAdminRevision, undefined, {
      name: kubernetesNamespaceName(tenant.id),
      plane: "execution",
    }),
  );
  const nativeAdminPod = nativeAdminGateway.spec.template.spec;
  const nativeAdminEnvironment = Object.fromEntries(
    nativeAdminPod.containers[0].env.map((entry) => [entry.name, entry]),
  );
  assert.equal(
    nativeAdminEnvironment.OPENCLAW_CONFIG_PATH.value,
    "/home/node/.openclaw/openclaw.json",
  );
  assert.deepEqual(
    nativeAdminPod.containers[0].volumeMounts.find(({ name }) => name === "openclaw-configuration"),
    { name: "openclaw-configuration", mountPath: "/etc/openclaw-managed", readOnly: true },
  );
  assert.deepEqual(
    nativeAdminPod.initContainers[0].volumeMounts.find(
      ({ name }) => name === "openclaw-configuration",
    ),
    { name: "openclaw-configuration", mountPath: "/etc/openclaw-managed", readOnly: true },
  );
  assert.match(
    nativeAdminPod.initContainers[0].args[0],
    /copyFileSync\("\/etc\/openclaw-managed\/openclaw\.json", "\/runtime-state\/home\/\.openclaw\/openclaw\.json"\)/,
  );

  const privateRuntimeDriver = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
      },
    }),
  );
  const privateNativeAdminRevision = {
    ...nativeAdminRevision,
    compute: { id: privateRuntimeDriver.id, implementation: privateRuntimeDriver.implementation },
  };
  const privateNativeAdminGateway = privateRuntimeDriver.deployment(
    runtimeName,
    { namespaceId: tenant.id, agentId: privateNativeAdminRevision.agentId },
    { name: namespace, plane: "execution" },
    "openclaw-enterprise/gateway-fixture:local",
    runtimeName,
    "gateway",
    {},
    "info",
    privateRuntimeDriver.gatewayConfiguration(privateNativeAdminRevision, undefined, {
      name: kubernetesNamespaceName(tenant.id),
      plane: "execution",
    }),
  );
  const privateNativeAdminPod = privateNativeAdminGateway.spec.template.spec;
  const privateNativeAdminEnvironment = Object.fromEntries(
    privateNativeAdminPod.containers[0].env.map((entry) => [entry.name, entry]),
  );
  assert.equal(
    privateNativeAdminEnvironment.OPENCLAW_CONFIG_PATH.value,
    "/etc/openclaw/openclaw.json",
  );
  assert.deepEqual(
    privateNativeAdminPod.containers[0].volumeMounts.find(
      ({ name }) => name === "openclaw-configuration",
    ),
    { name: "openclaw-configuration", mountPath: "/etc/openclaw", readOnly: true },
  );
  assert.equal(
    privateNativeAdminPod.initContainers[0].volumeMounts.some(
      ({ name }) => name === "openclaw-configuration",
    ),
    false,
  );
  assert.equal(privateNativeAdminPod.initContainers[0].args[0].includes("copyFileSync"), false);

  for (const [configuration, expected] of [
    [{ gateway: null }, /gateway configuration/i],
    [{ gateway: [] }, /gateway configuration/i],
    [{ gateway: { auth: null } }, /gateway auth/i],
    [{ gateway: { auth: [] } }, /gateway auth/i],
    [
      {
        gateway: {
          auth: {
            trustedProxy: null,
          },
        },
      },
      /trustedProxy/i,
    ],
    [
      {
        gateway: {
          auth: {
            identityScopes: null,
          },
        },
      },
      /identityScopes/i,
    ],
    [
      {
        gateway: {
          auth: { mode: "oauth" },
          allowRealIpFallback: true,
          trustedProxies: ["10.42.0.0/16"],
        },
      },
      /trusted-proxy/i,
    ],
    [
      {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            unsupportedField: true,
            trustedProxy: {
              userHeader: "x-occ-identity",
              allowUsers: ["occ-workspace-files"],
            },
            identityScopes: { "occ-workspace-files": ["operator.admin"] },
          },
          allowRealIpFallback: true,
          trustedProxies: ["10.42.0.0/16"],
        },
      },
      /unsupported field unsupportedField/i,
    ],
    [
      {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy: {
              userHeader: "x-openclaw-operator",
              allowUsers: ["occ-workspace-files"],
            },
            identityScopes: { "occ-workspace-files": ["operator.admin"] },
          },
          allowRealIpFallback: true,
          trustedProxies: ["10.42.0.0/16"],
        },
      },
      /userHeader/i,
    ],
    [
      {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy: {
              userHeader: "x-occ-identity",
              allowUsers: ["another-user"],
            },
            identityScopes: { "occ-workspace-files": ["operator.admin"] },
          },
          allowRealIpFallback: true,
          trustedProxies: ["10.42.0.0/16"],
        },
      },
      /allowUsers/i,
    ],
    [
      {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy: {
              userHeader: "x-occ-identity",
              allowUsers: ["occ-workspace-files"],
              allowLoopback: true,
            },
            identityScopes: { "occ-workspace-files": ["operator.admin"] },
          },
          allowRealIpFallback: true,
          trustedProxies: ["10.42.0.0/16"],
        },
      },
      /allowLoopback/i,
    ],
    [
      {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy: {
              userHeader: "x-occ-identity",
              allowUsers: ["occ-workspace-files"],
              allowLoopback: "false",
            },
            identityScopes: { "occ-workspace-files": ["operator.admin"] },
          },
          allowRealIpFallback: true,
          trustedProxies: ["10.42.0.0/16"],
        },
      },
      /allowLoopback/i,
    ],
    [
      {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy: {
              userHeader: "x-occ-identity",
              allowUsers: ["occ-workspace-files"],
            },
            identityScopes: { "occ-workspace-files": ["operator.read"] },
          },
          allowRealIpFallback: true,
          trustedProxies: ["10.42.0.0/16"],
        },
      },
      /identityScopes/i,
    ],
    [
      {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy: {
              userHeader: "x-occ-identity",
              allowUsers: ["occ-workspace-files"],
            },
            identityScopes: { "occ-workspace-files": ["operator.admin"] },
          },
          allowRealIpFallback: false,
          trustedProxies: ["10.42.0.0/16"],
        },
      },
      /allowRealIpFallback/i,
    ],
    [
      {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy: {
              userHeader: "x-occ-identity",
              allowUsers: ["occ-workspace-files"],
            },
            identityScopes: { "occ-workspace-files": ["operator.admin"] },
          },
          allowRealIpFallback: true,
          trustedProxies: [],
        },
      },
      /trustedProxies/i,
    ],
  ]) {
    // Routed native access must come from the driver-rendered immutable native configuration.
    await assert.rejects(
      driver.prepareRevision({
        ...revision,
        configuration: { ...revision.configuration, ...configuration },
      }),
      expected,
    );
  }

  for (const [configuration, expected] of [
    [{ gateway: { auth: { mode: "oauth" } } }, /trusted-proxy/i],
    [
      {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            unsupportedField: true,
          },
        },
      },
      /unsupported field unsupportedField/i,
    ],
    [
      {
        gateway: {
          auth: {
            identityScopes: { "occ-workspace-files": ["operator.read"] },
          },
        },
      },
      /identityScopes/i,
    ],
    [{ gateway: { trustedProxies: ["10.99.0.0/16"] } }, /gatewayTrustedProxyCidrs/i],
  ]) {
    for (const configure of [options, routedOptions]) {
      for (const operation of ["prepareRevision", "activateRevision"]) {
        const failClosed = createKubernetesComputeDriver(configure());
        const invalid = routedRevision(failClosed, {
          configuration: { ...revision.configuration, ...configuration },
        });
        let clusterTouched = false;
        failClosed.clients = async () => {
          clusterTouched = true;
          throw new Error("cluster touched");
        };
        await assert.rejects(failClosed[operation](invalid, authContext(invalid)), expected);
        assert.equal(clusterTouched, false);
      }
    }
  }

  const multiProxyDriver = createKubernetesComputeDriver(
    routedOptions({
      network: { gatewayTrustedProxyCidrs: ["10.42.0.0/16", "10.43.0.0/16"] },
    }),
  );
  const multiProxyRevision = routedRevision(multiProxyDriver, {
    configuration: {
      ...revision.configuration,
      gateway: {
        ...revision.configuration.gateway,
        trustedProxies: ["10.43.0.0/16", "10.42.0.0/16"],
      },
    },
  });
  assert.doesNotThrow(() =>
    multiProxyDriver.gatewayConfiguration(multiProxyRevision, undefined, {
      name: kubernetesNamespaceName(tenant.id),
      plane: "execution",
    }),
  );
});

test("agent provisioning validation reuses native trusted-proxy admission before cluster access", () => {
  const driver = createKubernetesComputeDriver(routedOptions());
  const revision = routedRevision(driver);
  assert.deepEqual(driver.agentProvisioning.executionModes, ["dedicated"]);

  assert.doesNotThrow(() =>
    driver.validateAgentProvisioning({
      executionMode: "dedicated",
      configuration: revision.configuration,
    }),
  );
  assert.throws(
    () =>
      driver.validateAgentProvisioning({
        executionMode: "embedded",
        configuration: revision.configuration,
      }),
    /dedicated execution mode/i,
  );

  for (const [configuration, expected] of [
    [{ gateway: { auth: { mode: "oauth" } } }, /trusted-proxy/i],
    [
      {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            unsupportedField: true,
          },
        },
      },
      /unsupported field unsupportedField/i,
    ],
    [
      {
        gateway: {
          auth: {
            identityScopes: { "occ-workspace-files": ["operator.read"] },
          },
        },
      },
      /identityScopes/i,
    ],
    [{ gateway: { trustedProxies: ["10.99.0.0/16"] } }, /gatewayTrustedProxyCidrs/i],
  ]) {
    const failClosed = createKubernetesComputeDriver(routedOptions());
    let clusterTouched = false;
    failClosed.clients = async () => {
      clusterTouched = true;
      throw new Error("cluster touched");
    };
    assert.throws(
      () =>
        failClosed.validateAgentProvisioning({
          executionMode: "dedicated",
          configuration: { ...revision.configuration, ...configuration },
        }),
      expected,
    );
    assert.equal(clusterTouched, false);
  }

  const missingRouting = createKubernetesComputeDriver(
    options({
      runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
    }),
  );
  assert.throws(
    () =>
      missingRouting.validateAgentProvisioning({
        executionMode: "dedicated",
        configuration: revision.configuration,
      }),
    /gateway routing and node enrollment/i,
  );
});

test("gateway routing startup validation and namespace membership fail closed", async () => {
  for (const endpointPort of [0, -1, 65536, 443.5, "443"]) {
    assert.throws(
      () =>
        createKubernetesComputeDriver(
          routedOptions({
            gatewayRouting: { ...gatewayRouting, endpointPort },
          }),
        ),
      /Gateway routing endpoint port/,
    );
  }
  for (const envoyHttpsTargetPort of [0, -1, 65536, 443.5, "10443"]) {
    assert.throws(
      () =>
        createKubernetesComputeDriver(
          routedOptions({
            gatewayRouting: { ...gatewayRouting, envoyHttpsTargetPort },
          }),
        ),
      /Envoy HTTPS target port/,
    );
  }
  for (const gatewayRouting of [
    {
      hostname: "agents.example.internal:443",
      gatewayName: "oce-agent-gateways",
      gatewayNamespace: "openclaw-system",
      envoyNamespace: "envoy-gateway-system",
    },
    {
      hostname: "https://agents.example.internal",
      gatewayName: "oce-agent-gateways",
      gatewayNamespace: "openclaw-system",
      envoyNamespace: "envoy-gateway-system",
    },
    {
      hostname: " ",
      gatewayName: "oce-agent-gateways",
      gatewayNamespace: "openclaw-system",
      envoyNamespace: "envoy-gateway-system",
    },
    {
      hostname: 42,
      gatewayName: "oce-agent-gateways",
      gatewayNamespace: "openclaw-system",
      envoyNamespace: "envoy-gateway-system",
    },
    {
      hostname: "agents.example.internal",
      gatewayName: "OCE",
      gatewayNamespace: "openclaw-system",
      envoyNamespace: "envoy-gateway-system",
    },
    {
      hostname: "agents.example.internal",
      gatewayName: "oce-agent-gateways",
      gatewayNamespace: "openclaw/system",
      envoyNamespace: "envoy-gateway-system",
    },
    {
      hostname: "agents.example.internal",
      gatewayName: "oce-agent-gateways",
      gatewayNamespace: "openclaw-system",
      envoyNamespace: "envoy/system",
    },
  ]) {
    assert.throws(
      () => createKubernetesComputeDriver(routedOptions({ gatewayRouting })),
      /Gateway routing/i,
    );
  }

  assert.throws(
    () => createKubernetesComputeDriver(options({ gatewayRouting })),
    /do not configure network\.gatewayClients/i,
  );

  const driver = createKubernetesComputeDriver(routedOptions());
  const namespace = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: "customer-support",
      resourceVersion: "7",
      labels: {
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/audit": "restricted",
        "pod-security.kubernetes.io/warn": "restricted",
      },
      annotations: { "openclaw.dev/namespace-lifecycle": "external" },
    },
    status: { phase: "Active" },
  };
  const patches = [];
  driver.apiClients = Promise.resolve({
    core: {
      async patchNamespace(request) {
        patches.push(structuredClone(request));
        namespace.metadata.labels = {
          ...namespace.metadata.labels,
          ...request.body.metadata.labels,
        };
        namespace.metadata.annotations = {
          ...namespace.metadata.annotations,
          ...request.body.metadata.annotations,
        };
      },
      async readNamespace() {
        return structuredClone(namespace);
      },
    },
  });

  await driver.claimExistingNamespace(namespace, { namespaceId: tenant.id });
  assert.equal(patches.length, 1);
  assert.equal(patches[0].fieldManager, "openclaw-enterprise-compute");
  assert.deepEqual(patches[0].body.metadata.labels, {
    "openclaw.dev/namespace": tenant.id,
    "openclaw-enterprise.io/gateway": digest(
      `${gatewayRouting.gatewayNamespace}/${gatewayRouting.gatewayName}`,
    ),
  });
  assert.deepEqual(patches[0].body.metadata.annotations, {
    "openclaw.dev/namespace-id": tenant.id,
  });

  await driver.claimExistingNamespace(namespace, { namespaceId: tenant.id });
  assert.equal(patches.length, 1);
});

test("Kubernetes drivers require explicit authentication, images, and production policy", () => {
  const baseNetwork = options().network;
  for (const [invalid, expected] of [
    [{ authentication: undefined }, /authentication|credential/i],
    [{ authentication: { mode: "kubeconfig", kubeconfigPath, context: "" } }, /context/i],
    [
      {
        authentication: {
          mode: "kubeconfig",
          kubeconfigPath: "relative/config",
          context: contextName,
        },
      },
      /absolute/i,
    ],
    [{ authentication: { mode: "ambient" } }, /authentication|mode|credential/i],
    [{ images: { gateway: "", agent: "agent:local", requireImmutableDigest: false } }, /gateway/i],
    [{ images: { gateway: "gateway:local", agent: "", requireImmutableDigest: false } }, /agent/i],
    [{ resources: undefined }, /resource/i],
    [{ network: undefined }, /network/i],
    [{ network: { ...baseNetwork, gatewayTrustedProxyCidrs: undefined } }, /trusted proxy CIDR/i],
    [{ network: { ...baseNetwork, gatewayTrustedProxyCidrs: [] } }, /trusted proxy CIDR/i],
    [{ network: { ...baseNetwork, gatewayTrustedProxyCidrs: ["10.42.0.1/"] } }, /CIDR/i],
    [{ network: { ...baseNetwork, gatewayTrustedProxyCidrs: ["10.42.0.1/00"] } }, /CIDR/i],
    [{ network: { ...baseNetwork, gatewayTrustedProxyCidrs: ["10.42.0.1/+0"] } }, /CIDR/i],
    [{ network: { ...baseNetwork, gatewayTrustedProxyCidrs: ["10.42.0.1/1e1"] } }, /CIDR/i],
    [
      { network: { ...baseNetwork, gatewayTrustedProxyCidrs: ["0.0.0.0/0"] } },
      /cannot trust every source/i,
    ],
    [
      { network: { ...baseNetwork, gatewayTrustedProxyCidrs: ["::/0"] } },
      /cannot trust every source/i,
    ],
    [
      { network: { ...baseNetwork, gatewayTrustedProxyCidrs: ["::ffff:0:0/96"] } },
      /cannot trust every source/i,
    ],
    [
      { network: { ...baseNetwork, gatewayTrustedProxyCidrs: ["::ffff:0.0.0.0/96"] } },
      /cannot trust every source/i,
    ],
    [{ servicePrincipalCredentials: undefined }, /credential|projection/i],
  ]) {
    assert.throws(() => createKubernetesComputeDriver(options(invalid)), expected);
  }

  for (const gatewayTrustedProxyCidrs of [
    ["::/96"],
    ["::ffff:0.0.0.0/120"],
    ["::1/128"],
    ["2001:db8::/32"],
  ]) {
    assert.doesNotThrow(() =>
      createKubernetesComputeDriver(
        options({ network: { ...baseNetwork, gatewayTrustedProxyCidrs } }),
      ),
    );
  }

  assert.doesNotThrow(() =>
    createKubernetesComputeDriver(options({ authentication: { mode: "inCluster" } })),
  );
});

test("the canonical Kubernetes runtime validates channel proxy configuration", () => {
  const runtime = {
    transportSecretPrefix: "transport",
    gatewayStorageClassName: "local-path",
  };
  assert.doesNotThrow(() => createKubernetesComputeDriver(options({ runtime })));

  for (const proxyUrl of ["http://10.42.0.15:3128", "https://[2001:db8::15]:8443"]) {
    const channels = { proxyUrl };
    assert.doesNotThrow(() =>
      createKubernetesComputeDriver(options({ runtime: { ...runtime, channels } })),
    );
  }
  const managedProxy = {
    hostname: "openclaw-enterprise-slack-proxy.openclaw-system.svc",
    namespace: "openclaw-system",
    podLabels: {
      "app.kubernetes.io/name": "openclaw-enterprise",
      "app.kubernetes.io/instance": "oce",
      "app.kubernetes.io/component": "slack-proxy",
    },
    port: 3128,
  };
  assert.doesNotThrow(() =>
    createKubernetesComputeDriver(
      options({
        runtime: {
          ...runtime,
          channels: {
            proxyUrl: "http://openclaw-enterprise-slack-proxy.openclaw-system.svc:3128",
            managedProxy,
          },
        },
      }),
    ),
  );
  for (const proxyUrl of [
    "http://proxy.internal:3128",
    "http://openclaw-enterprise-slack-proxy.openclaw-system.svc:3128",
    "https://192.0.2.15",
    "https://operator:secret@10.42.0.15:3128",
    "socks5://10.42.0.15:3128",
    "http://10.42.0.15:3128/unreviewed",
    "http://10.42.0.15:3128?token=secret",
  ]) {
    const channels = { proxyUrl };
    assert.throws(
      () => createKubernetesComputeDriver(options({ runtime: { ...runtime, channels } })),
      /HTTP\(S\) IP endpoint/i,
    );
  }
  for (const channels of [
    {
      proxyUrl: "http://openclaw-enterprise-slack-proxy.openclaw-system.svc:3128",
      managedProxy: { ...managedProxy, hostname: "other.openclaw-system.svc" },
    },
    {
      proxyUrl: "http://openclaw-enterprise-slack-proxy.openclaw-system.svc:3129",
      managedProxy,
    },
    {
      proxyUrl: "http://openclaw-enterprise-slack-proxy.openclaw-system.svc:3128",
      managedProxy: { ...managedProxy, podLabels: {} },
    },
  ]) {
    assert.throws(
      () => createKubernetesComputeDriver(options({ runtime: { ...runtime, channels } })),
      /Managed channel proxy/i,
    );
  }
});

test("the canonical Kubernetes runtime validates native OpenClaw session capacity", () => {
  const runtime = {
    transportSecretPrefix: "transport",
    gatewayStorageClassName: "local-path",
  };
  for (const nativeOpenClawSessionCapacity of [1, 8, 1024]) {
    assert.doesNotThrow(() =>
      createKubernetesComputeDriver(
        options({ runtime: { ...runtime, nativeOpenClawSessionCapacity } }),
      ),
    );
  }
  for (const nativeOpenClawSessionCapacity of [0, 1.5, 1025, Number.NaN]) {
    assert.throws(
      () =>
        createKubernetesComputeDriver(
          options({ runtime: { ...runtime, nativeOpenClawSessionCapacity } }),
        ),
      /session capacity must be an integer between 1 and 1024/i,
    );
  }
});

test("dedicated Codex localhost seccomp profile is validated and rendered only on the Agent container", () => {
  const runtime = {
    transportSecretPrefix: "transport",
    gatewayStorageClassName: "local-path",
  };
  const profile = "profiles/codex-0.156.0.json";
  const driver = createKubernetesComputeDriver(
    options({ runtime: { ...runtime, codexSeccompProfile: profile } }),
  );
  const defaultDriver = createKubernetesComputeDriver(options({ runtime }));
  const ownership = {
    namespaceId: tenant.id,
    agentId: "agent-seccomp",
    revisionId: "revision-seccomp",
  };
  const namespace = kubernetesNamespaceName(tenant.id);
  const workload = (computeDriver, role, embedded = false) =>
    computeDriver.deployment(
      role,
      ownership,
      { name: namespace, plane: "execution" },
      `${role}:local`,
      role,
      role,
      {},
      "info",
      computeDriver.gatewayConfiguration(
        routedRevision(computeDriver, { agentId: ownership.agentId }),
        undefined,
        { name: namespace, plane: "execution" },
      ),
      embedded,
      undefined,
      preparedAuth(computeDriver, namespace, embedded),
    ).spec.template.spec;

  const agent = workload(driver, "agent");
  assert.deepEqual(agent.securityContext.seccompProfile, { type: "RuntimeDefault" });
  assert.deepEqual(agent.containers[0].securityContext.seccompProfile, {
    type: "Localhost",
    localhostProfile: profile,
  });

  for (const pod of [
    workload(driver, "gateway"),
    workload(driver, "gateway", true),
    workload(defaultDriver, "agent"),
  ]) {
    assert.deepEqual(pod.securityContext.seccompProfile, { type: "RuntimeDefault" });
    assert.equal(pod.containers[0].securityContext.seccompProfile, undefined);
  }

  for (const codexSeccompProfile of [
    "",
    " ",
    "/profiles/codex.json",
    "../codex.json",
    "profiles/../codex.json",
    "profiles//codex.json",
    "unconfined",
    "profiles/unconfined",
    { type: "Unconfined" },
  ]) {
    assert.throws(
      () =>
        createKubernetesComputeDriver(options({ runtime: { ...runtime, codexSeccompProfile } })),
      /Codex seccomp localhost profile/i,
    );
  }

  assert.throws(
    () =>
      createKubernetesComputeDriver(
        options({
          runtime: {
            ...runtime,
            securityContext: { seccompProfile: { type: "Unconfined" } },
          },
        }),
      ),
    /unsupported option securityContext/i,
  );
});

test("account-owned Kubernetes Secrets reject invalid or foreign credentials before cluster access", async () => {
  const driver = createKubernetesComputeDriver(options());
  const serviceAccountId = "sa_00000000-0000-4000-8000-000000000001";
  const secretName = `service-account-${createHash("sha256")
    .update(serviceAccountId)
    .digest("hex")
    .slice(0, 32)}`;

  for (const invalid of [
    { namespaceId: "", serviceAccountId, accessToken: "token", workspaceId: "ws_1" },
    { namespaceId: tenant.id, serviceAccountId: "", accessToken: "token", workspaceId: "ws_1" },
    { namespaceId: tenant.id, serviceAccountId, accessToken: "", workspaceId: "ws_1" },
    { namespaceId: tenant.id, serviceAccountId, accessToken: "token", workspaceId: "" },
  ]) {
    // Incomplete account credentials cannot trigger Kubernetes requests or Secret mutations.
    await assert.rejects(driver.storeServiceAccountCredential(invalid), /must be explicitly/i);
  }

  for (const secretRef of [
    { name: "another-account-secret", key: "token" },
    { name: secretName, key: "another-key" },
  ]) {
    // Rollback and deletion are restricted to the deterministic Secret owned by this account.
    await assert.rejects(
      driver.deleteServiceAccountCredential({
        namespaceId: tenant.id,
        serviceAccountId,
        secretRef,
      }),
      /another ServiceAccount/i,
    );
  }
});

test("dedicated Codex projects the account-owned token and workspace without exposing either to its gateway", () => {
  const driver = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
        channels: { proxyUrl: "http://10.42.0.15:3128" },
      },
    }),
  );
  const agentId = "agent-service-account";
  const serviceAccountId = "sa_00000000-0000-4000-8000-000000000001";
  const secretName = `service-account-${createHash("sha256")
    .update(serviceAccountId)
    .digest("hex")
    .slice(0, 32)}`;
  const account = {
    method: "chatgpt_service_account",
    serviceAccountId,
    backendBinding: {
      backendId: "provider-chatgpt",
      driverId: "chatgpt",
      workspaceId: "ws_1",
      credentialIssued: true,
    },
    credential: { kind: "access_token", secretRef: { name: secretName, key: "token" } },
  };
  const namespace = kubernetesNamespaceName(tenant.id);
  const ownership = { namespaceId: tenant.id, agentId, revisionId: "revision-render" };
  const workload = driver.deployment(
    "codex-agent",
    ownership,
    { name: namespace, plane: "execution" },
    "agent:local",
    "codex-agent",
    "agent",
    {},
    "info",
    undefined,
    false,
    undefined,
    preparedAuth(driver, namespace, false, account),
  );
  const agentEnvironment = Object.fromEntries(
    workload.spec.template.spec.containers[0].env.map((entry) => [entry.name, entry]),
  );

  // Both values come from the one immutable account-owned reference; no Agent copy is created.
  assert.deepEqual(agentEnvironment.CODEX_ACCESS_TOKEN.valueFrom.secretKeyRef, {
    name: secretName,
    key: "token",
  });
  assert.deepEqual(agentEnvironment.CODEX_CHATGPT_WORKSPACE_ID.valueFrom.secretKeyRef, {
    name: secretName,
    key: "workspace-id",
  });
  assert.equal(agentEnvironment.CODEX_LOGIN_MODE.value, "chatgpt_service_account");
  assert.equal(agentEnvironment.OPENAI_API_KEY, undefined);
  assert.equal(agentEnvironment.SLACK_APP_TOKEN, undefined);
  assert.equal(agentEnvironment.SLACK_BOT_TOKEN, undefined);
  assert.equal(agentEnvironment.MSTEAMS_APP_PASSWORD, undefined);

  const channels = driver.enabledChannels({
    configuration: { channels: { slack: {}, msteams: {} } },
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    harnessAuth: apiKeyAuth,
  });

  const gateway = driver.deployment(
    "codex-gateway",
    ownership,
    { name: namespace, plane: "execution" },
    "gateway:local",
    "codex-gateway",
    "gateway",
    {},
    "info",
    driver.gatewayConfiguration(routedRevision(driver, { agentId: ownership.agentId }), undefined, {
      name: namespace,
      plane: "execution",
    }),
    false,
    undefined,
    undefined,
    channels,
  );
  const gatewayEnvironment = new Set(
    gateway.spec.template.spec.containers[0].env.map(({ name }) => name),
  );
  assert.equal(gatewayEnvironment.has("CODEX_ACCESS_TOKEN"), false);
  assert.equal(gatewayEnvironment.has("CODEX_CHATGPT_WORKSPACE_ID"), false);
  assert.equal(gatewayEnvironment.has("OPENAI_API_KEY"), false);
  assert.equal(gatewayEnvironment.has("SLACK_APP_TOKEN"), false);
  assert.equal(gatewayEnvironment.has("SLACK_BOT_TOKEN"), false);
  assert.equal(gatewayEnvironment.has("MSTEAMS_APP_PASSWORD"), false);
});

test("direct service account token is confined to the model container and exact admitted Secret", () => {
  const driver = createKubernetesComputeDriver(options());
  const namespace = kubernetesNamespaceName(tenant.id);
  const revision = {
    namespaceId: tenant.id,
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    harnessAuth: { ...apiKeyAuth, method: "codex_pat" },
    configuration: { agents: { defaults: { model: "codex/discovered-model" } } },
  };
  driver.validateHarnessAuth(revision.harness, revision.harnessAuth, revision.configuration);
  const context = authContext(revision, namespace);
  const prepared = driver.harnessAuthForRevision(revision, context, {
    name: namespace,
    plane: "execution",
  });
  const ownership = { namespaceId: tenant.id, agentId: "direct-pat-agent" };
  for (const role of ["agent", "gateway"]) {
    const workload = driver.deployment(
      "direct-pat",
      ownership,
      { name: namespace, plane: "execution" },
      "runtime:local",
      "direct-pat",
      role,
      {},
      "info",
      undefined,
      false,
      undefined,
      role === "agent" ? prepared : undefined,
    );
    const env = Object.fromEntries(
      workload.spec.template.spec.containers[0].env.map((entry) => [entry.name, entry]),
    );
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.CODEX_CHATGPT_WORKSPACE_ID, undefined);
    if (role === "agent") {
      assert.equal(env.CODEX_LOGIN_MODE.value, "codex_pat");
      assert.deepEqual(env.CODEX_ACCESS_TOKEN.valueFrom.secretKeyRef, {
        name: "occ-model-key",
        key: "value",
      });
    } else {
      assert.equal(env.CODEX_ACCESS_TOKEN, undefined);
    }
  }
  for (const harnessAuth of [
    { ...context.harnessAuth, method: "api_key" },
    { ...context.harnessAuth, secretDriverId: "different-driver" },
    { ...context.harnessAuth, backendRef: { ...context.harnessAuth.backendRef, uid: "" } },
  ]) {
    assert.throws(
      () =>
        driver.harnessAuthForRevision(
          revision,
          { harnessAuth },
          { name: namespace, plane: "execution" },
        ),
      /authentication.*(?:invalid|admitted source)/i,
    );
  }
  assert.throws(
    () =>
      driver.validateHarnessAuth(
        { id: "openclaw", version: "1.0.0", mode: "embedded" },
        revision.harnessAuth,
        revision.configuration,
      ),
    /incompatible.*topology/i,
  );
  assert.throws(
    () =>
      driver.validateHarnessAuth(revision.harness, revision.harnessAuth, {
        agents: { defaults: { model: "anthropic/claude" } },
      }),
    /compatible model provider/i,
  );
});

test("credential withdrawal revokes through the revision's exact Sandbox", async () => {
  const withdrawals = [];
  const sandboxDriver = {
    id: "sandbox-openshell",
    capability: "sandbox",
    facets: ["networking"],
    harnessResource({ namespace, revision }) {
      return {
        namespaceName: namespace.name,
        resourceName: `os-${revision.id}`,
        agentId: revision.agentId,
        revisionId: revision.id,
      };
    },
    async cleanup() {},
  };
  let reportedSource;
  const credentialGatewayDriver = {
    id: "credential-gateway",
    capability: "credential_gateway",
    async withdraw(context) {
      withdrawals.push(context);
      return { sourceId: reportedSource ?? context.sourceId, state: "revoked" };
    },
  };
  const driver = new KubernetesComputeDriver(options(), { sandboxDriver, credentialGatewayDriver });
  const namespace = kubernetesNamespaceName(tenant.id);
  const namespaceResource = {
    ...driver.manifest("v1", "Namespace", namespace, { namespaceId: tenant.id }),
    status: { phase: "Active" },
  };
  let namespaceExists = true;
  driver.apiClients = Promise.resolve({
    core: {
      async listNamespace() {
        return { items: namespaceExists ? [structuredClone(namespaceResource)] : [] };
      },
      async readNamespace() {
        if (!namespaceExists) {
          throw Object.assign(new Error("Not found"), { statusCode: 404 });
        }
        return structuredClone(namespaceResource);
      },
    },
  });
  const revision = {
    id: "rev-withdraw",
    namespaceId: tenant.id,
    agentId: "agent-withdraw",
    compute: { id: driver.id, implementation: driver.implementation },
    sandboxDriverId: sandboxDriver.id,
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    createdAt: "2026-09-28T00:00:00.000Z",
  };
  const source = {
    id: "cs_00000000-0000-4000-8000-000000000002",
    namespaceId: tenant.id,
    type: "openai",
    driverId: credentialGatewayDriver.id,
  };
  const signal = AbortSignal.timeout(5_000);

  // Compute hands the gateway the Sandbox provisioning created, in the Namespace's placement.
  assert.deepEqual(await driver.withdrawCredentialSource(revision, source, signal), {
    sourceId: source.id,
    state: "revoked",
  });
  assert.equal(withdrawals[0].namespace.name, namespace);
  assert.deepEqual(withdrawals[0].sandbox, {
    namespaceName: namespace,
    resourceName: "os-rev-withdraw",
    agentId: revision.agentId,
    revisionId: revision.id,
  });
  assert.equal(withdrawals[0].sourceId, source.id);
  assert.equal(withdrawals[0].revision, revision);

  // A gateway answer about another source is not evidence for this withdrawal.
  reportedSource = "cs_00000000-0000-4000-8000-000000000003";
  await assert.rejects(
    driver.withdrawCredentialSource(revision, source, signal),
    /withdrew another credential source/,
  );

  // Without the Namespace there is no Sandbox left to revoke, and the gateway is not called.
  namespaceExists = false;
  withdrawals.length = 0;
  assert.deepEqual(await driver.withdrawCredentialSource(revision, source, signal), {
    sourceId: source.id,
    state: "absent",
  });
  assert.equal(withdrawals.length, 0);
  await assert.rejects(
    driver.withdrawCredentialSource(
      { ...revision, compute: { id: "other-compute", implementation: driver.implementation } },
      source,
      signal,
    ),
    /another Compute Driver/,
  );
});

test("OAuth Harness authentication requires Compute-owned dedicated Codex", () => {
  const oauth = { ...apiKeyAuth, method: "oauth" };
  const codex = { id: "codex", version: "1.0.0", mode: "dedicated" };
  const configuration = { agents: { defaults: { model: "codex/gpt-5" } } };
  const driver = new KubernetesComputeDriver(options());
  assert.equal(typeof driver.startHarnessDeviceAuthorization, "function");
  assert.equal(typeof driver.pollHarnessDeviceAuthorization, "function");
  driver.validateHarnessAuth(codex, oauth, configuration);
  // Unsupported topologies fail at admission, before a deployment stops predecessors.
  const sandboxDriver = {
    id: "sandbox-openshell",
    capability: "sandbox",
    facets: ["networking", "filesystem", "process"],
    provisionHarness() {},
  };
  const sandboxed = new KubernetesComputeDriver(options(), { sandboxDriver });
  for (const harness of [codex, { id: "openclaw", version: "1.0.0", mode: "dedicated" }]) {
    assert.throws(
      () =>
        sandboxed.validateHarnessAuth(
          harness,
          oauth,
          harness.id === "codex"
            ? configuration
            : createHarnessConfiguration("openclaw", "gpt-4o-mini"),
        ),
      /OAuth requires the Compute-owned dedicated Codex Harness/,
    );
  }
});

test("dedicated Codex admission rejects settings its Gateway entrypoint cannot rewrite", () => {
  // The Gateway entrypoint refuses to start on these shapes; admitting them let
  // a deployment replace a working Gateway with one that crash-looped (D201).
  const oauth = { ...apiKeyAuth, method: "oauth" };
  const codex = { id: "codex", version: "1.0.0", mode: "dedicated" };
  const base = { agents: { defaults: { model: "codex/gpt-5" } } };
  const withCodexConfig = (config) => ({ ...base, plugins: { entries: { codex: { config } } } });
  const driver = new KubernetesComputeDriver(options());
  for (const accepted of [
    base,
    withCodexConfig({ codexDynamicToolsExclude: ["tts"] }),
    withCodexConfig(null),
    { ...withCodexConfig({}), cron: { enabled: true, triggers: { enabled: true } } },
    { ...withCodexConfig({}), cron: null },
    // Without the plugin entry the entrypoint leaves cron alone.
    { ...base, cron: "off" },
    {
      ...base,
      models: {
        providers: {
          Codex: { baseUrl: "https://model.example.test/v1", models: [{ id: "gpt-5" }] },
          openai: {},
          // Rows of other providers are not rewritten.
          anthropic: "unchanged",
        },
      },
    },
  ]) {
    driver.validateHarnessAuth(codex, oauth, accepted);
  }
  for (const [rejected, message] of [
    [
      withCodexConfig({ codexDynamicToolsExclude: "tts" }),
      "plugins.entries.codex.config.codexDynamicToolsExclude must be a list",
    ],
    [withCodexConfig("on"), "plugins.entries.codex.config must be an object"],
    [{ ...withCodexConfig({}), cron: "off" }, "cron must be an object"],
    [{ ...withCodexConfig({}), cron: { triggers: true } }, "cron.triggers must be an object"],
    [{ ...base, models: "none" }, "models must be an object"],
    [{ ...base, models: { providers: [] } }, "models.providers must be an object"],
    [
      { ...base, models: { providers: { codex: "stub" } } },
      "models.providers.codex must be an object",
    ],
    [
      { ...base, models: { providers: { " OpenAI ": null } } },
      "models.providers. OpenAI  must be an object",
    ],
    [
      { ...base, models: { providers: { codex: { models: {} } } } },
      "models.providers.codex.models must be a list of objects",
    ],
    [
      { ...base, models: { providers: { openai: { models: ["gpt-5"] } } } },
      "models.providers.openai.models must be a list of objects",
    ],
  ]) {
    // Admission returns this message to the Configuration owner (D321).
    assert.throws(
      () => driver.validateHarnessAuth(codex, oauth, rejected),
      (error) =>
        error instanceof ConfigurationHarnessError &&
        error.message ===
          `Configuration setting ${message}: a dedicated Codex Gateway cannot apply it otherwise.`,
    );
  }
});

test("credential-source authentication renders no model Secret and requires the paired gateway", () => {
  const sandboxDriver = {
    id: "sandbox-openshell",
    capability: "sandbox",
    facets: ["networking", "filesystem", "process"],
    provisionHarness() {},
  };
  const credentialGatewayDriver = { id: "credential-gateway", capability: "credential_gateway" };
  const driver = new KubernetesComputeDriver(options(), { sandboxDriver, credentialGatewayDriver });
  const namespace = { name: kubernetesNamespaceName(tenant.id), plane: "execution" };
  const snapshot = {
    method: "credential_source",
    sourceId: "cs_00000000-0000-4000-8000-000000000001",
    credentialGatewayId: credentialGatewayDriver.id,
    sourceType: "openai",
    loginMode: "api_key",
  };
  const sourceType = {
    type: "openai",
    config: [],
    secrets: [{ name: "api_key", required: true }],
    rotation: "none",
    harnessAuth: { modelProvider: "openai", loginMode: "api_key" },
  };
  const revision = {
    namespaceId: tenant.id,
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    harnessAuth: snapshot,
    configuration: { agents: { defaults: { model: "codex/gpt-5" } } },
  };
  driver.validateHarnessAuth(revision.harness, snapshot, revision.configuration, {}, sourceType);

  const source = {
    id: snapshot.sourceId,
    namespaceId: tenant.id,
    name: "openai",
    type: "openai",
    config: {},
    secrets: {},
    driverId: credentialGatewayDriver.id,
    state: "ready",
    createdAt: "2026-09-26T00:00:00.000Z",
  };
  const prepared = driver.harnessAuthForRevision(
    revision,
    { harnessAuth: { ...snapshot, source } },
    namespace,
  );
  // The Sandbox supplies the credential environment, so Compute projects no model Secret.
  assert.equal(prepared.credentialSource, source);
  assert.equal(prepared.loginMode, "api_key");
  assert.equal(
    prepared.environment.some((entry) => entry.valueFrom?.secretKeyRef !== undefined),
    false,
  );
  assert.equal(
    prepared.environment.some(({ name }) => name === "OPENAI_API_KEY"),
    false,
  );
  assert.deepEqual(
    prepared.environment.find(({ name }) => name === "CODEX_LOGIN_MODE"),
    { name: "CODEX_LOGIN_MODE", value: "api_key" },
  );

  const nativeRevision = {
    ...revision,
    harness: { id: "openclaw", version: "1.0.0", mode: "dedicated" },
    configuration: createHarnessConfiguration("openclaw", "gpt-4o-mini"),
  };
  driver.validateHarnessAuth(
    nativeRevision.harness,
    snapshot,
    nativeRevision.configuration,
    {},
    sourceType,
  );
  const nativePrepared = driver.harnessAuthForRevision(
    nativeRevision,
    { harnessAuth: { ...snapshot, source } },
    namespace,
  );
  assert.equal(nativePrepared.credentialSource, source);
  assert.equal(nativePrepared.loginMode, "api_key");
  assert.equal(
    nativePrepared.environment.some((entry) => entry.valueFrom?.secretKeyRef !== undefined),
    false,
  );
  assert.equal(
    nativePrepared.environment.some(({ name }) => name === "CODEX_LOGIN_MODE"),
    false,
  );
  assert.deepEqual(
    nativePrepared.environment.find(({ name }) => name === "OPENCLAW_HARNESS_PROVIDER"),
    { name: "OPENCLAW_HARNESS_PROVIDER", value: "openai" },
  );

  // A resolved source must match the frozen snapshot exactly and still be ready.
  for (const changed of [
    { ...source, state: "deleting" },
    { ...source, driverId: "other-gateway" },
    { ...source, type: "anthropic" },
  ]) {
    assert.throws(
      () =>
        driver.harnessAuthForRevision(
          revision,
          { harnessAuth: { ...snapshot, source: changed } },
          namespace,
        ),
      /credential source does not match the admitted source/i,
    );
  }

  const incompatible = /paired Sandbox and an OpenAI API key source/;
  assert.throws(
    () =>
      new KubernetesComputeDriver(options(), { sandboxDriver }).validateHarnessAuth(
        revision.harness,
        snapshot,
        revision.configuration,
        {},
        sourceType,
      ),
    incompatible,
  );
  assert.throws(
    () =>
      driver.validateHarnessAuth(
        revision.harness,
        snapshot,
        revision.configuration,
        {},
        {
          ...sourceType,
          harnessAuth: { modelProvider: "anthropic", loginMode: "api_key" },
        },
      ),
    incompatible,
  );
  assert.throws(
    () =>
      driver.validateHarnessAuth(
        { id: "openclaw", version: "1.0.0", mode: "embedded" },
        snapshot,
        revision.configuration,
        {},
        sourceType,
      ),
    /incompatible.*topology/i,
  );
});

test("dedicated OpenClaw renders an enrolled Harness without exposing model credentials to its gateway", async () => {
  const driverOptions = options({
    runtime: {
      transportSecretPrefix: "transport",
      gatewayStorageClassName: "local-path",
      nativeOpenClawSessionCapacity: 12,
    },
  });
  const sandboxDriver = {
    id: "sandbox-native-worker",
    implementation: "test/native-worker",
    capability: "sandbox",
    facets: ["networking", "filesystem", "process"],
    async provisionHarness() {},
    async cleanup() {},
  };
  const driver = new KubernetesComputeDriver(driverOptions, { sandboxDriver });
  const namespace = kubernetesNamespaceName(tenant.id);
  const namespaceAddress = { name: namespace, plane: "execution" };
  const agentId = "agent-native-worker";
  const configuration = admitLoggingConfiguration(
    createHarnessConfiguration("openclaw", "gpt-5"),
    "info",
  );
  const revision = {
    id: "revision-native-worker",
    namespaceId: tenant.id,
    agentId,
    revision: 1,
    configurationId: "cfg-native-worker",
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration,
    harness: { id: "openclaw", version: "1.0.0", mode: "dedicated" },
    harnessAuth: apiKeyAuth,
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId: "service-principal-native-worker",
    createdAt: tenant.createdAt,
  };
  assert.throws(
    () =>
      createKubernetesComputeDriver(driverOptions).validateHarnessAuth(
        revision.harness,
        revision.harnessAuth,
        revision.configuration,
      ),
    /requires a provisioning SandboxDriver with networking, filesystem, and process containment/,
  );
  assert.doesNotThrow(() =>
    driver.validateHarnessAuth(revision.harness, revision.harnessAuth, revision.configuration),
  );
  assert.throws(
    () =>
      driver.validateHarnessAuth(revision.harness, revision.harnessAuth, {
        ...revision.configuration,
        cloudWorkers: { requiredProfile: "user-selected" },
      }),
    /required profile.*owned by the selected Compute Driver/i,
  );
  const ownership = { namespaceId: tenant.id, agentId };
  const nativeInference = {
    models: [
      {
        provider: "openai",
        id: "gpt-5",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        contextWindow: 128000,
        maxTokens: 8192,
        reasoning: true,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        apiKeyEnv: "OPENAI_API_KEY",
      },
    ],
    workspaces: [
      {
        id: "main",
        path: "/home/node/.openclaw-node/node-host",
        scope: "subdirectories",
        models: ["openai/gpt-5"],
      },
    ],
  };
  const deviceId = "a".repeat(64);
  const gatewayDeployment = driver.deployment(
    "gateway-native-worker",
    ownership,
    namespaceAddress,
    "gateway:local",
    "gateway-native-worker",
    "gateway",
    {},
    "info",
    driver.gatewayConfiguration(revision, deviceId, namespaceAddress),
    false,
    undefined,
    undefined,
    [],
    [],
    undefined,
    [],
  );
  const workerDeployment = driver.deployment(
    "agent-native-worker",
    { ...ownership, revisionId: revision.id },
    namespaceAddress,
    "gateway:local",
    "agent-native-worker",
    "agent",
    {},
    "info",
    undefined,
    false,
    undefined,
    driver.harnessAuthForRevision(revision, authContext(revision, namespace), namespaceAddress),
    [],
    [],
    undefined,
    [],
    undefined,
    undefined,
    { configuration: JSON.stringify(nativeInference) },
  );
  driver.addNativeWorker(workerDeployment, "workspace-node-native-worker", undefined, revision);
  assertExecStringsWithinBudget([gatewayDeployment, workerDeployment]);
  const gateway = gatewayDeployment.spec.template.spec.containers[0];
  const worker = workerDeployment.spec.template.spec.containers[0];
  assert.ok(gateway);
  assert.ok(worker);
  const workerProgram = containerProgram(worker);
  assert.equal(
    gateway.env.some(({ name }) => name === "OPENAI_API_KEY"),
    false,
  );
  assert.equal(
    worker.env.some(({ name }) => name === "OPENAI_API_KEY"),
    true,
  );
  assert.equal(workerProgram.includes('"runtime-server"'), false);
  assert.equal(workerProgram.includes('"connect"'), true);
  assert.equal(workerProgram.includes('"--ephemeral"'), true);
  assert.equal(workerProgram.includes('"--target-file"'), true);
  assert.equal(workerProgram.includes('"--pair-if-needed"'), false);
  assert.equal(workerProgram.includes('"--session-host"'), false);
  assert.equal(
    workerProgram.includes("writeFileSync(connectTargetPath, setupCode, { mode: 0o600 })"),
    true,
  );
  assert.equal(
    worker.env.find(({ name }) => name === "TMPDIR")?.value,
    "/tmp/openclaw-native-worker",
  );
  assert.equal(
    worker.env.find(({ name }) => name === "NODE_COMPILE_CACHE")?.value,
    "/home/node/.openclaw-node/.cache/node-compile",
  );
  assert.equal(workerProgram.includes("chmodSync(temporary, 0o700)"), true);
  assert.equal(workerProgram.includes("initializeRuntimeAssets();"), true);
  assert.equal(workerProgram.includes("OPENCLAW_BUNDLED_SKILLS_DIR"), true);
  assert.equal(workerProgram.includes('publishImageTree("/app/custodian-skills"'), true);
  assert.equal(
    workerProgram.includes('agents: { defaults: { workspace: "/home/node/workspace" } }'),
    true,
  );
  assert.equal(
    worker.env.find(({ name }) => name === "OPENCLAW_NATIVE_WORKER_CAPACITY")?.value,
    "12",
    "the dedicated native node must receive its configured session capacity.",
  );
  assert.equal(
    gateway.env.find(({ name }) => name === "OPENCLAW_NATIVE_WORKER_PROFILE")?.value,
    "dedicated-native",
  );
  assert.equal(
    gateway.env.find(({ name }) => name === "OPENCLAW_WORKSPACE_NODE_ID")?.value,
    deviceId,
  );
  assert.equal(
    worker.env.find(({ name }) => name === "OPENCLAW_NODE_SETUP_CODE")?.valueFrom.secretKeyRef.name,
    "workspace-node-native-worker",
  );
  assert.equal(
    worker.volumeMounts.some(
      ({ name, mountPath }) =>
        name === "openclaw-node-state" && mountPath === "/home/node/.openclaw-node",
    ),
    true,
  );
  assert.deepEqual(
    JSON.parse(worker.env.find(({ name }) => name === "OPENCLAW_NATIVE_INFERENCE_CONFIG").value),
    nativeInference,
  );
  assert.equal(worker.readinessProbe.timeoutSeconds, 3);

  const nodeRequire = createRequire(import.meta.url);
  const files = new Map([["/etc/openclaw/openclaw.json", JSON.stringify(configuration)]]);
  let started = false;
  // Execute the generated Gateway startup program: every session must use the
  // enrolled worker without requiring a user-selected Cloud Worker destination.
  runInNewContext(GATEWAY_RUNTIME_ENTRYPOINT, {
    Buffer,
    JSON,
    URL,
    console,
    process: {
      env: {
        HOME: "/home/node",
        OPENCLAW_CONFIG_PATH: "/etc/openclaw/openclaw.json",
        OPENCLAW_GATEWAY_PORT: "8080",
        OPENCLAW_NATIVE_WORKER_PROFILE: "dedicated-native",
        OPENCLAW_STATE_DIR: "/home/node/.openclaw",
        OPENCLAW_WORKSPACE_NODE_ID: deviceId,
      },
      on() {},
      exit() {},
    },
    setTimeout() {
      return { unref() {} };
    },
    setInterval() {
      return { unref() {} };
    },
    require(specifier) {
      if (specifier === "node:fs") {
        return {
          cpSync() {},
          existsSync() {
            return false;
          },
          lstatSync() {
            throw new Error("Unexpected lstat");
          },
          mkdirSync() {},
          readFileSync(path) {
            const value = files.get(path);
            if (value === undefined) {
              throw new Error(`Unexpected read: ${path}`);
            }
            return value;
          },
          readdirSync() {
            return [];
          },
          rmSync() {},
          writeFileSync(path, value) {
            files.set(path, value);
          },
        };
      }
      if (specifier === "node:child_process") {
        return {
          spawn() {
            started = true;
            return { kill() {}, on() {} };
          },
          spawnSync() {
            throw new Error("Unexpected child process");
          },
        };
      }
      return nodeRequire(specifier);
    },
  });
  await Promise.resolve();
  assert.equal(started, true);
  const effectiveConfiguration = JSON.parse(files.get("/home/node/.openclaw/openclaw.json"));
  assert.equal(effectiveConfiguration.cloudWorkers.requiredProfile, "dedicated-native");
  assert.deepEqual(effectiveConfiguration.cloudWorkers.profiles["dedicated-native"], {
    provider: "device",
    settings: { device: deviceId, inference: "worker" },
  });
});

test("account-token authentication grants only the exact Codex revision outbound HTTPS", () => {
  const driver = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
      },
    }),
  );
  const revision = {
    id: "revision-account-token-1",
    namespaceId: tenant.id,
    agentId: "agent-account-token",
    servicePrincipalId: "service-principal-account-token",
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    harnessAuth: apiKeyAuth,
  };
  const namespace = kubernetesNamespaceName(tenant.id);
  const digest = (value, length = 32) =>
    createHash("sha256").update(value).digest("hex").slice(0, length);
  const policy = driver.agentAuthenticationNetworkPolicy(revision, {
    name: namespace,
    plane: "execution",
  });

  // Login needs public HTTPS before readiness; candidate transport must remain closed until activation.
  assert.equal(policy.metadata.name, `allow-agent-auth-${digest(revision.agentId, 12)}`);
  assert.equal(
    policy.metadata.annotations["openclaw.dev/service-principal-id"],
    revision.servicePrincipalId,
  );
  assert.deepEqual(policy.spec.podSelector.matchLabels, {
    "openclaw.dev/workload-role": "agent",
    "openclaw.dev/agent": revision.agentId,
    "openclaw.dev/revision": revision.id,
    "openclaw.dev/network-profile": "broad-egress-v1",
  });
  assert.deepEqual(policy.spec.policyTypes, ["Egress"]);
  assert.equal(policy.spec.ingress, undefined);
  assert.deepEqual(
    policy.spec.egress,
    driver.agentNetworkPolicies(revision, { name: namespace, plane: "execution" })[1].resource.spec
      .egress,
  );
  assert.deepEqual(policy.spec.egress[0].ports, [{ protocol: "TCP", port: 443 }]);
  assert.deepEqual(policy.spec.egress[0].to[0].ipBlock.except, [
    "10.0.0.0/8",
    "100.64.0.0/10",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "169.254.0.0/16",
  ]);
});

test("native channel providers require Secret bindings and project them only to the gateway", async () => {
  const driver = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
        channels: { proxyUrl: "http://10.42.0.15:3128" },
      },
    }),
  );
  const namespace = kubernetesNamespaceName(tenant.id);
  const agentId = "agent-a";
  const suffix = createHash("sha256").update(agentId).digest("hex").slice(0, 12);
  const revision = {
    id: "revision-a-1",
    namespaceId: tenant.id,
    agentId,
    revision: 1,
    configurationId: "cfg_00000000-0000-4000-8000-000000000001",
    configurationKind: "agent",
    configurationGeneration: 1,
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    harnessAuth: apiKeyAuth,
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId: "service-principal-agent-a",
    createdAt: tenant.createdAt,
  };
  const secretEnvironment = [
    {
      name: "SLACK_APP_TOKEN",
      namespaceId: tenant.id,
      agentId,
      secretId: "sec_00000000-0000-4000-8000-000000000001",
      backendRef: { namespaceName: namespace, name: "occ-slack-app", key: "value", uid: "app-uid" },
    },
    {
      name: "SLACK_BOT_TOKEN",
      namespaceId: tenant.id,
      agentId,
      secretId: "sec_00000000-0000-4000-8000-000000000002",
      backendRef: { namespaceName: namespace, name: "occ-slack-bot", key: "value", uid: "bot-uid" },
    },
    {
      name: "MSTEAMS_APP_PASSWORD",
      namespaceId: tenant.id,
      agentId,
      secretId: "sec_00000000-0000-4000-8000-000000000003",
      backendRef: {
        namespaceName: namespace,
        name: "occ-teams-password",
        key: "value",
        uid: "teams-uid",
      },
    },
  ];
  const secretBindings = Object.freeze({
    SLACK_APP_TOKEN: {
      source: { kind: "secret", namespaceId: tenant.id, id: secretEnvironment[0].secretId },
      delivery: { type: "env" },
    },
    SLACK_BOT_TOKEN: {
      source: { kind: "secret", namespaceId: tenant.id, id: secretEnvironment[1].secretId },
      delivery: { type: "env" },
    },
    MSTEAMS_APP_PASSWORD: {
      source: { kind: "secret", namespaceId: tenant.id, id: secretEnvironment[2].secretId },
      delivery: { type: "env" },
    },
  });

  for (const [channels, expectedSecrets] of [
    [{ slack: {} }, ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"]],
    [{ msteams: { enabled: true } }, ["MSTEAMS_APP_PASSWORD"]],
    [
      { slack: { enabled: true }, msteams: { enabled: true } },
      ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN", "MSTEAMS_APP_PASSWORD"],
    ],
    [
      {
        defaults: { groupPolicy: "allowlist" },
        modelByChannel: { "slack:channel-a": "codex/model" },
        slack: { enabled: false },
        msteams: { enabled: false },
        unsupported: { enabled: false },
      },
      [],
    ],
    [{ defaults: {}, modelByChannel: {} }, []],
  ]) {
    const configuredRevision = {
      ...revision,
      configuration: { agents: { defaults: { model: "codex/gpt-5" } }, channels },
      secretBindings,
      secretDriverId: "secret-kubernetes",
    };
    assert.doesNotThrow(() =>
      driver.validateHarnessAuth(
        configuredRevision.harness,
        configuredRevision.harnessAuth,
        configuredRevision.configuration,
        configuredRevision.secretBindings,
      ),
    );
    const enabled = driver.enabledChannels(configuredRevision);
    const expectedSecretEnvironment = expectedSecrets.map((name) =>
      secretEnvironment.find((item) => item.name === name),
    );
    const gateway = driver.deployment(
      `gateway-${suffix}`,
      { namespaceId: tenant.id, agentId },
      { name: namespace, plane: "execution" },
      "openclaw-enterprise/gateway-fixture:local",
      `gateway-${suffix}`,
      "gateway",
      {},
      "info",
      driver.gatewayConfiguration(
        routedRevision(driver, { agentId: { namespaceId: tenant.id, agentId }.agentId }),
        undefined,
        { name: namespace, plane: "execution" },
      ),
      false,
      undefined,
      undefined,
      enabled,
      expectedSecretEnvironment,
    );
    const environment = gateway.spec.template.spec.containers[0].env;

    // Native Teams IDs are ordinary configuration values; only its password is a Secret.
    for (const key of [
      "SLACK_APP_TOKEN",
      "SLACK_BOT_TOKEN",
      "MSTEAMS_APP_PASSWORD",
      "MSTEAMS_APP_ID",
      "MSTEAMS_TENANT_ID",
    ]) {
      const variable = environment.find(({ name }) => name === key);
      if (expectedSecrets.includes(key)) {
        const projection = secretEnvironment.find((item) => item.name === key);
        assert.deepEqual(variable.valueFrom.secretKeyRef, {
          name: projection.backendRef.name,
          key: projection.backendRef.key,
          optional: false,
        });
        assert.equal(environment.filter(({ name }) => name === key).length, 1);
      } else {
        assert.equal(variable, undefined);
      }
    }
    const proxy = environment.filter(({ name }) => name === "HTTPS_PROXY");
    assert.deepEqual(
      proxy,
      expectedSecrets.length === 0
        ? []
        : [{ name: "HTTPS_PROXY", value: "http://10.42.0.15:3128" }],
    );

    const policy = driver.channelNetworkPolicy(configuredRevision, enabled, {
      name: namespace,
      plane: "execution",
    });
    assert.deepEqual(
      policy.spec.egress,
      expectedSecrets.length === 0
        ? []
        : [
            {
              to: [{ ipBlock: { cidr: "10.42.0.15/32" } }],
              ports: [{ protocol: "TCP", port: 3128 }],
            },
          ],
    );

    // Dedicated Agents never receive gateway-owned channel credentials or their network proxy.
    const agent = driver.deployment(
      `agent-${suffix}`,
      {
        namespaceId: tenant.id,
        agentId,
        servicePrincipalId: revision.servicePrincipalId,
        revisionId: revision.id,
      },
      { name: namespace, plane: "execution" },
      "openclaw-enterprise/agent-fixture:local",
      `agent-${suffix}`,
      "agent",
      {},
      "info",
      undefined,
      undefined,
      undefined,
      preparedAuth(driver, namespace, false),
      [],
      [],
    );
    const agentEnvironment = agent.spec.template.spec.containers[0].env;
    for (const key of [...expectedSecrets, "HTTPS_PROXY"]) {
      assert.equal(
        agentEnvironment.some(({ name }) => name === key),
        false,
      );
    }
  }

  const managedProxy = {
    hostname: "openclaw-enterprise-slack-proxy.openclaw-system.svc",
    namespace: "openclaw-system",
    podLabels: {
      "app.kubernetes.io/name": "openclaw-enterprise",
      "app.kubernetes.io/instance": "oce",
      "app.kubernetes.io/component": "slack-proxy",
    },
    port: 3128,
  };
  const managedDriver = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
        channels: {
          proxyUrl: "http://openclaw-enterprise-slack-proxy.openclaw-system.svc:3128",
          managedProxy,
        },
      },
    }),
  );
  const managedRevision = {
    ...revision,
    configuration: { agents: { defaults: { model: "codex/gpt-5" } }, channels: { slack: {} } },
    secretBindings,
    secretDriverId: "secret-kubernetes",
  };
  const managedEnabled = managedDriver.enabledChannels(managedRevision);
  const managedGateway = managedDriver.deployment(
    `gateway-${suffix}`,
    { namespaceId: tenant.id, agentId },
    { name: namespace, plane: "execution" },
    "openclaw-enterprise/gateway-fixture:local",
    `gateway-${suffix}`,
    "gateway",
    {},
    "info",
    managedDriver.gatewayConfiguration(
      routedRevision(managedDriver, { agentId: { namespaceId: tenant.id, agentId }.agentId }),
      undefined,
      { name: namespace, plane: "execution" },
    ),
    false,
    undefined,
    undefined,
    managedEnabled,
    secretEnvironment.filter(({ name }) => name.startsWith("SLACK_")),
  );
  assert.deepEqual(
    managedGateway.spec.template.spec.containers[0].env.filter(
      ({ name }) => name === "HTTPS_PROXY",
    ),
    [
      {
        name: "HTTPS_PROXY",
        value: "http://openclaw-enterprise-slack-proxy.openclaw-system.svc:3128",
      },
    ],
  );
  const managedPolicy = managedDriver.channelNetworkPolicy(managedRevision, managedEnabled, {
    name: namespace,
    plane: "execution",
  });
  assert.deepEqual(managedPolicy.spec.egress, [
    {
      to: [
        {
          namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "openclaw-system" } },
          podSelector: { matchLabels: managedProxy.podLabels },
        },
      ],
      ports: [{ protocol: "TCP", port: 3128 }],
    },
  ]);

  // Removing channel runtime must revoke the exact existing grant without needing its old proxy.
  const activeRevision = {
    ...revision,
    configuration: {
      agents: { defaults: { model: "codex/gpt-5" } },
      channels: { slack: {} },
      logging: {
        level: "info",
        consoleLevel: "info",
        consoleStyle: "json",
      },
      diagnostics: { otel: { logs: false } },
    },
  };
  const previouslyGranted = driver.channelNetworkPolicy(
    activeRevision,
    driver.enabledChannels(activeRevision),
    { name: namespace, plane: "execution" },
  );
  for (const runtime of [
    {
      transportSecretPrefix: "transport",
      gatewayStorageClassName: "local-path",
    },
    undefined,
  ]) {
    const removed = createKubernetesComputeDriver(options({ runtime }));
    const disabledRevision = {
      ...revision,
      compute: { id: removed.id, implementation: removed.implementation },
      configuration: {
        agents: { defaults: { model: "codex/gpt-5" } },
        channels: { slack: { enabled: false } },
        logging: {
          level: "info",
          consoleLevel: "info",
          consoleStyle: "json",
        },
        diagnostics: { otel: { logs: false } },
      },
    };
    const revoked = removed.channelNetworkPolicy(
      disabledRevision,
      removed.enabledChannels(disabledRevision),
      { name: namespace, plane: "execution" },
    );
    assert.equal(revoked.metadata.name, previouslyGranted.metadata.name);
    assert.deepEqual(revoked.metadata.labels, previouslyGranted.metadata.labels);
    assert.deepEqual(revoked.metadata.annotations, previouslyGranted.metadata.annotations);
    assert.deepEqual(revoked.spec.podSelector, previouslyGranted.spec.podSelector);
    assert.deepEqual(revoked.spec.policyTypes, ["Egress"]);
    assert.deepEqual(revoked.spec.egress, []);
  }

  await assert.rejects(
    driver.prepareRevision({
      ...revision,
      configuration: {
        agents: { defaults: { model: "codex/gpt-5" } },
        channels: { discord: { enabled: true } },
        logging: {
          level: "info",
          consoleLevel: "info",
          consoleStyle: "json",
        },
        diagnostics: { otel: { logs: false } },
      },
    }),
    /Unsupported OpenClaw channel provider "discord"\./,
  );
  assert.throws(
    () =>
      driver.validateHarnessAuth(
        revision.harness,
        revision.harnessAuth,
        {
          agents: { defaults: { model: "codex/gpt-5" } },
          channels: {
            slack: {
              appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
              botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
            },
          },
        },
        { SLACK_APP_TOKEN: secretBindings.SLACK_APP_TOKEN },
      ),
    /Secret bindings/i,
  );

  const ipv6 = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
        channels: { proxyUrl: "https://[2001:db8::15]:8443" },
      },
    }),
  );
  const teamsRevision = {
    ...revision,
    compute: { id: ipv6.id, implementation: ipv6.implementation },
    configuration: {
      agents: { defaults: { model: "codex/gpt-5" } },
      channels: { msteams: {} },
      logging: {
        level: "info",
        consoleLevel: "info",
        consoleStyle: "json",
      },
      diagnostics: { otel: { logs: false } },
    },
  };
  const ipv6Policy = ipv6.channelNetworkPolicy(teamsRevision, ipv6.enabledChannels(teamsRevision), {
    name: namespace,
    plane: "execution",
  });
  assert.deepEqual(ipv6Policy.spec.egress, [
    {
      to: [{ ipBlock: { cidr: "2001:db8::15/128" } }],
      ports: [{ protocol: "TCP", port: 8443 }],
    },
  ]);
});

test("Kubernetes runtime diagnostics read exact private Pod status without native sends", async () => {
  const driver = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
      },
    }),
  );
  const resolveNamespace = driver.resolveNamespace.bind(driver);
  driver.resolveNamespace = async (...args) => {
    assert.ok(
      currentComputeAbortSignal(),
      "the overall diagnostic deadline covers namespace reads",
    );
    return resolveNamespace(...args);
  };
  const namespaceName = kubernetesNamespaceName(tenant.id);
  const gatewayNamespaceName = kubernetesGatewayNamespaceName(tenant.id);
  const agent = {
    id: "agent-runtime-diagnostics",
    namespaceId: tenant.id,
    name: "Runtime diagnostics Agent",
    configurationId: "cfg_runtime_diagnostics",
    providerId: null,
    executionMode: "dedicated",
    servicePrincipalId: "service-principal-runtime-diagnostics",
    createdAt: tenant.createdAt,
  };
  const revision = routedRevision(driver, {
    id: "revision-runtime-diagnostics",
    agentId: agent.id,
    configurationId: agent.configurationId,
    servicePrincipalId: agent.servicePrincipalId,
  });
  const pod = (role) => ({
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: `${role}-runtime-diagnostics-pod`,
      namespace: role === "gateway" ? gatewayNamespaceName : namespaceName,
      uid: `${role}-runtime-diagnostics-uid`,
      labels: {
        "openclaw.dev/agent": revision.agentId,
        "openclaw.dev/revision": revision.id,
        "openclaw.dev/workload-role": role,
      },
    },
    status: { containerStatuses: [{ name: role, containerID: `${role}-container-1` }] },
  });
  const pods = { agent: pod("agent"), gateway: pod("gateway") };
  const proxyReads = [];
  const podListReads = [];
  driver.apiClients = Promise.resolve({
    core: {
      async listNamespace({ labelSelector }) {
        assert.equal(labelSelector, `openclaw.dev/namespace=${tenant.id}`);
        return {
          apiVersion: "v1",
          kind: "NamespaceList",
          items: [
            {
              ...driver.manifest("v1", "Namespace", namespaceName, { namespaceId: tenant.id }),
              status: { phase: "Active" },
            },
          ],
        };
      },
      async readNamespace({ name }) {
        assert.equal(name, namespaceName);
        return {
          ...driver.manifest("v1", "Namespace", namespaceName, { namespaceId: tenant.id }),
          status: { phase: "Active" },
        };
      },
      async listNamespacedPod({ namespace, labelSelector }) {
        const role = labelSelector.includes("openclaw.dev/workload-role=agent")
          ? "agent"
          : "gateway";
        assert.equal(namespace, role === "gateway" ? gatewayNamespaceName : namespaceName);
        podListReads.push(role);
        return { apiVersion: "v1", kind: "PodList", items: [structuredClone(pods[role])] };
      },
      async connectGetNamespacedPodProxyWithPath({ name, namespace, path }) {
        proxyReads.push({ name, namespace, path });
        assert.equal(path, "openclaw/runtime/diagnostics");
        const role = name.startsWith("agent-") ? "agent" : "gateway";
        assert.equal(namespace, role === "gateway" ? gatewayNamespaceName : namespaceName);
        assert.equal(name, `${pods[role].metadata.name}:18791`);
        return {
          revisionId: revision.id,
          container: role,
          podUid: pods[role].metadata.uid,
          observedAt: "2026-09-19T12:00:00.000Z",
          checks: [
            {
              component: role,
              check: role === "agent" ? "auth" : "socket",
              state: role === "agent" ? "succeeded" : "unknown",
              checkedAt: role === "agent" ? "2026-09-19T12:00:00.000Z" : null,
            },
          ],
        };
      },
    },
  });

  const diagnostics = await driver.diagnoseAgentDeployment({
    namespace: tenant,
    agent,
    revision,
  });

  assert.equal(diagnostics.revisionId, revision.id);
  assert.equal(diagnostics.checks.length, 2);
  assert.deepEqual(
    diagnostics.checks.map(({ component, check, state }) => ({ component, check, state })),
    [
      { component: "agent", check: "auth", state: "succeeded" },
      { component: "gateway", check: "socket", state: "unknown" },
    ],
  );
  assert.equal(diagnostics.checks.find((check) => check.component === "gateway")?.checkedAt, null);
  assert.deepEqual(proxyReads, [
    {
      name: "agent-runtime-diagnostics-pod:18791",
      namespace: namespaceName,
      path: "openclaw/runtime/diagnostics",
    },
    {
      name: "gateway-runtime-diagnostics-pod:18791",
      namespace: gatewayNamespaceName,
      path: "openclaw/runtime/diagnostics",
    },
  ]);
  assert.equal(podListReads.filter((role) => role === "agent").length, 2);
  assert.equal(podListReads.filter((role) => role === "gateway").length, 2);
});

test("Kubernetes runtime diagnostics reject missing timestamps and raced Pod readbacks", async () => {
  const driver = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
      },
    }),
  );
  assert.throws(
    () =>
      driver.validRuntimeDiagnosticCheck({ component: "agent", check: "auth", state: "failed" }),
    /invalid diagnostic data/,
  );

  const namespaceName = kubernetesNamespaceName(tenant.id);
  const revision = routedRevision(driver, {
    id: "revision-runtime-readback-race",
    agentId: "agent-runtime-readback-race",
    configurationId: "cfg_runtime_readback_race",
    servicePrincipalId: "service-principal-runtime-readback-race",
  });
  const pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "agent-runtime-readback-race-pod",
      namespace: namespaceName,
      uid: "agent-runtime-readback-race-uid",
      labels: {
        "openclaw.dev/agent": revision.agentId,
        "openclaw.dev/revision": revision.id,
        "openclaw.dev/workload-role": "agent",
      },
    },
    status: { containerStatuses: [{ name: "agent", containerID: "agent-container-1" }] },
  };
  let podLists = 0;
  driver.apiClients = Promise.resolve({
    core: {
      async listNamespacedPod() {
        podLists += 1;
        return {
          apiVersion: "v1",
          kind: "PodList",
          items:
            podLists === 1
              ? [structuredClone(pod)]
              : [
                  structuredClone(pod),
                  {
                    ...structuredClone(pod),
                    metadata: {
                      ...pod.metadata,
                      name: "agent-runtime-readback-race-pod-2",
                      uid: "agent-runtime-readback-race-uid-2",
                    },
                  },
                ],
        };
      },
      async connectGetNamespacedPodProxyWithPath() {
        return {
          revisionId: revision.id,
          container: "agent",
          podUid: pod.metadata.uid,
          observedAt: "2026-09-19T12:00:00.000Z",
          checks: [
            {
              component: "agent",
              check: "auth",
              state: "unknown",
              checkedAt: "2026-09-19T12:00:00.000Z",
            },
          ],
        };
      },
    },
  });

  assert.equal(
    await driver.privateStatusReadback(
      revision,
      { name: namespaceName, plane: "execution" },
      "agent",
      "/openclaw/runtime/status",
    ),
    undefined,
  );
});

test("runtime diagnostics proxy ingress remains available without enabled plugins", () => {
  const cidr = "10.42.0.0/16";
  const tenantNamespace = kubernetesNamespaceName(tenant.id);
  for (const mode of ["embedded", "dedicated"]) {
    const driver = createKubernetesComputeDriver(
      options({
        network: { ...options().network, pluginStatusProxySourceCidrs: [cidr] },
        runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
      }),
    );
    const revision = routedRevision(driver, {
      harness: { id: mode === "embedded" ? "openclaw" : "codex", version: "1.0.0", mode },
      plugins: { plugins: {} },
    });
    const policies = driver
      .pluginStatusNetworkPolicies(revision, { name: tenantNamespace, plane: "execution" })
      .map(({ resource }) => resource);
    assert.deepEqual(
      policies.map((policy) => policy.metadata.namespace),
      mode === "embedded"
        ? [tenantNamespace]
        : [tenantNamespace, kubernetesGatewayNamespaceName(tenant.id)],
    );
    assert.ok(
      policies.every((policy) => policy.metadata.name.startsWith("allow-plugin-status-proxy-")),
    );
    assert.ok(
      policies.every((policy) =>
        policy.spec.ingress[0].from.some((peer) => peer.ipBlock?.cidr === cidr),
      ),
    );
  }
});

test("Kubernetes cached runtime failure evidence is native-only and readiness-passive", async () => {
  const revision = routedRevision(createKubernetesComputeDriver(options()), {
    id: "revision-runtime-failure-evidence",
    agentId: "agent-runtime-failure-evidence",
    configurationId: "cfg_runtime_failure_evidence",
    servicePrincipalId: "service-principal-runtime-failure-evidence",
  });
  const namespace = kubernetesNamespaceName(tenant.id);
  const nonNative = createKubernetesComputeDriver(options());
  let attemptedProxy = false;
  nonNative.apiClients = Promise.resolve({
    core: {
      async listNamespacedPod() {
        attemptedProxy = true;
        throw Object.assign(new Error("pods/proxy denied"), { statusCode: 403 });
      },
    },
  });

  assert.equal(
    await nonNative.safeRuntimeFailureObservation(revision, {
      name: namespace,
      plane: "execution",
    }),
    undefined,
  );
  assert.equal(attemptedProxy, false);

  const native = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
      },
    }),
  );
  const nativeRevision = {
    ...revision,
    compute: { id: native.id, implementation: native.implementation },
  };
  native.apiClients = Promise.resolve({
    core: {
      async listNamespacedPod() {
        throw Object.assign(new Error("pods/proxy denied"), { statusCode: 403 });
      },
    },
  });
  assert.equal(
    await native.safeRuntimeFailureObservation(nativeRevision, {
      name: namespace,
      plane: "execution",
    }),
    undefined,
  );

  const cancellation = new Error("runtime evidence cancelled");
  const owner = new AbortController();
  owner.abort(cancellation);
  await assert.rejects(
    withComputeAbortSignal(owner.signal, () =>
      native.safeRuntimeFailureObservation(nativeRevision, { name: namespace, plane: "execution" }),
    ),
    (error) => error === cancellation,
  );
});

async function exerciseEmbeddedReplacement({ providerId, model, environmentName, api, baseUrl }) {
  const modelRef = `${providerId}/${model}`;
  const driver = createKubernetesComputeDriver(
    routedOptions({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
      },
      servicePrincipalCredentials: {
        mode: "projectedServiceAccountToken",
        audience: "openclaw-controller",
        expirationSeconds: 900,
      },
    }),
  );
  const namespace = kubernetesNamespaceName(tenant.id);
  const agentId = "agent-embedded-recovery";
  const suffix = createHash("sha256").update(agentId).digest("hex").slice(0, 12);
  const base = {
    namespaceId: tenant.id,
    agentId,
    configurationId: "cfg_00000000-0000-4000-8000-000000000077",
    configurationKind: "agent",
    configurationGeneration: 1,
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    harnessAuth: apiKeyAuth,
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId: "service-principal-embedded-recovery",
    createdAt: tenant.createdAt,
  };
  const oldRevision = {
    ...base,
    id: "revision-embedded-recovery-bad",
    revision: 7,
    configuration: {
      agents: { defaults: { model: modelRef } },
      logging: {
        level: "info",
        consoleLevel: "info",
        consoleStyle: "json",
      },
      diagnostics: { otel: { logs: false } },
      gateway: {
        trustedProxies: ["10.42.0.0/16"],
        allowRealIpFallback: true,
        auth: {
          mode: "trusted-proxy",
          trustedProxy: {
            userHeader: "x-occ-identity",
            allowUsers: ["occ-workspace-files"],
          },
          identityScopes: { "occ-workspace-files": ["operator.admin"] },
        },
      },
    },
  };
  const replacement = {
    ...base,
    id: "revision-embedded-recovery-restored",
    revision: 8,
    configuration: {
      agents: {
        defaults: {
          model: modelRef,
          models: { [modelRef]: { alias: "Selected model", params: { temperature: 0.2 } } },
        },
      },
      models: {
        providers: {
          [providerId]: {
            baseUrl,
            api,
            apiKey: `\${${environmentName}}`,
            models: [{ id: model, name: "Selected model", contextWindow: 128000, maxTokens: 8192 }],
          },
        },
      },
      channels: { slack: { enabled: false, botToken: "${SLACK_BOT_TOKEN}" } },
      logging: {
        level: "info",
        consoleLevel: "info",
        consoleStyle: "json",
      },
      diagnostics: { otel: { logs: false } },
      gateway: {
        trustedProxies: ["10.42.0.0/16"],
        allowRealIpFallback: true,
        auth: {
          mode: "trusted-proxy",
          trustedProxy: {
            userHeader: "x-occ-identity",
            allowUsers: ["occ-workspace-files"],
          },
          identityScopes: { "occ-workspace-files": ["operator.admin"] },
        },
      },
    },
  };
  const tenantOwnership = { namespaceId: tenant.id };
  const gatewayOwnership = { namespaceId: tenant.id, agentId };
  const agentOwnership = {
    namespaceId: tenant.id,
    agentId,
    servicePrincipalId: replacement.servicePrincipalId,
  };
  const gatewayName = `gateway-${suffix}`;
  const agentName = `agent-${suffix}`;
  const objects = new Map();
  const key = (kind, name) => `${kind}:${name}`;
  const save = (object) =>
    objects.set(key(object.kind, object.metadata.name), structuredClone(object));
  const missing = (name) => Object.assign(new Error(`${name} not found`), { statusCode: 404 });

  save({
    ...driver.manifest("v1", "Namespace", namespace, tenantOwnership),
    status: { phase: "Active" },
  });
  for (const policy of driver.networkPolicies(tenantOwnership, {
    name: namespace,
    plane: "execution",
  })) {
    save(policy);
  }
  save({
    ...driver.manifest("v1", "ServiceAccount", agentName, agentOwnership, {
      name: namespace,
      plane: "execution",
    }),
    automountServiceAccountToken: false,
  });
  save({
    ...driver.deployment(
      gatewayName,
      gatewayOwnership,
      { name: namespace, plane: "execution" },
      "openclaw-enterprise/gateway-fixture:local",
      agentName,
      "gateway",
      {},
      driver.gatewayConfiguration(oldRevision).loggingLevel,
      driver.gatewayConfiguration(oldRevision),
      true,
      oldRevision.servicePrincipalId,
      driver.harnessAuthForRevision(oldRevision, authContext(oldRevision), {
        name: kubernetesGatewayNamespaceName(tenant.id),
        plane: "control",
      }),
    ),
    metadata: {
      ...driver.deployment(
        gatewayName,
        gatewayOwnership,
        { name: namespace, plane: "execution" },
        "openclaw-enterprise/gateway-fixture:local",
        agentName,
        "gateway",
        {},
        driver.gatewayConfiguration(oldRevision).loggingLevel,
        driver.gatewayConfiguration(oldRevision),
        true,
        oldRevision.servicePrincipalId,
        driver.harnessAuthForRevision(oldRevision, authContext(oldRevision), {
          name: kubernetesGatewayNamespaceName(tenant.id),
          plane: "control",
        }),
      ).metadata,
      generation: 2,
    },
    status: { observedGeneration: 2, readyReplicas: 0 },
  });
  const gatewayService = driver.service(
    gatewayName,
    gatewayOwnership,
    { name: namespace, plane: "execution" },
    {
      "app.kubernetes.io/name": gatewayName,
    },
  );
  gatewayService.metadata.uid = "gateway-service-uid";
  save(gatewayService);
  const activeRoute = driver.gatewayRoute(
    oldRevision,
    gatewayOwnership,
    { name: namespace, plane: "execution" },
    gatewayService,
  );
  activeRoute.metadata.uid = "route-uid";
  save(activeRoute);
  const predecessor = structuredClone(objects.get(key("Deployment", gatewayName)));

  const patches = [];
  const readyDeployments = new Set();
  let replacementDeploymentPatched = false;
  driver.apiClients = Promise.resolve({
    core: {
      async readNamespacedSecret({ name, namespace: target }) {
        if (name === "occ-model-key") {
          return {
            apiVersion: "v1",
            kind: "Secret",
            metadata: { name, namespace: target, uid: "model-secret-uid" },
            data: { value: Buffer.from("fixture-model").toString("base64") },
          };
        }
        const observed = objects.get(key("Secret", name));
        if (!observed || observed.metadata.namespace !== target) {
          throw missing(name);
        }
        return structuredClone(observed);
      },
      async createNamespacedSecret({ body }) {
        const value = {
          ...body,
          metadata: { ...body.metadata, uid: `${body.metadata.name}-uid`, resourceVersion: "1" },
        };
        save(value);
        return value;
      },
      async deleteNamespacedSecret({ name, body }) {
        assert.equal(objects.get(key("Secret", name))?.metadata.uid, body.preconditions.uid);
        objects.delete(key("Secret", name));
      },
      async deleteNamespacedConfigMap({ name, body }) {
        assert.equal(objects.get(key("ConfigMap", name))?.metadata.uid, body.preconditions.uid);
        objects.delete(key("ConfigMap", name));
      },

      async listNamespacedPod() {
        return { items: [] };
      },
      async listNamespace({ labelSelector }) {
        assert.equal(labelSelector, `openclaw.dev/namespace=${tenant.id}`);
        return { items: [] };
      },
      async readNamespace({ name }) {
        return structuredClone(objects.get(key("Namespace", name)) ?? missing(name));
      },
      async readNamespacedConfigMap({ name }) {
        const current = objects.get(key("ConfigMap", name));
        if (current === undefined) {
          throw missing(name);
        }
        return structuredClone(current);
      },
      async patchNamespacedConfigMap({ body }) {
        patches.push({ kind: body.kind, name: body.metadata.name });
        save(body);
      },
      async readNamespacedServiceAccount({ name }) {
        const current = objects.get(key("ServiceAccount", name));
        if (current === undefined) {
          throw missing(name);
        }
        return structuredClone(current);
      },
      async patchNamespacedServiceAccount({ body }) {
        patches.push({ kind: body.kind, name: body.metadata.name });
        save(body);
      },
      async readNamespacedService({ name }) {
        const current = objects.get(key("Service", name));
        if (current === undefined) {
          throw missing(name);
        }
        return structuredClone(current);
      },
      async patchNamespacedService({ body }) {
        patches.push({ kind: body.kind, name: body.metadata.name });
        save(body);
      },
      async readNamespacedPersistentVolumeClaim({ name }) {
        const current = objects.get(key("PersistentVolumeClaim", name));
        if (current === undefined) {
          throw missing(name);
        }
        return structuredClone(current);
      },
      async patchNamespacedPersistentVolumeClaim({ body }) {
        patches.push({ kind: body.kind, name: body.metadata.name });
        save(body);
      },
    },
    apps: {
      async readNamespacedDeployment({ name }) {
        const current = objects.get(key("Deployment", name));
        if (current === undefined) {
          throw missing(name);
        }
        const observed = structuredClone(current);
        // Readiness is an explicit transport observation, never inferred from a successful write.
        if (readyDeployments.has(name)) {
          observed.status = {
            observedGeneration: observed.metadata.generation,
            replicas: 1,
            updatedReplicas: 1,
            readyReplicas: 1,
          };
        }
        return observed;
      },
      async patchNamespacedDeployment({ body }) {
        patches.push({ kind: body.kind, name: body.metadata.name });
        if (body.metadata.name === gatewayName) {
          replacementDeploymentPatched = true;
        }
        const previous = objects.get(key("Deployment", body.metadata.name));
        save({
          ...previous,
          ...body,
          metadata: {
            ...body.metadata,
            generation: previous?.metadata.generation ?? 1,
            uid: previous?.metadata.uid ?? `${body.metadata.name}-uid`,
          },
        });
      },
    },
    discovery: {
      async listNamespacedEndpointSlice() {
        assert.equal(
          replacementDeploymentPatched,
          true,
          "replacement preparation must not wait on the unready previous gateway",
        );
        return {
          items: [
            {
              metadata: {
                labels: { "kubernetes.io/service-name": gatewayName },
                ownerReferences: [
                  { kind: "Service", name: gatewayName, uid: `${gatewayName}-uid` },
                ],
              },
              endpoints: [{ conditions: { ready: true } }],
            },
          ],
        };
      },
    },
    networking: {
      async readNamespacedNetworkPolicy({ name }) {
        const current = objects.get(key("NetworkPolicy", name));
        if (current === undefined) {
          throw missing(name);
        }
        return structuredClone(current);
      },
      async patchNamespacedNetworkPolicy({ body }) {
        patches.push({ kind: body.kind, name: body.metadata.name });
        save(body);
      },
    },
    objects: {
      async read({ metadata }) {
        const current = objects.get(key("HTTPRoute", metadata.name));
        if (current === undefined) {
          throw missing(metadata.name);
        }
        return structuredClone(current);
      },
      async patch(body) {
        patches.push({ kind: body.kind, name: body.metadata.name });
        save({ ...body, metadata: { ...body.metadata, uid: "route-uid" } });
      },
    },
  });

  const expected = { namespaceId: tenant.id, agentId, revisionId: replacement.id };
  assert.deepEqual(await driver.prepareRevision(replacement, authContext(replacement)), {
    ...expected,
    ready: true,
  });
  assert.deepEqual(objects.get(key("Deployment", gatewayName)), predecessor);
  assert.deepEqual(objects.get(key("HTTPRoute", gatewayName)), activeRoute);
  assert.equal(
    patches.some(({ kind }) => kind === "Deployment"),
    false,
  );

  // The served predecessor's own per-revision copies (its model key and rendered
  // configuration) exist until something retires them.
  const revisionArtifacts = (target) => [
    key("Secret", `harness-secrets-${suffix}-${digest(target.id)}`),
    key("ConfigMap", `${gatewayName}-rev-${digest(target.id)}`),
  ];
  const execution = { name: namespace, plane: "execution" };
  for (const [kind, name, ownership] of [
    [
      "Secret",
      `harness-secrets-${suffix}-${digest(oldRevision.id)}`,
      { ...agentOwnership, revisionId: oldRevision.id },
    ],
    ["ConfigMap", `${gatewayName}-rev-${digest(oldRevision.id)}`, gatewayOwnership],
  ]) {
    const seeded = driver.manifest("v1", kind, name, ownership, execution);
    seeded.metadata.uid = `${name}-uid`;
    save(seeded);
  }
  for (const artifact of revisionArtifacts(oldRevision)) {
    assert.ok(objects.has(artifact), `${artifact} is seeded for the served predecessor`);
  }

  // The guarded activation replaces the shared workload before model authentication
  // succeeds. Its failing startup may leave the Agent unavailable until redeploy.
  await assert.rejects(
    driver.activateRevision(replacement, authContext(replacement)),
    /gateway is not ready/i,
  );
  // The Recreate Gateway no longer runs the predecessor, and a failed activation
  // never reaches worker retirement, so its copies go with the re-render.
  for (const artifact of revisionArtifacts(oldRevision)) {
    assert.equal(objects.has(artifact), false, `${artifact} is removed once replaced`);
  }
  for (const artifact of revisionArtifacts(replacement)) {
    assert.ok(objects.has(artifact), `${artifact} is kept for the activating revision`);
  }
  const replaced = objects.get(key("Deployment", gatewayName));
  assert.equal(replaced.metadata.annotations["openclaw.dev/agent-revision-id"], replacement.id);
  assert.equal(replaced.spec.strategy.type, "Recreate");
  assert.deepEqual(
    [...objects.values()]
      .filter(({ kind }) => kind === "Deployment")
      .map(({ metadata }) => metadata.name),
    [gatewayName],
    "embedded authentication runs only inside the shared gateway",
  );
  assert.equal(
    objects.get(key("PersistentVolumeClaim", driver.gatewayPrivateStateClaimName(agentId)))
      ?.metadata.annotations["openclaw.dev/agent-id"],
    agentId,
  );
  const gatewayEnvironment = Object.fromEntries(
    replaced.spec.template.spec.containers[0].env.map((entry) => [entry.name, entry]),
  );
  assert.equal(gatewayEnvironment.OPENCLAW_HARNESS_MODEL.value, modelRef);
  assert.equal(gatewayEnvironment.OPENCLAW_HARNESS_PROVIDER.value, providerId);
  assert.equal(gatewayEnvironment.OPENCLAW_HARNESS_CREDENTIAL_ENV.value, environmentName);
  const otherEnvironment = providerId === "openai" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  assert.equal(gatewayEnvironment[otherEnvironment], undefined);
  assert.deepEqual(gatewayEnvironment[environmentName].valueFrom.secretKeyRef, {
    name: `harness-secrets-${digest(agentId)}-${digest(replacement.id)}`,
    key: environmentName,
  });
  const probeConfiguration = JSON.parse(gatewayEnvironment.OPENCLAW_HARNESS_PROBE_CONFIG.value);
  assert.equal(probeConfiguration.agents.defaults.model, modelRef);
  assert.deepEqual(probeConfiguration.agents.defaults.models, {
    [modelRef]: {
      alias: "Selected model",
      params: { temperature: 0.2 },
      agentRuntime: { id: "openclaw" },
    },
  });
  const { apiKey: _alias, ...expectedProvider } =
    replacement.configuration.models.providers[providerId];
  assert.deepEqual(probeConfiguration.models.providers[providerId], expectedProvider);
  for (const section of ["gateway", "channels", "plugins", "auth", "env", "secrets"]) {
    assert.equal(
      probeConfiguration[section],
      undefined,
      `${section} must not reach native validation`,
    );
  }
  const egressWrite = patches.findIndex(
    ({ kind, name }) => kind === "NetworkPolicy" && name === `allow-agent-runtime-${suffix}`,
  );
  const gatewayWrite = patches.findIndex(
    ({ kind, name }) => kind === "Deployment" && name === gatewayName,
  );
  assert.ok(egressWrite >= 0 && egressWrite < gatewayWrite);

  // Reconciliation observes readiness without replacing the Pod or retrying the
  // native model call; explicit deployment/restart owns recovery from bad auth.
  assert.deepEqual(await driver.prepareRevision(replacement, authContext(replacement)), {
    ...expected,
    ready: false,
  });
  await assert.rejects(
    driver.activateRevision(replacement, authContext(replacement)),
    /gateway is not ready/i,
  );
  assert.deepEqual(objects.get(key("Deployment", gatewayName)), replaced);

  readyDeployments.add(gatewayName);
  assert.equal((await driver.prepareRevision(replacement, authContext(replacement))).ready, true);
  await driver.activateRevision(replacement, authContext(replacement));
  assert.deepEqual(objects.get(key("Deployment", gatewayName)), replaced);
  await assert.rejects(
    driver.activateRevision(oldRevision, authContext(oldRevision)),
    /stale AgentRevision gateway activation/i,
  );
  assert.deepEqual(objects.get(key("Deployment", gatewayName)), replaced);

  const initial = {
    ...replacement,
    id: "initial-embedded-revision",
    agentId: "initial-embedded-agent",
    revision: 1,
  };
  assert.equal((await driver.prepareRevision(initial, authContext(initial))).ready, false);
  const initialGateway = objects.get(key("Deployment", `gateway-${digest(initial.agentId)}`));
  assert.ok(initialGateway);
  assert.deepEqual(
    initialGateway.spec.template.spec.containers[0].command,
    replaced.spec.template.spec.containers[0].command,
    "initial and replacement gateways execute the same native startup validation",
  );
}

test("embedded replacement cuts over an unready shared gateway and waits for actual startup readiness", async (t) => {
  for (const scenario of [
    {
      providerId: "openai",
      model: "gpt-5",
      environmentName: "OPENAI_API_KEY",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    },
    {
      providerId: "anthropic",
      model: "claude-sonnet-4-5",
      environmentName: "ANTHROPIC_API_KEY",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
    },
  ]) {
    await t.test(scenario.providerId, () => exerciseEmbeddedReplacement(scenario));
  }
});

test("Anthropic API-key admission binds every embedded model to the canonical credential", () => {
  const driver = createKubernetesComputeDriver(options());
  const embedded = { id: "openclaw", version: "1.0.0", mode: "embedded" };
  const model = "anthropic/claude-sonnet-4-5";
  const configuration = {
    agents: { defaults: { model: { primary: model, fallbacks: ["anthropic/claude-haiku-4-5"] } } },
    secrets: { providers: { model: { source: "env", allowlist: ["ANTHROPIC_API_KEY"] } } },
  };
  for (const apiKey of [
    undefined,
    "${ANTHROPIC_API_KEY}",
    { source: "env", provider: "model", id: "ANTHROPIC_API_KEY" },
  ]) {
    assert.doesNotThrow(() =>
      driver.validateHarnessAuth(embedded, apiKeyAuth, {
        ...configuration,
        models: { providers: { anthropic: { apiKey } } },
      }),
    );
  }
  for (const apiKey of [
    "plaintext-fixture",
    "${OPENAI_API_KEY}",
    "${ANTHROPIC_AUTH_TOKEN}",
    { source: "env", provider: "model", id: "OPENAI_API_KEY" },
  ]) {
    assert.throws(
      () =>
        driver.validateHarnessAuth(embedded, apiKeyAuth, {
          ...configuration,
          models: { providers: { anthropic: { apiKey } } },
        }),
      /credentials must use.*binding/i,
    );
  }
  for (const conflicting of [
    { env: { ANTHROPIC_API_KEY: "fixture" } },
    { env: { vars: { ANTHROPIC_AUTH_TOKEN: "fixture" } } },
    { auth: { profiles: { alternate: { provider: "anthropic", mode: "token" } } } },
    { models: { providers: { anthropic: { headers: { "x-api-key": "fixture" } } } } },
    {
      models: {
        providers: {
          anthropic: { models: [{ id: "claude-sonnet-4-5", headers: { "x-api-key": "fixture" } }] },
        },
      },
    },
  ]) {
    assert.throws(
      () => driver.validateHarnessAuth(embedded, apiKeyAuth, { ...configuration, ...conflicting }),
      /credentials must use.*binding/i,
    );
  }
  for (const selection of [
    { primary: model, fallbacks: ["openai/gpt-5"] },
    { primary: "openai/gpt-5", fallbacks: [model] },
    "codex/gpt-5",
    "ollama/llama3.2",
  ]) {
    assert.throws(
      () =>
        driver.validateHarnessAuth(embedded, apiKeyAuth, {
          agents: { defaults: { model: selection } },
        }),
      /compatible model provider/i,
    );
  }
  assert.throws(
    () =>
      driver.validateHarnessAuth(
        { id: "codex", version: "1.0.0", mode: "dedicated" },
        apiKeyAuth,
        configuration,
      ),
    /compatible model provider/i,
  );
});

test("embedded startup probes its selected provider and allows graceful Gateway shutdown", async (t) => {
  const nodeRequire = createRequire(import.meta.url);
  function assertProbeStageDiagnostics(
    lines,
    expectedOtherLines,
    elapsedMs,
    expectedStages = ["prepare", "preflight", "spawn", "returned", "cleanup", "complete"],
  ) {
    const stageLines = lines.filter((line) => line.includes('"openclaw.model_probe_stage"'));
    const stages = stageLines.map((line) => JSON.parse(line));
    assert.deepEqual(
      stages.map(({ stage }) => stage),
      expectedStages,
    );
    let previousElapsedMs = 0;
    for (const stage of stages) {
      // Only this closed, nonsecret schema may leave the unexpected-stderr set.
      assert.deepEqual(Object.keys(stage).sort(), ["capMs", "elapsedMs", "event", "stage"]);
      assert.equal(stage.event, "openclaw.model_probe_stage");
      assert.equal(stage.capMs, 110_000);
      assert.ok(Number.isSafeInteger(stage.elapsedMs));
      assert.ok(stage.elapsedMs >= previousElapsedMs && stage.elapsedMs <= elapsedMs);
      previousElapsedMs = stage.elapsedMs;
    }
    assert.deepEqual(
      lines.filter((line) => !stageLines.includes(line)),
      expectedOtherLines,
    );
  }
  for (const [provider, model, credentialName] of [
    ["openai", "gpt-5", "OPENAI_API_KEY"],
    ["anthropic", "claude-sonnet-4-5", "ANTHROPIC_API_KEY"],
  ]) {
    for (const [variant, probeStatus, failureCode] of [
      ["accepted", "ok", undefined],
      ["wrong provider result", "ok", "MODEL_PROBE_FAILED"],
      // OpenClaw buckets provider 401/403 and invalid-key responses as "auth".
      ["credentials rejected", "auth", "AUTHENTICATION_FAILED"],
      // The provider's 401 to the upfront request ends the probe before OpenClaw starts.
      ["credentials rejected upfront", undefined, "AUTHENTICATION_FAILED"],
      ["provider unavailable", "unknown", "MODEL_PROBE_FAILED"],
      ["provider timeout", "timeout", "MODEL_PROBE_TIMEOUT"],
      // The wrapper's cap ends the probe. Only CPU waiting for most of it makes
      // the failure CPU starvation, which fails the deployment at once.
      ["cap exceeded while waiting for CPU", undefined, "MODEL_PROBE_CPU_STARVED"],
      ["cap exceeded without CPU waiting", undefined, "MODEL_PROBE_TIMEOUT"],
      // Without pressure accounting, CPU-limit throttling is the waiting evidence.
      [
        "cap exceeded while throttled without pressure accounting",
        undefined,
        "MODEL_PROBE_CPU_STARVED",
      ],
    ]) {
      const accepted = failureCode === undefined;
      const upfront = variant === "credentials rejected upfront";
      await t.test(`${provider}: ${variant}`, async () => {
        const driver = createKubernetesComputeDriver(options());
        const candidate = {
          namespaceId: tenant.id,
          harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
          harnessAuth: apiKeyAuth,
          configuration: { agents: { defaults: { model: `${provider}/${model}` } } },
        };
        const prepared = driver.harnessAuthForRevision(candidate, authContext(candidate), {
          name: kubernetesGatewayNamespaceName(tenant.id),
          plane: "control",
        });
        const files = new Map();
        const calls = [];
        const errors = [];
        const signals = new Map();
        const childEvents = new Map();
        const childSignals = [];
        const exits = [];
        const timers = [];
        let probeTemplate;
        let pressureReads = 0;
        let started = false;
        let held = false;
        let statusHandler;
        // Stub native process I/O only: execute the complete generated startup
        // program and its real probe result validation, without claiming a model turn.
        runInNewContext(GATEWAY_RUNTIME_ENTRYPOINT, {
          Buffer,
          JSON,
          URL,
          console: { error: (value) => errors.push(value) },
          process: {
            env: Object.fromEntries([
              ...prepared.environment.map((entry) => [
                entry.name,
                entry.value ?? "fixture-model-key",
              ]),
              ["TMPDIR", "/approved-temporary"],
              ["NODE_EXTRA_CA_CERTS", "/run/openshell/ca.crt"],
              ["SSL_CERT_FILE", "/run/openshell/ca-bundle.crt"],
              ["OPENCLAW_AGENT_REVISION_ID", "revision-embedded-probe"],
              ["OPENCLAW_RUNTIME_STATUS_CONTAINER", "gateway"],
              ["OPENCLAW_RUNTIME_STATUS_PORT", "18791"],
              ["OPENCLAW_POD_UID", "pod-embedded-probe"],
            ]),
            on(signal, callback) {
              signals.set(signal, callback);
            },
            exit(code) {
              exits.push(code);
            },
            execPath: "/usr/local/bin/node",
          },
          setTimeout(callback, delay) {
            timers.push({ callback, delay });
            return { unref() {} };
          },
          setInterval() {
            held = true;
          },
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
                mkdirSync() {},
                mkdtempSync(template) {
                  probeTemplate = template;
                  return "/isolated-probe";
                },
                writeFileSync(path, value) {
                  files.set(path, value);
                },
                rmSync() {},
                // A 500m CPU limit; waiting grows 100 s across a starved probe.
                readFileSync(path) {
                  const starved =
                    variant.includes("waiting for CPU") || variant.includes("throttled");
                  if (path === "/sys/fs/cgroup/cpu.max") {
                    return "50000 100000\n";
                  }
                  if (
                    path === "/sys/fs/cgroup/cpu.pressure" &&
                    !variant.includes("pressure accounting")
                  ) {
                    const total = starved ? pressureReads++ * 1e8 : 0;
                    return `some avg10=0.00 avg60=0.00 avg300=0.00 total=${total}\nfull total=0\n`;
                  }
                  if (path === "/sys/fs/cgroup/cpu.stat") {
                    const throttled = starved ? pressureReads++ * 1e8 : 0;
                    return `usage_usec 1\nnr_throttled 1\nthrottled_usec ${throttled}\n`;
                  }
                  throw Object.assign(new Error("unexpected read"), { code: "ENOENT" });
                },
              };
            }
            if (specifier === "node:child_process") {
              return {
                spawnSync(command, args, options) {
                  calls.push({
                    command,
                    args: Array.from(args),
                    environment: { ...options.env },
                    timeout: options.timeout,
                  });
                  if (args[0] === "-e") {
                    // The upfront request's child exits 3 only on the provider's 401.
                    return { status: upfront ? 3 : 0 };
                  }
                  if (variant.startsWith("cap exceeded")) {
                    return {
                      status: null,
                      signal: "SIGKILL",
                      stdout: "",
                      error: { code: "ETIMEDOUT" },
                    };
                  }
                  return {
                    status: 0,
                    stdout: JSON.stringify({
                      auth: {
                        probes: {
                          results: [
                            {
                              provider:
                                variant === "wrong provider result" ? "another-provider" : provider,
                              model: `${provider}/${model}`,
                              source: "env",
                              status: probeStatus,
                            },
                          ],
                        },
                      },
                    }),
                  };
                },
                spawn() {
                  started = true;
                  return {
                    kill(signal) {
                      childSignals.push(signal);
                    },
                    on(event, callback) {
                      childEvents.set(event, callback);
                    },
                  };
                },
              };
            }
            return nodeRequire(specifier);
          },
        });
        await Promise.resolve();
        assert.equal(calls.length, upfront ? 1 : 2);
        assert.equal(probeTemplate, "/approved-temporary/openclaw-auth-probe-");
        // The upfront request carries the credential as OpenClaw sends it to
        // the provider's default endpoint, and nothing else from the environment.
        const [upfrontCall, probeCall] = calls;
        assert.equal(upfrontCall.command, "/usr/local/bin/node");
        assert.equal(upfrontCall.timeout, 10_000);
        assert.deepEqual(Object.keys(upfrontCall.environment).sort(), [
          "H",
          "NODE_EXTRA_CA_CERTS",
          "SSL_CERT_FILE",
          "U",
        ]);
        assert.equal(upfrontCall.environment.NODE_EXTRA_CA_CERTS, "/run/openshell/ca.crt");
        assert.deepEqual(
          [upfrontCall.environment.U, JSON.parse(upfrontCall.environment.H)],
          provider === "openai"
            ? [
                "https://api.openai.com/v1/responses",
                { authorization: "Bearer fixture-model-key", "content-type": "application/json" },
              ]
            : [
                "https://api.anthropic.com/v1/messages",
                {
                  "x-api-key": "fixture-model-key",
                  "anthropic-version": "2023-06-01",
                  "content-type": "application/json",
                },
              ],
        );
        if (!upfront) {
          assert.equal(probeCall.environment.TMPDIR, "/isolated-probe");
          // 15 s model turn, 5 s slack, and 45 CPU-seconds at the 500m limit.
          assert.equal(probeCall.timeout, 110_000);
          assert.equal(probeCall.environment.NODE_EXTRA_CA_CERTS, "/run/openshell/ca.crt");
          assert.equal(probeCall.environment.SSL_CERT_FILE, "/run/openshell/ca-bundle.crt");
          assert.equal(probeCall.args[probeCall.args.indexOf("--probe-provider") + 1], provider);
          assert.equal(probeCall.environment[credentialName], "fixture-model-key");
          assert.equal(
            probeCall.environment[provider === "openai" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"],
            undefined,
          );
          assert.equal(
            JSON.parse(files.get("/isolated-probe/openclaw.json")).agents.defaults.model,
            `${provider}/${model}`,
          );
        }
        assert.equal(started, accepted);
        assert.equal(held, !accepted);
        const phaseLines = errors.filter((line) => line.includes('"runtime.startup_phase"'));
        const probeLines = errors.filter((line) => line.includes('"openclaw.model_probe"'));
        assert.equal(probeLines.length, 1);
        const probeLog = JSON.parse(probeLines[0]);
        const otherLines = errors.filter(
          (line) => !phaseLines.includes(line) && !probeLines.includes(line),
        );
        assertProbeStageDiagnostics(
          otherLines,
          accepted ? [] : ["Harness model authentication probe failed."],
          probeLog.elapsedMs,
          upfront ? ["prepare", "preflight", "cleanup", "complete"] : undefined,
        );
        if (provider === "openai" && accepted) {
          // Mutate actual generated diagnostics: a permissive filter must not
          // conceal malformed fields, secret-bearing records or unexpected logs.
          const firstStage = JSON.parse(otherLines[0]);
          for (const [name, line] of [
            ["malformed JSON", '{"event":"openclaw.model_probe_stage"'],
            ["unknown event", JSON.stringify({ ...firstStage, event: "unexpected.event" })],
            ["unknown stage", JSON.stringify({ ...firstStage, stage: "unexpected" })],
            ["secret field", JSON.stringify({ ...firstStage, credential: "fixture-model-key" })],
            ["secret stage", JSON.stringify({ ...firstStage, stage: "fixture-model-key" })],
            ["string time", JSON.stringify({ ...firstStage, elapsedMs: "fixture-model-key" })],
            ["missing time", JSON.stringify({ ...firstStage, elapsedMs: undefined })],
            ["null time", JSON.stringify({ ...firstStage, elapsedMs: null })],
            ["negative time", JSON.stringify({ ...firstStage, elapsedMs: -1 })],
            ["fractional time", JSON.stringify({ ...firstStage, elapsedMs: 0.5 })],
            ["unsafe time", JSON.stringify({ ...firstStage, elapsedMs: Number.MAX_VALUE })],
            ["late time", JSON.stringify({ ...firstStage, elapsedMs: probeLog.elapsedMs + 1 })],
            ["wrong cap", JSON.stringify({ ...firstStage, capMs: 600_000 })],
          ]) {
            assert.throws(
              () =>
                assertProbeStageDiagnostics([line, ...otherLines.slice(1)], [], probeLog.elapsedMs),
              { name: name === "malformed JSON" ? "SyntaxError" : "AssertionError" },
              name,
            );
          }
          for (const lines of [
            otherLines.slice(1),
            [...otherLines, otherLines[0]],
            [otherLines[1], otherLines[0], ...otherLines.slice(2)],
            [...otherLines, "unexpected fixture-model-key"],
          ]) {
            assert.throws(() => assertProbeStageDiagnostics(lines, [], probeLog.elapsedMs), {
              name: "AssertionError",
            });
          }
        }
        assert.deepEqual([probeLog.code, probeLog.capMs], [failureCode ?? "READY", 110_000]);
        assert.equal(
          probeLog.cpuWaitMs,
          variant.includes("waiting for CPU") || variant.includes("throttled") ? 100_000 : 0,
        );
        assert.doesNotMatch(
          probeLines[0],
          new RegExp([provider, model, credentialName, "fixture-model-key"].join("|")),
        );
        // Startup timing names phases only, never the provider, model or credential.
        assert.deepEqual(
          phaseLines.map((line) => {
            const { container, phase, outcome } = JSON.parse(line);
            return [container, phase, outcome];
          }),
          [
            ["gateway", "model-probe", accepted ? "ok" : "failed"],
            ...(accepted ? [["gateway", "native-spawn", "ok"]] : []),
          ],
        );
        assert.doesNotMatch(
          phaseLines.join("\n"),
          new RegExp([provider, model, credentialName, "fixture-model-key"].join("|")),
        );
        let body = "";
        statusHandler(
          { method: "GET", url: "/openclaw/runtime/status" },
          { writeHead() {}, end: (chunk) => (body += chunk) },
        );
        assert.equal(JSON.parse(body).runtimeFailure?.code, failureCode);
        if (accepted) {
          signals.get("SIGTERM")();
          assert.deepEqual(childSignals, ["SIGTERM"]);
          // An admitted turn can take longer than the old eight-second wrapper
          // timeout to settle. Advance only the supervisor timers; native drain
          // and model completion are proved by the real-runtime acceptance.
          for (const timer of timers.filter(({ delay }) => delay <= 9_000)) {
            timer.callback();
          }
          assert.deepEqual(childSignals, ["SIGTERM"], "must allow a nine-second drain");
          assert.deepEqual(exits, [], "supervisor must wait for the child to finish");
          childEvents.get("exit")(0, null);
          assert.deepEqual(exits, [0], "clean Gateway completion exits the supervisor");
        }
      });
    }
  }
});

test("SDK resource requirements still require explicit CPU and memory requests and limits", () => {
  const configured = options().resources;

  for (const [resources, expected] of [
    [
      { ...configured, gateway: { limits: { cpu: "250m", memory: "128Mi" } } },
      /Gateway requests and limits/i,
    ],
    [
      {
        ...configured,
        agent: { requests: { cpu: "100m", memory: "64Mi" }, limits: { cpu: "250m" } },
      },
      /Agent memory limit/i,
    ],
    [
      {
        ...configured,
        namespace: {
          ...configured.namespace,
          containerDefaults: {
            requests: { cpu: "100m" },
            limits: { cpu: "250m", memory: "128Mi" },
          },
        },
      },
      /Namespace default memory request/i,
    ],
  ]) {
    assert.throws(() => createKubernetesComputeDriver(options({ resources })), expected);
  }
});

test("production drivers reject injected clients and fail closed without their kubeconfig", async () => {
  for (const clients of [{}, undefined]) {
    assert.throws(
      () => createKubernetesComputeDriver({ ...options(), clients }),
      /client|inject|configuration/i,
    );
  }

  const inheritedClients = Object.assign(Object.create({ clients: {} }), options());
  assert.throws(() => createKubernetesComputeDriver(inheritedClients), /client|inject/i);

  const driver = createKubernetesComputeDriver(
    options({
      authentication: {
        mode: "kubeconfig",
        kubeconfigPath: `/tmp/openclaw-enterprise-conformance/missing-kubeconfig-${process.pid}`,
        context: contextName,
      },
    }),
  );

  assert.deepEqual(await driver.ensureNamespace(tenant), {
    namespaceId: tenant.id,
    namespaceReady: false,
    failure: "retryable",
  });
});

test("Kubernetes lifecycle owners cannot be replaced after their first operation begins", async () => {
  const selected = {
    id: "configuration-selected",
    capability: "configuration",
    implementation: "local-selected",
    computeLifecycleHooks: { async afterNamespacePrepared() {} },
  };
  const driver = new KubernetesComputeDriver(options(), { lifecycleDrivers: [selected] });

  // Startup composition may configure trusted owners before any tenant resource is touched.
  assert.doesNotThrow(() => driver.setLifecycleDrivers([selected]));

  const operation = driver.ensureNamespace(tenant);

  // Freeze ownership synchronously so an in-flight reconciliation cannot lose its revocation owner.
  assert.throws(() => driver.setLifecycleDrivers([]), /owners cannot change.*operations begin/i);
  await operation;
  assert.doesNotThrow(() => driver.setLifecycleDrivers([selected]));
  assert.throws(
    () =>
      driver.setLifecycleDrivers([
        {
          ...selected,
          computeLifecycleHooks: { async afterNamespacePrepared() {} },
        },
      ]),
    /owners cannot change.*operations begin/i,
  );
  assert.throws(() => driver.setLifecycleDrivers([]), /owners cannot change.*operations begin/i);
});

test("Kubernetes lifecycle hooks never run before cluster ownership and workload identity checks", async () => {
  const calls = [];
  const selected = {
    id: "configuration-selected",
    capability: "configuration",
    implementation: "local-selected",
    computeLifecycleHooks: {
      async afterNamespacePrepared() {
        calls.push("namespace-prepared");
      },
      async beforeWorkloadStart() {
        calls.push("workload-start");
      },
      async beforeWorkloadStop() {
        calls.push("workload-stop");
      },
      async beforeNamespaceDelete() {
        calls.push("namespace-delete");
      },
    },
  };
  const driver = new KubernetesComputeDriver(
    options({
      authentication: {
        mode: "kubeconfig",
        kubeconfigPath: `/tmp/openclaw-enterprise-conformance/missing-lifecycle-${process.pid}`,
        context: contextName,
      },
    }),
    { lifecycleDrivers: [selected] },
  );
  const foreignRevision = {
    id: "revision-foreign-1",
    namespaceId: tenant.id,
    agentId: "agent-foreign",
    revision: 1,
    configurationId: "cfg_00000000-0000-4000-8000-000000000001",
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration: {
      agents: { defaults: { model: "codex/gpt-5" } },
      gateway: { controlUi: { enabled: false } },
      logging: {
        level: "info",
        consoleLevel: "info",
        consoleStyle: "json",
      },
      diagnostics: { otel: { logs: false } },
    },
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    harnessAuth: apiKeyAuth,
    compute: { id: "another-driver", implementation: "another-implementation" },
    servicePrincipalId: "service-principal-agent-foreign",
    createdAt: tenant.createdAt,
  };

  // Hooks cannot prepare or revoke tenant infrastructure until its cluster ownership is verified.
  const namespacePreparation = await driver.ensureNamespace(tenant);
  assert.deepEqual(
    { ...namespacePreparation, failure: undefined },
    {
      namespaceId: tenant.id,
      namespaceReady: false,
      failure: undefined,
    },
  );
  assert.match(namespacePreparation.failure, /^(?:permanent|retryable)$/);
  const namespaceDeletion = await driver.deleteNamespace({ ...tenant, status: "deleting" });
  assert.deepEqual(
    { ...namespaceDeletion, failure: undefined },
    {
      namespaceId: tenant.id,
      namespaceDeleted: false,
      failure: undefined,
    },
  );
  assert.match(namespaceDeletion.failure, /^(?:permanent|retryable)$/);

  // Another Compute Driver's revision must never trigger this driver's credential lifecycle.
  assert.deepEqual(await driver.prepareRevision(foreignRevision), {
    namespaceId: tenant.id,
    agentId: foreignRevision.agentId,
    revisionId: foreignRevision.id,
    ready: false,
  });
  await assert.rejects(driver.retireRevision(foreignRevision), /another Compute Driver/i);
  assert.deepEqual(calls, []);
});

test("containment-only Sandbox cleanup retries after its Compute-owned workload is absent", async () => {
  const cleanupCalls = [];
  const deletionCalls = [];
  let deploymentPresent = true;
  const sandboxDriver = {
    id: "sandbox-containment-only",
    implementation: "test/containment-only",
    capability: "sandbox",
    facets: ["networking"],
    async cleanup(context) {
      assert.equal(deploymentPresent, false);
      cleanupCalls.push(context);
      if (cleanupCalls.length === 1) {
        throw new Error("sandbox cleanup failed");
      }
    },
  };
  const driver = new KubernetesComputeDriver(options(), { sandboxDriver });
  const revision = routedRevision(driver, {
    id: "revision-containment-retirement",
    sandboxDriverId: sandboxDriver.id,
  });
  const namespace = kubernetesNamespaceName(revision.namespaceId);
  const namespaceResource = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: namespace,
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace": revision.namespaceId,
      },
      annotations: { "openclaw.dev/namespace-id": revision.namespaceId },
    },
  };
  const deploymentName = `agent-${digest(revision.agentId)}-rev-${digest(revision.id)}`;
  const deployment = driver.deployment(
    deploymentName,
    {
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      servicePrincipalId: revision.servicePrincipalId,
      revisionId: revision.id,
    },
    { name: namespace, plane: "execution" },
    "agent:local",
    `agent-${digest(revision.agentId)}`,
    "agent",
    {},
    "info",
    undefined,
    undefined,
    undefined,
    preparedAuth(driver, namespace, false),
  );
  deployment.metadata.uid = "containment-workload-uid";
  const gatewayName = `gateway-${digest(revision.agentId)}`;
  let gatewayReads = 0;
  const notFound = () => Object.assign(new Error("Not found"), { code: 404 });

  // Only Kubernetes transport observations are substituted; retirement and Sandbox dispatch
  // execute through the production driver against a supported containment-only extension.
  driver.apiClients = Promise.resolve({
    core: {
      async readNamespacedSecret() {
        throw notFound();
      },
      async listNamespace() {
        return { apiVersion: "v1", kind: "NamespaceList", items: [namespaceResource] };
      },
      async readNamespace({ name }) {
        if (name === kubernetesGatewayNamespaceName(tenant.id)) {
          return {
            ...driver.gatewayNamespaceManifest({ namespaceId: tenant.id }),
            status: { phase: "Active" },
          };
        }
        return structuredClone(namespaceResource);
      },
      async listNamespacedPod() {
        assert.equal(deploymentPresent, false);
        return { apiVersion: "v1", kind: "PodList", items: [] };
      },
      async readNamespacedPersistentVolumeClaim() {
        throw notFound();
      },
      async readNamespacedConfigMap() {
        throw notFound();
      },
      async readNamespacedService() {
        throw notFound();
      },
      async readNamespacedServiceAccount() {
        throw notFound();
      },
    },
    apps: {
      async readNamespacedDeployment({ name }) {
        if (name === deploymentName && deploymentPresent) {
          return structuredClone(deployment);
        }
        if (name === gatewayName) {
          gatewayReads += 1;
        }
        throw notFound();
      },
      async deleteNamespacedDeployment(request) {
        deletionCalls.push(request);
        deploymentPresent = false;
      },
    },
    networking: {
      async readNamespacedNetworkPolicy() {
        throw notFound();
      },
    },
    objects: {
      async read() {
        throw notFound();
      },
    },
  });

  // The first cleanup failure occurs after workload removal and must keep retirement retryable.
  await assert.rejects(driver.retireRevision(revision), /sandbox cleanup failed/);
  assert.equal(deploymentPresent, false);
  assert.deepEqual(deletionCalls, [
    {
      name: deploymentName,
      namespace,
      body: { preconditions: { uid: deployment.metadata.uid } },
    },
  ]);
  assert.equal(cleanupCalls.length, 1);
  assert.equal(gatewayReads, 0);

  // The absent-workload retry must run the required cleanup again instead of completing early.
  await driver.retireRevision(revision);
  assert.equal(deletionCalls.length, 1);
  assert.equal(cleanupCalls.length, 2);
  assert.ok(gatewayReads >= 1);
  for (const context of cleanupCalls) {
    assert.equal(context.namespace.id, revision.namespaceId);
    assert.equal(context.namespace.name, namespace);
    assert.deepEqual(context.revision, revision);
  }
});

test("the official Kubernetes client rejects ambiguous identity and insecure API servers", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-kubernetes-auth-conformance-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  for (const scenario of [
    { name: "unselected-context", context: "missing-context" },
    { name: "missing-credential-identity", users: [] },
    { name: "plaintext-api-endpoint", server: "http://127.0.0.1:1" },
    { name: "unverified-tls", skipTLSVerify: true },
    { name: "embedded-api-credentials", server: "https://user:password@127.0.0.1:1" },
    { name: "unexpected-api-path", server: "https://127.0.0.1:1/untrusted" },
  ]) {
    const path = join(directory, `${scenario.name}.json`);
    await writeFile(
      path,
      JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
        clusters: [
          {
            name: "conformance-cluster",
            cluster: {
              server: scenario.server ?? "https://127.0.0.1:1",
              ...(scenario.skipTLSVerify ? { "insecure-skip-tls-verify": true } : {}),
            },
          },
        ],
        users: scenario.users ?? [
          { name: "conformance-user", user: { token: "test-only-fixture-token" } },
        ],
        contexts: [
          {
            name: contextName,
            context: { cluster: "conformance-cluster", user: "conformance-user" },
          },
        ],
        "current-context": contextName,
      }),
    );

    const driver = createKubernetesComputeDriver(
      options({
        authentication: {
          mode: "kubeconfig",
          kubeconfigPath: path,
          context: scenario.context ?? contextName,
        },
      }),
    );

    // Unsafe cluster configuration is permanently rejected before contacting its API server.
    assert.deepEqual(
      await driver.ensureNamespace(tenant),
      {
        namespaceId: tenant.id,
        namespaceReady: false,
        failure: "permanent",
      },
      scenario.name,
    );
  }
});

test("immutable image policy accepts digests and rejects mutable tags", () => {
  assert.throws(
    () =>
      createKubernetesComputeDriver(
        options({
          images: {
            gateway: "registry.example/gateway:latest",
            agent: "registry.example/agent:latest",
            requireImmutableDigest: true,
          },
        }),
      ),
    /digest|immutable/i,
  );

  assert.doesNotThrow(() =>
    createKubernetesComputeDriver(
      options({
        images: {
          gateway: `registry.example/gateway@sha256:${"a".repeat(64)}`,
          agent: `registry.example/agent@sha256:${"b".repeat(64)}`,
          requireImmutableDigest: true,
        },
      }),
    ),
  );
});

test("projected ServicePrincipal tokens require an audience and bounded expiration", () => {
  for (const credentials of [
    { mode: "projectedServiceAccountToken", audience: "", expirationSeconds: 900 },
    { mode: "projectedServiceAccountToken", audience: "occ", expirationSeconds: 599 },
    { mode: "projectedServiceAccountToken", audience: "occ", expirationSeconds: 86_401 },
  ]) {
    assert.throws(
      () => createKubernetesComputeDriver(options({ servicePrincipalCredentials: credentials })),
      /audience|expiration|token/i,
    );
  }

  assert.doesNotThrow(() =>
    createKubernetesComputeDriver(
      options({
        servicePrincipalCredentials: {
          mode: "projectedServiceAccountToken",
          audience: "openclaw-controller",
          expirationSeconds: 900,
        },
      }),
    ),
  );
});

test("provider-owned Harness requirements preserve the exact projected ServicePrincipal identity", () => {
  const runtime = {
    transportSecretPrefix: "transport",
    gatewayStorageClassName: "local-path",
  };
  const driver = createKubernetesComputeDriver(
    options({
      runtime,
      servicePrincipalCredentials: {
        mode: "projectedServiceAccountToken",
        audience: "openclaw-controller",
        expirationSeconds: 900,
      },
    }),
  );
  const ownership = {
    namespaceId: tenant.id,
    agentId: "agt_00000000-0000-4000-8000-000000000001",
    revisionId: "rev_00000000-0000-4000-8000-000000000001",
    serviceAccountId: "sa_00000000-0000-4000-8000-000000000001",
    servicePrincipalId: "service-agent-agt_00000000-0000-4000-8000-000000000001",
  };
  const workload = driver.deployment(
    "agent-projected-identity",
    ownership,
    { name: kubernetesNamespaceName(tenant.id), plane: "execution" },
    "agent:local",
    "agent-projected-identity",
    "agent",
    {},
    "info",
    undefined,
    undefined,
    undefined,
    preparedAuth(driver, kubernetesNamespaceName(tenant.id), false),
  );

  const requirements = driver.harnessRequirementsFromDeployment(workload, "api_key");
  assert.equal(requirements.loginMode, "api_key");
  // Backend requirements must carry readable identities unchanged into Pod labels and selectors.
  for (const [key, value] of Object.entries({
    "openclaw.dev/namespace": ownership.namespaceId,
    "openclaw.dev/agent": ownership.agentId,
    "openclaw.dev/revision": ownership.revisionId,
    "openclaw.dev/service-account": ownership.serviceAccountId,
    "openclaw.dev/service-principal": ownership.servicePrincipalId,
  })) {
    assert.equal(workload.metadata.labels[key], value);
    assert.equal(workload.spec.template.metadata.labels[key], value);
    assert.equal(requirements.labels[key], value);
  }
  assert.deepEqual(requirements.serviceAccountToken, {
    audience: "openclaw-controller",
    expirationSeconds: 900,
    mountPath: "/var/run/secrets/openclaw/service-principal",
    path: "token",
    readOnly: true,
  });

  for (const mutate of [
    (spec) => {
      spec.volumes = spec.volumes.filter(({ name }) => name !== "openclaw-service-principal");
    },
    (spec) => {
      spec.volumes.find(
        ({ name }) => name === "openclaw-service-principal",
      ).projected.sources[0].serviceAccountToken.audience = "another-audience";
    },
    (spec) => {
      spec.volumes.find(
        ({ name }) => name === "openclaw-service-principal",
      ).projected.sources[0].serviceAccountToken.expirationSeconds = 901;
    },
    (spec) => {
      spec.volumes.find(
        ({ name }) => name === "openclaw-service-principal",
      ).projected.sources[0].serviceAccountToken.path = "another-token";
    },
    (spec) => {
      spec.containers[0].volumeMounts.find(
        ({ name }) => name === "openclaw-service-principal",
      ).readOnly = false;
    },
    (spec) => {
      spec.containers[0].volumeMounts.find(
        ({ name }) => name === "openclaw-service-principal",
      ).mountPath = "/another-token-path";
    },
  ]) {
    // A provider must receive exactly the same audience, expiry, token path, and readonly mount.
    const altered = structuredClone(workload);
    mutate(altered.spec.template.spec);
    assert.throws(
      () => driver.harnessRequirementsFromDeployment(altered, "api_key"),
      /ServicePrincipal/i,
    );
  }

  const withoutProjection = createKubernetesComputeDriver(options({ runtime }));
  const unprojected = withoutProjection.deployment(
    "agent-projected-identity",
    ownership,
    { name: kubernetesNamespaceName(tenant.id), plane: "execution" },
    "agent:local",
    "agent-projected-identity",
    "agent",
    {},
    "info",
    undefined,
    undefined,
    undefined,
    preparedAuth(withoutProjection, kubernetesNamespaceName(tenant.id), false),
  );
  assert.throws(
    () => withoutProjection.harnessRequirementsFromDeployment(unprojected, "api_key"),
    /projected ServicePrincipal token/i,
  );
});

function providerReadinessFixture({ provisionHarness, lifecycleDrivers = [] } = {}) {
  const driver = new KubernetesComputeDriver(
    routedOptions({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
      },
      servicePrincipalCredentials: {
        mode: "projectedServiceAccountToken",
        audience: "openclaw-controller",
        expirationSeconds: 900,
      },
    }),
    {
      lifecycleDrivers,
      nodeEnrollment: {
        async isConnected() {
          return true;
        },
      },
      sandboxDriver: {
        id: "sandbox-provider",
        async provisionHarness(context) {
          if (provisionHarness !== undefined) {
            return provisionHarness(context);
          }
          assert.fail("activation must only observe the previously provisioned Harness");
        },
      },
    },
  );
  const revision = routedRevision(driver, {
    sandboxDriverId: "sandbox-provider",
    configuration: admitLoggingConfiguration(
      {
        agents: { defaults: { model: "codex/gpt-5" } },
        gateway: { ...routedRevision(driver).configuration.gateway, controlUi: { enabled: false } },
      },
      "info",
    ),
  });
  const namespace = kubernetesNamespaceName(tenant.id);
  const agentName = `agent-${digest(revision.agentId)}`;
  const deployment = driver.deployment(
    `${agentName}-rev-${digest(revision.id)}`,
    {
      namespaceId: tenant.id,
      agentId: revision.agentId,
      revisionId: revision.id,
      servicePrincipalId: revision.servicePrincipalId,
    },
    { name: namespace, plane: "execution" },
    "agent:local",
    agentName,
    "agent",
    {},
    "info",
    undefined,
    undefined,
    undefined,
    preparedAuth(driver, namespace, false),
  );
  const { labels } = driver.harnessRequirementsFromDeployment(deployment, "api_key");
  const requests = [];
  let observe = () => ({ apiVersion: "v1", kind: "PodList", items: [] });
  const core = {
    async readNamespace() {
      return {
        ...driver.gatewayNamespaceManifest({ namespaceId: tenant.id }),
        status: { phase: "Active" },
      };
    },
    async readNamespacedSecret({ name }) {
      assert.equal(name, driver.workspaceNodeName(revision));
      return {
        ...driver.manifest("v1", "Secret", name, driver.pluginRuntimeOwnership(revision), {
          name: namespace,
          plane: "execution",
        }),
        data: {
          deviceId: Buffer.from("provider-node").toString("base64"),
          // A current setup code, as preparation keeps renewing it.
          expiresAtMs: Buffer.from(String(Date.now() + 600_000)).toString("base64"),
        },
      };
    },
    async listNamespace() {
      return { items: [] };
    },
    async listNamespacedPod(request) {
      if (request.labelSelector.includes("openclaw.dev/workload-role=gateway")) {
        // The workspace node binding nudge: the Gateway Pod is not modeled here.
        assert.equal(request.namespace, kubernetesGatewayNamespaceName(tenant.id));
        return { items: [] };
      }
      requests.push(request);
      assert.equal(request.namespace, namespace);
      assert.deepEqual(
        Object.fromEntries(request.labelSelector.split(",").map((entry) => entry.split("="))),
        {
          "openclaw.dev/agent": revision.agentId,
          "openclaw.dev/revision": revision.id,
          "openclaw.dev/workload-role": "agent",
        },
      );
      assert.equal(request.timeoutSeconds, 10);
      return observe();
    },
  };
  // Only the Kubernetes transport returns fixture data. Candidate selection, validation,
  // request cancellation, and revision activation all execute the production driver.
  driver.apiClients = Promise.resolve({ core });
  return {
    driver,
    revision,
    namespace,
    deployment,
    labels,
    requests,
    core,
    pod(name, ready = "True") {
      return {
        apiVersion: "v1",
        kind: "Pod",
        metadata: { name, namespace, labels: { ...labels } },
        status: { conditions: [{ type: "Ready", status: ready }] },
      };
    },
    setObservation(value) {
      observe = typeof value === "function" ? value : () => structuredClone(value);
    },
    ready() {
      return driver.providerHarnessReady(revision, { name: namespace, plane: "execution" }, labels);
    },
  };
}

test("provider Harness readiness requires exactly one live matching Pod", async (t) => {
  const fixture = providerReadinessFixture();
  const ready = fixture.pod("harness-ready");
  const unready = fixture.pod("harness-starting", "False");
  const terminating = fixture.pod("harness-terminating");
  terminating.metadata.deletionTimestamp = new Date("2026-08-25T00:00:00Z");
  const cases = [
    ["no Pods", [], false],
    ["one Ready Pod", [ready], true],
    ["one unready Pod", [unready], false],
    ["one unknown Pod", [fixture.pod("harness-unknown", "Unknown")], false],
    ["two Ready Pods", [ready, fixture.pod("harness-other")], false],
    ["Ready then unready", [ready, unready], false],
    ["unready then Ready", [unready, ready], false],
    ["two unready Pods", [unready, fixture.pod("harness-other", "False")], false],
    ["repeated Pod entry", [ready, ready], false],
    ["only terminating", [terminating], false],
    ["Ready plus terminating", [ready, terminating], true],
    ["unready plus terminating", [unready, terminating], false],
    ["all terminating", [terminating, terminating], false],
  ];
  for (const missing of ["status", "conditions"]) {
    const waiting = fixture.pod(`harness-no-${missing}`);
    if (missing === "status") {
      delete waiting.status;
    } else {
      delete waiting.status.conditions;
    }
    cases.push([`missing optional ${missing}`, [waiting], false]);
  }
  for (const [field, value] of [
    ["namespace", "another-namespace"],
    ["openclaw.dev/agent", "another-agent"],
    ["openclaw.dev/revision", "another-revision"],
    ["openclaw.dev/workload-role", "gateway"],
  ]) {
    const unrelated = fixture.pod("unrelated");
    if (field === "namespace") {
      unrelated.metadata.namespace = value;
    } else {
      unrelated.metadata.labels[field] = value;
    }
    cases.push([`wrong ${field}`, [unrelated], false]);
    cases.push([`Ready plus wrong ${field}`, [ready, unrelated], true]);
  }
  const unlabeled = fixture.pod("unlabeled");
  delete unlabeled.metadata.labels;
  cases.push(["no labels", [unlabeled], false]);
  const noTypeMetadata = fixture.pod("typed-sdk-pod");
  delete noTypeMetadata.apiVersion;
  delete noTypeMetadata.kind;
  cases.push(["optional Pod type metadata omitted", [noTypeMetadata], true]);
  const stringTimestamp = structuredClone(terminating);
  stringTimestamp.metadata.deletionTimestamp = "2026-08-25T00:00:00Z";
  cases.push(["serialized deletion timestamp", [ready, stringTimestamp], true]);

  for (const [name, items, expected] of cases) {
    await t.test(name, async () => {
      fixture.setObservation({ apiVersion: "v1", kind: "PodList", items });
      assert.equal(await fixture.ready(), expected);
    });
  }
});

test("provider Harness readiness rejects malformed or incomplete Pod observations", async (t) => {
  const fixture = providerReadinessFixture();
  const ready = fixture.pod("harness-ready");
  const invalid = /invalid or incomplete provider Harness Pod list/;
  for (const [name, response] of [
    ["null response", null],
    ["missing items", {}],
    ["object items", { items: {} }],
    ["null items", { items: null }],
    ["wrong list kind", { kind: "ServiceList", items: [ready] }],
    ["wrong list version", { apiVersion: "apps/v1", items: [ready] }],
    ["malformed list metadata", { metadata: [], items: [ready] }],
    ["continuation", { metadata: { continue: "next-page" }, items: [ready] }],
    ["SDK continuation", { metadata: { _continue: "next-page" }, items: [ready] }],
    ["remaining items", { metadata: { remainingItemCount: 1 }, items: [ready] }],
  ]) {
    await t.test(name, async () => {
      fixture.setObservation(response);
      await assert.rejects(fixture.ready(), invalid);
    });
  }
  for (const [name, mutate] of [
    ["wrong kind", (pod) => (pod.kind = "Service")],
    ["wrong version", (pod) => (pod.apiVersion = "apps/v1")],
    ["missing metadata", (pod) => delete pod.metadata],
    ["array metadata", (pod) => (pod.metadata = [])],
    ["missing name", (pod) => delete pod.metadata.name],
    ["empty namespace", (pod) => (pod.metadata.namespace = "")],
    ["array labels", (pod) => (pod.metadata.labels = [])],
    ["nonstring label", (pod) => (pod.metadata.labels.extra = 1)],
    [
      "contradictory selector label",
      (pod) => (pod.metadata.labels["openclaw.dev/service-principal"] = "another-principal"),
    ],
    ["null deletion timestamp", (pod) => (pod.metadata.deletionTimestamp = null)],
    ["invalid deletion date", (pod) => (pod.metadata.deletionTimestamp = new Date(NaN))],
    ["invalid deletion string", (pod) => (pod.metadata.deletionTimestamp = "0")],
    ["null status", (pod) => (pod.status = null)],
    ["array status", (pod) => (pod.status = [])],
    ["object conditions", (pod) => (pod.status.conditions = {})],
    ["null condition", (pod) => pod.status.conditions.push(null)],
    ["nonstring condition type", (pod) => pod.status.conditions.push({ type: 1, status: "True" })],
    ["nonstring condition status", (pod) => (pod.status.conditions[0].status = true)],
    ["invalid condition status", (pod) => (pod.status.conditions[0].status = "true")],
    ["duplicate Ready", (pod) => pod.status.conditions.push({ type: "Ready", status: "True" })],
    ["conflicting Ready", (pod) => pod.status.conditions.push({ type: "Ready", status: "False" })],
  ]) {
    await t.test(name, async () => {
      const malformed = fixture.pod("harness-malformed");
      mutate(malformed);
      // A valid Ready entry must not hide invalid observations before or after it.
      for (const items of [[malformed], [ready, malformed], [malformed, ready]]) {
        fixture.setObservation({ items });
        await assert.rejects(fixture.ready(), invalid);
      }
    });
  }
  for (const malformed of [null, false, "pod", [], {}]) {
    fixture.setObservation({ items: [ready, malformed] });
    await assert.rejects(fixture.ready(), invalid);
  }
  fixture.setObservation({ metadata: { continue: "", remainingItemCount: 0 }, items: [ready] });
  assert.equal(await fixture.ready(), true);
});

test("provider Harness activation fails before routing on absent, ambiguous, or malformed Pods", async () => {
  const fixture = providerReadinessFixture();
  const context = authContext(fixture.revision);
  const resolved = context.harnessAuth;
  for (const invalidContext of [
    undefined,
    { harnessAuth: { ...resolved, source: { ...resolved.source, id: "sec_other" } } },
    { harnessAuth: { ...resolved, secretDriverId: "another-secret-driver" } },
    {
      harnessAuth: {
        ...resolved,
        backendRef: { ...resolved.backendRef, namespaceName: "another-tenant" },
      },
    },
    { harnessAuth: { ...resolved, backendRef: { ...resolved.backendRef, uid: "" } } },
  ]) {
    await assert.rejects(
      fixture.driver.activateRevision(fixture.revision, invalidContext),
      /authentication.*(?:context|source)/i,
    );
  }
  assert.equal(fixture.requests.length, 0, "invalid authentication must fail before Pod readiness");
  for (const items of [
    [],
    [fixture.pod("starting", "False")],
    [fixture.pod("ready"), fixture.pod("starting", "False")],
    [fixture.pod("ready"), fixture.pod("also-ready")],
  ]) {
    fixture.setObservation({ items });
    await assert.rejects(
      fixture.driver.activateRevision(fixture.revision, authContext(fixture.revision)),
      /The exact AgentRevision workload is not ready/,
    );
  }
  fixture.setObservation({ items: [fixture.pod("ready"), null] });
  await assert.rejects(
    fixture.driver.activateRevision(fixture.revision, authContext(fixture.revision)),
    /invalid or incomplete/,
  );
  assert.equal(fixture.requests.length, 5);
});

test("provider Harness requires its assigned network profile before readiness and activation", async () => {
  const fixture = providerReadinessFixture();
  // The provider receives the provider-fenced profile, derived from the ordinary template.
  assert.equal(fixture.labels["openclaw.dev/network-profile"], "provider-fenced-v1");
  fixture.setObservation({ items: [fixture.pod("approved")] });
  assert.equal(await fixture.ready(), true);

  // A provider may preserve identity and report Ready while losing the network
  // classification, or gaining the ordinary one and with it Compute's egress grants.
  // Reject that candidate before activation can change routing.
  for (const profile of [undefined, "", "unknown-profile", "broad-egress-v1"]) {
    const pod = fixture.pod("unapproved");
    if (profile === undefined) {
      delete pod.metadata.labels["openclaw.dev/network-profile"];
    } else {
      pod.metadata.labels["openclaw.dev/network-profile"] = profile;
    }
    fixture.setObservation({ items: [pod] });
    await assert.rejects(fixture.ready(), /invalid or incomplete provider Harness Pod list/);
    await assert.rejects(
      fixture.driver.activateRevision(fixture.revision, authContext(fixture.revision)),
      /invalid or incomplete provider Harness Pod list/,
    );
  }

  // An unclassified template never yields provider requirements.
  for (const profile of [undefined, "", "unknown-profile"]) {
    const unapproved = structuredClone(fixture.deployment);
    const labels = unapproved.spec.template.metadata.labels;
    if (profile === undefined) {
      delete labels["openclaw.dev/network-profile"];
    } else {
      labels["openclaw.dev/network-profile"] = profile;
    }
    assert.throws(
      () => fixture.driver.harnessRequirementsFromDeployment(unapproved, "api_key"),
      /Dedicated Harness requires the ordinary network profile/,
    );
  }
});

test("provider Harness preparation preserves readiness and cleanup contracts", async () => {
  const hooks = [];
  const provisions = [];
  const fixture = providerReadinessFixture({
    async provisionHarness(context) {
      // The provider fences Harness egress; a Compute auth grant would be unioned with it.
      assert.equal(
        objects.has(key("NetworkPolicy", `allow-agent-auth-${digest(context.revision.agentId)}`)),
        false,
        "provider-fenced Harnesses receive no Compute authentication egress",
      );
      assert.ok(
        objects.has(
          key("NetworkPolicy", `allow-agent-runtime-${digest(context.revision.agentId)}`),
        ),
        "the Gateway transport ingress exists before Sandbox startup",
      );
      provisions.push(context);
      return {
        namespaceName: context.namespace.name,
        resourceName: "provider-sandbox",
        agentId: context.revision.agentId,
        revisionId: context.revision.id,
      };
    },
    lifecycleDrivers: [
      {
        id: "configuration-lifecycle",
        capability: "configuration",
        implementation: "conformance-lifecycle",
        computeLifecycleHooks: {
          async beforeWorkloadStart() {
            hooks.push("start");
          },
          async beforeWorkloadStop() {
            hooks.push("stop");
          },
        },
      },
    ],
  });
  const { driver, revision, namespace, core } = fixture;
  const gatewayName = `gateway-${digest(revision.agentId)}`;
  const gatewayOwnership = { namespaceId: tenant.id, agentId: revision.agentId };
  const objects = new Map();
  const key = (kind, name, target = namespace) =>
    `${kind}:${kind === "Namespace" ? "" : target}:${name}`;
  const save = (object) =>
    objects.set(
      key(object.kind, object.metadata.name, object.metadata.namespace),
      structuredClone(object),
    );
  save({
    ...driver.manifest("v1", "Namespace", namespace, { namespaceId: tenant.id }),
    status: { phase: "Active" },
  });
  save({
    ...driver.gatewayNamespaceManifest({ namespaceId: tenant.id }),
    status: { phase: "Active" },
  });
  save({
    ...driver.manifest(
      "v1",
      "Secret",
      `transport-${digest(revision.agentId)}`,
      { namespaceId: tenant.id, agentId: revision.agentId },
      { name: kubernetesGatewayNamespaceName(tenant.id), plane: "control" },
    ),
    type: "Opaque",
    metadata: {
      ...driver.manifest(
        "v1",
        "Secret",
        `transport-${digest(revision.agentId)}`,
        { namespaceId: tenant.id, agentId: revision.agentId },
        { name: kubernetesGatewayNamespaceName(tenant.id), plane: "control" },
      ).metadata,
      uid: "transport-uid",
      resourceVersion: "1",
    },
    data: {
      "app-server-token": Buffer.from("test-transport").toString("base64"),
    },
  });
  save({
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: "occ-model-key",
      namespace: kubernetesGatewayNamespaceName(tenant.id),
      uid: "model-secret-uid",
    },
    data: { value: Buffer.from("fixture-model-key").toString("base64") },
  });
  for (const target of [
    { name: namespace, plane: "execution" },
    { name: kubernetesGatewayNamespaceName(tenant.id), plane: "control" },
  ]) {
    for (const policy of driver.networkPolicies({ namespaceId: tenant.id }, target)) {
      save(policy);
    }
  }
  // Seed an already-ready gateway; the fixture never derives readiness from a write.
  const gateway = driver.deployment(
    gatewayName,
    gatewayOwnership,
    { name: kubernetesGatewayNamespaceName(tenant.id), plane: "control" },
    options().images.gateway,
    gatewayName,
    "gateway",
    {},
    "info",
    driver.gatewayConfiguration(revision, "provider-node", {
      name: kubernetesNamespaceName(tenant.id),
      plane: "execution",
    }),
    false,
    undefined,
    undefined,
    [],
    [],
    driver.pluginRuntimeSnapshot(revision),
  );
  gateway.metadata.generation = 1;
  gateway.status = {
    observedGeneration: 1,
    replicas: 1,
    updatedReplicas: 1,
    readyReplicas: 1,
  };
  save(gateway);
  const clients = {
    core,
    apps: {},
    networking: {},
    objects: {
      async read(object) {
        const value = objects.get(
          key(object.kind, object.metadata.name, object.metadata.namespace),
        );
        if (!value) {
          throw Object.assign(new Error("not found"), { statusCode: 404 });
        }
        return structuredClone(value);
      },
      async patch(object) {
        save(object);
        return object;
      },
    },
    discovery: {
      async listNamespacedEndpointSlice() {
        return {
          items: [
            {
              metadata: {
                labels: { "kubernetes.io/service-name": gatewayName },
                ownerReferences: [
                  { kind: "Service", name: gatewayName, uid: `${gatewayName}-uid` },
                ],
              },
              endpoints: [{ conditions: { ready: true } }],
            },
          ],
        };
      },
    },
  };
  core.readNamespace = async ({ name }) => structuredClone(objects.get(key("Namespace", name)));
  const enrollmentSecret = core.readNamespacedSecret;
  core.readNamespacedSecret = async ({ name, namespace: target }) => {
    if (name === driver.workspaceNodeName(revision)) {
      return enrollmentSecret({ name });
    }
    const value = objects.get(key("Secret", name, target));
    if (!value) {
      throw Object.assign(new Error("not found"), { statusCode: 404 });
    }
    return structuredClone(value);
  };
  core.createNamespacedSecret = core.replaceNamespacedSecret = async ({ body }) => {
    const value = {
      ...body,
      metadata: { ...body.metadata, uid: `${body.metadata.name}-uid`, resourceVersion: "1" },
    };
    save(value);
    return value;
  };
  const writes = [];
  for (const [api, kinds] of [
    [core, ["ConfigMap", "Service", "ServiceAccount", "PersistentVolumeClaim"]],
    [clients.apps, ["Deployment"]],
    [clients.networking, ["NetworkPolicy"]],
  ]) {
    for (const kind of kinds) {
      api[`readNamespaced${kind}`] = async ({ name, namespace: requestedNamespace }) => {
        const object = objects.get(key(kind, name, requestedNamespace));
        if (object === undefined) {
          throw Object.assign(new Error("not found"), { statusCode: 404 });
        }
        return structuredClone(object);
      };
      api[`patchNamespaced${kind}`] = async ({ body, namespace: requestedNamespace }) => {
        assert.equal(requestedNamespace, body.metadata.namespace);
        writes.push(structuredClone(body));
        const previous = objects.get(key(kind, body.metadata.name, body.metadata.namespace));
        if (kind === "Deployment") {
          assert.deepEqual(
            body.spec,
            previous?.spec,
            "fixture readiness requires an unchanged gateway",
          );
        }
        save({ ...previous, ...body, metadata: { ...previous?.metadata, ...body.metadata } });
      };
    }
  }
  driver.apiClients = Promise.resolve(clients);
  const expected = { namespaceId: tenant.id, agentId: revision.agentId, revisionId: revision.id };
  for (const [items, ready] of [
    [[], false],
    [[fixture.pod("starting", "False")], false],
    [[fixture.pod("ready"), fixture.pod("starting", "False")], false],
    [[fixture.pod("ready")], true],
  ]) {
    fixture.setObservation({ items });
    assert.deepEqual(await driver.prepareRevision(revision, authContext(revision)), {
      ...expected,
      ready,
    });
  }
  assert.deepEqual(hooks, ["start", "start", "start", "start"]);
  assert.equal(provisions.length, 4);
  assert.deepEqual(provisions[0].requirements.labels, fixture.labels);
  const agentServiceName = `agent-${digest(revision.agentId)}`;
  assert.equal(
    objects.get(key("Service", agentServiceName)).spec.selector["app.kubernetes.io/name"],
    `${agentServiceName}-inactive`,
  );

  fixture.setObservation({ items: [fixture.pod("ready"), null] });
  await assert.rejects(
    driver.prepareRevision(revision, authContext(revision)),
    /invalid or incomplete/,
  );
  assert.deepEqual(hooks.slice(-2), ["start", "stop"]);
  const writesBeforeActivation = writes.length;
  await assert.rejects(
    driver.activateRevision(revision, authContext(revision)),
    /invalid or incomplete/,
  );
  assert.equal(writes.length, writesBeforeActivation);

  fixture.setObservation({ items: [fixture.pod("ready")] });
  await driver.activateRevision(revision, authContext(revision));
  assert.deepEqual(objects.get(key("Service", agentServiceName)).spec.selector, {
    "openclaw.dev/network-profile": "provider-fenced-v1",
    "openclaw.dev/namespace": revision.namespaceId,
    "openclaw.dev/agent": revision.agentId,
    "openclaw.dev/revision": revision.id,
    "openclaw.dev/workload-role": "agent",
  });
});

test("provider Harness readiness preserves API errors and owner cancellation", async () => {
  const fixture = providerReadinessFixture();
  const denied = Object.assign(new Error("Pod observation denied"), { statusCode: 403 });
  fixture.setObservation(() => {
    throw denied;
  });
  await assert.rejects(fixture.ready(), (error) => error === denied);
  assert.equal(fixture.requests.length, 1);
  const unavailable = Object.assign(new Error("Pod observation unavailable"), { statusCode: 503 });
  fixture.setObservation(() => {
    throw unavailable;
  });
  await assert.rejects(fixture.ready(), (error) => error === unavailable);
  assert.equal(fixture.requests.length, 4);

  const cancellation = new Error("revision observation cancelled");
  const alreadyAborted = new AbortController();
  alreadyAborted.abort(cancellation);
  await assert.rejects(
    withComputeAbortSignal(alreadyAborted.signal, () => fixture.ready()),
    (error) => error === cancellation,
  );
  assert.equal(fixture.requests.length, 4);
  for (const lateSuccess of [false, true]) {
    const owner = new AbortController();
    let release;
    let started;
    const observing = new Promise((resolve) => {
      started = resolve;
    });
    fixture.setObservation(() => {
      const signal = currentComputeAbortSignal();
      started(signal);
      return new Promise((resolve, reject) => {
        release = () => resolve({ items: [fixture.pod("late-ready")] });
        if (!lateSuccess) {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }
      });
    });
    // Manual owner cancellation exercises the driver context; it is not database lease-loss proof.
    const readiness = withComputeAbortSignal(owner.signal, () => fixture.ready());
    const rejected = assert.rejects(readiness, (error) => error === cancellation);
    const requestSignal = await observing;
    owner.abort(cancellation);
    assert.equal(requestSignal.aborted, true);
    if (lateSuccess) {
      release();
    }
    await rejected;
  }
  assert.equal(fixture.requests.length, 6);
});

test("revision lifecycle rejects another driver or missing identity before cluster access", async () => {
  const driver = createKubernetesComputeDriver(options());
  const revision = {
    id: "revision-a-1",
    namespaceId: tenant.id,
    agentId: "agent-a",
    revision: 1,
    configurationId: "cfg_00000000-0000-4000-8000-000000000001",
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration: {
      agents: { defaults: { model: "codex/gpt-5" } },
      gateway: { controlUi: { enabled: false } },
      logging: {
        level: "info",
        consoleLevel: "info",
        consoleStyle: "json",
      },
      diagnostics: { otel: { logs: false } },
    },
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    harnessAuth: apiKeyAuth,
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId: "service-principal-agent-a",
    createdAt: tenant.createdAt,
  };

  for (const provider of ["slack", "msteams"]) {
    for (const configuration of [{ enabled: true }, { accounts: { support: { enabled: true } } }]) {
      await assert.rejects(
        driver.prepareRevision({
          ...revision,
          configuration: { ...revision.configuration, channels: { [provider]: configuration } },
        }),
        /isolated credentials and a reviewed proxy/i,
      );
    }
  }

  for (const invalid of [
    { ...revision, compute: { id: "another-driver", implementation: "another-implementation" } },
    { ...revision, servicePrincipalId: undefined },
    { ...revision, servicePrincipalId: " " },
  ]) {
    assert.deepEqual(await driver.prepareRevision(invalid), {
      namespaceId: tenant.id,
      agentId: revision.agentId,
      revisionId: revision.id,
      ready: false,
    });
  }

  for (const invalid of [
    { ...revision, configurationId: " " },
    { ...revision, configurationKind: "gateway" },
    { ...revision, revision: 0 },
    { ...revision, configurationGeneration: 0 },
    { ...revision, configurationGeneration: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    // Reject incompatible immutable snapshots before touching an Agent's Kubernetes resources.
    await assert.rejects(driver.prepareRevision(invalid), /Configuration/i);
  }

  for (const harness of [
    { id: "codex", version: "1.0.0", mode: "embedded" },
    { id: "codex", version: "1.0.0" },
    { id: "codex", version: "1.0.0", mode: "remote" },
  ]) {
    // Invalid explicit topology must fail before a missing kubeconfig can touch cluster resources.
    await assert.rejects(driver.prepareRevision({ ...revision, harness }), /Harness|topology/i);
  }

  const production = new KubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
        channels: { proxyUrl: "http://10.42.0.15:3128" },
      },
      servicePrincipalCredentials: {
        mode: "projectedServiceAccountToken",
        audience: "openclaw-controller",
        expirationSeconds: 900,
      },
    }),
    {
      sandboxDriver: {
        id: "sandbox-native-worker",
        implementation: "test/native-worker",
        capability: "sandbox",
        facets: ["networking", "filesystem", "process"],
        async provisionHarness() {},
        async cleanup() {},
      },
    },
  );
  const dedicatedNativeConfiguration = createHarnessConfiguration("openclaw", "gpt-5");
  assert.doesNotThrow(() =>
    production.validateHarnessAuth(
      { id: "openclaw", version: "1.0.0", mode: "dedicated" },
      apiKeyAuth,
      dedicatedNativeConfiguration,
    ),
  );
  assert.throws(
    () =>
      production.validateHarnessAuth(
        { id: "openclaw", version: "1.0.0", mode: "dedicated" },
        apiKeyAuth,
        {
          ...dedicatedNativeConfiguration,
          models: {
            providers: {
              openai: {
                ...dedicatedNativeConfiguration.models.providers.openai,
                models: [{ id: "gpt-5", contextWindow: 128000, maxTokens: 8192 }],
              },
            },
          },
        },
      ),
    /cost metadata/,
  );
  assert.throws(
    () =>
      production.validateHarnessAuth(
        { id: "openclaw", version: "1.0.0", mode: "dedicated" },
        apiKeyAuth,
        {
          ...dedicatedNativeConfiguration,
          models: {
            providers: {
              openai: {
                ...dedicatedNativeConfiguration.models.providers.openai,
                baseUrl: "https://models.example.test/v1",
              },
            },
          },
        },
      ),
    /approved OpenAI API endpoint/,
  );
  const serviceAccountId = "sa_00000000-0000-4000-8000-000000000001";
  const serviceAccount = {
    method: "chatgpt_service_account",
    serviceAccountId,
    backendBinding: {
      backendId: "provider-chatgpt",
      driverId: "chatgpt",
      workspaceId: "ws_1",
      credentialIssued: true,
    },
    credential: {
      kind: "access_token",
      secretRef: {
        name: `service-account-${createHash("sha256")
          .update(serviceAccountId)
          .digest("hex")
          .slice(0, 32)}`,
        key: "token",
      },
    },
  };
  const accessTokenRevision = {
    ...revision,
    compute: { id: production.id, implementation: production.implementation },
    harnessAuth: serviceAccount,
  };

  // Operator credentials do not weaken either managed Kubernetes topology.
  for (const mode of ["embedded", "dedicated"]) {
    await assert.rejects(
      production.prepareRevision({
        ...accessTokenRevision,
        harness: { id: mode === "embedded" ? "openclaw" : "codex", version: "1.0.0", mode },
        harnessAuth: { method: "runtime" },
      }),
      /incompatible.*topology/i,
    );
  }
  // Unsupported access-token execution and cross-account references fail before cluster access.
  await assert.rejects(
    production.prepareRevision({
      ...accessTokenRevision,
      harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    }),
    /incompatible.*topology/i,
  );
  for (const secretRef of [
    { ...serviceAccount.credential.secretRef, name: "service-account-another" },
    { ...serviceAccount.credential.secretRef, key: "another-key" },
  ]) {
    await assert.rejects(
      production.prepareRevision({
        ...accessTokenRevision,
        harnessAuth: {
          ...serviceAccount,
          credential: { ...serviceAccount.credential, secretRef },
        },
      }),
      /admitted account/i,
    );
  }
  const embeddedRevision = {
    ...revision,
    compute: { id: production.id, implementation: production.implementation },
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    harnessAuth: apiKeyAuth,
    configuration: { ...revision.configuration, agents: { defaults: { model: "openai/gpt-5" } } },
  };
  // Admission must retain supported model choices without permitting a second credential selector.
  for (const model of ["codex/gpt-5", "openai/gpt-5"]) {
    const configuration = { agents: { defaults: { model } } };
    assert.doesNotThrow(() =>
      production.validateHarnessAuth(revision.harness, apiKeyAuth, configuration),
    );
    assert.equal(configuration.agents.defaults.model, model);
  }
  for (const apiKey of [
    "plaintext-fixture",
    "${ANOTHER_API_KEY}",
    { source: "env", provider: "model", id: "ANOTHER_API_KEY" },
    { source: "store", provider: "model", id: "OPENAI_API_KEY" },
  ]) {
    await assert.rejects(
      production.prepareRevision({
        ...embeddedRevision,
        configuration: {
          ...embeddedRevision.configuration,
          models: { providers: { openai: { apiKey } } },
        },
      }),
      /credentials must use.*binding/i,
    );
  }
  for (const apiKey of [
    "${OPENAI_API_KEY}",
    { source: "env", provider: "model", id: "OPENAI_API_KEY" },
  ]) {
    assert.doesNotThrow(() =>
      production.validateHarnessAuth(embeddedRevision.harness, apiKeyAuth, {
        ...embeddedRevision.configuration,
        secrets: { providers: { model: { source: "env", allowlist: ["OPENAI_API_KEY"] } } },
        models: { providers: { openai: { apiKey } } },
      }),
    );
  }
  for (const transport of [
    { baseUrl: "${PROVIDER_URL}" },
    { headers: { "x-provider-feature": "${HEADER}" } },
    { headers: { "x-provider-feature": { source: "env", provider: "model", id: "HEADER" } } },
  ]) {
    await assert.rejects(
      production.prepareRevision({
        ...embeddedRevision,
        configuration: {
          ...embeddedRevision.configuration,
          models: { providers: { openai: { apiKey: "${OPENAI_API_KEY}", ...transport } } },
        },
      }),
      /transport configuration cannot require additional Secret or environment references/i,
    );
  }
  for (const conflicting of [
    { auth: { profiles: { alternate: { provider: "openai", mode: "api_key" } } } },
    { env: { OPENAI_API_KEY: "plaintext-fixture" } },
    { env: { vars: { OPENAI_API_KEY: "plaintext-fixture" } } },
    { models: { providers: { openai: { headers: { Authorization: "Bearer fixture" } } } } },
  ]) {
    await assert.rejects(
      production.prepareRevision({
        ...embeddedRevision,
        configuration: { ...embeddedRevision.configuration, ...conflicting },
      }),
      /credentials must use.*binding/i,
    );
  }
  // Channel credentials must never enter the combined embedded Agent and gateway workload.
  for (const provider of ["slack", "msteams"]) {
    await assert.rejects(
      production.prepareRevision({
        ...embeddedRevision,
        configuration: {
          ...embeddedRevision.configuration,
          channels: { [provider]: { enabled: true } },
        },
      }),
      /channels require a dedicated Agent workload\./i,
    );
  }
  const namespace = kubernetesNamespaceName(tenant.id);
  const agentHash = createHash("sha256").update(revision.agentId).digest("hex");
  const gateway = production.deployment(
    `gateway-${agentHash.slice(0, 12)}`,
    { namespaceId: tenant.id, agentId: revision.agentId },
    { name: namespace, plane: "execution" },
    "openclaw-enterprise/gateway-fixture:local",
    `agent-${agentHash.slice(0, 12)}`,
    "gateway",
    {},
    production.gatewayConfiguration(embeddedRevision).loggingLevel,
    production.gatewayConfiguration(embeddedRevision),
    true,
    revision.servicePrincipalId,
    preparedAuth(production, namespace, true),
  );
  const pod = gateway.spec.template.spec;
  const environment = Object.fromEntries(pod.containers[0].env.map((entry) => [entry.name, entry]));

  // The approved combined Agent workload receives only its own projected identity and model Secret.
  assert.equal(pod.serviceAccountName, `agent-${agentHash.slice(0, 12)}`);
  assert.ok(pod.volumes.some(({ name }) => name === "openclaw-service-principal"));
  assert.deepEqual(environment.OPENAI_API_KEY.valueFrom.secretKeyRef, {
    name: "occ-model-key",
    key: "value",
  });
  assert.equal(environment.HOME.value, "/home/node");
  assert.equal(environment.APP_SERVER_TOKEN, undefined);
  assert.equal(environment.APP_SERVER_URL, undefined);

  const policies = production
    .agentNetworkPolicies(embeddedRevision, {
      name: namespace,
      plane: "execution",
    })
    .map(({ resource }) => resource);
  assert.equal(policies.length, 1);
  assert.deepEqual(policies[0].spec.podSelector.matchLabels, {
    "openclaw.dev/namespace": tenant.id,
    "openclaw.dev/workload-role": "gateway",
    "openclaw.dev/agent": revision.agentId,
    "openclaw.dev/network-profile": "broad-egress-v1",
  });
  assert.deepEqual(policies[0].spec.policyTypes, ["Egress"]);
  assert.deepEqual(policies[0].spec.egress[0].ports, [{ protocol: "TCP", port: 443 }]);

  await assert.rejects(
    driver.retireRevision({
      ...revision,
      compute: { id: "another-driver", implementation: "another-implementation" },
    }),
    /another Compute Driver/i,
  );
  await assert.rejects(
    driver.stopRevision({
      ...revision,
      compute: { id: "another-driver", implementation: "another-implementation" },
    }),
    /another Compute Driver/i,
  );
});

// options() shares one resource object across roles; give each role its own.
function separateResources() {
  const configured = options();
  const { gateway, agent, namespace } = configured.resources;
  configured.resources = {
    gateway: structuredClone(gateway),
    agent: structuredClone(agent),
    namespace: {
      quota: structuredClone(namespace.quota),
      containerDefaults: structuredClone(namespace.containerDefaults),
    },
  };
  return configured;
}

test("resource quantities written as bare numbers name the field and the quoting fix", () => {
  const cases = [
    ["gateway", "limits", "cpu", 4, /Gateway CPU limit \(resources\.gateway\.limits\.cpu\)/],
    ["agent", "limits", "cpu", 1, /Agent CPU limit \(resources\.agent\.limits\.cpu\)/],
    ["agent", "requests", "cpu", 0.5, /Agent CPU request \(resources\.agent\.requests\.cpu\)/],
  ];
  for (const [role, kind, field, value, name] of cases) {
    const configured = separateResources();
    configured.resources[role][kind][field] = value;
    assert.throws(() => KubernetesComputeDriver.validateConfiguration(configured), name);
    assert.throws(
      () => KubernetesComputeDriver.validateConfiguration(configured),
      new RegExp(`must be a quoted Kubernetes quantity string: write "${value}", not ${value}\\.`),
    );
  }
  const defaults = separateResources();
  defaults.resources.namespace.containerDefaults.limits.cpu = 4;
  assert.throws(
    () => KubernetesComputeDriver.validateConfiguration(defaults),
    /Namespace default CPU limit \(resources\.namespace\.containerDefaults\.limits\.cpu\) must be a quoted/,
  );
  const quota = separateResources();
  quota.resources.namespace.quota.pods = 10;
  assert.throws(
    () => KubernetesComputeDriver.validateConfiguration(quota),
    /Quota pods \(resources\.namespace\.quota\.pods\) must be a quoted/,
  );
  // A missing value is still reported as missing, and quoted cores pass.
  const missing = separateResources();
  delete missing.resources.gateway.limits.cpu;
  assert.throws(
    () => KubernetesComputeDriver.validateConfiguration(missing),
    /Gateway CPU limit must be explicitly configured/,
  );
  const quoted = separateResources();
  quoted.resources.gateway.limits.cpu = "4";
  KubernetesComputeDriver.validateConfiguration(quoted);
});

test("real gateways require an explicit SQLite-compatible storage class", () => {
  for (const gatewayStorageClassName of [undefined, "", " "]) {
    assert.throws(
      () =>
        createKubernetesComputeDriver(
          options({
            runtime: {
              transportSecretPrefix: "transport",
              gatewayStorageClassName,
            },
          }),
        ),
      /SQLite-compatible gateway storage class must be explicitly configured/,
    );
  }
});

test("Gateway and Harness storage are separate and preserve ephemeral Codex credentials", () => {
  const driver = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
      },
    }),
  );
  const agentId = "agent-private-storage";
  const ownership = { namespaceId: tenant.id, agentId };
  const namespace = kubernetesNamespaceName(tenant.id);
  const claim = driver.gatewayPrivateStateClaim(agentId, ownership, {
    name: namespace,
    plane: "execution",
  });
  assert.deepEqual(claim.spec, {
    accessModes: ["ReadWriteOnce"],
    volumeMode: "Filesystem",
    storageClassName: "local-path",
    resources: { requests: { storage: "10Gi" } },
  });
  assert.equal(claim.metadata.annotations["openclaw.dev/agent-id"], agentId);
  assert.equal(claim.metadata.annotations["openclaw.dev/namespace-id"], tenant.id);
  assert.equal(claim.metadata.annotations["openclaw.dev/revision-id"], undefined);
  assert.notEqual(
    claim.metadata.name,
    driver.gatewayPrivateStateClaim(
      "another-agent",
      { ...ownership, agentId: "another-agent" },
      { name: namespace, plane: "execution" },
    ).metadata.name,
  );
  assert.notEqual(
    claim.metadata.name,
    driver.harnessWorkspaceClaim(agentId, ownership, { name: namespace, plane: "execution" })
      .metadata.name,
  );

  // Whole directories retain SQLite WAL/SHM siblings; only the gateway receives the private claim.
  for (const embedded of [false, true]) {
    const gateway = driver.deployment(
      "gateway",
      ownership,
      { name: namespace, plane: "execution" },
      "gateway:local",
      "gateway",
      "gateway",
      {},
      "info",
      driver.gatewayConfiguration(
        routedRevision(driver, { agentId: ownership.agentId }),
        undefined,
        { name: namespace, plane: "execution" },
      ),
      embedded,
      undefined,
      preparedAuth(driver, namespace, embedded),
    );
    const pod = gateway.spec.template.spec;
    assert.equal(pod.terminationGracePeriodSeconds, 330);
    assert.deepEqual(pod.nodeSelector, embedded ? undefined : { "oce-role": "control-plane" });
    const privateVolume = pod.volumes.find(({ name }) => name === "openclaw-gateway-state");
    assert.deepEqual(privateVolume.persistentVolumeClaim, { claimName: claim.metadata.name });
    assert.deepEqual(
      pod.containers[0].volumeMounts.filter(({ name }) => name === privateVolume.name),
      [
        {
          name: privateVolume.name,
          mountPath: "/home/node/.openclaw/state",
          subPath: "state",
          readOnly: false,
        },
        {
          name: privateVolume.name,
          mountPath: "/home/node/.openclaw/agents/main/agent",
          subPath: "agent",
          readOnly: false,
        },
        {
          name: privateVolume.name,
          mountPath: "/home/node/.openclaw/media",
          subPath: "media",
          readOnly: false,
        },
        ...(!embedded
          ? [
              {
                name: privateVolume.name,
                mountPath: "/home/node/.openclaw/agents/main/sessions",
                subPath: "sessions",
                readOnly: false,
              },
            ]
          : []),
        ...(embedded
          ? [
              {
                name: privateVolume.name,
                mountPath: "/home/node/.openclaw/workspace",
                subPath: "workspace",
                readOnly: false,
              },
            ]
          : []),
      ],
    );
    if (embedded) {
      // Revision replacement must reuse the attested workspace, not merely preserve its SQLite row.
      const replacement = driver.deployment(
        "gateway",
        ownership,
        { name: namespace, plane: "execution" },
        "gateway:local",
        "gateway",
        "gateway",
        {},
        "info",
        {
          name: "configuration-2",
          revision: 2,
          revisionId: "revision-2",
          annotations: {},
          loggingLevel: "info",
        },
        true,
        undefined,
        preparedAuth(driver, namespace, true),
      ).spec.template.spec;
      assert.deepEqual(
        replacement.volumes.find(({ name }) => name === privateVolume.name),
        privateVolume,
      );
      assert.deepEqual(
        replacement.containers[0].volumeMounts.find(({ subPath }) => subPath === "workspace"),
        pod.containers[0].volumeMounts.find(({ subPath }) => subPath === "workspace"),
      );
    }
    assert.deepEqual(
      pod.containers[0].volumeMounts.find(({ mountPath }) =>
        mountPath.endsWith("/agent/codex-home"),
      ),
      {
        name: "runtime-state",
        mountPath: "/home/node/.openclaw/agents/main/agent/codex-home",
        subPath: "home/gateway-codex-home",
      },
    );
    assert.deepEqual(pod.initContainers[0].volumeMounts, [
      { name: "runtime-state", mountPath: "/runtime-state" },
      { name: "runtime-temporary", mountPath: "/runtime-temporary" },
      { name: privateVolume.name, mountPath: "/gateway-state" },
    ]);
    assert.deepEqual(
      pod.containers[0].volumeMounts.find(({ mountPath }) => mountPath === "/home/node"),
      { name: "runtime-state", mountPath: "/home/node", subPath: "home" },
    );
    assert.deepEqual(
      pod.containers[0].volumeMounts.find(({ mountPath }) => mountPath === "/tmp"),
      { name: "runtime-temporary", mountPath: "/tmp", subPath: "tmp" },
    );
    assert.equal(pod.initContainers[0].args[0].includes("/runtime-state/home"), true);
    assert.equal(pod.initContainers[0].args[0].includes("/runtime-temporary/tmp"), true);
    assert.equal(pod.initContainers[0].env, undefined);
    assert.equal(pod.securityContext.runAsUser, 1000);
    assert.equal(pod.securityContext.fsGroup, 1000);
    // Cloud block disks otherwise chown the whole claim recursively on every Gateway start.
    assert.equal(pod.securityContext.fsGroupChangePolicy, "OnRootMismatch");
    assert.equal(gateway.spec.strategy.type, "Recreate");
    assert.equal(
      pod.volumes.some(({ name }) => name === "openclaw-workspace"),
      false,
    );
  }
  const harness = driver.deployment(
    "agent",
    { ...ownership, revisionId: "revision-render" },
    { name: namespace, plane: "execution" },
    "agent:local",
    "agent",
    "agent",
    {},
    "info",
    undefined,
    undefined,
    undefined,
    preparedAuth(driver, namespace, false),
  );
  assert.equal(JSON.stringify(harness).includes(claim.metadata.name), false);
  assert.equal(JSON.stringify(harness).includes("openclaw-gateway-state"), false);
  assert.equal(harness.spec.template.spec.securityContext.fsGroup, 1000);
  assert.equal(harness.spec.template.spec.securityContext.fsGroupChangePolicy, "OnRootMismatch");
  // The Harness retains task files, generated images and Codex thread rollouts, so
  // the Gateway's bound thread resumes after stop/start; it cannot mount Gateway transcripts.
  const workspaceMounts = harness.spec.template.spec.containers[0].volumeMounts.filter(
    ({ name }) => name === "openclaw-workspace",
  );
  assert.deepEqual(workspaceMounts, [
    {
      name: "openclaw-workspace",
      mountPath: "/home/node/workspace",
      subPath: "workspace",
      readOnly: false,
    },
    {
      name: "openclaw-workspace",
      mountPath: "/home/node/.codex/generated_images",
      subPath: "generated-images",
      readOnly: false,
    },
    {
      name: "openclaw-workspace",
      mountPath: "/home/node/.codex/sessions",
      subPath: "codex-sessions",
      readOnly: false,
    },
  ]);
  const initialState = harness.spec.template.spec.initContainers[0];
  assert.deepEqual(initialState.volumeMounts, [
    { name: "runtime-state", mountPath: "/runtime-state" },
    { name: "runtime-temporary", mountPath: "/runtime-temporary" },
    { name: "openclaw-workspace", mountPath: "/harness-workspace-state" },
  ]);
  assert.deepEqual(
    harness.spec.template.spec.containers[0].volumeMounts.find(
      ({ mountPath }) => mountPath === "/home/node",
    ),
    { name: "runtime-state", mountPath: "/home/node", subPath: "home" },
  );
  assert.deepEqual(
    harness.spec.template.spec.containers[0].volumeMounts.find(
      ({ mountPath }) => mountPath === "/tmp",
    ),
    { name: "runtime-temporary", mountPath: "/tmp", subPath: "tmp" },
  );
  assert.equal(initialState.args[0].includes("/runtime-state/home"), true);
  assert.equal(initialState.args[0].includes("/runtime-temporary/tmp"), true);
  assert.match(initialState.args[0], /chmodSync\(path, 0o700\)/);
  for (const directory of ["workspace", "generated-images", "codex-sessions"]) {
    assert.equal(initialState.args[0].includes(`/harness-workspace-state/${directory}`), true);
  }
  // Pod and AgentRevision replacement keep node credentials in one Agent
  // directory on the same Harness claim, outside task files and Gateway state.
  const revision = {
    agentId: ownership.agentId,
    id: "revision-node-state",
    harness: { id: "openclaw", mode: "dedicated" },
    configuration: {},
  };
  const withNode = (candidate) => {
    const workload = structuredClone(harness);
    driver.addWorkspaceNode(workload, driver.workspaceNodeName(candidate), undefined, candidate);
    const pod = workload.spec.template.spec;
    // The node-state claim keeps the Harness policy: ownership is fixed only on a root mismatch.
    assert.deepEqual(pod.securityContext, harness.spec.template.spec.securityContext);
    return driver.sandboxWorkspaceMounts(pod.volumes, pod.containers[0].volumeMounts);
  };
  const mounts = withNode(revision);
  const initializedHarness = structuredClone(harness);
  driver.addWorkspaceNode(
    initializedHarness,
    driver.workspaceNodeName(revision),
    undefined,
    revision,
  );
  const initialization = initializedHarness.spec.template.spec.initContainers[0].args[0];
  assert.match(initialization, /chmodSync\(path, 0o700\)/);
  assert.equal(
    initialization.includes(`/workspace-node-state/${driver.workspaceNodeName(revision)}`),
    true,
  );
  const node = mounts.find(({ mountPath }) => mountPath === "/home/node/.openclaw-node");
  assert.equal(new Set(mounts.map(({ claimName }) => claimName)).size, 1);
  assert.equal(node.readOnly, false);
  assert.equal(node.subPath.includes("/"), false);
  assert.deepEqual(withNode(revision), mounts);
  assert.deepEqual(withNode({ ...revision, id: "replacement-node-state" }), mounts);
  const otherHarness = withNode({ ...revision, harness: { id: "codex", mode: "dedicated" } });
  assert.notEqual(otherHarness.at(-1).subPath, node.subPath);
  assert.deepEqual(otherHarness.slice(0, -1), mounts.slice(0, -1));
});

test("runtime node selector schedules gateways and their private-state initialization together", () => {
  const driver = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
        nodeSelector: { "oce-role": "agents", "topology.kubernetes.io/zone": "us-east-2a" },
      },
    }),
  );
  const namespace = kubernetesNamespaceName(tenant.id);
  const gateway = driver.deployment(
    "gateway",
    { namespaceId: tenant.id, agentId: "agent-node-selector" },
    { name: namespace, plane: "execution" },
    "gateway:local",
    "gateway",
    "gateway",
    {},
    "info",
    driver.gatewayConfiguration(
      routedRevision(driver, {
        agentId: { namespaceId: tenant.id, agentId: "agent-node-selector" }.agentId,
      }),
      undefined,
      { name: namespace, plane: "execution" },
    ),
    false,
    undefined,
    preparedAuth(driver, namespace, false),
  );
  const pod = gateway.spec.template.spec;

  assert.deepEqual(pod.nodeSelector, {
    "oce-role": "control-plane",
  });
  assert.equal(pod.initContainers[0].name, "prepare-private-state");
});

test("Harness claim reuse retains owned RWO storage without mutation and rejects RWX, foreign or invalid claims", async () => {
  const driver = createKubernetesComputeDriver(options());
  const ownership = { namespaceId: tenant.id, agentId: "agent-workspace-ownership" };
  const namespace = { name: kubernetesNamespaceName(tenant.id), plane: "execution" };
  const desired = driver.harnessWorkspaceClaim(ownership.agentId, ownership, namespace);
  let observed;
  const mutations = [];
  driver.apiClients = Promise.resolve({
    core: {
      async readNamespacedPersistentVolumeClaim() {
        return structuredClone(observed);
      },
      async patchNamespacedPersistentVolumeClaim(request) {
        mutations.push(request);
      },
      async deleteNamespacedPersistentVolumeClaim(request) {
        mutations.push(request);
      },
    },
  });
  observed = structuredClone(desired);
  observed.metadata.uid = "retained-workspace";
  await driver.reconcile(desired, ownership, namespace);
  assert.deepEqual(mutations, [], "compatible workspace claims must never be patched or replaced");
  for (const mutate of [
    (claim) => {
      claim.spec.accessModes = ["ReadWriteMany"];
    },
    (claim) => {
      claim.spec.accessModes = ["ReadWriteOnce", "ReadWriteMany"];
    },
    (claim) => {
      claim.metadata.annotations["openclaw.dev/agent-id"] = "foreign";
    },
    (claim) => {
      claim.spec.accessModes = ["ReadOnlyMany"];
    },
    (claim) => {
      claim.spec.volumeMode = "Block";
    },
    (claim) => {
      claim.spec.resources.requests.storage = "1Gi";
    },
  ]) {
    const valid = structuredClone(observed);
    mutate(observed);
    await assert.rejects(driver.reconcile(desired, ownership, namespace), /Refusing/);
    // Reuse and final deletion enforce the same storage contract. Neither may
    // modify an unsupported or foreign claim.
    await assert.rejects(driver.deleteHarnessWorkspaceClaim(ownership, namespace), /Refusing/);
    assert.deepEqual(mutations, []);
    observed = valid;
  }
  await driver.deleteHarnessWorkspaceClaim(ownership, namespace);
  assert.deepEqual(mutations.pop().body.preconditions, { uid: "retained-workspace" });
});

test("private gateway claim reuse and deletion verify exact ownership and storage before mutation", async () => {
  const driver = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
      },
    }),
  );
  const agentId = "agent-claim-ownership";
  const ownership = { namespaceId: tenant.id, agentId };
  const namespace = kubernetesNamespaceName(tenant.id);
  const desired = driver.gatewayPrivateStateClaim(agentId, ownership, {
    name: namespace,
    plane: "execution",
  });
  let observed = {
    ...structuredClone(desired),
    metadata: { ...desired.metadata, uid: "claim-uid" },
  };
  const mutations = [];
  driver.apiClients = Promise.resolve({
    core: {
      async readNamespacedPersistentVolumeClaim() {
        if (observed === undefined) {
          throw Object.assign(new Error("Not found"), { code: 404 });
        }
        return structuredClone(observed);
      },
      async patchNamespacedPersistentVolumeClaim(request) {
        mutations.push(["patch", request]);
      },
      async deleteNamespacedPersistentVolumeClaim(request) {
        mutations.push(["delete", request]);
      },
    },
  });
  const valid = structuredClone(observed);
  // An already owned, compatible claim is reused without applying mutable revision state.
  await driver.reconcile(desired, ownership, { name: namespace, plane: "execution" });
  assert.deepEqual(mutations, []);
  for (const mutate of [
    (claim) => {
      claim.metadata.labels["openclaw.dev/agent"] = "another-agent";
    },
    (claim) => {
      claim.metadata.annotations["openclaw.dev/namespace-id"] = "another-namespace";
    },
    (claim) => {
      claim.spec.accessModes = ["ReadWriteMany"];
    },
    (claim) => {
      claim.spec.volumeMode = "Block";
    },
    (claim) => {
      claim.spec.storageClassName = "network-filesystem";
    },
    (claim) => {
      claim.spec.resources.requests.storage = "40Gi";
    },
  ]) {
    observed = structuredClone(valid);
    mutate(observed);
    await assert.rejects(
      driver.reconcile(desired, ownership, { name: namespace, plane: "execution" }),
      /Refusing/,
    );
    await assert.rejects(
      driver.deleteGatewayPrivateStateClaim(ownership, { name: namespace, plane: "execution" }),
      /Refusing/,
    );
    assert.deepEqual(mutations, []);
  }
  observed = structuredClone(valid);
  delete observed.metadata.uid;
  await assert.rejects(
    driver.deleteGatewayPrivateStateClaim(ownership, { name: namespace, plane: "execution" }),
    /UID must be explicitly/,
  );
  assert.deepEqual(mutations, []);
  observed = structuredClone(valid);
  await driver.deleteGatewayPrivateStateClaim(ownership, { name: namespace, plane: "execution" });
  assert.deepEqual(mutations, [
    [
      "delete",
      {
        name: desired.metadata.name,
        namespace,
        body: { preconditions: { uid: "claim-uid" } },
      },
    ],
  ]);
  observed = undefined;
  await driver.deleteGatewayPrivateStateClaim(ownership, { name: namespace, plane: "execution" });
  assert.equal(mutations.length, 1);
});

test("stopping a Kubernetes revision and retiring its predecessor retains Agent storage", async () => {
  const driver = createKubernetesComputeDriver(
    routedOptions({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
      },
    }),
  );
  const agentId = "agent-stop-storage";
  const revisionId = "revision-stop-storage";
  const ownership = { namespaceId: tenant.id, agentId };
  const namespace = kubernetesNamespaceName(tenant.id);
  const gatewayName = "gateway-" + createHash("sha256").update(agentId).digest("hex").slice(0, 12);
  const revision = routedRevision(driver, {
    id: revisionId,
    revision: 2,
    agentId,
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    harnessAuth: apiKeyAuth,
  });
  const namespaceResource = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: namespace,
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace": tenant.id,
      },
      annotations: { "openclaw.dev/namespace-id": tenant.id },
    },
  };
  const gateway = driver.manifest("apps/v1", "Deployment", gatewayName, ownership, {
    name: namespace,
    plane: "execution",
  });
  gateway.metadata.uid = "gateway-uid";
  gateway.metadata.resourceVersion = "1";
  gateway.metadata.annotations["openclaw.dev/agent-revision-id"] = revisionId;
  const service = driver.service(
    gatewayName,
    ownership,
    { name: namespace, plane: "execution" },
    {
      "app.kubernetes.io/name": gatewayName,
    },
  );
  service.metadata.uid = "service-uid";
  const account = driver.manifest("v1", "ServiceAccount", gatewayName, ownership, {
    name: namespace,
    plane: "execution",
  });
  account.metadata.uid = "account-uid";
  const route = driver.gatewayRoute(
    { id: revisionId, revision: 2, namespaceId: tenant.id, agentId },
    ownership,
    { name: namespace, plane: "execution" },
    service,
  );
  route.metadata.uid = "route-uid";
  route.metadata.resourceVersion = "1";
  const privateClaim = driver.gatewayPrivateStateClaim(agentId, ownership, {
    name: namespace,
    plane: "execution",
  });
  privateClaim.metadata.uid = "private-state-uid";
  const deletions = [];
  let privateClaimDeleted = false;
  let serviceDeleted = false;
  let accountDeleted = false;
  let gatewayDeleted = false;
  let routeDeleted = false;
  let failServiceDelete = true;
  let gatewayPodObservations = 0;
  const gatewayPod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "stopped-gateway-pod",
      namespace,
      labels: {
        "openclaw.dev/namespace": tenant.id,
        "openclaw.dev/agent": agentId,
        "openclaw.dev/revision": revisionId,
        "openclaw.dev/workload-role": "gateway",
      },
    },
  };
  driver.apiClients = Promise.resolve({
    apps: {
      async readNamespacedDeployment({ name }) {
        if (name !== gatewayName || gatewayDeleted) {
          throw Object.assign(new Error("Not found"), { code: 404 });
        }
        return structuredClone(gateway);
      },
      async deleteNamespacedDeployment(request) {
        deletions.push(["Deployment", request]);
        gatewayDeleted = true;
      },
    },
    core: {
      async readNamespacedSecret() {
        throw Object.assign(new Error("Not found"), { statusCode: 404 });
      },
      async listNamespace() {
        return { apiVersion: "v1", kind: "NamespaceList", items: [namespaceResource] };
      },
      async readNamespace({ name }) {
        if (name === kubernetesGatewayNamespaceName(tenant.id)) {
          return {
            ...driver.gatewayNamespaceManifest({ namespaceId: tenant.id }),
            status: { phase: "Active" },
          };
        }
        return structuredClone(namespaceResource);
      },
      async listNamespacedPod() {
        assert.equal(gatewayDeleted, true);
        gatewayPodObservations += 1;
        return {
          apiVersion: "v1",
          kind: "PodList",
          items: gatewayPodObservations === 1 ? [structuredClone(gatewayPod)] : [],
        };
      },
      async readNamespacedService({ name }) {
        if (name !== gatewayName || serviceDeleted) {
          throw Object.assign(new Error("Not found"), { code: 404 });
        }
        return structuredClone(service);
      },
      async deleteNamespacedService(request) {
        deletions.push(["Service", request]);
        if (failServiceDelete) {
          failServiceDelete = false;
          throw new Error("service delete failed");
        }
        serviceDeleted = true;
      },
      async readNamespacedServiceAccount({ name }) {
        if (name !== gatewayName || accountDeleted) {
          throw Object.assign(new Error("Not found"), { code: 404 });
        }
        return structuredClone(account);
      },
      async deleteNamespacedServiceAccount(request) {
        deletions.push(["ServiceAccount", request]);
        accountDeleted = true;
      },
      async readNamespacedPersistentVolumeClaim({ name }) {
        assert.equal(name, privateClaim.metadata.name);
        return structuredClone(privateClaim);
      },
      async deleteNamespacedPersistentVolumeClaim(request) {
        deletions.push(["PersistentVolumeClaim", request]);
        privateClaimDeleted = true;
      },
      async readNamespacedConfigMap() {
        throw Object.assign(new Error("Not found"), { code: 404 });
      },
    },
    networking: {
      async readNamespacedNetworkPolicy() {
        throw Object.assign(new Error("Not found"), { code: 404 });
      },
    },
    objects: {
      async read({ kind, metadata }) {
        if (routeDeleted || kind !== route.kind || metadata.name !== route.metadata.name) {
          throw Object.assign(new Error("Not found"), { code: 404 });
        }
        return structuredClone(route);
      },
      async delete(spec, _pretty, _dryRun, _grace, _orphan, _propagation, body) {
        deletions.push(["HTTPRoute", { spec, body }]);
        routeDeleted = true;
      },
    },
  });

  // A failed shared cleanup must retry after the exact route and Deployment are absent.
  await assert.rejects(driver.stopRevision(revision), /service delete failed/);
  await driver.stopRevision(revision);
  assert.deepEqual(
    deletions.map(([kind]) => kind),
    ["HTTPRoute", "Deployment", "Service", "Service", "ServiceAccount"],
  );
  assert.equal(gatewayPodObservations, 2);

  // The worker stops the published revision before retiring predecessors. A missing
  // gateway after stop does not make Agent-owned durable state revision garbage.
  const predecessor = { ...revision, id: "revision-stop-storage-predecessor", revision: 1 };
  await driver.retireRevision(predecessor);
  assert.equal(privateClaimDeleted, false, "stopping and retiring must retain native Agent state");
});

for (const cutover of ["already deployed", "during Deployment deletion", "during route deletion"]) {
  test(`stopping a predecessor preserves its replacement ${cutover}`, async () => {
    const driver = createKubernetesComputeDriver(routedOptions());
    const revision = routedRevision(driver, {
      harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    });
    const namespace = kubernetesNamespaceName(tenant.id);
    const name = `gateway-${digest(revision.agentId)}`;
    const ownership = { namespaceId: tenant.id, agentId: revision.agentId };
    const namespaceResource = driver.manifest("v1", "Namespace", namespace, {
      namespaceId: tenant.id,
    });
    const gateway = driver.manifest("apps/v1", "Deployment", name, ownership, {
      name: namespace,
      plane: "execution",
    });
    gateway.metadata.annotations["openclaw.dev/agent-revision-id"] = revision.id;
    const service = driver.service(
      name,
      ownership,
      { name: namespace, plane: "execution" },
      {
        "app.kubernetes.io/name": name,
      },
    );
    const account = driver.manifest("v1", "ServiceAccount", name, ownership, {
      name: namespace,
      plane: "execution",
    });
    const route = driver.gatewayRoute(
      revision,
      ownership,
      { name: namespace, plane: "execution" },
      service,
    );
    const resources = new Map();
    for (const resource of [gateway, service, account, route]) {
      resource.metadata.uid = `${resource.kind}-uid`;
      resource.metadata.resourceVersion = "1";
      resources.set(resource.kind, resource);
    }
    const advance = (resource) => {
      resource.metadata.annotations["openclaw.dev/agent-revision-id"] = "replacement-revision";
      resource.metadata.resourceVersion = "2";
    };
    if (cutover === "already deployed") {
      // Activation applies the replacement Deployment before replacing the old route.
      advance(gateway);
    }
    let raced = false;
    const deletions = [];
    const missing = () => Object.assign(new Error("Not found"), { code: 404 });
    const read = (kind) => {
      const resource = resources.get(kind);
      if (resource === undefined) {
        throw missing();
      }
      return structuredClone(resource);
    };
    const remove = (kind, body) => {
      if (!raced && cutover === `during ${kind === "HTTPRoute" ? "route" : kind} deletion`) {
        // Server-side apply updates the revision without changing the object's UID.
        advance(gateway);
        if (kind === "HTTPRoute") {
          advance(route);
        }
        raced = true;
      }
      const resource = resources.get(kind);
      if (resource === undefined) {
        throw missing();
      }
      for (const field of ["uid", "resourceVersion"]) {
        if (
          body?.preconditions?.[field] !== undefined &&
          body.preconditions[field] !== resource.metadata[field]
        ) {
          throw Object.assign(new Error("Deletion precondition conflict"), { code: 409 });
        }
      }
      resources.delete(kind);
      deletions.push(kind);
    };
    driver.apiClients = Promise.resolve({
      core: {
        async listNamespace() {
          return { items: [namespaceResource] };
        },
        async readNamespace() {
          return structuredClone(namespaceResource);
        },
        async listNamespacedPod() {
          return { items: [] };
        },
        async readNamespacedService() {
          return read("Service");
        },
        async readNamespacedServiceAccount() {
          return read("ServiceAccount");
        },
        async readNamespacedConfigMap() {
          throw missing();
        },
        async readNamespacedSecret() {
          throw missing();
        },
        async deleteNamespacedService({ body }) {
          remove("Service", body);
        },
        async deleteNamespacedServiceAccount({ body }) {
          remove("ServiceAccount", body);
        },
      },
      apps: {
        async readNamespacedDeployment() {
          return read("Deployment");
        },
        async deleteNamespacedDeployment({ body }) {
          remove("Deployment", body);
        },
      },
      networking: {
        async readNamespacedNetworkPolicy() {
          return read("NetworkPolicy");
        },
      },
      objects: {
        async read({ kind, metadata }) {
          if (kind !== route.kind || metadata.name !== route.metadata.name) {
            throw missing();
          }
          return read("HTTPRoute");
        },
        async delete(_spec, _pretty, _dryRun, _grace, _orphan, _propagation, body) {
          remove("HTTPRoute", body);
        },
      },
    });

    if (cutover !== "already deployed") {
      await assert.rejects(driver.stopRevision(revision), { code: 409 });
      assert.equal(raced, true);
    }
    await driver.stopRevision(revision);
    assert.equal(resources.get("Deployment"), gateway);
    assert.equal(resources.get("Service"), service);
    assert.equal(resources.get("ServiceAccount"), account);
    assert.equal(
      gateway.metadata.annotations["openclaw.dev/agent-revision-id"],
      "replacement-revision",
    );
    assert.deepEqual(deletions, cutover === "during route deletion" ? [] : ["HTTPRoute"]);
    assert.equal(resources.has("HTTPRoute"), cutover === "during route deletion");
  });
}

test("stopping a containment-only Kubernetes revision removes its workload before Sandbox cleanup", async () => {
  const cleanupCalls = [];
  const deletionCalls = [];
  let deploymentPresent = true;
  let podObservations = 0;
  const sandboxDriver = {
    id: "sandbox-containment-only-stop",
    implementation: "test/containment-only",
    capability: "sandbox",
    facets: ["networking"],
    async cleanup(context) {
      assert.equal(deploymentPresent, false);
      assert.ok(podObservations >= 2, "cleanup must wait for the exact workload Pod to terminate");
      cleanupCalls.push(context);
      if (cleanupCalls.length === 1) {
        throw new Error("sandbox cleanup failed");
      }
    },
  };
  const driver = new KubernetesComputeDriver(options(), { sandboxDriver });
  const revision = routedRevision(driver, {
    id: "revision-containment-stop",
    sandboxDriverId: sandboxDriver.id,
  });
  const namespace = kubernetesNamespaceName(revision.namespaceId);
  const namespaceResource = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: namespace,
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace": revision.namespaceId,
      },
      annotations: { "openclaw.dev/namespace-id": revision.namespaceId },
    },
  };
  const deploymentName = `agent-${digest(revision.agentId)}-rev-${digest(revision.id)}`;
  const deployment = driver.deployment(
    deploymentName,
    {
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      servicePrincipalId: revision.servicePrincipalId,
      revisionId: revision.id,
    },
    { name: namespace, plane: "execution" },
    "agent:local",
    `agent-${digest(revision.agentId)}`,
    "agent",
    {},
    "info",
    undefined,
    undefined,
    undefined,
    preparedAuth(driver, namespace, false),
  );
  deployment.metadata.uid = "containment-stop-workload-uid";
  const pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "containment-stop-workload-pod",
      namespace,
      labels: structuredClone(deployment.spec.template.metadata.labels),
    },
  };
  const notFound = () => Object.assign(new Error("Not found"), { code: 404 });
  driver.apiClients = Promise.resolve({
    core: {
      async readNamespacedConfigMap() {
        throw notFound();
      },
      async readNamespacedSecret() {
        throw notFound();
      },
      async readNamespacedService() {
        throw notFound();
      },
      async readNamespacedServiceAccount() {
        throw notFound();
      },
      async listNamespace() {
        return { apiVersion: "v1", kind: "NamespaceList", items: [namespaceResource] };
      },
      async readNamespace({ name }) {
        if (name === kubernetesGatewayNamespaceName(tenant.id)) {
          return {
            ...driver.gatewayNamespaceManifest({ namespaceId: tenant.id }),
            status: { phase: "Active" },
          };
        }
        return structuredClone(namespaceResource);
      },
      async listNamespacedPod(request) {
        const selected = Object.fromEntries(
          request.labelSelector.split(",").map((entry) => entry.split("=")),
        );
        assert.equal(selected["openclaw.dev/namespace"], revision.namespaceId);
        assert.equal(selected["openclaw.dev/agent"], revision.agentId);
        assert.equal(selected["openclaw.dev/revision"], revision.id);
        if (selected["openclaw.dev/workload-role"] === "gateway") {
          return { apiVersion: "v1", kind: "PodList", items: [] };
        }
        assert.equal(selected["openclaw.dev/workload-role"], "agent");
        assert.equal(deploymentPresent, false);
        podObservations += 1;
        return {
          apiVersion: "v1",
          kind: "PodList",
          items: podObservations === 1 ? [structuredClone(pod)] : [],
        };
      },
    },
    apps: {
      async readNamespacedDeployment({ name }) {
        if (name === deploymentName && deploymentPresent) {
          return structuredClone(deployment);
        }
        throw notFound();
      },
      async deleteNamespacedDeployment(request) {
        deletionCalls.push(request);
        deploymentPresent = false;
      },
    },
    objects: {},
  });

  // A cleanup failure leaves stop retryable after the Compute-owned workload is gone.
  await assert.rejects(driver.stopRevision(revision), /sandbox cleanup failed/);
  assert.deepEqual(deletionCalls, [
    {
      name: deploymentName,
      namespace,
      body: { preconditions: { uid: deployment.metadata.uid } },
    },
  ]);
  assert.equal(cleanupCalls.length, 1);

  // Retrying an absent workload must still invoke the selected Sandbox cleanup.
  await driver.stopRevision(revision);
  assert.equal(deletionCalls.length, 1);
  assert.equal(cleanupCalls.length, 2);
  assert.equal(podObservations, 3);
  for (const context of cleanupCalls) {
    assert.equal(context.namespace.id, revision.namespaceId);
    assert.equal(context.namespace.name, namespace);
    assert.deepEqual(context.revision, revision);
  }
});

test("stopping a provider-owned Kubernetes revision waits for Sandbox workload termination", async () => {
  let cleanupComplete = false;
  let podObservations = 0;
  const sandboxDriver = {
    id: "sandbox-provider-stop",
    implementation: "test/provider-owned",
    capability: "sandbox",
    facets: ["execution"],
    async provisionHarness() {
      assert.fail("stop must not provision a Harness workload");
    },
    async cleanup() {
      cleanupComplete = true;
    },
  };
  const driver = new KubernetesComputeDriver(options(), { sandboxDriver });
  const revision = routedRevision(driver, {
    id: "revision-provider-stop",
    sandboxDriverId: sandboxDriver.id,
  });
  const namespace = kubernetesNamespaceName(revision.namespaceId);
  const namespaceResource = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: namespace,
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace": revision.namespaceId,
      },
      annotations: { "openclaw.dev/namespace-id": revision.namespaceId },
    },
  };
  const pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "provider-stop-workload-pod",
      namespace,
      labels: {
        "openclaw.dev/namespace": revision.namespaceId,
        "openclaw.dev/agent": revision.agentId,
        "openclaw.dev/revision": revision.id,
        "openclaw.dev/workload-role": "agent",
      },
    },
  };
  const notFound = () => Object.assign(new Error("Not found"), { code: 404 });
  driver.apiClients = Promise.resolve({
    core: {
      async readNamespacedConfigMap() {
        throw notFound();
      },
      async readNamespacedSecret() {
        throw notFound();
      },
      async readNamespacedService() {
        throw notFound();
      },
      async readNamespacedServiceAccount() {
        throw notFound();
      },
      async listNamespace() {
        return { apiVersion: "v1", kind: "NamespaceList", items: [namespaceResource] };
      },
      async readNamespace({ name }) {
        if (name === kubernetesGatewayNamespaceName(tenant.id)) {
          return {
            ...driver.gatewayNamespaceManifest({ namespaceId: tenant.id }),
            status: { phase: "Active" },
          };
        }
        return structuredClone(namespaceResource);
      },
      async listNamespacedPod(request) {
        const selected = Object.fromEntries(
          request.labelSelector.split(",").map((entry) => entry.split("=")),
        );
        if (selected["openclaw.dev/workload-role"] === "gateway") {
          return { apiVersion: "v1", kind: "PodList", items: [] };
        }
        assert.equal(cleanupComplete, true);
        podObservations += 1;
        return {
          apiVersion: "v1",
          kind: "PodList",
          items: podObservations === 1 ? [structuredClone(pod)] : [],
        };
      },
    },
    apps: {
      async readNamespacedDeployment() {
        throw notFound();
      },
    },
    objects: {},
  });

  await driver.stopRevision(revision);
  assert.equal(cleanupComplete, true);
  assert.equal(podObservations, 2);
});

test("stop and retirement end credential-source access through Sandbox cleanup", async () => {
  // Salvaged from #146: stop and retirement must still shut the workload down when credential
  // cleanup is uncertain, and must not report completion until it is confirmed. On main the
  // Credential Gateway attachment lives only in the paired Sandbox, so Sandbox cleanup is the
  // withdrawal; OCC has no withdraw caller, and a failed cleanup must keep the work retryable.
  const cleanupCalls = [];
  let failCleanup = true;
  let podObservations = 0;
  const sandboxDriver = {
    id: "sandbox-credential-stop",
    implementation: "test/provider-owned",
    capability: "sandbox",
    facets: ["networking", "filesystem", "process"],
    async provisionHarness() {
      assert.fail("stop and retirement must not provision a Harness workload");
    },
    async cleanup(context) {
      cleanupCalls.push(context.revision?.id);
      if (failCleanup) {
        failCleanup = false;
        throw new Error("sandbox cleanup failed");
      }
    },
  };
  const unexpected = (method) => async () => {
    assert.fail(`stop and retirement must not call Credential Gateway ${method}`);
  };
  const credentialGatewayDriver = {
    id: "credential-gateway-stop",
    implementation: "test/credential-gateway",
    capability: "credential_gateway",
    attachForRevision: unexpected("attachForRevision"),
    attachmentStatus: unexpected("attachmentStatus"),
    withdraw: unexpected("withdraw"),
    removeSource: unexpected("removeSource"),
  };
  const driver = new KubernetesComputeDriver(options(), { sandboxDriver, credentialGatewayDriver });
  const harnessAuth = {
    method: "credential_source",
    sourceId: "cs_00000000-0000-4000-8000-000000000146",
    credentialGatewayId: credentialGatewayDriver.id,
    sourceType: "openai",
    loginMode: "api_key",
  };
  const revision = routedRevision(driver, {
    id: "revision-credential-stop",
    sandboxDriverId: sandboxDriver.id,
    harnessAuth,
  });
  const namespace = kubernetesNamespaceName(revision.namespaceId);
  const namespaceResource = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: namespace,
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace": revision.namespaceId,
      },
      annotations: { "openclaw.dev/namespace-id": revision.namespaceId },
    },
  };
  const notFound = () => Object.assign(new Error("Not found"), { code: 404 });
  driver.apiClients = Promise.resolve({
    core: {
      async readNamespacedSecret() {
        throw notFound();
      },
      async readNamespacedService() {
        throw notFound();
      },
      async readNamespacedServiceAccount() {
        throw notFound();
      },
      async readNamespacedPersistentVolumeClaim() {
        throw notFound();
      },
      async readNamespacedConfigMap() {
        throw notFound();
      },
      async listNamespace() {
        return { apiVersion: "v1", kind: "NamespaceList", items: [namespaceResource] };
      },
      async readNamespace({ name }) {
        if (name === kubernetesGatewayNamespaceName(tenant.id)) {
          return {
            ...driver.gatewayNamespaceManifest({ namespaceId: tenant.id }),
            status: { phase: "Active" },
          };
        }
        return structuredClone(namespaceResource);
      },
      async listNamespacedPod(request) {
        const selected = Object.fromEntries(
          request.labelSelector.split(",").map((entry) => entry.split("=")),
        );
        if (selected["openclaw.dev/workload-role"] === "agent") {
          // The Harness is only observed as gone after its Sandbox cleanup succeeded.
          assert.equal(failCleanup, false);
          podObservations += 1;
        }
        return { apiVersion: "v1", kind: "PodList", items: [] };
      },
    },
    apps: {
      async readNamespacedDeployment() {
        throw notFound();
      },
    },
    networking: {
      async readNamespacedNetworkPolicy() {
        throw notFound();
      },
    },
    objects: {
      async read() {
        throw notFound();
      },
    },
  });

  // An uncertain cleanup fails the stop, so the worker keeps the stop pending and retries.
  await assert.rejects(driver.stopRevision(revision), /sandbox cleanup failed/);
  assert.deepEqual(cleanupCalls, [revision.id]);
  assert.equal(podObservations, 0);

  await driver.stopRevision(revision);
  assert.deepEqual(cleanupCalls, [revision.id, revision.id]);
  assert.equal(podObservations, 1);

  // Retirement of the same revision repeats the idempotent cleanup instead of skipping it.
  await driver.retireRevision(revision);
  assert.deepEqual(cleanupCalls, [revision.id, revision.id, revision.id]);
  assert.equal(podObservations, 2);
});

test("retiring a running embedded revision waits for gateway Pods and removes owned artifacts", async () => {
  const driver = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
        channels: { secretPrefix: "channel", proxyUrl: "http://192.0.2.10:3128" },
      },
    }),
  );
  const revision = routedRevision(driver, {
    id: "revision-embedded-deletion",
    agentId: "agent-embedded-deletion",
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    configuration: {
      agents: { defaults: { model: "openai/gpt-5" } },
      gateway: { controlUi: { enabled: false } },
    },
    plugins: {
      driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
      plugins: { "occ-plugin:diffs": { enabled: true, toolDefaults: { approval: "none" } } },
    },
  });
  const namespace = kubernetesNamespaceName(revision.namespaceId);
  const gatewayName = `gateway-${digest(revision.agentId)}`;
  const agentName = `agent-${digest(revision.agentId)}`;
  const gatewayOwnership = { namespaceId: revision.namespaceId, agentId: revision.agentId };
  const agentOwnership = {
    ...gatewayOwnership,
    servicePrincipalId: revision.servicePrincipalId,
  };
  const revisionOwnership = { ...agentOwnership, revisionId: revision.id };
  const configurationName = `${gatewayName}-rev-${digest(revision.id)}`;
  const pluginName = `plugin-runtime-${digest(revision.agentId)}-rev-${digest(revision.id)}`;
  const key = (kind, name) => `${kind}:${name}`;
  const objects = new Map();
  const save = (object) => {
    object.metadata.uid ??= `${object.metadata.name}-uid`;
    objects.set(key(object.kind, object.metadata.name), structuredClone(object));
  };
  const missing = (kind, name) =>
    Object.assign(new Error(`${kind} ${name} not found`), { code: 404 });

  save({
    ...driver.manifest("v1", "Namespace", namespace, { namespaceId: revision.namespaceId }),
    status: { phase: "Active" },
  });
  const gateway = driver.manifest("apps/v1", "Deployment", gatewayName, gatewayOwnership, {
    name: namespace,
    plane: "execution",
  });
  gateway.metadata.annotations["openclaw.dev/agent-revision-id"] = revision.id;
  save(gateway);
  save(
    driver.service(
      gatewayName,
      gatewayOwnership,
      { name: namespace, plane: "execution" },
      {
        "app.kubernetes.io/name": gatewayName,
      },
    ),
  );
  save(
    driver.manifest("v1", "ServiceAccount", agentName, agentOwnership, {
      name: namespace,
      plane: "execution",
    }),
  );
  save(
    driver.gatewayPrivateStateClaim(revision.agentId, gatewayOwnership, {
      name: namespace,
      plane: "execution",
    }),
  );
  save(
    driver.manifest("v1", "ConfigMap", configurationName, gatewayOwnership, {
      name: namespace,
      plane: "execution",
    }),
  );
  save(
    driver.manifest("v1", "ConfigMap", pluginName, revisionOwnership, {
      name: namespace,
      plane: "execution",
    }),
  );
  const policies = [
    ...driver
      .agentNetworkPolicies(revision, { name: namespace, plane: "execution" })
      .map(({ resource }) => resource),
    driver.channelNetworkPolicy(revision, [], { name: namespace, plane: "execution" }),
  ];
  for (const policy of policies) {
    save(policy);
  }
  const sibling = driver.manifest(
    "v1",
    "ConfigMap",
    "sibling-agent-artifact",
    { namespaceId: revision.namespaceId, agentId: "agent-sibling" },
    { name: namespace, plane: "execution" },
  );
  save(sibling);

  const deletions = [];
  let podObservations = 0;
  const read = (kind, name) => {
    const value = objects.get(key(kind, name));
    if (value === undefined) {
      throw missing(kind, name);
    }
    return structuredClone(value);
  };
  const remove = (kind, request) => {
    const current = read(kind, request.name);
    assert.equal(request.body?.preconditions?.uid, current.metadata.uid);
    deletions.push({ kind, name: request.name });
    objects.delete(key(kind, request.name));
    return {};
  };
  driver.apiClients = Promise.resolve({
    core: {
      async listNamespace() {
        return { apiVersion: "v1", kind: "NamespaceList", items: [] };
      },
      async readNamespace({ name }) {
        return read("Namespace", name);
      },
      async listNamespacedPod({ namespace: requestedNamespace, labelSelector }) {
        assert.equal(requestedNamespace, namespace);
        assert.match(labelSelector, /openclaw\.dev\/workload-role=gateway/);
        podObservations += 1;
        deletions.push({ kind: "PodList", name: revision.id });
        return {
          apiVersion: "v1",
          kind: "PodList",
          items:
            podObservations === 1
              ? [
                  {
                    apiVersion: "v1",
                    kind: "Pod",
                    metadata: {
                      name: "terminating-embedded-gateway",
                      namespace,
                      labels: {
                        "openclaw.dev/namespace": revision.namespaceId,
                        "openclaw.dev/agent": revision.agentId,
                        "openclaw.dev/revision": revision.id,
                        "openclaw.dev/workload-role": "gateway",
                      },
                    },
                  },
                ]
              : [],
        };
      },
      async readNamespacedSecret({ name }) {
        return read("Secret", name);
      },
      async readNamespacedConfigMap({ name }) {
        return read("ConfigMap", name);
      },
      async deleteNamespacedConfigMap(request) {
        return remove("ConfigMap", request);
      },
      async readNamespacedServiceAccount({ name }) {
        return read("ServiceAccount", name);
      },
      async deleteNamespacedServiceAccount(request) {
        return remove("ServiceAccount", request);
      },
      async readNamespacedService({ name }) {
        return read("Service", name);
      },
      async deleteNamespacedService(request) {
        return remove("Service", request);
      },
      async readNamespacedPersistentVolumeClaim({ name }) {
        return read("PersistentVolumeClaim", name);
      },
      async deleteNamespacedPersistentVolumeClaim(request) {
        return remove("PersistentVolumeClaim", request);
      },
    },
    apps: {
      async readNamespacedDeployment({ name }) {
        return read("Deployment", name);
      },
      async deleteNamespacedDeployment(request) {
        return remove("Deployment", request);
      },
    },
    networking: {
      async readNamespacedNetworkPolicy({ name }) {
        return read("NetworkPolicy", name);
      },
      async deleteNamespacedNetworkPolicy(request) {
        return remove("NetworkPolicy", request);
      },
    },
    objects: {
      async read({ metadata }) {
        return read("HTTPRoute", metadata.name);
      },
    },
  });

  await driver.retireRevision(revision);

  assert.equal(podObservations, 2);
  const podWait = deletions.findIndex(({ kind }) => kind === "PodList");
  assert.ok(podWait > deletions.findIndex(({ kind }) => kind === "Deployment"));
  assert.equal(
    objects.has(
      key("PersistentVolumeClaim", driver.gatewayPrivateStateClaimName(revision.agentId)),
    ),
    true,
    "revision retirement must preserve Agent-owned native state",
  );

  // The worker invokes final Agent cleanup only after every revision has retired.
  await driver.deleteAgentRuntimeCredentials({
    namespace: tenant,
    agent: { id: revision.agentId, namespaceId: tenant.id, executionMode: revision.harness.mode },
  });
  assert.ok(
    podWait < deletions.findIndex(({ kind }) => kind === "PersistentVolumeClaim"),
    "Agent storage cleanup must follow terminated gateway Pods",
  );
  for (const [kind, name] of [
    ["Deployment", gatewayName],
    ["Service", gatewayName],
    ["ServiceAccount", agentName],
    ["PersistentVolumeClaim", driver.gatewayPrivateStateClaimName(revision.agentId)],
    ["ConfigMap", configurationName],
    ["ConfigMap", pluginName],
    ...policies.map((policy) => ["NetworkPolicy", policy.metadata.name]),
  ]) {
    assert.equal(objects.has(key(kind, name)), false, `${kind} ${name} must be deleted`);
  }
  assert.deepEqual(objects.get(key("ConfigMap", sibling.metadata.name)), sibling);
});

test("retirement preserves active storage and node routing and deletes exact owned UIDs", async () => {
  const driver = createKubernetesComputeDriver(
    routedOptions({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
      },
    }),
  );
  const agentId = "agent-revision-storage";
  const ownership = { namespaceId: tenant.id, agentId };
  const harnessNamespace = kubernetesNamespaceName(tenant.id);
  const namespace = kubernetesGatewayNamespaceName(tenant.id);
  const gatewayName = "gateway-" + createHash("sha256").update(agentId).digest("hex").slice(0, 12);
  const gateway = driver.manifest("apps/v1", "Deployment", gatewayName, ownership, {
    name: namespace,
    plane: "execution",
  });
  gateway.metadata.uid = "gateway-uid";
  gateway.metadata.annotations["openclaw.dev/agent-revision-id"] = "revision-2";
  let observedGateway = gateway;
  const gatewayService = driver.service(
    gatewayName,
    ownership,
    { name: namespace, plane: "execution" },
    {
      "app.kubernetes.io/name": gatewayName,
    },
  );
  gatewayService.metadata.uid = "gateway-service-uid";
  let observedService = gatewayService;
  const gatewayAccount = driver.manifest("v1", "ServiceAccount", gatewayName, ownership, {
    name: namespace,
    plane: "execution",
  });
  gatewayAccount.metadata.uid = "gateway-account-uid";
  let observedServiceAccount = gatewayAccount;
  const agentName = `agent-${digest(agentId)}`;
  const agentOwnership = {
    ...ownership,
    servicePrincipalId: "service-agent-revision-storage",
  };
  const agentService = driver.service(
    agentName,
    agentOwnership,
    { name: harnessNamespace, plane: "execution" },
    {
      "openclaw.dev/agent": agentId,
      "openclaw.dev/revision": "revision-2",
      "openclaw.dev/workload-role": "agent",
    },
  );
  agentService.metadata.uid = "agent-service-uid";
  const agentAccount = driver.manifest("v1", "ServiceAccount", agentName, agentOwnership, {
    name: harnessNamespace,
    plane: "execution",
  });
  agentAccount.metadata.uid = "agent-account-uid";
  const route = driver.gatewayRoute(
    { id: "revision-2", revision: 2, namespaceId: tenant.id, agentId },
    ownership,
    { name: namespace, plane: "execution" },
    gatewayService,
  );
  route.metadata.uid = "route-uid";
  route.metadata.resourceVersion = "route-version-2";
  let observedRoute = route;
  const nodeResources = new Map();
  const claims = [
    driver.gatewayPrivateStateClaim(agentId, ownership, { name: namespace, plane: "execution" }),
    driver.harnessWorkspaceClaim(agentId, ownership, {
      name: harnessNamespace,
      plane: "execution",
    }),
  ];
  for (const claim of claims) {
    claim.metadata.uid = claim.metadata.name + "-uid";
  }
  const deletions = [];
  let failServiceDelete = false;
  const missing = async () => {
    throw Object.assign(new Error("Not found"), { code: 404 });
  };
  driver.apiClients = Promise.resolve({
    apps: {
      async readNamespacedDeployment({ name, namespace: target }) {
        if (name !== gatewayName || target !== namespace) {
          return missing();
        }
        if (observedGateway === undefined) {
          return missing();
        }
        return structuredClone(observedGateway);
      },
      async deleteNamespacedDeployment(request) {
        deletions.push(["Deployment", request]);
      },
    },
    core: {
      async listNamespacedPod() {
        return { apiVersion: "v1", kind: "PodList", items: [] };
      },
      readNamespacedConfigMap: missing,
      readNamespacedSecret: missing,
      async readNamespacedPersistentVolumeClaim({ name }) {
        const claim = claims.find(({ metadata }) => metadata.name === name);
        if (claim === undefined) {
          return missing();
        }
        return structuredClone(claim);
      },
      async deleteNamespacedPersistentVolumeClaim(request) {
        deletions.push(["PersistentVolumeClaim", request]);
      },
      async readNamespacedService({ name }) {
        if (name === agentName) {
          return structuredClone(agentService);
        }
        if (observedService === undefined) {
          return missing();
        }
        return structuredClone(observedService);
      },
      async deleteNamespacedService(request) {
        deletions.push(["Service", request]);
        if (failServiceDelete) {
          throw new Error("service delete failed");
        }
      },
      async readNamespacedServiceAccount({ name }) {
        if (name === agentName) {
          return structuredClone(agentAccount);
        }
        if (observedServiceAccount === undefined) {
          return missing();
        }
        return structuredClone(observedServiceAccount);
      },
      async deleteNamespacedServiceAccount(request) {
        deletions.push(["ServiceAccount", request]);
      },
    },
    networking: {
      readNamespacedNetworkPolicy: missing,
    },
    objects: {
      async read({ kind, metadata }) {
        if (metadata.name === `${gatewayName}-node`) {
          const resource = nodeResources.get(kind);
          if (resource === undefined) {
            return missing();
          }
          return structuredClone(resource);
        }
        if (
          kind !== "HTTPRoute" ||
          metadata.name !== gatewayName ||
          metadata.namespace !== namespace
        ) {
          return missing();
        }
        if (observedRoute === undefined) {
          return missing();
        }
        return structuredClone(observedRoute);
      },
      async patch(body) {
        if (body.metadata.name === gatewayName) {
          observedRoute = {
            ...structuredClone(body),
            metadata: { ...body.metadata, uid: "route-uid", resourceVersion: "1" },
          };
          return;
        }
        assert.equal(body.metadata.name, `${gatewayName}-node`);
        nodeResources.set(body.kind, {
          ...structuredClone(body),
          metadata: { ...body.metadata, uid: `${body.kind}-node-uid`, resourceVersion: "1" },
        });
      },
      async delete(
        spec,
        pretty,
        dryRun,
        gracePeriodSeconds,
        orphanDependents,
        propagationPolicy,
        body,
      ) {
        deletions.push([spec.kind, { spec, body }]);
      },
    },
  });
  await driver.removeRetiredGateway(
    {
      id: "revision-1",
      agentId,
      namespaceId: tenant.id,
      servicePrincipalId: "service-agent-revision-storage",
      harness: { mode: "dedicated" },
    },
    { name: harnessNamespace, plane: "execution" },
  );
  assert.deepEqual(deletions, []);
  failServiceDelete = true;
  await assert.rejects(
    driver.removeRetiredGateway(
      {
        id: "revision-2",
        agentId,
        namespaceId: tenant.id,
        servicePrincipalId: "service-agent-revision-storage",
        harness: { mode: "dedicated" },
      },
      { name: harnessNamespace, plane: "execution" },
    ),
    /service delete failed/,
  );
  assert.deepEqual(
    deletions.map(([kind]) => kind),
    ["HTTPRoute", "Service"],
  );
  assert.equal(
    deletions.some(([kind]) => kind === "Deployment"),
    false,
    "Deployment must remain as the retry witness until Service deletion succeeds",
  );

  deletions.length = 0;
  failServiceDelete = false;
  await driver.removeRetiredGateway(
    {
      id: "revision-2",
      agentId,
      namespaceId: tenant.id,
      servicePrincipalId: "service-agent-revision-storage",
      harness: { mode: "dedicated" },
    },
    { name: harnessNamespace, plane: "execution" },
  );
  assert.deepEqual(deletions, [
    [
      "HTTPRoute",
      {
        spec: {
          apiVersion: "gateway.networking.k8s.io/v1",
          kind: "HTTPRoute",
          metadata: { name: gatewayName, namespace },
        },
        body: { preconditions: { uid: "route-uid", resourceVersion: "route-version-2" } },
      },
    ],
    [
      "Service",
      { name: gatewayName, namespace, body: { preconditions: { uid: "gateway-service-uid" } } },
    ],
    [
      "ServiceAccount",
      { name: gatewayName, namespace, body: { preconditions: { uid: "gateway-account-uid" } } },
    ],
    [
      "Deployment",
      { name: gatewayName, namespace, body: { preconditions: { uid: "gateway-uid" } } },
    ],
    [
      "Service",
      {
        name: agentName,
        namespace: harnessNamespace,
        body: { preconditions: { uid: "agent-service-uid" } },
      },
    ],
    [
      "ServiceAccount",
      {
        name: agentName,
        namespace: harnessNamespace,
        body: { preconditions: { uid: "agent-account-uid" } },
      },
    ],
  ]);

  deletions.length = 0;
  observedGateway = undefined;
  observedService = gatewayService;
  observedServiceAccount = gatewayAccount;
  observedRoute = route;
  await driver.removeRetiredGateway(
    {
      id: "revision-2",
      agentId,
      namespaceId: tenant.id,
      servicePrincipalId: "service-agent-revision-storage",
      harness: { mode: "dedicated" },
    },
    { name: harnessNamespace, plane: "execution" },
  );
  assert.deepEqual(deletions, [
    [
      "HTTPRoute",
      {
        spec: {
          apiVersion: "gateway.networking.k8s.io/v1",
          kind: "HTTPRoute",
          metadata: { name: gatewayName, namespace },
        },
        body: { preconditions: { uid: "route-uid", resourceVersion: "route-version-2" } },
      },
    ],
    [
      "Service",
      { name: gatewayName, namespace, body: { preconditions: { uid: "gateway-service-uid" } } },
    ],
    [
      "ServiceAccount",
      { name: gatewayName, namespace, body: { preconditions: { uid: "gateway-account-uid" } } },
    ],
    [
      "Service",
      {
        name: agentName,
        namespace: harnessNamespace,
        body: { preconditions: { uid: "agent-service-uid" } },
      },
    ],
    [
      "ServiceAccount",
      {
        name: agentName,
        namespace: harnessNamespace,
        body: { preconditions: { uid: "agent-account-uid" } },
      },
    ],
  ]);

  deletions.length = 0;
  observedRoute = {
    ...route,
    metadata: {
      ...route.metadata,
      annotations: {
        ...route.metadata.annotations,
        "openclaw.dev/agent-revision-id": "revision-3",
      },
    },
  };
  await driver.removeRetiredGateway(
    {
      id: "revision-2",
      agentId,
      namespaceId: tenant.id,
      servicePrincipalId: "service-agent-revision-storage",
      harness: { mode: "dedicated" },
    },
    { name: harnessNamespace, plane: "execution" },
  );
  assert.deepEqual(deletions, []);

  // Preparation can run while the previous Gateway still serves requests. A
  // failed candidate must not acquire and then delete that Gateway's node route.
  observedGateway = structuredClone(gateway);
  const active = routedRevision(driver, {
    id: "revision-2",
    revision: 2,
    agentId,
    servicePrincipalId: agentOwnership.servicePrincipalId,
  });
  observedGateway.metadata.annotations["openclaw.dev/agent-revision"] = String(active.revision);
  const candidate = { ...active, id: "revision-3", revision: 3 };
  await driver.reconcileGatewayRoute(active, ownership, { name: namespace, plane: "execution" });
  const activeNodeResources = structuredClone(nodeResources);
  assert.equal(activeNodeResources.size, 2);
  await driver.reconcileGatewayRoute(candidate, ownership, { name: namespace, plane: "execution" });
  assert.deepEqual(nodeResources, activeNodeResources);
  // A serving Gateway predating node enrollment may have no node endpoint.
  // Preparing its successor must create one under the serving revision, or
  // node readiness would wait for activation while activation waits for it.
  nodeResources.clear();
  await driver.reconcileGatewayRoute(candidate, ownership, { name: namespace, plane: "execution" });
  assert.deepEqual(nodeResources, activeNodeResources);
  await driver.removeRetiredGateway(candidate, { name: harnessNamespace, plane: "execution" });
  assert.deepEqual(deletions, []);

  // Once activation replaces the Gateway, the same endpoint belongs to the new
  // revision. Retiring the predecessor must leave it usable by the new node.
  observedGateway.metadata.annotations["openclaw.dev/agent-revision-id"] = candidate.id;
  observedGateway.metadata.annotations["openclaw.dev/agent-revision"] = String(candidate.revision);
  await driver.reconcileGatewayRoute(candidate, ownership, { name: namespace, plane: "execution" });
  for (const resource of nodeResources.values()) {
    assert.equal(resource.metadata.annotations["openclaw.dev/agent-revision-id"], candidate.id);
  }
  await driver.removeRetiredGateway(active, { name: harnessNamespace, plane: "execution" });
  assert.deepEqual(deletions, []);
  await driver.removeRetiredGateway(candidate, { name: harnessNamespace, plane: "execution" });
  assert.deepEqual(
    deletions
      .slice(0, 2)
      .map(([kind, { spec, body }]) => [kind, spec.metadata.name, body.preconditions.uid]),
    [
      ["HTTPRoute", `${gatewayName}-node`, "HTTPRoute-node-uid"],
      ["SecurityPolicy", `${gatewayName}-node`, "SecurityPolicy-node-uid"],
    ],
  );
});

// These fixtures substitute Kubernetes transport only. Preparation, ownership, private delivery,
// redaction, readiness, and completed-payload retention run through the production driver.
function workspaceSetupFixture(embedded, runtime = true, network = undefined, computeOptions = {}) {
  const state = { ready: false, secretFailure: false, failedInitializer: false };
  const driver = new KubernetesComputeDriver(
    routedOptions({
      ...(network === undefined ? {} : { network }),
      resources: {
        gateway: {
          requests: { cpu: "200m", memory: "256Mi" },
          limits: { cpu: "1", memory: "1Gi" },
        },
        agent: {
          requests: { cpu: "100m", memory: "128Mi" },
          limits: { cpu: "500m", memory: "512Mi" },
        },
        namespace: options().resources.namespace,
      },
      runtime: runtime
        ? { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" }
        : undefined,
      ...computeOptions,
    }),
    {
      nodeEnrollment: {
        async createSetup() {
          return { setupId: "setup-1", setupCode: "setup-code", expiresAtMs: Date.now() + 60000 };
        },
        async observeSetup() {
          return state.ready ? { deviceId: "node-1", connected: true } : undefined;
        },
        async isConnected() {
          return state.ready;
        },
      },
    },
  );
  const revision = routedRevision(driver, {
    configuration: {
      gateway: routedRevision(driver).configuration.gateway,
      agents: { defaults: { model: embedded ? "openai/gpt-5" : "codex/gpt-5" } },
      logging: { level: "info", consoleLevel: "info", consoleStyle: "json" },
      diagnostics: { otel: { logs: false } },
    },
    harness: embedded
      ? { id: "openclaw", version: "1.0.0", mode: "embedded" }
      : { id: "codex", version: "1.0.0", mode: "dedicated" },
  });
  const namespace = kubernetesNamespaceName(tenant.id);
  const objects = new Map();
  const records = [];
  const key = (kind, name, target = namespace) =>
    `${kind}:${kind === "Namespace" ? "" : target}:${name}`;
  const save = (body) => {
    const existing = objects.get(key(body.kind, body.metadata.name, body.metadata.namespace));
    const object = structuredClone(body);
    if (object.stringData) {
      object.data = Object.fromEntries(
        Object.entries(object.stringData).map(([key, value]) => [
          key,
          Buffer.from(value).toString("base64"),
        ]),
      );
      delete object.stringData;
    }
    object.metadata = {
      ...object.metadata,
      uid: existing?.metadata.uid ?? body.metadata.uid ?? `${body.metadata.name}-uid`,
      resourceVersion: String(Number(existing?.metadata.resourceVersion ?? 0) + 1),
      generation: 1,
    };
    objects.set(key(body.kind, body.metadata.name, body.metadata.namespace), object);
    return object;
  };
  save({
    ...driver.manifest("v1", "Namespace", namespace, { namespaceId: tenant.id }),
    status: { phase: "Active" },
  });
  save({
    ...driver.gatewayNamespaceManifest({ namespaceId: tenant.id }),
    status: { phase: "Active" },
  });
  save({
    ...driver.manifest(
      "v1",
      "Secret",
      `transport-${digest(revision.agentId)}`,
      { namespaceId: tenant.id, agentId: revision.agentId },
      { name: embedded ? namespace : kubernetesGatewayNamespaceName(tenant.id), plane: "control" },
    ),
    type: "Opaque",
    metadata: {
      ...driver.manifest(
        "v1",
        "Secret",
        `transport-${digest(revision.agentId)}`,
        { namespaceId: tenant.id, agentId: revision.agentId },
        {
          name: embedded ? namespace : kubernetesGatewayNamespaceName(tenant.id),
          plane: "control",
        },
      ).metadata,
      uid: "transport-uid",
      resourceVersion: "1",
    },
    data: {
      "app-server-token": Buffer.from("test-transport").toString("base64"),
      ...(embedded ? { "gateway-password": Buffer.from("test-password").toString("base64") } : {}),
    },
  });
  save({
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: "occ-model-key",
      namespace: kubernetesGatewayNamespaceName(tenant.id),
      uid: "model-secret-uid",
    },
    data: { value: Buffer.from("fixture-model-key").toString("base64") },
  });
  for (const target of [
    { name: namespace, plane: "execution" },
    { name: kubernetesGatewayNamespaceName(tenant.id), plane: "control" },
  ]) {
    for (const policy of driver.networkPolicies({ namespaceId: tenant.id }, target)) {
      save(policy);
    }
  }
  const read =
    (kind) =>
    async ({ name, namespace: target }) => {
      const object = objects.get(key(kind, name, target));
      if (object === undefined) {
        throw Object.assign(new Error("Not found"), { statusCode: 404 });
      }
      const observed = structuredClone(object);
      if (kind === "Deployment" && state.ready) {
        observed.status = {
          observedGeneration: 1,
          replicas: 1,
          updatedReplicas: 1,
          readyReplicas: 1,
        };
      }
      return observed;
    };
  const write = async ({ body }) => {
    if (body.kind === "Secret" && state.secretFailure) {
      throw Object.assign(new Error(`Rejected ${JSON.stringify(body)}`), { statusCode: 403 });
    }
    records.push(structuredClone(body));
    return save(body);
  };
  const remove =
    (kind) =>
    async ({ name, namespace: target, body }) => {
      const existing = objects.get(key(kind, name, target));
      assert.equal(body.preconditions.uid, existing.metadata.uid);
      objects.delete(key(kind, name, target));
    };
  const core = {
    async listNamespace() {
      return { items: [] };
    },
    readNamespace: read("Namespace"),
    async listNamespacedPod({ namespace: target, labelSelector }) {
      const labels = Object.fromEntries(labelSelector.split(",").map((entry) => entry.split("=")));
      const gateway = objects.get(key("Deployment", `gateway-${digest(revision.agentId)}`, target));
      const revisionId = labels["openclaw.dev/revision"];
      if (
        !embedded &&
        labels["openclaw.dev/workload-role"] === "gateway" &&
        gateway?.metadata.annotations?.["openclaw.dev/agent-revision-id"] === revisionId
      ) {
        // The running dedicated Gateway; its wrapper reports the applied node.
        return {
          items: [
            {
              apiVersion: "v1",
              kind: "Pod",
              metadata: {
                name: `gateway-pod-${revisionId}`,
                namespace: target,
                uid: `gateway-uid-${revisionId}`,
                labels,
              },
            },
          ],
        };
      }
      return {
        items: state.failedInitializer
          ? [
              {
                apiVersion: "v1",
                kind: "Pod",
                metadata: {
                  name: "failed-initializer",
                  namespace,
                  labels: {
                    "openclaw.dev/agent": revision.agentId,
                    "openclaw.dev/revision": revision.id,
                    "openclaw.dev/workload-role": embedded ? "gateway" : "agent",
                  },
                },
                status: {
                  initContainerStatuses: [
                    {
                      name: "initialize-workspace",
                      state: {
                        terminated: {
                          exitCode: 1,
                          finishedAt: "2026-09-22T00:00:00Z",
                          message: "private-content-must-not-escape",
                        },
                      },
                    },
                  ],
                },
              },
            ]
          : [],
      };
    },
    async deleteNamespacedSecret({ name, body }) {
      const existing = objects.get(key("Secret", name));
      assert.equal(body.preconditions.uid, existing.metadata.uid);
      objects.delete(key("Secret", name));
    },
    async patchNamespacedPod({ body }) {
      return body;
    },
    async connectGetNamespacedPodProxyWithPath({ name, path }) {
      const revisionId = name.replace(/^gateway-pod-/u, "").replace(/:\d+$/u, "");
      if (path !== "openclaw/runtime/status") {
        throw Object.assign(new Error("not found"), { statusCode: 404 });
      }
      return {
        revisionId,
        container: "gateway",
        podUid: `gateway-uid-${revisionId}`,
        workspaceNodeId: "node-1",
      };
    },
  };
  for (const kind of [
    "ConfigMap",
    "ServiceAccount",
    "Service",
    "PersistentVolumeClaim",
    "Secret",
  ]) {
    core[`readNamespaced${kind}`] = read(kind);
    core[`patchNamespaced${kind}`] = write;
    core[`deleteNamespaced${kind}`] = remove(kind);
  }
  core.createNamespacedSecret = write;
  core.replaceNamespacedSecret = write;
  driver.apiClients = Promise.resolve({
    core,
    apps: {
      readNamespacedDeployment: read("Deployment"),
      patchNamespacedDeployment: write,
      deleteNamespacedDeployment: remove("Deployment"),
    },
    objects: {
      read: async (object) =>
        read(object.kind)({ name: object.metadata.name, namespace: object.metadata.namespace }),
      patch: async (body) => write({ body }),
      delete: async (object, _pretty, _dryRun, _grace, _orphan, _propagation, body) =>
        remove(object.kind)({
          name: object.metadata.name,
          namespace: object.metadata.namespace,
          body,
        }),
    },
    networking: {
      readNamespacedNetworkPolicy: read("NetworkPolicy"),
      patchNamespacedNetworkPolicy: write,
      deleteNamespacedNetworkPolicy: remove("NetworkPolicy"),
    },
    discovery: {
      async listNamespacedEndpointSlice({ labelSelector }) {
        const name = labelSelector.split("=")[1];
        return {
          items: [
            {
              metadata: {
                labels: { "kubernetes.io/service-name": name },
                ownerReferences: [{ kind: "Service", name, uid: `${name}-uid` }],
              },
              endpoints: [{ conditions: { ready: state.ready } }],
            },
          ],
        };
      },
    },
  });
  const setup = {
    id: "setup-private",
    namespaceId: tenant.id,
    agentId: revision.agentId,
    files: { "AGENTS.md": "private-create-documents", "USER.md": "" },
    completed: false,
  };
  const context = { ...authContext(revision), workspaceSetup: setup };
  return { driver, revision, namespace, objects, records, state, setup, context };
}

for (const dualCluster of [false, true]) {
  test(`Kubernetes ${dualCluster ? "two-cluster" : "single-cluster"} OAuth handoff consumes the source before native startup and reuses private storage`, async () => {
    const { driver, revision, namespace, objects, records, state, context } = workspaceSetupFixture(
      false,
      true,
      undefined,
      dualCluster
        ? {
            executionCluster: {
              authentication: { mode: "kubeconfig", kubeconfigPath, context: "execution-cluster" },
              harnessRouting: {
                ...gatewayRouting,
                gatewayName: "harnesses",
                hostname: "harness.example.test",
              },
              network: {
                dns: options().network.dns,
                harnessEndpointCidrs: ["192.0.2.2/32"],
                gatewayEndpointCidrs: ["192.0.2.1/32"],
                pluginStatusProxySourceCidrs: ["192.0.2.2/32"],
              },
            },
          }
        : {},
    );
    if (dualCluster) {
      // Distinct transports reject requests sent to the wrong cluster. The production Driver
      // must mutate the source on control while seeding and removing workloads on execution.
      const transport = await driver.apiClients;
      const scoped = (namespaceName) =>
        Object.fromEntries(
          Object.entries(transport).map(([group, methods]) => [
            group,
            Object.fromEntries(
              Object.entries(methods).map(([method, invoke]) => [
                method,
                (...args) => {
                  const request = args[0];
                  const target =
                    request?.namespace ??
                    request?.metadata?.namespace ??
                    request?.body?.metadata?.namespace;
                  if (target !== undefined) {
                    assert.equal(
                      target,
                      namespaceName,
                      `${group}.${method} used the wrong cluster`,
                    );
                  }
                  return invoke(...args);
                },
              ]),
            ),
          ]),
        );
      driver.apiClients = Promise.resolve(scoped(kubernetesGatewayNamespaceName(tenant.id)));
      driver.executionApiClients = Promise.resolve(scoped(namespace));
    }
    const sourceKey = stageReadyOAuthSource(objects, revision, context);

    // Only the trusted seed writer may run while OCE still holds a usable bundle.
    assert.equal((await driver.prepareRevision(revision, context)).ready, false);
    assert.equal(
      objects.get(sourceKey).metadata.annotations["openclaw.dev/oauth-phase"],
      "claimed",
    );
    const bootstrap = [...objects.values()].find(
      ({ kind, metadata }) => kind === "Deployment" && metadata.name.startsWith("oauth-bootstrap-"),
    );
    assert.ok(bootstrap);
    const seedPod = bootstrap.spec.template.spec;
    assert.equal(seedPod.automountServiceAccountToken, false);
    // Containment rests on the missing profile label: namespace default-deny then applies.
    assert.equal(
      bootstrap.spec.template.metadata.labels["openclaw.dev/network-profile"],
      undefined,
    );
    assert.equal(seedPod.containers[0].securityContext.readOnlyRootFilesystem, true);
    assert.deepEqual(seedPod.containers[0].securityContext.capabilities.drop, ["ALL"]);
    // The process holding the seed sees only codex-home, never the rest of the Harness claim.
    const seedClaim = seedPod.volumes.find(({ persistentVolumeClaim }) => persistentVolumeClaim);
    const claimMounts = seedPod.containers[0].volumeMounts.filter(
      ({ name }) => name === seedClaim.name,
    );
    assert.deepEqual(claimMounts, [
      { name: seedClaim.name, mountPath: "/auth", subPath: "codex-home" },
    ]);
    assert.equal(
      seedPod.containers[0].env.find(({ name }) => name === "CODEX_HOME").value,
      "/auth",
    );
    assert.match(
      seedPod.containers[0].readinessProbe.exec.command[2],
      /"\/auth\/\.oce-oauth\.json"/,
    );
    // Only a credential-free init step sees the claim root, to create codex-home as uid 1000
    // (a kubelet-created subPath is root-owned and world-writable).
    assert.deepEqual(
      seedPod.initContainers.map(({ name }) => name),
      ["prepare-oauth-home"],
    );
    const [prepare] = seedPod.initContainers;
    assert.deepEqual(prepare.volumeMounts, [
      { name: seedClaim.name, mountPath: "/harness-workspace-state" },
    ]);
    assert.equal(prepare.env, undefined);
    assert.match(prepare.args[0], /chmodSync\(path, 0o700\)/);
    assert.match(prepare.args[0], /isDirectory\(\) === false/);
    assert.equal(prepare.securityContext.readOnlyRootFilesystem, true);
    assert.deepEqual(prepare.securityContext.capabilities.drop, ["ALL"]);
    assert.equal(
      records.some(
        ({ kind, metadata }) => kind === "Deployment" && metadata.name.startsWith("agent-"),
      ),
      false,
    );

    await assert.rejects(
      driver.prepareRevision(
        { ...revision, agentId: `${revision.agentId}-other` },
        { harnessAuth: context.harnessAuth },
      ),
      /OAuth credentials belong to another Agent/,
    );

    // Stopping an unfinished handoff removes both seed objects but retains the claimed
    // source, so the same login can resume without another authorization exchange.
    await driver.stopRevision(revision);
    assert.equal(
      [...objects.values()].some(({ metadata }) => metadata.name.startsWith("oauth-bootstrap-")),
      false,
    );
    assert.equal(
      objects.get(sourceKey).metadata.annotations["openclaw.dev/oauth-phase"],
      "claimed",
    );
    assert.equal((await driver.prepareRevision(revision, context)).ready, false);
    for (const kind of ["Deployment", "Secret"]) {
      assert.ok(
        [...objects.values()].some(
          (object) => object.kind === kind && object.metadata.name.startsWith("oauth-bootstrap-"),
        ),
      );
    }

    // Transport reports the seed writer ready; production preparation must clear the source first.
    state.ready = true;
    assert.equal((await driver.prepareRevision(revision, context)).ready, true);
    const consumed = objects.get(sourceKey);
    const envelope = JSON.parse(Buffer.from(consumed.data.value, "base64"));
    assert.equal(envelope.phase, "consumed");
    assert.equal(envelope.agentId, revision.agentId);
    assert.equal(envelope.credential, undefined);
    assert.equal(envelope.privateState, undefined);
    const consumeIndex = records.findIndex(
      ({ kind, metadata }) =>
        kind === "Secret" && metadata.annotations?.["openclaw.dev/oauth-phase"] === "consumed",
    );
    const launchIndex = records.findIndex(
      ({ kind, metadata }) => kind === "Deployment" && metadata.name.startsWith("agent-"),
    );
    assert.ok(consumeIndex >= 0 && consumeIndex < launchIndex);
    assert.equal(
      [...objects.values()].some(({ metadata }) => metadata.name.startsWith("oauth-bootstrap-")),
      false,
    );
    const harness = records[launchIndex];
    assert.equal(
      harness.spec.template.metadata.labels["openclaw.dev/network-profile"],
      "broad-egress-v1",
    );
    const pod = harness.spec.template.spec;
    assert.equal(
      pod.initContainers
        .find(({ name }) => name === "prepare-private-state")
        .args[0].includes("codex-home"),
      false,
    );
    const native = pod.containers[0];
    assert.equal(native.env.find(({ name }) => name === "CODEX_LOGIN_MODE").value, "oauth");
    assert.equal(
      native.env.some(({ name }) => ["CODEX_ACCESS_TOKEN", "OPENAI_API_KEY"].includes(name)),
      false,
    );
    const authMount = native.volumeMounts.find(
      ({ mountPath }) => mountPath === "/home/node/.codex",
    );
    assert.equal(authMount.subPath, "codex-home");
    // OAuth keeps thread rollouts inside codex-home, which a new OAuth source empties;
    // a separate rollout directory would outlive that reset, so it is neither mounted nor kept.
    assert.equal(
      native.volumeMounts.some(({ subPath }) => subPath === "codex-sessions"),
      false,
    );
    assert.match(
      pod.initContainers.find(({ name }) => name === "prepare-private-state").args[0],
      /rmSync\("\/harness-workspace-state\/codex-sessions", \{ recursive: true, force: true \}\)/,
    );
    const claimName = pod.volumes.find(({ name }) => name === authMount.name).persistentVolumeClaim
      .claimName;
    assert.equal(
      envelope.volumeUid,
      objects.get(`PersistentVolumeClaim:${namespace}:${claimName}`).metadata.uid,
    );
    const gateway = records.find(
      ({ kind, metadata }) => kind === "Deployment" && metadata.name.startsWith("gateway-"),
    );
    assert.equal(
      gateway.spec.template.spec.volumes.some(({ name }) => name === authMount.name),
      false,
    );

    // A later revision has no usable OCE bundle: it selects the same durable native generation.
    const later = { ...revision, id: `${revision.id}-next`, revision: revision.revision + 1 };
    const previousWrites = records.length;
    assert.equal((await driver.prepareRevision(later, context)).ready, true);
    assert.equal(
      records
        .slice(previousWrites)
        .some(({ metadata }) => metadata.name.startsWith("oauth-bootstrap-")),
      false,
    );
    const laterHarness = records
      .slice(previousWrites)
      .find(({ kind, metadata }) => kind === "Deployment" && metadata.name.startsWith("agent-"));
    assert.equal(
      laterHarness.spec.template.spec.volumes.find(({ name }) => name === authMount.name)
        .persistentVolumeClaim.claimName,
      claimName,
    );

    // Losing/replacing the volume must fail closed; the consumed source cannot restore stale tokens.
    objects.get(`PersistentVolumeClaim:${namespace}:${claimName}`).metadata.uid =
      "replacement-volume";
    await assert.rejects(
      driver.prepareRevision(later, context),
      /require reconnect after storage loss/,
    );
    assert.equal(
      [...objects.values()].some(({ metadata }) => metadata.name.startsWith("oauth-bootstrap-")),
      false,
    );
  });
}

function stageReadyOAuthSource(objects, revision, context) {
  revision.harnessAuth = { ...apiKeyAuth, method: "oauth" };
  context.harnessAuth = authContext(revision).harnessAuth;
  const sourceKey = `Secret:${context.harnessAuth.backendRef.namespaceName}:occ-model-key`;
  const source = objects.get(sourceKey);
  source.metadata.annotations = {
    "openclaw.dev/namespace-id": tenant.id,
    "openclaw.dev/secret-id": apiKeyAuth.source.id,
    "openclaw.dev/secret-driver-id": apiKeyAuth.secretDriverId,
  };
  source.data.value = Buffer.from(
    JSON.stringify({
      kind: "harness_device_authorization",
      version: 1,
      actorId: "admin",
      namespaceId: tenant.id,
      harnessId: "codex",
      phase: "ready",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      credential: JSON.stringify({
        version: 1,
        provider: "codex",
        state: "ready",
        auth: {
          auth_mode: "chatgpt",
          tokens: {
            id_token: "test-id",
            access_token: "test-access",
            refresh_token: "test-refresh",
          },
        },
      }),
    }),
  ).toString("base64");
  return sourceKey;
}

test("Kubernetes OAuth source consumed by one Agent cannot start a second Agent", async () => {
  const { driver, revision, objects, records, state, context } = workspaceSetupFixture(false, true);
  const sourceKey = stageReadyOAuthSource(objects, revision, context);
  state.ready = true;
  assert.equal((await driver.prepareRevision(revision, context)).ready, true);
  const consumed = structuredClone(objects.get(sourceKey));
  assert.equal(consumed.metadata.annotations["openclaw.dev/oauth-phase"], "consumed");

  // Admission does not enforce one Agent per login; preparation is the fence.
  const otherAgentId = `${revision.agentId}-other`;
  const other = { ...revision, agentId: otherAgentId, id: `${revision.id}-other` };
  const writes = records.length;
  await assert.rejects(
    driver.prepareRevision(other, { harnessAuth: context.harnessAuth }),
    /OAuth credentials belong to another Agent/,
  );
  // No Harness, seed writer, or seed Secret is created for the second Agent.
  assert.deepEqual(
    records
      .slice(writes)
      .filter(({ kind }) => kind === "Deployment" || kind === "Secret")
      .map(({ kind, metadata }) => `${kind}/${metadata.name}`),
    [],
  );
  assert.deepEqual(objects.get(sourceKey), consumed);
  // The owning Agent keeps its generation.
  const later = { ...revision, id: `${revision.id}-next`, revision: revision.revision + 1 };
  assert.equal((await driver.prepareRevision(later, context)).ready, true);
});

for (const embedded of [true, false]) {
  test(`Kubernetes ${embedded ? "embedded" : "dedicated"} setup stays private and retains only its completion guard`, async () => {
    const { driver, revision, objects, records, state, setup, context } =
      workspaceSetupFixture(embedded);
    const pending = await driver.prepareRevision(revision, context);
    assert.equal(pending.ready, false);
    const secret = [...objects.values()].find(
      ({ kind, metadata }) => kind === "Secret" && metadata.name.startsWith("workspace-setup-"),
    );
    assert.deepEqual(JSON.parse(Buffer.from(secret.data["setup.json"], "base64")), setup);
    const gateway = [...objects.values()].find(
      ({ kind, metadata }) => kind === "Deployment" && metadata.name.startsWith("gateway-"),
    );
    const harness = [...objects.values()].find(
      ({ kind, metadata }) => kind === "Deployment" && metadata.name.startsWith("agent-"),
    );
    const pod = (embedded ? gateway : harness).spec.template.spec;
    if (!embedded) {
      const gatewayPod = gateway.spec.template.spec;
      assert.equal(
        gatewayPod.initContainers.some(({ name }) => name === "initialize-workspace"),
        false,
      );
      assert.equal(
        gatewayPod.volumes.some(({ name }) => name === "shared-workspace"),
        false,
      );
      assert.equal(containerProgram(gatewayPod.containers[0]).includes(setup.id), false);
    }
    if (!embedded) {
      assert.throws(
        () => driver.harnessRequirementsFromDeployment(harness, "api_key"),
        /cannot deliver workspace initialization/,
      );
      // Leaving OAuth removes the persisted personal login before the non-OAuth Harness starts.
      const privateState = pod.initContainers.find(({ name }) => name === "prepare-private-state");
      assert.match(privateState.args[0], /rmSync\("\/harness-workspace-state\/codex-home"/);
    }
    const initializer = pod.initContainers.find(({ name }) => name === "initialize-workspace");
    assert.equal(initializer.image, driver.options.images.gateway);
    assert.deepEqual(initializer.resources, driver.options.resources.gateway);
    // Container restarts do not rerun initContainers; the workspace owner checks its marker.
    assert.equal(containerProgram(pod.containers[0]).includes(setup.id), true);
    assert.equal(
      initializer.volumeMounts.find(({ name }) => name === "workspace-setup").readOnly,
      true,
    );
    assert.equal(
      pod.containers[0].volumeMounts.some(({ name }) => name === "workspace-setup"),
      false,
    );
    const durable = initializer.volumeMounts.find(
      ({ mountPath }) =>
        mountPath === (embedded ? "/home/node/.openclaw/workspace" : "/home/node/workspace"),
    );
    assert.equal(durable.subPath, "workspace");
    assert.ok(pod.volumes.find(({ name }) => name === durable.name).persistentVolumeClaim);
    for (const object of records.filter(({ kind }) => kind !== "Secret")) {
      assert.equal(JSON.stringify(object).includes(setup.files["AGENTS.md"]), false);
      // Compressed programs would hide document bytes from the plain-text check.
      for (const container of object.spec?.template?.spec?.containers ?? []) {
        if (container.args?.[0] === nodeProgramArguments("")[0]) {
          assert.equal(containerProgram(container).includes(setup.files["AGENTS.md"]), false);
        }
      }
    }
    if (!embedded) {
      const harness = [...objects.values()].find(
        ({ kind, metadata }) => kind === "Deployment" && metadata.name.startsWith("agent-"),
      );
      // The actual command sent to either Kubernetes or an external Sandbox carries only identity.
      const program = containerProgram(harness.spec.template.spec.containers[0]);
      assert.equal(program.includes(setup.id), true);
      assert.equal(program.includes(setup.files["AGENTS.md"]), false);
    }
    state.ready = true;
    assert.equal((await driver.prepareRevision(revision, context)).ready, true);
    const completed = JSON.parse(
      Buffer.from(
        objects.get(`Secret:${secret.metadata.namespace}:${secret.metadata.name}`).data[
          "setup.json"
        ],
        "base64",
      ),
    );
    assert.equal(completed.completed, true);
    assert.equal(Object.hasOwn(completed, "files"), false);
    // Lost acknowledgement retries the old pending context without rehydrating discarded bytes.
    const before = records.filter(({ kind }) => kind === "Secret").length;
    assert.equal((await driver.prepareRevision(revision, context)).ready, true);
    assert.equal(records.filter(({ kind }) => kind === "Secret").length, before);
    await driver.retireRevision(revision);
    await driver.deleteAgentRuntimeCredentials({
      namespace: tenant,
      agent: { id: revision.agentId, namespaceId: tenant.id, executionMode: revision.harness.mode },
    });
    assert.equal(objects.has(`Secret:${secret.metadata.namespace}:${secret.metadata.name}`), false);
  });
}

test("rendered exec arguments and environment values stay within the per-string budget", async () => {
  for (const embedded of [true, false]) {
    const { driver, revision, objects, state, context } = workspaceSetupFixture(embedded);
    await driver.prepareRevision(revision, context);
    // Readiness admits the dedicated workspace node, whose supervisor embeds Codex.
    state.ready = true;
    await driver.prepareRevision(revision, context);
    const workloads = [...objects.values()].filter(({ kind }) => kind === "Deployment");
    // Every runtime wrapper runs under tini, so it is never PID 1: a Pod stop's
    // SIGTERM ends it in every startup phase, not only once it installs a handler.
    for (const { spec } of workloads) {
      assert.deepEqual(spec.template.spec.containers[0].command, [...RUNTIME_WRAPPER_COMMAND]);
    }
    assertExecStringsWithinBudget(workloads);
    for (const { spec } of workloads) {
      // Runtime programs travel as bounded pieces and arrive intact.
      const program = containerProgram(spec.template.spec.containers[0]);
      assert.ok(
        [GATEWAY_RUNTIME_ENTRYPOINT, AGENT_RUNTIME_ENTRYPOINT, AGENT_WITH_NODE_ENTRYPOINT].some(
          (entrypoint) => program.endsWith(entrypoint),
        ),
      );
    }
  }
  // The supervisor restarts Codex from the same bounded pieces.
  assert.ok(
    AGENT_WITH_NODE_ENTRYPOINT.includes(
      JSON.stringify(["-e", ...nodeProgramArguments(AGENT_RUNTIME_ENTRYPOINT)]),
    ),
  );
});

test(
  "the program loader runs a program above the exec argument limit as node -e would",
  {
    skip: process.platform !== "linux" && "MAX_ARG_STRLEN is a Linux limit.",
  },
  () => {
    // Incompressible padding keeps several pieces after compression.
    const padding = `// ${randomBytes(150 * 1024).toString("base64")}\n`;
    const program = `${padding}const observed = { argv: process.argv.slice(1), file: __filename,
    required: typeof require("node:fs").readFileSync };
process.stdout.write(JSON.stringify(observed));
process.exitCode = 3;`;
    const pieces = nodeProgramArguments(program);
    assert.ok(pieces.length > 2);
    assert.equal(spawnSync(process.execPath, ["-e", program]).error?.code, "E2BIG");
    const loaded = spawnSync(process.execPath, ["-e", ...pieces], { encoding: "utf8" });
    const direct = spawnSync(process.execPath, ["-e", program.slice(padding.length)], {
      encoding: "utf8",
    });
    assert.equal(loaded.stderr, "");
    assert.deepEqual([loaded.status, loaded.stdout], [direct.status, direct.stdout]);
    assert.deepEqual(JSON.parse(loaded.stdout), { argv: [], file: "[eval]", required: "function" });
    assert.equal(loaded.status, 3);
  },
);

test("Kubernetes workspace setup rejects foreign identities and unsupported storage before delivery", async () => {
  for (const mutate of [
    ...[
      null,
      "invalid",
      { list: [] },
      { entries: null },
      { entries: [] },
      { entries: {} },
      { entries: { main: null } },
      { entries: { other: {} } },
      { entries: { main: {}, other: {} } },
    ].map((agents) => ({ revision }) => {
      revision.configuration.agents = agents;
    }),
    ({ context }) => {
      context.workspaceSetup.agentId = "another-agent";
    },
    ({ revision }) => {
      revision.configuration.agents.defaults.workspace = "/tmp/unmanaged";
    },
    ({ revision }) => {
      revision.configuration.agents.entries = { main: { workspace: "/tmp/unmanaged" } };
    },
  ]) {
    const fixture = workspaceSetupFixture(true);
    mutate(fixture);
    await assert.rejects(
      fixture.driver.prepareRevision(fixture.revision, fixture.context),
      /Workspace setup/,
    );
    assert.equal(fixture.records.length, 0);
  }
});

test("Kubernetes workspace setup redacts backend failures and refuses foreign private delivery", async () => {
  const fixture = workspaceSetupFixture(true);
  fixture.state.secretFailure = true;
  await assert.rejects(fixture.driver.prepareRevision(fixture.revision, fixture.context), {
    message: "Workspace setup private delivery is unavailable.",
  });
  fixture.state.secretFailure = false;
  await fixture.driver.prepareRevision(fixture.revision, fixture.context);
  const secret = [...fixture.objects.values()].find(
    ({ kind, metadata }) => kind === "Secret" && metadata.name.startsWith("workspace-setup-"),
  );
  secret.metadata.annotations["openclaw.dev/agent-id"] = "another-agent";
  const before = fixture.records.length;
  await assert.rejects(fixture.driver.prepareRevision(fixture.revision, fixture.context), {
    message: "Workspace setup private delivery is unavailable.",
  });
  assert.equal(fixture.records.length, before);
});

for (const embedded of [true, false]) {
  test(`Kubernetes ${embedded ? "embedded" : "dedicated"} failed workspace initialization reports safe evidence and retains retry content`, async () => {
    const fixture = workspaceSetupFixture(embedded);
    fixture.state.failedInitializer = true;
    const result = await fixture.driver.prepareRevision(fixture.revision, fixture.context);
    assert.equal(result.ready, false);
    assert.deepEqual(result.runtimeFailure, {
      component: embedded ? "gateway" : "agent",
      check: "workspace-setup",
      code: "WORKSPACE_SETUP_FAILED",
      checkedAt: "2026-09-22T00:00:00Z",
    });
    const secret = [...fixture.objects.values()].find(
      ({ kind, metadata }) => kind === "Secret" && metadata.name.startsWith("workspace-setup-"),
    );
    assert.deepEqual(JSON.parse(Buffer.from(secret.data["setup.json"], "base64")), fixture.setup);
  });
}

for (const method of ["api_key", "codex_pat"]) {
  test(`dedicated ${method} preparation places Gateway state and credentials in its owned control-plane target`, async () => {
    const fixture = workspaceSetupFixture(false);
    const { driver, revision, namespace, context, objects, records } = fixture;
    revision.harnessAuth = { ...revision.harnessAuth, method };
    context.harnessAuth = { ...context.harnessAuth, method };
    const modelEnvironment = method === "api_key" ? "OPENAI_API_KEY" : "CODEX_ACCESS_TOKEN";
    const cp = kubernetesGatewayNamespaceName(tenant.id);
    const channel = {
      ...driver.manifest(
        "v1",
        "Secret",
        "channel-source",
        { namespaceId: tenant.id },
        { name: cp, plane: "execution" },
      ),
      data: { value: Buffer.from("fixture-channel-token").toString("base64") },
    };
    channel.metadata.uid = "channel-source-uid";
    objects.set(`Secret:${cp}:channel-source`, channel);
    const source = { kind: "secret", namespaceId: tenant.id, id: "sec_channel" };
    revision.secretDriverId = "kubernetes-secret";
    revision.secretBindings = { SLACK_BOT_TOKEN: { source } };
    context.secretEnvironment = [
      {
        name: "SLACK_BOT_TOKEN",
        namespaceId: tenant.id,
        agentId: revision.agentId,
        secretId: source.id,
        backendRef: {
          name: "channel-source",
          namespaceName: cp,
          key: "value",
          uid: channel.metadata.uid,
        },
      },
    ];
    await driver.prepareRevision(revision, context);
    const gatewayNamespace = kubernetesGatewayNamespaceName(tenant.id);
    assert.notEqual(gatewayNamespace, namespace);
    const values = [...objects.values()];
    const gateway = values.find(
      ({ kind, metadata }) => kind === "Deployment" && metadata.name.startsWith("gateway-"),
    );
    const harness = values.find(
      ({ kind, metadata }) => kind === "Deployment" && metadata.name.startsWith("agent-"),
    );
    assert.equal(gateway.metadata.namespace, gatewayNamespace);
    assert.equal(harness.metadata.namespace, namespace);
    assert.equal(gateway.spec.template.spec.automountServiceAccountToken, false);
    assert.equal(
      gateway.spec.template.spec.volumes.some(({ name }) => name === "openclaw-service-principal"),
      false,
    );
    const env = Object.fromEntries(
      gateway.spec.template.spec.containers[0].env.map((item) => [item.name, item]),
    );
    assert.equal(
      env.APP_SERVER_URL.value,
      `ws://agent-${digest(revision.agentId)}.${namespace}.svc:18790`,
    );
    assert.equal(env.OPENAI_API_KEY, undefined);
    const copied = values.find(
      ({ kind, metadata }) =>
        kind === "Secret" &&
        metadata.namespace === gatewayNamespace &&
        metadata.name.startsWith("transport-"),
    );
    assert.deepEqual(Object.keys(copied.data), ["app-server-token"]);
    assert.equal(env.APP_SERVER_TOKEN.valueFrom.secretKeyRef.name, copied.metadata.name);
    assert.deepEqual(env.SLACK_BOT_TOKEN.valueFrom.secretKeyRef, {
      name: "channel-source",
      key: "value",
      optional: false,
    });
    const material = values.find(
      ({ kind, metadata }) =>
        kind === "Secret" &&
        metadata.namespace === namespace &&
        metadata.name.startsWith("harness-secrets-"),
    );
    assert.deepEqual(Object.keys(material.data).sort(), [modelEnvironment, "app-server-token"]);
    assert.equal(JSON.stringify(harness).includes("channel-source"), false);
    assert.equal(JSON.stringify(harness).includes("gateway-password"), false);
    const model = objects.get(`Secret:${cp}:occ-model-key`);
    assert.equal(material.data[modelEnvironment], model.data.value);
    const writesBefore = records.length;
    model.metadata.uid = "replaced-model-source";
    await assert.rejects(
      driver.prepareRevision(revision, context),
      /credential source identity changed/,
    );
    assert.equal(
      records.slice(writesBefore).some(({ kind }) => kind === "Deployment"),
      false,
    );
    const gatewayClaim = values.find(
      ({ kind, metadata }) =>
        kind === "PersistentVolumeClaim" && metadata.name.startsWith("gateway-state-"),
    );
    const harnessClaim = values.find(
      ({ kind, metadata }) =>
        kind === "PersistentVolumeClaim" && metadata.name.startsWith("workspace-"),
    );
    assert.equal(gatewayClaim.metadata.namespace, gatewayNamespace);
    assert.equal(harnessClaim.metadata.namespace, namespace);
    for (const record of records.filter((item) => item.kind !== "Secret")) {
      assert.equal(JSON.stringify(record).includes("test-transport"), false);
    }
    const policies = driver
      .agentNetworkPolicies(revision, { name: namespace, plane: "execution" })
      .map(({ resource }) => resource);
    const egress = policies.find((item) => item.metadata.name.startsWith("allow-gateway-agent-"));
    const ingress = policies.find((item) => item.metadata.name.startsWith("allow-agent-runtime-"));
    assert.equal(egress.metadata.namespace, gatewayNamespace);
    assert.equal(ingress.metadata.namespace, namespace);
    assert.deepEqual(egress.spec.egress[0].to[0].namespaceSelector.matchLabels, {
      "kubernetes.io/metadata.name": namespace,
    });
    assert.deepEqual(ingress.spec.ingress[0].from[0].namespaceSelector.matchLabels, {
      "kubernetes.io/metadata.name": gatewayNamespace,
    });
    assert.equal(
      egress.spec.egress[0].to[0].podSelector.matchLabels["openclaw.dev/revision"],
      revision.id,
    );
    assert.equal(
      ingress.spec.ingress[0].from[0].podSelector.matchLabels["openclaw.dev/agent"],
      revision.agentId,
    );
  });
}

for (const embedded of [true, false]) {
  test(`Kubernetes ${embedded ? "embedded" : "dedicated"} stop removes the stopped revision's credential copies and snapshots`, async () => {
    const { driver, revision, namespace, context, objects } = workspaceSetupFixture(embedded);
    revision.harnessAuth = { ...revision.harnessAuth, method: "api_key" };
    context.harnessAuth = { ...context.harnessAuth, method: "api_key" };
    await driver.prepareRevision(revision, context);
    const revisionSuffix = `${digest(revision.agentId)}-${digest(revision.id)}`;
    const revisionScoped = () =>
      [...objects.values()]
        .filter(
          ({ kind, metadata }) =>
            (kind === "Secret" || kind === "ConfigMap") &&
            metadata.name.endsWith(digest(revision.id)),
        )
        .map(({ kind, metadata }) => `${kind}:${metadata.name}`)
        .sort();
    assert.ok(
      revisionScoped().includes(`Secret:harness-secrets-${revisionSuffix}`),
      "preparation projects the model credential into a per-revision Secret",
    );
    assert.ok(
      revisionScoped().includes(
        `ConfigMap:gateway-${digest(revision.agentId)}-rev-${digest(revision.id)}`,
      ),
    );
    await driver.stopRevision(revision);
    // A stopped revision keeps no copy of its credentials; preparing it again re-projects them.
    assert.deepEqual(revisionScoped(), []);
    assert.ok(objects.has(`Namespace::${namespace}`));
    assert.ok(
      [...objects.values()].some(
        ({ kind, metadata }) => kind === "Secret" && metadata.name === "occ-model-key",
      ),
      "the canonical control-plane source is retained",
    );
    await driver.prepareRevision(revision, context);
    assert.ok(revisionScoped().includes(`Secret:harness-secrets-${revisionSuffix}`));
  });
}

test("dedicated Harness Service selector satisfies the gateway policy during cutover", async () => {
  const fixture = workspaceSetupFixture(false);
  const { driver, revision, namespace, objects, state } = fixture;
  const gatewayNamespace = kubernetesGatewayNamespaceName(tenant.id);
  const serviceName = `agent-${digest(revision.agentId)}`;
  const serviceKey = `Service:${namespace}:${serviceName}`;
  const gatewayName = `gateway-${digest(revision.agentId)}`;
  const gatewayServiceKey = `Service:${gatewayNamespace}:${gatewayName}`;
  const policyKey = (selectedRevision) =>
    `NetworkPolicy:${gatewayNamespace}:allow-gateway-agent-${digest(selectedRevision.agentId)}`;
  const serviceSelector = () => objects.get(serviceKey).spec.selector;
  const gatewayServiceSelector = () => objects.get(gatewayServiceKey).spec.selector;
  const gatewayTargetSelector = (selectedRevision) =>
    objects.get(policyKey(selectedRevision)).spec.egress[0].to[0].podSelector.matchLabels;
  const gatewayTargetNamespace = (selectedRevision) =>
    objects.get(policyKey(selectedRevision)).spec.egress[0].to[0].namespaceSelector.matchLabels;
  const storeTransportSecret = (selectedRevision) => {
    const name = `transport-${digest(selectedRevision.agentId)}`;
    objects.set(`Secret:${gatewayNamespace}:${name}`, {
      ...driver.manifest(
        "v1",
        "Secret",
        name,
        { namespaceId: selectedRevision.namespaceId, agentId: selectedRevision.agentId },
        { name: gatewayNamespace, plane: "control" },
      ),
      type: "Opaque",
      metadata: {
        ...driver.manifest(
          "v1",
          "Secret",
          name,
          { namespaceId: selectedRevision.namespaceId, agentId: selectedRevision.agentId },
          { name: gatewayNamespace, plane: "control" },
        ).metadata,
        uid: `${name}-uid`,
        resourceVersion: "1",
      },
      data: { "app-server-token": Buffer.from("test-transport").toString("base64") },
    });
  };
  const assertServiceSatisfiesGatewayPolicy = (selectedRevision) => {
    const selector = serviceSelector();
    const target = gatewayTargetSelector(selectedRevision);
    assert.deepEqual(gatewayTargetNamespace(selectedRevision), {
      "kubernetes.io/metadata.name": namespace,
    });
    // EKS resolves policy peers before destination translation, so the Service
    // must include every peer label, including the Harness network profile.
    assert.equal(target["openclaw.dev/network-profile"], "broad-egress-v1");
    for (const [name, value] of Object.entries(target)) {
      assert.equal(selector[name], value, `${name} must match the gateway egress selector`);
    }
    assert.equal(
      selector["app.kubernetes.io/name"],
      `${serviceName}-rev-${digest(selectedRevision.id)}`,
    );
    assert.equal(selector["openclaw.dev/namespace"], selectedRevision.namespaceId);
    assert.equal(selector["openclaw.dev/agent"], selectedRevision.agentId);
    assert.equal(selector["openclaw.dev/revision"], selectedRevision.id);
    assert.equal(selector["openclaw.dev/workload-role"], "agent");
  };
  const assertGatewayServiceSatisfiesIngressPolicy = (selectedRevision) => {
    const selector = gatewayServiceSelector();
    const ingressPolicy = driver
      .networkPolicies(
        { namespaceId: selectedRevision.namespaceId },
        { name: gatewayNamespace, plane: "control" },
      )
      .find(({ metadata }) => metadata.name === "allow-gateway-ingress");
    const target = ingressPolicy.spec.podSelector.matchLabels;
    // Service selectors intentionally stay profile-free; the policy selector carries it.
    assert.equal(target["openclaw.dev/network-profile"], "broad-egress-v1");
    for (const [name, value] of Object.entries(target)) {
      if (name === "openclaw.dev/network-profile") {
        continue;
      }
      assert.equal(selector[name], value, `${name} must match the gateway ingress selector`);
    }
    assert.equal(selector["app.kubernetes.io/name"], gatewayName);
    assert.equal(selector["openclaw.dev/namespace"], selectedRevision.namespaceId);
    assert.equal(selector["openclaw.dev/agent"], selectedRevision.agentId);
    assert.equal(selector["openclaw.dev/workload-role"], "gateway");
    assert.equal(selector["openclaw.dev/revision"], undefined);
  };

  state.ready = true;
  assert.equal((await driver.prepareRevision(revision, authContext(revision))).ready, true);
  await driver.activateRevision(revision, authContext(revision));
  assertServiceSatisfiesGatewayPolicy(revision);
  assertGatewayServiceSatisfiesIngressPolicy(revision);

  const successor = {
    ...revision,
    id: "revision-selector-successor",
    revision: revision.revision + 1,
  };
  assert.equal((await driver.prepareRevision(successor, authContext(successor))).ready, true);
  assert.equal(serviceSelector()["openclaw.dev/revision"], revision.id);

  await driver.activateRevision(successor, authContext(successor));
  assertServiceSatisfiesGatewayPolicy(successor);
  assertGatewayServiceSatisfiesIngressPolicy(successor);

  const sibling = {
    ...revision,
    agentId: "agent-selector-sibling",
    id: "revision-selector-sibling",
    servicePrincipalId: "service-principal-selector-sibling",
  };
  storeTransportSecret(sibling);
  assert.equal((await driver.prepareRevision(sibling, authContext(sibling))).ready, true);
  await driver.activateRevision(sibling, authContext(sibling));
  const siblingSelector = objects.get(`Service:${namespace}:agent-${digest(sibling.agentId)}`).spec
    .selector;
  assert.equal(siblingSelector["openclaw.dev/namespace"], sibling.namespaceId);
  assert.equal(siblingSelector["openclaw.dev/agent"], sibling.agentId);
  assert.equal(siblingSelector["openclaw.dev/revision"], sibling.id);
  assert.notEqual(
    siblingSelector["openclaw.dev/agent"],
    gatewayTargetSelector(successor)["openclaw.dev/agent"],
  );
  assert.notEqual(
    siblingSelector["openclaw.dev/revision"],
    gatewayTargetSelector(successor)["openclaw.dev/revision"],
  );

  await driver.deactivateRevision(successor);
  assert.deepEqual(serviceSelector(), { "app.kubernetes.io/name": `${serviceName}-inactive` });
});

// Agent-scoped policies have one name per Agent. Preparing a successor must not
// point them only at its own revision while the predecessor still serves. The
// worker keeps an embedded predecessor serving; it stops a dedicated one first,
// but the driver must not depend on that ordering.
for (const embedded of [true, false]) {
  test(`${embedded ? "embedded" : "dedicated"} successor preparation keeps the serving predecessor's grants`, async () => {
    const { driver, revision, namespace, objects, state, context } = workspaceSetupFixture(
      embedded,
      true,
      { pluginStatusProxySourceCidrs: ["192.0.2.20/32"] },
    );
    const suffix = digest(revision.agentId);
    const gatewayNamespace = embedded ? namespace : kubernetesGatewayNamespaceName(tenant.id);
    const policy = (target, name) => objects.get(`NetworkPolicy:${target}:${name}-${suffix}`);
    const harnessLabels = (selected) =>
      objects.get(
        embedded
          ? `Deployment:${namespace}:gateway-${suffix}`
          : `Deployment:${namespace}:agent-${suffix}-rev-${digest(selected.id)}`,
      ).spec.template.metadata.labels;
    const grants = () =>
      embedded
        ? [policy(namespace, "allow-plugin-status-proxy").spec.podSelector]
        : [
            policy(gatewayNamespace, "allow-gateway-agent").spec.egress[0].to[0].podSelector,
            policy(namespace, "allow-agent-runtime").spec.podSelector,
            policy(namespace, "allow-plugin-status-proxy").spec.podSelector,
          ];
    state.ready = true;
    assert.equal(await prepareUntilReady(driver, revision, context), 1);
    await driver.activateRevision(revision, context);
    const predecessor = structuredClone(harnessLabels(revision));
    assert.equal(predecessor["openclaw.dev/revision"], revision.id);

    const successor = { ...revision, id: "grant-successor", revision: revision.revision + 1 };
    const successorContext = { ...context, ...authContext(successor) };
    assert.equal(await prepareUntilReady(driver, successor, successorContext), 1);
    for (const selector of grants()) {
      assert.equal(selectorMatches(selector, predecessor), true, JSON.stringify(selector));
      assert.equal(
        selectorMatches(selector, { ...predecessor, "openclaw.dev/agent": "another" }),
        false,
      );
      if (!embedded) {
        assert.equal(selectorMatches(selector, harnessLabels(successor)), true);
      }
    }

    // Activation pins the grants to the revision that now serves.
    await driver.activateRevision(successor, successorContext);
    for (const selector of grants()) {
      assert.equal(selectorMatches(selector, predecessor), false, JSON.stringify(selector));
      assert.equal(selectorMatches(selector, harnessLabels(successor)), true);
    }
  });
}

test("dedicated Harness deactivation still closes pre-upgrade Service selectors", async () => {
  const fixture = workspaceSetupFixture(false);
  const { driver, revision, namespace, objects, state } = fixture;
  const serviceName = `agent-${digest(revision.agentId)}`;
  const serviceKey = `Service:${namespace}:${serviceName}`;

  state.ready = true;
  assert.equal((await driver.prepareRevision(revision, authContext(revision))).ready, true);
  await driver.activateRevision(revision, authContext(revision));

  delete objects.get(serviceKey).spec.selector["openclaw.dev/namespace"];
  await driver.deactivateRevision(revision);
  assert.deepEqual(objects.get(serviceKey).spec.selector, {
    "app.kubernetes.io/name": `${serviceName}-inactive`,
  });
});

test("dedicated Gateway references canonical CP channel Secrets and rejects a replaced source", async () => {
  const { driver, revision, namespace, objects, records } = workspaceSetupFixture(false);
  const target = kubernetesGatewayNamespaceName(tenant.id);
  const source = {
    ...driver.manifest(
      "v1",
      "Secret",
      "channel-source",
      { namespaceId: tenant.id },
      { name: target, plane: "execution" },
    ),
    data: {
      token: Buffer.from("channel-token").toString("base64"),
      unrelated: Buffer.from("not-admitted").toString("base64"),
    },
  };
  source.metadata.uid = "channel-source-uid";
  objects.set(`Secret:${target}:channel-source`, source);
  const projection = {
    name: "SLACK_BOT_TOKEN",
    namespaceId: revision.namespaceId,
    agentId: revision.agentId,
    secretId: "channel-secret",
    backendRef: {
      name: "channel-source",
      namespaceName: target,
      key: "token",
      uid: source.metadata.uid,
    },
  };
  assert.deepEqual(
    await driver.deliverGatewaySecrets(
      revision,
      { name: namespace, plane: "execution" },
      { name: target, plane: "execution" },
      [projection],
    ),
    [projection],
  );
  assert.equal(records.length, 0, "direct references must not create copies");
  source.metadata.uid = "replaced-secret";
  await assert.rejects(
    driver.deliverGatewaySecrets(
      revision,
      { name: namespace, plane: "execution" },
      { name: target, plane: "execution" },
      [projection],
    ),
    /Gateway credential source is unavailable/,
  );
  await assert.rejects(
    driver.deliverGatewaySecrets(
      revision,
      { name: namespace, plane: "execution" },
      { name: target, plane: "execution" },
      [{ ...projection, backendRef: { ...projection.backendRef, namespaceName: namespace } }],
    ),
    /outside the admitted scope/,
  );
});

test("a missing or foreign Gateway namespace never falls back to the Harness target", async () => {
  for (const foreign of [false, true]) {
    const { driver, revision, context, objects, records } = workspaceSetupFixture(false);
    const key = `Namespace::${kubernetesGatewayNamespaceName(tenant.id)}`;
    if (foreign) {
      objects.get(key).metadata.annotations["openclaw.dev/namespace-id"] = "another-tenant";
    } else {
      objects.delete(key);
    }
    await assert.rejects(driver.prepareRevision(revision, context), /Gateway namespace/);
    assert.equal(records.length, 0);
  }
});

for (const embedded of [true, false]) {
  for (const surviving of ["Deployment", "HTTPRoute"]) {
    test(`retiring ${embedded ? "embedded" : "dedicated"} preserves other-mode runtime with surviving ${surviving}`, async () => {
      const { driver, revision, namespace, objects } = workspaceSetupFixture(embedded);
      const successor = {
        ...revision,
        id: "successor-revision",
        revision: revision.revision + 1,
        harness: embedded
          ? { id: "codex", version: "1.0.0", mode: "dedicated" }
          : { id: "openclaw", version: "1.0.0", mode: "embedded" },
      };
      const control = kubernetesGatewayNamespaceName(revision.namespaceId);
      const oldTarget = embedded ? namespace : control;
      const nextTarget = embedded ? control : namespace;
      const suffix = digest(revision.agentId);
      const gatewayName = `gateway-${suffix}`;
      const agentName = `agent-${suffix}`;
      const owner = { namespaceId: revision.namespaceId, agentId: revision.agentId };
      const save = (kind, name, target, selected = undefined, principal = false) => {
        const resource = driver.manifest(
          kind === "Deployment" ? "apps/v1" : "v1",
          kind,
          name,
          {
            ...owner,
            ...(principal ? { servicePrincipalId: revision.servicePrincipalId } : {}),
            ...(selected ? { revisionId: selected.id } : {}),
          },
          { name: target, plane: "execution" },
        );
        resource.metadata.uid = `${target}-${name}-uid`;
        resource.metadata.resourceVersion = "1";
        if (selected) {
          resource.metadata.annotations["openclaw.dev/agent-revision-id"] = selected.id;
        }
        objects.set(`${kind}:${target}:${name}`, resource);
        return resource;
      };
      save("Deployment", gatewayName, oldTarget, revision);
      save("Service", gatewayName, oldTarget);
      save("ServiceAccount", gatewayName, oldTarget);
      save(surviving, gatewayName, nextTarget, successor);
      save("Service", agentName, namespace, undefined, true);
      save("ServiceAccount", agentName, namespace, undefined, true);
      for (const name of [
        "allow-agent-runtime",
        "allow-agent-auth",
        "allow-plugin-status-proxy",
        "allow-plugin-status-agent",
      ]) {
        save(
          "NetworkPolicy",
          `${name}-${suffix}`,
          namespace,
          undefined,
          name === "allow-agent-auth",
        );
      }
      for (const name of [
        "allow-gateway-agent",
        "allow-gateway-channels",
        "allow-plugin-status-gateway",
      ]) {
        save("NetworkPolicy", `${name}-${suffix}`, oldTarget);
      }
      const preserved = new Map(
        [...objects]
          .filter(
            ([key]) =>
              key === `${surviving}:${nextTarget}:${gatewayName}` ||
              key === `Service:${namespace}:${agentName}` ||
              key === `ServiceAccount:${namespace}:${agentName}` ||
              key.startsWith(`NetworkPolicy:${namespace}:allow-agent-`) ||
              key === `NetworkPolicy:${namespace}:allow-plugin-status-proxy-${suffix}` ||
              key === `NetworkPolicy:${namespace}:allow-plugin-status-agent-${suffix}`,
          )
          .map(([key, value]) => [key, structuredClone(value)]),
      );
      await driver.retireRevision(revision);
      await driver.retireRevision(revision);
      for (const [key, value] of preserved) {
        assert.deepEqual(objects.get(key), value, key);
      }
      for (const kind of ["Deployment", "Service", "ServiceAccount"]) {
        assert.equal(objects.has(`${kind}:${oldTarget}:${gatewayName}`), false);
      }
      for (const name of [
        "allow-gateway-agent",
        "allow-gateway-channels",
        "allow-plugin-status-gateway",
      ]) {
        assert.equal(objects.has(`NetworkPolicy:${oldTarget}:${name}-${suffix}`), false);
      }
    });
  }
}

for (const embedded of [true, false]) {
  test(`fixture ${embedded ? "embedded" : "dedicated"} Pods consume model credentials from their own namespace`, async () => {
    const { driver, revision, objects } = workspaceSetupFixture(embedded, false);
    await driver.prepareRevision(revision, authContext(revision));
    const workloads = [...objects.values()].filter(({ kind }) => kind === "Deployment");
    assert.equal(workloads.length, embedded ? 1 : 2);
    let modelConsumers = 0;
    for (const workload of workloads) {
      for (const container of workload.spec.template.spec.containers) {
        for (const environment of container.env ?? []) {
          const ref = environment.valueFrom?.secretKeyRef;
          if (!ref) {
            continue;
          }
          const secret = objects.get(`Secret:${workload.metadata.namespace}:${ref.name}`);
          assert.ok(secret, `${environment.name} must resolve in the Pod namespace`);
          assert.ok(secret.data[ref.key]);
          if (environment.name === "OPENAI_API_KEY") {
            modelConsumers++;
          }
        }
      }
    }
    assert.equal(modelConsumers, 1);
  });
}

test("runtime image provenance survives missing metadata but never crosses Pod or image identity", async () => {
  const driver = new KubernetesComputeDriver(options());
  const revision = routedRevision(driver);
  const commit = "a".repeat(40);
  let generation = 1;
  let mode = "ready";
  driver.apiClients = Promise.resolve({
    core: {
      async listNamespace() {
        return { items: [] };
      },
      async listNamespacedPod({ namespace, labelSelector }) {
        const labels = Object.fromEntries(
          labelSelector.split(",").map((entry) => entry.split("=")),
        );
        const role = labels["openclaw.dev/workload-role"];
        return {
          items: [
            {
              metadata: { name: `${role}-pod`, namespace, labels, uid: `${role}-${generation}` },
              spec: {
                containers: [
                  { name: role, image: "runtime:mutable" },
                  { name: "sidecar", image: "sidecar:1" },
                ],
                initContainers: [{ name: "initialize", image: "runtime:mutable" }],
              },
              status: {
                containerStatuses: [
                  { name: role, imageID: "sha256:runtime", containerID: `${role}-${generation}` },
                  { name: "sidecar", imageID: "sha256:sidecar", containerID: "sidecar" },
                ],
                initContainerStatuses: [{ name: "initialize", imageID: "sha256:runtime" }],
              },
            },
          ],
        };
      },
      async connectGetNamespacedPodProxyWithPath() {
        if (mode === "restart") {
          generation += 1;
        }
        if (mode === "missing") {
          throw Object.assign(new Error("not found"), { statusCode: 404 });
        }
        if (mode === "timeout") {
          return new Promise((resolve, reject) => {
            const signal = currentComputeAbortSignal();
            const timer = setTimeout(
              () => reject(new Error("metadata deadline was not applied")),
              15_000,
            );
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(signal.reason);
              },
              { once: true },
            );
          });
        }
        return { commit, openclawCommit: "b".repeat(40), private: "must not escape" };
      },
    },
  });
  const images = await driver.getRuntimeImages(revision);
  assert.equal(images.length, 6);
  assert.deepEqual(
    new Set(images.map((image) => image.workload)),
    new Set([
      `${kubernetesGatewayNamespaceName(revision.namespaceId)}/gateway-pod`,
      `${kubernetesNamespaceName(revision.namespaceId)}/agent-pod`,
    ]),
  );
  assert.equal(images.filter((image) => image.commit === commit).length, 4);
  assert.equal(images.filter((image) => image.openclawCommit === "b".repeat(40)).length, 4);
  assert.ok(
    images
      .filter((image) => image.container === "sidecar")
      .every((image) => image.commit === null && image.openclawCommit === null),
  );
  assert.doesNotMatch(JSON.stringify(images), /must not escape/);
  for (mode of ["restart", "missing", "timeout"]) {
    const observed = await driver.getRuntimeImages(revision);
    assert.equal(observed.length, 6);
    assert.ok(
      observed.every(
        (image) => image.imageId !== null && image.commit === null && image.openclawCommit === null,
      ),
      mode,
    );
  }
});

// This checks the native document rendered by Compute, not live Slack delivery.
test("gateway configuration preserves Slack reply modes and native overrides", () => {
  const driver = createKubernetesComputeDriver(options());
  for (const policy of [
    {},
    { replyToModeByChatType: { channel: "all" }, dmPolicy: "disabled" },
    { replyToMode: "off" },
    {
      replyToMode: "all",
      replyToModeByChatType: { direct: "off", channel: "first" },
      channels: { CEXAMPLE: { replyToMode: "off" } },
    },
  ]) {
    const configuration = { channels: { slack: { enabled: true, mode: "socket", ...policy } } };
    const rendered = driver.kubernetesGatewayConfigurationDocument(configuration);
    assert.deepEqual(rendered.channels, configuration.channels);
  }
});

// These controls inspect real Driver policy and workload construction. Label
// matching below is only the Kubernetes selector contract; it is not a
// CNI/network-enforcement simulator or an admission authority.
const ORDINARY_PROFILE_LABEL = "openclaw.dev/network-profile";
const ORDINARY_PROFILE = "broad-egress-v1";
const UNAPPROVED_PROFILES = [undefined, "", "unknown-profile"];

function withProfile(labels, profile) {
  const changed = { ...labels };
  if (profile === undefined) {
    delete changed[ORDINARY_PROFILE_LABEL];
  } else {
    changed[ORDINARY_PROFILE_LABEL] = profile;
  }
  return changed;
}

function selectorMatches(selector, labels) {
  assert.deepEqual(selector.matchExpressions ?? [], []);
  return Object.entries(selector.matchLabels ?? {}).every(([key, value]) => labels[key] === value);
}

function profileNetworkDriver() {
  return createKubernetesComputeDriver(
    routedOptions({
      network: {
        pluginStatusProxySourceCidrs: ["192.0.2.20/32"],
        repositoryCredentials: {
          namespace: "repository-service",
          podLabels: { app: "repository" },
          port: 8443,
        },
      },
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
        channels: { proxyUrl: "http://192.0.2.15:3128" },
      },
    }),
  );
}

function profileNetworkRevision(driver, mode) {
  const base = routedRevision(driver);
  const embedded = mode === "embedded";
  return {
    ...base,
    id: `revision-network-${mode}`,
    agentId: `agent-network-${mode}`,
    servicePrincipalId: `principal-network-${mode}`,
    harness: { id: embedded ? "openclaw" : "codex", version: "1.0.0", mode },
    configuration: {
      ...base.configuration,
      agents: { defaults: { model: embedded ? "openai/gpt-5" : "codex/gpt-5" } },
    },
    plugins: {
      driver: { id: "codex-plugin", implementation: "occ/codex-plugin" },
      plugins: { "codex-plugin:example": { enabled: true, approvalMode: "auto" } },
    },
    repositoryCredentials: {
      driver: { id: "repository-credentials", implementation: "repository-credentials" },
      deadlineWallMs: Date.now() + 60_000,
      bindings: [
        {
          repositoryRef: "project",
          profile: "read",
          providerId: "github",
          grant: { providerInstanceId: "github-main", repositoryId: "project", grantId: "read" },
        },
      ],
    },
  };
}

// Builds the ordinary workload exactly as prepareRevision does for each role:
// the Gateway is Agent-scoped (its revision label comes from its configuration),
// the dedicated Harness is revision-scoped.
function profileNetworkWorkload(driver, revision, role) {
  const embedded = revision.harness.mode === "embedded";
  const executionNamespace = {
    name: kubernetesNamespaceName(revision.namespaceId),
    plane: "execution",
  };
  const namespace =
    role === "gateway" && !embedded
      ? { name: kubernetesGatewayNamespaceName(revision.namespaceId), plane: "control" }
      : executionNamespace;
  const ownership =
    role === "gateway"
      ? { namespaceId: revision.namespaceId, agentId: revision.agentId }
      : {
          namespaceId: revision.namespaceId,
          agentId: revision.agentId,
          servicePrincipalId: revision.servicePrincipalId,
          revisionId: revision.id,
        };
  return driver.deployment(
    `network-${role}`,
    ownership,
    namespace,
    `${role}:local`,
    `network-${role}`,
    role,
    {},
    "info",
    role === "gateway"
      ? driver.gatewayConfiguration(revision, undefined, executionNamespace)
      : undefined,
    role === "gateway" && embedded,
    role === "gateway" && embedded ? revision.servicePrincipalId : undefined,
    role === "agent" || embedded
      ? preparedAuth(driver, executionNamespace.name, embedded)
      : undefined,
  );
}

test("ordinary workload templates carry the network profile only outside the Deployment selector", () => {
  const driver = profileNetworkDriver();
  for (const [mode, role] of [
    ["embedded", "gateway"],
    ["dedicated", "gateway"],
    ["dedicated", "agent"],
  ]) {
    const workload = profileNetworkWorkload(driver, profileNetworkRevision(driver, mode), role);
    assert.equal(
      workload.spec.template.metadata.labels[ORDINARY_PROFILE_LABEL],
      ORDINARY_PROFILE,
      `${mode} ${role} template must be classified`,
    );
    assert.equal(workload.spec.template.metadata.labels["openclaw.dev/workload-role"], role);
    // The Deployment selector is immutable; the profile must never become part of it.
    assert.equal(workload.spec.selector.matchLabels[ORDINARY_PROFILE_LABEL], undefined);
    assert.equal(workload.metadata.labels[ORDINARY_PROFILE_LABEL], undefined);
  }
});

test("deployment readiness requires the ordinary network profile on the Pod template", () => {
  const driver = profileNetworkDriver();
  for (const [mode, role] of [
    ["embedded", "gateway"],
    ["dedicated", "gateway"],
    ["dedicated", "agent"],
  ]) {
    const workload = profileNetworkWorkload(driver, profileNetworkRevision(driver, mode), role);
    workload.metadata.generation = 1;
    workload.status = { observedGeneration: 1, readyReplicas: workload.spec.replicas };
    assert.equal(driver.deploymentReady(workload), true, `${mode} ${role} must be ready`);
    for (const profile of UNAPPROVED_PROFILES) {
      const unapproved = structuredClone(workload);
      unapproved.spec.template.metadata.labels = withProfile(
        unapproved.spec.template.metadata.labels,
        profile,
      );
      assert.equal(
        driver.deploymentReady(unapproved),
        false,
        `${mode} ${role} with profile ${JSON.stringify(profile)} must not be ready`,
      );
    }
  }
});

test("every ordinary allow policy requires the explicit network profile", () => {
  const driver = profileNetworkDriver();
  const dedicated = profileNetworkRevision(driver, "dedicated");
  const embedded = profileNetworkRevision(driver, "embedded");
  const execution = { name: kubernetesNamespaceName(tenant.id), plane: "execution" };
  const control = { name: kubernetesGatewayNamespaceName(tenant.id), plane: "control" };
  const ownership = { namespaceId: tenant.id };
  // Each generated policy is paired with the revision whose workloads it scopes.
  const sources = [
    ...driver.networkPolicies(ownership, execution).map((policy) => [policy, dedicated]),
    ...driver.networkPolicies(ownership, control).map((policy) => [policy, dedicated]),
    [driver.workspaceNodeNetworkPolicy(ownership, execution), dedicated],
    ...driver
      .agentNetworkPolicies(dedicated, execution)
      .map(({ resource }) => [resource, dedicated]),
    ...driver.agentNetworkPolicies(embedded, execution).map(({ resource }) => [resource, embedded]),
    [driver.agentAuthenticationNetworkPolicy(dedicated, execution), dedicated],
    [driver.channelNetworkPolicy(dedicated, [], control), dedicated],
  ];
  const d = digest(dedicated.agentId);
  const e = digest(embedded.agentId);
  const expected = [
    `${execution.name}/default-deny`,
    `${execution.name}/allow-dns`,
    `${execution.name}/allow-gateway-ingress`,
    `${control.name}/default-deny`,
    `${control.name}/allow-dns`,
    `${control.name}/allow-gateway-ingress`,
    `${execution.name}/allow-node-gateway`,
    `${control.name}/allow-gateway-agent-${d}`,
    `${execution.name}/allow-agent-runtime-${d}`,
    `${execution.name}/allow-plugin-status-proxy-${d}`,
    `${control.name}/allow-plugin-status-proxy-${d}`,
    `${control.name}/allow-plugin-status-gateway-${d}`,
    `${execution.name}/allow-plugin-status-agent-${d}`,
    `${execution.name}/allow-agent-runtime-${e}`,
    `${execution.name}/allow-plugin-status-proxy-${e}`,
    `${execution.name}/allow-agent-auth-${d}`,
    `${control.name}/allow-gateway-channels-${d}`,
  ];
  const checked = [];
  let workloadPeers = 0;
  for (const [policy, revision] of sources) {
    const key = `${policy.metadata.namespace}/${policy.metadata.name}`;
    assert.equal(checked.includes(key), false, `${key} must be generated once`);
    checked.push(key);
    const selector = policy.spec.podSelector;
    if (policy.metadata.name === "default-deny") {
      assert.deepEqual(selector, {});
      continue;
    }
    assert.equal(
      selector.matchLabels?.[ORDINARY_PROFILE_LABEL],
      ORDINARY_PROFILE,
      `${key} must select only the ordinary profile`,
    );
    // The generated ordinary workload for the selected role receives the grant; the
    // same Pod with a missing, empty, or unknown profile receives none.
    const role =
      selector.matchLabels["openclaw.dev/workload-role"] ??
      (revision.harness.mode === "embedded" ? "gateway" : "agent");
    const labels = profileNetworkWorkload(driver, revision, role).spec.template.metadata.labels;
    assert.equal(selectorMatches(selector, labels), true, `${key} must select its workload`);
    for (const profile of UNAPPROVED_PROFILES) {
      assert.equal(selectorMatches(selector, withProfile(labels, profile)), false, key);
    }
    for (const rule of [...(policy.spec.ingress ?? []), ...(policy.spec.egress ?? [])]) {
      for (const peer of [...(rule.from ?? []), ...(rule.to ?? [])]) {
        const peerLabels = peer.podSelector?.matchLabels;
        if (peerLabels?.["openclaw.dev/workload-role"] === undefined) {
          continue;
        }
        workloadPeers += 1;
        assert.equal(peerLabels[ORDINARY_PROFILE_LABEL], ORDINARY_PROFILE, `${key} peer`);
        assert.equal(peerLabels["openclaw.dev/namespace"], tenant.id, `${key} peer`);
        assert.ok(
          [execution.name, control.name].includes(
            peer.namespaceSelector.matchLabels["kubernetes.io/metadata.name"],
          ),
          `${key} peer namespace`,
        );
      }
    }
  }
  // An explicit list, not a count: a new or removed policy must be classified here.
  assert.deepEqual([...checked].sort(), [...expected].sort());
  // Gateway->Harness transport and plugin status, in both directions.
  assert.equal(workloadPeers, 4);
  // Dependency peers stay profile-free: they select platform Pods, not tenant workloads.
  const dns = driver
    .networkPolicies(ownership, execution)
    .find((policy) => policy.metadata.name === "allow-dns");
  assert.deepEqual(dns.spec.egress[0].to, [
    {
      namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } },
      podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
    },
  ]);
  const runtime = sources.find(
    ([policy]) => policy.metadata.name === `allow-agent-runtime-${d}`,
  )[0];
  assert.deepEqual(runtime.spec.egress[1].to[0].podSelector.matchLabels, { app: "repository" });
  assert.deepEqual(runtime.spec.egress[1].ports, [{ protocol: "TCP", port: 8443 }]);
});

test("the sandbox preview ingress grant requires the profile once the serving Gateway carries it", () => {
  const driver = createKubernetesComputeDriver(
    routedOptions({
      runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
      gatewayRouting: {
        ...gatewayRouting,
        sandbox: { domain: "previews.example.test", publicPort: 9443 },
      },
    }),
  );
  const revision = profileNetworkRevision(driver, "dedicated");
  const serving = profileNetworkWorkload(driver, revision, "gateway");
  const labels = serving.spec.template.metadata.labels;
  const metadata = {
    name: "gateway-sandbox",
    namespace: kubernetesGatewayNamespaceName(tenant.id),
  };
  const routing = driver.options.gatewayRouting;
  const selector = driver.gatewaySandboxNetworkPolicy(revision, metadata, routing, serving).spec
    .podSelector;
  assert.equal(selector.matchLabels[ORDINARY_PROFILE_LABEL], ORDINARY_PROFILE);
  assert.equal(selectorMatches(selector, labels), true);
  for (const profile of UNAPPROVED_PROFILES) {
    assert.equal(selectorMatches(selector, withProfile(labels, profile)), false);
  }
  // A serving Gateway from a pre-profile template keeps preview ingress until
  // activation replaces it.
  const legacy = structuredClone(serving);
  legacy.spec.template.metadata.labels = withProfile(labels, undefined);
  const legacySelector = driver.gatewaySandboxNetworkPolicy(revision, metadata, routing, legacy)
    .spec.podSelector;
  assert.equal(legacySelector.matchLabels[ORDINARY_PROFILE_LABEL], undefined);
  assert.equal(selectorMatches(legacySelector, legacy.spec.template.metadata.labels), true);
  assert.equal(legacySelector.matchLabels["openclaw.dev/workload-role"], "gateway");
  assert.equal(legacySelector.matchLabels["openclaw.dev/agent"], revision.agentId);
});

test("ordinary embedded and dedicated policy callers retain exact model and Harness routes", () => {
  const driver = profileNetworkDriver();
  const dedicated = profileNetworkRevision(driver, "dedicated");
  const embedded = profileNetworkRevision(driver, "embedded");
  const execution = { name: kubernetesNamespaceName(tenant.id), plane: "execution" };
  const find = (revision, prefix) =>
    driver
      .agentNetworkPolicies(revision, execution)
      .map(({ resource }) => resource)
      .find((policy) => policy.metadata.name === `${prefix}-${digest(revision.agentId)}`);
  const gateway = find(dedicated, "allow-gateway-agent");
  const agent = find(dedicated, "allow-agent-runtime");
  const embeddedRuntime = find(embedded, "allow-agent-runtime");
  const auth = driver.agentAuthenticationNetworkPolicy(dedicated, execution);
  assert.deepEqual(agent.spec.egress, embeddedRuntime.spec.egress);
  assert.deepEqual(auth.spec.egress, agent.spec.egress);
  assert.deepEqual(agent.spec.egress[0], {
    to: [
      {
        ipBlock: {
          cidr: "0.0.0.0/0",
          except: [
            "10.0.0.0/8",
            "100.64.0.0/10",
            "172.16.0.0/12",
            "192.168.0.0/16",
            "169.254.0.0/16",
          ],
        },
      },
    ],
    ports: [{ protocol: "TCP", port: 443 }],
  });
  assert.equal(agent.spec.ingress.length, 1);
  assert.deepEqual(gateway.spec.egress[0].ports, agent.spec.ingress[0].ports);

  const agentLabels = profileNetworkWorkload(driver, dedicated, "agent").spec.template.metadata
    .labels;
  const gatewayLabels = profileNetworkWorkload(driver, dedicated, "gateway").spec.template.metadata
    .labels;
  const embeddedLabels = profileNetworkWorkload(driver, embedded, "gateway").spec.template.metadata
    .labels;
  assert.equal(selectorMatches(embeddedRuntime.spec.podSelector, embeddedLabels), true);
  for (const [selector, labels] of [
    [gateway.spec.podSelector, gatewayLabels],
    [gateway.spec.egress[0].to[0].podSelector, agentLabels],
    [agent.spec.podSelector, agentLabels],
    [agent.spec.ingress[0].from[0].podSelector, gatewayLabels],
    [auth.spec.podSelector, agentLabels],
  ]) {
    assert.equal(selectorMatches(selector, labels), true);
    for (const profile of UNAPPROVED_PROFILES) {
      assert.equal(selectorMatches(selector, withProfile(labels, profile)), false);
    }
  }
  // The profile widens nothing: revision and Agent scope still bind the grants.
  assert.equal(
    selectorMatches(agent.spec.podSelector, {
      ...agentLabels,
      "openclaw.dev/revision": "revision-network-other",
    }),
    false,
  );
  assert.equal(
    selectorMatches(auth.spec.podSelector, { ...agentLabels, "openclaw.dev/agent": "another" }),
    false,
  );
});

// A SandboxDriver that provisions the Harness fences its egress (OpenShell's
// workload policy has `egress: []`). NetworkPolicies are additive, so any
// Compute egress grant selecting that Pod would reopen DNS and public 443.
test("SandboxDriver Harness Pods get Compute's transport ingress but none of its egress", () => {
  const options = routedOptions({
    network: { pluginStatusProxySourceCidrs: ["192.0.2.20/32"] },
    runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
    servicePrincipalCredentials: {
      mode: "projectedServiceAccountToken",
      audience: "openclaw-controller",
      expirationSeconds: 900,
    },
  });
  const driver = new KubernetesComputeDriver(options, {
    sandboxDriver: { id: "sandbox-provider", async provisionHarness() {} },
  });
  // Repository credentials are unsupported with a SandboxDriver.
  const { repositoryCredentials: _unsupported, ...dedicated } = profileNetworkRevision(
    driver,
    "dedicated",
  );
  const revision = { ...dedicated, sandboxDriverId: "sandbox-provider" };
  const execution = { name: kubernetesNamespaceName(tenant.id), plane: "execution" };
  const control = { name: kubernetesGatewayNamespaceName(tenant.id), plane: "control" };
  const ordinaryAgent = profileNetworkWorkload(driver, revision, "agent");
  const { labels: harness } = driver.harnessRequirementsFromDeployment(ordinaryAgent, "api_key");
  assert.equal(harness[ORDINARY_PROFILE_LABEL], "provider-fenced-v1");
  const gatewayLabels = profileNetworkWorkload(driver, revision, "gateway").spec.template.metadata
    .labels;
  const policies = [
    ...driver.networkPolicies({ namespaceId: tenant.id }, execution),
    driver.workspaceNodeNetworkPolicy({ namespaceId: tenant.id }, execution),
    ...driver.agentNetworkPolicies(revision, execution).map(({ resource }) => resource),
    ...driver
      .agentNetworkPolicies(revision, execution, { anyRevision: true })
      .map(({ resource }) => resource),
  ].filter((policy) => policy.metadata.namespace === execution.name);
  const selecting = policies.filter((policy) => selectorMatches(policy.spec.podSelector, harness));
  for (const policy of selecting) {
    assert.deepEqual(
      policy.spec.egress ?? [],
      [],
      `${policy.metadata.name} must not grant the provider-fenced Harness egress`,
    );
  }
  // Compute must not issue an authentication egress grant for a fenced Harness.
  assert.throws(
    () => driver.agentAuthenticationNetworkPolicy(revision, execution),
    /approved model egress policy/,
  );
  // The Gateway still reaches the Harness transport in both directions.
  const runtime = selecting.find(
    (policy) => policy.metadata.name === `allow-agent-runtime-${digest(revision.agentId)}`,
  );
  assert.ok(runtime, "the Harness keeps its Gateway transport ingress");
  assert.deepEqual(runtime.spec.policyTypes, ["Ingress"]);
  assert.equal(selectorMatches(runtime.spec.ingress[0].from[0].podSelector, gatewayLabels), true);
  const gatewayEgress = driver
    .agentNetworkPolicies(revision, execution)
    .map(({ resource }) => resource)
    .find((policy) => policy.metadata.name === `allow-gateway-agent-${digest(revision.agentId)}`);
  assert.equal(gatewayEgress.metadata.namespace, control.name);
  assert.equal(selectorMatches(gatewayEgress.spec.egress[0].to[0].podSelector, harness), true);
  // An ordinary-profile Pod of this revision gains nothing from the fenced grants.
  assert.equal(
    selectorMatches(runtime.spec.podSelector, {
      ...harness,
      [ORDINARY_PROFILE_LABEL]: ORDINARY_PROFILE,
    }),
    false,
  );
});

test("ordinary network profile selectors remain detached across caller results", () => {
  const driver = profileNetworkDriver();
  const revision = profileNetworkRevision(driver, "dedicated");
  const execution = { name: kubernetesNamespaceName(tenant.id), plane: "execution" };
  const runtimeName = `allow-agent-runtime-${digest(revision.agentId)}`;
  const runtime = (policies) =>
    policies.map(({ resource }) => resource).find(({ metadata }) => metadata.name === runtimeName);
  const first = runtime(driver.agentNetworkPolicies(revision, execution));
  delete first.spec.podSelector.matchLabels[ORDINARY_PROFILE_LABEL];
  first.spec.podSelector.matchLabels["openclaw.dev/agent"] = "mutated";
  const second = runtime(driver.agentNetworkPolicies(revision, execution));
  assert.equal(second.spec.podSelector.matchLabels[ORDINARY_PROFILE_LABEL], ORDINARY_PROFILE);
  assert.equal(second.spec.podSelector.matchLabels["openclaw.dev/agent"], revision.agentId);
});

// Returns how many preparation passes the revision needed to become ready.
async function prepareUntilReady(driver, revision, context, limit = 4) {
  for (let pass = 1; pass <= limit; pass += 1) {
    if ((await driver.prepareRevision(revision, context)).ready) {
      return pass;
    }
  }
  assert.fail(`${revision.id} did not become ready within ${limit} preparation passes`);
}

// Namespaces provisioned before the explicit profile keep their namespace-wide
// policies: allow-dns selected every Pod and allow-gateway-ingress and
// allow-node-gateway selected only the workload role. Preparing one Agent must
// not narrow them, or every other Agent's unprofiled Pods lose DNS, Gateway
// ingress and workspace-node egress.
function preProfilePolicy(policy) {
  const legacy = structuredClone(policy);
  legacy.metadata.uid = `${policy.metadata.namespace}-${policy.metadata.name}-legacy-uid`;
  legacy.metadata.resourceVersion = "1";
  legacy.spec.podSelector =
    policy.metadata.name === "allow-dns" || policy.metadata.name === "default-deny"
      ? {}
      : { matchLabels: withProfile(policy.spec.podSelector.matchLabels, undefined) };
  if (policy.metadata.name === "allow-dns") {
    legacy.spec.egress[0].ports = legacy.spec.egress[0].ports.filter(({ port }) => port === 53);
  }
  return legacy;
}

for (const embedded of [true, false]) {
  test(`${embedded ? "embedded" : "dedicated"} preparation keeps pre-profile namespace grants for every Agent`, async () => {
    const { driver, revision, namespace, objects, records, state, context } =
      workspaceSetupFixture(embedded);
    const execution = { name: namespace, plane: "execution" };
    const control = { name: kubernetesGatewayNamespaceName(tenant.id), plane: "control" };
    const ownership = { namespaceId: tenant.id };
    const legacy = [
      ...driver.networkPolicies(ownership, execution),
      ...driver.networkPolicies(ownership, control),
      driver.workspaceNodeNetworkPolicy(ownership, execution),
    ].map(preProfilePolicy);
    for (const policy of legacy) {
      objects.set(`NetworkPolicy:${policy.metadata.namespace}:${policy.metadata.name}`, policy);
    }

    state.ready = true;
    assert.equal(await prepareUntilReady(driver, revision, context), 1);

    const stored = (policy) =>
      objects.get(`NetworkPolicy:${policy.metadata.namespace}:${policy.metadata.name}`);
    for (const policy of legacy) {
      const current = stored(policy);
      assert.equal(current.metadata.uid, policy.metadata.uid);
      const expected = structuredClone(policy.spec);
      if (
        policy.metadata.name === "allow-dns" &&
        (policy.metadata.namespace === namespace || !embedded)
      ) {
        expected.egress[0].ports.push(
          { protocol: "UDP", port: 5353 },
          { protocol: "TCP", port: 5353 },
        );
      }
      assert.deepEqual(current.spec, expected, `${policy.metadata.name} must keep its selector`);
    }
    const namespaceWide = new Set(legacy.map(({ metadata }) => metadata.name));
    assert.equal(
      records.some(
        ({ kind, metadata }) =>
          kind === "NetworkPolicy" &&
          namespaceWide.has(metadata.name) &&
          metadata.name !== "allow-node-gateway" &&
          metadata.name !== "allow-dns",
      ),
      false,
      "preparation must not write namespace-wide deny or Gateway ingress policies",
    );
    if (!embedded) {
      // The workspace-node policy is reconciled on every dedicated preparation.
      assert.equal(
        records.some(({ metadata }) => metadata.name === "allow-node-gateway"),
        true,
      );
    }

    // Pods from the prepared Agent's new templates carry the profile; its
    // previous Pods and every other Agent's Pods predate it.
    const templates = [...objects.values()]
      .filter(({ kind }) => kind === "Deployment")
      .map((deployment) => deployment.spec.template.metadata.labels);
    assert.equal(templates.length, embedded ? 1 : 2);
    for (const labels of templates) {
      assert.equal(labels[ORDINARY_PROFILE_LABEL], ORDINARY_PROFILE);
    }
    const others = ["gateway", "agent"].map((role) => ({
      "openclaw.dev/namespace": tenant.id,
      "openclaw.dev/workload-role": role,
      "openclaw.dev/agent": "another-agent",
      "openclaw.dev/revision": "another-revision",
    }));
    const pods = [
      ...templates,
      ...templates.map((labels) => withProfile(labels, undefined)),
      ...others,
    ];
    const byName = (name, target) =>
      stored({ metadata: { name, namespace: target.name } }).spec.podSelector;
    for (const labels of pods) {
      const role = labels["openclaw.dev/workload-role"];
      for (const target of [execution, control]) {
        assert.equal(selectorMatches(byName("allow-dns", target), labels), true);
        assert.equal(
          selectorMatches(byName("allow-gateway-ingress", target), labels),
          role === "gateway",
        );
      }
      assert.equal(
        selectorMatches(byName("allow-node-gateway", execution), labels),
        role === "agent",
      );
    }

    // Per-Agent grants are re-rendered with the profile and select the new templates.
    const perAgent = records.filter(
      ({ kind, metadata }) => kind === "NetworkPolicy" && !namespaceWide.has(metadata.name),
    );
    assert.notEqual(perAgent.length, 0);
    for (const policy of perAgent) {
      const selector = policy.spec.podSelector;
      assert.equal(selector.matchLabels[ORDINARY_PROFILE_LABEL], ORDINARY_PROFILE);
      assert.equal(
        templates.some((labels) => selectorMatches(selector, labels)),
        true,
        `${policy.metadata.name} must select a prepared template`,
      );
      assert.equal(
        others.some((labels) => selectorMatches(selector, labels)),
        false,
        `${policy.metadata.name} must not select another Agent`,
      );
    }

    // New namespaces are narrowed: unprofiled Pods receive no ordinary grant.
    for (const policy of [
      ...driver.networkPolicies(ownership, execution),
      driver.workspaceNodeNetworkPolicy(ownership, execution),
    ]) {
      if (policy.metadata.name === "default-deny") {
        continue;
      }
      for (const labels of others) {
        assert.equal(selectorMatches(policy.spec.podSelector, labels), false);
      }
    }
  });
}

test("dedicated preparation keeps a profiled workspace-node policy narrowed", async () => {
  const { driver, revision, namespace, objects, context } = workspaceSetupFixture(false);
  const key = `NetworkPolicy:${namespace}:allow-node-gateway`;
  const current = driver.workspaceNodeNetworkPolicy(
    { namespaceId: tenant.id },
    { name: namespace, plane: "execution" },
  );
  for (const podSelector of [current.spec.podSelector, {}]) {
    const seeded = structuredClone(current);
    seeded.metadata.uid = "node-policy-uid";
    seeded.spec.podSelector = structuredClone(podSelector);
    objects.set(key, seeded);
    await driver.prepareRevision(revision, context);
    // Only the exact pre-profile selector is preserved; anything else is repaired.
    assert.deepEqual(objects.get(key).spec.podSelector, current.spec.podSelector);
  }
});

test("embedded preparation keeps model egress for a serving pre-profile Gateway until activation", async () => {
  const { driver, revision, namespace, objects, records, state, context } =
    workspaceSetupFixture(true);
  await driver.prepareRevision(revision, context);
  const gatewayKey = `Deployment:${namespace}:gateway-${digest(revision.agentId)}`;
  const runtimeKey = `NetworkPolicy:${namespace}:allow-agent-runtime-${digest(revision.agentId)}`;
  // The serving Gateway was rendered before the explicit profile existed.
  const serving = objects.get(gatewayKey);
  serving.spec.template.metadata.labels = withProfile(
    serving.spec.template.metadata.labels,
    undefined,
  );
  const servingLabels = serving.spec.template.metadata.labels;
  const replacement = { ...revision, id: "embedded-replacement", revision: revision.revision + 1 };
  const replacementContext = { ...context, ...authContext(replacement) };
  records.length = 0;
  state.ready = true;
  // The serving Gateway is observed, not replaced, so the first pass is ready.
  assert.equal(await prepareUntilReady(driver, replacement, replacementContext), 1);
  const retained = objects.get(runtimeKey);
  assert.equal(retained.spec.podSelector.matchLabels[ORDINARY_PROFILE_LABEL], undefined);
  assert.equal(selectorMatches(retained.spec.podSelector, servingLabels), true);
  assert.equal(
    selectorMatches(retained.spec.podSelector, { ...servingLabels, "openclaw.dev/agent": "other" }),
    false,
  );
  assert.deepEqual(objects.get(gatewayKey).spec.template.metadata.labels, servingLabels);

  // Activation replaces the Gateway with a profiled template, then narrows the grant.
  await driver.activateRevision(replacement, replacementContext);
  const replaced = objects.get(gatewayKey).spec.template.metadata.labels;
  assert.equal(replaced[ORDINARY_PROFILE_LABEL], ORDINARY_PROFILE);
  const narrowed = objects.get(runtimeKey).spec.podSelector;
  assert.equal(narrowed.matchLabels[ORDINARY_PROFILE_LABEL], ORDINARY_PROFILE);
  assert.equal(selectorMatches(narrowed, servingLabels), false);
  assert.equal(selectorMatches(narrowed, replaced), true);

  // With a profiled Gateway serving, preparation keeps the grant narrowed.
  const next = { ...replacement, id: "embedded-next", revision: replacement.revision + 1 };
  assert.equal(await prepareUntilReady(driver, next, { ...context, ...authContext(next) }), 1);
  assert.equal(
    objects.get(runtimeKey).spec.podSelector.matchLabels[ORDINARY_PROFILE_LABEL],
    ORDINARY_PROFILE,
  );
});

// Upgrade: a revision was prepared and activated before the explicit profile
// existed, so its serving Gateway template lacks the label. Preparing the next
// revision must still converge without touching the serving Gateway (or, for a
// dedicated Agent, the stable Agent Service): both topologies observe it
// without the profile requirement and only activation replaces it.
for (const embedded of [true, false]) {
  test(`${embedded ? "embedded" : "dedicated"} upgrade prepares a successor while a pre-profile Gateway serves`, async () => {
    const { driver, revision, namespace, objects, records, state, context } =
      workspaceSetupFixture(embedded);
    const gatewayNamespace = embedded ? namespace : kubernetesGatewayNamespaceName(tenant.id);
    const gatewayName = `gateway-${digest(revision.agentId)}`;
    const gatewayKey = `Deployment:${gatewayNamespace}:${gatewayName}`;
    const agentServiceKey = `Service:${namespace}:agent-${digest(revision.agentId)}`;
    const gatewayAgentKey = `NetworkPolicy:${gatewayNamespace}:allow-gateway-agent-${digest(revision.agentId)}`;
    const runtimeKey = `NetworkPolicy:${namespace}:allow-agent-runtime-${digest(revision.agentId)}`;
    state.ready = true;
    assert.equal(await prepareUntilReady(driver, revision, context), 1);
    await driver.activateRevision(revision, context);

    const serving = objects.get(gatewayKey);
    serving.spec.template.metadata.labels = withProfile(
      serving.spec.template.metadata.labels,
      undefined,
    );
    const servingLabels = structuredClone(serving.spec.template.metadata.labels);
    const servingTemplate = structuredClone(serving.spec.template);
    const stableSelector = embedded
      ? undefined
      : structuredClone(objects.get(agentServiceKey).spec.selector);
    if (!embedded) {
      assert.equal(stableSelector["openclaw.dev/revision"], revision.id);
    }

    const successor = { ...revision, id: "upgrade-successor", revision: revision.revision + 1 };
    // The pending workspace setup keeps embedded preparation on the Gateway readiness path.
    const successorContext = { ...context, ...authContext(successor) };
    assert.equal(successorContext.workspaceSetup.completed, false);
    records.length = 0;
    assert.equal(await prepareUntilReady(driver, successor, successorContext), 1);
    const gateway = objects.get(gatewayKey);
    assert.deepEqual(gateway.spec.template, servingTemplate, "preparation must not restart it");
    assert.equal(gateway.metadata.annotations["openclaw.dev/agent-revision-id"], revision.id);
    assert.equal(
      records.some(({ kind, metadata }) => kind === "Deployment" && metadata.name === gatewayName),
      false,
      "preparation must not re-render the serving Gateway",
    );
    if (!embedded) {
      // The stable Agent Service keeps selecting the predecessor Harness.
      assert.deepEqual(objects.get(agentServiceKey).spec.selector, stableSelector);
      const harness = objects.get(
        `Deployment:${namespace}:agent-${digest(revision.agentId)}-rev-${digest(successor.id)}`,
      );
      assert.equal(harness.spec.template.metadata.labels[ORDINARY_PROFILE_LABEL], ORDINARY_PROFILE);
      // The pre-profile Gateway keeps its Harness transport grants until activation.
      const gatewayAgent = objects.get(gatewayAgentKey);
      assert.equal(gatewayAgent.spec.podSelector.matchLabels[ORDINARY_PROFILE_LABEL], undefined);
      assert.equal(selectorMatches(gatewayAgent.spec.podSelector, servingLabels), true);
      const runtimePeer = objects.get(runtimeKey).spec.ingress[0].from[0].podSelector;
      assert.equal(runtimePeer.matchLabels[ORDINARY_PROFILE_LABEL], undefined);
      assert.equal(selectorMatches(runtimePeer, servingLabels), true);
    }

    await driver.activateRevision(successor, successorContext);
    const activated = objects.get(gatewayKey);
    assert.equal(activated.metadata.annotations["openclaw.dev/agent-revision-id"], successor.id);
    assert.equal(activated.spec.template.metadata.labels[ORDINARY_PROFILE_LABEL], ORDINARY_PROFILE);
    if (!embedded) {
      assert.equal(
        objects.get(agentServiceKey).spec.selector["openclaw.dev/revision"],
        successor.id,
      );
      assert.equal(
        objects.get(gatewayAgentKey).spec.podSelector.matchLabels[ORDINARY_PROFILE_LABEL],
        ORDINARY_PROFILE,
      );
      assert.equal(
        objects.get(runtimeKey).spec.ingress[0].from[0].podSelector.matchLabels[
          ORDINARY_PROFILE_LABEL
        ],
        ORDINARY_PROFILE,
      );
    }
    // Once the profiled Gateway serves, the next preparation is ready at once.
    const next = { ...successor, id: "upgrade-next", revision: successor.revision + 1 };
    assert.equal(await prepareUntilReady(driver, next, { ...context, ...authContext(next) }), 1);
  });
}

// Runtime status and log reads. The fixture supplies Kubernetes API responses only;
// plane selection, ownership re-checks, Event filtering, the typed 403 and byte-limit
// detection run through the production Driver.
function runtimeLogDriverFixture({ twoCluster = false } = {}) {
  const namespaceName = kubernetesNamespaceName(tenant.id);
  const gatewayNamespaceName = kubernetesGatewayNamespaceName(tenant.id);
  const driver = createKubernetesComputeDriver(
    twoCluster
      ? routedOptions({
          runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
          executionCluster: {
            authentication: { mode: "kubeconfig", kubeconfigPath, context: contextName },
            harnessRouting: {
              ...gatewayRouting,
              gatewayName: "harnesses",
              hostname: "harness.example.test",
            },
            network: {
              dns: options().network.dns,
              harnessEndpointCidrs: ["192.0.2.2/32"],
              gatewayEndpointCidrs: ["192.0.2.1/32"],
              pluginStatusProxySourceCidrs: ["192.0.2.2/32"],
            },
          },
        })
      : options({
          runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
        }),
  );
  const agent = {
    id: "agent-runtime-logs",
    namespaceId: tenant.id,
    name: "Runtime logs Agent",
    configurationId: "cfg_runtime_logs",
    providerId: null,
    executionMode: "dedicated",
    servicePrincipalId: "service-principal-runtime-logs",
    createdAt: tenant.createdAt,
  };
  const revision = routedRevision(driver, {
    id: "revision-runtime-logs",
    agentId: agent.id,
    configurationId: agent.configurationId,
    servicePrincipalId: agent.servicePrincipalId,
  });
  const state = {
    restartCount: { agent: 0, gateway: 2 },
    foreignPod: false,
    logs: { agent: "", gateway: "" },
    logError: undefined,
    eventError: undefined,
  };
  const pod = (role) => ({
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: `${role}-runtime-logs-pod`,
      namespace: role === "gateway" ? gatewayNamespaceName : namespaceName,
      uid: `${role}-runtime-logs-uid`,
      creationTimestamp: new Date("2026-09-30T10:00:00Z"),
      labels: {
        "openclaw.dev/agent": revision.agentId,
        "openclaw.dev/revision": revision.id,
        "openclaw.dev/workload-role": role,
      },
    },
    status: {
      phase: "Running",
      conditions: [{ type: "Ready", status: "True" }],
      containerStatuses: [
        {
          name: role,
          ready: true,
          restartCount: state.restartCount[role],
          state: { running: { startedAt: new Date("2026-09-30T11:00:00Z") } },
          ...(state.restartCount[role] === 0
            ? {}
            : {
                lastState: {
                  terminated: {
                    reason: "OOMKilled",
                    exitCode: 137,
                    finishedAt: new Date("2026-09-30T10:59:00Z"),
                  },
                },
              }),
        },
      ],
    },
  });
  const calls = [];
  const clientsFor = (plane) => ({
    core: {
      async listNamespace({ labelSelector }) {
        assert.equal(labelSelector, `openclaw.dev/namespace=${tenant.id}`);
        calls.push({ plane, call: "listNamespace" });
        return {
          apiVersion: "v1",
          kind: "NamespaceList",
          items: [
            {
              ...driver.manifest("v1", "Namespace", namespaceName, { namespaceId: tenant.id }),
              status: { phase: "Active" },
            },
          ],
        };
      },
      async readNamespace({ name }) {
        assert.equal(name, namespaceName);
        return {
          ...driver.manifest("v1", "Namespace", namespaceName, { namespaceId: tenant.id }),
          status: { phase: "Active" },
        };
      },
      async listNamespacedPod({ namespace, labelSelector }) {
        const role = labelSelector.includes("openclaw.dev/workload-role=agent")
          ? "agent"
          : "gateway";
        calls.push({ plane, call: "listNamespacedPod", namespace, role });
        const items = [pod(role)];
        if (state.foreignPod) {
          // A Pod in the namespace that belongs to another Agent must never be accepted.
          const foreign = pod(role);
          foreign.metadata.name = "foreign-pod";
          foreign.metadata.labels["openclaw.dev/agent"] = "another-agent";
          items.push(foreign);
        }
        return { apiVersion: "v1", kind: "PodList", items };
      },
      async listNamespacedEvent({ namespace, fieldSelector, limit }) {
        calls.push({ plane, call: "listNamespacedEvent", namespace, fieldSelector, limit });
        if (state.eventError !== undefined) {
          throw state.eventError;
        }
        const uid = fieldSelector.replace("involvedObject.uid=", "");
        return {
          items: [
            {
              type: "Warning",
              reason: "BackOff",
              message: "Back-off restarting failed container",
              count: 4,
              lastTimestamp: new Date("2026-09-30T11:01:00Z"),
              involvedObject: {
                kind: "Pod",
                uid,
                namespace,
                fieldPath: "spec.containers{gateway}",
              },
            },
            {
              type: "Normal",
              reason: "Pulled",
              message: "Container image already present on machine",
              count: 1,
              lastTimestamp: new Date("2026-09-30T11:00:30Z"),
              involvedObject: {
                kind: "Pod",
                uid,
                namespace,
                fieldPath: "spec.initContainers{prepare-private-state}",
              },
            },
            {
              type: "Normal",
              reason: "Scheduled",
              message: "Successfully assigned",
              lastTimestamp: new Date("2026-09-30T11:00:00Z"),
              involvedObject: { kind: "Pod", uid, namespace },
            },
            // A field selector the server ignored must not leak another object's Events.
            {
              type: "Warning",
              reason: "Foreign",
              message: "another Pod",
              involvedObject: { kind: "Pod", uid: "someone-else", namespace },
            },
          ],
        };
      },
      async readNamespacedPodLog(request) {
        calls.push({ plane, call: "readNamespacedPodLog", ...request });
        if (state.logError !== undefined) {
          throw state.logError;
        }
        const role = request.container;
        state.restartCount[role] += state.restartDuringRead ? 1 : 0;
        return state.logs[role];
      },
    },
  });
  driver.apiClients = Promise.resolve(clientsFor("control"));
  if (twoCluster) {
    driver.executionApiClients = Promise.resolve(clientsFor("execution"));
  }
  const binding = { namespace: tenant, agent, revision };
  const request = (role, overrides = {}) => ({
    source: role,
    pod: `${role}-runtime-logs-pod`,
    podUid: `${role}-runtime-logs-uid`,
    container: role,
    previous: false,
    tailLines: 200,
    limitBytes: 1024 * 1024,
    signal: new AbortController().signal,
    ...overrides,
  });
  return { driver, binding, calls, state, request, namespaceName, gatewayNamespaceName };
}

test("Kubernetes runtime description reads each plane's Pods and only their own Events", async () => {
  const fixture = runtimeLogDriverFixture({ twoCluster: true });
  const description = await fixture.driver.describeAgentRuntime(
    fixture.binding,
    new AbortController().signal,
  );
  assert.equal(description.revisionId, fixture.binding.revision.id);
  assert.deepEqual(
    description.pods.map(({ role, cluster, name }) => ({ role, cluster, name })),
    [
      { role: "agent", cluster: "execution", name: "agent-runtime-logs-pod" },
      { role: "gateway", cluster: "control", name: "gateway-runtime-logs-pod" },
    ],
  );
  const gateway = description.pods[1];
  assert.deepEqual(gateway.containers[0], {
    name: "gateway",
    state: "running",
    reason: null,
    ready: true,
    restartCount: 2,
    startedAt: "2026-09-30T11:00:00.000Z",
    lastTermination: { reason: "OOMKilled", exitCode: 137, finishedAt: "2026-09-30T10:59:00.000Z" },
  });
  assert.deepEqual(
    gateway.events.map(({ reason, count, container }) => ({ reason, count, container })),
    [
      { reason: "BackOff", count: 4, container: "gateway" },
      { reason: "Pulled", count: 1, container: "prepare-private-state" },
      { reason: "Scheduled", count: 1, container: null },
    ],
  );
  assert.deepEqual(
    description.sources.map(({ id, pods }) => ({ id, pods })),
    [
      {
        id: "agent",
        pods: [
          {
            name: "agent-runtime-logs-pod",
            uid: "agent-runtime-logs-uid",
            container: "agent",
            restartCount: 0,
          },
        ],
      },
      {
        id: "gateway",
        pods: [
          {
            name: "gateway-runtime-logs-pod",
            uid: "gateway-runtime-logs-uid",
            container: "gateway",
            restartCount: 2,
          },
        ],
      },
    ],
  );
  // The Harness Pod and its Events come from the execution cluster; the dedicated
  // Gateway from the control-plane Gateway namespace.
  const reads = fixture.calls.filter(({ call }) =>
    ["listNamespacedPod", "listNamespacedEvent"].includes(call),
  );
  assert.deepEqual(
    reads.map(({ plane, call, namespace }) => ({ plane, call, namespace })),
    [
      { plane: "execution", call: "listNamespacedPod", namespace: fixture.namespaceName },
      { plane: "execution", call: "listNamespacedEvent", namespace: fixture.namespaceName },
      { plane: "control", call: "listNamespacedPod", namespace: fixture.gatewayNamespaceName },
      { plane: "control", call: "listNamespacedEvent", namespace: fixture.gatewayNamespaceName },
    ],
  );
  assert.ok(
    reads.filter(({ call }) => call === "listNamespacedEvent").every(({ limit }) => limit === 100),
  );

  // A Pod of another Agent in the same namespace fails the whole description.
  fixture.state.foreignPod = true;
  await assert.rejects(
    fixture.driver.describeAgentRuntime(fixture.binding, new AbortController().signal),
    /invalid Pod/,
  );
});

test("Kubernetes runtime description for a log read lists one source's Pods and no Events", async () => {
  const fixture = runtimeLogDriverFixture({ twoCluster: true });
  const description = await fixture.driver.describeAgentRuntime(
    fixture.binding,
    new AbortController().signal,
    { source: "gateway", events: false },
  );
  assert.deepEqual(
    description.sources.map(({ id }) => id),
    ["gateway"],
  );
  assert.deepEqual(
    description.pods.map(({ role, events }) => ({ role, events })),
    [{ role: "gateway", events: [] }],
  );
  assert.deepEqual(
    fixture.calls
      .filter(({ call }) => ["listNamespacedPod", "listNamespacedEvent"].includes(call))
      .map(({ plane, call }) => ({ plane, call })),
    [{ plane: "control", call: "listNamespacedPod" }],
  );
});

test("Kubernetes runtime log reads are bounded, timestamped and re-check the Pod", async () => {
  const fixture = runtimeLogDriverFixture();
  fixture.state.logs.gateway =
    '2026-09-30T12:00:00.123456789Z {"level":"info","message":"ready"}\n2026-09-30T12:00:01Z plain text\n';
  const chunk = await fixture.driver.readAgentRuntimeLogs(
    fixture.binding,
    fixture.request("gateway", { previous: true, sinceSeconds: 30, tailLines: 50 }),
  );
  assert.deepEqual(chunk.lines, [
    { time: "2026-09-30T12:00:00.123456789Z", raw: '{"level":"info","message":"ready"}' },
    { time: "2026-09-30T12:00:01Z", raw: "plain text" },
  ]);
  assert.equal(chunk.truncated, false);
  assert.deepEqual(chunk.stream, {
    source: "gateway",
    pod: "gateway-runtime-logs-pod",
    podUid: "gateway-runtime-logs-uid",
    container: "gateway",
    restartCount: 2,
  });
  const logRead = fixture.calls.find(({ call }) => call === "readNamespacedPodLog");
  assert.deepEqual(
    {
      namespace: logRead.namespace,
      name: logRead.name,
      container: logRead.container,
      previous: logRead.previous,
      sinceSeconds: logRead.sinceSeconds,
      tailLines: logRead.tailLines,
      limitBytes: logRead.limitBytes,
      timestamps: logRead.timestamps,
      follow: logRead.follow,
    },
    {
      namespace: fixture.gatewayNamespaceName,
      name: "gateway-runtime-logs-pod",
      container: "gateway",
      previous: true,
      sinceSeconds: 30,
      tailLines: 50,
      limitBytes: 1024 * 1024,
      timestamps: true,
      follow: false,
    },
  );
  // The Pod is listed before and after the read, so a restart during the read is visible.
  fixture.state.restartDuringRead = true;
  const restarted = await fixture.driver.readAgentRuntimeLogs(
    fixture.binding,
    fixture.request("gateway"),
  );
  assert.equal(restarted.stream.restartCount, 3);
  fixture.state.restartDuringRead = false;

  // Output that fills the byte limit is reported as truncated.
  fixture.state.logs.gateway = `2026-09-30T12:00:02Z ${"x".repeat(64)}`;
  const cut = await fixture.driver.readAgentRuntimeLogs(
    fixture.binding,
    fixture.request("gateway", { limitBytes: 32 }),
  );
  assert.equal(cut.truncated, true);

  // A Pod name the revision does not own never reaches readNamespacedPodLog.
  const before = fixture.calls.filter(({ call }) => call === "readNamespacedPodLog").length;
  await assert.rejects(
    fixture.driver.readAgentRuntimeLogs(
      fixture.binding,
      fixture.request("gateway", { pod: "kube-apiserver", podUid: "gateway-runtime-logs-uid" }),
    ),
    /no longer available/,
  );
  await assert.rejects(
    fixture.driver.readAgentRuntimeLogs(
      fixture.binding,
      fixture.request("gateway", { container: "agent" }),
    ),
    /does not match/,
  );
  assert.equal(fixture.calls.filter(({ call }) => call === "readNamespacedPodLog").length, before);
});

test("Kubernetes runtime log and Event 403s become the typed cluster RBAC error", async () => {
  const { RuntimeLogsForbiddenByClusterError } = await import("../../packages/occ/src/index.ts");
  const forbidden = () =>
    Object.assign(new Error("pods/log is forbidden: secret detail"), { statusCode: 403 });
  const fixture = runtimeLogDriverFixture();
  fixture.state.logError = forbidden();
  await assert.rejects(
    fixture.driver.readAgentRuntimeLogs(fixture.binding, fixture.request("gateway")),
    RuntimeLogsForbiddenByClusterError,
  );
  fixture.state.eventError = forbidden();
  await assert.rejects(
    fixture.driver.describeAgentRuntime(fixture.binding, new AbortController().signal),
    RuntimeLogsForbiddenByClusterError,
  );
  // A container without a previous instance yields no lines instead of an error.
  fixture.state.logError = Object.assign(new Error("previous terminated container not found"), {
    statusCode: 400,
  });
  const empty = await fixture.driver.readAgentRuntimeLogs(
    fixture.binding,
    fixture.request("gateway", { previous: true }),
  );
  assert.deepEqual(empty.lines, []);
});

test("Kubernetes runtime log reads drop kubelet's untimestamped log-unavailable answer", async () => {
  const fixture = runtimeLogDriverFixture();
  // While the container restarts, kubelet answers 200 with its own error line, which has
  // no timestamp. It is not container output.
  fixture.state.logs.gateway =
    "unable to retrieve container logs for containerd://50c25aa8e1ba378edb6953635f4b49e376f6802d3d9a49775772c89845d8a7e0";
  const restarting = await fixture.driver.readAgentRuntimeLogs(
    fixture.binding,
    fixture.request("gateway", { previous: true }),
  );
  assert.deepEqual(restarting.lines, []);
  // The same text printed by the container carries a timestamp and stays.
  fixture.state.logs.gateway =
    "2026-09-30T12:00:00Z unable to retrieve container logs for containerd://abc\n";
  const printed = await fixture.driver.readAgentRuntimeLogs(
    fixture.binding,
    fixture.request("gateway", { previous: true }),
  );
  assert.deepEqual(printed.lines, [
    {
      time: "2026-09-30T12:00:00Z",
      raw: "unable to retrieve container logs for containerd://abc",
    },
  ]);
});

// A first embedded deploy that never became ready (for example rejected model
// auth) leaves an unready Gateway behind an inactive Service while workspace
// setup is still pending. The next deploy must repair it with its own template
// rather than wait on the failed predecessor until the convergence deadline.
test("embedded redeploy repairs a never-served unready Gateway while workspace setup is pending", async () => {
  const { driver, revision, namespace, objects, state, context } = workspaceSetupFixture(true);
  const gatewayName = `gateway-${digest(revision.agentId)}`;
  const gatewayKey = `Deployment:${namespace}:${gatewayName}`;
  const serviceKey = `Service:${namespace}:${gatewayName}`;
  assert.equal((await driver.prepareRevision(revision, context)).ready, false);
  assert.equal(
    objects.get(gatewayKey).metadata.annotations["openclaw.dev/agent-revision-id"],
    revision.id,
  );
  assert.equal(
    objects.get(serviceKey).spec.selector["app.kubernetes.io/name"],
    `${gatewayName}-inactive`,
  );
  const revisionArtifacts = (target) => [
    `Secret:${namespace}:harness-secrets-${digest(target.agentId)}-${digest(target.id)}`,
    `ConfigMap:${namespace}:${gatewayName}-rev-${digest(target.id)}`,
  ];
  for (const artifact of revisionArtifacts(revision)) {
    assert.ok(objects.has(artifact), `${artifact} is projected for the first deploy`);
  }

  const successor = { ...revision, id: "redeploy-successor", revision: revision.revision + 1 };
  const successorContext = { ...context, ...authContext(successor) };
  assert.equal(successorContext.workspaceSetup.completed, false);
  assert.equal((await driver.prepareRevision(successor, successorContext)).ready, false);
  const repaired = objects.get(gatewayKey);
  assert.equal(repaired.metadata.annotations["openclaw.dev/agent-revision-id"], successor.id);
  // The repaired Gateway no longer runs the failed predecessor, so its credential
  // and configuration copies go now rather than on stop or delete.
  for (const artifact of revisionArtifacts(revision)) {
    assert.equal(objects.has(artifact), false, `${artifact} is removed once superseded`);
  }
  for (const artifact of revisionArtifacts(successor)) {
    assert.ok(objects.has(artifact), `${artifact} is kept for the repairing successor`);
  }
  assert.equal(
    objects.get(serviceKey).spec.selector["app.kubernetes.io/name"],
    `${gatewayName}-inactive`,
    "the repaired Gateway stays unserved until activation",
  );

  state.ready = true;
  assert.equal(await prepareUntilReady(driver, successor, successorContext), 1);
  await driver.activateRevision(successor, successorContext);
  assert.equal(
    objects.get(gatewayKey).metadata.annotations["openclaw.dev/agent-revision-id"],
    successor.id,
  );
});
