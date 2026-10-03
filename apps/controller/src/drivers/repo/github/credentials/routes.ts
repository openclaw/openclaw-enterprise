import type { Denied, RequestHead, RequestPlan } from "../../credentials/backend-contracts.ts";
import type { ServiceLimits } from "../../credentials/service-contracts.ts";
import type { GitHubTokenProfile } from "./types.ts";
import { allowsGraphqlInput } from "./graphql-input.ts";
import { createResponsePolicy } from "./response.ts";
import { classifyRoute, nativeGraphqlAccept } from "./routes/classification.ts";
import type { Route } from "./routes/classification.ts";

const deny = (): Denied =>
  Object.freeze({ kind: "denied", status: 400, code: "unsupported-request" });

export interface RoutePolicy {
  route(head: RequestHead): Route | undefined;
  plan(head: RequestHead): RequestPlan | Denied;
}

interface RoutePolicyOptions {
  readonly repository: string;
  readonly repositoryId: string;
  readonly profile: GitHubTokenProfile;
  readonly gatewayOrigin: string;
  readonly gitOrigin: string;
  readonly apiOrigin: string;
  readonly limits: ServiceLimits;
}

interface PlanDependencies {
  readonly route: RoutePolicy["route"];
  readonly responsePolicy: ReturnType<typeof createResponsePolicy>;
}

function inputLimit(kind: Route["kind"], limits: ServiceLimits): number {
  const bytes: Record<Route["kind"], number> = {
    "git-push": limits.gitPushInputBytes,
    "git-fetch": limits.gitFetchInputBytes,
    api: limits.apiInputBytes,
    "git-discovery": 1,
  };
  return bytes[kind];
}

function requestHeaders(head: RequestHead, selected: Route): Readonly<Record<string, string>> {
  const git = selected.kind !== "api";
  const headers: Record<string, string> = {
    "user-agent": "openclaw-enterprise-repository-credentials",
    "accept-encoding": "identity",
  };
  if (git) {
    if (head.headers["git-protocol"] === "version=2") {
      headers["git-protocol"] = "version=2";
    }
    if (selected.kind === "git-fetch" || selected.kind === "git-push") {
      headers["content-type"] =
        selected.kind === "git-fetch"
          ? "application/x-git-upload-pack-request"
          : "application/x-git-receive-pack-request";
    }
    headers.accept = head.headers.accept ?? "*/*";
  } else {
    headers.accept =
      selected.rawResponse ||
      (selected.graphql === true && head.headers.accept === nativeGraphqlAccept)
        ? head.headers.accept!
        : "application/vnd.github+json";
    headers["x-github-api-version"] = "2026-03-10";
    if (["POST", "PATCH"].includes(head.method)) {
      headers["content-type"] = "application/json";
    }
    if (head.headers["graphql-features"]) {
      headers["graphql-features"] = "merge_queue";
    }
  }
  return Object.freeze(headers);
}

function planRequest(
  head: RequestHead,
  options: RoutePolicyOptions,
  dependencies: PlanDependencies,
): RequestPlan | Denied {
  const selected = dependencies.route(head);
  if (!selected) {
    return deny();
  }
  if (head.method === "GET" && (head.framing.kind === "chunked" || (head.framing.bytes ?? 0) > 0)) {
    return deny();
  }
  const git = selected.kind !== "api";
  if (head.contentEncoding === "gzip" && (!git || head.method !== "POST")) {
    return deny();
  }
  const input = inputLimit(selected.kind, options.limits);
  if ((head.framing.bytes ?? 0) > input) {
    return Object.freeze({ kind: "denied", status: 413, code: "limit-exceeded" });
  }
  const headers = requestHeaders(head, selected);
  return Object.freeze({
    origin: git ? options.gitOrigin : options.apiOrigin,
    method: head.method,
    target: selected.target,
    category: selected.kind,
    effect: selected.effect,
    requestHeaders: headers,
    limits: Object.freeze({
      inputWireBytes: input,
      inputDecodedBytes: input,
      responseBytes: git ? options.limits.gitResponseBytes : options.limits.apiResponseBytes,
      totalMs: options.limits.exchangeMs,
      inputMs: selected.kind === "git-push" ? options.limits.exchangeMs : options.limits.inputMs,
      firstHeaderMs: options.limits.firstHeaderMs,
      stallMs: options.limits.stallMs,
      connectMs: options.limits.connectMs,
    }),
    responsePolicy: dependencies.responsePolicy(git, selected.target, selected.rawResponse),
    ...(selected.graphql === true ? { inputPolicy: allowsGraphqlInput } : {}),
  }) as RequestPlan;
}

export function createRoutePolicy(options: RoutePolicyOptions): RoutePolicy {
  const route = (head: RequestHead) =>
    classifyRoute(head, {
      repository: options.repository,
      profile: options.profile,
      targetBytes: options.limits.targetBytes,
    });
  const responsePolicy = createResponsePolicy(options, (head) => route(head) !== undefined);
  const dependencies: PlanDependencies = { route, responsePolicy };
  return Object.freeze({
    route,
    plan: (head: RequestHead) => planRequest(head, options, dependencies),
  });
}
