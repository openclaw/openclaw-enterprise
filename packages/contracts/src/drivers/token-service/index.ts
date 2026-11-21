import type { CredentialSource, CredentialSourceReference } from "../../index.ts";
import type { Driver } from "../index.ts";

export type TokenServiceSourceRef = CredentialSourceReference | InstallationClientSecretRef;

/** Only authorized control-plane consumers can use an Installation registration secret. */
export interface InstallationClientSecretRef {
  readonly kind: "oauth_client";
  readonly id: string;
  readonly namespaceId?: never;
}

/** A credential store instance retains its identity across ordinary restarts and redeployments. */
export interface TokenServiceSourceInstance<
  Ref extends TokenServiceSourceRef = TokenServiceSourceRef,
> {
  readonly sourceRef: Ref;
  readonly tokenServiceInstanceId: string;
}

/** Only the selected owner's adapter interprets its reviewed source type and lifecycle fields. */
export interface SourceLifecycleConfig {
  readonly type: string;
  readonly settings: Readonly<Record<string, string>>;
}

type SecretFields = Readonly<Record<string, string>>;
type SourceConfig = Readonly<Record<string, string>>;

export interface SourceRegistrationInput {
  readonly namespaceId: string;
  readonly name: string;
  readonly secret: SecretFields;
  readonly lifecycleConfig: SourceLifecycleConfig;
  readonly config: SourceConfig;
}

export type SourceUpdate =
  | {
      readonly secret: SecretFields;
      readonly lifecycleConfig?: SourceLifecycleConfig;
      readonly config?: SourceConfig;
    }
  | {
      readonly lifecycleConfig: SourceLifecycleConfig;
      readonly secret?: SecretFields;
      readonly config?: SourceConfig;
    }
  | {
      readonly config: SourceConfig;
      readonly secret?: SecretFields;
      readonly lifecycleConfig?: SourceLifecycleConfig;
    };

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

/** The selected owner creates and maintains CredentialSources and their usable credentials. */
export interface TokenServiceDriver extends Omit<Driver, "capability"> {
  readonly capability: "token_service";
  createSource(input: SourceRegistrationInput, signal: AbortSignal): Promise<CredentialSource>;
  readSource(
    source: TokenServiceSourceInstance<CredentialSourceReference>,
    signal: AbortSignal,
  ): Promise<CredentialSource | undefined>;
  listSources(namespaceId: string, signal: AbortSignal): Promise<readonly CredentialSource[]>;
  updateSource(
    source: TokenServiceSourceInstance,
    update: SourceUpdate,
    signal: AbortSignal,
  ): Promise<CredentialSource>;
  resolveCredential(
    source: TokenServiceSourceInstance,
    signal: AbortSignal,
  ): Promise<ResolvedCredential>;
  forceRefresh(
    source: TokenServiceSourceInstance<CredentialSourceReference>,
    signal: AbortSignal,
  ): Promise<SourceRefreshOperation>;
  getRefreshStatus(
    operation: SourceRefreshOperation,
    signal: AbortSignal,
  ): Promise<CredentialRefreshStatus>;
  prepareSourceRetirement(source: TokenServiceSourceInstance, signal: AbortSignal): Promise<void>;
  removeSource(source: TokenServiceSourceInstance, signal: AbortSignal): Promise<void>;
}
