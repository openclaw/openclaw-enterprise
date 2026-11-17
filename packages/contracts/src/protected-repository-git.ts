import type { CredentialProxyBinding } from "./credential-proxy-exchange.ts";
import type { EgressInstallation } from "./drivers/credential-proxy/index.ts";
import type { RepositoryGitDeliveryProfile } from "./drivers/credential-proxy/index.ts";
import type {
  PreparedGitHubInstallationUseRequest,
  PreparedGitHubRepositoryUseRequest,
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

export interface ProtectedGitHubRepositoryMaterial extends Omit<
  ProtectedGitHubInstallationMaterial,
  "scope"
> {
  readonly scope: "github-repository";
  readonly repositories: readonly Readonly<{ repositoryId: string; repository: string }>[];
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
  readonly githubRepository?: {
    readMaterial(
      route: Route,
      signal: AbortSignal,
    ): Promise<
      | ProtectedGitHubRepositoryMaterial
      | { readonly absent: "withdrawn" | "unprepared" }
      | undefined
    >;
    authorize(
      request: PreparedGitHubRepositoryUseRequest,
      installed: Version & { readonly route: Route },
      signal: AbortSignal,
    ): Promise<RepositoryGitDenied | Allow>;
  };
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

/**
 * One HTTPS request a recipient is about to send to GitHub, before any credential is added:
 * what a supervisor-style request hook can send. The caller authenticates the execution first,
 * takes `target` from the TLS-verified destination (never from the `Host` header) and omits
 * credential, `host`, connection and framing headers. Header names are lowercase and in
 * received order; a repeated name is refused. OCE matches the target only against the grant's
 * own origins; it does not resolve or pin hosts.
 */
export interface GitHubRequestView {
  readonly target: {
    readonly host: string;
    readonly port: number;
    readonly method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
    /** Exactly as received, without the query and without normalization. */
    readonly path: string;
    /** Exactly as received, without the leading `?`; empty when absent. */
    readonly query: string;
  };
  readonly headers: readonly (readonly [string, string])[];
  /** The whole buffered body, at most 4 MiB. Git push packs count toward it, as on the bundled route. */
  readonly body: Uint8Array;
}

export type GitHubRequestOperation =
  PreparedGitHubUseRequest["operation"] | PreparedGitHubInstallationUseRequest["operation"];

/**
 * What the Agent may be told, never a token, installation or host:
 * - `request_not_allowed`: this grant does not admit the request (another ref, repository,
 *   base or route). Do not retry it.
 * - `draft_already_opened`: the grant's draft-create allowance was spent; this does not
 *   confirm that a draft exists.
 * - `access_withdrawn`: this Agent version's repository access ended. Do not retry.
 * - `route_not_ready`: no usable material yet, or OCE did not answer. The client may retry
 *   the request shortly, as a new request.
 */
export type GitHubRequestReasonCode =
  "request_not_allowed" | "draft_already_opened" | "access_withdrawn" | "route_not_ready";

/** Why OCE refused a request. Stable names for sender logs and receipts; never for the Agent. */
export type GitHubRequestRefusal =
  | "request_invalid"
  | "encoding_unsupported"
  | "draft_rejected"
  | "origin_mismatch"
  | "route_unsupported"
  | "discovery_body"
  | "body_empty"
  | "body_too_large"
  | "ref_not_allowed"
  | "binding_mismatch"
  | "material_unavailable"
  | "approval_denied"
  | "approval_failed"
  | "draft_already_opened"
  | "session_closed"
  | "aborted";

export type GitHubRequestDecision =
  | {
      readonly kind: "allow";
      readonly operation: GitHubRequestOperation;
      /** OCE's use record for this request: join sender receipts and outcome reports to it. */
      readonly exchangeId: string;
      /** Start sending before this instant on the Worker's clock, or drop the request. */
      readonly sendBy: string;
      /** The credential for exactly the request OCE classified, nothing else: send those bytes
       * once. Git takes it as HTTP Basic `username:token`, the API as `Bearer token`; the
       * caller places it as its route requires. Never log, store, reuse or resend it; a retry
       * is a new request with its own decision. */
      readonly credential:
        | { readonly scheme: "basic"; readonly username: "x-access-token"; readonly token: string }
        | { readonly scheme: "bearer"; readonly token: string };
    }
  | {
      readonly kind: "refused";
      readonly refusal: GitHubRequestRefusal;
      /** Absent when OCE cannot attribute the request to this grant: show a generic refusal. */
      readonly reasonCode?: GitHubRequestReasonCode;
      readonly operation?: GitHubRequestOperation;
      /** Present once OCE asked its owner, which may have recorded a possible use. */
      readonly exchangeId?: string;
    };

/**
 * Worker-supplied: OCE's own GitHub request classification and authorization, bound to the
 * same authority as `bindRepositoryGit`. Each call reads the current material for `route`,
 * classifies the request for that grant (Git smart HTTP and its pushed refs, GitHub REST and
 * GraphQL, the draft pull request create), records one possible use and answers allow (with
 * the credential) or refuse. Callers need no GitHub ref, draft or repository rules of
 * their own; malformed input is refused, never thrown.
 *
 * Precondition (current rule; a release-per-request evidence mode may replace it, RFC-0040):
 * OCE allows a use only for a recipient whose installation of that exact material version is
 * confirmed with `recipients.beginInstall` and `confirmInstall`, once per material version,
 * again after every renewal; pass the route `confirmInstall` returned. For a request-time
 * recipient, which asks per request and keeps no value, confirming means: ready to ask per
 * request, holding no value.
 *
 * Accepted gap: the allowed credential is the grant's installation token, which GitHub
 * accepts for anything its permissions cover until it expires or is retired. The ref, draft
 * and repository rules and `sendBy` bind a caller that keeps this contract; OCE cannot
 * enforce them on one that keeps the token. Never assume the credential is the same across
 * calls: OCE may return one minted or narrowed for the request's operation.
 *
 * The caller owns the time budget (pass a `signal` that aborts at it) and bounds how many
 * calls it has in flight.
 */
export interface RepositoryGitRequests {
  authorize(input: {
    /** The recipient's confirmed route for the installed material version (see above). */
    readonly route: RepositoryGitInstallationFence;
    /** The profile admitted for this recipient; the recipient is admitted for online
     * authorization of every request. */
    readonly profile: RepositoryGitDeliveryProfile;
    readonly request: GitHubRequestView;
    /** In the future and at most 30 seconds ahead, or refused; defaults to 10 seconds. */
    readonly deadlineAt?: string;
    readonly signal: AbortSignal;
  }): Promise<GitHubRequestDecision>;
}
