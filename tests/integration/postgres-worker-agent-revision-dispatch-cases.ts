import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import {
  admitRepositoryNetworkPolicy,
  assertExecutionAdmission,
  isSecretHarnessAuth,
  type Agent,
  type AgentRevision,
  type ComputeDriver,
  type RepositoryNetworkGrant,
  type SandboxPolicySnapshot,
} from "../../packages/contracts/src/index.ts";
import { PostgresWorkQueue, type OpenClawController } from "../../packages/occ/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import type {
  RevisionFixture,
  WorkIdentity,
} from "../helpers/postgres-worker-refused-candidate.ts";
import { repositoryBoundary } from "../helpers/postgres-worker-revision-support.mjs";
import type { createTestSecretDriver } from "../helpers/secret-driver.ts";
import { waitFor } from "../helpers/wait-for.ts";

interface DispatchFixture {
  admitInitialRevision: RevisionFixture["admitInitialRevision"];
  advanceMaintenance: RevisionFixture["advanceMaintenance"];
  agent: RevisionFixture["agent"];
  revision: RevisionFixture["revision"];
  actor: RevisionFixture["actor"];
  compute: RevisionFixture["compute"];
  currentAgent: RevisionFixture["currentAgent"];
  expireClaim: RevisionFixture["expireClaim"];
  installation: RevisionFixture["installation"];
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

export function registerRevisionDispatchCases({ revisionTest, setup }: DispatchFixtures): void {
  revisionTest(
    "a restarted worker refuses a historical deny-all policy without preparing the revision",
    async (fixture) => {
      const owner = await fixture.agent("repository-policy-worker-restart", {
        executionMode: "dedicated",
      });
      const { options } = await saveRepositoryPolicy(fixture, owner, []);
      // Older Workers could apply a repository policy to this unprotected revision.
      // It must never be treated as ordinary execution after the policy path is retired.
      const candidate = await fixture.revision(owner, 1, options);
      assert.equal(candidate.executionAdmission.mode, "unprotected");
      const { owner: control, candidate: ordinary } = await fixture.admitInitialRevision(
        "no-explicit-repository-policy",
      );
      const prepared: string[] = [];
      await fixture.start({
        ...fixture.compute,
        async prepareRevision(revision, context) {
          prepared.push(revision.id);
          return fixture.compute.prepareRevision(revision, context);
        },
      });
      await fixture.work(ordinary, "succeeded");
      const terminal = await settledRevision(fixture, candidate);
      assert.equal(terminal.state, "failed_permanent");
      assert.equal(terminal.reasonCode, "REPOSITORY_POLICY_PLACEMENT_UNSUPPORTED");
      assert.deepEqual((await fixture.deploymentStatus(owner, candidate)).error, {
        code: "REPOSITORY_POLICY_PLACEMENT_UNSUPPORTED",
        message:
          "The selected execution placement cannot enforce this version's repository network policy. Ask an Installation administrator for a placement that supports the policy, then deploy again.",
      });
      assert.deepEqual(prepared, [ordinary.id]);
      assert.equal((await fixture.currentAgent(owner))?.activeRevisionId, undefined);
      assert.equal((await fixture.currentAgent(control))?.activeRevisionId, ordinary.id);
    },
  );
  revisionTest(
    "a persisted protected execution revision is refused before Compute",
    async (fixture) => {
      const { owner, candidate: ordinary } = await fixture.admitInitialRevision(
        "retired-protected-execution",
        { agent: { executionMode: "dedicated" } },
      );
      const { id: namespaceId } = fixture.namespace;
      const id = `rev_${randomUUID()}`;
      const idempotencyKey = `agent_revision:${id}:reconcile`;
      const driver = {
        id: "openshell",
        implementation: "openshell",
        configurationId: "a".repeat(64),
      };
      // A selected legacy Proxy could admit a v3 plan with no credential routes.
      // Persist that historical shape with the normal store and the exact Agent and actor.
      const protectedRevision = await fixture.state.transactWithQueue(async (unit, queue) => {
        await unit.namespaces.lockNamespace(namespaceId);
        await unit.agents.lockAgent(namespaceId, owner.id);
        const previous = await unit.revisions.findRevision(namespaceId, owner.id, ordinary.id);
        assert.ok(previous);
        const admission: AgentRevision = {
          ...previous,
          id,
          revision: 2,
          sandboxDriverId: driver.id,
          executionAdmission: { version: 3, mode: "protected" },
          egressPlan: {
            id: randomUUID(),
            generation: 1,
            driver,
            execution: {
              installationId: fixture.installation.id,
              namespaceId,
              agentId: owner.id,
              revisionId: id,
              servicePrincipalId: owner.servicePrincipalId,
              executionId: randomUUID(),
            },
            sandboxDriverId: driver.id,
            egressDriverId: driver.id,
            routes: [],
          },
        };
        const revision = await unit.revisions.createRevision(admission);
        await queue.enqueue({
          idempotencyKey,
          namespaceId,
          agentId: owner.id,
          revisionId: id,
          actorId: fixture.actor.id,
          availableAt: new Date(0),
        });
        return revision;
      });
      assertExecutionAdmission(protectedRevision);
      assert.equal(protectedRevision.executionAdmission.mode, "protected");

      const validated: string[] = [];
      const prepared: string[] = [];
      await fixture.start({
        ...fixture.compute,
        validateExecutionAdmission(revision) {
          validated.push(revision.executionAdmission.mode);
        },
        async prepareRevision(revision, context) {
          prepared.push(revision.id);
          return fixture.compute.prepareRevision(revision, context);
        },
      });
      await fixture.work(ordinary, "succeeded");
      const result = await settledRevision(fixture, { id, idempotencyKey });
      assert.equal(result.state, "failed_permanent");
      assert.equal(result.reasonCode, "EXECUTION_ADMISSION_UNAVAILABLE");
      assert.ok(validated.length > 0);
      assert.ok(validated.every((mode) => mode === "unprotected"));
      assert.deepEqual(prepared, [ordinary.id]);
      assert.equal((await fixture.currentAgent(owner))?.activeRevisionId, ordinary.id);
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
        ...fixture.compute,
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
          ...fixture.compute,
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
    "ordinary exclusive replacement still transfers Repository retirement during predecessor maintenance",
    requiresPostgres,
    async (context) => {
      const repository = repositoryBoundary();
      const fixture = await setup(context, { repoDriver: repository.driver });
      const owner = await fixture.agent("ordinary-repository-replacement");
      const previous = await fixture.revision(owner, 1, {
        repositoryCredentials: repository.snapshot,
      });
      const compute = {
        ...repositoryCompute(fixture.compute, undefined),
        requiresStoppedPredecessors: () => true,
        maintenanceIntervalMs: 3_600_000,
      };
      await fixture.start(compute);
      await fixture.work(previous, "succeeded");
      await fixture.stop();

      const candidate = await fixture.revision(owner, 2);
      const later = await fixture.revision(owner, 3);
      await fixture.observerPool.query(
        "UPDATE occ.controller_work SET available_at = clock_timestamp() + interval '1 hour' WHERE idempotency_key = ANY($1::text[])",
        [[candidate.idempotencyKey, later.idempotencyKey]],
      );
      const key = (await fixture.advanceMaintenance(previous)).rows[0]?.idempotency_key;
      assert.ok(key);
      await fixture.start(compute);
      const result = await settledRevision(fixture, { id: previous.id, idempotencyKey: key });
      assert.equal(result.reasonCode, "REVISION_SUPERSEDED");
      const cleanup = await fixture.observerPool.query(
        "SELECT idempotency_key FROM occ.controller_work WHERE revision_id = $1 AND idempotency_key LIKE $2",
        [previous.id, `agent_revision:${previous.id}:repository_cleanup:retire:%`],
      );
      assert.equal(cleanup.rowCount, 1);
      const supersession = await fixture.observerPool.query(
        `SELECT details->>'activeRevisionId' AS successor FROM occ.audit_events
         WHERE resource_id = $1 AND action = 'openclaw.agents.lifecycle.supersede'`,
        [previous.id],
      );
      assert.deepEqual(supersession.rows, [{ successor: candidate.id }]);
    },
  );

  for (const state of ["queued", "missing work", "mismatched work", "stopping"] as const) {
    test(
      `Repository predecessor maintenance keeps its runtime with a historical scoped successor (${state})`,
      requiresPostgres,
      async (context) => {
        const repository = repositoryBoundary();
        const fixture = await setup(context, { repoDriver: repository.driver });
        const owner = await fixture.agent("repository-policy-maintenance");
        const previous = await fixture.revision(owner, 1, {
          repositoryCredentials: repository.snapshot,
        });
        const prepared: string[] = [];
        const stopped: string[] = [];
        const retired: string[] = [];
        const compute: ComputeDriver = {
          ...repositoryCompute(fixture.compute, undefined),
          requiresStoppedPredecessors: () => true,
          maintenanceIntervalMs: 3_600_000,
          async prepareRevision(revision, deploymentContext) {
            prepared.push(revision.id);
            return fixture.compute.prepareRevision(revision, deploymentContext);
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
        await fixture.start(compute);
        await fixture.work(previous, "succeeded");
        await fixture.stop();

        const { options } = await saveRepositoryPolicy(fixture, owner, []);
        const namespaceId = fixture.namespace.id;
        const candidate =
          state === "missing work" || state === "mismatched work"
            ? await fixture.state.transactWithQueue(async (unit, queue) => {
                // The production stores admit a revision and queue item separately. Simulate
                // a persisted mismatch without mutating immutable rows or bypassing the Worker.
                await unit.namespaces.lockNamespace(namespaceId);
                await unit.agents.lockAgent(namespaceId, owner.id);
                const current = await unit.revisions.findRevision(
                  namespaceId,
                  owner.id,
                  previous.id,
                );
                assert.ok(current);
                const { repositoryCredentials, ...admission } = current;
                assert.ok(repositoryCredentials);
                const revision = await unit.revisions.createRevision({
                  ...admission,
                  ...options,
                  id: `rev_${randomUUID()}`,
                  revision: 2,
                });
                const idempotencyKey = `agent_revision:${revision.id}:reconcile`;
                if (state === "mismatched work") {
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
        if (state === "stopping") {
          // A former Worker crossed the predecessor stop boundary. Merely refusing
          // its successor cannot prove that nothing happened to the predecessor.
          await fixture.state.transact(async (unit) => {
            await unit.namespaces.lockNamespace(namespaceId);
            await unit.agents.lockAgent(namespaceId, owner.id);
            await unit.agents.recordPredecessorReplacement(namespaceId, owner.id, {
              predecessorRevisionId: previous.id,
              candidateRevisionId: candidate.id,
              phase: "stopping",
            });
          });
        }
        await fixture.observerPool.query(
          "UPDATE occ.controller_work SET available_at = clock_timestamp() + interval '1 hour' WHERE idempotency_key = $1",
          [candidate.idempotencyKey],
        );
        const closedBeforeMaintenance = repository.calls.filter(
          ({ operation }) => operation === "close",
        ).length;
        const key = (await fixture.advanceMaintenance(previous)).rows[0]?.idempotency_key;
        assert.ok(key);
        await fixture.start(compute);
        const result = await settledRevision(fixture, { id: previous.id, idempotencyKey: key });
        assert.equal(result.reasonCode, "SUCCESSOR_EXECUTION_ADMISSION_UNAVAILABLE");
        assert.equal((await fixture.currentAgent(owner))?.activeRevisionId, previous.id);
        assert.deepEqual(prepared, [previous.id]);
        assert.deepEqual(stopped, []);
        assert.deepEqual(retired, []);
        assert.equal(
          repository.calls.filter(({ operation }) => operation === "close").length,
          closedBeforeMaintenance,
        );
        const cleanup = await fixture.observerPool.query(
          "SELECT idempotency_key FROM occ.controller_work WHERE revision_id = $1 AND idempotency_key LIKE $2",
          [previous.id, `agent_revision:${previous.id}:repository_cleanup:retire:%`],
        );
        assert.equal(cleanup.rowCount, 0);
      },
    );
  }

  for (const state of ["held", "recovering", "ordinary application failure"] as const) {
    test(
      state === "ordinary application failure"
        ? "a held ordinary successor still allows active predecessor maintenance"
        : `a historical scoped successor with a ${state} runtime fences predecessor maintenance`,
      requiresPostgres,
      async (context) => {
        const fixture = await setup(context, {});
        const owner = await fixture.agent("held-repository-policy-successor");
        const previous = await fixture.revision(owner, 1);
        const effects: string[] = [];
        const compute: ComputeDriver = {
          ...fixture.compute,
          maintenanceIntervalMs: 3_600_000,
          async prepareRevision(revision, deploymentContext) {
            effects.push(`prepare:${revision.id}`);
            return fixture.compute.prepareRevision(revision, deploymentContext);
          },
          async stopRevision(revision) {
            effects.push(`stop:${revision.id}`);
            await fixture.compute.stopRevision(revision);
          },
          async retireRevision(revision) {
            effects.push(`retire:${revision.id}`);
            await fixture.compute.retireRevision(revision);
          },
        };
        await fixture.start(compute);
        await fixture.work(previous, "succeeded");
        await fixture.stop();

        const options =
          state === "ordinary application failure"
            ? undefined
            : (await saveRepositoryPolicy(fixture, owner, [])).options;
        const candidate = await fixture.revision(owner, 2, options);
        const queue = new PostgresWorkQueue(fixture.observerPool);
        const claim = await queue.claim();
        assert.equal(claim?.idempotencyKey, candidate.idempotencyKey);
        assert.ok(claim);
        // Record the outcome a former Worker would have left after entering Compute.
        // The current Worker must account for it even though it cannot release this mode.
        if (state !== "recovering") {
          await queue.fail(claim, { code: "RUNTIME_MODEL_PROBE_FAILED" });
        } else {
          await queue.defer(claim, { code: "REVISION_INCOMPLETE" });
          const parked = await fixture.observerPool.query(
            "UPDATE occ.controller_work SET available_at = clock_timestamp() + interval '1 hour' WHERE idempotency_key = $1 AND state = 'queued'",
            [candidate.idempotencyKey],
          );
          assert.equal(parked.rowCount, 1);
        }

        const key = (await fixture.advanceMaintenance(previous)).rows[0]?.idempotency_key;
        assert.ok(key);
        await fixture.start(compute);
        const result = await settledRevision(fixture, { id: previous.id, idempotencyKey: key });
        const mayRepair = state === "ordinary application failure";
        assert.equal(
          result.reasonCode,
          mayRepair ? "REVISION_ALREADY_ACTIVE" : "SUCCESSOR_EXECUTION_ADMISSION_UNAVAILABLE",
        );
        assert.equal((await fixture.currentAgent(owner))?.activeRevisionId, previous.id);
        assert.deepEqual(
          effects,
          Array.from({ length: mayRepair ? 2 : 1 }, () => `prepare:${previous.id}`),
        );

        const stop = await fixture.requestStop(owner);
        await fixture.work(stop, "succeeded");
        assert.equal((await fixture.currentAgent(owner))?.activeRevisionId, undefined);
        assert.ok(effects.includes(`stop:${previous.id}`));
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
        const candidate = await fixture.revision(owner, 1, options);
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
        const prepared: string[] = [];
        let backendSecretReads = 0;
        fixture.secretDriver.setResolveOverride(() => {
          backendSecretReads++;
          throw new Error("Worker cannot read backend Secrets.");
        });
        await fixture.start({
          ...fixture.compute,
          async prepareRevision(revision, context) {
            prepared.push(revision.id);
            return fixture.compute.prepareRevision(revision, context);
          },
        });
        await fixture.work(ordinary, "succeeded");
        const terminal = await settledRevision(fixture, candidate);
        assert.deepEqual(
          {
            state: terminal.state,
            reason: terminal.reasonCode,
            candidateWasPrepared: prepared.includes(candidate.id),
            candidateWasPublished:
              (await fixture.currentAgent(owner))?.activeRevisionId === candidate.id,
          },
          {
            state: "failed_permanent",
            reason: "AUTHORIZATION_DENIED",
            candidateWasPrepared: false,
            candidateWasPublished: false,
          },
        );
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
}
