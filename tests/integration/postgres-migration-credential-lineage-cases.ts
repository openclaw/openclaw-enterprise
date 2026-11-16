import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { type TestContext, type TestOptions } from "node:test";
import pg, { type Client, type Pool } from "pg";
import type { initialSchemaState, migrationCatalog } from "../../scripts/migration-catalog.ts";
import type { migrateWithHistory } from "../../scripts/migration-history.mjs";
import { repositoryCredentials } from "../fixtures/repository-credentials/session-state.ts";
import type {
  MigrationDefaultAcl,
  MigrationReceipt,
} from "./postgres-migration-transaction-command-cases.ts";

type HistoryFixture = {
  admin: Pool;
  adminUrl: string;
  migrationUrl: string;
  databasePrefix: string;
};

type HistoryDatabase = {
  migrationUrl: string;
  app: Client;
  migrator: Client;
};

type ProviderHistoryDependencies = {
  requiresHistoryPostgres: Pick<TestOptions, "skip">;
  migrationHistoryFixture: () => Promise<HistoryFixture>;
  historyDatabase: (
    context: TestContext,
    fixture: HistoryFixture,
    label: string,
    options?: { prefix?: number },
  ) => Promise<HistoryDatabase>;
  installProviderCompletedHistory: (db: Pick<HistoryDatabase, "migrator">) => Promise<void>;
};

type MigrationResult =
  | { ok: true; history: Awaited<ReturnType<typeof migrateWithHistory>> }
  | {
      ok: false;
      code: "MIGRATION_HISTORY_UNSUPPORTED" | "MIGRATION_HISTORY_NOT_EMPTY" | "MIGRATION_FAILED";
    };

type HistorySnapshot = {
  receipts: MigrationReceipt[];
  occ: Awaited<ReturnType<typeof migrationCatalog>>;
  drizzle: Awaited<ReturnType<typeof migrationCatalog>>;
  defaultAcls: MigrationDefaultAcl[];
  initialOcc: Awaited<ReturnType<typeof initialSchemaState>>;
  initialDrizzle: Awaited<ReturnType<typeof initialSchemaState>>;
};

type CredentialLineageDependencies = ProviderHistoryDependencies & {
  seedCanonicalData: (
    db: Pick<HistoryDatabase, "app">,
    options: { preset: boolean },
  ) => Promise<string>;
  installCanonicalPrefix: (db: Pick<HistoryDatabase, "migrator">, length: number) => Promise<void>;
  runHistoryMigration: (
    db: Pick<HistoryDatabase, "migrationUrl">,
    mode?: "development" | "production",
    flag?: "--check" | "--expect-empty",
    refusal?: RegExp,
    assertFailure?: (error: unknown) => void,
  ) => Promise<MigrationResult>;
  historyReceipts: (client: Client) => Promise<MigrationReceipt[]>;
  historySnapshot: (db: Pick<HistoryDatabase, "migrator">) => Promise<HistorySnapshot>;
  assertCompletedHistory: (
    db: Pick<HistoryDatabase, "app" | "migrator">,
    previous: readonly MigrationReceipt[],
  ) => Promise<void>;
};

type NoRows = Record<string, never>;
type ColumnRow = { table_name: string; column_name: string };

async function seedProviderCompletedData(db: Pick<HistoryDatabase, "app" | "migrator">) {
  const installation = `ins_${randomUUID()}`;
  const namespace = `ns_${randomUUID()}`;
  const configuration = `cfg_${randomUUID()}`;
  const agent = `agt_${randomUUID()}`;
  const revision = `rev_${randomUUID()}`;
  const serviceAccount = `sa_${randomUUID()}`;
  const preset = `pre_${randomUUID()}`;
  const admission = `admission-${randomUUID()}`;
  const servicePrincipal = `service-agent-${agent}`;
  const fingerprint = createHash("sha256").update(`provider-plan-${randomUUID()}`).digest("hex");
  await db.app.query<NoRows, [string]>(
    "INSERT INTO occ.installation(id,name,created_at) VALUES($1,'Provider fixture',now())",
    [installation],
  );
  await db.app.query<NoRows, [string, string]>(
    "INSERT INTO occ.namespaces(id,name,status,created_at) VALUES($1,$2,'ready',now())",
    [namespace, `provider-${randomUUID()}`],
  );
  await db.app.query<NoRows, [string, string, string]>(
    `INSERT INTO occ.presets(id,namespace_id,name,template,created_at)
     VALUES($1,$2,'Provider preset',$3::jsonb,now())`,
    [
      preset,
      namespace,
      JSON.stringify({ agent: { name: "Provider preset agent", providerId: "openai" } }),
    ],
  );
  await db.app.query<NoRows, []>("BEGIN");
  try {
    await db.app.query<NoRows, [string, string]>(
      "INSERT INTO occ.configurations(id,namespace_id,kind,generation,created_at) VALUES($1,$2,'agent',1,now())",
      [configuration, namespace],
    );
    await db.app.query<NoRows, [string, string]>(
      "INSERT INTO occ.service_accounts(id,namespace_id,name,credential) VALUES($1,$2,'Provider account',NULL)",
      [serviceAccount, namespace],
    );
    await db.app.query<NoRows, [string, string, string]>(
      "INSERT INTO occ.iam_identities(id,namespace_id,agent_id,kind) VALUES($1,$2,$3,'service_principal')",
      [servicePrincipal, namespace, agent],
    );
    await db.app.query<NoRows, [string, string, string, string, string]>(
      `INSERT INTO occ.agents
        (id, namespace_id, name, configuration_id, provider_id, execution_mode,
         service_principal_id, harness_auth, created_at)
       VALUES($1,$2,'Provider agent',$3,'openai','dedicated',$4,$5::jsonb,now())`,
      [
        agent,
        namespace,
        configuration,
        servicePrincipal,
        JSON.stringify({ method: "chatgpt_service_account", serviceAccountId: serviceAccount }),
      ],
    );
    await db.app.query<NoRows, [string, string, string, string]>(
      `INSERT INTO occ.agent_revisions
        (id,namespace_id,agent_id,revision_number,provider_id,admitted_spec,admitted_at)
       VALUES($1,$2,$3,1,'openai',$4::jsonb,now())`,
      [
        revision,
        namespace,
        agent,
        JSON.stringify({
          configuration_id: configuration,
          configuration_kind: "agent",
          configuration_generation: 1,
          draft_spec: {},
          harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
          harness_auth: {
            method: "chatgpt_service_account",
            serviceAccountId: serviceAccount,
            credential: { kind: "access_token", secretRef: { name: "svc-token", key: "token" } },
            providerBinding: {
              providerId: "openai",
              driverId: "chatgpt-service-accounts",
              workspaceId: "workspace",
              credentialIssued: true,
            },
          },
          compute: { id: "kubernetes", implementation: "test" },
          repository_credentials: {
            driver: { id: "repository-credentials", implementation: "github" },
            deadlineWallMs: 1,
            bindings: [
              {
                repositoryRef: "openclaw-enterprise",
                profile: "git-write",
                providerId: "repository-provider",
                grant: {
                  providerInstanceId: "github-app",
                  repositoryId: "repo-id",
                  grantId: "grant-id",
                },
              },
            ],
          },
        }),
      ],
    );
    await db.app.query<NoRows, []>("COMMIT");
  } catch (error) {
    await db.app.query<NoRows, []>("ROLLBACK");
    throw error;
  }
  await db.migrator.query<NoRows, [string, string]>(
    `INSERT INTO occ.service_account_driver_bindings
      (service_account_id, namespace_id, provider_id, driver_id, external_account_id, workspace_id)
     VALUES($1,$2,'openai','chatgpt-service-accounts','external-account','workspace')`,
    [serviceAccount, namespace],
  );
  await db.app.query<NoRows, [string]>(
    "UPDATE occ.agents SET desired_runtime_state='running' WHERE id=$1",
    [agent],
  );
  await db.app.query<NoRows, [string, string, string, string]>(
    `INSERT INTO occ.repository_session_attempts
      (namespace_id,agent_id,revision_id,repository_ref,admission_id,duration_seconds,
       deadline_wall_ms,phase,created_at,updated_at)
     VALUES($1,$2,$3,'openclaw-enterprise',$4,60,1,'opening',now(),now())`,
    [namespace, agent, revision, admission],
  );
  const {
    rows: [work],
  } = await db.app.query<{ idempotency_key: string }, [string, string]>(
    `INSERT INTO occ.controller_work
      (idempotency_key,namespace_id,actor_id,work_kind,state,available_at,completed_at,reason_code,created_at,updated_at)
     VALUES($1,$2,'provider-fixture','provisioning','succeeded',now(),now(),'PROVISIONING_SUCCEEDED',now(),now())
     RETURNING idempotency_key`,
    [`work-${randomUUID()}`, namespace],
  );
  assert.ok(work, "Expected the inserted controller work.");
  const workId = work.idempotency_key;
  await db.app.query<NoRows, [string, string, string, string, string, string, string]>(
    `INSERT INTO occ.agent_provisioning_work
      (work_id,namespace_id,agent_id,configuration_id,actor_id,request_id,request_fingerprint,
       status,completed_phase,revision_id,plan,progress,created_at,updated_at)
     VALUES($1,$2,$3,$4,'provider-fixture','request-1',$5,'succeeded','handoff',$6,$7::jsonb,'{}'::jsonb,now(),now())`,
    [
      workId,
      namespace,
      agent,
      configuration,
      fingerprint,
      revision,
      JSON.stringify({
        name: "Provider agent",
        providerId: "openai",
        executionMode: "dedicated",
        configuration: { kind: "agent", values: {} },
        harnessAuth: { method: "chatgpt_service_account", serviceAccountId: serviceAccount },
        repositoryBindings: [{ repositoryRef: "openclaw-enterprise", profile: "git-write" }],
        drivers: {
          compute: "compute-kubernetes",
          configuration: "config-kubernetes",
          iam: "native-iam",
        },
      }),
    ],
  );
  return {
    namespace,
    agent,
    revision,
    serviceAccount,
    preset,
    admission,
    workId,
    fingerprint,
  };
}

export function registerPostgresMigrationCredentialLineageCases({
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
}: CredentialLineageDependencies): void {
  test(
    "Canonical repository-prefix upgrade retains exact attempt cleanup context",
    requiresHistoryPostgres,
    async (context) => {
      const fixture = await migrationHistoryFixture();
      const db = await historyDatabase(context, fixture, "repository", { prefix: 27 });
      const namespaceId = await seedCanonicalData(db, { preset: true });
      const snapshot = repositoryCredentials();
      const [binding] = snapshot.bindings;
      assert.ok(binding, "Expected a repository binding in the historical revision.");
      const revisionId = `rev_${randomUUID()}`;
      const admissionId = `admission-${randomUUID()}`;
      const {
        rows: [revision],
      } = await db.app.query<{ agent_id: string }, [string, string, string]>(
        `INSERT INTO occ.agent_revisions (id,namespace_id,agent_id,revision_number,admitted_spec,backend_id,admitted_at)
       SELECT $2,namespace_id,agent_id,2,admitted_spec || jsonb_build_object('repository_credentials',$3::jsonb),backend_id,now()
       FROM occ.agent_revisions WHERE namespace_id=$1 RETURNING agent_id`,
        [namespaceId, revisionId, JSON.stringify(snapshot)],
      );
      assert.ok(revision, "Expected the revision's owning Agent.");
      const owner = revision.agent_id;
      await db.app.query<NoRows, [string]>(
        "UPDATE occ.agents SET desired_runtime_state='running' WHERE id=$1",
        [owner],
      );
      await db.app.query<NoRows, [string, string, string, string, string, number]>(
        `INSERT INTO occ.repository_session_attempts
       (namespace_id,agent_id,revision_id,repository_ref,admission_id,duration_seconds,deadline_wall_ms,phase,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,60,$6,'opening',now(),now())`,
        [
          namespaceId,
          owner,
          revisionId,
          binding.repositoryRef,
          admissionId,
          snapshot.deadlineWallMs,
        ],
      );
      const attemptRows = () =>
        db.app.query<{ value: unknown }, []>(
          "SELECT to_jsonb(attempt) AS value FROM occ.repository_session_attempts AS attempt",
        );
      const { rows: before } = await attemptRows();
      assert.equal(before.length, 1);
      const receipts = await historyReceipts(db.migrator);
      assert.deepEqual(await runHistoryMigration(db, "production", "--check"), {
        ok: true,
        history: "repositoryCredentials",
      });
      assert.deepEqual(await runHistoryMigration(db), {
        ok: true,
        history: "repositoryCredentials",
      });
      await assertCompletedHistory(db, receipts);
      const { rows: retained } = await attemptRows();
      assert.deepEqual(
        retained,
        before.map(({ value }) => {
          assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
          return {
            value: {
              ...value,
              broker_protocol: 0,
              live_revision_id: revisionId,
              cleanup_context: { driver: snapshot.driver, binding },
              // Upgrading this attempt must not turn it into a successor of another session.
              predecessor_admission_id: null,
              execution_fingerprint: null,
            },
          };
        }),
      );
      assert.deepEqual(await runHistoryMigration(db, "production"), {
        ok: true,
        history: "completed",
      });
    },
  );

  test(
    "Provider migration preserves fingerprints and rejects retired managed PAT bindings",
    requiresHistoryPostgres,
    async (context) => {
      const fixture = await migrationHistoryFixture();
      const db = await historyDatabase(context, fixture, "providerlineage");
      await installProviderCompletedHistory(db);
      const seeded = await seedProviderCompletedData(db);
      const receipts = await historyReceipts(db.migrator);
      assert.equal(receipts.length, 31);
      assert.deepEqual(await runHistoryMigration(db, "production", "--check"), {
        ok: true,
        history: "providerCompleted",
      });
      // Preserve the historical terminology migration proof through its supported auth shape.
      // The canonical PAT-source migration must then refuse the retired binding atomically.
      await installCanonicalPrefix(db, 48);
      assert.deepEqual((await historyReceipts(db.migrator)).slice(0, receipts.length), receipts);
      assert.deepEqual(
        (
          await db.app.query<{ backendId: string; harnessAuth: unknown }, [string, string]>(
            `SELECT backend_id AS "backendId", harness_auth AS "harnessAuth"
             FROM occ.agents WHERE namespace_id=$1 AND id=$2`,
            [seeded.namespace, seeded.agent],
          )
        ).rows,
        [
          {
            backendId: "openai",
            harnessAuth: {
              method: "chatgpt_service_account",
              serviceAccountId: seeded.serviceAccount,
            },
          },
        ],
      );
      const revision = (
        await db.app.query<
          {
            backendId: string;
            backendBinding: unknown;
            providerBinding: unknown;
            repositoryBackendId: unknown;
            repositoryProviderId: unknown;
          },
          [string, string]
        >(
          `SELECT backend_id AS "backendId",
                  admitted_spec #> '{harness_auth,backendBinding}' AS "backendBinding",
                  admitted_spec #> '{harness_auth,providerBinding}' AS "providerBinding",
                  admitted_spec #> '{repository_credentials,bindings,0,backendId}' AS "repositoryBackendId",
                  admitted_spec #> '{repository_credentials,bindings,0,providerId}' AS "repositoryProviderId"
           FROM occ.agent_revisions WHERE namespace_id=$1 AND id=$2`,
          [seeded.namespace, seeded.revision],
        )
      ).rows[0];
      assert.deepEqual(revision, {
        backendId: "openai",
        backendBinding: {
          backendId: "openai",
          driverId: "chatgpt-service-accounts",
          workspaceId: "workspace",
          credentialIssued: true,
        },
        providerBinding: null,
        repositoryBackendId: "repository-provider",
        repositoryProviderId: null,
      });
      assert.deepEqual(
        (
          await db.migrator.query<{ backendId: string }, [string, string]>(
            `SELECT backend_id AS "backendId" FROM occ.service_account_driver_bindings
             WHERE namespace_id=$1 AND service_account_id=$2`,
            [seeded.namespace, seeded.serviceAccount],
          )
        ).rows,
        [{ backendId: "openai" }],
      );
      assert.deepEqual(
        (
          await db.app.query<
            {
              requestFingerprint: string;
              backendId: string | null;
              hasProviderId: boolean;
            },
            [string]
          >(
            `SELECT request_fingerprint AS "requestFingerprint",
                    plan->>'backendId' AS "backendId",
                    plan ? 'providerId' AS "hasProviderId"
             FROM occ.agent_provisioning_work WHERE work_id=$1`,
            [seeded.workId],
          )
        ).rows,
        [{ requestFingerprint: seeded.fingerprint, backendId: "openai", hasProviderId: false }],
      );
      assert.deepEqual(
        (
          await db.app.query<{ backendId: string | null; providerId: unknown }, [string, string]>(
            `SELECT template #>> '{agent,backendId}' AS "backendId",
                    template #> '{agent,providerId}' AS "providerId"
             FROM occ.presets WHERE namespace_id=$1 AND id=$2`,
            [seeded.namespace, seeded.preset],
          )
        ).rows,
        [{ backendId: "openai", providerId: null }],
      );
      assert.deepEqual(
        (
          await db.app.query<{ backendId: string | null; providerId: unknown }, [string]>(
            `SELECT cleanup_context #>> '{binding,backendId}' AS "backendId",
                    cleanup_context #> '{binding,providerId}' AS "providerId"
             FROM occ.repository_session_attempts WHERE admission_id=$1`,
            [seeded.admission],
          )
        ).rows,
        [{ backendId: "repository-provider", providerId: null }],
      );
      assert.deepEqual(
        (
          await db.migrator.query<ColumnRow, []>(
            `SELECT table_name,column_name FROM information_schema.columns
            WHERE table_schema='occ'
              AND table_name IN ('agents','agent_revisions','service_account_driver_bindings')
              AND column_name='provider_id'
            ORDER BY table_name,column_name`,
          )
        ).rows,
        [],
      );
      assert.deepEqual(
        (
          await db.migrator.query<ColumnRow, []>(
            `SELECT table_name,column_name FROM information_schema.columns
            WHERE table_schema='occ' AND table_name='account' AND column_name='provider_id'`,
          )
        ).rows,
        [{ table_name: "account", column_name: "provider_id" }],
      );
      assert.deepEqual(await runHistoryMigration(db, "production", "--check"), {
        ok: true,
        history: "preCodexPatSources",
      });
      const beforeRefusal = await historySnapshot(db);
      assert.deepEqual(
        await runHistoryMigration(db, "production", undefined, undefined, (error) => {
          const databaseError =
            error instanceof pg.DatabaseError
              ? error
              : error instanceof Error
                ? error.cause
                : undefined;
          assert.ok(databaseError instanceof pg.DatabaseError);
          assert.equal(databaseError.code, "23514");
          assert.match(databaseError.message, /^Unsupported legacy managed PAT authentication:/);
        }),
        { ok: false, code: "MIGRATION_FAILED" },
      );
      assert.deepEqual(await historySnapshot(db), beforeRefusal);
    },
  );
}

export function registerPostgresMigrationCredentialLineageRefusalCase({
  requiresHistoryPostgres,
  migrationHistoryFixture,
  historyDatabase,
  installProviderCompletedHistory,
  assertHistoryRefused,
}: ProviderHistoryDependencies & {
  assertHistoryRefused: (
    db: Pick<HistoryDatabase, "migrator" | "migrationUrl">,
    refusal: RegExp,
  ) => Promise<void>;
}): void {
  test(
    "Canonical migration refuses ambiguous Provider and Backend data before mutation",
    requiresHistoryPostgres,
    async (context) => {
      const fixture = await migrationHistoryFixture();
      const db = await historyDatabase(context, fixture, "ambiguousprovider");
      await installProviderCompletedHistory(db);
      const seeded = await seedProviderCompletedData(db);
      await db.migrator.query<NoRows, [string, string]>(
        `UPDATE occ.presets
         SET template=jsonb_set(template,'{agent,backendId}','"openai"'::jsonb,true)
         WHERE namespace_id=$1 AND id=$2`,
        [seeded.namespace, seeded.preset],
      );
      const presetRows = () =>
        db.migrator.query<{ template: unknown }, [string]>(
          "SELECT template FROM occ.presets WHERE id=$1",
          [seeded.preset],
        );
      const { rows: before } = await presetRows();
      assert.equal(before.length, 1);
      await assertHistoryRefused(db, /Provider and Backend terminology data is ambiguous/);
      assert.deepEqual((await presetRows()).rows, before);
    },
  );
}
