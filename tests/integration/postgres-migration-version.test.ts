import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import pg from "pg";
import { migrationCatalog } from "../../scripts/migration-catalog.mjs";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";

const exec = promisify(execFile);
const dependency = createRequire(new URL("../../packages/occ/package.json", import.meta.url));
const { drizzle } = dependency("drizzle-orm/node-postgres");
const { migrate } = dependency("drizzle-orm/node-postgres/migrator");

test(
  "Migration refuses PostgreSQL 16 before first installation or upgrade without exposing credentials",
  { skip: process.env.OCC_TEST_MIGRATION_SERVER !== "1", timeout: 180_000 },
  async (context) => {
    const container = `oce-migration-version-${randomUUID()}`;
    let client: pg.Client | undefined = undefined;
    // This server belongs only to this test. No existing database or role is changed.
    await exec(
      "docker",
      [
        "run",
        "--detach",
        "--name",
        container,
        "--env",
        "POSTGRES_PASSWORD",
        "--env",
        "POSTGRES_DB=openclaw_enterprise",
        "--publish",
        "127.0.0.1::5432",
        "docker.io/library/postgres:16.15",
      ],
      { env: { ...process.env, POSTGRES_PASSWORD: randomUUID() }, timeout: 120_000 },
    );
    context.after(async () => {
      try {
        await client?.end();
      } finally {
        await exec("docker", ["rm", "--force", "--volumes", container]);
      }
    });
    const mapped = await exec("docker", ["port", container, "5432/tcp"]);
    const port = Number(mapped.stdout.trim().split(":").at(-1));
    assert.ok(Number.isInteger(port) && port > 0);
    for (let attempt = 0; ; attempt += 1) {
      try {
        // TCP readiness avoids the temporary Unix-only server used during initialization.
        await exec("docker", [
          "exec",
          container,
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "postgres",
        ]);
        break;
      } catch {
        assert.ok(attempt < 60, "Disposable PostgreSQL server did not become ready.");
        await setTimeout(500);
      }
    }
    const setup = exec("docker", [
      "exec",
      "-i",
      container,
      "psql",
      "-U",
      "postgres",
      "-d",
      "openclaw_enterprise",
      "-v",
      "ON_ERROR_STOP=1",
    ]);
    setup.child.stdin!.end(
      await readFile(new URL("../../migrations/init-local.sql", import.meta.url)),
    );
    await setup;
    const url = syntheticCredentialUrl({
      protocol: "postgresql",
      username: "occ_migrator",
      password: "occ-migrator-local",
      host: "127.0.0.1",
      port,
      pathname: "/openclaw_enterprise",
    });
    client = new pg.Client({ connectionString: url });
    await client.connect();
    assert.match((await client.query("SHOW server_version")).rows[0].server_version, /^16\./);

    const run = async (connectionString: string, option?: string) => {
      try {
        return {
          code: 0,
          ...(await exec(
            process.execPath,
            ["scripts/migrate-production.mjs", ...(option ? [option] : [])],
            {
              env: {
                ...process.env,
                NODE_ENV: "production",
                OCC_DATABASE_AUTH: "password",
                OCC_CONFIG_PATH: undefined,
                OCC_MIGRATION_DATABASE_URL: connectionString,
              },
              timeout: 30_000,
            },
          )),
        };
      } catch (error) {
        const failure = error as { code: number; stdout: string; stderr: string };
        assert.equal(failure.code, 1, "Migration command must exit normally with failure.");
        return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
      }
    };
    const dump = async () =>
      (
        await exec("docker", [
          "exec",
          container,
          "pg_dump",
          "-U",
          "postgres",
          "--restrict-key=migrationversion",
          "openclaw_enterprise",
        ])
      ).stdout;

    for (const populated of [false, true]) {
      if (populated) {
        // Reproduce an installation made by the old runner, using the real SQL and receipts.
        await migrate(drizzle(client), { migrationsFolder: "migrations" });
        await client.query(
          "INSERT INTO occ.iam_identities(id,kind,issuer,subject) VALUES ('preserved-human','principal','fixture','human')",
        );
        await assert.rejects(migrationCatalog(client), {
          code: "22023",
          message: 'unrecognized privilege type: "MAINTAIN"',
        });
      }
      const before = await dump();
      for (const option of ["--expect-empty", "--check", undefined]) {
        const result = await run(url, option);
        assert.equal(result.code, 1);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /"code":"MIGRATION_SERVER_UNSUPPORTED"/);
        assert.match(result.stderr, /PostgreSQL 18\.6/);
        assert.match(result.stderr, /before.*migration/i);
        assert.ok(!result.stderr.includes(url));
        assert.ok(!result.stderr.includes("occ-migrator-local"));
      }
      // Includes schema, grants, receipt rows and application data, not only table counts.
      assert.equal(await dump(), before);
    }

    // A real authentication error contains the login in PostgreSQL's message. It stays redacted.
    const badUrl = new URL(url);
    badUrl.username = "private_migration_login";
    badUrl.password = "private-migration-password";
    const rejected = await run(badUrl.toString(), "--check");
    assert.equal(rejected.stdout, "");
    const events = rejected.stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.length, 1);
    const { time, ...event } = events[0];
    assert.equal(typeof time, "string");
    assert.deepEqual(event, {
      severity: "ERROR",
      service: "occ-migration",
      event: "migration.failed",
      code: "MIGRATION_FAILED",
    });
  },
);
