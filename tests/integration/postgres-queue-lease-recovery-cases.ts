import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Pool, PoolClient } from "pg";
import type { NamespaceStatus } from "@openclaw-enterprise/contracts";
import type {
  ClaimedWork,
  ControllerWorkState,
  PostgresWorkQueue,
  RecoverySummary,
} from "../../packages/occ/src/state/postgres-work-queue.ts";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import {
  deferWork,
  expireWorkLease,
  makeWorkDue,
} from "../helpers/postgres-worker-revision-queue.ts";
import {
  claimExpected,
  createNamespace,
  createQueueRevision,
  createResources,
  dependencies,
  namespaceWork,
  revisionWork,
} from "./postgres-queue-recovery-fixture.ts";

interface WorkStateRow {
  state: ControllerWorkState;
  attempt_count: number;
  reason_code: string | null;
}

interface ExhaustedNamespaceSnapshot {
  status: NamespaceStatus;
  state: ControllerWorkState;
  claim_token: string | null;
  lease_expires_at: Date | null;
  completed_at: Date | null;
  evidence: number;
  final_evidence: number;
}

interface AuditEvidenceRow {
  reason: string | null;
  final: boolean | null;
}

// Claims and completes Work, including any unrelated leftover Work, until every
// expected key was handed out, in whatever order the queue picks. Use it for keys
// whose relative claim order the test does not pin: claimExpected completes the
// Work it skips, so claiming such keys one by one fails whenever the queue hands
// out a later key first.
async function completeExpected(queue: PostgresWorkQueue, idempotencyKeys: readonly string[]) {
  const pending = new Set(idempotencyKeys);
  for (let index = 0; index < 200 && pending.size > 0; index += 1) {
    const claim = await queue.claim();
    if (!claim) {
      break;
    }
    pending.delete(claim.idempotencyKey);
    await queue.complete(claim);
  }
  assert.deepEqual([...pending], [], "The durable queue did not expose all expected work.");
}

export function registerQueueLeaseRecoveryCases() {
  test(
    "Namespace creation and deletion retain distinct durable work targets",
    requiresPostgres,
    async (context) => {
      const { pool, queue, PostgresWorkQueue } = await dependencies(context);
      const { namespaceId } = await createResources(pool, 0);
      const ready = namespaceWork(namespaceId, `namespace:${namespaceId}:reconcile:ready`);
      const deleted = namespaceWork(
        namespaceId,
        `namespace:${namespaceId}:reconcile:deleted`,
        new Date(0),
        "deleted",
      );

      assert.equal((await queue.enqueue(ready)).namespaceTarget, "ready");
      assert.equal((await queue.enqueue(deleted)).namespaceTarget, "deleted");
      const persisted = await pool.query<{
        idempotency_key: string;
        namespace_target: "ready" | "deleted" | null;
      }>(
        `SELECT idempotency_key, namespace_target
         FROM occ.controller_work
         WHERE idempotency_key = ANY($1::text[])
         ORDER BY namespace_target`,
        [[ready.idempotencyKey, deleted.idempotencyKey]],
      );
      assert.deepEqual(
        persisted.rows.map(({ namespace_target }) => namespace_target),
        ["deleted", "ready"],
      );

      const restarted = new PostgresWorkQueue(pool);
      assert.equal((await restarted.enqueue(ready)).namespaceTarget, "ready");
      assert.equal((await restarted.enqueue(deleted)).namespaceTarget, "deleted");
    },
  );

  test(
    "durable work deduplicates exact ownership and rejects actor or owner collisions",
    requiresPostgres,
    async (context) => {
      const { pool, queue } = await dependencies(context);
      const {
        namespaceId,
        agents: [firstAgent, secondAgent],
      } = await createResources(pool, 2);
      assert.ok(firstAgent && secondAgent);
      const revisionId = await createQueueRevision(pool, namespaceId, firstAgent);
      const otherRevisionId = await createQueueRevision(pool, namespaceId, secondAgent);
      const idempotencyKey = `queue-dedupe:${randomUUID()}`;
      const original = revisionWork(namespaceId, idempotencyKey, firstAgent, revisionId);

      const first = await queue.enqueue(original);
      const duplicate = await queue.enqueue(original);
      assert.deepEqual(duplicate, first);

      await assert.rejects(queue.enqueue({ ...original, actorId: "principal-different" }), {
        name: "ResourceConflictError",
      });
      await assert.rejects(
        queue.enqueue({ ...original, agentId: secondAgent, revisionId: otherRevisionId }),
        { name: "ResourceConflictError" },
      );

      const claim = await claimExpected(queue, idempotencyKey);
      assert.equal(claim.actorId, original.actorId);
      assert.equal(claim.attemptCount, 1);
      await queue.complete(claim);

      const terminal = await queue.enqueue(original);
      assert.equal(terminal.state, "succeeded");
      assert.equal(terminal.attemptCount, 1);
    },
  );

  test(
    "terminal revision work stores safe outcome data and plugin warnings",
    requiresPostgres,
    async (context) => {
      const { pool, queue } = await dependencies(context);
      const {
        namespaceId,
        agents: [firstAgent],
      } = await createResources(pool);
      assert.ok(firstAgent);
      const revisionId = await createQueueRevision(pool, namespaceId, firstAgent);
      const idempotencyKey = `agent_revision:${revisionId}:reconcile`;
      await queue.enqueue(revisionWork(namespaceId, idempotencyKey, firstAgent, revisionId));

      const claim = await claimExpected(queue, idempotencyKey);
      // Result payloads remain allowlisted even though success and failure now
      // share one column. Reject malformed warnings before completing the claim.
      for (const resultData of [
        { warnings: [{ code: "UNKNOWN_WARNING", pluginId: "occ-plugin:diffs" }] },
        { warnings: [{ code: "PLUGIN_INSTALL_FAILED", pluginId: "invalid plugin id" }] },
        {
          warnings: [
            { code: "PLUGIN_INSTALL_FAILED", pluginId: "occ-plugin:diffs", raw: "unsafe" },
          ],
        },
        {
          warnings: [
            { code: "PLUGIN_INSTALL_FAILED", pluginId: "occ-plugin:diffs" },
            { code: "PLUGIN_AUTH_REQUIRED", pluginId: "occ-plugin:diffs" },
          ],
        },
        { warnings: [], raw: "unsafe" },
        { timeoutMs: 1 },
      ]) {
        await assert.rejects(queue.complete(claim, { code: "REVISION_ACTIVATED", resultData }), {
          name: "ScopeViolationError",
        });
      }
      const warnings = [
        {
          code: "PLUGIN_AUTH_REQUIRED",
          pluginId: "codex-plugin:calendar@openai-curated-remote",
        },
        { code: "PLUGIN_INSTALL_FAILED", pluginId: "occ-plugin:diffs" },
      ];
      await queue.complete(claim, {
        code: "REVISION_ACTIVATED",
        resultData: { warnings },
      });

      // Reload through a fresh queue: mixed plugin outcomes must survive completion
      // without replacing the overall successful deployment reason.
      const { PostgresWorkQueue } =
        await import("../../packages/occ/src/state/postgres-work-queue.ts");
      const terminal = await new PostgresWorkQueue(pool).findWork(idempotencyKey);
      assert.ok(terminal);
      assert.equal(terminal.state, "succeeded");
      assert.equal(terminal.reasonCode, "REVISION_ACTIVATED");
      assert.deepEqual(terminal.resultData, { warnings });
      // PostgreSQL independently rejects unsafe persisted shapes, even when a
      // writer bypasses the queue's result validation.
      for (const resultData of [
        { warnings: {} },
        { warnings: [null] },
        { warnings: [{ code: "UNKNOWN_WARNING", pluginId: "occ-plugin:diffs" }] },
        { warnings: [{ code: "PLUGIN_INSTALL_FAILED", pluginId: "invalid plugin id" }] },
        {
          warnings: [
            { code: "PLUGIN_INSTALL_FAILED", pluginId: "occ-plugin:diffs", raw: "unsafe" },
          ],
        },
        { warnings: [], raw: "unsafe" },
      ]) {
        await assert.rejects(
          pool.query<never>(
            `UPDATE occ.controller_work SET result_data = $2::jsonb WHERE idempotency_key = $1`,
            [idempotencyKey, JSON.stringify(resultData)],
          ),
          { code: "23514" },
        );
      }
    },
  );

  test(
    "terminal metadata is allowlisted and retry exhaustion preserves a safe reason",
    requiresPostgres,
    async (context) => {
      const { pool, queue } = await dependencies(context, { maxAttempts: 1 });
      const {
        namespaceId,
        agents: [firstAgent, secondAgent],
      } = await createResources(pool, 2);
      assert.ok(firstAgent && secondAgent);
      const invalidRevisionId = await createQueueRevision(pool, namespaceId, firstAgent);
      const exhaustedRevisionId = await createQueueRevision(pool, namespaceId, secondAgent);
      const invalidKey = `agent_revision:${invalidRevisionId}:reconcile`;
      const exhaustedKey = `agent_revision:${exhaustedRevisionId}:reconcile`;
      await queue.enqueue(revisionWork(namespaceId, invalidKey, firstAgent, invalidRevisionId));
      await queue.enqueue(
        revisionWork(namespaceId, exhaustedKey, secondAgent, exhaustedRevisionId),
      );

      const invalidClaim = await claimExpected(queue, invalidKey);
      await assert.rejects(
        queue.fail(invalidClaim, { code: "DEPENDENCY_UNAVAILABLE", data: { raw: "unsafe" } }),
        { name: "ScopeViolationError" },
      );
      await assert.rejects(
        queue.fail(invalidClaim, {
          code: "PLUGIN_INSTALL_FAILED",
          data: { pluginId: "codex-plugin:calendar@openai-curated-remote", raw: "unsafe" },
        }),
        { name: "ScopeViolationError" },
      );
      for (const data of [
        { timeoutMs: 900_000, runtimeFailure: null },
        { timeoutMs: 900_000, runtimeFailure: { component: "gateway" } },
        {
          timeoutMs: 900_000,
          runtimeFailure: {
            component: "gateway",
            check: "readyz",
            checkedAt: "2026-02-30T20:30:00.000Z",
            code: "STARTUP_FAILED",
          },
        },
        {
          timeoutMs: 900_000,
          runtimeFailure: {
            component: "gateway",
            check: "readyz",
            checkedAt: "2026-09-19T20:30:00.000Z",
            code: "STARTUP_FAILED",
            raw: "unsafe",
          },
        },
      ]) {
        await assert.rejects(
          queue.fail(invalidClaim, { code: "CONVERGENCE_DEADLINE_EXCEEDED", data }),
          { name: "ScopeViolationError" },
        );
      }
      const stillClaimed = await queue.findWork(invalidKey);
      assert.ok(stillClaimed);
      assert.equal(stillClaimed.state, "claimed");
      const runtimeFailure = {
        component: "gateway",
        check: "readyz",
        checkedAt: "2026-09-19T20:30:00.000Z",
        code: "STARTUP_FAILED",
      };
      await queue.fail(invalidClaim, {
        code: "CONVERGENCE_DEADLINE_EXCEEDED",
        data: { timeoutMs: 900_000, runtimeFailure },
      });
      const deadline = await queue.findWork(invalidKey);
      assert.ok(deadline);
      assert.equal(deadline.state, "failed_permanent");
      // A check and code outside the runtime's vocabulary are recorded as UNRECOGNIZED, never as
      // served: a provider-owned Harness answers from inside its Sandbox (finding 1660).
      assert.deepEqual(deadline.resultData, {
        timeoutMs: 900_000,
        runtimeFailure: { ...runtimeFailure, check: "UNRECOGNIZED", code: "UNRECOGNIZED" },
      });
      // A permanent failure ends the work item on its first attempt; its evidence says so.
      const deadlineEvidence = await pool.query<{ final: boolean | null }>(
        `SELECT details->'final' AS final FROM occ.audit_events
         WHERE action = 'reconcile' AND details->>'workId' = $1`,
        [invalidKey],
      );
      assert.deepEqual(deadlineEvidence.rows, [{ final: true }]);
      for (const resultData of [
        { timeoutMs: 900_000, raw: "unsafe" },
        { timeoutMs: 0, runtimeFailure },
        {
          timeoutMs: 900_000,
          runtimeFailure: { ...runtimeFailure, checkedAt: "2026-02-30T20:30:00.000Z" },
        },
        { timeoutMs: 900_000, runtimeFailure: { ...runtimeFailure, raw: "unsafe" } },
      ]) {
        await assert.rejects(
          pool.query<never>(
            `UPDATE occ.controller_work SET result_data = $2::jsonb WHERE idempotency_key = $1`,
            [invalidKey, JSON.stringify(resultData)],
          ),
          { code: "23514" },
        );
      }

      const exhaustedClaim = await claimExpected(queue, exhaustedKey);
      await queue.retry(exhaustedClaim, {
        code: "DEPENDENCY_UNAVAILABLE",
      });
      const exhausted = await queue.findWork(exhaustedKey);
      assert.ok(exhausted);
      assert.equal(exhausted.state, "failed_permanent");
      assert.equal(exhausted.reasonCode, "DEPENDENCY_UNAVAILABLE");
    },
  );

  test(
    "Namespace convergence and admitted revision work share one durable queue with exact resource ownership",
    requiresPostgres,
    async (context) => {
      const { pool, queue } = await dependencies(context, { maxAttempts: 5 });
      const {
        namespaceId: revisionNamespaceId,
        agents: [firstAgent],
      } = await createResources(pool);
      assert.ok(firstAgent);
      const namespaceId = await createNamespace(pool, "provisioning");
      const revisionId = await createQueueRevision(pool, revisionNamespaceId, firstAgent);
      const prefix = `queue-current:${randomUUID()}`;
      const revisionKey = `${prefix}:revision`;
      const namespaceKey = `${prefix}:namespace`;
      const initialTotal = await queue.pending();

      await queue.enqueue(revisionWork(revisionNamespaceId, revisionKey, firstAgent, revisionId));
      await queue.enqueue(namespaceWork(namespaceId, namespaceKey, new Date(1)));

      assert.equal(await queue.pending(), initialTotal + 2);

      // Production revisions from ready tenants must not be filtered behind pending Namespace work.
      const revisionClaim = await queue.claim();
      assert.ok(revisionClaim);
      assert.equal(revisionClaim.idempotencyKey, revisionKey);
      assert.equal(revisionClaim.revisionId, revisionId);
      await queue.complete(revisionClaim);
      assert.equal(await queue.pending(), initialTotal + 1);

      // Pending Namespace convergence is progress evidence, not a worker failure budget.
      for (let observation = 0; observation < 7; observation += 1) {
        const namespaceClaim = await queue.claim();
        assert.ok(namespaceClaim);
        assert.equal(namespaceClaim.idempotencyKey, namespaceKey);
        assert.equal(namespaceClaim.attemptCount, 1);
        await queue.defer(namespaceClaim, { code: "NAMESPACE_INCOMPLETE" });

        const pending = await pool.query<Pick<WorkStateRow, "state" | "attempt_count">>(
          `SELECT state, attempt_count
           FROM occ.controller_work
           WHERE idempotency_key = $1`,
          [namespaceKey],
        );
        assert.deepEqual(pending.rows, [{ state: "queued", attempt_count: 0 }]);
      }

      const namespaceClaim = await claimExpected(queue, namespaceKey);
      await queue.complete(namespaceClaim);

      const completed = await pool.query<Pick<WorkStateRow, "state" | "attempt_count">>(
        `SELECT state, attempt_count
         FROM occ.controller_work
         WHERE idempotency_key = $1`,
        [namespaceKey],
      );
      assert.deepEqual(completed.rows, [{ state: "succeeded", attempt_count: 1 }]);

      const evidence = await pool.query<{ count: number }>(
        `SELECT count(*)::integer AS count
         FROM occ.audit_events
         WHERE namespace_id = $1 AND details->>'reasonCode' = 'NAMESPACE_INCOMPLETE'`,
        [namespaceId],
      );
      assert.deepEqual(evidence.rows, [{ count: 7 }]);

      assert.equal(await queue.pending(), initialTotal);
    },
  );

  // A serial worker's in-pass waits end early when other Work could be claimed
  // (D221). Only Work some worker could take now counts: not the caller's own
  // Agent's queued Work, which its claim holds back, and not delayed Work.
  test(
    "claimable work waiting matches what a worker could claim now",
    requiresPostgres,
    async (context) => {
      const { pool, queue } = await dependencies(context, { maxAttempts: 5 });
      const { namespaceId, agents } = await createResources(pool, 2);
      const [first, second] = agents;
      assert.ok(first && second);
      const prefix = `queue-claimable:${randomUUID()}`;
      for (let index = 0; index < 200; index += 1) {
        const leftover = await queue.claim();
        if (leftover === undefined) {
          break;
        }
        await queue.complete(leftover);
      }
      assert.equal(await queue.claimableWorkWaiting(), false);

      const firstRevision = await createQueueRevision(pool, namespaceId, first);
      await queue.enqueue(revisionWork(namespaceId, `${prefix}:first`, first, firstRevision));
      assert.equal(await queue.claimableWorkWaiting(), true);
      const firstClaim = await claimExpected(queue, `${prefix}:first`);
      assert.equal(await queue.claimableWorkWaiting(), false);

      // Same Agent: held back by the claim, so nothing is waiting for the worker.
      const firstSuccessor = await createQueueRevision(pool, namespaceId, first, 2);
      await queue.enqueue(
        revisionWork(namespaceId, `${prefix}:first-successor`, first, firstSuccessor),
      );
      assert.equal(await queue.claimableWorkWaiting(), false);

      // Another Agent's Work counts once it is due.
      const secondRevision = await createQueueRevision(pool, namespaceId, second);
      await queue.enqueue(
        revisionWork(
          namespaceId,
          `${prefix}:second`,
          second,
          secondRevision,
          new Date(Date.now() + 3_600_000),
        ),
      );
      assert.equal(await queue.claimableWorkWaiting(), false);
      await makeWorkDue(pool, `${prefix}:second`);
      assert.equal(await queue.claimableWorkWaiting(), true);
      // A draining stop names the stops that yielded during their own drain (finding 1093): they
      // do not count, while any other claimable Work still does.
      assert.equal(await queue.claimableWorkWaiting({ except: [`${prefix}:second`] }), false);
      assert.equal(
        await queue.claimableWorkWaiting({ except: [`${prefix}:first-successor`] }),
        true,
      );
      assert.equal(await queue.claimableWorkWaiting({ except: [] }), true);
      // @ts-expect-error Exercise runtime validation of a non-string excluded key.
      await assert.rejects(queue.claimableWorkWaiting({ except: [7] }), /keys are invalid/);

      await queue.complete(firstClaim);
      await queue.complete(await claimExpected(queue, `${prefix}:first-successor`));
      await queue.complete(await claimExpected(queue, `${prefix}:second`));
      assert.equal(await queue.claimableWorkWaiting(), false);
    },
  );

  test(
    "stale and exhausted recovery includes admitted revisions and Namespace lifecycle work",
    requiresPostgres,
    async (context) => {
      const { pool, queue } = await dependencies(context, { maxAttempts: 2 });
      const {
        namespaceId: revisionNamespaceId,
        agents: [firstAgent, secondAgent],
      } = await createResources(pool, 2);
      assert.ok(firstAgent && secondAgent);
      const namespaceId = await createNamespace(pool, "provisioning");
      const staleRevisionId = await createQueueRevision(pool, revisionNamespaceId, firstAgent);
      const exhaustedRevisionId = await createQueueRevision(pool, revisionNamespaceId, secondAgent);
      const prefix = `queue-current-recovery:${randomUUID()}`;
      const staleRevisionKey = `${prefix}:stale-revision`;
      const exhaustedRevisionKey = `${prefix}:exhausted-revision`;
      const namespaceKey = `${prefix}:namespace`;

      await queue.enqueue(
        revisionWork(revisionNamespaceId, staleRevisionKey, firstAgent, staleRevisionId),
      );
      const staleRevision = await queue.claim();
      assert.ok(staleRevision);
      assert.equal(staleRevision.idempotencyKey, staleRevisionKey);

      await queue.enqueue(namespaceWork(namespaceId, namespaceKey, new Date(1)));
      const staleNamespace = await queue.claim();
      assert.ok(staleNamespace);
      assert.equal(staleNamespace.idempotencyKey, namespaceKey);
      await queue.enqueue(
        revisionWork(
          revisionNamespaceId,
          exhaustedRevisionKey,
          secondAgent,
          exhaustedRevisionId,
          new Date(2),
        ),
      );

      await expireWorkLease(pool, [staleRevisionKey, namespaceKey]);
      await pool.query<never>(
        `UPDATE occ.controller_work
         SET attempt_count = 2
         WHERE idempotency_key = ANY($1::text[])`,
        [[exhaustedRevisionKey]],
      );

      const recovery = await queue.recoverStale({ limit: 10 });
      // Recovery scans the shared queue, so other integration scenarios may contribute to its totals.
      assert.ok(
        recovery.recovered >= 2,
        "the exact stale revision and Namespace must be recovered",
      );
      assert.ok(recovery.requeued >= 2, "the exact stale revision and Namespace must be requeued");
      assert.ok(
        recovery.failedPermanent >= 1,
        "the exact exhausted revision must fail permanently",
      );
      assert.ok(recovery.exhaustedQueued >= 1, "the exact exhausted revision must be counted");

      // Retryable provisioning remains pending; exhausted Agent work must not
      // change its already-ready tenant's lifecycle status.
      assert.equal(
        (
          await pool.query<{ status: NamespaceStatus }>(
            "SELECT status FROM occ.namespaces WHERE id = $1",
            [namespaceId],
          )
        ).rows[0]?.status,
        "provisioning",
      );
      assert.equal(
        (
          await pool.query<{ status: NamespaceStatus }>(
            "SELECT status FROM occ.namespaces WHERE id = $1",
            [revisionNamespaceId],
          )
        ).rows[0]?.status,
        "ready",
      );

      const recovered = await pool.query<
        Pick<WorkStateRow, "state" | "attempt_count"> & {
          idempotency_key: string;
          claim_token: string | null;
        }
      >(
        `SELECT idempotency_key, state, attempt_count, claim_token
         FROM occ.controller_work
         WHERE idempotency_key = ANY($1::text[])
         ORDER BY idempotency_key`,
        [[staleRevisionKey, exhaustedRevisionKey, namespaceKey]],
      );
      assert.deepEqual(recovered.rows, [
        {
          idempotency_key: exhaustedRevisionKey,
          state: "failed_permanent",
          attempt_count: 2,
          claim_token: null,
        },
        {
          idempotency_key: namespaceKey,
          state: "queued",
          attempt_count: 1,
          claim_token: null,
        },
        {
          idempotency_key: staleRevisionKey,
          state: "queued",
          attempt_count: 1,
          claim_token: null,
        },
      ]);

      const revisionEvidence = await pool.query<{ id: string }>(
        `SELECT id FROM occ.audit_events
         WHERE resource_id = ANY($1::text[])
           AND details->>'reasonCode' IN ('LEASE_EXPIRED', 'MAX_ATTEMPTS_EXHAUSTED')`,
        [[staleRevisionId, exhaustedRevisionId]],
      );
      assert.equal(revisionEvidence.rowCount, 2);
      await pool.query<never>(
        `UPDATE occ.controller_work
         SET available_at = CASE WHEN idempotency_key = $1 THEN $3::timestamptz ELSE $4::timestamptz END
         WHERE idempotency_key = ANY($2::text[])`,
        [staleRevisionKey, [staleRevisionKey, namespaceKey], new Date(0), new Date(1)],
      );
      const recoveredRevision = await queue.claim();
      assert.ok(recoveredRevision);
      assert.equal(recoveredRevision.idempotencyKey, staleRevisionKey);
      assert.notEqual(recoveredRevision.claimToken, staleRevision.claimToken);
      await queue.complete(recoveredRevision);
      // A completion also ends the work, but only a failure that ends it has a final field.
      const completion = await pool.query<{ final: boolean }>(
        `SELECT details ? 'final' AS final FROM occ.audit_events
         WHERE resource_id = $1 AND details->>'reasonCode' = 'RECONCILE_SUCCEEDED'`,
        [staleRevisionId],
      );
      assert.deepEqual(completion.rows, [{ final: false }]);
      const recoveredNamespace = await queue.claim();
      assert.ok(recoveredNamespace);
      assert.equal(recoveredNamespace.idempotencyKey, namespaceKey);
      assert.notEqual(recoveredNamespace.claimToken, staleNamespace.claimToken);
      await queue.complete(recoveredNamespace);
    },
  );

  for (const source of ["claimed", "queued"]) {
    test(
      `exhausted ${source} recovery fails provisioning Namespaces atomically with work and audit`,
      requiresPostgres,
      async (context) => {
        const { pool, queue, PostgresWorkQueue, WorkClaimLostError } = await dependencies(context, {
          maxAttempts: 1,
        });
        const namespaceId = await createNamespace(pool, "provisioning");
        const idempotencyKey = `queue-exhausted-${source}:${randomUUID()}`;
        await queue.enqueue(namespaceWork(namespaceId, idempotencyKey));
        const claim = await claimExpected(queue, idempotencyKey);

        // A crashed final attempt leaves an expired claim. Queued exhaustion can
        // also occur when a restarted worker lowers its configured attempt budget.
        if (source === "claimed") {
          await expireWorkLease(pool, idempotencyKey);
        } else {
          const previousQueue = new PostgresWorkQueue(pool, { maxAttempts: 2, random: () => 0 });
          await previousQueue.retry(claim, { code: "DEPENDENCY_UNAVAILABLE" });
        }

        const reasonCode = source === "claimed" ? "LEASE_EXPIRED" : "MAX_ATTEMPTS_EXHAUSTED";
        // The recovery ends the work, so its evidence is final.
        const snapshot = async (client: Pool | PoolClient) => {
          const result = await client.query<ExhaustedNamespaceSnapshot>(
            `SELECT namespace.status, work.state, work.claim_token, work.lease_expires_at,
                    work.completed_at,
                    (SELECT count(*)::integer FROM occ.audit_events
                     WHERE resource_id = $2 AND details->>'reasonCode' = $3) AS evidence,
                    (SELECT count(*)::integer FROM occ.audit_events
                     WHERE resource_id = $2 AND details->>'reasonCode' = $3
                       AND details->'final' = 'true'::jsonb) AS final_evidence
             FROM occ.controller_work AS work
             JOIN occ.namespaces AS namespace ON namespace.id = work.namespace_id
             WHERE work.idempotency_key = $1`,
            [idempotencyKey, namespaceId, reasonCode],
          );
          const [row] = result.rows;
          assert.ok(row);
          return row;
        };
        const before = await snapshot(pool);
        const expected = {
          status: "failed",
          state: "failed_permanent",
          claim_token: null,
          lease_expires_at: null,
          evidence: 1,
          final_evidence: 1,
        };

        // Block Namespace publication to force a real server-side statement
        // failure. Standalone recovery must not commit work or audit first.
        const blocker = await pool.connect();
        const recoveryClient = await pool.connect();
        try {
          await blocker.query<never>("BEGIN");
          await blocker.query<{ id: string }>(
            "SELECT id FROM occ.namespaces WHERE id = $1 FOR UPDATE",
            [namespaceId],
          );
          await recoveryClient.query<never>("SET lock_timeout = '100ms'");
          await assert.rejects(
            new PostgresWorkQueue(recoveryClient, { maxAttempts: 1 }).recoverStale(),
            { code: "55P03" },
          );
          assert.deepEqual(await snapshot(pool), before);
        } finally {
          await blocker.query<never>("ROLLBACK");
          blocker.release();
          await recoveryClient.query<never>("RESET lock_timeout");
          recoveryClient.release();
        }

        // Recovery must participate in its caller's transaction: neither the
        // terminal work nor the Namespace failure may survive a rollback alone.
        const client = await pool.connect();
        try {
          await client.query<never>("BEGIN");
          await new PostgresWorkQueue(client, { maxAttempts: 1 }).recoverStale();
          const { completed_at, ...recovered } = await snapshot(client);
          assert.ok(completed_at instanceof Date);
          assert.deepEqual(recovered, expected);
        } finally {
          await client.query<never>("ROLLBACK");
          client.release();
        }
        assert.deepEqual(await snapshot(pool), before);

        // A standalone pool call must publish all three effects together as well.
        await queue.recoverStale();
        const { completed_at, ...recovered } = await snapshot(pool);
        assert.ok(completed_at instanceof Date);
        assert.deepEqual(recovered, expected);
        await assert.rejects(queue.complete(claim), WorkClaimLostError);
        await queue.recoverStale();
        assert.deepEqual(await snapshot(pool), { ...expected, completed_at });
      },
    );

    test(
      `exhausted ${source} recovery preserves ready and deleting Namespaces`,
      requiresPostgres,
      async (context) => {
        const { pool, queue, PostgresWorkQueue } = await dependencies(context, { maxAttempts: 1 });
        for (const [status, target, tombstone] of [
          ["ready", "ready", false],
          ["deleting", "ready", false],
          ["deleting", "deleted", false],
          ["deleting", "deleted", true],
        ] as const) {
          const namespaceId = await createNamespace(pool, status);
          const key = `queue-exhausted-guard:${randomUUID()}`;
          await queue.enqueue(namespaceWork(namespaceId, key, new Date(0), target));
          const claim = await claimExpected(queue, key);
          if (tombstone) {
            // Teardown may already have published its tombstone before recovery.
            await pool.query<never>(
              "UPDATE occ.namespaces SET deleted_at = clock_timestamp() WHERE id = $1",
              [namespaceId],
            );
          }
          if (source === "claimed") {
            await expireWorkLease(pool, key);
          } else {
            await new PostgresWorkQueue(pool, { maxAttempts: 2, random: () => 0 }).retry(claim, {
              code: "DEPENDENCY_UNAVAILABLE",
            });
          }
          await queue.recoverStale();
          const result = await pool.query<{
            status: NamespaceStatus;
            tombstone: boolean;
            state: ControllerWorkState;
          }>(
            `SELECT namespace.status, namespace.deleted_at IS NOT NULL AS tombstone, work.state
             FROM occ.namespaces AS namespace JOIN occ.controller_work AS work ON work.namespace_id = namespace.id
             WHERE work.idempotency_key = $1`,
            [key],
          );
          assert.deepEqual(result.rows, [{ status, tombstone, state: "failed_permanent" }]);
        }
      },
    );
  }

  test(
    "transaction-scoped queue fencing rolls back Namespace mutation, completion, and audit together",
    requiresPostgres,
    async (context) => {
      const { pool, queue, WorkClaimLostError } = await dependencies(context);
      const { PostgresPlatformState } =
        await import("../../packages/occ/src/state/postgres-state.ts");
      const state = new PostgresPlatformState(pool);
      const { namespaceId } = await createResources(pool, 0);
      const idempotencyKey = `queue-transaction-fence:${randomUUID()}`;
      await queue.enqueue(namespaceWork(namespaceId, idempotencyKey));
      const claim = await claimExpected(queue, idempotencyKey);

      await assert.rejects(
        state.transactWithQueue(async (unit, transactionQueue) => {
          assert.ok(await transactionQueue.heartbeat(claim));
          assert.equal((await unit.namespaces.lockNamespace(namespaceId))?.status, "ready");

          if ((await unit.installations.getInstallation()) === undefined) {
            await unit.installations.createInstallation({
              id: `ins_${randomUUID()}`,
              name: "Transaction rollback integration",
              createdAt: new Date().toISOString(),
            });
          }
          await unit.namespaces.transitionNamespaceStatus(namespaceId, "ready", "deleting");
          await transactionQueue.complete(claim);
          throw new Error("injected finalization failure");
        }),
        /injected finalization failure/,
      );

      const namespace = await pool.query<{ status: NamespaceStatus }>(
        "SELECT status FROM occ.namespaces WHERE id = $1",
        [namespaceId],
      );
      const persisted = await pool.query<{
        state: ControllerWorkState;
        claim_token: string | null;
      }>("SELECT state, claim_token FROM occ.controller_work WHERE idempotency_key = $1", [
        idempotencyKey,
      ]);
      const audit = await pool.query<{ id: string }>(
        `SELECT id FROM occ.audit_events
         WHERE resource_id = $1 AND details->>'reasonCode' = 'RECONCILE_SUCCEEDED'`,
        [namespaceId],
      );
      assert.equal(namespace.rows[0]?.status, "ready");
      assert.deepEqual(persisted.rows[0], { state: "claimed", claim_token: claim.claimToken });
      assert.equal(audit.rowCount, 0);

      await expireWorkLease(pool, idempotencyKey);
      let namespaceMutationReached = false;
      await assert.rejects(
        state.transactWithQueue(async (unit, transactionQueue) => {
          if (!(await transactionQueue.heartbeat(claim))) {
            throw new WorkClaimLostError();
          }
          namespaceMutationReached = true;
          await unit.namespaces.transitionNamespaceStatus(namespaceId, "ready", "deleting");
        }),
        WorkClaimLostError,
      );
      assert.equal(namespaceMutationReached, false);
      assert.equal(
        (
          await pool.query<{ status: NamespaceStatus }>(
            "SELECT status FROM occ.namespaces WHERE id = $1",
            [namespaceId],
          )
        ).rows[0]?.status,
        "ready",
      );
      await assert.rejects(
        queue.defer(claim, { code: "NAMESPACE_INCOMPLETE" }),
        WorkClaimLostError,
      );

      const stale = await pool.query<Pick<WorkStateRow, "state" | "attempt_count">>(
        `SELECT state, attempt_count
         FROM occ.controller_work
         WHERE idempotency_key = $1`,
        [idempotencyKey],
      );
      assert.deepEqual(stale.rows, [{ state: "claimed", attempt_count: 1 }]);

      await queue.recoverStale();
      await queue.complete(await claimExpected(queue, idempotencyKey));
    },
  );

  test(
    "concurrent claims exclude one Namespace lifecycle and one Agent while distinct Agents progress",
    requiresPostgres,
    async (context) => {
      const { pool, queue } = await dependencies(context);
      const {
        namespaceId,
        agents: [firstAgent, secondAgent],
      } = await createResources(pool, 2);
      assert.ok(firstAgent && secondAgent);
      const revisions = [
        await createQueueRevision(pool, namespaceId, firstAgent),
        await createQueueRevision(pool, namespaceId, firstAgent, 2),
        await createQueueRevision(pool, namespaceId, secondAgent),
      ] as const;
      const prefix = `queue-concurrency:${randomUUID()}`;
      const inputs = [
        namespaceWork(namespaceId, `${prefix}:namespace:first`, new Date(0)),
        namespaceWork(namespaceId, `${prefix}:namespace:second`, new Date(1)),
        revisionWork(
          namespaceId,
          `${prefix}:revision:first`,
          firstAgent,
          revisions[0],
          new Date(2),
        ),
        revisionWork(
          namespaceId,
          `${prefix}:revision:second`,
          firstAgent,
          revisions[1],
          new Date(3),
        ),
        revisionWork(
          namespaceId,
          `${prefix}:other-revision`,
          secondAgent,
          revisions[2],
          new Date(4),
        ),
      ];
      for (const input of inputs) {
        await queue.enqueue(input);
      }

      const allClaims = (await Promise.all(Array.from({ length: 8 }, () => queue.claim()))).filter(
        (claim) => claim !== undefined,
      );
      const claimed = allClaims.filter((claim) => claim.idempotencyKey.startsWith(prefix));
      assert.equal(claimed.length, 3);

      const roots = claimed.map(({ namespaceId: owner, agentId }) => agentId ?? owner);
      assert.equal(new Set(roots).size, roots.length);
      assert.deepEqual(new Set(roots), new Set([namespaceId, firstAgent, secondAgent]));

      const locked = await pool.query<{ owner: string; claims: number }>(
        `SELECT COALESCE(agent_id, namespace_id) AS owner, count(*)::integer AS claims
       FROM occ.controller_work
       WHERE state = 'claimed' AND idempotency_key LIKE $1
       GROUP BY COALESCE(agent_id, namespace_id)`,
        [`${prefix}:%`],
      );
      assert.equal(locked.rowCount, 3);
      assert.ok(locked.rows.every(({ claims }) => claims === 1));

      for (const claim of allClaims) {
        await queue.complete(claim);
      }
      const remaining = await pool.query<{ idempotency_key: string }>(
        `SELECT idempotency_key
       FROM occ.controller_work
       WHERE state = 'queued' AND idempotency_key LIKE $1`,
        [`${prefix}:%`],
      );
      assert.equal(remaining.rowCount, 2);
      await completeExpected(
        queue,
        remaining.rows.map(({ idempotency_key }) => idempotency_key),
      );
    },
  );

  test(
    "a restarted queue recovers expired claims, fences old tokens, and persists exhausted failures",
    requiresPostgres,
    async (context) => {
      const { pool, queue, PostgresWorkQueue, WorkClaimLostError } = await dependencies(context, {
        leaseDurationMs: 40,
        maxAttempts: 2,
      });
      const {
        namespaceId,
        agents: [firstAgent],
      } = await createResources(pool);
      assert.ok(firstAgent);
      const revisionId = await createQueueRevision(pool, namespaceId, firstAgent);
      const idempotencyKey = `queue-stale:${randomUUID()}`;
      const candidateWork = revisionWork(namespaceId, idempotencyKey, firstAgent, revisionId);
      await queue.enqueue(candidateWork);

      const original = await claimExpected(queue, idempotencyKey);
      assert.equal(original.attemptCount, 1);
      await delay(80);

      const restarted = new PostgresWorkQueue(pool, {
        leaseDurationMs: 1_000,
        maxAttempts: 2,
        random: () => 0,
      });
      assert.equal(await restarted.heartbeat(original), undefined);
      const recovery = await restarted.recoverStale();
      assert.ok(recovery.recovered >= 1);
      assert.ok(recovery.requeued >= 1);

      await assert.rejects(restarted.complete(original), WorkClaimLostError);

      const recovered = await claimExpected(restarted, idempotencyKey);
      assert.equal(recovered.attemptCount, 2);
      assert.notEqual(recovered.claimToken, original.claimToken);
      assert.equal(recovered.actorId, original.actorId);
      await restarted.retry(recovered, { code: "upstream_timeout", summary: "redacted" });

      const terminal = await pool.query<
        Pick<WorkStateRow, "state" | "attempt_count"> & {
          claim_token: string | null;
          lease_expires_at: Date | null;
          completed_at: Date | null;
        }
      >(
        `SELECT state, attempt_count, claim_token, lease_expires_at, completed_at
       FROM occ.controller_work
       WHERE idempotency_key = $1`,
        [idempotencyKey],
      );
      const [work] = terminal.rows;
      assert.ok(work);
      assert.equal(work.state, "failed_permanent");
      assert.equal(work.attempt_count, 2);
      assert.equal(work.claim_token, null);
      assert.equal(work.lease_expires_at, null);
      assert.notEqual(work.completed_at, null);

      const evidence = await pool.query<AuditEvidenceRow & { actor_id: string; outcome: string }>(
        `SELECT actor_id, outcome, details->>'reasonCode' AS reason, details->'final' AS final
       FROM occ.audit_events
       WHERE resource_id = $1
         AND details->>'reasonCode' IN ('LEASE_EXPIRED', 'UPSTREAM_TIMEOUT')
       ORDER BY occurred_at`,
        [revisionId],
      );
      // Only the failure that exhausts the attempt budget is final; the requeued lease loss is not.
      assert.deepEqual(
        evidence.rows.map(({ reason, final }) => [reason, final]),
        [
          ["LEASE_EXPIRED", null],
          ["UPSTREAM_TIMEOUT", true],
        ],
      );
      assert.ok(evidence.rows.every(({ actor_id }) => actor_id === original.actorId));
      assert.ok(evidence.rows.every(({ outcome }) => outcome === "failure"));

      const afterRestart = new PostgresWorkQueue(pool, { maxAttempts: 2, random: () => 0 });
      const receipt = await afterRestart.enqueue(candidateWork);
      assert.equal(receipt.state, "failed_permanent");
      assert.equal(receipt.attemptCount, 2);
    },
  );

  test(
    "batch stale recovery reports each expired claim once and writes one audit event per item",
    requiresPostgres,
    async (context) => {
      const { pool, queue, PostgresWorkQueue } = await dependencies(context, {
        leaseDurationMs: 35,
      });
      const { namespaceId, agents } = await createResources(pool, 2);
      const revisions = await Promise.all(
        agents.map((agentId) => createQueueRevision(pool, namespaceId, agentId)),
      );
      const prefix = `queue-batch:${randomUUID()}`;
      const keys = agents.map((agentId, index) => `${prefix}:${index}`);
      for (const [index, agentId] of agents.entries()) {
        const key = keys[index];
        const revisionId = revisions[index];
        assert.ok(key && revisionId);
        await queue.enqueue(revisionWork(namespaceId, key, agentId, revisionId, new Date(index)));
      }

      const claims: ClaimedWork[] = [];
      for (const key of keys) {
        claims.push(await claimExpected(queue, key));
      }
      assert.equal(claims.length, 2);
      await delay(75);

      const recovery = await queue.recoverStale({ limit: 10 });
      assert.equal(recovery.recovered, 2);
      assert.equal(recovery.requeued, 2);
      assert.equal(recovery.failedPermanent, 0);

      const audits = await pool.query<{ resource_id: string; events: number }>(
        `SELECT resource_id, count(*)::integer AS events
       FROM occ.audit_events
       WHERE resource_id = ANY($1::text[])
         AND details->>'reasonCode' = 'LEASE_EXPIRED'
       GROUP BY resource_id`,
        [revisions],
      );
      assert.equal(audits.rowCount, 2);
      assert.ok(audits.rows.every(({ events }) => events === 1));

      // Recovery requeues both items at clock_timestamp() in the UPDATE's row order,
      // which the query plan decides, so either may be claimable first.
      const cleanupQueue = new PostgresWorkQueue(pool, { leaseDurationMs: 1_000, random: () => 0 });
      await completeExpected(cleanupQueue, keys);
    },
  );
}

// Finding 1107: a deployment whose predecessor stop yielded (PREDECESSOR_STOP_YIELDED) removed the
// serving revision's Gateway; only a worker pass finishes that stop before the deployment fails.
// Recovery that would end it on its attempt limit without a pass requeues it once instead.
async function predecessorDeployment(
  pool: Pool,
  queue: PostgresWorkQueue,
  namespaceId: string,
  agentId: string,
  { yielded, failures }: { yielded: boolean; failures: number },
) {
  const revisionId = await createQueueRevision(pool, namespaceId, agentId);
  const key = `agent_revision:${revisionId}:reconcile`;
  await queue.enqueue(revisionWork(namespaceId, key, agentId, revisionId));
  if (yielded) {
    // The yield refunds its attempt; later passes fail for real.
    const claim = await claimExpected(queue, key);
    await queue.defer(claim, { code: "PREDECESSOR_STOP_YIELDED" }, { delayMs: 1 });
    await delay(5);
  }
  for (let failure = 0; failure < failures; failure += 1) {
    await queue.retry(await claimExpected(queue, key), { code: "DEPENDENCY_UNAVAILABLE" });
  }
  return key;
}

async function workState(pool: Pool, key: string) {
  const row = await pool.query<WorkStateRow>(
    `SELECT state, attempt_count, reason_code FROM occ.controller_work
     WHERE idempotency_key = $1`,
    [key],
  );
  const [work] = row.rows;
  assert.ok(work, `Missing controller work for ${key}`);
  return work;
}

async function workEvidence(pool: Pool, key: string) {
  const evidence = await pool.query<AuditEvidenceRow>(
    `SELECT details->>'reasonCode' AS reason, details->'final' AS final
     FROM occ.audit_events
     WHERE kind = 'mutation' AND action = 'reconcile' AND details->>'workId' = $1
     ORDER BY occurred_at, id`,
    [key],
  );
  return evidence.rows.map(({ reason, final }) => [reason, final]);
}

const failedOn = (recovery: RecoverySummary, key: string) =>
  recovery.failed.some(({ idempotencyKey }) => idempotencyKey === key);

export function registerPredecessorStopRecoveryCases() {
  test(
    "an expired last claim of a deployment whose predecessor stop yielded gets one more attempt, once",
    requiresPostgres,
    async (context) => {
      const { pool, queue } = await dependencies(context, { leaseDurationMs: 200, maxAttempts: 2 });
      const {
        namespaceId,
        agents: [firstAgent, secondAgent, thirdAgent],
      } = await createResources(pool, 3);
      assert.ok(firstAgent && secondAgent && thirdAgent);
      const crash = async (key: string) => {
        const claim = await claimExpected(queue, key);
        assert.equal(claim.attemptCount, 2);
        await delay(300);
        return queue.recoverStale({ limit: 1_000 });
      };
      const yielded = await predecessorDeployment(pool, queue, namespaceId, firstAgent, {
        yielded: true,
        failures: 1,
      });

      // Invariant: such a deployment never ends in SQL on its first limit; it is requeued with one
      // more attempt, so a worker pass finishes the predecessor's stop (or deploys).
      let recovery = await crash(yielded);
      assert.ok(!failedOn(recovery, yielded));
      assert.ok(recovery.requeued >= 1);
      assert.deepEqual(await workState(pool, yielded), {
        state: "queued",
        attempt_count: 1,
        reason_code: null,
      });
      assert.deepEqual((await workEvidence(pool, yielded)).slice(-1), [
        ["PREDECESSOR_STOP_RECOVERY", null],
      ]);
      // Bounded: the extra attempt is granted once, so a pass that keeps crashing ends as before.
      recovery = await crash(yielded);
      assert.ok(failedOn(recovery, yielded));
      assert.deepEqual(await workState(pool, yielded), {
        state: "failed_permanent",
        attempt_count: 2,
        reason_code: "LEASE_EXPIRED",
      });
      assert.deepEqual((await workEvidence(pool, yielded)).slice(-2), [
        ["PREDECESSOR_STOP_RECOVERY", null],
        ["LEASE_EXPIRED", true],
      ]);

      // A deployment that already had the activation recovery's extra attempt (its pointer was
      // published, so its predecessors were stopped) does not get this one too.
      const activated = await predecessorDeployment(pool, queue, namespaceId, secondAgent, {
        yielded: true,
        failures: 1,
      });
      await pool.query<never>(
        `INSERT INTO occ.audit_events (id, occurred_at, kind, actor_id, action, namespace_id,
           resource_kind, resource_id, outcome, details)
         SELECT 'aud_' || gen_random_uuid()::text, clock_timestamp(), 'mutation', actor_id,
           'reconcile', namespace_id, 'agent_revision', revision_id, 'failure',
           jsonb_build_object('reasonCode', 'ACTIVE_REVISION_RECOVERY', 'workId', idempotency_key)
         FROM occ.controller_work WHERE idempotency_key = $1`,
        [activated],
      );
      assert.ok(failedOn(await crash(activated), activated));
      assert.equal((await workState(pool, activated)).reason_code, "LEASE_EXPIRED");

      // Work without that evidence never started a predecessor stop: it fails as before.
      const plain = await predecessorDeployment(pool, queue, namespaceId, thirdAgent, {
        yielded: false,
        failures: 1,
      });
      assert.ok(failedOn(await crash(plain), plain));
      assert.deepEqual(await workState(pool, plain), {
        state: "failed_permanent",
        attempt_count: 2,
        reason_code: "LEASE_EXPIRED",
      });
      assert.deepEqual(await workEvidence(pool, plain), [
        ["DEPENDENCY_UNAVAILABLE", null],
        ["LEASE_EXPIRED", true],
      ]);
    },
  );

  test(
    "queued exhaustion of a deployment whose predecessor stop yielded gets one more attempt, once",
    requiresPostgres,
    async (context) => {
      // A lower attempt limit after a restart leaves queued work at the limit.
      const { pool, queue, PostgresWorkQueue } = await dependencies(context, { maxAttempts: 3 });
      const {
        namespaceId,
        agents: [firstAgent, secondAgent],
      } = await createResources(pool, 2);
      assert.ok(firstAgent && secondAgent);
      const defer = (key: string) => deferWork(pool, key);
      const yielded = await predecessorDeployment(pool, queue, namespaceId, firstAgent, {
        yielded: true,
        failures: 2,
      });
      await defer(yielded);
      const plain = await predecessorDeployment(pool, queue, namespaceId, secondAgent, {
        yielded: false,
        failures: 2,
      });
      await defer(plain);
      const restarted = new PostgresWorkQueue(pool, { maxAttempts: 2, random: () => 0 });
      // Parked rows sort last in the sweep; the limit keeps other tests' leftovers from crowding
      // them out.
      const recovery = await restarted.recoverStale({ limit: 1_000 });
      assert.ok(!failedOn(recovery, yielded));
      assert.ok(failedOn(recovery, plain));
      assert.deepEqual(await workState(pool, yielded), {
        state: "queued",
        attempt_count: 1,
        reason_code: null,
      });
      assert.deepEqual((await workEvidence(pool, yielded)).slice(-1), [
        ["PREDECESSOR_STOP_RECOVERY", null],
      ]);
      assert.deepEqual(await workState(pool, plain), {
        state: "failed_permanent",
        attempt_count: 2,
        reason_code: "MAX_ATTEMPTS_EXHAUSTED",
      });
      // Once: back at the limit, it ends as before.
      await pool.query<never>(
        "UPDATE occ.controller_work SET attempt_count = 2 WHERE idempotency_key = $1",
        [yielded],
      );
      assert.ok(failedOn(await restarted.recoverStale({ limit: 1_000 }), yielded));
      assert.deepEqual(await workState(pool, yielded), {
        state: "failed_permanent",
        attempt_count: 2,
        reason_code: "MAX_ATTEMPTS_EXHAUSTED",
      });
    },
  );
}
