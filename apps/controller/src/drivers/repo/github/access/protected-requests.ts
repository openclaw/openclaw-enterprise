import { randomUUID } from "node:crypto";
import type {
  PreparedGitHubInstallationUseRequest,
  PreparedGitHubRepositoryUseRequest,
  PreparedGitHubUseRequest,
  RepositoryGitOnlineDecision,
} from "@openclaw-enterprise/contracts";
import { decodePushedBranchRef, normalizePushRefAllowlist } from "../../access/client-contracts.ts";
import type { InstalledGitMaterial } from "./prepared-repository-git.ts";
import { selectGitHubRequest } from "./routes/request-selection.ts";

// OCE's one decision for a protected GitHub request: classify it for the binding, record one
// possible use with the authority and check the answer against this exact request and
// material. The bundled OpenShell route calls it from its request hook. Classification is
// routes/request-selection.ts; the durable checks are the authority's.

/** The request view the caller validated, before any credential is added. */
type GitHubRequestView = Parameters<typeof selectGitHubRequest>[0];

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
      readonly sameRepositoryPullRequests?: true;
      readonly issueCreationRepositories?: readonly string[];
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

/**
 * Validates identities and scope: Git-only bindings allow a terminal wildcard in the push ref,
 * bindings with a pull request base require a concrete push ref, and scope pins check no push ref.
 */
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

type GitHubRequestOutcome =
  | {
      readonly kind: "allowed";
      readonly operation: GitHubRequestOperation;
      readonly replyBy: string;
    }
  | Refused;

/**
 * Classify one request for a validated binding, record one possible use and check the
 * authority's answer against this exact request and material. The caller authenticates the
 * execution, validates the binding and supplies a digest of the request view it will send.
 */
export async function decideGitHubRequest(options: {
  readonly request: GitHubRequestView;
  readonly binding: GitHubRequestBinding;
  readonly deadlineAt: string;
  readonly signal: AbortSignal;
  /** Called once, after classification; binds the sender's whole request view. */
  readonly requestDigest: () => string;
  readonly authorize: (
    request: Use,
    installed: InstalledGitMaterial,
    signal: AbortSignal,
  ) => Promise<RepositoryGitOnlineDecision>;
}): Promise<GitHubRequestOutcome> {
  const { request, binding, signal, deadlineAt } = options;
  const refuse = (refusal: GitHubRequestRefusal, operation?: GitHubRequestOperation): Refused =>
    operation === undefined
      ? { kind: "refused", refusal }
      : { kind: "refused", refusal, operation };
  const selection = selectGitHubRequest(request, binding, randomUUID);
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
  try {
    const result = await options.authorize(q, installed, signal);
    if (signal.aborted) {
      return refuse("aborted", selected.operation);
    }
    if (result.kind === "denied") {
      // Expose only the two denial reasons the Agent can act on.
      if (result.reason === "access_withdrawn") {
        return refuse("session_closed", selected.operation);
      }
      if (result.reason === "draft_already_opened") {
        return refuse("draft_already_opened", selected.operation);
      }
    } else if (
      result.kind === "allow" &&
      result.exchangeId === q.exchangeId &&
      result.requestDigestSha256 === requestDigestSha256 &&
      result.materialVersion === installed.materialVersion &&
      result.preparationAttemptId === installed.preparationAttemptId &&
      Date.parse(result.replyBy) <= Date.parse(deadlineAt)
    ) {
      return { kind: "allowed", operation: selected.operation, replyBy: result.replyBy };
    }
    return refuse("approval_denied", selected.operation);
  } catch {
    // The owner did not answer. Possible use may have committed; deny without retry.
    return refuse("approval_failed", selected.operation);
  }
}
