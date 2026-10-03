import { story } from "./story.mjs";

export const PluginsOAuthRevision = story("pluginsOAuthRevision");

export default { title: "Pages/Agent detail" };

export const Draft = story("draft");
export const NewVersion = story("newVersion");
export const FirstDeployment = story("draftAutomaticCredentials");
export const ConfigurationEditor = { ...story("configurationEditor"), name: "Edit Configuration" };
export const GatewayPasswordAccess = story("gatewayPasswordAccess");
export const GatewayPasswordEnabled = story("gatewayPasswordEnabled");
export const GatewayPasswordSaveDenied = story("gatewayPasswordSaveDenied");
export const GatewayPasswordSaving = story("gatewayPasswordSaving");
export const PluginsDraft = story("pluginsDraft");
export const PluginApproversInherited = story("pluginApproversInherited");
export const PluginApproversOverrides = story("pluginApproversOverrides");
export const PluginApproversLookup = story("pluginApproversLookup");
export const PluginApproversDirectoryUnavailable501 = story(
  "pluginApproversDirectoryUnavailable501",
);
export const PluginsAdmitted = story("pluginsAdmitted");
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
export const DeploymentDeferred = story("deploymentDeferred");
export const DeploymentRetrying = story("deploymentRetrying");
export const DeploymentRunning = story("deploymentRunning");
export const CurrentVersionDuringDeployment = story("currentVersionDuringDeployment");
export const DeploymentFailed = story("deploymentFailed");
export const DeploymentModelProbeFailed = story("deploymentModelProbeFailed");
export const DeploymentFailedAfterSelection = story("deploymentFailedAfterSelection");
export const DeploymentSucceeded = story("deploymentSucceeded");
export const DeploymentUnavailable = story("deploymentUnavailable");
export const DiagnosticsSuccess = story("diagnosticsSuccess");
export const DiagnosticsUnknown = story("diagnosticsUnknown");
export const DiagnosticsUnavailable = story("diagnosticsUnavailable");
export const RuntimeLogs = story("runtimeLogs");
export const RuntimeLogsStartupWarnings = story("runtimeLogsStartupWarnings");
export const RuntimeLogsFilteredDownload = story("runtimeLogsFilteredDownload");
export const RuntimeLogsDenied = story("runtimeLogsDenied");
export const RuntimeLogsClusterRbac = story("runtimeLogsClusterRbac");
export const AgentMissing = { ...story("agentMissing"), name: "Agent unavailable" };
export const ConfigurationError = {
  ...story("configurationError"),
  name: "Configuration unavailable",
};
export const UnreadableAgentConfiguration = story("unreadableAgentConfiguration");
export const UnreadableRevisionConfiguration = story("unreadableRevisionConfiguration");
export const RevisionError = { ...story("revisionError"), name: "Revision history unavailable" };
export const DeployDenied = { ...story("deployDenied"), name: "Deployment denied" };

export const RepositoryEditor = story("repositoryEditor");
export const ConfigurationNavigation = story("configurationNavigation");

export const RevisionDeployDenied = {
  ...story("revisionDeployDenied"),
  name: "New version deployment denied",
};
export const RevisionCredentialsMissing = {
  ...story("revisionCredentialsMissing"),
  name: "New version missing credentials",
};

export const Sharing = { ...story("agentSharing") };
export const SharingGranted = { ...story("agentSharingGranted") };
export const SharingRemoved = { ...story("agentSharingRemoved") };
export const SharingRoleChanged = story("agentSharingRoleChanged");
export const SharingRolesUnavailable = story("agentSharingRolesUnavailable");
export const SharingDenied = { ...story("agentSharingDenied") };
export const SharingUnknown = { ...story("agentSharingUnknown") };
