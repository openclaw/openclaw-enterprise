import type { CredentialSourceReference } from "../../index.ts";
import type { Driver } from "../index.ts";

export type TokenServiceSourceRef = CredentialSourceReference | InstallationClientSecretRef;

/** Only authorized control-plane consumers can use an Installation registration secret. */
export interface InstallationClientSecretRef {
  readonly kind: "oauth_client";
  readonly id: string;
  readonly namespaceId?: never;
}

/** Private nonsecret locator; a shared implementation validates it before provider attachment. */
export interface TokenServiceRegistration {
  readonly backendRef?: Readonly<Record<string, string>>;
}

/** A credential store instance retains its identity across ordinary restarts and redeployments. */
export interface TokenServiceSourceInstance<
  Ref extends TokenServiceSourceRef = TokenServiceSourceRef,
> {
  readonly sourceRef: Ref;
  readonly tokenServiceInstanceId: string;
}

export interface RegisteredTokenServiceSource<
  Ref extends TokenServiceSourceRef = TokenServiceSourceRef,
> extends TokenServiceSourceInstance<Ref> {
  readonly registration: TokenServiceRegistration;
}

/** Only the selected owner's adapter interprets its reviewed source type and lifecycle fields. */
export interface SourceLifecycleConfig {
  readonly type: string;
  readonly settings: Readonly<Record<string, string>>;
}

type SecretFields = Readonly<Record<string, string>>;

export interface SourceRegistrationInput extends TokenServiceSourceInstance {
  readonly secret: SecretFields;
  readonly lifecycleConfig: SourceLifecycleConfig;
}

export type SourceUpdate =
  | { readonly secret: SecretFields; readonly lifecycleConfig?: SourceLifecycleConfig }
  | { readonly lifecycleConfig: SourceLifecycleConfig; readonly secret?: SecretFields };

export interface ResolvedCredential {
  readonly credential: string;
  /** Required when the resolved value is pushed to a delivery resource. */
  readonly version?: string;
  readonly expiresAt?: string;
  /** Trusted account context when the consumer must route an account-scoped request. */
  readonly accountId?: string;
  readonly isFedramp?: boolean;
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

export interface SourceRefreshOperation extends TokenServiceSourceInstance<CredentialSourceReference> {
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
  resolveCredential(
    source: RegisteredTokenServiceSource,
    signal: AbortSignal,
  ): Promise<ResolvedCredential>;
  forceRefresh(
    source: RegisteredTokenServiceSource<CredentialSourceReference>,
    signal: AbortSignal,
  ): Promise<SourceRefreshOperation>;
  getRefreshStatus(
    operation: SourceRefreshOperation,
    signal: AbortSignal,
  ): Promise<CredentialRefreshStatus>;
  /** Instance identity remains required when registration failed before returning a locator. */
  removeSource(
    source: TokenServiceSourceInstance & { readonly registration?: TokenServiceRegistration },
    signal: AbortSignal,
  ): Promise<void>;
}
