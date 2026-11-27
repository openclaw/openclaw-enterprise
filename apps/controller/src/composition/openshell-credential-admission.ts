import type {
  AdmittedRepositoryBinding,
  GitHubAppInstallationCredentialSource,
  RepositoryNetworkGrant,
  RepositoryNetworkPolicyCeiling,
} from "@openclaw-enterprise/contracts";
import {
  repositoryNetworkLimitForSelection,
  type ControllerOptions,
} from "@openclaw-enterprise/occ";

import { OpenShellCredentialProxyDriver } from "../drivers/credential-proxy/openshell.ts";
import { openShellRepositoryCredentialRequests } from "../drivers/credential-proxy/openshell-repository-policy.ts";
import {
  repositoryGitRestOperations,
  restrictRepositoryPullRequestCreation,
} from "../drivers/repo/access/delivery.ts";
import {
  githubPullRequestCreationRequest,
  matchesConfiguredGitHubRepository,
  resolveSelectedRepositoryScope,
  type GitHubRepositoryRegistry,
} from "../drivers/repo/github/access/registry.ts";
import { OpenShellSandboxDriver } from "../drivers/sandbox/openshell.ts";
import { compileOpenShellCredentialPolicy } from "../drivers/sandbox/openshell-credential-policy.ts";
import { openShellRepositoryMetadataRequest } from "../drivers/sandbox/openshell-git-network-policy.ts";
import { isGitHubAppSourceScopeCurrent } from "../drivers/credential-service/github-app-source.ts";

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
    compileOpenShellCredentialPolicy(
      policy,
      sandbox.admitNetworkPolicy([], 1).defaults,
      proxy.nativeSourceOwner,
    );
    // TODO(1.0 strict policy): require HTTPS scheme, exact executable, and Bearer matching when native support is available.
    return true;
  } catch {
    return false;
  }
};

type OpenShellRepositorySourceSelection = {
  readonly namespaceId: string;
  readonly source: Readonly<GitHubAppInstallationCredentialSource>;
  readonly bindings: readonly AdmittedRepositoryBinding[];
};

function selectedSourceRepositories(
  registry: GitHubRepositoryRegistry,
  { namespaceId, source, bindings }: OpenShellRepositorySourceSelection,
  selected = resolveSelectedRepositoryScope(registry, namespaceId, bindings),
): RepositoryNetworkPolicyCeiling {
  if (
    source.namespaceId !== namespaceId ||
    source.state !== "ready" ||
    !isGitHubAppSourceScopeCurrent(source, registry)
  ) {
    return [];
  }
  const access = source.scope.permissions.contents;
  if (selected.nativeGit !== "v1" || (access !== "read" && access !== "write")) {
    return [];
  }
  return source.scope.repositories
    .filter((verified) =>
      selected.repositories.some((configured) =>
        matchesConfiguredGitHubRepository(configured, verified),
      ),
    )
    .map(({ repository }) => ({ repository, access }));
}

/** Qualify Installation limits using only GitHub identities in this authorized Source. */
export function openShellRepositorySourceCeiling(
  registry: GitHubRepositoryRegistry,
  input: OpenShellRepositorySourceSelection & { readonly ceiling: RepositoryNetworkPolicyCeiling },
): RepositoryNetworkPolicyCeiling {
  try {
    return selectedSourceRepositories(registry, input).flatMap((selected) => {
      const configured = input.ceiling.filter((limit) =>
        matchesConfiguredGitHubRepository(limit, selected),
      );
      if (!configured.length) {
        return [];
      }
      return [
        {
          repository: selected.repository,
          access: configured.every(({ access }) => access === "write") ? selected.access : "read",
        },
      ];
    });
  } catch {
    return [];
  }
}

export function prepareOpenShellRepositorySource(
  registry: GitHubRepositoryRegistry,
  {
    namespaceId,
    access,
    bindings,
    ceiling,
  }: Parameters<NonNullable<ControllerOptions["prepareStagedRepositorySource"]>>[0],
): ReturnType<NonNullable<ControllerOptions["prepareStagedRepositorySource"]>> {
  try {
    const selected = resolveSelectedRepositoryScope(registry, namespaceId, bindings);
    const contents = selected.permissions.contents;
    if (selected.nativeGit !== "v1" || (contents !== "read" && contents !== "write")) {
      return undefined;
    }
    const requested = access.repositories.flatMap(({ repositoryRef, access: level }) => {
      const repository = registry.repositories.find(
        (entry) => entry.repositoryRef === repositoryRef,
      );
      if (!repository || !level) {
        return [];
      }
      const limit = repositoryNetworkLimitForSelection(ceiling, repository.repository, true);
      if (!limit || (level === "write" && (contents !== "write" || limit.access !== "write"))) {
        return [];
      }
      return [{ repository, limit, access: level }];
    });
    if (requested.length !== bindings.length || requested.length !== access.repositories.length) {
      return undefined;
    }
    return {
      appId: registry.appId,
      installationId: registry.githubInstallationId,
      resolveGrants(source) {
        const verified = selectedSourceRepositories(registry, { namespaceId, source, bindings });
        if (verified.length !== requested.length) {
          return undefined;
        }
        const grants = requested.flatMap(({ repository, limit, access }) => {
          const match = source.scope.repositories.find(
            (entry) =>
              matchesConfiguredGitHubRepository(repository, entry) &&
              matchesConfiguredGitHubRepository(limit, entry),
          );
          return match ? [{ repository: match.repository, access }] : [];
        });
        return grants.length === requested.length ? grants : undefined;
      },
    };
  } catch {
    return undefined;
  }
}

/** Revalidate the Source and saved Agent grants against the currently selected Namespace registry. */
export function admitOpenShellRepositoryCredentials(
  registry: GitHubRepositoryRegistry | undefined,
  input: OpenShellRepositorySourceSelection & {
    readonly grants: readonly RepositoryNetworkGrant[];
  },
): ReturnType<NonNullable<ControllerOptions["repositoryCredentialAdmission"]>> {
  if (!registry || !input.grants.length) {
    return undefined;
  }
  try {
    const { namespaceId, source, bindings, grants } = input;
    const scope = resolveSelectedRepositoryScope(registry, namespaceId, bindings);
    const selected = selectedSourceRepositories(registry, input, scope);
    if (
      !grants.every((grant) =>
        selected.some(
          ({ repository, access }) =>
            repository === grant.repository && (access === "write" || grant.access === "read"),
        ),
      )
    ) {
      return undefined;
    }
    const gitRequests = openShellRepositoryCredentialRequests(grants);
    const publicNetworkRequests = grants.map(({ repository }) =>
      openShellRepositoryMetadataRequest(repository),
    );
    if (source.scope.permissions.pull_requests !== "write") {
      return { credentialRequests: gitRequests, publicNetworkRequests };
    }
    // Registry policy can use a short name. The request must use GitHub's verified full name.
    const scopedRest = scope.scopedRest.flatMap((authority) => {
      const verified = selected.find((entry) =>
        matchesConfiguredGitHubRepository(authority, entry),
      );
      return verified ? [{ ...authority, repository: verified.repository }] : [];
    });
    // A PR body can name a private fork head covered by the shared installation token.
    const authority = restrictRepositoryPullRequestCreation(
      scopedRest,
      source.scope.repositories,
      grants,
    );
    const publication = repositoryGitRestOperations(grants, authority).flatMap(
      ({ repository, pull_requests }) =>
        pull_requests === "write" ? [githubPullRequestCreationRequest(repository)] : [],
    );
    return { credentialRequests: [...gitRequests, ...publication], publicNetworkRequests };
  } catch {
    return undefined;
  }
}
