import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import type { Pool } from "pg";
import { createOccLogger, createWorkerLogEmitter } from "../../apps/controller/src/logging.ts";
import type { ControllerWorkerOptions } from "../../apps/controller/src/worker.ts";
import type {
  Agent,
  ComputeDriver,
  RuntimeFailureEvidence,
  SandboxDriver,
} from "../../packages/contracts/src/index.ts";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { PostgresWorkQueue } from "../../packages/occ/src/state/postgres-work-queue.ts";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import {
  requiresPostgres,
  setup as setupSingletonWorker,
} from "../helpers/compute-singleton-worker.mjs";
import { waitFor } from "../helpers/wait-for.mjs";

interface SeededRevision {
  readonly id: string;
  readonly idempotencyKey: string;
}

interface MaintenanceFixture {
  readonly observerPool: Pool;
  readonly namespace: { readonly id: string };
  readonly actor: { readonly id: string };
  readonly compute: ComputeDriver;
  agent(): Promise<Readonly<Agent>>;
  revision(owner: Readonly<Agent>, number: number): Promise<SeededRevision>;
  activeRevision(owner: Readonly<Agent>): Promise<string | null>;
  work(candidate: SeededRevision): Promise<unknown>;
  start(
    compute: ComputeDriver,
    leaseDurationMs?: number,
    convergenceTimeoutMs?: number,
    mode?: ControllerWorkerOptions["mode"],
    emit?: ControllerWorkerOptions["emit"],
  ): Promise<void>;
  stop(): Promise<void>;
}

interface RevisionEffect {
  readonly revisionId: string;
  readonly activeRevisionId: string | null;
}

async function setup(
  context: TestContext,
  sandboxDriver?: SandboxDriver,
): Promise<MaintenanceFixture> {
  const fixture = await setupSingletonWorker(context, { sandboxDriver });
  // The JavaScript fixture infers a zero-argument default emitter. The Worker supplies the event.
  return { ...fixture, start: fixture.start as MaintenanceFixture["start"] };
}

function maintenanceSandbox(maintenanceIntervalMs: number): SandboxDriver {
  return {
    id: "maintenance-sandbox",
    implementation: "fixture",
    capability: "sandbox",
    facets: ["process"],
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    maintenanceIntervalMs,
    async cleanup() {},
  };
}

async function waitForMaintenanceSuccessor(
  fixture: MaintenanceFixture,
  revision: { readonly id: string },
  expectedMs: number,
  previous = "",
) {
  return waitFor("one successor for the active revision", async () => {
    const work = await fixture.observerPool.query<{
      idempotency_key: string;
      available_at: Date;
      created_at: Date;
      state: string;
      is_future: boolean;
    }>(
      `SELECT idempotency_key, available_at, created_at, state,
              available_at > clock_timestamp() AS is_future
       FROM occ.controller_work
       WHERE namespace_id = $1 AND revision_id = $2 AND idempotency_key LIKE $3
         AND ($4 = '' OR created_at > (
           SELECT created_at FROM occ.controller_work WHERE idempotency_key = $4
         ))
       ORDER BY created_at`,
      [fixture.namespace.id, revision.id, `agent_revision:${revision.id}:maintenance:%`, previous],
    );
    const [next] = work.rows;
    if (next !== undefined) {
      assertMaintenanceDelay(next, expectedMs);
      assert.equal(next.state, "queued");
      assert.equal(next.is_future, true, "the database must see the successor as ineligible");
    }
    assert.ok(work.rows.length <= 1, "a pass must produce exactly one successor");
    return next;
  });
}

function assertMaintenanceDelay(
  work: { available_at: Date; created_at: Date },
  expectedMs: number,
): void {
  const delayMs = work.available_at.getTime() - work.created_at.getTime();
  assert.ok(
    Math.abs(delayMs - expectedMs) < 2_000,
    `expected ${expectedMs} ms, scheduled ${delayMs} ms`,
  );
}

export function registerComputeSingletonMaintenanceCases(): void {
  test(
    "an opted-in active runtime continuously repairs under its original authorized actor",
    requiresPostgres,
    async (context) => {
      const fixture = await setup(context);
      const owner = await fixture.agent();
      const candidate = await fixture.revision(owner, 1);
      const maintenancePrefix = `agent_revision:${candidate.id}:maintenance:`;
      const preparations: RevisionEffect[] = [];
      const activations: RevisionEffect[] = [];

      await fixture.start({
        ...fixture.compute,
        activationOrder: "beforeCommit",
        maintenanceIntervalMs: 75,
        async preflight() {},
        async prepareRevision(revision) {
          preparations.push({
            revisionId: revision.id,
            activeRevisionId: await fixture.activeRevision(owner),
          });
          return fixture.compute.prepareRevision(revision);
        },
        async activateRevision(revision) {
          activations.push({
            revisionId: revision.id,
            activeRevisionId: await fixture.activeRevision(owner),
          });
        },
      });
      await fixture.work(candidate);

      const maintained = await waitFor("a durable authorized maintenance pass", async () => {
        const work = await fixture.observerPool.query<{
          actor_id: string;
          namespace_id: string;
          agent_id: string;
          revision_id: string;
          state: string;
        }>(
          `SELECT actor_id, namespace_id, agent_id, revision_id, state
           FROM occ.controller_work
           WHERE namespace_id = $1 AND revision_id = $2
             AND idempotency_key LIKE $3 AND state = 'succeeded'
           ORDER BY completed_at DESC
           LIMIT 1`,
          [fixture.namespace.id, candidate.id, `${maintenancePrefix}%`],
        );
        return work.rows[0];
      });
      await fixture.stop();

      assert.deepEqual(maintained, {
        actor_id: fixture.actor.id,
        namespace_id: fixture.namespace.id,
        agent_id: owner.id,
        revision_id: candidate.id,
        state: "succeeded",
      });
      assert.equal(await fixture.activeRevision(owner), candidate.id);
      assert.deepEqual(preparations.slice(0, 2), [
        { revisionId: candidate.id, activeRevisionId: null },
        { revisionId: candidate.id, activeRevisionId: candidate.id },
      ]);
      assert.deepEqual(activations.slice(0, 2), [
        { revisionId: candidate.id, activeRevisionId: null },
        { revisionId: candidate.id, activeRevisionId: candidate.id },
      ]);

      await fixture.observerPool.query(
        `UPDATE occ.controller_work
         SET state = 'succeeded',
             completed_at = clock_timestamp(),
             reason_code = 'REVISION_MAINTENANCE_SUPERSEDED',
             updated_at = clock_timestamp()
         WHERE namespace_id = $1 AND state = 'queued'
           AND idempotency_key LIKE $2`,
        [fixture.namespace.id, `${maintenancePrefix}%`],
      );
    },
  );

  test(
    "a Sandbox schedules active maintenance without granting that pass permission to create a Harness",
    requiresPostgres,
    async (context) => {
      const fixture = await setup(context, maintenanceSandbox(75));
      const owner = await fixture.agent();
      const candidate = await fixture.revision(owner, 1);
      const observations: {
        revisionId: string;
        active: string | null;
        existingOnly: true | undefined;
      }[] = [];
      await fixture.start({
        ...fixture.compute,
        activationOrder: "beforeCommit",
        async preflight() {},
        async activateRevision() {},
        async prepareRevision(revision, dispatch) {
          observations.push({
            revisionId: revision.id,
            active: await fixture.activeRevision(owner),
            existingOnly: dispatch?.existingHarnessOnly,
          });
          return fixture.compute.prepareRevision(revision);
        },
      });
      await fixture.work(candidate);
      await waitFor(
        "the worker to revisit the active revision",
        () => observations.length >= 2 || undefined,
      );
      await fixture.stop();
      assert.deepEqual(observations.slice(0, 2), [
        { revisionId: candidate.id, active: null, existingOnly: undefined },
        { revisionId: candidate.id, active: candidate.id, existingOnly: true },
      ]);
    },
  );

  for (const initialInterval of [60_000, 30_000]) {
    test(
      `Sandbox maintenance keeps a durable cadence across restart from ${initialInterval} to 60000 ms`,
      requiresPostgres,
      async (context) => {
        const fixture = await setup(context, maintenanceSandbox(initialInterval));
        const owner = await fixture.agent();
        const revision = await fixture.revision(owner, 1);
        const compute: ComputeDriver = {
          ...fixture.compute,
          activationOrder: "beforeCommit",
          async preflight() {},
          async activateRevision() {},
        };
        const wallNow = Date.now.bind(Date);
        let clockOffsetMs = 0;
        context.mock.method(Date, "now", () => wallNow() + clockOffsetMs);

        await fixture.start(compute);
        await fixture.work(revision);
        const first = await waitForMaintenanceSuccessor(fixture, revision, initialInterval);
        await fixture.stop();

        // The replacement processes share the real queue and contend for each existing row.
        // Only the due time is advanced by the test so the real worker claims the original key.
        const replacement = await setup(context, maintenanceSandbox(60_000));
        const contender = await setup(context, maintenanceSandbox(60_000));
        await replacement.start(compute);
        await contender.start(compute);
        let previous = first;
        // Keep both replacements more than a full interval behind PostgreSQL.
        // The final pass also checks that a fast worker cannot extend the cadence.
        for (const offsetMs of [-120_000, -130_000, 120_000]) {
          clockOffsetMs = offsetMs;
          const madeDue = await fixture.observerPool.query(
            "UPDATE occ.controller_work SET available_at = clock_timestamp() WHERE idempotency_key = $1 AND state = 'queued'",
            [previous.idempotency_key],
          );
          assert.equal(madeDue.rowCount, 1);
          const next = await waitForMaintenanceSuccessor(
            fixture,
            revision,
            60_000,
            previous.idempotency_key,
          );
          assert.ok(
            Number(next.idempotency_key.split(":").at(-1)) >
              Number(previous.idempotency_key.split(":").at(-1)),
            "every pass needs a new increasing durable key",
          );
          const completed = await fixture.observerPool.query<{
            state: string;
            attempt_count: number;
          }>("SELECT state, attempt_count FROM occ.controller_work WHERE idempotency_key = $1", [
            previous.idempotency_key,
          ]);
          assert.deepEqual(completed.rows, [{ state: "succeeded", attempt_count: 1 }]);
          previous = next;
        }
        await replacement.stop();
        await contender.stop();
        assert.equal(await fixture.activeRevision(owner), revision.id);
      },
    );
  }

  test(
    "standing repository withdrawal schedules the retained runtime at its Sandbox cadence",
    requiresPostgres,
    async (context) => {
      const fixture = await setup(context, maintenanceSandbox(5_000));
      const owner = await fixture.agent();
      const original = await fixture.revision(owner, 1);
      const state = new PostgresPlatformState(fixture.observerPool);
      const queue = new PostgresWorkQueue(fixture.observerPool);

      // Represent a live revision whose standing approval has been removed. Persist its
      // immutable snapshot and transfer its claimed upkeep through the real cleanup adapter.
      const revisionId = `rev_${randomUUID()}`;
      const idempotencyKey = `agent_revision:${revisionId}:maintenance:1`;
      const reconcileKey = `agent_revision:${revisionId}:reconcile`;
      await state.transactWithQueue(async (unit, work) => {
        const seed = await unit.revisions.findRevision(fixture.namespace.id, owner.id, original.id);
        assert.ok(seed);
        await unit.revisions.createRevision({
          ...seed,
          id: revisionId,
          revision: 2,
          repositoryCredentials: {
            driver: { id: "repository-fixture", implementation: "fixture" },
            standingApprovalId: randomUUID(),
            standingApprovalGeneration: 1,
            standingApprovalScopeFingerprint: "a".repeat(64),
            deadlineWallMs: Date.now() - 1_000,
            bindings: [
              {
                repositoryRef: "repo-fixture",
                profile: "git-write",
                backendId: "repository-backend-fixture",
                grant: { providerInstanceId: "host", repositoryId: "repo", grantId: "grant" },
              },
            ],
          },
        });
        const active = await unit.agents.compareAndSetActiveRevision(
          fixture.namespace.id,
          owner.id,
          undefined,
          revisionId,
        );
        assert.equal(active?.activeRevisionId, revisionId);
        await work.enqueue({
          idempotencyKey: reconcileKey,
          namespaceId: fixture.namespace.id,
          agentId: owner.id,
          revisionId,
          actorId: fixture.actor.id,
          availableAt: new Date(0),
        });
        await work.enqueue({
          idempotencyKey,
          namespaceId: fixture.namespace.id,
          agentId: owner.id,
          revisionId,
          actorId: fixture.actor.id,
          availableAt: new Date(1),
        });
      });
      const originalClaim = await queue.claim();
      assert.equal(originalClaim?.idempotencyKey, original.idempotencyKey);
      assert.ok(originalClaim);
      await queue.complete(originalClaim, { code: "REVISION_SUPERSEDED" });
      const activeReconcile = await queue.claim();
      assert.equal(activeReconcile?.idempotencyKey, reconcileKey);
      assert.ok(activeReconcile);
      await queue.complete(activeReconcile, {});
      const interrupted = await queue.claim();
      assert.equal(interrupted?.idempotencyKey, idempotencyKey);
      assert.ok(interrupted);
      const cleanup = await state.transactWithQueue(async (_unit, work) => {
        const queued = await work.enqueueRepositoryCleanup(
          interrupted,
          { namespaceId: fixture.namespace.id, agentId: owner.id, revisionId },
          "standing-withdrawal",
        );
        await work.complete(interrupted, { code: "REPOSITORY_STANDING_APPROVAL_REMOVED" });
        return queued;
      });
      assert.ok(cleanup);

      let observations = 0;
      await fixture.start({
        ...fixture.compute,
        activationOrder: "beforeCommit",
        maintenanceIntervalMs: 60_000,
        async preflight() {},
        async prepareRevision() {
          assert.fail("withdrawal must not prepare the retained revision");
        },
        async activateRevision() {
          assert.fail("withdrawal must not reactivate the retained revision");
        },
        async stopRevision() {
          assert.fail("successful withdrawal must retain the runtime");
        },
        async retireExpiredRepositoryAccess(revision) {
          assert.equal(revision.id, revisionId);
          observations++;
          return "withdrawn";
        },
      });
      const completed = await waitFor(
        "withdrawal to finish without retiring the runtime",
        async () => {
          const item = await queue.findWork(cleanup.idempotencyKey);
          return item?.state === "succeeded" ? item : undefined;
        },
      );
      assert.equal(completed.reasonCode, "REPOSITORY_ACCESS_WITHDRAWN");
      assert.equal(observations, 1);
      const next = await waitForMaintenanceSuccessor(
        fixture,
        { id: revisionId },
        5_000,
        idempotencyKey,
      );
      // Leave the due time untouched so PostgreSQL admits the next supervision pass.
      const successor = await waitForMaintenanceSuccessor(
        fixture,
        { id: revisionId },
        5_000,
        next.idempotency_key,
      );
      await fixture.stop();
      const supervised = await queue.findWork(next.idempotency_key);
      assert.equal(supervised?.state, "succeeded");
      assert.equal(supervised?.reasonCode, "REPOSITORY_ACCESS_WITHDRAWN");
      assert.equal(supervised?.attemptCount, 1);
      assert.notEqual(successor.idempotency_key, next.idempotency_key);
      assert.equal(observations, 2);
      assert.equal(await fixture.activeRevision(owner), revisionId);
    },
  );

  for (const failure of ["observation", "binding"] as const) {
    test(
      `active maintenance recovers from ${failure} failures beyond its retry budget and stops when its actor is denied`,
      requiresPostgres,
      async (context) => {
        const fixture = await setup(context);
        const owner = await fixture.agent();
        const candidate = await fixture.revision(owner, 1);
        const maintenancePrefix = `agent_revision:${candidate.id}:maintenance:`;
        let available = false;
        let maintenanceAttempts = 0;
        let bindingAttempts = 0;
        let holdRecoveredPass = false;
        let recoveredPassHeld = false;
        const resumeRecoveredPass = Promise.withResolvers<void>();
        const evidence: RuntimeFailureEvidence = {
          component: "agent",
          check: "repository-git-route",
          checkedAt: new Date().toISOString(),
          code: "REPOSITORY_ROUTE_BLOCKED",
        };
        // Controlled Compute observations exercise Worker logging. Valid unknown codes stay
        // private. Malformed and absent evidence still produce the ordinary pending completion.
        const runtimeFailures: readonly (RuntimeFailureEvidence | undefined)[] = [
          evidence,
          { ...evidence, code: "PRIVATE_RUNTIME_SENTINEL" },
          { ...evidence, code: "invalid runtime identifier" },
          undefined,
          {
            ...evidence,
            check: "model-probe",
            code: "MODEL_PROBE_FAILED",
            cause: { kind: "PROBE_STATUS", detail: "billing" },
          },
        ];
        const events: Readonly<Record<string, unknown>>[] = [];
        const lines: string[] = [];
        const emit = createWorkerLogEmitter(
          createOccLogger({
            component: "occ-worker",
            destination: { write: (line) => lines.push(line) },
          }),
        );

        await fixture.start(
          {
            ...fixture.compute,
            activationOrder: "beforeCommit",
            maintenanceIntervalMs: 75,
            async preflight() {},
            async bindAgent(binding) {
              if (
                binding.namespace.id === fixture.namespace.id &&
                binding.agent.id === owner.id &&
                (await fixture.activeRevision(owner)) === candidate.id
              ) {
                bindingAttempts += 1;
                if (failure === "binding" && !available) {
                  throw new Error("Binding lookup unavailable");
                }
              }
            },
            async prepareRevision(revision) {
              const observation = await fixture.compute.prepareRevision(revision);
              if ((await fixture.activeRevision(owner)) === revision.id) {
                maintenanceAttempts += 1;
                if (!available) {
                  const runtimeFailure =
                    runtimeFailures[(maintenanceAttempts - 1) % runtimeFailures.length];
                  return runtimeFailure === undefined
                    ? { ...observation, ready: false }
                    : { ...observation, ready: false, runtimeFailure };
                }
                if (holdRecoveredPass) {
                  holdRecoveredPass = false;
                  recoveredPassHeld = true;
                  await resumeRecoveredPass.promise;
                }
              }
              return observation;
            },
            async activateRevision() {},
          },
          30_000,
          40,
          "production",
          (event) => {
            events.push(event);
            emit(event);
          },
        );
        await fixture.work(candidate);

        // Six failed passes exceed the worker's ordinary five-attempt budget.
        // Active maintenance must survive both binding and observation outages;
        // neither the queue nor the worker recovery logic is replaced by the fixture.
        await waitFor("multiple failed but rescheduled maintenance passes", async () => {
          const result = await fixture.observerPool.query<{ failures: number }>(
            `SELECT COUNT(*)::integer AS failures
           FROM occ.controller_work
           WHERE namespace_id = $1 AND revision_id = $2
             AND idempotency_key LIKE $3 AND state = 'failed_permanent'`,
            [fixture.namespace.id, candidate.id, `${maintenancePrefix}%`],
          );
          const row = result.rows[0];
          assert.ok(row, "maintenance failure count must return one row");
          return row.failures >= 6 ? row : undefined;
        });
        if (failure === "binding") {
          assert.equal(maintenanceAttempts, 0);
        } else {
          const isMaintenance = (record: unknown): record is Readonly<Record<string, unknown>> =>
            typeof record === "object" &&
            record !== null &&
            "event" in record &&
            record.event === "worker.completed" &&
            "workId" in record &&
            typeof record.workId === "string" &&
            record.workId.startsWith(maintenancePrefix);
          const expected = [
            "REPOSITORY_ROUTE_BLOCKED",
            "UNRECOGNIZED",
            undefined,
            undefined,
            "MODEL_PROBE_FAILED",
          ];
          // Both the producer and the serialized operational log retain only the code.
          // The real worker still closes each observation as pending and reschedules it.
          const logRecords = lines.map((line): unknown => JSON.parse(line));
          for (const records of [events, logRecords]) {
            const completions = records.filter(isMaintenance).slice(0, runtimeFailures.length);
            assert.equal(completions.length, runtimeFailures.length);
            assert.deepEqual(
              completions.map((event) => event.failure),
              expected,
            );
            assert.ok(
              completions.every(
                (event) => event.outcome === "pending" && event.code === "REVISION_INCOMPLETE",
              ),
            );
            for (const completion of completions) {
              assert.notEqual(completion.component, evidence.component);
              for (const field of ["runtimeFailure", "check", "checkedAt", "cause"]) {
                assert.equal(Object.hasOwn(completion, field), false);
              }
            }
          }
          assert.doesNotMatch(
            lines.join(""),
            /PRIVATE_RUNTIME_SENTINEL|invalid runtime identifier|billing/,
          );
        }
        assert.equal(await fixture.activeRevision(owner), candidate.id);
        available = true;

        await waitFor("active runtime recovery after a prolonged provider outage", async () => {
          const result = await fixture.observerPool.query<{ actor_id: string; state: string }>(
            `SELECT actor_id, state
           FROM occ.controller_work
           WHERE namespace_id = $1 AND revision_id = $2
             AND idempotency_key LIKE $3 AND state = 'succeeded'
           ORDER BY completed_at DESC LIMIT 1`,
            [fixture.namespace.id, candidate.id, `${maintenancePrefix}%`],
          );
          return result.rows[0];
        });
        assert.equal(await fixture.activeRevision(owner), candidate.id);

        // Account for the already-authorized pass before revoking deploy. Other
        // Agents may still have maintenance in the shared fixture database.
        try {
          holdRecoveredPass = true;
          await waitFor("a recovered target pass to reach Compute", () =>
            recoveredPassHeld ? true : undefined,
          );
          await fixture.observerPool.query(
            `INSERT INTO occ.iam_restrictions
             (id, namespace_id, action, resource_kind, resource_id, effect)
           VALUES ($1, $2, 'deploy', 'agent', $3, 'deny')`,
            [`restriction-${randomUUID()}`, fixture.namespace.id, owner.id],
          );
          const effectsBeforeDenial = maintenanceAttempts;
          const bindingsBeforeDenial = bindingAttempts;
          resumeRecoveredPass.resolve();
          await waitFor("the denied maintenance pass to stop without a successor", async () => {
            const result = await fixture.observerPool.query<{ pending: number; denied: number }>(
              `SELECT COUNT(*) FILTER (WHERE state IN ('queued', 'claimed'))::integer AS pending,
                      COUNT(*) FILTER (WHERE state = 'failed_permanent'
                        AND reason_code = 'AUTHORIZATION_DENIED' AND actor_id = $4)::integer AS denied
               FROM occ.controller_work
               WHERE namespace_id = $1 AND revision_id = $2 AND idempotency_key LIKE $3`,
              [fixture.namespace.id, candidate.id, `${maintenancePrefix}%`, fixture.actor.id],
            );
            const row = result.rows[0];
            assert.ok(row, "maintenance denial counts must return one row");
            return row.pending === 0 && row.denied > 0 ? row : undefined;
          });
          assert.equal(maintenanceAttempts, effectsBeforeDenial);
          assert.equal(bindingAttempts, bindingsBeforeDenial);
        } finally {
          resumeRecoveredPass.resolve();
        }
      },
    );
  }
}
