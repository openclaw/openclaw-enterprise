import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ControllerWorkerOptions } from "../../apps/controller/src/worker.ts";
import { waitFor } from "../helpers/wait-for.mjs";
import type { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";

type Setup = ReturnType<typeof createWorkerRevisionFixtures>["setup"];
type WorkerEvent = Parameters<NonNullable<ControllerWorkerOptions["emit"]>>[0];

export async function reportHealthDuringCompute(context: TestContext, setup: Setup) {
  const fixture = await setup(context, { leaseDurationMs: 1_200 });
  const { candidate } = await fixture.admitInitialRevision("long-compute-health");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const events: WorkerEvent[] = [];
  await fixture.start(
    {
      ...fixture.compute,
      async prepareRevision(revision, deploymentContext) {
        entered.resolve();
        await release.promise;
        return fixture.compute.prepareRevision(revision, deploymentContext);
      },
    },
    { emit: (event) => events.push(event) },
  );
  try {
    await entered.promise;
    const healthCount = () => events.filter(({ event }) => event === "worker.health").length;
    const before = healthCount();
    // A busy worker must report fresh database health before Compute returns,
    // not only after completion. The real queue continues renewing its lease.
    await waitFor("health observations during the unfinished Compute operation", async () =>
      healthCount() >= before + 2 ? true : undefined,
    );
    const claimed = await fixture.work(candidate, "claimed");
    assert.equal(claimed.attempt_count, 1);
  } finally {
    release.resolve();
  }
  await fixture.work(candidate, "succeeded");
}

export async function renewLeaseDuringSlowHealth(
  context: TestContext,
  setup: Setup,
  slowCall: number,
) {
  const healthEntered = Promise.withResolvers<void>();
  const releaseHealth = Promise.withResolvers<void>();
  const releaseCompute = Promise.withResolvers<void>();
  let healthCalls = 0;
  // Renewals run every third of the lease. A 4.5 s lease survives a busy CI host's late
  // renewal; a 1.2 s one expired under load (finding 870).
  const fixture = await setup(context, {
    leaseDurationMs: 4_500,
    async onHealthy() {
      if (++healthCalls !== slowCall) {
        return;
      }
      healthEntered.resolve();
      await releaseHealth.promise;
    },
  });
  const { owner, candidate } = await fixture.admitInitialRevision("slow-health");
  const events: WorkerEvent[] = [];
  let preparing = false;
  await fixture.start(
    {
      ...fixture.compute,
      async prepareRevision(revision, deploymentContext) {
        preparing = true;
        await releaseCompute.promise;
        return fixture.compute.prepareRevision(revision, deploymentContext);
      },
    },
    { emit: (event) => events.push(event) },
  );
  try {
    await healthEntered.promise;
    // Cover both the health update before the first effect and one started
    // during Compute. Neither may hold the claim's renewal chain hostage.
    await waitFor("Compute to start despite the pending health update", async () =>
      preparing ? true : undefined,
    );
    const original = await fixture.work(candidate, "claimed");
    // Count renewals instead of sampling the lease once: the same claim must be renewed
    // three times while the health update is still pending, however late each renewal
    // runs. Preparation nests two renewal chains, and each renews once before a chain that
    // waited on the health update would stop.
    const lease = async () => {
      const { rows } = await fixture.observerPool.query<Record<string, unknown>>(
        `SELECT claim_token, attempt_count, lease_expires_at,
                    lease_expires_at > clock_timestamp() AS live
             FROM occ.controller_work WHERE idempotency_key = $1`,
        [candidate.idempotencyKey],
      );
      const row = rows[0];
      assert.ok(row, "the admitted Work has a lease row");
      const { claim_token, attempt_count, lease_expires_at, live } = row;
      assert.ok(typeof claim_token === "string", "the Work still has a claim token");
      assert.ok(typeof attempt_count === "number", "the Work row contains an attempt count");
      assert.ok(lease_expires_at instanceof Date, "the Work still has a lease expiry");
      assert.ok(typeof live === "boolean", "the lease query reports whether the lease is live");
      return { claim_token, attempt_count, lease_expires_at, live };
    };
    let renewals = 0;
    let expiresAt = (await lease()).lease_expires_at.getTime();
    const renewed = await waitFor(
      "three lease renewals during the pending health update",
      async () => {
        const current = await lease();
        assert.ok(current.live, "the lease must not lapse while the health update is pending");
        if (current.lease_expires_at.getTime() > expiresAt) {
          renewals += 1;
          expiresAt = current.lease_expires_at.getTime();
        }
        return renewals >= 3 ? current : undefined;
      },
      30_000,
    );
    assert.deepEqual(
      { claim_token: renewed.claim_token, attempt_count: renewed.attempt_count },
      { claim_token: original.claim_token, attempt_count: 1 },
    );
    assert.equal(healthCalls, slowCall, "health updates must not overlap");
  } finally {
    releaseHealth.resolve();
    releaseCompute.resolve();
  }
  // A worker that gave up the claim reports it only once Compute returns.
  const done = await fixture.work(candidate, "succeeded");
  assert.equal(done.attempt_count, 1);
  assert.equal(
    events.some(({ code }) => code === "CLAIM_LOST"),
    false,
  );
  const active = await fixture.currentAgent(owner);
  assert.equal(active?.activeRevisionId, candidate.id);
}

export async function preserveRetryBudgetAfterHealthFailure(context: TestContext, setup: Setup) {
  const fixture = await setup(context, {
    leaseDurationMs: 1_200,
    async onHealthy() {
      throw new Error("readiness sink unavailable");
    },
  });
  const { candidate } = await fixture.admitInitialRevision("failed-health");
  const events: WorkerEvent[] = [];
  await fixture.start(
    {
      ...fixture.compute,
      async prepareRevision(revision, deploymentContext) {
        await delay(2_600);
        return fixture.compute.prepareRevision(revision, deploymentContext);
      },
    },
    { emit: (event) => events.push(event) },
  );
  const completed = await fixture.work(candidate, "succeeded");
  assert.equal(completed.attempt_count, 1);
  assert.ok(events.some(({ code }) => code === "HEALTH_UNAVAILABLE"));
  assert.equal(
    events.some(({ code }) => code === "CLAIM_LOST"),
    false,
  );
  assert.equal(
    events.some(({ event }) => event === "worker.health"),
    false,
  );
}
