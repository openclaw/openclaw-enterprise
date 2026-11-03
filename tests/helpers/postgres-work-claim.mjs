import { PostgresWorkQueue } from "../../packages/occ/src/state/postgres-work-queue.ts";

/**
 * Claims one test's controller work through the real queue while other suites keep work in the
 * same database. It locks every other row (`workId`: all other work; `namespaceId`: work in other
 * Namespaces) on one connection, so the queue's SKIP LOCKED claim on another connection selects
 * only this test's work, then releases the locks. Nothing else is changed.
 * @param {any} pool
 * @param {{ workId: string } | { namespaceId: string }} scope
 */
export async function claimIsolatedWork(pool, scope) {
  const [column, value] =
    "workId" in scope ? ["idempotency_key", scope.workId] : ["namespace_id", scope.namespaceId];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT idempotency_key FROM occ.controller_work WHERE ${column} <> $1 FOR UPDATE SKIP LOCKED`,
      [value],
    );
    // Claim on another connection: PostgreSQL does not skip a transaction's own locks.
    const claim = await new PostgresWorkQueue(pool).claim();
    await client.query("COMMIT");
    return claim;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
