import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import {
  KubernetesComputeDriver,
  kubernetesGatewayNamespaceName,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { SETUP_WRAPPER_COMMAND } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { encodeRepositoryCredentialSessionFiles } from "../../apps/controller/src/drivers/repo/github/credentials/client/config.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";

const deadlineWallMs = Date.now() + 86400000;
function repositoryClient(gatewayOrigin = "https://git.credentials.svc.cluster.local") {
  return {
    gatewayOrigin,
    gitRemote: `${gatewayOrigin}/example/project.git`,
    gitUsername: "gateway-session",
    canonicalApiHost: "github.com",
    apiHost: new URL(gatewayOrigin).hostname,
    repository: "example/project",
  };
}

const client = repositoryClient();

function codexPluginState() {
  return {
    driver: { id: "codex-plugin", implementation: "occ/codex-plugin" },
    plugins: {},
  };
}

function openClawPluginState() {
  return {
    driver: { id: "openclaw-plugin", implementation: "occ/openclaw-plugin" },
    plugins: {
      "openclaw-plugin:example": { enabled: true, toolDefaults: { approval: "provider_default" } },
    },
  };
}

function runtimeBinding(sessionId = "session_material_original", publicCa, gatewayOrigin) {
  return {
    kind: "new",
    repositoryRef: "project",
    sessionId,
    deadlineWallMs,
    files: encodeRepositoryCredentialSessionFiles(
      {
        session: { sessionId, deadlineWallMs },
        bearer: `controlled_gateway_bearer_${sessionId}_0000000000000000000000`,
        client: gatewayOrigin === undefined ? client : repositoryClient(gatewayOrigin),
      },
      publicCa,
    ),
  };
}

function workloadPod(deployment, namespace, name, ready = true) {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      ...structuredClone(deployment.spec.template.metadata),
      name,
      namespace,
      uid: `${name}-uid`,
    },
    spec: structuredClone(deployment.spec.template.spec),
    status: { phase: "Running", conditions: [{ type: "Ready", status: ready ? "True" : "False" }] },
  };
}

async function fixture(mode = "embedded", nodeEnrollment, options = {}) {
  const alreadyEnrolled = mode === "dedicated" && nodeEnrollment === undefined;
  if (alreadyEnrolled) {
    nodeEnrollment = {
      async createSetup() {
        throw new Error("The material fixture already has an enrolled node.");
      },
      async isConnected() {
        return true;
      },
    };
  }
  const resources = {
    requests: { cpu: "100m", memory: "64Mi" },
    limits: { cpu: "250m", memory: "128Mi" },
  };
  const driver = new KubernetesComputeDriver(
    {
      authentication: { mode: "inCluster" },
      images: { gateway: "gateway:local", agent: "agent:local", requireImmutableDigest: false },
      resources: {
        gateway: resources,
        agent: resources,
        namespace: { quota: { pods: "10" }, containerDefaults: resources },
      },
      network: {
        dns: { namespace: "kube-system", podLabels: { app: "dns" } },
        gatewayPort: 8080,
        gatewayTrustedProxyCidrs:
          nodeEnrollment === undefined ? ["127.0.0.1/32"] : ["10.42.0.0/16"],
        ...(nodeEnrollment === undefined
          ? { gatewayClients: [{ namespace: "controller", podLabels: { app: "controller" } }] }
          : {}),
        repositoryCredentials: {
          namespace: options.repositoryNamespace ?? "credentials",
          podLabels: { app: "credentials" },
          port: 8443,
        },
      },
      ...(nodeEnrollment === undefined
        ? {}
        : {
            gatewayRouting: {
              hostname: "agents.example.test",
              gatewayName: "gateways",
              gatewayNamespace: "controller",
              envoyNamespace: "envoy",
            },
          }),
      servicePrincipalCredentials: { mode: "disabled" },
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
        gatewayNodeSelector: { "oce-role": "control-plane" },
      },
    },
    { nodeEnrollment },
  );
  // Fixture failures are final; skip the driver's API retry waits.
  driver.waitBeforeRetry = async () => {};
  const revision = {
    id: "revision-repository-material",
    namespaceId: "namespace-repository-material",
    agentId: "agent-repository-material",
    revision: 1,
    backendId: null,
    configurationId: "configuration-repository-material",
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration: {
      gateway: {
        trustedProxies: ["127.0.0.1/32"],
        allowRealIpFallback: true,
        auth: {
          mode: "trusted-proxy",
          trustedProxy: { userHeader: "x-occ-identity", allowUsers: ["occ-workspace-files"] },
          identityScopes: { "occ-workspace-files": ["operator.admin"] },
        },
      },
      agents: { defaults: { model: "openai/gpt-5" } },
      logging: { level: "info", consoleLevel: "info", consoleStyle: "json" },
      diagnostics: { otel: { logs: false } },
    },
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    harnessAuth: {
      method: "api_key",
      source: { kind: "secret", namespaceId: "namespace-repository-material", id: "model-key" },
      secretDriverId: "kubernetes-secret",
    },
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId: "principal-repository-material",
    createdAt: "2026-09-18T00:00:00.000Z",
    repositoryCredentials: {
      driver: { id: "repository-credentials", implementation: "repository-credentials" },
      deadlineWallMs,
      bindings: [
        {
          repositoryRef: "project",
          profile: "read",
          backendId: "github",
          grant: { providerInstanceId: "github-main", repositoryId: "project", grantId: "read" },
        },
      ],
    },
  };
  const namespace = kubernetesNamespaceName(revision.namespaceId);
  if (mode === "dedicated") {
    revision.harness = { id: "codex", version: "1.0.0", mode };
    revision.configuration = {
      ...createHarnessConfiguration("codex", "gpt-5"),
      logging: revision.configuration.logging,
      diagnostics: revision.configuration.diagnostics,
    };
  }
  if (nodeEnrollment !== undefined) {
    revision.configuration.gateway = {
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
    };
  }
  const objects = new Map();
  const calls = [];
  let pods = [];
  let observePods;
  const key = (kind, name, target = namespace) =>
    `${kind}:${kind === "Namespace" ? "" : target}:${name}`;
  const failure = (statusCode) => Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });
  const matching = (object, selector) =>
    (selector ?? "")
      .split(",")
      .filter(Boolean)
      .every((item) => {
        const [name, value] = item.split("=");
        return object.metadata?.labels?.[name] === value;
      });
  const save = (object) =>
    objects.set(
      key(object.kind, object.metadata.name, object.metadata.namespace),
      structuredClone(object),
    );
  save({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: namespace,
      uid: "namespace-uid",
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace": revision.namespaceId,
      },
      annotations: { "openclaw.dev/namespace-id": revision.namespaceId },
    },
    status: { phase: "Active" },
  });
  const clients = { core: {}, apps: {}, networking: {}, discovery: {}, objects: {} };
  clients.objects.read = async ({ kind, metadata }) => {
    const object = objects.get(key(kind, metadata.name));
    if (!object) {
      throw failure(404);
    }
    return structuredClone(object);
  };
  clients.objects.patch = async (object) => {
    const previous = objects.get(key(object.kind, object.metadata.name));
    const stored = structuredClone(object);
    stored.metadata.uid = previous?.metadata.uid ?? `${object.kind}-${object.metadata.name}-uid`;
    stored.metadata.resourceVersion = String(Number(previous?.metadata.resourceVersion ?? 0) + 1);
    save(stored);
    return structuredClone(stored);
  };
  clients.objects.delete = async (
    object,
    _pretty,
    _dryRun,
    _grace,
    _orphan,
    _propagation,
    body,
  ) => {
    const existing = objects.get(key(object.kind, object.metadata.name));
    if (!existing) {
      throw failure(404);
    }
    if (
      existing.metadata.uid !== body.preconditions.uid ||
      existing.metadata.resourceVersion !== body.preconditions.resourceVersion
    ) {
      throw failure(409);
    }
    objects.delete(key(object.kind, object.metadata.name));
  };
  clients.core.listNamespace = async ({ labelSelector }) => ({
    items: [...objects.values()].filter(
      (object) => object.kind === "Namespace" && matching(object, labelSelector),
    ),
  });
  clients.core.readNamespace = async ({ name }) => {
    const observed = objects.get(key("Namespace", name));
    if (!observed) {
      throw failure(404);
    }
    return structuredClone(observed);
  };
  clients.core.createNamespace = async ({ body }) => {
    const observed = {
      ...body,
      metadata: { ...body.metadata, uid: `${body.metadata.name}-uid` },
      status: { phase: "Active" },
    };
    save(observed);
    return observed;
  };
  save({
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: "model-key",
      namespace: kubernetesGatewayNamespaceName(revision.namespaceId),
      uid: "model-key-uid",
    },
    data: { value: Buffer.from("fixture-key").toString("base64") },
  });
  clients.core.deleteNamespace = async ({ name, body }) => {
    const existing = objects.get(key("Namespace", name));
    assert.equal(body.preconditions.uid, existing.metadata.uid);
    objects.delete(key("Namespace", name));
    for (const [id, object] of objects) {
      if (object.metadata.namespace === name) {
        objects.delete(id);
      }
    }
    return {};
  };
  clients.core.patchNamespace = async ({ body }) => {
    const previous = objects.get(key("Namespace", body.metadata.name));
    save({ ...previous, ...body, metadata: { ...previous.metadata, ...body.metadata } });
  };
  clients.core.listNamespacedPod = async ({ labelSelector, namespace: target }) => {
    calls.push({ operation: "listPods" });
    if (observePods) {
      await observePods();
    }
    return {
      items: structuredClone(
        pods.filter((pod) => pod.metadata.namespace === target && matching(pod, labelSelector)),
      ),
    };
  };
  // Annotation patches that sync a running Harness after its node setup is written.
  clients.core.patchNamespacedPod = async ({ name, namespace: target }) => {
    calls.push({ operation: "patchPod", name, namespace: target });
    return {};
  };
  for (const [api, kinds] of [
    [
      clients.core,
      [
        "Secret",
        "ConfigMap",
        "ServiceAccount",
        "Service",
        "PersistentVolumeClaim",
        "ResourceQuota",
        "LimitRange",
      ],
    ],
    [clients.apps, ["Deployment"]],
    [clients.networking, ["NetworkPolicy"]],
  ]) {
    for (const kind of kinds) {
      api[`readNamespaced${kind}`] = async ({ name, namespace: target }) => {
        const object = objects.get(key(kind, name, target));
        if (!object) {
          throw failure(404);
        }
        return structuredClone(object);
      };
      api[`listNamespaced${kind}`] = async ({ labelSelector, namespace: target }) => ({
        items: structuredClone(
          [...objects.values()].filter(
            (object) =>
              object.kind === kind &&
              object.metadata.namespace === target &&
              matching(object, labelSelector),
          ),
        ),
      });
      const write = async ({ body }) => {
        calls.push({ operation: "write", kind, name: body.metadata.name });
        const previous = objects.get(key(kind, body.metadata.name, body.metadata.namespace));
        const object = structuredClone(body);
        if (object.stringData) {
          object.data = Object.fromEntries(
            Object.entries(object.stringData).map(([name, value]) => [
              name,
              Buffer.from(value).toString("base64"),
            ]),
          );
          delete object.stringData;
        }
        object.metadata.uid = previous?.metadata.uid ?? `${kind}-${body.metadata.name}-uid`;
        object.metadata.generation =
          (previous?.metadata.generation ?? 0) +
          (previous && isDeepStrictEqual(previous.spec, object.spec) ? 0 : 1);
        if (previous?.status) {
          object.status = structuredClone(previous.status);
        }
        object.metadata.resourceVersion = String(object.metadata.generation);
        save(object);
        return structuredClone(object);
      };
      api[`replaceNamespaced${kind}`] = write;
      api[`patchNamespaced${kind}`] = write;
      api[`createNamespaced${kind}`] = async (request) => {
        if (objects.has(key(kind, request.body.metadata.name, request.namespace))) {
          throw failure(409);
        }
        return write(request);
      };
      api[`deleteNamespaced${kind}`] = async ({ name, body, namespace: target }) => {
        const object = objects.get(key(kind, name, target));
        if (!object) {
          throw failure(404);
        }
        if (body?.preconditions?.uid && body.preconditions.uid !== object.metadata.uid) {
          throw failure(409);
        }
        calls.push({ operation: "delete", kind, name });
        objects.delete(key(kind, name, target));
      };
    }
  }
  clients.discovery.listNamespacedEndpointSlice = async ({ labelSelector, namespace: target }) => {
    const name = labelSelector.split("=")[1];
    const service = objects.get(key("Service", name, target));
    return {
      items: [
        {
          metadata: {
            labels: { "kubernetes.io/service-name": name },
            ownerReferences: [{ kind: "Service", name, uid: service.metadata.uid }],
          },
          endpoints: [{ conditions: { ready: true } }],
        },
      ],
    };
  };
  driver.apiClients = Promise.resolve(clients);
  const preparedNamespace = await driver.ensureNamespace({
    id: revision.namespaceId,
    name: "Repository material tenant",
    status: "ready",
    createdAt: revision.createdAt,
  });
  assert.equal(preparedNamespace.namespaceReady, true, JSON.stringify(preparedNamespace));
  if (mode === "dedicated") {
    assert.deepEqual(
      await driver.provisionAgentRuntimeCredentials(
        {
          namespace: {
            id: revision.namespaceId,
            name: "Repository material tenant",
            status: "ready",
            createdAt: revision.createdAt,
          },
          agent: {
            id: revision.agentId,
            namespaceId: revision.namespaceId,
            name: "Repository material Agent",
            configurationId: revision.configurationId,
            backendId: revision.backendId,
            executionMode: mode,
            servicePrincipalId: revision.servicePrincipalId,
            createdAt: revision.createdAt,
          },
        },
        {},
      ),
      { transportConfigured: true },
    );
  }
  calls.length = 0;
  const apiCalls = [];
  for (const [group, api] of Object.entries(clients)) {
    for (const [method, invoke] of Object.entries(api)) {
      api[method] = async (...args) => {
        apiCalls.push(`${group}.${method}`);
        return invoke(...args);
      };
    }
  }
  const context = (bindings) => ({
    secretEnvironment: [],
    harnessAuth: {
      ...revision.harnessAuth,
      backendRef: {
        namespaceName: kubernetesGatewayNamespaceName(revision.namespaceId),
        name: "model-key",
        key: "value",
        uid: "model-key-uid",
      },
    },
    repositoryCredentials: bindings,
  });
  const deployments = () => [...objects.values()].filter((object) => object.kind === "Deployment");
  const secrets = () =>
    [...objects.values()].filter(
      (object) =>
        object.kind === "Secret" &&
        object.metadata.namespace === namespace &&
        !object.metadata.name.startsWith("gateway-secrets-") &&
        !object.metadata.name.startsWith("harness-secrets-") &&
        !object.metadata.name.startsWith("workspace-node-"),
    );
  const enroll = (selected) => {
    const name = driver.workspaceNodeName(selected);
    const secret = driver.manifest("v1", "Secret", name, driver.pluginRuntimeOwnership(selected), {
      name: namespace,
      plane: "execution",
    });
    save({
      ...secret,
      metadata: {
        ...secret.metadata,
        uid: `${name}-uid`,
        resourceVersion: "1",
      },
      type: "Opaque",
      data: {
        deviceId: Buffer.from(`node-${selected.id}`).toString("base64"),
        setupCode: Buffer.from("completed-setup").toString("base64"),
        // A current setup code, as preparation keeps renewing it.
        expiresAtMs: Buffer.from(String(Date.now() + 600_000)).toString("base64"),
      },
    });
  };
  // Material-focused cases resume a revision with an existing enrolled node. The
  // explicit enrollment case below covers the first-start sequence separately.
  if (alreadyEnrolled) {
    enroll(revision);
  }
  const markReady = () => {
    for (const object of deployments()) {
      object.status = {
        observedGeneration: object.metadata.generation,
        replicas: 1,
        updatedReplicas: 1,
        readyReplicas: 1,
      };
      save(object);
    }
    pods = deployments().map((object) =>
      workloadPod(object, object.metadata.namespace, `${object.metadata.name}-ready`),
    );
  };
  return {
    driver,
    enroll,
    clients,
    revision,
    namespace,
    objects,
    calls,
    apiCalls,
    save,
    context,
    deployments,
    consumer: () =>
      deployments().find(
        (deployment) =>
          deployment.spec.template.metadata.labels["openclaw.dev/workload-role"] ===
          (mode === "embedded" ? "gateway" : "agent"),
      ),
    secrets,
    markReady,
    setPods(value) {
      pods = value;
    },
    observePods(value) {
      observePods = value;
    },
  };
}

function preparedCodexConfig(f) {
  const configurations = [...f.objects.values()].filter(
    (object) =>
      object.kind === "ConfigMap" &&
      object.metadata.namespace === f.namespace &&
      typeof object.data?.["config.toml"] === "string",
  );
  assert.equal(configurations.length, 1);
  return configurations[0].data["config.toml"];
}

function preparedCodexManifest(f) {
  const configurations = [...f.objects.values()].filter(
    (object) =>
      object.kind === "ConfigMap" &&
      object.metadata.namespace === f.namespace &&
      typeof object.data?.["runtime.json"] === "string",
  );
  assert.equal(configurations.length, 1);
  return JSON.parse(configurations[0].data["runtime.json"]);
}

function preparedNativeDocument(f) {
  const configurations = [...f.objects.values()].filter(
    (object) => object.kind === "ConfigMap" && typeof object.data?.["openclaw.json"] === "string",
  );
  assert.equal(configurations.length, 1);
  return configurations[0].data["openclaw.json"];
}

function runtimeWrites(calls) {
  return calls.filter(
    ({ operation, kind }) =>
      operation === "write" && (kind === "ConfigMap" || kind === "Deployment"),
  );
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

test("Dedicated repository custody and networking belong only to Codex", async () => {
  const f = await fixture("dedicated");
  const original = JSON.stringify(f.revision.configuration);
  await f.driver.prepareRevision(f.revision, f.context([runtimeBinding()]));
  const agent = f.consumer();
  const gateway = f.deployments().find((deployment) => deployment !== agent);
  assert.equal(
    preparedNativeDocument(f),
    original,
    "the separate gateway receives no native exec prefix",
  );
  const assertGatewayIsolated = (deployment) => {
    const pod = deployment.spec.template.spec;
    assert.equal(
      deployment.metadata.annotations["openclaw.dev/repository-material-generation"],
      undefined,
    );
    assert.ok(pod.volumes.every(({ name }) => !name.startsWith("repository-material")));
    assert.ok(pod.initContainers.every(({ name }) => name !== "prepare-repository-material"));
    for (const container of pod.containers) {
      assert.ok(
        container.env.every(
          ({ name, value }) =>
            name !== "OPENAI_API_KEY" &&
            name !== "OPENCLAW_GATEWAY_TOKEN" &&
            !value?.includes("repository-credentials"),
        ),
      );
      assert.ok(
        container.volumeMounts.every(({ name }) => !name.startsWith("repository-material")),
      );
    }
  };
  assertGatewayIsolated(gateway);
  const environment = agent.spec.template.spec.containers[0].env;
  assert.ok(environment.some(({ name }) => name === "OPENAI_API_KEY"));
  assert.match(
    environment.find(({ name }) => name === "PATH").value,
    /^\/opt\/oce\/repository-credentials\/bin:/,
  );
  const configuredPeer = {
    to: [
      {
        namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "credentials" } },
        podSelector: { matchLabels: { app: "credentials" } },
      },
    ],
    ports: [{ protocol: "TCP", port: 8443 }],
  };
  f.markReady();
  await f.driver.activateRevision(f.revision, f.context([runtimeBinding()]));
  const policies = [...f.objects.values()].filter(({ kind }) => kind === "NetworkPolicy");
  const repositoryPolicies = policies.filter((policy) =>
    policy.spec.egress?.some((rule) => isDeepStrictEqual(rule, configuredPeer)),
  );
  assert.equal(
    repositoryPolicies.length,
    2,
    "preparation and activation both permit the configured repository peer",
  );
  for (const policy of repositoryPolicies) {
    assert.equal(policy.spec.podSelector.matchLabels["openclaw.dev/workload-role"], "agent");
    assert.equal(policy.spec.podSelector.matchLabels["openclaw.dev/revision"], f.revision.id);
  }
  assertGatewayIsolated(
    f.deployments().find((deployment) => deployment.metadata.name === gateway.metadata.name),
  );
});

test("Dedicated credential refresh preserves its enrolled workspace node", async () => {
  let setups = 0;
  const f = await fixture("dedicated", {
    async createSetup() {
      setups++;
      return {
        setupId: "workspace-setup",
        setupCode: "workspace-code",
        expiresAtMs: deadlineWallMs,
      };
    },
    async observeSetup() {
      return { deviceId: "workspace-node", connected: true };
    },
    async isConnected() {
      return true;
    },
  });
  const original = runtimeBinding();
  await f.driver.prepareRevision(f.revision, f.context([original]));
  f.markReady();
  // Gateway readiness permits enrollment. The setup reaches the running Harness
  // through its volume without replacing it, and this fixture pairs at once.
  assert.equal((await f.driver.prepareRevision(f.revision, f.context([original]))).ready, true);
  // Without a status proxy the controller cannot read the Gateway's ack, so
  // activation binds the recorded node ID into the Gateway's pod spec and waits.
  await assert.rejects(
    f.driver.activateRevision(f.revision, f.context([original])),
    /gateway is not ready/,
  );
  f.markReady();
  await f.driver.activateRevision(f.revision, f.context([original]));
  const before = structuredClone(f.consumer());
  const nodeSecret = [...f.objects.values()].find(
    (secret) => secret.kind === "Secret" && secret.data?.deviceId,
  );
  assert.ok(nodeSecret);
  const nodeMount = before.spec.template.spec.containers[0].volumeMounts.find(
    (mount) => mount.subPath === nodeSecret.metadata.name,
  );
  assert.ok(nodeMount, "the enrolled identity lives in the revision's private state directory");
  const originalGeneration =
    before.metadata.annotations["openclaw.dev/repository-material-generation"];
  const gateway = structuredClone(
    f.deployments().find((deployment) => deployment !== f.consumer()),
  );
  const replacement = runtimeBinding("session_workspace_refresh");
  await assert.rejects(
    f.driver.activateRevision(f.revision, f.context([replacement])),
    /not ready/,
  );
  const refreshed = f.consumer();
  const container = refreshed.spec.template.spec.containers[0];
  assert.notEqual(
    refreshed.metadata.annotations["openclaw.dev/repository-material-generation"],
    originalGeneration,
  );
  assert.deepEqual(container.command, before.spec.template.spec.containers[0].command);
  assert.deepEqual(container.args, before.spec.template.spec.containers[0].args);
  assert.deepEqual(
    container.volumeMounts.find((mount) => mount.subPath === nodeSecret.metadata.name),
    nodeMount,
  );
  assert.equal(
    container.env.some(({ name }) => name === "OPENCLAW_NODE_SETUP_CODE"),
    false,
    "the setup code never enters the Harness environment",
  );
  assert.deepEqual(
    refreshed.spec.template.spec.volumes.find(({ name }) => name === "openclaw-node-setup"),
    before.spec.template.spec.volumes.find(({ name }) => name === "openclaw-node-setup"),
  );
  assert.equal(nodeSecret.data.setupCode, undefined, "readiness removed the paired setup code");
  assert.deepEqual(
    f.objects.get(`Secret:${nodeSecret.metadata.namespace}:${nodeSecret.metadata.name}`),
    nodeSecret,
  );
  assert.deepEqual(
    f.objects.get(`Deployment:${gateway.metadata.namespace}:${gateway.metadata.name}`),
    gateway,
    "an unready credential replacement must not change the serving Gateway",
  );
  assert.equal(setups, 1, "credential rotation must reuse the enrolled node");
  f.markReady();
  await f.driver.activateRevision(f.revision, f.context([replacement]));
  assert.equal(setups, 1);
  assert.deepEqual(
    f.objects.get(`Secret:${nodeSecret.metadata.namespace}:${nodeSecret.metadata.name}`),
    nodeSecret,
  );
  assert.equal(f.secrets().filter((secret) => secret.immutable).length, 1);
});

test("Kubernetes keeps original admission correlation out of runtime resources", async () => {
  const f = await fixture("dedicated");
  const admissionId = "1720000000000-12345678-1234-4234-8234-123456789abc";
  const binding = { ...runtimeBinding(), admissionId };
  // The Worker may carry its original attempt identity internally; it is not
  // a credential and must not be exposed in the Agent's material resources.
  await f.driver.prepareRevision(f.revision, f.context([binding]));
  assert.equal(JSON.stringify([...f.objects.values()]).includes(admissionId), false);
  await f.driver.prepareRevision(
    f.revision,
    f.context([
      {
        kind: "retained",
        repositoryRef: binding.repositoryRef,
        sessionId: binding.sessionId,
        deadlineWallMs: binding.deadlineWallMs,
        admissionId,
      },
    ]),
  );
  assert.equal(f.secrets().length, 1);

  for (const invalid of ["", "bad\ncorrelation", "x".repeat(129), null]) {
    const other = await fixture("dedicated");
    await assert.rejects(
      other.driver.prepareRevision(
        other.revision,
        other.context([{ ...binding, admissionId: invalid }]),
      ),
      { message: "Repository credential material is invalid." },
    );
    assert.deepEqual(other.apiCalls, []);
  }
});

for (const mode of ["embedded", "dedicated"]) {
  test(`Repository material is rechecked after plugin status (${mode})`, async () => {
    const f = await fixture(
      mode,
      mode === "embedded"
        ? undefined
        : {
            async createSetup() {
              return {
                setupId: "plugin-setup",
                setupCode: "plugin-code",
                expiresAtMs: deadlineWallMs,
              };
            },
            async observeSetup() {
              return { deviceId: "plugin-node", connected: true };
            },
            async isConnected() {
              return true;
            },
          },
    );
    const pluginId = mode === "embedded" ? "openclaw-plugin:example" : "codex-plugin:example";
    const driverId = mode === "embedded" ? "openclaw-plugin" : "codex-plugin";
    f.revision.plugins = {
      driver: { id: driverId, implementation: `occ/${driverId}` },
      plugins: { [pluginId]: { enabled: true, toolDefaults: { approval: "provider_default" } } },
    };
    let loseMaterialReadiness = false;
    let statusObserved = false;
    f.clients.core.connectGetNamespacedPodProxyWithPath = async ({ name }) => {
      const podName = name.split(":")[0];
      const role = podName.startsWith("gateway-") ? "gateway" : "agent";
      if (loseMaterialReadiness && role === "gateway") {
        statusObserved = true;
        // A status response can arrive after the credential consumer loses readiness.
        // Keep its identity stable so status readback alone cannot detect the change.
        f.setPods(
          f
            .deployments()
            .map((deployment) =>
              workloadPod(
                deployment,
                f.namespace,
                `${deployment.metadata.name}-ready`,
                deployment !== f.consumer(),
              ),
            ),
        );
      }
      return {
        revisionId: f.revision.id,
        container: role,
        podUid: `${podName}-uid`,
        startupId: `${role}-startup`,
        phase: "ready",
        successfulPluginIds: [pluginId],
        failures: [],
      };
    };
    const prepare = () => f.driver.prepareRevision(f.revision, f.context([runtimeBinding()]));
    // Observe each startup generation, including the Gateway's enrolled-node binding.
    for (let generation = 0; generation < 6; generation++) {
      await prepare();
      f.markReady();
    }
    assert.equal((await prepare()).ready, true);
    loseMaterialReadiness = true;
    assert.equal((await prepare()).ready, false);
    assert.equal(statusObserved, true);
  });
}

test("Embedded successor is not ready when material expires during policy reconciliation", async (t) => {
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const f = await fixture("embedded");
  const original = runtimeBinding();
  await f.driver.prepareRevision(f.revision, f.context([original]));
  f.markReady();
  await f.driver.activateRevision(f.revision, f.context([original]));

  const successor = { ...f.revision, id: "revision-successor", revision: 2 };
  const replacement = runtimeBinding("session_successor");
  const patchPolicy = f.clients.networking.patchNamespacedNetworkPolicy;
  let policyObserved = false;
  f.clients.networking.patchNamespacedNetworkPolicy = async (...args) => {
    const result = await patchPolicy(...args);
    policyObserved = true;
    clock = deadlineWallMs;
    return result;
  };
  const result = await f.driver.prepareRevision(successor, f.context([replacement]));
  assert.equal(policyObserved, true);
  assert.equal(result.ready, false);
});

test("Dedicated successor material is rechecked after workspace-node status", async () => {
  let loseMaterialReadiness = false;
  let statusObserved = false;
  let successor;
  const f = await fixture("dedicated", {
    async createSetup() {
      throw new Error("The material fixture already has an enrolled node.");
    },
    async isConnected() {
      if (loseMaterialReadiness) {
        statusObserved = true;
        f.setPods(
          f.deployments().map((deployment) => {
            const labels = deployment.spec.template.metadata.labels;
            const successorConsumer =
              labels["openclaw.dev/workload-role"] === "agent" &&
              labels["openclaw.dev/revision"] === successor.id;
            return workloadPod(
              deployment,
              f.namespace,
              `${deployment.metadata.name}-ready`,
              !successorConsumer,
            );
          }),
        );
      }
      return true;
    },
  });
  f.enroll(f.revision);
  const original = runtimeBinding();
  await f.driver.prepareRevision(f.revision, f.context([original]));
  f.markReady();
  await f.driver.activateRevision(f.revision, f.context([original]));
  successor = { ...f.revision, id: "revision-successor", revision: 2 };
  f.enroll(successor);
  const replacement = runtimeBinding("session_successor");
  const prepare = () => f.driver.prepareRevision(successor, f.context([replacement]));
  await prepare();
  f.markReady();
  assert.equal((await prepare()).ready, true);
  const gateway = f
    .deployments()
    .find(
      (deployment) =>
        deployment.spec.template.metadata.labels["openclaw.dev/workload-role"] === "gateway",
    );
  assert.equal(gateway.spec.template.metadata.labels["openclaw.dev/revision"], f.revision.id);
  loseMaterialReadiness = true;
  assert.equal((await prepare()).ready, false);
  assert.equal(statusObserved, true);
  loseMaterialReadiness = false;
  f.markReady();
  assert.equal((await prepare()).ready, true);
});

test("Dedicated successor is not ready when material expires during workspace-node status", async (t) => {
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  let expireOnStatus = false;
  let statusObserved = false;
  const f = await fixture("dedicated", {
    async createSetup() {
      throw new Error("The material fixture already has an enrolled node.");
    },
    async isConnected() {
      if (expireOnStatus) {
        statusObserved = true;
        clock = deadlineWallMs;
      }
      return true;
    },
  });
  f.enroll(f.revision);
  const original = runtimeBinding();
  await f.driver.prepareRevision(f.revision, f.context([original]));
  f.markReady();
  await f.driver.activateRevision(f.revision, f.context([original]));

  const successor = { ...f.revision, id: "revision-successor", revision: 2 };
  f.enroll(successor);
  const replacement = runtimeBinding("session_successor");
  const prepare = () => f.driver.prepareRevision(successor, f.context([replacement]));
  await prepare();
  f.markReady();
  assert.equal((await prepare()).ready, true);
  expireOnStatus = true;
  assert.equal((await prepare()).ready, false);
  assert.equal(statusObserved, true);
});

test("Dedicated activation refuses material that expires during workspace-node status", async (t) => {
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  let expireOnStatus = false;
  let statusObserved = false;
  const f = await fixture("dedicated", {
    async createSetup() {
      throw new Error("The material fixture already has an enrolled node.");
    },
    async isConnected() {
      if (expireOnStatus) {
        statusObserved = true;
        clock = deadlineWallMs;
      }
      return true;
    },
  });
  f.enroll(f.revision);
  const binding = runtimeBinding();
  await f.driver.prepareRevision(f.revision, f.context([binding]));
  f.markReady();
  await f.driver.activateRevision(f.revision, f.context([binding]));
  f.markReady();

  expireOnStatus = true;
  await assert.rejects(f.driver.activateRevision(f.revision, f.context([binding])), {
    message: "The exact repository credential runtime generation is not ready.",
  });
  assert.equal(statusObserved, true);
});

test("Dedicated retained-material loss reports only the missing session and accepts worker replacement", async () => {
  const f = await fixture("dedicated");
  const original = runtimeBinding();
  await f.driver.prepareRevision(f.revision, f.context([original]));
  f.markReady();
  await f.driver.activateRevision(f.revision, f.context([original]));
  const secret = f.secrets()[0];
  f.objects.delete(`Secret:${secret.metadata.namespace}:${secret.metadata.name}`);
  const { files: _files, ...retained } = original;
  retained.kind = "retained";
  const lost = await f.driver.prepareRevision(f.revision, f.context([retained]));
  assert.equal(lost.ready, false);
  assert.deepEqual(lost.repositoryCredentialMaterialMissing, [
    { repositoryRef: original.repositoryRef, sessionId: original.sessionId },
  ]);
  await assert.rejects(
    f.driver.activateRevision(f.revision, f.context([retained])),
    /material is unavailable/,
  );
  assert.equal(f.secrets().length, 0, "Compute must not recreate retained custody");
  // The worker owns disposal and issuance; Compute receives the replacement as new material.
  const replacement = runtimeBinding("session_worker_repaired");
  assert.equal((await f.driver.prepareRevision(f.revision, f.context([replacement]))).ready, false);
  f.markReady();
  assert.equal((await f.driver.prepareRevision(f.revision, f.context([replacement]))).ready, true);
  await f.driver.activateRevision(f.revision, f.context([replacement]));
  assert.equal(f.secrets().length, 1);
});

test("Dedicated material readiness ignores another revision, gateway role and terminating Pods", async (t) => {
  for (const mismatch of ["revision", "role", "terminating"]) {
    await t.test(mismatch, async () => {
      const f = await fixture("dedicated");
      const binding = runtimeBinding();
      await f.driver.prepareRevision(f.revision, f.context([binding]));
      f.markReady();
      const pod = workloadPod(f.consumer(), f.namespace, "non-current-ready");
      if (mismatch === "revision") {
        pod.metadata.labels["openclaw.dev/revision"] = "another-revision";
      }
      if (mismatch === "role") {
        pod.metadata.labels["openclaw.dev/workload-role"] = "gateway";
      }
      if (mismatch === "terminating") {
        pod.metadata.deletionTimestamp = "2026-09-22T00:00:00.000Z";
      }
      f.setPods([pod]);
      assert.equal((await f.driver.prepareRevision(f.revision, f.context([binding]))).ready, false);
      await assert.rejects(
        f.driver.activateRevision(f.revision, f.context([binding])),
        /not ready/,
      );
    });
  }
});

test("Dedicated rotation retains material referenced by an owned template before its Pod exists", async () => {
  const f = await fixture("dedicated");
  const original = runtimeBinding();
  await f.driver.prepareRevision(f.revision, f.context([original]));
  f.markReady();
  await f.driver.activateRevision(f.revision, f.context([original]));
  const retainedTemplate = structuredClone(f.consumer());
  retainedTemplate.metadata.name += "-retiring";
  f.save(retainedTemplate);
  const replacement = runtimeBinding("session_template_replacement");
  await f.driver.prepareRevision(f.revision, f.context([replacement]));
  f.markReady();
  f.setPods([workloadPod(f.consumer(), f.namespace, "current-material")]);
  await f.driver.prepareRevision(f.revision, f.context([replacement]));
  assert.equal(
    f.secrets().length,
    2,
    "absence of an old Pod does not release its template's material",
  );
  f.objects.delete(
    `Deployment:${retainedTemplate.metadata.namespace}:${retainedTemplate.metadata.name}`,
  );
  await f.driver.prepareRevision(f.revision, f.context([replacement]));
  assert.equal(f.secrets().length, 1);
});

test("Dedicated retirement preserves the successor gateway, Agent and repository material", async () => {
  const f = await fixture("dedicated");
  const original = runtimeBinding();
  await f.driver.prepareRevision(f.revision, f.context([original]));
  f.markReady();
  await f.driver.activateRevision(f.revision, f.context([original]));
  const oldSecret = f.secrets()[0].metadata.name;
  const successor = { ...f.revision, id: "revision-successor", revision: 2 };
  f.enroll(successor);
  const replacement = runtimeBinding("session_successor");
  await f.driver.prepareRevision(successor, f.context([replacement]));
  f.markReady();
  assert.equal((await f.driver.prepareRevision(successor, f.context([replacement]))).ready, true);
  await assert.rejects(
    f.driver.activateRevision(successor, f.context([replacement])),
    /gateway is not ready/,
  );
  f.markReady();
  await f.driver.activateRevision(successor, f.context([replacement]));
  // Kubernetes completes old Pod deletion while the current consumers remain running.
  f.observePods(() =>
    f.setPods(
      f
        .deployments()
        .filter(
          (deployment) =>
            deployment.spec.template.metadata.labels["openclaw.dev/revision"] === successor.id,
        )
        .map((deployment) =>
          workloadPod(deployment, f.namespace, `${deployment.metadata.name}-current`),
        ),
    ),
  );
  await f.driver.retireRevision(f.revision);
  assert.equal(f.secrets().length, 1);
  assert.notEqual(f.secrets()[0].metadata.name, oldSecret);
  assert.equal(f.deployments().length, 2);
  assert.ok(
    f
      .deployments()
      .every(
        (deployment) =>
          deployment.spec.template.metadata.labels["openclaw.dev/revision"] === successor.id,
      ),
  );
  await f.driver.activateRevision(successor, f.context([replacement]));
});

test("Dedicated Codex repository bindings receive broker network policy centrally", async () => {
  const f = await fixture("dedicated", undefined, {
    repositoryNamespace: "123-control",
  });
  await f.driver.prepareRevision(
    f.revision,
    f.context([
      runtimeBinding(
        "session_custom_control",
        undefined,
        "https://git.123-control.svc.cluster.local",
      ),
    ]),
  );
  const config = preparedCodexConfig(f);
  assert.match(config, /^\[features\]$/m);
  assert.doesNotMatch(config, /^\[network_proxy\]$/m);
  assert.doesNotMatch(config, /^\[\[network\.private_endpoints\]\]$/m);
  assert.doesNotMatch(config, /privateEndpoints|private_endpoints|default_permissions/);
  assert.deepEqual(preparedCodexManifest(f).repositoryBrokerNetworkPolicy, {
    host: "git.123-control.svc.cluster.local",
    domains: {},
  });
});

test("Dedicated Codex repository policy is independent of preset shape", async (t) => {
  for (const [name, configure] of [
    ["default", () => {}],
    [
      "swe",
      (configuration) => {
        configuration.agents.defaults.instructions = "Handle software engineering work.";
      },
    ],
    [
      "custom",
      (configuration) => {
        configuration.plugins.entries.codex.config.appServer.networkProxy = {
          enabled: true,
          mode: "limited",
          domains: { "github.com": "allow" },
        };
      },
    ],
  ]) {
    await t.test(name, async () => {
      const f = await fixture("dedicated");
      configure(f.revision.configuration);
      await f.driver.prepareRevision(f.revision, f.context([runtimeBinding()]));
      const policy = preparedCodexManifest(f).repositoryBrokerNetworkPolicy;
      assert.equal(policy.host, "git.credentials.svc.cluster.local");
      if (name === "custom") {
        assert.deepEqual(policy.domains, { "github.com": "allow" });
      }
    });
  }
});

test("Dedicated Codex repository policy preserves compatible domain decisions", async () => {
  const f = await fixture("dedicated");
  f.revision.configuration.plugins.entries.codex.config.appServer.networkProxy = {
    enabled: true,
    mode: "limited",
    domains: { "GitHub.COM ": "allow", "*.credentials.svc.cluster.local": "deny" },
  };
  await f.driver.prepareRevision(f.revision, f.context([runtimeBinding()]));
  assert.deepEqual(preparedCodexManifest(f).repositoryBrokerNetworkPolicy, {
    host: "git.credentials.svc.cluster.local",
    domains: { "github.com": "allow", "*.credentials.svc.cluster.local": "deny" },
  });
});

test("Dedicated Codex repository policy preserves an explicitly disabled network proxy", async () => {
  const f = await fixture("dedicated");
  f.revision.configuration.plugins.entries.codex.config.appServer.networkProxy = { enabled: false };
  await assert.rejects(
    f.driver.prepareRevision(f.revision, f.context([runtimeBinding()])),
    /explicitly disabled Codex network proxy/,
  );
  assert.deepEqual(
    runtimeWrites(f.calls),
    [],
    "explicit network-proxy disablement must fail before runtime configuration or workload writes",
  );
});

test("Dedicated Codex repository policy preserves explicit broker host denies", async () => {
  const f = await fixture("dedicated");
  f.revision.configuration.plugins.entries.codex.config.appServer.networkProxy ??= {};
  f.revision.configuration.plugins.entries.codex.config.appServer.networkProxy.domains = {
    " Git.Credentials.SVC.Cluster.Local ": "deny",
    "git.credentials.svc.cluster.local": "allow",
  };
  await assert.rejects(
    f.driver.prepareRevision(f.revision, f.context([runtimeBinding()])),
    /broker host is explicitly denied/,
  );
  assert.deepEqual(
    runtimeWrites(f.calls),
    [],
    "explicit administrative denies must fail before runtime configuration or workload writes",
  );
});

test("Dedicated Codex repository policy accepts stock private-network settings", async (t) => {
  for (const [name, networkProxy] of [
    ["full mode", { enabled: true, mode: "full" }],
    ["local binding", { enabled: true, mode: "limited", allowLocalBinding: true }],
  ]) {
    await t.test(name, async () => {
      const f = await fixture("dedicated");
      f.revision.configuration.plugins.entries.codex.config.appServer.networkProxy = networkProxy;
      await f.driver.prepareRevision(f.revision, f.context([runtimeBinding()]));
      assert.deepEqual(preparedCodexManifest(f).repositoryBrokerNetworkPolicy, {
        host: "git.credentials.svc.cluster.local",
        domains: {},
      });
    });
  }
});

test("Dedicated Codex repository policy rejects malformed domain policy containers", async (t) => {
  for (const [name, networkProxy, reason] of [
    [
      "domains array",
      { enabled: true, mode: "limited", domains: ["github.com"] },
      /network policy domains must be an object/,
    ],
    [
      "domains scalar",
      { enabled: true, mode: "limited", domains: "github.com" },
      /network policy domains must be an object/,
    ],
  ]) {
    await t.test(name, async () => {
      const f = await fixture("dedicated");
      f.revision.configuration.plugins.entries.codex.config.appServer.networkProxy = networkProxy;
      await assert.rejects(
        f.driver.prepareRevision(f.revision, f.context([runtimeBinding()])),
        reason,
      );
      assert.deepEqual(
        runtimeWrites(f.calls),
        [],
        "malformed explicit domain policy containers must fail before runtime configuration or workload writes",
      );
    });
  }
});

test("Dedicated Codex without repository bindings does not receive broker policy", async () => {
  const f = await fixture("dedicated");
  delete f.revision.repositoryCredentials;
  await f.driver.prepareRevision(f.revision, f.context(undefined));
  const config = preparedCodexConfig(f);
  assert.doesNotMatch(config, /private_endpoints/);
  assert.equal(preparedCodexManifest(f).repositoryBrokerNetworkPolicy, undefined);
});

test("Embedded OpenClaw repository bindings without Codex plugins do not receive broker policy", async () => {
  const f = await fixture("embedded");
  await f.driver.prepareRevision(f.revision, f.context([runtimeBinding()]));
  const codexRuntimeManifests = [...f.objects.values()].filter(
    (object) =>
      object.kind === "ConfigMap" &&
      object.metadata.namespace === f.namespace &&
      typeof object.data?.["runtime.json"] === "string",
  );
  assert.deepEqual(codexRuntimeManifests, []);
});

test("Embedded OpenClaw plugin runtime does not receive Codex broker policy", async () => {
  const f = await fixture("embedded");
  f.revision.plugins = openClawPluginState();
  await f.driver.prepareRevision(f.revision, f.context([runtimeBinding()]));
  const manifest = preparedCodexManifest(f);
  assert.equal(manifest.kind, "openclaw");
  assert.equal(manifest.repositoryBrokerNetworkPolicy, undefined);
});

test("Embedded Codex plugin runtime receives broker network policy centrally", async () => {
  const f = await fixture("embedded");
  f.revision.plugins = codexPluginState();
  await f.driver.prepareRevision(f.revision, f.context([runtimeBinding()]));
  assert.deepEqual(preparedCodexManifest(f).repositoryBrokerNetworkPolicy, {
    host: "git.credentials.svc.cluster.local",
    domains: {},
  });
});

// Both consumer shapes must trust the projected CA without disabling TLS verification.
for (const mode of ["embedded", "dedicated"]) {
  test(`Repository consumer projects a combined broker CA bundle (${mode})`, async () => {
    const f = await fixture(mode);
    const publicCa = Buffer.from(
      "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n",
    );
    await f.driver.prepareRevision(
      f.revision,
      f.context([runtimeBinding("session_with_ca", publicCa)]),
    );
    const environment = Object.fromEntries(
      f.consumer().spec.template.spec.containers[0].env.map(({ name, value }) => [name, value]),
    );
    assert.match(
      environment.SSL_CERT_FILE,
      /^\/run\/oce\/repository-credentials\/sessions\/[a-f0-9]{64}\/ca-bundle\.pem$/,
    );
    assert.equal(environment.GIT_SSL_CAINFO, environment.SSL_CERT_FILE);
    assert.equal(environment.NODE_EXTRA_CA_CERTS, environment.SSL_CERT_FILE);
  });
}

test("Kubernetes projects the repository client into native exec paths without changing admitted configuration", async (t) => {
  for (const roster of ["list", "entries"]) {
    await t.test(roster, async () => {
      const f = await fixture();
      const shim = "/opt/oce/repository-credentials/bin";
      f.revision.configuration.tools = {
        allow: ["exec", "process"],
        exec: {
          host: "gateway",
          mode: "full",
          timeoutSec: 120,
          pathPrepend: ["/operator/bin", shim, "/shared/bin", shim],
        },
      };
      f.revision.configuration.agents.ownership = "explicit";
      f.revision.configuration.agents.list = [
        {
          id: "custom",
          tools: {
            allow: ["exec"],
            exec: { host: "gateway", mode: "full", pathPrepend: ["/agent/bin", shim] },
          },
        },
        { id: "own-exec", tools: { exec: { mode: "full" } } },
        { id: "inherits", tools: { allow: ["exec", "process"] } },
        { id: "plain" },
      ];
      if (roster === "entries") {
        f.revision.configuration.agents.entries = Object.fromEntries(
          f.revision.configuration.agents.list.map(({ id, ...entry }) => [id, entry]),
        );
        delete f.revision.configuration.agents.list;
      }
      const original = structuredClone(f.revision.configuration);
      deepFreeze(f.revision.configuration);

      // The actual runtime document must survive OpenClaw's exec environment
      // construction; setting only the Kubernetes container PATH is insufficient.
      await f.driver.prepareRevision(f.revision, f.context([runtimeBinding()]));
      const expected = structuredClone(original);
      expected.tools.exec.pathPrepend = [shim, "/operator/bin", "/shared/bin"];
      const custom = roster === "list" ? expected.agents.list[0] : expected.agents.entries.custom;
      const ownExec =
        roster === "list" ? expected.agents.list[1] : expected.agents.entries["own-exec"];
      custom.tools.exec.pathPrepend = [shim, "/agent/bin"];
      ownExec.tools.exec.pathPrepend = [shim, "/operator/bin", "/shared/bin"];
      assert.deepEqual(JSON.parse(preparedNativeDocument(f)), expected);
      assert.deepEqual(f.revision.configuration, original);
    });
  }
});

test("Kubernetes supplies a native repository exec prefix when no tools configuration exists", async () => {
  const f = await fixture();
  const original = structuredClone(f.revision.configuration);
  deepFreeze(f.revision.configuration);
  await f.driver.prepareRevision(f.revision, f.context([runtimeBinding()]));
  assert.deepEqual(JSON.parse(preparedNativeDocument(f)), {
    ...original,
    tools: { exec: { pathPrepend: ["/opt/oce/repository-credentials/bin"] } },
  });
  assert.deepEqual(f.revision.configuration, original);
});

test("Kubernetes preserves native configuration bytes without repository bindings", async (t) => {
  for (const runtimeBindings of [undefined, []]) {
    await t.test(runtimeBindings === undefined ? "missing" : "empty", async () => {
      const f = await fixture();
      delete f.revision.repositoryCredentials;
      f.revision.configuration.tools = {
        allow: ["exec"],
        exec: { host: "gateway", mode: "full", pathPrepend: ["/operator/bin"] },
      };
      const document = JSON.stringify(f.revision.configuration);
      deepFreeze(f.revision.configuration);
      await f.driver.prepareRevision(f.revision, f.context(runtimeBindings));
      assert.equal(preparedNativeDocument(f), document);
      assert.equal(JSON.stringify(f.revision.configuration), document);
    });
  }
});

test("Kubernetes rejects malformed repository exec configuration before any API access", async (t) => {
  const malformed = [
    ["tools null", { tools: null }, "Repository credentials require tools to be an object."],
    ["tools array", { tools: [] }, "Repository credentials require tools to be an object."],
    [
      "exec string",
      { tools: { exec: "full" } },
      "Repository credentials require tools.exec to be an object.",
    ],
    [
      "exec null",
      { tools: { exec: null } },
      "Repository credentials require tools.exec to be an object.",
    ],
    [
      "exec array",
      { tools: { exec: [] } },
      "Repository credentials require tools.exec to be an object.",
    ],
    [
      "prefix scalar",
      { tools: { exec: { pathPrepend: "/operator/bin" } } },
      "Repository credentials require tools.exec.pathPrepend to be an array of strings.",
    ],
    [
      "prefix null",
      { tools: { exec: { pathPrepend: null } } },
      "Repository credentials require tools.exec.pathPrepend to be an array of strings.",
    ],
    [
      "prefix nonstring",
      { tools: { exec: { pathPrepend: ["/operator/bin", 1] } } },
      "Repository credentials require tools.exec.pathPrepend to be an array of strings.",
    ],
    ["agents null", { agents: null }, "Repository credentials require agents to be an object."],
    ["agents array", { agents: [] }, "Repository credentials require agents to be an object."],
    [
      "agent list object",
      { agents: { list: {} } },
      "Repository credentials require agents.list to be an array.",
    ],
    [
      "agent list null",
      { agents: { list: null } },
      "Repository credentials require agents.list to be an array.",
    ],
    [
      "agent entries null",
      { agents: { entries: null } },
      "Repository credentials require agents.entries to be an object.",
    ],
    [
      "agent entries array",
      { agents: { entries: [] } },
      "Repository credentials require agents.entries to be an object.",
    ],
    [
      "agent entry null",
      { agents: { entries: { main: null } } },
      "Repository credentials require agents.entries entry to be an object.",
    ],
    [
      "agent entry exec string",
      { agents: { entries: { main: { tools: { exec: "full" } } } } },
      "Repository credentials require agents.entries entry.tools.exec to be an object.",
    ],
    [
      "agent entry prefix nonstring",
      { agents: { entries: { main: { tools: { exec: { pathPrepend: [false] } } } } } },
      "Repository credentials require agents.entries entry.tools.exec.pathPrepend to be an array of strings.",
    ],
    [
      "agent null",
      { agents: { list: [null] } },
      "Repository credentials require agents.list entry to be an object.",
    ],
    [
      "agent array",
      { agents: { list: [[]] } },
      "Repository credentials require agents.list entry to be an object.",
    ],
    [
      "agent tools null",
      { agents: { list: [{ id: "main", tools: null }] } },
      "Repository credentials require agents.list entry.tools to be an object.",
    ],
    [
      "agent tools array",
      { agents: { list: [{ id: "main", tools: [] }] } },
      "Repository credentials require agents.list entry.tools to be an object.",
    ],
    [
      "agent exec null",
      { agents: { list: [{ id: "main", tools: { exec: null } }] } },
      "Repository credentials require agents.list entry.tools.exec to be an object.",
    ],
    [
      "agent exec array",
      { agents: { list: [{ id: "main", tools: { exec: [] } }] } },
      "Repository credentials require agents.list entry.tools.exec to be an object.",
    ],
    [
      "agent prefix scalar",
      { agents: { list: [{ id: "main", tools: { exec: { pathPrepend: "/agent/bin" } } }] } },
      "Repository credentials require agents.list entry.tools.exec.pathPrepend to be an array of strings.",
    ],
    [
      "agent prefix nonstring",
      { agents: { list: [{ id: "main", tools: { exec: { pathPrepend: [false] } } }] } },
      "Repository credentials require agents.list entry.tools.exec.pathPrepend to be an array of strings.",
    ],
  ];
  for (const [name, configuration, message] of malformed) {
    await t.test(name, async () => {
      const f = await fixture();
      const agentDefaults = f.revision.configuration.agents.defaults;
      Object.assign(f.revision.configuration, structuredClone(configuration));
      if (configuration.agents && !Array.isArray(configuration.agents)) {
        f.revision.configuration.agents.defaults = agentDefaults;
      }
      const before = structuredClone(f.revision.configuration);
      await assert.rejects(f.driver.prepareRevision(f.revision, f.context([runtimeBinding()])), {
        message,
      });
      assert.deepEqual(
        f.apiCalls,
        [],
        "invalid native configuration must fail before Kubernetes reads or writes",
      );
      // Activation is a separate reconciliation entrypoint and must not bypass
      // the same native configuration validation before consulting workloads.
      await assert.rejects(f.driver.activateRevision(f.revision, f.context([runtimeBinding()])), {
        message,
      });
      assert.deepEqual(f.apiCalls, [], "activation must reject before Kubernetes reads or writes");
      assert.deepEqual(f.revision.configuration, before);
    });
  }
});

test("Kubernetes rejects invalid repository text before any API access", async (t) => {
  for (const [name, content] of [
    ["unpaired high surrogate", "\ud800"],
    ["unpaired low surrogate", "\udfff"],
    ["UTF-8 byte limit", "\u00e9".repeat(32 * 1024) + "a"],
  ]) {
    await t.test(name, async () => {
      const f = await fixture();
      const binding = runtimeBinding();
      binding.files["ca.pem"] = content;
      const document = JSON.parse(binding.files["client.json"]);
      document.hasPublicCa = true;
      binding.files["client.json"] = JSON.stringify(document);
      // No Secret or workload may observe text that cannot be stored losslessly.
      await assert.rejects(f.driver.prepareRevision(f.revision, f.context([binding])), {
        message: "Repository credential material is invalid.",
      });
      assert.deepEqual(f.apiCalls, []);
    });
  }
});

for (const mode of ["embedded", "dedicated"]) {
  test(`Kubernetes repository material lifecycle (${mode})`, async (t) => {
    await t.test(
      "Kubernetes preparation creates immutable material and mounts only private output in the runtime",
      async () => {
        const f = await fixture(mode);
        const binding = runtimeBinding();
        await f.driver.prepareRevision(f.revision, f.context([binding]));
        assert.equal(f.secrets().length, 1);
        const secret = f.secrets()[0];
        assert.equal(secret.immutable, true);
        const pod = f.consumer().spec.template.spec;
        const init = pod.initContainers.find((container) => container.name.includes("repository"));
        assert.ok(init, "repository material must pass through an init container");
        const output = pod.volumes.find((volume) => volume.emptyDir?.medium === "Memory");
        assert.ok(output, "runtime material requires a memory-backed private volume");
        const mount = pod.containers[0].volumeMounts.find((value) => value.name === output.name);
        assert.equal(mount.readOnly, true);
        assert.equal(mount.subPath, "private");
        assert.equal(mount.mountPath, "/run/oce/repository-credentials");
        const nativeIndex = pod.initContainers.findIndex(
          ({ name }) => name === "prepare-repository-native-git",
        );
        assert.ok(nativeIndex > pod.initContainers.indexOf(init));
        const native = pod.initContainers[nativeIndex];
        assert.deepEqual(native.volumeMounts, [{ ...mount, readOnly: false }]);
        assert.equal(pod.securityContext.runAsNonRoot, true);
        for (const initializer of [init, native]) {
          assert.deepEqual(initializer.command, [...SETUP_WRAPPER_COMMAND]);
          assert.equal(initializer.securityContext.readOnlyRootFilesystem, true);
          assert.equal(initializer.securityContext.allowPrivilegeEscalation, false);
          assert.deepEqual(initializer.securityContext.capabilities, { drop: ["ALL"] });
        }
        assert.equal(JSON.stringify(pod).includes(binding.files.bearer), false);
        assert.equal(
          JSON.stringify(
            [...f.objects.values()].filter((object) => object.kind === "ConfigMap"),
          ).includes(binding.files.bearer),
          false,
        );
        const retained = {
          kind: "retained",
          repositoryRef: binding.repositoryRef,
          sessionId: binding.sessionId,
          deadlineWallMs,
        };
        await f.driver.prepareRevision(f.revision, f.context([retained]));
        assert.equal(
          f.calls.filter(
            (call) =>
              call.operation === "write" &&
              call.kind === "Secret" &&
              call.name.startsWith("oce-repository-"),
          ).length,
          1,
        );
      },
    );

    for (const publicCa of [undefined, Buffer.from("fixture-public-ca")]) {
      await t.test(
        `repository file ordering preserves the Pod template (public CA: ${publicCa !== undefined})`,
        async () => {
          const f = await fixture(mode);
          const binding = runtimeBinding(undefined, publicCa);
          await f.driver.prepareRevision(f.revision, f.context([binding]));
          const originalTemplate = structuredClone(f.consumer().spec.template);
          const originalGeneration = f.consumer().metadata.generation;

          // JSON object members may return in a different order after storage.
          // That must not restart an unchanged credential-consuming workload.
          const secret = f.secrets()[0];
          secret.data = Object.fromEntries(Object.entries(secret.data).reverse());
          f.save(secret);
          const { files, ...retained } = binding;
          retained.kind = "retained";
          await f.driver.prepareRevision(f.revision, f.context([retained]));
          assert.deepEqual(f.consumer().spec.template, originalTemplate);
          assert.equal(f.consumer().metadata.generation, originalGeneration);

          const reordered = {
            ...binding,
            files: Object.fromEntries(Object.entries(files).reverse()),
          };
          await f.driver.prepareRevision(f.revision, f.context([reordered]));
          assert.deepEqual(f.consumer().spec.template, originalTemplate);
          assert.equal(f.consumer().metadata.generation, originalGeneration);
        },
      );
    }

    await t.test(
      "Kubernetes reports exact missing retained material without silently creating new custody",
      async () => {
        const f = await fixture(mode);
        // The new binding is visited first; a later missing reference must prevent
        // the entire set from publishing any new Secret or workload.
        const pending = { ...runtimeBinding(), repositoryRef: "earlier-project" };
        f.revision.repositoryCredentials.bindings.push({
          ...f.revision.repositoryCredentials.bindings[0],
          repositoryRef: pending.repositoryRef,
        });
        const missing = { repositoryRef: "project", sessionId: "session-missing" };
        const context = f.context([pending, { kind: "retained", ...missing, deadlineWallMs }]);
        assert.deepEqual(await f.driver.prepareRevision(f.revision, context), {
          namespaceId: f.revision.namespaceId,
          agentId: f.revision.agentId,
          revisionId: f.revision.id,
          ready: false,
          repositoryCredentialMaterialMissing: [missing],
        });
        // Dedicated activation reports the missing material. Embedded activation refuses
        // earlier: preparation stopped, so the shared gateway Deployment was never created.
        await assert.rejects(
          f.driver.activateRevision(f.revision, context),
          mode === "dedicated"
            ? {
                name: "DependencyUnavailableError",
                message: "Repository credential material is unavailable for activation.",
              }
            : { message: "The Agent gateway workload is unavailable." },
        );
        assert.equal(
          f.calls.filter((call) => call.operation === "write" && call.kind === "Secret").length,
          0,
        );
        assert.equal(f.secrets().length, 0);
        assert.equal(f.deployments().length, 0);
        if (mode === "embedded") {
          // Once the shared gateway exists, embedded activation reaches the same refusal and
          // publishes no Secret for the set while one retained reference is missing.
          const project = runtimeBinding("session_material_project");
          await f.driver.prepareRevision(f.revision, f.context([pending, project]));
          assert.equal(f.deployments().length, 1);
          const writes = f.calls.length;
          await assert.rejects(f.driver.activateRevision(f.revision, context), {
            name: "DependencyUnavailableError",
            message: "Repository credential material is unavailable for activation.",
          });
          assert.deepEqual(
            f.calls.slice(writes).filter((call) => call.operation === "write"),
            [],
          );
        }
      },
    );

    await t.test(
      "Kubernetes rejects mismatched session documents before publishing repository material",
      async () => {
        const f = await fixture(mode);
        const binding = runtimeBinding();
        const document = JSON.parse(binding.files["client.json"]);
        document.sessionId = "another-session";
        binding.files["client.json"] = JSON.stringify(document);
        await assert.rejects(f.driver.prepareRevision(f.revision, f.context([binding])), {
          message: "Repository credential material is invalid.",
        });
        assert.equal(f.secrets().length, 0);
        assert.equal(f.deployments().length, 0);
      },
    );

    await t.test(
      "Kubernetes stop recovers material left by an interrupted multi-Secret create",
      async () => {
        const f = await fixture(mode);
        f.revision.repositoryCredentials.bindings.push({
          ...f.revision.repositoryCredentials.bindings[0],
          repositoryRef: "second-project",
        });
        const first = runtimeBinding();
        const second = {
          ...runtimeBinding("session_material_second"),
          repositoryRef: "second-project",
        };
        const create = f.clients.core.createNamespacedSecret;
        let creations = 0;
        f.clients.core.createNamespacedSecret = async (request) => {
          // The API accepts one material object before the next request loses service.
          // No Pod exists, so recovery must discover material independently of Pods.
          if (++creations === 2) {
            throw Object.assign(new Error("API unavailable"), { statusCode: 503 });
          }
          return create(request);
        };
        // The API error is replaced so a Secret body it may carry never reaches callers.
        await assert.rejects(f.driver.prepareRevision(f.revision, f.context([first, second])), {
          message: "Repository credential material could not be created.",
        });
        assert.equal(f.secrets().length, 1);
        assert.equal(f.deployments().length, 0);
        await f.driver.stopRevision(f.revision);
        assert.equal(f.secrets().length, 0);
        // A conflict whose Secret is gone by the follow-up read cannot confirm custody.
        f.clients.core.createNamespacedSecret = async () => {
          throw Object.assign(new Error("Secret already exists"), { statusCode: 409 });
        };
        await assert.rejects(f.driver.prepareRevision(f.revision, f.context([first, second])), {
          message: "Repository credential material creation could not be confirmed.",
        });
        assert.equal(f.secrets().length, 0);
        assert.equal(f.deployments().length, 0);
      },
    );

    await t.test(
      "Kubernetes stop keeps material until the exact revision Pods disappear",
      async () => {
        const f = await fixture(mode);
        await f.driver.prepareRevision(f.revision, f.context([runtimeBinding()]));
        const deployment = f.consumer();
        f.setPods([
          {
            apiVersion: "v1",
            kind: "Pod",
            metadata: {
              ...deployment.spec.template.metadata,
              name: "terminating-gateway",
              namespace: f.namespace,
              deletionTimestamp: "2026-09-18T00:00:00.000Z",
            },
            spec: deployment.spec.template.spec,
          },
        ]);
        let observed = 0;
        f.observePods(() => {
          assert.equal(
            f.secrets().length,
            1,
            "material must survive every termination observation",
          );
          if (++observed === 2) {
            f.setPods([]);
          }
        });
        await f.driver.stopRevision(f.revision);
        assert.ok(observed >= 2);
        assert.equal(f.secrets().length, 0);
      },
    );

    await t.test(
      "Kubernetes activation rotates same-revision material while retaining the old Pod's Secret",
      async () => {
        const f = await fixture(mode);
        const original = runtimeBinding();
        await f.driver.prepareRevision(f.revision, f.context([original]));
        f.markReady();
        await f.driver.activateRevision(f.revision, f.context([original]));
        const oldSecret = f.secrets()[0].metadata.name;
        const deployment = f.consumer();
        f.setPods([
          {
            apiVersion: "v1",
            kind: "Pod",
            metadata: {
              ...deployment.spec.template.metadata,
              name: "old-session-gateway",
              namespace: f.namespace,
            },
            spec: deployment.spec.template.spec,
          },
        ]);

        // Session rotation keeps the revision ID; deleting by revision label alone
        // would revoke a Secret still mounted by the terminating predecessor.
        const replacement = runtimeBinding("session_material_rotated");
        await assert.rejects(
          f.driver.activateRevision(f.revision, f.context([replacement])),
          /not ready/,
        );
        assert.notDeepEqual(f.consumer().spec.template, deployment.spec.template);
        assert.equal(JSON.stringify(f.consumer().spec.template).includes(oldSecret), false);
        assert.equal(f.secrets().length, 2);
        assert.ok(f.secrets().some((secret) => secret.metadata.name === oldSecret));
        f.setPods([]);
        f.markReady();
        await f.driver.activateRevision(f.revision, f.context([replacement]));
        assert.equal(f.secrets().length, 1);
        assert.notEqual(f.secrets()[0].metadata.name, oldSecret);
        assert.equal(JSON.stringify(f.consumer().spec.template).includes(oldSecret), false);
      },
    );

    await t.test(
      "repository material readiness waits for the replacement Pod when the old Pod is still ready",
      async () => {
        const f = await fixture(mode);
        const original = runtimeBinding();
        await f.driver.prepareRevision(f.revision, f.context([original]));
        f.markReady();
        await f.driver.activateRevision(f.revision, f.context([original]));
        const oldPod = workloadPod(f.consumer(), f.namespace, "old-material-ready");
        const replacement = runtimeBinding("session_material_replacement");
        await f.driver.prepareRevision(f.revision, f.context([replacement]));

        // Deployment status can acknowledge the new template while its ready replica
        // still belongs to the old material generation. Observe both Pods separately.
        const deployment = f.consumer();
        deployment.status = {
          observedGeneration: deployment.metadata.generation,
          replicas: 1,
          updatedReplicas: 1,
          readyReplicas: 1,
        };
        f.save(deployment);
        const replacementPod = workloadPod(deployment, f.namespace, "replacement-starting", false);
        f.setPods([oldPod, replacementPod]);
        const waiting = await f.driver.prepareRevision(f.revision, f.context([replacement]));
        assert.equal(waiting.ready, false);
        await assert.rejects(f.driver.activateRevision(f.revision, f.context([replacement])), {
          name: "DependencyUnavailableError",
          message: "The exact repository credential runtime generation is not ready.",
        });

        replacementPod.status.conditions = [{ type: "Ready", status: "True" }];
        f.setPods([replacementPod]);
        const ready = await f.driver.prepareRevision(f.revision, f.context([replacement]));
        assert.equal(ready.ready, true);
        await f.driver.activateRevision(f.revision, f.context([replacement]));
      },
    );

    await t.test(
      "Kubernetes retirement finds material after its Deployment was already removed",
      async () => {
        const f = await fixture(mode);
        await f.driver.prepareRevision(f.revision, f.context([runtimeBinding()]));
        const deployment = f.consumer();
        f.objects.delete(`Deployment:${deployment.metadata.namespace}:${deployment.metadata.name}`);
        f.setPods([
          {
            apiVersion: "v1",
            kind: "Pod",
            metadata: {
              ...deployment.spec.template.metadata,
              name: "orphaned-old-gateway",
              namespace: f.namespace,
            },
            spec: deployment.spec.template.spec,
          },
        ]);
        let observations = 0;
        f.observePods(() => {
          assert.equal(f.secrets().length, 1);
          if (++observations === 2) {
            f.setPods([]);
          }
        });
        await f.driver.retireRevision(f.revision);
        assert.ok(observations >= 2);
        assert.equal(f.secrets().length, 0);
      },
    );

    await t.test(
      "external namespace cleanup removes owned repository material and preserves unrelated Secrets",
      async () => {
        const f = await fixture(mode);
        await f.driver.prepareRevision(f.revision, f.context([runtimeBinding()]));
        const tenant = f.objects.get(`Namespace::${f.namespace}`);
        tenant.metadata.annotations["openclaw.dev/namespace-lifecycle"] = "external";
        f.save(tenant);
        for (const deployment of f.deployments()) {
          f.objects.delete(
            `Deployment:${deployment.metadata.namespace}:${deployment.metadata.name}`,
          );
        }
        f.save({
          apiVersion: "v1",
          kind: "Secret",
          metadata: { name: "external-owner", namespace: f.namespace, uid: "external-owner-uid" },
          data: { value: "cHJlc2VydmU=" },
        });
        const result = await f.driver.deleteNamespace({
          id: f.revision.namespaceId,
          name: "External material tenant",
          status: "deleting",
          existingNamespace: f.namespace,
          createdAt: f.revision.createdAt,
        });
        assert.equal(result.namespaceDeleted, true, JSON.stringify(result));
        assert.deepEqual(
          f.secrets().map((secret) => secret.metadata.name),
          ["external-owner"],
        );
        assert.ok(f.objects.has(`Namespace::${f.namespace}`));
      },
    );
  });
}
