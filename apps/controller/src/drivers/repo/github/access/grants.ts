import type { AuthorityIdentity, ResolvedGrant } from "../../access/backend-contracts.ts";
import { createHash } from "node:crypto";
import { createGitHubClientEndpoint } from "./client-endpoint.ts";
import {
  permissionsForProfile,
  staticTokenCapabilityPolicy,
  staticTokenGraphqlPolicy,
} from "./profiles.ts";
import {
  GITHUB_SESSION_PROFILES,
  isGitHubProfile,
  type GitHubTokenConfiguration,
  type GitHubTokenProfile,
} from "./types.ts";
import { sameAuthority } from "./driver/state.ts";

type GrantDependencies = Readonly<{
  config: GitHubTokenConfiguration;
  gatewayOrigin: string;
}>;

function grantIdentity(config: GitHubTokenConfiguration, profile: GitHubTokenProfile) {
  // A static token's permission map is a REST write-route allowlist, not provider-verified
  // permissions. The authority and push policy keep token grants disjoint from App grants.
  return {
    configVersion: config.configVersion,
    profile,
    routePermissions: permissionsForProfile(profile),
    capabilityPolicy:
      staticTokenCapabilityPolicy[staticTokenGraphqlPolicy(profile, config.allowGraphql)],
    pushRefAllowlist: config.pushRefAllowlist,
    authority: config.kind,
  };
}

export function createGrantResolver({ config, gatewayOrigin }: GrantDependencies) {
  const { pushRefAllowlist } = config;
  function resolve(profile: string): ResolvedGrant {
    if (!isGitHubProfile(profile)) {
      throw new Error("unsupported-profile");
    }
    return Object.freeze({
      binding: Object.freeze({
        providerInstanceId: config.providerInstanceId,
        repositoryId: config.repositoryId,
        grantId: `sha256:${createHash("sha256")
          .update(JSON.stringify(grantIdentity(config, profile)))
          .digest("hex")}`,
      }),
      client: Object.freeze({
        ...createGitHubClientEndpoint(gatewayOrigin, config.repository),
        repository: config.repository,
        pushRefAllowlist,
      }),
    });
  }
  function forAuthority(authority: AuthorityIdentity) {
    for (const profile of GITHUB_SESSION_PROFILES) {
      const grant = resolve(profile);
      if (!sameAuthority({ ...grant.binding, sessionId: authority.sessionId }, authority)) {
        continue;
      }
      if (authority.sessionId) {
        return { profile, grant };
      }
      break;
    }
    throw new Error("invalid-binding");
  }
  return { resolve, forAuthority };
}
