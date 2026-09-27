import { story } from "./story.mjs";

export default { title: "Pages/Agent detail" };

export const Draft = story("draft");
export const NewVersion = story("newVersion");
export const ConfigurationEditor = { ...story("configurationEditor"), name: "Edit Configuration" };
export const InvalidConfiguration = {
  ...story("invalidConfiguration"),
  name: "Invalid Configuration JSON",
};
export const Admitted = story("admitted");
export const RepositoryDraft = {
  ...story("repositoryDraft"),
  name: "Repository access in new version",
};
export const RepositoryAdmitted = {
  ...story("repositoryAdmitted"),
  name: "Repository access in current version",
};
export const DeploymentPending = story("deploymentPending");
export const DeploymentRunning = story("deploymentRunning");
export const CurrentVersionDuringDeployment = story("currentVersionDuringDeployment");
export const DeploymentFailed = story("deploymentFailed");
export const DeploymentFailedAfterSelection = story("deploymentFailedAfterSelection");
export const DeploymentSucceeded = story("deploymentSucceeded");
export const DeploymentUnavailable = story("deploymentUnavailable");
export const DiagnosticsSuccess = story("diagnosticsSuccess");
export const DiagnosticsUnknown = story("diagnosticsUnknown");
export const DiagnosticsUnavailable = story("diagnosticsUnavailable");
export const AgentMissing = { ...story("agentMissing"), name: "Agent unavailable" };
export const ConfigurationError = {
  ...story("configurationError"),
  name: "Configuration unavailable",
};
export const RevisionError = { ...story("revisionError"), name: "Revision history unavailable" };
export const DeployDenied = { ...story("deployDenied"), name: "Deployment denied" };

export const ConfigurationNavigation = story("configurationNavigation");

export const RevisionDeployDenied = {
  ...story("revisionDeployDenied"),
  name: "New version deployment denied",
};
export const RevisionCredentialsMissing = {
  ...story("revisionCredentialsMissing"),
  name: "New version missing credentials",
};
