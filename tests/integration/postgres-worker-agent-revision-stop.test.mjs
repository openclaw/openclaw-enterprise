import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createOccMetrics } from "../../apps/controller/src/metrics/index.ts";
import { createOccLogger, createWorkerLogEmitter } from "../../apps/controller/src/logging.ts";
import { PostgresMetricsSnapshot } from "../../packages/occ/src/index.ts";
import {
  ComputeStopYieldedError,
  computeStopShouldYield,
  computeWorkWaiting,
  currentComputeAbortSignal,
} from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import { jsonLineDestination } from "../helpers/json-lines.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";
import {
  advanceCleanupRetries,
  completedPasses,
  completion,
  makeWorkDue,
  removeAccessBindings,
  repositoryAttempts,
  repositoryBoundary,
} from "../helpers/postgres-worker-revision-support.mjs";

// Agent stop and its Gateway drain, Agent deletion and Namespace teardown, moved unchanged from
// the -teardown sibling, which keeps the repository session cases, so the two run side by side in
// the PostgreSQL Application lane. Deployment and dispatch cases, and the persisted deploy, stop
// and delete lifecycle, are in postgres-worker-agent-revision.test.mjs.

const { setup, cleanup, revisionTest } = createWorkerRevisionFixtures(import.meta.url);
after(cleanup);

async function coldSshComputeDriver(fixture, operations) {
  const { SshComputeDriver } =
    await import("../../apps/controller/src/drivers/compute/ssh/index.ts");
  return new SshComputeDriver(
    {
      ssh: { identityFile: "/fixture/identity", knownHostsFile: "/fixture/hosts" },
      hosts: { [fixture.namespace.name]: { address: "127.0.0.1", user: "root" } },
      runtime: {
        nodePath: "/usr/bin/node",
        openclawPath: "/opt/openclaw/index.js",
        user: "runtime",
        root: "/var/lib/openclaw-enterprise",
      },
      network: { gatewayPortRange: { start: 18800, end: 18899 } },
    },
    {
      id: fixture.compute.id,
      implementation: fixture.compute.implementation,
      executor: {
        async execute(request) {
          operations.push(JSON.parse(Buffer.from(request.operation, "base64").toString()));
          return { code: 0, stdout: '{"ok":true}', stderr: "" };
        },
      },
    },
  );
}

test(
  "Agent stop clears only the exact active pointer after Compute shutdown and retries safely",
  requiresPostgres,
  async (context) => {
    const metrics = createOccMetrics("worker", () =>
      new PostgresMetricsSnapshot(fixture.observerPool).collect(),
    );
    const fixture = await setup(context, { metrics });
    const before = await new PostgresMetricsSnapshot(fixture.observerPool).collect();
    const owner = await fixture.agent("stop-target");
    const sibling = await fixture.agent("stop-sibling");
    const targetRevision = await fixture.revision(owner, 1);
    const siblingRevision = await fixture.revision(sibling, 1);
    const stoppedRevisions = [];
    let failStopOnce = true;
    let failedCandidate;
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision) {
          const observation = await fixture.compute.prepareRevision(revision);
          return revision.namespaceId === fixture.namespace.id && revision.revision === 2
            ? { ...observation, ready: false }
            : observation;
        },
        async stopRevision(revision) {
          // The real queue can dispatch due work from earlier Namespaces. Keep
          // this failure injection and its ownership assertions in this fixture.
          if (revision.namespaceId !== fixture.namespace.id) {
            return fixture.compute.stopRevision(revision);
          }
          const during = await new PostgresMetricsSnapshot(fixture.observerPool).collect();
          assert.equal(
            during.agents.stopping,
            before.agents.stopping + 1,
            "stop stays in progress until Compute shutdown commits",
          );
          const current = await fixture.currentAgent(owner);
          if (stoppedRevisions.length < 3) {
            assert.equal(
              current.activeRevisionId,
              targetRevision.id,
              "the serving pointer remains until candidate cleanup succeeds",
            );
          }
          if (revision.id === failedCandidate.id && failStopOnce) {
            failStopOnce = false;
            throw new Error("transient Compute stop failure");
          }
          stoppedRevisions.push(revision.id);
        },
      },
      { convergenceTimeoutMs: 50 },
    );
    await Promise.all([
      fixture.work(targetRevision, "succeeded"),
      fixture.work(siblingRevision, "succeeded"),
    ]);

    // The replacement owns resources but never becomes ready. Terminal queue
    // failure must not make it invisible to the real Agent-stop workflow.
    failedCandidate = await fixture.revision(owner, 2);
    await fixture.work(failedCandidate, "failed_permanent");
    const firstStop = await fixture.requestStop(owner);
    const completedStop = await fixture.work(firstStop, "succeeded");
    assert.equal(completedStop.attempt_count, 2);
    // Stop work must retain its own bounded kind and committed retry/success
    // outcomes after integrating stop support with metrics instrumentation. Both
    // are recorded after the stop commits, the attempt outcome last.
    const exposition = await waitFor("the stop's successful attempt metric", async () => {
      const text = await metrics.exposition();
      return /occ_reconciliation_attempts_total\{[^\n]*work_kind="agent_stop"[^\n]*outcome="success"/.test(
        text,
      )
        ? text
        : undefined;
    });
    assert.match(
      exposition,
      /occ_agent_operation_duration_seconds_count\{[^\n]*operation="stop"[^\n]*\} 1(?:\n|$)/,
    );
    const after = await new PostgresMetricsSnapshot(fixture.observerPool).collect();
    assert.equal(after.agents.stopped, before.agents.stopped + 1);
    assert.equal(after.agents.running, before.agents.running + 1);
    for (const outcome of ["retry", "success"]) {
      assert.match(
        exposition,
        new RegExp(
          `occ_reconciliation_attempts_total\\{[^\\n]*work_kind="agent_stop"[^\\n]*outcome="${outcome}"[^\\n]*\\} 1(?:\\n|$)`,
        ),
      );
    }
    const [stopped, unaffected, retainedRevision] = await fixture.state.read(async (view) =>
      Promise.all([
        view.agents.findAgent(fixture.namespace.id, owner.id),
        view.agents.findAgent(fixture.namespace.id, sibling.id),
        view.revisions.findRevision(fixture.namespace.id, owner.id, targetRevision.id),
      ]),
    );
    assert.equal(stopped.desiredRuntimeState, "stopped");
    assert.equal(stopped.activeRevisionId, undefined);
    assert.equal(unaffected.activeRevisionId, siblingRevision.id);
    assert.equal(retainedRevision.id, targetRevision.id);
    assert.deepEqual(stoppedRevisions, [targetRevision.id, targetRevision.id, failedCandidate.id]);

    const repeatedStop = await fixture.requestStop(owner);
    await fixture.work(repeatedStop, "succeeded");
    assert.deepEqual(stoppedRevisions, [
      targetRevision.id,
      targetRevision.id,
      failedCandidate.id,
      targetRevision.id,
      failedCandidate.id,
    ]);
    const audit = await fixture.observerPool.query(
      `SELECT action, resource_id, details->>'reasonCode' AS reason_code
       FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.stop'
       ORDER BY occurred_at`,
      [fixture.namespace.id],
    );
    assert.deepEqual(audit.rows, [
      {
        action: "openclaw.agents.lifecycle.stop",
        resource_id: owner.id,
        reason_code: "AGENT_STOPPED",
      },
      {
        action: "openclaw.agents.lifecycle.stop",
        resource_id: owner.id,
        reason_code: "AGENT_ALREADY_STOPPED",
      },
    ]);
  },
);

// Finding 1088: an Agent stop held the serial worker for its Gateway's whole drain (up to about
// 340 s on Kubernetes), stalling every other Agent's work. A stopped Agent's drain wait now
// yields to due Work and the stop is deferred and repeated. This Compute simulates that wait for
// each of `owners`: an Agent's drain ends `drainMs` after its first stop call (a Gateway Pod's
// grace runs from its deletion, across controller restarts), the wait ends with
// ComputeStopYieldedError when the worker allows it and other Work is due, and a Harness is
// stopped only after the drain. Kubernetes' own wait is in the Compute conformance tests. `busy`
// names revisions that never become ready, so their deployments keep Work due; `onFirstStop` runs
// once, inside an Agent's first stop. A record's `drainStartedAt` and `drainEndsAt` are its drain's
// wall-clock window, set once `onFirstStop` returns, for same-run ordering checks. `record` is the
// first owner's.
function gatewayDrainCompute(fixture, owners, { drainMs, onFirstStop }) {
  const busy = new Set();
  const records = new Map(
    owners.map((owner) => [
      owner.id,
      {
        busy,
        calls: 0,
        yields: 0,
        harnessStops: [],
        pointers: new Set(),
        waitingWithoutYield: false,
        drainStartedAt: undefined,
        drainEndsAt: undefined,
      },
    ]),
  );
  const compute = {
    ...fixture.compute,
    async prepareRevision(revision) {
      const observation = await fixture.compute.prepareRevision(revision);
      return busy.has(revision.id) ? { ...observation, ready: false } : observation;
    },
    async stopRevision(revision) {
      const record = records.get(revision.agentId);
      if (record === undefined) {
        return fixture.compute.stopRevision(revision);
      }
      record.calls += 1;
      if (record.drainEndsAt === undefined) {
        record.drainEndsAt = Number.POSITIVE_INFINITY;
        await onFirstStop?.();
        record.drainStartedAt = Date.now();
        record.drainEndsAt = record.drainStartedAt + drainMs;
      }
      while (Date.now() < record.drainEndsAt) {
        currentComputeAbortSignal()?.throwIfAborted();
        const agent = await fixture.currentAgent({ id: revision.agentId });
        record.pointers.add(agent?.activeRevisionId ?? null);
        if (await computeStopShouldYield("gateway")) {
          record.yields += 1;
          throw new ComputeStopYieldedError(
            "The AgentRevision workload Pods are still terminating; other work is waiting.",
          );
        }
        if (await computeWorkWaiting()) {
          record.waitingWithoutYield = true;
        }
        await delay(100);
      }
      record.harnessStops.push(revision.id);
    },
  };
  return { compute, busy, records, record: records.get(owners[0].id) };
}

function stopPasses(events, stop) {
  return events.filter(
    ({ event, workId }) => event === "worker.completed" && workId === stop.idempotencyKey,
  );
}

async function stopAudit(fixture, owner) {
  const audit = await fixture.observerPool.query(
    `SELECT details->>'reasonCode' AS reason_code FROM occ.audit_events
     WHERE namespace_id = $1 AND resource_id = $2
       AND (action = 'openclaw.agents.lifecycle.stop' OR details->>'reasonCode' = 'AGENT_STOP_YIELDED')
     ORDER BY reason_code`,
    [fixture.namespace.id, owner.id],
  );
  return audit.rows.map(({ reason_code: code }) => code);
}

// A provisioned caller that keeps every fixture grant except delete, so a refusal comes from the
// delete-permission check itself rather than from an unknown identity (finding 1888).
async function deleteDeniedCaller(fixture, label) {
  const callerId = `${label}-${randomUUID()}`;
  await fixture.copyActorGrants(callerId, { withoutActions: ["delete"] });
  return callerId;
}

function deleteDenied(resource) {
  return {
    name: "AuthorizationDeniedError",
    message: "No explicit scoped binding grants the exact action and resource.",
    authorization: { action: "delete", resource },
  };
}

test(
  "an Agent stop yields to due work during its Gateway drain, across a restart and a second stop",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context, { leaseDurationMs: 3_000 });
    const { owner, candidate } = await fixture.admitInitialRevision("drain-yield");
    const drainMs = 6_000;
    const { compute, record } = gatewayDrainCompute(fixture, [owner], { drainMs });
    const events = [];
    const emit = (event) => events.push({ ...event, at: Date.now() });
    await fixture.start(compute, { emit });
    await fixture.work(candidate, "succeeded");
    const busy = await fixture.revision(await fixture.agent("drain-yield-busy"), 1);
    record.busy.add(busy.id);

    // The stop's first pass yields, and the other Agent's deployment runs while the stop waits for
    // the drain. The ordering checks below prove both, so a stop that does not yield fails there
    // with its timeline. The 30 s waits only guard against a hang.
    const first = await fixture.requestStop(owner);
    const firstPass = await waitFor(
      "the stop's first pass",
      async () => stopPasses(events, first)[0],
      30_000,
    );
    await waitFor(
      "another Agent's pass after the stop's first pass",
      async () =>
        events.some(
          ({ event, workId, at }) =>
            event === "worker.completed" && workId === busy.idempotencyKey && at > firstPass.at,
        ) || undefined,
      30_000,
    );
    // A second stop while the first is deferred, and a controller restart. The restart lands
    // between passes or interrupts one (which then waits out its lease); either path must end.
    const second = await fixture.requestStop(owner);
    await fixture.stop();
    await fixture.start(compute, { emit });
    const [firstWork, secondWork] = await Promise.all([
      fixture.work(first, "succeeded", 30_000),
      fixture.work(second, "succeeded", 30_000),
    ]);
    await Promise.all([first, second].map((stop) => completedPasses(events, stop)));

    // Same-run ordering, not a wall-clock total (finding 1344). The worker is serial, so another
    // Agent's pass ends inside the drain only if a stop pass ended during it, which a yield does
    // (no pass failed, checked below). The stops end after the drain, and less than another drain
    // after its end: a pass cut short by the restart waits out its 3 s lease, and a deferred stop
    // rechecks within about 1 s. A stop that waited out a drain, a default lease or a long retry
    // backoff of its own would end later.
    const { drainStartedAt, drainEndsAt } = record;
    const offset = (time) => (time === undefined ? "none" : `${time - drainStartedAt}`);
    const otherPasses = events
      .filter(({ event, workId }) => event === "worker.completed" && workId === busy.idempotencyKey)
      .map((event) => event.at);
    const stopEnds = [first, second].map(
      (stop) => stopPasses(events, stop).find(({ outcome }) => outcome === "success")?.at,
    );
    const timeline = [
      `drain 0..${offset(drainEndsAt)} ms`,
      ...[first, second].map(
        (stop, index) =>
          `stop ${index + 1} ${stopPasses(events, stop)
            .map(({ code, at }) => `${code}@${offset(at)}`)
            .join(" ")}`,
      ),
      `other Agent's passes @${otherPasses.map(offset).join(",")}`,
    ].join("; ");
    assert.ok(
      otherPasses.some((time) => time > drainStartedAt && time < drainEndsAt),
      `no other Agent's pass ended during the drain: ${timeline}`,
    );
    assert.ok(
      stopEnds.every((time) => time >= drainEndsAt),
      `a stop ended before the drain: ${timeline}`,
    );
    assert.ok(
      Math.max(...stopEnds) - drainEndsAt < drainMs,
      `the stops ended a drain or more after it: ${timeline}`,
    );
    assert.equal(firstPass.code, "AGENT_STOP_YIELDED", timeline);
    assert.equal(firstPass.outcome, "pending");
    // Yields refund their attempt; only a pass cut short by the restart may count.
    assert.ok(firstWork.attempt_count <= 2, `attempts ${firstWork.attempt_count}`);
    assert.ok(secondWork.attempt_count <= 2, `attempts ${secondWork.attempt_count}`);
    // The active pointer stays until the Harness is stopped after the drain, then clears.
    assert.deepEqual([...record.pointers], [candidate.id]);
    assert.ok(record.harnessStops.length >= 1);
    const current = await fixture.currentAgent(owner);
    assert.equal(current.desiredRuntimeState, "stopped");
    assert.equal(current.activeRevisionId, undefined);
    // A yield is neither audited nor recorded as evidence; each stop records one outcome, and
    // no pass of either stop failed.
    assert.deepEqual(await stopAudit(fixture, owner), ["AGENT_ALREADY_STOPPED", "AGENT_STOPPED"]);
    for (const stop of [first, second]) {
      assert.ok(stopPasses(events, stop).every(({ code }) => code !== "DEPENDENCY_UNAVAILABLE"));
    }
    // The yield names the revision whose Gateway drains.
    assert.equal(firstPass.revisionId, candidate.id);
  },
);

revisionTest(
  "a stopped Agent's candidate work and its multi-revision stop both yield during the drain",
  async (fixture) => {
    const { owner, candidate } = await fixture.admitInitialRevision("drain-candidate");
    const { compute, busy, record } = gatewayDrainCompute(fixture, [owner], { drainMs: 8_000 });
    const events = [];
    await fixture.start(compute, { emit: (event) => events.push(event) });
    await fixture.work(candidate, "succeeded");
    // A replacement that never becomes ready, and another Agent's deployment that keeps Work due.
    const replacement = await fixture.revision(owner, 2);
    busy.add(replacement.id);
    const other = await fixture.revision(await fixture.agent("drain-candidate-busy"), 1);
    busy.add(other.id);
    await waitFor(
      "the replacement to wait for readiness",
      async () =>
        events.some(
          ({ event, workId }) =>
            event === "worker.completed" && workId === replacement.idempotencyKey,
        ) || undefined,
    );
    const stop = await fixture.requestStop(owner);
    await Promise.all([
      fixture.work(stop, "succeeded", 30_000),
      fixture.work(replacement, "succeeded", 30_000),
    ]);
    const [replacementPasses, stopWorkPasses] = await Promise.all(
      [replacement, stop].map((work) => completedPasses(events, work)),
    );
    // The replacement's own work stopped it as a stopped Agent's revision, and yielded while the
    // Gateway drained instead of spending its attempts.
    const replacementCodes = replacementPasses.map(({ code }) => code);
    assert.ok(replacementCodes.includes("AGENT_STOP_YIELDED"), replacementCodes.join(", "));
    assert.equal(replacementCodes.at(-1), "REVISION_STOPPED");
    assert.ok(!replacementCodes.includes("DEPENDENCY_UNAVAILABLE"), replacementCodes.join(", "));
    // The stop's retries reached both revisions; Harnesses stop only after the drain.
    assert.ok(record.yields >= 1);
    assert.deepEqual(
      [...new Set(record.harnessStops)].sort(),
      [candidate.id, replacement.id].sort(),
    );
    assert.deepEqual([...record.pointers], [candidate.id]);
    assert.equal((await fixture.currentAgent(owner)).activeRevisionId, undefined);
    assert.equal(stopWorkPasses.at(-1).code, "AGENT_STOPPED");
    assert.deepEqual(
      stopWorkPasses.map(({ code }) => code).filter((code) => code !== "AGENT_STOP_YIELDED"),
      ["AGENT_STOPPED"],
    );
  },
);

// Finding 1093: two draining stops were each other's due Work, so they took turns, each pass
// repeating the whole stop, for the whole drain. A stop now yields to the other's first pass
// (real Work: it starts that Gateway's drain) but not to its rechecks.
revisionTest(
  "two Agents stopping at once do not take turns during their drains",
  async (fixture) => {
    const first = await fixture.admitInitialRevision("drain-pair-a");
    const second = await fixture.admitInitialRevision("drain-pair-b");
    const { compute, records } = gatewayDrainCompute(fixture, [first.owner, second.owner], {
      drainMs: 6_000,
    });
    const events = [];
    await fixture.start(compute, { emit: (event) => events.push(event) });
    await Promise.all([
      fixture.work(first.candidate, "succeeded"),
      fixture.work(second.candidate, "succeeded"),
    ]);
    const stops = [await fixture.requestStop(first.owner), await fixture.requestStop(second.owner)];
    await Promise.all(stops.map((stop) => fixture.work(stop, "succeeded", 30_000)));
    const passes = await Promise.all(stops.map((stop) => completedPasses(events, stop)));
    // The drains overlap: one starts before the other ends. Drains taken in turn, each stop
    // holding the serial worker for its whole drain, start the second only after the first ends.
    // Same-run ordering, not a wall-clock total (finding 1344); 30 s only guards against a hang.
    const drains = [first, second].map(({ owner }) => records.get(owner.id));
    const origin = Math.min(...drains.map(({ drainStartedAt }) => drainStartedAt));
    assert.ok(
      Math.max(...drains.map(({ drainStartedAt }) => drainStartedAt)) <
        Math.min(...drains.map(({ drainEndsAt }) => drainEndsAt)),
      `the drains ran in turn: ${drains
        .map(
          ({ drainStartedAt, drainEndsAt }) =>
            `${drainStartedAt - origin}..${drainEndsAt - origin} ms`,
        )
        .join(", ")}`,
    );
    // Taking turns yields about once a second per stop (3 each in a CI mutation run); now only
    // the stop that runs first yields, once, to the other's first pass (2 tolerates one more).
    const yields = [first, second].map(({ owner }) => records.get(owner.id).yields);
    assert.ok(yields[0] + yields[1] <= 2, `yields ${yields.join(", ")}`);
    for (const { owner } of [first, second]) {
      assert.ok(records.get(owner.id).calls <= 3, `calls ${records.get(owner.id).calls}`);
    }
    for (const { owner, candidate } of [first, second]) {
      const record = records.get(owner.id);
      assert.deepEqual(record.harnessStops, [candidate.id]);
      assert.deepEqual([...record.pointers], [candidate.id]);
      assert.equal((await fixture.currentAgent(owner)).activeRevisionId, undefined);
    }
    for (const stopWorkPasses of passes) {
      assert.deepEqual(
        stopWorkPasses.map(({ code }) => code).filter((code) => code !== "AGENT_STOP_YIELDED"),
        ["AGENT_STOPPED"],
      );
    }
  },
);

// Finding 1094: every yield wrote a `worker.completed` line, up to about 300 per stop. The first
// is logged, then at most one a minute (the rule's clock is in the stop-yields conformance test).
revisionTest(
  "a draining stop that keeps yielding to real Work logs its first yield only",
  async (fixture) => {
    const { owner, candidate } = await fixture.admitInitialRevision("drain-log");
    const { compute, record } = gatewayDrainCompute(fixture, [owner], { drainMs: 6_000 });
    const events = [];
    await fixture.start(compute, { emit: (event) => events.push(event) });
    await fixture.work(candidate, "succeeded");
    // Another Agent's deployment never becomes ready, so its rechecks keep Work due: real Work
    // still preempts the drain each time.
    const busy = await fixture.revision(await fixture.agent("drain-log-busy"), 1);
    record.busy.add(busy.id);
    const stop = await fixture.requestStop(owner);
    await fixture.work(stop, "succeeded", 30_000);
    assert.ok(record.yields >= 2, `yields ${record.yields}`);
    const passes = await completedPasses(events, stop);
    // The completion carries the count of every yield, logged or not.
    assert.deepEqual(
      passes.map(({ code, stopYields }) => [code, stopYields]),
      [
        ["AGENT_STOP_YIELDED", 1],
        ["AGENT_STOPPED", record.yields],
      ],
    );
    assert.ok(
      events.some(
        ({ event, workId }) => event === "worker.completed" && workId === busy.idempotencyKey,
      ),
    );
    assert.deepEqual(record.harnessStops, [candidate.id]);
  },
);

for (const change of ["redeploy", "deletion"]) {
  revisionTest(
    `a ${change} while an Agent stop is yielded supersedes the stop`,
    async (fixture) => {
      const { owner, candidate } = await fixture.admitInitialRevision(`drain-${change}`);
      // The drain outlasts the test: only the change ends the stop.
      const { compute, record } = gatewayDrainCompute(fixture, [owner], { drainMs: 120_000 });
      const events = [];
      await fixture.start(compute, { emit: (event) => events.push(event) });
      await fixture.work(candidate, "succeeded");
      const busy = await fixture.revision(await fixture.agent(`drain-${change}-busy`), 1);
      record.busy.add(busy.id);
      const stop = await fixture.requestStop(owner);
      await waitFor(
        "the stop to yield",
        async () =>
          stopPasses(events, stop).some(({ code }) => code === "AGENT_STOP_YIELDED") || undefined,
      );

      if (change === "redeploy") {
        const redeployed = await fixture.revision(owner, 2);
        await fixture.work(redeployed, "succeeded", 30_000);
        await fixture.work(stop, "succeeded", 30_000);
        const current = await fixture.currentAgent(owner);
        assert.equal(current.desiredRuntimeState, "running");
        assert.equal(current.activeRevisionId, redeployed.id);
        assert.equal(record.calls, 1, "the superseded stop is not repeated");
        assert.deepEqual(await stopAudit(fixture, owner), ["STOP_SUPERSEDED"]);
      } else {
        await fixture.requestDeletion(owner);
        await waitFor(
          "the Agent and its stop work to be removed",
          async () => {
            const remaining = await fixture.observerPool.query(
              "SELECT 1 FROM occ.controller_work WHERE idempotency_key = $1",
              [stop.idempotencyKey],
            );
            return (await fixture.currentAgent(owner)) === undefined && remaining.rowCount === 0
              ? true
              : undefined;
          },
          30_000,
        );
        // Quiet: one logged yield, and no failed pass or failure audit for the deleted Agent.
        assert.deepEqual(await stopAudit(fixture, owner), []);
        assert.deepEqual(
          stopPasses(events, stop).map(({ code }) => code),
          ["AGENT_STOP_YIELDED"],
        );
      }
      // While yielded the Harness kept running and the pointer named it.
      assert.deepEqual(record.harnessStops, []);
      assert.deepEqual([...record.pointers], [candidate.id]);
      assert.ok(stopPasses(events, stop).every(({ code }) => code !== "DEPENDENCY_UNAVAILABLE"));
    },
  );
}

test(
  "an Agent stop older than the convergence deadline keeps its full Gateway wait",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const { owner, candidate } = await fixture.admitInitialRevision("drain-old");
    const { compute, record } = gatewayDrainCompute(fixture, [owner], {
      drainMs: 2_000,
      async onFirstStop() {
        // Another Agent's Work is due during the whole drain.
        const other = await fixture.revision(await fixture.agent("drain-old-other"), 1);
        record.busy.add(other.id);
        await waitFor("the other Agent's Work to be due", async () =>
          (await computeWorkWaiting()) ? true : undefined,
        );
      },
    });
    await fixture.start(compute);
    await fixture.work(candidate, "succeeded");
    await fixture.stop();
    const stop = await fixture.requestStop(owner);
    await delay(1_500);
    const events = [];
    await fixture.start(compute, {
      convergenceTimeoutMs: 1_000,
      emit: (event) => events.push(event),
    });
    await fixture.work(stop, "succeeded", 30_000);
    // Past the deadline the stop no longer yields, so its deferrals cannot outlast a drain that
    // never ends: it waits as before, in one pass.
    assert.equal(record.yields, 0);
    assert.equal(record.waitingWithoutYield, true);
    assert.equal(record.calls, 1);
    assert.deepEqual(
      (await completedPasses(events, stop)).map(({ code }) => code),
      ["AGENT_STOPPED"],
    );
    assert.equal((await fixture.currentAgent(owner)).activeRevisionId, undefined);
  },
);

// Finding 1090: a deployment whose Agent stopped while the deployment's own pass ran stopped its
// candidate with the full Gateway wait: during preparation, before the commit (Compute that
// activates first), or after the pointer commit. Each now yields like a stopped Agent's stop, and
// its next pass repeats the stop as the stopped Agent's revision.
for (const moment of ["preparation", "commit", "activation"]) {
  revisionTest(
    `a deployment whose Agent stops during its ${moment} yields that stop during the drain`,
    async (fixture) => {
      const owner = await fixture.agent(`drain-${moment}`);
      const drain = gatewayDrainCompute(fixture, [owner], { drainMs: 5_000 });
      let candidate;
      let stop;
      const requestStop = async () => {
        stop ??= await fixture.requestStop(owner);
      };
      const compute = {
        ...drain.compute,
        async prepareRevision(revision) {
          const observation = await drain.compute.prepareRevision(revision);
          if (moment === "preparation" && revision.id === candidate?.id) {
            await requestStop();
          }
          return observation;
        },
        ...(moment === "commit"
          ? {
              activationOrder: "beforeCommit",
              async activateRevision(revision) {
                if (revision.id === candidate?.id) {
                  await requestStop();
                }
              },
            }
          : {}),
      };
      const events = [];
      await fixture.start(compute, { emit: (event) => events.push(event) });
      if (moment === "activation") {
        // The stop is admitted right after the pass commits the candidate's pointer.
        const worker = [...fixture.database.workers].at(-1);
        const transactWithQueue = worker.state.transactWithQueue.bind(worker.state);
        worker.state.transactWithQueue = async (work, options) => {
          const result = await transactWithQueue(work, options);
          if (
            candidate !== undefined &&
            stop === undefined &&
            (await fixture.currentAgent(owner))?.activeRevisionId === candidate.id
          ) {
            await requestStop();
          }
          return result;
        };
      }
      const busy = await fixture.revision(await fixture.agent(`drain-${moment}-busy`), 1);
      drain.busy.add(busy.id);
      candidate = await fixture.revision(owner, 1);
      const done = await fixture.work(candidate, "succeeded", 30_000);
      assert.ok(stop !== undefined, "the stop was admitted during the pass");
      await fixture.work(stop, "succeeded", 30_000);
      // Both works drain the same Gateway, so the stop can finish first.
      const passes = (await completedPasses(events, candidate)).map(({ code }) => code);
      assert.ok(passes.includes("AGENT_STOP_YIELDED"), passes.join(", "));
      assert.equal(passes.at(-1), "REVISION_STOPPED");
      assert.ok(!passes.includes("DEPENDENCY_UNAVAILABLE"), passes.join(", "));
      assert.ok(done.attempt_count <= 1, `attempts ${done.attempt_count}`);
      // The Harness stopped only after the drain, and the Agent ends stopped with no pointer.
      assert.ok(drain.record.yields >= 1);
      assert.deepEqual([...new Set(drain.record.harnessStops)], [candidate.id]);
      const current = await fixture.currentAgent(owner);
      assert.equal(current.desiredRuntimeState, "stopped");
      assert.equal(current.activeRevisionId, undefined);
    },
  );
}

for (const recovery of [false, true]) {
  revisionTest(
    `fresh worker binds SSH ownership before ${recovery ? "stopped revision recovery" : "Agent stop"}`,
    async (fixture) => {
      const owner = await fixture.agent("cold-stop", { auth: "runtime" });
      let candidate = await fixture.revision(owner, 1);
      await fixture.start(fixture.compute);
      await fixture.work(candidate, "succeeded");
      await fixture.stop();
      if (recovery) {
        const previous = candidate;
        candidate = await fixture.revision(owner, 2);
        // A worker can exit after publication but before completing revision work.
        await fixture.state.transact((unit) =>
          unit.agents.compareAndSetActiveRevision(
            fixture.namespace.id,
            owner.id,
            previous.id,
            candidate.id,
          ),
        );
      }
      const stop = await fixture.requestStop(owner);
      const operations = [];
      // Exercise the bundled SSH Driver's actual cold binding validation. Only
      // remote SSH execution is controlled; the queue and worker use PostgreSQL.
      const cold = await coldSshComputeDriver(fixture, operations);
      await fixture.start(
        {
          ...fixture.compute,
          bindAgent: cold.bindAgent.bind(cold),
          stopRevision: cold.stopRevision.bind(cold),
          retireRevision: cold.retireRevision.bind(cold),
        },
        { pool: fixture.createWorkerPool() },
      );
      if (recovery) {
        assert.equal((await fixture.work(candidate, "succeeded")).attempt_count, 1);
      }
      assert.equal((await fixture.work(stop, "succeeded")).attempt_count, 1);
      const current = await fixture.currentAgent(owner);
      assert.equal(current.activeRevisionId, undefined);
      assert.equal(current.desiredRuntimeState, "stopped");
      assert.ok(operations.some((op) => op.operation === "stop-revision"));
      assert.ok(
        operations.every(
          (op) => op.namespace.id === fixture.namespace.id && op.revision.agentId === owner.id,
        ),
      );
      if (recovery) {
        assert.ok(operations.some((op) => op.operation === "retire-revision"));
      }
    },
  );
}

revisionTest("fresh worker binds SSH ownership before Agent deletion", async (fixture) => {
  const { owner, candidate } = await fixture.admitInitialRevision("cold-delete", {
    agent: { auth: "runtime" },
  });
  await fixture.start(fixture.compute);
  await fixture.work(candidate, "succeeded");
  await fixture.stop();

  // Deletion is admitted while the Agent is running, then a fresh worker must
  // reconstruct the SSH binding before it can retire the persisted revision.
  await fixture.requestDeletion(owner);
  const operations = [];
  const cold = await coldSshComputeDriver(fixture, operations);
  await fixture.start(
    {
      ...fixture.compute,
      bindAgent: cold.bindAgent.bind(cold),
      retireRevision: cold.retireRevision.bind(cold),
    },
    { pool: fixture.createWorkerPool() },
  );

  await waitFor(`Agent ${owner.id} deletion to complete`, async () => {
    const deleted = await fixture.currentAgent(owner);
    return deleted === undefined ? true : undefined;
  });
  const audit = await fixture.observerPool.query(
    `SELECT (details->>'attemptCount')::integer AS attempt_count
       FROM occ.audit_events
       WHERE namespace_id = $1 AND resource_id = $2
         AND action = 'openclaw.agents.lifecycle.delete' AND outcome = 'success'`,
    [fixture.namespace.id, owner.id],
  );
  assert.deepEqual(audit.rows, [{ attempt_count: 1 }]);
  assert.deepEqual(
    operations.map(({ operation }) => operation),
    ["retire-revision"],
  );
  assert.ok(
    operations.every(
      (operation) =>
        operation.namespace.id === fixture.namespace.id && operation.revision.agentId === owner.id,
    ),
  );
});

test(
  "a repository cleanup stuck on an invalidated attempt logs its cause once and backs off",
  requiresPostgres,
  async (context) => {
    const repository = repositoryBoundary({ count: 2 });
    // The production default; the fixture's hour-long interval would hide the backoff.
    repository.driver.maintenanceIntervalMs = 30_000;
    const fixture = await setup(context, { repoDriver: repository.driver });
    const { owner, candidate } = await fixture.admitInitialRevision("cleanup-invalidated", {
      revision: { repositoryCredentials: repository.snapshot },
    });
    const events = [];
    await fixture.start(fixture.compute, { emit: (event) => events.push(event) });
    await fixture.work(candidate, "succeeded");
    const [attempt, sibling] = await repositoryAttempts(fixture, candidate);
    // An invalidated attempt has no outgoing transition, so no pass can settle this cleanup.
    await fixture.observerPool.query(
      `UPDATE occ.repository_session_attempts
       SET phase = 'invalidated', updated_at = clock_timestamp()
       WHERE admission_id = $1`,
      [attempt.admissionId],
    );
    const cleanupKey = `agent_revision:${candidate.id}:repository_cleanup:${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
    await fixture.observerPool.query(
      `INSERT INTO occ.controller_work
         (idempotency_key, namespace_id, agent_id, revision_id, actor_id,
          namespace_target, agent_target, state, available_at, attempt_count, created_at,
          updated_at)
       VALUES ($1, $2, $3, $4, $5, NULL, NULL, 'queued',
          clock_timestamp(), 0, clock_timestamp() - interval '1 day', clock_timestamp())`,
      [cleanupKey, fixture.namespace.id, owner.id, candidate.id, fixture.actor.id],
    );
    const deferred = async (passes) =>
      waitFor(`cleanup pass ${passes} to defer`, async () => {
        const completed = events.filter(
          (event) => event.event === "worker.completed" && event.workId === cleanupKey,
        );
        if (completed.length < passes) {
          return undefined;
        }
        const { rows } = await fixture.observerPool.query(
          `SELECT state, EXTRACT(EPOCH FROM (available_at - updated_at)) * 1000 AS delay_ms
           FROM occ.controller_work WHERE idempotency_key = $1`,
          [cleanupKey],
        );
        return rows[0]?.state === "queued" ? rows[0] : undefined;
      });
    // A day-old stuck cleanup rechecks every 10 minutes, not every 30 s.
    const first = await deferred(1);
    assert.ok(Number(first.delay_ms) >= 590_000, `delay ${first.delay_ms} ms`);
    await makeWorkDue(fixture.observerPool, cleanupKey);
    await deferred(2);
    // The cause is logged once, not on every recheck.
    assert.deepEqual(
      events
        .filter(
          (event) =>
            event.event === "worker.repository-cleanup-warning" && event.workId === cleanupKey,
        )
        .map(({ code, cause }) => ({ code, cause })),
      [{ code: "REPOSITORY_CLEANUP_STALLED", cause: "REPOSITORY_ATTEMPT_INVALIDATED" }],
    );
    // A session still closing keeps the configured cadence, even next to an invalidated one.
    repository.driver.close = async () => {
      throw new Error("REPOSITORY_BROKER_UNAVAILABLE");
    };
    await fixture.observerPool.query(
      `UPDATE occ.repository_session_attempts
       SET phase = 'closing', updated_at = clock_timestamp()
       WHERE admission_id = $1`,
      [sibling.admissionId],
    );
    await makeWorkDue(fixture.observerPool, cleanupKey);
    const closing = await deferred(3);
    assert.ok(Number(closing.delay_ms) < 60_000, `delay ${closing.delay_ms} ms`);
    // Retain the unsettled obligation while keeping it out of later scheduling.
    await fixture.observerPool.query(
      "UPDATE occ.controller_work SET available_at = 'infinity' WHERE idempotency_key = $1",
      [cleanupKey],
    );
    await fixture.stop();
  },
);

test(
  "Agent deletion completes with unresolved repository sessions retained as evidence",
  requiresPostgres,
  async (context) => {
    const repository = repositoryBoundary({ count: 2 });
    // Release blocked broker calls before setup's worker shutdown hook, including on failure.
    const cleanupBarrier = Promise.withResolvers();
    context.after(() => cleanupBarrier.resolve());
    const fixture = await setup(context, { repoDriver: repository.driver });
    const pendingOwner = await fixture.agent("delete-repository-unresolved");
    const missingOwner = await fixture.agent("delete-repository-missing");
    const pendingRevision = await fixture.revision(pendingOwner, 1, {
      repositoryCredentials: repository.snapshot,
    });
    const missingRevision = await fixture.revision(missingOwner, 1);
    const close = repository.driver.close.bind(repository.driver);
    repository.driver.close = async (...args) => {
      await cleanupBarrier.promise;
      return close(...args);
    };
    await fixture.start(fixture.compute);
    await Promise.all([
      fixture.work(pendingRevision, "succeeded"),
      fixture.work(missingRevision, "succeeded"),
    ]);
    const opened = await repositoryAttempts(fixture, pendingRevision);
    assert.deepEqual(
      opened.map(({ phase, liveRevisionId }) => ({ phase, liveRevisionId })),
      [
        { phase: "open", liveRevisionId: pendingRevision.id },
        { phase: "open", liveRevisionId: pendingRevision.id },
      ],
    );
    await fixture.observerPool.query(
      `UPDATE occ.repository_session_attempts
       SET phase = 'invalidated', updated_at = clock_timestamp()
       WHERE admission_id = $1`,
      [opened[0].admissionId],
    );
    // A prepared admission without a broker receipt can be fenced as missing after deletion.
    const missingAdmissionId = `missing-${randomUUID()}`;
    await fixture.observerPool.query(
      `INSERT INTO occ.repository_session_attempts
         (namespace_id, agent_id, revision_id, repository_ref, admission_id,
          duration_seconds, deadline_wall_ms, phase, session_id, created_at, updated_at,
          broker_protocol)
       VALUES ($1, $2, $3, $4, $5, 60, $6, 'opening', NULL, clock_timestamp(),
          clock_timestamp(), 3)`,
      [
        fixture.namespace.id,
        pendingOwner.id,
        pendingRevision.id,
        repository.snapshot.bindings[0].repositoryRef,
        missingAdmissionId,
        repository.snapshot.deadlineWallMs,
      ],
    );
    await fixture.stop();
    await fixture.requestDeletion(pendingOwner);
    await fixture.requestDeletion(missingOwner);
    const retireCleanupKey = `agent_revision:${pendingRevision.id}:repository_cleanup:retire:${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
    await fixture.observerPool.query(
      `INSERT INTO occ.controller_work
         (idempotency_key, namespace_id, agent_id, revision_id, actor_id,
          namespace_target, agent_target, state, available_at, attempt_count, created_at,
          updated_at)
       VALUES ($1, $2, $3, $4, $5, NULL, NULL, 'queued',
          clock_timestamp(), 0, clock_timestamp(), clock_timestamp())`,
      [
        retireCleanupKey,
        fixture.namespace.id,
        pendingOwner.id,
        pendingRevision.id,
        fixture.actor.id,
      ],
    );
    await fixture.start(fixture.compute);
    await waitFor("Agent deletion to finish despite unresolved repository sessions", async () =>
      (await fixture.currentAgent(pendingOwner)) === undefined &&
      (await fixture.currentAgent(missingOwner)) === undefined
        ? true
        : undefined,
    );
    await Promise.all([
      fixture.requestDeletion(pendingOwner).then(
        () => assert.fail("repeated DELETE after completion should not recreate the Agent"),
        (error) => assert.match(error.message, /exact Namespace/),
      ),
      fixture.requestDeletion(missingOwner).then(
        () => assert.fail("repeated DELETE after completion should not recreate the Agent"),
        (error) => assert.match(error.message, /exact Namespace/),
      ),
    ]);

    const retained = await repositoryAttempts(fixture, pendingRevision);
    assert.deepEqual(
      retained.map(({ phase, liveRevisionId, cleanupContext }) => ({
        phase,
        liveRevisionId,
        repositoryRef: cleanupContext.binding.repositoryRef,
      })),
      [
        {
          phase: "invalidated",
          liveRevisionId: null,
          repositoryRef: repository.snapshot.bindings[0].repositoryRef,
        },
        {
          phase: "closing",
          liveRevisionId: null,
          repositoryRef: repository.snapshot.bindings[1].repositoryRef,
        },
        {
          phase: "closing",
          liveRevisionId: null,
          repositoryRef: repository.snapshot.bindings[0].repositoryRef,
        },
      ],
    );
    await waitFor("retained runtime cleanup to claim without live owner", async () => {
      const { rows } = await fixture.observerPool.query(
        `SELECT agent_id, revision_id, state
         FROM occ.controller_work
         WHERE idempotency_key = $1`,
        [retireCleanupKey],
      );
      return rows[0]?.agent_id === null &&
        rows[0]?.revision_id === null &&
        rows[0]?.state === "claimed"
        ? true
        : undefined;
    });
    assert.equal(
      retained.some(({ phase }) => phase === "disposed"),
      false,
      "deletion must not fabricate disposal for unresolved repository sessions",
    );
    const retainedCounts = await fixture.observerPool.query(
      `SELECT
         (SELECT count(*)::integer FROM occ.repository_session_attempts
          WHERE agent_id = $1) AS attempts,
         (SELECT count(*)::integer FROM occ.agent_revisions
          WHERE agent_id IN ($1, $2)) AS revisions,
         (SELECT count(*)::integer FROM occ.controller_work
          WHERE agent_id IN ($1, $2) OR idempotency_key LIKE $3) AS work`,
      [
        pendingOwner.id,
        missingOwner.id,
        `agent_revision:${pendingRevision.id}:repository_cleanup:%`,
      ],
    );
    assert.deepEqual(retainedCounts.rows, [{ attempts: 3, revisions: 0, work: 2 }]);
    // Cleanup is still claimed behind the provider barrier. It must not be
    // mistaken for a deployment merely because its live owners were deleted.
    const whileClaimed = await fixture.controller.getInstallationDeploymentInventory(
      fixture.actor.id,
    );
    assert.deepEqual(
      whileClaimed.namespaces.find(({ id }) => id === fixture.namespace.id).agents,
      [],
    );
    cleanupBarrier.resolve();
    let missing;
    await waitFor("retained repository cleanup to run after Agent deletion", async () => {
      const afterCleanup = await repositoryAttempts(fixture, pendingRevision);
      missing = await fixture.state.read((view) =>
        view.repositorySessions.findAttempt(missingAdmissionId),
      );
      if (
        missing.phase !== "closing" &&
        afterCleanup.some(
          ({ phase, repositoryRef, liveRevisionId }) =>
            repositoryRef === repository.snapshot.bindings[1].repositoryRef &&
            phase === "disposed" &&
            liveRevisionId === null,
        )
      ) {
        return true;
      }
      // Incomplete cleanup defers by the boundary Driver's hourly interval.
      await advanceCleanupRetries(fixture, pendingRevision);
      return undefined;
    });
    assert.equal(missing.phase, "invalidated");
    assert.equal(missing.liveRevisionId, null);
    assert.equal(missing.sessionId, undefined);

    // Deletion finished while cleanup remained unresolved. Inventory lists live
    // Agents without settling or hiding the durable cleanup obligation.
    await fixture.stop();
    const readCleanup = async () => {
      const { rows } = await fixture.observerPool.query(
        "SELECT agent_id, revision_id, state FROM occ.controller_work WHERE idempotency_key = $1",
        [retireCleanupKey],
      );
      return rows;
    };
    const cleanupBeforeInventory = await readCleanup();
    assert.deepEqual(cleanupBeforeInventory, [
      { agent_id: null, revision_id: null, state: "queued" },
    ]);
    const inventory = await fixture.controller.getInstallationDeploymentInventory(fixture.actor.id);
    assert.deepEqual(inventory.namespaces.find(({ id }) => id === fixture.namespace.id).agents, []);
    assert.deepEqual(await readCleanup(), cleanupBeforeInventory);
  },
);

test(
  "deployment inventory survives retained completed repository cleanup and preserves deployment guards",
  requiresPostgres,
  async (context) => {
    const repository = repositoryBoundary();
    const fixture = await setup(context, { repoDriver: repository.driver });
    const { owner, candidate } = await fixture.admitInitialRevision("inventory-deleted", {
      revision: { repositoryCredentials: repository.snapshot },
    });
    const sibling = await fixture.agent("inventory-live");
    const live = await fixture.revision(sibling, 1);
    await fixture.start(fixture.compute);
    await Promise.all([fixture.work(candidate, "succeeded"), fixture.work(live, "succeeded")]);
    const stop = await fixture.requestStop(owner);
    await fixture.work(stop, "succeeded");
    await waitFor("cleanup to complete while its revision still exists", async () => {
      const cleanup = await fixture.observerPool.query(
        `SELECT state FROM occ.controller_work WHERE revision_id = $1 AND idempotency_key LIKE $2`,
        [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:%`],
      );
      return cleanup.rowCount > 0 && cleanup.rows.every(({ state }) => state === "succeeded")
        ? true
        : undefined;
    });
    const beforeDeletion = await fixture.controller.getInstallationDeploymentInventory(
      fixture.actor.id,
    );
    assert.deepEqual(
      beforeDeletion.namespaces
        .find(({ id }) => id === fixture.namespace.id)
        .agents.map(({ id }) => id)
        .sort(),
      [owner.id, sibling.id].sort(),
    );
    await fixture.requestDeletion(owner);
    await waitFor("Agent deletion and its independent cleanup to finish", async () => {
      const cleanup = await fixture.observerPool.query(
        `SELECT agent_id, revision_id, namespace_target, agent_target, state
         FROM occ.controller_work WHERE namespace_id = $1 AND idempotency_key LIKE $2`,
        [fixture.namespace.id, `agent_revision:${candidate.id}:repository_cleanup:%`],
      );
      return (await fixture.currentAgent(owner)) === undefined &&
        cleanup.rowCount > 0 &&
        cleanup.rows.every((row) => row.state === "succeeded")
        ? cleanup.rows
        : undefined;
    });
    await fixture.stop();

    // The production deletion finalizer detaches both owners, retaining the
    // immutable cleanup identity and completion. No historical row is fabricated.
    const retained = await fixture.observerPool.query(
      `SELECT idempotency_key, agent_id, revision_id, namespace_target, agent_target, state
       FROM occ.controller_work WHERE namespace_id = $1 AND idempotency_key LIKE $2
       ORDER BY idempotency_key`,
      [fixture.namespace.id, `agent_revision:${candidate.id}:repository_cleanup:%`],
    );
    assert.ok(retained.rowCount > 0);
    assert.ok(
      retained.rows.every(
        (row) =>
          row.agent_id === null &&
          row.revision_id === null &&
          row.namespace_target === null &&
          row.agent_target === null &&
          row.state === "succeeded",
      ),
    );
    assert.ok(
      (await repositoryAttempts(fixture, candidate)).every(
        ({ phase, liveRevisionId }) => phase === "disposed" && liveRevisionId === null,
      ),
    );
    async function inventoryAgent() {
      const inventory = await fixture.controller.getInstallationDeploymentInventory(
        fixture.actor.id,
      );
      assert.equal(inventory.installationId, fixture.installation.id);
      const namespace = inventory.namespaces.find(({ id }) => id === fixture.namespace.id);
      assert.equal(namespace.status, "ready");
      assert.equal(namespace.agents.length, 1);
      return namespace.agents[0];
    }
    assert.deepEqual(await inventoryAgent(), {
      id: sibling.id,
      status: "active",
      desiredRuntimeState: "running",
      executionMode: "embedded",
      activeRevisionId: live.id,
      deploymentInProgress: false,
    });

    // Completed history must not mask a new deployment of a surviving Agent.
    const replacement = await fixture.revision(sibling, 2);
    assert.equal((await inventoryAgent()).deploymentInProgress, true);
    let preparing = false;
    const release = Promise.withResolvers();
    context.after(() => release.resolve());
    await fixture.start({
      ...fixture.compute,
      async prepareRevision(revision, deploymentContext) {
        if (revision.id === replacement.id) {
          preparing = true;
          await release.promise;
        }
        return fixture.compute.prepareRevision(revision, deploymentContext);
      },
    });
    try {
      await waitFor("replacement deployment to enter Compute", async () =>
        preparing ? true : undefined,
      );
      assert.equal((await inventoryAgent()).deploymentInProgress, true);
    } finally {
      release.resolve();
    }
    await fixture.work(replacement, "succeeded");
    await fixture.stop();
    assert.equal((await inventoryAgent()).activeRevisionId, replacement.id);
    assert.equal((await inventoryAgent()).deploymentInProgress, false);
    const afterInventory = await fixture.observerPool.query(
      `SELECT idempotency_key, agent_id, revision_id, namespace_target, agent_target, state
       FROM occ.controller_work WHERE namespace_id = $1 AND idempotency_key LIKE $2
       ORDER BY idempotency_key`,
      [fixture.namespace.id, `agent_revision:${candidate.id}:repository_cleanup:%`],
    );
    assert.deepEqual(afterInventory.rows, retained.rows);

    // The schema permits this terminal failure state, although the worker
    // normally retries cleanup indefinitely. Inject failure into the real
    // retained record to prove that inventory leaves terminal failure intact.
    const cleanupKey = retained.rows[0].idempotency_key;
    try {
      await fixture.observerPool.query(
        "UPDATE occ.controller_work SET state = 'failed_permanent' WHERE idempotency_key = $1",
        [cleanupKey],
      );
      assert.equal((await inventoryAgent()).deploymentInProgress, false);
      const failed = await fixture.observerPool.query(
        "SELECT state FROM occ.controller_work WHERE idempotency_key = $1",
        [cleanupKey],
      );
      assert.equal(failed.rows[0].state, "failed_permanent");
    } finally {
      await fixture.observerPool.query(
        "UPDATE occ.controller_work SET state = 'succeeded' WHERE idempotency_key = $1",
        [cleanupKey],
      );
    }
  },
);

test(
  "Agent deletion retries teardown, removes owned state, and preserves sibling resources",
  requiresPostgres,
  async (context) => {
    let snapshot;
    const metrics = createOccMetrics("worker", () => snapshot.collect());
    const fixture = await setup(context, { metrics });
    snapshot = new PostgresMetricsSnapshot(fixture.observerPool);
    const owner = await fixture.agent("delete-target");
    const sibling = await fixture.agent("delete-sibling");
    const targetRevision = await fixture.revision(owner, 1);
    const siblingRevision = await fixture.revision(sibling, 1);
    const retiredRevisions = [];
    const deletedCredentialOwners = [];
    let failRetirementOnce = true;
    await fixture.start({
      ...fixture.compute,
      async retireRevision(revision) {
        retiredRevisions.push(revision.id);
        if (revision.id === targetRevision.id && failRetirementOnce) {
          failRetirementOnce = false;
          throw new Error("transient Compute retirement failure");
        }
      },
      async deleteAgentRuntimeCredentials({ agent }) {
        deletedCredentialOwners.push(agent.id);
      },
    });
    await Promise.all([
      fixture.work(targetRevision, "succeeded"),
      fixture.work(siblingRevision, "succeeded"),
    ]);

    // Use an exact Namespace-local role so the binding is realistic and the
    // finalizer must remove it without relying on a foreign-key cascade.
    const revisionRoleId = `role-${randomUUID()}`;
    await fixture.observerPool.query(
      `INSERT INTO occ.iam_roles (id, namespace_id, name, permissions)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        revisionRoleId,
        fixture.namespace.id,
        `Agent revision reader ${randomUUID()}`,
        JSON.stringify([{ action: "read", resourceKind: "agent_revision" }]),
      ],
    );
    await fixture.observerPool.query(
      `INSERT INTO occ.iam_access_bindings
         (id, namespace_id, identity_subject_id, role_id, resource_kind, resource_id)
       VALUES ($1, $2, $3, $4, 'agent_revision', $5)`,
      [
        `binding-${randomUUID()}`,
        fixture.namespace.id,
        owner.servicePrincipalId,
        revisionRoleId,
        targetRevision.id,
      ],
    );
    await fixture.observerPool.query(
      `INSERT INTO occ.iam_restrictions
         (id, namespace_id, action, resource_kind, resource_id, effect)
       VALUES ($1, $2, 'read', 'agent', $3, 'deny')`,
      [`restriction-${randomUUID()}`, fixture.namespace.id, owner.id],
    );
    await fixture.observerPool.query(
      `INSERT INTO occ.apikey
         (id, config_id, reference_id, key, created_at, updated_at)
       VALUES ($1, $2, $3, $4, now(), now())`,
      [randomUUID(), randomUUID(), owner.servicePrincipalId, randomUUID()],
    );

    await fixture.requestDeletion(owner);
    await waitFor(`Agent ${owner.id} to be removed`, async () => {
      const deleted = await fixture.currentAgent(owner);
      return deleted === undefined ? true : undefined;
    });

    await fixture.stop();
    // Deletion passes have their own work kind and record the committed retry
    // and completion, rather than appearing as Namespace errors.
    const exposition = await metrics.exposition();
    assert.match(
      exposition,
      /occ_reconciliation_attempts_total\{[^}]*work_kind="agent_delete"[^}]*outcome="retry"[^}]*\} 1/,
    );
    assert.match(
      exposition,
      /occ_reconciliation_attempts_total\{[^}]*work_kind="agent_delete"[^}]*outcome="success"[^}]*\} 1/,
    );
    assert.doesNotMatch(exposition, /work_kind="namespace_ensure"[^}]*outcome="error"/);

    const [survivingAgent, survivingRevision, survivingConfiguration] = await fixture.state.read(
      async (view) =>
        Promise.all([
          view.agents.findAgent(fixture.namespace.id, sibling.id),
          view.revisions.findRevision(fixture.namespace.id, sibling.id, siblingRevision.id),
          view.configurations.findConfiguration(fixture.namespace.id, owner.configurationId),
        ]),
    );
    assert.equal(survivingAgent?.activeRevisionId, siblingRevision.id);
    assert.equal(survivingRevision?.id, siblingRevision.id);
    assert.equal(survivingConfiguration?.id, owner.configurationId);
    assert.deepEqual(
      retiredRevisions.filter((id) => id === targetRevision.id),
      [targetRevision.id, targetRevision.id],
    );
    assert.equal(retiredRevisions.includes(siblingRevision.id), false);
    assert.deepEqual(
      deletedCredentialOwners.filter((id) => id === owner.id),
      [owner.id],
    );
    assert.equal(deletedCredentialOwners.includes(sibling.id), false);

    const leftovers = await fixture.observerPool.query(
      `SELECT
         (SELECT count(*)::integer FROM occ.agent_revisions
           WHERE namespace_id = $1 AND agent_id = $2) AS revisions,
         (SELECT count(*)::integer FROM occ.iam_identities WHERE id = $3) AS identities,
         (SELECT count(*)::integer FROM occ.iam_access_bindings
           WHERE identity_subject_id = $3 OR resource_id IN ($2, $4)) AS bindings,
         (SELECT count(*)::integer FROM occ.iam_restrictions
           WHERE resource_id IN ($2, $4)) AS restrictions,
         (SELECT count(*)::integer FROM occ.apikey WHERE reference_id = $3) AS api_keys,
         (SELECT count(*)::integer FROM occ.controller_work
           WHERE namespace_id = $1 AND agent_id = $2) AS work`,
      [fixture.namespace.id, owner.id, owner.servicePrincipalId, targetRevision.id],
    );
    assert.deepEqual(leftovers.rows, [
      { revisions: 0, identities: 0, bindings: 0, restrictions: 0, api_keys: 0, work: 0 },
    ]);
    const audit = await fixture.observerPool.query(
      `SELECT outcome, details->>'reasonCode' AS reason_code,
              (details->>'attemptCount')::integer AS attempt_count
       FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.delete'
         AND resource_id = $2`,
      [fixture.namespace.id, owner.id],
    );
    assert.deepEqual(audit.rows, [
      { outcome: "success", reason_code: "AGENT_DELETED", attempt_count: 2 },
    ]);
  },
);

test(
  "repeating Agent deletion recovers exhausted teardown without resetting an active claim",
  requiresPostgres,
  async (context) => {
    const retirement = Promise.withResolvers();
    context.after(() => retirement.resolve());
    const fixture = await setup(context, { maxAttempts: 1 });
    const owner = await fixture.agent("delete-exhausted");
    const sibling = await fixture.agent("delete-retry-sibling");
    const revision = await fixture.revision(owner, 1);
    const siblingRevision = await fixture.revision(sibling, 1);
    let unavailable = true;
    let retirementAttempts = 0;
    await fixture.start({
      ...fixture.compute,
      async retireRevision(target) {
        assert.equal(target.id, revision.id);
        retirementAttempts += 1;
        if (unavailable) {
          throw new Error("Compute temporarily unavailable during teardown");
        }
        await retirement.promise;
      },
    });
    await Promise.all([
      fixture.work(revision, "succeeded"),
      fixture.work(siblingRevision, "succeeded"),
    ]);
    const deletion = await fixture.requestDeletion(owner);
    await fixture.work(deletion, "failed_permanent");
    const observe = () =>
      fixture.state.read((view) => view.operations.findWork(deletion.idempotencyKey));
    const exhausted = await observe();
    assert.equal(exhausted.attemptCount, 1);
    assert.equal(exhausted.reasonCode, "DEPENDENCY_UNAVAILABLE");

    // A rejected caller cannot replenish the worker's attempt budget.
    await assert.rejects(
      fixture.controller.deleteAgent(
        await deleteDeniedCaller(fixture, "unprivileged"),
        fixture.namespace.id,
        owner.id,
      ),
      deleteDenied({ kind: "agent", id: owner.id, namespaceId: fixture.namespace.id }),
    );
    assert.deepEqual(await observe(), exhausted);

    const otherActor = `delete-operator-${randomUUID()}`;
    await fixture.copyActorGrants(otherActor);
    await assert.rejects(
      fixture.controller.deleteAgent(otherActor, fixture.namespace.id, owner.id),
      {
        name: "DeletionRetryOwnedError",
        message: /Only the actor that started this deletion can retry it/,
        initiatingActorId: fixture.actor.id,
        authorization: {
          action: "delete",
          resource: { kind: "agent", id: owner.id, namespaceId: fixture.namespace.id },
        },
      },
    );
    assert.deepEqual(await observe(), exhausted);

    unavailable = false;
    await fixture.requestDeletion(owner);
    const retried = await observe();
    assert.ok(
      ["queued", "claimed"].includes(retried.state),
      "authorized repeated DELETE must requeue the exhausted teardown",
    );
    assert.equal(retried.idempotencyKey, exhausted.idempotencyKey);
    assert.equal(retried.actorId, exhausted.actorId);
    assert.equal(retried.createdAt.getTime(), exhausted.createdAt.getTime());
    assert.equal(retried.reasonCode, undefined);
    await waitFor("retried teardown to hold a live claim", async () => {
      const work = await observe();
      return work.state === "claimed" && retirementAttempts === 2 ? work : undefined;
    });
    const claimed = await observe();
    await Promise.all([fixture.requestDeletion(owner), fixture.requestDeletion(owner)]);
    const repeated = await observe();
    assert.equal(repeated.state, "claimed");
    assert.equal(repeated.claimToken, claimed.claimToken);
    assert.equal(repeated.attemptCount, claimed.attemptCount);

    retirement.resolve();
    await waitFor("retried deletion to remove its Agent", async () =>
      (await fixture.currentAgent(owner)) === undefined ? true : undefined,
    );
    assert.equal(retirementAttempts, 2);
    assert.equal(await observe(), undefined);
    const surviving = await fixture.currentAgent(sibling);
    assert.equal(surviving.activeRevisionId, siblingRevision.id);
    const { rows: ownedAudit } = await fixture.observerPool.query(
      `SELECT action, actor_id AS "actorId", outcome, details FROM occ.audit_events
       WHERE namespace_id = $1 AND resource_id = $2`,
      [fixture.namespace.id, owner.id],
    );
    assert.equal(
      ownedAudit.filter((event) => event.action === "reconcile" && event.outcome === "failure")
        .length,
      1,
      "retry must retain the original failure evidence",
    );
    assert.deepEqual(
      ownedAudit
        .filter((event) => event.action === "openclaw.agents.delete.retry")
        .map((event) => ({
          actorId: event.actorId,
          outcome: event.outcome,
          details: {
            workId: event.details.workId,
            previousAttemptCount: event.details.previousAttemptCount,
            previousReasonCode: event.details.previousReasonCode,
          },
        })),
      [
        {
          actorId: fixture.actor.id,
          outcome: "success",
          details: {
            workId: deletion.idempotencyKey,
            previousAttemptCount: 1,
            previousReasonCode: "DEPENDENCY_UNAVAILABLE",
          },
        },
      ],
    );
  },
);

test(
  "another authorized actor takes over failed Agent deletion once the initiator loses permission",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context, { maxAttempts: 1 });
    const { owner, candidate: revision } = await fixture.admitInitialRevision("delete-takeover");
    let unavailable = true;
    let retirementAttempts = 0;
    await fixture.start({
      ...fixture.compute,
      async retireRevision(target) {
        assert.equal(target.id, revision.id);
        retirementAttempts += 1;
        if (unavailable) {
          throw new Error("Compute temporarily unavailable during teardown");
        }
      },
    });
    await fixture.work(revision, "succeeded");
    const deletion = await fixture.requestDeletion(owner);
    await fixture.work(deletion, "failed_permanent");
    const observe = () =>
      fixture.state.read((view) => view.operations.findWork(deletion.idempotencyKey));
    const exhausted = await observe();
    assert.equal(exhausted.actorId, fixture.actor.id);

    const otherActor = `delete-successor-${randomUUID()}`;
    await fixture.copyActorGrants(otherActor);
    const unprivileged = await deleteDeniedCaller(fixture, "unprivileged");
    // The initiator is offboarded: it no longer holds any access.
    await removeAccessBindings(fixture, fixture.actor.id);
    // A caller without delete permission still cannot take over.
    await assert.rejects(
      fixture.controller.deleteAgent(unprivileged, fixture.namespace.id, owner.id),
      deleteDenied({ kind: "agent", id: owner.id, namespaceId: fixture.namespace.id }),
    );
    assert.deepEqual(await observe(), exhausted);

    unavailable = false;
    await fixture.controller.deleteAgent(otherActor, fixture.namespace.id, owner.id);
    const retried = await observe();
    assert.ok(
      retried === undefined || ["queued", "claimed"].includes(retried.state),
      "an authorized takeover must requeue the exhausted teardown",
    );
    if (retried !== undefined) {
      assert.equal(retried.actorId, otherActor);
      assert.equal(retried.idempotencyKey, exhausted.idempotencyKey);
    }
    await waitFor("taken-over deletion to remove its Agent", async () =>
      (await fixture.currentAgent(owner)) === undefined ? true : undefined,
    );
    assert.equal(retirementAttempts, 2);
    const { rows: retryAudit } = await fixture.observerPool.query(
      `SELECT actor_id AS "actorId", outcome, details FROM occ.audit_events
       WHERE namespace_id = $1 AND resource_id = $2 AND action = 'openclaw.agents.delete.retry'`,
      [fixture.namespace.id, owner.id],
    );
    assert.deepEqual(
      retryAudit.map((event) => ({
        actorId: event.actorId,
        outcome: event.outcome,
        takeover: event.details.takeover,
        previousActorId: event.details.previousActorId,
      })),
      [
        {
          actorId: otherActor,
          outcome: "success",
          takeover: true,
          previousActorId: fixture.actor.id,
        },
      ],
    );
  },
);

revisionTest(
  "repeating Namespace deletion recovers a teardown that exceeded its convergence deadline",
  async (fixture) => {
    const namespace = {
      id: `ns_${randomUUID()}`,
      name: `delete-exhausted-${randomUUID()}`,
      status: "ready",
      createdAt: new Date().toISOString(),
    };
    await fixture.state.transact((unit) => unit.namespaces.createNamespace(namespace));
    // A stuck finalizer keeps the Namespace terminating past the deadline.
    let terminating = true;
    let deleteAttempts = 0;
    await fixture.start(
      {
        ...fixture.compute,
        async deleteNamespace(target) {
          assert.equal(target.id, namespace.id);
          deleteAttempts += 1;
          return { namespaceId: target.id, namespaceDeleted: !terminating };
        },
      },
      { convergenceTimeoutMs: 1 },
    );
    const deletion = {
      id: namespace.id,
      idempotencyKey: `namespace:${namespace.id}:reconcile:deleted`,
    };
    const observe = () =>
      fixture.state.read((view) => view.operations.findWork(deletion.idempotencyKey));
    await fixture.controller.deleteNamespace(fixture.actor.id, namespace.id);
    await fixture.work(deletion, "failed_permanent");
    const exhausted = await observe();
    assert.equal(exhausted.reasonCode, "CONVERGENCE_DEADLINE_EXCEEDED");
    assert.equal(deleteAttempts, 1);
    const stranded = await fixture.state.read((view) =>
      view.namespaces.findNamespace(namespace.id),
    );
    assert.equal(stranded.status, "deleting");

    // A rejected caller cannot replenish the worker's attempt budget.
    await assert.rejects(
      fixture.controller.deleteNamespace(
        await deleteDeniedCaller(fixture, "unprivileged"),
        namespace.id,
      ),
      deleteDenied({ kind: "namespace", id: namespace.id, namespaceId: namespace.id }),
    );
    assert.deepEqual(await observe(), exhausted);

    // Retrying before the teardown is repaired keeps the original deadline and
    // fails again after one pass instead of looping.
    const repeated = await fixture.controller.deleteNamespace(fixture.actor.id, namespace.id);
    assert.equal(repeated.status, "deleting");
    const retried = await observe();
    assert.ok(
      ["queued", "claimed"].includes(retried.state),
      "authorized repeated DELETE must requeue the failed Namespace teardown",
    );
    assert.equal(retried.idempotencyKey, exhausted.idempotencyKey);
    assert.equal(retried.actorId, exhausted.actorId);
    assert.equal(retried.reasonCode, undefined);
    await waitFor("unrepaired retry to fail again", async () => {
      const work = await observe();
      return deleteAttempts === 2 && work.state === "failed_permanent" ? work : undefined;
    });

    terminating = false;
    await fixture.controller.deleteNamespace(fixture.actor.id, namespace.id);
    await fixture.work(deletion, "succeeded");
    assert.equal(deleteAttempts, 3);
    assert.equal(
      await fixture.state.read((view) => view.namespaces.findNamespace(namespace.id)),
      undefined,
    );
    const { rows: retryAudit } = await fixture.observerPool.query(
      `SELECT actor_id AS "actorId", outcome, details FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.namespaces.delete.retry'
       ORDER BY occurred_at, id`,
      [namespace.id],
    );
    assert.deepEqual(
      retryAudit.map(({ actorId, outcome, details }) => ({
        actorId,
        outcome,
        workId: details.workId,
        previousReasonCode: details.previousReasonCode,
      })),
      Array.from({ length: 2 }, () => ({
        actorId: fixture.actor.id,
        outcome: "success",
        workId: deletion.idempotencyKey,
        previousReasonCode: "CONVERGENCE_DEADLINE_EXCEEDED",
      })),
    );
  },
);

revisionTest(
  "Namespace teardown audits one pending pass and the terminal pass, not every pass",
  async (fixture) => {
    // D323: each worker pass while Kubernetes namespaces terminated wrote its own
    // lifecycle.delete audit row (38 rows for one deletion).
    const namespace = {
      id: `ns_${randomUUID()}`,
      name: `delete-audit-${randomUUID()}`,
      status: "ready",
      createdAt: new Date().toISOString(),
    };
    await fixture.state.transact((unit) => unit.namespaces.createNamespace(namespace));
    let deleteAttempts = 0;
    await fixture.start({
      ...fixture.compute,
      async deleteNamespace(target) {
        assert.equal(target.id, namespace.id);
        deleteAttempts += 1;
        return { namespaceId: target.id, namespaceDeleted: deleteAttempts >= 4 };
      },
    });
    const deletion = {
      id: namespace.id,
      idempotencyKey: `namespace:${namespace.id}:reconcile:deleted`,
    };
    await fixture.controller.deleteNamespace(fixture.actor.id, namespace.id);
    await fixture.work(deletion, "succeeded");
    assert.equal(deleteAttempts, 4);
    const { rows } = await fixture.observerPool.query(
      `SELECT outcome, details FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.namespaces.lifecycle.delete'
       ORDER BY occurred_at, id`,
      [namespace.id],
    );
    assert.deepEqual(
      rows.map(({ outcome, details }) => ({
        outcome,
        namespaceDeleted: details.namespaceDeleted,
        convergencePending: details.convergencePending,
      })),
      [
        { outcome: "success", namespaceDeleted: false, convergencePending: true },
        { outcome: "success", namespaceDeleted: true, convergencePending: undefined },
      ],
    );
    // The queue's own reconcile evidence follows the same rule: one row for the
    // unchanged waiting state, one for completion.
    const reconcile = await fixture.observerPool.query(
      `SELECT outcome, details->>'reasonCode' AS code FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'reconcile' AND resource_kind = 'namespace'
       ORDER BY occurred_at, id`,
      [namespace.id],
    );
    assert.deepEqual(
      reconcile.rows.map(({ outcome, code }) => ({ outcome, code })),
      [
        { outcome: "success", code: "NAMESPACE_INCOMPLETE" },
        { outcome: "success", code: "RECONCILE_SUCCEEDED" },
      ],
    );
  },
);

test(
  "a failed Namespace logs the Compute refusal reason while status and audit keep only the failure",
  requiresPostgres,
  async (context) => {
    // D521: a refused existing-namespace selection ended `failed` with no reason anywhere.
    const fixture = await setup(context);
    const reason =
      "Existing Kubernetes namespace customer-support belongs to another tenant: its openclaw.dev/namespace label names a different Namespace.";
    const timedOut = "Kubernetes API request timed out.";
    const results = [
      { failure: "retryable", reason: timedOut },
      // Only a failed pass keeps a reason, and only bounded printable text: the worker drops
      // the rest itself, before the logger sees it.
      { reason: timedOut },
      { failure: "retryable", reason: "line\nbreak" },
      { failure: "retryable", reason: "x".repeat(257) },
      { failure: "permanent", reason },
    ];
    let attempts = 0;
    let deletes = 0;
    const output = [];
    const events = [];
    const logger = createWorkerLogEmitter(
      createOccLogger({
        component: "occ-worker",
        destination: jsonLineDestination(output),
      }),
    );
    const log = (event) => {
      events.push(event);
      logger(event);
    };
    await fixture.start(
      {
        ...fixture.compute,
        async deleteNamespace(target) {
          deletes += 1;
          return deletes === 1
            ? {
                namespaceId: target.id,
                namespaceDeleted: false,
                failure: "retryable",
                reason: timedOut,
              }
            : { namespaceId: target.id, namespaceDeleted: true };
        },
        async ensureNamespace(target) {
          const result = results[Math.min(attempts, results.length - 1)];
          attempts += 1;
          return { namespaceId: target.id, namespaceReady: false, ...result };
        },
      },
      { emit: log },
    );
    const namespace = await fixture.controller.createNamespace(fixture.actor.id, {
      name: `refused-${randomUUID()}`,
    });
    assert.equal(namespace.status, "provisioning");
    await fixture.work(
      { id: namespace.id, idempotencyKey: `namespace:${namespace.id}:reconcile:ready` },
      "failed_permanent",
      // The retries back off, under 10 s in all; the pending pass uses no attempt.
      40_000,
    );
    const ensured = (lines) =>
      lines.filter(
        (line) =>
          line.event === "worker.completed" &&
          line.namespaceId === namespace.id &&
          line.operation === "namespace.ensure",
      );
    const completed = await waitFor("every logged Namespace pass", async () =>
      ensured(output).length === results.length ? ensured(output) : undefined,
    );
    const passes = [
      ["retry", timedOut],
      ["pending", undefined],
      ["retry", undefined],
      ["retry", undefined],
      ["permanent", reason],
    ];
    assert.deepEqual(
      completed.map(({ outcome, code, reason }) => [outcome, code, reason]),
      passes.map(([outcome, reason]) => [outcome, "NAMESPACE_INCOMPLETE", reason]),
    );
    // The worker's own events already lack the dropped reasons.
    assert.deepEqual(
      ensured(events).map((event) => event.reason),
      passes.map(([, reason]) => reason),
    );
    const failed = await fixture.state.read((view) => view.namespaces.findNamespace(namespace.id));
    assert.equal(failed.status, "failed");
    // The reason stays in the operator log: the Namespace and its audit events carry none.
    assert.equal(JSON.stringify(failed).includes("another tenant"), false);
    const { rows } = await fixture.observerPool.query(
      `SELECT details FROM occ.audit_events WHERE namespace_id = $1`,
      [namespace.id],
    );
    assert.ok(rows.length > 0);
    assert.equal(JSON.stringify(rows).includes("another tenant"), false);
    assert.equal(JSON.stringify(rows).includes("timed out"), false);
    // A delete pass logs no reason, even when its Driver returns one.
    await fixture.controller.deleteNamespace(fixture.actor.id, namespace.id);
    await fixture.work(
      { id: namespace.id, idempotencyKey: `namespace:${namespace.id}:reconcile:deleted` },
      "succeeded",
    );
    const deleted = await waitFor("both Namespace delete passes", async () => {
      const passes = events.filter(
        (event) =>
          event.event === "worker.completed" &&
          event.namespaceId === namespace.id &&
          event.operation === "namespace.delete",
      );
      return passes.length === 2 ? passes : undefined;
    });
    assert.deepEqual(
      deleted.map((event) => Object.hasOwn(event, "reason")),
      [false, false],
    );
  },
);

revisionTest(
  "Namespace teardown records the same waiting state again after a retry in between",
  async (fixture) => {
    const namespace = {
      id: `ns_${randomUUID()}`,
      name: `delete-retry-audit-${randomUUID()}`,
      status: "ready",
      createdAt: new Date().toISOString(),
    };
    await fixture.state.transact((unit) => unit.namespaces.createNamespace(namespace));
    let deleteAttempts = 0;
    await fixture.start({
      ...fixture.compute,
      async deleteNamespace(target) {
        deleteAttempts += 1;
        // waiting, waiting, retryable failure, waiting, waiting, deleted
        return deleteAttempts === 3
          ? { namespaceId: target.id, namespaceDeleted: false, failure: "retryable" }
          : { namespaceId: target.id, namespaceDeleted: deleteAttempts >= 6 };
      },
    });
    await fixture.controller.deleteNamespace(fixture.actor.id, namespace.id);
    await fixture.work(
      { id: namespace.id, idempotencyKey: `namespace:${namespace.id}:reconcile:deleted` },
      "succeeded",
    );
    assert.equal(deleteAttempts, 6);
    const { rows } = await fixture.observerPool.query(
      `SELECT outcome, details->>'reasonCode' AS code FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'reconcile' AND resource_kind = 'namespace'
       ORDER BY occurred_at, id`,
      [namespace.id],
    );
    assert.deepEqual(
      rows.map(({ outcome, code }) => ({ outcome, code })),
      [
        { outcome: "success", code: "NAMESPACE_INCOMPLETE" },
        { outcome: "failure", code: "NAMESPACE_INCOMPLETE" },
        { outcome: "success", code: "NAMESPACE_INCOMPLETE" },
        { outcome: "success", code: "RECONCILE_SUCCEEDED" },
      ],
    );
  },
);

revisionTest(
  "another authorized actor takes over failed Namespace deletion once the initiator loses permission",
  async (fixture) => {
    const namespace = {
      id: `ns_${randomUUID()}`,
      name: `delete-takeover-${randomUUID()}`,
      status: "ready",
      createdAt: new Date().toISOString(),
    };
    await fixture.state.transact((unit) => unit.namespaces.createNamespace(namespace));
    // A stuck finalizer keeps the Namespace terminating past the deadline.
    let terminating = true;
    let deleteAttempts = 0;
    await fixture.start(
      {
        ...fixture.compute,
        async deleteNamespace(target) {
          assert.equal(target.id, namespace.id);
          deleteAttempts += 1;
          return { namespaceId: target.id, namespaceDeleted: !terminating };
        },
      },
      { convergenceTimeoutMs: 1 },
    );
    const deletion = {
      id: namespace.id,
      idempotencyKey: `namespace:${namespace.id}:reconcile:deleted`,
    };
    const observe = () =>
      fixture.state.read((view) => view.operations.findWork(deletion.idempotencyKey));
    await fixture.controller.deleteNamespace(fixture.actor.id, namespace.id);
    await fixture.work(deletion, "failed_permanent");
    const exhausted = await observe();
    assert.equal(exhausted.actorId, fixture.actor.id);

    const otherActor = `delete-successor-${randomUUID()}`;
    await fixture.copyActorGrants(otherActor);
    const unprivileged = await deleteDeniedCaller(fixture, "unprivileged");
    // While the initiator still holds delete permission, it keeps ownership.
    await assert.rejects(fixture.controller.deleteNamespace(otherActor, namespace.id), {
      name: "DeletionRetryOwnedError",
      message: /Only the actor that started this deletion can retry it/,
      initiatingActorId: fixture.actor.id,
      authorization: {
        action: "delete",
        resource: { kind: "namespace", id: namespace.id, namespaceId: namespace.id },
      },
    });
    assert.deepEqual(await observe(), exhausted);

    // The initiator is offboarded: it no longer holds any access.
    await removeAccessBindings(fixture, fixture.actor.id);
    // A caller without delete permission still cannot take over.
    await assert.rejects(
      fixture.controller.deleteNamespace(unprivileged, namespace.id),
      deleteDenied({ kind: "namespace", id: namespace.id, namespaceId: namespace.id }),
    );
    assert.deepEqual(await observe(), exhausted);

    terminating = false;
    const repeated = await fixture.controller.deleteNamespace(otherActor, namespace.id);
    assert.equal(repeated.status, "deleting");
    const retried = await observe();
    assert.ok(
      retried === undefined || ["queued", "claimed", "succeeded"].includes(retried.state),
      "an authorized takeover must requeue the exhausted teardown",
    );
    if (retried !== undefined) {
      assert.equal(retried.actorId, otherActor);
      assert.equal(retried.idempotencyKey, exhausted.idempotencyKey);
    }
    // Namespace policy left at teardown is removed with the tombstone and audited.
    const policyRole = `role-${randomUUID()}`;
    const policyBinding = `binding-${randomUUID()}`;
    await fixture.observerPool.query(
      `INSERT INTO occ.iam_roles (id, namespace_id, name, permissions)
       VALUES ($1, $2, NULL, '[{"action":"read","resourceKind":"namespace"}]'::jsonb)`,
      [policyRole, namespace.id],
    );
    await fixture.observerPool.query(
      `INSERT INTO occ.iam_access_bindings
         (id, namespace_id, identity_subject_id, role_id, resource_kind, resource_id)
       VALUES ($1, $2, $3, $4, 'namespace', $2)`,
      [policyBinding, namespace.id, otherActor, policyRole],
    );
    await fixture.work(deletion, "succeeded");
    assert.equal(deleteAttempts, 2);
    assert.equal(
      await fixture.state.read((view) => view.namespaces.findNamespace(namespace.id)),
      undefined,
    );
    const { rows: leftover } = await fixture.observerPool.query(
      `SELECT (SELECT count(*) FROM occ.iam_roles WHERE namespace_id = $1)::int AS roles,
              (SELECT count(*) FROM occ.iam_access_bindings WHERE namespace_id = $1)::int AS bindings`,
      [namespace.id],
    );
    assert.deepEqual(leftover, [{ roles: 0, bindings: 0 }]);
    const { rows: teardownAudit } = await fixture.observerPool.query(
      `SELECT details FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.namespaces.lifecycle.delete'
         AND outcome = 'success'`,
      [namespace.id],
    );
    assert.equal(teardownAudit.length, 1);
    assert.ok(teardownAudit[0].details.removedRoleIds.includes(policyRole));
    assert.ok(
      teardownAudit[0].details.removedAccessBindings.some(
        (binding) => binding.id === policyBinding && binding.subjectId === otherActor,
      ),
    );
    const { rows: retryAudit } = await fixture.observerPool.query(
      `SELECT actor_id AS "actorId", outcome, details FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.namespaces.delete.retry'`,
      [namespace.id],
    );
    assert.deepEqual(
      retryAudit.map(({ actorId, outcome, details }) => ({
        actorId,
        outcome,
        takeover: details.takeover,
        previousActorId: details.previousActorId,
      })),
      [
        {
          actorId: otherActor,
          outcome: "success",
          takeover: true,
          previousActorId: fixture.actor.id,
        },
      ],
    );
  },
);

test(
  "Agent deletion fails closed when a credential-provisioning Driver cannot delete credentials",
  requiresPostgres,
  async (context) => {
    let snapshot;
    const metrics = createOccMetrics("worker", () => snapshot.collect());
    const fixture = await setup(context, { metrics });
    snapshot = new PostgresMetricsSnapshot(fixture.observerPool);
    const owner = await fixture.agent("delete-credentials-unsupported");
    const before = await snapshot.collect();
    const deletion = await fixture.requestDeletion(owner);
    // Even a draft enters teardown while deletion is queued. Failed cleanup
    // retains the Agent and must remain visible as a failed lifecycle.
    const pending = await snapshot.collect();
    assert.equal(pending.agents.draft, before.agents.draft - 1);
    assert.equal(pending.agents.stopping, before.agents.stopping + 1);
    await fixture.start({
      ...fixture.compute,
      async provisionAgentRuntimeCredentials() {},
    });

    const failed = await fixture.work(deletion, "failed_permanent");
    assert.equal(failed.attempt_count, 1);
    await fixture.stop();
    const after = await snapshot.collect();
    assert.equal(after.agents.failed, before.agents.failed + 1);
    assert.equal(after.agents.draft, before.agents.draft - 1);
    assert.match(
      await metrics.exposition(),
      /occ_reconciliation_attempts_total\{[^}]*work_kind="agent_delete"[^}]*outcome="permanent"[^}]*\} 1/,
    );
    const retained = await fixture.currentAgent(owner);
    assert.equal(retained?.status, "deleting");
    assert.equal(retained?.desiredRuntimeState, "stopped");
    const audit = await fixture.observerPool.query(
      `SELECT outcome, details->>'reasonCode' AS reason_code
       FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.delete'
         AND resource_id = $2`,
      [fixture.namespace.id, owner.id],
    );
    assert.deepEqual(audit.rows, [
      { outcome: "failure", reason_code: "CREDENTIAL_DELETION_UNSUPPORTED" },
    ]);
  },
);

revisionTest(
  "Agent deletion finalization rejects an expired lease without removing state",
  async (fixture) => {
    const owner = await fixture.agent("delete-expired-lease");
    const deletion = await fixture.requestDeletion(owner);
    const claimToken = randomUUID();
    await fixture.observerPool.query(
      `UPDATE occ.controller_work
       SET state = 'claimed', claim_token = $1, lease_expires_at = now() - interval '1 second',
           attempt_count = 1, updated_at = now()
       WHERE idempotency_key = $2`,
      [claimToken, deletion.idempotencyKey],
    );
    const queue = new fixture.PostgresWorkQueue(fixture.workerPool);

    await assert.rejects(
      queue.completeAgentDeletion(
        { idempotencyKey: deletion.idempotencyKey, claimToken },
        fixture.namespace.id,
        owner.id,
      ),
      { name: "WorkClaimLostError" },
    );
    const [retained, revisions, identity, work] = await Promise.all([
      fixture.currentAgent(owner),
      fixture.observerPool.query(
        "SELECT count(*)::integer AS count FROM occ.agent_revisions WHERE agent_id = $1",
        [owner.id],
      ),
      fixture.observerPool.query(
        "SELECT count(*)::integer AS count FROM occ.iam_identities WHERE id = $1",
        [owner.servicePrincipalId],
      ),
      fixture.observerPool.query(
        "SELECT count(*)::integer AS count FROM occ.controller_work WHERE idempotency_key = $1",
        [deletion.idempotencyKey],
      ),
    ]);
    assert.equal(retained?.status, "deleting");
    assert.deepEqual(revisions.rows, [{ count: 0 }]);
    assert.deepEqual(identity.rows, [{ count: 1 }]);
    assert.deepEqual(work.rows, [{ count: 1 }]);
    // Keep this deliberately expired fixture from being recovered by a later
    // worker test; the assertions above already proved the live product path.
    await fixture.observerPool.query(
      `UPDATE occ.controller_work
       SET state = 'failed_permanent', claim_token = NULL, lease_expires_at = NULL,
           completed_at = now(), reason_code = 'EXPIRED_LEASE_TEST_CLEANUP',
           result_data = NULL, updated_at = now()
       WHERE idempotency_key = $1`,
      [deletion.idempotencyKey],
    );
  },
);

revisionTest(
  "deleting the last Agent releases its Namespace for ordinary offboarding",
  async (fixture) => {
    const owner = await fixture.agent("last-agent");
    await fixture.start(fixture.compute);

    await fixture.requestDeletion(owner);
    await waitFor(`last Agent ${owner.id} to be removed`, async () => {
      const deleted = await fixture.currentAgent(owner);
      return deleted === undefined ? true : undefined;
    });

    // Agent deletion preserves Namespace-owned inputs. Remove the surviving
    // harness Secret through the production controller before offboarding.
    assert.equal(owner.harnessAuth.method, "api_key");
    await fixture.controller.deleteSecret(
      fixture.actor.id,
      fixture.namespace.id,
      owner.harnessAuth.source.id,
    );
    await fixture.state.transactWithQueue(async (unit, queue) => {
      assert.equal(await unit.namespaces.hasAgents(fixture.namespace.id), false);
      assert.equal(
        await unit.configurations.deleteConfiguration(fixture.namespace.id, owner.configurationId),
        true,
      );
      const deleting = await unit.namespaces.transitionNamespaceStatus(
        fixture.namespace.id,
        "ready",
        "deleting",
      );
      assert.ok(deleting);
      await queue.enqueue({
        idempotencyKey: `namespace:${fixture.namespace.id}:reconcile:deleted`,
        namespaceId: fixture.namespace.id,
        namespaceTarget: "deleted",
        actorId: fixture.actor.id,
        availableAt: new Date(0),
      });
    });
    await waitFor(`Namespace ${fixture.namespace.id} to be tombstoned`, async () => {
      const namespace = await fixture.state.read((view) =>
        view.namespaces.findNamespace(fixture.namespace.id),
      );
      return namespace === undefined ? true : undefined;
    });
  },
);

revisionTest(
  "the application role can finalize Agent deletion without direct table deletion grants",
  async (fixture) => {
    const privileges = await fixture.observerPool.query(
      `SELECT
         has_table_privilege(current_user, 'occ.agents', 'DELETE') AS delete_agent,
         has_table_privilege(current_user, 'occ.agent_revisions', 'DELETE') AS delete_revision,
         has_table_privilege(current_user, 'occ.iam_identities', 'DELETE') AS delete_identity,
         has_function_privilege(
           current_user,
           'occ.finalize_agent_deletion(text,text,text,uuid)',
           'EXECUTE'
         ) AS execute_finalizer,
         EXISTS (
           SELECT 1
           FROM information_schema.routine_privileges
           WHERE routine_schema = 'occ'
             AND routine_name = 'finalize_agent_deletion'
             AND grantee = 'PUBLIC'
             AND privilege_type = 'EXECUTE'
         ) AS public_execute`,
    );
    assert.deepEqual(privileges.rows, [
      {
        delete_agent: false,
        delete_revision: false,
        delete_identity: false,
        execute_finalizer: true,
        public_execute: false,
      },
    ]);
  },
);

test(
  "a deployment admitted after stop supersedes stale stop work before Compute mutation",
  requiresPostgres,
  async (context) => {
    const metrics = createOccMetrics("worker", () =>
      new PostgresMetricsSnapshot(fixture.observerPool).collect(),
    );
    const fixture = await setup(context, { metrics });
    const { owner, candidate: first } = await fixture.admitInitialRevision("stop-then-deploy");
    const stoppedRevisions = [];
    let releaseStopAuthorization;
    const stopAuthorizationReleased = new Promise((resolve) => {
      releaseStopAuthorization = resolve;
    });
    let stopAuthorizationStarted;
    const stopAuthorizationObserved = new Promise((resolve) => {
      stopAuthorizationStarted = resolve;
    });
    const compute = {
      ...fixture.compute,
      async stopRevision(candidate) {
        stoppedRevisions.push(candidate.id);
      },
    };
    await fixture.start(compute, {
      pool: fixture.workerPool,
      transformDrivers: (drivers) => {
        const createIAMDriver = drivers.createIAMDriver;
        return {
          ...drivers,
          createIAMDriver(state) {
            const iam = createIAMDriver(state);
            return {
              id: iam.id,
              implementation: iam.implementation,
              capability: iam.capability,
              lookupIdentity: iam.lookupIdentity.bind(iam),
              async authorize(request) {
                if (
                  request.action === "operate" &&
                  request.resource.kind === "agent" &&
                  request.resource.id === owner.id
                ) {
                  stopAuthorizationStarted();
                  await stopAuthorizationReleased;
                }
                return iam.authorize(request);
              },
            };
          },
        };
      },
    });
    await fixture.work(first, "succeeded");

    const stop = await fixture.requestStop(owner);
    await stopAuthorizationObserved;
    // This later admission changes intent while stop is inside its required IAM check.
    const second = await fixture.revision(owner, 2);
    releaseStopAuthorization();

    await Promise.all([fixture.work(stop, "succeeded"), fixture.work(second, "succeeded")]);
    const running = await fixture.currentAgent(owner);
    assert.equal(running.desiredRuntimeState, "running");
    assert.equal(running.activeRevisionId, second.id);
    assert.deepEqual(stoppedRevisions, []);
    assert.match(
      await metrics.exposition(),
      /occ_agent_operation_duration_seconds_count\{[^\n]*operation="stop"[^\n]*\} 0(?:\n|$)/,
    );
    const audit = await fixture.observerPool.query(
      `SELECT details->>'reasonCode' AS reason_code
       FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.stop'
         AND resource_id = $2`,
      [fixture.namespace.id, owner.id],
    );
    assert.deepEqual(audit.rows, [{ reason_code: "STOP_SUPERSEDED" }]);
  },
);

revisionTest(
  "Agent stop cleans a terminal candidate without an active revision",
  async (fixture) => {
    const { owner, candidate } = await fixture.admitInitialRevision("stop-initial-failure");
    const stopped = [];
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision) {
          return { ...(await fixture.compute.prepareRevision(revision)), ready: false };
        },
        async stopRevision(revision) {
          // The shared queue can also dispatch another fixture's durable cleanup.
          if (revision.namespaceId === fixture.namespace.id) {
            stopped.push(revision.id);
          }
          return fixture.compute.stopRevision(revision);
        },
      },
      { convergenceTimeoutMs: 50 },
    );
    await fixture.work(candidate, "failed_permanent");
    // Historical records from another selected Compute are not cleanup inputs
    // for this worker, even when the Agent has no active pointer.
    await fixture.state.transact((unit) =>
      unit.revisions.createRevision({
        ...candidate,
        id: `rev_${randomUUID()}`,
        revision: 2,
        compute: { id: "retired-compute", implementation: "retired-compute" },
      }),
    );
    const stop = await fixture.requestStop(owner);
    await fixture.work(stop, "succeeded");
    assert.deepEqual(stopped, [candidate.id]);
    const current = await fixture.currentAgent(owner);
    assert.equal(current.desiredRuntimeState, "stopped");
    assert.equal(current.activeRevisionId, undefined);
  },
);

for (const admissionDuring of ["active", "candidate"]) {
  revisionTest(
    `a deployment during ${admissionDuring} cleanup supersedes the remaining Agent stop effects`,
    async (fixture) => {
      const { owner, candidate: active } = await fixture.admitInitialRevision(
        `stop-race-${admissionDuring}`,
      );
      const stopped = [];
      let candidate;
      let newer;
      let activeWhenNewerPrepared;
      await fixture.start(
        {
          ...fixture.compute,
          async prepareRevision(revision) {
            if (revision.revision === 3) {
              const current = await fixture.currentAgent(owner);
              activeWhenNewerPrepared = current.activeRevisionId;
            }
            return {
              ...(await fixture.compute.prepareRevision(revision)),
              ready: revision.revision !== 2,
            };
          },
          async stopRevision(revision) {
            // The shared queue can also dispatch another fixture's durable cleanup.
            if (revision.namespaceId !== fixture.namespace.id) {
              return fixture.compute.stopRevision(revision);
            }
            stopped.push(revision.id);
            if (revision.id === (admissionDuring === "active" ? active.id : candidate.id)) {
              // Admission changes desired state during an exact cleanup call. The
              // old pointer must survive both the next-effect and final-CAS fences.
              newer = await fixture.revision(owner, 3);
            }
          },
        },
        { convergenceTimeoutMs: 50 },
      );
      await fixture.work(active, "succeeded");
      candidate = await fixture.revision(owner, 2);
      await fixture.work(candidate, "failed_permanent");
      const stop = await fixture.requestStop(owner);
      await fixture.work(stop, "succeeded");
      assert.ok(newer);
      await fixture.work(newer, "succeeded");
      assert.deepEqual(
        stopped,
        admissionDuring === "active" ? [active.id] : [active.id, candidate.id],
      );
      assert.equal(
        activeWhenNewerPrepared,
        active.id,
        "stale stop must not clear the serving pointer after a later admission",
      );
      const current = await fixture.currentAgent(owner);
      assert.equal(current.desiredRuntimeState, "running");
      assert.equal(current.activeRevisionId, newer.id);
    },
  );
}

for (const { operation, action } of [
  { operation: "stop", action: "operate" },
  { operation: "delete", action: "delete" },
]) {
  test(
    `Agent ${operation} reauthorizes the recorded actor before Compute mutation`,
    requiresPostgres,
    async (context) => {
      const metrics = createOccMetrics("worker", () =>
        new PostgresMetricsSnapshot(fixture.observerPool).collect(),
      );
      const fixture = await setup(context, { metrics });
      const before = await new PostgresMetricsSnapshot(fixture.observerPool).collect();
      const { owner, candidate: revision } = await fixture.admitInitialRevision(
        `${operation}-reauthorization`,
      );
      const effects = [];
      const compute = {
        ...fixture.compute,
        async stopRevision(candidate) {
          effects.push({ action: "stop", agentId: candidate.agentId });
        },
        async retireRevision(candidate) {
          effects.push({ action: "retire", agentId: candidate.agentId });
        },
        async deleteAgentRuntimeCredentials({ agent }) {
          effects.push({ action: "credentials", agentId: agent.id });
        },
      };
      await fixture.start(compute);
      await fixture.work(revision, "succeeded");

      await fixture.stop();
      const work = await (operation === "stop"
        ? fixture.requestStop(owner)
        : fixture.requestDeletion(owner));
      // Admission was authorized; revoke before restarting the worker to prove
      // dispatch independently rechecks the recorded actor's permission.
      await fixture.observerPool.query(
        `INSERT INTO occ.iam_restrictions
         (id, namespace_id, action, resource_kind, resource_id, effect)
       VALUES ($1, $2, $3, 'agent', $4, 'deny')`,
        [`restriction-${randomUUID()}`, fixture.namespace.id, action, owner.id],
      );
      await fixture.start(compute, { pool: fixture.createWorkerPool() });
      assert.equal((await fixture.work(work, "failed_permanent")).attempt_count, 1);
      if (operation === "stop") {
        assert.equal(
          (await new PostgresMetricsSnapshot(fixture.observerPool).collect()).agents.failed,
          before.agents.failed + 1,
        );
        assert.match(
          await metrics.exposition(),
          /occ_agent_operation_duration_seconds_count\{[^\n]*operation="stop"[^\n]*\} 0(?:\n|$)/,
        );
      }

      // The shared queue can also dispatch another fixture's durable cleanup.
      assert.deepEqual(
        effects.filter(({ agentId }) => agentId === owner.id),
        [],
      );
      const current = await fixture.currentAgent(owner);
      assert.equal(current.activeRevisionId, revision.id);
      assert.equal(current.desiredRuntimeState, "stopped");
      assert.equal(current.status, operation === "delete" ? "deleting" : "active");
      const audit = await fixture.observerPool.query(
        `SELECT kind, action, outcome,
              details->'__occAuditMetadata'->'authorization' AS authorization,
              details->'__occAuditMetadata'->>'reasonCode' AS reason_code
       FROM occ.audit_events
       WHERE namespace_id = $1 AND resource_id = $2
         AND kind = 'authorization_denial'`,
        [fixture.namespace.id, owner.id],
      );
      assert.deepEqual(audit.rows, [
        {
          kind: "authorization_denial",
          action: `openclaw.agents.${operation}`,
          outcome: "denied",
          authorization: {
            principalId: fixture.actor.id,
            action,
            resource: { kind: "agent", id: owner.id, namespaceId: fixture.namespace.id },
          },
          reason_code: "AUTHORIZATION_DENIED",
        },
      ]);
    },
  );
}

revisionTest(
  "active revision maintenance defers shutdown to the separately authorized Agent stop work",
  async (fixture, context) => {
    const { owner, candidate: revision } = await fixture.admitInitialRevision(
      "stop-maintenance-authorization",
    );
    await fixture.start(fixture.compute);
    await fixture.work(revision, "succeeded");
    await fixture.stop();

    // The shared queue can also deliver an independently authorized stop from
    // another Namespace while this Namespace denies its own Agent's shutdown.
    const neighbor = await setup(context, { database: fixture.database });
    const neighborOwner = await neighbor.agent("authorized-neighbor-stop");
    const neighborRevision = await neighbor.revision(neighborOwner, 1);
    await neighbor.start(neighbor.compute);
    await neighbor.work(neighborRevision, "succeeded");
    await neighbor.stop();
    const neighborStop = await neighbor.requestStop(neighborOwner);

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
    const stop = await fixture.requestStop(owner);

    // Maintenance may observe stopped intent first, but only the Agent-stop claim
    // may perform shutdown after reauthorizing its recorded actor.
    await fixture.observerPool.query(
      `INSERT INTO occ.iam_restrictions
         (id, namespace_id, action, resource_kind, resource_id, effect)
       VALUES ($1, $2, 'operate', 'agent', $3, 'deny')`,
      [`restriction-${randomUUID()}`, fixture.namespace.id, owner.id],
    );
    const stoppedRevisions = [];
    const events = [];
    await fixture.start(
      {
        ...fixture.compute,
        async stopRevision(candidate) {
          if (candidate.namespaceId === fixture.namespace.id) {
            stoppedRevisions.push(candidate.id);
          }
          return fixture.compute.stopRevision(candidate);
        },
      },
      { emit: (event) => events.push(event), pool: fixture.createWorkerPool() },
    );

    await fixture.work(maintenance, "succeeded");
    await fixture.work(stop, "failed_permanent");
    await neighbor.work(neighborStop, "succeeded");
    assert.deepEqual(stoppedRevisions, []);
    const current = await fixture.currentAgent(owner);
    assert.equal(current.activeRevisionId, revision.id);
    assert.equal(current.desiredRuntimeState, "stopped");
    await completion(
      events,
      "the maintenance's REVISION_MAINTENANCE_SUPERSEDED completion",
      ({ event, code, revisionId }) =>
        event === "worker.completed" &&
        code === "REVISION_MAINTENANCE_SUPERSEDED" &&
        revisionId === revision.id,
    );
  },
);

revisionTest(
  "a stop accepted during revision preparation prevents the candidate from becoming active",
  async (fixture, context) => {
    const owner = await fixture.agent("stop-prepare-race");
    // Other Namespaces share this worker's queue. Their durable stop work must
    // drain without changing this candidate's preparation gate or observations.
    const foreign = await setup(context, { database: fixture.database });
    const foreignOwner = await foreign.agent("stop-prepare-foreign");
    const foreignRevision = await foreign.revision(foreignOwner, 1);
    const foreignStop = await foreign.requestStop(foreignOwner);
    const candidate = await fixture.revision(owner, 1);
    let releasePreparation;
    const preparationReleased = new Promise((resolve) => {
      releasePreparation = resolve;
    });
    let preparationStarted = false;
    const stoppedRevisions = [];
    await fixture.start({
      ...fixture.compute,
      async prepareRevision(revision) {
        if (revision.namespaceId === fixture.namespace.id) {
          preparationStarted = true;
          await preparationReleased;
        }
        return fixture.compute.prepareRevision(revision);
      },
      async stopRevision(revision) {
        if (revision.namespaceId === fixture.namespace.id) {
          stoppedRevisions.push(revision.id);
        }
        return fixture.compute.stopRevision(revision);
      },
    });
    await waitFor("revision preparation to start", async () =>
      preparationStarted ? true : undefined,
    );

    const stop = await fixture.requestStop(owner);
    releasePreparation();
    await fixture.work(candidate, "succeeded");
    await fixture.work(stop, "succeeded");
    await foreign.work(foreignRevision, "succeeded");
    await foreign.work(foreignStop, "succeeded");

    const stopped = await fixture.currentAgent(owner);
    assert.equal(stopped.activeRevisionId, undefined);
    assert.equal(stopped.desiredRuntimeState, "stopped");
    // Both the interrupted revision and Agent-stop owner perform exact,
    // idempotent cleanup; neither may activate the candidate.
    assert.deepEqual(stoppedRevisions, [candidate.id, candidate.id]);
    const activation = await fixture.observerPool.query(
      `SELECT id FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.activate'
         AND resource_id = $2`,
      [fixture.namespace.id, candidate.id],
    );
    assert.deepEqual(activation.rows, []);
    // The deployment did not activate, and its error says why instead of a generic failure.
    const status = await fixture.deploymentStatus(owner, candidate);
    assert.equal(status.status, "failed");
    assert.deepEqual(status.error, {
      code: "REVISION_STOPPED",
      message: "Deployment ended because the Agent was stopped.",
    });
  },
);

revisionTest(
  "a stop committed after the last running check never publishes the candidate",
  async (fixture) => {
    const { owner, candidate: predecessor } =
      await fixture.admitInitialRevision("stop-before-publication");
    await fixture.start(fixture.compute);
    await fixture.work(predecessor, "succeeded");
    await fixture.stop();

    // A before-commit Driver activates the candidate after the worker's last check
    // that the Agent runs. A stop admitted then is seen only when publication locks
    // the Agent: the candidate must stay unpublished, and the predecessor is left
    // to the stop instead of being retired by a candidate that never served.
    const candidate = await fixture.revision(owner, 2);
    let releaseActivation;
    const activationReleased = new Promise((resolve) => {
      releaseActivation = resolve;
    });
    let activationStarted = false;
    const stoppedRevisions = [];
    const retiredRevisions = [];
    await fixture.start({
      ...fixture.compute,
      activationOrder: "beforeCommit",
      async activateRevision(revision) {
        if (revision.id === candidate.id) {
          activationStarted = true;
          await activationReleased;
        }
      },
      async stopRevision(revision) {
        stoppedRevisions.push(revision.id);
        return fixture.compute.stopRevision(revision);
      },
      async retireRevision(revision) {
        retiredRevisions.push(revision.id);
        return fixture.compute.retireRevision(revision);
      },
    });
    await waitFor("candidate activation to start", async () =>
      activationStarted ? true : undefined,
    );

    let stop;
    try {
      stop = await fixture.requestStop(owner);
    } finally {
      releaseActivation();
    }
    await fixture.work(candidate, "succeeded");
    await fixture.work(stop, "succeeded");

    const stopped = await fixture.currentAgent(owner);
    assert.equal(stopped.desiredRuntimeState, "stopped");
    assert.equal(stopped.activeRevisionId, undefined);
    // The candidate stops itself. The stop work then stops the still-serving predecessor
    // first and cleans up the candidate after it.
    assert.deepEqual(stoppedRevisions, [candidate.id, predecessor.id, candidate.id]);
    assert.deepEqual(retiredRevisions, []);
    const status = await fixture.deploymentStatus(owner, candidate);
    assert.equal(status.status, "failed");
    assert.deepEqual(status.error, {
      code: "REVISION_STOPPED",
      message: "Deployment ended because the Agent was stopped.",
    });
  },
);

revisionTest(
  "a stop admitted after the last running check waits for the claimed revision work, then stops the Agent",
  async (fixture) => {
    const owner = await fixture.agent("stop-after-running-check");
    const sibling = await fixture.agent("stop-after-running-check-sibling");
    const candidate = await fixture.revision(owner, 1);
    let releaseActivation;
    const activationReleased = new Promise((resolve) => {
      releaseActivation = resolve;
    });
    let activationStarted = false;
    const stoppedRevisions = [];
    const compute = {
      ...fixture.compute,
      // An after-commit Driver activates the published candidate after the worker's last check
      // that the Agent runs. Holding it keeps the revision work claimed past that check.
      async activateRevision(revision) {
        if (revision.id === candidate.id && !activationStarted) {
          activationStarted = true;
          await activationReleased;
        }
      },
      async stopRevision(revision) {
        // Records whether the revision work had released its claim when the stop reached Compute.
        const work = await fixture.observerPool.query(
          "SELECT state FROM occ.controller_work WHERE idempotency_key = $1",
          [candidate.idempotencyKey],
        );
        stoppedRevisions.push([revision.id, work.rows[0]?.state]);
        return fixture.compute.stopRevision(revision);
      },
    };
    await fixture.start(compute);
    let stop;
    try {
      await waitFor("candidate activation to start", async () =>
        activationStarted ? true : undefined,
      );
      // A second worker stands in for another controller replica: the first is busy activating,
      // and only the one-claim-per-Agent rule (the claim query skips an Agent with claimed work,
      // backed by controller_work_one_claim_per_resource) keeps this one from taking the stop.
      await fixture.start(compute, { pool: fixture.createWorkerPool() });
      stop = await fixture.requestStop(owner);
      // Claimed in queue order, the sibling's later stop finishing shows the second worker has
      // passed over the owner's stop while the revision work held its claim.
      const siblingStop = await fixture.requestStop(sibling);
      await fixture.work(siblingStop, "succeeded");
      const held = await fixture.observerPool.query(
        "SELECT idempotency_key, state FROM occ.controller_work WHERE idempotency_key = ANY($1::text[])",
        [[candidate.idempotencyKey, stop.idempotencyKey]],
      );
      assert.deepEqual(
        Object.fromEntries(held.rows.map((row) => [row.idempotency_key, row.state])),
        { [candidate.idempotencyKey]: "claimed", [stop.idempotencyKey]: "queued" },
      );
    } finally {
      releaseActivation();
    }

    // The revision work finishes its activation, then the stop runs and stops the active
    // candidate, so the Agent ends stopped rather than serving after its owner stopped it.
    await fixture.work(candidate, "succeeded");
    await fixture.work(stop, "succeeded");
    const stopped = await fixture.currentAgent(owner);
    assert.equal(stopped.desiredRuntimeState, "stopped");
    assert.equal(stopped.activeRevisionId, undefined);
    assert.deepEqual(stoppedRevisions, [[candidate.id, "succeeded"]]);
    assert.deepEqual(await stopAudit(fixture, owner), ["AGENT_STOPPED"]);
  },
);

revisionTest(
  "a stop admitted immediately after publication retires the predecessor before completion",
  async (fixture, context) => {
    const { owner, candidate: predecessor } =
      await fixture.admitInitialRevision("stop-publication-race");
    await fixture.start(fixture.compute);
    await fixture.work(predecessor, "succeeded");
    await fixture.stop();

    // This worker must drain another Namespace's real stop work without adding
    // its effects to this Agent's observations or consuming its injected fault.
    const foreign = await setup(context, { database: fixture.database });
    const foreignOwner = await foreign.agent("stop-publication-foreign");
    const foreignRevision = await foreign.revision(foreignOwner, 1);
    const foreignStop = await foreign.requestStop(foreignOwner);

    const replacement = await fixture.revision(owner, 2);
    await fixture.compute.prepareRevision(replacement);
    // Recreate the committed publication boundary before route finalization. Stop
    // admission can observe this exact durable state while revision work remains.
    const published = await fixture.state.transact((unit) =>
      unit.agents.compareAndSetActiveRevision(
        fixture.namespace.id,
        owner.id,
        predecessor.id,
        replacement.id,
      ),
    );
    assert.equal(published.activeRevisionId, replacement.id);
    const stop = await fixture.requestStop(owner);

    const stoppedRevisions = [];
    const retiredRevisions = [];
    let failRetirement = true;
    await fixture.start(
      {
        ...fixture.compute,
        async stopRevision(candidate) {
          if (candidate.namespaceId !== fixture.namespace.id) {
            return fixture.compute.stopRevision(candidate);
          }
          stoppedRevisions.push(candidate.id);
          return fixture.compute.stopRevision(candidate);
        },
        async retireRevision(candidate) {
          if (candidate.namespaceId !== fixture.namespace.id) {
            return fixture.compute.retireRevision(candidate);
          }
          retiredRevisions.push(candidate.id);
          if (failRetirement) {
            failRetirement = false;
            throw new Error("transient predecessor retirement failure");
          }
          return fixture.compute.retireRevision(candidate);
        },
      },
      { pool: fixture.createWorkerPool() },
    );

    await fixture.work(replacement, "succeeded");
    await fixture.work(stop, "succeeded");
    await Promise.all([
      foreign.work(foreignRevision, "succeeded"),
      foreign.work(foreignStop, "succeeded"),
    ]);
    const [stopped, retainedPredecessor, retainedReplacement] = await fixture.state.read(
      async (view) =>
        Promise.all([
          view.agents.findAgent(fixture.namespace.id, owner.id),
          view.revisions.findRevision(fixture.namespace.id, owner.id, predecessor.id),
          view.revisions.findRevision(fixture.namespace.id, owner.id, replacement.id),
        ]),
    );
    assert.equal(stopped.desiredRuntimeState, "stopped");
    assert.equal(stopped.activeRevisionId, undefined);
    assert.equal(retainedPredecessor.id, predecessor.id);
    assert.equal(retainedReplacement.id, replacement.id);
    assert.deepEqual(retiredRevisions, [predecessor.id, predecessor.id]);
    // Agent stop also covers the older same-Compute predecessor whose
    // retirement failed after publication, with serving revision cleanup first.
    assert.deepEqual(stoppedRevisions, [
      replacement.id,
      replacement.id,
      predecessor.id,
      replacement.id,
    ]);
  },
);

test(
  "maintenance retains its real lease across consecutive short predecessor retirements",
  requiresPostgres,
  async (context) => {
    const metrics = createOccMetrics("worker", () =>
      new PostgresMetricsSnapshot(fixture.observerPool).collect(),
    );
    const fixture = await setup(context, { metrics, leaseDurationMs: 1_200 });
    const { owner, candidate: first } =
      await fixture.admitInitialRevision("short-retirement-lease");
    const events = [];
    let completedRetirements = 0;
    await fixture.start(
      {
        ...fixture.compute,
        maintenanceIntervalMs: 200,
        async retireRevision(previous) {
          // Exercise the real worker and PostgreSQL lease with short external
          // effects: each finishes before the heartbeat timer, but the whole
          // cleanup sequence exceeds the lease. No claim timestamps are edited.
          await delay(120);
          const result = await fixture.compute.retireRevision(previous);
          completedRetirements += 1;
          return result;
        },
      },
      { emit: (event) => events.push(event) },
    );
    await fixture.work(first, "succeeded");
    // Admitted intermediate revisions can be superseded before execution. They
    // remain valid predecessors that active-revision maintenance must retire.
    await fixture.state.transact(async (unit) => {
      for (let number = 2; number <= 24; number += 1) {
        const skipped = { ...first, id: `rev_${randomUUID()}`, revision: number };
        delete skipped.idempotencyKey;
        await unit.revisions.createRevision(skipped);
      }
    });
    const current = await fixture.revision(owner, 25);
    await fixture.work(current, "succeeded");
    const maintenance = await waitFor("one successful short-effect maintenance claim", async () => {
      assert.equal(
        events.some(({ event, code }) => event === "worker.error" && code === "CLAIM_LOST"),
        false,
        "consecutive short effects must not starve lease renewal",
      );
      const result = await fixture.observerPool.query(
        `SELECT state, attempt_count FROM occ.controller_work
         WHERE revision_id = $1 AND idempotency_key LIKE '%:maintenance:%'
           AND state = 'succeeded'`,
        [current.id],
      );
      return result.rows[0];
    });
    assert.equal(maintenance.attempt_count, 1);
    // Periodic reconciliation must not inflate successful deployment counts.
    assert.match(
      await metrics.exposition(),
      /occ_agent_operation_duration_seconds_count\{[^\n]*operation="deploy"[^\n]*\} 2(?:\n|$)/,
    );
    assert.ok(completedRetirements >= 25, "activation and all predecessors were retired");
    const active = await fixture.currentAgent(owner);
    assert.equal(active.activeRevisionId, current.id);
  },
);
