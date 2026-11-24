import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, type TestContext } from "node:test";
import pg, { type QueryResult } from "pg";
import type { ControllerWorkerOptions } from "../../apps/controller/src/worker.ts";
import { OpenShellAdmissionLimitError } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type {
  Agent,
  ComputeDriver,
  ComputePreparationFailureEvidence,
  RuntimeFailureEvidence,
} from "../../packages/contracts/src/index.ts";
import {
  ActivationPendingError,
  ComputePreparationFailedError,
  DependencyUnavailableError,
  SandboxGatewayUnavailableError,
  TransientDependencyError,
  type ControllerOptions,
  type ControllerWorkState,
  type OpenClawController,
  type DeploymentStatusResult,
} from "../../packages/occ/src/index.ts";
import { createBackendController, requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import type {
  RevisionFixture,
  WorkerEvent,
  WorkIdentity,
} from "../helpers/postgres-worker-refused-candidate.ts";
import { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";
import {
  advanceCleanupRetries,
  completion,
  makeWorkDue,
} from "../helpers/postgres-worker-revision-queue.ts";
import {
  assertFailedDeployment,
  runPreparationFailureCase,
  type WorkResultRow,
} from "../helpers/postgres-worker-revision-scenarios.ts";
import {
  repositoryAttempts,
  repositoryBoundary,
} from "../helpers/postgres-worker-revision-support.mjs";
import { waitFor } from "../helpers/wait-for.ts";

type AgentIdentity = Pick<Agent, "id">;
type RevisionIdentity = Pick<WorkIdentity, "id">;
type ConvergenceFixture = Pick<
  RevisionFixture,
  | "actor"
  | "admitInitialRevision"
  | "advanceMaintenance"
  | "compute"
  | "controller"
  | "currentAgent"
  | "installation"
  | "namespace"
  | "observerPool"
  | "PostgresWorkQueue"
  | "requestStop"
  | "revision"
  | "start"
  | "state"
  | "stop"
  | "work"
  | "workResult"
> & {
  activePointer(owner: AgentIdentity): Promise<QueryResult<ActiveRevisionRow>>;
  deploymentStatus(
    owner: AgentIdentity,
    revision: RevisionIdentity,
  ): Promise<DeploymentStatusResult>;
  expireClaim(
    work: Pick<WorkIdentity, "idempotencyKey">,
    token: string,
  ): Promise<{ rowCount: number | null }>;
};
type SetupOptions = NonNullable<
  Parameters<ReturnType<typeof createWorkerRevisionFixtures>["setup"]>[1]
>;
const makeController: (
  fixture: Pick<ConvergenceFixture, "installation" | "state">,
  options: Pick<ControllerOptions, "backends" | "now">,
) => OpenClawController = createBackendController;

// Each case clones this file's migrated template and owns its worker and connections.
const {
  setup,
  cleanup,
}: {
  setup(
    context: Pick<TestContext, "after">,
    options?: Pick<SetupOptions, "maxAttempts" | "repoDriver">,
  ): Promise<ConvergenceFixture>;
  cleanup: ReturnType<typeof createWorkerRevisionFixtures>["cleanup"];
} = createWorkerRevisionFixtures(import.meta.url);
after(cleanup);

function revisionTest(
  name: string,
  run: (fixture: ConvergenceFixture, context: TestContext) => Promise<void>,
) {
  test(name, requiresPostgres, async (context) => {
    await run(await setup(context), context);
  });
}

type WorkStateRow = { state: ControllerWorkState };
type ActiveRevisionRow = { active_revision_id: string | null };
type PendingAttempt = NonNullable<DeploymentStatusResult["progress"]>["lastAttempt"];
type RepositoryGitMaterialState = Awaited<
  ReturnType<NonNullable<ControllerWorkerOptions["repositoryGitMaterial"]>>
>;
type FirstTokenScenario = {
  agent: "new" | "existing" | "stopped-before-activation";
  material: RepositoryGitMaterialState;
};
type DeadlineScenario = {
  wait: ConstructorParameters<typeof ActivationPendingError>[0];
  material: RepositoryGitMaterialState;
};

async function retirementStates(
  fixture: Pick<ConvergenceFixture, "observerPool">,
  revisionId: string,
) {
  const { rows } = await fixture.observerPool.query<WorkStateRow, [string]>(
    "SELECT state FROM occ.controller_work WHERE revision_id = $1 AND idempotency_key LIKE '%:repository_cleanup:retire:%'",
    [revisionId],
  );
  return rows;
}

async function activeRevisionId(
  fixture: Pick<ConvergenceFixture, "namespace" | "observerPool">,
  owner: AgentIdentity,
) {
  const {
    rows: [row],
  } = await fixture.observerPool.query<ActiveRevisionRow, [string, string]>(
    "SELECT active_revision_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
    [fixture.namespace.id, owner.id],
  );
  assert.ok(row, "missing persisted Agent");
  return row.active_revision_id;
}

function readMilliseconds(value: unknown): number {
  // pg returns PostgreSQL numeric expressions as text.
  assert.equal(typeof value, "string");
  const milliseconds = Number(value);
  assert.ok(Number.isFinite(milliseconds), `expected finite milliseconds, got ${value}`);
  return milliseconds;
}

function eventMilliseconds(event: WorkerEvent, field: string): number {
  const value = event[field];
  assert.ok(typeof value === "number" && Number.isFinite(value), `missing worker timing ${field}`);
  return value;
}

revisionTest(
  "deployment progress distinguishes deferred work and isolates each work item's evidence",
  async (fixture) => {
    const { owner, candidate } = await fixture.admitInitialRevision("deployment-progress");
    const queue = new fixture.PostgresWorkQueue(fixture.observerPool);
    const readStatus = () => fixture.deploymentStatus(owner, candidate);

    const initial = await readStatus();
    assert.equal(initial.status, "queued");
    assert.ok(initial.progress);
    assert.equal(initial.progress.lastAttempt, null);

    const evidenceCodes = async () =>
      (
        await fixture.observerPool.query<{ code: string | null }, [string]>(
          `SELECT details->>'reasonCode' AS code FROM occ.audit_events
           WHERE details->>'workId' = $1 AND action = 'reconcile' ORDER BY occurred_at, id`,
          [candidate.idempotencyKey],
        )
      ).rows.map(({ code }) => code);
    const makeDue = () => makeWorkDue(fixture.observerPool, candidate.idempotencyKey);

    // A normal pending observation restores the failure budget to zero. It must
    // still be distinguishable from a deployment that has never been checked.
    const first = await queue.claim();
    assert.ok(first, "expected a claim for the due work");
    assert.equal(first.idempotencyKey, candidate.idempotencyKey);
    await queue.defer(first, { code: "REVISION_INCOMPLETE" }, { delayMs: 60_000 });
    const firstDeferred = await readStatus();
    assert.deepEqual(await evidenceCodes(), ["REVISION_INCOMPLETE"]);
    // The work is queued again between attempts, but a deploy a worker has started never reports
    // queued again: the console showed In progress -> Queued for ~16 s (finding 2456).
    assert.equal(firstDeferred.status, "running");

    // Repeating the same pending result is not a state transition: it adds no audit row,
    // and progress keeps reporting when that result was first recorded.
    await makeDue();
    const claim = await queue.claim();
    assert.ok(claim, "expected a claim for the due work");
    assert.equal(claim.idempotencyKey, candidate.idempotencyKey);
    await queue.defer(claim, { code: "REVISION_INCOMPLETE" }, { delayMs: 60_000 });
    const deferred = await readStatus();
    assert.deepEqual(await evidenceCodes(), ["REVISION_INCOMPLETE"]);
    assert.ok(firstDeferred.progress);
    assert.ok(deferred.progress?.lastAttempt);
    assert.deepEqual(deferred.progress.lastAttempt, firstDeferred.progress.lastAttempt);
    assert.equal(deferred.status, "running");
    // The Versions list reads the same status from the same work and evidence.
    const listed = await fixture.controller.listRevisions(
      fixture.actor.id,
      fixture.namespace.id,
      owner.id,
    );
    assert.deepEqual(
      listed.revisions.map(({ id, deploymentStatus }) => [id, deploymentStatus]),
      [[candidate.id, "running"]],
    );
    const deferredWork = await queue.findWork(candidate.idempotencyKey);
    assert.ok(deferredWork);
    assert.equal(deferredWork.attemptCount, 0);
    assert.equal(deferred.progress.lastAttempt.code, "REVISION_INCOMPLETE");
    assert.equal(deferred.progress.lastAttempt.message, "Waiting for the runtime to become ready.");
    assert.ok(Number.isFinite(Date.parse(deferred.progress.lastAttempt.at)));
    assert.equal(deferred.progress.nextAttemptAt, deferredWork.availableAt.toISOString());

    // Maintenance shares the revision and actor, but cannot overwrite the
    // original deployment's progress. Both transitions use the real queue.
    const maintenanceKey = `agent_revision:${candidate.id}:maintenance:0`;
    await queue.enqueue({
      idempotencyKey: maintenanceKey,
      namespaceId: fixture.namespace.id,
      agentId: owner.id,
      revisionId: candidate.id,
      actorId: fixture.actor.id,
    });
    const maintenance = await queue.claim();
    assert.ok(maintenance, "expected a claim for the due work");
    assert.equal(maintenance.idempotencyKey, maintenanceKey);
    await queue.defer(maintenance, { code: "DEPENDENCY_UNAVAILABLE" }, { delayMs: 60_000 });
    assert.deepEqual((await readStatus()).progress, deferred.progress);

    // Rescheduling only our fixture work lets a new claim exercise retry output.
    await makeDue();
    const retry = await queue.claim();
    assert.ok(retry, "expected a claim for the due work");
    assert.equal(retry.idempotencyKey, candidate.idempotencyKey);
    const running = await readStatus();
    assert.equal(running.status, "running");
    assert.ok(running.progress);
    assert.equal(running.progress.nextAttemptAt, null);
    assert.deepEqual(running.progress.lastAttempt, deferred.progress.lastAttempt);
    await queue.retry(retry, { code: "PRIVATE_PROVIDER_DETAIL_DO_NOT_EXPOSE" });
    const retrying = await readStatus();
    assert.equal(retrying.status, "running");
    assert.equal(retrying.progress?.lastAttempt?.code, "RECONCILIATION_PENDING");
    assert.doesNotMatch(JSON.stringify(retrying), /PRIVATE_PROVIDER/);

    // Returning to the pending result after a failure is a transition and is recorded again.
    await makeDue();
    const recovered = await queue.claim();
    assert.ok(recovered, "expected a claim for the due work");
    assert.equal(recovered.idempotencyKey, candidate.idempotencyKey);
    await queue.defer(recovered, { code: "REVISION_INCOMPLETE" }, { delayMs: 60_000 });
    const codes = await evidenceCodes();
    assert.equal(codes.length, 3);
    assert.equal(codes[0], "REVISION_INCOMPLETE");
    assert.equal(codes[2], "REVISION_INCOMPLETE");
    assert.equal((await readStatus()).progress?.lastAttempt?.code, "REVISION_INCOMPLETE");

    // Let the real worker finish this admitted revision; completion must remove
    // the pending explanation rather than retain an obsolete readiness warning.
    await makeDue();
    await fixture.start(fixture.compute);
    await fixture.work(candidate, "succeeded");
    const completed = await readStatus();
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.progress, null);
  },
);

revisionTest(
  "an expired claim keeps a started deployment running under any controller clock",
  async (fixture) => {
    const { owner, candidate } = await fixture.admitInitialRevision("deployment-clock");
    const queue = new fixture.PostgresWorkQueue(fixture.observerPool, { leaseDurationMs: 60_000 });
    // Both controllers read the same durable work with clocks skewed far from PostgreSQL's.
    const statusFrom = (instant: string) => {
      const controller = makeController(fixture, {
        backends: [],
        now: () => new Date(instant),
      });
      return async () =>
        (
          await controller.getDeploymentStatus(
            fixture.actor.id,
            fixture.namespace.id,
            owner.id,
            candidate.id,
          )
        ).status;
    };
    const statusAhead = statusFrom("2999-01-01T00:00:00Z");
    const statusBehind = statusFrom("1970-01-01T00:00:00Z");

    const claim = await queue.claim();
    assert.ok(claim, "expected a claim for the due work");
    assert.equal(claim.idempotencyKey, candidate.idempotencyKey);
    // A controller clock ahead of the lease still reports the live claim.
    assert.equal(await statusAhead(), "running");

    await fixture.expireClaim(candidate, claim.claimToken);
    // An expired claim does not take a started deploy back to queued under either clock
    // (finding 2456): the next claim resumes it.
    assert.equal(await statusBehind(), "running");
    assert.equal(await statusAhead(), "running");
  },
);

revisionTest(
  "revision cleanup status reads queued until claimed, running between attempts and its result once recorded",
  async (fixture) => {
    const repository = repositoryBoundary().snapshot;
    const { owner, candidate } = await fixture.admitInitialRevision("cleanup-status", {
      revision: { repositoryCredentials: repository },
    });
    const queue = new fixture.PostgresWorkQueue(fixture.observerPool);
    const readStatus = () => fixture.deploymentStatus(owner, candidate);

    // The deployment records evidence, then its preparation fails permanently. As the worker
    // does, the failing claim registers the revision's cleanup and then fails the deployment.
    const deferredDeploy = await queue.claim();
    assert.ok(deferredDeploy, "expected a claim for the due work");
    assert.equal(deferredDeploy.idempotencyKey, candidate.idempotencyKey);
    await queue.defer(deferredDeploy, { code: "REVISION_INCOMPLETE" }, { delayMs: 60_000 });
    await makeWorkDue(fixture.observerPool, candidate.idempotencyKey);
    const deploy = await queue.claim();
    assert.ok(deploy, "expected a claim for the due work");
    assert.equal(deploy.idempotencyKey, candidate.idempotencyKey);
    const revisionOwner = {
      namespaceId: fixture.namespace.id,
      agentId: owner.id,
      revisionId: candidate.id,
    };
    await queue.enqueueRepositoryCleanup(deploy, revisionOwner, "failed-preparation");
    const binding = repository.bindings[0];
    assert.ok(binding);
    // Deployment failure transfers a still-unconfirmed opening to retirement.
    await fixture.state.transact(async ({ repositorySessions }) => {
      const now = new Date();
      await repositorySessions.createAttempt({
        ...revisionOwner,
        admissionId: `${now.getTime()}-${randomUUID()}`,
        repositoryRef: binding.repositoryRef,
        durationSeconds: 60,
        deadlineWallMs: repository.deadlineWallMs,
        createdAt: now.toISOString(),
        brokerProtocol: 3,
      });
    });
    await queue.fail(deploy, { code: "HARNESS_CREDENTIAL_BOOTSTRAP_FAILED" });

    // No worker has claimed the cleanup yet: it waits, whatever its deployment recorded
    // (findings 2456, 2466 apply only to started work).
    const waiting = await readStatus();
    assert.equal(waiting.status, "failed");
    assert.equal(waiting.cleanup?.status, "queued");
    assert.equal(typeof waiting.cleanup.nextAttemptAt, "string");

    // A claimed cleanup runs and has no next attempt; it has recorded no result.
    const claim = await queue.claim();
    assert.ok(claim, "expected a claim for the due work");
    assert.match(claim.idempotencyKey, /^agent_revision:[^:]+:repository_cleanup:retire:/);
    assert.equal(claim.revisionId, candidate.id);
    assert.deepEqual((await readStatus()).cleanup, { status: "running", nextAttemptAt: null });

    // A deferral refunds the count, but exact-work evidence keeps terminal retirement running.
    await queue.defer(claim, { code: "DEPENDENCY_UNAVAILABLE" }, { delayMs: 60_000 });
    const deferred = await queue.findWork(claim.idempotencyKey);
    assert.equal(deferred?.attemptCount, 0);
    assert.deepEqual((await readStatus()).cleanup, {
      status: "running",
      nextAttemptAt: deferred.availableAt.toISOString(),
    });

    // A retry counts the attempt and queues the cleanup again. It stays running between
    // attempts and still reports no result.
    await makeWorkDue(fixture.observerPool, claim.idempotencyKey);
    const retry = await queue.claim();
    assert.ok(retry);
    assert.equal(retry.idempotencyKey, claim.idempotencyKey);
    await queue.retry(retry, { code: "DEPENDENCY_UNAVAILABLE" });
    const retried = await queue.findWork(claim.idempotencyKey);
    assert.ok(retried, "missing retried cleanup work");
    assert.equal(retried.attemptCount, 1);
    const retrying = await readStatus();
    assert.equal(retrying.cleanup?.status, "running");
    assert.equal(typeof retrying.cleanup.nextAttemptAt, "string");

    // Only the recorded result completes it.
    await makeWorkDue(fixture.observerPool, claim.idempotencyKey);
    const last = await queue.claim();
    assert.ok(last, "expected a claim for the due work");
    assert.equal(last.idempotencyKey, claim.idempotencyKey);
    assert.equal((await readStatus()).cleanup?.status, "running");
    await queue.complete(last, { code: "REPOSITORY_CLEANUP_COMPLETE" });
    assert.deepEqual((await readStatus()).cleanup, { status: "succeeded", nextAttemptAt: null });

    // A later Stop can transfer its own cleanup obligation for the same revision.
    // The already-completed retirement must not mask that independent work.
    await fixture.controller.stopAgent(fixture.actor.id, fixture.namespace.id, owner.id);
    const stop = await queue.claim();
    assert.ok(stop);
    assert.equal(stop.agentTarget, "stopped");
    const sessions = await queue.enqueueRepositoryCleanup(stop, revisionOwner);
    assert.ok(sessions);
    await queue.complete(stop, { code: "AGENT_STOPPED" });
    const pending = await readStatus();

    const disposal = await queue.claim();
    assert.ok(disposal);
    assert.equal(disposal.idempotencyKey, sessions.idempotencyKey);
    const running = await readStatus();

    assert.deepEqual(
      [pending.cleanup, running.cleanup],
      [
        { status: "queued", nextAttemptAt: sessions.availableAt.toISOString() },
        { status: "running", nextAttemptAt: null },
      ],
      "completed retirement must not mask pending or running session disposal",
    );
    assert.deepEqual([pending.status, running.status], ["failed", "failed"]);

    await queue.complete(disposal, { code: "REPOSITORY_CLEANUP_COMPLETE" });
    assert.deepEqual((await readStatus()).cleanup, { status: "succeeded", nextAttemptAt: null });
  },
);

revisionTest(
  "real PostgreSQL preserves the failure budget while an Agent runtime converges",
  async (fixture) => {
    const { owner, candidate } = await fixture.admitInitialRevision("slow-runtime");
    let observations = 0;
    const events: WorkerEvent[] = [];

    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision) {
          const observation = await fixture.compute.prepareRevision(revision);
          observations += 1;
          // Image pulls and app-server startup remain ordinary pending observations, not failures.
          return observations <= 7 ? { ...observation, ready: false } : observation;
        },
      },
      { emit: (event) => events.push(event) },
    );

    const completed = await fixture.work(candidate, "succeeded");
    assert.equal(observations, 8);
    assert.equal(completed.attempt_count, 1);

    // Each pass reports its deployment phase timing; the successful pass carries
    // the totals across all eight passes of this one work item.
    const passes = await waitFor("the successful deployment pass to be reported", () => {
      const reported = events.filter(
        (event) => event.event === "worker.completed" && event.workId === candidate.idempotencyKey,
      );
      return reported.at(-1)?.outcome === "success" ? reported : undefined;
    });
    assert.deepEqual(
      passes.map(({ outcome, code, deployPasses }) => ({ outcome, code, deployPasses })),
      [
        ...Array.from({ length: 7 }, (_, index) => ({
          outcome: "pending",
          code: "REVISION_INCOMPLETE",
          deployPasses: index + 1,
        })),
        { outcome: "success", code: "REVISION_ACTIVATED", deployPasses: 8 },
      ],
    );
    for (const pass of passes.slice(0, 7)) {
      assert.equal(pass.activationMs, undefined, "an unready pass has no activation phase");
    }

    const success = passes.at(-1);
    const previous = passes[6];
    assert.ok(success && previous);
    const readinessWaitMs = eventMilliseconds(success, "readinessWaitMs");
    const elapsedMs = eventMilliseconds(success, "elapsedMs");
    const prepareMs = eventMilliseconds(success, "prepareMs");
    const activationMs = eventMilliseconds(success, "activationMs");
    const durationMs = eventMilliseconds(success, "durationMs");
    // Seven jittered readiness retries separate the first unready and the ready observation.
    assert.ok(readinessWaitMs > 0);
    assert.ok(readinessWaitMs >= eventMilliseconds(previous, "readinessWaitMs"));
    assert.ok(elapsedMs >= readinessWaitMs);
    assert.ok(prepareMs >= 0 && prepareMs <= elapsedMs);
    assert.ok(activationMs >= 0 && activationMs <= durationMs);
    assert.ok(durationMs <= elapsedMs);

    // The pending state is durable and attributable, but seven identical deferrals are one
    // state transition: the audit log records it once, then the activation.
    const evidence = await fixture.observerPool.query<
      { outcome: string; reason_code: string | null },
      [string]
    >(
      `SELECT outcome, details->>'reasonCode' AS reason_code FROM occ.audit_events
       WHERE resource_id = $1 AND action = 'reconcile' ORDER BY occurred_at, id`,
      [candidate.id],
    );
    assert.deepEqual(evidence.rows, [
      { outcome: "success", reason_code: "REVISION_INCOMPLETE" },
      { outcome: "success", reason_code: "REVISION_ACTIVATED" },
    ]);
    assert.equal(await activeRevisionId(fixture, owner), candidate.id);
  },
);

revisionTest(
  "real PostgreSQL rechecks a not-ready runtime on a short fixed delay after transient failures",
  async (fixture) => {
    const { candidate } = await fixture.admitInitialRevision("readiness-recheck");
    const recheckDelays: Promise<(WorkStateRow & { delay_ms: string }) | undefined>[] = [];
    let observations = 0;

    try {
      await fixture.start(
        {
          ...fixture.compute,
          async prepareRevision(revision) {
            if (revision.id !== candidate.id) {
              return fixture.compute.prepareRevision(revision);
            }
            observations += 1;
            // Two dependency failures raise the attempt count, so the queue's
            // exponential retry backoff would now allow up to 4 s per recheck.
            if (observations <= 2) {
              throw new Error("transient Compute dependency failure");
            }
            const observation = await fixture.compute.prepareRevision(revision);
            return observations <= 5 ? { ...observation, ready: false } : observation;
          },
        },
        {
          emit: (event) => {
            if (
              event.event === "worker.completed" &&
              event.workId === candidate.idempotencyKey &&
              event.outcome === "pending"
            ) {
              // Read while the deferral is still queued, about 500 ms after this event.
              const observation = fixture.observerPool
                .query<WorkStateRow & { delay_ms: string }, [string]>(
                  `SELECT state, EXTRACT(EPOCH FROM (available_at - updated_at)) * 1000 AS delay_ms
                   FROM occ.controller_work WHERE idempotency_key = $1`,
                  [candidate.idempotencyKey],
                )
                .then(({ rows }) => rows[0]);
              // A read can fail before the worker finishes. Keep its rejection for the join.
              void observation.catch(() => {});
              recheckDelays.push(observation);
            }
          },
        },
      );

      const completed = await fixture.work(candidate, "succeeded", 30_000);
      assert.equal(observations, 6);
      // Failures consumed two attempts; readiness rechecks refunded theirs.
      assert.equal(completed.attempt_count, 3);
      const rechecks = await Promise.all(recheckDelays);
      assert.equal(rechecks.length, 3);
      for (const row of rechecks) {
        assert.ok(row, "missing queued readiness work");
        assert.equal(row.state, "queued");
        const delayMs = readMilliseconds(row.delay_ms);
        assert.ok(
          delayMs > 450 && delayMs <= 500,
          `readiness recheck must wait about 500 ms, not the retry backoff (${delayMs} ms)`,
        );
      }
    } finally {
      // Stop the producer before draining any reads still in flight on failure.
      try {
        await fixture.stop();
      } finally {
        await Promise.allSettled(recheckDelays);
      }
    }
  },
);

revisionTest(
  "terminal Compute preparation persists failure and resumes exact cleanup after worker restart",
  async (fixture) => {
    const { owner, candidate } = await fixture.admitInitialRevision("bootstrap-failure");
    let preparations = 0;
    let cleanupAllowed = false;
    let cleanups = 0;
    const preparation: ComputePreparationFailureEvidence = {
      workload: {
        kind: "Job",
        name: "oauth-bootstrap-fixture",
        uid: randomUUID(),
        namespace: "tenant-fixture",
      },
      reason: "retry_limit",
      observedAt: "2026-10-12T12:00:00.000Z",
      startedAt: null,
      finishedAt: null,
      pods: [],
    };
    const compute: ComputeDriver = {
      ...fixture.compute,
      async prepareRevision() {
        preparations += 1;
        throw new ComputePreparationFailedError("HARNESS_CREDENTIAL_BOOTSTRAP_FAILED", preparation);
      },
      async stopRevision(revision) {
        // Runtime retirement must start only after the deployment is terminal.
        const {
          rows: [failed],
        } = await fixture.workResult(candidate);
        assert.equal(failed?.reason_code, "HARNESS_CREDENTIAL_BOOTSTRAP_FAILED");
        assert.equal(revision.id, candidate.id);
        cleanups += 1;
        if (!cleanupAllowed) {
          throw new DependencyUnavailableError("Temporary cleanup outage.");
        }
        await fixture.compute.stopRevision(revision);
      },
    };
    await fixture.start(compute);
    await assertFailedDeployment(
      fixture,
      { owner, candidate },
      {
        error: {
          code: "HARNESS_CREDENTIAL_BOOTSTRAP_FAILED",
          message: "Harness credential initialization failed. Correct the cause and deploy again.",
          data: { preparation },
        },
        resultData: { preparation },
      },
    );
    await waitFor("failed preparation to retain its cleanup obligation", async () => {
      const [row] = await retirementStates(fixture, candidate.id);
      return cleanups > 0 && row?.state === "queued" ? row : undefined;
    });
    await fixture.stop();

    // The failed cleanup attempt queued its work for a retry. A cleanup a worker has started never
    // reports queued again between its attempts, as a deployment does not (finding 2466).
    const pendingStatus = await fixture.deploymentStatus(owner, candidate);
    assert.equal(pendingStatus.cleanup?.status, "running");
    assert.equal(typeof pendingStatus.cleanup?.nextAttemptAt, "string");
    // The database must reject raw provider output even if a writer bypasses
    // the controller's public evidence validator.
    await assert.rejects(
      fixture.observerPool.query<Record<string, never>, [string, string]>(
        "UPDATE occ.controller_work SET result_data = $2::jsonb WHERE idempotency_key = $1",
        [
          candidate.idempotencyKey,
          JSON.stringify({ preparation: { ...preparation, rawOutput: "provider detail" } }),
        ],
      ),
      (error) =>
        error instanceof pg.DatabaseError &&
        error.code === "23514" &&
        error.constraint === "controller_work_result_data_state",
    );

    // The new worker resumes cleanup from PostgreSQL, without invoking
    // preparation again even though the Driver's bootstrap resources are gone.
    cleanupAllowed = true;
    await advanceCleanupRetries(fixture, candidate);
    await fixture.start(compute);
    await waitFor("failed preparation cleanup after restart", async () => {
      const [row] = await retirementStates(fixture, candidate.id);
      return row?.state === "succeeded" ? row : undefined;
    });
    assert.equal(preparations, 1);
    assert.ok(cleanups >= 2);
    assert.equal((await fixture.deploymentStatus(owner, candidate)).status, "failed");
    const completedStatus = await fixture.deploymentStatus(owner, candidate);
    assert.equal(completedStatus.cleanup?.status, "succeeded");
    assert.deepEqual(completedStatus.error?.data, { preparation });
    assert.equal(await activeRevisionId(fixture, owner), null);
  },
);

revisionTest(
  "an overdue Agent runtime fails closed without activating its incomplete revision",
  async (fixture) => {
    const { owner, candidate } = await fixture.admitInitialRevision("expired-runtime");
    const runtimeFailure: RuntimeFailureEvidence = {
      component: "gateway",
      check: "readyz",
      checkedAt: "2026-09-19T20:30:00.000Z",
      code: "STARTUP_FAILED",
    };

    // A real short deadline expires against the durable queued creation timestamp.
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision) {
          return {
            ...(await fixture.compute.prepareRevision(revision)),
            ready: false,
            runtimeFailure,
          };
        },
      },
      { convergenceTimeoutMs: 1 },
    );

    const failed = await fixture.work(candidate, "failed_permanent");
    assert.equal(failed.attempt_count, 1);
    assert.equal(await activeRevisionId(fixture, owner), null);
    const evidence = await fixture.observerPool.query<{ reason: string }, [string]>(
      `SELECT details->>'reasonCode' AS reason FROM occ.audit_events
       WHERE resource_id = $1 AND details->>'reasonCode' = 'CONVERGENCE_DEADLINE_EXCEEDED'`,
      [candidate.id],
    );
    assert.deepEqual(evidence.rows, [{ reason: "CONVERGENCE_DEADLINE_EXCEEDED" }]);
    // The Compute observation carried a check and code outside the runtime's vocabulary. They
    // are recorded as UNRECOGNIZED, so neither the stored work nor its status carries them
    // (finding 1660).
    const recordedRuntimeFailure = {
      ...runtimeFailure,
      check: "UNRECOGNIZED",
      code: "UNRECOGNIZED",
    };
    const {
      rows: [recorded],
    } = await fixture.observerPool.query<Pick<WorkResultRow, "result_data">, [string]>(
      "SELECT result_data FROM occ.controller_work WHERE idempotency_key = $1",
      [candidate.idempotencyKey],
    );
    assert.deepEqual(recorded?.result_data, {
      timeoutMs: 1,
      runtimeFailure: recordedRuntimeFailure,
    });
    const status = await fixture.deploymentStatus(owner, candidate);
    assert.equal(status.status, "failed");
    assert.deepEqual(status.error, {
      code: "CONVERGENCE_DEADLINE_EXCEEDED",
      message:
        "Deployment convergence deadline exceeded: the version did not become ready in time. Check its logs and runtime diagnostics, correct the cause if there is one, then deploy a new version.",
      data: { timeoutMs: 1, runtimeFailure: recordedRuntimeFailure },
    });
    assert.deepEqual(status.warnings, []);
    // A runtime that failed by itself stays for diagnosis: nothing retires it.
    assert.equal(status.cleanup, null);
  },
);

revisionTest(
  "an OAuth bootstrap still running at the convergence deadline retires its revision with the failure",
  async (fixture) => {
    const { owner, candidate } = await fixture.admitInitialRevision("expired-bootstrap");
    const stopped: string[] = [];
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision) {
          return {
            ...(await fixture.compute.prepareRevision(revision)),
            ready: false,
            pendingReason: "HARNESS_CREDENTIAL_BOOTSTRAP_PENDING",
          };
        },
        async stopRevision(revision) {
          stopped.push(revision.id);
          await fixture.compute.stopRevision(revision);
        },
      },
      { convergenceTimeoutMs: 1 },
    );

    await fixture.work(candidate, "failed_permanent");
    // The retirement obligation commits with the failure, so the bootstrap Job and its
    // seed Secret (the OAuth token bundle) cannot outlive the failed revision.
    assert.equal((await retirementStates(fixture, candidate.id)).length, 1);
    const status = await fixture.deploymentStatus(owner, candidate);
    assert.equal(status.status, "failed");
    assert.deepEqual(status.error, {
      code: "CONVERGENCE_DEADLINE_EXCEEDED",
      message:
        "Deployment convergence deadline exceeded: the version did not become ready in time. Check its logs and runtime diagnostics, correct the cause if there is one, then deploy a new version.",
      data: { timeoutMs: 1 },
    });
    assert.notEqual(status.cleanup, null);
    await waitFor("the expired bootstrap's revision cleanup", async () => {
      const [row] = await retirementStates(fixture, candidate.id);
      return row?.state === "succeeded" ? row : undefined;
    });
    assert.ok(stopped.includes(candidate.id));
    assert.equal(await activeRevisionId(fixture, owner), null);
  },
);

revisionTest(
  "the convergence deadline judges work age by the database clock, not the controller clock",
  async (fixture, context) => {
    // The worker's wall clock disagrees with PostgreSQL's by five minutes, first ahead and then
    // behind. Work's creation time is on the database clock, so its deadline must be too:
    // otherwise skew alone retires a pending OAuth bootstrap early or holds it past the deadline.
    // Each direction has its own deployment, a minute or more from the deadline by the database
    // clock, so neither outcome depends on how soon the worker's first pass runs (finding 1171).
    const timeoutMs = 60_000;
    const skewMs = 300_000;
    let controllerSkewMs = skewMs;
    // The worker reads the global clock. context.mock restores it when this test ends, even on
    // failure, and the file runs one test at a time, so no other test sees the skew.
    const realNow = Date.now;
    const controllerClock = context.mock.method(Date, "now", () => realNow() + controllerSkewMs);
    const outcomes = new Map<string, string[]>();
    const passes = ({ idempotencyKey }: Pick<WorkIdentity, "idempotencyKey">) =>
      outcomes.get(idempotencyKey) ?? [];
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision) {
          return {
            ...(await fixture.compute.prepareRevision(revision)),
            ready: false,
            pendingReason: "HARNESS_CREDENTIAL_BOOTSTRAP_PENDING",
          };
        },
      },
      {
        convergenceTimeoutMs: timeoutMs,
        emit: (event) => {
          const { workId, outcome } = event;
          if (
            event.event === "worker.completed" &&
            typeof workId === "string" &&
            typeof outcome === "string"
          ) {
            outcomes.set(workId, [...(outcomes.get(workId) ?? []), outcome]);
          }
        },
      },
    );
    const workRow = async (candidate: WorkIdentity) =>
      (
        await fixture.observerPool.query<WorkStateRow & { age_ms: string }, [string]>(
          `SELECT state, EXTRACT(EPOCH FROM COALESCE(completed_at, clock_timestamp()) - created_at)
                    * 1000 AS age_ms
           FROM occ.controller_work WHERE idempotency_key = $1`,
          [candidate.idempotencyKey],
        )
      ).rows[0];
    // Ahead: the controller clock already counts new work as five minutes old, past the deadline,
    // yet by the database clock it is young, so the bootstrap keeps waiting.
    const young = await fixture.admitInitialRevision("deadline-clock-ahead");
    await waitFor(
      "a pass ahead of the database clock",
      async () => passes(young.candidate)[0],
      timeoutMs - 15_000,
    );
    const youngRow = await workRow(young.candidate);
    assert.ok(youngRow);
    assert.ok(
      readMilliseconds(youngRow.age_ms) < timeoutMs,
      `work is still young (${youngRow.age_ms} ms)`,
    );
    assert.equal(passes(young.candidate)[0], "pending");
    assert.notEqual(youngRow.state, "failed_permanent");
    assert.deepEqual(await retirementStates(fixture, young.candidate.id), []);

    // Behind: work admitted two minutes ago by the database clock is past the deadline, though the
    // controller clock would not count it as old for another four minutes. Its first pass fails it.
    controllerSkewMs = -skewMs;
    const old = await fixture.admitInitialRevision("deadline-clock-behind", {
      revision: { workAge: `${(2 * timeoutMs) / 1000} seconds` },
    });
    await fixture.work(old.candidate, "failed_permanent", 30_000);
    await waitFor("the old work's pass", async () => passes(old.candidate)[0]);
    controllerClock.mock.restore();
    const failed = await workRow(old.candidate);
    assert.ok(failed);
    assert.ok(
      readMilliseconds(failed.age_ms) >= timeoutMs,
      `failed past the deadline (${failed.age_ms} ms)`,
    );
    assert.deepEqual(passes(old.candidate), ["permanent"]);
    const status = await fixture.deploymentStatus(old.owner, old.candidate);
    assert.equal(status.error?.code, "CONVERGENCE_DEADLINE_EXCEEDED");
    assert.deepEqual(status.error?.data, { timeoutMs });
    // The deadline retires the bootstrap with the failure.
    assert.equal((await retirementStates(fixture, old.candidate.id)).length, 1);
  },
);

revisionTest(
  "a Gateway route that lags its Ready Pod is retried within the deadline, not the attempt budget",
  async (fixture) => {
    const { owner, candidate } = await fixture.admitInitialRevision("gateway-route-lag");
    const events: WorkerEvent[] = [];
    const progress: (PendingAttempt | undefined)[] = [];
    let failures = 0;

    // D28: the worker reaches a new Gateway through its private route as soon as
    // the Pod is Ready. Until Envoy programs the new HTTPRoute the upgrade answers
    // 404, for longer than five quick retries last. Fail more passes than the
    // attempt budget allows, then let the route converge.
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision, revisionContext) {
          if (failures < 8) {
            failures += 1;
            if (failures === 3) {
              const status = await fixture.deploymentStatus(owner, candidate);
              progress.push(status.progress?.lastAttempt);
            }
            throw new TransientDependencyError(
              "agent_gateway",
              "unavailable",
              "The Agent Gateway route answered HTTP 404 to the connection upgrade.",
            );
          }
          return fixture.compute.prepareRevision(revision, revisionContext);
        },
      },
      { emit: (event) => events.push(event) },
    );

    const succeeded = await fixture.work(candidate, "succeeded", 30_000);
    assert.equal(failures, 8);
    assert.equal(succeeded.attempt_count, 1);
    assert.equal((await fixture.deploymentStatus(owner, candidate)).status, "succeeded");
    assert.equal(progress.length, 1);
    assert.equal(progress[0]?.code, "AGENT_GATEWAY_UNAVAILABLE");
    assert.equal(
      progress[0]?.message,
      "The Agent Gateway was not reachable through its route yet. The controller will retry until the deployment deadline.",
    );
    const passes = events.filter(
      (event) => event.event === "worker.completed" && event.revisionId === candidate.id,
    );
    assert.deepEqual(
      passes.slice(0, 8).map(({ outcome, code, dependency, cause }) => ({
        outcome,
        code,
        dependency,
        cause,
      })),
      Array.from({ length: 8 }, () => ({
        outcome: "pending",
        code: "AGENT_GATEWAY_UNAVAILABLE",
        dependency: "agent_gateway",
        cause: "unavailable",
      })),
    );
  },
);

revisionTest(
  "a Sandbox gateway outage longer than the attempt budget waits, then the deployment activates",
  async (fixture) => {
    const { owner, candidate } = await fixture.admitInitialRevision("sandbox-gateway-outage");
    const events: WorkerEvent[] = [];
    // Finding 2040 (D28, finding 1658): while the OpenShell gateway is scaled down or restarting,
    // every request of the pass answers gRPC UNAVAILABLE, which the gateway client raises as a
    // SandboxGatewayUnavailableError. The outage holds until the test has seen more passes than
    // the attempt budget (5), whatever their backoff, and only then does the gateway come back.
    let held = true;
    let passes = 0;
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision, revisionContext) {
          if (held) {
            passes += 1;
            throw new SandboxGatewayUnavailableError(
              "OpenShell CreateSandbox failed with gRPC status 14.",
            );
          }
          return fixture.compute.prepareRevision(revision, revisionContext);
        },
      },
      { emit: (event) => events.push(event) },
    );

    const waited = await waitFor(
      "more passes against the stopped gateway than the attempt budget",
      async () => {
        const {
          rows: [work],
        } = await fixture.observerPool.query<WorkStateRow & { attempt_count: number }, [string]>(
          "SELECT state, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
          [candidate.idempotencyKey],
        );
        assert.notEqual(work?.state, "failed_permanent", "the outage spent the budget");
        return passes > 7 && work?.state === "queued" ? work : undefined;
      },
      30_000,
    );
    assert.equal(waited.attempt_count, 0);
    // Read the status between passes, when the work waits for its next attempt. A started
    // deploy still reads as `running` there (finding 2456).
    const during = await waitFor("the deployment status between outage passes", async () => {
      const status = await fixture.deploymentStatus(owner, candidate);
      return status.progress?.nextAttemptAt ? status : undefined;
    });
    held = false;
    assert.equal(during.status, "running");
    assert.deepEqual(
      {
        code: during.progress?.lastAttempt?.code,
        message: during.progress?.lastAttempt?.message,
      },
      {
        code: "SANDBOX_GATEWAY_UNAVAILABLE",
        message:
          "The Sandbox gateway did not answer the controller yet. The controller will retry until the deployment deadline.",
      },
    );

    const succeeded = await fixture.work(candidate, "succeeded", 30_000);
    assert.equal(succeeded.attempt_count, 1);
    assert.equal((await fixture.currentAgent(owner))?.activeRevisionId, candidate.id);
    const outagePasses = events.filter(
      (event) =>
        event.event === "worker.completed" &&
        event.revisionId === candidate.id &&
        event.outcome !== "success",
    );
    assert.ok(outagePasses.length > 7, `saw ${outagePasses.length} outage passes`);
    assert.deepEqual(
      new Set(
        outagePasses.map(({ outcome, code, dependency, cause }) =>
          JSON.stringify({ outcome, code, dependency, cause }),
        ),
      ),
      new Set([
        JSON.stringify({
          outcome: "pending",
          code: "SANDBOX_GATEWAY_UNAVAILABLE",
          dependency: "sandbox_gateway",
          cause: "unavailable",
        }),
      ]),
    );
  },
);

revisionTest(
  "an activation wait or a lagging Gateway route keeps its own code, not REVISION_FINALIZATION_INCOMPLETE",
  async (fixture) => {
    const { owner, candidate } = await fixture.admitInitialRevision("activation-wait-codes");
    const events: WorkerEvent[] = [];
    const progress: (PendingAttempt | undefined)[] = [];
    const readProgress = async () =>
      (await fixture.deploymentStatus(owner, candidate)).progress?.lastAttempt;
    let activations = 0;

    // D330: dedicated activation runs after the pointer is published. It waits
    // for the Gateway to apply its workspace node, for the Harness node to
    // connect, and reaches the Gateway through its route, which can answer 404
    // while Envoy converges. Each pass must name what it waits on.
    await fixture.start(
      {
        ...fixture.compute,
        async activateRevision(revision, revisionContext) {
          activations += 1;
          if (activations > 1) {
            progress.push(await readProgress());
          }
          if (activations <= 2) {
            throw new ActivationPendingError(
              "WORKSPACE_NODE_BINDING_PENDING",
              "The exact AgentRevision gateway has not applied its workspace node.",
            );
          }
          if (activations === 3) {
            throw new ActivationPendingError(
              "WORKSPACE_NODE_PENDING",
              "The exact AgentRevision Harness node is not ready.",
            );
          }
          if (activations === 4) {
            throw new TransientDependencyError(
              "agent_gateway",
              "unavailable",
              "The Agent Gateway route answered HTTP 404 to the connection upgrade.",
            );
          }
          if (activations === 5) {
            throw new RangeError("unexpected activation failure");
          }
          return fixture.compute.activateRevision?.(revision, revisionContext);
        },
      },
      { emit: (event) => events.push(event) },
    );

    await fixture.work(candidate, "succeeded", 30_000);
    assert.equal(activations, 6);
    assert.deepEqual(
      progress.map((attempt) => [attempt?.code, attempt?.message]),
      [
        [
          "WORKSPACE_NODE_BINDING_PENDING",
          "Workloads are ready; waiting for the Gateway to apply the workspace node.",
        ],
        [
          "WORKSPACE_NODE_BINDING_PENDING",
          "Workloads are ready; waiting for the Gateway to apply the workspace node.",
        ],
        [
          "WORKSPACE_NODE_PENDING",
          "Workloads are ready; waiting for the workspace node to connect to the Gateway.",
        ],
        [
          "AGENT_GATEWAY_UNAVAILABLE",
          "The Agent Gateway was not reachable through its route yet. The controller will retry until the deployment deadline.",
        ],
        [
          "RECONCILIATION_PENDING",
          "Deployment has not completed. Another reconciliation is pending.",
        ],
      ],
    );
    const passes = events
      .filter(
        (event) =>
          event.event === "worker.completed" &&
          event.revisionId === candidate.id &&
          event.outcome === "pending",
      )
      .slice(-5)
      .map(({ code, dependency, cause }) => ({ code, dependency, cause }));
    assert.deepEqual(passes, [
      {
        code: "WORKSPACE_NODE_BINDING_PENDING",
        dependency: undefined,
        cause: "ActivationPendingError",
      },
      {
        code: "WORKSPACE_NODE_BINDING_PENDING",
        dependency: undefined,
        cause: "ActivationPendingError",
      },
      { code: "WORKSPACE_NODE_PENDING", dependency: undefined, cause: "ActivationPendingError" },
      { code: "AGENT_GATEWAY_UNAVAILABLE", dependency: "agent_gateway", cause: "unavailable" },
      { code: "REVISION_FINALIZATION_INCOMPLETE", dependency: undefined, cause: "RangeError" },
    ]);
    const succeeded = await fixture.work(candidate, "succeeded");
    assert.equal(succeeded.attempt_count, 1);
  },
);

// The admission-limit case uses the real OpenShellAdmissionLimitError class, thrown from a
// stubbed Compute prepareRevision; the gateway wire test proves the client raises it. The
// limit frees up as completed admissions age out, so it must wait like any other dependency
// instead of spending the attempt budget.
for (const { label, failure, code, message } of [
  {
    label: "Kubernetes API",
    failure: () =>
      new TransientDependencyError(
        "kubernetes_api",
        "timeout",
        "A Kubernetes API request timed out.",
      ),
    code: "KUBERNETES_API_UNAVAILABLE",
    message:
      "The Kubernetes API was still unavailable at the deployment deadline. Deploy again; if it keeps failing, ask an operator to check the cluster's API server.",
  },
  {
    label: "OpenShell admission limit",
    failure: () =>
      new OpenShellAdmissionLimitError("CreateSandbox", {
        code: 8,
        details:
          "caller has reached the durable mutation admission limit; unresolved requests require reconciliation",
      }),
    code: "SANDBOX_ADMISSION_LIMIT_REACHED",
    message:
      "The Sandbox gateway still refused new controller requests (request admission limit reached) at the deployment deadline. Deploy again once other Sandbox work has finished; if it keeps failing, ask an operator to check the gateway's request limit.",
  },
  {
    // Finding 2040: a gateway that never comes back is bounded by the deadline too.
    label: "Sandbox gateway",
    failure: () =>
      new SandboxGatewayUnavailableError("OpenShell CreateSandbox failed with gRPC status 14."),
    code: "SANDBOX_GATEWAY_UNAVAILABLE",
    message:
      "The Sandbox gateway still did not answer the controller at the deployment deadline. Deploy again; if it keeps failing, ask an operator to check the Sandbox gateway.",
  },
]) {
  test(
    `a dependency still failing at the convergence deadline fails deployment with its own code (${label})`,
    requiresPostgres,
    async (context) => {
      // The 2.5 s deadline fits only four to six passes on a loaded runner, too close
      // to the default budget of five; with one attempt, more passes than the budget
      // means two.
      const fixture = await setup(context, { maxAttempts: 1 });
      const observations = await runPreparationFailureCase(
        fixture,
        {
          label: "dependency-down",
          failure,
          convergenceTimeoutMs: 2_500,
          expected: { error: { code, message } },
        },
        30_000,
      );
      assert.ok(
        observations > 1,
        `expected more passes than the attempt budget, saw ${observations}`,
      );
    },
  );
}

// Finding 2415: native prepared Git issues a version's first token only after its active pointer
// is published, so a ready runtime reported success while every Git request answered 503. The
// deployment now waits for the token. Owner decision 2026-10-28 (finding 2425) for a version
// whose token GitHub's answer quarantined: a new Agent's deployment fails and its version is
// retired; an existing Agent's deployment fails but the version keeps running without Git, so
// the Agent can still chat and report it. A token still pending at the convergence deadline
// (finding 2894: no attempt finished, for example an unreadable App key) ends the same way: a new
// Agent's version is retired, an existing Agent's is kept and gets Git if the token arrives.
for (const { agent, material } of [
  { agent: "new", material: "ready" },
  { agent: "new", material: "quarantined" },
  { agent: "new", material: "pending" },
  { agent: "existing", material: "quarantined" },
  { agent: "existing", material: "pending" },
  // The earlier version's deployment completed without activation: still a new Agent.
  { agent: "stopped-before-activation", material: "quarantined" },
] satisfies FirstTokenScenario[]) {
  test(
    `a ${agent} Agent's native repository deployment waits for its first GitHub token, ` +
      `then handles a ${material} token`,
    requiresPostgres,
    async (context) => {
      const repository = repositoryBoundary();
      const fixture = await setup(context, { repoDriver: repository.driver });
      const revisionOptions = { repositoryCredentials: repository.snapshot };
      // A stopped repository version fails its deployment (REPOSITORY_REVISION_STOPPED), so the
      // version stopped before activation binds no repository.
      const { owner, candidate: first } = await fixture.admitInitialRevision(
        `repository-token-${agent}-${material}`,
        { revision: agent === "stopped-before-activation" ? {} : revisionOptions },
      );
      const ready = async (): Promise<RepositoryGitMaterialState> => "ready";
      if (agent === "existing") {
        await fixture.start(fixture.compute, { repositoryGitMaterial: ready });
        await fixture.work(first, "succeeded");
        await fixture.stop();
      } else if (agent === "stopped-before-activation") {
        // The Agent is stopped while its first version prepares: that deployment completes
        // REVISION_STOPPED, a succeeded work row that never activated anything.
        const { promise: released, resolve: release } = Promise.withResolvers<void>();
        const { promise: started, resolve: preparing } = Promise.withResolvers<void>();
        await fixture.start(
          {
            ...fixture.compute,
            async prepareRevision(revision) {
              preparing();
              await released;
              return fixture.compute.prepareRevision(revision);
            },
          },
          { repositoryGitMaterial: ready },
        );
        await started;
        const stop = await fixture.requestStop(owner);
        release();
        await fixture.work(first, "succeeded");
        await fixture.work(stop, "succeeded");
        await fixture.stop();
        const {
          rows: [result],
        } = await fixture.workResult(first);
        assert.ok(result, "the stopped deployment has a persisted work result");
        assert.equal(result.reason_code, "REVISION_STOPPED");
      }
      const candidate = agent === "new" ? first : await fixture.revision(owner, 2, revisionOptions);
      const checked: string[] = [];
      const stopped: string[] = [];
      const retired: string[] = [];
      let published = 0;
      let waiting: DeploymentStatusResult | undefined;
      const compute: ComputeDriver = {
        ...fixture.compute,
        async stopRevision(revision) {
          stopped.push(revision.id);
          return fixture.compute.stopRevision(revision);
        },
        async retireRevision(revision) {
          retired.push(revision.id);
          return fixture.compute.retireRevision(revision);
        },
      };
      const events: WorkerEvent[] = [];
      await fixture.start(compute, {
        emit: (event) => events.push(event),
        // A pending token ends at the convergence deadline.
        ...(material === "pending" ? { convergenceTimeoutMs: 3_000 } : {}),
        async repositoryGitMaterial(revisionId) {
          // A later version (below) gets its token at once.
          if (revisionId !== candidate.id) {
            return "ready";
          }
          checked.push(revisionId);
          // In production the worker's prepared owner reports the token state; this returns the
          // states its store returns (postgres-prepared-github-git-use test). Like the owner,
          // nothing is issued before the pointer is published. The first check after it
          // records the wait; GitHub answers before the next one.
          const pointer = (await fixture.activePointer(owner)).rows[0]?.active_revision_id;
          if (pointer !== candidate.id || published++ === 0) {
            return "pending";
          }
          waiting ??= await fixture.deploymentStatus(owner, candidate);
          return material;
        },
      });
      await fixture.work(candidate, material === "ready" ? "succeeded" : "failed_permanent");
      assert.ok(checked.length >= 2 && checked.every((id) => id === candidate.id), checked.join());
      // The wait is visible as progress, never as success.
      assert.ok(waiting, "the deployment reported its token wait");
      assert.notEqual(waiting.status, "succeeded");
      assert.equal(waiting.progress?.lastAttempt?.code, "REPOSITORY_GIT_MATERIAL_PENDING");
      const status = await fixture.deploymentStatus(owner, candidate);
      const pointer = () => activeRevisionId(fixture, owner);
      if (material === "ready") {
        assert.equal(status.status, "succeeded");
        assert.equal(status.error, null);
        assert.equal(await pointer(), candidate.id);
        assert.deepEqual(stopped, []);
        return;
      }
      // A quarantined version is never prepared again, so its deployment fails at once instead
      // of at the convergence deadline, and names the cause and the recovery. A token still
      // pending ends at the deadline: a new Agent's deployment names the deadline, an existing
      // Agent's names the missing token and keeps the version.
      assert.equal(status.status, "failed");
      assert.ok(status.error, "the failed deployment reports an error");
      let expectedCode = "CONVERGENCE_DEADLINE_EXCEEDED";
      if (material === "quarantined") {
        expectedCode = "REPOSITORY_GIT_TOKEN_QUARANTINED";
      } else if (agent === "existing") {
        expectedCode = "REPOSITORY_GIT_TOKEN_PENDING";
      }
      assert.equal(status.error.code, expectedCode);
      assert.match(status.error.message, /deploy a new version\.$/);
      const retirement = () =>
        fixture.observerPool.query<WorkStateRow, [string, string]>(
          `SELECT state FROM occ.controller_work
           WHERE revision_id = $1 AND idempotency_key LIKE $2`,
          [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:retire:%`],
        );
      if (agent !== "existing") {
        // A new Agent fails: like any repository version that failed for good, its version is
        // retired, so the Agent has no running version until a deployment succeeds.
        await waitFor("the failed version's runtime retirement", async () =>
          (await retirement()).rows[0]?.state === "succeeded" ? true : undefined,
        );
        assert.deepEqual(stopped, [candidate.id]);
        assert.equal(await pointer(), null);
        return;
      }
      // An existing Agent keeps this version serving without Git and says so. Its predecessor
      // stopped serving when the pointer moved; this deployment neither stops its own version
      // nor retires the predecessor.
      assert.match(status.error.message, /keeps this version running without Git/);
      // The pass ends with its completion event, after any Compute call it makes. A pass that
      // throws after the failure committed (for example a Compute call for a claim it no longer
      // holds) logs worker.error instead.
      const ended = await completion(
        events,
        "the failed deployment's completion",
        ({ event, workId, outcome }) =>
          event === "worker.error" ||
          (event === "worker.completed" &&
            workId === candidate.idempotencyKey &&
            outcome === "permanent"),
      );
      assert.equal(ended.event, "worker.completed", JSON.stringify(ended));
      assert.equal(await pointer(), candidate.id);
      const active = await fixture.currentAgent(owner);
      assert.ok(active, "the existing Agent remains persisted");
      assert.equal(active.desiredRuntimeState, "running");
      assert.equal((await retirement()).rowCount, 0);
      assert.deepEqual(stopped, []);
      assert.deepEqual([...retired], []);
      // A pending token can still commit after the deadline and give the kept version Git: the
      // prepared owner issues a token for an open session of the running Agent's active version
      // (postgres-prepared-github-git-use test), and this version keeps its session open.
      const openSessions = async () => [
        ...new Set(
          (await repositoryAttempts(fixture, candidate)).map(({ phase }) => phase === "open"),
        ),
      ];
      assert.deepEqual(await openSessions(), [true]);
      // The failure starts the version's maintenance chain in the same transaction; its next
      // pass keeps the version active (and retires the superseded predecessor, as any does).
      const [maintenance] = (await fixture.advanceMaintenance(candidate)).rows;
      assert.ok(maintenance, "the failed deployment queued the version's maintenance");
      const passed = await waitFor("the version's maintenance pass", async () => {
        const { rows } = await fixture.observerPool.query<
          WorkStateRow & { reason_code: string | null },
          [string]
        >("SELECT state, reason_code FROM occ.controller_work WHERE idempotency_key = $1", [
          maintenance.idempotency_key,
        ]);
        return rows[0]?.state === "succeeded" ? rows[0] : undefined;
      });
      assert.equal(passed.reason_code, "REVISION_ALREADY_ACTIVE");
      assert.equal(await pointer(), candidate.id);
      assert.deepEqual(stopped, []);
      assert.deepEqual(retired, [first.id]);
      assert.deepEqual(await openSessions(), [true]);
      // A later version whose token GitHub issues replaces the kept one as usual: its deployment
      // succeeds, takes the pointer and retires the version that ran without Git.
      const fixed = await fixture.revision(owner, 3, revisionOptions);
      await fixture.work(fixed, "succeeded");
      assert.equal((await fixture.deploymentStatus(owner, fixed)).status, "succeeded");
      assert.equal(await pointer(), fixed.id);
      assert.ok(retired.includes(candidate.id), retired.join());
      assert.equal((await fixture.deploymentStatus(owner, candidate)).status, "failed");
    },
  );
}

// Finding 2894 keeps an existing Agent's version only when the deadline ended its wait for the
// first Git token. A published version whose runtime never activated is a convergence failure
// even when its token is pending, and so is Compute's Sandbox install, which shares the token
// wait's code, once the token is committed: both retire the version as before.
for (const { wait, material } of [
  { wait: "WORKSPACE_NODE_PENDING", material: "pending" },
  { wait: "REPOSITORY_GIT_MATERIAL_PENDING", material: "ready" },
] satisfies DeadlineScenario[]) {
  test(
    `an existing Agent's native repository version that waits at ${wait} with a ${material} ` +
      "token fails at the convergence deadline and is retired",
    requiresPostgres,
    async (context) => {
      const repository = repositoryBoundary();
      const fixture = await setup(context, { repoDriver: repository.driver });
      const revisionOptions = { repositoryCredentials: repository.snapshot };
      const { owner, candidate: first } = await fixture.admitInitialRevision(
        `repository-deadline-${wait.toLowerCase()}`,
        { revision: revisionOptions },
      );
      await fixture.start(fixture.compute, { repositoryGitMaterial: async () => "ready" });
      await fixture.work(first, "succeeded");
      await fixture.stop();
      const candidate = await fixture.revision(owner, 2, revisionOptions);
      const stopped: string[] = [];
      await fixture.start(
        {
          ...fixture.compute,
          async activateRevision(revision, revisionContext) {
            // The published version's activation never completes before the deadline.
            if (revision.id === candidate.id) {
              throw new ActivationPendingError(wait, "The test runtime is not ready.");
            }
            return fixture.compute.activateRevision?.(revision, revisionContext);
          },
          async stopRevision(revision) {
            stopped.push(revision.id);
            return fixture.compute.stopRevision(revision);
          },
        },
        {
          convergenceTimeoutMs: 3_000,
          repositoryGitMaterial: async (revisionId) =>
            revisionId === candidate.id ? material : "ready",
        },
      );
      await fixture.work(candidate, "failed_permanent");
      const status = await fixture.deploymentStatus(owner, candidate);
      assert.equal(status.status, "failed");
      assert.ok(status.error, "the failed deployment reports an error");
      assert.equal(status.error.code, "CONVERGENCE_DEADLINE_EXCEEDED");
      await waitFor("the failed version's runtime retirement", async () => {
        const { rows } = await fixture.observerPool.query<WorkStateRow, [string, string]>(
          `SELECT state FROM occ.controller_work
           WHERE revision_id = $1 AND idempotency_key LIKE $2`,
          [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:retire:%`],
        );
        return rows[0]?.state === "succeeded" ? true : undefined;
      });
      assert.deepEqual(stopped, [candidate.id]);
      assert.equal(await activeRevisionId(fixture, owner), null);
    },
  );
}

test(
  "a running native repository version's maintenance ignores a quarantined token renewal",
  requiresPostgres,
  async (context) => {
    // Finding 2415: only a deployment waits for its version's token. A running version whose
    // renewal GitHub refused keeps its maintenance chain: failing that pass would fail a version
    // nobody deployed just now, and its renewal failure is reported in the worker log instead.
    const repository = repositoryBoundary();
    const fixture = await setup(context, { repoDriver: repository.driver });
    const { owner, candidate } = await fixture.admitInitialRevision("repository-token-renewal", {
      revision: { repositoryCredentials: repository.snapshot },
    });
    const events: WorkerEvent[] = [];
    let state: RepositoryGitMaterialState = "ready";
    await fixture.start(
      { ...fixture.compute, maintenanceIntervalMs: 200 },
      {
        emit: (event) => events.push(event),
        repositoryGitMaterial: async () => state,
      },
    );
    await fixture.work(candidate, "succeeded");
    // The running version's renewal is quarantined from now on.
    state = "quarantined";
    const quarantinedAt = events.length;
    const maintenance = `agent_revision:${candidate.id}:maintenance:`;
    const passes = () =>
      events
        .slice(quarantinedAt)
        .filter(
          (event) =>
            event.event === "worker.completed" &&
            typeof event.workId === "string" &&
            event.workId.startsWith(maintenance),
        );
    // Two passes, so at least one began after the quarantine.
    await waitFor("two maintenance passes after the quarantine", async () =>
      passes().length >= 2 ? true : undefined,
    );
    const completed = passes();
    assert.ok(
      completed.every(({ outcome }) => outcome === "success"),
      completed.map(({ outcome, code }) => `${outcome}:${code}`).join(),
    );
    assert.equal((await fixture.deploymentStatus(owner, candidate)).status, "succeeded");
    const active = await fixture.currentAgent(owner);
    assert.ok(active, "the running Agent remains persisted");
    assert.equal(active.activeRevisionId, candidate.id);
  },
);
