import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { currentComputeAbortSignal } from "../../apps/controller/src/drivers/compute/operation-context.ts";
import {
  admitRepositoryNetworkPolicy,
  isSecretHarnessAuth,
  type Agent,
  type AgentRevision,
  type ComputeDriver,
  type RepositoryNetworkGrant,
  type SandboxPolicySnapshot,
} from "../../packages/contracts/src/index.ts";
import {
  isRepositoryRuntimeRetirementWork,
  PostgresWorkQueue,
  WorkClaimLostError,
  type OpenClawController,
} from "../../packages/occ/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { registerRevisionSnapshotCase } from "./postgres-worker-agent-revision-refusal-cases.ts";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import { deferWork, makeWorkDue } from "../helpers/postgres-worker-revision-queue.ts";
import type {
  RevisionFixture,
  WorkIdentity,
} from "../helpers/postgres-worker-refused-candidate.ts";
import { repositoryBoundary } from "../helpers/postgres-worker-revision-support.mjs";
import type { createTestSecretDriver } from "../helpers/secret-driver.ts";
import { waitFor, waitUntil, within } from "../helpers/wait-for.ts";

interface DispatchFixture {
  admitInitialRevision: RevisionFixture["admitInitialRevision"];
  advanceMaintenance: RevisionFixture["advanceMaintenance"];
  agent: RevisionFixture["agent"];
  revision: RevisionFixture["revision"];
  actor: RevisionFixture["actor"];
  compute: RevisionFixture["compute"];
  createWorkerPool: RevisionFixture["createWorkerPool"];
  currentAgent: RevisionFixture["currentAgent"];
  expireClaim: RevisionFixture["expireClaim"];
  namespace: RevisionFixture["namespace"];
  observerPool: RevisionFixture["observerPool"];
  productionHarness: RevisionFixture["productionHarness"];
  requestStop: RevisionFixture["requestStop"];
  start: RevisionFixture["start"];
  state: RevisionFixture["state"];
  stop: RevisionFixture["stop"];
  deploymentStatus(
    owner: Pick<Agent, "id">,
    candidate: Pick<AgentRevision, "id">,
  ): ReturnType<OpenClawController["getDeploymentStatus"]>;
  secretDriver: Pick<ReturnType<typeof createTestSecretDriver>, "setResolveOverride">;
  work: RevisionFixture["work"];
}

interface DispatchFixtures {
  revisionTest(name: string, run: (fixture: DispatchFixture) => Promise<void>): void;
  setup(
    context: Pick<TestContext, "after">,
    options: {
      secretAuthMethod?: "api_key" | "codex_pat";
      leaseDurationMs?: number;
      repoDriver?: ReturnType<typeof repositoryBoundary>["driver"];
    },
  ): Promise<DispatchFixture>;
}

type DispatchContext = Parameters<ComputeDriver["prepareRevision"]>[1];
type ComputeEffect = "bind" | "prepare";

function harnessSecretId(owner: Readonly<Agent>): string {
  assert.ok(
    isSecretHarnessAuth(owner.harnessAuth),
    `Agent ${owner.id} has a Harness Secret binding`,
  );
  return owner.harnessAuth.source.id;
}

function observeComputeEffects(compute: ComputeDriver, effects: ComputeEffect[]): ComputeDriver {
  return {
    ...compute,
    async bindAgent() {
      effects.push("bind");
    },
    async prepareRevision(revision) {
      effects.push("prepare");
      return compute.prepareRevision(revision);
    },
  };
}

async function saveRepositoryPolicy(
  fixture: DispatchFixture,
  owner: Pick<Agent, "id">,
  grants: readonly RepositoryNetworkGrant[],
) {
  // The frozen revision uses the same list and version as the Agent's saved policy.
  const desired = await fixture.state.transact(async (unit) => {
    await unit.namespaces.lockNamespace(fixture.namespace.id);
    await unit.agents.lockAgent(fixture.namespace.id, owner.id);
    const current = await unit.sandboxPolicies.find(fixture.namespace.id, owner.id);
    assert.ok(current);
    return unit.sandboxPolicies.save(
      { ...current, version: current.version + 1, repositoryNetworkPolicy: grants },
      current.version,
    );
  });
  assert.ok(desired);
  const repositoryNetworkPolicy = admitRepositoryNetworkPolicy(grants, grants);
  assert.ok(repositoryNetworkPolicy);
  const sandboxPolicy: SandboxPolicySnapshot = {
    driverId: "repository-policy-test-sandbox",
    implementation: "test",
    version: desired.version,
    additions: [],
    defaults: {},
    repositoryNetworkPolicy,
  };
  return { id: desired.id, options: { sandboxDriverId: sandboxPolicy.driverId, sandboxPolicy } };
}

async function settledRevision(fixture: DispatchFixture, revision: WorkIdentity) {
  const queue = new PostgresWorkQueue(fixture.observerPool);
  return waitFor("repository policy candidate settles", async () => {
    const work = await queue.findWork(revision.idempotencyKey);
    return work?.state === "failed_permanent" || work?.state === "succeeded" ? work : undefined;
  });
}

function repositoryCompute(
  compute: ComputeDriver,
  expectedSandboxId: string | undefined,
): ComputeDriver {
  return {
    ...compute,
    validateRepositoryCredentials(harness, sandboxId) {
      assert.equal(harness.mode, "embedded");
      assert.equal(sandboxId, expectedSandboxId);
    },
  };
}

function computeSupportingRepositoryPolicy(compute: ComputeDriver): ComputeDriver {
  return { ...compute, validateProtectedRepositoryNetworkPolicy() {} };
}

export function registerRevisionDispatchCases({ revisionTest, setup }: DispatchFixtures): void {
  for (const variant of ["mismatched", "malformed"] as const) {
    revisionTest(
      `the Worker refuses a ${variant} revision work key before scoped deployment`,
      async (fixture) => {
        const owner = await fixture.agent(`${variant}-revision-work-key`, {
          executionMode: "dedicated",
        });
        const { id: policyId, options } = await saveRepositoryPolicy(fixture, owner, []);
        const candidate = await fixture.revision(owner, 1, options);
        const idempotencyKey =
          variant === "mismatched"
            ? `agent_revision:rev_${randomUUID()}:reconcile`
            : `agent_revision:${candidate.id}:maintenance:01`;
        const namespaceId = fixture.namespace.id;
        const actorId = fixture.actor.id;
        const queue = new PostgresWorkQueue(fixture.observerPool);

        // Keep the canonical deployment for the same revision as a separate control.
        assert.equal((await deferWork(fixture.observerPool, candidate.idempotencyKey)).rowCount, 1);
        await fixture.observerPool.query(
          `INSERT INTO occ.iam_restrictions
             (id, namespace_id, action, resource_kind, resource_id, effect)
           VALUES ($1, $2, 'update', 'sandbox_policy', $3, 'deny')`,
          [`restriction-${randomUUID()}`, namespaceId, policyId],
        );
        await queue.enqueue({
          idempotencyKey,
          namespaceId,
          agentId: owner.id,
          revisionId: candidate.id,
          actorId,
        });

        const effects: ComputeEffect[] = [];
        await fixture.start(
          observeComputeEffects(computeSupportingRepositoryPolicy(fixture.compute), effects),
        );
        const refusal = await waitFor("the invalid Work to settle or reach Compute", async () => {
          const work = await queue.findWork(idempotencyKey);
          return effects.length > 0 || work?.completedAt !== undefined ? work : undefined;
        });
        assert.deepEqual(effects, [], "invalid work cannot bind or prepare this candidate");
        assert.equal(refusal.state, "failed_permanent");
        assert.equal(refusal.reasonCode, "INVALID_TARGET");
        assert.equal(refusal.attemptCount, 1);
        assert.equal(refusal.namespaceId, namespaceId);
        assert.equal(refusal.agentId, owner.id);
        assert.equal(refusal.revisionId, candidate.id);
        assert.equal(refusal.actorId, actorId);
        const evidence = await queue.findWorkAttempt(idempotencyKey);
        assert.equal(evidence?.code, "INVALID_TARGET");
        assert.equal(evidence?.candidateNotStarted, undefined);
        assert.equal((await fixture.currentAgent(owner))?.activeRevisionId, undefined);

        const original = await queue.findWork(candidate.idempotencyKey);
        assert.equal(original?.state, "queued");
        assert.equal(original.attemptCount, 0);
        assert.equal(
          (await makeWorkDue(fixture.observerPool, candidate.idempotencyKey)).rowCount,
          1,
        );
        const denied = await settledRevision(fixture, candidate);
        assert.equal(denied.reasonCode, "AUTHORIZATION_DENIED");
        assert.deepEqual(effects, []);
      },
    );
  }

  for (const settlement of ["permanent", "stale"] as const) {
    test(
      settlement === "permanent"
        ? "permanent work settlement transfers repository cleanup only for the exact revision key"
        : "stale work recovery transfers repository cleanup only for the exact revision key",
      requiresPostgres,
      async (context) => {
        const repository = repositoryBoundary();
        const fixture = await setup(context, { repoDriver: repository.driver });
        const owner = await fixture.agent(`${settlement}-revision-key-cleanup`);
        const revision = await fixture.revision(owner, 1, {
          repositoryCredentials: repository.snapshot,
        });
        const namespaceId = fixture.namespace.id;
        const actorId = fixture.actor.id;
        const queue = new PostgresWorkQueue(fixture.observerPool, { maxAttempts: 1 });
        assert.equal((await deferWork(fixture.observerPool, revision.idempotencyKey)).rowCount, 1);
        const wrongKey = `agent_revision:rev_${randomUUID()}:reconcile`;
        const input = {
          idempotencyKey: wrongKey,
          namespaceId,
          agentId: owner.id,
          revisionId: revision.id,
          actorId,
        };
        const inserted = await queue.enqueue(input);
        assert.deepEqual(await queue.enqueue(input), inserted);

        async function settle(idempotencyKey: string) {
          const claim = await queue.claim();
          assert.ok(claim);
          assert.equal(claim.idempotencyKey, idempotencyKey);
          assert.equal(claim.revisionId, revision.id);
          if (settlement === "permanent") {
            await queue.fail(claim, { code: "INVALID_TARGET" });
          } else {
            await fixture.expireClaim({ id: revision.id, idempotencyKey }, claim.claimToken);
            const recovered = await queue.recoverStale();
            assert.ok(recovered.failed.some((work) => work.idempotencyKey === idempotencyKey));
          }
          const work = await queue.findWork(idempotencyKey);
          assert.equal(work?.state, "failed_permanent");
          assert.equal(
            work.reasonCode,
            settlement === "permanent" ? "INVALID_TARGET" : "LEASE_EXPIRED",
          );
        }

        async function cleanupRows() {
          const { rows } = await fixture.observerPool.query<{
            idempotency_key: string;
            actor_id: string;
            agent_id: string;
            state: string;
          }>(
            `SELECT idempotency_key, actor_id, agent_id, state FROM occ.controller_work
             WHERE namespace_id = $1 AND revision_id = $2 AND idempotency_key LIKE $3`,
            [namespaceId, revision.id, `agent_revision:${revision.id}:repository_cleanup:%`],
          );
          return rows;
        }

        await settle(wrongKey);
        assert.deepEqual(await cleanupRows(), [], "a foreign key grants no cleanup authority");

        assert.equal(
          (await makeWorkDue(fixture.observerPool, revision.idempotencyKey)).rowCount,
          1,
        );
        await settle(revision.idempotencyKey);
        const cleanup = await cleanupRows();
        assert.equal(cleanup.length, 1);
        const [retirement] = cleanup;
        assert.ok(retirement);
        assert.ok(
          isRepositoryRuntimeRetirementWork({
            idempotencyKey: retirement.idempotency_key,
            agentId: retirement.agent_id,
            revisionId: revision.id,
          }),
        );
        assert.equal(retirement.agent_id, owner.id);
        assert.equal(retirement.actor_id, actorId);
        assert.equal(retirement.state, "queued");
      },
    );
  }

  revisionTest(
    "recovered revision maintenance can settle only under its replacement claim",
    async (fixture) => {
      const { owner, candidate } = await fixture.admitInitialRevision(
        "revision-maintenance-key-recovery",
      );
      const compute: ComputeDriver = { ...fixture.compute, maintenanceIntervalMs: 3_600_000 };
      await fixture.start(compute);
      await fixture.work(candidate, "succeeded");
      await fixture.stop();

      const key = (await fixture.advanceMaintenance(candidate)).rows[0]?.idempotency_key;
      assert.ok(key);
      const maintenance = { id: candidate.id, idempotencyKey: key };
      const queue = new PostgresWorkQueue(fixture.observerPool);
      const expired = await queue.claim();
      assert.ok(expired);
      assert.equal(expired.idempotencyKey, key);
      assert.equal(expired.actorId, fixture.actor.id);
      assert.equal(expired.agentId, owner.id);
      assert.equal(expired.revisionId, candidate.id);
      await fixture.expireClaim(maintenance, expired.claimToken);
      const recovery = await queue.recoverStale();
      assert.equal(recovery.requeued, 1);
      assert.equal((await makeWorkDue(fixture.observerPool, key)).rowCount, 1);

      const resume = Promise.withResolvers<void>();
      let preparing = false;
      await fixture.start({
        ...compute,
        async prepareRevision(revision, deploymentContext) {
          assert.equal(revision.id, candidate.id);
          preparing = true;
          await resume.promise;
          return compute.prepareRevision(revision, deploymentContext);
        },
      });
      try {
        await waitUntil("recovered maintenance enters Compute", () => preparing);
        const replacement = await queue.findWork(key);
        assert.equal(replacement?.state, "claimed");
        assert.ok(replacement.claimToken);
        assert.notEqual(replacement.claimToken, expired.claimToken);
        assert.equal(replacement.attemptCount, expired.attemptCount + 1);
        assert.equal(replacement.actorId, expired.actorId);
        await assert.rejects(queue.fail(expired, { code: "INVALID_TARGET" }), WorkClaimLostError);
        assert.equal((await queue.findWork(key))?.claimToken, replacement.claimToken);
      } finally {
        resume.resolve();
      }
      await fixture.work(maintenance, "succeeded");
      assert.equal((await fixture.currentAgent(owner))?.activeRevisionId, candidate.id);
    },
  );

  revisionTest(
    "a restarted worker refuses explicit deny-all before preparing an ordinary revision",
    async (fixture) => {
      const owner = await fixture.agent("repository-policy-worker-restart", {
        executionMode: "dedicated",
      });
      const { options } = await saveRepositoryPolicy(fixture, owner, []);
      const previous = await fixture.revision(owner, 1, options);
      const supportingCompute = computeSupportingRepositoryPolicy(fixture.compute);
      await fixture.start(supportingCompute);
      await fixture.work(previous, "succeeded");
      await fixture.stop();

      // Preserve the admitted Compute identity while its restarted configuration refuses the policy.
      const candidate = await fixture.revision(owner, 2, options);
      assert.equal(candidate.executionAdmission.mode, "unprotected");
      const { owner: control, candidate: ordinary } = await fixture.admitInitialRevision(
        "no-explicit-repository-policy",
      );
      const checked: string[] = [];
      const prepared: string[] = [];
      await fixture.start({
        ...supportingCompute,
        validateProtectedRepositoryNetworkPolicy(revision) {
          assert.ok("id" in revision && typeof revision.id === "string");
          checked.push(revision.id);
          return Promise.reject(
            new Error("Compute no longer admits this repository network policy."),
          );
        },
        async prepareRevision(revision, context) {
          prepared.push(revision.id);
          return supportingCompute.prepareRevision(revision, context);
        },
      });
      await fixture.work(ordinary, "succeeded");
      const terminal = await settledRevision(fixture, candidate);
      assert.deepEqual(
        {
          state: terminal.state,
          reason: terminal.reasonCode,
          candidateWasPrepared: prepared.includes(candidate.id),
          keptPredecessor: (await fixture.currentAgent(owner))?.activeRevisionId === previous.id,
        },
        {
          state: "failed_permanent",
          reason: "REPOSITORY_POLICY_PLACEMENT_UNSUPPORTED",
          candidateWasPrepared: false,
          keptPredecessor: true,
        },
      );
      assert.deepEqual((await fixture.deploymentStatus(owner, candidate)).error, {
        code: "REPOSITORY_POLICY_PLACEMENT_UNSUPPORTED",
        message:
          "The selected execution placement cannot enforce this version's repository network policy. Ask an Installation administrator for a placement that supports the policy, then deploy again.",
      });
      assert.deepEqual(checked, [candidate.id]);
      assert.deepEqual(prepared, [ordinary.id]);
      assert.equal((await fixture.currentAgent(control))?.activeRevisionId, ordinary.id);
    },
  );

  test(
    "a queued scoped deployment cannot replace an unscoped revision",
    requiresPostgres,
    async (context) => {
      const fixture = await setup(context, {});
      const owner = await fixture.agent("legacy-history");
      const previous = await fixture.revision(owner, 1);
      await fixture.start(fixture.compute);
      await fixture.work(previous, "succeeded");
      await fixture.stop();
      const { options } = await saveRepositoryPolicy(fixture, owner, []);
      const candidate = await fixture.revision(owner, 2, options);
      const calls: string[] = [];
      await fixture.start({
        ...computeSupportingRepositoryPolicy(fixture.compute),
        requiresStoppedPredecessors: () => true,
        async bindAgent() {
          calls.push("bind");
        },
        async prepareRevision(revision, ctx) {
          calls.push("prepare");
          return fixture.compute.prepareRevision(revision, ctx);
        },
        async stopRevision() {
          calls.push("stop");
        },
        async retireRevision() {
          calls.push("retire");
        },
      });
      const result = await settledRevision(fixture, candidate);
      assert.deepEqual(calls, []);
      assert.equal(result.reasonCode, "REPOSITORY_POLICY_HISTORY_INCOMPATIBLE");
      assert.deepEqual((await fixture.deploymentStatus(owner, candidate)).error, {
        code: "REPOSITORY_POLICY_HISTORY_INCOMPATIBLE",
        message:
          "This Agent has deployment history without a repository network policy. Save the policy for a new Agent before its first deployment.",
      });
      assert.equal((await fixture.currentAgent(owner))?.activeRevisionId, previous.id);
    },
  );
  for (const deferred of [false, true]) {
    test(
      deferred
        ? "a prior deferred scoped attempt fences shared predecessor maintenance after refusal"
        : "shared predecessor maintenance can repair after a scoped candidate was never started",
      requiresPostgres,
      async (context) => {
        const fixture = await setup(context, {});
        const owner = await fixture.agent("legacy-maintenance-repair");
        const previous = await fixture.revision(owner, 1);
        const prepared: string[] = [];
        const compute: ComputeDriver = {
          ...computeSupportingRepositoryPolicy(fixture.compute),
          maintenanceIntervalMs: 3_600_000,
          prepareRevision(revision, ctx) {
            prepared.push(revision.id);
            return fixture.compute.prepareRevision(revision, ctx);
          },
        };
        assert.equal(compute.requiresStoppedPredecessors, undefined);
        await fixture.start(compute);
        await fixture.work(previous, "succeeded");
        await fixture.stop();
        const { options } = await saveRepositoryPolicy(fixture, owner, []);
        const candidate = await fixture.revision(owner, 2, options);
        const queue = new PostgresWorkQueue(fixture.observerPool);
        if (deferred) {
          const earlier = await queue.claim();
          assert.ok(earlier);
          assert.equal(earlier.idempotencyKey, candidate.idempotencyKey);
          await queue.defer(earlier, { code: "REVISION_INCOMPLETE" }, { delayMs: 1 });
          // A prior attempt can have prepared a Gateway, despite the reset attempt count.
          assert.equal((await queue.findWork(candidate.idempotencyKey))?.attemptCount, 0);
        }
        await fixture.start(compute);
        const refused = await settledRevision(fixture, candidate);
        const evidence = await queue.findWorkAttempt(candidate.idempotencyKey);
        assert.equal(evidence?.candidateNotStarted, deferred ? undefined : true);
        assert.deepEqual(prepared, [previous.id]);
        const key = (await fixture.advanceMaintenance(previous)).rows[0]?.idempotency_key;
        assert.ok(key);
        const attempt = await waitFor("predecessor maintenance records its decision", () =>
          queue.findWorkAttempt(key),
        );
        assert.ok(attempt);
        if (deferred) {
          assert.equal(refused.reasonCode, "REPOSITORY_POLICY_HISTORY_INCOMPATIBLE");
          assert.equal(attempt.code, "SUCCESSOR_EXECUTION_ADMISSION_UNAVAILABLE");
          assert.deepEqual(prepared, [previous.id]);
        } else {
          assert.deepEqual(prepared, [previous.id, previous.id]);
          assert.equal(refused.reasonCode, "REPOSITORY_POLICY_HISTORY_INCOMPATIBLE");
        }
        assert.equal((await fixture.currentAgent(owner))?.activeRevisionId, previous.id);
      },
    );
  }
  test(
    "a recovered exclusive refusal fences predecessor repair while a shared preparation is outstanding",
    requiresPostgres,
    async (context) => {
      const fixture = await setup(context, { leaseDurationMs: 60_000 });
      const owner = await fixture.agent("replacement-placement-change");
      const { options } = await saveRepositoryPolicy(fixture, owner, []);
      const previous = await fixture.revision(owner, 1, options);
      const loseResponse = Promise.withResolvers<void>();
      const finishWrite = Promise.withResolvers<void>();
      const prepared: string[] = [];
      let outstanding: Promise<void> | undefined;
      let gateway: string | undefined;
      const shared: ComputeDriver = {
        ...computeSupportingRepositoryPolicy(fixture.compute),
        maintenanceIntervalMs: 3_600_000,
        async prepareRevision(revision, ctx) {
          prepared.push(revision.id);
          if (revision.id !== previous.id) {
            // The provider accepted a write whose response the first Worker loses.
            // The write itself can outlive both its claim and the Worker.
            outstanding = finishWrite.promise.then(() => {
              gateway = revision.id;
            });
            await loseResponse.promise;
            throw new Error("Shared preparation response lost.");
          }
          gateway = revision.id;
          return fixture.compute.prepareRevision(revision, ctx);
        },
      };
      assert.equal(shared.requiresStoppedPredecessors, undefined);
      await fixture.start(shared);
      await fixture.work(previous, "succeeded");
      const candidate = await fixture.revision(owner, 2, options);
      try {
        await waitUntil("shared prepare accepted", () => outstanding !== undefined);
        const original = await fixture.work(candidate, "claimed");
        assert.ok(original.claim_token);
        await fixture.expireClaim(candidate, original.claim_token);
        const queue = new PostgresWorkQueue(fixture.observerPool);
        assert.equal((await queue.recoverStale()).recovered, 1);
        const stopping = fixture.stop();
        loseResponse.resolve();
        await stopping;
        await fixture.start({
          ...shared,
          requiresStoppedPredecessors: () => true,
          validateProtectedRepositoryNetworkPolicy(revision) {
            if ("id" in revision && revision.id === candidate.id) {
              throw new Error("Compute can no longer enforce this policy.");
            }
          },
        });
        const refused = await settledRevision(fixture, candidate);
        assert.equal(refused.reasonCode, "REPOSITORY_POLICY_PLACEMENT_UNSUPPORTED");
        assert.equal(
          (await queue.findWorkAttempt(candidate.idempotencyKey))?.candidateNotStarted,
          undefined,
        );
        assert.equal((await fixture.currentAgent(owner))?.activeRevisionId, previous.id);
        const key = (await fixture.advanceMaintenance(previous)).rows[0]?.idempotency_key;
        assert.ok(key);
        const repair = await settledRevision(fixture, { id: previous.id, idempotencyKey: key });
        assert.equal(repair.reasonCode, "SUCCESSOR_EXECUTION_ADMISSION_UNAVAILABLE");
        assert.deepEqual(prepared, [previous.id, candidate.id]);
        assert.equal(gateway, previous.id);
      } finally {
        loseResponse.resolve();
        finishWrite.resolve();
        await outstanding;
      }
      assert.equal(gateway, candidate.id);
    },
  );
  for (const capability of [
    "legacy",
    "missing",
    "refused",
    "supported",
    "later supported",
    "revoked",
    "refused after stop began",
    "missing work",
    "mismatched work",
  ] as const) {
    test(
      capability === "revoked"
        ? "predecessor maintenance cannot retire its runtime for a scoped deployment with revoked policy authority"
        : `repository policy successor with ${capability} Compute enforcement during predecessor maintenance`,
      requiresPostgres,
      async (context) => {
        const repository = repositoryBoundary();
        const fixture = await setup(context, { repoDriver: repository.driver });
        const owner = await fixture.agent("repository-policy-maintenance");
        const initial =
          capability === "legacy" || capability === "missing"
            ? undefined
            : await saveRepositoryPolicy(fixture, owner, []);
        const previous = await fixture.revision(owner, 1, {
          ...initial?.options,
          repositoryCredentials: repository.snapshot,
        });
        const prepared: string[] = [];
        const stopped: string[] = [];
        const retired: string[] = [];
        const compute: ComputeDriver = {
          ...repositoryCompute(fixture.compute, initial?.options.sandboxDriverId),
          ...(capability === "missing work" ? {} : { requiresStoppedPredecessors: () => true }),
          maintenanceIntervalMs: 3_600_000,
          async prepareRevision(revision, deploymentContext) {
            if (
              revision.revision > 1 &&
              (capability === "supported" || capability === "later supported")
            ) {
              assert.ok(stopped.includes(previous.id), "the deployment stopped its predecessor");
            }
            prepared.push(revision.id);
            const observed = await fixture.compute.prepareRevision(revision, deploymentContext);
            return capability === "refused after stop began" && revision.revision === 2
              ? { ...observed, ready: false }
              : observed;
          },
          async stopRevision(revision) {
            await fixture.compute.stopRevision(revision);
            stopped.push(revision.id);
          },
          async retireRevision(revision) {
            await fixture.compute.retireRevision(revision);
            retired.push(revision.id);
          },
        };
        await fixture.start(initial ? computeSupportingRepositoryPolicy(compute) : compute);
        await fixture.work(previous, "succeeded");
        await fixture.stop();

        const policy =
          capability === "legacy" ? undefined : await saveRepositoryPolicy(fixture, owner, []);
        const options = policy?.options;
        const candidate =
          capability === "missing work" || capability === "mismatched work"
            ? await fixture.state.transactWithQueue(async (unit, queue) => {
                // Construct an inconsistent admission snapshot through the storage interfaces.
                // The application role cannot delete or reassign an existing queue row.
                const namespaceId = fixture.namespace.id;
                await unit.namespaces.lockNamespace(namespaceId);
                await unit.agents.lockAgent(namespaceId, owner.id);
                const predecessor = await unit.revisions.findRevision(
                  namespaceId,
                  owner.id,
                  previous.id,
                );
                assert.ok(predecessor);
                const { repositoryCredentials, ...admission } = predecessor;
                assert.ok(repositoryCredentials);
                const revision = await unit.revisions.createRevision({
                  ...admission,
                  ...options,
                  id: `rev_${randomUUID()}`,
                  revision: 2,
                });
                const idempotencyKey = `agent_revision:${revision.id}:reconcile`;
                if (capability === "mismatched work") {
                  await queue.enqueue({
                    idempotencyKey,
                    namespaceId,
                    agentId: owner.id,
                    revisionId: previous.id,
                    actorId: fixture.actor.id,
                    availableAt: new Date(0),
                  });
                }
                return { ...revision, idempotencyKey };
              })
            : await fixture.revision(owner, 2, options);
        const saved = await fixture.state.read((view) =>
          view.revisions.findRevision(fixture.namespace.id, owner.id, candidate.id),
        );
        assert.ok(saved);
        assert.deepEqual(
          saved.sandboxPolicy?.repositoryNetworkPolicy?.grants,
          capability === "legacy" ? undefined : [],
        );
        const later =
          capability === "legacy" || capability === "later supported"
            ? await fixture.revision(owner, 3, options)
            : undefined;
        if (capability === "revoked") {
          assert.ok(policy);
          // Keep the predecessor's maintenance grants. Revoke only the policy
          // update permission the successor needs for its frozen scoped deployment.
          await fixture.observerPool.query(
            `INSERT INTO occ.iam_restrictions
               (id, namespace_id, action, resource_kind, resource_id, effect)
             VALUES ($1, $2, 'update', 'sandbox_policy', $3, 'deny')`,
            [`restriction-${randomUUID()}`, fixture.namespace.id, policy.id],
          );
        }
        if (capability === "refused after stop began") {
          await fixture.start(computeSupportingRepositoryPolicy(compute));
          const queue = new PostgresWorkQueue(fixture.observerPool);
          // Entering Compute does not release the claim. Park the candidate only after
          // its recorded deferral, in the same update that checks it is unclaimed.
          await waitFor("the prepared candidate to defer and release its claim", async () => {
            if (!(await queue.findWorkAttempt(candidate.idempotencyKey, "REVISION_INCOMPLETE"))) {
              return;
            }
            const parked = await fixture.observerPool.query(
              `UPDATE occ.controller_work SET available_at = clock_timestamp() + interval '1 hour'
               WHERE idempotency_key = $1 AND state = 'queued' AND claim_token IS NULL`,
              [candidate.idempotencyKey],
            );
            return parked.rowCount === 1 ? true : undefined;
          });
          assert.ok(prepared.includes(candidate.id));
          await fixture.stop();
          const replacement = await fixture.state.read((view) =>
            view.agents.findPredecessorReplacement(fixture.namespace.id, owner.id),
          );
          assert.equal(replacement?.predecessorRevisionId, previous.id);
          assert.equal(replacement?.phase, "stopping");
        }
        if (capability === "missing work") {
          assert.equal(compute.requiresStoppedPredecessors, undefined);
        }
        const beforeMaintenance = {
          prepared: [...prepared],
          stopped: [...stopped],
          retired: [...retired],
        };
        const closedBeforeMaintenance = repository.calls.filter(
          ({ operation }) => operation === "close",
        ).length;
        // Hold candidate work so no candidate-owned stop can mask the
        // effects of the predecessor's maintenance claim.
        if (capability !== "refused after stop began") {
          await fixture.observerPool.query(
            "UPDATE occ.controller_work SET available_at = clock_timestamp() + interval '1 hour' WHERE idempotency_key = ANY($1::text[])",
            [[candidate.idempotencyKey, ...(later ? [later.idempotencyKey] : [])]],
          );
        }
        const {
          rows: [next],
        } = await fixture.advanceMaintenance(previous);
        assert.ok(next);
        const validate: NonNullable<
          ComputeDriver["validateProtectedRepositoryNetworkPolicy"]
        > = async (admitted) => {
          assert.deepEqual(admitted.sandboxPolicy?.repositoryNetworkPolicy?.grants, []);
          assert.ok("id" in admitted && typeof admitted.id === "string");
          if (
            capability !== "supported" &&
            capability !== "revoked" &&
            capability !== "missing work" &&
            capability !== "mismatched work" &&
            admitted.id !== previous.id &&
            admitted.id !== later?.id
          ) {
            throw new Error("Compute cannot enforce the admitted repository policy.");
          }
        };
        await fixture.start(
          capability === "missing"
            ? compute
            : { ...compute, validateProtectedRepositoryNetworkPolicy: validate },
        );
        const work = await settledRevision(fixture, {
          id: previous.id,
          idempotencyKey: next.idempotency_key,
        });
        const retirement = () =>
          fixture.observerPool.query(
            "SELECT idempotency_key FROM occ.controller_work WHERE revision_id = $1 AND idempotency_key LIKE $2",
            [previous.id, `agent_revision:${previous.id}:repository_cleanup:retire:%`],
          );
        const cleanup = await retirement();
        assert.deepEqual(
          prepared,
          beforeMaintenance.prepared,
          "maintenance must not reprepare the predecessor",
        );
        if (capability === "legacy") {
          assert.equal(work.reasonCode, "REVISION_SUPERSEDED");
          assert.equal(cleanup.rowCount, 1, "legacy supersession transfers retirement");
          const supersession = await fixture.observerPool.query(
            `SELECT details->>'activeRevisionId' AS successor FROM occ.audit_events
             WHERE resource_id = $1 AND action = 'openclaw.agents.lifecycle.supersede'`,
            [previous.id],
          );
          assert.deepEqual(supersession.rows, [{ successor: candidate.id }]);
        } else {
          assert.equal(
            cleanup.rowCount,
            0,
            "predecessor maintenance cannot enqueue cleanup for a scoped successor",
          );
          assert.equal(work.reasonCode, "SUCCESSOR_EXECUTION_ADMISSION_UNAVAILABLE");
          assert.equal((await fixture.currentAgent(owner))?.activeRevisionId, previous.id);
          assert.deepEqual(stopped, beforeMaintenance.stopped);
          assert.deepEqual(retired, beforeMaintenance.retired);
          assert.equal(
            repository.calls.filter(({ operation }) => operation === "close").length,
            closedBeforeMaintenance,
          );
        }

        if (capability === "supported" || capability === "later supported") {
          // Release both claims. Only the authorized, enforceable deployment
          // can stop its predecessor, prepare, activate and retire it.
          const replacement = later ?? candidate;
          await fixture.observerPool.query(
            "UPDATE occ.controller_work SET available_at = clock_timestamp() WHERE idempotency_key = ANY($1::text[])",
            [[candidate.idempotencyKey, replacement.idempotencyKey]],
          );
          await fixture.work(replacement, "succeeded");
          assert.equal((await fixture.currentAgent(owner))?.activeRevisionId, replacement.id);
          assert.deepEqual(prepared, [...beforeMaintenance.prepared, replacement.id]);
          assert.ok(stopped.includes(previous.id));
          assert.ok(retired.includes(previous.id));
          assert.equal((await retirement()).rowCount, 0);
        }

        if (
          capability === "refused" ||
          capability === "revoked" ||
          capability === "refused after stop began"
        ) {
          // Let the real deployment refusal settle. A healthy predecessor can
          // resume maintenance, while a replacement stop cannot be rolled back.
          await fixture.observerPool.query(
            "UPDATE occ.controller_work SET available_at = created_at WHERE idempotency_key = $1",
            [candidate.idempotencyKey],
          );
          assert.equal(
            (await settledRevision(fixture, candidate)).reasonCode,
            capability === "revoked"
              ? "AUTHORIZATION_DENIED"
              : "REPOSITORY_POLICY_PLACEMENT_UNSUPPORTED",
          );
          const {
            rows: [following],
          } = await fixture.advanceMaintenance(previous);
          assert.ok(following, "deferral keeps the maintenance chain");
          const followup = await settledRevision(fixture, {
            id: previous.id,
            idempotencyKey: following.idempotency_key,
          });
          assert.equal((await fixture.currentAgent(owner))?.activeRevisionId, previous.id);
          assert.equal((await retirement()).rowCount, 0);
          if (capability !== "refused after stop began") {
            assert.equal(followup.reasonCode, "REVISION_ALREADY_ACTIVE");
            assert.deepEqual(prepared, [...beforeMaintenance.prepared, previous.id]);
            assert.deepEqual(stopped, []);
          } else {
            assert.equal(followup.reasonCode, "SUCCESSOR_EXECUTION_ADMISSION_UNAVAILABLE");
            assert.deepEqual(prepared, beforeMaintenance.prepared);
          }
        }
      },
    );
  }

  for (const [placement, active, enforcement] of [
    ["shared", false, "missing"],
    ["exclusive", false, "missing"],
    ["shared", true, "missing"],
    ["shared", true, "missing with a later queued revision"],
    ["shared", true, "still converging"],
    ["shared", true, "refused"],
    ["shared", true, "supported"],
    ["shared", true, "legacy"],
    ["shared", true, "overdue original"],
  ] as const) {
    const overdue = enforcement === "overdue original";
    const converging = enforcement === "still converging";
    const name = overdue
      ? "an overdue deployment cannot retire its active revision on behalf of an unenforceable held successor"
      : enforcement === "missing with a later queued revision"
        ? "a queued revision does not hide a shared Gateway held by a scoped revision"
        : converging
          ? "predecessor maintenance leaves a converging scoped Gateway in place"
          : active
            ? `an active predecessor handles a held shared successor with ${enforcement} repository policy enforcement`
            : `a held repository policy successor without enforcement cannot supersede or reprepare an older ${placement} revision`;
    test(name, requiresPostgres, async (context) => {
      const repository = repositoryBoundary();
      const fixture = await setup(context, { repoDriver: repository.driver });
      const owner = await fixture.agent("held-repository-policy-successor");
      const queue = new PostgresWorkQueue(fixture.observerPool);
      const initial =
        enforcement === "legacy" ? undefined : await saveRepositoryPolicy(fixture, owner, []);
      const older = await fixture.revision(owner, 1, {
        ...initial?.options,
        ...(active ? { repositoryCredentials: repository.snapshot } : {}),
      });
      const prepared: string[] = [];
      const activated: string[] = [];
      const stopped: string[] = [];
      const retired: string[] = [];
      const compute: ComputeDriver = {
        ...repositoryCompute(fixture.compute, initial?.options.sandboxDriverId),
        // The predecessor itself remains enforceable during recovery.
        // Only the successor's placement has lost its capability.
        validateProtectedRepositoryNetworkPolicy(revision) {
          assert.ok("id" in revision);
          if (revision.id !== older.id) {
            throw new Error("The replacement placement is unavailable.");
          }
        },
        maintenanceIntervalMs: 3_600_000,
        requiresStoppedPredecessors: (revision) =>
          placement === "exclusive" && revision.id === older.id,
        async prepareRevision(revision, deploymentContext) {
          prepared.push(revision.id);
          const observation = await fixture.compute.prepareRevision(revision, deploymentContext);
          if (revision.revision !== 2) {
            return observation;
          }
          if (converging) {
            return { ...observation, ready: false };
          }
          // Shared Compute installed the candidate before its probe failed.
          // The failure leaves that runtime in place with the old active pointer.
          return {
            ...observation,
            ready: false,
            runtimeFailure: {
              component: "agent",
              check: "model-probe",
              checkedAt: new Date().toISOString(),
              code: "MODEL_PROBE_FAILED",
              cause: { kind: "PROBE_STATUS", detail: "format" },
            },
          };
        },
        async activateRevision(revision, deploymentContext) {
          activated.push(revision.id);
          if (overdue && revision.id === older.id) {
            throw new Error("The original activation was not acknowledged");
          }
          await fixture.compute.activateRevision?.(revision, deploymentContext);
        },
        async stopRevision(revision) {
          stopped.push(revision.id);
          await fixture.compute.stopRevision(revision);
        },
        async retireRevision(revision) {
          retired.push(revision.id);
          await fixture.compute.retireRevision(revision);
        },
      };
      if (active) {
        await fixture.start(initial ? computeSupportingRepositoryPolicy(compute) : compute);
        if (overdue) {
          const original = await waitFor("original activation is pending", () =>
            queue.findWorkAttempt(older.idempotencyKey, "REVISION_FINALIZATION_INCOMPLETE"),
          );
          assert.ok(original);
        } else {
          await fixture.work(older, "succeeded");
        }
        await fixture.stop();
      }
      if (!active || overdue) {
        await fixture.observerPool.query(
          "UPDATE occ.controller_work SET available_at = clock_timestamp() + interval '1 hour' WHERE idempotency_key = $1",
          [older.idempotencyKey],
        );
      }
      const options =
        enforcement === "legacy"
          ? undefined
          : (await saveRepositoryPolicy(fixture, owner, [])).options;
      const candidate = await fixture.revision(owner, 2, options);
      await fixture.start(computeSupportingRepositoryPolicy(compute));
      if (converging) {
        await waitFor("the scoped deployment stays queued after preparation", () =>
          queue.findWorkAttempt(candidate.idempotencyKey, "REVISION_INCOMPLETE"),
        );
      } else {
        assert.equal(
          (await settledRevision(fixture, candidate)).reasonCode,
          "RUNTIME_MODEL_PROBE_FAILED",
        );
      }
      await fixture.stop();
      if (converging) {
        // Keep the already-prepared candidate queued while maintenance runs.
        // A queued operation with prior Compute effects can still own the Gateway.
        const parked = await fixture.observerPool.query(
          "UPDATE occ.controller_work SET available_at = clock_timestamp() + interval '1 hour' WHERE idempotency_key = $1 AND state = 'queued'",
          [candidate.idempotencyKey],
        );
        assert.equal(parked.rowCount, 1);
      }
      assert.equal(
        (await fixture.currentAgent(owner))?.activeRevisionId,
        active ? older.id : undefined,
      );

      const queued =
        enforcement === "missing with a later queued revision"
          ? await fixture.revision(owner, 3, options)
          : undefined;
      if (queued !== undefined) {
        // A later admission is only queued. It has not touched the Gateway
        // installed by the held, deny-all revision.
        const moved = await fixture.observerPool.query(
          "UPDATE occ.controller_work SET available_at = clock_timestamp() + interval '1 hour' WHERE idempotency_key = $1 AND state = 'queued'",
          [queued.idempotencyKey],
        );
        assert.equal(moved.rowCount, 1);
      }

      if (active) {
        const before = {
          prepared: [...prepared],
          activated: [...activated],
          stopped: [...stopped],
          retired: [...retired],
        };
        if (overdue) {
          // The original work already published its pointer. A short restart
          // deadline makes the ordinary terminal path eligible for this claim.
          const pending = await fixture.observerPool.query(
            `UPDATE occ.controller_work SET available_at = clock_timestamp()
               WHERE idempotency_key = $1 AND state = 'queued'
                 AND created_at + interval '1 millisecond' < clock_timestamp()`,
            [older.idempotencyKey],
          );
          assert.equal(pending.rowCount, 1);
        }
        const work = overdue
          ? older
          : {
              id: older.id,
              idempotencyKey: (await fixture.advanceMaintenance(older)).rows[0]?.idempotency_key,
            };
        assert.ok(work.idempotencyKey);
        await fixture.start(
          enforcement === "refused"
            ? {
                ...compute,
                async validateProtectedRepositoryNetworkPolicy(revision) {
                  if ("id" in revision && revision.id === older.id) {
                    return;
                  }
                  throw new Error("Compute cannot enforce the admitted repository policy.");
                },
              }
            : enforcement === "supported"
              ? computeSupportingRepositoryPolicy(compute)
              : compute,
          overdue ? { convergenceTimeoutMs: 1 } : undefined,
        );
        const key = work.idempotencyKey;
        if (overdue) {
          const disposition = await waitFor(
            "overdue predecessor records its disposition",
            async () => {
              const blocked = await queue.findWorkAttempt(
                key,
                "SUCCESSOR_EXECUTION_ADMISSION_UNAVAILABLE",
              );
              const current = await queue.findWork(key);
              return current?.state === "failed_permanent" || blocked !== undefined
                ? (current?.reasonCode ?? blocked?.code)
                : undefined;
            },
          );
          assert.equal(disposition, "SUCCESSOR_EXECUTION_ADMISSION_UNAVAILABLE");
        } else {
          const result = await settledRevision(fixture, { id: older.id, idempotencyKey: key });
          if (enforcement !== "legacy") {
            assert.deepEqual(prepared, before.prepared, "the held revision still owns the Gateway");
          }
          assert.equal(
            result.reasonCode,
            enforcement === "legacy"
              ? "REVISION_ALREADY_ACTIVE"
              : "SUCCESSOR_EXECUTION_ADMISSION_UNAVAILABLE",
          );
        }
        if (enforcement === "legacy") {
          assert.deepEqual(prepared, [...before.prepared, older.id]);
          assert.deepEqual(activated, [...before.activated, older.id]);
        } else {
          assert.deepEqual(prepared, before.prepared);
          assert.deepEqual(activated, before.activated);
        }
        assert.deepEqual(stopped, before.stopped);
        assert.deepEqual(retired, before.retired);
        const retirement = await fixture.observerPool.query(
          "SELECT idempotency_key FROM occ.controller_work WHERE revision_id = $1 AND idempotency_key LIKE $2",
          [older.id, `agent_revision:${older.id}:repository_cleanup:retire:%`],
        );
        assert.equal(retirement.rowCount, 0);
        assert.equal((await fixture.currentAgent(owner))?.activeRevisionId, older.id);
        if (queued === undefined) {
          // An explicit Stop still owns shutdown after the held-successor check.
          const stop = await fixture.requestStop(owner);
          await fixture.work(stop, "succeeded");
          assert.equal((await fixture.currentAgent(owner))?.activeRevisionId, undefined);
          assert.ok(stopped.includes(older.id));
        } else {
          // The later deployment can replace the Gateway under its own claim
          // once Compute supports its policy again.
          await fixture.stop();
          await fixture.observerPool.query(
            "UPDATE occ.controller_work SET available_at = clock_timestamp() WHERE idempotency_key = $1 AND state = 'queued'",
            [queued.idempotencyKey],
          );
          await fixture.start(computeSupportingRepositoryPolicy(compute));
          await fixture.work(queued, "succeeded");
          assert.equal((await fixture.currentAgent(owner))?.activeRevisionId, queued.id);
          assert.deepEqual(prepared, [...before.prepared, queued.id]);
          assert.deepEqual(activated, [...before.activated, queued.id]);
          assert.deepEqual(retired, [...before.retired, older.id, candidate.id]);
          assert.deepEqual(stopped, before.stopped);
        }
        return;
      }

      await fixture.observerPool.query(
        "UPDATE occ.controller_work SET available_at = clock_timestamp() WHERE idempotency_key = $1",
        [older.idempotencyKey],
      );
      await fixture.start(compute);
      const disposition = await waitFor(
        "the older deployment to record its disposition",
        async () => {
          const blocked = await queue.findWorkAttempt(
            older.idempotencyKey,
            "SUCCESSOR_EXECUTION_ADMISSION_UNAVAILABLE",
          );
          const work = await queue.findWork(older.idempotencyKey);
          if (blocked !== undefined || work?.state === "succeeded" || prepared.includes(older.id)) {
            return { blocked: blocked !== undefined, settled: work?.state === "succeeded" };
          }
          return undefined;
        },
      );
      assert.deepEqual(disposition, { blocked: true, settled: false });
      assert.deepEqual(prepared, [candidate.id]);
      assert.equal((await fixture.currentAgent(owner))?.activeRevisionId, undefined);
    });
  }

  for (const [boundary, activationOrder] of [
    ["preparation on shared Compute", "afterCommit"],
    ["activation before commit", "beforeCommit"],
    ["activation after commit", "afterCommit"],
  ] as const) {
    test(
      `a successor claim prevents ${boundary} before the stale signal aborts`,
      requiresPostgres,
      async (context) => {
        // Leave time before the next heartbeat so the database can transfer the claim
        // while the old Worker's local cancellation signal is still clear.
        const fixture = await setup(context, { leaseDurationMs: 60_000 });
        const owner = await fixture.agent("repository-policy-stale-claim", {
          executionMode: "dedicated",
        });
        const { options } = await saveRepositoryPolicy(fixture, owner, []);
        const candidate = await fixture.revision(owner, 1, options);
        const release = Promise.withResolvers<void>();
        const activations: string[] = [];
        const beforePrepare = boundary === "preparation on shared Compute";
        const preparations: string[] = [];
        assert.equal(fixture.compute.requiresStoppedPredecessors, undefined);
        let validationSignal: AbortSignal | undefined;
        let claimLost = false;
        await fixture.start(
          {
            ...fixture.compute,
            activationOrder,
            validateProtectedRepositoryNetworkPolicy() {
              // The earlier Secret-context check runs outside the Compute operation.
              const signal = currentComputeAbortSignal();
              const atBoundary = beforePrepare
                ? preparations.length === 0
                : preparations.length > 0;
              if (signal && atBoundary) {
                validationSignal = signal;
                // Validation can return successfully even after the claim expires.
                return release.promise;
              }
            },
            async prepareRevision(revision, deploymentContext) {
              preparations.push(revision.id);
              return fixture.compute.prepareRevision(revision, deploymentContext);
            },
            async activateRevision(revision) {
              activations.push(revision.id);
            },
          },
          {
            emit: ({ event, code, workId }) => {
              if (
                event === "worker.error" &&
                code === "CLAIM_LOST" &&
                workId === candidate.idempotencyKey
              ) {
                claimLost = true;
              }
            },
          },
        );
        const recoveryQueue = new PostgresWorkQueue(fixture.observerPool, {
          leaseDurationMs: 30_000,
          maxAttempts: 5,
          random: () => 0,
        });
        let recovered;
        try {
          const signal = await waitFor(
            `${boundary} repository policy validation`,
            () => validationSignal,
          );
          assert.equal(signal.aborted, false);
          const activeRevisionId =
            !beforePrepare && activationOrder === "afterCommit" ? candidate.id : undefined;
          assert.equal((await fixture.currentAgent(owner))?.activeRevisionId, activeRevisionId);
          const original = await fixture.work(candidate, "claimed");
          assert.ok(original.claim_token);
          await fixture.expireClaim(candidate, original.claim_token);
          assert.equal((await recoveryQueue.recoverStale()).recovered, 1);
          recovered = await recoveryQueue.claim();
          assert.equal(recovered?.idempotencyKey, candidate.idempotencyKey);
          assert.equal(recovered.attemptCount, original.attempt_count + 1);
          assert.notEqual(recovered.claimToken, original.claim_token);
          assert.equal(signal.aborted, false, "validation must resume before local cancellation");
        } finally {
          release.resolve();
        }
        await waitUntil(
          "claim loss or a stale Driver call after validation",
          () => claimLost || activations.length > 0 || (beforePrepare && preparations.length > 0),
        );
        assert.deepEqual(preparations, beforePrepare ? [] : [candidate.id]);
        assert.deepEqual(activations, [], "the stale worker must never call the activation Driver");
        await fixture.stop();
        assert.equal((await fixture.work(candidate, "claimed")).claim_token, recovered.claimToken);
      },
    );
  }

  for (const boundary of [
    "binding",
    "preparation",
    "repository credential preparation",
    "repository credential preparation after binding",
    "activation before commit",
    "activation after commit",
  ] as const) {
    test(
      `a current claim refuses revoked policy authority before ${boundary}`,
      requiresPostgres,
      async (context) => {
        const repository = boundary.startsWith("repository credential")
          ? repositoryBoundary()
          : undefined;
        const withoutBinding = boundary === "repository credential preparation";
        const untouched = boundary === "binding" || withoutBinding;
        const fixture = await setup(context, {
          leaseDurationMs: 60_000,
          ...(repository ? { repoDriver: repository.driver } : {}),
        });
        const owner = await fixture.agent("policy-revocation-during-validation", {
          executionMode: repository ? "embedded" : "dedicated",
        });
        const { id: policyId, options } = await saveRepositoryPolicy(fixture, owner, []);
        const previous = await fixture.revision(owner, 1, options);
        await fixture.start({
          ...computeSupportingRepositoryPolicy(fixture.compute),
          maintenanceIntervalMs: 3_600_000,
        });
        await fixture.work(previous, "succeeded");
        await fixture.stop();
        const candidate = await fixture.revision(owner, 2, {
          ...options,
          ...(repository ? { repositoryCredentials: repository.snapshot } : {}),
        });
        const resume = Promise.withResolvers<void>();
        let blocked = false;
        const calls: string[] = [];
        const stoppedRevisions: string[] = [];
        let callsAtRefusal: string[] | undefined;
        let retirementWorkId: string | undefined;
        const afterCommit = boundary === "activation after commit";
        const expected = untouched
          ? []
          : repository || boundary === "preparation"
            ? ["bind"]
            : ["bind", "prepare"];
        const compute: ComputeDriver = {
          ...(repository
            ? repositoryCompute(fixture.compute, options.sandboxDriverId)
            : fixture.compute),
          maintenanceIntervalMs: 3_600_000,
          activationOrder: afterCommit ? "afterCommit" : "beforeCommit",
          validateProtectedRepositoryNetworkPolicy() {
            if (
              !blocked &&
              calls.length === expected.length &&
              (!repository || currentComputeAbortSignal() !== undefined)
            ) {
              blocked = true;
              return resume.promise;
            }
          },
          ...(withoutBinding
            ? {}
            : {
                async bindAgent() {
                  calls.push("bind");
                },
              }),
          async prepareRevision(revision, ctx) {
            calls.push("prepare");
            return fixture.compute.prepareRevision(revision, ctx);
          },
          async activateRevision() {
            calls.push("activate");
          },
          async stopRevision(revision) {
            await fixture.compute.stopRevision(revision);
            stoppedRevisions.push(revision.id);
          },
        };
        await fixture.start(compute, {
          emit: ({ event, workId, revisionId, outcome, code }) => {
            if (event !== "worker.completed" || revisionId !== candidate.id) {
              return;
            }
            if (
              workId === candidate.idempotencyKey &&
              outcome === "permanent" &&
              code === "AUTHORIZATION_DENIED"
            ) {
              callsAtRefusal = [...calls];
            }
            if (
              typeof workId === "string" &&
              outcome === "success" &&
              isRepositoryRuntimeRetirementWork({
                idempotencyKey: workId,
                agentId: owner.id,
                revisionId,
              })
            ) {
              retirementWorkId = workId;
            }
          },
        });
        try {
          await waitUntil(`validation before ${boundary}`, () => blocked);
          const first = await fixture.work(candidate, "claimed");
          assert.ok(first.claim_token);
          await fixture.observerPool.query(
            `INSERT INTO occ.iam_restrictions
               (id, namespace_id, action, resource_kind, resource_id, effect)
             VALUES ($1, $2, 'update', 'sandbox_policy', $3, 'deny')`,
            [`restriction-${randomUUID()}`, fixture.namespace.id, policyId],
          );
          assert.equal((await fixture.work(candidate, "claimed")).claim_token, first.claim_token);
          assert.deepEqual(calls, expected);
        } finally {
          resume.resolve();
        }
        const result = await settledRevision(fixture, candidate);
        assert.equal(result.reasonCode, "AUTHORIZATION_DENIED");
        // The denied deployment and its retirement are separate jobs. Retirement can bind
        // Compute before the test observes the deployment's terminal row.
        assert.deepEqual(
          await waitFor("candidate refusal completion", () => callsAtRefusal),
          expected,
        );
        if (repository) {
          const idempotencyKey = await waitFor(
            "candidate retirement completion",
            () => retirementWorkId,
          );
          await fixture.work({ id: candidate.id, idempotencyKey }, "succeeded");
          assert.deepEqual(stoppedRevisions, [candidate.id]);
          assert.deepEqual(repository.calls, []);
        }
        assert.equal(
          (await fixture.currentAgent(owner))?.activeRevisionId,
          afterCommit ? candidate.id : previous.id,
        );
        const queue = new PostgresWorkQueue(fixture.observerPool);
        const attempt = await queue.findWorkAttempt(candidate.idempotencyKey);
        const denied = await fixture.observerPool.query<{ authorization: unknown }>(
          `SELECT details->'__occAuditMetadata'->'authorization' AS authorization
           FROM occ.audit_events WHERE namespace_id = $1 AND kind = 'authorization_denial'`,
          [fixture.namespace.id],
        );
        assert.deepEqual(
          { untouched: attempt?.candidateNotStarted, authorizations: denied.rows },
          {
            untouched: untouched ? true : undefined,
            authorizations: [
              {
                authorization: {
                  principalId: fixture.actor.id,
                  action: "update",
                  resource: {
                    kind: "sandbox_policy",
                    id: policyId,
                    namespaceId: fixture.namespace.id,
                  },
                },
              },
            ],
          },
        );
        if (!afterCommit) {
          const key = (await fixture.advanceMaintenance(previous)).rows[0]?.idempotency_key;
          assert.ok(key);
          const repair = await settledRevision(fixture, { id: previous.id, idempotencyKey: key });
          assert.equal(
            repair.reasonCode,
            untouched ? "REVISION_ALREADY_ACTIVE" : "SUCCESSOR_EXECUTION_ADMISSION_UNAVAILABLE",
          );
        }
      },
    );
  }

  for (const boundary of ["Compute binding", "exclusive predecessor stop"] as const) {
    revisionTest(
      `an IAM change committed during the lock wait prevents ${boundary}`,
      async (fixture) => {
        const owner = await fixture.agent("repository-policy-iam-lock", {
          executionMode: "dedicated",
        });
        const { id: policyId, options } = await saveRepositoryPolicy(fixture, owner, []);
        const previous = await fixture.revision(owner, 1, options);
        const compute = computeSupportingRepositoryPolicy(fixture.compute);
        await fixture.start({ ...compute, maintenanceIntervalMs: 3_600_000 });
        await fixture.work(previous, "succeeded");
        await fixture.stop();
        const candidate = await fixture.revision(owner, 2, options);

        // The first advisory-lock statement can freeze a Repeatable Read snapshot
        // before the writer commits. Use the Worker's single connection to identify
        // that wait in PostgreSQL before making the revocation visible.
        const workerPool = fixture.createWorkerPool();
        await workerPool.query("SET default_transaction_isolation = 'repeatable read'");
        const {
          rows: [worker],
        } = await workerPool.query<{ pid: number; isolation: string }>(
          "SELECT pg_backend_pid() AS pid, current_setting('default_transaction_isolation') AS isolation",
        );
        assert.equal(worker?.isolation, "repeatable read");

        const paused = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        const exclusive = boundary === "exclusive predecessor stop";
        const effects: string[] = [];
        let validations = 0;
        const writer = await fixture.observerPool.connect();
        try {
          await fixture.start(
            {
              ...compute,
              maintenanceIntervalMs: 3_600_000,
              ...(exclusive
                ? { requiresStoppedPredecessors: () => true }
                : {
                    async bindAgent() {
                      effects.push("bind");
                    },
                  }),
              validateProtectedRepositoryNetworkPolicy() {
                // For exclusive placement, let initial validation finish and pause
                // at the validation just before preparation checks predecessors.
                validations += 1;
                if (validations === (exclusive ? 2 : 1)) {
                  paused.resolve();
                  return resume.promise;
                }
              },
              async prepareRevision(revision, ctx) {
                effects.push(`prepare:${revision.id}`);
                return compute.prepareRevision(revision, ctx);
              },
              async stopRevision(revision) {
                effects.push(`stop:${revision.id}`);
                await compute.stopRevision(revision);
              },
            },
            { pool: workerPool },
          );
          await within(paused.promise, `validation before ${boundary}`);
          await writer.query("BEGIN");
          const {
            rows: [blocker],
          } = await writer.query<{ pid: number }>(
            "SELECT pg_backend_pid() AS pid, pg_advisory_xact_lock(hashtextextended($1, 0))",
            ["occ:iam-configuration"],
          );
          assert.ok(blocker);
          resume.resolve();
          await waitUntil("Worker waits for the IAM configuration writer", async () => {
            const { rowCount } = await fixture.observerPool.query(
              `SELECT 1 FROM pg_locks
             WHERE pid = $1 AND locktype = 'advisory' AND NOT granted
               AND $2 = ANY(pg_blocking_pids(pid))`,
              [worker.pid, blocker.pid],
            );
            return rowCount === 1;
          });
          await writer.query(
            `INSERT INTO occ.iam_restrictions
             (id, namespace_id, action, resource_kind, resource_id, effect)
           VALUES ($1, $2, 'update', 'sandbox_policy', $3, 'deny')`,
            [`restriction-${randomUUID()}`, fixture.namespace.id, policyId],
          );
          await writer.query("COMMIT");
        } catch (error) {
          await writer.query("ROLLBACK");
          throw error;
        } finally {
          resume.resolve();
          writer.release();
        }

        const result = await settledRevision(fixture, candidate);
        const denied = await fixture.observerPool.query<{ authorization: unknown }>(
          `SELECT details->'__occAuditMetadata'->'authorization' AS authorization
         FROM occ.audit_events WHERE namespace_id = $1 AND kind = 'authorization_denial'`,
          [fixture.namespace.id],
        );
        assert.deepEqual(
          {
            state: result.state,
            reason: result.reasonCode,
            effects,
            active: (await fixture.currentAgent(owner))?.activeRevisionId,
            denials: denied.rows,
          },
          {
            state: "failed_permanent",
            reason: "AUTHORIZATION_DENIED",
            effects: [],
            active: previous.id,
            denials: [
              {
                authorization: {
                  principalId: fixture.actor.id,
                  action: "update",
                  resource: {
                    kind: "sandbox_policy",
                    id: policyId,
                    namespaceId: fixture.namespace.id,
                  },
                },
              },
            ],
          },
        );
      },
    );
  }

  for (const { action, kind, grants } of [
    {
      action: "read",
      kind: "sandbox_policy",
      grants: [{ repository: "example/project", access: "read" }],
    },
    {
      action: "update",
      kind: "sandbox_policy",
      grants: [{ repository: "example/project", access: "write" }],
    },
    { action: "manage_policy", kind: "agent", grants: [] },
  ] as const) {
    revisionTest(
      `queued repository policy refuses revoked ${kind} ${action} before Compute`,
      async (fixture) => {
        const owner = await fixture.agent(`repository-policy-${action}`, {
          executionMode: "dedicated",
        });
        const { id: policyId, options } = await saveRepositoryPolicy(fixture, owner, grants);
        const previous = await fixture.revision(owner, 1, options);
        const supportingCompute = computeSupportingRepositoryPolicy(fixture.compute);
        await fixture.start(supportingCompute);
        await fixture.work(previous, "succeeded");
        await fixture.stop();

        const candidate = await fixture.revision(owner, 2, options);
        const { owner: control, candidate: ordinary } = await fixture.admitInitialRevision(
          "ordinary-after-policy-revocation",
        );
        const controlPolicy = await fixture.state.read((view) =>
          view.sandboxPolicies.find(fixture.namespace.id, control.id),
        );
        assert.ok(controlPolicy);
        const resourceId = kind === "agent" ? owner.id : policyId;
        const controlResourceId = kind === "agent" ? control.id : controlPolicy.id;

        // Revoke the same exact permission on both Agents after admission. Only the
        // queued revision that will deploy an explicit policy needs that permission.
        await fixture.observerPool.query(
          `INSERT INTO occ.iam_restrictions
           (id, namespace_id, action, resource_kind, resource_id, effect)
           VALUES ($1, $2, $3, $4, $5, 'deny'), ($6, $2, $3, $4, $7, 'deny')`,
          [
            `restriction-${randomUUID()}`,
            fixture.namespace.id,
            action,
            kind,
            resourceId,
            `restriction-${randomUUID()}`,
            controlResourceId,
          ],
        );
        const checked: string[] = [];
        const prepared: string[] = [];
        let backendSecretReads = 0;
        fixture.secretDriver.setResolveOverride(() => {
          backendSecretReads++;
          throw new Error("Worker cannot read backend Secrets.");
        });
        await fixture.start({
          ...supportingCompute,
          validateProtectedRepositoryNetworkPolicy(revision) {
            assert.ok("id" in revision && typeof revision.id === "string");
            checked.push(revision.id);
          },
          async prepareRevision(revision, context) {
            prepared.push(revision.id);
            return supportingCompute.prepareRevision(revision, context);
          },
        });
        await fixture.work(ordinary, "succeeded");
        const terminal = await settledRevision(fixture, candidate);
        assert.deepEqual(
          {
            state: terminal.state,
            reason: terminal.reasonCode,
            candidateWasPrepared: prepared.includes(candidate.id),
            keptPredecessor: (await fixture.currentAgent(owner))?.activeRevisionId === previous.id,
          },
          {
            state: "failed_permanent",
            reason: "AUTHORIZATION_DENIED",
            candidateWasPrepared: false,
            keptPredecessor: true,
          },
        );
        assert.deepEqual(checked, []);
        assert.deepEqual(prepared, [ordinary.id]);
        assert.equal(backendSecretReads, 0);
        assert.equal((await fixture.currentAgent(control))?.activeRevisionId, ordinary.id);

        // Audit the denied authorization itself, not merely the enclosing deploy action.
        const denied = await fixture.observerPool.query<{ authorization: unknown }>(
          `SELECT details->'__occAuditMetadata'->'authorization' AS authorization
           FROM occ.audit_events WHERE namespace_id = $1 AND kind = 'authorization_denial'`,
          [fixture.namespace.id],
        );
        assert.deepEqual(denied.rows, [
          {
            authorization: {
              principalId: fixture.actor.id,
              action,
              resource: { kind, id: resourceId, namespaceId: fixture.namespace.id },
            },
          },
        ]);
      },
    );
  }
  revisionTest(
    "one worker reconciles embedded OpenClaw and dedicated Codex but rejects unapproved pinned Harnesses",
    async (fixture) => {
      const embedded = await fixture.agent("embedded-openclaw");
      const dedicated = await fixture.agent("dedicated-codex", { executionMode: "dedicated" });
      const unsupported = await fixture.agent("unapproved-harness", { executionMode: "dedicated" });
      const mismatched = await fixture.agent("mismatched-placement");
      const embeddedRevision = await fixture.revision(embedded, 1);
      const dedicatedRevision = await fixture.revision(dedicated, 1);
      const unsupportedRevision = await fixture.revision(unsupported, 1, {
        harness: {
          id: "codex",
          version: "unapproved",
          mode: "dedicated",
        },
      });
      const mismatchedRevision = await fixture.revision(mismatched, 1, {
        harness: {
          ...fixture.productionHarness,
          mode: "embedded",
        },
      });

      await fixture.start(fixture.compute);
      await Promise.all([
        fixture.work(embeddedRevision, "succeeded"),
        fixture.work(dedicatedRevision, "succeeded"),
        fixture.work(unsupportedRevision, "failed_permanent"),
        fixture.work(mismatchedRevision, "failed_permanent"),
      ]);

      const active = await fixture.observerPool.query<{
        id: string;
        active_revision_id: string | null;
      }>(
        "SELECT id, active_revision_id FROM occ.agents WHERE namespace_id = $1 AND id = ANY($2::text[])",
        [fixture.namespace.id, [embedded.id, dedicated.id, unsupported.id, mismatched.id]],
      );
      const activeByAgent = new Map(
        active.rows.map(({ id, active_revision_id }) => [id, active_revision_id]),
      );
      assert.equal(activeByAgent.get(embedded.id), embeddedRevision.id);
      assert.equal(activeByAgent.get(dedicated.id), dedicatedRevision.id);
      assert.equal(activeByAgent.get(unsupported.id), null);
      assert.equal(activeByAgent.get(mismatched.id), null);
      // The deployment status provides recovery guidance for the rejected Harness (finding 828).
      assert.deepEqual((await fixture.deploymentStatus(unsupported, unsupportedRevision)).error, {
        code: "HARNESS_DESCRIPTOR_MISMATCH",
        message:
          "This revision's Harness or Harness version is no longer approved, for example after a controller upgrade. Deploy again to admit a revision with the approved version.",
      });
    },
  );

  for (const secretAuthMethod of ["api_key", "codex_pat"] as const) {
    test(
      `${secretAuthMethod} revision dispatch rechecks Configuration and exact harness Secret grants without backend Secret reads`,
      requiresPostgres,
      async (context) => {
        const fixture = await setup(context, { secretAuthMethod });
        const executionMode = secretAuthMethod === "codex_pat" ? "dedicated" : "embedded";
        const [allowed, configurationDenied, actorSecretDenied, agentSecretUngranted] =
          await Promise.all([
            fixture.agent("allowed", { executionMode }),
            fixture.agent("configuration-denied", { executionMode }),
            fixture.agent("actor-secret-denied", { executionMode }),
            fixture.agent("agent-secret-ungranted", { executionMode, grantHarnessSecret: false }),
          ]);
        const [
          allowedRevision,
          configurationDeniedRevision,
          actorSecretDeniedRevision,
          agentSecretUngrantedRevision,
        ] = await Promise.all([
          fixture.revision(allowed, 1),
          fixture.revision(configurationDenied, 1),
          fixture.revision(actorSecretDenied, 1),
          fixture.revision(agentSecretUngranted, 1),
        ]);
        const actorDeniedSecret = harnessSecretId(actorSecretDenied);
        const ungrantedSecret = harnessSecretId(agentSecretUngranted);
        // Revoke actor permissions after admission and independently exercise an
        // Agent lacking its own grant; actor authority never authorizes that Agent.
        await fixture.observerPool.query(
          `INSERT INTO occ.iam_restrictions
           (id, namespace_id, action, resource_kind, resource_id, effect)
         VALUES ($1, $2, 'read', 'configuration', $3, 'deny'),
                ($4, $2, 'operate', 'secret', $5, 'deny')`,
          [
            `restriction-${randomUUID()}`,
            fixture.namespace.id,
            configurationDenied.configurationId,
            `restriction-${randomUUID()}`,
            actorDeniedSecret,
          ],
        );
        const prepared: { id: AgentRevision["id"]; operationContext: DispatchContext }[] = [];
        // Production workers have no Secret API permission. Dispatch must project
        // authoritative OCC metadata without asking the backend owner to read values.
        fixture.secretDriver.setResolveOverride(() => {
          throw new Error("Worker cannot read backend Secrets.");
        });
        await fixture.start({
          ...fixture.compute,
          async prepareRevision(revision, operationContext) {
            prepared.push({ id: revision.id, operationContext });
            return fixture.compute.prepareRevision(revision);
          },
        });
        await Promise.all([
          fixture.work(allowedRevision, "succeeded"),
          fixture.work(configurationDeniedRevision, "failed_permanent"),
          fixture.work(actorSecretDeniedRevision, "failed_permanent"),
          fixture.work(agentSecretUngrantedRevision, "failed_permanent"),
        ]);
        const { harnessAuth } = allowedRevision;
        assert.ok(isSecretHarnessAuth(harnessAuth), "the admitted Harness uses a Secret");
        const source = await fixture.state.read((view) =>
          view.secrets.findSecret(fixture.namespace.id, harnessAuth.source.id),
        );
        assert.ok(source, "the admitted Secret is still stored");
        assert.deepEqual(
          prepared,
          [
            {
              id: allowedRevision.id,
              operationContext: {
                secretEnvironment: [],
                harnessAuth: { ...harnessAuth, backendRef: source.backendRef },
              },
            },
          ],
          "only the independently authorized binding reaches Compute, outside gateway environment projections",
        );
        const denied = await fixture.observerPool.query<{ authorization: unknown }>(
          `SELECT details->'__occAuditMetadata'->'authorization' AS authorization
         FROM occ.audit_events WHERE namespace_id = $1 AND kind = 'authorization_denial'`,
          [fixture.namespace.id],
        );
        const deniedResources = denied.rows
          .map(({ authorization }) => {
            const decision = asRecord(authorization);
            const resource = asRecord(decision?.resource);
            assert.ok(typeof decision?.principalId === "string", "denial has a principal");
            assert.ok(
              typeof resource?.kind === "string" && typeof resource.id === "string",
              "denial has an exact resource",
            );
            return `${decision.principalId}:${resource.kind}:${resource.id}`;
          })
          .sort();
        assert.deepEqual(
          deniedResources,
          [
            `${fixture.actor.id}:configuration:${configurationDenied.configurationId}`,
            `${fixture.actor.id}:secret:${actorDeniedSecret}`,
            `${agentSecretUngranted.servicePrincipalId}:secret:${ungrantedSecret}`,
          ].sort(),
        );
      },
    );
  }

  revisionTest(
    "revision dispatch refuses a different selected Secret Driver before binding or activating the Agent",
    async (fixture) => {
      const { owner, candidate } = await fixture.admitInitialRevision("changed-secret-owner");
      // Installation composition changed after admission. The revision remains
      // pinned to its admitted Secret Driver and cannot use the replacement.
      const effects: ComputeEffect[] = [];
      await fixture.start(observeComputeEffects(fixture.compute, effects), {
        transformDrivers: (drivers) => ({
          ...drivers,
          installation: {
            ...drivers.installation,
            drivers: {
              ...drivers.installation.drivers,
              secret: { ...drivers.installation.drivers.secret, id: "secret-replacement" },
            },
          },
          secretDriver: { ...drivers.secretDriver, id: "secret-replacement" },
        }),
      });
      await fixture.work(candidate, "failed_permanent");
      assert.deepEqual(effects, []);
      const current = await fixture.currentAgent(owner);
      assert.ok(current, "the Agent is still stored");
      assert.equal(current.activeRevisionId, undefined);
      const work = await fixture.observerPool.query<{ reason_code: string | null }>(
        "SELECT details->>'reasonCode' AS reason_code FROM occ.audit_events WHERE resource_id = $1 AND action = 'reconcile' AND outcome = 'failure'",
        [candidate.id],
      );
      const [failure] = work.rows;
      assert.ok(failure, "the failed reconciliation is audited");
      assert.equal(failure.reason_code, "SECRET_DRIVER_MISMATCH");
      // The deployment status provides recovery guidance without exposing Driver IDs (finding 828).
      assert.deepEqual((await fixture.deploymentStatus(owner, candidate)).error, {
        code: "SECRET_DRIVER_MISMATCH",
        message:
          "The Installation no longer selects the Secret Driver this revision was admitted with. Bind Secrets created through the selected Secret Driver, or remove the old Secret bindings, then deploy again.",
      });
    },
  );

  revisionTest(
    "revision dispatch refuses a different selected Compute Driver with a fixed status message",
    async (fixture) => {
      const { owner, candidate } = await fixture.admitInitialRevision("changed-compute-owner");
      // Installation composition changed after admission: the revision stays pinned to the
      // Compute Driver it was admitted with, so dispatch refuses it before any Compute effect.
      const effects: ComputeEffect[] = [];
      await fixture.start({
        ...observeComputeEffects(fixture.compute, effects),
        id: "compute-replacement",
      });
      await fixture.work(candidate, "failed_permanent");
      await fixture.stop();
      assert.deepEqual(effects, []);
      const current = await fixture.currentAgent(owner);
      assert.ok(current, "the Agent is still stored");
      assert.equal(current.activeRevisionId, undefined);
      assert.deepEqual((await fixture.deploymentStatus(owner, candidate)).error, {
        code: "COMPUTE_DRIVER_MISMATCH",
        message:
          "The Installation no longer selects the Compute Driver this revision was admitted with. Deploy again to admit a revision for the selected driver.",
      });
    },
  );

  registerRevisionSnapshotCase(revisionTest);
}
