import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { asRecord } from "../../packages/utils/src/index.ts";
import type {} from "./ci-prepare-postgres-diagnostics-child.ts";
import {
  composePostgres,
  fixture,
  spawnResult,
  writePostgresState,
} from "../helpers/ci-prepare-fixture.ts";
import { rejectPostgresStartup, startFakePostgres } from "../helpers/fake-postgres-server.ts";
import { readJsonLines } from "../helpers/json-lines.mjs";

const childPath = fileURLToPath(
  new URL("./ci-prepare-postgres-diagnostics-child.ts", import.meta.url),
);
const scenarios = [
  { stage: "database-create", failure: "query", queries: ["create"], timedOut: false },
  { stage: "database-create", failure: "connect", queries: [], timedOut: false },
  { stage: "database-schema", failure: "query", queries: ["create", "schema"], timedOut: false },
  {
    stage: "database-migrate",
    failure: "exit",
    queries: ["create", "schema"],
    exitCode: 44,
    signal: null,
    timedOut: false,
  },
  { stage: "database-migrate", failure: "spawn", queries: ["create", "schema"] },
  {
    stage: "database-migrate",
    failure: "signal",
    queries: ["create", "schema"],
    exitCode: null,
    signal: "SIGTERM",
    timedOut: false,
  },
] as const;

function assertChildExited(pid: number | undefined) {
  assert.ok(pid, "expected a child process");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}

describe(
  "CI PostgreSQL preparation diagnostics",
  { concurrency: Math.min(4, 2 * availableParallelism()) },
  () => {
    for (const { queries, ...diagnostic } of scenarios) {
      const { stage, failure } = diagnostic;
      test(`PostgreSQL preparation identifies ${stage} ${failure}`, async (t) => {
        const root = await fixture(t);
        const statePath = join(root, "state.json");
        const commandsPath = join(root, "commands.jsonl");
        const corepackPath = join(root, "corepack.mjs");

        // An owned socket rejects startup in the connect case. The query fixture
        // completes startup and lets the real pg client observe statement errors.
        const postgres =
          failure === "connect"
            ? await rejectPostgresStartup(t)
            : await startFakePostgres({
                onQuery: (query) => {
                  if (
                    failure === "query" &&
                    (stage === "database-create") === query.startsWith("CREATE DATABASE ")
                  ) {
                    return { error: "secret-canary-server-message" };
                  }
                },
              });
        if ("close" in postgres) {
          t.after(() => postgres.close());
        }
        const server = composePostgres("diagnostics", postgres.port);
        await writePostgresState(statePath, server);

        // The migration executable is a tripwire in the SQL failures. The spawn
        // case leaves that path absent so Node observes a real spawn failure.
        if (failure !== "spawn") {
          const terminate =
            failure === "signal"
              ? 'process.kill(process.pid, "SIGTERM");'
              : `process.exit(${failure === "exit" ? diagnostic.exitCode : 45});`;
          await writeFile(
            corepackPath,
            `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(process.env.CI_DIAGNOSTIC_COMMANDS, JSON.stringify(process.pid) + "\\n");
process.stdout.write("secret-canary-stdout");
process.stderr.write("secret-canary-stderr");
${terminate}
`,
            { mode: 0o700 },
          );
        }

        let pid: number | undefined;
        const result = await spawnResult(process.execPath, [childPath, statePath], {
          env: {
            PATH: root,
            OCC_DOCKER_BIN: join(root, "must-not-run"),
            OPENCLAW_CI_COREPACK_BIN: corepackPath,
            CI_DIAGNOSTIC_COMMANDS: commandsPath,
          },
          timeout: 10_000,
          onSpawn: (child) => {
            pid = child.pid;
          },
        });
        assert.equal(result.error, undefined);
        assert.equal(result.signal, null);
        assert.equal(result.status, 0, result.stderr);
        assertChildExited(pid);
        const error: unknown = JSON.parse(result.stdout);
        assert.deepEqual(error, { code: "CI_PREPARATION_COMMAND_FAILED", ...diagnostic });

        const journal = asRecord(JSON.parse(await readFile(statePath, "utf8")));
        const resources: unknown = journal?.resources;
        assert.ok(Array.isArray(resources) && resources.length === 2);
        const database = asRecord(resources[1]);
        assert.ok(database && typeof database.name === "string");
        // Cleanup must retain ownership of a database whose setup failed partway.
        assert.deepEqual(resources[0], server);
        assert.equal(database.kind, "postgres-database");
        assert.equal(database.owner, server.owner);
        assert.equal(database.composeProject, server.name);
        assert.equal(database.port, server.port);
        assert.equal(database.status, "planned");
        assert.equal(database.laneTemplate, "ci");

        if ("connections" in postgres) {
          assert.equal(postgres.connections.length, 1);
          await Promise.all(postgres.connections);
        } else {
          const name = database.name;
          assert.deepEqual(
            postgres.queries().map((entry) => {
              if (entry === `postgres\tCREATE DATABASE "${name}"`) {
                return "create";
              }
              if (
                entry.startsWith(
                  `${name}\tGRANT CREATE ON DATABASE "${name}" TO occ_migrator; CREATE SCHEMA `,
                )
              ) {
                return "schema";
              }
              return entry;
            }),
            queries,
          );
        }

        if (failure === "spawn") {
          await assert.rejects(stat(corepackPath), { code: "ENOENT" });
        }
        const migrations: unknown = await readJsonLines(commandsPath, { missingOk: true });
        if (failure === "exit" || failure === "signal") {
          assert.ok(Array.isArray(migrations) && migrations.length === 1);
          const migrationPid: unknown = migrations[0];
          assert.ok(
            typeof migrationPid === "number" &&
              Number.isSafeInteger(migrationPid) &&
              migrationPid > 0,
          );
          assertChildExited(migrationPid);
        } else {
          await assert.rejects(stat(commandsPath), { code: "ENOENT" });
          assert.deepEqual(migrations, []);
        }
      });
    }
  },
);
