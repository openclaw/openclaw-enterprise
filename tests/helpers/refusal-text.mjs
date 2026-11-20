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
// An Agent create or update whose gatewayManagedMode alone needs Installation administer names the
// field (finding 2691).
export const GATEWAY_MANAGED_MODE_DENIED =
  "Not authorized: changing gatewayManagedMode needs Installation administer. Omit it, or ask an Installation administrator to change it.";
// The native admin host names the grant but no Agent: the host, not the caller, names the Agent.
export const NATIVE_ADMIN_DENIED =
  "Not authorized: opening this Agent's browser UI needs Agent operate or administer on it. Ask an Installation administrator to grant it.";
// An IAM AccessBinding subject that is an email, and one that is no eligible principal: an unknown
// ID gets the same answer as an ineligible one (finding D753).
export const BINDING_SUBJECT_EMAIL =
  "The IAM AccessBinding subject is an email address, not a principal ID. Use the person's principalId (prn_…): creating their account returns it; see the IAM guide.";
export const BINDING_SUBJECT_INELIGIBLE =
  "The IAM AccessBinding subject must be a human Principal, a non-Agent ServicePrincipal of this Namespace, or the ServicePrincipal of a live Agent here.";
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
export const PRESET_NAME_CONFLICT =
  "A Preset with this name already exists in this Namespace. Choose a different name.";
export const SERVICE_ACCOUNT_NAME_CONFLICT =
  "A ServiceAccount with this name already exists in this Namespace. Choose a different name.";
// Refusals that once read as the generic 404 or 409 and now say what to change (finding 2536).
// Agent save, provisioning and deploy (packages/occ/src/errors.ts RepositoryBindingSelectionError).
export const REPOSITORY_SELECTION_NOT_APPROVED =
  "Choose up to 16 distinct repositories approved for this Namespace and profile. For github-repository, all selections must have the same configured permissions. Ask an Installation administrator to check the available options.";
export const REPOSITORY_ACCESS_OR_BINDINGS =
  "Send repositoryAccess or repositoryBindings, not both. In repositoryAccess, list each repository once, at most 16, with a defaultProfile other than github-installation.";
export const COMPUTE_REPOSITORY_UNSUPPORTED =
  "This Installation's Compute Driver cannot deliver repository credentials, so this Agent cannot use repository access. Remove its repository bindings, or ask an Installation administrator to select Kubernetes Compute.";
// Saved selections (an Agent's, or queued provisioning work's) the repository policy no longer
// approves: deploy, the approval scope read and the provisioning worker answer 409, not 400.
export const SAVED_REPOSITORY_SELECTION_NOT_APPROVED =
  "The saved repository selections are no longer approved for this Namespace: repository policy changed after they were saved. Choose approved ones from the repository options, or ask an Installation administrator to approve them again.";
// Protected deploy admission (packages/occ/src/errors.ts CredentialProxyAdmissionError).
export const CREDENTIAL_PROXY_INSTALLATION_ACCESS =
  "Installation-wide repository access (profile github-installation) needs a Credential Proxy, and this Installation selects none. Choose another repository profile, or ask an Installation administrator to select drivers.credential_proxy.";
// Deploy of several protected sources on a Credential Proxy without policy reduction (409).
export const CREDENTIAL_PROXY_ONE_SOURCE =
  "The selected Credential Proxy cannot verify a reduced policy, so a protected revision can use only one credential source. Remove the others, or ask an Installation administrator to select a Proxy release with policy reduction.";
// Deploy of a live-adopted source whose Configuration names no provider/model (400).
export const LIVE_SOURCE_MODEL_REQUIRED =
  "Configuration setting agents.defaults.model must name a provider/model: a live-adopted credential source routes protected inference only to an explicit provider. Set it in the Agent's Configuration, then deploy again.";
// Protected credential source create: the Agent in config.agent_id (409), the type a Credential
// Proxy cannot protect (409), and a Secret reference to another Namespace (400).
export const AGENT_DELETING = "The requested Agent is being deleted.";
// 503s that name when to retry or what to start again.
export const DEVICE_LOGIN_FAILED =
  "The sign-in service did not complete this device login, so it was cancelled. Start a new device login. If it keeps failing, ask an operator to check the API logs.";
export const SERVICE_ACCOUNT_CROSS_NAMESPACE =
  "Agent setting harnessAuth.source names a ServiceAccount in another Namespace. Harness authentication can use only a ServiceAccount in the Agent's own Namespace: select one from this Namespace.";
// The sign-in endpoints' 503 (apps/controller/src/auth/index.ts); the console words its own.
export const SIGN_IN_UNAVAILABLE =
  "Sign-in is temporarily unavailable. Try again shortly. If it continues, ask an operator to check the API logs.";
// The sign-in endpoints' 429. The password limiter names its wait, the same number of seconds as
// its Retry-After header, which counts down: two refusals a second apart differ in it. The external
// sign-in budgets refill each minute and send no Retry-After.
export const signInRateLimited = (seconds) =>
  `Too many attempts. Wait ${seconds === 1 ? "1 second" : `${seconds} seconds`}, then try again.`;
export const SIGN_IN_RATE_LIMITED_MINUTE = "Too many attempts. Wait a minute, then try again.";
// The same places for an Installation administrator whom a deny Restriction keeps from creating
// Agents in this Namespace (finding D759): administration cannot lift it.
export const AGENT_CREATE_RESTRICTED =
  "A Restriction in this Namespace denies Agent create, even for Installation administrators. Ask whoever manages IAM Restrictions to lift it, or create the Agent in another Namespace.";
// Secrets and Namespaces follow the same rule: Namespace Roles cannot grant people create.
export const SECRET_CREATE_DENIED =
  "Your access does not include creating Secrets in this Namespace. Only an Installation administrator can create Secrets: ask one to create it and to give you Secret read and operate on it.";

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
// Deploy's status line on the draft for a reader without Agent deploy names the grant (D753).
export const AGENT_DEPLOY_NOT_INCLUDED = notIncluded("deploying this Agent", "Agent deploy on it");
// The Stop confirmation, on the Agents list and the Agent page, by what the page read of the
// Agent's version and its latest deployment (apps/controller/src/console/agents/
// lifecycle-confirmation.mts, finding D691).
const STOP_KEEPS =
  "Configuration, versions, Credentials, and workspace data are retained. Deploy a new version to start the Agent again.";
// A version is selected for service.
export const STOP_CONFIRMATION = `This interrupts the current runtime gateway and ends any reply in progress; open chats can keep showing it as responding. ${STOP_KEEPS}`;
// No version is selected and the first deployment is queued or in progress.
export const STOP_FIRST_DEPLOYMENT_CONFIRMATION = `No version is serving yet, so this cancels the deployment in progress. ${STOP_KEEPS}`;
// No version is selected and the page could not read the latest deployment's outcome.
export const STOP_UNKNOWN_DEPLOYMENT_CONFIRMATION = `This cancels a deployment in progress or, if a version already started, interrupts its runtime gateway and ends any reply in progress. ${STOP_KEEPS}`;
// The Agent is already requested to stop: Request Stop again only repeats the request (D815).
export const STOP_REPEAT_CONFIRMATION = `This Agent is already requested to stop. This sends the stop request again; use it if an earlier stop did not finish. ${STOP_KEEPS}`;
// The Agent page's Stop row, by whether Stop would cancel a first deployment in progress.
export const STOP_CANCELS_FIRST_DEPLOYMENT = "Cancels this deployment without deleting Agent data.";
export const STOP_RUNNING_VERSION = "Stops the running version without deleting Agent data.";
// A request the API refused for lack of a grant: what the reader tried, then the grant to ask for.
export const permissionRefused = (task, grant) =>
  `You do not have permission to ${task}. ${askForGrant(grant)}`;
// A refused Stop or Delete names the Agent on the Agents list and "this Agent" on its page, says
// what was refused, then the reason (finding D753).
export const stopRefused = (name) =>
  `Stop was refused: your access does not include stopping ${name}. ${askForGrant("Agent operate on it")}`;
export const deleteRefused = (name) =>
  `Deletion was refused: your access does not include deleting ${name}. ${askForGrant("Agent delete on it")}`;
// A version link the page cannot list may name a version that does not exist: the API answers
// both alike, so the console says either may be true (finding D750).
export const VERSION_UNAVAILABLE =
  "This version does not exist or your access does not include it. If you need it, ask an Installation administrator for AgentRevision read on it.";
export const requestedVersionUnavailable = (version) =>
  `Version ${version} does not exist or your access does not include it, so this page shows no progress or outcome for it. If you need it, ask an Installation administrator for AgentRevision read on it.`;
// A version the reader's own Deploy created exists, so the page says it was accepted (finding D751).
export const deployAcceptedVersionUnreadable = (version) =>
  `Deployment accepted. You cannot read version ${version}, so its progress and outcome are not shown here; ask an Installation administrator for AgentRevision read on it.`;
// The summary card for that version, after a first deployment or a redeploy alike (finding D755).
export const DEPLOYED_VERSION_UNREADABLE = "You cannot read the version you deployed.";
export const VERSION_READ_DENIED =
  "Your access does not include this version, so its configuration and deployment outcome are hidden. Ask an Installation administrator for AgentRevision read on it.";
// The API's recorded message for the same failure, which tells everyone to change the credential.
export const MODEL_CREDENTIAL_REJECTED_RECORDED =
  "The model provider rejected this version's credential (HTTP 401 or 403). Check that the key or token is valid and can use the selected model, update or replace the Agent's model credential, then deploy a new version.";
// The API has no route to Slack (SlackRouteNotConfiguredError, apps/controller/src/drivers/channel/
// slack.ts). A member reads who to ask, not Helm keys; the guide lists them (findings D750, D753).
export const SLACK_ROUTE_NOT_CONFIGURED =
  "Managed channel egress is not configured for OCC provider requests. Ask an Installation administrator to enable the channel egress fleet.";
// Agent-side save controls, from the caller's permission answer (findings 2441, 2459).
export const AGENT_UPDATE_DENIED = notIncluded(
  "saving these settings",
  "Agent update on this Agent",
);
export const AGENT_SOURCES_DENIED =
  "Saving these settings needs operate on each Secret and credential source this Agent and its Configuration bind, which your access does not include. Ask an Installation administrator for that access.";
// Device login from Create Agent (Namespace-scoped) and from Agent detail (Agent-scoped): a start
// requires credential source create. A poll checks the Agent scope and source operate;
// cancellation checks only the Agent scope.
const DEVICE_LOGIN_START_REMEDY =
  "which only an Installation administrator holds: choose another authentication method, or ask one to set up this sign-in.";
export const DEVICE_LOGIN_START_DENIED = `Your access does not include starting a device login in this Namespace. It needs Agent create and credential source create here, ${DEVICE_LOGIN_START_REMEDY}`;
export const AGENT_DEVICE_LOGIN_START_DENIED = `Your access does not include starting a device login for this Agent. It needs Agent read and update on it, plus credential source create in this Namespace, ${DEVICE_LOGIN_START_REMEDY}`;
export const AGENT_DEVICE_LOGIN_CANCEL_DENIED = notIncluded(
  "cancelling this device login",
  "Agent read and update on this Agent",
);

// Kubernetes Compute refuses a Dedicated Agent the Installation cannot place (no gateway routing
// or node enrollment) at Agent save, provisioning and Create Agent's preflight. A Codex Agent
// cannot switch to Embedded, so its refusal names that as a harness change.
export const DEDICATED_PLACEMENT_REQUIREMENT =
  "Dedicated Agents need gateway routing and node enrollment in this Installation's Kubernetes Compute configuration.";
export const CODEX_PLACEMENT_REFUSAL = `${DEDICATED_PLACEMENT_REQUIREMENT} Codex runs only as a Dedicated Agent: select Embedded OpenClaw, or ask an operator to configure it.`;
// The Compute Driver's own refusal of Dedicated storage without them, at provisioning, preparation
// and activation. The API keeps it out of the response and logs it as the refusal reason; the
// worker records it as the permanent failure reason.
export const DEDICATED_STORAGE_ROUTING_REQUIRED =
  "Dedicated Harness storage requires gateway routing and node enrollment.";
// Kubernetes Compute's harness rules: embedded OpenClaw takes only API key authentication, and
// Dedicated Codex takes its model credential only from the Harness authentication binding.
export const EMBEDDED_API_KEY_REQUIRED =
  "Agent setting harnessAuth.method must be api_key for embedded OpenClaw on Kubernetes Compute: change harnessAuth or executionMode.";
export const codexApiKeyRefusal = (setting) =>
  `Configuration setting ${setting} must be unset: Dedicated Codex receives model credentials from the Agent's Harness authentication binding.`;
// Kubernetes Agent save and deploy admission refuse a plugin setting that turns off file-transfer
// for an Agent whose Gateway hosts its workspace node (findings 1112, 3083). `setting` is
// plugins.deny, plugins.enabled or plugins.entries.file-transfer.enabled; `rule` is what it must
// satisfy, such as "must not be false".
export const workspaceNodePluginRefusal = (setting, rule) =>
  `Configuration setting ${setting} ${rule}: the Agent's workspace node requires the file-transfer plugin.`;
// Kubernetes Configuration save, Agent save, provisioning and deploy admission refuse a plugin
// setting that turns off the codex plugin every Dedicated Codex Gateway runs (finding 3096).
// `setting` is plugins.allow, plugins.deny or plugins.enabled; `rule` is what it must satisfy,
// such as "must list codex"; `step` is the fix, such as "Add it".
export const codexPluginRefusal = (setting, rule, step) =>
  `Configuration setting ${setting} ${rule}: Dedicated Codex runs the codex plugin, so its Gateway would not start. ${step}.`;
// Configuration save, Agent save and deploy admission refuse a plugins.entries key that spells the
// codex or acpx plugin another way (finding 3073), and on Kubernetes file-transfer or a managed
// plugin (finding 3077). `path` is the setting as the message shows it, such as
// plugins.entries.Codex or plugins.entries[" codex"]; `id` is the plugin. Renaming the key beside
// the exact entry would leave a duplicate key, so the step says what to do in both cases (finding
// 3087).
export const pluginEntryKeyVariantRefusal = (path, id) =>
  `Configuration setting ${path} must be named ${id}: OpenClaw merges it into plugins.entries.${id}, the entry OCE checks. If that entry exists, move these settings into it and remove this key; else rename this key.`;
// Configuration save, Agent save and deploy admission refuse a plugins.allow or plugins.deny that
// OpenClaw's config schema refuses, so no Gateway starts with it (finding 3101): `key` is allow or
// deny; `list` is false for a value that is not a list, true for a list item that is not text.
export const pluginPolicyListRefusal = (key, list = true) =>
  list
    ? `Configuration setting plugins.${key} must list only plugin IDs as text, or the Gateway does not start: remove any other item.`
    : `Configuration setting plugins.${key} must be a list of plugin IDs as text, or the Gateway does not start: make it a list or remove it.`;
// Kubernetes Compute generates the Gateway password, so gateway.auth.password may only reference it,
// on the default env provider alias (secrets.defaults.env, else "default").
export const kubernetesGatewayPasswordRequirement = (alias = "default") =>
  `must be the environment reference {source: "env", provider: "${alias}", id: "OPENCLAW_GATEWAY_PASSWORD"}, whose value Kubernetes Compute generates`;
export const KUBERNETES_GATEWAY_PASSWORD_REQUIREMENT = kubernetesGatewayPasswordRequirement();
export const KUBERNETES_GATEWAY_PASSWORD_REFUSAL = `Configuration setting gateway.auth.password ${KUBERNETES_GATEWAY_PASSWORD_REQUIREMENT}.`;
// A Dedicated Codex Configuration without gateway.auth.password, where the Installation applies the
// workspace node at runtime: every activation failed AGENT_GATEWAY_UNAUTHORIZED (finding 3132), so
// save, preflight, provisioning and deploy admission refuse it.
export const kubernetesWorkspaceNodePasswordRefusal = (alias = "default") =>
  `Configuration setting gateway.auth.password must be the environment reference {source: "env", provider: "${alias}", id: "OPENCLAW_GATEWAY_PASSWORD"} on a Dedicated Codex Agent: its Gateway uses it to apply the workspace node.`;
export const KUBERNETES_WORKSPACE_NODE_PASSWORD_REFUSAL = kubernetesWorkspaceNodePasswordRefusal();
// Kubernetes Configuration save, provisioning and deploy admission refuse a trusted-proxy allowlist
// and a device auto-approval the Gateway would refuse, naming no submitted identity (finding 3032).
// The allowlist text says which identities match case-insensitively, so a case duplicate reads as
// one (finding 3122).
export const KUBERNETES_ALLOW_USERS_REFUSAL =
  "Configuration setting gateway.auth.trustedProxy.allowUsers must include occ-workspace-files and list distinct (case-insensitive for occ-workspace-files and @ identities), nonblank, trimmed, printable ASCII identities that are not object property names.";
export const KUBERNETES_DEVICE_AUTO_APPROVE_REFUSAL =
  "Configuration setting gateway.auth.trustedProxy.deviceAutoApprove must be an object with only an optional boolean enabled and an optional array of nonblank scope names.";
// Deploy and Agent provisioning of dedicated OpenClaw where the Installation selects no
// provisioning SandboxDriver with all three containment facets (409 RESOURCE_CONFLICT). It names
// the next step: codex for the selected models when Codex runs them (`codexRuns`), else a Codex
// model (finding 3036), within the API's 256-character message cap. Stored provisioning work keeps
// the first sentence alone, as a 503.
export const DEDICATED_OPENCLAW_SANDBOX_REQUIRED =
  "Dedicated OpenClaw requires a provisioning SandboxDriver with networking, filesystem, and process containment.";
export const dedicatedOpenClawSandboxRefusal = (codexRuns) =>
  `${DEDICATED_OPENCLAW_SANDBOX_REQUIRED} ${
    codexRuns
      ? "Set agentRuntime.id to codex for the selected models"
      : "Select a codex/<model> model with agentRuntime.id codex"
  }, or ask an Installation administrator for such a SandboxDriver.`;
// Model policy refusals at Configuration save and deploy (packages/occ/src/configured-harness.ts).
// `policy` is the setting path of the object that holds agentRuntime, such as
// agents.defaults.models["openai/gpt-4.1"] or models.providers.openai.models[0]; `parent` is
// agents.defaults.models or agents.entries.<id>.models.
export const runtimeIdUnsupported = (policy) =>
  `Configuration setting ${policy}.agentRuntime.id must be openclaw or codex.`;
// `offer` lists only values deployment then accepts: "openclaw", "openclaw or codex" where Codex
// runs the model ("codex" alone for a dedicated Agent on an Installation that cannot run
// dedicated OpenClaw, finding 3036; "openclaw" alone for an embedded Agent where the Installation
// approves Codex only for dedicated execution, finding 3037), or the runtime the other selected
// models use.
export const runtimeIdRequired = (policy, offer) =>
  `Configuration setting ${policy}.agentRuntime.id is required for the selected model: set it to ${offer}.`;
// `remedy` offers only values deployment then accepts: BOTH_RUNTIMES, or keepRuntime(...) when
// only one runtime is accepted (Codex does not run the model, another policy or an earlier
// selected model already selects it, or the deploying Agent cannot run the other one), or
// noRunnableRuntime("both") where the deploying Agent runs neither (finding 3037).
export const runtimePoliciesConflict = (first, firstId, second, secondId, remedy) =>
  `Configuration settings ${first}.agentRuntime.id (${firstId}) and ${second}.agentRuntime.id (${secondId}) conflict: ${remedy}.`;
export const keepRuntime = (runtime, other) =>
  `set both to ${runtime}, or remove the one set to ${other}`;
// `remedy` keeps only the step the deploying Agent can take: CODEX_MODEL_ONLY where it cannot run
// OpenClaw (finding 3036), OPENCLAW_ONLY where it cannot run Codex (finding 3037).
export const CODEX_MODEL_OR_OPENCLAW = "select a codex/<model> model, or set it to openclaw";
export const OPENCLAW_ONLY = "set it to openclaw";
export const codexRuntimeOffProvider = (policy, remedy = CODEX_MODEL_OR_OPENCLAW) =>
  `Configuration setting ${policy}.agentRuntime.id selects codex for a model outside the codex provider: ${remedy}.`;
export const selectableModelOffProvider = (policy, provider) =>
  `Configuration setting ${policy} is not on the primary model's provider, "${provider}": remove it, or list a model of that provider.`;
// A provider catalog row (`provider` such as models.providers.openai) that names no selected
// model; with no model selected at all, the refusal names the model setting instead.
export const catalogRowUnselected = (provider) =>
  `Configuration setting ${provider}.models may list only entries whose id names a primary or fallback model set in agents.defaults.model or agents.entries.`;
export const catalogRowNoModel = (provider) =>
  `Configuration setting ${provider}.models lists models, but no model is selected: set agents.defaults.model or an agents.entries model.`;
// Deployment progress that asks an administrator to act, in fixed copy that never shows the
// quota's numbers or the image reference (packages/occ/src/state/controller-work.ts).
export const POD_QUOTA_FULL =
  "The Namespace's Pod quota is full. Stop or delete an Agent, or ask an Installation administrator to raise the quota.";
export const IMAGE_PULL_FAILING =
  "Kubernetes cannot pull a container image for this Agent and keeps retrying. Ask an Installation administrator to check the runtime image reference and that the cluster's nodes can pull from its registry.";
export const WORKSPACE_SETUP_RETRYING =
  "Workspace setup failed; Kubernetes is retrying it. If it keeps failing, ask an Installation administrator to check the Agent's workspace storage and runtime image.";
// Failed deployments whose next step needs an Installation administrator, or an operator for the
// cluster's own capacity, keyed by error code (deploymentErrorMessage in controller-work.ts).
export const DEPLOYMENT_FAILED = {
  AUTHORIZATION_DENIED:
    "The deploying account, or the Agent's own identity, lost a permission the revision needs: Agent deploy, Configuration read, or use of a bound Secret, credential source or ServiceAccount. Ask an Installation administrator to grant it, then deploy again.",
  BACKEND_UNAVAILABLE:
    "The Backend this revision was admitted with is no longer configured on the Installation. Ask an Installation administrator to restore it, or move the Agent to a configured Backend, then deploy again.",
  DEPENDENCY_UNAVAILABLE:
    "A dependency the controller needs stayed unavailable through every attempt. Deploy again; if it keeps failing, ask an Installation administrator to check the controller worker log.",
  REPOSITORY_BINDING_UNAVAILABLE:
    "A repository this revision binds, or its access level, is no longer approved for the Agent's Namespace. Choose approved repository access on the Agent, or ask an Installation administrator to approve it again, then deploy again.",
  REPOSITORY_DRIVER_MISMATCH:
    "The Installation no longer selects the repository credential Driver admitted with this revision. Deploy again, choosing approved repository access if refused. If it selects none, remove repository access or ask an Installation administrator to select one.",
  REPOSITORY_RUNTIME_UNSUPPORTED:
    "This revision lost repository credentials: they need an embedded OpenClaw or dedicated Codex runtime, no Sandbox Driver, and a Compute Driver set up for them. Ask an Installation administrator to restore that or remove repository access, then deploy again.",
  RUNTIME_CPU_STARVED:
    "Deployment runtime did not get enough CPU to finish its startup model check, because of a CPU limit below one core or a busy node. Ask an Installation administrator to raise the limit, or an operator to free node capacity, then deploy a new version.",
  WORKSPACE_SETUP_REFUSED:
    "Initial workspace setup refused this version, and retries would too: its files, setup record or runtime defaults differ from the Agent's originals. Ask an Installation administrator to check workspace storage and the runtime image; keep the setup record.",
  WORKSPACE_SETUP_UNSUPPORTED:
    "The Agent was created with initial workspace files, which the Installation's Compute Driver cannot set up. Ask an Installation administrator to select a Compute Driver that supports them, then deploy again, or create the Agent without them.",
};

// Console refusals for a save the caller may not make, when the API names no grant.
export const AGENT_SAVE_DENIED =
  "Save was refused: your access does not include saving this Agent. Ask an Installation administrator for Agent update and Configuration read on it, plus access to the Secrets, credential sources and Service Account it binds.";
export const CONFIGURATION_SAVE_DENIED =
  "Save was refused: your access does not include saving this Configuration. Ask an Installation administrator for Configuration update on it, plus Secret operate on each Secret it binds.";
// A Secret field lists a Secret the caller may read but not operate disabled, with this reason,
// and a save refused on one a fresh answer names says so (finding 2453).
export const SECRET_OPERATE_DENIED =
  "Binding it needs Secret operate, which your access does not include. Ask an Installation administrator for Secret operate on it.";
// The console's 403 for a read that names its grant, and for one that names none. Granting access
// is Installation administration (findings 1920, 2259, 2260).
// A Namespace list (Secrets, Presets, Service Accounts) is refused for lack of Namespace read.
export const namespaceListDenied = (items) =>
  notIncluded(`listing ${items} in this Namespace`, "Namespace read");

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

// Every console view that meets NAMESPACE_NOT_READY shows this one sentence (finding 2538).
export const CONSOLE_NAMESPACE_NOT_READY =
  "This Namespace is not ready yet. Check its status on the Namespaces page: a provisioning Namespace becomes ready when its Kubernetes setup completes. If it stays provisioning, ask an operator to finish that setup.";
// Why a read failed with an outage (agents/list.mts readFailureReason).
export const READ_OUTAGE_REASON =
  "The service did not answer. Try again; if it continues, ask an operator to check the API.";
export const OVERVIEW_REFRESH_FAILED =
  "Current version and version history could not be refreshed.";
// A workspace file read or write that the gateway did not answer.
export const WORKSPACE_UNREACHABLE =
  "Workspace files could not be reached: the Agent's gateway did not answer. Check that the Agent is running, then reload this file. If it continues, ask an operator to check the gateway.";
// A workspace file request that never reached the API (a fetch that failed in the browser).
export const WORKSPACE_API_UNREACHABLE =
  "The request did not reach the API. Check your connection, then reload this file.";
// A Stop that the API accepted for an Agent with a running version.
export const STOP_REQUESTED =
  "Stop requested. Deploy a new version to restart. Runtime shutdown is not verified here.";
// A Stop that the API accepted while a first deployment was queued or in progress.
export const STOP_REQUESTED_FIRST_DEPLOYMENT =
  "Deployment cancellation requested. Deploy a new version to restart.";
// The Stop panel with no version selected and no first-deployment Stop requested here.
export const STOPPED_NO_VERSION =
  "No version is selected. Deploy a new version to start this Agent.";
// A Stop status read that failed: the prefix, then why (agents/stop.mts).
export const STOP_STATUS_REFRESH_FAILED = "Could not refresh stop status.";
export const stopStatusRefreshFailed = (reason) => `${STOP_STATUS_REFRESH_FAILED} ${reason}`;

// The Agent page's Workspace tab without a deployed, reachable gateway.
export const WORKSPACE_FILES_UNAVAILABLE =
  "Workspace files require a deployed Agent with a current version and a reachable gateway. Deploy the Agent to read or edit them.";

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
// Kubernetes Compute admission of an Agent's plugin secret input whose unset variable stops its
// Gateway at startup (findings 3040, 3041, 3042): an APP_SERVER_ variable on an embedded or
// Dedicated OpenClaw Agent at Agent save and deployment, any other unbound name a binding could
// set at deployment.
export const dedicatedCodexVariableRefusal = (
  setting,
  name,
  plugin = "codex",
  agent = "an embedded",
) =>
  `Configuration setting ${setting} references ${name}, which only a Dedicated Codex Agent receives: on ${agent} Agent, remove plugins.entries.${plugin} or set its enabled to false.`;
// `enabledBy`: the key of a later entry for the same plugin that enables it, such as GOOGLE; the
// step names it instead of the entry itself (finding 3074). `null`: the order written and the
// stored order end on different entries, so the step offers only removal (finding 3095).
export const unboundPluginSecretRefusal = (setting, name, plugin, enabledBy) =>
  `Configuration setting ${setting} references ${name} without a Configuration Secret binding: bind ${name} in secretBindings, or remove plugins.entries.${plugin}${enabledBy === null ? "" : ` or set ${enabledBy === undefined ? "its enabled" : `plugins.entries.${enabledBy}.enabled`} to false`}.`;
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
// page's Configuration JSON editor saves none (finding 2494), the Credentials tab binds only Slack's
// standard names (finding 2542), and Create Agent binds only those too (finding 2506).
const CHANNEL_BINDING_PLACES =
  "bind SLACK_APP_TOKEN and SLACK_BOT_TOKEN on the Credentials tab or in the Slack editor on the Channels tab, and other names through the Configuration API.";
export const CHANNEL_BINDING_CONSOLE_REMEDY = `This editor does not save Secret bindings: ${CHANNEL_BINDING_PLACES}`;
export const CHANNEL_BINDING_CREDENTIALS_REMEDY = `To fix it, ${CHANNEL_BINDING_PLACES}`;
// The Slack card of an Embedded Agent, on Create Agent and the Agent page's Channels tab.
export const CHANNELS_NEED_DEDICATED =
  "Channels require Dedicated execution. Embedded Agents can only keep channels disabled.";
// Kubernetes Compute's Configuration rule for an uninstalled channel provider, at
// Configuration and Preset save and at deployment (apps/controller/src/drivers/compute/kubernetes/
// configuration-rules.ts). `setting` is channels.<name>.
export const unsupportedChannelRefusal = (setting) =>
  `Configuration setting ${setting} is not a supported channel: use slack, or set its enabled to false.`;
// The Slack card's setup step, shown until both token Secrets are bound (finding 2438), and never
// on an Embedded Agent, which cannot have channels (finding D708).
export const SLACK_SETUP_HINT =
  "Provide SLACK_APP_TOKEN and SLACK_BOT_TOKEN through Secret bindings before deployment.";
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
// Repository credentials the selected Compute topology cannot deliver (Agent save and deploy 409,
// packages/occ/src/index.ts), and the fixed status text of provisioning work that failed for a
// reason it does not name.
export const COMPUTE_TOPOLOGY_REPOSITORY_UNSUPPORTED =
  "The selected Compute Driver cannot deliver repository credentials to this Harness topology.";
export const PROVISIONING_NOT_COMPLETED = "Agent provisioning could not complete.";
// An Installation without repository access. Only an Installation administrator can set it up,
// so only one gets the setup guide link; anyone else is told whom to ask (finding D754).
export const REPOSITORY_ACCESS_NOT_CONFIGURED =
  "This Installation has no repository access, so this Agent cannot use repositories.";
export const REPOSITORY_SETUP_ASK = "Ask an Installation administrator to set it up.";

// Finding 2536, slice 4. The bundled OpenShell Credential Proxy refuses installation-wide
// repository access without its preview opt-in (409), and names the gateway states an operator
// fixes (503); a stored source that breaks a later OpenShell Credential Gateway rule (409); a
// ChatGPT service account whose credential does not belong to the Agent's Backend (409).
export const CREDENTIAL_PROXY_GIT_ALONE =
  "The selected Credential Proxy cannot add other credential sources beside this Agent's repository Git. Remove those sources or the repository binding, or ask an Installation administrator to select a Proxy with policy reduction.";
export const CREDENTIAL_PROXY_INSTALLATION_PREVIEW =
  "Installation-wide repository access (profile github-installation) needs the OpenShell Credential Proxy's observed-hook preview, which this Installation does not enable. Choose another profile, or ask an Installation administrator to enable the preview.";
export const PROXY_REGISTRATION_UNAVAILABLE =
  "The OpenShell gateway does not offer the protected egress middleware the Credential Proxy is configured to use. Ask an operator to check the gateway's middleware registration, protocol and capabilities, then retry.";
export const storedCredentialSourceConfig = (field) =>
  `This credential source's saved ${field} no longer meets the OpenShell Credential Gateway's rules, so it cannot be used. Create a new source with a valid ${field}, bind it in place of this one, then delete this one.`;
// The Agent page's heading for a version that exists but the reader's access does not include
// (agents/detail.mts); VERSION_READ_DENIED is its reason.
export const VERSION_READ_DENIED_HEADING = "You cannot read this version";
// The version draft a reader without Agent update views (finding 2421), and its plugin list.
export const READ_ONLY_DRAFT_NOTICE =
  "Version draft · read-only with your access. The next deployment uses it as saved.";
// Why a running version reads "Not verified" (finding 2367).
export const NO_TEST_REQUEST = "OpenClaw Enterprise sends no test request.";
// The API's refusal of a sandbox policy rule outside the Installation delegation ceiling.
export const GRANT_EXCEEDS_CEILING = "The grant exceeds the Installation delegation ceiling.";
// Plugin discovery with a credential the plugin service rejected (agents/plugin-discovery.mts).
export const PLUGIN_CREDENTIALS_REJECTED =
  "The credential was rejected or cannot access plugins. Check its permissions.";

// Finding 2619. A bound Secret the caller's readable Secret list leaves out, shown without the
// audited metadata read; and the Backends refusal a non-administrator gets without the read.
export const BOUND_SECRET_UNLISTED = `A Secret is bound. Its name is unavailable: your access does not include reading it, or it was deleted. ${askForGrant("Secret read on it")}`;
// Finding D760. A link to the Access tab, or its refused policy read, for a reader who does not
// administer the Installation.
export const ACCESS_TAB_UNAVAILABLE =
  "The Access tab needs Installation administration, which your access does not include. Showing Configuration.";
// Finding D756. Deploy beside a bound Secret the deployer may neither read nor operate: it names
// no Secret, and the grant to ask for includes read.
export const deployUnreadableSecrets = (count) =>
  count === 1
    ? `Deploying needs Secret operate on a bound Secret your access does not include reading. ${askForGrant("Secret read and operate on it")}`
    : `Deploying needs Secret operate on ${count} bound Secrets your access does not include reading. ${askForGrant("Secret read and operate on them")}`;
// The sandbox policy editing setting, which only an Installation administrator who also
// administers the Agent can change.
export const POLICY_EDITING_SETTING_REFUSED =
  "Your access does not include changing the editing setting. Only an Installation administrator who also administers this Agent can change it.";
// Rechecking an open Agent page when the API names no grant.
export const AGENT_PAGE_READ_DENIED = notIncluded(
  "reading this Agent, its versions or its Configuration",
  "Agent read, AgentRevision read and Configuration read on them",
);

// Every per-Agent network policy answer on an Installation that selects no Sandbox Driver: the
// policy view, validate, save, apply and turning editing on (D774).
export const NO_SANDBOX_DRIVER_NETWORK_POLICY =
  "This Installation selects no Sandbox Driver, so Agents run without a Sandbox: there are no policy denials, suggestions or Agent network rules.";
// A policy denial that names only OpenShell's policy DNS placeholder address, with no record
// of the host it stood for in the loaded log: the row proposes no rule (D771).
export const PLACEHOLDER_DESTINATION =
  "OpenShell logged only a placeholder address for this connection, and the record that names its hostname is not in the loaded log, so this denial proposes no rule. Add a rule for the hostname in Manage rules.";
export const POLICY_RECOMMENDATIONS_NO_SANDBOX =
  "This version runs without a Sandbox, so it records no network denials to recommend policy from. Policy recommendations need an Agent deployed with a Sandbox Driver such as OpenShell.";
export const DEVICE_LOGIN_NOT_CONFIGURED =
  "Device login needs a Credential Gateway and a Credential Refresh Driver, and this Installation does not select both. Ask an Installation administrator to select them; see the credential lifecycle guide.";
export const REPOSITORY_SETTINGS_MISSING =
  "This Installation has no repository settings, so no repository credential Driver is selected and an Agent cannot bind repositories. Remove the repository bindings, or ask an Installation administrator to add repository settings to the Installation.";
// The caller's own denial of the grant an Agent update checks on the Agent's current Harness
// authentication, which an update that replaces it also needs (finding D763).
export const currentHarnessAuthDenied = (grant, target) =>
  `Not authorized: this needs ${grant} on ${target}, the Agent's current Harness authentication: every update checks it, even one that replaces it. Ask an Installation administrator to grant it.`;
// Native admin status for a caller without Agent administer, on an Installation with native admin
// off: the grant alone would not open it (finding D762).
export const nativeAdminOffDenied = (target) =>
  `${callerDenied("Agent operate", target)} Native admin is also off on this Installation, so the grant alone would not open it.`;
// A workspace file read or write on an Agent with no running version, after the Agent grant
// (finding D768): stopped or never deployed, or a deployment still starting.
export const workspaceWithoutRunningVersion = (agentId) =>
  `Agent ${agentId} has no running version, so its workspace files cannot be read or written. Deploy it, then try again.`;
export const workspaceVersionStarting = (agentId) =>
  `Agent ${agentId} has no running version yet: its deployment is still starting, so its workspace files cannot be read or written. Try again when the deployment finishes.`;

// Deploy new version's reason while saved Secrets wait for the Agent's grant names the bindings
// whose Secrets wait, as the Credentials tab lists them, and where to grant access (finding 3017).
// `missing`: an Installation administrator's console read no grant; otherwise a grant request left
// it unconfirmed. `administrator`: the grant was refused, or the reader is offered no Retry.
export const secretGrantDeployReason = (
  bindings,
  { missing = false, administrator = false } = {},
) => {
  const names =
    bindings.length < 2
      ? bindings.join("")
      : `${bindings.slice(0, -1).join(", ")} and ${bindings.at(-1)}`;
  const secrets = `the ${bindings.length > 1 ? "Secrets" : "Secret"} bound to ${names}`;
  const problem = missing
    ? `This Agent has no access to ${secrets}, so deploying it would be refused.`
    : `This Agent's access to ${secrets} is not confirmed.`;
  const step = administrator
    ? "Granting access needs Installation administration access: ask an Installation administrator to open this Agent's Credentials and select Retry Secret access."
    : "Open Credentials and select Retry Secret access.";
  return `${problem} ${step}`;
};

// Channel Secrets outcomes once the Agent can use its bound Secrets (agents/credentials.mts). With
// Slack on they name the saved Slack Secrets. With Slack off a Retry saved nothing about Slack, so
// they name the bound Secrets (finding 3021). A grant read that finds the grant a lost Retry made
// says access is confirmed (finding 3030).
const SLACK_SECRETS_USABLE =
  "This Agent can use its saved Slack Secrets. Deploy the new version to deliver them.";
const BOUND_SECRETS_USABLE =
  "This Agent can use its bound Secrets. Deploy the new version to deliver them.";
export const SLACK_RETRY_GRANTED = SLACK_SECRETS_USABLE;
export const SLACK_OFF_RETRY_GRANTED = `Secret access granted. ${BOUND_SECRETS_USABLE}`;
export const secretAccessConfirmed = (slackOn) =>
  `Secret access confirmed. ${slackOn ? SLACK_SECRETS_USABLE : BOUND_SECRETS_USABLE}`;
