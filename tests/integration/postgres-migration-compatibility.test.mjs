import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const migrationsDirectory = join(repositoryRoot, "migrations");
const execFileAsync = promisify(execFile);
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
    composeArgs: ["compose", "-f", server.composeFile, "-p", server.name, "exec", "-T", "postgres"],
  };
}

async function runCommand(fixture, command, args) {
  const pending = execFileAsync(command, args, {
    cwd: repositoryRoot,
    env: {
      ...process.env,
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
      `import config from ${JSON.stringify(join(repositoryRoot, "drizzle.config.ts"))};\nexport default { ...config, out: ${JSON.stringify(outputDirectory)} };\n`,
      { mode: 0o600, flag: "wx" },
    );
    const generateArgs = ["pnpm", "db:generate", "--config", configPath, "--name", "compatibility"];
    await runCommand(fixture, "corepack", generateArgs);

    const sqlFiles = (await readdir(outputDirectory)).filter((name) => name.endsWith(".sql"));
    assert.equal(sqlFiles.length, 1, "Generation must produce one initial SQL migration.");
    assert.ok((await readFile(join(outputDirectory, sqlFiles[0]), "utf8")).trim().length > 0);
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
           (id, namespace_id, name, configuration_id, provider_id, execution_mode,
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
           (id, namespace_id, agent_id, revision_number, admitted_spec, provider_id, admitted_at)
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
             (id, namespace_id, name, configuration_id, provider_id, execution_mode,
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
             (id, namespace_id, agent_id, revision_number, admitted_spec, provider_id, admitted_at)
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

    // Native preparation performed the first migration; rerun that exact Kit entry point.
    await runCommand(fixture, "corepack", ["pnpm", "db:migrate"]);
    assert.deepEqual((await pool.query(journalQuery)).rows, beforeJournal);
    assert.equal(await runCommand(fixture, "docker", dumpArgs), beforeSchema);
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
