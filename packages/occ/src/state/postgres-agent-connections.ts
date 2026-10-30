import { immutableCopy } from "@openclaw-enterprise/utils";
import type { AgentConnection, ConnectionSession } from "@openclaw-enterprise/contracts";
import { isCredentialSourceProfile } from "@openclaw-enterprise/contracts";
import { DependencyUnavailableError } from "../errors.ts";
import type { AgentConnectionRepository } from "./platform-state.ts";
import type { PostgresQueryClient } from "./postgres-work-queue.ts";

type Row = Record<string, unknown>;

const selectConnection = `SELECT c.*, s.profile FROM occ.agent_connections AS c
  JOIN occ.credential_sources AS s
    ON s.namespace_id = c.namespace_id AND s.id = c.credential_source_id`;

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
  const profile = row.profile;
  if (profile !== null && !isCredentialSourceProfile(profile)) {
    return invalid();
  }
  return immutableCopy({
    namespaceId: text(row, "namespace_id"),
    credentialSourceId: text(row, "credential_source_id"),
    agentId: text(row, "agent_id"),
    ownerPrincipalId: text(row, "owner_principal_id"),
    connectionTemplateId: text(row, "connection_template_id"),
    connectionTemplateVersion: integer(row, "connection_template_version"),
    ...(profile === null ? {} : { profile }),
    createdAt: timestamp(row, "created_at"),
  });
}

function sessionFromRow(row: Row): Readonly<ConnectionSession> {
  return immutableCopy({
    stateHash: text(row, "state_hash"),
    namespaceId: text(row, "namespace_id"),
    agentId: text(row, "agent_id"),
    credentialSourceId: text(row, "credential_source_id"),
    secretId: text(row, "secret_id"),
    actorId: text(row, "actor_id"),
    connectionTemplateId: text(row, "connection_template_id"),
    connectionTemplateVersion: integer(row, "connection_template_version"),
    createdAt: timestamp(row, "created_at"),
    expiresAt: timestamp(row, "expires_at"),
    ...(row.consumed_at === null || row.consumed_at === undefined
      ? {}
      : { consumedAt: timestamp(row, "consumed_at") }),
  });
}

/** Foreign keys tie each row to its source, Agent, and approved connection template version. */
export function postgresAgentConnections(
  client: PostgresQueryClient,
  requireInitialized: () => Promise<unknown>,
): AgentConnectionRepository {
  return {
    findAgentConnection: async (namespaceId, credentialSourceId) => {
      const [row] = (
        await client.query(
          `${selectConnection} WHERE c.namespace_id = $1 AND c.credential_source_id = $2`,
          [namespaceId, credentialSourceId],
        )
      ).rows;
      return row === undefined ? undefined : connectionFromRow(row as Row);
    },
    listAgentConnections: async (namespaceId, agentId) =>
      Object.freeze(
        (
          await client.query(
            `${selectConnection}
             WHERE c.namespace_id = $1 AND c.agent_id = $2 ORDER BY c.credential_source_id`,
            [namespaceId, agentId],
          )
        ).rows.map((row) => connectionFromRow(row as Row)),
      ),
    findConnectionSession: async (stateHash) => {
      const [row] = (
        await client.query(`SELECT * FROM occ.connection_sessions WHERE state_hash = $1`, [
          stateHash,
        ])
      ).rows;
      return row === undefined ? undefined : sessionFromRow(row as Row);
    },
    createAgentConnection: async (connection) => {
      await requireInitialized();
      const result = await client.query(
        `INSERT INTO occ.agent_connections
         (namespace_id, credential_source_id, agent_id, owner_principal_id,
          connection_template_id, connection_template_version, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *, (SELECT profile FROM occ.credential_sources
                       WHERE namespace_id = $1 AND id = $2) AS profile`,
        [
          connection.namespaceId,
          connection.credentialSourceId,
          connection.agentId,
          connection.ownerPrincipalId,
          connection.connectionTemplateId,
          connection.connectionTemplateVersion,
          connection.createdAt,
        ],
      );
      return connectionFromRow(result.rows[0] as Row);
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
         (state_hash, namespace_id, agent_id, credential_source_id, secret_id, actor_id,
          connection_template_id, connection_template_version, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          session.stateHash,
          session.namespaceId,
          session.agentId,
          session.credentialSourceId,
          session.secretId,
          session.actorId,
          session.connectionTemplateId,
          session.connectionTemplateVersion,
          session.createdAt,
          session.expiresAt,
        ],
      );
      return immutableCopy(session);
    },
    consumeConnectionSession: async (stateHash, at) => {
      const consumed = await client.query(
        `UPDATE occ.connection_sessions SET consumed_at = $2
         WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > $2`,
        [stateHash, at],
      );
      return consumed.rowCount === 1;
    },
  };
}
