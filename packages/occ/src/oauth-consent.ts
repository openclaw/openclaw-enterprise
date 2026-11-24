import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { iamPolicyOperation } from "./iam-policy-operations.ts";
import {
  ConnectionTemplateValidationError,
  isOAuthScopeToken,
  type AuditEvent,
  type ConnectionTemplate,
  type IAMDriver,
  type OAuthAccountRef,
  type OAuthClient,
  type OAuthConnectionClient,
  type OAuthConnectionTemplateVersion,
  type OAuthCredentialSource,
  type Permission,
  type TokenServiceDriver,
} from "@openclaw-enterprise/contracts";
import { isNonEmptyString } from "@openclaw-enterprise/utils";
import { exchangeAuthorizationCode, startBrowserAuthorization } from "./browser-authorization.ts";
import {
  BrowserAuthorizationError,
  DependencyUnavailableError,
  NamespaceNotReadyError,
  ResourceConflictError,
  ResourceStateConflictError,
  ScopeViolationError,
} from "./errors.ts";
import type { StoredCredentialClient } from "./ports/oauth-client.ts";
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
  readonly oauthClientId: string;
  readonly redirectUri: string;
}
export interface CompleteNamespaceConnectionInput {
  readonly sessionId: string;
  readonly iss?: string;
  readonly state: string;
  readonly code?: string;
  readonly error?: string;
}
export const CONNECTION_OPERATION_TIMEOUT_MS = 30_000;
const CONNECTION_SESSION_TTL_MS = 10 * 60 * 1000;
const connectionOwnerPermissions: readonly Permission[] = [
  { resourceKind: "credential_source", action: "read" },
  { resourceKind: "credential_source", action: "operate" },
];
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

interface OAuthConsentDependencies
  extends
    Pick<ControllerAuthority, "authorize">,
    Pick<ControllerTransactions, "read" | "transact"> {
  readonly iamPolicyDriver: (
    method: "createNamespaceAccessBinding" | "createNamespaceRole",
  ) => IAMDriver;
  readonly selectedTokenServiceDriver: () => TokenServiceDriver;
  readonly currentTokenServiceInstanceId: () => string;
  readonly withOAuthClientSecret: <T>(
    client: Readonly<OAuthClient>,
    use: (value: string | undefined) => Promise<T>,
  ) => Promise<T>;
  readonly timestamp: () => string;
}
export function createOAuthConsent(deps: OAuthConsentDependencies) {
  const authorizeCreate = (principalId: string, namespaceId: string) =>
    deps.authorize(principalId, "create", {
      kind: "credential_source",
      id: namespaceId,
      namespaceId,
    });
  async function listUsableConnectionTemplates(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<ConnectionTemplate>[]> {
    await authorizeCreate(principalId, namespaceId);
    return deps.read(async (state) => {
      await exactNamespace(state, namespaceId);
      const templates = await state.connectionTemplates.listConnectionTemplates();
      return templates.filter(
        (template) => template.namespaceId === undefined || template.namespaceId === namespaceId,
      );
    });
  }
  async function listEligibleOAuthClients(
    principalId: string,
    namespaceId: string,
    connectionTemplateId: string,
  ): Promise<readonly Readonly<OAuthClient>[]> {
    await authorizeCreate(principalId, namespaceId);
    return deps.read(async (state) => {
      await exactNamespace(state, namespaceId);
      const template = await state.connectionTemplates.findConnectionTemplate(connectionTemplateId);
      if (
        !template ||
        (template.namespaceId !== undefined && template.namespaceId !== namespaceId)
      ) {
        throw new ScopeViolationError("The connection template does not exist.");
      }
      if (template.current.mode === "static_bearer") {
        throw new ResourceStateConflictError("A static template cannot use an OAuth client.");
      }
      const version = template.current;
      const owner = deps.selectedTokenServiceDriver();
      const instanceId = deps.currentTokenServiceInstanceId();
      return (await state.connectionTemplates.listCredentialClients())
        .filter(
          (client): client is Extract<typeof client, { kind: "oauth2" }> =>
            client.kind === "oauth2" &&
            eligibleClient(client, namespaceId, version, owner, instanceId),
        )
        .map(({ tokenServiceInstanceId: _owner, ...metadata }) => metadata);
    });
  }
  async function startNamespaceConnection(
    principalId: string,
    input: StartNamespaceConnectionInput,
    audit?: () => AuditEvent,
  ) {
    await authorizeCreate(principalId, input.namespaceId);
    deps.selectedTokenServiceDriver();
    return deps.transact(async (state) => {
      const namespace = await lockNamespace(state, input.namespaceId);
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      const template = await state.connectionTemplates.lockConnectionTemplate(
        input.connectionTemplateId,
      );
      if (
        !template ||
        (template.namespaceId !== undefined && template.namespaceId !== input.namespaceId)
      ) {
        throw new ScopeViolationError("The connection template does not exist.");
      }
      const version = template.current;
      if (version.mode === "static_bearer") {
        throw new ResourceStateConflictError("A static template cannot start OAuth consent.");
      }
      const selectedScopes = connectionConsentScopes(version, input.selectedScopes);
      const client = await connectionClientForVersion(
        state,
        input.namespaceId,
        version,
        input.oauthClientId,
      );
      await connectionOwnerPolicy(state, input.namespaceId);
      const started = startBrowserAuthorization(
        browserAuthorizationRequest(version, client, input.redirectUri, selectedScopes),
      );
      const createdAt = deps.timestamp();
      const expiresAt = new Date(Date.parse(createdAt) + CONNECTION_SESSION_TTL_MS).toISOString();
      await state.authenticationStates.create({
        kind: "oauth_connection",
        id: createHash("sha256").update(started.state).digest("hex"),
        namespaceId: input.namespaceId,
        sessionId: input.sessionId,
        redirectUri: input.redirectUri,
        selectedScopes,
        pkceVerifier: started.pkceVerifier,
        issuerRequired: await state.connectionTemplates.hasOtherConnectionIssuer(version.issuer),
        actorId: principalId,
        connectionTemplateId: template.id,
        connectionTemplateVersion: version.version,
        oauthClientId: client.id,
        createdAt,
        expiresAt,
      });
      if (audit) {
        await state.audit.append(audit());
      }
      return { authorizationUrl: started.authorizationUrl, expiresAt };
    });
  }
  async function expireAuthenticationStates(limit: number): Promise<void> {
    await deps.transact((state) => state.authenticationStates.expire(deps.timestamp(), limit));
  }
  async function completeNamespaceConnection(
    principalId: string,
    input: CompleteNamespaceConnectionInput,
    audit?: (source: Readonly<OAuthCredentialSource>) => AuditEvent,
    holdSession?: (unit: PlatformUnitOfWork) => Promise<void>,
  ): Promise<Readonly<OAuthCredentialSource>> {
    if (!isNonEmptyString(input.state)) {
      throw new BrowserAuthorizationError("missing_state", "retry");
    }
    const session = await deps.transact((state) =>
      state.authenticationStates.consumeOAuth(
        createHash("sha256").update(input.state).digest("hex"),
        principalId,
        input.sessionId,
        deps.timestamp(),
      ),
    );
    if (!session) {
      throw new BrowserAuthorizationError("unknown_session", "retry");
    }
    try {
      await authorizeCreate(principalId, session.namespaceId);
      const { version, client } = await deps.transact(async (state) => {
        await holdSession?.(state);
        const namespace = await lockNamespace(state, session.namespaceId);
        if (namespace.status !== "ready") {
          throw new NamespaceNotReadyError();
        }
        const template = await state.connectionTemplates.findConnectionTemplate(
          session.connectionTemplateId,
        );
        if (
          !template ||
          (template.namespaceId !== undefined && template.namespaceId !== session.namespaceId)
        ) {
          throw new ScopeViolationError(
            "The connection template is unavailable in this Namespace.",
          );
        }
        const version = await state.connectionTemplates.findOAuthConnectionTemplateVersion(
          session.connectionTemplateId,
          session.connectionTemplateVersion,
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
        if (
          input.iss === undefined &&
          (session.issuerRequired ||
            (await state.connectionTemplates.hasOtherConnectionIssuer(version.issuer)))
        ) {
          throw new BrowserAuthorizationError("issuer_required", "fix_configuration");
        }
        await connectionOwnerPolicy(state, session.namespaceId);
        return {
          version,
          client: await connectionClientForVersion(
            state,
            session.namespaceId,
            version,
            session.oauthClientId,
          ),
        };
      });
      const owner = deps.selectedTokenServiceDriver();
      const tokenServiceInstanceId = deps.currentTokenServiceInstanceId();
      const signal = AbortSignal.timeout(CONNECTION_OPERATION_TIMEOUT_MS);
      const grant = await deps.withOAuthClientSecret(client, (secret) =>
        exchangeAuthorizationCode(
          browserAuthorizationRequest(version, client, session.redirectUri, session.selectedScopes),
          session.pkceVerifier,
          input.code!,
          secret,
          signal,
        ),
      );
      const source = await owner.createSource(
        {
          kind: "oauth_refresh_token",
          namespaceId: session.namespaceId,
          name: `Connection ${randomUUID()}`,
          connectionTemplateId: session.connectionTemplateId,
          consent: {
            kind: "connection_template",
            version: session.connectionTemplateVersion,
            oauthClientId: client.id,
            ownerPrincipalId: principalId,
          },
          grant,
        },
        signal,
      );
      if (
        source.type !== "oauth2-refresh-token" ||
        source.state !== "ready" ||
        source.ownerCapability !== "token_service" ||
        source.tokenServiceInstanceId !== tokenServiceInstanceId ||
        source.namespaceId !== session.namespaceId ||
        source.consent.kind !== "connection_template" ||
        source.connectionTemplateId !== session.connectionTemplateId ||
        source.consent.version !== session.connectionTemplateVersion ||
        source.consent.oauthClientId !== client.id ||
        source.consent.ownerPrincipalId !== principalId ||
        !isDeepStrictEqual(source.consent.requestedScopes, session.selectedScopes) ||
        !isDeepStrictEqual(source.consent.grantedScopes, grant.grantedScopes)
      ) {
        throw new ResourceStateConflictError("TokenService returned an invalid OAuth Source.");
      }
      await deps.transact(async (state) => {
        await grantConnectionOwner(state, source.namespaceId, principalId, source.id);
        if (audit) {
          await state.audit.append(audit(source));
        }
      });
      return source;
    } finally {
      await deps.transact((state) => state.authenticationStates.releaseOAuth(session.id));
    }
  }
  async function resolveConnectionClient(
    ref: OAuthAccountRef,
    registrationSource?: Readonly<OAuthCredentialSource>,
  ): Promise<OAuthConnectionClient> {
    return deps.read(async (view) => {
      const source =
        registrationSource ??
        (await view.credentialSources.findCredentialSource(ref.namespaceId, ref.sourceId));
      if (
        source?.ownerCapability !== "token_service" ||
        source.type !== "oauth2-refresh-token" ||
        source.id !== ref.sourceId ||
        source.namespaceId !== ref.namespaceId ||
        source.consent.revocationRequestedBy !== undefined ||
        source.consent.kind !== "connection_template"
      ) {
        throw new BrowserAuthorizationError("client_unavailable", "fix_configuration");
      }
      if (source.connectionTemplateId === undefined) {
        throw new BrowserAuthorizationError("client_unavailable", "fix_configuration");
      }
      const version = await view.connectionTemplates.findOAuthConnectionTemplateVersion(
        source.connectionTemplateId,
        source.consent.version,
      );
      if (!version) {
        throw new BrowserAuthorizationError("client_unavailable", "fix_configuration");
      }
      const client = await connectionClientForVersion(
        view,
        ref.namespaceId,
        version,
        source.consent.oauthClientId,
      );
      return {
        registration: {
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
  function eligibleClient(
    client: Extract<StoredCredentialClient, { kind: "oauth2" }>,
    namespaceId: string,
    version: OAuthConnectionTemplateVersion,
    owner: TokenServiceDriver,
    instanceId: string,
  ): boolean {
    const scope = client.namespaceId === undefined ? "installation" : "namespace";
    return (
      (client.namespaceId === undefined || client.namespaceId === namespaceId) &&
      owner.clientScopes.oauth2?.includes(scope) === true &&
      (client.tokenEndpointAuthMethod === "none" || client.tokenServiceInstanceId === instanceId) &&
      client.issuer === version.issuer &&
      client.tokenUrl === version.tokenUrl &&
      (version.revocationUrl === undefined || client.revocationUrl === version.revocationUrl) &&
      (version.observed === undefined ||
        (version.observed.tokenEndpointAuthMethods ?? ["client_secret_basic"]).includes(
          client.tokenEndpointAuthMethod,
        ))
    );
  }

  async function connectionClientForVersion(
    view: PlatformReadView,
    namespaceId: string,
    version: OAuthConnectionTemplateVersion,
    clientId: string,
  ): Promise<Readonly<OAuthClient>> {
    const client = await view.connectionTemplates.findCredentialClient(clientId);
    if (
      !client ||
      client.kind !== "oauth2" ||
      !eligibleClient(
        client,
        namespaceId,
        version,
        deps.selectedTokenServiceDriver(),
        deps.currentTokenServiceInstanceId(),
      )
    ) {
      throw new BrowserAuthorizationError("client_unavailable", "fix_configuration");
    }
    const { tokenServiceInstanceId: _owner, ...metadata } = client;
    return metadata;
  }

  async function connectionOwnerPolicy(
    state: Pick<PlatformReadView, "iamPolicy">,
    namespaceId: string,
  ) {
    const bindingDriver = deps.iamPolicyDriver("createNamespaceAccessBinding");
    if (bindingDriver.namespacePolicyTransaction !== "platform-unit-of-work") {
      throw new DependencyUnavailableError(
        "The IAM Driver cannot grant connection access transactionally.",
      );
    }
    const roleId = `role_${namespaceId}_connection_owner`;
    const role = await state.iamPolicy.getRole(namespaceId, roleId);
    if (
      role !== undefined &&
      (role.namespaceId !== namespaceId ||
        role.permissions.length !== connectionOwnerPermissions.length ||
        !connectionOwnerPermissions.every((required) =>
          role.permissions.some((existing) => isDeepStrictEqual(existing, required)),
        ))
    ) {
      throw new ResourceConflictError(
        "The connected account owner Role requires exactly credential source read and operate.",
      );
    }
    const roleDriver = role === undefined ? deps.iamPolicyDriver("createNamespaceRole") : undefined;
    return { bindingDriver, roleDriver, roleId };
  }

  async function grantConnectionOwner(
    state: PlatformUnitOfWork,
    namespaceId: string,
    principalId: string,
    sourceId: string,
  ): Promise<void> {
    const { bindingDriver, roleDriver, roleId } = await connectionOwnerPolicy(state, namespaceId);
    if (roleDriver !== undefined) {
      await iamPolicyOperation(() =>
        roleDriver.createNamespaceRole!(
          { policy: state.iamPolicy },
          {
            id: roleId,
            namespaceId,
            name: "Connected account owner",
            permissions: connectionOwnerPermissions,
          },
        ),
      );
    }
    await iamPolicyOperation(() =>
      bindingDriver.createNamespaceAccessBinding!(
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

  return {
    listUsableConnectionTemplates,
    listEligibleOAuthClients,
    startNamespaceConnection,
    expireAuthenticationStates,
    completeNamespaceConnection,
    resolveConnectionClient,
  };
}
