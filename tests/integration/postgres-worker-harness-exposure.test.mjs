import assert from "node:assert/strict";
import { after } from "node:test";
import { waitFor } from "../helpers/wait-for.mjs";
import { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";

// The worker's native Harness exposure sweep (findings 1669 and 1672). Deployment and dispatch
// cases are in postgres-worker-agent-revision.test.mjs and its siblings; the lane runs the
// revision files at once.

const { cleanup, revisionTest } = createWorkerRevisionFixtures(import.meta.url);
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
