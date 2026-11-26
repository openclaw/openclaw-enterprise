import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext, TestOptions } from "node:test";
import type { Client, Pool } from "pg";
import type { migrateWithHistory } from "../../scripts/migration-history.mjs";

type MigrationHistory = Awaited<ReturnType<typeof migrateWithHistory>>;
type MigrationResult =
  | { ok: true; history: MigrationHistory }
  | {
      ok: false;
      code: "MIGRATION_HISTORY_UNSUPPORTED" | "MIGRATION_HISTORY_NOT_EMPTY" | "MIGRATION_FAILED";
    };

type HistoryAdministration = {
  admin: Pool;
  adminUrl: string;
};

type HistoryFixture = HistoryAdministration & {
  migrationUrl: string;
  container: string;
  port: number;
  databasePrefix: string;
};

type HistoryDatabase = HistoryFixture & {
  name: string;
  applicationUrl: string;
  app: Client;
  migrator: Client;
};

type SchemaAdmissionDependencies = {
  concurrentHistoryPostgres: Pick<TestOptions, "skip" | "concurrency">;
  migrationHistoryFixture: () => Promise<HistoryFixture>;
  historyDatabase: (
    context: TestContext,
    fixture: HistoryFixture,
    label: string,
    options?: { schemas?: boolean; prefix?: number },
  ) => Promise<HistoryDatabase>;
  historyAdmin: (fixture: HistoryAdministration, database: string, sql: string) => Promise<void>;
  runHistoryMigration: (
    db: Pick<HistoryDatabase, "migrationUrl">,
    mode?: "development" | "production",
    flag?: "--check" | "--expect-empty",
    refusal?: RegExp,
    assertFailure?: (error: unknown) => void,
  ) => Promise<MigrationResult>;
  assertHistoryRefused: (db: HistoryDatabase, refusal?: RegExp) => Promise<void>;
  assertCompletedHistory: (db: HistoryDatabase) => Promise<void>;
  canonicalData: (db: HistoryDatabase) => Promise<unknown>;
  seedCanonicalData: (db: HistoryDatabase, options?: { preset?: boolean }) => Promise<string>;
};

type InstalledHistory = "main" | "completed";
const installedHistories = ["main", "completed"] as const satisfies readonly InstalledHistory[];

type DefaultAclObject =
  | readonly ["SCHEMAS", "n"]
  | readonly ["TYPES", "T"]
  | readonly ["TABLES", "r"]
  | readonly ["SEQUENCES", "S"];

const defaultAclObjects = [
  ["SCHEMAS", "n"],
  ["TYPES", "T"],
  ["TABLES", "r"],
  ["SEQUENCES", "S"],
] as const satisfies readonly DefaultAclObject[];

type DefaultAclRow = { acl: string };

type SetupCase<Statement> = readonly [label: string, statement: Statement];

export function registerPostgresMigrationSchemaAdmissionCases({
  concurrentHistoryPostgres,
  migrationHistoryFixture,
  historyDatabase,
  historyAdmin,
  runHistoryMigration,
  assertHistoryRefused,
  assertCompletedHistory,
  canonicalData,
  seedCanonicalData,
}: SchemaAdmissionDependencies): void {
  test(
    "Canonical migration refuses empty default ACLs on installed histories",
    concurrentHistoryPostgres,
    async (context) => {
      const fixture = await migrationHistoryFixture();
      for (const history of installedHistories) {
        for (const [kind, objectType] of defaultAclObjects) {
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
            await db.migrator.query<Record<string, unknown>>(
              `ALTER DEFAULT PRIVILEGES REVOKE ALL ON ${kind} FROM PUBLIC; ALTER DEFAULT PRIVILEGES REVOKE ALL ON ${kind} FROM occ_migrator`,
            );
            assert.deepEqual(
              (
                await db.migrator.query<DefaultAclRow, [DefaultAclObject[1]]>(
                  "SELECT defaclacl::text AS acl FROM pg_catalog.pg_default_acl WHERE defaclrole=current_user::regrole AND defaclnamespace=0 AND defaclobjtype=$1",
                  [objectType],
                )
              ).rows,
              [{ acl: "{}" }] satisfies DefaultAclRow[],
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
      ] satisfies readonly SetupCase<string>[]) {
        void context.test(label, async (child) => {
          const db = await historyDatabase(child, fixture, "initial", { schemas: false });
          await db.migrator.query<Record<string, unknown>>(setup);
          assert.deepEqual(await runHistoryMigration(db, "production"), {
            ok: true,
            history: "empty",
          });
          await assertCompletedHistory(db);
          assert.deepEqual(await runHistoryMigration(db), { ok: true, history: "completed" });
          await assert.rejects(
            db.app.query<Record<string, unknown>>("CREATE TABLE occ.unexpected(id integer)"),
            {
              code: "42501",
            },
          );
          await assert.rejects(
            db.app.query<Record<string, unknown>>("SELECT * FROM drizzle.__drizzle_migrations"),
            {
              code: "42501",
            },
          );
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
          [
            "owner-grant-option",
            `GRANT USAGE ON SCHEMA ${schema} TO occ_migrator WITH GRANT OPTION`,
          ],
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
        ] satisfies readonly SetupCase<string>[]) {
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
      ] satisfies readonly SetupCase<(database: string) => string>[]) {
        void context.test(label, async (child) => {
          const db = await historyDatabase(child, fixture, "roles");
          await historyAdmin(db, db.name, setup(db.name));
          await assertHistoryRefused(db);
        });
      }
    },
  );
}
