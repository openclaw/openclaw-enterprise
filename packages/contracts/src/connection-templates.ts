/** Where a connected credential may be sent; the Credential Gateway releases it nowhere else. */
export interface ConnectionEndpoint {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly access: "read-only" | "full";
}

export type OAuthClientAuthMethod = "none" | "client_secret_basic" | "client_secret_post";

/** A client may send its credentials only to its explicitly approved provider endpoints. */
export interface OAuthClient {
  readonly id: string;
  readonly namespaceId?: string;
  readonly displayName: string;
  readonly issuer: string;
  readonly tokenUrl: string;
  readonly revocationUrl?: string;
  readonly clientId: string;
  readonly tokenEndpointAuthMethod: OAuthClientAuthMethod;
  /** Installation Driver that owns this client registration and its private material. */
  readonly credentialRefreshDriverId: string;
  readonly createdAt: string;
}

/** Public metadata observed during MCP discovery. The administrator approves a subset. */
export interface McpAuthorizationMetadata {
  readonly serverUrl: string;
  readonly resource: string;
  readonly issuers: readonly string[];
  readonly resourceScopes?: readonly string[];
  readonly requestedScopes: readonly string[];
  readonly issuer?: string;
  readonly authorizationUrl?: string;
  readonly tokenUrl?: string;
  readonly revocationUrl?: string;
  readonly registrationUrl?: string;
  readonly supportedScopes?: readonly string[];
  readonly tokenEndpointAuthMethods?: readonly string[];
}

export interface ConnectionTemplateValues {
  readonly mode: "manual" | "mcp_discovery";
  readonly issuer: string;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly revocationUrl?: string;
  readonly oauthClientId?: string;
  readonly scopes: readonly string[];
  readonly authorizationParameters: Readonly<Record<string, string>>;
  readonly recipient: Readonly<ConnectionEndpoint>;
  readonly mcp?: { readonly serverUrl: string; readonly resource: string };
  readonly observed?: McpAuthorizationMetadata;
}

export interface OAuthConnectionTemplateVersion extends ConnectionTemplateValues {
  readonly templateId: string;
  readonly version: number;
  readonly createdAt: string;
}

export interface ConnectionTemplate {
  readonly id: string;
  readonly namespaceId?: string;
  readonly displayName: string;
  readonly current: Readonly<OAuthConnectionTemplateVersion>;
  readonly createdAt: string;
}

const flowParameters = new Set([
  "resource",
  "client_secret",
  "response_type",
  "client_id",
  "redirect_uri",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
]);

export function isFlowOwnedOAuthParameter(name: string): boolean {
  return flowParameters.has(name);
}

export class ConnectionTemplateValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.field = field;
    this.name = "ConnectionTemplateValidationError";
  }
}

/** Validate immutable OAuth settings before the Refresh Driver stages a client secret. */
export function validateConnectionTemplateAuthorization(
  values: Pick<
    ConnectionTemplateValues,
    "issuer" | "authorizationUrl" | "tokenUrl" | "revocationUrl" | "authorizationParameters"
  >,
): void {
  for (const field of ["issuer", "authorizationUrl", "tokenUrl", "revocationUrl"] as const) {
    const value = values[field];
    if (value === undefined) {
      continue;
    }
    if (
      !/^https:\/\/[^/?#@\s\\]+(?:[/?][^#\s\\]*)?$/.test(value) ||
      !URL.canParse(value) ||
      (field === "issuer" && value.includes("?"))
    ) {
      throw new ConnectionTemplateValidationError(
        field,
        `${field} must be a valid HTTPS URL without userinfo or a fragment${field === "issuer" ? " or query." : "."}`,
      );
    }
  }
  if ([...new URL(values.authorizationUrl).searchParams.keys()].some(isFlowOwnedOAuthParameter)) {
    throw new ConnectionTemplateValidationError(
      "authorizationUrl",
      "The authorization URL contains a parameter that the OAuth flow supplies.",
    );
  }
  if (Object.keys(values.authorizationParameters).some(isFlowOwnedOAuthParameter)) {
    throw new ConnectionTemplateValidationError(
      "authorizationParameters",
      "The template cannot override a parameter that the OAuth flow supplies.",
    );
  }
}

/** True when `next` changes a value a person approved, so it needs a new version. */
export function connectionValuesChanged(
  current: Readonly<ConnectionTemplateValues>,
  next: Readonly<ConnectionTemplateValues>,
): boolean {
  return (
    current.mode !== next.mode ||
    current.mcp?.serverUrl !== next.mcp?.serverUrl ||
    current.mcp?.resource !== next.mcp?.resource ||
    current.oauthClientId !== next.oauthClientId ||
    current.issuer !== next.issuer ||
    current.authorizationUrl !== next.authorizationUrl ||
    current.tokenUrl !== next.tokenUrl ||
    current.revocationUrl !== next.revocationUrl ||
    current.recipient.host !== next.recipient.host ||
    current.recipient.port !== next.recipient.port ||
    current.recipient.path !== next.recipient.path ||
    current.recipient.access !== next.recipient.access ||
    current.scopes.length !== next.scopes.length ||
    current.scopes.some((scope, index) => scope !== next.scopes[index]) ||
    !sameParameters(current.authorizationParameters, next.authorizationParameters)
  );
}

function sameParameters(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
  );
}

/** One connected credential source: who consented in this Namespace and which template version they approved. */
export interface SavedConnection {
  readonly namespaceId: string;
  readonly credentialSourceId: string;
  /** Revocation survives process restarts until the worker retires the grant. */
  readonly revocationRequestedBy?: string;
  readonly revokedAt?: string;
  readonly ownerPrincipalId: string;
  readonly oauthClientId: string;
  readonly clientId: string;
  readonly issuer: string;
  readonly tokenUrl: string;
  readonly mcpServerUrl?: string;
  readonly recipient: ConnectionTemplateValues["recipient"];
  readonly resource?: string;
  readonly requestedScopes: readonly string[];
  readonly grantedScopes: readonly string[];
  readonly connectionTemplateId: string;
  readonly connectionTemplateVersion: number;
  readonly createdAt: string;
}

/** The saved Agent plugin slot a user chose before leaving for provider consent. */
export interface ConnectionAttachmentIntent {
  readonly agentId: string;
  readonly pluginId: string;
  readonly slotId: string;
  readonly releaseSha256: string;
  readonly expectedCredentialSourceId: string | null;
  readonly connectionTemplateId: string;
  readonly connectionTemplateVersion: number;
}

/** A pending browser authorization, found by the SHA-256 of its `state` and consumed once. */
export interface ConnectionSession {
  readonly attachmentIntent?: ConnectionAttachmentIntent;
  readonly stateHash: string;
  readonly namespaceId: string;
  readonly credentialSourceId: string;
  /** Server-private PKCE state, erased when the callback consumes the attempt. */
  readonly privateState: string;
  readonly selectedScopes: readonly string[];
  readonly issuerRequired: boolean;
  readonly sessionId: string;
  readonly redirectUri: string;
  readonly actorId: string;
  readonly connectionTemplateId: string;
  readonly connectionTemplateVersion: number;
  readonly createdAt: string;
  readonly expiresAt: string;
}
