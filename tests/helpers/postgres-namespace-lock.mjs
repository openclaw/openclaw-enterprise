import assert from "node:assert/strict";
import { waitFor } from "./wait-for.mjs";

// Holds a Namespace row lock on its own connection while `probe` runs, as the Namespace-first
// paths take it (deployment admission, withdrawal requests, Agent stop and delete). Lock-order
// tests use it to catch a transaction that waits for the Namespace while it already holds a
// row those paths lock later:
// - `waitForBlocked(description)` resolves once another backend really waits on this lock.
// - `assertNotHeld(sql, params, message)` runs the caller's `FOR UPDATE NOWAIT` query on the
//   holding connection, which fails if the waiting transaction already holds that row.
// When `probe` settles the transaction rolls back, releasing the lock, and the helper returns
// `probe`'s result. After a failure the connection is discarded instead of returned to the pool.
export async function withNamespaceLockHeld(pool, namespaceId, probe) {
  const holder = await pool.connect();
  let failed = false;
  try {
    await holder.query("BEGIN");
    const backend = await holder.query("SELECT pg_backend_pid() AS pid");
    await holder.query("SELECT id FROM occ.namespaces WHERE id = $1 FOR UPDATE", [namespaceId]);
    const result = await probe({
      waitForBlocked: (description) =>
        waitFor(description, async () => {
          const waiting = await pool.query(
            `SELECT pid FROM pg_stat_activity
             WHERE wait_event_type = 'Lock' AND $1 = ANY(pg_blocking_pids(pid))`,
            [backend.rows[0].pid],
          );
          return waiting.rowCount > 0 ? true : undefined;
        }),
      assertNotHeld: (sql, params, message) =>
        assert.doesNotReject(holder.query(sql, params), message),
    });
    await holder.query("ROLLBACK");
    return result;
  } catch (error) {
    failed = true;
    await holder.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    holder.release(failed);
  }
}
