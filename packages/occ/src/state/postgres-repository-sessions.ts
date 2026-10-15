import { immutableCopy } from "@openclaw-enterprise/utils";
import { DependencyUnavailableError } from "../errors.ts";
import type {
  RepositorySessionAttempt,
  RepositoryBrokerReceipt,
  RepositorySessionPhase,
  RepositorySessionRepository,
} from "../ports/repository-sessions.ts";
import type { PostgresQueryClient } from "./postgres-work-queue.ts";

const columns = `namespace_id, agent_id, revision_id, repository_ref, admission_id,
  duration_seconds, deadline_wall_ms, phase, session_id, created_at, updated_at,
  live_revision_id, cleanup_context, broker_protocol`;

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
    ![0, 1].includes(brokerProtocol) ||
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
    brokerProtocol: brokerProtocol as 0 | 1,
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
          duration_seconds, deadline_wall_ms, phase, session_id, created_at, updated_at, broker_protocol)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'opening', NULL, $8, $8, $9)
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
