import type {
  Agent,
  Configuration,
  OpenClawConfigurationDocument,
  SecretBindings,
  SecretMetadata,
  SecretReference,
} from "@openclaw-enterprise/contracts";
import { requestFailure, responseFields } from "../api-client.mjs";
import { sameValue } from "../carry.mjs";
import {
  element,
  button,
  setUnavailable,
  focusSaveOutcome,
  setStatusTone,
  validateFields,
} from "../dom.mjs";
import {
  environmentReferenceNames,
  secretInputShorthandName,
  wholeEnvironmentReferenceName,
} from "../environment-references.mjs";
import {
  askInstallationAdministrator,
  CHANNEL_BINDING_PLACES,
  channelBindingRefusal,
  configurationConflictMessage,
  isStaleGeneration,
  namespacePath,
  SAVE_REFUSALS,
} from "./list.mjs";
import {
  credentialOperateGrants,
  ensureCredentialOperateBinding,
  type AgentAccessContext,
} from "./credential-access.mjs";
import {
  createSecretReferenceField,
  secretBinding,
  secretIdForBinding,
  secretSourceForBinding,
} from "./secret-picker.mjs";

export const SLACK_SECRET_BINDINGS = [
  { key: "SLACK_APP_TOKEN", label: "Slack app token", secretName: "Slack app token" },
  { key: "SLACK_BOT_TOKEN", label: "Slack bot token", secretName: "Slack bot token" },
];
// Why the pickers are not offered when a default-account token reads a key other than its own
// standard name, such as another `${NAME}` or the other token's name (finding 2526). The list may
// hold a standard name too, so the hint never says it does not (finding 2540).
const SLACK_OTHER_KEYS_HINT =
  "The token pickers bind only SLACK_APP_TOKEN for the app token and SLACK_BOT_TOKEN for the bot token. The Slack settings read the keys listed above: bind them through the Configuration API.";
// Beside the pickers, for the other keys the Slack settings read, such as a signing secret's
// (finding 2554).
const SLACK_EXTRA_KEYS_HINT =
  "The Slack settings also read the other keys listed above: bind them through the Configuration API.";
function channelPolicy(values: unknown, provider: string) {
  return responseFields(responseFields(values).channels)[provider];
}

function channelEnabled(values: unknown, provider: string) {
  const policy = channelPolicy(values, provider);
  return (
    policy !== null &&
    typeof policy === "object" &&
    !Array.isArray(policy) &&
    responseFields(policy).enabled !== false
  );
}

// The environment key a Slack token reads, as the Slack Channel Driver reads it: an env
// SecretRef's id, or NAME when the token is exactly one `${NAME}` (finding 2513).
function slackTokenKey(token: unknown) {
  if (typeof token === "string") {
    return wholeEnvironmentReferenceName(token);
  }
  const { source, id } = responseFields(token);
  return source === "env" && typeof id === "string" ? id : undefined;
}

// Slack's secret-input fields, on the channel and on each named account: `SLACK_SECRET_INPUTS` in
// packages/occ/src/channel-secret-bindings.ts, which Configuration save reads.
const SLACK_SECRET_INPUTS: readonly (readonly string[])[] = [
  ["appToken"],
  ["botToken"],
  ["signingSecret"],
  ["userToken"],
  ["relay", "authToken"],
];
const sameKeys = (left: readonly (string | number)[], right: readonly string[]) =>
  left.length === right.length && right.every((key, index) => left[index] === key);
const isSlackSecretInput = (keys: readonly (string | number)[]) =>
  SLACK_SECRET_INPUTS.some(
    (field) =>
      sameKeys(keys, field) ||
      (keys[0] === "accounts" && typeof keys[1] === "string" && sameKeys(keys.slice(2), field)),
  );

// Each environment name in the Slack settings that Configuration save requires a binding for, as
// `requireChannelSecretBindings` reads it: an env SecretRef's id anywhere, each `${NAME}` without
// a fallback, and in a secret-input field also `${NAME:-text}` and `$NAME`. That covers the
// tokens and named accounts' keys, and the signing secret, user token and relay token, which a
// save refuses unbound too (finding 2554).
function slackSettingReferences(
  value: unknown,
  keys: readonly (string | number)[] = [],
  names = new Set<string>(),
) {
  if (typeof value === "string") {
    const secretInput = isSlackSecretInput(keys);
    const shorthand = secretInput ? secretInputShorthandName(value) : undefined;
    for (const name of [
      ...environmentReferenceNames(value, { fallbacks: secretInput }),
      ...(shorthand === undefined ? [] : [shorthand]),
    ]) {
      names.add(name);
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => slackSettingReferences(item, [...keys, index], names));
  } else if (value !== null && typeof value === "object") {
    const record = responseFields(value);
    if (record.source === "env" && typeof record.id === "string" && record.id.length > 0) {
      names.add(record.id);
    }
    for (const [key, item] of Object.entries(record)) {
      slackSettingReferences(item, [...keys, key], names);
    }
  }
  return names;
}

// The keys the default account's tokens read, as the Slack Channel Driver reads them, with the
// token that reads each: each token's own key; the standard name for a token that names none
// (absent, or a form save refuses, which a save from this tab then reports); and no app token in
// HTTP mode unless one is referenced (finding 2526). HTTP mode never reads the app token, but save
// still needs a binding for each name it references, `$NAME` and `${NAME:-text}` included, so
// those count too (finding 2541).
type SlackTokenRole = "appToken" | "botToken";
const STANDARD_SLACK_KEYS: Readonly<Record<SlackTokenRole, string>> = {
  appToken: "SLACK_APP_TOKEN",
  botToken: "SLACK_BOT_TOKEN",
};
function defaultSlackAccountReads(slack: Record<string, unknown>) {
  const reads: { role: SlackTokenRole; key: string }[] = [];
  const http = slack.mode === "http";
  for (const role of ["appToken", "botToken"] as const) {
    const token = slack[role];
    const key = slackTokenKey(token);
    if (role === "appToken" && http) {
      const shorthand = typeof token === "string" ? secretInputShorthandName(token) : undefined;
      const names =
        typeof token === "string"
          ? [...environmentReferenceNames(token), ...(shorthand === undefined ? [] : [shorthand])]
          : key === undefined
            ? []
            : [key];
      reads.push(...names.map((name) => ({ role, key: name })));
    } else {
      reads.push({ role, key: key ?? STANDARD_SLACK_KEYS[role] });
    }
  }
  return reads;
}

const usesNamedSlackAccounts = (values: unknown) => {
  const slack = responseFields(channelPolicy(values, "slack"));
  return slack.accounts !== undefined || slack.account !== undefined;
};

// The keys the Credentials tab lists and Deploy waits for: every name save requires a binding
// for, and the standard name a default-account token without a key reads. Named accounts must not
// use the standard keys: OpenClaw reads SLACK_APP_TOKEN and SLACK_BOT_TOKEN as an extra implicit
// default account, so for them only the referenced names count.
function slackBindingKeys(values: unknown) {
  const slack = responseFields(channelPolicy(values, "slack"));
  const tokenKeys = usesNamedSlackAccounts(values)
    ? []
    : defaultSlackAccountReads(slack).map(({ key }) => key);
  return [...new Set([...tokenKeys, ...slackSettingReferences(slack)])].sort();
}

// The standard bindings the Credentials tab's form binds: those the default account's tokens
// read, when each token reads its own standard name, so a picker's label names the token its
// Secret reaches. HTTP mode often reads only SLACK_BOT_TOKEN, which keeps its picker (finding
// 2540); swapped or other names get the list. Null when the tab only lists the keys.
function slackFormBindings(values: unknown) {
  if (usesNamedSlackAccounts(values)) {
    return null;
  }
  const reads = defaultSlackAccountReads(responseFields(channelPolicy(values, "slack")));
  return reads.every(({ role, key }) => key === STANDARD_SLACK_KEYS[role])
    ? SLACK_SECRET_BINDINGS.filter((binding) => reads.some(({ key }) => key === binding.key))
    : null;
}

function servicePrincipalId(agent: Pick<Agent, "servicePrincipalId">) {
  return typeof agent?.servicePrincipalId === "string" && agent.servicePrincipalId.trim().length
    ? agent.servicePrincipalId
    : null;
}

export { secretBinding, secretIdForBinding };

type ChannelBindings = Pick<Configuration, "secretBindings">;

export function channelCredentialBlockReason(values: unknown) {
  return channelEnabled(values, "msteams")
    ? "Microsoft Teams credentials and readiness are operator-managed and cannot be confirmed by this Credentials tab. Use the operator deployment workflow for Teams, or disable Teams through the Configuration API to deploy here."
    : null;
}

export function missingChannelCredentialGroups(values: unknown, configuration: ChannelBindings) {
  if (!channelEnabled(values, "slack")) {
    return [];
  }
  const keys = slackBindingKeys(values);
  const unbound = keys.filter((key) => !secretIdForBinding(configuration?.secretBindings?.[key]));
  if (!unbound.length) {
    return [];
  }
  // The standard pair is what the form binds; other keys are named.
  const form = slackFormBindings(values);
  return form?.length === SLACK_SECRET_BINDINGS.length &&
    unbound.every((key) => form.some((binding) => binding.key === key))
    ? ["Slack Secret bindings"]
    : [`Slack Secret bindings (${unbound.join(", ")})`];
}

export function hasRequiredChannelCredentials(values: unknown, configuration: ChannelBindings) {
  return (
    channelCredentialBlockReason(values) === null &&
    missingChannelCredentialGroups(values, configuration).length === 0
  );
}

type SaveFailure = ReturnType<typeof requestFailure> & {
  step: "configuration" | "preflight" | "grant";
  refusal?: string | undefined;
  retryRead?: "Agent" | "Configuration";
};

// Where to fix a channel setting a channel Secret save was refused for. A refusal that asks only
// for a binding gets where the console binds one instead: the Configuration JSON editor saves no
// bindings (finding 2542).
const CHANNEL_SETTING_REMEDY =
  "Fix that setting in the Configuration JSON on the Configuration tab: this tab saves only the SLACK_APP_TOKEN and SLACK_BOT_TOKEN bindings.";
const channelRefusalRemedy = (refusal: string) =>
  refusal.includes(" without a Configuration Secret binding: ")
    ? `To fix it, ${CHANNEL_BINDING_PLACES}`
    : CHANNEL_SETTING_REMEDY;

function credentialSaveError(error: SaveFailure) {
  let text;
  if (error.status === 403) {
    // A refused Configuration update names the grants it needs (finding 1839), or the chosen
    // Secrets a fresh answer says the caller may not operate (finding 2453).
    text = error.refusal ?? SAVE_REFUSALS.configuration;
  } else if (error.status === 409) {
    text =
      configurationConflictMessage(error, true) ??
      "Credential metadata conflicts with the saved Agent state or selected Secrets.";
  } else if (error.status === 400) {
    // The save resends the stored values, so a channel setting saved before a rule refused its
    // form is refused here too: no Secret choice fixes it (finding 2529).
    const refusal = channelBindingRefusal(error);
    text =
      refusal === undefined
        ? "Check the selected Secrets and reload this Agent."
        : `${refusal} ${channelRefusalRemedy(refusal)}`;
  } else if (error.status === 429) {
    text = "Too many requests. Wait before trying again.";
  } else if (error.status === 404) {
    text = "Credential metadata is unavailable for this Agent. Check the ID and your access.";
  } else {
    text = "Outcome unknown. Reload this Agent to confirm the saved Secret bindings.";
  }
  return text + (error.requestId ? ` Request ID: ${error.requestId}` : "");
}

// Why a saved Slack Secret or authentication source still waits for the Agent's access grant:
// the grant was refused (403), its outcome could not be confirmed, the Namespace's IAM policy
// shows none, or a session known not to administer the Installation sent no grant, so nothing
// verified it (findings 1920, 2259).
export type SecretGrantProblem = "refused" | "unconfirmed" | "missing" | "unverified";

export interface OutstandingSecretGrants {
  secrets: SecretReference[];
  problem: SecretGrantProblem;
}

// The words one grant path's warnings use: what saved, the credential the Agent waits for, what
// a refused grant means, the control an Installation administrator selects to grant it, and the
// retry this page offers.
export interface GrantWarningSubject {
  saved: string;
  credential: string;
  refusal: string;
  access: string;
  bound: string;
  administratorStep: string;
  retry: string;
}

const SLACK_GRANT: GrantWarningSubject = {
  saved: "Configuration",
  credential: "the saved Slack Secret",
  refusal: "this Agent cannot use the saved Slack Secret until it is granted access",
  access: "Secret access grants",
  bound: "a bound Slack Secret",
  administratorStep: "Retry Secret access",
  retry: "Retry Secret access",
};

// Granting an Agent a credential writes Namespace IAM policy, which needs Installation
// administration (UX plan A2): a refused or unverified grant names who finishes it and how. The
// Slack Secret and harness authentication paths share these words (findings 1920, 2259).
const ADMINISTRATOR_STEP = (step: string) =>
  askInstallationAdministrator(`open this Agent's Credentials and select ${step}`);
const GRANT_WARNINGS: Record<SecretGrantProblem, (subject: GrantWarningSubject) => string> = {
  refused: ({ saved, refusal, administratorStep }) =>
    `${saved} saved, but ${refusal}. Granting it ${ADMINISTRATOR_STEP(administratorStep)}`,
  unconfirmed: ({ saved, access, retry }) =>
    `${saved} saved, but ${access} could not be confirmed. Select ${retry}; if it is refused, ask an Installation administrator.`,
  // Only an Installation administrator's console reads a missing grant, so it names the
  // administrator's step (finding 2260).
  missing: ({ bound, administratorStep }) =>
    `This Agent has no access to ${bound}, so deploying it would be refused. Select ${administratorStep} to grant it.`,
  unverified: ({ saved, credential, administratorStep }) =>
    `${saved} saved, but this session did not verify that this Agent can use ${credential}. Granting access ${ADMINISTRATOR_STEP(administratorStep)}`,
};

// A reader this page offers no Retry, such as an administrator whose access ended after the policy
// read or after a grant request failed, is told who grants a missing or unconfirmed grant instead
// of a step they cannot take (finding 2949). Refused and unverified grants already name them.
const NO_RETRY_GRANT_WARNINGS: Partial<
  Record<SecretGrantProblem, (subject: GrantWarningSubject) => string>
> = {
  unconfirmed: ({ saved, access, administratorStep }) =>
    `${saved} saved, but ${access} could not be confirmed. Confirming access ${ADMINISTRATOR_STEP(administratorStep)}`,
  missing: ({ bound, administratorStep }) =>
    `This Agent has no access to ${bound}, so deploying it would be refused. Granting it ${ADMINISTRATOR_STEP(administratorStep)}`,
};

export function grantWarning(
  problem: SecretGrantProblem,
  subject: GrantWarningSubject,
  canRetry = true,
) {
  return ((!canRetry && NO_RETRY_GRANT_WARNINGS[problem]) || GRANT_WARNINGS[problem])(subject);
}

// The harness authentication source's grant. A refusal reports the refused request, not the
// Agent's access, which nothing read. An administrator saves the source again, which grants it;
// their console reads the IAM policy and names that step when the grant is missing (findings
// 2259, 2260).
export function harnessGrantSubject(kind: "secret" | "credential_source"): GrantWarningSubject {
  const noun = kind === "secret" ? "Secret" : "credential source";
  return {
    saved: "Authentication source",
    credential: `the selected ${noun}`,
    refusal: `the request to grant this Agent access to the selected ${noun} was refused`,
    access: `this Agent's ${noun} access`,
    bound: `its authentication ${noun}`,
    administratorStep: "Save authentication source",
    retry: "Retry credential access",
  };
}

// A definite answer to a grant request is a known outcome: 403 is refused (only an Installation
// administrator can grant), and 400/404/409/429 left it ungranted for now. A lost answer, a
// timeout (408) or a 5xx may have granted it, so the outcome stays unknown (finding 1920).
export function grantProblemFor(status: number | undefined): SecretGrantProblem | null {
  if (status === 403) {
    return "refused";
  }
  return status !== undefined && [400, 404, 409, 429].includes(status) ? "unconfirmed" : null;
}

interface SecretDraft {
  secretBindings: SecretBindings;
  changedSecrets: Record<string, SecretMetadata>;
}

export interface CarriedChannelSecrets extends SecretDraft {
  configurationId: string;
  initialSecretBindings: SecretBindings;
}

interface ChannelState {
  agent: Pick<Agent, "name" | "id" | "servicePrincipalId">;
  configuration: Configuration;
  values: OpenClawConfigurationDocument;
  saving: boolean;
  saveError: SaveFailure | null;
  saveMessage: string;
  saveGrantWarning: string;
  pendingSecretGrants: Record<string, SecretReference>;
  grantProblem: SecretGrantProblem;
  outcomeUnknown: boolean;
  reloadRequired: boolean;
  draftSeed: SecretDraft | null;
  unsavedSecrets: boolean;
  carried: CarriedChannelSecrets | null;
  carriedNote: string;
  // An administrator's console is reading the Agent's grants on the bound Secrets.
  checkingGrants: boolean;
}

// The update stores the submitted values unchanged. Its response must confirm the new
// generation and every binding before we grant the Agent access to any selected Secret.
function confirmedConfiguration(
  result: unknown,
  previous: Configuration,
  values: OpenClawConfigurationDocument,
  secretBindings: SecretBindings,
): Configuration {
  const saved = responseFields(result);
  const { generation } = saved;
  if (
    saved.id !== previous.id ||
    saved.namespaceId !== previous.namespaceId ||
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation <= previous.generation ||
    !sameValue(saved.values, values) ||
    !sameValue(saved.secretBindings, secretBindings)
  ) {
    // A successful but unrecognizable response cannot justify another write.
    throw new Error("The save response did not confirm the submitted Secret bindings.");
  }
  return { ...previous, generation, values, secretBindings };
}

// Reapplies the Secret choices a save conflict carried over the reread bindings, when they were
// made on this Configuration. A choice another browser also changed is named (finding 1512).
function applyCarriedSecrets(state: ChannelState, carried: CarriedChannelSecrets | null) {
  if (!carried) {
    return;
  }
  if (carried.configurationId !== state.configuration.id) {
    state.carriedNote =
      "Your channel Secret choices were not reapplied: this Agent now uses another Configuration.";
    return;
  }
  // No Slack token form renders for these, so the note shows in the section instead
  // (finding 1525).
  if (!channelEnabled(state.values, "slack")) {
    state.carriedNote =
      "Your channel Secret choices were not reapplied: Slack is off in the reloaded Configuration.";
    return;
  }
  const form = slackFormBindings(state.values);
  if (form === null) {
    state.carriedNote = usesNamedSlackAccounts(state.values)
      ? "Your channel Secret choices were not reapplied: the reloaded Configuration uses named Slack accounts."
      : "Your channel Secret choices were not reapplied: the reloaded Configuration's Slack tokens use other keys.";
    return;
  }
  const saved = state.configuration.secretBindings ?? {};
  const secretBindings = { ...saved };
  const changedSecrets: SecretDraft["changedSecrets"] = {};
  const names: string[] = [];
  for (const { key, label } of form) {
    const choice = carried.secretBindings[key];
    const secret = carried.changedSecrets[key];
    const initial = secretIdForBinding(carried.initialSecretBindings[key]);
    const current = secretIdForBinding(saved[key]);
    const selected = secretIdForBinding(choice);
    if (
      secret &&
      choice &&
      selected === secret.id &&
      selected !== initial &&
      selected !== current
    ) {
      secretBindings[key] = choice;
      changedSecrets[key] = secret;
      names.push(current === initial ? label : `${label} (also changed in another browser)`);
    }
  }
  if (!names.length) {
    state.carriedNote = "The reloaded bindings already include your Secret choices.";
    return;
  }
  state.draftSeed = { secretBindings, changedSecrets };
  state.carriedNote = `Your Secret choices are applied over the reloaded bindings: ${names.join(", ")}. Review them, then save.`;
}

// The Configuration's bound Secrets. Deploy checks that the Agent may operate each of them,
// whether or not a Slack setting reads it (`apps/controller/src/worker.ts`), so grant checks,
// outstanding grants and Retry Secret access cover them all (finding 2558).
function boundSecrets(secretBindings: SecretBindings | undefined) {
  const secrets = new Map<string, SecretReference>();
  for (const binding of Object.values(secretBindings ?? {})) {
    const secret = secretSourceForBinding(binding);
    if (secret !== null) {
      secrets.set(secret.id, secret);
    }
  }
  return [...secrets.values()];
}

// The rows the tab shows: the pickers' tokens, the other keys the Slack settings read, then each
// other bound key, such as SLACK_APP_TOKEN left bound after a switch to HTTP mode. Deploy checks
// those Secrets' grants too, so their warning and Retry need a row (finding 2558).
function slackBindingRows(state: ChannelState) {
  const form = slackFormBindings(state.values) ?? [];
  const listed = slackBindingKeys(state.values)
    .filter((key) => !form.some((binding) => binding.key === key))
    .map((key) => ({ key, label: key, unused: false }));
  const shown = new Set([...form, ...listed].map(({ key }) => key));
  const unused = Object.keys(state.configuration.secretBindings ?? {})
    .filter(
      (key) =>
        !shown.has(key) && secretIdForBinding(state.configuration.secretBindings?.[key]) !== null,
    )
    .sort()
    .map((key) => ({ key, label: key, unused: true }));
  return [...form.map((binding) => ({ ...binding, unused: false })), ...listed, ...unused];
}

function renderSlackBindings(state: ChannelState) {
  const list = element("dl", { className: "credential-status-list" });
  for (const binding of slackBindingRows(state)) {
    const id = secretIdForBinding(state.configuration.secretBindings?.[binding.key]);
    // A bound Secret the Agent may not use yet is not plainly Bound (finding 1920).
    const ungranted = id !== null && id in state.pendingSecretGrants;
    const bound = binding.unused ? "Bound · not read by the Slack settings" : "Bound";
    list.append(
      element("dt", {}, binding.label),
      element(
        "dd",
        {},
        element(
          "span",
          {
            className: "badge",
            "data-tone": id === null ? "danger" : ungranted ? "warning" : "success",
          },
          id === null ? "Missing" : ungranted ? `${bound} · Agent access not confirmed` : bound,
        ),
      ),
    );
  }
  return list;
}

// The deploy status while a grant read runs; the page shows it only after 250 ms (finding 2576).
export const CHECKING_CREDENTIAL_ACCESS =
  "Checking this Agent's credential access before deploying.";
// The next step a channel Secret save names once the Agent's access to them is confirmed.
const DELIVER_ON_DEPLOY = " Deploy the new version to deliver them.";

// Why the channel Secrets are read-only: the caller may not update the Configuration, or may not
// operate a Secret that a save keeps bound, which each Configuration save also needs (finding
// 2437). A save is checked on the Secrets it submits, not on those it replaces (finding 2444).
export const CHANNEL_SECRETS_CONFIGURATION_READ_ONLY =
  "Your access does not include editing this Configuration, so its channel Secrets are read-only.";
export const CHANNEL_SECRETS_OPERATE_READ_ONLY =
  "Saving channel Secrets needs Secret operate on each Secret the saved Configuration keeps bound, which your access does not include.";

const bindingNames = (keys: readonly string[]) =>
  keys.map((key) => SLACK_SECRET_BINDINGS.find((binding) => binding.key === key)?.label ?? key);
const listed = (names: readonly string[]) =>
  names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * The binding names a channel save must replace, from the permission answer: each bound Secret
 * the caller may not operate sits under a Slack token name, which channel saves replace (finding
 * 2444). Null when the answer allows every save, denies Configuration update, does not list the
 * names, or lists one that channel saves keep, so the usual rule applies.
 */
export function channelBindingsToReplace(
  permissions:
    | {
        configurationUpdate?: boolean;
        configurationSecretsOperate?: boolean;
        configurationSecretsOperateDeniedBindings?: readonly string[];
      }
    | null
    | undefined,
): readonly string[] | null {
  const denied = permissions?.configurationSecretsOperateDeniedBindings;
  return permissions?.configurationUpdate === true &&
    permissions.configurationSecretsOperate === false &&
    Array.isArray(denied) &&
    denied.length > 0 &&
    denied.every((key) => SLACK_SECRET_BINDINGS.some((binding) => binding.key === key))
    ? denied
    : null;
}

/** Why channel saves are read-only when a bound Secret the caller may not operate stays bound. */
export function channelSecretsOperateReadOnly(
  denied: readonly string[] | undefined,
  unlisted = CHANNEL_SECRETS_OPERATE_READ_ONLY,
) {
  const kept = (denied ?? []).filter(
    (key) => !SLACK_SECRET_BINDINGS.some((binding) => binding.key === key),
  );
  return kept.length
    ? `Each Configuration save needs Secret operate on every Secret it keeps bound. Your access does not include it for ${listed(kept)}, which channel saves keep.`
    : unlisted;
}

/** What a channel editor says while a bound Secret it must replace is still bound. */
export function channelReplaceHint(keys: readonly string[]) {
  const names = listed(bindingNames(keys));
  return `Your access does not include Secret operate on the Secret bound to ${names}. Each save needs it for every Secret it keeps bound, so choose another Secret for ${keys.length > 1 ? "them" : "it"} before saving.`;
}

/**
 * Refuses, before any request, a channel save that keeps a listed binding on the Secret it binds
 * now: the API would answer 403 (finding 2444). A save that submits no bindings keeps them all.
 */
export function channelReplaceRefusal(
  keys: readonly string[] | null,
  saved: SecretBindings | undefined,
  submitted: SecretBindings | undefined,
) {
  const kept = keptReplaceBindings(keys, saved, submitted);
  return kept.length
    ? `This save keeps ${listed(bindingNames(kept))} on a Secret your access cannot operate. Choose another Secret for ${kept.length > 1 ? "them" : "it"}, then save.`
    : null;
}

/**
 * Why Disable is offered disabled: it saves no bindings, so it keeps each listed binding on the
 * Secret it binds now and the API would answer 403 (finding 2471). Edit Slack rebinds them first.
 */
export function channelDisableRefusal(
  keys: readonly string[] | null,
  saved: SecretBindings | undefined,
) {
  const kept = keptReplaceBindings(keys, saved, undefined);
  return kept.length
    ? `Disabling keeps ${listed(bindingNames(kept))} on a Secret your access cannot operate. Choose another Secret for ${kept.length > 1 ? "them" : "it"} in Edit Slack first, then disable.`
    : null;
}

function keptReplaceBindings(
  keys: readonly string[] | null,
  saved: SecretBindings | undefined,
  submitted: SecretBindings | undefined,
) {
  return (keys ?? []).filter((key) => {
    const id = secretIdForBinding(submitted === undefined ? saved?.[key] : submitted[key]);
    return id !== null && id === secretIdForBinding(saved?.[key]);
  });
}

export function createChannelSecretsPanel({
  context,
  path,
  agent,
  configuration,
  values,
  revisionsLoaded,
  carried = null,
  outstandingGrants = null,
  checkGrants = false,
  canGrant = true,
  readOnly = () => false,
  readOnlyReason = () => CHANNEL_SECRETS_CONFIGURATION_READ_ONLY,
  bindingsToReplace = () => null,
  bindingRefusal = async () => undefined,
  isCurrent = () => true,
  onReadDenied,
  onOutstandingGrants,
  onConfigurationChange,
  onChange,
  onReload,
}: {
  context: AgentAccessContext;
  path: string;
  agent: ChannelState["agent"];
  configuration: Configuration;
  values: OpenClawConfigurationDocument;
  revisionsLoaded: boolean;
  carried?: CarriedChannelSecrets | null;
  // Grants an earlier save on this page left outstanding, and where to keep the current ones.
  outstandingGrants?: OutstandingSecretGrants | null;
  onOutstandingGrants?(grants: OutstandingSecretGrants | null): void;
  onReadDenied(error: unknown, receipt: HTMLElement): void;
  // Whether to read the Namespace's IAM policy for bound Secrets the Agent has no grant for.
  checkGrants?: boolean;
  // False when this session is known not to administer the Installation, so it cannot grant.
  canGrant?: boolean;
  // True when the caller may not update this Configuration: the bindings are shown, not edited
  // (finding 2432). The page's permission answer can land after the panel is built.
  readOnly?(): boolean;
  // Why the bindings are read-only: Configuration update, or Secret operate on the Secrets it
  // binds, which every Configuration save also needs (finding 2437).
  readOnlyReason?(): string;
  // Slack token names whose bound Secret the caller may not operate: a save must replace each of
  // them, since it is checked on the Secrets it submits (finding 2444).
  bindingsToReplace?(): readonly string[] | null;
  // Why a save that bound these chosen Secrets was refused, when a fresh permission answer
  // names one the caller may not operate; undefined keeps the usual text (finding 2453).
  bindingRefusal?(secrets: readonly SecretMetadata[]): Promise<string | undefined>;
  // Whether this panel is still the page's own, for answers that arrive late.
  isCurrent?(): boolean;
  onConfigurationChange?(configuration: Configuration): void;
  onChange(): void;
  onReload(carried: CarriedChannelSecrets | null): void;
}) {
  const state: ChannelState = {
    agent,
    configuration,
    values,
    saving: false,
    saveError: null,
    saveMessage: "",
    saveGrantWarning: "",
    pendingSecretGrants: Object.fromEntries(
      (outstandingGrants?.secrets ?? []).map((secret) => [secret.id, secret]),
    ),
    grantProblem: outstandingGrants?.problem ?? "unconfirmed",
    outcomeUnknown: false,
    reloadRequired: false,
    // Unsaved Secret choices the form reopens with, and what a save conflict carries.
    draftSeed: null,
    // The form shows a Secret choice the saved bindings do not have (finding 1640).
    unsavedSecrets: false,
    carried: null,
    carriedNote: "",
    checkingGrants: false,
  };
  applyCarriedSecrets(state, carried);
  const section = element("section", { className: "agent-card channel-secrets" });

  function saveErrorText() {
    const { saveError, saveGrantWarning } = state;
    if (!saveError || saveError.step === "grant") {
      return saveGrantWarning;
    }
    if (saveError.retryRead) {
      return (
        `Channel Secret bindings are saved. Could not read the ${saveError.retryRead} before retrying Secret access. No binding changes or access grants were sent.` +
        (saveError.requestId ? ` Request ID: ${saveError.requestId}` : "")
      );
    }
    const message =
      saveError.step === "preflight"
        ? "Could not check the saved Configuration. Try again before saving channel Secrets." +
          (saveError.requestId ? ` Request ID: ${saveError.requestId}` : "")
        : credentialSaveError(saveError);
    // Report this failed save first. A grant can still be outstanding from an earlier save.
    return saveGrantWarning
      ? `${message} Access to a previously saved Secret is still unconfirmed.`
      : message;
  }

  // A refused save is danger. Secret grants left unconfirmed after a save are a warning, from
  // the failed grant on: the Configuration itself saved (finding 2003).
  function saveErrorTone() {
    return state.saveError && state.saveError.step !== "grant" ? "danger" : "warning";
  }

  function canEnterChannelCredentials() {
    return (
      !readOnly() &&
      revisionsLoaded &&
      !state.saving &&
      !state.outcomeUnknown &&
      !state.reloadRequired &&
      channelEnabled(state.values, "slack") &&
      servicePrincipalId(state.agent) !== null
    );
  }

  // Every bound Secret, which grants and their checks cover whether or not the form offers a
  // picker for it or a Slack setting reads it: Deploy checks them all (finding 2558).
  function referencedSecretIds(secretBindings: SecretBindings) {
    return new Set(boundSecrets(secretBindings).map(({ id }) => id));
  }

  function pendingSecretGrants(secretBindings = state.configuration.secretBindings ?? {}) {
    const referencedIds = referencedSecretIds(secretBindings);
    return Object.values(state.pendingSecretGrants).filter((secret) =>
      referencedIds.has(secret.id),
    );
  }

  // Outstanding grants this session could not verify, which it cannot retry either.
  function unverifiedGrants() {
    return state.grantProblem === "unverified" && pendingSecretGrants().length > 0;
  }

  function retryableGrants() {
    return pendingSecretGrants().length > 0 && state.grantProblem !== "unverified";
  }

  function prunePendingSecretGrants(secretBindings = state.configuration.secretBindings ?? {}) {
    state.pendingSecretGrants = Object.fromEntries(
      pendingSecretGrants(secretBindings).map((secret) => [secret.id, secret]),
    );
  }

  // Retry Secret access is offered only to a reader who may save the bindings.
  function slackGrantWarning() {
    return grantWarning(state.grantProblem, SLACK_GRANT, !readOnly());
  }

  function updateGrantWarning(secretBindings = state.configuration.secretBindings ?? {}) {
    prunePendingSecretGrants(secretBindings);
    const pending = pendingSecretGrants(secretBindings);
    state.saveGrantWarning = pending.length ? slackGrantWarning() : "";
    // The page keeps the outstanding grants across rebuilds of this panel.
    onOutstandingGrants?.(
      pending.length ? { secrets: pending, problem: state.grantProblem } : null,
    );
  }

  function secretGrantTargets({ secretBindings, changedSecrets }: SecretDraft) {
    prunePendingSecretGrants(secretBindings);
    for (const binding of SLACK_SECRET_BINDINGS) {
      const secret = changedSecrets[binding.key];
      if (secret?.id && secretIdForBinding(secretBindings?.[binding.key]) === secret.id) {
        state.pendingSecretGrants[secret.id] = secret.ref;
      }
    }
    return Object.values(state.pendingSecretGrants);
  }

  // Channel credentials are saved and complete: the next-step card's credentials step (UX spec
  // 3.7). Deploy also needs the version history. A grant read still in flight may yet show a
  // bound Secret the Agent cannot use, so Deploy waits for it (#3686 review).
  // A grant this session could not verify holds nothing: the save finished, nothing here can
  // confirm the grant, and the API checks the Agent's access when it deploys (finding 2547).
  function grantHoldsDeploy() {
    return Boolean(state.saveGrantWarning) && state.grantProblem !== "unverified";
  }

  function credentialsReady() {
    return (
      !state.saving &&
      !state.checkingGrants &&
      !state.outcomeUnknown &&
      !state.reloadRequired &&
      !grantHoldsDeploy() &&
      !state.unsavedSecrets &&
      hasRequiredChannelCredentials(state.values, state.configuration)
    );
  }

  function canDeploy() {
    return revisionsLoaded && credentialsReady();
  }

  function deployGateMessage() {
    if (state.saving) {
      return "Wait for the credential save to finish before deploying.";
    }
    if (state.outcomeUnknown) {
      return "Credential changes may have been saved. Reload this draft and inspect the saved state before deploying.";
    }
    if (state.reloadRequired) {
      return "Configuration changed. Reload this draft before deploying.";
    }
    if (!revisionsLoaded) {
      return "Version history is required before deploying this new version.";
    }
    if (state.checkingGrants) {
      return CHECKING_CREDENTIAL_ACCESS;
    }
    if (grantHoldsDeploy()) {
      return "Resolve the saved Secret access grant before deploying.";
    }
    const blockReason = channelCredentialBlockReason(state.values);
    if (blockReason !== null) {
      return blockReason;
    }
    const missing = missingChannelCredentialGroups(state.values, state.configuration);
    if (missing.length) {
      return `Complete these in Credentials before deploying: ${missing.join(", ")}.`;
    }
    if (state.unsavedSecrets) {
      // A member who cannot read a saved Secret cannot pick it again: the picker offers the
      // unreadable binding only while the draft still holds it (finding 1649). A page reload
      // drops unsaved choices for every reader, with the page's other unsaved edits.
      return "Save the channel Secret choices before deploying, or reload the page to discard unsaved changes.";
    }
    return "Ready to deploy.";
  }

  // The last render's save outcome and next-step controls, for focus after a save.
  const shown: {
    status?: HTMLElement | null;
    save?: HTMLButtonElement | null;
    reload?: HTMLButtonElement | null;
    outcome?: HTMLElement | null;
    bindings?: HTMLElement;
    error?: HTMLElement;
    updateControls?: (() => void) | null;
  } = {};
  // Saves started, so a grant check that a save overtook drops its answer.
  let saveCount = 0;
  let readDenied = false;
  // Grant reads started: only the latest one clears the Deploy hold or changes the panel.
  let grantRead = 0;
  // A save or Retry overtook a grant read, so the panel reads the grants again once it ends:
  // the dropped answer may have shown a bound Secret the save left ungranted (finding 2575).
  let grantRecheck = false;
  // Whether the last save was a Retry, so a grant read that settles can restate its outcome.
  let lastSaveRetry = false;

  // A grant read settled: the save outcome names Deploy only if nothing now holds it.
  function restateSaveOutcome() {
    if (!state.saveMessage) {
      return;
    }
    state.saveMessage = saveOutcomeText(lastSaveRetry);
    if (shown.status && shown.status.textContent !== state.saveMessage) {
      shown.status.textContent = state.saveMessage;
    }
  }

  // A save's outcome points to Deploy only when no grant read is still to come and no bound
  // Secret waits for its grant: the read that follows may yet hold Deploy (#3686 review).
  function saveOutcomeText(retry: boolean) {
    lastSaveRetry = retry;
    const saved = retry
      ? "This Agent can use its saved Slack Secrets."
      : "Channel Secret bindings saved.";
    return grantRecheck || state.checkingGrants || pendingSecretGrants().length
      ? saved
      : `${saved}${DELIVER_ON_DEPLOY}`;
  }

  function renderChannelForm(error: HTMLElement) {
    shown.save = null;
    shown.status = null;
    shown.updateControls = null;
    state.unsavedSecrets = false;
    if (!channelEnabled(state.values, "slack")) {
      return null;
    }
    // Keys the form has no pickers for are listed only; the form then keeps just Retry Secret
    // access for their outstanding grants.
    const listOnly = slackFormBindings(state.values) === null;
    const formBindings = slackFormBindings(state.values) ?? [];
    const extraKeys = slackBindingKeys(state.values).some(
      (key) => !formBindings.some((binding) => binding.key === key),
    );
    let hintText = extraKeys ? SLACK_EXTRA_KEYS_HINT : null;
    if (listOnly) {
      hintText = usesNamedSlackAccounts(state.values)
        ? "Named Slack accounts use their own token keys. Bind them through the Configuration API."
        : SLACK_OTHER_KEYS_HINT;
    }
    const listHint = hintText === null ? null : element("p", { className: "hint" }, hintText);
    const formId = "runtime-channel-secrets-form";
    const draft: SecretDraft = {
      secretBindings: { ...(state.configuration.secretBindings ?? {}) },
      changedSecrets: {},
      ...structuredClone(state.draftSeed ?? {}),
    };
    // Reopen the form with its unsaved choices after a refused write or a draft reload.
    state.draftSeed = null;
    const pickers: ReturnType<typeof createSecretReferenceField>[] = [];
    const status = element(
      "p",
      { className: "hint", role: "status" },
      state.saveMessage || state.carriedNote,
    );
    const save = element(
      "button",
      { type: "submit", form: formId, className: "button button--primary" },
      "Save channel Secrets",
    );
    const readOnlyNote = element("p", { className: "hint" }, readOnlyReason());
    const replaceNote = element("p", { className: "hint" });
    // Why an enterable form's Save is disabled; Save is described by it (finding D793).
    const saveHint = element("p", { className: "hint", hidden: true });
    shown.status = status;
    shown.save = save;
    function createTokenPicker(binding: (typeof SLACK_SECRET_BINDINGS)[number]) {
      const picker = createSecretReferenceField({
        context,
        id: `runtime-${binding.key.toLowerCase().replaceAll("_", "-")}`,
        label: binding.label,
        getCurrentSource: () => draft.secretBindings[binding.key]?.source,
        onSecretSelected(secret) {
          draft.secretBindings = {
            ...draft.secretBindings,
            [binding.key]: secretBinding(secret),
          };
          draft.changedSecrets = { ...draft.changedSecrets, [binding.key]: secret };
          state.saveError = null;
          state.saveMessage = "";
          state.carriedNote = "";
          updateGrantWarning();
          setStatusTone(error, "warning");
          error.textContent = state.saveGrantWarning;
          status.textContent = "";
          updateControls();
          onChange();
        },
        createSecretName: () => `${state.agent.name} ${binding.secretName}`,
        createDialogTitle: `Create ${binding.label} Secret`,
        createFixedKey: {
          label: "Binding key",
          value: binding.key,
          hint: "This environment key is fixed for Slack Socket Mode.",
        },
        metadataLabel: `View ${binding.label.replace("Slack ", "")} Secret metadata`,
        required: true,
        disabled: !canEnterChannelCredentials(),
      });
      pickers.push(picker);
      return picker.field;
    }
    const canSaveChannelSecrets = () =>
      canEnterChannelCredentials() &&
      formBindings.every(
        (binding) => secretIdForBinding(draft.secretBindings[binding.key]) !== null,
      ) &&
      (Object.values(draft.changedSecrets).length > 0 || retryableGrants());
    const updateControls = () => {
      // Deploy delivers the saved bindings, so a choice shown here but not saved blocks it, as
      // an unsaved authentication source does.
      state.unsavedSecrets = formBindings.some(
        (binding) =>
          secretIdForBinding(draft.secretBindings[binding.key]) !==
          secretIdForBinding(state.configuration.secretBindings?.[binding.key]),
      );
      for (const picker of pickers) {
        picker.setDisabled(state.saving || !canEnterChannelCredentials());
        picker.setRequired(true);
      }
      // With the saved bindings shown, the button only retries their outstanding grants.
      save.textContent =
        !state.unsavedSecrets && pendingSecretGrants().length
          ? "Retry Secret access"
          : "Save channel Secrets";
      const saveUnavailable = !canSaveChannelSecrets();
      // A session that cannot grant gets no Retry the API would refuse (finding 2263). A reader
      // gets no Save the API would refuse either (finding 2432).
      readOnlyNote.hidden = listOnly || !readOnly();
      readOnlyNote.textContent = readOnlyReason();
      const replace = readOnly() || listOnly ? [] : (bindingsToReplace() ?? []);
      replaceNote.hidden = replace.length === 0;
      replaceNote.textContent = replace.length ? channelReplaceHint(replace) : "";
      save.hidden =
        readOnly() ||
        (!state.unsavedSecrets && unverifiedGrants()) ||
        (listOnly && !retryableGrants());
      // A form the reader can fill says why Save is disabled: a token has no Secret yet, or
      // nothing changed. While a save runs, or after one that needs Reload draft, the status or
      // error line says why instead.
      let saveReason = "";
      if (!save.hidden && saveUnavailable && canEnterChannelCredentials()) {
        saveReason = formBindings.some(
          (binding) => secretIdForBinding(draft.secretBindings[binding.key]) === null,
        )
          ? "Choose a Secret for each Slack token to save."
          : "No channel Secret changes to save.";
      }
      saveHint.textContent = saveReason;
      saveHint.hidden = saveReason === "";
      // Unavailable Save stays in the Tab order while one of these says why (finding 2878).
      setUnavailable(
        save,
        saveUnavailable,
        [saveHint, status, error].find((reason) => !reason.hidden && reason.textContent?.trim()),
      );
    };
    shown.updateControls = updateControls;
    const form = element(
      "form",
      { id: formId, className: "credential-form", novalidate: "" },
      listHint,
      readOnlyNote,
      replaceNote,
      ...formBindings.map((binding) => createTokenPicker(binding)),
      status,
      saveHint,
      element("div", { className: "form-actions" }, save),
    );
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!canEnterChannelCredentials()) {
        return;
      }
      // The console's own errors under each field, not the browser's bubble (UX plan C3).
      if (!validateFields([...form.elements])) {
        return;
      }
      if (!canSaveChannelSecrets()) {
        return;
      }
      // A retry writes no Configuration: the saved bindings stay as they are (finding 1920).
      const retry = !state.unsavedSecrets;
      const refusal = retry
        ? null
        : channelReplaceRefusal(
            bindingsToReplace(),
            state.configuration.secretBindings,
            draft.secretBindings,
          );
      if (refusal) {
        status.textContent = "";
        setStatusTone(error, "danger");
        error.textContent = refusal;
        return;
      }
      saveCount += 1;
      state.saving = true;
      state.saveError = null;
      state.saveMessage = "";
      state.carriedNote = "";
      state.saveGrantWarning = "";
      status.textContent = retry
        ? "Checking Secret access..."
        : "Saving channel Secret bindings...";
      error.textContent = "";
      updateControls();
      onChange();
      let mutationStarted = false;
      let configurationSaved = false;
      let failedRead: "Agent" | "Configuration" | undefined;
      // A conflict keeps these choices for Reload draft instead of dropping them (finding 1512).
      const carryChoices = () => {
        state.reloadRequired = true;
        state.draftSeed = structuredClone(draft);
        state.carried = {
          configurationId: state.configuration.id,
          initialSecretBindings: structuredClone(state.configuration.secretBindings ?? {}),
          ...structuredClone(draft),
        };
      };
      try {
        const configurationPath = `${namespacePath(context.namespaceId)}/configurations/${encodeURIComponent(state.configuration.id)}`;
        const [freshAgent, freshConfiguration] = await Promise.all([
          context
            .request(path)
            .then(responseFields)
            .catch((error: unknown) => {
              failedRead ??= "Agent";
              throw error;
            }),
          context
            .request(configurationPath)
            .then(responseFields)
            .catch((error: unknown) => {
              failedRead ??= "Configuration";
              throw error;
            }),
        ]);
        if (!context.isCurrent()) {
          return;
        }
        if (
          freshAgent.id !== state.agent.id ||
          freshAgent.servicePrincipalId !== state.agent.servicePrincipalId ||
          freshAgent.namespaceId !== context.namespaceId ||
          freshAgent.configurationId !== state.configuration.id ||
          freshConfiguration.id !== state.configuration.id ||
          freshConfiguration.namespaceId !== context.namespaceId ||
          freshConfiguration.generation !== state.configuration.generation
        ) {
          carryChoices();
          return;
        }
        if (!retry) {
          // A write from another browser after the preflight is refused with 409 (finding 1505).
          mutationStarted = true;
          const result = await context.request(configurationPath, {
            method: "PATCH",
            expectedStatus: 200,
            body: {
              values: state.values,
              secretBindings: draft.secretBindings,
              expectedGeneration: state.configuration.generation,
            },
          });
          if (!context.isCurrent()) {
            return;
          }
          state.configuration = confirmedConfiguration(
            result,
            state.configuration,
            state.values,
            draft.secretBindings,
          );
          onConfigurationChange?.(state.configuration);
        }
        configurationSaved = true;
        state.draftSeed = null;
        state.carriedNote = "";
        // Grants an earlier request left refused or unconfirmed keep their problem and Retry.
        const earlierProblem = pendingSecretGrants().length > 0;
        const grantTargets = secretGrantTargets(draft);
        if (grantTargets.length && !canGrant) {
          // Granting writes IAM policy, which needs Installation administration. This session
          // already knows it lacks that, so it sends no grant the API would refuse and audit.
          // Nothing verified the Agent's access, which an administrator may already have
          // granted; the warning names who grants it, as the harness path does (findings 2109,
          // 2259, 2263).
          if (!earlierProblem) {
            state.grantProblem = "unverified";
          }
          state.outcomeUnknown = false;
          state.saveError = { ...requestFailure(undefined), step: "grant" };
          state.saveMessage = "";
          updateGrantWarning();
          status.textContent = "";
          setStatusTone(error, saveErrorTone());
          error.textContent = saveErrorText();
          return;
        }
        for (const secret of grantTargets) {
          if (!context.isCurrent()) {
            return;
          }
          await ensureCredentialOperateBinding(context, state.agent, secret);
          delete state.pendingSecretGrants[secret.id];
        }
        if (!context.isCurrent()) {
          return;
        }
        state.outcomeUnknown = false;
        updateGrantWarning();
        state.saveMessage = saveOutcomeText(retry);
        status.textContent = state.saveMessage;
      } catch (cause) {
        if (!context.isCurrent()) {
          return;
        }
        const failure = requestFailure(cause);
        if (failure.status === 401) {
          context.onExpired();
          return;
        }
        if (isStaleGeneration(cause) && mutationStarted && !configurationSaved) {
          carryChoices();
          return;
        }
        if (
          mutationStarted &&
          !configurationSaved &&
          failure.status === 409 &&
          failure.code === "RESOURCE_CONFLICT"
        ) {
          // The write was refused. Keep the choices in this form, without requesting a reload.
          state.draftSeed = draft;
        }
        const step = configurationSaved ? "grant" : mutationStarted ? "configuration" : "preflight";
        if (step === "grant") {
          // A refusal is known: only an Installation administrator can grant (finding 1920).
          state.grantProblem = grantProblemFor(failure.status) ?? "unconfirmed";
        }
        const refusal =
          step === "configuration" && failure.status === 403
            ? await bindingRefusal(Object.values(draft.changedSecrets))
            : undefined;
        if (!context.isCurrent()) {
          return;
        }
        state.saveError = {
          ...failure,
          step,
          refusal,
          ...(retry && step === "preflight" && failedRead ? { retryRead: failedRead } : {}),
        };
        if (step === "preflight" && failure.status === 403) {
          // This read authorizes the binding editor. Retire it before finally or a pending
          // grant check can recreate protected controls, but retain this attempt's receipt.
          readDenied = true;
          section.replaceChildren(
            element("h2", {}, "Channel Secrets"),
            element(
              "p",
              { role: "alert", className: "status", "data-tone": "danger" },
              saveErrorText(),
            ),
          );
          onReadDenied(cause, section);
          return;
        }
        state.saveMessage = "";
        state.outcomeUnknown =
          step === "configuration" &&
          (failure.status === undefined || ![400, 403, 404, 409, 429].includes(failure.status));
        updateGrantWarning(state.configuration.secretBindings);
        status.textContent = "";
        setStatusTone(error, saveErrorTone());
        error.textContent = saveErrorText();
      } finally {
        if (context.isCurrent() && !readDenied) {
          state.saving = false;
          if (grantRecheck || state.checkingGrants) {
            // Deploy stays held until the new read lands.
            grantRecheck = false;
            void checkBoundSecretGrants();
          }
          updateControls();
          render();
          onChange();
          // The rebuilt section replaced the pressed button: focus the next step, described
          // by the outcome, or the outcome itself (finding 1481).
          focusSaveOutcome(section, [shown.reload, shown.save], shown.outcome);
        }
      }
    });
    updateControls();
    return form;
  }

  function renderUnavailableReason() {
    if (!revisionsLoaded) {
      return element(
        "p",
        { className: "muted", role: "status" },
        "Credential entry requires readable version history.",
      );
    }
    if (channelEnabled(state.values, "slack") && servicePrincipalId(state.agent) === null) {
      return element(
        "p",
        { className: "status", "data-tone": "danger", role: "alert" },
        "The API did not return this Agent's service principal, so the console cannot bind Secrets.",
      );
    }
    return null;
  }

  function render() {
    const error = element(
      "p",
      { className: "status", "data-tone": saveErrorTone(), role: "alert" },
      saveErrorText(),
    );
    const reloadMessage = state.reloadRequired
      ? element(
          "p",
          { className: "status", "data-tone": "danger", role: "alert" },
          "Configuration changed. Reload this draft before saving channel Secrets.",
        )
      : null;
    // An unknown outcome always comes with its save error, which the error line above shows as a
    // danger alert ("Outcome unknown…"); the deploy gate names it too (finding 2014).
    // Reload draft also clears grants this session could not verify (finding 2263).
    const reload =
      state.outcomeUnknown || state.reloadRequired || unverifiedGrants()
        ? button("Reload draft", (event) => {
            // The page rebuilds this section from the reread draft, with the Secret choices a
            // save conflict kept applied over it.
            if (event.currentTarget instanceof HTMLButtonElement) {
              event.currentTarget.disabled = true;
            }
            void onReload(state.reloadRequired && !state.outcomeUnknown ? state.carried : null);
          })
        : null;
    const bindings = renderSlackBindings(state);
    shown.bindings = bindings;
    shown.error = error;
    const form = renderChannelForm(error);
    shown.reload = reload;
    shown.outcome = state.saveError
      ? error
      : (reloadMessage ?? (shown.status?.textContent ? shown.status : null));
    if (!channelEnabled(state.values, "slack") && state.carriedNote) {
      // Shown only to say carried Secret choices were not reapplied (finding 1525).
      section.replaceChildren(
        element("h2", {}, "Channel Secrets"),
        element("p", { className: "hint", role: "status" }, state.carriedNote),
      );
      return;
    }
    section.replaceChildren(
      ...[
        element("h2", {}, "Channel Secrets"),
        element(
          "p",
          { className: "muted" },
          "Save Slack tokens as Secrets, then deploy a new version to apply them. Saved bindings do not confirm live channel readiness.",
        ),
        bindings,
        error,
        reloadMessage,
        reload ? element("div", { className: "form-actions credential-actions" }, reload) : null,
        renderUnavailableReason(),
        form,
      ].filter((node) => node !== null),
    );
  }

  // A reload forgets a refused grant. An Installation administrator's console reads the IAM
  // policy instead: a bound Secret the Agent has no grant for, under any key (finding 2558), waits
  // for Retry Secret access as an outstanding grant does, and one granted since is no longer
  // outstanding. A failed or undecided read changes nothing (finding 1920).
  async function checkBoundSecretGrants() {
    grantRead += 1;
    const read = grantRead;
    const bound = boundSecrets(state.configuration.secretBindings).filter(
      (secret) => secret.namespaceId === context.namespaceId,
    );
    if (!bound.length || servicePrincipalId(state.agent) === null) {
      // Nothing left to read: an earlier read still in flight no longer holds Deploy.
      state.checkingGrants = false;
      return;
    }
    const started = saveCount;
    state.checkingGrants = true;
    try {
      await applyBoundSecretGrants(bound, started, read);
    } finally {
      // Deploy waited for this read, whatever its outcome, unless a newer read replaced it.
      if (read === grantRead) {
        state.checkingGrants = false;
        if (context.isCurrent() && isCurrent()) {
          restateSaveOutcome();
          shown.updateControls?.();
          onChange();
        }
      }
    }
  }

  async function applyBoundSecretGrants(bound: SecretReference[], started: number, read: number) {
    let grants;
    try {
      grants = await credentialOperateGrants(
        context,
        state.agent,
        "secret",
        bound.map(({ id }) => id),
      );
    } catch {
      return;
    }
    // A newer read replaced this one, and a rebuilt panel no longer speaks for the page.
    if (!context.isCurrent() || readDenied || read !== grantRead || !isCurrent()) {
      return;
    }
    // A save since the read began may have granted or replaced these Secrets. The save reads
    // the grants again when it ends.
    if (state.saving || saveCount !== started) {
      grantRecheck = true;
      return;
    }
    let changed = false;
    for (const secret of bound) {
      const granted = grants.get(secret.id);
      if (granted === false && !(secret.id in state.pendingSecretGrants)) {
        state.pendingSecretGrants[secret.id] = secret;
        changed = true;
      } else if (granted === true && secret.id in state.pendingSecretGrants) {
        delete state.pendingSecretGrants[secret.id];
        changed = true;
      }
    }
    // This reader can grant: the warning asks for Retry, not for an administrator.
    if (pendingSecretGrants().length && state.grantProblem !== "missing") {
      state.grantProblem = "missing";
      changed = true;
    }
    if (!changed) {
      return;
    }
    updateGrantWarning();
    // Update in place: a rebuilt form would drop Secret choices made meanwhile and the focus.
    const bindings = renderSlackBindings(state);
    shown.bindings?.replaceWith(bindings);
    shown.bindings = bindings;
    if (shown.error && (!state.saveError || state.saveError.step === "grant")) {
      setStatusTone(shown.error, saveErrorTone());
      shown.error.textContent = saveErrorText();
    }
  }

  updateGrantWarning();
  render();
  if (checkGrants && channelEnabled(values, "slack")) {
    void checkBoundSecretGrants();
  }
  return {
    // What the Channels tab says while saved Slack Secrets wait for the Agent's grant.
    grantWarning: () => (state.saving || !pendingSecretGrants().length ? "" : slackGrantWarning()),
    section: channelEnabled(values, "slack") || state.carriedNote ? section : null,
    canDeploy,
    credentialsReady,
    deployGateMessage,
    isSaving: () => state.saving,
    checkingGrants: () => state.checkingGrants,
    // The permission answer changed what this caller may edit: update the form in place.
    applyAccess() {
      // The answer can take Retry away: a missing or unconfirmed grant's warning then names who
      // grants it.
      // Only the words change: the outstanding grants stay as they are.
      if (state.saveGrantWarning) {
        state.saveGrantWarning = slackGrantWarning();
        if (shown.error && (!state.saveError || state.saveError.step === "grant")) {
          shown.error.textContent = saveErrorText();
        }
      }
      shown.updateControls?.();
    },
    mutationPending: () => state.saving || state.outcomeUnknown || state.reloadRequired,
  };
}
