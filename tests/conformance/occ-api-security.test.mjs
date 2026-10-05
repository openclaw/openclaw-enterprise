import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import {
  BOOTSTRAP_DEFAULT_NAMESPACE_NAME,
  createRuntimeLogCursorCodec,
  RuntimeLogsForbiddenByClusterError,
} from "../../packages/occ/src/index.ts";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { createReadyComputeDriver } from "../helpers/development.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import {
  administerGrants,
  createRuntimeLogComputeDriver,
  createRuntimeLogFixture,
  operateGrants,
} from "../helpers/runtime-logs.mjs";
import {
  createTenantReaderFixture,
  tenantANamespaceId,
  tenantRequest as request,
} from "../helpers/tenant-reader-app.mjs";

const installationId = "ins_3033697e-6397-4cc6-9b04-8ec17af78cf1";
const missingRevisionId = "rev_3dd29693-ce8b-4b4c-97c4-14b4c68c6e9c";
const bootstrapDefaultNamespaceId = "ns_00000000-0000-4000-8000-000000000001";

const permissions = [
  { action: "administer", resourceKind: "installation" },
  { action: "read", resourceKind: "installation" },
  { action: "create", resourceKind: "namespace" },
  { action: "read", resourceKind: "namespace" },
  { action: "delete", resourceKind: "namespace" },
  { action: "create", resourceKind: "configuration" },
  { action: "read", resourceKind: "configuration" },
  { action: "update", resourceKind: "configuration" },
  { action: "delete", resourceKind: "configuration" },
  { action: "create", resourceKind: "agent" },
  { action: "read", resourceKind: "agent" },
  { action: "update", resourceKind: "agent" },
  { action: "deploy", resourceKind: "agent" },
  { action: "read", resourceKind: "agent_revision" },
  { action: "administer", resourceKind: "agent" },
];

function createFixture(options = {}) {
  return createTenantReaderFixture({
    installationId,
    label: "security",
    administratorName: "Security Administrator",
    readerName: "Tenant A Reader",
    administratorPermissions: permissions,
    computeDriver: createReadyComputeDriver("compute-security"),
    recordOperations: true,
    appOptions: (overrides) => ({
      ...(overrides.maxBodyBytes === undefined ? {} : { maxBodyBytes: overrides.maxBodyBytes }),
      ...(overrides.gatewayRequestTimeoutMs === undefined
        ? {}
        : { gatewayRequestTimeoutMs: overrides.gatewayRequestTimeoutMs }),
      ...(overrides.publicOrigin === undefined ? {} : { publicOrigin: overrides.publicOrigin }),
    }),
    options,
  });
}

async function bootstrap(fixture) {
  const result = await request(fixture.app, "/installation/bootstrap", {
    body: { name: "Security test installation" },
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.payload.data.id, installationId);
  return result.payload.data;
}

async function bootstrappedDefaultNamespace(fixture) {
  const namespaces = await request(fixture.app, "/namespaces");
  assert.equal(namespaces.response.status, 200);
  const found = namespaces.payload.data.find(
    (namespace) => namespace.name === BOOTSTRAP_DEFAULT_NAMESPACE_NAME,
  );
  assert.ok(found, "fresh bootstrap must create the default Namespace");
  assert.equal(found.id, bootstrapDefaultNamespaceId);
  assert.equal(found.status, "provisioning");
  return found;
}

async function createNamespace(fixture, name) {
  const result = await request(fixture.app, "/namespaces", {
    body: { name },
  });
  assert.equal(result.response.status, 201);
  return result.payload.data;
}

async function createConfiguration(fixture, namespace, values = {}) {
  const result = await request(fixture.app, `/namespaces/${namespace.id}/configurations`, {
    body: { kind: "agent", values },
  });
  assert.equal(result.response.status, 201);
  return result.payload.data;
}

async function createAgent(fixture, namespace, name) {
  const configuration = await createConfiguration(fixture, namespace);
  const result = await request(fixture.app, `/namespaces/${namespace.id}/agents`, {
    body: { name, configurationId: configuration.id },
  });
  assert.equal(result.response.status, 201);
  return result.payload.data;
}

async function deploy(fixture, namespace, agent) {
  const result = await request(
    fixture.app,
    `/namespaces/${namespace.id}/agents/${agent.id}/deploy`,
    { method: "POST" },
  );
  assert.equal(result.response.status, 409);
  assert.equal(result.payload.error.code, "NAMESPACE_NOT_READY");
  return result;
}

test("existing namespace adoption requires installation administration and waits for provisioning", async () => {
  const fixture = await createFixture();
  await bootstrap(fixture);

  // Ordinary namespace creation does not authorize claiming an operator-owned Kubernetes namespace.
  fixture.state.roles.push({
    id: "role-namespace-creator",
    permissions: [{ action: "create", resourceKind: "namespace" }],
  });
  fixture.state.bindings.push({
    id: "binding-namespace-creator",
    subjectKind: "identity",
    subjectId: fixture.tenantAReader.id,
    roleId: "role-namespace-creator",
  });
  const creator = fixture.createApp(fixture.tenantAReader);
  const managed = await request(creator, "/namespaces", {
    body: { name: "Ordinary tenant" },
  });
  assert.equal(managed.response.status, 201);
  assert.equal(Object.hasOwn(managed.payload.data, "existingNamespace"), false);

  const denied = await request(creator, "/namespaces", {
    body: { name: "Unauthorized adoption", existingNamespace: "operator-owned" },
  });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.payload.error.code, "FORBIDDEN");
  const denial = fixture.auditSink.events.at(-1);
  assert.equal(denial.kind, "authorization_denial");
  assert.equal(denial.authorization.action, "administer");
  assert.deepEqual(denial.authorization.resource, { kind: "installation", id: installationId });

  // Even an administrator cannot silently adopt through Docker or another unsupported Driver,
  // and the refusal leaves no Namespace behind.
  const namespacesBefore = (await request(fixture.app, "/namespaces")).payload.data;
  const unsupported = await request(fixture.app, "/namespaces", {
    body: { name: "Unsupported adoption", existingNamespace: "operator-owned" },
  });
  assert.equal(unsupported.response.status, 409);
  assert.equal(unsupported.payload.error.code, "RESOURCE_CONFLICT");
  assert.deepEqual((await request(fixture.app, "/namespaces")).payload.data, namespacesBefore);

  const kubernetes = createTestKubernetesComputeDriver("compute-security-kubernetes");
  fixture.controller.registerDriver(kubernetes);
  fixture.controller.selectDriver("compute", kubernetes.id);
  const selected = await request(fixture.app, "/namespaces", {
    body: { name: "Operator-owned tenant", existingNamespace: "operator-owned" },
  });
  assert.equal(selected.response.status, 201);
  assert.equal(selected.payload.data.existingNamespace, "operator-owned");

  const duplicate = await request(fixture.app, "/namespaces", {
    body: { name: "Duplicate adoption", existingNamespace: "operator-owned" },
  });
  assert.equal(duplicate.response.status, 409);

  const invalid = await request(fixture.app, "/namespaces", {
    body: { name: "Invalid adoption", existingNamespace: "Operator.Owned" },
  });
  assert.equal(invalid.response.status, 400);

  // Unauthorized callers cannot infer provisioning state or bypass denial auditing.
  const unauthorizedConfiguration = await request(
    creator,
    `/namespaces/${selected.payload.data.id}/configurations`,
    { body: { kind: "agent", values: {} } },
  );
  assert.equal(unauthorizedConfiguration.response.status, 403);
  assert.equal(fixture.auditSink.events.at(-1).kind, "authorization_denial");

  // Authorized Configuration writes cannot race the worker before it claims the namespace.
  const premature = await request(
    fixture.app,
    `/namespaces/${selected.payload.data.id}/configurations`,
    { body: { kind: "agent", values: {} } },
  );
  assert.equal(premature.response.status, 409);
  assert.equal(premature.payload.error.code, "NAMESPACE_NOT_READY");

  await fixture.controller.transact((unit) =>
    unit.namespaces.transitionNamespaceStatus(selected.payload.data.id, "provisioning", "ready"),
  );
  const ready = await request(
    fixture.app,
    `/namespaces/${selected.payload.data.id}/configurations`,
    { body: { kind: "agent", values: {} } },
  );
  assert.equal(ready.response.status, 201);
  assert.equal(ready.payload.data.namespaceId, selected.payload.data.id);
});

test("Agent configuration replacement requires exact Agent update authorization and returns Agent service principal identity", async () => {
  const fixture = await createFixture();
  await bootstrap(fixture);
  const namespace = await createNamespace(fixture, "Tenant A");
  const agent = await createAgent(fixture, namespace, "Private configuration agent");
  const replacement = await createConfiguration(fixture, namespace, { model: "private-model" });

  const updated = await request(fixture.app, `/namespaces/${namespace.id}/agents/${agent.id}`, {
    method: "PATCH",
    body: { configurationId: replacement.id },
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.payload.data.configurationId, replacement.id);
  assert.equal(updated.payload.data.servicePrincipalId, agent.servicePrincipalId);

  const readOnly = fixture.createApp(fixture.tenantAReader);
  const denied = await request(readOnly, `/namespaces/${namespace.id}/agents/${agent.id}`, {
    method: "PATCH",
    body: { configurationId: agent.configurationId },
  });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.payload.error.code, "FORBIDDEN");
  assert.equal(fixture.auditSink.events.at(-1)?.kind, "authorization_denial");
  assert.equal(fixture.auditSink.events.at(-1)?.resource.id, agent.id);

  const unchanged = await request(fixture.app, `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.equal(unchanged.payload.data.configurationId, replacement.id);
});

test("an exact Agent update Restriction denies only its target without changing its configuration", async () => {
  const deniedAgentId = "agt_00000000-0000-4000-8000-000000000003";
  const fixture = await createFixture({
    restrictions: [
      {
        id: "restriction-no-target-agent-update",
        namespaceId: tenantANamespaceId,
        action: "update",
        resourceKind: "agent",
        resourceId: deniedAgentId,
        effect: "deny",
      },
    ],
  });
  await bootstrap(fixture);
  const namespace = await createNamespace(fixture, "Tenant A");
  const deniedAgent = await createAgent(fixture, namespace, "Restricted agent");
  const allowedAgent = await createAgent(fixture, namespace, "Allowed agent");
  const replacement = await createConfiguration(fixture, namespace, { model: "allowed" });
  assert.equal(deniedAgent.id, deniedAgentId);

  const denied = await request(
    fixture.app,
    `/namespaces/${namespace.id}/agents/${deniedAgent.id}`,
    { method: "PATCH", body: { configurationId: replacement.id } },
  );
  assert.equal(denied.response.status, 403);
  assert.deepEqual(fixture.auditSink.events.at(-1)?.details.iamEvidence.restrictionIds, [
    "restriction-no-target-agent-update",
  ]);

  const allowed = await request(
    fixture.app,
    `/namespaces/${namespace.id}/agents/${allowedAgent.id}`,
    { method: "PATCH", body: { configurationId: replacement.id } },
  );
  assert.equal(allowed.response.status, 200);
  assert.equal(allowed.payload.data.configurationId, replacement.id);

  const unchanged = await request(
    fixture.app,
    `/namespaces/${namespace.id}/agents/${deniedAgent.id}`,
  );
  assert.equal(unchanged.payload.data.configurationId, deniedAgent.configurationId);
});

test("development admission fails closed outside explicit loopback-only development", async () => {
  await assert.rejects(
    createFixture({ development: { trustedCidrs: ["not-a-cidr"] } }),
    /IPv4 CIDR/,
  );

  const fixture = await createFixture();
  const remote = await request(fixture.app, "/installation/bootstrap", {
    origin: "http://public.example.com",
    body: { name: "Must not bootstrap remotely" },
  });
  assert.equal(remote.response.status, 403);
  assert.equal(fixture.controller, undefined);

  const remoteOrigin = await request(fixture.app, "/installation/bootstrap", {
    headers: { origin: "http://public.example.com" },
    body: { name: "Must not bootstrap from a remote browser origin" },
  });
  assert.equal(remoteOrigin.response.status, 403);
  assert.equal(fixture.controller, undefined);

  for (const forwarded of [
    { forwarded: "for=203.0.113.2" },
    { "x-forwarded-for": "203.0.113.2" },
    { "x-forwarded-host": "public.example.com" },
    { "x-forwarded-proto": "https" },
    { "x-forwarded-port": "443" },
    { "x-real-ip": "203.0.113.2" },
  ]) {
    const response = await request(fixture.app, "/installation/bootstrap", {
      headers: forwarded,
      body: { name: "Must not trust forwarded requests" },
    });
    assert.equal(response.response.status, 403);
    assert.equal(fixture.controller, undefined);
  }
});

test("a trusted development CIDR admits its own range and nothing else", async (t) => {
  const development = { trustedCidrs: ["10.89.0.0/16"] };
  const fixture = await createFixture({ development });
  await bootstrap(fixture);
  // app.fetch always injects from 127.0.0.1; Fastify inject can name the peer address.
  const app = fixture.createApp(fixture.administrator, { development }, createFastifyApp);
  t.after(() => app.close());
  const list = (remoteAddress) =>
    app.inject({
      url: "/namespaces",
      remoteAddress,
      headers: authenticatedHeaders(fixture.app.defaultSession),
    });
  for (const admitted of ["127.0.0.1", "10.89.0.1", "10.89.255.254", "::ffff:10.89.3.4"]) {
    assert.equal((await list(admitted)).statusCode, 200, admitted);
  }
  for (const refused of [
    "10.90.0.1",
    "10.88.255.255",
    "192.0.2.10",
    "fd00::1",
    "::ffff:10.90.0.1",
  ]) {
    const response = await list(refused);
    assert.equal(response.statusCode, 403, refused);
    assert.match(response.json().error.message, /restricted to direct loopback requests/, refused);
  }
});

test("spoofed bearer evidence is denied without audit writes and admitted unknown identities are audited", async () => {
  const fixture = await createFixture();
  await bootstrap(fixture);
  const expectedOperations = fixture.controller.pendingOperations().length;
  const expectedAuditEvents = fixture.auditSink.events.length;

  for (const headers of [
    {},
    {
      "x-openclaw-principal": fixture.administrator.id,
      "x-openclaw-issuer": fixture.administrator.issuer,
      "x-openclaw-subject": fixture.administrator.subject,
    },
  ]) {
    const denied = await request(fixture.app, "/namespaces", {
      identity: false,
      headers,
      body: { name: "Unauthorized namespace" },
    });
    assert.equal(denied.response.status, 401);
    assert.equal(fixture.controller.pendingOperations().length, expectedOperations);
    assert.equal(fixture.auditSink.events.length, expectedAuditEvents);
  }

  for (const headers of [
    { authorization: "Bearer impostor" },
    { authorization: "Basic impostor" },
    { authorization: "Bearer token-a, Bearer impostor" },
    { authorization: "Bearer" },
    { authorization: "not-a-session-cookie" },
  ]) {
    const denied = await request(fixture.app, "/namespaces", {
      headers,
      body: { name: "Unauthorized namespace" },
    });
    assert.equal(denied.response.status, 401);
    assert.equal(fixture.controller.pendingOperations().length, expectedOperations);
    assert.equal(fixture.auditSink.events.length, expectedAuditEvents);
  }

  const unprovisioned = await createFixture({ identities: [] });
  const unknown = await request(unprovisioned.app, "/installation/bootstrap", {
    body: { name: "Unknown principal" },
  });
  assert.equal(unknown.response.status, 403);
  assert.equal(unprovisioned.controller, undefined);
  assert.equal(unprovisioned.auditSink.events[0]?.kind, "authorization_denial");
});

test("an unknown caller cannot enumerate an empty or populated Namespace collection", async () => {
  const fixture = await createFixture();
  await bootstrap(fixture);

  const unknownHeaders = { authorization: "Bearer not-the-configured-token" };
  const initialAuditEvents = fixture.auditSink.events.length;
  const empty = await request(fixture.app, "/namespaces", {
    headers: unknownHeaders,
  });
  assert.equal(empty.response.status, 401);
  assert.equal(empty.payload.data, undefined);
  assert.equal(fixture.auditSink.events.length, initialAuditEvents);

  const namespace = await createNamespace(fixture, "Existing tenant");
  const expectedAuditEvents = fixture.auditSink.events.length;
  const populated = await request(fixture.app, "/namespaces", {
    headers: unknownHeaders,
  });
  assert.equal(populated.response.status, 401);
  assert.equal(populated.payload.data, undefined);
  assert.doesNotMatch(JSON.stringify(populated.payload), new RegExp(namespace.id));
  assert.equal(fixture.auditSink.events.length, expectedAuditEvents);
});

test("Restriction denials retain sanitized native IAM evidence in audit", async () => {
  const fixture = await createFixture();
  await bootstrap(fixture);
  fixture.state.restrictions.push({
    id: "restriction-no-namespace-create",
    action: "create",
    resourceKind: "namespace",
    effect: "deny",
  });
  const denied = await request(fixture.app, "/namespaces", {
    body: { name: "blocked-by-restriction" },
  });
  assert.equal(denied.response.status, 403);
  const event = fixture.auditSink.events.at(-1);
  assert.equal(event.kind, "authorization_denial");
  assert.equal(event.iamDriverId, "iam-security");
  assert.deepEqual(event.details.iamEvidence.restrictionIds, ["restriction-no-namespace-create"]);
  assert.equal(JSON.stringify(event).includes("blocked-by-restriction"), false);
});

test("bootstrap owns one Installation without a plural installation collection", async () => {
  const fixture = await createFixture();
  const installation = await bootstrap(fixture);
  assert.equal(installation.name, "Security test installation");
  const defaultNamespace = await bootstrappedDefaultNamespace(fixture);

  const read = await request(fixture.app, "/installation");
  assert.equal(read.response.status, 200);
  assert.deepEqual(read.payload.data, installation);

  const again = await request(fixture.app, "/installation/bootstrap", {
    body: { name: "Second installation" },
  });
  assert.equal(again.response.status, 409);

  for (const candidate of [
    { pathname: "/installations" },
    { pathname: "/installations", body: { name: "Tenant installation" } },
  ]) {
    const result = await request(fixture.app, candidate.pathname, candidate);
    assert.equal(result.response.status, 404);
  }

  const bootstrapEvents = fixture.auditSink.events.filter(
    (event) => event.kind === "bootstrap" && event.resource.kind === "installation",
  );
  assert.equal(bootstrapEvents.length, 1);
  assert.equal(bootstrapEvents[0].actorId, fixture.administrator.id);
  assert.equal(bootstrapEvents[0].resource.id, installationId);

  await fixture.controller.handleNamespaceLifecycle(
    fixture.administrator.id,
    defaultNamespace.id,
    "ready",
  );
  const readyDefault = await request(fixture.app, `/namespaces/${defaultNamespace.id}`);
  assert.equal(readyDefault.response.status, 200);
  assert.equal(readyDefault.payload.data.status, "ready");
  const defaultAgent = await createAgent(fixture, readyDefault.payload.data, "Default Agent");
  assert.equal(defaultAgent.namespaceId, defaultNamespace.id);
});

test("bootstrap fails closed when default Namespace creation is denied and later retries cleanly", async () => {
  const restrictions = [
    {
      id: "restriction-no-bootstrap-namespace",
      action: "create",
      resourceKind: "namespace",
      effect: "deny",
    },
  ];
  const fixture = await createFixture({ restrictions });

  const denied = await request(fixture.app, "/installation/bootstrap", {
    body: { name: "Blocked default Namespace" },
  });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.payload.error.code, "FORBIDDEN");

  const deniedEvent = fixture.auditSink.events.at(-1);
  assert.equal(deniedEvent.kind, "authorization_denial");
  assert.equal(deniedEvent.authorization.action, "create");
  assert.deepEqual(deniedEvent.authorization.resource, {
    kind: "namespace",
    id: installationId,
  });
  assert.deepEqual(deniedEvent.details.iamEvidence.restrictionIds, [
    "restriction-no-bootstrap-namespace",
  ]);

  const absentInstallation = await request(fixture.app, "/installation");
  assert.equal(absentInstallation.response.status, 404);
  const absentNamespaces = await request(fixture.app, "/namespaces");
  assert.equal(absentNamespaces.response.status, 404);

  restrictions.length = 0;
  const recovered = await request(fixture.app, "/installation/bootstrap", {
    body: { name: "Recovered default Namespace" },
  });
  assert.equal(recovered.response.status, 201);
  assert.equal(recovered.payload.data.name, "Recovered default Namespace");
  await bootstrappedDefaultNamespace(fixture);
});

test("bootstrap without Installation administer is refused and audited", async () => {
  const restrictions = [
    {
      id: "restriction-no-installation-administer",
      action: "administer",
      resourceKind: "installation",
      effect: "deny",
    },
  ];
  const fixture = await createFixture({ restrictions });

  const eventsBefore = fixture.auditSink.events.length;
  const denied = await request(fixture.app, "/installation/bootstrap", {
    body: { name: "Refused Installation" },
  });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.payload.error.code, "FORBIDDEN");
  assert.equal(fixture.controller, undefined);
  assert.equal(fixture.auditSink.events.length, eventsBefore + 1);
  const deniedEvent = fixture.auditSink.events.at(-1);
  assert.equal(deniedEvent.kind, "authorization_denial");
  assert.equal(deniedEvent.actorId, fixture.administrator.id);
  assert.deepEqual(deniedEvent.details.iamEvidence.restrictionIds, [
    "restriction-no-installation-administer",
  ]);

  restrictions.length = 0;
  const bootstrapped = await request(fixture.app, "/installation/bootstrap", {
    body: { name: "Allowed Installation" },
  });
  assert.equal(bootstrapped.response.status, 201);
});

test("concurrent streaming bootstrap creates one audited Installation", async () => {
  const fixture = await createFixture();
  let releaseBodies;
  const ready = new Promise((resolve) => {
    releaseBodies = resolve;
  });
  const encoder = new TextEncoder();

  function competingRequest(name) {
    const body = new ReadableStream({
      async start(stream) {
        await ready;
        stream.enqueue(encoder.encode(JSON.stringify({ name })));
        stream.close();
      },
    });

    return new Request("http://127.0.0.1/installation/bootstrap", {
      method: "POST",
      duplex: "half",
      headers: authenticatedHeaders(fixture.app.defaultSession, {
        "content-type": "application/json",
      }),
      body,
    });
  }

  const requests = [
    competingRequest("First competing installation"),
    competingRequest("Second competing installation"),
  ];
  const pending = Promise.all(requests.map((candidate) => fixture.app.fetch(candidate)));
  const release = setTimeout(() => releaseBodies(), 0);
  let responses;
  try {
    responses = await pending;
  } finally {
    clearTimeout(release);
  }

  assert.deepEqual(
    responses.map((response) => response.status).sort((left, right) => left - right),
    [201, 409],
  );
  const accepted = responses.find((response) => response.status === 201);
  assert.ok(accepted);
  const installation = (await accepted.json()).data;
  assert.deepEqual(fixture.controller.installation, installation);
  await bootstrappedDefaultNamespace(fixture);

  const confirmed = await request(fixture.app, "/installation");
  assert.equal(confirmed.response.status, 200);
  assert.deepEqual(confirmed.payload.data, installation);

  const bootstrapEvents = fixture.auditSink.events.filter(
    (event) => event.kind === "bootstrap" && event.resource.kind === "installation",
  );
  assert.equal(bootstrapEvents.length, 1);
  assert.equal(bootstrapEvents[0].resource.id, installation.id);
  assert.equal(bootstrapEvents[0].actorId, fixture.administrator.id);
  // Only the winning bootstrap queues provisioning of the default Namespace.
  assert.deepEqual(fixture.controller.pendingOperations(), [
    {
      kind: "namespace",
      action: "reconcile",
      target: "ready",
      namespaceId: bootstrapDefaultNamespaceId,
      resourceId: bootstrapDefaultNamespaceId,
      actorId: fixture.administrator.id,
    },
  ]);
});

test("an existing controller cannot be configured for a different Installation", async () => {
  const fixture = await createFixture();
  const installation = await bootstrap(fixture);

  assert.throws(
    () =>
      fixture.createApp(fixture.administrator, {
        development: {
          installationId: "ins_9ce0e58a-415d-485e-90c2-20c3c5572505",
        },
      }),
    /installation/i,
  );

  const unchanged = await request(fixture.app, "/installation");
  assert.equal(unchanged.response.status, 200);
  assert.deepEqual(unchanged.payload.data, installation);
  assert.deepEqual(fixture.controller.installation, installation);
});

test("malformed, non-JSON, invalid, and oversized inputs fail without mutations", async () => {
  const fixture = await createFixture({ maxBodyBytes: 256 });
  await bootstrap(fixture);
  const before = fixture.controller.pendingOperations().length;

  const cases = [
    {
      expectedStatus: 415,
      headers: { "content-type": "text/plain" },
      body: '{"name":"wrong media type"}',
    },
    { expectedStatus: 400, body: '{"name":' },
    { expectedStatus: 400, body: null },
    { expectedStatus: 400, body: [] },
    { expectedStatus: 400, body: {} },
    { expectedStatus: 400, body: { name: "   " } },
    { expectedStatus: 413, body: { name: "x".repeat(1024) } },
  ];

  for (const candidate of cases) {
    const result = await request(fixture.app, "/namespaces", candidate);
    assert.equal(result.response.status, candidate.expectedStatus, JSON.stringify(candidate.body));
    assert.equal(fixture.controller.pendingOperations().length, before);
  }

  assert.equal(
    fixture.auditSink.events.filter(
      (event) => event.kind === "mutation" && event.resource.kind === "namespace",
    ).length,
    0,
  );
});

test("NUL characters and unpaired surrogates are refused in bodies and path parameters", async () => {
  // PostgreSQL text and jsonb cannot store either one: they answered 500 or 503 there, while
  // the in-memory State accepted them. A lone surrogate in a name was stored as U+FFFD.
  const fixture = await createFixture();
  await bootstrap(fixture);
  const namespace = await createNamespace(fixture, "Unstorable text tenant");
  const configurations = `/namespaces/${namespace.id}/configurations`;
  const nul = ["a NUL character", "INVALID_FORMAT"];
  const surrogate = ["an unpaired UTF-16 surrogate", "INVALID_VALUE"];
  // A deep body inside the 64 KiB limit; its detail path keeps whole leading segments.
  const deep = 30_000;
  const deepPath = `/values/x${"/0".repeat((512 - "/values/x".length) >> 1)}`;
  const cases = [
    ["/namespaces", '{"name":"lone \\ud800 surrogate"}', "/name", surrogate],
    ["/namespaces", '{"name":"trailing \\udc00"}', "/name", surrogate],
    [configurations, '{"kind":"agent","values":{"x":"a\\u0000b"}}', "/values/x", nul],
    [configurations, '{"kind":"agent","values":{"a\\u0000~/":"x"}}', "/values/a?~0~1", nul],
    [configurations, '{"kind":"agent","values":{"\\udbff":"x"}}', "/values/?", surrogate],
    // The first offender in document order is named.
    [
      configurations,
      '{"kind":"agent","values":{"first":["ok","\\ud800"],"second":"\\u0000"}}',
      "/values/first/1",
      surrogate,
    ],
    // Keys and values share document order.
    [configurations, '{"kind":"agent","values":{"a":"\\u0000","b\\ud800":1}}', "/values/a", nul],
    // A first segment too long for the 512-character detail path is cut, not dropped.
    [configurations, `{"${"k".repeat(600)}\\u0000":1}`, `/${"k".repeat(511)}`, nul],
    [
      configurations,
      `{"kind":"agent","values":{"x":${"[".repeat(deep)}"\\u0000"${"]".repeat(deep)}}}`,
      deepPath,
      nul,
    ],
  ];
  for (const [pathname, body, path, [problem, code]] of cases) {
    const result = await request(fixture.app, pathname, { body });
    assert.equal(result.response.status, 400, body.slice(0, 80));
    assert.equal(result.payload.error.code, "INVALID_REQUEST");
    assert.deepEqual(result.payload.error.details, [{ path, code }]);
    const expected = `The request does not match the operation contract: body ${path} contains ${problem}.`;
    // The deep path is cut to the 256-character message cap.
    assert.equal(
      result.payload.error.message,
      expected.length <= 256 ? expected : `${expected.slice(0, 255)}…`,
    );
  }
  // A surrogate pair is one well-formed character.
  const paired = await request(fixture.app, "/namespaces", { body: { name: "Paired \u{1F600}" } });
  assert.equal(paired.response.status, 201);

  const role = await request(fixture.app, `/namespaces/${namespace.id}/iam/roles/role%00x`);
  assert.equal(role.response.status, 400);
  assert.deepEqual(role.payload.error.details, [{ path: "/roleId", code: "INVALID_FORMAT" }]);
  assert.equal(
    role.payload.error.message,
    "The request does not match the operation contract: params /roleId contains a NUL character.",
  );

  const namespaces = await request(fixture.app, "/namespaces");
  assert.deepEqual(
    namespaces.payload.data.map(({ name }) => name),
    ["default", "Unstorable text tenant", "Paired \u{1F600}"],
  );
  assert.equal(
    fixture.auditSink.events.filter(
      (event) => event.kind === "mutation" && event.resource.kind === "configuration",
    ).length,
    0,
  );
});

test("router failures answer the error envelope without echoing the path", async () => {
  const fixture = await createFixture();
  await bootstrap(fixture);
  const namespace = await createNamespace(fixture, "Router failure tenant");
  const roles = `/namespaces/${namespace.id}/iam/roles`;
  const contract = "The request does not match the operation contract";
  for (const [pathname, status, code, message] of [
    // Fastify answered these itself: its own body naming FST_ERR_* and the submitted path,
    // no meta.requestId, x-request-id, cache-control or nosniff, and 414 for a long parameter.
    [
      "/namespaces/%ZZ",
      400,
      "INVALID_REQUEST",
      "The request path has a malformed percent-encoding.",
    ],
    [
      `${roles}/role%ED%A0%80x`,
      400,
      "INVALID_REQUEST",
      "The request path has a malformed percent-encoding.",
    ],
    [
      `${roles}/${"r".repeat(401)}`,
      400,
      "INVALID_REQUEST",
      `${contract}: a path parameter is too long.`,
    ],
    // Role IDs may hold 200 characters, so a long one reaches the route.
    [
      `${roles}/${"r".repeat(200)}`,
      404,
      "NOT_FOUND",
      "The requested platform resource was not found.",
    ],
    [
      `${roles}/${"%F0%9F%98%80".repeat(200)}`,
      404,
      "NOT_FOUND",
      "The requested platform resource was not found.",
    ],
  ]) {
    const { response, payload } = await request(fixture.app, pathname);
    assert.equal(response.status, status, pathname.slice(0, 80));
    assert.deepEqual(payload.error, { code, message });
    assert.deepEqual(Object.keys(payload).sort(), ["error", "meta"]);
    assert.doesNotMatch(JSON.stringify(payload), /FST_ERR|%ZZ|%ED|rrrr/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  }
});

test("names are measured in characters, not UTF-16 code units", async () => {
  // 200 emoji fit the 200-character contract (and PostgreSQL char_length), but each is two
  // UTF-16 code units; the controller answered 404 NOT_FOUND for such a Namespace or Agent.
  const fixture = await createFixture();
  await bootstrap(fixture);
  const name = "\u{1F600}".repeat(200);
  const namespace = await createNamespace(fixture, name);
  assert.equal(namespace.name, name);
  const agent = await createAgent(fixture, namespace, name);
  assert.equal(agent.name, name);

  const tooLong = await request(fixture.app, "/namespaces", { body: { name: `${name}x` } });
  assert.equal(tooLong.response.status, 400);
  assert.deepEqual(tooLong.payload.error.details, [{ path: "/name", code: "TOO_LONG" }]);
});

test("exact Namespace ownership prevents cross-tenant access and resource traversal", async () => {
  const fixture = await createFixture();
  await bootstrap(fixture);
  const namespaceA = await createNamespace(fixture, "Tenant A");
  const namespaceB = await createNamespace(fixture, "Tenant B");
  const agentA = await createAgent(fixture, namespaceA, "Agent A");
  const agentB = await createAgent(fixture, namespaceB, "Agent B");
  await deploy(fixture, namespaceA, agentA);
  await deploy(fixture, namespaceB, agentB);

  for (const [namespace, agent] of [
    [namespaceA, agentA],
    [namespaceB, agentB],
  ]) {
    const revisions = await request(
      fixture.app,
      `/namespaces/${namespace.id}/agents/${agent.id}/revisions`,
    );
    assert.equal(revisions.response.status, 200);
    assert.deepEqual(revisions.payload.data, []);
  }

  for (const pathname of [
    `/namespaces/${namespaceA.id}/agents/${agentB.id}`,
    `/namespaces/${namespaceA.id}/agents/${agentB.id}/revisions`,
    `/namespaces/${namespaceA.id}/agents/${agentA.id}/revisions/${missingRevisionId}`,
    `/namespaces/${namespaceB.id}/agents/${agentB.id}/revisions/${missingRevisionId}`,
    `/namespaces/${namespaceA.id}%2F..%2F${namespaceB.id}`,
    `/namespaces/${namespaceA.id}/agents/${agentB.id}%2F..`,
    "/namespaces/%00",
    "/namespaces/%5Ctenant",
  ]) {
    const result = await request(fixture.app, pathname);
    assert.ok(
      result.response.status === 400 || result.response.status === 404,
      `${pathname}: ${result.response.status}`,
    );
  }

  const reader = fixture.tenantAReader;
  assert.equal(namespaceA.id, tenantANamespaceId);
  const readerApp = fixture.createApp(reader);

  const visible = await request(readerApp, "/namespaces", {
    principal: reader,
  });
  assert.equal(visible.response.status, 200);
  assert.deepEqual(
    visible.payload.data.map((namespace) => namespace.id),
    [namespaceA.id],
  );

  const ownAgent = await request(readerApp, `/namespaces/${namespaceA.id}/agents/${agentA.id}`, {
    principal: reader,
  });
  assert.equal(ownAgent.response.status, 200);

  const operationCount = fixture.controller.pendingOperations().length;
  for (const candidate of [
    { pathname: `/namespaces/${namespaceB.id}` },
    { pathname: `/namespaces/${namespaceB.id}/agents` },
    { pathname: `/namespaces/${namespaceB.id}/agents/${agentB.id}` },
    {
      pathname: `/namespaces/${namespaceB.id}/agents`,
      body: { name: "Cross-tenant mutation", configurationId: agentB.configurationId },
    },
  ]) {
    const result = await request(readerApp, candidate.pathname, {
      principal: reader,
      ...candidate,
    });
    assert.equal(result.response.status, 403, candidate.pathname);
    assert.equal(fixture.controller.pendingOperations().length, operationCount);
  }

  const scopedDenials = fixture.auditSink.events.filter(
    (event) => event.kind === "authorization_denial" && event.actorId === reader.id,
  );
  assert.equal(scopedDenials.length, 4);
  for (const event of scopedDenials) {
    assert.equal(event.installationId, installationId);
    assert.equal(event.namespaceId, namespaceB.id);
    assert.equal(event.outcome, "denied");
  }
});

test("a caller without a grant gets the same audited denial whether or not the target exists", async () => {
  const fixture = await createFixture();
  await bootstrap(fixture);
  await createNamespace(fixture, "Tenant A");
  const namespace = await createNamespace(fixture, "Tenant B");
  const agent = await createAgent(fixture, namespace, "Agent B");
  const missingNamespaceId = "ns_9e5b1c7a-5d2f-4c1e-8a3b-0f6d2e7c9a41";
  const missingAgentId = "agt_4b8e2d1f-7a3c-4e9b-9c5d-2a1f8e6b3d70";
  const child = (prefix) => `${prefix}_6c2a9f1e-3b7d-4a8c-b5e1-9d4f2a7c8e03`;
  const reader = fixture.tenantAReader;
  const readerApp = fixture.createApp(reader);

  // The reader holds no grant in Tenant B. Every target below must answer the same audited
  // 403 whether the Namespace or Agent exists, so a refusal never reveals which ids are real.
  const namespaceRoutes = [
    ["GET", "agents/repository-options"],
    ["GET", `agents/provision/${child("work")}`],
    ["POST", `agents/provision/${child("work")}/retry`],
    ["GET", "presets"],
    ["POST", "agents", { name: "probe", configurationId: agent.configurationId }],
    ["POST", "configurations", { kind: "agent", values: {} }],
    ["PATCH", `configurations/${child("cfg")}`, { values: {} }],
    ["DELETE", `configurations/${child("cfg")}`],
    ["POST", "secrets", { name: "probe", value: "probe-value" }],
    ["PATCH", `secrets/${child("sec")}`, { value: "probe-value" }],
    ["DELETE", `secrets/${child("sec")}`],
    ["POST", "credential-sources", { name: "probe", type: "openai" }],
    ["PATCH", `credential-sources/${child("cs")}`, {}],
    ["DELETE", `credential-sources/${child("cs")}`],
    ["POST", "presets", { name: "probe", template: {} }],
    ["PATCH", `presets/${child("pre")}`, { name: "probe" }],
    ["DELETE", `presets/${child("pre")}`],
    ["POST", "service-accounts", { name: "probe" }],
    ["POST", `service-accounts/${child("sa")}/credentials`, {}],
    [
      "PATCH",
      `service-accounts/${child("sa")}/credential`,
      { kind: "api_key", secretRef: { name: "probe", key: "probe" } },
    ],
    ["DELETE", `service-accounts/${child("sa")}`],
    ["DELETE", ""],
  ];
  const agentRoutes = [
    ["GET", ""],
    ["GET", `revisions/${missingRevisionId}`],
    ["GET", `deployments/${missingRevisionId}`],
    ["GET", "repository-options"],
    ["PATCH", "", { configurationId: agent.configurationId }],
    ["POST", "deploy"],
    ["POST", "stop"],
    ["POST", `credential-sources/${child("cs")}/withdraw`],
    ["DELETE", ""],
  ];
  const probes = [
    ...namespaceRoutes.flatMap(([method, suffix, body]) =>
      [namespace.id, missingNamespaceId].map((namespaceId) => ({
        method,
        body,
        pathname: `/namespaces/${namespaceId}${suffix ? `/${suffix}` : ""}`,
      })),
    ),
    ...agentRoutes.flatMap(([method, suffix, body]) =>
      [
        [namespace.id, agent.id],
        [namespace.id, missingAgentId],
        [missingNamespaceId, missingAgentId],
      ].map(([namespaceId, agentId]) => ({
        method,
        body,
        pathname: `/namespaces/${namespaceId}/agents/${agentId}${suffix ? `/${suffix}` : ""}`,
      })),
    ),
  ];

  const leaks = [];
  for (const { method, pathname, body } of probes) {
    const auditCount = fixture.auditSink.events.length;
    const result = await request(readerApp, pathname, {
      method,
      ...(body === undefined ? {} : { body }),
    });
    const denials = fixture.auditSink.events
      .slice(auditCount)
      .filter((event) => event.kind === "authorization_denial" && event.actorId === reader.id);
    if (result.response.status !== 403 || denials.length !== 1) {
      leaks.push(`${method} ${pathname}: ${result.response.status}, ${denials.length} denials`);
    }
  }
  assert.deepEqual(leaks, []);
});

test("a denial whose audit cannot be written answers 503, not 403", async () => {
  const fixture = await createFixture();
  await bootstrap(fixture);
  await createNamespace(fixture, "Tenant A");
  const namespace = await createNamespace(fixture, "Tenant B");
  const readerApp = fixture.createApp(fixture.tenantAReader);
  const read = () => request(readerApp, `/namespaces/${namespace.id}`);

  const append = fixture.auditSink.append;
  fixture.auditSink.append = async (event) => {
    if (event.kind === "authorization_denial") {
      throw new Error("audit sink unavailable");
    }
    return append.call(fixture.auditSink, event);
  };
  try {
    const unaudited = await read();
    assert.equal(unaudited.response.status, 503);
    assert.equal(unaudited.payload.error.code, "DEPENDENCY_UNAVAILABLE");
  } finally {
    fixture.auditSink.append = append;
  }
  const audited = await read();
  assert.equal(audited.response.status, 403);
  assert.equal(fixture.auditSink.events.at(-1).kind, "authorization_denial");
});

test("Namespace deletion authorizes the exact target and rejects nonempty resources", async () => {
  const fixture = await createFixture();
  await bootstrap(fixture);
  const occupied = await createNamespace(fixture, "Occupied tenant");
  assert.equal(occupied.id, tenantANamespaceId);
  const readerApp = fixture.createApp(fixture.tenantAReader);
  const forbidden = await request(readerApp, `/namespaces/${occupied.id}`, {
    method: "DELETE",
  });
  assert.equal(forbidden.response.status, 403);

  await createAgent(fixture, occupied, "Existing Agent");
  const nonempty = await request(fixture.app, `/namespaces/${occupied.id}`, {
    method: "DELETE",
  });
  assert.equal(nonempty.response.status, 409);
  assert.equal(nonempty.payload.error.code, "NAMESPACE_NOT_EMPTY");

  const empty = await createNamespace(fixture, "Empty tenant");
  const accepted = await request(fixture.app, `/namespaces/${empty.id}`, {
    method: "DELETE",
  });
  assert.equal(accepted.response.status, 202);
  assert.equal(accepted.payload.data.status, "deleting");
  const deletionAudit = fixture.auditSink.events.at(-1);
  assert.equal(deletionAudit.action, "openclaw.namespaces.delete");
  assert.equal(deletionAudit.resource.id, empty.id);
});

test("mutations are attributable and authorization failures never leak credentials", async () => {
  const fixture = await createFixture();
  await bootstrap(fixture);
  const namespace = await createNamespace(fixture, "Audited tenant");
  const agent = await createAgent(fixture, namespace, "Audited agent");
  await deploy(fixture, namespace, agent);

  assert.deepEqual(
    fixture.auditSink.events
      .filter((event) => ["bootstrap", "mutation"].includes(event.kind))
      .map((event) => [event.kind, event.resource.kind]),
    [
      ["bootstrap", "installation"],
      ["mutation", "namespace"],
      ["mutation", "configuration"],
      ["mutation", "agent"],
      ["mutation", "agent"],
    ],
  );
  for (const event of fixture.auditSink.events.slice(0, -1)) {
    assert.equal(event.actorId, fixture.administrator.id);
    assert.equal(event.installationId, installationId);
    assert.equal(event.outcome, "success");
  }
  assert.equal(fixture.auditSink.events.at(-1)?.outcome, "failure");
  assert.equal(fixture.auditSink.events.at(-1)?.reasonCode, "NAMESPACE_NOT_READY");
  assert.equal(fixture.auditSink.events.at(-1)?.resource.id, agent.id);

  const secret = "sk-security-provider-credential-123456789";
  fixture.iamDriver.authorize = async () => {
    throw new Error(`Backend credentials failed: ${secret}`);
  };
  const denied = await request(fixture.app, "/namespaces", {
    body: { name: "Must fail closed" },
  });
  assert.equal(denied.response.status, 503);
  assert.equal(denied.payload.error.code, "DEPENDENCY_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(denied.payload), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(fixture.auditSink.events), new RegExp(secret));
  assert.equal(fixture.auditSink.events.at(-1)?.resource.id, agent.id);
});

// Agent runtime status and log reads. Status (tier 1) needs Agent operate + read and
// revision read; log text (tier 2) needs Agent read_logs (or administer) + read.
// Every request is re-authorized, including cursor polls, and a denial never reaches
// the Compute Driver.
function runtimeLogLine(index, raw = `gateway output ${index}`) {
  return { time: `2026-09-30T12:00:${String(index).padStart(2, "0")}.000000001Z`, raw };
}

function driverReads(fixture) {
  return fixture.computeDriver.calls.filter(({ operation }) => operation === "read");
}

test("runtime status and log reads enforce their permission tiers before any Driver call", async () => {
  const fixture = await createRuntimeLogFixture();
  const target = await fixture.deployAgent();
  fixture.computeDriver.state.lines = [runtimeLogLine(1)];

  const reader = await fixture.createPrincipal("runtime-reader", target, [
    { action: "read", resourceKind: "agent" },
    { action: "read", resourceKind: "agent_revision" },
  ]);
  const operator = await fixture.createPrincipal("runtime-operator", target, operateGrants);
  const administerOnly = await fixture.createPrincipal("runtime-administer-only", target, [
    { action: "administer", resourceKind: "agent" },
    { action: "read", resourceKind: "agent_revision" },
  ]);
  const administrator = await fixture.createPrincipal(
    "runtime-administrator",
    target,
    administerGrants,
  );
  fixture.computeDriver.calls.length = 0;

  for (const path of [target.runtimePath, target.logsPath()]) {
    const denied = await fixture.request("GET", path, { session: reader.session });
    assert.equal(denied.status, 403, path);
    assert.equal(denied.body.error.code, "FORBIDDEN");
    assert.equal(fixture.auditSink.events.at(-1).kind, "authorization_denial");
  }
  // Operate is the status audience: it sees Pods and Events but never log text.
  const status = await fixture.request("GET", target.runtimePath, { session: operator.session });
  assert.equal(status.status, 200, status.text);
  assert.equal(
    status.data.sources[0].pods[0].name,
    fixture.computeDriver.podName({ id: target.revisionId }),
  );
  const operatorLogs = await fixture.request("GET", target.logsPath(), {
    session: operator.session,
  });
  assert.equal(operatorLogs.status, 403);
  // Without either log grant the denial names the delegable read_logs permission.
  assert.deepEqual(fixture.auditSink.events.at(-1).authorization, {
    principalId: operator.principal.id,
    action: "read_logs",
    resource: { kind: "agent", id: target.agent.id, namespaceId: target.namespace.id },
  });
  const missingRead = await fixture.request("GET", target.logsPath(), {
    session: administerOnly.session,
  });
  assert.equal(missingRead.status, 403);
  assert.equal(fixture.auditSink.events.at(-1).authorization.action, "read");
  // No denied request reached the Driver.
  assert.deepEqual(
    fixture.computeDriver.calls.map(({ operation }) => operation),
    ["describe"],
  );

  const logs = await fixture.request("GET", target.logsPath(), {
    session: administrator.session,
  });
  assert.equal(logs.status, 200, logs.text);
  assert.equal(logs.data.records[0].message, "gateway output 1");

  // A principal of another Namespace is denied like every revision-scoped route: the
  // exact revision read is authorized before anything about the runtime is observed.
  const other = await fixture.deployAgent("runtime-other");
  const foreign = await fixture.createPrincipal("runtime-foreign", other, administerGrants);
  fixture.computeDriver.calls.length = 0;
  for (const path of [target.runtimePath, target.logsPath()]) {
    const crossNamespace = await fixture.request("GET", path, { session: foreign.session });
    assert.equal(crossNamespace.status, 403, path);
  }
  assert.equal(fixture.computeDriver.calls.length, 0);

  // Service principals use the same bindings (CLI and automation).
  const service = await fixture.createServicePrincipal("runtime-cli", target, administerGrants);
  const serviceLogs = await fixture.request("GET", target.logsPath(), {
    serviceKey: service.serviceKey,
  });
  assert.equal(serviceLogs.status, 200, serviceLogs.text);
});

test("a delegated read_logs principal reads and downloads logs without administer", async () => {
  const fixture = await createRuntimeLogFixture();
  const target = await fixture.deployAgent();
  fixture.computeDriver.state.lines = [runtimeLogLine(1)];
  const logReader = [
    { action: "read_logs", resourceKind: "agent" },
    { action: "read", resourceKind: "agent" },
    { action: "read", resourceKind: "agent_revision" },
  ];
  const delegate = await fixture.createPrincipal("runtime-log-reader", target, logReader);
  const accessEvents = () =>
    fixture.auditSink.events.filter(
      ({ action, actor }) =>
        action.startsWith("openclaw.agents.runtime_logs.") &&
        actor?.principalId === delegate.principal.id,
    );

  // read_logs admits log text but nothing the administer tier also covers.
  const logs = await fixture.request("GET", target.logsPath(), { session: delegate.session });
  assert.equal(logs.status, 200, logs.text);
  assert.equal(logs.data.records[0].message, "gateway output 1");
  const download = await fixture.request("GET", target.logsPath("source=gateway&download=true"), {
    session: delegate.session,
  });
  assert.equal(download.status, 200, download.text);
  assert.match(download.text, /gateway output 1/);
  const nativeAdmin = await fixture.request(
    "GET",
    `/namespaces/${target.namespace.id}/agents/${target.agent.id}/native-admin`,
    { session: delegate.session },
  );
  assert.equal(nativeAdmin.status, 403);
  // Runtime status stays with the operate audience.
  const status = await fixture.request("GET", target.runtimePath, { session: delegate.session });
  assert.equal(status.status, 403);

  // Each read is an access event that names the delegated grant, never the text.
  const [view, downloaded] = accessEvents().filter(({ kind }) => kind === "access");
  assert.deepEqual(
    [view, downloaded].map(({ kind, action, outcome, authorization }) => [
      kind,
      action,
      outcome,
      authorization.action,
    ]),
    [
      ["access", "openclaw.agents.runtime_logs.view", "success", "read_logs"],
      ["access", "openclaw.agents.runtime_logs.download", "success", "read_logs"],
    ],
  );
  assert.equal(JSON.stringify(accessEvents()).includes("gateway output 1"), false);

  // The grant is still exact-Agent: a sibling Agent's logs are denied.
  const sibling = await fixture.deployAgent("runtime-log-sibling");
  const siblingLogs = await fixture.request("GET", sibling.logsPath(), {
    session: delegate.session,
  });
  assert.equal(siblingLogs.status, 403);

  // A read_logs Restriction wins even over administer, so it cannot be bypassed.
  const both = await fixture.createPrincipal("runtime-log-both", target, [
    ...logReader,
    { action: "administer", resourceKind: "agent" },
  ]);
  fixture.policy.restrictions.push({
    id: `restriction-read-logs-${target.agent.id}`,
    namespaceId: target.namespace.id,
    action: "read_logs",
    resourceKind: "agent",
    resourceId: target.agent.id,
    effect: "deny",
  });
  const reads = driverReads(fixture).length;
  for (const principal of [delegate, both]) {
    const restricted = await fixture.request("GET", target.logsPath(), {
      session: principal.session,
    });
    assert.equal(restricted.status, 403);
    const denial = fixture.auditSink.events.at(-1);
    assert.equal(denial.kind, "authorization_denial");
    assert.equal(denial.authorization.action, "read_logs");
    assert.deepEqual(denial.details.iamEvidence.restrictionIds, [
      `restriction-read-logs-${target.agent.id}`,
    ]);
  }
  assert.equal(driverReads(fixture).length, reads);

  // Revocation between polls is honoured for the delegated grant too.
  fixture.policy.restrictions.length = 0;
  const again = await fixture.request("GET", target.logsPath(), { session: delegate.session });
  assert.equal(again.status, 200, again.text);
  delegate.revoke("read_logs", "agent");
  const revoked = await fixture.request(
    "GET",
    target.logsPath(`source=gateway&cursor=${encodeURIComponent(again.data.cursor)}`),
    { session: delegate.session },
  );
  assert.equal(revoked.status, 403);
});

test("an Agent-level read_logs grant covers every revision, including later deployments", async () => {
  const fixture = await createRuntimeLogFixture();
  const target = await fixture.deployAgent();
  fixture.computeDriver.state.lines = [runtimeLogLine(1)];
  // No per-revision grant: log text is delegated on the exact Agent alone.
  const delegate = await fixture.createPrincipal("runtime-log-agent-only", target, [
    { action: "read_logs", resourceKind: "agent" },
    { action: "read", resourceKind: "agent" },
  ]);
  const first = await fixture.request("GET", target.logsPath(), { session: delegate.session });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.data.records[0].message, "gateway output 1");

  // A new deployment creates a new revision; the same Agent grant still reads its logs.
  const redeployed = await fixture.request(
    "POST",
    `/namespaces/${target.namespace.id}/agents/${target.agent.id}/deploy`,
  );
  assert.equal(redeployed.status, 202, redeployed.text);
  assert.notEqual(redeployed.data.id, target.revisionId);
  const secondPath = `/namespaces/${target.namespace.id}/agents/${target.agent.id}/deployments/${redeployed.data.id}/runtime/logs?source=gateway`;
  const second = await fixture.request("GET", secondPath, { session: delegate.session });
  assert.equal(second.status, 200, second.text);

  // Runtime status keeps its revision requirement, and a revision of another Agent is
  // never reachable through this Agent's path.
  const status = await fixture.request("GET", target.runtimePath, { session: delegate.session });
  assert.equal(status.status, 403);
  const sibling = await fixture.deployAgent("runtime-log-agent-only-sibling");
  const crossed = await fixture.request(
    "GET",
    `/namespaces/${target.namespace.id}/agents/${target.agent.id}/deployments/${sibling.revisionId}/runtime/logs?source=gateway`,
    { session: delegate.session },
  );
  assert.notEqual(crossed.status, 200);
  const reads = driverReads(fixture).length;
  delegate.revoke("read_logs", "agent");
  const revoked = await fixture.request("GET", secondPath, { session: delegate.session });
  assert.equal(revoked.status, 403);
  assert.equal(driverReads(fixture).length, reads);
});

test("runtime log cursors bind one principal and view and are re-authorized on every poll", async () => {
  const fixture = await createRuntimeLogFixture();
  const target = await fixture.deployAgent();
  const state = fixture.computeDriver.state;
  state.lines = [runtimeLogLine(1), runtimeLogLine(2)];
  const viewer = await fixture.createPrincipal("runtime-viewer", target, administerGrants);
  const other = await fixture.createPrincipal("runtime-other-viewer", target, administerGrants);

  const first = await fixture.request("GET", target.logsPath(), { session: viewer.session });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.data.records.length, 2);
  const views = () =>
    fixture.auditSink.events.filter(({ action }) => action === "openclaw.agents.runtime_logs.view");
  assert.equal(views().length, 1);
  const view = views()[0];
  assert.equal(view.kind, "access");
  assert.equal(view.authorization.action, "administer");
  assert.equal(view.actor.principalId, viewer.principal.id);
  assert.deepEqual(
    { ...view.details.runtimeLogs, viewId: typeof view.details.runtimeLogs.viewId },
    {
      viewId: "string",
      revisionId: target.revisionId,
      source: "gateway",
      pod: fixture.computeDriver.podName({ id: target.revisionId }),
      container: "gateway",
      previous: false,
      tailLines: 200,
    },
  );

  // A follow poll returns only lines after the cursor and is not re-audited.
  state.lines = [runtimeLogLine(1), runtimeLogLine(2), runtimeLogLine(3)];
  const cursor = encodeURIComponent(first.data.cursor);
  const next = await fixture.request("GET", target.logsPath(`source=gateway&cursor=${cursor}`), {
    session: viewer.session,
  });
  assert.equal(next.status, 200, next.text);
  assert.deepEqual(
    next.data.records.map(({ message }) => message),
    ["gateway output 3"],
  );
  assert.ok(driverReads(fixture).at(-1).sinceSeconds >= 1);
  assert.equal(views().length, 1);

  // A container restart is labelled, never a silent restart of the stream.
  state.restartCount = 1;
  state.lines = [runtimeLogLine(4, "after restart")];
  const replaced = await fixture.request(
    "GET",
    target.logsPath(`source=gateway&cursor=${encodeURIComponent(next.data.cursor)}`),
    { session: viewer.session },
  );
  assert.equal(replaced.status, 200, replaced.text);
  assert.deepEqual(
    replaced.data.records.map(({ type, reason, message }) => (type === "gap" ? reason : message)),
    ["stream_replaced", "after restart"],
  );
  state.previousLines = [runtimeLogLine(0, "before restart")];
  const previous = await fixture.request("GET", target.logsPath("source=gateway&previous=true"), {
    session: viewer.session,
  });
  assert.equal(previous.status, 200, previous.text);
  assert.deepEqual(
    previous.data.records.map(({ message }) => message),
    ["before restart"],
  );
  assert.equal(driverReads(fixture).at(-1).previous, true);
  // Reusing a view's cursor for another instance selection starts a new audited view.
  const previousWithCursor = await fixture.request(
    "GET",
    target.logsPath(`source=gateway&previous=true&cursor=${encodeURIComponent(next.data.cursor)}`),
    { session: viewer.session },
  );
  assert.equal(previousWithCursor.status, 200, previousWithCursor.text);
  assert.equal(views().length, 3);

  // Cursors are bound to the principal, target and signature.
  const cursorParts = first.data.cursor.split(".");
  const originalMac = cursorParts[2];
  const tamperedMac = `${originalMac[0] === "A" ? "B" : "A"}${originalMac.slice(1)}`;
  const tamperedCursor = `${cursorParts[0]}.${cursorParts[1]}.${tamperedMac}`;
  assert.equal(
    Buffer.from(originalMac, "base64url").equals(Buffer.from(tamperedMac, "base64url")),
    false,
    "the tamper control must change decoded MAC bytes",
  );
  const readsBefore = driverReads(fixture).length;
  for (const [label, forged, session] of [
    ["foreign principal", first.data.cursor, other.session],
    ["tampered", tamperedCursor, viewer.session],
    ["another source", first.data.cursor.replace("v1.", "v1.e"), viewer.session],
  ]) {
    const rejected = await fixture.request(
      "GET",
      target.logsPath(`source=gateway&cursor=${encodeURIComponent(forged)}`),
      { session },
    );
    assert.equal(rejected.status, 400, label);
    assert.equal(rejected.body.error.code, "RUNTIME_LOGS_CURSOR_INVALID", label);
  }
  assert.equal(driverReads(fixture).length, readsBefore);

  // Only Pods the Driver listed for this revision reach it.
  const unknownPod = await fixture.request(
    "GET",
    target.logsPath("source=gateway&pod=kube-apiserver-0"),
    {
      session: viewer.session,
    },
  );
  assert.equal(unknownPod.status, 400);
  assert.equal(unknownPod.body.error.code, "RUNTIME_LOGS_POD_INVALID");
  const unsupported = await fixture.request("GET", target.logsPath("source=gateway&follow=true"), {
    session: viewer.session,
  });
  assert.equal(unsupported.status, 400);
  assert.equal(driverReads(fixture).length, readsBefore);

  // Revocation between polls is honoured with the same cursor.
  viewer.revoke("administer", "agent");
  const revoked = await fixture.request("GET", target.logsPath(`source=gateway&cursor=${cursor}`), {
    session: viewer.session,
  });
  assert.equal(revoked.status, 403);
  assert.equal(driverReads(fixture).length, readsBefore);
});

test("minLevel filters log lines on the server and a cursor still resumes after hidden lines", async () => {
  const fixture = await createRuntimeLogFixture();
  const target = await fixture.deployAgent();
  const state = fixture.computeDriver.state;
  const codex = (index, level, fields, span) =>
    runtimeLogLine(
      index,
      JSON.stringify({
        timestamp: "2026-10-01T07:49:44.100970Z",
        level,
        fields,
        target: span === undefined ? "codex_app_server" : "codex_exec_server::local_file_system",
        ...(span === undefined ? {} : { span, spans: [] }),
      }),
    );
  state.lines = [
    codex(1, "INFO", { message: "new" }, { name: "fs.read_file" }),
    codex(2, "WARN", { message: "retrying model request" }),
    runtimeLogLine(3, "plain wrapper text"),
    codex(4, "INFO", { message: "close" }, { name: "fs.read_file" }),
  ];
  const views = () =>
    fixture.auditSink.events.filter(({ action }) => action === "openclaw.agents.runtime_logs.view");
  const shown = (page) =>
    page.data.records.map((record) =>
      record.type === "line" ? `${record.level} ${record.message}` : record.type,
    );

  const all = await fixture.request("GET", target.logsPath("source=gateway"));
  assert.equal(all.status, 200, all.text);
  assert.deepEqual(shown(all), [
    "debug span new fs.read_file",
    "warn retrying model request",
    "unknown plain wrapper text",
    "debug span close fs.read_file",
  ]);

  // Lines of unknown level stay: the server cannot tell they are below the floor.
  const info = await fixture.request("GET", target.logsPath("source=gateway&minLevel=info"));
  assert.equal(info.status, 200, info.text);
  assert.deepEqual(shown(info), ["warn retrying model request", "unknown plain wrapper text"]);
  assert.equal(views().length, 2);

  // A poll at the same level is the same view and resumes after the last line read,
  // including the hidden debug line, so lowering the level later never replays it.
  state.lines.push(
    codex(5, "INFO", { message: "new" }, { name: "fs.get_metadata" }),
    codex(6, "ERROR", { message: "model request failed" }),
  );
  const next = await fixture.request(
    "GET",
    target.logsPath(`source=gateway&minLevel=info&cursor=${encodeURIComponent(info.data.cursor)}`),
  );
  assert.equal(next.status, 200, next.text);
  assert.deepEqual(shown(next), ["error model request failed"]);
  assert.equal(views().length, 2);
  const after = await fixture.request(
    "GET",
    target.logsPath(`source=gateway&cursor=${encodeURIComponent(next.data.cursor)}`),
  );
  assert.equal(after.status, 200, after.text);
  assert.deepEqual(shown(after), []);

  // The download applies the same floor.
  const download = await fixture.request(
    "GET",
    target.logsPath("source=gateway&minLevel=error&download=true"),
  );
  assert.equal(download.status, 200, download.text);
  assert.deepEqual(
    download.text
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => line.split(" ").slice(1, 2)[0]),
    ["UNKNOWN", "ERROR"],
  );

  const reads = driverReads(fixture).length;
  const invalid = await fixture.request("GET", target.logsPath("source=gateway&minLevel=unknown"));
  assert.equal(invalid.status, 400, invalid.text);
  assert.equal(driverReads(fixture).length, reads);
});

test("an expired runtime log cursor starts a new audited view with a labelled gap", async () => {
  const cursorSecret = `runtime-log-expiry-secret-${randomUUID()}`;
  const fixture = await createRuntimeLogFixture({
    agentRuntimeLogs: { enabled: true, cursorSecret },
  });
  const target = await fixture.deployAgent();
  fixture.computeDriver.state.lines = [runtimeLogLine(1)];
  const codec = createRuntimeLogCursorCodec(cursorSecret);
  const expired = codec.encode(
    {
      principalId: fixture.admin.seed.principal.id,
      agentId: target.agent.id,
      revisionId: target.revisionId,
      source: "gateway",
    },
    {
      viewId: "rlv_expired",
      pod: fixture.computeDriver.podName({ id: target.revisionId }),
      podUid: fixture.computeDriver.state.podUid,
      restartCount: 0,
      previous: false,
      lastTime: "2026-09-30T10:00:00Z",
      lastHashes: [],
      issuedAt: Date.now() - 2 * 60 * 60 * 1000,
    },
  );
  const resumed = await fixture.request(
    "GET",
    target.logsPath(`source=gateway&cursor=${encodeURIComponent(expired)}`),
  );
  assert.equal(resumed.status, 200, resumed.text);
  assert.deepEqual(
    resumed.data.records.map(({ type, reason }) => (type === "gap" ? reason : type)),
    ["cursor_expired", "line"],
  );
  assert.equal(
    fixture.auditSink.events.filter(({ action }) => action === "openclaw.agents.runtime_logs.view")
      .length,
    1,
  );
});

test("a cursor whose Pod is gone starts a new audited view of the Pod that is read", async () => {
  const fixture = await createRuntimeLogFixture();
  const target = await fixture.deployAgent();
  const state = fixture.computeDriver.state;
  state.lines = [runtimeLogLine(1)];
  const replacement = "gateway-replacement-0";
  state.extraPods = [{ name: replacement, uid: "4a1b2c3d-0000-4000-8000-000000000002" }];
  const views = () =>
    fixture.auditSink.events.filter(({ action }) => action === "openclaw.agents.runtime_logs.view");

  const first = await fixture.request("GET", target.logsPath(`source=gateway&pod=${replacement}`));
  assert.equal(first.status, 200, first.text);
  assert.equal(views().length, 1);
  assert.equal(views()[0].details.runtimeLogs.pod, replacement);

  // The cursor's Pod disappears; the next poll falls back to the remaining Pod.
  state.extraPods = [];
  const next = await fixture.request(
    "GET",
    target.logsPath(`source=gateway&cursor=${encodeURIComponent(first.data.cursor)}`),
  );
  assert.equal(next.status, 200, next.text);
  assert.equal(next.data.records[0].reason, "stream_replaced");
  const primary = fixture.computeDriver.podName({ id: target.revisionId });
  assert.equal(next.data.stream.pod, primary);
  assert.equal(views().length, 2, "reading another Pod is a new view");
  assert.equal(views()[1].details.runtimeLogs.pod, primary);
  assert.notEqual(views()[1].details.runtimeLogs.viewId, views()[0].details.runtimeLogs.viewId);

  // Polls of the new view are not re-audited.
  const again = await fixture.request(
    "GET",
    target.logsPath(`source=gateway&cursor=${encodeURIComponent(next.data.cursor)}`),
  );
  assert.equal(again.status, 200, again.text);
  assert.equal(views().length, 2);
});

test("runtime routes reject the Agent draft and unknown revisions without a Driver call", async () => {
  const fixture = await createRuntimeLogFixture();
  const target = await fixture.deployAgent();
  fixture.computeDriver.calls.length = 0;
  const base = `/namespaces/${target.namespace.id}/agents/${target.agent.id}/deployments`;
  const unknown = target.revisionId.replace(/[0-9a-f]{12}$/, "000000000000");
  // The editable draft is not a revision: its id fails the route contract.
  for (const [revision, status, code] of [
    ["draft", 400, "INVALID_REQUEST"],
    [unknown, 404, "NOT_FOUND"],
  ]) {
    for (const path of [
      `${base}/${revision}/runtime`,
      `${base}/${revision}/runtime/logs?source=gateway`,
    ]) {
      const response = await fixture.request("GET", path);
      assert.equal(response.status, status, `${path}: ${response.text}`);
      assert.equal(response.body.error.code, code);
    }
  }
  assert.equal(fixture.computeDriver.calls.length, 0);
});

test("log polls describe only the requested source and skip Event lists", async () => {
  const fixture = await createRuntimeLogFixture();
  const target = await fixture.deployAgent();
  fixture.computeDriver.state.lines = [runtimeLogLine(1)];
  fixture.computeDriver.state.events = [
    {
      type: "Warning",
      reason: "BackOff",
      message: "Back-off restarting failed container",
      count: 1,
      lastObservedAt: "2026-09-30T11:59:00Z",
    },
  ];
  const status = await fixture.request("GET", target.runtimePath);
  assert.equal(status.status, 200, status.text);
  assert.equal(status.data.pods[0].events.length, 1);
  const logs = await fixture.request("GET", target.logsPath());
  assert.equal(logs.status, 200, logs.text);
  const describes = fixture.computeDriver.calls.filter(({ operation }) => operation === "describe");
  assert.deepEqual(
    describes.map(({ options }) => options),
    [{}, { source: "gateway", events: false }],
  );
});

test("runtime log failures are fixed, content-free and never read after an audit failure", async () => {
  const auditSink = new InMemoryAuditSink();
  const append = auditSink.append.bind(auditSink);
  let failViews = true;
  auditSink.append = async (event) => {
    if (
      failViews &&
      (event.action === "openclaw.agents.runtime_logs.view" ||
        event.action === "openclaw.agents.runtime_logs.download")
    ) {
      throw new Error("audit store unavailable");
    }
    await append(event);
  };
  const fixture = await createRuntimeLogFixture({ auditSink });
  const target = await fixture.deployAgent();
  fixture.computeDriver.state.lines = [runtimeLogLine(1, "must not be returned")];

  const unaudited = await fixture.request("GET", target.logsPath());
  assert.equal(unaudited.status, 503);
  assert.equal(unaudited.body.error.code, "RUNTIME_LOGS_AUDIT_UNAVAILABLE");
  assert.equal(unaudited.text.includes("must not be returned"), false);
  const undownloaded = await fixture.request(
    "GET",
    target.logsPath("source=gateway&download=true"),
  );
  assert.equal(undownloaded.status, 503);
  assert.equal(undownloaded.body.error.code, "RUNTIME_LOGS_AUDIT_UNAVAILABLE");
  assert.equal(undownloaded.text.includes("must not be returned"), false);
  assert.equal(driverReads(fixture).length, 0);
  failViews = false;

  const marker = `private-driver-detail-${randomUUID()}`;
  fixture.computeDriver.state.readError = new Error(marker);
  const failed = await fixture.request("GET", target.logsPath());
  assert.equal(failed.status, 503);
  assert.equal(failed.body.error.code, "RUNTIME_LOGS_UNAVAILABLE");
  assert.equal(failed.text.includes(marker), false);
  assert.equal(JSON.stringify(fixture.auditSink.events).includes(marker), false);

  fixture.computeDriver.state.readError = new RuntimeLogsForbiddenByClusterError();
  const rbac = await fixture.request("GET", target.logsPath());
  assert.equal(rbac.status, 503);
  assert.equal(rbac.body.error.code, "RUNTIME_LOGS_CLUSTER_RBAC");
  fixture.computeDriver.state.readError = undefined;

  fixture.computeDriver.state.describeError = new Error(marker);
  const status = await fixture.request("GET", target.runtimePath);
  assert.equal(status.status, 503);
  assert.equal(status.text.includes(marker), false);
  fixture.computeDriver.state.describeError = undefined;

  // A hostile Driver description naming a Pod outside the revision is rejected whole.
  fixture.computeDriver.state.extraPods = [{ name: "Not A Pod!", uid: "x" }];
  const hostile = await fixture.request("GET", target.runtimePath);
  assert.equal(hostile.status, 503);
  assert.equal(hostile.body.error.code, "RUNTIME_LOGS_UNAVAILABLE");
});

test("runtime log reads are rate limited per principal and Agent with Retry-After", async () => {
  const fixture = await createRuntimeLogFixture();
  const target = await fixture.deployAgent();
  let limited;
  for (let attempt = 0; attempt < 12 && limited === undefined; attempt += 1) {
    const response = await fixture.request("GET", target.runtimePath);
    if (response.status === 429) {
      limited = response;
    } else {
      assert.equal(response.status, 200, response.text);
    }
  }
  assert.ok(limited, "the burst of 10 is exhausted within 12 immediate requests");
  assert.equal(limited.body.error.code, "RUNTIME_LOGS_RATE_LIMITED");
  assert.match(limited.headers.get("retry-after") ?? "", /^[1-9][0-9]*$/);

  // Authorization runs before the limiter: an unauthorized principal past the burst is
  // still refused with 403 and audited every time, takes no token and never reaches the
  // Driver. (A limiter answering first would hide denials behind unaudited 429s.)
  const outsider = await fixture.createPrincipal("runtime-outsider", target, []);
  fixture.computeDriver.calls.length = 0;
  const deniedBefore = fixture.auditSink.events.filter(
    (event) => event.kind === "authorization_denial" && event.actorId === outsider.principal.id,
  ).length;
  const statuses = [];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    for (const path of [target.runtimePath, target.logsPath()]) {
      statuses.push((await fixture.request("GET", path, { session: outsider.session })).status);
    }
  }
  assert.deepEqual(new Set(statuses), new Set([403]));
  assert.equal(
    fixture.auditSink.events.filter(
      (event) => event.kind === "authorization_denial" && event.actorId === outsider.principal.id,
    ).length - deniedBefore,
    statuses.length,
  );
  assert.equal(fixture.computeDriver.calls.length, 0);
  // The denials took no token: once granted, the same principal still has its full burst.
  for (const grant of operateGrants) {
    const id = `runtime-outsider-${grant.resourceKind}-${grant.action}`;
    fixture.policy.roles.push({
      id,
      namespaceId: target.namespace.id,
      permissions: [{ action: grant.action, resourceKind: grant.resourceKind }],
    });
    fixture.policy.bindings.push({
      id,
      namespaceId: target.namespace.id,
      subjectKind: "identity",
      subjectId: outsider.principal.id,
      roleId: id,
      resourceKind: grant.resourceKind,
      resourceId: grant.resourceKind === "agent_revision" ? target.revisionId : target.agent.id,
    });
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const granted = await fixture.request("GET", target.runtimePath, {
      session: outsider.session,
    });
    assert.equal(granted.status, 200, granted.text);
  }
  const operator = await fixture.createPrincipal("runtime-limit-operator", target, operateGrants);
  const unaffected = await fixture.request("GET", target.runtimePath, {
    session: operator.session,
  });
  assert.equal(unaffected.status, 200, unaffected.text);
});

test("runtime routes answer 501 when the Driver, its logging owner or the operator switch opts out", async () => {
  for (const [label, options] of [
    [
      "driver-owned logging",
      { computeDriver: createRuntimeLogComputeDriver({ runtimeLogging: "driver" }) },
    ],
    [
      "no Driver method",
      { computeDriver: createRuntimeLogComputeDriver({ withoutDescribe: true }) },
    ],
    ["feature disabled", { agentRuntimeLogs: { enabled: false, cursorSecret: "x".repeat(32) } }],
  ]) {
    const fixture = await createRuntimeLogFixture(options);
    const target = await fixture.deployAgent();
    for (const path of [target.runtimePath, target.logsPath()]) {
      const response = await fixture.request("GET", path);
      assert.equal(response.status, 501, `${label}: ${path}`);
      assert.equal(response.body.error.code, "NOT_IMPLEMENTED");
    }
    assert.equal(fixture.computeDriver.calls.length, 0, label);
    if (label === "feature disabled") {
      // The operator switch is checked before authorization (documented), so a
      // principal without grants learns only that the feature is off.
      const outsider = await fixture.createPrincipal("runtime-disabled-outsider", target, []);
      const response = await fixture.request("GET", target.runtimePath, {
        session: outsider.session,
      });
      assert.equal(response.status, 501);
      assert.equal(fixture.computeDriver.calls.length, 0);
    }
  }
});

test("runtime log downloads use the log tier and are audited once per download", async () => {
  const fixture = await createRuntimeLogFixture();
  const target = await fixture.deployAgent();
  fixture.computeDriver.state.lines = [
    runtimeLogLine(1),
    runtimeLogLine(2, '{"level":"warn","message":"slow start","subsystem":"gateway","status":503}'),
  ];
  const operator = await fixture.createPrincipal("download-operator", target, operateGrants);
  const administrator = await fixture.createPrincipal(
    "download-administrator",
    target,
    administerGrants,
  );
  const downloads = () =>
    fixture.auditSink.events.filter(
      ({ action }) => action === "openclaw.agents.runtime_logs.download",
    );
  const views = () =>
    fixture.auditSink.events.filter(({ action }) => action === "openclaw.agents.runtime_logs.view");
  fixture.computeDriver.calls.length = 0;

  // Status access is not enough; the denial never reaches the Driver.
  const denied = await fixture.request("GET", target.logsPath("source=gateway&download=true"), {
    session: operator.session,
  });
  assert.equal(denied.status, 403);
  assert.equal(fixture.auditSink.events.at(-1).kind, "authorization_denial");
  assert.equal(fixture.auditSink.events.at(-1).authorization.action, "read_logs");
  // The denial names the download, not a view.
  assert.equal(fixture.auditSink.events.at(-1).action, "openclaw.agents.runtime_logs.download");
  assert.equal(driverReads(fixture).length, 0);
  const deniedDownloads = downloads().length;

  const path = target.logsPath("source=gateway&tailLines=5&download=true");
  const first = await fixture.request("GET", path, { session: administrator.session });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(first.headers.get("cache-control"), "no-store");
  const pod = fixture.computeDriver.podName({ id: target.revisionId });
  assert.equal(
    first.headers.get("content-disposition"),
    `attachment; filename="${target.agent.id}-${target.revisionId}-gateway-${pod}.log"`,
  );
  const lines = first.text.trimEnd().split("\n");
  assert.match(lines[0], new RegExp(`^# agent=${target.agent.id} revision=${target.revisionId}`));
  assert.deepEqual(lines.slice(1), [
    `${runtimeLogLine(1).time} UNKNOWN text gateway output 1`,
    `${runtimeLogLine(2).time} WARN openclaw [gateway] slow start status=503`,
  ]);
  // A download always reads the maximum tail, whatever the caller asked for.
  assert.equal(driverReads(fixture).at(-1).tailLines, 1000);

  await fixture.request("GET", path, { session: administrator.session });
  const granted = () => downloads().filter(({ kind }) => kind === "access");
  assert.equal(downloads().length, deniedDownloads + 2);
  assert.equal(granted().length, 2, "every download is audited");
  assert.equal(views().length, 0, "a download is not a view");
  const [audit] = granted();
  assert.equal(audit.kind, "access");
  assert.equal(audit.actor.principalId, administrator.principal.id);
  assert.equal(audit.details.runtimeLogs.tailLines, 1000);
  assert.equal(audit.details.runtimeLogs.pod, pod);
  assert.equal(JSON.stringify(audit).includes("slow start"), false);

  // A download is a fresh snapshot and never continues a view.
  const page = await fixture.request("GET", target.logsPath(), { session: administrator.session });
  const readsBefore = driverReads(fixture).length;
  const withCursor = await fixture.request(
    "GET",
    target.logsPath(`source=gateway&download=true&cursor=${encodeURIComponent(page.data.cursor)}`),
    { session: administrator.session },
  );
  assert.equal(withCursor.status, 400);
  assert.equal(withCursor.body.error.code, "INVALID_REQUEST");
  assert.equal(driverReads(fixture).length, readsBefore);
  assert.equal(granted().length, 2);

  // Failures stay JSON errors with fixed text.
  fixture.computeDriver.state.readError = new RuntimeLogsForbiddenByClusterError();
  const rbac = await fixture.request("GET", path, { session: administrator.session });
  assert.equal(rbac.status, 503);
  assert.equal(rbac.body.error.code, "RUNTIME_LOGS_CLUSTER_RBAC");
});
