import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, connect } from "node:net";
import test from "node:test";
import { createOccMetrics } from "../../apps/controller/src/metrics/index.ts";
import { PostgresMetricsSnapshot } from "../../packages/occ/src/index.ts";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";
import { waitFor } from "../helpers/wait-for.mjs";

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
      createAuthPrincipalSeed(
        installation.id,
        "worker-stale-claim-integration",
        {
          id: `account-worker-${randomUUID()}`,
        },
        { grant: "administrator" },
      ),
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

// A TCP relay between one pool and PostgreSQL. `silence()` keeps every connection open but
// forwards nothing, like a failover or partition that drops packets without a reset: queries
// are sent and never answered. `reset()` closes every connection.
async function startDatabaseRelay(url) {
  const target = new URL(url);
  const sockets = new Set();
  let silent = false;
  const server = createServer((client) => {
    const upstream = connect(Number(target.port || 5432), target.hostname);
    for (const [from, to] of [
      [client, upstream],
      [upstream, client],
    ]) {
      sockets.add(from);
      from.on("data", (chunk) => {
        if (!silent) {
          to.write(chunk);
        }
      });
      from.on("error", () => to.destroy());
      from.on("close", () => to.destroy());
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const relayed = new URL(url);
  relayed.hostname = "127.0.0.1";
  relayed.port = String(server.address().port);
  return {
    url: relayed.href,
    silence() {
      silent = true;
    },
    async reset() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function codexPluginRevisionState(pluginId) {
  return {
    driver: { id: "codex-plugin", implementation: "occ/codex-plugin" },
    plugins: {
      [pluginId]: {
        enabled: true,
        toolDefaults: { approval: "provider_default" },
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
  "a worker whose lease renewal is never answered stops its Compute effect once the lease runs out",
  requiresPostgres,
  async (context) => {
    const [
      { Pool },
      { createControllerWorker, workerDatabasePoolOptions },
      { currentComputeAbortSignal },
      { createDevelopmentComputeDriver },
      { createAuthPrincipalSeed },
      { PostgresPlatformState },
      { PostgresWorkQueue },
      { createDevelopmentIAMState },
    ] = await Promise.all([
      import("pg"),
      import("../../apps/controller/src/worker.ts"),
      import("../../apps/controller/src/drivers/compute/operation-context.ts"),
      import("../helpers/development.mjs"),
      import("../../packages/iam/src/index.ts"),
      import("../../packages/occ/src/state/postgres-state.ts"),
      import("../../packages/occ/src/state/postgres-work-queue.ts"),
      import("../helpers/development-iam-state.mjs"),
    ]);

    const leaseDurationMs = 1_500;
    const observerPool = new Pool({ connectionString: databaseUrl, max: 8 });
    const relay = await startDatabaseRelay(databaseUrl);
    // The production worker pool settings: a silent query is abandoned only after 60 s.
    const workerPool = new Pool({
      connectionString: relay.url,
      max: 4,
      ...workerDatabasePoolOptions(60_000),
    });
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
      name: `worker-silent-lease-${randomUUID()}`,
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

    const events = [];
    let effectSignal;
    let stoppedAt;
    const developmentCompute = createDevelopmentComputeDriver();
    const worker = createControllerWorker({
      pool: workerPool,
      installationId: installation.id,
      pollIntervalMs: 20,
      leaseDurationMs,
      maxAttempts: 5,
      computeDriver: {
        ...developmentCompute,
        // Like the shipped Drivers, this long Compute effect keeps writing until the
        // worker's claim-owned signal tells it the claim is gone.
        async ensureNamespace() {
          effectSignal = currentComputeAbortSignal();
          await new Promise((resolve) => {
            effectSignal.addEventListener("abort", resolve, { once: true });
          });
          stoppedAt = Date.now();
          throw effectSignal.reason;
        },
      },
      emit(event) {
        events.push(event);
      },
    });

    const recoveryQueue = new PostgresWorkQueue(observerPool, {
      leaseDurationMs: 30_000,
      maxAttempts: 5,
      random: () => 0,
    });
    let takeover;
    context.after(async () => {
      await relay.reset();
      await worker.stop();
      await workerPool.end().catch(() => {});
      // Leave no claimed work behind for later tests that share this database.
      if (takeover !== undefined) {
        await recoveryQueue.complete(takeover);
      }
      await observerPool.end();
    });
    await worker.start();
    await waitFor("the worker to enter its Compute effect", async () => effectSignal);

    // The worker's database path goes silent: its next renewal is sent and never answered,
    // so its lease runs out while Compute still runs.
    relay.silence();
    await waitFor(
      "the silent worker's lease to expire",
      async () => {
        const rows = await observerPool.query(
          `SELECT lease_expires_at <= clock_timestamp() AS expired
           FROM occ.controller_work WHERE idempotency_key = $1 AND state = 'claimed'`,
          [idempotencyKey],
        );
        return rows.rows[0]?.expired === true ? true : undefined;
      },
      leaseDurationMs * 4,
    );
    // A healthy worker recovers the expired claim and becomes the owner.
    assert.ok((await recoveryQueue.recoverStale()).recovered >= 1);
    const claimed = await waitFor("the healthy worker's fresh claim", () => recoveryQueue.claim());
    assert.equal(claimed.idempotencyKey, idempotencyKey);
    takeover = claimed;
    const takeoverAt = Date.now();

    // The silent worker cannot learn about the takeover, so it must stop on its own once
    // its last confirmed lease runs out. Otherwise it keeps writing beside the new owner
    // until the 60 s database timeout.
    await waitFor("the silent worker to stop its Compute effect", async () => stoppedAt, 1_000);
    assert.equal(effectSignal.reason?.name, "WorkClaimLostError");
    assert.ok(
      stoppedAt <= takeoverAt + 250,
      `the stale effect stopped ${stoppedAt - takeoverAt} ms after the takeover`,
    );

    // Once its connections fail, the stale worker reports the lost claim and publishes nothing.
    await relay.reset();
    await waitFor("the stale worker's claim-loss error", async () =>
      events.find(({ event, code }) => event === "worker.error" && code === "CLAIM_LOST"),
    );
    const current = await observerPool.query(
      `SELECT namespaces.status, work.state, work.claim_token
       FROM occ.namespaces AS namespaces
       JOIN occ.controller_work AS work ON work.namespace_id = namespaces.id
       WHERE namespaces.id = $1 AND work.idempotency_key = $2`,
      [namespace.id, idempotencyKey],
    );
    assert.deepEqual(current.rows, [
      { status: "provisioning", state: "claimed", claim_token: takeover.claimToken },
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
      backendId: null,
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
      backendId: null,
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
