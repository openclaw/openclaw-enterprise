import { createHash } from "node:crypto";
import type { ResolvedGrant } from "../../credentials/backend-contracts.ts";
import type { RepositoryCredentialBoundSessionInput } from "../../credentials/service-contracts.ts";
import { sameBinding } from "../../credentials/grant-identity.ts";
import type { GitLabTokenConfiguration } from "./config.ts";
import type { GitLabProfile } from "../client.ts";

export interface GitLabGrantPolicy {
  readonly authority: "gitlab-token";
  readonly configVersion: string;
  readonly providerInstanceId: string;
  readonly projectId: string;
  readonly project: string;
  readonly namespaceId: string;
  readonly profile: GitLabProfile;
  readonly pushRefAllowlist: readonly string[];
}

export function createGitLabGrantIdentity(policy: GitLabGrantPolicy) {
  return Object.freeze({
    providerInstanceId: policy.providerInstanceId,
    repositoryId: policy.projectId,
    grantId: `sha256:${createHash("sha256").update(JSON.stringify(policy)).digest("hex")}`,
  });
}

type GrantDependencies = Readonly<{
  readonly configuration: GitLabTokenConfiguration;
  readonly gatewayOrigin: string;
  readonly namespaceId: string;
}>;

export function createGitLabGrantResolver({
  configuration,
  gatewayOrigin,
  namespaceId,
}: GrantDependencies) {
  function selection(profile: GitLabProfile): ResolvedGrant {
    const binding = createGitLabGrantIdentity({
      authority: configuration.kind,
      configVersion: configuration.configVersion,
      providerInstanceId: configuration.providerInstanceId,
      projectId: configuration.projectId,
      project: configuration.project,
      namespaceId,
      profile,
      pushRefAllowlist: configuration.pushRefAllowlist,
    });
    return Object.freeze({
      binding,
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
  return Object.freeze({
    resolveBound(input: RepositoryCredentialBoundSessionInput): ResolvedGrant {
      if (
        input.repositoryRef !== configuration.projectId ||
        input.namespaceId !== namespaceId ||
        (input.profile !== "git-read" &&
          input.profile !== "git-write" &&
          input.profile !== "git-full") ||
        input.durationSeconds > configuration.leaseSeconds
      ) {
        throw new Error("invalid-binding");
      }
      const resolved = selection(input.profile);
      if (!sameBinding(resolved.binding, input.expectedBinding)) {
        throw new Error("invalid-binding");
      }
      return resolved;
    },
  });
}
