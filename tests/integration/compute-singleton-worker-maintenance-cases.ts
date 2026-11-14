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
} from "../../packages/contracts/src/index.ts";
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

async function setup(context: TestContext): Promise<MaintenanceFixture> {
  const fixture = await setupSingletonWorker(context);
  // The JavaScript fixture infers a zero-argument default emitter. The Worker supplies the event.
  return { ...fixture, start: fixture.start as MaintenanceFixture["start"] };
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
