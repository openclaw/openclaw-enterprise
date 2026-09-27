import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";

import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import { ResourceConflictError, ScopeViolationError } from "../../packages/occ/src/index.ts";
import { createControllerAuth } from "../../apps/controller/src/auth/index.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
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
  const diagnosticObservedAt = "2026-01-02T03:04:05.000Z";
  const diagnosticCheckedAt = "2026-01-02T03:04:04.000Z";
  const emptyStatus = Object.freeze({
    transportConfigured: false,
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
    validateHarnessAuth() {},
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
      if (options.statusError !== undefined) {
        throw options.statusError;
      }
      return { ...statusOf(binding) };
    },
    async provisionAgentRuntimeCredentials(binding, input) {
      calls.push({
        operation: "provision",
        agentId: binding.agent.id,
        input: structuredClone(input),
      });
      const status = {
        transportConfigured: true,
      };
      statusByAgent.set(keyOf(binding), status);
      if (options.provisionError !== undefined) {
        throw options.provisionError;
      }
      return { ...status };
    },
    async diagnoseAgentDeployment(binding) {
      calls.push({
        operation: "diagnostics",
        agentId: binding.agent.id,
        revisionId: binding.revision.id,
      });
      if (options.diagnosticsError !== undefined) {
        throw options.diagnosticsError;
      }
      if (Object.hasOwn(options, "diagnosticsResult")) {
        return options.diagnosticsResult;
      }
      return {
        revisionId: binding.revision.id,
        observedAt: diagnosticObservedAt,
        checks: [
          {
            component: "runtime",
            check: "gateway",
            state: "succeeded",
            checkedAt: diagnosticCheckedAt,
            code: "gateway_ready",
          },
        ],
      };
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

  async function bootstrapAgent() {
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
    const secret = await request("POST", `/namespaces/${namespace.data.id}/secrets`, {
      body: { name: "Model API key", value: `model-key-${randomUUID()}` },
    });
    assert.equal(secret.status, 201);
    const configuration = await request("POST", `/namespaces/${namespace.data.id}/configurations`, {
      body: {
        kind: "agent",
        values: createHarnessConfiguration("openclaw", "gpt-4.1"),
      },
    });
    assert.equal(configuration.status, 201);
    const agent = await request("POST", `/namespaces/${namespace.data.id}/agents`, {
      body: {
        name: "Runtime credential Agent",
        configurationId: configuration.data.id,
        executionMode: "embedded",
        harnessAuth: { method: "api_key", source: secret.data.ref },
      },
    });
    assert.equal(agent.status, 201);
    const servicePrincipalId = `service-agent-${agent.data.id}`;
    const roleId = `auth-${agent.data.id}`;
    policy.identities.push({
      id: servicePrincipalId,
      kind: "service_principal",
      namespaceId: namespace.data.id,
      agentId: agent.data.id,
    });
    policy.roles.push({
      id: roleId,
      namespaceId: namespace.data.id,
      permissions: [{ action: "operate", resourceKind: "secret" }],
    });
    policy.bindings.push({
      id: roleId,
      namespaceId: namespace.data.id,
      subjectKind: "identity",
      subjectId: servicePrincipalId,
      roleId,
      resourceKind: "secret",
      resourceId: secret.data.id,
    });
    return {
      namespace: namespace.data,
      configuration: configuration.data,
      agent: agent.data,
      secret: secret.data,
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

test("runtime credential API provisions transport metadata only through the selected Compute Driver", async (t) => {
  const fixture = await createFixture(t);
  const { namespace, agent } = await fixture.bootstrapAgent();
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/runtime-credentials`;

  const initial = await fixture.request("GET", path);
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.data, {
    transportConfigured: false,
  });

  const provisioned = await fixture.request("POST", path, { body: {} });
  assert.equal(provisioned.status, 200);
  assert.deepEqual(provisioned.data, {
    transportConfigured: true,
  });

  const observed = await fixture.request("GET", path);
  assert.equal(observed.status, 200);
  assert.deepEqual(observed.data, provisioned.data);
  assert.deepEqual(
    fixture.computeDriver.calls.map((call) => call.operation),
    ["status", "provision", "status"],
  );
  assert.deepEqual(fixture.computeDriver.calls[1].input, {});

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
  });

  const provisioned = await fixture.request("POST", path, { body: {} });
  assert.equal(provisioned.status, 200);
  assert.deepEqual(provisioned.data, {
    transportConfigured: true,
  });
  assert.deepEqual(fixture.computeDriver.calls.at(-1).input, {});
});

test("runtime credential POST rejects channel token bodies before driver provisioning", async (t) => {
  const fixture = await createFixture(t);
  const { namespace, agent } = await fixture.bootstrapAgent();
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/runtime-credentials`;
  const appToken = `xapp-${randomUUID()}`;

  const rejected = await fixture.request("POST", path, {
    body: { slack: { appToken, botToken: "xoxb-test" } },
  });
  assert.equal(rejected.status, 400);
  assert.equal(JSON.stringify(rejected.body).includes(appToken), false);
  assert.equal(fixture.computeDriver.calls.length, 0);
});

test("runtime credential POST keeps session CSRF and exact Agent read plus operate authorization", async (t) => {
  const fixture = await createFixture(t);
  const { namespace, agent } = await fixture.bootstrapAgent();
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/runtime-credentials`;

  const wrongLoopbackOrigin = fixture.origin.replace(/:\d+$/, ":1");
  const csrfRejected = await fixture.request("POST", path, {
    origin: wrongLoopbackOrigin,
    body: {},
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
    body: {},
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
});

test("runtime credential API rejects unsupported initial provisioning states and request shapes", async (t) => {
  const fixture = await createFixture(t);
  const { namespace, agent } = await fixture.bootstrapAgent();
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/runtime-credentials`;
  const invalidBodies = [
    { modelApiKey: "legacy-model-secret" },
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

  const generated = await fixture.request("POST", path, { body: {} });
  assert.equal(generated.status, 200);

  const revision = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/agents/${agent.id}/deploy`,
  );
  assert.equal(revision.status, 202);
  const deployedRejected = await fixture.request("POST", path, {
    body: {},
  });
  assert.equal(deployedRejected.status, 409);
  assert.equal(deployedRejected.body.error.code, "RESOURCE_CONFLICT");
});

test("deployment diagnostics require exact revision read and Agent operate authorization", async (t) => {
  const fixture = await createFixture(t);
  const { namespace, agent } = await fixture.bootstrapAgent();
  const revision = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/agents/${agent.id}/deploy`,
  );
  assert.equal(revision.status, 202);
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/deployments/${revision.data.id}/diagnostics`;

  const { principal, session } = await fixture.createPrincipal(
    "deployment-diagnostics-reader",
    (limited) => {
      fixture.policy.roles.push({
        id: "diagnostics-revision-reader",
        namespaceId: namespace.id,
        permissions: [{ action: "read", resourceKind: "agent_revision" }],
      });
      fixture.policy.bindings.push({
        id: "diagnostics-revision-reader-binding",
        namespaceId: namespace.id,
        subjectKind: "identity",
        subjectId: limited.id,
        roleId: "diagnostics-revision-reader",
        resourceKind: "agent_revision",
        resourceId: revision.data.id,
      });
    },
  );
  const denied = await fixture.request("POST", path, { session });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "FORBIDDEN");
  assert.equal(fixture.computeDriver.calls.length, 0);
  const denial = fixture.auditSink.events.at(-1);
  assert.equal(denial.kind, "authorization_denial");
  assert.deepEqual(denial.authorization, {
    principalId: principal.id,
    action: "operate",
    resource: { kind: "agent", id: agent.id, namespaceId: namespace.id },
  });

  fixture.policy.roles.push({
    id: "diagnostics-agent-operator",
    namespaceId: namespace.id,
    permissions: [{ action: "operate", resourceKind: "agent" }],
  });
  fixture.policy.bindings.push({
    id: "diagnostics-agent-operator-binding",
    namespaceId: namespace.id,
    subjectKind: "identity",
    subjectId: principal.id,
    roleId: "diagnostics-agent-operator",
    resourceKind: "agent",
    resourceId: agent.id,
  });
  const missingAgentRead = await fixture.request("POST", path, { session });
  assert.equal(missingAgentRead.status, 403);
  assert.equal(missingAgentRead.body.error.code, "FORBIDDEN");
  assert.equal(fixture.computeDriver.calls.length, 0);
  const readDenial = fixture.auditSink.events.at(-1);
  assert.equal(readDenial.kind, "authorization_denial");
  assert.deepEqual(readDenial.authorization, {
    principalId: principal.id,
    action: "read",
    resource: { kind: "agent", id: agent.id, namespaceId: namespace.id },
  });

  fixture.policy.roles.push({
    id: "diagnostics-agent-reader",
    namespaceId: namespace.id,
    permissions: [{ action: "read", resourceKind: "agent" }],
  });
  fixture.policy.bindings.push({
    id: "diagnostics-agent-reader-binding",
    namespaceId: namespace.id,
    subjectKind: "identity",
    subjectId: principal.id,
    roleId: "diagnostics-agent-reader",
    resourceKind: "agent",
    resourceId: agent.id,
  });
  const scopedDiagnostics = await fixture.request("POST", path, { session });
  assert.equal(scopedDiagnostics.status, 200);
  assert.equal(scopedDiagnostics.data.revisionId, revision.data.id);
  assert.deepEqual(fixture.computeDriver.calls, [
    { operation: "diagnostics", agentId: agent.id, revisionId: revision.data.id },
  ]);
  fixture.computeDriver.calls.length = 0;

  const diagnostics = await fixture.request("POST", path);
  assert.equal(diagnostics.status, 200);
  assert.deepEqual(diagnostics.data, {
    revisionId: revision.data.id,
    observedAt: "2026-01-02T03:04:05.000Z",
    checks: [
      {
        component: "runtime",
        check: "gateway",
        state: "succeeded",
        checkedAt: "2026-01-02T03:04:04.000Z",
        code: "gateway_ready",
      },
    ],
  });
  assert.deepEqual(fixture.computeDriver.calls, [
    { operation: "diagnostics", agentId: agent.id, revisionId: revision.data.id },
  ]);

  // Revoking revision access must deny an otherwise authorized Agent operator.
  const revisionBindingIndex = fixture.policy.bindings.findIndex(
    (binding) => binding.id === "diagnostics-revision-reader-binding",
  );
  assert.notEqual(revisionBindingIndex, -1);
  fixture.policy.bindings.splice(revisionBindingIndex, 1);
  fixture.computeDriver.calls.length = 0;
  const missingRevisionRead = await fixture.request("POST", path, { session });
  assert.equal(missingRevisionRead.status, 403);
  assert.equal(missingRevisionRead.body.error.code, "FORBIDDEN");
  assert.equal(fixture.computeDriver.calls.length, 0);
  const revisionDenial = fixture.auditSink.events.at(-1);
  assert.equal(revisionDenial.kind, "authorization_denial");
  assert.deepEqual(revisionDenial.authorization, {
    principalId: principal.id,
    action: "read",
    resource: { kind: "agent_revision", id: revision.data.id, namespaceId: namespace.id },
  });
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
    body: {},
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
  });

  const leakedAuditValue = `audit-leak-${randomUUID()}`;
  const auditSink = new InMemoryAuditSink();
  const originalAppend = auditSink.append.bind(auditSink);
  auditSink.append = async (event) => {
    if (event.action === "openclaw.agents.runtime_credentials.provision") {
      throw new Error(`must not leak ${leakedAuditValue}`);
    }
    await originalAppend(event);
  };
  const auditFailureFixture = await createFixture(t, { auditSink });
  const auditAgent = await auditFailureFixture.bootstrapAgent();
  const auditPath = `/namespaces/${auditAgent.namespace.id}/agents/${auditAgent.agent.id}/runtime-credentials`;
  const auditFailed = await auditFailureFixture.request("POST", auditPath, {
    body: {},
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
  });
});

for (const DriverError of [ResourceConflictError, ScopeViolationError]) {
  test(`deployment diagnostics sanitize ${DriverError.name} from Drivers`, async (t) => {
    const marker = `private-driver-detail-${randomUUID()}`;
    const error = new DriverError(marker);
    const fixture = await createFixture(t, {
      computeDriver: createRuntimeCredentialComputeDriver({ diagnosticsError: error }),
    });
    const { namespace, agent } = await fixture.bootstrapAgent();
    const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
    const revision = await fixture.request("POST", `${agentPath}/deploy`);
    assert.equal(revision.status, 202);
    const result = await fixture.request(
      "POST",
      `${agentPath}/deployments/${revision.data.id}/diagnostics`,
    );
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, "DEPENDENCY_UNAVAILABLE");
    assert.equal(JSON.stringify(result.body).includes(marker), false);
    assert.equal(JSON.stringify(fixture.auditSink.events).includes(marker), false);
  });
}

test("deployment diagnostics reject a null Driver response as unavailable", async (t) => {
  const fixture = await createFixture(t, {
    computeDriver: createRuntimeCredentialComputeDriver({ diagnosticsResult: null }),
  });
  const { namespace, agent } = await fixture.bootstrapAgent();
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const revision = await fixture.request("POST", `${agentPath}/deploy`);
  assert.equal(revision.status, 202);
  const result = await fixture.request(
    "POST",
    `${agentPath}/deployments/${revision.data.id}/diagnostics`,
  );
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, "DEPENDENCY_UNAVAILABLE");
});

test("deployment diagnostics reject invalid Driver evidence", async (t) => {
  const diagnosticOptions = { diagnosticsResult: null };
  const fixture = await createFixture(t, {
    computeDriver: createRuntimeCredentialComputeDriver(diagnosticOptions),
  });
  const { namespace, agent } = await fixture.bootstrapAgent();
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const revision = await fixture.request("POST", `${agentPath}/deploy`);
  assert.equal(revision.status, 202);
  const path = `${agentPath}/deployments/${revision.data.id}/diagnostics`;
  const check = {
    component: "gateway",
    check: "connectivity",
    state: "unknown",
    checkedAt: "2026-01-02T03:04:04.000Z",
  };
  const base = {
    revisionId: revision.data.id,
    observedAt: "2026-01-02T03:04:05.000Z",
    checks: [check],
  };
  for (const [name, diagnosticsResult] of [
    ["revision binding", { ...base, revisionId: `rev_${randomUUID()}` }],
    ["observation time", { ...base, observedAt: "2026-01-02" }],
    ["check time", { ...base, checks: [{ ...check, checkedAt: "2026-01-02" }] }],
    ["component", { ...base, checks: [{ ...check, component: "gateway status" }] }],
    ["check", { ...base, checks: [{ ...check, check: "private status" }] }],
    ["code", { ...base, checks: [{ ...check, code: "private token value" }] }],
  ]) {
    diagnosticOptions.diagnosticsResult = diagnosticsResult;
    const result = await fixture.request("POST", path);
    assert.equal(result.status, 503, name);
    assert.equal(result.body.error.code, "DEPENDENCY_UNAVAILABLE", name);
    assert.equal(JSON.stringify(result.body).includes("private token value"), false, name);
  }
});
