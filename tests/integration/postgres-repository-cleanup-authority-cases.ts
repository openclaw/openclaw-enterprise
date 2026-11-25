import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { EnqueueWork } from "../../packages/occ/src/index.ts";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import {
  claimExpected,
  createResources,
  dependencies,
  namespaceWork,
  revisionWork,
} from "./postgres-queue-recovery-fixture.ts";
import {
  cleanupNotAbandonable,
  cleanupNotOwned,
  completeCleanupWork,
  createRepositoryRevision,
  insertRawQueueWork,
  readQueueRow,
  readRepositoryAttempts,
  repositoryCleanupKey,
} from "./postgres-repository-cleanup-fixture.ts";

export function registerRepositoryCleanupAuthorityCases(): void {
  for (const desiredState of ["stopped", "running"]) {
    test(
      `failed Agent stop protects later admissions while Agent is ${desiredState}`,
      requiresPostgres,
      async (context) => {
        const { pool, queue } = await dependencies(context);
        const {
          namespaceId,
          agents: [agentId, unrelatedAgentId],
        } = await createResources(pool, 2);
        assert.ok(agentId && unrelatedAgentId);
        const old = await createRepositoryRevision(pool, namespaceId, agentId, ["open", "closing"]);
        const unrelated = await createRepositoryRevision(pool, namespaceId, unrelatedAgentId);
        const sourceKey = `agent-stop-cleanup:${randomUUID()}`;
        await pool.query<never>(
          "UPDATE occ.agents SET desired_runtime_state = 'stopped' WHERE id = $1",
          [agentId],
        );
        await queue.enqueue({
          namespaceId,
          agentId,
          agentTarget: "stopped",
          idempotencyKey: sourceKey,
          actorId: "principal-stop-source",
          availableAt: new Date(0),
        });
        const claim = await claimExpected(queue, sourceKey);
        const later = await createRepositoryRevision(pool, namespaceId, agentId, ["open"], 2);
        await pool.query<never>(
          "UPDATE occ.agents SET desired_runtime_state = $2, active_revision_id = $3 WHERE id = $1",
          [agentId, desiredState, later.revisionId],
        );
        const laterBefore = await readRepositoryAttempts(pool, later.revisionId);
        const unrelatedBefore = await readRepositoryAttempts(pool, unrelated.revisionId);
        await queue.fail(claim, { code: "STOP_FAILED" });
        assert.deepEqual(
          (await readRepositoryAttempts(pool, old.revisionId)).map((row) => row.phase),
          desiredState === "stopped" ? ["closing", "closing"] : ["open", "closing"],
        );
        assert.deepEqual(await readRepositoryAttempts(pool, later.revisionId), laterBefore);
        assert.deepEqual(await readRepositoryAttempts(pool, unrelated.revisionId), unrelatedBefore);
        assert.equal(
          await readQueueRow(pool, repositoryCleanupKey(later.revisionId, sourceKey)),
          undefined,
        );
        assert.equal(
          (await readQueueRow(pool, repositoryCleanupKey(old.revisionId, sourceKey)))?.actor_id,
          "principal-stop-source",
        );
        await completeCleanupWork(queue, old.revisionId, sourceKey);
      },
    );
  }

  test(
    "Namespace ensure failure cannot sweep an Agent and deletion registers only closing obligations",
    requiresPostgres,
    async (context) => {
      const { pool, queue, PostgresWorkQueue } = await dependencies(context);
      const {
        namespaceId,
        agents: [agentId],
      } = await createResources(pool);
      assert.ok(agentId);
      const owner = await createRepositoryRevision(pool, namespaceId, agentId, [
        "opening",
        "open",
        "closing",
      ]);
      const before = await readRepositoryAttempts(pool, owner.revisionId);
      const ensureKey = `namespace-ensure-cleanup:${randomUUID()}`;
      // A previously queued ensure observation may fail after the Namespace is ready.
      // Its target must not acquire deletion authority over admitted Agents.
      await queue.enqueue(namespaceWork(namespaceId, ensureKey));
      await queue.fail(await claimExpected(queue, ensureKey), { code: "PROVISION_FAILED" });
      assert.deepEqual(await readRepositoryAttempts(pool, owner.revisionId), before);
      assert.equal(
        await readQueueRow(pool, repositoryCleanupKey(owner.revisionId, ensureKey)),
        undefined,
      );
      const deleteKey = `namespace-delete-cleanup:${randomUUID()}`;
      await queue.enqueue(namespaceWork(namespaceId, deleteKey, new Date(0), "deleted"));
      const claim = await claimExpected(queue, deleteKey);
      // Public deletion rejects nonempty Namespaces; this retained-owner fixture exercises
      // only the queue recovery seam. The database forbids tombstoning this Namespace.
      await pool.query<never>("UPDATE occ.namespaces SET status = 'deleting' WHERE id = $1", [
        namespaceId,
      ]);
      await queue.fail(claim, { code: "DELETE_FAILED" });
      assert.deepEqual(await readRepositoryAttempts(pool, owner.revisionId), before);
      const cleanupKey = repositoryCleanupKey(owner.revisionId, deleteKey);
      assert.ok(await readQueueRow(pool, cleanupKey));
      const namespaceQueue = new PostgresWorkQueue(pool, { workKind: "namespace" });
      assert.equal(
        await namespaceQueue.claim(),
        undefined,
        "Namespace-only workers must not claim revision cleanup",
      );
      const cleanupClaim = await claimExpected(queue, cleanupKey);
      assert.equal(cleanupClaim.revisionId, owner.revisionId);
      await queue.complete(cleanupClaim);
    },
  );

  test(
    "internal cleanup registration accepts only closing owned predecessors and stored source identity",
    requiresPostgres,
    async (context) => {
      const { pool, queue, WorkClaimLostError } = await dependencies(context);
      const {
        namespaceId,
        agents: [agentId, unrelatedAgentId],
      } = await createResources(pool, 2);
      assert.ok(agentId && unrelatedAgentId);
      const previous = await createRepositoryRevision(pool, namespaceId, agentId, ["closing"]);
      const current = await createRepositoryRevision(pool, namespaceId, agentId, ["disposed"], 2);
      const later = await createRepositoryRevision(pool, namespaceId, agentId, ["closing"], 3);
      const unrelated = await createRepositoryRevision(pool, namespaceId, unrelatedAgentId, [
        "closing",
      ]);
      const sourceKey = `queue-retirement-cleanup:${randomUUID()}`;
      await queue.enqueue({
        ...revisionWork(namespaceId, sourceKey, agentId, current.revisionId),
        actorId: "principal-retirement",
      });
      const claim = await claimExpected(queue, sourceKey);
      await assert.rejects(
        queue.enqueueRepositoryCleanup({ ...claim, claimToken: randomUUID() }, previous),
        WorkClaimLostError,
      );
      await assert.rejects(queue.enqueueRepositoryCleanup(claim, later), cleanupNotOwned);
      await assert.rejects(queue.enqueueRepositoryCleanup(claim, unrelated), cleanupNotOwned);
      await assert.rejects(
        queue.enqueueRepositoryCleanup(claim, {
          ...previous,
          revisionId: `${previous.revisionId}0`,
        }),
        {
          name: "ScopeViolationError",
          message: "Repository cleanup requires an exact revision ID.",
        },
      );
      await assert.rejects(
        // @ts-expect-error The queue also rejects unsupported purposes at runtime.
        queue.enqueueRepositoryCleanup(claim, previous, "all"),
        {
          name: "ScopeViolationError",
          message: "Repository cleanup requires a supported purpose.",
        },
      );
      await assert.rejects(
        queue.enqueueRepositoryCleanup(claim, { ...previous, namespaceId: `ns_${randomUUID()}` }),
        cleanupNotOwned,
      );
      const forgedClaim = { ...claim, actorId: "principal-forged-caller" };
      const registered = await queue.enqueueRepositoryCleanup(forgedClaim, previous);
      assert.ok(registered);
      assert.equal(registered.idempotencyKey, repositoryCleanupKey(previous.revisionId, sourceKey));
      assert.equal(registered.actorId, "principal-retirement");
      assert.equal(
        (await queue.enqueueRepositoryCleanup(claim, previous))?.idempotencyKey,
        registered.idempotencyKey,
      );
      // Runtime retirement survives settled credentials but cannot inherit the
      // broader predecessor authority granted to session-only cleanup.
      assert.equal(await queue.enqueueRepositoryCleanup(claim, current), undefined);
      for (const purpose of ["terminal-runtime", "failed-preparation"] as const) {
        for (const forbidden of [
          previous,
          later,
          unrelated,
          { ...current, namespaceId: `ns_${randomUUID()}` },
        ]) {
          await assert.rejects(
            queue.enqueueRepositoryCleanup(claim, forbidden, purpose),
            cleanupNotOwned,
          );
        }
      }
      await assert.rejects(
        queue.enqueueRepositoryCleanup(
          { ...claim, claimToken: randomUUID() },
          current,
          "terminal-runtime",
        ),
        WorkClaimLostError,
      );
      const forgedRevisionClaim = { ...forgedClaim, revisionId: previous.revisionId };
      const retirement = await queue.enqueueRepositoryCleanup(
        forgedRevisionClaim,
        current,
        "terminal-runtime",
      );
      assert.ok(retirement);
      assert.equal(
        retirement.idempotencyKey,
        repositoryCleanupKey(current.revisionId, sourceKey, "terminal-runtime"),
      );
      assert.equal(retirement.actorId, "principal-retirement");
      assert.equal(
        (await queue.enqueueRepositoryCleanup(claim, current, "terminal-runtime"))?.idempotencyKey,
        retirement.idempotencyKey,
      );
      // Failed preparation coalesces with the same exact runtime retirement, never
      // granting predecessor or caller-supplied actor authority.
      const failedPreparation = await queue.enqueueRepositoryCleanup(
        forgedRevisionClaim,
        current,
        "failed-preparation",
      );
      assert.equal(failedPreparation?.idempotencyKey, retirement.idempotencyKey);
      assert.equal(failedPreparation?.actorId, "principal-retirement");
      assert.equal((await readRepositoryAttempts(pool, current.revisionId))[0]?.phase, "disposed");
      assert.equal(
        await readQueueRow(pool, repositoryCleanupKey(later.revisionId, sourceKey)),
        undefined,
      );
      assert.equal(
        await readQueueRow(pool, repositoryCleanupKey(unrelated.revisionId, sourceKey)),
        undefined,
      );
      await queue.complete(claim);
      await completeCleanupWork(queue, previous.revisionId, sourceKey);
      await completeCleanupWork(queue, current.revisionId, sourceKey, "terminal-runtime");
      // Credential withdrawal names the active revision but owns no repository cleanup. It is
      // claimable only once the Agent's other claimed work is settled.
      await pool.query<never>(
        "UPDATE occ.agents SET active_revision_id = $2, desired_runtime_state = 'running' WHERE id = $1",
        [agentId, current.revisionId],
      );
      const withdrawalKey = `agent_revision:${current.revisionId}:reconcile:credentials_withdrawn:${randomUUID()}`;
      await queue.enqueue({
        ...revisionWork(namespaceId, withdrawalKey, agentId, current.revisionId),
        agentTarget: "credentials_withdrawn",
      });
      const withdrawal = await claimExpected(queue, withdrawalKey);
      await assert.rejects(queue.enqueueRepositoryCleanup(withdrawal, previous), cleanupNotOwned);
      await queue.complete(withdrawal);
      await assert.rejects(queue.enqueueRepositoryCleanup(claim, previous), WorkClaimLostError);
      await assert.rejects(
        queue.enqueueRepositoryCleanup(claim, current, "terminal-runtime"),
        WorkClaimLostError,
      );
    },
  );

  test(
    "internal cleanup registration cannot close an open attempt or act for Namespace provisioning",
    requiresPostgres,
    async (context) => {
      const { pool, queue } = await dependencies(context);
      const {
        namespaceId,
        agents: [agentId],
      } = await createResources(pool);
      assert.ok(agentId);
      const owner = await createRepositoryRevision(pool, namespaceId, agentId);
      const key = `queue-no-closing:${randomUUID()}`;
      await queue.enqueue(revisionWork(namespaceId, key, agentId, owner.revisionId));
      const claim = await claimExpected(queue, key);
      assert.equal(await queue.enqueueRepositoryCleanup(claim, owner), undefined);
      assert.equal((await readRepositoryAttempts(pool, owner.revisionId))[0]?.phase, "open");
      await queue.complete(claim);
      const namespaceKey = `queue-provision-registration:${randomUUID()}`;
      await queue.enqueue(namespaceWork(namespaceId, namespaceKey));
      const namespaceClaim = await claimExpected(queue, namespaceKey);
      await assert.rejects(queue.enqueueRepositoryCleanup(namespaceClaim, owner), cleanupNotOwned);
      await assert.rejects(
        queue.enqueueRepositoryCleanup(namespaceClaim, owner, "terminal-runtime"),
        cleanupNotOwned,
      );
      await queue.complete(namespaceClaim);
    },
  );

  test(
    "maintenance continuation and successor enqueue commit together or preserve existing sessions on rollback",
    requiresPostgres,
    async (context) => {
      const { pool, queue, PostgresWorkQueue } = await dependencies(context);
      const {
        namespaceId,
        agents: [agentId],
      } = await createResources(pool);
      assert.ok(agentId);
      const owner = await createRepositoryRevision(pool, namespaceId, agentId);
      await pool.query<never>(
        "UPDATE occ.agents SET active_revision_id = $2, desired_runtime_state = 'running' WHERE id = $1",
        [agentId, owner.revisionId],
      );
      const sourceKey = `agent_revision:${owner.revisionId}:maintenance:1`;
      const successorKey = `agent_revision:${owner.revisionId}:maintenance:2`;
      await queue.enqueue(revisionWork(namespaceId, sourceKey, agentId, owner.revisionId));
      const claim = await claimExpected(queue, sourceKey);
      await queue.enqueue({
        ...revisionWork(namespaceId, successorKey, agentId, owner.revisionId),
        actorId: "principal-conflicting-successor",
      });
      const before = await readRepositoryAttempts(pool, owner.revisionId);
      const client = await pool.connect();
      try {
        await client.query<never>("BEGIN");
        const transactionQueue = new PostgresWorkQueue(client);
        await transactionQueue.fail(
          claim,
          { code: "MAINTENANCE_OUTAGE" },
          { continuingRevision: true },
        );
        await assert.rejects(
          transactionQueue.enqueue(
            revisionWork(namespaceId, successorKey, agentId, owner.revisionId),
          ),
          {
            name: "ResourceConflictError",
            message:
              "The controller work idempotency key already belongs to another owner or actor.",
          },
        );
        await client.query<never>("ROLLBACK");
        assert.equal((await readQueueRow(pool, sourceKey))?.state, "claimed");
        assert.deepEqual(await readRepositoryAttempts(pool, owner.revisionId), before);
        assert.equal(
          await readQueueRow(
            pool,
            repositoryCleanupKey(owner.revisionId, sourceKey, "terminal-runtime"),
          ),
          undefined,
        );
        assert.equal(
          (
            await pool.query<{ id: string }>(
              "SELECT id FROM occ.audit_events WHERE resource_id = $1 AND details->>'reasonCode' = 'MAINTENANCE_OUTAGE'",
              [owner.revisionId],
            )
          ).rowCount,
          0,
        );
        await client.query<never>("BEGIN");
        await transactionQueue.fail(
          claim,
          { code: "MAINTENANCE_OUTAGE" },
          { continuingRevision: true },
        );
        await transactionQueue.enqueue(
          revisionWork(
            namespaceId,
            `agent_revision:${owner.revisionId}:maintenance:3`,
            agentId,
            owner.revisionId,
          ),
        );
        await client.query<never>("COMMIT");
      } finally {
        client.release();
      }
      assert.equal((await readQueueRow(pool, sourceKey))?.state, "failed_permanent");
      assert.deepEqual(await readRepositoryAttempts(pool, owner.revisionId), before);
      assert.equal(
        await readQueueRow(
          pool,
          repositoryCleanupKey(owner.revisionId, sourceKey, "terminal-runtime"),
        ),
        undefined,
      );
      assert.equal(
        (await readQueueRow(pool, `agent_revision:${owner.revisionId}:maintenance:3`))?.actor_id,
        claim.actorId,
      );
      assert.equal(
        (
          await pool.query<{ id: string }>(
            "SELECT id FROM occ.audit_events WHERE resource_id = $1 AND details->>'reasonCode' = 'MAINTENANCE_OUTAGE'",
            [owner.revisionId],
          )
        ).rowCount,
        1,
      );
      await queue.complete(await claimExpected(queue, successorKey));
      await queue.complete(
        await claimExpected(queue, `agent_revision:${owner.revisionId}:maintenance:3`),
      );
    },
  );

  for (const invalid of [
    "another revision's deployment",
    "leading zero",
    "suffix",
    "cleanup",
    "stop",
    "namespace",
    "stopped",
    "inactive",
    "namespace unavailable",
    "expired deadline",
  ]) {
    test(
      `maintenance continuation rejects ${invalid} without abandoning obligations`,
      requiresPostgres,
      async (context) => {
        const { pool, queue } = await dependencies(context);
        const {
          namespaceId,
          agents: [agentId],
        } = await createResources(pool);
        assert.ok(agentId);
        const owner = await createRepositoryRevision(
          pool,
          namespaceId,
          agentId,
          ["open"],
          1,
          invalid === "expired deadline" ? Date.now() - 1000 : Date.now() + 3_600_000,
        );
        await pool.query<never>(
          "UPDATE occ.agents SET active_revision_id = $2, desired_runtime_state = 'running' WHERE id = $1",
          [agentId, owner.revisionId],
        );
        let sourceKey = `agent_revision:${owner.revisionId}:maintenance:1`;
        // The active revision's own deployment may continue; see the worker tests.
        if (invalid === "another revision's deployment") {
          sourceKey = `agent_revision:rev_${randomUUID()}:reconcile`;
        }
        if (invalid === "leading zero") {
          sourceKey = `agent_revision:${owner.revisionId}:maintenance:01`;
        }
        if (invalid === "suffix") {
          sourceKey = `agent_revision:${owner.revisionId}:maintenance:1:extra`;
        }
        if (invalid === "cleanup") {
          sourceKey = repositoryCleanupKey(owner.revisionId, "source");
        }
        let input: EnqueueWork = revisionWork(namespaceId, sourceKey, agentId, owner.revisionId);
        if (invalid === "stop") {
          input = {
            namespaceId,
            agentId,
            agentTarget: "stopped",
            idempotencyKey: sourceKey,
            actorId: "principal-queue-integration",
          };
        }
        if (invalid === "namespace") {
          input = namespaceWork(namespaceId, sourceKey);
        }
        if (invalid === "cleanup") {
          await insertRawQueueWork(pool, input);
        } else {
          await queue.enqueue(input);
        }
        const claim = await claimExpected(queue, sourceKey);
        if (invalid === "stopped") {
          await pool.query<never>(
            "UPDATE occ.agents SET desired_runtime_state = 'stopped' WHERE id = $1",
            [agentId],
          );
        }
        if (invalid === "inactive") {
          await pool.query<never>("UPDATE occ.agents SET active_revision_id = NULL WHERE id = $1", [
            agentId,
          ]);
        }
        if (invalid === "namespace unavailable") {
          await pool.query<never>("UPDATE occ.namespaces SET status = 'deleting' WHERE id = $1", [
            namespaceId,
          ]);
        }
        const before = await readRepositoryAttempts(pool, owner.revisionId);
        // Malformed or non-continuation keys fail the key check before any SQL runs; the
        // rest reach SQL, which finds no current active revision for the claim.
        await assert.rejects(
          queue.fail(claim, { code: "INVALID_CONTINUATION" }, { continuingRevision: true }),
          ["leading zero", "suffix", "cleanup"].includes(invalid)
            ? {
                name: "ScopeViolationError",
                message:
                  "Only an active revision's deployment or maintenance can continue after failure.",
              }
            : cleanupNotAbandonable,
        );
        assert.equal((await readQueueRow(pool, sourceKey))?.state, "claimed");
        assert.deepEqual(await readRepositoryAttempts(pool, owner.revisionId), before);
        assert.equal(
          (
            await pool.query<{ id: string }>(
              "SELECT id FROM occ.audit_events WHERE resource_id = $1 AND details->>'reasonCode' = 'INVALID_CONTINUATION'",
              [owner.revisionId],
            )
          ).rowCount,
          0,
        );
        await queue.complete(claim);
      },
    );
  }

  test(
    "a still-current Namespace deletion claim requeues completed cleanup for a later closing obligation",
    requiresPostgres,
    async (context) => {
      const { pool, queue } = await dependencies(context);
      const {
        namespaceId,
        agents: [agentId],
      } = await createResources(pool);
      assert.ok(agentId);
      const owner = await createRepositoryRevision(pool, namespaceId, agentId, ["closing", "open"]);
      // This is retained-owner recovery at the queue boundary; public deletion currently
      // requires an empty Namespace and cannot construct this fixture itself.
      await pool.query<never>("UPDATE occ.namespaces SET status = 'deleting' WHERE id = $1", [
        namespaceId,
      ]);
      const sourceKey = `queue-delete-register:${randomUUID()}`;
      await queue.enqueue(namespaceWork(namespaceId, sourceKey, new Date(0), "deleted"));
      const source = await claimExpected(queue, sourceKey);
      const registered = await queue.enqueueRepositoryCleanup(source, owner);
      assert.ok(registered);
      const cleanup = await claimExpected(queue, registered.idempotencyKey);
      const [closingAdmissionId, lateAdmissionId] = owner.admissionIds;
      assert.ok(closingAdmissionId && lateAdmissionId);
      await pool.query<never>(
        "UPDATE occ.repository_session_attempts SET phase = 'disposed', updated_at = clock_timestamp() WHERE admission_id = $1",
        [closingAdmissionId],
      );
      await queue.complete(cleanup);
      assert.equal((await readQueueRow(pool, registered.idempotencyKey))?.state, "succeeded");
      // Admission already happened before deletion; only its closing transition is late.
      await pool.query<never>(
        "UPDATE occ.repository_session_attempts SET phase = 'closing', updated_at = clock_timestamp() WHERE admission_id = $1",
        [lateAdmissionId],
      );
      const requeued = await queue.enqueueRepositoryCleanup(source, owner);
      assert.ok(requeued);
      assert.equal(requeued.idempotencyKey, registered.idempotencyKey);
      assert.equal(requeued.state, "queued");
      assert.equal(requeued.actorId, source.actorId);
      assert.equal((await readQueueRow(pool, registered.idempotencyKey))?.completed_at, null);
      const replay = await claimExpected(queue, registered.idempotencyKey);
      await pool.query<never>(
        "UPDATE occ.repository_session_attempts SET phase = 'disposed', updated_at = clock_timestamp() WHERE admission_id = $1",
        [lateAdmissionId],
      );
      await queue.complete(replay);
      await queue.complete(source);
    },
  );

  test(
    "stop cleanup uses the Agent state obtained after waiting for its row lock",
    requiresPostgres,
    async (context) => {
      const { pool, queue, PostgresWorkQueue } = await dependencies(context);
      const {
        namespaceId,
        agents: [agentId],
      } = await createResources(pool);
      assert.ok(agentId);
      const owner = await createRepositoryRevision(pool, namespaceId, agentId, ["open", "closing"]);
      await pool.query<never>(
        "UPDATE occ.agents SET desired_runtime_state = 'stopped' WHERE id = $1",
        [agentId],
      );
      const sourceKey = `queue-stop-lock:${randomUUID()}`;
      await queue.enqueue({
        namespaceId,
        agentId,
        agentTarget: "stopped",
        idempotencyKey: sourceKey,
        actorId: "principal-stop-lock",
      });
      const claim = await claimExpected(queue, sourceKey);
      const before = await readRepositoryAttempts(pool, owner.revisionId);
      const blocker = await pool.connect();
      const worker = await pool.connect();
      let failure: Promise<void> | undefined;
      try {
        await blocker.query<never>("BEGIN");
        await blocker.query<never>(
          "UPDATE occ.agents SET desired_runtime_state = 'running' WHERE id = $1",
          [agentId],
        );
        const workerPid = "processID" in worker ? worker.processID : undefined;
        assert.equal(typeof workerPid, "number");
        // The queue statement begins while the old stopped value is still committed.
        // The writer releases running only after the queue demonstrably waits on its lock.
        failure = new PostgresWorkQueue(worker).fail(claim, { code: "STOP_LOCK_RACE" });
        failure.catch(() => {});
        let waiting = false;
        for (let index = 0; index < 100; index += 1) {
          const activity = await pool.query<{ wait_event_type: string | null }>(
            "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
            [workerPid],
          );
          if (activity.rows[0]?.wait_event_type === "Lock") {
            waiting = true;
            break;
          }
          await delay(20);
        }
        assert.equal(
          waiting,
          true,
          "terminal transfer must serialize with the Agent lifecycle writer",
        );
        await blocker.query<never>("COMMIT");
        await failure;
      } finally {
        await blocker.query<never>("ROLLBACK");
        await failure?.catch(() => {});
        blocker.release();
        worker.release();
      }
      assert.deepEqual(
        await readRepositoryAttempts(pool, owner.revisionId),
        before,
        "a statement snapshot of stopped must not override the freshly locked running value",
      );
      assert.ok(
        await readQueueRow(pool, repositoryCleanupKey(owner.revisionId, sourceKey)),
        "the preexisting closing obligation still requires cleanup",
      );
      await completeCleanupWork(queue, owner.revisionId, sourceKey);
    },
  );
}
