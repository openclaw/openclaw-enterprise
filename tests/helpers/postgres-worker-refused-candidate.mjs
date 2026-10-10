import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SandboxRevisionUnsupportedError } from "../../packages/occ/src/index.ts";
import { waitFor } from "./wait-for.mjs";

// Refused-candidate fakes shared by the worker revision -health and -refused-stop test files:
// an exclusive counting Compute, a refused replacement candidate, a failing stop, and waits on
// the stop's logged refusals. Test file names stay out of comments here: CI Impact sends a
// test-only change to full CI when another file names that test.

/**
 * An exclusive Compute that counts stops and preparations; a candidate is ready only once no
 * predecessor of its Agent still runs.
 */
export function countingExclusiveCompute(fixture, { ready, onPrepare, runtimeFailure } = {}) {
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

/** The actor loses `deploy` on the Agent, as removing its grants did on oce-dogfood-b. */
export function denyDeploy(fixture, owner) {
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
export async function startRefusedCandidate(
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
export function failingStop({
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
export function refusedStopWaits(events, candidate) {
  return events.filter(
    ({ event, workId, outcome, refusal }) =>
      event === "worker.completed" &&
      workId === candidate.idempotencyKey &&
      outcome === "pending" &&
      refusal !== undefined,
  );
}

/** Waits until `count` passes could not stop the refused candidate. */
export function waitForRefusedStopWaits(events, candidate, count, timeoutMs) {
  return waitFor(
    `${count} logged refused-stop waits`,
    async () => (refusedStopWaits(events, candidate).length >= count ? true : undefined),
    timeoutMs,
  );
}

/** Waits for the work to reach `state` and checks the reason code it recorded. */
export async function assertWorkEnds(fixture, work, state, code) {
  await fixture.work(work, state, 30_000);
  const result = await fixture.workResult(work);
  assert.equal(result.rows[0].reason_code, code);
}

/** Worker drivers whose IAM Driver answers through `authorize(iam, request)`. */
export function proxiedIAM(authorize) {
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

// The refusal codes a refused candidate's work ends with.
export const refusals = {
  revoked: "AUTHORIZATION_DENIED",
  unsupported: "SANDBOX_HARNESS_UNSUPPORTED",
};
