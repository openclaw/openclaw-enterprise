import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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
      const secretId = `sec_${randomUUID()}`;
      const harnessAuth = {
        method: "api_key",
        source: { kind: "secret", namespaceId, id: secretId },
      };
      await client.query(
        `INSERT INTO occ.configurations (id, namespace_id, kind, generation, created_at)
         VALUES ($1, $2, 'agent', 1, clock_timestamp())`,
        [configurationId, namespaceId],
      );
      await client.query(
        `INSERT INTO occ.secrets
           (id, namespace_id, name, driver_id, backend_namespace_name, backend_name,
            backend_key, backend_uid, created_at)
         VALUES ($1, $2, $1, 'secret-queue', 'queue-recovery', $3, 'value', $4, clock_timestamp())`,
        [secretId, namespaceId, `harness-${randomUUID()}`, randomUUID()],
      );
      await client.query(
        `INSERT INTO occ.agents
           (id, namespace_id, name, configuration_id, backend_id, execution_mode, service_principal_id,
            harness_auth, created_at)
         VALUES ($1, $2, $3, $4, NULL, 'embedded', $5, $6::jsonb, clock_timestamp())`,
        [
          agentId,
          namespaceId,
          `Queue agent ${randomUUID()}`,
          configurationId,
          identityId,
          JSON.stringify(harnessAuth),
        ],
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

async function createQueueRevision(
  pool,
  namespaceId,
  agentId,
  revisionNumber = 1,
  repositoryCredentials,
) {
  const revisionId = `rev_${randomUUID()}`;
  const configuration = await pool.query(
    `SELECT agent.configuration_id, agent.harness_auth, secret.driver_id
     FROM occ.agents agent
     JOIN occ.secrets secret
       ON secret.namespace_id = agent.namespace_id AND secret.id = agent.harness_auth_secret_id
     WHERE agent.namespace_id = $1 AND agent.id = $2`,
    [namespaceId, agentId],
  );
  assert.equal(configuration.rowCount, 1, "queued revisions require an exact same-Namespace Agent");
  const admittedSpec = {
    draft_spec: {},
    harness_auth: {
      ...configuration.rows[0].harness_auth,
      secretDriverId: configuration.rows[0].driver_id,
    },
    configuration_id: configuration.rows[0].configuration_id,
    configuration_kind: "agent",
    configuration_generation: 1,
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    compute: { id: "compute-queue", implementation: "deterministic-queue" },
    ...(repositoryCredentials === undefined
      ? {}
      : { repository_credentials: repositoryCredentials }),
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
    if (!claim) {
      break;
    }
    if (claim.idempotencyKey === idempotencyKey) {
      return claim;
    }
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
  "terminal revision work stores safe outcome data and plugin warnings",
  requiresPostgres,
  async (context) => {
    const { pool, queue } = await dependencies(context);
    const { namespaceId, agents } = await createResources(pool);
    const revisionId = await createQueueRevision(pool, namespaceId, agents[0]);
    const idempotencyKey = `agent_revision:${revisionId}:reconcile`;
    await queue.enqueue(revisionWork(namespaceId, idempotencyKey, agents[0], revisionId));

    const claim = await claimExpected(queue, idempotencyKey);
    // Result payloads remain allowlisted even though success and failure now
    // share one column. Reject malformed warnings before completing the claim.
    for (const resultData of [
      { warnings: [{ code: "UNKNOWN_WARNING", pluginId: "occ-plugin:diffs" }] },
      { warnings: [{ code: "PLUGIN_INSTALL_FAILED", pluginId: "invalid plugin id" }] },
      {
        warnings: [{ code: "PLUGIN_INSTALL_FAILED", pluginId: "occ-plugin:diffs", raw: "unsafe" }],
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
        warnings: [{ code: "PLUGIN_INSTALL_FAILED", pluginId: "occ-plugin:diffs", raw: "unsafe" }],
      },
      { warnings: [], raw: "unsafe" },
    ]) {
      await assert.rejects(
        pool.query(
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
    const { namespaceId, agents } = await createResources(pool, 2);
    const invalidRevisionId = await createQueueRevision(pool, namespaceId, agents[0]);
    const exhaustedRevisionId = await createQueueRevision(pool, namespaceId, agents[1]);
    const invalidKey = `agent_revision:${invalidRevisionId}:reconcile`;
    const exhaustedKey = `agent_revision:${exhaustedRevisionId}:reconcile`;
    await queue.enqueue(revisionWork(namespaceId, invalidKey, agents[0], invalidRevisionId));
    await queue.enqueue(revisionWork(namespaceId, exhaustedKey, agents[1], exhaustedRevisionId));

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
    assert.equal(deadline.state, "failed_permanent");
    assert.deepEqual(deadline.resultData, { timeoutMs: 900_000, runtimeFailure });
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
        pool.query(
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
    assert.equal(exhausted.state, "failed_permanent");
    assert.equal(exhausted.reasonCode, "DEPENDENCY_UNAVAILABLE");
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
    const { namespaceId: revisionNamespaceId, agents } = await createResources(pool, 2);
    const namespaceId = await createNamespace(pool, "provisioning");
    const staleRevisionId = await createQueueRevision(pool, revisionNamespaceId, agents[0]);
    const exhaustedRevisionId = await createQueueRevision(pool, revisionNamespaceId, agents[1]);
    const prefix = `queue-current-recovery:${randomUUID()}`;
    const staleRevisionKey = `${prefix}:stale-revision`;
    const exhaustedRevisionKey = `${prefix}:exhausted-revision`;
    const namespaceKey = `${prefix}:namespace`;

    await queue.enqueue(
      revisionWork(revisionNamespaceId, staleRevisionKey, agents[0], staleRevisionId),
    );
    const staleRevision = await queue.claim();
    assert.equal(staleRevision.idempotencyKey, staleRevisionKey);

    await queue.enqueue(namespaceWork(namespaceId, namespaceKey, new Date(1)));
    const staleNamespace = await queue.claim();
    assert.equal(staleNamespace.idempotencyKey, namespaceKey);
    await queue.enqueue(
      revisionWork(
        revisionNamespaceId,
        exhaustedRevisionKey,
        agents[1],
        exhaustedRevisionId,
        new Date(2),
      ),
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

    // Retryable provisioning remains pending; exhausted Agent work must not
    // change its already-ready tenant's lifecycle status.
    assert.equal(
      (await pool.query("SELECT status FROM occ.namespaces WHERE id = $1", [namespaceId])).rows[0]
        .status,
      "provisioning",
    );
    assert.equal(
      (await pool.query("SELECT status FROM occ.namespaces WHERE id = $1", [revisionNamespaceId]))
        .rows[0].status,
      "ready",
    );

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
        await pool.query(
          `UPDATE occ.controller_work
           SET lease_expires_at = clock_timestamp() - interval '1 second'
           WHERE idempotency_key = $1`,
          [idempotencyKey],
        );
      } else {
        const previousQueue = new PostgresWorkQueue(pool, { maxAttempts: 2, random: () => 0 });
        await previousQueue.retry(claim, { code: "DEPENDENCY_UNAVAILABLE" });
      }

      const reasonCode = source === "claimed" ? "LEASE_EXPIRED" : "MAX_ATTEMPTS_EXHAUSTED";
      const snapshot = async (client) => {
        const result = await client.query(
          `SELECT namespace.status, work.state, work.claim_token, work.lease_expires_at,
                  work.completed_at,
                  (SELECT count(*)::integer FROM occ.audit_events
                   WHERE resource_id = $2 AND details->>'reasonCode' = $3) AS evidence
           FROM occ.controller_work AS work
           JOIN occ.namespaces AS namespace ON namespace.id = work.namespace_id
           WHERE work.idempotency_key = $1`,
          [idempotencyKey, namespaceId, reasonCode],
        );
        return result.rows[0];
      };
      const before = await snapshot(pool);
      const expected = {
        status: "failed",
        state: "failed_permanent",
        claim_token: null,
        lease_expires_at: null,
        evidence: 1,
      };

      // Block Namespace publication to force a real server-side statement
      // failure. Standalone recovery must not commit work or audit first.
      const blocker = await pool.connect();
      const recoveryClient = await pool.connect();
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT id FROM occ.namespaces WHERE id = $1 FOR UPDATE", [
          namespaceId,
        ]);
        await recoveryClient.query("SET lock_timeout = '100ms'");
        await assert.rejects(
          new PostgresWorkQueue(recoveryClient, { maxAttempts: 1 }).recoverStale(),
          { code: "55P03" },
        );
        assert.deepEqual(await snapshot(pool), before);
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
        await recoveryClient.query("RESET lock_timeout");
        recoveryClient.release();
      }

      // Recovery must participate in its caller's transaction: neither the
      // terminal work nor the Namespace failure may survive a rollback alone.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await new PostgresWorkQueue(client, { maxAttempts: 1 }).recoverStale();
        const { completed_at, ...recovered } = await snapshot(client);
        assert.ok(completed_at instanceof Date);
        assert.deepEqual(recovered, expected);
      } finally {
        await client.query("ROLLBACK");
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
      ]) {
        const namespaceId = await createNamespace(pool, status);
        const key = `queue-exhausted-guard:${randomUUID()}`;
        await queue.enqueue(namespaceWork(namespaceId, key, new Date(0), target));
        const claim = await claimExpected(queue, key);
        if (tombstone) {
          // Teardown may already have published its tombstone before recovery.
          await pool.query(
            "UPDATE occ.namespaces SET deleted_at = clock_timestamp() WHERE id = $1",
            [namespaceId],
          );
        }
        if (source === "claimed") {
          await pool.query(
            `UPDATE occ.controller_work SET lease_expires_at = clock_timestamp() - interval '1 second'
             WHERE idempotency_key = $1`,
            [key],
          );
        } else {
          await new PostgresWorkQueue(pool, { maxAttempts: 2, random: () => 0 }).retry(claim, {
            code: "DEPENDENCY_UNAVAILABLE",
          });
        }
        await queue.recoverStale();
        const result = await pool.query(
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
    for (const input of inputs) {
      await queue.enqueue(input);
    }

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

    for (const claim of allClaims) {
      await queue.complete(claim);
    }
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
    for (const key of keys) {
      claims.push(await claimExpected(queue, key));
    }
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
    for (const key of keys) {
      await cleanupQueue.complete(await claimExpected(cleanupQueue, key));
    }
  },
);

function repositoryCleanupKey(revisionId, sourceKey, purpose = "sessions") {
  const purposeKey = purpose === "terminal-runtime" ? "retire:" : "";
  return `agent_revision:${revisionId}:repository_cleanup:${purposeKey}${createHash("sha256").update(sourceKey, "utf8").digest("hex")}`;
}

async function createRepositoryRevision(
  pool,
  namespaceId,
  agentId,
  phases = ["open"],
  revisionNumber = 1,
  deadlineWallMs = Date.now() + 3_600_000,
) {
  const bindings = phases.map((_, index) => ({
    repositoryRef: `repository-${index}`,
    profile: "read",
    backendId: "queue-provider",
    grant: {
      providerInstanceId: "queue-provider-instance",
      repositoryId: `repository-${index}`,
      grantId: `grant-${index}`,
    },
  }));
  const revisionId = await createQueueRevision(pool, namespaceId, agentId, revisionNumber, {
    driver: { id: "repository-queue", implementation: "queue-integration" },
    deadlineWallMs,
    bindings,
  });
  const owner = { namespaceId, agentId, revisionId };
  const admissionIds = [];
  // Session admission requires a live running owner; terminal scenarios stop it afterwards.
  await pool.query(
    "UPDATE occ.agents SET desired_runtime_state = 'running' WHERE namespace_id = $1 AND id = $2",
    [namespaceId, agentId],
  );
  for (const [index, phase] of phases.entries()) {
    // An admitted binding can fail before its first session attempt is recorded.
    if (phase === undefined) {
      continue;
    }
    const admissionId = `admission-${randomUUID()}`;
    admissionIds.push(admissionId);
    await pool.query(
      `INSERT INTO occ.repository_session_attempts
         (namespace_id, agent_id, revision_id, repository_ref, admission_id,
          duration_seconds, deadline_wall_ms, phase, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 3600, $6, 'opening', clock_timestamp(), clock_timestamp())`,
      [
        namespaceId,
        agentId,
        revisionId,
        bindings[index].repositoryRef,
        admissionId,
        deadlineWallMs,
      ],
    );
    if (phase !== "opening") {
      await pool.query(
        `UPDATE occ.repository_session_attempts
         SET phase = 'open', session_id = $2, updated_at = clock_timestamp()
         WHERE admission_id = $1`,
        [admissionId, `session-${randomUUID()}`],
      );
      if (phase !== "open") {
        await pool.query(
          `UPDATE occ.repository_session_attempts SET phase = 'closing', updated_at = clock_timestamp()
           WHERE admission_id = $1`,
          [admissionId],
        );
        if (phase !== "closing") {
          await pool.query(
            `UPDATE occ.repository_session_attempts SET phase = $2, updated_at = clock_timestamp()
             WHERE admission_id = $1`,
            [admissionId, phase],
          );
        }
      }
    }
  }
  return { ...owner, admissionIds };
}

async function readRepositoryAttempts(pool, revisionId) {
  return (
    await pool.query(
      `SELECT namespace_id, agent_id, revision_id, repository_ref, admission_id,
              duration_seconds, deadline_wall_ms, phase, session_id, created_at
       FROM occ.repository_session_attempts WHERE revision_id = $1 ORDER BY repository_ref`,
      [revisionId],
    )
  ).rows;
}

async function readQueueRow(pool, idempotencyKey) {
  return (
    await pool.query("SELECT * FROM occ.controller_work WHERE idempotency_key = $1", [
      idempotencyKey,
    ])
  ).rows[0];
}

async function insertRawQueueWork(pool, input, attemptCount = 0) {
  await pool.query(
    `INSERT INTO occ.controller_work
       (idempotency_key, namespace_id, agent_id, revision_id, actor_id, namespace_target,
        agent_target, state, available_at, attempt_count, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', to_timestamp(0), $8,
             clock_timestamp(), clock_timestamp())`,
    [
      input.idempotencyKey,
      input.namespaceId,
      input.agentId ?? null,
      input.revisionId ?? null,
      input.actorId,
      input.namespaceTarget ?? null,
      input.agentTarget ?? null,
      attemptCount,
    ],
  );
}

async function completeCleanupWork(queue, revisionId, sourceKey, purpose = "sessions") {
  await queue.complete(
    await claimExpected(queue, repositoryCleanupKey(revisionId, sourceKey, purpose)),
  );
}

for (const transition of ["fail", "retry", "expired claim", "exhausted queued"]) {
  for (const sessionState of ["mixed", "settled", "unstarted"]) {
    test(
      `repository cleanup transfers exact revision obligations atomically on ${transition} with ${sessionState} sessions`,
      requiresPostgres,
      async (context) => {
        const { pool, queue, WorkClaimLostError } = await dependencies(context, { maxAttempts: 1 });
        const { namespaceId, agents } = await createResources(pool, 2);
        const phases = {
          mixed: ["opening", "open", "closing", "disposed", "invalidated"],
          settled: ["disposed"],
          unstarted: [undefined],
        };
        const owner = await createRepositoryRevision(
          pool,
          namespaceId,
          agents[0],
          phases[sessionState],
        );
        const sibling = await createRepositoryRevision(pool, namespaceId, agents[0], ["open"], 2);
        const unrelated = await createRepositoryRevision(pool, namespaceId, agents[1]);
        const before = await readRepositoryAttempts(pool, owner.revisionId);
        const siblingBefore = await readRepositoryAttempts(pool, sibling.revisionId);
        const unrelatedBefore = await readRepositoryAttempts(pool, unrelated.revisionId);
        const sourceKey = `queue-cleanup:${transition}:café:雪:${randomUUID()}`;
        const actorId = `principal-source-${randomUUID()}`;
        await queue.enqueue({
          ...revisionWork(namespaceId, sourceKey, agents[0], owner.revisionId),
          actorId,
        });
        let claim;
        if (transition === "exhausted queued") {
          await pool.query(
            "UPDATE occ.controller_work SET attempt_count = 1 WHERE idempotency_key = $1",
            [sourceKey],
          );
          await queue.recoverStale();
        } else {
          claim = await claimExpected(queue, sourceKey);
          if (transition === "expired claim") {
            await pool.query(
              "UPDATE occ.controller_work SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE idempotency_key = $1",
              [sourceKey],
            );
            await queue.recoverStale();
          } else {
            await queue[transition](claim, { code: "REPOSITORY_TRANSITION_FAILED" });
          }
        }
        assert.equal((await readQueueRow(pool, sourceKey)).state, "failed_permanent");
        assert.deepEqual(
          await readRepositoryAttempts(pool, owner.revisionId),
          before.map((attempt) => ({
            ...attempt,
            phase: ["opening", "open"].includes(attempt.phase) ? "closing" : attempt.phase,
          })),
          "transfer must retain immutable admission identity and every recorded session",
        );
        assert.deepEqual(await readRepositoryAttempts(pool, sibling.revisionId), siblingBefore);
        assert.deepEqual(await readRepositoryAttempts(pool, unrelated.revisionId), unrelatedBefore);
        const cleanupKey = repositoryCleanupKey(owner.revisionId, sourceKey, "terminal-runtime");
        const cleanup = await readQueueRow(pool, cleanupKey);
        assert.ok(cleanup);
        const transferred = await pool.query(
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
          [namespaceId, agents[0], owner.revisionId, actorId, null, null, "queued", 0],
        );
        const digest = await pool.query(
          "SELECT encode(sha256(convert_to($1, 'UTF8')), 'hex') AS hash",
          [sourceKey],
        );
        assert.equal(
          cleanupKey,
          `agent_revision:${owner.revisionId}:repository_cleanup:retire:${digest.rows[0].hash}`,
        );
        const evidence = await pool.query(
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
        assert.equal((await readQueueRow(pool, cleanupKey)).state, "queued");
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
    const { namespaceId, agents } = await createResources(pool);
    const owner = await createRepositoryRevision(pool, namespaceId, agents[0]);
    const sourceKey = `queue-cleanup-retry:${randomUUID()}`;
    await queue.enqueue(revisionWork(namespaceId, sourceKey, agents[0], owner.revisionId));
    const claim = await claimExpected(queue, sourceKey);
    const before = await readRepositoryAttempts(pool, owner.revisionId);
    const stale = { ...claim, claimToken: randomUUID() };
    await assert.rejects(queue.fail(stale, { code: "STALE" }), WorkClaimLostError);
    await assert.rejects(queue.retry(stale, { code: "STALE" }), WorkClaimLostError);
    await queue.retry(claim, { code: "TEMPORARY" });
    assert.equal((await readQueueRow(pool, sourceKey)).state, "queued");
    assert.deepEqual(await readRepositoryAttempts(pool, owner.revisionId), before);
    assert.equal(
      await readQueueRow(
        pool,
        repositoryCleanupKey(owner.revisionId, sourceKey, "terminal-runtime"),
      ),
      undefined,
    );
    const next = await claimExpected(queue, sourceKey);
    await pool.query(
      "UPDATE occ.controller_work SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE idempotency_key = $1",
      [sourceKey],
    );
    await assert.rejects(queue.fail(next, { code: "EXPIRED" }), WorkClaimLostError);
    await assert.rejects(queue.retry(next, { code: "EXPIRED" }), WorkClaimLostError);
    assert.deepEqual(await readRepositoryAttempts(pool, owner.revisionId), before);
    await queue.recoverStale();
    await queue.complete(await claimExpected(queue, sourceKey));
  },
);

test(
  "cleanup transfer rollback and a conflicting cleanup actor preserve the source claim",
  requiresPostgres,
  async (context) => {
    const { pool, queue, PostgresWorkQueue } = await dependencies(context);
    const { namespaceId, agents } = await createResources(pool);
    const owner = await createRepositoryRevision(pool, namespaceId, agents[0]);
    const sourceKey = `queue-cleanup-rollback:${randomUUID()}`;
    await queue.enqueue(revisionWork(namespaceId, sourceKey, agents[0], owner.revisionId));
    const claim = await claimExpected(queue, sourceKey);
    const before = await readRepositoryAttempts(pool, owner.revisionId);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const transactionQueue = new PostgresWorkQueue(client);
      await transactionQueue.fail(claim, { code: "ROLLBACK_CLEANUP" });
      assert.equal((await readQueueRow(client, sourceKey)).state, "failed_permanent");
      assert.ok(
        await readQueueRow(
          client,
          repositoryCleanupKey(owner.revisionId, sourceKey, "terminal-runtime"),
        ),
      );
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    assert.equal((await readQueueRow(pool, sourceKey)).state, "claimed");
    assert.deepEqual(await readRepositoryAttempts(pool, owner.revisionId), before);
    const cleanupKey = repositoryCleanupKey(owner.revisionId, sourceKey, "terminal-runtime");
    assert.equal(await readQueueRow(pool, cleanupKey), undefined);
    await insertRawQueueWork(pool, {
      ...revisionWork(namespaceId, cleanupKey, agents[0], owner.revisionId),
      actorId: "principal-conflicting-cleanup",
    });
    await assert.rejects(queue.fail(claim, { code: "COLLIDING_CLEANUP" }));
    const source = await readQueueRow(pool, sourceKey);
    assert.equal(source.state, "claimed");
    assert.equal(source.claim_token, claim.claimToken);
    assert.deepEqual(await readRepositoryAttempts(pool, owner.revisionId), before);
    assert.equal(
      (
        await pool.query("SELECT id FROM occ.audit_events WHERE resource_id = $1", [
          owner.revisionId,
        ])
      ).rowCount,
      0,
    );
    await queue.complete(claim);
    await queue.complete(await claimExpected(queue, cleanupKey));
  },
);

for (const purpose of ["sessions", "terminal-runtime"]) {
  test(
    `${purpose} cleanup retries and worker crashes cannot exhaust or recursively fan out`,
    requiresPostgres,
    async (context) => {
      const { pool, queue } = await dependencies(context, { maxAttempts: 2 });
      const { namespaceId, agents } = await createResources(pool);
      const owner = await createRepositoryRevision(pool, namespaceId, agents[0]);
      const sourceKey = `queue-cleanup-persistent:${randomUUID()}`;
      await queue.enqueue(revisionWork(namespaceId, sourceKey, agents[0], owner.revisionId));
      const source = await claimExpected(queue, sourceKey);
      if (purpose === "terminal-runtime") {
        await queue.fail(source, { code: "SOURCE_FAILED" });
      } else {
        await pool.query(
          "UPDATE occ.repository_session_attempts SET phase = 'closing', updated_at = clock_timestamp() WHERE revision_id = $1",
          [owner.revisionId],
        );
        await queue.enqueueRepositoryCleanup(source, owner);
        await queue.complete(source);
      }
      const cleanupKey = repositoryCleanupKey(owner.revisionId, sourceKey, purpose);
      for (let index = 0; index < 8; index += 1) {
        const claim = await claimExpected(queue, cleanupKey);
        assert.ok(claim.attemptCount <= 2, "cleanup attempts must saturate without integer growth");
        await assert.rejects(queue.fail(claim, { code: "CANNOT_ABANDON" }));
        assert.equal((await readQueueRow(pool, cleanupKey)).state, "claimed");
        if (index % 2 === 0) {
          await queue.retry(claim, { code: "CLEANUP_UNAVAILABLE" });
        } else {
          await pool.query(
            "UPDATE occ.controller_work SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE idempotency_key = $1",
            [cleanupKey],
          );
          await queue.recoverStale();
        }
        const queued = await readQueueRow(pool, cleanupKey);
        assert.equal(queued.state, "queued");
        assert.equal(queued.completed_at, null);
        assert.ok(queued.attempt_count <= 2);
        await queue.recoverStale();
        assert.equal(
          (await readQueueRow(pool, cleanupKey)).state,
          "queued",
          "queued exhaustion must exclude cleanup",
        );
      }
      const rows = await pool.query(
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

for (const purpose of ["sessions", "terminal-runtime"]) {
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
          key: `agent_revision:${revisions[0]}:repository_cleanup:${purposeKey}${digest}`,
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
      // Use a distinct digest for the owner-mismatch case so both database rows can coexist.
      cases[4].key = `agent_revision:${revisions[0]}:repository_cleanup:${purposeKey}${"b".repeat(64)}`;
      for (const [index, scenario] of cases.entries()) {
        const input =
          scenario.name === "namespace target"
            ? namespaceWork(namespaceId, scenario.key)
            : revisionWork(namespaceId, scenario.key, agents[index], revisions[index]);
        assert.equal(isRepositoryCleanupWork(input), scenario.valid, scenario.name);
        assert.equal(
          isRepositoryRuntimeRetirementWork(input),
          scenario.valid && purpose === "terminal-runtime",
          scenario.name,
        );
        await assert.rejects(
          queue.enqueue(input),
          undefined,
          `normal enqueue must reserve ${scenario.name}`,
        );
        await insertRawQueueWork(pool, input, 2);
      }
      assert.equal(
        isRepositoryCleanupWork({
          ...revisionWork(namespaceId, cases[0].key, agents[0], revisions[0]),
          agentTarget: "stopped",
        }),
        false,
      );
      assert.equal(
        isRepositoryCleanupWork({ idempotencyKey: cases[0].key, revisionId: revisions[0] }),
        false,
      );
      const claimedKeys = [];
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
        [cases[0].key],
        "only the complete matching cleanup identity bypasses exhaustion",
      );
      await queue.recoverStale();
      for (const scenario of cases) {
        assert.equal(
          (await readQueueRow(pool, scenario.key)).state,
          scenario.valid ? "succeeded" : "failed_permanent",
          scenario.name,
        );
      }
    },
  );
}

for (const transition of ["fail", "retry", "expired claim", "exhausted queued"]) {
  test(
    `Agent deletion retains exact cleanup obligations on ${transition}`,
    requiresPostgres,
    async (context) => {
      const { pool, queue, WorkClaimLostError } = await dependencies(context, { maxAttempts: 1 });
      const { namespaceId, agents } = await createResources(pool, 2);
      const owner = await createRepositoryRevision(pool, namespaceId, agents[0], [
        "opening",
        "open",
        "invalidated",
        "disposed",
      ]);
      const sibling = await createRepositoryRevision(pool, namespaceId, agents[1], ["closing"]);
      const sourceKey = `agent-delete-cleanup:${randomUUID()}`;
      await queue.enqueue({
        namespaceId,
        agentId: agents[0],
        agentTarget: "deleted",
        idempotencyKey: sourceKey,
        actorId: "principal-deletion",
        availableAt: new Date(0),
      });
      // A revision admitted after this Work was created cannot inherit its cleanup authority.
      const later = await createRepositoryRevision(pool, namespaceId, agents[0], ["closing"], 2);
      await pool.query(
        "UPDATE occ.agents SET desired_runtime_state = 'stopped', status = 'deleting' WHERE id = $1",
        [agents[0]],
      );
      const before = await readRepositoryAttempts(pool, owner.revisionId);
      const siblingBefore = await readRepositoryAttempts(pool, sibling.revisionId);
      const laterBefore = await readRepositoryAttempts(pool, later.revisionId);
      let claim;
      if (transition === "exhausted queued") {
        await pool.query(
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
        await assert.rejects(queue.enqueueRepositoryCleanup(claim, sibling));
        await assert.rejects(queue.enqueueRepositoryCleanup(claim, later));
        assert.equal(
          await queue.completeAgentDeletion(claim, namespaceId, agents[0]),
          "cleanup-pending",
        );
        if (transition === "expired claim") {
          await pool.query(
            "UPDATE occ.controller_work SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE idempotency_key = $1",
            [sourceKey],
          );
          await queue.recoverStale();
        } else {
          await queue[transition](claim, { code: "DELETE_FAILED" });
        }
      }
      assert.equal((await readQueueRow(pool, sourceKey)).state, "failed_permanent");
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
      assert.equal(cleanup.actor_id, "principal-deletion");
      assert.equal(cleanup.state, "queued");
      assert.equal(
        await readQueueRow(pool, repositoryCleanupKey(later.revisionId, sourceKey)),
        undefined,
      );
      if (claim !== undefined) {
        await assert.rejects(
          queue.completeAgentDeletion(claim, namespaceId, agents[0]),
          WorkClaimLostError,
        );
      }
      await completeCleanupWork(queue, owner.revisionId, sourceKey);
    },
  );
}

for (const desiredState of ["stopped", "running"]) {
  test(
    `failed Agent stop protects later admissions while Agent is ${desiredState}`,
    requiresPostgres,
    async (context) => {
      const { pool, queue } = await dependencies(context);
      const { namespaceId, agents } = await createResources(pool, 2);
      const old = await createRepositoryRevision(pool, namespaceId, agents[0], ["open", "closing"]);
      const unrelated = await createRepositoryRevision(pool, namespaceId, agents[1]);
      const sourceKey = `agent-stop-cleanup:${randomUUID()}`;
      await pool.query("UPDATE occ.agents SET desired_runtime_state = 'stopped' WHERE id = $1", [
        agents[0],
      ]);
      await queue.enqueue({
        namespaceId,
        agentId: agents[0],
        agentTarget: "stopped",
        idempotencyKey: sourceKey,
        actorId: "principal-stop-source",
        availableAt: new Date(0),
      });
      const claim = await claimExpected(queue, sourceKey);
      const later = await createRepositoryRevision(pool, namespaceId, agents[0], ["open"], 2);
      await pool.query(
        "UPDATE occ.agents SET desired_runtime_state = $2, active_revision_id = $3 WHERE id = $1",
        [agents[0], desiredState, later.revisionId],
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
        (await readQueueRow(pool, repositoryCleanupKey(old.revisionId, sourceKey))).actor_id,
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
    const { namespaceId, agents } = await createResources(pool);
    const owner = await createRepositoryRevision(pool, namespaceId, agents[0], [
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
    await pool.query("UPDATE occ.namespaces SET status = 'deleting' WHERE id = $1", [namespaceId]);
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
    const { namespaceId, agents } = await createResources(pool, 2);
    const previous = await createRepositoryRevision(pool, namespaceId, agents[0], ["closing"]);
    const current = await createRepositoryRevision(pool, namespaceId, agents[0], ["disposed"], 2);
    const later = await createRepositoryRevision(pool, namespaceId, agents[0], ["closing"], 3);
    const unrelated = await createRepositoryRevision(pool, namespaceId, agents[1], ["closing"]);
    const sourceKey = `queue-retirement-cleanup:${randomUUID()}`;
    await queue.enqueue({
      ...revisionWork(namespaceId, sourceKey, agents[0], current.revisionId),
      actorId: "principal-retirement",
    });
    const claim = await claimExpected(queue, sourceKey);
    await assert.rejects(
      queue.enqueueRepositoryCleanup({ ...claim, claimToken: randomUUID() }, previous),
      WorkClaimLostError,
    );
    await assert.rejects(queue.enqueueRepositoryCleanup(claim, later));
    await assert.rejects(queue.enqueueRepositoryCleanup(claim, unrelated));
    await assert.rejects(
      queue.enqueueRepositoryCleanup(claim, { ...previous, namespaceId: `ns_${randomUUID()}` }),
    );
    const registered = await queue.enqueueRepositoryCleanup(
      { ...claim, actorId: "principal-forged-caller" },
      previous,
    );
    assert.equal(registered.idempotencyKey, repositoryCleanupKey(previous.revisionId, sourceKey));
    assert.equal(registered.actorId, "principal-retirement");
    assert.equal(
      (await queue.enqueueRepositoryCleanup(claim, previous)).idempotencyKey,
      registered.idempotencyKey,
    );
    // Runtime retirement survives settled credentials but cannot inherit the
    // broader predecessor authority granted to session-only cleanup.
    assert.equal(await queue.enqueueRepositoryCleanup(claim, current), undefined);
    for (const forbidden of [
      previous,
      later,
      unrelated,
      { ...current, namespaceId: `ns_${randomUUID()}` },
    ]) {
      await assert.rejects(queue.enqueueRepositoryCleanup(claim, forbidden, "terminal-runtime"));
    }
    await assert.rejects(
      queue.enqueueRepositoryCleanup(
        { ...claim, claimToken: randomUUID() },
        current,
        "terminal-runtime",
      ),
      WorkClaimLostError,
    );
    const retirement = await queue.enqueueRepositoryCleanup(
      { ...claim, actorId: "principal-forged-caller", revisionId: previous.revisionId },
      current,
      "terminal-runtime",
    );
    assert.equal(
      retirement.idempotencyKey,
      repositoryCleanupKey(current.revisionId, sourceKey, "terminal-runtime"),
    );
    assert.equal(retirement.actorId, "principal-retirement");
    assert.equal(
      (await queue.enqueueRepositoryCleanup(claim, current, "terminal-runtime")).idempotencyKey,
      retirement.idempotencyKey,
    );
    assert.equal((await readRepositoryAttempts(pool, current.revisionId))[0].phase, "disposed");
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
    const { namespaceId, agents } = await createResources(pool);
    const owner = await createRepositoryRevision(pool, namespaceId, agents[0]);
    const key = `queue-no-closing:${randomUUID()}`;
    await queue.enqueue(revisionWork(namespaceId, key, agents[0], owner.revisionId));
    const claim = await claimExpected(queue, key);
    assert.equal(await queue.enqueueRepositoryCleanup(claim, owner), undefined);
    assert.equal((await readRepositoryAttempts(pool, owner.revisionId))[0].phase, "open");
    await queue.complete(claim);
    const namespaceKey = `queue-provision-registration:${randomUUID()}`;
    await queue.enqueue(namespaceWork(namespaceId, namespaceKey));
    const namespaceClaim = await claimExpected(queue, namespaceKey);
    await assert.rejects(queue.enqueueRepositoryCleanup(namespaceClaim, owner));
    await assert.rejects(queue.enqueueRepositoryCleanup(namespaceClaim, owner, "terminal-runtime"));
    await queue.complete(namespaceClaim);
  },
);

test(
  "maintenance continuation and successor enqueue commit together or preserve existing sessions on rollback",
  requiresPostgres,
  async (context) => {
    const { pool, queue, PostgresWorkQueue } = await dependencies(context);
    const { namespaceId, agents } = await createResources(pool);
    const owner = await createRepositoryRevision(pool, namespaceId, agents[0]);
    await pool.query(
      "UPDATE occ.agents SET active_revision_id = $2, desired_runtime_state = 'running' WHERE id = $1",
      [agents[0], owner.revisionId],
    );
    const sourceKey = `agent_revision:${owner.revisionId}:maintenance:1`;
    const successorKey = `agent_revision:${owner.revisionId}:maintenance:2`;
    await queue.enqueue(revisionWork(namespaceId, sourceKey, agents[0], owner.revisionId));
    const claim = await claimExpected(queue, sourceKey);
    await queue.enqueue({
      ...revisionWork(namespaceId, successorKey, agents[0], owner.revisionId),
      actorId: "principal-conflicting-successor",
    });
    const before = await readRepositoryAttempts(pool, owner.revisionId);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const transactionQueue = new PostgresWorkQueue(client);
      await transactionQueue.fail(
        claim,
        { code: "MAINTENANCE_OUTAGE" },
        { continuingRevision: true },
      );
      await assert.rejects(
        transactionQueue.enqueue(
          revisionWork(namespaceId, successorKey, agents[0], owner.revisionId),
        ),
      );
      await client.query("ROLLBACK");
      assert.equal((await readQueueRow(pool, sourceKey)).state, "claimed");
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
          await pool.query(
            "SELECT id FROM occ.audit_events WHERE resource_id = $1 AND details->>'reasonCode' = 'MAINTENANCE_OUTAGE'",
            [owner.revisionId],
          )
        ).rowCount,
        0,
      );
      await client.query("BEGIN");
      await transactionQueue.fail(
        claim,
        { code: "MAINTENANCE_OUTAGE" },
        { continuingRevision: true },
      );
      await transactionQueue.enqueue(
        revisionWork(
          namespaceId,
          `agent_revision:${owner.revisionId}:maintenance:3`,
          agents[0],
          owner.revisionId,
        ),
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    assert.equal((await readQueueRow(pool, sourceKey)).state, "failed_permanent");
    assert.deepEqual(await readRepositoryAttempts(pool, owner.revisionId), before);
    assert.equal(
      await readQueueRow(
        pool,
        repositoryCleanupKey(owner.revisionId, sourceKey, "terminal-runtime"),
      ),
      undefined,
    );
    assert.equal(
      (await readQueueRow(pool, `agent_revision:${owner.revisionId}:maintenance:3`)).actor_id,
      claim.actorId,
    );
    assert.equal(
      (
        await pool.query(
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
  "ordinary",
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
      const { namespaceId, agents } = await createResources(pool);
      const owner = await createRepositoryRevision(
        pool,
        namespaceId,
        agents[0],
        ["open"],
        1,
        invalid === "expired deadline" ? Date.now() - 1000 : Date.now() + 3_600_000,
      );
      await pool.query(
        "UPDATE occ.agents SET active_revision_id = $2, desired_runtime_state = 'running' WHERE id = $1",
        [agents[0], owner.revisionId],
      );
      let sourceKey = `agent_revision:${owner.revisionId}:maintenance:1`;
      if (invalid === "ordinary") {
        sourceKey = `agent_revision:${owner.revisionId}:reconcile`;
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
      let input = revisionWork(namespaceId, sourceKey, agents[0], owner.revisionId);
      if (invalid === "stop") {
        input = {
          namespaceId,
          agentId: agents[0],
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
        await pool.query("UPDATE occ.agents SET desired_runtime_state = 'stopped' WHERE id = $1", [
          agents[0],
        ]);
      }
      if (invalid === "inactive") {
        await pool.query("UPDATE occ.agents SET active_revision_id = NULL WHERE id = $1", [
          agents[0],
        ]);
      }
      if (invalid === "namespace unavailable") {
        await pool.query("UPDATE occ.namespaces SET status = 'deleting' WHERE id = $1", [
          namespaceId,
        ]);
      }
      const before = await readRepositoryAttempts(pool, owner.revisionId);
      await assert.rejects(
        queue.fail(claim, { code: "INVALID_CONTINUATION" }, { continuingRevision: true }),
      );
      assert.equal((await readQueueRow(pool, sourceKey)).state, "claimed");
      assert.deepEqual(await readRepositoryAttempts(pool, owner.revisionId), before);
      assert.equal(
        (
          await pool.query(
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
    const { namespaceId, agents } = await createResources(pool);
    const owner = await createRepositoryRevision(pool, namespaceId, agents[0], ["closing", "open"]);
    // This is retained-owner recovery at the queue boundary; public deletion currently
    // requires an empty Namespace and cannot construct this fixture itself.
    await pool.query("UPDATE occ.namespaces SET status = 'deleting' WHERE id = $1", [namespaceId]);
    const sourceKey = `queue-delete-register:${randomUUID()}`;
    await queue.enqueue(namespaceWork(namespaceId, sourceKey, new Date(0), "deleted"));
    const source = await claimExpected(queue, sourceKey);
    const registered = await queue.enqueueRepositoryCleanup(source, owner);
    const cleanup = await claimExpected(queue, registered.idempotencyKey);
    await pool.query(
      "UPDATE occ.repository_session_attempts SET phase = 'disposed', updated_at = clock_timestamp() WHERE admission_id = $1",
      [owner.admissionIds[0]],
    );
    await queue.complete(cleanup);
    assert.equal((await readQueueRow(pool, registered.idempotencyKey)).state, "succeeded");
    // Admission already happened before deletion; only its closing transition is late.
    const newAdmissionId = owner.admissionIds[1];
    await pool.query(
      "UPDATE occ.repository_session_attempts SET phase = 'closing', updated_at = clock_timestamp() WHERE admission_id = $1",
      [newAdmissionId],
    );
    const requeued = await queue.enqueueRepositoryCleanup(source, owner);
    assert.equal(requeued.idempotencyKey, registered.idempotencyKey);
    assert.equal(requeued.state, "queued");
    assert.equal(requeued.actorId, source.actorId);
    assert.equal((await readQueueRow(pool, registered.idempotencyKey)).completed_at, null);
    const replay = await claimExpected(queue, registered.idempotencyKey);
    await pool.query(
      "UPDATE occ.repository_session_attempts SET phase = 'disposed', updated_at = clock_timestamp() WHERE admission_id = $1",
      [newAdmissionId],
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
    const { namespaceId, agents } = await createResources(pool);
    const owner = await createRepositoryRevision(pool, namespaceId, agents[0], ["open", "closing"]);
    await pool.query("UPDATE occ.agents SET desired_runtime_state = 'stopped' WHERE id = $1", [
      agents[0],
    ]);
    const sourceKey = `queue-stop-lock:${randomUUID()}`;
    await queue.enqueue({
      namespaceId,
      agentId: agents[0],
      agentTarget: "stopped",
      idempotencyKey: sourceKey,
      actorId: "principal-stop-lock",
    });
    const claim = await claimExpected(queue, sourceKey);
    const before = await readRepositoryAttempts(pool, owner.revisionId);
    const blocker = await pool.connect();
    const worker = await pool.connect();
    let failure;
    try {
      await blocker.query("BEGIN");
      await blocker.query("UPDATE occ.agents SET desired_runtime_state = 'running' WHERE id = $1", [
        agents[0],
      ]);
      // The queue statement begins while the old stopped value is still committed.
      // The writer releases running only after the queue demonstrably waits on its lock.
      failure = new PostgresWorkQueue(worker).fail(claim, { code: "STOP_LOCK_RACE" });
      failure.catch(() => {});
      let waiting = false;
      for (let index = 0; index < 100; index += 1) {
        const activity = await pool.query(
          "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
          [worker.processID],
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
      await blocker.query("COMMIT");
      await failure;
    } finally {
      await blocker.query("ROLLBACK");
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
