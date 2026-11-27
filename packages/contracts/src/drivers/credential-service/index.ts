import type {
  AccessBinding,
  CredentialClient,
  CredentialSource,
  CredentialSourceReference,
  OAuthCredentialSource,
  OAuthConnectionGrant,
  OAuthBuiltinCodexSourceConsent,
  OAuthTemplateSourceConsent,
} from "../../index.ts";
import type { Driver } from "../index.ts";

export type CredentialClientPurpose = CredentialClient["kind"];
export type CredentialClientScope = "installation" | "namespace";
export type CredentialServiceClientScopes = Readonly<
  Partial<Record<CredentialClientPurpose, readonly CredentialClientScope[]>>
>;

type CredentialClientSecretOwner = Pick<CredentialClient, "id" | "namespaceId"> & {
  readonly credentialServiceInstanceId: string;
};

/** OAuth material belongs to the exact client registration and issuer. */
export type OAuthClientSecretInstance = CredentialClientSecretOwner & {
  readonly kind: "oauth2";
  readonly issuer: string;
};

/** GitHub App signing material is used by its issuer inside CredentialService. */
export type GitHubAppClientSecretInstance = CredentialClientSecretOwner & {
  readonly kind: "github-app";
  readonly appId: string;
};

export type CredentialClientSecretInstance =
  OAuthClientSecretInstance | GitHubAppClientSecretInstance;

/** A credential store instance retains its identity across ordinary restarts and redeployments. */
export interface CredentialServiceSourceInstance<
  Ref extends CredentialSourceReference = CredentialSourceReference,
> {
  readonly sourceRef: Ref;
  readonly credentialServiceInstanceId: string;
}

/** Only the selected owner's adapter interprets its reviewed source type and lifecycle fields. */
export interface SourceLifecycleConfig {
  readonly settings: Readonly<Record<string, string>>;
}

type SourceConfig = Readonly<Record<string, string>>;

export type SourceRegistrationInput =
  | {
      readonly type: "static";
      readonly namespaceId: string;
      readonly name: string;
      readonly secret: string;
      readonly lifecycleConfig: SourceLifecycleConfig;
      readonly config: SourceConfig;
      readonly connectionTemplateId?: string;
    }
  | ({
      readonly type: "oauth2-refresh-token";
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
      readonly type: "github-app-installation";
      readonly namespaceId: string;
      readonly name: string;
      readonly clientId: string;
      readonly repositoryRefs: readonly string[];
    };

export type SourceUpdate =
  | {
      readonly secret: string;
      readonly lifecycleConfig?: SourceLifecycleConfig;
    }
  | {
      readonly lifecycleConfig: SourceLifecycleConfig;
      readonly secret?: string;
    };

export interface ResolvedCredential {
  readonly credential: string;
  /** Required when the resolved value is pushed to a delivery resource. */
  readonly version?: string;
  readonly expiresAt?: string;
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

export interface SourceRefreshOperation extends CredentialServiceSourceInstance<CredentialSourceReference> {
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
export interface CredentialServiceDeviceAuthorizationContext {
  readonly namespaceId: string;
  readonly ownerPrincipalId: string;
  readonly harnessId: string;
}

export type CredentialServiceDeviceAuthorizationResult =
  | { readonly status: "pending" }
  | { readonly status: "ready"; readonly source: OAuthCredentialSource };

/** The selected owner creates and maintains CredentialSources and their usable credentials. */
export interface CredentialServiceDriver extends Omit<Driver, "capability"> {
  readonly capability: "credential_service";
  /** An absent purpose does not support client registration at any scope. */
  readonly clientScopes: CredentialServiceClientScopes;
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
    context: CredentialServiceDeviceAuthorizationContext,
    signal: AbortSignal,
  ): Promise<CredentialSourceDeviceAuthorization>;
  pollDeviceAuthorization?(
    context: CredentialServiceDeviceAuthorizationContext,
    privateState: string,
    beforeCreate: () => Promise<void>,
    signal: AbortSignal,
  ): Promise<CredentialServiceDeviceAuthorizationResult>;
  createSource(input: SourceRegistrationInput, signal: AbortSignal): Promise<CredentialSource>;
  updateSource(
    source: CredentialServiceSourceInstance,
    update: SourceUpdate,
    signal: AbortSignal,
  ): Promise<CredentialSource>;
  resolveCredential(
    source: CredentialServiceSourceInstance,
    signal: AbortSignal,
  ): Promise<ResolvedCredential>;
  forceRefresh(
    source: CredentialServiceSourceInstance<CredentialSourceReference>,
    signal: AbortSignal,
  ): Promise<SourceRefreshOperation>;
  getRefreshStatus(
    operation: SourceRefreshOperation,
    signal: AbortSignal,
  ): Promise<CredentialRefreshStatus>;
  removeSource(
    source: CredentialServiceSourceInstance,
    signal: AbortSignal,
  ): Promise<readonly AccessBinding[]>;
}
