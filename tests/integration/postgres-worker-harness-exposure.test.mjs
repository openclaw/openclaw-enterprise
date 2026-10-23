import assert from "node:assert/strict";
import test, { after } from "node:test";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import { occLogLine } from "../helpers/occ-log-line.ts";
import { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";
import {
  SandboxGatewayUnauthorizedError,
  SandboxRevisionUnsupportedError,
} from "../../packages/occ/src/index.ts";

// The worker's native Harness exposure sweep (findings 1669 and 1672). Deployment and dispatch
// cases are in postgres-worker-agent-revision.test.mjs and its siblings; the lane runs the
// revision files at once.

const { setup, cleanup, revisionTest } = createWorkerRevisionFixtures(import.meta.url);
after(cleanup);

// A Kubernetes Compute declares no maintenance interval, so a native OpenShell revision that
// is already active when the worker starts, or a newer candidate that failed for good with its
// Sandbox kept for diagnosis, never gets a pass that would withdraw its exposure. The worker
// lists them once at start and withdraws one per pass through Compute's hook, with bounded,
// logged retries; a pending deployment, a Codex Harness and a revision without a Sandbox Driver
// are left to their own passes or have no exposure to withdraw.
revisionTest(
  "the worker withdraws native Harness exposures of revisions that get no preparation pass",
  async (fixture) => {
    const sandboxDriverId = "native-sandbox";
    const nativeHarness = { ...fixture.productionHarness, id: "openclaw", mode: "dedicated" };
    const native = { harness: nativeHarness, sandboxDriverId };
    const { owner: served, candidate: active } = await fixture.admitInitialRevision("served", {
      agent: { executionMode: "dedicated" },
      revision: native,
    });
    const failed = await fixture.revision(served, 2, native);
    const { owner: codexOwner, candidate: codex } = await fixture.admitInitialRevision("codex", {
      agent: { executionMode: "dedicated" },
      revision: { sandboxDriverId },
    });
    const { owner: plainOwner, candidate: plain } = await fixture.admitInitialRevision("plain", {
      agent: { executionMode: "dedicated" },
      revision: { harness: nativeHarness },
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
    await fixture.observerPool.query(
      "UPDATE occ.controller_work SET available_at = clock_timestamp() + interval '1 hour' WHERE idempotency_key = $1",
      [pending.idempotencyKey],
    );
    for (const [owner, revision] of [
      [served, active],
      [codexOwner, codex],
      [plainOwner, plain],
    ]) {
      await fixture.observerPool.query(
        "UPDATE occ.agents SET active_revision_id = $2, desired_runtime_state = 'running' WHERE id = $1",
        [owner.id, revision.id],
      );
    }
    const withdrawals = [];
    const events = [];
    // The served revision's first withdrawal is not confirmed: it is logged and retried later.
    let unconfirmed = new Error("OpenShell DeleteService did not confirm deletion.");
    await fixture.start(
      {
        ...fixture.compute,
        async withdrawHarnessExposure(revision, signal) {
          assert.ok(signal instanceof AbortSignal);
          withdrawals.push(revision.id);
          if (revision.id === active.id && unconfirmed !== undefined) {
            const failure = unconfirmed;
            unconfirmed = undefined;
            throw failure;
          }
        },
      },
      { emit: (event) => events.push(event) },
    );
    const named = (name) => events.filter(({ event }) => event === name);
    await waitFor("the failed candidate's exposure to be withdrawn", async () =>
      named("worker.harness-exposure-withdrawn").some(({ revisionId }) => revisionId === failed.id)
        ? true
        : undefined,
    );
    await waitFor("the served revision's first withdrawal to be logged", async () =>
      named("worker.harness-exposure-withdrawal-failed").length > 0 ? true : undefined,
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
    assert.equal(withdrawals.filter((id) => id === active.id).length, 1);
    assert.equal(withdrawals.filter((id) => id === failed.id).length, 1);
    assert.equal(named("worker.error").length, 0, JSON.stringify(named("worker.error")));
  },
);

// A candidate that fails for good keeps its Sandbox for diagnosis, and with it the exposure
// Compute's status read used, which nothing reads any more (finding 1672): the worker that
// commits the failure hands the revision to the sweep, which withdraws it on a later pass. A
// candidate without a provider exposure is not handed over.
revisionTest(
  "a native candidate that fails for good has its Harness exposure withdrawn by the sweep",
  async (fixture) => {
    const sandboxDriverId = "native-sandbox";
    const nativeHarness = { ...fixture.productionHarness, id: "openclaw", mode: "dedicated" };
    // The Codex candidate is queued first, so it fails first: a hand-over that ignored the
    // exposure kind would withdraw it before the native one.
    const { candidate: codex } = await fixture.admitInitialRevision("failing-codex", {
      agent: { executionMode: "dedicated" },
      revision: { sandboxDriverId },
    });
    const { candidate: native } = await fixture.admitInitialRevision("failing-native", {
      agent: { executionMode: "dedicated" },
      revision: { harness: nativeHarness, sandboxDriverId },
    });
    const withdrawals = [];
    const events = [];
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision() {
          throw new SandboxRevisionUnsupportedError("SANDBOX_HARNESS_UNSUPPORTED", "test");
        },
        async withdrawHarnessExposure(revision) {
          withdrawals.push(revision.id);
        },
      },
      { emit: (event) => events.push(event) },
    );
    for (const candidate of [codex, native]) {
      const failed = await fixture.work(candidate, "failed_permanent");
      assert.equal(failed.attempt_count, 1);
    }
    const named = (name) => events.filter(({ event }) => event === name);
    await waitFor("the failed native candidate's exposure to be withdrawn", async () =>
      named("worker.harness-exposure-withdrawn").length > 0 ? true : undefined,
    );
    // Two more idle passes: anything else handed over would have been withdrawn by now.
    const settledPasses = named("worker.health").length + 2;
    await waitFor("two more idle passes", async () =>
      named("worker.health").length >= settledPasses ? true : undefined,
    );
    assert.deepEqual(named("worker.harness-exposure-withdrawn"), [
      {
        event: "worker.harness-exposure-withdrawn",
        namespaceId: fixture.namespace.id,
        agentId: native.agentId,
        revisionId: native.id,
      },
    ]);
    assert.deepEqual(withdrawals, [native.id]);
    assert.deepEqual(named("worker.harness-exposure-withdrawal-failed"), []);
    // Nothing was listed at start: both deployments were still queued then.
    assert.deepEqual(named("worker.harness-exposure-sweep"), []);
  },
);

// The start listing's one read: `listNamespaces` is the only statement with this shape the
// worker issues outside a claim, so refusing it fails exactly the listing.
const NAMESPACE_LISTING_SQL =
  "FROM occ.namespaces WHERE deleted_at IS NULL ORDER BY created_at, id";

/** The worker's pool, with every checked-out client refusing the listing while `refuse` says so. */
function listingRefusingPool(pool, refuse) {
  const wrapped = new WeakSet();
  return new Proxy(pool, {
    get(target, property) {
      if (property === "connect") {
        return async (...args) => {
          const client = await target.connect(...args);
          if (!wrapped.has(client)) {
            wrapped.add(client);
            const query = client.query.bind(client);
            client.query = (...queryArgs) => {
              const text = typeof queryArgs[0] === "string" ? queryArgs[0] : queryArgs[0]?.text;
              const refusal =
                typeof text === "string" && text.includes(NAMESPACE_LISTING_SQL)
                  ? refuse()
                  : undefined;
              return refusal === undefined ? query(...queryArgs) : Promise.reject(refusal);
            };
          }
          return client;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// Finding 1678: the start listing has five attempts, logged and then given up, and a candidate
// handed over by its terminal failure is withdrawn whether or not the listing ever succeeded.
revisionTest(
  "a candidate failing after the start listing ran out of attempts is still handed to the sweep",
  async (fixture) => {
    const sandboxDriverId = "native-sandbox";
    const nativeHarness = { ...fixture.productionHarness, id: "openclaw", mode: "dedicated" };
    const { candidate: native } = await fixture.admitInitialRevision("listing-lost", {
      agent: { executionMode: "dedicated" },
      revision: { harness: nativeHarness, sandboxDriverId },
    });
    // Nothing is deployed while the listing fails: the candidate fails only once the listing
    // has given up, so its hand-over is the sweep's only source.
    await fixture.observerPool.query(
      "UPDATE occ.controller_work SET available_at = clock_timestamp() + interval '1 hour' WHERE idempotency_key = $1",
      [native.idempotencyKey],
    );
    let listings = 0;
    const withdrawals = [];
    const events = [];
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision() {
          throw new SandboxRevisionUnsupportedError("SANDBOX_HARNESS_UNSUPPORTED", "test");
        },
        async withdrawHarnessExposure(revision) {
          withdrawals.push(revision.id);
        },
      },
      {
        emit: (event) => events.push(event),
        pool: listingRefusingPool(fixture.workerPool, () => {
          listings += 1;
          return new Error("namespace listing unavailable");
        }),
      },
    );
    const named = (name) => events.filter(({ event }) => event === name);
    await waitFor("the listing to run out of attempts", async () =>
      named("worker.harness-exposure-sweep-failed").length >= 5 ? true : undefined,
    );
    assert.deepEqual(
      named("worker.harness-exposure-sweep-failed"),
      [1, 2, 3, 4, 5].map((attempt) => ({
        event: "worker.harness-exposure-sweep-failed",
        code: "WORKER_UNAVAILABLE",
        attempt,
      })),
    );
    await fixture.observerPool.query(
      "UPDATE occ.controller_work SET available_at = clock_timestamp() WHERE idempotency_key = $1",
      [native.idempotencyKey],
    );
    await fixture.work(native, "failed_permanent");
    await waitFor("the handed-over candidate's exposure to be withdrawn", async () =>
      named("worker.harness-exposure-withdrawn").length > 0 ? true : undefined,
    );
    // Two more idle passes: the listing is not tried again once it is out of attempts.
    const settledPasses = named("worker.health").length + 2;
    await waitFor("two more idle passes", async () =>
      named("worker.health").length >= settledPasses ? true : undefined,
    );
    assert.equal(listings, 5);
    assert.deepEqual(named("worker.harness-exposure-sweep"), []);
    assert.deepEqual(named("worker.harness-exposure-withdrawn"), [
      {
        event: "worker.harness-exposure-withdrawn",
        namespaceId: fixture.namespace.id,
        agentId: native.agentId,
        revisionId: native.id,
      },
    ]);
    assert.deepEqual(withdrawals, [native.id]);
  },
);

// Finding 1678: the hand-over's own guards. It is asked through the worker, as the committing
// pass asks it, for revisions the sweep must leave alone (an active revision, a Codex Harness,
// a revision that is gone), and twice for one it holds, which keeps the pending attempt count.
revisionTest(
  "the exposure hand-over skips active, Codex and unknown revisions and repeats idempotently",
  async (fixture) => {
    const sandboxDriverId = "native-sandbox";
    const nativeHarness = { ...fixture.productionHarness, id: "openclaw", mode: "dedicated" };
    const native = { harness: nativeHarness, sandboxDriverId };
    const { owner: served, candidate: active } = await fixture.admitInitialRevision("served", {
      agent: { executionMode: "dedicated" },
      revision: native,
    });
    const failed = await fixture.revision(served, 2, native);
    const { candidate: codex } = await fixture.admitInitialRevision("codex", {
      agent: { executionMode: "dedicated" },
      revision: { sandboxDriverId },
    });
    // Nothing runs: the start listing finds no active revision and no failed deployment, and
    // the hand-over is asked directly, so the only sweep entries are the ones it creates.
    await fixture.observerPool.query(
      "UPDATE occ.controller_work SET available_at = clock_timestamp() + interval '1 hour' WHERE idempotency_key = ANY($1::text[])",
      [[active.idempotencyKey, failed.idempotencyKey, codex.idempotencyKey]],
    );
    const events = [];
    const withdrawals = [];
    await fixture.start(
      {
        ...fixture.compute,
        async withdrawHarnessExposure(revision) {
          withdrawals.push(revision.id);
          // Not confirmed: the entry stays, with its attempt counted and its retry due later.
          throw new Error("OpenShell DeleteService did not confirm deletion.");
        },
      },
      { emit: (event) => events.push(event) },
    );
    const [worker] = fixture.database.workers;
    const claim = (revision) => ({
      namespaceId: fixture.namespace.id,
      agentId: revision.agentId,
      revisionId: revision.id,
      idempotencyKey: revision.idempotencyKey,
    });
    const handOver = (revision) =>
      worker.scheduleFailedCandidateExposureWithdrawal(claim(revision));
    const pending = () => [...worker.harnessExposureWithdrawals.keys()];
    await waitFor("the start listing", async () =>
      worker.harnessExposureListed ? true : undefined,
    );
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
    const named = (name) => events.filter(({ event }) => event === name);
    await waitFor("the handed-over revision's first withdrawal to fail", async () =>
      named("worker.harness-exposure-withdrawal-failed").length > 0 ? true : undefined,
    );
    const entry = worker.harnessExposureWithdrawals.get(failed.id);
    assert.equal(entry.attempts, 1);
    assert.ok(entry.dueAt > Date.now(), "the retry waits for its backoff");
    // A second hand-over of the same revision changes nothing: no reset, no second attempt now.
    await handOver(failed);
    assert.equal(worker.harnessExposureWithdrawals.get(failed.id), entry);
    assert.equal(entry.attempts, 1);
    const settledPasses = named("worker.health").length + 2;
    await waitFor("two more idle passes", async () =>
      named("worker.health").length >= settledPasses ? true : undefined,
    );
    assert.deepEqual(withdrawals, [failed.id]);
    assert.deepEqual(named("worker.harness-exposure-sweep"), []);
  },
);

// Finding 1676: a stop or deletion records a revision's Sandbox gone only once the Sandbox
// gateway confirms it. When the gateway refuses the controller's own identity, retrying cannot
// help until an operator restores its Workspace role, so the work fails with that code instead of
// spending its attempts as a generic failure, and the Agent keeps its active revision.
revisionTest(
  "a stop or deletion the Sandbox gateway refuses to confirm fails with SANDBOX_GATEWAY_UNAUTHORIZED",
  async (fixture) => {
    const { owner: stopped, candidate: stopping } = await fixture.admitInitialRevision("stop");
    const { owner: deleted, candidate: deleting } = await fixture.admitInitialRevision("delete");
    const refusals = new Set();
    const refused = (revision) => {
      if (refusals.has(revision.id)) {
        throw new SandboxGatewayUnauthorizedError(
          `OpenShell refused the controller gateway identity in Workspace w, so Sandbox ${revision.id} cannot be confirmed removed.`,
        );
      }
    };
    await fixture.start({
      ...fixture.compute,
      async stopRevision(revision) {
        refused(revision);
        return fixture.compute.stopRevision(revision);
      },
      async retireRevision(revision) {
        refused(revision);
        return fixture.compute.retireRevision(revision);
      },
    });
    await Promise.all([fixture.work(stopping, "succeeded"), fixture.work(deleting, "succeeded")]);
    refusals.add(stopping.id).add(deleting.id);
    const stop = await fixture.requestStop(stopped);
    const stopWork = await fixture.work(stop, "failed_permanent");
    assert.equal(stopWork.attempt_count, 1);
    assert.equal(
      (await fixture.workResult(stop)).rows[0].reason_code,
      "SANDBOX_GATEWAY_UNAUTHORIZED",
    );
    const deletion = await fixture.requestDeletion(deleted);
    const deletionWork = await fixture.work(deletion, "failed_permanent");
    assert.equal(deletionWork.attempt_count, 1);
    assert.equal(
      (await fixture.workResult(deletion)).rows[0].reason_code,
      "SANDBOX_GATEWAY_UNAUTHORIZED",
    );
    // Nothing was recorded stopped or removed.
    assert.equal((await fixture.currentAgent(stopped)).activeRevisionId, stopping.id);
    assert.equal((await fixture.currentAgent(deleted))?.activeRevisionId, deleting.id);
  },
);

// Finding 1694: OpenShell also answers UNAUTHENTICATED while the controller's token file or the
// gateway's signing keys are between refreshes. The refusal keeps its code but retries within
// the attempt budget, on stops, deletions and deployments alike; a refusal that outlasts the
// budget fails with the code and the worker logs the same guidance the deployment status shows.
test(
  "a stop, deletion or deployment refused as unauthenticated retries before failing with the code",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context, { maxAttempts: 2 });
    const { owner: stopped, candidate: stopping } = await fixture.admitInitialRevision("stop-t");
    const { owner: deleted, candidate: deleting } = await fixture.admitInitialRevision("delete-t");
    const { owner: recovered, candidate: recovering } =
      await fixture.admitInitialRevision("stop-r");
    const { owner: refusedDeployOwner, candidate: refusedDeploy } =
      await fixture.admitInitialRevision("deploy-t");
    const { owner: recoveredDeployOwner, candidate: recoveredDeploy } =
      await fixture.admitInitialRevision("deploy-r");
    // Refusals left per revision (every Compute call on it); Infinity never clears.
    const refusals = new Map([
      [refusedDeploy.id, Number.POSITIVE_INFINITY],
      [recoveredDeploy.id, 1],
    ]);
    const refused = (revision) => {
      const remaining = refusals.get(revision.id) ?? 0;
      if (remaining > 0) {
        refusals.set(revision.id, remaining - 1);
        throw new SandboxGatewayUnauthorizedError(
          `OpenShell refused the controller gateway identity in Workspace w, so Sandbox ${revision.id} cannot be confirmed removed.`,
          { transient: true },
        );
      }
    };
    const events = [];
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision, deploymentContext) {
          refused(revision);
          return fixture.compute.prepareRevision(revision, deploymentContext);
        },
        async stopRevision(revision) {
          refused(revision);
          return fixture.compute.stopRevision(revision);
        },
        async retireRevision(revision) {
          refused(revision);
          return fixture.compute.retireRevision(revision);
        },
      },
      { emit: (event) => events.push(event) },
    );
    await Promise.all(
      [stopping, deleting, recovering].map((candidate) => fixture.work(candidate, "succeeded")),
    );
    // Deployments: one refusal is retried and the second attempt activates; a persistent one
    // spends the budget and fails with the code.
    assert.equal((await fixture.work(recoveredDeploy, "succeeded", 30_000)).attempt_count, 2);
    const failedDeploy = await fixture.work(refusedDeploy, "failed_permanent", 30_000);
    assert.equal(failedDeploy.attempt_count, 2);
    assert.equal(
      (await fixture.workResult(refusedDeploy)).rows[0].reason_code,
      "SANDBOX_GATEWAY_UNAUTHORIZED",
    );
    // Stops and deletions: the same, on the Compute calls that confirm the Sandbox gone.
    refusals.set(stopping.id, Number.POSITIVE_INFINITY);
    refusals.set(deleting.id, Number.POSITIVE_INFINITY);
    refusals.set(recovering.id, 1);
    const stop = await fixture.requestStop(stopped);
    const stopWork = await fixture.work(stop, "failed_permanent", 30_000);
    assert.equal(stopWork.attempt_count, 2);
    assert.equal(
      (await fixture.workResult(stop)).rows[0].reason_code,
      "SANDBOX_GATEWAY_UNAUTHORIZED",
    );
    const deletion = await fixture.requestDeletion(deleted);
    const deletionWork = await fixture.work(deletion, "failed_permanent", 30_000);
    assert.equal(deletionWork.attempt_count, 2);
    assert.equal(
      (await fixture.workResult(deletion)).rows[0].reason_code,
      "SANDBOX_GATEWAY_UNAUTHORIZED",
    );
    const recovery = await fixture.requestStop(recovered);
    assert.equal((await fixture.work(recovery, "succeeded", 30_000)).attempt_count, 2);
    // Nothing was recorded stopped or removed for the refused ones; the recovered one stopped.
    assert.equal((await fixture.currentAgent(stopped)).activeRevisionId, stopping.id);
    assert.equal((await fixture.currentAgent(deleted))?.activeRevisionId, deleting.id);
    assert.notEqual((await fixture.currentAgent(recovered)).activeRevisionId, recovering.id);
    // The guidance code is logged with the failed stop and deletion only, not with their
    // retries. These are the lines the worker log keeps (finding 2245).
    const completed = events
      .filter(
        ({ event, code }) =>
          event === "worker.completed" && code === "SANDBOX_GATEWAY_UNAUTHORIZED",
      )
      .map(occLogLine);
    const terminal = completed.filter(({ hintCode }) => hintCode !== undefined);
    assert.deepEqual(
      terminal.map(({ agentId }) => agentId).sort(),
      [stopped.id, deleted.id].sort(),
    );
    for (const { hintCode } of terminal) {
      assert.equal(hintCode, "sandbox-gateway-identity");
    }
    // Attempt 1 is the Driver's retry and the queue's; attempt 2 is still the Driver's retry
    // but the queue's permanent failure, which is what the line reports with the guidance.
    for (const agent of [stopped, deleted]) {
      assert.deepEqual(
        completed
          .filter(({ agentId }) => agentId === agent.id)
          .map(({ attempt, result, outcome, hintCode }) => [
            attempt,
            result,
            outcome,
            hintCode !== undefined,
          ]),
        [
          [1, "retry", "retry", false],
          [2, "retry", "permanent", true],
        ],
      );
    }
    // Every retried attempt was logged without it (the deployments never get it: their status
    // shows the guidance).
    const retried = completed.filter(
      ({ outcome, hintCode }) => outcome === "retry" && hintCode === undefined,
    );
    assert.deepEqual(
      new Set(retried.map(({ agentId }) => agentId)),
      new Set([
        stopped.id,
        deleted.id,
        recovered.id,
        refusedDeployOwner.id,
        recoveredDeployOwner.id,
      ]),
    );
  },
);

async function seedActiveAndFailedNativeExposureRevisions(fixture) {
  const sandboxDriverId = "native-sandbox";
  const nativeHarness = { ...fixture.productionHarness, id: "openclaw", mode: "dedicated" };
  const native = { harness: nativeHarness, sandboxDriverId };
  const { owner: served, candidate: active } = await fixture.admitInitialRevision("served", {
    agent: { executionMode: "dedicated" },
    revision: native,
  });
  const failed = await fixture.revision(served, 2, native);
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

// Finding 1695: the sweep step ran only on passes after an empty claim, so a worker whose queue
// is never empty never withdrew a second listed exposure (the first goes on the first pass).
// It now also runs after every five claimed passes in a row.
revisionTest(
  "a saturated queue still gets a sweep step after five claimed passes",
  async (fixture) => {
    const { active, failed } = await seedActiveAndFailedNativeExposureRevisions(fixture);
    // Eight deployments queued before the worker starts keep every claim busy.
    const busy = [];
    for (let index = 0; index < 8; index += 1) {
      busy.push((await fixture.admitInitialRevision(`busy-${index}`)).candidate);
    }
    const events = [];
    const withdrawals = [];
    await fixture.start(
      {
        ...fixture.compute,
        async withdrawHarnessExposure(revision) {
          withdrawals.push(revision.id);
        },
      },
      { emit: (event) => events.push(event) },
    );
    await Promise.all(busy.map((candidate) => fixture.work(candidate, "succeeded")));
    await waitFor("both listed exposures to be withdrawn", async () =>
      withdrawals.length >= 2 ? true : undefined,
    );
    assert.deepEqual(new Set(withdrawals), new Set([active.id, failed.id]));
    const indices = (name) => events.flatMap(({ event }, index) => (event === name ? [index] : []));
    const completed = indices("worker.completed");
    const withdrawn = indices("worker.harness-exposure-withdrawn");
    assert.ok(completed.length >= 8, `claimed passes: ${completed.length}`);
    // The first withdrawal is the start pass's; the second ran after at most five claimed passes
    // (one claim per pass, so five completions), before the queue drained, not on the idle pass
    // after it.
    assert.ok(
      withdrawn[0] < completed[0],
      `first withdrawal at ${withdrawn[0]}, passes ${completed}`,
    );
    const between = completed.filter((index) => index > withdrawn[0] && index < withdrawn[1]);
    assert.ok(
      between.length >= 1 && between.length <= 5 && withdrawn[1] < completed.at(-1),
      `second withdrawal at ${withdrawn[1]}, passes ${completed}`,
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
  async (fixture) => {
    const { served, active, failed } = await seedActiveAndFailedNativeExposureRevisions(fixture);
    const events = [];
    const withdrawals = [];
    await fixture.start(
      {
        ...fixture.compute,
        async withdrawHarnessExposure(revision) {
          withdrawals.push(revision.id);
          if (revision.id === failed.id) {
            // The shape of what the OpenShell Sandbox Driver throws when DeleteService answers
            // NOT_FOUND for a service GetService had just found (OpenShellDeletionUnconfirmedError;
            // the wire conformance test covers the class and its code).
            throw Object.assign(
              new Error(
                "OpenShell DeleteService did not find the Sandbox, so the deletion is unconfirmed.",
              ),
              { code: "SANDBOX_DELETION_UNCONFIRMED" },
            );
          }
        },
      },
      { emit: (event) => events.push(event) },
    );
    const named = (name) => events.filter(({ event }) => event === name);
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
