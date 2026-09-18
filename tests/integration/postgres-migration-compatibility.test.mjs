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
