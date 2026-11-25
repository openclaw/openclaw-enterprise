import type { Pool, QueryResult, QueryResultRow } from "pg";

import { summarizeWorkerEvents, workerDiagnosticLines } from "./k3d-failure-diagnostics.ts";
import { diagnosticDeadlinePassed } from "./kubernetes-real.ts";

export const diagnosticQueryTimeoutMs = 3_000;

type RevisionIdentity = {
  namespaceId: string;
  agentId: string;
  revisionId: string;
};

type ControllerWorkRow = {
  revision_id: string | null;
  namespace_target: string | null;
  state: string;
  attempt_count: number;
  completed: boolean;
};

type QueueEntry = {
  operation: "work.reconcile" | `namespace.${string}` | "agent_revision.reconcile";
  revisionId: string | undefined;
  state: string;
  attempt: number;
  completed: boolean;
};

type PersistedWorkerState = {
  activeRevisionId: string | null | undefined;
  revision: { revisionId: string; revisionNumber: string } | undefined;
  queue: QueueEntry[];
};

type WorkerCompletionDiagnostic = {
  operation: "agent_revision.reconcile";
  revisionId: string;
  persisted: PersistedWorkerState | { readError: "unavailable" };
  events: ReturnType<typeof summarizeWorkerEvents>;
};

export async function diagnosticQuery<Row extends QueryResultRow = Record<string, unknown>>(
  pool: Pool,
  text: string,
  values: string[],
): Promise<QueryResult<Row>> {
  const query = { text, values, query_timeout: diagnosticQueryTimeoutMs };
  return pool.query<Row>(query);
}

async function readWorkerRevisionState(
  pool: Pool,
  { namespaceId, agentId, revisionId }: RevisionIdentity,
): Promise<PersistedWorkerState> {
  const [agent, revision, work] = await Promise.all([
    diagnosticQuery<{ active_revision_id: string | null }>(
      pool,
      "SELECT active_revision_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
      [namespaceId, agentId],
    ),
    diagnosticQuery<{ revision_number: string }>(
      pool,
      `SELECT revision_number
       FROM occ.agent_revisions
       WHERE namespace_id = $1 AND agent_id = $2 AND id = $3`,
      [namespaceId, agentId, revisionId],
    ),
    diagnosticQuery<ControllerWorkRow>(
      pool,
      `SELECT revision_id, namespace_target, state, attempt_count, completed_at IS NOT NULL AS completed
       FROM occ.controller_work
       WHERE namespace_id = $1 AND (revision_id = $2 OR agent_id = $3)
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 8`,
      [namespaceId, revisionId, agentId],
    ),
  ]);

  return {
    activeRevisionId: agent.rows[0]?.active_revision_id,
    revision: revision.rows[0]
      ? { revisionId, revisionNumber: revision.rows[0].revision_number }
      : undefined,
    queue: work.rows.map((row): QueueEntry => ({
      operation:
        row.revision_id === null
          ? row.namespace_target === null
            ? "work.reconcile"
            : `namespace.${row.namespace_target}`
          : "agent_revision.reconcile",
      revisionId: row.revision_id ?? undefined,
      state: row.state,
      attempt: row.attempt_count,
      completed: row.completed,
    })),
  };
}

// The reporter keeps 1,000 characters of each output line, so the persisted state comes before
// the event list. Returns the diagnostic for callers that also put it in a failure message.
export async function writeWorkerCompletionDiagnostics(
  options: RevisionIdentity & {
    pool: Pool;
    events: readonly Readonly<Record<string, unknown>>[];
  },
): Promise<WorkerCompletionDiagnostic> {
  let persisted: WorkerCompletionDiagnostic["persisted"];
  try {
    persisted = await readWorkerRevisionState(options.pool, options);
  } catch {
    persisted = { readError: "unavailable" };
  }
  const diagnostic: WorkerCompletionDiagnostic = {
    operation: "agent_revision.reconcile",
    revisionId: options.revisionId,
    persisted,
    events: summarizeWorkerEvents(options.events, options.revisionId),
  };
  for (const line of workerDiagnosticLines(diagnostic)) {
    if (diagnosticDeadlinePassed()) {
      break;
    }
    process.stderr.write(`${line}\n`);
  }
  return diagnostic;
}
