import { story } from "./story.mjs";

export default { title: "Pages/Create Agent" };

export const CreateStart = { ...story("createStart"), name: "Choose a starting point" };
export const CreateForm = { ...story("createForm"), name: "OpenAI with Codex harness" };
export const PluginsUnavailable = {
  ...story("createPluginsUnavailable"),
  name: "Plugin discovery needs a service account credential",
};
export const PluginsConfigured = {
  ...story("createPluginsConfigured"),
  name: "Edit existing plugin policies",
};
export const PluginsCurated = story("createPluginsCurated");
export const PluginsDiscovered = story("createPluginsDiscovered");
export const PluginsPrefetch = story("createPluginsPrefetch");
export const PluginsSearchLoading = story("createPluginsSearchLoading");
export const PluginsToolsLoading = story("createPluginsToolsLoading");
export const PluginsSelectedSecret = story("createPluginsSelectedSecret");
export const PluginsSelectedSecretDenied = story("createPluginsSelectedSecretDenied");
export const PluginsTools = story("createPluginsTools");
export const PluginsPolicies = story("createPluginsPolicies");
export const PluginApproversMissingSecret = story("createPluginApproversMissingSecret");
export const PluginsSetupReminder = story("createPluginsSetupReminder");
export const PluginsSecondPage = story("createPluginsSecondPage");
export const PluginsEmpty = story("createPluginsEmpty");
export const PluginsLoading = story("createPluginsLoading");
export const PluginsRejected = story("createPluginsRejected");
export const PluginsError = story("createPluginsError");
export const PluginsDetailsError = story("createPluginsDetailsError");
export const CreateSlackSecretMenu = {
  ...story("createSlackSecretMenu"),
  name: "Slack Secret menu before Agent exists",
};
export const CreateSlackCreateSecretModal = {
  ...story("createSlackCreateSecretModal"),
  name: "Create Slack Secret before Agent exists",
};
export const CreateSlackSecretStaged = {
  ...story("createSlackSecretStaged"),
  name: "Slack Secret bindings staged",
};
export const CreateSlackChannelAccessRequired = {
  ...story("createSlackChannelAccessRequired"),
  name: "Slack channel sender required",
};
export const CreateSlackAllowEveryone = {
  ...story("createSlackAllowEveryone"),
  name: "Slack allow everyone",
};
export const CreateProvisioningSecrets = {
  ...story("createProvisioningSecrets"),
  name: "Provisioning with saved Secrets",
};
export const CreateDeploymentPending = story("createDeploymentPending");
export const CreateDeploymentFailed = story("createDeploymentFailed");
export const CreateUnsupportedProvisioning = {
  ...story("createUnsupportedProvisioning"),
  name: "Unsupported provisioning",
};
export const CreatePresetWorkspaceFiles = {
  ...story("createPresetWorkspaceFiles"),
  name: "Preset workspace files",
};
export const CreateWorkspaceFiles = { ...story("createWorkspaceFiles"), name: "Workspace files" };
export const CreateDedicatedOpenclaw = story("createDedicatedOpenclaw");
export const CreateEmbedded = { ...story("createEmbedded"), name: "Embedded OpenClaw" };
export const CreateDedicatedOpenclawExperimental = {
  ...story("createDedicatedOpenclawExperimental"),
  name: "Experimental Dedicated OpenClaw",
};
export const RepositorySelection = {
  ...story("createRepositoriesSelected"),
  name: "Repositories using the Agent default",
};
export const RepositoryDetails = story("createRepositoriesDetails");
export const RepositoryDescriptionsPending = story("createRepositoriesDescriptionsPending");
export const RepositoryContributor = {
  ...story("createRepositoriesContributor"),
  name: "Contributor without issue management",
};
export const RepositoryCollaborator = {
  ...story("createRepositoriesCollaborator"),
  name: "Contributor with issue management",
};
export const RepositoryEmpty = {
  ...story("createRepositoriesEmpty"),
  name: "No approved repositories",
};
export const RepositoryLoading = {
  ...story("createRepositoriesLoading"),
  name: "Repository discovery pending",
};
export const RepositoryUnavailable = {
  ...story("createRepositoriesUnavailable"),
  name: "Repository choices unavailable",
};
export const RepositoryDenied = {
  ...story("createRepositoriesDenied"),
  name: "Repository discovery denied",
};
export const RepositoryAmbiguous = {
  ...story("createRepositoriesAmbiguous"),
  name: "Repository authorization unverified",
};
export const RepositoryRecovery = {
  ...story("createRepositoriesRecovery"),
  name: "Reselect repositories after rejection",
};
export const CreatePreset = { ...story("createPreset"), name: "Preset variables" };
export const CreateBoundCredentialPreset = {
  ...story("createBoundCredentialPreset"),
  name: "Preset with saved model credential",
};
export const CreateNoPresets = { ...story("createNoPresets"), name: "No Presets" };
export const CreateAnthropic = {
  ...story("createAnthropic"),
  name: "Anthropic with OpenClaw harness",
};
export const CreateCodexPat = { ...story("createCodexPat"), name: "Service Accounts" };
export const CreateOAuth = story("createOAuth");
export const CreateOAuthPending = story("createOAuthPending");
export const CreateOAuthReady = story("createOAuthReady");
export const CreateOAuthDenied = story("createOAuthDenied");
export const CreateOAuthUnavailable = story("createOAuthUnavailable");
export const CreateOAuthError = story("createOAuthError");
export const CreateOAuthExpired = story("createOAuthExpired");
export const CreatePatToOpenClaw = {
  ...story("createPatToOpenClaw"),
  name: "Switch from Service Accounts to OpenClaw",
};
export const CreateBoundPatPreset = {
  ...story("createBoundPatPreset"),
  name: "Preset with saved service account token",
};
export const CreateModels = {
  ...story("createModels"),
  name: "Model choices before credential entry",
};
export const CreateModelManual = { ...story("createModelManual"), name: "Enter another model ID" };
export const CreateSecretDenied = {
  ...story("createSecretDenied"),
  name: "API key storage denied",
};
export const CreateGrantDenied = { ...story("createGrantDenied"), name: "Credential access retry" };
export const CreateInvalid = { ...story("createInvalid"), name: "Invalid JSON" };
export const CreateConflict = { ...story("createConflict"), name: "Provisioning conflict" };
export const CreateUnknown = { ...story("createUnknown"), name: "Provisioning outcome unknown" };

export const CreatePasswordPreset = {
  ...story("createPasswordPreset"),
  name: "Standard Codex password variable",
};
export const CreatePasswordPresetMissingModel = {
  ...story("createPasswordPresetMissingModel"),
  name: "Standard Codex missing model",
};
export const CreatePasswordPresetDraft = {
  ...story("createPasswordPresetDraft"),
  name: "Standard Codex password draft",
};
export const CreatePasswordPresetDenied = {
  ...story("createPasswordPresetDenied"),
  name: "Password Secret creation denied",
};

export const RepositoryOne = story("createRepositories1");
export const RepositoryFive = story("createRepositories5");
export const RepositoryTwentyFive = story("createRepositories25");
export const RepositoryLargeCatalog = story("createRepositories140");
export const RepositoryExactSearch = story("createRepositoriesExactSearch");
export const RepositoryCustom = story("createRepositoriesCustom");
export const RepositoryPolicyConflict = story("createRepositoriesPolicyConflict");

export const CreateStandardOpenclawPreset = {
  ...story("createStandardOpenclawPreset"),
  name: "Standard OpenClaw preset",
};

export const CreatePresetExistingSecret = {
  ...story("createPresetExistingSecret"),
  name: "SWE existing service account Secret",
};
export const CreatePresetSecretsLoading = {
  ...story("createPresetSecretsLoading"),
  name: "Preset Secrets loading",
};
export const CreatePresetSecretsDenied = {
  ...story("createPresetSecretsDenied"),
  name: "Preset Secret metadata denied",
};
export const CreatePresetSecretsEmpty = {
  ...story("createPresetSecretsEmpty"),
  name: "No existing Preset Secrets",
};

export const CreatePresetNavigation = story("createPresetNavigation");

export const PresetVariableNavigation = story("presetVariableNavigation");

export const RepositoryNavigationOutage = story("createRepositoryNavigationOutage");
