// Why a control is disabled, or a request refused, for lack of one grant, in one shape (finding
// 2539): what the reader's access does not include, then who grants it and what to ask for.
// People receive exact-resource grants through Namespace IAM policy, which only Installation
// administration may write (findings 1920, 2259, 2260), so every reason sends the reader to an
// Installation administrator. Grants use the permissions cheat sheet's words and name the action
// the API checks for that request (docs/reference/cheatsheets/permissions.md).
export const askForGrant = (grant: string) => `Ask an Installation administrator for ${grant}.`;

export const notIncluded = (task: string, grant: string) =>
  `Your access does not include ${task}. ${askForGrant(grant)}`;

// POST /agents/{id}/stop authorizes Agent operate; DELETE /agents/{id} authorizes Agent delete.
export const AGENT_STOP_DENIED = notIncluded("stopping this Agent", "Agent operate on it");
export const AGENT_DELETE_DENIED = notIncluded("deleting this Agent", "Agent delete on it");
// Deploy authorizes Agent deploy first; the deployment's other checks name themselves when refused.
export const AGENT_DEPLOY_DENIED = notIncluded("deploying this Agent", "Agent deploy on it");
// Saving a draft Configuration authorizes Configuration update on it.
export const CONFIGURATION_UPDATE_DENIED = notIncluded(
  "editing this Configuration",
  "Configuration update on it",
);

// Each version is a separate AgentRevision with its own read grant, so a reader who deploys
// still needs read on each new version, granted after it exists (docs/guides/topics/iam.md).
export const VERSION_READ_DENIED = notIncluded(
  "this version, so its configuration and deployment outcome are hidden",
  "AgentRevision read on it",
);
export const NEW_VERSIONS_READ =
  "Each new version needs its own AgentRevision read: ask an Installation administrator to grant it after each deployment.";

// Secret create is checked on the Namespace, and Namespace IAM Roles cannot grant create, so only
// an Installation administrator can create one (as AGENT_CREATE_DENIED says for Agents).
export const SECRET_CREATE_DENIED =
  "Your access does not include creating Secrets in this Namespace. Only an Installation administrator can create Secrets: ask one to create it and to give you Secret read and operate on it.";
export const SECRET_READ_DENIED = notIncluded("reading this Secret", "Secret read on it");
export const SECRET_UPDATE_DENIED = notIncluded(
  "replacing this Secret's value",
  "Secret update on it",
);
export const SECRET_DELETE_DENIED = notIncluded("deleting this Secret", "Secret delete on it");
export const SECRET_OPERATE_NEEDED = askForGrant("Secret operate on it");

// The network policy and its suggestions authorize Agent read and SandboxPolicy read on the
// Agent's own policy; previews and saves authorize Agent manage_policy and SandboxPolicy update.
export const SANDBOX_POLICY_READ_DENIED = notIncluded(
  "reading this Agent’s network policy or its suggestions",
  "SandboxPolicy read on it",
);
