import assert from "node:assert/strict";
import test from "node:test";

import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  DependencyUnavailableError,
  ResourceConflictError,
  RuntimeCredentialsForbiddenByClusterError,
} from "../../packages/occ/src/index.ts";
import {
  agent,
  binding,
  credentialFixture,
  digest,
  encode,
  executionModes,
  embeddedFirstModes,
  httpError,
  namespace,
  runtimeSecret,
  type StoredSecret,
} from "./kubernetes-runtime-credentials-fixture.ts";
import { registerGatewayPasswordProjection } from "./kubernetes-runtime-credentials-gateway-cases.ts";
import { registerCodexLauncher } from "./kubernetes-runtime-credentials-launcher-cases.ts";
import {
  registerEarlyTeardown,
  registerSharedAndTwoClusterTeardown,
} from "./kubernetes-runtime-credentials-teardown-cases.ts";

test("mocked Kubernetes client reports only complete owned Agent runtime credential Secrets", async () => {
  const { resources } = credentialFixture();
  const secrets = {
    [`transport-${digest(agent.id)}`]: runtimeSecret(resources, "transport", {
      "app-server-token": "app-server-token-value",
    }),
    [`gateway-password-${digest(agent.id)}`]: runtimeSecret(resources, "gateway-password", {
      "gateway-password": "gateway-password-value",
    }),
  };
  const fixture = credentialFixture({ secrets });

  assert.deepEqual(await fixture.driver.getAgentRuntimeCredentialStatus(binding()), {
    transportConfigured: true,
  });
});

for (const executionMode of executionModes) {
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
    first.resources,
    "transport",
    {
      "app-server-token": "legacy-transport",
      "gateway-password": "legacy-password",
    },
    { uid: "legacy-uid" },
  );
  const secrets: Record<string, StoredSecret> = { [name]: legacy };
  const fixture = credentialFixture({ secrets });
  for (const executionMode of embeddedFirstModes) {
    assert.deepEqual(
      await fixture.driver.getAgentRuntimeCredentialStatus({
        namespace,
        agent: { ...agent, executionMode },
      }),
      { transportConfigured: true },
    );
  }
  const before = structuredClone(legacy);
  await fixture.resources.ensureLegacyGatewayPassword(
    { namespaceId: namespace.id, agentId: agent.id },
    {
      name: fixture.namespaceName,
      plane: "control",
    },
  );
  const password = secrets[`gateway-password-${digest(agent.id)}`];
  assert.ok(password?.data);
  assert.deepEqual(password.data, { "gateway-password": legacy.data["gateway-password"] });
  assert.deepEqual(secrets[name], before, "an older Gateway may still reference its legacy Secret");
  await fixture.resources.ensureLegacyGatewayPassword(
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
    const secrets: Record<string, StoredSecret> = {
      [name]: runtimeSecret(initial.resources, "transport", {
        "app-server-token": "legacy-transport",
        "gateway-password": "legacy-password",
      }),
    };
    const fixture = credentialFixture({
      secrets,
      async createSecret(request, store) {
        if (outcome === "unavailable") {
          throw httpError(503);
        }
        if (outcome !== "disappeared") {
          const competitor = structuredClone(request);
          if (outcome === "different") {
            assert.ok(competitor.body.data);
            competitor.body.data["gateway-password"] = encode("another-password");
          }
          if (outcome === "foreign") {
            competitor.body.metadata.labels["openclaw.dev/agent"] = "another-agent";
            competitor.body.metadata.annotations["openclaw.dev/agent-id"] = "another-agent";
          }
          await store(competitor);
        }
        throw httpError(409);
      },
    });
    const original = structuredClone(secrets[name]);
    assert.ok(original?.data);
    const delivery = () =>
      fixture.resources.ensureLegacyGatewayPassword(
        { namespaceId: namespace.id, agentId: agent.id },
        { name: fixture.namespaceName, plane: "control" },
      );
    if (outcome === "identical") {
      await delivery();
      assert.deepEqual(secrets[`gateway-password-${digest(agent.id)}`]?.data, {
        "gateway-password": original.data["gateway-password"],
      });
    } else {
      const refusal = {
        different: ResourceConflictError,
        foreign: {
          message: /^Refusing unowned Kubernetes Secret gateway-password-[a-f0-9]{12}\.$/,
        },
        disappeared: { message: "HTTP 409", statusCode: 409 },
        unavailable: { message: "HTTP 503", statusCode: 503 },
      }[outcome];
      assert.ok(refusal, `${outcome}: name its refusal`);
      await assert.rejects(delivery(), refusal, outcome);
    }
    assert.deepEqual(secrets[name], original, `${outcome}: preserve the serving Gateway source`);
  }
});

registerEarlyTeardown();

test("a cluster denial of runtime credential Secrets names the Kubernetes operation and namespace", async () => {
  // The data-plane tenant-api RoleBinding is missing: the API may not read the embedded
  // Agent's transport Secret, so operators need the operation, not a generic outage.
  const kubernetesNamespace = kubernetesNamespaceName(namespace.id);
  for (const executionMode of embeddedFirstModes) {
    const { driver } = credentialFixture({ secretReadStatus: 403 });
    const denied = await driver
      .getAgentRuntimeCredentialStatus({ namespace, agent: { ...agent, executionMode } })
      .then(
        () => assert.fail("a denied Secret read must fail"),
        (error: unknown) => error,
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
      { verb: "get", resource: "secrets", kubernetesNamespace, plane: "execution", status: 403 },
    );
  }

  const { driver, created } = credentialFixture({ secretCreateStatus: 403 });
  const denied = await driver.provisionAgentRuntimeCredentials(binding(), {}).then(
    () => assert.fail("a denied Secret create must fail"),
    (error: unknown) => error,
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
    (error: unknown) => error,
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
      .filter((call) => call.kind === "readSecret")
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
  const transport = created[0]?.stringData;
  assert.ok(transport);
  const token = transport["app-server-token"];
  assert.ok(token !== undefined);
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  const password = created[1]?.stringData;
  assert.ok(password);
  const passwordValue = password["gateway-password"];
  assert.ok(passwordValue !== undefined);
  assert.deepEqual(Object.keys(transport), ["app-server-token"]);
  assert.deepEqual(Object.keys(password), ["gateway-password"]);
  assert.match(passwordValue, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(token, passwordValue);
});

for (const group of ["transport", "gateway-password"]) {
  for (const defect of ["extra data", "foreign owner", "missing group"]) {
    test(`runtime credential creation refuses ${group} with ${defect} on readback`, async () => {
      const secrets: Record<string, StoredSecret> = {};
      const name = `${group}-${digest(agent.id)}`;
      const fixture = credentialFixture({
        secrets,
        observeCreatedSecret(secret) {
          if (secret.metadata.name === name) {
            if (defect === "extra data") {
              secret.data.unexpected = encode("benign-admission-value");
            } else if (defect === "foreign owner") {
              secret.metadata.labels["openclaw.dev/agent"] = "another-agent";
            }
          }
          return secret;
        },
        ...(defect === "missing group"
          ? {
              async createSecret(request, store) {
                const observed = await store(request);
                // Another actor removes this group after the create has succeeded.
                delete secrets[name];
                return observed;
              },
            }
          : {}),
      });

      await assert.rejects(
        fixture.driver.provisionAgentRuntimeCredentials(binding(), {}),
        defect === "missing group" ? DependencyUnavailableError : ResourceConflictError,
      );
      const retained = structuredClone(secrets);
      if (defect === "missing group") {
        assert.deepEqual(await fixture.driver.getAgentRuntimeCredentialStatus(binding()), {
          transportConfigured: false,
        });
      } else {
        await assert.rejects(
          fixture.driver.getAgentRuntimeCredentialStatus(binding()),
          ResourceConflictError,
        );
      }
      assert.deepEqual(secrets, retained, "failed confirmation must retain the stored objects");
      assert.deepEqual(fixture.deleted, []);
      assert.deepEqual(
        fixture.calls.filter((call) => call.kind === "createSecret").map(({ name }) => name),
        [`transport-${digest(agent.id)}`, `gateway-password-${digest(agent.id)}`],
        "confirmation must not replay creates or compensate for the stored objects",
      );
    });
  }
}

test("runtime credential creation reconciles a lost response without replaying the stored Secret", async () => {
  let responseLost = false;
  const fixture = credentialFixture({
    async createSecret(request, store) {
      const observed = await store(request);
      if (!responseLost) {
        responseLost = true;
        throw httpError(503);
      }
      return observed;
    },
  });

  await assert.rejects(
    fixture.driver.provisionAgentRuntimeCredentials(binding(), {}),
    DependencyUnavailableError,
  );
  assert.equal(fixture.created.length, 1, "an uncertain create must not be replayed");
  assert.deepEqual(await fixture.driver.getAgentRuntimeCredentialStatus(binding()), {
    transportConfigured: false,
  });
  assert.deepEqual(await fixture.driver.provisionAgentRuntimeCredentials(binding(), {}), {
    transportConfigured: true,
  });
  assert.deepEqual(
    fixture.created.map((secret) => secret.metadata.name),
    [`transport-${digest(agent.id)}`, `gateway-password-${digest(agent.id)}`],
  );
  assert.deepEqual(fixture.deleted, []);
});

test("mocked Kubernetes client can recover missing transport when model credentials already exist", async () => {
  const first = credentialFixture();
  const secrets = {
    [`model-${digest(agent.id)}`]: runtimeSecret(first.resources, "model", {
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
    [`transport-${digest(agent.id)}`]: runtimeSecret(first.resources, "transport", {
      "app-server-token": "app-server-token-value",
    }),
    [`gateway-password-${digest(agent.id)}`]: runtimeSecret(first.resources, "gateway-password", {
      "gateway-password": "gateway-password-value",
    }),
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
    [`transport-${digest(agent.id)}`]: runtimeSecret(first.resources, "transport", {
      "app-server-token": "app-server-token-value",
      unexpected: "unexpected-value",
      "gateway-password": "gateway-password-value",
    }),
  };
  const { driver, created } = credentialFixture({ secrets });

  await assert.rejects(
    driver.provisionAgentRuntimeCredentials(binding(), {}),
    /runtime credential Secret is incomplete/,
  );
  assert.equal(created.length, 0);
});

registerGatewayPasswordProjection();

test("mocked Kubernetes client rejects malformed existing credential Secrets before writes", async () => {
  const first = credentialFixture();
  const malformed: readonly (readonly [string, StoredSecret])[] = [
    ["missing transport key", runtimeSecret(first.resources, "transport", {})],
    [
      "empty decoded credential",
      runtimeSecret(
        first.resources,
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
  ];
  for (const [name, secret] of malformed) {
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
    ...first.resources.manifest(
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

registerCodexLauncher();
registerSharedAndTwoClusterTeardown();
