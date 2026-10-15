import type { PostgresPool } from "./postgres-state.ts";
import { PENDING_WORK_PREDICATE } from "./postgres-work-queue.ts";

export interface PlatformMetricsSnapshot {
  readonly agents: Readonly<
    Record<"draft" | "deploying" | "running" | "stopping" | "stopped" | "failed", number>
  >;
  readonly pending: number;
  readonly oldestPendingAgeSeconds: number;
}

/** Read-only operational projection of this database's singleton Installation. */
export class PostgresMetricsSnapshot {
  private readonly pool: PostgresPool;
  constructor(pool: PostgresPool) {
    this.pool = pool;
  }

  async collect(): Promise<PlatformMetricsSnapshot> {
    const client = await this.pool.connect();
    let failed = false;
    let transportError: Error | undefined;
    let snapshot: PlatformMetricsSnapshot;
    const onTransportError = (error: Error) => {
      transportError ??= error;
    };
    try {
      // A checked-out pg client owns transport errors until it returns to the pool.
      client.on?.("error", onTransportError);
      // One statement gives all gauges the same MVCC snapshot. The dedicated
      // pool supplies connection and server-side statement deadlines.
      const result = await client.query(`
        WITH latest_teardown AS (
          SELECT DISTINCT ON (agent_id) agent_id, state
          FROM occ.controller_work
          WHERE agent_target IN ('stopped', 'deleted')
          ORDER BY agent_id, created_at DESC, idempotency_key DESC
        ), unfinished_deployments AS (
          SELECT DISTINCT agent_id
          FROM occ.controller_work
          WHERE ${PENDING_WORK_PREDICATE}
            AND idempotency_key = 'agent_revision:' || revision_id || ':reconcile'
        ), agent_states AS (
          SELECT CASE
            WHEN a.status = 'deleting' THEN CASE
              WHEN teardown.state = 'failed_permanent' THEN 'failed'
              ELSE 'stopping'
            END
            WHEN a.desired_runtime_state = 'stopped' THEN CASE
              WHEN teardown.state = 'failed_permanent' THEN 'failed'
              WHEN a.active_revision_id IS NOT NULL
                OR teardown.state IN ('queued', 'claimed')
                OR unfinished.agent_id IS NOT NULL THEN 'stopping'
              WHEN revision.id IS NULL AND teardown.agent_id IS NULL THEN 'draft'
              ELSE 'stopped'
            END
            WHEN deployment.state = 'failed_permanent' THEN 'failed'
            WHEN deployment.state IN ('queued', 'claimed')
              OR a.active_revision_id IS DISTINCT FROM revision.id THEN 'deploying'
            ELSE 'running'
          END AS lifecycle_state
          FROM occ.agents a
          JOIN occ.namespaces n ON n.id = a.namespace_id AND n.deleted_at IS NULL
          LEFT JOIN LATERAL (
            SELECT id FROM occ.agent_revisions
            WHERE namespace_id = a.namespace_id AND agent_id = a.id
            ORDER BY revision_number DESC LIMIT 1
          ) revision ON true
          LEFT JOIN occ.controller_work deployment
            ON deployment.idempotency_key = 'agent_revision:' || revision.id || ':reconcile'
          LEFT JOIN latest_teardown teardown ON teardown.agent_id = a.id
          LEFT JOIN unfinished_deployments unfinished ON unfinished.agent_id = a.id
        )
        SELECT
          (SELECT jsonb_build_object(
            'draft', count(*) FILTER (WHERE lifecycle_state = 'draft'),
            'deploying', count(*) FILTER (WHERE lifecycle_state = 'deploying'),
            'running', count(*) FILTER (WHERE lifecycle_state = 'running'),
            'stopping', count(*) FILTER (WHERE lifecycle_state = 'stopping'),
            'stopped', count(*) FILTER (WHERE lifecycle_state = 'stopped'),
            'failed', count(*) FILTER (WHERE lifecycle_state = 'failed')
          ) FROM agent_states) AS agents,
          pending.count AS pending,
          pending.oldest AS "oldestPendingAgeSeconds"
        FROM occ.installation
        CROSS JOIN (
          SELECT count(*)::float8 AS count,
            COALESCE(GREATEST(0, extract(epoch FROM
              statement_timestamp() - min(created_at))), 0)::float8 AS oldest
          FROM occ.controller_work WHERE ${PENDING_WORK_PREDICATE}
        ) pending`);
      if (transportError !== undefined) {
        throw transportError;
      }
      const row = result.rows[0] as PlatformMetricsSnapshot | undefined;
      if (row === undefined) {
        throw new Error("Metrics require the singleton Installation.");
      }
      snapshot = row;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      // Wait for query settlement before returning the client. The pool takes
      // error ownership during release; retain ours if release itself fails.
      client.release(failed || transportError !== undefined);
      client.removeListener?.("error", onTransportError);
    }
    if (transportError !== undefined) {
      throw transportError;
    }
    return snapshot;
  }
}
