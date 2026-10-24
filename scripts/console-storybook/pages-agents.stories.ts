import { story } from "./story.ts";

export default { title: "Pages/Agents" };

export const Agents = { ...story("agents"), name: "Populated" };
export const RowNavigation = story("agentsRowNavigation");
export const UnreadableConfiguration = story("agentsUnreadableConfiguration");
export const LongName = story("agentsLongName");
export const LongNameDigits = story("agentsLongNameDigits");
export const LongNamePunctuation = story("agentsLongNamePunctuation");
export const LongNameDashes = story("agentsLongNameDashes");
export const LongNameJoiners = story("agentsLongNameJoiners");
export const LongNameMixed = story("agentsLongNameMixed");
export const LongNamePhone = story("agentsLongNamePhone");
export const IdLigaturesPhone = story("agentsIdLigaturesPhone");
export const AgentsEmpty = { ...story("agentsEmpty"), name: "Empty" };
export const AgentsSearch = { ...story("agentsSearch"), name: "No search matches" };
export const NoNamespaces = { ...story("noNamespaces"), name: "No readable Namespaces" };
export const NamespaceMissing = { ...story("namespaceMissing"), name: "Namespace unavailable" };
export const CreateRestricted = story("agentsCreateRestricted");
export const CreateRestrictedEmpty = {
  ...story("agentsCreateRestrictedEmpty"),
  name: "Empty, Create Agent unavailable",
};
export const NamespaceProvisioning = {
  ...story("agentsNamespaceProvisioning"),
  name: "Empty, Namespace still provisioning",
};
export const NamespaceBecomesReady = {
  ...story("agentsNamespaceBecomesReady"),
  name: "Namespace becomes ready",
};
export const NamespaceLeavesList = {
  ...story("agentsNamespaceMissing"),
  name: "Namespace leaves the list while provisioning",
};
export const AgentsDenied = { ...story("agentsDenied"), name: "Access denied" };
export const AgentsError = { ...story("agentsError"), name: "Read failure" };
export const AgentsInterruptedResponse = {
  ...story("agentsInterruptedResponse"),
  name: "Interrupted response",
};
export const AgentsLoading = { ...story("agentsLoading"), name: "Loading" };

export const RowStopConfirmation = story("agentsRowStopConfirm");
export const RowStopped = story("agentsRowStopped");
export const RowDeleteConfirmation = story("agentsRowDeleteConfirm");
export const RowStopDenied = story("agentsRowStopDenied");
export const RowDeleteDenied = story("agentsRowDeleteDenied");
export const RowStopUnknown = story("agentsRowStopUnknown");
export const RowRestricted = story("agentsRowRestricted");

export const LatestDeploymentFailed = story("agentsDeploymentFailed");
export const LatestDeploymentDenied = story("agentsDeploymentDenied");
export const LatestDeploymentLoading = story("agentsDeploymentLoading");
export const CurrentVersionOlder = story("agentsCurrentVersionOlder");
export const CurrentVersionDenied = story("agentsCurrentVersionDenied");
export const ReturnWhileDeploymentsLoad = {
  ...story("agentsReturnWhileDeploymentsLoad"),
  name: "Return while deployments load",
};
export const LatestDeploymentUnavailable = story("agentsDeploymentError");
