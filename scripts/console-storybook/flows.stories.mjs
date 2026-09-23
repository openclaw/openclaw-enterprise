import { story } from "./story.mjs";

export default { title: "Flows" };

export const CreateFlow = { ...story("createFlow"), name: "Create and deploy an Agent" };
export const CreateHarnessFlow = {
  ...story("createHarnessFlow"),
  name: "Choose provider and harness",
};
export const UpdateFlow = { ...story("updateFlow"), name: "Update an Agent" };
export const StopFlow = { ...story("stopFlow"), name: "Stop an Agent" };
export const CreateWorkspaceFilesFlow = {
  ...story("createWorkspaceFlow"),
  name: "Create with workspace files",
};
export const CreateSlackSecretsFlow = {
  ...story("createSlackSecretsFlow"),
  name: "Create with Slack Secrets",
};
export const DeleteFlow = { ...story("deleteFlow"), name: "Delete an Agent" };
