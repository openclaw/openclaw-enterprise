import { githubProviderOrigin } from "./origin.ts";
import type { RepositoryBackend } from "../../access/backend-contracts.ts";
import { createGitHubDriver } from "./driver.ts";
import { validateGitHubConfiguration } from "./config.ts";
import { staticTokenGraphqlPolicy } from "./profiles.ts";
import { createRoutePolicy } from "./routes.ts";
import { createGatewayAuthentication } from "./gateway-authentication.ts";
import { createGrantResolver } from "./grants.ts";
import type { GitHubDriverFactory, GitHubFactoryOptions, GitHubTokenProfile } from "./types.ts";

export function createGitHubDriverFactory(options: GitHubFactoryOptions): GitHubDriverFactory {
  const config = validateGitHubConfiguration(options.configuration);
  // A static token has no metadata-only capability.
  // Its push allowlist comes only from configuration, where the gateway enforces it.
  // Caller-selected bindings are unsupported, including an explicitly undefined property.
  if (
    options.authority?.kind !== config.kind ||
    Object.hasOwn(options, "metadataOnly") ||
    "binding" in options
  ) {
    throw new Error("invalid-configuration");
  }
  const apiOrigin = githubProviderOrigin(
    options.trustedEndpoints?.apiOrigin ?? "https://api.github.com",
  );
  const gitOrigin = githubProviderOrigin(
    options.trustedEndpoints?.gitOrigin ?? "https://github.com",
  );
  const gatewayOrigin = githubProviderOrigin(options.gatewayOrigin);
  const owner = options.authority;
  const leaseMs = config.leaseSeconds * 1000;
  // Acquisition must cover an exchange deadline and both credential margins.
  if (
    leaseMs < options.limits.exchangeMs + 2 * options.limits.credentialMarginMs ||
    (config.allowGraphql && owner.tokenClass !== "fine-grained")
  ) {
    throw new Error("invalid-configuration");
  }
  const grants = createGrantResolver({ config, gatewayOrigin });
  const { pushRefAllowlist } = config;
  const policy = (profile: GitHubTokenProfile) =>
    createRoutePolicy({
      repository: config.repository,
      repositoryId: config.repositoryId,
      profile,
      gatewayOrigin,
      gitOrigin,
      apiOrigin,
      limits: {
        ...options.limits,
        gitFetchExchangeMs: Math.min(
          options.limits.gitFetchExchangeMs,
          config.leaseSeconds * 1000 - 2 * options.limits.credentialMarginMs,
        ),
      },
      graphql: staticTokenGraphqlPolicy(profile, config.allowGraphql),
      pushRefAllowlist,
    });
  const unauthenticatedPolicy = policy("git-write");
  const authentication = createGatewayAuthentication({
    isGitRoute: (head) => {
      const route = unauthenticatedPolicy.route(head);
      return route !== undefined && route.kind !== "api";
    },
  });
  return Object.freeze<GitHubDriverFactory>({
    trustedUpstreamOrigins: new Set([apiOrigin, gitOrigin]),
    resolve: grants.resolve,
    ...authentication,
    create({ authority: input, custody, clock }): RepositoryBackend {
      const authority = Object.freeze({ ...input });
      const admitted = grants.forAuthority(authority);
      const { profile } = admitted;
      return createGitHubDriver({
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
