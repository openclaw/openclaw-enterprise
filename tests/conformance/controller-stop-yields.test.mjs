import assert from "node:assert/strict";
import test from "node:test";

import {
  ComputeStopYieldedError,
  computeStopShouldYield,
  computeWorkWaiting,
  withComputeWorkWaiting,
  withYieldingComputeStop,
} from "../../apps/controller/src/drivers/compute/operation-context.ts";
import {
  isStopYieldedCode,
  PredecessorStopYieldedError,
  STOP_YIELD_LOG_INTERVAL_MS,
  StopYields,
  stopWithDrainYield,
  stopYieldedCode,
  stopYieldRecheckMs,
} from "../../apps/controller/src/worker/stop-yields.ts";
import { provisioningProgress } from "../../packages/occ/src/agent-provisioning.ts";
import {
  deploymentErrorForWork,
  deploymentProgressForWork,
  revisionAdmittedBeforeWork,
} from "../../packages/occ/src/state/controller-work.ts";

// Findings 1093 and 1094: stops that yield during their Gateway drain (#2145) are rechecked on
// a faster-growing cadence, do not count as due Work for another draining stop, and log their
// first yield and then at most one a minute.

const AGENT = "AGENT_STOP_YIELDED";
const PREDECESSOR = "PREDECESSOR_STOP_YIELDED";

function clock(start = 1_000_000) {
  const now = { value: start };
  return { now, read: () => now.value };
}

test("a yielded stop is rechecked after 1 s, growing to 5 s by 50 s", () => {
  assert.equal(stopYieldRecheckMs(0), 1_000);
  assert.equal(stopYieldRecheckMs(-5_000), 1_000);
  assert.equal(stopYieldRecheckMs(10_000), 1_000);
  assert.equal(stopYieldRecheckMs(20_000), 2_000);
  assert.equal(stopYieldRecheckMs(35_000), 3_500);
  assert.equal(stopYieldRecheckMs(50_000), 5_000);
  assert.equal(stopYieldRecheckMs(315_000), 5_000);
  assert.equal(stopYieldRecheckMs(900_000), 5_000);
  // Faster than the readiness cadence (age / 40), which is still at 1 s at 40 s.
  assert.ok(stopYieldRecheckMs(40_000) > 1_000);
  // A 315 s drain takes about 80 passes when every recheck yields, not about 125.
  let passes = 0;
  for (let at = 0; at < 315_000; at += stopYieldRecheckMs(at)) {
    passes += 1;
  }
  assert.ok(passes <= 85, `${passes} passes`);
});

test("a stop's first yield is logged, then at most one a minute with the count", () => {
  const { now, read } = clock();
  const yields = new StopYields(read);
  assert.equal(yields.yielded("stop-a", AGENT), 1);
  now.value += 1_000;
  assert.equal(yields.yielded("stop-a", AGENT), undefined);
  now.value += STOP_YIELD_LOG_INTERVAL_MS - 1_001;
  assert.equal(yields.yielded("stop-a", AGENT), undefined);
  now.value += 1;
  assert.equal(yields.yielded("stop-a", AGENT), 4);
  now.value += 5_000;
  assert.equal(yields.yielded("stop-a", AGENT), undefined);
  now.value += STOP_YIELD_LOG_INTERVAL_MS;
  assert.equal(yields.yielded("stop-a", AGENT), 6);
  // Another stop is logged on its own schedule. The count is kept for the work's final line.
  assert.equal(yields.yielded("stop-b", AGENT), 1);
  assert.equal(yields.yielded("stop-b", AGENT), undefined);
  assert.equal(yields.count("stop-a"), 6);
  assert.equal(yields.count("stop-b"), 2);
  assert.equal(yields.count("stop-c"), undefined);
});

test("only stops whose latest pass yielded are excluded from a draining stop's due Work", () => {
  const { now, read } = clock();
  const yields = new StopYields(read);
  assert.deepEqual(yields.waiting("gateway-drain"), []);
  yields.yielded("stop-a", AGENT);
  yields.yielded("revision-b", PREDECESSOR);
  assert.deepEqual(yields.waiting("gateway-drain").sort(), ["revision-b", "stop-a"]);
  // A pass that ends any other way (done, failed, retried) is due Work again, and its next
  // yield starts a new log series.
  yields.settled("stop-a");
  assert.deepEqual(yields.waiting("gateway-drain"), ["revision-b"]);
  assert.equal(yields.count("stop-a"), undefined);
  now.value += 1_000;
  assert.equal(yields.yielded("stop-a", AGENT), 1);
  yields.settled("unknown");
  assert.deepEqual(yields.waiting("gateway-drain").sort(), ["revision-b", "stop-a"]);
});

// Finding 1108: a deployment whose predecessor stop yielded deploys on its next pass once that
// drain is over, so only a Gateway drain skips it; other optional waits (the D221 binding ack, a
// refused candidate's stop, pairing) end for it. A stopped Agent's yielded stop only rechecks its
// drain next, so no wait ends for it.
test("only a Gateway drain skips a yielded redeploy; no wait ends for a stopped Agent's yield", () => {
  const { read } = clock();
  const yields = new StopYields(read);
  yields.yielded("stop-a", AGENT);
  yields.yielded("revision-b", PREDECESSOR);
  assert.deepEqual(yields.waiting("gateway-drain").sort(), ["revision-b", "stop-a"]);
  assert.deepEqual(yields.waiting("optional"), ["stop-a"]);
  // The latest yield decides: a redeploy that later waits on its stopped Agent's drain (the
  // stopped branch finishing its predecessor stop, finding 1109) only rechecks that drain.
  yields.yielded("revision-b", AGENT);
  assert.deepEqual(yields.waiting("optional").sort(), ["revision-b", "stop-a"]);
  yields.yielded("stop-a", PREDECESSOR);
  assert.deepEqual(yields.waiting("optional"), ["revision-b"]);
  assert.deepEqual(yields.waiting("gateway-drain").sort(), ["revision-b", "stop-a"]);
});

test("each wait tells the worker which kind it is", async () => {
  const asked = [];
  const check = async (wait) => {
    asked.push(wait);
    return true;
  };
  await withComputeWorkWaiting(check, async () => {
    // Outside a yielding stop: the D221 ack and pairing waits are optional.
    assert.equal(await computeWorkWaiting(), true);
    assert.equal(await computeStopShouldYield("gateway"), false);
    await stopWithDrainYield(0, 900_000, async () => {
      assert.equal(await computeStopShouldYield("gateway"), true);
      // The Harness wait of an ordinary stop never asks.
      assert.equal(await computeStopShouldYield("agent"), false);
    });
    await withYieldingComputeStop(async () => {
      assert.equal(await computeStopShouldYield("agent"), true);
      assert.equal(await computeStopShouldYield("gateway"), true);
    });
  });
  assert.deepEqual(asked, ["optional", "gateway-drain", "optional", "optional"]);
});

test("a yielded stop this worker has not run for ten minutes is forgotten", () => {
  const { now, read } = clock();
  const yields = new StopYields(read);
  yields.yielded("stop-a", AGENT);
  now.value += 300_000;
  yields.yielded("stop-b", AGENT);
  now.value += 299_999;
  assert.deepEqual(yields.waiting("gateway-drain").sort(), ["stop-a", "stop-b"]);
  now.value += 1;
  assert.deepEqual(yields.waiting("gateway-drain"), ["stop-b"]);
  // Forgotten, its next yield is logged as a first one.
  assert.equal(yields.yielded("stop-a", AGENT), 1);
  // Ten minutes count from the latest yield, logged or not.
  now.value += 59_000;
  assert.equal(yields.yielded("stop-a", AGENT), undefined);
  now.value += 541_000;
  assert.deepEqual(yields.waiting("gateway-drain"), ["stop-a"]);
  now.value += 59_000;
  assert.deepEqual(yields.waiting("gateway-drain"), []);
});

// Finding 1090: a redeploy's predecessor stop (exclusive replacement) yields during the Gateway
// drain like a stopped Agent's. The worker integration tests run it against PostgreSQL; these
// pin the stop's yield mode and the pending code the deployment then shows.

// A stop as Kubernetes runs it: the Gateway's Pods drain first, then the Harness's terminate.
// Each wait asks whether it may end now; the Harness is deleted only after the Gateway wait.
async function drainingStop(steps) {
  for (const role of ["gateway", "agent"]) {
    if (await computeStopShouldYield(role)) {
      throw new ComputeStopYieldedError(`${role} Pods are still terminating`);
    }
    steps.push(role);
  }
}

async function stopRun(ageMs, deadlineMs, workDue = true) {
  const steps = [];
  try {
    await withComputeWorkWaiting(
      async () => workDue,
      () => stopWithDrainYield(ageMs, deadlineMs, () => drainingStop(steps)),
    );
    return { yielded: false, steps };
  } catch (error) {
    assert.ok(error instanceof ComputeStopYieldedError);
    return { yielded: true, steps };
  }
}

test("a stop yields only its Gateway drain, only to due Work, and only before the deadline", async () => {
  // Before the deadline the Gateway wait ends when other Work is due; the Harness is untouched.
  assert.deepEqual(await stopRun(0, 900_000), { yielded: true, steps: [] });
  assert.deepEqual(await stopRun(899_999, 900_000), { yielded: true, steps: [] });
  // Nothing due: the stop waits as before and stops the Harness after the Gateway.
  assert.deepEqual(await stopRun(0, 900_000, false), {
    yielded: false,
    steps: ["gateway", "agent"],
  });
  // From the deadline on the stop keeps its full bounded wait, so it cannot defer forever.
  assert.deepEqual(await stopRun(900_000, 900_000), {
    yielded: false,
    steps: ["gateway", "agent"],
  });
  // The Harness's own wait never yields, even when the Gateway's is already done.
  const harnessOnly = [];
  await withComputeWorkWaiting(
    async () => true,
    () =>
      stopWithDrainYield(0, 900_000, async () => {
        assert.equal(await computeStopShouldYield("agent"), false);
        harnessOnly.push("agent");
      }),
  );
  assert.deepEqual(harnessOnly, ["agent"]);
});

test("a yielded predecessor stop defers as PREDECESSOR_STOP_YIELDED", () => {
  const yielded = new ComputeStopYieldedError("draining");
  assert.equal(stopYieldedCode(yielded), "AGENT_STOP_YIELDED");
  const predecessor = new PredecessorStopYieldedError(yielded);
  assert.ok(predecessor instanceof ComputeStopYieldedError);
  assert.equal(stopYieldedCode(predecessor), "PREDECESSOR_STOP_YIELDED");
  assert.equal(stopYieldedCode(new Error("failed")), undefined);
  // Both codes are yields: the deadline does not expire them, and they are rechecked as yields.
  assert.equal(isStopYieldedCode("AGENT_STOP_YIELDED"), true);
  assert.equal(isStopYieldedCode("PREDECESSOR_STOP_YIELDED"), true);
  assert.equal(isStopYieldedCode("REVISION_INCOMPLETE"), false);
  assert.equal(isStopYieldedCode("REFUSED_CANDIDATE_STOP_PENDING"), false);
});

// Finding 1195: a stop owns the revisions admitted no later than its work was created. Both
// stamps are truncated to milliseconds, so a revision admitted in the stop's millisecond
// belongs to it; otherwise the stop would end STOP_SUPERSEDED and leave that revision running.
test("a stop owns a revision admitted in the same millisecond as its work", () => {
  const stop = { createdAt: new Date("2026-10-24T12:00:00.123Z") };
  assert.equal(revisionAdmittedBeforeWork({ createdAt: "2026-10-24T12:00:00.122Z" }, stop), true);
  assert.equal(revisionAdmittedBeforeWork({ createdAt: "2026-10-24T12:00:00.123Z" }, stop), true);
  assert.equal(revisionAdmittedBeforeWork({ createdAt: "2026-10-24T12:00:00.124Z" }, stop), false);
});

// Finding 1107: lease recovery gives a deployment whose predecessor stop started one more attempt
// instead of failing it on its limit; its progress says why.
test("a deployment recovered to finish its predecessor stop says so in its progress", () => {
  const at = new Date("2026-10-11T10:00:00.000Z");
  const availableAt = new Date("2026-10-11T10:00:01.000Z");
  assert.deepEqual(
    deploymentProgressForWork(
      { state: "queued", availableAt },
      { at, code: "PREDECESSOR_STOP_RECOVERY" },
    ),
    {
      lastAttempt: {
        at: at.toISOString(),
        code: "PREDECESSOR_STOP_RECOVERY",
        message:
          "The last attempt ended while the previous version was stopping. The controller will try once more.",
      },
      nextAttemptAt: availableAt.toISOString(),
    },
  );
});

test("a deployment waiting for its predecessor's drain says so in its progress", () => {
  const at = new Date("2026-10-11T10:00:00.000Z");
  const availableAt = new Date("2026-10-11T10:00:05.000Z");
  const progress = deploymentProgressForWork(
    { state: "queued", availableAt },
    { at, code: "PREDECESSOR_STOP_YIELDED" },
  );
  assert.deepEqual(progress, {
    lastAttempt: {
      at: at.toISOString(),
      code: "PREDECESSOR_STOP_YIELDED",
      message:
        "Waiting for the previous version's gateway to finish its active work before this version starts.",
    },
    nextAttemptAt: availableAt.toISOString(),
  });
});

test("a deployment whose stopped Agent's drain yielded says so in its progress", () => {
  const at = new Date("2026-10-11T10:00:00.000Z");
  const availableAt = new Date("2026-10-11T10:00:05.000Z");
  const progress = deploymentProgressForWork(
    { state: "queued", availableAt },
    { at, code: "AGENT_STOP_YIELDED" },
  );
  assert.deepEqual(progress, {
    lastAttempt: {
      at: at.toISOString(),
      code: "AGENT_STOP_YIELDED",
      message:
        "The Agent was stopped; its gateway is finishing active work before the stop completes.",
    },
    nextAttemptAt: availableAt.toISOString(),
  });
});

// Finding 1677: the kubelet restarts a failed initialize-workspace init container, which can pass
// after an I/O or native setup failure, so that deployment waits and names the wait. A refusal
// fails every restart the same way, so it fails the deployment at once.
test("a deployment whose workspace setup Kubernetes is retrying says so in its progress", () => {
  const at = new Date("2026-10-17T10:00:00.000Z");
  const availableAt = new Date("2026-10-17T10:00:05.000Z");
  assert.deepEqual(
    deploymentProgressForWork(
      { state: "queued", availableAt },
      { at, code: "WORKSPACE_SETUP_RETRYING" },
    ),
    {
      lastAttempt: {
        at: at.toISOString(),
        code: "WORKSPACE_SETUP_RETRYING",
        message:
          "Workspace setup failed; Kubernetes is retrying it. If it keeps failing, ask an admin to check the Agent's workspace storage and runtime image.",
      },
      nextAttemptAt: availableAt.toISOString(),
    },
  );
});

test("a refused workspace setup fails the deployment saying a retry cannot help", () => {
  assert.deepEqual(
    deploymentErrorForWork({ state: "failed_permanent", reasonCode: "WORKSPACE_SETUP_REFUSED" }),
    {
      code: "WORKSPACE_SETUP_REFUSED",
      message:
        "Initial workspace setup refused this version, and retries would too: its files, setup record or runtime defaults differ from what the Agent was created with. Ask an admin to check workspace storage and the runtime image; do not delete the setup record.",
    },
  );
});

// Finding 1634: after handoff the job defers without a lease and without spending attempts while
// its first deployment converges, so status and attemptCount alone read `queued`/0 like a job
// that never ran. The status names the deployment phase and why it waits.

const updatedAt = new Date("2026-10-17T12:00:05.000Z");
const now = new Date("2026-10-17T12:00:06.000Z");
const handedOff = {
  workId: "agent-provisioning:0123456789abcdef0123456789abcdef",
  namespaceId: "ns_1",
  actorId: "principal_1",
  requestId: "req_1",
  requestFingerprint: "f".repeat(64),
  status: "running",
  completedPhase: "handoff",
  agentId: "agt_1",
  configurationId: "cfg_1",
  revisionId: "rev_1",
  plan: {},
  // The deferral's checkpoint (observeProvisioningDeployment) stores its code here.
  progress: {
    error: {
      code: "PROVISIONING_DEPLOYMENT_PENDING",
      message: "Waiting for the initial deployment to complete.",
    },
  },
  createdAt: new Date("2026-10-17T12:00:00.000Z"),
  updatedAt,
};
// A deferred job is queued again with its attempt returned and no lease.
const deferredWork = {
  kind: "provisioning",
  idempotencyKey: handedOff.workId,
  namespaceId: "ns_1",
  actorId: "principal_1",
  state: "queued",
  availableAt: new Date("2026-10-17T12:00:06.000Z"),
  attemptCount: 0,
  createdAt: handedOff.createdAt,
  updatedAt,
};
// The deployment's queued work; its progress reads only the state and the next attempt time.
const deploymentWork = { state: "queued", availableAt: new Date("2026-10-17T12:00:10.000Z") };
const nodePending = deploymentProgressForWork(deploymentWork, {
  at: new Date("2026-10-17T12:00:04.000Z"),
  code: "WORKSPACE_NODE_PENDING",
});
const ownDeferral = {
  phase: "deployment",
  lastAttempt: {
    at: updatedAt.toISOString(),
    code: "PROVISIONING_DEPLOYMENT_PENDING",
    message: "Waiting for the initial deployment to complete.",
  },
};

test("a job past handoff names the deployment's wait, or its own deferral", () => {
  const named = provisioningProgress(handedOff, deferredWork, now, nodePending);
  assert.equal(named.status, "queued");
  assert.equal(named.attemptCount, 0);
  assert.equal(named.error, undefined);
  assert.deepEqual(named.progress, {
    phase: "deployment",
    lastAttempt: {
      at: "2026-10-17T12:00:04.000Z",
      code: "WORKSPACE_NODE_PENDING",
      message: "Workloads are ready; waiting for the workspace node to connect to the Gateway.",
    },
  });

  // Without a deployment the caller may read, or a wait the deployment can name (no attempt
  // yet, or only the generic reconciliation pending), the job's own deferral stands in.
  assert.deepEqual(provisioningProgress(handedOff, deferredWork, now).progress, ownDeferral);
  for (const attempt of [undefined, { at: new Date(0), code: "SOME_DRIVER_CODE" }]) {
    assert.deepEqual(
      provisioningProgress(
        handedOff,
        deferredWork,
        now,
        deploymentProgressForWork(deploymentWork, attempt),
      ).progress,
      ownDeferral,
    );
  }
  // Handoff committed but the job has not deferred yet: the phase, with no attempt to name.
  assert.deepEqual(
    provisioningProgress({ ...handedOff, progress: {} }, deferredWork, now).progress,
    { phase: "deployment", lastAttempt: null },
  );
});

test("a job before handoff or finished reports no deployment wait", () => {
  const { revisionId: _revisionId, ...beforeHandoff } = handedOff;
  for (const [record, work] of [
    [{ ...beforeHandoff, completedPhase: "transport", progress: {} }, deferredWork],
    [
      { ...handedOff, status: "succeeded", progress: {} },
      { ...deferredWork, state: "succeeded" },
    ],
    [
      { ...handedOff, status: "failed" },
      { ...deferredWork, state: "failed_permanent" },
    ],
    [{ ...handedOff, status: "cancelled" }, deferredWork],
  ]) {
    assert.equal(
      Object.hasOwn(provisioningProgress(record, work, now, nodePending), "progress"),
      false,
      `${record.status}/${record.completedPhase}`,
    );
  }
});
