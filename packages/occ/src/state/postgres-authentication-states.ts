import { immutableCopy } from "@openclaw-enterprise/utils";

import type {
  AuthenticationStateRepository,
  DeviceAuthenticationChanges,
  OAuthAuthenticationState,
} from "../ports/authentication-states.ts";
import type { DeviceAuthenticationState } from "../device-authorization.ts";
import type { PostgresQueryClient } from "./postgres-work-queue.ts";

const oauthKeys = [
  "pkceVerifier",
  "selectedScopes",
  "issuerRequired",
  "sessionId",
  "redirectUri",
] as const;
const deviceKeys = [
  "agentId",
  "harnessId",
  "credentialGatewayId",
  "credentialRefreshId",
  "sourceId",
  "intervalSeconds",
] as const;
type OAuthBinding = Pick<OAuthAuthenticationState, (typeof oauthKeys)[number]>;
type DeviceBinding = Pick<DeviceAuthenticationState, (typeof deviceKeys)[number]>;
type CommonRow = { id: string; namespace_id: string; actor_id: string; expires_at: Date };
type OAuthRow = CommonRow & {
  binding: OAuthBinding;
  credential_source_id: string;
  connection_template_id: string;
  connection_template_version: number;
  created_at: Date;
};
type DeviceRow = CommonRow & {
  binding: DeviceBinding;
  phase: DeviceAuthenticationState["phase"];
  next_poll_at: Date;
  encrypted_challenge: string | null;
  private_state: string | null;
  version: number;
};

function common(row: CommonRow) {
  return {
    id: row.id,
    namespaceId: row.namespace_id,
    actorId: row.actor_id,
    expiresAt: row.expires_at.toISOString(),
  };
}

function oauthFromRow(row: OAuthRow): OAuthAuthenticationState {
  return immutableCopy({
    ...common(row),
    ...row.binding,
    kind: "oauth_connection",
    credentialSourceId: row.credential_source_id,
    connectionTemplateId: row.connection_template_id,
    connectionTemplateVersion: row.connection_template_version,
    createdAt: row.created_at.toISOString(),
  });
}

function deviceFromRow(row: DeviceRow): DeviceAuthenticationState {
  return immutableCopy({
    ...common(row),
    ...row.binding,
    kind: "device_authorization",
    phase: row.phase,
    nextPollAt: row.next_poll_at.toISOString(),
    ...(row.encrypted_challenge === null ? {} : { encryptedChallenge: row.encrypted_challenge }),
    ...(row.private_state === null ? {} : { privateState: row.private_state }),
    version: row.version,
  });
}

function progress({
  phase,
  nextPollAt,
  encryptedChallenge,
  privateState,
}: DeviceAuthenticationChanges) {
  return [phase, nextPollAt, encryptedChallenge, privateState] as const;
}

function pick<T, K extends keyof T>(record: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.map((key) => [key, record[key]])) as Pick<T, K>;
}

/** PostgreSQL validates immutable bindings and typed progress; settlement stays kind-specific. */
export function postgresAuthenticationStates(
  client: PostgresQueryClient,
  requireInitialized: () => Promise<unknown>,
): AuthenticationStateRepository {
  return {
    create: async (record) => {
      const oauth = record.kind === "oauth_connection" ? record : undefined;
      const device = record.kind === "device_authorization" ? record : undefined;
      if (oauth) {
        await requireInitialized();
      }
      const binding =
        record.kind === "oauth_connection" ? pick(record, oauthKeys) : pick(record, deviceKeys);
      await client.query(
        `INSERT INTO occ.authentication_states
        (kind,id,namespace_id,actor_id,expires_at,credential_source_id,connection_template_id,connection_template_version,created_at,binding,phase,next_poll_at,encrypted_challenge,private_state,version)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          record.kind,
          record.id,
          record.namespaceId,
          record.actorId,
          record.expiresAt,
          oauth?.credentialSourceId,
          oauth?.connectionTemplateId,
          oauth?.connectionTemplateVersion,
          oauth?.createdAt,
          binding,
          ...(device ? progress(device) : [null, null, null, null]),
          device?.version,
        ],
      );
    },
    findDevice: async (namespaceId, id) => {
      const { rows } = await client.query(
        "SELECT * FROM occ.authentication_states WHERE kind = 'device_authorization' AND namespace_id = $1 AND id = $2",
        [namespaceId, id],
      );
      return rows[0] === undefined ? undefined : deviceFromRow(rows[0] as DeviceRow);
    },
    replaceDevice: async (namespaceId, id, version, changes) => {
      const result = await client.query(
        `UPDATE occ.authentication_states SET version = version + 1, expires_at = $4,
        phase = $5, next_poll_at = $6, encrypted_challenge = $7, private_state = $8
        WHERE kind = 'device_authorization' AND namespace_id = $1 AND id = $2 AND version = $3`,
        [namespaceId, id, version, changes.expiresAt, ...progress(changes)],
      );
      return result.rowCount === 1;
    },
    consumeOAuth: async (id, actorId, sessionId, at) => {
      const { rows } = await client.query(
        `DELETE FROM occ.authentication_states WHERE kind = 'oauth_connection' AND id = $1 AND actor_id = $2
        AND binding->>'sessionId' = $3 AND expires_at > $4 RETURNING *`,
        [id, actorId, sessionId, at],
      );
      return rows[0] === undefined ? undefined : oauthFromRow(rows[0] as OAuthRow);
    },
    expire: async (at, limit) => {
      await client.query(
        `WITH expired AS (
          SELECT id FROM occ.authentication_states WHERE kind = 'device_authorization' AND expires_at <= $1 AND phase <> 'cancelled'
          ORDER BY expires_at,id LIMIT $2 FOR UPDATE SKIP LOCKED
        ) UPDATE occ.authentication_states d SET version = d.version + 1, phase = 'cancelled', private_state = NULL, encrypted_challenge = NULL
        FROM expired WHERE d.kind = 'device_authorization' AND d.id = expired.id`,
        [at, limit],
      );
      const { rows } = await client.query(
        `DELETE FROM occ.authentication_states WHERE kind = 'oauth_connection' AND id IN (
          SELECT id FROM occ.authentication_states WHERE kind = 'oauth_connection' AND expires_at <= $1 ORDER BY expires_at,id LIMIT $2)
        RETURNING namespace_id,credential_source_id`,
        [at, limit],
      );
      return (rows as { namespace_id: string; credential_source_id: string }[]).map((row) => ({
        namespaceId: row.namespace_id,
        credentialSourceId: row.credential_source_id,
      }));
    },
  };
}
