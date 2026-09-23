import { story } from "./story.mjs";

export default { title: "Pages/Agent detail" };

export const Draft = { ...story("draft"), name: "New revision" };
export const Admitted = { ...story("admitted"), name: "Admitted revision" };
export const DeploymentPending = { ...story("deploymentPending"), name: "Deployment pending" };
export const DeploymentFailed = { ...story("deploymentFailed"), name: "Deployment failed" };
export const AgentMissing = { ...story("agentMissing"), name: "Agent unavailable" };
export const ConfigurationError = {
  ...story("configurationError"),
  name: "Configuration unavailable",
};
export const RevisionError = { ...story("revisionError"), name: "Revision history unavailable" };
export const DeployDenied = { ...story("deployDenied"), name: "Deployment denied" };
