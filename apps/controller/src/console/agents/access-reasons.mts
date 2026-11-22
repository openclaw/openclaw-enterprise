import type { DeployGrant } from "./credentials.mjs";

// The one place that words who grants access and what to ask for (findings 2539, 2578). People
// receive exact-resource grants through Namespace IAM policy, which only Installation
// administration may write (findings 1920, 2259, 2260). Reasons that request such a grant use
// these words. Grants use the permissions cheat sheet's words and
// name the action the API checks for that request (docs/reference/cheatsheets/permissions.md).
// Other refusals identify the relevant access and the next step.

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

// Advisory permission answers report access, not why it was refused. A caller can need a
// different grant or be subject to a Restriction, even with Installation administration.
type InstallationPermissions = { installation?: { administer?: boolean } } | null;
const CHECK_ACCESS = "Check your access and whether an IAM Restriction applies.";
const accessRequired = (task: string, access: string, permissions?: InstallationPermissions) =>
  `${task} requires ${access}. ${permissions?.installation?.administer === false ? askAdministratorTo("check your access") : CHECK_ACCESS}`;

export const agentCreateDenied = (permissions?: InstallationPermissions) =>
  accessRequired("Creating an Agent", "Agent create in this Namespace", permissions);
export const AGENT_CREATE_DENIED = agentCreateDenied();
export const secretCreateDenied = (permissions?: InstallationPermissions) =>
  accessRequired("Creating a Secret", "Secret create in this Namespace", permissions);
export const SECRET_CREATE_DENIED = secretCreateDenied();
export function namespaceCreateDenied(installationAdmin: boolean | null) {
  const required = "Creating a Namespace requires Namespace create in this Installation.";
  if (installationAdmin === true) {
    return `${required} Check whether an IAM Restriction applies.`;
  }
  if (installationAdmin === false) {
    return `${required} ${askAdministratorTo("check your access")}`;
  }
  return `${required} ${CHECK_ACCESS}`;
}
export const namespaceDeleteDenied = (permissions?: InstallationPermissions) =>
  accessRequired("Deleting this Namespace", "Namespace delete", permissions);
export const NAMESPACE_DELETE_REFUSED =
  "Deletion was refused. Review your access with whoever manages IAM.";

// POST /agents/{id}/stop authorizes Agent operate; DELETE /agents/{id} authorizes Agent delete.
export const AGENT_STOP_DENIED = notIncluded("stopping this Agent", "Agent operate on it");
export const AGENT_DELETE_DENIED = notIncluded("deleting this Agent", "Agent delete on it");
// A Stop or Delete the API refused, on the Agent's page ("this Agent") or its Agents row (its
// name). It says what was refused, then the same reason as the permission answer (finding D753).
export const stopRefused = (target: string) =>
  `Stop was refused: your access does not include stopping ${target}. ${askForGrant("Agent operate on it")}`;
export const deleteRefused = (target: string) =>
  `Deletion was refused: your access does not include deleting ${target}. ${askForGrant("Agent delete on it")}`;
// POST /agents/{id}/deploy authorizes Agent deploy.
export const AGENT_DEPLOY_DENIED = notIncluded("deploying this Agent", "Agent deploy on it");
// A Namespace the reader cannot read: deleted, never shared or no longer shared. One sentence
// for every page, which cannot tell these apart (finding D753).
export const NAMESPACE_UNAVAILABLE = "This Namespace is missing or your access does not include it";
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
// A version the page showed as selected for service exists, so once a stop or another version
// takes its place it is not named as one that may not exist, nor by its raw ID (finding 3000).
export const FORMER_CURRENT_VERSION_UNREADABLE = `You cannot read the version that was selected for service, so this page shows no progress or outcome for it. ${IF_NEEDED_VERSION_READ}`;
// A version this tab's own Deploy created exists: the API accepted it. A deployer without read on
// it is told that, not that it may not exist (finding D751).
export const deployAcceptedVersionUnreadable = (version: string) =>
  `Deployment accepted. You cannot read version ${version}, so its progress and outcome are not shown here; ${ASK_INSTALLATION_ADMINISTRATOR} for AgentRevision read on it.`;
// A current version the reader cannot read, named in words rather than by its raw ID, on the
// Agents list and the Agent page alike (findings D789, D791). It is newer than every readable
// version when the newest readable one's deployment succeeded: that made it current, and a
// different current version came after it.
export const unreadableCurrentVersion = (newer: boolean) =>
  newer ? "A newer version you cannot read" : "A version you cannot read";

// A rejected model credential is fixed in the Agent's Credentials, which needs Agent update and
// the grants each Agent update also checks. A Secret-backed credential can also be replaced in
// place, which needs Secret update on that Secret. A caller whose permission answer denies the
// Agent update is told which grant it lacks, which grants do what, and who grants them, rather
// than to fix it (finding D750). Deploying the fix needs Agent deploy, and Secret operate on a
// Secret-backed credential: the console cannot tell a caller who cannot read that Secret whether
// she holds it, so it says what deploying needs unless the answer denies Agent deploy (D752).
export type CredentialChoiceGap = "update" | "configurationRead" | "sources" | "serviceAccount";
const CREDENTIAL_CHOICE_NEEDS: Record<CredentialChoiceGap, string> = {
  update: "Agent update on this Agent, which your access does not include",
  configurationRead:
    "Configuration read on this Agent's Configuration, which your access does not include",
  sources:
    "operate on each Secret and credential source this Agent and its Configuration bind, which your access does not include",
  serviceAccount:
    "operate on each Secret and credential source this Agent and its Configuration bind, and read on the ServiceAccount it uses for Harness authentication; your access does not include all of them",
};
export interface CredentialFixAccess {
  secretBacked: boolean;
  gap: CredentialChoiceGap;
  // The answer's Agent deploy, or undefined when there is no answer.
  deploy: boolean | undefined;
}
const credentialFixGrants = ({ secretBacked, gap, deploy }: CredentialFixAccess, then: string) => {
  const choose = `another credential needs ${CREDENTIAL_CHOICE_NEEDS[gap]}.`;
  const fix = secretBacked
    ? `Replacing its Secret's value needs Secret update on that Secret; choosing ${choose}`
    : `Choosing ${choose}`;
  const operate = secretBacked ? " and Secret operate on that Secret" : "";
  const deploying =
    deploy === false
      ? "Deploying needs Agent deploy on this Agent, which your access does not include."
      : deploy === true
        ? `Then ${then}${secretBacked ? ", which also needs Secret operate on that Secret" : ""}.`
        : `Then ${then}, which needs Agent deploy on this Agent${operate}.`;
  return `${fix} ${deploying} ${ASK} for whichever of these grants your access does not include.`;
};
export const MODEL_CREDENTIAL_REJECTED_DEPLOY_DENIED = `The model provider rejected this version's credential (HTTP 401 or 403). Choose a valid authentication source in Credentials. ${AGENT_DEPLOY_DENIED}`;
export const modelCredentialRejectedAsk = (access: CredentialFixAccess) =>
  `The model provider rejected this version's credential (HTTP 401 or 403). ${credentialFixGrants(access, "deploy a new version")}`;
export const modelCredentialRejectedReadOnly = (access: CredentialFixAccess) =>
  `The last deployment's model credential was rejected. ${credentialFixGrants(access, "deploy again")}`;
// The Agent no longer binds the credential the failed version was deployed with, so the recorded
// failure asks for nothing more, of any reader: the next deployment uses the new one (D752).
export const MODEL_CREDENTIAL_REJECTED_REPLACED =
  "The model provider rejected this version's credential (HTTP 401 or 403). The Agent now uses a different credential, which the next deployment uses.";

// A Secret field with nothing to choose for a caller who can neither create nor read a Secret.
export const NO_SECRETS_CREATE_DENIED = `No Secrets you can read in this Namespace. ${SECRET_CREATE_DENIED} Using an existing Secret requires Secret read and operate on it.`;
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
// a member's console sends no grant. The member's deploy writes the Agent's operate grant on each
// source it uses that the member may operate (RFC-0040), so a member's save says that instead of
// naming an administrator (finding D748). Deploy names a bound Secret the member may not operate.
// A member who may not deploy this Agent is told who can: someone who may deploy it and operate
// the credential, or an administrator who grants it directly. When the IAM Driver cannot write
// that grant, the deploy only checks the Agent's access, so the save names the administrator.
const CREDENTIAL_AT_DEPLOY: Record<DeployGrant, (credential: string, grant: string) => string> = {
  grants: (credential) => `Deploying gives this Agent operate on ${credential}.`,
  denied: (credential, grant) =>
    `Ask someone who may deploy this Agent and operate ${credential} to deploy it, or ${ASK_INSTALLATION_ADMINISTRATOR} to give the Agent ${grant}.`,
  none: (credential, grant) =>
    `Deploying checks that this Agent can use ${credential}. If it cannot, ${ASK_INSTALLATION_ADMINISTRATOR} to give the Agent ${grant}.`,
};
export const credentialGrantedAtDeploy = (credential: string, grant: string, deploy: DeployGrant) =>
  CREDENTIAL_AT_DEPLOY[deploy](credential, grant);

// The network policy and its suggestions authorize Agent read and SandboxPolicy read on the
// Agent's own policy; previews and saves authorize Agent manage_policy and SandboxPolicy update.
export const SANDBOX_POLICY_READ_DENIED = notIncluded(
  "reading this Agent’s network policy or its suggestions",
  "SandboxPolicy read on it",
);
// Deploy also checks SandboxPolicy read on that policy when it has saved rules (finding 2151). The
// API's denial names the policy by its raw ID; the Agent page names it in words (finding D801).
export const DEPLOY_SANDBOX_POLICY_READ_DENIED = `Deploying this Agent needs SandboxPolicy read on its network policy, which your access does not include. ${askAdministratorTo("grant it")}`;

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
// A version the page could not read: its runtime status would be refused too, so the Logs tab
// says so in words instead of sending that read (finding D794).
export const RUNTIME_STATUS_VERSION_UNREADABLE = `You cannot read this version, so its runtime status is not shown. ${askForGrant("AgentRevision read on it")}`;

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
// POST /configurations checks Configuration create and Secret operate on each bound Secret.
export const CONFIGURATION_CREATE_REFUSED = accessRequired(
  "Creating this Agent's Configuration",
  "Configuration create in this Namespace and Secret operate on each Secret it binds",
);
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
