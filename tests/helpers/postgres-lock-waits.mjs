import { waitFor } from "./wait-for.mjs";

// Lock-order and race tests hold a row lock on one connection and need to know that the code
// under test really waits for it before they move on. These poll PostgreSQL's own lock graph
// (pg_blocking_pids) through `pool`, which must not be the holding or waiting connection.
// pg_blocking_pids is non-empty only for a backend waiting on a heavyweight lock, so no
// wait_event_type filter is needed.
// `options` are waitFor's ({ timeoutMs, intervalMs }) plus the extras below.

// Waits until a backend waits for a lock that `holderPid` holds and returns the lowest waiting
// pid (callers expect one waiter). With `count`, waits until at least that many do; with
// `queryLike`, counts only waiters whose current statement matches that LIKE pattern.
export function waitForLockWaiter(
  pool,
  holderPid,
  description,
  { count = 1, queryLike, ...options } = {},
) {
  return waitFor(
    description,
    async () => {
      const waiting = await pool.query(
        `SELECT pid FROM pg_stat_activity
         WHERE $1 = ANY(pg_blocking_pids(pid)) AND ($2::text IS NULL OR query LIKE $2)
         ORDER BY pid`,
        [holderPid, queryLike ?? null],
      );
      return waiting.rowCount >= count ? waiting.rows[0].pid : undefined;
    },
    options,
  );
}

// Waits until `waiterPid` waits for a lock another backend holds and returns the first holder's
// pid.
export function waitForLockHolder(pool, waiterPid, description, options) {
  return waitFor(
    description,
    async () => {
      const holders = await pool.query("SELECT pg_blocking_pids($1) AS pids", [waiterPid]);
      return holders.rows[0].pids[0];
    },
    options,
  );
}
