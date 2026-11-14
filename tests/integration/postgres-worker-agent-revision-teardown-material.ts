import assert from "node:assert/strict";
import test from "node:test";
import type {
  RepositoryCredentialRuntimeBinding,
  ComputeDriver,
} from "../../packages/contracts/src/index.ts";
import type { ControllerWorkState } from "../../packages/occ/src/controller-work.ts";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import {
  repositoryAttempts,
  repositoryBoundary,
} from "../helpers/postgres-worker-revision-support.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import { required, type RevisionSetup } from "./postgres-worker-agent-revision-teardown-fixture.ts";

export function testMaterialRepair(setup: RevisionSetup) {
  for (const loss of ["missing", "closed-repair"]) {
    test(
      loss === "missing"
        ? "repository missing refuses replacement after exposure and retains refusal across worker restart"
        : "repository closed-repair waits across worker restart and replaces material only after disposal",
      requiresPostgres,
      async (context) => {
        const repository = repositoryBoundary();
        const fixture = await setup(context, {
          repoDriver: repository.driver,
          leaseDurationMs: 600,
        });
        const { owner, candidate } = await fixture.admitInitialRevision(`repository-${loss}`, {
          revision: { repositoryCredentials: repository.snapshot },
        });
        const delivered: RepositoryCredentialRuntimeBinding[] = [];
        const stopped: string[] = [];
        let missingMaterial = false;
        const compute: ComputeDriver = {
          ...fixture.compute,
          async prepareRevision(revision, deploymentContext) {
            assert.ok(deploymentContext?.repositoryCredentials);
            delivered.push(...deploymentContext.repositoryCredentials);
            const observation = await fixture.compute.prepareRevision(revision, deploymentContext);
            return missingMaterial
              ? {
                  ...observation,
                  ready: false,
                  repositoryCredentialMaterialMissing: [
                    {
                      repositoryRef: required(delivered[0], "original material").repositoryRef,
                      sessionId: required(delivered[0], "original material").sessionId,
                    },
                  ],
                }
              : observation;
          },
          async stopRevision(revision) {
            stopped.push(revision.id);
            return fixture.compute.stopRevision(revision);
          },
        };
        await fixture.start(compute);
        await fixture.work(candidate, "succeeded");
        await fixture.stop();
        const [original] = await repositoryAttempts(fixture, candidate);
        assert.ok(original, "expected original repository attempt");
        const status = await repository.driver.status(
          required(original.sessionId, "original session ID"),
        );
        const close = repository.driver.close;
        // These are Driver protocol observations. Real PostgreSQL and worker
        // admission must refuse replacement without inferring provider settlement.
        if (loss === "missing") {
          repository.driver.status = async () => undefined;
          repository.driver.close = async () => undefined;
        } else {
          assert.ok(status, "expected the original session status");
          missingMaterial = true;
          repository.driver.close = async () => ({ ...status, state: "CLOSED" });
        }
        const maintenance = await fixture.advanceMaintenance(candidate);
        assert.equal(maintenance.rowCount, 1);
        const maintenanceRow = required(maintenance.rows[0], "scheduled maintenance");
        await fixture.start(compute, { pool: fixture.createWorkerPool() });
        if (loss === "closed-repair") {
          await waitFor("known closing session to retain cleanup ownership", async () => {
            const [attempt] = await repositoryAttempts(fixture, candidate);
            return attempt?.phase === "closing" ? attempt : undefined;
          });
          await fixture.work(
            { id: candidate.id, idempotencyKey: maintenanceRow.idempotency_key },
            "failed_permanent",
          );
          await fixture.stop();
          const [pending] = await repositoryAttempts(fixture, candidate);
          assert.ok(pending, "expected pending repository attempt");
          assert.equal(pending.sessionId, original.sessionId);
          assert.equal(pending.liveRevisionId, candidate.id);
          assert.deepEqual(pending.cleanupContext, original.cleanupContext);
          assert.equal(repository.calls.filter(({ operation }) => operation === "open").length, 1);
          assert.equal(delivered.filter(({ kind }) => kind === "new").length, 1);

          // A restarted worker must still wait; CLOSED has not settled the
          // original session's provider obligations or authorized new material.
          const queued = await fixture.advanceMaintenance(candidate);
          assert.equal(queued.rowCount, 1);
          const queuedRow = required(queued.rows[0], "queued maintenance");
          const retry = { id: candidate.id, idempotencyKey: queuedRow.idempotency_key };
          await fixture.start(compute, { pool: fixture.createWorkerPool() });
          await fixture.work(retry, "failed_permanent");
          await fixture.stop();
          const refusal = await fixture.observerPool.query<{ reason_code: string | null }>(
            "SELECT reason_code FROM occ.controller_work WHERE idempotency_key = $1",
            [retry.idempotencyKey],
          );
          assert.equal(
            required(refusal.rows[0], "completed work result").reason_code,
            "REVISION_FINALIZATION_INCOMPLETE",
          );
          assert.equal((await repositoryAttempts(fixture, candidate)).length, 1);
          assert.equal(repository.calls.filter(({ operation }) => operation === "open").length, 1);
          assert.equal(delivered.filter(({ kind }) => kind === "new").length, 1);
          assert.deepEqual(stopped, []);

          // Only confirmed disposal permits the existing bounded continuation
          // to obtain a fresh session under the original revision deadline.
          repository.driver.close = close;
          missingMaterial = false;
          const continuation = await fixture.advanceMaintenance(candidate);
          assert.ok((continuation.rowCount ?? 0) > 0);
          const continuationRow = required(continuation.rows[0], "continuation maintenance");
          await fixture.start(compute, { pool: fixture.createWorkerPool() });
          await fixture.work(
            { id: candidate.id, idempotencyKey: continuationRow.idempotency_key },
            "succeeded",
          );
          await fixture.stop();
          const attempts = await repositoryAttempts(fixture, candidate);
          assert.equal(
            attempts.find(({ sessionId }) => sessionId === original.sessionId)?.phase,
            "disposed",
          );
          const fresh = attempts.find(({ phase }) => phase === "open");
          assert.ok(fresh);
          assert.notEqual(fresh.sessionId, original.sessionId);
          assert.notEqual(fresh.admissionId, original.admissionId);
          assert.equal(fresh.deadlineWallMs, original.deadlineWallMs);
          assert.ok(fresh.durationSeconds <= original.durationSeconds);
          assert.equal(repository.calls.filter(({ operation }) => operation === "open").length, 2);
          assert.equal(delivered.filter(({ kind }) => kind === "new").length, 2);
          assert.deepEqual(stopped, []);
          return;
        }
        await fixture.work(
          { id: candidate.id, idempotencyKey: maintenanceRow.idempotency_key },
          "failed_permanent",
        );
        await waitFor("unsafe revision runtime to retire", async () =>
          stopped.includes(candidate.id) ? true : undefined,
        );
        await waitFor("invalidated cleanup to wait for Driver maintenance", async () => {
          const delayed = await fixture.observerPool.query<{ delay_ms: string }>(
            `SELECT EXTRACT(EPOCH FROM (available_at - updated_at)) * 1000 AS delay_ms
               FROM occ.controller_work
               WHERE revision_id = $1 AND state = 'queued' AND idempotency_key LIKE $2`,
            [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:retire:%`],
          );
          return Number(delayed.rows[0]?.delay_ms) >=
            repository.driver.maintenanceIntervalMs - 1_000
            ? true
            : undefined;
        });
        await fixture.stop();
        const refusal = await fixture.observerPool.query<{ reason_code: string | null }>(
          "SELECT reason_code FROM occ.controller_work WHERE idempotency_key = $1",
          [maintenanceRow.idempotency_key],
        );
        assert.equal(
          required(refusal.rows[0], "completed work result").reason_code,
          "REPOSITORY_SESSION_RECOVERY_UNSAFE",
        );
        // The runtime stopped even though the session's disposal is still unconfirmed.
        // Report no active revision; keep the requested run state and deployment history.
        const agent = required(await fixture.currentAgent(owner), "fixture Agent");
        assert.equal(agent.activeRevisionId, undefined);
        assert.equal(agent.desiredRuntimeState, "running");
        assert.equal(
          required((await fixture.workResult(candidate)).rows[0], "completed work result")
            .reason_code,
          "REVISION_ACTIVATED",
        );
        const [retained] = await repositoryAttempts(fixture, candidate);
        assert.ok(retained, "expected retained repository attempt");
        assert.equal(retained.phase, "invalidated");
        assert.equal(retained.sessionId, original.sessionId);
        assert.equal(retained.liveRevisionId, candidate.id);
        assert.deepEqual(retained.cleanupContext, original.cleanupContext);
        const cleanup = await fixture.observerPool.query<{
          state: ControllerWorkState;
          actor_id: string;
        }>(
          `SELECT state, actor_id FROM occ.controller_work
           WHERE revision_id = $1 AND idempotency_key LIKE $2`,
          [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:retire:%`],
        );
        assert.equal(cleanup.rowCount, 1);
        const cleanupRow = required(cleanup.rows[0], "cleanup work");
        assert.equal(cleanupRow.state, "queued");
        assert.equal(cleanupRow.actor_id, fixture.actor.id);

        // Previously admitted maintenance observations must keep refusing the
        // lost session without multiplying the durable retirement obligation.
        await fixture.start(compute, { pool: fixture.createWorkerPool() });
        for (let index = 0; index < 4; index += 1) {
          const another = {
            id: candidate.id,
            idempotencyKey: `agent_revision:${candidate.id}:maintenance:${Math.floor(Date.now() / repository.driver.maintenanceIntervalMs) + 2 + index}`,
          };
          await fixture.state.transactWithQueue((_unit, queue) =>
            queue.enqueue({
              idempotencyKey: another.idempotencyKey,
              namespaceId: candidate.namespaceId,
              agentId: candidate.agentId,
              revisionId: candidate.id,
              actorId: fixture.actor.id,
              availableAt: new Date(0),
            }),
          );
          await fixture.work(another, "failed_permanent");
        }
        await fixture.stop();
        const repeatedCleanup = await fixture.observerPool.query<{
          state: ControllerWorkState;
          actor_id: string;
        }>(
          `SELECT state, actor_id FROM occ.controller_work
           WHERE revision_id = $1 AND idempotency_key LIKE $2`,
          [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:retire:%`],
        );
        assert.equal(repeatedCleanup.rowCount, 1);
        const repeatedCleanupRow = required(repeatedCleanup.rows[0], "repeated cleanup work");
        assert.equal(repeatedCleanupRow.state, "queued");
        assert.equal(repeatedCleanupRow.actor_id, fixture.actor.id);
        assert.equal((await repositoryAttempts(fixture, candidate)).length, 1);
        assert.equal(repository.calls.filter(({ operation }) => operation === "open").length, 1);
        assert.equal(delivered.filter(({ kind }) => kind === "new").length, 1);
        assert.ok(stopped.every((id) => id === candidate.id));

        // A separately admitted revision is a new user request. It must not erase
        // the old unresolved evidence or inherit the old session's authority.
        missingMaterial = false;
        const replacement = await fixture.revision(owner, 2, {
          repositoryCredentials: repository.snapshot,
        });
        await fixture.start(compute, { pool: fixture.createWorkerPool() });
        await fixture.work(replacement, "succeeded");
        await fixture.stop();
        const [fresh] = await repositoryAttempts(fixture, replacement);
        assert.ok(fresh, "expected the replacement session");
        assert.equal(fresh.phase, "open");
        assert.notEqual(fresh.sessionId, original.sessionId);
        assert.notEqual(fresh.admissionId, original.admissionId);
        assert.equal(
          required((await repositoryAttempts(fixture, candidate))[0], "original repository attempt")
            .phase,
          retained.phase,
        );
        assert.equal(repository.calls.filter(({ operation }) => operation === "open").length, 2);
      },
    );
  }

  test(
    "worker restart resumes repository maintenance and repairs only Compute's exact missing subset once",
    requiresPostgres,
    async (context) => {
      const repository = repositoryBoundary({ count: 2 });
      const fixture = await setup(context, { repoDriver: repository.driver });
      const { owner, candidate } = await fixture.admitInitialRevision(
        "repository-maintenance-restart",
        {
          revision: { repositoryCredentials: repository.snapshot },
        },
      );
      const initial: RepositoryCredentialRuntimeBinding[] = [];
      await fixture.start({
        ...fixture.compute,
        async prepareRevision(revision, deploymentContext) {
          assert.ok(deploymentContext?.repositoryCredentials);
          initial.push(...deploymentContext.repositoryCredentials);
          return fixture.compute.prepareRevision(revision, deploymentContext);
        },
      });
      await fixture.work(candidate, "succeeded");
      await fixture.stop();
      assert.equal(initial.length, 2);
      const [missing, unchanged] = initial;
      assert.ok(missing && unchanged, "expected two original bindings");
      const initialAttempts = await repositoryAttempts(fixture, candidate);
      for (const binding of initial) {
        const attempt = initialAttempts.find(
          (entry) =>
            entry.repositoryRef === binding.repositoryRef && entry.sessionId === binding.sessionId,
        );
        assert.ok(attempt);
        assert.equal(binding.admissionId, attempt.admissionId);
      }

      // Successful activation already owns a queued observation with its original
      // actor. Advancing this owned work's due time models a restart at that time.
      const maintenance = await fixture.advanceMaintenance(candidate);
      assert.equal(maintenance.rowCount, 1);
      const maintenanceRow = required(maintenance.rows[0], "scheduled maintenance");
      assert.equal(maintenanceRow.actor_id, fixture.actor.id);
      const observed: (readonly RepositoryCredentialRuntimeBinding[])[] = [];
      const stopped: string[] = [];
      const callsBeforeRestart = repository.calls.length;
      await fixture.start(
        {
          ...fixture.compute,
          async stopRevision(revision) {
            stopped.push(revision.id);
            return fixture.compute.stopRevision(revision);
          },
          async prepareRevision(revision, deploymentContext) {
            assert.ok(deploymentContext?.repositoryCredentials);
            observed.push(deploymentContext.repositoryCredentials);
            const result = await fixture.compute.prepareRevision(revision, deploymentContext);
            return observed.length === 1
              ? {
                  ...result,
                  ready: false,
                  repositoryCredentialMaterialMissing: [
                    { repositoryRef: missing.repositoryRef, sessionId: missing.sessionId },
                  ],
                }
              : result;
          },
        },
        { pool: fixture.createWorkerPool() },
      );
      await fixture.work(
        { id: candidate.id, idempotencyKey: maintenanceRow.idempotency_key },
        "succeeded",
      );
      assert.equal(observed.length, 2, "one missing observation permits one bounded repair");
      const [firstObservation, repairedObservation] = observed;
      assert.ok(firstObservation && repairedObservation, "expected two observations");
      assert.deepEqual(
        firstObservation.map(({ kind, repositoryRef, sessionId, admissionId }) => ({
          kind,
          repositoryRef,
          sessionId,
          admissionId,
        })),
        initial.map(({ repositoryRef, sessionId, admissionId }) => ({
          kind: "retained",
          repositoryRef,
          sessionId,
          admissionId,
        })),
      );
      const repaired = repairedObservation.find(
        ({ repositoryRef }) => repositoryRef === missing.repositoryRef,
      );
      const retained = repairedObservation.find(
        ({ repositoryRef }) => repositoryRef === unchanged.repositoryRef,
      );
      assert.equal(repaired?.kind, "new");
      assert.notEqual(repaired.sessionId, missing.sessionId);
      assert.notEqual(repaired.admissionId, missing.admissionId);
      assert.deepEqual(retained, firstObservation[1]);
      const repairedAttempts = await repositoryAttempts(fixture, candidate);
      const repairedAttempt = repairedAttempts.find(
        (entry) => entry.sessionId === repaired.sessionId,
      );
      assert.ok(repairedAttempt);
      assert.equal(repaired.admissionId, repairedAttempt.admissionId);
      const recoveryCalls = repository.calls.slice(callsBeforeRestart);
      assert.deepEqual(
        recoveryCalls
          .filter((call) => call.operation === "status")
          .map(({ sessionId }) => sessionId)
          .sort(),
        initial.map(({ sessionId }) => sessionId).sort(),
      );
      assert.deepEqual(
        recoveryCalls
          .filter((call) => call.operation === "close")
          .map(({ sessionId }) => sessionId),
        [missing.sessionId],
      );
      assert.equal(recoveryCalls.filter(({ operation }) => operation === "open").length, 1);
      await waitFor("session-only repair cleanup to settle", async () => {
        const cleanup = await fixture.observerPool.query<{ state: ControllerWorkState }>(
          `SELECT state FROM occ.controller_work
           WHERE revision_id = $1 AND idempotency_key LIKE $2`,
          [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:%`],
        );
        return cleanup.rowCount === 1 && cleanup.rows[0]?.state === "succeeded" ? true : undefined;
      });
      assert.deepEqual(stopped, []);
      assert.equal(
        required(await fixture.currentAgent(owner), "fixture Agent").activeRevisionId,
        candidate.id,
      );
    },
  );

  test(
    "repeated missing repository material fails the observation after one repair and cannot activate",
    requiresPostgres,
    async (context) => {
      const repository = repositoryBoundary();
      const fixture = await setup(context, { repoDriver: repository.driver });
      const { owner, candidate } = await fixture.admitInitialRevision("repository-repair-bound", {
        revision: { repositoryCredentials: repository.snapshot },
      });
      let preparations = 0;
      await fixture.start({
        ...fixture.compute,
        async prepareRevision(revision, deploymentContext) {
          preparations += 1;
          const observation = await fixture.compute.prepareRevision(revision, deploymentContext);
          assert.ok(deploymentContext?.repositoryCredentials);
          const [binding] = deploymentContext.repositoryCredentials;
          assert.ok(binding, "expected repository material");
          return {
            ...observation,
            ready: false,
            repositoryCredentialMaterialMissing: [
              {
                repositoryRef: binding.repositoryRef,
                sessionId: binding.sessionId,
              },
            ],
          };
        },
      });
      assert.equal((await fixture.work(candidate, "failed_permanent")).attempt_count, 1);
      assert.equal(preparations, 2);
      assert.equal(repository.calls.filter(({ operation }) => operation === "open").length, 2);
      const current = required(await fixture.currentAgent(owner), "fixture Agent");
      assert.equal(current.activeRevisionId, undefined);
      await waitFor("both unusable material attempts to be disposed", async () => {
        const attempts = await repositoryAttempts(fixture, candidate);
        return attempts.length === 2 && attempts.every(({ phase }) => phase === "disposed")
          ? true
          : undefined;
      });
    },
  );
}
