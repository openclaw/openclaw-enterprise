import { createHash, randomUUID } from "node:crypto";
import type {
  GitHubRequestDecision,
  GitHubRequestOperation,
  GitHubRequestReasonCode,
  GitHubRequestRefusal as Refusal,
  GitHubRequestView,
  PreparedGitHubInstallationUseRequest,
  PreparedGitHubRepositoryUseRequest,
  PreparedGitHubUseRequest,
  ProtectedGitHubInstallationMaterial,
  ProtectedGitHubRepositoryMaterial,
  ProtectedRepositoryGitAuthority,
  ProtectedRepositoryGitMaterial,
  RepositoryGitInstallationFence,
  RepositoryGitOnlineDecision,
  RepositoryGitRequests,
  RepositoryGitSendDecision,
} from "@openclaw-enterprise/contracts";
import {
  decodePushedBranchRef,
  hasControlCharacter,
  normalizePushRefAllowlist,
} from "../../access/client-contracts.ts";
import type { InstalledGitMaterial } from "./prepared-repository-git.ts";
import { selectGitHubRequest } from "./routes/request-selection.ts";

// OCE's one decision for a protected GitHub request, shared by every sender: classify it for
// the binding, record one possible use with the authority and check the answer against this
// exact request and material. The bundled OpenShell route calls decideGitHubRequest from its
// request hook; an installed Driver package receives createRepositoryGitRequests(authority)
// from the Worker at bind time. Classification is routes/request-selection.ts; the durable
// checks are the authority's.

/** The refusals decideGitHubRequest gives; the requests port adds `material_unavailable`. */
export type GitHubRequestRefusal = Exclude<Refusal, "material_unavailable">;

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
  Record<Refusal, GitHubRequestReasonCode | undefined>
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
  material_unavailable: "route_not_ready",
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

type Material =
  | ProtectedRepositoryGitMaterial
  | ProtectedGitHubRepositoryMaterial
  | ProtectedGitHubInstallationMaterial;

/** One scope's read and authorize calls, as the three ports share them. */
type Port = {
  readMaterial(
    route: RepositoryGitInstallationFence,
    signal: AbortSignal,
  ): Promise<Material | { readonly absent: "withdrawn" | "unprepared" } | undefined>;
  authorize(
    request: Use,
    installed: InstalledGitMaterial & { readonly route: RepositoryGitInstallationFence },
    signal: AbortSignal,
  ): Promise<
    | (AllowedDecision &
        Partial<Readonly<{ scope: string; operation: string; revisionId: string; fence: number }>>)
    | Extract<RepositoryGitOnlineDecision, { kind: "denied" }>
  >;
};

const methods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const transportHeaders = new Set([
  "authorization",
  "proxy-authorization",
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "expect",
]);

/** The bounds the bundled route's wire view applies before classification. */
function boundedView(request: GitHubRequestView): boolean {
  const { target, headers, body } = request;
  if (
    !target ||
    typeof target.host !== "string" ||
    target.host.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(
      target.host,
    ) ||
    !Number.isInteger(target.port) ||
    target.port < 1 ||
    target.port > 65535 ||
    !methods.has(target.method) ||
    typeof target.path !== "string" ||
    !/^\/[\x21-\x7e]{0,4095}$/.test(target.path) ||
    /[?#]/.test(target.path) ||
    typeof target.query !== "string" ||
    !/^[\x21-\x7e]{0,4096}$/.test(target.query) ||
    !(body instanceof Uint8Array) ||
    body.byteLength > 4 * 1024 * 1024 ||
    !Array.isArray(headers) ||
    headers.length > 128
  ) {
    return false;
  }
  let bytes = 0;
  for (const header of headers) {
    const [name, value] = Array.isArray(header) ? header : [];
    if (
      typeof name !== "string" ||
      !/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name) ||
      // The sender owns credential placement, the connection and framing.
      transportHeaders.has(name) ||
      name.startsWith("proxy-") ||
      typeof value !== "string" ||
      hasControlCharacter(value) ||
      value.trim() !== value
    ) {
      return false;
    }
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (bytes > 64 * 1024) {
      return false;
    }
  }
  return true;
}

function bindingFor(
  material: Material,
  route: RepositoryGitInstallationFence,
): GitHubRequestBinding {
  const { sessionId, providerInstanceId, grantId, preparationAttemptId, materialVersion } =
    material;
  const identity = {
    executionId: route.revisionId,
    sessionId,
    providerInstanceId,
    grantId,
    installed: { route, preparationAttemptId, materialVersion },
  };
  if ("scope" in material) {
    return material.scope === "github-repository"
      ? {
          ...identity,
          scope: material.scope,
          installationId: material.installationId,
          apiOrigin: material.apiOrigin,
          repositories: material.repositories,
        }
      : {
          ...identity,
          scope: material.scope,
          installationId: material.installationId,
          apiOrigin: material.apiOrigin,
        };
  }
  return {
    ...identity,
    repositoryId: material.repositoryId,
    repository: material.repository,
    pushRef: material.pushRef,
    ...(material.pullRequestBase && { pullRequestBase: material.pullRequestBase }),
    apiOrigin: material.apiOrigin,
  };
}

const gitOperations: ReadonlySet<GitHubRequestOperation> = new Set([
  "advertise-upload-pack",
  "upload-pack",
  "advertise-receive-pack",
  "receive-pack",
]);

/**
 * OCE's request authorization for an installed sender or injector, bound to the Worker's
 * authority. The token appears only in the returned header value. Whether the material was
 * prepared ahead or is minted for this request stays behind `readMaterial`.
 */
export function createRepositoryGitRequests(
  authority: ProtectedRepositoryGitAuthority,
): RepositoryGitRequests {
  return Object.freeze({
    async authorize(
      input: Parameters<RepositoryGitRequests["authorize"]>[0],
    ): Promise<GitHubRequestDecision> {
      const { route, profile, authorization, request, signal } = input;
      const refuse = (
        refusal: Refusal,
        operation?: GitHubRequestOperation,
      ): GitHubRequestDecision => {
        const reasonCode = githubRequestReasonCodes[refusal];
        return {
          kind: "refused",
          refusal,
          ...(reasonCode === undefined ? {} : { reasonCode }),
          ...(operation === undefined ? {} : { operation }),
        };
      };
      const deadlineAt = input.deadlineAt ?? new Date(Date.now() + 10_000).toISOString();
      const scope =
        profile === "github_repository"
          ? "github-repository"
          : profile === "github_installation"
            ? "github-installation"
            : profile === "repository_git"
              ? undefined
              : null;
      const mode =
        authorization === "online-request"
          ? authority.online
          : authorization === "exact-dispatch"
            ? authority
            : undefined;
      if (
        scope === null ||
        !mode ||
        !route ||
        typeof route.revisionId !== "string" ||
        !Number.isSafeInteger(route.fence) ||
        !Number.isFinite(Date.parse(deadlineAt)) ||
        !boundedView(request)
      ) {
        return refuse("request_invalid");
      }
      if (signal.aborted) {
        return refuse("aborted");
      }
      const port = (
        scope === "github-repository"
          ? mode.githubRepository
          : scope === "github-installation"
            ? mode.githubInstallation
            : mode
      ) as Port | undefined;
      if (!port) {
        return refuse("material_unavailable");
      }
      let material: Awaited<ReturnType<Port["readMaterial"]>>;
      try {
        material = await port.readMaterial(route, signal);
      } catch {
        material = undefined;
      }
      if (material && "absent" in material && material.absent === "withdrawn") {
        return refuse("session_closed");
      }
      if (
        !material ||
        "absent" in material ||
        ("scope" in material ? material.scope : undefined) !== scope ||
        !(Date.now() < Date.parse(material.expiresAt))
      ) {
        return refuse("material_unavailable");
      }
      const binding = bindingFor(material, route);
      if (!validGitHubRequestBinding(binding)) {
        return refuse("binding_mismatch");
      }
      const outcome = await decideGitHubRequest({
        request,
        binding,
        deadlineAt,
        signal,
        expect: authorization === "online-request" ? "allow" : "permit",
        requestDigest: () =>
          createHash("sha256")
            .update(
              JSON.stringify([
                "oce-github-request-v1",
                route.revisionId,
                route.fence,
                binding.sessionId,
                binding.providerInstanceId,
                binding.grantId,
                binding.scope ? [binding.scope, binding.installationId] : binding.repositoryId,
                binding.scope ? route.fence : binding.pushRef,
                request.target,
                request.headers,
              ]),
            )
            .update(Buffer.from([0]))
            .update(request.body)
            .digest("hex"),
        authorize: async (q, installed, signal) => {
          const result = await port.authorize(q, { ...installed, route }, signal);
          // An installation-scope answer names its scope, operation and recipient fence.
          if (
            result.kind !== "denied" &&
            "scope" in q &&
            q.scope === "github-installation" &&
            !(
              result.scope === q.scope &&
              result.operation === q.operation &&
              result.revisionId === route.revisionId &&
              result.fence === route.fence
            )
          ) {
            return { kind: "denied", reason: "unavailable" };
          }
          return result;
        },
      });
      if (outcome.kind === "refused") {
        return refuse(outcome.refusal, outcome.operation);
      }
      const { decision, operation } = outcome;
      const sendBy = decision.kind === "allow" ? decision.replyBy : decision.sendStartBy;
      if (!(Date.now() < Date.parse(sendBy))) {
        return refuse("approval_denied", operation);
      }
      return {
        kind: "allow",
        operation,
        sendBy,
        inject: {
          name: "authorization",
          value: gitOperations.has(operation)
            ? "Basic " + Buffer.from("x-access-token:" + material.value).toString("base64")
            : "Bearer " + material.value,
        },
      };
    },
  });
}
