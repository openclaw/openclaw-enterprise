/** Where a connected credential may be sent; the Credential Gateway releases it nowhere else. */
export interface ConnectionEndpoint {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly access: "read-only" | "full";
}

/** The values a person approves when they connect; any change creates a new version. */
export interface ConnectionTemplateValues {
  readonly issuer: string;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly authorizationParameters: Readonly<Record<string, string>>;
  readonly endpoint: Readonly<ConnectionEndpoint>;
  readonly envVar: string;
}

export interface ConnectionTemplateVersion extends ConnectionTemplateValues {
  readonly templateId: string;
  readonly version: number;
  /** The Credential Refresh Driver registration for this `issuer` and `clientId` pair. */
  readonly clientRegistrationId: string;
  readonly createdAt: string;
}

/** An administrator sets the template’s scope at creation. */
export interface ConnectionTemplate {
  readonly id: string;
  /** Omitted for an Installation-wide template. */
  readonly namespaceId?: string;
  readonly displayName: string;
  readonly current: Readonly<ConnectionTemplateVersion>;
  readonly createdAt: string;
}

/**
 * One OAuth client at one authorization server. Its secret belongs to the Credential Refresh
 * Driver named here; OCC stores no secret value.
 */
export interface ConnectionClientRegistration {
  readonly id: string;
  readonly namespaceId?: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly credentialRefreshDriverId: string;
  readonly createdAt: string;
}

/** True when `next` changes a value a person approved, so it needs a new version. */
export function connectionValuesChanged(
  current: Readonly<ConnectionTemplateValues>,
  next: Readonly<ConnectionTemplateValues>,
): boolean {
  return (
    current.issuer !== next.issuer ||
    current.authorizationUrl !== next.authorizationUrl ||
    current.tokenUrl !== next.tokenUrl ||
    current.clientId !== next.clientId ||
    current.envVar !== next.envVar ||
    current.endpoint.host !== next.endpoint.host ||
    current.endpoint.port !== next.endpoint.port ||
    current.endpoint.path !== next.endpoint.path ||
    current.endpoint.access !== next.endpoint.access ||
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
