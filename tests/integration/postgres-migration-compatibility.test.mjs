import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import {
  assertCredentialSchemaPrivileges,
  assertInjectedMigrationRollback,
  retainGatewaySourcesAcrossProxyAdmission,
} from "../helpers/credential-source-owner-upgrade.ts";
import { repositoryCredentials } from "../fixtures/repository-credentials/session-state.mjs";
import {
  catalogDigest,
  initialSchemaState,
  migrationCatalog,
} from "../../scripts/migration-catalog.mjs";
import { migrateWithHistory } from "../../scripts/migration-history.mjs";
import { createPostgresPool } from "../../packages/occ/src/state/postgres-pool.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const migrationsDirectory = join(repositoryRoot, "migrations");
const providerMigrationsDirectory = join(
  repositoryRoot,
  "tests/fixtures/migrations/provider-completed",
);
const providerMigrationTags = new Set([
  "0014_provider_driver_abstraction",
  "0017_harness_auth_binding",
  "0018_runtime_harness_auth",
  "0025_repository_credentials",
  "0030_codex_pat_harness_auth",
]);
const execFileAsync = promisify(execFile);
const dependency = createRequire(new URL("../../packages/occ/package.json", import.meta.url));
const { drizzle } = dependency("drizzle-orm/node-postgres");
const { migrate } = dependency("drizzle-orm/node-postgres/migrator");
const selectors = [
  process.env.OCC_TEST_DATABASE_URL,
  process.env.OPENCLAW_ENTERPRISE_CI_STATE,
  process.env.OPENCLAW_ENTERPRISE_CI_PREFIX,
];
const requiresOwnedPostgres = {
  skip:
    selectors.slice(1).every((value) => value === undefined) &&
    !process.env.CI &&
    !process.env.GITHUB_ACTIONS
      ? "Requires the native CI runner's prepared disposable PostgreSQL fixture."
      : false,
};

async function ownedPostgres() {
  assert.ok(
    selectors.every((value) => typeof value === "string" && value.length > 0),
    "PostgreSQL compatibility tests require the complete native CI fixture environment.",
  );
  const [applicationUrl, statePath, prefix] = selectors;
  assert.ok(isAbsolute(statePath), "The native CI state path must be absolute.");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.version, 1);
  assert.equal(state.repositoryRoot, resolve(repositoryRoot));
  assert.equal(state.statePath, resolve(statePath));
  assert.equal(state.lane, "postgres");
  assert.ok(
    /^openclaw-ci-[a-z0-9-]+$/.test(prefix) && prefix.length <= 48,
    "The fixture must have a native CI owner prefix.",
  );
  assert.equal(state.prefix, prefix);
  assert.ok(Array.isArray(state.resources), "The native CI state must record its resources.");

  let application;
  try {
    application = new URL(applicationUrl);
  } catch {
    throw new Error("The application database selector must be a valid PostgreSQL URL.");
  }
  assert.ok(
    ["postgresql:", "postgres:"].includes(application.protocol) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(application.hostname) &&
      application.username === "occ_app" &&
      application.password === "occ-app-local" &&
      application.search === "" &&
      application.hash === "",
    "The application URL must select the loopback native CI application role without overrides.",
  );
  const database = application.pathname.slice(1);
  assert.ok(
    /^openclaw_ci_[a-z0-9_]+$/.test(database) && database.length <= 63,
    "The database must be a disposable openclaw_ci_* fixture.",
  );
  const port = Number(application.port);
  assert.ok(
    Number.isInteger(port) && port > 0 && port <= 65535 && port !== 55432,
    "The fixture must use an explicit port other than the developer PostgreSQL port.",
  );
  const servers = state.resources.filter((resource) => resource.kind === "compose-postgres");
  assert.equal(servers.length, 1, "The state must own exactly one PostgreSQL Compose project.");
  const server = servers[0];
  assert.equal(server.owner, prefix);
  assert.equal(server.status, "ready");
  assert.ok(
    /^openclaw_ci_pg_[a-z0-9_]+$/.test(server.name) && server.name.length <= 63,
    "The PostgreSQL Compose project must have a native CI name.",
  );
  assert.equal(server.composeFile, join(repositoryRoot, "compose.postgres.yaml"));
  assert.equal(server.port, port);
  const databases = state.resources.filter(
    (resource) => resource.kind === "postgres-database" && resource.name === database,
  );
  assert.equal(databases.length, 1, "The selected database must be recorded in native CI state.");
  assert.equal(databases[0].owner, prefix);
  assert.equal(databases[0].status, "ready");
  assert.equal(databases[0].composeProject, server.name);
  assert.equal(databases[0].port, port);

  // Only the native runner's already-migrated database may receive a second migration.
  const migration = new URL(application);
  migration.username = "occ_migrator";
  migration.password = "occ-migrator-local";
  return {
    database,
    port,
    migrationUrl: migration.toString(),
    composeProjectArgs: ["compose", "-f", server.composeFile, "-p", server.name],
    composeArgs: ["compose", "-f", server.composeFile, "-p", server.name, "exec", "-T", "postgres"],
  };
}

async function runCommand(fixture, command, args) {
  const pending = execFileAsync(command, args, {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      pnpm_config_verify_deps_before_run: "false",
      OCC_MIGRATION_DATABASE_URL: fixture.migrationUrl,
      OCC_POSTGRES_PORT: String(fixture.port),
    },
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  pending.child.stdin.end();
  try {
    return (await pending).stdout;
  } catch (error) {
    // Subprocess errors include command output, which may contain database credentials.
    throw new Error(
      `${command} failed (code=${error.code ?? "none"}, signal=${error.signal ?? "none"}, killed=${error.killed === true}).`,
    );
  }
}

async function fileHashes(directory, relativePath = "") {
  const hashes = {};
  const entries = await readdir(join(directory, relativePath), { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(relativePath, entry.name);
    if (entry.isDirectory()) {
      Object.assign(hashes, await fileHashes(directory, path));
    } else {
      assert.ok(entry.isFile(), "Migration artifacts must be regular files.");
      hashes[path] = createHash("sha256")
        .update(await readFile(join(directory, path)))
        .digest("hex");
    }
  }
  return hashes;
}

test(
  "Drizzle generates repository schema migrations without redundant regeneration",
  requiresOwnedPostgres,
  async (context) => {
    const fixture = await ownedPostgres();
    const directory = await mkdtemp(join(tmpdir(), "openclaw-ci-drizzle-"));
    context.after(async () => {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        context.diagnostic("Temporary migration cleanup failed.");
        throw error;
      }
    });
    await chmod(directory, 0o700);
    const originalMigrations = await fileHashes(migrationsDirectory);
    context.after(async () => {
      assert.deepEqual(await fileHashes(migrationsDirectory), originalMigrations);
    });
    const outputDirectory = join(directory, "migrations");
    await mkdir(outputDirectory, { mode: 0o700 });
    const configPath = join(directory, "drizzle.config.ts");
    // Keep the real TypeScript schema/config; only generated output leaves the checkout.
    await writeFile(
      configPath,
      `import config from ${JSON.stringify(join(repositoryRoot, "drizzle.config.ts"))};\nexport default { ...config, out: ${JSON.stringify(relative(repositoryRoot, outputDirectory))} };\n`,
      { mode: 0o600, flag: "wx" },
    );
    const generateArgs = ["pnpm", "db:generate", "--config", configPath, "--name", "compatibility"];
    await runCommand(fixture, "corepack", generateArgs);

    const sqlFiles = (await readdir(outputDirectory)).filter((name) => name.endsWith(".sql"));
    assert.equal(sqlFiles.length, 1, "Generation must produce one initial SQL migration.");
    const sql = await readFile(join(outputDirectory, sqlFiles[0]), "utf8");
    // Compare constraints as PostgreSQL actually parsed them. Execute Drizzle's generated
    // table DDL verbatim except for its destination; the fixture has the authored migrations.
    const client = new pg.Client({ connectionString: fixture.migrationUrl });
    await client.connect();
    try {
      for (const [table, constraint] of [
        ["egress_send_receipts", "egress_send_receipts_check_17"],
        ["repository_standing_approvals", "standing_approvals_binding_check"],
        ["prepared_github_attempts", "prepared_github_attempts_expired_check"],
        ["agent_revisions", "agent_revisions_admitted_snapshot"],
        ["agent_revisions", "agent_revisions_execution_admission"],
        ["repository_session_attempts", "repository_session_attempts_broker_protocol_valid"],
      ]) {
        const create = `CREATE TABLE "occ"."${table}"`;
        const ddl = sql
          .split("--> statement-breakpoint")
          .find((statement) => statement.includes(create));
        assert.ok(ddl, `Generated SQL must include ${table}`);
        // Redirect both the CREATE and any schema-qualified references to that table.
        const temporaryDdl = ddl
          .replace(create, `CREATE TEMP TABLE "${table}"`)
          .replaceAll(`"occ"."${table}".`, `"${table}".`);
        await client.query(temporaryDdl);
        const checks = await client.query(
          `SELECT pg_get_constraintdef(oid) AS definition
             FROM pg_constraint
            WHERE conname = $1 AND conrelid IN ($2::regclass, $3::regclass)`,
          [constraint, `pg_temp.${table}`, `occ.${table}`],
        );
        assert.equal(checks.rowCount, 2, `Both tables must have ${constraint}`);
        assert.equal(checks.rows[0].definition, checks.rows[1].definition);
        await client.query(`DROP TABLE pg_temp."${table}"`);
      }
    } finally {
      await client.end();
    }

    const metadataDirectory = join(outputDirectory, "meta");
    const snapshots = (await readdir(metadataDirectory)).filter((name) =>
      name.endsWith("_snapshot.json"),
    );
    assert.equal(snapshots.length, 1);
    const snapshot = JSON.parse(await readFile(join(metadataDirectory, snapshots[0]), "utf8"));
    assert.equal(snapshot.dialect, "postgresql");
    assert.ok(snapshot.tables["occ.installation"]);
    assert.ok(snapshot.tables["occ.namespaces"]);
    const journal = JSON.parse(await readFile(join(metadataDirectory, "_journal.json"), "utf8"));
    assert.equal(journal.dialect, "postgresql");
    assert.equal(journal.entries.length, 1);
    assert.equal(`${journal.entries[0].tag}.sql`, sqlFiles[0]);

    // Unchanged schema must not append or rewrite any SQL, snapshot, or journal bytes.
    const firstGeneration = await fileHashes(outputDirectory);
    await runCommand(fixture, "corepack", generateArgs);
    assert.deepEqual(await fileHashes(outputDirectory), firstGeneration);

    // Generate a custom migration after the checked-in journal, including its historical
    // numbering gap. Drizzle chooses the next filename by index and applies SQL by timestamp.
    await rm(outputDirectory, { recursive: true });
    await cp(migrationsDirectory, outputDirectory, { recursive: true });
    const journalPath = join(metadataDirectory, "_journal.json");
    const readJournal = async () => JSON.parse(await readFile(journalPath, "utf8")).entries;
    const previous = await readJournal();
    await runCommand(fixture, "corepack", [...generateArgs, "--custom"]);
    const next = await readJournal();
    assert.deepEqual(next.slice(0, -1), previous);
    const { tag, when } = next.at(-1);
    const last = previous.at(-1);
    assert.equal(Number(tag.slice(0, 4)), Number(last.tag.slice(0, 4)) + 1);
    assert.ok(when > last.when, "Drizzle must see the next migration as pending");
  },
);

for (const legacyState of ["active_runtime", "harness_revision", "harness_account"]) {
  test(
    `Migration rejects legacy ${legacyState} state without changing persisted rows`,
    requiresOwnedPostgres,
    async (context) => {
      const fixture = await ownedPostgres();
      const database = `openclaw_ci_agent_stop_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      let pool;
      context.after(async () => {
        try {
          if (pool !== undefined) {
            await pool.end();
          }
        } finally {
          await runCommand(fixture, "docker", [
            ...fixture.composeArgs,
            "psql",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            "postgres",
            "-d",
            "postgres",
            "-c",
            `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
          ]);
        }
      });

      await runCommand(fixture, "docker", [
        ...fixture.composeArgs,
        "psql",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-c",
        `CREATE DATABASE ${database}`,
      ]);
      await runCommand(fixture, "docker", [
        ...fixture.composeArgs,
        "psql",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "postgres",
        "-d",
        database,
        "-c",
        `GRANT CREATE ON DATABASE ${database} TO occ_migrator; CREATE SCHEMA occ AUTHORIZATION occ_migrator; CREATE SCHEMA drizzle AUTHORIZATION occ_migrator; REVOKE CREATE ON SCHEMA public FROM PUBLIC;`,
      ]);

      const migrationUrl = new URL(fixture.migrationUrl);
      migrationUrl.pathname = `/${database}`;
      pool = new pg.Pool({ connectionString: migrationUrl.toString(), max: 1 });
      const migrationFiles = (await readdir(migrationsDirectory))
        .filter(
          (name) =>
            /^\d{4}_.+\.sql$/.test(name) &&
            name <
              (legacyState === "active_runtime"
                ? "0016_agent_stop.sql"
                : "0017_harness_auth_binding.sql"),
        )
        .sort();
      assert.equal(
        migrationFiles.at(-1),
        legacyState === "active_runtime" ? "0015_agent_plugins.sql" : "0016_agent_stop.sql",
      );
      for (const name of migrationFiles) {
        await pool.query(await readFile(join(migrationsDirectory, name), "utf8"));
      }

      const namespaceId = `ns_${randomUUID()}`;
      const configurationId = `cfg_${randomUUID()}`;
      const agentId = `agt_${randomUUID()}`;
      const revisionId = `rev_${randomUUID()}`;
      const servicePrincipalId = `service-agent-${agentId}`;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO occ.namespaces (id, name, status, created_at)
         VALUES ($1, $2, 'ready', clock_timestamp())`,
          [namespaceId, `active-agent-${randomUUID()}`],
        );
        await client.query(
          `INSERT INTO occ.configurations (id, namespace_id, kind, generation, created_at)
         VALUES ($1, $2, 'agent', 1, clock_timestamp())`,
          [configurationId, namespaceId],
        );
        await client.query(
          `INSERT INTO occ.iam_identities (id, namespace_id, agent_id, kind)
         VALUES ($1, $2, $3, 'service_principal')`,
          [servicePrincipalId, namespaceId, agentId],
        );
        await client.query(
          `INSERT INTO occ.agents
           (id, namespace_id, name, configuration_id, backend_id, execution_mode,
            service_principal_id, created_at)
         VALUES ($1, $2, $3, $4, NULL, 'dedicated', $5, clock_timestamp())`,
          [
            agentId,
            namespaceId,
            `active-agent-${randomUUID()}`,
            configurationId,
            servicePrincipalId,
          ],
        );
        if (legacyState !== "harness_account") {
          await client.query(
            `INSERT INTO occ.agent_revisions
           (id, namespace_id, agent_id, revision_number, admitted_spec, backend_id, admitted_at)
         VALUES ($1, $2, $3, 1, $4, NULL, clock_timestamp())`,
            [
              revisionId,
              namespaceId,
              agentId,
              {
                configuration_id: configurationId,
                configuration_kind: "agent",
                configuration_generation: 1,
                draft_spec: {},
                harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
                compute: { id: "kubernetes", implementation: "test" },
              },
            ],
          );
        }
        if (legacyState === "active_runtime") {
          await client.query(
            "UPDATE occ.agents SET active_revision_id = $1 WHERE namespace_id = $2 AND id = $3",
            [revisionId, namespaceId, agentId],
          );
        }
        if (legacyState === "harness_account") {
          const serviceAccountId = `sa_${randomUUID()}`;
          await client.query(
            "INSERT INTO occ.service_accounts (id, namespace_id, name) VALUES ($1, $2, $3)",
            [serviceAccountId, namespaceId, "legacy account"],
          );
          await client.query("UPDATE occ.agents SET service_account_id = $1 WHERE id = $2", [
            serviceAccountId,
            agentId,
          ]);
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      const agentStopMigration = await readFile(
        join(
          migrationsDirectory,
          legacyState === "active_runtime"
            ? "0016_agent_stop.sql"
            : "0017_harness_auth_binding.sql",
        ),
        "utf8",
      );
      await assert.rejects(pool.query(agentStopMigration), ({ code, message }) =>
        legacyState === "active_runtime"
          ? code === "55000" &&
            message ===
              "Agent stop migration requires active revisions and pending revision work to be removed before cutover"
          : code === "23514" &&
            message.startsWith("Legacy Agent authentication state is unsupported"),
      );
      const unchanged = await pool.query(
        `SELECT active_revision_id,
              EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'occ' AND table_name = 'agents'
                  AND column_name = $3
              ) AS migration_started
       FROM occ.agents WHERE namespace_id = $1 AND id = $2`,
        [
          namespaceId,
          agentId,
          legacyState === "active_runtime" ? "desired_runtime_state" : "harness_auth",
        ],
      );
      assert.deepEqual(unchanged.rows, [
        {
          active_revision_id: legacyState === "active_runtime" ? revisionId : null,
          migration_started: false,
        },
      ]);
    },
  );
}

test(
  "Migration backfills legacy terminal controller work from durable audit evidence",
  requiresOwnedPostgres,
  async (context) => {
    const fixture = await ownedPostgres();
    const database = `openclaw_ci_work_outcome_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    let pool;
    context.after(async () => {
      try {
        if (pool !== undefined) {
          await pool.end();
        }
      } finally {
        await runCommand(fixture, "docker", [
          ...fixture.composeArgs,
          "psql",
          "-v",
          "ON_ERROR_STOP=1",
          "-U",
          "postgres",
          "-d",
          "postgres",
          "-c",
          `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
        ]);
      }
    });

    await runCommand(fixture, "docker", [
      ...fixture.composeArgs,
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-c",
      `CREATE DATABASE ${database}`,
    ]);
    await runCommand(fixture, "docker", [
      ...fixture.composeArgs,
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      database,
      "-c",
      `GRANT CREATE ON DATABASE ${database} TO occ_migrator; CREATE SCHEMA occ AUTHORIZATION occ_migrator; CREATE SCHEMA drizzle AUTHORIZATION occ_migrator; REVOKE CREATE ON SCHEMA public FROM PUBLIC;`,
    ]);

    const migrationUrl = new URL(fixture.migrationUrl);
    migrationUrl.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: migrationUrl.toString(), max: 1 });
    const migrationFiles = (await readdir(migrationsDirectory))
      .filter(
        (name) =>
          /^\d{4}_.+\.sql$/.test(name) && name < "0019_controller_work_terminal_outcome.sql",
      )
      .sort();
    assert.equal(migrationFiles.at(-1), "0018_runtime_harness_auth.sql");
    for (const name of migrationFiles) {
      await pool.query(await readFile(join(migrationsDirectory, name), "utf8"));
    }

    const namespaceId = `ns_${randomUUID()}`;
    const configurationId = `cfg_${randomUUID()}`;
    const firstAgentId = `agt_${randomUUID()}`;
    const secondAgentId = `agt_${randomUUID()}`;
    const firstRevisionId = `rev_${randomUUID()}`;
    const secondRevisionId = `rev_${randomUUID()}`;
    const failedRevisionId = `rev_${randomUUID()}`;
    const actorId = "legacy-worker";
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO occ.namespaces (id, name, status, created_at)
         VALUES ($1, $2, 'ready', '2026-09-20T00:00:00Z'::timestamptz)`,
        [namespaceId, `terminal-work-${randomUUID()}`],
      );
      await client.query(
        `INSERT INTO occ.configurations (id, namespace_id, kind, generation, created_at)
         VALUES ($1, $2, 'agent', 1, '2026-09-20T00:00:00Z'::timestamptz)`,
        [configurationId, namespaceId],
      );

      for (const agentId of [firstAgentId, secondAgentId]) {
        await client.query(
          `INSERT INTO occ.iam_identities (id, namespace_id, agent_id, kind)
           VALUES ($1, $2, $3, 'service_principal')`,
          [`service-agent-${agentId}`, namespaceId, agentId],
        );
        await client.query(
          `INSERT INTO occ.agents
             (id, namespace_id, name, configuration_id, backend_id, execution_mode,
              service_principal_id, created_at)
           VALUES ($1, $2, $3, $4, NULL, 'dedicated', $5, '2026-09-20T00:00:00Z'::timestamptz)`,
          [
            agentId,
            namespaceId,
            `agent-${agentId.slice("agt_".length, "agt_".length + 8)}`,
            configurationId,
            `service-agent-${agentId}`,
          ],
        );
      }

      const admittedSpec = {
        configuration_id: configurationId,
        configuration_kind: "agent",
        configuration_generation: 1,
        draft_spec: {},
        harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
        harness_auth: { method: "runtime" },
        compute: { id: "kubernetes", implementation: "test" },
      };
      for (const [agentId, revisionId, revisionNumber] of [
        [firstAgentId, firstRevisionId, 1],
        [firstAgentId, secondRevisionId, 2],
        [secondAgentId, failedRevisionId, 1],
      ]) {
        await client.query(
          `INSERT INTO occ.agent_revisions
             (id, namespace_id, agent_id, revision_number, admitted_spec, backend_id, admitted_at)
           VALUES ($1, $2, $3, $4, $5, NULL, '2026-09-20T00:00:00Z'::timestamptz)`,
          [revisionId, namespaceId, agentId, revisionNumber, admittedSpec],
        );
      }
      await client.query("UPDATE occ.agents SET active_revision_id = $1 WHERE id = $2", [
        secondRevisionId,
        firstAgentId,
      ]);

      const workRows = [
        ["legacy-revision-activated", firstAgentId, firstRevisionId, null, "succeeded", 2],
        [
          "legacy-revision-without-activation",
          firstAgentId,
          secondRevisionId,
          null,
          "succeeded",
          3,
        ],
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

      const reconcileRows = [
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
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    await pool.query(
      await readFile(
        join(migrationsDirectory, "0019_controller_work_terminal_outcome.sql"),
        "utf8",
      ),
    );
    const migrated = await pool.query(
      `SELECT idempotency_key, state, completed_at IS NULL AS completed_at_is_null,
              reason_code, result_data
       FROM occ.controller_work
       ORDER BY idempotency_key`,
    );
    assert.deepEqual(migrated.rows, [
      {
        idempotency_key: "legacy-namespace-pending",
        state: "queued",
        completed_at_is_null: true,
        reason_code: null,
        result_data: null,
      },
      {
        idempotency_key: "legacy-namespace-reconciled",
        state: "succeeded",
        completed_at_is_null: false,
        reason_code: "RECONCILE_SUCCEEDED",
        result_data: null,
      },
      {
        idempotency_key: "legacy-revision-activated",
        state: "succeeded",
        completed_at_is_null: false,
        reason_code: "REVISION_ACTIVATED",
        result_data: null,
      },
      {
        idempotency_key: "legacy-revision-failed",
        state: "failed_permanent",
        completed_at_is_null: false,
        reason_code: "CONVERGENCE_DEADLINE_EXCEEDED",
        result_data: null,
      },
      {
        idempotency_key: "legacy-revision-unknown",
        state: "failed_permanent",
        completed_at_is_null: false,
        reason_code: "LEGACY_OUTCOME_UNKNOWN",
        result_data: null,
      },
      {
        idempotency_key: "legacy-revision-without-activation",
        state: "succeeded",
        completed_at_is_null: false,
        reason_code: "RECONCILE_SUCCEEDED",
        result_data: null,
      },
    ]);
  },
);

test(
  "Drizzle second migration preserves the applied journal and PostgreSQL schema",
  requiresOwnedPostgres,
  async (context) => {
    const fixture = await ownedPostgres();
    const pool = new pg.Pool({
      connectionString: fixture.migrationUrl,
      max: 1,
      connectionTimeoutMillis: 30_000,
      query_timeout: 30_000,
    });
    context.after(async () => {
      try {
        await pool.end();
      } catch (error) {
        context.diagnostic("Migration pool cleanup failed.");
        throw error;
      }
    });
    const originalMigrations = await fileHashes(migrationsDirectory);
    context.after(async () => {
      assert.deepEqual(await fileHashes(migrationsDirectory), originalMigrations);
    });
    const server = await pool.query("SELECT current_setting('server_version_num') AS version");
    const serverVersion = Number(server.rows[0].version);
    assert.ok(serverVersion >= 180_000 && serverVersion < 190_000, "PostgreSQL 18 is required.");
    const dumpVersion = await runCommand(fixture, "docker", [
      ...fixture.composeArgs,
      "pg_dump",
      "--version",
    ]);
    assert.match(dumpVersion, /^pg_dump \(PostgreSQL\) 18(?:\.|\s)/);
    const journalQuery =
      "SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id";
    const beforeJournal = (await pool.query(journalQuery)).rows;
    const sourceJournal = JSON.parse(
      await readFile(join(migrationsDirectory, "meta", "_journal.json"), "utf8"),
    );
    assert.ok(beforeJournal.length > 0, "Native preparation must apply the original migrations.");
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
    const beforeSchema = await runCommand(fixture, "docker", dumpArgs);
    assert.ok(beforeSchema.trim().length > 0);

    // Native preparation performed the first migration; rerun the supported entry point.
    await runCommand(fixture, "corepack", ["pnpm", "db:migrate"]);
    assert.deepEqual((await pool.query(journalQuery)).rows, beforeJournal);
    // The history cases run the script text directly; prove pnpm forwards --check too.
    const checked = await runCommand(fixture, "corepack", [
      "pnpm",
      "db:migrate:production",
      "--check",
    ]);
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
    const startupFile = async (name, contents) => {
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
      const result = await runMigrationCheck(fixture, path);
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
    const atInfo = await runMigrationCheck(
      fixture,
      await startupFile("info.yaml", "logging:\n  level: info\n"),
    );
    assert.equal(atInfo.code, 0);
    assert.equal(atInfo.stdout, checkedOutput);
    assert.deepEqual(logEvents(atInfo.stderr), [
      { severity: "INFO", service: "occ-migration", event: "migration.checked" },
    ]);
    const atWarn = await runMigrationCheck(
      fixture,
      await startupFile("warn.yaml", "logging:\n  level: warn\n"),
    );
    assert.equal(atWarn.code, 0);
    assert.equal(atWarn.stdout, checkedOutput);
    assert.deepEqual(logEvents(atWarn.stderr), []);
    assert.equal(await runCommand(fixture, "docker", dumpArgs), beforeSchema);
  },
);

async function runMigrationCheck(fixture, configPath) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["scripts/migrate-production.mjs", "--check"],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          NODE_ENV: "production",
          OCC_MIGRATION_DATABASE_URL: fixture.migrationUrl,
          OCC_CONFIG_PATH: configPath,
        },
        encoding: "utf8",
        timeout: 180_000,
      },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (typeof error.code !== "number") {
      // Subprocess errors can retain connection credentials in stdout or stderr.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        `Migration subprocess failed unexpectedly (signal=${error.signal ?? "none"}).`,
      );
    }
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

// Structured log lines without their timestamps.
function logEvents(stderr) {
  return stderr
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const { time, ...event } = JSON.parse(line);
      assert.equal(typeof time, "string");
      return event;
    });
}

const historySelectors = [
  process.env.OCC_MIGRATION_HISTORY_DATABASE_URL,
  process.env.OCC_MIGRATION_HISTORY_CONTAINER,
  process.env.OCC_MIGRATION_HISTORY_DATABASE_PREFIX,
];
const requiresHistoryPostgres = {
  skip: historySelectors.every((value) => value === undefined) && requiresOwnedPostgres.skip,
};
// The subtests of these cases run four at a time (`void context.test`): each owns its
// database and migration subprocesses, the migration lock is a per-database advisory
// lock, and every fixture changes only that database's catalogs and ACLs, never roles.
// node:test still waits for every subtest and fails the parent if one fails.
const concurrentHistoryPostgres = { ...requiresHistoryPostgres, concurrency: 4 };

// Administrator SQL runs over TCP as the container's own superuser: one pool for the
// `postgres` database (CREATE/DROP DATABASE) and a fresh session per database-local call,
// like each `psql -c` it replaces. `docker inspect` reads the credential once per file.
async function historyAdministrator(container, hostname, port) {
  const { stdout } = await execFileAsync(
    "docker",
    ["inspect", "--format", "{{json .Config.Env}}", container],
    { encoding: "utf8" },
  );
  const environment = new Map(
    JSON.parse(stdout).map((entry) => {
      const separator = entry.indexOf("=");
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
  );
  const password = environment.get("POSTGRES_PASSWORD");
  assert.ok(password, "The PostgreSQL container must define its administrator password.");
  const url = new URL("postgresql://localhost/postgres");
  url.hostname = hostname;
  url.port = String(port);
  // The fixtures name the `postgres` role (owners, grantors), as `psql -U postgres` did.
  assert.equal(environment.get("POSTGRES_USER") ?? "postgres", "postgres");
  url.username = "postgres";
  url.password = password;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  // An idle client's error (server restart) must fail its next query, not the process.
  pool.on("error", () => {});
  assert.deepEqual(
    (await pool.query("SELECT rolsuper FROM pg_roles WHERE rolname=current_user")).rows,
    [{ rolsuper: true }],
  );
  return { adminUrl: url.toString(), admin: pool };
}

let historyFixture;
// File-level: `after` called inside the first test that resolves the fixture would end the
// pool when that test finishes.
after(async () => {
  // A fixture that failed to resolve already failed its tests and owns no pool.
  await historyFixture?.then(
    (fixture) => fixture.admin.end(),
    () => {},
  );
});
function migrationHistoryFixture() {
  historyFixture ??= resolveMigrationHistoryFixture();
  return historyFixture;
}

async function resolveMigrationHistoryFixture() {
  if (historySelectors.every((value) => value === undefined)) {
    const fixture = await ownedPostgres();
    // Resolve the Compose service's container to read its administrator credential.
    const container = (
      await runCommand(fixture, "docker", [...fixture.composeProjectArgs, "ps", "-q", "postgres"])
    ).trim();
    assert.match(container, /^[a-f0-9]{12,64}$/);
    return {
      ...fixture,
      container,
      ...(await historyAdministrator(container, "127.0.0.1", fixture.port)),
      databasePrefix: "openclaw_ci_canonical",
    };
  }
  assert.ok(historySelectors.every((value) => typeof value === "string" && value.length > 0));
  const [migrationUrl, container, databasePrefix] = historySelectors;
  const url = new URL(migrationUrl);
  assert.ok(["postgresql:", "postgres:"].includes(url.protocol));
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert.equal(url.username, "occ_migrator");
  assert.equal(url.password, "occ-migrator-local");
  assert.equal(url.pathname, "/postgres");
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
  assert.match(container, /^[a-zA-Z0-9][a-zA-Z0-9_-]+$/);
  assert.match(databasePrefix, /^openclaw_[a-z0-9_]+$/);
  assert.ok(databasePrefix.length <= 50);
  const port = Number(url.port);
  assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65535);
  const mapped = await execFileAsync("docker", ["port", container, "5432/tcp"], {
    encoding: "utf8",
  });
  assert.ok(
    mapped.stdout
      .trim()
      .split("\n")
      .some((line) => line === `127.0.0.1:${port}` || line === `[::1]:${port}`),
  );
  return {
    migrationUrl,
    port,
    container,
    databasePrefix,
    ...(await historyAdministrator(container, url.hostname, port)),
  };
}

// One simple-protocol query, so a multi-statement string runs in one implicit
// transaction exactly as `psql -c` ran it.
async function historyAdmin(fixture, database, sql) {
  if (database === "postgres") {
    await fixture.admin.query(sql);
    return;
  }
  const url = new URL(fixture.adminUrl);
  url.pathname = `/${database}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function historyDatabase(context, fixture, label, { schemas = true, prefix = 0 } = {}) {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
  const labelLength = 63 - fixture.databasePrefix.length - suffix.length - 2;
  assert.ok(labelLength > 0);
  const name = `${fixture.databasePrefix}_${label.slice(0, labelLength)}_${suffix}`;
  assert.match(name, /^[a-z0-9_]+$/);
  const clients = [];
  await historyAdmin(fixture, "postgres", `CREATE DATABASE ${name}`);
  context.after(async () => {
    try {
      await Promise.all(clients.map((client) => client.end()));
    } finally {
      await historyAdmin(fixture, "postgres", `DROP DATABASE ${name} WITH (FORCE)`);
    }
  });
  await historyAdmin(
    fixture,
    name,
    `GRANT CREATE ON DATABASE ${name} TO occ_migrator; REVOKE CREATE ON SCHEMA public FROM PUBLIC;${schemas ? " CREATE SCHEMA occ AUTHORIZATION occ_migrator; CREATE SCHEMA drizzle AUTHORIZATION occ_migrator;" : ""}`,
  );
  const migration = new URL(fixture.migrationUrl);
  migration.pathname = `/${name}`;
  const application = new URL(migration);
  application.username = "occ_app";
  application.password = "occ-app-local";
  const migrator = new pg.Client({ connectionString: migration.toString() });
  const app = new pg.Client({ connectionString: application.toString() });
  clients.push(migrator, app);
  await migrator.connect();
  await app.connect();
  const db = { ...fixture, name, migrationUrl: migration.toString(), migrator, app };
  assert.deepEqual((await migrator.query("SELECT current_user,session_user")).rows, [
    { current_user: "occ_migrator", session_user: "occ_migrator" },
  ]);
  assert.deepEqual((await app.query("SELECT current_user,session_user")).rows, [
    { current_user: "occ_app", session_user: "occ_app" },
  ]);
  if (prefix > 0) {
    await installCanonicalPrefix(db, prefix);
  }
  return db;
}

async function installCanonicalPrefix(db, length, { entries: selectedEntries } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-canonical-prefix-"));
  try {
    await mkdir(join(directory, "meta"));
    const journal = JSON.parse(
      await readFile(join(migrationsDirectory, "meta/_journal.json"), "utf8"),
    );
    const entries = selectedEntries ?? journal.entries.slice(0, length);
    for (const entry of entries) {
      await writeFile(
        join(directory, `${entry.tag}.sql`),
        await readFile(join(migrationsDirectory, `${entry.tag}.sql`)),
      );
    }
    await writeFile(join(directory, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
    await migrate(drizzle(db.migrator), { migrationsFolder: directory });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function installProviderCompletedHistory(db) {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-provider-history-"));
  try {
    await mkdir(join(directory, "meta"));
    const manifest = JSON.parse(
      await readFile(join(migrationsDirectory, "meta/_canonical-history.json"), "utf8"),
    );
    const entries = manifest.compatibleLineages.providerCompleted.entries;
    assert.equal(entries.length, 31);
    const journal = {
      version: "7",
      dialect: "postgresql",
      entries: entries.map(({ sha256: _sha256, ...entry }) => entry),
    };
    for (const entry of journal.entries) {
      const sourceDirectory = providerMigrationTags.has(entry.tag)
        ? providerMigrationsDirectory
        : migrationsDirectory;
      const sql = await readFile(join(sourceDirectory, `${entry.tag}.sql`), "utf8");
      assert.equal(createHash("sha256").update(sql).digest("hex"), entries[entry.idx].sha256);
      await writeFile(join(directory, `${entry.tag}.sql`), sql);
    }
    await writeFile(join(directory, "meta/_journal.json"), JSON.stringify(journal));
    await migrate(drizzle(db.migrator), { migrationsFolder: directory });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// The real migration command. pnpm's own startup costs about 1 s of CPU per call, so run each
// package.json script's exact text through `sh` with this Node first on PATH, as pnpm does.
// The "Drizzle second migration" case still runs both commands through `corepack pnpm`,
// every prepared CI database is migrated that way, and the Helm migration Job runs the
// script file directly. Each refusal code and both scripts keep a command case here.
const migrationScripts = readFile(join(repositoryRoot, "package.json"), "utf8").then(
  (text) => JSON.parse(text).scripts,
);

// flag is one migration command option (--check or --expect-empty) or undefined; refusal,
// when set, must match the command's MIGRATION_HISTORY_UNSUPPORTED message.
async function runHistoryCommand(db, mode = "development", flag, refusal) {
  const script = (await migrationScripts)[
    mode === "production" ? "db:migrate:production" : "db:migrate"
  ];
  assert.equal(typeof script, "string");
  const args = ["-c", `${script} "$@"`, "sh", ...(flag === undefined ? [] : [flag])];
  const checkOnly = flag === "--check";
  try {
    const { stdout } = await execFileAsync("sh", args, {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
        OCC_MIGRATION_DATABASE_URL: db.migrationUrl,
      },
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const result = stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line))
      .find((value) => value.event === (checkOnly ? "migration.checked" : "migration.completed"));
    assert.ok(result, "The supported migration command must report its successful outcome.");
    return { ok: true, history: result.history };
  } catch (error) {
    const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    if (error.code === 1 && output.includes('"code":"MIGRATION_HISTORY_UNSUPPORTED"')) {
      if (refusal !== undefined) {
        assert.match(output, refusal);
      }
      return { ok: false, code: "MIGRATION_HISTORY_UNSUPPORTED" };
    }
    if (error.code === 1 && output.includes('"code":"MIGRATION_HISTORY_NOT_EMPTY"')) {
      assert.ok(
        output.includes("use --check to inspect migration history without applying changes"),
      );
      return { ok: false, code: "MIGRATION_HISTORY_NOT_EMPTY" };
    }
    if (error.code === 1 && output.includes('"code":"MIGRATION_FAILED"')) {
      return { ok: false, code: "MIGRATION_FAILED" };
    }
    // Subprocess errors can retain connection credentials in stdout or stderr.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`Migration subprocess failed unexpectedly (code=${error.code ?? "none"}).`);
  }
}

// The history cases migrate a few hundred databases. Run them in this process: the same
// `migrateWithHistory` call on the same pool as `scripts/migrate-production.mjs`, with that
// command's outcome codes. The mode only selects the script (and its NODE_ENV logging),
// never the migration; `runHistoryCommand` covers the process contract. flag and refusal
// are as for runHistoryCommand: the command prints this same error.message on refusal.
async function runHistoryMigration(db, mode = "development", flag, refusal, assertFailure) {
  assert.ok(["development", "production"].includes(mode));
  assert.ok([undefined, "--check", "--expect-empty"].includes(flag));
  const pool = await createPostgresPool(db.migrationUrl, { max: 1 });
  try {
    const history = await migrateWithHistory(pool, {
      checkOnly: flag === "--check",
      expectEmpty: flag === "--expect-empty",
    });
    return { ok: true, history };
  } catch (error) {
    assertFailure?.(error);
    if (error?.code === "MIGRATION_HISTORY_UNSUPPORTED") {
      if (refusal !== undefined) {
        assert.match(error.message, refusal);
      }
      return { ok: false, code: "MIGRATION_HISTORY_UNSUPPORTED" };
    }
    if (error?.code === "MIGRATION_HISTORY_NOT_EMPTY") {
      assert.ok(
        error.message.includes("use --check to inspect migration history without applying changes"),
      );
      return { ok: false, code: "MIGRATION_HISTORY_NOT_EMPTY" };
    }
    // The command reports any other failure as MIGRATION_FAILED. Here only a PostgreSQL
    // error (SQLSTATE, possibly wrapped by Drizzle) counts, so a test bug cannot pass as one.
    if (
      [error, error?.cause].some(
        (value) => typeof value?.severity === "string" && typeof value?.code === "string",
      )
    ) {
      return { ok: false, code: "MIGRATION_FAILED" };
    }
    throw error;
  } finally {
    await pool.end();
  }
}

async function historyReceipts(client) {
  const { rows } = await client.query(
    `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='drizzle' AND c.relname='__drizzle_migrations') AS present`,
  );
  return !rows[0].present
    ? []
    : (
        await client.query(
          "SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id",
        )
      ).rows;
}

async function historySnapshot(db) {
  return {
    receipts: await historyReceipts(db.migrator),
    occ: await migrationCatalog(db.migrator),
    drizzle: await migrationCatalog(db.migrator, "drizzle"),
    defaultAcls: (
      await db.migrator.query(
        "SELECT oid,defaclrole,defaclnamespace,defaclobjtype,defaclacl::text AS acl FROM pg_catalog.pg_default_acl ORDER BY oid",
      )
    ).rows,
    initialOcc: await initialSchemaState(db.migrator, "occ"),
    initialDrizzle: await initialSchemaState(db.migrator, "drizzle"),
  };
}

async function assertHistoryRefused(db, refusal) {
  const before = await historySnapshot(db);
  for (const [mode, checkOnly] of [
    ["development", true],
    ["development", false],
    ["production", false],
  ]) {
    assert.deepEqual(
      await runHistoryMigration(db, mode, checkOnly ? "--check" : undefined, refusal),
      {
        ok: false,
        code: "MIGRATION_HISTORY_UNSUPPORTED",
      },
    );
    assert.deepEqual(await historySnapshot(db), before);
  }
}

async function assertCompletedHistory(db, previous = []) {
  const manifest = JSON.parse(
    await readFile(join(migrationsDirectory, "meta/_canonical-history.json"), "utf8"),
  );
  const receipts = await historyReceipts(db.migrator);
  assert.equal(receipts.length, manifest.entries.length);
  await assertCredentialSchemaPrivileges(db.app);
  assert.deepEqual(receipts.slice(0, previous.length), previous);
  const providerEntries = manifest.compatibleLineages.providerCompleted.entries;
  const providerLineage = [...providerEntries, ...manifest.entries.slice(providerEntries.length)];
  const expectedEntries =
    previous.length >= providerEntries.length && receiptsMatchEntries(previous, providerLineage)
      ? providerLineage
      : manifest.entries;
  assert.deepEqual(
    receipts.map(({ hash, created_at }) => [hash, Number(created_at)]),
    expectedEntries.map(({ sha256, when }) => [sha256, when]),
  );
  assert.equal(catalogDigest(await migrationCatalog(db.migrator)), manifest.catalogs.completed);
  // Pre-existing Agents receive one empty owned policy and keep delegated editing disabled.
  const policies = await db.app.query(`SELECT bool_and(
    NOT agent.sandbox_policy_editing AND policy.namespace_id=agent.namespace_id
    AND policy.version=1 AND policy.document->'additions'='[]'::jsonb
  ) AS valid, count(policy.id)::integer AS policies, count(agent.id)::integer AS agents
  FROM occ.agents agent LEFT JOIN occ.sandbox_policies policy ON policy.agent_id=agent.id`);
  assert.notEqual(policies.rows[0].valid, false);
  assert.equal(policies.rows[0].policies, policies.rows[0].agents);

  assert.equal(
    (
      await db.app.query(
        "SELECT count(*)::integer AS count FROM occ.agents WHERE repository_access IS NOT NULL",
      )
    ).rows[0].count,
    0,
    "migration must not invent inheritance intent for existing Agent bindings",
  );
  assert.equal(
    catalogDigest(await migrationCatalog(db.migrator, "drizzle")),
    manifest.ledgerCatalogs.completed,
  );
  assert.deepEqual(
    (
      await db.migrator.query(`SELECT p.oid::pg_catalog.regprocedure::text AS identity,
      pg_catalog.pg_get_userbyid(p.proowner) AS owner,p.proconfig,
      pg_catalog.has_function_privilege('occ_app',p.oid,'EXECUTE') AS app_execute,
      pg_catalog.has_function_privilege('public',p.oid,'EXECUTE') AS public_execute
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='occ' AND p.prosecdef ORDER BY identity`)
    ).rows,
    [
      // The app records a standing execution; only the Agent lifecycle trigger can close it.
      ["occ.close_repository_standing_execution()", false],
      ["occ.create_agent_sandbox_policy()", false, "search_path=pg_catalog, occ"],
      ["occ.finalize_agent_deletion(text,text,text,uuid)", true],
      ["occ.record_repository_standing_execution(text,text,text,text,text)", true],
      ["occ.remove_sandbox_policy_access()", false, "search_path=pg_catalog, occ"],
      ["occ.retry_failed_agent_deletion(text,text,text,text)", true],
      ["occ.retry_failed_namespace_deletion(text,text,text)", true],
      // The Agent trigger keeps the credential-source join table exact; occ_app cannot write it.
      ["occ.sync_agent_credential_sources()", false],
      ["occ.validate_access_binding_scope()", false],
      ["occ.validate_group_membership()", false],
      ["occ.validate_restriction_scope()", false],
    ].map(([identity, app_execute, searchPath = "search_path=pg_catalog, occ, pg_temp"]) => ({
      identity,
      owner: "occ_migrator",
      proconfig: [searchPath],
      app_execute,
      public_execute: false,
    })),
  );
}

function receiptsMatchEntries(receipts, entries) {
  return receipts.every(
    (receipt, index) =>
      entries[index] !== undefined &&
      receipt.hash === entries[index].sha256 &&
      Number(receipt.created_at) === entries[index].when,
  );
}

async function seedCanonicalData(
  db,
  { preset = false, computeAdmission = false, executionAdmission = false } = {},
) {
  const installation = `ins_${randomUUID()}`;
  const namespace = `ns_${randomUUID()}`;
  const configuration = `cfg_${randomUUID()}`;
  const agent = `agt_${randomUUID()}`;
  const revision = `rev_${randomUUID()}`;
  const servicePrincipal = `service-agent-${agent}`;
  await db.app.query(
    "INSERT INTO occ.installation(id,name,created_at) VALUES($1,'Migration fixture',now())",
    [installation],
  );
  await db.app.query(
    "INSERT INTO occ.namespaces(id,name,status,created_at) VALUES($1,$2,'ready',now())",
    [namespace, `migration-${randomUUID()}`],
  );
  // A real admitted snapshot exercises the repository migration's replacement
  // constraint. Agent and ServicePrincipal ownership is checked at commit.
  await db.app.query("BEGIN");
  try {
    await db.app.query(
      "INSERT INTO occ.configurations(id,namespace_id,kind,generation,created_at) VALUES($1,$2,'agent',1,now())",
      [configuration, namespace],
    );
    await db.app.query(
      "INSERT INTO occ.iam_identities(id,namespace_id,agent_id,kind) VALUES($1,$2,$3,'service_principal')",
      [servicePrincipal, namespace, agent],
    );
    await db.app.query(
      "INSERT INTO occ.agents(id,namespace_id,name,configuration_id,backend_id,execution_mode,service_principal_id,created_at) VALUES($1,$2,$3,$4,NULL,'dedicated',$5,now())",
      [agent, namespace, `agent-${randomUUID()}`, configuration, servicePrincipal],
    );
    await db.app.query(
      "INSERT INTO occ.agent_revisions(id,namespace_id,agent_id,revision_number,admitted_spec,backend_id,admitted_at) VALUES($1,$2,$3,1,$4,NULL,now())",
      [
        revision,
        namespace,
        agent,
        {
          configuration_id: configuration,
          configuration_kind: "agent",
          configuration_generation: 1,
          draft_spec: {},
          harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
          harness_auth: { method: "runtime" },
          ...(executionAdmission
            ? { execution_admission: { version: 2, mode: "unprotected" } }
            : {}),
          compute: {
            id: "kubernetes",
            implementation: "test",
            ...(computeAdmission ? { admission: `public-github-read:v1:${"a".repeat(64)}` } : {}),
          },
        },
      ],
    );
    await db.app.query("COMMIT");
  } catch (error) {
    await db.app.query("ROLLBACK");
    throw error;
  }
  await db.app.query(
    `INSERT INTO occ.controller_work(idempotency_key,namespace_id,namespace_target,actor_id,state,available_at,completed_at,reason_code,created_at,updated_at)
    VALUES($1,$2,'ready','migration-fixture','succeeded',now(),now(),'NAMESPACE_READY',now(),now())`,
    [`work-${randomUUID()}`, namespace],
  );
  await db.app.query(
    `INSERT INTO occ.audit_events(id,occurred_at,kind,actor_id,action,namespace_id,resource_kind,resource_id,outcome,details)
    VALUES($1,now(),'mutation','migration-fixture','reconcile',$2,'namespace',$2,'success','{"reasonCode":"NAMESPACE_READY"}')`,
    [`aud_${randomUUID()}`, namespace],
  );
  // Stored human sign-in state: a password method, an external method holding
  // provider tokens, and a live session. Later auth migrations alter these tables.
  const user = `usr_${randomUUID()}`;
  await db.app.query(
    `INSERT INTO occ."user"(id,name,email,email_verified,created_at,updated_at)
    VALUES($1,'Migration fixture',$2,true,now(),now())`,
    [user, `migration-${randomUUID()}@example.test`],
  );
  await db.app.query(
    `INSERT INTO occ.account(id,account_id,provider_id,user_id,password,created_at,updated_at)
    VALUES($1,$2,'credential',$2,'fixture-password-hash',now(),now())`,
    [`acc_${randomUUID()}`, user],
  );
  await db.app.query(
    `INSERT INTO occ.account(id,account_id,provider_id,user_id,access_token,refresh_token,id_token,
      access_token_expires_at,refresh_token_expires_at,scope,created_at,updated_at)
    VALUES($1,$2,'oidc',$3,'fixture-access','fixture-refresh','fixture-id',
      now()+interval '1 hour',now()+interval '1 day','openid email',now(),now())`,
    [`acc_${randomUUID()}`, `subject-${randomUUID()}`, user],
  );
  await db.app.query(
    `INSERT INTO occ.session(id,expires_at,token,created_at,updated_at,ip_address,user_agent,user_id)
    VALUES($1,now()+interval '1 day',$2,now(),now(),'127.0.0.1','migration-fixture',$3)`,
    [`ses_${randomUUID()}`, `token-${randomUUID()}`, user],
  );
  if (preset) {
    await db.app.query(
      "INSERT INTO occ.presets(id,namespace_id,name,template,created_at) VALUES($1,$2,'Migration preset',$3,now())",
      [
        `pre_${randomUUID()}`,
        namespace,
        {
          agent: { name: "Preset Agent", executionMode: "dedicated" },
          configuration: { values: {} },
        },
      ],
    );
  }
  return namespace;
}

async function seedProviderCompletedData(db) {
  const installation = `ins_${randomUUID()}`;
  const namespace = `ns_${randomUUID()}`;
  const configuration = `cfg_${randomUUID()}`;
  const agent = `agt_${randomUUID()}`;
  const revision = `rev_${randomUUID()}`;
  const serviceAccount = `sa_${randomUUID()}`;
  const preset = `pre_${randomUUID()}`;
  const admission = `admission-${randomUUID()}`;
  const servicePrincipal = `service-agent-${agent}`;
  const fingerprint = createHash("sha256").update(`provider-plan-${randomUUID()}`).digest("hex");
  await db.app.query(
    "INSERT INTO occ.installation(id,name,created_at) VALUES($1,'Provider fixture',now())",
    [installation],
  );
  await db.app.query(
    "INSERT INTO occ.namespaces(id,name,status,created_at) VALUES($1,$2,'ready',now())",
    [namespace, `provider-${randomUUID()}`],
  );
  await db.app.query(
    `INSERT INTO occ.presets(id,namespace_id,name,template,created_at)
     VALUES($1,$2,'Provider preset',$3::jsonb,now())`,
    [
      preset,
      namespace,
      JSON.stringify({ agent: { name: "Provider preset agent", providerId: "openai" } }),
    ],
  );
  await db.app.query("BEGIN");
  try {
    await db.app.query(
      "INSERT INTO occ.configurations(id,namespace_id,kind,generation,created_at) VALUES($1,$2,'agent',1,now())",
      [configuration, namespace],
    );
    await db.app.query(
      "INSERT INTO occ.service_accounts(id,namespace_id,name,credential) VALUES($1,$2,'Provider account',NULL)",
      [serviceAccount, namespace],
    );
    await db.app.query(
      "INSERT INTO occ.iam_identities(id,namespace_id,agent_id,kind) VALUES($1,$2,$3,'service_principal')",
      [servicePrincipal, namespace, agent],
    );
    await db.app.query(
      `INSERT INTO occ.agents
        (id, namespace_id, name, configuration_id, provider_id, execution_mode,
         service_principal_id, harness_auth, created_at)
       VALUES($1,$2,'Provider agent',$3,'openai','dedicated',$4,$5::jsonb,now())`,
      [
        agent,
        namespace,
        configuration,
        servicePrincipal,
        JSON.stringify({ method: "chatgpt_service_account", serviceAccountId: serviceAccount }),
      ],
    );
    await db.app.query(
      `INSERT INTO occ.agent_revisions
        (id,namespace_id,agent_id,revision_number,provider_id,admitted_spec,admitted_at)
       VALUES($1,$2,$3,1,'openai',$4::jsonb,now())`,
      [
        revision,
        namespace,
        agent,
        JSON.stringify({
          configuration_id: configuration,
          configuration_kind: "agent",
          configuration_generation: 1,
          draft_spec: {},
          harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
          harness_auth: {
            method: "chatgpt_service_account",
            serviceAccountId: serviceAccount,
            credential: { kind: "access_token", secretRef: { name: "svc-token", key: "token" } },
            providerBinding: {
              providerId: "openai",
              driverId: "chatgpt-service-accounts",
              workspaceId: "workspace",
              credentialIssued: true,
            },
          },
          compute: { id: "kubernetes", implementation: "test" },
          repository_credentials: {
            driver: { id: "repository-credentials", implementation: "github" },
            deadlineWallMs: 1,
            bindings: [
              {
                repositoryRef: "openclaw-enterprise",
                profile: "git-write",
                providerId: "repository-provider",
                grant: {
                  providerInstanceId: "github-app",
                  repositoryId: "repo-id",
                  grantId: "grant-id",
                },
              },
            ],
          },
        }),
      ],
    );
    await db.app.query("COMMIT");
  } catch (error) {
    await db.app.query("ROLLBACK");
    throw error;
  }
  await db.migrator.query(
    `INSERT INTO occ.service_account_driver_bindings
      (service_account_id, namespace_id, provider_id, driver_id, external_account_id, workspace_id)
     VALUES($1,$2,'openai','chatgpt-service-accounts','external-account','workspace')`,
    [serviceAccount, namespace],
  );
  await db.app.query("UPDATE occ.agents SET desired_runtime_state='running' WHERE id=$1", [agent]);
  await db.app.query(
    `INSERT INTO occ.repository_session_attempts
      (namespace_id,agent_id,revision_id,repository_ref,admission_id,duration_seconds,
       deadline_wall_ms,phase,created_at,updated_at)
     VALUES($1,$2,$3,'openclaw-enterprise',$4,60,1,'opening',now(),now())`,
    [namespace, agent, revision, admission],
  );
  await db.app.query(
    `INSERT INTO occ.controller_work
      (idempotency_key,namespace_id,actor_id,work_kind,state,available_at,completed_at,reason_code,created_at,updated_at)
     VALUES($1,$2,'provider-fixture','provisioning','succeeded',now(),now(),'PROVISIONING_SUCCEEDED',now(),now())`,
    [`work-${randomUUID()}`, namespace],
  );
  const workId = (
    await db.app.query("SELECT idempotency_key FROM occ.controller_work WHERE namespace_id=$1", [
      namespace,
    ])
  ).rows[0].idempotency_key;
  await db.app.query(
    `INSERT INTO occ.agent_provisioning_work
      (work_id,namespace_id,agent_id,configuration_id,actor_id,request_id,request_fingerprint,
       status,completed_phase,revision_id,plan,progress,created_at,updated_at)
     VALUES($1,$2,$3,$4,'provider-fixture','request-1',$5,'succeeded','handoff',$6,$7::jsonb,'{}'::jsonb,now(),now())`,
    [
      workId,
      namespace,
      agent,
      configuration,
      fingerprint,
      revision,
      JSON.stringify({
        name: "Provider agent",
        providerId: "openai",
        executionMode: "dedicated",
        configuration: { kind: "agent", values: {} },
        harnessAuth: { method: "chatgpt_service_account", serviceAccountId: serviceAccount },
        repositoryBindings: [{ repositoryRef: "openclaw-enterprise", profile: "git-write" }],
        drivers: {
          compute: "compute-kubernetes",
          configuration: "config-kubernetes",
          iam: "native-iam",
        },
      }),
    ],
  );
  return {
    namespace,
    agent,
    revision,
    serviceAccount,
    preset,
    admission,
    workId,
    fingerprint,
  };
}

// Migration 0037 adds authentication-version columns, the identity-only CHECK
// and the method guard trigger to occ.account. Populated upgrades must default
// the new columns onto stored methods and enforce both rules on those rows.
async function assertUpgradedAuthentication(db) {
  assert.deepEqual(
    (
      await db.app.query(
        `SELECT provider_id,authentication_version,identity_only FROM occ.account ORDER BY provider_id`,
      )
    ).rows,
    [
      { provider_id: "credential", authentication_version: 1, identity_only: false },
      { provider_id: "oidc", authentication_version: 1, identity_only: false },
    ],
  );
  assert.equal(
    (await db.app.query("SELECT count(*)::integer AS sessions FROM occ.session")).rows[0].sessions,
    1,
  );
  assert.deepEqual(
    (
      await db.app.query(
        "UPDATE occ.account SET password='rotated-fixture-hash' WHERE provider_id='credential' RETURNING authentication_version",
      )
    ).rows,
    [{ authentication_version: 2 }],
  );
  await assert.rejects(
    db.app.query("UPDATE occ.account SET identity_only=true WHERE provider_id='oidc'"),
    (error) => error.code === "23514" && error.constraint === "account_identity_only",
  );
  assert.deepEqual(
    (
      await db.app.query(
        `UPDATE occ.account SET identity_only=true,access_token=NULL,refresh_token=NULL,id_token=NULL,
          access_token_expires_at=NULL,refresh_token_expires_at=NULL,scope=NULL
        WHERE provider_id='oidc' RETURNING authentication_version`,
      )
    ).rows,
    [{ authentication_version: 2 }],
  );
}

const legacyExecutionAdmission = { version: 2, mode: "unprotected" };

// A revision admitted before 0060 carries no execution admission. The upgrade records
// the unprotected decision it was admitted under; every other stored field stays identical.
function upgradedCanonicalData(data) {
  return {
    ...data,
    agent_revisions: data.agent_revisions.map(({ value }) => ({
      value: Object.hasOwn(value.admitted_spec, "execution_admission")
        ? value
        : {
            ...value,
            admitted_spec: {
              ...value.admitted_spec,
              execution_admission: legacyExecutionAdmission,
            },
          },
    })),
  };
}

// Every pre-existing Agent must stay readable through the application adapter after
// the upgrade: createRevision decodes the earlier revisions, and the worker's reconcile,
// stop, retire and delete paths all go through findRevision or listRevisions.
async function assertUpgradedRevisionReadable(db) {
  const { PostgresPlatformState } = await import("../../packages/occ/src/state/postgres-state.ts");
  const application = new URL(db.migrationUrl);
  application.username = "occ_app";
  application.password = "occ-app-local";
  const seeded = (await db.app.query("SELECT namespace_id, agent_id, id FROM occ.agent_revisions"))
    .rows;
  assert.equal(seeded.length, 1);
  const { namespace_id: namespaceId, agent_id: agentId, id } = seeded[0];
  const pool = new pg.Pool({ connectionString: application.toString(), max: 1 });
  try {
    const state = new PostgresPlatformState(pool);
    const found = await state.read((view) => view.revisions.findRevision(namespaceId, agentId, id));
    assert.equal(found?.id, id, "findRevision must decode the pre-upgrade revision");
    assert.deepEqual(found.executionAdmission, legacyExecutionAdmission);
    assert.equal(found.egressPlan, undefined);
    const listed = await state.read((view) => view.revisions.listRevisions(namespaceId, agentId));
    assert.deepEqual(
      listed.map((revision) => [revision.id, revision.executionAdmission]),
      [[id, legacyExecutionAdmission]],
      "listRevisions must decode the pre-upgrade revision",
    );
  } finally {
    await pool.end();
  }
  // The decision is now proven for every stored row, not only for new writers.
  assert.deepEqual(
    (
      await db.migrator.query(
        `SELECT convalidated FROM pg_catalog.pg_constraint
         WHERE conrelid='occ.agent_revisions'::pg_catalog.regclass AND conname='agent_revisions_execution_admission'`,
      )
    ).rows,
    [{ convalidated: true }],
  );
  // The recorded decision stays immutable: the migrator's row rewrite is closed again and
  // the application role never held UPDATE, so an unprotected revision cannot later claim
  // protection or an egress plan.
  await assert.rejects(
    db.migrator.query(
      `UPDATE occ.agent_revisions
       SET admitted_spec = admitted_spec || '{"execution_admission":{"version":2,"mode":"protected"}}'::jsonb
       WHERE id=$1`,
      [id],
    ),
    (error) => error.code === "55000",
  );
  assert.equal(
    (
      await db.app.query(
        "SELECT has_table_privilege(current_user,'occ.agent_revisions','UPDATE') AS allowed",
      )
    ).rows[0].allowed,
    false,
  );
  // New rows still fail closed: no snapshot may omit its decision, and a decision that
  // claims protection without the protected plan and reader marker is inconsistent.
  const revisionId = `rev_${randomUUID()}`;
  const insertRevision = (rewrite, ...parameters) =>
    db.app.query(
      `INSERT INTO occ.agent_revisions(id,namespace_id,agent_id,revision_number,admitted_spec,backend_id,admitted_at)
       SELECT $1, namespace_id, agent_id, 2, ${rewrite}, NULL, now() FROM occ.agent_revisions WHERE id=$2`,
      [revisionId, id, ...parameters],
    );
  const invalidAdmission = (error) =>
    error.code === "23514" && error.constraint === "agent_revisions_execution_admission";
  for (const rewrite of [
    "admitted_spec - 'execution_admission'",
    `admitted_spec || '{"execution_admission":{"version":2,"mode":"protected"}}'::jsonb`,
  ]) {
    await assert.rejects(insertRevision(rewrite), invalidAdmission);
  }

  // Draft-only protected v2 must fail even with a scoped plan and matching reader marker.
  const plan = { execution: { namespaceId, agentId, revisionId }, routes: [] };
  const insertProtectedV2 = (egressPlan) =>
    insertRevision(
      `jsonb_set(admitted_spec, '{harness_auth,protectedExecutionVersion}', '2'::jsonb)
       || jsonb_build_object('execution_admission', '{"version":2,"mode":"protected"}'::jsonb,
                             'egress_plan', $3::jsonb)`,
      egressPlan,
    );
  await assert.rejects(insertProtectedV2(plan), invalidAdmission);
  await assert.rejects(
    insertProtectedV2({ ...plan, repositoryGitAuthorization: "online-request" }),
    invalidAdmission,
  );
  assert.equal(
    (await db.app.query("SELECT count(*)::integer AS count FROM occ.agent_revisions")).rows[0]
      .count,
    1,
  );
}

async function canonicalData(db) {
  const result = { presets: [] };
  const migrationOwnedColumns = {
    account: ["authentication_version", "identity_only"],
    agents: [
      "repository_bindings",
      "repository_access",
      "harness_auth_credential_source_id",
      "plugin_approvers",
      "credential_sources",
      "sandbox_policy_editing",
      "gateway_managed_mode",
    ],
    agent_revisions: ["gateway_managed_mode"],
    controller_work: ["work_kind"],
  };
  const hasPresets =
    (await db.app.query("SELECT to_regclass('occ.presets') AS relation")).rows[0].relation !== null;
  for (const table of [
    "installation",
    "namespaces",
    "configurations",
    "agents",
    "agent_revisions",
    "controller_work",
    "audit_events",
    "iam_identities",
    "iam_roles",
    "iam_groups",
    "iam_group_memberships",
    "iam_access_bindings",
    "iam_restrictions",
    "user",
    "account",
    "session",
    ...(hasPresets ? ["presets"] : []),
  ]) {
    result[table] = (
      await db.app.query(
        // New migration-owned compatibility columns may be defaulted onto
        // existing rows; every previously stored field must remain identical.
        `SELECT to_jsonb(t) - $1::pg_catalog.text[] AS value FROM occ."${table}" t ORDER BY to_jsonb(t)::pg_catalog.text`,
        [migrationOwnedColumns[table] ?? []],
      )
    ).rows;
  }
  return result;
}

test(
  "First installation requires empty migration history under the migration lock",
  requiresHistoryPostgres,
  async (context) => {
    const fixture = await migrationHistoryFixture();
    const db = await historyDatabase(context, fixture, "first_install");
    // The real production command: its exit code, stdout outcome and refusal message.
    const firstInstall = () => runHistoryCommand(db, "production", "--expect-empty");
    const refused = { ok: false, code: "MIGRATION_HISTORY_NOT_EMPTY" };
    // Concurrent callers both intend a first installation. Only the lock winner may migrate.
    const results = await Promise.all([firstInstall(), firstInstall()]);
    assert.deepEqual(
      results.sort((a, b) => Number(b.ok) - Number(a.ok)),
      [{ ok: true, history: "empty" }, refused],
    );
    await assertCompletedHistory(db);

    const before = await historySnapshot(db);
    assert.deepEqual(await firstInstall(), refused);
    assert.deepEqual(await historySnapshot(db), before);
    assert.deepEqual(await runHistoryCommand(db, "production", "--check"), {
      ok: true,
      history: "completed",
    });
  },
);

test(
  "Canonical migration commands preserve main data and serialize fresh/repeat runners",
  concurrentHistoryPostgres,
  async (context) => {
    const fixture = await migrationHistoryFixture();
    for (const schemas of [false, true]) {
      void context.test(
        `fresh ${schemas ? "owner-only schemas" : "absent schemas"}`,
        async (child) => {
          const db = await historyDatabase(child, fixture, "fresh", { schemas });
          const before = await historySnapshot(db);
          assert.deepEqual(await runHistoryMigration(db, "development", "--check"), {
            ok: true,
            history: "empty",
          });
          assert.deepEqual(await historySnapshot(db), before);
          // Two real processes (both scripts) race for the migration lock once; the
          // owner-only case races in-process connections.
          const migrate = schemas ? runHistoryMigration : runHistoryCommand;
          const results = await Promise.all([migrate(db), migrate(db, "production")]);
          assert.deepEqual(
            results.map((result) => result.ok),
            [true, true],
          );
          assert.deepEqual(results.map((result) => result.history).sort(), ["completed", "empty"]);
          await assertCompletedHistory(db);
          const after = await historySnapshot(db);
          assert.deepEqual(await runHistoryMigration(db), { ok: true, history: "completed" });
          assert.deepEqual(await runHistoryMigration(db, "production"), {
            ok: true,
            history: "completed",
          });
          assert.deepEqual(await historySnapshot(db), after);
        },
      );
    }
    for (const [prefix, history] of [
      [24, "prePresetsMain"],
      [25, "main"],
      [28, "repositoryRetention"],
      [29, "workspaceSetup"],
      [30, "agentProvisioning"],
      [31, "backendCompleted"],
      [32, "backendTerminology"],
      [33, "prePluginApprovers"],
      [34, "preBrokerReceipts"],
      [35, "preAgentDeletion"],
      [36, "preDeploymentProgress"],
      [37, "preHumanAuthentication"],
      [38, "preAgentDeletionTakeover"],
      [39, "preNamespaceDeletionTakeover"],
      [40, "preRepositoryAccess"],
      [41, "preRestrictionReadLogs"],
      [42, "preOAuth"],
      [43, "preCredentialWithdrawals"],
      [44, "preBrokerReceiptFence"],
      [45, "preModelProbeFailureCause"],
      [46, "preProvisioningConfigurationRelease"],
      [47, "preAdministratorCredentialSourceGrants"],
      [48, "preCodexPatSources"],
      [49, "preAgentCredentialSources"],
      [50, "preCredentialWithdrawalRequester"],
      [51, "preProvisioningDeploymentOutcome"],
      [52, "preComputePreparationFailureEvidence"],
      [53, "preCredentialSourcePat"],
      [54, "preComputeRevisionAdmission"],
      [55, "preHeldAuthenticationSession"],
      [56, "preCanonicalHarnessAuth"],
      [57, "preSandboxPolicies"],
      [58, "preSandboxPolicyAdministrator"],
      [59, "preCredentialProxy"],
      [62, "prePreparedAttemptSettlement"],
      [63, "preGatewayManagedMode"],
    ]) {
      void context.test(`populated canonical ${history}`, async (child) => {
        const db = await historyDatabase(child, fixture, "main", { prefix });
        const namespaceId = await seedCanonicalData(db, {
          preset: prefix >= 25,
          computeAdmission: prefix >= 55,
          // 0060 requires an execution admission on every revision written after it.
          executionAdmission: prefix >= 62,
        });
        const assertSourceOwners =
          prefix === 59
            ? await retainGatewaySourcesAcrossProxyAdmission(db.app, db.migrator, namespaceId)
            : undefined;
        const before = await canonicalData(db);
        const receipts = await historyReceipts(db.migrator);
        assert.deepEqual(await runHistoryMigration(db, "production", "--check"), {
          ok: true,
          history,
        });
        assert.deepEqual(await runHistoryMigration(db), { ok: true, history });
        await assertSourceOwners?.();
        await assertCompletedHistory(db, receipts);
        await assertUpgradedRevisionReadable(db);
        assert.deepEqual(await canonicalData(db), upgradedCanonicalData(before));
        await assertUpgradedAuthentication(db);
        if (history === "preGatewayManagedMode") {
          await db.app.query(
            `INSERT INTO occ.agent_revisions
               (id, namespace_id, agent_id, revision_number, backend_id, admitted_spec, admitted_at)
             SELECT $1, namespace_id, agent_id, revision_number + 1, backend_id, admitted_spec, now()
             FROM occ.agent_revisions`,
            [`rev_${randomUUID()}`],
          );
          assert.deepEqual(
            (
              await db.app.query(
                `SELECT a.gateway_managed_mode AS desired, r.gateway_managed_mode AS admitted
                 FROM occ.agents a JOIN occ.agent_revisions r
                   ON r.namespace_id = a.namespace_id AND r.agent_id = a.id ORDER BY r.revision_number`,
              )
            ).rows,
            [
              { desired: true, admitted: false },
              { desired: true, admitted: true },
            ],
          );
        }
        if (prefix === 59) {
          const upgradedReceipts = await historyReceipts(db.migrator);
          const sessions = await db.app.query("SELECT count(*)::integer AS count FROM occ.session");
          child.diagnostic(
            JSON.stringify({
              scenario: "previous-schema-upgrade",
              oldReceipts: receipts.length,
              newReceipts: upgradedReceipts.length,
              retainedSessions: sessions.rows[0].count,
              preservedStoredRows: true,
            }),
          );
        }
        // Main's existing IAM DELETE compatibility grant belongs to its later controlled-writer transition.
        assert.equal(
          (
            await db.app.query(
              "SELECT has_table_privilege(current_user,'occ.iam_access_bindings','DELETE') AS allowed",
            )
          ).rows[0].allowed,
          true,
        );
      });
    }
  },
);

test(
  "External ChatGPT migration rejects retired OAuth state and admits only source metadata",
  requiresHistoryPostgres,
  async (context) => {
    const fixture = await migrationHistoryFixture();
    const db = await historyDatabase(context, fixture, "externalchatgpt", { prefix: 56 });
    const namespaceId = await seedCanonicalData(db);
    const sourceId = `cs_${randomUUID()}`;
    await db.app.query(
      `INSERT INTO occ.credential_sources(id,namespace_id,name,type,config,driver_id,state,created_at)
       VALUES($1,$2,'External ChatGPT','chatgpt','{}','external-gateway','ready',now())`,
      [sourceId, namespaceId],
    );
    const binding = {
      method: "credential_source",
      sourceId,
      credentialGatewayId: "external-gateway",
      sourceType: "chatgpt",
      loginMode: "chatgptAuthTokens",
    };
    let revisionNumber = 2;
    let executionAdmission = {};
    const insertSnapshot = (auth) =>
      db.app.query(
        `INSERT INTO occ.agent_revisions(id,namespace_id,agent_id,revision_number,admitted_spec,backend_id,admitted_at)
         SELECT $2,namespace_id,agent_id,$3,
           jsonb_set(admitted_spec,'{harness_auth}',$4::jsonb) || '{"sandbox_driver_id":"external-sandbox"}'::jsonb || $5::jsonb,
           backend_id,now()
         FROM occ.agent_revisions WHERE namespace_id=$1 AND revision_number=1
         RETURNING admitted_spec->'harness_auth' AS auth`,
        [
          namespaceId,
          `rev_${randomUUID()}`,
          revisionNumber++,
          JSON.stringify(auth),
          executionAdmission,
        ],
      );
    const invalidSnapshot = (error) =>
      error.code === "23514" && error.constraint === "agent_revisions_admitted_snapshot";

    // A valid PAT snapshot from main must survive the new function replacement.
    const patSourceId = `cs_${randomUUID()}`;
    await db.app.query(
      `INSERT INTO occ.credential_sources(id,namespace_id,name,type,config,driver_id,state,created_at)
       VALUES($1,$2,'Existing PAT','codex-pat','{}','external-gateway','ready',now())`,
      [patSourceId, namespaceId],
    );
    const patBinding = {
      ...binding,
      sourceId: patSourceId,
      sourceType: "codex-pat",
      loginMode: "codex_pat",
    };
    assert.deepEqual((await insertSnapshot(patBinding)).rows, [{ auth: patBinding }]);

    // Exercise the actual old CHECK constraint first, not the application validator.
    await assert.rejects(insertSnapshot(binding), invalidSnapshot);
    const secretId = `sec_${randomUUID()}`;
    await db.app.query(
      `INSERT INTO occ.secrets(id,namespace_id,name,driver_id,backend_namespace_name,backend_name,backend_key,backend_uid,created_at)
       VALUES($1,$2,'Legacy OAuth','secrets','fixture','oauth-source','value',$3,now())`,
      [secretId, namespaceId, randomUUID()],
    );
    const legacyBinding = {
      method: "oauth",
      source: { kind: "secret", namespaceId, id: secretId },
    };
    await db.app.query("UPDATE occ.agents SET harness_auth=$2::jsonb WHERE namespace_id=$1", [
      namespaceId,
      JSON.stringify(legacyBinding),
    ]);
    // A preexisting native OAuth binding blocks the new grammar atomically; the
    // migration cannot silently relabel a Secret as a gateway-owned connection.
    const beforeRefusal = await historySnapshot(db);
    // The real command reports a failed migration transaction as MIGRATION_FAILED.
    assert.deepEqual(await runHistoryCommand(db), { ok: false, code: "MIGRATION_FAILED" });
    assert.deepEqual(await historySnapshot(db), beforeRefusal);
    assert.deepEqual(
      (
        await db.app.query("SELECT harness_auth FROM occ.agents WHERE namespace_id=$1", [
          namespaceId,
        ])
      ).rows,
      [{ harness_auth: legacyBinding }],
    );
    await db.app.query("UPDATE occ.agents SET harness_auth=NULL WHERE namespace_id=$1", [
      namespaceId,
    ]);
    const receipts = await historyReceipts(db.migrator);
    assert.deepEqual(await runHistoryMigration(db), {
      ok: true,
      history: "preCanonicalHarnessAuth",
    });
    await assertCompletedHistory(db, receipts);
    executionAdmission = { execution_admission: { version: 2, mode: "unprotected" } };
    assert.deepEqual((await insertSnapshot(binding)).rows, [{ auth: binding }]);
    const apiKey = { ...binding, loginMode: "api_key" };
    assert.deepEqual((await insertSnapshot(apiKey)).rows, [{ auth: apiKey }]);
    assert.deepEqual(
      (
        await db.app.query(
          "SELECT admitted_spec->'harness_auth' AS auth FROM occ.agent_revisions WHERE admitted_spec #>> '{harness_auth,sourceId}'=$1",
          [patSourceId],
        )
      ).rows,
      [{ auth: patBinding }],
    );
    assert.deepEqual((await insertSnapshot(patBinding)).rows, [{ auth: patBinding }]);
    // Only the admitted mode expands: unknown modes and credential payloads remain invalid.
    await assert.rejects(insertSnapshot({ ...binding, loginMode: "unknown" }), invalidSnapshot);
    await assert.rejects(
      insertSnapshot({ ...binding, accessTokenPlaceholder: "synthetic-placeholder" }),
      invalidSnapshot,
    );
  },
);

test(
  "Canonical repository-prefix upgrade retains exact attempt cleanup context",
  requiresHistoryPostgres,
  async (context) => {
    const fixture = await migrationHistoryFixture();
    const db = await historyDatabase(context, fixture, "repository", { prefix: 27 });
    const namespaceId = await seedCanonicalData(db, { preset: true });
    const snapshot = repositoryCredentials();
    const revisionId = `rev_${randomUUID()}`;
    const admissionId = `admission-${randomUUID()}`;
    const owner = (
      await db.app.query(
        `INSERT INTO occ.agent_revisions (id,namespace_id,agent_id,revision_number,admitted_spec,backend_id,admitted_at)
     SELECT $2,namespace_id,agent_id,2,admitted_spec || jsonb_build_object('repository_credentials',$3::jsonb),backend_id,now()
     FROM occ.agent_revisions WHERE namespace_id=$1 RETURNING agent_id`,
        [namespaceId, revisionId, JSON.stringify(snapshot)],
      )
    ).rows[0].agent_id;
    await db.app.query("UPDATE occ.agents SET desired_runtime_state='running' WHERE id=$1", [
      owner,
    ]);
    await db.app.query(
      `INSERT INTO occ.repository_session_attempts
     (namespace_id,agent_id,revision_id,repository_ref,admission_id,duration_seconds,deadline_wall_ms,phase,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,60,$6,'opening',now(),now())`,
      [
        namespaceId,
        owner,
        revisionId,
        snapshot.bindings[0].repositoryRef,
        admissionId,
        snapshot.deadlineWallMs,
      ],
    );
    const before = (
      await db.app.query(
        "SELECT to_jsonb(attempt) AS value FROM occ.repository_session_attempts AS attempt",
      )
    ).rows;
    const receipts = await historyReceipts(db.migrator);
    assert.deepEqual(await runHistoryMigration(db, "production", "--check"), {
      ok: true,
      history: "repositoryCredentials",
    });
    assert.deepEqual(await runHistoryMigration(db), { ok: true, history: "repositoryCredentials" });
    await assertCompletedHistory(db, receipts);
    const retained = (
      await db.app.query(
        "SELECT to_jsonb(attempt) AS value FROM occ.repository_session_attempts AS attempt",
      )
    ).rows;
    assert.deepEqual(
      retained,
      before.map(({ value }) => ({
        value: {
          ...value,
          broker_protocol: 0,
          live_revision_id: revisionId,
          cleanup_context: { driver: snapshot.driver, binding: snapshot.bindings[0] },
          // Upgrading this attempt must not turn it into a successor of another session.
          predecessor_admission_id: null,
          execution_fingerprint: null,
        },
      })),
    );
    assert.deepEqual(await runHistoryMigration(db, "production"), {
      ok: true,
      history: "completed",
    });
  },
);

test(
  "Provider migration preserves fingerprints and rejects retired managed PAT bindings",
  requiresHistoryPostgres,
  async (context) => {
    const fixture = await migrationHistoryFixture();
    const db = await historyDatabase(context, fixture, "providerlineage");
    await installProviderCompletedHistory(db);
    const seeded = await seedProviderCompletedData(db);
    const receipts = await historyReceipts(db.migrator);
    assert.equal(receipts.length, 31);
    assert.deepEqual(await runHistoryMigration(db, "production", "--check"), {
      ok: true,
      history: "providerCompleted",
    });
    // Preserve the historical terminology migration proof through its supported auth shape.
    // The canonical PAT-source migration must then refuse the retired binding atomically.
    await installCanonicalPrefix(db, 48);
    assert.deepEqual((await historyReceipts(db.migrator)).slice(0, receipts.length), receipts);
    assert.deepEqual(
      (
        await db.app.query(
          `SELECT backend_id AS "backendId", harness_auth AS "harnessAuth"
           FROM occ.agents WHERE namespace_id=$1 AND id=$2`,
          [seeded.namespace, seeded.agent],
        )
      ).rows,
      [
        {
          backendId: "openai",
          harnessAuth: {
            method: "chatgpt_service_account",
            serviceAccountId: seeded.serviceAccount,
          },
        },
      ],
    );
    const revision = (
      await db.app.query(
        `SELECT backend_id AS "backendId",
                admitted_spec #> '{harness_auth,backendBinding}' AS "backendBinding",
                admitted_spec #> '{harness_auth,providerBinding}' AS "providerBinding",
                admitted_spec #> '{repository_credentials,bindings,0,backendId}' AS "repositoryBackendId",
                admitted_spec #> '{repository_credentials,bindings,0,providerId}' AS "repositoryProviderId"
         FROM occ.agent_revisions WHERE namespace_id=$1 AND id=$2`,
        [seeded.namespace, seeded.revision],
      )
    ).rows[0];
    assert.deepEqual(revision, {
      backendId: "openai",
      backendBinding: {
        backendId: "openai",
        driverId: "chatgpt-service-accounts",
        workspaceId: "workspace",
        credentialIssued: true,
      },
      providerBinding: null,
      repositoryBackendId: "repository-provider",
      repositoryProviderId: null,
    });
    assert.deepEqual(
      (
        await db.migrator.query(
          `SELECT backend_id AS "backendId" FROM occ.service_account_driver_bindings
           WHERE namespace_id=$1 AND service_account_id=$2`,
          [seeded.namespace, seeded.serviceAccount],
        )
      ).rows,
      [{ backendId: "openai" }],
    );
    assert.deepEqual(
      (
        await db.app.query(
          `SELECT request_fingerprint AS "requestFingerprint",
                  plan->>'backendId' AS "backendId",
                  plan ? 'providerId' AS "hasProviderId"
           FROM occ.agent_provisioning_work WHERE work_id=$1`,
          [seeded.workId],
        )
      ).rows,
      [{ requestFingerprint: seeded.fingerprint, backendId: "openai", hasProviderId: false }],
    );
    assert.deepEqual(
      (
        await db.app.query(
          `SELECT template #>> '{agent,backendId}' AS "backendId",
                  template #> '{agent,providerId}' AS "providerId"
           FROM occ.presets WHERE namespace_id=$1 AND id=$2`,
          [seeded.namespace, seeded.preset],
        )
      ).rows,
      [{ backendId: "openai", providerId: null }],
    );
    assert.deepEqual(
      (
        await db.app.query(
          `SELECT cleanup_context #>> '{binding,backendId}' AS "backendId",
                  cleanup_context #> '{binding,providerId}' AS "providerId"
           FROM occ.repository_session_attempts WHERE admission_id=$1`,
          [seeded.admission],
        )
      ).rows,
      [{ backendId: "repository-provider", providerId: null }],
    );
    assert.deepEqual(
      (
        await db.migrator.query(
          `SELECT table_name,column_name FROM information_schema.columns
	           WHERE table_schema='occ'
	             AND table_name IN ('agents','agent_revisions','service_account_driver_bindings')
	             AND column_name='provider_id'
	           ORDER BY table_name,column_name`,
        )
      ).rows,
      [],
    );
    assert.deepEqual(
      (
        await db.migrator.query(
          `SELECT table_name,column_name FROM information_schema.columns
	           WHERE table_schema='occ' AND table_name='account' AND column_name='provider_id'`,
        )
      ).rows,
      [{ table_name: "account", column_name: "provider_id" }],
    );
    assert.deepEqual(await runHistoryMigration(db, "production", "--check"), {
      ok: true,
      history: "preCodexPatSources",
    });
    const beforeRefusal = await historySnapshot(db);
    assert.deepEqual(await runHistoryMigration(db, "production"), {
      ok: false,
      code: "MIGRATION_FAILED",
    });
    assert.deepEqual(await historySnapshot(db), beforeRefusal);
  },
);

test(
  "Canonical migration completes a Provider lineage after later canonical migrations",
  concurrentHistoryPostgres,
  async (context) => {
    const fixture = await migrationHistoryFixture();
    for (const [prefix, history] of [
      [32, "backendTerminology"],
      [33, "prePluginApprovers"],
      [34, "preBrokerReceipts"],
      [35, "preAgentDeletion"],
      [36, "preDeploymentProgress"],
      [37, "preHumanAuthentication"],
      [38, "preAgentDeletionTakeover"],
      [39, "preNamespaceDeletionTakeover"],
      [40, "preRepositoryAccess"],
      [41, "preRestrictionReadLogs"],
      [42, "preOAuth"],
      [43, "preCredentialWithdrawals"],
      [44, "preBrokerReceiptFence"],
      [45, "preModelProbeFailureCause"],
      [46, "preProvisioningConfigurationRelease"],
      [47, "preAdministratorCredentialSourceGrants"],
      [48, "preCodexPatSources"],
      [49, "preAgentCredentialSources"],
      [50, "preCredentialWithdrawalRequester"],
      [51, "preProvisioningDeploymentOutcome"],
      [52, "preComputePreparationFailureEvidence"],
      [53, "preCredentialSourcePat"],
      [54, "preComputeRevisionAdmission"],
      [55, "preHeldAuthenticationSession"],
      [56, "preCanonicalHarnessAuth"],
      [57, "preSandboxPolicies"],
      [58, "preSandboxPolicyAdministrator"],
      [59, "preCredentialProxy"],
      [62, "prePreparedAttemptSettlement"],
    ]) {
      void context.test(history, async (child) => {
        const db = await historyDatabase(child, fixture, "providercontinuation");
        await installProviderCompletedHistory(db);
        // Stock Drizzle appends later canonical migrations while retaining Provider fingerprints.
        await installCanonicalPrefix(db, prefix);
        const receipts = await historyReceipts(db.migrator);
        assert.equal(receipts.length, prefix);
        assert.deepEqual(await runHistoryMigration(db, "production", "--check"), {
          ok: true,
          history,
        });
        assert.deepEqual(await runHistoryMigration(db), { ok: true, history });
        // Approver storage appends to either continuation without rewriting existing receipts.
        await assertCompletedHistory(db, receipts);
      });
    }
  },
);

async function restoreHistoryArchive(context, fixture, archive) {
  const restored = await historyDatabase(context, fixture, "restore", { schemas: false });
  const command = ["exec", "-i", fixture.container, "pg_restore", "-U", "postgres"];
  const restore = execFileAsync(
    "docker",
    [...command, "--exit-on-error", "--single-transaction", "-d", restored.name],
    { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
  );
  restore.child.stdin.end(archive);
  await restore;
  return restored;
}

async function logicalRestoreSnapshot(db) {
  const sequence = await db.migrator.query(
    "SELECT last_value,is_called FROM drizzle.__drizzle_migrations_id_seq",
  );
  return {
    ...(await historySnapshot(db)),
    identities: (await db.app.query("SELECT * FROM occ.iam_identities ORDER BY id")).rows,
    sequence: sequence.rows,
  };
}

test(
  "Logical restore preserves reviewed canonical and Provider migration histories",
  requiresHistoryPostgres,
  async (context) => {
    const fixture = await migrationHistoryFixture();
    for (const lineage of ["canonical", "provider"]) {
      const source = await historyDatabase(context, fixture, "dump");
      if (lineage === "provider") {
        await installProviderCompletedHistory(source);
      }
      const previous = await historyReceipts(source.migrator);
      assert.deepEqual(await runHistoryCommand(source, "production"), {
        ok: true,
        history: lineage === "provider" ? "providerCompleted" : "empty",
      });
      await assertCompletedHistory(source, previous);
      await source.app.query(
        "INSERT INTO occ.iam_identities(id,kind,issuer,subject) VALUES ('restore-human','principal','restore-fixture','human'), ('restore-service','service_principal',NULL,NULL)",
      );
      const native = await logicalRestoreSnapshot(source);
      assert.equal(native.identities.length, 2);

      // Restore a real archive into a distinct database, preserving ownership and grants atomically.
      const { stdout: archive } = await execFileAsync(
        "docker",
        ["exec", fixture.container, "pg_dump", "-U", "postgres", "-Fc", source.name],
        { encoding: "buffer", timeout: 180_000, maxBuffer: 32 * 1024 * 1024 },
      );
      const restored = await restoreHistoryArchive(context, fixture, archive);
      const accepted = await logicalRestoreSnapshot(restored);
      const restoredDigest = catalogDigest(accepted.occ);
      assert.notEqual(restoredDigest, catalogDigest(native.occ));
      assert.deepEqual(accepted.receipts, native.receipts);
      assert.deepEqual(accepted.drizzle, native.drizzle);
      assert.deepEqual(accepted.identities, native.identities);
      assert.deepEqual(accepted.sequence, native.sequence);
      await assertCredentialSchemaPrivileges(restored.app);
      for (const flag of ["--check", undefined]) {
        assert.deepEqual(await runHistoryCommand(restored, "production", flag), {
          ok: true,
          history: "completed",
        });
        assert.deepEqual(await logicalRestoreSnapshot(restored), accepted);
      }

      if (lineage !== "canonical") {
        continue;
      }
      // Start each hostile case from the accepted archive; never undo digest-sensitive DDL.
      const catalogRefusal = /catalog objects or effective grants differ/;
      for (const [query, refusal, expectedRows] of [
        [
          `ALTER TABLE occ.credential_sources DROP CONSTRAINT credential_sources_driver_id_valid,
           ADD CONSTRAINT credential_sources_driver_id_valid
           CHECK (char_length(driver_id) BETWEEN 1 AND 201 AND driver_id = btrim(driver_id))`,
          catalogRefusal,
        ],
        ["REVOKE SELECT ON occ.iam_identities FROM occ_app", catalogRefusal],
        [
          {
            text: "UPDATE drizzle.__drizzle_migrations SET hash=repeat('0',64) WHERE id=$1 AND hash <> repeat('0',64)",
            values: [native.receipts[14].id],
          },
          /applied receipts differ from canonical history/,
          1,
        ],
      ]) {
        const drifted = await restoreHistoryArchive(context, fixture, archive);
        assert.equal(catalogDigest(await migrationCatalog(drifted.migrator)), restoredDigest);
        const change = await drifted.migrator.query(query);
        if (expectedRows !== undefined) {
          assert.equal(change.rowCount, expectedRows);
        }
        const beforeRefusal = await historySnapshot(drifted);
        assert.deepEqual(await runHistoryCommand(drifted, "production", undefined, refusal), {
          ok: false,
          code: "MIGRATION_HISTORY_UNSUPPORTED",
        });
        assert.deepEqual(await historySnapshot(drifted), beforeRefusal);
      }
    }
  },
);

test(
  "Canonical migration refuses ambiguous Provider and Backend data before mutation",
  requiresHistoryPostgres,
  async (context) => {
    const fixture = await migrationHistoryFixture();
    const db = await historyDatabase(context, fixture, "ambiguousprovider");
    await installProviderCompletedHistory(db);
    const seeded = await seedProviderCompletedData(db);
    await db.migrator.query(
      `UPDATE occ.presets
       SET template=jsonb_set(template,'{agent,backendId}','"openai"'::jsonb,true)
       WHERE namespace_id=$1 AND id=$2`,
      [seeded.namespace, seeded.preset],
    );
    const before = (
      await db.migrator.query("SELECT template FROM occ.presets WHERE id=$1", [seeded.preset])
    ).rows;
    await assertHistoryRefused(db);
    assert.deepEqual(
      (await db.migrator.query("SELECT template FROM occ.presets WHERE id=$1", [seeded.preset]))
        .rows,
      before,
    );
  },
);

test(
  "Canonical migration rollback preserves receipts and retries through the other command",
  concurrentHistoryPostgres,
  async (context) => {
    const fixture = await migrationHistoryFixture();
    for (const [prefix, history] of [
      [0, "empty"],
      [24, "prePresetsMain"],
      [25, "main"],
      [27, "repositoryCredentials"],
      [28, "repositoryRetention"],
      [29, "workspaceSetup"],
      [30, "agentProvisioning"],
      [31, "backendCompleted"],
      [32, "backendTerminology"],
      [33, "prePluginApprovers"],
      [34, "preBrokerReceipts"],
      [35, "preAgentDeletion"],
      [36, "preDeploymentProgress"],
      [37, "preHumanAuthentication"],
      [38, "preAgentDeletionTakeover"],
      [39, "preNamespaceDeletionTakeover"],
      [40, "preRepositoryAccess"],
      [41, "preRestrictionReadLogs"],
      [42, "preOAuth"],
      [43, "preCredentialWithdrawals"],
      [44, "preBrokerReceiptFence"],
      [45, "preModelProbeFailureCause"],
      [46, "preProvisioningConfigurationRelease"],
      // Prefix 47 is omitted: 0048 only updates rows, so it has no DDL for the trigger to abort.
      [48, "preCodexPatSources"],
      [49, "preAgentCredentialSources"],
      [50, "preCredentialWithdrawalRequester"],
      [51, "preProvisioningDeploymentOutcome"],
      [52, "preComputePreparationFailureEvidence"],
      [53, "preCredentialSourcePat"],
      [54, "preComputeRevisionAdmission"],
      [55, "preHeldAuthenticationSession"],
      [56, "preCanonicalHarnessAuth"],
      [57, "preSandboxPolicies"],
      [58, "preSandboxPolicyAdministrator"],
      [59, "preCredentialProxy"],
      [62, "prePreparedAttemptSettlement"],
    ]) {
      void context.test(`prefix ${prefix} transaction`, async (child) => {
        const db = await historyDatabase(child, fixture, "rollback", { prefix });
        if (prefix) {
          await seedCanonicalData(db, {
            preset: prefix >= 25,
            computeAdmission: prefix >= 55,
            executionAdmission: prefix >= 62,
          });
        }
        const before = await historySnapshot(db);
        const data = prefix ? await canonicalData(db) : undefined;
        // A database-local event trigger aborts the real final DDL. Drizzle must
        // roll back every preceding SQL statement and receipt in that transaction.
        // 0051's final GRANT runs after it dropped both withdrawal triggers.
        // Abort 0056 after its function was created, before the deferred trigger exists.
        // 0057 replaces the Harness validator, so reject that function replacement.
        // 0058 creates the policy table; 0059 has no DDL, so later prefixes reach custody.
        // Fail the common reduction grant after admission backfill and repository authority.
        // All three pending receipts, schema changes and main-row annotations roll back.
        const rollbackTag = [
          [58, "GRANT"],
          [57, "CREATE TABLE"],
          [56, "CREATE FUNCTION"],
          [55, "CREATE TRIGGER"],
          [54, "ALTER TABLE"],
          [53, "CREATE FUNCTION"],
          [50, "GRANT"],
          [41, "ALTER TABLE"],
          [38, "CREATE FUNCTION"],
          [36, "CREATE INDEX"],
          [31, "ALTER TABLE"],
          [27, "CREATE FUNCTION"],
          [0, "ALTER FUNCTION"],
        ].find(([minimum]) => prefix >= minimum)[1];
        const failAt =
          prefix >= 58
            ? "IF to_regclass('occ.credential_delivery_reductions') IS NULL THEN RETURN; END IF;"
            : "";
        await historyAdmin(
          db,
          db.name,
          `CREATE FUNCTION public.reject_migration_ddl() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN ${failAt} RAISE EXCEPTION 'migration rollback fixture' USING ERRCODE='55000'; END $$;
        CREATE EVENT TRIGGER reject_migration_ddl ON ddl_command_start WHEN TAG IN ('${rollbackTag}') EXECUTE FUNCTION public.reject_migration_ddl()`,
        );
        assert.deepEqual(
          await runHistoryMigration(
            db,
            "development",
            undefined,
            undefined,
            assertInjectedMigrationRollback,
          ),
          { ok: false, code: "MIGRATION_FAILED" },
        );
        assert.deepEqual(await historyReceipts(db.migrator), before.receipts);
        assert.deepEqual(await migrationCatalog(db.migrator), before.occ);
        if (prefix) {
          assert.deepEqual(await canonicalData(db), data);
        } else {
          assert.equal(
            (
              await db.migrator.query(
                "SELECT to_regclass('drizzle.__drizzle_migrations') AS ledger",
              )
            ).rows[0].ledger,
            "drizzle.__drizzle_migrations",
          );
        }
        await historyAdmin(
          db,
          db.name,
          "DROP EVENT TRIGGER reject_migration_ddl; DROP FUNCTION public.reject_migration_ddl()",
        );
        assert.deepEqual(await runHistoryMigration(db, "production"), {
          ok: true,
          history,
        });
        await assertCompletedHistory(db, before.receipts);
      });
    }
  },
);

test(
  "Credential Proxy preview receipts require the exact history before the shared migration",
  requiresHistoryPostgres,
  async (context) => {
    const fixture = await migrationHistoryFixture();
    const db = await historyDatabase(context, fixture, "proxypreview", { prefix: 59 });
    const manifest = JSON.parse(
      await readFile(join(migrationsDirectory, "meta/_canonical-history.json"), "utf8"),
    );
    assert.deepEqual(
      manifest.entries.slice(58, 63).map(({ tag }) => tag),
      [
        "0059_administrator_sandbox_policy_grants",
        "0060_credential_proxy_admission",
        "0061_repository_credential_authority",
        "0062_credential_delivery_custody",
        "0063_prepared_attempt_settlement",
      ],
    );
    await seedCanonicalData(db, { preset: true, computeAdmission: true });
    const before = await historySnapshot(db);
    const data = await canonicalData(db);
    assert.equal(before.receipts.length, 59);
    assert.deepEqual(await runHistoryMigration(db, "production", "--check"), {
      ok: true,
      history: "preCredentialProxy",
    });
    assert.deepEqual(await historySnapshot(db), before);
    assert.deepEqual(await canonicalData(db), data);

    // Exact retired 0060..0069 hashes from 717e737e892cc^'s canonical manifest.
    // Exercise receipt recognition on a valid main catalog, without recreating retired
    // preview DDL or reading Git in CI. Even the complete preview is now unsupported.
    const preview = [
      "41187ea37a83a33ef725c762e5c04af7381139e685795ec5a7233024810a53cf",
      "193a18fe7ad88a7c6418749cdd52be0062267dcbed39d8286d540bd453d43cdf",
      "1d55d6eaac9106490a62a04efa1f8f2b7061d30c757c8c9b6f9f198494bfec96",
      "76f385a160d5662aebef2b439494f7d10e7410351f1c039f2b3f0cea2132fcdc",
      "42835bbf93e5e6b60c28accdec0338ece93ddcb1e4f86dcdd8365a5289ff3988",
      "dd02c82589af7ebd10640e4190cbc27959393baac910af997e836bc825292b82",
      "5fbb2769ec51c46a48c4e6dd9102baba46d71321b39c4176cdd864e1ad178575",
      "4cfa28c47b246638a7e3831b93f1eac25a6e6ffca4e7cbd454e4ade306089b07",
      "76aff98b9d5d220ba089ea32ad0c7b2c34ab3b4c7adb3ea614d7fb31d246ee36",
      "03c19cdc8e4c41b41b47886ad30b54f67ae78c99a86aaffc1d6f954187c8e3e2",
    ];
    const receiptRefusal =
      /applied receipts differ from canonical history; pre-merge preview histories are unsupported/;
    for (const [start, end] of [
      [0, 9],
      [9, 10],
    ]) {
      await db.migrator.query(
        `INSERT INTO drizzle.__drizzle_migrations(hash,created_at)
           SELECT hash, $2::bigint + n - 1 FROM unnest($1::text[]) WITH ORDINALITY AS entry(hash,n)
           ORDER BY n`,
        [preview.slice(start, end), 1787000000060 + start],
      );
      const receipts = await historyReceipts(db.migrator);
      assert.deepEqual(receipts.slice(0, 59), before.receipts);
      assert.deepEqual(
        receipts.slice(59).map(({ hash, created_at }) => [hash, Number(created_at)]),
        preview.slice(0, end).map((hash, index) => [hash, 1787000000060 + index]),
      );
      await assertHistoryRefused(db, receiptRefusal);
      assert.deepEqual(await canonicalData(db), data);
    }

    // Only this fixture's ledger was changed: removing the injected rows restores
    // main exactly. This is not recovery advice for a database with preview DDL.
    assert.equal(
      (
        await db.migrator.query("DELETE FROM drizzle.__drizzle_migrations WHERE id > $1", [
          before.receipts.at(-1).id,
        ])
      ).rowCount,
      preview.length,
    );
    assert.deepEqual(await historySnapshot(db), before);
    assert.deepEqual(await runHistoryMigration(db, "production"), {
      ok: true,
      history: "preCredentialProxy",
    });
    await assertCompletedHistory(db, before.receipts);
    const completed = await historySnapshot(db);
    const upgradedData = await canonicalData(db);
    assert.deepEqual(upgradedData, upgradedCanonicalData(data));
    assert.deepEqual(
      completed.receipts.slice(59).map(({ hash, created_at }) => [hash, Number(created_at)]),
      manifest.entries.slice(59).map(({ sha256, when }) => [sha256, when]),
    );

    // A valid first and last receipt cannot vouch for the interior 0061 receipt.
    // Start each fault from accepted history so rejection cannot pass merely because
    // a retired preview hash was already unsupported.
    const middle = completed.receipts.at(-3);
    for (const [label, sql] of [
      ["changed interior hash", "UPDATE drizzle.__drizzle_migrations SET hash=$2 WHERE id=$1"],
      [
        "changed interior timestamp",
        "UPDATE drizzle.__drizzle_migrations SET created_at=created_at+1 WHERE id=$1",
      ],
      ["deleted interior receipt", "DELETE FROM drizzle.__drizzle_migrations WHERE id=$1"],
    ]) {
      await context.test(label, async () => {
        const parameters =
          label === "changed interior hash" ? [middle.id, preview[1]] : [middle.id];
        assert.equal((await db.migrator.query(sql, parameters)).rowCount, 1);
        const receipts = await historyReceipts(db.migrator);
        assert.deepEqual(receipts[0], completed.receipts[0]);
        assert.deepEqual(receipts.at(-1), completed.receipts.at(-1));
        await assertHistoryRefused(db, receiptRefusal);
        assert.deepEqual(await canonicalData(db), upgradedData);
        await db.migrator.query(
          `INSERT INTO drizzle.__drizzle_migrations(id,hash,created_at) VALUES($1,$2,$3)
             ON CONFLICT(id) DO UPDATE SET hash=excluded.hash,created_at=excluded.created_at`,
          [middle.id, middle.hash, middle.created_at],
        );
        assert.deepEqual(await historySnapshot(db), completed);
        assert.deepEqual(await runHistoryMigration(db, "production", "--check"), {
          ok: true,
          history: "completed",
        });
      });
    }

    // Discarding every new receipt leaves main's exact ledger but the completed
    // catalog. The runner must refuse before replaying any credential migration.
    assert.equal(
      (
        await db.migrator.query("DELETE FROM drizzle.__drizzle_migrations WHERE id > $1", [
          before.receipts.at(-1).id,
        ])
      ).rowCount,
      completed.receipts.length - before.receipts.length,
    );
    assert.deepEqual(await historyReceipts(db.migrator), before.receipts);
    await assertHistoryRefused(
      db,
      /catalog objects or effective grants differ for preCredentialProxy/,
    );
    assert.deepEqual(await canonicalData(db), upgradedData);
    for (const receipt of completed.receipts.slice(59)) {
      await db.migrator.query(
        "INSERT INTO drizzle.__drizzle_migrations(id,hash,created_at) VALUES($1,$2,$3)",
        [receipt.id, receipt.hash, receipt.created_at],
      );
    }
    assert.deepEqual(await historySnapshot(db), completed);
    for (const mode of ["development", "production"]) {
      assert.deepEqual(await runHistoryMigration(db, mode), { ok: true, history: "completed" });
      assert.deepEqual(await historySnapshot(db), completed);
      assert.deepEqual(await canonicalData(db), upgradedData);
    }
  },
);

test(
  "Canonical migration refuses unexplained histories before mutation",
  concurrentHistoryPostgres,
  async (context) => {
    const fixture = await migrationHistoryFixture();
    const manifest = JSON.parse(
      await readFile(join(migrationsDirectory, "meta/_canonical-history.json"), "utf8"),
    );
    const repositorySql = await readFile(
      join(migrationsDirectory, "0025_repository_credentials.sql"),
      "utf8",
    );
    const cases = [
      ["partial", 19, null],
      [
        "mixed-credential-history",
        19,
        `${repositorySql}\nINSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES('${manifest.entries[25].sha256}',1787000000019)`,
      ],
      [
        "wrong-receipt",
        25,
        "UPDATE drizzle.__drizzle_migrations SET hash=repeat('0',64) WHERE id=(SELECT min(id) FROM drizzle.__drizzle_migrations)",
      ],
      [
        "future-receipt",
        25,
        "INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES(repeat('f',64),9999999999999)",
      ],
      ["catalog-object", 25, "CREATE TABLE occ.unexplained(id integer)"],
      [
        "draft-pull-privilege",
        62,
        "GRANT DELETE ON occ.prepared_repository_draft_pulls TO occ_app",
      ],
      ["ledger-grant", 25, "GRANT SELECT ON drizzle.__drizzle_migrations TO occ_app"],
    ];
    for (const [label, prefix, sql] of cases) {
      void context.test(label, async (child) => {
        const db = await historyDatabase(child, fixture, "refuse", { prefix });
        if (sql) {
          await db.migrator.query(sql);
        }
        await assertHistoryRefused(db);
      });
    }
    void context.test("published premerge credential history", async (child) => {
      const db = await historyDatabase(child, fixture, "premerge");
      const journal = JSON.parse(
        await readFile(join(migrationsDirectory, "meta/_journal.json"), "utf8"),
      );
      // Reproduce the actual earlier SQL and receipts: that branch installed
      // credentials at index 24 without main's preset migration. Relocated SQL
      // retains its exact bytes, but this divergent history must not be relabeled.
      const entries = [
        ...journal.entries.slice(0, 24),
        ...journal.entries.slice(25, 28).map((entry) => ({
          ...entry,
          idx: entry.idx - 1,
          when: entry.when - 1,
        })),
      ];
      await installCanonicalPrefix(db, entries.length, { entries });
      await seedCanonicalData(db);
      const before = await canonicalData(db);
      await assertHistoryRefused(db);
      assert.deepEqual(await canonicalData(db), before);
    });
    for (const slot of [30, 31, 34, 35, 36]) {
      void context.test(
        `unpublished authentication at occupied migration slot ${slot}`,
        async (child) => {
          const db = await historyDatabase(child, fixture, "oldauth");
          const journal = JSON.parse(
            await readFile(join(migrationsDirectory, "meta/_journal.json"), "utf8"),
          );
          // Development builds of the authentication branch installed these exact
          // SQL bytes at slots later published for other migrations. Neither
          // migration command may relabel that history or change its data.
          const authentication = journal.entries.find(
            (entry) => entry.tag === "0037_human_authentication",
          );
          const entries = [
            ...journal.entries.slice(0, slot),
            { ...authentication, idx: slot, when: journal.entries[slot].when },
          ];
          await installCanonicalPrefix(db, entries.length, { entries });
          await seedCanonicalData(db, { preset: true });
          const before = await canonicalData(db);
          await assertHistoryRefused(db);
          assert.deepEqual(await canonicalData(db), before);
        },
      );
    }
    void context.test("application credential", async (child) => {
      const db = await historyDatabase(child, fixture, "app");
      const before = await historySnapshot(db);
      const url = new URL(db.migrationUrl);
      url.username = "occ_app";
      url.password = "occ-app-local";
      // The real command refuses an unsupported history with exit code 1.
      assert.deepEqual(await runHistoryCommand({ ...db, migrationUrl: url.toString() }), {
        ok: false,
        code: "MIGRATION_HISTORY_UNSUPPORTED",
      });
      assert.deepEqual(await historySnapshot(db), before);
    });
  },
);

test(
  "Canonical migration refuses empty default ACLs on installed histories",
  concurrentHistoryPostgres,
  async (context) => {
    const fixture = await migrationHistoryFixture();
    for (const history of ["main", "completed"]) {
      for (const [kind, objectType] of [
        ["SCHEMAS", "n"],
        ["TYPES", "T"],
        ["TABLES", "r"],
        ["SEQUENCES", "S"],
      ]) {
        void context.test(`${history} ${kind}`, async (child) => {
          const db = await historyDatabase(child, fixture, "defaults", { prefix: 25 });
          await seedCanonicalData(db, { preset: true });
          if (history === "completed") {
            assert.deepEqual(await runHistoryMigration(db, "production"), {
              ok: true,
              history: "main",
            });
            await assertCompletedHistory(db);
          }
          const data = await canonicalData(db);
          assert.deepEqual(await runHistoryMigration(db, "development", "--check"), {
            ok: true,
            history,
          });
          // An empty global ACL still changes future objects created by the
          // migrator. Both installed histories must reject it before any DDL.
          await db.migrator.query(
            `ALTER DEFAULT PRIVILEGES REVOKE ALL ON ${kind} FROM PUBLIC; ALTER DEFAULT PRIVILEGES REVOKE ALL ON ${kind} FROM occ_migrator`,
          );
          assert.deepEqual(
            (
              await db.migrator.query(
                "SELECT defaclacl::text AS acl FROM pg_catalog.pg_default_acl WHERE defaclrole=current_user::regrole AND defaclnamespace=0 AND defaclobjtype=$1",
                [objectType],
              )
            ).rows,
            [{ acl: "{}" }],
          );
          await assertHistoryRefused(db);
          assert.deepEqual(await canonicalData(db), data);
        });
      }
    }
  },
);

test(
  "Canonical initial schemas admit only finite owner ACL states",
  concurrentHistoryPostgres,
  async (context) => {
    const fixture = await migrationHistoryFixture();
    for (const [label, setup] of [
      ["occ-only", "CREATE SCHEMA occ AUTHORIZATION occ_migrator"],
      ["drizzle-only", "CREATE SCHEMA drizzle AUTHORIZATION occ_migrator"],
      [
        "explicit-owner",
        "CREATE SCHEMA occ AUTHORIZATION occ_migrator; CREATE SCHEMA drizzle AUTHORIZATION occ_migrator; GRANT CREATE,USAGE ON SCHEMA occ,drizzle TO occ_migrator",
      ],
    ]) {
      void context.test(label, async (child) => {
        const db = await historyDatabase(child, fixture, "initial", { schemas: false });
        await db.migrator.query(setup);
        assert.deepEqual(await runHistoryMigration(db, "production"), {
          ok: true,
          history: "empty",
        });
        await assertCompletedHistory(db);
        assert.deepEqual(await runHistoryMigration(db), { ok: true, history: "completed" });
        await assert.rejects(db.app.query("CREATE TABLE occ.unexpected(id integer)"), {
          code: "42501",
        });
        await assert.rejects(db.app.query("SELECT * FROM drizzle.__drizzle_migrations"), {
          code: "42501",
        });
      });
    }
    for (const schema of ["occ", "drizzle"]) {
      for (const [label, setup] of [
        ["app-usage", `GRANT USAGE ON SCHEMA ${schema} TO occ_app`],
        ["public-usage", `GRANT USAGE ON SCHEMA ${schema} TO PUBLIC`],
        ["foreign-usage", `GRANT USAGE ON SCHEMA ${schema} TO postgres`],
        ["public-create", `GRANT CREATE ON SCHEMA ${schema} TO PUBLIC`],
        ["app-create", `GRANT CREATE ON SCHEMA ${schema} TO occ_app`],
        ["owner-create", `REVOKE CREATE ON SCHEMA ${schema} FROM occ_migrator`],
        ["owner-usage", `REVOKE USAGE ON SCHEMA ${schema} FROM occ_migrator`],
        ["owner-grant-option", `GRANT USAGE ON SCHEMA ${schema} TO occ_migrator WITH GRANT OPTION`],
        ["app-grant-option", `GRANT USAGE ON SCHEMA ${schema} TO occ_app WITH GRANT OPTION`],
        [
          "foreign-grantor",
          `GRANT USAGE ON SCHEMA ${schema} TO occ_app WITH GRANT OPTION; SET ROLE occ_app; GRANT USAGE ON SCHEMA ${schema} TO postgres; RESET ROLE`,
        ],
        ["owner-mismatch", `ALTER SCHEMA ${schema} OWNER TO postgres`],
        [
          "defaults",
          `ALTER DEFAULT PRIVILEGES FOR ROLE occ_migrator IN SCHEMA ${schema} GRANT SELECT ON TABLES TO occ_app`,
        ],
        [
          "foreign-defaults",
          `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA ${schema} GRANT SELECT ON TABLES TO occ_app`,
        ],
        ["object", `CREATE TABLE ${schema}.unexpected(id integer)`],
        [
          "other-object",
          `CREATE TEXT SEARCH DICTIONARY ${schema}.unexpected (TEMPLATE=pg_catalog.simple)`,
        ],
      ]) {
        void context.test(`${schema} ${label}`, async (child) => {
          const db = await historyDatabase(child, fixture, "acl");
          await historyAdmin(db, db.name, setup);
          await assertHistoryRefused(db);
        });
      }
    }
    for (const [label, setup] of [
      [
        "global-defaults",
        () => "ALTER DEFAULT PRIVILEGES FOR ROLE occ_migrator GRANT SELECT ON TABLES TO occ_app",
      ],
      [
        "empty-defaults",
        () =>
          "ALTER DEFAULT PRIVILEGES FOR ROLE occ_migrator REVOKE ALL ON FUNCTIONS FROM PUBLIC; ALTER DEFAULT PRIVILEGES FOR ROLE occ_migrator REVOKE ALL ON FUNCTIONS FROM occ_migrator",
      ],
      ["database-create", (name) => `REVOKE CREATE ON DATABASE ${name} FROM occ_migrator`],
      ["application-create", (name) => `GRANT CREATE ON DATABASE ${name} TO occ_app`],
    ]) {
      void context.test(label, async (child) => {
        const db = await historyDatabase(child, fixture, "roles");
        await historyAdmin(db, db.name, setup(db.name));
        await assertHistoryRefused(db);
      });
    }
  },
);

test(
  "Canonical forward migration closes the real application temporary-domain exploit",
  requiresHistoryPostgres,
  async (context) => {
    const fixture = await migrationHistoryFixture();
    const db = await historyDatabase(context, fixture, "definers", { prefix: 25 });
    await historyAdmin(
      db,
      db.name,
      `CREATE TABLE public.definer_privilege_probe(actor pg_catalog.name NOT NULL);
    ALTER TABLE public.definer_privilege_probe OWNER TO occ_migrator;
    REVOKE ALL ON public.definer_privilege_probe FROM PUBLIC,occ_app`,
    );
    await assert.rejects(
      db.app.query("INSERT INTO public.definer_privilege_probe VALUES(current_user)"),
      { code: "42501" },
    );
    await db.app
      .query(`CREATE FUNCTION pg_temp.observe_domain(pg_catalog.text) RETURNS boolean LANGUAGE plpgsql AS $proof$
    BEGIN INSERT INTO public.definer_privilege_probe VALUES(current_user); RETURN true; END $proof$;
    GRANT EXECUTE ON FUNCTION pg_temp.observe_domain(pg_catalog.text) TO occ_migrator;
    CREATE DOMAIN pg_temp.text AS pg_catalog.text CHECK(pg_temp.observe_domain(VALUE))`);
    const count = async () =>
      Number(
        (await db.migrator.query("SELECT count(*) AS n FROM public.definer_privilege_probe"))
          .rows[0].n,
      );
    const suffix = randomUUID();
    const group = `migration-group-${suffix}`;
    const role = `migration-role-${suffix}`;
    await db.app.query("INSERT INTO occ.iam_groups(id,name) VALUES($1,$2)", [group, group]);
    await db.app.query("INSERT INTO occ.iam_roles(id,name,permissions) VALUES($1,$2,'[]')", [
      role,
      role,
    ]);
    async function exercise(phase, vulnerable) {
      const principal = `migration-principal-${phase}-${suffix}`;
      await db.app.query(
        "INSERT INTO occ.iam_identities(id,kind,issuer,subject) VALUES($1,'principal','migration-fixture',$1)",
        [principal],
      );
      for (const [label, operation] of [
        [
          "finalizer",
          () =>
            db.app
              .query(
                "SELECT occ.finalize_agent_deletion('absent-namespace','absent-agent','absent-work',$1) AS deleted",
                [randomUUID()],
              )
              .then((result) => assert.equal(result.rows[0].deleted, false)),
        ],
        [
          "membership",
          () =>
            db.app.query(
              "INSERT INTO occ.iam_group_memberships(group_id,principal_id) VALUES($1,$2)",
              [group, principal],
            ),
        ],
        [
          "access-binding",
          () =>
            db.app.query(
              "INSERT INTO occ.iam_access_bindings(id,identity_subject_id,role_id) VALUES($1,$2,$3)",
              [`binding-${phase}-${suffix}`, principal, role],
            ),
        ],
      ]) {
        const before = await count();
        await operation();
        const after = await count();
        if (vulnerable) {
          assert.ok(after > before, `Published ${label} must reproduce the privilege crossing.`);
        } else {
          assert.equal(after, before, `Hardened ${label} must not execute the temporary domain.`);
        }
      }
    }
    await exercise("before", true);
    assert.deepEqual(
      (await db.migrator.query("SELECT DISTINCT actor FROM public.definer_privilege_probe")).rows,
      [{ actor: "occ_migrator" }],
    );
    const before = await canonicalData(db);
    const receipts = await historyReceipts(db.migrator);
    const attempts = await count();
    assert.deepEqual(await runHistoryMigration(db, "production"), { ok: true, history: "main" });
    await assertCompletedHistory(db, receipts);
    assert.deepEqual(await canonicalData(db), before);
    // Keep the same hostile application session: ALTER FUNCTION must invalidate
    // the already-compiled vulnerable bodies while ordinary IAM inserts still work.
    await exercise("after", false);
    assert.equal(await count(), attempts);
    await db.app.query(
      "INSERT INTO occ.iam_restrictions(id,action,resource_kind,effect) VALUES($1,'read','agent','deny')",
      [`restriction-${suffix}`],
    );
    assert.equal(await count(), attempts);
  },
);

test(
  "Preset migration upgrades only unchanged built-in administrators and preserves custom policy",
  requiresOwnedPostgres,
  async (context) => {
    const fixture = await ownedPostgres();
    const database = `openclaw_presets_upgrade_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const databaseCommand = (sql, target = "postgres") =>
      runCommand(fixture, "docker", [
        ...fixture.composeArgs,
        "psql",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "postgres",
        "-d",
        target,
        "-c",
        sql,
      ]);
    let pool;
    context.after(async () => {
      try {
        await pool?.end();
      } finally {
        await databaseCommand(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      }
    });
    await databaseCommand(`CREATE DATABASE ${database}`);
    await databaseCommand(
      `GRANT CREATE ON DATABASE ${database} TO occ_migrator; CREATE SCHEMA occ AUTHORIZATION occ_migrator; CREATE SCHEMA drizzle AUTHORIZATION occ_migrator; REVOKE CREATE ON SCHEMA public FROM PUBLIC;`,
      database,
    );
    const migrationUrl = new URL(fixture.migrationUrl);
    migrationUrl.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: migrationUrl.toString(), max: 1 });
    const priorMigrations = (await readdir(migrationsDirectory))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < "0024_agent_presets.sql")
      .sort();
    assert.equal(priorMigrations.at(-1), "0023_runtime_failure_timestamp_validation.sql");
    for (const name of priorMigrations) {
      await pool.query(await readFile(join(migrationsDirectory, name), "utf8"));
    }

    // Freeze the historical policy: future seed-policy edits must not alter this upgrade fixture.
    const legacyPermissions = [
      ["installation", ["administer", "read"]],
      ["namespace", ["create", "read", "delete"]],
      ["configuration", ["create", "read", "update", "delete"]],
      ["service_account", ["create", "read", "update", "delete"]],
      ["secret", ["create", "read", "update", "delete", "operate"]],
      ["agent", ["create", "read", "update", "delete", "deploy", "operate", "administer"]],
      ["agent_revision", ["read"]],
    ].flatMap(([resourceKind, actions]) => actions.map((action) => ({ action, resourceKind })));
    const presetPermissions = ["create", "read", "update", "delete"].map((action) => ({
      action,
      resourceKind: "preset",
    }));
    const installationId = `ins_${randomUUID()}`;
    const namespaceId = `ns_${randomUUID()}`;
    await pool.query("INSERT INTO occ.installation VALUES ($1, 'Upgrade', now())", [
      installationId,
    ]);
    await pool.query(
      "INSERT INTO occ.namespaces (id, name, status, created_at) VALUES ($1, 'Upgrade', 'ready', now())",
      [namespaceId],
    );
    const role = (overrides = {}) => ({
      id: `role_admin_${randomUUID()}`,
      namespace_id: null,
      name: "Installation administrator",
      permissions: legacyPermissions,
      ...overrides,
    });
    const stock = role();
    const reordered = role({ permissions: [...legacyPermissions].reverse() });
    const reduced = role({ permissions: legacyPermissions.slice(1) });
    const roles = [
      stock,
      reordered,
      reduced,
      role({
        permissions: [...legacyPermissions, { action: "update", resourceKind: "namespace" }],
      }),
      role({ name: "Custom administrator" }),
      role({ id: `role_${randomUUID()}` }),
      role({ namespace_id: namespaceId }),
      role({ permissions: [...legacyPermissions, presetPermissions[1]] }),
    ];
    for (const entry of roles) {
      await pool.query("INSERT INTO occ.iam_roles VALUES ($1, $2, $3, $4::jsonb)", [
        entry.id,
        entry.namespace_id,
        entry.name,
        JSON.stringify(entry.permissions),
      ]);
    }
    const principals = [];
    for (const entry of [stock, reduced]) {
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
    const [{ NativeIAMDriver }, { PostgresPlatformState }] = await Promise.all([
      import("../../packages/iam/src/index.ts"),
      import("../../packages/occ/src/state/postgres-state.ts"),
    ]);
    const iam = new NativeIAMDriver(new PostgresPlatformState(pool));
    const presetId = `pre_${randomUUID()}`;
    const authorize = (principalId, action, kind = "preset") =>
      iam.authorize({
        principalId,
        action,
        resource: {
          kind,
          id:
            kind === "installation"
              ? installationId
              : kind === "preset" && action !== "create"
                ? presetId
                : namespaceId,
          ...(kind === "installation" ? {} : { namespaceId }),
        },
      });
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
      const actual = (await pool.query("SELECT * FROM occ.iam_roles WHERE id = $1", [entry.id]))
        .rows[0];
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
  },
);

test(
  "Credential source grant migration upgrades only unchanged built-in administrators",
  requiresOwnedPostgres,
  async (context) => {
    const fixture = await ownedPostgres();
    const database = `openclaw_cs_grants_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const databaseCommand = (sql, target = "postgres") =>
      runCommand(fixture, "docker", [
        ...fixture.composeArgs,
        "psql",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "postgres",
        "-d",
        target,
        "-c",
        sql,
      ]);
    let pool;
    context.after(async () => {
      try {
        await pool?.end();
      } finally {
        await databaseCommand(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      }
    });
    await databaseCommand(`CREATE DATABASE ${database}`);
    await databaseCommand(
      `GRANT CREATE ON DATABASE ${database} TO occ_migrator; CREATE SCHEMA occ AUTHORIZATION occ_migrator; CREATE SCHEMA drizzle AUTHORIZATION occ_migrator; REVOKE CREATE ON SCHEMA public FROM PUBLIC;`,
      database,
    );
    const migrationUrl = new URL(fixture.migrationUrl);
    migrationUrl.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: migrationUrl.toString(), max: 1 });
    const migration = "0048_administrator_credential_source_grants.sql";
    const priorMigrations = (await readdir(migrationsDirectory))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < migration)
      .sort();
    assert.equal(priorMigrations.at(-1), "0047_provisioning_configuration_release.sql");
    for (const name of priorMigrations) {
      await pool.query(await readFile(join(migrationsDirectory, name), "utf8"));
    }

    // Freeze the historical seeds: future seed edits must not alter this upgrade fixture.
    const permissions = (entries) =>
      entries.flatMap(([resourceKind, actions]) =>
        actions.map((action) => ({ action, resourceKind })),
      );
    const presetSeed = permissions([
      ["installation", ["administer", "read"]],
      ["namespace", ["create", "read", "delete"]],
      ["configuration", ["create", "read", "update", "delete"]],
      ["service_account", ["create", "read", "update", "delete"]],
      ["secret", ["create", "read", "update", "delete"]],
      ["preset", ["create", "read", "update", "delete"]],
      ["secret", ["operate"]],
      ["agent", ["create", "read", "update", "delete", "deploy", "operate", "administer"]],
      ["agent_revision", ["read"]],
    ]);
    // The 2026-09-28 release seed: credential sources without update.
    const releaseSeed = [
      ...presetSeed.slice(0, -8),
      ...permissions([["credential_source", ["create", "read", "delete", "operate"]]]),
      ...presetSeed.slice(-8),
    ];
    const currentGrants = permissions([
      ["credential_source", ["create", "read", "update", "delete", "operate"]],
    ]);
    const installationId = `ins_${randomUUID()}`;
    const namespaceId = `ns_${randomUUID()}`;
    await pool.query("INSERT INTO occ.installation VALUES ($1, 'Upgrade', now())", [
      installationId,
    ]);
    await pool.query(
      "INSERT INTO occ.namespaces (id, name, status, created_at) VALUES ($1, 'Upgrade', 'ready', now())",
      [namespaceId],
    );
    const role = (overrides = {}) => ({
      id: `role_admin_${randomUUID()}`,
      namespace_id: null,
      name: "Installation administrator",
      permissions: releaseSeed,
      ...overrides,
    });
    const release = role();
    const reordered = role({ permissions: [...releaseSeed].reverse() });
    const preCredentialSources = role({ permissions: presetSeed });
    const reduced = role({ permissions: releaseSeed.slice(1) });
    const current = role({ permissions: [...releaseSeed, currentGrants[2]] });
    const roles = [
      release,
      reordered,
      preCredentialSources,
      reduced,
      current,
      role({ permissions: [...releaseSeed, { action: "update", resourceKind: "namespace" }] }),
      role({ name: "Custom administrator" }),
      role({ id: `role_${randomUUID()}` }),
      role({ namespace_id: namespaceId }),
    ];
    for (const entry of roles) {
      await pool.query("INSERT INTO occ.iam_roles VALUES ($1, $2, $3, $4::jsonb)", [
        entry.id,
        entry.namespace_id,
        entry.name,
        JSON.stringify(entry.permissions),
      ]);
    }
    const principals = [];
    for (const entry of [release, preCredentialSources, reduced]) {
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
    const [{ NativeIAMDriver }, { PostgresPlatformState }] = await Promise.all([
      import("../../packages/iam/src/index.ts"),
      import("../../packages/occ/src/state/postgres-state.ts"),
    ]);
    const iam = new NativeIAMDriver(new PostgresPlatformState(pool));
    const sourceId = `cs_${randomUUID()}`;
    const authorize = async (principalId, action) =>
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
    const upgraded = new Map([
      [release.id, [currentGrants[2]]],
      [reordered.id, [currentGrants[2]]],
      [preCredentialSources.id, currentGrants],
    ]);
    const expected = (entry) => ({
      ...entry,
      permissions: [...entry.permissions, ...(upgraded.get(entry.id) ?? [])],
    });
    for (const entry of roles) {
      const actual = (await pool.query("SELECT * FROM occ.iam_roles WHERE id = $1", [entry.id]))
        .rows[0];
      assert.deepEqual(actual, expected(entry));
    }
    // A repeated run changes nothing: every upgraded Role now matches the current seed.
    await pool.query(sql);
    for (const entry of roles) {
      const actual = (await pool.query("SELECT * FROM occ.iam_roles WHERE id = $1", [entry.id]))
        .rows[0];
      assert.deepEqual(actual, expected(entry));
    }
    for (const { action } of currentGrants) {
      assert.equal(await authorize(principals[0], action), true);
      assert.equal(await authorize(principals[1], action), true);
    }
    assert.equal(await authorize(principals[2], "update"), false);
    assert.equal(await authorize(principals[2], "read"), true);
  },
);
