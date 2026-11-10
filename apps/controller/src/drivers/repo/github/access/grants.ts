import type { AuthorityIdentity, ResolvedGrant } from "../../access/backend-contracts.ts";
import { createHash } from "node:crypto";
import {
  permissionsForProfile,
  staticTokenCapabilityPolicy,
  staticTokenGraphqlPolicy,
} from "./profiles.ts";
import type { GitHubTokenConfiguration, GitHubTokenProfile } from "./types.ts";
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
    if (profile !== "git-read" && profile !== "git-write" && profile !== "git-full") {
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
        gatewayOrigin,
        gitRemote: `${gatewayOrigin}/${config.repository}.git`,
        gitUsername: "gateway-session",
        canonicalApiHost: "github.com",
        apiHost: new URL(gatewayOrigin).hostname,
        repository: config.repository,
        pushRefAllowlist,
      }),
    });
  }
  function forAuthority(authority: AuthorityIdentity) {
    const profile = (["git-read", "git-write", "git-full"] as const).find((value) =>
      sameAuthority({ ...resolve(value).binding, sessionId: authority.sessionId }, authority),
    );
    if (!profile || !authority.sessionId) {
      throw new Error("invalid-binding");
    }
    return { profile, grant: resolve(profile) };
  }
  return { resolve, forAuthority };
}
