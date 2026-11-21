import { isDeepStrictEqual } from "node:util";
import {
  connectionValuesChanged,
  ConnectionTemplateValidationError,
  normalizeConnectionDestinations,
  validateConnectionTemplateAuthorization,
  type AuditEvent,
  type ConnectionTemplate,
  type ConnectionTemplateValues,
  type McpAuthorizationMetadata,
  type OAuthClient,
  type SecretDriver,
} from "@openclaw-enterprise/contracts";
import { immutableCopy, isNonEmptyString } from "@openclaw-enterprise/utils";

import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import {
  DependencyUnavailableError,
  ResourceStateConflictError,
  ScopeViolationError,
} from "./errors.ts";
import type { StoredOAuthClient } from "./ports/oauth-client.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";
import { lockNamespace } from "./resource-scope.ts";
import { secretOperation } from "./secret-operations.ts";

interface ApprovedTemplateSettings {
  readonly scopes: readonly string[];
  readonly authorizationParameters?: Readonly<Record<string, string>>;
  readonly oauthClientId?: string;
}
type TemplateInput = ApprovedTemplateSettings &
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
  );
export type CreateConnectionTemplateInput = TemplateInput & {
  readonly namespaceId?: string;
  readonly displayName: string;
};
export type UpdateConnectionTemplateInput =
  { readonly displayName: string } | (TemplateInput & { readonly displayName?: string });
export type CreateOAuthClientInput = Pick<
  OAuthClient,
  "displayName" | "clientId" | "tokenEndpointAuthMethod"
> & {
  readonly connectionTemplateId: string;
  readonly connectionTemplateVersion: number;
  readonly clientSecret?: string;
};
export type DiscoverMcp = (serverUrl: string, issuer?: string) => Promise<McpAuthorizationMetadata>;

function templateAcceptsAuthMethod(
  observed: McpAuthorizationMetadata | undefined,
  method: OAuthClient["tokenEndpointAuthMethod"],
): boolean {
  return (
    !observed || (observed.tokenEndpointAuthMethods ?? ["client_secret_basic"]).includes(method)
  );
}

async function effectiveConnectionTemplate(
  input: TemplateInput,
  discover: DiscoverMcp,
): Promise<ConnectionTemplateValues> {
  const settings = {
    scopes: [...input.scopes],
    authorizationParameters: input.authorizationParameters ?? {},
    ...(input.oauthClientId && { oauthClientId: input.oauthClientId }),
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

async function assertTemplateClient(
  state: PlatformUnitOfWork,
  values: ConnectionTemplateValues,
  namespaceId?: string,
) {
  if (!values.oauthClientId) {
    return;
  }
  const client = await state.connectionTemplates.findOAuthClient(values.oauthClientId);
  if (
    !client ||
    (client.namespaceId !== undefined && client.namespaceId !== namespaceId) ||
    client.issuer !== values.issuer ||
    client.tokenUrl !== values.tokenUrl ||
    (values.revocationUrl !== undefined && client.revocationUrl !== values.revocationUrl) ||
    !templateAcceptsAuthMethod(values.observed, client.tokenEndpointAuthMethod)
  ) {
    throw new ResourceStateConflictError(
      "Choose a client approved for this scope, issuer and provider endpoints.",
    );
  }
}

function oauthClientMetadata({
  secretDriverId: _owner,
  ...metadata
}: StoredOAuthClient): OAuthClient {
  return immutableCopy(metadata);
}

interface ConnectionAdministrationDependencies {
  readonly installationId: string;
  readonly transactions: Pick<
    ControllerTransactions,
    "read" | "transact" | "requireIndependentMutation"
  >;
  readonly authority: Pick<ControllerAuthority, "authorize">;
  readonly secretDriver: (expectedId?: string) => Pick<SecretDriver, "id" | "installationSecrets">;
  readonly now: () => Date;
  readonly timestamp: () => string;
}

export function createConnectionAdministration({
  installationId,
  transactions,
  authority,
  secretDriver,
  now,
  timestamp,
}: ConnectionAdministrationDependencies) {
  const { read, transact, requireIndependentMutation } = transactions;

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
  ): Promise<Readonly<ConnectionTemplate>> {
    await authorizeAdministration(principalId);
    const values = await effectiveConnectionTemplate(input, discover);
    return transact(async (state) => {
      await authorizeAdministration(principalId);
      await lockTemplateScope(state, input.namespaceId);
      await assertTemplateClient(state, values, input.namespaceId);
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
    // Resolve the exact authorized target before any administrator-selected outbound discovery.
    await getConnectionTemplate(principalId, id);
    const values = "mode" in input ? await effectiveConnectionTemplate(input, discover) : undefined;
    return transact(async (state) => {
      await authorizeAdministration(principalId);
      const current = await state.connectionTemplates.lockConnectionTemplate(id);
      if (!current) {
        throw new ScopeViolationError("The connection template does not exist.");
      }
      if (values) {
        await assertTemplateClient(state, values, current.namespaceId);
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

  async function listOAuthClients(principalId: string) {
    await authorizeAdministration(principalId);
    const clients = await read((view) => view.connectionTemplates.listOAuthClients());
    return Object.freeze(clients.map(oauthClientMetadata));
  }

  async function createOAuthClient(
    principalId: string,
    input: CreateOAuthClientInput,
    audit?: (id: string) => AuditEvent,
    holdSession?: (unit: PlatformUnitOfWork) => Promise<void>,
  ) {
    requireIndependentMutation("OAuth client registration");
    const template = await getConnectionTemplate(principalId, input.connectionTemplateId);
    const assertSelectedVersion = (version: number | undefined) => {
      if (version !== input.connectionTemplateVersion) {
        throw new ResourceStateConflictError(
          "The template changed. Choose its current version and register again.",
        );
      }
    };
    assertSelectedVersion(template.current.version);
    const { clientSecret, tokenEndpointAuthMethod } = input;
    if (
      tokenEndpointAuthMethod === "none"
        ? clientSecret !== undefined
        : !isNonEmptyString(clientSecret)
    ) {
      throw new ConnectionTemplateValidationError(
        "clientSecret",
        "Provide a secret only for a confidential OAuth client.",
      );
    }
    const { issuer, tokenUrl, revocationUrl, observed } = template.current;
    if (!templateAcceptsAuthMethod(observed, tokenEndpointAuthMethod)) {
      throw new ConnectionTemplateValidationError(
        "tokenEndpointAuthMethod",
        "Choose an authentication method supported by this template.",
      );
    }
    const client: OAuthClient = {
      id: `ccr_${crypto.randomUUID()}`,
      displayName: input.displayName,
      clientId: input.clientId,
      tokenEndpointAuthMethod,
      issuer,
      tokenUrl,
      ...(revocationUrl !== undefined && { revocationUrl }),
      ...(template.namespaceId !== undefined && { namespaceId: template.namespaceId }),
      createdAt: timestamp(),
    };
    const lockSelectedVersion = async (state: PlatformUnitOfWork) => {
      await authorizeAdministration(principalId);
      await holdSession?.(state);
      await lockTemplateScope(state, template.namespaceId);
      const current = await state.connectionTemplates.lockConnectionTemplate(template.id);
      assertSelectedVersion(current?.current.version);
    };
    const publish = async (state: PlatformUnitOfWork) => {
      const selected = !template.current.oauthClientId;
      if (selected) {
        // Select the first registration. Another registration never replaces a chosen client.
        const updated = await state.connectionTemplates.updateConnectionTemplate(template.id, {
          version: {
            ...template.current,
            version: template.current.version + 1,
            oauthClientId: client.id,
            createdAt: timestamp(),
          },
        });
        if (!updated) {
          throw new ResourceStateConflictError("The template changed during client registration.");
        }
      }
      if (audit) {
        const event = audit(client.id);
        await state.audit.append({
          ...event,
          details: {
            ...event.details,
            connectionTemplateId: template.id,
            connectionTemplateVersion: template.current.version,
            selected,
          },
        });
      }
    };
    await transact(async (state) => {
      await lockSelectedVersion(state);
      // The cleanup worker can reclaim a hidden reservation if the private write fails.
      const cleanupAfter = clientSecret
        ? new Date(now().getTime() + 5 * 60_000).toISOString()
        : undefined;
      const registration = clientSecret
        ? { ...client, secretDriverId: oauthClientSecretDriver().id }
        : client;
      await state.connectionTemplates.createOAuthClient(registration, cleanupAfter);
      if (!clientSecret) {
        await publish(state);
      }
    });
    if (clientSecret) {
      await transact(async (state) => {
        await lockSelectedVersion(state);
        const reserved = await state.connectionTemplates.lockOAuthClientForCleanup(
          client.id,
          false,
        );
        if (!reserved) {
          throw new ResourceStateConflictError(
            "The OAuth client reservation expired. Create the client again.",
          );
        }
        const { store, ref } = oauthClientSecret(reserved);
        await secretOperation(() => store.create(ref, clientSecret));
        await state.connectionTemplates.setOAuthClientCleanup(client.id, null);
        await publish(state);
      });
    }
    return client;
  }

  async function rotateOAuthClientSecret(
    principalId: string,
    id: string,
    clientSecret: string,
    audit?: AuditEvent,
    holdSession?: (unit: PlatformUnitOfWork) => Promise<void>,
  ) {
    requireIndependentMutation("OAuth client secret rotation");
    await authorizeAdministration(principalId);
    const lockClient = async (state: PlatformUnitOfWork) => {
      const client = await state.connectionTemplates.lockOAuthClient(id);
      await authorizeAdministration(principalId);
      await holdSession?.(state);
      if (!client) {
        throw new ScopeViolationError("The OAuth client does not exist.");
      }
      if (client.tokenEndpointAuthMethod === "none") {
        throw new ResourceStateConflictError("This public client authenticates without a secret.");
      }
      return client;
    };
    if (audit) {
      // An in-place Driver write can succeed before SQL records its outcome. Persist the request first.
      await transact(async (state) => {
        await lockClient(state);
        await state.audit.append({
          ...audit,
          id: `aud_${crypto.randomUUID()}`,
          details: { ...audit.details, phase: "requested" },
        });
      });
    }
    return transact(async (state) => {
      const client = await lockClient(state);
      const { store, ref } = oauthClientSecret(client);
      await secretOperation(() => store.update(ref, clientSecret));
      if (audit) {
        await state.audit.append({ ...audit, occurredAt: timestamp() });
      }
      return oauthClientMetadata(client);
    });
  }

  async function deleteOAuthClient(
    principalId: string,
    id: string,
    audit?: AuditEvent,
    holdSession?: (unit: PlatformUnitOfWork) => Promise<void>,
  ) {
    await authorizeAdministration(principalId);
    await transact(async (state) => {
      const client = await state.connectionTemplates.lockOAuthClient(id);
      await authorizeAdministration(principalId);
      await holdSession?.(state);
      if (!client) {
        throw new ScopeViolationError("The OAuth client does not exist.");
      }
      // Hide confidential clients and retain their stable private reference until removal succeeds.
      if (
        !(await state.connectionTemplates.deleteOAuthClient(
          id,
          client.tokenEndpointAuthMethod !== "none",
        ))
      ) {
        throw new ResourceStateConflictError(
          "A template version still references this OAuth client.",
        );
      }
      if (audit) {
        await state.audit.append(audit);
      }
    });
  }

  async function cleanupOAuthClients(): Promise<void> {
    const ids = await read((view) => view.connectionTemplates.listOAuthClientCleanups(32));
    for (const id of ids) {
      await transact(async (state) => {
        const client = await state.connectionTemplates.lockOAuthClientForCleanup(id, true);
        if (!client) {
          return;
        }
        try {
          const { store, ref } = oauthClientSecret(client);
          await secretOperation(() => store.delete(ref));
        } catch {
          await state.connectionTemplates.setOAuthClientCleanup(
            id,
            new Date(now().getTime() + 60_000).toISOString(),
          );
          return;
        }
        if (!(await state.connectionTemplates.deleteOAuthClient(id))) {
          throw new ResourceStateConflictError("The OAuth client is still referenced.");
        }
      });
    }
  }

  async function withOAuthClientSecret<T>(
    client: Readonly<OAuthClient>,
    use: (secret: string | undefined) => Promise<T>,
  ): Promise<T> {
    const current = await read((view) => view.connectionTemplates.findOAuthClient(client.id));
    if (!current || !isDeepStrictEqual(oauthClientMetadata(current), oauthClientMetadata(client))) {
      throw new ResourceStateConflictError("The approved OAuth client is unavailable.");
    }
    if (current.tokenEndpointAuthMethod === "none") {
      return use(undefined);
    }
    const { store, ref } = oauthClientSecret(current);
    return store.withValue(ref, use);
  }

  function oauthClientSecretDriver(expectedId?: string) {
    const driver = secretDriver(expectedId);
    if (!driver.installationSecrets) {
      throw new DependencyUnavailableError(
        "The selected Secret Driver cannot store Installation-private OAuth client secrets.",
      );
    }
    return { id: driver.id, store: driver.installationSecrets };
  }

  function oauthClientSecret(client: StoredOAuthClient) {
    if (!client.secretDriverId) {
      throw new ResourceStateConflictError("The OAuth client has no private secret.");
    }
    return {
      store: oauthClientSecretDriver(client.secretDriverId).store,
      ref: { installationId, id: client.id },
    };
  }

  return {
    listConnectionTemplates,
    getConnectionTemplate,
    discoverConnectionTemplate,
    createConnectionTemplate,
    updateConnectionTemplate,
    deleteConnectionTemplate,
    listOAuthClients,
    createOAuthClient,
    rotateOAuthClientSecret,
    deleteOAuthClient,
    cleanupOAuthClients,
    withOAuthClientSecret,
  };
}
