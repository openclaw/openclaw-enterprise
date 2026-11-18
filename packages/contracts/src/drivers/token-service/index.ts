import type { CredentialSourceReference } from "../../index.ts";
import type { Driver } from "../index.ts";

export type TokenServiceSourceRef = CredentialSourceReference | InstallationClientSecretRef;

/** Only authorized control-plane consumers can use an Installation registration secret. */
export interface InstallationClientSecretRef {
  readonly kind: "oauth_client";
  readonly id: string;
  readonly namespaceId?: never;
}

/** Nonsecret owner output. Native delivery must validate the backend and workspace before attach. */
export type TokenServiceRegistration =
  | { readonly delivery: "push"; readonly backendRef?: Readonly<Record<string, string>> }
  | { readonly delivery: "native"; readonly backendRef: Readonly<Record<string, string>> };

export interface RegisteredTokenServiceSource<
  Ref extends TokenServiceSourceRef = TokenServiceSourceRef,
> {
  readonly sourceRef: Ref;
  readonly driverId: string;
  readonly registration: TokenServiceRegistration;
}

/** Only the selected owner's adapter interprets its reviewed source type and lifecycle fields. */
export interface SourceLifecycleConfig {
  readonly type: string;
  readonly settings: Readonly<Record<string, string>>;
}

type SecretFields = Readonly<Record<string, string>>;

export interface SourceRegistrationInput {
  readonly sourceRef: TokenServiceSourceRef;
  readonly secret: SecretFields;
  readonly lifecycleConfig: SourceLifecycleConfig;
}

export type SourceUpdate =
  | { readonly secret: SecretFields; readonly lifecycleConfig?: SourceLifecycleConfig }
  | { readonly lifecycleConfig: SourceLifecycleConfig; readonly secret?: SecretFields };

export interface UsableCredential {
  readonly credential: string;
  readonly expiresAt?: string;
  /** Trusted account context when the consumer must route an account-scoped request. */
  readonly accountId?: string;
  readonly isFedramp?: boolean;
}

export interface VersionedCredential extends UsableCredential {
  readonly version: string;
}

export interface CredentialRefreshStatus {
  readonly state: "pending" | "ready" | "failed";
  readonly expiresAt?: string;
  readonly nextRefreshAt?: string;
  readonly lastRefreshAt?: string;
  /** Implementation-owned identifier, never provider-controlled text. */
  readonly failureCode?: string;
  readonly recoveryAction?: "retry" | "reauthorize" | "fix_configuration" | "investigate";
}

export interface SourceRefreshOperation {
  readonly sourceRef: CredentialSourceReference;
  readonly driverId: string;
  readonly operationId: string;
}

/** Proposed owner boundary. Installation selection lands with its first implementation. */
export interface TokenServiceDriver extends Omit<Driver, "capability"> {
  readonly capability: "token_service";
  registerSource(
    input: SourceRegistrationInput,
    signal: AbortSignal,
  ): Promise<TokenServiceRegistration>;
  updateSource(
    source: RegisteredTokenServiceSource,
    update: SourceUpdate,
    signal: AbortSignal,
  ): Promise<void>;
  /** Required for push delivery. Read the current usable version committed by this owner,
   * independently of proxy acknowledgments. Never issue, refresh, push or return credential material.
   * An unavailable version keeps the deployment pending. */
  getPushVersion?(
    source: RegisteredTokenServiceSource<CredentialSourceReference> & {
      readonly registration: Extract<TokenServiceRegistration, { delivery: "push" }>;
    },
    signal: AbortSignal,
  ): Promise<string | undefined>;
  resolveCredential(
    source: RegisteredTokenServiceSource,
    signal: AbortSignal,
  ): Promise<
    | (VersionedCredential & { readonly delivery: "push" })
    | (UsableCredential & { readonly delivery: "native"; readonly version?: string })
  >;
  forceRefresh(
    source: RegisteredTokenServiceSource<CredentialSourceReference>,
    signal: AbortSignal,
  ): Promise<SourceRefreshOperation>;
  getRefreshStatus(
    operation: SourceRefreshOperation,
    signal: AbortSignal,
  ): Promise<CredentialRefreshStatus>;
  /** The reference alone permits cleanup after an uncertain registration on supporting owners. */
  removeSource(
    sourceRef: TokenServiceSourceRef,
    registration: TokenServiceRegistration | undefined,
    signal: AbortSignal,
  ): Promise<void>;
}
