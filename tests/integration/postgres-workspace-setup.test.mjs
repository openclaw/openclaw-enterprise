import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

const identifier = (prefix) => `${prefix}_${randomUUID()}`;

async function exerciseSetup(store, reopened = store) {
  const createdAt = new Date().toISOString();
  const namespace = {
    id: identifier("ns"),
    name: `Workspace ${randomUUID()}`,
    status: "ready",
    createdAt,
  };
  const otherNamespace = { ...namespace, id: identifier("ns"), name: `${namespace.name} other` };
  const configuration = {
    id: identifier("cfg"),
    namespaceId: namespace.id,
    kind: "agent",
    generation: 1,
    createdAt,
  };
  const installation = await store.transact(async (state) => {
    const installation =
      (await state.installations.getInstallation()) ??
      (await state.installations.createInstallation({
        id: identifier("ins"),
        name: "Workspace setup",
        createdAt,
      }));
    await state.namespaces.createNamespace(namespace);
    await state.namespaces.createNamespace(otherNamespace);
    await state.configurations.createConfiguration(configuration);
    return installation;
  });
  // Real OCC authorization and create transactions exercise both repository implementations.
  const controller = new OpenClawController(installation, { state: store });
  const iam = new NativeIAMDriver(
    {
      loadNativeIAMState: async () => ({
        identities: ["creator", "outsider"].map((id) => ({
          id,
          kind: "principal",
          issuer: "workspace-tests",
          subject: id,
        })),
        groups: [],
        memberships: [],
        restrictions: [],
        roles: [
          {
            id: "creator-role",
            namespaceId: namespace.id,
            permissions: [
              { action: "create", resourceKind: "agent" },
              { action: "read", resourceKind: "agent" },
              { action: "delete", resourceKind: "agent" },
              { action: "read", resourceKind: "configuration" },
            ],
          },
        ],
        bindings: [
          {
            id: "creator-binding",
            namespaceId: namespace.id,
            subjectKind: "identity",
            subjectId: "creator",
            roleId: "creator-role",
          },
        ],
      }),
    },
    { id: "workspace-iam" },
  );
  controller.registerDriver(iam);
  controller.selectDriver("iam", iam.id);
  const input = {
    namespaceId: namespace.id,
    configurationId: configuration.id,
    name: "With files",
  };
  const files = {
    "AGENTS.md": "  private setup\r\n",
    "SOUL.md": "",
    "IDENTITY.md": "🦀".repeat(4096),
    "USER.md": "\u0001".repeat(16384),
  };
  const defaultsId = "a".repeat(64);
  const agent = await controller.createAgent("creator", {
    ...input,
    initialWorkspaceFiles: files,
    workspaceDefaultsId: defaultsId,
  });
  const setup = await reopened.read((state) => state.workspaceSetups.find(namespace.id, agent.id));
  assert.deepEqual(setup.files, files);
  assert.equal(setup.defaultsId, defaultsId);
  assert.equal(setup.completed, false);
  assert.equal(agent.desiredRuntimeState, "stopped");
  assert.equal("initialWorkspaceFiles" in agent, false);
  assert.equal("workspaceDefaultsId" in agent, false);
  assert.deepEqual(
    await reopened.read((state) => state.revisions.listRevisions(namespace.id, agent.id)),
    [],
  );
  assert.equal(
    await reopened.read((state) => state.workspaceSetups.find(otherNamespace.id, agent.id)),
    undefined,
  );
  assert.equal(
    await store.transact((state) =>
      state.workspaceSetups.complete(otherNamespace.id, agent.id, setup.id),
    ),
    undefined,
  );
  assert.equal(
    await store.transact((state) =>
      state.workspaceSetups.complete(namespace.id, agent.id, "wrong-setup"),
    ),
    undefined,
  );
  assert.equal(
    await store.transact((state) => state.workspaceSetups.delete(otherNamespace.id, agent.id)),
    false,
  );
  await assert.rejects(
    store.transact((state) => state.workspaceSetups.create({ ...setup, id: randomUUID() })),
    { name: "ResourceConflictError" },
  );
  let withoutSetup;
  for (const [name, initialWorkspaceFiles] of [
    ["Omitted", undefined],
    ["Empty map", {}],
  ]) {
    const omitted = await controller.createAgent("creator", {
      ...input,
      name,
      initialWorkspaceFiles,
    });
    withoutSetup = omitted;
    assert.equal(
      await reopened.read((state) => state.workspaceSetups.find(namespace.id, omitted.id)),
      undefined,
    );
  }
  const before = await reopened.read((state) => state.agents.listAgents(namespace.id));
  for (const bad of [
    null,
    [],
    { "TOOLS.md": "unexpected" },
    { "SOUL.md": null },
    { "SOUL.md": "\0" },
    { "SOUL.md": "\ud800" },
    { "SOUL.md": "🦀".repeat(4097) },
  ]) {
    await assert.rejects(
      controller.createAgent("creator", { ...input, name: "Rejected", initialWorkspaceFiles: bad }),
      { name: "ScopeViolationError" },
    );
  }
  await assert.rejects(
    controller.createAgent("outsider", { ...input, name: "Denied", initialWorkspaceFiles: files }),
    { name: "AuthorizationDeniedError" },
  );
  await assert.rejects(
    controller.createAgent("creator", {
      ...input,
      name: "Cross namespace",
      namespaceId: otherNamespace.id,
      initialWorkspaceFiles: files,
    }),
    { name: "AuthorizationDeniedError" },
  );
  assert.deepEqual(await reopened.read((state) => state.agents.listAgents(namespace.id)), before);
  // An enclosing transaction failure rolls back both Agent and staged private contents.
  let rolledBackAgent;
  await assert.rejects(
    controller.transact(async () => {
      rolledBackAgent = await controller.createAgent("creator", {
        ...input,
        name: "Rolled back",
        initialWorkspaceFiles: { "USER.md": "transaction private" },
      });
      throw new Error("abort setup transaction");
    }),
    /abort setup transaction/,
  );
  assert.equal(
    await reopened.read((state) => state.agents.findAgent(namespace.id, rolledBackAgent.id)),
    undefined,
  );
  assert.equal(
    await reopened.read((state) => state.workspaceSetups.find(namespace.id, rolledBackAgent.id)),
    undefined,
  );
  const completed = await store.transact((state) =>
    state.workspaceSetups.complete(namespace.id, agent.id, setup.id),
  );
  assert.deepEqual(completed, {
    id: setup.id,
    namespaceId: namespace.id,
    agentId: agent.id,
    defaultsId,
    completed: true,
  });
  assert.deepEqual(
    await reopened.read((state) => state.workspaceSetups.find(namespace.id, agent.id)),
    completed,
  );
  assert.deepEqual(
    await store.transact((state) =>
      state.workspaceSetups.complete(namespace.id, agent.id, setup.id),
    ),
    completed,
  );
  // Deleting an undeployed Agent must erase pending bytes without waiting for a worker.
  const pending = await controller.createAgent("creator", {
    ...input,
    name: "Delete pending",
    initialWorkspaceFiles: { "USER.md": "delete me" },
  });
  await controller.deleteAgent("creator", namespace.id, pending.id);
  assert.equal(
    await reopened.read((state) => state.workspaceSetups.find(namespace.id, pending.id)),
    undefined,
  );
  return { setup, completed, namespace, otherNamespace, agent, withoutSetup };
}

test("OCC stages workspace input atomically, isolates it, and clears bytes on completion or deletion", async () => {
  await exerciseSetup(new InMemoryPlatformState());
});

test(
  "PostgreSQL workspace setup survives reopen and enforces immutable input and completed state",
  requiresPostgres,
  async (context) => {
    const [{ Pool }, { PostgresPlatformState }] = await Promise.all([
      import("pg"),
      import("../../packages/occ/src/state/postgres-state.ts"),
    ]);
    const pool = new Pool({ connectionString: databaseUrl });
    const secondPool = new Pool({ connectionString: databaseUrl });
    context.after(() => Promise.all([pool.end(), secondPool.end()]));
    const { setup, namespace, agent, withoutSetup } = await exerciseSetup(
      new PostgresPlatformState(pool),
      new PostgresPlatformState(secondPool),
    );
    await assert.rejects(
      pool.query("UPDATE occ.workspace_setups SET files = $2::jsonb WHERE id = $1", [
        setup.id,
        JSON.stringify({ "USER.md": "replay" }),
      ]),
      { code: "23514" },
    );
    await assert.rejects(
      pool.query("UPDATE occ.workspace_setups SET completed = false WHERE id = $1", [setup.id]),
      { code: "23514" },
    );
    await assert.rejects(
      pool.query("UPDATE occ.workspace_setups SET defaults_id = $2 WHERE id = $1", [
        setup.id,
        "b".repeat(64),
      ]),
      { code: "42501" },
    );
    await assert.rejects(
      pool.query(
        "INSERT INTO occ.workspace_setups (id, namespace_id, agent_id, files) VALUES ($1,$2,$3,$4::jsonb)",
        [randomUUID(), namespace.id, identifier("agt"), JSON.stringify({ "USER.md": "unowned" })],
      ),
      { code: "23514" },
    );
    // Direct application-role writes cannot bypass validation or replace submitted pending input.
    for (const files of [
      {},
      { "TOOLS.md": "unknown" },
      { "USER.md": 1 },
      { "USER.md": "x".repeat(16385) },
    ]) {
      await assert.rejects(
        pool.query(
          "INSERT INTO occ.workspace_setups (id, namespace_id, agent_id, files) VALUES ($1,$2,$3,$4::jsonb)",
          [randomUUID(), namespace.id, withoutSetup.id, JSON.stringify(files)],
        ),
        { code: "23514" },
      );
    }
    const pendingId = randomUUID();
    await pool.query(
      "INSERT INTO occ.workspace_setups (id, namespace_id, agent_id, files) VALUES ($1,$2,$3,$4::jsonb)",
      [pendingId, namespace.id, withoutSetup.id, JSON.stringify({ "USER.md": "original" })],
    );
    await assert.rejects(
      pool.query("UPDATE occ.workspace_setups SET files = $2::jsonb WHERE id = $1", [
        pendingId,
        JSON.stringify({ "USER.md": "replacement" }),
      ]),
      { code: "23514" },
    );
    assert.equal(
      (await pool.query("SELECT files FROM occ.workspace_setups WHERE agent_id = $1", [agent.id]))
        .rows[0].files,
      null,
    );
  },
);
