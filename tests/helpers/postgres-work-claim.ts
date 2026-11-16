import type { Pool } from "pg";
import { PostgresWorkQueue, type ClaimedWork } from "../../packages/occ/src/index.ts";

type WorkScope = { workId: string } | { namespaceId: string };

// Guard competing rows visible to the locking statement. Rows inserted after its
// snapshot can still be claimed. Use another connection for the real queue claim
// because PostgreSQL does not skip a transaction's own locks.
export async function claimIsolatedWork(
  pool: Pool,
  scope: WorkScope,
): Promise<ClaimedWork | undefined> {
  const [column, value] =
    "workId" in scope ? ["idempotency_key", scope.workId] : ["namespace_id", scope.namespaceId];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT idempotency_key FROM occ.controller_work WHERE ${column} <> $1 FOR UPDATE SKIP LOCKED`,
      [value],
    );
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
