import { createHash, randomUUID } from "node:crypto";
import type { Server } from "@grpc/grpc-js";
import type {
  PreparedGitHubPullScope,
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

export interface OpenShellOnlineGitBinding {
  readonly sandboxId: string;
  readonly bindingId: string;
  readonly workspace: string;
  /** A live, exclusively owned execution mapped by the runtime, absent from the stock JWT. */
  readonly executionId: string;
  readonly sessionId: string;
  readonly providerInstanceId: string;
  readonly repositoryId: string;
  readonly grantId: string;
  readonly repository: string;
  readonly pushRef: string;
  readonly pullRequestBase?: string;
  readonly gitOrigin?: string;
  readonly apiOrigin?: string;
  readonly installed: {
    readonly preparationAttemptId: string;
    readonly materialVersion: string;
  };
}

export interface OpenShellOnlineGitAuthorityOptions extends Omit<
  OpenShellOnlineHttpAuthorityOptions,
  "authorize"
> {
  /** Resolve exactly one live admitted workspace/execution from the authenticated sandbox and
   * binding. Require a never-reused sandbox identity dedicated to that execution. Recheck
   * replacement fencing, mandatory final middleware, TLS-only routing and the
   * installed provider generation. Neither RPC config nor workspace metadata is this proof. */
  readonly lookupBinding: (
    identity: OpenShellOnlineGitIdentity,
    signal: AbortSignal,
  ) => Promise<OpenShellOnlineGitBinding | undefined>;
  /** Check live session/grant/material in one transaction. For draft creates, durably consume
   * ONE submission per grant before returning true, including uncertain/expired permits. Never
   * retry on a lost acknowledgement. This records possible use, not a provider outcome. */
  readonly approve: (
    request: PreparedGitHubUseRequest,
    expectedInstalled: OpenShellOnlineGitBinding["installed"],
    signal: AbortSignal,
  ) => Promise<boolean>;
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
      binding.repositoryId,
      binding.grantId,
      binding.installed?.preparationAttemptId,
      binding.installed?.materialVersion,
    ].every((id) => typeof id === "string" && /^[\x21-\x7e]{1,256}$/.test(id)) &&
    /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(binding.repository) &&
    !/\/(?:\.|\.\.)$/.test(binding.repository) &&
    typeof binding.pushRef === "string" &&
    decodePushedBranchRef(Buffer.from(binding.pushRef)) === binding.pushRef &&
    (binding.pullRequestBase === undefined ||
      (decodePushedBranchRef(Buffer.from("refs/heads/" + binding.pullRequestBase)) ===
        "refs/heads/" + binding.pullRequestBase &&
        "refs/heads/" + binding.pullRequestBase !== binding.pushRef))
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
      (name === "pragma" && value !== "no-cache")
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
    contentEncoding: "identity",
    // These lengths describe the complete buffered view, never the omitted original framing.
    framing: { kind: "length", bytes: request.body.byteLength },
  };
}

function draftScope(
  request: OpenShellOnlineHttpRequest,
  binding: OpenShellOnlineGitBinding,
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

function operation(
  request: OpenShellOnlineHttpRequest,
  binding: OpenShellOnlineGitBinding,
  head: RequestHead,
): Pick<PreparedGitHubUseRequest, "operation" | "pull"> | undefined {
  if (request.target.path.startsWith("/repos/")) {
    const pull = draftScope(request, binding, head);
    return pull ? { operation: "create-draft-pull", pull } : undefined;
  }
  if (
    !matchesOrigin(binding.gitOrigin ?? "https://github.com", request) ||
    head.headers["x-github-api-version"] !== undefined
  ) {
    return undefined;
  }
  const route = classifyRoute(head, {
    repository: binding.repository,
    profile: "git-ref-write",
    targetBytes: 8192,
    graphql: "deny",
  });
  if (!route || route.kind === "api") {
    return undefined;
  }
  if (route.kind === "git-discovery") {
    if (request.body.byteLength !== 0 || head.headers["content-type"] !== undefined) {
      return undefined;
    }
    return {
      operation: route.effect === "write" ? "advertise-receive-pack" : "advertise-upload-pack",
    };
  }
  if (!request.body.byteLength) {
    return undefined;
  }
  if (route.kind === "git-fetch") {
    return request.body.byteLength <= 1024 * 1024 ? { operation: "upload-pack" } : undefined;
  }
  return allowsReceivePackInput([binding.pushRef])(request.body) === true
    ? { operation: "receive-pack" }
    : undefined;
}

/** Authorize the stock sender's inspected request. The worker separately verifies installation
 * and delivers material; an allow here records possible use, never a successful send. */
export function createOpenShellOnlineGitAuthority(
  options: OpenShellOnlineGitAuthorityOptions,
): Server {
  if (typeof options.lookupBinding !== "function" || typeof options.approve !== "function") {
    throw new Error("OpenShell Git requires live binding and durable approval owners.");
  }
  return createOpenShellOnlineHttpAuthority({
    ...options,
    async authorize(request, signal) {
      const { sandboxId, bindingId, requestId, workspace } = request;
      const binding = await options.lookupBinding(
        { sandboxId, bindingId, requestId, workspace },
        signal,
      );
      if (signal.aborted || !binding || !validBinding(binding, request)) {
        return "deny";
      }
      const head = requestHead(request);
      const selected = head && operation(request, binding, head);
      if (!selected || signal.aborted) {
        return "deny";
      }
      const { sessionId, providerInstanceId, repositoryId, grantId, pushRef, executionId } =
        binding;
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
            repositoryId,
            grantId,
            pushRef,
            request.target,
            request.headers,
          ]),
        )
        .update(Buffer.from([0]))
        .update(request.body)
        .digest("hex");
      const allowed = await options.approve(
        {
          sessionId,
          providerInstanceId,
          repositoryId,
          grantId,
          pushRef,
          ...selected,
          exchangeId: randomUUID(),
          requestDigestSha256,
          deadlineAt: request.deadlineAt,
        },
        {
          preparationAttemptId: binding.installed.preparationAttemptId,
          materialVersion: binding.installed.materialVersion,
        },
        signal,
      );
      return allowed === true && !signal.aborted ? "allow" : "deny";
    },
  });
}
