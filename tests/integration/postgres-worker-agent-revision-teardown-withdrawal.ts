import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ComputeDriver } from "../../packages/contracts/src/index.ts";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import { advanceCleanupRetries, completion } from "../helpers/postgres-worker-revision-queue.ts";
import {
  removeAccessBindings,
  repositoryAttempts,
  repositoryBoundary,
} from "../helpers/postgres-worker-revision-support.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import {
  required,
  type RevisionSetup,
  readWorkerEvent,
  type WorkerEvent,
} from "./postgres-worker-agent-revision-teardown-fixture.ts";

type Withdrawal = NonNullable<ComputeDriver["retireExpiredRepositoryAccess"]>;
type WithdrawalObservation = Awaited<ReturnType<Withdrawal>> | "unconfirmed";

const deadlineCases = [
  ["withdrawn", "withdrawn"],
  ["pending then stop", "pending"],
  ["pending then superseded", "pending"],
  ["unconfirmed then withdrawn", "unconfirmed"],
  ["lost maintenance claim", "withdrawn"],
  ["retire-runtime", "retire-runtime"],
  ["unsupported", "withdrawn"],
] as const satisfies readonly (readonly [string, WithdrawalObservation])[];

export function testDeadlineWithdrawal(setup: RevisionSetup) {
  for (const [scenario, initialObservation] of deadlineCases) {
    test(
      `scheduled maintenance at the admitted Git deadline: ${scenario}`,
      requiresPostgres,
      async (t) => {
        const repository = repositoryBoundary();
        const fixture = await setup(t, { repoDriver: repository.driver });
        repository.snapshot.deadlineWallMs = Date.now() + 4_000;
        const { owner, candidate } = await fixture.admitInitialRevision("git-expiry", {
          revision: { repositoryCredentials: repository.snapshot },
        });
        const stopped: string[] = [];
        const events: WorkerEvent[] = [];
        let preparations = 0;
        let observations = 0;
        let result: WithdrawalObservation = initialObservation;
        const compute: ComputeDriver = {
          ...fixture.compute,
          async prepareRevision(revision, context) {
            if (revision.id === candidate.id) {
              preparations++;
            }
            return fixture.compute.prepareRevision(revision, context);
          },
          ...(scenario === "unsupported"
            ? {}
            : {
                async retireExpiredRepositoryAccess(revision, signal) {
                  assert.equal(revision.id, candidate.id);
                  signal.throwIfAborted();
                  observations++;
                  if (result === "unconfirmed") {
                    throw new Error("withdrawal reply lost");
                  }
                  return result;
                },
              }),
          async stopRevision(revision) {
            stopped.push(revision.id);
            return fixture.compute.stopRevision(revision);
          },
        };
        const start = () =>
          fixture.start(compute, { emit: (event) => events.push(readWorkerEvent(event)) });
        const completed = (label: string) =>
          completion(
            events,
            label,
            (event) =>
              event.event === "worker.completed" &&
              event.revisionId === candidate.id &&
              event.workId?.includes(":repository_cleanup:"),
          );
        await start();
        await fixture.work(candidate, "succeeded");
        await fixture.stop();
        const [original] = await repositoryAttempts(fixture, candidate);
        assert.ok(original, "expected original repository attempt");
        assert.equal(original.phase, "open");
        assert.equal(original.deadlineWallMs, repository.snapshot.deadlineWallMs);
        const remaining = original.deadlineWallMs - Date.now();
        assert.ok(remaining > 0, "activate with a live Git grant before its admitted deadline");
        await delay(remaining + 20);
        const {
          rowCount,
          rows: [maintenance],
        } = await fixture.advanceMaintenance(candidate);
        assert.equal(rowCount, 1, "use ordinary maintenance scheduled by activation");
        assert.ok(maintenance);
        if (scenario === "lost maintenance claim") {
          const queue = new fixture.PostgresWorkQueue(fixture.observerPool, { maxAttempts: 1 });
          const abandoned = required(await queue.claim(), "claimed work");
          assert.equal(abandoned.idempotencyKey, maintenance.idempotency_key);
          await fixture.expireClaim(abandoned, abandoned.claimToken);
          assert.equal((await queue.recoverStale()).failedPermanent, 1);
        }
        await start();
        const first = await completed("durable Git expiry outcome");
        const observed = await fixture.workResult({
          id: candidate.id,
          idempotencyKey: maintenance.idempotency_key,
        });
        assert.equal(
          required(observed.rows[0], "completed work result").reason_code,
          scenario === "lost maintenance claim"
            ? "LEASE_EXPIRED"
            : "REPOSITORY_CREDENTIAL_DEADLINE_EXCEEDED",
        );
        assert.equal(
          required((await fixture.workResult(candidate)).rows[0], "completed work result")
            .reason_code,
          "REVISION_ACTIVATED",
        );
        const checkNoNewGit = async () => {
          assert.deepEqual(
            (await repositoryAttempts(fixture, candidate)).map(({ phase, sessionId }) => [
              phase,
              sessionId,
            ]),
            [["disposed", original.sessionId]],
          );
          assert.equal(repository.calls.filter((call) => call.operation === "open").length, 1);
          assert.equal(preparations, 1);
        };
        await checkNoNewGit();
        if (scenario === "retire-runtime" || scenario === "unsupported") {
          assert.equal(first.code, "REPOSITORY_RUNTIME_RETIREMENT_QUEUED");
          await waitFor("confirmed retirement clears only this active revision", async () =>
            required(await fixture.currentAgent(owner), "fixture Agent").activeRevisionId ===
            undefined
              ? true
              : undefined,
          );
          assert.deepEqual(stopped, [candidate.id]);
          assert.equal(observations, scenario === "unsupported" ? 0 : 1);
          return;
        }
        assert.equal(
          stopped.length,
          0,
          "the Git deadline alone must not stop the serving revision",
        );
        if (scenario.startsWith("pending") || scenario.startsWith("unconfirmed")) {
          assert.equal(first.code, "REPOSITORY_CLEANUP_PENDING");
          assert.equal(
            required(await fixture.currentAgent(owner), "fixture Agent").activeRevisionId,
            candidate.id,
          );
          await fixture.stop();
          events.length = 0;
          await start();
          await advanceCleanupRetries(fixture, candidate);
          assert.equal((await completed("cold worker still owes withdrawal")).code, first.code);
          assert.equal(stopped.length, 0);
          if (scenario === "pending then stop") {
            const stop = await fixture.requestStop(owner);
            await fixture.work(stop, "succeeded");
            const agent = required(await fixture.currentAgent(owner), "fixture Agent");
            assert.equal(agent.activeRevisionId, undefined);
            assert.equal(agent.desiredRuntimeState, "stopped");
            assert.ok(stopped.includes(candidate.id));
            return;
          }
          if (scenario === "pending then superseded") {
            const newer = await fixture.revision(owner, 2);
            await fixture.work(newer, "succeeded");
            const previous = observations;
            events.length = 0;
            await advanceCleanupRetries(fixture, candidate);
            assert.equal(
              (await completed("superseded expiry transfers to retirement")).code,
              "REPOSITORY_RUNTIME_RETIREMENT_QUEUED",
            );
            assert.equal(observations, previous, "cannot preserve a superseded revision");
            assert.equal(
              required(await fixture.currentAgent(owner), "fixture Agent").activeRevisionId,
              newer.id,
            );
            assert.ok(stopped.every((id) => id === candidate.id));
            return;
          }
          result = "withdrawn";
          events.length = 0;
          await advanceCleanupRetries(fixture, candidate);
          assert.equal(
            (await completed("withdrawal confirmation")).code,
            "REPOSITORY_ACCESS_WITHDRAWN",
          );
        } else {
          assert.equal(first.code, "REPOSITORY_ACCESS_WITHDRAWN");
        }
        assert.equal(
          required(await fixture.currentAgent(owner), "fixture Agent").activeRevisionId,
          candidate.id,
        );
        await fixture.stop();
        const previous = observations;
        const {
          rowCount: count,
          rows: [next],
        } = await fixture.advanceMaintenance(candidate);
        assert.equal(count, 1, "continue normal maintenance after confirmed Git withdrawal");
        assert.ok(next);
        await start();
        const work = { id: candidate.id, idempotencyKey: next.idempotency_key };
        await fixture.work(work, "succeeded");
        assert.equal(
          required((await fixture.workResult(work)).rows[0], "completed work result").reason_code,
          "REPOSITORY_ACCESS_WITHDRAWN",
        );
        assert.ok(observations > previous, "cold maintenance verifies the reduced runtime");
        await checkNoNewGit();
        assert.equal(stopped.length, 0);
        const agent = required(await fixture.currentAgent(owner), "fixture Agent");
        assert.equal(agent.activeRevisionId, candidate.id);
        assert.equal(agent.desiredRuntimeState, "running");

        // Offboard the requester after Git withdrawal. IAM now denies this exact revision.
        const removed = await removeAccessBindings(fixture, fixture.actor.id);
        assert.ok((removed.rowCount ?? 0) > 0, "remove the requester's actual access bindings");
        await fixture.advanceMaintenance(candidate);
        await waitFor("runtime authority loss retires exact revision", async () =>
          required(await fixture.currentAgent(owner), "fixture Agent").activeRevisionId ===
          undefined
            ? true
            : undefined,
        );
        assert.deepEqual(stopped, [candidate.id]);
        await checkNoNewGit();
      },
    );
  }
}
