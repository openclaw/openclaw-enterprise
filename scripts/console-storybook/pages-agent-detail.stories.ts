import { story } from "./story.ts";

export const PluginsOAuthRevision = story("pluginsOAuthRevision");

export default { title: "Pages/Agent detail" };

export const Draft = story("draft");
export const NewVersion = story("newVersion");
export const FailedFirstVersion = story("failedFirstVersion");
export const EditCurrentConfiguration = story("editCurrentConfiguration");
export const CurrentConfigurationReader = story("currentConfigurationReader");
export const HeaderActions = story("agentHeaderActions");
export const EarlierFailedVersion = story("earlierFailedVersion");
export const LongVersionHistory = story("longVersionHistory");
export const FirstDeployment = story("draftAutomaticCredentials");
export const ConfigurationEditor = { ...story("configurationEditor"), name: "Edit Configuration" };
export const ConfigurationSaveRefused = story("configurationSaveRefused");
export const ConfigurationSaveUnconfirmed = story("configurationSaveUnconfirmed");
export const GatewayPasswordAccess = story("gatewayPasswordAccess");
export const GatewayPasswordEnabled = story("gatewayPasswordEnabled");
export const GatewayPasswordSaveDenied = story("gatewayPasswordSaveDenied");
export const GatewayPasswordSaving = story("gatewayPasswordSaving");
export const PluginsDraft = story("pluginsDraft");
export const PluginsUpdateDenied = story("pluginsUpdateDenied");
export const DraftReader = story("draftReader");
export const DraftSourcesOperateDenied = story("draftSourcesOperateDenied");
export const PluginsToolRefusal = story("pluginsToolRefusal");
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
export const InvalidConfigurationInvisibleCharacters = story(
  "invalidConfigurationInvisibleCharacters",
);
export const ConfigurationChangedElsewhereMerged = story("configurationChangedElsewhereMerged");
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
export const DeploymentRunningActivates = story("deploymentRunningActivates");
export const DeploymentCompletesRereadFails = story("deploymentCompletesRereadFails");
export const DeploymentStatusReadRecovers = story("deploymentStatusReadRecovers");
export const DeploymentActivityLoading = story("deploymentActivityLoading");
export const CurrentVersionDuringDeployment = story("currentVersionDuringDeployment");
export const DeploymentFailed = story("deploymentFailed");
export const SandboxLost = story("sandboxLost");
export const SandboxRunning = story("sandboxRunning");
export const SandboxStatusUnknown = story("sandboxStatusUnknown");
export const AgentHeader = story("agentHeader");
export const AgentHeaderMobile = story("agentHeaderMobile");
export const AgentHeaderNoClipboard = story("agentHeaderNoClipboard");
export const DraftCredentialRejected = story("draftCredentialRejected");
export const DeploymentFailedLogsFromDraft = story("deploymentFailedLogsFromDraft");
export const DeploymentModelProbeFailed = story("deploymentModelProbeFailed");
export const DeploymentFailsWhileWatching = story("deploymentFailsWhileWatching");
export const DeploymentModelProbeRetried = story("deploymentModelProbeRetried");
export const DeploymentModelProbeFailedReadOnly = story("deploymentModelProbeFailedReadOnly");
export const DeploymentModelProbeFailedDeployOnly = story("deploymentModelProbeFailedDeployOnly");
export const DeploymentModelProbeFailedConfigurationEditor = story(
  "deploymentModelProbeFailedConfigurationEditor",
);
export const DeploymentFailedDeployAgain = story("deploymentFailedDeployAgain");
export const DeploymentFailedDeployAgainUnreadable = story("deploymentFailedDeployAgainUnreadable");
export const DeploymentFailedAdmissionUnavailable = story("deploymentFailedAdmissionUnavailable");
export const DeploymentFailedStoredInconsistent = story("deploymentFailedStoredInconsistent");
export const DeploymentModelProbeFailedDeployOnlyUnreadable = story(
  "deploymentModelProbeFailedDeployOnlyUnreadable",
);
export const DeploymentFailedAfterSelection = story("deploymentFailedAfterSelection");
export const DeploymentStopped = story("deploymentStopped");
export const DeploymentSuperseded = story("deploymentSuperseded");
export const DeploymentSucceeded = story("deploymentSucceeded");
export const DeploymentUnavailable = story("deploymentUnavailable");
export const DiagnosticsSuccess = story("diagnosticsSuccess");
export const DiagnosticsFast = story("diagnosticsFast");
export const DiagnosticsReader = story("diagnosticsReader");
export const DangerZoneReader = story("dangerZoneReader");
export const DiagnosticsRefused = story("diagnosticsRefused");
export const DiagnosticsUnknown = story("diagnosticsUnknown");
export const DiagnosticsUnavailable = story("diagnosticsUnavailable");
export const RuntimeLogs = story("runtimeLogs");
export const RuntimeLogsSlowFirstStatus = story("runtimeLogsSlowFirstStatus");
export const RuntimeLogsSlowTabClick = story("runtimeLogsSlowTabClick");
export const RuntimeLogsStartupWarnings = story("runtimeLogsStartupWarnings");
export const RuntimeLogsDedicatedPods = story("runtimeLogsDedicatedPods");
export const RuntimeLogsFilteredDownload = story("runtimeLogsFilteredDownload");
export const RuntimeLogsRateLimited = story("runtimeLogsRateLimited");
export const RuntimeLogsRefreshRateLimited = story("runtimeLogsRefreshRateLimited");
export const RuntimeLogsDenied = story("runtimeLogsDenied");
export const RuntimeLogPodReplaced = story("runtimeLogPodReplaced");
export const RuntimeLogAccessLost = story("runtimeLogAccessLost");
export const RuntimeLogDownloadRefused = story("runtimeLogDownloadRefused");
export const RuntimeStatusAccessLost = story("runtimeStatusAccessLost");
export const RuntimeStatusAccessRestored = story("runtimeStatusAccessRestored");
export const RuntimeLogsReaderDownload = story("runtimeLogsReaderDownload");
export const RuntimeLogsReaderNoPodDownload = story("runtimeLogsReaderNoPodDownload");
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
export const TabLinkUnavailable = {
  ...story("tabLinkUnavailable"),
  name: "Link to an unavailable tab",
};
export const DeploySecretOperateDenied = {
  ...story("deploySecretOperateDenied"),
  name: "Deployment needs Secret operate",
};
export const DeployInProgress = { ...story("deployInProgress"), name: "Deployment in progress" };
export const DeployHoldsNavigation = {
  ...story("deployHoldsNavigation"),
  name: "Deployment holds navigation",
};
export const DeployRefusedBeforeAdmission = {
  ...story("deployRefusedBeforeAdmission"),
  name: "Deployment refused before admission",
};
export const DeployOutcomeUnknown = {
  ...story("deployOutcomeUnknown"),
  name: "Deployment outcome unknown",
};
export const DeployRefusedSetting = {
  ...story("deployRefusedSetting"),
  name: "Deployment refused by a Configuration setting",
};
export const DeployOpensVersion = {
  ...story("deployOpensVersion"),
  name: "Deployment opens the new version",
};
export const DeployAgentPrincipalDenied = {
  ...story("deployAgentPrincipalDenied"),
  name: "Deployment denied for the Agent's service principal",
};

export const RepositoryEditor = story("repositoryEditor");
export const RepositoryEditorUpdateDenied = story("repositoryEditorUpdateDenied");
export const RepositoryEditorNotConfigured = story("repositoryEditorNotConfigured");
export const RepositoryEditorLoading = story("repositoryEditorLoading");
export const RepositoryEditorSaveRefused = story("repositoryEditorSaveRefused");
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
export const SharingRequiredFields = { ...story("agentSharingRequiredFields") };
export const PluginsRequiredFields = { ...story("agentPluginsRequiredFields") };
export const AuthenticationRequiredFields = { ...story("agentAuthenticationRequiredFields") };
export const WorkspaceRequiredFields = { ...story("agentWorkspaceRequiredFields") };
export const SharingGranted = { ...story("agentSharingGranted") };
export const SharingHoldsNavigation = { ...story("agentSharingHoldsNavigation") };
export const SharingHoldsAfterDelete = { ...story("agentSharingHoldsAfterDelete") };
export const SharingRemoved = { ...story("agentSharingRemoved") };
export const SharingDenied = { ...story("agentSharingDenied") };
export const SharingUnknown = { ...story("agentSharingUnknown") };

export const BootstrapFailureCleanupPending = story("deploymentBootstrapCleanup");
export const BootstrapContainerStatusAndLogs = story("runtimeBootstrapContainers");

export const PolicyDenials = story("policyDenials");
export const PolicyUnicodeExecutable = story("policyUnicodeExecutable");
export const PolicyDenialsEmpty = story("policyDenialsEmpty");
export const PolicyDenialsDisabled = story("policyDenialsDisabled");
export const PolicyDenialsUnsupported = story("policyDenialsUnsupported");
export const PolicyDenialsGap = story("policyDenialsGap");
export const PolicyDenialsMissingMetadata = story("policyDenialsMissingMetadata");
export const PolicyDenialsFailed = story("policyDenialsFailed");
export const PolicyApplicationCeilingChanged = story("policyApplicationCeilingChanged");
export const PolicyDenialsApplyRejected = story("policyDenialsApplyRejected");
export const PolicyIncompletePreview = story("policyIncompletePreview");
export const PolicyUnconfirmedSave = story("policyUnconfirmedSave");
export const PolicyDenialsEditDenied = story("policyDenialsEditDenied");
export const PolicyDenialsCeilingDenied = story("policyDenialsCeilingDenied");
export const PolicyDenialsSuggestionsUnavailable = story("policyDenialsSuggestionsUnavailable");
export const PolicyDenialsReadDenied = story("policyDenialsReadDenied");
export const PolicyDenialsLoading = story("policyDenialsLoading");
export const PolicyDenialsNoCredential = story("policyDenialsNoCredential");
export const PolicyDenialsProtected = story("policyDenialsProtected");

export const ConfigurationInvalid = story("policyConfigurationInvalid");
export const ConfigurationConflict = story("policyConfigurationConflict");

export const ConfigurationAlternateDriver = story("policyConfigurationAlternate");
export const ConfigurationDiscoveryLoading = story("policyConfigurationLoading");
export const ConfigurationDiscoveryDenied = story("policyConfigurationDenied");
export const ConfigurationStalePreview = story("policyConfigurationStale");
export const ConfigurationRefreshRace = story("policyConfigurationRefresh");
export const ConfigurationJsonFallback = story("policyConfigurationJson");

export const ConfigurationOwnerDenied = story("policyConfigurationHidden");
