import assert from "node:assert/strict";
import test, { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { TransientDependencyError } from "../../packages/occ/src/index.ts";
import {
  ComputeStopYieldedError,
  computeStopShouldYield,
} from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";
import {
  assertWorkEnds,
  denyDeploy,
  failingStop,
  proxiedIAM,
  refusals,
  refusedStopWaits,
  startRefusedCandidate,
  waitForRefusedStopWaits,
} from "../helpers/postgres-worker-refused-candidate.mjs";

// A refused candidate's stop: a failing stop's status, recheck backoff, yields and restarts, the
// wait past the deadline and a refusal lifted during it, and supersession while the stop fails.
// The rest of worker health, including refused exclusive and shared deployments, is in the
// -health sibling; the lane runs the revision files at once. Neither file names the other in
// full: CI Impact sends a test-only change to full CI when another file names that test.

const { setup, cleanup, revisionTest } = createWorkerRevisionFixtures(import.meta.url);
after(cleanup);

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
