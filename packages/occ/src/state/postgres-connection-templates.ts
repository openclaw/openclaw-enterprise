import { immutableCopy } from "@openclaw-enterprise/utils";
import type {
  OAuthClient,
  ConnectionTemplate,
  ConnectionTemplateVersion,
} from "@openclaw-enterprise/contracts";
import { DependencyUnavailableError } from "../errors.ts";
import type { ConnectionTemplateRepository } from "./platform-state.ts";
import type { PostgresQueryClient } from "./postgres-work-queue.ts";

type Row = Record<string, unknown>;

const versionColumns = `v.template_id, v.version, v.oauth_client_id, v.issuer, v.mode, v.observed_metadata, v.revocation_url,
  v.authorization_url, v.token_url, v.scopes, v.authorization_parameters, v.endpoint_host,
  v.endpoint_port, v.endpoint_path, v.endpoint_access, v.created_at AS version_created_at`;

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

function versionFromRow(row: Row): ConnectionTemplateVersion {
  const scopes = row.scopes;
  const access = row.endpoint_access;
  const parameters = row.authorization_parameters;
  if (
    (access !== "full" && access !== "read-only") ||
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
          observed: row.observed_metadata as NonNullable<ConnectionTemplateVersion["observed"]>,
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
    recipient: {
      host: text(row, "endpoint_host"),
      port: integer(row, "endpoint_port"),
      path: text(row, "endpoint_path"),
      access,
    },
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
    ...(row.secret_registration_id === null
      ? {}
      : { secretRegistrationId: text(row, "secret_registration_id") }),
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
  version: ConnectionTemplateVersion,
): Promise<void> {
  await client.query(
    `INSERT INTO occ.connection_template_versions
     (template_id, version, oauth_client_id, issuer, mode, authorization_url, token_url, revocation_url, scopes,
      authorization_parameters, endpoint_host, endpoint_port, endpoint_path, endpoint_access, observed_metadata, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
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
      version.recipient.host,
      version.recipient.port,
      version.recipient.path,
      version.recipient.access,
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
         JOIN occ.connection_template_versions v
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
    listConnectionTemplates: async () => Object.freeze(await selectTemplates("", [])),
    findConnectionTemplateVersion: async (templateId, version) => {
      const [row] = (
        await client.query(
          `SELECT ${versionColumns} FROM occ.connection_template_versions v
           WHERE v.template_id = $1 AND v.version = $2`,
          [templateId, version],
        )
      ).rows;
      return row === undefined ? undefined : immutableCopy(versionFromRow(row as Row));
    },
    listOAuthClients: async () =>
      Object.freeze(
        (await client.query("SELECT * FROM occ.oauth_clients ORDER BY id", [])).rows.map((row) =>
          registrationFromRow(row as Row),
        ),
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
        await client.query(`SELECT * FROM occ.oauth_clients WHERE id = $1`, [registrationId])
      ).rows;
      return row === undefined ? undefined : registrationFromRow(row as Row);
    },
    lockOAuthClient: async (id) => {
      const [row] = (
        await client.query("SELECT * FROM occ.oauth_clients WHERE id=$1 FOR UPDATE", [id])
      ).rows;
      return row === undefined ? undefined : registrationFromRow(row as Row);
    },
    setOAuthClientSecret: async (id, handle) => {
      await client.query("UPDATE occ.oauth_clients SET secret_registration_id=$2 WHERE id=$1", [
        id,
        handle,
      ]);
    },
    listRetiredOAuthClientSecrets: async (limit) =>
      (
        await client.query(
          "SELECT * FROM occ.retired_oauth_client_secrets WHERE retry_at <= now() ORDER BY retry_at,id LIMIT $1",
          [limit],
        )
      ).rows.map((row) => ({
        id: text(row as Row, "id"),
        issuer: text(row as Row, "issuer"),
        clientId: text(row as Row, "client_id"),
        credentialRefreshDriverId: text(row as Row, "credential_refresh_driver_id"),
      })),
    queueOAuthClientSecretCleanup: async (ref, phase) => {
      await client.query(
        `INSERT INTO occ.retired_oauth_client_secrets(id,issuer,client_id,credential_refresh_driver_id,retry_at)
         VALUES ($1,$2,$3,$4,CASE WHEN $5='staging' THEN now()+interval '5 minutes' ELSE now() END)`,
        [ref.id, ref.issuer, ref.clientId, ref.credentialRefreshDriverId, phase],
      );
    },
    lockOAuthClientSecretCleanup: async (id, dueOnly) =>
      (
        await client.query(
          `SELECT id FROM occ.retired_oauth_client_secrets WHERE id=$1 AND (NOT $2::boolean OR retry_at <= now()) FOR UPDATE SKIP LOCKED`,
          [id, dueOnly],
        )
      ).rowCount === 1,
    deferRetiredOAuthClientSecret: async (id) => {
      await client.query(
        "UPDATE occ.retired_oauth_client_secrets SET retry_at=now()+INTERVAL '1 minute' WHERE id=$1",
        [id],
      );
    },
    forgetRetiredOAuthClientSecret: async (id) => {
      await client.query("DELETE FROM occ.retired_oauth_client_secrets WHERE id=$1", [id]);
    },
    lockConnectionTemplate: async (templateId) => {
      await client.query("SELECT id FROM occ.connection_templates WHERE id = $1 FOR UPDATE", [
        templateId,
      ]);
      // A concurrent editor may have committed a new current version while we waited.
      return (await selectTemplates("WHERE t.id = $1", [templateId]))[0];
    },
    createOAuthClient: async (registration) => {
      await requireInitialized();
      await client.query(
        `INSERT INTO occ.oauth_clients
         (id, namespace_id, issuer, client_id, credential_refresh_driver_id, created_at, display_name, token_url, revocation_url, token_endpoint_auth_method, secret_registration_id)
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
          registration.secretRegistrationId ?? null,
        ],
      );
      return immutableCopy(registration);
    },
    deleteOAuthClient: async (registrationId) => {
      // Concurrent deletions of templates sharing a client must check the last reference
      // one at a time. A separate statement sees commits made while the lock was pending.
      await client.query(
        "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
        [`occ.oauth_clients:${registrationId}`],
      );
      const deleted = await client.query(
        `DELETE FROM occ.oauth_clients r WHERE r.id = $1
         AND NOT EXISTS (
           SELECT 1 FROM occ.connection_template_versions v
           WHERE v.oauth_client_id = r.id
         )`,
        [registrationId],
      );
      return deleted.rowCount === 1;
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
      const deleted = await client.query("DELETE FROM occ.connection_templates WHERE id = $1", [
        templateId,
      ]);
      return deleted.rowCount === 1;
    },
  };
}
