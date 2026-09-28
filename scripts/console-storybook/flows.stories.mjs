import { story } from "./story.mjs";

export default { title: "Flows" };

export const CreateFlow = { ...story("createFlow"), name: "Create and deploy an Agent" };
export const CreateHarnessFlow = {
  ...story("createHarnessFlow"),
  name: "Choose provider, harness, and authentication",
};
export const UpdateFlow = { ...story("updateFlow"), name: "Update an Agent" };
export const SlackChannelAccessFlow = {
  ...story("slackChannelAccessFlow"),
  name: "Change Slack channel senders",
};
export const StopFlow = { ...story("stopFlow"), name: "Stop an Agent" };
export const CreateExitFlow = {
  ...story("createExitFlow"),
  name: "Restart Agent creation",
};
export const CreateWorkspaceFilesFlow = {
  ...story("createWorkspaceFlow"),
  name: "Create with workspace files",
};
export const CreateSlackSecretsFlow = {
  ...story("createSlackSecretsFlow"),
  name: "Create with Slack Secrets",
};
export const DevdayCreateFlow = {
  ...story("devdayCreateFlow"),
  name: "DevDay segment 1: create devday claw",
};
export const DevdayCreateCheckpoint = {
  ...story("devdayCreateCheckpoint"),
  name: "DevDay segment 1 checkpoint: deployed devday claw",
};
export const DevdayAdminFlow = {
  ...story("devdayAdminFlow"),
  name: "DevDay segment 2: oceclaw Admin UI",
};
export const DevdayAdminCheckpoint = {
  ...story("devdayAdminCheckpoint"),
  name: "DevDay segment 2 checkpoint: oceclaw detail",
};
export const DeleteFlow = { ...story("deleteFlow"), name: "Delete an Agent" };
