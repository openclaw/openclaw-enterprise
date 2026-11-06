/** RFC 6749 section 3.3 scope-token grammar shared by the API and token exchange. */
export const oauthScopeTokenPattern = /^[\x21\x23-\x5b\x5d-\x7e]+$/u;
export function isOAuthScopeToken(value: unknown): value is string {
  return typeof value === "string" && value.length <= 512 && oauthScopeTokenPattern.test(value);
}

/** Where a connected credential may be sent; the Credential Gateway releases it nowhere else. */
export interface ConnectionEndpoint {
  readonly host: string;
  readonly port: number;
  readonly path: string;
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
  /** An empty list leaves scope selection to the account owner and provider. */
  readonly scopes: readonly string[];
  readonly authorizationParameters: Readonly<Record<string, string>>;
  readonly destinations: readonly ConnectionEndpoint[];
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

/** Validate immutable OAuth settings before OCC registers a client. */
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

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left === right ? 0 : 1;
}

function compareEndpoint(left: ConnectionEndpoint, right: ConnectionEndpoint): number {
  return (
    compareText(left.host, right.host) ||
    left.port - right.port ||
    compareText(left.path, right.path)
  );
}

/** Save exact HTTPS routes in a stable order regardless of editor row order or omitted defaults. */
export function normalizeConnectionDestinations(
  rows: readonly { readonly host: string; readonly port?: number; readonly path?: string }[],
): ConnectionEndpoint[] {
  if (!rows.length) {
    throw new ConnectionTemplateValidationError(
      "destinations",
      "Choose at least one HTTPS destination.",
    );
  }
  const destinations = rows
    .map(({ host, port = 443, path = "/**" }) => {
      host = host.toLowerCase();
      if (
        host.length > 253 ||
        !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
          host,
        ) ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535 ||
        path.length > 512 ||
        !/^\/[!-~]*$/.test(path) ||
        /[?#\\]/.test(path)
      ) {
        throw new ConnectionTemplateValidationError(
          "destinations",
          "Choose a DNS host, HTTPS port and request path for each destination.",
        );
      }
      return { host, port, path };
    })
    .sort(compareEndpoint);
  return destinations.filter(
    (row, index) => index === 0 || compareEndpoint(row, destinations[index - 1]!) !== 0,
  );
}

/** The in-memory repository mirrors the persisted version's nonempty, canonical destination set. */
export function validateConnectionTemplateDestinations(values: ConnectionTemplateValues): void {
  const canonical = normalizeConnectionDestinations(values.destinations);
  if (
    !sameDestinations(values.destinations, canonical) ||
    (values.mode === "mcp_discovery" && canonical.length !== 1)
  ) {
    throw new ConnectionTemplateValidationError(
      "destinations",
      "The saved destinations must be canonical. An MCP template requires exactly one server destination.",
    );
  }
}

function sameDestinations(
  left: readonly ConnectionEndpoint[],
  right: readonly ConnectionEndpoint[],
): boolean {
  return (
    left.length === right.length &&
    left.every((row, index) => compareEndpoint(row, right[index]!) === 0)
  );
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
    !sameDestinations(current.destinations, next.destinations) ||
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
  readonly destinations: ConnectionTemplateValues["destinations"];
  readonly resource?: string;
  readonly requestedScopes: readonly string[];
  readonly grantedScopes: readonly string[];
  readonly connectionTemplateId: string;
  readonly connectionTemplateVersion: number;
  readonly createdAt: string;
}

/** A pending browser authorization, found by the SHA-256 of its `state` and consumed once. */
export interface ConnectionSession {
  readonly stateHash: string;
  readonly namespaceId: string;
  readonly credentialSourceId: string;
  /** Server-private PKCE state, erased when the callback consumes the attempt. */
  readonly pkceVerifier: string;
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
