import type {
  AccessBinding,
  CredentialSource,
  CredentialSourceReference,
  OAuthCredentialSource,
  OAuthConnectionGrant,
  OAuthBuiltinCodexSourceConsent,
  OAuthTemplateSourceConsent,
} from "../../index.ts";
import type { Driver } from "../index.ts";

export type CredentialClientPurpose = "oauth2" | "github-app";
export type CredentialClientScope = "installation" | "namespace";
export type TokenServiceClientScopes = Readonly<
  Partial<Record<CredentialClientPurpose, readonly CredentialClientScope[]>>
>;

export type OAuthClientSecretRef =
  | { readonly kind: "oauth_client"; readonly id: string; readonly namespaceId?: never }
  | { readonly kind: "oauth_client"; readonly id: string; readonly namespaceId: string };

/** OAuth confidential material remains bound to its approved token endpoint and owner. */
export interface OAuthClientSecretInstance {
  readonly sourceRef: OAuthClientSecretRef;
  readonly tokenServiceInstanceId: string;
  readonly tokenUrl: string;
}

/** GitHub App signing material is Installation-private and cannot be resolved as OAuth material. */
export interface GitHubAppClientSecretInstance {
  readonly sourceRef: {
    readonly kind: "github_app_client";
    readonly id: string;
    readonly namespaceId?: never;
  };
  readonly tokenServiceInstanceId: string;
  readonly appId: string;
}

export type CredentialClientSecretInstance =
  OAuthClientSecretInstance | GitHubAppClientSecretInstance;

/** A credential store instance retains its identity across ordinary restarts and redeployments. */
export interface TokenServiceSourceInstance<
  Ref extends CredentialSourceReference = CredentialSourceReference,
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

export type SourceRegistrationInput =
  | {
      readonly kind: "static";
      readonly namespaceId: string;
      readonly name: string;
      readonly secret: SecretFields;
      readonly lifecycleConfig: SourceLifecycleConfig;
      readonly config: SourceConfig;
      readonly connectionTemplateId?: string;
    }
  | ({
      readonly kind: "oauth_refresh_token";
      readonly namespaceId: string;
      readonly name: string;
      readonly grant: OAuthConnectionGrant;
    } & (
      | {
          readonly connectionTemplateId: string;
          readonly consent: Omit<
            OAuthTemplateSourceConsent,
            "revocationRequestedBy" | "revokedAt" | "requestedScopes" | "grantedScopes"
          >;
        }
      | {
          readonly connectionTemplateId?: never;
          readonly consent: Omit<
            OAuthBuiltinCodexSourceConsent,
            "revocationRequestedBy" | "revokedAt" | "requestedScopes" | "grantedScopes"
          >;
        }
    ))
  | {
      readonly kind: "github_app_installation";
      readonly namespaceId: string;
      readonly name: string;
      readonly clientId: string;
      readonly repositoryRefs: readonly string[];
    };

export type SourceUpdate =
  | {
      readonly secret: SecretFields;
      readonly lifecycleConfig?: SourceLifecycleConfig;
    }
  | {
      readonly lifecycleConfig: SourceLifecycleConfig;
      readonly secret?: SecretFields;
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

export interface CredentialSourceDeviceAuthorization {
  readonly verificationUrl: string;
  readonly userCode: string;
  readonly expiresAt: string;
  readonly intervalSeconds: number;
  /** Opaque issuer-owned login handle; never an access or refresh token. */
  readonly privateState: string;
}

/** Trusted enrollment context selected by the authorized control-plane login flow. */
export interface TokenServiceDeviceAuthorizationContext {
  readonly namespaceId: string;
  readonly ownerPrincipalId: string;
  readonly harnessId: string;
}

export type TokenServiceDeviceAuthorizationResult =
  | { readonly status: "pending" }
  | { readonly status: "ready"; readonly source: OAuthCredentialSource };

/** The selected owner creates and maintains CredentialSources and their usable credentials. */
export interface TokenServiceDriver extends Omit<Driver, "capability"> {
  readonly capability: "token_service";
  /** An absent purpose does not support client registration at any scope. */
  readonly clientScopes: TokenServiceClientScopes;
  registerClientSecret(
    client: CredentialClientSecretInstance,
    secret: string,
    signal: AbortSignal,
  ): Promise<void>;
  updateClientSecret(
    client: CredentialClientSecretInstance,
    secret: string,
    signal: AbortSignal,
  ): Promise<void>;
  resolveClientSecret(client: OAuthClientSecretInstance, signal: AbortSignal): Promise<string>;
  removeClientSecret(client: CredentialClientSecretInstance, signal: AbortSignal): Promise<void>;
  startDeviceAuthorization?(
    context: TokenServiceDeviceAuthorizationContext,
    signal: AbortSignal,
  ): Promise<CredentialSourceDeviceAuthorization>;
  pollDeviceAuthorization?(
    context: TokenServiceDeviceAuthorizationContext,
    privateState: string,
    beforeCreate: () => Promise<void>,
    signal: AbortSignal,
  ): Promise<TokenServiceDeviceAuthorizationResult>;
  createSource(input: SourceRegistrationInput, signal: AbortSignal): Promise<CredentialSource>;
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
  removeSource(
    source: TokenServiceSourceInstance,
    signal: AbortSignal,
  ): Promise<readonly AccessBinding[]>;
}
