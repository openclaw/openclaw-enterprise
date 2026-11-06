import type { CredentialRefreshStatus } from "./drivers/credential-refresh/index.ts";
import type { Secret } from "./index.ts";
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

/** A trusted consumer receives the usable access token and its issuer-reported expiry. */
export interface ResolvedToken {
  readonly accessToken: string;
  readonly expiresAt: string;
}

export interface PreparedTokenSelection extends ResolvedToken {
  readonly family: EgressRef;
  readonly ownerEpoch: number;
  readonly inputVersion: string;
  readonly preparationAttemptId: string;
  readonly materialId: string;
  readonly materialVersion: string;
  readonly usableUntil: string;
}

export interface PreparedTokenEvidence extends Omit<PreparedTokenSelection, keyof ResolvedToken> {
  readonly providerExpiresAt: string;
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
  /** Releases outstanding callers when this installed owner shuts down. */
  readonly shutdownSignal?: AbortSignal;
  readonly tokenKind: PreparedTokenKind;
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
  resolve(
    reference: EgressSourceKey,
    options: TokenResolveOptions,
  ): Promise<PreparedTokenSelection | undefined>;
}

/** The proxy supplies its original request deadline and the token lifetime that use requires. */
export interface TokenResolveOptions extends CredentialReadLifetime {
  readonly minimumValidityMs: number;
}

export type PreparedTokenKind = "github_app_installation" | "prepared_source";

export interface PreparedTokenRegistration {
  readonly kind: PreparedTokenKind;
  readonly source: PreparedTokenSource;
  readonly secret: Readonly<Secret>;
}

/** The installed provider generation and admitted grant remain bound to this handle across renewal. */
export interface PreparedTokenRef {
  readonly kind: PreparedTokenKind;
  readonly key: EgressSourceKey;
}

/** Registration binds an immutable grant to its issuer secret. Its reference survives renewal. */
export interface TokenService {
  register(
    registration: OAuthRefreshTokenRegistration,
    signal: AbortSignal,
  ): Promise<OAuthAccountRef>;
  register(registration: PreparedTokenRegistration, signal: AbortSignal): Promise<PreparedTokenRef>;
  resolve(
    reference: OAuthAccountRef,
    options: TokenResolveOptions,
  ): Promise<OAuthConnectionAccessToken | undefined>;
  resolve(
    reference: PreparedTokenRef,
    options: TokenResolveOptions,
  ): Promise<PreparedTokenSelection | undefined>;
  resolve(
    reference: PreparedTokenRef | OAuthAccountRef,
    options: TokenResolveOptions,
  ): Promise<ResolvedToken | undefined>;
  issuer(
    kind: OAuthAccountRef["kind"],
  ): Pick<OAuthRefreshTokenIssuer, "status" | "maintain" | "retire"> | undefined;
  issuer(provider: EgressRef): Omit<PreparedTokenIssuer, "configure" | "resolve"> | undefined;
}

/** Stable reference to a saved account. Its private grant can rotate between resolutions. */
export interface OAuthAccountRef {
  readonly kind: "oauth_refresh_token";
  readonly namespaceId: string;
  readonly sourceId: string;
}

/** OCC supplies the template version and the client registration the person approved at consent. */
export interface OAuthRefreshTokenRegistration extends OAuthAccountRef {
  readonly approval: {
    readonly connectionTemplateId: string;
    readonly connectionTemplateVersion: number;
    readonly oauthClientId: string;
  };
  readonly grant: OAuthConnectionGrant;
}

/** The installed owner of saved OAuth grants. OCC and the worker use its lifecycle operations. */
export interface OAuthRefreshTokenIssuer {
  readonly tokenKind: OAuthAccountRef["kind"];
  register(
    registration: OAuthRefreshTokenRegistration,
    signal: AbortSignal,
  ): Promise<OAuthAccountRef>;
  resolve(
    ref: OAuthAccountRef,
    options: TokenResolveOptions,
  ): Promise<OAuthConnectionAccessToken | undefined>;
  status(ref: OAuthAccountRef, signal: AbortSignal): Promise<OAuthConnectionStatus>;
  maintain(ref: OAuthAccountRef, signal: AbortSignal): Promise<OAuthConnectionStatus | undefined>;
  retire(ref: OAuthAccountRef, signal: AbortSignal): Promise<void>;
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
export interface OAuthConnectionGrant extends ResolvedToken {
  readonly requestedScopes: readonly string[];
  /** Scopes the provider granted. An empty list means no scopes were reported or requested. */
  readonly grantedScopes: readonly string[];
  readonly refreshToken: string;
}

/** The only credential the trusted delivery path may install, with a deadline for its use. */
export interface OAuthConnectionAccessToken extends ResolvedToken {
  readonly grantedScopes: readonly string[];
  readonly nextRefreshAt: string;
  readonly version: string;
}

export type OAuthConnectionStatus = CredentialRefreshStatus & {
  readonly schedule?: {
    readonly version: string;
    readonly nextRefreshAt: string;
    readonly grantedScopes: readonly string[];
  };
};
