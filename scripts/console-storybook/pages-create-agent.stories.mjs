import { story } from "./story.mjs";

export default { title: "Pages/Create Agent" };

export const CreateStart = { ...story("createStart"), name: "Choose a starting point" };
export const CreateForm = { ...story("createForm"), name: "Dedicated form" };
export const CreateWorkspaceFiles = { ...story("createWorkspaceFiles"), name: "Workspace files" };
export const CreateEmbedded = { ...story("createEmbedded"), name: "Embedded form" };
export const CreatePreset = { ...story("createPreset"), name: "Preset variables" };
export const CreateNoPresets = { ...story("createNoPresets"), name: "No Presets" };
export const CreateAnthropic = { ...story("createAnthropic"), name: "Anthropic API key" };
export const CreateModels = { ...story("createModels"), name: "Choose an available model" };
export const CreateModelsEmpty = { ...story("createModelsEmpty"), name: "No model choices" };
export const CreateModelsUnavailable = {
  ...story("createModelsUnavailable"),
  name: "Model discovery unavailable",
};
export const CreateSecretDenied = {
  ...story("createSecretDenied"),
  name: "API key storage denied",
};
export const CreateGrantDenied = { ...story("createGrantDenied"), name: "Credential access retry" };
export const CreateInvalid = { ...story("createInvalid"), name: "Invalid JSON" };
export const CreateConflict = { ...story("createConflict"), name: "Partial save and conflict" };
export const CreateUnknown = { ...story("createUnknown"), name: "Save outcome unknown" };
