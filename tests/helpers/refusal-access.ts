// Independent Console and API access-refusal expectations. Keep these literals separate from product wording.
import { AGENT_CREATE_ACCESS_CHECK, askForGrant, notIncluded } from "./refusal-text.mjs";

// An ordinary denial identifies the required action and scope without disclosing a cause.
export const createDenied = (kind: string, namespaceId: string): string =>
  `Not authorized: this needs ${kind} create in Namespace ${namespaceId}. Review this permission with whoever manages IAM.`;
// The API confirms a Restriction for a caller who administers the Installation when it has
// evidence of that Restriction (finding D769).
export const createRestricted = (kind: string, namespaceId: string): string =>
  `Not authorized: a Restriction in Namespace ${namespaceId} denies ${kind} create, even for Installation administrators. Check your access and the applicable IAM Restriction.`;
export const NAMESPACE_CREATE_DENIED =
  "Not authorized: this needs Namespace create. Review this permission with whoever manages IAM.";
export const namespaceDeleteDenied = (namespaceId: string): string =>
  `Not authorized: this needs Namespace delete on Namespace ${namespaceId}. Review this permission with whoever manages IAM.`;
export const INSTALLATION_ADMINISTER_DENIED =
  "Not authorized: this needs Installation administer. Ask an Installation administrator to do it for you or to grant it.";

// The Create Agent page and Agents list identify the permission required in this Namespace.
export const AGENT_CREATE_DENIED =
  "Creating an Agent requires Agent create in this Namespace. Ask an Installation administrator to check your access.";

// The same refused Installation read when the Namespace permission read failed (finding 2110).
export const AGENT_CREATE_PERMISSIONS_UNREAD =
  "Your permissions in this Namespace could not be checked, and Installation-wide capabilities are not readable with your access. Retry the permission check before creating an Agent.";

// The Secret dialog's disabled Replace value and Delete Secret, from the Secret read's answer
// (finding D761).
export const SECRET_UPDATE_DENIED = notIncluded(
  "replacing this Secret's value",
  "Secret update on it",
);
export const SECRET_DELETE_DENIED = notIncluded("deleting this Secret", "Secret delete on it");

// A Namespace the reader cannot read, deleted or not shared, in one sentence (finding D753).
export const NAMESPACE_UNAVAILABLE = "This Namespace is missing or your access does not include it";

// Each version has its own AgentRevision read grant, so a reader who deploys still needs read on
// each new version, granted after it exists.
export const NEW_VERSIONS_READ =
  "Each new version needs its own AgentRevision read: ask an Installation administrator to grant it after each deployment.";

export const CONFIGURATION_UPDATE_DENIED = notIncluded(
  "editing this Configuration",
  "Configuration update on it",
);
export const DIAGNOSTICS_DENIED = notIncluded(
  "running diagnostics for this Agent",
  "Agent operate on it",
);
export const WORKSPACE_SAVE_DENIED = notIncluded(
  "saving this Agent's workspace files",
  "Agent operate on it",
);
export const SANDBOX_POLICY_READ_DENIED = notIncluded(
  "reading this Agent’s network policy or its suggestions",
  "SandboxPolicy read on it",
);
// Deploy checks the same read when the policy has saved rules; the Agent page names the policy in
// words, not by the ID the API's denial gives (finding D801).
export const DEPLOY_SANDBOX_POLICY_READ_DENIED =
  "Deploying this Agent needs SandboxPolicy read on its network policy, which your access does not include. Ask an Installation administrator to grant it.";
// The Logs tab's refusals use the API's grant words for log text (finding 2599).
export const LOG_TEXT_DENIED =
  "Log text requires Agent read_logs (or Agent administer) on this Agent. Ask an Installation administrator to grant it.";
// The status refusal names only status: the log pane names read_logs itself (finding D763). It
// names only the grant the caller's answers show missing (finding D753); unknown answers, both.
export const RUNTIME_STATUS_DENIED =
  "Runtime status requires Agent operate on this Agent and AgentRevision read on this version. Ask an Installation administrator to grant them.";
export const RUNTIME_STATUS_OPERATE_DENIED =
  "Runtime status requires Agent operate on this Agent. Ask an Installation administrator to grant it.";
// A version the page could not read: the strip says so instead of reading status (finding D794).
export const RUNTIME_STATUS_VERSION_UNREADABLE =
  "You cannot read this version, so its runtime status is not shown. Ask an Installation administrator for AgentRevision read on it.";

// Create Agent's Create new Secret choice and typed model key, for a caller whose Secret operate
// covers only some Secrets: a new Secret gets no operate grant of its own (finding 2492).
export const NEW_SECRET_OPERATE_DENIED =
  "Your access includes Secret operate on only some Secrets in this Namespace, so an Agent cannot use a new Secret you create here.";
// What an administrator can grant instead: Secret operate on one exact Secret (finding 2507).
export const NEW_SECRET_OPERATE_REMEDY =
  "To use a new Secret, create it on the Secrets page, then ask an Installation administrator for Secret operate on it.";

// What an Installation administrator's own refused request says: asking one would not help.
export const ADMINISTRATOR_ACCESS_DENIED = "Your access does not include this action.";
export const CONSOLE_ACCESS_DENIED =
  "Your access does not include this action. Ask an Installation administrator to check your access.";
export const secretOperateRefused = (name: string): string =>
  `Save was refused: your access does not include Secret operate on ${name}, which each save needs on every Secret it binds. Choose another Secret, or ask an Installation administrator for Secret operate on it.`;

// The heading wherever a caller reads no Namespace, on every page alike (finding D755).
export const NO_READABLE_NAMESPACES = "No readable Namespaces";

export const PLUGINS_READ_ONLY =
  "These are the version draft's plugin selections, read-only with your access. The next deployment uses them as saved.";

// A bound Secret whose metadata read was refused to a caller who may still administer the
// Installation, such as one a Restriction on Secret read covers (finding 2549).
export const BOUND_SECRET_READ_REFUSED = `A Secret is bound. Its name is hidden because your access does not include reading it. ${askForGrant("Secret read on it")}`;
// Finding D761. A link to a Secret the readable list leaves out: missing and unreadable alike.
export const SECRET_LINK_UNLISTED = `This Secret is not in your readable list: it may not exist, or your access does not include reading it. ${askForGrant("Secret read on it")}`;
// The same link for an Installation administrator, with no ask (finding D769). `shown` is
// "Secret <id>" for a well-formed linked ID, otherwise "such Secret".
export const secretLinkUnlistedAdministrator = (shown: string): string =>
  `No ${shown} is in your readable list for this Namespace.`;
// A disabled Secret field's hint for a bound Secret the caller may read (finding 2646: a check
// that it is absent must use this text, not a pasted fragment).
export const BOUND_SECRET_METADATA = "Secret metadata is bound. Values are never shown.";

export const BACKENDS_DENIED = `Your account does not have access to Backends. Backends apply to the whole Installation, so choosing another Namespace would not change this. ${askForGrant("access")}`;
// A write the console names after the API refused it, where it was tried (errcopy-console-1026b).
export const actionRefused = (action: string, task: string, grant: string): string =>
  `${action} was refused: your access does not include ${task}. ${askForGrant(grant)}`;
// A request that checks several grants shows the API's named one after "<Action> was refused:".
export const refusedNamed = (action: string, grant: string, target: string): string =>
  `${action} was refused: this needs ${grant} on ${target}. Ask an Installation administrator to grant it.`;
// A save's reread of the Agent and its Configuration was refused before the write.
export const SAVE_READ_REFUSED = actionRefused(
  "Save",
  "reading this Agent's saved settings, which each save reads first",
  "Agent read and Configuration read on it",
);
export const WORKSPACE_SAVE_REFUSED = actionRefused(
  "Save",
  "saving this Agent's workspace files",
  "Agent operate on it",
);
// A refused Configuration save can require checking Configuration create or Secret operate.
export const CONFIGURATION_CREATE_REFUSED =
  "Creating this Agent's Configuration requires Configuration create in this Namespace and Secret operate on each Secret it binds. Check your access and whether an IAM Restriction applies.";
// Repository choices for an Agent (Agent update) and for a new Agent (Agent create).
export const REPOSITORY_CHOICES_AGENT_DENIED = notIncluded(
  "loading repository choices for this Agent",
  "Agent update on it",
);
export const REPOSITORY_CHOICES_CREATE_DENIED = `Repository choices are not shown. ${AGENT_CREATE_ACCESS_CHECK}`;

// A Slack people or channel lookup the API refused without naming a grant.
export const SLACK_LOOKUP_DENIED = notIncluded(
  "looking up Slack people and channels with the selected Slack bot Secret",
  "Secret operate on it",
);
