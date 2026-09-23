import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const requiresPostgres = {
  skip: databaseUrl ? false : "Set OCC_TEST_DATABASE_URL to run real PostgreSQL integration tests.",
};

function identifier(kind) {
  return `${kind}_${randomUUID()}`;
}

function shortName(prefix) {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function resources() {
  const namespaceId = identifier("ns");
  const configurationId = identifier("cfg");
  const agentId = identifier("agt");
  const createdAt = new Date().toISOString();
  const namespace = {
    id: namespaceId,
    name: `Secret state ${randomUUID()}`,
    status: "ready",
    createdAt,
  };
  const configuration = {
    id: configurationId,
    namespaceId,
    kind: "agent",
    generation: 1,
    createdAt,
  };
  const agent = {
    id: agentId,
    namespaceId,
    name: `Secret owner ${randomUUID()}`,
    configurationId,
    providerId: null,
    harnessAuth: null,
    executionMode: "dedicated",
    servicePrincipalId: `service-agent-${randomUUID()}`,
    createdAt,
  };
  return { namespace, configuration, agent, createdAt };
}

function secret(namespaceId, name = `model-key-${randomUUID()}`) {
  return {
    id: identifier("sec"),
    namespaceId,
    name,
    driverId: "kubernetes-secret",
    backendRef: {
      namespaceName: shortName("ns"),
      name: `${shortName("agent")}.credentials`,
      key: "value",
      uid: randomUUID(),
    },
    createdAt: new Date().toISOString(),
  };
}

function bindingValue(storedSecret) {
  return {
    source: {
      kind: "secret",
      namespaceId: storedSecret.namespaceId,
      id: storedSecret.id,
    },
    delivery: { type: "env" },
  };
}

function bindingFor(storedSecret, destination = "SERVICE_TOKEN") {
  return {
    [destination]: bindingValue(storedSecret),
  };
}

function bindingsFor(storedSecret, destinations) {
  return Object.fromEntries(
    destinations.map((destination) => [destination, bindingValue(storedSecret)]),
  );
}

function tooManyBindings(storedSecret) {
  return bindingsFor(
    storedSecret,
    Array.from({ length: 65 }, (_, index) => `MODEL_KEY_${index}`),
  );
}

function acceptedBindings(storedSecret) {
  return bindingsFor(storedSecret, ["SERVICE_TOKEN", "EXTERNAL_API_KEY"]);
}

async function assertStateBindingDestinationGrammar(
  state,
  namespaceId,
  configuration,
  storedSecret,
) {
  for (const bindings of [
    bindingFor(storedSecret, "CODEX_TOKEN"),
    bindingFor(storedSecret, "OPENAI_API_KEY"),
    bindingFor(storedSecret, "PATH"),
    tooManyBindings(storedSecret),
  ]) {
    await assert.rejects(
      state.configurations.advanceConfigurationGeneration(
        namespaceId,
        configuration.id,
        configuration.generation,
        bindings,
      ),
      { name: "ScopeViolationError" },
    );
  }

  const advanced = await state.configurations.advanceConfigurationGeneration(
    namespaceId,
    configuration.id,
    configuration.generation,
    acceptedBindings(storedSecret),
  );
  assert.deepEqual(advanced.secretBindings, acceptedBindings(storedSecret));
  assert.equal(advanced.generation, configuration.generation + 1);
}

function insertSqlConfiguration(pool, namespaceId, bindings) {
  return pool.query(
    `INSERT INTO occ.configurations (id, namespace_id, kind, generation, secret_bindings, created_at)
     VALUES ($1, $2, 'agent', 1, $3::jsonb, now())`,
    [identifier("cfg"), namespaceId, JSON.stringify(bindings)],
  );
}

function revisionFor(agent, configuration, storedSecret, revisionNumber = 1) {
  return {
    id: identifier("rev"),
    namespaceId: agent.namespaceId,
    agentId: agent.id,
    revision: revisionNumber,
    configurationId: configuration.id,
    configurationKind: configuration.kind,
    configurationGeneration: configuration.generation,
    providerId: null,
    harnessAuth: {
      method: "codex_pat",
      source: { kind: "secret", namespaceId: agent.namespaceId, id: storedSecret.id },
      secretDriverId: storedSecret.driverId,
    },
    configuration: { models: { providers: { codex: {} } } },
    harness: { id: "codex", version: "1.0.0", mode: agent.executionMode },
    compute: { id: "compute-test", implementation: "deterministic-test" },
    servicePrincipalId: agent.servicePrincipalId,
    createdAt: new Date().toISOString(),
    secretDriverId: "kubernetes-secret",
  };
}

async function ensureInstallation(store) {
  const existing = await store.read((state) => state.installations.getInstallation());
  if (existing !== undefined) {
    return existing;
  }
  return store.transact((state) =>
    state.installations.createInstallation({
      id: identifier("ins"),
      name: `Secret state ${randomUUID()}`,
      createdAt: new Date().toISOString(),
    }),
  );
}

async function exerciseRepository(store) {
  await ensureInstallation(store);
  const { namespace, configuration, agent } = resources();
  const storedSecret = secret(namespace.id);
  const siblingConfiguration = {
    ...configuration,
    id: identifier("cfg"),
    generation: 1,
  };
  const secondSharedSecret = secret(namespace.id);
  const siblingAgent = {
    ...agent,
    id: identifier("agt"),
    name: `Sibling ${randomUUID()}`,
    servicePrincipalId: `service-agent-${randomUUID()}`,
    configurationId: siblingConfiguration.id,
  };

  await store.transact(async (state) => {
    await state.namespaces.createNamespace(namespace);
    assert.equal(await state.namespaces.hasSecrets(namespace.id), false);
    // Namespace-owned Secrets can be registered before any Agent exists.
    assert.deepEqual(await state.secrets.createSecret(storedSecret), storedSecret);
    assert.equal(await state.namespaces.hasSecrets(namespace.id), true);
    assert.deepEqual(await state.secrets.findSecret(namespace.id, storedSecret.id), storedSecret);
    assert.deepEqual(await state.secrets.listSecrets(namespace.id), [storedSecret]);
    assert.deepEqual(await state.secrets.lockSecret(namespace.id, storedSecret.id), storedSecret);
    await state.configurations.createConfiguration({
      ...configuration,
      secretBindings: acceptedBindings(storedSecret),
    });
    await state.agents.createAgent(agent);
  });

  await store.transact(async (state) => {
    await assertStateBindingDestinationGrammar(state, namespace.id, configuration, storedSecret);
    assert.equal(await state.secrets.hasReferences(namespace.id, storedSecret.id), true);
  });

  await assert.rejects(
    store.transact((state) =>
      state.secrets.createSecret({
        ...secret(namespace.id, storedSecret.name),
        backendRef: { ...storedSecret.backendRef, uid: randomUUID() },
      }),
    ),
    { name: "ResourceConflictError" },
  );

  await store.transact(async (state) => {
    await state.secrets.createSecret(secondSharedSecret);
    await state.configurations.createConfiguration({
      ...siblingConfiguration,
      secretBindings: {
        MODEL_KEY: bindingValue(storedSecret),
        SECONDARY_MODEL_KEY: bindingValue(secondSharedSecret),
      },
    });
    await state.agents.createAgent(siblingAgent);
    assert.deepEqual(
      new Set((await state.secrets.listSecrets(namespace.id)).map((item) => item.id)),
      new Set([storedSecret.id, secondSharedSecret.id]),
    );
    assert.equal(await state.secrets.hasReferences(namespace.id, secondSharedSecret.id), true);
  });

  const foreign = resources();
  const foreignSecret = secret(foreign.namespace.id);
  await store.transact(async (state) => {
    await state.namespaces.createNamespace(foreign.namespace);
    await state.secrets.createSecret(foreignSecret);
    assert.deepEqual(
      (await state.secrets.listSecrets(namespace.id))
        .map((item) => item.id)
        .includes(foreignSecret.id),
      false,
    );
  });
  await assert.rejects(
    store.transact((state) =>
      state.configurations.createConfiguration({
        ...configuration,
        id: identifier("cfg"),
        secretBindings: bindingFor(foreignSecret),
      }),
    ),
    { name: "ScopeViolationError" },
  );

  const configurationBlockerSecret = secret(namespace.id);
  const configurationBlocker = {
    ...configuration,
    id: identifier("cfg"),
    generation: 1,
    secretBindings: bindingFor(configurationBlockerSecret),
  };
  await store.transact(async (state) => {
    await state.secrets.createSecret(configurationBlockerSecret);
    await state.configurations.createConfiguration(configurationBlocker);
    assert.equal(
      await state.secrets.hasReferences(namespace.id, configurationBlockerSecret.id),
      true,
    );
  });
  await assert.rejects(
    store.transact((state) =>
      state.secrets.deleteSecret(namespace.id, configurationBlockerSecret.id),
    ),
    { name: "ScopeViolationError" },
  );

  await store.transact(async (state) => {
    const cleared = await state.configurations.advanceConfigurationGeneration(
      namespace.id,
      configurationBlocker.id,
      configurationBlocker.generation,
      {},
    );
    assert.equal(Object.hasOwn(cleared, "secretBindings"), false);
    assert.equal(
      await state.secrets.hasReferences(namespace.id, configurationBlockerSecret.id),
      false,
    );
    assert.equal(
      await state.secrets.deleteSecret(namespace.id, configurationBlockerSecret.id),
      true,
    );
  });

  // Service account token references must retain sources without ordinary environment bindings.
  const revisionSecret = secret(namespace.id);
  const activeSecret = secret(namespace.id);
  let activeRevisionId;
  await store.transact(async (state) => {
    await state.secrets.createSecret(revisionSecret);
    await state.secrets.createSecret(activeSecret);
    await state.agents.updateConfiguration(namespace.id, agent.id, configuration.id, undefined, {
      method: "codex_pat",
      source: bindingValue(revisionSecret).source,
    });
    const snapshot = revisionFor(agent, { ...configuration, generation: 3 }, revisionSecret, 1);
    await assert.rejects(
      state.revisions.createRevision({
        ...snapshot,
        harnessAuth: { ...snapshot.harnessAuth, method: "api_key" },
      }),
      { name: "ScopeViolationError" },
    );
    const revision = await state.revisions.createRevision(snapshot);
    assert.equal(revision.harnessAuth.method, "codex_pat");
    await state.agents.updateConfiguration(
      namespace.id,
      agent.id,
      configuration.id,
      undefined,
      null,
    );
    assert.equal(await state.secrets.hasReferences(namespace.id, revisionSecret.id), false);
    await state.operations.append({
      kind: "agent_revision",
      action: "reconcile",
      namespaceId: namespace.id,
      resourceId: revision.id,
      actorId: "principal-secret-state",
    });
    assert.equal(await state.secrets.hasReferences(namespace.id, revisionSecret.id), true);

    await state.agents.updateConfiguration(namespace.id, agent.id, configuration.id, undefined, {
      method: "codex_pat",
      source: bindingValue(activeSecret).source,
    });
    const activeRevision = await state.revisions.createRevision(
      revisionFor(agent, { ...configuration, generation: 3 }, activeSecret, 2),
    );
    activeRevisionId = activeRevision.id;
    await state.agents.compareAndSetActiveRevision(
      namespace.id,
      agent.id,
      undefined,
      activeRevision.id,
    );
    assert.equal(await state.secrets.hasReferences(namespace.id, activeSecret.id), true);
  });

  await assert.rejects(
    store.transact((state) => state.secrets.deleteSecret(namespace.id, activeSecret.id)),
    { name: "ScopeViolationError" },
  );

  await store.transact(async (state) => {
    await state.agents.updateConfiguration(namespace.id, agent.id, configuration.id, undefined, {
      method: "codex_pat",
      source: bindingValue(secondSharedSecret).source,
    });
    const replacementRevision = await state.revisions.createRevision(
      revisionFor(agent, { ...configuration, generation: 3 }, secondSharedSecret, 3),
    );
    await state.agents.compareAndSetActiveRevision(
      namespace.id,
      agent.id,
      activeRevisionId,
      replacementRevision.id,
    );
    assert.equal(await state.secrets.hasReferences(namespace.id, activeSecret.id), false);
    assert.equal(await state.secrets.deleteSecret(namespace.id, activeSecret.id), true);
  });

  await assert.rejects(
    store.transact((state) => state.secrets.deleteSecret(namespace.id, revisionSecret.id)),
    { name: "ScopeViolationError" },
  );

  return { namespace, agent, configuration, revisionSecret };
}

test("in-memory state persists Secret metadata and binding references without values", async () => {
  const { InMemoryPlatformState } = await import("../../packages/occ/src/state/platform-state.ts");
  await exerciseRepository(new InMemoryPlatformState());
});

test(
  "PostgreSQL state persists Secret metadata and enforces binding dependencies",
  requiresPostgres,
  async (context) => {
    const [{ Pool }, { PostgresPlatformState }] = await Promise.all([
      import("pg"),
      import("../../packages/occ/src/state/postgres-state.ts"),
    ]);
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    const store = new PostgresPlatformState(pool);

    const { namespace, agent, configuration, revisionSecret } = await exerciseRepository(store);
    const storedAuth = await pool.query(
      "SELECT harness_auth, harness_auth_secret_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
      [namespace.id, agent.id],
    );
    assert.equal(storedAuth.rows[0].harness_auth.method, "codex_pat");
    assert.equal(
      storedAuth.rows[0].harness_auth_secret_id,
      storedAuth.rows[0].harness_auth.source.id,
    );
    await assert.rejects(
      pool.query(
        "UPDATE occ.agents SET harness_auth = $3::jsonb WHERE namespace_id = $1 AND id = $2",
        [
          namespace.id,
          agent.id,
          JSON.stringify({
            method: "codex_pat",
            source: { kind: "secret", namespaceId: namespace.id, id: identifier("sec") },
          }),
        ],
      ),
      { code: "23503" },
    );
    const sqlSecret = secret(namespace.id, `sql-key-${randomUUID()}`);

    await store.transact((state) => state.secrets.createSecret(sqlSecret));
    for (const bindings of [
      bindingFor(sqlSecret, "CODEX_TOKEN"),
      bindingFor(sqlSecret, "OPENAI_API_KEY"),
      bindingFor(sqlSecret, "PATH"),
      tooManyBindings(sqlSecret),
    ]) {
      await assert.rejects(insertSqlConfiguration(pool, namespace.id, bindings), { code: "23514" });
    }

    await insertSqlConfiguration(pool, namespace.id, acceptedBindings(sqlSecret));

    await assert.rejects(
      pool.query(
        `INSERT INTO occ.configurations (id, namespace_id, kind, generation, secret_bindings, created_at)
       VALUES ($1, $2, 'agent', 1, $3::jsonb, now())`,
        [
          identifier("cfg"),
          namespace.id,
          JSON.stringify({
            INVALID: {
              source: { kind: "secret", namespaceId: namespace.id, id: sqlSecret.id },
              unexpected: true,
            },
          }),
        ],
      ),
      { code: "23514" },
    );

    await assert.rejects(
      pool.query(
        `INSERT INTO occ.secrets
       (id, namespace_id, name, driver_id, backend_namespace_name, backend_name,
        backend_key, backend_uid, created_at)
       VALUES ($1, $2, $3, 'kubernetes-secret', 'valid-ns', 'valid.secret',
        'value', $4, now())`,
        [identifier("sec"), identifier("ns"), `bad-namespace-${randomUUID()}`, randomUUID()],
      ),
      { code: "23503" },
    );

    const principalId = `principal-${randomUUID()}`;
    const roleId = `role-${randomUUID()}`;
    await pool.query(
      `INSERT INTO occ.iam_identities (id, namespace_id, agent_id, kind, issuer, subject)
     VALUES ($1, NULL, NULL, 'principal', 'postgres-secret-test', $2)`,
      [principalId, `subject-${randomUUID()}`],
    );
    await pool.query(
      `INSERT INTO occ.iam_roles (id, namespace_id, name, permissions)
     VALUES ($1, $2, $3, $4::jsonb)`,
      [
        roleId,
        namespace.id,
        `Secret operator ${randomUUID()}`,
        JSON.stringify([{ action: "operate", resourceKind: "secret" }]),
      ],
    );
    await pool.query(
      `INSERT INTO occ.iam_access_bindings
       (id, namespace_id, identity_subject_id, group_subject_id, role_id, resource_kind, resource_id)
     VALUES ($1, $2, $3, NULL, $4, 'secret', $5)`,
      [`binding-${randomUUID()}`, namespace.id, principalId, roleId, sqlSecret.id],
    );

    const other = resources();
    await store.transact(async (state) => {
      await state.namespaces.createNamespace(other.namespace);
      await state.configurations.createConfiguration(other.configuration);
      await state.agents.createAgent(other.agent);
    });
    await assert.rejects(
      pool.query(
        `INSERT INTO occ.iam_restrictions
         (id, namespace_id, action, resource_kind, resource_id, effect)
       VALUES ($1, $2, 'operate', 'secret', $3, 'deny')`,
        [`restriction-${randomUUID()}`, other.namespace.id, sqlSecret.id],
      ),
      { code: "23514" },
    );

    await assert.rejects(
      pool.query(
        `INSERT INTO occ.agent_revisions
         (id, namespace_id, agent_id, revision_number, admitted_spec, admitted_at)
       VALUES ($1, $2, $3, 99, $4::jsonb, now())`,
        [
          identifier("rev"),
          namespace.id,
          agent.id,
          JSON.stringify({
            configuration_id: configuration.id,
            configuration_kind: "agent",
            configuration_generation: 1,
            draft_spec: {},
            harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
            compute: { id: "compute-test", implementation: "deterministic-test" },
            secret_driver_id: "kubernetes-secret",
            secret_bindings: bindingFor(sqlSecret),
            unexpected: true,
          }),
        ],
      ),
      { code: "23514" },
    );

    await pool.query(
      `UPDATE occ.controller_work AS work
       SET state = 'succeeded',
           completed_at = clock_timestamp(),
           reason_code = 'REVISION_ACTIVATED',
           updated_at = clock_timestamp()
       FROM occ.agent_revisions AS revision
       WHERE work.namespace_id = $1
         AND work.revision_id = revision.id
         AND revision.namespace_id = $1
         AND revision.admitted_spec #>> '{harness_auth,source,namespaceId}' = $1
         AND revision.admitted_spec #>> '{harness_auth,source,id}' = $2`,
      [namespace.id, revisionSecret.id],
    );
    await store.transact(async (state) => {
      assert.equal(await state.secrets.hasReferences(namespace.id, revisionSecret.id), false);
      assert.equal(await state.secrets.deleteSecret(namespace.id, revisionSecret.id), true);
    });

    const columns = await pool.query(
      `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'occ' AND table_name = 'secrets'
     ORDER BY column_name`,
    );
    assert.ok(!columns.rows.some(({ column_name }) => column_name === "agent_id"));
    assert.ok(!columns.rows.some(({ column_name }) => /value|bytes|material/i.test(column_name)));
  },
);
