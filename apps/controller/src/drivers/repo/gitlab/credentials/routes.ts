import type {
  Denied,
  InputVerdict,
  RequestHead,
  RequestPlan,
  ResponsePolicy,
} from "../../credentials/backend-contracts.ts";
import type { JsonValue } from "../../credentials/json-value.ts";
import type { ServiceLimits } from "../../credentials/service-contracts.ts";
import { allowsReceivePackInput } from "../../credentials/receive-pack.ts";
import { draftMergeRequestRequest, refuseGitLabQuickActions } from "../client.ts";
import type { GitLabTokenProfile } from "./types.ts";

export interface GitLabRoute {
  readonly kind: "git-discovery" | "git-fetch" | "git-push" | "api";
  readonly effect: "read" | "write";
  readonly target: string;
  readonly draft?: true;
}

export interface GitLabRoutePolicy {
  route(head: RequestHead): GitLabRoute | undefined;
  plan(head: RequestHead): RequestPlan | Denied;
}

interface GitLabRoutePolicyOptions {
  readonly project: string;
  readonly projectId: string;
  readonly profile: GitLabTokenProfile;
  readonly gatewayOrigin: string;
  readonly limits: ServiceLimits;
  readonly pushRefAllowlist: readonly string[];
}

const deny = (): Denied =>
  Object.freeze({ kind: "denied", status: 400, code: "unsupported-request" });

function parseTarget(raw: string, limit: number) {
  if (Buffer.byteLength(raw) > limit || !/^\/[\x21-\x7e]*$/.test(raw) || raw.includes("#")) {
    return undefined;
  }
  const split = raw.indexOf("?");
  const path = split < 0 ? raw : raw.slice(0, split);
  const query = split < 0 ? "" : raw.slice(split + 1);
  if (
    raw.startsWith("//") ||
    (split >= 0 && query === "") ||
    path.split("/").some((piece) => piece === "." || piece === "..") ||
    query.includes("?") ||
    /%(?![0-9A-Fa-f]{2})/.test(query)
  ) {
    return undefined;
  }
  return { path, query };
}

function decodedPath(path: string): string | undefined {
  try {
    return decodeURIComponent(path);
  } catch {
    return undefined;
  }
}

function classifyGitRoute(
  head: RequestHead,
  target: ReturnType<typeof parseTarget>,
  project: string,
  profile: GitLabTokenProfile,
): GitLabRoute | undefined {
  if (!target) {
    return undefined;
  }
  const path = decodedPath(target.path);
  const prefix = `/${project}.git/`;
  if (path === undefined || !path.startsWith(prefix)) {
    return undefined;
  }
  const endpoint = path.slice(prefix.length);
  if (head.headers["git-protocol"] !== undefined && head.headers["git-protocol"] !== "version=2") {
    return undefined;
  }
  if (
    endpoint === "info/refs" &&
    head.method === "GET" &&
    (target.query === "service=git-upload-pack" ||
      (profile !== "git-read" && target.query === "service=git-receive-pack"))
  ) {
    return {
      kind: "git-discovery",
      effect: target.query.includes("receive") ? "write" : "read",
      target: `${prefix}info/refs?${target.query}`,
    };
  }
  if (target.query || head.method !== "POST") {
    return undefined;
  }
  if (
    endpoint === "git-upload-pack" &&
    head.headers["content-type"] === "application/x-git-upload-pack-request"
  ) {
    return { kind: "git-fetch", effect: "read", target: `${prefix}git-upload-pack` };
  }
  if (
    profile !== "git-read" &&
    endpoint === "git-receive-pack" &&
    head.headers["content-type"] === "application/x-git-receive-pack-request"
  ) {
    return { kind: "git-push", effect: "write", target: `${prefix}git-receive-pack` };
  }
  return undefined;
}

function classifyApiRoute(
  head: RequestHead,
  target: ReturnType<typeof parseTarget>,
  projectId: string,
  profile: GitLabTokenProfile,
): GitLabRoute | undefined {
  if (!target || head.contentEncoding !== "identity") {
    return undefined;
  }
  const prefix = `/api/v4/projects/${projectId}`;
  const path = target.path;
  if (path === prefix) {
    return head.method === "GET" && target.query === ""
      ? { kind: "api", effect: "read", target: path }
      : undefined;
  }
  if (!path.startsWith(`${prefix}/`)) {
    return undefined;
  }
  const endpoint = path.slice(prefix.length + 1);
  const readRoutes: Readonly<Record<string, readonly string[]>> = {
    "repository/branches": ["per_page=100"],
    issues: ["state=opened&per_page=100", "state=closed&per_page=100", "state=all&per_page=100"],
    merge_requests: [
      "state=opened&per_page=100",
      "state=closed&per_page=100",
      "state=all&per_page=100",
    ],
    pipelines: ["per_page=100"],
  };
  if (head.method === "GET" && readRoutes[endpoint]?.includes(target.query) === true) {
    return { kind: "api", effect: "read", target: path };
  }
  if (head.method !== "POST" || target.query !== "") {
    return undefined;
  }
  if (
    head.headers["content-type"]?.toLowerCase() !== "application/json" ||
    !["*/*", "application/json"].includes(head.headers.accept ?? "*/*")
  ) {
    return undefined;
  }
  if (endpoint === "merge_requests" && profile !== "git-read") {
    return { kind: "api", effect: "write", target: path, draft: true };
  }
  const mergeRequestNote = /^merge_requests\/([1-9][0-9]{0,15})\/notes$/.exec(endpoint);
  if (mergeRequestNote && profile !== "git-read") {
    return { kind: "api", effect: "write", target: path };
  }
  if (endpoint === "issues" && profile === "git-full") {
    return { kind: "api", effect: "write", target: path };
  }
  const issueNote = /^issues\/([1-9][0-9]{0,15})\/notes$/.exec(endpoint);
  if (issueNote && profile === "git-full") {
    return { kind: "api", effect: "write", target: path };
  }
  return undefined;
}

function object(value: JsonValue | undefined): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid-request");
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("invalid-request");
  }
  return refuseGitLabQuickActions(value, field);
}

function apiInput(route: GitLabRoute): (body: Uint8Array) => InputVerdict {
  return (body) => {
    try {
      const value = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)));
      if (route.draft === true) {
        const request = draftMergeRequestRequest({
          sourceBranch: requireString(value.source_branch, "merge request source branch"),
          targetBranch: requireString(value.target_branch, "merge request target branch"),
          title: requireString(value.title, "merge request title"),
          ...(value.description === undefined
            ? {}
            : { description: requireString(value.description, "merge request description") }),
        });
        return { body: Buffer.from(JSON.stringify(request.body)) };
      }
      if (route.target.endsWith("/issues")) {
        const replacement = {
          title: requireString(value.title, "issue title"),
          ...(value.description === undefined
            ? {}
            : { description: requireString(value.description, "issue description") }),
        };
        return { body: Buffer.from(JSON.stringify(replacement)) };
      }
      if (route.target.endsWith("/notes")) {
        return { body: Buffer.from(JSON.stringify({ body: requireString(value.body, "note") })) };
      }
      return false;
    } catch {
      return false;
    }
  };
}

function responsePolicy(route: GitLabRoute): ResponsePolicy {
  const headers = (status: number, headers: Record<string, string>) => {
    if (status >= 300 && status < 400) {
      throw new Error("upstream-redirect");
    }
    const output: Record<string, string> = {};
    for (const name of ["content-type", "cache-control", "retry-after"]) {
      const value = headers[name];
      if (value !== undefined && value.length <= 2048 && !/[\r\n]/.test(value)) {
        output[name] = value;
      }
    }
    return Object.freeze(output);
  };
  if (route.kind === "api") {
    return Object.freeze({
      body: "bounded-json",
      trailers: "forbid",
      rewriteJson:
        route.draft === true
          ? (value) => {
              const result = object(value);
              if (result.draft !== true || result.state !== "opened") {
                throw new Error("invalid-gitlab-draft");
              }
              return value;
            }
          : undefined,
      headers,
    });
  }
  return Object.freeze({ body: "stream", rewriteJson: undefined, headers });
}

function requestHeaders(head: RequestHead, route: GitLabRoute): Record<string, string> {
  const headers: Record<string, string> = {
    "user-agent": "openclaw-enterprise-repository-credentials",
    "accept-encoding": "identity",
  };
  if (route.kind === "api") {
    headers.accept = "application/json";
    if (head.method === "POST") {
      headers["content-type"] = "application/json";
    }
  } else {
    if (head.headers["git-protocol"] === "version=2") {
      headers["git-protocol"] = "version=2";
    }
    if (route.kind === "git-fetch" || route.kind === "git-push") {
      headers["content-type"] =
        route.kind === "git-fetch"
          ? "application/x-git-upload-pack-request"
          : "application/x-git-receive-pack-request";
    }
    headers.accept = head.headers.accept ?? "*/*";
  }
  return headers;
}

function plan(
  head: RequestHead,
  options: GitLabRoutePolicyOptions,
  route: GitLabRoute | undefined,
): RequestPlan | Denied {
  if (!route) {
    return deny();
  }
  if (head.method === "GET" && (head.framing.kind === "chunked" || (head.framing.bytes ?? 0) > 0)) {
    return deny();
  }
  const input =
    route.kind === "git-push"
      ? options.limits.gitPushInputBytes
      : route.kind === "git-fetch"
        ? options.limits.gitFetchInputBytes
        : route.kind === "api"
          ? options.limits.apiInputBytes
          : 1;
  if ((head.framing.bytes ?? 0) > input) {
    return Object.freeze({ kind: "denied", status: 413, code: "limit-exceeded" });
  }
  const uploadPack = route.kind === "git-fetch";
  return Object.freeze({
    origin: "https://gitlab.com",
    method: head.method,
    target: route.target,
    category: route.kind,
    effect: route.effect,
    requestHeaders: Object.freeze(requestHeaders(head, route)),
    limits: Object.freeze({
      inputWireBytes: input,
      inputDecodedBytes: input,
      responseBytes: uploadPack
        ? options.limits.gitFetchResponseBytes
        : route.kind === "api"
          ? options.limits.apiResponseBytes
          : options.limits.gitResponseBytes,
      totalMs: uploadPack ? options.limits.gitFetchExchangeMs : options.limits.exchangeMs,
      inputMs: route.kind === "git-push" ? options.limits.exchangeMs : options.limits.inputMs,
      firstHeaderMs: uploadPack
        ? options.limits.gitFetchFirstHeaderMs
        : options.limits.firstHeaderMs,
      stallMs: uploadPack ? options.limits.gitFetchStallMs : options.limits.stallMs,
      connectMs: options.limits.connectMs,
    }),
    responsePolicy: responsePolicy(route),
    ...(route.effect === "write" ? { bindRequestDigest: true } : {}),
    ...(route.kind === "api" && head.method === "POST" ? { inputPolicy: apiInput(route) } : {}),
    ...(route.kind === "git-push"
      ? { inputPolicy: allowsReceivePackInput(options.pushRefAllowlist) }
      : {}),
  }) as RequestPlan;
}

export function createGitLabRoutePolicy(options: GitLabRoutePolicyOptions): GitLabRoutePolicy {
  const route: GitLabRoutePolicy["route"] = (head) => {
    const target = parseTarget(head.rawTarget, options.limits.targetBytes);
    return (
      classifyGitRoute(head, target, options.project, options.profile) ??
      classifyApiRoute(head, target, options.projectId, options.profile)
    );
  };
  return Object.freeze({
    route,
    plan: (head: RequestHead) => plan(head, options, route(head)),
  });
}
