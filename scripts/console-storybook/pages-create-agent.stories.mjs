import { story } from "./story.mjs";

export default { title: "Pages/Create Agent" };

export const CreateStart = { ...story("createStart"), name: "Choose a starting point" };
export const CreateForm = { ...story("createForm"), name: "Dedicated form" };
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
export const CreateProvisioningSecrets = {
  ...story("createProvisioningSecrets"),
  name: "Provisioning with saved Secrets",
};
export const CreateUnsupportedProvisioning = {
  ...story("createUnsupportedProvisioning"),
  name: "Unsupported provisioning",
};
export const CreateWorkspaceFiles = { ...story("createWorkspaceFiles"), name: "Workspace files" };
export const CreateEmbedded = { ...story("createEmbedded"), name: "Embedded form" };
export const CreatePreset = { ...story("createPreset"), name: "Preset variables" };
export const CreateNoPresets = { ...story("createNoPresets"), name: "No Presets" };
export const CreateDiscoveryError = {
  ...story("createDiscoveryError"),
  name: "Optional discovery denied",
};
export const CreateInvalid = { ...story("createInvalid"), name: "Invalid JSON" };
export const CreateConflict = { ...story("createConflict"), name: "Provisioning conflict" };
export const CreateUnknown = { ...story("createUnknown"), name: "Provisioning outcome unknown" };
