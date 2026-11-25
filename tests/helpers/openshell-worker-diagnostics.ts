import type { Pool, QueryResult, QueryResultRow } from "pg";

import { summarizeWorkerEvents, workerDiagnosticLines } from "./k3d-failure-diagnostics.ts";
import {
  diagnosticDeadlineMs,
  diagnosticDeadlinePassed,
  withinDiagnosticDeadline,
} from "./kubernetes-real.ts";

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

// The thrown value controls even its name. Report only known error classes, never its text.
const diagnosticErrorNames = new Set([
  "AbortError",
  "AggregateError",
  "AssertionError",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TimeoutError",
  "TypeError",
  "URIError",
]);

function diagnosticErrorName(error: unknown): string {
  try {
    const name = typeof error === "object" && error !== null && "name" in error && error.name;
    return typeof name === "string" && diagnosticErrorNames.has(name) ? name : "Error";
  } catch {
    return "Error";
  }
}

type RevisionFailureCallbacks = {
  readWorker: () => unknown;
  describe: (worker: object | undefined) => string | PromiseLike<string>;
};

export async function describeRevisionFailure({
  flow,
  readWorker,
  describe,
  timeoutMs = diagnosticDeadlineMs,
}: RevisionFailureCallbacks & {
  flow: "Recovery" | "Replacement";
  timeoutMs?: number;
}): Promise<string> {
  // Give the description its full budget even if the worker uses all of its own.
  const read = await withinDiagnosticDeadline(
    () =>
      Promise.resolve()
        .then(readWorker)
        .catch(() => null),
    { timeoutMs, timedOut: null },
  );
  const worker = typeof read === "object" && read !== null ? read : undefined;
  return withinDiagnosticDeadline(
    () =>
      Promise.resolve()
        .then(() => describe(worker))
        .catch(
          (error: unknown) => `\n${flow} diagnostic unavailable: ${diagnosticErrorName(error)}`,
        ),
    { timeoutMs, timedOut: `\n${flow} diagnostic timed out after ${timeoutMs / 1_000} s` },
  );
}

// Finding 2017: after the gateway outage the held deployment can end failed_permanent with
// RUNTIME_LOGIN_FAILED. The proof reads why near the failure, before its refresh checks take
// minutes and the failed revision's Pods go: `readWorker` gives the worker's events and persisted
// state, and `describe(worker)` the revision's Pods with the Gateway, Harness and OpenShell
// supervisor log tails. Each read stops at the diagnostic deadline, and one that fails or stalls
// only says so: it never replaces the failure it explains. The text is written to stderr, added
// to `failure`'s message when the wait itself failed, and returned for the assertion.
export async function failedRecoveryDiagnostic(
  {
    readWorker,
    describe,
    failure,
    write = (text) => process.stderr.write(text),
  }: RevisionFailureCallbacks & {
    failure?: Error | undefined;
    write?: (text: string) => unknown;
  },
  { timeoutMs = diagnosticDeadlineMs } = {},
) {
  const detail = await describeRevisionFailure({
    flow: "Recovery",
    readWorker,
    describe,
    timeoutMs,
  });
  write(`OpenShell integration: gateway outage recovery failed.${detail}\n`);
  if (failure instanceof Error) {
    failure.message = `${failure.message}${detail}`;
  }
  return detail;
}

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
