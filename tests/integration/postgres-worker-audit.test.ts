import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { PostgresWorkQueue } from "../../packages/occ/src/state/postgres-work-queue.ts";
import { createDevelopmentComputeDriver } from "../helpers/development.ts";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { databaseUrl, withPool } from "../helpers/postgres-database.mjs";
import { waitUntil } from "../helpers/wait-for.mjs";

const migrationUrl = process.env.OCC_TEST_WORKER_AUDIT_MIGRATION_DATABASE_URL;
const claimAction = "openclaw.controller_work.claimed";

test(
  "PostgreSQL commits a worker claim and its audit record before Compute",
  {
    skip: migrationUrl ? false : "Prepare the dedicated postgres-platform file fixture.",
    timeout: 30_000,
  },
  async (context) => {
    // The test changes the audit table briefly. Require this file's disposable CI database.
    assert.ok(databaseUrl && migrationUrl, "The test needs app and migrator URLs.");
    assert.ok(URL.canParse(databaseUrl) && URL.canParse(migrationUrl), "Invalid fixture URLs.");
    const appTarget = new URL(databaseUrl);
    const migratorTarget = new URL(migrationUrl);
    assert.ok(
      [appTarget, migratorTarget].every(
        (url) =>
          url.protocol === "postgresql:" &&
          url.hostname === "127.0.0.1" &&
          url.port !== "" &&
          /^\/openclaw_ci_postgres_worker_audit_[a-f0-9]{12}$/.test(url.pathname) &&
          url.search === "" &&
          url.hash === "",
      ) &&
        appTarget.port === migratorTarget.port &&
        appTarget.pathname === migratorTarget.pathname &&
        appTarget.username === "occ_app" &&
        migratorTarget.username === "occ_migrator",
      "Both roles must use the same disposable worker audit database.",
    );

    const { inject, pool, principal } = await createPostgresAgentApp(context, {
      label: "worker-audit",
      authSecret: "worker-audit-fixture-signing-secret",
      requestAudit: true,
      controllerOptions: { recordOperations: true },
    });
    await withPool(migrationUrl, async (migrator: pg.Pool) => {
      // Failing the enqueue evidence must also undo the admitted operation's state change.
      await migrator.query(`ALTER TABLE occ.audit_events ADD CONSTRAINT reject_enqueue_audit
        CHECK (action <> 'openclaw.controller_work.queued') NOT VALID`);
      try {
        const refused = await inject("POST", "/namespaces", { name: "Refused enqueue" });
        assert.equal(refused.statusCode, 503, refused.body);
        const saved = await pool.query("SELECT 1 FROM occ.namespaces WHERE name = $1", [
          "Refused enqueue",
        ]);
        assert.equal(saved.rowCount, 0);
      } finally {
        await migrator.query("ALTER TABLE occ.audit_events DROP CONSTRAINT reject_enqueue_audit");
      }
    });
    const created = await inject("POST", "/namespaces", { name: "Worker audit" });
    assert.equal(created.statusCode, 201, created.body);
    const namespaceId = created.json().data.id as string;
    const workId = `namespace:${namespaceId}:reconcile:ready`;
    const queue = new PostgresWorkQueue(pool);
    const queued = await pool.query(
      `SELECT actor_id, outcome, resource_kind, resource_id, details->>'workId' AS work_id,
              details->'__occAuditMetadata'->>'requestId' AS request_id
       FROM occ.audit_events WHERE action = 'openclaw.controller_work.queued'
       AND namespace_id = $1`,
      [namespaceId],
    );
    assert.deepEqual(queued.rows, [
      {
        actor_id: principal.id,
        outcome: "success",
        resource_kind: "namespace",
        resource_id: namespaceId,
        work_id: workId,
        request_id: created.headers["x-request-id"],
      },
    ]);

    const compute = createDevelopmentComputeDriver();
    let observedClaims: Array<{ id: string; details: unknown }> = [];
    let computeCalls = 0;
    let claimFailed = false;
    const worker = createControllerWorker({
      pool: new pg.Pool({ connectionString: databaseUrl }),
      mode: "development",
      pollIntervalMs: 20,
      computeDriver: {
        ...compute,
        async ensureNamespace(namespace) {
          if (namespace.id !== namespaceId) {
            return compute.ensureNamespace(namespace);
          }
          computeCalls += 1;
          // A separate connection must see the committed claim record as the effect starts.
          const audit = await pool.query(
            `SELECT id, actor_id, kind, outcome, namespace_id, resource_kind, details
             FROM occ.audit_events WHERE action = $1 AND resource_id = $2
             ORDER BY occurred_at, id`,
            [claimAction, namespace.id],
          );
          observedClaims = audit.rows;
          if (computeCalls < 3) {
            return { namespaceId: namespace.id, namespaceReady: false };
          }
          return compute.ensureNamespace(namespace);
        },
      },
      emit(event) {
        if (event.event === "worker.error" && event.code === "WORKER_UNAVAILABLE") {
          claimFailed = true;
        }
      },
    });
    context.after(() => worker.stop());

    const capacityPool = new pg.Pool({
      connectionString: databaseUrl,
      options: "-c occ.control_plane_audit_max_bytes=1",
    });
    let capacityRefusal = false;
    const capacityWorker = createControllerWorker({
      pool: capacityPool,
      pollIntervalMs: 20,
      computeDriver: {
        ...compute,
        async ensureNamespace(namespace) {
          if (namespace.id === namespaceId) {
            computeCalls += 1;
          }
          return compute.ensureNamespace(namespace);
        },
      },
      emit(event) {
        if (event.event === "worker.error" && event.code === "AUDIT_CAPACITY_EXCEEDED") {
          capacityRefusal = true;
        }
      },
    });
    try {
      // The real capacity guard stops dispatch and keeps the work eligible for another worker.
      await assert.rejects(new PostgresWorkQueue(capacityPool).claim({ recordAudit: true }), {
        code: "53400",
        constraint: "control_plane_audit_capacity",
      });
      await capacityWorker.start();
      await waitUntil("the worker to report audit capacity refusal", () => capacityRefusal);
      const stillQueued = await queue.findWork(workId);
      assert.equal(stillQueued?.state, "queued");
      assert.equal(stillQueued?.attemptCount, 0);
      assert.equal(computeCalls, 0);
    } finally {
      await capacityWorker.stop();
    }

    await withPool(migrationUrl, async (migrator: pg.Pool) => {
      // PostgreSQL must reject the audit insert after the statement has selected the work.
      await migrator.query(`ALTER TABLE occ.audit_events
        ADD CONSTRAINT reject_worker_claim_audit
        CHECK (action <> 'openclaw.controller_work.claimed') NOT VALID`);
      try {
        await assert.rejects(queue.claim({ recordAudit: true }), {
          code: "23514",
          constraint: "reject_worker_claim_audit",
        });
        await worker.start();
        await waitUntil("the worker to report the failed claim", () => claimFailed);
        const failedClaim = await queue.findWork(workId);
        assert.ok(failedClaim);
        assert.equal(failedClaim.state, "queued");
        assert.equal(failedClaim.attemptCount, 0);
        assert.equal(computeCalls, 0);
      } finally {
        await migrator.query(
          "ALTER TABLE occ.audit_events DROP CONSTRAINT reject_worker_claim_audit",
        );
      }
    });

    await waitUntil(
      "the worker to complete the original Namespace operation",
      async () => (await queue.findWork(workId))?.state === "succeeded",
    );
    assert.equal(computeCalls, 3);
    const completed = await queue.findWork(workId);
    const attemptId = completed?.auditAttemptId;
    assert.match(attemptId ?? "", /^aud_[a-f0-9-]{36}$/);
    const attemptIds = observedClaims.map(({ id }) => id);
    assert.equal(attemptIds.length, 3);
    assert.equal(new Set(attemptIds).size, 3);
    assert.equal(attemptId, attemptIds[2]);
    assert.deepEqual(
      observedClaims,
      attemptIds.map((id) => ({
        id,
        actor_id: principal.id,
        kind: "mutation",
        outcome: "success",
        namespace_id: namespaceId,
        resource_kind: "namespace",
        details: {
          reasonCode: "WORK_CLAIMED",
          workId,
          attemptCount: 1,
          attemptId: id,
          workState: "claimed",
        },
      })),
    );
    // A pending pass refunds the attempt count. Its event still links to the unique claim.
    // The repeat uses a separate deferred event because existing progress coalesces repeats.
    const settlements = await pool.query(
      `SELECT action, details->>'attemptId' AS attempt_id, details->>'workState' AS work_state
       FROM occ.audit_events WHERE action IN ('reconcile', 'openclaw.controller_work.deferred')
         AND details->>'workId' = $1
       ORDER BY occurred_at, id`,
      [workId],
    );
    assert.deepEqual(settlements.rows, [
      { action: "reconcile", attempt_id: attemptIds[0], work_state: "queued" },
      {
        action: "openclaw.controller_work.deferred",
        attempt_id: attemptIds[1],
        work_state: "queued",
      },
      { action: "reconcile", attempt_id: attemptIds[2], work_state: "succeeded" },
    ]);

    await worker.stop();
    const pending = await inject("POST", "/namespaces", { name: "Capacity during settlement" });
    assert.equal(pending.statusCode, 201, pending.body);
    const pendingNamespace = pending.json().data.id as string;
    const claim = await queue.claim({ recordAudit: true });
    assert.equal(claim?.namespaceId, pendingNamespace);
    assert.ok(claim?.auditAttemptId);
    // Capacity can run out after a valid claim. The queue must keep that claim unsettled.
    const fullLedger = new pg.Pool({
      connectionString: databaseUrl,
      options: "-c occ.control_plane_audit_max_bytes=1",
    });
    try {
      await assert.rejects(new PostgresWorkQueue(fullLedger).complete(claim), {
        code: "53400",
        constraint: "control_plane_audit_capacity",
      });
      assert.equal((await queue.findWork(claim.idempotencyKey))?.state, "claimed");
      const refused = await pool.query(
        `SELECT 1 FROM occ.audit_events WHERE action = 'reconcile' AND details->>'attemptId' = $1`,
        [claim.auditAttemptId],
      );
      assert.equal(refused.rowCount, 0);
    } finally {
      await fullLedger.end();
    }
  },
);
