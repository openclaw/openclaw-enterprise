import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { AGENT_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import {
  createKubernetesComputeDriver,
  kubernetesNamespaceName,
  kubernetesGatewayNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  DependencyUnavailableError,
  ResourceConflictError,
  RuntimeCredentialsForbiddenByClusterError,
} from "../../packages/occ/src/index.ts";
import { conformanceKubernetesOptions } from "../helpers/kubernetes-compute.mjs";

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
  backendId: null,
  executionMode: "dedicated",
  servicePrincipalId: "sp_runtime_00000000-0000-4000-8000-000000000001",
  createdAt: namespace.createdAt,
});

function options(overrides = {}) {
  return {
    ...conformanceKubernetesOptions({
      gatewayTrustedProxyCidrs: ["127.0.0.1/32"],
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
        channels: { proxyUrl: "http://10.42.0.15:3128" },
      },
    }),
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
  configMaps = {},
  runtime = true,
  namespaceReadStatus = 200,
  twoCluster = false,
  secretReadStatus = undefined,
  secretCreateStatus = undefined,
  deploymentListStatus = undefined,
} = {}) {
  const configured = options(runtime ? {} : { runtime: undefined });
  if (twoCluster) {
    delete configured.network.gatewayClients;
    configured.gatewayRouting = {
      hostname: "gateway.example.test",
      gatewayName: "gateway",
      gatewayNamespace: "system",
      envoyNamespace: "envoy",
    };
    configured.executionCluster = {
      authentication: { ...configured.authentication, context: "execution" },
      harnessRouting: { ...configured.gatewayRouting, hostname: "harness.example.test" },
      network: {
        dns: configured.network.dns,
        harnessEndpointCidrs: ["192.0.2.2/32"],
        gatewayEndpointCidrs: ["192.0.2.1/32"],
        pluginStatusProxySourceCidrs: ["192.0.2.2/32"],
      },
    };
  }
  const driver = createKubernetesComputeDriver(configured);
  const namespaceName = kubernetesNamespaceName(namespace.id);
  const namespaceObject = {
    ...driver.manifest("v1", "Namespace", namespaceName, { namespaceId: namespace.id }),
    status: { phase: "Active" },
  };
  const controlNamespace = twoCluster
    ? {
        ...driver.gatewayNamespaceManifest({ namespaceId: namespace.id }),
        status: { phase: "Active" },
      }
    : undefined;
  const calls = [];
  const created = [];
  const deleted = [];
  const locate = (resources, request) =>
    Object.entries(resources).find(
      ([, value]) =>
        value.metadata.name === request.name && value.metadata.namespace === request.namespace,
    );
  const core = {
    async listNamespace(request) {
      calls.push({ kind: "listNamespace", request: structuredClone(request) });
      const [label, owner] = request.labelSelector.split("=");
      return {
        items: [namespaceReadStatus === 404 ? undefined : namespaceObject, controlNamespace]
          .filter((value) => value?.metadata.labels?.[label] === owner)
          .map((value) => structuredClone(value)),
      };
    },
    async readNamespace(request) {
      calls.push({ kind: "readNamespace", request: structuredClone(request) });
      if (request.name === controlNamespace?.metadata.name) {
        return structuredClone(controlNamespace);
      }
      assert.equal(request.name, namespaceName);
      if (namespaceReadStatus !== 200) {
        throw httpError(namespaceReadStatus);
      }
      return structuredClone(namespaceObject);
    },
    async readNamespacedPersistentVolumeClaim(request) {
      calls.push({ kind: "readClaim", name: request.name });
      const claim = locate(claims, request)?.[1];
      if (claim === undefined) {
        throw httpError(404);
      }
      return structuredClone(claim);
    },
    async deleteNamespacedPersistentVolumeClaim(request) {
      const [key, claim] = locate(claims, request);
      assert.equal(request.namespace, claim.metadata.namespace);
      assert.equal(request.body?.preconditions?.uid, claim.metadata.uid);
      calls.push({ kind: "deleteClaim", name: request.name });
      delete claims[key];
      return {};
    },
    async readNamespacedConfigMap(request) {
      calls.push({ kind: "readConfigMap", name: request.name });
      const configMap = locate(configMaps, request)?.[1];
      if (configMap === undefined) {
        throw httpError(404);
      }
      return structuredClone(configMap);
    },
    async deleteNamespacedConfigMap(request) {
      const [key, configMap] = locate(configMaps, request);
      assert.equal(request.body?.preconditions?.uid, configMap.metadata.uid);
      calls.push({ kind: "deleteConfigMap", name: request.name });
      delete configMaps[key];
      return {};
    },
    async readNamespacedSecret(request) {
      calls.push({ kind: "readSecret", name: request.name });
      if (secretReadStatus !== undefined) {
        throw httpError(secretReadStatus);
      }
      const secret = locate(secrets, request)?.[1];
      if (secret === undefined) {
        throw httpError(404);
      }
      return structuredClone(secret);
    },
    async createNamespacedSecret(request) {
      calls.push({ kind: "createSecret", name: request.body.metadata.name });
      if (secretCreateStatus !== undefined) {
        throw httpError(secretCreateStatus);
      }
      assert.equal(request.namespace, controlNamespace?.metadata.name ?? namespaceName);
      created.push(structuredClone(request.body));
      const observed = {
        ...request.body,
        metadata: { ...request.body.metadata, uid: `${request.body.metadata.name}-uid` },
        data:
          request.body.data ??
          Object.fromEntries(
            Object.entries(request.body.stringData ?? {}).map(([key, value]) => [
              key,
              encode(value),
            ]),
          ),
      };
      secrets[observed.metadata.name] = observed;
      return structuredClone(observed);
    },
    async deleteNamespacedSecret(request) {
      calls.push({ kind: "deleteSecret", name: request.name });
      const [key, secret] = locate(secrets, request) ?? [];
      if (secret === undefined) {
        throw httpError(404);
      }
      if (secret.metadata.uid !== undefined) {
        assert.equal(request.body?.preconditions?.uid, secret.metadata.uid);
      }
      deleted.push(request.name);
      delete secrets[key];
      return {};
    },
  };
  const apps = {
    async listNamespacedDeployment(request) {
      calls.push({ kind: "listDeployments", request: structuredClone(request) });
      if (deploymentListStatus !== undefined && request.namespace === namespaceName) {
        throw httpError(deploymentListStatus);
      }
      assert.ok([namespaceName, controlNamespace?.metadata.name].includes(request.namespace));
      assert.equal(
        request.labelSelector,
        `openclaw.dev/namespace=${namespace.id},openclaw.dev/agent=${agent.id}`,
      );
      return {
        items: deployments
          .filter((deployment) => deployment.metadata.namespace === request.namespace)
          .map((deployment) => structuredClone(deployment)),
      };
    },
  };
  driver.apiClients = Promise.resolve({ core, apps });
  driver.executionApiClients = driver.apiClients;
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
      { name: kubernetesNamespaceName(namespace.id), plane: "control" },
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
    }),
    [`gateway-password-${digest(agent.id)}`]: runtimeSecret(
      driver,
      namespaceName,
      "gateway-password",
      { "gateway-password": "gateway-password-value" },
    ),
  };
  const fixture = credentialFixture({ secrets });

  assert.deepEqual(await fixture.driver.getAgentRuntimeCredentialStatus(binding()), {
    transportConfigured: true,
  });
});

for (const executionMode of ["dedicated", "embedded"]) {
  test(`runtime credentials remain valid across ${executionMode} mode changes`, async () => {
    const fixture = credentialFixture();
    const initial = { namespace, agent: { ...agent, executionMode } };
    await fixture.driver.provisionAgentRuntimeCredentials(initial, {});
    assert.deepEqual(
      await fixture.driver.getAgentRuntimeCredentialStatus({
        namespace,
        agent: {
          ...agent,
          executionMode: executionMode === "dedicated" ? "embedded" : "dedicated",
        },
      }),
      { transportConfigured: true },
      "changing execution mode must preserve the Agent's provisioned credentials",
    );
  });
}

test("legacy combined credentials remain usable without removing the serving Gateway source", async () => {
  const first = credentialFixture();
  const name = `transport-${digest(agent.id)}`;
  const legacy = runtimeSecret(
    first.driver,
    first.namespaceName,
    "transport",
    {
      "app-server-token": "legacy-transport",
      "gateway-password": "legacy-password",
    },
    {
      metadata: {
        ...runtimeSecret(first.driver, first.namespaceName, "transport", {}).metadata,
        uid: "legacy-uid",
      },
    },
  );
  const secrets = { [name]: legacy };
  const fixture = credentialFixture({ secrets });
  for (const executionMode of ["embedded", "dedicated"]) {
    assert.deepEqual(
      await fixture.driver.getAgentRuntimeCredentialStatus({
        namespace,
        agent: { ...agent, executionMode },
      }),
      { transportConfigured: true },
    );
  }
  const before = structuredClone(legacy);
  await fixture.driver.ensureLegacyGatewayPassword(
    { namespaceId: namespace.id, agentId: agent.id },
    {
      name: fixture.namespaceName,
      plane: "control",
    },
  );
  const password = secrets[`gateway-password-${digest(agent.id)}`];
  assert.deepEqual(password.data, { "gateway-password": legacy.data["gateway-password"] });
  assert.deepEqual(secrets[name], before, "an older Gateway may still reference its legacy Secret");
  await fixture.driver.ensureLegacyGatewayPassword(
    { namespaceId: namespace.id, agentId: agent.id },
    {
      name: fixture.namespaceName,
      plane: "control",
    },
  );
  assert.equal(fixture.created.length, 1, "compatibility delivery must be idempotent");
  password.data["gateway-password"] = encode("conflicting-password");
  await assert.rejects(
    fixture.driver.getAgentRuntimeCredentialStatus(binding()),
    ResourceConflictError,
  );
});

test("concurrent legacy password delivery accepts only an identical owned source", async () => {
  for (const outcome of ["identical", "different", "foreign", "disappeared", "unavailable"]) {
    const initial = credentialFixture();
    const name = `transport-${digest(agent.id)}`;
    const secrets = {
      [name]: runtimeSecret(initial.driver, initial.namespaceName, "transport", {
        "app-server-token": "legacy-transport",
        "gateway-password": "legacy-password",
      }),
    };
    const fixture = credentialFixture({ secrets });
    const { core } = await fixture.driver.apiClients;
    const create = core.createNamespacedSecret.bind(core);
    core.createNamespacedSecret = async (request) => {
      if (outcome === "unavailable") {
        throw httpError(503);
      }
      if (outcome !== "disappeared") {
        const competitor = structuredClone(request);
        if (outcome === "different") {
          competitor.body.data["gateway-password"] = encode("another-password");
        }
        if (outcome === "foreign") {
          competitor.body.metadata.labels["openclaw.dev/agent"] = "another-agent";
          competitor.body.metadata.annotations["openclaw.dev/agent-id"] = "another-agent";
        }
        await create(competitor);
      }
      throw httpError(409);
    };
    const original = structuredClone(secrets[name]);
    const delivery = () =>
      fixture.driver.ensureLegacyGatewayPassword(
        { namespaceId: namespace.id, agentId: agent.id },
        { name: fixture.namespaceName, plane: "control" },
      );
    if (outcome === "identical") {
      await delivery();
      assert.deepEqual(secrets[`gateway-password-${digest(agent.id)}`].data, {
        "gateway-password": original.data["gateway-password"],
      });
    } else {
      await assert.rejects(delivery());
    }
    assert.deepEqual(secrets[name], original, `${outcome}: preserve the serving Gateway source`);
  }
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

test("Agent deletion removes the Gateway workspace node binding", async () => {
  const first = credentialFixture();
  const name = `gateway-${digest(agent.id)}-workspace-node`;
  const nodeBinding = {
    ...first.driver.manifest(
      "v1",
      "ConfigMap",
      name,
      { namespaceId: namespace.id, agentId: agent.id },
      { name: kubernetesNamespaceName(namespace.id), plane: "control" },
    ),
    data: { "workspace-node.json": JSON.stringify({ revisionId: "revision-1", deviceId: "node" }) },
  };
  nodeBinding.metadata.uid = "binding-uid";
  const configMaps = { [name]: nodeBinding };
  const fixture = credentialFixture({ configMaps });
  await fixture.driver.deleteAgentRuntimeCredentials(binding());
  assert.deepEqual(configMaps, {});
  assert.deepEqual(
    fixture.calls.filter(({ kind }) => kind === "deleteConfigMap").map(({ name }) => name),
    [name],
  );
  // A retry observes absence and converges.
  await fixture.driver.deleteAgentRuntimeCredentials(binding());
});

for (const runtime of [true, false]) {
  test(`Agent deletion removes owned claims after transport loss with runtime ${runtime ? "configured" : "disabled"}`, async () => {
    const first = credentialFixture();
    const ownership = { namespaceId: namespace.id, agentId: agent.id };
    const owned = [
      first.driver.harnessWorkspaceClaim(agent.id, ownership, {
        name: first.namespaceName,
        plane: "execution",
      }),
      ...(runtime
        ? [
            first.driver.gatewayPrivateStateClaim(agent.id, ownership, {
              name: kubernetesNamespaceName(namespace.id),
              plane: "control",
            }),
          ]
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

test("a cluster denial of runtime credential Secrets names the Kubernetes operation and namespace", async () => {
  // The data-plane tenant-api RoleBinding is missing: the API may not read the embedded
  // Agent's transport Secret, so operators need the operation, not a generic outage.
  for (const [executionMode, kubernetesNamespace, plane] of [
    ["embedded", kubernetesNamespaceName(namespace.id), "execution"],
    ["dedicated", kubernetesNamespaceName(namespace.id), "execution"],
  ]) {
    const { driver } = credentialFixture({ secretReadStatus: 403 });
    const denied = await driver
      .getAgentRuntimeCredentialStatus({ namespace, agent: { ...agent, executionMode } })
      .then(
        () => assert.fail("a denied Secret read must fail"),
        (error) => error,
      );
    assert.ok(denied instanceof RuntimeCredentialsForbiddenByClusterError, executionMode);
    // Callers that fail closed on dependency outages keep doing so.
    assert.ok(denied instanceof DependencyUnavailableError);
    assert.deepEqual(
      {
        verb: denied.verb,
        resource: denied.resource,
        kubernetesNamespace: denied.kubernetesNamespace,
        plane: denied.plane,
        status: denied.status,
      },
      { verb: "get", resource: "secrets", kubernetesNamespace, plane, status: 403 },
    );
  }

  const { driver, created } = credentialFixture({ secretCreateStatus: 403 });
  const denied = await driver.provisionAgentRuntimeCredentials(binding(), {}).then(
    () => assert.fail("a denied Secret create must fail"),
    (error) => error,
  );
  assert.ok(denied instanceof RuntimeCredentialsForbiddenByClusterError);
  assert.equal(denied.verb, "create");
  assert.equal(denied.resource, "secrets");
  assert.equal(denied.kubernetesNamespace, kubernetesNamespaceName(namespace.id));
  assert.equal(created.length, 0);

  // A dedicated Agent's preflight also lists Deployments in the data-plane namespace.
  const preflight = credentialFixture({ deploymentListStatus: 403 });
  const listDenied = await preflight.driver.provisionAgentRuntimeCredentials(binding(), {}).then(
    () => assert.fail("a denied Deployment list must fail"),
    (error) => error,
  );
  assert.ok(listDenied instanceof RuntimeCredentialsForbiddenByClusterError);
  assert.deepEqual(
    [listDenied.verb, listDenied.resource, listDenied.kubernetesNamespace, listDenied.plane],
    ["list", "deployments", kubernetesNamespaceName(namespace.id), "execution"],
  );
  assert.equal(preflight.created.length, 0);

  // Other failures, including a rejected API credential (401), keep the generic outage.
  for (const status of [400, 401]) {
    const unavailable = credentialFixture({ secretReadStatus: status });
    await assert.rejects(unavailable.driver.getAgentRuntimeCredentialStatus(binding()), (error) => {
      assert.ok(error instanceof DependencyUnavailableError, String(status));
      assert.equal(error instanceof RuntimeCredentialsForbiddenByClusterError, false);
      return true;
    });
  }
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
    [`transport-${digest(agent.id)}`, `gateway-password-${digest(agent.id)}`],
  );
  assert.equal(
    calls.slice(0, firstCreate).some(({ kind }) => kind === "listDeployments"),
    true,
  );
  assert.deepEqual(
    created.map((secret) => secret.metadata.name),
    [`transport-${digest(agent.id)}`, `gateway-password-${digest(agent.id)}`],
  );
  const transport = created[0].stringData;
  assert.match(transport["app-server-token"], /^[A-Za-z0-9_-]+$/);
  const password = created[1].stringData;
  assert.deepEqual(Object.keys(transport), ["app-server-token"]);
  assert.deepEqual(Object.keys(password), ["gateway-password"]);
  assert.match(password["gateway-password"], /^[A-Za-z0-9_-]+$/);
  assert.notEqual(transport["app-server-token"], password["gateway-password"]);
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
    [`transport-${digest(agent.id)}`, `gateway-password-${digest(agent.id)}`],
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
      },
    ),
    [`gateway-password-${digest(agent.id)}`]: runtimeSecret(
      first.driver,
      first.namespaceName,
      "gateway-password",
      { "gateway-password": "gateway-password-value" },
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

test("embedded Gateway uses the separate canonical password source", () => {
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
      { name: namespaceName, plane: "execution" },
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
        { name: namespaceName, plane: "execution" },
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
    { name: `gateway-password-${suffix}`, key: "gateway-password" },
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
    ["missing transport key", runtimeSecret(first.driver, first.namespaceName, "transport", {})],
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
      { name: first.namespaceName, plane: "execution" },
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
    { CODEX_LOGIN_MODE: "codex_pat", CODEX_ACCESS_TOKEN: " " },
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
  ];
  for (const env of cases) {
    const child = spawnSync(
      process.execPath,
      ["-e", ...nodeProgramArguments(AGENT_RUNTIME_ENTRYPOINT)],
      {
        env,
        encoding: "utf8",
        timeout: 5000,
      },
    );
    assert.equal(child.status, 1);
    assert.match(
      child.stderr,
      /Codex (?:API-key authentication configuration|service account token authentication configuration|authentication mode) is (?:invalid|missing or unsupported)/,
    );
    assert.equal(child.stdout, "");
    assert.doesNotMatch(child.stderr, /fixture-key|fixture-token/);
  }
});

test("credential provisioning cannot replace transport while a Gateway survives in the shared namespace", async () => {
  const initial = credentialFixture();
  const gateway = initial.driver.manifest(
    "apps/v1",
    "Deployment",
    "gateway-existing",
    { namespaceId: namespace.id, agentId: agent.id },
    { name: kubernetesNamespaceName(namespace.id), plane: "control" },
  );
  const fixture = credentialFixture({ deployments: [gateway] });
  await assert.rejects(
    fixture.driver.provisionAgentRuntimeCredentials(binding(), {}),
    /already been deployed/,
  );
  assert.equal(fixture.created.length, 0);
});

test("Agent deletion is idempotent after its shared namespace disappears", async () => {
  const fixture = credentialFixture({ namespaceReadStatus: 404 });
  await fixture.driver.deleteAgentRuntimeCredentials(binding());
  assert.equal(
    fixture.calls.some(({ kind }) => kind === "deleteClaim" || kind === "deleteSecret"),
    false,
  );
});

test("two-cluster Agent deletion removes Gateway state after the execution namespace disappears", async () => {
  const initial = credentialFixture({ twoCluster: true });
  const claim = initial.driver.gatewayPrivateStateClaim(
    agent.id,
    { namespaceId: namespace.id, agentId: agent.id },
    { name: kubernetesGatewayNamespaceName(namespace.id), plane: "control" },
  );
  claim.metadata.uid = "retained-gateway-claim";
  const claims = { [claim.metadata.name]: claim };
  const fixture = credentialFixture({ twoCluster: true, claims, namespaceReadStatus: 404 });
  await fixture.driver.deleteAgentRuntimeCredentials(binding());
  assert.deepEqual(Object.keys(claims), []);
});

for (const executionMode of ["embedded", "dedicated"]) {
  test(`Agent deletion cleans the shared target despite draft mode ${executionMode}`, async () => {
    const initial = credentialFixture();
    const ownership = { namespaceId: namespace.id, agentId: agent.id };
    const targets = [initial.namespaceName];
    const claims = {};
    const secrets = {};
    for (const target of targets) {
      const claim = initial.driver.gatewayPrivateStateClaim(agent.id, ownership, {
        name: target,
        plane: "execution",
      });
      claim.metadata.uid = `${target}-claim-uid`;
      claims[target] = claim;
      const secret = initial.driver.manifest(
        "v1",
        "Secret",
        `transport-${digest(agent.id)}`,
        ownership,
        { name: target, plane: "execution" },
      );
      secret.metadata.uid = `${target}-transport-uid`;
      secrets[target] = secret;
    }
    const fixture = credentialFixture({ claims, secrets });
    const current = { namespace, agent: { ...agent, executionMode } };
    await fixture.driver.deleteAgentRuntimeCredentials(current);
    assert.deepEqual(
      Object.keys(claims),
      [],
      "The private claim must be removed at Agent deletion",
    );
    assert.deepEqual(Object.keys(secrets), [], "The owned transport Secret must be removed");
    await fixture.driver.deleteAgentRuntimeCredentials(current);
    assert.equal(fixture.calls.filter(({ kind }) => kind === "deleteClaim").length, 1);
    assert.equal(fixture.deleted.length, 1);
  });
}
