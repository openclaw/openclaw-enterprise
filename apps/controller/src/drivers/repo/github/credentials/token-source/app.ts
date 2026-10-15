import type { GitHubTokenSource, TokenSourceOptions } from "../token-source.ts";
import type { GitHubAppConfiguration, GitHubKeyOwner } from "../types.ts";
import { createCredentialAcquisition } from "../driver/acquisition.ts";
import { createCredentialRetirement } from "../driver/retirement.ts";
import { githubCapabilityPolicy } from "../profiles.ts";
import { createProviderTransport } from "../provider-transport.ts";

/** GitHub App installation tokens: minted per session scope and revoked on retirement. */
export function createAppTokenSource(
  key: GitHubKeyOwner,
  { config, apiOrigin, ca }: TokenSourceOptions & Readonly<{ config: GitHubAppConfiguration }>,
): GitHubTokenSource {
  return Object.freeze<GitHubTokenSource>({
    kind: "github-app",
    cleanup: "revocable",
    capabilityPolicy: () => githubCapabilityPolicy,
    graphql: () => "token-bounded",
    // Registry push policy stays the client hook's convenience check for App grants.
    pushRefAllowlist: undefined,
    bind({ state, custody, clock, profile, permissions }) {
      const exchange = createProviderTransport(apiOrigin, ca, clock, {
        installationId: config.installationId,
        repositoryId: config.repositoryId,
        profile,
      });
      return Object.freeze({
        acquire: createCredentialAcquisition({
          state,
          custody,
          clock,
          key,
          config,
          permissions,
          exchange,
        }),
        retire: createCredentialRetirement({ state, custody, clock, exchange }),
      });
    },
  });
}
