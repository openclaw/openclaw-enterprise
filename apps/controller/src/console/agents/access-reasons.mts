// The one place that words who grants access and what to ask for (findings 2539, 2578). People
// receive exact-resource grants through Namespace IAM policy, which only Installation
// administration may write (findings 1920, 2259, 2260), so every reason sends the reader to an
// Installation administrator, in these words. Grants use the permissions cheat sheet's words and
// name the action the API checks for that request (docs/reference/cheatsheets/permissions.md).
// The API's own named denials end the same way ("Ask an Installation administrator to grant it.").

// The ask clause inside a sentence, such as "Refresh, or ask an Installation administrator."
export const ASK_INSTALLATION_ADMINISTRATOR = "ask an Installation administrator";
const ASK = "Ask an Installation administrator";

/** "Ask an Installation administrator for <grant>." */
export const askForGrant = (grant: string) => `${ASK} for ${grant}.`;

/** "Ask an Installation administrator to <step>.", for a step only that role can take. */
export const askAdministratorTo = (step: string) => `${ASK} to ${step}.`;

/** What the reader's access does not include, then the grant to ask for. */
export const notIncluded = (task: string, grant: string) =>
  `Your access does not include ${task}. ${askForGrant(grant)}`;

/**
 * A write the API refused, where it was tried: which action was refused, what the reader's access
 * does not include, then the grant to ask for ("Save was refused: your access does not include
 * ...").
 */
export const actionRefused = (action: string, task: string, grant: string) =>
  `${action} was refused: ${notIncluded(task, grant).replace(/^Your/, "your")}`;

// Create is checked on the parent (the Installation for a Namespace, otherwise the Namespace), and
// Namespace IAM Roles cannot grant people create (docs/guides/topics/iam.md), so the reason names
// who can create instead of a grant to ask for (findings 2496, 2508).
const onlyAdministratorCreates = (kinds: string, where: string, step: string) =>
  `Your access does not include creating ${kinds} ${where}. Only an Installation administrator can create ${kinds}: ask one to ${step}.`;

export const AGENT_CREATE_DENIED = onlyAdministratorCreates(
  "Agents",
  "in this Namespace",
  "create it and to give you access to edit and deploy it",
);
// An Installation administrator may still be refused Agent create: a deny Restriction overrides
// every grant in its Namespace, administration included, and administration cannot lift it. The
// permission answer says so when it holds Installation administer but not Agent create (finding
// D759).
export const AGENT_CREATE_RESTRICTED =
  "A Restriction in this Namespace denies Agent create, even for Installation administrators. Ask whoever manages IAM Restrictions to lift it, or create the Agent in another Namespace.";
/** Why the Namespace permission answer refuses Agent create: a Restriction, or missing access. */
export const agentCreateDenied = (
  permissions?: { installation?: { administer?: boolean } } | null,
) =>
  permissions?.installation?.administer === true ? AGENT_CREATE_RESTRICTED : AGENT_CREATE_DENIED;
export const SECRET_CREATE_DENIED = onlyAdministratorCreates(
  "Secrets",
  "in this Namespace",
  "create it and to give you Secret read and operate on it",
);
export const NAMESPACE_CREATE_DENIED = onlyAdministratorCreates(
  "Namespaces",
  "in this Installation",
  "create a Namespace or to give you access to an existing one",
);

// POST /agents/{id}/stop authorizes Agent operate; DELETE /agents/{id} authorizes Agent delete.
export const AGENT_STOP_DENIED = notIncluded("stopping this Agent", "Agent operate on it");
export const AGENT_DELETE_DENIED = notIncluded("deleting this Agent", "Agent delete on it");
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
export const NEW_VERSIONS_READ = `Each new version needs its own AgentRevision read: ${ASK_INSTALLATION_ADMINISTRATOR} to grant it after each deployment.`;
// A version link names a version the page cannot list. A reader granted read per version gets
// the same answer for an unknown version as for one they may not read, so the text says either
// may be true (finding D750).
const IF_NEEDED_VERSION_READ = `If you need it, ${ASK_INSTALLATION_ADMINISTRATOR} for AgentRevision read on it.`;
export const VERSION_UNAVAILABLE = `This version does not exist or your access does not include it. ${IF_NEEDED_VERSION_READ}`;
export const requestedVersionUnavailable = (version: string) =>
  `Version ${version} does not exist or your access does not include it, so this page shows no progress or outcome for it. ${IF_NEEDED_VERSION_READ}`;
// A version this tab's own Deploy created exists: the API accepted it. A deployer without read on
// it is told that, not that it may not exist (finding D751).
export const deployAcceptedVersionUnreadable = (version: string) =>
  `Deployment accepted. You cannot read version ${version}, so its progress and outcome are not shown here; ${ASK_INSTALLATION_ADMINISTRATOR} for AgentRevision read on it.`;

// A rejected model credential is fixed in the Agent's Credentials, which needs Agent update. A
// Secret-backed credential can also be replaced in place, which needs Secret update on that
// Secret. The permission answer covers only Agent update, so a caller known to lack it is told
// which grant does what, and who grants it, rather than to fix it (finding D750).
const credentialFixGrants = (secretBacked: boolean, then: string) =>
  secretBacked
    ? `Replacing its Secret's value needs Secret update on that Secret; choosing another credential needs Agent update on this Agent, which your access does not include. If your access does not include Secret update either, ${ASK_INSTALLATION_ADMINISTRATOR} for one of them. Then ${then}.`
    : `${notIncluded("changing it", "Agent update on this Agent")} Then ${then}.`;
export const modelCredentialRejectedAsk = (secretBacked: boolean) =>
  `The model provider rejected this version's credential (HTTP 401 or 403). ${credentialFixGrants(secretBacked, "deploy a new version")}`;
export const modelCredentialRejectedReadOnly = (secretBacked: boolean) =>
  `The last deployment's model credential was rejected. ${credentialFixGrants(secretBacked, "deploy again")}`;

// A Secret field with nothing to choose for a caller who can neither create nor read a Secret.
export const NO_SECRETS_CREATE_DENIED = `No Secrets you can read in this Namespace. ${SECRET_CREATE_DENIED} Or ask one for Secret read and operate on an existing Secret.`;
export const SECRET_READ_DENIED = notIncluded("reading this Secret", "Secret read on it");
export const SECRET_UPDATE_DENIED = notIncluded(
  "replacing this Secret's value",
  "Secret update on it",
);
export const SECRET_DELETE_DENIED = notIncluded("deleting this Secret", "Secret delete on it");
// A link to a Secret the readable list leaves out. The list answers the same for a Secret that
// does not exist, so the text says either may be true (finding D761).
export const SECRET_LINK_UNLISTED = `This Secret is not in your readable list: it may not exist, or your access does not include reading it. ${askForGrant("Secret read on it")}`;
// The same link for an Installation administrator, who is that "Installation administrator": the
// text asks nothing, and names the linked Secret only when its ID is well formed, so a link
// cannot put other words on the page (finding D769).
const SECRET_ID = /^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const secretLinkUnlistedForAdministrator = (secretId: string) =>
  `No ${SECRET_ID.test(secretId) ? `Secret ${secretId}` : "such Secret"} is in your readable list for this Namespace.`;
export const SECRET_OPERATE_NEEDED = askForGrant("Secret operate on it");
// Deploying authorizes Secret operate on each Secret the draft binds. A bound Secret the caller
// may neither read nor operate keeps its name hidden, and the grant to ask for includes read
// (finding D756).
export const deployUnreadableSecretsReason = (count: number) =>
  count === 1
    ? `Deploying needs Secret operate on a bound Secret your access does not include reading. ${askForGrant("Secret read and operate on it")}`
    : `Deploying needs Secret operate on ${count} bound Secrets your access does not include reading. ${askForGrant("Secret read and operate on them")}`;
// Only Installation administration writes the IAM policy that lets an Agent use a credential, so
// a member's console sends no grant. The deploy checks the Agent's own access and names the grant
// if it is missing (finding 2592), so a saved source says that, and who gives it (finding D748).
export const credentialCheckedAtDeploy = (noun: "Secret" | "credential source") =>
  `Deploying checks that this Agent can use the selected ${noun}. If it cannot, ${ASK_INSTALLATION_ADMINISTRATOR} to give the Agent ${noun} operate on it.`;

// The network policy and its suggestions authorize Agent read and SandboxPolicy read on the
// Agent's own policy; previews and saves authorize Agent manage_policy and SandboxPolicy update.
export const SANDBOX_POLICY_READ_DENIED = notIncluded(
  "reading this Agent’s network policy or its suggestions",
  "SandboxPolicy read on it",
);

// Log text authorizes Agent read_logs, or Agent administer in its place, plus Agent read. The API
// and the CLI name the grant in these words (finding 2599); the page is open, so Agent read is held.
export const LOG_TEXT_GRANT = "Agent read_logs (or Agent administer)";
export const LOG_TEXT_DENIED = `Log text requires ${LOG_TEXT_GRANT} on this Agent. ${askAdministratorTo("grant it")}`;
// Runtime status authorizes Agent operate and read plus AgentRevision read on the version. The
// log pane says what log text needs in its own words, so this names only status (finding D763).
// It names only the grant the caller's answers show missing: a reader who can read the version
// is not asked for AgentRevision read (finding D753). An unknown answer names both.
export function runtimeStatusDenied(grants: {
  operate?: boolean | undefined;
  versionRead?: boolean | undefined;
}) {
  if (grants.operate === false && grants.versionRead === true) {
    return `Runtime status requires Agent operate on this Agent. ${askAdministratorTo("grant it")}`;
  }
  if (grants.operate === true && grants.versionRead === false) {
    return `Runtime status requires AgentRevision read on this version. ${askAdministratorTo("grant it")}`;
  }
  return `Runtime status requires Agent operate on this Agent and AgentRevision read on this version. ${askAdministratorTo("grant them")}`;
}

// Reading a workspace file authorizes Agent read; saving one and running diagnostics, Agent
// operate.
export const WORKSPACE_READ_DENIED = notIncluded(
  "reading this Agent's workspace files",
  "Agent read on it",
);
export const WORKSPACE_SAVE_DENIED = notIncluded(
  "saving this Agent's workspace files",
  "Agent operate on it",
);
export const DIAGNOSTICS_DENIED = notIncluded(
  "running diagnostics for this Agent",
  "Agent operate on it",
);

// A save first rereads the Agent and its Configuration, which authorizes Agent read and
// Configuration read; a refused read is not a refused update (finding 1540).
export const SAVE_READ_REFUSED = actionRefused(
  "Save",
  "reading this Agent's saved settings, which each save reads first",
  "Agent read and Configuration read on it",
);
// PATCH /configurations/{id} authorizes Configuration update, and Secret operate on each Secret
// the save binds.
export const CONFIGURATION_SAVE_REFUSED = actionRefused(
  "Save",
  "saving this Configuration",
  "Configuration update on it, plus Secret operate on each Secret it binds",
);
// PATCH /agents/{id} authorizes Agent update, then Configuration read and the grants on each
// Secret, credential source and ServiceAccount the Agent and its Configuration bind.
export const AGENT_SAVE_REFUSED = actionRefused(
  "Save",
  "saving this Agent",
  "Agent update and Configuration read on it, plus access to the Secrets, credential sources and Service Account it binds",
);
// PUT /agents/{id}/workspace/files/{name} authorizes Agent operate.
export const WORKSPACE_SAVE_REFUSED = actionRefused(
  "Save",
  "saving this Agent's workspace files",
  "Agent operate on it",
);
// POST /configurations authorizes Configuration create, which no Namespace Role grants, plus
// Secret operate on each Secret it binds: only an Installation administrator can create it.
export const CONFIGURATION_CREATE_REFUSED = `Create was refused: your access does not include creating this Agent's Configuration. That needs Configuration create in this Namespace, which only an Installation administrator holds, plus Secret operate on each Secret it binds. ${askAdministratorTo("create this Agent")}`;
// The editing setting authorizes Installation administer and Agent administer, which no Namespace
// Role grants, so the reason names who can change it instead of a grant.
export const POLICY_EDITING_SETTING_REFUSED =
  "Your access does not include changing the editing setting. Only an Installation administrator who also administers this Agent can change it.";
// Repository choices for an Agent authorize Agent update (GET /agents/{id}/repository-options);
// for a new Agent, Agent create in the Namespace (GET /agents/repository-options).
export const REPOSITORY_CHOICES_AGENT_DENIED = notIncluded(
  "loading repository choices for this Agent",
  "Agent update on it",
);
// The Agent page checks Agent read, the versions list (Agent read) and the shown version
// (AgentRevision read) or draft (Configuration read) before it shows the Agent again.
export const AGENT_PAGE_READ_DENIED = notIncluded(
  "reading this Agent, its versions or its Configuration",
  "Agent read, AgentRevision read and Configuration read on them",
);
// A 403 that names no grant, such as an older API's generic denial. message() adds who grants
// access; administratorMessage() does not.
export const ACCESS_NOT_INCLUDED = "Your access does not include this action.";
