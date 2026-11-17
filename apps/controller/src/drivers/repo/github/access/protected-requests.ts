import { randomUUID } from "node:crypto";
import type {
  PreparedGitHubInstallationUseRequest,
  PreparedGitHubRepositoryUseRequest,
  PreparedGitHubUseRequest,
  RepositoryGitOnlineDecision,
  RepositoryGitSendDecision,
} from "@openclaw-enterprise/contracts";
import { decodePushedBranchRef, normalizePushRefAllowlist } from "../../access/client-contracts.ts";
import type { InstalledGitMaterial } from "./prepared-repository-git.ts";
import { selectGitHubRequest } from "./routes/request-selection.ts";

// OCE's one decision for a protected GitHub request: classify it for the binding, record one
// possible use with the authority and check the answer against this exact request and
// material. The bundled OpenShell route calls it from its request hook. Classification is
// routes/request-selection.ts; the durable checks are the authority's.

/** The request view the caller validated, before any credential is added. */
export type GitHubRequestView = Omit<Parameters<typeof selectGitHubRequest>[0], "target"> & {
  readonly target: Omit<Parameters<typeof selectGitHubRequest>[0]["target"], "reportedScheme">;
};

export type GitHubRequestOperation =
  PreparedGitHubUseRequest["operation"] | PreparedGitHubInstallationUseRequest["operation"];

/** What the Agent may be told about a refusal, never a token, installation or host. */
export type GitHubRequestReasonCode =
  "request_not_allowed" | "draft_already_opened" | "access_withdrawn" | "route_not_ready";

/** Why OCE refused a request. Stable names for logs and receipts; never for the Agent. */
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
  | "approval_denied"
  | "approval_failed"
  | "draft_already_opened"
  | "session_closed"
  | "aborted";

type Use =
  | PreparedGitHubUseRequest
  | PreparedGitHubInstallationUseRequest
  | PreparedGitHubRepositoryUseRequest;

type Identity = {
  /** The live execution (Agent revision) the sender attributed this request to. */
  readonly executionId: string;
  readonly sessionId: string;
  readonly providerInstanceId: string;
  readonly grantId: string;
  readonly installed: InstalledGitMaterial;
};

/** The installed material's nonsecret scope for one recipient. */
export type GitHubRequestBinding =
  | (Identity & {
      readonly scope?: never;
      readonly repositoryId: string;
      readonly repository: string;
      readonly pushRef: string;
      readonly pullRequestBase?: string;
      readonly gitOrigin?: string;
      readonly apiOrigin?: string;
    })
  | (Identity & {
      readonly scope: "github-installation";
      readonly installationId: string;
      readonly apiOrigin: string;
    })
  | (Identity & {
      readonly scope: "github-repository";
      readonly installationId: string;
      readonly apiOrigin: string;
      readonly repositories: readonly Readonly<{ repositoryId: string; repository: string }>[];
    });

/** What the Agent is told for each refusal; binding_mismatch stays generic. */
export const githubRequestReasonCodes: Readonly<
  Record<GitHubRequestRefusal, GitHubRequestReasonCode | undefined>
> = Object.freeze({
  binding_mismatch: undefined,
  request_invalid: "request_not_allowed",
  encoding_unsupported: "request_not_allowed",
  draft_rejected: "request_not_allowed",
  origin_mismatch: "request_not_allowed",
  route_unsupported: "request_not_allowed",
  discovery_body: "request_not_allowed",
  body_empty: "request_not_allowed",
  body_too_large: "request_not_allowed",
  ref_not_allowed: "request_not_allowed",
  // The owner refused the installed material (rotated, expired or past its deadline).
  approval_denied: "route_not_ready",
  approval_failed: "route_not_ready",
  draft_already_opened: "draft_already_opened",
  session_closed: "access_withdrawn",
  aborted: "route_not_ready",
});

function validPushRefPolicy(pushRef: string): boolean {
  try {
    return normalizePushRefAllowlist([pushRef])[0] === pushRef;
  } catch {
    return false;
  }
}

/** The binding's identities and scope are well formed and its policy is one exact branch. */
export function validGitHubRequestBinding(binding: GitHubRequestBinding): boolean {
  return (
    [
      binding.executionId,
      binding.sessionId,
      binding.providerInstanceId,
      binding.scope ? binding.installationId : binding.repositoryId,
      binding.grantId,
      binding.installed?.preparationAttemptId,
      binding.installed?.materialVersion,
    ].every((id) => typeof id === "string" && /^[\x21-\x7e]{1,256}$/.test(id)) &&
    (binding.scope !== undefined
      ? /^[1-9][0-9]{0,15}$/.test(binding.installationId) &&
        binding.apiOrigin === "https://api.github.com" &&
        binding.installed.route?.revisionId === binding.executionId &&
        Number.isSafeInteger(binding.installed.route.fence) &&
        binding.installed.route.fence > 0
      : /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(binding.repository) &&
        !/\/(?:\.|\.\.)$/.test(binding.repository) &&
        typeof binding.pushRef === "string" &&
        validPushRefPolicy(binding.pushRef) &&
        (binding.pullRequestBase === undefined ||
          (decodePushedBranchRef(Buffer.from(binding.pushRef)) === binding.pushRef &&
            decodePushedBranchRef(Buffer.from("refs/heads/" + binding.pullRequestBase)) ===
              "refs/heads/" + binding.pullRequestBase &&
            "refs/heads/" + binding.pullRequestBase !== binding.pushRef)))
  );
}

type Refused = {
  readonly kind: "refused";
  readonly refusal: GitHubRequestRefusal;
  readonly operation?: GitHubRequestOperation;
};

export type GitHubRequestOutcome<Decision> =
  | {
      readonly kind: "allowed";
      readonly operation: GitHubRequestOperation;
      readonly decision: Decision;
    }
  | Refused;

type AllowedDecision =
  | Extract<RepositoryGitOnlineDecision, { kind: "allow" }>
  | Extract<RepositoryGitSendDecision, { kind: "permit" }>;

/**
 * Classify one request for a validated binding, record one possible use and check the
 * authority's answer against this exact request and material. The caller authenticates the
 * execution, validates the binding and supplies a digest of the request view it will send.
 */
export async function decideGitHubRequest<Decision extends AllowedDecision>(options: {
  readonly request: GitHubRequestView;
  readonly binding: GitHubRequestBinding;
  readonly deadlineAt: string;
  readonly signal: AbortSignal;
  /** Called once, after classification; binds the sender's whole request view. */
  readonly requestDigest: () => string;
  /** "allow" for online authorization (replyBy), "permit" for exact dispatch (sendStartBy). */
  readonly expect: Decision["kind"];
  readonly authorize: (
    request: Use,
    installed: InstalledGitMaterial,
    signal: AbortSignal,
  ) => Promise<Decision | Extract<RepositoryGitOnlineDecision, { kind: "denied" }>>;
}): Promise<GitHubRequestOutcome<Decision>> {
  const { request, binding, signal, deadlineAt } = options;
  const refuse = (refusal: GitHubRequestRefusal, operation?: GitHubRequestOperation): Refused =>
    operation === undefined
      ? { kind: "refused", refusal }
      : { kind: "refused", refusal, operation };
  // The caller verified TLS to the target; the classifier does not read the scheme.
  const selection = selectGitHubRequest(
    { ...request, target: { ...request.target, reportedScheme: "https" } },
    binding,
    randomUUID,
  );
  if ("denied" in selection) {
    return refuse(selection.denied);
  }
  const { selected } = selection;
  if (signal.aborted) {
    return refuse("aborted", selected.operation);
  }
  const { sessionId, providerInstanceId, grantId } = binding;
  const requestDigestSha256 = options.requestDigest();
  const use = {
    sessionId,
    providerInstanceId,
    grantId,
    exchangeId: randomUUID(),
    requestDigestSha256,
    deadlineAt,
  };
  let q: Use;
  if (binding.scope !== undefined) {
    if (selected.operation === "create-draft-pull") {
      return refuse("binding_mismatch");
    }
    q = {
      ...use,
      ...(binding.scope === "github-repository"
        ? { scope: binding.scope, repositories: binding.repositories }
        : { scope: binding.scope }),
      installationId: binding.installationId,
      operation: selected.operation,
    };
  } else {
    const { operation, pull } = selected;
    if (operation === "github-rest" || operation === "github-graphql") {
      return refuse("binding_mismatch");
    }
    q = {
      ...use,
      repositoryId: binding.repositoryId,
      pushRef: binding.pushRef,
      operation,
      ...(pull && { pull }),
    };
  }
  const { installed } = binding;
  let denied: false | "draft_already_opened" | "access_withdrawn";
  try {
    const result = await options.authorize(q, installed, signal);
    if (result.kind === "denied") {
      const { reason } = result;
      denied = reason === "draft_already_opened" || reason === "access_withdrawn" ? reason : false;
    } else if (
      result.kind === options.expect &&
      !signal.aborted &&
      result.exchangeId === q.exchangeId &&
      result.requestDigestSha256 === requestDigestSha256 &&
      result.materialVersion === installed.materialVersion &&
      result.preparationAttemptId === installed.preparationAttemptId &&
      Date.parse(result.kind === "allow" ? result.replyBy : result.sendStartBy) <=
        Date.parse(deadlineAt)
    ) {
      // The owner checked this exact authority deadline at its final callback. A sender that
      // holds the allow may finish the request after withdrawal.
      return { kind: "allowed", operation: selected.operation, decision: result as Decision };
    } else {
      denied = false;
    }
  } catch {
    // The owner did not answer. Possible use may have committed; deny without retry.
    return refuse("approval_failed", selected.operation);
  }
  if (denied) {
    if (signal.aborted) {
      return refuse("aborted", selected.operation);
    }
    // The grant's one draft create was already used (finding 2147), or the session ended.
    // The Agent is told which; nothing about the earlier draft or the session is disclosed.
    return refuse(
      denied === "access_withdrawn" ? "session_closed" : "draft_already_opened",
      selected.operation,
    );
  }
  return refuse("approval_denied", selected.operation);
}
