import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, type TestContext } from "node:test";
import type { Pool, PoolClient } from "pg";
import { currentComputeAbortSignal } from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { createOccLogger, createWorkerLogEmitter } from "../../apps/controller/src/logging.ts";
import { createOccMetrics } from "../../apps/controller/src/metrics/index.ts";
import type { ControllerWorkerOptions } from "../../apps/controller/src/worker.ts";
import type {
  Agent,
  AgentRevision,
  ComputeDriver,
  ComputeRevisionContext,
  Namespace,
  Principal,
} from "../../packages/contracts/src/index.ts";
import {
  PostgresMetricsSnapshot,
  type ControllerWorkState,
  type OpenClawController,
} from "../../packages/occ/src/index.ts";
import type { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import type { PostgresWorkQueue } from "../../packages/occ/src/state/postgres-work-queue.ts";
import { jsonLineDestination, requireLogRecord } from "../helpers/json-lines.ts";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import { withNamespaceLockHeld } from "../helpers/postgres-locks.ts";
import type { WorkerEvent } from "../helpers/postgres-worker-refused-candidate.ts";
import { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";
import { completion, expireWorkLease } from "../helpers/postgres-worker-revision-queue.ts";
import { waitFor } from "../helpers/wait-for.ts";

type WorkIdentity = { id: string; idempotencyKey: string };
type AdmittedRevision = AgentRevision & WorkIdentity;
type WorkStateRow = { state: ControllerWorkState; attempt_count: number };
type LifecycleFixture = {
  actor: Pick<Principal, "id">;
  namespace: Pick<Namespace, "id">;
  compute: ComputeDriver;
  observerPool: Pool;
  workerPool: Pool;
  PostgresWorkQueue: typeof PostgresWorkQueue;
  state: Pick<PostgresPlatformState, "read" | "transact">;
  controller: Pick<OpenClawController, "deleteAgent" | "listRevisions">;
  agent(label: string): Promise<Agent>;
  currentAgent(owner: Pick<Agent, "id">): Promise<Readonly<Agent> | undefined>;
  admitInitialRevision(
    label: string,
    options?: { agent: Pick<Agent, "executionMode"> },
  ): Promise<{ owner: Agent; candidate: AdmittedRevision }>;
  requestStop(owner: Pick<Agent, "id">): Promise<WorkIdentity>;
  revision(
    owner: Agent,
    number: number,
    options?: { controllerSkewMs: number },
  ): Promise<AdmittedRevision>;
  start(compute: ComputeDriver, options?: Pick<ControllerWorkerOptions, "emit">): Promise<void>;
  stop(): Promise<void>;
  work(
    work: WorkIdentity,
    expected: ControllerWorkState,
  ): Promise<
    WorkStateRow & {
      claim_token: string | null;
    }
  >;
};

// The file owns its migrated template. Each case owns its clone and connections.
const {
  setup,
  cleanup,
}: {
  setup(
    context: Pick<TestContext, "after">,
    options?: Pick<ControllerWorkerOptions, "maxAttempts" | "metrics">,
  ): Promise<LifecycleFixture>;
  cleanup: ReturnType<typeof createWorkerRevisionFixtures>["cleanup"];
} = createWorkerRevisionFixtures(import.meta.url);
after(cleanup);

function revisionTest(name: string, run: (fixture: LifecycleFixture) => Promise<void>) {
  test(name, requiresPostgres, async (context) => {
    await run(await setup(context));
  });
}

type RevisionEffect = { action: "prepare" | "retire"; revisionId: string };
type RemovedCountRow = { count: number };
type MaintenanceCountRow = { count: string };
type AuditReasonRow = { reason_code: string | null };
type LifecycleAuditRow = AuditReasonRow & { action: string; outcome: string };
type ListRevisionPage = Awaited<ReturnType<OpenClawController["listRevisions"]>>;

revisionTest(
  "Agent deploy, stop, and deletion complete as one persisted lifecycle",
  async (fixture) => {
    const owner = await fixture.agent("complete-lifecycle");
    const effects: string[] = [];
    await fixture.start({
      ...fixture.compute,
      async prepareRevision(revision) {
        effects.push(`prepare:${revision.id}`);
        return fixture.compute.prepareRevision(revision);
      },
      async stopRevision(revision) {
        effects.push(`stop:${revision.id}`);
      },
      async retireRevision(revision) {
        effects.push(`retire:${revision.id}`);
      },
      async deleteAgentRuntimeCredentials({ agent }) {
        effects.push(`credentials:${agent.id}`);
      },
    });

    const revision = await fixture.revision(owner, 1);
    await fixture.work(revision, "succeeded");
    const running = await fixture.currentAgent(owner);
    assert.equal(running?.desiredRuntimeState, "running");
    assert.equal(running?.activeRevisionId, revision.id);

    const stop = await fixture.requestStop(owner);
    await fixture.work(stop, "succeeded");
    const [stopped, retainedRevision] = await fixture.state.read(async (view) =>
      Promise.all([
        view.agents.findAgent(fixture.namespace.id, owner.id),
        view.revisions.findRevision(fixture.namespace.id, owner.id, revision.id),
      ]),
    );
    assert.equal(stopped?.desiredRuntimeState, "stopped");
    assert.equal(stopped?.activeRevisionId, undefined);
    assert.equal(retainedRevision?.id, revision.id);

    await fixture.controller.deleteAgent(fixture.actor.id, fixture.namespace.id, owner.id);
    await waitFor(`Agent ${owner.id} lifecycle deletion to complete`, async () => {
      const deleted = await fixture.currentAgent(owner);
      return deleted === undefined ? true : undefined;
    });
    const [deletedRevision, deletedIdentity, remainingWork] = await Promise.all([
      fixture.state.read((view) =>
        view.revisions.findRevision(fixture.namespace.id, owner.id, revision.id),
      ),
      fixture.observerPool.query<RemovedCountRow, [string]>(
        "SELECT count(*)::integer AS count FROM occ.iam_identities WHERE id = $1",
        [owner.servicePrincipalId],
      ),
      fixture.observerPool.query<RemovedCountRow, [string]>(
        "SELECT count(*)::integer AS count FROM occ.controller_work WHERE agent_id = $1",
        [owner.id],
      ),
    ]);
    assert.equal(deletedRevision, undefined);
    assert.deepEqual(deletedIdentity.rows, [{ count: 0 }]);
    assert.deepEqual(remainingWork.rows, [{ count: 0 }]);
    assert.deepEqual(effects, [
      `prepare:${revision.id}`,
      `stop:${revision.id}`,
      `retire:${revision.id}`,
      `credentials:${owner.id}`,
    ]);

    const lifecycleAudit = await fixture.observerPool.query<LifecycleAuditRow, [string, string]>(
      `SELECT action, outcome, details->>'reasonCode' AS reason_code
       FROM occ.audit_events
       WHERE namespace_id = $1 AND resource_id = $2
         AND action IN (
           'openclaw.agents.lifecycle.stop',
           'openclaw.agents.lifecycle.delete'
         )
       ORDER BY occurred_at`,
      [fixture.namespace.id, owner.id],
    );
    assert.deepEqual(lifecycleAudit.rows, [
      {
        action: "openclaw.agents.lifecycle.stop",
        outcome: "success",
        reason_code: "AGENT_STOPPED",
      },
      {
        action: "openclaw.agents.lifecycle.delete",
        outcome: "success",
        reason_code: "AGENT_DELETED",
      },
    ]);
  },
);

revisionTest(
  "maintenance completion takes the Namespace lock before the Agent, like deployment admission",
  async (fixture) => {
    const { owner, candidate } = await fixture.admitInitialRevision("maintenance-lock-order");
    await fixture.start({ ...fixture.compute, maintenanceIntervalMs: 200 });
    await fixture.work(candidate, "succeeded");
    async function succeededMaintenance() {
      const { rows } = await fixture.observerPool.query<MaintenanceCountRow, [string]>(
        `SELECT count(*) AS count FROM occ.controller_work
         WHERE revision_id = $1 AND idempotency_key LIKE '%:maintenance:%'
           AND state = 'succeeded'`,
        [candidate.id],
      );
      const row = rows[0];
      assert.ok(row);
      return Number(row.count);
    }
    await waitFor("one completed maintenance pass", async () =>
      (await succeededMaintenance()) > 0 ? true : undefined,
    );

    // Deployment admission locks the Namespace, then the Agent. Hold the Namespace
    // until the worker waits on it; the waiting worker must not hold the Agent, or
    // admission and maintenance completion deadlock.
    const before = await withNamespaceLockHeld(
      fixture.observerPool,
      fixture.namespace.id,
      async (lock) => {
        await lock.waitForBlocked("the worker's real wait on the Namespace lock");
        const succeeded = await succeededMaintenance();
        await lock.assertNotHeld(
          "SELECT id FROM occ.agents WHERE namespace_id = $1 AND id = $2 FOR UPDATE NOWAIT",
          [fixture.namespace.id, owner.id],
          "a worker waiting for the Namespace must not already hold the Agent",
        );
        return succeeded;
      },
    );
    await waitFor("the maintenance chain to continue", async () =>
      (await succeededMaintenance()) > before ? true : undefined,
    );
  },
);

revisionTest(
  "development workers run supplied after-commit activation hooks and retry incomplete finalization",
  async (fixture) => {
    const { owner, candidate } = await fixture.admitInitialRevision("development-after-commit", {
      agent: { executionMode: "dedicated" },
    });
    const activations: {
      revisionId: AgentRevision["id"];
      activeRevisionId: AgentRevision["id"] | null;
      secretEnvironment: ComputeRevisionContext["secretEnvironment"] | null;
    }[] = [];
    let failed = false;

    await fixture.start({
      ...fixture.compute,
      async activateRevision(revision, activationContext) {
        activations.push({
          revisionId: revision.id,
          activeRevisionId: (await fixture.currentAgent(owner))?.activeRevisionId ?? null,
          secretEnvironment: activationContext?.secretEnvironment ?? null,
        });
        if (!failed) {
          failed = true;
          throw new Error("route publication failed");
        }
      },
    });

    const completed = await fixture.work(candidate, "succeeded");
    // Incomplete finalization requeues the same claim without spending an
    // attempt, but the second activation call proves the recovery pass ran.
    assert.equal(completed.attempt_count, 1);
    assert.equal((await fixture.currentAgent(owner))?.activeRevisionId, candidate.id);
    assert.deepEqual(
      activations.filter(({ revisionId }) => revisionId === candidate.id),
      [
        { revisionId: candidate.id, activeRevisionId: candidate.id, secretEnvironment: [] },
        { revisionId: candidate.id, activeRevisionId: candidate.id, secretEnvironment: [] },
      ],
    );

    const activation = await fixture.observerPool.query<{ resource_id: string }, [string]>(
      `SELECT resource_id
       FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.activate'`,
      [fixture.namespace.id],
    );
    assert.deepEqual(activation.rows, [{ resource_id: candidate.id }]);
  },
);

test(
  "an older revision retry is superseded without preparing or retiring a newer active revision",
  requiresPostgres,
  async (context) => {
    const metrics = createOccMetrics("worker", () =>
      new PostgresMetricsSnapshot(fixture.observerPool).collect(),
    );
    const fixture = await setup(context, { metrics });
    const { owner, candidate: older } = await fixture.admitInitialRevision("superseded-retry");
    const newer = await fixture.revision(owner, 2);
    const effects: RevisionEffect[] = [];
    const events: WorkerEvent[] = [];
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(candidate) {
          effects.push({ action: "prepare", revisionId: candidate.id });
          const observation = await fixture.compute.prepareRevision(candidate);
          return candidate.id === older.id ? { ...observation, ready: false } : observation;
        },
        async retireRevision(candidate) {
          effects.push({ action: "retire", revisionId: candidate.id });
          return fixture.compute.retireRevision(candidate);
        },
      },
      { emit: (event) => events.push(event) },
    );

    await Promise.all([fixture.work(newer, "succeeded"), fixture.work(older, "succeeded")]);
    // The deploy duration is observed just before the newer revision's completion
    // event; the older retry's supersession completes without a deploy observation.
    await completion(
      events,
      "the newer revision's successful completion",
      ({ event, workId, outcome }) =>
        event === "worker.completed" && workId === newer.idempotencyKey && outcome === "success",
    );
    await completion(
      events,
      "the older revision's REVISION_SUPERSEDED completion",
      ({ event, code, revisionId }) =>
        event === "worker.completed" && code === "REVISION_SUPERSEDED" && revisionId === older.id,
    );
    assert.match(
      await metrics.exposition(),
      /occ_agent_operation_duration_seconds_count\{[^\n]*operation="deploy"[^\n]*\} 1(?:\n|$)/,
    );
    // Newer publication retires every older candidate. The later superseded retry
    // must contribute no preparation or retirement against the active revision.
    assert.deepEqual(effects, [
      { action: "prepare", revisionId: older.id },
      { action: "prepare", revisionId: newer.id },
      { action: "retire", revisionId: older.id },
    ]);
    assert.equal((await fixture.currentAgent(owner))?.activeRevisionId, newer.id);
    const superseded = await fixture.observerPool.query<
      LifecycleAuditRow & { active_revision_id: string | null },
      [string]
    >(
      `SELECT action, outcome, details->>'activeRevisionId' AS active_revision_id,
              details->>'reasonCode' AS reason_code
       FROM occ.audit_events
       WHERE resource_id = $1 AND action = 'openclaw.agents.lifecycle.supersede'`,
      [older.id],
    );
    assert.deepEqual(superseded.rows, [
      {
        action: "openclaw.agents.lifecycle.supersede",
        outcome: "success",
        active_revision_id: newer.id,
        reason_code: "REVISION_SUPERSEDED",
      },
    ]);
    // The Versions list names each version's outcome with the code its record reports. The
    // superseded version is listed as failed, the record's own status, beside the code that tells
    // the console it did not fail, so a reloaded console shows no Failed mark on it (finding 2422).
    const outcomes = ({ revisions }: ListRevisionPage) =>
      revisions.map(({ id, deploymentStatus, deploymentErrorCode }) => [
        id,
        deploymentStatus,
        deploymentErrorCode,
      ]);
    const listed = await fixture.controller.listRevisions(
      fixture.actor.id,
      fixture.namespace.id,
      owner.id,
    );
    assert.deepEqual(outcomes(listed), [
      [newer.id, "succeeded", null],
      [older.id, "failed", "REVISION_SUPERSEDED"],
    ]);
    // A page that stops before the last revision carries the same outcomes.
    const first = await fixture.controller.listRevisions(
      fixture.actor.id,
      fixture.namespace.id,
      owner.id,
      { limit: 1 },
    );
    assert.deepEqual(outcomes(first), [[newer.id, "succeeded", null]]);
    assert.equal(first.nextBefore, newer.revision);
    const second = await fixture.controller.listRevisions(
      fixture.actor.id,
      fixture.namespace.id,
      owner.id,
      { limit: 1, before: first.nextBefore },
    );
    assert.deepEqual(outcomes(second), [[older.id, "failed", "REVISION_SUPERSEDED"]]);
  },
);

test(
  "a worker stopped during queue recovery leaves fresh work for its successor",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context, { maxAttempts: 1 });
    let connection: Promise<PoolClient> | undefined;
    let candidate: AdmittedRevision;
    let stopping: Promise<void>;
    try {
      await fixture.start(fixture.compute, {
        emit({ event }) {
          if (event === "worker.started") {
            // Hold the worker pool's only connection before its first recovery transaction.
            connection = fixture.workerPool.connect();
          }
        },
      });
      assert.ok(connection, "the worker must emit its start event before queue recovery");
      await connection;
      ({ candidate } = await fixture.admitInitialRevision("shutdown-before-claim"));
      stopping = fixture.stop();
    } finally {
      (await connection)?.release();
    }
    await stopping;
    const work = await fixture.observerPool.query<
      WorkStateRow & { has_claim: boolean; has_lease: boolean },
      [string]
    >(
      `SELECT state, attempt_count, claim_token IS NOT NULL AS has_claim,
              lease_expires_at IS NOT NULL AS has_lease
       FROM occ.controller_work WHERE idempotency_key = $1`,
      [candidate.idempotencyKey],
    );
    assert.deepEqual(work.rows, [
      { state: "queued", attempt_count: 0, has_claim: false, has_lease: false },
    ]);

    const prepared: string[] = [];
    await fixture.start({
      ...fixture.compute,
      async prepareRevision(revision, deploymentContext) {
        prepared.push(revision.id);
        return fixture.compute.prepareRevision(revision, deploymentContext);
      },
    });
    const succeeded = await fixture.work(candidate, "succeeded");
    await fixture.stop();
    assert.equal(succeeded.attempt_count, 1);
    assert.deepEqual(prepared, [candidate.id]);
  },
);

test(
  "a graceful shutdown during Compute preparation logs the interrupted pass, not errors",
  requiresPostgres,
  async (context) => {
    // Stopping the worker aborts the pass in flight. Its claim stays available for lease recovery,
    // so no compute-prepare-failed or CLAIM_LOST error is logged.
    const events: WorkerEvent[] = [];
    const lines: unknown[] = [];
    const logged = createWorkerLogEmitter(
      createOccLogger({
        component: "occ-worker",
        level: "debug",
        destination: jsonLineDestination(lines),
      }),
    );
    const preparing = Promise.withResolvers<AbortSignal | undefined>();
    const releasePreparation = Promise.withResolvers<void>();
    const release = () => releasePreparation.resolve();
    // Release the held Compute call before fixture teardown if a test assertion fails.
    context.after(release);
    const fixture = await setup(context);
    const { candidate } = await fixture.admitInitialRevision("compute-preparation-shutdown");
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision, revisionContext) {
          if (revision.id !== candidate.id) {
            return fixture.compute.prepareRevision(revision, revisionContext);
          }
          const signal = currentComputeAbortSignal();
          signal?.addEventListener("abort", release, { once: true });
          preparing.resolve(signal);
          await releasePreparation.promise;
          signal?.removeEventListener("abort", release);
          throw new Error("Kubernetes request aborted by the worker");
        },
        describePrepareRevisionFailure() {
          return { code: "KUBERNETES_PREPARATION_FAILED", stage: "prepare_revision" };
        },
      },
      {
        emit: (event) => {
          events.push(event);
          logged(event);
        },
      },
    );
    const signal = await preparing.promise;
    assert.ok(signal, "the worker must pass its abort signal into Compute preparation");
    assert.equal(signal.aborted, false);
    await fixture.stop();
    assert.equal(signal.aborted, true);

    assert.deepEqual(
      events.filter(({ event }) => event !== "worker.health").map(({ event }) => event),
      ["worker.started", "worker.pass-interrupted", "worker.stopped"],
    );
    assert.deepEqual(
      events.find(({ event }) => event === "worker.pass-interrupted"),
      {
        event: "worker.pass-interrupted",
        workId: candidate.idempotencyKey,
        attempt: 1,
        operation: "agent_revision.reconcile",
        cause: "WorkerStopping",
      },
    );
    assert.deepEqual(
      lines
        .map((line) => {
          const { event, severity } = requireLogRecord(line);
          assert.equal(typeof event, "string");
          assert.equal(typeof severity, "string");
          return { event, severity };
        })
        .filter(({ event }) => event !== "worker.health"),
      [
        { event: "worker.started", severity: "INFO" },
        { event: "worker.pass-interrupted", severity: "INFO" },
        { event: "worker.stopped", severity: "INFO" },
      ],
    );
    // The work keeps its claim until the lease expires; then another worker resumes it.
    const work = await fixture.observerPool.query<WorkStateRow, [string]>(
      "SELECT state, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
      [candidate.idempotencyKey],
    );
    assert.deepEqual(work.rows, [{ state: "claimed", attempt_count: 1 }]);
  },
);

revisionTest(
  "a stop orders the running revision by the database clock, not the controller clock",
  async (fixture) => {
    // The controller clock that stamps each admission runs five minutes ahead of PostgreSQL's
    // for one Agent and behind for the other. The stop's creation time is on the database clock,
    // so the admission must be too. Ahead, the running revision would read as admitted after the
    // stop, which would finish STOP_SUPERSEDED and leave the runtime running (finding 1195).
    const stopped: string[] = [];
    await fixture.start({
      ...fixture.compute,
      async stopRevision(revision) {
        stopped.push(revision.id);
        return fixture.compute.stopRevision(revision);
      },
    });
    for (const [label, controllerSkewMs] of [
      ["ahead", 300_000],
      ["behind", -300_000],
    ] as const) {
      const owner = await fixture.agent(`stop-clock-${label}`);
      const candidate = await fixture.revision(owner, 1, { controllerSkewMs });
      const admitted = (
        await fixture.observerPool.query<{ admitted_at: Date; age_ms: string }, [string]>(
          `SELECT admitted_at, EXTRACT(EPOCH FROM clock_timestamp() - admitted_at) * 1000 AS age_ms
           FROM occ.agent_revisions WHERE id = $1`,
          [candidate.id],
        )
      ).rows[0];
      assert.ok(admitted);
      // The store stamped admission on its own clock and returned that stamp.
      const ageMs = Number(admitted.age_ms);
      assert.ok(ageMs >= 0 && ageMs < 60_000, `${label}: admitted ${ageMs} ms ago`);
      assert.equal(candidate.createdAt, admitted.admitted_at.toISOString(), label);
      await fixture.work(candidate, "succeeded");
      assert.equal((await fixture.currentAgent(owner))?.activeRevisionId, candidate.id, label);

      const stop = await fixture.requestStop(owner);
      await fixture.work(stop, "succeeded");
      const audit = await fixture.observerPool.query<AuditReasonRow, [string, string]>(
        `SELECT details->>'reasonCode' AS reason_code FROM occ.audit_events
         WHERE namespace_id = $1 AND resource_id = $2 AND action = 'openclaw.agents.lifecycle.stop'`,
        [fixture.namespace.id, owner.id],
      );
      assert.deepEqual(audit.rows, [{ reason_code: "AGENT_STOPPED" }], label);
      assert.ok(stopped.includes(candidate.id), `${label}: the running revision was stopped`);
      const current = await fixture.currentAgent(owner);
      assert.ok(current);
      assert.equal(current.desiredRuntimeState, "stopped", label);
      assert.equal(current.activeRevisionId, undefined, label);
    }
  },
);

test(
  "a lost retirement claim preserves the activated replacement and cannot complete stolen work",
  requiresPostgres,
  async (context) => {
    const releaseRetirement = Promise.withResolvers<void>();
    // Release the held effect before fixture teardown joins the worker on failure.
    context.after(() => releaseRetirement.resolve());
    const fixture = await setup(context);
    const { owner, candidate: first } = await fixture.admitInitialRevision("stale-retirement");
    const effects: RevisionEffect[] = [];
    const events: WorkerEvent[] = [];
    let retirements = 0;
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(candidate) {
          effects.push({ action: "prepare", revisionId: candidate.id });
          return fixture.compute.prepareRevision(candidate);
        },
        async retireRevision(previous) {
          retirements += 1;
          effects.push({ action: "retire", revisionId: previous.id });
          if (retirements === 1) {
            await releaseRetirement.promise;
          }
          return fixture.compute.retireRevision(previous);
        },
      },
      { emit: (event) => events.push(event) },
    );
    await fixture.work(first, "succeeded");
    const { idempotencyKey, ...firstRevision } = first;
    const skipped: AgentRevision = {
      ...firstRevision,
      id: `rev_${randomUUID()}`,
      revision: 2,
      createdAt: new Date().toISOString(),
    };
    // A persisted but never-started intermediate revision must not hide the serving predecessor.
    await fixture.state.transact((unit) => unit.revisions.createRevision(skipped));
    const second = await fixture.revision(owner, 3);
    await waitFor("the real worker to block in predecessor retirement", async () =>
      retirements === 1 ? true : undefined,
    );
    // Publishing success is not attributable until route publication and teardown have finished.
    const prematureActivation = await fixture.observerPool.query<{ action: string }, [string]>(
      `SELECT action FROM occ.audit_events
       WHERE resource_id = $1 AND action = 'openclaw.agents.lifecycle.activate'`,
      [second.id],
    );
    assert.equal(prematureActivation.rowCount, 0);

    const original = await fixture.work(second, "claimed");
    assert.equal(original.attempt_count, 1);
    const originalToken = original.claim_token;
    assert.ok(originalToken, "the worker must hold a live claim before it can lose it");
    const expired = await expireWorkLease(fixture.observerPool, {
      key: second.idempotencyKey,
      claimToken: originalToken,
    });
    assert.equal(expired.rowCount, 1);
    const recoveryQueue = new fixture.PostgresWorkQueue(fixture.observerPool, {
      leaseDurationMs: 30_000,
      maxAttempts: 5,
      random: () => 0,
    });
    const recovery = await recoveryQueue.recoverStale();
    assert.ok(recovery.recovered >= 1);
    const recovered = await recoveryQueue.claim();
    assert.ok(recovered, "the recovered revision must receive a fresh active claim");
    assert.equal(recovered.idempotencyKey, second.idempotencyKey);
    assert.notEqual(recovered.claimToken, originalToken);

    releaseRetirement.resolve();
    await waitFor("the expired worker to report claim loss", async () =>
      events.find(({ event, code }) => event === "worker.error" && code === "CLAIM_LOST"),
    );
    // Activation committed before teardown; a stolen claim cannot mark that teardown complete.
    const unchanged = await fixture.observerPool.query<
      { active_revision_id: string | null; state: ControllerWorkState; claim_token: string | null },
      [string, string, string]
    >(
      `SELECT agent.active_revision_id, work.state, work.claim_token
       FROM occ.agents AS agent
       JOIN occ.controller_work AS work
         ON work.namespace_id = agent.namespace_id AND work.agent_id = agent.id
       WHERE agent.namespace_id = $1 AND agent.id = $2 AND work.idempotency_key = $3`,
      [fixture.namespace.id, owner.id, second.idempotencyKey],
    );
    assert.deepEqual(unchanged.rows, [
      {
        active_revision_id: second.id,
        state: "claimed",
        claim_token: recovered.claimToken,
      },
    ]);
    const staleCompletion = await fixture.observerPool.query<{ action: string }, [string]>(
      `SELECT action FROM occ.audit_events
       WHERE resource_id = $1
         AND details->>'reasonCode' = 'RECONCILE_SUCCEEDED'`,
      [second.id],
    );
    assert.equal(staleCompletion.rowCount, 0);

    await recoveryQueue.retry(recovered, { code: "TEST_RECOVERY_HANDOFF" });
    await fixture.work(second, "succeeded");
    assert.equal((await fixture.currentAgent(owner))?.activeRevisionId, second.id);
    assert.equal(retirements, 3);
    assert.equal(
      effects.filter(({ action, revisionId }) => action === "retire" && revisionId === first.id)
        .length,
      2,
    );
    assert.equal(
      effects.filter(({ action, revisionId }) => action === "prepare" && revisionId === second.id)
        .length,
      2,
    );
    const activation = await fixture.observerPool.query<{ action: string }, [string]>(
      `SELECT action FROM occ.audit_events
       WHERE resource_id = $1 AND action = 'openclaw.agents.lifecycle.activate'`,
      [second.id],
    );
    assert.equal(activation.rowCount, 1);
  },
);
