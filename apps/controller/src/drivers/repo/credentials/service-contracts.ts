import type { RepositoryCredentialGrantIdentity } from "@openclaw-enterprise/contracts";
import type { RepositoryCredentialClientConfiguration } from "./client-contracts.ts";

/** Full private service observation, validated before projection at the Driver boundary. */
export interface SessionStatus {
  readonly sessionId: string;
  readonly state: "OPEN" | "CLOSED" | "DISPOSED";
  readonly deadlineWallMs: number;
  readonly binding: RepositoryCredentialGrantIdentity;
  readonly activeUses: number;
  readonly cleanup: Readonly<{
    active: number;
    pending: number;
    revoked: number;
    expired: number;
    uncertain: number;
    auxiliaryPending: boolean;
  }>;
}

/** Protected single-repository operator input; registry admission uses the bound form. */
export type RepositoryCredentialSessionInput = Readonly<{
  durationSeconds: number;
  profile: string | undefined;
}>;

/** Registry-backed admission always supplies the complete resolved authority. */
export interface RepositoryCredentialBoundSessionInput extends RepositoryCredentialSessionInput {
  readonly namespaceId: string;
  readonly repositoryRef: string;
  readonly profile: string;
  readonly expectedBinding: RepositoryCredentialGrantIdentity;
  readonly deadlineWallMs: number;
  /** Look up an admission without creating a session; not part of replay identity. */
  readonly recoverOnly?: true;
  /** Requires the durable admission protocol; older brokers must reject it. */
  readonly durableAdmission?: true;
  /** Part of durable admission identity; only a prepared backend may serve it. */
  readonly preparedOnly?: true;
}

export interface RepositoryCredentialSessionResult {
  readonly session: SessionStatus;
  readonly bearer: string;
  readonly client: RepositoryCredentialClientConfiguration;
}

export interface ShutdownSummary {
  readonly closedSessions: number;
  readonly disposedSessions: number;
  readonly pendingActions: number;
  readonly pendingCredentials: number;
  readonly pendingAuxiliary: number;
  readonly graceExpired: boolean;
}
export interface ServiceLimits {
  readonly sessions: number;
  readonly credentialSlotsPerSession: number;
  readonly providerActions: number;
  readonly providerQueue: number;
  readonly sockets: number;
  readonly exchanges: number;
  readonly exchangesPerSession: number;
  readonly headerBytes: number;
  readonly headerPairs: number;
  readonly targetBytes: number;
  readonly gitFetchInputBytes: number;
  readonly gitPushInputBytes: number;
  readonly gitResponseBytes: number;
  readonly gitFetchResponseBytes: number;
  readonly gitFetchStallMs: number;
  readonly gitFetchFirstHeaderMs: number;
  readonly gitFetchExchangeMs: number;
  readonly apiInputBytes: number;
  readonly apiResponseBytes: number;
  readonly controlBodyBytes: number;
  readonly headerMs: number;
  readonly connectMs: number;
  readonly stallMs: number;
  readonly inputMs: number;
  readonly firstHeaderMs: number;
  readonly exchangeMs: number;
  readonly maxExchangeMs: number;
  readonly providerActionMs: number;
  readonly shutdownGraceMs: number;
  readonly credentialMarginMs: number;
  readonly accessTokenBytes: number;
  readonly renewalBytesPerSession: number;
}
export interface ServiceConfig {
  readonly gateway: Readonly<{ publicOrigin: string; listen: string; controlSocket: string }>;
  readonly sessionPolicy: Readonly<{
    maximumDurationSeconds: number;
    defaultProfile: string;
    allowedProfiles: readonly string[];
  }>;
  readonly limits: ServiceLimits;
}
export interface SafeConfigurationSummary {
  readonly valid: true;
  readonly gatewayOrigin: string;
  readonly profiles: readonly string[];
  readonly maximumDurationSeconds: number;
  readonly authority: "github-prepared-git-registry" | "github-token-development";
  /** Token authority only: the class derived from the token prefix, never its value. */
  readonly tokenClass?: string;
}
export interface SessionControl {
  open(
    input: RepositoryCredentialSessionInput | RepositoryCredentialBoundSessionInput,
    /** Private receipt owner, never part of the client input. */
    authorizeStanding?: (sessionId: string) => Promise<void>,
  ): RepositoryCredentialSessionResult;
  status(sessionId: string): SessionStatus | undefined;
  close(sessionId: string): SessionStatus;
}
export interface CredentialService extends SessionControl {
  shutdown(graceMs: number): Promise<ShutdownSummary>;
}
