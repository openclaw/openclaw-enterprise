import type { AuthorityIdentity, ResolvedGrant } from "../../credentials/backend-contracts.ts";
import { createHash } from "node:crypto";
import { githubCapabilityPolicy, permissionsForProfile } from "./profiles.ts";
import type { GitHubTokenSource } from "./token-source.ts";
import type { GitHubConfiguration, GitHubFactoryOptions, GitHubTokenProfile } from "./types.ts";
import { sameAuthority } from "./driver/state.ts";

type GrantDependencies = Readonly<{
  config: GitHubConfiguration;
  gatewayOrigin: string;
  source: GitHubTokenSource;
  metadataOnly?: true;
  selectedBinding?: GitHubFactoryOptions["binding"];
}>;

function grantIdentity(
  source: GitHubTokenSource,
  configVersion: string,
  profile: GitHubTokenProfile,
) {
  // App grant JSON is unchanged; registry grants and recorded bindings depend on it.
  if (source.kind === "github-app") {
    return {
      configVersion,
      profile,
      permissions: permissionsForProfile(profile),
      capabilityPolicy: githubCapabilityPolicy,
    };
  }
  // A static token's permission map is a REST write-route allowlist, not provider-verified
  // permissions. The authority and push policy keep token grants disjoint from App grants.
  return {
    configVersion,
    profile,
    routePermissions: permissionsForProfile(profile),
    capabilityPolicy: source.capabilityPolicy(profile),
    pushRefAllowlist: source.pushRefAllowlist,
    authority: source.kind,
  };
}

export function createGrantResolver({
  config,
  gatewayOrigin,
  source,
  metadataOnly,
  selectedBinding,
}: GrantDependencies) {
  const pushRefAllowlist = selectedBinding?.pushRefAllowlist ?? source.pushRefAllowlist;
  function resolve(profile: string): ResolvedGrant {
    if (
      profile !== "git-read" &&
      profile !== "git-write" &&
      profile !== "git-full" &&
      profile !== "metadata-read"
    ) {
      throw new Error("unsupported-profile");
    }
    if ((profile === "metadata-read") !== (metadataOnly === true)) {
      throw new Error("unsupported-profile");
    }
    if (selectedBinding && profile !== selectedBinding.profile) {
      throw new Error("unsupported-profile");
    }
    return Object.freeze({
      binding:
        selectedBinding?.identity ??
        Object.freeze({
          providerInstanceId: config.providerInstanceId,
          repositoryId: config.repositoryId,
          grantId: `sha256:${createHash("sha256")
            .update(JSON.stringify(grantIdentity(source, config.configVersion, profile)))
            .digest("hex")}`,
        }),
      client: Object.freeze({
        gatewayOrigin,
        gitRemote: `${gatewayOrigin}/${config.repository}.git`,
        gitUsername: "gateway-session",
        canonicalApiHost: "github.com",
        apiHost: new URL(gatewayOrigin).hostname,
        repository: config.repository,
        ...(pushRefAllowlist === undefined ? {} : { pushRefAllowlist }),
      }),
    });
  }
  function forAuthority(authority: AuthorityIdentity) {
    const profile = (
      selectedBinding
        ? [selectedBinding.profile]
        : metadataOnly
          ? (["metadata-read"] as const)
          : (["git-read", "git-write", "git-full"] as const)
    ).find((value) =>
      sameAuthority({ ...resolve(value).binding, sessionId: authority.sessionId }, authority),
    );
    if (!profile || !authority.sessionId) {
      throw new Error("invalid-binding");
    }
    return { profile, grant: resolve(profile) };
  }
  return { resolve, forAuthority };
}
