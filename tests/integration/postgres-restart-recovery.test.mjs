import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const requiresPostgres = {
  skip: databaseUrl ? false : "Set OCC_TEST_DATABASE_URL to run real PostgreSQL integration tests.",
};

async function dependencies(context, options = {}) {
  const [{ Pool }, queueModule] = await Promise.all([
    import("pg"),
    import("../../packages/occ/src/state/postgres-work-queue.ts"),
  ]);
  const pool = new Pool({ connectionString: databaseUrl, max: 12 });
  context.after(() => pool.end());
  const queue = new queueModule.PostgresWorkQueue(pool, {
    claimRaceRetries: 16,
    random: () => 0,
    ...options,
  });
  return { pool, queue, ...queueModule };
}

async function createNamespace(pool, status = "ready") {
  const namespaceId = `ns_${randomUUID()}`;
  await pool.query(
    `INSERT INTO occ.namespaces (id, name, status, created_at)
     VALUES ($1, $2, $3, clock_timestamp())`,
    [namespaceId, `Queue integration ${randomUUID()}`, status],
  );
  return namespaceId;
}

async function createResources(pool, agentCount = 1) {
  const client = await pool.connect();
  const namespaceId = `ns_${randomUUID()}`;
  const agents = [];
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO occ.namespaces (id, name, status, created_at)
       VALUES ($1, $2, 'ready', clock_timestamp())`,
      [namespaceId, `Queue integration ${randomUUID()}`],
    );
    for (let index = 0; index < agentCount; index += 1) {
      const agentId = `agt_${randomUUID()}`;
      const configurationId = `cfg_${randomUUID()}`;
      const identityId = `service-agent-${randomUUID()}`;
      await client.query(
        `INSERT INTO occ.configurations (id, namespace_id, kind, generation, created_at)
         VALUES ($1, $2, 'agent', 1, clock_timestamp())`,
        [configurationId, namespaceId],
      );
      await client.query(
        `INSERT INTO occ.agents
           (id, namespace_id, name, configuration_id, provider_id, execution_mode, service_principal_id,
            created_at)
         VALUES ($1, $2, $3, $4, NULL, 'embedded', $5, clock_timestamp())`,
        [agentId, namespaceId, `Queue agent ${randomUUID()}`, configurationId, identityId],
      );
      await client.query(
        `INSERT INTO occ.iam_identities (id, namespace_id, agent_id, kind)
         VALUES ($1, $2, $3, 'service_principal')`,
        [identityId, namespaceId, agentId],
      );
      agents.push(agentId);
    }
    await client.query("COMMIT");
    return { namespaceId, agents };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function createQueueRevision(pool, namespaceId, agentId, revisionNumber = 1) {
  const revisionId = `rev_${randomUUID()}`;
  const configuration = await pool.query(
    `SELECT configuration_id FROM occ.agents WHERE namespace_id = $1 AND id = $2`,
    [namespaceId, agentId],
  );
  assert.equal(configuration.rowCount, 1, "queued revisions require an exact same-Namespace Agent");
  const admittedSpec = {
    draft_spec: {},
    configuration_id: configuration.rows[0].configuration_id,
    configuration_kind: "agent",
    configuration_generation: 1,
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    compute: { id: "compute-queue", implementation: "deterministic-queue" },
  };
  await pool.query(
    `INSERT INTO occ.agent_revisions
       (id, namespace_id, agent_id, revision_number, admitted_spec, admitted_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, clock_timestamp())`,
    [revisionId, namespaceId, agentId, revisionNumber, JSON.stringify(admittedSpec)],
  );
  return revisionId;
}

function namespaceWork(
  namespaceId,
  idempotencyKey,
  availableAt = new Date(0),
  namespaceTarget = "ready",
) {
  return {
    idempotencyKey,
    namespaceId,
    namespaceTarget,
    actorId: "principal-queue-integration",
    availableAt,
  };
}

function revisionWork(namespaceId, idempotencyKey, agentId, revisionId, availableAt = new Date(0)) {
  return {
    idempotencyKey,
    namespaceId,
    agentId,
    revisionId,
    actorId: "principal-queue-integration",
    availableAt,
  };
}

async function claimExpected(queue, idempotencyKey) {
  for (let index = 0; index < 200; index += 1) {
    const claim = await queue.claim();
    if (!claim) break;
    if (claim.idempotencyKey === idempotencyKey) return claim;
    await queue.complete(claim);
  }
  assert.fail(`The durable queue did not expose expected work ${idempotencyKey}.`);
}

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
    const persisted = await pool.query(
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
    const { pool, queue, ResourceConflictError } = await dependencies(context);
    const { namespaceId, agents } = await createResources(pool, 2);
    const revisionId = await createQueueRevision(pool, namespaceId, agents[0]);
    const otherRevisionId = await createQueueRevision(pool, namespaceId, agents[1]);
    const idempotencyKey = `queue-dedupe:${randomUUID()}`;
    const original = revisionWork(namespaceId, idempotencyKey, agents[0], revisionId);

    const first = await queue.enqueue(original);
    const duplicate = await queue.enqueue(original);
    assert.deepEqual(duplicate, first);

    await assert.rejects(
      queue.enqueue({ ...original, actorId: "principal-different" }),
      ResourceConflictError ?? { name: "ResourceConflictError" },
    );
    await assert.rejects(
      queue.enqueue({ ...original, agentId: agents[1], revisionId: otherRevisionId }),
      ResourceConflictError ?? { name: "ResourceConflictError" },
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
  "Namespace convergence and admitted revision work share one durable queue with exact resource ownership",
  requiresPostgres,
  async (context) => {
    const { pool, queue } = await dependencies(context, { maxAttempts: 5 });
    const { namespaceId: revisionNamespaceId, agents } = await createResources(pool);
    const namespaceId = await createNamespace(pool, "provisioning");
    const revisionId = await createQueueRevision(pool, revisionNamespaceId, agents[0]);
    const prefix = `queue-current:${randomUUID()}`;
    const revisionKey = `${prefix}:revision`;
    const namespaceKey = `${prefix}:namespace`;
    const initialTotal = await queue.pending();

    await queue.enqueue(revisionWork(revisionNamespaceId, revisionKey, agents[0], revisionId));
    await queue.enqueue(namespaceWork(namespaceId, namespaceKey, new Date(1)));

    assert.equal(await queue.pending(), initialTotal + 2);

    // Production revisions from ready tenants must not be filtered behind pending Namespace work.
    const revisionClaim = await queue.claim();
    assert.equal(revisionClaim.idempotencyKey, revisionKey);
    assert.equal(revisionClaim.revisionId, revisionId);
    await queue.complete(revisionClaim);
    assert.equal(await queue.pending(), initialTotal + 1);

    // Pending Namespace convergence is progress evidence, not a worker failure budget.
    for (let observation = 0; observation < 7; observation += 1) {
      const namespaceClaim = await queue.claim();
      assert.equal(namespaceClaim.idempotencyKey, namespaceKey);
      assert.equal(namespaceClaim.attemptCount, 1);
      await queue.defer(namespaceClaim, { code: "NAMESPACE_INCOMPLETE" });

      const pending = await pool.query(
        `SELECT state, attempt_count
         FROM occ.controller_work
         WHERE idempotency_key = $1`,
        [namespaceKey],
      );
      assert.deepEqual(pending.rows, [{ state: "queued", attempt_count: 0 }]);
    }

    const namespaceClaim = await claimExpected(queue, namespaceKey);
    await queue.complete(namespaceClaim);

    const completed = await pool.query(
      `SELECT state, attempt_count
       FROM occ.controller_work
       WHERE idempotency_key = $1`,
      [namespaceKey],
    );
    assert.deepEqual(completed.rows, [{ state: "succeeded", attempt_count: 1 }]);

    const evidence = await pool.query(
      `SELECT count(*)::integer AS count
       FROM occ.audit_events
       WHERE namespace_id = $1 AND details->>'reasonCode' = 'NAMESPACE_INCOMPLETE'`,
      [namespaceId],
    );
    assert.deepEqual(evidence.rows, [{ count: 7 }]);

    assert.equal(await queue.pending(), initialTotal);
  },
);

test(
  "stale and exhausted recovery includes admitted revisions and Namespace lifecycle work",
  requiresPostgres,
  async (context) => {
    const { pool, queue } = await dependencies(context, { maxAttempts: 2 });
    const { namespaceId, agents } = await createResources(pool, 2);
    const staleRevisionId = await createQueueRevision(pool, namespaceId, agents[0]);
    const exhaustedRevisionId = await createQueueRevision(pool, namespaceId, agents[1]);
    const prefix = `queue-current-recovery:${randomUUID()}`;
    const staleRevisionKey = `${prefix}:stale-revision`;
    const exhaustedRevisionKey = `${prefix}:exhausted-revision`;
    const namespaceKey = `${prefix}:namespace`;

    await queue.enqueue(revisionWork(namespaceId, staleRevisionKey, agents[0], staleRevisionId));
    const staleRevision = await queue.claim();
    assert.equal(staleRevision.idempotencyKey, staleRevisionKey);

    await queue.enqueue(namespaceWork(namespaceId, namespaceKey, new Date(1)));
    const staleNamespace = await queue.claim();
    assert.equal(staleNamespace.idempotencyKey, namespaceKey);
    await queue.enqueue(
      revisionWork(namespaceId, exhaustedRevisionKey, agents[1], exhaustedRevisionId, new Date(2)),
    );

    await pool.query(
      `UPDATE occ.controller_work
       SET lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE idempotency_key = ANY($1::text[])`,
      [[staleRevisionKey, namespaceKey]],
    );
    await pool.query(
      `UPDATE occ.controller_work
       SET attempt_count = 2
       WHERE idempotency_key = ANY($1::text[])`,
      [[exhaustedRevisionKey]],
    );

    const recovery = await queue.recoverStale({ limit: 10 });
    // Recovery scans the shared queue, so other integration scenarios may contribute to its totals.
    assert.ok(recovery.recovered >= 2, "the exact stale revision and Namespace must be recovered");
    assert.ok(recovery.requeued >= 2, "the exact stale revision and Namespace must be requeued");
    assert.ok(recovery.failedPermanent >= 1, "the exact exhausted revision must fail permanently");
    assert.ok(recovery.exhaustedQueued >= 1, "the exact exhausted revision must be counted");

    const recovered = await pool.query(
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

    const revisionEvidence = await pool.query(
      `SELECT id FROM occ.audit_events
       WHERE resource_id = ANY($1::text[])
         AND details->>'reasonCode' IN ('LEASE_EXPIRED', 'MAX_ATTEMPTS_EXHAUSTED')`,
      [[staleRevisionId, exhaustedRevisionId]],
    );
    assert.equal(revisionEvidence.rowCount, 2);
    await pool.query(
      `UPDATE occ.controller_work
       SET available_at = CASE WHEN idempotency_key = $1 THEN $3::timestamptz ELSE $4::timestamptz END
       WHERE idempotency_key = ANY($2::text[])`,
      [staleRevisionKey, [staleRevisionKey, namespaceKey], new Date(0), new Date(1)],
    );
    const recoveredRevision = await queue.claim();
    assert.equal(recoveredRevision.idempotencyKey, staleRevisionKey);
    assert.notEqual(recoveredRevision.claimToken, staleRevision.claimToken);
    await queue.complete(recoveredRevision);
    const recoveredNamespace = await queue.claim();
    assert.equal(recoveredNamespace.idempotencyKey, namespaceKey);
    assert.notEqual(recoveredNamespace.claimToken, staleNamespace.claimToken);
    await queue.complete(recoveredNamespace);
  },
);

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
        assert.equal((await unit.namespaces.lockNamespace(namespaceId)).status, "ready");

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

    const namespace = await pool.query("SELECT status FROM occ.namespaces WHERE id = $1", [
      namespaceId,
    ]);
    const persisted = await pool.query(
      "SELECT state, claim_token FROM occ.controller_work WHERE idempotency_key = $1",
      [idempotencyKey],
    );
    const audit = await pool.query(
      `SELECT id FROM occ.audit_events
       WHERE resource_id = $1 AND details->>'reasonCode' = 'RECONCILE_SUCCEEDED'`,
      [namespaceId],
    );
    assert.equal(namespace.rows[0].status, "ready");
    assert.deepEqual(persisted.rows[0], { state: "claimed", claim_token: claim.claimToken });
    assert.equal(audit.rowCount, 0);

    await pool.query(
      `UPDATE occ.controller_work
       SET lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    let namespaceMutationReached = false;
    await assert.rejects(
      state.transactWithQueue(async (unit, transactionQueue) => {
        if (!(await transactionQueue.heartbeat(claim))) throw new WorkClaimLostError();
        namespaceMutationReached = true;
        await unit.namespaces.transitionNamespaceStatus(namespaceId, "ready", "deleting");
      }),
      WorkClaimLostError,
    );
    assert.equal(namespaceMutationReached, false);
    assert.equal(
      (await pool.query("SELECT status FROM occ.namespaces WHERE id = $1", [namespaceId])).rows[0]
        .status,
      "ready",
    );
    await assert.rejects(queue.defer(claim, { code: "NAMESPACE_INCOMPLETE" }), WorkClaimLostError);

    const stale = await pool.query(
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
    const { namespaceId, agents } = await createResources(pool, 2);
    const revisions = [
      await createQueueRevision(pool, namespaceId, agents[0]),
      await createQueueRevision(pool, namespaceId, agents[0], 2),
      await createQueueRevision(pool, namespaceId, agents[1]),
    ];
    const prefix = `queue-concurrency:${randomUUID()}`;
    const inputs = [
      namespaceWork(namespaceId, `${prefix}:namespace:first`, new Date(0)),
      namespaceWork(namespaceId, `${prefix}:namespace:second`, new Date(1)),
      revisionWork(namespaceId, `${prefix}:revision:first`, agents[0], revisions[0], new Date(2)),
      revisionWork(namespaceId, `${prefix}:revision:second`, agents[0], revisions[1], new Date(3)),
      revisionWork(namespaceId, `${prefix}:other-revision`, agents[1], revisions[2], new Date(4)),
    ];
    for (const input of inputs) await queue.enqueue(input);

    const allClaims = (await Promise.all(Array.from({ length: 8 }, () => queue.claim()))).filter(
      Boolean,
    );
    const claimed = allClaims.filter((claim) => claim.idempotencyKey.startsWith(prefix));
    assert.equal(claimed.length, 3);

    const roots = claimed.map(({ namespaceId: owner, agentId }) => agentId ?? owner);
    assert.equal(new Set(roots).size, roots.length);
    assert.deepEqual(new Set(roots), new Set([namespaceId, ...agents]));

    const locked = await pool.query(
      `SELECT COALESCE(agent_id, namespace_id) AS owner, count(*)::integer AS claims
     FROM occ.controller_work
     WHERE state = 'claimed' AND idempotency_key LIKE $1
     GROUP BY COALESCE(agent_id, namespace_id)`,
      [`${prefix}:%`],
    );
    assert.equal(locked.rowCount, 3);
    assert.ok(locked.rows.every(({ claims }) => claims === 1));

    for (const claim of allClaims) await queue.complete(claim);
    const remaining = await pool.query(
      `SELECT idempotency_key
     FROM occ.controller_work
     WHERE state = 'queued' AND idempotency_key LIKE $1`,
      [`${prefix}:%`],
    );
    assert.equal(remaining.rowCount, 2);
    for (const { idempotency_key } of remaining.rows) {
      await queue.complete(await claimExpected(queue, idempotency_key));
    }
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
    const { namespaceId, agents } = await createResources(pool);
    const revisionId = await createQueueRevision(pool, namespaceId, agents[0]);
    const idempotencyKey = `queue-stale:${randomUUID()}`;
    const candidateWork = revisionWork(namespaceId, idempotencyKey, agents[0], revisionId);
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

    const terminal = await pool.query(
      `SELECT state, attempt_count, claim_token, lease_expires_at, completed_at
     FROM occ.controller_work
     WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    assert.equal(terminal.rows[0].state, "failed_permanent");
    assert.equal(terminal.rows[0].attempt_count, 2);
    assert.equal(terminal.rows[0].claim_token, null);
    assert.equal(terminal.rows[0].lease_expires_at, null);
    assert.notEqual(terminal.rows[0].completed_at, null);

    const evidence = await pool.query(
      `SELECT actor_id, outcome, details->>'reasonCode' AS reason
     FROM occ.audit_events
     WHERE resource_id = $1
       AND details->>'reasonCode' IN ('LEASE_EXPIRED', 'UPSTREAM_TIMEOUT')
     ORDER BY occurred_at`,
      [revisionId],
    );
    assert.deepEqual(
      evidence.rows.map(({ reason }) => reason),
      ["LEASE_EXPIRED", "UPSTREAM_TIMEOUT"],
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
    const { pool, queue, PostgresWorkQueue } = await dependencies(context, { leaseDurationMs: 35 });
    const { namespaceId, agents } = await createResources(pool, 2);
    const revisions = await Promise.all(
      agents.map((agentId) => createQueueRevision(pool, namespaceId, agentId)),
    );
    const prefix = `queue-batch:${randomUUID()}`;
    const keys = agents.map((agentId, index) => `${prefix}:${index}`);
    for (const [index, agentId] of agents.entries()) {
      await queue.enqueue(
        revisionWork(namespaceId, keys[index], agentId, revisions[index], new Date(index)),
      );
    }

    const claims = [];
    for (const key of keys) claims.push(await claimExpected(queue, key));
    assert.equal(claims.length, 2);
    await delay(75);

    const recovery = await queue.recoverStale({ limit: 10 });
    assert.equal(recovery.recovered, 2);
    assert.equal(recovery.requeued, 2);
    assert.equal(recovery.failedPermanent, 0);

    const audits = await pool.query(
      `SELECT resource_id, count(*)::integer AS events
     FROM occ.audit_events
     WHERE resource_id = ANY($1::text[])
       AND details->>'reasonCode' = 'LEASE_EXPIRED'
     GROUP BY resource_id`,
      [revisions],
    );
    assert.equal(audits.rowCount, 2);
    assert.ok(audits.rows.every(({ events }) => events === 1));

    const cleanupQueue = new PostgresWorkQueue(pool, { leaseDurationMs: 1_000, random: () => 0 });
    for (const key of keys) await cleanupQueue.complete(await claimExpected(cleanupQueue, key));
  },
);
