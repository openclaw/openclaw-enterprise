import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import type { InstallationDeploymentInventoryResponse } from "../../packages/contracts/src/index.ts";
import { seedInventoryAgent } from "../helpers/postgres-inventory-agent.ts";
import { requiresPostgres } from "../helpers/postgres-database.mjs";

test(
  "deployment inventory bounds PostgreSQL queries across retained revision history",
  requiresPostgres,
  async (t) => {
    const { agent, appendHistory, inject, namespace, pool, revision } = await seedInventoryAgent(
      t,
      "inventory-history",
    );

    // Count real pg calls around each request, including both inventory snapshots.
    const sql = t.mock.method(pg.Client.prototype, "query");
    const inventoryPath = "/installation/deployment-inventory";
    const read = async () => {
      const before = sql.mock.callCount();
      const reply = await inject("GET", inventoryPath);
      const calls = sql.mock.calls.slice(before);
      const queries = calls.length;
      let rows = 0;
      for (const call of calls) {
        const result = (await call.result) as { rows?: unknown[] } | undefined;
        rows += result?.rows?.length ?? 0;
      }
      assert.equal(reply.statusCode, 200, reply.body);
      const inventory = reply.json<InstallationDeploymentInventoryResponse>().data;
      const selected = inventory.namespaces
        .find(({ id }) => id === namespace.id)
        ?.agents.find(({ id }) => id === agent.id);
      assert.ok(selected);
      assert.equal(selected.activeRevisionId, revision.id);
      return { inventory, selected, queries, rows };
    };
    const small = await read();
    assert.equal(small.selected.deploymentInProgress, false);
    assert.equal(small.selected.repositoryWorkerRestart, "unknown");

    // Failed replacements leave the original revision active, while still adding durable work.
    const historicalRevisions = 1024;
    await appendHistory(1, historicalRevisions, "failed_permanent");
    const populated = await read();
    assert.deepEqual(populated.inventory, small.inventory);
    // Settled history stays in PostgreSQL: the rows read do not grow with it.
    assert.equal(populated.rows, small.rows, "settled history must not add rows read");

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
      `Inventory queries and rows with 0 and ${historicalRevisions} historical revisions: ${small.queries}/${small.rows} and ${populated.queries}/${populated.rows}`,
    );
    assert.ok(small.queries > 0, "inventory must read PostgreSQL");
    assert.ok(
      populated.queries <= small.queries + 2,
      `terminal history must not add per-revision database queries (${small.queries} → ${populated.queries})`,
    );
  },
);
