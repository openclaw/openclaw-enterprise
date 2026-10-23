import type { InstalledGitMaterial } from "../repo/github/credentials/prepared-repository-git.ts";
import { createHash, randomUUID } from "node:crypto";
import type { Server } from "@grpc/grpc-js";
import type {
  RepositoryGitOnlineDecision,
  PreparedGitHubPullScope,
  PreparedGitHubInstallationUseRequest,
  PreparedGitHubUseRequest,
} from "@openclaw-enterprise/contracts";
import type { RequestHead } from "../repo/credentials/backend-contracts.ts";
import { decodePushedBranchRef } from "../repo/credentials/client-contracts.ts";
import { parseUnambiguousJson } from "../repo/credentials/json-members.ts";
import { planDraftPull } from "../repo/github/credentials/prepared-draft-pull.ts";
import { classifyRoute } from "../repo/github/credentials/routes/classification.ts";
import { allowsReceivePackInput } from "../repo/github/credentials/routes/receive-pack.ts";
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
    });

type Use = PreparedGitHubUseRequest | PreparedGitHubInstallationUseRequest;

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
} & (
    | {
        readonly approve?: never;
        readonly authorizeOnlineRequest: (
          request: Use,
          installed: InstalledGitMaterial,
          signal: AbortSignal,
        ) => Promise<RepositoryGitOnlineDecision>;
      }
    | {
        readonly authorizeOnlineRequest?: never;
        /** Compatibility with the separately selected broker-backed trial and its refusal reasons. */
        readonly approve: (
          request: PreparedGitHubUseRequest,
          installed: InstalledGitMaterial,
          signal: AbortSignal,
        ) => Promise<boolean | "draft_already_opened" | "access_withdrawn">;
      }
  );

/**
 * The reason the Agent's tool is shown for a refusal (finding 2149): OpenShell returns it as
 * `reason_code` in the 403 body, the draft helper prints it, and the worker log names it as
 * `reasonCode`. Each one names what the Agent can do, never a token, installation or host:
 * - `request_not_allowed`: the binding does not admit this request (another branch, ref or
 *   repository, a non-draft or other-base pull request, an API call). Do not retry it.
 * - `draft_already_opened`: the grant's one draft was already created (finding 2147).
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

function matchesOrigin(origin: string, request: OpenShellOnlineHttpRequest): boolean {
  const url = new URL(origin);
  return (
    url.origin === origin &&
    url.protocol === "https:" &&
    url.hostname === request.target.host &&
    Number(url.port || 443) === request.target.port
  );
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
    (binding.scope === "github-installation"
      ? /^[1-9][0-9]{0,15}$/.test(binding.installationId) &&
        binding.apiOrigin === "https://api.github.com" &&
        binding.installed.route?.revisionId === binding.executionId &&
        Number.isSafeInteger(binding.installed.route.fence) &&
        binding.installed.route.fence > 0
      : /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(binding.repository) &&
        !/\/(?:\.|\.\.)$/.test(binding.repository) &&
        typeof binding.pushRef === "string" &&
        decodePushedBranchRef(Buffer.from(binding.pushRef)) === binding.pushRef &&
        (binding.pullRequestBase === undefined ||
          (decodePushedBranchRef(Buffer.from("refs/heads/" + binding.pullRequestBase)) ===
            "refs/heads/" + binding.pullRequestBase &&
            "refs/heads/" + binding.pullRequestBase !== binding.pushRef)))
  );
}

function requestHead(request: OpenShellOnlineHttpRequest): RequestHead | undefined {
  const headers: Record<string, string> = Object.create(null);
  // Stock has already removed protected headers. Refuse unknown or repeated visible headers;
  // never interpret their absence as proof of original framing or authentication.
  const allowed = [
    "user-agent",
    "accept",
    "accept-encoding",
    "accept-language",
    "content-encoding",
    "content-type",
    "git-protocol",
    "pragma",
    "x-github-api-version",
  ];
  for (const [name, value] of request.headers) {
    if (
      !allowed.includes(name) ||
      Object.hasOwn(headers, name) ||
      (name === "accept-language" && value.length > 256) ||
      (name === "pragma" && value !== "no-cache") ||
      // Exactly one gzip layer; operation() admits it only where the body is never inspected.
      (name === "content-encoding" && value.toLowerCase() !== "gzip")
    ) {
      return undefined;
    }
    headers[name] = value;
  }
  return {
    method: request.target.method,
    rawTarget: request.target.path + (request.target.query ? "?" + request.target.query : ""),
    headers,
    receivedMonoMs: performance.now(),
    contentEncoding: headers["content-encoding"] === undefined ? "identity" : "gzip",
    // These lengths describe the complete buffered view, never the omitted original framing.
    framing: { kind: "length", bytes: request.body.byteLength },
  };
}

function draftScope(
  request: OpenShellOnlineHttpRequest,
  binding: RepositoryBinding,
  head: RequestHead,
): PreparedGitHubPullScope | undefined {
  const apiOrigin = binding.apiOrigin ?? "https://api.github.com";
  if (
    !binding.pullRequestBase ||
    !matchesOrigin(apiOrigin, request) ||
    request.body.byteLength > 64 * 1024 ||
    head.headers["git-protocol"] !== undefined ||
    (head.headers["x-github-api-version"] !== undefined &&
      head.headers["x-github-api-version"] !== "2026-03-10")
  ) {
    return undefined;
  }
  const json = parseUnambiguousJson(new TextDecoder("utf-8", { fatal: true }).decode(request.body));
  if (
    !json ||
    typeof json !== "object" ||
    Array.isArray(json) ||
    !("maintainer_can_modify" in json) ||
    json.maintainer_can_modify !== false
  ) {
    return undefined;
  }
  const { maintainer_can_modify: _, ...input } = json as Record<string, unknown>;
  // The ordinary broker canonicalizes. This authorizer cannot change bytes: require exactly
  // that canonical result, including the explicit restriction on maintainer modifications.
  const headers: Record<string, string> = { ...head.headers, "x-oce-operation-id": randomUUID() };
  delete headers["x-github-api-version"];
  let scope: PreparedGitHubPullScope | undefined;
  const plan = planDraftPull(
    { ...head, headers },
    {
      apiOrigin,
      repository: binding.repository,
      repositoryId: binding.repositoryId,
      head: binding.pushRef.slice("refs/heads/".length),
      base: binding.pullRequestBase,
    },
    (_plan, selected) => {
      scope = selected;
    },
  );
  if ("kind" in plan) {
    return undefined;
  }
  const verdict = plan.inputPolicy?.(Buffer.from(JSON.stringify(input)));
  return verdict &&
    typeof verdict === "object" &&
    "body" in verdict &&
    Buffer.from(verdict.body).equals(Buffer.from(request.body))
    ? scope
    : undefined;
}

/**
 * For an explicit installation grant, GitHub interprets the API operation and permissions.
 * Accept canonical repository and common discovery routes, not the App, token or owner API.
 * The supplier presents a normalized, complete request; hidden headers and original spelling
 * cannot establish credential placement or TLS. Those are prerequisites of release.
 */
function installationApiOperation(request: OpenShellOnlineHttpRequest, head: RequestHead) {
  const { path, query, method } = request.target;
  const { headers } = head;
  const graph = path === "/graphql";
  const read = method === "GET" || method === "HEAD";
  if (
    head.contentEncoding !== "identity" ||
    headers["git-protocol"] !== undefined ||
    (graph
      ? method !== "POST" || query !== ""
      : !/^\/(?:repos\/[\w-]+\/[\w.-]+(?:\/[\w.-]+)*|orgs\/[\w-]+(?:\/[\w.-]+)*|users\/[\w-]+(?:\/[\w.-]+)*|user(?:\/repos)?|installation\/repositories|search\/[\w-]+|rate_limit)$/.test(
          path,
        )) ||
    path.split("/").some((s) => s === "." || s === "..") ||
    (query !== "" && (!read || !validApiQuery(query))) ||
    (headers["x-github-api-version"] !== undefined &&
      !/^\d{4}-\d\d-\d\d$/.test(headers["x-github-api-version"])) ||
    request.body.byteLength > 64 * 1024
  ) {
    return;
  }
  if (!request.body.byteLength) {
    return graph ? undefined : "github-rest";
  }
  if (
    read ||
    !/^application\/(?:json|vnd\.github\+json)(?:;\s*charset=utf-8)?$/i.test(
      headers["content-type"] ?? "",
    )
  ) {
    return;
  }
  try {
    const body = parseUnambiguousJson(
      new TextDecoder("utf-8", { fatal: true }).decode(request.body),
    );
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return;
    }
    if (!graph) {
      return "github-rest";
    }
    return "query" in body && typeof body.query === "string" && body.query.trim()
      ? "github-graphql"
      : undefined;
  } catch {
    return;
  }
}

function validApiQuery(query: string) {
  const keys = new Set<string>();
  return query.split("&").every((part) => {
    const key = /^([\w-]{1,64})=(?:[\w.,:+/-]|%[a-fA-F\d]{2}){0,1024}$/.exec(part)?.[1];
    if (!key || keys.has(key)) {
      return false;
    }
    keys.add(key);
    return keys.size <= 32;
  });
}

type Selection =
  | {
      readonly selected: {
        readonly operation: Use["operation"];
        readonly pull?: PreparedGitHubPullScope;
      };
    }
  | { readonly denied: OpenShellOnlineGitDenialReason };

function operation(
  request: OpenShellOnlineHttpRequest,
  binding: OpenShellOnlineGitBinding,
  head: RequestHead,
): Selection {
  if (binding.scope === "github-installation") {
    if (matchesOrigin("https://api.github.com", request)) {
      const api = installationApiOperation(request, head);
      return api ? { selected: { operation: api } } : { denied: "route_unsupported" };
    }
    if (!matchesOrigin("https://github.com", request)) {
      return { denied: "origin_mismatch" };
    }
    // The operator granted the installation, not one named repository. Still require exactly a
    // smart HTTP request; GitHub owns repository membership, ref protection and token permissions.
    const repo = /^\/([a-zA-Z0-9_-]{1,100}\/[a-zA-Z0-9_.-]{1,100})(?:\.git)?\//.exec(
      request.target.path,
    )?.[1];
    return repo ? gitOperation(request, head, repo) : { denied: "route_unsupported" };
  }
  if (request.target.path.startsWith("/repos/")) {
    if (head.contentEncoding !== "identity") {
      return { denied: "encoding_unsupported" };
    }
    let pull: PreparedGitHubPullScope | undefined;
    try {
      pull = draftScope(request, binding, head);
    } catch {
      // Invalid UTF-8 or ambiguous JSON members: refused and logged like any other bad draft.
      pull = undefined;
    }
    return pull
      ? { selected: { operation: "create-draft-pull", pull } }
      : { denied: "draft_rejected" };
  }
  if (
    !matchesOrigin(binding.gitOrigin ?? "https://github.com", request) ||
    head.headers["x-github-api-version"] !== undefined
  ) {
    return { denied: "origin_mismatch" };
  }
  return gitOperation(request, head, binding.repository, binding.pushRef);
}

function gitOperation(
  request: OpenShellOnlineHttpRequest,
  head: RequestHead,
  repository: string,
  pushRef?: string,
): Selection {
  const route = classifyRoute(head, {
    repository,
    profile: "git-ref-write",
    targetBytes: 8192,
    graphql: "deny",
  });
  if (!route || route.kind === "api") {
    return { denied: "route_unsupported" };
  }
  // Git gzips upload-pack bodies over 1024 bytes. That body is opaque here (only its size is
  // bounded, and the digest binds the encoded bytes), so gzip is admitted there alone. Discovery
  // has no body; receive-pack and draft create bodies are inspected, so they stay identity.
  if (head.contentEncoding !== "identity" && route.kind !== "git-fetch") {
    return { denied: "encoding_unsupported" };
  }
  if (route.kind === "git-discovery") {
    if (request.body.byteLength !== 0 || head.headers["content-type"] !== undefined) {
      return { denied: "discovery_body" };
    }
    return {
      selected: {
        operation: route.effect === "write" ? "advertise-receive-pack" : "advertise-upload-pack",
      },
    };
  }
  if (!request.body.byteLength) {
    return { denied: "body_empty" };
  }
  if (route.kind === "git-fetch") {
    // Never parse or trust this body: it may be gzip, and the upstream decides what it means.
    return request.body.byteLength <= 1024 * 1024
      ? { selected: { operation: "upload-pack" } }
      : { denied: "body_too_large" };
  }
  // The complete body is bounded at 4 MiB in httpRequestView, before this classification.
  // Installation access deliberately has no OCE ref filter. GitHub validates the pack and refs.
  return pushRef === undefined || allowsReceivePackInput([pushRef])(request.body) === true
    ? { selected: { operation: "receive-pack" } }
    : { denied: "ref_not_allowed" };
}

/** Authorize the stock sender's inspected request. The worker separately verifies installation
 * and delivers material; an allow here records possible use, never a successful send. */
export function createOpenShellOnlineGitAuthority(
  options: OpenShellOnlineGitAuthorityOptions,
): Server {
  if (
    typeof options.lookupBinding !== "function" ||
    typeof (options.authorizeOnlineRequest ?? options.approve) !== "function"
  ) {
    throw new Error("OpenShell Git requires live binding and durable approval owners.");
  }
  return createOpenShellOnlineHttpAuthority({
    ...options,
    async authorize(request, signal) {
      const { sandboxId, bindingId, requestId, workspace } = request;
      if (options.previewDenial && request.target.path.startsWith("/oce-observe-request/")) {
        return { reasonCode: options.previewDenial(request) ?? "preview_challenge_refused" };
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
      const head = requestHead(request);
      if (!head) {
        return deny("request_invalid");
      }
      const selection = operation(request, binding, head);
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
      if (binding.scope === "github-installation") {
        if (selected.operation === "create-draft-pull" || !options.authorizeOnlineRequest) {
          return deny("binding_mismatch");
        }
        q = {
          ...use,
          scope: binding.scope,
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
      let allowed: boolean | "draft_already_opened" | "access_withdrawn";
      try {
        if (options.authorizeOnlineRequest) {
          const result = await options.authorizeOnlineRequest(q, installed, signal);
          if (result.kind === "denied") {
            allowed = result.reason !== "unavailable" && result.reason;
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
        } else {
          allowed = !("scope" in q) && (await options.approve(q, installed, signal));
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
      if (allowed !== true) {
        return deny("approval_denied", selected.operation);
      }
      return signal.aborted ? deny("aborted", selected.operation) : "allow";
    },
  });
}
