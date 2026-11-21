import type {
  AdmittedRepositoryBinding,
  AgentRevision,
  RepositoryNetworkGrant,
} from "@openclaw-enterprise/contracts";

export type RepositoryGitRestAuthority = readonly Readonly<{
  repository: string;
  version?: "v1" | "v2";
  readIssues: boolean;
  createIssues?: true;
  createPullRequests?: true;
}>[];

export type ScopedRepositoryRestWrites = Readonly<{
  pullRequestRepositories: readonly string[];
  issueCreationRepositories: readonly string[];
}>;

/** Intersect the frozen Git grants with the repository owner's scoped REST authority. */
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
      createIssues: write && rest?.version === "v2" && rest.createIssues === true,
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
        readonly repositories: readonly Readonly<{ repositoryId: string; repository: string }>[];
        readonly scopedRest?: RepositoryGitRestAuthority;
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
