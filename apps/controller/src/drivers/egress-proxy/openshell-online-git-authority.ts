import { HARNESS_GIT_PROBE_PREFIX } from "../compute/harness-egress-enrollment.ts";
import type { InstalledGitMaterial } from "../repo/github/credentials/prepared-repository-git.ts";
import { createHash, randomUUID } from "node:crypto";
import type { Server } from "@grpc/grpc-js";
import type {
  RepositoryGitOnlineDecision,
  PreparedGitHubInstallationUseRequest,
  PreparedGitHubRepositoryUseRequest,
  PreparedGitHubUseRequest,
} from "@openclaw-enterprise/contracts";
import {
  decodePushedBranchRef,
  normalizePushRefAllowlist,
} from "../repo/credentials/client-contracts.ts";
import { selectGitHubRequest } from "../repo/github/credentials/routes/request-selection.ts";
import {
  createOpenShellOnlineHttpAuthority,
  type OpenShellOnlineDecision,
  type OpenShellOnlineHttpAuthorityOptions,
  type OpenShellOnlineHttpRequest,
} from "./openshell-online-authority.ts";

export interface OpenShellOnlineGitIdentity {
  readonly sandboxId: string;
  readonly bindingId: string;
  readonly requestId: string;
  /** Display metadata only; compare with the workspace in the trusted sandbox mapping. */
  readonly workspace: string;
}

type GitBindingIdentity = {
  readonly sandboxId: string;
  readonly bindingId: string;
  readonly workspace: string;
  /** A live, exclusively owned execution mapped by the runtime, absent from the stock JWT. */
  readonly executionId: string;
  readonly sessionId: string;
  readonly providerInstanceId: string;
  readonly grantId: string;
  readonly installed: InstalledGitMaterial;
};

type RepositoryBinding = GitBindingIdentity & {
  readonly scope?: never;
  readonly repositoryId: string;
  readonly repository: string;
  readonly pushRef: string;
  readonly pullRequestBase?: string;
  readonly gitOrigin?: string;
  readonly apiOrigin?: string;
};

export type OpenShellOnlineGitBinding =
  | RepositoryBinding
  | (GitBindingIdentity & {
      readonly scope: "github-installation";
      readonly installationId: string;
      readonly apiOrigin: string;
    })
  | (GitBindingIdentity & {
      readonly scope: "github-repository";
      readonly installationId: string;
      readonly apiOrigin: string;
      readonly repositories: readonly Readonly<{
        repositoryId: string;
        repository: string;
      }>[];
    });

type Use =
  | PreparedGitHubUseRequest
  | PreparedGitHubInstallationUseRequest
  | PreparedGitHubRepositoryUseRequest;

export type OpenShellOnlineGitAuthorityOptions = Omit<
  OpenShellOnlineHttpAuthorityOptions,
  "authorize"
> & {
  /** This branch can only refuse the reserved pre-material challenge, never authorize Git. */
  readonly previewDenial?: (request: OpenShellOnlineHttpRequest) => string | undefined;
  /** Resolve exactly one live admitted workspace/execution from the authenticated sandbox and
   * binding. Require a never-reused sandbox identity dedicated to that execution. Recheck
   * replacement fencing, the revision’s admitted middleware assurance, TLS-only routing and the
   * installed provider generation. Neither RPC config nor workspace metadata is this proof. */
  readonly lookupBinding: (
    identity: OpenShellOnlineGitIdentity,
    signal: AbortSignal,
  ) => Promise<OpenShellOnlineGitBinding | OpenShellOnlineGitRefusal | undefined>;
  /** Told once per request the authority itself refuses, with the reason class (finding 2133).
   * A request with no live binding is the lookup's to report. Never the request's content. */
  readonly onDeny?: (denial: OpenShellOnlineGitDenial) => void;
  readonly authorizeOnlineRequest: (
    request: Use,
    installed: InstalledGitMaterial,
    signal: AbortSignal,
  ) => Promise<RepositoryGitOnlineDecision>;
};

/**
 * The reason the Agent's tool is shown for a refusal (finding 2149): OpenShell returns it as
 * `reason_code` in the 403 body, the draft helper prints it, and the worker log names it as
 * `reasonCode`. Each one names what the Agent can do, never a token, installation or host:
 * - `request_not_allowed`: the binding does not admit this request (another branch, ref or
 *   repository, a non-draft or other-base pull request, an API call). Do not retry it.
 * - `draft_already_opened`: the grant's draft-create allowance was spent; this does not confirm creation.
 * - `access_withdrawn`: this Agent version's repository access ended (binding removed,
 *   version replaced or stopped). Do not retry; an operator rebinds and deploys.
 * - `credential_unavailable`: the route lost its credential (for example the App key was
 *   rejected). Retrying does not help until an operator recovers it.
 * - `route_blocked`: the worker closed this version's route for good; a new version reopens it.
 * - `route_not_ready`: the route is starting, verifying or briefly unavailable. Retry shortly.
 * A request the worker cannot attribute to a live binding keeps the generic
 * `online_authorization_denied`.
 */
export type OpenShellOnlineGitReasonCode =
  | "request_not_allowed"
  | "draft_already_opened"
  | "access_withdrawn"
  | "credential_unavailable"
  | "route_blocked"
  | "route_not_ready";

/** A lookup refusal for a request the worker attributed to one of its bindings. */
export interface OpenShellOnlineGitRefusal {
  readonly refused: OpenShellOnlineGitReasonCode;
}

/** Why the authority refused a request it could attribute to a live binding, or a request
 * whose shape it rejected before approval. */
export type OpenShellOnlineGitDenialReason =
  | "binding_mismatch"
  | "request_invalid"
  | "encoding_unsupported"
  | "draft_rejected"
  | "origin_mismatch"
  | "route_unsupported"
  | "discovery_body"
  | "body_empty"
  | "body_too_large"
  | "ref_not_allowed"
  | "approval_denied"
  | "approval_failed"
  | "draft_already_opened"
  | "session_closed"
  | "aborted";

/** What the Agent is told for each authority denial; binding_mismatch stays generic. */
const reasonCodes: Readonly<
  Record<OpenShellOnlineGitDenialReason, OpenShellOnlineGitReasonCode | undefined>
> = {
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
};

export interface OpenShellOnlineGitDenial {
  readonly reason: OpenShellOnlineGitDenialReason;
  /** The reason code the supervisor shows the Agent, when it is not the generic one. */
  readonly reasonCode?: OpenShellOnlineGitReasonCode;
  readonly sandboxId: string;
  readonly requestId: string;
  readonly revisionId: string;
  readonly operation?: Use["operation"];
}

function validPushRefPolicy(pushRef: string): boolean {
  try {
    return normalizePushRefAllowlist([pushRef])[0] === pushRef;
  } catch {
    return false;
  }
}

function validBinding(
  binding: OpenShellOnlineGitBinding,
  request: OpenShellOnlineHttpRequest,
): boolean {
  return (
    binding.sandboxId === request.sandboxId &&
    binding.bindingId === request.bindingId &&
    binding.workspace === request.workspace &&
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

/** Authorize the stock sender's inspected request. The worker separately verifies installation
 * and delivers material; an allow here records possible use, never a successful send. */
export function createOpenShellOnlineGitAuthority(
  options: OpenShellOnlineGitAuthorityOptions,
): Server {
  if (
    typeof options.lookupBinding !== "function" ||
    typeof options.authorizeOnlineRequest !== "function"
  ) {
    throw new Error("OpenShell Git requires live binding and durable approval owners.");
  }
  return createOpenShellOnlineHttpAuthority({
    ...options,
    async authorize(request, signal) {
      const { sandboxId, bindingId, requestId, workspace } = request;
      if (options.previewDenial && HARNESS_GIT_PROBE_PREFIX.test(request.target.path)) {
        return {
          reasonCode: options.previewDenial(request) ?? "preview_challenge_refused",
        };
      }
      const binding = await options.lookupBinding(
        { sandboxId, bindingId, requestId, workspace },
        signal,
      );
      if (!binding) {
        return "deny";
      }
      if ("refused" in binding) {
        // The lookup reported this denial with its own reason; tell the Agent the class.
        return { reasonCode: binding.refused };
      }
      const deny = (
        reason: OpenShellOnlineGitDenialReason,
        selected?: Use["operation"],
      ): OpenShellOnlineDecision => {
        const reasonCode = reasonCodes[reason];
        options.onDeny?.({
          reason,
          ...(reasonCode === undefined ? {} : { reasonCode }),
          sandboxId,
          requestId,
          revisionId: binding.executionId,
          ...(selected === undefined ? {} : { operation: selected }),
        });
        return reasonCode === undefined ? "deny" : { reasonCode };
      };
      if (signal.aborted) {
        return deny("aborted");
      }
      if (!validBinding(binding, request)) {
        return deny("binding_mismatch");
      }
      const selection = selectGitHubRequest(request, binding, randomUUID);
      if ("denied" in selection) {
        return deny(selection.denied);
      }
      const { selected } = selection;
      if (signal.aborted) {
        return deny("aborted", selected.operation);
      }
      const { sessionId, providerInstanceId, grantId, executionId } = binding;
      // Bind the authenticated mapping and the full inspected view. Do not accept a caller's
      // digest or confuse this normalized-view digest with an exact original-wire commitment.
      const requestDigestSha256 = createHash("sha256")
        .update(
          JSON.stringify([
            "openshell-git-v1",
            sandboxId,
            bindingId,
            requestId,
            workspace,
            executionId,
            sessionId,
            providerInstanceId,
            binding.scope ? [binding.scope, binding.installationId] : binding.repositoryId,
            grantId,
            binding.scope ? binding.installed.route!.fence : binding.pushRef,
            request.target,
            request.headers,
          ]),
        )
        .update(Buffer.from([0]))
        .update(request.body)
        .digest("hex");
      const use = {
        sessionId,
        providerInstanceId,
        grantId,
        exchangeId: randomUUID(),
        requestDigestSha256,
        deadlineAt: request.deadlineAt,
      };
      let q: Use;
      if (binding.scope !== undefined) {
        if (selected.operation === "create-draft-pull") {
          return deny("binding_mismatch");
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
          return deny("binding_mismatch");
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
      let allowed: false | "draft_already_opened" | "access_withdrawn";
      try {
        const result = await options.authorizeOnlineRequest(q, installed, signal);
        if (result.kind === "denied") {
          const { reason } = result;
          allowed =
            reason === "draft_already_opened" || reason === "access_withdrawn" ? reason : false;
        } else if (
          result.kind === "allow" &&
          !signal.aborted &&
          result.exchangeId === q.exchangeId &&
          result.requestDigestSha256 === requestDigestSha256 &&
          result.materialVersion === installed.materialVersion &&
          result.preparationAttemptId === installed.preparationAttemptId &&
          Date.parse(result.replyBy) <= Date.parse(request.deadlineAt)
        ) {
          // The RPC owner checks this exact authority deadline at its final allow callback.
          // A supervisor that has received the allow may finish the request after withdrawal.
          return { kind: "allow", replyBy: result.replyBy };
        } else {
          allowed = false;
        }
      } catch {
        // The owner did not answer. Possible use may have committed; deny without retry.
        return deny("approval_failed", selected.operation);
      }
      if (allowed === "draft_already_opened" || allowed === "access_withdrawn") {
        if (signal.aborted) {
          return deny("aborted", selected.operation);
        }
        // The grant's one draft create was already used (finding 2147), or the session ended.
        // The Agent is told which; nothing about the earlier draft or the session is disclosed.
        return deny(
          allowed === "access_withdrawn" ? "session_closed" : "draft_already_opened",
          selected.operation,
        );
      }
      return deny("approval_denied", selected.operation);
    },
  });
}
