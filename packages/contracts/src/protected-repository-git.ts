import type { EgressInstallation } from "./credential-proxy.ts";
import type { PreparedGitHubUseRequest } from "./prepared-github-egress.ts";

/** Exact observation by this Driver of the recipient in the committed installation. */
export interface RepositoryGitInstallationFence {
  readonly revisionId: string;
  readonly fence: number;
  readonly observed: unknown;
}

export interface RepositoryGitMaterialVersion {
  readonly preparationAttemptId: string;
  readonly materialVersion: string;
}

export interface ProtectedRepositoryGitMaterial extends RepositoryGitMaterialVersion {
  readonly value: string;
  readonly expiresAt: string;
  readonly sessionId: string;
  readonly providerInstanceId: string;
  readonly repositoryId: string;
  readonly grantId: string;
  readonly repository: string;
  readonly pushRef: string;
  readonly pullRequestBase?: string;
  readonly apiOrigin: string;
}

type Route = RepositoryGitInstallationFence;
type Version = RepositoryGitMaterialVersion;

/** Committed possible use. Only this exchange, request and installed material may consume it. */
export interface RepositoryGitSendPermit extends RepositoryGitMaterialVersion {
  readonly kind: "permit";
  readonly exchangeId: string;
  readonly requestDigestSha256: string;
  /** Exclusive deadline to start sending, not a deadline to finish or evidence of delivery. */
  readonly sendStartBy: string;
}

export type RepositoryGitSendDecision =
  | RepositoryGitSendPermit
  | {
      readonly kind: "denied";
      readonly reason: "unavailable" | "draft_already_opened" | "access_withdrawn";
    };

/** Private port for the trusted sender selected at installation. Never pass it to a workload. */
export interface ProtectedRepositoryGitAuthority {
  readonly recipients: {
    /** Re-observe this exact released recipient. An unresolved installation is not adopted. */
    observe(installation: EgressInstallation): Promise<Route | undefined>;
    /** Persist intent before installing. A lost install or confirmation stays pending, never replay it. */
    beginInstall(route: Route, version: Version): Promise<(Route & Version) | undefined>;
    /** Only after independently verifying that exact material at the same recipient. */
    confirmInstall(pending: Route & Version): Promise<Route | undefined>;
  };
  /** Read eligible committed material only for this verified installation; never issue from here. */
  readMaterial(
    route: Route,
    signal: AbortSignal,
  ): Promise<
    ProtectedRepositoryGitMaterial | { readonly absent: "withdrawn" | "unprepared" } | undefined
  >;
  /** Authenticate the sender and bind the actual request before calling once. At its last
   * controlled boundary before sending, the Driver must match and consume the permit before
   * sendStartBy, even if transport readiness was delayed. Never renew or retry an uncertain use. */
  authorize(
    request: PreparedGitHubUseRequest,
    installed: Version & { readonly route: Route },
    signal: AbortSignal,
  ): Promise<RepositoryGitSendDecision>;
}
