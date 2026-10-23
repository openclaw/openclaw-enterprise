import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, connect } from "node:net";
import test from "node:test";
import { createOccMetrics } from "../../apps/controller/src/metrics/index.ts";
import { PostgresMetricsSnapshot } from "../../packages/occ/src/index.ts";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";
import { waitFor } from "../helpers/wait-for.mjs";

// A TCP relay between one pool and PostgreSQL. `silence()` keeps every connection open but
// forwards nothing, like a failover or partition that drops packets without a reset: queries
// are sent and never answered. `hold()` still forwards queries, so PostgreSQL runs them, but
// keeps their answers until `release()`, like a slow network or a busy worker host.
// `reset()` closes every connection.
async function startDatabaseRelay(url) {
  const target = new URL(url);
  const sockets = new Set();
  let silent = false;
  let held;
  const server = createServer((client) => {
    const upstream = connect(Number(target.port || 5432), target.hostname);
    for (const [from, to] of [
      [client, upstream],
      [upstream, client],
    ]) {
      sockets.add(from);
      from.on("data", (chunk) => {
        if (silent) {
          return;
        }
        if (held !== undefined && from === upstream) {
          held.push(() => to.write(chunk));
          return;
        }
        to.write(chunk);
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
    hold() {
      held ??= [];
    },
    release() {
      const writes = held ?? [];
      held = undefined;
      for (const write of writes) {
        write();
      }
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
      { PostgresPlatformState },
      { PostgresWorkQueue },
      { authorizedPrincipal, ensureInstallation },
    ] = await Promise.all([
      import("pg"),
      import("../../apps/controller/src/worker.ts"),
      import("../helpers/development.mjs"),
      import("../../packages/occ/src/state/postgres-state.ts"),
      import("../../packages/occ/src/state/postgres-work-queue.ts"),
      import("../helpers/postgres-backend-state.mjs"),
    ]);

    const observerPool = new Pool({ connectionString: databaseUrl, max: 8 });
    const workerPool = new Pool({ connectionString: databaseUrl, max: 8 });
    const state = new PostgresPlatformState(observerPool);
    const installation = await ensureInstallation(state, "worker-stale-claim");
    const actor = authorizedPrincipal(await state.loadNativeIAMState(), [["create", "namespace"]]);
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
      { PostgresPlatformState },
      { PostgresWorkQueue },
      { authorizedPrincipal, ensureInstallation },
    ] = await Promise.all([
      import("pg"),
      import("../../apps/controller/src/worker.ts"),
      import("../../apps/controller/src/drivers/compute/operation-context.ts"),
      import("../helpers/development.mjs"),
      import("../../packages/occ/src/state/postgres-state.ts"),
      import("../../packages/occ/src/state/postgres-work-queue.ts"),
      import("../helpers/postgres-backend-state.mjs"),
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
    const installation = await ensureInstallation(state, "worker-stale-claim");
    const actor = authorizedPrincipal(await state.loadNativeIAMState(), [["create", "namespace"]]);
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
  "a worker whose lease renewal answers after the lease drops the claim before its Compute effect",
  requiresPostgres,
  async (context) => {
    const [
      { Pool },
      { createControllerWorker },
      { createDevelopmentComputeDriver },
      { PostgresPlatformState },
      { PostgresWorkQueue },
      { authorizedPrincipal, ensureInstallation },
    ] = await Promise.all([
      import("pg"),
      import("../../apps/controller/src/worker.ts"),
      import("../helpers/development.mjs"),
      import("../../packages/occ/src/state/postgres-state.ts"),
      import("../../packages/occ/src/state/postgres-work-queue.ts"),
      import("../helpers/postgres-backend-state.mjs"),
    ]);

    const leaseDurationMs = 30_000;
    const observerPool = new Pool({ connectionString: databaseUrl, max: 8 });
    const workerPool = new Pool({ connectionString: databaseUrl, max: 4 });
    const state = new PostgresPlatformState(observerPool);
    const installation = await ensureInstallation(state, "worker-stale-claim");
    const actor = authorizedPrincipal(await state.loadNativeIAMState(), [["create", "namespace"]]);
    assert.ok(actor, "persisted IAM must contain an unrestricted Namespace-create Principal");

    const namespace = {
      id: `ns_${randomUUID()}`,
      name: `worker-late-renewal-${randomUUID()}`,
      status: "provisioning",
      createdAt: new Date().toISOString(),
    };
    const idempotencyKey = `namespace:${namespace.id}:reconcile:ready`;

    // The worker's clock runs on: each renewal of the work's first attempt succeeds but
    // answers 2.6 s after the lease it confirmed ran out, like a loaded host (finding 2137).
    // Nothing really waits, so the database lease stays valid throughout.
    const realNow = performance.now.bind(performance);
    let skewMs = 0;
    performance.now = () => realNow() + skewMs;
    const heartbeat = PostgresWorkQueue.prototype.heartbeat;
    let lateRenewals = 0;
    PostgresWorkQueue.prototype.heartbeat = async function (claim) {
      const renewed = await heartbeat.call(this, claim);
      if (claim.idempotencyKey === idempotencyKey && claim.attemptCount === 1) {
        lateRenewals += 1;
        skewMs += leaseDurationMs + 2_558;
      }
      return renewed;
    };
    const warnings = [];
    const onWarning = (warning) => warnings.push(warning);
    process.on("warning", onWarning);
    let worker;
    context.after(async () => {
      try {
        await worker?.stop();
      } finally {
        PostgresWorkQueue.prototype.heartbeat = heartbeat;
        delete performance.now;
        process.off("warning", onWarning);
        await observerPool.end();
      }
    });

    const calls = [];
    const events = [];
    const developmentCompute = createDevelopmentComputeDriver();
    worker = createControllerWorker({
      pool: workerPool,
      installationId: installation.id,
      pollIntervalMs: 20,
      leaseDurationMs,
      maxAttempts: 5,
      computeDriver: {
        ...developmentCompute,
        async ensureNamespace(candidate) {
          calls.push(candidate.id);
          return developmentCompute.ensureNamespace(candidate);
        },
      },
      emit(event) {
        events.push(event);
      },
    });

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
    await worker.start();

    // On the old code the negative timer fired a tick later, after Compute had started.
    await waitFor("the worker to act on the late renewal", async () =>
      lateRenewals > 0 && (calls.length > 0 || events.some(({ event }) => event === "worker.error"))
        ? true
        : undefined,
    );
    await new Promise((resolve) => setImmediate(resolve));
    // No timer was armed with the negative remainder, and Compute never ran on the claim.
    assert.deepEqual(
      warnings
        .filter(({ name }) => name === "TimeoutNegativeWarning")
        .map(({ message }) => message),
      [],
    );
    assert.deepEqual(calls, []);
    assert.deepEqual(
      events.find(({ event }) => event === "worker.error"),
      {
        event: "worker.error",
        code: "CLAIM_LOST",
        workId: idempotencyKey,
        attempt: 1,
        operation: "namespace.ensure",
        cause: "CLAIM_RENEWAL_LATE",
      },
    );
    const late = events.filter(({ event }) => event === "worker.claim-renewal-warning");
    assert.equal(late.length, 1);
    assert.deepEqual(
      { ...late[0], durationMs: undefined },
      {
        event: "worker.claim-renewal-warning",
        workId: idempotencyKey,
        attempt: 1,
        operation: "namespace.ensure",
        code: "CLAIM_RENEWAL_LATE",
        durationMs: undefined,
      },
    );
    assert.ok(late[0].durationMs > leaseDurationMs, `durationMs ${late[0].durationMs}`);

    // The claim stays with lease recovery; once it expires the work runs again and converges.
    await observerPool.query(
      `UPDATE occ.controller_work
       SET lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE idempotency_key = $1 AND state = 'claimed'`,
      [idempotencyKey],
    );
    await waitFor("the recovered work to converge the Namespace", async () => {
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
    assert.deepEqual(calls, [namespace.id]);
  },
);

// A stale worker whose renewal PostgreSQL ran at once but whose answer is held on the wire
// until another worker has recovered the expired claim and finished the work. `stage` picks
// the held renewal: "initial" holds the renewal right before the Compute effect, "interval"
// the first renewal sent while the effect runs.
async function heldRenewalHandoff(context, stage) {
  const [
    { Pool },
    { createControllerWorker, workerDatabasePoolOptions },
    { currentComputeAbortSignal },
    { createDevelopmentComputeDriver },
    { PostgresPlatformState },
    { PostgresWorkQueue },
    { authorizedPrincipal, ensureInstallation },
  ] = await Promise.all([
    import("pg"),
    import("../../apps/controller/src/worker.ts"),
    import("../../apps/controller/src/drivers/compute/operation-context.ts"),
    import("../helpers/development.mjs"),
    import("../../packages/occ/src/state/postgres-state.ts"),
    import("../../packages/occ/src/state/postgres-work-queue.ts"),
    import("../helpers/postgres-backend-state.mjs"),
  ]);

  const leaseDurationMs = 1_500;
  const observerPool = new Pool({ connectionString: databaseUrl, max: 8 });
  const relay = await startDatabaseRelay(databaseUrl);
  const stalePool = new Pool({
    connectionString: relay.url,
    max: 4,
    ...workerDatabasePoolOptions(60_000),
  });
  const ownerPool = new Pool({ connectionString: databaseUrl, max: 4 });
  const state = new PostgresPlatformState(observerPool);
  const installation = await ensureInstallation(state, "worker-stale-claim");
  const actor = authorizedPrincipal(await state.loadNativeIAMState(), [["create", "namespace"]]);
  assert.ok(actor, "persisted IAM must contain an unrestricted Namespace-create Principal");
  const namespace = {
    id: `ns_${randomUUID()}`,
    name: `worker-held-renewal-${randomUUID()}`,
    status: "provisioning",
    createdAt: new Date().toISOString(),
  };
  const idempotencyKey = `namespace:${namespace.id}:reconcile:ready`;

  // The namespace pass renews once before its effect without a timer, then again inside the
  // effect's claim heartbeat; the "initial" stage holds that second renewal.
  const heartbeat = PostgresWorkQueue.prototype.heartbeat;
  let renewals = 0;
  let effectEntered = false;
  let heldAt;
  PostgresWorkQueue.prototype.heartbeat = function (claim) {
    if (claim.idempotencyKey === idempotencyKey && claim.attemptCount === 1) {
      renewals += 1;
      if (heldAt === undefined && (stage === "initial" ? renewals === 2 : effectEntered)) {
        relay.hold();
        heldAt = Date.now();
      }
    }
    return heartbeat.call(this, claim);
  };
  const warnings = [];
  const onWarning = (warning) => warnings.push(warning);
  process.on("warning", onWarning);
  const workers = [];
  context.after(async () => {
    try {
      relay.release();
      for (const worker of workers) {
        await worker.stop();
      }
    } finally {
      PostgresWorkQueue.prototype.heartbeat = heartbeat;
      process.off("warning", onWarning);
      await relay.reset();
      await stalePool.end().catch(() => {});
      await observerPool.end();
    }
  });

  const calls = [];
  const staleEvents = [];
  let staleStoppedAt;
  const developmentCompute = createDevelopmentComputeDriver();
  const workerFor = (name, pool, events) =>
    createControllerWorker({
      pool,
      installationId: installation.id,
      pollIntervalMs: 20,
      leaseDurationMs,
      maxAttempts: 5,
      computeDriver: {
        ...developmentCompute,
        async ensureNamespace(candidate) {
          calls.push({ worker: name, at: Date.now() });
          if (name === "stale" && stage === "interval") {
            // Like the shipped Drivers, this effect runs until the claim-owned signal ends it.
            const signal = currentComputeAbortSignal();
            effectEntered = true;
            await new Promise((resolve) => {
              signal.addEventListener("abort", resolve, { once: true });
            });
            staleStoppedAt = Date.now();
            throw signal.reason;
          }
          return developmentCompute.ensureNamespace(candidate);
        },
      },
      emit(event) {
        events?.push(event);
      },
    });

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
  const stale = workerFor("stale", stalePool, staleEvents);
  workers.push(stale);
  await stale.start();
  await waitFor("the stale worker's held renewal", async () => heldAt);

  // PostgreSQL ran the held renewal, so its lease runs out one lease after it; then a healthy
  // worker recovers the claim and finishes the work while the answer is still held.
  await waitFor(
    "the held claim's lease to expire",
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
  const owner = workerFor("owner", ownerPool);
  workers.push(owner);
  await owner.start();
  const finished = await waitFor("the new owner to converge the Namespace", async () => {
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
  assert.equal(finished.attempt_count, 2);

  // Only now does the stale worker get its successful, late answer.
  relay.release();
  const lost = await waitFor("the stale worker's claim-loss error", async () =>
    staleEvents.find(({ event }) => event === "worker.error"),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    warnings.filter(({ name }) => name === "TimeoutNegativeWarning").map(({ message }) => message),
    [],
  );
  const published = await observerPool.query(
    `SELECT outcome FROM occ.audit_events
     WHERE resource_id = $1 AND action = 'openclaw.namespaces.lifecycle.ensure'`,
    [namespace.id],
  );
  assert.deepEqual(published.rows, [{ outcome: "success" }]);
  return { calls, lost, staleEvents, staleStoppedAt, idempotencyKey, leaseDurationMs };
}

test(
  "a stale worker whose held renewal succeeds after a takeover starts no Compute effect",
  requiresPostgres,
  async (context) => {
    const { calls, lost, staleEvents, idempotencyKey, leaseDurationMs } = await heldRenewalHandoff(
      context,
      "initial",
    );
    assert.deepEqual(
      calls.map(({ worker }) => worker),
      ["owner"],
    );
    assert.deepEqual(lost, {
      event: "worker.error",
      code: "CLAIM_LOST",
      workId: idempotencyKey,
      attempt: 1,
      operation: "namespace.ensure",
      cause: "CLAIM_RENEWAL_LATE",
    });
    const late = staleEvents.filter(({ event }) => event === "worker.claim-renewal-warning");
    assert.equal(late.length, 1);
    assert.ok(late[0].durationMs > leaseDurationMs, `durationMs ${late[0].durationMs}`);
  },
);

test(
  "a stale worker whose held interval renewal succeeds after a takeover stopped its effect first",
  requiresPostgres,
  async (context) => {
    const { calls, lost, staleEvents, staleStoppedAt, idempotencyKey } = await heldRenewalHandoff(
      context,
      "interval",
    );
    assert.deepEqual(
      calls.map(({ worker }) => worker),
      ["stale", "owner"],
    );
    const ownerStartedAt = calls[1].at;
    assert.ok(staleStoppedAt !== undefined, "the stale effect must stop");
    assert.ok(
      staleStoppedAt <= ownerStartedAt,
      `the stale effect stopped ${staleStoppedAt - ownerStartedAt} ms after the new owner started`,
    );
    assert.deepEqual(lost, {
      event: "worker.error",
      code: "CLAIM_LOST",
      workId: idempotencyKey,
      attempt: 1,
      operation: "namespace.ensure",
      cause: "CLAIM_LEASE_LAPSED",
    });
    // The answer came after the claim was already given up; it re-arms and logs nothing.
    assert.equal(
      staleEvents.filter(({ event }) => event === "worker.claim-renewal-warning").length,
      0,
    );
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
      { PostgresPlatformState },
      { PostgresWorkQueue },
      { authorizedPrincipal, ensureInstallation },
    ] = await Promise.all([
      import("pg"),
      import("../../apps/controller/src/worker.ts"),
      import("../helpers/development.mjs"),
      import("../../apps/controller/src/composition/production-harness.ts"),
      import("../../packages/occ/src/state/postgres-state.ts"),
      import("../../packages/occ/src/state/postgres-work-queue.ts"),
      import("../helpers/postgres-backend-state.mjs"),
    ]);

    const observerPool = new Pool({ connectionString: databaseUrl, max: 8 });
    const workerPool = new Pool({ connectionString: databaseUrl, max: 4 });
    const recoveryPool = new Pool({ connectionString: databaseUrl, max: 2 });
    const recoveredWorkerPool = new Pool({ connectionString: databaseUrl, max: 4 });
    const state = new PostgresPlatformState(observerPool);
    const releasePreparation = Promise.withResolvers();
    const installation = await ensureInstallation(state, "worker-stale-claim");
    const actor = authorizedPrincipal(await state.loadNativeIAMState(), [["create", "namespace"]]);
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
      executionAdmission: { version: 2, mode: "unprotected" },
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
