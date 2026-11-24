import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { ClaimedWork, ControllerWorkState } from "../../packages/occ/src/controller-work.ts";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { expireWorkLease } from "../helpers/postgres-worker-revision-support.mjs";
import {
  claimExpected,
  createQueueRevision,
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

interface CleanupRegistrationRow {
  readonly idempotency_key: string;
  readonly state: ControllerWorkState;
  readonly actor_id: string;
}

export function registerRepositoryCleanupTransferCases(): void {
  test(
    "repeated and concurrent cleanup registration coalesces by revision and purpose",
    requiresPostgres,
    async (context) => {
      const { pool, queue, WorkClaimLostError } = await dependencies(context);
      const {
        namespaceId,
        agents: [agentId, otherAgentId],
      } = await createResources(pool, 2);
      assert.ok(agentId);
      assert.ok(otherAgentId);
      const owner = await createRepositoryRevision(pool, namespaceId, agentId, ["invalidated"]);
      const sibling = await createRepositoryRevision(pool, namespaceId, otherAgentId, [
        "invalidated",
      ]);
      let cleanupKey: string | undefined;

      for (let index = 0; index < 8; index += 1) {
        const sourceKey = `agent:${agentId}:reconcile:stopped:${randomUUID()}`;
        await queue.enqueue({
          idempotencyKey: sourceKey,
          namespaceId,
          agentId,
          agentTarget: "stopped",
          actorId: `principal-source-${index}`,
          availableAt: new Date(0),
        });
        const source = await claimExpected(queue, sourceKey);
        await assert.rejects(queue.enqueueRepositoryCleanup(source, sibling), cleanupNotOwned);
        if (index === 0) {
          // A revision admitted after this stop Work was created cannot inherit its cleanup.
          const later = await createRepositoryRevision(pool, namespaceId, agentId, ["closing"], 2);
          await assert.rejects(queue.enqueueRepositoryCleanup(source, later), cleanupNotOwned);
        }
        await assert.rejects(
          queue.enqueueRepositoryCleanup({ ...source, claimToken: randomUUID() }, owner),
          WorkClaimLostError,
        );
        // Concurrent registrations must retain the same claim and never multiply
        // the unknown provider obligation, even across different source actors.
        const registered = await Promise.all(
          Array.from({ length: 4 }, () => queue.enqueueRepositoryCleanup(source, owner)),
        );
        const [registration] = registered;
        assert.ok(registration, "The invalidated session needs a cleanup obligation");
        cleanupKey ??= registration.idempotencyKey;
        const expectedKey = cleanupKey;
        assert.ok(registered.every((work) => work?.idempotencyKey === expectedKey));
        assert.equal(registration.actorId, "principal-source-0");
        await queue.complete(source);
      }
      assert.ok(cleanupKey);
      const rows = await pool.query<CleanupRegistrationRow>(
        `SELECT idempotency_key, state, actor_id FROM occ.controller_work
       WHERE revision_id = $1 AND idempotency_key LIKE $2`,
        [owner.revisionId, `agent_revision:${owner.revisionId}:repository_cleanup:%`],
      );
      assert.deepEqual(rows.rows, [
        {
          idempotency_key: cleanupKey,
          state: "queued",
          actor_id: "principal-source-0",
        },
      ]);
      assert.equal((await readRepositoryAttempts(pool, owner.revisionId))[0]?.phase, "invalidated");
      assert.equal(
        (await readRepositoryAttempts(pool, sibling.revisionId))[0]?.phase,
        "invalidated",
      );

      // Retry preserves the same durable obligation and claim ownership.
      const cleanup = await claimExpected(queue, cleanupKey);
      // Cleanup work cannot register more cleanup, even for the revision it cleans.
      await assert.rejects(queue.enqueueRepositoryCleanup(cleanup, owner), cleanupNotOwned);
      await assert.rejects(queue.fail(cleanup, { code: "CANNOT_ABANDON" }), cleanupNotAbandonable);
      await queue.defer(cleanup, { code: "REPOSITORY_CLEANUP_PENDING" });
      await assert.rejects(queue.complete(cleanup), WorkClaimLostError);
      assert.equal((await readQueueRow(pool, cleanupKey))?.state, "queued");
      // Retain the unresolved fixture while keeping it out of other test scheduling.
      await pool.query<never>(
        "UPDATE occ.controller_work SET available_at = 'infinity' WHERE idempotency_key = $1",
        [cleanupKey],
      );
    },
  );

  test(
    "batch recovery coalesces multiple failed Agent stops without losing audit attribution",
    requiresPostgres,
    async (context) => {
      const { pool, queue } = await dependencies(context, { maxAttempts: 1 });
      const {
        namespaceId,
        agents: [agentId, otherAgentId],
      } = await createResources(pool, 2);
      assert.ok(agentId);
      assert.ok(otherAgentId);
      const owner = await createRepositoryRevision(pool, namespaceId, agentId, [
        "open",
        "invalidated",
      ]);
      const sibling = await createRepositoryRevision(pool, namespaceId, otherAgentId, ["open"]);
      const siblingBefore = await readRepositoryAttempts(pool, sibling.revisionId);
      await pool.query<never>(
        "UPDATE occ.agents SET desired_runtime_state = 'stopped' WHERE id = $1",
        [agentId],
      );
      const keys: string[] = [];
      for (const actorId of ["principal-stop-a", "principal-stop-b"]) {
        const key = `agent:${agentId}:reconcile:stopped:${randomUUID()}`;
        keys.push(key);
        await queue.enqueue({
          idempotencyKey: key,
          namespaceId,
          agentId,
          agentTarget: "stopped",
          actorId,
        });
      }
      // Two distinct stop requests exhaust in one recovery statement.
      await pool.query<never>(
        "UPDATE occ.controller_work SET attempt_count = 1 WHERE idempotency_key = ANY($1::text[])",
        [keys],
      );
      const recovered = await queue.recoverStale();
      assert.equal(recovered.exhaustedQueued, 2);
      const cleanup = await pool.query<CleanupRegistrationRow>(
        `SELECT idempotency_key, state, actor_id FROM occ.controller_work
       WHERE revision_id = $1 AND idempotency_key LIKE $2`,
        [owner.revisionId, `agent_revision:${owner.revisionId}:repository_cleanup:%`],
      );
      assert.equal(cleanup.rowCount, 1);
      const [cleanupWork] = cleanup.rows;
      assert.ok(cleanupWork);
      assert.equal(cleanupWork.state, "queued");
      assert.ok(["principal-stop-a", "principal-stop-b"].includes(cleanupWork.actor_id));
      assert.deepEqual(
        (await readRepositoryAttempts(pool, owner.revisionId)).map(({ phase }) => phase),
        ["closing", "invalidated"],
      );
      assert.deepEqual(await readRepositoryAttempts(pool, sibling.revisionId), siblingBefore);
      const evidence = await pool.query<{ actor_id: string }>(
        `SELECT actor_id FROM occ.audit_events
       WHERE resource_id = $1 AND details->>'reasonCode' = 'MAX_ATTEMPTS_EXHAUSTED'`,
        [agentId],
      );
      assert.deepEqual(evidence.rows.map(({ actor_id }) => actor_id).sort(), [
        "principal-stop-a",
        "principal-stop-b",
      ]);
      await pool.query<never>(
        "UPDATE occ.controller_work SET available_at = 'infinity' WHERE idempotency_key = $1",
        [cleanupWork.idempotency_key],
      );
    },
  );

  for (const transition of ["fail", "retry", "expired claim", "exhausted queued"] as const) {
    for (const sessionState of ["mixed", "settled", "unstarted"] as const) {
      test(
        `repository cleanup transfers exact revision obligations atomically on ${transition} with ${sessionState} sessions`,
        requiresPostgres,
        async (context) => {
          const { pool, queue, WorkClaimLostError } = await dependencies(context, {
            maxAttempts: 1,
          });
          const {
            namespaceId,
            agents: [agentId, otherAgentId],
          } = await createResources(pool, 2);
          assert.ok(agentId);
          assert.ok(otherAgentId);
          const phases = {
            mixed: ["opening", "open", "closing", "disposed", "invalidated"],
            settled: ["disposed"],
            unstarted: [undefined],
          } as const;
          const owner = await createRepositoryRevision(
            pool,
            namespaceId,
            agentId,
            phases[sessionState],
          );
          const sibling = await createRepositoryRevision(pool, namespaceId, agentId, ["open"], 2);
          const unrelated = await createRepositoryRevision(pool, namespaceId, otherAgentId);
          const before = await readRepositoryAttempts(pool, owner.revisionId);
          const siblingBefore = await readRepositoryAttempts(pool, sibling.revisionId);
          const unrelatedBefore = await readRepositoryAttempts(pool, unrelated.revisionId);
          const sourceKey = `queue-cleanup:${transition}:café:雪:${randomUUID()}`;
          const actorId = `principal-source-${randomUUID()}`;
          await queue.enqueue({
            ...revisionWork(namespaceId, sourceKey, agentId, owner.revisionId),
            actorId,
          });
          let claim: ClaimedWork | undefined;
          if (transition === "exhausted queued") {
            await pool.query<never>(
              "UPDATE occ.controller_work SET attempt_count = 1 WHERE idempotency_key = $1",
              [sourceKey],
            );
            await queue.recoverStale();
          } else {
            claim = await claimExpected(queue, sourceKey);
            if (transition === "expired claim") {
              await expireWorkLease(pool, sourceKey);
              await queue.recoverStale();
            } else {
              await queue[transition](claim, { code: "REPOSITORY_TRANSITION_FAILED" });
            }
          }
          assert.equal((await readQueueRow(pool, sourceKey))?.state, "failed_permanent");
          assert.deepEqual(
            await readRepositoryAttempts(pool, owner.revisionId),
            before.map((attempt) => ({
              ...attempt,
              phase: ["opening", "open"].includes(attempt.phase) ? "closing" : attempt.phase,
            })),
            "transfer must retain immutable admission identity and every recorded session",
          );
          assert.deepEqual(await readRepositoryAttempts(pool, sibling.revisionId), siblingBefore);
          assert.deepEqual(
            await readRepositoryAttempts(pool, unrelated.revisionId),
            unrelatedBefore,
          );
          const cleanupKey = repositoryCleanupKey(owner.revisionId, sourceKey, "terminal-runtime");
          const cleanup = await readQueueRow(pool, cleanupKey);
          assert.ok(cleanup);
          const transferred = await pool.query<{ idempotency_key: string }>(
            "SELECT idempotency_key FROM occ.controller_work WHERE namespace_id = $1 ORDER BY idempotency_key",
            [namespaceId],
          );
          assert.deepEqual(
            transferred.rows.map(({ idempotency_key }) => idempotency_key),
            [sourceKey, cleanupKey].sort(),
            "terminal transfer creates only the exact revision's runtime retirement obligation",
          );
          assert.deepEqual(
            [
              cleanup.namespace_id,
              cleanup.agent_id,
              cleanup.revision_id,
              cleanup.actor_id,
              cleanup.namespace_target,
              cleanup.agent_target,
              cleanup.state,
              cleanup.attempt_count,
            ],
            [namespaceId, agentId, owner.revisionId, actorId, null, null, "queued", 0],
          );
          const digest = await pool.query<{ hash: string }>(
            "SELECT encode(sha256(convert_to($1, 'UTF8')), 'hex') AS hash",
            [owner.revisionId],
          );
          assert.equal(
            cleanupKey,
            `agent_revision:${owner.revisionId}:repository_cleanup:retire:${digest.rows[0]?.hash}`,
          );
          const evidence = await pool.query<{ actor_id: string }>(
            "SELECT actor_id FROM occ.audit_events WHERE resource_id = $1 AND outcome = 'failure'",
            [owner.revisionId],
          );
          assert.deepEqual(evidence.rows, [{ actor_id: actorId }]);
          if (claim) {
            await assert.rejects(
              queue.fail(claim, { code: "DUPLICATE_FAILURE" }),
              WorkClaimLostError,
            );
          }
          await queue.recoverStale();
          assert.equal((await readQueueRow(pool, cleanupKey))?.state, "queued");
          await completeCleanupWork(queue, owner.revisionId, sourceKey, "terminal-runtime");
        },
      );
    }
  }

  test(
    "ordinary retry and stale claim tokens cannot close repository authority",
    requiresPostgres,
    async (context) => {
      const { pool, queue, WorkClaimLostError } = await dependencies(context, { maxAttempts: 3 });
      const {
        namespaceId,
        agents: [agentId],
      } = await createResources(pool);
      assert.ok(agentId);
      const owner = await createRepositoryRevision(pool, namespaceId, agentId);
      const sourceKey = `queue-cleanup-retry:${randomUUID()}`;
      await queue.enqueue(revisionWork(namespaceId, sourceKey, agentId, owner.revisionId));
      const claim = await claimExpected(queue, sourceKey);
      const before = await readRepositoryAttempts(pool, owner.revisionId);
      const stale = { ...claim, claimToken: randomUUID() };
      await assert.rejects(queue.fail(stale, { code: "STALE" }), WorkClaimLostError);
      await assert.rejects(queue.retry(stale, { code: "STALE" }), WorkClaimLostError);
      await queue.retry(claim, { code: "TEMPORARY" });
      assert.equal((await readQueueRow(pool, sourceKey))?.state, "queued");
      assert.deepEqual(await readRepositoryAttempts(pool, owner.revisionId), before);
      assert.equal(
        await readQueueRow(
          pool,
          repositoryCleanupKey(owner.revisionId, sourceKey, "terminal-runtime"),
        ),
        undefined,
      );
      const next = await claimExpected(queue, sourceKey);
      await expireWorkLease(pool, sourceKey);
      await assert.rejects(queue.fail(next, { code: "EXPIRED" }), WorkClaimLostError);
      await assert.rejects(queue.retry(next, { code: "EXPIRED" }), WorkClaimLostError);
      assert.deepEqual(await readRepositoryAttempts(pool, owner.revisionId), before);
      await queue.recoverStale();
      await queue.complete(await claimExpected(queue, sourceKey));
    },
  );

  test(
    "cleanup transfer rollback and a conflicting cleanup owner preserve the source claim",
    requiresPostgres,
    async (context) => {
      const { pool, queue, PostgresWorkQueue } = await dependencies(context);
      const {
        namespaceId,
        agents: [agentId],
      } = await createResources(pool);
      assert.ok(agentId);
      const owner = await createRepositoryRevision(pool, namespaceId, agentId);
      const successor = await createRepositoryRevision(pool, namespaceId, agentId, ["open"], 2);
      const sourceKey = `queue-cleanup-rollback:${randomUUID()}`;
      await queue.enqueue(revisionWork(namespaceId, sourceKey, agentId, owner.revisionId));
      const claim = await claimExpected(queue, sourceKey);
      const before = await readRepositoryAttempts(pool, owner.revisionId);
      const successorBefore = await readRepositoryAttempts(pool, successor.revisionId);
      const client = await pool.connect();
      try {
        await client.query<never>("BEGIN");
        const transactionQueue = new PostgresWorkQueue(client);
        await transactionQueue.fail(claim, { code: "ROLLBACK_CLEANUP" });
        assert.equal((await readQueueRow(client, sourceKey))?.state, "failed_permanent");
        assert.ok(
          await readQueueRow(
            client,
            repositoryCleanupKey(owner.revisionId, sourceKey, "terminal-runtime"),
          ),
        );
        await client.query<never>("ROLLBACK");
      } finally {
        client.release();
      }
      assert.equal((await readQueueRow(pool, sourceKey))?.state, "claimed");
      assert.deepEqual(await readRepositoryAttempts(pool, owner.revisionId), before);
      const cleanupKey = repositoryCleanupKey(owner.revisionId, sourceKey, "terminal-runtime");
      assert.equal(await readQueueRow(pool, cleanupKey), undefined);
      await insertRawQueueWork(pool, {
        // Same Agent, another revision: the key collides and only the revision differs.
        ...revisionWork(namespaceId, cleanupKey, agentId, successor.revisionId),
        actorId: "principal-conflicting-cleanup",
      });
      // The colliding owner turns the cleanup upsert's attempt count negative, so the
      // attempt-count constraint aborts the whole failure transition.
      await assert.rejects(queue.fail(claim, { code: "COLLIDING_CLEANUP" }), {
        code: "23514",
        constraint: "controller_work_attempt_count_valid",
      });
      const source = await readQueueRow(pool, sourceKey);
      assert.ok(source);
      assert.equal(source.state, "claimed");
      assert.equal(source.claim_token, claim.claimToken);
      assert.deepEqual(await readRepositoryAttempts(pool, owner.revisionId), before);
      assert.deepEqual(await readRepositoryAttempts(pool, successor.revisionId), successorBefore);
      assert.equal(
        (
          await pool.query<{ id: string }>(
            "SELECT id FROM occ.audit_events WHERE resource_id = $1",
            [owner.revisionId],
          )
        ).rowCount,
        0,
      );
      await queue.complete(claim);
      await queue.complete(await claimExpected(queue, cleanupKey));
    },
  );

  for (const purpose of ["sessions", "terminal-runtime"] as const) {
    test(
      `${purpose} cleanup retries and worker crashes cannot exhaust or recursively fan out`,
      requiresPostgres,
      async (context) => {
        const { pool, queue } = await dependencies(context, { maxAttempts: 2 });
        const {
          namespaceId,
          agents: [agentId],
        } = await createResources(pool);
        assert.ok(agentId);
        const owner = await createRepositoryRevision(pool, namespaceId, agentId);
        const sourceKey = `queue-cleanup-persistent:${randomUUID()}`;
        await queue.enqueue(revisionWork(namespaceId, sourceKey, agentId, owner.revisionId));
        const source = await claimExpected(queue, sourceKey);
        if (purpose === "terminal-runtime") {
          await queue.fail(source, { code: "SOURCE_FAILED" });
        } else {
          await pool.query<never>(
            "UPDATE occ.repository_session_attempts SET phase = 'closing', updated_at = clock_timestamp() WHERE revision_id = $1",
            [owner.revisionId],
          );
          await queue.enqueueRepositoryCleanup(source, owner);
          await queue.complete(source);
        }
        const cleanupKey = repositoryCleanupKey(owner.revisionId, sourceKey, purpose);
        for (let index = 0; index < 8; index += 1) {
          const claim = await claimExpected(queue, cleanupKey);
          assert.ok(
            claim.attemptCount <= 2,
            "cleanup attempts must saturate without integer growth",
          );
          await assert.rejects(
            queue.fail(claim, { code: "CANNOT_ABANDON" }),
            cleanupNotAbandonable,
          );
          assert.equal((await readQueueRow(pool, cleanupKey))?.state, "claimed");
          if (index % 2 === 0) {
            await queue.retry(claim, { code: "CLEANUP_UNAVAILABLE" });
          } else {
            await expireWorkLease(pool, cleanupKey);
            await queue.recoverStale();
          }
          const queued = await readQueueRow(pool, cleanupKey);
          assert.ok(queued);
          assert.equal(queued.state, "queued");
          assert.equal(queued.completed_at, null);
          assert.ok(queued.attempt_count <= 2);
          await queue.recoverStale();
          assert.equal(
            (await readQueueRow(pool, cleanupKey))?.state,
            "queued",
            "queued exhaustion must exclude cleanup",
          );
        }
        const rows = await pool.query<{ idempotency_key: string }>(
          "SELECT idempotency_key FROM occ.controller_work WHERE revision_id = $1",
          [owner.revisionId],
        );
        assert.deepEqual(
          rows.rows.map((row) => row.idempotency_key).sort(),
          [sourceKey, cleanupKey].sort(),
        );
        await queue.complete(await claimExpected(queue, cleanupKey));
      },
    );
  }

  for (const purpose of ["sessions", "terminal-runtime"] as const) {
    test(
      `${purpose} cleanup key validation agrees with SQL claim exemptions and reserves the entire family`,
      requiresPostgres,
      async (context) => {
        const { pool, queue, isRepositoryCleanupWork, isRepositoryRuntimeRetirementWork } =
          await dependencies(context, {
            maxAttempts: 2,
          });
        const { namespaceId, agents } = await createResources(pool, 8);
        const revisions = await Promise.all(
          agents.map((agentId) => createQueueRevision(pool, namespaceId, agentId)),
        );
        const digest = "a".repeat(64);
        const purposeKey = purpose === "terminal-runtime" ? "retire:" : "";
        const cases = [
          {
            name: "valid",
            key: `agent_revision:${revisions[0]}:repository_cleanup:${purposeKey}${digest}`,
            valid: true,
          },
          {
            name: "short digest",
            key: `agent_revision:${revisions[1]}:repository_cleanup:${purposeKey}${digest.slice(1)}`,
            valid: false,
          },
          {
            name: "uppercase digest",
            key: `agent_revision:${revisions[2]}:repository_cleanup:${purposeKey}${digest.toUpperCase()}`,
            valid: false,
          },
          {
            name: "suffix",
            key: `agent_revision:${revisions[3]}:repository_cleanup:${purposeKey}${digest}:extra`,
            valid: false,
          },
          {
            name: "different revision",
            // A distinct digest lets the valid and owner-mismatch rows coexist.
            key: `agent_revision:${revisions[0]}:repository_cleanup:${purposeKey}${"b".repeat(64)}`,
            valid: false,
          },
          {
            name: "trailing newline",
            key: `agent_revision:${revisions[5]}:repository_cleanup:${purposeKey}${digest}\n`,
            valid: false,
          },
          {
            name: "invalid embedded revision",
            key: `agent_revision:rev_invalid_${randomUUID()}:repository_cleanup:${purposeKey}${digest}`,
            valid: false,
          },
          {
            name: "namespace target",
            key: `agent_revision:${revisions[7]}:repository_cleanup:${purposeKey}${digest}`,
            valid: false,
          },
        ];
        for (const [index, scenario] of cases.entries()) {
          const agentId = agents[index];
          const revisionId = revisions[index];
          assert.ok(agentId && revisionId, "Each key scenario needs its own revision");
          const input =
            scenario.name === "namespace target"
              ? namespaceWork(namespaceId, scenario.key)
              : revisionWork(namespaceId, scenario.key, agentId, revisionId);
          assert.equal(isRepositoryCleanupWork(input), scenario.valid, scenario.name);
          assert.equal(
            isRepositoryRuntimeRetirementWork(input),
            scenario.valid && purpose === "terminal-runtime",
            scenario.name,
          );
          await assert.rejects(
            queue.enqueue(input),
            {
              name: "ScopeViolationError",
              message: "Repository cleanup work requires an owned cleanup transfer.",
            },
            `normal enqueue must reserve ${scenario.name}`,
          );
          await insertRawQueueWork(pool, input, 2);
        }
        const [valid] = cases;
        const [firstAgentId] = agents;
        const [firstRevisionId] = revisions;
        assert.ok(valid && firstAgentId && firstRevisionId);
        assert.equal(
          isRepositoryCleanupWork({
            ...revisionWork(namespaceId, valid.key, firstAgentId, firstRevisionId),
            agentTarget: "stopped",
          }),
          false,
        );
        assert.equal(
          isRepositoryCleanupWork({ idempotencyKey: valid.key, revisionId: firstRevisionId }),
          false,
        );
        const claimedKeys: string[] = [];
        for (let index = 0; index < 200; index += 1) {
          const claim = await queue.claim();
          if (!claim) {
            break;
          }
          if (cases.some((scenario) => scenario.key === claim.idempotencyKey)) {
            claimedKeys.push(claim.idempotencyKey);
          }
          await queue.complete(claim);
        }
        assert.deepEqual(
          claimedKeys,
          [valid.key],
          "only the complete matching cleanup identity bypasses exhaustion",
        );
        await queue.recoverStale();
        for (const scenario of cases) {
          assert.equal(
            (await readQueueRow(pool, scenario.key))?.state,
            scenario.valid ? "succeeded" : "failed_permanent",
            scenario.name,
          );
        }
      },
    );
  }

  for (const transition of ["fail", "retry", "expired claim", "exhausted queued"] as const) {
    test(
      `Agent deletion retains exact cleanup obligations on ${transition}`,
      requiresPostgres,
      async (context) => {
        const { pool, queue, WorkClaimLostError } = await dependencies(context, { maxAttempts: 1 });
        const { namespaceId, agents } = await createResources(pool, 2);
        const [agentId, otherAgentId] = agents;
        assert.ok(agentId);
        assert.ok(otherAgentId);
        const owner = await createRepositoryRevision(pool, namespaceId, agentId, [
          "opening",
          "open",
          "invalidated",
          "disposed",
        ]);
        const sibling = await createRepositoryRevision(pool, namespaceId, otherAgentId, [
          "closing",
        ]);
        const sourceKey = `agent-delete-cleanup:${randomUUID()}`;
        await queue.enqueue({
          namespaceId,
          agentId,
          agentTarget: "deleted",
          idempotencyKey: sourceKey,
          actorId: "principal-deletion",
          availableAt: new Date(0),
        });
        // A revision admitted after this Work was created cannot inherit its cleanup authority.
        const later = await createRepositoryRevision(pool, namespaceId, agentId, ["closing"], 2);
        // The sibling Agent is being deleted too, so only Agent identity refuses its cleanup.
        await pool.query<never>(
          "UPDATE occ.agents SET desired_runtime_state = 'stopped', status = 'deleting' WHERE id = ANY($1)",
          [agents],
        );
        const before = await readRepositoryAttempts(pool, owner.revisionId);
        const siblingBefore = await readRepositoryAttempts(pool, sibling.revisionId);
        const laterBefore = await readRepositoryAttempts(pool, later.revisionId);
        let claim: ClaimedWork | undefined;
        if (transition === "exhausted queued") {
          await pool.query<never>(
            "UPDATE occ.controller_work SET attempt_count = 1 WHERE idempotency_key = $1",
            [sourceKey],
          );
          await queue.recoverStale();
        } else {
          claim = await claimExpected(queue, sourceKey);
          await assert.rejects(
            queue.enqueueRepositoryCleanup({ ...claim, claimToken: randomUUID() }, owner),
            WorkClaimLostError,
          );
          await assert.rejects(queue.enqueueRepositoryCleanup(claim, sibling), cleanupNotOwned);
          await assert.rejects(queue.enqueueRepositoryCleanup(claim, later), cleanupNotOwned);
          // Teardown fails before finalization; unresolved sessions no longer
          // prevent successful finalization from deleting this Agent.
          if (transition === "expired claim") {
            await expireWorkLease(pool, sourceKey);
            await queue.recoverStale();
          } else {
            await queue[transition](claim, { code: "DELETE_FAILED" });
          }
        }
        assert.equal((await readQueueRow(pool, sourceKey))?.state, "failed_permanent");
        const after = await readRepositoryAttempts(pool, owner.revisionId);
        assert.deepEqual(
          after.map(({ phase }) => phase),
          ["closing", "closing", "invalidated", "disposed"],
        );
        assert.deepEqual(
          after.map(({ phase: _phase, ...identity }) => identity),
          before.map(({ phase: _phase, ...identity }) => identity),
        );
        assert.deepEqual(await readRepositoryAttempts(pool, sibling.revisionId), siblingBefore);
        assert.deepEqual(await readRepositoryAttempts(pool, later.revisionId), laterBefore);
        const cleanup = await readQueueRow(pool, repositoryCleanupKey(owner.revisionId, sourceKey));
        assert.ok(cleanup);
        assert.equal(cleanup.actor_id, "principal-deletion");
        assert.equal(cleanup.state, "queued");
        assert.equal(
          await readQueueRow(pool, repositoryCleanupKey(later.revisionId, sourceKey)),
          undefined,
        );
        if (claim !== undefined) {
          await assert.rejects(
            queue.completeAgentDeletion(claim, namespaceId, agentId),
            WorkClaimLostError,
          );
        }
        await completeCleanupWork(queue, owner.revisionId, sourceKey);
      },
    );
  }

  test(
    "deleted Agent repository cleanup audit retains the exact revision target",
    requiresPostgres,
    async (context) => {
      const { pool, queue } = await dependencies(context);
      const {
        namespaceId,
        agents: [agentId],
      } = await createResources(pool);
      assert.ok(agentId);
      const owner = await createRepositoryRevision(pool, namespaceId, agentId, ["closing"]);
      const sourceKey = `agent-delete-cleanup-audit:${randomUUID()}`;
      const actorId = `principal-deletion-audit-${randomUUID()}`;
      await queue.enqueue({
        namespaceId,
        agentId,
        agentTarget: "deleted",
        idempotencyKey: sourceKey,
        actorId,
        availableAt: new Date(0),
      });
      await pool.query<never>(
        "UPDATE occ.agents SET desired_runtime_state = 'stopped', status = 'deleting' WHERE id = $1",
        [agentId],
      );
      const deletion = await claimExpected(queue, sourceKey);
      const registered = await queue.enqueueRepositoryCleanup(deletion, owner);
      assert.ok(registered);
      assert.equal(registered.agentId, agentId);
      assert.equal(registered.revisionId, owner.revisionId);

      assert.equal(await queue.completeAgentDeletion(deletion, namespaceId, agentId), "completed");
      const removedOwner = await pool.query<{ agent_exists: boolean; revision_exists: boolean }>(
        `SELECT
         EXISTS (SELECT 1 FROM occ.agents WHERE namespace_id = $1 AND id = $2) AS agent_exists,
         EXISTS (SELECT 1 FROM occ.agent_revisions WHERE namespace_id = $1 AND id = $3) AS revision_exists`,
        [namespaceId, agentId, owner.revisionId],
      );
      assert.deepEqual(removedOwner.rows[0], { agent_exists: false, revision_exists: false });

      const detached = await pool.query<{ agent_id: string | null; revision_id: string | null }>(
        `SELECT agent_id, revision_id
       FROM occ.controller_work
       WHERE idempotency_key = $1`,
        [registered.idempotencyKey],
      );
      assert.deepEqual(detached.rows, [{ agent_id: null, revision_id: null }]);

      const cleanup = await claimExpected(queue, registered.idempotencyKey);
      assert.equal(cleanup.agentId, undefined);
      assert.equal(cleanup.revisionId, undefined);
      await queue.defer(cleanup, { code: "REPOSITORY_CLEANUP_PENDING" });
      const evidence = await pool.query<{
        namespace_id: string;
        resource_kind: string;
        resource_id: string;
        actor_id: string;
        outcome: string;
        reason: string | null;
      }>(
        `SELECT namespace_id, resource_kind, resource_id, actor_id, outcome,
              details->>'reasonCode' AS reason
       FROM occ.audit_events
       WHERE actor_id = $1
         AND action = 'reconcile'
         AND details->>'reasonCode' = 'REPOSITORY_CLEANUP_PENDING'`,
        [actorId],
      );
      assert.deepEqual(evidence.rows, [
        {
          namespace_id: namespaceId,
          resource_kind: "agent_revision",
          resource_id: owner.revisionId,
          actor_id: actorId,
          outcome: "success",
          reason: "REPOSITORY_CLEANUP_PENDING",
        },
      ]);
      await pool.query<never>(
        "UPDATE occ.controller_work SET available_at = 'infinity' WHERE idempotency_key = $1",
        [registered.idempotencyKey],
      );
    },
  );
}
