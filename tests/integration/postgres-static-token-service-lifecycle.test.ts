import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Pool } from "pg";

import { createPostgresAuthAccountProvisioner } from "../../apps/controller/src/auth/index.ts";
import { OCCTokenServiceDriver } from "../../apps/controller/src/drivers/token-service/occ.ts";
import type {
  AuditEvent,
  CredentialSourceReference,
  SourceProviderPresetId,
} from "../../packages/contracts/src/index.ts";
import {
  AuditAppendUnavailableError,
  AuthorizationDeniedError,
  ResourceStateConflictError,
  ScopeViolationError,
  TokenServiceSourceInputError,
  type UpdateManagedCredentialSourceInput,
} from "../../packages/occ/src/index.ts";
import { controllerIAMConfiguration, defaultUsersIAM } from "../helpers/default-users-iam.mjs";
import { useInstallationSecretDriver } from "../helpers/kubernetes-secret-core.mjs";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { databaseUrl, testPool } from "../helpers/postgres-database.mjs";
import { waitForLockWaiter } from "../helpers/postgres-locks.ts";
import { auditEvent } from "./postgres-namespace-iam-fixture.ts";

const migratorUrl = process.env.OCC_TEST_STATIC_TOKEN_SERVICE_MIGRATION_DATABASE_URL;

async function withRejectedAuditRows<T>(migrator: Pool, action: string, run: () => Promise<T>) {
  // The disposable migrator role can refuse a new action without invalidating earlier ledger rows.
  await migrator.query(
    `ALTER TABLE occ.audit_events ADD CONSTRAINT reject_static_token_service_audit
       CHECK (action <> '${action}') NOT VALID`,
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
    const { controller, inject, pool, principal, state } = await createPostgresAgentApp(t, {
      label: "staged-token-service",
      authSecret: "staged-token-service-session-secret",
      requestAudit: false,
      controllerOptions: {
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
      (work) => controller.transact(({ credentialSources }) => work(credentialSources)),
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
    const createSource = (
      name: string,
      credential: string,
      providerPreset?: SourceProviderPresetId,
    ) =>
      controller.createManagedCredentialSource(
        principal.id,
        namespaceId,
        {
          name,
          lifecycleConfig: { type: "static", settings: {} },
          secret: { opaque: credential },
          ...(providerPreset === undefined ? {} : { providerPreset }),
        },
        createAudit,
      );
    const retire = (id: string) =>
      controller.deleteCredentialSource(principal.id, namespaceId, id, (_removed, phase) =>
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

    const createsBefore = core.calls.createNamespacedSecret;
    // The owner resolves one static value; ambiguous material must fail before custody starts.
    await assert.rejects(
      controller.createManagedCredentialSource(
        principal.id,
        namespaceId,
        {
          name: "Ambiguous credential",
          lifecycleConfig: { type: "static", settings: {} },
          secret: { first: randomUUID(), second: randomUUID() },
        },
        createAudit,
      ),
      TokenServiceSourceInputError,
    );
    await assert.rejects(
      createSource("Oversized", "a".repeat(65_471)),
      TokenServiceSourceInputError,
    );
    // Provider approval belongs to OCC. Neither an unknown ID nor a lifecycle setting can create it.
    for (const invalid of ["", "unknown"]) {
      await assert.rejects(
        createSource("Invalid preset", randomUUID(), invalid as SourceProviderPresetId),
        ScopeViolationError,
      );
    }
    await assert.rejects(
      controller.createManagedCredentialSource(
        principal.id,
        namespaceId,
        {
          name: "Lifecycle cannot approve a provider",
          lifecycleConfig: { type: "static", settings: { provider_preset: "openai" } },
          secret: { opaque: randomUUID() },
        },
        createAudit,
      ),
      ScopeViolationError,
    );
    assert.equal(core.calls.createNamespacedSecret, createsBefore);
    assert.deepEqual(await custodyRows(), [{ sources: 0, bindings: 0 }]);

    // Refusing intent prevents the concrete owner from taking custody or leaving a creator binding.
    await withRejectedAuditRows(
      migrator,
      "openclaw.credential_sources.create.started",
      async () => {
        await assert.rejects(
          createSource("Intent refused", randomUUID()),
          AuditAppendUnavailableError,
        );
      },
    );
    assert.equal(core.calls.createNamespacedSecret, createsBefore);
    assert.deepEqual(await custodyRows(), [{ sources: 0, bindings: 0 }]);

    // The private store can accept a write and lose its acknowledgment. The request fails,
    // and the canonical Source transaction rolls back; orphaned custody is an accepted outcome.
    const unknownKey = randomUUID();
    core.createAppliedFailureCodes.push(503);
    const unknown = await inject("POST", base, {
      name: "Unknown credential write",
      type: "static",
      secret: { opaque: unknownKey },
    });
    assert.equal(unknown.statusCode, 503, unknown.body);
    assert.equal(unknown.json().error.code, "DEPENDENCY_UNAVAILABLE");
    assert.deepEqual(await custodyRows(), [{ sources: 0, bindings: 0 }]);
    assert.equal(
      core.secrets.size,
      1,
      "the lost acknowledgment can leave private orphaned material",
    );
    assert.deepEqual(
      (
        await pool.query(
          `SELECT actor_id,resource_id,details->>'phase' AS phase FROM occ.audit_events
           WHERE action='openclaw.credential_sources.create.started' AND resource_id=$1 AND actor_id=$2`,
          [namespaceId, principal.id],
        )
      ).rows.at(-1),
      { actor_id: principal.id, resource_id: namespaceId, phase: "registration_started" },
    );

    // Static custody accepts no settings. Successful registration proves OCC did not forward the approval.
    const approved = await createSource("Approved provider", randomUUID(), "openai");
    assert.deepEqual(approved.config, { provider_preset: "openai" });
    assert.deepEqual(
      (await pool.query("SELECT config FROM occ.credential_sources WHERE id=$1", [approved.id]))
        .rows[0].config,
      { provider_preset: "openai" },
    );
    assert.deepEqual(
      (
        await pool.query(
          "SELECT actor_id, details->'providerPreset' AS preset FROM occ.audit_events WHERE action='openclaw.credential_sources.create' AND resource_id=$1",
          [approved.id],
        )
      ).rows,
      [{ actor_id: principal.id, preset: "openai" }],
    );
    const beforeDuplicate = core.calls.createNamespacedSecret;
    const duplicate = await inject("POST", base, {
      name: "Approved provider",
      type: "static",
      secret: { opaque: randomUUID() },
    });
    assert.equal(duplicate.statusCode, 409, duplicate.body);
    assert.equal(core.calls.createNamespacedSecret, beforeDuplicate);
    await retire(approved.id);

    const key = randomUUID();
    const source = await createSource("Private credential", key);
    assert.deepEqual(source.config, {});
    const sourceId = source.id;
    const ref = source.ref;
    const persisted = await state.read((view) =>
      view.credentialSources.findCredentialSource(namespaceId, sourceId),
    );
    assert.ok(persisted?.ownerCapability === "token_service");
    assert.equal(persisted.tokenServiceInstanceId, instanceId);
    assert.equal(persisted.type, "static");
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
          },
          AbortSignal.timeout(5_000),
        )
      ).credential;
    assert.equal(await resolve(), key);
    // Static custody has no renewal operation; refusal must leave the current value intact.
    await assert.rejects(
      owner.forceRefresh(
        {
          sourceRef: ref,
          tokenServiceInstanceId: instanceId,
        },
        AbortSignal.timeout(5_000),
      ),
      /static credential cannot be refreshed/i,
    );
    assert.equal(await resolve(), key);

    const updateSource = (actorId: string, input: UpdateManagedCredentialSourceInput) =>
      controller.updateManagedCredentialSource(
        actorId,
        { namespaceId, credentialSourceId: sourceId },
        input,
        (resource, phase) => event(actorId, "openclaw.credential_sources.update", resource, phase),
        (reasonCode) => ({
          ...event(actorId, "openclaw.credential_sources.update", ref),
          outcome: "failure",
          reasonCode,
        }),
      );
    const update = (actorId: string, credential: string) =>
      updateSource(actorId, { secret: { replacement: credential } });
    const sourceConfig = async () =>
      (await pool.query("SELECT config FROM occ.credential_sources WHERE id=$1", [sourceId]))
        .rows[0].config;
    await assert.rejects(
      updateSource(principal.id, { providerPreset: "unknown" as SourceProviderPresetId }),
      ScopeViolationError,
    );
    const replacementsBeforePreset = core.calls.replaceNamespacedSecret;
    const readsBeforePreset = core.reads;
    // Metadata and its attributable audit must commit together; custody is untouched.
    await withRejectedAuditRows(migrator, "openclaw.credential_sources.update", async () => {
      await assert.rejects(
        updateSource(principal.id, { providerPreset: "openai" }),
        AuditAppendUnavailableError,
      );
    });
    assert.deepEqual(await sourceConfig(), {});
    const presetUpdate = await updateSource(principal.id, { providerPreset: "openai" });
    assert.deepEqual(presetUpdate.config, { provider_preset: "openai" });
    assert.deepEqual(await sourceConfig(), { provider_preset: "openai" });
    assert.equal(core.calls.replaceNamespacedSecret, replacementsBeforePreset);
    assert.equal(core.reads, readsBeforePreset);
    // A mixed approval and material change is rejected before custody changes.
    await assert.rejects(
      updateSource(principal.id, {
        secret: { replacement: randomUUID() },
        providerPreset: null,
      }),
      ResourceStateConflictError,
    );
    assert.equal(await resolve(), key);
    assert.deepEqual(await sourceConfig(), { provider_preset: "openai" });
    assert.deepEqual(
      (
        await pool.query(
          "SELECT details->'providerPreset' AS preset FROM occ.audit_events WHERE action='openclaw.credential_sources.update' AND resource_id=$1 AND actor_id=$2",
          [sourceId, principal.id],
        )
      ).rows,
      [{ preset: "openai" }],
    );
    await updateSource(principal.id, { lifecycleConfig: { type: "static", settings: {} } });
    assert.deepEqual(await sourceConfig(), { provider_preset: "openai" });
    const replacementKey = randomUUID();
    await updateSource(principal.id, {
      secret: { replacement: replacementKey },
      providerPreset: "openai",
    });
    assert.equal(await resolve(), replacementKey);
    assert.deepEqual(await sourceConfig(), { provider_preset: "openai" });

    // Refusing the separately committed intent must stop the owner before private custody changes.
    await withRejectedAuditRows(
      migrator,
      "openclaw.credential_sources.update.started",
      async () => {
        await assert.rejects(update(principal.id, randomUUID()), AuditAppendUnavailableError);
      },
    );
    assert.equal(await resolve(), replacementKey);

    // Even if both completion and rollback audit writes fail after custody changes, the
    // authorized source-targeted intent remains attributable in the ledger.
    const committedKey = randomUUID();
    const intentCount = async () =>
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM occ.audit_events WHERE action='openclaw.credential_sources.update.started' AND resource_id=$1 AND actor_id=$2",
          [sourceId, principal.id],
        )
      ).rows[0].count as number;
    const beforeIntent = await intentCount();
    await withRejectedAuditRows(migrator, "openclaw.credential_sources.update", async () => {
      await assert.rejects(update(principal.id, committedKey), AuditAppendUnavailableError);
    });
    assert.equal(await resolve(), committedKey);
    assert.equal(await intentCount(), beforeIntent + 1);

    const account = await inject("POST", "/api/auth/accounts", {
      name: "Source updater",
      email: `source-${randomUUID()}@example.test`,
      password: randomUUID(),
    });
    assert.equal(account.statusCode, 201, account.body);
    const memberId: string = account.json().data.principalId;
    await assert.rejects(
      updateSource(memberId, { providerPreset: null }),
      AuthorizationDeniedError,
    );
    assert.deepEqual(await sourceConfig(), { provider_preset: "openai" });
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM occ.audit_events WHERE action='openclaw.credential_sources.update' AND resource_id=$1 AND actor_id=$2",
          [sourceId, memberId],
        )
      ).rows[0].count,
      0,
    );
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

    await updateSource(memberId, { providerPreset: null });
    assert.deepEqual(await sourceConfig(), {});
    assert.deepEqual(
      (
        await pool.query(
          "SELECT details ? 'providerPreset' AS recorded, details->'providerPreset' AS preset FROM occ.audit_events WHERE action='openclaw.credential_sources.update' AND resource_id=$1 AND actor_id=$2 AND details->'providerPreset' = 'null'::jsonb",
          [sourceId, memberId],
        )
      ).rows,
      [{ recorded: true, preset: null }],
    );

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
    // A failed completion audit must not commit Source metadata or creator-IAM removal.
    // Custody may already be removed; retaining deleting state permits an authorized retry.
    await withRejectedAuditRows(migrator, "openclaw.credential_sources.delete", async () => {
      await assert.rejects(retire(sourceId), AuditAppendUnavailableError);
    });
    assert.equal(
      (await pool.query("SELECT state FROM occ.credential_sources WHERE id=$1", [sourceId])).rows[0]
        .state,
      "deleting",
    );
    assert.deepEqual(await custodyRows(), [{ sources: 1, bindings: 1 }]);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM occ.audit_events WHERE action='openclaw.credential_sources.delete' AND resource_id=$1",
          [sourceId],
        )
      ).rows[0].count,
      0,
    );
    await retire(sourceId);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM occ.audit_events WHERE action='openclaw.credential_sources.delete' AND resource_id=$1 AND outcome='success'",
          [sourceId],
        )
      ).rows[0].count,
      1,
    );
    assert.equal(core.secrets.size, 1, "only the accepted orphan from the lost write remains");
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
