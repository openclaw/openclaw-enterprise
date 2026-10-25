// Expected refusal text that the product defines once. Tests compare against these constants instead
// of local copies, so a wording change is one edit here. A missed copy cannot drift: a check that
// the text is absent would still pass on stale wording. The text is written out here and not
// imported from product source, so a wording regression still fails the tests that read it.

// The API's generic error messages (apps/controller/src/http/errors.ts). Console tests use them
// as the server's answer in fulfilled routes, and API tests expect them in error envelopes.
export const GENERIC_DENIAL = "The exact platform operation was not authorized.";
export const DEPENDENCY_UNAVAILABLE = "A required platform dependency is unavailable.";
export const RESOURCE_CONFLICT = "The requested platform resource already exists.";
export const RESOURCE_NOT_FOUND = "The requested platform resource was not found.";
export const NAMESPACE_NOT_READY = "The requested Namespace is not ready.";
// Agent create, its preflight and provisioning refuse a name another Agent in the Namespace has
// (AGENT_NAME_CONFLICT in errors.ts); a provisioning job that loses the name race reports it too.
export const AGENT_NAME_CONFLICT =
  "An Agent with this name already exists in this Namespace. Choose a different name.";
// Create Agent and the Agents list for a caller without Agent create, which Namespace Roles cannot
// grant people (findings 2496, 2508).
export const AGENT_CREATE_DENIED =
  "Your access does not include creating Agents in this Namespace. Only an Installation administrator can create Agents: ask one to create it and to give you access to edit and deploy it.";

// Kubernetes Compute refuses a Dedicated Agent the Installation cannot place (no gateway routing
// or node enrollment) at Agent save, provisioning and Create Agent's preflight. A Codex Agent
// cannot switch to Embedded, so its refusal names that as a harness change.
export const DEDICATED_PLACEMENT_REQUIREMENT =
  "Dedicated Agents need gateway routing and node enrollment in this Installation's Kubernetes Compute configuration.";
export const CODEX_PLACEMENT_REFUSAL = `${DEDICATED_PLACEMENT_REQUIREMENT} Codex runs only as a Dedicated Agent: select Embedded OpenClaw, or ask an operator to configure it.`;

// Console refusals for a save the caller may not make.
export const AGENT_SAVE_DENIED =
  "You do not have permission to save this Agent. Ask an administrator for Agent update and Configuration read access, plus access to the Secrets, credential sources and Service Account it binds.";
export const CONFIGURATION_SAVE_DENIED =
  "You do not have permission to save this Configuration. Ask an administrator for Configuration update access, plus Secret operate on each Secret it binds.";
// A Secret field lists a Secret the caller may read but not operate disabled, with this reason,
// and a save refused on one a fresh answer names says so (finding 2453).
export const SECRET_OPERATE_DENIED =
  "Binding it needs Secret operate, which your access does not include.";
// Create Agent's Create new Secret choice and typed model key, for a caller whose Secret operate
// covers only some Secrets: a new Secret gets no operate grant of its own (finding 2492).
export const NEW_SECRET_OPERATE_DENIED =
  "Your access includes Secret operate on only some Secrets in this Namespace, so an Agent cannot use a new Secret you create here.";
// What an administrator can grant instead: Secret operate on one exact Secret (finding 2507).
export const NEW_SECRET_OPERATE_REMEDY =
  "To use a new Secret, create it on the Secrets page, then ask an administrator to grant you Secret operate on that Secret.";
export const secretOperateRefused = (name) =>
  `You do not have permission to bind ${name}. Each save needs Secret operate on every Secret it binds, which your access does not include for it. Choose another Secret, or ask an administrator for Secret operate on it.`;

// The console's text for a read that failed with a 5xx.
export const READ_UNAVAILABLE = "Service unavailable. The read could not be completed. Try again.";

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
// Where the console says to add a Secret binding that a channel refusal asks for: the Agent
// page's Configuration JSON editor saves none (finding 2494), and Create Agent binds only Slack's
// standard names (finding 2506).
export const CHANNEL_BINDING_CONSOLE_REMEDY =
  "This editor does not save Secret bindings: bind SLACK_APP_TOKEN and SLACK_BOT_TOKEN on the Credentials tab or in the Slack editor on the Channels tab, and other names through the Configuration API.";
export const CHANNEL_BINDING_FORM_REMEDY =
  "On this form, the Slack channel settings bind SLACK_APP_TOKEN and SLACK_BOT_TOKEN to the Secrets you select there; bind other names through the Configuration API after the Agent exists.";
