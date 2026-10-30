import type { CredentialSourceContext } from "./credential-gateway.ts";
import type { Driver } from "./driver.ts";

export interface CredentialRefreshInput {
  readonly config: Readonly<Record<string, string>>;
  /** Resolved refresh material keyed by catalog field; never persisted by OCC. */
  readonly secrets: Readonly<Record<string, string>>;
  /** A UUID, stable per source and configuration attempt, so a replay is not applied twice. */
  readonly requestId: string;
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

/**
 * Mints and re-mints tokens for the paired Credential Gateway's `refresh` sources. OCC drives
 * only setup, incident rotation, and status; the implementation refreshes before expiry.
 */
export interface CredentialRefreshDriver extends Driver {
  readonly capability: "credential_refresh";
  /** Owns the private device exchange; OCC retains only an opaque login handle. */
  startDeviceAuthorization?(
    context: CredentialSourceContext,
  ): Promise<CredentialSourceDeviceAuthorization>;
  /** Ready means refresh custody and the first managed token are established; never returns tokens. */
  pollDeviceAuthorization?(
    context: CredentialSourceContext,
    privateState: string,
  ): Promise<CredentialSourceDeviceAuthorizationResult>;
  /** Replaces the source's refresh material; replaying a successful `requestId` is a no-op. */
  configureRefresh(
    context: CredentialSourceContext,
    input: CredentialRefreshInput,
  ): Promise<CredentialRefreshStatus>;
  /** Forces one refresh; it does not revoke the previous token at the issuer. */
  rotate(context: CredentialSourceContext, requestId: string): Promise<CredentialRefreshStatus>;
  refreshStatus(context: CredentialSourceContext): Promise<CredentialRefreshStatus>;
  /** Idempotent; deletes the stored refresh material. */
  removeRefresh(context: CredentialSourceContext): Promise<void>;
}

export interface CredentialSourceDeviceAuthorization {
  readonly verificationUrl: string;
  readonly userCode: string;
  readonly expiresAt: string;
  readonly intervalSeconds: number;
  /** Opaque Refresh Driver login handle; never an access or refresh token. */
  readonly privateState: string;
}

export type CredentialSourceDeviceAuthorizationResult = { readonly status: "pending" | "ready" };
