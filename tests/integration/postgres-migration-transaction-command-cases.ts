import assert from "node:assert/strict";
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
