import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import {
  createKubernetesComputeDriver,
  KubernetesComputeDriver,
  kubernetesNamespaceName,
  kubernetesGatewayNamespaceName,
  resolveKubernetesNamespace,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  currentComputeAbortSignal,
  withComputeAbortSignal,
} from "../../apps/controller/src/drivers/compute/operation-context.ts";

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
    harnessAuth:
      revision.harnessAuth.method === "api_key" || revision.harnessAuth.method === "codex_pat"
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
  return driver.harnessAuthForRevision(revision, authContext(revision, namespace), namespace);
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

test("retiring node enrollment deletes only its revision Secret and preserves Harness storage", async () => {
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
  const namespace = kubernetesNamespaceName(revision.namespaceId);
  const secret = {
    ...driver.manifest(
      "v1",
      "Secret",
      driver.workspaceNodeName(revision),
      driver.pluginRuntimeOwnership(revision),
      namespace,
    ),
    type: "Opaque",
  };
  secret.metadata.uid = "node-enrollment-uid";
  let observedSecret = secret;
  const deleted = [];
  // The transport exposes only Secret operations: retiring a revision must
  // leave the Harness claim (including other revisions' files) intact.
  driver.apiClients = Promise.resolve({
    core: {
      async readNamespacedSecret() {
        return structuredClone(observedSecret);
      },
      async deleteNamespacedSecret(request) {
        deleted.push(["secret", request]);
      },
    },
  });
  await driver.retireWorkspaceNode(revision, namespace);
  assert.deepEqual(deleted, [
    [
      "secret",
      {
        name: secret.metadata.name,
        namespace,
        body: { preconditions: { uid: "node-enrollment-uid" } },
      },
    ],
  ]);
  deleted.length = 0;
  const other = { ...revision, id: "another-revision" };
  observedSecret = {
    ...secret,
    metadata: {
      ...secret.metadata,
      ...driver.manifest(
        "v1",
        "Secret",
        secret.metadata.name,
        driver.pluginRuntimeOwnership(other),
        namespace,
      ).metadata,
    },
  };
  await assert.rejects(
    driver.retireWorkspaceNode(revision, namespace),
    /ownership|another|revision|Refusing/i,
  );
  assert.deepEqual(deleted, []);
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
    }),
    { nodeEnrollment: {} },
  );
  const revision = routedRevision(driver);
  revision.configuration = admitLoggingConfiguration(revision.configuration, "info");
  const namespace = kubernetesNamespaceName(revision.namespaceId);
  let secret;
  const policies = driver.networkPolicies({ namespaceId: tenant.id }, namespace);
  const gatewayName = `gateway-${digest(revision.agentId)}`;
  const gateway = driver.deployment(
    gatewayName,
    { namespaceId: tenant.id, agentId: revision.agentId },
    kubernetesGatewayNamespaceName(tenant.id),
    options().images.gateway,
    gatewayName,
    "gateway",
    {},
    "info",
    driver.gatewayConfiguration(revision, "previous-device", kubernetesNamespaceName(tenant.id)),
  );
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
    },
    apps: {
      async readNamespacedDeployment() {
        return structuredClone(gateway);
      },
    },
    networking: {
      async readNamespacedNetworkPolicy({ name }) {
        return structuredClone(policies.find((policy) => policy.metadata.name === name));
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
      driver.pluginRuntimeOwnership({ ...revision, id: "previous-revision" }),
      namespace,
    ),
    data: { deviceId: Buffer.from("previous-device").toString("base64") },
  };
  await assert.rejects(
    driver.activateRevision(revision, authContext(revision)),
    /ownership|another|revision|Refusing/i,
  );
});

test("dedicated startup initializes Harness plugins before enrolling its workspace node", async () => {
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
          return connected ? { deviceId: "node-1", connected: true } : undefined;
        },
        async isConnected() {
          return connected;
        },
      },
    },
  );
  const revision = routedRevision(driver, {
    plugins: {
      driver: { id: "codex-plugin", implementation: "occ/codex-plugin" },
      plugins: { "codex-plugin:example": { enabled: true, toolDefaults: { approval: "native" } } },
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
      kubernetesGatewayNamespaceName(tenant.id),
    ),
    type: "Opaque",
    metadata: {
      ...driver.manifest(
        "v1",
        "Secret",
        `transport-${digest(revision.agentId)}`,
        { namespaceId: tenant.id, agentId: revision.agentId },
        kubernetesGatewayNamespaceName(tenant.id),
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
  for (const policy of driver.networkPolicies({ namespaceId: tenant.id }, namespace)) {
    save(policy);
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
        },
      ],
    };
  };
  clients.core.connectGetNamespacedPodProxyWithPath = async ({ name }) => {
    const role = name.startsWith("agent-") ? "agent" : "gateway";
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
    object.status = { observedGeneration: object.metadata.generation, readyReplicas: 1 };
    save(object);
  };
  assert.equal((await prepare()).ready, false);
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
  assert.equal(setupCalls, 0);
  assert.equal(
    objects.has(key("Deployment", gatewayName, kubernetesGatewayNamespaceName(tenant.id))),
    false,
  );
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
  assert.ok(
    objects.has(key("Deployment", gatewayName, kubernetesGatewayNamespaceName(tenant.id))),
    "plugin readiness permits Gateway startup",
  );
  assert.equal(setupCalls, 0);
  markReady(gatewayName);
  assert.equal((await prepare()).ready, false);
  assert.equal(setupCalls, 1);
  const agent = read("Deployment", agentName);
  assert.deepEqual(agent.spec.strategy, initialStrategy);
  assert.ok(
    agent.spec.template.spec.containers[0].env.some(
      (variable) => variable.name === "OPENCLAW_NODE_SETUP_CODE",
    ),
  );
  markReady(agentName);
  assert.equal((await prepare()).ready, false, "running workloads alone are not node readiness");
  connected = true;
  assert.equal((await prepare()).ready, true);
  assert.equal(setupCalls, 1);
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
      gatewayNamespace,
    ),
    type: "Opaque",
    metadata: {
      ...driver.manifest(
        "v1",
        "Secret",
        `transport-${digest(replacement.agentId)}`,
        gatewayOwnership,
        gatewayNamespace,
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
  for (const policy of driver.networkPolicies({ namespaceId: tenant.id }, namespace)) {
    save(policy);
  }
  const predecessor = driver.deployment(
    gatewayName,
    gatewayOwnership,
    gatewayNamespace,
    options().images.gateway,
    gatewayName,
    "gateway",
    {},
    "info",
    driver.gatewayConfiguration(oldRevision, "previous-node", namespace),
  );
  predecessor.metadata.annotations["openclaw.dev/agent-revision"] = String(oldRevision.revision);
  predecessor.metadata.annotations["openclaw.dev/agent-revision-id"] = oldRevision.id;
  predecessor.metadata.generation = 1;
  predecessor.metadata.uid = `${gatewayName}-uid`;
  predecessor.status = { observedGeneration: 1, readyReplicas: 1 };
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
  driver.apiClients = Promise.resolve(clients);

  const prepare = () => driver.prepareRevision(replacement, authContext(replacement));
  const markReady = (name) => {
    const target = name === gatewayName ? gatewayNamespace : namespace;
    const object = read("Deployment", name, target);
    object.status = { observedGeneration: object.metadata.generation, readyReplicas: 1 };
    save(object);
  };

  assert.equal((await prepare()).ready, false);
  assert.equal(candidateGatewayStarted, false);
  assert.equal(setupCalls, 1);
  const initiallyPreparedAgent = read("Deployment", agentName);
  assert.ok(
    initiallyPreparedAgent.spec.template.spec.containers[0].env.some(
      (variable) => variable.name === "OPENCLAW_NODE_SETUP_CODE",
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
  const agentWithSetup = read("Deployment", agentName);
  assert.ok(
    agentWithSetup.spec.template.spec.containers[0].env.some(
      (variable) => variable.name === "OPENCLAW_NODE_SETUP_CODE",
    ),
  );
  markReady(agentName);
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
  } = {}) => {
    let observed = prepared();
    mutate?.(observed);
    const patches = [];
    const driver = createKubernetesComputeDriver(options());
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
  const claim = driver.harnessWorkspaceClaim(agentId, ownership, "customer-support");
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

test("gateway routing derives stable endpoints and exact Envoy HTTPRoutes", async () => {
  const driver = createKubernetesComputeDriver(routedOptions());
  const revision = routedRevision(driver);
  const namespace = kubernetesNamespaceName(tenant.id);
  const name = `gateway-${digest(revision.agentId)}`;
  const ownership = { namespaceId: tenant.id, agentId: revision.agentId };
  const nodeEgress = driver.workspaceNodeNetworkPolicy({ namespaceId: tenant.id }, namespace);
  assert.equal(nodeEgress.metadata.annotations["openclaw.dev/namespace-id"], tenant.id);
  assert.deepEqual(nodeEgress.spec, {
    podSelector: { matchLabels: { "openclaw.dev/workload-role": "agent" } },
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
    customPortDriver.workspaceNodeNetworkPolicy({ namespaceId: tenant.id }, namespace).spec
      .egress[0].ports,
    [{ protocol: "TCP", port: 11443 }],
  );
  const service = driver.service(name, ownership, namespace, {
    "app.kubernetes.io/name": name,
  });
  service.metadata.uid = "gateway-service-uid";

  assert.equal(
    driver.getGatewayEndpoint(revision),
    `wss://${gatewayRouting.hostname}/namespaces/${tenant.id}/agents/${revision.agentId}`,
  );

  const route = driver.gatewayRoute(revision, ownership, namespace, service);
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

  // Node enrollment uses an exact device-authenticated endpoint, not the
  // operator UI prefix route or its injected administrative identity.
  const nodeRoute = driver.gatewayRoute(revision, ownership, namespace, service, "node");
  assert.equal(nodeRoute.spec.rules.length, 1);
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

  const ingress = driver
    .networkPolicies(ownership, namespace)
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
    const hostnames = derivedDriver.gatewayRoute(derivedRevision, ownership, namespace, service)
      .spec.hostnames;
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
    namespace,
    "openclaw-enterprise/gateway-fixture:local",
    name,
    "gateway",
    {},
    "info",
    driver.gatewayConfiguration(revision, undefined, kubernetesNamespaceName(tenant.id)),
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
    namespace,
    "openclaw-enterprise/gateway-fixture:local",
    runtimeName,
    "gateway",
    {},
    "info",
    runtimeDriver.gatewayConfiguration(
      runtimeRevision,
      undefined,
      kubernetesNamespaceName(tenant.id),
    ),
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
    namespace,
    "openclaw-enterprise/gateway-fixture:local",
    runtimeName,
    "gateway",
    {},
    "info",
    runtimeDriver.gatewayConfiguration(
      nativeAdminRevision,
      undefined,
      kubernetesNamespaceName(tenant.id),
    ),
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
    /copyFileSync\("\/etc\/openclaw-managed\/openclaw\.json", "\/home\/node\/\.openclaw\/openclaw\.json"\)/,
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
    namespace,
    "openclaw-enterprise/gateway-fixture:local",
    runtimeName,
    "gateway",
    {},
    "info",
    privateRuntimeDriver.gatewayConfiguration(
      privateNativeAdminRevision,
      undefined,
      kubernetesNamespaceName(tenant.id),
    ),
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
    multiProxyDriver.gatewayConfiguration(
      multiProxyRevision,
      undefined,
      kubernetesNamespaceName(tenant.id),
    ),
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
  for (const proxyUrl of [
    "http://proxy.internal:3128",
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
      namespace,
      `${role}:local`,
      role,
      role,
      {},
      "info",
      computeDriver.gatewayConfiguration(
        routedRevision(computeDriver, { agentId: ownership.agentId }),
        undefined,
        namespace,
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
    namespace,
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
    namespace,
    "gateway:local",
    "codex-gateway",
    "gateway",
    {},
    "info",
    driver.gatewayConfiguration(
      routedRevision(driver, { agentId: ownership.agentId }),
      undefined,
      namespace,
    ),
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
  const prepared = driver.harnessAuthForRevision(revision, context, namespace);
  const ownership = { namespaceId: tenant.id, agentId: "direct-pat-agent" };
  for (const role of ["agent", "gateway"]) {
    const workload = driver.deployment(
      "direct-pat",
      ownership,
      namespace,
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
      () => driver.harnessAuthForRevision(revision, { harnessAuth }, namespace),
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
  const policy = driver.agentAuthenticationNetworkPolicy(revision, namespace);

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
  });
  assert.deepEqual(policy.spec.policyTypes, ["Egress"]);
  assert.equal(policy.spec.ingress, undefined);
  assert.deepEqual(
    policy.spec.egress,
    driver.agentNetworkPolicies(revision, namespace)[1].spec.egress,
  );
  assert.deepEqual(policy.spec.egress[0].ports, [{ protocol: "TCP", port: 443 }]);
  assert.deepEqual(policy.spec.egress[0].to[0].ipBlock.except, [
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "169.254.0.0/16",
  ]);

  const successor = driver.agentAuthenticationNetworkPolicy(
    { ...revision, id: "revision-account-token-2" },
    namespace,
  );
  // One Agent-owned policy moves between candidates without leaving stale-revision egress behind.
  assert.equal(successor.metadata.name, policy.metadata.name);
  assert.notDeepEqual(successor.spec.podSelector, policy.spec.podSelector);
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
      namespace,
      "openclaw-enterprise/gateway-fixture:local",
      `gateway-${suffix}`,
      "gateway",
      {},
      "info",
      driver.gatewayConfiguration(
        routedRevision(driver, { agentId: { namespaceId: tenant.id, agentId }.agentId }),
        undefined,
        namespace,
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

    const policy = driver.channelNetworkPolicy(configuredRevision, enabled, namespace);
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
      namespace,
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
    namespace,
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
      namespace,
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
  const ipv6Policy = ipv6.channelNetworkPolicy(
    teamsRevision,
    ipv6.enabledChannels(teamsRevision),
    namespace,
  );
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
      namespaceName,
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
    const policies = driver.pluginStatusNetworkPolicies(revision, tenantNamespace);
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

  assert.equal(await nonNative.safeRuntimeFailureObservation(revision, namespace), undefined);
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
  assert.equal(await native.safeRuntimeFailureObservation(nativeRevision, namespace), undefined);

  const cancellation = new Error("runtime evidence cancelled");
  const owner = new AbortController();
  owner.abort(cancellation);
  await assert.rejects(
    withComputeAbortSignal(owner.signal, () =>
      native.safeRuntimeFailureObservation(nativeRevision, namespace),
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
  for (const policy of driver.networkPolicies(tenantOwnership, namespace)) {
    save(policy);
  }
  save({
    ...driver.manifest("v1", "ServiceAccount", agentName, agentOwnership, namespace),
    automountServiceAccountToken: false,
  });
  save({
    ...driver.deployment(
      gatewayName,
      gatewayOwnership,
      namespace,
      "openclaw-enterprise/gateway-fixture:local",
      agentName,
      "gateway",
      {},
      driver.gatewayConfiguration(oldRevision).loggingLevel,
      driver.gatewayConfiguration(oldRevision),
      true,
      oldRevision.servicePrincipalId,
      driver.harnessAuthForRevision(
        oldRevision,
        authContext(oldRevision),
        kubernetesGatewayNamespaceName(tenant.id),
      ),
    ),
    metadata: {
      ...driver.deployment(
        gatewayName,
        gatewayOwnership,
        namespace,
        "openclaw-enterprise/gateway-fixture:local",
        agentName,
        "gateway",
        {},
        driver.gatewayConfiguration(oldRevision).loggingLevel,
        driver.gatewayConfiguration(oldRevision),
        true,
        oldRevision.servicePrincipalId,
        driver.harnessAuthForRevision(
          oldRevision,
          authContext(oldRevision),
          kubernetesGatewayNamespaceName(tenant.id),
        ),
      ).metadata,
      generation: 2,
    },
    status: { observedGeneration: 2, readyReplicas: 0 },
  });
  const gatewayService = driver.service(gatewayName, gatewayOwnership, namespace, {
    "app.kubernetes.io/name": gatewayName,
  });
  gatewayService.metadata.uid = "gateway-service-uid";
  save(gatewayService);
  const activeRoute = driver.gatewayRoute(oldRevision, gatewayOwnership, namespace, gatewayService);
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

  // The guarded activation replaces the shared workload before model authentication
  // succeeds. Its failing startup may leave the Agent unavailable until redeploy.
  await assert.rejects(
    driver.activateRevision(replacement, authContext(replacement)),
    /gateway is not ready/i,
  );
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
  for (const [provider, model, credentialName] of [
    ["openai", "gpt-5", "OPENAI_API_KEY"],
    ["anthropic", "claude-sonnet-4-5", "ANTHROPIC_API_KEY"],
  ]) {
    for (const accepted of [true, false]) {
      await t.test(`${provider}: ${accepted ? "accepted" : "wrong provider result"}`, async () => {
        const driver = createKubernetesComputeDriver(options());
        const candidate = {
          namespaceId: tenant.id,
          harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
          harnessAuth: apiKeyAuth,
          configuration: { agents: { defaults: { model: `${provider}/${model}` } } },
        };
        const prepared = driver.harnessAuthForRevision(
          candidate,
          authContext(candidate),
          kubernetesGatewayNamespaceName(tenant.id),
        );
        const files = new Map();
        const calls = [];
        const errors = [];
        const signals = new Map();
        const childEvents = new Map();
        const childSignals = [];
        const exits = [];
        const timers = [];
        let started = false;
        let held = false;
        // Stub native process I/O only: execute the complete generated startup
        // program and its real probe result validation, without claiming a model turn.
        runInNewContext(GATEWAY_RUNTIME_ENTRYPOINT, {
          Buffer,
          JSON,
          URL,
          console: { error: (value) => errors.push(value) },
          process: {
            env: Object.fromEntries(
              prepared.environment.map((entry) => [entry.name, entry.value ?? "fixture-model-key"]),
            ),
            on(signal, callback) {
              signals.set(signal, callback);
            },
            exit(code) {
              exits.push(code);
            },
          },
          setTimeout(callback, delay) {
            timers.push({ callback, delay });
            return { unref() {} };
          },
          setInterval() {
            held = true;
          },
          require(specifier) {
            if (specifier === "node:fs") {
              return {
                mkdirSync() {},
                mkdtempSync() {
                  return "/isolated-probe";
                },
                writeFileSync(path, value) {
                  files.set(path, value);
                },
                rmSync() {},
              };
            }
            if (specifier === "node:child_process") {
              return {
                spawnSync(command, args, options) {
                  calls.push({ command, args: Array.from(args), environment: { ...options.env } });
                  return {
                    status: 0,
                    stdout: JSON.stringify({
                      auth: {
                        probes: {
                          results: [
                            {
                              provider: accepted ? provider : "another-provider",
                              model: `${provider}/${model}`,
                              source: "env",
                              status: "ok",
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
        assert.equal(calls.length, 1);
        assert.equal(calls[0].args[calls[0].args.indexOf("--probe-provider") + 1], provider);
        assert.equal(calls[0].environment[credentialName], "fixture-model-key");
        assert.equal(
          calls[0].environment[provider === "openai" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"],
          undefined,
        );
        assert.equal(
          JSON.parse(files.get("/isolated-probe/openclaw.json")).agents.defaults.model,
          `${provider}/${model}`,
        );
        assert.equal(started, accepted);
        assert.equal(held, !accepted);
        assert.deepEqual(errors, accepted ? [] : ["Harness model authentication probe failed."]);
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
    namespace,
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
    kubernetesNamespaceName(tenant.id),
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
    kubernetesNamespaceName(tenant.id),
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
    namespace,
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
        ...driver.manifest(
          "v1",
          "Secret",
          name,
          driver.pluginRuntimeOwnership(revision),
          namespace,
        ),
        data: { deviceId: Buffer.from("provider-node").toString("base64") },
      };
    },
    async listNamespace() {
      return { items: [] };
    },
    async listNamespacedPod(request) {
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
      return driver.providerHarnessReady(revision, namespace, labels);
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

test("provider Harness preparation preserves readiness and cleanup contracts", async () => {
  const hooks = [];
  const provisions = [];
  const fixture = providerReadinessFixture({
    async provisionHarness(context) {
      assert.ok(
        objects.has(key("NetworkPolicy", `allow-agent-auth-${digest(context.revision.agentId)}`)),
        "API-key candidates need provider egress before Sandbox startup",
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
      kubernetesGatewayNamespaceName(tenant.id),
    ),
    type: "Opaque",
    metadata: {
      ...driver.manifest(
        "v1",
        "Secret",
        `transport-${digest(revision.agentId)}`,
        { namespaceId: tenant.id, agentId: revision.agentId },
        kubernetesGatewayNamespaceName(tenant.id),
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
  for (const policy of driver.networkPolicies({ namespaceId: tenant.id }, namespace)) {
    save(policy);
  }
  // Seed an already-ready gateway; the fixture never derives readiness from a write.
  const gateway = driver.deployment(
    gatewayName,
    gatewayOwnership,
    kubernetesGatewayNamespaceName(tenant.id),
    options().images.gateway,
    gatewayName,
    "gateway",
    {},
    "info",
    driver.gatewayConfiguration(revision, "provider-node", kubernetesNamespaceName(tenant.id)),
  );
  gateway.metadata.generation = 1;
  gateway.status = { observedGeneration: 1, readyReplicas: 1 };
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
    { id: "openclaw", version: "1.0.0", mode: "dedicated" },
    { id: "codex", version: "1.0.0", mode: "embedded" },
    { id: "codex", version: "1.0.0" },
    { id: "codex", version: "1.0.0", mode: "remote" },
  ]) {
    // Invalid explicit topology must fail before a missing kubeconfig can touch cluster resources.
    await assert.rejects(driver.prepareRevision({ ...revision, harness }), /Harness|topology/i);
  }

  const production = createKubernetesComputeDriver(
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
    namespace,
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

  const policies = production.agentNetworkPolicies(embeddedRevision, namespace);
  assert.equal(policies.length, 1);
  assert.deepEqual(policies[0].spec.podSelector.matchLabels, {
    "openclaw.dev/namespace": tenant.id,
    "openclaw.dev/workload-role": "gateway",
    "openclaw.dev/agent": revision.agentId,
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
  const claim = driver.gatewayPrivateStateClaim(agentId, ownership, namespace);
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
      namespace,
    ).metadata.name,
  );
  assert.notEqual(
    claim.metadata.name,
    driver.harnessWorkspaceClaim(agentId, ownership, namespace).metadata.name,
  );

  // Whole directories retain SQLite WAL/SHM siblings; only the gateway receives the private claim.
  for (const embedded of [false, true]) {
    const gateway = driver.deployment(
      "gateway",
      ownership,
      namespace,
      "gateway:local",
      "gateway",
      "gateway",
      {},
      "info",
      driver.gatewayConfiguration(
        routedRevision(driver, { agentId: ownership.agentId }),
        undefined,
        namespace,
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
        namespace,
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
        subPath: "gateway-codex-home",
      },
    );
    assert.deepEqual(pod.initContainers[0].volumeMounts, [
      { name: "runtime-state", mountPath: "/home/node" },
      { name: "runtime-temporary", mountPath: "/runtime-temporary" },
      { name: privateVolume.name, mountPath: "/gateway-state" },
    ]);
    assert.equal(pod.initContainers[0].env, undefined);
    assert.equal(pod.securityContext.runAsUser, 1000);
    assert.equal(pod.securityContext.fsGroup, 1000);
    assert.equal(gateway.spec.strategy.type, "Recreate");
    assert.equal(
      pod.volumes.some(({ name }) => name === "openclaw-workspace"),
      false,
    );
  }
  const harness = driver.deployment(
    "agent",
    { ...ownership, revisionId: "revision-render" },
    namespace,
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
  // The Harness retains task files and generated images; it cannot mount Gateway transcripts.
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
  ]);
  // Pod replacement keeps node credentials; a new revision receives a different
  // directory on the same Harness claim, outside task files and Gateway state.
  const revision = { agentId: ownership.agentId, id: "revision-node-state", configuration: {} };
  const withNode = (candidate) => {
    const workload = structuredClone(harness);
    driver.addWorkspaceNode(workload, driver.workspaceNodeName(candidate), undefined, candidate);
    const pod = workload.spec.template.spec;
    return driver.sandboxWorkspaceMounts(pod.volumes, pod.containers[0].volumeMounts);
  };
  const mounts = withNode(revision);
  const node = mounts.find(({ mountPath }) => mountPath === "/home/node/.openclaw-node");
  assert.equal(new Set(mounts.map(({ claimName }) => claimName)).size, 1);
  assert.equal(node.readOnly, false);
  assert.equal(node.subPath.includes("/"), false);
  assert.deepEqual(withNode(revision), mounts);
  const replacement = withNode({ ...revision, id: "replacement-node-state" });
  assert.notEqual(replacement.at(-1).subPath, node.subPath);
  assert.deepEqual(replacement.slice(0, -1), mounts.slice(0, -1));
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
    namespace,
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
      namespace,
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

test("Harness claim reuse retains owned RWO and RWX storage without mutation and rejects foreign or invalid claims", async () => {
  const driver = createKubernetesComputeDriver(options());
  const ownership = { namespaceId: tenant.id, agentId: "agent-workspace-ownership" };
  const namespace = kubernetesNamespaceName(tenant.id);
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
  for (const mode of ["ReadWriteOnce", "ReadWriteMany"]) {
    observed = structuredClone(desired);
    observed.metadata.uid = "retained-workspace";
    observed.spec.accessModes = [mode];
    await driver.reconcile(desired, ownership, namespace);
    assert.deepEqual(
      mutations,
      [],
      "compatible workspace claims must never be patched or replaced",
    );
    for (const mutate of [
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
      assert.deepEqual(mutations, []);
      observed = valid;
    }
    await driver.deleteHarnessWorkspaceClaim(ownership, namespace);
    assert.deepEqual(mutations.pop().body.preconditions, { uid: "retained-workspace" });
  }
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
  const desired = driver.gatewayPrivateStateClaim(agentId, ownership, namespace);
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
  await driver.reconcile(desired, ownership, namespace);
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
    await assert.rejects(driver.reconcile(desired, ownership, namespace), /Refusing/);
    await assert.rejects(driver.deleteGatewayPrivateStateClaim(ownership, namespace), /Refusing/);
    assert.deepEqual(mutations, []);
  }
  observed = structuredClone(valid);
  delete observed.metadata.uid;
  await assert.rejects(
    driver.deleteGatewayPrivateStateClaim(ownership, namespace),
    /UID must be explicitly/,
  );
  assert.deepEqual(mutations, []);
  observed = structuredClone(valid);
  await driver.deleteGatewayPrivateStateClaim(ownership, namespace);
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
  await driver.deleteGatewayPrivateStateClaim(ownership, namespace);
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
  const gateway = driver.manifest("apps/v1", "Deployment", gatewayName, ownership, namespace);
  gateway.metadata.uid = "gateway-uid";
  gateway.metadata.resourceVersion = "1";
  gateway.metadata.annotations["openclaw.dev/agent-revision-id"] = revisionId;
  const service = driver.service(gatewayName, ownership, namespace, {
    "app.kubernetes.io/name": gatewayName,
  });
  service.metadata.uid = "service-uid";
  const account = driver.manifest("v1", "ServiceAccount", gatewayName, ownership, namespace);
  account.metadata.uid = "account-uid";
  const route = driver.gatewayRoute(
    { id: revisionId, revision: 2, namespaceId: tenant.id, agentId },
    ownership,
    namespace,
    service,
  );
  route.metadata.uid = "route-uid";
  route.metadata.resourceVersion = "1";
  const privateClaim = driver.gatewayPrivateStateClaim(agentId, ownership, namespace);
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
    const gateway = driver.manifest("apps/v1", "Deployment", name, ownership, namespace);
    gateway.metadata.annotations["openclaw.dev/agent-revision-id"] = revision.id;
    const service = driver.service(name, ownership, namespace, {
      "app.kubernetes.io/name": name,
    });
    const account = driver.manifest("v1", "ServiceAccount", name, ownership, namespace);
    const route = driver.gatewayRoute(revision, ownership, namespace, service);
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
    namespace,
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
      plugins: { "occ-plugin:diffs": { enabled: true, toolDefaults: { approval: "approve" } } },
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
  const gateway = driver.manifest(
    "apps/v1",
    "Deployment",
    gatewayName,
    gatewayOwnership,
    namespace,
  );
  gateway.metadata.annotations["openclaw.dev/agent-revision-id"] = revision.id;
  save(gateway);
  save(
    driver.service(gatewayName, gatewayOwnership, namespace, {
      "app.kubernetes.io/name": gatewayName,
    }),
  );
  save(driver.manifest("v1", "ServiceAccount", agentName, agentOwnership, namespace));
  save(driver.gatewayPrivateStateClaim(revision.agentId, gatewayOwnership, namespace));
  save(driver.manifest("v1", "ConfigMap", configurationName, gatewayOwnership, namespace));
  save(driver.manifest("v1", "ConfigMap", pluginName, revisionOwnership, namespace));
  const policies = [
    ...driver.agentNetworkPolicies(revision, namespace),
    driver.channelNetworkPolicy(revision, [], namespace),
  ];
  for (const policy of policies) {
    save(policy);
  }
  const sibling = driver.manifest(
    "v1",
    "ConfigMap",
    "sibling-agent-artifact",
    { namespaceId: revision.namespaceId, agentId: "agent-sibling" },
    namespace,
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
  const gateway = driver.manifest("apps/v1", "Deployment", gatewayName, ownership, namespace);
  gateway.metadata.uid = "gateway-uid";
  gateway.metadata.annotations["openclaw.dev/agent-revision-id"] = "revision-2";
  let observedGateway = gateway;
  const gatewayService = driver.service(gatewayName, ownership, namespace, {
    "app.kubernetes.io/name": gatewayName,
  });
  gatewayService.metadata.uid = "gateway-service-uid";
  let observedService = gatewayService;
  const gatewayAccount = driver.manifest("v1", "ServiceAccount", gatewayName, ownership, namespace);
  gatewayAccount.metadata.uid = "gateway-account-uid";
  let observedServiceAccount = gatewayAccount;
  const agentName = `agent-${digest(agentId)}`;
  const agentOwnership = {
    ...ownership,
    servicePrincipalId: "service-agent-revision-storage",
  };
  const agentService = driver.service(agentName, agentOwnership, harnessNamespace, {
    "openclaw.dev/agent": agentId,
    "openclaw.dev/revision": "revision-2",
    "openclaw.dev/workload-role": "agent",
  });
  agentService.metadata.uid = "agent-service-uid";
  const agentAccount = driver.manifest(
    "v1",
    "ServiceAccount",
    agentName,
    agentOwnership,
    harnessNamespace,
  );
  agentAccount.metadata.uid = "agent-account-uid";
  const route = driver.gatewayRoute(
    { id: "revision-2", revision: 2, namespaceId: tenant.id, agentId },
    ownership,
    namespace,
    gatewayService,
  );
  route.metadata.uid = "route-uid";
  route.metadata.resourceVersion = "route-version-2";
  let observedRoute = route;
  const nodeResources = new Map();
  const claims = [
    driver.gatewayPrivateStateClaim(agentId, ownership, namespace),
    driver.harnessWorkspaceClaim(agentId, ownership, harnessNamespace),
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
    harnessNamespace,
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
      harnessNamespace,
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
    harnessNamespace,
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
    harnessNamespace,
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
    harnessNamespace,
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
  await driver.reconcileGatewayRoute(active, ownership, namespace);
  const activeNodeResources = structuredClone(nodeResources);
  assert.equal(activeNodeResources.size, 2);
  await driver.reconcileGatewayRoute(candidate, ownership, namespace);
  assert.deepEqual(nodeResources, activeNodeResources);
  // A serving Gateway predating node enrollment may have no node endpoint.
  // Preparing its successor must create one under the serving revision, or
  // node readiness would wait for activation while activation waits for it.
  nodeResources.clear();
  await driver.reconcileGatewayRoute(candidate, ownership, namespace);
  assert.deepEqual(nodeResources, activeNodeResources);
  await driver.removeRetiredGateway(candidate, harnessNamespace);
  assert.deepEqual(deletions, []);

  // Once activation replaces the Gateway, the same endpoint belongs to the new
  // revision. Retiring the predecessor must leave it usable by the new node.
  observedGateway.metadata.annotations["openclaw.dev/agent-revision-id"] = candidate.id;
  observedGateway.metadata.annotations["openclaw.dev/agent-revision"] = String(candidate.revision);
  await driver.reconcileGatewayRoute(candidate, ownership, namespace);
  for (const resource of nodeResources.values()) {
    assert.equal(resource.metadata.annotations["openclaw.dev/agent-revision-id"], candidate.id);
  }
  await driver.removeRetiredGateway(active, harnessNamespace);
  assert.deepEqual(deletions, []);
  await driver.removeRetiredGateway(candidate, harnessNamespace);
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
function workspaceSetupFixture(embedded, runtime = true) {
  const state = { ready: false, secretFailure: false, failedInitializer: false };
  const driver = new KubernetesComputeDriver(
    routedOptions({
      runtime: runtime
        ? { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" }
        : undefined,
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
      embedded ? namespace : kubernetesGatewayNamespaceName(tenant.id),
    ),
    type: "Opaque",
    metadata: {
      ...driver.manifest(
        "v1",
        "Secret",
        `transport-${digest(revision.agentId)}`,
        { namespaceId: tenant.id, agentId: revision.agentId },
        embedded ? namespace : kubernetesGatewayNamespaceName(tenant.id),
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
  for (const policy of driver.networkPolicies({ namespaceId: tenant.id }, namespace)) {
    save(policy);
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
        observed.status = { observedGeneration: 1, readyReplicas: 1 };
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
    async listNamespacedPod() {
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
      assert.equal(gatewayPod.containers[0].args[0].includes(setup.id), false);
    }
    if (!embedded) {
      assert.throws(
        () => driver.harnessRequirementsFromDeployment(harness, "api_key"),
        /cannot deliver workspace initialization/,
      );
    }
    const initializer = pod.initContainers.find(({ name }) => name === "initialize-workspace");
    assert.equal(initializer.image, driver.options.images.gateway);
    // Container restarts do not rerun initContainers; the workspace owner checks its marker.
    assert.equal(pod.containers[0].args[0].includes(setup.id), true);
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
    }
    if (!embedded) {
      const harness = [...objects.values()].find(
        ({ kind, metadata }) => kind === "Deployment" && metadata.name.startsWith("agent-"),
      );
      // The actual command sent to either Kubernetes or an external Sandbox carries only identity.
      assert.equal(harness.spec.template.spec.containers[0].args[0].includes(setup.id), true);
      assert.equal(
        harness.spec.template.spec.containers[0].args[0].includes(setup.files["AGENTS.md"]),
        false,
      );
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
      ...driver.manifest("v1", "Secret", "channel-source", { namespaceId: tenant.id }, cp),
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
    const policies = driver.agentNetworkPolicies(revision, namespace);
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
        gatewayNamespace,
      ),
      type: "Opaque",
      metadata: {
        ...driver.manifest(
          "v1",
          "Secret",
          name,
          { namespaceId: selectedRevision.namespaceId, agentId: selectedRevision.agentId },
          gatewayNamespace,
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
      .networkPolicies({ namespaceId: selectedRevision.namespaceId }, gatewayNamespace)
      .find(({ metadata }) => metadata.name === "allow-gateway-ingress");
    const target = ingressPolicy.spec.podSelector.matchLabels;
    for (const [name, value] of Object.entries(target)) {
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
    ...driver.manifest("v1", "Secret", "channel-source", { namespaceId: tenant.id }, target),
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
  assert.deepEqual(await driver.deliverGatewaySecrets(revision, namespace, target, [projection]), [
    projection,
  ]);
  assert.equal(records.length, 0, "direct references must not create copies");
  source.metadata.uid = "replaced-secret";
  await assert.rejects(
    driver.deliverGatewaySecrets(revision, namespace, target, [projection]),
    /Gateway credential source is unavailable/,
  );
  await assert.rejects(
    driver.deliverGatewaySecrets(revision, namespace, target, [
      { ...projection, backendRef: { ...projection.backendRef, namespaceName: namespace } },
    ]),
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
          target,
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
