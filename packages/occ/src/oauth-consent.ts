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
import type { PlatformReadView } from "./ports/platform-read-view.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";
import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import { lockNamespace } from "./resource-scope.ts";

export interface StartNamespaceConnectionInput {
  readonly selectedScopes?: readonly string[];
  readonly sessionId: string;
  readonly namespaceId: string;
  readonly connectionTemplateId: string;
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
export interface OAuthApproval {
  readonly connectionTemplateId: string;
  readonly connectionTemplateVersion: number;
  readonly oauthClientId: string;
}
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
    return deps.read(async (state) =>
      (await state.connectionTemplates.listConnectionTemplates()).filter(
        (t) =>
          (t.current.mode === "static_bearer" || t.current.oauthClientId !== undefined) &&
          (t.namespaceId === undefined || t.namespaceId === namespaceId),
      ),
    );
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
      await authorizeCreate(principalId, input.namespaceId);
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
      const client = await connectionClientForVersion(state, input.namespaceId, version);
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
    await authorizeCreate(principalId, session.namespaceId);
    const { version, client } = await deps.transact(async (state) => {
      await holdSession?.(state);
      const namespace = await lockNamespace(state, session.namespaceId);
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      await authorizeCreate(principalId, session.namespaceId);
      const template = await state.connectionTemplates.findConnectionTemplate(
        session.connectionTemplateId,
      );
      if (
        !template ||
        (template.namespaceId !== undefined && template.namespaceId !== session.namespaceId)
      ) {
        throw new ScopeViolationError("The connection template is unavailable in this Namespace.");
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
      return {
        version,
        client: await connectionClientForVersion(state, session.namespaceId, version),
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
          version: session.connectionTemplateVersion,
          oauthClientId: client.id,
          ownerPrincipalId: principalId,
          requestedScopes: session.selectedScopes,
          grantedScopes: grant.grantedScopes,
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
  }
  async function resolveConnectionClient(
    ref: OAuthAccountRef,
    approval?: OAuthApproval,
  ): Promise<OAuthConnectionClient> {
    return deps.read(async (view) => {
      let pinned = approval;
      if (!pinned) {
        const source = await view.credentialSources.findCredentialSource(
          ref.namespaceId,
          ref.sourceId,
        );
        if (
          source?.ownerCapability !== "token_service" ||
          source.type !== "oauth2-refresh-token" ||
          source.consent.revocationRequestedBy !== undefined
        ) {
          throw new BrowserAuthorizationError("client_unavailable", "fix_configuration");
        }
        pinned = {
          connectionTemplateId: source.connectionTemplateId,
          connectionTemplateVersion: source.consent.version,
          oauthClientId: source.consent.oauthClientId,
        };
      }
      const version = await view.connectionTemplates.findOAuthConnectionTemplateVersion(
        pinned.connectionTemplateId,
        pinned.connectionTemplateVersion,
      );
      if (!version || version.oauthClientId !== pinned.oauthClientId) {
        throw new BrowserAuthorizationError("client_unavailable", "fix_configuration");
      }
      const client = await connectionClientForVersion(view, ref.namespaceId, version);
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
      await iamPolicyOperation(() =>
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
    await iamPolicyOperation(() =>
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

  return {
    listUsableConnectionTemplates,
    startNamespaceConnection,
    expireAuthenticationStates,
    completeNamespaceConnection,
    resolveConnectionClient,
  };
}
