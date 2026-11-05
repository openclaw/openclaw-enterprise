import type {
  PreparedRepositoryBackend,
  RequestPlan,
  ResolvedGrant,
} from "../../credentials/backend-contracts.ts";
import { sameBinding } from "../../credentials/grant-identity.ts";
import { createGatewayAuthentication } from "../../credentials/gateway-authentication.ts";
import { createGitLabGrantResolver } from "./grants.ts";
import { createGitLabRoutePolicy } from "./routes.ts";
import type { GitLabDriverFactory, GitLabFactoryOptions } from "./types.ts";
import { validateGitLabConfiguration } from "./config.ts";

export function createGitLabDriverFactory(options: GitLabFactoryOptions): GitLabDriverFactory {
  const configuration = validateGitLabConfiguration(options.configuration);
  if (options.authority.kind !== configuration.kind || configuration.allowGraphql === true) {
    throw new Error("invalid-configuration");
  }
  const gatewayOrigin = new URL(options.gatewayOrigin).origin;
  const owner = options.authority;
  const namespaceId = options.namespaceId;
  if (
    configuration.leaseSeconds * 1000 <
    options.limits.exchangeMs + 2 * options.limits.credentialMarginMs
  ) {
    throw new Error("invalid-configuration");
  }
  const grants = createGitLabGrantResolver({ configuration, gatewayOrigin, namespaceId });
  const policy = (profile: "git-read" | "git-write" | "git-full") =>
    createGitLabRoutePolicy({
      project: configuration.project,
      projectId: configuration.projectId,
      profile,
      gatewayOrigin,
      limits: options.limits,
      pushRefAllowlist: configuration.pushRefAllowlist,
    });
  const unauthenticatedPolicy = policy("git-write");
  const authentication = createGatewayAuthentication({
    isGitRoute: (head) => {
      const route = unauthenticatedPolicy.route(head);
      return route !== undefined && route.kind !== "api";
    },
  });
  const selections = new WeakMap<ResolvedGrant, "git-read" | "git-write" | "git-full">();
  return Object.freeze<GitLabDriverFactory>({
    trustedUpstreamOrigins: new Set(["https://gitlab.com"]),
    resolveBound(input) {
      const selection = grants.resolveBound(input);
      selections.set(selection, input.profile as "git-read" | "git-write" | "git-full");
      return selection;
    },
    ...authentication,
    createPrepared(authority, selection) {
      const profile = selections.get(selection);
      if (
        profile === undefined ||
        !sameBinding(selection.binding, authority) ||
        !authority.sessionId
      ) {
        throw new Error("invalid-binding");
      }
      selections.delete(selection);
      const routes = policy(profile);
      return Object.freeze<PreparedRepositoryBackend>({
        binding: selection.binding,
        plan({ head }) {
          const plan = routes.plan(head);
          if ("kind" in plan) {
            return plan;
          }
          return Object.freeze({
            ...plan,
            bindRequestDigest: true,
            ...(plan.category === "git-fetch" ? { inputPolicy: () => true } : {}),
          });
        },
        async authorize(plan: RequestPlan, _requestDigestSha256, bounds) {
          return owner.withToken(async (bytes, assertCurrent) => {
            const basic = plan.category.startsWith("git-")
              ? Buffer.concat([Buffer.from("x-access-token:"), bytes])
              : undefined;
            const authorization = basic ? `Basic ${basic.toString("base64")}` : undefined;
            const privateToken =
              basic === undefined ? Buffer.from(bytes).toString("utf8") : undefined;
            let startedSend = false;
            return Object.freeze({
              headers: Object.freeze({
                ...plan.requestHeaders,
                ...(authorization === undefined ? {} : { authorization }),
                ...(privateToken === undefined ? {} : { "private-token": privateToken }),
              }),
              assertSendStart() {
                assertCurrent();
                if (
                  startedSend ||
                  bounds.signal.aborted ||
                  options.clock.monotonicNow() >= bounds.deadlineMonoMs
                ) {
                  throw new Error("exchange-expired");
                }
                startedSend = true;
              },
            });
          });
        },
      });
    },
  });
}
