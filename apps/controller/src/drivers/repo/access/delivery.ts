import type {
  AdmittedRepositoryBinding,
  AgentRevision,
  RepositoryApiLevel,
  RepositoryApiLimits,
  RepositoryApiMaximum,
  RepositoryNetworkGrant,
} from "@openclaw-enterprise/contracts";

export type RepositoryGitRestAuthority = readonly Readonly<{
  repository: string;
  readIssues: boolean;
  createIssues?: true;
  readPullRequests?: true;
  createPullRequests?: true;
}>[];

/** A PR may name another repository covered by the same installation token as its head. */
export function restrictRepositoryPullRequestCreation(
  authority: RepositoryGitRestAuthority,
  credentialRepositories: readonly Readonly<{ repository: string }>[],
  grants: readonly RepositoryNetworkGrant[],
): RepositoryGitRestAuthority {
  const granted = new Set(grants.map(({ repository }) => repository));
  if (
    credentialRepositories.length > 0 &&
    credentialRepositories.every(({ repository }) => granted.has(repository))
  ) {
    return authority;
  }
  return Object.freeze(authority.map(({ createPullRequests, ...rest }) => Object.freeze(rest)));
}

export function limitRepositoryApi(
  limits: RepositoryApiLimits | undefined,
  resource: "issues" | "pull_requests",
  read: boolean,
  create: boolean,
): RepositoryApiLevel {
  const limit = limits?.[resource] ?? limits?.default;
  if (!read || limit === "none") {
    return "none";
  }
  return create && limit !== "read" ? "write" : "read";
}

/** Apply the saved Git access and API limits to the owner's scoped REST authority. */
export function repositoryGitRestOperations(
  grants: readonly RepositoryNetworkGrant[],
  authority: RepositoryGitRestAuthority | undefined,
): readonly RepositoryApiMaximum[] {
  return Object.freeze(
    grants.map(({ repository, access, apiLimits }) => {
      const rest = authority?.find((entry) => entry.repository === repository);
      const write = access === "write";
      return Object.freeze({
        repository,
        access,
        issues: limitRepositoryApi(
          apiLimits,
          "issues",
          rest?.readIssues === true,
          write && rest?.createIssues === true,
        ),
        pull_requests: limitRepositoryApi(
          apiLimits,
          "pull_requests",
          rest?.readPullRequests === true,
          write && rest?.createPullRequests === true,
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
