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
  register(registration: PreparedTokenRegistration, signal: AbortSignal): Promise<PreparedTokenRef>;
  resolve(
    reference: PreparedTokenRef,
    options: TokenResolveOptions,
  ): Promise<PreparedTokenSelection | undefined>;
  issuer(provider: EgressRef): Omit<PreparedTokenIssuer, "configure" | "resolve"> | undefined;
}
