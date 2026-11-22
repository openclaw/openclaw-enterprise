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
import {
  assertAdministratorGrantUpgrade,
  assertDrizzleJournalPreserved,
  assertEmptyInstallationHistory,
  assertGuardedInstallationUpgrade,
  assertLegacyAgentMigrationRefusal,
  assertLegacyControllerWorkBackfill,
  assertNativeRestartUpgrade,
  assertPresetPolicyUpgrade,
  assertRetainedRevisionResponses,
  prepareRetainedHarnessRevisions,
} from "./postgres-historical-agent-migration-cases.ts";
import {
  registerPostgresMigrationCredentialLineageCases,
  registerPostgresMigrationCredentialLineageRefusalCase,
} from "./postgres-migration-credential-lineage-cases.ts";
import { registerPostgresMigrationSchemaAdmissionCases } from "./postgres-migration-schema-admission-cases.ts";
import { registerPostgresMigrationTransactionCommandCases } from "./postgres-migration-transaction-command-cases.ts";
import pg from "pg";
import {
  assertCredentialSchemaPrivileges,
  assertInjectedMigrationRollback,
  retainGatewaySourcesAcrossProxyAdmission,
} from "../helpers/credential-source-owner-upgrade.ts";
import { request, startController } from "../helpers/postgres-platform-state.ts";
import {
  catalogDigest,
  initialSchemaState,
  migrationCatalog,
} from "../../scripts/migration-catalog.ts";
import { migrateWithHistory } from "../../scripts/migration-history.mjs";
import { createPostgresPool } from "../../packages/occ/src/state/postgres-pool.ts";
import { PostgresWorkQueue } from "../../packages/occ/src/index.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import {
  assertReleasedControllerCompatibility,
  assertReleasedControllerIAMCompatibility,
} from "../helpers/released-controller-compatibility.mjs";

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
const controllerImages = {
  released: {
    reference: process.env.OCC_TEST_RELEASED_CONTROLLER_IMAGE,
    revision: process.env.OCC_TEST_RELEASED_CONTROLLER_REVISION,
  },
  candidate: {
    reference: process.env.OCC_TEST_CANDIDATE_CONTROLLER_IMAGE,
    revision: process.env.OCC_TEST_CANDIDATE_CONTROLLER_REVISION,
  },
};
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
        ["agent_revisions", "agent_revisions_first_deployment_digest"],
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
          `SELECT pg_get_constraintdef(oid) AS definition, convalidated, conrelid=$3::regclass AS stored
             FROM pg_constraint
            WHERE conname = $1 AND conrelid IN ($2::regclass, $3::regclass)`,
          [constraint, `pg_temp.${table}`, `occ.${table}`],
        );
        assert.equal(checks.rowCount, 2, `Both tables must have ${constraint}`);
        const generated = checks.rows.find((row) => !row.stored);
        const stored = checks.rows.find((row) => row.stored);
        // Existing snapshots remain available for cleanup; new writes need resolved settings.
        const retainedUnsupportedSnapshots = constraint === "agent_revisions_admitted_snapshot";
        assert.equal(stored.convalidated, !retainedUnsupportedSnapshots);
        assert.equal(
          stored.definition,
          generated.definition + (retainedUnsupportedSnapshots ? " NOT VALID" : ""),
        );
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

const historicalMigrationDependencies = { ownedPostgres, runCommand, migrationsDirectory };

for (const legacyState of ["active_runtime", "harness_revision", "harness_account"]) {
  test(
    `Migration rejects legacy ${legacyState} state without changing persisted rows`,
    requiresOwnedPostgres,
    (context) =>
      assertLegacyAgentMigrationRefusal(context, historicalMigrationDependencies, legacyState),
  );
}

test(
  "Migration backfills legacy terminal controller work from durable audit evidence",
  requiresOwnedPostgres,
  (context) => assertLegacyControllerWorkBackfill(context, historicalMigrationDependencies),
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
    await assertDrizzleJournalPreserved(context, pool, fixture, {
      migrationsDirectory,
      runCommand,
      runMigrationCheck,
      logEvents,
      temporaryDirectory,
    });
  },
);

async function runMigrationCheck(fixture, configPath) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["scripts/migrate-production.ts", "--check"],
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
/** @returns {Promise<HistoryFixture>} */
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
/**
 * @param {Pick<HistoryFixture, "admin" | "adminUrl">} fixture
 * @param {string} database
 * @param {string} sql
 */
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

/**
 * @typedef {object} HistoryFixture
 * @property {string} migrationUrl
 * @property {string} container
 * @property {number} port
 * @property {string} databasePrefix
 * @property {string} adminUrl
 * @property {pg.Pool} admin
 */

/**
 * @param {import("node:test").TestContext} context
 * @param {HistoryFixture} fixture
 * @param {string} label
 * @param {{ schemas?: boolean, prefix?: number }} [options]
 */
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
  const db = {
    ...fixture,
    name,
    migrationUrl: migration.toString(),
    applicationUrl: application.toString(),
    migrator,
    app,
  };
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

// Each new migration needs a named history for the count before it, and every
// hand-kept prefix table below must reach that count: a missing row means no case
// upgrades a database at that count. From `contiguousFrom`, no count may be skipped.
async function coveringNewestPrefix(table, contiguousFrom, rows) {
  const { entries } = JSON.parse(
    await readFile(join(migrationsDirectory, "meta/_canonical-history.json"), "utf8"),
  );
  const listed = new Set(rows.map(([prefix]) => prefix));
  for (let count = contiguousFrom; count < entries.length; count += 1) {
    assert.ok(
      listed.has(count),
      `${table} table has no row for history prefix ${count} (${entries.length} migrations)`,
    );
  }
  return rows;
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
// every prepared CI database is migrated that way, and Helm runs the migration entry directly
// in the selected controller image. Each refusal code and both tasks keep a command case here.
const migrationScripts = readFile(join(repositoryRoot, "package.json"), "utf8").then(
  (text) => JSON.parse(text).scripts,
);

// flag is a migration command option or undefined; refusal,
// when set, must match the command's MIGRATION_HISTORY_UNSUPPORTED message.
/**
 * @param {{ migrationUrl: string }} db
 * @param {import("./postgres-migration-transaction-command-cases.ts").MigrationCommandMode} [mode]
 * @param {import("./postgres-migration-transaction-command-cases.ts").MigrationCommandFlag | "--check-for-installation" | "--apply-for-installation" | "--require-current-for-installation"} [flag]
 * @param {RegExp} [refusal]
 * @param {string} [installationId]
 * @returns {Promise<import("./postgres-migration-transaction-command-cases.ts").MigrationCommandResult>}
 */
async function runHistoryCommand(db, mode = "development", flag, refusal, installationId) {
  const script = (await migrationScripts)[
    mode === "production" ? "db:migrate:production" : "db:migrate"
  ];
  assert.equal(typeof script, "string");
  const args = [
    "-c",
    `${script} "$@"`,
    "sh",
    ...(flag === undefined ? [] : [flag]),
    ...(installationId === undefined ? [] : [installationId]),
  ];
  const checkOnly =
    flag === "--check" ||
    flag === "--check-for-installation" ||
    flag === "--require-current" ||
    flag === "--require-current-for-installation";
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
    const checkedEvent =
      flag === "--check-for-installation"
        ? "migration.checked-for-installation"
        : "migration.checked";
    const event = checkOnly ? checkedEvent : "migration.completed";
    const result = stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map(/** @returns {unknown} */ (line) => JSON.parse(line))
      .find(
        (value) =>
          value !== null && typeof value === "object" && "event" in value && value.event === event,
      );
    assert.ok(
      result !== null &&
        typeof result === "object" &&
        "history" in result &&
        typeof result.history === "string",
      "The supported migration command must report its successful outcome.",
    );
    return { ok: true, history: result.history };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    const stdout = error instanceof Error && "stdout" in error ? error.stdout : undefined;
    const stderr = error instanceof Error && "stderr" in error ? error.stderr : undefined;
    const output = `${stdout ?? ""}\n${stderr ?? ""}`;
    if (code === 1 && output.includes('"code":"MIGRATION_HISTORY_UNSUPPORTED"')) {
      if (refusal !== undefined) {
        assert.match(output, refusal);
      }
      return { ok: false, code: "MIGRATION_HISTORY_UNSUPPORTED" };
    }
    if (code === 1 && output.includes('"code":"MIGRATION_HISTORY_PENDING"')) {
      return { ok: false, code: "MIGRATION_HISTORY_PENDING" };
    }
    if (code === 1 && output.includes('"code":"MIGRATION_HISTORY_NOT_EMPTY"')) {
      assert.ok(
        output.includes("use --check to inspect migration history without applying changes"),
      );
      return { ok: false, code: "MIGRATION_HISTORY_NOT_EMPTY" };
    }
    if (code === 1 && output.includes('"code":"MIGRATION_FAILED"')) {
      return { ok: false, code: "MIGRATION_FAILED" };
    }
    // Subprocess errors can retain connection credentials in stdout or stderr.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`Migration subprocess failed unexpectedly (code=${code ?? "none"}).`);
  }
}

// The history cases migrate a few hundred databases. Run them in this process: the same
// `migrateWithHistory` call on the same pool as `scripts/migrate-production.ts`, with that
// command's outcome codes. The mode only selects the script (and its NODE_ENV logging),
// never the migration; `runHistoryCommand` covers the process contract. flag and refusal
// are as for runHistoryCommand: the command prints this same error.message on refusal.
/**
 * @param {{ migrationUrl: string }} db
 * @param {"development" | "production"} [mode]
 * @param {"--check" | "--expect-empty"} [flag]
 * @param {RegExp} [refusal]
 * @param {(error: unknown) => void} [assertFailure]
 * @returns {Promise<
 *   { ok: true, history: Awaited<ReturnType<typeof migrateWithHistory>> } |
 *   { ok: false, code: "MIGRATION_HISTORY_UNSUPPORTED" | "MIGRATION_HISTORY_NOT_EMPTY" | "MIGRATION_FAILED" }
 * >}
 */
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

/** @param {pg.Client} client */
async function historyReceipts(client) {
  /** @type {import("pg").QueryResult<{ present: boolean }>} */
  const ledger = await client.query(
    `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='drizzle' AND c.relname='__drizzle_migrations') AS present`,
  );
  const [state] = ledger.rows;
  assert.ok(state, "Expected the PostgreSQL ledger presence result.");
  if (!state.present) {
    return [];
  }
  /** @type {import("pg").QueryResult<import("./postgres-migration-transaction-command-cases.ts").MigrationReceipt>} */
  const receipts = await client.query(
    "SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id",
  );
  return receipts.rows;
}

/** @param {{ migrator: pg.Client }} db */
async function historySnapshot(db) {
  const receipts = await historyReceipts(db.migrator);
  const occ = await migrationCatalog(db.migrator);
  const drizzle = await migrationCatalog(db.migrator, "drizzle");
  /** @type {import("pg").QueryResult<import("./postgres-migration-transaction-command-cases.ts").MigrationDefaultAcl>} */
  const defaultAcls = await db.migrator.query(
    "SELECT oid,defaclrole,defaclnamespace,defaclobjtype,defaclacl::text AS acl FROM pg_catalog.pg_default_acl ORDER BY oid",
  );
  return {
    receipts,
    occ,
    drizzle,
    defaultAcls: defaultAcls.rows,
    initialOcc: await initialSchemaState(db.migrator, "occ"),
    initialDrizzle: await initialSchemaState(db.migrator, "drizzle"),
  };
}

/**
 * @param {Pick<Awaited<ReturnType<typeof historyDatabase>>, "migrationUrl" | "migrator">} db
 * @param {RegExp} [refusal]
 */
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

/**
 * @param {Pick<Awaited<ReturnType<typeof historyDatabase>>, "app" | "migrator">} db
 * @param {readonly { hash: string, created_at: string | number | null }[]} [previous]
 */
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
      ["occ.check_connection_registration_scope()", false, "search_path=pg_catalog, pg_temp"],
      // The app records a standing execution; only the Agent lifecycle trigger can close it.
      ["occ.close_repository_standing_execution()", false],
      ["occ.create_agent_sandbox_policy()", false, "search_path=pg_catalog, occ"],
      ["occ.finalize_agent_deletion(text,text,text,uuid)", true],
      ["occ.hold_account_administration_policy(text)", true],
      ["occ.hold_agent_audit_policy(text)", true],
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

async function seedCanonicalAgent(
  db,
  namespace,
  { computeAdmission, executionAdmission, harnessSettings, restartContinuation = false },
) {
  const configuration = `cfg_${randomUUID()}`;
  const agent = `agt_${randomUUID()}`;
  const revision = `rev_${randomUUID()}`;
  const servicePrincipal = `service-agent-${agent}`;
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
          ...(restartContinuation
            ? { restart_continuation: { generation: randomUUID(), domain: "retained-workspace" } }
            : {}),
          harness: {
            id: "codex",
            version: "1.0.0",
            mode: "dedicated",
            ...(harnessSettings ? { overrides: {}, configuration: {} } : {}),
          },
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
    if (restartContinuation) {
      await db.app.query(
        "UPDATE occ.agents SET desired_runtime_state='running', restart_generation=$2, restart_domain=$3 WHERE id=$1",
        [agent, randomUUID(), "retained-workspace"],
      );
    }
    await db.app.query("COMMIT");
  } catch (error) {
    await db.app.query("ROLLBACK");
    throw error;
  }
  return { agent, revision };
}

/**
 * @param {Pick<Awaited<ReturnType<typeof historyDatabase>>, "app">} db
 * @param {{ preset?: boolean, computeAdmission?: boolean, executionAdmission?: boolean, harnessSettings?: boolean }} [options]
 */
async function seedCanonicalData(
  db,
  {
    preset = false,
    computeAdmission = false,
    executionAdmission = false,
    harnessSettings = false,
  } = {},
) {
  const installation = `ins_${randomUUID()}`;
  const namespace = `ns_${randomUUID()}`;
  await db.app.query(
    "INSERT INTO occ.installation(id,name,created_at) VALUES($1,'Migration fixture',now())",
    [installation],
  );
  await seedCanonicalAgent(db, namespace, {
    computeAdmission,
    executionAdmission,
    harnessSettings,
  });
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

async function assertSignInResultStorage(app) {
  // An upgraded Better Auth session can own a result only after State binds it.
  const insert = `INSERT INTO occ.human_authentication_results
    (installation_id,attempt_id,session_id,provider_id,expires_at)
    SELECT i.id,$1,s.id,'oidc',clock_timestamp() + $2::interval
    FROM occ.installation i CROSS JOIN occ.session s`;
  const expired = "e".repeat(43);
  const live = "v".repeat(43);
  await assert.rejects(app.query(insert, [live, "1 minute"]), { code: "23503" });
  await app.query(
    `INSERT INTO occ.iam_identities(id,kind,issuer,subject)
     SELECT 'migration-human','principal','migration-fixture',id FROM occ."user"`,
  );
  await app.query(
    `INSERT INTO occ.human_authentication_accounts(user_id,installation_id,principal_id)
     SELECT u.id,i.id,'migration-human' FROM occ."user" u CROSS JOIN occ.installation i`,
  );
  await app.query(
    `INSERT INTO occ.human_authentication_sessions(session_id,user_id,method_id,version,method_version)
     SELECT s.id,s.user_id,a.id,1,a.authentication_version FROM occ.session s
     JOIN occ.account a ON a.user_id=s.user_id AND a.provider_id='oidc'`,
  );

  await app.query(insert, [expired, "-1 minute"]);
  await app.query(insert, [live, "1 minute"]);
  await assert.rejects(app.query(insert, [live, "1 minute"]), { code: "23505" });
  await assert.rejects(app.query("UPDATE occ.human_authentication_results SET expires_at=now()"), {
    code: "42501",
  });
  assert.deepEqual(
    (
      await app.query(
        `DELETE FROM occ.human_authentication_results
         WHERE installation_id=(SELECT id FROM occ.installation) AND expires_at <= clock_timestamp()
         RETURNING attempt_id`,
      )
    ).rows,
    [{ attempt_id: expired }],
  );
  await app.query("DELETE FROM occ.session");
  assert.equal(
    (await app.query("SELECT attempt_id FROM occ.human_authentication_results")).rowCount,
    0,
  );
}

const legacyExecutionAdmission = { version: 2, mode: "unprotected" };

// A revision admitted before 0060 carries no execution admission. The upgrade records
// the unprotected decision it was admitted under. Existing revisions have no first-deployment
// recovery binding; every other stored field stays identical.
function upgradedCanonicalData(data) {
  return {
    ...data,
    agents: data.agents.map(({ value }) => {
      const current = { ...value, predecessor_replacement: value.predecessor_replacement ?? null };
      delete current.restart_generation;
      delete current.restart_domain;
      return { value: current };
    }),
    agent_revisions: data.agent_revisions.map(({ value }) => ({
      value: {
        ...value,
        first_deployment_digest: null,
        admitted_spec: Object.hasOwn(value.admitted_spec, "execution_admission")
          ? value.admitted_spec
          : {
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
  // A new writer supplies the current Harness shape while the old row stays unchanged.
  const currentSpec = `jsonb_set(admitted_spec, '{harness}', (admitted_spec->'harness') || '{"overrides":{},"configuration":{}}'::jsonb)`;
  const insertRevision = (rewrite, ...parameters) =>
    db.app.query(
      `INSERT INTO occ.agent_revisions(id,namespace_id,agent_id,revision_number,admitted_spec,backend_id,admitted_at)
       SELECT $1, namespace_id, agent_id, 2, ${rewrite}, NULL, now() FROM occ.agent_revisions WHERE id=$2`,
      [revisionId, id, ...parameters],
    );
  const invalidAdmission = (error) =>
    error.code === "23514" && error.constraint === "agent_revisions_execution_admission";
  for (const rewrite of [
    `${currentSpec} - 'execution_admission'`,
    `${currentSpec} || '{"execution_admission":{"version":2,"mode":"protected"}}'::jsonb`,
  ]) {
    await assert.rejects(insertRevision(rewrite), invalidAdmission);
  }

  // Draft-only protected v2 must fail even with a scoped plan and matching reader marker.
  const plan = { execution: { namespaceId, agentId, revisionId }, routes: [] };
  const insertProtectedV2 = (egressPlan) =>
    insertRevision(
      `jsonb_set(${currentSpec}, '{harness_auth,protectedExecutionVersion}', '2'::jsonb)
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

/**
 * @param {Pick<Awaited<ReturnType<typeof historyDatabase>>, "app">} db
 * @returns {Promise<unknown>}
 */
async function canonicalData(db) {
  const result = { presets: [] };
  const migrationOwnedColumns = {
    account: ["authentication_version", "identity_only"],
    agents: [
      "repository_bindings",
      "repository_access",
      "harness_auth_credential_source_id",
      "plugin_approvers",
      "plugin_driver",
      "credential_sources",
      "sandbox_policy_editing",
      "gateway_managed_mode",
    ],
    agent_revisions: ["gateway_managed_mode"],
    controller_work: ["work_kind", "audit_attempt_id"],
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
  "Separate migration Jobs guard the expected Installation before applying or verifying SQL",
  requiresHistoryPostgres,
  async (context) => {
    const fixture = await migrationHistoryFixture();
    const expected = `ins_${randomUUID()}`;
    const different = `ins_${randomUUID()}`;
    const empty = await historyDatabase(context, fixture, "guarded_empty");
    await assertEmptyInstallationHistory(empty, expected, { runHistoryCommand, historySnapshot });

    // Build the published predecessor with its original SQL and receipts.
    const pending = await historyDatabase(context, fixture, "guarded_pending", { prefix: 81 });
    await pending.app.query(
      "INSERT INTO occ.installation(id,name,created_at) VALUES($1,'Migration fixture',now())",
      [expected],
    );
    await pending.app.query(
      "INSERT INTO occ.namespaces(id,name,status,created_at) VALUES($1,'Migration fixture','ready',now())",
      [`ns_${randomUUID()}`],
    );
    await assertGuardedInstallationUpgrade(pending, expected, different, {
      runHistoryCommand,
      historySnapshot,
      canonicalData,
      assertCompletedHistory,
    });
  },
);

test(
  "Native restart migration removes recovery metadata and preserves immutable admitted revisions",
  requiresHistoryPostgres,
  async (context) => {
    const fixture = await migrationHistoryFixture();
    for (const prefix of [0, 81, 82]) {
      await context.test(`fresh or populated prefix ${prefix}`, async (child) => {
        const db = await historyDatabase(child, fixture, "native_restart", { prefix });
        await assertNativeRestartUpgrade(db, prefix, {
          seedCanonicalAgent,
          runHistoryMigration,
          assertCompletedHistory,
          assertUpgradedRevisionReadable,
        });
      });
    }
  },
);

test(
  "Canonical migration preserves pending SandboxPolicy custody across the published 0076 and 0077 predecessors",
  requiresHistoryPostgres,
  async (context) => {
    const fixture = await migrationHistoryFixture();
    for (const [prefix, history] of await coveringNewestPrefix("pending SandboxPolicy", 76, [
      [76, "preControlPlaneAudit"],
      [77, "prePendingSandboxPolicyApplication"],
      [78, "prePredecessorReplacement"],
      [79, "preRevisionRuntimeInputs"],
      [80, "preRestartContinuation"],
      [81, "preAuthenticationStates"],
      [82, "preNativeRestartRecovery"],
      [83, "preRevisionEgressInstallations"],
      [84, "preStaticTokenServiceSources"],
      [85, "preTokenServiceSourceOwnership"],
    ])) {
      await context.test(`populated canonical ${prefix}`, async (child) => {
        const db = await historyDatabase(child, fixture, "pending_policy", { prefix });
        const namespace = `ns_${randomUUID()}`;
        const { agent, revision } = await seedCanonicalAgent(db, namespace, {
          computeAdmission: true,
          executionAdmission: true,
          harnessSettings: true,
        });
        const applicationId = randomUUID();
        const application = {
          id: applicationId,
          revisionId: revision,
          policyVersion: 1,
          snapshot: {
            driverId: "migration-fixture",
            implementation: "test",
            version: 1,
            defaults: {},
            additions: [],
          },
          state: "pending",
          requestedBy: "migration-fixture",
          requestedAt: new Date().toISOString(),
        };
        const workKey = `agent:${agent}:reconcile:sandbox_policy:${applicationId}`;
        // Persist the same policy/queue ownership shape used by normal application admission.
        await db.app.query("BEGIN");
        try {
          await db.app.query(
            "UPDATE occ.sandbox_policies SET document=document || jsonb_build_object('application',$1::jsonb) WHERE agent_id=$2",
            [application, agent],
          );
          await new PostgresWorkQueue(db.app).enqueue({
            idempotencyKey: workKey,
            namespaceId: namespace,
            agentId: agent,
            agentTarget: "sandbox_policy",
            actorId: application.requestedBy,
          });
          await db.app.query("COMMIT");
        } catch (error) {
          await db.app.query("ROLLBACK");
          throw error;
        }
        const custody = async () => ({
          policy: (
            await db.app.query("SELECT * FROM occ.sandbox_policies WHERE agent_id=$1", [agent])
          ).rows,
          work: (
            await db.app.query("SELECT * FROM occ.controller_work WHERE idempotency_key=$1", [
              workKey,
            ])
          ).rows,
          audit: (
            await db.app.query("SELECT * FROM occ.audit_events WHERE namespace_id=$1 ORDER BY id", [
              namespace,
            ])
          ).rows,
        });
        const binding = async () =>
          (
            await db.migrator
              .query(`SELECT p.oid,pg_get_userbyid(p.proowner) AS owner,p.proacl::text AS acl,
        t.oid AS trigger_oid,t.tgfoid,pg_get_triggerdef(t.oid) AS trigger_definition
        FROM pg_proc p JOIN pg_trigger t ON t.tgfoid=p.oid
        WHERE p.oid='occ.guard_sandbox_policy_update()'::regprocedure AND NOT t.tgisinternal`)
          ).rows;
        const before = await custody();
        const beforeBinding = await binding();
        const receipts = await historyReceipts(db.migrator);
        assert.equal(receipts.length, prefix);
        assert.equal(before.policy[0].document.application.state, "pending");
        assert.equal(before.work[0].state, "queued");
        assert.deepEqual(await runHistoryCommand(db, "production", "--check"), {
          ok: true,
          history,
        });
        assert.deepEqual(await runHistoryCommand(db, "production", "--require-current"), {
          ok: false,
          code: "MIGRATION_HISTORY_PENDING",
        });
        assert.deepEqual(await custody(), before);
        assert.deepEqual(await runHistoryCommand(db, "production"), {
          ok: true,
          history,
        });
        await assertCompletedHistory(db, receipts);
        // Public 0077 adds the audit-attempt column without changing queued work.
        const upgradedCustody = {
          ...before,
          work:
            prefix === 76
              ? before.work.map((row) => ({ ...row, audit_attempt_id: null }))
              : before.work,
        };
        const manifest = JSON.parse(
          await readFile(join(migrationsDirectory, "meta/_canonical-history.json"), "utf8"),
        );
        assert.deepEqual(
          (await historyReceipts(db.migrator))
            .slice(prefix)
            .map(({ hash, created_at }) => [hash, Number(created_at)]),
          manifest.entries.slice(prefix).map(({ sha256, when }) => [sha256, when]),
        );
        assert.equal(manifest.entries[77].tag, "0078_preserve_pending_sandbox_policy_application");
        assert.deepEqual(await custody(), upgradedCustody);
        assert.deepEqual(await binding(), beforeBinding);
        await assert.rejects(
          db.app.query(
            "UPDATE occ.sandbox_policies SET document=document-'application' WHERE agent_id=$1",
            [agent],
          ),
          { code: "23514" },
        );
        assert.deepEqual(await custody(), upgradedCustody);
        assert.deepEqual(await runHistoryCommand(db, "production", "--require-current"), {
          ok: true,
          history: "completed",
        });

        // An unrelated receipt in the same slot is not an upgradeable canonical prefix.
        const unknown = await historyDatabase(child, fixture, "unknown_policy_slot", { prefix });
        await unknown.migrator.query(
          "INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES(repeat('0',64),$1)",
          [manifest.entries[prefix].when],
        );
        const unknownBefore = await historySnapshot(unknown);
        for (const flag of ["--check", undefined]) {
          assert.deepEqual(
            await runHistoryCommand(
              unknown,
              "production",
              flag,
              /applied receipts differ from canonical history/,
            ),
            {
              ok: false,
              code: "MIGRATION_HISTORY_UNSUPPORTED",
            },
          );
          assert.deepEqual(await historySnapshot(unknown), unknownBefore);
        }
      });
    }
  },
);

test(
  "An authenticated user can browse revisions retained across the Harness settings migration",
  requiresHistoryPostgres,
  async (context) => {
    const fixture = await migrationHistoryFixture();
    const db = await historyDatabase(context, fixture, "harness_history", { prefix: 71 });
    const { namespace, agent, revision, current, settings } = await prepareRetainedHarnessRevisions(
      db,
      { seedCanonicalAgent, runHistoryMigration },
    );

    // The controller must stop before its parent context drops the database.
    await context.test("Signed-in revision reads", async (httpContext) => {
      const controller = await startController(httpContext, { databaseUrl: db.applicationUrl });
      const path = `/namespaces/${namespace}/agents/${agent}/revisions`;
      const list = await request(controller, "GET", path);
      const oldDetail = await request(controller, "GET", `${path}/${revision}`);
      const newDetail = await request(controller, "GET", `${path}/${current}`);
      assertRetainedRevisionResponses({ revision, current, settings }, list, oldDetail, newDetail);
    });
  },
);

registerPostgresMigrationTransactionCommandCases({
  requiresHistoryPostgres,
  migrationHistoryFixture,
  historyDatabase,
  historyAdmin,
  runHistoryCommand,
  historySnapshot,
  assertCompletedHistory,
});

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
    // Gaps: 26, 60 and 61 have no named history; 27 is covered by the rollback case.
    const histories = await coveringNewestPrefix("populated canonical", 62, [
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
      [64, "preSelectedRepositorySet"],
      [65, "preAgentDeployIntent"],
      [66, "preAgentCredentialSourceLimit"],
      [67, "preAgentPluginDriver"],
      [68, "preConnectionTemplates"],
      [69, "preSavedConnections"],
      [70, "preDefaultUsers"],
      [71, "preHarnessOverrides"],
      [72, "preAccountAdministrationPolicy"],
      [73, "preFiniteRepositorySessionWithdrawal"],
      [74, "preHumanAuthenticationResults"],
      [75, "preNativeBrowserAccess"],
      [76, "preControlPlaneAudit"],
      [77, "prePendingSandboxPolicyApplication"],
      [78, "prePredecessorReplacement"],
      [79, "preRevisionRuntimeInputs"],
      [80, "preRestartContinuation"],
      [81, "preAuthenticationStates"],
      [82, "preNativeRestartRecovery"],
      [83, "preRevisionEgressInstallations"],
      [84, "preStaticTokenServiceSources"],
      [85, "preTokenServiceSourceOwnership"],
    ]);
    for (const [prefix, history] of histories) {
      void context.test(`populated canonical ${history}`, async (child) => {
        const db = await historyDatabase(child, fixture, "main", { prefix });
        const namespaceId = await seedCanonicalData(db, {
          preset: prefix >= 25,
          computeAdmission: prefix >= 55,
          // 0060 requires an execution admission on every revision written after it.
          executionAdmission: prefix >= 62,
          // 0072 requires settings on new rows; earlier prefixes retain their historical shape.
          harnessSettings: prefix >= 72,
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
        // Upgrading an existing revision must never invent a recoverable first-deployment intent.
        const existingBindings = await db.app.query(
          "SELECT first_deployment_digest FROM occ.agent_revisions",
        );
        assert.ok(existingBindings.rows.length > 0);
        assert.ok(existingBindings.rows.every((row) => row.first_deployment_digest === null));
        await assertUpgradedAuthentication(db);
        if (history === "preHumanAuthenticationResults") {
          await assertSignInResultStorage(db.app);
        }
        if (history === "preConnectionTemplates") {
          // An Installation-wide template cannot present a Namespace client's credentials,
          // even when an application-role writer bypasses OCC.
          const templateId = `ctp_${randomUUID()}`;
          const registrationId = `ccr_${randomUUID()}`;
          await db.app.query("BEGIN");
          try {
            await db.app.query(
              `INSERT INTO occ.oauth_clients
                 (id,namespace_id,display_name,issuer,client_id,token_url,token_endpoint_auth_method,created_at)
               VALUES ($1,$2,'Namespace client','https://issuer.example.test','shared-client','https://issuer.example.test/token','none',now())`,
              [registrationId, namespaceId],
            );
            await db.app.query(
              `INSERT INTO occ.connection_templates
                 (id, namespace_id, display_name, current_version, created_at)
               VALUES ($1, NULL, 'Installation template', 1, now())`,
              [templateId],
            );
            await assert.rejects(
              db.app.query(
                `INSERT INTO occ.oauth_connection_template_versions
                   (template_id, version, oauth_client_id, issuer, mode, authorization_url,
                    token_url, scopes, authorization_parameters, destinations, created_at)
                 VALUES ($1, 1, $2, 'https://issuer.example.test', 'manual',
                    'https://issuer.example.test/auth', 'https://issuer.example.test/token',
                    ARRAY['read'], '{}', '[{"host":"api.example.test","port":443,"path":"/"}]', now())`,
                [templateId, registrationId],
              ),
              { code: "23514", message: /registration must belong to the template scope/ },
            );
          } finally {
            await db.app.query("ROLLBACK");
          }
        }
        if (history === "preGatewayManagedMode") {
          await db.app.query(
            `INSERT INTO occ.agent_revisions
               (id, namespace_id, agent_id, revision_number, backend_id, admitted_spec, admitted_at)
             SELECT $1, namespace_id, agent_id, revision_number + 1, backend_id,
               jsonb_set(admitted_spec, '{harness}', (admitted_spec->'harness') || '{"overrides":{},"configuration":{}}'::jsonb), now()
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
    const originalHarness = (
      await db.app.query(
        "SELECT admitted_spec->'harness' AS harness FROM occ.agent_revisions WHERE namespace_id=$1 AND revision_number=1",
        [namespaceId],
      )
    ).rows[0].harness;
    executionAdmission = {
      execution_admission: { version: 2, mode: "unprotected" },
      harness: { ...originalHarness, overrides: {}, configuration: {} },
    };
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

registerPostgresMigrationCredentialLineageCases({
  requiresHistoryPostgres,
  migrationHistoryFixture,
  historyDatabase,
  seedCanonicalData,
  installProviderCompletedHistory,
  installCanonicalPrefix,
  runHistoryMigration,
  historyReceipts,
  historySnapshot,
  assertCompletedHistory,
});

test(
  "Canonical migration completes a Provider lineage after later canonical migrations",
  concurrentHistoryPostgres,
  async (context) => {
    const fixture = await migrationHistoryFixture();
    // Prefixes 63 to 74 are not listed, so the guard starts at 75.
    for (const [prefix, history] of await coveringNewestPrefix("Provider continuation", 75, [
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
      [75, "preNativeBrowserAccess"],
      [76, "preControlPlaneAudit"],
      [77, "prePendingSandboxPolicyApplication"],
      [78, "prePredecessorReplacement"],
      [79, "preRevisionRuntimeInputs"],
      [80, "preRestartContinuation"],
      [81, "preAuthenticationStates"],
      [82, "preNativeRestartRecovery"],
      [83, "preRevisionEgressInstallations"],
      [84, "preStaticTokenServiceSources"],
      [85, "preTokenServiceSourceOwnership"],
    ])) {
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

async function dumpHistoryArchive(fixture, database) {
  const { stdout } = await execFileAsync(
    "docker",
    ["exec", fixture.container, "pg_dump", "-U", "postgres", "-Fc", database.name],
    { encoding: "buffer", timeout: 180_000, maxBuffer: 32 * 1024 * 1024 },
  );
  return stdout;
}

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

async function logicalRestoreSnapshot(db, identityReader = db.app) {
  const sequence = await db.migrator.query(
    "SELECT last_value,is_called FROM drizzle.__drizzle_migrations_id_seq",
  );
  return {
    ...(await historySnapshot(db)),
    identities: (await identityReader.query("SELECT * FROM occ.iam_identities ORDER BY id")).rows,
    sequence: sequence.rows,
  };
}

test(
  "Current canonical logical restore preserves data and refuses catalog tampering",
  requiresHistoryPostgres,
  async (context) => {
    const fixture = await migrationHistoryFixture();
    const source = await historyDatabase(context, fixture, "dump");
    assert.deepEqual(await runHistoryCommand(source, "production"), {
      ok: true,
      history: "empty",
    });
    await assertCompletedHistory(source);
    await source.app.query(
      "INSERT INTO occ.iam_identities(id,kind,issuer,subject) VALUES ('restore-human','principal','restore-fixture','human'), ('restore-service','service_principal',NULL,NULL)",
    );
    const native = await logicalRestoreSnapshot(source);
    assert.equal(native.identities.length, 2);

    // Restore a current-schema archive into a distinct database with ownership and grants intact.
    const archive = await dumpHistoryArchive(fixture, source);
    const restored = await restoreHistoryArchive(context, fixture, archive);
    const accepted = await logicalRestoreSnapshot(restored);
    const restoredDigest = catalogDigest(accepted.occ);
    context.diagnostic(`Restore current canonical: ${restoredDigest}`);
    assert.notEqual(restoredDigest, catalogDigest(native.occ));
    assert.deepEqual(accepted.receipts, native.receipts);
    assert.deepEqual(accepted.drizzle, native.drizzle);
    assert.deepEqual(accepted.identities, native.identities);
    assert.deepEqual(accepted.sequence, native.sequence);
    for (const flag of ["--check", undefined]) {
      assert.deepEqual(await runHistoryCommand(restored, "production", flag), {
        ok: true,
        history: "completed",
      });
      assert.deepEqual(await logicalRestoreSnapshot(restored), accepted);
    }
    await assertCredentialSchemaPrivileges(restored.app);

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
      // Read as migrator so the lost app grant does not hide row/sequence mutations.
      const beforeRefusal = await logicalRestoreSnapshot(drifted, drifted.migrator);
      for (const flag of ["--check", undefined]) {
        assert.deepEqual(await runHistoryCommand(drifted, "production", flag, refusal), {
          ok: false,
          code: "MIGRATION_HISTORY_UNSUPPORTED",
        });
        assert.deepEqual(await logicalRestoreSnapshot(drifted, drifted.migrator), beforeRefusal);
      }
    }
  },
);

registerPostgresMigrationCredentialLineageRefusalCase({
  requiresHistoryPostgres,
  migrationHistoryFixture,
  historyDatabase,
  installProviderCompletedHistory,
  assertHistoryRefused,
});

test(
  "Canonical migration rollback preserves receipts and retries through the other command",
  concurrentHistoryPostgres,
  async (context) => {
    const fixture = await migrationHistoryFixture();
    // Prefixes 63 to 74 are not listed, so the guard starts at 75.
    for (const [prefix, history] of await coveringNewestPrefix("rollback", 75, [
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
      [75, "preNativeBrowserAccess"],
      [76, "preControlPlaneAudit"],
      [77, "prePendingSandboxPolicyApplication"],
      [78, "prePredecessorReplacement"],
      [79, "preRevisionRuntimeInputs"],
      [80, "preRestartContinuation"],
      [81, "preAuthenticationStates"],
      [82, "preNativeRestartRecovery"],
      [83, "preRevisionEgressInstallations"],
      [84, "preStaticTokenServiceSources"],
      [85, "preTokenServiceSourceOwnership"],
    ])) {
      void context.test(`prefix ${prefix} transaction`, async (child) => {
        const db = await historyDatabase(child, fixture, "rollback", { prefix });
        if (prefix) {
          await seedCanonicalData(db, {
            preset: prefix >= 25,
            computeAdmission: prefix >= 55,
            executionAdmission: prefix >= 62,
            harnessSettings: prefix >= 72,
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
        // Reject native browser trigger creation after its tables and grants; all of 0076 must roll back.
        // 0078 replaces the custody guard in place; abort its CREATE FUNCTION statement.
        const rollbackTag =
          prefix === 0
            ? "CREATE TRIGGER"
            : [
                [85, "ALTER TABLE"],
                [83, "GRANT"],
                [82, "CREATE TRIGGER"],
                [81, "GRANT"],
                [79, "ALTER TABLE"],
                [78, "GRANT"],
                [77, "CREATE FUNCTION"],
                [76, "CREATE INDEX"],
                [75, "CREATE TRIGGER"],
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
        // A fresh install fails inside 0085 after its table exists. Drizzle must
        // roll back the whole install so retry starts from empty history.
        let failAt = "";
        if (prefix === 0) {
          failAt = "IF to_regclass('occ.token_service_instances') IS NULL THEN RETURN; END IF;";
        } else if (prefix >= 58) {
          failAt =
            "IF to_regclass('occ.credential_delivery_reductions') IS NULL THEN RETURN; END IF;";
        }
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
      ["completed-catalog", manifest.entries.length, "CREATE TABLE occ.unexplained(id integer)"],
      [
        "completed-grant",
        manifest.entries.length,
        "REVOKE SELECT ON occ.iam_identities FROM occ_app",
      ],
      [
        "completed-receipt",
        manifest.entries.length,
        "UPDATE drizzle.__drizzle_migrations SET hash=repeat('0',64) WHERE id=(SELECT min(id) FROM drizzle.__drizzle_migrations)",
      ],
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

registerPostgresMigrationSchemaAdmissionCases({
  concurrentHistoryPostgres,
  migrationHistoryFixture,
  historyDatabase,
  historyAdmin,
  runHistoryMigration,
  assertHistoryRefused,
  assertCompletedHistory,
  canonicalData,
  seedCanonicalData,
});

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
    await assertPresetPolicyUpgrade(pool, migrationsDirectory, {
      installationId,
      namespaceId,
      legacyPermissions,
      presetPermissions,
    });
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
    await assertAdministratorGrantUpgrade(pool, migrationsDirectory, migration, {
      namespaceId,
      presetSeed,
      releaseSeed,
      currentGrants,
    });
  },
);

// An unselected opt-in case must not become an unexpected skip in native PostgreSQL CI.
if (
  Object.values(controllerImages).some((image) =>
    Object.values(image).some((value) => value !== undefined),
  )
) {
  test(
    "Released controller remains usable across candidate database writes",
    { timeout: 360_000 },
    async (t) => {
      assert.ok(
        Object.values(controllerImages).every(
          (image) => typeof image.reference === "string" && typeof image.revision === "string",
        ),
        "Both released and candidate controller image references and revisions are required.",
      );
      await assertReleasedControllerCompatibility(t, controllerImages, async () => {
        const fixture = await migrationHistoryFixture();
        return historyDatabase(t, fixture, "released_controller");
      });
    },
  );
  test(
    "Released controller remains usable after configured IAM activation",
    { timeout: 360_000 },
    async (t) => {
      assert.ok(
        Object.values(controllerImages).every(
          (image) => typeof image.reference === "string" && typeof image.revision === "string",
        ),
        "Both released and candidate controller image references and revisions are required.",
      );
      await assertReleasedControllerIAMCompatibility(t, controllerImages, async () => {
        const fixture = await migrationHistoryFixture();
        return historyDatabase(t, fixture, "released_iam");
      });
    },
  );
}
