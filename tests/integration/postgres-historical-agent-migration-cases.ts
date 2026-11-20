import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import pg from "pg";
import type { Client, Pool, PoolClient } from "pg";
import type {
  MigrationCommandResult,
  MigrationReceipt,
} from "./postgres-migration-transaction-command-cases.ts";

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

type DrizzleInput = {
  database: string;
  migrationUrl: string;
  port: number;
  composeArgs: readonly unknown[];
};
type DrizzleFixture = OwnedPostgres & { database: string };
type MigrationCheckResult = { code: number; stdout: string; stderr: string };
type DrizzleDependencies = {
  migrationsDirectory: string;
  runCommand: (fixture: DrizzleFixture, command: string, args: string[]) => Promise<unknown>;
  runMigrationCheck: (fixture: DrizzleFixture, configPath: string) => Promise<unknown>;
  logEvents: (stderr: string) => unknown;
  temporaryDirectory: (context: TestContext, prefix: string) => Promise<string>;
};

type HistoricalPermission = { action: string; resourceKind: string };
type HistoricalRole = {
  id: string;
  namespace_id: string | null;
  name: string;
  permissions: HistoricalPermission[];
};
type PresetAction = "create" | "read" | "update" | "delete";
type PresetPermission = { action: PresetAction; resourceKind: "preset" };
type PresetPolicyFixture = {
  installationId: string;
  namespaceId: string;
  legacyPermissions: HistoricalPermission[];
  presetPermissions: PresetPermission[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function assertDrizzleFixture(value: unknown): asserts value is DrizzleFixture {
  assert.ok(isRecord(value));
  assert.equal(typeof value.database, "string");
  assert.equal(typeof value.migrationUrl, "string");
  assert.equal(typeof value.port, "number");
  assert.ok(
    isUnknownArray(value.composeArgs) && value.composeArgs.every((arg) => typeof arg === "string"),
  );
}

function assertMigrationCheckResult(value: unknown): asserts value is MigrationCheckResult {
  assert.ok(isRecord(value));
  assert.equal(typeof value.code, "number");
  assert.equal(typeof value.stdout, "string");
  assert.equal(typeof value.stderr, "string");
}

function isHistoricalPermission(value: unknown): value is HistoricalPermission {
  return (
    isRecord(value) && typeof value.action === "string" && typeof value.resourceKind === "string"
  );
}

function isPresetPermission(value: unknown): value is PresetPermission {
  return (
    isHistoricalPermission(value) &&
    value.resourceKind === "preset" &&
    ["create", "read", "update", "delete"].includes(value.action)
  );
}

// The root test remains JavaScript. Check its historical fixtures without rejecting
// deliberately unsupported custom permissions before passing them to the real IAM Driver.
function assertPresetPolicyFixture(value: unknown): asserts value is PresetPolicyFixture {
  assert.ok(isRecord(value));
  assert.equal(typeof value.installationId, "string");
  assert.equal(typeof value.namespaceId, "string");
  assert.ok(
    isUnknownArray(value.legacyPermissions) &&
      value.legacyPermissions.every(isHistoricalPermission),
  );
  assert.ok(
    isUnknownArray(value.presetPermissions) && value.presetPermissions.every(isPresetPermission),
  );
}

function historicalRole(
  permissions: HistoricalPermission[],
  overrides: Partial<HistoricalRole> = {},
): HistoricalRole {
  return {
    id: `role_admin_${randomUUID()}`,
    namespace_id: null,
    name: "Installation administrator",
    permissions,
    ...overrides,
  };
}

async function seedHistoricalRoles(
  pool: Pool,
  roles: HistoricalRole[],
  boundRoles: HistoricalRole[],
) {
  for (const entry of roles) {
    await pool.query("INSERT INTO occ.iam_roles VALUES ($1, $2, $3, $4::jsonb)", [
      entry.id,
      entry.namespace_id,
      entry.name,
      JSON.stringify(entry.permissions),
    ]);
  }
  const principals: string[] = [];
  for (const entry of boundRoles) {
    const principalId = `prn_${randomUUID()}`;
    principals.push(principalId);
    await pool.query(
      "INSERT INTO occ.iam_identities (id, kind, issuer, subject) VALUES ($1, 'principal', 'upgrade', $1)",
      [principalId],
    );
    await pool.query(
      "INSERT INTO occ.iam_access_bindings (id, identity_subject_id, role_id) VALUES ($1, $2, $3)",
      [`binding_admin_${randomUUID()}`, principalId, entry.id],
    );
  }
  return principals;
}

export async function assertDrizzleJournalPreserved(
  context: TestContext,
  pool: Pool,
  fixture: DrizzleInput,
  {
    migrationsDirectory,
    runCommand,
    runMigrationCheck,
    logEvents,
    temporaryDirectory,
  }: DrizzleDependencies,
) {
  assertDrizzleFixture(fixture);
  const commandOutput = async (command: string, args: string[]) => {
    const output = await runCommand(fixture, command, args);
    assert.ok(typeof output === "string");
    return output;
  };
  const migrationCheck = async (path: string) => {
    const result = await runMigrationCheck(fixture, path);
    assertMigrationCheckResult(result);
    return result;
  };
  const server = await pool.query<Record<string, unknown>>(
    "SELECT current_setting('server_version_num') AS version",
  );
  const serverVersion = Number(server.rows[0]?.version);
  assert.ok(serverVersion >= 180_000 && serverVersion < 190_000, "PostgreSQL 18 is required.");
  const dumpVersion = await commandOutput("docker", [
    ...fixture.composeArgs,
    "pg_dump",
    "--version",
  ]);
  assert.match(dumpVersion, /^pg_dump \(PostgreSQL\) 18(?:\.|\s)/);
  const journalQuery = "SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id";
  const beforeJournal = (await pool.query<Record<string, unknown>>(journalQuery)).rows;
  const sourceJournal: unknown = JSON.parse(
    await readFile(join(migrationsDirectory, "meta", "_journal.json"), "utf8"),
  );
  assert.ok(beforeJournal.length > 0, "Native preparation must apply the original migrations.");
  assert.ok(isRecord(sourceJournal) && isUnknownArray(sourceJournal.entries));
  assert.equal(beforeJournal.length, sourceJournal.entries.length);
  const dumpArgs = [
    ...fixture.composeArgs,
    "pg_dump",
    "--schema-only",
    "--restrict-key=phase2compatibility",
    "-U",
    "occ_migrator",
    "-d",
    fixture.database,
  ];
  const beforeSchema = await commandOutput("docker", dumpArgs);
  assert.ok(beforeSchema.trim().length > 0);

  // Native preparation performed the first migration; rerun the supported entry point.
  await commandOutput("corepack", ["pnpm", "db:migrate"]);
  assert.deepEqual((await pool.query<Record<string, unknown>>(journalQuery)).rows, beforeJournal);
  // The history cases run the script text directly; prove pnpm forwards --check too.
  const checked = await commandOutput("corepack", ["pnpm", "db:migrate:production", "--check"]);
  assert.ok(
    checked
      .split("\n")
      .some(
        (line) => line === JSON.stringify({ event: "migration.checked", history: "completed" }),
      ),
  );

  // The migration command reads only the logging section of the Installation startup file,
  // through the controller's own startup reader. A file the controller would refuse fails the
  // command with no migration output and the usual single structured failure line.
  const configDirectory = await temporaryDirectory(context, "occ-migration-config-");
  const startupFile = async (name: string, contents: string) => {
    const path = join(configDirectory, name);
    await writeFile(path, contents, "utf8");
    return path;
  };
  // One refusal from each layer: the logging section, the file reader, and the path rules.
  const refused = [
    await startupFile("trace.yaml", "logging:\n  level: trace\n"),
    await startupFile("invalid.yaml", "logging: [\n"),
    "relative/startup.yaml",
  ];
  for (const path of refused) {
    const result = await migrationCheck(path);
    assert.equal(result.code, 1, path);
    assert.equal(result.stdout, "", path);
    assert.deepEqual(
      logEvents(result.stderr),
      [
        {
          severity: "ERROR",
          service: "occ-migration",
          event: "migration.failed",
          code: "MIGRATION_FAILED",
        },
      ],
      path,
    );
  }
  // An accepted file sets the command's log level: info keeps the success event, warn drops it.
  const checkedOutput = `${JSON.stringify({ event: "migration.checked", history: "completed" })}\n`;
  const atInfo = await migrationCheck(await startupFile("info.yaml", "logging:\n  level: info\n"));
  assert.equal(atInfo.code, 0);
  assert.equal(atInfo.stdout, checkedOutput);
  assert.deepEqual(logEvents(atInfo.stderr), [
    { severity: "INFO", service: "occ-migration", event: "migration.checked" },
  ]);
  const atWarn = await migrationCheck(await startupFile("warn.yaml", "logging:\n  level: warn\n"));
  assert.equal(atWarn.code, 0);
  assert.equal(atWarn.stdout, checkedOutput);
  assert.deepEqual(logEvents(atWarn.stderr), []);
  assert.equal(await commandOutput("docker", dumpArgs), beforeSchema);
}

export async function assertPresetPolicyUpgrade(
  pool: Pool,
  migrationsDirectory: string,
  fixture: unknown,
) {
  assertPresetPolicyFixture(fixture);
  const { installationId, namespaceId, legacyPermissions, presetPermissions } = fixture;
  const presetRead = presetPermissions[1];
  assert.ok(presetRead);
  const stock = historicalRole(legacyPermissions);
  const reordered = historicalRole(legacyPermissions, {
    permissions: [...legacyPermissions].reverse(),
  });
  const reduced = historicalRole(legacyPermissions, { permissions: legacyPermissions.slice(1) });
  const roles = [
    stock,
    reordered,
    reduced,
    historicalRole(legacyPermissions, {
      permissions: [...legacyPermissions, { action: "update", resourceKind: "namespace" }],
    }),
    historicalRole(legacyPermissions, { name: "Custom administrator" }),
    historicalRole(legacyPermissions, { id: `role_${randomUUID()}` }),
    historicalRole(legacyPermissions, { namespace_id: namespaceId }),
    historicalRole(legacyPermissions, { permissions: [...legacyPermissions, presetRead] }),
  ];
  const principals = await seedHistoricalRoles(pool, roles, [stock, reduced]);
  assert.ok(principals[0] && principals[1]);
  const [{ NativeIAMDriver }, { PostgresPlatformState }] = await Promise.all([
    import("../../packages/iam/src/index.ts"),
    import("../../packages/occ/src/state/postgres-state.ts"),
  ]);
  const iam = new NativeIAMDriver(new PostgresPlatformState(pool));
  const presetId = `pre_${randomUUID()}`;
  const authorize = (
    principalId: string,
    action: PresetAction | "administer",
    kind: "preset" | "installation" | "namespace" = "preset",
  ) => {
    let id = namespaceId;
    if (kind === "installation") {
      id = installationId;
    } else if (kind === "preset" && action !== "create") {
      id = presetId;
    }
    return iam.authorize({
      principalId,
      action,
      resource: {
        kind,
        id,
        ...(kind === "installation" ? {} : { namespaceId }),
      },
    });
  };
  assert.equal((await authorize(principals[0], "create")).allowed, false);
  assert.equal((await authorize(principals[0], "administer", "installation")).allowed, true);

  // Run the repository migration itself, not copied UPDATE text or a test-only migrator.
  await pool.query(await readFile(join(migrationsDirectory, "0024_agent_presets.sql"), "utf8"));
  await pool.query(
    "INSERT INTO occ.presets (id, namespace_id, name, template, created_at) VALUES ($1, $2, 'Upgrade', '{}'::jsonb, now())",
    [presetId, namespaceId],
  );
  const upgraded = new Set([stock.id, reordered.id]);
  for (const entry of roles) {
    const actual = (
      await pool.query<Record<string, unknown>>("SELECT * FROM occ.iam_roles WHERE id = $1", [
        entry.id,
      ])
    ).rows[0];
    assert.deepEqual(actual, {
      ...entry,
      permissions: upgraded.has(entry.id)
        ? [...entry.permissions, ...presetPermissions]
        : entry.permissions,
    });
  }
  for (const { action } of presetPermissions) {
    assert.equal((await authorize(principals[0], action)).allowed, true);
    assert.equal((await authorize(principals[1], action)).allowed, false);
  }
  assert.equal((await authorize(principals[0], "administer", "installation")).allowed, true);
  assert.equal((await authorize(principals[0], "read", "namespace")).allowed, true);
  assert.equal((await authorize(principals[1], "read", "namespace")).allowed, true);
}

type HistoricalDatabase = { migrationUrl: string; migrator: Client; app: Client };
type GuardFlag =
  "--check-for-installation" | "--apply-for-installation" | "--require-current-for-installation";
type GuardCommand = (
  db: HistoricalDatabase,
  mode: "production",
  flag: GuardFlag,
  refusal: RegExp | undefined,
  installationId: string,
) => Promise<MigrationCommandResult>;
type HistorySnapshot = Record<string, unknown> & { receipts: MigrationReceipt[] };
type SnapshotOperation = (db: HistoricalDatabase) => Promise<unknown>;
type GuardOperations = { runHistoryCommand: GuardCommand; historySnapshot: SnapshotOperation };
type CompletedHistory = (
  db: HistoricalDatabase,
  previous: readonly MigrationReceipt[],
) => Promise<void>;
type SeedOptions = {
  computeAdmission: boolean;
  executionAdmission: boolean;
  harnessSettings: boolean;
  restartContinuation?: boolean;
};
type SeedAgent = (
  db: HistoricalDatabase,
  namespace: string,
  options: SeedOptions,
) => Promise<unknown>;
type MigrateHistory = (db: HistoricalDatabase) => Promise<MigrationCommandResult>;

const refusedHistory = { ok: false, code: "MIGRATION_HISTORY_UNSUPPORTED" };
const guardedCommands = ["--check-for-installation", "--apply-for-installation"] as const;

function assertHistoricalDatabase(value: unknown): asserts value is HistoricalDatabase {
  assert.ok(isRecord(value));
  assert.equal(typeof value.migrationUrl, "string");
  assert.ok(value.migrator instanceof pg.Client);
  assert.ok(value.app instanceof pg.Client);
}

function isMigrationReceipt(value: unknown): value is MigrationReceipt {
  return (
    isRecord(value) &&
    typeof value.id === "number" &&
    typeof value.hash === "string" &&
    (value.created_at === null || typeof value.created_at === "string")
  );
}

function assertHistorySnapshot(value: unknown): asserts value is HistorySnapshot {
  assert.ok(isRecord(value));
  assert.ok(isUnknownArray(value.receipts) && value.receipts.every(isMigrationReceipt));
}

function assertSeededAgent(value: unknown): asserts value is { agent: string; revision: string } {
  assert.ok(isRecord(value));
  assert.equal(typeof value.agent, "string");
  assert.equal(typeof value.revision, "string");
}

export async function assertEmptyInstallationHistory(
  empty: unknown,
  expected: string,
  { runHistoryCommand, historySnapshot }: GuardOperations,
) {
  assertHistoricalDatabase(empty);
  const emptyBefore = await historySnapshot(empty);
  for (const flag of guardedCommands) {
    assert.deepEqual(
      await runHistoryCommand(empty, "production", flag, /empty Installation history/, expected),
      refusedHistory,
    );
    assert.deepEqual(await historySnapshot(empty), emptyBefore);
  }
}

export async function assertGuardedInstallationUpgrade(
  pending: unknown,
  expected: string,
  different: string,
  {
    runHistoryCommand,
    historySnapshot,
    canonicalData,
    assertCompletedHistory,
  }: GuardOperations & {
    canonicalData: (db: HistoricalDatabase) => Promise<unknown>;
    assertCompletedHistory: CompletedHistory;
  },
) {
  assertHistoricalDatabase(pending);
  const data = await canonicalData(pending);
  const before = await historySnapshot(pending);
  assertHistorySnapshot(before);
  assert.equal(before.receipts.length, 81);
  for (const flag of guardedCommands) {
    assert.deepEqual(
      await runHistoryCommand(
        pending,
        "production",
        flag,
        /does not own the expected Installation/,
        different,
      ),
      refusedHistory,
    );
    assert.deepEqual(await historySnapshot(pending), before);
    assert.deepEqual(await canonicalData(pending), data);
  }
  // A supported pending history is eligible for downtime, but the check itself
  // must leave the catalog and the receipts unchanged.
  assert.deepEqual(
    await runHistoryCommand(pending, "production", "--check-for-installation", undefined, expected),
    { ok: true, history: "preAuthenticationStates" },
  );
  assert.deepEqual(await historySnapshot(pending), before);
  assert.deepEqual(
    await runHistoryCommand(
      pending,
      "production",
      "--require-current-for-installation",
      undefined,
      expected,
    ),
    { ok: false, code: "MIGRATION_HISTORY_PENDING" },
  );
  assert.deepEqual(await historySnapshot(pending), before);

  assert.deepEqual(
    await runHistoryCommand(pending, "production", "--apply-for-installation", undefined, expected),
    { ok: true, history: "preAuthenticationStates" },
  );
  // Compare the complete canonical ledger and preserve every original receipt,
  // including its ID, regardless of how many migrations follow the predecessor.
  await assertCompletedHistory(pending, before.receipts);
  const after = await historySnapshot(pending);
  assertHistorySnapshot(after);
  assert.ok(after.receipts.length > before.receipts.length);
  assert.deepEqual(await canonicalData(pending), data);
  assert.deepEqual(
    await runHistoryCommand(pending, "production", "--check-for-installation", undefined, expected),
    { ok: true, history: "completed" },
  );
  assert.deepEqual(await historySnapshot(pending), after);
  assert.deepEqual(
    (
      await pending.migrator.query<{ prior_gone: boolean; current_exists: boolean }>(
        "SELECT to_regclass('occ.connection_sessions') IS NULL AS prior_gone, to_regclass('occ.authentication_states') IS NOT NULL AS current_exists",
      )
    ).rows,
    [{ prior_gone: true, current_exists: true }],
  );
  assert.deepEqual(
    await runHistoryCommand(
      pending,
      "production",
      "--require-current-for-installation",
      /does not own the expected Installation/,
      different,
    ),
    refusedHistory,
  );
  assert.deepEqual(
    await runHistoryCommand(
      pending,
      "production",
      "--require-current-for-installation",
      undefined,
      expected,
    ),
    { ok: true, history: "completed" },
  );
  assert.deepEqual(await historySnapshot(pending), after);
}

export async function assertNativeRestartUpgrade(
  db: unknown,
  prefix: number,
  {
    seedCanonicalAgent,
    runHistoryMigration,
    assertCompletedHistory,
    assertUpgradedRevisionReadable,
  }: {
    seedCanonicalAgent: SeedAgent;
    runHistoryMigration: MigrateHistory;
    assertCompletedHistory: CompletedHistory;
    assertUpgradedRevisionReadable: (db: HistoricalDatabase) => Promise<void>;
  },
) {
  assertHistoricalDatabase(db);
  assert.equal(typeof prefix, "number");
  let revision: string | undefined;
  let before: Record<string, unknown> | undefined;
  if (prefix > 0) {
    // These published schemas admitted recovery metadata. Preserve all other
    // execution inputs when the migrator removes it from immutable snapshots.
    const seeded = await seedCanonicalAgent(db, `ns_${randomUUID()}`, {
      computeAdmission: true,
      executionAdmission: true,
      harnessSettings: true,
      restartContinuation: true,
    });
    assertSeededAgent(seeded);
    revision = seeded.revision;
    const row = (
      await db.app.query<{ admitted_spec: unknown }>(
        "SELECT admitted_spec FROM occ.agent_revisions WHERE id=$1",
        [revision],
      )
    ).rows[0];
    assert.ok(row && isRecord(row.admitted_spec));
    before = row.admitted_spec;
    assert.ok(before.restart_continuation);
  }
  assert.equal((await runHistoryMigration(db)).ok, true);
  await assertCompletedHistory(db, []);
  assert.deepEqual(
    (
      await db.migrator.query<{ attname: string }>(
        "SELECT attname FROM pg_attribute WHERE attrelid='occ.agents'::regclass AND NOT attisdropped AND attname IN ('restart_generation','restart_domain')",
      )
    ).rows,
    [],
  );
  assert.equal(
    (
      await db.app.query<{ allowed: boolean }>(
        "SELECT has_table_privilege(current_user,'occ.agent_revisions','UPDATE') AS allowed",
      )
    ).rows[0]?.allowed,
    false,
  );
  if (revision !== undefined) {
    assert.ok(before);
    delete before.restart_continuation;
    assert.deepEqual(
      (
        await db.app.query<{ admitted_spec: unknown }>(
          "SELECT admitted_spec FROM occ.agent_revisions WHERE id=$1",
          [revision],
        )
      ).rows[0]?.admitted_spec,
      before,
    );
    await assert.rejects(
      db.migrator.query(
        'UPDATE occ.agent_revisions SET admitted_spec=admitted_spec || \'{"draft_spec":{"changed":true}}\'::jsonb WHERE id=$1',
        [revision],
      ),
      { code: "55000" },
    );
    await assert.rejects(
      db.app.query("UPDATE occ.agent_revisions SET admitted_spec=admitted_spec WHERE id=$1", [
        revision,
      ]),
      { code: "42501" },
    );
    await assertUpgradedRevisionReadable(db);
  }
}

export async function prepareRetainedHarnessRevisions(
  db: unknown,
  {
    seedCanonicalAgent,
    runHistoryMigration,
  }: { seedCanonicalAgent: SeedAgent; runHistoryMigration: MigrateHistory },
) {
  assertHistoricalDatabase(db);
  const namespace = `ns_${randomUUID()}`;
  // Seed the old shape under its original constraint, then upgrade in place.
  const seeded = await seedCanonicalAgent(db, namespace, {
    computeAdmission: true,
    executionAdmission: true,
    harnessSettings: false,
  });
  assertSeededAgent(seeded);
  const { agent, revision } = seeded;
  assert.deepEqual(await runHistoryMigration(db), { ok: true, history: "preHarnessOverrides" });

  const current = `rev_${randomUUID()}`;
  const settings = {
    overrides: { preset: "small" },
    configuration: { preset: "small", instances: 1 },
  };
  await db.app.query(
    `INSERT INTO occ.agent_revisions(id,namespace_id,agent_id,revision_number,admitted_spec,backend_id,admitted_at)
     SELECT $1,namespace_id,agent_id,2,jsonb_set(admitted_spec,'{harness}',(admitted_spec->'harness') || $2::jsonb),backend_id,now()
     FROM occ.agent_revisions WHERE id=$3`,
    [current, settings, revision],
  );
  return { namespace, agent, revision, current, settings };
}

type RetainedRevisionFixture = {
  revision: string;
  current: string;
  settings: { overrides: { preset: string }; configuration: { preset: string; instances: number } };
};
type ResponseEnvelope = { status: number; data: unknown };

function assertRetainedRevisionFixture(value: unknown): asserts value is RetainedRevisionFixture {
  assert.ok(isRecord(value));
  assert.equal(typeof value.revision, "string");
  assert.equal(typeof value.current, "string");
  assert.ok(isRecord(value.settings));
  assert.ok(isRecord(value.settings.overrides));
  assert.equal(typeof value.settings.overrides.preset, "string");
  assert.ok(isRecord(value.settings.configuration));
  assert.equal(typeof value.settings.configuration.preset, "string");
  assert.equal(typeof value.settings.configuration.instances, "number");
}

function assertResponseEnvelope(value: unknown): asserts value is ResponseEnvelope {
  assert.ok(isRecord(value));
  assert.equal(typeof value.status, "number");
  assert.ok("data" in value);
}

export function assertRetainedRevisionResponses(
  fixture: unknown,
  list: unknown,
  oldDetail: unknown,
  newDetail: unknown,
) {
  assertRetainedRevisionFixture(fixture);
  assertResponseEnvelope(list);
  assertResponseEnvelope(oldDetail);
  assertResponseEnvelope(newDetail);
  const { revision, current, settings } = fixture;
  assert.deepEqual([list.status, oldDetail.status, newDetail.status], [200, 200, 200]);
  assert.ok(isUnknownArray(list.data) && list.data.every(isRecord));
  assert.ok(isRecord(oldDetail.data));
  assert.ok(isRecord(newDetail.data));
  const historicalHarness = { id: "codex", version: "1.0.0", mode: "dedicated" };
  assert.deepEqual(
    list.data.map(({ id, harness }) => [id, harness]),
    [
      [current, { ...historicalHarness, ...settings }],
      [revision, historicalHarness],
    ],
  );
  assert.equal(oldDetail.data.id, revision);
  assert.deepEqual(oldDetail.data.configurationReadError, {
    code: "SAVED_CONFIGURATION_UNREADABLE",
    field: "configuration",
  });
  assert.equal("configuration" in oldDetail.data, false);
  assert.equal("harness" in oldDetail.data, false);
  assert.equal(newDetail.data.id, current);
  assert.deepEqual(newDetail.data.harness, { ...historicalHarness, ...settings });
}

type CredentialSourceAction = "create" | "read" | "update" | "delete" | "operate";
type CredentialSourcePermission = {
  action: CredentialSourceAction;
  resourceKind: "credential_source";
};
type AdministratorFixture = {
  namespaceId: string;
  presetSeed: HistoricalPermission[];
  releaseSeed: HistoricalPermission[];
  currentGrants: CredentialSourcePermission[];
};

function isCredentialSourcePermission(value: unknown): value is CredentialSourcePermission {
  return (
    isHistoricalPermission(value) &&
    value.resourceKind === "credential_source" &&
    ["create", "read", "update", "delete", "operate"].includes(value.action)
  );
}

function assertAdministratorFixture(value: unknown): asserts value is AdministratorFixture {
  assert.ok(isRecord(value));
  assert.equal(typeof value.namespaceId, "string");
  assert.ok(isUnknownArray(value.presetSeed) && value.presetSeed.every(isHistoricalPermission));
  assert.ok(isUnknownArray(value.releaseSeed) && value.releaseSeed.every(isHistoricalPermission));
  assert.ok(
    isUnknownArray(value.currentGrants) && value.currentGrants.every(isCredentialSourcePermission),
  );
}

export async function assertAdministratorGrantUpgrade(
  pool: Pool,
  migrationsDirectory: string,
  migration: string,
  fixture: unknown,
) {
  assertAdministratorFixture(fixture);
  const { namespaceId, presetSeed, releaseSeed, currentGrants } = fixture;
  const currentUpdate = currentGrants[2];
  assert.ok(currentUpdate);
  const release = historicalRole(releaseSeed);
  const reordered = historicalRole(releaseSeed, { permissions: [...releaseSeed].reverse() });
  const preCredentialSources = historicalRole(releaseSeed, { permissions: presetSeed });
  const reduced = historicalRole(releaseSeed, { permissions: releaseSeed.slice(1) });
  const current = historicalRole(releaseSeed, { permissions: [...releaseSeed, currentUpdate] });
  const roles = [
    release,
    reordered,
    preCredentialSources,
    reduced,
    current,
    historicalRole(releaseSeed, {
      permissions: [...releaseSeed, { action: "update", resourceKind: "namespace" }],
    }),
    historicalRole(releaseSeed, { name: "Custom administrator" }),
    historicalRole(releaseSeed, { id: `role_${randomUUID()}` }),
    historicalRole(releaseSeed, { namespace_id: namespaceId }),
  ];
  const principals = await seedHistoricalRoles(pool, roles, [
    release,
    preCredentialSources,
    reduced,
  ]);
  assert.ok(pool instanceof pg.Pool);
  assert.ok(principals[0] && principals[1] && principals[2]);
  const [{ NativeIAMDriver }, { PostgresPlatformState }] = await Promise.all([
    import("../../packages/iam/src/index.ts"),
    import("../../packages/occ/src/state/postgres-state.ts"),
  ]);
  const iam = new NativeIAMDriver(new PostgresPlatformState(pool));
  const sourceId = `cs_${randomUUID()}`;
  const authorize = async (principalId: string, action: CredentialSourceAction) =>
    (
      await iam.authorize({
        principalId,
        action,
        resource: {
          kind: "credential_source",
          id: action === "create" ? namespaceId : sourceId,
          namespaceId,
        },
      })
    ).allowed;
  assert.equal(await authorize(principals[0], "update"), false);
  assert.equal(await authorize(principals[0], "read"), true);
  assert.equal(await authorize(principals[1], "read"), false);

  // Run the repository migration itself, not copied UPDATE text or a test-only migrator.
  const sql = await readFile(join(migrationsDirectory, migration), "utf8");
  await pool.query(sql);
  const updateGrant = currentGrants[2];
  assert.ok(updateGrant && updateGrant.action === "update");
  const upgraded = new Map<string, HistoricalPermission[]>([
    [release.id, [updateGrant]],
    [reordered.id, [updateGrant]],
    [preCredentialSources.id, currentGrants],
  ]);
  const expected = (entry: HistoricalRole) => ({
    ...entry,
    permissions: [...entry.permissions, ...(upgraded.get(entry.id) ?? [])],
  });
  for (const entry of roles) {
    const actual = (
      await pool.query<Record<string, unknown>>("SELECT * FROM occ.iam_roles WHERE id = $1", [
        entry.id,
      ])
    ).rows[0];
    assert.deepEqual(actual, expected(entry));
  }
  // A repeated run changes nothing: every upgraded Role now matches the current seed.
  await pool.query(sql);
  for (const entry of roles) {
    const actual = (
      await pool.query<Record<string, unknown>>("SELECT * FROM occ.iam_roles WHERE id = $1", [
        entry.id,
      ])
    ).rows[0];
    assert.deepEqual(actual, expected(entry));
  }
  for (const { action } of currentGrants) {
    assert.equal(await authorize(principals[0], action), true);
    assert.equal(await authorize(principals[1], action), true);
  }
  assert.equal(await authorize(principals[2], "update"), false);
  assert.equal(await authorize(principals[2], "read"), true);
}
