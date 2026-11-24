import type {
  AdmittedRepositoryBinding,
  DeploymentRequestMatch,
  GitHubAppInstallationCredentialSource,
  RepositoryNetworkGrant,
} from "@openclaw-enterprise/contracts";
import type { ControllerOptions } from "@openclaw-enterprise/occ";

import { OpenShellCredentialProxyDriver } from "../drivers/credential-proxy/openshell.ts";
import { OpenShellSandboxDriver } from "../drivers/sandbox/openshell.ts";
import { compileOpenShellCredentialPolicy } from "../drivers/sandbox/openshell-credential-policy.ts";

import { openShellRepositoryCredentialRequests } from "../drivers/credential-proxy/openshell-repository-policy.ts";
import {
  resolveSelectedRepositoryScope,
  type GitHubRepositoryRegistry,
} from "../drivers/repo/github/access/registry.ts";
import { isGitHubAppSourceScopeCurrent } from "../drivers/token-service/github-app-source.ts";

/** Qualify the installed native pair against the complete admitted deployment policy. */
export const supportsOpenShellCredentialDeployment: NonNullable<
  ControllerOptions["supportsCredentialDeployment"]
> = ({ sandbox, proxy, policy }): boolean => {
  if (
    !(sandbox instanceof OpenShellSandboxDriver) ||
    !(proxy instanceof OpenShellCredentialProxyDriver) ||
    sandbox.id !== proxy.id ||
    sandbox.implementation !== proxy.implementation ||
    typeof sandbox.provisionStagedHarness !== "function" ||
    typeof sandbox.prepareStagedHarness !== "function" ||
    typeof sandbox.activateStagedHarness !== "function" ||
    typeof sandbox.applyNetworkPolicy !== "function" ||
    typeof sandbox.observeNetworkPolicy !== "function"
  ) {
    return false;
  }
  try {
    compileOpenShellCredentialPolicy(policy, sandbox.admitNetworkPolicy([], 1).defaults);
    // TODO(1.0 strict policy): require HTTPS scheme, exact executable, and Bearer matching when native support is available.
    return true;
  } catch {
    return false;
  }
};

/** Revalidate the Source and saved Agent grants against the currently selected Namespace registry. */
export function admitOpenShellRepositoryCredentials(
  registry: GitHubRepositoryRegistry | undefined,
  input: {
    readonly namespaceId: string;
    readonly source: Readonly<GitHubAppInstallationCredentialSource>;
    readonly bindings: readonly AdmittedRepositoryBinding[];
    readonly grants: readonly RepositoryNetworkGrant[];
  },
): readonly DeploymentRequestMatch[] | undefined {
  const { namespaceId, source, bindings, grants } = input;
  try {
    if (
      !registry ||
      source.namespaceId !== namespaceId ||
      source.state !== "ready" ||
      !isGitHubAppSourceScopeCurrent(source, registry) ||
      !grants.length
    ) {
      return undefined;
    }
    const selected = resolveSelectedRepositoryScope(registry, namespaceId, bindings);
    // TODO(GitHub API cutover): admit REST and PR profiles only when their exact saved restrictions are enforced.
    if (
      selected.nativeGit !== "v1" ||
      selected.scopedRest.length > 0 ||
      !grants.every(
        ({ repository, access }) =>
          selected.repositories.some(
            (candidate) =>
              candidate.repository === repository &&
              source.scope.repositories.some(
                ({ repositoryId, repository: name }) =>
                  repositoryId === candidate.repositoryId && name === repository,
              ),
          ) &&
          (source.scope.permissions.contents === "write" ||
            (access === "read" && source.scope.permissions.contents === "read")),
      )
    ) {
      return undefined;
    }
    return openShellRepositoryCredentialRequests(grants);
  } catch {
    return undefined;
  }
}
