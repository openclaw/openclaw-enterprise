import { immutableCopy } from "@openclaw-enterprise/utils";
import type {
  OAuthClient,
  ConnectionTemplate,
  OAuthConnectionTemplateVersion,
} from "@openclaw-enterprise/contracts";
import { DependencyUnavailableError, ResourceStateConflictError } from "../errors.ts";
import type { ConnectionTemplateRepository } from "./platform-state.ts";
import type { PostgresQueryClient } from "./postgres-work-queue.ts";

type Row = Record<string, unknown>;

const versionColumns = `v.template_id, v.version, v.oauth_client_id, v.issuer, v.mode, v.observed_metadata, v.revocation_url,
  v.authorization_url, v.token_url, v.scopes, v.authorization_parameters, v.destinations, v.created_at AS version_created_at`;

function invalid(): never {
  throw new DependencyUnavailableError("Persisted connection template state is invalid.");
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

function versionFromRow(row: Row): OAuthConnectionTemplateVersion {
  const scopes = row.scopes;
  const parameters = row.authorization_parameters;
  if (
    !Array.isArray(scopes) ||
    !scopes.every((scope) => typeof scope === "string") ||
    typeof parameters !== "object" ||
    parameters === null ||
    Array.isArray(parameters) ||
    !Object.values(parameters).every((value) => typeof value === "string")
  ) {
    invalid();
  }
  return {
    templateId: text(row, "template_id"),
    version: integer(row, "version"),
    ...(row.oauth_client_id === null ? {} : { oauthClientId: text(row, "oauth_client_id") }),
    mode: row.mode === "manual" || row.mode === "mcp_discovery" ? row.mode : invalid(),
    ...(row.revocation_url === null ? {} : { revocationUrl: text(row, "revocation_url") }),
    ...(row.observed_metadata === null
      ? {}
      : {
          observed: row.observed_metadata as NonNullable<
            OAuthConnectionTemplateVersion["observed"]
          >,
          mcp: {
            serverUrl: text(row.observed_metadata as Row, "serverUrl"),
            resource: text(row.observed_metadata as Row, "resource"),
          },
        }),
    issuer: text(row, "issuer"),
    authorizationUrl: text(row, "authorization_url"),
    tokenUrl: text(row, "token_url"),
    scopes,
    authorizationParameters: parameters as Record<string, string>,
    destinations: row.destinations as OAuthConnectionTemplateVersion["destinations"],
    createdAt: timestamp(row, "version_created_at"),
  };
}

function templateFromRow(row: Row): Readonly<ConnectionTemplate> {
  return immutableCopy({
    id: text(row, "id"),
    ...(row.namespace_id === null ? {} : { namespaceId: text(row, "namespace_id") }),
    displayName: text(row, "display_name"),
    current: versionFromRow(row),
    createdAt: timestamp(row, "created_at"),
  });
}

function registrationFromRow(row: Row): Readonly<OAuthClient> {
  return immutableCopy({
    id: text(row, "id"),
    ...(row.namespace_id === null ? {} : { namespaceId: text(row, "namespace_id") }),
    issuer: text(row, "issuer"),
    clientId: text(row, "client_id"),
    displayName: text(row, "display_name"),
    tokenUrl: text(row, "token_url"),
    ...(row.revocation_url === null ? {} : { revocationUrl: text(row, "revocation_url") }),
    tokenEndpointAuthMethod:
      row.token_endpoint_auth_method as OAuthClient["tokenEndpointAuthMethod"],
    credentialRefreshDriverId: text(row, "credential_refresh_driver_id"),
    createdAt: timestamp(row, "created_at"),
  });
}

async function insertVersion(
  client: PostgresQueryClient,
  version: OAuthConnectionTemplateVersion,
): Promise<void> {
  await client.query(
    `INSERT INTO occ.oauth_connection_template_versions
     (template_id, version, oauth_client_id, issuer, mode, authorization_url, token_url, revocation_url, scopes,
      authorization_parameters, destinations, observed_metadata, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      version.templateId,
      version.version,
      version.oauthClientId ?? null,
      version.issuer,
      version.mode,
      version.authorizationUrl,
      version.tokenUrl,
      version.revocationUrl ?? null,
      version.scopes,
      JSON.stringify(version.authorizationParameters),
      JSON.stringify(version.destinations),
      version.observed ?? null,
      version.createdAt,
    ],
  );
}

/** The database enforces the template and registration scopes and immutable versions. */
export function postgresConnectionTemplates(
  client: PostgresQueryClient,
  requireInitialized: () => Promise<unknown>,
): ConnectionTemplateRepository {
  const selectTemplates = async (where: string, values: unknown[]) =>
    (
      await client.query(
        `SELECT t.id, t.namespace_id, t.display_name, t.created_at, ${versionColumns}
         FROM occ.connection_templates t
         JOIN occ.oauth_connection_template_versions v
           ON v.template_id = t.id AND v.version = t.current_version
         ${where} ORDER BY t.id`,
        values,
      )
    ).rows.map((row) => templateFromRow(row as Row));

  return {
    findConnectionTemplate: async (templateId) =>
      (await selectTemplates("WHERE t.id = $1", [templateId]))[0],
    countNamespaceConnectionTemplates: async (namespaceId) => {
      const {
        rows: [row],
      } = await client.query(
        "SELECT count(*)::integer AS count FROM occ.connection_templates WHERE namespace_id = $1",
        [namespaceId],
      );
      return integer(row as Row, "count");
    },
    hasOtherConnectionIssuer: async (issuer) =>
      (
        await client.query(
          "SELECT 1 FROM occ.oauth_connection_template_versions WHERE issuer <> $1 LIMIT 1",
          [issuer],
        )
      ).rows.length > 0,
    listConnectionTemplates: async () => Object.freeze(await selectTemplates("", [])),
    findOAuthConnectionTemplateVersion: async (templateId, version) => {
      const [row] = (
        await client.query(
          `SELECT ${versionColumns} FROM occ.oauth_connection_template_versions v
           WHERE v.template_id = $1 AND v.version = $2`,
          [templateId, version],
        )
      ).rows;
      return row === undefined ? undefined : immutableCopy(versionFromRow(row as Row));
    },
    listOAuthClients: async () =>
      Object.freeze(
        (
          await client.query(
            "SELECT * FROM occ.oauth_clients WHERE cleanup_after IS NULL ORDER BY id",
            [],
          )
        ).rows.map((row) => registrationFromRow(row as Row)),
      ),
    countNamespaceOAuthClients: async (namespaceId) =>
      integer(
        (
          await client.query("SELECT count(*) AS n FROM occ.oauth_clients WHERE namespace_id=$1", [
            namespaceId,
          ])
        ).rows[0] as Row,
        "n",
      ),
    findOAuthClient: async (registrationId) => {
      const [row] = (
        await client.query(
          `SELECT * FROM occ.oauth_clients WHERE id = $1 AND cleanup_after IS NULL`,
          [registrationId],
        )
      ).rows;
      return row === undefined ? undefined : registrationFromRow(row as Row);
    },
    lockOAuthClient: async (id) => {
      const [row] = (
        await client.query(
          "SELECT * FROM occ.oauth_clients WHERE id=$1 AND cleanup_after IS NULL FOR UPDATE",
          [id],
        )
      ).rows;
      return row === undefined ? undefined : registrationFromRow(row as Row);
    },
    listOAuthClientCleanups: async (limit) =>
      (
        await client.query(
          "SELECT id FROM occ.oauth_clients WHERE cleanup_after<=now() ORDER BY cleanup_after,id LIMIT $1",
          [limit],
        )
      ).rows.map((row) => text(row as Row, "id")),
    lockOAuthClientForCleanup: async (id, dueOnly) => {
      const [row] = (
        await client.query(
          "SELECT * FROM occ.oauth_clients WHERE id=$1 AND cleanup_after IS NOT NULL AND (NOT $2::boolean OR cleanup_after<=now()) FOR UPDATE SKIP LOCKED",
          [id, dueOnly],
        )
      ).rows;
      return row === undefined ? undefined : registrationFromRow(row as Row);
    },
    setOAuthClientCleanup: async (id, cleanupAfter) => {
      await client.query("UPDATE occ.oauth_clients SET cleanup_after=$2 WHERE id=$1", [
        id,
        cleanupAfter,
      ]);
    },
    lockConnectionTemplate: async (templateId) => {
      await client.query("SELECT id FROM occ.connection_templates WHERE id = $1 FOR UPDATE", [
        templateId,
      ]);
      // A concurrent editor may have committed a new current version while we waited.
      return (await selectTemplates("WHERE t.id = $1", [templateId]))[0];
    },
    createOAuthClient: async (registration, cleanupAfter) => {
      await requireInitialized();
      await client.query(
        `INSERT INTO occ.oauth_clients
         (id, namespace_id, issuer, client_id, credential_refresh_driver_id, created_at, display_name, token_url, revocation_url, token_endpoint_auth_method, cleanup_after)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          registration.id,
          registration.namespaceId ?? null,
          registration.issuer,
          registration.clientId,
          registration.credentialRefreshDriverId,
          registration.createdAt,
          registration.displayName,
          registration.tokenUrl,
          registration.revocationUrl ?? null,
          registration.tokenEndpointAuthMethod,
          cleanupAfter ?? null,
        ],
      );
      return immutableCopy(registration);
    },
    deleteOAuthClient: async (id, retainForCleanup) => {
      const mutation = retainForCleanup
        ? "UPDATE occ.oauth_clients r SET cleanup_after=now()"
        : "DELETE FROM occ.oauth_clients r";
      const result = await client.query(
        `${mutation} WHERE r.id=$1 AND NOT EXISTS(SELECT 1 FROM occ.oauth_connection_template_versions v WHERE v.oauth_client_id=r.id)`,
        [id],
      );
      return result.rowCount === 1;
    },
    createConnectionTemplate: async (template) => {
      await requireInitialized();
      // The current-version foreign key is deferred, so the template row goes in first.
      await client.query(
        `INSERT INTO occ.connection_templates (id, namespace_id, display_name, current_version, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          template.id,
          template.namespaceId ?? null,
          template.displayName,
          template.current.version,
          template.createdAt,
        ],
      );
      await insertVersion(client, template.current);
      return immutableCopy(template);
    },
    updateConnectionTemplate: async (templateId, changes) => {
      if (changes.version !== undefined) {
        await insertVersion(client, changes.version);
      }
      const updated = await client.query(
        `UPDATE occ.connection_templates
         SET display_name = COALESCE($2, display_name),
             current_version = COALESCE($3, current_version)
         WHERE id = $1`,
        [templateId, changes.displayName ?? null, changes.version?.version ?? null],
      );
      if (updated.rowCount !== 1) {
        return undefined;
      }
      return (await selectTemplates("WHERE t.id = $1", [templateId]))[0];
    },
    deleteConnectionTemplate: async (templateId) => {
      try {
        const deleted = await client.query(`DELETE FROM occ.connection_templates WHERE id = $1`, [
          templateId,
        ]);
        return deleted.rowCount === 1;
      } catch (error) {
        // A saved account or an unexpired consent attempt can still reference a version.
        if (
          error instanceof Error &&
          "code" in error &&
          (error.code === "23001" || error.code === "23503") &&
          "constraint" in error &&
          (error.constraint === "connection_sessions_template_version" ||
            error.constraint === "saved_connections_template_version")
        ) {
          throw new ResourceStateConflictError("The connection template is in use.");
        }
        throw error;
      }
    },
  };
}
