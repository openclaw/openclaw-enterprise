import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import test, { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  SandboxRevisionUnsupportedError,
  TransientDependencyError,
} from "../../packages/occ/src/index.ts";
import {
  ComputeStopYieldedError,
  computeStopShouldYield,
} from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";
import { repositoryAttempts } from "../helpers/postgres-worker-revision-support.mjs";

// Worker health, readiness, leases and outages, and exclusive replacement. Withdrawal,
// deployment and dispatch cases are in postgres-worker-agent-revision.test.mjs; repository
// sessions, Agent stop and deletion, and Namespace teardown are in
// postgres-worker-agent-revision-teardown.test.mjs. The lane runs the three files at once.

const { setup, cleanup, revisionTest } = createWorkerRevisionFixtures(import.meta.url);
after(cleanup);

test(
  "worker fixture disposal preserves another database's live claim and activation",
  requiresPostgres,
  async (context) => {
    const first = await setup(context);
    const firstOwner = await first.agent("isolated-first");
    await first.revision(firstOwner, 1);
    const second = await setup(context);
    const queue = new second.PostgresWorkQueue(second.observerPool);
    assert.equal(await queue.claim(), undefined, "workers cannot claim another fixture's work");

    const owner = await second.agent("isolated-second");
    const candidate = await second.revision(owner, 1);
    const release = Promise.withResolvers();
    let preparing = false;
    try {
      await second.start({
        ...second.compute,
        async prepareRevision(revision) {
          preparing = true;
          await release.promise;
          return second.compute.prepareRevision(revision);
        },
      });
      await waitFor("second fixture to hold its claim during preparation", async () =>
        preparing ? true : undefined,
      );
      const before = await second.work(candidate, "claimed");
      assert.equal(typeof before.claim_token, "string");

      await first.database.dispose();
      const renewed = await queue.heartbeat({
        idempotencyKey: candidate.idempotencyKey,
        claimToken: before.claim_token,
      });
      assert.equal(renewed?.claimToken, before.claim_token);
      release.resolve();
      await second.work(candidate, "succeeded");
      const activated = await second.currentAgent(owner);
      assert.equal(activated.activeRevisionId, candidate.id);
    } finally {
      // Release Compute before the registered owner teardown joins its worker.
      release.resolve();
    }
  },
);

// The worker is serial. A Compute wait that only saves a later pass asks whether
// other Work is waiting and ends early when it is, so another Agent's deploy
// runs next instead of queuing behind the wait (D221).
test(
  "a revision pass learns when another Agent's Work is waiting for the serial worker",
  { ...requiresPostgres, timeout: 30_000 },
  async (context) => {
    const { computeWorkWaiting } =
      await import("../../apps/controller/src/drivers/compute/operation-context.ts");
    const fixture = await setup(context);
    const first = await fixture.agent("waiting-first", { executionMode: "dedicated" });
    const second = await fixture.agent("waiting-second", { executionMode: "dedicated" });
    const prepared = [];
    let secondRevision;
    let wait;
    const compute = {
      ...fixture.compute,
      async prepareRevision(revision, deploymentContext) {
        prepared.push(revision.agentId);
        if (revision.agentId !== first.id || wait !== undefined) {
          return fixture.compute.prepareRevision(revision, deploymentContext);
        }
        // The first Agent's pass waits, as for its node to pair; nothing else is
        // queued yet, so nothing is waiting for the worker.
        const before = await computeWorkWaiting();
        secondRevision = await fixture.revision(second, 1);
        const started = Date.now();
        let endedEarly = false;
        while (Date.now() - started < 10_000) {
          if (await computeWorkWaiting()) {
            endedEarly = true;
            break;
          }
          await delay(25);
        }
        wait = { before, endedEarly, ms: Date.now() - started };
        return {
          ...(await fixture.compute.prepareRevision(revision, deploymentContext)),
          ready: false,
        };
      },
    };
    await fixture.start(compute);
    const firstRevision = await fixture.revision(first, 1);
    await waitFor("the second Agent to deploy during the first pass", async () => secondRevision);
    await fixture.work(secondRevision, "succeeded");
    await fixture.work(firstRevision, "succeeded");
    assert.equal(wait.before, false, "the pass's own Agent is not other Work");
    assert.equal(wait.endedEarly, true);
    assert.ok(wait.ms < 5_000, `the wait ended early (${wait.ms} ms)`);
    // The pending first pass ended and the second Agent's pass ran next.
    assert.deepEqual(prepared.slice(0, 2), [first.id, second.id]);
  },
);

revisionTest(
  "exclusive replacement blocks overlap, supersedes old maintenance and recovers through a new revision",
  async (fixture) => {
    const owner = await fixture.agent("exclusive-workspace", { executionMode: "dedicated" });
    const running = new Set();
    const prepared = [];
    let rejectStop = true;
    let stopFailures = 0;
    const compute = {
      ...fixture.compute,
      requiresStoppedPredecessors: () => true,
      async prepareRevision(revision) {
        // This Driver boundary represents a resource which cannot be held by
        // two revisions. PostgreSQL and the real worker own ordering and retries.
        assert.deepEqual(
          [...running].filter((id) => id !== revision.id),
          [],
        );
        running.add(revision.id);
        prepared.push(revision.id);
        return {
          ...(await fixture.compute.prepareRevision(revision)),
          ready: revision.revision !== 2,
        };
      },
      async stopRevision(revision) {
        if (rejectStop && running.has(revision.id)) {
          rejectStop = false;
          stopFailures += 1;
          throw new Error("resource release temporarily unavailable");
        }
        running.delete(revision.id);
      },
      async retireRevision(revision) {
        running.delete(revision.id);
      },
    };
    await fixture.start(compute, { convergenceTimeoutMs: 3_000 });
    const first = await fixture.revision(owner, 1);
    await fixture.work(first, "succeeded");
    const replacement = await fixture.revision(owner, 2);
    await waitFor("replacement preparation after predecessor release", async () =>
      running.has(replacement.id) ? true : undefined,
    );
    assert.equal(stopFailures, 1);
    const firstPreparations = prepared.filter((id) => id === first.id).length;
    const maintenance = {
      id: first.id,
      idempotencyKey: `agent_revision:${first.id}:maintenance:${randomUUID()}`,
    };
    await fixture.state.transactWithQueue((_unit, queue) =>
      queue.enqueue({
        idempotencyKey: maintenance.idempotencyKey,
        namespaceId: fixture.namespace.id,
        agentId: owner.id,
        revisionId: first.id,
        actorId: fixture.actor.id,
        availableAt: new Date(0),
      }),
    );
    await fixture.work(maintenance, "succeeded");
    assert.equal(prepared.filter((id) => id === first.id).length, firstPreparations);
    await fixture.work(replacement, "failed_permanent");
    assert.deepEqual([...running], [replacement.id]);
    const recovery = await fixture.revision(owner, 3);
    await fixture.work(recovery, "succeeded");
    assert.deepEqual([...running], [recovery.id]);
    const current = await fixture.currentAgent(owner);
    assert.equal(current.activeRevisionId, recovery.id);
  },
  { timeout: 30_000 },
);

function countingExclusiveCompute(fixture, { ready, onPrepare, runtimeFailure } = {}) {
  const running = new Set();
  const agents = new Map();
  const prepared = [];
  const stops = new Map();
  const compute = {
    ...fixture.compute,
    requiresStoppedPredecessors: () => true,
    async prepareRevision(revision) {
      const overlap = [...running].filter((id) => id !== revision.id);
      running.add(revision.id);
      agents.set(revision.id, revision.agentId);
      prepared.push(revision.id);
      await onPrepare?.(revision, overlap);
      // The candidate cannot become ready while any predecessor of its Agent still runs.
      const exclusive = [...running].every(
        (id) => id === revision.id || agents.get(id) !== revision.agentId,
      );
      const failure = runtimeFailure?.(revision);
      return {
        ...(await fixture.compute.prepareRevision(revision)),
        ready: exclusive && failure === undefined && (ready?.(revision) ?? true),
        ...(failure === undefined ? {} : { runtimeFailure: failure }),
      };
    },
    async stopRevision(revision) {
      stops.set(revision.id, (stops.get(revision.id) ?? 0) + 1);
      running.delete(revision.id);
    },
    async retireRevision(revision) {
      running.delete(revision.id);
    },
  };
  const count = (revision) => stops.get(revision.id) ?? 0;
  const preparations = (revision) => prepared.filter((id) => id === revision.id).length;
  return { compute, running, count, preparations };
}

async function enqueueMaintenance(fixture, owner, revision) {
  const maintenance = {
    id: revision.id,
    idempotencyKey: `agent_revision:${revision.id}:maintenance:${randomUUID()}`,
  };
  await fixture.state.transactWithQueue((_unit, queue) =>
    queue.enqueue({
      idempotencyKey: maintenance.idempotencyKey,
      namespaceId: fixture.namespace.id,
      agentId: owner.id,
      revisionId: revision.id,
      actorId: fixture.actor.id,
      availableAt: new Date(0),
    }),
  );
  return maintenance;
}

revisionTest(
  "exclusive replacement stops each predecessor once across pending passes and maintenance",
  async (fixture) => {
    const owner = await fixture.agent("exclusive-sweep-once", { executionMode: "dedicated" });
    let pendingPasses = 4;
    const driver = countingExclusiveCompute(fixture, {
      ready: (revision) => revision.revision !== 2 || pendingPasses-- <= 0,
    });
    await fixture.start(driver.compute);
    const first = await fixture.revision(owner, 1);
    await fixture.work(first, "succeeded");
    const replacement = await fixture.revision(owner, 2);
    await fixture.work(replacement, "succeeded", 30_000);
    assert.ok(driver.preparations(replacement) >= 5, "the replacement must repeat pending passes");
    // Exactly one stop holds because the fixture lease (30 s) outlasts this pending
    // window; with a shorter lease the scheduled re-stop would add more.
    assert.equal(driver.count(first), 1, "pending passes must not repeat the predecessor stop");

    for (let index = 0; index < 2; index += 1) {
      await fixture.work(await enqueueMaintenance(fixture, owner, replacement), "succeeded");
    }
    assert.equal(driver.count(first), 1, "maintenance must not repeat the predecessor stop");

    const recovery = await fixture.revision(owner, 3);
    await fixture.work(recovery, "succeeded");
    assert.equal(driver.count(replacement), 1);
    assert.equal(driver.count(first), 1, "a recorded predecessor is skipped by later sweeps");
    assert.deepEqual([...driver.running], [recovery.id]);
  },
  { timeout: 60_000 },
);

/** The actor loses `deploy` on the Agent, as removing its grants did on oce-dogfood-b. */
function denyDeploy(fixture, owner) {
  return fixture.observerPool.query(
    `INSERT INTO occ.iam_restrictions
       (id, namespace_id, action, resource_kind, resource_id, effect)
     VALUES ($1, $2, 'deploy', 'agent', $3, 'deny')`,
    [`restriction-${randomUUID()}`, fixture.namespace.id, owner.id],
  );
}

/**
 * Starts the refused-candidate scenario: an exclusive Agent whose first revision activated and
 * whose replacement's first pass started its runtime but is not ready. `refuse` decides how later
 * passes fail: "revoked" denies `deploy` (the next pass refuses it) and "unsupported" is refused
 * by Compute; the self-failures "held" (a held model-probe failure) and "retried" (an ordinary
 * error) are not refusals. Any other value, such as "late", only leaves the candidate unready.
 * `stopRevision(revision)` returns undefined to use the counting driver's stop or a promise that
 * replaces it, for example a failing stop. `compute` restarts the worker. `refusing()` false lets
 * Compute accept the candidate again, and `candidateReady()` makes it ready; `startOptions` go to
 * the worker. `admittedAt` is the time just before the replacement was admitted.
 */
async function startRefusedCandidate(
  fixture,
  label,
  {
    refuse = "revoked",
    stopRevision = () => undefined,
    emit,
    ready,
    refusing = () => true,
    candidateReady = () => false,
    startOptions = {},
  } = {},
) {
  const owner = await fixture.agent(label, { executionMode: "dedicated" });
  let candidateId;
  let candidatePasses = 0;
  const driver = countingExclusiveCompute(fixture, {
    ready: (revision) =>
      revision.id === candidateId ? candidateReady() : (ready?.(revision) ?? true),
    runtimeFailure: (revision) =>
      refuse === "held" && revision.id === candidateId && candidatePasses > 1
        ? {
            component: "agent",
            check: "model-probe",
            checkedAt: "2026-10-10T02:24:00.000Z",
            code: "MODEL_PROBE_FAILED",
            cause: { kind: "PROBE_STATUS", detail: "format" },
          }
        : undefined,
    async onPrepare(revision) {
      if (revision.id !== candidateId) {
        return;
      }
      candidatePasses += 1;
      if (refuse === "revoked" && candidatePasses === 1) {
        // Revoked after the runtime started; the worker's recheck on the next pass denies it.
        await denyDeploy(fixture, owner);
      }
      if (refuse === "unsupported" && candidatePasses > 1 && refusing()) {
        // A refusal decided by the pass after the newer-revision check.
        throw new SandboxRevisionUnsupportedError("SANDBOX_HARNESS_UNSUPPORTED", "test");
      }
      if (refuse === "retried" && candidatePasses > 1) {
        throw new Error("Kubernetes API temporarily unavailable");
      }
    },
  });
  const compute = {
    ...driver.compute,
    async stopRevision(revision) {
      return (
        (revision.id === candidateId ? stopRevision(revision) : undefined) ??
        driver.compute.stopRevision(revision)
      );
    },
  };
  await fixture.start(compute, { emit, ...startOptions });
  const first = await fixture.revision(owner, 1);
  await fixture.work(first, "succeeded");
  const admittedAt = Date.now();
  const replacement = await fixture.revision(owner, 2);
  candidateId = replacement.id;
  return { owner, first, replacement, driver, compute, admittedAt };
}

/**
 * A refused candidate's `stopRevision` for startRefusedCandidate that fails with `message` until
 * `succeed()` is called or it has failed `limit` times. `failed` holds each failure's start time.
 */
function failingStop({
  limit = Infinity,
  message = "Kubernetes API temporarily unavailable",
} = {}) {
  const failed = [];
  let succeeding = false;
  return {
    failed,
    succeed() {
      succeeding = true;
    },
    /** Waits until the stop has failed `count` times. */
    waitForFailures(count, timeoutMs) {
      return waitFor(
        `${count} failed refused stops`,
        async () => (failed.length >= count ? true : undefined),
        timeoutMs,
      );
    },
    stopRevision() {
      if (succeeding || failed.length >= limit) {
        return undefined;
      }
      failed.push(Date.now());
      return Promise.reject(new Error(message));
    },
  };
}

/** Passes that could not stop the refused candidate: their log names the refusal. */
function refusedStopWaits(events, candidate) {
  return events.filter(
    ({ event, workId, outcome, refusal }) =>
      event === "worker.completed" &&
      workId === candidate.idempotencyKey &&
      outcome === "pending" &&
      refusal !== undefined,
  );
}

/** Waits until `count` passes could not stop the refused candidate. */
function waitForRefusedStopWaits(events, candidate, count, timeoutMs) {
  return waitFor(
    `${count} logged refused-stop waits`,
    async () => (refusedStopWaits(events, candidate).length >= count ? true : undefined),
    timeoutMs,
  );
}

/** Waits for the work to reach `state` and checks the reason code it recorded. */
async function assertWorkEnds(fixture, work, state, code) {
  await fixture.work(work, state, 30_000);
  const result = await fixture.workResult(work);
  assert.equal(result.rows[0].reason_code, code);
}

// Finding 990: exclusive replacement stops the active revision before its candidate's first
// pass. On Kubernetes the candidate then took over the Agent's Gateway, so when a later pass
// refused it because its actor lost `deploy`, its Pods kept answering chat with a deployment
// OCC had rejected while the recorded active revision had no workload. A refused candidate is
// stopped before its failure is published. A runtime that failed by itself (here a held model
// probe) keeps its Pods for diagnosis on its version's Logs tab. Either way the pointer still
// names the stopped predecessor: OCC never rolls back, and recovery is a new revision.
// "unsupported" is a refusal thrown by the pass itself rather than decided by its observation.
// A candidate that missed the convergence deadline or exhausted its retries failed by itself too.
const refusals = { revoked: "AUTHORIZATION_DENIED", unsupported: "SANDBOX_HARNESS_UNSUPPORTED" };
const selfFailures = {
  held: "RUNTIME_MODEL_PROBE_FAILED",
  late: "CONVERGENCE_DEADLINE_EXCEEDED",
  retried: "DEPENDENCY_UNAVAILABLE",
};
for (const { failure, stopFailures = 0, convergenceTimeoutMs, maxAttempts } of [
  { failure: "revoked" },
  // A failed stop must not publish the refusal with the candidate still running: the work
  // waits, repeats the refusal and the stop, and the refusal keeps its code.
  { failure: "revoked", stopFailures: 1 },
  { failure: "unsupported", stopFailures: 1 },
  // A stop outage outlasts the attempt budget (here 2) and the convergence deadline: ending the
  // work then would leave the refused candidate serving with nothing left to stop it.
  { failure: "revoked", stopFailures: 3, convergenceTimeoutMs: 2_000, maxAttempts: 2 },
  { failure: "held" },
  { failure: "late", convergenceTimeoutMs: 2_000 },
  { failure: "retried", maxAttempts: 2 },
]) {
  const refused = failure in refusals;
  test(
    `a ${failure} exclusive candidate ${refused ? "is stopped" : "stays for diagnosis"} when its deployment fails${stopFailures === 0 ? "" : ` after ${stopFailures} failed stops`}`,
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const fixture = await setup(context, maxAttempts === undefined ? {} : { maxAttempts });
      const events = [];
      const stop = failingStop({ limit: stopFailures });
      // The candidate's first pass starts its runtime but is not ready yet.
      const { owner, first, replacement, driver, admittedAt } = await startRefusedCandidate(
        fixture,
        `exclusive-failed-${failure}`,
        {
          refuse: failure,
          emit: (event) => events.push(event),
          stopRevision: stop.stopRevision,
          startOptions: convergenceTimeoutMs === undefined ? {} : { convergenceTimeoutMs },
        },
      );
      await fixture.work(replacement, "failed_permanent", 30_000);
      assert.equal(stop.failed.length, stopFailures);
      if (convergenceTimeoutMs !== undefined) {
        assert.ok(
          Date.now() - admittedAt > convergenceTimeoutMs,
          "the work outlasted the deadline",
        );
      }
      const result = await fixture.workResult(replacement);
      assert.equal(result.rows[0].reason_code, refusals[failure] ?? selfFailures[failure]);
      // A thrown pass forgets the sweep record, so the retry repeats the idempotent stop. A
      // refusal whose stop failed retries only that stop, without sweeping again (finding 1034).
      const predecessorStops =
        failure === "retried" || (failure === "unsupported" && stopFailures === 0) ? 2 : 1;
      assert.equal(driver.count(first), predecessorStops, "replacement stopped the predecessor");
      if (refused) {
        assert.equal(driver.count(replacement), 1, "the refused candidate is stopped once");
        assert.deepEqual([...driver.running], [], "nothing serves the Agent");
        const waited = events.filter(
          ({ event, workId, refusal }) =>
            event === "worker.completed" &&
            workId === replacement.idempotencyKey &&
            refusal === refusals[failure],
        );
        assert.deepEqual(
          waited.map(({ outcome, code }) => [outcome, code]),
          Array.from({ length: stopFailures }, () => ["pending", "REFUSED_CANDIDATE_STOP_PENDING"]),
        );
      } else {
        assert.equal(driver.count(replacement), 0, "the failed runtime stays for diagnosis");
        assert.deepEqual([...driver.running], [replacement.id]);
      }
      const active = await fixture.activePointer(owner);
      assert.equal(active.rows[0].active_revision_id, first.id);
      if (failure === "unsupported") {
        // The refused stop counts as a sweep: the next deployment does not repeat it within the
        // lease (30 s here). Only this refusal leaves the Agent deployable; revoked keeps its deny.
        const recovery = await fixture.revision(owner, 3);
        await fixture.work(recovery, "succeeded");
        assert.equal(driver.count(replacement), 1, "the next sweep skips the stopped candidate");
      }
    },
  );
}

// Finding 1016: without exclusive replacement (Kubernetes declares it only for dedicated
// Harnesses; Docker and SSH not at all) a refused candidate was never stopped. On a first
// deployment it is the Agent's only runtime: on Kubernetes its embedded Gateway Pod kept its model
// key, secret environment and private state until a later deployment, stop or delete. It is now
// stopped before the refusal is published, waiting on a failed stop like an exclusive candidate.
// Beside an active revision a refused candidate is left alone: on Kubernetes the active revision
// keeps serving, and an embedded candidate may own the Agent's shared Gateway route, which its stop
// would delete. The next deployment retires it. (On Docker the candidate's preparation already
// replaced the Agent's gateway container; that redeploy shape is tracked separately.) A refusal
// decided before the work's first preparation leaves Compute untouched; see the Secret Driver and
// ServiceAccount issuance refusals in postgres-worker-agent-revision.test.mjs. "revoked" refuses on
// the second pass, before Compute, so only the first pass's recorded evidence shows the candidate
// was prepared; "unsupported" is refused by Compute itself on the first pass, before any evidence.
const sharedRefusals = {
  revoked: "AUTHORIZATION_DENIED",
  unsupported: "SANDBOX_HARNESS_UNSUPPORTED",
};
for (const { declares, shape, stopFailures = 0, refusal = "revoked" } of [
  { declares: true, shape: "first" },
  { declares: true, shape: "first", stopFailures: 1 },
  { declares: true, shape: "redeploy" },
  { declares: false, shape: "first" },
  { declares: false, shape: "first", refusal: "unsupported" },
  { declares: false, shape: "redeploy" },
]) {
  const compute = declares ? "embedded Kubernetes-style" : "undeclared (Docker or SSH)";
  const code = sharedRefusals[refusal];
  test(
    `${refusal === "unsupported" ? "an" : "a"} ${refusal} ${shape === "first" ? "first deployment" : "redeploy"} on ${compute} Compute ${shape === "first" ? "is stopped" : "is not stopped"}${stopFailures === 0 ? "" : ` after ${stopFailures} failed stop`}`,
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const fixture = await setup(context);
      const owner = await fixture.agent(`shared-${refusal}-${shape}-${declares}-${stopFailures}`);
      let candidateId;
      let candidatePasses = 0;
      let failedStops = 0;
      const running = new Set();
      const stops = new Map();
      const retires = new Map();
      const counted = (counts, revision) => counts.get(revision.id) ?? 0;
      const events = [];
      const effects = [];
      await fixture.start(
        {
          ...fixture.compute,
          async bindAgent(binding) {
            effects.push("bind");
            await fixture.compute.bindAgent?.(binding);
          },
          // Kubernetes declares exclusive replacement only for dedicated Harnesses.
          ...(declares
            ? { requiresStoppedPredecessors: (revision) => revision.harness.mode === "dedicated" }
            : {}),
          async prepareRevision(revision) {
            effects.push("prepare");
            running.add(revision.id);
            const observed = await fixture.compute.prepareRevision(revision);
            if (revision.id !== candidateId) {
              return observed;
            }
            candidatePasses += 1;
            if (refusal === "unsupported") {
              // Compute started the runtime, then refused the revision in the same pass.
              throw new SandboxRevisionUnsupportedError("SANDBOX_HARNESS_UNSUPPORTED", "test");
            }
            if (candidatePasses === 1) {
              // The actor loses deploy authority after the candidate's runtime started; the
              // worker's recheck on the next pass refuses the deployment.
              await denyDeploy(fixture, owner);
            }
            return { ...observed, ready: false };
          },
          async stopRevision(revision) {
            effects.push("stop");
            if (revision.id === candidateId && failedStops < stopFailures) {
              failedStops += 1;
              throw new Error("Kubernetes API temporarily unavailable");
            }
            stops.set(revision.id, counted(stops, revision) + 1);
            running.delete(revision.id);
          },
          async retireRevision(revision) {
            retires.set(revision.id, counted(retires, revision) + 1);
            running.delete(revision.id);
          },
        },
        { emit: (event) => events.push(event) },
      );
      let first;
      if (shape === "redeploy") {
        first = await fixture.revision(owner, 1);
        await fixture.work(first, "succeeded");
      }
      const candidate = await fixture.revision(owner, shape === "first" ? 1 : 2);
      candidateId = candidate.id;
      await assertWorkEnds(fixture, candidate, "failed_permanent", code);
      assert.equal(failedStops, stopFailures);
      const active = await fixture.activePointer(owner);
      if (shape === "first") {
        assert.equal(active.rows[0].active_revision_id, null);
        assert.equal(counted(stops, candidate), 1, "the refused first deployment is stopped once");
        assert.deepEqual([...running], [], "nothing runs for the Agent");
        // Like Agent stop and retirement, each try binds the Agent first, even when this pass
        // refused before Compute and never bound it.
        assert.ok(
          effects.every((effect, index) => effect !== "stop" || effects[index - 1] === "bind"),
          effects.join(","),
        );
        // A failed stop publishes nothing: the work waits and keeps the refusal's code.
        const waited = events.filter(
          ({ event, workId, refusal }) =>
            event === "worker.completed" && workId === candidate.idempotencyKey && refusal === code,
        );
        assert.deepEqual(
          waited.map(({ outcome, code }) => [outcome, code]),
          Array.from({ length: stopFailures }, () => ["pending", "REFUSED_CANDIDATE_STOP_PENDING"]),
        );
      } else {
        assert.equal(active.rows[0].active_revision_id, first.id);
        assert.equal(counted(stops, candidate), 0, "the refused redeploy is not stopped");
        assert.equal(counted(stops, first) + counted(retires, first), 0, "the predecessor serves");
        assert.ok(running.has(first.id), "the predecessor still runs");
      }
    },
  );
}

// Finding 1003: while the refused candidate's stop keeps failing, deployment status named a
// generic dependency failure and its last attempt time never moved. It now names the refusal the
// deployment will record, which its reader may already see as the failed deployment's `error`,
// and every waiting pass moves `lastAttempt.at`.
revisionTest(
  "a refused candidate whose stop keeps failing shows the refusal in deployment status",
  async (fixture) => {
    const events = [];
    const stop = failingStop();
    const { owner, replacement, driver } = await startRefusedCandidate(fixture, "refused-status", {
      emit: (event) => events.push(event),
      stopRevision: stop.stopRevision,
    });
    await waitForRefusedStopWaits(events, replacement, 1);
    const waiting = await fixture.deploymentStatus(owner, replacement);
    assert.ok(["queued", "running"].includes(waiting.status), waiting.status);
    assert.equal(waiting.error, null);
    assert.equal(waiting.progress.lastAttempt.code, "REFUSED_CANDIDATE_STOP_PENDING");
    assert.equal(
      waiting.progress.lastAttempt.message,
      "Deployment refused (AUTHORIZATION_DENIED); stopping the refused version before recording the failure. The controller will retry.",
    );
    // A pass that starts after this read records a newer attempt, though its result repeats.
    await waitForRefusedStopWaits(
      events,
      replacement,
      refusedStopWaits(events, replacement).length + 1,
    );
    const later = await fixture.deploymentStatus(owner, replacement);
    assert.equal(later.progress.lastAttempt.code, "REFUSED_CANDIDATE_STOP_PENDING");
    assert.ok(
      Date.parse(later.progress.lastAttempt.at) > Date.parse(waiting.progress.lastAttempt.at),
      "the last attempt time moves while the stop is retried",
    );
    // A fast failing stop waits on the readiness cadence (0.5 s here), doubled per failure.
    await stop.waitForFailures(4, 20_000);
    const gaps = stop.failed.slice(1, 4).map((at, index) => at - stop.failed[index]);
    assert.ok(
      gaps[1] >= 950 && gaps[2] >= 1_950,
      `failed stops started ${gaps.join(", ")} ms apart`,
    );
    stop.succeed();
    await fixture.work(replacement, "failed_permanent", 30_000);
    const failed = await fixture.deploymentStatus(owner, replacement);
    assert.equal(failed.error.code, "AUTHORIZATION_DENIED");
    assert.deepEqual([...driver.running], [], "the refused candidate was stopped");
  },
  { timeout: 60_000 },
);

// Finding 1002: the worker is serial, and a refused candidate's stop can block it for minutes
// (Kubernetes waits for its Pods to terminate). Rechecked every 0.5-5 s, such a stop took every
// other turn from every other Agent. Each failed stop now doubles its recheck and waits at least
// four times as long as the stop took, so another Agent's deployment runs its readiness passes
// between the stops.
revisionTest(
  "a slow failing refused stop backs off so another Agent's deployment keeps its cadence",
  async (fixture) => {
    const events = [];
    const stopStarts = [];
    const otherPasses = [];
    let otherId;
    const { replacement } = await startRefusedCandidate(fixture, "refused-slow", {
      emit: (event) => events.push(event),
      // The other Agent's deployment needs ten readiness passes.
      ready: (revision) => {
        if (revision.id !== otherId) {
          return true;
        }
        otherPasses.push(Date.now());
        return otherPasses.length >= 10;
      },
      async stopRevision() {
        // Stands in for a Pod-termination wait that ends in an error.
        stopStarts.push(Date.now());
        await delay(1_000);
        throw new Error("Pods did not terminate before the deadline");
      },
    });
    // Let the backoff grow past four times the stop's duration (4, 4, 4, 4 and then 8 s).
    await waitForRefusedStopWaits(events, replacement, 5, 45_000);
    const other = await fixture.agent("refused-slow-other", { executionMode: "dedicated" });
    const otherRevision = await fixture.revision(other, 1);
    otherId = otherRevision.id;
    await fixture.work(otherRevision, "succeeded", 45_000);
    // Without the backoff a stop ran between every two of the other Agent's passes (nine).
    const interleaved = stopStarts.filter(
      (at) => at > otherPasses[0] && at < otherPasses.at(-1),
    ).length;
    assert.ok(interleaved <= 2, `${interleaved} refused stops ran during the other deployment`);
    // Each 1 s stop is followed by at least 4 s in which other work can run.
    const gaps = stopStarts.slice(1).map((at, index) => at - stopStarts[index]);
    assert.ok(
      gaps.every((gap) => gap >= 4_900),
      `refused stops started ${gaps.join(", ")} ms apart`,
    );
  },
  { timeout: 120_000 },
);

// Finding 1022: the failed-stop count that doubles the recheck lived in memory, so after a
// restart the next failed stop was rechecked on the readiness cadence again (0.5 s here). It is
// now counted from the work's REFUSED_CANDIDATE_STOP_PENDING evidence.
revisionTest(
  "a failing refused stop keeps its doubled recheck across a controller restart",
  async (fixture) => {
    const events = [];
    const stop = failingStop();
    const { replacement, driver, compute } = await startRefusedCandidate(
      fixture,
      "refused-restart-backoff",
      { emit: (event) => events.push(event), stopRevision: stop.stopRevision },
    );
    // Three failed stops wait 0.5, 1 and 2 s; the restart falls in the 2 s wait.
    await waitForRefusedStopWaits(events, replacement, 3, 20_000);
    await fixture.stop();
    await fixture.start(compute, { emit: (event) => events.push(event) });
    // Two more after the restart.
    await stop.waitForFailures(5, 30_000);
    // The fourth failure waits 4 s; a forgotten count waited 0.5 s.
    const gap = stop.failed[4] - stop.failed[3];
    assert.ok(gap >= 3_900, `the stops after the restart started ${gap} ms apart`);
    stop.succeed();
    await fixture.work(replacement, "failed_permanent", 30_000);
    assert.deepEqual([...driver.running], [], "the refused candidate was stopped");
  },
  { timeout: 90_000 },
);

// Finding 1022: a shutdown during a slow refused stop deferred the work without the stop's
// duration, so the next controller repeated the blocking stop on the readiness cadence. The
// interrupted stop now lengthens the recheck like a failed one: four times as long as it ran.
revisionTest(
  "a refused stop that a shutdown interrupts keeps its duration in the recheck",
  async (fixture) => {
    const stopCalls = [];
    let release;
    let stopping = false;
    const { replacement, driver, compute } = await startRefusedCandidate(
      fixture,
      "refused-shutdown-backoff",
      {
        stopRevision: () => {
          if (stopping) {
            return undefined;
          }
          stopCalls.push(Date.now());
          if (stopCalls.length > 1) {
            return Promise.reject(new Error("Kubernetes API temporarily unavailable"));
          }
          // A Pod-termination wait that outlasts the controller's shutdown.
          return new Promise((resolve, reject) => {
            release = () =>
              reject(new Error("Pods did not terminate before the controller stopped"));
          });
        },
      },
    );
    await waitFor("the refused stop to block", async () => release, 20_000);
    await delay(1_500);
    const stopped = fixture.stop();
    release();
    await stopped;
    await fixture.start(compute);
    await waitFor(
      "the stop after the restart",
      async () => (stopCalls.length >= 2 ? true : undefined),
      30_000,
    );
    // The stop ran at least 1.5 s, so its recheck is at least 6 s more; without it, 0.5 s.
    const gap = stopCalls[1] - stopCalls[0];
    assert.ok(gap >= 7_000, `the interrupted stop was repeated ${gap} ms after it started`);
    stopping = true;
    await fixture.work(replacement, "failed_permanent", 30_000);
    assert.deepEqual([...driver.running], [], "the refused candidate was stopped");
  },
  { timeout: 90_000 },
);

// Finding 1022: a refused candidate's stop held the serial worker for its whole Pod-termination
// wait. Its stop now yields: Compute ends the wait once other Work is due, and the work waits on
// the stop as if it had failed. Kubernetes' wait is covered in the Compute conformance tests.
revisionTest(
  "a refused candidate's stop may yield to another Agent's due work",
  async (fixture) => {
    const events = [];
    // The order of the candidate's stops and the other Agent's passes.
    const order = [];
    let other;
    let yielded = false;
    let stopping = false;
    const { replacement, driver } = await startRefusedCandidate(fixture, "refused-yield", {
      emit: (event) => {
        events.push(event);
        if (event.event === "worker.completed" && event.workId === other?.idempotencyKey) {
          order.push("other");
        }
      },
      stopRevision: () => {
        order.push("stop");
        return stopping
          ? undefined
          : (async () => {
              const owner = await fixture.agent("refused-yield-other", {
                executionMode: "dedicated",
              });
              other = await fixture.revision(owner, 1);
              yielded = await waitFor("the stop to see the due work", async () =>
                (await computeStopShouldYield()) ? true : undefined,
              );
              stopping = true;
              throw new Error("The workload Pods are still terminating; other work is waiting.");
            })();
      },
    });
    await fixture.work(replacement, "failed_permanent", 30_000);
    assert.equal(yielded, true);
    assert.deepEqual(
      refusedStopWaits(events, replacement).map(({ code }) => code),
      ["REFUSED_CANDIDATE_STOP_PENDING"],
    );
    assert.deepEqual(
      [...driver.running].filter((id) => id === replacement.id),
      [],
    );
    await fixture.work(other, "succeeded", 30_000);
    // The other Agent's first pass ran before the candidate's stop was repeated.
    const repeated = order.indexOf("stop", 1);
    assert.ok(
      repeated > 0 && order.indexOf("other") > 0 && order.indexOf("other") < repeated,
      order.join(", "),
    );
  },
  { timeout: 90_000 },
);

// Finding 1025: every deferral of a refused stop doubled its recheck, so under a constantly busy
// queue each yield to other Work doubled it too, and publishing the refusal took about twice as
// long. A yield is now recorded as `stopYielded` and only failed stops double the recheck.
revisionTest(
  "a refused stop's yields do not double its recheck",
  async (fixture) => {
    const stopCalls = [];
    const { replacement, driver } = await startRefusedCandidate(fixture, "refused-yield-backoff", {
      stopRevision: () => {
        stopCalls.push(Date.now());
        if (stopCalls.length <= 4) {
          return Promise.reject(
            new ComputeStopYieldedError(
              "The workload Pods are still terminating; other work is waiting.",
            ),
          );
        }
        if (stopCalls.length <= 6) {
          return Promise.reject(new Error("Kubernetes API temporarily unavailable"));
        }
        return undefined;
      },
    });
    await fixture.work(replacement, "failed_permanent", 30_000);
    assert.equal(stopCalls.length, 7);
    assert.deepEqual([...driver.running], [], "the refused candidate was stopped");
    const gaps = stopCalls.slice(1).map((at, index) => at - stopCalls[index]);
    // Four yields recheck on the readiness cadence (0.5 s here); doubled, the fourth waited 4 s.
    // The first failed stop after them is not doubled either; the next failure doubles it.
    assert.ok(
      gaps.slice(0, 5).every((gap) => gap < 1_500) && gaps[5] >= 950,
      `refused stops started ${gaps.join(", ")} ms apart`,
    );
    const evidence = await fixture.observerPool.query(
      `SELECT details->>'stopYielded' AS stop_yielded FROM occ.audit_events
        WHERE details->>'workId' = $1 AND details->>'reasonCode' = 'REFUSED_CANDIDATE_STOP_PENDING'
        ORDER BY occurred_at, id`,
      [replacement.idempotencyKey],
    );
    assert.deepEqual(
      evidence.rows.map(({ stop_yielded: yielded }) => yielded),
      ["true", "true", "true", "true", null, null],
    );
  },
  { timeout: 60_000 },
);

// Finding 1034: a refusal decided inside Compute's preparation (here an unsupported Sandbox) was
// reached again by re-running the whole pass, so every wait on its stop swept the predecessors
// and re-prepared the refused candidate (on Kubernetes its route, Service, credentials and Gateway
// Deployment). The stored refusal now retries only its stop. A refusal decided before Compute
// (revoked) never prepared it again.
for (const refuse of ["revoked", "unsupported"]) {
  revisionTest(
    `a ${refuse} candidate's stored refusal retries only its stop`,
    async (fixture) => {
      const stop = failingStop({ limit: 3 });
      const { first, replacement, driver } = await startRefusedCandidate(
        fixture,
        `refused-only-stop-${refuse}`,
        { refuse, stopRevision: stop.stopRevision },
      );
      await assertWorkEnds(fixture, replacement, "failed_permanent", refusals[refuse]);
      assert.equal(stop.failed.length, 3);
      assert.equal(driver.count(replacement), 1, "the refused candidate was stopped");
      assert.deepEqual([...driver.running], []);
      // The first pass started the runtime; an unsupported one was refused by the second.
      assert.equal(driver.preparations(replacement), refuse === "unsupported" ? 2 : 1);
      assert.equal(driver.count(first), 1, "the waits did not sweep the predecessor again");
    },
    { timeout: 60_000 },
  );
}

// Finding 1034: a Kubernetes stop waits for the candidate's Pods to terminate and yields when
// other Work is due. Re-preparing the candidate on every wait recreated its Pods, so under a busy
// queue the stop yielded on every pass, never finished, and the refusal was never published. Here
// the candidate's Pods terminate 3 s after its latest preparation, and another Agent's deployment
// that never becomes ready keeps the queue busy.
revisionTest(
  "a refusal decided inside Compute is published while a yielding stop competes with due work",
  async (fixture) => {
    const stats = { starts: 0, yields: 0 };
    let preparedAt = 0;
    let seenPreparations = 0;
    let otherId;
    const { replacement, driver } = await startRefusedCandidate(fixture, "refused-busy-yield", {
      refuse: "unsupported",
      ready: (revision) => revision.id !== otherId,
      stopRevision: (revision) =>
        (async () => {
          stats.starts += 1;
          let checked;
          for (;;) {
            const preparations = driver.preparations(revision);
            if (preparations !== seenPreparations) {
              // Compute recreated the candidate's Pods since the last stop.
              seenPreparations = preparations;
              preparedAt = Date.now();
            }
            if (Date.now() - preparedAt >= 3_000) {
              return driver.compute.stopRevision(revision);
            }
            if (checked === undefined || Date.now() - checked >= 1_000) {
              checked = Date.now();
              if (await computeStopShouldYield()) {
                stats.yields += 1;
                throw new ComputeStopYieldedError("The workload Pods are still terminating.");
              }
            }
            await delay(100);
          }
        })(),
    });
    const other = await fixture.agent("refused-busy-yield-other", { executionMode: "dedicated" });
    otherId = (await fixture.revision(other, 1)).id;
    await assertWorkEnds(fixture, replacement, "failed_permanent", "SANDBOX_HARNESS_UNSUPPORTED");
    assert.ok(!driver.running.has(replacement.id), "the refused candidate was stopped");
    assert.equal(driver.preparations(replacement), 2, `stops: ${JSON.stringify(stats)}`);
    await fixture.stop();
  },
  { timeout: 60_000 },
);

/** Worker drivers whose IAM Driver answers through `authorize(iam, request)`. */
function proxiedIAM(authorize) {
  return (drivers) => ({
    ...drivers,
    createIAMDriver(platformState) {
      const iam = drivers.createIAMDriver(platformState);
      return new Proxy(iam, {
        get(target, key) {
          if (key === "authorize") {
            return (request) => authorize(target, request);
          }
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  });
}

// Finding 1033: the wait on a refused candidate's stop outlasts the convergence deadline and the
// attempt budget, but each wait re-ran the pass, which could fail before it reached the refusal
// again: past the deadline a transient dependency failure ended the work with its own code, and
// ordinary errors spent the attempts and ended it DEPENDENCY_UNAVAILABLE. Either way the candidate
// kept running and its refusal was lost. A pass that fails before retrying the stored refusal's
// stop now retries that stop instead. Here the worker's IAM checks fail.
for (const mode of ["transient", "generic"]) {
  test(
    `a refused candidate's wait survives ${mode} failures before its stop past the deadline`,
    { ...requiresPostgres, timeout: 90_000 },
    async (context) => {
      // Two attempts: on main the second ordinary failure ended the work.
      const fixture = await setup(context, { maxAttempts: 2 });
      const events = [];
      const stop = failingStop({ message: "Pods did not terminate before the deadline" });
      let failIAM = false;
      let iamFailures = 0;
      const { replacement, driver } = await startRefusedCandidate(fixture, `refused-wait-${mode}`, {
        refuse: "unsupported",
        emit: (event) => events.push(event),
        stopRevision: stop.stopRevision,
        startOptions: {
          convergenceTimeoutMs: 2_000,
          transformDrivers: proxiedIAM(async (iam, request) => {
            if (!failIAM) {
              return iam.authorize(request);
            }
            iamFailures += 1;
            throw mode === "transient"
              ? new TransientDependencyError(
                  "kubernetes_api",
                  "unavailable",
                  "The Kubernetes API answered HTTP 503.",
                )
              : new Error("IAM state temporarily unavailable");
          }),
        },
      });
      const admitted = Date.now();
      await waitFor(
        "two failed refused stops past the deadline",
        async () => (stop.failed.length >= 2 && Date.now() - admitted > 2_500 ? true : undefined),
        30_000,
      );
      failIAM = true;
      const before = stop.failed.length;
      await waitFor(
        "two failed passes, each retrying the stop",
        async () => (iamFailures >= 2 && stop.failed.length >= before + 2 ? true : undefined),
        45_000,
      );
      stop.succeed();
      await assertWorkEnds(fixture, replacement, "failed_permanent", "SANDBOX_HARNESS_UNSUPPORTED");
      assert.equal(driver.count(replacement), 1, "the refused candidate was stopped");
      assert.deepEqual([...driver.running], []);
      assert.equal(driver.preparations(replacement), 2);
      // Every pass waited with the refusal; none ended with the IAM failure's code.
      const ended = events.filter(
        ({ event, workId, outcome }) =>
          event === "worker.completed" &&
          workId === replacement.idempotencyKey &&
          outcome !== "pending",
      );
      assert.deepEqual(
        ended.map(({ code }) => code),
        ["SANDBOX_HARNESS_UNSUPPORTED"],
      );
    },
  );
}

// Finding 1033 keeps one exception: authorization and backend refusals are decided again before
// the stored refusal's stop, so once `deploy` is granted again the deployment continues as before.
// A refusal Compute decided is not prepared again, so it is published once its stop succeeds.
for (const refuse of ["revoked", "unsupported"]) {
  revisionTest(
    `a ${refuse} candidate whose refusal lifts during its wait ${refuse === "revoked" ? "deploys" : "keeps its refusal"}`,
    async (fixture) => {
      const stop = failingStop();
      let lifted = false;
      let scenario;
      scenario = await startRefusedCandidate(fixture, `refused-lifts-${refuse}`, {
        // "iam": the IAM Driver below denies `deploy` once the candidate's runtime started.
        refuse: refuse === "revoked" ? "iam" : "unsupported",
        refusing: () => !lifted,
        candidateReady: () => lifted,
        stopRevision: stop.stopRevision,
        startOptions: {
          transformDrivers: proxiedIAM(async (iam, request) => {
            const decision = await iam.authorize(request);
            const denied =
              refuse === "revoked" &&
              !lifted &&
              request.action === "deploy" &&
              scenario !== undefined &&
              scenario.driver.preparations(scenario.replacement) > 0;
            return denied ? { ...decision, allowed: false } : decision;
          }),
        },
      });
      const { owner, replacement, driver } = scenario;
      await stop.waitForFailures(2, 30_000);
      lifted = true;
      // Only the unsupported candidate's stop succeeds. A revoked candidate's never does, so a
      // pass denied just before the grant cannot publish its refusal.
      if (refuse === "unsupported") {
        stop.succeed();
      }
      if (refuse === "revoked") {
        await fixture.work(replacement, "succeeded", 30_000);
        const active = await fixture.activePointer(owner);
        assert.equal(active.rows[0].active_revision_id, replacement.id);
        assert.ok(driver.running.has(replacement.id), "the deployment kept its candidate");
      } else {
        await assertWorkEnds(
          fixture,
          replacement,
          "failed_permanent",
          "SANDBOX_HARNESS_UNSUPPORTED",
        );
        assert.equal(driver.count(replacement), 1, "the refused candidate was stopped");
        assert.equal(driver.preparations(replacement), 2);
      }
    },
    { timeout: 60_000 },
  );
}

// Finding 1004: a refusal decided after the check for a newer revision (here a Sandbox that
// cannot run the revision; also lost repository authority or a Secret problem) waits on its
// stop like any refusal. Once a newer revision was admitted, its next pass finished as
// REVISION_SUPERSEDED without the stop, leaving the refused candidate to the newer deployment's
// sweep, which gives up at its own deadline. The superseded pass now finishes the stop first.
test(
  "a refused candidate superseded while its stop fails is stopped before it completes",
  { ...requiresPostgres, timeout: 120_000 },
  async (context) => {
    // The newer revision's own sweep fails on the same stop and retries until it succeeds.
    const fixture = await setup(context, { maxAttempts: 20 });
    const events = [];
    const stop = failingStop();
    const { owner, replacement, driver } = await startRefusedCandidate(
      fixture,
      "refused-superseded",
      {
        refuse: "unsupported",
        emit: (event) => events.push(event),
        stopRevision: stop.stopRevision,
      },
    );
    await waitForRefusedStopWaits(events, replacement, 1);
    const newer = await fixture.revision(owner, 3);
    const admitted = events.length;
    // A pass already running at admission may finish after it, so the second pass after the
    // admission is the first that surely saw the newer revision. Both keep waiting on the stop.
    const passes = () =>
      events
        .slice(admitted)
        .filter(
          ({ event, workId }) =>
            event === "worker.completed" && workId === replacement.idempotencyKey,
        );
    await waitFor("two candidate passes after the newer admission, or its end", async () =>
      passes().length >= 2 || passes().some(({ outcome }) => outcome !== "pending")
        ? true
        : undefined,
    );
    assert.deepEqual(
      passes().map(({ outcome, code, refusal }) => [outcome, code, refusal]),
      passes().map(() => [
        "pending",
        "REFUSED_CANDIDATE_STOP_PENDING",
        "SANDBOX_HARNESS_UNSUPPORTED",
      ]),
    );
    assert.ok(driver.running.has(replacement.id), "the stop has not succeeded yet");
    stop.succeed();
    await assertWorkEnds(fixture, replacement, "succeeded", "REVISION_SUPERSEDED");
    assert.ok(!driver.running.has(replacement.id), "the refused candidate was stopped");
    // Its sweep retried on the queue's growing backoff while the stop failed.
    await fixture.work(newer, "succeeded", 75_000);
  },
);

// A superseded pass skips the refused stop when this process stopped the candidate within the
// last lease, here the newer revision's sweep.
revisionTest(
  "a superseded refused candidate that the newer sweep stopped is not stopped again",
  async (fixture) => {
    const events = [];
    const stop = failingStop();
    const { owner, replacement, driver } = await startRefusedCandidate(fixture, "refused-swept", {
      refuse: "unsupported",
      emit: (event) => events.push(event),
      stopRevision: stop.stopRevision,
    });
    // After three failed stops the candidate's next pass is at least 2 s away, so the newer
    // revision's first pass usually sweeps it first. Stops succeed only once the newer revision
    // exists: an earlier candidate pass would publish its refusal instead of superseding.
    await waitForRefusedStopWaits(events, replacement, 3);
    const newer = await fixture.revision(owner, 3);
    stop.succeed();
    await fixture.work(newer, "succeeded");
    assert.equal(driver.count(replacement), 1, "the newer sweep stopped the candidate");
    await assertWorkEnds(fixture, replacement, "succeeded", "REVISION_SUPERSEDED");
    assert.equal(driver.count(replacement), 1, "the superseded pass did not repeat the stop");
  },
  { timeout: 60_000 },
);

// Finding 1010: the refused-stop wait has no attempt limit, but a claim lost during it spent one.
// A restart whose lease runs out while the stop blocks (a Pod-termination wait; also a crash)
// loses the claim, so a few rollouts ended the work LEASE_EXPIRED with the refused candidate
// still running and its refusal unrecorded. Recovery now refunds that attempt and keeps the
// refusal, which deployment status names. Finding 1021: a graceful restart during the FIRST stop,
// before any wait evidence, still spent an attempt; the shutdown now defers the work as
// REFUSED_CANDIDATE_STOP_PENDING while its lease holds. Exclusive replacement and a shared first
// deployment reach the stop the same way.
for (const shape of ["exclusive", "shared"]) {
  for (const restart of ["lost", "graceful"]) {
    const label =
      shape === "exclusive" ? "exclusive candidate" : "first deployment on shared Compute";
    test(
      restart === "lost"
        ? `a refused ${label} keeps waiting on its stop across lost claims`
        : `a refused ${label} keeps waiting on its first stop across graceful restarts`,
      { ...requiresPostgres, timeout: 120_000 },
      async (context) => {
        await refusedStopRestarts(context, shape, restart);
      },
    );
  }
}

async function refusedStopRestarts(context, shape, restart) {
  // On main the second restart exhausted these two attempts.
  const restarts = 3;
  const fixture = await setup(context, { maxAttempts: 2 });
  const owner = await fixture.agent(
    `refused-${restart}-${shape}`,
    shape === "exclusive" ? { executionMode: "dedicated" } : {},
  );
  // A lost-claim run first fails one stop, so its recovered claims follow wait evidence; a
  // graceful run blocks from the first stop on.
  const failedStops = restart === "lost" ? 1 : 0;
  let candidateId;
  let candidatePasses = 0;
  let stopCalls = 0;
  let release;
  const events = [];
  const compute = {
    ...fixture.compute,
    ...(shape === "exclusive" ? { requiresStoppedPredecessors: () => true } : {}),
    async prepareRevision(revision) {
      const observed = await fixture.compute.prepareRevision(revision);
      if (revision.id !== candidateId) {
        return observed;
      }
      candidatePasses += 1;
      if (candidatePasses === 1) {
        // The actor loses deploy authority after the runtime started; the next pass refuses.
        await denyDeploy(fixture, owner);
      }
      return { ...observed, ready: false };
    },
    async stopRevision(revision) {
      if (revision.id === candidateId) {
        stopCalls += 1;
        if (stopCalls <= failedStops) {
          // The work waits as REFUSED_CANDIDATE_STOP_PENDING.
          throw new Error("Kubernetes API temporarily unavailable");
        }
        if (stopCalls <= failedStops + restarts) {
          // A Pod-termination wait that outlasts the controller's shutdown.
          await new Promise((resolve) => {
            release = resolve;
          });
          throw new Error("Pods did not terminate before the controller stopped");
        }
      }
    },
    async retireRevision() {},
  };
  await fixture.start(compute, { emit: (event) => events.push(event) });
  if (shape === "exclusive") {
    await fixture.work(await fixture.revision(owner, 1), "succeeded");
  }
  const candidate = await fixture.revision(owner, shape === "exclusive" ? 2 : 1);
  candidateId = candidate.id;
  const expireLease = () =>
    fixture.observerPool.query(
      `UPDATE occ.controller_work SET lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE idempotency_key = $1 AND state = 'claimed'`,
      [candidate.idempotencyKey],
    );
  for (let count = 1; count <= restarts; count += 1) {
    const ended = await waitFor(
      `refused stop ${count + failedStops} to block, or the work to end`,
      async () => {
        if (release !== undefined) {
          return { blocked: true };
        }
        const { rows } = await fixture.workResult(candidate);
        return rows[0] !== undefined && rows[0].reason_code !== null ? rows[0] : undefined;
      },
      30_000,
    );
    assert.deepEqual(ended, { blocked: true }, `the work ended before restart ${count}`);
    if (restart === "lost") {
      // The lease runs out before the shutdown ends the stop, so the pass loses its claim.
      await expireLease();
    }
    const stopped = fixture.stop();
    release();
    release = undefined;
    await stopped;
    if (restart === "lost") {
      // The next controller's recovery, run here so status shows it before the next claim.
      const recovery = new fixture.PostgresWorkQueue(fixture.observerPool, { maxAttempts: 2 });
      assert.equal((await recovery.recoverStale()).recovered, 1);
      const status = await fixture.deploymentStatus(owner, candidate);
      assert.equal(status.progress.lastAttempt.code, "LEASE_EXPIRED");
      assert.equal(
        status.progress.lastAttempt.message,
        "Deployment refused (AUTHORIZATION_DENIED); the previous worker claim expired before the refused version was stopped. The controller will retry.",
      );
    } else {
      // The shutdown released the claim with its refusal; on main it stayed claimed.
      const { rows } = await fixture.observerPool.query(
        "SELECT state, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
        [candidate.idempotencyKey],
      );
      assert.deepEqual(rows[0], { state: "queued", attempt_count: 0 });
      const status = await fixture.deploymentStatus(owner, candidate);
      assert.equal(status.progress.lastAttempt.code, "REFUSED_CANDIDATE_STOP_PENDING");
      assert.match(
        status.progress.lastAttempt.message,
        /^Deployment refused \(AUTHORIZATION_DENIED\)/u,
      );
      // A claim that main left behind is recovered like a lost one.
      await expireLease();
    }
    await fixture.start(compute, { emit: (event) => events.push(event) });
  }
  await assertWorkEnds(fixture, candidate, "failed_permanent", "AUTHORIZATION_DENIED");
  assert.equal(
    stopCalls,
    failedStops + restarts + 1,
    "the refusal was recorded after the stop succeeded",
  );
  // A shutdown's deferral logs why the stop ended, not a lost claim.
  assert.deepEqual(
    refusedStopWaits(events, candidate).map(({ cause }) => cause),
    restart === "lost" ? ["Error"] : Array.from({ length: restarts }, () => "WorkerStopping"),
  );
  const evidence = await fixture.observerPool.query(
    `SELECT details->>'reasonCode' AS code, details->>'refusal' AS refusal FROM occ.audit_events
     WHERE details->>'workId' = $1 AND details->>'reasonCode' IN ('LEASE_EXPIRED',
       'REFUSED_CANDIDATE_STOP_PENDING')
     ORDER BY occurred_at, id`,
    [candidate.idempotencyKey],
  );
  assert.deepEqual(
    evidence.rows,
    Array.from({ length: failedStops + restarts }, (_, index) => ({
      code:
        index < failedStops || restart === "graceful"
          ? "REFUSED_CANDIDATE_STOP_PENDING"
          : "LEASE_EXPIRED",
      refusal: "AUTHORIZATION_DENIED",
    })),
    "each interrupted stop keeps the refusal it waits to publish",
  );
}

test(
  "a predecessor that comes back after the sweep is stopped again",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    for (const { leaseDurationMs, label, returns } of [
      // A late Compute effect makes the next pass fail, which forgets the record.
      { leaseDurationMs: 30_000, label: "failed-pass", returns: 1 },
      // A late effect keeps the candidate pending until one lease has elapsed.
      { leaseDurationMs: 1_000, label: "lease-restop", returns: 1 },
      // It comes back again after that re-stop; the next one follows two leases later.
      { leaseDurationMs: 1_000, label: "repeated-restop", returns: 2 },
    ]) {
      const fixture = await setup(context, { leaseDurationMs });
      const owner = await fixture.agent(`exclusive-resurrection-${label}`, {
        executionMode: "dedicated",
      });
      let first;
      let resurrections = 0;
      const driver = countingExclusiveCompute(fixture, {
        async onPrepare(revision, overlap) {
          if (revision.revision !== 2) {
            return;
          }
          if (resurrections < returns && driver.count(first) > resurrections) {
            // Model a lost claim's late Compute write landing after each stop.
            resurrections += 1;
            driver.running.add(first.id);
          } else if (overlap.length > 0 && label === "failed-pass") {
            driver.running.delete(revision.id);
            throw new Error("predecessor still holds the exclusive resource");
          }
        },
      });
      await fixture.start(driver.compute);
      first = await fixture.revision(owner, 1);
      await fixture.work(first, "succeeded");
      const replacement = await fixture.revision(owner, 2);
      await fixture.work(replacement, "succeeded", 30_000);
      assert.equal(resurrections, returns);
      assert.equal(
        driver.count(first),
        returns + 1,
        `${label}: the returned predecessor is stopped again`,
      );
      assert.deepEqual([...driver.running], [replacement.id]);
      const current = await fixture.currentAgent(owner);
      assert.equal(current.activeRevisionId, replacement.id);
      await fixture.stop();
    }
  },
);

test(
  "worker readiness remains available when repository credentials are disabled",
  requiresPostgres,
  async (context) => {
    let healthy = false;
    const fixture = await setup(context, {
      onHealthy: async () => {
        healthy = true;
      },
    });
    const { candidate } = await fixture.admitInitialRevision("no-repository-capability");
    await fixture.start(fixture.compute);
    await fixture.work(candidate, "succeeded");
    await waitFor("repository-disabled worker readiness", async () => (healthy ? true : undefined));
  },
);

/**
 * Relay PostgreSQL connections through a local proxy that can go silent: it stops relaying on
 * every open connection without closing it, as a client sees after a failover or partition
 * that sent no RST. New connections still reach the server.
 */
async function startSilenceableProxy(context, databaseUrl) {
  const { createServer, connect } = await import("node:net");
  const target = new URL(databaseUrl);
  const pairs = new Set();
  const server = createServer((client) => {
    const upstream = connect(Number(target.port || 5432), target.hostname);
    const pair = { client, upstream };
    pairs.add(pair);
    client.pipe(upstream);
    upstream.pipe(client);
    const close = () => {
      pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    for (const socket of [client, upstream]) {
      socket.on("error", close);
      socket.on("close", close);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = () => {
    for (const { client, upstream } of pairs) {
      client.destroy();
      upstream.destroy();
    }
    return new Promise((resolve) => server.close(resolve));
  };
  context.after(close);
  const url = new URL(databaseUrl);
  url.hostname = "127.0.0.1";
  url.port = String(server.address().port);
  return {
    url: url.toString(),
    silence() {
      for (const { client, upstream } of pairs) {
        client.unpipe(upstream);
        upstream.unpipe(client);
        client.pause();
        upstream.pause();
      }
    },
    close,
  };
}

test(
  "a worker abandons a query on a silent database connection and resumes work",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const [{ Pool }, { workerDatabasePoolOptions }] = await Promise.all([
      import("pg"),
      import("../../apps/controller/src/worker.ts"),
    ]);
    const fixture = await setup(context);
    const proxy = await startSilenceableProxy(context, fixture.database.url);
    const pool = new Pool({
      connectionString: proxy.url,
      ...workerDatabasePoolOptions(3_000),
      max: 2,
    });
    fixture.database.pools.add(pool);
    const { candidate: before } = await fixture.admitInitialRevision("before-silence");
    await fixture.start(fixture.compute, { pool });
    await fixture.work(before, "succeeded");

    // Every pooled connection now swallows queries without an answer or an error.
    proxy.silence();
    const { candidate: after } = await fixture.admitInitialRevision("after-silence");
    await fixture.work(after, "succeeded", 30_000);
    await fixture.stop();
    await proxy.close();
  },
);

test(
  "worker progress continues through a database outage and stops when the loop is stuck",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const { Pool } = await import("pg");
    let progressed = 0;
    const fixture = await setup(context, {
      onProgress: async () => {
        progressed += 1;
      },
    });
    const proxy = await startSilenceableProxy(context, fixture.database.url);
    // No query timeout: this isolates the liveness signal from the timeout that would unstick it.
    const pool = new Pool({ connectionString: proxy.url, max: 1 });
    fixture.database.pools.add(pool);
    pool.on("error", () => {});
    await fixture.start(fixture.compute, { pool });
    await waitFor("idle worker progress", async () => (progressed >= 2 ? true : undefined));

    proxy.silence();
    // A negative check needs a fixed window. Progress is reported at most once per second
    // here (pollIntervalMs 15), so 1.5 s lets an in-flight pass settle and 3 s spans three
    // reports a moving loop would have made.
    await delay(1_500);
    const stuck = progressed;
    await delay(3_000);
    assert.equal(
      progressed,
      stuck,
      "a worker stuck on a silent query must stop reporting progress",
    );

    // Refused connections fail each pass fast; the loop still moves, so liveness holds.
    await proxy.close();
    await waitFor("progress through a database outage", async () =>
      progressed >= stuck + 2 ? true : undefined,
    );
    await fixture.stop();
  },
);

test(
  "worker readiness and fresh Agent admission require the broker capability",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    let healthy = 0;
    const fixture = await setup(context, {
      onHealthy: async () => {
        healthy += 1;
      },
    });
    const [
      { GitHubRepoDriver },
      { UnixRepositoryCredentialControlClient },
      { startRegistryCredentialServiceFixture },
      { startRepositoryReceiptServer },
      { startControlResponseRelay },
      { createResourceScope },
      { dirname },
    ] = await Promise.all([
      import("../../apps/controller/src/drivers/repo/github/driver.ts"),
      import("../../apps/controller/src/backends/repository-credentials/control-client.ts"),
      import("../fixtures/repository-credentials/registry.mjs"),
      import("../../apps/controller/src/backends/repository-credentials/receipt-server.ts"),
      import("../fixtures/repository-credentials/control-relay.mjs"),
      import("../fixtures/repository-credentials/resources.mjs"),
      import("node:path"),
    ]);
    const credentials = await startRegistryCredentialServiceFixture(context, {
      namespaceId: fixture.namespace.id,
      autoOpen: false,
      clock: { ...createControlledClock(), wallNow: Date.now },
      gateway: { listen: "127.0.0.1:0" },
    });
    const scope = createResourceScope();
    context.after(() => scope.close());
    const relay = await startControlResponseRelay(scope, {
      directory: dirname(credentials.config.gateway.controlSocket),
      target: credentials.config.gateway.controlSocket,
    });
    // Simulate the old broker's 404 while all other traffic still reaches the real service.
    relay.setCapabilitiesHidden(true);
    const driver = new GitHubRepoDriver(
      {
        id: credentials.backendId,
        client: new UnixRepositoryCredentialControlClient({ controlSocket: relay.socketPath }),
        drivers: { repo: "repository-credentials" },
      },
      credentials.registry,
      { sessionDurationSeconds: 60, publicCa: credentials.tls.ca },
    );
    const receiptServer = await startRepositoryReceiptServer({
      state: fixture.state,
      controlSocket: credentials.config.gateway.controlSocket,
      driverId: driver.id,
      implementation: driver.implementation,
      backendId: credentials.backendId,
    });
    context.after(() => receiptServer.close());
    const resolution = driver.resolve({
      namespaceId: fixture.namespace.id,
      bindings: [{ repositoryRef: "repo-a", profile: "git-read" }],
    });
    const owner = await fixture.agent("repository-capability");
    const selection = {
      driver: { id: driver.id, implementation: driver.implementation },
      deadlineWallMs: Date.now() + 120_000,
      bindings: resolution.bindings,
    };
    const incompatible = await fixture.revision(owner, 1, { repositoryCredentials: selection });
    await fixture.start(
      {
        ...fixture.compute,
        validateRepositoryCredentials() {},
      },
      {
        pool: fixture.workerPool,
        transformDrivers: (drivers) => ({ ...drivers, repoDriver: driver }),
      },
    );
    // Four jittered retry delays can total nearly 15 seconds before the fifth claim.
    await fixture.work(incompatible, "failed_permanent", 20_000);
    assert.equal(healthy, 0);
    assert.deepEqual(await repositoryAttempts(fixture, incompatible), []);
    assert.ok(credentials.repositories.every(({ github }) => github.issuesOfTokens.length === 0));
    // Restoring the real capability permits an explicit new revision.
    relay.setCapabilitiesHidden(false);
    await waitFor("worker readiness after compatible broker selection", async () =>
      healthy > 0 ? true : undefined,
    );
    const open = driver.open.bind(driver);
    let lostSessionId;
    driver.open = async (input, signal) => {
      const result = await open(input, signal);
      if (lostSessionId === undefined && result.kind === "created") {
        lostSessionId = result.session.sessionId;
        // The response is lost after the broker creates a session, then the
        // capability disappears before recovery gets another worker claim.
        relay.setCapabilitiesHidden(true);
        throw new Error("repository admission response lost after creation");
      }
      return result;
    };
    const uncertain = await fixture.revision(owner, 2, { repositoryCredentials: selection });
    await fixture.work(uncertain, "failed_permanent", 20_000);
    assert.ok(lostSessionId);
    await waitFor("lost session disposal after work failure", async () =>
      (await repositoryAttempts(fixture, uncertain)).find(
        ({ sessionId }) => sessionId === lostSessionId,
      )?.phase === "disposed"
        ? true
        : undefined,
    );
    assert.equal((await repositoryAttempts(fixture, uncertain)).length, 1);
    // Recovery and disposal ran while capability was absent; fresh material
    // requires restoring it and explicitly admitting another revision.
    relay.setCapabilitiesHidden(false);
    const compatible = await fixture.revision(owner, 3, { repositoryCredentials: selection });
    await fixture.work(compatible, "succeeded");
    assert.equal(
      (await repositoryAttempts(fixture, compatible)).filter(({ phase }) => phase === "open")
        .length,
      1,
    );
    // Losing the capability again must not gate the real stop and cleanup paths.
    relay.setCapabilitiesHidden(true);
    const stop = await fixture.requestStop(owner);
    await fixture.work(stop, "succeeded");
    await waitFor("repository cleanup despite the missing capability", async () =>
      (await repositoryAttempts(fixture, compatible)).every(({ phase }) => phase === "disposed")
        ? true
        : undefined,
    );
  },
);

test(
  "worker health remains current while a Compute operation holds a renewed PostgreSQL lease",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context, { leaseDurationMs: 1_200 });
    const { candidate } = await fixture.admitInitialRevision("long-compute-health");
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const events = [];
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision, deploymentContext) {
          entered.resolve();
          await release.promise;
          return fixture.compute.prepareRevision(revision, deploymentContext);
        },
      },
      { emit: (event) => events.push(event) },
    );
    try {
      await entered.promise;
      const healthCount = () => events.filter(({ event }) => event === "worker.health").length;
      const before = healthCount();
      // A busy worker must report fresh database health before Compute returns,
      // not only after completion. The real queue continues renewing its lease.
      await waitFor("health observations during the unfinished Compute operation", async () =>
        healthCount() >= before + 2 ? true : undefined,
      );
      const claimed = await fixture.work(candidate, "claimed");
      assert.equal(claimed.attempt_count, 1);
    } finally {
      release.resolve();
    }
    await fixture.work(candidate, "succeeded");
  },
);

for (const slowCall of [1, 2]) {
  test(
    `slow health update ${slowCall} does not block Compute or PostgreSQL lease renewal`,
    requiresPostgres,
    async (context) => {
      const healthEntered = Promise.withResolvers();
      const releaseHealth = Promise.withResolvers();
      const releaseCompute = Promise.withResolvers();
      let healthCalls = 0;
      // Renewals run every third of the lease. A 4.5 s lease survives a busy CI host's late
      // renewal; a 1.2 s one expired under load (finding 870).
      const fixture = await setup(context, {
        leaseDurationMs: 4_500,
        async onHealthy() {
          if (++healthCalls !== slowCall) {
            return;
          }
          healthEntered.resolve();
          await releaseHealth.promise;
        },
      });
      const { owner, candidate } = await fixture.admitInitialRevision("slow-health");
      const events = [];
      let preparing = false;
      await fixture.start(
        {
          ...fixture.compute,
          async prepareRevision(revision, deploymentContext) {
            preparing = true;
            await releaseCompute.promise;
            return fixture.compute.prepareRevision(revision, deploymentContext);
          },
        },
        { emit: (event) => events.push(event) },
      );
      try {
        await healthEntered.promise;
        // Cover both the health update before the first effect and one started
        // during Compute. Neither may hold the claim's renewal chain hostage.
        await waitFor("Compute to start despite the pending health update", async () =>
          preparing ? true : undefined,
        );
        const original = await fixture.work(candidate, "claimed");
        // Count renewals instead of sampling the lease once: the same claim must be renewed
        // three times while the health update is still pending, however late each renewal
        // runs. Preparation nests two renewal chains, and each renews once before a chain that
        // waited on the health update would stop.
        const lease = async () => {
          const { rows } = await fixture.observerPool.query(
            `SELECT claim_token, attempt_count, lease_expires_at,
                    lease_expires_at > clock_timestamp() AS live
             FROM occ.controller_work WHERE idempotency_key = $1`,
            [candidate.idempotencyKey],
          );
          return rows[0];
        };
        let renewals = 0;
        let expiresAt = (await lease()).lease_expires_at.getTime();
        const renewed = await waitFor(
          "three lease renewals during the pending health update",
          async () => {
            const current = await lease();
            assert.ok(current.live, "the lease must not lapse while the health update is pending");
            if (current.lease_expires_at.getTime() > expiresAt) {
              renewals += 1;
              expiresAt = current.lease_expires_at.getTime();
            }
            return renewals >= 3 ? current : undefined;
          },
          30_000,
        );
        assert.deepEqual(
          { claim_token: renewed.claim_token, attempt_count: renewed.attempt_count },
          { claim_token: original.claim_token, attempt_count: 1 },
        );
        assert.equal(healthCalls, slowCall, "health updates must not overlap");
      } finally {
        releaseHealth.resolve();
        releaseCompute.resolve();
      }
      // A worker that gave up the claim reports it only once Compute returns.
      const done = await fixture.work(candidate, "succeeded");
      assert.equal(done.attempt_count, 1);
      assert.equal(
        events.some(({ code }) => code === "CLAIM_LOST"),
        false,
      );
      const active = await fixture.currentAgent(owner);
      assert.equal(active.activeRevisionId, candidate.id);
    },
  );
}

test(
  "failed readiness updates do not abort Compute or spend its retry budget",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context, {
      leaseDurationMs: 1_200,
      async onHealthy() {
        throw new Error("readiness sink unavailable");
      },
    });
    const { candidate } = await fixture.admitInitialRevision("failed-health");
    const events = [];
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision, deploymentContext) {
          await delay(2_600);
          return fixture.compute.prepareRevision(revision, deploymentContext);
        },
      },
      { emit: (event) => events.push(event) },
    );
    const completed = await fixture.work(candidate, "succeeded");
    assert.equal(completed.attempt_count, 1);
    assert.ok(events.some(({ code }) => code === "HEALTH_UNAVAILABLE"));
    assert.equal(
      events.some(({ code }) => code === "CLAIM_LOST"),
      false,
    );
    assert.equal(
      events.some(({ event }) => event === "worker.health"),
      false,
    );
  },
);

// Finding 1041: an error in a waiting pass's first reads (its resources, or the stored refusal
// itself) was recorded as an ordinary retry. It spent an attempt, and its evidence hid the stored
// refusal, so the next pass prepared the candidate again; at the attempt limit the work failed
// DEPENDENCY_UNAVAILABLE with the candidate running and the refusal lost. The pass now reads the
// stored refusal again and retries its stop. If that read fails too, the claim is left to lease
// recovery, which keeps the refusal.
test(
  "a refused candidate's wait survives failures reading its stored refusal",
  { ...requiresPostgres, timeout: 120_000 },
  async (context) => {
    // Two attempts: on main the second failed read ended the work.
    const fixture = await setup(context, { maxAttempts: 2 });
    const events = [];
    let failedStops = 0;
    let stopping = false;
    let readFailures = 0;
    let injected = 0;
    const queue = fixture.PostgresWorkQueue.prototype;
    const findWorkAttempt = queue.findWorkAttempt;
    queue.findWorkAttempt = function (...args) {
      if (readFailures > 0 && new Error().stack.includes("readRefusalWait")) {
        readFailures -= 1;
        injected += 1;
        return Promise.reject(new Error("canceling statement due to statement timeout"));
      }
      return findWorkAttempt.apply(this, args);
    };
    try {
      const { replacement, driver } = await startRefusedCandidate(fixture, "refused-wait-read", {
        refuse: "unsupported",
        emit: (event) => events.push(event),
        stopRevision: () => {
          if (stopping) {
            return undefined;
          }
          failedStops += 1;
          return Promise.reject(new Error("Pods did not terminate before the deadline"));
        },
      });
      await waitFor("two failed refused stops", async () => (failedStops >= 2 ? true : undefined));
      // One failed read: the same pass reads the refusal again and retries the stop.
      let before = failedStops;
      readFailures = 1;
      await waitFor(
        "a failed read, then the stop retried",
        async () => (injected >= 1 && failedStops >= before + 1 ? true : undefined),
        30_000,
      );
      // Both reads fail: the pass leaves its claim, and lease recovery keeps the refusal.
      readFailures = 2;
      await waitFor(
        "two failed reads in one pass",
        async () => {
          const ended = await fixture.workResult(replacement);
          assert.equal(ended.rows[0].reason_code, null, "the wait ended");
          const left = events.some(
            ({ event, code, workId }) =>
              event === "worker.error" &&
              code === "WORKER_UNAVAILABLE" &&
              workId === replacement.idempotencyKey,
          );
          return injected >= 3 && left ? true : undefined;
        },
        30_000,
      );
      const claimed = await fixture.observerPool.query(
        "SELECT claim_token FROM occ.controller_work WHERE idempotency_key = $1 AND state = 'claimed'",
        [replacement.idempotencyKey],
      );
      assert.equal(claimed.rowCount, 1, "the failed pass left its claim");
      before = failedStops;
      await fixture.expireClaim(replacement, claimed.rows[0].claim_token);
      await waitFor(
        "the recovered wait retries the stop",
        async () => (failedStops >= before + 1 ? true : undefined),
        30_000,
      );
      stopping = true;
      await fixture.work(replacement, "failed_permanent", 30_000);
      const result = await fixture.workResult(replacement);
      assert.equal(result.rows[0].reason_code, "SANDBOX_HARNESS_UNSUPPORTED");
      assert.equal(driver.count(replacement), 1, "the refused candidate was stopped");
      assert.deepEqual([...driver.running], []);
      assert.equal(driver.preparations(replacement), 2, "no wait prepared the candidate again");
      const evidence = await fixture.observerPool.query(
        `SELECT details->>'reasonCode' AS code, details->>'refusal' AS refusal
           FROM occ.audit_events WHERE details->>'workId' = $1 ORDER BY occurred_at, id`,
        [replacement.idempotencyKey],
      );
      const codes = evidence.rows.map(({ code, refusal }) => `${code}:${refusal ?? ""}`);
      assert.ok(codes.includes("LEASE_EXPIRED:SANDBOX_HARNESS_UNSUPPORTED"), codes.join(" "));
      assert.ok(!codes.some((code) => code.startsWith("DEPENDENCY_UNAVAILABLE")), codes.join(" "));
    } finally {
      queue.findWorkAttempt = findWorkAttempt;
    }
  },
);

// Finding 1042: an authorization or backend refusal that lifted after the convergence deadline
// prepared its waiting candidate again, and the deadline then ended the work with that candidate
// running beside the stopped predecessor the active pointer still named. Past the deadline the
// lift now stops the candidate and publishes the deadline, waiting like a refusal if the stop
// fails.
test(
  "an authorization refusal lifted past the deadline stops its candidate",
  { ...requiresPostgres, timeout: 120_000 },
  async (context) => {
    const fixture = await setup(context);
    const events = [];
    let failedStops = 0;
    let lifted = false;
    let liftedAt = 0;
    let failedAfterLift = 0;
    let admitted = Infinity;
    let preparations;
    let scenario;
    scenario = await startRefusedCandidate(fixture, "refused-lifts-late", {
      refuse: "iam",
      emit: (event) => events.push(event),
      // On main the pass after the grant prepared it again, and it became ready too late.
      candidateReady: () => lifted && Date.now() - liftedAt > 1_500,
      stopRevision: () => {
        if (lifted && failedAfterLift >= 2) {
          return undefined;
        }
        failedStops += 1;
        if (lifted) {
          failedAfterLift += 1;
        } else if (failedStops >= 2 && Date.now() - admitted > 3_000) {
          // Granted during this pass's stop, after its denial: the next pass sees the grant.
          lifted = true;
          liftedAt = Date.now();
          preparations = scenario.driver.preparations(scenario.replacement);
        }
        return Promise.reject(new Error("Kubernetes API temporarily unavailable"));
      },
      startOptions: {
        convergenceTimeoutMs: 2_000,
        transformDrivers: proxiedIAM(async (iam, request) => {
          const decision = await iam.authorize(request);
          const denied =
            !lifted &&
            request.action === "deploy" &&
            scenario !== undefined &&
            scenario.driver.preparations(scenario.replacement) > 0;
          return denied ? { ...decision, allowed: false } : decision;
        }),
      },
    });
    const { owner, first, replacement, driver } = scenario;
    admitted = Date.now();
    await waitFor("the grant past the deadline", async () => (lifted ? true : undefined), 30_000);
    await waitFor(
      "a wait on the deadline",
      async () =>
        refusedStopWaits(events, replacement).some(
          ({ refusal }) => refusal === "CONVERGENCE_DEADLINE_EXCEEDED",
        )
          ? true
          : undefined,
      30_000,
    );
    const waiting = await fixture.deploymentStatus(owner, replacement);
    assert.equal(waiting.progress.lastAttempt.code, "REFUSED_CANDIDATE_STOP_PENDING");
    assert.equal(
      waiting.progress.lastAttempt.message,
      "Deployment missed its convergence deadline; stopping the candidate before recording the failure. The controller will retry.",
    );
    await fixture.work(replacement, "failed_permanent", 60_000);
    const result = await fixture.workResult(replacement);
    assert.equal(result.rows[0].reason_code, "CONVERGENCE_DEADLINE_EXCEEDED");
    assert.deepEqual(result.rows[0].result_data, { timeoutMs: 2_000 });
    assert.equal(driver.preparations(replacement), preparations, "not prepared after the grant");
    assert.equal(failedAfterLift, 2);
    assert.equal(driver.count(replacement), 1, "the candidate was stopped");
    assert.ok(!driver.running.has(replacement.id));
    assert.ok(!driver.running.has(first.id), "the sweep had stopped the predecessor");
    const active = await fixture.activePointer(owner);
    assert.equal(active.rows[0].active_revision_id, first.id);
    // The waits after the grant name the deadline they will publish.
    const waits = refusedStopWaits(events, replacement).map(({ refusal }) => refusal);
    const lateWaits = waits.slice(waits.indexOf("CONVERGENCE_DEADLINE_EXCEEDED"));
    assert.deepEqual(lateWaits, ["CONVERGENCE_DEADLINE_EXCEEDED", "CONVERGENCE_DEADLINE_EXCEEDED"]);
  },
);
