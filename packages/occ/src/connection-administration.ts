import {
  connectionValuesChanged,
  ConnectionTemplateValidationError,
  normalizeConnectionDestinations,
  normalizeStaticKeyDestinations,
  validateConnectionTemplateAuthorization,
  type AuditEvent,
  type ConnectionTemplate,
  type ConnectionTemplateValues,
  type ConnectionTemplateSettings,
  type StaticKeyTemplateValues,
  type McpAuthorizationMetadata,
  type OAuthClient,
} from "@openclaw-enterprise/contracts";

import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import {
  DependencyUnavailableError,
  ResourceStateConflictError,
  ScopeViolationError,
} from "./errors.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";
import { lockNamespace } from "./resource-scope.ts";

interface ApprovedTemplateSettings {
  readonly scopes: readonly string[];
  readonly authorizationParameters?: Readonly<Record<string, string>>;
}
type TemplateInput =
  | StaticKeyTemplateValues
  | (ApprovedTemplateSettings &
      (
        | {
            readonly mode: "manual";
            readonly issuer: string;
            readonly authorizationUrl: string;
            readonly tokenUrl: string;
            readonly revocationUrl?: string;
            readonly destinations: readonly {
              readonly host: string;
              readonly port?: number;
              readonly path?: string;
            }[];
          }
        | { readonly mode: "mcp_discovery"; readonly serverUrl: string; readonly issuer: string }
      ));
export type CreateConnectionTemplateInput = TemplateInput & {
  readonly namespaceId?: string;
  readonly displayName: string;
};
export type UpdateConnectionTemplateInput =
  { readonly displayName: string } | (TemplateInput & { readonly displayName?: string });
export type DiscoverMcp = (serverUrl: string, issuer?: string) => Promise<McpAuthorizationMetadata>;

/** Code-only collaborator for issuer-owned endpoint validation and pinned token requests. */
export interface OAuthIssuerOperations {
  verifyTemplate(
    template: ConnectionTemplateValues,
    signal: AbortSignal,
  ): Promise<NonNullable<ConnectionTemplateValues["issuerVerification"]>>;
  revalidate(
    template: ConnectionTemplateValues & {
      readonly tokenEndpointAuthMethod: OAuthClient["tokenEndpointAuthMethod"];
    },
    signal: AbortSignal,
  ): Promise<void>;
  fetchToken(template: ConnectionTemplateValues, init: RequestInit): Promise<Response>;
}

async function effectiveConnectionTemplate(
  input: TemplateInput,
  discover: DiscoverMcp,
): Promise<ConnectionTemplateSettings> {
  if (input.mode === "static_bearer") {
    return { mode: input.mode, destinations: normalizeStaticKeyDestinations(input.destinations) };
  }
  const settings = {
    scopes: [...input.scopes],
    authorizationParameters: input.authorizationParameters ?? {},
  };
  let values: ConnectionTemplateValues;
  if (input.mode === "manual") {
    values = {
      ...settings,
      mode: input.mode,
      issuer: input.issuer,
      authorizationUrl: input.authorizationUrl,
      tokenUrl: input.tokenUrl,
      ...(input.revocationUrl && { revocationUrl: input.revocationUrl }),
      destinations: normalizeConnectionDestinations(input.destinations),
    };
  } else {
    const observed = await discover(input.serverUrl, input.issuer);
    if (observed.issuer !== input.issuer || !observed.authorizationUrl || !observed.tokenUrl) {
      throw new ConnectionTemplateValidationError(
        "issuer",
        "Choose a verified issuer for this MCP server.",
      );
    }
    const offered = [...observed.requestedScopes, ...(observed.resourceScopes ?? [])];
    const allowed = new Set(offered.length ? offered : observed.supportedScopes);
    const supported = observed.supportedScopes && new Set(observed.supportedScopes);
    const approved = new Set(settings.scopes);
    if (approved.size && observed.requestedScopes.some((scope) => !approved.has(scope))) {
      throw new ConnectionTemplateValidationError(
        "scopes",
        "Include the scopes required by the MCP server or choose no template limit.",
      );
    }
    if (
      settings.scopes.some((scope) => !allowed.has(scope) || (supported && !supported.has(scope)))
    ) {
      throw new ConnectionTemplateValidationError(
        "scopes",
        "Choose only scopes advertised for this MCP resource.",
      );
    }
    const server = new URL(observed.serverUrl);
    values = {
      ...settings,
      mode: input.mode,
      issuer: observed.issuer,
      authorizationUrl: observed.authorizationUrl,
      tokenUrl: observed.tokenUrl,
      ...(observed.revocationUrl && { revocationUrl: observed.revocationUrl }),
      destinations: normalizeConnectionDestinations([
        {
          host: server.hostname,
          port: Number(server.port || 443),
          path: server.pathname,
        },
      ]),
      mcp: { serverUrl: observed.serverUrl, resource: observed.resource },
      observed,
    };
  }
  validateConnectionTemplateAuthorization(values);
  return values;
}

interface ConnectionAdministrationDependencies {
  readonly installationId: string;
  readonly transactions: Pick<ControllerTransactions, "read" | "transact">;
  readonly authority: Pick<ControllerAuthority, "authorize">;
  readonly tokenServiceTimeoutMs: number;
  readonly oauthIssuer: OAuthIssuerOperations | undefined;
  readonly timestamp: () => string;
}

export function createConnectionAdministration({
  installationId,
  transactions,
  authority,
  tokenServiceTimeoutMs,
  oauthIssuer,
  timestamp,
}: ConnectionAdministrationDependencies) {
  const { read, transact } = transactions;

  async function authorizeAdministration(principalId: string): Promise<void> {
    await authority.authorize(principalId, "administer", {
      kind: "installation",
      id: installationId,
    });
  }

  async function listConnectionTemplates(
    principalId: string,
  ): Promise<readonly Readonly<ConnectionTemplate>[]> {
    await authorizeAdministration(principalId);
    return read((state) => state.connectionTemplates.listConnectionTemplates());
  }

  async function getConnectionTemplate(
    principalId: string,
    templateId: string,
  ): Promise<Readonly<ConnectionTemplate>> {
    await authorizeAdministration(principalId);
    const template = await read((state) =>
      state.connectionTemplates.findConnectionTemplate(templateId),
    );
    if (!template) {
      throw new ScopeViolationError("The connection template does not exist.");
    }
    return template;
  }

  async function discoverConnectionTemplate(
    principalId: string,
    input: { serverUrl: string; issuer?: string },
    discover: DiscoverMcp,
  ) {
    await authorizeAdministration(principalId);
    return discover(input.serverUrl, input.issuer);
  }

  async function lockTemplateScope(state: PlatformUnitOfWork, namespaceId?: string) {
    if (
      namespaceId !== undefined &&
      (await lockNamespace(state, namespaceId)).status === "deleting"
    ) {
      throw new ResourceStateConflictError("The Namespace is being deleted.");
    }
  }

  async function createConnectionTemplate(
    principalId: string,
    input: CreateConnectionTemplateInput,
    discover: DiscoverMcp,
    audit?: (id: string) => AuditEvent,
    holdSession?: (unit: PlatformUnitOfWork) => Promise<void>,
    verifyIssuer = true,
  ): Promise<Readonly<ConnectionTemplate>> {
    await authorizeAdministration(principalId);
    const values = await approvedTemplate(input, discover, verifyIssuer);
    return transact(async (state) => {
      await authorizeAdministration(principalId);
      await lockTemplateScope(state, input.namespaceId);
      const templateId = `ctp_${crypto.randomUUID()}`;
      const createdAt = timestamp();
      const template = await state.connectionTemplates.createConnectionTemplate({
        id: templateId,
        displayName: input.displayName,
        ...(input.namespaceId && { namespaceId: input.namespaceId }),
        createdAt,
        current: { ...values, templateId, version: 1, createdAt },
      });
      await holdSession?.(state);
      if (audit) {
        await state.audit.append(audit(templateId));
      }
      return template;
    });
  }

  async function updateConnectionTemplate(
    principalId: string,
    id: string,
    input: UpdateConnectionTemplateInput,
    discover: DiscoverMcp,
    audit?: AuditEvent,
    holdSession?: (unit: PlatformUnitOfWork) => Promise<void>,
  ) {
    // Resolve the exact authorized target and immutable authentication method before discovery.
    const template = await getConnectionTemplate(principalId, id);
    if (
      "mode" in input &&
      (template.current.mode === "static_bearer") !== (input.mode === "static_bearer")
    ) {
      throw new ResourceStateConflictError(
        "Create a new connection template to change its authentication method.",
      );
    }
    const values = "mode" in input ? await approvedTemplate(input, discover) : undefined;
    return transact(async (state) => {
      await authorizeAdministration(principalId);
      const current = await state.connectionTemplates.lockConnectionTemplate(id);
      if (!current) {
        throw new ScopeViolationError("The connection template does not exist.");
      }
      const version =
        values && connectionValuesChanged(current.current, values)
          ? {
              ...values,
              templateId: id,
              version: current.current.version + 1,
              createdAt: timestamp(),
            }
          : undefined;
      const updated = await state.connectionTemplates.updateConnectionTemplate(id, {
        ...(input.displayName !== undefined && { displayName: input.displayName }),
        ...(version && { version }),
      });
      if (!updated) {
        throw new ResourceStateConflictError("The template changed during the update.");
      }
      await holdSession?.(state);
      if (audit) {
        await state.audit.append(audit);
      }
      return updated;
    });
  }

  async function deleteConnectionTemplate(
    principalId: string,
    id: string,
    audit?: AuditEvent,
    holdSession?: (unit: PlatformUnitOfWork) => Promise<void>,
  ) {
    await transact(async (state) => {
      await authorizeAdministration(principalId);
      if (!(await state.connectionTemplates.deleteConnectionTemplate(id))) {
        throw new ScopeViolationError("The connection template does not exist.");
      }
      await holdSession?.(state);
      if (audit) {
        await state.audit.append(audit);
      }
    });
  }

  async function approvedTemplate(input: TemplateInput, discover: DiscoverMcp, verify = true) {
    const values = await effectiveConnectionTemplate(input, discover);
    if (values.mode === "static_bearer" || !verify) {
      return values;
    }
    if (!oauthIssuer) {
      throw new DependencyUnavailableError("OAuth issuer verification is unavailable.");
    }
    const issuerVerification = await oauthIssuer.verifyTemplate(
      values,
      AbortSignal.timeout(tokenServiceTimeoutMs),
    );
    return { ...values, issuerVerification };
  }

  return {
    listConnectionTemplates,
    getConnectionTemplate,
    discoverConnectionTemplate,
    createConnectionTemplate,
    updateConnectionTemplate,
    deleteConnectionTemplate,
  };
}
