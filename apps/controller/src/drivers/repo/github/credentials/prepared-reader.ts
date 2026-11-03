import {
  createWarmTokenReader,
  type WarmTokenResult,
} from "../../../../backends/token-service/warm-reader.ts";
import type { GitHubPreparationAdmission } from "./prepared-contracts.ts";

export const createGitHubWarmReader = createWarmTokenReader<GitHubPreparationAdmission>;
export type GitHubWarmResult = WarmTokenResult<GitHubPreparationAdmission>;
