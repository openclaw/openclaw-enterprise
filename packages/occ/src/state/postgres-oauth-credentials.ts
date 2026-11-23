import { immutableCopy } from "@openclaw-enterprise/utils";
import type { Secret } from "@openclaw-enterprise/contracts";
import { DependencyUnavailableError } from "../errors.ts";
import type { OAuthCredentialRepository } from "../ports/oauth-credentials.ts";
import type { PostgresQueryClient } from "./postgres-work-queue.ts";

function invalid(): never {
  throw new DependencyUnavailableError("Persisted OAuth custody is invalid.");
}

export function postgresOAuthCredentials(client: PostgresQueryClient): OAuthCredentialRepository {
  return {
    findTokenCustody: async (namespaceId, sourceId) => {
      const { rows } = await client.query(
        "SELECT secret_ref, scheduled_version, next_refresh_at <= now() AS due FROM occ.connection_token_custody WHERE namespace_id=$1 AND credential_source_id=$2",
        [namespaceId, sourceId],
      );
      const row = rows[0] as
        { secret_ref: unknown; scheduled_version: unknown; due: boolean } | undefined;
      if (!row) {
        return undefined;
      }
      const secret = row.secret_ref as Readonly<Secret>;
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
        due: row.due === true,
        ...(row.scheduled_version == null
          ? {}
          : { scheduledVersion: String(row.scheduled_version) }),
      });
    },
    createTokenCustody: async ({ namespaceId, sourceId, secret }) => {
      await client.query(
        "INSERT INTO occ.connection_token_custody(namespace_id,credential_source_id,secret_ref) VALUES ($1,$2,$3)",
        [namespaceId, sourceId, JSON.stringify(secret)],
      );
    },
    recordTokenSchedule: async (namespaceId, sourceId, schedule) => {
      const timing = typeof schedule === "object" ? schedule : undefined;
      const result = await client.query(
        "UPDATE occ.connection_token_custody SET scheduled_version=COALESCE($3,scheduled_version), next_refresh_at=CASE WHEN $5 THEN now() ELSE $4::timestamptz END WHERE namespace_id=$1 AND credential_source_id=$2",
        [
          namespaceId,
          sourceId,
          timing?.scheduledVersion ?? null,
          timing?.nextRefreshAt ?? null,
          schedule === "due",
        ],
      );
      if (!result.rowCount) {
        invalid();
      }
      if (timing) {
        await client.query(
          "UPDATE occ.credential_sources SET oauth_granted_scopes=$3 WHERE namespace_id=$1 AND id=$2 AND oauth_granted_scopes IS DISTINCT FROM $3",
          [namespaceId, sourceId, timing.grantedScopes],
        );
      }
    },
    listDueOAuthSources: async (installationId, limit, afterSourceId) => {
      const { rows } = await client.query(
        "SELECT s.namespace_id,s.id FROM occ.credential_sources s JOIN occ.connection_token_custody c ON c.namespace_id=s.namespace_id AND c.credential_source_id=s.id JOIN occ.token_service_instances i ON i.id=s.token_service_instance_id WHERE i.installation_id=$1 AND s.type='oauth2-refresh-token' AND s.state='ready' AND s.oauth_revocation_requested_by IS NULL AND c.next_refresh_at<=now() AND s.id>$2 ORDER BY s.id LIMIT $3",
        [installationId, afterSourceId ?? "", limit],
      );
      return Object.freeze(
        rows.map((value) => {
          const row = value as { namespace_id: unknown; id: unknown };
          return { namespaceId: String(row.namespace_id), id: String(row.id) };
        }),
      );
    },
    listRevokingOAuthSources: async (installationId, limit, afterSourceId) => {
      const { rows } = await client.query(
        "SELECT s.namespace_id,s.id FROM occ.credential_sources s JOIN occ.token_service_instances i ON i.id=s.token_service_instance_id WHERE i.installation_id=$1 AND s.oauth_revocation_requested_by IS NOT NULL AND s.id>$2 ORDER BY s.id LIMIT $3",
        [installationId, afterSourceId ?? "", limit],
      );
      return Object.freeze(
        rows.map((value) => {
          const row = value as { namespace_id: unknown; id: unknown };
          return { namespaceId: String(row.namespace_id), id: String(row.id) };
        }),
      );
    },
  };
}
