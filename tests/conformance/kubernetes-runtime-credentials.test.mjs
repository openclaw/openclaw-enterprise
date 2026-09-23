import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { AGENT_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
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
      gatewayTrustedProxyCidrs: ["127.0.0.1/32"],
      gatewayClients: [
        { namespace: "openclaw-controller", podLabels: { "app.kubernetes.io/name": "controller" } },
      ],
    },
    servicePrincipalCredentials: { mode: "disabled" },
    runtime: {
      transportSecretPrefix: "transport",
      gatewayStorageClassName: "local-path",
      channels: { proxyUrl: "http://10.42.0.15:3128" },
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

function credentialFixture({
  secrets = {},
  deployments = [],
  claims = {},
  runtime = true,
  namespaceReadStatus = 200,
} = {}) {
  const driver = createKubernetesComputeDriver(options(runtime ? {} : { runtime: undefined }));
  const namespaceName = kubernetesNamespaceName(namespace.id);
  const namespaceObject = {
    ...driver.manifest("v1", "Namespace", namespaceName, { namespaceId: namespace.id }),
    status: { phase: "Active" },
  };
  const calls = [];
  const created = [];
  const deleted = [];
  const core = {
    async listNamespace(request) {
      calls.push({ kind: "listNamespace", request: structuredClone(request) });
      assert.equal(request.labelSelector, `openclaw.dev/namespace=${namespace.id}`);
      return { items: namespaceReadStatus === 404 ? [] : [structuredClone(namespaceObject)] };
    },
    async readNamespace(request) {
      calls.push({ kind: "readNamespace", request: structuredClone(request) });
      assert.equal(request.name, namespaceName);
      if (namespaceReadStatus !== 200) {
        throw httpError(namespaceReadStatus);
      }
      return structuredClone(namespaceObject);
    },
    async readNamespacedPersistentVolumeClaim(request) {
      calls.push({ kind: "readClaim", name: request.name });
      assert.equal(request.namespace, namespaceName);
      const claim = claims[request.name];
      if (claim === undefined) {
        throw httpError(404);
      }
      return structuredClone(claim);
    },
    async deleteNamespacedPersistentVolumeClaim(request) {
      const claim = claims[request.name];
      assert.equal(request.namespace, namespaceName);
      assert.equal(request.body?.preconditions?.uid, claim.metadata.uid);
      calls.push({ kind: "deleteClaim", name: request.name });
      delete claims[request.name];
      return {};
    },
    async readNamespacedSecret(request) {
      calls.push({ kind: "readSecret", name: request.name });
      assert.equal(request.namespace, namespaceName);
      const secret = secrets[request.name];
      if (secret === undefined) {
        throw httpError(404);
      }
      return structuredClone(secret);
    },
    async createNamespacedSecret(request) {
      calls.push({ kind: "createSecret", name: request.body.metadata.name });
      assert.equal(request.namespace, namespaceName);
      created.push(structuredClone(request.body));
      return structuredClone(request.body);
    },
    async deleteNamespacedSecret(request) {
      calls.push({ kind: "deleteSecret", name: request.name });
      assert.equal(request.namespace, namespaceName);
      const secret = secrets[request.name];
      if (secret === undefined) {
        throw httpError(404);
      }
      if (secret.metadata.uid !== undefined) {
        assert.equal(request.body?.preconditions?.uid, secret.metadata.uid);
      }
      deleted.push(request.name);
      delete secrets[request.name];
      return {};
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
  return { driver, namespaceName, calls, created, deleted };
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
      "gateway-password": "gateway-password-value",
    }),
  };
  const fixture = credentialFixture({ secrets });

  assert.deepEqual(await fixture.driver.getAgentRuntimeCredentialStatus(binding()), {
    transportConfigured: true,
  });
});

test("mocked Kubernetes client deletes every owned Agent runtime credential Secret idempotently", async () => {
  const first = credentialFixture();
  const secrets = {
    [`transport-${digest(agent.id)}`]: runtimeSecret(
      first.driver,
      first.namespaceName,
      "transport",
      { incomplete: "deletion must not depend on credential contents" },
      {
        metadata: {
          ...runtimeSecret(first.driver, first.namespaceName, "transport", {}).metadata,
          uid: "transport-uid",
        },
      },
    ),
  };
  const fixture = credentialFixture({ secrets });

  await fixture.driver.deleteAgentRuntimeCredentials(binding());
  assert.deepEqual(fixture.deleted, [`transport-${digest(agent.id)}`]);

  // A retry after partial or complete teardown observes absence and converges.
  await fixture.driver.deleteAgentRuntimeCredentials(binding());
  assert.equal(fixture.deleted.length, 1);
});

for (const runtime of [true, false]) {
  test(`Agent deletion removes owned claims after transport loss with runtime ${runtime ? "configured" : "disabled"}`, async () => {
    const first = credentialFixture();
    const ownership = { namespaceId: namespace.id, agentId: agent.id };
    const owned = [
      first.driver.sharedWorkspaceClaim(agent.id, ownership, first.namespaceName),
      ...(runtime
        ? [first.driver.gatewayPrivateStateClaim(agent.id, ownership, first.namespaceName)]
        : []),
    ];
    const claims = Object.fromEntries(
      owned.map((claim) => {
        claim.metadata.uid = `${claim.metadata.name}-uid`;
        return [claim.metadata.name, claim];
      }),
    );
    const fixture = credentialFixture({ claims, runtime });

    // Recovery cannot depend on the transport Secret surviving earlier teardown.
    await fixture.driver.deleteAgentRuntimeCredentials(binding());
    assert.deepEqual(Object.keys(claims), []);
    assert.deepEqual(
      fixture.calls
        .filter(({ kind }) => kind === "deleteClaim")
        .map(({ name }) => name)
        .sort(),
      owned.map(({ metadata }) => metadata.name).sort(),
    );
    await fixture.driver.deleteAgentRuntimeCredentials(binding());
    assert.equal(fixture.calls.filter(({ kind }) => kind === "deleteClaim").length, owned.length);
  });
}

test("draft Agent cleanup tolerates absent compute Namespace without bypassing scope or backend denial", async () => {
  const absent = credentialFixture({ runtime: false, namespaceReadStatus: 404 });

  // A draft Agent can be deleted before Namespace provisioning creates any workload storage.
  await absent.driver.deleteAgentRuntimeCredentials(binding());
  assert.deepEqual(
    absent.calls.map(({ kind }) => kind),
    ["listNamespace", "readNamespace"],
  );

  const wrongBinding = credentialFixture({ runtime: false, namespaceReadStatus: 404 });
  await assert.rejects(
    wrongBinding.driver.deleteAgentRuntimeCredentials({
      namespace,
      agent: { ...agent, namespaceId: "another-namespace" },
    }),
    ResourceConflictError,
  );
  assert.deepEqual(wrongBinding.calls, []);

  const denied = credentialFixture({ runtime: false, namespaceReadStatus: 403 });
  await assert.rejects(
    denied.driver.deleteAgentRuntimeCredentials(binding()),
    /backend is not authorized/,
  );
  assert.deepEqual(
    denied.calls.map(({ kind }) => kind),
    ["listNamespace", "readNamespace"],
  );

  // Cleanup absence does not authorize credential operations against a missing Namespace.
  const credential = credentialFixture({ namespaceReadStatus: 404 });
  await assert.rejects(
    credential.driver.getAgentRuntimeCredentialStatus(binding()),
    /namespace is unavailable/,
  );
});

test("mocked Kubernetes client preflights the transport Secret before initial create", async () => {
  const { driver, calls, created } = credentialFixture();

  assert.deepEqual(await driver.provisionAgentRuntimeCredentials(binding(), {}), {
    transportConfigured: true,
  });

  const firstCreate = calls.findIndex(({ kind }) => kind === "createSecret");
  assert.ok(firstCreate > 0, "the fixture must observe credential Secret writes");
  assert.deepEqual(
    calls
      .slice(0, firstCreate)
      .filter(({ kind }) => kind === "readSecret")
      .map(({ name }) => name),
    [`transport-${digest(agent.id)}`],
  );
  assert.equal(
    calls.slice(0, firstCreate).some(({ kind }) => kind === "listDeployments"),
    true,
  );
  assert.deepEqual(
    created.map((secret) => secret.metadata.name),
    [`transport-${digest(agent.id)}`],
  );
  const transport = created[0].stringData;
  assert.match(transport["app-server-token"], /^[A-Za-z0-9_-]+$/);
  assert.match(transport["gateway-password"], /^[A-Za-z0-9_-]+$/);
  assert.notEqual(transport["app-server-token"], transport["gateway-password"]);
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
        "gateway-password": "gateway-password-value",
      },
    ),
  };
  const { driver, created } = credentialFixture({ secrets });

  assert.deepEqual(await driver.provisionAgentRuntimeCredentials(binding(), {}), {
    transportConfigured: true,
  });
  assert.equal(created.length, 0);
});

test("mocked Kubernetes client rejects transport Secrets with unexpected keys", async () => {
  const first = credentialFixture();
  const secrets = {
    [`transport-${digest(agent.id)}`]: runtimeSecret(
      first.driver,
      first.namespaceName,
      "transport",
      {
        "app-server-token": "app-server-token-value",
        unexpected: "unexpected-value",
        "gateway-password": "gateway-password-value",
      },
    ),
  };
  const { driver, created } = credentialFixture({ secrets });

  await assert.rejects(
    driver.provisionAgentRuntimeCredentials(binding(), {}),
    /runtime credential Secret is incomplete/,
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
      agents: { defaults: { model: "openai/gpt-5" } },
    },
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    harnessAuth: {
      method: "api_key",
      source: { kind: "secret", namespaceId: namespace.id, id: "secret-model" },
      secretDriverId: "kubernetes-secret",
    },
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
      driver.harnessAuthForRevision(
        revision,
        {
          secretEnvironment: [],
          harnessAuth: {
            ...revision.harnessAuth,
            backendRef: { namespaceName, name: "occ-secret-model", key: "value", uid: "model-uid" },
          },
        },
        namespaceName,
      ),
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
          "gateway-password": "gateway-password-value",
        },
        {
          data: {
            "app-server-token": "",
            "gateway-password": encode("gateway-password-value"),
          },
        },
      ),
    ],
  ]) {
    const secrets = { [`${secret.metadata.name}`]: secret };
    const { driver, created } = credentialFixture({ secrets });

    await assert.rejects(
      driver.provisionAgentRuntimeCredentials(binding(), {}),
      ResourceConflictError,
      name,
    );
    assert.equal(created.length, 0, name);
  }
});

test("mocked Kubernetes client rejects retired model provisioning input without writes", async () => {
  const { driver, calls, created } = credentialFixture();

  for (const input of [
    { modelApiKey: "unsupported-model-key" },
    { slack: { appToken: "xapp-test", botToken: "xoxb-test" } },
  ]) {
    await assert.rejects(
      driver.provisionAgentRuntimeCredentials(binding(), input),
      DependencyUnavailableError,
    );
  }
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
    driver.provisionAgentRuntimeCredentials(binding(), {}),
    ResourceConflictError,
  );
  assert.equal(created.length, 0);
});

// Run the actual generated bootstrap in a fresh process. No provider login is
// attempted: malformed credential combinations must fail before launching Codex.
test("Codex startup rejects missing, blank, conflicting, and unsupported authentication inputs", () => {
  const cases = [
    {},
    { CODEX_LOGIN_MODE: "unknown" },
    { CODEX_LOGIN_MODE: "codex_pat" },
    { CODEX_LOGIN_MODE: "codex_pat", CODEX_ACCESS_TOKEN: "not-a-pat" },
    {
      CODEX_LOGIN_MODE: "codex_pat",
      CODEX_ACCESS_TOKEN: "at-fixture",
      CODEX_CHATGPT_WORKSPACE_ID: "caller-account",
    },
    {
      CODEX_LOGIN_MODE: "codex_pat",
      CODEX_ACCESS_TOKEN: "at-fixture",
      OPENAI_API_KEY: "other-key",
    },
    { CODEX_LOGIN_MODE: "api_key" },
    { CODEX_LOGIN_MODE: "api_key", OPENAI_API_KEY: " " },
    {
      CODEX_LOGIN_MODE: "api_key",
      OPENAI_API_KEY: "fixture-key",
      CODEX_ACCESS_TOKEN: "fixture-token",
    },
    {
      CODEX_LOGIN_MODE: "api_key",
      OPENAI_API_KEY: "fixture-key",
      CODEX_CHATGPT_WORKSPACE_ID: "workspace",
    },
    { CODEX_LOGIN_MODE: "chatgpt_service_account", CODEX_ACCESS_TOKEN: "fixture-token" },
    {
      CODEX_LOGIN_MODE: "chatgpt_service_account",
      CODEX_ACCESS_TOKEN: " ",
      CODEX_CHATGPT_WORKSPACE_ID: "workspace",
    },
    {
      CODEX_LOGIN_MODE: "chatgpt_service_account",
      CODEX_ACCESS_TOKEN: "fixture-token",
      CODEX_CHATGPT_WORKSPACE_ID: " ",
    },
    {
      CODEX_LOGIN_MODE: "chatgpt_service_account",
      CODEX_ACCESS_TOKEN: "fixture-token",
      CODEX_CHATGPT_WORKSPACE_ID: "workspace",
      OPENAI_API_KEY: "fixture-key",
    },
  ];
  for (const env of cases) {
    const child = spawnSync(process.execPath, ["-e", AGENT_RUNTIME_ENTRYPOINT], {
      env,
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(child.status, 1);
    assert.match(
      child.stderr,
      /Codex (?:API-key authentication configuration|service account token authentication configuration|service-account authentication configuration|authentication mode) is (?:invalid|missing or unsupported)/,
    );
    assert.equal(child.stdout, "");
    assert.doesNotMatch(child.stderr, /fixture-key|fixture-token/);
  }
});
