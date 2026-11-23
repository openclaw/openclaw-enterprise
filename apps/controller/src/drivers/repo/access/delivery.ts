import type {
  AdmittedRepositoryBinding,
  AgentRevision,
  RepositoryNetworkGrant,
} from "@openclaw-enterprise/contracts";

export type RepositoryGitRestAuthority = readonly Readonly<{
  repository: string;
  readIssues: boolean;
  readPullRequests?: true;
  createPullRequests?: true;
}>[];

/**
 * Intersect the frozen Git grants with the repository owner's scoped REST authority.
 * Creating a pull request also requires the saved Write grant.
 */
export function repositoryGitRestOperations(
  grants: readonly RepositoryNetworkGrant[],
  authority: RepositoryGitRestAuthority | undefined,
) {
  return grants.map(({ repository, access }) => {
    const rest = authority?.find((entry) => entry.repository === repository);
    const write = access === "write";
    return {
      repository,
      readIssues: rest?.readIssues === true,
      readPullRequests: rest?.readPullRequests === true,
      createPullRequests: write && rest?.createPullRequests === true,
    };
  });
}

/** Nonsecret delivery scope resolved by Repo, independently of token issuance or transport. */
export interface RepositoryGitDeliveryBinding {
  readonly binding: AdmittedRepositoryBinding;
  readonly delivery:
    | {
        readonly scope: "github-repository";
        readonly repository?: never;
        readonly installationId: string;
        readonly credentialSource?: never;
        readonly repositories: readonly Readonly<{ repositoryId: string; repository: string }>[];
        readonly nativeGit?: "v1";
        readonly scopedRest?: RepositoryGitRestAuthority;
        readonly permissions: Readonly<Record<string, string>>;
      }
    | {
        readonly scope: "github-repository";
        readonly repository?: never;
        readonly installationId?: never;
        /** The registration's TokenService Source ID: native Git only, lent rather than issued. */
        readonly credentialSource: string;
        readonly repositories: readonly Readonly<{ repositoryId: string; repository: string }>[];
        readonly nativeGit: "v1";
        readonly scopedRest?: never;
        readonly permissions: Readonly<Record<string, string>>;
      }
    | { readonly repository: string; readonly installationId?: never }
    | { readonly repository?: never; readonly installationId: string };
  readonly repository?: {
    readonly pushRef: string;
    readonly draftPullRequest: boolean;
    readonly pullRequestBase?: string;
  };
}

export type RepositoryGitDeliveryResolver = (
  revision: Readonly<AgentRevision>,
) => RepositoryGitDeliveryBinding;
