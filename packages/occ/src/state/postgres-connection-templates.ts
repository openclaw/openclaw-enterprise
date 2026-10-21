import { immutableCopy } from "@openclaw-enterprise/utils";
import type {
  ConnectionClientRegistration,
  ConnectionTemplate,
  ConnectionTemplateVersion,
} from "@openclaw-enterprise/contracts";
import { DependencyUnavailableError, ResourceStateConflictError } from "../errors.ts";
import type { ConnectionTemplateRepository } from "./platform-state.ts";
import type { PostgresQueryClient } from "./postgres-work-queue.ts";

type Row = Record<string, unknown>;

const versionColumns = `v.template_id, v.version, v.client_registration_id, v.issuer, v.client_id,
  v.authorization_url, v.token_url, v.scopes, v.authorization_parameters, v.endpoint_host,
  v.endpoint_port, v.endpoint_path, v.env_var, v.created_at AS version_created_at`;

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
    clientRegistrationId: text(row, "client_registration_id"),
    issuer: text(row, "issuer"),
    clientId: text(row, "client_id"),
    authorizationUrl: text(row, "authorization_url"),
    tokenUrl: text(row, "token_url"),
    scopes,
    authorizationParameters: parameters as Record<string, string>,
    endpoint: {
      host: text(row, "endpoint_host"),
      port: integer(row, "endpoint_port"),
      path: text(row, "endpoint_path"),
    },
    envVar: text(row, "env_var"),
    createdAt: timestamp(row, "version_created_at"),
  };
}

function templateFromRow(row: Row): Readonly<ConnectionTemplate> {
  return immutableCopy({
    id: text(row, "id"),
    displayName: text(row, "display_name"),
    current: versionFromRow(row),
    createdAt: timestamp(row, "created_at"),
  });
}

function registrationFromRow(row: Row): Readonly<ConnectionClientRegistration> {
  return immutableCopy({
    id: text(row, "id"),
    issuer: text(row, "issuer"),
    clientId: text(row, "client_id"),
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
     (template_id, version, client_registration_id, issuer, client_id, authorization_url,
      token_url, scopes, authorization_parameters, endpoint_host, endpoint_port, endpoint_path,
      env_var, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9::jsonb, $10, $11, $12, $13, $14)`,
    [
      version.templateId,
      version.version,
      version.clientRegistrationId,
      version.issuer,
      version.clientId,
      version.authorizationUrl,
      version.tokenUrl,
      version.scopes,
      JSON.stringify(version.authorizationParameters),
      version.endpoint.host,
      version.endpoint.port,
      version.endpoint.path,
      version.envVar,
      version.createdAt,
    ],
  );
}

/** The database enforces value formats, immutable versions, and in-use deletion refusal. */
export function postgresConnectionTemplates(
  client: PostgresQueryClient,
  requireInitialized: () => Promise<unknown>,
): ConnectionTemplateRepository {
  const selectTemplates = async (where: string, values: unknown[], lock = "") =>
    (
      await client.query(
        `SELECT t.id, t.display_name, t.created_at, ${versionColumns}
         FROM occ.connection_templates t
         JOIN occ.connection_template_versions v
           ON v.template_id = t.id AND v.version = t.current_version
         ${where} ORDER BY t.id ${lock}`,
        values,
      )
    ).rows.map((row) => templateFromRow(row as Row));

  return {
    findConnectionTemplate: async (templateId) =>
      (await selectTemplates("WHERE t.id = $1", [templateId]))[0],
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
    findClientRegistration: async (issuer, clientId) => {
      const [row] = (
        await client.query(
          `SELECT * FROM occ.connection_client_registrations WHERE issuer = $1 AND client_id = $2`,
          [issuer, clientId],
        )
      ).rows;
      return row === undefined ? undefined : registrationFromRow(row as Row);
    },
    findClientRegistrationById: async (registrationId) => {
      const [row] = (
        await client.query(`SELECT * FROM occ.connection_client_registrations WHERE id = $1`, [
          registrationId,
        ])
      ).rows;
      return row === undefined ? undefined : registrationFromRow(row as Row);
    },
    lockConnectionTemplate: async (templateId) =>
      (await selectTemplates("WHERE t.id = $1", [templateId], "FOR UPDATE OF t"))[0],
    createClientRegistration: async (registration) => {
      await requireInitialized();
      await client.query(
        `INSERT INTO occ.connection_client_registrations
         (id, issuer, client_id, credential_refresh_driver_id, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          registration.id,
          registration.issuer,
          registration.clientId,
          registration.credentialRefreshDriverId,
          registration.createdAt,
        ],
      );
      return immutableCopy(registration);
    },
    deleteClientRegistration: async (registrationId) => {
      const deleted = await client.query(
        `DELETE FROM occ.connection_client_registrations r WHERE r.id = $1
         AND NOT EXISTS (
           SELECT 1 FROM occ.connection_template_versions v
           WHERE v.client_registration_id = r.id
         )`,
        [registrationId],
      );
      return deleted.rowCount === 1;
    },
    createConnectionTemplate: async (template) => {
      await requireInitialized();
      // The current-version foreign key is deferred, so the template row goes in first.
      await client.query(
        `INSERT INTO occ.connection_templates (id, display_name, current_version, created_at)
         VALUES ($1, $2, $3, $4)`,
        [template.id, template.displayName, template.current.version, template.createdAt],
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
        // A connection that still references a version restricts the delete (restrict_violation).
        if ((error as { code?: unknown }).code === "23001") {
          throw new ResourceStateConflictError(
            "The connection template still has connections; disconnect them first.",
          );
        }
        throw error;
      }
    },
  };
}
