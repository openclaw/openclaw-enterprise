import { githubProviderOrigin } from "./origin.ts";
import type { RepositoryBackend } from "../../credentials/backend-contracts.ts";
import { createGitHubDriver } from "./driver.ts";
import { snapshotBinding } from "../../credentials/sessions.ts";
import { validateGitHubConfiguration } from "./config.ts";
import { permissionsForProfile } from "./profiles.ts";
import { createRoutePolicy } from "./routes.ts";
import { createGatewayAuthentication } from "./gateway-authentication.ts";
import { createGrantResolver } from "./grants.ts";
import { createStaticTokenSource } from "./token-source/static.ts";
import type { GitHubDriverFactory, GitHubFactoryOptions, GitHubTokenProfile } from "./types.ts";

export function createGitHubDriverFactory(options: GitHubFactoryOptions): GitHubDriverFactory {
  const config = validateGitHubConfiguration(options.configuration);
  // A static token has no metadata-only capability.
  // Its push allowlist comes only from configuration, where the gateway enforces it.
  if (
    options.authority?.kind !== config.kind ||
    Object.hasOwn(options, "metadataOnly") ||
    (options.binding !== undefined && Object.hasOwn(options.binding, "pushRefAllowlist"))
  ) {
    throw new Error("invalid-configuration");
  }
  if (
    options.binding &&
    (Object.hasOwn(options.binding, "transport") ||
      ["git-ref-write", "git-ref-draft-pr"].includes(options.binding.profile))
  ) {
    throw new Error("invalid-binding");
  }
  const selectedBinding =
    options.binding &&
    Object.freeze({
      profile: options.binding.profile,
      identity: snapshotBinding(options.binding.identity),
    });
  if (selectedBinding) {
    permissionsForProfile(selectedBinding.profile);
    if (
      selectedBinding.identity.providerInstanceId !== config.providerInstanceId ||
      selectedBinding.identity.repositoryId !== config.repositoryId
    ) {
      throw new Error("invalid-binding");
    }
  }
  const apiOrigin = githubProviderOrigin(
    options.trustedEndpoints?.apiOrigin ?? "https://api.github.com",
  );
  const gitOrigin = githubProviderOrigin(
    options.trustedEndpoints?.gitOrigin ?? "https://github.com",
  );
  const gatewayOrigin = githubProviderOrigin(options.gatewayOrigin);
  const source = createStaticTokenSource(options.authority, { config, limits: options.limits });
  const grants = createGrantResolver({
    config,
    gatewayOrigin,
    source,
    selectedBinding,
  });
  const { pushRefAllowlist } = source;
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
      graphql: source.graphql(profile),
      ...(pushRefAllowlist === undefined ? {} : { pushRefAllowlist }),
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
        source,
        session: {
          profile,
          permissions: permissionsForProfile(profile),
          repositoryId: config.repositoryId,
          repository: config.repository,
        },
      });
    },
  });
}
