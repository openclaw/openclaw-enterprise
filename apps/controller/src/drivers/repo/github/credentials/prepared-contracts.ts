import type { GitHubTokenProfile } from "./types.ts";
import type {
  TokenAdmission,
  TokenAttempt,
  TokenFamily,
  TokenMaterial,
  TokenReadPort,
  TokenPreparationStore,
} from "../../../../backends/token-service/custody.ts";

export interface GitHubPreparationAdmission extends TokenAdmission {
  readonly grant: Readonly<{
    id: string;
    isolationId: string;
    appId: string;
    installationId: string;
    repositoryId: string;
    repository: string;
    profile: GitHubTokenProfile;
    /** Only the repository Git family has an exact admitted review ref. */
    pushRef?: string;
    pullRequestBase?: string;
  }>;
}

export type GitHubPreparationAttempt = TokenAttempt<GitHubPreparationAdmission>;
export type GitHubPreparationFamily = TokenFamily<GitHubPreparationAdmission>;
export type GitHubPreparedMaterial = TokenMaterial<GitHubPreparationAdmission>;
export type GitHubPreparedReadPort = TokenReadPort<GitHubPreparationAdmission>;
export type GitHubPreparationStore = TokenPreparationStore<GitHubPreparationAdmission>;
