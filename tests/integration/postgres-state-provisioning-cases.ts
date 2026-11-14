import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { Pool } from "pg";

import type { ProvisioningEffectTarget, WorkClaim } from "../../packages/occ/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { databaseUrl } from "../helpers/postgres-platform-state.ts";
import { ensureInstallation } from "../helpers/postgres-state-installation.ts";
import { makeWorkDue } from "../helpers/postgres-worker-revision-queue.ts";
import { AGENT_NAME_CONFLICT } from "../helpers/refusal-text.mjs";

async function claimProvisioningWork(pool: Pool, idempotencyKey: string): Promise<WorkClaim> {
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

export async function replayProvisioning(context: TestContext): Promise<void> {
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
  // The repository must issue its own effect owner even when the input carries one.
  const pendingConfiguration: ProvisioningEffectTarget & { owner: string } = {
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
  const actualPendingConfiguration = asRecord(pendingEffect.progress.pendingEffect);
  assert.ok(actualPendingConfiguration);
  const { kind, owner, targetId } = actualPendingConfiguration;
  assert.equal(kind, "configuration");
  assert.ok(typeof owner === "string");
  assert.notEqual(owner, pendingConfiguration.owner);
  assert.equal(targetId, configurationId);

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

  await makeWorkDue(pool, workId);
  const secondClaim = await claimProvisioningWork(pool, workId);
  const settledBeforeFailure = await state.transact((unit) =>
    unit.provisioning.settleEffect(workId, {
      kind: "configuration",
      owner,
      targetId,
    }),
  );
  assert.deepEqual(settledBeforeFailure.progress.effectReceipt, {
    kind: "configuration",
    owner,
    targetId,
  });

  await state.transact((unit) =>
    unit.configurations.createConfiguration({
      id: configurationId,
      namespaceId,
      kind: "agent",
      generation: 1,
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

  await makeWorkDue(pool, workId);
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
}

export async function completeProvisioning(context: TestContext): Promise<void> {
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
    const agent = await unit.agents.createAgent({
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
      gatewayManagedMode: agent.gatewayManagedMode,
      configurationId,
      configurationKind: "agent",
      configurationGeneration: 1,
      configuration: { agents: { defaults: { model: "test/model" } } },
      harness: {
        id: "openclaw",
        version: "1.0.0",
        mode: "embedded",
        overrides: {},
        configuration: {},
      },
      compute: { id: "compute-provisioning-success", implementation: "deterministic-test" },
      executionAdmission: { version: 2, mode: "unprotected" },
      harnessAuth: { method: "runtime" },
      servicePrincipalId: `service-agent-${agentId}`,
      createdAt,
    });
  });

  // The Namespace-unique name constraint surfaces as an actionable duplicate-name conflict.
  const duplicateAgentId = `agt_${randomUUID()}`;
  await assert.rejects(
    state.transact((unit) =>
      unit.agents.createAgent({
        id: duplicateAgentId,
        namespaceId,
        name: "Provisioning success",
        configurationId,
        backendId: null,
        harnessAuth: { method: "runtime" },
        executionMode: "embedded",
        servicePrincipalId: `service-agent-${duplicateAgentId}`,
        desiredRuntimeState: "stopped",
        status: "active",
        createdAt,
      }),
    ),
    {
      name: "ResourceStateConflictError",
      message: AGENT_NAME_CONFLICT,
    },
  );

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
}

export async function checkpointProvisioning(context: TestContext): Promise<void> {
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
  // The repository must issue its own effect owner even when the input carries one.
  const pendingConfiguration: ProvisioningEffectTarget & { owner: string } = {
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
  const actualPendingConfiguration = asRecord(checkpointed.progress.pendingEffect);
  assert.ok(actualPendingConfiguration);
  const { kind, owner, targetId } = actualPendingConfiguration;
  assert.equal(kind, "configuration");
  assert.ok(typeof owner === "string");
  assert.notEqual(owner, pendingConfiguration.owner);
  assert.equal(targetId, configurationId);
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
        owner: `${owner}-mismatch`,
        targetId: configurationId,
      }),
    ),
    { name: "ResourceConflictError" },
  );
  const receipted = await state.transact((unit) =>
    unit.provisioning.settleEffect(workId, {
      kind: "configuration",
      owner,
      targetId: configurationId,
    }),
  );
  assert.deepEqual(receipted.progress.pendingEffect, actualPendingConfiguration);
  assert.deepEqual(receipted.progress.effectReceipt, {
    kind: "configuration",
    owner,
    targetId: configurationId,
  });
  await state.transact((unit) =>
    unit.configurations.createConfiguration({
      id: configurationId,
      namespaceId,
      kind: "agent",
      generation: 1,
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
}
