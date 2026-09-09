import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";

import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import { createControllerAuth } from "../../apps/controller/src/auth/index.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { authenticatedHeaders, signInWithEmailPassword } from "../helpers/auth-session.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

const uuidV4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const identifier = (prefix) => new RegExp(`^${prefix}_${uuidV4}$`);

async function availableLoopbackPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.notEqual(address, null);
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

function createRuntimeCredentialComputeDriver(options = {}) {
  const statusByAgent = new Map();
  const calls = [];
  const emptyStatus = Object.freeze({
    transportConfigured: false,
    modelConfigured: false,
    slackConfigured: false,
  });
  const keyOf = (binding) => `${binding.namespace.id}:${binding.agent.id}`;
  const explicitKeyOf = (namespaceId, agentId) => `${namespaceId}:${agentId}`;
  const statusOf = (binding) => statusByAgent.get(keyOf(binding)) ?? emptyStatus;

  return {
    id: options.id ?? "runtime-credential-compute",
    capability: "compute",
    implementation: "in-memory-runtime-credential-test",
    calls,
    setStatus(namespaceId, agentId, status) {
      statusByAgent.set(explicitKeyOf(namespaceId, agentId), { ...status });
    },
    async ensureNamespace(namespace) {
      return { namespaceId: namespace.id, namespaceReady: true };
    },
    async deleteNamespace(namespace) {
      return { namespaceId: namespace.id, namespaceDeleted: true };
    },
    async prepareRevision(revision) {
      return {
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        revisionId: revision.id,
        ready: true,
      };
    },
    async retireRevision() {},
    async getAgentRuntimeCredentialStatus(binding) {
      calls.push({ operation: "status", agentId: binding.agent.id });
      if (options.statusError !== undefined) throw options.statusError;
      return { ...statusOf(binding) };
    },
    async provisionAgentRuntimeCredentials(binding, input) {
      calls.push({
        operation: "provision",
        agentId: binding.agent.id,
        input: structuredClone(input),
      });
      const previous = statusOf(binding);
      const status = {
        transportConfigured: true,
        modelConfigured: input.modelApiKey !== undefined || previous.modelConfigured,
        slackConfigured: input.slack !== undefined || previous.slackConfigured,
      };
      statusByAgent.set(keyOf(binding), status);
      if (options.provisionError !== undefined) throw options.provisionError;
      return { ...status };
    },
  };
}

async function createFixture(t, options = {}) {
  const installationId = `ins_${randomUUID()}`;
  const port = await availableLoopbackPort();
  const origin = `http://127.0.0.1:${port}`;
  const auth = createControllerAuth({
    installationId,
    mode: "development",
    baseURL: origin,
    secret: `runtime-credential-test-secret-${randomUUID()}`,
    memoryDatabase: { user: [], account: [], session: [], verification: [], apikey: [] },
  });
  const credentials = {
    email: `runtime-admin-${randomUUID()}@example.com`,
    password: `runtime-password-${randomUUID()}`,
    name: "Runtime Credential Administrator",
  };
  const account = await auth.createAccount(credentials);
  const seed = auth.principalSeed(account);
  const policy = {
    identities: [seed.principal],
    groups: [],
    memberships: [],
    roles: seed.roles.map((role) => ({
      ...role,
      permissions: role.permissions.map((permission) => ({ ...permission })),
    })),
    bindings: seed.bindings.map((binding) => ({ ...binding })),
    restrictions: [],
  };
  const auditSink = options.auditSink ?? new InMemoryAuditSink();
  const iamDriver = new NativeIAMDriver(
    { loadNativeIAMState: async () => policy },
    { id: "runtime-credential-iam" },
  );
  const computeDriver = options.computeDriver ?? createRuntimeCredentialComputeDriver();
  const platformState = new InMemoryPlatformState({ auditSink });
  let controller;
  const app = createFastifyApp({
    auth,
    iamDriver,
    auditSink,
    development: { enabled: true, installationId },
    publicOrigin: origin,
    computeDriver,
    configurationDriver: createTestConfigurationDriver({ id: "runtime-credential-configuration" }),
    secretDriver: createTestSecretDriver({ id: "runtime-credential-secret" }),
    resolveHarness: resolveApprovedHarness,
    createController(installation) {
      controller = new OpenClawController(installation, {
        state: platformState,
        recordOperations: false,
      });
      return controller;
    },
  });
  await app.listen({ host: "127.0.0.1", port });
  t.after(() => app.close());
  const adminSession = await signInWithEmailPassword({ origin, ...credentials });
  let bootstrapped = false;

  async function rawRequest(method, path, { headers = {}, body } = {}) {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const payload = text.length === 0 ? undefined : JSON.parse(text);
    if (payload !== undefined) {
      assert.match(payload.meta?.requestId ?? "", identifier("req"));
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    return {
      status: response.status,
      headers: response.headers,
      body: payload,
      data: payload?.data,
    };
  }

  async function request(
    method,
    path,
    { session = adminSession, headers = {}, body, origin: requestOrigin = origin } = {},
  ) {
    const mutation = ["POST", "PATCH", "PUT", "DELETE"].includes(method);
    return rawRequest(method, path, {
      headers: {
        ...(session === null ? {} : authenticatedHeaders(session)),
        ...(mutation && requestOrigin !== null ? { origin: requestOrigin } : {}),
        ...headers,
      },
      body,
    });
  }

  async function bootstrapAgent(options = {}) {
    if (!bootstrapped) {
      const created = await request("POST", "/installation/bootstrap", {
        body: { name: "Runtime credential test" },
      });
      assert.equal(created.status, 201);
      bootstrapped = true;
    }
    const namespace = await request("POST", "/namespaces", {
      body: { name: `runtime-namespace-${randomUUID().slice(0, 8)}` },
    });
    assert.equal(namespace.status, 201);
    await controller.handleNamespaceLifecycle(seed.principal.id, namespace.data.id, "ready");
    const serviceAccount = options.serviceAccount
      ? await request("POST", `/namespaces/${namespace.data.id}/service-accounts`, {
          body: { name: "Managed ServiceAccount" },
        })
      : undefined;
    if (serviceAccount !== undefined) assert.equal(serviceAccount.status, 201);
    const secret = options.modelSecretBinding
      ? await request("POST", `/namespaces/${namespace.data.id}/secrets`, {
          body: { name: "Model API key", value: `model-key-${randomUUID()}` },
        })
      : undefined;
    if (secret !== undefined) assert.equal(secret.status, 201);
    const configuration = await request("POST", `/namespaces/${namespace.data.id}/configurations`, {
      body: {
        kind: "agent",
        values: {},
        ...(secret === undefined
          ? {}
          : {
              secretBindings: {
                OPENAI_API_KEY: {
                  source: secret.data.ref,
                  delivery: { type: "env" },
                },
              },
            }),
      },
    });
    assert.equal(configuration.status, 201);
    const agent = await request("POST", `/namespaces/${namespace.data.id}/agents`, {
      body: {
        name: "Runtime credential Agent",
        configurationId: configuration.data.id,
        ...(serviceAccount === undefined ? {} : { serviceAccountId: serviceAccount.data.id }),
      },
    });
    assert.equal(agent.status, 201);
    return {
      namespace: namespace.data,
      configuration: configuration.data,
      agent: agent.data,
      serviceAccount: serviceAccount?.data,
      secret: secret?.data,
    };
  }

  async function createPrincipal(label, configurePolicy) {
    const principalCredentials = {
      email: `${label}-${randomUUID()}@example.com`,
      password: `runtime-password-${randomUUID()}`,
      name: label,
    };
    const created = await auth.createAccount(principalCredentials);
    const createdSeed = auth.principalSeed(created);
    policy.identities.push(createdSeed.principal);
    configurePolicy(createdSeed.principal);
    return {
      principal: createdSeed.principal,
      session: await signInWithEmailPassword({ origin, ...principalCredentials }),
    };
  }

  return {
    auditSink,
    bootstrapAgent,
    computeDriver,
    controller: () => controller,
    createPrincipal,
    origin,
    policy,
    request,
    seed,
  };
}

test("runtime credential API provisions metadata only through the selected Compute Driver", async (t) => {
  const fixture = await createFixture(t);
  const { namespace, agent } = await fixture.bootstrapAgent();
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/runtime-credentials`;
  const modelApiKey = `model-secret-${randomUUID()}`;
  const slack = {
    appToken: `xapp-${randomUUID()}`,
    botToken: `xoxb-${randomUUID()}`,
  };

  const initial = await fixture.request("GET", path);
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.data, {
    transportConfigured: false,
    modelConfigured: false,
    slackConfigured: false,
  });

  const provisioned = await fixture.request("POST", path, {
    body: { modelApiKey, slack },
  });
  assert.equal(provisioned.status, 200);
  assert.deepEqual(provisioned.data, {
    transportConfigured: true,
    modelConfigured: true,
    slackConfigured: true,
  });
  assert.equal(JSON.stringify(provisioned.body).includes(modelApiKey), false);
  assert.equal(JSON.stringify(provisioned.body).includes(slack.appToken), false);
  assert.equal(JSON.stringify(provisioned.body).includes(slack.botToken), false);

  const observed = await fixture.request("GET", path);
  assert.equal(observed.status, 200);
  assert.deepEqual(observed.data, provisioned.data);
  assert.deepEqual(
    fixture.computeDriver.calls.map((call) => call.operation),
    ["status", "provision", "status"],
  );
  assert.deepEqual(fixture.computeDriver.calls[1].input, { modelApiKey, slack });

  const audit = JSON.stringify(fixture.auditSink.events);
  assert.equal(audit.includes(modelApiKey), false);
  assert.equal(audit.includes(slack.appToken), false);
  assert.equal(audit.includes(slack.botToken), false);
  assert.ok(
    fixture.auditSink.events.some(
      (event) =>
        event.action === "openclaw.agents.runtime_credentials.provision" &&
        event.resource.kind === "agent" &&
        event.resource.id === agent.id &&
        event.outcome === "success",
    ),
  );
});

test("runtime credential POST accepts empty input when only transport provisioning is needed", async (t) => {
  const fixture = await createFixture(t);
  const { namespace, agent } = await fixture.bootstrapAgent();
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/runtime-credentials`;
  fixture.computeDriver.setStatus(namespace.id, agent.id, {
    transportConfigured: false,
    modelConfigured: true,
    slackConfigured: false,
  });

  const provisioned = await fixture.request("POST", path, { body: {} });
  assert.equal(provisioned.status, 200);
  assert.deepEqual(provisioned.data, {
    transportConfigured: true,
    modelConfigured: true,
    slackConfigured: false,
  });
  assert.deepEqual(fixture.computeDriver.calls.at(-1).input, {});
});

test("runtime credential POST keeps session CSRF and exact Agent read plus operate authorization", async (t) => {
  const fixture = await createFixture(t);
  const { namespace, agent } = await fixture.bootstrapAgent();
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/runtime-credentials`;
  const modelApiKey = `csrf-secret-${randomUUID()}`;

  const wrongLoopbackOrigin = fixture.origin.replace(/:\d+$/, ":1");
  const csrfRejected = await fixture.request("POST", path, {
    origin: wrongLoopbackOrigin,
    body: { modelApiKey },
  });
  assert.equal(csrfRejected.status, 403);
  assert.equal(csrfRejected.body.error.code, "FORBIDDEN");
  assert.equal(fixture.computeDriver.calls.length, 0);

  const { principal, session } = await fixture.createPrincipal(
    "runtime-operator-without-read",
    (limited) => {
      fixture.policy.roles.push({
        id: "runtime-operate-without-read",
        namespaceId: namespace.id,
        permissions: [{ action: "operate", resourceKind: "agent" }],
      });
      fixture.policy.bindings.push({
        id: "runtime-operate-without-read-binding",
        namespaceId: namespace.id,
        subjectKind: "identity",
        subjectId: limited.id,
        roleId: "runtime-operate-without-read",
      });
    },
  );
  const denied = await fixture.request("POST", path, {
    session,
    body: { modelApiKey },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "FORBIDDEN");
  assert.equal(fixture.computeDriver.calls.length, 0);
  const denial = fixture.auditSink.events.at(-1);
  assert.equal(denial.kind, "authorization_denial");
  assert.deepEqual(denial.authorization, {
    principalId: principal.id,
    action: "read",
    resource: { kind: "agent", id: agent.id, namespaceId: namespace.id },
  });
  assert.equal(JSON.stringify(denial).includes(modelApiKey), false);
});

test("runtime credential API rejects unsupported initial provisioning states and request shapes", async (t) => {
  const fixture = await createFixture(t);
  const { namespace, agent } = await fixture.bootstrapAgent();
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/runtime-credentials`;
  const invalidBodies = [
    { modelApiKey: "" },
    { modelApiKey: "valid", extra: "unsupported" },
    { slack: { appToken: "xapp-valid" } },
    { slack: { appToken: "xapp-valid", botToken: "xoxb-valid", extra: "unsupported" } },
  ];

  for (const body of invalidBodies) {
    const rejected = await fixture.request("POST", path, { body });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, "INVALID_REQUEST");
  }
  assert.equal(fixture.computeDriver.calls.length, 0);

  const withServiceAccount = await fixture.bootstrapAgent({ serviceAccount: true });
  const serviceAccountRejected = await fixture.request(
    "POST",
    `/namespaces/${withServiceAccount.namespace.id}/agents/${withServiceAccount.agent.id}/runtime-credentials`,
    { body: { modelApiKey: `service-account-conflict-${randomUUID()}` } },
  );
  assert.equal(serviceAccountRejected.status, 409);
  assert.equal(serviceAccountRejected.body.error.code, "RESOURCE_CONFLICT");

  const withModelSecret = await fixture.bootstrapAgent({ modelSecretBinding: true });
  const modelSecretRejected = await fixture.request(
    "POST",
    `/namespaces/${withModelSecret.namespace.id}/agents/${withModelSecret.agent.id}/runtime-credentials`,
    { body: { modelApiKey: `model-secret-conflict-${randomUUID()}` } },
  );
  assert.equal(modelSecretRejected.status, 409);
  assert.equal(modelSecretRejected.body.error.code, "RESOURCE_CONFLICT");

  const revision = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/agents/${agent.id}/deploy`,
  );
  assert.equal(revision.status, 202);
  const deployedRejected = await fixture.request("POST", path, {
    body: { modelApiKey: `historical-revision-conflict-${randomUUID()}` },
  });
  assert.equal(deployedRejected.status, 409);
  assert.equal(deployedRejected.body.error.code, "RESOURCE_CONFLICT");
});

test("runtime credential driver and audit failures stay sanitized and recoverable through GET", async (t) => {
  const leakedDriverValue = `driver-leak-${randomUUID()}`;
  const driverFailureFixture = await createFixture(t, {
    computeDriver: createRuntimeCredentialComputeDriver({
      provisionError: new Error(`must not leak ${leakedDriverValue}`),
    }),
  });
  const failedAgent = await driverFailureFixture.bootstrapAgent();
  const failedPath = `/namespaces/${failedAgent.namespace.id}/agents/${failedAgent.agent.id}/runtime-credentials`;
  const failed = await driverFailureFixture.request("POST", failedPath, {
    body: { modelApiKey: leakedDriverValue },
  });
  assert.equal(failed.status, 503);
  assert.equal(failed.body.error.code, "DEPENDENCY_UNAVAILABLE");
  assert.equal(JSON.stringify(failed.body).includes(leakedDriverValue), false);
  assert.equal(
    JSON.stringify(driverFailureFixture.auditSink.events).includes(leakedDriverValue),
    false,
  );
  const recovered = await driverFailureFixture.request("GET", failedPath);
  assert.equal(recovered.status, 200);
  assert.deepEqual(recovered.data, {
    transportConfigured: true,
    modelConfigured: true,
    slackConfigured: false,
  });

  const leakedAuditValue = `audit-leak-${randomUUID()}`;
  const auditSink = new InMemoryAuditSink();
  const originalAppend = auditSink.append.bind(auditSink);
  auditSink.append = async (event) => {
    if (event.action === "openclaw.agents.runtime_credentials.provision")
      throw new Error(`must not leak ${leakedAuditValue}`);
    await originalAppend(event);
  };
  const auditFailureFixture = await createFixture(t, { auditSink });
  const auditAgent = await auditFailureFixture.bootstrapAgent();
  const auditPath = `/namespaces/${auditAgent.namespace.id}/agents/${auditAgent.agent.id}/runtime-credentials`;
  const auditFailed = await auditFailureFixture.request("POST", auditPath, {
    body: { modelApiKey: leakedAuditValue },
  });
  assert.equal(auditFailed.status, 503);
  assert.equal(auditFailed.body.error.code, "DEPENDENCY_UNAVAILABLE");
  assert.equal(JSON.stringify(auditFailed.body).includes(leakedAuditValue), false);
  assert.equal(
    JSON.stringify(auditFailureFixture.auditSink.events).includes(leakedAuditValue),
    false,
  );
  const auditRecovered = await auditFailureFixture.request("GET", auditPath);
  assert.equal(auditRecovered.status, 200);
  assert.deepEqual(auditRecovered.data, {
    transportConfigured: true,
    modelConfigured: true,
    slackConfigured: false,
  });
});
