import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createKubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { DependencyUnavailableError, ResourceConflictError } from "../../packages/occ/src/index.ts";

const kubeconfigPath = "/tmp/openclaw-enterprise-conformance/kubeconfig";
const contextName = "openclaw-enterprise-local";
const namespace = Object.freeze({
  id: "ns_runtime_00000000-0000-4000-8000-000000000001",
  name: "Runtime credential tenant",
  status: "ready",
  createdAt: "2026-09-08T00:00:00.000Z",
});
const agent = Object.freeze({
  id: "agt_runtime_00000000-0000-4000-8000-000000000001",
  namespaceId: namespace.id,
  name: "Runtime credential Agent",
  configurationId: "cfg_runtime_00000000-0000-4000-8000-000000000001",
  providerId: null,
  executionMode: "dedicated",
  servicePrincipalId: "sp_runtime_00000000-0000-4000-8000-000000000001",
  createdAt: namespace.createdAt,
});

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
      gatewayClients: [
        { namespace: "openclaw-controller", podLabels: { "app.kubernetes.io/name": "controller" } },
      ],
    },
    servicePrincipalCredentials: { mode: "disabled" },
    runtime: {
      transportSecretPrefix: "transport",
      gatewayStorageClassName: "local-path",
      modelSecretPrefix: "model",
      channels: { secretPrefix: "channel", proxyUrl: "http://10.42.0.15:3128" },
    },
    ...overrides,
  };
}

function digest(value, length = 12) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function encode(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

function httpError(statusCode) {
  return Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });
}

function binding() {
  return { namespace, agent };
}

function credentialFixture({ secrets = {}, deployments = [] } = {}) {
  const driver = createKubernetesComputeDriver(options());
  const namespaceName = kubernetesNamespaceName(namespace.id);
  const namespaceObject = {
    ...driver.manifest("v1", "Namespace", namespaceName, { namespaceId: namespace.id }),
    status: { phase: "Active" },
  };
  const calls = [];
  const created = [];
  const core = {
    async listNamespace(request) {
      calls.push({ kind: "listNamespace", request: structuredClone(request) });
      assert.equal(request.labelSelector, `openclaw.dev/namespace=${namespace.id}`);
      return { items: [structuredClone(namespaceObject)] };
    },
    async readNamespace(request) {
      calls.push({ kind: "readNamespace", request: structuredClone(request) });
      assert.equal(request.name, namespaceName);
      return structuredClone(namespaceObject);
    },
    async readNamespacedSecret(request) {
      calls.push({ kind: "readSecret", name: request.name });
      assert.equal(request.namespace, namespaceName);
      const secret = secrets[request.name];
      if (secret === undefined) throw httpError(404);
      return structuredClone(secret);
    },
    async createNamespacedSecret(request) {
      calls.push({ kind: "createSecret", name: request.body.metadata.name });
      assert.equal(request.namespace, namespaceName);
      created.push(structuredClone(request.body));
      return structuredClone(request.body);
    },
  };
  const apps = {
    async listNamespacedDeployment(request) {
      calls.push({ kind: "listDeployments", request: structuredClone(request) });
      assert.equal(request.namespace, namespaceName);
      assert.equal(
        request.labelSelector,
        `openclaw.dev/namespace=${namespace.id},openclaw.dev/agent=${agent.id}`,
      );
      return { items: deployments.map((deployment) => structuredClone(deployment)) };
    },
  };
  driver.apiClients = Promise.resolve({ core, apps });
  return { driver, namespaceName, calls, created };
}

function runtimeSecret(driver, namespaceName, prefix, data, overrides = {}) {
  return {
    ...driver.manifest(
      "v1",
      "Secret",
      `${prefix}-${digest(agent.id)}`,
      {
        namespaceId: namespace.id,
        agentId: agent.id,
      },
      namespaceName,
    ),
    type: "Opaque",
    data: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, encode(value)])),
    ...overrides,
  };
}

test("mocked Kubernetes client reports only complete owned Agent runtime credential Secrets", async () => {
  const { driver, namespaceName } = credentialFixture();
  const secrets = {
    [`transport-${digest(agent.id)}`]: runtimeSecret(driver, namespaceName, "transport", {
      "app-server-token": "app-server-token-value",
      "gateway-token": "gateway-token-value",
      "gateway-password": "gateway-password-value",
    }),
    [`model-${digest(agent.id)}`]: runtimeSecret(driver, namespaceName, "model", {
      OPENAI_API_KEY: "model-key",
    }),
  };
  const fixture = credentialFixture({ secrets });

  assert.deepEqual(await fixture.driver.getAgentRuntimeCredentialStatus(binding()), {
    transportConfigured: true,
    modelConfigured: true,
    slackConfigured: false,
  });
});

test("mocked Kubernetes client preflights all credential Secrets before initial creates", async () => {
  const { driver, calls, created } = credentialFixture();

  assert.deepEqual(
    await driver.provisionAgentRuntimeCredentials(binding(), {
      modelApiKey: "model-key",
      slack: { appToken: "xapp-test", botToken: "xoxb-test" },
    }),
    { transportConfigured: true, modelConfigured: true, slackConfigured: true },
  );

  const firstCreate = calls.findIndex(({ kind }) => kind === "createSecret");
  assert.ok(firstCreate > 0, "the fixture must observe credential Secret writes");
  assert.deepEqual(
    calls
      .slice(0, firstCreate)
      .filter(({ kind }) => kind === "readSecret")
      .map(({ name }) => name),
    [`transport-${digest(agent.id)}`, `model-${digest(agent.id)}`, `channel-${digest(agent.id)}`],
  );
  assert.equal(
    calls.slice(0, firstCreate).some(({ kind }) => kind === "listDeployments"),
    true,
  );
  assert.deepEqual(
    created.map((secret) => secret.metadata.name),
    [`transport-${digest(agent.id)}`, `model-${digest(agent.id)}`, `channel-${digest(agent.id)}`],
  );
  const transport = created[0].stringData;
  assert.match(transport["app-server-token"], /^[A-Za-z0-9_-]+$/);
  assert.match(transport["gateway-token"], /^[A-Za-z0-9_-]+$/);
  assert.match(transport["gateway-password"], /^[A-Za-z0-9_-]+$/);
  assert.notEqual(transport["app-server-token"], transport["gateway-token"]);
  assert.notEqual(transport["app-server-token"], transport["gateway-password"]);
  assert.notEqual(transport["gateway-token"], transport["gateway-password"]);
  assert.deepEqual(created[1].stringData, { OPENAI_API_KEY: "model-key" });
  assert.deepEqual(created[2].stringData, {
    SLACK_APP_TOKEN: "xapp-test",
    SLACK_BOT_TOKEN: "xoxb-test",
  });
});

test("mocked Kubernetes client completes missing credential groups without replacing existing Secrets", async () => {
  const first = credentialFixture();
  const secrets = {
    [`transport-${digest(agent.id)}`]: runtimeSecret(
      first.driver,
      first.namespaceName,
      "transport",
      {
        "app-server-token": "app-server-token-value",
        "gateway-token": "gateway-token-value",
        "gateway-password": "gateway-password-value",
      },
    ),
  };
  const { driver, created } = credentialFixture({ secrets });

  assert.deepEqual(
    await driver.provisionAgentRuntimeCredentials(binding(), {
      modelApiKey: "model-key",
      slack: { appToken: "xapp-test", botToken: "xoxb-test" },
    }),
    { transportConfigured: true, modelConfigured: true, slackConfigured: true },
  );
  assert.deepEqual(
    created.map((secret) => secret.metadata.name),
    [`model-${digest(agent.id)}`, `channel-${digest(agent.id)}`],
  );
});

test("mocked Kubernetes client can recover missing transport when model credentials already exist", async () => {
  const first = credentialFixture();
  const secrets = {
    [`model-${digest(agent.id)}`]: runtimeSecret(first.driver, first.namespaceName, "model", {
      OPENAI_API_KEY: "model-key",
    }),
  };
  const { driver, created } = credentialFixture({ secrets });

  assert.deepEqual(await driver.provisionAgentRuntimeCredentials(binding(), {}), {
    transportConfigured: true,
    modelConfigured: true,
    slackConfigured: false,
  });
  assert.deepEqual(
    created.map((secret) => secret.metadata.name),
    [`transport-${digest(agent.id)}`],
  );
});

test("mocked Kubernetes client returns configured metadata without writes for existing credentials", async () => {
  const first = credentialFixture();
  const secrets = {
    [`transport-${digest(agent.id)}`]: runtimeSecret(
      first.driver,
      first.namespaceName,
      "transport",
      {
        "app-server-token": "app-server-token-value",
        "gateway-token": "gateway-token-value",
        "gateway-password": "gateway-password-value",
      },
    ),
    [`model-${digest(agent.id)}`]: runtimeSecret(first.driver, first.namespaceName, "model", {
      OPENAI_API_KEY: "model-key",
    }),
    [`channel-${digest(agent.id)}`]: runtimeSecret(first.driver, first.namespaceName, "channel", {
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
    }),
  };
  const { driver, created } = credentialFixture({ secrets });

  assert.deepEqual(await driver.provisionAgentRuntimeCredentials(binding(), {}), {
    transportConfigured: true,
    modelConfigured: true,
    slackConfigured: true,
  });
  assert.equal(created.length, 0);
});

test("mocked Kubernetes client treats legacy two-token transport Secrets as conflicts", async () => {
  const first = credentialFixture();
  const secrets = {
    [`transport-${digest(agent.id)}`]: runtimeSecret(
      first.driver,
      first.namespaceName,
      "transport",
      {
        "app-server-token": "app-server-token-value",
        "gateway-token": "gateway-token-value",
      },
    ),
    [`model-${digest(agent.id)}`]: runtimeSecret(first.driver, first.namespaceName, "model", {
      OPENAI_API_KEY: "model-key",
    }),
  };
  const { driver, created } = credentialFixture({ secrets });

  await assert.rejects(
    driver.provisionAgentRuntimeCredentials(binding(), {}),
    ResourceConflictError,
  );
  assert.equal(created.length, 0);
});

test("gateway password env references project only from the Agent transport Secret", () => {
  const { driver, namespaceName } = credentialFixture();
  const agentId = "agent-password-projection";
  const suffix = digest(agentId);
  const revision = {
    id: "revision-password-projection",
    namespaceId: namespace.id,
    agentId,
    revision: 1,
    configurationId: "cfg_runtime_password_projection",
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration: {
      logging: { level: "info", consoleLevel: "info", consoleStyle: "json" },
      diagnostics: { otel: { logs: false } },
    },
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId: "service-principal-password-projection",
    createdAt: namespace.createdAt,
  };
  const gatewayEnvironment = (configuration) => {
    const configured = {
      ...revision,
      configuration: { ...revision.configuration, ...configuration },
    };
    const snapshot = driver.gatewayConfiguration(configured);
    const gateway = driver.deployment(
      `gateway-${suffix}`,
      { namespaceId: namespace.id, agentId },
      namespaceName,
      "openclaw-enterprise/gateway-fixture:local",
      `agent-${suffix}`,
      "gateway",
      {},
      snapshot.loggingLevel,
      snapshot,
      true,
      revision.servicePrincipalId,
    );
    return Object.fromEntries(
      gateway.spec.template.spec.containers[0].env.map((entry) => [entry.name, entry]),
    );
  };

  assert.equal(gatewayEnvironment({}).OPENCLAW_GATEWAY_PASSWORD, undefined);
  assert.deepEqual(
    gatewayEnvironment({
      gateway: {
        auth: { password: { source: "env", id: "OPENCLAW_GATEWAY_PASSWORD" } },
      },
    }).OPENCLAW_GATEWAY_PASSWORD.valueFrom.secretKeyRef,
    { name: `transport-${suffix}`, key: "gateway-password" },
  );
  assert.throws(
    () =>
      driver.gatewayConfiguration({
        ...revision,
        configuration: {
          ...revision.configuration,
          gateway: { auth: { password: "static-password" } },
        },
      }),
    /OPENCLAW_GATEWAY_PASSWORD/i,
  );
});

test("mocked Kubernetes client rejects existing credential conflicts before writes", async () => {
  const first = credentialFixture();
  const secrets = {
    [`model-${digest(agent.id)}`]: runtimeSecret(first.driver, first.namespaceName, "model", {
      OPENAI_API_KEY: "different-model-key",
    }),
  };
  const { driver, created } = credentialFixture({ secrets });

  await assert.rejects(
    driver.provisionAgentRuntimeCredentials(binding(), { modelApiKey: "model-key" }),
    ResourceConflictError,
  );
  assert.equal(created.length, 0);
});

test("mocked Kubernetes client rejects malformed existing credential Secrets before writes", async () => {
  const first = credentialFixture();
  for (const [name, secret] of [
    [
      "missing transport key",
      runtimeSecret(first.driver, first.namespaceName, "transport", {
        "app-server-token": "app-server-token-value",
      }),
    ],
    [
      "empty decoded credential",
      runtimeSecret(
        first.driver,
        first.namespaceName,
        "transport",
        {
          "app-server-token": "app-server-token-value",
          "gateway-token": "gateway-token-value",
          "gateway-password": "gateway-password-value",
        },
        {
          data: {
            "app-server-token": "",
            "gateway-token": encode("gateway-token-value"),
            "gateway-password": encode("gateway-password-value"),
          },
        },
      ),
    ],
    [
      "noncanonical base64 credential",
      runtimeSecret(
        first.driver,
        first.namespaceName,
        "model",
        { OPENAI_API_KEY: "model-key" },
        { data: { OPENAI_API_KEY: "Zg" } },
      ),
    ],
    [
      "oversized decoded credential",
      runtimeSecret(
        first.driver,
        first.namespaceName,
        "model",
        { OPENAI_API_KEY: "model-key" },
        { data: { OPENAI_API_KEY: Buffer.alloc(65_537, 65).toString("base64") } },
      ),
    ],
  ]) {
    const secrets = { [`${secret.metadata.name}`]: secret };
    const { driver, created } = credentialFixture({ secrets });

    await assert.rejects(
      driver.provisionAgentRuntimeCredentials(binding(), { modelApiKey: "model-key" }),
      ResourceConflictError,
      name,
    );
    assert.equal(created.length, 0, name);
  }
});

test("mocked Kubernetes client requires a model credential when the model Secret is missing", async () => {
  const { driver, calls, created } = credentialFixture();

  await assert.rejects(
    driver.provisionAgentRuntimeCredentials(binding(), {}),
    DependencyUnavailableError,
  );
  assert.equal(
    calls.some(({ kind }) => kind === "listDeployments"),
    false,
  );
  assert.equal(created.length, 0);
});

test("mocked Kubernetes client refuses initial provisioning after Agent deployments exist", async () => {
  const first = credentialFixture();
  const deployment = {
    ...first.driver.manifest(
      "apps/v1",
      "Deployment",
      `gateway-${digest(agent.id)}`,
      {
        namespaceId: namespace.id,
        agentId: agent.id,
      },
      first.namespaceName,
    ),
    spec: { replicas: 1 },
  };
  const { driver, created } = credentialFixture({ deployments: [deployment] });

  await assert.rejects(
    driver.provisionAgentRuntimeCredentials(binding(), { modelApiKey: "model-key" }),
    ResourceConflictError,
  );
  assert.equal(created.length, 0);
});
