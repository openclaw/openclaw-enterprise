import assert from "node:assert/strict";
import test from "node:test";

import { provisioningProgress } from "../../packages/occ/src/agent-provisioning.ts";
import { deploymentProgressForWork } from "../../packages/occ/src/state/controller-work.ts";

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
const deploymentWork = {
  kind: "lifecycle",
  idempotencyKey: "agent_revision:rev_1:reconcile",
  namespaceId: "ns_1",
  agentId: "agt_1",
  revisionId: "rev_1",
  actorId: "principal_1",
  state: "queued",
  availableAt: new Date("2026-10-17T12:00:10.000Z"),
  attemptCount: 0,
  createdAt: handedOff.createdAt,
  updatedAt,
};
const ownDeferral = {
  phase: "deployment",
  lastAttempt: {
    at: updatedAt.toISOString(),
    code: "PROVISIONING_DEPLOYMENT_PENDING",
    message: "Waiting for the initial deployment to complete.",
  },
};

test("a job past handoff names the deployment's wait, or its own deferral", () => {
  const nodePending = deploymentProgressForWork(deploymentWork, {
    at: new Date("2026-10-17T12:00:04.000Z"),
    code: "WORKSPACE_NODE_PENDING",
  });
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
  const nodePending = deploymentProgressForWork(deploymentWork, {
    at: new Date("2026-10-17T12:00:04.000Z"),
    code: "WORKSPACE_NODE_PENDING",
  });
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
