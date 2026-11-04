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
import { bindRole } from "../helpers/iam-grants.mjs";
import {
  workspaceVersionStarting,
  workspaceWithoutRunningVersion,
} from "../helpers/refusal-text.mjs";

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

// An app and two signed-in accounts cost far more than a case, so cases share one bootstrapped
// app and run one at a time. Each gets a new Namespace and Agent, its own workspace file
// provider (the app's forwards to the running case's) and the audit events since it started.
// An app with a shorter workspace file deadline is built once per deadline, on the same controller.
const running = {};
const deadlineApps = new Map();
let shared;

async function createFixture({ workspaceFilesAccess, workspaceFileRequestTimeoutMs: deadline }) {
  shared ??= createTenantReaderFixture({
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
      // An app built with `workspaceFilesUnconfigured` has no workspace file access at all.
      ...(overrides.workspaceFilesUnconfigured === true
        ? {}
        : {
            workspaceFilesAccess: {
              read: (read) => running.workspaceFilesAccess.read(read),
              write: (write) => running.workspaceFilesAccess.write(write),
            },
          }),
      ...(overrides.workspaceFileRequestTimeoutMs === undefined
        ? {}
        : { workspaceFileRequestTimeoutMs: overrides.workspaceFileRequestTimeoutMs }),
      publicOrigin,
    }),
  }).then(async (fixture) => {
    const result = await request(fixture.app, "/installation/bootstrap", {
      body: { name: "Workspace file test installation" },
    });
    assert.equal(result.response.status, 201);
    return fixture;
  });
  const fixture = await shared;
  running.workspaceFilesAccess = workspaceFilesAccess;
  if (deadline !== undefined && !deadlineApps.has(deadline)) {
    const app = fixture.createApp(fixture.administrator, {
      workspaceFileRequestTimeoutMs: deadline,
    });
    deadlineApps.set(deadline, app);
  }
  return Object.assign(Object.create(fixture), {
    app: deadlineApps.get(deadline) ?? fixture.app,
    firstAuditEvent: fixture.auditSink.events.length,
  });
}

// Replaces `object[key]` until the returned restore runs, at the latest when the case ends. An own
// property gets its value back; an inherited one (a prototype method) is uncovered again.
function replaceForCase(context, object, key, value) {
  const own = Object.getOwnPropertyDescriptor(object, key);
  object[key] = value;
  let restored = false;
  const restore = () => {
    if (restored) {
      return;
    }
    restored = true;
    if (own === undefined) {
      delete object[key];
    } else {
      Object.defineProperty(object, key, own);
    }
  };
  context.after(restore);
  return restore;
}

// Namespace names are unique in the shared app, so a case that runs again gets a new one.
let namespaces = 0;

async function createNamespace(fixture, name) {
  namespaces += 1;
  const result = await request(fixture.app, "/namespaces", {
    body: { name: `${name} ${namespaces}` },
  });
  assert.equal(result.response.status, 201);
  await fixture.controller.transact((unit) =>
    unit.namespaces.transitionNamespaceStatus(result.payload.data.id, "provisioning", "ready"),
  );
  return result.payload.data;
}

// `stage` is how far the Agent gets: "draft" (created, never deployed), "starting" (deploy
// accepted, no version active yet) or "active" (the default).
async function createAgent(fixture, namespace, name, { stage = "active" } = {}) {
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
  bindRole(fixture.state, agent.servicePrincipalId, {
    id: `model-${agent.id}`,
    roleId: `model-${agent.id}`,
    namespaceId: namespace.id,
    resource: { kind: "secret", id: secret.id },
  });
  if (stage === "draft") {
    return { agent: created.payload.data };
  }
  const deployed = await request(
    fixture.app,
    `/namespaces/${namespace.id}/agents/${created.payload.data.id}/deploy`,
    { method: "POST" },
  );
  assert.equal(deployed.response.status, 202);
  if (stage === "starting") {
    return { agent: created.payload.data, revision: deployed.payload.data };
  }
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

// A workspace file PUT from the public origin, with any other request options.
function put(app, path, body, { headers = {}, ...options } = {}) {
  return request(app, path, {
    ...options,
    method: "PUT",
    headers: { origin: publicOrigin, ...headers },
    body,
  });
}

function fileAudits(fixture) {
  return fixture.auditSink.events
    .slice(fixture.firstAuditEvent)
    .filter((event) => event.action.startsWith("openclaw.agents.workspace.files."));
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

  const write = await put(
    fixture.app,
    `/namespaces/${namespace.id}/agents/${second.agent.id}/workspace/files/SOUL.md`,
    { content: "new soul\n" },
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

test("Agent workspace file routes enforce read and operate permissions separately", async (context) => {
  const workspaceFilesAccess = {
    async read(read) {
      return { status: "ok", file: { name: read.filename, content: "readable\n" } };
    },
    async write() {
      throw new Error("read-only caller must not reach workspace file write");
    },
  };
  const fixture = await createFixture({ workspaceFilesAccess });
  const namespace = await createNamespace(fixture, "Reader tenant");
  const { agent } = await createAgent(fixture, namespace, "Reader visible Agent");
  // The reader's tenant A grant names the first Namespace any case created; read this one, and
  // leave the shared grant as it was for the next case.
  for (const grant of [...fixture.state.roles, ...fixture.state.bindings]) {
    if (["role-tenant-a-reader", "binding-tenant-a-reader"].includes(grant.id)) {
      replaceForCase(context, grant, "namespaceId", namespace.id);
    }
  }
  const session = fixture.session(fixture.tenantAReader);

  const readable = await request(
    fixture.app,
    `/namespaces/${namespace.id}/agents/${agent.id}/workspace/files/AGENTS.md`,
    { session },
  );
  assert.equal(readable.response.status, 200);
  assert.deepEqual(readable.payload.data, { name: "AGENTS.md", content: "readable\n" });

  const denied = await put(
    fixture.app,
    `/namespaces/${namespace.id}/agents/${agent.id}/workspace/files/AGENTS.md`,
    { content: "cannot write\n" },
    { session },
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

test("Agent workspace file routes authorize the caller before reporting unconfigured file access", async (context) => {
  const fixture = await createFixture({ workspaceFilesAccess: undefined });
  const namespace = await createNamespace(fixture, "Unconfigured tenant");
  const { agent } = await createAgent(fixture, namespace, "Unconfigured files Agent");
  // The same controller and sessions, but no workspace file access configured.
  const unconfigured = fixture.createApp(fixture.administrator, {
    workspaceFilesUnconfigured: true,
  });
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/workspace/files/AGENTS.md`;
  const session = fixture.session(fixture.tenantAReader);
  const assertDenied = (result, action) => {
    assert.equal(result.response.status, 403);
    assert.equal(result.payload.error.code, "FORBIDDEN");
    assert.equal(fixture.auditSink.events.at(-1).kind, "authorization_denial");
    assert.equal(fixture.auditSink.events.at(-1).authorization.action, action);
  };
  const assertUnavailable = (result) => {
    assert.equal(result.response.status, 503);
    assert.equal(result.payload.error.code, "DEPENDENCY_UNAVAILABLE");
  };

  // A caller with no grant on this Agent gets the refusal it would get on a configured
  // Installation, not a 503 that answers before its authorization (finding 2584).
  assertDenied(await request(unconfigured, path, { session }), "read");
  // With Agent read, the read reaches the missing file access; a write still needs operate.
  for (const grant of [...fixture.state.roles, ...fixture.state.bindings]) {
    if (["role-tenant-a-reader", "binding-tenant-a-reader"].includes(grant.id)) {
      replaceForCase(context, grant, "namespaceId", namespace.id);
    }
  }
  assertUnavailable(await request(unconfigured, path, { session }));
  assertDenied(
    await put(unconfigured, path, { content: "cannot write\n" }, { session }),
    "operate",
  );
  // An authorized caller still gets 503 for both. The two refusals are the only file audits.
  assertUnavailable(await request(unconfigured, path));
  assertUnavailable(await put(unconfigured, path, { content: "unconfigured\n" }));
  assert.deepEqual(
    fileAudits(fixture).map((event) => event.kind),
    ["authorization_denial", "authorization_denial"],
  );
});

// An Agent with no running version has no workspace to reach: a lifecycle state the caller can
// change, so the answer names it and the next step instead of a retryable 503 (finding D768). It
// comes after the Agent grant, as the 503 for unconfigured access does (finding 2584).
test("Agent workspace file routes name an Agent with no running version after its grant", async (context) => {
  const workspaceFilesAccess = {
    async read() {
      throw new Error("an Agent with no running version must not reach workspace file read");
    },
    async write() {
      throw new Error("an Agent with no running version must not reach workspace file write");
    },
  };
  const fixture = await createFixture({ workspaceFilesAccess });
  const namespace = await createNamespace(fixture, "No running version");
  const { agent: draft } = await createAgent(fixture, namespace, "Never deployed", {
    stage: "draft",
  });
  const { agent: starting } = await createAgent(fixture, namespace, "Still starting", {
    stage: "starting",
  });
  const session = fixture.session(fixture.tenantAReader);
  const path = (agent) =>
    `/namespaces/${namespace.id}/agents/${agent.id}/workspace/files/AGENTS.md`;
  const assertConflict = (result, message) => {
    assert.equal(result.response.status, 409);
    assert.equal(result.payload.error.code, "RESOURCE_CONFLICT");
    assert.equal(result.payload.error.message, message);
  };

  // A caller with no grant on the draft gets its refusal, not the draft's state.
  const denied = await request(fixture.app, path(draft), { session });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.payload.error.code, "FORBIDDEN");
  for (const grant of [...fixture.state.roles, ...fixture.state.bindings]) {
    if (["role-tenant-a-reader", "binding-tenant-a-reader"].includes(grant.id)) {
      replaceForCase(context, grant, "namespaceId", namespace.id);
    }
  }
  // With Agent read the reader learns the draft's state; a write still needs operate first.
  assertConflict(
    await request(fixture.app, path(draft), { session }),
    workspaceWithoutRunningVersion(draft.id),
  );
  const writeDenied = await put(fixture.app, path(draft), { content: "x\n" }, { session });
  assert.equal(writeDenied.response.status, 403);
  // An operator gets the same answer for a write, and one naming the wait for a deployment that
  // has not activated a version yet.
  assertConflict(
    await put(fixture.app, path(draft), { content: "x\n" }),
    workspaceWithoutRunningVersion(draft.id),
  );
  for (const result of [
    await request(fixture.app, path(starting)),
    await put(fixture.app, path(starting), { content: "x\n" }),
  ]) {
    assertConflict(result, workspaceVersionStarting(starting.id));
  }
  // Only the two refused callers are audited: the state answers record no file outcome.
  assert.deepEqual(
    fileAudits(fixture).map((event) => event.kind),
    ["authorization_denial", "authorization_denial"],
  );
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
  const namespace = await createNamespace(fixture, "Validation tenant");
  const { agent } = await createAgent(fixture, namespace, "Validated Agent");
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/workspace/files`;

  const invalidName = await request(fixture.app, `${path}/README.md`);
  assert.equal(invalidName.response.status, 400);
  assert.equal(invalidName.payload.error.code, "INVALID_REQUEST");

  const crossSite = await put(
    fixture.app,
    `${path}/USER.md`,
    { content: "blocked\n" },
    { headers: { "sec-fetch-site": "cross-site" } },
  );
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

  const missingContent = await put(fixture.app, `${path}/USER.md`, {});
  assert.equal(missingContent.response.status, 400);

  const unknownField = await put(fixture.app, `${path}/USER.md`, {
    content: "ok\n",
    agentId: "caller-selected-native-id",
  });
  assert.equal(unknownField.response.status, 400);

  const nul = await put(fixture.app, `${path}/USER.md`, { content: "bad\u0000value" });
  assert.equal(nul.response.status, 400);
  assert.deepEqual(nul.payload.error.details, [{ path: "/content", code: "INVALID_FORMAT" }]);

  const unpairedSurrogate = await put(
    fixture.app,
    `${path}/USER.md`,
    String.raw`{"content":"\ud800"}`,
  );
  assert.equal(unpairedSurrogate.response.status, 400);
  assert.deepEqual(unpairedSurrogate.payload.error.details, [
    { path: "/content", code: "INVALID_VALUE" },
  ]);

  const tooLong = await put(fixture.app, `${path}/USER.md`, { content: "x".repeat(16 * 1024 + 1) });
  assert.equal(tooLong.response.status, 400);
  assert.equal(
    tooLong.payload.error.details.some((detail) => detail.code === "TOO_LONG"),
    true,
  );

  // 16 KiB of content, every byte a six-byte escape, then whitespace: one byte over the limit.
  const escapedMaximum = `{"content":"${String.raw`\u0061`.repeat(16 * 1024)}"}`;
  const encodedTooLarge = await put(
    fixture.app,
    `${path}/USER.md`,
    escapedMaximum + " ".repeat(6 * 16 * 1024 + 1024 + 1 - escapedMaximum.length),
  );
  assert.equal(encodedTooLarge.response.status, 413);
  assert.equal(encodedTooLarge.payload.error.code, "PAYLOAD_TOO_LARGE");
  assert.deepEqual(calls, []);
});

test("Agent workspace file PUT admits 16 KiB of content in any JSON encoding", async () => {
  const writes = [];
  const fixture = await createFixture({
    workspaceFilesAccess: {
      async read(read) {
        return { status: "ok", file: { name: read.filename, content: "" } };
      },
      async write(write) {
        writes.push(write.content);
        return { status: "ok", file: { name: write.filename, size: 0 } };
      },
    },
  });
  const namespace = await createNamespace(fixture, "Encoded content tenant");
  const { agent } = await createAgent(fixture, namespace, "Encoded content Agent");
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/workspace/files/USER.md`;
  const escape = (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  const cases = [
    // JSON.stringify writes each control character as a six-byte escape: a 98 KB body.
    ["U+0001 control characters", "\u0001".repeat(16 * 1024), undefined],
    // ASCII-only JSON (Python's json.dumps default) writes each two-byte letter in six bytes.
    ["ASCII-escaped two-byte letters", "\u00e9".repeat(8 * 1024), escape],
    ["ASCII letters, every one escaped", "a".repeat(16 * 1024), escape],
  ];
  for (const [label, content, escapeAll] of cases) {
    assert.equal(Buffer.byteLength(content, "utf8"), 16 * 1024, label);
    const body =
      escapeAll === undefined
        ? { content }
        : `{"content":"${[...content].map((character) => escapeAll(character)).join("")}"}`;
    const write = await put(fixture.app, path, body);
    assert.equal(write.response.status, 200, `${label}: ${JSON.stringify(write.payload)}`);
    assert.equal(writes.at(-1), content, label);
  }
  assert.equal(writes.length, cases.length);
});

test("Agent workspace file routes map provider file states without leaking content in audit", async () => {
  const fixture = await createFixture({
    workspaceFilesAccess: {
      async read(read) {
        if (read.filename === "SOUL.md") {
          return { status: "missing" };
        }
        if (read.filename === "AGENTS.md") {
          // One byte over the content limit: OCC refuses it rather than relaying it.
          return {
            status: "ok",
            file: { name: read.filename, content: "x".repeat(16 * 1024 + 1) },
          };
        }
        return { status: "unavailable" };
      },
      async write(write) {
        return { status: write.filename === "SOUL.md" ? "missing" : "unavailable" };
      },
    },
  });
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

  const oversized = await request(
    fixture.app,
    `/namespaces/${namespace.id}/agents/${agent.id}/workspace/files/AGENTS.md`,
  );
  assert.equal(oversized.response.status, 503);
  assert.equal(oversized.payload.error.code, "DEPENDENCY_UNAVAILABLE");

  const writeUnavailable = await put(
    fixture.app,
    `/namespaces/${namespace.id}/agents/${agent.id}/workspace/files/USER.md`,
    { content: "secret-ish replacement\n" },
  );
  assert.equal(writeUnavailable.response.status, 503);
  assert.equal(writeUnavailable.payload.error.code, "DEPENDENCY_UNAVAILABLE");

  const writeMissing = await put(
    fixture.app,
    `/namespaces/${namespace.id}/agents/${agent.id}/workspace/files/SOUL.md`,
    { content: "secret-ish soul\n" },
  );
  assert.equal(writeMissing.response.status, 404);
  assert.equal(writeMissing.payload.error.code, "NOT_FOUND");

  const audits = fileAudits(fixture);
  assert.equal(JSON.stringify(audits).includes("secret-ish"), false);
  assert.deepEqual(
    audits.map(({ action, outcome, reasonCode, details }) => [
      action,
      outcome,
      reasonCode,
      details.workspaceFileName,
    ]),
    [
      ["openclaw.agents.workspace.files.write", "failure", "DEPENDENCY_UNAVAILABLE", "USER.md"],
      ["openclaw.agents.workspace.files.write", "failure", "FILE_MISSING", "SOUL.md"],
    ],
  );
});

test("Agent workspace file reads refuse provider content OCC would not accept in a write", async () => {
  let content;
  const fixture = await createFixture({
    workspaceFilesAccess: {
      async read(read) {
        return { status: "ok", file: { name: read.filename, content } };
      },
      async write() {
        throw new Error("not used");
      },
    },
  });
  const namespace = await createNamespace(fixture, "Unstorable read tenant");
  const { agent } = await createAgent(fixture, namespace, "Unstorable read Agent");
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/workspace/files/AGENTS.md`;
  for (const refused of ["before\u0000after", "lone \ud800 surrogate"]) {
    content = refused;
    const result = await request(fixture.app, path);
    assert.equal(result.response.status, 503, JSON.stringify(refused));
    assert.equal(result.payload.error.code, "DEPENDENCY_UNAVAILABLE");
  }
  content = "paired \ud83d\ude00 emoji\n";
  const accepted = await request(fixture.app, path);
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.payload.data.content, content);
});

test("Agent workspace file writes report an unknown outcome when the success audit fails", async (context) => {
  const writes = [];
  const fixture = await createFixture({
    workspaceFilesAccess: {
      async read() {
        throw new Error("not used");
      },
      async write(write) {
        writes.push(write);
        return { status: "ok" };
      },
    },
  });
  const namespace = await createNamespace(fixture, "Unaudited write tenant");
  const { agent } = await createAgent(fixture, namespace, "Unaudited write Agent");
  const append = fixture.auditSink.append.bind(fixture.auditSink);
  replaceForCase(context, fixture.auditSink, "append", async (event) => {
    if (event.action === "openclaw.agents.workspace.files.write") {
      throw new Error("audit store unavailable");
    }
    await append(event);
  });

  const result = await put(
    fixture.app,
    `/namespaces/${namespace.id}/agents/${agent.id}/workspace/files/USER.md`,
    { content: "written once\n" },
  );
  // The provider wrote the file, but without its audit record OCC cannot report success.
  assert.equal(result.response.status, 503);
  assert.equal(result.payload.error.code, "UNKNOWN_OUTCOME");
  assert.equal(
    result.payload.error.message,
    "The workspace file was written, but its final audit outcome could not be persisted.",
  );
  assert.equal(writes.length, 1);
});

// Exercise an uncertain write together with a stalled audit sink. The provider is
// simulated here; this test does not perform or verify a real gateway file write.
test("Agent workspace file unknown outcomes stay bounded when audit persistence stalls", async (context) => {
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
  const namespace = await createNamespace(fixture, "Unknown write tenant");
  const { agent } = await createAgent(fixture, namespace, "Unknown write Agent");
  const append = fixture.auditSink.append.bind(fixture.auditSink);
  replaceForCase(context, fixture.auditSink, "append", async (event) => {
    // Stall before storing the event, so the API must bound its audit attempt too.
    if (event.action === "openclaw.agents.workspace.files.write") {
      await new Promise(() => {});
    }
    await append(event);
  });

  const startedAt = Date.now();
  const result = await put(
    fixture.app,
    `/namespaces/${namespace.id}/agents/${agent.id}/workspace/files/USER.md`,
    { content: "sent once\n" },
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

test("Agent workspace file requests are bounded before and during provider access", async (context) => {
  const preAccess = await createFixture({
    workspaceFilesAccess: {
      async read() {
        throw new Error("active revision lookup should time out before provider read");
      },
      async write() {
        throw new Error("not used");
      },
    },
    workspaceFileRequestTimeoutMs: 20,
  });
  const preNamespace = await createNamespace(preAccess, "Pre-access deadline tenant");
  const preAgent = await createAgent(preAccess, preNamespace, "Pre-access deadline Agent");
  const restoreLookup = replaceForCase(
    context,
    preAccess.controller,
    "getReadableActiveAgentRevision",
    async () => new Promise(() => {}),
  );

  const startedBeforeRead = Date.now();
  const read = await request(
    preAccess.app,
    `/namespaces/${preNamespace.id}/agents/${preAgent.agent.id}/workspace/files/AGENTS.md`,
  );
  const readElapsedMs = Date.now() - startedBeforeRead;
  // The provider half needs the real lookup back.
  restoreLookup();
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
    workspaceFileRequestTimeoutMs: 20,
  });
  const providerNamespace = await createNamespace(providerAccess, "Provider deadline tenant");
  const providerAgent = await createAgent(
    providerAccess,
    providerNamespace,
    "Provider deadline Agent",
  );

  const appendAfterTimeout = providerAccess.auditSink.append.bind(providerAccess.auditSink);
  replaceForCase(context, providerAccess.auditSink, "append", async (event) => {
    await appendAfterTimeout(event);
    if (event.action === "openclaw.agents.workspace.files.write") {
      throw new Error("Audit acknowledgement failed after the request deadline.");
    }
  });

  const startedBeforeWrite = Date.now();
  const write = await put(
    providerAccess.app,
    `/namespaces/${providerNamespace.id}/agents/${providerAgent.agent.id}/workspace/files/USER.md`,
    { content: "deadline write\n" },
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
  const namespace = await createNamespace(fixture, "Disconnect tenant");
  const { agent } = await createAgent(fixture, namespace, "Disconnect Agent");
  // Every app forwards to the running case's workspace file provider.
  const app = fixture.createApp(fixture.administrator, {}, createFastifyApp);
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
  // The disconnect aborted the read, not the request deadline.
  assert.match(read.signal.reason.message, /disconnected/);
  assert.equal(reads.length, 1);
});
