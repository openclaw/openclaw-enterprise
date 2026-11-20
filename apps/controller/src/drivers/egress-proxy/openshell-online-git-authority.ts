import {
  HARNESS_GIT_PROBE_PREFIX,
  HARNESS_REPOSITORY_GIT_PROBE_HEADER,
} from "../compute/harness-egress-enrollment.ts";
import type { InstalledGitMaterial } from "../repo/github/access/prepared-repository-git.ts";
import { createHash } from "node:crypto";
import type { Server } from "@grpc/grpc-js";
import type {
  RepositoryGitOnlineDecision,
  PreparedGitHubInstallationUseRequest,
  PreparedGitHubRepositoryUseRequest,
  PreparedGitHubUseRequest,
} from "@openclaw-enterprise/contracts";
import {
  decideGitHubRequest,
  githubRequestReasonCodes,
  validGitHubRequestBinding,
  type GitHubRequestBinding,
  type GitHubRequestRefusal,
} from "../repo/github/access/protected-requests.ts";
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

/** The shared request binding, attributed to one authenticated sandbox binding. */
export type OpenShellOnlineGitBinding = GitHubRequestBinding & {
  readonly sandboxId: string;
  readonly bindingId: string;
  readonly workspace: string;
};

type Use =
  | PreparedGitHubUseRequest
  | PreparedGitHubInstallationUseRequest
  | PreparedGitHubRepositoryUseRequest;

export type OpenShellOnlineGitAuthorityOptions = Omit<
  OpenShellOnlineHttpAuthorityOptions,
  "authorize"
> & {
  /** Only a binding using synthetic probe paths reserves the legacy prefix. */
  readonly reservesLegacyProbePath?: (identity: OpenShellOnlineGitIdentity) => boolean;
  /** This branch can only refuse a startup challenge, never authorize Git. */
  readonly previewDenial?: (request: OpenShellOnlineHttpRequest) => string | undefined;
  /** Resolve exactly one live admitted workspace/execution from the authenticated sandbox and
   * binding. A retained Sandbox needs a fresh binding for each admitted execution. Recheck
   * revision ownership, the revision’s admitted middleware assurance, TLS-only routing and the
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
export type OpenShellOnlineGitDenialReason = GitHubRequestRefusal;

export interface OpenShellOnlineGitDenial {
  readonly reason: OpenShellOnlineGitDenialReason;
  /** The reason code the supervisor shows the Agent, when it is not the generic one. */
  readonly reasonCode?: OpenShellOnlineGitReasonCode;
  readonly sandboxId: string;
  readonly requestId: string;
  readonly revisionId: string;
  readonly operation?: Use["operation"];
}

function validBinding(
  binding: OpenShellOnlineGitBinding,
  request: OpenShellOnlineHttpRequest,
): boolean {
  return (
    binding.sandboxId === request.sandboxId &&
    binding.bindingId === request.bindingId &&
    binding.workspace === request.workspace &&
    validGitHubRequestBinding(binding)
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
      const identity = { sandboxId, bindingId, requestId, workspace };
      if (
        request.headers.some(([name]) => name === HARNESS_REPOSITORY_GIT_PROBE_HEADER) ||
        (HARNESS_GIT_PROBE_PREFIX.test(request.target.path) &&
          options.reservesLegacyProbePath?.(identity))
      ) {
        return {
          reasonCode: options.previewDenial?.(request) ?? "preview_challenge_refused",
        };
      }
      const binding = await options.lookupBinding(identity, signal);
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
        const reasonCode = githubRequestReasonCodes[reason];
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
      const outcome = await decideGitHubRequest({
        request,
        binding,
        deadlineAt: request.deadlineAt,
        signal,
        // Bind the authenticated mapping and the full inspected view. Do not accept a caller's
        // digest or confuse this normalized-view digest with an exact original-wire commitment.
        requestDigest: () =>
          createHash("sha256")
            .update(
              JSON.stringify([
                "openshell-git-v1",
                sandboxId,
                bindingId,
                requestId,
                workspace,
                binding.executionId,
                binding.sessionId,
                binding.providerInstanceId,
                binding.scope ? [binding.scope, binding.installationId] : binding.repositoryId,
                binding.grantId,
                binding.scope ? binding.installed.route!.fence : binding.pushRef,
                request.target,
                request.headers,
              ]),
            )
            .update(Buffer.from([0]))
            .update(request.body)
            .digest("hex"),
        authorize: (q, installed, signal) => options.authorizeOnlineRequest(q, installed, signal),
      });
      if (outcome.kind === "allowed") {
        // The RPC owner checks this exact authority deadline at its final allow callback.
        // A supervisor that has received the allow may finish the request after withdrawal.
        return { kind: "allow", replyBy: outcome.replyBy };
      }
      return deny(outcome.refusal, outcome.operation);
    },
  });
}
