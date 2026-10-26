import type {
  Agent,
  AgentCallerPermissionsResponse,
  AgentDeploymentStatusWire,
  Namespace,
} from "@openclaw-enterprise/contracts";
import type { Static } from "typebox";
import { GENERIC_DENIAL, namedDenial, requestFailure, responseFields } from "../api-client.mjs";
import { element } from "../dom.mjs";
import type { createNavigation } from "../navigation.mjs";
import {
  ASK_INSTALLATION_ADMINISTRATOR,
  askAdministratorTo,
  askForGrant,
  notIncluded,
} from "./access-reasons.mjs";

export const displayDate = (value: string) => new Date(value).toLocaleString();
export const shortId = (value: string) => `${value.slice(0, 12)}…${value.slice(-6)}`;
export const namespacePath = (id: string) => `/namespaces/${encodeURIComponent(id)}`;

export type AgentNavigation = Pick<ReturnType<typeof createNavigation>, "navigate" | "pageUrl">;

export function link(label: string, target: string, context: AgentNavigation) {
  const node = element("a", { href: context.pageUrl(target) }, label);
  node.addEventListener("click", (event) => {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    context.navigate(target);
  });
  return node;
}

// A Namespace that is still provisioning (or failed to) refuses Agent, Configuration and
// deployment writes with NAMESPACE_NOT_READY; "conflicts with the saved state" would send the
// operator to the wrong place.
// Every view that meets NAMESPACE_NOT_READY shows this one sentence (finding 2538).
export const NAMESPACE_NOT_READY_MESSAGE =
  "This Namespace is not ready yet. Check its status on the Namespaces page: a provisioning Namespace becomes ready when its Kubernetes setup completes. If it stays provisioning, ask an operator to finish that setup.";

// Why a Namespace can't take new Agents, by status. Neither becomes ready by waiting.
const NOT_READY_REASONS: Partial<Record<Namespace["status"], string>> = {
  failed:
    "Provisioning this Namespace failed, so it cannot hold new Agents. Ask an operator to check it on the Namespaces page, or choose another Namespace.",
  deleting:
    "This Namespace is being deleted, so it cannot hold new Agents. Choose another Namespace.",
};

// How often an open Create Agent form, or the Agents list, rereads a provisioning Namespace while
// its note is shown: the runtime status poll's cadence (findings 2012, 2058).
export const NAMESPACE_RECHECK_MS = 10_000;

// What the selected Namespace's status means where Agent creation starts (finding 1895): null
// when it is ready or its status is unknown, otherwise the status and its consequence, and
// whether the API refuses every new Agent there (`blocked`). A provisioning Namespace still
// accepts Agent drafts, but no Secret, sign-in or deployment until it is ready; one that adopts
// an existing Kubernetes namespace takes no Configuration until then; a failed or deleting one
// takes no new Agent. The API still decides.
export function namespaceCreation(
  namespace: Pick<Namespace, "status" | "existingNamespace"> | null | undefined,
): { blocked: boolean; note: string; missing?: true } | null {
  const status = namespace?.status;
  if (typeof status !== "string" || !status || status === "ready") {
    return null;
  }
  const label = `Namespace status: ${status.charAt(0).toUpperCase()}${status.slice(1)}.`;
  if (status === "provisioning" && namespace.existingNamespace === undefined) {
    return {
      blocked: false,
      note: `${label} ${NAMESPACE_NOT_READY_MESSAGE} Until then, Agents can be saved as drafts that need no new Secret or sign-in, but none can be deployed.`,
    };
  }
  return {
    blocked: Object.hasOwn(NOT_READY_REASONS, status) || status === "provisioning",
    note: `${label} ${NOT_READY_REASONS[status] ?? NAMESPACE_NOT_READY_MESSAGE}`,
  };
}

// A complete Namespace list read without the selected Namespace: it was deleted, or the reader
// lost access. Waiting changes nothing, so the reader chooses another one.
export const NAMESPACE_MISSING = Object.freeze({
  blocked: true,
  missing: true,
  note: "This Namespace is missing or you no longer have access. Choose another Namespace.",
});

// The API's catch-all answers: a caller's own denial that names no grant (api-client.mts) and an
// untyped conflict. They name nothing the caller can act on, so views keep their own guidance
// instead of showing them.
export { GENERIC_DENIAL };
export const GENERIC_CONFLICT = "The requested platform resource already exists.";

// Granting an Agent a credential writes Namespace IAM policy, which only Installation
// administration may do (UX plan A2); credentials.mts words its grant steps with this.
// TODO: when #3686 lands, word those steps with askAdministratorTo (access-reasons.mts) and
// remove this, so one module words every ask (finding 2578).
export const askInstallationAdministrator = (task: string) =>
  `needs Installation administration access: ask an Installation administrator to ${task}.`;

// The grant a read needs, so its 403 names it as Stop, Delete and occ's hints do (finding 1530):
// `task` says what the request does and `grant` names the one permission it checks, in the
// permissions cheat sheet's words. It wins over the API's named denial (finding 2534), which
// shows a raw ID where this names the task. The text depends only on the request, never on
// whether the resource exists.
export interface AccessNeed {
  readonly task: string;
  readonly grant: string;
}

// Namespace lists (Secrets, Presets, ServiceAccounts) check Namespace read, then read on each item:
// a 403 is the Namespace read, and an item the caller may not read is left out instead.
export const namespaceListNeed = (items: string): AccessNeed => ({
  task: `listing ${items} in this Namespace`,
  grant: "Namespace read",
});

// The Stop and Delete pages reread the Agent for its status, which authorizes Agent read.
export const AGENT_STATUS_READ_NEED: AccessNeed = {
  task: "reading this Agent's status",
  grant: "Agent read on it",
};

// A 403 that names no grant. message() adds who grants access; administratorMessage() does not.
const PLAIN_ACCESS_DENIED = "Access denied. You do not have permission for this operation.";

// The API records these deployment endings as failed, but nothing went wrong with the version,
// so the console shows a neutral outcome instead. A newer version took over before this one
// became current (finding 1353; the record never names the newer version, so neither does the
// console), or the owner stopped the Agent while this version was deploying (finding 1375).
// REPOSITORY_REVISION_STOPPED stays a failure: it can also mean the Namespace is not ready.
const NEUTRAL_DEPLOYMENT_OUTCOMES = new Map<string, "stopped" | "superseded">([
  ["REVISION_SUPERSEDED", "superseded"],
  ["REPOSITORY_REVISION_SUPERSEDED", "superseded"],
  ["REVISION_STOPPED", "stopped"],
]);

// "superseded" or "stopped" for a neutral ending, otherwise null. Takes a deployment record or a
// Versions list item's status and error code in the record's shape (finding 2422).
export function neutralDeploymentOutcome(
  status:
    | {
        readonly status: AgentDeploymentStatusWire["status"];
        readonly error: { readonly code: string } | null;
      }
    | null
    | undefined,
) {
  return status?.status === "failed" && status.error
    ? (NEUTRAL_DEPLOYMENT_OUTCOMES.get(status.error.code) ?? null)
    : null;
}

// The recorded outcome to show: the API's status, except that a neutral ending is not a failure.
export function deploymentOutcome(status: AgentDeploymentStatusWire) {
  return neutralDeploymentOutcome(status) ?? status.status;
}

// One word per recorded outcome wherever the console shows one: the Agents list, the Agent's
// overview and its deployment records (finding 2093).
const DEPLOYMENT_OUTCOME_LABELS = {
  queued: "Queued",
  running: "In progress",
  succeeded: "Completed",
  failed: "Failed",
  superseded: "Superseded",
  stopped: "Stopped",
};

// The label for a recorded outcome (deploymentOutcome's value).
export function outcomeLabel(outcome: ReturnType<typeof deploymentOutcome>) {
  return DEPLOYMENT_OUTCOME_LABELS[outcome] ?? outcome;
}

export const NEUTRAL_DEPLOYMENT_NOTES = {
  superseded: "Superseded by a newer version",
  stopped: "Stopped before it finished",
};

// message() for a caller known to administer the Installation: its own 403 is not one that asking
// an Installation administrator can fix, so the denial names nobody (finding 2113).
export function administratorMessage(cause: unknown): string {
  const error = responseFields(cause);
  return error.status === 403 && typeof error.refusal !== "string"
    ? PLAIN_ACCESS_DENIED
    : message(cause);
}

export function message(cause: unknown, mutation = false, need?: AccessNeed): string {
  const error = responseFields(cause);
  if (error.code === "SAVED_CONFIGURATION_UNREADABLE") {
    const fieldLabels: Record<string, string> = {
      plugins: "plugin selections",
      pluginApprovers: "plugin approvers",
      repositoryBindings: "repository access",
      harnessAuth: "harness authentication",
      secretBindings: "Secret bindings",
      repositoryCredentials: "repository credentials",
      configuration: "native configuration",
    };
    const field = typeof error.field === "string" ? fieldLabels[error.field] : undefined;
    return `Saved ${field ?? "configuration"} could not be read. Editing and deployment are unavailable for these settings. ${askAdministratorTo("repair the saved configuration, then refresh this page")}`;
  }
  if (error.status === 403) {
    // A view's own refusal or grant names the task in its words; without one, the API's named
    // denial (finding 2534) says which grant is missing, and an older API's generic one nothing.
    return typeof error.refusal === "string"
      ? error.refusal
      : need
        ? notIncluded(need.task, need.grant)
        : (namedDenial(cause) ??
          `${PLAIN_ACCESS_DENIED} ${askAdministratorTo("check your access")}`);
  }
  if (error.status === 404) {
    return "Resource unavailable in this Namespace. Check the ID and your access.";
  }
  if (error.status === 409 && error.code === "NAMESPACE_NOT_READY") {
    return NAMESPACE_NOT_READY_MESSAGE;
  }
  if (error.status === 409) {
    return "The request conflicts with the saved state. Check for an existing Agent name or changed Configuration, then refresh.";
  }
  if (error.status === 400) {
    return "Check the entered values and resource IDs, then try again.";
  }
  if (error.status === 429) {
    return "Too many requests. Wait before trying again.";
  }
  return mutation
    ? "Outcome unknown. The result could not be confirmed. Refresh and inspect the saved state before trying again."
    : error.name === "TypeError" || error.name === "TimeoutError"
      ? "Request interrupted. Retry to check current access and saved state."
      : "Service unavailable. The read could not be completed. Try again.";
}

// The 503 codes POST /agents/provision sends only before its own admission, so that request
// stored nothing and queued no job (finding 1635); an earlier attempt with the same request ID
// may have, which is why Retry stays. They are a named dependency outage, whose transaction
// rolled back, and channel credential validation, which runs before the transaction (the API
// throws if it runs inside one). Create Agent shows their reason. A cluster denial of runtime credentials is met
// by the provisioning worker, deploy and the runtime credential routes, not by this request.
// tests/conformance/http-errors.test.mjs classifies every other API error code.
export const PROVISIONING_REFUSAL_CODES = Object.freeze([
  "DEPENDENCY_UNAVAILABLE",
  "CHANNEL_CREDENTIAL_UNAVAILABLE",
]);

// The API's 503 answers that name no reason: the catch-all outage, and a commit whose outcome
// the API itself could not confirm.
const UNNAMED_DEPENDENCY_FAILURES = new Set([
  "A required platform dependency is unavailable.",
  "The operation outcome is unknown. Do not retry automatically; inspect current state before a deliberate new action.",
]);

// The server's own sentence for a 503 that refused the request before admission: one of
// PROVISIONING_REFUSAL_CODES with a named reason. POST /agents/{id}/deploy sends these codes
// only before its revision commits too: channel credential validation runs before its
// transaction, and the only named DEPENDENCY_UNAVAILABLE answers, the Secret and credential
// source driver-ownership refusals, roll it back (finding 1638). Any other 503, including an
// unnamed one, leaves the outcome unknown and returns undefined.
export function preAdmissionRefusal(cause: unknown) {
  const error = requestFailure(cause);
  return error.status === 503 &&
    PROVISIONING_REFUSAL_CODES.some((code) => code === error.code) &&
    error.serverMessage !== undefined &&
    !UNNAMED_DEPENDENCY_FAILURES.has(error.serverMessage)
    ? error.serverMessage
    : undefined;
}

// A refused save names the grants it needs, as Stop, Delete and occ do (finding 1530). Each save
// shows one fixed text for every 403, so it says nothing the server did not: no IDs, and nothing
// about whether a resource exists.
export const SAVE_REFUSALS = Object.freeze({
  configuration: `You do not have permission to save this Configuration. ${askForGrant(
    "Configuration update on it, plus Secret operate on each Secret it binds",
  )}`,
  agent: `You do not have permission to save this Agent. ${askForGrant(
    "Agent update and Configuration read on it, plus access to the Secrets, credential sources and Service Account it binds",
  )}`,
  // A save first rereads the Agent and its Configuration; a refused read is not a refused
  // update (finding 1540).
  read: `You do not have permission to read this Agent's saved settings. ${askForGrant(
    "Agent read and Configuration read on it",
  )}`,
});

// A refused save that binds Secrets a permission answer read after the refusal says the caller
// may not operate: it names them and that grant, not the Configuration update the caller may
// have (finding 2453). The names are the caller's own choices, read from the Secret list.
export function secretOperateRefusal(names: readonly string[]) {
  const them = names.length > 1 ? "them" : "it";
  const listed =
    names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `You do not have permission to bind ${listed}. Each save needs Secret operate on every Secret it binds, which your access does not include for ${them}. Choose another Secret, or ${ASK_INSTALLATION_ADMINISTRATOR} for Secret operate on ${them}.`;
}

// Shown beside Agent-side save controls when the caller's permission answer denies Agent update.
// Gating only: an unknown answer keeps the controls, and the API still decides.
export const AGENT_UPDATE_DENIED = notIncluded(
  "saving these settings",
  "Agent update on this Agent",
);
// Shown instead when the answer allows Agent update but not the Configuration read each Agent
// update needs; the source note would name the wrong grant.
export const AGENT_CONFIGURATION_READ_DENIED = `Saving these settings needs read access to this Agent's Configuration, which your access does not include. ${askForGrant("Configuration read on it")}`;
// Shown instead when the answer allows Agent update but not the source grants each Agent update
// also checks on what the Agent and its Configuration bind (finding 2441).
export const AGENT_SOURCES_DENIED = `Saving these settings needs operate on each Secret and credential source this Agent and its Configuration bind, which your access does not include. ${askForGrant("that access")}`;
// Shown instead when the Agent uses a ServiceAccount for Harness authentication: each Agent update
// also checks read on it, and the answer does not say which of the grants is missing (finding
// 2459).
export const AGENT_SOURCES_SERVICE_ACCOUNT_DENIED = `Saving these settings needs operate on each Secret and credential source this Agent and its Configuration bind, and read on the ServiceAccount it uses for Harness authentication. Your access does not include all of them. ${askForGrant("that access")}`;

// Why the permission answer says an Agent-side save would be refused, or undefined when it allows
// the save or is unknown. Each Agent update also needs Configuration read and checks the caller's
// grant on every source the Agent and its Configuration bind (finding 2441).
export function agentSaveDenial(
  permissions: Static<typeof AgentCallerPermissionsResponse>["data"] | null | undefined,
  agent?: Partial<Pick<Agent, "harnessAuth">>,
): string | undefined {
  if (permissions?.update === false) {
    return AGENT_UPDATE_DENIED;
  }
  if (permissions?.configurationRead === false) {
    return AGENT_CONFIGURATION_READ_DENIED;
  }
  if (permissions?.agentSourcesOperate !== false) {
    return undefined;
  }
  const harnessAuth = agent?.harnessAuth;
  return harnessAuth?.method === "codex_pat" && harnessAuth.source.kind === "service_account"
    ? AGENT_SOURCES_SERVICE_ACCOUNT_DENIED
    : AGENT_SOURCES_DENIED;
}

// Marks a 403 from a save so message() names the grants it needs: the save's own when the
// write itself was refused (`written`), read access when a read before it was (finding 1540).
// A refused write that a fresh Secret answer explains says so instead (`named`, finding 2453).
export function refusedSave<Cause>(
  cause: Cause,
  save: "configuration" | "agent",
  written: boolean,
  named?: string,
) {
  const error = responseFields(cause);
  if (error.status === 403) {
    error.refusal = written ? (named ?? SAVE_REFUSALS[save]) : SAVE_REFUSALS.read;
  }
  return cause;
}

// The API refused a Configuration update because another save moved its generation, which a
// reread recovers from. Other Configuration conflicts, such as a provisioning reservation, carry
// no such detail and a reread meets them again (finding 1511).
export function isStaleGeneration(cause: unknown) {
  const error = responseFields(cause);
  return (
    error.status === 409 &&
    error.code === "RESOURCE_CONFLICT" &&
    Array.isArray(error.detailPaths) &&
    error.detailPaths.includes("/expectedGeneration")
  );
}

// For a refused Configuration write, show the reason the API gave this caller (for
// example, reserved for provisioning). Never infer that a reload will fix it from the prose.
// The catch-all conflict names nothing (a Kubernetes resourceVersion conflict answers it), so
// the caller's own conflict text applies instead (finding 1639).
export function configurationConflictMessage(cause: unknown, submitted: boolean) {
  const error = requestFailure(cause);
  if (
    submitted &&
    error.status === 409 &&
    error.code === "RESOURCE_CONFLICT" &&
    error.serverMessage !== GENERIC_CONFLICT
  ) {
    return error.serverMessage ?? "The Configuration could not be saved in its current state.";
  }
}

// A rejected write shows the API's own sentence, which names the field to fix (for example
// an inline model credential); other failures keep the generic status text.
export function rejectionMessage(cause: unknown, mutation = false): string {
  const error = requestFailure(cause);
  return error.status === 400 && error.serverMessage !== undefined
    ? error.serverMessage
    : message(cause, mutation);
}

// The API's answer to a request that does not match its schema. It names a JSON path, which
// helps where the reader typed the value, but the console sent everything else itself.
const CONTRACT_MISMATCH = "The request does not match the operation contract";

// When to try again after the API's Retry-After: seconds up to two minutes, then whole minutes.
export function retryAfterText(seconds: number) {
  if (seconds < 120) {
    return `Try again in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`;
  }
  return `Try again in about ${Math.ceil(seconds / 60)} minutes.`;
}

// How long a rate-limited reader waits: the API's Retry-After when it sent one.
function tooManyRequests(cause: unknown) {
  const seconds = requestFailure(cause).retryAfterSeconds;
  return `Too many requests. ${seconds === undefined ? "Wait before trying again." : retryAfterText(seconds)}`;
}

// The API's sentence for a 409 that explains itself, or undefined for a conflict it does not
// explain (no message, or the generic "already exists" text), where the view says its own.
export function explainedConflict(cause: unknown): string | undefined {
  const { status, serverMessage } = requestFailure(cause);
  return status === 409 && serverMessage !== undefined && serverMessage !== GENERIC_CONFLICT
    ? serverMessage
    : undefined;
}

// One description of a failed request for the views that once showed a bare message()
// (finding 2538). The API's 400 and typed 409 sentences name the rule or the state that
// refused the request, and the API never puts a secret value in one, so they show as written
// (views set them as textContent). `next` follows a 409: the step that recovers in this view,
// such as a refresh ("" when the view adds its own); `conflict` replaces the generic sentence
// for a 409 the API does not explain.
// `form` says the reader entered the values sent, so a 400 the API does not explain asks to check
// them; without a form it never mentions entered values. Denials, missing resources and
// unanswered requests keep message()'s text.
export function describeFailure(
  cause: unknown,
  {
    mutation = false,
    form = false,
    next,
    conflict = "The request conflicts with the current state.",
    need,
  }: {
    mutation?: boolean;
    form?: boolean;
    next?: string;
    conflict?: string;
    need?: AccessNeed;
  } = {},
): string {
  const error = requestFailure(cause);
  const then = next ? ` ${next}` : "";
  if (error.status === 400) {
    if (
      error.serverMessage !== undefined &&
      (form || !error.serverMessage.startsWith(CONTRACT_MISMATCH))
    ) {
      return error.serverMessage;
    }
    return form
      ? message(cause, mutation)
      : "The API refused this request as malformed. Refresh the page and try again.";
  }
  if (error.status === 409) {
    if (error.code === "NAMESPACE_NOT_READY") {
      return NAMESPACE_NOT_READY_MESSAGE;
    }
    const explained = explainedConflict(cause);
    return explained !== undefined
      ? `${explained}${then}`
      : `${conflict}${next === undefined ? " Refresh, then try again." : then}`;
  }
  if (error.status === 429) {
    return tooManyRequests(cause);
  }
  return message(cause, mutation, need);
}

// An outage names who acts if it continues, as sign-in's 503 does.
const READ_OUTAGE =
  "The service did not answer. Try again; if it continues, ask an operator to check the API.";

// Why a read failed and what to do next, by status, for the views whose catch once said
// "unavailable, retry" for a denial and an outage alike (finding 2538): a 403 names the grant
// (`need`) and who grants it, a 429 how long to wait, and an outage who to ask if it continues.
export function readFailureReason(cause: unknown, need?: AccessNeed): string {
  const error = requestFailure(cause);
  if (error.status === 403) {
    return message(cause, false, need);
  }
  if (error.status === 404) {
    return "It is no longer available. Refresh the page.";
  }
  if (error.status === 400 || error.status === 409 || error.status === 429) {
    return describeFailure(cause);
  }
  const { name } = responseFields(cause);
  return name === "TypeError" || name === "TimeoutError"
    ? "The request was interrupted. Try again."
    : READ_OUTAGE;
}

/** "<subject> could not be read. <reason>" for a failed read (readFailureReason). */
export const readFailure = (subject: string, cause: unknown, need?: AccessNeed) =>
  `${subject} could not be read. ${readFailureReason(cause, need)}`;

// A channel credential value that Configuration save or provisioning refuses: a reference without
// a Secret binding, a `${` the runtime does not substitute, or a value the setting "holds" that is
// not one whole reference or a SecretRef it accepts, an inline credential included (findings 2319,
// 2477, 2493, 2517); otherwise undefined. The message names the setting, so a form shows it under
// the field that holds the Configuration.
const CHANNEL_REFERENCE_REFUSAL =
  / (?:without a Configuration Secret binding|the runtime does not substitute): | holds /;
export function channelBindingRefusal(cause: unknown): string | undefined {
  const { status, serverMessage } = requestFailure(cause);
  return status === 400 &&
    serverMessage?.startsWith("Configuration setting channels.") &&
    CHANNEL_REFERENCE_REFUSAL.test(serverMessage)
    ? serverMessage
    : undefined;
}

export function assertReadableConfiguration(resource: unknown) {
  const { configurationReadError } = responseFields(resource);
  if (configurationReadError) {
    throw Object.assign(new Error(message(configurationReadError)), configurationReadError);
  }
}

// A run of more characters than any ordinary word cannot wrap, so it would set the table's width
// (finding 1955). Only a name with one breaks anywhere (console.css); others wrap as before. The
// rule follows the break points Chromium was measured to use (finding 1982), not all of UAX #14.
// A run ends where a line can break: after a breaking space, a zero-width space, a soft hyphen,
// or a hyphen or dash (a name holds no control or line-separator characters). No-break spaces
// (U+00A0, U+2007, U+202F, U+FEFF), which `\s` counts, do not end it. A hyphen-minus between
// ASCII digits does break ("1000-1001"). Combining marks count with the letter they sit on. Ideographs, kana,
// Hangul syllables and most emoji break on both sides; other scripts (Thai, for one) count per
// character, which can only over-mark: a marked name still shows in full, in a narrower box.
const WIDE_SPACES = String.raw`\u1680\u2000-\u2006\u2008-\u200a\u205f\u3000`;
const DASHES = String.raw`\u00ad\u2010\u2012\u2013`; // soft hyphen, hyphen, figure and en dash
const CLOSING = String.raw`!),./:;\]}\u00bb\u2019\u201d\u2060\u200d`; // and joiners (ZWJ last: lint)
// Opening quotes, the infix separators U+037E, U+0589, U+060C and U+2044, and the no-break U+FEFF:
// Chromium keeps them after a hyphen, dash or wide space too (finding 2001).
const OPENING = String.raw`\u00ab\u037e\u0589\u060c\u2018\u201c\u2039\u203a\u2044\ufeff`;
const IDEOGRAPHIC = String.raw`\p{Ideographic}\u3041-\u3096\u30a1-\u30fa\uac00-\ud7a3\p{Emoji_Presentation}`;
// Emoji whose line-break class is AL, unlike the rest: Chromium keeps them with their neighbours,
// as it does letters (finding 2001).
const LETTER_EMOJI = String.raw`\u23e9-\u23ec\u25fd\u25fe\u2648-\u2653\u2693\u26a1\u26aa\u26ab\u26ce\u2705\u2728\u274c\u274e\u2753-\u2755\u2757\u2795-\u2797\u27b0\u27bf\u2b1b\u2b1c\u2b50\u2b55\u{1f18e}\u{1f191}-\u{1f19a}\u{1f3b5}\u{1f3b6}\u{1f3bc}\u{1f4a0}\u{1f4a2}\u{1f4a4}\u{1f4af}\u{1f4b1}\u{1f4b2}\u{1f500}-\u{1f506}\u{1f517}-\u{1f524}\u{1f532}-\u{1f53d}`;
export const UNBROKEN_ALTERNATIVES = [
  String.raw`[^ ${WIDE_SPACES}\u200b${DASHES}\u2014\p{M}${IDEOGRAPHIC}-]`,
  String.raw`[${LETTER_EMOJI}]`,
  // Where a break character holds the next one on its line:
  // - a hyphen-minus before closing punctuation, an opening quote, "$", or a hyphen, figure dash
  //   or en dash;
  String.raw`-(?=\p{M}*[$\u2010\u2012\u2013${OPENING}${CLOSING}])`,
  // - a hyphen-minus before a digit, unless the digit is fullwidth, or ASCII after an ASCII letter
  //   or digit: "1000-1001" and "a-1" break; "x -5", an accented letter before "-1", and "a-"
  //   before a Devanagari digit do not (finding 2000). A mark on the hyphen holds an ASCII digit too;
  String.raw`(?<![A-Za-z0-9])-(?=\p{M}*\p{Nd})(?!\p{M}*[\uff10-\uff19])`,
  String.raw`(?<=[A-Za-z0-9])-(?=\p{M}*\p{Nd})(?![0-9]|\p{M}*[\uff10-\uff19])`,
  // - a wide space, soft hyphen or dash before closing punctuation, an opening quote, a quote or a
  //   vertical bar;
  String.raw`[${WIDE_SPACES}${DASHES}](?=\p{M}*["'|${OPENING}${CLOSING}])`,
  // - a hyphen or dash (an em dash too) before any of them but an em dash (LB21);
  String.raw`[\u2010\u2012-\u2014](?=[\u2010\u2012\u2013-])`,
  // - a hyphen, figure dash or en dash that starts a word, before a letter (LB20a); a no-break
  //   space or non-breaking hyphen before it starts a word too;
  String.raw`(?<=^|[ \u00a0\u200b\u2007\u2011\u202f])[\u2010\u2012\u2013](?=\p{L})`,
  // - an ideograph or emoji before a word joiner or zero-width joiner (LB11, LB9). The other
  //   characters a joiner holds already count: ordinary ones always, and a hyphen, dash or wide
  //   space because CLOSING lists the joiners. What follows a joiner keeps its own rules.
  // No character may match two of these, nor a combining mark start one: each overlap doubles the
  // ways to split a run, so a failed match on a joiner-run name backtracked for seconds (finding
  // 1999). One ideograph is a combining mark (U+16FE4), and letter emoji have their own line, so
  // the last line skips both. tests/conformance/console-agent-name-runs.test.mjs checks it.
  String.raw`(?![\p{M}${LETTER_EMOJI}])[${IDEOGRAPHIC}](?=\p{M}*[\u2060\u200d])`,
];
const UNBROKEN_CHARACTER = UNBROKEN_ALTERNATIVES.join("|");
const RUN_CHARACTER = String.raw`(?:${UNBROKEN_CHARACTER})\p{M}*`;
// A run of em dashes breaks only at its ends (LB17), so it is a run of its own (finding 1971).
// The wide space, hyphen or dash a line breaks after stays on that line, so it counts too.
// Exported for tests/conformance/console-agent-name-runs.test.mjs, which checks its shape.
export const UNBROKEN_RUN = new RegExp(
  String.raw`\u2014{21,}|(?:${RUN_CHARACTER}){21,}|(?:${RUN_CHARACTER}){20}[${WIDE_SPACES}${DASHES}-]`,
  "u",
);

/** Whether a name holds a run the browser cannot wrap, so it must be marked to break anywhere. */
export const hasUnbrokenRun = (name: string) => UNBROKEN_RUN.test(name);
