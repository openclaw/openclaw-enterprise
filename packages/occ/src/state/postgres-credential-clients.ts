import { immutableCopy } from "@openclaw-enterprise/utils";
import type { OAuthClient } from "@openclaw-enterprise/contracts";
import { DependencyUnavailableError } from "../errors.ts";
import type {
  CredentialClientRepository,
  StoredCredentialClient,
} from "../ports/credential-clients.ts";
import type { PostgresQueryClient } from "./postgres-work-queue.ts";

type Row = Record<string, unknown>;

function invalid(): never {
  throw new DependencyUnavailableError("Persisted credential client state is invalid.");
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

function registrationFromRow(row: Row): Readonly<StoredCredentialClient> {
  const common = {
    id: text(row, "id"),
    ...(row.namespace_id === null ? {} : { namespaceId: text(row, "namespace_id") }),
    displayName: text(row, "display_name"),
    createdAt: timestamp(row, "created_at"),
    ...(row.token_service_instance_id === null
      ? {}
      : { tokenServiceInstanceId: text(row, "token_service_instance_id") }),
  };
  if (row.kind === "github-app") {
    return immutableCopy({ ...common, kind: "github-app", appId: text(row, "app_id") });
  }
  if (row.kind !== "oauth2") {
    return invalid();
  }
  return immutableCopy({
    ...common,
    kind: "oauth2",
    issuer: text(row, "issuer"),
    clientId: text(row, "client_id"),
    tokenEndpointAuthMethod:
      row.token_endpoint_auth_method as OAuthClient["tokenEndpointAuthMethod"],
  });
}

export function postgresCredentialClients(
  client: PostgresQueryClient,
  requireInitialized: () => Promise<unknown>,
): CredentialClientRepository {
  return {
    list: async () =>
      Object.freeze(
        (
          await client.query(
            "SELECT * FROM occ.oauth_clients WHERE cleanup_after IS NULL ORDER BY id",
            [],
          )
        ).rows.map((row) => registrationFromRow(row as Row)),
      ),
    countNamespace: async (namespaceId) =>
      integer(
        (
          await client.query("SELECT count(*) AS n FROM occ.oauth_clients WHERE namespace_id=$1", [
            namespaceId,
          ])
        ).rows[0] as Row,
        "n",
      ),
    find: async (registrationId) => {
      const [row] = (
        await client.query(
          `SELECT * FROM occ.oauth_clients WHERE id = $1 AND cleanup_after IS NULL`,
          [registrationId],
        )
      ).rows;
      return row === undefined ? undefined : registrationFromRow(row as Row);
    },
    lock: async (id) => {
      const [row] = (
        await client.query(
          "SELECT * FROM occ.oauth_clients WHERE id=$1 AND cleanup_after IS NULL FOR UPDATE",
          [id],
        )
      ).rows;
      return row === undefined ? undefined : registrationFromRow(row as Row);
    },
    listCleanups: async (limit) =>
      (
        await client.query(
          "SELECT id FROM occ.oauth_clients WHERE cleanup_after<=now() ORDER BY cleanup_after,id LIMIT $1",
          [limit],
        )
      ).rows.map((row) => text(row as Row, "id")),
    lockForCleanup: async (id, dueOnly) => {
      const [row] = (
        await client.query(
          "SELECT * FROM occ.oauth_clients WHERE id=$1 AND cleanup_after IS NOT NULL AND (NOT $2::boolean OR cleanup_after<=now()) FOR UPDATE SKIP LOCKED",
          [id, dueOnly],
        )
      ).rows;
      return row === undefined ? undefined : registrationFromRow(row as Row);
    },
    setCleanup: async (id, cleanupAfter) => {
      await client.query("UPDATE occ.oauth_clients SET cleanup_after=$2 WHERE id=$1", [
        id,
        cleanupAfter,
      ]);
    },
    create: async (registration, cleanupAfter) => {
      await requireInitialized();
      const oauth = registration.kind === "oauth2" ? registration : undefined;
      await client.query(
        `INSERT INTO occ.oauth_clients
         (id, kind, namespace_id, issuer, client_id, token_service_instance_id, created_at, display_name,
          token_endpoint_auth_method, app_id, cleanup_after)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          registration.id,
          registration.kind,
          registration.namespaceId ?? null,
          oauth?.issuer ?? null,
          oauth?.clientId ?? null,
          registration.tokenServiceInstanceId ?? null,
          registration.createdAt,
          registration.displayName,
          oauth?.tokenEndpointAuthMethod ?? null,
          registration.kind === "github-app" ? registration.appId : null,
          cleanupAfter ?? null,
        ],
      );
      return immutableCopy(registration);
    },
    delete: async (id, retainForCleanup) => {
      const mutation = retainForCleanup
        ? "UPDATE occ.oauth_clients r SET cleanup_after=now()"
        : "DELETE FROM occ.oauth_clients r";
      const result = await client.query(
        `${mutation} WHERE r.id=$1
         AND NOT EXISTS(SELECT 1 FROM occ.credential_sources s
                        WHERE s.oauth_client_id=r.id OR s.github_app_client_id=r.id)
         AND NOT EXISTS(SELECT 1 FROM occ.authentication_states a WHERE a.oauth_client_id=r.id)
         AND NOT EXISTS(SELECT 1 FROM occ.agents a
                        WHERE r.kind='github-app' AND a.repository_access->>'githubAppClientId'=r.id)`,
        [id],
      );
      return result.rowCount === 1;
    },
  };
}
