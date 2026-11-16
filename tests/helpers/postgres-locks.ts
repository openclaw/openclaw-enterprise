import assert from "node:assert/strict";
import type { Pool } from "pg";
import { waitFor } from "./wait-for.mjs";

type WaitDescription = Parameters<typeof waitFor>[0];
type WaitOptions = Parameters<typeof waitFor>[2];

interface WaiterOptions {
  count?: number;
  queryLike?: string;
  timeoutMs?: number;
  intervalMs?: number;
}

interface NamespaceLockProbe {
  waitForBlocked(description: string): Promise<number>;
  assertNotHeld(sql: string, params: unknown[], message: string): Promise<void>;
}

// Observe the real lock graph on a connection separate from the holder and waiters.
// Return the lowest matching PID once at least count sessions are waiting.
export function waitForLockWaiter(
  pool: Pool,
  holderPid: number,
  description: WaitDescription,
  { count = 1, queryLike, ...options }: WaiterOptions = {},
): Promise<number> {
  return waitFor<number>(
    description,
    async () => {
      const waiting = await pool.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity
         WHERE $1 = ANY(pg_blocking_pids(pid)) AND ($2::text IS NULL OR query LIKE $2)
         ORDER BY pid`,
        [holderPid, queryLike ?? null],
      );
      return (waiting.rowCount ?? 0) >= count ? waiting.rows[0]?.pid : undefined;
    },
    options,
  );
}

// Return the first holder in the order pg_blocking_pids reports.
export function waitForLockHolder(
  pool: Pool,
  waiterPid: number,
  description: WaitDescription,
  options?: WaitOptions,
): Promise<number> {
  return waitFor<number>(
    description,
    async () => {
      const holders = await pool.query<{ pids: number[] }>("SELECT pg_blocking_pids($1) AS pids", [
        waiterPid,
      ]);
      return holders.rows[0]?.pids[0];
    },
    options,
  );
}

// Hold a Namespace row while the probe checks a Namespace-first path. Once the tested
// transaction waits on that row, the holder can use FOR UPDATE NOWAIT to check whether
// the waiter took a later lock out of order.
export async function withNamespaceLockHeld<T>(
  pool: Pool,
  namespaceId: string,
  probe: (lock: NamespaceLockProbe) => Promise<T>,
): Promise<T> {
  const holder = await pool.connect();
  let failed = false;
  try {
    await holder.query("BEGIN");
    const backend = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    const current = backend.rows[0];
    assert.ok(current);
    await holder.query("SELECT id FROM occ.namespaces WHERE id = $1 FOR UPDATE", [namespaceId]);
    const result = await probe({
      waitForBlocked: (description) => waitForLockWaiter(pool, current.pid, description),
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
