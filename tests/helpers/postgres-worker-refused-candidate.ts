import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ControllerWorkerOptions } from "../../apps/controller/src/worker.ts";
import type {
  Agent,
  AgentRevision,
  ComputeDriver,
  IAMDriver,
  RuntimeFailureEvidence,
} from "../../packages/contracts/src/index.ts";
import {
  RepositoryGitProfileUnsupportedError,
  RepositoryGitSenderUnqualifiedError,
  SandboxRevisionUnsupportedError,
  type ControllerWorkState,
} from "../../packages/occ/src/index.ts";
import type { createWorkerRevisionFixtures } from "./postgres-worker-revision-fixture.mjs";
import { waitForWorkStateDue } from "./postgres-worker-revision-support.mjs";
import { waitFor } from "./wait-for.mjs";

export type RevisionFixture = Awaited<
  ReturnType<ReturnType<typeof createWorkerRevisionFixtures>["setup"]>
>;
export type WorkerEvent = Parameters<NonNullable<ControllerWorkerOptions["emit"]>>[0];

type OwnerIdentity = { id: string };
export type WorkIdentity = OwnerIdentity & { idempotencyKey: string };
type WorkerDrivers = NonNullable<ControllerWorkerOptions["drivers"]>;
type TransformDrivers = (drivers: WorkerDrivers) => WorkerDrivers | undefined;
type ReadinessCheck = (revision: AgentRevision) => boolean;

interface RefusedCandidate {
  owner: Readonly<Agent>;
  first: WorkIdentity;
  replacement: WorkIdentity;
  driver: ReturnType<typeof countingExclusiveCompute>;
  compute: ComputeDriver;
  admittedAt: number;
}

interface ExclusiveComputeOptions {
  ready?: ReadinessCheck;
  onPrepare?: (revision: AgentRevision, overlap: string[]) => void | Promise<void>;
  runtimeFailure?: (revision: AgentRevision) => RuntimeFailureEvidence | undefined;
}

interface RefusedOptions {
  refuse?: string;
  stopRevision?: (revision: AgentRevision) => Promise<void> | undefined;
  emit?: ControllerWorkerOptions["emit"];
  ready?: ReadinessCheck;
  refusing?: () => boolean;
  candidateReady?: () => boolean;
  startOptions?: Pick<ControllerWorkerOptions, "convergenceTimeoutMs"> & {
    transformDrivers?: TransformDrivers;
  };
}

/**
 * An exclusive Compute that counts stops and preparations; a candidate is ready only once no
 * predecessor of its Agent still runs.
 */
export function countingExclusiveCompute(
  fixture: Pick<RevisionFixture, "compute">,
  { ready, onPrepare, runtimeFailure }: ExclusiveComputeOptions = {},
) {
  const running = new Set<string>();
  const agents = new Map<string, string>();
  const prepared: string[] = [];
  const stops = new Map<string, number>();
  const compute: ComputeDriver = {
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
  const count = (revision: OwnerIdentity) => stops.get(revision.id) ?? 0;
  const preparations = (revision: OwnerIdentity) =>
    prepared.filter((id) => id === revision.id).length;
  return { compute, running, count, preparations };
}

/** The restriction revokes the actor's `deploy` access on this Agent. */
export function denyDeploy(
  fixture: Pick<RevisionFixture, "observerPool" | "namespace">,
  owner: OwnerIdentity,
) {
  return fixture.observerPool.query<Record<string, unknown>>(
    `INSERT INTO occ.iam_restrictions
       (id, namespace_id, action, resource_kind, resource_id, effect)
     VALUES ($1, $2, 'deploy', 'agent', $3, 'deny')`,
    [`restriction-${randomUUID()}`, fixture.namespace.id, owner.id],
  );
}

/**
 * Starts the refused-candidate scenario: an exclusive Agent whose first revision activated and
 * whose replacement's first pass started its runtime but is not ready. `refuse` decides how later
 * passes fail: "revoked" denies `deploy` (the next pass refuses it), "unsupported" is refused
 * by Compute, "unqualified" by its Credential Proxy (an upgraded worker refusing a revision
 * admitted with an unqualified Git sender), and "undeliverable" by it too (a Git plan with no
 * delivery profile, such as git-read). The self-failures "held" (a held model-probe
 * failure) and "retried" (an ordinary error) are not refusals. Any other value, such as
 * "late", only leaves the candidate unready. `stopRevision(revision)` returns undefined to use
 * the counting driver's stop or a promise that replaces it, for example a failing stop.
 * `compute` restarts the worker. `refusing()` false lets Compute accept the candidate again, and
 * `candidateReady()` makes it ready; `startOptions` go to the worker. `admittedAt` is the time
 * just before the replacement was admitted.
 */
export async function startRefusedCandidate(
  fixture: RevisionFixture,
  label: string,
  {
    refuse = "revoked",
    stopRevision = () => undefined,
    emit,
    ready,
    refusing = () => true,
    candidateReady = () => false,
    startOptions = {},
  }: RefusedOptions = {},
): Promise<RefusedCandidate> {
  const owner = await fixture.agent(label, { executionMode: "dedicated" });
  const candidate: { id?: string } = {};
  let candidatePasses = 0;
  const driver = countingExclusiveCompute(fixture, {
    ready: (revision) =>
      revision.id === candidate.id ? candidateReady() : (ready?.(revision) ?? true),
    runtimeFailure: (revision) =>
      refuse === "held" && revision.id === candidate.id && candidatePasses > 1
        ? {
            component: "agent",
            check: "model-probe",
            checkedAt: "2026-10-10T02:24:00.000Z",
            code: "MODEL_PROBE_FAILED",
            cause: { kind: "PROBE_STATUS", detail: "format" },
          }
        : undefined,
    async onPrepare(revision) {
      if (revision.id !== candidate.id) {
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
      if (refuse === "unqualified" && candidatePasses > 1 && refusing()) {
        throw new RepositoryGitSenderUnqualifiedError();
      }
      if (refuse === "undeliverable" && candidatePasses > 1 && refusing()) {
        throw new RepositoryGitProfileUnsupportedError(1);
      }
      if (refuse === "retried" && candidatePasses > 1) {
        throw new Error("Kubernetes API temporarily unavailable");
      }
    },
  });
  const compute: ComputeDriver = {
    ...driver.compute,
    async stopRevision(revision) {
      return (
        (revision.id === candidate.id ? stopRevision(revision) : undefined) ??
        driver.compute.stopRevision(revision)
      );
    },
  };
  await fixture.start(compute, { emit, ...startOptions });
  const first: WorkIdentity = await fixture.revision(owner, 1);
  await fixture.work(first, "succeeded");
  const admittedAt = Date.now();
  const replacement: WorkIdentity = await fixture.revision(owner, 2);
  candidate.id = replacement.id;
  assert.ok(owner !== null && typeof owner === "object" && !Array.isArray(owner));
  assert.equal(typeof owner.id, "string");
  assertWorkIdentity(first);
  assertWorkIdentity(replacement);
  assert.ok([...driver.running].every((id) => typeof id === "string"));
  return { owner, first, replacement, driver, compute, admittedAt };
}

function assertWorkIdentity(work: WorkIdentity) {
  assert.ok(work !== null && typeof work === "object" && !Array.isArray(work));
  assert.equal(typeof work.id, "string");
  assert.equal(typeof work.idempotencyKey, "string");
}

/**
 * A refused candidate's `stopRevision` for startRefusedCandidate that fails with `message` until
 * `succeed()` is called or it has failed `limit` times. `failed` holds each failure's start time.
 */
export function failingStop({
  limit = Infinity,
  message = "Kubernetes API temporarily unavailable",
} = {}) {
  const failed: number[] = [];
  let succeeding = false;
  return {
    failed,
    succeed() {
      succeeding = true;
    },
    /** Waits until the stop has failed `count` times. */
    waitForFailures(count: number, timeoutMs?: Parameters<typeof waitFor>[2]) {
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
export function refusedStopWaits(events: readonly WorkerEvent[], candidate: WorkIdentity) {
  return events.filter(
    ({ event, workId, outcome, refusal }) =>
      event === "worker.completed" &&
      workId === candidate.idempotencyKey &&
      outcome === "pending" &&
      refusal !== undefined,
  );
}

/** Waits until `count` passes could not stop the refused candidate. */
export function waitForRefusedStopWaits(
  events: readonly WorkerEvent[],
  candidate: WorkIdentity,
  count: number,
  timeoutMs?: Parameters<typeof waitFor>[2],
) {
  return waitFor(
    `${count} logged refused-stop waits`,
    async () => (refusedStopWaits(events, candidate).length >= count ? true : undefined),
    timeoutMs,
  );
}

/**
 * Waits for the work to reach `state` and checks the reason code it recorded. With `due`, each
 * miss makes the work's queued retry due, for a test that waits on its refused stop's retries
 * but not on their backoff.
 */
export async function assertWorkEnds(
  fixture: Pick<RevisionFixture, "observerPool"> & {
    work(candidate: WorkIdentity, state: ControllerWorkState, timeoutMs: number): Promise<unknown>;
    workResult(candidate: WorkIdentity): Promise<{ rows: { reason_code: string | null }[] }>;
  },
  work: WorkIdentity,
  state: ControllerWorkState,
  code: string,
  { due = false } = {},
) {
  await (due ? waitForWorkStateDue(fixture, work, state) : fixture.work(work, state, 30_000));
  const result = await fixture.workResult(work);
  const [outcome] = result.rows;
  assert.ok(outcome, "missing persisted work outcome");
  assert.equal(outcome.reason_code, code);
}

/** Worker drivers whose IAM Driver answers through `authorize(iam, request)`. */
export function proxiedIAM(
  authorize: (
    iam: IAMDriver,
    request: Parameters<IAMDriver["authorize"]>[0],
  ) => ReturnType<IAMDriver["authorize"]>,
): TransformDrivers {
  return (drivers) => ({
    ...drivers,
    createIAMDriver(platformState) {
      const iam = drivers.createIAMDriver(platformState);
      return new Proxy(iam, {
        get(target, key) {
          if (key === "authorize") {
            return (request: Parameters<IAMDriver["authorize"]>[0]) => authorize(target, request);
          }
          const value: unknown = Reflect.get(target, key, target);
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
  unqualified: "REPOSITORY_GIT_SENDER_UNQUALIFIED",
  undeliverable: "REPOSITORY_GIT_PROFILE_UNSUPPORTED",
} as const;
