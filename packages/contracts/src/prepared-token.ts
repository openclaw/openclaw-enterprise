import type { Secret } from "./index.ts";
import type { CredentialRefreshStatus } from "./drivers/credential-refresh/index.ts";
import type {
  CredentialReadLifetime,
  CredentialSourceControl,
  EgressRef,
  EgressRoute,
  EgressSourceKey,
} from "./drivers/credential-proxy/index.ts";
import type { GitHubMetadataGrant } from "./prepared-github-egress.ts";

/** Scope normalized by the issuer, always isolated to one dedicated execution's Agent. */
export interface PreparedTokenGrant {
  readonly kind: "prepared_scope";
  readonly isolationId: string;
  readonly scope: Readonly<Record<string, string>>;
}

export interface PreparedTokenSource<
  G extends PreparedTokenGrant | GitHubMetadataGrant = PreparedTokenGrant | GitHubMetadataGrant,
> {
  readonly key: EgressSourceKey;
  readonly sender: EgressRef;
  readonly resolver: EgressRef;
  readonly origin: string;
  readonly schemaVersion: 2 | 4;
  readonly adoption: "prepared";
  readonly retention: "none";
  readonly grant: G;
}

export interface PreparedTokenSelection {
  readonly value: string;
  readonly family: EgressRef;
  readonly ownerEpoch: number;
  readonly inputVersion: string;
  readonly preparationAttemptId: string;
  readonly materialId: string;
  readonly materialVersion: string;
  readonly providerExpiresAt: string;
  readonly usableUntil: string;
}

export interface PreparedTokenEvidence extends Omit<PreparedTokenSelection, "value"> {
  /** Existing GitHub receipts keep their exact meaning. */
  readonly kind: "prepared_token" | "prepared_github";
  readonly source: EgressSourceKey;
  readonly binding: EgressRef;
  readonly grantHash: string;
  readonly isolationId: string;
}

/** Only valid in this use's platform transaction, never a detached freshness observation. */
export interface PreparedTokenCurrentProof {
  current(
    source: PreparedTokenSource,
    evidence: PreparedTokenEvidence,
    issuerAuthority: string,
    lifetime: CredentialReadLifetime,
  ): Promise<boolean>;
}

/** Installed issuer policy and its custody. No management or material method is given to a sender. */
export interface PreparedTokenIssuer {
  readonly provider: EgressRef;
  readonly issuerInput: string;
  readonly issuerAuthority: string;
  admission(
    config: Readonly<Record<string, string>>,
  ): Pick<PreparedTokenSource, "origin" | "grant" | "schemaVersion">;
  sourceFromRoute(
    route: EgressRoute,
    control: Pick<CredentialSourceControl, "sender" | "resolver">,
  ): PreparedTokenSource | undefined;
  configure(
    source: PreparedTokenSource,
    issuer: Readonly<Secret>,
    signal: AbortSignal,
  ): Promise<void>;
  withdraw(source: PreparedTokenSource, signal: AbortSignal): Promise<void>;
  ready(source: PreparedTokenSource, signal: AbortSignal): Promise<boolean>;
  readWarm(
    source: PreparedTokenSource,
    lifetime: CredentialReadLifetime,
  ): Promise<PreparedTokenSelection | undefined>;
}

/** The installation chooses the lifecycle owner independently of the Sandbox and sender. */
export interface PreparedTokenService {
  readonly oauthConnections?: OAuthConnectionTokenService | undefined;
  issuer(provider: EgressRef): PreparedTokenIssuer | undefined;
}

/** The source owner keeps this private Secret reference outside the user-managed Secret inventory. */
export interface OAuthConnectionCustody {
  readonly sourceId: string;
  readonly secret: Readonly<Secret>;
}

/** The client and provider destination pinned when the account was connected. */
export interface OAuthConnectionRegistration {
  readonly issuer: string;
  readonly tokenUrl: string;
  readonly oauthClientId: string;
  readonly tokenEndpointAuthMethod: "none" | "client_secret_post" | "client_secret_basic";
  readonly resource?: string;
  readonly clientId: string;
}

/** Server-owned registration and its private credential reader, resolved for one account. */
export interface OAuthConnectionClient {
  readonly registration: OAuthConnectionRegistration;
  readonly readSecret?: (signal: AbortSignal) => Promise<string>;
}

/** Trusted handoff from code exchange. The Token Service retains the reusable grant. */
export interface OAuthConnectionGrant extends OAuthConnectionRegistration {
  readonly requestedScopes: readonly string[];
  /** Scopes the provider granted. An empty list means no scopes were reported or requested. */
  readonly grantedScopes: readonly string[];
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: string;
}

/** The only credential the trusted delivery path may install, with a deadline for its use. */
export interface OAuthConnectionAccessToken {
  readonly grantedScopes: readonly string[];
  readonly nextRefreshAt: string;
  readonly accessToken: string;
  readonly version: string;
  readonly expiresAt: string;
}

export const PENDING_OAUTH_CONNECTION = "pending";

export type OAuthConnectionStatus = CredentialRefreshStatus & {
  readonly schedule?: {
    readonly version: string;
    readonly nextRefreshAt: string;
    readonly grantedScopes: readonly string[];
  };
};

export interface OAuthConnectionTokenService {
  accept(
    custody: OAuthConnectionCustody,
    grant: OAuthConnectionGrant,
    signal: AbortSignal,
  ): Promise<void>;
  warm(
    custody: OAuthConnectionCustody,
    signal: AbortSignal,
  ): Promise<OAuthConnectionAccessToken | undefined>;
  status(custody: OAuthConnectionCustody, signal: AbortSignal): Promise<OAuthConnectionStatus>;
  /** Renew when due, or early when custody still holds the previously scheduled version. */
  renew(
    custody: OAuthConnectionCustody,
    signal: AbortSignal,
    resolveClient: () => Promise<OAuthConnectionClient>,
    scheduledVersion?: string,
  ): Promise<OAuthConnectionStatus>;
  retire(custody: OAuthConnectionCustody, signal: AbortSignal): Promise<void>;
}
