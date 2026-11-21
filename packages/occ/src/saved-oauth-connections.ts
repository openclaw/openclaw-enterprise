import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  ConnectionTemplateValidationError,
  isOAuthScopeToken,
  type AuditEvent,
  type ConnectionTemplate,
  type CredentialSource,
  type IAMDriver,
  type Namespace,
  type OAuthAccountRef,
  type OAuthClient,
  type OAuthConnectionClient,
  type OAuthConnectionTemplateVersion,
  type OAuthRefreshTokenIssuer,
  type OAuthRefreshTokenRegistration,
  type Permission,
  type SavedConnection,
  type SecretDriver,
  type TokenService,
} from "@openclaw-enterprise/contracts";
import { isNonEmptyString } from "@openclaw-enterprise/utils";
import { exchangeAuthorizationCode, startBrowserAuthorization } from "./browser-authorization.ts";
import {
  BrowserAuthorizationError,
  DependencyUnavailableError,
  NamespaceNotReadyError,
  NotImplementedError,
  ResourceConflictError,
  ResourceStateConflictError,
  ScopeViolationError,
} from "./errors.ts";
import type { PlatformReadView } from "./ports/platform-read-view.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";
import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import { exactNamespace, lockNamespace } from "./resource-scope.ts";

export interface StartNamespaceConnectionInput {
  readonly selectedScopes?: readonly string[];
  readonly sessionId: string;
  readonly namespaceId: string;
  readonly connectionTemplateId: string;
  /** The exact OCC callback URI, derived from trusted console configuration. */
  readonly redirectUri: string;
}

export interface CompleteNamespaceConnectionInput {
  readonly sessionId: string;
  readonly iss?: string;
  readonly state: string;
  /** Present on approval. */
  readonly code?: string;
  /** Present when the provider reports a refusal, such as `access_denied`. */
  readonly error?: string;
}

export const CONNECTION_OPERATION_TIMEOUT_MS = 30_000;

const CONNECTION_SESSION_TTL_MS = 10 * 60 * 1000;

function connectionConsentScopes(
  version: Readonly<OAuthConnectionTemplateVersion>,
  selection?: readonly string[],
): readonly string[] {
  if (version.mode === "manual" && version.scopes.length) {
    if (selection !== undefined) {
      throw new ConnectionTemplateValidationError(
        "selectedScopes",
        "This connection template uses fixed scopes.",
      );
    }
    return version.scopes;
  }
  const selected = selection ?? [];
  const approved = new Set(version.scopes);
  const requested = new Set(selected);
  const required = version.observed?.requestedScopes ?? [];
  if (
    (approved.size > 0 && requested.size === 0) ||
    requested.size !== selected.length ||
    selected.some(
      (scope) => !isOAuthScopeToken(scope) || (approved.size > 0 && !approved.has(scope)),
    ) ||
    required.some((scope) => !requested.has(scope))
  ) {
    throw new ConnectionTemplateValidationError(
      "selectedScopes",
      "Include each scope required by the resource and choose valid scopes within any configured limit.",
    );
  }
  return selected;
}

function browserAuthorizationRequest(
  version: Readonly<OAuthConnectionTemplateVersion>,
  client: Readonly<OAuthClient>,
  redirectUri: string,
  selectedScopes: readonly string[],
) {
  return {
    oauthClientId: client.id,
    issuer: version.issuer,
    clientId: client.clientId,
    tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
    authorizationUrl: version.authorizationUrl,
    tokenUrl: version.tokenUrl,
    ...(version.mcp ? { resource: version.mcp.resource } : {}),
    scopes: selectedScopes,
    authorizationParameters: version.authorizationParameters,
    redirectUri,
  };
}

type ConsumedConnectionSession = NonNullable<
  Awaited<ReturnType<PlatformUnitOfWork["authenticationStates"]["consumeOAuth"]>>
>;

interface SavedConnectionDependencies
  extends
    Pick<ControllerAuthority, "authorize" | "canRead" | "holdAuthority">,
    Pick<ControllerTransactions, "read" | "transact"> {
  readonly iamPolicyDriver: (
    method: "createNamespaceAccessBinding" | "createNamespaceRole",
  ) => IAMDriver;
  readonly iamPolicyOperation: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly connectionTokenIssuer: () => Pick<
    OAuthRefreshTokenIssuer,
    "status" | "maintain" | "retire"
  >;
  readonly tokenService: () => Pick<TokenService, "register">;
  readonly secretDriver: () => SecretDriver;
  readonly withOAuthClientSecret: <T>(
    client: Readonly<OAuthClient>,
    use: (value: string | undefined) => Promise<T>,
  ) => Promise<T>;
  readonly retireCredentialSourceMaterial: (
    namespace: Readonly<Namespace>,
    source: Readonly<CredentialSource>,
  ) => Promise<void>;
  readonly discardPendingConnection: (
    principalId: string,
    namespaceId: string,
    sourceId: string,
  ) => Promise<void>;
  readonly finishConnectionRevocation: (namespaceId: string, sourceId: string) => Promise<void>;
  readonly nextIdentifier: (kind: "credential_source") => string;
  readonly timestamp: () => string;
}

export function createSavedConnections(deps: SavedConnectionDependencies) {
  async function listUsableConnectionTemplates(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<ConnectionTemplate>[]> {
    await authorizeConnectionCreation(principalId, namespaceId);
    return deps.read(async (state) => {
      await exactNamespace(state, namespaceId);
      const templates = await state.connectionTemplates.listConnectionTemplates();
      return templates.filter(
        (template) =>
          (template.current.mode === "static_bearer" ||
            template.current.oauthClientId !== undefined) &&
          (template.namespaceId === undefined || template.namespaceId === namespaceId),
      );
    });
  }

  async function startNamespaceConnection(
    principalId: string,
    input: StartNamespaceConnectionInput,
    audit?: (credentialSourceId: string) => AuditEvent,
  ): Promise<{
    readonly credentialSourceId: string;
    readonly authorizationUrl: string;
    readonly expiresAt: string;
  }> {
    const { namespaceId } = input;
    await authorizeConnectionCreation(principalId, namespaceId);
    return deps.transact(async (state) => {
      const namespace = await lockNamespace(state, namespaceId);
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      await authorizeConnectionCreation(principalId, namespaceId);
      assertConnectionTokenCustody();
      const template = await state.connectionTemplates.lockConnectionTemplate(
        input.connectionTemplateId,
      );
      if (
        !template ||
        (template.namespaceId !== undefined && template.namespaceId !== namespaceId)
      ) {
        throw new ScopeViolationError("The connection template does not exist.");
      }
      const version = template.current;
      if (version.mode === "static_bearer") {
        throw new ResourceStateConflictError("A static template cannot start an OAuth connection.");
      }
      const selectedScopes = connectionConsentScopes(version, input.selectedScopes);
      const client = await connectionClientForVersion(state, namespaceId, version);
      const createdAt = deps.timestamp();
      const expiresAt = new Date(Date.parse(createdAt) + CONNECTION_SESSION_TTL_MS).toISOString();
      // Consent starts with one atomic reservation. There is no grant or worker provider to retire
      // if the browser closes. Only a successful exchange can hand material to the Token Service.
      const source = await state.credentialSources.createCredentialSource({
        id: deps.nextIdentifier("credential_source"),
        namespaceId,
        name: `Connection ${crypto.randomUUID()}`,
        type: "oauth2-refresh-token",
        config: {
          connection_template_id: template.id,
          connection_template_version: String(version.version),
          oauth_client_id: client.id,
        },
        secrets: {},
        ownerCapability: "token_service",
        state: "registering",
        createdAt,
      });
      const started = startBrowserAuthorization(
        browserAuthorizationRequest(version, client, input.redirectUri, selectedScopes),
      );
      await state.authenticationStates.create({
        kind: "oauth_connection",
        id: createHash("sha256").update(started.state).digest("hex"),
        namespaceId,
        credentialSourceId: source.id,
        sessionId: input.sessionId,
        redirectUri: input.redirectUri,
        selectedScopes,
        pkceVerifier: started.pkceVerifier,
        issuerRequired: await state.connectionTemplates.hasOtherConnectionIssuer(version.issuer),
        actorId: principalId,
        connectionTemplateId: template.id,
        connectionTemplateVersion: version.version,
        createdAt,
        expiresAt,
      });
      if (audit) {
        await state.audit.append(audit(source.id));
      }
      return {
        credentialSourceId: source.id,
        authorizationUrl: started.authorizationUrl,
        expiresAt,
      };
    });
  }

  async function expireAuthenticationStates(limit: number): Promise<void> {
    await deps.transact(async (state) => {
      const now = deps.timestamp();
      for (const attempt of await state.authenticationStates.expire(now, limit)) {
        await state.credentialSources.deleteCredentialSource(
          attempt.namespaceId,
          attempt.credentialSourceId,
        );
      }
    });
  }

  async function completeNamespaceConnection(
    principalId: string,
    input: CompleteNamespaceConnectionInput,
    audit?: (connection: Readonly<SavedConnection>) => AuditEvent,
    holdSession?: (unit: PlatformUnitOfWork) => Promise<void>,
  ): Promise<Readonly<SavedConnection>> {
    if (!isNonEmptyString(input.state)) {
      throw new BrowserAuthorizationError("missing_state", "retry");
    }
    const stateHash = createHash("sha256").update(input.state).digest("hex");
    const session = await deps.transact((state) =>
      state.authenticationStates.consumeOAuth(
        stateHash,
        principalId,
        input.sessionId,
        deps.timestamp(),
      ),
    );
    if (!session) {
      throw new BrowserAuthorizationError("unknown_session", "retry");
    }
    const { namespaceId, credentialSourceId } = session;
    const { approved, schedule } = await exchangeConnection(
      principalId,
      input,
      session,
      holdSession,
    );
    try {
      return await deps.transact(async (state) => {
        await holdSession?.(state);
        await deps.holdAuthority(state);
        await lockNamespace(state, namespaceId);
        await authorizeConnectionCreation(principalId, namespaceId);
        await assertConnectionTemplateScope(session.connectionTemplateId, namespaceId);
        await grantConnectionOwner(state, namespaceId, principalId, credentialSourceId);
        const ready = await state.credentialSources.markCredentialSourceReady(
          namespaceId,
          credentialSourceId,
        );
        if (!ready) {
          throw new ResourceStateConflictError("The pending connection changed. Connect again.");
        }
        await state.savedConnections.recordTokenSchedule(namespaceId, credentialSourceId, {
          scheduledVersion: schedule.version,
          nextRefreshAt: schedule.nextRefreshAt,
          grantedScopes: schedule.grantedScopes,
        });
        const connection = await state.savedConnections.createSavedConnection({
          ...approved,
          namespaceId,
          credentialSourceId,
          ownerPrincipalId: principalId,
          connectionTemplateId: session.connectionTemplateId,
          connectionTemplateVersion: session.connectionTemplateVersion,
          createdAt: deps.timestamp(),
        });
        if (audit) {
          await state.audit.append(audit(connection));
        }
        return connection;
      });
    } catch (error) {
      // The Token Service holds the grant. A commit with an uncertain
      // outcome is safe to retry: the internal pending-source delete refuses a ready account.
      await deps
        .discardPendingConnection(principalId, namespaceId, credentialSourceId)
        .catch(() => undefined);
      throw error;
    }
  }

  async function exchangeConnection(
    principalId: string,
    input: CompleteNamespaceConnectionInput,
    session: ConsumedConnectionSession,
    holdSession?: (unit: PlatformUnitOfWork) => Promise<void>,
  ) {
    const { namespaceId, credentialSourceId } = session;
    let exchangeStarted = false;
    let handoffStarted = false;
    try {
      await authorizeConnectionCreation(principalId, namespaceId);
      await assertConnectionTemplateScope(session.connectionTemplateId, namespaceId);
      const version = await deps.read((state) =>
        state.connectionTemplates.findOAuthConnectionTemplateVersion(
          session.connectionTemplateId,
          session.connectionTemplateVersion,
        ),
      );
      if (!version || (input.iss !== undefined && input.iss !== version.issuer)) {
        throw new BrowserAuthorizationError("issuer_mismatch", "fix_configuration");
      }
      if (input.error !== undefined || !isNonEmptyString(input.code)) {
        throw new BrowserAuthorizationError(
          input.error === "access_denied" ? "consent_denied" : "provider_error",
          "retry",
        );
      }
      // A shared redirect URI cannot identify the responding authorization server. A legacy
      // single-issuer deployment may omit iss until a second issuer has been configured.
      if (
        input.iss === undefined &&
        (session.issuerRequired ||
          (await deps.read((state) =>
            state.connectionTemplates.hasOtherConnectionIssuer(version.issuer),
          )))
      ) {
        throw new BrowserAuthorizationError("issuer_required", "fix_configuration");
      }
      assertConnectionTokenCustody();
      const client = await deps.transact(async (view) => {
        const source = await view.credentialSources.findCredentialSource(
          namespaceId,
          credentialSourceId,
        );
        if (source?.state !== "registering" || source.ownerCapability !== "token_service") {
          throw new BrowserAuthorizationError("invalid_session", "retry");
        }
        const registration = await connectionClientForVersion(view, namespaceId, version);
        await holdSession?.(view);
        return registration;
      });
      const request = browserAuthorizationRequest(
        version,
        client,
        session.redirectUri,
        session.selectedScopes,
      );
      const signal = AbortSignal.timeout(CONNECTION_OPERATION_TIMEOUT_MS);
      const code = input.code;
      const grant = await deps.withOAuthClientSecret(client, async (clientSecret) => {
        signal.throwIfAborted();
        exchangeStarted = true;
        return exchangeAuthorizationCode(request, session.pkceVerifier, code, clientSecret, signal);
      });
      handoffStarted = true;
      const schedule = await acceptConnectionTokens(
        {
          kind: "oauth_refresh_token",
          namespaceId,
          sourceId: credentialSourceId,
          approval: {
            connectionTemplateId: session.connectionTemplateId,
            connectionTemplateVersion: session.connectionTemplateVersion,
            oauthClientId: client.id,
          },
          grant,
        },
        signal,
        holdSession,
      );
      const approved = {
        issuer: version.issuer,
        tokenUrl: version.tokenUrl,
        oauthClientId: client.id,
        clientId: client.clientId,
        destinations: version.destinations,
        ...(version.mcp
          ? { resource: version.mcp.resource, mcpServerUrl: version.mcp.serverUrl }
          : {}),
        requestedScopes: session.selectedScopes,
        grantedScopes: grant.grantedScopes,
      };
      return { approved, schedule };
    } catch (error) {
      // A network timeout may have spent the code. Keep the pending source for explicit
      // retirement; never retry that exchange. Definite refusals have no material to retire.
      if (!exchangeStarted || (!handoffStarted && error instanceof BrowserAuthorizationError)) {
        await deps.transact((state) =>
          state.credentialSources.deleteCredentialSource(namespaceId, credentialSourceId),
        );
      }
      throw error;
    }
  }

  async function listNamespaceConnections(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<SavedConnection>[]> {
    await deps.authorize(principalId, "read", { kind: "namespace", id: namespaceId, namespaceId });
    return deps.read(async (state) => {
      const connections = await state.savedConnections.listNamespaceConnections(namespaceId);
      const visible: Readonly<SavedConnection>[] = [];
      for (const connection of connections) {
        if (
          await deps.canRead(principalId, {
            kind: "credential_source",
            namespaceId,
            id: connection.credentialSourceId,
          })
        ) {
          visible.push({
            ...connection,
            destinations: await effectiveConnectionDestinations(state, connection),
          });
        }
      }
      return visible;
    });
  }

  async function disconnectNamespaceConnection(
    principalId: string,
    namespaceId: string,
    sourceId: string,
    audit?: AuditEvent,
  ): Promise<void> {
    await deps.transact(async (state) => {
      await lockNamespace(state, namespaceId);
      const connection = await state.savedConnections.findSavedConnection(namespaceId, sourceId);
      if (connection?.ownerPrincipalId !== principalId) {
        await deps.authorize(principalId, "delete", {
          kind: "credential_source",
          namespaceId,
          id: sourceId,
        });
      }
      if (!connection) {
        throw new ScopeViolationError("The Namespace has no such connection.");
      }
      if (connection.revocationRequestedBy !== undefined) {
        return;
      }
      const source = await state.credentialSources.lockCredentialSource(namespaceId, sourceId);
      if (!source) {
        throw new ScopeViolationError("The connected source no longer exists.");
      }
      if (
        source.state !== "deleting" &&
        !(await state.credentialSources.markCredentialSourceDeleting(namespaceId, sourceId))
      ) {
        throw new ResourceStateConflictError("The connected source changed during revocation.");
      }
      await state.savedConnections.requestConnectionRevocation(namespaceId, sourceId, principalId);
      if (audit) {
        await state.audit.append(audit);
      }
    });
    await deps.finishConnectionRevocation(namespaceId, sourceId);
  }

  async function finishConnectionRevocation(namespaceId: string, sourceId: string): Promise<void> {
    const pending = await deps.read(async (state) => {
      const account = await state.savedConnections.findSavedConnection(namespaceId, sourceId);
      if (account?.revocationRequestedBy === undefined) {
        return undefined;
      }
      const source = await state.credentialSources.findCredentialSource(namespaceId, sourceId);
      if (source?.state !== "deleting") {
        throw new ResourceStateConflictError("The connected source has no pending retirement.");
      }
      return { account, source, namespace: await exactNamespace(state, namespaceId) };
    });
    if (!pending) {
      return;
    }
    if (pending.account.revokedAt === undefined) {
      await deps.retireCredentialSourceMaterial(pending.namespace, pending.source);
    }
    await deps.transact(async (state) => {
      await lockNamespace(state, namespaceId);
      const account = await state.savedConnections.findSavedConnection(namespaceId, sourceId);
      if (account?.revocationRequestedBy === undefined) {
        return;
      }
      if (!account.revokedAt) {
        await state.savedConnections.confirmConnectionRevocation(
          namespaceId,
          sourceId,
          deps.timestamp(),
        );
      }
      if (await state.credentialSources.hasReferences(namespaceId, sourceId)) {
        return;
      }
      await state.credentialSources.deleteCredentialSource(namespaceId, sourceId);
    });
  }

  async function resolveConnectionClient(
    { namespaceId, sourceId }: OAuthAccountRef,
    approval?: OAuthRefreshTokenRegistration["approval"],
  ): Promise<OAuthConnectionClient> {
    return deps.read(async (view) => {
      let pinned = approval;
      if (pinned) {
        // Only the pending source that started consent can receive this grant. Another valid
        // template can select the same OAuth client but authorize a different resource.
        const source = await view.credentialSources.findCredentialSource(namespaceId, sourceId);
        if (
          source?.ownerCapability !== "token_service" ||
          source.state !== "registering" ||
          source.config.connection_template_id !== pinned.connectionTemplateId ||
          source.config.connection_template_version !== String(pinned.connectionTemplateVersion) ||
          source.config.oauth_client_id !== pinned.oauthClientId
        ) {
          throw new BrowserAuthorizationError("client_registration_mismatch", "fix_configuration");
        }
      } else {
        const saved = await view.savedConnections.findSavedConnection(namespaceId, sourceId);
        if (!saved || saved.revocationRequestedBy) {
          throw new BrowserAuthorizationError("client_unavailable", "fix_configuration");
        }
        pinned = saved;
      }
      const version = await view.connectionTemplates.findOAuthConnectionTemplateVersion(
        pinned.connectionTemplateId,
        pinned.connectionTemplateVersion,
      );
      if (!version || version.oauthClientId !== pinned.oauthClientId) {
        throw new BrowserAuthorizationError("client_unavailable", "fix_configuration");
      }
      const client = await connectionClientForVersion(view, namespaceId, version);
      return {
        registration: {
          oauthClientId: client.id,
          issuer: client.issuer,
          clientId: client.clientId,
          tokenUrl: client.tokenUrl,
          tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
          ...(version.mcp && { resource: version.mcp.resource }),
        },
        ...(client.tokenEndpointAuthMethod !== "none" && {
          readSecret: (signal: AbortSignal) =>
            deps.withOAuthClientSecret(client, async (value) => {
              signal.throwIfAborted();
              if (value === undefined) {
                throw new BrowserAuthorizationError("client_unavailable", "fix_configuration");
              }
              return value;
            }),
        }),
      };
    });
  }

  function maintainConnectionToken(namespaceId: string, sourceId: string) {
    return deps
      .connectionTokenIssuer()
      .maintain(
        { kind: "oauth_refresh_token", namespaceId, sourceId },
        AbortSignal.timeout(CONNECTION_OPERATION_TIMEOUT_MS),
      );
  }

  async function authorizeConnectionCreation(
    principalId: string,
    namespaceId: string,
  ): Promise<void> {
    await deps.authorize(principalId, "create", {
      kind: "credential_source",
      id: namespaceId,
      namespaceId,
    });
  }

  async function assertConnectionTemplateScope(
    templateId: string,
    namespaceId: string,
  ): Promise<void> {
    const template = await deps.read((view) =>
      view.connectionTemplates.findConnectionTemplate(templateId),
    );
    if (!template || (template.namespaceId !== undefined && template.namespaceId !== namespaceId)) {
      throw new ScopeViolationError("The connection template is unavailable in this Namespace.");
    }
  }

  async function connectionClientForVersion(
    view: PlatformReadView,
    namespaceId: string,
    version: OAuthConnectionTemplateVersion,
  ) {
    const client = version.oauthClientId
      ? await view.connectionTemplates.findOAuthClient(version.oauthClientId)
      : undefined;
    if (
      !client ||
      (client.namespaceId !== undefined && client.namespaceId !== namespaceId) ||
      client.issuer !== version.issuer ||
      client.tokenUrl !== version.tokenUrl ||
      (version.revocationUrl !== undefined && client.revocationUrl !== version.revocationUrl)
    ) {
      throw new BrowserAuthorizationError("client_unavailable", "fix_configuration");
    }
    return client;
  }

  async function effectiveConnectionDestinations(
    state: PlatformReadView,
    account: Readonly<SavedConnection>,
  ): Promise<SavedConnection["destinations"]> {
    const template = await state.connectionTemplates.findConnectionTemplate(
      account.connectionTemplateId,
    );
    if (
      !template ||
      template.current.mode === "static_bearer" ||
      template.current.issuer !== account.issuer
    ) {
      return [];
    }
    if (template.current.mode === "manual") {
      return account.mcpServerUrl === undefined && account.resource === undefined
        ? template.current.destinations
        : [];
    }
    if (
      !account.mcpServerUrl ||
      !account.resource ||
      template.current.mcp?.serverUrl !== account.mcpServerUrl ||
      template.current.mcp?.resource !== account.resource
    ) {
      return [];
    }
    return account.destinations;
  }

  async function grantConnectionOwner(
    state: PlatformUnitOfWork,
    namespaceId: string,
    principalId: string,
    sourceId: string,
  ): Promise<void> {
    const driver = deps.iamPolicyDriver("createNamespaceAccessBinding");
    if (driver.namespacePolicyTransaction !== "platform-unit-of-work") {
      throw new DependencyUnavailableError(
        "The IAM Driver cannot grant connection access transactionally.",
      );
    }
    const roleId = `role_${namespaceId}_connection_owner`;
    const permissions: readonly Permission[] = [
      { resourceKind: "credential_source", action: "read" },
      { resourceKind: "credential_source", action: "operate" },
    ];
    const role = await state.iamPolicy.getRole(namespaceId, roleId);
    if (role === undefined) {
      const roleDriver = deps.iamPolicyDriver("createNamespaceRole");
      await deps.iamPolicyOperation(() =>
        roleDriver.createNamespaceRole!(
          { policy: state.iamPolicy },
          { id: roleId, namespaceId, name: "Connected account owner", permissions },
        ),
      );
    } else if (
      role.namespaceId !== namespaceId ||
      role.permissions.length !== permissions.length ||
      !permissions.every((required) =>
        role.permissions.some((existing) => isDeepStrictEqual(existing, required)),
      )
    ) {
      throw new ResourceConflictError(
        "The connected account owner Role requires exactly credential source read and operate.",
      );
    }
    await deps.iamPolicyOperation(() =>
      driver.createNamespaceAccessBinding!(
        { policy: state.iamPolicy },
        {
          id: `binding_${sourceId}_connection_owner`,
          namespaceId,
          subjectKind: "identity",
          subjectId: principalId,
          roleId,
          resourceKind: "credential_source",
          resourceId: sourceId,
        },
      ),
    );
  }

  async function acceptConnectionTokens(
    registration: OAuthRefreshTokenRegistration,
    signal: AbortSignal,
    holdSession?: (unit: PlatformUnitOfWork) => Promise<void>,
  ) {
    const issuer = deps.connectionTokenIssuer();
    if (holdSession) {
      await deps.transact(holdSession);
    }
    const reference = await deps.tokenService().register(registration, signal);
    const { schedule } = await issuer.status(reference, signal);
    if (!schedule) {
      throw new ResourceStateConflictError(
        "No eligible access token is prepared for this account.",
      );
    }
    return schedule;
  }

  function assertConnectionTokenCustody(): void {
    deps.connectionTokenIssuer();
    const secrets = deps.secretDriver();
    if (!secrets.withValue || !secrets.compareAndSwap) {
      throw new NotImplementedError(
        "connection_templates",
        "The selected Secret Driver cannot store an OAuth grant.",
      );
    }
  }

  return {
    listUsableConnectionTemplates,
    startNamespaceConnection,
    expireAuthenticationStates,
    completeNamespaceConnection,
    listNamespaceConnections,
    disconnectNamespaceConnection,
    finishConnectionRevocation,
    resolveConnectionClient,
    maintainConnectionToken,
  };
}
