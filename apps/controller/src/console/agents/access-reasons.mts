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
// A version this tab's own Deploy created exists: the API accepted it. A deployer without read on
// it is told that, not that it may not exist (finding D751).
export const deployAcceptedVersionUnreadable = (version: string) =>
  `Deployment accepted. You cannot read version ${version}, so its progress and outcome are not shown here; ${ASK_INSTALLATION_ADMINISTRATOR} for AgentRevision read on it.`;

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
export const modelCredentialRejectedAsk = (access: CredentialFixAccess) =>
  `The model provider rejected this version's credential (HTTP 401 or 403). ${credentialFixGrants(access, "deploy a new version")}`;
export const modelCredentialRejectedReadOnly = (access: CredentialFixAccess) =>
  `The last deployment's model credential was rejected. ${credentialFixGrants(access, "deploy again")}`;
// The Agent no longer binds the credential the failed version was deployed with, so the recorded
// failure asks for nothing more, of any reader: the next deployment uses the new one (D752).
export const MODEL_CREDENTIAL_REJECTED_REPLACED =
  "The model provider rejected this version's credential (HTTP 401 or 403). The Agent now uses a different credential, which the next deployment uses.";

// A Secret field with nothing to choose for a caller who can neither create nor read a Secret.
export const NO_SECRETS_CREATE_DENIED = `No Secrets you can read in this Namespace. ${SECRET_CREATE_DENIED} Or ask one for Secret read and operate on an existing Secret.`;
export const SECRET_READ_DENIED = notIncluded("reading this Secret", "Secret read on it");
export const SECRET_UPDATE_DENIED = notIncluded(
  "replacing this Secret's value",
  "Secret update on it",
);
export const SECRET_DELETE_DENIED = notIncluded("deleting this Secret", "Secret delete on it");
export const SECRET_OPERATE_NEEDED = askForGrant("Secret operate on it");
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
// Runtime status authorizes Agent operate and read plus AgentRevision read on the version.
export const RUNTIME_STATUS_DENIED = `Runtime status requires Agent operate on this Agent and AgentRevision read on this version. Log text needs ${LOG_TEXT_GRANT}. ${askForGrant("the access you need")}`;

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
