import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { resolveApprovedHarness as resolveApprovedDevelopmentHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createControllerApp } from "../../apps/controller/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  BOOTSTRAP_DEFAULT_NAMESPACE_NAME,
  InMemoryPlatformState,
  OpenClawController,
} from "../../packages/occ/src/index.ts";
import {
  authenticatedHeaders,
  createTestAuthPrincipal,
  signInToControllerApp,
} from "../helpers/auth-session.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";

const installationId = "ins_3033697e-6397-4cc6-9b04-8ec17af78cf1";
const missingRevisionId = "rev_3dd29693-ce8b-4b4c-97c4-14b4c68c6e9c";
const bootstrapDefaultNamespaceId = "ns_00000000-0000-4000-8000-000000000001";
const tenantANamespaceId = "ns_00000000-0000-4000-8000-000000000002";

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

async function createFixture(options = {}) {
  const adminAuth = await createTestAuthPrincipal({
    installationId,
    name: "Security Administrator",
  });
  const administrator = adminAuth.seed.principal;
  const readerEmail = `tenant-a-reader-${randomUUID()}@example.com`;
  const readerPassword = `generated-password-${randomUUID()}`;
  const readerAccount = await adminAuth.auth.createAccount({
    email: readerEmail,
    password: readerPassword,
    name: "Tenant A Reader",
  });
  const readerSeed = adminAuth.auth.principalSeed(readerAccount);
  const tenantAReader = readerSeed.principal;
  const identities = options.identities ?? [administrator, tenantAReader];
  const identityIds = new Set(identities.map(({ id }) => id));
  const state = {
    identities,
    groups: [],
    memberships: [],
    roles: [
      {
        id: "role-administrator",
        permissions: [...permissions],
      },
      {
        id: "role-tenant-a-reader",
        namespaceId: tenantANamespaceId,
        permissions: [
          { action: "read", resourceKind: "namespace" },
          { action: "read", resourceKind: "agent" },
          { action: "read", resourceKind: "agent_revision" },
        ],
      },
    ],
    bindings: [
      {
        id: "binding-administrator",
        subjectKind: "identity",
        subjectId: administrator.id,
        roleId: "role-administrator",
      },
      {
        id: "binding-tenant-a-reader",
        namespaceId: tenantANamespaceId,
        subjectKind: "identity",
        subjectId: tenantAReader.id,
        roleId: "role-tenant-a-reader",
      },
    ].filter(({ subjectId }) => identityIds.has(subjectId)),
    restrictions: options.restrictions ?? [],
  };
  const iamDriver = new NativeIAMDriver(
    { loadNativeIAMState: async () => state },
    { id: "iam-security" },
  );
  const computeDriver = {
    id: "compute-security",
    capability: "compute",
    implementation: "deterministic-test",
    async ensureNamespace(namespace) {
      return {
        namespaceId: namespace.id,
        namespaceReady: true,
      };
    },
    async deleteNamespace(namespace) {
      return {
        namespaceId: namespace.id,
        namespaceDeleted: true,
      };
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
  };
  const auditSink = new InMemoryAuditSink();
  const configurationDriver = createTestConfigurationDriver({ id: "configuration-security" });
  const sessions = new Map();
  let controller;
  let sequence = 0;
  let configurationSequence = 0;

  function createApp(principal = administrator, overrides = {}, factory = createControllerApp) {
    const app = factory({
      ...(controller
        ? { controller }
        : {
            createController(installation) {
              controller = new OpenClawController(installation, {
                state: new InMemoryPlatformState({ auditSink }),
                recordOperations: false,
                createId(kind) {
                  if (kind === "configuration") {
                    configurationSequence += 1;
                    return `cfg_10000000-0000-4000-8000-${String(configurationSequence).padStart(12, "0")}`;
                  }
                  sequence += 1;
                  const prefix = {
                    namespace: "ns",
                    agent: "agt",
                    agent_revision: "rev",
                  }[kind];
                  return `${prefix}_00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
                },
              });
              return controller;
            },
          }),
      iamDriver,
      computeDriver,
      configurationDriver,
      resolveHarness: resolveApprovedDevelopmentHarness,
      auditSink,
      development: {
        enabled: true,
        installationId,
        ...overrides.development,
      },
      auth: adminAuth.auth,
      ...(overrides.maxBodyBytes === undefined ? {} : { maxBodyBytes: overrides.maxBodyBytes }),
      ...(overrides.gatewayRequestTimeoutMs === undefined
        ? {}
        : { gatewayRequestTimeoutMs: overrides.gatewayRequestTimeoutMs }),
      ...(overrides.publicOrigin === undefined ? {} : { publicOrigin: overrides.publicOrigin }),
    });
    app.defaultSession = sessions.get(principal.id);
    return app;
  }

  const app = createApp(administrator, options);
  sessions.set(administrator.id, await signInToControllerApp(app, adminAuth));
  sessions.set(
    tenantAReader.id,
    await signInToControllerApp(app, { email: readerEmail, password: readerPassword }),
  );
  app.defaultSession = sessions.get(administrator.id);

  return {
    app,
    administrator,
    tenantAReader,
    auditSink,
    createApp,
    auth: adminAuth.auth,
    iamDriver,
    state,
    get controller() {
      return controller;
    },
  };
}

async function request(app, pathname, options = {}) {
  const headers = new Headers(
    options.identity === false ? {} : authenticatedHeaders(options.session ?? app.defaultSession),
  );

  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === null) {
      headers.delete(name);
    } else {
      headers.set(name, value);
    }
  }

  const hasBody = Object.hasOwn(options, "body");
  if (hasBody && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const body = hasBody
    ? typeof options.body === "string"
      ? options.body
      : JSON.stringify(options.body)
    : undefined;
  const response = await app.fetch(
    new Request(new URL(pathname, options.origin ?? "http://127.0.0.1"), {
      method: options.method ?? (hasBody ? "POST" : "GET"),
      headers,
      ...(body === undefined ? {} : { body }),
    }),
  );
  const contentType = response.headers.get("content-type");
  assert.match(contentType ?? "", /^application\/json\b/i);
  const payload = await response.json();
  assert.match(
    payload.meta?.requestId ?? "",
    /^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );

  if (response.ok) {
    assert.ok(Object.hasOwn(payload, "data"));
  } else {
    assert.equal(typeof payload.error?.code, "string");
    assert.equal(typeof payload.error?.message, "string");
  }

  return { response, payload };
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

  // Even an administrator cannot silently adopt through Docker or another unsupported Driver.
  const unsupported = await request(fixture.app, "/namespaces", {
    body: { name: "Unsupported adoption", existingNamespace: "operator-owned" },
  });
  assert.equal(unsupported.response.status, 409);
  assert.equal(unsupported.payload.error.code, "RESOURCE_CONFLICT");

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
});

test("Agent configuration replacement requires exact Agent update authorization and keeps identity private", async () => {
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
  assert.equal(Object.hasOwn(updated.payload.data, "servicePrincipalId"), false);

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
  assert.deepEqual(fixture.controller.pendingOperations(), []);
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
    throw new Error(`Provider credentials failed: ${secret}`);
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
