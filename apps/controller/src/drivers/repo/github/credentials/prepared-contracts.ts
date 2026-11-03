import type { GitHubRepositoryGrant } from "./repository-grant.ts";
import type { GitHubTokenProfile } from "./types.ts";
import type {
  TokenAdmission,
  TokenAttempt,
  TokenFamily,
  TokenMaterial,
  TokenReadPort,
  TokenPreparationStore,
} from "../../../../backends/token-service/custody.ts";

type GrantIdentity = Readonly<{
  id: string;
  isolationId: string;
  appId: string;
  installationId: string;
}>;

/** Inherit this App installation's selection and permissions. There is no repository or ref override. */
export type GitHubInstallationGrant = GrantIdentity & Readonly<{ profile: "github-installation" }>;

export interface GitHubPreparationAdmission extends TokenAdmission {
  readonly grant:
    | GitHubRepositoryGrant
    | GitHubInstallationGrant
    | (GrantIdentity &
        Readonly<{
          repositoryId: string;
          repository: string;
          profile: GitHubTokenProfile;
          /** Only the repository Git family has an exact admitted review ref. */
          pushRef?: string;
          pullRequestBase?: string;
        }>);
}

export type GitHubPreparationAttempt = TokenAttempt<GitHubPreparationAdmission>;
export type GitHubPreparationFamily = TokenFamily<GitHubPreparationAdmission>;
export type GitHubPreparedMaterial = TokenMaterial<GitHubPreparationAdmission>;
export type GitHubPreparedReadPort = TokenReadPort<GitHubPreparationAdmission>;
export type GitHubPreparationStore = TokenPreparationStore<GitHubPreparationAdmission>;
