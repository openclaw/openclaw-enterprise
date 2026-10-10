import { story } from "./story.mjs";

export default { title: "Components/Workspace" };

export const Workspace = { ...story("workspace"), name: "Editable files" };
export const WorkspaceUnavailable = {
  ...story("workspaceUnavailable"),
  name: "No deployed revision",
};
export const WorkspaceDenied = { ...story("workspaceDenied"), name: "Access denied" };
export const WorkspaceMissing = { ...story("workspaceMissing"), name: "Missing file" };
export const WorkspaceUnknown = { ...story("workspaceUnknown"), name: "Write outcome unknown" };

export const WorkspaceNavigation = story("workspaceNavigation");

export const WorkspaceCleanCRLF = story("workspaceCleanCRLF");
