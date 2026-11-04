import { createHash } from "node:crypto";
import type { AuthorityIdentity, ResolvedGrant } from "../../credentials/backend-contracts.ts";
import { sameAuthority } from "../../credentials/driver-state.ts";
import type { GitLabTokenConfiguration } from "./config.ts";
import type { GitLabProfile } from "../client.ts";

type GrantDependencies = Readonly<{
  readonly configuration: GitLabTokenConfiguration;
  readonly gatewayOrigin: string;
}>;

function grantIdentity(configuration: GitLabTokenConfiguration, profile: GitLabProfile) {
  return {
    configVersion: configuration.configVersion,
    profile,
    projectId: configuration.projectId,
    project: configuration.project,
    pushRefAllowlist: configuration.pushRefAllowlist,
    authority: configuration.kind,
  };
}

export function createGitLabGrantResolver({ configuration, gatewayOrigin }: GrantDependencies) {
  function resolve(profile: string): ResolvedGrant {
    if (profile !== "git-read" && profile !== "git-write" && profile !== "git-full") {
      throw new Error("unsupported-profile");
    }
    return Object.freeze({
      binding: Object.freeze({
        providerInstanceId: configuration.providerInstanceId,
        repositoryId: configuration.projectId,
        grantId: `sha256:${createHash("sha256")
          .update(JSON.stringify(grantIdentity(configuration, profile)))
          .digest("hex")}`,
      }),
      client: Object.freeze({
        gatewayOrigin,
        gitRemote: `${gatewayOrigin}/${configuration.project}.git`,
        gitUsername: "gateway-session",
        canonicalApiHost: "gitlab.com",
        apiHost: new URL(gatewayOrigin).hostname,
        repository: configuration.project,
        projectId: configuration.projectId,
        pushRefAllowlist: configuration.pushRefAllowlist,
      }),
    });
  }
  function forAuthority(authority: AuthorityIdentity) {
    const profile = (["git-read", "git-write", "git-full"] as const).find((value) =>
      sameAuthority({ ...resolve(value).binding, sessionId: authority.sessionId }, authority),
    );
    if (profile === undefined || authority.sessionId === "") {
      throw new Error("invalid-binding");
    }
    return { profile, grant: resolve(profile) };
  }
  return Object.freeze({ resolve, forAuthority });
}
