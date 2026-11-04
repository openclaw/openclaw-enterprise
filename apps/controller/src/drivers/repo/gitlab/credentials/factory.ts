import type { Clock, DriverCustody } from "../../credentials/backend-contracts.ts";
import { createGatewayAuthentication } from "../../credentials/gateway-authentication.ts";
import { createGitLabGrantResolver } from "./grants.ts";
import { createGitLabDriver } from "./driver.ts";
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
  const leaseMs = configuration.leaseSeconds * 1000;
  if (leaseMs < options.limits.exchangeMs + 2 * options.limits.credentialMarginMs) {
    throw new Error("invalid-configuration");
  }
  const grants = createGitLabGrantResolver({ configuration, gatewayOrigin });
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
  return Object.freeze<GitLabDriverFactory>({
    trustedUpstreamOrigins: new Set(["https://gitlab.com"]),
    resolve: grants.resolve,
    ...authentication,
    create({
      authority: input,
      custody,
      clock,
    }: {
      authority: Parameters<GitLabDriverFactory["create"]>[0]["authority"];
      custody: DriverCustody;
      clock: Clock;
    }) {
      const authority = Object.freeze({ ...input });
      const admitted = grants.forAuthority(authority);
      const { profile } = admitted;
      return createGitLabDriver({
        authority,
        binding: admitted.grant.binding,
        custody,
        clock,
        routes: policy(profile),
        owner,
        leaseMs,
      });
    },
  });
}
