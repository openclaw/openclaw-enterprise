import { story } from "./story.ts";

export default { title: "Components/Workspace" };

export const Workspace = { ...story("workspace"), name: "Editable files" };
export const WorkspaceUnavailable = {
  ...story("workspaceUnavailable"),
  name: "No deployed revision",
};
export const WorkspaceDenied = { ...story("workspaceDenied"), name: "Access denied" };
export const WorkspaceSaveDenied = { ...story("workspaceSaveDenied"), name: "Save denied" };
export const WorkspaceMissing = { ...story("workspaceMissing"), name: "Missing file" };
export const WorkspaceResourceMissing = {
  ...story("workspaceResourceMissing"),
  name: "Agent unavailable while reading a file",
};
export const WorkspaceUnknown = { ...story("workspaceUnknown"), name: "Write outcome unknown" };

export const WorkspaceNavigation = story("workspaceNavigation");

export const WorkspaceMissingReadback = {
  ...story("workspaceMissingReadback"),
  name: "Missing file after uncertain create",
};
export const WorkspaceCleanCRLF = story("workspaceCleanCRLF");
export const WorkspaceVersionReread = {
  ...story("workspaceVersionReread"),
  name: "Reread after a version change",
};
export const WorkspaceVersionRereadUnconfirmed = {
  ...story("workspaceVersionRereadUnconfirmed"),
  name: "Reread cannot confirm a missing file",
};
export const WorkspaceVersionRereadFocused = {
  ...story("workspaceVersionRereadFocused"),
  name: "Reread keeps a focused editor's caret",
};
