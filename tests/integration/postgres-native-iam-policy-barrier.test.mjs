import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const ciFixtureRequested = [
  process.env.OCC_TEST_NATIVE_IAM_BARRIER_CI,
  process.env.OCC_TEST_NATIVE_IAM_BARRIER_DATABASE,
  process.env.OCC_TEST_NATIVE_IAM_BARRIER_MIGRATION_DATABASE_URL,
].some((value) => value !== undefined);
const enabled = process.env.OCC_NATIVE_IAM_BARRIER_TEST === "1" || ciFixtureRequested;
const appUrl = process.env.OCC_TEST_DATABASE_URL;
const migrationUrl = ciFixtureRequested
  ? process.env.OCC_TEST_NATIVE_IAM_BARRIER_MIGRATION_DATABASE_URL
  : process.env.OCC_MIGRATION_DATABASE_URL;
const fixtureDatabase = ciFixtureRequested
  ? process.env.OCC_TEST_NATIVE_IAM_BARRIER_DATABASE
  : "openclaw_enterprise";
const tables = [
  "iam_identities",
  "iam_roles",
  "iam_groups",
  "iam_group_memberships",
  "iam_access_bindings",
  "iam_restrictions",
];

function requireExplicitCISelection(requested, flag) {
  if (requested && flag !== "1") {
    throw new Error("An owned PostgreSQL fixture requires explicit CI selection.");
  }
}

function fixtureUrls(application, migration, database, mode) {
  if (
    (mode === "standalone" && database !== "openclaw_enterprise") ||
    (mode === "ci" &&
      (typeof database !== "string" ||
        !/^openclaw_ci_postgres_native_iam_policy_barrier_[a-f0-9]{12}$/.test(database))) ||
    (mode !== "standalone" && mode !== "ci")
  ) {
    throw new Error("An owned PostgreSQL fixture has an unsupported database.");
  }
  for (const value of [application, migration]) {
    if (
      typeof value !== "string" ||
      [...value].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 31 || code === 127;
      }) ||
      value.startsWith(" ") ||
      value.endsWith(" ") ||
      value.includes("?") ||
      value.includes("#")
    ) {
      throw new Error("An owned PostgreSQL fixture has an unsupported connection target.");
    }
    const schemeEnd = value.indexOf("://");
    const pathStart = schemeEnd < 0 ? -1 : value.indexOf("/", schemeEnd + 3);
    if (pathStart < 0 || value.slice(pathStart) !== `/${database}`) {
      throw new Error("An owned PostgreSQL fixture has an unsupported connection target.");
    }
  }
  let app;
  let migrator;
  try {
    app = new URL(application);
    migrator = new URL(migration);
  } catch {
    throw new Error("An owned PostgreSQL fixture requires valid connection URLs.");
  }
  for (const [url, role] of [
    [app, "occ_app"],
    [migrator, "occ_migrator"],
  ]) {
    if (
      url.protocol !== "postgresql:" ||
      url.hostname !== "127.0.0.1" ||
      url.port === "" ||
      url.pathname !== `/${database}` ||
      url.username !== role ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("An owned PostgreSQL fixture has an unsupported connection target.");
    }
  }
  if (app.host !== migrator.host || app.pathname !== migrator.pathname) {
    throw new Error("The app and migrator must use the same owned PostgreSQL fixture.");
  }
}

function tupleTransactionId(xid8) {
  return (BigInt(xid8) & 0xffff_ffffn).toString();
}

test("xid8 comparison preserves the tuple transaction ID across epochs", () => {
  const epochOneXid8 = "4294967338";
  const tupleXmin = "42";
  assert.equal(tupleTransactionId("42"), "42");
  assert.notEqual(epochOneXid8, tupleXmin);
  assert.equal(tupleTransactionId(epochOneXid8), tupleXmin);
  assert.equal(tupleTransactionId("8589934591"), "4294967295");
  assert.throws(() => tupleTransactionId("not-an-xid"), SyntaxError);
});

test("native IAM barrier fixture rejects unsafe connection targets before connecting", () => {
  const app = "postgresql://occ_app:synthetic@127.0.0.1:5432/openclaw_enterprise";
  const migrator = "postgresql://occ_migrator:synthetic@127.0.0.1:5432/openclaw_enterprise";
  const ciDatabase = "openclaw_ci_postgres_native_iam_policy_barrier_0123456789ab";
  const ciApp = app.replace("openclaw_enterprise", ciDatabase);
  const ciMigrator = migrator.replace("openclaw_enterprise", ciDatabase);
  assert.doesNotThrow(() => requireExplicitCISelection(false, undefined));
  assert.doesNotThrow(() => requireExplicitCISelection(true, "1"));
  assert.throws(
    () => requireExplicitCISelection(true, undefined),
    /requires explicit CI selection/,
  );
  assert.throws(() => requireExplicitCISelection(true, "0"), /requires explicit CI selection/);
  assert.doesNotThrow(() => fixtureUrls(app, migrator, "openclaw_enterprise", "standalone"));
  assert.doesNotThrow(() => fixtureUrls(ciApp, ciMigrator, ciDatabase, "ci"));
  for (const invalid of [
    app.replace("occ_app", "%6fcc_app"),
    app.replace("synthetic", "synth\tetic"),
    `${app}?`,
    `${app}#`,
    app.replace("127.0.0.1", "localhost"),
    app.replace(":5432", ":5433"),
  ]) {
    assert.throws(
      () => fixtureUrls(invalid, migrator, "openclaw_enterprise", "standalone"),
      /owned PostgreSQL fixture|same owned PostgreSQL fixture/,
    );
  }
  for (const [application, migration, database, mode] of [
    [ciApp, undefined, ciDatabase, "ci"],
    [ciApp, ciMigrator, undefined, "ci"],
    [ciApp, ciMigrator, "openclaw_enterprise", "ci"],
    [ciApp, ciMigrator, ciDatabase.replace("0123456789ab", "INVALID"), "ci"],
    [ciApp, ciMigrator.replace(ciDatabase, `${ciDatabase}x`), ciDatabase, "ci"],
    [ciApp, ciMigrator.replace("occ_migrator", "%6fcc_migrator"), ciDatabase, "ci"],
    [ciApp, ciMigrator.replace(":5432", ":5433"), ciDatabase, "ci"],
    [ciApp, ciMigrator.replace("synthetic", "synth\netic"), ciDatabase, "ci"],
    [ciApp.replace(ciDatabase, "%6f" + ciDatabase.slice(1)), ciMigrator, ciDatabase, "ci"],
    [ciApp, ciMigrator, ciDatabase, "standalone"],
    [ciApp, ciMigrator, ciDatabase, "unknown"],
  ]) {
    assert.throws(
      () => fixtureUrls(application, migration, database, mode),
      /owned PostgreSQL fixture|same owned PostgreSQL fixture/,
    );
  }
  for (const [application, migration, database, mode] of [
    [app, migrator, "openclaw_enterprise", "standalone"],
    [ciApp, ciMigrator, ciDatabase, "ci"],
  ]) {
    const assertSafeRefusal = (nextApp, nextMigration) => {
      assert.throws(
        () => fixtureUrls(nextApp, nextMigration, database, mode),
        (error) => {
          assert.equal(
            error.message,
            "An owned PostgreSQL fixture has an unsupported connection target.",
          );
          assert.equal(error.cause, undefined);
          assert.equal(error.input, undefined);
          assert.equal(error.actual, undefined);
          assert.doesNotMatch(String(error.stack), /synthetic/);
          return true;
        },
      );
    };
    const spacedApplication = application.replace("synthetic", "syn thetic");
    const spacedMigration = migration.replace("synthetic", "syn thetic");
    assert.doesNotThrow(() => fixtureUrls(spacedApplication, migration, database, mode));
    assert.doesNotThrow(() => fixtureUrls(application, spacedMigration, database, mode));

    for (const role of ["application", "migration"]) {
      const selected = role === "application" ? spacedApplication : spacedMigration;
      for (const prefix of ["%2e", "%2E", "%2e%2e", ".", "x/.."]) {
        const invalid = selected.replace(`/${database}`, `/${prefix}/${database}`);
        const nextApp = role === "application" ? invalid : application;
        const nextMigration = role === "migration" ? invalid : migration;
        assertSafeRefusal(nextApp, nextMigration);
      }
    }

    for (const role of ["application", "migration"]) {
      const selected = role === "application" ? application : migration;
      for (const invalid of [` ${selected}`, `${selected} `]) {
        const nextApp = role === "application" ? invalid : application;
        const nextMigration = role === "migration" ? invalid : migration;
        assertSafeRefusal(nextApp, nextMigration);
      }
      for (const code of [...Array(32).keys(), 127]) {
        const control = String.fromCharCode(code);
        for (const invalid of [
          `${control}${selected}`,
          `${selected}${control}`,
          selected.replace("synthetic", `syn${control}thetic`),
        ]) {
          const nextApp = role === "application" ? invalid : application;
          const nextMigration = role === "migration" ? invalid : migration;
          assertSafeRefusal(nextApp, nextMigration);
        }
      }
    }
  }
  const sentinel = "synthetic-secret-not-for-errors";
  assert.throws(
    () => fixtureUrls(`${ciApp}?${sentinel}`, ciMigrator, ciDatabase, "ci"),
    (error) =>
      error instanceof Error &&
      !String(error).includes(sentinel) &&
      !String(error.stack).includes(sentinel),
  );
});

test(
  "native IAM policy barrier holds the original authority and blocks all six writers",
  { skip: !enabled, timeout: 120000 },
  async (context) => {
    requireExplicitCISelection(ciFixtureRequested, process.env.OCC_TEST_NATIVE_IAM_BARRIER_CI);
    assert.ok(appUrl && migrationUrl, "an explicitly owned app and migrator fixture is required");
    fixtureUrls(appUrl, migrationUrl, fixtureDatabase, ciFixtureRequested ? "ci" : "standalone");
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
    const appIdentity = (await app.query(identityQuery)).rows[0];
    const migrationIdentity = (await migrator.query(identityQuery)).rows[0];
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
        await app.query(
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
    const existingInstallations = (await app.query("SELECT id, name FROM occ.installation")).rows;
    // The installation row cannot be deleted, so a repeated standalone run
    // reuses the row an earlier run of this test created. Any other existing
    // installation still refuses the shared database.
    const reusable =
      !ciFixtureRequested &&
      existingInstallations.length === 1 &&
      existingInstallations[0].name === fixtureName;
    if (!reusable) {
      assert.equal(existingInstallations.length, 0);
    }
    const state = new PostgresPlatformState(app);
    const installation = reusable
      ? existingInstallations[0]
      : await state.transact((unit) =>
          unit.installations.createInstallation({
            id: `ins_${randomUUID()}`,
            name: fixtureName,
            createdAt: new Date().toISOString(),
          }),
        );
    const namespaceWork = () => {
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
    const enqueueNamespace = async (unit, queue, input) => {
      await unit.namespaces.createNamespace(input.namespace);
      const work = await queue.enqueue(input.work);
      await unit.audit.append(input.audit);
      assert.equal(work.idempotencyKey, input.work.idempotencyKey);
      assert.equal(work.state, "queued");
      return work.idempotencyKey;
    };
    const effects = async (client, input) =>
      (
        await client.query(
          `SELECT
            (SELECT count(*)::integer FROM occ.namespaces WHERE id = $1) AS namespaces,
            (SELECT count(*)::integer FROM occ.controller_work WHERE idempotency_key = $2) AS work,
            (SELECT count(*)::integer FROM occ.audit_events WHERE id = $3) AS audit`,
          [input.namespace.id, input.work.idempotencyKey, input.audit.id],
        )
      ).rows[0];

    await context.test("policy queue fails closed before the supplier is installed", async () => {
      assert.equal(
        (
          await app.query(
            "SELECT to_regprocedure('occ.native_iam_policy_barrier(text,boolean)') AS supplier",
          )
        ).rows[0].supplier,
        null,
      );
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
    const metadata = (
      await migrator.query(`SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
        has_function_privilege('occ_app', p.oid, 'EXECUTE') AS app_execute,
        EXISTS (SELECT 1 FROM aclexplode(p.proacl) WHERE grantee = 0 AND privilege_type = 'EXECUTE')
          AS public_execute
        FROM pg_proc p WHERE p.oid = 'occ.native_iam_policy_barrier(text,boolean)'::regprocedure`)
    ).rows[0];
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
      assert.equal(
        Number(
          (await migrator.query("SELECT count(*) AS n FROM occ.native_iam_barrier_privilege_probe"))
            .rows[0].n,
        ),
        0,
      );
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
      const request = {
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

      await state.transactWithNativeIAMAuthority(installation.id, "read", async (unit) => {
        await state.guardNativeIAMPolicyInTransaction(unit, installation.id, "read");
        for (const table of tables) {
          await conflicting.query("BEGIN");
          try {
            await conflicting.query("SET LOCAL lock_timeout = '250ms'");
            await assert.rejects(
              conflicting.query(`INSERT INTO occ.${table} SELECT * FROM occ.${table} WHERE FALSE`),
              { code: "55P03" },
            );
          } finally {
            await conflicting.query("ROLLBACK");
          }
        }
      });
      for (const table of tables) {
        const result = await conflicting.query(
          `INSERT INTO occ.${table} SELECT * FROM occ.${table} WHERE FALSE`,
        );
        assert.equal(result.rowCount, 0);
      }

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
        (error) => error.code === "25001" || error.cause?.code === "25001",
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
    let observer;
    try {
      observer = await app.connect();
      await owner.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [key]);
      await owner.query("BEGIN");
      await owner.query("SELECT occ.native_iam_policy_barrier($1, true)", [installation.id]);
      await owner.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
      let result = await observer.query(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS held",
        [key],
      );
      assert.equal(result.rows[0].held, false);
      await owner.query("ROLLBACK");
      result = await observer.query(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS held",
        [key],
      );
      assert.equal(result.rows[0].held, true);
    } finally {
      await owner.query("ROLLBACK").catch(() => {});
      await owner
        .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key])
        .catch(() => {});
      owner.release(true);
      observer?.release(true);
    }

    // One real State backend makes restoration and pool reuse observable; a
    // different connection must not hide a leaked setting or failed transaction.
    const boundedPool = new Pool({
      connectionString: appUrl,
      max: 1,
      connectionTimeoutMillis: 3000,
    });
    context.after(() => boundedPool.end());
    const boundedState = new PostgresPlatformState(boundedPool);
    const contender = await app.connect();
    const settingsSQL = `SELECT pg_catalog.pg_backend_pid() AS pid, current_user AS role,
      pg_catalog.current_setting('lock_timeout') AS lock_timeout,
      pg_catalog.current_setting('statement_timeout') AS statement_timeout,
      pg_catalog.current_setting('search_path') AS search_path`;
    const configureTimeout = async (lockTimeout) => {
      // The separate statement fuse distinguishes an unbounded/overlong lock
      // wait (57014) from the required lock timeout (55P03), without timing guesses.
      await boundedPool.query(
        `SELECT pg_catalog.set_config('lock_timeout', $1, false),
          pg_catalog.set_config('statement_timeout', $2, false)`,
        [lockTimeout, lockTimeout === "250ms" ? "1s" : "8s"],
      );
      return (await boundedPool.query(settingsSQL)).rows[0];
    };
    const policyLocks = async (pid) =>
      (
        await contender.query(
          `SELECT c.relname AS name, l.mode FROM pg_catalog.pg_locks AS l
            JOIN pg_catalog.pg_class AS c ON c.oid = l.relation
            JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
            WHERE l.pid = $1 AND l.granted AND n.nspname = 'occ'
              AND c.relname = ANY($2::text[])
              AND l.mode IN ('ShareLock', 'ShareRowExclusiveLock')
            ORDER BY c.relname`,
          [pid, tables],
        )
      ).rows;
    const expectedLocks = (intent) =>
      tables.toSorted().map((name) => ({
        name,
        mode: intent === "read" ? "ShareLock" : "ShareRowExclusiveLock",
      }));
    const authorityAvailable = async () =>
      (
        await contender.query(
          "SELECT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended($1, 0)) AS held",
          [key],
        )
      ).rows[0].held;
    const holdLastPolicyTable = async () => {
      await contender.query("BEGIN");
      await contender.query("SET LOCAL lock_timeout = '1s'");
      // Real DML retains RowExclusiveLock without altering the fixture policy.
      // The last table exposes partial acquisition of the preceding five locks.
      await contender.query(
        "INSERT INTO occ.iam_restrictions SELECT * FROM occ.iam_restrictions WHERE FALSE",
      );
    };
    const waitForBarrier = async (pid, intent) => {
      const deadline = performance.now() + 2000;
      while (performance.now() < deadline) {
        const result = await contender.query(
          `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks
            WHERE pid = $1 AND NOT granted
              AND relation = 'occ.iam_restrictions'::pg_catalog.regclass AND mode = $2
              AND pg_catalog.pg_backend_pid() = ANY(pg_catalog.pg_blocking_pids($1))) AS waiting`,
          [pid, intent === "read" ? "ShareLock" : "ShareRowExclusiveLock"],
        );
        if (result.rows[0].waiting) {
          return;
        }
        await delay(10);
      }
      assert.fail("the original State backend did not reach the conflicting policy table");
    };
    const resourceLocks = async (pid) =>
      (
        await contender.query(
          `SELECT c.relname AS name, l.mode FROM pg_catalog.pg_locks AS l
            JOIN pg_catalog.pg_class AS c ON c.oid = l.relation
            JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
            WHERE l.pid = $1 AND n.nspname = 'occ'
              AND c.relkind IN ('r', 'p') AND c.relname <> ALL($2::text[])
            ORDER BY c.relname, l.mode`,
          [pid, ["installation", ...tables]],
        )
      ).rows;
    const waitForAdvisoryLock = async (pid) => {
      const deadline = performance.now() + 2000;
      while (performance.now() < deadline) {
        const result = await contender.query(
          `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks
            WHERE pid = $1 AND locktype = 'advisory' AND NOT granted
              AND pg_catalog.pg_backend_pid() = ANY(pg_catalog.pg_blocking_pids($1))) AS waiting`,
          [pid],
        );
        if (result.rows[0].waiting) {
          return;
        }
        await delay(10);
      }
      assert.fail("the original State backend did not wait for the independent lock holder");
    };
    try {
      await context.test(
        "policy queue binds one transaction after both write barriers",
        async () => {
          const baseline = await configureTimeout("1min");
          const input = namespaceWork();
          let retainedUnit;
          let retainedQueue;
          const result = await boundedState.transactWithNativeIAMPolicyQueue(
            installation.id,
            async (unit, queue) => {
              retainedUnit = unit;
              retainedQueue = queue;
              // Observe the real backend before the callback touches either
              // repository: authority and all policy locks precede resource locks.
              assert.deepEqual(await policyLocks(baseline.pid), expectedLocks("write"));
              assert.equal(await authorityAvailable(), false);
              assert.deepEqual(await resourceLocks(baseline.pid), []);
              assert.deepEqual(
                (await boundedState.queryInTransaction(unit, settingsSQL)).rows[0],
                baseline,
              );
              assert.equal(
                (await boundedState.queryInTransaction(unit, "SHOW transaction_isolation")).rows[0]
                  .transaction_isolation,
                "read committed",
              );
              await enqueueNamespace(unit, queue, input);
              assert.equal(
                (await queue.findWork(input.work.idempotencyKey)).namespaceId,
                input.namespace.id,
              );
              const identity = (
                await boundedState.queryInTransaction(
                  unit,
                  `SELECT pg_catalog.pg_backend_pid() AS pid,
                  pg_catalog.pg_current_xact_id()::text AS xid,
                  n.xmin::text AS namespace_xid, w.xmin::text AS work_xid, a.xmin::text AS audit_xid
                  FROM occ.namespaces AS n, occ.controller_work AS w, occ.audit_events AS a
                  WHERE n.id = $1 AND w.idempotency_key = $2 AND a.id = $3`,
                  [input.namespace.id, input.work.idempotencyKey, input.audit.id],
                )
              ).rows[0];
              assert.equal(identity.pid, baseline.pid);
              const transactionId = tupleTransactionId(identity.xid);
              assert.equal(identity.namespace_xid, transactionId);
              assert.equal(identity.work_xid, transactionId);
              assert.equal(identity.audit_xid, transactionId);
              assert.deepEqual(await effects(contender, input), {
                namespaces: 0,
                work: 0,
                audit: 0,
              });
              return input.work.idempotencyKey;
            },
          );
          assert.equal(result, input.work.idempotencyKey);
          assert.deepEqual(await effects(contender, input), { namespaces: 1, work: 1, audit: 1 });
          assert.equal(await authorityAvailable(), true);
          assert.deepEqual(await policyLocks(baseline.pid), []);
          assert.deepEqual((await boundedPool.query(settingsSQL)).rows[0], baseline);
          await assert.rejects(retainedQueue.pending(), /transaction is closed/);
          await assert.rejects(
            retainedUnit.namespaces.findNamespace(input.namespace.id),
            /transaction is closed/,
          );
          assert.throws(
            () => boundedState.queryInTransaction(retainedUnit, "SELECT 1"),
            /unavailable/,
          );
          await assert.rejects(
            boundedState.guardNativeIAMPolicyInTransaction(retainedUnit, installation.id, "write"),
            /unavailable/,
          );
        },
      );

      await context.test("policy queue rolls back resource, Work and audit together", async () => {
        const baseline = await configureTimeout("1min");
        const input = namespaceWork();
        const abort = new Error("abort protected queue transaction");
        let retainedQueue;
        await assert.rejects(
          boundedState.transactWithNativeIAMPolicyQueue(installation.id, async (unit, queue) => {
            retainedQueue = queue;
            await enqueueNamespace(unit, queue, input);
            throw abort;
          }),
          (error) => error === abort,
        );
        assert.deepEqual(await effects(contender, input), { namespaces: 0, work: 0, audit: 0 });
        assert.equal(await authorityAvailable(), true);
        assert.deepEqual(await policyLocks(baseline.pid), []);
        assert.deepEqual((await boundedPool.query(settingsSQL)).rows[0], baseline);
        await assert.rejects(
          retainedQueue.findWork(input.work.idempotencyKey),
          /transaction is closed/,
        );
      });

      for (const intent of ["read", "write"]) {
        const authoritySQL =
          intent === "read"
            ? "SELECT pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended($1, 0))"
            : "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))";
        await context.test(
          `policy queue waits for preceding ${intent} authority to commit`,
          async () => {
            const baseline = await configureTimeout("1min");
            const input = namespaceWork();
            let called = false;
            let transaction;
            await contender.query("BEGIN");
            try {
              await contender.query(authoritySQL, [key]);
              await contender.query("SELECT occ.native_iam_policy_barrier($1, $2)", [
                installation.id,
                intent === "write",
              ]);
              transaction = boundedState.transactWithNativeIAMPolicyQueue(
                installation.id,
                async (unit, queue) => {
                  called = true;
                  assert.deepEqual(await policyLocks(baseline.pid), expectedLocks("write"));
                  return enqueueNamespace(unit, queue, input);
                },
              );
              void transaction.catch(() => {});
              await waitForAdvisoryLock(baseline.pid);
              assert.equal(called, false);
              assert.deepEqual(await resourceLocks(baseline.pid), []);
              assert.deepEqual(await policyLocks(baseline.pid), []);
              await contender.query("COMMIT");
              assert.equal(await transaction, input.work.idempotencyKey);
              assert.equal(called, true);
              assert.deepEqual(await effects(contender, input), {
                namespaces: 1,
                work: 1,
                audit: 1,
              });
            } finally {
              await contender.query("ROLLBACK");
              if (transaction !== undefined) {
                await transaction.catch(() => {});
              }
            }
          },
        );

        await context.test(
          `policy queue excludes later ${intent} authority until commit`,
          async () => {
            const input = namespaceWork();
            await boundedState.transactWithNativeIAMPolicyQueue(
              installation.id,
              async (unit, queue) => {
                await enqueueNamespace(unit, queue, input);
                await contender.query("BEGIN");
                try {
                  await contender.query("SET LOCAL lock_timeout = '100ms'");
                  await assert.rejects(contender.query(authoritySQL, [key]), { code: "55P03" });
                } finally {
                  await contender.query("ROLLBACK");
                }
              },
            );
            await contender.query("BEGIN");
            try {
              await contender.query("SET LOCAL lock_timeout = '100ms'");
              await contender.query(authoritySQL, [key]);
              await contender.query("SELECT occ.native_iam_policy_barrier($1, $2)", [
                installation.id,
                intent === "write",
              ]);
              assert.deepEqual(await effects(contender, input), {
                namespaces: 1,
                work: 1,
                audit: 1,
              });
              await contender.query("COMMIT");
            } finally {
              await contender.query("ROLLBACK");
            }
          },
        );
      }

      await context.test(
        "policy queue waits for its barrier before exposing the callback",
        async () => {
          const baseline = await configureTimeout("1min");
          let called = false;
          let transaction;
          await holdLastPolicyTable();
          try {
            transaction = boundedState.transactWithNativeIAMPolicyQueue(
              installation.id,
              async (_unit, queue) => {
                called = true;
                assert.deepEqual(await policyLocks(baseline.pid), expectedLocks("write"));
                return queue.pending();
              },
            );
            void transaction.catch(() => {});
            await waitForBarrier(baseline.pid, "write");
            assert.equal(called, false);
            assert.deepEqual(await resourceLocks(baseline.pid), []);
            assert.equal(await authorityAvailable(), false);
            await contender.query("ROLLBACK");
            assert.ok(Number.isInteger(await transaction));
            assert.equal(called, true);
          } finally {
            await contender.query("ROLLBACK");
            if (transaction !== undefined) {
              await transaction.catch(() => {});
            }
          }
        },
      );

      await context.test(
        "policy queue barrier timeout has no callback or durable effects",
        async () => {
          const baseline = await configureTimeout("250ms");
          const input = namespaceWork();
          let called = false;
          await holdLastPolicyTable();
          try {
            await assert.rejects(
              boundedState.transactWithNativeIAMPolicyQueue(
                installation.id,
                async (unit, queue) => {
                  called = true;
                  return enqueueNamespace(unit, queue, input);
                },
              ),
              // State classifies the lock timeout (55P03) as retryable unavailability.
              { name: "DependencyUnavailableError", message: /lock timeout/ },
            );
            assert.equal(called, false);
            assert.deepEqual(await effects(contender, input), { namespaces: 0, work: 0, audit: 0 });
            assert.deepEqual(await policyLocks(baseline.pid), []);
            assert.deepEqual(await resourceLocks(baseline.pid), []);
            assert.deepEqual((await boundedPool.query(settingsSQL)).rows[0], baseline);
          } finally {
            await contender.query("ROLLBACK");
          }
          assert.equal(await authorityAvailable(), true);
        },
      );

      await context.test(
        "policy queue drains accepted work and closes callback admissions",
        async () => {
          const baseline = await configureTimeout("1min");
          const latch = `policy-queue-drain:${randomUUID()}`;
          let retainedUnit;
          let retainedQueue;
          let blocked;
          let queued;
          let settled = false;
          let transaction;
          await contender.query("BEGIN");
          try {
            await contender.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [latch]);
            transaction = boundedState.transactWithNativeIAMPolicyQueue(
              installation.id,
              async (unit, queue) => {
                retainedUnit = unit;
                retainedQueue = queue;
                // Hold a real query so the callback returns while an accepted queue
                // operation remains pending on the same client. No methods are replaced.
                blocked = boundedState.queryInTransaction(
                  unit,
                  "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
                  [latch],
                );
                queued = queue.pending();
                void blocked.catch(() => {});
                void queued.catch(() => {});
                return "drained";
              },
            );
            void transaction.then(
              () => {
                settled = true;
              },
              () => {
                settled = true;
              },
            );
            await waitForAdvisoryLock(baseline.pid);
            assert.equal(settled, false);
            assert.equal(await authorityAvailable(), false);
            assert.deepEqual(await policyLocks(baseline.pid), expectedLocks("write"));
            await assert.rejects(retainedQueue.pending(), /transaction is closed/);
            await assert.rejects(retainedUnit.namespaces.listNamespaces(), /transaction is closed/);
            await contender.query("ROLLBACK");
            assert.equal(await transaction, "drained");
            await blocked;
            assert.ok(Number.isInteger(await queued));
            assert.equal(await authorityAvailable(), true);
            assert.deepEqual((await boundedPool.query(settingsSQL)).rows[0], baseline);
          } finally {
            await contender.query("ROLLBACK");
            await Promise.allSettled([transaction, blocked, queued]);
          }
        },
      );

      for (const intent of ["read", "write"]) {
        for (const lockTimeout of ["0", "1min", "250ms"]) {
          await context.test(
            `${intent} barrier preserves lock_timeout=${lockTimeout}`,
            async () => {
              const baseline = await configureTimeout(lockTimeout);
              assert.equal(baseline.role, "occ_app");
              await boundedState.transactWithNativeIAMAuthority(
                installation.id,
                intent,
                async (unit) => {
                  await boundedState.guardNativeIAMPolicyInTransaction(
                    unit,
                    installation.id,
                    intent,
                  );
                  assert.deepEqual(
                    (await boundedState.queryInTransaction(unit, settingsSQL)).rows[0],
                    baseline,
                  );
                  assert.deepEqual(await policyLocks(baseline.pid), expectedLocks(intent));
                  assert.equal(await authorityAvailable(), false);
                  if (lockTimeout === "0") {
                    for (const table of tables) {
                      await contender.query("BEGIN");
                      try {
                        await contender.query("SET LOCAL lock_timeout = '50ms'");
                        await assert.rejects(
                          contender.query(
                            `INSERT INTO occ.${table} SELECT * FROM occ.${table} WHERE FALSE`,
                          ),
                          { code: "55P03" },
                        );
                      } finally {
                        await contender.query("ROLLBACK");
                      }
                    }
                  }
                },
              );
              assert.deepEqual((await boundedPool.query(settingsSQL)).rows[0], baseline);
              assert.deepEqual(await policyLocks(baseline.pid), []);
              assert.equal(await authorityAvailable(), true);
              if (lockTimeout === "0") {
                for (const table of tables) {
                  assert.equal(
                    (
                      await contender.query(
                        `INSERT INTO occ.${table} SELECT * FROM occ.${table} WHERE FALSE`,
                      )
                    ).rowCount,
                    0,
                  );
                }
              }

              const namespaceId = `ns_${randomUUID()}`;
              const auditId = `aud_${randomUUID()}`;
              let protectedWorkReached = false;
              await holdLastPolicyTable();
              try {
                await assert.rejects(
                  boundedState.transactWithNativeIAMAuthority(
                    installation.id,
                    intent,
                    async (unit) => {
                      await boundedState.guardNativeIAMPolicyInTransaction(
                        unit,
                        installation.id,
                        intent,
                      );
                      protectedWorkReached = true;
                      await unit.namespaces.createNamespace({
                        id: namespaceId,
                        name: "Barrier timeout must prevent this mutation",
                        status: "provisioning",
                        createdAt: new Date().toISOString(),
                      });
                      await unit.audit.append({
                        schemaVersion: 1,
                        id: auditId,
                        installationId: installation.id,
                        occurredAt: new Date().toISOString(),
                        source: "occ",
                        kind: "mutation",
                        actorId: "barrier-timeout-test",
                        actor: { principalId: "barrier-timeout-test" },
                        action: "openclaw.namespaces.create",
                        namespaceId,
                        resource: { kind: "namespace", id: namespaceId, namespaceId },
                        outcome: "success",
                      });
                    },
                  ),
                  { name: "DependencyUnavailableError", message: /lock timeout/ },
                );
                assert.equal(protectedWorkReached, false);
                assert.equal(
                  (
                    await boundedPool.query("SELECT id FROM occ.namespaces WHERE id = $1", [
                      namespaceId,
                    ])
                  ).rowCount,
                  0,
                );
                assert.equal(
                  (
                    await boundedPool.query("SELECT id FROM occ.audit_events WHERE id = $1", [
                      auditId,
                    ])
                  ).rowCount,
                  0,
                );
                assert.deepEqual(await policyLocks(baseline.pid), []);
                const activity = await contender.query(
                  "SELECT state, xact_start FROM pg_catalog.pg_stat_activity WHERE pid = $1",
                  [baseline.pid],
                );
                assert.deepEqual(activity.rows, [{ state: "idle", xact_start: null }]);
                assert.deepEqual((await boundedPool.query(settingsSQL)).rows[0], baseline);
              } finally {
                await contender.query("ROLLBACK");
              }
              assert.equal(await authorityAvailable(), true);
            },
          );
        }

        await context.test(
          `${intent} barrier restores before concurrent same-unit work`,
          async () => {
            const baseline = await configureTimeout("1min");
            await holdLastPolicyTable();
            try {
              await boundedState.transactWithNativeIAMAuthority(
                installation.id,
                intent,
                async (unit) => {
                  await boundedState.queryInTransaction(unit, "SET LOCAL lock_timeout = '9s'");
                  const localSettings = { ...baseline, lock_timeout: "9s" };
                  await boundedState.queryInTransaction(unit, "SAVEPOINT policy_guard");
                  const guard = boundedState.guardNativeIAMPolicyInTransaction(
                    unit,
                    installation.id,
                    intent,
                  );
                  void guard.catch(() => {});
                  await waitForBarrier(baseline.pid, intent);
                  // Admit this query only after the guard is waiting inside PostgreSQL.
                  // A client-side restore queued after the guard would be too late.
                  const concurrent = boundedState.queryInTransaction(unit, settingsSQL);
                  const joined = Promise.all([guard, concurrent]);
                  void joined.catch(() => {});
                  await contender.query("ROLLBACK");
                  const [, observed] = await joined;
                  assert.deepEqual(observed.rows[0], localSettings);
                  assert.deepEqual(await policyLocks(baseline.pid), expectedLocks(intent));
                  await boundedState.queryInTransaction(unit, "ROLLBACK TO SAVEPOINT policy_guard");
                  assert.deepEqual(await policyLocks(baseline.pid), []);
                  assert.equal(
                    await authorityAvailable(),
                    false,
                    "the original authority predates the savepoint",
                  );
                  assert.deepEqual(
                    (await boundedState.queryInTransaction(unit, settingsSQL)).rows[0],
                    localSettings,
                  );
                  await boundedState.queryInTransaction(unit, "RELEASE SAVEPOINT policy_guard");
                },
              );
            } finally {
              await contender.query("ROLLBACK");
            }
            assert.deepEqual((await boundedPool.query(settingsSQL)).rows[0], baseline);
            assert.equal(await authorityAvailable(), true);
          },
        );

        await context.test(
          `${intent} barrier error restores at the original savepoint`,
          async () => {
            const baseline = await configureTimeout("1min");
            await holdLastPolicyTable();
            try {
              await boundedState.transactWithNativeIAMAuthority(
                installation.id,
                intent,
                async (unit) => {
                  await boundedState.queryInTransaction(unit, "SET LOCAL lock_timeout = '0'");
                  const localSettings = { ...baseline, lock_timeout: "0" };
                  await boundedState.queryInTransaction(unit, "SAVEPOINT policy_guard");
                  const guard = boundedState.guardNativeIAMPolicyInTransaction(
                    unit,
                    installation.id,
                    intent,
                  );
                  void guard.catch(() => {});
                  await waitForBarrier(baseline.pid, intent);
                  const concurrent = boundedState.queryInTransaction(unit, settingsSQL);
                  const outcomes = await Promise.allSettled([guard, concurrent]);
                  assert.equal(outcomes[0].status, "rejected");
                  assert.equal(outcomes[0].reason.code, "55P03");
                  assert.equal(outcomes[1].status, "rejected");
                  assert.equal(outcomes[1].reason.code, "25P02");
                  await boundedState.queryInTransaction(unit, "ROLLBACK TO SAVEPOINT policy_guard");
                  assert.deepEqual(
                    (await boundedState.queryInTransaction(unit, settingsSQL)).rows[0],
                    localSettings,
                  );
                  assert.deepEqual(await policyLocks(baseline.pid), []);
                  assert.equal(await authorityAvailable(), false);
                  await boundedState.queryInTransaction(unit, "RELEASE SAVEPOINT policy_guard");

                  // A PL/pgSQL caller may catch the propagated error in its own
                  // subtransaction. That must restore settings and partial locks
                  // while retaining the original authority outside that scope.
                  await boundedState.queryInTransaction(
                    unit,
                    `DO $caller$
                  BEGIN
                    BEGIN
                      PERFORM occ.native_iam_policy_barrier(
                        (SELECT id FROM occ.installation), ${intent === "write"});
                      RAISE EXCEPTION 'the conflicting policy lock unexpectedly succeeded';
                    EXCEPTION WHEN lock_not_available THEN
                      NULL;
                    END;
                  END;
                $caller$`,
                  );
                  assert.deepEqual(
                    (await boundedState.queryInTransaction(unit, settingsSQL)).rows[0],
                    localSettings,
                  );
                  assert.deepEqual(await policyLocks(baseline.pid), []);
                  assert.equal(await authorityAvailable(), false);
                },
              );
            } finally {
              await contender.query("ROLLBACK");
            }
            assert.deepEqual((await boundedPool.query(settingsSQL)).rows[0], baseline);
            assert.equal(await authorityAvailable(), true);
          },
        );
      }

      await context.test(
        "upgrade refusal preserves an earlier read barrier and caller settings",
        async () => {
          const baseline = await configureTimeout("1min");
          const abort = new Error("roll back the retained read barrier");
          await assert.rejects(
            boundedState.transactWithNativeIAMAuthority(installation.id, "write", async (unit) => {
              await boundedState.guardNativeIAMPolicyInTransaction(unit, installation.id, "read");
              await boundedState.queryInTransaction(unit, "SAVEPOINT refused_upgrade");
              await assert.rejects(
                boundedState.guardNativeIAMPolicyInTransaction(unit, installation.id, "write"),
                { code: "25001" },
              );
              await boundedState.queryInTransaction(unit, "ROLLBACK TO SAVEPOINT refused_upgrade");
              assert.deepEqual(
                (await boundedState.queryInTransaction(unit, settingsSQL)).rows[0],
                baseline,
              );
              assert.deepEqual(await policyLocks(baseline.pid), expectedLocks("read"));
              assert.equal(await authorityAvailable(), false);
              throw abort;
            }),
            (error) => error === abort,
          );
          assert.deepEqual((await boundedPool.query(settingsSQL)).rows[0], baseline);
          assert.deepEqual(await policyLocks(baseline.pid), []);
          assert.equal(await authorityAvailable(), true);
        },
      );
    } finally {
      try {
        await contender.query("ROLLBACK");
      } finally {
        contender.release(true);
      }
    }
  },
);
