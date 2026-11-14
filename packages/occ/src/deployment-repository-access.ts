export interface DeploymentRepositoryAccessStatus {
  readonly state: "redeploy-required";
  readonly code: "REPOSITORY_EXECUTION_REDEPLOY_REQUIRED";
  readonly message: string;
}

export const repositoryExecutionRedeployMessage =
  "The controller can no longer renew this version's repository access on its current runtime. Deploy again to restore repository access.";

export function deploymentRepositoryAccessStatus(
  redeployRequired: boolean,
): DeploymentRepositoryAccessStatus | undefined {
  if (!redeployRequired) {
    return undefined;
  }
  return Object.freeze({
    state: "redeploy-required",
    code: "REPOSITORY_EXECUTION_REDEPLOY_REQUIRED",
    message: repositoryExecutionRedeployMessage,
  });
}
