import { postgresStandingRepositoryApprovals } from "./postgres-standing-repository-approvals.ts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { repositoryRemovalWorkKey } from "../repository-withdrawal.ts";
import { DependencyUnavailableError, ScopeViolationError } from "../errors.ts";
import type {
  RepositorySessionAttempt,
  RepositoryBrokerReceipt,
  RepositorySessionPhase,
  RepositorySessionRepository,
} from "../ports/repository-sessions.ts";
import type { PostgresQueryClient } from "./postgres-work-queue.ts";

const columns = `namespace_id, agent_id, revision_id, repository_ref, admission_id,
  duration_seconds, deadline_wall_ms, phase, session_id, created_at, updated_at,
  live_revision_id, cleanup_context, broker_protocol, predecessor_admission_id, execution_fingerprint`;

function attemptFromRow(value: unknown): Readonly<RepositorySessionAttempt> {
  const row = value as Record<string, unknown>;
  const text = (key: string): string => {
    if (typeof row[key] !== "string") {
      throw new DependencyUnavailableError("Persisted repository session state is invalid.");
    }
    return row[key];
  };
  const timestamp = (key: string): string => {
    const value = row[key];
    const date = value instanceof Date ? value : new Date(text(key));
    if (!Number.isFinite(date.getTime())) {
      throw new DependencyUnavailableError("Persisted repository session timestamp is invalid.");
    }
    return date.toISOString();
  };
  const durationSeconds = Number(row.duration_seconds);
  const deadlineWallMs = Number(row.deadline_wall_ms);
  const phase = text("phase");
  const brokerProtocol = Number(row.broker_protocol);
  if (
    !Number.isSafeInteger(durationSeconds) ||
    durationSeconds <= 0 ||
    !Number.isSafeInteger(deadlineWallMs) ||
    deadlineWallMs <= 0 ||
    ![0, 1, 2, 3].includes(brokerProtocol) ||
    !["opening", "open", "closing", "disposed", "invalidated"].includes(phase)
  ) {
    throw new DependencyUnavailableError("Persisted repository session input or phase is invalid.");
  }
  return immutableCopy({
    namespaceId: text("namespace_id"),
    agentId: text("agent_id"),
    revisionId: text("revision_id"),
    liveRevisionId: row.live_revision_id === null ? null : text("live_revision_id"),
    cleanupContext: row.cleanup_context as RepositorySessionAttempt["cleanupContext"],
    repositoryRef: text("repository_ref"),
    admissionId: text("admission_id"),
    durationSeconds,
    deadlineWallMs,
    phase: phase as RepositorySessionPhase,
    brokerProtocol: brokerProtocol as 0 | 1 | 2 | 3,
    ...(row.predecessor_admission_id == null
      ? {}
      : { predecessorAdmissionId: text("predecessor_admission_id") }),
    ...(row.execution_fingerprint == null
      ? {}
      : { executionFingerprint: text("execution_fingerprint") }),
    ...(row.session_id === null ? {} : { sessionId: text("session_id") }),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  });
}

const receiptColumns = `admission_id, state, generation, session_id, deadline_wall_ms, revoked, expired`;

function receiptFromRow(value: unknown): Readonly<RepositoryBrokerReceipt> {
  const row = value as Record<string, unknown>;
  const state = row.state;
  if (
    typeof row.admission_id !== "string" ||
    !["fenced", "reserved", "active", "disposed"].includes(String(state))
  ) {
    throw new DependencyUnavailableError("Persisted broker receipt is invalid.");
  }
  const number = (key: string): number | undefined => {
    if (row[key] === null) {
      return undefined;
    }
    const result = Number(row[key]);
    if (!Number.isSafeInteger(result) || result < 0) {
      throw new DependencyUnavailableError("Persisted broker receipt is invalid.");
    }
    return result;
  };
  const deadlineWallMs = number("deadline_wall_ms");
  const revoked = number("revoked");
  const expired = number("expired");
  return immutableCopy({
    admissionId: row.admission_id,
    state: state as RepositoryBrokerReceipt["state"],
    ...(typeof row.generation === "string" ? { generation: row.generation } : {}),
    ...(typeof row.session_id === "string" ? { sessionId: row.session_id } : {}),
    ...(deadlineWallMs === undefined ? {} : { deadlineWallMs }),
    ...(revoked === undefined ? {} : { revoked }),
    ...(expired === undefined ? {} : { expired }),
  });
}

/** Uses the enclosing State transaction; database constraints own persisted invariants. */
export function postgresRepositorySessions(
  client: PostgresQueryClient,
): RepositorySessionRepository {
  return {
    ...postgresStandingRepositoryApprovals(client),
    async findStandingExecution(owner) {
      const r = await client.query(
        'SELECT execution_id AS "executionId", fingerprint, closed FROM occ.repository_standing_executions WHERE namespace_id=$1 AND agent_id=$2 AND revision_id=$3',
        [owner.namespaceId, owner.agentId, owner.revisionId],
      );
      return r.rows[0] as { executionId: string; fingerprint: string; closed: boolean } | undefined;
    },
    async recordStandingExecution(owner, execution) {
      await client.query("SELECT occ.record_repository_standing_execution($1,$2,$3,$4,$5)", [
        owner.namespaceId,
        owner.agentId,
        owner.revisionId,
        execution.executionId,
        execution.fingerprint,
      ]);
    },
    async withdrawFinite(owner, at) {
      const key = repositoryRemovalWorkKey(owner.revisionId);
      // The caller holds the Agent lock. Read existing immutable ownership without
      // locking the cleanup row: its worker takes that row before the Agent lock.
      const result = await client.query(
        `SELECT work.actor_id, cleanup.idempotency_key IS NOT NULL AS existing,
          (cleanup.namespace_id,cleanup.agent_id,cleanup.revision_id,cleanup.actor_id)=
            (v.namespace_id,v.agent_id,v.id,work.actor_id)
            AND cleanup.agent_target IS NULL AND cleanup.namespace_target IS NULL AS same_owner
         FROM occ.agent_revisions v JOIN occ.agents a
           ON (a.namespace_id,a.id,a.active_revision_id)=(v.namespace_id,v.agent_id,v.id)
         JOIN occ.controller_work work ON (work.namespace_id,work.agent_id,work.revision_id)=(v.namespace_id,v.agent_id,v.id)
           AND work.idempotency_key='agent_revision:' || v.id || ':reconcile'
           AND work.agent_target IS NULL AND work.namespace_target IS NULL
         LEFT JOIN occ.controller_work cleanup ON cleanup.idempotency_key=$4
         WHERE (v.namespace_id,v.agent_id,v.id)=($1,$2,$3)
           AND a.status='active'
           AND v.admitted_spec->'repository_credentials' IS NOT NULL
           AND NOT (v.admitted_spec->'repository_credentials' ? 'standingApprovalId')`,
        [owner.namespaceId, owner.agentId, owner.revisionId, key],
      );
      const recorded = result.rows[0] as
        { actor_id: string; existing: boolean; same_owner: boolean | null } | undefined;
      if (!recorded || (recorded.existing && !recorded.same_owner)) {
        throw new ScopeViolationError("Finite withdrawal requires the exact active revision.");
      }
      if (!recorded.existing) {
        await client.query(
          `INSERT INTO occ.controller_work
            (idempotency_key,namespace_id,agent_id,revision_id,actor_id,state,available_at,created_at,updated_at)
           VALUES ($4,$1,$2,$3,$5,'queued',clock_timestamp(),clock_timestamp(),clock_timestamp())`,
          [owner.namespaceId, owner.agentId, owner.revisionId, key, recorded.actor_id],
        );
      }
      await client.query(
        `UPDATE occ.repository_session_attempts SET phase='closing',updated_at=greatest(updated_at,$4::timestamptz)
         WHERE (namespace_id,agent_id,revision_id)=($1,$2,$3) AND phase IN ('opening','open')`,
        [owner.namespaceId, owner.agentId, owner.revisionId, at],
      );
    },
    lockAttempt: async (admissionId) => {
      const result = await client.query(
        `SELECT ${columns} FROM occ.repository_session_attempts WHERE admission_id = $1 FOR UPDATE`,
        [admissionId],
      );
      return result.rows[0] === undefined ? undefined : attemptFromRow(result.rows[0]);
    },
    findBrokerReceipt: async (admissionId) => {
      const result = await client.query(
        `SELECT ${receiptColumns} FROM occ.repository_broker_receipts WHERE admission_id = $1`,
        [admissionId],
      );
      return result.rows[0] === undefined ? undefined : receiptFromRow(result.rows[0]);
    },
    findBrokerReceiptBySession: async (sessionId) => {
      const result = await client.query(
        `SELECT ${receiptColumns} FROM occ.repository_broker_receipts WHERE session_id = $1`,
        [sessionId],
      );
      return result.rows[0] === undefined ? undefined : receiptFromRow(result.rows[0]);
    },
    createBrokerReceipt: async (input) => {
      const result = await client.query(
        `INSERT INTO occ.repository_broker_receipts (admission_id, state, generation) VALUES ($1, $2, $3) RETURNING ${receiptColumns}`,
        [input.admissionId, input.state, input.generation ?? null],
      );
      return receiptFromRow(result.rows[0]);
    },
    advanceBrokerReceipt: async (input) => {
      const result = await client.query(
        `UPDATE occ.repository_broker_receipts SET state = $4, session_id = $5, deadline_wall_ms = $6, revoked = $7, expired = $8 WHERE admission_id = $1 AND state = $2 AND generation = $3 RETURNING ${receiptColumns}`,
        [
          input.admissionId,
          input.expectedState,
          input.generation,
          input.state,
          input.sessionId,
          input.deadlineWallMs,
          input.revoked ?? null,
          input.expired ?? null,
        ],
      );
      return result.rows[0] === undefined ? undefined : receiptFromRow(result.rows[0]);
    },
    fenceBrokerReceipt: async (input) => {
      const result = await client.query(
        `UPDATE occ.repository_broker_receipts SET state = 'fenced' WHERE admission_id = $1 AND state = 'reserved' AND generation = $2 RETURNING ${receiptColumns}`,
        [input.admissionId, input.generation],
      );
      return result.rows[0] === undefined ? undefined : receiptFromRow(result.rows[0]);
    },
    findAttempt: async (admissionId) => {
      const result = await client.query(
        `SELECT ${columns} FROM occ.repository_session_attempts WHERE admission_id = $1`,
        [admissionId],
      );
      return result.rows[0] === undefined ? undefined : attemptFromRow(result.rows[0]);
    },
    listRevisionAttempts: async (owner) => {
      const result = await client.query(
        `SELECT ${columns} FROM occ.repository_session_attempts
         WHERE namespace_id = $1 AND agent_id = $2 AND revision_id = $3
         ORDER BY created_at, admission_id`,
        [owner.namespaceId, owner.agentId, owner.revisionId],
      );
      return Object.freeze(result.rows.map(attemptFromRow));
    },
    listNamespaceAttempts: async (namespaceId) => {
      const result = await client.query(
        `SELECT ${columns} FROM occ.repository_session_attempts
         WHERE namespace_id = $1 ORDER BY created_at, admission_id`,
        [namespaceId],
      );
      return Object.freeze(result.rows.map(attemptFromRow));
    },
    createAttempt: async (input) => {
      const result = await client.query(
        `INSERT INTO occ.repository_session_attempts
         (namespace_id, agent_id, revision_id, repository_ref, admission_id,
          duration_seconds, deadline_wall_ms, phase, session_id, created_at, updated_at, broker_protocol, predecessor_admission_id, execution_fingerprint)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'opening', NULL, $8, $8, $9, $10, $11)
         RETURNING ${columns}`,
        [
          input.namespaceId,
          input.agentId,
          input.revisionId,
          input.repositoryRef,
          input.admissionId,
          input.durationSeconds,
          input.deadlineWallMs,
          input.createdAt,
          input.brokerProtocol ?? 0,
          input.predecessorAdmissionId ?? null,
          input.executionFingerprint ?? null,
        ],
      );
      return attemptFromRow(result.rows[0]);
    },
    advanceAttempt: async (input) => {
      const result = await client.query(
        `UPDATE occ.repository_session_attempts
         SET phase = $3, session_id = CASE WHEN $4::boolean THEN $5::text ELSE session_id END,
             updated_at = $6
         WHERE admission_id = $1 AND phase = $2
         RETURNING ${columns}`,
        [
          input.admissionId,
          input.expectedPhase,
          input.phase,
          input.sessionId !== undefined,
          input.sessionId ?? null,
          input.updatedAt,
        ],
      );
      return result.rows[0] === undefined ? undefined : attemptFromRow(result.rows[0]);
    },
  };
}
