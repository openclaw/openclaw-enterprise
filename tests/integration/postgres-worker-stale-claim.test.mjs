import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createOccMetrics } from "../../apps/controller/src/metrics/index.ts";
import { PostgresMetricsSnapshot } from "../../packages/occ/src/index.ts";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const requiresPostgres = {
  skip: databaseUrl ? false : "Set OCC_TEST_DATABASE_URL to run real PostgreSQL integration tests.",
};

async function waitFor(description, read, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await delay(20);
  }
  assert.fail(`Timed out waiting for ${description}.`);
}

async function ensureInstallation(state, createDevelopmentIAMState, createAuthPrincipalSeed) {
  const existing = await state.loadInstallation();
  if (existing !== undefined) {
    return existing;
  }

  const installation = {
    id: `ins_${randomUUID()}`,
    name: "Controller worker stale-claim integration",
    createdAt: new Date().toISOString(),
  };
  state.setBootstrapNativeIAM(
    createDevelopmentIAMState(
      createAuthPrincipalSeed(installation.id, "worker-stale-claim-integration", {
        id: `account-worker-${randomUUID()}`,
      }),
    ),
  );
  await state.transact((unit) => unit.installations.createInstallation(installation));
  return installation;
}

function authorizedPrincipal(iam) {
  const grants = new Set(
    iam.roles
      .filter(({ permissions }) =>
        permissions.some(
          ({ action, resourceKind }) => action === "create" && resourceKind === "namespace",
        ),
      )
      .map(({ id }) => id),
  );
  return iam.identities.find(
    ({ id, kind }) =>
      kind === "principal" &&
      iam.bindings.some(
        (binding) =>
          binding.subjectKind === "identity" &&
          binding.subjectId === id &&
          binding.namespaceId === undefined &&
          binding.resourceKind === undefined &&
          grants.has(binding.roleId),
      ),
  );
}

function codexPluginRevisionState(pluginId) {
  return {
    driver: { id: "codex-plugin", implementation: "occ/codex-plugin" },
    plugins: {
      [pluginId]: {
        enabled: true,
        toolDefaults: { approval: "native" },
      },
    },
  };
}

test(
  "a worker that loses its claim during Compute cannot publish Namespace status, lifecycle audit, or completion",
  requiresPostgres,
  async (context) => {
    const [
      { Pool },
      { createControllerWorker },
      { createDevelopmentComputeDriver },
      { createAuthPrincipalSeed },
      { PostgresPlatformState },
      { PostgresWorkQueue },
      { createDevelopmentIAMState },
    ] = await Promise.all([
      import("pg"),
      import("../../apps/controller/src/worker.ts"),
      import("../helpers/development.mjs"),
      import("../../packages/iam/src/index.ts"),
      import("../../packages/occ/src/state/postgres-state.ts"),
      import("../../packages/occ/src/state/postgres-work-queue.ts"),
      import("../helpers/development-iam-state.mjs"),
    ]);

    const observerPool = new Pool({ connectionString: databaseUrl, max: 8 });
    const workerPool = new Pool({ connectionString: databaseUrl, max: 8 });
    const state = new PostgresPlatformState(observerPool);
    const installation = await ensureInstallation(
      state,
      createDevelopmentIAMState,
      createAuthPrincipalSeed,
    );
    const actor = authorizedPrincipal(await state.loadNativeIAMState());
    assert.ok(actor, "persisted IAM must contain an unrestricted Namespace-create Principal");

    const namespace = {
      id: `ns_${randomUUID()}`,
      name: `worker-stale-claim-${randomUUID()}`,
      status: "provisioning",
      createdAt: new Date().toISOString(),
    };
    const idempotencyKey = `namespace:${namespace.id}:reconcile:ready`;
    await state.transactWithQueue(async (unit, queue) => {
      await unit.namespaces.createNamespace(namespace);
      await queue.enqueue({
        idempotencyKey,
        namespaceId: namespace.id,
        namespaceTarget: "ready",
        actorId: actor.id,
        availableAt: new Date(0),
      });
    });

    const releaseStaleEffect = Promise.withResolvers();
    const calls = [];
    const events = [];
    const developmentCompute = createDevelopmentComputeDriver();
    const snapshot = new PostgresMetricsSnapshot(observerPool);
    const metrics = createOccMetrics("worker", () => snapshot.collect());
    const worker = createControllerWorker({
      metrics,
      pool: workerPool,
      installationId: installation.id,
      pollIntervalMs: 20,
      leaseDurationMs: 30_000,
      maxAttempts: 5,
      computeDriver: {
        ...developmentCompute,
        async ensureNamespace(candidate) {
          calls.push(candidate.id);
          if (
            candidate.id === namespace.id &&
            calls.filter((id) => id === namespace.id).length === 1
          ) {
            await releaseStaleEffect.promise;
          }
          return developmentCompute.ensureNamespace(candidate);
        },
      },
      emit(event) {
        events.push(event);
      },
    });

    context.after(async () => {
      releaseStaleEffect.resolve();
      await worker.stop();
      await observerPool.end();
    });
    await worker.start();
    await waitFor("the real worker to enter its blocking ComputeDriver effect", async () =>
      calls.includes(namespace.id) ? true : undefined,
    );

    const original = await observerPool.query(
      `SELECT state, claim_token, attempt_count
       FROM occ.controller_work WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    assert.equal(original.rows[0].state, "claimed");
    assert.equal(original.rows[0].attempt_count, 1);

    await observerPool.query(
      `UPDATE occ.controller_work
       SET lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE idempotency_key = $1 AND claim_token = $2::uuid`,
      [idempotencyKey, original.rows[0].claim_token],
    );
    const recoveryQueue = new PostgresWorkQueue(observerPool, {
      leaseDurationMs: 30_000,
      maxAttempts: 5,
      random: () => 0,
    });
    const recovery = await recoveryQueue.recoverStale();
    assert.ok(recovery.recovered >= 1);
    const recovered = await recoveryQueue.claim();
    assert.ok(recovered, "the recovered lifecycle operation must have a fresh active claim");
    assert.equal(recovered.idempotencyKey, idempotencyKey);
    assert.equal(recovered.attemptCount, 2);
    assert.notEqual(recovered.claimToken, original.rows[0].claim_token);

    releaseStaleEffect.resolve();
    await waitFor("the stale worker's claim-loss error", async () =>
      events.find(({ event, code }) => event === "worker.error" && code === "CLAIM_LOST"),
    );
    assert.match(
      await metrics.exposition(),
      /occ_reconciliation_attempts_total\{[^\n]*outcome="claim_lost"[^\n]*\} 1/,
    );

    const unchangedNamespace = await observerPool.query(
      "SELECT status, deleted_at FROM occ.namespaces WHERE id = $1",
      [namespace.id],
    );
    assert.deepEqual(unchangedNamespace.rows, [{ status: "provisioning", deleted_at: null }]);

    const unchangedClaim = await observerPool.query(
      `SELECT state, claim_token, attempt_count, completed_at
       FROM occ.controller_work WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    assert.deepEqual(unchangedClaim.rows, [
      {
        state: "claimed",
        claim_token: recovered.claimToken,
        attempt_count: 2,
        completed_at: null,
      },
    ]);

    const staleEffects = await observerPool.query(
      `SELECT action, details->>'reasonCode' AS reason
       FROM occ.audit_events
       WHERE resource_id = $1
         AND (action = 'openclaw.namespaces.lifecycle.ensure'
              OR details->>'reasonCode' = 'RECONCILE_SUCCEEDED')`,
      [namespace.id],
    );
    assert.equal(staleEffects.rowCount, 0, "the expired worker must publish no lifecycle effect");
    assert.equal(calls.filter((id) => id === namespace.id).length, 1);

    await recoveryQueue.retry(recovered, { code: "TEST_RECOVERY_HANDOFF" });
    await waitFor("a fresh worker claim to converge the Namespace", async () => {
      const rows = await observerPool.query(
        `SELECT namespaces.status, work.state, work.attempt_count
         FROM occ.namespaces AS namespaces
         JOIN occ.controller_work AS work ON work.namespace_id = namespaces.id
         WHERE namespaces.id = $1 AND work.idempotency_key = $2`,
        [namespace.id, idempotencyKey],
      );
      const current = rows.rows[0];
      return current.status === "ready" && current.state === "succeeded" ? current : undefined;
    });

    assert.equal(calls.filter((id) => id === namespace.id).length, 2);
    const published = await observerPool.query(
      `SELECT action, outcome FROM occ.audit_events
       WHERE resource_id = $1 AND action = 'openclaw.namespaces.lifecycle.ensure'`,
      [namespace.id],
    );
    assert.deepEqual(published.rows, [
      { action: "openclaw.namespaces.lifecycle.ensure", outcome: "success" },
    ]);
  },
);

test(
  "a worker that loses its claim before committing plugin warnings cannot write them",
  requiresPostgres,
  async (context) => {
    const [
      { Pool },
      { createControllerWorker },
      { createDevelopmentComputeDriver },
      { DEVELOPMENT_HARNESS_DESCRIPTOR },
      { createAuthPrincipalSeed },
      { PostgresPlatformState },
      { PostgresWorkQueue },
      { createDevelopmentIAMState },
    ] = await Promise.all([
      import("pg"),
      import("../../apps/controller/src/worker.ts"),
      import("../helpers/development.mjs"),
      import("../../apps/controller/src/composition/production-harness.ts"),
      import("../../packages/iam/src/index.ts"),
      import("../../packages/occ/src/state/postgres-state.ts"),
      import("../../packages/occ/src/state/postgres-work-queue.ts"),
      import("../helpers/development-iam-state.mjs"),
    ]);

    const observerPool = new Pool({ connectionString: databaseUrl, max: 8 });
    const workerPool = new Pool({ connectionString: databaseUrl, max: 4 });
    const recoveryPool = new Pool({ connectionString: databaseUrl, max: 2 });
    const recoveredWorkerPool = new Pool({ connectionString: databaseUrl, max: 4 });
    const state = new PostgresPlatformState(observerPool);
    const releasePreparation = Promise.withResolvers();
    const installation = await ensureInstallation(
      state,
      createDevelopmentIAMState,
      createAuthPrincipalSeed,
    );
    const actor = authorizedPrincipal(await state.loadNativeIAMState());
    assert.ok(actor, "persisted IAM must contain an unrestricted Namespace-create Principal");

    let worker;
    context.after(async () => {
      releasePreparation.resolve();
      if (worker !== undefined) {
        await worker.stop();
      }
      await observerPool.end();
      await recoveryPool.end();
    });

    const namespace = {
      id: `ns_${randomUUID()}`,
      name: `worker-stale-plugin-${randomUUID()}`,
      status: "ready",
      createdAt: new Date().toISOString(),
    };
    const owner = {
      id: `agt_${randomUUID()}`,
      namespaceId: namespace.id,
      name: `stale-plugin-${randomUUID()}`,
      configurationId: `cfg_${randomUUID()}`,
      providerId: null,
      harnessAuth: { method: "runtime" },
      executionMode: "embedded",
      servicePrincipalId: `service-agent-${randomUUID()}`,
      createdAt: new Date().toISOString(),
    };
    const pluginId = "codex-plugin:gmail@openai-curated-remote";
    const compute = createDevelopmentComputeDriver();
    const revision = {
      id: `rev_${randomUUID()}`,
      namespaceId: namespace.id,
      agentId: owner.id,
      revision: 1,
      providerId: null,
      configuration: { revision: "1" },
      configurationId: owner.configurationId,
      configurationKind: "agent",
      configurationGeneration: 1,
      harness: { ...DEVELOPMENT_HARNESS_DESCRIPTOR, mode: "embedded" },
      compute: {
        id: compute.id,
        implementation: compute.implementation,
      },
      plugins: codexPluginRevisionState(pluginId),
      harnessAuth: { method: "runtime" },
      servicePrincipalId: owner.servicePrincipalId,
      createdAt: new Date().toISOString(),
    };
    const idempotencyKey = `agent_revision:${revision.id}:reconcile`;
    await state.transactWithQueue(async (unit, queue) => {
      await unit.namespaces.createNamespace(namespace);
      await unit.configurations.createConfiguration({
        id: owner.configurationId,
        namespaceId: namespace.id,
        kind: "agent",
        generation: 1,
        createdAt: new Date().toISOString(),
      });
      await unit.agents.createAgent(owner);
      await unit.revisions.createRevision(revision);
      await unit.agents.transitionAgentDesiredRuntimeState(
        namespace.id,
        owner.id,
        ["stopped", "running"],
        "running",
      );
      await queue.enqueue({
        idempotencyKey,
        namespaceId: namespace.id,
        agentId: owner.id,
        revisionId: revision.id,
        actorId: actor.id,
        availableAt: new Date(0),
      });
    });

    const prepareStarted = Promise.withResolvers();
    worker = createControllerWorker({
      pool: workerPool,
      installationId: installation.id,
      pollIntervalMs: 20,
      leaseDurationMs: 30_000,
      maxAttempts: 5,
      computeDriver: {
        ...compute,
        async prepareRevision(candidate) {
          prepareStarted.resolve();
          await releasePreparation.promise;
          return {
            namespaceId: candidate.namespaceId,
            agentId: candidate.agentId,
            revisionId: candidate.id,
            ready: true,
            warnings: [{ code: "PLUGIN_INSTALL_FAILED", pluginId }],
          };
        },
      },
    });
    await worker.start();
    await prepareStarted.promise;

    const original = await observerPool.query(
      `SELECT state, claim_token, attempt_count
       FROM occ.controller_work WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    assert.equal(original.rows[0].state, "claimed");
    assert.equal(original.rows[0].attempt_count, 1);

    await observerPool.query(
      `UPDATE occ.controller_work
       SET lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE idempotency_key = $1 AND claim_token = $2::uuid`,
      [idempotencyKey, original.rows[0].claim_token],
    );
    const recoveryQueue = new PostgresWorkQueue(recoveryPool, {
      leaseDurationMs: 30_000,
      maxAttempts: 5,
      random: () => 0,
    });
    const recovery = await recoveryQueue.recoverStale();
    assert.ok(recovery.recovered >= 1);
    const recovered = await recoveryQueue.claim();
    assert.ok(recovered, "the recovered deployment must receive a fresh claim");
    assert.equal(recovered.idempotencyKey, idempotencyKey);
    assert.equal(recovered.attemptCount, 2);
    assert.notEqual(recovered.claimToken, original.rows[0].claim_token);

    releasePreparation.resolve();
    const stolen = await waitFor("stolen plugin warnings to remain uncommitted", async () => {
      const rows = await observerPool.query(
        `SELECT state, claim_token, reason_code, result_data
         FROM occ.controller_work WHERE idempotency_key = $1`,
        [idempotencyKey],
      );
      const row = rows.rows[0];
      return row?.state === "claimed" && row.claim_token === recovered.claimToken ? row : undefined;
    });
    assert.equal(stolen.reason_code, null);
    assert.equal(stolen.result_data, null);

    await worker.stop();
    worker = undefined;
    await recoveryQueue.retry(recovered, { code: "TEST_RECOVERY_HANDOFF" });

    const recoveredCompute = createDevelopmentComputeDriver();
    worker = createControllerWorker({
      pool: recoveredWorkerPool,
      installationId: installation.id,
      pollIntervalMs: 20,
      leaseDurationMs: 30_000,
      maxAttempts: 5,
      computeDriver: {
        ...recoveredCompute,
        async prepareRevision(candidate) {
          return {
            namespaceId: candidate.namespaceId,
            agentId: candidate.agentId,
            revisionId: candidate.id,
            ready: true,
            warnings: [{ code: "PLUGIN_INSTALL_FAILED", pluginId }],
          };
        },
      },
    });
    await worker.start();

    const terminal = await waitFor("recovered worker successful plugin warning", async () => {
      const rows = await observerPool.query(
        `SELECT state, reason_code, result_data
         FROM occ.controller_work WHERE idempotency_key = $1`,
        [idempotencyKey],
      );
      return rows.rows[0]?.state === "succeeded" ? rows.rows[0] : undefined;
    });
    assert.deepEqual(terminal, {
      state: "succeeded",
      reason_code: "REVISION_ACTIVATED",
      result_data: { warnings: [{ code: "PLUGIN_INSTALL_FAILED", pluginId }] },
    });
  },
);
