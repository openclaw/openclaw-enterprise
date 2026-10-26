// Expected refusal text that the product defines once. Tests compare against these constants instead
// of local copies, so a wording change is one edit here. A missed copy cannot drift: a check that
// the text is absent would still pass on stale wording. The text is written out here and not
// imported from product source, so a wording regression still fails the tests that read it.

// The API's generic error messages (apps/controller/src/http/errors.ts). Console tests use them
// as the server's answer in fulfilled routes, and API tests expect them in error envelopes.
export const GENERIC_DENIAL = "The exact platform operation was not authorized.";
// A caller's own denial names the grant the request checked and who grants it (finding 2534,
// apps/controller/src/http/caller-denial.ts). `target` is "<Kind> <id>" for an ID the request
// carried, otherwise "a <Kind> this request uses".
export const callerDenied = (grant, target) =>
  `Not authorized: this needs ${grant} on ${target}. Ask an Installation administrator to grant it.`;
// An Agent's own service principal lacks a grant deployment needs (finding 2592). `agent` is
// "Agent <id>" when the request carried its ID, otherwise "This Agent"; `target` is "Secret <id>"
// when the caller sent it or may read both it and the Agent, otherwise "one of its bound Secrets".
export const agentPrincipalDenied = (agent, target, grant = "Secret operate") =>
  `${agent} cannot use ${target}: the Agent itself needs ${grant} on it. Ask an Installation administrator to give the Agent access, then deploy again.`;
// A denial echoes the ID its request sent, so a real and an unknown ID get answers that match once
// each answer's own ID is hidden: the text never says whether the resource exists.
export const sentIdHidden = (text, id) => text.replaceAll(id, "<id>");
// A create needs the collection grant, which no Role can hold: only an Installation
// administrator creates one. `kinds` is the plural, such as "Secrets".
export const createDenied = (kind, namespaceId, kinds = `${kind}s`) =>
  `Not authorized: this needs ${kind} create in Namespace ${namespaceId}. Only an Installation administrator can create ${kinds}: ask one to create it.`;
export const NAMESPACE_CREATE_DENIED =
  "Not authorized: this needs Namespace create. Only an Installation administrator can create Namespaces: ask one to create it.";
export const INSTALLATION_ADMINISTER_DENIED =
  "Not authorized: this needs Installation administer. Ask an Installation administrator to do it for you or to grant it.";
// The native admin host names the grant but no Agent: the host, not the caller, names the Agent.
export const NATIVE_ADMIN_DENIED =
  "Not authorized: opening this Agent's native admin UI needs Agent administer on it. Ask an Installation administrator to grant it.";
export const DEPENDENCY_UNAVAILABLE = "A required platform dependency is unavailable.";
export const RESOURCE_CONFLICT = "The requested platform resource already exists.";
export const RESOURCE_NOT_FOUND = "The requested platform resource was not found.";
export const NAMESPACE_NOT_READY = "The requested Namespace is not ready.";
// Agent create, its preflight and provisioning refuse a name another Agent in the Namespace has
// (AGENT_NAME_CONFLICT in errors.ts); a provisioning job that loses the name race reports it too.
export const AGENT_NAME_CONFLICT =
  "An Agent with this name already exists in this Namespace. Choose a different name.";
export const SECRET_NAME_CONFLICT =
  "A Secret with this name already exists in this Namespace. Choose a different name.";
export const NAMESPACE_NAME_CONFLICT =
  "A Namespace with this name already exists. Choose a different name.";
// Refusals that once read as the generic 404 or 409 and now say what to change (finding 2536).
// A credential source field its type's catalog does not list, or a required one that is missing:
// `field` is the request path, such as "secrets.api_key".
export const credentialSourceFieldUnknown = (type, field, group, allowed) =>
  `Credential source type ${type} has no field ${field}: remove it. Its ${group} fields: ${allowed}.`;
export const credentialSourceFieldRequired = (type, field) =>
  field.startsWith("secrets.")
    ? `Credential source type ${type} requires ${field}: add a reference to a Secret in this Namespace.`
    : `Credential source type ${type} requires ${field}: add it.`;
// Agent save, provisioning and deploy (packages/occ/src/errors.ts RepositoryBindingSelectionError).
export const REPOSITORY_SELECTION_NOT_APPROVED =
  "These repository selections are not approved for this Namespace: each repository must be approved here for its profile and listed once, at most 16. Choose from the repository options, or ask an Installation administrator to approve it.";
export const REPOSITORY_ACCESS_OR_BINDINGS =
  "Send repositoryAccess or repositoryBindings, not both. In repositoryAccess, list each repository once, at most 16, with a defaultProfile other than github-installation.";
export const COMPUTE_REPOSITORY_UNSUPPORTED =
  "This Installation's Compute Driver cannot deliver repository credentials, so this Agent cannot use repository access. Remove its repository bindings, or ask an Installation administrator to select Kubernetes Compute.";
export const SERVICE_ACCOUNT_CROSS_NAMESPACE =
  "Agent setting harnessAuth.source names a ServiceAccount in another Namespace. Harness authentication can use only a ServiceAccount in the Agent's own Namespace: select one from this Namespace.";
// Standing repository approval refusals (409 RESOURCE_CONFLICT); none names the approval.
export const STANDING_APPROVAL_BINDING_LOCKED =
  "A standing repository approval holds this Agent's repository binding, so the binding cannot change. Remove the approval first (this needs Agent administer on the Agent), then save again.";
export const STANDING_APPROVAL_ONE_BINDING =
  "A standing repository approval needs exactly one repository binding on the Agent. Keep one binding, then approve again.";
export const STANDING_APPROVAL_NOT_PERMITTED =
  "Team policy does not permit this standing approval: it must last until removed and name one of the Agent's repository bindings that the Installation allows standing approval for. Ask an Installation administrator to allow it.";
export const STANDING_APPROVAL_SCOPE_CHANGED =
  "The standing approval scope changed since you reviewed it. Read the current scope from repository-approval-scopes, review it, then approve again with its scopeFingerprint as expectedScopeFingerprint.";
export const STANDING_APPROVAL_POLICY_CHANGED =
  "This Agent's standing repository approval no longer matches team policy. Remove it (this needs Agent administer on the Agent) and approve the current scope again, or deploy after an Installation administrator restores the policy.";
// The sign-in endpoints' 503 (apps/controller/src/auth/index.ts); the console words its own.
export const SIGN_IN_UNAVAILABLE =
  "Sign-in is temporarily unavailable. Try again shortly. If it continues, ask an operator to check the API logs.";
// The sign-in endpoints' 429. The password limiter names its wait, the same number of seconds as
// its Retry-After header, which counts down: two refusals a second apart differ in it. The external
// sign-in budgets refill each minute and send no Retry-After.
export const signInRateLimited = (seconds) =>
  `Too many attempts. Wait ${seconds === 1 ? "1 second" : `${seconds} seconds`}, then try again.`;
export const SIGN_IN_RATE_LIMITED_MINUTE = "Too many attempts. Wait a minute, then try again.";
// Create Agent and the Agents list for a caller without Agent create, which Namespace Roles cannot
// grant people (findings 2496, 2508).
export const AGENT_CREATE_DENIED =
  "Your access does not include creating Agents in this Namespace. Only an Installation administrator can create Agents: ask one to create it and to give you access to edit and deploy it.";
// Secrets and Namespaces follow the same rule: Namespace Roles cannot grant people create.
export const SECRET_CREATE_DENIED =
  "Your access does not include creating Secrets in this Namespace. Only an Installation administrator can create Secrets: ask one to create it and to give you Secret read and operate on it.";
// Create Agent for a member whose Installation read and Agent create are both refused (create.mts).
export const AGENT_CREATE_INSTALLATION_DENIED =
  "Creating an Agent needs Installation access that your account does not have. Ask an Installation administrator to create this Agent.";
export const CONSOLE_NAMESPACE_CREATE_DENIED =
  "Your access does not include creating Namespaces in this Installation. Only an Installation administrator can create Namespaces: ask one to create a Namespace or to give you access to an existing one.";

// The console's reasons for a control disabled, or a request refused, for lack of a grant
// (findings 2539, 2578): what the reader's access does not include, then the grant to ask an
// Installation administrator for, in the permissions cheat sheet's words.
export const askForGrant = (grant) => `Ask an Installation administrator for ${grant}.`;
export const notIncluded = (task, grant) =>
  `Your access does not include ${task}. ${askForGrant(grant)}`;
// A member's console sends no credential grant, so a saved authentication source says the deploy
// checks the Agent's own access, and who gives it (finding D748). `noun` is "Secret" or
// "credential source".
export const credentialCheckedAtDeploy = (noun) =>
  `Deploying checks that this Agent can use the selected ${noun}. If it cannot, ask an Installation administrator to give the Agent ${noun} operate on it.`;
export const AGENT_STOP_DENIED = notIncluded("stopping this Agent", "Agent operate on it");
export const AGENT_DELETE_DENIED = notIncluded("deleting this Agent", "Agent delete on it");
export const AGENT_STOP_AND_DELETE_DENIED = notIncluded(
  "stopping or deleting this Agent",
  "Agent operate and Agent delete on it",
);
// Each version has its own AgentRevision read grant, so a reader who deploys still needs read on
// each new version, granted after it exists.
export const NEW_VERSIONS_READ =
  "Each new version needs its own AgentRevision read: ask an Installation administrator to grant it after each deployment.";
// A request the API refused for lack of a grant: what the reader tried, then the grant to ask for.
export const permissionRefused = (task, grant) =>
  `You do not have permission to ${task}. ${askForGrant(grant)}`;
// A refused Stop or Delete names the Agent on the Agents list and "this Agent" on its page.
export const stopRefused = (name) => permissionRefused(`stop ${name}`, "Agent operate on it");
export const deleteRefused = (name) => permissionRefused(`delete ${name}`, "Agent delete on it");
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
// The Logs tab's refusals use the API's grant words for log text (finding 2599).
export const LOG_TEXT_DENIED =
  "Log text requires Agent read_logs (or Agent administer) on this Agent. Ask an Installation administrator to grant it.";
export const RUNTIME_STATUS_DENIED =
  "Runtime status requires Agent operate on this Agent and AgentRevision read on this version. Log text needs Agent read_logs (or Agent administer). Ask an Installation administrator for the access you need.";
// A version link the page cannot list may name a version that does not exist: the API answers
// both alike, so the console says either may be true (finding D750).
export const VERSION_UNAVAILABLE =
  "This version does not exist or your access does not include it. If you need it, ask an Installation administrator for AgentRevision read on it.";
export const requestedVersionUnavailable = (version) =>
  `Version ${version} does not exist or your access does not include it, so this page shows no progress or outcome for it. If you need it, ask an Installation administrator for AgentRevision read on it.`;
// A rejected model credential for a caller known to lack Agent update names the grants that fix
// it and who gives them (finding D750): the failure banner, and the draft's deploy line. A
// Secret-backed credential can also be replaced in place with Secret update on its Secret.
const credentialFixGrants = (secretBacked, then) =>
  secretBacked
    ? `Replacing its Secret's value needs Secret update on that Secret; choosing another credential needs Agent update on this Agent, which your access does not include. If your access does not include Secret update either, ask an Installation administrator for one of them. Then ${then}.`
    : `Your access does not include changing it. Ask an Installation administrator for Agent update on this Agent. Then ${then}.`;
export const modelCredentialRejectedAsk = (secretBacked) =>
  `The model provider rejected this version's credential (HTTP 401 or 403). ${credentialFixGrants(secretBacked, "deploy a new version")}`;
export const modelCredentialRejectedReadOnly = (secretBacked) =>
  `The last deployment's model credential was rejected. ${credentialFixGrants(secretBacked, "deploy again")}`;
// The API has no route to Slack (SlackRouteNotConfiguredError, apps/controller/src/drivers/channel/
// slack.ts). Helm settings belong to whoever operates the Installation (finding D750).
export const SLACK_ROUTE_NOT_CONFIGURED =
  "OCC could not reach Slack, and the API has no Slack proxy. If the API has another approved route to Slack, try again. Otherwise ask the Installation operator to set Helm slackProxy.enabled or api.channelDirectoryProxyUrl; see the Slack integration guide.";
// Agent-side save controls, from the caller's permission answer (findings 2441, 2459).
export const AGENT_UPDATE_DENIED = notIncluded(
  "saving these settings",
  "Agent update on this Agent",
);
export const AGENT_SOURCES_DENIED =
  "Saving these settings needs operate on each Secret and credential source this Agent and its Configuration bind, which your access does not include. Ask an Installation administrator for that access.";
// Device login from Create Agent (Namespace-scoped) and from Agent detail (Agent-scoped): a start
// creates a Secret and a credential source, which only an Installation administrator can create;
// a poll or cancel checks the scope again plus operate on the login's Secret (finding 2577).
const DEVICE_LOGIN_START_REMEDY =
  "which only an Installation administrator holds: choose another authentication method, or ask one to set up this sign-in.";
export const DEVICE_LOGIN_START_DENIED = `Your access does not include starting a device login in this Namespace. It needs Agent create, Secret create and credential source create here, ${DEVICE_LOGIN_START_REMEDY}`;
export const AGENT_DEVICE_LOGIN_START_DENIED = `Your access does not include starting a device login for this Agent. It needs Agent read and update on it, plus Secret create and credential source create in this Namespace, ${DEVICE_LOGIN_START_REMEDY}`;
export const AGENT_DEVICE_LOGIN_POLL_DENIED = notIncluded(
  "finishing this device login",
  "Agent read and update on this Agent, plus Secret operate on the login's Secret and credential source operate on its credential source",
);
export const AGENT_DEVICE_LOGIN_CANCEL_DENIED = notIncluded(
  "cancelling this device login",
  "Agent read and update on this Agent, plus Secret operate on the login's Secret",
);

// Kubernetes Compute refuses a Dedicated Agent the Installation cannot place (no gateway routing
// or node enrollment) at Agent save, provisioning and Create Agent's preflight. A Codex Agent
// cannot switch to Embedded, so its refusal names that as a harness change.
export const DEDICATED_PLACEMENT_REQUIREMENT =
  "Dedicated Agents need gateway routing and node enrollment in this Installation's Kubernetes Compute configuration.";
export const CODEX_PLACEMENT_REFUSAL = `${DEDICATED_PLACEMENT_REQUIREMENT} Codex runs only as a Dedicated Agent: select Embedded OpenClaw, or ask an operator to configure it.`;
// Kubernetes Compute's harness rules: embedded OpenClaw takes only API key authentication, and
// Dedicated Codex takes its model credential only from the Harness authentication binding.
export const EMBEDDED_API_KEY_REQUIRED =
  "Agent setting harnessAuth.method must be api_key for embedded OpenClaw on Kubernetes Compute: change harnessAuth or executionMode.";
export const codexApiKeyRefusal = (setting) =>
  `Configuration setting ${setting} must be unset: Dedicated Codex receives model credentials from the Agent's Harness authentication binding.`;
// Deployment progress that asks an administrator to act, in fixed copy that never shows the
// quota's numbers or the image reference (packages/occ/src/state/controller-work.ts).
export const POD_QUOTA_FULL =
  "The Namespace's Pod quota is full. Stop or delete an Agent, or ask an administrator to raise the quota.";
export const IMAGE_PULL_FAILING =
  "Kubernetes cannot pull a container image for this Agent and keeps retrying. Ask an administrator to check the runtime image reference and that the cluster's nodes can pull from its registry.";

// Console refusals for a save the caller may not make.
export const AGENT_SAVE_DENIED =
  "You do not have permission to save this Agent. Ask an Installation administrator for Agent update and Configuration read on it, plus access to the Secrets, credential sources and Service Account it binds.";
export const CONFIGURATION_SAVE_DENIED =
  "You do not have permission to save this Configuration. Ask an Installation administrator for Configuration update on it, plus Secret operate on each Secret it binds.";
// A Secret field lists a Secret the caller may read but not operate disabled, with this reason,
// and a save refused on one a fresh answer names says so (finding 2453).
export const SECRET_OPERATE_DENIED =
  "Binding it needs Secret operate, which your access does not include. Ask an Installation administrator for Secret operate on it.";
// Create Agent's Create new Secret choice and typed model key, for a caller whose Secret operate
// covers only some Secrets: a new Secret gets no operate grant of its own (finding 2492).
export const NEW_SECRET_OPERATE_DENIED =
  "Your access includes Secret operate on only some Secrets in this Namespace, so an Agent cannot use a new Secret you create here.";
// What an administrator can grant instead: Secret operate on one exact Secret (finding 2507).
export const NEW_SECRET_OPERATE_REMEDY =
  "To use a new Secret, create it on the Secrets page, then ask an Installation administrator for Secret operate on it.";
// The console's 403 for a read that names its grant, and for one that names none. Granting access
// is Installation administration (findings 1920, 2259, 2260).
// A Namespace list (Secrets, Presets, Service Accounts) is refused for lack of Namespace read.
export const namespaceListDenied = (items) =>
  notIncluded(`listing ${items} in this Namespace`, "Namespace read");
// What an Installation administrator's own refused request says: asking one would not help.
export const ADMINISTRATOR_ACCESS_DENIED =
  "Access denied. You do not have permission for this operation.";
export const CONSOLE_ACCESS_DENIED =
  "Access denied. You do not have permission for this operation. Ask an Installation administrator to check your access.";
export const secretOperateRefused = (name) =>
  `You do not have permission to bind ${name}. Each save needs Secret operate on every Secret it binds, which your access does not include for it. Choose another Secret, or ask an Installation administrator for Secret operate on it.`;

// The console's text for a read that failed with a 5xx.
export const READ_UNAVAILABLE = "Service unavailable. The read could not be completed. Try again.";
// The console's text for a 400 the API does not explain, where the reader entered nothing (Stop,
// Delete): the console sent a request the API's schema refused.
export const MALFORMED_REQUEST =
  "The API refused this request as malformed. Refresh the page and try again.";
// A 429 with Retry-After names the wait: seconds up to two minutes, then whole minutes.
export const tooManyRequestsIn = (seconds) =>
  seconds < 120
    ? `Too many requests. Try again in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`
    : `Too many requests. Try again in about ${Math.ceil(seconds / 60)} minutes.`;

// The Agent page's Workspace tab without a deployed, reachable gateway.
export const WORKSPACE_FILES_UNAVAILABLE =
  "Workspace files require a deployed Agent with a current version and a reachable gateway.";

// Saves refused because the saved state changed under the editor. SAVED_CONFIGURATION_CHANGED
// also opens the channel editor's variant, so a check that reads only it matches both.
export const SAVED_CONFIGURATION_CHANGED =
  "The saved Configuration changed while you were editing.";
export const RELOAD_DRAFT_BEFORE_SAVING = `${SAVED_CONFIGURATION_CHANGED} Reload this draft before saving.`;
export const REPOSITORY_ACCESS_CHANGED =
  "Repository access changed while you were editing. Reload this draft before saving.";
export const CHANNEL_SECRETS_CONFIGURATION_CHANGED =
  "Configuration changed. Reload this draft before saving channel Secrets.";

// Actions the Agent page holds back while another editor has unsaved changes.
export const REPOSITORY_EDITS_PENDING =
  "Save or cancel repository changes before leaving this tab.";
export const CONFIGURATION_EDITS_PENDING = "Save or cancel Configuration edits before deploying.";

// The Configuration Drivers' refusal of a credential slot that holds a reference the runtime
// substitutes, but not as the whole value, naming the setting (findings 2493, 2503), and of a
// channel credential setting that holds the value itself (finding 2517).
const REFERENCE_FORMS = {
  inline:
    "holds a credential value inline, where a reference is required. Make the value a ${NAME} reference or a SecretRef",
  shorthand:
    "holds a $NAME value, where a credential reference is required. Write it as one ${NAME} reference, or a SecretRef",
  fallback:
    "holds a ${NAME:-…} fallback, which would replace a missing credential. Make the value one ${NAME} reference without a fallback, or a SecretRef",
  otherText:
    "holds a ${NAME} reference with other text, spaces or references. Make the value exactly one ${NAME} reference, or a SecretRef",
};
export const referenceFormRefusal = (setting, form) =>
  `Configuration setting ${setting} ${REFERENCE_FORMS[form]}.`;
// A channel credential's ${NAME} with no Configuration Secret binding for it, and a ${ the runtime
// does not substitute (finding 2477): a lowercase ${name} shows as written, ${NAME-text} only by
// its name, and other text (which may be the token) not at all
// (packages/occ/src/channel-secret-bindings.ts).
export const unboundReferenceRefusal = (setting, name) =>
  `Configuration setting ${setting} references ${name} without a Configuration Secret binding: bind ${name} in secretBindings to an environment-backed Secret, or remove the reference.`;
const USE_UPPERCASE =
  "use an uppercase ${NAME} bound to a Secret in secretBindings, or escape literal text as $${NAME}";
export const unsubstitutedReferenceRefusal = (setting, shown) =>
  shown === undefined
    ? `Configuration setting ${setting} contains a \${ the runtime does not substitute: ${USE_UPPERCASE}.`
    : `Configuration setting ${setting} contains ${shown}, which the runtime does not substitute: ${USE_UPPERCASE}.`;
export const unsubstitutedFallbackRefusal = (setting, name) =>
  `Configuration setting ${setting} contains \${${name}-…}, which the runtime does not substitute: write a fallback as \${${name}:-text}, with ${name} bound to a Secret in secretBindings.`;
// The Slack token rule's refusal of an object the Slack Channel Driver cannot read: a SecretRef it
// does not read, or another object (findings 2514, 2518, 2527).
const SLACK_TOKEN_OBJECTS = { secretRef: "a SecretRef", object: "an object" };
export const unreadableSlackTokenRefusal = (setting, held) =>
  `Configuration setting ${setting} holds ${SLACK_TOKEN_OBJECTS[held]} the Slack Channel Driver cannot read: use an env SecretRef with provider default, or one whole \${NAME}, bound in secretBindings.`;
// Where the console says to add a Secret binding that a channel refusal asks for: the Agent
// page's Configuration JSON editor saves none (finding 2494), and Create Agent binds only Slack's
// standard names (finding 2506).
export const CHANNEL_BINDING_CONSOLE_REMEDY =
  "This editor does not save Secret bindings: bind SLACK_APP_TOKEN and SLACK_BOT_TOKEN on the Credentials tab or in the Slack editor on the Channels tab, and other names through the Configuration API.";
export const CHANNEL_BINDING_FORM_REMEDY =
  "On this form, the Slack channel settings bind SLACK_APP_TOKEN and SLACK_BOT_TOKEN to the Secrets you select there; bind other names through the Configuration API after the Agent exists.";
// A Codex network proxy setting that blocks the repository credential broker for an Agent with
// repository bindings (finding 2350): Agent save, provisioning and deployment refuse it, and
// Compute preparation refuses it too, with a deny of the broker host it learns from the prepared
// material (packages/contracts/src/index.ts codexRepositoryBrokerNetworkProxy).
const brokerProxyRefusal = (setting, problem, change) =>
  `Configuration setting plugins.entries.codex.config.appServer.networkProxy.${setting} ${problem}, so Codex cannot reach the repository credential broker. ${change}, or remove the repository bindings.`;
export const BROKER_PROXY_DISABLED = brokerProxyRefusal(
  "enabled",
  "is false",
  "Set it to true or delete it",
);
export const BROKER_PROXY_MODE = brokerProxyRefusal(
  "mode",
  'is not "limited" or "full"',
  "Set it to one of those or delete it",
);
export const BROKER_PROXY_LOCAL_BINDING = brokerProxyRefusal(
  "allowLocalBinding",
  "is not true or false",
  "Set it to true or false or delete it",
);
export const BROKER_PROXY_DOMAINS = brokerProxyRefusal(
  "domains",
  "is not an object",
  'Map each host to "allow" or "deny"',
);
export const BROKER_PROXY_DOMAIN_DECISION = brokerProxyRefusal(
  "domains",
  'maps a host to neither "allow" nor "deny"',
  'Set each host to "allow" or "deny"',
);
export const BROKER_PROXY_EMPTY_HOST = brokerProxyRefusal(
  "domains",
  "has an empty host",
  "Delete that entry",
);
export const BROKER_HOST_DENIED = brokerProxyRefusal(
  "domains",
  "denies the repository credential broker's host",
  "Delete that deny",
);
