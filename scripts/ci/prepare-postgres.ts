import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { asRecord } from "../../packages/utils/src/index.ts";
import type {
  PreparationJournal,
  PreparationResource,
  PreparationState,
} from "./k3d-preparation.ts";
import { quoteIdentifier, runPostgresAdmin } from "./postgres-admin.ts";
import { commandAvailable, execFile } from "./prepare-command.ts";
import { ownedName } from "./resource-names.ts";

const databasePrefixes = {
  ci: "openclaw_ci",
  failures: "openclaw_failures",
  k8s: "openclaw_k8s",
} as const;

type DatabaseKind = keyof typeof databasePrefixes;
type DatabasePreparationOptions = {
  kind?: DatabaseKind;
  label: string;
  requireExistingServer?: boolean;
  template?: string | undefined;
};
type DatabaseCreationOptions = {
  kind: DatabaseKind;
  label: string;
  source?: string;
  laneTemplate?: DatabaseKind;
};
type PreparedDatabase = {
  name: string;
  appUrl: string;
  migrationUrl: string;
  resourceId: string;
};
type PostgresServer = { name: string; port: number };
type ComposeProject = { name: string; composeFile: string };
type PostgresAdminStep = {
  database?: string;
  statements: readonly string[];
  stage: "postgres-settings" | "database-create" | "database-schema";
};

function databaseName(kind: DatabaseKind, label: string) {
  return ownedName(databasePrefixes[kind], label, { maxLength: 63, separator: "_" });
}

function dockerArgsForPostgres(resource: ComposeProject, ...args: string[]) {
  return ["compose", "-f", resource.composeFile, "-p", resource.name, ...args];
}

function postgresUrl(role: string, password: string, port: number, database: string) {
  return `postgresql://${role}:${password}@127.0.0.1:${port}/${database}`;
}

function parsePostgresPorts(stdout: string): unknown {
  try {
    const ports: unknown = JSON.parse(stdout);
    return ports;
  } catch {
    throw new Error("Invalid PostgreSQL port discovery response.");
  }
}

function postgresResource(state: PreparationState) {
  return state.resources.find((resource) => resource.kind === "compose-postgres");
}

// The lane's server is disposable (cleanup removes it with its volume), so it gives up
// durability: commits stop waiting for WAL flushes, and the checkpoint each test
// database's DROP DATABASE waits for skips its fsyncs. PostgreSQL containers wrote most
// of a loaded runner's IO. A host crash could now corrupt the data and a server crash
// could lose the last few hundred milliseconds of acknowledged commits; nothing kills
// this server or reads it after a crash. The reload is requested before any test
// database exists. Developers' compose.postgres.yaml server keeps PostgreSQL's defaults.
const ciPostgresSettings = Object.freeze([
  "ALTER SYSTEM SET fsync = off",
  "ALTER SYSTEM SET synchronous_commit = off",
  "ALTER SYSTEM SET full_page_writes = off",
  "SELECT pg_catalog.pg_reload_conf()",
]);

// Administrative SQL on the lane's server, over its published port (postgres-admin.ts). A
// failed database step carries the closed diagnostic contract run-tests.ts reports.
async function postgresAdmin(
  server: PostgresServer,
  { database, statements, stage }: PostgresAdminStep,
) {
  try {
    await runPostgresAdmin({
      port: server.port,
      ...(database === undefined ? {} : { database }),
      statements,
    });
  } catch (error) {
    if (error instanceof Error && stage !== "postgres-settings") {
      Object.assign(error, { code: "CI_PREPARATION_COMMAND_FAILED", stage });
    }
    throw error;
  }
}

// A template must be a ready database this state owns on the same server. Nothing may
// stay connected to it: PostgreSQL refuses to copy a database that has other sessions.
function templateDatabase(state: PreparationState, server: PostgresServer, templateUrl: string) {
  let name: string;
  try {
    name = new URL(templateUrl).pathname.slice(1);
  } catch {
    throw new Error("The template must be a PostgreSQL URL that prepareFile returned.");
  }
  if (!findReadyDatabase(state, server, "name", name)) {
    throw new Error("The template must be a ready database prepared in this state.");
  }
  return name;
}

function findReadyDatabase(
  state: PreparationState,
  server: PostgresServer,
  field: "name" | "laneTemplate",
  value: string,
): Record<string, unknown> | undefined {
  for (const entry of state.resources) {
    const resource = asRecord(entry);
    if (
      resource?.kind === "postgres-database" &&
      resource[field] === value &&
      resource.owner === state.prefix &&
      resource.status === "ready" &&
      resource.composeProject === server.name &&
      resource.port === server.port
    ) {
      return resource;
    }
  }
  return undefined;
}

export function createPostgresPreparation(
  repositoryRoot: string,
  { addResource, writeState, markResourceReady }: PreparationJournal,
) {
  const composePostgresFile = join(repositoryRoot, "compose.postgres.yaml");

  async function ensurePostgresServer(
    statePath: string,
    state: PreparationState,
  ): Promise<PreparationResource> {
    const existing = postgresResource(state);
    if (existing) {
      return existing;
    }
    await commandAvailable(process.env.OCC_DOCKER_BIN ?? "docker", [
      "version",
      "--format",
      "{{.Server.Version}}",
    ]);
    const project = ownedName("openclaw-ci-pg", state.prefix, { maxLength: 63, separator: "_" });
    const directory = join(dirname(statePath), `${project}-bootstrap`);
    try {
      await lstat(directory);
      throw new Error(`Refusing existing PostgreSQL bootstrap directory: ${directory}`);
    } catch (error) {
      if (asRecord(error)?.code !== "ENOENT") {
        throw error;
      }
    }
    const resource = addResource(state, "compose-postgres", {
      name: project,
      directory,
      directoryCreated: false,
      initSqlCreated: false,
      composeFile: composePostgresFile,
      // Zero asks Docker to allocate in its own host namespace. Keep this pending
      // value until discovery succeeds so partial startup can still be cleaned.
      port: 0,
    });
    await writeState(statePath, state);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      state.resources = state.resources.filter(({ id }) => id !== resource.id);
      await writeState(statePath, state);
      throw error;
    }
    // Cleanup must not claim a competing directory if creation or this save fails.
    resource.directoryCreated = true;
    await writeState(statePath, state);
    // PostgreSQL reads this public bootstrap as its container user, not the checkout owner.
    const initSql = join(directory, "init-local.sql");
    await writeFile(initSql, await readFile(join(repositoryRoot, "migrations/init-local.sql")), {
      flag: "wx",
      mode: 0o600,
    });
    resource.initSqlCreated = true;
    await writeState(statePath, state);
    await chmod(initSql, 0o644);
    try {
      await execFile(
        process.env.OCC_DOCKER_BIN ?? "docker",
        dockerArgsForPostgres(resource, "up", "-d", "--wait"),
        { env: { OCC_POSTGRES_PORT: "0", OPENCLAW_CI_POSTGRES_INIT_SQL: initSql } },
      );
    } catch (error) {
      const output = asRecord(error);
      if (
        error instanceof Error &&
        /all predefined address pools have been fully subnetted/i.test(
          `${output?.stderr ?? ""}\n${output?.stdout ?? ""}`,
        )
      ) {
        const quotedStatePath = `'${statePath.replaceAll("'", "'\\''")}'`;
        error.message +=
          `\nDocker subnet pools are exhausted. Clean this run's partial resources with:\n` +
          `node scripts/ci/cleanup.ts --state ${quotedStatePath}\n` +
          `Retain the state if cleanup fails. On a shared host, ask the host administrator ` +
          `to coordinate cleanup of confirmed abandoned projects with their owners; ` +
          `do not prune shared networks or volumes. See docs/testing/postgresql.md#subnet-pool-exhaustion.`;
      }
      throw error;
    }
    const docker = process.env.OCC_DOCKER_BIN ?? "docker";
    // Standalone podman-compose does not accept a service argument to ps.
    const lookup =
      basename(docker) === "podman"
        ? await execFile(docker, [
            "ps",
            "--no-trunc",
            "--filter",
            `label=com.docker.compose.project=${resource.name}`,
            "--filter",
            "label=com.docker.compose.service=postgres",
            "--format",
            "{{.ID}}",
          ])
        : await execFile(docker, dockerArgsForPostgres(resource, "ps", "-q", "postgres"), {
            env: { OCC_POSTGRES_PORT: "0", OPENCLAW_CI_POSTGRES_INIT_SQL: initSql },
          });
    const container = lookup.stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(container)) {
      throw new Error("Expected one owned PostgreSQL container for port discovery.");
    }
    const cluster = state.resources.find(
      (entry) => entry.kind === "k3d-cluster" && entry.status === "ready",
    );
    if (cluster) {
      // Linux Docker can reassign an automatic host port when a network attaches.
      // Finish this topology before publishing the port or opening test pools.
      const clusterName = asRecord(cluster)?.name;
      if (typeof clusterName !== "string") {
        throw new Error("Invalid k3d cluster name in CI state.");
      }
      const networks: unknown = JSON.parse(
        (
          await execFile(docker, [
            "inspect",
            "--format",
            "{{json .NetworkSettings.Networks}}",
            `k3d-${clusterName}-server-0`,
          ])
        ).stdout,
      );
      const entries = asRecord(networks);
      const network =
        entries && Object.keys(entries).find((name) => name.startsWith(`k3d-${clusterName}`));
      if (!network) {
        throw new Error("The owned k3d network is unavailable for PostgreSQL.");
      }
      await execFile(docker, ["network", "connect", network, container]);
    }
    const output = await execFile(docker, [
      "inspect",
      "--format",
      "{{json .NetworkSettings.Ports}}",
      container,
    ]);
    const ports = parsePostgresPorts(output.stdout);
    const published = asRecord(ports)?.["5432/tcp"];
    const bindings: readonly unknown[] = Array.isArray(published) ? published : [];
    const binding = asRecord(bindings[0]);
    const hostPort = binding?.HostPort;
    const port = typeof hostPort === "string" ? Number(hostPort) : NaN;
    if (
      bindings.length !== 1 ||
      binding?.HostIp !== "127.0.0.1" ||
      typeof hostPort !== "string" ||
      !/^[1-9][0-9]{0,4}$/.test(hostPort) ||
      port > 65535 ||
      port === 55432
    ) {
      throw new Error("Expected one loopback PostgreSQL port outside developer port 55432.");
    }
    resource.port = port;
    await writeState(statePath, state);
    await postgresAdmin(resource, { statements: ciPostgresSettings, stage: "postgres-settings" });
    await markResourceReady(statePath, state, resource);
    return resource;
  }

  async function createAndMigrateDatabase(
    statePath: string,
    state: PreparationState,
    { kind = "ci", label, requireExistingServer = false, template }: DatabasePreparationOptions,
  ): Promise<PreparedDatabase> {
    const existingServer = postgresResource(state);
    if (requireExistingServer && !existingServer) {
      throw new Error(
        "prepareFile requires prepareLane to create the owned PostgreSQL server first.",
      );
    }
    const serverResource = existingServer ?? (await ensurePostgresServer(statePath, state));
    if (serverResource.status !== "ready") {
      throw new Error("PostgreSQL server is not ready; clean up the failed preparation first.");
    }
    const record = asRecord(serverResource);
    if (typeof record?.name !== "string" || typeof record.port !== "number") {
      throw new Error("Invalid ready PostgreSQL server in CI state.");
    }
    const server = { name: record.name, port: record.port };
    const source =
      template === undefined
        ? await laneTemplateDatabase(statePath, state, server, kind)
        : templateDatabase(state, server, template);
    return createDatabase(statePath, state, server, { kind, label, source });
  }

  // The server's migrated database, one per kind, that each file's database of that kind
  // copies. Migrating takes a pnpm process and seconds of CPU, and it ran once per file
  // under the CI state lock, where each test's own copy waited behind it: a worker revision
  // file's first test waited for the runner to migrate the files that start with it
  // (finding 2178). A copy is the same database (schemas, their ACLs, every migration).
  // PostgreSQL copies only a database without sessions, and nothing connects to the
  // template: its URL is never handed out. Lane cleanup drops it with the other databases.
  async function laneTemplateDatabase(
    statePath: string,
    state: PreparationState,
    server: PostgresServer,
    kind: DatabaseKind,
  ) {
    const existing = findReadyDatabase(state, server, "laneTemplate", kind);
    if (existing) {
      if (typeof existing.name !== "string") {
        throw new Error("Invalid lane template database name in CI state.");
      }
      return existing.name;
    }
    const created = await createDatabase(statePath, state, server, {
      kind,
      label: "lane_template",
      laneTemplate: kind,
    });
    return created.name;
  }

  async function createDatabase(
    statePath: string,
    state: PreparationState,
    server: PostgresServer,
    { kind, label, source, laneTemplate }: DatabaseCreationOptions,
  ): Promise<PreparedDatabase> {
    const name = databaseName(kind, label);
    const resource = addResource(state, "postgres-database", {
      name,
      composeProject: server.name,
      port: server.port,
      ...(laneTemplate === undefined ? {} : { laneTemplate }),
    });
    await writeState(statePath, state);

    const grant = `GRANT CREATE ON DATABASE ${quoteIdentifier(name)} TO occ_migrator;`;
    await postgresAdmin(server, {
      statements: [
        `CREATE DATABASE ${quoteIdentifier(name)}${source === undefined ? "" : ` TEMPLATE ${quoteIdentifier(source)}`}`,
        // A copy carries the template's schemas, their ACLs and every migration, but not
        // the database-level grant, which lives in pg_database, so it is granted from here.
        // Each statement is its own request (CREATE DATABASE refuses a transaction block)
        // and the first error stops the rest. Every test's copy runs this.
        ...(source === undefined ? [] : [grant]),
      ],
      stage: "database-create",
    });
    const migrationUrl = postgresUrl("occ_migrator", "occ-migrator-local", server.port, name);
    if (source === undefined) {
      await postgresAdmin(server, {
        database: name,
        statements: [
          `${grant} CREATE SCHEMA occ AUTHORIZATION occ_migrator; CREATE SCHEMA drizzle AUTHORIZATION occ_migrator; REVOKE CREATE ON SCHEMA public FROM PUBLIC;`,
        ],
        stage: "database-schema",
      });
      await execFile(process.env.OPENCLAW_CI_COREPACK_BIN ?? "corepack", ["pnpm", "db:migrate"], {
        env: { OCC_MIGRATION_DATABASE_URL: migrationUrl },
        stage: "database-migrate",
      });
    }
    await markResourceReady(statePath, state, resource);
    return {
      name,
      appUrl: postgresUrl("occ_app", "occ-app-local", server.port, name),
      migrationUrl,
      resourceId: resource.id,
    };
  }

  return { ensurePostgresServer, createAndMigrateDatabase };
}
