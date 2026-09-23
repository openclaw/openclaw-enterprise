import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { harnessAuthBindingFromSnapshot } from "../../packages/contracts/src/harness-auth.ts";

const identifier = (kind) => `${kind}_${randomUUID()}`;
const databaseUrl = process.env.OCC_TEST_DATABASE_URL;

async function exerciseConnections(store, reopened = store) {
  const createdAt = new Date().toISOString();
  const namespace = {
    id: identifier("ns"),
    name: `Connections ${randomUUID()}`,
    status: "ready",
    createdAt,
  };
  const other = { ...namespace, id: identifier("ns"), name: `${namespace.name} other` };
  const secret = {
    id: identifier("sec"),
    namespaceId: namespace.id,
    name: "API key",
    driverId: "kubernetes-secret",
    createdAt,
    backendRef: {
      namespaceName: "connection-test",
      name: "credentials",
      key: "value",
      uid: randomUUID(),
    },
  };
  const source = { kind: "secret", namespaceId: namespace.id, id: secret.id };
  const connection = {
    id: identifier("pco"),
    namespaceId: namespace.id,
    name: "OpenAI",
    providerId: "openai",
    authMethodId: "api-key",
    source,
    createdAt,
  };
  await store.transact(async (state) => {
    if ((await state.installations.getInstallation()) === undefined) {
      await state.installations.createInstallation({
        id: identifier("ins"),
        name: "Connection persistence",
        createdAt,
      });
    }
    await state.namespaces.createNamespace(namespace);
    await state.namespaces.createNamespace(other);
    await state.secrets.createSecret(secret);
    await state.providerConnections.createProviderConnection(connection);
  });
  // Setup exists before an Agent, and another state instance reads only metadata.
  const copy = await reopened.read((state) =>
    state.providerConnections.findProviderConnection(namespace.id, connection.id),
  );
  assert.deepEqual(copy, connection);
  assert.equal(Object.isFrozen(copy.source), true);
  await reopened.read(async (state) => {
    assert.equal(
      await state.providerConnections.findProviderConnection(other.id, connection.id),
      undefined,
    );
    assert.deepEqual(await state.providerConnections.listProviderConnections(other.id), []);
    assert.deepEqual(await state.providerConnections.listProviderConnections(namespace.id), [
      connection,
    ]);
  });
  await assert.rejects(
    store.transact((state) => state.secrets.deleteSecret(namespace.id, secret.id)),
    { name: "ScopeViolationError" },
  );
  await assert.rejects(
    store.transact((state) =>
      state.providerConnections.createProviderConnection({
        ...connection,
        id: identifier("pco"),
        namespaceId: other.id,
      }),
    ),
    { name: "ScopeViolationError" },
  );
  const contenders = await Promise.allSettled([
    store.transact((state) =>
      state.providerConnections.createProviderConnection({
        ...connection,
        id: identifier("pco"),
        name: "Unique",
      }),
    ),
    reopened.transact((state) =>
      state.providerConnections.createProviderConnection({
        ...connection,
        id: identifier("pco"),
        name: "Unique",
      }),
    ),
  ]);
  assert.equal(contenders.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(
    contenders.find((result) => result.status === "rejected").reason.name,
    "ResourceConflictError",
  );

  const configuration = {
    id: identifier("cfg"),
    namespaceId: namespace.id,
    kind: "agent",
    generation: 1,
    createdAt,
  };
  const binding = { method: "provider_connection", connectionId: connection.id };
  const agent = {
    id: identifier("agt"),
    namespaceId: namespace.id,
    name: "Connection user",
    configurationId: configuration.id,
    providerId: null,
    harnessAuth: binding,
    executionMode: "embedded",
    servicePrincipalId: `service-agent-${randomUUID()}`,
    createdAt,
  };
  const revision = {
    id: identifier("rev"),
    namespaceId: namespace.id,
    agentId: agent.id,
    revision: 1,
    configurationId: configuration.id,
    configurationKind: "agent",
    configurationGeneration: 1,
    providerId: null,
    configuration: {},
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    compute: { id: "test", implementation: "test" },
    servicePrincipalId: agent.servicePrincipalId,
    createdAt,
    harnessAuth: {
      method: "provider_connection",
      credential: { source, secretDriverId: secret.driverId },
      connection: {
        id: connection.id,
        providerId: connection.providerId,
        authMethodId: connection.authMethodId,
      },
    },
  };
  assert.deepEqual(harnessAuthBindingFromSnapshot(revision.harnessAuth), binding);
  await store.transact(async (state) => {
    await state.configurations.createConfiguration(configuration);
    await state.agents.createAgent(agent);
    assert.equal(await state.providerConnections.hasReferences(namespace.id, connection.id), true);
  });
  await assert.rejects(
    store.transact((state) =>
      state.providerConnections.deleteProviderConnection(namespace.id, connection.id),
    ),
    { name: "ScopeViolationError" },
  );
  await store.transact(async (state) => {
    await state.revisions.createRevision(revision);
    await state.agents.updateConfiguration(
      namespace.id,
      agent.id,
      configuration.id,
      undefined,
      null,
    );
    // Historical revision metadata does not hold a live connection dependency.
    assert.equal(await state.providerConnections.hasReferences(namespace.id, connection.id), false);
    await state.agents.compareAndSetActiveRevision(namespace.id, agent.id, undefined, revision.id);
    assert.equal(await state.providerConnections.hasReferences(namespace.id, connection.id), true);
  });
  assert.deepEqual(
    (
      await reopened.read((state) =>
        state.revisions.findRevision(namespace.id, agent.id, revision.id),
      )
    ).harnessAuth,
    revision.harnessAuth,
  );
  await assert.rejects(
    store.transact((state) =>
      state.providerConnections.deleteProviderConnection(namespace.id, connection.id),
    ),
    { name: "ScopeViolationError" },
  );

  const queued = { ...connection, id: identifier("pco"), name: "Queued" };
  const queuedRevision = {
    ...revision,
    id: identifier("rev"),
    revision: 2,
    harnessAuth: {
      ...revision.harnessAuth,
      connection: { ...revision.harnessAuth.connection, id: queued.id },
    },
  };
  await store.transact(async (state) => {
    await state.providerConnections.createProviderConnection(queued);
    await state.agents.updateConfiguration(namespace.id, agent.id, configuration.id, undefined, {
      method: "provider_connection",
      connectionId: queued.id,
    });
    await state.revisions.createRevision(queuedRevision);
    await state.agents.updateConfiguration(
      namespace.id,
      agent.id,
      configuration.id,
      undefined,
      null,
    );
    assert.equal(await state.providerConnections.hasReferences(namespace.id, queued.id), false);
    await state.operations.append({
      kind: "agent_revision",
      action: "reconcile",
      namespaceId: namespace.id,
      resourceId: queuedRevision.id,
      actorId: "connection-test",
    });
    assert.equal(await state.providerConnections.hasReferences(namespace.id, queued.id), true);
  });
  await assert.rejects(
    store.transact((state) =>
      state.providerConnections.deleteProviderConnection(namespace.id, queued.id),
    ),
    { name: "ScopeViolationError" },
  );

  const local = {
    id: identifier("pco"),
    namespaceId: namespace.id,
    name: "Local Ollama",
    providerId: "ollama",
    authMethodId: "local",
    baseUrl: "http://ollama.models.svc.cluster.local:11434",
    createdAt,
  };
  const localRevision = {
    ...revision,
    id: identifier("rev"),
    revision: 3,
    harnessAuth: {
      method: "provider_connection",
      connection: {
        id: local.id,
        providerId: local.providerId,
        authMethodId: local.authMethodId,
        baseUrl: local.baseUrl,
      },
    },
  };
  await store.transact(async (state) => {
    await state.providerConnections.createProviderConnection(local);
    await state.agents.updateConfiguration(namespace.id, agent.id, configuration.id, undefined, {
      method: "provider_connection",
      connectionId: local.id,
    });
    await state.revisions.createRevision(localRevision);
  });
  assert.deepEqual(
    (
      await reopened.read((state) =>
        state.revisions.findRevision(namespace.id, agent.id, localRevision.id),
      )
    ).harnessAuth,
    localRevision.harnessAuth,
  );
  const invalidSnapshots = [
    { ...localRevision.harnessAuth, secretValue: "must-not-be-persisted" },
    {
      ...localRevision.harnessAuth,
      credential: { source, secretDriverId: secret.driverId, backendRef: secret.backendRef },
    },
    {
      ...localRevision.harnessAuth,
      credential: { source: { ...source, namespaceId: other.id }, secretDriverId: secret.driverId },
    },
    {
      ...localRevision.harnessAuth,
      connection: { ...localRevision.harnessAuth.connection, baseUrl: " " },
    },
  ];
  for (const harnessAuth of invalidSnapshots) {
    await assert.rejects(
      store.transact((state) =>
        state.revisions.createRevision({
          ...localRevision,
          id: identifier("rev"),
          revision: 4,
          harnessAuth,
        }),
      ),
      { name: "ScopeViolationError" },
    );
  }

  // A local endpoint needs no Secret, but its saved connection still prevents Namespace deletion.
  const endpoint = {
    id: identifier("pco"),
    namespaceId: other.id,
    name: "Ollama endpoint",
    providerId: "ollama",
    authMethodId: "local",
    baseUrl: "http://ollama.models.svc.cluster.local:11434",
    createdAt,
  };
  await store.transact(async (state) => {
    await state.providerConnections.createProviderConnection(endpoint);
    assert.equal(await state.namespaces.hasProviderConnections(other.id), true);
    await state.namespaces.transitionNamespaceStatus(other.id, "ready", "deleting");
  });
  await assert.rejects(
    store.transact((state) => state.namespaces.markNamespaceDeleted(other.id, createdAt)),
    { name: "ScopeViolationError" },
  );
  await assert.rejects(
    store.transact((state) =>
      state.providerConnections.createProviderConnection({
        ...endpoint,
        id: identifier("pco"),
        name: "Too late",
      }),
    ),
    { name: "ScopeViolationError" },
  );
  await store.transact(async (state) => {
    assert.equal(
      await state.providerConnections.deleteProviderConnection(namespace.id, endpoint.id),
      false,
    );
    assert.equal(
      await state.providerConnections.deleteProviderConnection(other.id, endpoint.id),
      true,
    );
    assert.equal(await state.namespaces.hasProviderConnections(other.id), false);
    assert.ok(await state.namespaces.markNamespaceDeleted(other.id, createdAt));
  });
  return { namespace, other, connection, secret, agent, localRevision, invalidSnapshots };
}

test("in-memory ProviderConnections preserve setup, source ownership, and live revision references", async () => {
  await exerciseConnections(new InMemoryPlatformState());
});

test(
  "PostgreSQL ProviderConnections survive reopening and enforce source, identity, and IAM ownership",
  {
    skip: databaseUrl
      ? false
      : "Set OCC_TEST_DATABASE_URL to run real PostgreSQL integration tests.",
  },
  async (context) => {
    const [{ Pool }, { PostgresPlatformState }] = await Promise.all([
      import("pg"),
      import("../../packages/occ/src/state/postgres-state.ts"),
    ]);
    const pool = new Pool({ connectionString: databaseUrl });
    const secondPool = new Pool({ connectionString: databaseUrl });
    context.after(() => Promise.all([pool.end(), secondPool.end()]));
    const { namespace, other, connection, secret, agent, localRevision, invalidSnapshots } =
      await exerciseConnections(
        new PostgresPlatformState(pool),
        new PostgresPlatformState(secondPool),
      );
    // Bypass the repository validator to prove PostgreSQL protects the same private snapshot.
    for (const harnessAuth of invalidSnapshots) {
      await assert.rejects(
        pool.query(
          `INSERT INTO occ.agent_revisions
        (id, namespace_id, agent_id, revision_number, provider_id, admitted_spec, admitted_at)
        SELECT $1, namespace_id, agent_id, 4, provider_id,
          jsonb_set(admitted_spec, '{harness_auth}', $2::jsonb), admitted_at
        FROM occ.agent_revisions WHERE id = $3`,
          [identifier("rev"), JSON.stringify(harnessAuth), localRevision.id],
        ),
        { code: "23514" },
      );
    }
    await assert.rejects(
      pool.query("UPDATE occ.provider_connections SET name = 'Changed' WHERE id = $1", [
        connection.id,
      ]),
      { code: "55000" },
    );
    await assert.rejects(
      pool.query("DELETE FROM occ.secrets WHERE id = $1", [secret.id]),
      (error) => ["23001", "23503"].includes(error.code),
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO occ.provider_connections (id, namespace_id, name, provider_id, auth_method_id, source_secret_id, created_at)
    VALUES ($1, $2, 'Foreign source', 'openai', 'api-key', $3, now())`,
        [identifier("pco"), other.id, secret.id],
      ),
      { code: "23503" },
    );
    await assert.rejects(
      pool.query("UPDATE occ.agents SET harness_auth = $2::jsonb WHERE id = $1", [
        agent.id,
        JSON.stringify({ method: "provider_connection", connectionId: identifier("pco") }),
      ]),
      { code: "23503" },
    );
    await pool.query(
      `INSERT INTO occ.iam_restrictions (id, namespace_id, action, resource_kind, resource_id, effect)
    VALUES ($1, $2, 'read', 'provider_connection', $3, 'deny')`,
      [identifier("restriction"), namespace.id, connection.id],
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO occ.iam_restrictions (id, namespace_id, action, resource_kind, resource_id, effect)
    VALUES ($1, $2, 'read', 'provider_connection', $3, 'deny')`,
        [identifier("restriction"), other.id, connection.id],
      ),
      { code: "23514" },
    );
  },
);
