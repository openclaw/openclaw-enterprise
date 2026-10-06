export { createGitHubDriverFactory } from "./factory.ts";
export { createGitHubKeyOwner } from "./material.ts";
export { classifyGitHubToken, createGitHubStaticTokenOwner } from "./static-token.ts";
export type {
  GitHubAuthority,
  GitHubConfiguration,
  GitHubFactoryOptions,
  GitHubKeyOwner,
  GitHubStaticTokenOwner,
  GitHubTokenClass,
} from "./types.ts";
