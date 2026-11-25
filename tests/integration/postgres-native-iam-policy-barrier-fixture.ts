import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { AuditEvent, Installation, Namespace } from "@openclaw-enterprise/contracts";
import type { Pool } from "pg";
import type {
  EnqueueWork,
  PlatformUnitOfWork,
  PostgresWorkQueue,
} from "../../packages/occ/src/index.ts";

const tables = [
  "iam_identities",
  "iam_roles",
  "iam_groups",
  "iam_group_memberships",
  "iam_access_bindings",
  "iam_restrictions",
] as const;

interface FixtureTarget {
  appUrl: string;
  migrationUrl: string;
  fixtureDatabase: string;
  ciFixtureRequested: boolean;
}

interface DatabaseIdentityRow {
  role: string;
  database: string;
  rolsuper: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolbypassrls: boolean;
}

interface TablePrivilegeRow {
  name: (typeof tables)[number];
  can_insert: boolean;
  can_update: boolean;
  can_delete: boolean;
  can_truncate: boolean;
}

type InstallationRow = Pick<Installation, "id" | "name">;

interface NamespaceWorkInput {
  namespace: Namespace;
  work: EnqueueWork;
  audit: AuditEvent;
}

interface NamespaceEffectsRow {
  namespaces: number;
  work: number;
  audit: number;
}

export type BarrierFixture = Awaited<ReturnType<typeof createBarrierFixture>>;

export async function createBarrierFixture(
  context: TestContext,
  { appUrl, migrationUrl, fixtureDatabase, ciFixtureRequested }: FixtureTarget,
) {
  const [{ Pool }, { PostgresPlatformState }] = await Promise.all([
    import("pg"),
    import("../../packages/occ/src/state/postgres-state.ts"),
  ]);
  const app = new Pool({ connectionString: appUrl, max: 4, connectionTimeoutMillis: 3000 });
  const migrator = new Pool({
    connectionString: migrationUrl,
    max: 1,
    connectionTimeoutMillis: 3000,
  });
  context.after(async () => {
    try {
      if (!ciFixtureRequested) {
        // Standalone mode shares the local development database, which is
        // not dropped afterwards. Remove the unregistered supplier and the
        // privilege probe so the next run starts without them and the
        // migration catalog preflight still matches.
        await migrator.query(`DROP FUNCTION IF EXISTS occ.native_iam_policy_barrier(text, boolean);
            DROP TABLE IF EXISTS occ.native_iam_barrier_privilege_probe`);
      }
    } finally {
      await Promise.all([app.end(), migrator.end()]);
    }
  });
  const identityQuery = `SELECT current_user AS role, current_database() AS database,
      rolsuper, rolcreaterole, rolcreatedb, rolbypassrls
      FROM pg_roles WHERE rolname = current_user`;
  const [appIdentity] = (await app.query<DatabaseIdentityRow>(identityQuery)).rows;
  const [migrationIdentity] = (await migrator.query<DatabaseIdentityRow>(identityQuery)).rows;
  assert.ok(appIdentity);
  assert.ok(migrationIdentity);
  assert.equal(appIdentity.role, "occ_app");
  assert.equal(migrationIdentity.role, "occ_migrator");
  assert.equal(appIdentity.database, fixtureDatabase);
  assert.equal(migrationIdentity.database, fixtureDatabase);
  assert.equal(appIdentity.database, migrationIdentity.database);
  for (const identity of [appIdentity, migrationIdentity]) {
    assert.equal(identity.rolsuper, false);
    assert.equal(identity.rolcreaterole, false);
    assert.equal(identity.rolcreatedb, false);
    assert.equal(identity.rolbypassrls, false);
  }
  const tablePrivileges = async () =>
    (
      await app.query<TablePrivilegeRow>(
        `SELECT name, has_table_privilege(current_user, 'occ.' || name, 'INSERT') AS can_insert,
            has_table_privilege(current_user, 'occ.' || name, 'UPDATE') AS can_update,
            has_table_privilege(current_user, 'occ.' || name, 'DELETE') AS can_delete,
            has_table_privilege(current_user, 'occ.' || name, 'TRUNCATE') AS can_truncate
            FROM unnest($1::text[]) AS name ORDER BY name`,
        [tables],
      )
    ).rows;
  const beforePrivileges = await tablePrivileges();
  const fixtureName = "Native IAM barrier fixture";
  const existingInstallations = (
    await app.query<InstallationRow>("SELECT id, name FROM occ.installation")
  ).rows;
  const [existingInstallation] = existingInstallations;
  // The installation row cannot be deleted, so a repeated standalone run
  // reuses the row an earlier run of this test created. Any other existing
  // installation still refuses the shared database.
  const reusable =
    !ciFixtureRequested &&
    existingInstallations.length === 1 &&
    existingInstallation?.name === fixtureName;
  if (!reusable) {
    assert.equal(existingInstallations.length, 0);
  }
  const state = new PostgresPlatformState(app);
  const installation = reusable
    ? existingInstallation
    : await state.transact((unit) =>
        unit.installations.createInstallation({
          id: `ins_${randomUUID()}`,
          name: fixtureName,
          createdAt: new Date().toISOString(),
        }),
      );

  const namespaceWork = (): NamespaceWorkInput => {
    const namespaceId = `ns_${randomUUID()}`;
    return {
      namespace: {
        id: namespaceId,
        name: `Policy queue ${randomUUID()}`,
        status: "provisioning",
        createdAt: new Date().toISOString(),
      },
      work: {
        idempotencyKey: `namespace:${namespaceId}:ready`,
        namespaceId,
        namespaceTarget: "ready",
        actorId: "policy-queue-test",
      },
      audit: {
        schemaVersion: 1,
        id: `aud_${randomUUID()}`,
        installationId: installation.id,
        occurredAt: new Date().toISOString(),
        source: "occ",
        kind: "mutation",
        actorId: "policy-queue-test",
        actor: { principalId: "policy-queue-test" },
        action: "openclaw.namespaces.create",
        namespaceId,
        resource: { kind: "namespace", id: namespaceId, namespaceId },
        outcome: "success",
      },
    };
  };
  const enqueueNamespace = async (
    unit: Pick<PlatformUnitOfWork, "namespaces" | "audit">,
    queue: Pick<PostgresWorkQueue, "enqueue">,
    input: NamespaceWorkInput,
  ) => {
    await unit.namespaces.createNamespace(input.namespace);
    const work = await queue.enqueue(input.work);
    await unit.audit.append(input.audit);
    assert.equal(work.idempotencyKey, input.work.idempotencyKey);
    assert.equal(work.state, "queued");
    return work.idempotencyKey;
  };
  const effects = async (client: Pick<Pool, "query">, input: NamespaceWorkInput) => {
    const [row] = (
      await client.query<NamespaceEffectsRow>(
        `SELECT
            (SELECT count(*)::integer FROM occ.namespaces WHERE id = $1) AS namespaces,
            (SELECT count(*)::integer FROM occ.controller_work WHERE idempotency_key = $2) AS work,
            (SELECT count(*)::integer FROM occ.audit_events WHERE id = $3) AS audit`,
        [input.namespace.id, input.work.idempotencyKey, input.audit.id],
      )
    ).rows;
    assert.ok(row);
    return row;
  };

  return {
    app,
    migrator,
    state,
    installation,
    tables,
    tablePrivileges,
    beforePrivileges,
    namespaceWork,
    enqueueNamespace,
    effects,
  };
}
