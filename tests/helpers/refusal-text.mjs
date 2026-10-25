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
