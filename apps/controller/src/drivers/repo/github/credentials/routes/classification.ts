import type { RequestHead } from "../../../credentials/backend-contracts.ts";
import type { GitHubTokenProfile } from "../types.ts";
import { permissionsForProfile } from "../profiles.ts";

export type Route = Readonly<{
  kind: "git-discovery" | "git-fetch" | "git-push" | "api";
  effect: "read" | "write";
  target: string;
  rawResponse?: boolean;
  graphql?: true;
}>;
const resourceNumber = /^[1-9][0-9]{0,14}$/;
// Native gh 2.100.0 uses this JSON media profile for GraphQL and REST reads.
export const nativeGraphqlAccept =
  "application/vnd.github.merge-info-preview+json, application/vnd.github.nebula-preview";
const queryValues: Readonly<Record<string, RegExp>> = Object.freeze({
  page: /^[1-9][0-9]{0,5}$/,
  after: /^[A-Za-z0-9+/_-]{1,1024}={0,2}$/,
  before: /^[A-Za-z0-9+/_-]{1,1024}={0,2}$/,
  per_page: /^(?:[1-9]|[1-9][0-9]|100)$/,
  state: /^(open|closed|all)$/,
  sort: /^(created|updated|popularity|long-running|comments)$/,
  direction: /^(asc|desc)$/,
  head: /^[A-Za-z0-9_.:/-]{1,256}$/,
  base: /^[A-Za-z0-9_./-]{1,256}$/,
  since: /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/,
  labels: /^[A-Za-z0-9 _.,-]{1,512}$/,
  creator: /^[A-Za-z0-9-]{1,39}$/,
  mentioned: /^[A-Za-z0-9-]{1,39}$/,
  assignee: /^(?:\*|none|[A-Za-z0-9-]{1,39})$/,
});
interface ParsedTarget {
  readonly raw: string;
  readonly path: string;
  readonly query: string;
}

function parseTarget(raw: string, limit: number): ParsedTarget | undefined {
  if (
    Buffer.byteLength(raw) > limit ||
    !/^\/[\x21-\x7e]*$/.test(raw) ||
    /[\\#]/.test(raw) ||
    raw.startsWith("//")
  ) {
    return;
  }
  const split = raw.indexOf("?");
  const path = split < 0 ? raw : raw.slice(0, split);
  const query = split < 0 ? "" : raw.slice(split + 1);
  // A bare "?" would give one route two targets (for example "/graphql?").
  if (
    (split >= 0 && query === "") ||
    path.includes("%") ||
    path.split("/").some((piece) => piece === "." || piece === "..") ||
    query.includes("?") ||
    /%(?![0-9A-Fa-f]{2})/.test(query)
  ) {
    return;
  }
  return { raw, path, query };
}

function classifyGitRoute(
  head: RequestHead,
  target: ParsedTarget,
  repository: string,
  profile: GitHubTokenProfile,
): Route | undefined {
  const { path, query } = target;
  const parts = /^\/([^/]+\/[^/]+)\/(.*)$/.exec(path);
  const identity = repository.toLowerCase();
  const requested = parts?.[1]?.toLowerCase();
  // Compare both spellings with the admitted identity; a literal .git name keeps its suffix.
  if (requested !== identity && requested !== `${identity}.git`) {
    return;
  }
  const endpoint = parts![2];
  const git = `/${repository}.git/`;
  if (head.headers["git-protocol"] !== undefined && head.headers["git-protocol"] !== "version=2") {
    return;
  }
  if (
    endpoint === "info/refs" &&
    head.method === "GET" &&
    (query === "service=git-upload-pack" ||
      (profile !== "git-read" && query === "service=git-receive-pack"))
  ) {
    return {
      kind: "git-discovery",
      effect: query.includes("receive") ? "write" : "read",
      target: `${git}info/refs?${query}`,
    };
  }
  if (query || head.method !== "POST") {
    return;
  }
  if (
    endpoint === "git-upload-pack" &&
    head.headers["content-type"] === "application/x-git-upload-pack-request"
  ) {
    return { kind: "git-fetch", effect: "read", target: `${git}git-upload-pack` };
  }
  if (
    profile !== "git-read" &&
    endpoint === "git-receive-pack" &&
    head.headers["content-type"] === "application/x-git-receive-pack-request"
  ) {
    return { kind: "git-push", effect: "write", target: `${git}git-receive-pack` };
  }
  return;
}

interface ApiRoutePolicy {
  readonly methods: readonly string[];
  readonly queryParameters: readonly string[];
  readonly writePermissions?: readonly string[];
  readonly rawMedia?: readonly string[];
}

function matchApiRoute(path: string, repository: string): ApiRoutePolicy | undefined {
  const prefix = `/repos/${repository}`;
  if (path === prefix || path === "/meta") {
    return { methods: ["GET"], queryParameters: [] };
  }
  if (path === "/graphql") {
    return { methods: ["POST"], queryParameters: [] };
  }
  if (!path.startsWith(`${prefix}/`)) {
    return;
  }
  const parts = path.slice(prefix.length + 1).split("/");
  if (parts.length === 1 && parts[0] === "readme") {
    return {
      methods: ["GET"],
      queryParameters: [],
      rawMedia: [
        "application/vnd.github.raw",
        "application/vnd.github.v3.raw",
        "application/vnd.github.raw+json",
        "application/vnd.github.v3.raw+json",
      ],
    };
  }
  if (parts.length === 1 && (parts[0] === "pulls" || parts[0] === "issues")) {
    return {
      methods: ["GET", "POST"],
      writePermissions: [parts[0] === "pulls" ? "pull_requests" : "issues"],
      queryParameters:
        parts[0] === "pulls"
          ? ["page", "per_page", "state", "head", "base", "sort", "direction"]
          : [
              "page",
              "per_page",
              "after",
              "before",
              "state",
              "sort",
              "direction",
              "since",
              "labels",
              "creator",
              "mentioned",
              "assignee",
            ],
    };
  }
  if (
    parts.length === 2 &&
    (parts[0] === "pulls" || parts[0] === "issues") &&
    resourceNumber.test(parts[1]!)
  ) {
    return {
      methods: ["GET", "PATCH"],
      queryParameters: [],
      writePermissions: [parts[0] === "pulls" ? "pull_requests" : "issues"],
      ...(parts[0] === "pulls"
        ? {
            rawMedia: [
              "application/vnd.github.v3.diff",
              "application/vnd.github.v3.patch",
              "application/vnd.github.diff",
              "application/vnd.github.patch",
            ],
          }
        : {}),
    };
  }
  if (
    parts.length === 3 &&
    parts[0] === "issues" &&
    resourceNumber.test(parts[1]!) &&
    parts[2] === "comments"
  ) {
    // GitHub uses this route for both issue and PR conversations. Its token
    // permissions decide whether a Contributor can write to the selected item.
    return {
      methods: ["GET", "POST"],
      queryParameters: ["page", "per_page", "since"],
      writePermissions: ["issues", "pull_requests"],
    };
  }
  if (
    parts.length === 3 &&
    parts[0] === "issues" &&
    parts[1] === "comments" &&
    resourceNumber.test(parts[2]!)
  ) {
    return {
      methods: ["GET", "PATCH", "DELETE"],
      queryParameters: [],
      writePermissions: ["issues", "pull_requests"],
    };
  }
  return;
}

function allowsQuery(method: string, query: string, parameters: readonly string[]): boolean {
  if (query) {
    if (method !== "GET") {
      return false;
    }
    const params = new URLSearchParams(query);
    const seen = new Set<string>();
    for (const [name, value] of params) {
      if (seen.has(name) || !parameters.includes(name) || !queryValues[name]?.test(value)) {
        return false;
      }
      seen.add(name);
    }
    if (!seen.size) {
      return false;
    }
  }
  return true;
}

function classifyApiRoute(
  head: RequestHead,
  target: ParsedTarget,
  repository: string,
  profile: GitHubTokenProfile,
): Route | undefined {
  const { raw, path, query } = target;
  const policy = matchApiRoute(path, repository);
  if (!policy || !policy.methods.includes(head.method)) {
    return;
  }
  // GraphQL is token-bounded; only the clone-credential body check applies (graphql-input.ts).
  if (head.method !== "GET" && path !== "/graphql") {
    const permissions = permissionsForProfile(profile);
    if (!policy.writePermissions?.some((permission) => permissions[permission] === "write")) {
      return;
    }
  }
  if (!allowsQuery(head.method, query, policy.queryParameters)) {
    return;
  }
  if (
    ["POST", "PATCH"].includes(head.method) &&
    !/^application\/(?:json|vnd\.github\+json)(?:;\s*charset=utf-8)?$/i.test(
      head.headers["content-type"] ?? "",
    )
  ) {
    return;
  }
  const accept = head.headers.accept;
  const rawResponse =
    head.method === "GET" && accept !== undefined && policy.rawMedia?.includes(accept) === true;
  if (
    accept !== undefined &&
    !["*/*", "application/json", "application/vnd.github+json"].includes(accept) &&
    !rawResponse &&
    accept !== nativeGraphqlAccept
  ) {
    return;
  }
  const feature = head.headers["graphql-features"];
  if (feature !== undefined && (path !== "/graphql" || feature !== "merge_queue")) {
    return;
  }
  return {
    kind: "api",
    effect: head.method === "GET" ? "read" : "write",
    target: raw,
    rawResponse,
    ...(path === "/graphql" ? { graphql: true as const } : {}),
  };
}

export function classifyRoute(
  head: RequestHead,
  policy: Readonly<{ repository: string; profile: GitHubTokenProfile; targetBytes: number }>,
): Route | undefined {
  const target = parseTarget(head.rawTarget, policy.targetBytes);
  if (!target) {
    return;
  }
  // This private scope is only used for a single repository metadata read.
  if (policy.profile === "metadata-read") {
    if (
      head.method !== "GET" ||
      head.contentEncoding !== "identity" ||
      target.raw !== `/repos/${policy.repository}`
    ) {
      return;
    }
    return { kind: "api", effect: "read", target: target.raw };
  }
  const git = classifyGitRoute(head, target, policy.repository, policy.profile);
  if (git) {
    return git;
  }
  if (head.contentEncoding !== "identity") {
    return;
  }
  return classifyApiRoute(head, target, policy.repository, policy.profile);
}
