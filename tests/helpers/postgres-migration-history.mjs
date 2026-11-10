import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { migrateWithHistory } from "../../scripts/migration-history.mjs";
import { createPostgresPool } from "../../packages/occ/src/state/postgres-pool.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const migrationsDirectory = join(repositoryRoot, "migrations");
const execFileAsync = promisify(execFile);
const dependency = createRequire(new URL("../../packages/occ/package.json", import.meta.url));
const { drizzle } = dependency("drizzle-orm/node-postgres");
const { migrate } = dependency("drizzle-orm/node-postgres/migrator");

const selectors = [
  process.env.OCC_TEST_DATABASE_URL,
  process.env.OPENCLAW_ENTERPRISE_CI_STATE,
  process.env.OPENCLAW_ENTERPRISE_CI_PREFIX,
];
export const requiresOwnedPostgres = {
  skip:
    selectors.slice(1).every((value) => value === undefined) &&
    !process.env.CI &&
    !process.env.GITHUB_ACTIONS
      ? "Requires the native CI runner's prepared disposable PostgreSQL fixture."
      : false,
};

export async function ownedPostgres() {
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

export async function runCommand(fixture, command, args) {
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
    // eslint-disable-next-line preserve-caught-error
    throw new Error(
      `${command} failed (code=${error.code ?? "none"}, signal=${error.signal ?? "none"}, killed=${error.killed === true}).`,
    );
  }
}

const historySelectors = [
  process.env.OCC_MIGRATION_HISTORY_DATABASE_URL,
  process.env.OCC_MIGRATION_HISTORY_CONTAINER,
  process.env.OCC_MIGRATION_HISTORY_DATABASE_PREFIX,
];
export const requiresHistoryPostgres = {
  skip: historySelectors.every((value) => value === undefined) && requiresOwnedPostgres.skip,
};
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

// Each test file owns its pool and registers its cleanup at file scope.
/** @param {typeof import("node:test").after} after */
export function migrationHistoryFixtureFor(after) {
  let historyFixture;
  after(async () => {
    await historyFixture?.then(
      (fixture) => fixture.admin.end(),
      () => {},
    );
  });
  return () => (historyFixture ??= resolveMigrationHistoryFixture());
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
export async function historyAdmin(fixture, database, sql) {
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
 * @param {import("node:test").TestContext} context
 * @param {Awaited<ReturnType<typeof resolveMigrationHistoryFixture>>} fixture
 * @param {string} label
 */
export async function historyDatabase(
  context,
  fixture,
  label,
  { schemas = true, prefix = 0 } = {},
) {
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

export async function installCanonicalPrefix(db, length, { entries: selectedEntries } = {}) {
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

// The history cases migrate a few hundred databases. Run them in this process: the same
// `migrateWithHistory` call on the same pool as `scripts/migrate-production.mjs`, with that
// command's outcome codes. The mode only selects the script (and its NODE_ENV logging),
// never the migration; `runHistoryCommand` covers the process contract. flag and refusal
// are as for runHistoryCommand: the command prints this same error.message on refusal.
/**
 * @param {{migrationUrl: string}} db
 * @param {"development" | "production"} mode
 * @param {"--check" | "--expect-empty"} [flag]
 * @param {RegExp} [refusal]
 * @param {(error: unknown) => void} [assertFailure]
 */
export async function runHistoryMigration(db, mode = "development", flag, refusal, assertFailure) {
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

/**
 * @param {import("pg").Client} client
 * @returns {Promise<Array<{id: number, hash: string, created_at: string}>>}
 */
export async function historyReceipts(client) {
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
