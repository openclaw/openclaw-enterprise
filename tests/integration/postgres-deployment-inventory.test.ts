import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import type { InstallationDeploymentInventoryResponse } from "../../packages/contracts/src/index.ts";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";

test(
  "deployment inventory bounds PostgreSQL queries across retained revision history",
  requiresPostgres,
  async (t) => {
    const { deployAgent, inject, pool, principal, state } = await createPostgresAgentApp(t, {
      label: "inventory-history",
      authSecret: "synthetic-deployment-inventory-auth-secret",
      controllerOptions: { recordOperations: true },
    });
    const { namespace, agent, revision } = await deployAgent("Inventory Agent");
    const completed = await pool.query(
      `UPDATE occ.controller_work
       SET state = 'succeeded', attempt_count = 1, completed_at = now(), updated_at = now(),
           reason_code = 'REVISION_ACTIVATED'
       WHERE idempotency_key = $1`,
      [`agent_revision:${revision.id}:reconcile`],
    );
    assert.equal(completed.rowCount, 1);
    await state.transact(async ({ agents, operations }) => {
      assert.ok(
        await agents.compareAndSetActiveRevision(namespace.id, agent.id, undefined, revision.id),
      );
      // Outstanding credential withdrawal on the active revision does not block inventory.
      await operations.append({
        kind: "agent_revision",
        action: "reconcile",
        target: "credentials_withdrawn",
        operationId: "inventory-withdrawal",
        namespaceId: namespace.id,
        resourceId: revision.id,
        actorId: principal.id,
      });
    });

    const appendHistory = async (
      offset: number,
      count: number,
      workState: "queued" | "failed_permanent",
      keySuffix = "reconcile",
    ) => {
      const inserted = await pool.query(
        `WITH history AS (
           INSERT INTO occ.agent_revisions
             (id, namespace_id, agent_id, revision_number, backend_id, admitted_spec,
              gateway_managed_mode, admitted_at)
           SELECT 'rev_' || gen_random_uuid(), namespace_id, agent_id, revision_number + n,
                  backend_id, admitted_spec, gateway_managed_mode, now()
           FROM occ.agent_revisions, generate_series($2::int, $2::int + $3::int - 1) AS n
           WHERE id = $1
           RETURNING id, namespace_id, agent_id
         )
         INSERT INTO occ.controller_work
           (idempotency_key, namespace_id, agent_id, revision_id, actor_id, state, available_at,
            attempt_count, completed_at, reason_code, created_at, updated_at)
         SELECT 'agent_revision:' || id || ':' || $6, namespace_id, agent_id, id, $4, $5, now(),
                CASE WHEN $5 = 'queued' THEN 0 ELSE 1 END,
                CASE WHEN $5 = 'queued' THEN NULL ELSE now() END,
                CASE WHEN $5 = 'queued' THEN NULL ELSE 'CONVERGENCE_DEADLINE_EXCEEDED' END,
                now(), now()
         FROM history`,
        [revision.id, offset, count, principal.id, workState, keySuffix],
      );
      assert.equal(inserted.rowCount, count);
    };

    // Count real pg calls around each request, including both inventory snapshots.
    const sql = t.mock.method(pg.Client.prototype, "query");
    const inventoryPath = "/installation/deployment-inventory";
    const read = async () => {
      const before = sql.mock.callCount();
      const reply = await inject("GET", inventoryPath);
      const queries = sql.mock.callCount() - before;
      assert.equal(reply.statusCode, 200, reply.body);
      const inventory = reply.json<InstallationDeploymentInventoryResponse>().data;
      const selected = inventory.namespaces
        .find(({ id }) => id === namespace.id)
        ?.agents.find(({ id }) => id === agent.id);
      assert.ok(selected);
      assert.equal(selected.activeRevisionId, revision.id);
      return { inventory, selected, queries };
    };
    const small = await read();
    assert.equal(small.selected.deploymentInProgress, false);
    assert.equal(small.selected.repositoryWorkerRestart, "unknown");

    // Failed replacements leave the original revision active, while still adding durable work.
    const historicalRevisions = 1024;
    await appendHistory(1, historicalRevisions, "failed_permanent");
    const populated = await read();
    assert.deepEqual(populated.inventory, small.inventory);

    await appendHistory(historicalRevisions + 1, 1, "queued");
    const pending = await read();
    assert.equal(pending.selected.deploymentInProgress, true);
    assert.equal(pending.selected.repositoryWorkerRestart, undefined);

    // A retained lifecycle row with no exact reconcile key makes the inventory incomplete.
    await appendHistory(historicalRevisions + 2, 1, "failed_permanent", "invalid-key");
    const incomplete = await inject("GET", inventoryPath);
    assert.equal(incomplete.statusCode, 503, incomplete.body);
    assert.equal(incomplete.json().error.code, "DEPENDENCY_UNAVAILABLE");
    assert.deepEqual(Object.keys(incomplete.json()).sort(), ["error", "meta"]);

    // A later malformed work row must not mask the earlier incomplete operation.
    const malformedRevision = historicalRevisions + 3;
    await appendHistory(malformedRevision, 1, "failed_permanent");
    const malformed = await pool.query(
      `UPDATE occ.controller_work AS work SET available_at = 'infinity'
       FROM occ.agent_revisions AS revision
       WHERE work.revision_id = revision.id AND revision.agent_id = $1
         AND revision.revision_number = $2`,
      [agent.id, revision.revision + malformedRevision],
    );
    assert.equal(malformed.rowCount, 1);
    const firstRefusal = await inject("GET", inventoryPath);
    assert.equal(firstRefusal.statusCode, 503, firstRefusal.body);
    assert.deepEqual(firstRefusal.json().error, incomplete.json().error);

    t.diagnostic(
      `Inventory queries with 0 and ${historicalRevisions} historical revisions: ${small.queries} and ${populated.queries}`,
    );
    assert.ok(small.queries > 0, "inventory must read PostgreSQL");
    assert.ok(
      populated.queries <= small.queries + 2,
      `terminal history must not add per-revision database queries (${small.queries} → ${populated.queries})`,
    );
  },
);
