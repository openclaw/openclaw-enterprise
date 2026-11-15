import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  InMemoryPlatformState,
  PostgresPlatformState,
  type PlatformStateStore,
  type RepositorySessionRepository,
} from "../../packages/occ/src/index.ts";
import {
  seedSessionRevision,
  sessionAttempt,
} from "../conformance/repository-sessions.contract.mjs";
import { databaseUrl, requiresPostgres, testPool } from "../helpers/postgres-database.mjs";

type AttemptInput = Parameters<RepositorySessionRepository["createAttempt"]>[0];
type FenceInput = Parameters<RepositorySessionRepository["fenceBrokerReceipt"]>[0];

export function registerBrokerReceiptFencingCase(): void {
  test(
    "only the reserving broker generation fences its own reservation",
    { ...requiresPostgres, timeout: 30_000 },
    async (t) => {
      const pool = testPool(t, { connectionString: databaseUrl, max: 2 });
      const postgres = new PostgresPlatformState(pool);
      // Memory enforces the same transition boundary that PostgreSQL enforces in its trigger.
      const stores: readonly [name: string, state: PlatformStateStore, fenceRefusal: RegExp][] = [
        ["memory", new InMemoryPlatformState(), /The broker receipt transition is invalid/],
        ["postgres", postgres, /The resource violates its exact platform ownership or state/],
      ];
      for (const [name, state, fenceRefusal] of stores) {
        await t.test(name, async () => {
          const generation = randomUUID();
          // Each reservation needs its own revision because an opening attempt owns its binding.
          const reserve = async (phase?: "open" | "closing") => {
            const { revision } = await seedSessionRevision(state);
            const attempt: AttemptInput = sessionAttempt(revision, { brokerProtocol: 1 });
            const { admissionId, deadlineWallMs } = attempt;
            await state.transact(async (unit) => {
              await unit.repositorySessions.createAttempt(attempt);
              await unit.repositorySessions.createBrokerReceipt({
                admissionId,
                state: "reserved",
                generation,
              });
              if (phase !== undefined) {
                const advanced = await unit.repositorySessions.advanceAttempt({
                  admissionId,
                  expectedPhase: "opening",
                  phase,
                  ...(phase === "open" ? { sessionId: `session-${randomUUID()}` } : {}),
                  updatedAt: revision.createdAt,
                });
                assert.equal(advanced?.phase, phase);
              }
            });
            return { admissionId, deadlineWallMs };
          };
          const fence = (admissionId: FenceInput["admissionId"], by = generation) =>
            state.transact((unit) =>
              unit.repositorySessions.fenceBrokerReceipt({ admissionId, generation: by }),
            );

          const reserved = await reserve();
          assert.equal(
            await fence(reserved.admissionId, randomUUID()),
            undefined,
            "a foreign generation must leave the reservation untouched",
          );
          assert.deepEqual(await fence(reserved.admissionId), {
            admissionId: reserved.admissionId,
            state: "fenced",
            generation,
          });
          // Fencing is terminal even if the reserving generation tries to bind later.
          assert.equal(await fence(reserved.admissionId), undefined);
          assert.equal(
            await state.transact((unit) =>
              unit.repositorySessions.advanceBrokerReceipt({
                admissionId: reserved.admissionId,
                expectedState: "reserved",
                generation,
                state: "active",
                sessionId: `session-${randomUUID()}`,
                deadlineWallMs: reserved.deadlineWallMs,
              }),
            ),
            undefined,
          );

          // A worker that has recorded a session keeps the reservation unfenced.
          const opened = await reserve("open");
          await assert.rejects(fence(opened.admissionId), {
            name: "ScopeViolationError",
            message: fenceRefusal,
          });
          const receipt = await state.read((view) =>
            view.repositorySessions.findBrokerReceipt(opened.admissionId),
          );
          assert.equal(receipt?.state, "reserved");

          // A closing attempt without a known session may still be fenced.
          const closing = await reserve("closing");
          assert.equal((await fence(closing.admissionId))?.state, "fenced");
        });
      }

      // The database independently rejects direct insertion of a generation-owned fence.
      const { revision } = await seedSessionRevision(postgres);
      const attempt: AttemptInput = sessionAttempt(revision, { brokerProtocol: 1 });
      await postgres.transact((unit) => unit.repositorySessions.createAttempt(attempt));
      await assert.rejects(
        pool.query(
          "INSERT INTO occ.repository_broker_receipts (admission_id,state,generation) VALUES ($1,'fenced',$2)",
          [attempt.admissionId, randomUUID()],
        ),
        { code: "23514" },
      );
    },
  );
}
