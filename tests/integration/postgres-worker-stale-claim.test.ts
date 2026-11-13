import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, connect, type Socket } from "node:net";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { Pool } from "pg";

import { PRODUCTION_HARNESS_DESCRIPTOR } from "../../apps/controller/src/composition/production-harness.ts";
import { currentComputeAbortSignal } from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { createOccMetrics } from "../../apps/controller/src/metrics/index.ts";
import {
  createControllerWorker,
  workerDatabasePoolOptions,
  type ControllerWorker,
  type ControllerWorkerOptions,
} from "../../apps/controller/src/worker.ts";
import type {
  Agent,
  AgentRevision,
  ComputeDriver,
  Namespace,
  PluginRevisionState,
} from "../../packages/contracts/src/index.ts";
import { createPostgresPool, PostgresMetricsSnapshot } from "../../packages/occ/src/index.ts";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import {
  PostgresWorkQueue,
  type ClaimedWork,
  type ControllerWorkState,
} from "../../packages/occ/src/state/postgres-work-queue.ts";
import { deferred } from "../helpers/deferred.ts";
import { createDevelopmentComputeDriver } from "../helpers/development.ts";
import {
  authorizedPrincipal,
  createBackendWorkerDrivers,
  ensureInstallation,
} from "../helpers/postgres-backend-state.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import { expireWorkLease } from "../helpers/postgres-worker-revision-queue.ts";
import { asRecord } from "../../packages/utils/src/index.ts";

type WorkerEvent = Parameters<NonNullable<ControllerWorkerOptions["emit"]>>[0];

interface ClaimRow {
  state: ControllerWorkState;
  claim_token: string | null;
  attempt_count: number;
}

interface NamespaceWorkRow {
  status: Namespace["status"];
  state: ControllerWorkState;
  attempt_count: number;
}

interface WorkResultRow {
  state: ControllerWorkState;
  reason_code: string | null;
  result_data: unknown;
}

async function bootstrapWorkerActor(state: PostgresPlatformState) {
  await ensureInstallation(state, "worker-stale-claim");
  const actor: unknown = authorizedPrincipal(await state.loadNativeIAMState(), [
    ["create", "namespace"],
  ]);
  const actorId = asRecord(actor)?.id;
  assert.ok(
    typeof actorId === "string",
    "persisted IAM must contain an unrestricted Namespace-create Principal",
  );
  return actorId;
}

function namespaceWork(name: string) {
  const namespace: Namespace = {
    id: `ns_${randomUUID()}`,
    name: `${name}-${randomUUID()}`,
    status: "provisioning",
    createdAt: new Date().toISOString(),
  };
  return { namespace, idempotencyKey: `namespace:${namespace.id}:reconcile:ready` };
}

async function enqueueNamespace(
  state: PostgresPlatformState,
  { namespace, idempotencyKey }: ReturnType<typeof namespaceWork>,
  actorId: string,
) {
  await state.transactWithQueue(async (unit, queue) => {
    await unit.namespaces.createNamespace(namespace);
    await queue.enqueue({
      idempotencyKey,
      namespaceId: namespace.id,
      namespaceTarget: "ready",
      actorId,
      availableAt: new Date(0),
    });
  });
}

async function waitForNamespaceConvergence(
  description: string,
  pool: Pool,
  { namespace, idempotencyKey }: ReturnType<typeof namespaceWork>,
) {
  return waitFor(description, async () => {
    const {
      rows: [current],
    } = await pool.query<NamespaceWorkRow>(
      `SELECT namespaces.status, work.state, work.attempt_count
       FROM occ.namespaces AS namespaces
       JOIN occ.controller_work AS work ON work.namespace_id = namespaces.id
       WHERE namespaces.id = $1 AND work.idempotency_key = $2`,
      [namespace.id, idempotencyKey],
    );
    return current?.status === "ready" && current.state === "succeeded" ? current : undefined;
  });
}

async function waitForClaimExpiry(description: string, pool: Pool, key: string, timeoutMs: number) {
  await waitFor(
    description,
    async () => {
      const {
        rows: [claim],
      } = await pool.query<{ expired: boolean }>(
        `SELECT lease_expires_at <= clock_timestamp() AS expired
       FROM occ.controller_work WHERE idempotency_key = $1 AND state = 'claimed'`,
        [key],
      );
      return claim?.expired === true ? true : undefined;
    },
    timeoutMs,
  );
}

async function readFirstClaim(pool: Pool, key: string) {
  const {
    rows: [claim],
  } = await pool.query<ClaimRow>(
    `SELECT state, claim_token, attempt_count
     FROM occ.controller_work WHERE idempotency_key = $1`,
    [key],
  );
  assert.ok(claim);
  assert.equal(claim.state, "claimed");
  assert.equal(claim.attempt_count, 1);
  assert.ok(claim.claim_token);
  return claim.claim_token;
}

function observeWarnings() {
  const warnings: Error[] = [];
  const onWarning = (warning: Error) => warnings.push(warning);
  process.on("warning", onWarning);
  return { warnings, stop: () => process.off("warning", onWarning) };
}

// A TCP relay between one pool and PostgreSQL. `silence()` keeps every connection open but
// forwards nothing, like a failover or partition that drops packets without a reset: queries
// are sent and never answered. `hold()` still forwards queries, so PostgreSQL runs them, but
// keeps their answers until `release()`, like a slow network or a busy worker host.
// `reset()` closes every connection.
async function startDatabaseRelay(url: string) {
  const target = new URL(url);
  const sockets = new Set<Socket>();
  let silent = false;
  let held: (() => void)[] | undefined;
  const server = createServer((client) => {
    const upstream = connect(Number(target.port || 5432), target.hostname);
    for (const [from, to] of [
      [client, upstream],
      [upstream, client],
    ] as const) {
      sockets.add(from);
      from.on("data", (chunk: Buffer) => {
        if (silent) {
          return;
        }
        if (held !== undefined && from === upstream) {
          held.push(() => {
            to.write(chunk);
          });
          return;
        }
        to.write(chunk);
      });
      from.on("error", () => to.destroy());
      from.on("close", () => to.destroy());
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const relayed = new URL(url);
  relayed.hostname = "127.0.0.1";
  relayed.port = String(address.port);
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
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function codexPluginRevisionState(pluginId: string): PluginRevisionState {
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
    const observerPool = new Pool({ connectionString: databaseUrl, max: 8 });
    const workerPool = new Pool({ connectionString: databaseUrl, max: 8 });
    const state = new PostgresPlatformState(observerPool);
    const actorId = await bootstrapWorkerActor(state);

    const work = namespaceWork("worker-stale-claim");
    const { namespace, idempotencyKey } = work;
    await enqueueNamespace(state, work, actorId);

    const releaseStaleEffect = deferred();
    const calls: string[] = [];
    const events: WorkerEvent[] = [];
    const developmentCompute = createDevelopmentComputeDriver();
    const snapshot = new PostgresMetricsSnapshot(observerPool);
    const metrics = createOccMetrics("worker", () => snapshot.collect());
    const worker = createControllerWorker({
      metrics,
      pool: workerPool,
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

    const originalClaimToken = await readFirstClaim(observerPool, idempotencyKey);

    await expireWorkLease(observerPool, {
      key: idempotencyKey,
      claimToken: originalClaimToken,
    });
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
    assert.notEqual(recovered.claimToken, originalClaimToken);

    releaseStaleEffect.resolve();
    await waitFor("the stale worker's claim-loss error", async () =>
      events.find(({ event, code }) => event === "worker.error" && code === "CLAIM_LOST"),
    );
    assert.match(
      await metrics.exposition(),
      /occ_reconciliation_attempts_total\{[^\n]*outcome="claim_lost"[^\n]*\} 1/,
    );

    const unchangedNamespace = await observerPool.query<{
      status: Namespace["status"];
      deleted_at: Date | null;
    }>("SELECT status, deleted_at FROM occ.namespaces WHERE id = $1", [namespace.id]);
    assert.deepEqual(unchangedNamespace.rows, [{ status: "provisioning", deleted_at: null }]);

    const unchangedClaim = await observerPool.query<ClaimRow & { completed_at: Date | null }>(
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

    const staleEffects = await observerPool.query<{ action: string; reason: string | null }>(
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
    await waitForNamespaceConvergence(
      "a fresh worker claim to converge the Namespace",
      observerPool,
      work,
    );

    assert.equal(calls.filter((id) => id === namespace.id).length, 2);
    const published = await observerPool.query<{ action: string; outcome: string }>(
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
    const leaseDurationMs = 1_500;
    const observerPool = new Pool({ connectionString: databaseUrl, max: 8 });
    assert.ok(databaseUrl);
    const relay = await startDatabaseRelay(databaseUrl);
    // Use the production pool: resetting the relay drops idle clients as well as active queries.
    const workerPool = await createPostgresPool(relay.url, {
      max: 4,
      ...workerDatabasePoolOptions(60_000),
    });
    const state = new PostgresPlatformState(observerPool);
    const actorId = await bootstrapWorkerActor(state);

    const work = namespaceWork("worker-silent-lease");
    const { namespace, idempotencyKey } = work;
    await enqueueNamespace(state, work, actorId);

    const events: WorkerEvent[] = [];
    let effectSignal: AbortSignal | undefined;
    let stoppedAt: number | undefined;
    const developmentCompute = createDevelopmentComputeDriver();
    const worker = createControllerWorker({
      pool: workerPool,
      pollIntervalMs: 20,
      leaseDurationMs,
      maxAttempts: 5,
      computeDriver: {
        ...developmentCompute,
        // Like the shipped Drivers, this long Compute effect keeps writing until the
        // worker's claim-owned signal tells it the claim is gone.
        async ensureNamespace() {
          const signal = currentComputeAbortSignal();
          assert.ok(signal, "Compute must receive the claim-owned signal");
          effectSignal = signal;
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          stoppedAt = Date.now();
          const reason: unknown = signal.reason;
          throw reason;
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
    const recovery: { takeover?: ClaimedWork } = {};
    context.after(async () => {
      await relay.reset();
      await worker.stop();
      await workerPool.end().catch(() => {});
      // Leave no claimed work behind for later tests that share this database.
      if (recovery.takeover !== undefined) {
        await recoveryQueue.complete(recovery.takeover);
      }
      await observerPool.end();
    });
    await worker.start();
    const signal = await waitFor(
      "the worker to enter its Compute effect",
      async () => effectSignal,
    );

    // The worker's database path goes silent: its next renewal is sent and never answered,
    // so its lease runs out while Compute still runs.
    relay.silence();
    await waitForClaimExpiry(
      "the silent worker's lease to expire",
      observerPool,
      idempotencyKey,
      leaseDurationMs * 4,
    );
    // A healthy worker recovers the expired claim and becomes the owner.
    assert.ok((await recoveryQueue.recoverStale()).recovered >= 1);
    const claimed = await waitFor("the healthy worker's fresh claim", () => recoveryQueue.claim());
    assert.equal(claimed.idempotencyKey, idempotencyKey);
    recovery.takeover = claimed;
    const takeoverAt = Date.now();

    // The silent worker cannot learn about the takeover, so it must stop on its own once
    // its last confirmed lease runs out. Otherwise it keeps writing beside the new owner
    // until the 60 s database timeout.
    const stopped = await waitFor(
      "the silent worker to stop its Compute effect",
      async () => stoppedAt,
      1_000,
    );
    assert.equal(asRecord(signal.reason)?.name, "WorkClaimLostError");
    assert.ok(
      stopped <= takeoverAt + 250,
      `the stale effect stopped ${stopped - takeoverAt} ms after the takeover`,
    );

    // Once its connections fail, the stale worker reports the lost claim and publishes nothing.
    await relay.reset();
    await waitFor("the stale worker's claim-loss error", async () =>
      events.find(({ event, code }) => event === "worker.error" && code === "CLAIM_LOST"),
    );
    const current = await observerPool.query<
      Pick<NamespaceWorkRow, "status" | "state"> & Pick<ClaimRow, "claim_token">
    >(
      `SELECT namespaces.status, work.state, work.claim_token
       FROM occ.namespaces AS namespaces
       JOIN occ.controller_work AS work ON work.namespace_id = namespaces.id
       WHERE namespaces.id = $1 AND work.idempotency_key = $2`,
      [namespace.id, idempotencyKey],
    );
    assert.deepEqual(current.rows, [
      { status: "provisioning", state: "claimed", claim_token: claimed.claimToken },
    ]);
  },
);

test(
  "a worker whose lease renewal answers after the lease drops the claim before its Compute effect",
  requiresPostgres,
  async (context) => {
    const leaseDurationMs = 30_000;
    const observerPool = new Pool({ connectionString: databaseUrl, max: 8 });
    const workerPool = new Pool({ connectionString: databaseUrl, max: 4 });
    const state = new PostgresPlatformState(observerPool);
    const actorId = await bootstrapWorkerActor(state);

    const work = namespaceWork("worker-late-renewal");
    const { namespace, idempotencyKey } = work;

    // The worker's clock runs on: each renewal of the work's first attempt succeeds but
    // answers 2.6 s after the lease it confirmed ran out, like a loaded host (finding 2137).
    // Nothing really waits, so the database lease stays valid throughout.
    const realNow = performance.now.bind(performance);
    const ownNow = Object.getOwnPropertyDescriptor(performance, "now");
    let skewMs = 0;
    performance.now = () => realNow() + skewMs;
    const heartbeat = PostgresWorkQueue.prototype.heartbeat;
    let lateRenewals = 0;
    PostgresWorkQueue.prototype.heartbeat = async function (claim) {
      const renewed = await heartbeat.call(this, claim);
      if (
        claim.idempotencyKey === idempotencyKey &&
        "attemptCount" in claim &&
        claim.attemptCount === 1
      ) {
        lateRenewals += 1;
        skewMs += leaseDurationMs + 2_558;
      }
      return renewed;
    };
    const { warnings, stop: stopObservingWarnings } = observeWarnings();
    let stopWorker = () => workerPool.end();
    context.after(async () => {
      try {
        await stopWorker();
      } finally {
        PostgresWorkQueue.prototype.heartbeat = heartbeat;
        if (ownNow === undefined) {
          Reflect.deleteProperty(performance, "now");
        } else {
          Object.defineProperty(performance, "now", ownNow);
        }
        stopObservingWarnings();
        await observerPool.end();
      }
    });

    const calls: string[] = [];
    const events: WorkerEvent[] = [];
    const developmentCompute = createDevelopmentComputeDriver();
    const worker = createControllerWorker({
      pool: workerPool,
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

    stopWorker = () => worker.stop();

    await enqueueNamespace(state, work, actorId);
    await worker.start();

    // On the old code the negative timer fired a tick later, after Compute had started.
    await waitFor("the worker to act on the late renewal", async () =>
      lateRenewals > 0 && (calls.length > 0 || events.some(({ event }) => event === "worker.error"))
        ? true
        : undefined,
    );
    await setImmediate();
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
    const durationMs = late[0]?.durationMs;
    assert.ok(typeof durationMs === "number");
    assert.ok(durationMs > leaseDurationMs, `durationMs ${durationMs}`);

    // The claim stays with lease recovery; once it expires the work runs again and converges.
    await expireWorkLease(observerPool, { key: idempotencyKey, state: "claimed" });
    await waitForNamespaceConvergence(
      "the recovered work to converge the Namespace",
      observerPool,
      work,
    );
    assert.deepEqual(calls, [namespace.id]);
  },
);

// A stale worker whose renewal PostgreSQL ran at once but whose answer is held on the wire
// until another worker has recovered the expired claim and finished the work. `stage` picks
// the held renewal: "initial" holds the renewal right before the Compute effect, "interval"
// the first renewal sent while the effect runs.
async function heldRenewalHandoff(context: TestContext, stage: "initial" | "interval") {
  const leaseDurationMs = 1_500;
  const observerPool = new Pool({ connectionString: databaseUrl, max: 8 });
  assert.ok(databaseUrl);
  const relay = await startDatabaseRelay(databaseUrl);
  const stalePool = await createPostgresPool(relay.url, {
    max: 4,
    ...workerDatabasePoolOptions(60_000),
  });
  const ownerPool = new Pool({ connectionString: databaseUrl, max: 4 });
  const state = new PostgresPlatformState(observerPool);
  const actorId = await bootstrapWorkerActor(state);
  const work = namespaceWork("worker-held-renewal");
  const { namespace, idempotencyKey } = work;

  // The namespace pass renews once before its effect without a timer, then again inside the
  // effect's claim heartbeat; the "initial" stage holds that second renewal.
  const heartbeat = PostgresWorkQueue.prototype.heartbeat;
  let renewals = 0;
  let effectEntered = false;
  let heldAt: number | undefined;
  PostgresWorkQueue.prototype.heartbeat = function (claim) {
    if (
      claim.idempotencyKey === idempotencyKey &&
      "attemptCount" in claim &&
      claim.attemptCount === 1
    ) {
      renewals += 1;
      if (heldAt === undefined && (stage === "initial" ? renewals === 2 : effectEntered)) {
        relay.hold();
        heldAt = Date.now();
      }
    }
    return heartbeat.call(this, claim);
  };
  const { warnings, stop: stopObservingWarnings } = observeWarnings();
  const workers: ControllerWorker[] = [];
  context.after(async () => {
    try {
      relay.release();
      for (const worker of workers) {
        await worker.stop();
      }
    } finally {
      PostgresWorkQueue.prototype.heartbeat = heartbeat;
      stopObservingWarnings();
      await relay.reset();
      await stalePool.end().catch(() => {});
      await observerPool.end();
    }
  });

  const calls: { worker: "stale" | "owner"; at: number }[] = [];
  const staleEvents: WorkerEvent[] = [];
  let staleStoppedAt: number | undefined;
  const developmentCompute = createDevelopmentComputeDriver();
  const workerFor = (
    name: "stale" | "owner",
    pool: ControllerWorkerOptions["pool"],
    events?: WorkerEvent[],
  ) =>
    createControllerWorker({
      pool,
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
            assert.ok(signal, "Compute must receive the claim-owned signal");
            effectEntered = true;
            await new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
            staleStoppedAt = Date.now();
            const reason: unknown = signal.reason;
            throw reason;
          }
          return developmentCompute.ensureNamespace(candidate);
        },
      },
      emit(event) {
        events?.push(event);
      },
    });

  await enqueueNamespace(state, work, actorId);
  const stale = workerFor("stale", stalePool, staleEvents);
  workers.push(stale);
  await stale.start();
  await waitFor("the stale worker's held renewal", async () => heldAt);

  // PostgreSQL ran the held renewal, so its lease runs out one lease after it; then a healthy
  // worker recovers the claim and finishes the work while the answer is still held.
  await waitForClaimExpiry(
    "the held claim's lease to expire",
    observerPool,
    idempotencyKey,
    leaseDurationMs * 4,
  );
  const owner = workerFor("owner", ownerPool);
  workers.push(owner);
  await owner.start();
  const finished = await waitForNamespaceConvergence(
    "the new owner to converge the Namespace",
    observerPool,
    work,
  );
  assert.equal(finished.attempt_count, 2);

  // Only now does the stale worker get its successful, late answer.
  relay.release();
  const lost = await waitFor("the stale worker's claim-loss error", async () =>
    staleEvents.find(({ event }) => event === "worker.error"),
  );
  await setImmediate();
  assert.deepEqual(
    warnings.filter(({ name }) => name === "TimeoutNegativeWarning").map(({ message }) => message),
    [],
  );
  const published = await observerPool.query<{ outcome: string }>(
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
    const durationMs = late[0]?.durationMs;
    assert.ok(typeof durationMs === "number");
    assert.ok(durationMs > leaseDurationMs, `durationMs ${durationMs}`);
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
    const ownerStartedAt = calls[1]?.at;
    assert.ok(ownerStartedAt !== undefined, "the new owner must enter Compute");
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
    const observerPool = new Pool({ connectionString: databaseUrl, max: 8 });
    const workerPool = new Pool({ connectionString: databaseUrl, max: 4 });
    const recoveryPool = new Pool({ connectionString: databaseUrl, max: 2 });
    const recoveredWorkerPool = new Pool({ connectionString: databaseUrl, max: 4 });
    const state = new PostgresPlatformState(observerPool);
    const releasePreparation = deferred();
    const actorId = await bootstrapWorkerActor(state);

    let worker: ControllerWorker | undefined;
    context.after(async () => {
      releasePreparation.resolve();
      if (worker !== undefined) {
        await worker.stop();
      }
      await observerPool.end();
      await recoveryPool.end();
    });

    const namespace: Namespace = {
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
      executionMode: "dedicated",
      gatewayManagedMode: true,
      desiredRuntimeState: "stopped",
      status: "active",
      servicePrincipalId: `service-agent-${randomUUID()}`,
      createdAt: new Date().toISOString(),
    } satisfies Agent;
    const pluginId = "codex-plugin:gmail@openai-curated-remote";
    const compute = createDevelopmentComputeDriver();
    const revision: AgentRevision = {
      id: `rev_${randomUUID()}`,
      namespaceId: namespace.id,
      agentId: owner.id,
      revision: 1,
      backendId: null,
      configuration: { revision: "1" },
      configurationId: owner.configurationId,
      configurationKind: "agent",
      configurationGeneration: 1,
      gatewayManagedMode: owner.gatewayManagedMode,
      harness: {
        ...PRODUCTION_HARNESS_DESCRIPTOR,
        mode: "dedicated",
        overrides: {},
        configuration: {},
      },
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
        actorId,
        availableAt: new Date(0),
      });
    });

    const warningWorker = (pool: Pool, beforePrepare?: () => Promise<void>) =>
      createControllerWorker({
        pool,
        pollIntervalMs: 20,
        leaseDurationMs: 30_000,
        maxAttempts: 5,
        drivers: {
          ...createBackendWorkerDrivers(
            {
              ...compute,
              async prepareRevision(candidate) {
                await beforePrepare?.();
                return {
                  namespaceId: candidate.namespaceId,
                  agentId: candidate.agentId,
                  revisionId: candidate.id,
                  ready: true,
                  warnings: [{ code: "PLUGIN_INSTALL_FAILED", pluginId }],
                };
              },
            } satisfies ComputeDriver,
            [],
          ),
          pluginDrivers: [new CodexPluginDriver()],
        },
      });
    let preparing = false;
    worker = warningWorker(workerPool, async () => {
      preparing = true;
      await releasePreparation.promise;
    });
    await worker.start();
    await waitFor(
      "the first worker to prepare the pinned Codex revision",
      async () => preparing || undefined,
    );

    const originalClaimToken = await readFirstClaim(observerPool, idempotencyKey);

    await expireWorkLease(observerPool, {
      key: idempotencyKey,
      claimToken: originalClaimToken,
    });
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
    assert.notEqual(recovered.claimToken, originalClaimToken);

    releasePreparation.resolve();
    const stolen = await waitFor("stolen plugin warnings to remain uncommitted", async () => {
      const rows = await observerPool.query<WorkResultRow & Pick<ClaimRow, "claim_token">>(
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

    worker = warningWorker(recoveredWorkerPool);
    await worker.start();

    const terminal = await waitFor("recovered worker successful plugin warning", async () => {
      const rows = await observerPool.query<WorkResultRow>(
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
