import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Pool } from "pg";
import { createOccMetrics } from "../../apps/controller/src/metrics/index.ts";
import type { ControllerWorkerOptions } from "../../apps/controller/src/worker.ts";
import type { Agent, AgentRevision, ComputeDriver } from "../../packages/contracts/src/index.ts";
import { PostgresMetricsSnapshot } from "../../packages/occ/src/index.ts";
import { requiresPostgres, setup } from "../helpers/compute-singleton-worker.mjs";
import { deferred } from "../helpers/deferred.ts";
import { waitFor } from "../helpers/wait-for.mjs";

type QueuedRevision = Pick<AgentRevision, "id"> & { idempotencyKey: string };
type WorkerEvent = Parameters<NonNullable<ControllerWorkerOptions["emit"]>>[0];

type ActivationFixture = {
  observerPool: Pool;
  namespace: { id: string; name: string };
  compute: ComputeDriver;
  agent: () => Promise<Readonly<Agent>>;
  revision: (owner: Readonly<Agent>, number: number) => Promise<QueuedRevision>;
  activeRevision: (owner: Readonly<Agent>) => Promise<string | null>;
  work: (candidate: QueuedRevision) => Promise<{ state: string; attempt_count: number }>;
  start: (
    compute: ComputeDriver,
    leaseDurationMs?: ControllerWorkerOptions["leaseDurationMs"],
    convergenceTimeoutMs?: ControllerWorkerOptions["convergenceTimeoutMs"],
    mode?: ControllerWorkerOptions["mode"],
    // The JavaScript fixture infers a zero-argument default emitter.
    emit?: (event?: WorkerEvent) => void,
    metrics?: ControllerWorkerOptions["metrics"],
  ) => Promise<void>;
};

const setupActivationFixture: (context: TestContext) => Promise<ActivationFixture> = setup;

type BindingEffect =
  | {
      action: "bind";
      namespaceId: string;
      namespaceName: string;
      agentId: string;
      agentName: string;
      servicePrincipalId: Agent["servicePrincipalId"];
    }
  | { action: "prepare" | "activate"; revisionId: string };

type RevisionEffect = { revisionId: string; activeRevisionId: string | null };
type LifecycleAction = "prepare" | "activate" | "deactivate" | "retire";

function recordRevisionEffects(fixture: ActivationFixture, owner: Readonly<Agent>) {
  const effects: (RevisionEffect & { action: LifecycleAction })[] = [];

  async function record(action: LifecycleAction, candidate: AgentRevision) {
    effects.push({
      action,
      revisionId: candidate.id,
      activeRevisionId: await fixture.activeRevision(owner),
    });
  }

  return { effects, record };
}

export function registerComputeSingletonActivationCases() {
  test(
    "production worker emits Compute preflight warnings before worker.started and continues startup",
    requiresPostgres,
    async (context) => {
      const fixture = await setupActivationFixture(context);
      const events: (WorkerEvent | undefined)[] = [];

      await fixture.start(
        {
          ...fixture.compute,
          async preflight() {
            return {
              warnings: [
                {
                  code: "KUBERNETES_VERSION_BELOW_MINIMUM",
                  message: "Kubernetes 1.34.12 is below the supported minimum 1.35.0.",
                },
              ],
            };
          },
        },
        30_000,
        900_000,
        "production",
        (event) => events.push(event),
      );

      assert.deepEqual(events.slice(0, 2), [
        {
          event: "compute.preflight-warning",
          computeDriverId: fixture.compute.id,
          code: "KUBERNETES_VERSION_BELOW_MINIMUM",
          message: "Kubernetes 1.34.12 is below the supported minimum 1.35.0.",
        },
        { event: "worker.started", computeDriverId: fixture.compute.id },
      ]);
    },
  );

  test(
    "a worker binds persisted Namespace, Agent, and service principal before provider effects",
    requiresPostgres,
    async (context) => {
      const fixture = await setupActivationFixture(context);
      const owner = await fixture.agent();
      const candidate = await fixture.revision(owner, 1);
      const effects: BindingEffect[] = [];

      await fixture.start({
        ...fixture.compute,
        activationOrder: "beforeCommit",
        async preflight() {},
        async bindAgent(binding) {
          effects.push({
            action: "bind",
            namespaceId: binding.namespace.id,
            namespaceName: binding.namespace.name,
            agentId: binding.agent.id,
            agentName: binding.agent.name,
            servicePrincipalId: binding.agent.servicePrincipalId,
          });
        },
        async prepareRevision(revision) {
          effects.push({ action: "prepare", revisionId: revision.id });
          return fixture.compute.prepareRevision(revision);
        },
        async activateRevision(revision) {
          effects.push({ action: "activate", revisionId: revision.id });
        },
      });

      assert.equal((await fixture.work(candidate)).attempt_count, 1);
      assert.deepEqual(effects, [
        {
          action: "bind",
          namespaceId: fixture.namespace.id,
          namespaceName: fixture.namespace.name,
          agentId: owner.id,
          agentName: owner.name,
          servicePrincipalId: owner.servicePrincipalId,
        },
        { action: "prepare", revisionId: candidate.id },
        { action: "activate", revisionId: candidate.id },
      ]);
    },
  );

  test(
    "a production singleton driver activates under its claim heartbeat before CAS and retires only after CAS",
    requiresPostgres,
    async (context) => {
      const fixture = await setupActivationFixture(context);
      const owner = await fixture.agent();
      const first = await fixture.revision(owner, 1);
      const { effects, record } = recordRevisionEffects(fixture, owner);

      await fixture.start(
        {
          ...fixture.compute,
          activationOrder: "beforeCommit",
          async preflight() {},
          async prepareRevision(candidate) {
            await record("prepare", candidate);
            return fixture.compute.prepareRevision(candidate);
          },
          async activateRevision(candidate) {
            await record("activate", candidate);
            if (candidate.id === first.id) {
              const original = await fixture.observerPool.query<{
                claim_token: string | null;
                expires_at: string | null;
              }>(
                `SELECT claim_token, lease_expires_at::text AS expires_at
                 FROM occ.controller_work WHERE idempotency_key = $1`,
                [first.idempotencyKey],
              );
              assert.equal(original.rowCount, 1);
              const claim = original.rows[0];
              assert.ok(claim);
              assert.ok(claim.claim_token);
              assert.ok(claim.expires_at);

              // Keep activation open beyond its initial lease: the same claim must
              // remain live because the real worker renewed it before publication.
              await waitFor("the original activation claim to outlive its lease", async () => {
                const current = await fixture.observerPool.query<{
                  state: string;
                  claim_token: string | null;
                  attempt_count: number;
                  live: boolean | null;
                  original_expired: boolean;
                  renewed: boolean | null;
                }>(
                  `SELECT state, claim_token, attempt_count,
                          lease_expires_at > clock_timestamp() AS live,
                          clock_timestamp() > $2::timestamptz AS original_expired,
                          lease_expires_at > $2::timestamptz AS renewed
                   FROM occ.controller_work WHERE idempotency_key = $1`,
                  [first.idempotencyKey, claim.expires_at],
                );
                assert.equal(current.rowCount, 1);
                const work = current.rows[0];
                assert.ok(work);
                assert.equal(work.state, "claimed");
                assert.equal(work.claim_token, claim.claim_token);
                assert.equal(work.attempt_count, 1);
                assert.equal(
                  work.live,
                  true,
                  "the original claim must remain live during activation",
                );
                return work.original_expired && work.renewed ? work : undefined;
              });
            }
          },
          async deactivateRevision(candidate) {
            await record("deactivate", candidate);
          },
          async retireRevision(candidate) {
            await record("retire", candidate);
            return fixture.compute.retireRevision(candidate);
          },
        },
        5_000,
      );
      assert.equal((await fixture.work(first)).attempt_count, 1);
      assert.equal(await fixture.activeRevision(owner), first.id);

      const second = await fixture.revision(owner, 2);
      assert.equal((await fixture.work(second)).attempt_count, 1);
      assert.equal(await fixture.activeRevision(owner), second.id);
      assert.deepEqual(effects, [
        { action: "prepare", revisionId: first.id, activeRevisionId: null },
        { action: "activate", revisionId: first.id, activeRevisionId: null },
        { action: "prepare", revisionId: second.id, activeRevisionId: first.id },
        { action: "activate", revisionId: second.id, activeRevisionId: first.id },
        { action: "retire", revisionId: first.id, activeRevisionId: second.id },
      ]);

      const activation = await fixture.observerPool.query<{
        resource_id: string;
        previous: string | null;
      }>(
        `SELECT resource_id, details->>'previousRevisionId' AS previous
         FROM occ.audit_events
         WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.activate'
         ORDER BY occurred_at`,
        [fixture.namespace.id],
      );
      assert.deepEqual(activation.rows, [
        { resource_id: first.id, previous: null },
        { resource_id: second.id, previous: first.id },
      ]);
    },
  );

  test(
    "failed singleton activation retries without publishing or retiring the previous revision",
    requiresPostgres,
    async (context) => {
      const fixture = await setupActivationFixture(context);
      const owner = await fixture.agent();
      const first = await fixture.revision(owner, 1);
      const activations: RevisionEffect[] = [];
      const retirements: RevisionEffect[] = [];
      let failed = false;
      const snapshot = new PostgresMetricsSnapshot(fixture.observerPool);
      const metrics = createOccMetrics("worker", () => snapshot.collect());

      await fixture.start(
        {
          ...fixture.compute,
          activationOrder: "beforeCommit",
          async preflight() {},
          async activateRevision(candidate) {
            activations.push({
              revisionId: candidate.id,
              activeRevisionId: await fixture.activeRevision(owner),
            });
            if (candidate.revision === 2 && !failed) {
              failed = true;
              throw new Error("provider readiness verification failed");
            }
          },
          async retireRevision(candidate) {
            retirements.push({
              revisionId: candidate.id,
              activeRevisionId: await fixture.activeRevision(owner),
            });
            return fixture.compute.retireRevision(candidate);
          },
        },
        30_000,
        900_000,
        "production",
        undefined,
        metrics,
      );
      await fixture.work(first);

      const second = await fixture.revision(owner, 2);
      assert.equal((await fixture.work(second)).attempt_count, 2);
      assert.equal(await fixture.activeRevision(owner), second.id);
      assert.deepEqual(activations, [
        { revisionId: first.id, activeRevisionId: null },
        { revisionId: second.id, activeRevisionId: first.id },
        { revisionId: second.id, activeRevisionId: first.id },
      ]);
      assert.deepEqual(retirements, [{ revisionId: first.id, activeRevisionId: second.id }]);

      const failure = await fixture.observerPool.query<{ reason: string | null }>(
        `SELECT details->>'reasonCode' AS reason
         FROM occ.audit_events
         WHERE resource_id = $1 AND action = 'reconcile' AND outcome = 'failure'`,
        [second.id],
      );
      assert.deepEqual(failure.rows, [{ reason: "DEPENDENCY_UNAVAILABLE" }]);
      // One failed provider pass is counted as a retry, not another deployment.
      assert.match(
        await metrics.exposition(),
        /occ_reconciliation_attempts_total\{[^\n]*outcome="retry"[^\n]*\} 1/,
      );
    },
  );

  test(
    "production Drivers without an activation preference retain after-commit Kubernetes ordering",
    requiresPostgres,
    async (context) => {
      const fixture = await setupActivationFixture(context);
      const owner = await fixture.agent();
      const first = await fixture.revision(owner, 1);
      const { effects, record } = recordRevisionEffects(fixture, owner);

      await fixture.start({
        ...fixture.compute,
        async preflight() {},
        async prepareRevision(candidate) {
          await record("prepare", candidate);
          return fixture.compute.prepareRevision(candidate);
        },
        async deactivateRevision(candidate) {
          await record("deactivate", candidate);
        },
        async activateRevision(candidate) {
          await record("activate", candidate);
        },
        async retireRevision(candidate) {
          await record("retire", candidate);
          return fixture.compute.retireRevision(candidate);
        },
      });
      await fixture.work(first);
      const second = await fixture.revision(owner, 2);
      await fixture.work(second);

      assert.equal(await fixture.activeRevision(owner), second.id);
      assert.deepEqual(effects, [
        { action: "prepare", revisionId: first.id, activeRevisionId: null },
        { action: "deactivate", revisionId: first.id, activeRevisionId: null },
        { action: "activate", revisionId: first.id, activeRevisionId: first.id },
        { action: "prepare", revisionId: second.id, activeRevisionId: first.id },
        { action: "activate", revisionId: second.id, activeRevisionId: second.id },
        { action: "retire", revisionId: first.id, activeRevisionId: second.id },
      ]);
    },
  );

  test(
    "development after-commit Drivers activate after CAS and retry before retiring the previous revision",
    requiresPostgres,
    async (context) => {
      const fixture = await setupActivationFixture(context);
      const owner = await fixture.agent();
      const first = await fixture.revision(owner, 1);
      let second: QueuedRevision | undefined;
      const { effects, record } = recordRevisionEffects(fixture, owner);
      let secondActivationAttempts = 0;
      let retryStarted = false;
      const { promise: retryRelease, resolve: releaseRetry } = deferred();

      await fixture.start(
        {
          ...fixture.compute,
          async preflight() {},
          async prepareRevision(candidate) {
            await record("prepare", candidate);
            return fixture.compute.prepareRevision(candidate);
          },
          async activateRevision(candidate) {
            await record("activate", candidate);
            if (candidate.id === second?.id) {
              secondActivationAttempts += 1;
              if (secondActivationAttempts === 1) {
                throw new Error("development gateway did not start");
              }
              retryStarted = true;
              await retryRelease;
            }
          },
          async retireRevision(candidate) {
            await record("retire", candidate);
            return fixture.compute.retireRevision(candidate);
          },
        },
        30_000,
        900_000,
        "development",
      );
      await fixture.work(first);

      try {
        second = await fixture.revision(owner, 2);
        await waitFor("activation retry", async () => (retryStarted ? true : undefined));
        assert.equal(await fixture.activeRevision(owner), second.id);
        assert.deepEqual(
          effects.filter(({ action }) => action === "retire"),
          [],
        );
      } finally {
        // Release paused activation before fixture cleanup waits for the worker to stop.
        releaseRetry();
      }

      // Pending finalization restores the retry budget despite making two activation calls.
      assert.equal((await fixture.work(second)).attempt_count, 1);
      assert.equal(secondActivationAttempts, 2);
      assert.equal(await fixture.activeRevision(owner), second.id);
      // Recovery reobserves the published candidate before retrying activation so
      // current readiness is checked even after the active pointer moves.
      assert.deepEqual(effects, [
        { action: "prepare", revisionId: first.id, activeRevisionId: null },
        { action: "activate", revisionId: first.id, activeRevisionId: first.id },
        { action: "prepare", revisionId: second.id, activeRevisionId: first.id },
        { action: "activate", revisionId: second.id, activeRevisionId: second.id },
        { action: "prepare", revisionId: second.id, activeRevisionId: second.id },
        { action: "activate", revisionId: second.id, activeRevisionId: second.id },
        { action: "retire", revisionId: first.id, activeRevisionId: second.id },
      ]);
    },
  );
}
