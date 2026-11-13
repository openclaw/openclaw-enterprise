import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { TestContext } from "node:test";
import type { AuthorizationRequest } from "@openclaw-enterprise/contracts";
import type { PoolClient } from "pg";
import type { BarrierFixture } from "./postgres-native-iam-policy-barrier-fixture.ts";

interface SupplierMetadataRow {
  prosecdef: boolean;
  proconfig: string[] | null;
  owner: string;
  app_execute: boolean;
  public_execute: boolean;
}

function isBarrierUpgradeError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "25001";
}

export async function runBarrierAuthorityCases(
  context: TestContext,
  fixture: BarrierFixture,
): Promise<string> {
  const {
    app,
    migrator,
    state,
    installation,
    tablePrivileges,
    beforePrivileges,
    namespaceWork,
    enqueueNamespace,
    effects,
  } = fixture;

  await context.test("policy queue fails closed before the supplier is installed", async () => {
    const [supplier] = (
      await app.query<{ supplier: string | null }>(
        "SELECT to_regprocedure('occ.native_iam_policy_barrier(text,boolean)') AS supplier",
      )
    ).rows;
    assert.equal(supplier?.supplier, null);
    const input = namespaceWork();
    let called = false;
    await assert.rejects(
      state.transactWithNativeIAMPolicyQueue(installation.id, async (unit, queue) => {
        called = true;
        return enqueueNamespace(unit, queue, input);
      }),
      { code: "42883" },
    );
    assert.equal(called, false);
    assert.deepEqual(await effects(app, input), { namespaces: 0, work: 0, audit: 0 });
    await assert.rejects(
      state.transactWithNativeIAMAuthority(installation.id, "write", (unit) =>
        state.guardNativeIAMPolicyInTransaction(unit, installation.id, "write"),
      ),
      { code: "42883" },
    );

    // Ordinary queue transactions remain usable on the existing migrated
    // profile, without installing the opt-in barrier or selecting a Driver.
    await state.transactWithQueue((unit, queue) => enqueueNamespace(unit, queue, input));
    assert.deepEqual(await effects(app, input), { namespaces: 1, work: 1, audit: 1 });
  });

  const supplier = await readFile(
    new URL("../../sql-suppliers/native-iam-policy-barrier.sql", import.meta.url),
    "utf8",
  );
  await migrator.query(supplier);
  const [metadata] = (
    await migrator.query<SupplierMetadataRow>(`SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
      has_function_privilege('occ_app', p.oid, 'EXECUTE') AS app_execute,
      EXISTS (SELECT 1 FROM aclexplode(p.proacl) WHERE grantee = 0 AND privilege_type = 'EXECUTE')
        AS public_execute
      FROM pg_proc p WHERE p.oid = 'occ.native_iam_policy_barrier(text,boolean)'::regprocedure`)
  ).rows;
  assert.ok(metadata);
  assert.equal(metadata.owner, "occ_migrator");
  assert.equal(metadata.prosecdef, true);
  assert.deepEqual(metadata.proconfig, ["search_path=pg_catalog, pg_temp"]);
  assert.equal(metadata.app_execute, true);
  assert.equal(metadata.public_execute, false);
  assert.deepEqual(await tablePrivileges(), beforePrivileges);

  const key = `native-account-security-v1:${installation.id}`;
  // A caller-controlled temporary catalog must not supply privileged lock evidence.
  await migrator.query(`CREATE TABLE occ.native_iam_barrier_privilege_probe(actor pg_catalog.name NOT NULL);
    ALTER TABLE occ.native_iam_barrier_privilege_probe OWNER TO occ_migrator;
    REVOKE ALL ON occ.native_iam_barrier_privilege_probe FROM PUBLIC, occ_app`);
  const attacker = await app.connect();
  try {
    await attacker.query(`CREATE FUNCTION pg_temp.observe_catalog() RETURNS boolean LANGUAGE plpgsql AS $probe$
      BEGIN INSERT INTO occ.native_iam_barrier_privilege_probe VALUES(current_user); RETURN true; END $probe$;
      GRANT EXECUTE ON FUNCTION pg_temp.observe_catalog() TO occ_migrator;
      CREATE TEMP TABLE fake_lock(locktype text, pid integer, database oid, classid oid,
        objid oid, objsubid smallint, granted boolean, mode text, relation oid);
      GRANT SELECT ON pg_temp.fake_lock TO occ_migrator;
      CREATE TEMP VIEW pg_locks WITH (security_invoker = true) AS
        SELECT * FROM pg_temp.fake_lock WHERE pg_temp.observe_catalog();
      GRANT SELECT ON pg_temp.pg_locks TO occ_migrator`);
    await attacker.query(
      `INSERT INTO pg_temp.fake_lock
      SELECT 'advisory', pg_catalog.pg_backend_pid(),
        (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()),
        ((pg_catalog.hashtextextended($1, 0) >> 32) & 4294967295)::pg_catalog.oid,
        (pg_catalog.hashtextextended($1, 0) & 4294967295)::pg_catalog.oid,
        1, true, 'ExclusiveLock', NULL::pg_catalog.oid`,
      [key],
    );
    await assert.rejects(
      attacker.query("SELECT occ.native_iam_policy_barrier($1, true)", [installation.id]),
      { code: "55000" },
    );
    await attacker.query("BEGIN");
    try {
      await attacker.query(
        "SELECT pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended($1, 0))",
        [key],
      );
      await assert.rejects(
        attacker.query("SELECT occ.native_iam_policy_barrier($1, true)", [installation.id]),
        { code: "55000" },
      );
    } finally {
      await attacker.query("ROLLBACK");
    }
    await attacker.query("BEGIN");
    try {
      await attacker.query(
        "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
        [key],
      );
      await attacker.query("SELECT occ.native_iam_policy_barrier($1, true)", [installation.id]);
      await attacker.query("COMMIT");
    } catch (error) {
      await attacker.query("ROLLBACK").catch(() => {});
      throw error;
    }
    const [probe] = (
      await migrator.query<{ n: string }>(
        "SELECT count(*) AS n FROM occ.native_iam_barrier_privilege_probe",
      )
    ).rows;
    assert.ok(probe);
    assert.equal(Number(probe.n), 0);
  } finally {
    attacker.release(true);
  }
  await assert.rejects(
    app.query("SELECT occ.native_iam_policy_barrier($1, false)", [installation.id]),
    { code: "55000" },
  );
  await assert.rejects(
    app.query("SELECT occ.native_iam_policy_barrier($1, NULL)", [installation.id]),
    { code: "22023" },
  );

  const conflicting = await app.connect();
  try {
    await conflicting.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    try {
      await assert.rejects(
        conflicting.query("SELECT occ.native_iam_policy_barrier($1, false)", [installation.id]),
        { code: "25000" },
      );
    } finally {
      await conflicting.query("ROLLBACK");
    }
    const otherId = `ins_${randomUUID()}`;
    await conflicting.query("BEGIN");
    try {
      await conflicting.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `native-account-security-v1:${otherId}`,
      ]);
      await assert.rejects(
        conflicting.query("SELECT occ.native_iam_policy_barrier($1, true)", [otherId]),
        { code: "23514" },
      );
    } finally {
      await conflicting.query("ROLLBACK");
    }

    // Exercise the existing native evaluator against persisted policy read on
    // this exact State unit, rather than the driver's separate read transaction.
    const { evaluateAuthorization, NativeIAMDriver } =
      await import("../../packages/iam/src/index.ts");
    const principalId = `principal_${randomUUID()}`;
    const retainedPrincipalId = `principal_${randomUUID()}`;
    const roleId = `role_${randomUUID()}`;
    const bindingId = `binding_${randomUUID()}`;
    const retainedBindingId = `binding_${randomUUID()}`;
    await app.query(
      "INSERT INTO occ.iam_identities(id, kind, issuer, subject) VALUES($1, 'principal', 'fixture', $1)",
      [principalId],
    );
    await app.query(
      "INSERT INTO occ.iam_identities(id, kind, issuer, subject) VALUES($1, 'principal', 'fixture', $1)",
      [retainedPrincipalId],
    );
    await app.query("INSERT INTO occ.iam_roles(id, permissions) VALUES($1, $2::jsonb)", [
      roleId,
      JSON.stringify([{ action: "administer", resourceKind: "installation" }]),
    ]);
    const insertBinding = () =>
      app.query(
        "INSERT INTO occ.iam_access_bindings(id, identity_subject_id, role_id) VALUES($1, $2, $3)",
        [bindingId, principalId, roleId],
      );
    await insertBinding();
    // Keep a different principal's grant so that revoking the subject under
    // test leaves a valid, complete persisted policy instead of deleting the
    // Installation's final binding.
    await app.query(
      "INSERT INTO occ.iam_access_bindings(id, identity_subject_id, role_id) VALUES($1, $2, $3)",
      [retainedBindingId, retainedPrincipalId, roleId],
    );
    const request: AuthorizationRequest = {
      principalId,
      action: "administer",
      resource: { kind: "installation", id: installation.id },
    };
    const driver = new NativeIAMDriver(state);
    assert.equal((await driver.authorize(request)).allowed, true);
    assert.equal(
      (await conflicting.query("DELETE FROM occ.iam_access_bindings WHERE id = $1", [bindingId]))
        .rowCount,
      1,
    );
    const decisionInOriginalUnit = () =>
      state.transactWithNativeIAMAuthority(installation.id, "read", async (unit) => {
        await state.guardNativeIAMPolicyInTransaction(unit, installation.id, "read");
        const snapshot = await state.loadNativeIAMStateInTransaction(unit, installation.id);
        return evaluateAuthorization(request, snapshot, driver.id);
      });
    assert.equal((await decisionInOriginalUnit()).allowed, false);
    await insertBinding();
    await state.transactWithNativeIAMAuthority(installation.id, "read", async (unit) => {
      await state.guardNativeIAMPolicyInTransaction(unit, installation.id, "read");
      const snapshot = await state.loadNativeIAMStateInTransaction(unit, installation.id);
      assert.equal(evaluateAuthorization(request, snapshot, driver.id).allowed, true);
      await conflicting.query("BEGIN");
      try {
        await conflicting.query("SET LOCAL lock_timeout = '250ms'");
        await assert.rejects(
          conflicting.query("DELETE FROM occ.iam_access_bindings WHERE id = $1", [bindingId]),
          { code: "55P03" },
        );
      } finally {
        await conflicting.query("ROLLBACK");
      }
    });
    assert.equal(
      (await conflicting.query("DELETE FROM occ.iam_access_bindings WHERE id = $1", [bindingId]))
        .rowCount,
      1,
    );
    assert.equal((await decisionInOriginalUnit()).allowed, false);

    await assert.rejects(
      state.transactWithNativeIAMAuthority(installation.id, "read", async (unit) => {
        await state.guardNativeIAMPolicyInTransaction(unit, installation.id, "write");
      }),
      { name: "ScopeViolationError" },
    );
    await assert.rejects(
      state.transactWithNativeIAMAuthority(installation.id, "write", async (unit) => {
        await state.guardNativeIAMPolicyInTransaction(unit, installation.id, "read");
        await state.guardNativeIAMPolicyInTransaction(unit, installation.id, "write");
      }),
      (error: unknown) =>
        isBarrierUpgradeError(error) ||
        (error instanceof Error && isBarrierUpgradeError(error.cause)),
    );
    await assert.rejects(
      state.transactWithNativeIAMAuthority(installation.id, "write", async (unit) => {
        await state.guardNativeIAMPolicyInTransaction(unit, installation.id, "write");
        await conflicting.query("BEGIN");
        try {
          await conflicting.query("SET LOCAL lock_timeout = '250ms'");
          await assert.rejects(
            conflicting.query(
              "INSERT INTO occ.iam_restrictions SELECT * FROM occ.iam_restrictions WHERE FALSE",
            ),
            { code: "55P03" },
          );
        } finally {
          await conflicting.query("ROLLBACK");
        }
        throw new Error("abort policy barrier");
      }),
      /abort policy barrier/,
    );
    assert.equal(
      (
        await conflicting.query(
          "INSERT INTO occ.iam_restrictions SELECT * FROM occ.iam_restrictions WHERE FALSE",
        )
      ).rowCount,
      0,
    );
  } finally {
    conflicting.release();
  }

  const owner = await app.connect();
  let observer: PoolClient | undefined;
  try {
    observer = await app.connect();
    await owner.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [key]);
    await owner.query("BEGIN");
    await owner.query("SELECT occ.native_iam_policy_barrier($1, true)", [installation.id]);
    await owner.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
    // The supplier retains the advisory lock until the transaction ends, even
    // after the owner releases its session lock.
    const [beforeRollback] = (
      await observer.query<{ held: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS held",
        [key],
      )
    ).rows;
    assert.equal(beforeRollback?.held, false);
    await owner.query("ROLLBACK");
    const [afterRollback] = (
      await observer.query<{ held: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS held",
        [key],
      )
    ).rows;
    assert.equal(afterRollback?.held, true);
  } finally {
    await owner.query("ROLLBACK").catch(() => {});
    await owner.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]).catch(() => {});
    owner.release(true);
    observer?.release(true);
  }

  return key;
}
