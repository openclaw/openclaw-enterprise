import type {
  AdmittedRepositoryBinding,
  AgentRevision,
  RepositoryApiAction,
  RepositoryApiActions,
  RepositoryApiActionFilterOption,
  RepositoryNetworkGrant,
} from "@openclaw-enterprise/contracts";

export type RepositoryGitRestAuthority = readonly Readonly<{
  repository: string;
  readIssues: boolean;
  createIssues?: true;
  readPullRequests?: true;
  createPullRequests?: true;
}>[];

export function permitsRepositoryApiAction(
  filter: RepositoryApiActions | undefined,
  action: RepositoryApiAction,
): boolean {
  return (
    !filter || ("allow" in filter ? filter.allow.includes(action) : !filter.deny.includes(action))
  );
}

/** Apply per-grant restrictions to the owner's scoped REST authority. */
export function repositoryGitRestOperations(
  grants: readonly RepositoryNetworkGrant[],
  authority: RepositoryGitRestAuthority | undefined,
): readonly RepositoryApiActionFilterOption[] {
  return Object.freeze(
    grants.map(({ repository, access, apiActions }) => {
      const rest = authority?.find((entry) => entry.repository === repository);
      const write = access === "write";
      const available: RepositoryApiAction[] = [];
      if (rest?.readIssues === true) {
        available.push("issues:read");
      }
      if (write && rest?.createIssues === true) {
        available.push("issues:create");
      }
      if (rest?.readPullRequests === true) {
        available.push("pull_requests:read");
      }
      if (write && rest?.createPullRequests === true) {
        available.push("pull_requests:create");
      }
      return Object.freeze({
        repository,
        access,
        available: Object.freeze(
          available.filter((action) => permitsRepositoryApiAction(apiActions, action)),
        ),
      });
    }),
  );
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
        readonly nativeGit?: "v1";
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
