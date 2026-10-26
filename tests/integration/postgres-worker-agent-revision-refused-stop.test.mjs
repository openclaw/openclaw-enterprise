import assert from "node:assert/strict";
import { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  ComputeStopYieldedError,
  computeStopShouldYield,
} from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { waitFor } from "../helpers/wait-for.mjs";
import { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";
import {
  failingStop,
  refusedStopWaits,
  startRefusedCandidate,
  waitForRefusedStopWaits,
} from "../helpers/postgres-worker-refused-candidate.mjs";

// A refused candidate's stop: a failing stop's status, its recheck backoff across slow stops,
// restarts and shutdowns, and yields to other Work. A stored refusal's wait (its failures, a lift
// or supersession during it, and lost claims and restarts) is in the -refused-wait sibling;
// refused exclusive and shared deployments are in the -replacement sibling. The lane runs the
// revision files at once. These files name the -replacement, -refused-stop and -refused-wait
// siblings only by suffix: CI Impact sends a test-only change to full CI when another file names
// that test.

const { cleanup, revisionTest } = createWorkerRevisionFixtures(import.meta.url);
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
