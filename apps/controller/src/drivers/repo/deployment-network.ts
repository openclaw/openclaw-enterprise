import { isDeepStrictEqual } from "node:util";
import { repositoryGitDeliveryProfile } from "@openclaw-enterprise/contracts";
import type { AgentRevision, SandboxDeploymentGrants } from "@openclaw-enterprise/contracts";
import { githubActionsDownloads } from "./github/actions-downloads.ts";

/** Check the saved declaration against the repository that authorized it at Deploy. */
export function repositoryDeploymentGrantsMatch(
  revision: Readonly<AgentRevision>,
  grants: SandboxDeploymentGrants,
): boolean {
  const { executionAdmission, egressPlan, repositoryCredentials, sandboxPolicy } = revision;
  return (
    executionAdmission.version === 5 &&
    egressPlan?.repositoryGitAuthorization === "online-request" &&
    sandboxPolicy?.repositoryNetworkPolicy === undefined &&
    repositoryCredentials?.driver?.implementation === "github" &&
    repositoryGitDeliveryProfile(repositoryCredentials) === "github_repository" &&
    isDeepStrictEqual(repositoryCredentials, egressPlan.repositoryGit) &&
    isDeepStrictEqual(grants, githubActionsDownloads)
  );
}
