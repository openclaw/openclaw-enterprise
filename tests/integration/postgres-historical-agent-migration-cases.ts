import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import pg from "pg";
import type { Pool, PoolClient } from "pg";

type OwnedPostgres = {
  migrationUrl: string;
  port: number;
  composeArgs: readonly string[];
};

type MigrationDependencies = {
  ownedPostgres: () => Promise<OwnedPostgres>;
  runCommand: (fixture: OwnedPostgres, command: string, args: string[]) => Promise<string>;
  migrationsDirectory: string;
};

type MigrationStep = { predecessor: string; target: string };
type RefusalState = "active_runtime" | "harness_revision" | "harness_account";

const agentStop = { predecessor: "0015_agent_plugins.sql", target: "0016_agent_stop.sql" };
const harnessAuth = { predecessor: agentStop.target, target: "0017_harness_auth_binding.sql" };
const workOutcome = {
  predecessor: "0018_runtime_harness_auth.sql",
  target: "0019_controller_work_terminal_outcome.sql",
};

async function prepareHistoricalDatabase(
  context: TestContext,
  { ownedPostgres, runCommand, migrationsDirectory }: MigrationDependencies,
  scope: "agent_stop" | "work_outcome",
  { predecessor, target }: MigrationStep,
) {
  const fixture = await ownedPostgres();
  const database = `openclaw_ci_${scope}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const migrationUrl = new URL(fixture.migrationUrl);
  migrationUrl.pathname = `/${database}`;
  const applicationUrl = new URL(migrationUrl);
  applicationUrl.username = "occ_app";
  applicationUrl.password = "occ-app-local";
  const migrator = new pg.Pool({ connectionString: migrationUrl.toString(), max: 1 });
  const app = new pg.Pool({ connectionString: applicationUrl.toString(), max: 1 });

  function administer(databaseName: string, statement: string) {
    return runCommand(fixture, "docker", [
      ...fixture.composeArgs,
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      databaseName,
      "-c",
      statement,
    ]);
  }

  // A failed create response can still leave the case-owned database behind.
  context.after(async () => {
    try {
      await app.end();
    } finally {
      try {
        await migrator.end();
      } finally {
        await administer("postgres", `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      }
    }
  });
  await administer("postgres", `CREATE DATABASE ${database}`);
  await administer(
    database,
    `GRANT CREATE ON DATABASE ${database} TO occ_migrator; CREATE SCHEMA occ AUTHORIZATION occ_migrator; CREATE SCHEMA drizzle AUTHORIZATION occ_migrator; REVOKE CREATE ON SCHEMA public FROM PUBLIC;`,
  );

  assert.deepEqual((await migrator.query<{ role: string }>("SELECT current_user AS role")).rows, [
    { role: "occ_migrator" },
  ]);
  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < target)
    .sort();
  assert.equal(migrationFiles.at(-1), predecessor);
  for (const name of migrationFiles) {
    await migrator.query(await readFile(join(migrationsDirectory, name), "utf8"));
  }

  assert.deepEqual((await app.query<{ role: string }>("SELECT current_user AS role")).rows, [
    { role: "occ_app" },
  ]);
  return { migrator, app, targetSql: await readFile(join(migrationsDirectory, target), "utf8") };
}

async function inHistoricalTransaction(app: Pool, seed: (client: PoolClient) => Promise<void>) {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await seed(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type LegacyNamespace = { namespaceId: string; configurationId: string; createdAt: string | null };

async function seedNamespace(
  client: PoolClient,
  { namespaceId, configurationId, createdAt }: LegacyNamespace,
  name: string,
) {
  await client.query(
    `INSERT INTO occ.namespaces (id, name, status, created_at)
     VALUES ($1, $2, 'ready', COALESCE($3::timestamptz, clock_timestamp()))`,
    [namespaceId, name, createdAt],
  );
  await client.query(
    `INSERT INTO occ.configurations (id, namespace_id, kind, generation, created_at)
     VALUES ($1, $2, 'agent', 1, COALESCE($3::timestamptz, clock_timestamp()))`,
    [configurationId, namespaceId, createdAt],
  );
}

async function seedAgent(
  client: PoolClient,
  { namespaceId, configurationId, createdAt }: LegacyNamespace,
  agentId: string,
  name: string,
) {
  const principalId = `service-agent-${agentId}`;
  await client.query(
    `INSERT INTO occ.iam_identities (id, namespace_id, agent_id, kind)
     VALUES ($1, $2, $3, 'service_principal')`,
    [principalId, namespaceId, agentId],
  );
  await client.query(
    `INSERT INTO occ.agents
       (id, namespace_id, name, configuration_id, backend_id, execution_mode,
        service_principal_id, created_at)
     VALUES ($1, $2, $3, $4, NULL, 'dedicated', $5, COALESCE($6::timestamptz, clock_timestamp()))`,
    [agentId, namespaceId, name, configurationId, principalId, createdAt],
  );
}

function legacyAdmittedSpec(configurationId: string) {
  return {
    configuration_id: configurationId,
    configuration_kind: "agent",
    configuration_generation: 1,
    draft_spec: {},
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    compute: { id: "kubernetes", implementation: "test" },
  };
}

type LegacyAdmittedSpec = ReturnType<typeof legacyAdmittedSpec> & {
  harness_auth?: { method: "runtime" };
};

async function seedRevision(
  client: PoolClient,
  { namespaceId, createdAt }: LegacyNamespace,
  revision: {
    agentId: string;
    revisionId: string;
    revisionNumber: number;
    spec: LegacyAdmittedSpec;
  },
) {
  await client.query(
    `INSERT INTO occ.agent_revisions
       (id, namespace_id, agent_id, revision_number, admitted_spec, backend_id, admitted_at)
     VALUES ($1, $2, $3, $4, $5, NULL, COALESCE($6::timestamptz, clock_timestamp()))`,
    [
      revision.revisionId,
      namespaceId,
      revision.agentId,
      revision.revisionNumber,
      revision.spec,
      createdAt,
    ],
  );
}

export async function assertLegacyAgentMigrationRefusal(
  context: TestContext,
  dependencies: MigrationDependencies,
  legacyState: RefusalState,
) {
  const active = legacyState === "active_runtime";
  const { migrator, app, targetSql } = await prepareHistoricalDatabase(
    context,
    dependencies,
    "agent_stop",
    active ? agentStop : harnessAuth,
  );
  const namespaceId = `ns_${randomUUID()}`;
  const configurationId = `cfg_${randomUUID()}`;
  const namespace = { namespaceId, configurationId, createdAt: null };
  const agentId = `agt_${randomUUID()}`;
  const revisionId = `rev_${randomUUID()}`;
  const serviceAccountId = legacyState === "harness_account" ? `sa_${randomUUID()}` : null;
  const agentName = `active-agent-${randomUUID()}`;
  const spec = legacyAdmittedSpec(configurationId);

  // Commit mutually linked Agent and identity rows together. Give the two
  // harness cases mutually exclusive evidence so each refusal branch is exercised.
  await inHistoricalTransaction(app, async (client) => {
    await seedNamespace(client, namespace, `active-agent-${randomUUID()}`);
    await seedAgent(client, namespace, agentId, agentName);
    if (serviceAccountId === null) {
      await seedRevision(client, namespace, { agentId, revisionId, revisionNumber: 1, spec });
    } else {
      await client.query(
        "INSERT INTO occ.service_accounts (id, namespace_id, name) VALUES ($1, $2, $3)",
        [serviceAccountId, namespaceId, "legacy account"],
      );
      await client.query("UPDATE occ.agents SET service_account_id = $1 WHERE id = $2", [
        serviceAccountId,
        agentId,
      ]);
    }
    if (active) {
      await client.query(
        "UPDATE occ.agents SET active_revision_id = $1 WHERE namespace_id = $2 AND id = $3",
        [revisionId, namespaceId, agentId],
      );
    }
  });

  await assert.rejects(migrator.query(targetSql), (error: unknown) => {
    assert.ok(error instanceof pg.DatabaseError);
    if (active) {
      assert.equal(error.code, "55000");
      assert.equal(
        error.message,
        "Agent stop migration requires active revisions and pending revision work to be removed before cutover",
      );
    } else {
      assert.equal(error.code, "23514");
      assert.match(error.message, /^Legacy Agent authentication state is unsupported/);
    }
    return true;
  });

  // Observe the old schema and rows as the application. A refusal must retain
  // the active pointer, admitted snapshot or legacy account that made cutover unsafe.
  type Agent = {
    name: string;
    configuration_id: string;
    active_revision_id: string | null;
    service_account_id: string | null;
  };
  // node-postgres returns the historical bigint revision number as text.
  type Revision = { id: string; revision_number: string; admitted_spec: unknown };
  type Account = { id: string; name: string; credential: unknown };
  const agents = await app.query<Agent>(
    `SELECT name, configuration_id, active_revision_id, service_account_id
     FROM occ.agents WHERE namespace_id = $1 AND id = $2`,
    [namespaceId, agentId],
  );
  assert.deepEqual(agents.rows, [
    {
      name: agentName,
      configuration_id: configurationId,
      active_revision_id: active ? revisionId : null,
      service_account_id: serviceAccountId,
    },
  ]);
  const revisions = await app.query<Revision>(
    `SELECT id, revision_number, admitted_spec
     FROM occ.agent_revisions WHERE namespace_id = $1 AND agent_id = $2`,
    [namespaceId, agentId],
  );
  assert.deepEqual(
    revisions.rows,
    serviceAccountId === null
      ? [{ id: revisionId, revision_number: "1", admitted_spec: spec }]
      : [],
  );
  const accounts = await app.query<Account>(
    `SELECT id, name, credential FROM occ.service_accounts WHERE namespace_id = $1`,
    [namespaceId],
  );
  assert.deepEqual(
    accounts.rows,
    serviceAccountId === null
      ? []
      : [{ id: serviceAccountId, name: "legacy account", credential: null }],
  );
  const columns = await app.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'occ' AND table_name = 'agents' AND column_name = $1`,
    [active ? "desired_runtime_state" : "harness_auth"],
  );
  assert.deepEqual(columns.rows, []);
}

export async function assertLegacyControllerWorkBackfill(
  context: TestContext,
  dependencies: MigrationDependencies,
) {
  const { migrator, app, targetSql } = await prepareHistoricalDatabase(
    context,
    dependencies,
    "work_outcome",
    workOutcome,
  );
  const namespaceId = `ns_${randomUUID()}`;
  const configurationId = `cfg_${randomUUID()}`;
  const namespace = { namespaceId, configurationId, createdAt: "2026-09-20T00:00:00Z" };
  const firstAgentId = `agt_${randomUUID()}`;
  const secondAgentId = `agt_${randomUUID()}`;
  const firstRevisionId = `rev_${randomUUID()}`;
  const secondRevisionId = `rev_${randomUUID()}`;
  const failedRevisionId = `rev_${randomUUID()}`;
  const actorId = "legacy-worker";
  await inHistoricalTransaction(app, async (client) => {
    await seedNamespace(client, namespace, `terminal-work-${randomUUID()}`);
    for (const agentId of [firstAgentId, secondAgentId]) {
      await seedAgent(
        client,
        namespace,
        agentId,
        `agent-${agentId.slice("agt_".length, "agt_".length + 8)}`,
      );
    }

    const spec: LegacyAdmittedSpec = {
      ...legacyAdmittedSpec(configurationId),
      harness_auth: { method: "runtime" },
    };
    const revisions = [
      { agentId: firstAgentId, revisionId: firstRevisionId, revisionNumber: 1 },
      { agentId: firstAgentId, revisionId: secondRevisionId, revisionNumber: 2 },
      { agentId: secondAgentId, revisionId: failedRevisionId, revisionNumber: 1 },
    ];
    for (const revision of revisions) {
      await seedRevision(client, namespace, { ...revision, spec });
    }
    // The active pointer alone cannot prove activation. Only the first revision
    // has a durable activation audit.
    await client.query("UPDATE occ.agents SET active_revision_id = $1 WHERE id = $2", [
      secondRevisionId,
      firstAgentId,
    ]);

    // Two failed Work rows share a revision, but only attempt four has matching audit evidence.
    const workRows: [
      key: string,
      agentId: string | null,
      revisionId: string | null,
      namespaceTarget: "ready" | null,
      state: "succeeded" | "failed_permanent",
      attemptCount: number,
    ][] = [
      ["legacy-revision-activated", firstAgentId, firstRevisionId, null, "succeeded", 2],
      ["legacy-revision-without-activation", firstAgentId, secondRevisionId, null, "succeeded", 3],
      ["legacy-namespace-reconciled", null, null, "ready", "succeeded", 1],
      ["legacy-revision-failed", secondAgentId, failedRevisionId, null, "failed_permanent", 4],
      ["legacy-revision-unknown", secondAgentId, failedRevisionId, null, "failed_permanent", 5],
    ];
    for (const [key, agentId, revisionId, namespaceTarget, state, attemptCount] of workRows) {
      await client.query(
        `INSERT INTO occ.controller_work
           (idempotency_key, namespace_id, agent_id, revision_id, actor_id,
            namespace_target, state, available_at, attempt_count, completed_at,
            created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7,
           '2026-09-20T00:00:00Z'::timestamptz, $8,
           '2026-09-20T00:01:00Z'::timestamptz,
           '2026-09-20T00:00:00Z'::timestamptz,
           '2026-09-20T00:01:00Z'::timestamptz)`,
        [key, namespaceId, agentId, revisionId, actorId, namespaceTarget, state, attemptCount],
      );
    }
    await client.query(
      `INSERT INTO occ.controller_work
         (idempotency_key, namespace_id, actor_id, namespace_target, state,
          available_at, attempt_count, created_at, updated_at)
       VALUES ('legacy-namespace-pending', $1, $2, 'ready', 'queued',
         '2026-09-20T00:00:00Z'::timestamptz, 0,
         '2026-09-20T00:00:00Z'::timestamptz,
         '2026-09-20T00:00:00Z'::timestamptz)`,
      [namespaceId, actorId],
    );

    await client.query(
      `INSERT INTO occ.audit_events
         (id, occurred_at, kind, actor_id, action, namespace_id,
          resource_kind, resource_id, outcome, details)
       VALUES ($1, '2026-09-20T00:00:30Z'::timestamptz, 'mutation', $2,
         'openclaw.agents.lifecycle.activate', $3, 'agent_revision', $4, 'success', NULL)`,
      [`aud_${randomUUID()}`, actorId, namespaceId, firstRevisionId],
    );

    const reconcileRows: [
      occurredAt: string,
      resourceKind: "agent_revision" | "namespace",
      resourceId: string,
      outcome: "success" | "failure",
      reason: "RECONCILE_SUCCEEDED" | "CONVERGENCE_DEADLINE_EXCEEDED",
      attemptCount: number,
    ][] = [
      [
        "2026-09-20T00:01:00.100Z",
        "agent_revision",
        secondRevisionId,
        "success",
        "RECONCILE_SUCCEEDED",
        3,
      ],
      ["2026-09-20T00:01:00.200Z", "namespace", namespaceId, "success", "RECONCILE_SUCCEEDED", 1],
      [
        "2026-09-20T00:01:00.300Z",
        "agent_revision",
        failedRevisionId,
        "failure",
        "CONVERGENCE_DEADLINE_EXCEEDED",
        4,
      ],
    ];
    for (const [
      occurredAt,
      resourceKind,
      resourceId,
      outcome,
      reasonCode,
      attemptCount,
    ] of reconcileRows) {
      await client.query(
        `INSERT INTO occ.audit_events
           (id, occurred_at, kind, actor_id, action, namespace_id,
            resource_kind, resource_id, outcome, details)
         VALUES ($1, $2::timestamptz, 'mutation', $3, 'reconcile', $4,
           $5, $6, $7, jsonb_build_object('reasonCode', $8::text, 'attemptCount', $9::integer))`,
        [
          `aud_${randomUUID()}`,
          occurredAt,
          actorId,
          namespaceId,
          resourceKind,
          resourceId,
          outcome,
          reasonCode,
          attemptCount,
        ],
      );
    }
  });

  await migrator.query(targetSql);
  type MigratedWork = {
    idempotency_key: string;
    state: "queued" | "succeeded" | "failed_permanent";
    completed_at: Date | null;
    reason_code: string | null;
    result_data: unknown;
  };
  const migrated = await app.query<MigratedWork>(
    `SELECT idempotency_key, state, completed_at, reason_code, result_data
     FROM occ.controller_work ORDER BY idempotency_key`,
  );
  const completedAt = new Date("2026-09-20T00:01:00Z");
  assert.deepEqual(migrated.rows, [
    {
      idempotency_key: "legacy-namespace-pending",
      state: "queued",
      completed_at: null,
      reason_code: null,
      result_data: null,
    },
    {
      idempotency_key: "legacy-namespace-reconciled",
      state: "succeeded",
      completed_at: completedAt,
      reason_code: "RECONCILE_SUCCEEDED",
      result_data: null,
    },
    {
      idempotency_key: "legacy-revision-activated",
      state: "succeeded",
      completed_at: completedAt,
      reason_code: "REVISION_ACTIVATED",
      result_data: null,
    },
    {
      idempotency_key: "legacy-revision-failed",
      state: "failed_permanent",
      completed_at: completedAt,
      reason_code: "CONVERGENCE_DEADLINE_EXCEEDED",
      result_data: null,
    },
    {
      idempotency_key: "legacy-revision-unknown",
      state: "failed_permanent",
      completed_at: completedAt,
      reason_code: "LEGACY_OUTCOME_UNKNOWN",
      result_data: null,
    },
    {
      idempotency_key: "legacy-revision-without-activation",
      state: "succeeded",
      completed_at: completedAt,
      reason_code: "RECONCILE_SUCCEEDED",
      result_data: null,
    },
  ]);
}
