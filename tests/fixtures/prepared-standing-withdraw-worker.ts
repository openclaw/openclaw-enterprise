import assert from "node:assert/strict";
import { parentPort, workerData } from "node:worker_threads";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { withPool, databaseUrl } from "../helpers/postgres-database.mjs";

const { approval, admissionId, shared } = workerData as {
  approval: { namespaceId: string; agentId: string; id: string; generation: number };
  admissionId: string;
  shared: SharedArrayBuffer;
};
const outcome = new Int32Array(shared);
try {
  await withPool(databaseUrl, async (pool) => {
    const state = new PostgresPlatformState(pool);
    await pool.query("SELECT 1");
    parentPort!.postMessage("ready");
    await new Promise((resolve) => parentPort!.once("message", resolve));
    const uses = await pool.query(
      "SELECT count(*)::int AS n FROM occ.prepared_repository_git_uses WHERE admission_id=$1",
      [admissionId],
    );
    assert.equal(uses.rows[0].n, 2);
    await state.transact(async (u) => {
      assert.ok(await u.namespaces.lockNamespace(approval.namespaceId, { includeDeleted: true }));
      assert.ok(await u.agents.lockAgent(approval.namespaceId, approval.agentId));
      await u.repositorySessions.revokeStanding(approval, new Date().toISOString());
    });
    Atomics.store(outcome, 0, 1);
    Atomics.notify(outcome, 0);
  });
} finally {
  Atomics.compareExchange(outcome, 0, 0, -1);
  Atomics.notify(outcome, 0);
  parentPort!.close();
}
