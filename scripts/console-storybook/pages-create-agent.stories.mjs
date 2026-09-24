import { story } from "./story.mjs";

export default { title: "Pages/Create Agent" };

export const CreateStart = { ...story("createStart"), name: "Choose a starting point" };
export const CreateForm = { ...story("createForm"), name: "OpenAI with Codex harness" };
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
export const CreateUnsupportedProvisioning = {
  ...story("createUnsupportedProvisioning"),
  name: "Unsupported provisioning",
};
export const CreateWorkspaceFiles = { ...story("createWorkspaceFiles"), name: "Workspace files" };
export const CreateEmbedded = { ...story("createEmbedded"), name: "OpenAI with OpenClaw harness" };
export const RepositorySelection = {
  ...story("createRepositoriesSelected"),
  name: "Approved repositories and shared access",
};
export const RepositoryContributor = {
  ...story("createRepositoriesContributor"),
  name: "Contributor access and write limits",
};
export const RepositoryCollaborator = {
  ...story("createRepositoriesCollaborator"),
  name: "Collaborator access and write limits",
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
  name: "Optional repository service unavailable",
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
export const CreatePasswordPresetDraft = {
  ...story("createPasswordPresetDraft"),
  name: "Standard Codex password draft",
};
export const CreatePasswordPresetDenied = {
  ...story("createPasswordPresetDenied"),
  name: "Password Secret creation denied",
};
