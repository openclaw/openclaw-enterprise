import type {
  PreparedGitHubPullScope,
  PreparedGitHubInstallationUseRequest,
  PreparedGitHubRepositoryUseRequest,
  PreparedGitHubUseRequest,
} from "@openclaw-enterprise/contracts";
import type { RequestHead } from "../../../credentials/backend-contracts.ts";
import { parseUnambiguousJson } from "../../../credentials/json-members.ts";
import { planDraftPull } from "../prepared-draft-pull.ts";
import { classifyRoute } from "./classification.ts";
import { allowsGraphqlInput } from "../graphql-input.ts";
import { allowsReceivePackInput } from "./receive-pack.ts";

/** A validated HTTPS request view; transport validation remains with the caller. */
type GitHubRequest = {
  readonly target: {
    readonly reportedScheme: "https";
    readonly host: string;
    readonly port: number;
    readonly method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
    readonly path: string;
    readonly query: string;
  };
  readonly headers: readonly (readonly [string, string])[];
  readonly body: Uint8Array;
};

type RepositoryScope = {
  readonly scope?: never;
  readonly repositoryId: string;
  readonly repository: string;
  readonly pushRef: string;
  readonly pullRequestBase?: string;
  readonly gitOrigin?: string;
  readonly apiOrigin?: string;
};

type GitHubScope =
  | RepositoryScope
  | { readonly scope: "github-installation" }
  | {
      readonly scope: "github-repository";
      readonly repositories: readonly Readonly<{ repository: string }>[];
    };

type Use =
  | PreparedGitHubUseRequest
  | PreparedGitHubInstallationUseRequest
  | PreparedGitHubRepositoryUseRequest;

type ClassificationDenialReason =
  | "request_invalid"
  | "encoding_unsupported"
  | "draft_rejected"
  | "origin_mismatch"
  | "route_unsupported"
  | "discovery_body"
  | "body_empty"
  | "body_too_large"
  | "ref_not_allowed";

/** Select GitHub request semantics after the caller validates its request and binding. */
export function selectGitHubRequest(
  request: GitHubRequest,
  binding: GitHubScope,
  createUUID: () => string,
): Selection {
  const head = requestHead(request, binding);
  if (!head) {
    return { denied: "request_invalid" };
  }
  return operation(request, binding, head, createUUID);
}

function matchesOrigin(origin: string, request: GitHubRequest): boolean {
  const url = new URL(origin);
  return (
    url.origin === origin &&
    url.protocol === "https:" &&
    url.hostname === request.target.host &&
    Number(url.port || 443) === request.target.port
  );
}

function requestHead(request: GitHubRequest, binding: GitHubScope): RequestHead | undefined {
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
    // Shipped gh metadata survives stock's visible-header projection. Admit only
    // these values on selected-repository bindings; operation() still selects the route.
    const apiMetadata =
      binding.scope === "github-repository" &&
      matchesOrigin("https://api.github.com", request) &&
      ((name === "time-zone" && value === "Etc/UTC") ||
        (request.target.method === "POST" &&
          request.target.path === "/graphql" &&
          ((name === "graphql-features" && value === "merge_queue") ||
            // gh forwards its local cache duration; never use it to cache authorization.
            (name === "x-gh-cache-ttl" &&
              value.length > 0 &&
              value.length <= 64 &&
              [...value].every((character) => character >= " " && character !== "\u007f")))));
    if (
      (!allowed.includes(name) && !apiMetadata) ||
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
  request: GitHubRequest,
  binding: RepositoryScope,
  head: RequestHead,
  createUUID: () => string,
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
  const headers: Record<string, string> = {
    ...head.headers,
    "x-oce-operation-id": createUUID(),
  };
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
function installationApiOperation(
  request: GitHubRequest,
  head: RequestHead,
  scope: "github-repository" | "github-installation",
) {
  const { path, query, method } = request.target;
  const { headers } = head;
  const graph = path === "/graphql";
  const maximumBody = scope === "github-repository" && !graph ? 1024 * 1024 : 64 * 1024;
  const read = method === "GET" || method === "HEAD";
  if (
    head.contentEncoding !== "identity" ||
    // Dedicated credential issuance is not ordinary repository collaboration.
    (method === "POST" && /^\/repos\/[\w-]+\/[\w.-]+\/keys$/i.test(path)) ||
    (method === "POST" &&
      /^\/(?:repos\/[\w-]+\/[\w.-]+|orgs\/[\w-]+)\/actions\/runners\/(?:registration-token|remove-token|generate-jitconfig)$/i.test(
        path,
      )) ||
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
    request.body.byteLength > maximumBody
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
    return allowsGraphqlInput(request.body) &&
      "query" in body &&
      typeof body.query === "string" &&
      body.query.trim()
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
  | { readonly denied: ClassificationDenialReason };

function operation(
  request: GitHubRequest,
  binding: GitHubScope,
  head: RequestHead,
  createUUID: () => string,
): Selection {
  if (binding.scope !== undefined) {
    if (matchesOrigin("https://api.github.com", request)) {
      if (binding.scope === "github-repository" && request.target.path.startsWith("/repos/")) {
        const repo = /^\/repos\/([^/]+\/[^/]+)(?:\/|$)/.exec(request.target.path)?.[1];
        if (
          !repo ||
          !binding.repositories.some((r) => r.repository.toLowerCase() === repo.toLowerCase())
        ) {
          return { denied: "route_unsupported" };
        }
      }
      const api = installationApiOperation(request, head, binding.scope);
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
    if (
      binding.scope === "github-repository" &&
      (!repo ||
        !binding.repositories.some(
          (r) => r.repository.toLowerCase() === repo.replace(/\.git$/, "").toLowerCase(),
        ))
    ) {
      return { denied: "route_unsupported" };
    }
    return repo ? gitOperation(request, head, repo) : { denied: "route_unsupported" };
  }
  if (request.target.path.startsWith("/repos/")) {
    if (head.contentEncoding !== "identity") {
      return { denied: "encoding_unsupported" };
    }
    let pull: PreparedGitHubPullScope | undefined;
    try {
      pull = draftScope(request, binding, head, createUUID);
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
  request: GitHubRequest,
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
