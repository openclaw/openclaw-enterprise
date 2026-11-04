import { immutableCopy } from "@openclaw-enterprise/utils";
import type { AgentConnection, Secret, ConnectionSession } from "@openclaw-enterprise/contracts";
import { DependencyUnavailableError } from "../errors.ts";
import type { AgentConnectionRepository } from "./platform-state.ts";
import type { PostgresQueryClient } from "./postgres-work-queue.ts";

type Row = Record<string, unknown>;

function invalid(): never {
  throw new DependencyUnavailableError("Persisted Agent connection state is invalid.");
}

function text(row: Row, key: string): string {
  return typeof row[key] === "string" ? row[key] : invalid();
}

function timestamp(row: Row, key: string): string {
  const value = row[key];
  const date = value instanceof Date ? value : new Date(text(row, key));
  return Number.isFinite(date.getTime()) ? date.toISOString() : invalid();
}

function integer(row: Row, key: string): number {
  const value = Number(row[key]);
  return Number.isSafeInteger(value) ? value : invalid();
}

function connectionFromRow(row: Row): Readonly<AgentConnection> {
  return immutableCopy({
    namespaceId: text(row, "namespace_id"),
    credentialSourceId: text(row, "credential_source_id"),
    ...(row.agent_id === null ? {} : { agentId: text(row, "agent_id") }),
    ownerPrincipalId: text(row, "owner_principal_id"),
    ...(row.revocation_requested_by === null
      ? {}
      : { revocationRequestedBy: text(row, "revocation_requested_by") }),
    ...(row.revoked_at === null ? {} : { revokedAt: timestamp(row, "revoked_at") }),
    connectionTemplateId: text(row, "connection_template_id"),
    connectionTemplateVersion: integer(row, "connection_template_version"),
    createdAt: timestamp(row, "created_at"),
  });
}

function sessionFromRow(row: Row): Readonly<ConnectionSession> {
  return immutableCopy({
    stateHash: text(row, "state_hash"),
    namespaceId: text(row, "namespace_id"),
    ...(row.agent_id === null ? {} : { agentId: text(row, "agent_id") }),
    credentialSourceId: text(row, "credential_source_id"),
    privateState: text(row, "private_state"),
    issuerRequired: row.issuer_required === true,
    sessionId: text(row, "session_id"),
    redirectUri: text(row, "redirect_uri"),
    actorId: text(row, "actor_id"),
    connectionTemplateId: text(row, "connection_template_id"),
    connectionTemplateVersion: integer(row, "connection_template_version"),
    createdAt: timestamp(row, "created_at"),
    expiresAt: timestamp(row, "expires_at"),
  });
}

/** A completed connection lives as long as its source, independently of Agent bindings. */
export function postgresAgentConnections(
  client: PostgresQueryClient,
  requireInitialized: () => Promise<unknown>,
): AgentConnectionRepository {
  return {
    findTokenCustody: async (namespaceId, sourceId) => {
      const [row] = (
        await client.query(
          "SELECT secret_ref, published_version FROM occ.connection_token_custody WHERE namespace_id=$1 AND credential_source_id=$2",
          [namespaceId, sourceId],
        )
      ).rows;
      if (!row) {
        return undefined;
      }
      const record = row as Row;
      const secret = record.secret_ref as Readonly<Secret>;
      if (
        secret?.namespaceId !== namespaceId ||
        !secret.id ||
        !secret.driverId ||
        !secret.backendRef?.uid
      ) {
        invalid();
      }
      return immutableCopy({
        namespaceId,
        sourceId,
        secret,
        ...(record.published_version === null
          ? {}
          : { publishedVersion: text(record, "published_version") }),
      });
    },
    createTokenCustody: async (c) => {
      await client.query(
        "INSERT INTO occ.connection_token_custody (namespace_id,credential_source_id,secret_ref) VALUES ($1,$2,$3)",
        [c.namespaceId, c.sourceId, JSON.stringify(c.secret)],
      );
    },
    recordTokenSchedule: async (namespaceId, sourceId, schedule) => {
      const published = typeof schedule === "object" ? schedule : undefined;
      const result = await client.query(
        `UPDATE occ.connection_token_custody
         SET published_version = COALESCE($3, published_version),
             next_refresh_at = CASE WHEN $5 THEN now() ELSE $4::timestamptz END
         WHERE namespace_id = $1 AND credential_source_id = $2`,
        [
          namespaceId,
          sourceId,
          published?.publishedVersion ?? null,
          published?.nextRefreshAt ?? null,
          schedule === "due",
        ],
      );
      if (!result.rowCount) {
        invalid();
      }
    },
    listDueConnectionTokens: async (installationId, limit, afterSourceId) =>
      Object.freeze(
        (
          await client.query(
            `SELECT a.* FROM occ.agent_connections a JOIN occ.connection_token_custody c USING(namespace_id,credential_source_id)
         WHERE c.next_refresh_at <= now() AND a.revocation_requested_by IS NULL AND a.credential_source_id > $1 AND EXISTS (SELECT 1 FROM occ.installation WHERE id=$2)
         ORDER BY a.credential_source_id LIMIT $3`,
            [afterSourceId ?? "", installationId, limit],
          )
        ).rows.map((row) => connectionFromRow(row as Row)),
      ),
    findAgentConnection: async (namespaceId, credentialSourceId) => {
      const [row] = (
        await client.query(
          `SELECT * FROM occ.agent_connections
           WHERE namespace_id = $1 AND credential_source_id = $2`,
          [namespaceId, credentialSourceId],
        )
      ).rows;
      return row === undefined ? undefined : connectionFromRow(row as Row);
    },
    hasPendingConnectionWithdrawals: async (namespaceId, sourceId) => {
      const pending = await client.query(
        `SELECT 1 FROM occ.credential_withdrawals
         WHERE namespace_id = $1 AND credential_source_id = $2 AND state = 'pending' LIMIT 1`,
        [namespaceId, sourceId],
      );
      return pending.rows.length > 0;
    },
    listRevokingConnections: async (installationId, limit, afterSourceId) =>
      Object.freeze(
        (
          await client.query(
            `SELECT * FROM occ.agent_connections WHERE revocation_requested_by IS NOT NULL
         AND credential_source_id > $2 AND EXISTS (SELECT 1 FROM occ.installation WHERE id = $1)
         ORDER BY credential_source_id LIMIT $3`,
            [installationId, afterSourceId ?? "", limit],
          )
        ).rows.map((row) => connectionFromRow(row as Row)),
      ),
    requestConnectionRevocation: async (namespaceId, sourceId, principalId) => {
      await client.query(
        `UPDATE occ.agent_connections SET revocation_requested_by = $3
         WHERE namespace_id = $1 AND credential_source_id = $2 AND revocation_requested_by IS NULL`,
        [namespaceId, sourceId, principalId],
      );
    },
    confirmConnectionRevocation: async (namespaceId, sourceId, at) => {
      await client.query(
        `UPDATE occ.agent_connections SET revoked_at = $3
         WHERE namespace_id = $1 AND credential_source_id = $2 AND revocation_requested_by IS NOT NULL AND revoked_at IS NULL`,
        [namespaceId, sourceId, at],
      );
    },
    listNamespaceConnections: async (namespaceId) =>
      Object.freeze(
        (
          await client.query(
            `SELECT * FROM occ.agent_connections WHERE namespace_id = $1 AND revocation_requested_by IS NULL ORDER BY credential_source_id`,
            [namespaceId],
          )
        ).rows.map((row) => connectionFromRow(row as Row)),
      ),
    listAgentConnections: async (namespaceId, agentId) =>
      Object.freeze(
        (
          await client.query(
            `SELECT c.* FROM occ.agent_connections c
             JOIN occ.agent_credential_sources b USING (namespace_id, credential_source_id)
             WHERE c.namespace_id = $1 AND b.agent_id = $2 AND c.revocation_requested_by IS NULL ORDER BY c.credential_source_id`,
            [namespaceId, agentId],
          )
        ).rows.map((row) => connectionFromRow(row as Row)),
      ),
    createAgentConnection: async (connection) => {
      await requireInitialized();
      await client.query(
        `INSERT INTO occ.agent_connections
         (namespace_id, credential_source_id, agent_id, owner_principal_id,
          connection_template_id, connection_template_version, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          connection.namespaceId,
          connection.credentialSourceId,
          connection.agentId ?? null,
          connection.ownerPrincipalId,
          connection.connectionTemplateId,
          connection.connectionTemplateVersion,
          connection.createdAt,
        ],
      );
      return immutableCopy(connection);
    },
    deleteAgentConnection: async (namespaceId, credentialSourceId) => {
      const deleted = await client.query(
        `DELETE FROM occ.agent_connections WHERE namespace_id = $1 AND credential_source_id = $2`,
        [namespaceId, credentialSourceId],
      );
      return deleted.rowCount === 1;
    },
    createConnectionSession: async (session) => {
      await requireInitialized();
      await client.query(
        `INSERT INTO occ.connection_sessions
         (state_hash, namespace_id, agent_id, credential_source_id, private_state, actor_id,
          session_id, redirect_uri, connection_template_id, connection_template_version, created_at, expires_at, issuer_required)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          session.stateHash,
          session.namespaceId,
          session.agentId ?? null,
          session.credentialSourceId,
          session.privateState,
          session.actorId,
          session.sessionId,
          session.redirectUri,
          session.connectionTemplateId,
          session.connectionTemplateVersion,
          session.createdAt,
          session.expiresAt,
          session.issuerRequired,
        ],
      );
      return immutableCopy(session);
    },
    consumeConnectionSession: async (stateHash, actorId, sessionId, at) => {
      const { rows } = await client.query(
        `DELETE FROM occ.connection_sessions WHERE state_hash = $1 AND actor_id = $2
         AND session_id = $3 AND expires_at > $4 RETURNING *`,
        [stateHash, actorId, sessionId, at],
      );
      return rows[0] === undefined ? undefined : sessionFromRow(rows[0] as Row);
    },
    takeExpiredConnectionSessions: async (at, limit) => {
      const { rows } = await client.query(
        `DELETE FROM occ.connection_sessions WHERE state_hash IN (
          SELECT state_hash FROM occ.connection_sessions WHERE expires_at <= $1
          ORDER BY expires_at, state_hash LIMIT $2)
         RETURNING namespace_id, credential_source_id`,
        [at, limit],
      );
      return rows.map((row) => ({
        namespaceId: text(row as Row, "namespace_id"),
        credentialSourceId: text(row as Row, "credential_source_id"),
      }));
    },
  };
}
