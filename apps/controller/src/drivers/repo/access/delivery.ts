import type { AdmittedRepositoryBinding, AgentRevision } from "@openclaw-enterprise/contracts";

/** Nonsecret delivery scope resolved by Repo, independently of token issuance or transport. */
export interface RepositoryGitDeliveryBinding {
  readonly binding: AdmittedRepositoryBinding;
  readonly delivery:
    | ({
        readonly scope: "github-repository";
        readonly repository?: never;
        readonly repositories: readonly Readonly<{ repositoryId: string; repository: string }>[];
        readonly nativeGit?: "v1";
        readonly permissions: Readonly<Record<string, string>>;
      } & (
        | { readonly installationId: string; readonly tokenSource?: never }
        /** A token registry's providerInstanceId: native Git only, lent rather than issued. */
        | {
            readonly installationId?: never;
            readonly tokenSource: string;
            readonly nativeGit: "v1";
          }
      ))
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
