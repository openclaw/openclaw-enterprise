import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Pool } from "pg";

import { createPostgresAuthAccountProvisioner } from "../../apps/controller/src/auth/index.ts";
import { OCCTokenServiceDriver } from "../../apps/controller/src/drivers/token-service/occ.ts";
import type { AuditEvent, CredentialSourceReference } from "../../packages/contracts/src/index.ts";
import {
  AuditAppendUnavailableError,
  AuthorizationDeniedError,
  DependencyUnavailableError,
  RetryLaterError,
} from "../../packages/occ/src/index.ts";
import { controllerIAMConfiguration, defaultUsersIAM } from "../helpers/default-users-iam.mjs";
import { useInstallationSecretDriver } from "../helpers/kubernetes-secret-core.mjs";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { databaseUrl, testPool } from "../helpers/postgres-database.mjs";
import { waitForLockWaiter } from "../helpers/postgres-locks.ts";
import { auditEvent } from "./postgres-namespace-iam-fixture.ts";

const migratorUrl = process.env.OCC_TEST_STATIC_TOKEN_SERVICE_MIGRATION_DATABASE_URL;

async function withRejectedAuditRows<T>(
  migrator: Pool,
  action: string,
  run: () => Promise<T>,
  outcome?: "success",
) {
  // The disposable migrator role can refuse a new action without invalidating earlier ledger rows.
  await migrator.query(
    `ALTER TABLE occ.audit_events ADD CONSTRAINT reject_static_token_service_audit
       CHECK (action <> '${action}'${outcome ? ` OR outcome <> '${outcome}'` : ""}) NOT VALID`,
  );
  try {
    return await run();
  } finally {
    await migrator.query(
      "ALTER TABLE occ.audit_events DROP CONSTRAINT reject_static_token_service_audit",
    );
  }
}

test(
  "staged TokenService lifecycle keeps private custody, audit, and exact update authority",
  {
    skip:
      databaseUrl && migratorUrl ? false : "Prepare the dedicated postgres-platform file fixture.",
  },
  async (t) => {
    assert.ok(databaseUrl && migratorUrl);
    const appTarget = new URL(databaseUrl);
    const migratorTarget = new URL(migratorUrl);
    assert.ok(
      appTarget.protocol === "postgresql:" &&
        appTarget.hostname === "127.0.0.1" &&
        appTarget.pathname.startsWith("/openclaw_ci_") &&
        migratorTarget.protocol === appTarget.protocol &&
        migratorTarget.hostname === appTarget.hostname &&
        migratorTarget.port === appTarget.port &&
        migratorTarget.pathname === appTarget.pathname &&
        appTarget.username === "occ_app" &&
        migratorTarget.username === "occ_migrator",
      "Audit constraints require a role-separated disposable loopback database.",
    );
    const migrator = testPool(t, { connectionString: migratorUrl });
    let now = new Date();
    const { controller, inject, pool, principal, state } = await createPostgresAgentApp(t, {
      label: "staged-token-service",
      authSecret: "staged-token-service-session-secret",
      requestAudit: false,
      controllerOptions: {
        now: () => now,
        iamConfiguration: controllerIAMConfiguration(defaultUsersIAM()),
      },
      appOptions: {
        provisionAuthAccount: (
          ...args: Parameters<ReturnType<typeof createPostgresAuthAccountProvisioner>>
        ) => provision(...args),
      },
    });
    const provision = createPostgresAuthAccountProvisioner({
      state,
      installationId: controller.installation.id,
    });
    await controller.applyIAMConfiguration();
    // PostgreSQL, Native IAM, and both concrete Drivers are real; only the Kubernetes API transport is simulated.
    const { core, driver } = useInstallationSecretDriver(controller);
    assert.ok(driver.installationSecrets);
    const ownerId = "staged-token-service";
    const instanceId = await controller.activateTokenServiceInstance(ownerId, randomUUID());
    const owner = new OCCTokenServiceDriver(
      ownerId,
      controller.installation.id,
      driver.installationSecrets,
      instanceId,
    );
    controller.registerDriver(owner);
    controller.selectDriver("token_service", owner.id);

    const createdNamespace = await inject("POST", "/namespaces", {
      name: `Staged source ${randomUUID()}`,
    });
    assert.equal(createdNamespace.statusCode, 201, createdNamespace.body);
    const namespaceId: string = createdNamespace.json().data.id;
    await controller.handleNamespaceLifecycle(principal.id, namespaceId, "ready");
    const base = `/namespaces/${namespaceId}/credential-sources`;
    const event = (
      actorId: string,
      action: string,
      ref: CredentialSourceReference,
      phase?: string,
    ): AuditEvent => ({
      ...auditEvent(
        controller.installation.id,
        namespaceId,
        actorId,
        phase ? `${action}.started` : action,
        ref,
      ),
      ...(phase ? { details: { phase } } : {}),
    });
    const createAudit = (ref: CredentialSourceReference, phase?: "registration_started") =>
      event(principal.id, "openclaw.credential_sources.create", ref, phase);
    const register = (name: string, apiKey: string) =>
      controller.registerManagedCredentialSource(
        principal.id,
        namespaceId,
        { name, lifecycleConfig: { type: "openai", settings: {} }, secret: { api_key: apiKey } },
        createAudit,
      );
    const retire = (id: string) =>
      controller.deleteManagedCredentialSource(principal.id, namespaceId, id, (_removed, phase) =>
        event(
          principal.id,
          "openclaw.credential_sources.delete",
          { kind: "credential_source", namespaceId, id },
          phase,
        ),
      );
    const custodyRows = async () =>
      (
        await pool.query(
          `SELECT (SELECT count(*)::int FROM occ.credential_sources WHERE namespace_id=$1) AS sources,
              (SELECT count(*)::int FROM occ.iam_access_bindings WHERE namespace_id=$1 AND resource_kind='credential_source') AS bindings`,
          [namespaceId],
        )
      ).rows;

    // The serving route remains the Secret-reference contract; staged material is not a public writer.
    const publicWriter = await inject("POST", base, {
      name: "not public",
      type: "openai",
      secret: { api_key: randomUUID() },
    });
    assert.equal(publicWriter.statusCode, 400, publicWriter.body);
    const createsBefore = core.calls.createNamespacedSecret;
    await assert.rejects(register("Oversized", "a".repeat(65_471)), /encoded credential exceeds/);
    assert.equal(core.calls.createNamespacedSecret, createsBefore);
    assert.deepEqual(await custodyRows(), [{ sources: 0, bindings: 0 }]);

    // Refusing intent prevents the concrete owner from taking custody or leaving a creator binding.
    await withRejectedAuditRows(
      migrator,
      "openclaw.credential_sources.create.started",
      async () => {
        await assert.rejects(register("Intent refused", randomUUID()), AuditAppendUnavailableError);
      },
    );
    assert.equal(core.calls.createNamespacedSecret, createsBefore);
    assert.deepEqual(await custodyRows(), [{ sources: 0, bindings: 0 }]);

    // The dependency applies the credential write but loses the acknowledgment; retain fencing and attributable intent.
    const unknownKey = randomUUID();
    core.createAppliedFailureCodes.push(503);
    await assert.rejects(register("Unknown receipt", unknownKey), DependencyUnavailableError);
    const uncertain = (
      await pool.query(
        "SELECT id,state,registration,registration_dispatched_at FROM occ.credential_sources WHERE namespace_id=$1",
        [namespaceId],
      )
    ).rows[0];
    assert.equal(uncertain.state, "deleting");
    assert.equal(uncertain.registration, null);
    assert.ok(uncertain.registration_dispatched_at);
    assert.equal(core.secrets.size, 1);
    assert.deepEqual(
      (
        await pool.query(
          `SELECT actor_id,resource_id,details->>'phase' AS phase FROM occ.audit_events
       WHERE action='openclaw.credential_sources.create.started' AND resource_id=$1`,
          [uncertain.id],
        )
      ).rows,
      [{ actor_id: principal.id, resource_id: uncertain.id, phase: "registration_started" }],
    );
    await assert.rejects(retire(uncertain.id), RetryLaterError);
    assert.equal(core.secrets.size, 1);
    now = new Date(now.getTime() + 70_001);
    await retire(uncertain.id);
    assert.equal(core.secrets.size, 0);
    assert.deepEqual(await custodyRows(), [{ sources: 0, bindings: 0 }]);

    const key = randomUUID();
    const source = await register("Private key", key);
    const sourceId = source.id;
    const ref = source.ref;
    const persisted = await state.read((view) =>
      view.credentialSources.findCredentialSource(namespaceId, sourceId),
    );
    assert.ok(persisted?.ownerCapability === "token_service" && persisted.registration);
    assert.equal(persisted.tokenServiceInstanceId, instanceId);
    assert.deepEqual(persisted.registration, { backendRef: { type: "openai" } });
    assert.equal(
      (
        await pool.query("SELECT count(*)::int AS count FROM occ.secrets WHERE namespace_id=$1", [
          namespaceId,
        ])
      ).rows[0].count,
      0,
    );
    const resolve = async () =>
      (
        await owner.resolveCredential(
          {
            sourceRef: ref,
            tokenServiceInstanceId: instanceId,
            registration: persisted.registration!,
          },
          AbortSignal.timeout(5_000),
        )
      ).credential;
    assert.equal(await resolve(), key);

    // Internal records must not become serving source metadata or mutable public resources, even for an administrator.
    assert.deepEqual((await inject("GET", base)).json().data, []);
    assert.equal((await inject("GET", `${base}/${sourceId}`)).statusCode, 404);
    assert.equal((await inject("PATCH", `${base}/${sourceId}`, {})).statusCode, 404);
    assert.equal((await inject("POST", `${base}/${sourceId}/rotate`)).statusCode, 404);
    assert.equal((await inject("DELETE", `${base}/${sourceId}`)).statusCode, 404);

    const update = (actorId: string, apiKey: string) =>
      controller.updateManagedCredentialSource(
        actorId,
        { namespaceId, credentialSourceId: sourceId },
        { secret: { api_key: apiKey } },
        (resource) => event(actorId, "openclaw.credential_sources.update", resource),
        (reasonCode) => ({
          ...event(actorId, "openclaw.credential_sources.update", ref),
          outcome: "failure",
          reasonCode,
        }),
      );
    const replacementKey = randomUUID();
    await update(principal.id, replacementKey);
    assert.equal(await resolve(), replacementKey);

    // Custody may advance before the success audit fails; retain an attributable failure rather than rolling the value back.
    const committedKey = randomUUID();
    await withRejectedAuditRows(
      migrator,
      "openclaw.credential_sources.update",
      async () => {
        await assert.rejects(update(principal.id, committedKey), AuditAppendUnavailableError);
      },
      "success",
    );
    assert.equal(await resolve(), committedKey);
    assert.deepEqual(
      (
        await pool.query(
          "SELECT outcome,details->'__occAuditMetadata'->>'reasonCode' AS reason_code FROM occ.audit_events WHERE action='openclaw.credential_sources.update' AND resource_id=$1 AND outcome='failure'",
          [sourceId],
        )
      ).rows,
      [{ outcome: "failure", reason_code: "CREDENTIAL_SOURCE_UPDATE_FAILED" }],
    );

    const account = await inject("POST", "/api/auth/accounts", {
      name: "Source updater",
      email: `source-${randomUUID()}@example.test`,
      password: randomUUID(),
    });
    assert.equal(account.statusCode, 201, account.body);
    const memberId: string = account.json().data.principalId;
    const role = await inject("POST", `/namespaces/${namespaceId}/iam/roles`, {
      name: "Exact updater",
      permissions: [{ action: "update", resourceKind: "credential_source" }],
    });
    assert.equal(role.statusCode, 201, role.body);
    const grant = await inject("POST", `/namespaces/${namespaceId}/iam/access-bindings`, {
      subjectKind: "identity",
      subjectId: memberId,
      roleId: role.json().data.id,
      resourceKind: "credential_source",
      resourceId: sourceId,
    });
    assert.equal(grant.statusCode, 201, grant.body);

    // Revocation cannot pass a source update that already acquired the policy fence while waiting on its row.
    const lock = await pool.connect();
    let open = false;
    const requests: Promise<unknown>[] = [];
    try {
      await lock.query("BEGIN");
      open = true;
      const held = await lock.query(
        "SELECT pg_backend_pid() AS pid FROM occ.credential_sources WHERE id=$1 FOR UPDATE",
        [sourceId],
      );
      const concurrentKey = randomUUID();
      const patching = update(memberId, concurrentKey);
      requests.push(patching);
      const patchPid = await waitForLockWaiter(
        pool,
        held.rows[0].pid,
        "the source update waiting for its row",
      );
      const revoking = Promise.resolve(
        inject("DELETE", `/namespaces/${namespaceId}/iam/access-bindings/${grant.json().data.id}`),
      );
      requests.push(revoking);
      assert.equal(
        await Promise.race([
          revoking.then(() => "completed"),
          waitForLockWaiter(pool, patchPid, "revocation waiting on the update policy fence", {
            queryLike: "%FROM occ.namespaces%",
          }).then(() => "blocked"),
        ]),
        "blocked",
      );
      await lock.query("ROLLBACK");
      open = false;
      await patching;
      assert.equal((await revoking).statusCode, 204);
      assert.equal(await resolve(), concurrentKey);
      await assert.rejects(update(memberId, randomUUID()), AuthorizationDeniedError);
    } finally {
      if (open) {
        await lock.query("ROLLBACK");
      }
      lock.release();
      await Promise.allSettled(requests);
    }

    const valueBeforeRetirement = await resolve();
    await withRejectedAuditRows(
      migrator,
      "openclaw.credential_sources.delete.started",
      async () => {
        await assert.rejects(retire(sourceId), AuditAppendUnavailableError);
      },
    );
    assert.equal(await resolve(), valueBeforeRetirement);
    assert.equal(
      (await pool.query("SELECT state FROM occ.credential_sources WHERE id=$1", [sourceId])).rows[0]
        .state,
      "ready",
    );
    await retire(sourceId);
    assert.equal(core.secrets.size, 0);
    assert.deepEqual(await custodyRows(), [{ sources: 0, bindings: 0 }]);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM occ.audit_events WHERE details::text LIKE $1",
          [`%${unknownKey}%`],
        )
      ).rows[0].count,
      0,
    );
  },
);
