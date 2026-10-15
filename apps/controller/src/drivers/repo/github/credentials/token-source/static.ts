import type { GitHubTokenSource, TokenSourceOptions } from "../token-source.ts";
import type {
  GitHubStaticTokenOwner,
  GitHubTokenConfiguration,
  GitHubTokenProfile,
} from "../types.ts";
import {
  createStaticTokenAcquisition,
  createUnsupportedRetirement,
} from "../driver/static-acquisition.ts";
import { staticTokenCapabilityPolicy } from "../profiles.ts";

/**
 * Development-only static token. It cannot be narrowed per session, so the route
 * policy is its scope: GraphQL stays denied unless explicitly allowed (never for
 * git-read) and pushes are checked against the required ref allowlist.
 */
export function createStaticTokenSource(
  owner: GitHubStaticTokenOwner,
  { config, limits }: TokenSourceOptions & Readonly<{ config: GitHubTokenConfiguration }>,
): GitHubTokenSource {
  const leaseMs = config.leaseSeconds * 1000;
  // The lifecycle asks for validity covering a waiter's exchange deadline plus its margin.
  if (leaseMs < limits.exchangeMs + 2 * limits.credentialMarginMs) {
    throw new Error("invalid-configuration");
  }
  if (config.allowGraphql && owner.tokenClass !== "fine-grained") {
    throw new Error("invalid-configuration");
  }
  const graphql = (profile: GitHubTokenProfile) =>
    profile !== "git-read" && config.allowGraphql ? ("read-only" as const) : ("deny" as const);
  return Object.freeze<GitHubTokenSource>({
    kind: "github-token",
    cleanup: "expiry-only",
    capabilityPolicy: (profile) => staticTokenCapabilityPolicy[graphql(profile)],
    graphql,
    pushRefAllowlist: config.pushRefAllowlist,
    bind({ state, custody, clock }) {
      return Object.freeze({
        acquire: createStaticTokenAcquisition({ state, custody, clock, owner, leaseMs }),
        retire: createUnsupportedRetirement(state),
      });
    },
  });
}
