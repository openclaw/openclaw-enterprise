import assert from "node:assert/strict";
import test from "node:test";
import { ControllerWorkspaceFileUnknownOutcomeError } from "../../apps/controller/src/gateway/contracts.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import {
  createTenantReaderFixture,
  tenantRequest as request,
} from "../helpers/tenant-reader-app.mjs";

const installationId = "ins_4033697e-6397-4cc6-9b04-8ec17af78cf1";
const publicOrigin = "http://127.0.0.1";

const administratorPermissions = [
  { action: "administer", resourceKind: "installation" },
  { action: "read", resourceKind: "installation" },
  { action: "create", resourceKind: "namespace" },
  { action: "read", resourceKind: "namespace" },
  { action: "create", resourceKind: "configuration" },
  { action: "read", resourceKind: "configuration" },
  { action: "create", resourceKind: "secret" },
  { action: "operate", resourceKind: "secret" },
  { action: "create", resourceKind: "agent" },
  { action: "read", resourceKind: "agent" },
  { action: "update", resourceKind: "agent" },
  { action: "deploy", resourceKind: "agent" },
  { action: "operate", resourceKind: "agent" },
  { action: "read", resourceKind: "agent_revision" },
];

function createFixture(options = {}) {
  return createTenantReaderFixture({
    installationId,
    label: "workspace-files",
    administratorName: "Workspace file administrator",
    readerName: "Workspace file reader",
    administratorPermissions,
    computeDriver: {
      ...createDevelopmentComputeDriver(),
      id: "compute-workspace-files",
      implementation: "deterministic-test",
    },
    secretDriver: createTestSecretDriver(),
    appOptions: (overrides) => ({
      workspaceFilesAccess:
        overrides.workspaceFilesAccess === undefined
          ? options.workspaceFilesAccess
          : overrides.workspaceFilesAccess,
      ...(overrides.workspaceFileRequestTimeoutMs === undefined
        ? {}
        : { workspaceFileRequestTimeoutMs: overrides.workspaceFileRequestTimeoutMs }),
      ...(overrides.maxBodyBytes === undefined ? {} : { maxBodyBytes: overrides.maxBodyBytes }),
      publicOrigin: overrides.publicOrigin === undefined ? publicOrigin : overrides.publicOrigin,
    }),
    options,
  });
}

async function bootstrap(fixture) {
  const result = await request(fixture.app, "/installation/bootstrap", {
    body: { name: "Workspace file test installation" },
  });
  assert.equal(result.response.status, 201);
}

async function createNamespace(fixture, name) {
  const result = await request(fixture.app, "/namespaces", { body: { name } });
  assert.equal(result.response.status, 201);
  await fixture.controller.transact((unit) =>
    unit.namespaces.transitionNamespaceStatus(result.payload.data.id, "provisioning", "ready"),
  );
  return result.payload.data;
}

async function createAgent(fixture, namespace, name) {
  const configuration = await request(fixture.app, `/namespaces/${namespace.id}/configurations`, {
    body: { kind: "agent", values: {} },
  });
  assert.equal(configuration.response.status, 201);
  const secret = await fixture.controller.createSecret(fixture.administrator.id, {
    namespaceId: namespace.id,
    name: `key-${name}`,
    value: "synthetic-workspace-model-key",
  });
  const created = await request(fixture.app, `/namespaces/${namespace.id}/agents`, {
    body: {
      name,
      configurationId: configuration.payload.data.id,
      harnessAuth: { method: "api_key", source: secret.ref },
    },
  });
  assert.equal(created.response.status, 201);
  // Workspace routes require an admitted Agent, with its own exact credential grant.
  const agent = await fixture.controller.getAgent(
    fixture.administrator.id,
    namespace.id,
    created.payload.data.id,
  );
  fixture.state.identities.push({
    kind: "service_principal",
    id: agent.servicePrincipalId,
    namespaceId: namespace.id,
    agentId: agent.id,
  });
  fixture.state.roles.push({
    id: `model-${agent.id}`,
    permissions: [{ action: "operate", resourceKind: "secret" }],
  });
  fixture.state.bindings.push({
    id: `model-${agent.id}`,
    subjectKind: "identity",
    subjectId: agent.servicePrincipalId,
    roleId: `model-${agent.id}`,
    namespaceId: namespace.id,
    resourceKind: "secret",
    resourceId: secret.id,
  });
  const deployed = await request(
    fixture.app,
    `/namespaces/${namespace.id}/agents/${created.payload.data.id}/deploy`,
    { method: "POST" },
  );
  assert.equal(deployed.response.status, 202);
  await fixture.controller.transact((unit) =>
    unit.agents.compareAndSetActiveRevision(
      namespace.id,
      created.payload.data.id,
      undefined,
      deployed.payload.data.id,
    ),
  );
  return { agent: created.payload.data, revision: deployed.payload.data };
}

function fileAudits(fixture) {
  return fixture.auditSink.events.filter((event) =>
    event.action.startsWith("openclaw.agents.workspace.files."),
  );
}

test("Agent workspace file routes read and replace fixed files through the selected active Agent", async () => {
  const reads = [];
  const writes = [];
  const workspaceFilesAccess = {
    async read(read) {
      reads.push(read);
      assert.equal(read.signal.aborted, false);
      assert.ok(read.deadline instanceof Date);
      return {
        status: "ok",
        file: { name: read.filename, content: `content from ${read.revision.agentId}\n` },
      };
    },
    async write(write) {
      writes.push(write);
      assert.equal(write.signal.aborted, false);
      assert.ok(write.deadline instanceof Date);
      return { status: "ok", file: { name: write.filename, size: 100_000 } };
    },
  };
  const fixture = await createFixture({ workspaceFilesAccess });
  await bootstrap(fixture);
  const namespace = await createNamespace(fixture, "Workspace file tenant");
  const first = await createAgent(fixture, namespace, "First workspace Agent");
  const second = await createAgent(fixture, namespace, "Second workspace Agent");

  const read = await request(
    fixture.app,
    `/namespaces/${namespace.id}/agents/${second.agent.id}/workspace/files/USER.md`,
  );
  assert.equal(read.response.status, 200);
  assert.deepEqual(read.payload.data, {
    name: "USER.md",
    content: `content from ${second.agent.id}\n`,
  });

  const write = await request(
    fixture.app,
    `/namespaces/${namespace.id}/agents/${second.agent.id}/workspace/files/SOUL.md`,
    {
      method: "PUT",
      headers: { origin: publicOrigin },
      body: { content: "new soul\n" },
    },
  );
  assert.equal(write.response.status, 200);
  assert.deepEqual(write.payload.data, { name: "SOUL.md", size: 9 });

  assert.equal(reads.length, 1);
  assert.equal(reads[0].revision.id, second.revision.id);
  assert.equal(reads[0].revision.agentId, second.agent.id);
  assert.equal(reads[0].filename, "USER.md");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].revision.id, second.revision.id);
  assert.equal(writes[0].revision.agentId, second.agent.id);
  assert.equal(writes[0].filename, "SOUL.md");
  assert.equal(writes[0].content, "new soul\n");
  assert.notEqual(reads[0].revision.agentId, first.agent.id);

  const audits = fileAudits(fixture);
  assert.deepEqual(
    audits.map(({ action, outcome, reasonCode, resource, authorization, details }) => ({
      action,
      outcome,
      reasonCode,
      resource,
      authorizationAction: authorization.action,
      workspaceFileName: details.workspaceFileName,
    })),
    [
      {
        action: "openclaw.agents.workspace.files.write",
        outcome: "success",
        reasonCode: undefined,
        resource: { kind: "agent", id: second.agent.id, namespaceId: namespace.id },
        authorizationAction: "operate",
        workspaceFileName: "SOUL.md",
      },
    ],
  );
  assert.equal(JSON.stringify(audits).includes("content from"), false);
  assert.equal(JSON.stringify(audits).includes("new soul"), false);
});

test("Agent workspace file routes enforce read and operate permissions separately", async () => {
  const workspaceFilesAccess = {
    async read(read) {
      return { status: "ok", file: { name: read.filename, content: "readable\n" } };
    },
    async write() {
      throw new Error("read-only caller must not reach workspace file write");
    },
  };
  const fixture = await createFixture({ workspaceFilesAccess });
  await bootstrap(fixture);
  const namespace = await createNamespace(fixture, "Reader tenant");
  const { agent } = await createAgent(fixture, namespace, "Reader visible Agent");
  const reader = fixture.createApp(fixture.tenantAReader);

  const readable = await request(
    reader,
    `/namespaces/${namespace.id}/agents/${agent.id}/workspace/files/AGENTS.md`,
  );
  assert.equal(readable.response.status, 200);
  assert.deepEqual(readable.payload.data, { name: "AGENTS.md", content: "readable\n" });

  const denied = await request(
    reader,
    `/namespaces/${namespace.id}/agents/${agent.id}/workspace/files/AGENTS.md`,
    {
      method: "PUT",
      headers: { origin: publicOrigin },
      body: { content: "cannot write\n" },
    },
  );
  assert.equal(denied.response.status, 403);
  assert.equal(denied.payload.error.code, "FORBIDDEN");
  assert.equal(fixture.auditSink.events.at(-1).kind, "authorization_denial");
  assert.equal(fixture.auditSink.events.at(-1).authorization.action, "operate");
  assert.deepEqual(fixture.auditSink.events.at(-1).resource, {
    kind: "agent",
    id: agent.id,
    namespaceId: namespace.id,
  });
});

test("Agent workspace file routes reject invalid names, bodies, and cross-site writes before provider access", async () => {
  const calls = [];
  const fixture = await createFixture({
    workspaceFilesAccess: {
      async read(read) {
        calls.push(["read", read]);
        return { status: "ok", file: { name: read.filename, content: "" } };
      },
      async write(write) {
        calls.push(["write", write]);
        return { status: "ok", file: { name: write.filename, size: 0 } };
      },
    },
  });
  await bootstrap(fixture);
  const namespace = await createNamespace(fixture, "Validation tenant");
  const { agent } = await createAgent(fixture, namespace, "Validated Agent");
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/workspace/files`;

  const invalidName = await request(fixture.app, `${path}/README.md`);
  assert.equal(invalidName.response.status, 400);
  assert.equal(invalidName.payload.error.code, "INVALID_REQUEST");

  const crossSite = await request(fixture.app, `${path}/USER.md`, {
    method: "PUT",
    headers: { origin: publicOrigin, "sec-fetch-site": "cross-site" },
    body: { content: "blocked\n" },
  });
  assert.equal(crossSite.response.status, 403);
  assert.equal(crossSite.payload.error.code, "FORBIDDEN");
  // Session admission refuses cross-site writes too; for reads the route's own check is the
  // only one, so a cross-site page cannot read Agent files with the browser's credentials.
  for (const site of ["cross-site", "Cross-Site"]) {
    const crossSiteRead = await request(fixture.app, `${path}/USER.md`, {
      headers: { "sec-fetch-site": site },
    });
    assert.equal(crossSiteRead.response.status, 403, site);
    assert.equal(crossSiteRead.payload.error.code, "FORBIDDEN", site);
  }

  const missingContent = await request(fixture.app, `${path}/USER.md`, {
    method: "PUT",
    headers: { origin: publicOrigin },
    body: {},
  });
  assert.equal(missingContent.response.status, 400);

  const unknownField = await request(fixture.app, `${path}/USER.md`, {
    method: "PUT",
    headers: { origin: publicOrigin },
    body: { content: "ok\n", agentId: "caller-selected-native-id" },
  });
  assert.equal(unknownField.response.status, 400);

  const nul = await request(fixture.app, `${path}/USER.md`, {
    method: "PUT",
    headers: { origin: publicOrigin },
    body: { content: "bad\u0000value" },
  });
  assert.equal(nul.response.status, 400);
  assert.deepEqual(nul.payload.error.details, [{ path: "/content", code: "INVALID_FORMAT" }]);

  const unpairedSurrogate = await request(fixture.app, `${path}/USER.md`, {
    method: "PUT",
    headers: { origin: publicOrigin },
    body: String.raw`{"content":"\ud800"}`,
  });
  assert.equal(unpairedSurrogate.response.status, 400);
  assert.deepEqual(unpairedSurrogate.payload.error.details, [
    { path: "/content", code: "INVALID_VALUE" },
  ]);

  const tooLong = await request(fixture.app, `${path}/USER.md`, {
    method: "PUT",
    headers: { origin: publicOrigin },
    body: { content: "x".repeat(16 * 1024 + 1) },
  });
  assert.equal(tooLong.response.status, 400);
  assert.equal(
    tooLong.payload.error.details.some((detail) => detail.code === "TOO_LONG"),
    true,
  );

  const encodedTooLarge = await request(fixture.app, `${path}/USER.md`, {
    method: "PUT",
    headers: { origin: publicOrigin, "content-length": String(54_014) },
    body: `{"content":"${String.raw`\u0061`.repeat(9_000)}"}`,
  });
  assert.equal(encodedTooLarge.response.status, 413);
  assert.equal(encodedTooLarge.payload.error.code, "PAYLOAD_TOO_LARGE");
  assert.deepEqual(calls, []);
});

test("Agent workspace file routes map provider file states without leaking content in audit", async () => {
  const fixture = await createFixture({
    workspaceFilesAccess: {
      async read(read) {
        if (read.filename === "SOUL.md") {
          return { status: "missing" };
        }
        return { status: "unavailable" };
      },
      async write() {
        return { status: "unavailable" };
      },
    },
  });
  await bootstrap(fixture);
  const namespace = await createNamespace(fixture, "Provider state tenant");
  const { agent } = await createAgent(fixture, namespace, "Provider state Agent");

  const missing = await request(
    fixture.app,
    `/namespaces/${namespace.id}/agents/${agent.id}/workspace/files/SOUL.md`,
  );
  assert.equal(missing.response.status, 404);
  assert.equal(missing.payload.error.code, "NOT_FOUND");

  const readUnavailable = await request(
    fixture.app,
    `/namespaces/${namespace.id}/agents/${agent.id}/workspace/files/IDENTITY.md`,
  );
  assert.equal(readUnavailable.response.status, 503);
  assert.equal(readUnavailable.payload.error.code, "DEPENDENCY_UNAVAILABLE");

  const writeUnavailable = await request(
    fixture.app,
    `/namespaces/${namespace.id}/agents/${agent.id}/workspace/files/USER.md`,
    {
      method: "PUT",
      headers: { origin: publicOrigin },
      body: { content: "secret-ish replacement\n" },
    },
  );
  assert.equal(writeUnavailable.response.status, 503);
  assert.equal(writeUnavailable.payload.error.code, "DEPENDENCY_UNAVAILABLE");

  const audits = fileAudits(fixture);
  assert.equal(JSON.stringify(audits).includes("secret-ish"), false);
  assert.deepEqual(
    audits.map(({ action, outcome, reasonCode, details }) => [
      action,
      outcome,
      reasonCode,
      details.workspaceFileName,
    ]),
    [["openclaw.agents.workspace.files.write", "failure", "DEPENDENCY_UNAVAILABLE", "USER.md"]],
  );
});

// Exercise an uncertain write together with a stalled audit sink. The provider is
// simulated here; this test does not perform or verify a real gateway file write.
test("Agent workspace file unknown outcomes stay bounded when audit persistence stalls", async () => {
  const writes = [];
  const fixture = await createFixture({
    workspaceFilesAccess: {
      async read() {
        throw new Error("not used");
      },
      async write(write) {
        writes.push(write);
        // Model a dispatched write whose acknowledgement was lost: it may have succeeded.
        throw new ControllerWorkspaceFileUnknownOutcomeError("workspace write sent before timeout");
      },
    },
    workspaceFileRequestTimeoutMs: 20,
  });
  await bootstrap(fixture);
  const namespace = await createNamespace(fixture, "Unknown write tenant");
  const { agent } = await createAgent(fixture, namespace, "Unknown write Agent");
  const append = fixture.auditSink.append.bind(fixture.auditSink);
  fixture.auditSink.append = async (event) => {
    // Stall before storing the event, so the API must bound its audit attempt too.
    if (event.action === "openclaw.agents.workspace.files.write") {
      await new Promise(() => {});
    }
    await append(event);
  };

  const startedAt = Date.now();
  const result = await request(
    fixture.app,
    `/namespaces/${namespace.id}/agents/${agent.id}/workspace/files/USER.md`,
    {
      method: "PUT",
      headers: { origin: publicOrigin },
      body: { content: "sent once\n" },
    },
  );
  const elapsedMs = Date.now() - startedAt;

  // Report uncertainty rather than claiming success or a definite write failure.
  assert.equal(result.response.status, 503);
  assert.equal(result.payload.error.code, "UNKNOWN_OUTCOME");
  // The 20 ms deadline must release the request; 2 seconds allows scheduling slack.
  assert.ok(
    elapsedMs < 2_000,
    `expected stalled audit to be deadline-bounded, took ${elapsedMs}ms`,
  );
  // OCC must not replay a mutation that may already have succeeded.
  assert.equal(writes.length, 1);
  assert.equal(writes[0].content, "sent once\n");
  // Error responses must not echo operator-supplied file contents.
  assert.equal(JSON.stringify(result.payload).includes("sent once"), false);
});

test("Agent workspace file requests are bounded before and during provider access", async () => {
  const preAccess = await createFixture({
    workspaceFilesAccess: {
      async read() {
        throw new Error("active revision lookup should time out before provider read");
      },
      async write() {
        throw new Error("not used");
      },
    },
    workspaceFileRequestTimeoutMs: 5,
  });
  await bootstrap(preAccess);
  const preNamespace = await createNamespace(preAccess, "Pre-access deadline tenant");
  const preAgent = await createAgent(preAccess, preNamespace, "Pre-access deadline Agent");
  preAccess.controller.getReadableActiveAgentRevision = async () => new Promise(() => {});

  const startedBeforeRead = Date.now();
  const read = await request(
    preAccess.app,
    `/namespaces/${preNamespace.id}/agents/${preAgent.agent.id}/workspace/files/AGENTS.md`,
  );
  const readElapsedMs = Date.now() - startedBeforeRead;
  assert.equal(read.response.status, 503);
  assert.equal(read.payload.error.code, "DEPENDENCY_UNAVAILABLE");
  assert.ok(readElapsedMs < 2_000, `expected pre-access deadline, took ${readElapsedMs}ms`);
  assert.deepEqual(fileAudits(preAccess), []);

  const writes = [];
  const providerAccess = await createFixture({
    workspaceFilesAccess: {
      async read() {
        throw new Error("not used");
      },
      async write(write) {
        writes.push(write);
        await new Promise(() => {});
      },
    },
    workspaceFileRequestTimeoutMs: 5,
  });
  await bootstrap(providerAccess);
  const providerNamespace = await createNamespace(providerAccess, "Provider deadline tenant");
  const providerAgent = await createAgent(
    providerAccess,
    providerNamespace,
    "Provider deadline Agent",
  );

  const appendAfterTimeout = providerAccess.auditSink.append.bind(providerAccess.auditSink);
  providerAccess.auditSink.append = async (event) => {
    await appendAfterTimeout(event);
    if (event.action === "openclaw.agents.workspace.files.write") {
      throw new Error("Audit acknowledgement failed after the request deadline.");
    }
  };

  const startedBeforeWrite = Date.now();
  const write = await request(
    providerAccess.app,
    `/namespaces/${providerNamespace.id}/agents/${providerAgent.agent.id}/workspace/files/USER.md`,
    {
      method: "PUT",
      headers: { origin: publicOrigin },
      body: { content: "deadline write\n" },
    },
  );
  const writeElapsedMs = Date.now() - startedBeforeWrite;
  assert.equal(write.response.status, 503);
  assert.equal(write.payload.error.code, "UNKNOWN_OUTCOME");
  assert.ok(writeElapsedMs < 2_000, `expected provider deadline, took ${writeElapsedMs}ms`);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].signal.aborted, true);
  assert.deepEqual(
    fileAudits(providerAccess).map(({ outcome, reasonCode, details }) => [
      outcome,
      reasonCode,
      details.workspaceFileName,
    ]),
    [["failure", "UNKNOWN_OUTCOME", "USER.md"]],
  );
});

test("Agent workspace file read aborts provider access on real HTTP client disconnect", async (context) => {
  let enteredRead;
  const readEntered = new Promise((resolve) => {
    enteredRead = resolve;
  });
  let observedAbort;
  const readAborted = new Promise((resolve) => {
    observedAbort = resolve;
  });
  const reads = [];
  const workspaceFilesAccess = {
    async read(read) {
      reads.push(read);
      enteredRead(read);
      if (read.signal.aborted) {
        observedAbort(read);
      } else {
        read.signal.addEventListener("abort", () => observedAbort(read), { once: true });
      }
      await readAborted;
      return { status: "ok", file: { name: read.filename, content: "late\n" } };
    },
    async write() {
      throw new Error("not used");
    },
  };
  const fixture = await createFixture({ workspaceFilesAccess });
  await bootstrap(fixture);
  const namespace = await createNamespace(fixture, "Disconnect tenant");
  const { agent } = await createAgent(fixture, namespace, "Disconnect Agent");
  const app = fixture.createApp(fixture.administrator, { workspaceFilesAccess }, createFastifyApp);
  context.after(async () => {
    await app.close();
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const controller = new AbortController();
  const response = fetch(
    new URL(`/namespaces/${namespace.id}/agents/${agent.id}/workspace/files/USER.md`, address),
    {
      method: "GET",
      headers: authenticatedHeaders(fixture.app.defaultSession, { origin: publicOrigin }),
      signal: controller.signal,
    },
  );

  const read = await readEntered;
  assert.equal(read.signal.aborted, false);
  controller.abort();
  await assert.rejects(response, { name: "AbortError" });
  const abortedRead = await readAborted;
  assert.equal(abortedRead, read);
  assert.equal(read.signal.aborted, true);
  assert.equal(reads.length, 1);
});
