import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import {
  adminEmail,
  createDurableController,
  databaseUrl,
  parseJsonLines,
  pollUntil,
  request,
  requiresPostgres,
  spawnWorker,
  startController,
  verifyPlatformStateStoreContract,
} from "../helpers/postgres-platform-state.mjs";

async function ensureInstallation(state, name) {
  const existing = await state.loadInstallation();
  if (existing !== undefined) {
    return existing;
  }
  return state.transact((unit) =>
    unit.installations.createInstallation({
      id: `ins_${randomUUID()}`,
      name,
      createdAt: new Date().toISOString(),
    }),
  );
}

async function claimProvisioningWork(pool, idempotencyKey) {
  const claimToken = randomUUID();
  const claimed = await pool.query(
    `UPDATE occ.controller_work
     SET state = 'claimed',
         attempt_count = attempt_count + 1,
         claim_token = $2::uuid,
         lease_expires_at = clock_timestamp() + interval '10 minutes',
         updated_at = clock_timestamp()
     WHERE idempotency_key = $1
       AND work_kind = 'provisioning'
       AND state = 'queued'
     RETURNING idempotency_key`,
    [idempotencyKey, claimToken],
  );
  assert.equal(claimed.rowCount, 1, "test must claim the exact provisioning work item");
  return { idempotencyKey, claimToken };
}

test(
  "PostgreSQL rejects platform writes until the singleton Installation is bootstrapped",
  requiresPostgres,
  async (context) => {
    const [{ Pool }, { PostgresPlatformState }] = await Promise.all([
      import("pg"),
      import("../../packages/occ/src/state/postgres-state.ts"),
    ]);
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    const state = new PostgresPlatformState(pool);
    if ((await state.loadInstallation()) !== undefined) {
      context.skip("The configured PostgreSQL database has already been bootstrapped.");
      return;
    }

    const prematureWorker = await spawnWorker(context);
    const [prematureExit] = await once(prematureWorker.child, "exit", {
      signal: AbortSignal.timeout(10_000),
    });
    assert.notEqual(prematureExit, 0);
    const startupFailure = parseJsonLines(prematureWorker.output()).find(
      (line) => line.event === "worker.startup-error",
    );
    assert.ok(startupFailure, prematureWorker.output());
    assert.deepEqual(
      {
        severity: startupFailure.severity,
        service: startupFailure.service,
        event: startupFailure.event,
        code: startupFailure.code,
      },
      {
        severity: "ERROR",
        service: "occ-worker",
        event: "worker.startup-error",
        code: "WORKER_STARTUP_FAILED",
      },
    );

    const namespaceId = `ns_${randomUUID()}`;
    const agentId = `agt_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const namespace = { id: namespaceId, name: "Uninitialized", status: "provisioning", createdAt };
    const agent = {
      id: agentId,
      namespaceId,
      name: "Uninitialized agent",
      configurationId: `cfg_${randomUUID()}`,
      backendId: null,
      harnessAuth: null,
      draft_spec: {},
      executionMode: "embedded",
      servicePrincipalId: `service-agent-${randomUUID()}`,
      createdAt,
    };
    const revision = {
      id: `rev_${randomUUID()}`,
      namespaceId,
      agentId,
      revision: 1,
      backendId: null,
      configurationId: `cfg_${randomUUID()}`,
      configurationKind: "agent",
      configurationGeneration: 1,
      configuration: {},
      harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
      compute: {
        id: "compute-local-development",
        implementation: "deterministic-local-development",
      },
      servicePrincipalId: agent.servicePrincipalId,
      createdAt,
    };
    const operation = {
      kind: "namespace",
      action: "reconcile",
      target: "ready",
      namespaceId,
      resourceId: namespaceId,
      actorId: "principal-uninitialized",
    };
    const stateCounts = `SELECT
         (SELECT count(*)::integer FROM occ.installation) AS installations,
         (SELECT count(*)::integer FROM occ.namespaces) AS namespaces,
         (SELECT count(*)::integer FROM occ.agents) AS agents,
         (SELECT count(*)::integer FROM occ.agent_revisions) AS revisions,
         (SELECT count(*)::integer FROM occ.controller_work) AS work`;
    const baseline = await pool.query(stateCounts);
    assert.equal(baseline.rows[0].installations, 0);

    for (const write of [
      (transaction) => transaction.namespaces.createNamespace(namespace),
      (transaction) => transaction.agents.createAgent(agent),
      (transaction) => transaction.revisions.createRevision(revision),
      (transaction) => transaction.operations.append(operation),
      (transaction) => transaction.operations.list(),
    ]) {
      await assert.rejects(state.transact(write), { name: "ScopeViolationError" });
    }

    const persisted = await pool.query(stateCounts);
    assert.deepEqual(persisted.rows[0], baseline.rows[0]);
  },
);

test(
  "real OCC Namespace lifecycle persists provisioning, readiness, deletion, and its tombstone",
  requiresPostgres,
  async (context) => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    const process = await startController(context);
    const installation = await request(process, "GET", "/installation");
    if (installation.status === 404) {
      const bootstrapped = await request(process, "POST", "/installation/bootstrap", {
        name: "PostgreSQL namespace lifecycle integration",
      });
      assert.equal(bootstrapped.status, 201);
    } else {
      assert.equal(installation.status, 200);
    }
    const { controller } = await createDurableController(pool);
    const actor = await pool.query(
      `SELECT identity.id
       FROM occ.iam_identities AS identity
       JOIN occ."user" AS auth_user ON auth_user.id = identity.subject
       WHERE auth_user.email = $1`,
      [adminEmail],
    );
    assert.equal(actor.rowCount, 1);
    const principalId = actor.rows[0].id;

    const created = await request(process, "POST", "/namespaces", {
      name: `durable-lifecycle-${randomUUID()}`,
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.status, "provisioning");
    const namespaceId = created.data.id;

    const provisioning = await request(process, "GET", `/namespaces/${namespaceId}`);
    assert.equal(provisioning.status, 200);
    assert.deepEqual(provisioning.data, created.data);

    const persistedProvisioning = await pool.query(
      "SELECT status, deleted_at FROM occ.namespaces WHERE id = $1",
      [namespaceId],
    );
    assert.deepEqual(persistedProvisioning.rows, [{ status: "provisioning", deleted_at: null }]);
    const provisionWork = await pool.query(
      "SELECT namespace_target FROM occ.controller_work WHERE namespace_id = $1",
      [namespaceId],
    );
    assert.deepEqual(provisionWork.rows, [{ namespace_target: "ready" }]);

    const reconciled = await controller.handleNamespaceLifecycle(principalId, namespaceId, "ready");
    assert.equal(reconciled?.status, "ready");
    const ready = await request(process, "GET", `/namespaces/${namespaceId}`);
    assert.equal(ready.status, 200);
    assert.equal(ready.data.status, "ready");
    const persistedReady = await pool.query(
      "SELECT status, deleted_at FROM occ.namespaces WHERE id = $1",
      [namespaceId],
    );
    assert.deepEqual(persistedReady.rows, [{ status: "ready", deleted_at: null }]);

    const deleting = await request(process, "DELETE", `/namespaces/${namespaceId}`);
    assert.equal(deleting.status, 202);
    assert.equal(deleting.data.status, "deleting");
    const visibleDeletion = await request(process, "GET", `/namespaces/${namespaceId}`);
    assert.equal(visibleDeletion.status, 200);
    assert.equal(visibleDeletion.data.status, "deleting");
    const persistedDeleting = await pool.query(
      "SELECT status, deleted_at FROM occ.namespaces WHERE id = $1",
      [namespaceId],
    );
    assert.deepEqual(persistedDeleting.rows, [{ status: "deleting", deleted_at: null }]);

    const lifecycleWork = await pool.query(
      `SELECT idempotency_key, namespace_target
       FROM occ.controller_work WHERE namespace_id = $1 ORDER BY namespace_target`,
      [namespaceId],
    );
    assert.deepEqual(
      lifecycleWork.rows.map(({ namespace_target }) => namespace_target),
      ["deleted", "ready"],
    );
    assert.notEqual(lifecycleWork.rows[0].idempotency_key, lifecycleWork.rows[1].idempotency_key);

    const tombstoned = await controller.handleNamespaceLifecycle(
      principalId,
      namespaceId,
      "deleted",
    );
    assert.equal(tombstoned?.status, "deleting");
    assert.equal(typeof tombstoned?.deletedAt, "string");
    const persistedTombstone = await pool.query(
      "SELECT status, deleted_at FROM occ.namespaces WHERE id = $1",
      [namespaceId],
    );
    assert.equal(persistedTombstone.rowCount, 1);
    assert.equal(persistedTombstone.rows[0].status, "deleting");
    assert.ok(persistedTombstone.rows[0].deleted_at instanceof Date);
    assert.equal(persistedTombstone.rows[0].deleted_at.toISOString(), tombstoned.deletedAt);

    const hidden = await request(process, "GET", `/namespaces/${namespaceId}`);
    assert.equal(hidden.status, 404);
    const listed = await request(process, "GET", "/namespaces");
    assert.equal(listed.status, 200);
    assert.ok(listed.data.every(({ id }) => id !== namespaceId));

    const audits = await pool.query(
      "SELECT action, outcome FROM occ.audit_events WHERE resource_id = $1",
      [namespaceId],
    );
    assert.deepEqual(
      audits.rows.map(({ action }) => action).sort(),
      [
        "openclaw.namespaces.create",
        "openclaw.namespaces.delete",
        "openclaw.namespaces.lifecycle.delete",
        "openclaw.namespaces.lifecycle.ensure",
      ].sort(),
    );
    assert.ok(audits.rows.every(({ outcome }) => outcome === "success"));
  },
);

test(
  "PostgreSQL Agent provisioning persistence replays requests and fences checkpoints",
  requiresPostgres,
  async (context) => {
    const [{ Pool }, { PostgresPlatformState, PostgresWorkQueue }] = await Promise.all([
      import("pg"),
      import("../../packages/occ/src/index.ts"),
    ]);
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    const state = new PostgresPlatformState(pool);
    await ensureInstallation(state, "agent-provisioning");
    const createdAt = new Date().toISOString();
    const namespaceId = `ns_${randomUUID()}`;
    const configurationId = `cfg_${randomUUID()}`;
    const actorId = `principal-agent-provisioning-${randomUUID()}`;
    const workId = `agent-provisioning:${randomUUID()}:request-1`;

    await state.transact(async (unit) => {
      await unit.namespaces.createNamespace({
        id: namespaceId,
        name: `agent-provisioning-${randomUUID()}`,
        status: "ready",
        createdAt,
      });
    });

    const queue = new PostgresWorkQueue(pool);
    await queue.enqueue({
      kind: "provisioning",
      idempotencyKey: workId,
      namespaceId,
      actorId,
    });

    const createInput = {
      workId,
      namespaceId,
      actorId,
      requestId: "request-1",
      requestFingerprint: "a".repeat(64),
      plan: { configuration: { kind: "agent", values: { ok: true } } },
    };

    const created = await state.transact((unit) => unit.provisioning.create(createInput));
    assert.equal(created.replayed, false);
    assert.equal(created.record.status, "queued");

    const replay = await state.transact((unit) => unit.provisioning.create(createInput));
    assert.equal(replay.replayed, true);
    assert.equal(replay.record.workId, workId);

    await assert.rejects(
      state.transact((unit) =>
        unit.provisioning.create({ ...createInput, requestFingerprint: "b".repeat(64) }),
      ),
      { name: "ResourceConflictError" },
    );

    const claim = await claimProvisioningWork(pool, workId);
    const pendingConfiguration = {
      kind: "configuration",
      owner: randomUUID(),
      targetId: configurationId,
    };
    await assert.rejects(
      state.transact((unit) =>
        unit.provisioning.checkpoint(
          { idempotencyKey: workId, claimToken: randomUUID() },
          { completedPhase: "admitted", status: "running", configurationId },
        ),
      ),
      { name: "WorkClaimLostError" },
    );

    await assert.rejects(
      state.transact((unit) =>
        unit.provisioning.checkpoint(claim, {
          completedPhase: "admitted",
          status: "running",
          configurationId,
        }),
      ),
      { name: "ScopeViolationError" },
    );
    const pendingEffect = await state.transact((unit) =>
      unit.provisioning.beginEffect(claim, pendingConfiguration),
    );
    assert.equal(pendingEffect.configurationId, undefined);
    const actualPendingConfiguration = pendingEffect.progress.pendingEffect;
    assert.equal(actualPendingConfiguration.kind, "configuration");
    assert.equal(typeof actualPendingConfiguration.owner, "string");
    assert.equal(actualPendingConfiguration.targetId, configurationId);

    await assert.rejects(
      state.transact((unit) =>
        unit.provisioning.checkpoint(claim, {
          completedPhase: "configuration",
          status: "failed",
          configurationId,
        }),
      ),
      { name: "ScopeViolationError" },
    );

    const retrying = await state.transact((unit) =>
      unit.provisioning.recordFailure(
        claim,
        {
          completedPhase: "admitted",
          progress: { pendingEffect: actualPendingConfiguration },
        },
        {
          disposition: "retry",
          code: "PROVISIONING_DEPENDENCY_UNAVAILABLE",
          message: "retry after test dependency failure",
        },
      ),
    );
    assert.equal(retrying.status, "running");
    assert.equal(retrying.configurationId, undefined);
    const requeued = await pool.query(
      "SELECT state, completed_at, reason_code FROM occ.controller_work WHERE idempotency_key = $1",
      [workId],
    );
    assert.deepEqual(requeued.rows, [{ state: "queued", completed_at: null, reason_code: null }]);

    await pool.query(
      "UPDATE occ.controller_work SET available_at = clock_timestamp() WHERE idempotency_key = $1",
      [workId],
    );
    const secondClaim = await claimProvisioningWork(pool, workId);
    const settledBeforeFailure = await state.transact((unit) =>
      unit.provisioning.settleEffect(workId, {
        kind: "configuration",
        owner: actualPendingConfiguration.owner,
        targetId: actualPendingConfiguration.targetId,
      }),
    );
    assert.deepEqual(settledBeforeFailure.progress.effectReceipt, {
      kind: "configuration",
      owner: actualPendingConfiguration.owner,
      targetId: actualPendingConfiguration.targetId,
    });

    await state.transact((unit) =>
      unit.configurations.createConfiguration({
        id: configurationId,
        namespaceId,
        kind: "agent",
        generation: 1,
        values: { ok: true },
        createdAt,
      }),
    );

    const failed = await state.transact((unit) =>
      unit.provisioning.recordFailure(
        secondClaim,
        {
          completedPhase: "configuration",
          configurationId,
          progress: settledBeforeFailure.progress,
        },
        {
          disposition: "permanent",
          code: "PROVISIONING_REJECTED",
          message: "permanent test failure",
        },
      ),
    );
    assert.equal(failed.status, "failed");
    assert.deepEqual(
      failed.progress.effectReceipt,
      settledBeforeFailure.progress.effectReceipt,
      "permanent failures keep the exact receipt for authorized retry",
    );
    const failedWork = await pool.query(
      "SELECT state, reason_code FROM occ.controller_work WHERE idempotency_key = $1",
      [workId],
    );
    assert.deepEqual(failedWork.rows, [
      { state: "failed_permanent", reason_code: "PROVISIONING_REJECTED" },
    ]);

    const retried = await state.transact((unit) =>
      unit.provisioning.retryByWorkId(namespaceId, workId, actorId),
    );
    assert.equal(retried.status, "queued");
    assert.deepEqual(retried.progress.effectReceipt, settledBeforeFailure.progress.effectReceipt);
    const retryWork = await pool.query(
      "SELECT state, completed_at, reason_code FROM occ.controller_work WHERE idempotency_key = $1",
      [workId],
    );
    assert.deepEqual(retryWork.rows, [{ state: "queued", completed_at: null, reason_code: null }]);

    await pool.query(
      "UPDATE occ.controller_work SET available_at = clock_timestamp() WHERE idempotency_key = $1",
      [workId],
    );
    const terminalClaim = await claimProvisioningWork(pool, workId);
    const cancelled = await state.transact((unit) =>
      unit.provisioning.cancel(terminalClaim, {
        code: "PROVISIONING_CANCELLED",
        message: "cancelled by test",
      }),
    );
    assert.equal(cancelled.status, "cancelled");
    assert.deepEqual(cancelled.progress.effectReceipt, settledBeforeFailure.progress.effectReceipt);
    const terminal = await pool.query(
      "SELECT state, reason_code FROM occ.controller_work WHERE idempotency_key = $1",
      [workId],
    );
    assert.deepEqual(terminal.rows, [
      { state: "failed_permanent", reason_code: "PROVISIONING_CANCELLED" },
    ]);

    await assert.rejects(
      state.transact((unit) => unit.provisioning.retryByWorkId(namespaceId, workId, actorId)),
      { name: "ResourceConflictError" },
    );

    await assert.rejects(
      state.transact((unit) =>
        unit.provisioning.checkpoint(claim, {
          completedPhase: "admitted",
          status: "running",
          configurationId,
        }),
      ),
      { name: "ScopeViolationError" },
    );
  },
);

test(
  "PostgreSQL Agent provisioning success completes its queue row atomically",
  requiresPostgres,
  async (context) => {
    const [{ Pool }, { PostgresPlatformState, PostgresWorkQueue }] = await Promise.all([
      import("pg"),
      import("../../packages/occ/src/index.ts"),
    ]);
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    const state = new PostgresPlatformState(pool);
    await ensureInstallation(state, "agent-provisioning-success");
    const createdAt = new Date().toISOString();
    const namespaceId = `ns_${randomUUID()}`;
    const configurationId = `cfg_${randomUUID()}`;
    const agentId = `agt_${randomUUID()}`;
    const revisionId = `rev_${randomUUID()}`;
    const actorId = `principal-agent-provisioning-${randomUUID()}`;
    const workId = `agent-provisioning:${randomUUID()}:request-success`;

    await state.transact(async (unit) => {
      await unit.namespaces.createNamespace({
        id: namespaceId,
        name: `agent-provisioning-success-${randomUUID()}`,
        status: "ready",
        createdAt,
      });
      await unit.configurations.createConfiguration({
        id: configurationId,
        namespaceId,
        kind: "agent",
        generation: 1,
        createdAt,
      });
      await unit.agents.createAgent({
        id: agentId,
        namespaceId,
        name: "Provisioning success",
        configurationId,
        backendId: null,
        harnessAuth: { method: "runtime" },
        executionMode: "embedded",
        servicePrincipalId: `service-agent-${agentId}`,
        desiredRuntimeState: "stopped",
        status: "active",
        createdAt,
      });
      await unit.revisions.createRevision({
        id: revisionId,
        namespaceId,
        agentId,
        revision: 1,
        backendId: null,
        configurationId,
        configurationKind: "agent",
        configurationGeneration: 1,
        configuration: { agents: { defaults: { model: "test/model" } } },
        harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
        compute: { id: "compute-provisioning-success", implementation: "deterministic-test" },
        harnessAuth: { method: "runtime" },
        servicePrincipalId: `service-agent-${agentId}`,
        createdAt,
      });
    });

    const queue = new PostgresWorkQueue(pool);
    await queue.enqueue({
      kind: "provisioning",
      idempotencyKey: workId,
      namespaceId,
      actorId,
    });
    await state.transact((unit) =>
      unit.provisioning.create({
        workId,
        namespaceId,
        actorId,
        requestId: "request-success",
        requestFingerprint: "c".repeat(64),
        plan: { configuration: { kind: "agent", values: { ok: true } } },
      }),
    );

    const claim = await claimProvisioningWork(pool, workId);
    const succeeded = await state.transact((unit) =>
      unit.provisioning.checkpoint(claim, {
        completedPhase: "handoff",
        status: "succeeded",
        agentId,
        configurationId,
        revisionId,
      }),
    );
    assert.equal(succeeded.status, "succeeded");
    assert.equal(succeeded.revisionId, revisionId);
    const completed = await pool.query(
      "SELECT state, reason_code FROM occ.controller_work WHERE idempotency_key = $1",
      [workId],
    );
    assert.deepEqual(completed.rows, [{ state: "succeeded", reason_code: "PROVISIONING_HANDOFF" }]);
  },
);

test(
  "PostgreSQL Agent provisioning direct checkpoint still moves ordinary progress",
  requiresPostgres,
  async (context) => {
    const [{ Pool }, { PostgresPlatformState, PostgresWorkQueue }] = await Promise.all([
      import("pg"),
      import("../../packages/occ/src/index.ts"),
    ]);
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    const state = new PostgresPlatformState(pool);
    await ensureInstallation(state, "agent-provisioning-checkpoint");
    const createdAt = new Date().toISOString();
    const namespaceId = `ns_${randomUUID()}`;
    const configurationId = `cfg_${randomUUID()}`;
    const actorId = `principal-agent-provisioning-${randomUUID()}`;
    const workId = `agent-provisioning:${randomUUID()}:request-checkpoint`;

    await state.transact(async (unit) => {
      await unit.namespaces.createNamespace({
        id: namespaceId,
        name: `agent-provisioning-checkpoint-${randomUUID()}`,
        status: "ready",
        createdAt,
      });
    });

    const queue = new PostgresWorkQueue(pool);
    await queue.enqueue({
      kind: "provisioning",
      idempotencyKey: workId,
      namespaceId,
      actorId,
    });
    await state.transact((unit) =>
      unit.provisioning.create({
        workId,
        namespaceId,
        actorId,
        requestId: "request-checkpoint",
        requestFingerprint: "d".repeat(64),
        plan: { configuration: { kind: "agent", values: { ok: true } } },
      }),
    );

    const claim = await claimProvisioningWork(pool, workId);
    const pendingConfiguration = {
      kind: "configuration",
      owner: randomUUID(),
      targetId: configurationId,
    };
    await assert.rejects(
      state.transact((unit) =>
        unit.provisioning.checkpoint(claim, {
          completedPhase: "admitted",
          status: "running",
          configurationId,
        }),
      ),
      { name: "ScopeViolationError" },
    );
    const checkpointed = await state.transact((unit) =>
      unit.provisioning.beginEffect(claim, pendingConfiguration),
    );
    assert.equal(checkpointed.status, "running");
    assert.equal(checkpointed.configurationId, undefined);
    const actualPendingConfiguration = checkpointed.progress.pendingEffect;
    assert.equal(actualPendingConfiguration.kind, "configuration");
    assert.equal(typeof actualPendingConfiguration.owner, "string");
    assert.equal(actualPendingConfiguration.targetId, configurationId);
    await assert.rejects(
      state.transact((unit) =>
        unit.provisioning.checkpoint(claim, {
          completedPhase: "admitted",
          status: "running",
          configurationId,
          progress: {},
        }),
      ),
      { name: "ScopeViolationError" },
    );
    await assert.rejects(
      state.transact((unit) =>
        unit.provisioning.settleEffect(workId, {
          kind: "configuration",
          owner: `${actualPendingConfiguration.owner}-mismatch`,
          targetId: configurationId,
        }),
      ),
      { name: "ResourceConflictError" },
    );
    const receipted = await state.transact((unit) =>
      unit.provisioning.settleEffect(workId, {
        kind: "configuration",
        owner: actualPendingConfiguration.owner,
        targetId: configurationId,
      }),
    );
    assert.deepEqual(receipted.progress.pendingEffect, actualPendingConfiguration);
    assert.deepEqual(receipted.progress.effectReceipt, {
      kind: "configuration",
      owner: actualPendingConfiguration.owner,
      targetId: configurationId,
    });
    await state.transact((unit) =>
      unit.configurations.createConfiguration({
        id: configurationId,
        namespaceId,
        kind: "agent",
        generation: 1,
        values: { ok: true },
        createdAt,
      }),
    );
    const cleared = await state.transact((unit) =>
      unit.provisioning.checkpoint(claim, {
        completedPhase: "configuration",
        status: "running",
        configurationId,
        progress: {},
      }),
    );
    assert.deepEqual(cleared.progress, {});
  },
);

test(
  "PostgreSQL platform state satisfies memory adapter ownership, immutability, and atomicity",
  requiresPostgres,
  async (context) => {
    const [{ Pool }, { PostgresPlatformState }, { NativeIAMDriver }] = await Promise.all([
      import("pg"),
      import("../../packages/occ/src/state/postgres-state.ts"),
      import("../../packages/iam/src/index.ts"),
    ]);
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    const state = new PostgresPlatformState(pool);
    const installation = await state.loadInstallation();
    assert.ok(installation, "the prior API integration must bootstrap the sole Installation");

    const fixture = await verifyPlatformStateStoreContract(state, { installation });
    const durable = await pool.query(
      `SELECT
       (SELECT count(*)::integer FROM occ.agent_revisions WHERE id = $1) AS revisions,
       (SELECT count(*)::integer FROM occ.audit_events WHERE id = $2) AS audit_events,
       (SELECT count(*)::integer FROM occ.controller_work WHERE revision_id = $1) AS operations,
       (SELECT count(*)::integer FROM occ.namespaces
         WHERE id = $3 AND deleted_at IS NOT NULL) AS tombstones`,
      [fixture.revision.id, fixture.audit.id, fixture.lifecycleNamespace.id],
    );
    assert.deepEqual(durable.rows[0], {
      revisions: 1,
      audit_events: 1,
      operations: 1,
      tombstones: 1,
    });

    // The limited application role can insert Agents, so the database must reject
    // caller-selected running intent instead of relying on repository defaults.
    await assert.rejects(
      pool.query(
        `INSERT INTO occ.agents
           (id, namespace_id, name, configuration_id, backend_id, execution_mode,
            service_principal_id, desired_runtime_state, created_at)
         SELECT $1, namespace_id, $2, configuration_id, backend_id, execution_mode,
                $3, 'running', clock_timestamp()
         FROM occ.agents WHERE namespace_id = $4 AND id = $5`,
        [
          `agt_${randomUUID()}`,
          `Invalid running Agent ${randomUUID()}`,
          `service-agent-${randomUUID()}`,
          fixture.agent.namespaceId,
          fixture.agent.id,
        ],
      ),
      ({ code, constraint }) =>
        code === "23514" && constraint === "agent_initial_runtime_state_is_valid",
    );

    const durableAccount = await pool.query(
      "SELECT id, namespace_id, name, credential " + "FROM occ.service_accounts WHERE id = $1",
      [fixture.serviceAccount.id],
    );
    assert.deepEqual(durableAccount.rows, [
      {
        id: fixture.serviceAccount.id,
        namespace_id: fixture.serviceAccountNamespace.id,
        name: fixture.serviceAccount.name,
        credential: fixture.serviceAccount.credential,
      },
    ]);

    // Prove exact source scope at the actual SQL boundary, independent of OCC admission.
    for (const [binding, code, constraint] of [
      [
        {
          method: "api_key",
          source: {
            ...fixture.agent.harnessAuth.source,
            namespaceId: fixture.serviceAccountNamespace.id,
          },
        },
        "23514",
        "agents_harness_auth_valid",
      ],
      [
        {
          method: "api_key",
          source: { kind: "secret", namespaceId: fixture.namespace.id, id: `sec_${randomUUID()}` },
        },
        "23503",
        "agents_harness_auth_secret_owner",
      ],
      [
        { method: "chatgpt_service_account", serviceAccountId: fixture.serviceAccount.id },
        "23503",
        "agents_harness_auth_service_account_owner",
      ],
      [
        { ...fixture.agent.harnessAuth, value: "sentinel-not-a-reference" },
        "23514",
        "agents_harness_auth_valid",
      ],
      ["api_key", "23514", "agents_harness_auth_valid"],
    ]) {
      await assert.rejects(
        pool.query("UPDATE occ.agents SET harness_auth = $1::jsonb WHERE id = $2", [
          JSON.stringify(binding),
          fixture.agent.id,
        ]),
        (error) => error.code === code && error.constraint === constraint,
      );
    }
    assert.deepEqual(
      (await state.read((view) => view.agents.findAgent(fixture.namespace.id, fixture.agent.id)))
        .harnessAuth,
      fixture.agent.harnessAuth,
    );
    for (const [offset, invalid] of [
      null,
      {},
      { ...fixture.revision.harnessAuth, secretDriverId: "" },
      { ...fixture.revision.harnessAuth, secretValue: "sentinel-not-a-reference" },
    ].entries()) {
      await assert.rejects(
        pool.query(
          `INSERT INTO occ.agent_revisions
        (id, namespace_id, agent_id, revision_number, backend_id, admitted_spec, admitted_at)
        SELECT $1, namespace_id, agent_id, $2, backend_id,
          jsonb_set(admitted_spec, '{harness_auth}', $3::jsonb), admitted_at
        FROM occ.agent_revisions WHERE id = $4`,
          [`rev_${randomUUID()}`, 1000 + offset, JSON.stringify(invalid), fixture.revision.id],
        ),
        ({ code, constraint }) =>
          code === "23514" && constraint === "agent_revisions_admitted_snapshot",
      );
    }

    const sandboxDriverId = "openshell-sandbox";
    const sandboxRevision = await state.transact((unit) =>
      unit.revisions.createRevision({
        ...fixture.revision,
        id: `rev_${randomUUID()}`,
        revision: fixture.revision.revision + 1,
        sandboxDriverId,
      }),
    );
    const reloadedSandboxRevision = await state.read((unit) =>
      unit.revisions.findRevision(
        sandboxRevision.namespaceId,
        sandboxRevision.agentId,
        sandboxRevision.id,
      ),
    );
    assert.ok(reloadedSandboxRevision);
    assert.equal(reloadedSandboxRevision.sandboxDriverId, sandboxDriverId);
    assert.equal(Object.isFrozen(reloadedSandboxRevision), true);
    const durableSandboxRevision = await pool.query(
      "SELECT admitted_spec FROM occ.agent_revisions WHERE id = $1",
      [sandboxRevision.id],
    );
    assert.equal(durableSandboxRevision.rows[0].admitted_spec.sandbox_driver_id, sandboxDriverId);
    assert.equal(Object.hasOwn(durableSandboxRevision.rows[0].admitted_spec, "sandbox"), false);

    // The database accepts only a nonempty SandboxDriver identity, not descriptors or blank values.
    for (const [offset, invalid] of [null, "", " ", 1, { id: sandboxDriverId }].entries()) {
      await assert.rejects(
        pool.query(
          `INSERT INTO occ.agent_revisions
             (id, namespace_id, agent_id, revision_number, admitted_spec, admitted_at)
           SELECT $2, namespace_id, agent_id, $3,
                  jsonb_set(admitted_spec, '{sandbox_driver_id}', $1::jsonb, true), admitted_at
           FROM occ.agent_revisions WHERE id = $4`,
          [
            JSON.stringify(invalid),
            `rev_${randomUUID()}`,
            sandboxRevision.revision + 100 + offset,
            sandboxRevision.id,
          ],
        ),
        ({ code, constraint }) =>
          code === "23514" && constraint === "agent_revisions_admitted_snapshot",
      );
    }

    // The database, not adapter-only validation, rejects malformed or cross-scope credential JSON.
    for (const invalid of [
      null,
      {},
      { kind: "api_key", secretRef: { name: "valid-source" } },
      { kind: "bearer", secretRef: { name: "valid-source", key: "api-key" } },
      { kind: "api_key", secretRef: { name: "INVALID", key: "api-key" } },
      ...["../token", ".", ".."].map((key) => ({
        kind: "api_key",
        secretRef: { name: "valid-source", key },
      })),
      {
        kind: "api_key",
        secretRef: { name: "valid-source", key: "api-key", namespace: "another-tenant" },
      },
      {
        kind: "api_key",
        secretRef: { name: "valid-source", key: "api-key" },
        token: "plaintext-must-not-persist",
      },
    ]) {
      await assert.rejects(
        pool.query("UPDATE occ.service_accounts SET credential = $1::jsonb WHERE id = $2", [
          JSON.stringify(invalid),
          fixture.serviceAccount.id,
        ]),
        ({ code, constraint }) =>
          code === "23514" && constraint === "service_accounts_credential_valid",
      );
    }

    const accountPrivileges = await pool.query(
      "SELECT " +
        "has_table_privilege(current_user, 'occ.service_accounts', 'SELECT') AS can_read, " +
        "has_table_privilege(current_user, 'occ.service_accounts', 'INSERT') AS can_insert, " +
        "has_table_privilege(current_user, 'occ.service_accounts', 'DELETE') AS can_delete, " +
        "has_column_privilege(current_user, 'occ.service_accounts', 'credential', 'UPDATE') " +
        "AS can_update_credential, " +
        "has_column_privilege(current_user, 'occ.service_accounts', 'id', 'UPDATE') " +
        "AS can_update_identity, " +
        "has_column_privilege(current_user, 'occ.service_accounts', 'namespace_id', 'UPDATE') " +
        "AS can_update_owner",
    );
    assert.deepEqual(accountPrivileges.rows, [
      {
        can_read: true,
        can_insert: true,
        can_delete: true,
        can_update_credential: true,
        can_update_identity: false,
        can_update_owner: false,
      },
    ]);

    const principalId = `principal-${randomUUID()}`;
    const groupId = `group-${randomUUID()}`;
    const roleId = `role-${randomUUID()}`;
    const sharedRoleId = `role-${randomUUID()}`;
    const bindingId = `binding-${randomUUID()}`;
    const agentBindingId = `binding-${randomUUID()}`;
    const restrictionId = `restriction-${randomUUID()}`;
    const accountRoleId = "role-" + randomUUID();
    const accountBindingId = "binding-" + randomUUID();
    const accountCreationBindingId = "binding-" + randomUUID();
    const accountRestrictionId = "restriction-" + randomUUID();
    const platformActions = [
      "create",
      "read",
      "update",
      "delete",
      "deploy",
      "operate",
      "administer",
    ];
    const siblingId = `agt_${randomUUID()}`;
    const sibling = await state.transact((unit) =>
      unit.agents.createAgent({
        id: siblingId,
        namespaceId: fixture.namespace.id,
        name: `Sibling ${randomUUID()}`,
        configurationId: fixture.configuration.id,
        backendId: null,
        harnessAuth: null,
        executionMode: "embedded",
        servicePrincipalId: `service-agent-${siblingId}`,
        createdAt: new Date().toISOString(),
      }),
    );
    await state.seedNativeIAM({
      identities: [
        {
          id: principalId,
          kind: "principal",
          issuer: `postgres-platform-${randomUUID()}`,
          subject: `principal-${randomUUID()}`,
        },
      ],
      groups: [
        {
          id: groupId,
          namespaceId: fixture.namespace.id,
          name: `Operators ${randomUUID()}`,
        },
      ],
      memberships: [
        {
          namespaceId: fixture.namespace.id,
          groupId,
          principalId,
        },
      ],
      roles: [
        {
          id: roleId,
          namespaceId: fixture.namespace.id,
          name: `Reader ${randomUUID()}`,
          permissions: [{ action: "read", resourceKind: "agent" }],
        },
        {
          id: sharedRoleId,
          namespaceId: fixture.namespace.id,
          name: `Agent operators ${randomUUID()}`,
          permissions: platformActions.map((action) => ({ action, resourceKind: "agent" })),
        },
        {
          id: accountRoleId,
          namespaceId: fixture.serviceAccountNamespace.id,
          name: "Exact account access " + randomUUID(),
          permissions: [
            { action: "create", resourceKind: "service_account" },
            { action: "read", resourceKind: "service_account" },
            { action: "update", resourceKind: "service_account" },
          ],
        },
      ],
      bindings: [
        {
          id: bindingId,
          namespaceId: fixture.namespace.id,
          subjectKind: "group",
          subjectId: groupId,
          roleId,
          resourceKind: "agent",
          resourceId: fixture.agent.id,
        },
        {
          id: `binding-${randomUUID()}`,
          namespaceId: fixture.namespace.id,
          subjectKind: "identity",
          subjectId: principalId,
          roleId: sharedRoleId,
        },
        {
          id: accountBindingId,
          namespaceId: fixture.serviceAccountNamespace.id,
          subjectKind: "identity",
          subjectId: principalId,
          roleId: accountRoleId,
          resourceKind: "service_account",
          resourceId: fixture.serviceAccount.id,
        },
        {
          id: accountCreationBindingId,
          namespaceId: fixture.serviceAccountNamespace.id,
          subjectKind: "identity",
          subjectId: principalId,
          roleId: accountRoleId,
          resourceKind: "service_account",
          resourceId: fixture.serviceAccountNamespace.id,
        },
      ],
      restrictions: [
        {
          id: restrictionId,
          namespaceId: fixture.namespace.id,
          action: "deploy",
          resourceKind: "agent",
          resourceId: fixture.agent.id,
          effect: "deny",
        },
        {
          id: accountRestrictionId,
          namespaceId: fixture.serviceAccountNamespace.id,
          action: "update",
          resourceKind: "service_account",
          resourceId: fixture.serviceAccount.id,
          effect: "deny",
        },
      ],
    });
    await pool.query(
      `INSERT INTO occ.iam_access_bindings
       (id, namespace_id, identity_subject_id, role_id)
       VALUES ($1, $2, $3, $4)`,
      [agentBindingId, fixture.namespace.id, fixture.agent.servicePrincipalId, sharedRoleId],
    );

    const reopened = new PostgresPlatformState(pool);
    await reopened.read(async (view) => {
      const revision = await view.revisions.findRevision(
        fixture.namespace.id,
        fixture.agent.id,
        fixture.revision.id,
      );
      assert.deepEqual(revision, fixture.revision);
    });
    const reloadedIAM = await reopened.loadNativeIAMState(installation.id);
    assert.deepEqual(
      reloadedIAM.identities.find(({ id }) => id === fixture.agent.servicePrincipalId),
      {
        id: fixture.agent.servicePrincipalId,
        kind: "service_principal",
        namespaceId: fixture.namespace.id,
        agentId: fixture.agent.id,
      },
      "The Agent service principal and its exact owner survive a PostgreSQL restart.",
    );
    assert.ok(
      reloadedIAM.identities.every((identity) => !Object.hasOwn(identity, "installationId")),
    );
    assert.ok(reloadedIAM.groups.some(({ id }) => id === groupId));
    assert.ok(
      reloadedIAM.memberships.some(
        ({ groupId: storedGroupId, principalId: storedPrincipalId }) =>
          storedGroupId === groupId && storedPrincipalId === principalId,
      ),
    );
    assert.ok(
      reloadedIAM.bindings.some(
        ({ id, subjectKind }) => id === bindingId && subjectKind === "group",
      ),
    );
    assert.ok(
      reloadedIAM.bindings.some(
        ({ id, subjectId }) =>
          id === agentBindingId && subjectId === fixture.agent.servicePrincipalId,
      ),
    );
    assert.ok(reloadedIAM.restrictions.some(({ id }) => id === restrictionId));
    assert.ok(
      reloadedIAM.bindings.some(
        ({ id, resourceKind, resourceId }) =>
          id === accountBindingId &&
          resourceKind === "service_account" &&
          resourceId === fixture.serviceAccount.id,
      ),
    );
    assert.ok(
      reloadedIAM.bindings.some(
        ({ id, resourceKind, resourceId }) =>
          id === accountCreationBindingId &&
          resourceKind === "service_account" &&
          resourceId === fixture.serviceAccountNamespace.id,
      ),
    );
    assert.ok(
      reloadedIAM.restrictions.some(
        ({ id, resourceKind }) => id === accountRestrictionId && resourceKind === "service_account",
      ),
    );

    const iam = new NativeIAMDriver(reopened);
    assert.equal(
      (
        await iam.authorize({
          principalId,
          action: "create",
          resource: {
            kind: "service_account",
            id: fixture.serviceAccountNamespace.id,
            namespaceId: fixture.serviceAccountNamespace.id,
          },
        })
      ).allowed,
      true,
      "An exact persisted collection binding authorizes ServiceAccount creation.",
    );
    assert.equal(
      (
        await iam.authorize({
          principalId,
          action: "read",
          resource: {
            kind: "service_account",
            id: fixture.serviceAccount.id,
            namespaceId: fixture.serviceAccountNamespace.id,
          },
        })
      ).allowed,
      true,
      "An exact persisted account binding grants only the named account.",
    );
    assert.equal(
      (
        await iam.authorize({
          principalId,
          action: "update",
          resource: {
            kind: "service_account",
            id: fixture.serviceAccount.id,
            namespaceId: fixture.serviceAccountNamespace.id,
          },
        })
      ).allowed,
      false,
      "An exact persisted account Restriction overrides its granted update.",
    );
    for (const identityId of [principalId, fixture.agent.servicePrincipalId]) {
      for (const action of platformActions) {
        const ownAgentDecision = await iam.authorize({
          principalId: identityId,
          action,
          resource: {
            kind: "agent",
            id: fixture.agent.id,
            namespaceId: fixture.namespace.id,
          },
        });
        assert.equal(
          ownAgentDecision.allowed,
          action !== "deploy",
          `${identityId} should receive its granted ${action} action unless an exact Restriction denies it`,
        );

        const siblingDecision = await iam.authorize({
          principalId: identityId,
          action,
          resource: { kind: "agent", id: sibling.id, namespaceId: fixture.namespace.id },
        });
        assert.equal(
          siblingDecision.allowed,
          true,
          `${identityId} should receive its granted ${action} action for a same-Namespace sibling`,
        );
      }

      const foreignNamespaceDecision = await iam.authorize({
        principalId: identityId,
        action: "read",
        resource: {
          kind: "agent",
          id: `agt_${randomUUID()}`,
          namespaceId: `ns_${randomUUID()}`,
        },
      });
      assert.equal(foreignNamespaceDecision.allowed, false);
    }
  },
);

test(
  "PostgreSQL persists Agent plugin desired state and immutable revision snapshots atomically",
  requiresPostgres,
  async (context) => {
    const [
      { Pool },
      { OCCPluginDriver },
      { PostgresPlatformState },
      { createTestConfigurationDriver },
    ] = await Promise.all([
      import("pg"),
      import("../../apps/controller/src/drivers/plugin/index.ts"),
      import("../../packages/occ/src/state/postgres-state.ts"),
      import("../helpers/configuration-driver.mjs"),
    ]);
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    await startController(context);

    const bootstrapState = new PostgresPlatformState(pool);
    const installation = await bootstrapState.loadInstallation();
    assert.ok(installation, "the real OCC subprocess must bootstrap the singleton Installation");
    const actor = await pool.query(
      `SELECT identity.id
       FROM occ.iam_identities AS identity
       JOIN occ."user" AS auth_user ON auth_user.id = identity.subject
       WHERE auth_user.email = $1`,
      [adminEmail],
    );
    assert.equal(actor.rowCount, 1);
    const principalId = actor.rows[0].id;

    const { controller, state, resolveHarness } = await createDurableController(pool);
    const configurationDriver = createTestConfigurationDriver({
      id: `configuration-plugin-${randomUUID()}`,
    });
    const { createTestSecretDriver } = await import("../helpers/secret-driver.mjs");
    const harnessSecretDriver = createTestSecretDriver();
    controller.registerDriver(harnessSecretDriver);
    controller.selectDriver("secret", harnessSecretDriver.id);
    const pluginDriver = new OCCPluginDriver();
    controller.registerDriver(configurationDriver);
    controller.selectDriver("configuration", configurationDriver.id);
    controller.registerDriver(pluginDriver);
    controller.selectDriver("plugin", pluginDriver.id);

    const namespace = await controller.createNamespace(principalId, {
      name: `postgres-plugin-${randomUUID()}`,
    });
    const configuration = await controller.createConfiguration(principalId, {
      namespaceId: namespace.id,
      kind: "agent",
      values: {},
    });
    const replacementConfiguration = await controller.createConfiguration(principalId, {
      namespaceId: namespace.id,
      kind: "agent",
      values: { runtime: { revision: "replacement" } },
    });
    const initialPlugins = {
      "occ-plugin:diffs": {
        enabled: true,
        approvers: [{ channel: "slack", id: "team:T123:user:U123" }],
        toolDefaults: { enabled: false, approval: "approve" },
        tools: { diffs: { enabled: true, approvers: [] } },
      },
    };
    const malformedCreateAgentId = `agt_${randomUUID()}`;
    await assert.rejects(
      state.transact((unit) =>
        unit.agents.createAgent({
          id: malformedCreateAgentId,
          namespaceId: namespace.id,
          name: `postgres-plugin-malformed-agent-${randomUUID()}`,
          configurationId: configuration.id,
          backendId: null,
          harnessAuth: null,
          executionMode: "embedded",
          servicePrincipalId: `service-agent-${malformedCreateAgentId}`,
          plugins: {
            "occ-plugin:diffs": { enabled: true, toolDefaults: { approval: "sometimes" } },
          },
          createdAt: new Date().toISOString(),
        }),
      ),
      { name: "ScopeViolationError" },
    );
    const malformedCreateRow = await pool.query("SELECT plugins FROM occ.agents WHERE id = $1", [
      malformedCreateAgentId,
    ]);
    assert.equal(malformedCreateRow.rowCount, 0);

    let escapedUnit;
    const agent = await controller.transact(async (unit) => {
      escapedUnit = unit;
      return controller.createAgent(principalId, {
        namespaceId: namespace.id,
        name: `postgres-plugin-agent-${randomUUID()}`,
        configurationId: configuration.id,
        plugins: initialPlugins,
        pluginApprovers: [],
      });
    });
    // An Agent mutation may share its caller's transaction, but the borrowed
    // handle cannot change that Agent after the controller publishes the result.
    await assert.rejects(
      escapedUnit.agents.updateConfiguration(namespace.id, agent.id, replacementConfiguration.id),
      { name: "ScopeViolationError" },
    );
    const persistedAgent = await state.read((view) =>
      view.agents.findAgent(namespace.id, agent.id),
    );
    assert.equal(persistedAgent.configurationId, configuration.id);
    assert.deepEqual(persistedAgent.pluginApprovers, []);

    const storedSelection = await pool.query(
      "SELECT plugins, plugin_approvers FROM occ.agents WHERE id = $1",
      [agent.id],
    );
    assert.deepEqual(storedSelection.rows[0].plugins, initialPlugins);
    assert.deepEqual(storedSelection.rows[0].plugin_approvers, []);
    const stateBeforeFailure = await state.read((view) =>
      view.agents.findAgent(namespace.id, agent.id),
    );
    const auditBeforeFailure = await pool.query(
      "SELECT count(*)::integer AS count FROM occ.audit_events",
    );
    const stagedAuditId = `aud_${randomUUID()}`;

    await assert.rejects(
      controller.transact(async (unit) => {
        await unit.audit.append({
          schemaVersion: 1,
          id: stagedAuditId,
          installationId: installation.id,
          namespaceId: namespace.id,
          occurredAt: new Date().toISOString(),
          source: "occ",
          kind: "mutation",
          actorId: principalId,
          actor: { principalId },
          action: "openclaw.agents.update",
          resource: { kind: "agent", id: agent.id, namespaceId: namespace.id },
          outcome: "success",
        });
        await unit.agents.updateConfiguration(
          namespace.id,
          agent.id,
          configuration.id,
          undefined,
          undefined,
          undefined,
          { "occ-plugin:diffs": { enabled: true, approvalMode: "always" } },
        );
      }),
      { name: "ScopeViolationError" },
    );

    const [stateAfterFailure, auditAfterFailure, stagedAudit] = await Promise.all([
      state.read((view) => view.agents.findAgent(namespace.id, agent.id)),
      pool.query("SELECT count(*)::integer AS count FROM occ.audit_events"),
      pool.query("SELECT count(*)::integer AS count FROM occ.audit_events WHERE id = $1", [
        stagedAuditId,
      ]),
    ]);
    assert.deepEqual(stateAfterFailure.plugins, stateBeforeFailure.plugins);
    assert.equal(auditAfterFailure.rows[0].count, auditBeforeFailure.rows[0].count);
    assert.equal(stagedAudit.rows[0].count, 0);

    await controller.handleNamespaceLifecycle(principalId, namespace.id, "ready");
    const harnessSecret = await controller.createSecret(principalId, {
      namespaceId: namespace.id,
      name: `plugin-harness-${randomUUID()}`,
      value: "synthetic-persistence-key",
    });
    await controller.updateAgent(principalId, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: configuration.id,
      harnessAuth: {
        method: "api_key",
        source: { kind: "secret", namespaceId: namespace.id, id: harnessSecret.id },
      },
    });
    const harnessRoleId = `role-${randomUUID()}`;
    await pool.query(
      "INSERT INTO occ.iam_roles(id, namespace_id, name, permissions) VALUES($1, $2, $3, $4::jsonb)",
      [
        harnessRoleId,
        namespace.id,
        "Harness Secret consumer",
        JSON.stringify([{ action: "operate", resourceKind: "secret" }]),
      ],
    );
    await pool.query(
      "INSERT INTO occ.iam_access_bindings(id, namespace_id, identity_subject_id, role_id, resource_kind, resource_id) VALUES($1, $2, $3, $4, 'secret', $5)",
      [
        `binding-${randomUUID()}`,
        namespace.id,
        agent.servicePrincipalId,
        harnessRoleId,
        harnessSecret.id,
      ],
    );
    const revision = await controller.deployAgent(
      principalId,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveHarness,
    );
    assert.deepEqual(revision.plugins, {
      driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
      plugins: initialPlugins,
    });
    assert.deepEqual(revision.pluginApprovers, []);
    assert.equal(Object.hasOwn(revision.plugins, "artifacts"), false);
    const omittedPlugins = await controller.updateAgent(principalId, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: replacementConfiguration.id,
    });
    assert.deepEqual(omittedPlugins.plugins, initialPlugins);
    assert.deepEqual(omittedPlugins.pluginApprovers, []);
    const replacementPlugins = {
      "occ-plugin:diffs": {
        enabled: true,
        toolDefaults: { approval: "native" },
        tools: { diffs: { approval: "approve" } },
      },
    };
    const replacedPlugins = await controller.updateAgent(principalId, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: replacementConfiguration.id,
      plugins: replacementPlugins,
      pluginApprovers: [{ channel: "slack", id: "team:T123:user:U456" }],
    });
    assert.deepEqual(replacedPlugins.plugins, replacementPlugins);
    assert.deepEqual(replacedPlugins.pluginApprovers, [
      { channel: "slack", id: "team:T123:user:U456" },
    ]);
    const clearedPlugins = await controller.updateAgent(principalId, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: replacementConfiguration.id,
      plugins: {},
    });
    assert.deepEqual(clearedPlugins.plugins, {});
    assert.deepEqual(clearedPlugins.pluginApprovers, [
      { channel: "slack", id: "team:T123:user:U456" },
    ]);

    const [reloadedAgent, reloadedRevision] = await state.read(async (view) => [
      await view.agents.findAgent(namespace.id, agent.id),
      await view.revisions.findRevision(namespace.id, agent.id, revision.id),
    ]);
    assert.deepEqual(reloadedAgent.plugins, {});
    assert.deepEqual(reloadedAgent.pluginApprovers, [
      { channel: "slack", id: "team:T123:user:U456" },
    ]);
    assert.deepEqual(reloadedRevision.plugins.plugins, initialPlugins);
    assert.deepEqual(reloadedRevision.pluginApprovers, []);

    const durableRevision = await pool.query(
      "SELECT admitted_spec FROM occ.agent_revisions WHERE id = $1",
      [revision.id],
    );
    assert.deepEqual(durableRevision.rows[0].admitted_spec.plugins, revision.plugins);
    assert.deepEqual(durableRevision.rows[0].admitted_spec.plugin_approvers, []);

    const clearedApprovers = await controller.updateAgent(principalId, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: replacementConfiguration.id,
      pluginApprovers: null,
    });
    assert.equal(Object.hasOwn(clearedApprovers, "pluginApprovers"), false);
    const storedApprovers = await pool.query(
      "SELECT plugin_approvers FROM occ.agents WHERE id = $1",
      [agent.id],
    );
    assert.equal(storedApprovers.rows[0].plugin_approvers, null);

    const malformedPlugins = {
      ...revision.plugins,
      artifacts: {
        kind: "openclaw",
        configuration: {},
        installs: [
          {
            pluginId: "occ-plugin:diffs",
            nativeId: "diffs",
            version: "2026.8.2",
          },
        ],
      },
    };
    const malformedRevisionId = `rev_${randomUUID()}`;
    const revisionCountBeforeMalformed = await pool.query(
      "SELECT count(*)::integer AS count FROM occ.agent_revisions WHERE agent_id = $1",
      [agent.id],
    );
    await assert.rejects(
      state.transact((unit) =>
        unit.revisions.createRevision({
          ...revision,
          id: malformedRevisionId,
          revision: revision.revision + 1,
          plugins: malformedPlugins,
        }),
      ),
      { name: "ScopeViolationError" },
    );
    const revisionCountAfterMalformed = await pool.query(
      "SELECT count(*)::integer AS count FROM occ.agent_revisions WHERE agent_id = $1",
      [agent.id],
    );
    assert.equal(
      revisionCountAfterMalformed.rows[0].count,
      revisionCountBeforeMalformed.rows[0].count,
    );

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO occ.agent_revisions
           (id, namespace_id, agent_id, revision_number, backend_id, admitted_spec, admitted_at)
         SELECT $1, namespace_id, agent_id, revision_number + 1000, backend_id,
                jsonb_set(admitted_spec, '{plugins}', $2::jsonb, false), admitted_at
         FROM occ.agent_revisions WHERE id = $3`,
        [malformedRevisionId, JSON.stringify(malformedPlugins), revision.id],
      );
      const transactionState = new PostgresPlatformState({
        async connect() {
          return {
            async query(statement, parameters) {
              if (/^(BEGIN|COMMIT|ROLLBACK)\b/.test(statement)) {
                return { rows: [], rowCount: null };
              }
              return client.query(statement, parameters);
            },
            release() {},
          };
        },
        async end() {},
      });
      await assert.rejects(
        transactionState.read((view) =>
          view.revisions.findRevision(namespace.id, agent.id, malformedRevisionId),
        ),
        { name: "DependencyUnavailableError" },
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  },
);

test(
  "the PostgreSQL worker reloads exact Namespace restrictions and never dispatches revoked provisioning",
  requiresPostgres,
  async (context) => {
    const [{ Pool }, { createControllerWorker }, { createDevelopmentComputeDriver }] =
      await Promise.all([
        import("pg"),
        import("../../apps/controller/src/worker.ts"),
        import("../helpers/development.mjs"),
      ]);
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    const api = await startController(context);

    const installation = await request(api, "GET", "/installation");
    if (installation.status === 404) {
      const created = await request(api, "POST", "/installation/bootstrap", {
        name: "Revoked provisioning integration",
      });
      assert.equal(created.status, 201);
    } else {
      assert.equal(installation.status, 200);
    }
    const actor = await pool.query(
      `SELECT identity.id
       FROM occ.iam_identities AS identity
       JOIN occ."user" AS auth_user ON auth_user.id = identity.subject
       WHERE auth_user.email = $1`,
      [adminEmail],
    );
    assert.equal(actor.rowCount, 1);
    const principalId = actor.rows[0].id;

    const namespace = await request(api, "POST", "/namespaces", {
      name: `revoked-before-dispatch-${randomUUID()}`,
    });
    assert.equal(namespace.status, 201);
    const authorizedNamespace = await request(api, "POST", "/namespaces", {
      name: `authorized-positive-control-${randomUUID()}`,
    });
    assert.equal(authorizedNamespace.status, 201);

    const restrictionId = `restriction-worker-${randomUUID()}`;
    await pool.query(
      `INSERT INTO occ.iam_restrictions
       (id, namespace_id, action, resource_kind, resource_id, effect)
       VALUES ($1, $2, 'create', 'namespace', $2, 'deny')`,
      [restrictionId, namespace.data.id],
    );

    const observedComputeEffects = [];
    const developmentCompute = createDevelopmentComputeDriver();
    const worker = createControllerWorker({
      pool: new Pool({ connectionString: databaseUrl }),
      pollIntervalMs: 20,
      computeDriver: {
        ...developmentCompute,
        async ensureNamespace(candidate) {
          observedComputeEffects.push(candidate.id);
          return developmentCompute.ensureNamespace(candidate);
        },
      },
      emit() {},
    });
    context.after(() => worker.stop());
    await worker.start();

    const rejected = await pollUntil(
      `revoked provisioning for Namespace ${namespace.data.id} to fail permanently`,
      async () => {
        const rows = await pool.query(
          `SELECT state, attempt_count FROM occ.controller_work
           WHERE namespace_id = $1 AND namespace_target = 'ready'`,
          [namespace.data.id],
        );
        assert.equal(rows.rowCount, 1);
        return rows.rows[0].state === "failed_permanent" ? rows.rows[0] : undefined;
      },
    );
    assert.equal(rejected.attempt_count, 1);

    await pollUntil(
      `authorized positive-control Namespace ${authorizedNamespace.data.id} to become ready`,
      async () => {
        const rows = await pool.query("SELECT status FROM occ.namespaces WHERE id = $1", [
          authorizedNamespace.data.id,
        ]);
        assert.equal(rows.rowCount, 1);
        return rows.rows[0].status === "ready" ? rows.rows[0] : undefined;
      },
    );
    assert.ok(
      observedComputeEffects.includes(authorizedNamespace.data.id),
      "the positive-control Namespace must invoke the injected ComputeDriver",
    );
    assert.ok(
      !observedComputeEffects.includes(namespace.data.id),
      "denied provisioning must not invoke the injected ComputeDriver",
    );

    const persistedNamespace = await pool.query(
      "SELECT status, deleted_at FROM occ.namespaces WHERE id = $1",
      [namespace.data.id],
    );
    assert.deepEqual(persistedNamespace.rows, [{ status: "failed", deleted_at: null }]);

    const lifecycleEffects = await pool.query(
      `SELECT action, outcome, actor_id FROM occ.audit_events
       WHERE resource_id = $1 AND action = 'openclaw.namespaces.lifecycle.ensure'
         AND outcome = 'success'`,
      [namespace.data.id],
    );
    assert.equal(lifecycleEffects.rowCount, 0);

    const denial = await pool.query(
      `SELECT actor_id, outcome, details FROM occ.audit_events
       WHERE resource_id = $1 AND actor_id = $2 AND outcome IN ('denied', 'failure')`,
      [namespace.data.id, principalId],
    );
    assert.ok(denial.rowCount > 0, "revocation must produce attributable durable failure evidence");
  },
);
