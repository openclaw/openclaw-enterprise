import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { InMemoryPlatformState } from "../../packages/occ/src/index.ts";

test("creation requests recover the original Configuration and Agent without duplicate writes", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Creation recovery");
  const configurations = `/namespaces/${namespace.id}/configurations`;
  const agents = `/namespaces/${namespace.id}/agents`;
  const configurationBody = {
    idempotencyKey: randomUUID(),
    kind: "agent",
    values: { agents: { defaults: { model: "openai/example" } }, logging: { level: "info" } },
  };
  const saved = await fixture.request("POST", configurations, { body: configurationBody });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));

  // The caller may not receive the first reply; canonical JSON key ordering must
  // still recover that resource when its unchanged request is serialized again.
  const recovered = await fixture.request("POST", configurations, {
    body: {
      values: { logging: { level: "info" }, agents: { defaults: { model: "openai/example" } } },
      kind: "agent",
      idempotencyKey: configurationBody.idempotencyKey,
    },
  });
  assert.equal(recovered.status, 201, JSON.stringify(recovered.body));
  assert.equal(recovered.data.id, saved.data.id);
  await fixture.updateConfiguration(namespace.id, saved.data.id, { logging: { level: "debug" } });
  const current = await fixture.request("POST", configurations, { body: configurationBody });
  assert.equal(current.status, 201);
  assert.equal(current.data.id, saved.data.id);
  assert.equal(current.data.values.logging.level, "debug", "recovery never restores stale values");

  const agentBody = {
    idempotencyKey: randomUUID(),
    name: "Recovered Agent",
    configurationId: saved.data.id,
    initialWorkspaceFiles: { "AGENTS.md": "Preserve this initial workspace." },
  };
  const replies = await Promise.all(
    Array.from({ length: 3 }, () => fixture.request("POST", agents, { body: agentBody })),
  );
  for (const result of replies) {
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.data.id, replies[0].data.id);
    assert.equal(result.data.configurationId, saved.data.id);
  }
  const listed = await fixture.request("GET", agents);
  assert.deepEqual(
    listed.data.map(({ id }) => id),
    [replies[0].data.id],
  );

  for (const [path, body] of [
    [configurations, { ...configurationBody, values: { logging: { level: "debug" } } }],
    [agents, { ...agentBody, initialWorkspaceFiles: { "AGENTS.md": "Different request." } }],
  ]) {
    const conflict = await fixture.request("POST", path, { body });
    assert.equal(conflict.status, 409);
    assert.match(conflict.body.error.message, /idempotency key.*different/i);
  }

  // Identical content with a new request identity is an intentional new create.
  const separateBody = { ...configurationBody, idempotencyKey: randomUUID() };
  const separate = await fixture.request("POST", configurations, { body: separateBody });
  assert.equal(separate.status, 201);
  assert.notEqual(separate.data.id, saved.data.id);
  const removal = await fixture.rawRequest("DELETE", `${configurations}/${separate.data.id}`, {
    headers: authenticatedHeaders(await fixture.signIn()),
  });
  assert.equal(removal.response.status, 204);
  const deleted = await fixture.request("POST", configurations, {
    body: separateBody,
  });
  assert.equal(deleted.status, 409);
  assert.match(deleted.body.error.message, /no longer available/i);
});

test("creation recovery scopes keys to each caller and Namespace and rechecks exact read permission", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const firstNamespace = await fixture.createNamespace("First recovery Namespace");
  const secondNamespace = await fixture.createNamespace("Second recovery Namespace");
  const path = `/namespaces/${firstNamespace.id}/configurations`;
  const role = {
    id: `role-${randomUUID()}`,
    namespaceId: firstNamespace.id,
    permissions: [
      { action: "create", resourceKind: "configuration" },
      { action: "read", resourceKind: "configuration" },
    ],
  };
  const account = await fixture.createAccountWithPolicy("creation-reader", (principal) => {
    fixture.policy.roles.push(role);
    fixture.policy.bindings.push({
      id: `binding-${randomUUID()}`,
      namespaceId: firstNamespace.id,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: role.id,
    });
  });
  const session = await fixture.signIn(account.credentials);
  const body = { idempotencyKey: randomUUID(), kind: "agent", values: {} };
  const first = await fixture.request("POST", path, { body });
  const otherCaller = await fixture.request("POST", path, { body, session });
  const otherNamespace = await fixture.request(
    "POST",
    `/namespaces/${secondNamespace.id}/configurations`,
    { body },
  );
  for (const result of [first, otherCaller, otherNamespace]) {
    assert.equal(result.status, 201, JSON.stringify(result.body));
  }
  assert.equal(new Set([first.data.id, otherCaller.data.id, otherNamespace.data.id]).size, 3);

  // A retained request key is not authority to read its result after revocation.
  role.permissions.splice(1, 1);
  const denied = await fixture.request("POST", path, { body, session });
  assert.equal(denied.status, 403);
  const newRequest = await fixture.request("POST", path, {
    body: { ...body, idempotencyKey: randomUUID() },
    session,
  });
  assert.equal(newRequest.status, 201, "create authority itself remains granted");
});

test("an Agent creation committed with earlier workspace defaults can still be recovered", async (t) => {
  const state = new InMemoryPlatformState();
  const fixture = await createConsoleAppFixture(t, { state });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Workspace recovery");
  const agent = await fixture.createAgent(namespace.id, "Existing Agent");
  const body = {
    configurationId: agent.configurationId,
    name: agent.name,
    workspaceDefaultsId: "0".repeat(64),
  };
  const idempotencyKey = randomUUID();
  // Seed a committed receipt from the previous application version. Its old
  // defaults were valid then; recovery must not readmit it as a fresh creation.
  await state.transact((unit) =>
    unit.creationRequests.record({
      namespaceId: namespace.id,
      actorId: fixture.policy.identities[0].id,
      operation: "createAgent",
      idempotencyKey,
      fingerprint: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
      resourceId: agent.id,
      createdAt: agent.createdAt,
    }),
  );
  const recovered = await fixture.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: { ...body, idempotencyKey },
  });
  assert.equal(recovered.status, 201, JSON.stringify(recovered.body));
  assert.equal(recovered.data.id, agent.id);
  const fresh = await fixture.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: { ...body, idempotencyKey: randomUUID() },
  });
  assert.equal(fresh.status, 409);
  assert.match(fresh.body.error.message, /defaults changed/i);
});
