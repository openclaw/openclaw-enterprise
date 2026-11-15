import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import {
  ControllerWorker,
  type ControllerWorkerOptions,
} from "../../apps/controller/src/worker.ts";
import type {
  ComputeDriver,
  RevisionHarnessDescriptor,
} from "../../packages/contracts/src/index.ts";
import { SandboxRevisionUnsupportedError, type ClaimedWork } from "../../packages/occ/src/index.ts";
import type { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";
import { deferWork, makeWorkDue } from "../helpers/postgres-worker-revision-queue.ts";
import { waitUntil } from "../helpers/wait-for.mjs";

type RevisionFixtures = ReturnType<typeof createWorkerRevisionFixtures>;
type RevisionFixture = Awaited<ReturnType<RevisionFixtures["setup"]>>;
type WorkerEvent = Parameters<NonNullable<ControllerWorkerOptions["emit"]>>[0];
// The legacy fixture infers only its defaulted revision options.
type NativeRevisionOptions = NonNullable<Parameters<RevisionFixture["revision"]>[2]> & {
  harness: RevisionHarnessDescriptor;
  sandboxDriverId: string;
};

const SANDBOX_DRIVER_ID = "native-sandbox";
const NAMESPACE_LISTING_SQL =
  "FROM occ.namespaces WHERE deleted_at IS NULL ORDER BY created_at, id";

function nativeRevisionOptions(fixture: RevisionFixture): NativeRevisionOptions {
  return {
    harness: { ...fixture.productionHarness, id: "openclaw", mode: "dedicated" },
    sandboxDriverId: SANDBOX_DRIVER_ID,
  };
}

function admittedAgentId(revision: { agentId: unknown }): string {
  const { agentId } = revision;
  assert.ok(typeof agentId === "string");
  return agentId;
}

export function registerHarnessExposureSweepCases({ revisionTest }: RevisionFixtures): void {
  // A Kubernetes Compute declares no maintenance interval, so a native OpenShell revision that
  // is already active when the worker starts, or a newer candidate that failed for good with its
  // Sandbox kept for diagnosis, never gets a pass that would withdraw its exposure. The worker
  // lists them once at start and withdraws one per pass through Compute's hook, with bounded,
  // logged retries; a pending deployment, a Codex Harness and a revision without a Sandbox Driver
  // are left to their own passes or have no exposure to withdraw.
  revisionTest(
    "the worker withdraws native Harness exposures of revisions that get no preparation pass",
    async (fixture: RevisionFixture) => {
      const native = nativeRevisionOptions(fixture);
      const { owner: served, candidate: active } = await fixture.admitInitialRevision("served", {
        agent: { executionMode: "dedicated" },
        revision: native,
      });
      const failed = await fixture.revision(served, 2, native);
      const { owner: codexOwner, candidate: codex } = await fixture.admitInitialRevision("codex", {
        agent: { executionMode: "dedicated" },
        revision: { sandboxDriverId: SANDBOX_DRIVER_ID },
      });
      const { owner: plainOwner, candidate: plain } = await fixture.admitInitialRevision("plain", {
        agent: { executionMode: "dedicated" },
        revision: { harness: native.harness },
      });
      const { candidate: pending } = await fixture.admitInitialRevision("pending", {
        agent: { executionMode: "dedicated" },
        revision: native,
      });
      // The durable state the worker finds at start: three activated deployments, one newer
      // candidate that failed for good, and one deployment still waiting for its pass.
      await fixture.observerPool.query(
        `UPDATE occ.controller_work
         SET state = 'succeeded', reason_code = 'REVISION_ACTIVATED', completed_at = clock_timestamp()
         WHERE idempotency_key = ANY($1::text[])`,
        [[active.idempotencyKey, codex.idempotencyKey, plain.idempotencyKey]],
      );
      await fixture.observerPool.query(
        `UPDATE occ.controller_work
         SET state = 'failed_permanent', reason_code = 'DEPENDENCY_UNAVAILABLE', completed_at = clock_timestamp()
         WHERE idempotency_key = $1`,
        [failed.idempotencyKey],
      );
      await deferWork(fixture.observerPool, pending.idempotencyKey);
      for (const [agentId, revisionId] of [
        [served.id, active.id],
        [codexOwner.id, codex.id],
        [plainOwner.id, plain.id],
      ] satisfies [string, string][]) {
        await fixture.observerPool.query(
          "UPDATE occ.agents SET active_revision_id = $2, desired_runtime_state = 'running' WHERE id = $1",
          [agentId, revisionId],
        );
      }
      const withdrawals: string[] = [];
      const events: WorkerEvent[] = [];
      // The served revision's first withdrawal is not confirmed: it is logged and retried later.
      let refuseFirstActiveWithdrawal = true;
      await fixture.start(
        {
          ...fixture.compute,
          async withdrawHarnessExposure(revision, signal) {
            assert.ok(signal instanceof AbortSignal);
            withdrawals.push(revision.id);
            if (revision.id === active.id && refuseFirstActiveWithdrawal) {
              refuseFirstActiveWithdrawal = false;
              throw new Error("OpenShell DeleteService did not confirm deletion.");
            }
          },
        } satisfies ComputeDriver,
        { emit: (event) => events.push(event) },
      );
      const named = (name: string) => events.filter(({ event }) => event === name);
      await waitUntil("the failed candidate's exposure to be withdrawn", () =>
        named("worker.harness-exposure-withdrawn").some(
          ({ revisionId }) => revisionId === failed.id,
        ),
      );
      await waitUntil(
        "the served revision's first withdrawal to be logged",
        () => named("worker.harness-exposure-withdrawal-failed").length > 0,
      );
      assert.deepEqual(named("worker.harness-exposure-sweep"), [
        { event: "worker.harness-exposure-sweep", pending: 2 },
      ]);
      assert.deepEqual(named("worker.harness-exposure-withdrawal-failed"), [
        {
          event: "worker.harness-exposure-withdrawal-failed",
          namespaceId: fixture.namespace.id,
          agentId: served.id,
          revisionId: active.id,
          code: "HARNESS_EXPOSURE_WITHDRAWAL_FAILED",
          attempt: 1,
          outcome: "retry",
        },
      ]);
      assert.deepEqual(named("worker.harness-exposure-withdrawn"), [
        {
          event: "worker.harness-exposure-withdrawn",
          namespaceId: fixture.namespace.id,
          agentId: served.id,
          revisionId: failed.id,
        },
      ]);
      // Only the two listed revisions were asked about; the retry waits for its backoff.
      assert.deepEqual(new Set(withdrawals), new Set([active.id, failed.id]));
      assert.equal(withdrawals.length, 2);
      assert.equal(named("worker.error").length, 0, JSON.stringify(named("worker.error")));
    },
  );

  // A candidate that fails for good keeps its Sandbox for diagnosis, and with it the exposure
  // Compute's status read used, which nothing reads any more: the worker that
  // commits the failure hands the revision to the sweep, which withdraws it on a later pass. A
  // candidate without a provider exposure is not handed over.
  revisionTest(
    "a native candidate that fails for good has its Harness exposure withdrawn by the sweep",
    async (fixture: RevisionFixture) => {
      const revisionOptions = nativeRevisionOptions(fixture);
      // The Codex candidate is queued first, so it fails first: a hand-over that ignored the
      // exposure kind would withdraw it before the native one.
      const { candidate: codex } = await fixture.admitInitialRevision("failing-codex", {
        agent: { executionMode: "dedicated" },
        revision: { sandboxDriverId: SANDBOX_DRIVER_ID },
      });
      const { candidate: native } = await fixture.admitInitialRevision("failing-native", {
        agent: { executionMode: "dedicated" },
        revision: revisionOptions,
      });
      const withdrawals: string[] = [];
      const events: WorkerEvent[] = [];
      await fixture.start(
        {
          ...fixture.compute,
          async prepareRevision() {
            throw new SandboxRevisionUnsupportedError("SANDBOX_HARNESS_UNSUPPORTED", "test");
          },
          async withdrawHarnessExposure(revision) {
            withdrawals.push(revision.id);
          },
        } satisfies ComputeDriver,
        { emit: (event) => events.push(event) },
      );
      for (const candidate of [codex, native]) {
        const failed: unknown = await fixture.work(candidate, "failed_permanent");
        assert.ok(failed !== null && typeof failed === "object" && "attempt_count" in failed);
        assert.equal(failed.attempt_count, 1);
      }
      const named = (name: string) => events.filter(({ event }) => event === name);
      await waitUntil(
        "the failed native candidate's exposure to be withdrawn",
        () => named("worker.harness-exposure-withdrawn").length > 0,
      );
      // Anything else handed over would be withdrawn before two more health reports.
      const settledReports = named("worker.health").length + 2;
      await waitUntil(
        "two more worker health reports",
        () => named("worker.health").length >= settledReports,
      );
      assert.deepEqual(named("worker.harness-exposure-withdrawn"), [
        {
          event: "worker.harness-exposure-withdrawn",
          namespaceId: fixture.namespace.id,
          agentId: admittedAgentId(native),
          revisionId: native.id,
        },
      ]);
      assert.deepEqual(withdrawals, [native.id]);
      assert.deepEqual(named("worker.harness-exposure-withdrawal-failed"), []);
      // Nothing was listed at start: both deployments were still queued then.
      assert.deepEqual(named("worker.harness-exposure-sweep"), []);
    },
  );

  // The start listing has five attempts, logged and then given up, and a candidate
  // handed over by its terminal failure is withdrawn whether or not the listing ever succeeded.
  revisionTest(
    "a candidate failing after the start listing ran out of attempts is still handed to the sweep",
    async (fixture: RevisionFixture) => {
      const revisionOptions = nativeRevisionOptions(fixture);
      const { candidate: native } = await fixture.admitInitialRevision("listing-lost", {
        agent: { executionMode: "dedicated" },
        revision: revisionOptions,
      });
      // Nothing is deployed while the listing fails: the candidate fails only once the listing
      // has given up, so its hand-over is the sweep's only source.
      await deferWork(fixture.observerPool, native.idempotencyKey);
      let listings = 0;
      // This pool opens its first connection at worker startup. Refuse only the
      // parameterless Promise query used by the startup Namespace listing.
      fixture.workerPool.on("connect", (client: PoolClient) => {
        client.query = new Proxy(client.query, {
          apply(query, receiver: unknown, args: unknown[]): unknown {
            const [statement, values, callback] = args;
            if (
              typeof statement === "string" &&
              statement.includes(NAMESPACE_LISTING_SQL) &&
              values === undefined &&
              callback === undefined
            ) {
              listings += 1;
              return Promise.reject(new Error("namespace listing unavailable"));
            }
            return Reflect.apply(query, receiver, args);
          },
        });
      });
      const withdrawals: string[] = [];
      const events: WorkerEvent[] = [];
      await fixture.start(
        {
          ...fixture.compute,
          async prepareRevision() {
            throw new SandboxRevisionUnsupportedError("SANDBOX_HARNESS_UNSUPPORTED", "test");
          },
          async withdrawHarnessExposure(revision) {
            withdrawals.push(revision.id);
          },
        } satisfies ComputeDriver,
        { emit: (event) => events.push(event) },
      );
      const named = (name: string) => events.filter(({ event }) => event === name);
      await waitUntil(
        "the listing to run out of attempts",
        () => named("worker.harness-exposure-sweep-failed").length >= 5,
      );
      assert.deepEqual(
        named("worker.harness-exposure-sweep-failed"),
        [1, 2, 3, 4, 5].map((attempt) => ({
          event: "worker.harness-exposure-sweep-failed",
          code: "WORKER_UNAVAILABLE",
          attempt,
        })),
      );
      await makeWorkDue(fixture.observerPool, native.idempotencyKey);
      await fixture.work(native, "failed_permanent");
      await waitUntil(
        "the handed-over candidate's exposure to be withdrawn",
        () => named("worker.harness-exposure-withdrawn").length > 0,
      );
      // The listing is not tried again during two more health reports.
      const settledReports = named("worker.health").length + 2;
      await waitUntil(
        "two more worker health reports",
        () => named("worker.health").length >= settledReports,
      );
      assert.equal(listings, 5);
      assert.deepEqual(named("worker.harness-exposure-sweep"), []);
      assert.deepEqual(named("worker.harness-exposure-withdrawn"), [
        {
          event: "worker.harness-exposure-withdrawn",
          namespaceId: fixture.namespace.id,
          agentId: admittedAgentId(native),
          revisionId: native.id,
        },
      ]);
      assert.deepEqual(withdrawals, [native.id]);
    },
  );

  // The hand-over has its own guards. It is asked through the worker, as the committing
  // pass asks it, for revisions the sweep must leave alone (an active revision, a Codex Harness,
  // a revision that is gone), and twice for one it holds, which keeps the pending attempt count.
  revisionTest(
    "the exposure hand-over skips active, Codex and unknown revisions and repeats idempotently",
    async (fixture: RevisionFixture) => {
      const native = nativeRevisionOptions(fixture);
      const { owner: served, candidate: active } = await fixture.admitInitialRevision("served", {
        agent: { executionMode: "dedicated" },
        revision: native,
      });
      const failed = await fixture.revision(served, 2, native);
      const { candidate: codex } = await fixture.admitInitialRevision("codex", {
        agent: { executionMode: "dedicated" },
        revision: { sandboxDriverId: SANDBOX_DRIVER_ID },
      });
      // Nothing runs: the start listing finds no active revision and no failed deployment, and
      // the hand-over is asked directly, so the only sweep entries are the ones it creates.
      await deferWork(fixture.observerPool, [
        active.idempotencyKey,
        failed.idempotencyKey,
        codex.idempotencyKey,
      ]);
      const events: WorkerEvent[] = [];
      const withdrawals: string[] = [];
      await fixture.start(
        {
          ...fixture.compute,
          async withdrawHarnessExposure(revision) {
            withdrawals.push(revision.id);
            // Not confirmed: the entry stays, with its attempt counted and its retry due later.
            throw new Error("OpenShell DeleteService did not confirm deletion.");
          },
        } satisfies ComputeDriver,
        { emit: (event) => events.push(event) },
      );
      const database: unknown = fixture.database;
      assert.ok(
        typeof database === "object" &&
          database !== null &&
          "workers" in database &&
          database.workers instanceof Set,
      );
      const [worker]: Iterable<unknown> = database.workers;
      assert.ok(worker instanceof ControllerWorker);
      type RevisionIdentity = {
        id: string;
        agentId: unknown;
        idempotencyKey: string;
      };
      const handOver = async (revision: RevisionIdentity) => {
        const identity: Pick<
          ClaimedWork,
          "namespaceId" | "agentId" | "revisionId" | "idempotencyKey"
        > = {
          namespaceId: fixture.namespace.id,
          agentId: admittedAgentId(revision),
          revisionId: revision.id,
          idempotencyKey: revision.idempotencyKey,
        };
        // The scheduler reads only claim identity. Leave the Work deferred so the
        // running worker cannot schedule a withdrawal through the deployment path.
        const scheduled: unknown = Reflect.apply(
          worker["scheduleFailedCandidateExposureWithdrawal"],
          worker,
          [identity],
        );
        await scheduled;
      };
      const pending = () => [...worker["harnessExposureWithdrawals"].keys()];
      await waitUntil("the start listing", () => worker["harnessExposureListed"]);
      assert.deepEqual(pending(), []);
      // The served Agent's revision activates after the listing: the hand-over reads the pointer.
      await fixture.observerPool.query(
        "UPDATE occ.agents SET active_revision_id = $2, desired_runtime_state = 'running' WHERE id = $1",
        [served.id, active.id],
      );
      await handOver(active);
      await handOver(codex);
      await handOver({ ...failed, id: "rev_00000000-0000-4000-8000-000000000000" });
      assert.deepEqual(pending(), []);
      await handOver(failed);
      assert.deepEqual(pending(), [failed.id]);
      const named = (name: string) => events.filter(({ event }) => event === name);
      await waitUntil("the handed-over revision's first withdrawal to fail", () =>
        named("worker.harness-exposure-withdrawal-failed").some(
          ({ revisionId, attempt, outcome }) =>
            revisionId === failed.id && attempt === 1 && outcome === "retry",
        ),
      );
      const entry = worker["harnessExposureWithdrawals"].get(failed.id);
      assert.ok(entry);
      const dueAt = entry.dueAt;
      assert.equal(entry.attempts, 1);
      assert.ok(dueAt > Date.now(), "the retry waits for its backoff");
      // A second hand-over of the same revision changes nothing: no reset, no second attempt now.
      await handOver(failed);
      assert.equal(worker["harnessExposureWithdrawals"].get(failed.id), entry);
      assert.equal(entry.attempts, 1);
      assert.equal(entry.dueAt, dueAt);
      const settledReports = named("worker.health").length + 2;
      await waitUntil(
        "two more worker health reports",
        () => named("worker.health").length >= settledReports,
      );
      assert.deepEqual(withdrawals, [failed.id]);
      assert.deepEqual(named("worker.harness-exposure-sweep"), []);
    },
  );
}
