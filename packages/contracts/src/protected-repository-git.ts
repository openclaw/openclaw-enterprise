import type { CredentialProxyBinding } from "./credential-proxy-exchange.ts";
import type { EgressInstallation } from "./drivers/credential-proxy/index.ts";
import type {
  PreparedGitHubInstallationUseRequest,
  PreparedGitHubUseRequest,
} from "./prepared-github-egress.ts";

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

/** Installed only at the independently observed recipient released for this scope. */
export interface ProtectedGitHubInstallationMaterial extends Omit<
  ProtectedRepositoryGitMaterial,
  "repositoryId" | "repository" | "pushRef" | "pullRequestBase"
> {
  readonly scope: "github-installation";
  readonly installationId: string;
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

/** Authority committed possible use of this installed material for this request. Deliver the
 * allow reply before replyBy. The sender may then finish that request, even after withdrawal.
 * This is neither a lease for another request nor evidence of a send or provider outcome. */
export interface RepositoryGitOnlineAllow extends RepositoryGitMaterialVersion {
  readonly kind: "allow";
  readonly exchangeId: string;
  readonly requestDigestSha256: string;
  readonly replyBy: string;
}

interface RepositoryGitDenied {
  readonly kind: "denied";
  readonly reason: "unavailable" | "draft_already_opened" | "access_withdrawn";
}

export type RepositoryGitSendDecision = RepositoryGitSendPermit | RepositoryGitDenied;
export type RepositoryGitOnlineDecision = RepositoryGitOnlineAllow | RepositoryGitDenied;

export type GitHubInstallationSendPermit = RepositoryGitSendPermit &
  Pick<PreparedGitHubInstallationUseRequest, "scope" | "operation"> &
  Pick<Route, "revisionId" | "fence">;

export type GitHubInstallationSendDecision =
  GitHubInstallationSendPermit | Extract<RepositoryGitSendDecision, { kind: "denied" }>;

interface GitHubInstallationAuthority<
  Allow extends RepositoryGitSendPermit | RepositoryGitOnlineAllow,
> {
  readMaterial(
    route: Route,
    signal: AbortSignal,
  ): Promise<
    | ProtectedGitHubInstallationMaterial
    | { readonly absent: "withdrawn" | "unprepared" }
    | undefined
  >;
  /** Match this recipient and request, enforcing the selected send or authorization deadline. */
  authorize(
    request: PreparedGitHubInstallationUseRequest,
    installed: Version & { readonly route: Route },
    signal: AbortSignal,
  ): Promise<
    | RepositoryGitDenied
    | (Allow &
        Pick<PreparedGitHubInstallationUseRequest, "scope" | "operation"> &
        Pick<Route, "revisionId" | "fence">)
  >;
}

/** Private port for the trusted sender selected at installation. Never pass it to a workload. */
export interface ProtectedRepositoryGitAuthority extends RepositoryGitAuthority<RepositoryGitSendPermit> {
  /** Only for recipients admitted and verified for authorization of every new request. */
  readonly online: RepositoryGitAuthority<RepositoryGitOnlineAllow>;
  /** Separately selected, only for a v6 admission on the bundled observed route. */
  readonly observedHook?: GitHubInstallationAuthority<RepositoryGitOnlineAllow>;
  readonly recipients: {
    /** Re-observe this exact released recipient. An unresolved installation is not adopted. */
    observe(installation: EgressInstallation): Promise<Route | undefined>;
    /** Persist intent before installing. A lost install or confirmation stays pending, never replay it. */
    beginInstall(route: Route, version: Version): Promise<(Route & Version) | undefined>;
    /** Only after independently verifying that exact material at the same recipient. */
    confirmInstall(pending: Route & Version): Promise<Route | undefined>;
  };
}

export interface RepositoryGitAuthority<
  Allow extends RepositoryGitSendPermit | RepositoryGitOnlineAllow,
> {
  /** Neither the other scope nor another sender guarantee can release this material. */
  readonly githubInstallation?: GitHubInstallationAuthority<Allow>;
  /** Read eligible committed material only for this verified installation; never issue from here. */
  readMaterial(
    route: Route,
    signal: AbortSignal,
  ): Promise<
    ProtectedRepositoryGitMaterial | { readonly absent: "withdrawn" | "unprepared" } | undefined
  >;
  /** Authenticate the sender and bind the actual request before calling once. At its last
   * controlled boundary the Driver must match the decision to this request and material. For
   * exact dispatch consume the permit before sendStartBy, even if transport was delayed.
   * Online authorization checks replyBy when replying. Never renew or retry an uncertain use. */
  authorize(
    request: PreparedGitHubUseRequest,
    installed: Version & { readonly route: Route },
    signal: AbortSignal,
  ): Promise<RepositoryGitDenied | Allow>;
}

/** Worker-owned delivery loop for the selected registered sender. */
export interface RepositoryGitBinding extends CredentialProxyBinding {
  /** Reconcile eligible material and independently observe unresolved operations.
   * A lost response must never cause a second installation. No request may invoke this. */
  reconcile?(signal: AbortSignal): Promise<void>;
}
