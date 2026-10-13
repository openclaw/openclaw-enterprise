import assert from "node:assert/strict";
import test, { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  ComputeStopYieldedError,
  computeStopShouldYield,
  computeWorkWaiting,
} from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";
import {
  assertWorkEnds,
  denyDeploy,
  proxiedIAM,
} from "../helpers/postgres-worker-refused-candidate.mjs";

// Exclusive redeploys whose predecessor stop yields during its Gateway drain: the replacement
// waits for the drain, newer and refused deployments supersede it, an Agent stop overtakes it, and
// lease recovery grants its last attempt one more. Other exclusive replacement and refused
// candidate cases are in the -replacement sibling; the lane runs the revision files at once.
// These files name the -replacement and -yielded-redeploy siblings only by suffix: CI Impact sends
// a test-only change to full CI when another file names that test.

const { setup, cleanup, revisionTest } = createWorkerRevisionFixtures(import.meta.url);
after(cleanup);

// Finding 1090: on exclusive replacement (Kubernetes dedicated), a redeploy's stop of its
// predecessor held the serial worker for the predecessor Gateway's whole drain (up to about
// 340 s). That drain now yields to due Work like a stopped Agent's. This exclusive Compute
// simulates it: a running revision's Gateway drains for `drainMs` from its first stop call, the
// wait ends with ComputeStopYieldedError when the worker allows it, and the Harness stops only
// after the drain. `overlaps` records any preparation while another revision of the same Agent
// still has a Harness: the RWO workspace and Gateway SQLite volumes would be mounted twice.
// `busy` revisions never become ready, so their deployments keep Work due. With `holdMs`, each of
// their passes first holds an optional wait (like the D221 binding ack) for up to `holdMs`, ending
// it once other Work is due; `holds` records how long each one took. A stop for which `failStop`
// resolves true throws before it does anything.
function drainingExclusiveCompute(fixture, { drainMs, holdMs, failStop = async () => false }) {
  const running = new Map();
  const busy = new Set();
  const prepared = [];
  const overlaps = [];
  const harnessStops = [];
  const drains = new Map();
  const pointers = new Set();
  const stopCalls = new Map();
  const holds = [];
  let yields = 0;
  const compute = {
    ...fixture.compute,
    requiresStoppedPredecessors: () => true,
    async prepareRevision(revision) {
      for (const [id, agentId] of running) {
        if (id !== revision.id && agentId === revision.agentId) {
          overlaps.push([revision.id, id]);
        }
      }
      running.set(revision.id, revision.agentId);
      prepared.push(revision.id);
      if (holdMs !== undefined && busy.has(revision.id)) {
        const started = Date.now();
        while (Date.now() - started < holdMs && !(await computeWorkWaiting())) {
          await delay(100);
        }
        holds.push(Date.now() - started);
      }
      const observation = await fixture.compute.prepareRevision(revision);
      return busy.has(revision.id) ? { ...observation, ready: false } : observation;
    },
    async stopRevision(revision) {
      stopCalls.set(revision.id, (stopCalls.get(revision.id) ?? 0) + 1);
      if (await failStop(revision)) {
        throw new Error("Kubernetes API temporarily unavailable");
      }
      if (!running.has(revision.id)) {
        return;
      }
      if (!drains.has(revision.id)) {
        drains.set(revision.id, Date.now() + drainMs);
      }
      while (Date.now() < drains.get(revision.id)) {
        const agent = await fixture.currentAgent({ id: revision.agentId });
        pointers.add(agent?.activeRevisionId ?? null);
        if (await computeStopShouldYield("gateway")) {
          yields += 1;
          throw new ComputeStopYieldedError(
            "The AgentRevision workload Pods are still terminating; other work is waiting.",
          );
        }
        await delay(100);
      }
      running.delete(revision.id);
      harnessStops.push(revision.id);
    },
    async retireRevision(revision) {
      running.delete(revision.id);
    },
  };
  return {
    compute,
    running,
    busy,
    prepared,
    overlaps,
    harnessStops,
    pointers,
    holds,
    stopCalls: (revision) => stopCalls.get(revision.id) ?? 0,
    yields: () => yields,
  };
}

function runningFor(driver, owner) {
  return [...driver.running].filter(([, agentId]) => agentId === owner.id).map(([id]) => id);
}

function workPasses(events, work) {
  return events.filter(
    ({ event, workId }) => event === "worker.completed" && workId === work.idempotencyKey,
  );
}

/**
 * An exclusive Agent whose first revision serves, another Agent's deployment that keeps Work due,
 * and a redeploy whose first pass yields its predecessor stop. `drainMs` is the first revision's
 * Gateway drain; `holdMs`, `failStop` and `start` (worker options) are optional.
 */
async function yieldedRedeploy(fixture, label, { drainMs, holdMs, failStop, start = {} }) {
  const owner = await fixture.agent(label, { executionMode: "dedicated" });
  const driver = drainingExclusiveCompute(fixture, { drainMs, holdMs, failStop });
  const events = [];
  await fixture.start(driver.compute, {
    ...start,
    emit: (event) => events.push({ ...event, at: Date.now() }),
  });
  const first = await fixture.revision(owner, 1);
  await fixture.work(first, "succeeded");
  const busy = await fixture.revision(await fixture.agent(`${label}-busy`), 1);
  driver.busy.add(busy.id);
  const requestedAt = Date.now();
  const replacement = await fixture.revision(owner, 2);
  const yielded = await waitFor("the predecessor stop to yield", async () =>
    workPasses(events, replacement).find(({ code }) => code === "PREDECESSOR_STOP_YIELDED"),
  );
  return { owner, driver, events, first, busy, replacement, yielded, requestedAt };
}

revisionTest(
  "a redeploy's predecessor stop yields during its Gateway drain and the replacement starts after it",
  async (fixture) => {
    const { owner, driver, events, first, busy, replacement, yielded, requestedAt } =
      await yieldedRedeploy(fixture, "drain-predecessor", { drainMs: 6_000 });
    assert.equal(yielded.outcome, "pending");
    // Deployment status says what the replacement waits for.
    const waiting = await fixture.deploymentStatus(owner, replacement);
    assert.equal(waiting.progress.lastAttempt.code, "PREDECESSOR_STOP_YIELDED");
    // The other Agent's deployment runs while the replacement waits for the drain.
    await waitFor(
      "another Agent's pass while the replacement is deferred",
      async () =>
        events.some(
          ({ event, workId, at }) =>
            event === "worker.completed" && workId === busy.idempotencyKey && at > yielded.at,
        ) || undefined,
    );
    const done = await fixture.work(replacement, "succeeded", 30_000);
    // Bounded by the drain, not by full waits of its own; yields refund their attempt.
    assert.ok(Date.now() - requestedAt < 6_000 + 20_000, `${Date.now() - requestedAt} ms`);
    assert.ok(done.attempt_count <= 1, `attempts ${done.attempt_count}`);
    // Hard invariant: the replacement was prepared only after the predecessor's Harness stopped,
    // and the predecessor's stop resumed its drain rather than restarting it (one Harness stop).
    assert.deepEqual(driver.overlaps, []);
    assert.deepEqual(driver.harnessStops, [first.id]);
    assert.ok(driver.yields() >= 1);
    assert.ok(driver.prepared.indexOf(replacement.id) > driver.prepared.lastIndexOf(first.id));
    // While the drain yielded, the pointer still named the predecessor; then the replacement.
    assert.deepEqual([...driver.pointers], [first.id]);
    assert.equal((await fixture.currentAgent(owner)).activeRevisionId, replacement.id);
    const passes = workPasses(events, replacement);
    assert.ok(passes.every(({ code }) => code !== "DEPENDENCY_UNAVAILABLE"));
    // The yields are throttled like a stopped Agent's, and the completion carries their count.
    assert.deepEqual(
      passes.map(({ code, stopYields }) => [code, stopYields]),
      [
        ["PREDECESSOR_STOP_YIELDED", 1],
        ["REVISION_ACTIVATED", driver.yields()],
      ],
    );
  },
);

revisionTest(
  "a newer deployment admitted while a predecessor stop is yielded supersedes it and starts last",
  async (fixture) => {
    const { owner, driver, first, replacement } = await yieldedRedeploy(
      fixture,
      "drain-predecessor-third",
      { drainMs: 8_000 },
    );
    const third = await fixture.revision(owner, 3);
    await Promise.all([
      fixture.work(third, "succeeded", 30_000),
      fixture.work(replacement, "succeeded", 30_000),
    ]);
    assert.equal(
      (await fixture.workResult(replacement)).rows[0].reason_code,
      "REVISION_SUPERSEDED",
    );
    // Nothing slipped in: the yielded replacement never started, and the newer revision started
    // only once the predecessor's Harness was gone.
    assert.deepEqual(driver.overlaps, []);
    assert.ok(!driver.prepared.includes(replacement.id), driver.prepared.join(","));
    assert.deepEqual(driver.harnessStops, [first.id]);
    assert.deepEqual(runningFor(driver, owner), [third.id]);
    assert.equal((await fixture.currentAgent(owner)).activeRevisionId, third.id);
  },
);

revisionTest(
  "a yielded redeploy superseded by a deployment refused before Compute finishes its predecessor stop",
  async (fixture) => {
    const { owner, driver, first, replacement } = await yieldedRedeploy(
      fixture,
      "drain-predecessor-handoff",
      { drainMs: 4_000 },
    );
    // The newer deployment is refused before its pass reaches the predecessor sweep.
    const refused = await fixture.revision(owner, 3, {
      harness: { ...fixture.productionHarness, mode: "dedicated", version: "0.0.0-unapproved" },
    });
    await assertWorkEnds(fixture, refused, "failed_permanent", "HARNESS_DESCRIPTOR_MISMATCH");
    await assertWorkEnds(fixture, replacement, "succeeded", "REVISION_SUPERSEDED");
    // The superseded work finished the stop it started, so no Harness is left without its
    // Gateway; nothing else would stop it until a later deployment, stop or delete.
    assert.deepEqual(driver.harnessStops, [first.id]);
    assert.deepEqual(runningFor(driver, owner), []);
    assert.ok(!driver.prepared.includes(replacement.id));
    assert.ok(!driver.prepared.includes(refused.id));
    assert.deepEqual(driver.overlaps, []);
    assert.equal((await fixture.activePointer(owner)).rows[0].active_revision_id, first.id);
  },
);

revisionTest(
  "a redeploy refused while its predecessor stop is yielded finishes that stop before it fails",
  async (fixture) => {
    const { owner, driver, first, replacement } = await yieldedRedeploy(
      fixture,
      "drain-predecessor-refused",
      { drainMs: 4_000 },
    );
    // The deploying actor loses deploy; the next pass refuses the replacement.
    await denyDeploy(fixture, owner);
    await assertWorkEnds(fixture, replacement, "failed_permanent", "AUTHORIZATION_DENIED");
    // The predecessor whose Gateway was already removed is stopped before the failure is
    // published, as when its stop never yielded, so its Harness does not keep the workspace.
    assert.deepEqual(driver.harnessStops, [first.id]);
    assert.deepEqual(runningFor(driver, owner), []);
    assert.ok(!driver.prepared.includes(replacement.id));
    assert.deepEqual(driver.overlaps, []);
    // Nothing serves until a new revision activates; the pointer still names the predecessor.
    assert.equal((await fixture.activePointer(owner)).rows[0].active_revision_id, first.id);
  },
);

// Finding 1109: an Agent stop admitted while a redeploy's predecessor stop is yielded makes the
// redeploy's next pass end REVISION_STOPPED. It finishes the predecessor stop it started first,
// so the predecessor's Harness does not depend on the Agent-stop work alone, which re-decides
// `operate` on every pass and here fails. A failure of that stop retries it, as for the
// redeploy's own stop, instead of ending stopped with the predecessor half stopped.
for (const failing of [false, true]) {
  revisionTest(
    failing
      ? "a yielded redeploy overtaken by an Agent stop retries a failed predecessor stop before it ends stopped"
      : "a yielded redeploy overtaken by an Agent stop finishes its predecessor stop before it ends stopped",
    async (fixture) => {
      let operateDenied;
      let failOnce = failing;
      const { owner, driver, events, first, replacement } = await yieldedRedeploy(
        fixture,
        `drain-predecessor-stopped-${failing}`,
        {
          drainMs: 10_000,
          // The first stop of the predecessor once the Agent is stopped fails.
          failStop: async (revision) => {
            if (
              !failOnce ||
              revision.revision !== 1 ||
              (await fixture.currentAgent({ id: revision.agentId }))?.desiredRuntimeState !==
                "stopped"
            ) {
              return false;
            }
            failOnce = false;
            return true;
          },
          start: {
            transformDrivers: proxiedIAM(async (iam, request) => {
              const decision = await iam.authorize(request);
              return request.action === "operate" && request.resource.id === operateDenied
                ? { ...decision, allowed: false }
                : decision;
            }),
          },
        },
      );
      // The stop is admitted, but the worker's per-pass check refuses the Agent-stop work.
      operateDenied = owner.id;
      const stop = await fixture.requestStop(owner);
      await assertWorkEnds(fixture, stop, "failed_permanent", "AUTHORIZATION_DENIED");
      await assertWorkEnds(fixture, replacement, "succeeded", "REVISION_STOPPED");
      // Hard invariant: nothing prepared the replacement, and the predecessor whose Gateway the
      // redeploy removed ended fully stopped, by the redeploy's own work.
      assert.ok(!driver.prepared.includes(replacement.id), driver.prepared.join(","));
      assert.deepEqual(driver.overlaps, []);
      assert.deepEqual(driver.harnessStops, [first.id]);
      assert.deepEqual(runningFor(driver, owner), []);
      // A stop keeps the pointer and the workspace; only a deployment moves the pointer.
      assert.equal((await fixture.activePointer(owner)).rows[0].active_revision_id, first.id);
      // Its finishing drain yielded like the stopped Agent's own drain, not as a deployment
      // waiting to start: deployment status read AGENT_STOP_YIELDED meanwhile.
      const codes = workPasses(events, replacement).map(({ code }) => code);
      assert.equal(codes.at(-1), "REVISION_STOPPED");
      assert.equal(codes.includes("DEPENDENCY_UNAVAILABLE"), failing, codes.join(", "));
      assert.equal(failOnce, false);
      if (failing) {
        return;
      }
      const evidence = await fixture.observerPool.query(
        `SELECT details->>'reasonCode' AS reason_code FROM occ.audit_events
       WHERE kind = 'mutation' AND action = 'reconcile' AND details->>'workId' = $1
       ORDER BY occurred_at, id`,
        [replacement.idempotencyKey],
      );
      assert.deepEqual(
        evidence.rows
          .map(({ reason_code: code }) => code)
          .filter((code) => code.endsWith("_YIELDED")),
        ["PREDECESSOR_STOP_YIELDED", "AGENT_STOP_YIELDED"],
      );
    },
  );
}

// Finding 1108: once a redeploy's predecessor stop yielded, another Agent's optional in-pass wait
// (here a 20 s hold, like the D221 binding ack) still ends when the redeploy is due: the redeploy's
// next pass may be its whole deployment. Only a Gateway drain does not end for it.
revisionTest(
  "another Agent's optional wait ends for a yielded redeploy, which starts soon after its drain",
  async (fixture) => {
    const { owner, driver, first, replacement, requestedAt } = await yieldedRedeploy(
      fixture,
      "drain-predecessor-hold",
      { drainMs: 3_000, holdMs: 20_000 },
    );
    await fixture.work(replacement, "succeeded", 30_000);
    // Bounded by the drain and a few rechecks, not by the other Agent's 20 s holds.
    const elapsed = Date.now() - requestedAt;
    assert.ok(elapsed < 3_000 + 12_000, `${elapsed} ms, holds ${driver.holds.join(", ")}`);
    assert.deepEqual(driver.overlaps, []);
    assert.deepEqual(driver.harnessStops, [first.id]);
    assert.equal((await fixture.currentAgent(owner)).activeRevisionId, replacement.id);
  },
);

revisionTest(
  "a redeploy refused before stopping its predecessor leaves the serving revision running",
  async (fixture) => {
    const owner = await fixture.agent("drain-predecessor-early", { executionMode: "dedicated" });
    const driver = drainingExclusiveCompute(fixture, { drainMs: 4_000 });
    await fixture.start(driver.compute);
    const first = await fixture.revision(owner, 1);
    await fixture.work(first, "succeeded");
    await denyDeploy(fixture, owner);
    const replacement = await fixture.revision(owner, 2);
    await assertWorkEnds(fixture, replacement, "failed_permanent", "AUTHORIZATION_DENIED");
    assert.equal(driver.stopCalls(first), 0, "the serving revision is not stopped");
    assert.ok(driver.running.has(first.id));
    assert.equal((await fixture.activePointer(owner)).rows[0].active_revision_id, first.id);
  },
);

// Finding 1107: a yielded redeploy whose worker crashes on its last attempt is not ended by lease
// recovery in SQL, which would leave the predecessor's Harness and workspace with no Gateway and
// nothing to stop them. Recovery grants one more attempt, and that pass finishes the stop.
for (const refused of [false, true]) {
  test(
    refused
      ? "a yielded redeploy refused on the extra attempt after its last claim expired finishes its predecessor stop"
      : "a yielded redeploy whose last claim expires gets one more attempt, which finishes its predecessor stop",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const fixture = await setup(context, { maxAttempts: 1 });
      const { owner, driver, first, replacement } = await yieldedRedeploy(
        fixture,
        `drain-predecessor-crash-${refused}`,
        { drainMs: 8_000 },
      );
      // The worker dies during the deployment's last (only) attempt; its claim expires.
      await fixture.stop();
      await fixture.observerPool.query(
        `UPDATE occ.controller_work
         SET state = 'claimed', attempt_count = 1,
           claim_token = COALESCE(claim_token, gen_random_uuid()),
           lease_expires_at = clock_timestamp() - interval '1 second'
         WHERE idempotency_key = $1`,
        [replacement.idempotencyKey],
      );
      const queue = new fixture.PostgresWorkQueue(fixture.observerPool, {
        leaseDurationMs: 30_000,
        maxAttempts: 1,
        random: () => 0,
      });
      await queue.recoverStale();
      const row = await fixture.observerPool.query(
        "SELECT state, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
        [replacement.idempotencyKey],
      );
      assert.deepEqual(row.rows[0], { state: "queued", attempt_count: 0 });
      if (refused) {
        await denyDeploy(fixture, owner);
      }
      await fixture.start(driver.compute);
      if (refused) {
        await assertWorkEnds(fixture, replacement, "failed_permanent", "AUTHORIZATION_DENIED");
      } else {
        await assertWorkEnds(fixture, replacement, "succeeded", "REVISION_ACTIVATED");
      }
      // Hard invariant: the predecessor's Harness stopped once, before anything prepared the
      // replacement, and no Harness is left without its Gateway.
      assert.deepEqual(driver.overlaps, []);
      assert.deepEqual(driver.harnessStops, [first.id]);
      assert.deepEqual(runningFor(driver, owner), refused ? [] : [replacement.id]);
      assert.equal(
        (await fixture.activePointer(owner)).rows[0].active_revision_id,
        refused ? first.id : replacement.id,
      );
    },
  );
}
