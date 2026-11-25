import assert from "node:assert/strict";
import type { ComputeDriver } from "../../packages/contracts/src/index.ts";
import {
  KubernetesSecretWriteForbiddenError,
  SandboxRevisionUnsupportedError,
} from "../../packages/occ/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import type { RevisionFixture, WorkerEvent } from "../helpers/postgres-worker-refused-candidate.ts";
import { completion } from "../helpers/postgres-worker-revision-queue.ts";
import {
  assertFailedDeployment,
  runPreparationFailureCase,
} from "../helpers/postgres-worker-revision-scenarios.ts";

type RefusalFixture = Pick<
  RevisionFixture,
  "admitInitialRevision" | "actor" | "controller" | "compute" | "namespace" | "start" | "workResult"
> & {
  work(...args: Parameters<RevisionFixture["work"]>): Promise<unknown>;
};
function refusalScenario(fixture: RefusalFixture): Parameters<typeof runPreparationFailureCase>[0] {
  const { admitInitialRevision, compute, start, work, workResult } = fixture;
  return {
    admitInitialRevision,
    compute,
    start,
    async work(candidate, expected, timeoutMs) {
      const row = asRecord(await work(candidate, expected, timeoutMs));
      assert.ok(row && row.state === expected, "missing expected work row");
      const { claim_token, attempt_count } = row;
      assert.ok(
        claim_token === null || typeof claim_token === "string",
        "invalid work claim token",
      );
      assert.ok(typeof attempt_count === "number", "invalid work attempt count");
      return { state: expected, claim_token, attempt_count };
    },
    workResult,
    deploymentStatus(owner, candidate) {
      return fixture.controller.getDeploymentStatus(
        fixture.actor.id,
        fixture.namespace.id,
        owner.id,
        candidate.id,
      );
    },
  };
}

export async function assertFailedReplacementStaysActive(
  fixture: RefusalFixture & Pick<RevisionFixture, "observerPool" | "revision">,
): Promise<void> {
  // Kubernetes embedded replacement reports a new revision ready while its
  // predecessor serves, publishes it, and only then replaces the shared
  // gateway. When the replacement's startup model probe then rejects the
  // credential, the predecessor no longer runs: the failed revision owns the
  // only runtime, so it stays active for stop, deletion, and diagnostics
  // until a later revision replaces it. OCC never rolls back automatically.
  const { owner, candidate: healthy } = await fixture.admitInitialRevision(
    "failed-published-replacement",
  );
  let rejectCredential = false;
  const activations: string[] = [];
  const retired: string[] = [];
  const compute: ComputeDriver = {
    ...fixture.compute,
    async prepareRevision(revision) {
      const observation = await fixture.compute.prepareRevision(revision);
      // The first observation of a replacement reflects the serving predecessor.
      if (!rejectCredential || !activations.includes(revision.id)) {
        return observation;
      }
      return {
        ...observation,
        ready: false,
        runtimeFailure: {
          component: "gateway",
          check: "model-probe",
          checkedAt: "2026-09-30T17:14:54.000Z",
          code: "AUTHENTICATION_FAILED",
        },
      };
    },
    async activateRevision(revision) {
      activations.push(revision.id);
      if (rejectCredential) {
        throw new Error("The exact AgentRevision gateway is not ready.");
      }
    },
    async retireRevision(revision) {
      retired.push(revision.id);
      return fixture.compute.retireRevision(revision);
    },
  };
  await fixture.start(compute);
  await fixture.work(healthy, "succeeded");
  const activeRevision = async () => {
    const pointer = await fixture.observerPool.query<
      { active_revision_id: string | null },
      [string, string]
    >("SELECT active_revision_id FROM occ.agents WHERE namespace_id = $1 AND id = $2", [
      fixture.namespace.id,
      owner.id,
    ]);
    const row = pointer.rows[0];
    assert.ok(row, "the Agent has an active revision row");
    return row.active_revision_id;
  };
  assert.equal(await activeRevision(), healthy.id);

  rejectCredential = true;
  const rejected = await fixture.revision(owner, 2);
  await fixture.work(rejected, "failed_permanent");
  const codes = await fixture.observerPool.query<{ reason: string | null }, [string]>(
    `SELECT details->>'reasonCode' AS reason FROM occ.audit_events
         WHERE resource_id = $1 AND action = 'reconcile' ORDER BY occurred_at`,
    [rejected.id],
  );
  assert.deepEqual(
    [...new Set(codes.rows.map(({ reason }) => reason))],
    ["REVISION_FINALIZATION_INCOMPLETE", "RUNTIME_AUTHENTICATION_FAILED"],
  );
  const status = await refusalScenario(fixture).deploymentStatus(owner, rejected);
  assert.equal(status.status, "failed");
  assert.ok(status.error, "the failed deployment has an error");
  assert.equal(status.error.code, "RUNTIME_AUTHENTICATION_FAILED");
  assert.equal(await activeRevision(), rejected.id);
  assert.deepEqual(retired, []);

  // Recovery is a new, higher revision; it replaces the failed one.
  rejectCredential = false;
  const repaired = await fixture.revision(owner, 3);
  await fixture.work(repaired, "succeeded");
  assert.equal(await activeRevision(), repaired.id);
  assert.deepEqual(retired.toSorted(), [healthy.id, rejected.id].toSorted());
}

export async function assertUnsupportedSandboxRefusal(fixture: RefusalFixture): Promise<void> {
  // The OpenShell SandboxDriver cannot project secretKeyRef environment. The
  // same revision fails the same way on every attempt, so it is terminal.
  const preparations = await runPreparationFailureCase(refusalScenario(fixture), {
    label: "sandbox-unsupported",
    failure: () =>
      new SandboxRevisionUnsupportedError(
        "SANDBOX_SECRET_ENVIRONMENT_UNSUPPORTED",
        "OpenShell cannot receive secretKeyRef environment APP_SERVER_TOKEN.",
      ),
    expected: {
      error: {
        code: "SANDBOX_SECRET_ENVIRONMENT_UNSUPPORTED",
        message:
          "The Sandbox Driver cannot deliver Secret-backed environment variables to the Harness. Use credential sources instead of Secret bindings, or ask an Installation administrator for a Sandbox Driver that supports them, then deploy again.",
      },
    },
  });
  assert.equal(preparations, 1);
}

export async function assertGatewayLabelRefusal(fixture: RefusalFixture): Promise<void> {
  // The OpenShell gateway rejects label keys missing from its allowed_pod_labels on every
  // CreateSandbox, so retrying cannot help until an operator changes its configuration.
  // The gateway wire test proves the client raises this error for the gateway's refusal.
  const preparations = await runPreparationFailureCase(refusalScenario(fixture), {
    label: "sandbox-pod-labels",
    failure: () =>
      new SandboxRevisionUnsupportedError(
        "SANDBOX_POD_LABELS_NOT_PERMITTED",
        "OpenShell refused the Harness Pod labels app.kubernetes.io/managed-by; add them to the gateway's Kubernetes driver allowed_pod_labels.",
      ),
    expected: {
      error: {
        code: "SANDBOX_POD_LABELS_NOT_PERMITTED",
        message:
          "The Sandbox gateway refuses this revision's Harness Pod labels. Ask an admin to allow them in the gateway configuration, then deploy again.",
      },
    },
  });
  assert.equal(preparations, 1);
}

export async function assertSecretWriteRefusal(fixture: RefusalFixture): Promise<void> {
  // Finding 1770 (D503): an RBAC grant, admission policy or quota that refuses the write
  // refuses every retry too, so the deployment fails at once with a status that names the
  // refusal and the grant to check, instead of five DEPENDENCY_UNAVAILABLE retries and
  // "Deployment reconciliation failed.". The Driver keeps only the HTTP status and Status
  // reason as the cause (tests/conformance/kubernetes-compute.test.mjs pins that shape), and
  // the worker log keeps both. A 429, 5xx or timeout stays a TransientDependencyError, which
  // waits for the convergence deadline (the KUBERNETES_API_UNAVAILABLE case below).
  const admitted = await fixture.admitInitialRevision("private-secret-write-forbidden");
  const events: WorkerEvent[] = [];
  let preparations = 0;
  await fixture.start(
    {
      ...fixture.compute,
      async prepareRevision() {
        preparations += 1;
        const refused = new KubernetesSecretWriteForbiddenError();
        refused.cause = Object.assign(
          new Error("The Kubernetes API answered HTTP 403 (Forbidden)."),
          { code: 403, reason: "Forbidden" },
        );
        throw refused;
      },
    },
    { emit: (event) => events.push(event) },
  );
  await assertFailedDeployment(refusalScenario(fixture), admitted, {
    error: {
      code: "KUBERNETES_SECRET_WRITE_FORBIDDEN",
      message:
        "Kubernetes refused access to a Secret this version needs (HTTP 403 Forbidden), so the controller did not retry. Ask a platform operator to check the worker's tenant RoleBindings for secrets and any admission policy or ResourceQuota, then deploy again.",
    },
  });
  assert.equal(preparations, 1);
  const completed = events.filter(
    (event) => event.event === "worker.completed" && event.revisionId === admitted.candidate.id,
  );
  assert.deepEqual(
    completed.map(({ outcome, code, cause, status, reason }) => ({
      outcome,
      code,
      cause,
      status,
      reason,
    })),
    [
      {
        outcome: "permanent",
        code: "KUBERNETES_SECRET_WRITE_FORBIDDEN",
        cause: "KubernetesSecretWriteForbiddenError",
        status: 403,
        reason: "Forbidden",
      },
    ],
  );
}

function isMaintenanceWork(workId: unknown, prefix: string): boolean {
  if (workId === null || workId === undefined) {
    return false;
  }
  if (typeof workId !== "string") {
    throw new TypeError("Expected a string work ID");
  }
  return workId.startsWith(prefix);
}

function revisionMaintenanceRefusal(
  ...[step, label]: ["prepareRevision", "preparation"] | ["activateRevision", "activation"]
) {
  async function run(
    fixture: RefusalFixture & Pick<RevisionFixture, "currentAgent">,
  ): Promise<void> {
    const { owner, candidate } = await fixture.admitInitialRevision(
      `maintenance-secret-forbidden-${label}`,
    );
    const events: WorkerEvent[] = [];
    let refuse = false;
    const compute: ComputeDriver = {
      ...fixture.compute,
      maintenanceIntervalMs: 200,
    };
    if (step === "prepareRevision") {
      compute.prepareRevision = async (...args) => {
        if (refuse) {
          throw new KubernetesSecretWriteForbiddenError();
        }
        return fixture.compute.prepareRevision(...args);
      };
    } else {
      compute.activateRevision = async (...args) => {
        if (refuse) {
          throw new KubernetesSecretWriteForbiddenError();
        }
        // The fixture's Compute has no activation step of its own.
        return fixture.compute.activateRevision?.(...args);
      };
    }
    await fixture.start(compute, { emit: (event) => events.push(event) });
    await fixture.work(candidate, "succeeded");
    refuse = true;
    const maintenance = `agent_revision:${candidate.id}:maintenance:`;
    const refused = await completion(
      events,
      "a maintenance pass refused with 403",
      (event) =>
        event.event === "worker.completed" &&
        isMaintenanceWork(event.workId, maintenance) &&
        event.cause === "KubernetesSecretWriteForbiddenError",
    );
    assert.deepEqual(
      { outcome: refused.outcome, code: refused.code },
      { outcome: "pending", code: "REVISION_FINALIZATION_INCOMPLETE" },
    );
    refuse = false;
    await completion(
      events,
      "a later maintenance pass to succeed",
      (event, index) =>
        index > events.indexOf(refused) &&
        event.event === "worker.completed" &&
        isMaintenanceWork(event.workId, maintenance) &&
        event.outcome === "success",
    );
    const current = await fixture.currentAgent(owner);
    assert.ok(current, "the Agent is still stored");
    assert.equal(current.activeRevisionId, candidate.id);
    assert.equal(
      (await refusalScenario(fixture).deploymentStatus(owner, candidate)).status,
      "succeeded",
    );
  }
  return { label, run };
}

export const maintenanceRefusalCases = [
  revisionMaintenanceRefusal("prepareRevision", "preparation"),
  revisionMaintenanceRefusal("activateRevision", "activation"),
];
