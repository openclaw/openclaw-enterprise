import type { RepositoryBackend } from "../../credentials/backend-contracts.ts";
import { createGitHubDriver } from "./driver.ts";
import { snapshotBinding } from "../../credentials/sessions.ts";
import { normalizePushRefAllowlist } from "../../credentials/client-contracts.ts";
import { validateGitHubConfiguration } from "./config.ts";
import { permissionsForProfile } from "./profiles.ts";
import { createRoutePolicy } from "./routes.ts";
import { createGatewayAuthentication } from "./gateway-authentication.ts";
import { createGrantResolver } from "./grants.ts";
import { createTokenSource } from "./token-source.ts";
import type { GitHubDriverFactory, GitHubFactoryOptions, GitHubTokenProfile } from "./types.ts";

function endpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password) {
    throw new Error("invalid-endpoint");
  }
  return url.origin;
}
export function createGitHubDriverFactory(options: GitHubFactoryOptions): GitHubDriverFactory {
  const config = validateGitHubConfiguration(options.configuration);
  // A static token has no metadata-only capability: the registry description path is App-only.
  // Its push allowlist comes only from configuration, where the gateway enforces it.
  if (
    options.authority?.kind !== config.kind ||
    (config.kind === "github-token" &&
      (options.metadataOnly || options.binding?.pushRefAllowlist !== undefined))
  ) {
    throw new Error("invalid-configuration");
  }
  const selectedBinding =
    options.binding &&
    Object.freeze({
      profile: options.binding.profile,
      identity: snapshotBinding(options.binding.identity),
      ...(options.binding.pushRefAllowlist === undefined
        ? {}
        : { pushRefAllowlist: normalizePushRefAllowlist(options.binding.pushRefAllowlist) }),
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
  const apiOrigin = endpoint(options.trustedEndpoints?.apiOrigin ?? "https://api.github.com");
  const gitOrigin = endpoint(options.trustedEndpoints?.gitOrigin ?? "https://github.com");
  const gatewayOrigin = endpoint(options.gatewayOrigin);
  const source = createTokenSource(options.authority, {
    config,
    apiOrigin,
    ca: options.trustedEndpoints?.ca,
    limits: options.limits,
  });
  const grants = createGrantResolver({
    config,
    gatewayOrigin,
    source,
    selectedBinding,
    ...(options.metadataOnly ? { metadataOnly: true } : {}),
  });
  const policy = (profile: GitHubTokenProfile) =>
    createRoutePolicy({
      repository: config.repository,
      repositoryId: config.repositoryId,
      profile,
      gatewayOrigin,
      gitOrigin,
      apiOrigin,
      limits: options.limits,
      graphql: source.graphql(profile),
      ...(source.pushRefAllowlist === undefined
        ? {}
        : { pushRefAllowlist: source.pushRefAllowlist }),
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
      const { profile, grant } = grants.forAuthority(authority);
      return createGitHubDriver({
        authority,
        binding: grant.binding,
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
