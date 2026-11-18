import type { ConnectionSession } from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";

import type { DeviceAuthorizationSession } from "../device-authorization.ts";
import { DependencyUnavailableError } from "../errors.ts";
import type { AuthenticationStateRepository } from "./platform-state.ts";
import type { PostgresQueryClient } from "./postgres-work-queue.ts";

type Row = Record<string, unknown>;

function invalid(): never {
  throw new DependencyUnavailableError("Persisted authentication state is invalid.");
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

function connectionSessionFromRow(row: Row): Readonly<ConnectionSession> {
  return immutableCopy({
    stateHash: text(row, "id"),
    namespaceId: text(row, "namespace_id"),
    credentialSourceId: text(row, "credential_source_id"),
    pkceVerifier: text(row, "pkce_verifier"),
    selectedScopes: row.selected_scopes as string[],
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

/** Transient authentication attempts retain their workflow-specific settlement rules. */
export function postgresAuthenticationStates(
  client: PostgresQueryClient,
  requireInitialized: () => Promise<unknown>,
): AuthenticationStateRepository {
  return {
    createConnectionSession: async (session) => {
      await requireInitialized();
      await client.query(
        `INSERT INTO occ.authentication_states
         (kind, id, namespace_id, credential_source_id, pkce_verifier, actor_id,
          session_id, redirect_uri, connection_template_id, connection_template_version, created_at, expires_at, issuer_required, selected_scopes)
         VALUES ('oauth_connection',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          session.stateHash,
          session.namespaceId,
          session.credentialSourceId,
          session.pkceVerifier,
          session.actorId,
          session.sessionId,
          session.redirectUri,
          session.connectionTemplateId,
          session.connectionTemplateVersion,
          session.createdAt,
          session.expiresAt,
          session.issuerRequired,
          session.selectedScopes,
        ],
      );
      return immutableCopy(session);
    },
    consumeConnectionSession: async (stateHash, actorId, sessionId, at) => {
      const { rows } = await client.query(
        `DELETE FROM occ.authentication_states WHERE kind = 'oauth_connection' AND id = $1 AND actor_id = $2
         AND session_id = $3 AND expires_at > $4 RETURNING *`,
        [stateHash, actorId, sessionId, at],
      );
      return rows[0] === undefined ? undefined : connectionSessionFromRow(rows[0] as Row);
    },
    takeExpiredConnectionSessions: async (at, limit) => {
      const { rows } = await client.query(
        `DELETE FROM occ.authentication_states WHERE kind = 'oauth_connection' AND id IN (
          SELECT id FROM occ.authentication_states WHERE kind = 'oauth_connection' AND expires_at <= $1
          ORDER BY expires_at, id LIMIT $2)
         RETURNING namespace_id, credential_source_id`,
        [at, limit],
      );
      return rows.map((row) => ({
        namespaceId: text(row as Row, "namespace_id"),
        credentialSourceId: text(row as Row, "credential_source_id"),
      }));
    },
    findDeviceAuthorization: async (namespaceId, id) => {
      const { rows } = await client.query(
        "SELECT * FROM occ.authentication_states WHERE kind = 'device_authorization' AND namespace_id = $1 AND id = $2",
        [namespaceId, id],
      );
      const row = rows[0] as Row | undefined;
      if (!row) {
        return undefined;
      }
      return {
        version: integer(row, "version"),
        session: {
          namespaceId,
          actorId: text(row, "actor_id"),
          ...(row.agent_id === null ? {} : { agentId: text(row, "agent_id") }),
          harnessId: text(row, "harness_id"),
          credentialGatewayId: text(row, "credential_gateway_id"),
          credentialRefreshId: text(row, "credential_refresh_id"),
          sourceId: text(row, "device_source_id"),
          phase: row.phase as DeviceAuthorizationSession["phase"],
          expiresAt: timestamp(row, "expires_at"),
          nextPollAt: timestamp(row, "next_poll_at"),
          intervalSeconds: integer(row, "interval_seconds"),
          ...(row.encrypted_challenge === null
            ? {}
            : { encryptedChallenge: text(row, "encrypted_challenge") }),
          ...(row.private_state === null ? {} : { privateState: text(row, "private_state") }),
        },
      };
    },
    createDeviceAuthorization: async (id, session) => {
      await client.query(
        `INSERT INTO occ.authentication_states
         (kind, namespace_id, id, actor_id, agent_id, harness_id, credential_gateway_id, credential_refresh_id,
          device_source_id, encrypted_challenge, interval_seconds, phase, expires_at, next_poll_at, private_state, version)
         VALUES ('device_authorization',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1)`,
        [
          session.namespaceId,
          id,
          session.actorId,
          session.agentId,
          session.harnessId,
          session.credentialGatewayId,
          session.credentialRefreshId,
          session.sourceId,
          session.encryptedChallenge,
          session.intervalSeconds,
          session.phase,
          session.expiresAt,
          session.nextPollAt,
          session.privateState,
        ],
      );
    },
    replaceDeviceAuthorization: async (namespaceId, id, version, session) => {
      const result = await client.query(
        `UPDATE occ.authentication_states SET version = version + 1, phase = $4, expires_at = $5,
           next_poll_at = $6, private_state = $7, encrypted_challenge = $8
         WHERE kind = 'device_authorization' AND namespace_id = $1 AND id = $2 AND version = $3`,
        [
          namespaceId,
          id,
          version,
          session.phase,
          session.expiresAt,
          session.nextPollAt,
          session.privateState,
          session.encryptedChallenge,
        ],
      );
      return result.rowCount === 1;
    },
    expireDeviceAuthorizations: async (at, limit) => {
      await client.query(
        `WITH expired AS (
           SELECT id FROM occ.authentication_states WHERE kind = 'device_authorization' AND expires_at <= $1 AND phase <> 'cancelled'
           ORDER BY expires_at, id LIMIT $2 FOR UPDATE SKIP LOCKED
         )
         UPDATE occ.authentication_states d SET version = d.version + 1, phase = 'cancelled', private_state = NULL, encrypted_challenge = NULL
         FROM expired WHERE d.kind = 'device_authorization' AND d.id = expired.id`,
        [at, limit],
      );
    },
  };
}
