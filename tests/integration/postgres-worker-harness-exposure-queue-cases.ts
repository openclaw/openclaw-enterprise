import assert from "node:assert/strict";
import { OpenShellDeletionUnconfirmedError } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-errors.ts";
import type { ControllerWorkerOptions } from "../../apps/controller/src/worker.ts";
import type {
  ComputeDriver,
  RevisionHarnessDescriptor,
} from "../../packages/contracts/src/index.ts";
import type { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";
import { completedPasses } from "../helpers/postgres-worker-revision-queue.ts";
import { waitFor } from "../helpers/wait-for.mjs";

type WorkerRevisionFixtures = ReturnType<typeof createWorkerRevisionFixtures>;
type RevisionFixture = Awaited<ReturnType<WorkerRevisionFixtures["setup"]>>;
type WorkerEvent = Parameters<NonNullable<ControllerWorkerOptions["emit"]>>[0];
type QueueEvent = WorkerEvent & { event?: string; workId?: string; outcome?: string };

function checkedQueueEvent(event: WorkerEvent): QueueEvent {
  for (const key of ["event", "workId", "outcome"]) {
    assert.ok(event[key] === undefined || typeof event[key] === "string", `invalid worker ${key}`);
  }
  return event;
}

async function seedActiveAndFailedNativeExposureRevisions(fixture: RevisionFixture) {
  const sandboxDriverId = "native-sandbox";
  const nativeHarness = {
    ...fixture.productionHarness,
    id: "openclaw",
    mode: "dedicated",
  } satisfies RevisionHarnessDescriptor;
  const native = { harness: nativeHarness, sandboxDriverId };
  const { owner: served, candidate: active } = await fixture.admitInitialRevision("served", {
    agent: { executionMode: "dedicated" },
    revision: native,
  });
  const actorId: unknown = fixture.actor.id;
  assert.ok(typeof actorId === "string");
  const failed = await fixture.revision(served, 2, { ...native, actorId });
  // A newly started worker finds a served revision and a newer failed candidate.
  await fixture.observerPool.query(
    `UPDATE occ.controller_work
     SET state = 'succeeded', reason_code = 'REVISION_ACTIVATED', completed_at = clock_timestamp()
     WHERE idempotency_key = $1`,
    [active.idempotencyKey],
  );
  await fixture.observerPool.query(
    `UPDATE occ.controller_work
     SET state = 'failed_permanent', reason_code = 'DEPENDENCY_UNAVAILABLE', completed_at = clock_timestamp()
     WHERE idempotency_key = $1`,
    [failed.idempotencyKey],
  );
  await fixture.observerPool.query(
    "UPDATE occ.agents SET active_revision_id = $2, desired_runtime_state = 'running' WHERE id = $1",
    [served.id, active.id],
  );
  return { served, active, failed };
}

export function registerHarnessExposureQueueCases({ revisionTest }: WorkerRevisionFixtures): void {
  // Finding 1695: the sweep step ran only on passes after an empty claim, so a worker whose queue
  // is never empty never withdrew a second listed exposure (the first goes on the first pass).
  // It now also runs after every five claimed passes in a row.
  revisionTest(
    "a saturated queue still gets a sweep step after five claimed passes",
    async (fixture: RevisionFixture) => {
      const { active, failed } = await seedActiveAndFailedNativeExposureRevisions(fixture);
      // Eight deployments queued before the worker starts keep every claim busy.
      const busy: Awaited<ReturnType<RevisionFixture["revision"]>>[] = [];
      for (let index = 0; index < 8; index += 1) {
        busy.push((await fixture.admitInitialRevision(`busy-${index}`)).candidate);
      }
      const events: QueueEvent[] = [];
      const withdrawals: string[] = [];
      await fixture.start(
        {
          ...fixture.compute,
          async withdrawHarnessExposure(revision) {
            withdrawals.push(revision.id);
          },
        } satisfies ComputeDriver,
        { emit: (event) => events.push(checkedQueueEvent(event)) },
      );
      // Each deployment's worker.completed follows the commit that marks its Work succeeded, so
      // wait for the events counted below, not the rows (finding 2283).
      await Promise.all(busy.map((candidate) => completedPasses(events, candidate)));
      const indices = (name: string) =>
        events.flatMap(({ event }, index) => (event === name ? [index] : []));
      await waitFor("both listed exposures to be withdrawn", async () =>
        indices("worker.harness-exposure-withdrawn").length >= 2 ? true : undefined,
      );
      assert.deepEqual(new Set(withdrawals), new Set([active.id, failed.id]));
      const completed = indices("worker.completed");
      const [firstWithdrawal, secondWithdrawal] = indices("worker.harness-exposure-withdrawn");
      assert.ok(completed.length >= 8, `claimed passes: ${completed.length}`);
      const firstCompletion = completed[0];
      const lastCompletion = completed.at(-1);
      assert.ok(firstCompletion !== undefined && lastCompletion !== undefined);
      assert.ok(firstWithdrawal !== undefined && secondWithdrawal !== undefined);
      // The first withdrawal is the start pass's; the second ran after at most five claimed passes
      // (one claim per pass, so five completions), before the queue drained, not on the idle pass
      // after it.
      assert.ok(
        firstWithdrawal < firstCompletion,
        `first withdrawal at ${firstWithdrawal}, passes ${completed}`,
      );
      const between = completed.filter(
        (index) => index > firstWithdrawal && index < secondWithdrawal,
      );
      assert.ok(
        between.length >= 1 && between.length <= 5 && secondWithdrawal < lastCompletion,
        `second withdrawal at ${secondWithdrawal}, passes ${completed}`,
      );
      assert.equal(indices("worker.harness-exposure-withdrawal-failed").length, 0);
    },
  );

  // Finding 1696: a candidate retired between the sweep's read and its delete answers NOT_FOUND
  // on the delete. That is unconfirmed, not failed: the Driver reports it by code and the sweep
  // logs it apart, with the same bounded retry; the next attempt settles it through the Driver's
  // absence check.
  revisionTest(
    "a target gone between the sweep's read and delete is logged unconfirmed",
    async (fixture: RevisionFixture) => {
      const { served, active, failed } = await seedActiveAndFailedNativeExposureRevisions(fixture);
      const events: WorkerEvent[] = [];
      const withdrawals: string[] = [];
      await fixture.start(
        {
          ...fixture.compute,
          async withdrawHarnessExposure(revision) {
            withdrawals.push(revision.id);
            if (revision.id === failed.id) {
              // DeleteService answered NOT_FOUND for a service GetService had just found.
              // The wire conformance test covers how the gateway response becomes this error.
              throw new OpenShellDeletionUnconfirmedError(
                "OpenShell DeleteService did not find the Sandbox, so the deletion is unconfirmed.",
              );
            }
          },
        } satisfies ComputeDriver,
        { emit: (event) => events.push(event) },
      );
      const named = (name: string) => events.filter(({ event }) => event === name);
      await waitFor("both listed exposures to be attempted", async () =>
        withdrawals.includes(active.id) && withdrawals.includes(failed.id) ? true : undefined,
      );
      await waitFor("the unconfirmed withdrawal to be logged", async () =>
        named("worker.harness-exposure-withdrawal-unconfirmed").length > 0 ? true : undefined,
      );
      assert.deepEqual(named("worker.harness-exposure-withdrawal-unconfirmed"), [
        {
          event: "worker.harness-exposure-withdrawal-unconfirmed",
          namespaceId: fixture.namespace.id,
          agentId: served.id,
          revisionId: failed.id,
          code: "SANDBOX_DELETION_UNCONFIRMED",
          attempt: 1,
          outcome: "retry",
        },
      ]);
      assert.deepEqual(named("worker.harness-exposure-withdrawal-failed"), []);
      assert.deepEqual(
        named("worker.harness-exposure-withdrawn").map(({ revisionId }) => revisionId),
        [active.id],
      );
      // The retry waits for its backoff like a failure does.
      assert.equal(withdrawals.filter((id) => id === failed.id).length, 1);
    },
  );
}
