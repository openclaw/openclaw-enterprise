import { selectedImageMigrationEntry } from "../../scripts/lib/selected-image-migration.ts";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import test, { type TestContext, type TestOptions } from "node:test";
import type { Client, Pool } from "pg";
import { createPostgresPool } from "../../packages/occ/src/state/postgres-pool.ts";
import type { initialSchemaState, migrationCatalog } from "../../scripts/migration-catalog.ts";
import { migrateWithHistory } from "../../scripts/migration-history.mjs";

export type MigrationCommandMode = "development" | "production";
export type MigrationCommandFlag = "--check" | "--require-current" | "--expect-empty";
export type MigrationCommandResult =
  | { ok: true; history: string }
  | {
      ok: false;
      code:
        | "MIGRATION_HISTORY_PENDING"
        | "MIGRATION_HISTORY_UNSUPPORTED"
        | "MIGRATION_HISTORY_NOT_EMPTY"
        | "MIGRATION_REGISTRATION_PENDING"
        | "MIGRATION_FAILED";
    };

type HistoryAdministration = { admin: Pool; adminUrl: string };
type HistoryFixture = HistoryAdministration & {
  migrationUrl: string;
  container: string;
  port: number;
  databasePrefix: string;
};
type HistoryDatabase = HistoryFixture & {
  name: string;
  migrator: Client;
  app: Client;
};
export type MigrationReceipt = { id: number; hash: string; created_at: string | null };
export type MigrationDefaultAcl = {
  oid: number;
  defaclrole: number;
  defaclnamespace: number;
  defaclobjtype: string;
  acl: string | null;
};
type Snapshot = {
  receipts: MigrationReceipt[];
  occ: Awaited<ReturnType<typeof migrationCatalog>>;
  drizzle: Awaited<ReturnType<typeof migrationCatalog>>;
  defaultAcls: MigrationDefaultAcl[];
  initialOcc: Awaited<ReturnType<typeof initialSchemaState>>;
  initialDrizzle: Awaited<ReturnType<typeof initialSchemaState>>;
};

type TransactionCommandDependencies = {
  requiresHistoryPostgres: Pick<TestOptions, "skip">;
  migrationHistoryFixture: () => Promise<HistoryFixture>;
  historyDatabase: (
    context: TestContext,
    fixture: HistoryFixture,
    label: string,
    options?: { schemas?: boolean; prefix?: number },
  ) => Promise<HistoryDatabase>;
  historyAdmin: (fixture: HistoryAdministration, database: string, sql: string) => Promise<void>;
  runHistoryCommand: (
    db: Pick<HistoryDatabase, "migrationUrl">,
    mode?: MigrationCommandMode,
    flag?: MigrationCommandFlag,
    refusal?: RegExp,
  ) => Promise<MigrationCommandResult>;
  historySnapshot: (db: Pick<HistoryDatabase, "migrator">) => Promise<Snapshot>;
  assertCompletedHistory: (db: Pick<HistoryDatabase, "app" | "migrator">) => Promise<void>;
};

export function registerPostgresMigrationTransactionCommandCases({
  requiresHistoryPostgres,
  migrationHistoryFixture,
  historyDatabase,
  historyAdmin,
  runHistoryCommand,
  historySnapshot,
  assertCompletedHistory,
}: TransactionCommandDependencies): void {
  test(
    "Separate database deployment verifies the exact candidate history without applying pending SQL",
    requiresHistoryPostgres,
    async (context) => {
      const db = await historyDatabase(context, await migrationHistoryFixture(), "separate", {
        prefix: 73,
      });
      const verify = () => runHistoryCommand(db, "production", "--require-current");
      const predecessor = await historySnapshot(db);
      assert.deepEqual(await verify(), { ok: false, code: "MIGRATION_HISTORY_PENDING" });
      assert.deepEqual(await historySnapshot(db), predecessor);
      assert.deepEqual(await runHistoryCommand(db, "production"), {
        ok: true,
        history: "preFiniteRepositorySessionWithdrawal",
      });
      const current = await historySnapshot(db);
      assert.deepEqual(await verify(), { ok: true, history: "completed" });
      assert.deepEqual(await historySnapshot(db), current);
      await db.migrator.query<Record<string, never>>(
        "REVOKE SELECT ON occ.iam_identities FROM occ_app",
      );
      assert.deepEqual(await verify(), { ok: false, code: "MIGRATION_HISTORY_UNSUPPORTED" });
    },
  );

  test(
    "Completed migration avoids DDL while preserving read-only refusal and lock release",
    requiresHistoryPostgres,
    async (context) => {
      const db = await historyDatabase(context, await migrationHistoryFixture(), "completed", {
        prefix: 73,
      });
      // Observe attempted DDL, including CREATE IF NOT EXISTS on existing objects.
      // These database-local objects are outside the canonical application catalogs.
      await historyAdmin(
        db,
        db.name,
        `CREATE SEQUENCE public.migration_ddl_attempts;
         GRANT USAGE, SELECT ON public.migration_ddl_attempts TO occ_migrator;
         CREATE FUNCTION public.observe_migration_ddl() RETURNS event_trigger
         LANGUAGE plpgsql AS $$ BEGIN
           PERFORM nextval('public.migration_ddl_attempts');
         END $$;
         CREATE EVENT TRIGGER observe_migration_ddl ON ddl_command_start
         WHEN TAG IN ('CREATE SCHEMA', 'CREATE TABLE')
         EXECUTE FUNCTION public.observe_migration_ddl();`,
      );
      const attempts = async () => {
        const {
          rows: [row],
        } = await db.migrator.query<{ last_value: unknown }>(
          "SELECT last_value FROM public.migration_ddl_attempts",
        );
        assert.ok(
          row && typeof row.last_value === "string",
          "Expected a PostgreSQL sequence value.",
        );
        return row.last_value;
      };
      assert.deepEqual(await runHistoryCommand(db, "production"), {
        ok: true,
        history: "preFiniteRepositorySessionWithdrawal",
      });
      const before = await attempts();
      assert.ok(Number(before) >= 2, "The observer must see the pending migrator's DDL.");
      const snapshot = await historySnapshot(db);
      for (const mode of ["development", "production"] as const) {
        assert.deepEqual(await runHistoryCommand(db, mode), { ok: true, history: "completed" });
        assert.equal(await attempts(), before, "A completed migration must not attempt DDL.");
      }

      const readonly = new URL(db.migrationUrl);
      readonly.searchParams.set("options", "-c default_transaction_read_only=on");
      const readonlyDb = { ...db, migrationUrl: readonly.toString() };
      assert.deepEqual(await runHistoryCommand(readonlyDb, "production"), {
        ok: false,
        code: "MIGRATION_FAILED",
      });
      for (const flag of ["--check", "--require-current"] as const) {
        assert.deepEqual(await runHistoryCommand(readonlyDb, "production", flag), {
          ok: true,
          history: "completed",
        });
      }
      assert.deepEqual(await runHistoryCommand(readonlyDb, "production", "--expect-empty"), {
        ok: false,
        code: "MIGRATION_HISTORY_NOT_EMPTY",
      });

      // Keep the backend alive: closing the pool would hide a missing explicit unlock.
      for (const readOnly of [false, true]) {
        const pool = await createPostgresPool(db.migrationUrl, {
          max: 1,
          options: `-c default_transaction_read_only=${readOnly ? "on" : "off"}`,
        });
        try {
          if (readOnly) {
            await assert.rejects(migrateWithHistory(pool), (error: unknown) => {
              const cause = error instanceof Error ? error.cause : undefined;
              return cause instanceof Error && "code" in cause && cause.code === "25006";
            });
          } else {
            assert.equal(await migrateWithHistory(pool), "completed");
          }
          const {
            rows: [settings],
          } = await pool.query<{ transaction_read_only: unknown }>("SHOW transaction_read_only");
          assert.equal(settings?.transaction_read_only, readOnly ? "on" : "off");
          const {
            rows: [lock],
          } = await db.migrator.query<{ held: unknown }>(
            "SELECT pg_try_advisory_lock(1868785005, 1835624306) AS held",
          );
          assert.equal(lock?.held, true);
          await db.migrator.query<{ pg_advisory_unlock: boolean }>(
            "SELECT pg_advisory_unlock(1868785005, 1835624306)",
          );
        } finally {
          await pool.end();
        }
      }
      assert.deepEqual(await historySnapshot(db), snapshot);
    },
  );

  test(
    "The operator migration check rejects a misplaced separator without applying",
    requiresHistoryPostgres,
    async (context) => {
      const fixture = await migrationHistoryFixture();
      const db = await historyDatabase(context, fixture, "check_args");
      const before = await historySnapshot(db);
      const run = promisify(execFile);
      const options = {
        env: {
          ...process.env,
          NODE_ENV: "production",
          OCC_MIGRATION_DATABASE_URL: db.migrationUrl,
        },
      };
      // The documented direct invocation receives --check as its own argument.
      const checked = await run(
        process.execPath,
        [...selectedImageMigrationEntry, "--check"],
        options,
      );
      assert.match(checked.stdout, /"event":"migration.checked","history":"empty"/);
      // An operator who adds the old task-runner separator must get a refusal, never an apply.
      await assert.rejects(
        run(process.execPath, [...selectedImageMigrationEntry, "--", "--check"], options),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === 1 &&
          "stderr" in error &&
          typeof error.stderr === "string" &&
          error.stderr.includes('"code":"MIGRATION_FAILED"'),
      );
      assert.deepEqual(await historySnapshot(db), before);
    },
  );

  test(
    "Cancelling the production migration process releases its database session",
    requiresHistoryPostgres,
    (context) => checkCancellation(context, "advisory"),
  );

  test(
    "Cancelling the production migration during blocked DDL preserves history",
    requiresHistoryPostgres,
    (context) => checkCancellation(context, "ddl"),
  );

  async function checkCancellation(context: TestContext, lock: "advisory" | "ddl") {
    const ddl = lock === "ddl";
    const fixture = await migrationHistoryFixture();
    const db = await historyDatabase(
      context,
      fixture,
      `cancel_${lock}`,
      ddl ? { prefix: 88 } : undefined,
    );
    const before = ddl ? await historySnapshot(db) : undefined;
    if (ddl) {
      // Migration 0089 must wait to alter this table after starting its transaction.
      await db.app.query("BEGIN READ ONLY");
      await db.app.query("SELECT 1 FROM occ.connection_templates LIMIT 1");
    } else {
      await db.migrator.query("SELECT pg_advisory_lock(1868785005, 1835624306)");
    }
    const child = spawn(process.execPath, selectedImageMigrationEntry, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_ENV: "production", OCC_MIGRATION_DATABASE_URL: db.migrationUrl },
    });
    const exited = once(child, "close").then(() => undefined);
    let wroteStdout = false;
    child.stdout.on("data", () => {
      wroteStdout = true;
    });

    const limit = 16_384;
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk.slice(0, limit + 1 - stderr.length);
    });
    const sessions = async () =>
      (
        await db.migrator.query<{ waiting: boolean }>(
          `SELECT EXISTS (
               SELECT 1 FROM pg_locks l WHERE l.pid = a.pid AND NOT l.granted
               AND CASE WHEN $1 THEN l.mode = 'AccessExclusiveLock'
                 AND l.relation = to_regclass('occ.connection_templates')
                 ELSE l.locktype = 'advisory' END
             ) AS waiting FROM pg_stat_activity a
             WHERE a.datname = current_database() AND a.application_name LIKE 'oce-migration-%'`,
          [ddl],
        )
      ).rows;
    async function until(predicate: () => Promise<boolean>, timeout: number) {
      const deadline = Date.now() + timeout;
      do {
        if (await predicate()) {
          return true;
        }
        await delay(25);
      } while (Date.now() < deadline);
      return false;
    }
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      assert.equal(
        await until(async () => (await sessions()).some(({ waiting }) => waiting), 15_000),
        true,
        `migration did not wait for the ${lock} lock`,
      );
      assert.ok(child.kill("SIGTERM"));
      if (!ddl) {
        await delay(5);
        child.kill("SIGTERM");
      }
      const exitDeadline = new Promise<never>((_, reject) => {
        exitTimer = setTimeout(
          () => reject(new Error("migration did not exit within 10 seconds after SIGTERM")),
          10_000,
        );
      });
      await Promise.race([exited, exitDeadline]);
      assert.equal(child.exitCode, 143);
      assert.equal(child.signalCode, null);
      assert.equal(wroteStdout, false, "cancelled migration wrote a stdout result");
      assert.ok(stderr.length <= limit, "excessive cancellation output");
      assert.ok(!stderr.includes("Unhandled 'error' event"), "unhandled client error");
      const failed = stderr.split("\n").some((line) => {
        try {
          const event: unknown = JSON.parse(line);
          return (
            typeof event === "object" &&
            event !== null &&
            "event" in event &&
            event.event === "migration.failed" &&
            "code" in event &&
            event.code === "MIGRATION_FAILED"
          );
        } catch {
          return false;
        }
      });
      assert.ok(failed, "missing structured migration failure");
      assert.equal(
        await until(async () => (await sessions()).length === 0, 2_000),
        true,
        "migration session survived caller cancellation",
      );
    } finally {
      clearTimeout(exitTimer);
      try {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await exited;
        }
      } finally {
        if (ddl) await db.app.query("ROLLBACK");
        else await db.migrator.query("SELECT pg_advisory_unlock(1868785005, 1835624306)");
      }
    }
    if (ddl) assert.deepEqual(await historySnapshot(db), before);
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
}
