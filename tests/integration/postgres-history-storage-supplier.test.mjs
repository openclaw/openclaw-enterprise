import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

// This storage qualification requires a separately owned, disposable database
// installed through the supported, reviewed migration path.
// The resource owner must dispose that entire database: immutable committed audit
// evidence cannot be cleaned up by the application role. This file never installs
// a migration or provisions a server/database on a caller's behalf.
const databaseUrl = process.env.OCC_HISTORY_STORAGE_DATABASE_URL;
const migratorUrl = process.env.OCC_HISTORY_STORAGE_MIGRATOR_DATABASE_URL;
// A separately admitted fixture owner prepares exactly one drift scenario before
// selecting this mode. It runs only the supplier's read-only preflight; neither
// this case nor the ordinary writer suite grants privileges or changes defaults.
const unsafeConfiguration = process.env.OCC_HISTORY_STORAGE_UNSAFE_CONFIGURATION;
const requiresSupplier = {
  skip: !databaseUrl && "Select the owned History storage qualification database.",
  timeout: 90_000,
};
const identifier = (prefix) => `${prefix}_${randomUUID()}`;
const principalId = "principal-history-storage-test";

function selectedDatabase(value, role) {
  assert.ok(value, "Both application and migrator qualification URLs are required.");
  // Refuse controls before URL normalization can erase part of the supplied role.
  assert.ok(!/[\t\n\r]/.test(value), "Qualification URLs must not contain raw TAB, LF, or CR.");
  const url = new URL(value);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(["127.0.0.1", "[::1]", "localhost"].includes(url.hostname));
  assert.equal(url.search, "", "Qualification URLs must not contain query overrides.");
  assert.equal(url.hash, "", "Qualification URLs must not contain fragments.");
  // Literal role spelling avoids pg re-encoding percent escapes when a URL contains spaces.
  assert.equal(url.username, role, "Qualification URLs require the literal canonical username.");
  assert.match(url.pathname, /^\/openclaw_history_storage_[a-z0-9_]+$/);
  // An explicit port prevents inherited PGPORT from selecting another service.
  assert.ok(Number(url.port) > 0 && Number(url.port) <= 65535);
  return { host: url.hostname, port: url.port, database: url.pathname };
}

test("History qualification rejects endpoint and role overrides before opening pools", () => {
  const base = "postgresql://occ_app@127.0.0.1:55433/openclaw_history_storage_target";
  for (const suffix of [
    "?host=192.0.2.1",
    "?port=5433",
    "?user=occ_migrator",
    "?database=another_database",
    "?options=-c%20session_replication_role%3Dreplica",
    "#ignored",
  ]) {
    assert.throws(() => selectedDatabase(base + suffix, "occ_app"), { name: "AssertionError" });
  }
  // A literal-space password triggers pg connection-string normalization; encoded
  // role spellings must be refused before either application or migrator pool opens.
  for (const [username, role] of [
    ["occ%5Fapp", "occ_app"],
    ["occ%5Fmigrator", "occ_migrator"],
  ]) {
    const target = `postgresql://${username}:synthetic space@127.0.0.1:55433/openclaw_history_storage_target`;
    assert.throws(() => selectedDatabase(target, role), {
      name: "AssertionError",
      message: /Qualification URLs require the literal canonical username\./,
    });
    assert.deepEqual(selectedDatabase(target.replace(username, role), role), {
      host: "127.0.0.1",
      port: "55433",
      database: "/openclaw_history_storage_target",
    });
  }
  // Raw controls are stripped by URL parsing but may survive pg's space handling.
  // Refusal diagnostics must not retain credentials from either qualification URL.
  for (const [username, role] of [
    ["occ_\tapp", "occ_app"],
    ["occ_\napp", "occ_app"],
    ["occ_\rapp", "occ_app"],
    ["occ_\tmigrator", "occ_migrator"],
    ["occ_\nmigrator", "occ_migrator"],
    ["occ_\rmigrator", "occ_migrator"],
  ]) {
    const password = "synthetic diagnostic sentinel";
    const target = `postgresql://${username}:${password}@127.0.0.1:55433/openclaw_history_storage_target`;
    assert.throws(
      () => selectedDatabase(target, role),
      (error) => {
        assert.ok(error instanceof assert.AssertionError);
        assert.equal(error.message, "Qualification URLs must not contain raw TAB, LF, or CR.");
        for (const diagnostic of [
          JSON.stringify(Object.getOwnPropertyDescriptors(error)),
          String(error),
          error.stack,
        ]) {
          assert.equal(
            diagnostic.includes(password),
            false,
            "Rejected qualification credentials must not appear in error diagnostics.",
          );
          assert.equal(
            diagnostic.includes("postgresql://"),
            false,
            "Rejected qualification URLs must not appear in error diagnostics.",
          );
        }
        return true;
      },
    );
  }
  assert.throws(() => selectedDatabase(base, "occ_migrator"), { name: "AssertionError" });
  assert.throws(() => selectedDatabase(base.replace(":55433", ""), "occ_app"), {
    name: "AssertionError",
  });
  assert.deepEqual(selectedDatabase(base, "occ_app"), {
    host: "127.0.0.1",
    port: "55433",
    database: "/openclaw_history_storage_target",
  });
});

async function supplierPreflight() {
  const sql = await readFile(
    new URL("../../migrations/0038_agent_audit_ledger_metadata.sql", import.meta.url),
    "utf8",
  );
  // Execute the actual first supplier statement, never its schema mutations or
  // a second hand-written approximation of the configuration boundary.
  return sql.split("--> statement-breakpoint")[0];
}

const unsafeConfigurations = {
  "app-set": { grantee: "occ_app", privilege: "SET" },
  "migrator-set": { grantee: "occ_migrator", privilege: "SET" },
  "public-set": { grantee: "PUBLIC", privilege: "SET" },
  "app-alter-system": { grantee: "occ_app", privilege: "ALTER SYSTEM" },
  "app-replica": { role: "occ_app", database: false, value: "replica" },
  "migrator-replica": { role: "occ_migrator", database: false, value: "replica" },
  "database-replica": { role: null, database: true, value: "replica" },
  "app-database-replica": { role: "occ_app", database: true, value: "replica" },
  // Refuse even a safe-looking override that can mask an unsafe lower default.
  "migrator-origin-override": { role: "occ_migrator", database: false, value: "origin" },
  "masked-database-replica": {
    settings: [
      { role: null, database: true, value: "replica" },
      { role: "occ_migrator", database: false, value: "origin" },
    ],
  },
};

async function verifyUnsafeConfiguration(context) {
  assert.ok(Object.hasOwn(unsafeConfigurations, unsafeConfiguration), "Unknown drift scenario.");
  assert.deepEqual(
    selectedDatabase(databaseUrl, "occ_app"),
    selectedDatabase(migratorUrl, "occ_migrator"),
  );
  const scenario = unsafeConfigurations[unsafeConfiguration];
  const { Pool } = await import("pg");
  const migrator = new Pool({ connectionString: migratorUrl, max: 1, statement_timeout: 5_000 });
  context.after(() => migrator.end());
  assert.deepEqual((await migrator.query("SELECT current_user, session_user")).rows, [
    { current_user: "occ_migrator", session_user: "occ_migrator" },
  ]);
  if (scenario.grantee !== undefined) {
    const { rows } = await migrator.query(
      `
        SELECT grant_entry.privilege_type FROM pg_catalog.pg_parameter_acl AS parameter
        CROSS JOIN LATERAL pg_catalog.aclexplode(parameter.paracl) AS grant_entry
        WHERE parameter.parname = 'session_replication_role'
          AND grant_entry.grantee = CASE WHEN $1 = 'PUBLIC' THEN 0::oid
            ELSE (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1) END
          AND grant_entry.privilege_type = $2`,
      [scenario.grantee, scenario.privilege],
    );
    assert.ok(rows.length > 0, "The fixture must contain the selected real parameter grant.");
  } else {
    for (const setting of scenario.settings ?? [scenario]) {
      const { rows } = await migrator.query(
        `
        SELECT setting.setconfig FROM pg_catalog.pg_db_role_setting AS setting
        WHERE setting.setrole = CASE WHEN $1::text IS NULL THEN 0::oid
            ELSE (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1) END
          AND setting.setdatabase = CASE WHEN $2::boolean
            THEN (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())
            ELSE 0::oid END`,
        [setting.role, setting.database],
      );
      assert.ok(
        rows.some(({ setconfig }) =>
          setconfig.includes(`session_replication_role=${setting.value}`),
        ),
        "The fixture must contain the selected real login override.",
      );
    }
    if (unsafeConfiguration === "masked-database-replica") {
      assert.equal(
        (await migrator.query("SHOW session_replication_role")).rows[0].session_replication_role,
        "origin",
        "The migrator must look safe while the application inherits the database replica default.",
      );
    }
  }
  // The boundary refuses the actual configuration without attempting repairs.
  await assert.rejects(migrator.query(await supplierPreflight()), {
    code: "42501",
    message:
      "history storage requires origin sessions without replication-role control or login overrides",
  });
}

async function createResources(state, existingNamespace, repositorySnapshot) {
  let installation = await state.loadInstallation();
  if (installation === undefined) {
    installation = await state.transact((unit) =>
      unit.installations.createInstallation({
        id: identifier("ins"),
        name: "History storage qualification",
        createdAt: new Date().toISOString(),
      }),
    );
  }
  const createdAt = new Date().toISOString();
  const namespace = existingNamespace ?? {
    id: identifier("ns"),
    name: `History storage ${randomUUID()}`,
    status: "ready",
    createdAt,
  };
  const configuration = {
    id: identifier("cfg"),
    namespaceId: namespace.id,
    kind: "agent",
    generation: 1,
    createdAt,
  };
  const agent = {
    id: identifier("agt"),
    namespaceId: namespace.id,
    name: "History storage Agent",
    configurationId: configuration.id,
    executionMode: "embedded",
    backendId: null,
    harnessAuth: { method: "runtime" },
    servicePrincipalId: identifier("service-agent"),
    desiredRuntimeState: "stopped",
    status: "active",
    ...(repositorySnapshot === undefined
      ? {}
      : {
          repositoryBindings: repositorySnapshot.bindings.map(({ repositoryRef, profile }) => ({
            repositoryRef,
            profile,
          })),
        }),
    createdAt,
  };
  const revision = {
    id: identifier("rev"),
    namespaceId: namespace.id,
    agentId: agent.id,
    revision: 1,
    backendId: null,
    configurationId: configuration.id,
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration: {},
    harnessAuth: { method: "runtime" },
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    compute: { id: "compute-storage-test", implementation: "deterministic-test" },
    servicePrincipalId: agent.servicePrincipalId,
    ...(repositorySnapshot === undefined ? {} : { repositoryCredentials: repositorySnapshot }),
    createdAt,
  };
  await state.transact(async (unit) => {
    if (existingNamespace === undefined) {
      await unit.namespaces.createNamespace(namespace);
    }
    await unit.configurations.createConfiguration(configuration);
    await unit.agents.createAgent(agent);
    await unit.revisions.createRevision(revision);
  });
  return { installation, namespace, configuration, agent, revision };
}

function ordinaryEvent(owner) {
  return {
    id: identifier("aud"),
    installationId: owner.installation.id,
    namespaceId: owner.namespace.id,
    occurredAt: new Date().toISOString(),
    source: "occ",
    kind: "mutation",
    actorId: principalId,
    action: "openclaw.agents.update",
    resource: { kind: "agent", id: owner.agent.id, namespaceId: owner.namespace.id },
    outcome: "success",
    details: { changed: "configuration" },
  };
}

function producerFact(owner) {
  const admissionDecisionId = `admission-${randomUUID()}`;
  return {
    schema: "openclaw.audit-history/v1",
    id: identifier("aud"),
    installationId: owner.installation.id,
    namespaceId: owner.namespace.id,
    occurredAt: new Date().toISOString(),
    subject: { kind: "agent", id: owner.agent.id, namespaceId: owner.namespace.id },
    resource: { kind: "agent_revision", id: owner.revision.id, namespaceId: owner.namespace.id },
    source: "occ_admission",
    action: "openclaw.agents.deploy",
    phase: "accepted",
    result: "accepted",
    reasonCode: "ACCEPTED",
    initiator: { kind: "resolved", principalId },
    executor: { kind: "controller" },
    authorization: {
      kind: "decision",
      decision: "allowed",
      principalId,
      action: "deploy",
      resource: { kind: "agent", id: owner.agent.id, namespaceId: owner.namespace.id },
      iamDriverId: "iam-storage-test",
      admissionDecisionId,
    },
    causation: {
      requestId: identifier("req"),
      admissionDecisionId,
      revisionId: owner.revision.id,
    },
  };
}

// The predecessor State API has no History argument yet. Direct fact inserts
// exercise SQL validation only; ordinary State append/list below uses its real
// implementation. The later History receiver must add its own State roundtrip.
async function insertFact(client, fact, envelope = fact, authorizationMetadata) {
  return client.query(
    `INSERT INTO occ.audit_events
      (id, occurred_at, kind, actor_id, action, namespace_id, resource_kind, resource_id,
       outcome, details, history_fact)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)
     RETURNING *`,
    [
      envelope.id,
      envelope.occurredAt,
      envelope.result === "denied" ? "authorization_denial" : "mutation",
      envelope.initiator.principalId ?? principalId,
      envelope.action,
      envelope.namespaceId,
      envelope.resource.kind,
      envelope.resource.id,
      envelope.result === "denied"
        ? "denied"
        : ["failure", "unknown"].includes(envelope.result)
          ? "failure"
          : "success",
      JSON.stringify({
        __occAuditMetadata: {
          source: "occ",
          schemaVersion: 1,
          requestId: envelope.causation.requestId,
          admissionDecisionId: envelope.causation.admissionDecisionId,
          reasonCode: envelope.reasonCode,
          ...(authorizationMetadata === undefined ? {} : { authorization: authorizationMetadata }),
        },
      }),
      JSON.stringify(fact),
    ],
  );
}

async function ledgerRow(pool, id) {
  const { rows } = await pool.query("SELECT * FROM occ.audit_events WHERE id = $1", [id]);
  assert.equal(rows.length, 1);
  return rows[0];
}

function assertReceipt(row, owner, revisionId = null) {
  assert.match(row.ledger_sequence, /^[1-9][0-9]*$/);
  assert.ok(row.received_at instanceof Date);
  assert.ok(Number.isFinite(row.received_at.getTime()));
  assert.equal(row.retained_installation_id, owner.installation.id);
  assert.equal(row.retained_namespace_id, owner.namespace.id);
  assert.equal(row.retained_agent_id, owner.agent.id);
  assert.equal(row.retained_revision_id, revisionId);
}

async function enqueueClaim(queue, owner, target = "revision") {
  const work = {
    idempotencyKey: `history-test:${randomUUID()}`,
    namespaceId: owner.namespace.id,
    agentId: owner.agent.id,
    actorId: principalId,
    ...(target === "revision" ? { revisionId: owner.revision.id } : { agentTarget: "deleted" }),
    availableAt: new Date(0),
  };
  await queue.enqueue(work);
  const claim = await queue.claim();
  assert.equal(
    claim?.idempotencyKey,
    work.idempotencyKey,
    "Use an exclusive qualification database.",
  );
  return claim;
}

async function denyWithSavepoint(client, sql, values = []) {
  await client.query("SAVEPOINT denied_operation");
  try {
    await assert.rejects(client.query(sql, values), { code: "42501" });
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT denied_operation");
    await client.query("RELEASE SAVEPOINT denied_operation");
  }
}

test(
  unsafeConfiguration
    ? "History supplier refuses an owner-prepared replication configuration drift"
    : "History storage supplier through the real limited-role writers",
  requiresSupplier,
  async (context) => {
    if (unsafeConfiguration) {
      await verifyUnsafeConfiguration(context);
      return;
    }
    assert.deepEqual(
      selectedDatabase(databaseUrl, "occ_app"),
      selectedDatabase(migratorUrl, "occ_migrator"),
    );
    const [{ Pool }, { PostgresPlatformState }, { PostgresWorkQueue }, { migrateWithHistory }] =
      await Promise.all([
        import("pg"),
        import("../../packages/occ/src/state/postgres-state.ts"),
        import("../../packages/occ/src/state/postgres-work-queue.ts"),
        import("../../scripts/migration-history.mjs"),
      ]);
    const pool = new Pool({ connectionString: databaseUrl, max: 4, statement_timeout: 5_000 });
    const migrator = new Pool({ connectionString: migratorUrl, max: 1, statement_timeout: 5_000 });
    context.after(async () => {
      await Promise.all([pool.end(), migrator.end()]);
    });
    // Refuse drift and require the installed catalog produced by the real migrator.
    await migrator.query(await supplierPreflight());
    assert.equal(await migrateWithHistory(migrator, { checkOnly: true }), "completed");
    const identity = await pool.query(
      "SELECT current_user, session_user, current_setting('session_replication_role') AS replication_role",
    );
    assert.deepEqual(identity.rows, [
      { current_user: "occ_app", session_user: "occ_app", replication_role: "origin" },
    ]);
    const state = new PostgresPlatformState(pool);
    const owner = await createResources(state);
    const queue = new PostgresWorkQueue(pool, { leaseDurationMs: 60_000, random: () => 0 });

    await context.test(
      "State append stamps new ordinary rows and rollback removes the evidence",
      async () => {
        const event = ordinaryEvent(owner);
        await state.auditSink.append(event);
        const row = await ledgerRow(pool, event.id);
        assertReceipt(row, owner);
        assert.equal(row.history_fact, null);
        assert.equal(row.occurred_at.toISOString(), event.occurredAt);
        assert.deepEqual(row.details.changed, "configuration");
        const listed = await state.transact((unit) => unit.audit.list());
        assert.equal(listed.find(({ id }) => id === event.id)?.actorId, principalId);
        const refused = ordinaryEvent(owner);
        const rollback = new Error("rollback requested by the qualification case");
        await assert.rejects(
          state.transact(async (unit) => {
            await unit.audit.append(refused);
            throw rollback;
          }),
          (error) => error === rollback,
        );
        assert.equal(
          (await pool.query("SELECT 1 FROM occ.audit_events WHERE id = $1", [refused.id])).rowCount,
          0,
        );
      },
    );

    await context.test(
      "accepted admission binds authorization to the resolved initiator",
      async () => {
        const accepted = producerFact(owner);
        await insertFact(pool, accepted, accepted, accepted.authorization);
        assertReceipt(await ledgerRow(pool, accepted.id), owner, owner.revision.id);
        // Even mutually consistent optional metadata cannot substitute another
        // authorized principal for the person who initiated this accepted action.
        for (const withMetadata of [false, true]) {
          const contradictory = producerFact(owner);
          contradictory.authorization.principalId = "principal-other";
          await assert.rejects(
            insertFact(
              pool,
              contradictory,
              contradictory,
              withMetadata ? contradictory.authorization : undefined,
            ),
            { code: "23514" },
          );
          assert.equal(
            (await pool.query("SELECT 1 FROM occ.audit_events WHERE id = $1", [contradictory.id]))
              .rowCount,
            0,
          );
        }
      },
    );

    await context.test(
      "ordinary denials keep unavailable targets without invented Agent parentage",
      async () => {
        const other = await createResources(state);
        const absentNamespace = identifier("ns");
        const cases = [
          {
            name: "missing Namespace",
            namespaceId: absentNamespace,
            kind: "agent",
            id: owner.agent.id,
            retainedNamespaceId: null,
          },
          {
            name: "missing Agent",
            namespaceId: owner.namespace.id,
            kind: "agent",
            id: identifier("agt"),
            retainedNamespaceId: owner.namespace.id,
          },
          {
            name: "Agent in another Namespace",
            namespaceId: owner.namespace.id,
            kind: "agent",
            id: other.agent.id,
            retainedNamespaceId: owner.namespace.id,
          },
          {
            name: "revision in another Namespace",
            namespaceId: owner.namespace.id,
            kind: "agent_revision",
            id: other.revision.id,
            retainedNamespaceId: owner.namespace.id,
          },
          {
            name: "unscoped Agent",
            namespaceId: undefined,
            kind: "agent",
            id: owner.agent.id,
            retainedNamespaceId: null,
          },
          {
            name: "non-Agent resource",
            namespaceId: owner.namespace.id,
            kind: "configuration",
            id: owner.configuration.id,
            retainedNamespaceId: owner.namespace.id,
          },
          {
            name: "mismatched Namespace resource",
            namespaceId: owner.namespace.id,
            kind: "namespace",
            id: other.namespace.id,
            retainedNamespaceId: owner.namespace.id,
          },
        ];
        for (const scenario of cases) {
          const event = {
            ...ordinaryEvent(owner),
            kind: "authorization_denial",
            outcome: "denied",
            namespaceId: scenario.namespaceId,
            resource: { kind: scenario.kind, id: scenario.id, namespaceId: scenario.namespaceId },
          };
          await state.auditSink.append(event);
          const row = await ledgerRow(pool, event.id);
          assert.equal(row.outcome, "denied", scenario.name);
          assert.ok(row.received_at instanceof Date, scenario.name);
          assert.equal(row.retained_installation_id, owner.installation.id, scenario.name);
          // Namespace evidence proves existence of the declared row scope only; an
          // absent Agent/revision association must stay absent even for a real ID.
          assert.equal(row.retained_namespace_id, scenario.retainedNamespaceId, scenario.name);
          assert.equal(row.retained_agent_id, null, scenario.name);
          assert.equal(row.retained_revision_id, null, scenario.name);
          assert.equal(row.history_fact, null, scenario.name);
        }
        const strict = producerFact(owner);
        strict.namespaceId = absentNamespace;
        strict.subject.namespaceId = absentNamespace;
        strict.resource.namespaceId = absentNamespace;
        strict.authorization.resource.namespaceId = absentNamespace;
        await assert.rejects(insertFact(pool, strict), { code: "23514" });
      },
    );

    await context.test(
      "closed SQL facts bind to the exact row and persisted revision owner",
      async () => {
        const fact = producerFact(owner);
        const { rows } = await insertFact(pool, fact);
        assertReceipt(rows[0], owner, owner.revision.id);
        assert.deepEqual(rows[0].history_fact, fact);
        const other = await createResources(state);
        const mutations = [
          (value) => {
            value.extra = true;
          },
          (value) => {
            delete value.schema;
          },
          (value) => {
            value.source = null;
          },
          (value) => {
            value.source = "occ_legacy";
          },
          (value) => {
            value.receipt = { kind: "database_receipt", receivedAt: value.occurredAt };
          },
          (value) => {
            value.sequence = "1";
          },
          (value) => {
            value.causation.attempt = 1.5;
          },
          (value) => {
            value.causation.attempt = 9_007_199_254_740_992;
          },
          (value) => {
            value.causation.attempt = null;
          },
          (value) => {
            value.causation.workId = [];
          },
          (value) => {
            value.causation.workId = "x".repeat(513);
          },
          (value) => {
            value.causation.workId = "é".repeat(257);
          },
          (value) => {
            value.causation.workId = "Bearer synthetic-credential";
          },
          (value) => {
            value.causation.workId = "éBearer synthetic-credential";
          },
          (value) => {
            value.causation.workId = "unsafe\u0080identifier";
          },
          (value) => {
            value.causation.workId = { deep: { object: {} } };
          },
          (value) => {
            value.causation.parentEventId = value.id;
          },
          (value) => {
            value.executor.kind = "agent";
          },
          (value) => {
            value.reasonCode = "ARBITRARY_EXCEPTION_TEXT";
          },
          (value) => {
            value.authorization = { kind: "unresolved" };
          },
          (value) => {
            value.authorization.decision = "denied";
          },
          (value) => {
            value.authorization.action = "read";
          },
          (value) => {
            value.authorization.admissionDecisionId = "other-decision";
          },
          (value) => {
            value.phase = "observed";
            value.result = "success";
          },
          (value) => {
            value.id = identifier("aud");
          },
          (value) => {
            value.installationId = identifier("ins");
          },
          (value) => {
            value.subject.id = other.agent.id;
          },
          (value) => {
            value.resource.id = other.revision.id;
            value.causation.revisionId = other.revision.id;
          },
          (value) => {
            value.occurredAt = "2026-02-30T00:00:00.000Z";
          },
        ];
        for (const mutate of mutations) {
          const envelope = producerFact(owner);
          const invalid = structuredClone(envelope);
          mutate(invalid);
          await assert.rejects(insertFact(pool, invalid, envelope), { code: "23514" });
          assert.equal(
            (await pool.query("SELECT 1 FROM occ.audit_events WHERE id = $1", [envelope.id]))
              .rowCount,
            0,
          );
        }
        // Matching a forged row envelope still cannot make another Agent's revision
        // authentic: this assertion exercises the database association join itself.
        const sibling = await createResources(state, owner.namespace);
        const wrongOwner = producerFact(owner);
        wrongOwner.resource.id = sibling.revision.id;
        wrongOwner.causation.revisionId = sibling.revision.id;
        await assert.rejects(insertFact(pool, wrongOwner), { code: "23514" });
      },
    );

    await context.test(
      "the fact budget counts compact JSON bytes, including escaped safe strings",
      async () => {
        const fact = producerFact(owner);
        const escaped = "\\".repeat(512);
        fact.initiator.principalId = escaped;
        fact.authorization.principalId = escaped;
        fact.authorization.iamDriverId = escaped;
        fact.authorization.admissionDecisionId = escaped;
        fact.causation.admissionDecisionId = escaped;
        fact.causation.operationId = escaped;
        fact.causation.workId = escaped;
        fact.causation.attemptId = escaped;
        const bytes = () => Buffer.byteLength(JSON.stringify(fact));
        for (const key of ["operationId", "workId", "attemptId"]) {
          while (bytes() > 8192 && fact.causation[key].length > 1) {
            if (bytes() === 8193) {
              fact.causation[key] = `a${fact.causation[key].slice(1)}`;
            } else {
              fact.causation[key] = fact.causation[key].slice(1);
            }
          }
        }
        assert.equal(bytes(), 8192);
        await insertFact(pool, fact);
        const oversized = structuredClone(fact);
        oversized.id = identifier("aud");
        oversized.causation.operationId += "a";
        assert.equal(Buffer.byteLength(JSON.stringify(oversized)), 8193);
        await assert.rejects(insertFact(pool, oversized), { code: "23514" });
      },
    );

    await context.test(
      "effective producer privileges exclude trusted metadata and administrative paths",
      async () => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          for (const column of [
            "ledger_sequence",
            "received_at",
            "retained_installation_id",
            "retained_namespace_id",
            "retained_agent_id",
            "retained_revision_id",
          ]) {
            await denyWithSavepoint(
              client,
              `INSERT INTO occ.audit_events (${column}) VALUES (DEFAULT)`,
            );
          }
          for (const sql of [
            "INSERT INTO occ.audit_events (ledger_sequence) OVERRIDING SYSTEM VALUE VALUES (1)",
            "UPDATE occ.audit_events SET action = 'forged'",
            "DELETE FROM occ.audit_events",
            "TRUNCATE occ.audit_events",
            "SELECT nextval('occ.audit_events_ledger_sequence_seq')",
            "SELECT setval('occ.audit_events_ledger_sequence_seq', 1)",
            "SELECT occ.stamp_audit_ledger_metadata()",
            "SELECT occ.validate_audit_history_fact('{}'::jsonb)",
            "ALTER TABLE occ.audit_events DISABLE TRIGGER audit_events_stamp_metadata",
            "ALTER TABLE occ.audit_events OWNER TO occ_app",
            "CREATE TABLE occ.history_storage_forbidden (id integer)",
            "SET ROLE occ_migrator",
            "SET session_replication_role = replica",
            "SET LOCAL session_replication_role = replica",
            "SELECT set_config('session_replication_role', 'replica', false)",
            "SELECT set_config('session_replication_role', 'replica', true)",
          ]) {
            await denyWithSavepoint(client, sql);
          }
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
        const defaults = await pool.query(`
      SELECT column_default, is_identity, identity_generation
      FROM information_schema.columns
      WHERE table_schema = 'occ' AND table_name = 'audit_events' AND column_name = 'received_at'`);
        assert.deepEqual(defaults.rows, [
          { column_default: null, is_identity: "NO", identity_generation: null },
        ]);
      },
    );

    await context.test(
      "all queue evidence mechanisms stamp atomically and retain revision parentage",
      async () => {
        for (const operation of ["complete", "defer", "retry", "fail", "recoverStale"]) {
          const claim = await enqueueClaim(queue, owner);
          const before = await pool.query(
            "SELECT count(*)::integer AS count FROM occ.audit_events",
          );
          if (operation === "complete") {
            await queue.complete(claim);
          } else if (operation === "defer") {
            await queue.defer(claim, { code: "DEPENDENCY_UNAVAILABLE" });
          } else if (operation === "retry") {
            await queue.retry(claim, { code: "DEPENDENCY_UNAVAILABLE" });
          } else if (operation === "fail") {
            await queue.fail(claim, { code: "INVALID_TARGET" });
          } else {
            // Move an actual claimed lease into the past; no fake timer or patched
            // queue method supplies the recovery result.
            await pool.query(
              "UPDATE occ.controller_work SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE idempotency_key = $1",
              [claim.idempotencyKey],
            );
            assert.equal((await queue.recoverStale()).recovered, 1);
          }
          const after = await pool.query("SELECT count(*)::integer AS count FROM occ.audit_events");
          assert.equal(after.rows[0].count, before.rows[0].count + 1);
          const evidence = await pool.query(
            "SELECT * FROM occ.audit_events WHERE action = 'reconcile' ORDER BY ledger_sequence DESC LIMIT 1",
          );
          assertReceipt(evidence.rows[0], owner, owner.revision.id);
          assert.equal(evidence.rows[0].history_fact, null);
          // Clear a requeued case through the actual claim/completion path before
          // the next independent operation uses the exclusive fixture queue.
          if (["defer", "retry", "recoverStale"].includes(operation)) {
            const next = await queue.claim();
            assert.equal(next?.idempotencyKey, claim.idempotencyKey);
            await queue.complete(next);
          }
        }
      },
    );

    await context.test("namespace-only Work remains ordinary scoped evidence", async () => {
      const key = `history-namespace:${randomUUID()}`;
      await queue.enqueue({
        idempotencyKey: key,
        namespaceId: owner.namespace.id,
        namespaceTarget: "ready",
        actorId: principalId,
        availableAt: new Date(0),
      });
      const claim = await queue.claim();
      assert.equal(claim?.idempotencyKey, key);
      await queue.complete(claim);
      const { rows } = await pool.query(
        "SELECT * FROM occ.audit_events WHERE action = 'reconcile' AND resource_kind = 'namespace' AND resource_id = $1 ORDER BY ledger_sequence DESC LIMIT 1",
        [owner.namespace.id],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].retained_installation_id, owner.installation.id);
      assert.equal(rows[0].retained_namespace_id, owner.namespace.id);
      assert.equal(rows[0].retained_agent_id, null);
      assert.equal(rows[0].retained_revision_id, null);
      assert.equal(rows[0].history_fact, null);
      assert.ok(rows[0].received_at instanceof Date);
    });

    for (const source of ["claimed", "queued"]) {
      await context.test(
        `exhausted ${source} Namespace recovery requires stamped audit evidence`,
        async () => {
          const namespace = {
            id: identifier("ns"),
            name: `History recovery ${source}`,
            status: "provisioning",
            createdAt: new Date().toISOString(),
          };
          await state.transact((unit) => unit.namespaces.createNamespace(namespace));
          const key = `history-namespace-exhausted:${randomUUID()}`;
          const recovery = new PostgresWorkQueue(pool, { maxAttempts: 1, random: () => 0 });
          await recovery.enqueue({
            idempotencyKey: key,
            namespaceId: namespace.id,
            namespaceTarget: "ready",
            actorId: principalId,
            availableAt: new Date(0),
          });
          const claim = await recovery.claim();
          assert.equal(claim?.idempotencyKey, key);
          // A crashed last attempt has an expired lease. A queued attempt can
          // exhaust its budget when the restarted worker lowers maxAttempts.
          if (source === "claimed") {
            await pool.query(
              "UPDATE occ.controller_work SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE idempotency_key = $1",
              [key],
            );
          } else {
            await new PostgresWorkQueue(pool, { maxAttempts: 2, random: () => 0 }).retry(claim, {
              code: "DEPENDENCY_UNAVAILABLE",
            });
          }
          const reason = source === "claimed" ? "LEASE_EXPIRED" : "MAX_ATTEMPTS_EXHAUSTED";
          const snapshot = async () => {
            const result = await pool.query(
              `SELECT namespace.status, work.state, work.claim_token, work.lease_expires_at,
                      work.completed_at,
                      (SELECT count(*)::integer FROM occ.audit_events
                       WHERE resource_id = $2 AND details->>'reasonCode' = $3) AS evidence
               FROM occ.controller_work AS work
               JOIN occ.namespaces AS namespace ON namespace.id = work.namespace_id
               WHERE work.idempotency_key = $1`,
              [key, namespace.id, reason],
            );
            assert.equal(result.rows.length, 1);
            return result.rows[0];
          };
          const before = await snapshot();
          const constraint = `history_recovery_reject_${randomUUID().replaceAll("-", "")}`;
          // Extend the ordinary recovery tests with the new storage trigger in
          // place: rejecting its stamped row must undo Namespace and Work changes.
          await migrator.query(
            `ALTER TABLE occ.audit_events ADD CONSTRAINT ${constraint} CHECK (NOT (action = 'reconcile' AND resource_id = '${namespace.id}' AND details->>'reasonCode' = '${reason}')) NOT VALID`,
          );
          try {
            await assert.rejects(recovery.recoverStale(), { code: "23514" });
            assert.deepEqual(await snapshot(), before);
          } finally {
            await migrator.query(`ALTER TABLE occ.audit_events DROP CONSTRAINT ${constraint}`);
          }
          const result = await recovery.recoverStale();
          assert.equal(result.failedPermanent, 1);
          assert.equal(result.recovered, source === "claimed" ? 1 : 0);
          assert.equal(result.exhaustedQueued, source === "queued" ? 1 : 0);
          const { completed_at, ...after } = await snapshot();
          assert.ok(completed_at instanceof Date);
          assert.deepEqual(after, {
            status: "failed",
            state: "failed_permanent",
            claim_token: null,
            lease_expires_at: null,
            evidence: 1,
          });
          const evidence = await pool.query(
            "SELECT * FROM occ.audit_events WHERE resource_id = $1 AND details->>'reasonCode' = $2",
            [namespace.id, reason],
          );
          assert.equal(evidence.rows.length, 1);
          const row = evidence.rows[0];
          assert.match(row.ledger_sequence, /^[1-9][0-9]*$/);
          assert.ok(row.received_at instanceof Date);
          assert.equal(row.retained_installation_id, owner.installation.id);
          assert.equal(row.retained_namespace_id, namespace.id);
          assert.equal(row.retained_agent_id, null);
          assert.equal(row.retained_revision_id, null);
          assert.equal(row.history_fact, null);
          assert.equal(row.actor_id, principalId);
          assert.equal(row.outcome, "failure");
          assert.deepEqual(row.details, { reasonCode: reason, attemptCount: 1 });
        },
      );
    }

    await context.test("ledger rejection rolls back the real queue transition", async () => {
      const claim = await enqueueClaim(queue, owner);
      const name = `history_storage_reject_${randomUUID().replaceAll("-", "")}`;
      // NOT VALID permits existing evidence while rejecting new matching writes.
      // The fixture migrator owns the temporary constraint and always removes it.
      await migrator.query(
        `ALTER TABLE occ.audit_events ADD CONSTRAINT ${name} CHECK (NOT (action = 'reconcile' AND resource_id = '${owner.revision.id}')) NOT VALID`,
      );
      try {
        const before = await pool.query("SELECT count(*)::integer AS count FROM occ.audit_events");
        await assert.rejects(queue.complete(claim), { code: "23514" });
        assert.equal((await queue.findWork(claim.idempotencyKey)).state, "claimed");
        assert.equal((await queue.findWork(claim.idempotencyKey)).claimToken, claim.claimToken);
        assert.deepEqual(
          (await pool.query("SELECT count(*)::integer AS count FROM occ.audit_events")).rows,
          before.rows,
        );
      } finally {
        await migrator.query(`ALTER TABLE occ.audit_events DROP CONSTRAINT ${name}`);
      }
      await queue.complete(claim);
    });

    await context.test(
      "continuing maintenance failure and multirow stale recovery use the real Work paths",
      async () => {
        const continuing = await createResources(state);
        await state.transact(async (unit) => {
          await unit.agents.compareAndSetActiveRevision(
            continuing.namespace.id,
            continuing.agent.id,
            undefined,
            continuing.revision.id,
          );
          await unit.agents.transitionAgentDesiredRuntimeState(
            continuing.namespace.id,
            continuing.agent.id,
            "stopped",
            "running",
          );
        });
        const maintenanceKey = `agent_revision:${continuing.revision.id}:maintenance:0`;
        await queue.enqueue({
          idempotencyKey: maintenanceKey,
          namespaceId: continuing.namespace.id,
          agentId: continuing.agent.id,
          revisionId: continuing.revision.id,
          actorId: principalId,
          availableAt: new Date(0),
        });
        const maintenance = await queue.claim();
        assert.equal(maintenance?.idempotencyKey, maintenanceKey);
        await queue.fail(
          maintenance,
          { code: "DEPENDENCY_UNAVAILABLE" },
          { continuingRevision: true },
        );
        const failure = await pool.query(
          "SELECT * FROM occ.audit_events WHERE action = 'reconcile' ORDER BY ledger_sequence DESC LIMIT 1",
        );
        assertReceipt(failure.rows[0], continuing, continuing.revision.id);
        const owners = [await createResources(state), await createResources(state)];
        const claims = [];
        for (const resource of owners) {
          claims.push(await enqueueClaim(queue, resource));
        }
        await pool.query(
          "UPDATE occ.controller_work SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE idempotency_key = ANY($1::text[])",
          [claims.map((claim) => claim.idempotencyKey)],
        );
        const recovered = await queue.recoverStale({ limit: 100 });
        assert.equal(recovered.recovered, 2);
        assert.equal(recovered.requeued, 2);
        for (const resource of owners) {
          const evidence = await pool.query(
            "SELECT * FROM occ.audit_events WHERE action = 'reconcile' AND resource_id = $1 ORDER BY ledger_sequence DESC LIMIT 1",
            [resource.revision.id],
          );
          assertReceipt(evidence.rows[0], resource, resource.revision.id);
        }
        for (let index = 0; index < 2; index += 1) {
          const claim = await queue.claim();
          assert.ok(claims.some(({ idempotencyKey }) => idempotencyKey === claim?.idempotencyKey));
          await queue.complete(claim);
        }
      },
    );

    await context.test(
      "an ordinary completion adds no wait behind a held Namespace row",
      async () => {
        const claim = await enqueueClaim(queue, owner);
        const blocker = await pool.connect();
        try {
          await blocker.query("BEGIN");
          await blocker.query("SELECT id FROM occ.namespaces WHERE id = $1 FOR UPDATE", [
            owner.namespace.id,
          ]);
          // complete() already owns its Work update. The real INSERT trigger must
          // finish while another transaction still owns the Namespace lock.
          await queue.complete(claim);
        } finally {
          await blocker.query("ROLLBACK");
          blocker.release();
        }
      },
    );

    await context.test(
      "finalization preserves refusal, rollback and evidence after physical deletion",
      async () => {
        const { repositoryCredentials } =
          await import("../fixtures/repository-credentials/session-state.mjs");
        const credentials = repositoryCredentials({ deadlineWallMs: Date.now() + 3_600_000 });
        const deleting = await createResources(state, undefined, credentials);
        // Use the current State producer to retain a real repository cleanup
        // obligation admitted before deletion Work; the finalizer must retain it.
        const attempt = {
          namespaceId: deleting.namespace.id,
          agentId: deleting.agent.id,
          revisionId: deleting.revision.id,
          repositoryRef: credentials.bindings[0].repositoryRef,
          admissionId: `admission-${randomUUID()}`,
          durationSeconds: 60,
          deadlineWallMs: credentials.deadlineWallMs,
          createdAt: deleting.revision.createdAt,
        };
        await state.transact(async (unit) => {
          await unit.agents.transitionAgentDesiredRuntimeState(
            deleting.namespace.id,
            deleting.agent.id,
            "stopped",
            "running",
          );
          await unit.repositorySessions.createAttempt(attempt);
          await unit.repositorySessions.advanceAttempt({
            admissionId: attempt.admissionId,
            expectedPhase: "opening",
            phase: "closing",
            updatedAt: attempt.createdAt,
          });
          await unit.agents.transitionAgentDesiredRuntimeState(
            deleting.namespace.id,
            deleting.agent.id,
            "running",
            "stopped",
          );
        });
        const priorFact = producerFact(deleting);
        await insertFact(pool, priorFact);
        const claim = await enqueueClaim(queue, deleting, "deleted");
        await assert.rejects(
          queue.completeAgentDeletion(
            { ...claim, claimToken: randomUUID() },
            deleting.namespace.id,
            deleting.agent.id,
          ),
          { name: "WorkClaimLostError" },
        );
        await assert.rejects(
          queue.completeAgentDeletion(claim, deleting.namespace.id, deleting.agent.id),
          { name: "WorkClaimLostError" },
        );
        await pool.query("UPDATE occ.agents SET status = 'deleting' WHERE id = $1", [
          deleting.agent.id,
        ]);
        const cleanup = await queue.enqueueRepositoryCleanup(claim, {
          namespaceId: deleting.namespace.id,
          agentId: deleting.agent.id,
          revisionId: deleting.revision.id,
        });
        assert.ok(cleanup, "Deletion transfers the pending session cleanup before finalization.");
        const retainedBefore = await state.read((view) =>
          view.repositorySessions.findAttempt(attempt.admissionId),
        );
        assert.equal(retainedBefore.liveRevisionId, deleting.revision.id);

        // A real later DELETE error must roll back the earlier success INSERT and
        // preserve the original claim. The private migrator owns this scoped fault;
        // it does not replace the finalizer or grant additional application rights.
        const name = `history_storage_fault_${randomUUID().replaceAll("-", "")}`;
        await migrator.query(
          `CREATE FUNCTION occ.${name}() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN RAISE EXCEPTION 'history qualification deletion fault' USING ERRCODE = 'P0001'; END; $$`,
        );
        try {
          await migrator.query(
            `CREATE TRIGGER ${name} AFTER DELETE ON occ.agents FOR EACH ROW WHEN (OLD.id = '${deleting.agent.id}') EXECUTE FUNCTION occ.${name}()`,
          );
          const count = await pool.query("SELECT count(*)::integer AS count FROM occ.audit_events");
          await assert.rejects(
            queue.completeAgentDeletion(claim, deleting.namespace.id, deleting.agent.id),
            { code: "P0001" },
          );
          assert.deepEqual(
            (await pool.query("SELECT count(*)::integer AS count FROM occ.audit_events")).rows,
            count.rows,
          );
          assert.equal(
            (await pool.query("SELECT 1 FROM occ.agents WHERE id = $1", [deleting.agent.id]))
              .rowCount,
            1,
          );
          assert.equal((await queue.findWork(claim.idempotencyKey)).claimToken, claim.claimToken);
          assert.deepEqual(
            await state.read((view) => view.repositorySessions.findAttempt(attempt.admissionId)),
            retainedBefore,
          );
          assert.equal(
            (await queue.findWork(cleanup.idempotencyKey)).revisionId,
            deleting.revision.id,
          );
        } finally {
          await migrator.query(`DROP TRIGGER IF EXISTS ${name} ON occ.agents`);
          await migrator.query(`DROP FUNCTION occ.${name}()`);
        }

        assert.equal(
          await queue.completeAgentDeletion(claim, deleting.namespace.id, deleting.agent.id),
          "completed",
        );
        assert.equal(
          (await pool.query("SELECT 1 FROM occ.agents WHERE id = $1", [deleting.agent.id]))
            .rowCount,
          0,
        );
        assert.equal(
          (
            await pool.query("SELECT 1 FROM occ.agent_revisions WHERE id = $1", [
              deleting.revision.id,
            ])
          ).rowCount,
          0,
        );
        assertReceipt(await ledgerRow(pool, priorFact.id), deleting, deleting.revision.id);
        assert.deepEqual(
          await state.read((view) => view.repositorySessions.findAttempt(attempt.admissionId)),
          { ...retainedBefore, liveRevisionId: null },
        );
        const retainedWork = await queue.findWork(cleanup.idempotencyKey);
        assert.equal(retainedWork.state, "queued");
        assert.equal(retainedWork.agentId, undefined);
        assert.equal(retainedWork.revisionId, undefined);
        assert.equal(retainedWork.actorId, principalId);
        const deletion = await pool.query(
          "SELECT * FROM occ.audit_events WHERE action = 'openclaw.agents.lifecycle.delete' AND resource_id = $1",
          [deleting.agent.id],
        );
        assert.equal(deletion.rows.length, 1);
        assertReceipt(deletion.rows[0], deleting);
        assert.equal(
          deletion.rows[0].history_fact,
          null,
          "Deletion is an ordinary event, not a new closed action.",
        );
        await assert.rejects(insertFact(pool, producerFact(deleting)), { code: "23514" });
      },
    );
  },
);
