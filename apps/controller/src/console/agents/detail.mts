import type {
  Agent,
  AgentCallerPermissionsResponse,
  AgentDeploymentStatusWire,
  AgentHarnessStatusRead,
  AgentRead,
  AgentRevision,
  AgentRevisionRead,
  Configuration,
  HarnessAuthBinding,
  OpenClawConfigurationDocument,
  SecretMetadata,
} from "@openclaw-enterprise/contracts";
import type { Static } from "typebox";
import { requestFailure, responseFields } from "../api-client.mjs";
import type { ConsolePageContext } from "../page-context.mjs";
import { renderAgentDriverConfigurations } from "../driver-configurations.mjs";
import {
  button,
  element,
  fieldError,
  focusSaveOutcome,
  jsonObjectProblem,
  revealStatus,
  setHidden,
  setStatusTone,
  setText,
  statusBlock,
  validateFields,
} from "../dom.mjs";
import {
  configuredHarnessId,
  createHarnessAuthFields,
  harnessAuthDescription,
  renderHarnessAuthSummary,
} from "./harness-auth.mjs";
import { renderAgentAccess } from "./access.mjs";
import { renderNativeAdminAccess } from "./native-admin.mjs";
import { createAgentDeletion } from "./deletion.mjs";
import { createAgentStop } from "./stop.mjs";
import { renderAgentPlugins } from "./plugins.mjs";
import { repositoryProfile, repositoryWriteAccessHelp } from "./repository-profiles.mjs";
import { createRepositoryFields } from "./repositories.mjs";
import { renderChannels } from "../channels.mjs";
import { carryDocument, sameValue } from "../carry.mjs";
import { renderWorkspaceFiles } from "./workspace.mjs";
import { renderAgentLogs } from "./logs.mjs";
import {
  displayDate,
  shortId,
  namespacePath,
  refusedSave,
  secretOperateRefusal,
  channelBindingRefusal,
  agentSaveDenial,
  message,
  rejectionMessage,
  assertReadableConfiguration,
  isStaleGeneration,
  configurationConflictMessage,
  GENERIC_CONFLICT,
  GENERIC_DENIAL,
  NAMESPACE_NOT_READY_MESSAGE,
  NEUTRAL_DEPLOYMENT_NOTES,
  deploymentOutcome,
  neutralDeploymentOutcome,
  outcomeLabel,
  preAdmissionRefusal,
  askInstallationAdministrator,
  type AccessNeed,
} from "./list.mjs";
import {
  type CarriedChannelSecrets,
  type OutstandingSecretGrants,
  type SecretGrantProblem,
  grantProblemFor,
  grantWarning,
  harnessGrantSubject,
  createChannelSecretsPanel,
  CHANNEL_SECRETS_CONFIGURATION_READ_ONLY,
  channelBindingsToReplace,
  channelReplaceHint,
  channelReplaceRefusal,
  channelDisableRefusal,
  channelSecretsOperateReadOnly,
  hasRequiredChannelCredentials,
  channelCredentialBlockReason,
} from "./credentials.mjs";
import {
  credentialOperateGrants,
  ensureCredentialOperateBinding,
  secretOperateAnswer,
} from "./credential-access.mjs";
import {
  createDeploymentStatusPanel,
  createVersionDeploymentEvidence,
  deploymentPending,
  readRevisionPage,
} from "./deployment-evidence.mjs";
import { createDeploymentRecovery } from "./deployment-recovery.mjs";
import {
  sameNamespaceSecretHref,
  secretMetadata,
  secretSourceForBinding,
} from "./secret-picker.mjs";

type DetailContext = ConsolePageContext & { namespaceId: string; agentId: string };
type Permissions = Static<typeof AgentCallerPermissionsResponse>["data"];
type RevisionPage = Awaited<ReturnType<typeof readRevisionPage>>;
type Revision = RevisionPage["revisions"][number];
type RevisionResult = PromiseSettledResult<RevisionPage>;
type DeploymentOutcome = Parameters<typeof outcomeLabel>[0];
type Snapshot = Configuration | AgentRevisionRead;
type AgentMetadataOnly = Extract<AgentRead, { configurationReadError: unknown }>;
type PageAgent =
  | (Agent & { configurationReadError?: never })
  | (AgentMetadataOnly & Partial<Record<Exclude<keyof Agent, keyof AgentMetadataOnly>, never>>);
type Credentials = ReturnType<typeof createChannelSecretsPanel>;
type SaveState = "idle" | "saving" | "uncertain";
type VersionControl = HTMLButtonElement | HTMLSelectElement;

interface EditorState {
  dirty: boolean;
  saving: boolean;
  outcomeUnknown: boolean;
  reloadRequired: boolean;
}

interface ConfigurationDraft {
  text: string;
  initialText: string;
  baseline: Pick<Configuration, "id" | "generation">;
  outcomeUnknown?: boolean;
  reloadRequired?: boolean;
  carried?: boolean;
}

type AuthenticationFields = ReturnType<ReturnType<typeof createHarnessAuthFields>["capture"]>;
interface AuthenticationDraft {
  fields: AuthenticationFields;
  originalFields: AuthenticationFields;
  baseline: Pick<Agent, "configurationId" | "harnessAuth" | "servicePrincipalId">;
  savedAuthentication: Agent | null;
  outcomeUnknown: boolean;
  // Why the saved source's grant is outstanding, once a grant attempt answered (finding 2259).
  grantProblem?: SecretGrantProblem;
}

interface DraftDetails {
  draft: true;
  snapshot: Configuration;
  values: OpenClawConfigurationDocument;
  executionMode: Agent["executionMode"];
  credentials: Credentials | null;
  channelSecretsNote: string;
  setAuthenticationPending(pending: boolean): void;
  setAuthenticationUnsaved(unsaved: boolean): void;
  setDraftEditorState(state: Partial<EditorState>): void;
  setAuthenticationSaveState(state: SaveState): void;
  setAuthenticationForm(form: HTMLElement): void;
  setPluginEditorState(state: Partial<EditorState>): void;
  // Whether this draft's IAM policy shows the harness authentication grant missing; the first
  // call reads it (finding 2260).
  harnessGrantMissing(): Promise<boolean>;
}

interface VersionDetails {
  draft: false;
  snapshot: AgentRevision;
  values: AgentRevision["configuration"];
  executionMode: AgentRevision["harness"]["mode"];
}
type Details = DraftDetails | VersionDetails;
type DetailsResult = Details | { error: unknown } | undefined;
type DraftFocus = string | readonly string[] | null | undefined;
type DraftRefresh = { agent?: AgentRead | null; saved?: string; focus?: DraftFocus };

// A parked tab owns its exact DOM, unsaved-work registrations and navigation explanation.
interface MountedTab {
  id: string;
  reusable: boolean;
  loading: boolean;
  pending: number;
  mutations: number;
  resumeDrafts?(): void;
  showBlock?(): void;
  refresh?(): void;
  applyOperate?(allowed: boolean | undefined): void;
  nodes?: ChildNode[];
}

const refusedWriteStatuses: readonly (number | undefined)[] = [400, 403, 404, 409, 429];

// The pending write of each status that announceAfterShown is waiting to fill.
const pendingAnnouncements = new WeakMap<Element, { text: string; timer: number }>();

// Empties a status just inserted with `text` and writes it again once screen readers have seen
// it empty, so they announce it as a change. A timer, unlike a frame, also runs in a hidden tab.
// A newer call replaces the pending write, so the status is written once (finding 1976).
function announceAfterShown(status: Element, text: string) {
  clearTimeout(pendingAnnouncements.get(status)?.timer);
  status.textContent = "";
  const timer = setTimeout(() => {
    pendingAnnouncements.delete(status);
    status.textContent = pending.text;
  }, 100);
  const pending = { text, timer };
  pendingAnnouncements.set(status, pending);
}

// Sets a status's text, or, while announceAfterShown waits to fill it, the text it will write:
// writing now as well would make a screen reader speak it twice.
function setAnnouncedText(status: Element, text: string) {
  const pending = pendingAnnouncements.get(status);
  if (pending) {
    pending.text = text;
  } else {
    status.textContent = text;
  }
}

// Drops a status's pending write, for a status taken off the page.
function cancelAnnouncement(status: Element) {
  clearTimeout(pendingAnnouncements.get(status)?.timer);
  pendingAnnouncements.delete(status);
}

// A 503 the deploy request answered before admission: no version was created, so Deploy stays
// available. Create Agent treats the same codes the same way (finding 1638).
function deployRefusedBeforeAdmission(error: unknown) {
  return (
    requestFailure(error).code === "RUNTIME_CREDENTIALS_CLUSTER_RBAC" ||
    preAdmissionRefusal(error) !== undefined
  );
}

function deployFailureText(cause: unknown, submitted: boolean) {
  const error = requestFailure(cause);
  if (error.code === "RUNTIME_CREDENTIALS_CLUSTER_RBAC") {
    return "Deployment refused: the cluster denied OCC access to this Agent's connection credentials. Ask a platform operator to grant the documented tenant RoleBindings, then deploy again.";
  }
  const refusal = submitted ? preAdmissionRefusal(error) : undefined;
  if (refusal !== undefined) {
    return refusal;
  }
  if (error.status === 409 && error.code === "NAMESPACE_NOT_READY") {
    return NAMESPACE_NOT_READY_MESSAGE;
  }
  if (error.status !== 403 && error.status !== 409) {
    return rejectionMessage(cause, submitted);
  }
  // A typed refusal is written for the caller: a 409 names the setting or state to fix, and a
  // 403 other than the caller's own denial names the Agent's service principal and a resource
  // the caller was already authorized to operate. Showing it reveals nothing the API did not
  // already tell this caller (D94).
  if (
    error.serverMessage !== undefined &&
    error.serverMessage !== GENERIC_DENIAL &&
    error.serverMessage !== GENERIC_CONFLICT
  ) {
    return error.serverMessage;
  }
  return error.status === 403
    ? `Deployment denied. Check Agent deploy permission and access to selected Secrets. First deployment also needs Agent read and operate permissions to create connection credentials. Granting them ${askInstallationAdministrator("check these grants")}`
    : "Deployment conflicts with the saved Agent state. Refresh this Agent to check for changed Configuration or missing connection credentials. If credentials are missing after an earlier version, ask an operator to restore them.";
}

// Deployment authorizes Secret operate on every Secret the draft binds (finding 2546).
function deploySecretsOperateReason(names: readonly string[]) {
  const listed =
    names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `Deploying needs Secret operate on ${listed}, which your access does not include. Ask an Installation administrator to grant it.`;
}

// The credential an Agent's harness authentication grant covers: its credential source or its
// Secret, if any.
function harnessCredential(binding: HarnessAuthBinding | null | undefined, namespaceId: string) {
  return binding?.method === "credential_source"
    ? { kind: "credential_source" as const, namespaceId, id: binding.sourceId }
    : binding && "source" in binding && binding.source.kind === "secret"
      ? binding.source
      : null;
}

// The draft is the Agent's Configuration: an Agent reader without Configuration read is refused it.
const DRAFT_CONFIGURATION_NEED: AccessNeed = {
  task: "Reading this Agent's draft Configuration",
  grant: "Configuration read",
};

function errorPanel(
  cause: unknown,
  context: DetailContext,
  retry: () => void,
  { version = false } = {},
) {
  const error = requestFailure(cause);
  if (error.status === 401) {
    context.onExpired();
    return element("div");
  }
  // Revision read is granted per version; Agent access alone does not cover new versions.
  const versionDenied = version && error.status === 403;
  return element(
    "section",
    { className: "state-panel", role: "alert" },
    element(
      "h2",
      {},
      error.code === "SAVED_CONFIGURATION_UNREADABLE"
        ? "Saved configuration unreadable"
        : versionDenied
          ? "You cannot read this version"
          : "Configuration unavailable",
    ),
    element(
      "p",
      {},
      versionDenied
        ? "Your access to this Agent does not include this version, so its configuration and deployment outcome are hidden. Ask an Agent administrator for read access to it."
        : message(cause, false, DRAFT_CONFIGURATION_NEED),
    ),
    responseFields(cause).remembered === true
      ? element(
          "p",
          { className: "hint" },
          "This tab remembers the earlier denial. Retry checks your access again.",
        )
      : null,
    error.requestId
      ? element("p", { className: "request-id" }, `Request ID: ${error.requestId}`)
      : null,
    button("Retry", retry),
  );
}

function summary(
  values: OpenClawConfigurationDocument,
  details: [string, string | Node | null | undefined][],
) {
  const { model } = responseFields(responseFields(values.agents).defaults);
  const primary = typeof model === "string" ? model : responseFields(model).primary;
  const list = element("dl", { className: "configuration-summary" });
  for (const [name, value] of [
    ["Model", typeof primary === "string" ? primary : "Not specified"],
    ...details,
  ]) {
    list.append(element("dt", {}, name), element("dd", {}, value ?? "None"));
  }
  return list;
}

function nativeDocument(values: OpenClawConfigurationDocument, label: string) {
  return element(
    "details",
    { className: "native-document" },
    element("summary", {}, label),
    element("pre", { tabindex: "0" }, JSON.stringify(values, null, 2)),
  );
}

// A draft the caller can read but neither change nor save (finding 2421).
const READ_ONLY_DRAFT_NOTICE =
  "Version draft · read-only with your access. The next deployment uses it as saved.";
const CONFIGURATION_READ_ONLY = "Your access does not include editing this Configuration.";
// Saving a Configuration also needs Secret operate on every Secret it binds (finding 2437).
const CONFIGURATION_SECRETS_READ_ONLY =
  "Saving this Configuration needs Secret operate on each Secret it binds, which your access does not include.";
// A save's reread or its PATCH found a newer Configuration generation than the page's.
const CONFIGURATION_CHANGED =
  "The saved Configuration changed while you were editing. Reload this draft before saving.";
// The Configuration JSON saves no Secret bindings; a channel refusal that asks for one gets where
// the console binds Slack's standard names (finding 2494). The API keeps its secretBindings text.
const CHANNEL_BINDING_CONSOLE_REMEDY =
  "This editor does not save Secret bindings: bind SLACK_APP_TOKEN and SLACK_BOT_TOKEN on the Credentials tab or in the Slack editor on the Channels tab, and other names through the Configuration API.";

// Longest wait for Deployment activity's first read before the sections below it show. On a
// slow link that read lands over a second after the page, and a failed version's banner then
// pushed the shown overview down (finding 1489).
export const FIRST_ACTIVITY_WAIT_MS = 2000;
// The badge tone of a recorded deployment outcome in the Agent summary; superseded and stopped
// records stay neutral.
const DEPLOYMENT_OUTCOME_TONES: Partial<Record<DeploymentOutcome, string>> = {
  queued: "info",
  running: "info",
  succeeded: "success",
  failed: "danger",
};

// Versions whose deployment this tab has read as failed, keyed by Agent path and version ID. The
// Versions list reads only the latest version's record, so an earlier failed version lost its
// mark once a newer version was deployed (finding 2383). A failed record is final, so the mark
// stays for as long as the console is open. Each listed version's outcome comes with the list,
// so a new page load marks earlier failed versions too (finding 2422); a version's own record
// panel and the latest version's record add marks as they are read (finding 2407).
const failedVersions = new Set<string>();
const failedVersionKey = (agentPath: string, revisionId: string) =>
  JSON.stringify([agentPath, revisionId]);

// A recovery link opens a version tab far below the banner it sits in. Only the URL changed and
// the page stayed at the top, so the link looked dead (finding 1586). The page the link opens,
// switched in place, rebuilt or restored for Back, brings that tab into view and focuses it.
// Keyed by Namespace and target, so only the page the link names takes it, and by console load,
// so a load the link did not start (Back before it landed, a later visit) never takes it.
let linkedVersionView: {
  key: string;
  load: number;
  deploy?: boolean;
  edit?: boolean;
} | null = null;
let consoleLoads = 0;

/** The console starts a page load (navigation, Back, refocus): earlier link requests lapse. */
export function noteConsoleLoad() {
  consoleLoads += 1;
  if (linkedVersionView?.load !== consoleLoads) {
    linkedVersionView = null;
  }
}

/** The link request for this page, if one names it: `{ deploy }` says how to open it. */
function takeLinkedVersionView(key: string) {
  const linked = linkedVersionView?.key === key ? linkedVersionView : null;
  if (linked) {
    linkedVersionView = null;
  }
  return linked;
}

// One Tab stop for a list of version buttons, as in the tab strip (UX plan C7): it sits on the
// viewed version (else the newest), Up/Down (and Home/End) move focus between versions, and
// Enter or Space opens one. A rail of 51 versions was 51 Tab stops (finding 2101).
// It returns a function that moves the Tab stop to an item and focuses it.
function rovingVersions(list: HTMLElement, items: HTMLButtonElement[]) {
  const home = items.find((item) => item.getAttribute("aria-current") === "page") ?? items[0];
  const reset = () => {
    for (const item of items) {
      item.tabIndex = item === home ? 0 : -1;
    }
  };
  const focusItem = (target: HTMLButtonElement) => {
    for (const item of items) {
      item.tabIndex = item === target ? 0 : -1;
    }
    target.focus({ preventScroll: true });
  };
  reset();
  list.addEventListener("keydown", (event) => {
    const enabled = items.filter((item) => !item.disabled);
    const at = enabled.findIndex((control) => control === document.activeElement);
    const next = {
      ArrowUp: at - 1,
      ArrowDown: at + 1,
      Home: 0,
      End: enabled.length - 1,
    }[event.key];
    if (at === -1 || next === undefined || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    event.preventDefault();
    const target = enabled[(next + enabled.length) % enabled.length];
    if (!target) {
      return;
    }
    focusItem(target);
    target.scrollIntoView({ block: "nearest" });
  });
  // Tabbing back in lands on the viewed version, wherever the arrows left focus.
  list.addEventListener("focusout", () => {
    queueMicrotask(() => {
      if (!list.contains(document.activeElement)) {
        reset();
      }
    });
  });
  return focusItem;
}

export async function renderAgentDetail(
  context: DetailContext,
  { agent: preloadedAgent }: { agent?: AgentRead | null } = {},
): Promise<AgentRead | null> {
  const { view, namespaceId, agentId, request, url } = context;
  const path = `${namespacePath(namespaceId)}/agents/${encodeURIComponent(agentId)}`;
  // Saving the authentication source replaces it with the saved Agent (finding 1445).
  let agent = agentForPage(preloadedAgent ?? (await request(path)));
  if (!context.isCurrent()) {
    return null;
  }
  // The controller validates the response shape. Bind its identity to this page before using
  // a read as write preflight or a write response as confirmation. A metadata-only Agent or
  // revision is still readable; its saved configuration and editing controls remain unavailable.
  function agentForPage(value: unknown): PageAgent {
    const result = value as AgentRead | null;
    if (result?.id !== agentId || result.namespaceId !== namespaceId || !result.configurationId) {
      throw new Error("The response did not identify this Agent. Reload to check its saved state.");
    }
    return result;
  }
  const readAgent = (source: Pick<DetailContext, "request"> = context) =>
    source.request(path).then(agentForPage);

  async function readConfiguration(id: string, options?: Parameters<typeof request>[1]) {
    const value = await request(
      `${namespacePath(namespaceId)}/configurations/${encodeURIComponent(id)}`,
      options,
    );
    return configurationForPage(value, id);
  }

  function configurationForPage(value: unknown, id: string): Configuration {
    const result = value as Configuration | null;
    if (
      result?.id !== id ||
      result.namespaceId !== namespaceId ||
      !Number.isSafeInteger(result.generation)
    ) {
      throw new Error(
        "The response did not identify this Configuration. Reload to check its saved state.",
      );
    }
    return result;
  }

  async function saveConfigurationEdit(
    previous: Configuration,
    values: Readonly<Record<string, unknown>>,
    secretBindings?: Configuration["secretBindings"],
  ) {
    // Compare the values JSON can transmit, including -0 serialized as 0.
    const submittedValues: unknown = JSON.parse(JSON.stringify(values));
    const saved = await readConfiguration(previous.id, {
      method: "PATCH",
      expectedStatus: 200,
      body: {
        values: submittedValues,
        expectedGeneration: previous.generation,
        ...(secretBindings === undefined ? {} : { secretBindings }),
      },
    });
    if (
      saved.generation <= previous.generation ||
      !sameValue(saved.values, submittedValues) ||
      !sameValue(saved.secretBindings ?? {}, secretBindings ?? previous.secretBindings ?? {})
    ) {
      throw new Error(
        "The response did not confirm the saved Configuration. Reload to check its values.",
      );
    }
  }

  function revisionForPage(value: unknown, id?: string): AgentRevisionRead {
    const revision = value as AgentRevisionRead | null;
    if (
      !revision?.id ||
      (id !== undefined && revision.id !== id) ||
      revision.namespaceId !== namespaceId ||
      revision.agentId !== agentId
    ) {
      throw new Error(
        "The response did not identify a version of this Agent. Reload to check the deployment.",
      );
    }
    return revision;
  }

  function revisionsForPage(page: RevisionPage): RevisionPage {
    if (
      page.revisions.some((item) => item.agentId !== agentId || item.namespaceId !== namespaceId)
    ) {
      throw new Error(
        "The version history did not identify this Agent. Refresh to check it again.",
      );
    }
    for (const item of page.revisions) {
      // A version that a newer one or a Stop ended is listed as failed too, with the code that
      // says so; it is not marked (finding 2422).
      if (
        item.deploymentStatus === "failed" &&
        !neutralDeploymentOutcome({
          status: item.deploymentStatus,
          error: item.deploymentErrorCode === null ? null : { code: item.deploymentErrorCode },
        })
      ) {
        failedVersions.add(failedVersionKey(path, item.id));
      }
    }
    return page;
  }

  function readPermissions(): Promise<Permissions> {
    return request(`${path}/permissions`) as Promise<Permissions>;
  }
  // The readable Secrets this caller may not operate: each Secret field lists them disabled and
  // never stages one, since the save would answer 403 (finding 2453). Read when a field first
  // needs it, and again after a permission reread or an inline Secret create. A failed read keeps
  // the last answer; before any answer it marks none.
  const secretsOperateAnswer = secretOperateAnswer(() => request(`${path}/permissions/secrets`));
  const secretsOperateDenied = secretsOperateAnswer.read;
  context.setTitle(agent.name);
  // A missing summary leaves each control on its usual path, except failed-version
  // recovery, which waits for a positive answer before offering a draft link.
  let callerPermissions: Permissions | null = null;
  let callerPermissionsSettled = false;
  const callerPermissionsRead = readPermissions()
    .then(
      (permissions) => (callerPermissions = permissions),
      () => null,
    )
    .finally(() => {
      callerPermissionsSettled = true;
    });
  // Agent-side saves (plugins, authentication source, repository access) are Agent updates;
  // Configuration saves need Configuration update, its own bit (findings 1530, 2421). A draft
  // refresh reads the answer again, so a grant applies without a page Refresh (finding 1538).
  // The note names a Harness authentication ServiceAccount's read when the Agent uses one.
  let agentSaveDenied = callerPermissionsRead.then((permissions) =>
    agentSaveDenial(permissions, agent),
  );
  // Only the latest reread's answer replaces the summary.
  let permissionsRereads = 0;
  // The newest reread whose operate answer the page's controls show.
  let appliedOperateReread = 0;
  // The newest permission read. Logs compares a remembered status denial with it, so an
  // operate grant read since the page was built applies (finding 1579).
  let latestPermissionsRead = callerPermissionsRead;
  let permissionsReadSettled = false;
  void callerPermissionsRead.then(() => {
    permissionsReadSettled = latestPermissionsRead === callerPermissionsRead;
  });
  // A caller who may neither update the Agent nor its Configuration reads the draft; the page
  // says so instead of addressing an editor (finding 2421). An unknown answer keeps the editor.
  // Each Configuration save also needs Secret operate on every Secret it binds, so a caller
  // without it reads the Configuration too (finding 2437).
  const configurationReadOnly = () =>
    callerPermissions?.configurationUpdate === false ||
    callerPermissions?.configurationSecretsOperate === false;
  const configurationReadOnlyReason = () =>
    callerPermissions?.configurationUpdate === false
      ? CONFIGURATION_READ_ONLY
      : CONFIGURATION_SECRETS_READ_ONLY;
  // Channel saves submit the Secret bindings, and a save is checked only on the Secrets it
  // submits. Lacking operate only on Secrets bound to the Slack token names, which channel saves
  // replace, leaves Channels and channel Secrets editable: a save must replace each of them
  // (finding 2444). The Configuration editor submits no bindings, so it keeps the rule above.
  const channelBindingsReplace = () => channelBindingsToReplace(callerPermissions);
  const channelsReadOnly = () => configurationReadOnly() && channelBindingsReplace() === null;
  const channelsReadOnlyReason = () =>
    callerPermissions?.configurationUpdate === false
      ? CONFIGURATION_READ_ONLY
      : channelSecretsOperateReadOnly(
          callerPermissions?.configurationSecretsOperateDeniedBindings,
          CONFIGURATION_SECRETS_READ_ONLY,
        );
  // Agent-side saves (plugins, authentication source, repository access) would be refused: the
  // answer denies Agent update or a grant each Agent update also checks (finding 2441).
  const agentReadOnly = () => agentSaveDenial(callerPermissions, agent) !== undefined;
  // Channel saves that replace a bound Secret keep the draft changeable (finding 2444).
  const draftReadOnly = () => agentReadOnly() && channelsReadOnly();
  // Draft views that follow Configuration update. Nothing waits for an answer: a view drawn
  // before the first answer, or before a reread that changes the bit, is redrawn when it lands.
  // Each view redraws only while shown and only when its access differs from the answer's.
  const configurationAccessViews = new Set<() => void>();
  function followConfigurationAccess(rerender: () => void) {
    configurationAccessViews.add(rerender);
  }
  function redrawConfigurationAccessViews() {
    for (const rerender of configurationAccessViews) {
      rerender();
    }
  }
  // An Agent-side view (Plugins, Repositories) drawn from one answer is rebuilt when a newer
  // answer changes whether Agent saves are refused: a channel save that rebinds a Secret the
  // caller could not operate makes them editable without a reload (finding 2470).
  function followAgentSaveAccess(isShown: () => boolean) {
    let shownReadOnly: boolean | null = null;
    void agentSaveDenied.then((reason) => {
      shownReadOnly = reason !== undefined;
    });
    followConfigurationAccess(() => {
      if (mountedTab && isShown() && shownReadOnly !== null && agentReadOnly() !== shownReadOnly) {
        // Rebuild, not restore: a reusable tab would be parked and shown again as it was.
        mountedTab.reusable = false;
        void renderTab();
      }
    });
  }
  // Applies the newest permission answer to the draft's labels and views (findings 2421, 2432).
  function applyDraftAccess() {
    if (headerNewVersion) {
      // This opens the draft; Configuration update and Agent deploy are independent grants.
      headerNewVersion.textContent = agentReadOnly() ? "Open version draft" : "Create new version";
    }
    labelDraftEntry();
    renderVersionNotice();
    activeCredentials?.applyAccess();
    // A draft refresh rebuilds the shown tab and then redraws what its answer changed.
    if (!refreshingDraft) {
      redrawConfigurationAccessViews();
    }
    refreshDeployControls();
  }
  let deleting = agent.status === "deleting";
  let currentRevisionId = agent.activeRevisionId;
  // The Agent as last read; Stop and finished deployments update it in place.
  let currentAgent = agent;
  let currentRuntimeState = agent.desiredRuntimeState;
  let visibleRevisions: Revision[] = [];
  // True once the readable version list loaded; until then nothing counts as hidden.
  let visibleRevisionsLoaded = false;
  const selected = url.searchParams.get("revision") ?? agent.activeRevisionId ?? "draft";
  const tab = url.searchParams.get("tab");
  // Sharing policy reads need Installation administration and a denial is audited, so the
  // Access tab is left out (not disabled) when the session probe already showed that access is
  // missing (spec 3.8). It is about the whole Agent, so every version's strip has it, last.
  const sharingTab = context.installationAdmin !== false;
  const tabLabels: [string, string][] = [
    ["configuration", "Configuration"],
    ["plugins", "Plugins"],
    ["channels", "Channels"],
  ];
  if (selected === "draft") {
    tabLabels.push(["repositories", "Repositories"], ["credentials", "Credentials"]);
  }
  tabLabels.push(["workspace", "Workspace files"], ["policy", "Policy denials"]);
  if (selected !== "draft") {
    tabLabels.push(["logs", "Logs"]);
  }
  if (sharingTab) {
    tabLabels.push(["access", "Access"]);
  }
  const tabsForSelection = new Set(tabLabels.map(([id]) => id));
  let selectedTab = tab && tabsForSelection.has(tab) ? tab : "configuration";
  let deployInFlight = false;
  // The draft holds below are declared before a deleting Agent's early return: ← Agents and the
  // reload check read them on that page too (finding 2125).
  let draftEditorNavigationBlock: string | null = null;
  // Whether a draft editor's write is in flight (its block names the save to wait for).
  let draftEditorSaving = false;
  // Set while a saved draft refreshes in place; tab and version changes wait for it.
  let refreshingDraft = false;
  // A share or binding removal in flight. Its writes belong to this page, so other versions and
  // pages wait for it (finding 2108); tabs do not, since the panel stays with the page.
  let sharingWrite = false;
  let authenticationSaveState: SaveState = "idle";
  let activeCredentials: Credentials | null = null;
  // Channel Secret choices that Reload draft carries into the rebuilt panel (finding 1512). The
  // draft store keeps them too, for the page a failed reread reloads (finding 1525).
  let carriedChannelSecrets: CarriedChannelSecrets | null = null;
  // Saved Slack Secrets whose Agent grant was refused or left unconfirmed. Rebuilt panels and
  // later visits in this session keep warning and offer Retry Secret access (finding 1920).
  let outstandingChannelGrants =
    (context.drafts.get("channelSecretGrants") as OutstandingSecretGrants | undefined) ?? null;
  // The newest channel Secrets panel: an older one's late grant check no longer speaks for the page.
  let channelPanelCount = 0;
  function setOutstandingChannelGrants(grants: OutstandingSecretGrants | null) {
    outstandingChannelGrants = grants;
    if (grants) {
      context.drafts.track("channelSecretGrants", () => outstandingChannelGrants ?? undefined);
      // Saved state: nothing a reload or tab close would lose.
      context.drafts.unsavedWhen("channelSecretGrants", () => false);
    } else {
      context.drafts.forget("channelSecretGrants");
    }
  }
  const target = (revision = selected, tab = selectedTab) =>
    `agents/${agentId}?revision=${encodeURIComponent(revision)}&tab=${tab}`;
  const linkedKey = (revision = selected, tab = selectedTab) =>
    JSON.stringify([namespaceId, target(revision, tab)]);
  // A link to one of this Agent's version tabs that brings the tab into view once it opens.
  // With `deploy`, a draft link brings that draft's Deploy new version into view instead.
  function versionLink(label: string, revision: string, tab: string, { deploy = false } = {}) {
    const node = element("a", { href: context.pageUrl(target(revision, tab)) }, label);
    node.addEventListener("click", (event) => {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      if (revision === selected && tab === selectedTab) {
        // Already open below: rebuilding it would only discard the reader's edits.
        openVersionDetail({ animate: true, deploy });
        return;
      }
      // A link to another version must not add a history entry if sharing keeps this one open.
      if (sharingWrite && revision !== selected) {
        showLeaveBlock();
        return;
      }
      if (draftEditorBlocksNavigation()) {
        // Show the refusal at the editor without adding a visit the reader never made.
        showLeaveBlock();
        openVersionDetail({ animate: true });
        return;
      }
      // The load this navigation starts is the next one.
      linkedVersionView = { key: linkedKey(revision, tab), load: consoleLoads + 1, deploy };
      context.navigate(target(revision, tab));
    });
    return node;
  }
  const change = (revision: string, tab: string) => {
    if (draftEditorBlocksNavigation() || (sharingWrite && revision !== selected)) {
      showLeaveBlock();
      return;
    }
    context.navigate(target(revision, tab));
  };
  const headerNewVersion =
    selected !== "draft"
      ? button("Create new version", () => change("draft", "configuration"), { size: "sm" })
      : null;
  // Create new version sits in the page header beside Refresh (UX spec 3.2); the shell's
  // ← Agents and Namespace selector ask refuseLeave before they leave.
  const headerActions = element("div", { className: "agent-toolbar-actions" }, headerNewVersion);
  context.setPageActions?.(headerActions);
  // The note that holds the tabs also holds ← Agents and the Namespace selector (finding 1902).
  // Refresh rebuilds the page, so only a share in flight holds it.
  const refuseLeave = ({ pendingOnly = false, refresh = false } = {}) => {
    if (
      !sharingWrite &&
      (refresh || !(pendingOnly ? draftWriteInFlight() : draftEditorBlocksNavigation()))
    ) {
      return false;
    }
    showLeaveBlock();
    return true;
  };
  context.setLeaveGuard?.(refuseLeave);
  // The writes that hold Back and the sidebar make a reload or tab close ask first too. A draft
  // reread does not: a reload would lose nothing (finding 1938).
  context.setWriteInFlight?.(() => sharingWrite || Boolean(draftWriteInFlight({ rereads: false })));
  const currentVersionValue = element("strong", { className: "stat-value" });
  const currentVersionNote = element("p", { className: "stat-help" });
  // The summary's loading text follows the 250 ms rule: a read that settles sooner never shows
  // it, and the version number shows at once (finding 1438).
  function setDelayedText(node: HTMLElement, prefix: string, loading: string) {
    if (node.textContent !== prefix + loading || !node.querySelector(".delayed-status")) {
      node.replaceChildren(prefix, element("span", { className: "delayed-status" }, loading));
    }
  }
  const latestDeploymentValue = element("strong", { className: "stat-value" });
  // The note keeps its line while empty (console.css) when the page shows before the outcome,
  // so the loading text giving way to it moves nothing below (finding 2163); see showDetail.
  const latestDeploymentNote = element("p", { className: "stat-help stat-help-line" });
  setDelayedText(latestDeploymentValue, "", "Loading…");
  setDelayedText(latestDeploymentNote, "", "Reading deployment history.");
  // A recorded outcome is the version and a status badge (spec 3.5). The separator stays in the
  // text for screen readers and text matching ("v7 · Failed"); the badge's gap shows it.
  function setDeploymentOutcome(node: HTMLElement, version: string, label: string, tone?: string) {
    const text = `${version} · ${label}`;
    const badge = node.querySelector<HTMLElement>(":scope > .badge");
    if (node.textContent === text && badge && (badge.dataset.tone ?? "") === (tone ?? "")) {
      return;
    }
    node.replaceChildren(
      version,
      element("span", { className: "visually-hidden" }, " · "),
      element("span", { className: "badge", ...(tone ? { "data-tone": tone } : {}) }, label),
    );
  }
  const liveServingBadge = element("span", { className: "badge" }, "Not verified");
  const liveServingValue = element("strong", { className: "stat-value" }, liveServingBadge);
  const liveServingNote = element("p", { className: "stat-help" });
  // A failed deployment that probably left nothing serving (see renderLatestDeployment).
  let mayBeOfflineAfterFailure = false;
  // The Sandbox Driver's record of the current version's Sandbox, read once per serving state
  // (finding 2152). Nothing restarts a lost Sandbox, so Live serving says so and names the next
  // step. A status that cannot be read is unknown, never lost.
  let harnessRead: { revisionId: string; status: AgentHarnessStatusRead | null } | null = null;
  let harnessReads = 0;
  // The current version the read in flight or answered is for, or null when none is wanted.
  let harnessRequested: string | null = null;
  // Only a running Agent's dedicated current version has a Sandbox to read. The version's own
  // mode decides once the version list shows it; the Agent's saved mode can differ from it.
  // The note line is reserved from the first paint (console.css), so the answer moves nothing.
  const harnessExpected = () =>
    !deleting &&
    currentRuntimeState === "running" &&
    Boolean(currentRevisionId) &&
    (visibleRevisions.find((revision) => revision.id === currentRevisionId)?.harness?.mode ??
      currentAgent.executionMode) === "dedicated";
  function syncHarnessRead() {
    const wanted = harnessExpected() ? (currentRevisionId ?? null) : null;
    if (wanted === harnessRequested) {
      return;
    }
    // A stop, a new current version or a deletion drops any answer for the old state.
    const read = ++harnessReads;
    harnessRequested = wanted;
    harnessRead = null;
    if (wanted === null) {
      return;
    }
    void request(`${path}/harness-status`)
      .then(
        (status) => status as AgentHarnessStatusRead,
        () => null,
      )
      .then((status) => {
        if (read !== harnessReads || !context.isCurrent() || deleting) {
          return;
        }
        // A read that failed is kept as null: the note then says the status is unknown.
        harnessRead = { revisionId: wanted, status };
        renderLiveServing();
      });
  }
  function renderLiveServing() {
    syncHarnessRead();
    const expected = harnessExpected();
    const answer = harnessRead?.revisionId === currentRevisionId ? harnessRead : null;
    const harness =
      answer?.status?.status === "observed" && answer.status.revisionId === currentRevisionId
        ? answer.status.harness
        : undefined;
    const lost = expected && harness?.state === "lost";
    // With no current version nothing serves, so there is nothing to verify (finding 2403): a
    // failed first deployment said "Not verified" here. A requested stop stays unverified: the
    // page does not show when shutdown completes.
    const nothingRunning =
      !deleting &&
      !currentRevisionId &&
      !(
        currentRuntimeState === "stopped" &&
        (!visibleRevisionsLoaded || visibleRevisions.length > 0)
      );
    const badge = liveServingBadge;
    setText(
      badge,
      lost
        ? "Sandbox lost"
        : mayBeOfflineAfterFailure
          ? "May be offline"
          : nothingRunning
            ? "Not running"
            : "Not verified",
    );
    const tone = lost ? "danger" : mayBeOfflineAfterFailure ? "warning" : undefined;
    if (tone === undefined) {
      if (badge.dataset.tone) {
        delete badge.dataset.tone;
      }
    } else if (badge.dataset.tone !== tone) {
      badge.dataset.tone = tone;
    }
    liveServingNote.classList.toggle("stat-help-line", expected);
    // Nothing sends a running version a request to verify it, so "Not verified" says why
    // (finding 2367); a Sandbox note takes its place.
    const unchecked =
      tone === undefined && !deleting && currentRuntimeState === "running" && currentRevisionId
        ? "OCC sends no test request."
        : "";
    if (!expected) {
      setText(liveServingNote, unchecked);
    } else if (answer === null) {
      setDelayedText(liveServingNote, "", "Checking Sandbox…");
    } else if (lost) {
      // OCC does not restart a lost Sandbox. The notes stay short enough for one line in the
      // narrowest column (beside the sidebar), so the reserved line never grows.
      setText(liveServingNote, "Deploy a new version.");
    } else if (answer.status === null || harness?.state === "unknown") {
      setText(liveServingNote, "Sandbox status unknown.");
    } else if (harness?.code === "HARNESS_RESTARTING") {
      setText(liveServingNote, "Harness restarting.");
    } else if (harness?.state === "running") {
      setText(liveServingNote, "Sandbox running.");
    } else if (harness?.state === "starting") {
      setText(liveServingNote, "Sandbox starting.");
    } else {
      // The Sandbox Driver keeps no record of this Sandbox.
      setText(liveServingNote, unchecked);
    }
  }
  function setLiveServing(mayBeOffline: boolean) {
    mayBeOfflineAfterFailure = mayBeOffline;
    renderLiveServing();
  }
  // A requested stop belongs in the summary, not only in the Stop row at the bottom (finding
  // 1899). It is attached only once the Agent has a version: an Agent is created stopped.
  const runtimeNote = element("p", { className: "stat-help" });
  const stat = (label: string, ...children: HTMLElement[]) =>
    element(
      "div",
      { className: "stat" },
      element("span", { className: "overview-fact-label stat-label" }, label),
      ...children,
    );
  const runtimeFact = stat(
    "Runtime",
    element("strong", { className: "stat-value" }, "Stop requested"),
    runtimeNote,
  );
  // The facts are a stat row (spec 3.5); what they cannot tell the reader is said once, in the
  // disclosure under them, rather than under each fact (spec 3.6, plan D5).
  const currentSummary = element(
    "section",
    { className: "agent-current-summary stats", "aria-label": "Agent state at a glance" },
    stat("Selected version", currentVersionValue, currentVersionNote),
    stat("Latest visible deployment", latestDeploymentValue, latestDeploymentNote),
    stat("Live serving", liveServingValue, liveServingNote),
  );
  renderLiveServing();
  const pageDisclosure = element(
    "details",
    { className: "disclosure" },
    element("summary", {}, "What this page can tell you"),
    element(
      "ul",
      {},
      element("li", {}, "Selection does not confirm that this version is serving."),
      element("li", {}, "Deployment records don’t verify live serving or model access."),
      // Shown only beside a draft's next step (console.css), which it explains.
      element(
        "li",
        { className: "disclosure-deploy" },
        "Deployment creates an immutable version from the saved Configuration and plugin selections. Connection credentials are generated automatically on first deployment when needed. A successful request means work was admitted; readiness is tracked above.",
      ),
      // Shown only while the sharing panel is (console.css): it speaks for that panel's list.
      element(
        "li",
        { className: "disclosure-access" },
        "Listed bindings describe present configuration; they do not confirm a previous request’s outcome.",
      ),
    ),
  );
  const statCard = element(
    "div",
    { className: "card agent-stat-card" },
    currentSummary,
    pageDisclosure,
  );
  const statusLine = statusBlock("warning", null, null, [], {
    className: "agent-status-line",
    role: null,
    hidden: true,
  });
  // Revision read is granted per version, so someone who may deploy can still be
  // unable to read the version that is now current, or the one they just requested.
  function revisionHidden(revisionId: string | undefined) {
    // Until every page is loaded, an unlisted version may simply be older than those shown.
    return (
      visibleRevisionsLoaded &&
      olderCursor === null &&
      Boolean(revisionId) &&
      revisionId !== "draft" &&
      !visibleRevisions.some((revision) => revision.id === revisionId)
    );
  }
  // Members have no console chat, and native admin needs administer (and is off under
  // external sign-in), so point only at paths that work in every sign-in mode.
  const readAccessHint =
    "Ask an Agent administrator for read access to new versions. If this Agent is set up for a channel such as Slack, you can message it there when that channel allows you.";
  function renderCurrentVersion() {
    const current = visibleRevisions.find((revision) => revision.id === currentRevisionId);
    const version = current
      ? `v${current.revision}`
      : currentRevisionId
        ? shortId(currentRevisionId)
        : "None";
    setText(currentVersionValue, version);
    setText(
      currentVersionNote,
      !currentRevisionId
        ? "No version is currently selected for service."
        : revisionHidden(currentRevisionId)
          ? "Selected for service · you cannot read this version"
          : "",
    );
    const stopRequested =
      currentRuntimeState === "stopped" &&
      (Boolean(currentRevisionId) || visibleRevisions.length > 0);
    if (!stopRequested) {
      runtimeFact.remove();
    } else if (runtimeFact.parentNode !== currentSummary) {
      currentSummary.append(runtimeFact);
    }
    setText(
      runtimeNote,
      currentRevisionId
        ? "Shutdown completion is not shown here. Deploy a new version to start this Agent again."
        : "Deploy a new version to start this Agent again.",
    );
  }
  renderCurrentVersion();
  // Stop changes only the runtime state and the current version, so update the page in place.
  // Reloading it collapsed the version detail, moved the reader and dropped focus (finding 1419).
  const stopPanel = createAgentStop(
    context,
    path,
    agent,
    showDeleting,
    (next) => updateCurrentAgent(next, latestRevisionResult, viewedSnapshot),
    callerPermissionsRead.then((permissions) => permissions?.operate),
  );
  const deletion = createAgentDeletion(
    context,
    path,
    agent,
    showDeleting,
    callerPermissionsRead.then((permissions) => permissions?.delete),
  );
  // Stop and Delete are the rows of one danger zone at the end of the page (UX spec 3.9). A row
  // hides itself when the caller's permission answer denies it, and the zone hides with no row.
  const dangerZone = element(
    "section",
    { className: "section danger-zone", "aria-labelledby": "danger-zone-title" },
    element("h2", { id: "danger-zone-title" }, "Danger zone"),
    element(
      "div",
      { className: "card card--danger danger-zone-card" },
      stopPanel.section,
      deletion.section,
    ),
  );
  function showDeleting({ focus = false } = {}) {
    deleting = true;
    headerActions.replaceChildren(
      element("span", { className: "badge", "data-tone": "warning" }, "Deleting"),
    );
    view.classList.remove("agent-detail-pending", "agent-logs-opening");
    // A deleting Agent can no longer be stopped; its deletion row is all the page shows.
    stopPanel.section.remove();
    view.replaceChildren(dangerZone);
    deletion.showOnPage({ focus });
    context.revealed?.();
  }
  if (deleting) {
    showDeleting();
    return agent;
  }
  const selector = element("section", { className: "agent-card revision-selector" });
  const content = element("div");
  const detailPane = element("div", { className: "agent-version-detail" });
  const detailHeading = element("div", { className: "agent-version-heading" });
  const versionEvidence = element("div", { className: "version-evidence" });
  // The selected version's heading, record and (on a draft) its next step sit beside the Versions
  // rail; the tabs and open tab run full width below both (UX spec 3.7). Under 1100 px the summary
  // comes first, so a draft's Deploy is on the first screen of a phone too.
  const versionSummary = element("div", { className: "agent-version-summary" });
  // Known from the address, not from what has loaded, so the tabs never jump as reads land: a
  // draft's next step or a version's record fills the summary and the tabs run full width below;
  // with only a heading (Logs, Workspace files, Access on a version) the tab sits beside the rail.
  function setLayoutShape() {
    versionLayout.dataset.summary =
      selected === "draft" || !["workspace", "logs", "access"].includes(selectedTab)
        ? "full"
        : "heading";
    // Stacked, a draft's next step leads the rail, so its Deploy is on a phone's first screens.
    versionLayout.toggleAttribute("data-draft", selected === "draft");
  }
  const versionLayout = element(
    "div",
    { className: "agent-version-layout" },
    selector,
    versionSummary,
    detailPane,
  );
  setLayoutShape();
  // The stand-in has the folded panel's one row, so the panel that replaces it moves nothing
  // when the bounded reveal shows the page before the latest record is read (finding 2163).
  const deploymentStatus = element(
    "section",
    { className: "deployment-status deployment-evidence", "aria-label": "Deployment activity" },
    element(
      "p",
      { className: "deployment-evidence-loading muted" },
      "Loading the most recent visible deployment…",
    ),
  );
  const tabControls = new Map<string, HTMLButtonElement>();
  const revisionControls = new Map<VersionControl, boolean>();
  // A refused leave says why beside the control whose request holds the page (finding 1962).
  // The configuration, channels and repositories editors write their block into their own
  // feedback; every other hold writes it here.
  const leaveNote = statusBlock("info", null, null);
  let leaveNoteText: string | null = null;
  // The authentication form, whose save holds the page from the Credentials tab.
  let authenticationLeaveAnchor: HTMLElement | null = null;
  function showLeaveNote(
    anchor: Element | null,
    text: string | null,
    place: "start" | "end" | "after",
  ) {
    if (!anchor?.isConnected || !text) {
      return;
    }
    const placed =
      place === "end"
        ? anchor.lastElementChild === leaveNote
        : place === "start"
          ? anchor.firstElementChild === leaveNote
          : anchor.nextElementSibling === leaveNote;
    leaveNoteText = text;
    if (placed) {
      setAnnouncedText(leaveNote, text);
      return;
    }
    if (place === "end") {
      anchor.append(leaveNote);
    } else if (place === "start") {
      anchor.prepend(leaveNote);
    } else {
      anchor.after(leaveNote);
    }
    announceAfterShown(leaveNote, text);
  }
  // A tab without its own editor feedback shows its block at the top of the tab panel.
  const showBlockInPanel = () => showLeaveNote(content, draftEditorNavigationBlock, "start");
  let showDraftEditorNavigationBlock = showBlockInPanel;
  // Why the page holds, for each write in flight; editor blocks name their own.
  function leaveReason() {
    if (!draftEditorBlocksNavigation()) {
      return sharingWrite ? "This page stays open until sharing finishes." : null;
    }
    if (deployInFlight) {
      return "This page stays open until the deploy request finishes.";
    }
    if (refreshingDraft) {
      return "This page stays open until the draft finishes updating.";
    }
    if (authenticationSaveState === "saving") {
      return "This page stays open until the authentication save finishes.";
    }
    if (activeCredentials?.isSaving()) {
      return "This page stays open until the channel Secret bindings save finishes.";
    }
    return draftEditorNavigationBlock;
  }
  function showLeaveBlock() {
    const reason = leaveReason();
    if (deleting) {
      // Delete replaced the page, editors and tab panel included, with its deletion row: a
      // write still in flight says why above that row (finding 2125).
      showLeaveNote(view, reason, "start");
      if (leaveNote.isConnected) {
        leaveNote.scrollIntoView({ block: "nearest" });
      }
    } else if (!draftEditorBlocksNavigation()) {
      showLeaveNote(content, reason, "start");
      // The note tops the tab panel, which may be scrolled out of view; focus stays put.
      if (leaveNote.isConnected) {
        leaveNote.scrollIntoView({ block: "nearest" });
      }
    } else if (deployInFlight) {
      showLeaveNote(versionSummary.querySelector(":scope > .agent-draft-actions"), reason, "end");
    } else if (refreshingDraft) {
      // A refresh replaces the draft actions card mid-hold; the tab panel stays until it ends.
      showLeaveNote(content, reason, "start");
    } else if (authenticationSaveState === "saving") {
      showLeaveNote(authenticationLeaveAnchor, reason, "end");
    } else if (activeCredentials?.isSaving()) {
      showLeaveNote(activeCredentials.section, reason, "after");
    } else {
      showDraftEditorNavigationBlock();
    }
  }
  function draftEditorBlocksNavigation() {
    if (deleting) {
      // The editors went with Delete, so their unsaved changes no longer hold the page; a write
      // in flight still does.
      return draftWriteInFlight();
    }
    return (
      selected === "draft" &&
      (deployInFlight ||
        refreshingDraft ||
        authenticationSaveState === "saving" ||
        activeCredentials?.isSaving() ||
        (["configuration", "plugins", "repositories", "channels"].includes(selectedTab) &&
          draftEditorNavigationBlock))
    );
  }
  // A write in flight, whose answer only this page can handle: the sidebar and Back wait for it
  // too (finding 1937). An uncertain or stale editor is kept as a draft, so they may leave it.
  // `rereads` counts the draft's reread after a save as one.
  function draftWriteInFlight({ rereads = true } = {}) {
    return (
      selected === "draft" &&
      (deployInFlight ||
        (rereads && refreshingDraft) ||
        authenticationSaveState === "saving" ||
        activeCredentials?.isSaving() ||
        (["configuration", "plugins", "repositories", "channels"].includes(selectedTab) &&
          draftEditorSaving))
    );
  }
  function trackRevisionControl(control: VersionControl) {
    revisionControls.set(control, control.disabled);
  }
  function updateNavigationControls() {
    // The note goes once the hold it explained ends or changes; the next refusal says why anew.
    if (leaveNoteText !== null && leaveReason() !== leaveNoteText) {
      cancelAnnouncement(leaveNote);
      leaveNote.remove();
      leaveNoteText = null;
    }
    const blocked = Boolean(draftEditorBlocksNavigation());
    for (const [id, control] of tabControls) {
      control.disabled = blocked && id !== selectedTab;
      // A disabled tab cannot hold the list's one Tab stop.
      if (blocked) {
        control.tabIndex = id === selectedTab ? 0 : -1;
      }
    }
    for (const [control, originallyDisabled] of revisionControls) {
      control.disabled = blocked || sharingWrite || originallyDisabled;
    }
  }
  // A tab list (UX plan C7): one Tab stop on the selected tab, Left/Right (and Home/End) move
  // focus between tabs, Enter or Space opens one. Opening still changes the URL's `tab=`.
  const tabIds = `agent-tabs-${crypto.randomUUID()}`;
  const tabs = element("div", {
    className: "agent-tabs",
    role: "tablist",
    "aria-label": "Agent configuration views",
  });
  content.id = `${tabIds}-panel`;
  content.setAttribute("role", "tabpanel");
  content.setAttribute("aria-labelledby", `${tabIds}-${selectedTab}`);
  for (const [id, label] of tabLabels) {
    const control = button(
      label,
      () => {
        if (id === selectedTab) {
          return;
        }
        if (draftEditorBlocksNavigation()) {
          showLeaveBlock();
          return;
        }
        change(selected, id);
      },
      {
        id: `${tabIds}-${id}`,
        role: "tab",
        "aria-controls": content.id,
        "aria-selected": String(id === selectedTab),
        tabindex: id === selectedTab ? "0" : "-1",
      },
    );
    tabControls.set(id, control);
    tabs.append(control);
  }
  tabs.addEventListener("keydown", (event) => {
    const enabled = [...tabControls.values()].filter(
      (control) => !control.disabled && !control.hidden,
    );
    const at = enabled.findIndex((control) => control === document.activeElement);
    const next = {
      ArrowLeft: at - 1,
      ArrowRight: at + 1,
      Home: 0,
      End: enabled.length - 1,
    }[event.key];
    if (at === -1 || next === undefined || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    event.preventDefault();
    const control = enabled[(next + enabled.length) % enabled.length];
    if (!control) {
      return;
    }
    for (const other of tabControls.values()) {
      other.tabIndex = other === control ? 0 : -1;
    }
    // focus() leaves a partly visible tab where it is; scrolling it into view honours the strip's
    // scroll padding, so the tab and its ring clear the faded edge.
    control.focus({ preventScroll: true });
    control.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
  // Tabbing back in lands on the selected tab, wherever the arrows left focus. Checked once focus
  // has moved: a window losing focus leaves it on the tab, so the arrowed-to stop stays.
  tabs.addEventListener("focusout", () => {
    queueMicrotask(() => {
      if (!tabs.contains(document.activeElement)) {
        for (const [id, control] of tabControls) {
          control.tabIndex = id === selectedTab ? 0 : -1;
        }
      }
    });
  });
  // On a narrow screen the strip scrolls sideways; an edge with more tabs past it fades.
  const fadeTabEdges = () => {
    tabs.toggleAttribute("data-more-before", tabs.scrollLeft > 0);
    tabs.toggleAttribute(
      "data-more-after",
      tabs.scrollLeft + tabs.clientWidth < tabs.scrollWidth - 1,
    );
  };
  tabs.addEventListener("scroll", fadeTabEdges, { passive: true });
  versionSummary.append(detailHeading, versionEvidence);
  detailPane.append(tabs, content);
  const nativeAdmin = renderNativeAdminAccess(context, path, () =>
    latestPermissionsRead.then((permissions) => permissions?.administer),
  );
  const recovery = createDeploymentRecovery(context, {
    path,
    selected,
    isDeleting: () => deleting,
    refresh: renderLatestDeployment,
    versionLink,
  });
  const overviewStatus = element(
    "div",
    { className: "agent-overview-status" },
    statCard,
    statusLine,
    deploymentStatus,
  );
  view.replaceChildren(recovery.section, nativeAdmin.section, overviewStatus, versionLayout);
  // Recovery or native administration can appear above the facts. Keep the Agent heading and
  // controls in place, then reveal the overview once its first deployment reads settle.
  // The bounded wait still exposes loading, refresh and the version controls on a slow read.
  view.classList.add("agent-detail-pending");
  // Set once the page shows (after any minimum loading time), whether its first deployment
  // record is in or the wait ran out.
  let detailShown = false;
  let markRevealed: () => void;
  const revealed = new Promise<void>((resolve) => {
    markRevealed = resolve;
  });
  // A Logs entry that scrolls to its output also waits for that output (within the same bound)
  // and scrolls in the frame that reveals the page, never at the top first (finding 1552).
  let revealHold: Promise<void> | null = null;
  let scrollOnReveal: (() => void) | null = null;
  // Brings the version's detail (tab strip and open tab) to the top of the window; the heading
  // and record sit above it beside the Versions rail (UX spec 3.7). A
  // click in the shown page scrolls smoothly unless the reader asked for reduced motion; a page
  // about to show scrolls at once, so it never paints at the top first (findings 1552, 1586).
  function scrollToVersionDetail({ animate = false } = {}, node: Element = detailPane) {
    const smooth = animate && !globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    node.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "instant" });
  }
  function openVersionDetail({
    deploy = false,
    edit = false,
    ...options
  }: { animate?: boolean; deploy?: boolean | undefined; edit?: boolean | undefined } = {}) {
    // Edit current Configuration opens the draft with its Configuration editor open, in view and
    // focused. It switched to the draft at the top of the page, and the editor still needed an
    // Edit Configuration click far below (finding 2061).
    // A draft restored with unsaved edits is already in the editor; otherwise its Edit
    // Configuration button opens it.
    const editorTarget = () =>
      detailPane.querySelector<HTMLTextAreaElement>("#configuration-json") ??
      detailPane.querySelector<HTMLButtonElement>('button[data-opens="configuration-editor"]');
    const editStart = edit ? editorTarget() : null;
    if (edit && !editStart && !detailLoadFinished) {
      const tab = selectedTab;
      void Promise.resolve(details).then(
        () => {
          const focused = document.activeElement;
          if (
            context.isCurrent() &&
            !deleting &&
            selectedTab === tab &&
            (!focused || focused === document.body || focused === tabControls.get(tab)) &&
            editorTarget()
          ) {
            openVersionDetail({ ...options, edit });
          }
        },
        () => {},
      );
    }
    if (editStart && !editStart.disabled) {
      // Entering the editor focuses it without scrolling; the editor is then brought into view.
      if (editStart.id === "configuration-json") {
        editStart.focus({ preventScroll: true });
      } else {
        editStart.click();
      }
      const field = detailPane.querySelector("#configuration-json")?.closest(".form-field");
      if (field) {
        // The draft's "New version" notice comes to the top with the editor below it, so the
        // screen says this is now the draft (finding 2086). When the notice is too far above for
        // the editor's label and first lines (about 160 px) to show too, the editor comes to the
        // top instead.
        const notice = detailPane.querySelector(".version-selection-notice");
        const below = notice
          ? field.getBoundingClientRect().top - notice.getBoundingClientRect().top
          : -1;
        scrollToVersionDetail(
          options,
          notice && below >= 0 && below + 160 <= window.innerHeight ? notice : field,
        );
        return;
      }
    }
    // Deploy again opens the draft at its deploy step, whose card can end below a phone's
    // fold when the version detail is at the top: the card is brought to the top, with its
    // Deploy new version focused when the reader can press it (finding 1898).
    const actions = deploy ? versionSummary.querySelector(":scope > .agent-draft-actions") : null;
    if (deploy && !actions && !detailLoadFinished) {
      // The card is built once the draft's own reads land: open it then, unless the reader has
      // moved on (another tab, or focus taken elsewhere) in the meantime.
      const tab = selectedTab;
      void Promise.resolve(details).then(
        () => {
          const focused = document.activeElement;
          if (
            context.isCurrent() &&
            !deleting &&
            selectedTab === tab &&
            (!focused || focused === document.body || focused === tabControls.get(tab)) &&
            versionSummary.querySelector(":scope > .agent-draft-actions")
          ) {
            openVersionDetail({ ...options, deploy });
          }
        },
        () => {},
      );
    }
    const deployButton = actions?.querySelector<HTMLButtonElement>("button.primary");
    if (deployButton && !deployButton.disabled) {
      deployButton.focus({ preventScroll: true });
    } else {
      tabControls.get(selectedTab)?.focus({ preventScroll: true });
    }
    scrollToVersionDetail(options, actions ?? detailPane);
  }
  // Opened by a recovery link: show its tab once this page shows. Logs waits for its output
  // first and scrolls itself.
  const linkedOnLoad = takeLinkedVersionView(linkedKey());
  if (linkedOnLoad && selectedTab !== "logs") {
    scrollOnReveal = () => {
      scrollOnReveal = null;
      if (context.isCurrent() && !deleting) {
        openVersionDetail({ deploy: linkedOnLoad.deploy, edit: linkedOnLoad.edit });
      }
    };
  }
  // A page restored for Back mounts at its old scroll position.
  context.onResume?.(() => {
    const linked = takeLinkedVersionView(linkedKey());
    if (linked && !deleting) {
      openVersionDetail({ deploy: linked.deploy, edit: linked.edit });
    }
  });
  function showDetail() {
    clearTimeout(revealTimer);
    const shown = () => {
      // A note already empty gives its line back before the page first shows; one still loading
      // keeps it, so the outcome that empties it moves nothing (finding 2163).
      if (!detailShown && !latestDeploymentNote.textContent) {
        latestDeploymentNote.classList.remove("stat-help-line");
      }
      detailShown = true;
      if (view.classList.contains("agent-detail-pending")) {
        view.classList.remove("agent-detail-pending");
      }
      scrollOnReveal?.();
      markRevealed();
    };
    // An Agent opened from the list shows this page in place of the list only now (finding 1516).
    // A loading page that has just appeared in its place stays a moment longer (finding 1587), so
    // the page counts as shown, and scrolls, once it replaced the stand-in.
    if (context.revealed) {
      context.revealed(shown);
    } else {
      shown();
    }
  }
  // The overview's first reads settled.
  function revealDetail() {
    if (revealHold) {
      void revealHold.then(showDetail);
    } else {
      showDetail();
    }
  }
  const revealTimer = setTimeout(showDetail, FIRST_ACTIVITY_WAIT_MS);
  function revealSelectedTab() {
    const strip = tabs.getBoundingClientRect();
    // A tab that has focus (moved there with the arrows) stays in view over the selected one.
    const shown = tabs.contains(document.activeElement)
      ? document.activeElement
      : tabControls.get(selectedTab);
    if (!shown) {
      return;
    }
    const bounds = shown.getBoundingClientRect();
    if (bounds.left < strip.left) {
      tabs.scrollLeft += Math.floor(bounds.left - strip.left);
    } else if (bounds.right > strip.right) {
      tabs.scrollLeft += Math.ceil(bounds.right - strip.right);
    }
  }
  const tabResize = new ResizeObserver(() => {
    if (!context.isCurrent() || !tabs.isConnected) {
      tabResize.disconnect();
      return;
    }
    revealSelectedTab();
    fadeTabEdges();
  });
  tabResize.observe(tabs);
  // Detached views stop observing; Back's retained view re-arms the strip.
  context.onResume?.(() => {
    if (tabs.isConnected) {
      tabResize.observe(tabs);
    }
  });
  let details: Promise<DetailsResult> | null = null;
  // The details read that has settled, so a tab rebuilt from it shows no loading text.
  let settledDetails: Promise<DetailsResult> | null = null;
  const retainedTabs = new Map<string, MountedTab>();
  let mountedTab: MountedTab | null = null;
  // The Access tab's sharing panel, built the first time the tab opens.
  let accessPanel: ReturnType<typeof renderAgentAccess> | null = null;
  // Replaces an Access tab whose policy read was refused with Configuration, in place, once the
  // page shows (a page still behind its loading stand-in would rebuild instead) and the
  // navigation that opened the tab has finished.
  function leaveDeniedAccess({ refocus = false } = {}) {
    void revealed.then(() => {
      if (selectedTab === "access" && context.isCurrent() && !deleting) {
        context.navigate(target(selected, "configuration"), namespaceId, true);
      }
      if (refocus && context.isCurrent() && document.activeElement === document.body) {
        tabControls.get(selectedTab)?.focus({ preventScroll: true });
      }
    });
  }
  // Shown once by the tab a draft refresh rebuilds after a save (finding 1445).
  let savedNotice = "";
  let activityPanel = deploymentStatus;
  let activityRevisionId: string | null | undefined;
  let viewedSnapshot: Snapshot | null = null;
  let detailLoadFinished = false;
  let latestRevisionResult: RevisionResult | null = null;
  let latestDeploymentStatus: DeploymentOutcome | null = null;
  let latestDeploymentUnavailable = false;
  let latestDeploymentRecord: AgentDeploymentStatusWire | null = null;
  // Whether the newest version's panel last failed to refresh the Agent or its versions.
  let latestOverviewUnavailable = false;
  // The newest version's status from its last record read; a failed read keeps it, so one
  // failure does not relabel a deploying version Historical (finding 2085).
  let latestRecordedStatus: DeploymentOutcome | null = null;
  // Set when the Agent reread after a completed deployment failed, until an Agent read lands.
  let agentRereadFailed = false;
  let versionRecord: ReturnType<typeof createVersionDeploymentEvidence> | null = null;
  const revisionsPromise = readRevisionPage(request, path).then(revisionsForPage);
  // Every revision summary listed so far, from the newest page and from older pages the viewer
  // asked for. Summaries never change, and a revision appears once however pages shift.
  const listedRevisions = new Map<string, Revision>();
  // Whether an older page was loaded, and the cursor for the next one (null once complete).
  let olderPageLoaded = false;
  let olderCursor: string | null = null;
  let olderLoading = false;
  let olderError: unknown = null;
  // The newest revision with its saved settings, read only when a check needs them.
  let latestRevisionDetail: AgentRevisionRead | null = null;
  let latestRevisionDetailReading: string | null = null;

  function versionNotice() {
    return selected === "draft"
      ? selectedTab === "plugins"
        ? // Plugin selections are Agent settings: a caller who may not save them reads them.
          agentReadOnly()
          ? READ_ONLY_DRAFT_NOTICE
          : "Plugin changes to this Agent appear in the next deployment. Existing versions stay unchanged."
        : draftReadOnly()
          ? READ_ONLY_DRAFT_NOTICE
          : "New version. Changes affect future deployments using this Configuration. Admitted versions stay unchanged."
      : selected === currentRevisionId
        ? "Current version · read-only admitted snapshot."
        : deployingRevision()?.id === selected
          ? "Deploying version · read-only admitted snapshot. It becomes the current version only if its deployment completes."
          : deployedRevision()?.id === selected
            ? "Deployed version · read-only admitted snapshot. Its deployment completed, but the current version could not be refreshed."
            : // A failed version that is not current is not history: after a failed first
              // deployment it was the only version and was called "Historical" (finding 2403).
              failedVersions.has(failedVersionKey(path, selected))
              ? "Failed version · read-only admitted snapshot. Its deployment did not complete."
              : "Historical version · read-only admitted snapshot. Browsing it does not change the current version.";
  }

  // The newest version while its deployment is queued or running and it is not yet current. Right
  // after Deploy new version it was called "Historical" beside "Selected version v1" (finding 2065).
  function deployingRevision() {
    const latest = visibleRevisions[0];
    return latest &&
      latest.id !== currentRevisionId &&
      activityRevisionId === latest.id &&
      deploymentPending(latestRecordedStatus)
      ? latest
      : null;
  }

  // The newest version once its deployment completed, while the Agent reread that would make it
  // current failed. It is not Deploying beside "Completed" (finding 2085), nor Historical: the
  // page cannot yet tell. Only that failed reread says so; a stopped Agent's last version, say,
  // also has a completed record and no current version, and stays Historical, as does one under
  // a known newer current version the viewer cannot read.
  function deployedRevision() {
    const latest = visibleRevisions[0];
    return latest &&
      latest.id !== currentRevisionId &&
      activityRevisionId === latest.id &&
      latestRecordedStatus === "succeeded" &&
      agentRereadFailed &&
      !revisionHidden(currentRevisionId)
      ? latest
      : null;
  }

  function renderVersionNotice() {
    const notice = content.querySelector(".version-selection-notice");
    if (notice) {
      // Deployment polls call this too; an unchanged notice is left untouched.
      setText(notice, versionNotice());
    }
  }

  function renderDetailHeading() {
    detailHeading.hidden = false;
    // An Agent-wide tab's heading introduces the tab below it; a version's heading leads the
    // summary beside the Versions rail.
    const agentWide = ["access", "workspace"].includes(selectedTab);
    if (agentWide && detailHeading.parentElement !== detailPane) {
      detailPane.prepend(detailHeading);
    } else if (!agentWide && detailHeading.parentElement !== versionSummary) {
      versionSummary.prepend(detailHeading);
    }
    if (selectedTab === "access") {
      detailHeading.replaceChildren(
        element(
          "div",
          {},
          element("h2", {}, "Agent access"),
          element(
            "p",
            { className: "muted" },
            "Sharing applies to the whole Agent, not to one version.",
          ),
        ),
      );
      return;
    }
    if (selectedTab === "workspace") {
      detailHeading.replaceChildren(
        element(
          "div",
          {},
          element("h2", {}, "Agent workspace"),
          element(
            "p",
            { className: "muted" },
            "Workspace files are live Agent data, not part of a version snapshot.",
          ),
        ),
      );
      return;
    }
    // A draft's next-step card names it and its Configuration, so the heading steps aside for it
    // (UX spec 3.7).
    if (selected === "draft" && versionSummary.querySelector(":scope > .agent-draft-actions")) {
      detailHeading.replaceChildren();
      detailHeading.hidden = true;
      return;
    }
    const snapshot = viewedSnapshot;
    const heading = element(
      "div",
      {},
      element(
        "span",
        { className: "eyebrow" },
        selected === "draft" ? "Editable Configuration" : "Immutable snapshot",
      ),
      element(
        "h2",
        // A read that settles within 250 ms never shows its loading text (finding 1449).
        selected !== "draft" && !snapshot && !detailLoadFinished
          ? { className: "delayed-status" }
          : {},
        selected === "draft"
          ? "Create new version"
          : snapshot && "revision" in snapshot
            ? `Version v${snapshot.revision}`
            : detailLoadFinished
              ? "Version unavailable"
              : "Loading version details…",
      ),
    );
    if (snapshot) {
      if (selected !== "draft") {
        heading.append(element("p", { className: "resource-id" }, snapshot.id));
      }
      if (!("configurationReadError" in snapshot)) {
        const draft = "generation" in snapshot;
        heading.append(
          element(
            "p",
            { className: "muted" },
            `${draft ? "Configuration" : "Source Configuration"} ${draft ? snapshot.id : snapshot.configurationId} · generation ${draft ? snapshot.generation : snapshot.configurationGeneration}`,
          ),
        );
      }
    }
    detailHeading.replaceChildren(
      heading,
      ...(selected !== "draft" &&
      currentRevisionId &&
      selected !== currentRevisionId &&
      visibleRevisions.some((revision) => revision.id === currentRevisionId)
        ? [
            button(
              "View current version",
              () => currentRevisionId && change(currentRevisionId, "configuration"),
            ),
          ]
        : []),
    );
  }

  // The rail's version buttons by revision ID, for the outcome badge the latest one carries.
  const versionControls = new Map<
    string,
    { control: HTMLButtonElement; line: HTMLElement; label: string }
  >();
  // Each rail control's key (a revision ID, "new", "older" or "chooser"), so a rebuild of the
  // rail gives focus back to the same control instead of dropping it to the page (finding 2115).
  let railFocusKeys = new Map<VersionControl, string>();
  // The revisions the rail last listed, not counting a viewed version shown on its own below
  // them: where the loaded pages ended.
  let listedRevisionIds = new Set<string>();
  // A version's own deployment outcome beside its number (finding 2095): the rail knows the
  // latest version's record, so a failed or deploying latest version is marked; the others have
  // no record read here and stay plain. The rail may show before that record is read, so the
  // badge is set in place.
  function markVersionOutcomes() {
    // The badge uses the page's outcome words (finding 2093).
    const status = latestDeploymentStatus;
    const tone = status && status !== "succeeded" && DEPLOYMENT_OUTCOME_TONES[status];
    const outcome = tone && [outcomeLabel(status), tone];
    const failed = [outcomeLabel("failed"), DEPLOYMENT_OUTCOME_TONES.failed];
    for (const [id, { control, line, label }] of versionControls) {
      const [text, tone] =
        (id === activityRevisionId
          ? outcome
          : failedVersions.has(failedVersionKey(path, id)) && failed) || [];
      const shown = line.querySelector<HTMLElement>(".version-outcome");
      if (
        (shown?.textContent ?? "") === (text ?? "") &&
        (shown?.dataset.tone ?? "") === (tone ?? "")
      ) {
        continue;
      }
      shown?.remove();
      if (text) {
        line.append(
          " ",
          element("span", { className: "badge version-outcome", "data-tone": tone }, text),
        );
      }
      const name = text ? `${label}, deployment ${text.toLowerCase()}` : label;
      if (control.getAttribute("aria-label") !== name) {
        control.setAttribute("aria-label", name);
      }
    }
  }
  // The Versions list's draft entry and chooser option. When Agent-side saves would be refused
  // they do not call the draft a new version (findings 2405, 2441); without Configuration update,
  // the Configuration is read-only (finding 2421). The permission answer can land after the list
  // is built, so its callback labels them again.
  function labelDraftEntry() {
    const [title, detail, name, option] = agentReadOnly()
      ? [
          "Version draft",
          configurationReadOnly() ? "Read-only Configuration" : "Configuration draft",
          "View version draft",
          "Version draft",
        ]
      : configurationReadOnly()
        ? [
            "New version",
            "Read-only Configuration",
            "View new version, read-only Configuration",
            "New version · read-only Configuration",
          ]
        : [
            "New version",
            "Editable Configuration",
            "View new version, editable Configuration",
            "New version · editable Configuration",
          ];
    const entry = selector.querySelector(".revision-create");
    entry?.setAttribute("aria-label", name);
    entry?.replaceChildren(element("strong", {}, title), element("small", {}, detail));
    const choice = selector.querySelector("#revision-selector option[value=draft]");
    if (choice) {
      choice.textContent = option;
    }
  }
  function renderVersions(
    revisions: Revision[],
    snapshot: Snapshot | null,
    historyError: unknown = null,
  ) {
    const focusKey = [...railFocusKeys].find(
      ([control]) => control === document.activeElement,
    )?.[1];
    const listedBefore = listedRevisionIds;
    listedRevisionIds = new Set(revisions.map((revision) => revision.id));
    // The rebuilt list keeps the reader's scroll position.
    const listScroll = selector.querySelector(".version-list")?.scrollTop ?? 0;
    railFocusKeys = new Map();
    revisionControls.clear();
    versionControls.clear();
    // Opening the draft is navigation. Saving a Configuration and deploying have their own permissions.
    // The draft is an entry in the list, named as the chooser below names it, not a second
    // "Create new version": the page header holds that action (finding 2403).
    const newVersion = button("", () => change("draft", "configuration"), {
      className: "revision-create",
      ...(selected === "draft" ? { "aria-current": "page" } : {}),
    });
    trackRevisionControl(newVersion);
    railFocusKeys.set(newVersion, "new");
    // The versions, the viewed one included, are one Tab stop (finding 2101), so the list is a
    // vertical toolbar: screen readers announce it as one control that the arrows move through.
    const list = element("div", {
      className: "version-list",
      role: "toolbar",
      "aria-orientation": "vertical",
      "aria-label": "Versions",
    });
    const items = [];
    for (const revision of revisions) {
      const label = `View version v${revision.revision}${revision.id === currentRevisionId ? ", current version" : ""}`;
      const control = button("", () => change(revision.id, "configuration"), {
        className: "version-item",
        "aria-label": label,
        ...(selected === revision.id ? { "aria-current": "page" } : {}),
      });
      // The current version's badge follows its number on the same line, after a space.
      const line = element(
        "span",
        {},
        element("strong", {}, `v${revision.revision}`),
        ...(revision.id === currentRevisionId
          ? // Current means only that OCC selected this version; it can be stopped or failed
            // (finding 1969), so the badge marks it without claiming health.
            [" ", element("span", { className: "badge", "data-tone": "info" }, "Current")]
          : []),
      );
      control.append(line, element("small", {}, displayDate(revision.createdAt)));
      versionControls.set(revision.id, { control, line, label });
      railFocusKeys.set(control, revision.id);
      trackRevisionControl(control);
      items.push(control);
      list.append(control);
    }
    if (selected !== "draft" && !revisions.some((revision) => revision.id === selected)) {
      if (snapshot && "revision" in snapshot) {
        const control = button("", () => change(selected, "configuration"), {
          className: "version-item",
          "aria-label": `View version v${snapshot.revision}`,
          "aria-current": "page",
        });
        control.append(
          element("strong", {}, `v${snapshot.revision}`),
          element("small", {}, "Viewed version"),
        );
        railFocusKeys.set(control, selected);
        trackRevisionControl(control);
        items.push(control);
        list.append(control);
      } else {
        list.append(
          element(
            "div",
            { className: "version-item version-unavailable" },
            "Viewed version unavailable",
          ),
        );
      }
    }
    const focusVersion = rovingVersions(list, items);
    // Versions list one page at a time, newest first; older pages load on request. The button
    // follows the list rather than sitting in it: it loads versions, it is not one, so the arrows
    // stay on versions and Tab reaches it next (finding 2115). While loading it keeps focus.
    let older = null;
    if (olderCursor && !historyError) {
      older = button(
        olderLoading ? "Loading older versions…" : "Show older versions",
        () => void loadOlderRevisions(),
        {
          className: "version-item version-older",
          ...(olderLoading ? { "aria-disabled": "true", "aria-busy": "true" } : {}),
        },
      );
      trackRevisionControl(older);
      railFocusKeys.set(older, "older");
    }
    const chooser = element(
      "select",
      { id: "revision-selector" },
      element("option", { value: "draft" }),
      ...revisions.map((revision) =>
        element(
          "option",
          { value: revision.id },
          `v${revision.revision} · ${displayDate(revision.createdAt)}`,
        ),
      ),
    );
    if (selected !== "draft" && !revisions.some((revision) => revision.id === selected)) {
      chooser.append(
        element(
          "option",
          { value: selected, disabled: !snapshot },
          snapshot && "revision" in snapshot
            ? `v${snapshot.revision} · Viewed version`
            : "Viewed version unavailable",
        ),
      );
    }
    chooser.value = selected;
    railFocusKeys.set(chooser, "chooser");
    chooser.addEventListener("change", () => {
      const nextRevision = chooser.value;
      if (draftEditorBlocksNavigation() || sharingWrite) {
        chooser.value = selected;
        showLeaveBlock();
        return;
      }
      change(nextRevision, "configuration");
    });
    trackRevisionControl(chooser);
    selector.replaceChildren(
      ...[
        element("h2", {}, "Versions"),
        element("p", { className: "muted" }, "Choose a version to inspect its saved details."),
        newVersion,
        list,
        older,
        olderError
          ? statusBlock("danger", null, `Older versions unavailable. ${message(olderError)}`)
          : null,
        revisions.length || selected !== "draft"
          ? element("label", { for: "revision-selector" }, "Available versions")
          : null,
        revisions.length || selected !== "draft" ? chooser : null,
        historyError
          ? statusBlock("danger", null, `Version history unavailable. ${message(historyError)}`)
          : null,
        !historyError && !revisions.length
          ? element(
              "p",
              { className: "muted" },
              // A current version, or a deploy that set the Agent running, means versions
              // exist and are hidden. A stopped Agent may have versions too; the record cannot say.
              currentRevisionId || currentRuntimeState === "running"
                ? "No readable versions. This Agent has versions your access does not include. Ask an Agent administrator for read access to them."
                : "No readable versions. Creating an Agent alone does not create a version; if this Agent was deployed before, your access does not include its versions.",
            )
          : null,
      ].filter((child) => child !== null),
    );
    labelDraftEntry();
    updateNavigationControls();
    list.scrollTop = listScroll;
    // A rebuild while the reader is in the rail (a poll that lands an outcome, or older versions
    // loading) keeps focus on the same control. Once every older version is shown, focus goes to
    // the first one that just loaded, below those listed before (a poll may add a newer one
    // meanwhile; the viewed version shown on its own does not count), else the last version. A version no longer listed gives focus to the list's
    // Tab stop.
    if (focusKey !== undefined && !selector.contains(document.activeElement)) {
      const usable = items.filter((item) => !item.disabled);
      const wasListed = (item: VersionControl) => listedBefore.has(railFocusKeys.get(item) ?? "");
      const lastShown = usable.map(wasListed).lastIndexOf(true);
      const target =
        [...railFocusKeys].find(([control, key]) => key === focusKey && !control.disabled)?.[0] ??
        (focusKey === "older"
          ? (usable.find((item, index) => index > lastShown && !wasListed(item)) ?? usable.at(-1))
          : ["new", "chooser"].includes(focusKey)
            ? undefined
            : (usable.find((item) => item.tabIndex === 0) ?? usable[0]));
      if (target instanceof HTMLButtonElement && items.includes(target)) {
        focusVersion(target);
        target.scrollIntoView({ block: "nearest" });
      } else {
        target?.focus({ preventScroll: true });
      }
    }
  }

  // Without a version list yet (still loading), its first render shows the new state.
  function updateCurrentAgent(
    next: unknown,
    revisionResult: RevisionResult | null,
    snapshot: Snapshot | null,
  ) {
    const freshAgent = agentForPage(next);
    // A read answered after deletion was shown has nothing left to update.
    if (deleting) {
      return;
    }
    if (freshAgent.status === "deleting") {
      showDeleting();
      return;
    }
    agentRereadFailed = false;
    const revisionChanged = freshAgent.activeRevisionId !== currentRevisionId;
    const workspaceAvailabilityChanged =
      Boolean(freshAgent.activeRevisionId) !== Boolean(currentRevisionId);
    const servingChanged =
      revisionChanged || freshAgent.desiredRuntimeState !== currentRuntimeState;
    currentRevisionId = freshAgent.activeRevisionId;
    currentRuntimeState = freshAgent.desiredRuntimeState;
    currentAgent = freshAgent;
    stopPanel.updateAgent(freshAgent);
    if (servingChanged) {
      renderLiveServing();
      retainedTabs.clear();
      if (mountedTab) {
        // Leaving must not put a tab built for the old serving state back in the cache.
        mountedTab.reusable = false;
        if (workspaceAvailabilityChanged && mountedTab.id === "workspace") {
          // Capture drafts and retire the old file controls now, not on the next tab visit.
          void renderTab();
        } else if (revisionChanged && mountedTab.id === "workspace") {
          // Another current version keeps the editors, so a reader typing keeps focus, caret
          // and edits; files without unsaved edits are reread from it (finding 1836).
          mountedTab.refresh?.();
        }
      }
      // Native admin access depends on the serving version, so a finished deployment rereads it.
      nativeAdmin.refresh();
    }
    if (revisionResult) {
      renderOverview(revisionResult, snapshot);
    } else {
      renderCurrentVersion();
    }
    renderDetailHeading();
    renderVersionNotice();
    versionRecord?.renderDiagnostics();
  }

  // The failed version the recovery block leads with, if any. The viewed version's record does
  // not repeat that version's error below it (finding 2368).
  let recoveryRevisionId: string | null = null;
  function showRecovery(failure: Parameters<typeof recovery.show>[0]) {
    recovery.show(failure);
    recoveryRevisionId = failure?.latest.id ?? null;
    versionRecord?.setFailureShownAbove(recoveryRevisionId === selected);
  }

  function renderLatestDeployment() {
    markVersionOutcomes();
    const latest = visibleRevisions[0];
    if (!latest) {
      showRecovery(null);
      delete latestDeploymentValue.dataset.outcome;
      if (latestRevisionResult) {
        const rejected = latestRevisionResult.status === "rejected";
        setText(latestDeploymentValue, rejected ? "Unavailable" : "None");
        setText(
          latestDeploymentNote,
          rejected ? "Version history could not be read." : "No readable deployments.",
        );
      } else {
        setDelayedText(latestDeploymentValue, "", "Loading…");
        setDelayedText(latestDeploymentNote, "", "Reading deployment history.");
      }
      const hidden = [selected, currentRevisionId].find(revisionHidden);
      setHidden(statusLine, hidden === undefined);
      setText(
        statusLine,
        hidden
          ? `You cannot read version ${shortId(hidden)}, so its progress and outcome are not shown here. ${readAccessHint}`
          : "",
      );
      setLiveServing(false);
      stopPanel.setNothingRunning(false);
      return;
    }
    stopPanel.setNothingRunning(latestDeploymentStatus === "failed" && !currentRevisionId);
    const label = latestDeploymentStatus ? outcomeLabel(latestDeploymentStatus) : undefined;
    // A superseded or stopped deployment is neutral: it raises no banner and says nothing about
    // serving.
    const neutral = latestDeploymentStatus === "superseded" || latestDeploymentStatus === "stopped";
    const current = visibleRevisions.find((revision) => revision.id === currentRevisionId);
    const currentLabel = current ? `v${current.revision}` : shortId(currentRevisionId ?? "");
    // The caller cannot read the current version, so it may be newer than every version shown.
    const currentHidden = currentRevisionId !== latest.id && revisionHidden(currentRevisionId);
    // The current version is not on the pages loaded so far, yet not known to be hidden either:
    // it may be on an older page or one the caller cannot read (finding 1477).
    const currentUnknown = Boolean(currentRevisionId) && !current && !currentHidden;
    // A succeeded deployment becomes current, so a different current version is newer.
    const newerHidden = latestDeploymentStatus === "succeeded" && currentHidden;
    // A failed deployment never becomes current, so a hidden current version may be newer or
    // older: the page cannot say whether that failure still matters (finding 1458).
    const failureBehindHidden = latestDeploymentStatus === "failed" && currentHidden;
    const failureBehindUnknown = latestDeploymentStatus === "failed" && currentUnknown;
    // Likewise a succeeded deployment behind an unlisted current version may be older than a
    // hidden newer one (finding 1485).
    const successBehindUnknown = latestDeploymentStatus === "succeeded" && currentUnknown;
    const requestedHidden = selected !== currentRevisionId && revisionHidden(selected);
    // Deploying a dedicated Agent stops the previous version's workload before the new
    // one starts, so a failed newer deployment usually leaves nothing serving.
    const replacementFailed =
      latestDeploymentStatus === "failed" &&
      currentRuntimeState === "running" &&
      current !== undefined &&
      current.revision < latest.revision &&
      latest.harness?.mode === "dedicated";
    // Embedded activation selects the new version before its gateway is ready, and that
    // gateway replaces the previous one, so a failed selected version is the only one left.
    const selectedFailed =
      latestDeploymentStatus === "failed" &&
      currentRuntimeState === "running" &&
      current !== undefined &&
      current.id === latest.id;
    // Each poll rereads the same record, so every text is written once with its final value.
    if (newerHidden) {
      setText(latestDeploymentValue, "Newer version hidden");
      setText(
        latestDeploymentNote,
        `You cannot read the current version. v${latest.revision} (${label}) is older.`,
      );
    } else if (!latestDeploymentStatus && !latestDeploymentUnavailable) {
      setDelayedText(latestDeploymentValue, `v${latest.revision} · `, "Loading…");
      setDelayedText(latestDeploymentNote, "", "Reading recorded deployment status.");
    } else {
      setDeploymentOutcome(
        latestDeploymentValue,
        `v${latest.revision}`,
        label ?? (latestDeploymentUnavailable ? "Unavailable" : "Loading…"),
        latestDeploymentStatus ? DEPLOYMENT_OUTCOME_TONES[latestDeploymentStatus] : undefined,
      );
      setText(
        latestDeploymentNote,
        neutral
          ? latestDeploymentStatus === "stopped"
            ? `${NEUTRAL_DEPLOYMENT_NOTES.stopped}. Deploy a new version when you want it running.`
            : `${NEUTRAL_DEPLOYMENT_NOTES.superseded}.`
          : latestDeploymentStatus
            ? ""
            : "Recorded deployment status could not be read.",
      );
    }
    const mayBeOffline = replacementFailed || selectedFailed;
    setLiveServing(mayBeOffline);
    const outcome = newerHidden ? "" : (latestDeploymentStatus ?? "");
    if (latestDeploymentValue.dataset.outcome !== outcome) {
      latestDeploymentValue.dataset.outcome = outcome;
    }
    const hiddenNotice = requestedHidden || newerHidden || failureBehindHidden;
    setHidden(statusLine, !hiddenNotice && !failureBehindUnknown && !successBehindUnknown);
    if (!statusLine.hidden) {
      setText(
        statusLine,
        [
          requestedHidden
            ? `Version ${shortId(selected)} was requested, but you cannot read it, so its progress and outcome are not shown here.`
            : null,
          newerHidden
            ? `The current version, ${shortId(currentRevisionId ?? "")}, is one you cannot read; v${latest.revision} is an older version.`
            : null,
          failureBehindHidden
            ? `The current version, ${shortId(currentRevisionId ?? "")}, is one you cannot read, so this page cannot tell whether the failed v${latest.revision} deployment affects it.`
            : null,
          failureBehindUnknown
            ? `The current version, ${shortId(currentRevisionId ?? "")}, is not among the versions listed, so this page cannot tell whether the failed v${latest.revision} deployment affects it.${olderCursor ? " Show older versions to check." : ""}`
            : null,
          successBehindUnknown
            ? `The current version, ${shortId(currentRevisionId ?? "")}, is not among the versions listed, so this page cannot tell whether it is newer than v${latest.revision}.${olderCursor ? " Show older versions to check." : ""}`
            : null,
          hiddenNotice ? readAccessHint : null,
        ]
          .filter(Boolean)
          .join(" "),
      );
    }

    // Recovery speaks for the current version, so it needs that version to be readable. It
    // waits for the caller's permission answer, which decides its draft link, so it never
    // shows a draft link the answer then withdraws (finding 1478). That read starts first, so
    // it has usually settled by now.
    const hideRecovery =
      latestDeploymentStatus !== "failed" ||
      currentHidden ||
      currentUnknown ||
      !callerPermissionsSettled;
    showRecovery(
      hideRecovery
        ? null
        : {
            latest,
            record: latestDeploymentRecord,
            agent: currentAgent,
            permissions: callerPermissions,
            currentLabel,
            servingImpact: replacementFailed
              ? "replacement-failed"
              : selectedFailed
                ? "selected-failed"
                : null,
            overviewUnavailable: latestOverviewUnavailable,
            activityPanel,
          },
    );
  }
  // List summaries omit the credential binding a revision was admitted with, so the
  // rejected-credential hint reads the newest revision once.
  async function readLatestRevisionDetail(revision: Revision) {
    if (latestRevisionDetail?.id === revision.id || latestRevisionDetailReading === revision.id) {
      return;
    }
    latestRevisionDetailReading = revision.id;
    try {
      const detail =
        viewedSnapshot && "revision" in viewedSnapshot && viewedSnapshot.id === revision.id
          ? viewedSnapshot
          : revisionForPage(
              await request(`${path}/revisions/${encodeURIComponent(revision.id)}`),
              revision.id,
            );
      if (!context.isCurrent() || deleting || visibleRevisions[0]?.id !== revision.id) {
        return;
      }
      latestRevisionDetail = detail;
      refreshDeployControls();
    } catch {
      // Without the detail the hint stays generic; the deployment status still shows.
    } finally {
      if (latestRevisionDetailReading === revision.id) {
        latestRevisionDetailReading = null;
      }
    }
  }

  async function loadOlderRevisions() {
    if (olderLoading || !olderCursor) {
      return;
    }
    olderLoading = true;
    olderError = null;
    if (latestRevisionResult) {
      renderOverview(latestRevisionResult, viewedSnapshot);
    }
    try {
      const page = revisionsForPage(await readRevisionPage(request, path, olderCursor));
      if (!context.isCurrent() || deleting) {
        return;
      }
      for (const revision of page.revisions) {
        listedRevisions.set(revision.id, revision);
      }
      olderPageLoaded = true;
      olderCursor = page.nextCursor;
    } catch (error) {
      if (!context.isCurrent() || deleting) {
        return;
      }
      if (requestFailure(error).status === 401) {
        context.onExpired();
        return;
      }
      olderError = error;
    } finally {
      olderLoading = false;
    }
    if (latestRevisionResult) {
      renderOverview(latestRevisionResult, viewedSnapshot);
    }
    renderDetailHeading();
  }

  function renderOverview(revisionResult: RevisionResult, snapshot: Snapshot | null) {
    latestRevisionResult = revisionResult;
    const newest = revisionResult.status === "fulfilled" ? revisionResult.value.revisions : [];
    // Until an older page is loaded, the newest page's cursor says whether older ones exist.
    // After that the older pages' own cursor continues, so a refresh never loses the place.
    if (!olderPageLoaded && revisionResult.status === "fulfilled") {
      olderCursor = revisionResult.value.nextCursor;
    }
    for (const revision of newest) {
      listedRevisions.set(revision.id, revision);
    }
    const revisions = [...listedRevisions.values()].sort((a, b) => b.revision - a.revision);
    visibleRevisions = revisions;
    visibleRevisionsLoaded = revisionResult.status === "fulfilled";
    stopPanel.setNoReadableVersions(visibleRevisionsLoaded ? revisions.length === 0 : null);
    const labels = new Map(revisions.map((revision) => [revision.id, `v${revision.revision}`]));
    stopPanel.setVersionLabel((id) => labels.get(id));
    renderCurrentVersion();
    renderVersions(
      revisions,
      snapshot,
      revisionResult.status === "rejected" ? revisionResult.reason : null,
    );
    const mostRecent = revisions[0];
    if (activityRevisionId !== (mostRecent?.id ?? null)) {
      // The version's record panel no longer gets this panel's reads.
      versionRecord?.release();
      latestDeploymentStatus = null;
      latestRecordedStatus = null;
      agentRereadFailed = false;
      latestDeploymentRecord = null;
      latestOverviewUnavailable = false;
      latestDeploymentUnavailable = false;
      // On first load the newest version's panel replaces the loading placeholder once its
      // first status read settles, in the same frame as the summary and status line, so the
      // page below moves once instead of once for an empty panel and again for the status.
      // A newer version found later replaces the shown (older) panel at once.
      const firstLoad = activityPanel === deploymentStatus;
      // A failed version's banner also waits for the caller's permission answer (finding
      // 1478), so the overview waits for it too rather than move when the banner lands.
      const showPanel = (panel: HTMLElement, failed = false) => {
        if (activityPanel !== panel) {
          activityPanel.replaceWith(panel);
          activityPanel = panel;
        }
        void Promise.all([nativeAdmin.ready, failed ? callerPermissionsRead : null]).then(
          revealDetail,
        );
      };
      const nextPanel: HTMLElement = mostRecent
        ? createDeploymentStatusPanel(
            context,
            path,
            mostRecent,
            (freshAgent, freshRevisions) =>
              updateCurrentAgent(
                freshAgent,
                { status: "fulfilled", value: revisionsForPage(freshRevisions) },
                snapshot,
              ),
            ({ outcome: status, readFailed, record, overviewUnavailable, transientFailure }) => {
              if (activityRevisionId !== mostRecent.id) {
                return;
              }
              showPanel(nextPanel, status === "failed");
              latestDeploymentStatus = status;
              if (status === "failed") {
                failedVersions.add(failedVersionKey(path, mostRecent.id));
              }
              // A refused or missing record ends the wait, so it no longer labels the version.
              if (record || !transientFailure) {
                latestRecordedStatus = status;
              }
              if (overviewUnavailable) {
                agentRereadFailed = true;
              }
              latestOverviewUnavailable = overviewUnavailable;
              latestDeploymentUnavailable = readFailed;
              if (record?.error?.code === "RUNTIME_AUTHENTICATION_FAILED") {
                void readLatestRevisionDetail(mostRecent);
              }
              latestDeploymentRecord = record;
              if (mostRecent.id === selected) {
                // After a failed read, the version's record panel reads its record itself.
                if (record) {
                  versionRecord?.show(record);
                } else {
                  versionRecord?.release();
                }
              }
              renderLatestDeployment();
              // A success is shown once the Agent reread makes the version current; until then
              // the notice keeps "Deploying" rather than flash "Historical". A reread that failed
              // leaves the version labelled from its record (finding 2085).
              if (status !== "succeeded" || overviewUnavailable) {
                renderVersionNotice();
              }
              refreshDeployControls();
            },
            // A newer version found later is one the reader is following: its first record
            // opens the details as any new outcome does.
            firstLoad ? () => detailShown : undefined,
          )
        : element(
            "section",
            // With no versions the card would repeat the facts' "No readable deployments", so it
            // stays out of the way of the draft's next step (UX spec 3.7).
            {
              className: "agent-card deployment-status",
              hidden: revisionResult.status !== "rejected",
            },
            element("h2", {}, "Deployment activity"),
            element(
              "p",
              { className: "muted" },
              revisionResult.status === "rejected"
                ? "Version history is unavailable."
                : "No readable deployment records.",
            ),
          );
      if (!mostRecent || !firstLoad) {
        showPanel(nextPanel);
      }
      activityRevisionId = mostRecent?.id ?? null;
    }
    renderLatestDeployment();
    return revisions;
  }

  async function loadOverview() {
    const [revisionResult] = await Promise.allSettled([revisionsPromise]);
    if (!context.isCurrent() || deleting) {
      return;
    }
    if (revisionResult.status === "rejected" && revisionResult.reason.status === 401) {
      context.onExpired();
      return;
    }
    renderOverview(revisionResult, viewedSnapshot);
    renderDetailHeading();
  }
  let refreshDeployControls = () => {};
  void callerPermissionsRead.then((permissions) => {
    if (!context.isCurrent()) {
      return;
    }
    // A failed-version recovery held for this answer can now show, with or without its draft link.
    if (latestDeploymentStatus === "failed" && !deleting) {
      renderLatestDeployment();
    }
    if (!permissions) {
      return;
    }
    applyDraftAccess();
  });

  const snapshotPath =
    selected === "draft"
      ? `${namespacePath(namespaceId)}/configurations/${encodeURIComponent(agent.configurationId)}`
      : `${path}/revisions/${encodeURIComponent(selected)}`;

  async function readSnapshot() {
    // A denied read is audited, so reuse this tab's settled denial instead of asking per view.
    if (context.deniedReads?.has(snapshotPath)) {
      throw Object.assign(new Error("Access denied."), {
        status: 403,
        code: "FORBIDDEN",
        remembered: true,
      });
    }
    try {
      const value = await request(snapshotPath);
      return selected === "draft"
        ? configurationForPage(value, agent.configurationId)
        : revisionForPage(value, selected);
    } catch (error) {
      if (requestFailure(error).status === 403) {
        context.deniedReads?.remember(snapshotPath);
      }
      throw error;
    }
  }

  async function loadDetails(): Promise<DetailsResult> {
    const results = await Promise.allSettled([
      revisionsPromise,
      selected === "draft" && agent.configurationReadError ? Promise.resolve(null) : readSnapshot(),
    ]);
    if (!context.isCurrent() || deleting) {
      return;
    }
    if (results.some((result) => result.status === "rejected" && result.reason.status === 401)) {
      context.onExpired();
      return;
    }
    const revisionResult = latestRevisionResult ?? results[0];
    const read = results[1];
    const found = read.status === "fulfilled" ? read.value : null;
    if (selected === "draft") {
      // The draft's own read is the Configuration read; recovery waits for it.
      recovery.noteDraftRead(found?.id ?? null);
    }
    detailLoadFinished = true;
    viewedSnapshot = found;
    renderOverview(revisionResult, found);
    renderDetailHeading();
    if (selected === "draft" && agent.configurationReadError) {
      return { error: agent.configurationReadError };
    }
    if (!found) {
      return {
        error: read.status === "rejected" ? read.reason : new Error("Configuration unavailable."),
      };
    }
    if ("configurationReadError" in found) {
      return { error: found.configurationReadError };
    }
    if ("revision" in found) {
      versionRecord = createVersionDeploymentEvidence(context, path, selected, {
        shared: activityRevisionId === selected && !latestDeploymentUnavailable,
        operateAllowed: latestPermissionsRead.then((permissions) => permissions?.operate),
        isCurrentVersion: () => currentRevisionId === selected,
        // After a reload only the latest record feeds the cache, so an earlier failed version
        // read "Historical" with no mark beside its own "Failed" record (finding 2407).
        onRecord: (record) => {
          const key = failedVersionKey(path, selected);
          if (deploymentOutcome(record) === "failed" && !failedVersions.has(key)) {
            failedVersions.add(key);
            renderVersionNotice();
            markVersionOutcomes();
          }
        },
      });
      versionEvidence.append(...versionRecord.panels);
      versionRecord.setFailureShownAbove(recoveryRevisionId === selected);
      if (latestDeploymentRecord?.deploymentId === selected) {
        versionRecord.show(latestDeploymentRecord);
      }
      return {
        snapshot: found,
        values: found.configuration,
        draft: false,
        executionMode: found.harness.mode,
      };
    }
    let snapshot: Configuration = found;
    let values = snapshot.values;
    const executionMode = agent.executionMode;
    let deployPending = false;
    let deployReloadMessage = "";
    let authenticationForm: HTMLElement | undefined;
    const retainedAuthentication = context.drafts.get("authentication") as
      AuthenticationDraft | undefined;
    // A member's save that this session could not verify is finished: it holds nothing
    // (finding 2547).
    let authenticationPending = Boolean(
      retainedAuthentication?.outcomeUnknown ||
      (retainedAuthentication?.savedAuthentication &&
        retainedAuthentication.grantProblem !== "unverified"),
    );
    // Authentication edits staged in Credentials but not yet saved.
    let authenticationUnsaved = false;
    const retainedEditor = context.drafts.get("configuration") as ConfigurationDraft | undefined;
    const draftEditorState = {
      dirty: Boolean(retainedEditor && retainedEditor.text !== retainedEditor.initialText),
      saving: false,
      outcomeUnknown: retainedEditor?.outcomeUnknown ?? false,
      reloadRequired: retainedEditor?.reloadRequired ?? false,
    };
    const retainedPlugins = context.drafts.get("plugins") as Partial<EditorState> | undefined;
    const pluginEditorState = {
      dirty: Boolean(retainedPlugins?.dirty),
      saving: false,
      outcomeUnknown: retainedPlugins?.outcomeUnknown ?? false,
      reloadRequired: retainedPlugins?.reloadRequired ?? false,
    };
    const runtimeAuth = agent.harnessAuth?.method === "runtime";
    // The carried choices apply once, to the panel built from the reread.
    const carriedSecrets =
      carriedChannelSecrets ??
      (context.drafts.get("channelSecrets") as CarriedChannelSecrets | undefined) ??
      null;
    carriedChannelSecrets = null;
    context.drafts.forget("channelSecrets");
    const panelNumber = ++channelPanelCount;
    const credentials = !runtimeAuth
      ? createChannelSecretsPanel({
          context: { ...context, secretsOperateDenied },
          path,
          agent,
          configuration: snapshot,
          values,
          revisionsLoaded: revisionResult.status === "fulfilled",
          carried: carriedSecrets,
          outstandingGrants: outstandingChannelGrants,
          onOutstandingGrants: setOutstandingChannelGrants,
          // Only an Installation administrator may read the IAM policy that shows a grant.
          checkGrants: context.installationAdmin === true,
          canGrant: context.installationAdmin !== false,
          // Binding Secrets saves the Configuration (finding 2432).
          readOnly: channelsReadOnly,
          readOnlyReason: () =>
            callerPermissions?.configurationUpdate === false
              ? CHANNEL_SECRETS_CONFIGURATION_READ_ONLY
              : channelSecretsOperateReadOnly(
                  callerPermissions?.configurationSecretsOperateDeniedBindings,
                ),
          bindingsToReplace: channelBindingsReplace,
          bindingRefusal: (secrets) => refusedSecretBinding("configuration", secrets),
          isCurrent: () => panelNumber === channelPanelCount,
          onChange() {
            updateNavigationControls();
            updateDeployControls();
          },
          onConfigurationChange(configuration) {
            snapshot = configuration;
            values = configuration.values;
            viewedSnapshot = configuration;
            renderDetailHeading();
            updateDeployControls();
            // The answer's denied binding names describe the bindings before this save. Read it
            // again, so the panel and the Channels drawer stop asking to replace a binding the
            // save rebound (findings 2444, 2457), and Deploy names the Secrets now bound.
            void rereadPermissions();
            void readDeploySecretsDenied();
          },
          onReload: (carried = null) => {
            carriedChannelSecrets = carried;
            if (carried) {
              context.drafts.track("channelSecrets", () => carried);
              // Saved Secrets the reloaded draft references: nothing a reload would lose.
              context.drafts.unsavedWhen("channelSecrets", () => false);
            } else {
              context.drafts.forget("channelSecrets");
            }
            return reloadDraftInPlace(context, {
              saved: "Draft reloaded.",
              focus: ["Save channel Secrets", "Retry Secret access"],
            });
          },
        })
      : null;
    // Operator-managed credentials build no channel Secrets panel to say so (finding 1525).
    const channelSecretsNote =
      runtimeAuth && carriedSecrets
        ? "Your channel Secret choices were not reapplied: this Agent now uses operator-managed credentials."
        : "";
    activeCredentials = credentials;
    // An Installation administrator's Credentials tab reads whether the Agent may use its harness
    // authentication Secret or credential source, as it reads bound Slack Secrets' grants: a
    // missing grant then blocks Deploy until Credentials grants it. The read runs once per draft;
    // a failed or undecided read changes nothing (findings 1920, 2260).
    let harnessGrantMissing = false;
    let harnessGrantRead: Promise<boolean> | null = null;
    function readHarnessGrant() {
      const credential = harnessCredential(agent.harnessAuth, context.namespaceId);
      if (
        context.installationAdmin !== true ||
        credential?.namespaceId !== context.namespaceId ||
        typeof agent.servicePrincipalId !== "string"
      ) {
        return Promise.resolve(false);
      }
      return credentialOperateGrants(context, agent, credential.kind, [credential.id]).then(
        (grants) => {
          if (grants.get(credential.id) !== false || !context.isCurrent()) {
            return false;
          }
          harnessGrantMissing = true;
          updateDeployControls();
          return true;
        },
        () => false,
      );
    }
    // Deployment needs Secret operate on each Secret the draft binds: its Configuration's Secret
    // bindings and a Secret authentication source. The Secret operate answer names the bound ones
    // this caller may not operate, so Deploy says so before a click the API would refuse. An
    // unknown or unreported answer names none and leaves Deploy to the API (finding 2546).
    let deploySecretsDenied: readonly string[] = [];
    let deploySecretsRead = 0;
    async function boundSecretsDenied({ fresh = false } = {}) {
      const bound = new Map<string, unknown>();
      for (const binding of Object.values(snapshot.secretBindings ?? {})) {
        const source = secretSourceForBinding(binding);
        if (source) {
          bound.set(source.id, source);
        }
      }
      const harness = harnessCredential(agent.harnessAuth, namespaceId);
      if (harness?.kind === "secret") {
        bound.set(harness.id, harness);
      }
      if (bound.size === 0) {
        return [];
      }
      const denied = await secretsOperateDenied({ fresh });
      // The answer lists only Secrets this caller may read, so each one's name reads too.
      const names = await Promise.all(
        [...bound]
          .filter(([id]) => denied?.has(id))
          .map(async ([id, source]) => {
            const href = sameNamespaceSecretHref(source, namespaceId);
            try {
              return href ? (secretMetadata(await request(href), namespaceId)?.name ?? id) : id;
            } catch {
              return id;
            }
          }),
      );
      return names.sort((left, right) => left.localeCompare(right));
    }
    function readDeploySecretsDenied(options?: { fresh?: boolean }) {
      const read = ++deploySecretsRead;
      return boundSecretsDenied(options).then(
        (names) => {
          if (read === deploySecretsRead && context.isCurrent()) {
            deploySecretsDenied = names;
            updateDeployControls();
          }
          return names;
        },
        () => deploySecretsDenied,
      );
    }
    function editedSubject() {
      if (selectedTab === "repositories") {
        return "repository access";
      }
      return selectedTab === "channels" ? "channel settings" : "Configuration";
    }
    function retainedConfigurationState() {
      const retained =
        selectedTab === "configuration"
          ? null
          : (context.drafts.get("configuration") as ConfigurationDraft | undefined);
      return {
        dirty: Boolean(retained && retained.text !== retained.initialText),
        reloadRequired: Boolean(retained?.outcomeUnknown || retained?.reloadRequired),
      };
    }
    const setupCredentials = !runtimeAuth
      ? button("Set up credentials", () => change("draft", "credentials"))
      : null;
    function deployIsDisabled() {
      const retainedConfiguration = retainedConfigurationState();
      return (
        deployPending ||
        callerPermissions?.deploy === false ||
        deploySecretsDenied.length > 0 ||
        authenticationSaveState !== "idle" ||
        Boolean(deployReloadMessage) ||
        authenticationPending ||
        harnessGrantMissing ||
        authenticationUnsaved ||
        retainedConfiguration.dirty ||
        retainedConfiguration.reloadRequired ||
        draftEditorState.dirty ||
        draftEditorState.saving ||
        draftEditorState.outcomeUnknown ||
        draftEditorState.reloadRequired ||
        pluginEditorState.dirty ||
        pluginEditorState.saving ||
        pluginEditorState.outcomeUnknown ||
        pluginEditorState.reloadRequired ||
        !agent.harnessAuth ||
        revisionResult.status !== "fulfilled" ||
        (!runtimeAuth && !credentials?.canDeploy())
      );
    }
    function updateDeployControls() {
      authenticationForm?.toggleAttribute("inert", Boolean(credentials?.mutationPending()));
      credentials?.section?.toggleAttribute("inert", authenticationSaveState !== "idle");
      const retainedConfiguration = retainedConfigurationState();
      deploy.disabled = deployIsDisabled();
      if (setupCredentials) {
        // A reader's card offers no editor's action; the status says why (finding 2421).
        setupCredentials.hidden =
          draftReadOnly() ||
          selectedTab === "credentials" ||
          revisionResult.status !== "fulfilled" ||
          channelCredentialBlockReason(values) !== null ||
          (Boolean(agent.harnessAuth) &&
            !authenticationPending &&
            !harnessGrantMissing &&
            (credentials?.canDeploy() ?? false));
        setupCredentials.disabled = deployPending || Boolean(draftEditorNavigationBlock);
      }
      if (!deployPending) {
        if (callerPermissions?.deploy === false) {
          deployStatus.textContent = "Your access does not include deploying this Agent.";
        } else if (deploySecretsDenied.length) {
          const reason = deploySecretsOperateReason(deploySecretsDenied);
          // A refused deployment's alert already says it.
          deployStatus.textContent = deployFeedback.textContent === reason ? "" : reason;
        } else if (deployReloadMessage) {
          deployStatus.textContent = deployReloadMessage;
        } else if (authenticationSaveState === "saving") {
          deployStatus.textContent = "Wait for the authentication save to finish before deploying.";
        } else if (authenticationSaveState === "uncertain") {
          deployStatus.textContent =
            "Authentication may have been saved. Reload this draft before deploying.";
        } else if (authenticationPending || harnessGrantMissing) {
          deployStatus.textContent =
            "Confirm authentication and Secret access in Credentials before deploying.";
        } else if (authenticationUnsaved) {
          deployStatus.textContent =
            "Save or reload the authentication source in Credentials before deploying.";
        } else if (retainedConfiguration.reloadRequired) {
          deployStatus.textContent = "Reload the Configuration draft before deploying.";
        } else if (retainedConfiguration.dirty) {
          deployStatus.textContent = "Save or cancel Configuration edits before deploying.";
        } else if (draftEditorState.outcomeUnknown) {
          deployStatus.textContent = `Reload this draft before deploying because the last ${editedSubject()} save outcome is unknown.`;
        } else if (draftEditorState.reloadRequired) {
          deployStatus.textContent = "Reload this draft before deploying.";
        } else if (draftEditorState.saving) {
          deployStatus.textContent = `Wait for ${editedSubject()} save to finish before deploying.`;
        } else if (draftEditorState.dirty) {
          deployStatus.textContent = `Save or cancel ${editedSubject()} edits before deploying.`;
        } else if (pluginEditorState.outcomeUnknown) {
          deployStatus.textContent =
            "Refresh this Agent before deploying because the last plugin save outcome is unknown.";
        } else if (pluginEditorState.reloadRequired) {
          deployStatus.textContent = "Reload plugin selections before deploying.";
        } else if (pluginEditorState.saving) {
          deployStatus.textContent =
            "Wait for plugin selections to finish saving before deploying.";
        } else if (pluginEditorState.dirty) {
          deployStatus.textContent = "Save or discard plugin changes before deploying.";
        } else if (deployFeedback?.textContent) {
          deployStatus.textContent = "";
        } else if (revisionResult.status !== "fulfilled") {
          deployStatus.textContent =
            "Version history is required before deploying this new version.";
        } else if (!agent.harnessAuth) {
          deployStatus.textContent =
            "Select a harness authentication source in Credentials before deployment.";
        } else if (runtimeAuth) {
          // A rejected operator-managed credential is fixed on the runtime host, not by Deploy.
          deployStatus.textContent = credentialRejected()
            ? "The last deployment's model credential was rejected; ask an operator to replace it on the runtime host before deploying again."
            : "Configured on the runtime host; not validated by OCC. Gateway readiness does not confirm model access.";
        } else {
          const gate =
            credentials?.deployGateMessage() ?? "Credential readiness could not be confirmed.";
          // Secret values can be updated in place, so a rejected credential warns instead of
          // blocking. It never reads "Ready to deploy.": deploying again does not fix it.
          const rejected =
            "The last deployment's model credential was rejected; update or replace it in Credentials before deploying again.";
          const status = !credentialRejected()
            ? gate
            : gate === "Ready to deploy."
              ? rejected
              : `${gate} ${rejected}`;
          deployStatus.textContent =
            draftReadOnly() && status !== "Ready to deploy."
              ? `${status} Your access does not include changing this version draft.`
              : status;
        }
      }
      updateChecklist();
    }
    // The last deployment's model credential was rejected and the draft still uses it.
    function credentialRejected() {
      return (
        latestDeploymentRecord?.error?.code === "RUNTIME_AUTHENTICATION_FAILED" &&
        latestRevisionDetail !== null &&
        "harnessAuth" in latestRevisionDetail &&
        latestRevisionDetail.id === visibleRevisions[0]?.id &&
        JSON.stringify(latestRevisionDetail.harnessAuth) === JSON.stringify(agent.harnessAuth)
      );
    }
    // The next step's checklist (UX spec 3.7): each step is done or still open, with one muted
    // detail line. A credential the last deployment had rejected keeps its step open.
    const checklistSteps = [
      "Edit and save Configuration, plugins, or Channels",
      "Check authentication and credentials",
      "Deploy the saved draft",
    ].map((text) => {
      const state = element("span", { className: "visually-hidden" });
      const detail = element("span", { className: "checklist-detail" });
      const item = element(
        "li",
        {},
        element("span", { className: "checklist-mark", "aria-hidden": "true" }),
        element("span", { className: "checklist-text" }, state, text, detail),
      );
      return { item, state, detail };
    });
    const checklist = element(
      "ol",
      // list-style: none drops list semantics in some screen readers; keep them.
      { className: "checklist", role: "list" },
      ...checklistSteps.map((step) => step.item),
    );
    const draftActionsHeading = element("h2", {}, "Prepare this version");
    function setStep(
      step: (typeof checklistSteps)[number] | undefined,
      done: boolean,
      detail: string,
    ) {
      if (!step) {
        return;
      }
      const value = done ? "done" : "pending";
      if (step.item.dataset.state !== value) {
        step.item.dataset.state = value;
        step.state.textContent = done ? "Done: " : "Not done: ";
      }
      setText(step.detail, detail);
    }
    function updateChecklist() {
      // A caller who can change nothing here and cannot deploy gets no editor's checklist
      // (finding 2421); Deploy says why it is disabled.
      const reader = draftReadOnly() && callerPermissions?.deploy === false;
      checklist.hidden = reader;
      setText(draftActionsHeading, reader ? "Version draft" : "Prepare this version");
      const retainedConfiguration = retainedConfigurationState();
      const saving = draftEditorState.saving || pluginEditorState.saving;
      const reload =
        draftEditorState.outcomeUnknown ||
        draftEditorState.reloadRequired ||
        pluginEditorState.outcomeUnknown ||
        pluginEditorState.reloadRequired ||
        retainedConfiguration.reloadRequired ||
        Boolean(deployReloadMessage);
      const unsaved =
        draftEditorState.dirty || pluginEditorState.dirty || retainedConfiguration.dirty;
      setStep(
        checklistSteps[0],
        !saving && !reload && !unsaved,
        `${saving ? "Saving…" : reload ? "Reload this draft" : unsaved ? "Unsaved changes" : "Saved"} · Configuration ${snapshot.id} · generation ${snapshot.generation}`,
      );
      const rejected = credentialRejected();
      const authenticationReady =
        Boolean(agent.harnessAuth) &&
        authenticationSaveState === "idle" &&
        !authenticationPending &&
        !harnessGrantMissing &&
        !authenticationUnsaved &&
        (runtimeAuth || Boolean(credentials?.credentialsReady()));
      setStep(
        checklistSteps[1],
        authenticationReady && !rejected,
        !agent.harnessAuth
          ? "No harness authentication selected"
          : rejected
            ? "The last deployment's model credential was rejected"
            : authenticationReady
              ? `Saved · ${harnessAuthDescription(agent.harnessAuth)}`
              : authenticationSaveState === "saving" || credentials?.isSaving()
                ? "Saving…"
                : authenticationSaveState === "uncertain"
                  ? "Reload this draft"
                  : "Finish in Credentials",
      );
      setStep(checklistSteps[2], false, "Creates an immutable version from the saved draft");
    }
    refreshDeployControls = updateDeployControls;
    const deployStatus = element("p", { className: "muted", role: "status" });
    const deployFeedback = statusBlock("danger", null, null);
    const deploy = button(
      "Deploy new version",
      async () => {
        deployFeedback.textContent = "";
        deploy.disabled = true;
        deployPending = true;
        deployInFlight = true;
        content.toggleAttribute("inert", true);
        updateNavigationControls();
        // One status for the whole request, shown only if it outlasts 250 ms; it takes focus
        // from the disabled button so a keyboard reader is not dropped to the page (finding 1619).
        deployStatus.replaceChildren(
          element("span", { className: "delayed-status" }, "Deploying…"),
        );
        focusSaveOutcome(draftActions, [], deployStatus);
        let submitted = false;
        try {
          const freshAgent = await readAgent();
          if (!context.isCurrent()) {
            return;
          }
          assertReadableConfiguration(freshAgent);
          if (!freshAgent.harnessAuth) {
            deployFeedback.textContent =
              "Select a harness authentication source in Credentials before deployment.";
            return;
          }
          const freshConfig = await readConfiguration(freshAgent.configurationId);
          if (!context.isCurrent()) {
            return;
          }
          if (
            freshAgent.configurationId !== snapshot.id ||
            JSON.stringify(freshAgent.harnessAuth) !== JSON.stringify(agent.harnessAuth) ||
            freshConfig.generation !== snapshot.generation
          ) {
            deployReloadMessage =
              "Configuration or authentication changed. Reload this draft before deploying.";
            return;
          }
          if (
            freshAgent.executionMode !== agent.executionMode ||
            freshAgent.backendId !== agent.backendId ||
            JSON.stringify(freshAgent.plugins ?? {}) !== JSON.stringify(agent.plugins ?? {})
          ) {
            deployReloadMessage = "Agent settings changed. Reload this draft before deploying.";
            return;
          }
          if (
            JSON.stringify(freshAgent.repositoryAccess) !==
              JSON.stringify(agent.repositoryAccess) ||
            JSON.stringify(freshAgent.repositoryBindings) !==
              JSON.stringify(agent.repositoryBindings)
          ) {
            deployReloadMessage = "Repository access changed. Reload this draft before deploying.";
            return;
          }
          // TODO: require an expected Agent version at deployment admission; a change
          // after this preflight can still race with the POST.
          const credentialBlockReason = channelCredentialBlockReason(freshConfig.values);
          if (credentialBlockReason !== null) {
            deployFeedback.textContent = credentialBlockReason;
            return;
          }
          if (
            freshAgent.harnessAuth.method !== "runtime" &&
            !hasRequiredChannelCredentials(freshConfig.values, freshConfig)
          ) {
            deployFeedback.textContent =
              "Channel Secret bindings changed. Refresh this Agent before deploying.";
            return;
          }
          submitted = true;
          const revision = revisionForPage(await request(`${path}/deploy`, { method: "POST" }));
          if (
            !("configurationGeneration" in revision) ||
            revision.configurationId !== snapshot.id ||
            revision.configurationGeneration !== snapshot.generation
          ) {
            throw new Error("The admitted version could not be confirmed for this Configuration.");
          }
          if (context.isCurrent()) {
            deployInFlight = false;
            content.toggleAttribute("inert", false);
            updateNavigationControls();
            change(revision.id, "configuration");
          }
        } catch (error) {
          if (!context.isCurrent()) {
            return;
          }
          if (requestFailure(error).status === 401) {
            context.onExpired();
            return;
          }
          const failure = requestFailure(error);
          // A plain denial does not say which grant failed. When the Secret operate answer, read
          // again, names bound Secrets this caller may not operate, the alert names them and
          // Deploy stays disabled until a grant is read (finding 2546).
          const deniedSecrets =
            submitted &&
            failure.status === 403 &&
            (failure.serverMessage === undefined || failure.serverMessage === GENERIC_DENIAL)
              ? await readDeploySecretsDenied({ fresh: true })
              : [];
          if (!context.isCurrent()) {
            return;
          }
          deployFeedback.textContent = deniedSecrets.length
            ? deploySecretsOperateReason(deniedSecrets)
            : deployFailureText(error, submitted);
          if (
            !submitted ||
            deployRefusedBeforeAdmission(error) ||
            refusedWriteStatuses.includes(requestFailure(error).status)
          ) {
            deployPending = false;
          } else {
            // The request ended, not necessarily the deployment. Keep Deploy disabled and let
            // the alert explain the unknown outcome instead of leaving “Deploying…” beside it.
            deployStatus.textContent = "";
          }
        } finally {
          if (context.isCurrent()) {
            deployInFlight = false;
            content.toggleAttribute("inert", false);
            updateNavigationControls();
            if (!submitted) {
              deployPending = false;
            }
            updateDeployControls();
            // A refused or failed request stays on this draft: focus returns to Deploy, or to
            // the message when Deploy stays disabled.
            if (document.activeElement === deployStatus) {
              focusSaveOutcome(
                draftActions,
                [deploy],
                deployFeedback.textContent ? deployFeedback : deployStatus,
              );
            }
          }
        }
      },
      // .primary stays for tests that find Deploy new version by it.
      { tone: "primary", className: "primary" },
    );
    updateDeployControls();
    void readDeploySecretsDenied();
    const draftActions = element(
      "section",
      { className: "card agent-draft-actions" },
      draftActionsHeading,
      checklist,
      // The status follows Deploy in reading order; on a wide screen it shows to its left.
      element("div", { className: "card-actions" }, setupCredentials, deploy, deployStatus),
      deployFeedback,
    );
    // A draft refreshed in place swaps its actions in one step (finding 1445).
    const shownActions = versionSummary.querySelector(":scope > .agent-draft-actions");
    if (shownActions) {
      shownActions.replaceWith(draftActions);
    } else {
      versionSummary.append(draftActions);
    }
    renderDetailHeading();
    return {
      get snapshot() {
        return snapshot;
      },
      get values() {
        return values;
      },
      draft: true,
      executionMode,
      credentials,
      channelSecretsNote,
      setAuthenticationPending(pending) {
        authenticationPending = pending;
        updateDeployControls();
      },
      setAuthenticationUnsaved(unsaved) {
        if (authenticationUnsaved !== unsaved) {
          authenticationUnsaved = unsaved;
          updateDeployControls();
        }
      },
      setDraftEditorState(nextState) {
        Object.assign(draftEditorState, nextState);
        draftEditorSaving = Boolean(draftEditorState.saving);
        draftEditorNavigationBlock = draftEditorState.outcomeUnknown
          ? "Outcome unknown. Reload this draft before leaving the editor."
          : draftEditorState.reloadRequired
            ? "Reload this draft before leaving the editor."
            : draftEditorState.saving
              ? `Wait for ${editedSubject()} save to finish before leaving the editor.`
              : draftEditorState.dirty && selectedTab === "repositories"
                ? `Save or cancel ${editedSubject()} edits before leaving this tab.`
                : null;
        updateNavigationControls();
        updateDeployControls();
      },
      setAuthenticationSaveState(nextState) {
        authenticationSaveState = nextState;
        updateNavigationControls();
        updateDeployControls();
      },
      setAuthenticationForm(form) {
        authenticationForm = form;
        updateDeployControls();
      },
      harnessGrantMissing() {
        harnessGrantRead ??= readHarnessGrant();
        return harnessGrantRead;
      },
      setPluginEditorState(nextState) {
        Object.assign(pluginEditorState, nextState);
        draftEditorSaving = Boolean(pluginEditorState.saving);
        draftEditorNavigationBlock = pluginEditorState.outcomeUnknown
          ? "Outcome unknown. Reload this Agent before leaving plugin selections."
          : pluginEditorState.reloadRequired
            ? "Reload plugin selections before leaving this tab."
            : pluginEditorState.saving
              ? "Wait for plugin selections to finish saving before leaving this tab."
              : null;
        updateNavigationControls();
        updateDeployControls();
      },
    };
  }

  // A saved draft refreshes in place: one read of its Configuration rebuilds the draft's state
  // and the shown tab, keeping the reader's place. Re-navigating to the same URL collapsed the
  // page to its summary, made about 12 reads, scrolled to the top and dropped focus with no
  // saved message (finding 1445). `focus` names the button that takes focus afterwards.
  async function refreshDraftInPlace({
    agent: value = null,
    saved = "",
    focus = null,
  }: DraftRefresh = {}) {
    if (deleting) {
      // Delete took the editors: there is nothing to rebuild, and a settled save no longer holds
      // the page (finding 2125).
      draftEditorNavigationBlock = null;
      draftEditorSaving = false;
      authenticationSaveState = "idle";
      if (context.isCurrent()) {
        updateNavigationControls();
      }
      return;
    }
    const freshAgent = value ? agentForPage(value) : null;
    if (freshAgent && freshAgent.configurationId !== agent.configurationId) {
      // The draft now edits another Configuration; reload the page for it.
      context.navigate(target("draft", selectedTab), namespaceId, true);
      return;
    }
    refreshingDraft = true;
    updateNavigationControls();
    try {
      await refreshDraft(freshAgent, saved, focus);
    } finally {
      refreshingDraft = false;
      if (context.isCurrent()) {
        updateNavigationControls();
      }
    }
  }

  // Reload draft rereads the Agent, then refreshes in place. The read goes through the tab's
  // request, so a tab left mid-read is rebuilt rather than retained; a failed read reloads the
  // page as before.
  async function reloadDraftInPlace(
    tabContext: DetailContext,
    options: Omit<DraftRefresh, "agent">,
  ) {
    if (refreshingDraft) {
      return;
    }
    // Tabs and versions wait from the click, not only once the reread is back.
    refreshingDraft = true;
    updateNavigationControls();
    const tab = mountedTab;
    const current = () => tabContext.isCurrent() && mountedTab === tab && !deleting;
    let fresh;
    try {
      fresh = await readAgent(tabContext);
    } catch {
      fresh = null;
    }
    refreshingDraft = false;
    if (!current()) {
      if (context.isCurrent()) {
        updateNavigationControls();
      }
      return;
    }
    // Slack Secret grants this session could not verify block Deploy only until a reload, as
    // Reload authentication source clears the harness path's (finding 2263).
    if (outstandingChannelGrants?.problem === "unverified") {
      setOutstandingChannelGrants(null);
    }
    if (fresh) {
      await refreshDraftInPlace({ agent: fresh, ...options });
    } else {
      context.navigate(target("draft", selectedTab), namespaceId, true);
    }
  }

  // Every operate-gated control follows the newest answer read, without a reload: the Stop row,
  // the shown version's Run diagnostics, and Workspace editors, shown or parked (finding 2328).
  function applyOperateAnswer(allowed: boolean | undefined) {
    stopPanel.applyOperate(allowed);
    versionRecord?.applyOperate(allowed);
    mountedTab?.applyOperate?.(allowed);
    for (const tab of retainedTabs.values()) {
      tab.applyOperate?.(allowed);
    }
  }

  // Why a save that bound these chosen Secrets was refused: the Secret answer, read again, names
  // each one the caller may not operate (finding 2453). It is named only when the permission
  // answer, read again too, allows the save's own grants: update on the Configuration for a
  // Configuration save; update, Configuration read and the bound sources for an Agent save.
  // Otherwise the save's usual refusal names every grant it needs: so it does when the permission
  // read fails, or when the Secret read fails before any answer (a failed reread keeps the last).
  async function refusedSecretBinding(
    save: "configuration" | "agent",
    secrets: readonly Pick<SecretMetadata, "id" | "name">[],
  ) {
    secretsOperateAnswer.reset();
    const [permissions, denied] = await Promise.all([
      readPermissions().catch(() => null),
      secretsOperateDenied(),
    ]);
    const ownGrants =
      save === "configuration"
        ? permissions?.configurationUpdate === true
        : permissions?.update === true &&
          permissions.configurationRead === true &&
          permissions.agentSourcesOperate === true;
    const names = secrets.filter((secret) => denied?.has(secret.id)).map((secret) => secret.name);
    return ownGrants && names.length ? secretOperateRefusal(names) : undefined;
  }

  // Reads the caller's permission answer again; a failed read keeps the last answer.
  function rereadPermissions() {
    secretsOperateAnswer.reset();
    const previous = latestPermissionsRead;
    const reread = ++permissionsRereads;
    const read = readPermissions().then(
      (permissions) => {
        if (context.isCurrent() && reread === permissionsRereads) {
          callerPermissions = permissions;
          // Views built from now on take this answer; shown ones follow it below (finding 2470).
          agentSaveDenied = Promise.resolve(agentSaveDenial(permissions, agent));
          if (latestDeploymentStatus === "failed" && !deleting) {
            renderLatestDeployment();
          }
          // A grant or revocation since the last answer relabels the draft (finding 2421).
          applyDraftAccess();
        }
        // An older reread still applies when no newer one has answered: a newer read that
        // fails resolves to this answer, which the controls would otherwise never see.
        if (context.isCurrent() && reread > appliedOperateReread) {
          appliedOperateReread = reread;
          applyOperateAnswer(permissions?.operate);
        }
        return permissions;
      },
      () => previous,
    );
    latestPermissionsRead = read;
    permissionsReadSettled = false;
    const settle = () => {
      permissionsReadSettled = latestPermissionsRead === read;
    };
    void read.then(settle, settle);
    return read;
  }

  async function refreshDraft(freshAgent: PageAgent | null, saved: string, focus: DraftFocus) {
    if (freshAgent) {
      agent = freshAgent;
      updateCurrentAgent(freshAgent, latestRevisionResult, viewedSnapshot);
    }
    // The rebuilt editors take the fresh answer.
    agentSaveDenied = rereadPermissions().then((permissions) =>
      agentSaveDenial(permissions, agent),
    );
    const next = loadDetails();
    const data = await next;
    if (!context.isCurrent() || deleting || !data) {
      return;
    }
    settledDetails = next;
    if ("error" in data) {
      versionSummary.querySelector(":scope > .agent-draft-actions")?.remove();
      renderDetailHeading();
    }
    details = next;
    // The rebuilt editors start clean; nothing is saving any more.
    draftEditorNavigationBlock = null;
    draftEditorSaving = false;
    authenticationSaveState = "idle";
    // Tabs built from the previous draft state would drive its replaced controls.
    retainedTabs.clear();
    if (mountedTab) {
      mountedTab.reusable = false;
    }
    savedNotice = saved;
    // A save lands well after its click, and the rebuilt tab is usually shorter than the editor
    // it replaces. When the cards below the version layout are in view, scroll by the layout's
    // change, so they keep their place and the summary takes the editor's (finding 1482).
    const bottomBefore = versionLayout.getBoundingClientRect().bottom;
    const anchorBelow = bottomBefore < globalThis.innerHeight;
    try {
      await renderTab();
    } finally {
      savedNotice = "";
    }
    if (!context.isCurrent()) {
      return;
    }
    // The permission reread can land after the rebuilt tab was drawn.
    redrawConfigurationAccessViews();
    const shrunk = versionLayout.getBoundingClientRect().bottom - bottomBefore;
    if (anchorBelow && shrunk < 0) {
      globalThis.scrollBy({ top: shrunk, behavior: "instant" });
    }
    // `focus` may list fallbacks; the first enabled, shown match in the tab takes focus. A
    // Cancel that the rebuilt editor hides falls back to the tab (finding 2386).
    const named = [...content.querySelectorAll("button")].find(
      (candidate) =>
        [focus].flat().includes(candidate.textContent) &&
        !candidate.disabled &&
        !candidate.closest("[hidden]"),
    );
    const status = saved
      ? [...content.querySelectorAll<HTMLElement>('[role="status"]')].find(
          (node) => node.textContent === saved,
        )
      : null;
    let control: HTMLElement | undefined = named ?? tabControls.get(selectedTab);
    // Disabling Save or replacing its editor can leave focus on the body. Restore it then, but
    // don't take it back from a control the reader reached while saving.
    const focusMoved = Boolean(document.activeElement) && document.activeElement !== document.body;
    if (status && focusMoved) {
      // No control we focus names the status then, so it announces itself: a live region speaks
      // when its text changes after it is shown, not when it is inserted with it (finding 1641).
      announceAfterShown(status, saved);
    } else if (status && named) {
      // A status inserted with its text is rarely announced; the focused control names it.
      status.id = "draft-save-status";
      named.setAttribute("aria-describedby", status.id);
    } else if (status) {
      // A save that leaves nothing to save disables its own button; the status takes focus
      // instead of the tab bar above, which would scroll the reader away.
      status.tabIndex = -1;
      control = status;
    }
    if (!focusMoved) {
      control?.focus();
    }
  }

  async function renderTab({ activated = false } = {}) {
    // A Logs view left before it showed no longer holds the cards below it back.
    view.classList.remove("agent-logs-opening");
    const resumeDrafts = context.suspendDrafts();
    if (mountedTab) {
      mountedTab.resumeDrafts = resumeDrafts;
      for (const input of content.querySelectorAll<HTMLInputElement>('input[type="password"]')) {
        if (input.value) {
          mountedTab.reusable = false;
          input.value = "";
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
      if (mountedTab.reusable && !mountedTab.loading && mountedTab.pending === 0) {
        mountedTab.nodes = [...content.childNodes];
        // Its editor's block note returns with it, not the last built tab's (finding 1962).
        mountedTab.showBlock = showDraftEditorNavigationBlock;
        retainedTabs.set(mountedTab.id, mountedTab);
      }
      mountedTab = null;
    }
    // A tab the reader chose keeps its strip where it was used: the version evidence above it
    // hides for Workspace and Logs and returns for the others (finding 1518). At the top of the
    // page the heading stays in view instead.
    const stripTop = activated && window.scrollY > 0 ? tabs.getBoundingClientRect().top : null;
    renderDetailHeading();
    versionEvidence.hidden = ["workspace", "logs", "access"].includes(selectedTab);
    setLayoutShape();
    if (stripTop !== null) {
      const moved = tabs.getBoundingClientRect().top - stripTop;
      if (Math.abs(moved) >= 1) {
        window.scrollBy({ top: moved, left: 0, behavior: "instant" });
      }
    }
    const tab = selectedTab;
    const focusInStrip = tabs.contains(document.activeElement);
    for (const [id, control] of tabControls) {
      control.setAttribute("aria-selected", String(id === tab));
      control.tabIndex = id === tab ? 0 : -1;
    }
    content.setAttribute("aria-labelledby", `${tabIds}-${tab}`);
    // History can select another tab while focus is in the strip; focus follows the selection,
    // so the focused tab is the one revealed and the Tab stop.
    if (focusInStrip && document.activeElement !== tabControls.get(tab)) {
      tabControls.get(tab)?.focus({ preventScroll: true });
    }
    revealSelectedTab();
    fadeTabEdges();
    refreshDeployControls();
    const retained = retainedTabs.get(tab);
    retainedTabs.delete(tab);
    if (retained?.nodes && retained.mutations === context.mutationVersion()) {
      mountedTab = retained;
      showDraftEditorNavigationBlock = retained.showBlock ?? showBlockInPanel;
      content.replaceChildren(...retained.nodes);
      // The deployment may have settled while this tab was parked.
      renderVersionNotice();
      retained.resumeDrafts?.();
      // So may a permission answer that changes Configuration access (finding 2421).
      redrawConfigurationAccessViews();
      return;
    }
    showDraftEditorNavigationBlock = showBlockInPanel;
    const state: MountedTab = {
      id: tab,
      reusable: true,
      loading: true,
      pending: 0,
      mutations: context.mutationVersion(),
    };
    mountedTab = state;
    const tabContext: DetailContext = {
      ...context,
      isCurrent: () => context.isCurrent() && mountedTab === state,
      request: async (path, options) => {
        state.pending += 1;
        try {
          return await context.request(path, options);
        } catch (error) {
          state.reusable = false;
          throw error;
        } finally {
          state.pending -= 1;
        }
      },
    };
    // Retain the panel's height during reads so loading does not jump the scroll position.
    content.style.minHeight = `${content.getBoundingClientRect().height}px`;
    content.replaceChildren();
    if (tab === "workspace") {
      const workspace = renderWorkspaceFiles(
        tabContext,
        currentAgent,
        path,
        latestPermissionsRead.then((permissions) => permissions?.operate),
      );
      state.refresh = workspace.refresh;
      if (workspace.applyOperate) {
        state.applyOperate = workspace.applyOperate;
      }
      content.append(workspace.section);
      state.loading = false;
      content.style.minHeight = "";
      return;
    }
    if (tab === "access") {
      // Share Agent moved here from the overview (spec 3.8, plan D1). The panel is built once per
      // page with the page's context, as it was on the overview: a share or removal in flight
      // finishes, and its progress shows again, when the reader leaves the tab and comes back.
      state.reusable = false;
      accessPanel ??= renderAgentAccess(context, agent, {
        onWriting: (writing) => {
          sharingWrite = writing;
          if (context.isCurrent()) {
            updateNavigationControls();
          }
        },
        onDenied: () => {
          // A refused policy read (the session probe could not tell) hides the tab, as the
          // panel hid on the overview; a reader on it is taken to Configuration instead. Focus
          // on the hidden tab moves to Configuration's.
          const control = tabControls.get("access");
          if (!control) {
            return;
          }
          const focused = document.activeElement === control;
          control.hidden = true;
          leaveDeniedAccess({ refocus: focused });
        },
      });
      if (tabControls.get("access")?.hidden) {
        // Back to a tab whose policy read was refused.
        leaveDeniedAccess();
      } else {
        content.append(accessPanel);
      }
      state.loading = false;
      content.style.minHeight = "";
      return;
    }
    if (tab === "policy") {
      state.reusable = false;
      // A remembered denial can predate a grant, so opening the tab compares it with a fresh
      // answer, which is not audited; an answer still in flight is that fresh answer.
      const settled = permissionsReadSettled;
      const policyReadAllowed = latestPermissionsRead.then((permissions) =>
        permissions?.sandboxPolicyRead === false && settled && tabContext.isCurrent()
          ? rereadPermissions().then((fresh) => fresh?.sandboxPolicyRead)
          : permissions?.sandboxPolicyRead,
      );
      // The version's snapshot says whether it runs in a Sandbox, whose log alone records
      // policy denials; without one the tab reads no log (finding 2484). The draft reads none.
      let sandboxLogSource: Promise<boolean | undefined> | undefined;
      if (selected !== "draft") {
        details ??= loadDetails();
        sandboxLogSource = details.then((result) =>
          result && "draft" in result && !result.draft
            ? result.snapshot.sandboxDriverId !== undefined
            : undefined,
        );
      }
      content.append(
        renderAgentDriverConfigurations(tabContext, {
          agent,
          revisionId: selected,
          policyReadAllowed,
          ...(sandboxLogSource ? { sandboxLogSource } : {}),
        }),
      );
      state.loading = false;
      content.style.minHeight = "";
      return;
    }
    if (tab === "logs") {
      // The version heading still comes from the snapshot read.
      details ??= loadDetails();
      // Polling views are rebuilt on every visit instead of being retained.
      state.reusable = false;
      // An answer still in flight when this view opened is read after it, so it is fresh.
      const openingRead = permissionsReadSettled ? null : latestPermissionsRead;
      const logs = renderAgentLogs(tabContext, {
        agent,
        revisionId: selected,
        shown: revealed,
        // A rebuilt view asks for a fresh answer when it remembers a status denial; a read
        // still in flight, or in flight when the view opened, is that answer.
        permissions: (options) =>
          options?.fresh && permissionsReadSettled && latestPermissionsRead !== openingRead
            ? rereadPermissions()
            : latestPermissionsRead,
        // The failed-version recovery stops offering Logs as soon as they are denied.
        onLogsDenied: () => {
          if (tabContext.isCurrent() && !recovery.section.hidden) {
            renderLatestDeployment();
          }
        },
      });
      content.append(logs.section);
      state.loading = false;
      // The pending view is nearly empty: Stop and Delete sat under it, then the strip and
      // output pushed them down 0.6-1.7 s later (finding 1479). Until the view shows, keep the
      // reserved height and keep those cards hidden; they appear in place in the same frame.
      view.classList.add("agent-logs-opening");
      void logs.firstView.then(() => {
        if (mountedTab === state) {
          content.style.minHeight = "";
          view.classList.remove("agent-logs-opening");
        }
      });
      // An address, reload or sign-in landing reveals the page already at the output once it is
      // ready, rather than at the top and then jumping to it (finding 1552).
      let scrolledOnReveal = false;
      if (!activated && view.classList.contains("agent-detail-pending")) {
        revealHold = Promise.all([details, logs.firstView]).then(
          () => {
            if (!view.classList.contains("agent-detail-pending")) {
              return;
            }
            scrollOnReveal = () => {
              scrollOnReveal = null;
              if (tabContext.isCurrent() && !deleting) {
                scrollToVersionDetail();
                scrolledOnReveal = true;
              }
            };
          },
          () => {},
        );
      }
      // Finish the overview layout and the Logs view's first reads before bringing this
      // version's output into view, so nothing above it grows afterwards (finding 1413).
      await Promise.all([details, revealed, logs.firstView]);
      // Lay the view out in one frame and scroll in the next: content below that moves in the
      // frame that scrolls counts as shifted (finding 1413).
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
      if (tabContext.isCurrent() && !deleting) {
        // A strip clicked in view with the output starting on screen stays put (finding 1518).
        // A link or address that opens Logs scrolls the output into view as before.
        const stripKept =
          activated &&
          tabs.getBoundingClientRect().top >= 0 &&
          content.getBoundingClientRect().top < innerHeight - Math.min(200, innerHeight / 3);
        if (stripKept || scrolledOnReveal) {
          tabControls.get("logs")?.focus({ preventScroll: true });
        } else {
          openVersionDetail({ animate: activated });
        }
      }
      return;
    }
    const pendingDetails = (details ??= loadDetails());
    if (pendingDetails !== settledDetails) {
      // Shown only if the read outlasts 250 ms (finding 1449).
      content.append(
        element("p", { role: "status", className: "delayed-status" }, "Loading configuration…"),
      );
    }
    const data = await pendingDetails;
    settledDetails = pendingDetails;
    if (!tabContext.isCurrent() || deleting) {
      return;
    }
    content.replaceChildren();
    state.loading = false;
    if (data && "error" in data) {
      state.reusable = false;
      content.append(
        errorPanel(
          data.error,
          tabContext,
          () => {
            context.deniedReads?.forget(snapshotPath);
            context.navigate(target(selected, selectedTab), namespaceId, true);
          },
          { version: selected !== "draft" },
        ),
      );
    } else if (data) {
      renderConfigurationTab(tabContext, tab, data);
    }
    content.style.minHeight = "";
  }

  function renderConfigurationTab(context: DetailContext, selectedTab: string, data: Details) {
    const { snapshot, values, draft, executionMode } = data;
    content.append(
      statusBlock("info", null, versionNotice(), [], { className: "version-selection-notice" }),
    );
    if (selectedTab === "repositories" && draft) {
      content.append(renderRepositoryTab(context, data));
    } else if (selectedTab === "plugins") {
      const plugins = renderAgentPlugins(context, {
        agent: { ...agent, harnessAuth: agent.harnessAuth ?? null },
        snapshot,
        draft,
        path,
        onState: (state) => {
          if (data.draft) {
            data.setPluginEditorState(state);
          }
        },
        savedNotice,
        saveDenied: agentSaveDenied,
        // Saves and reloads rebuild the tab in place (finding 1445's rest).
        onSaved: (savedAgent) => {
          if (!data.draft || agent.configurationReadError) {
            return;
          }
          // Rebuild from the save response: the editor confirmed its identity and settings, and
          // it carries the Agent's lifecycle, which a Stop or deployment since page load changed.
          // That identity check means agentForPage cannot throw; it only types the response.
          return refreshDraftInPlace({
            agent: agentForPage(savedAgent),
            saved: "Plugin selections saved.",
          });
        },
        onReload: () => {
          context.drafts.forget("plugins");
          return reloadDraftInPlace(context, { saved: "Plugin selections reloaded." });
        },
      });
      // Plugin blocks had no note of their own: the sidebar and Back refused in silence.
      showDraftEditorNavigationBlock = () =>
        showLeaveNote(plugins, draftEditorNavigationBlock, "after");
      content.append(plugins);
      if (draft) {
        followAgentSaveAccess(() => context.isCurrent() && plugins.isConnected);
      }
    } else if (selectedTab === "channels") {
      const { servicePrincipalId } = agent;
      // Bound Slack token Secrets this caller may not operate, which a save must replace.
      const channelReplace = draft ? channelBindingsReplace() : null;
      // Whether the last save left a Secret grant outstanding, for its saved notice.
      let channelGrantOutstanding = false;
      const channels = renderChannels({
        values,
        executionMode,
        readOnly: !draft || channelsReadOnly(),
        // Every deployment needs a model authentication source, so the drawer asks for one only
        // while the Agent has none; a deployed Agent with its key bound was told to set
        // credentials "before first deploy" (finding 2063).
        copy: {
          ...(draft && channelsReadOnly()
            ? {
                readOnlyDescription: `These are the version draft’s channel settings. ${channelsReadOnlyReason()}`,
                readOnlyCardMessage: "Read-only with your access.",
              }
            : {}),
          drawerNotice: `New version. Changes affect future deployments using this Configuration.${
            agent.harnessAuth
              ? ""
              : " Configure model credentials in the Credentials tab before deploying."
          }${channelReplace ? ` ${channelReplaceHint(channelReplace)}` : ""}`,
        },
        // Disable saves no bindings, so a binding it must replace refuses it (finding 2471).
        disableRefusal: channelDisableRefusal(channelReplace, snapshot.secretBindings),
        drawerContext: {
          drafts: context.drafts,
          baseline: JSON.stringify([
            snapshot.id,
            draft ? snapshot.generation : snapshot.configurationGeneration,
            servicePrincipalId,
          ]),
          operatorId: context.operatorId,
          namespaceId,
          request,
          agentName: agent.name,
          configurationId: draft ? snapshot.id : snapshot.configurationId,
          secretBindings: snapshot.secretBindings,
          isCurrent: context.isCurrent,
          onExpired: context.onExpired,
          secretsCreateAllowed: context.secretsCreateAllowed,
          secretsOperateDenied,
          credentialsHref: context.pageUrl(
            `agents/${agent.id}?revision=draft&tab=credentials`,
            namespaceId,
          ),
        },
        onSave: async (updatedValues, options = {}) => {
          if (!draft) {
            throw new Error("This version is read-only. Open the draft to edit its channels.");
          }
          // A save that keeps a bound Secret this caller may not operate would answer 403.
          const refusal = channelReplaceRefusal(
            channelBindingsReplace(),
            snapshot.secretBindings,
            options.secretBindings,
          );
          if (refusal) {
            throw new Error(refusal);
          }
          channelGrantOutstanding = false;
          let mutationStarted = false;
          let configurationSaved = false;
          try {
            const [freshAgent, freshConfig] = await Promise.all([
              readAgent(),
              readConfiguration(snapshot.id),
            ]);
            if (!context.isCurrent()) {
              throw new Error("This view has changed. Reopen the Configuration before saving.");
            }
            assertReadableConfiguration(freshAgent);
            if (freshAgent.servicePrincipalId !== servicePrincipalId) {
              throw Object.assign(
                new Error("The Agent identity changed. Reload this draft before saving channels."),
                { reloadRequired: true },
              );
            }
            if (
              freshAgent.configurationId !== snapshot.id ||
              freshConfig.generation !== snapshot.generation
            ) {
              // The section offers Reload draft; reopening the editor kept failing against
              // the page's old generation until a browser reload (finding 1480).
              throw Object.assign(new Error(CONFIGURATION_CHANGED), { reloadRequired: true });
            }
            mutationStarted = true;
            await saveConfigurationEdit(freshConfig, updatedValues, options.secretBindings);
            configurationSaved = true;
            details = null;
            const ungranted = (options.changedSecrets ?? []).map((secret) => secret.ref);
            if (ungranted.length && context.installationAdmin === false) {
              // This session is known not to administer the Installation, so it sends no grant
              // the API would refuse and audit. Credentials says nothing verified the Agent's
              // access and names who grants it, as the harness path does (findings 2109, 2263).
              const kept = (outstandingChannelGrants?.secrets ?? []).filter(
                (secret) => !ungranted.some((next) => next.id === secret.id),
              );
              // A grant an earlier request left refused or unconfirmed keeps its problem and Retry.
              setOutstandingChannelGrants({
                secrets: [...kept, ...ungranted],
                problem: kept.length
                  ? (outstandingChannelGrants?.problem ?? "unverified")
                  : "unverified",
              });
              channelGrantOutstanding = true;
              if (context.isCurrent()) {
                data.setDraftEditorState({ saving: false, outcomeUnknown: false });
                context.drafts.forget("channels");
              }
              return;
            }
            try {
              while (ungranted.length) {
                if (!context.isCurrent()) {
                  return;
                }
                await ensureCredentialOperateBinding(context, freshAgent, ungranted[0]!);
                ungranted.shift();
              }
            } catch (cause) {
              const { status, requestId } = requestFailure(cause);
              const problem = grantProblemFor(status);
              if (problem) {
                // A refused grant is a known outcome, not an unknown one: the Configuration
                // saved, and its Secrets wait in Credentials for Retry Secret access, which names
                // who can grant them. Only a lost answer, a timeout or a 5xx is unknown (finding
                // 1920).
                const kept = (outstandingChannelGrants?.secrets ?? []).filter(
                  (secret) => !ungranted.some((next) => next.id === secret.id),
                );
                setOutstandingChannelGrants({
                  secrets: [...kept, ...ungranted],
                  problem,
                });
                channelGrantOutstanding = true;
                if (context.isCurrent()) {
                  data.setDraftEditorState({ saving: false, outcomeUnknown: false });
                  context.drafts.forget("channels");
                }
                return;
              }
              // Keep the failed grant's status and Request ID: the notice names the ID for the
              // Installation administrator, and a 401 still ends the session below.
              throw Object.assign(
                new Error(
                  "Configuration saved, but Secret access grants could not be confirmed. Reload the draft, inspect saved bindings in Agent Credentials, then ask an Installation administrator to grant this Agent access to the saved Secret.",
                  { cause },
                ),
                {
                  outcomeUnknown: true,
                  ...(status === undefined ? {} : { status }),
                  ...(requestId === undefined ? {} : { requestId }),
                },
              );
            }
            const granted = new Set(options.changedSecrets?.map((secret) => secret.id));
            const still = outstandingChannelGrants?.secrets.filter(({ id }) => !granted.has(id));
            if (
              outstandingChannelGrants &&
              still?.length !== outstandingChannelGrants.secrets.length
            ) {
              setOutstandingChannelGrants(
                still?.length ? { ...outstandingChannelGrants, secrets: still } : null,
              );
            }
            if (context.isCurrent()) {
              data.setDraftEditorState({ saving: false, outcomeUnknown: false });
              context.drafts.forget("channels");
            }
          } catch (error) {
            if (!context.isCurrent()) {
              throw error;
            }
            if (!configurationSaved) {
              // A refused write names the chosen Secrets the caller may not operate, when a fresh
              // answer says so (finding 2453).
              const named =
                mutationStarted && requestFailure(error).status === 403
                  ? await refusedSecretBinding("configuration", options.changedSecrets ?? [])
                  : undefined;
              if (!context.isCurrent()) {
                throw error;
              }
              refusedSave(error, "configuration", mutationStarted, named);
            }
            if (requestFailure(error).status === 401) {
              context.onExpired();
              throw new Error("Your session has expired.", { cause: error });
            }
            if (isStaleGeneration(error) && mutationStarted && !configurationSaved) {
              // The PATCH found a newer generation than the reread: the same recovery applies.
              throw Object.assign(new Error(CONFIGURATION_CHANGED), { reloadRequired: true });
            }
            const fields = responseFields(error);
            const { status } = requestFailure(error);
            if (
              !configurationSaved &&
              (status !== undefined ||
                fields.name === "TimeoutError" ||
                fields.name === "TypeError")
            ) {
              fields.message =
                configurationConflictMessage(error, mutationStarted) ??
                rejectionMessage(error, mutationStarted);
            }
            fields.outcomeUnknown ??= mutationStarted && !refusedWriteStatuses.includes(status);
            throw error;
          }
        },
        onStateChange: ({ pending, outcomeUnknown, reloadRequired = false }) => {
          if (draft && context.isCurrent()) {
            data.setDraftEditorState({
              dirty: false,
              saving: pending,
              outcomeUnknown,
              reloadRequired,
            });
          }
        },
        savedNotice,
        // The section calls these once its dialog has closed; both rebuild the tab in place.
        // A grant left outstanding is not a finished save: the tab's warning says what remains.
        onSaved: (focus) =>
          refreshDraftInPlace({
            saved: channelGrantOutstanding ? "Configuration saved." : "Channels saved.",
            focus,
          }),
        // The section forgets its editor draft first unless a save conflict carried it.
        onReload: () => reloadDraftInPlace(context, { saved: "Draft reloaded." }),
      });
      const navigationFeedback = element("p", { className: "hint", role: "status" });
      showDraftEditorNavigationBlock = () => {
        navigationFeedback.textContent = draftEditorNavigationBlock;
      };
      // Saved Slack Secrets the Agent cannot use yet; Credentials retries the grant (finding 1920).
      const grantWarning = data.draft ? data.credentials?.grantWarning() : "";
      content.append(
        ...(grantWarning
          ? [
              statusBlock("warning", null, grantWarning, [
                versionLink("Open Credentials", "draft", "credentials"),
              ]),
            ]
          : []),
        channels,
        navigationFeedback,
      );
      // An answer that lands after this view changes whether it is read-only (finding 2421).
      if (draft) {
        const shownReadOnly = channelsReadOnly();
        const shownReplace = JSON.stringify(channelReplace);
        followConfigurationAccess(() => {
          if (
            context.isCurrent() &&
            mountedTab &&
            (channelsReadOnly() !== shownReadOnly ||
              JSON.stringify(channelBindingsReplace()) !== shownReplace)
          ) {
            // Rebuild, not restore: a reusable tab would be parked and shown again as it was.
            mountedTab.reusable = false;
            void renderTab();
          }
        });
      }
    } else if (selectedTab === "credentials" && draft) {
      const { credentials, channelSecretsNote } = data;
      const retained = context.drafts.get("authentication") as AuthenticationDraft | undefined;
      const baseline = retained?.baseline ?? {
        configurationId: agent.configurationId,
        harnessAuth: agent.harnessAuth,
        servicePrincipalId: agent.servicePrincipalId,
      };
      let syncUnsavedAuthentication = () => {};
      const auth = createHarnessAuthFields(
        { ...context, secretsOperateDenied },
        agent.harnessAuth,
        configuredHarnessId(values),
        {
          agentName: agent.name,
          draft: retained?.fields,
          onChange: () => syncUnsavedAuthentication(),
        },
      );
      const feedback = element("p", { role: "status", className: "hint" }, savedNotice);
      // Progress stays a quiet hint; a refusal is a danger block that takes focus, and a save
      // whose Secret access is unconfirmed a warning (finding 1966).
      const say = (text: string, tone: "danger" | "warning" | null = null) => {
        // The tone first: a refusal or warning is written into an alert (finding 2010).
        setStatusTone(feedback, tone);
        feedback.textContent = text;
        if (tone) {
          revealStatus(feedback, form);
        }
      };
      const save = element(
        "button",
        { type: "submit", className: "button button--primary" },
        "Save authentication source",
      );
      const reload = button("Reload authentication source", async () => {
        context.drafts.forget("authentication");
        reload.disabled = true;
        save.disabled = true;
        let fresh;
        try {
          // The tab's own request keeps this tab from being retained while the read is pending.
          fresh = await readAgent(context);
        } catch {
          if (context.isCurrent()) {
            data.setAuthenticationSaveState("idle");
            data.setAuthenticationPending(false);
            context.navigate(target("draft", "credentials"), namespaceId, true);
          }
          return;
        }
        if (context.isCurrent()) {
          // Rebuild in place; focus stays on Reload (finding 1446).
          await refreshDraftInPlace({ agent: fresh, focus: "Reload authentication source" });
        }
      });
      const updateNote = element("p", { className: "muted", role: "status", hidden: true });
      const form = element(
        "form",
        { className: "agent-card", novalidate: "" },
        auth.section,
        updateNote,
        // One action row, so Save and Reload keep the shared gap (finding 2386).
        element("div", { className: "form-actions" }, save, reload),
        feedback,
      );
      data.setAuthenticationForm(form);
      authenticationLeaveAnchor = form;
      let outcomeUnknown = retained?.outcomeUnknown ?? false;
      let pending = false;
      // Set when the caller's permission answer denies Agent update (finding 1530).
      let updateDenied = false;
      const applyUpdateDenial = (reason: string | undefined) => {
        // Retry credential access only rechecks the Secret grant; it is not an Agent update.
        if (savedAuthentication || (reason === undefined && !updateDenied)) {
          return;
        }
        updateDenied = reason !== undefined;
        updateNote.textContent = reason ?? "";
        updateNote.hidden = !updateDenied;
        // A save in flight sets the controls when it ends.
        if (!pending) {
          save.disabled = outcomeUnknown || updateDenied;
          // An edit that cannot be saved would only block Deploy (finding 1539).
          auth.setDisabled(outcomeUnknown || updateDenied);
        }
      };
      void agentSaveDenied.then((reason) => {
        if (context.isCurrent()) {
          applyUpdateDenial(reason);
        }
      });
      // A newer answer updates the form in place: the channel Secrets panel below it keeps its
      // state and focus (finding 2470).
      followConfigurationAccess(() => {
        if (context.isCurrent() && form.isConnected) {
          applyUpdateDenial(agentSaveDenial(callerPermissions, agent));
        }
      });
      let savedAuthentication = retained?.savedAuthentication ?? null;
      let grantProblem = retained?.grantProblem ?? null;
      // The shared grant wording (finding 1920), for the saved source's credential kind. A
      // refused grant request keeps Retry: it works once the reader's access is restored.
      const grantText = (problem: SecretGrantProblem) =>
        grantWarning(
          problem,
          harnessGrantSubject(
            savedAuthentication?.harnessAuth?.method === "credential_source"
              ? "credential_source"
              : "secret",
          ),
        ) +
        (problem === "refused" ? " Select Retry credential access once you have that access." : "");
      const originalFields = retained?.originalFields ?? auth.capture();
      const bindingFields = ({
        method,
        secretSource,
        credentialSource,
        account,
      }: AuthenticationFields) =>
        JSON.stringify({ method, secretSource, credentialSource, account });
      syncUnsavedAuthentication = () => {
        // Pending and saved states already gate deployment with their own messages.
        data.setAuthenticationUnsaved(
          !pending &&
            !outcomeUnknown &&
            !savedAuthentication &&
            bindingFields(auth.capture()) !== bindingFields(originalFields),
        );
        applySavedGrantWarning();
      };
      // The IAM answer is about the saved Secret. A later selection is what Save would grant,
      // so the warning follows that selection: another Secret clears it, and returning to the
      // saved Secret restores it. A submit since the read began still owns the status line.
      let submitted = false;
      form.addEventListener("submit", () => {
        submitted = true;
      });
      let savedGrantMissing = false;
      const missingGrantWarning = () =>
        grantWarning(
          "missing",
          harnessGrantSubject(
            agent.harnessAuth?.method === "credential_source" ? "credential_source" : "secret",
          ),
        );
      const selectionMatchesSavedGrant = () => {
        const saved = baseline.harnessAuth;
        const credential = harnessCredential(saved, context.namespaceId);
        if (!credential) {
          return false;
        }
        const fields = auth.capture();
        if (credential.kind === "secret") {
          return (
            saved?.method === fields.method &&
            fields.secretSource?.kind === "secret" &&
            fields.secretSource.id === credential.id &&
            fields.secretSource.namespaceId === credential.namespaceId
          );
        }
        return (
          fields.method === "credential_source" &&
          (fields.credentialSource === null || fields.credentialSource.id === credential.id)
        );
      };
      const applySavedGrantWarning = () => {
        if (submitted || savedAuthentication || outcomeUnknown) {
          return;
        }
        const warning = missingGrantWarning();
        if (savedGrantMissing && selectionMatchesSavedGrant()) {
          setStatusTone(feedback, "warning");
          feedback.textContent = warning;
          return;
        }
        if (feedback.textContent === warning) {
          setStatusTone(feedback, null);
          feedback.textContent = "";
        }
      };
      form.addEventListener("input", () => syncUnsavedAuthentication());
      form.addEventListener("change", () => syncUnsavedAuthentication());
      syncUnsavedAuthentication();
      context.drafts.track("authentication", () => {
        const fields = auth.capture();
        return pending ||
          outcomeUnknown ||
          savedAuthentication ||
          JSON.stringify(fields) !== JSON.stringify(originalFields)
          ? {
              fields,
              originalFields,
              baseline,
              savedAuthentication,
              outcomeUnknown: outcomeUnknown || pending,
              ...(grantProblem ? { grantProblem } : {}),
            }
          : undefined;
      });
      if (savedAuthentication) {
        save.textContent = "Retry credential access";
        // This session sent no grant because it cannot make one, so a Retry would be refused too.
        save.hidden = grantProblem === "unverified";
        auth.setDisabled(true);
        setStatusTone(feedback, "warning");
        feedback.textContent = grantProblem
          ? grantText(grantProblem)
          : "Authentication source saved. Retry credential access to confirm this Agent can use the selected Secret.";
      }
      if (outcomeUnknown) {
        save.disabled = true;
        auth.setDisabled(true);
        setStatusTone(feedback, "danger");
        feedback.textContent = "Outcome unknown. Reload authentication source before saving again.";
      }
      // This administrator's console read the saved source's grant as missing: saving the source
      // again grants it, which the shared wording names (finding 2260). The form is retained
      // while another tab is shown, so the answer is applied even when this tab is parked.
      void data.harnessGrantMissing().then((missing) => {
        savedGrantMissing = missing;
        applySavedGrantWarning();
      });
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        // The console's own errors under each field, not the browser's bubble (UX plan C3).
        if (!validateFields([...form.elements]) || save.disabled) {
          return;
        }
        let harnessAuth: HarnessAuthBinding | null;
        try {
          harnessAuth = savedAuthentication?.harnessAuth ?? (await auth.readBinding());
        } catch (error) {
          // Incomplete fields (no Secret, unfinished ChatGPT sign-in) say what to do next.
          say(error instanceof Error ? error.message : message(error), "danger");
          return;
        }
        save.disabled = true;
        pending = true;
        reload.disabled = true;
        auth.setDisabled(true);
        data.setAuthenticationSaveState("saving");
        data.setAuthenticationPending(true);
        say(savedAuthentication ? "Checking Secret access…" : "Saving authentication…");
        let mutationStarted = false;
        // Set once the grant request starts: a retry first rereads the Agent.
        let grantRequested = false;
        try {
          const current = await readAgent();
          if (!context.isCurrent()) {
            return;
          }
          assertReadableConfiguration(current);
          // The Agent as saved: this PATCH's response, or the fresh read on a retry.
          let savedAgent = current;
          const expected = savedAuthentication ?? baseline;
          const samePrincipal = current.servicePrincipalId === expected.servicePrincipalId;
          if (
            !samePrincipal ||
            current.configurationId !== expected.configurationId ||
            !sameValue(current.harnessAuth, expected.harnessAuth)
          ) {
            say(
              samePrincipal
                ? "The Configuration changed. Reload authentication source before saving."
                : "The Agent identity changed. Reload authentication source before continuing.",
              "danger",
            );
            outcomeUnknown = true;
            return;
          }
          if (!savedAuthentication) {
            const credentialSources = (current.credentialSources ?? []).filter(
              (source) =>
                current.harnessAuth?.method !== "credential_source" ||
                (harnessAuth?.method === "credential_source" &&
                  current.harnessAuth.sourceId === harnessAuth.sourceId) ||
                source.sourceId !== current.harnessAuth.sourceId,
            );
            if (
              harnessAuth?.method === "credential_source" &&
              !credentialSources.some((source) => source.sourceId === harnessAuth.sourceId)
            ) {
              credentialSources.push({ sourceId: harnessAuth.sourceId });
            }
            mutationStarted = true;
            const updated = agentForPage(
              await request(path, {
                method: "PATCH",
                expectedStatus: 200,
                body: { configurationId: expected.configurationId, harnessAuth, credentialSources },
              }),
            );
            if (
              updated.configurationReadError ||
              updated.configurationId !== expected.configurationId ||
              updated.servicePrincipalId !== current.servicePrincipalId ||
              !sameValue(updated.harnessAuth, harnessAuth) ||
              !sameValue(updated.credentialSources ?? [], credentialSources)
            ) {
              throw new Error("The response did not confirm this Agent’s authentication settings.");
            }
            savedAuthentication = updated;
            savedAgent = updated;
            details = null;
          }
          const credential = harnessCredential(harnessAuth, context.namespaceId);
          if (credential && context.installationAdmin === false) {
            // Granting writes IAM policy, which needs Installation administration. The session
            // already knows this member lacks it, so it sends no grant that would be refused, and
            // no IAM read either. Nothing verified the Agent's access, which an administrator may
            // already have granted. It names who grants it, as Create Agent does (findings 2109,
            // 2259).
            grantProblem = "unverified";
            if (context.isCurrent()) {
              say(grantText(grantProblem), "warning");
              // The binding saved and nothing in this session can confirm the grant, so Deploy
              // is not held: the API checks the Agent's access when it deploys (finding 2547).
              data.setAuthenticationPending(false);
            }
            return;
          }
          if (credential) {
            say(
              credential.kind === "credential_source"
                ? "Authentication saved. Checking credential source access…"
                : "Authentication saved. Checking Secret access…",
            );
            grantRequested = true;
            await ensureCredentialOperateBinding(context, current, credential);
          }
          if (context.isCurrent()) {
            context.drafts.forget("authentication");
            await refreshDraftInPlace({
              agent: savedAgent,
              saved: "Authentication source saved.",
              focus: "Save authentication source",
            });
          }
        } catch (error) {
          if (!context.isCurrent()) {
            return;
          }
          if (requestFailure(error).status === 401) {
            context.onExpired();
          } else if (savedAuthentication) {
            const { status, requestId } = requestFailure(error);
            const requestNote = requestId ? ` Request ID: ${requestId}` : "";
            if (!grantRequested) {
              // A retry rereads the Agent before any grant request: its failure is about that
              // read, not the grant, and Retry stays for when the Agent reads again.
              say(
                `Authentication source saved, but this Agent could not be read before retrying its credential access. ${message(error)}${requestNote} Select Retry credential access once the Agent can be read.`,
                "warning",
              );
            } else {
              // The shared classifier: a refused grant request (403) names who grants it and
              // keeps Retry; a lost answer or a server error stays unconfirmed (findings 1920,
              // 2259).
              grantProblem = grantProblemFor(status) ?? "unconfirmed";
              say(
                grantText(grantProblem) +
                  (grantProblem === "refused" ? "" : ` ${message(error)}`) +
                  requestNote,
                "warning",
              );
            }
          } else {
            const fields = responseFields(error);
            // A refused write names the chosen Secret when a fresh answer says the caller may not
            // operate it (finding 2453).
            const chosen = auth.changedSecret;
            const named =
              mutationStarted && requestFailure(error).status === 403 && chosen
                ? await refusedSecretBinding("agent", [chosen])
                : undefined;
            if (!context.isCurrent()) {
              return;
            }
            outcomeUnknown =
              fields.outcomeUnknown === true ||
              (mutationStarted && !refusedWriteStatuses.includes(requestFailure(error).status));
            say(
              fields.outcomeUnknown && typeof fields.message === "string"
                ? fields.message
                : rejectionMessage(
                    refusedSave(error, "agent", mutationStarted, named),
                    mutationStarted,
                  ),
              "danger",
            );
            data.setAuthenticationPending(outcomeUnknown);
          }
        } finally {
          if (context.isCurrent()) {
            data.setAuthenticationSaveState(outcomeUnknown ? "uncertain" : "idle");
            save.textContent = savedAuthentication
              ? "Retry credential access"
              : "Save authentication source";
            save.hidden = savedAuthentication !== null && grantProblem === "unverified";
            pending = false;
            reload.disabled = false;
            save.disabled = outcomeUnknown || updateDenied;
            auth.setDisabled(outcomeUnknown || savedAuthentication !== null || updateDenied);
            syncUnsavedAuthentication();
          }
        }
      });
      content.append(form);
      if (credentials?.section) {
        content.append(credentials.section);
      } else if (channelSecretsNote) {
        content.append(
          element(
            "section",
            { className: "agent-card channel-secrets" },
            element("h2", {}, "Channel Secrets"),
            element("p", { className: "hint", role: "status" }, channelSecretsNote),
          ),
        );
      }
    } else {
      const repositoryBindings = draft
        ? agent.repositoryBindings
        : snapshot.repositoryCredentials?.bindings;
      const details: Parameters<typeof summary>[1] = [
        ["Execution mode", executionMode === "dedicated" ? "Dedicated" : "Embedded"],
        ["Backend (experimental)", draft ? agent.backendId : snapshot.backendId],
        [
          "Repository access",
          repositoryBindings
            ?.map(
              (binding) =>
                `${binding.repositoryRef} · ${repositoryProfile(binding.profile)?.label ?? "Unknown access level"}`,
            )
            .join(", ") ?? "None",
        ],
        [
          "Harness authentication",
          renderHarnessAuthSummary(context, draft ? agent.harnessAuth : snapshot.harnessAuth),
        ],
        ["Created", displayDate(snapshot.createdAt)],
      ];
      if (!draft) {
        details.push(
          ["Harness", `${snapshot.harness.id} · ${snapshot.harness.version}`],
          ["Compute", `${snapshot.compute.id} · ${snapshot.compute.implementation}`],
        );
      }
      let currentConfigurationEntry: HTMLButtonElement | null = null;
      if (!draft) {
        // A caller who may not edit the Configuration opens the draft to read it; the entry does
        // not offer an editor it has none of (finding 2436).
        const entryLabel = () =>
          configurationReadOnly() ? "Open version draft" : "Edit current Configuration";
        const entry = button(entryLabel(), () => {
          const edit = !configurationReadOnly();
          // The draft this navigation opens takes it with its editor open. Saving
          // patches the Configuration, which the API authorizes on its own.
          linkedVersionView = {
            key: linkedKey("draft", "configuration"),
            load: consoleLoads + 1,
            edit,
          };
          context.navigate(target("draft", "configuration"));
        });
        followConfigurationAccess(() => {
          if (context.isCurrent() && entry.isConnected) {
            entry.textContent = entryLabel();
          }
        });
        currentConfigurationEntry = entry;
      }
      content.append(
        element(
          "section",
          { className: "agent-card" },
          element("h2", {}, draft ? "Configuration draft" : "Configuration snapshot"),
          summary(values, details),
          repositoryBindings?.some((binding) => repositoryProfile(binding.profile)?.writes)
            ? element("p", { className: "hint repository-write-access" }, repositoryWriteAccessHelp)
            : null,
          draft
            ? renderDraftConfigurationEditor(context, data)
            : element(
                "div",
                {},
                element("div", { className: "form-actions" }, currentConfigurationEntry),
                nativeDocument(values, "View admitted native configuration"),
              ),
        ),
      );
    }
  }

  // The repository choices read needs Agent update, so a caller whose permission answer denies it
  // reads the saved repository access instead of a refused editor, and is not sent a read that
  // answers 403 (finding 2454). As on Plugins, a caller missing only a grant that each Agent update
  // also checks reads the summary too: no save could keep an edit. An unknown answer keeps the
  // editor.
  function renderRepositoryTab(context: DetailContext, data: DraftDetails) {
    const holder = element("div", {});
    let shown: Element = holder;
    void agentSaveDenied.then((reason) => {
      if (!context.isCurrent() || !holder.parentNode) {
        return;
      }
      shown =
        reason === undefined
          ? renderRepositoryEditor(context, data)
          : repositoryAccessSummary(reason);
      holder.replaceWith(shown);
    });
    followAgentSaveAccess(() => context.isCurrent() && shown.isConnected);
    return holder;
  }

  function repositoryAccessSummary(reason: string) {
    const bindings = agent.repositoryBindings ?? [];
    return element(
      "section",
      { className: "agent-card" },
      element("h2", {}, "Repository access"),
      element(
        "p",
        { className: "muted" },
        bindings.length
          ? "These are the version draft’s repository selections, read-only with your access. The next deployment uses them as saved."
          : "The version draft selects no repositories. The Agent runs without repository access.",
      ),
      bindings.length
        ? element(
            "ul",
            { className: "repository-access-summary" },
            ...bindings.map((binding) =>
              element(
                "li",
                {},
                `${binding.repositoryRef} · ${repositoryProfile(binding.profile)?.label ?? "Unknown access level"}`,
              ),
            ),
          )
        : null,
      bindings.some((binding) => repositoryProfile(binding.profile)?.writes)
        ? element("p", { className: "hint repository-write-access" }, repositoryWriteAccessHelp)
        : null,
      element("p", { className: "muted", role: "status" }, reason),
    );
  }

  function renderRepositoryEditor(context: DetailContext, data: DraftDetails) {
    // Drawn only when the permission answer allows Agent saves or is unknown: a caller it denies
    // reads the summary instead (renderRepositoryTab).
    let saveState = "idle";
    const feedback = element("p", { className: "hint", role: "status" }, savedNotice);
    // A refused save is a danger block that takes focus; other notes stay a hint (finding 1966).
    const refuse = (text: string) => {
      setStatusTone(feedback, "danger");
      feedback.textContent = text;
      revealStatus(feedback, feedback.closest("section") ?? undefined);
    };
    // Reload and Cancel reread the Agent and rebuild this tab in place (finding 1445's rest).
    // Set once Reload or Cancel starts rereading; this editor is about to be replaced.
    let reloading = false;
    function rebuild(saved: string, focus?: string) {
      reloading = true;
      update();
      void reloadDraftInPlace(context, { saved, focus });
    }
    const reload = button("Reload draft", () => rebuild("Draft reloaded."));
    const save = button("Save repository access", () => void submit(), {
      tone: "primary",
      disabled: true,
    });
    const cancel = button("Cancel", () => {
      data.setDraftEditorState({
        dirty: false,
        saving: false,
        outcomeUnknown: false,
        reloadRequired: false,
      });
      rebuild("", "Cancel");
    });
    const actions = element("div", { className: "form-actions" }, save, cancel, reload);
    function update() {
      if (reloading) {
        // A Save during the reread would write the edit being discarded, and a late field
        // update (repository choices loading, say) must not enable it again.
        reload.disabled = true;
        cancel.disabled = true;
        save.disabled = true;
        fields?.setDisabled(true);
        return;
      }
      const dirty = fields?.isDirty() ?? false;
      const pending = saveState === "saving";
      const outcomeUnknown = saveState === "uncertain";
      const reloadRequired = saveState === "conflict";
      const locked = saveState !== "idle";
      data.setDraftEditorState({ dirty, saving: pending, outcomeUnknown, reloadRequired });
      save.disabled = locked || !dirty || !fields?.isSettled() || fields.blocksCreate();
      if (save.getAttribute("aria-busy") !== String(pending)) {
        save.setAttribute("aria-busy", String(pending));
      }
      cancel.disabled = locked;
      reload.hidden = !outcomeUnknown && !reloadRequired;
      // Without repository access in the Installation only removing every repository can be
      // saved (finding 2398). Otherwise the status says so: Save is not offered, and Cancel only
      // to undo an edit (finding 2386).
      // A control hidden while focused would drop focus to the page, so the tab takes it.
      const hide = (control: HTMLButtonElement, hidden: boolean) => {
        if (hidden && document.activeElement === control) {
          tabControls.get(selectedTab)?.focus({ preventScroll: true });
        }
        control.hidden = hidden;
      };
      hide(save, !saveOffered());
      hide(cancel, Boolean(fields?.notConfigured()) && !dirty);
      actions.hidden = save.hidden && cancel.hidden && reload.hidden;
      fields?.setDisabled(locked);
    }
    const fields = createRepositoryFields(
      context,
      (changed) => {
        if (changed) {
          setStatusTone(feedback, null);
          feedback.textContent = fields.isDirty()
            ? pendingEditGuidance("deploying")
            : "No repository changes to save.";
        }
        update();
      },
      { ...agent, agentId: agent.id },
    );
    showDraftEditorNavigationBlock = () => {
      setStatusTone(feedback, null);
      feedback.textContent = draftEditorSaving
        ? draftEditorNavigationBlock
        : pendingEditGuidance("leaving this tab");
    };
    function saveOffered() {
      return !fields?.notConfigured() || (fields.isDirty() && fields.bindings().length === 0);
    }
    // While Save is not offered, the guidance names only what the tab offers (finding 2398).
    function pendingEditGuidance(before: string) {
      return saveOffered()
        ? `Save or cancel repository changes before ${before}.`
        : `Remove every repository and save, or cancel repository changes, before ${before}.`;
    }
    async function submit() {
      if (save.disabled || !fields.validate()) {
        return;
      }
      saveState = "saving";
      update();
      let mutationStarted = false;
      let saved = false;
      try {
        const fresh = await readAgent();
        if (!context.isCurrent()) {
          return;
        }
        if (
          fresh.configurationId !== agent.configurationId ||
          JSON.stringify(fresh.repositoryAccess) !== JSON.stringify(agent.repositoryAccess) ||
          JSON.stringify(fresh.repositoryBindings) !== JSON.stringify(agent.repositoryBindings)
        ) {
          saveState = "conflict";
          refuse(
            "Repository access changed while you were editing. Reload this draft before saving.",
          );
          return;
        }
        // TODO: enforce an expected Agent version in PATCH when draft concurrency
        // is implemented; this preflight cannot prevent a write between requests.
        mutationStarted = true;
        const repositoryAccess = fields.access();
        const savedAgent = agentForPage(
          await request(path, {
            method: "PATCH",
            expectedStatus: 200,
            body: { configurationId: fresh.configurationId, repositoryAccess },
          }),
        );
        if (
          savedAgent.configurationReadError ||
          savedAgent.configurationId !== fresh.configurationId ||
          !sameValue(savedAgent.repositoryAccess, repositoryAccess)
        ) {
          throw new Error("The response did not confirm this Agent’s repository access.");
        }
        saved = true;
        fields.recordSuccessfulSave();
        if (context.isCurrent()) {
          data.setDraftEditorState({ dirty: false, saving: false });
          await refreshDraftInPlace({ agent: savedAgent, saved: "Repository access saved." });
        }
      } catch (error) {
        if (!context.isCurrent()) {
          return;
        }
        if (requestFailure(error).status === 401) {
          context.onExpired();
        } else {
          refuse(
            rejectionMessage(
              saved ? error : refusedSave(error, "agent", mutationStarted),
              mutationStarted,
            ),
          );
          if (mutationStarted && !refusedWriteStatuses.includes(requestFailure(error).status)) {
            saveState = "uncertain";
          }
        }
      } finally {
        if (saveState === "saving") {
          saveState = "idle";
        }
        if (context.isCurrent()) {
          update();
        }
      }
    }
    update();
    return element("section", { className: "agent-card" }, fields.section, actions, feedback);
  }

  // Edits carried through a save conflict, merged over the Configuration Reload draft reread
  // (finding 1512). Returns the editor draft to open and a note on what was applied.
  function carriedConfigurationDraft(
    context: DetailContext,
    snapshot: Configuration,
    values: OpenClawConfigurationDocument,
  ) {
    const retained = context.drafts.get("configuration") as ConfigurationDraft | undefined;
    if (!retained?.carried) {
      return { retained, note: "" };
    }
    const initialText = JSON.stringify(values, null, 2);
    if (retained.baseline?.id !== snapshot.id) {
      context.drafts.forget("configuration");
      return {
        retained: undefined,
        note: "Your Configuration edits were not reapplied: this Agent now uses another Configuration.",
      };
    }
    const merged = carryDocument(
      JSON.parse(retained.initialText),
      JSON.parse(retained.text),
      values,
    );
    const text = JSON.stringify(merged.value, null, 2);
    if (text === initialText) {
      // Nothing left to apply: a plain reload of the saved Configuration.
      context.drafts.forget("configuration");
      return { retained: undefined, note: "" };
    }
    const shown = (value: unknown) => {
      const json = value === undefined ? "removed" : JSON.stringify(value);
      return json.length > 60 ? `${json.slice(0, 59)}…` : json;
    };
    const conflicts = merged.conflicts
      .slice(0, 5)
      .map(({ path, saved }) => `${path} (saved: ${shown(saved)})`);
    const more = merged.conflicts.length > 5 ? ` and ${merged.conflicts.length - 5} more` : "";
    // Objects where each browser changed other keys are merged, not conflicts, but their keys
    // may belong together, so the note names them (finding 1524).
    const mixed = merged.mixed.slice(0, 5).join(", ");
    const moreMixed = merged.mixed.length > 5 ? ` and ${merged.mixed.length - 5} more` : "";
    return {
      retained: {
        text,
        initialText,
        baseline: { id: snapshot.id, generation: snapshot.generation },
        outcomeUnknown: false,
        reloadRequired: false,
      },
      note: `Your edits are applied over the reloaded Configuration.${
        conflicts.length
          ? ` Another browser also changed ${conflicts.join(", ")}${more}; yours are shown.`
          : ""
      }${
        mixed
          ? ` Both browsers changed different keys in ${mixed}${moreMixed}; check they still fit together.`
          : ""
      } Review them, then save.`,
    };
  }

  function renderDraftConfigurationEditor(context: DetailContext, data: DraftDetails) {
    const { snapshot, values, setDraftEditorState } = data;
    const container = element("div", { className: "configuration-draft-editor" });
    const { retained, note: carriedNote } = carriedConfigurationDraft(context, snapshot, values);
    let baseline = retained?.baseline ?? { id: snapshot.id, generation: snapshot.generation };
    let editing = Boolean(retained);
    let pending = false;
    let outcomeUnknown = retained?.outcomeUnknown ?? false;
    let reloadRequired = retained?.reloadRequired ?? false;
    let initialText = retained?.initialText ?? JSON.stringify(values, null, 2);
    const editor = element("textarea", {
      id: "configuration-json",
      name: "configuration",
      required: "",
      rows: "18",
      className: "configuration-editor",
      spellcheck: "false",
      "aria-describedby": "configuration-json-hint",
    });
    // Invalid JSON is reported under the editor, never by the browser's bubble (finding 1903).
    const editorError = fieldError(editor);
    editor.value = retained?.text ?? initialText;
    context.drafts.track("configuration", () =>
      editing
        ? {
            text: editor.value,
            initialText,
            baseline,
            outcomeUnknown: outcomeUnknown || pending,
            reloadRequired,
          }
        : undefined,
    );
    // An open but unchanged editor is no unsaved work.
    context.drafts.unsavedWhen("configuration", (value) => {
      const draft = value as ConfigurationDraft | undefined;
      return !!draft && (draft.text !== draft.initialText || !!draft.outcomeUnknown);
    });
    const feedback = element(
      "p",
      { className: "hint", role: "status", id: "configuration-editor-feedback" },
      [savedNotice, carriedNote].filter(Boolean).join(" "),
    );
    // The carried-edits note stays until the reader edits again.
    let feedbackLocked = Boolean(carriedNote);
    // Entering the editor replaces the pressed button; focus moves to the editor (finding 1620).
    function startEditing() {
      editing = true;
      render();
      editor.focus({ preventScroll: true });
    }
    const edit = button("Edit Configuration", startEditing, {
      "data-opens": "configuration-editor",
    });
    const gateway = responseFields(values.gateway);
    const gatewayAuth = responseFields(gateway.auth);
    const password = responseFields(gatewayAuth.password);
    const usesGeneratedGatewayPassword =
      password?.source === "env" &&
      (password.provider === undefined || password.provider === "default") &&
      password.id === "OPENCLAW_GATEWAY_PASSWORD";
    // A version admitted from this exact Configuration generation already carries the reference.
    const gatewayPasswordRevision = visibleRevisions.find(
      (revision) =>
        revision.configurationId === snapshot.id &&
        revision.configurationGeneration === snapshot.generation,
    );
    const enableGatewayPassword = button("Enable gateway password access", () => {
      // Stage the native reference through the same draft and save checks as JSON edits.
      // The Compute Driver delivers the generated value only after deployment.
      editor.value = JSON.stringify(
        {
          ...values,
          gateway: {
            ...gateway,
            auth: {
              ...gatewayAuth,
              password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
            },
          },
        },
        null,
        2,
      );
      startEditing();
    });
    const save = button("Save Configuration", () => void saveConfiguration(), {
      tone: "primary",
      // Reload draft focuses Save after carrying edits; the note says what was applied.
      ...(carriedNote && retained ? { "aria-describedby": feedback.id } : {}),
    });
    const cancel = button("Cancel", () => {
      baseline = { id: snapshot.id, generation: snapshot.generation };
      initialText = JSON.stringify(values, null, 2);
      editing = false;
      editor.value = initialText;
      editorError.clear();
      feedback.textContent = "";
      setStatusTone(feedback, null);
      feedback.setAttribute("role", "status");
      reloadRequired = false;
      setDraftEditorState({
        dirty: false,
        saving: false,
        outcomeUnknown: false,
        reloadRequired: false,
      });
      render();
      // Cancel leaves with the editor; its replacement control keeps focus (finding 1446).
      edit.focus();
    });
    const reload = button("Reload draft", () => {
      // After a save conflict the edits are merged over the reread Configuration instead of
      // dropped (finding 1512); an unknown outcome starts from the saved state.
      const carry =
        reloadRequired && !outcomeUnknown && currentDirty() && parseEditor() !== undefined;
      if (carry) {
        const carried = { carried: true, text: editor.value, initialText, baseline };
        context.drafts.track("configuration", () => carried);
      } else {
        context.drafts.forget("configuration");
      }
      reload.disabled = true;
      void reloadDraftInPlace(context, {
        saved: "Draft reloaded.",
        focus: carry ? ["Save Configuration", "Edit Configuration"] : "Edit Configuration",
      });
    });

    function currentDirty() {
      return editor.value !== initialText;
    }

    function parseEditor(reportInvalid = false) {
      const problem = jsonObjectProblem(editor.value);
      if (problem === undefined) {
        return JSON.parse(editor.value) as OpenClawConfigurationDocument;
      }
      if (reportInvalid) {
        // One message, under the editor, which keeps focus so the JSON can be fixed in place.
        editorError.show(problem);
        feedback.textContent = "";
        feedbackLocked = true;
        editor.focus();
      }
      return undefined;
    }

    function updateState() {
      const dirty = editing && currentDirty();
      setDraftEditorState({
        dirty,
        saving: pending,
        outcomeUnknown,
        reloadRequired,
      });
      save.disabled = pending || outcomeUnknown || reloadRequired || !dirty;
      // A save in flight is busy, not unavailable: the progress cursor (finding 1927). Written
      // only on a change, so a rerender is no DOM mutation.
      if (save.getAttribute("aria-busy") !== String(pending)) {
        save.setAttribute("aria-busy", String(pending));
      }
      cancel.disabled = pending || outcomeUnknown || reloadRequired;
      edit.disabled = pending || outcomeUnknown;
      enableGatewayPassword.disabled = pending || outcomeUnknown || reloadRequired;
      editor.readOnly = pending || outcomeUnknown || reloadRequired;
      if (outcomeUnknown) {
        setStatusTone(feedback, "danger");
        feedback.textContent =
          "Outcome unknown. Configuration may have been saved. Reload this draft before saving again.";
        feedbackLocked = true;
      } else if (reloadRequired) {
        if (!feedbackLocked) {
          setStatusTone(feedback, "danger");
          feedback.textContent = "Reload this draft before saving again.";
        }
        feedbackLocked = true;
      } else if (pending) {
        if (!feedbackLocked) {
          feedback.textContent = "Checking Configuration…";
        }
      } else if (dirty) {
        if (!feedbackLocked) {
          feedback.textContent = "Save or cancel these Configuration edits before deploying.";
        }
      } else if (!pending && editing) {
        if (!feedbackLocked) {
          feedback.textContent = "No Configuration changes to save.";
        }
      }
    }

    editor.addEventListener("input", () => {
      editorError.clear();
      feedback.textContent = "";
      setStatusTone(feedback, null);
      feedback.setAttribute("role", "status");
      feedbackLocked = false;
      reloadRequired = false;
      updateState();
    });
    showDraftEditorNavigationBlock = () => {
      if (draftEditorNavigationBlock) {
        setStatusTone(feedback, null);
        feedback.setAttribute("role", "status");
        feedback.textContent = draftEditorNavigationBlock;
        feedbackLocked = true;
      }
    };

    async function saveConfiguration() {
      if (pending || outcomeUnknown || !currentDirty()) {
        return;
      }
      const nextValues = parseEditor(true);
      if (nextValues === undefined) {
        updateState();
        return;
      }
      pending = true;
      setStatusTone(feedback, null);
      feedback.setAttribute("role", "status");
      feedback.textContent = "Checking Configuration…";
      feedbackLocked = true;
      const saveFocused = document.activeElement === save;
      updateState();
      // Save is disabled while it runs; its status takes focus so a keyboard reader is not
      // dropped to the page, as Deploy's does (finding 1646).
      if (saveFocused) {
        focusSaveOutcome(container, [], feedback);
      }
      let mutationStarted = false;
      let configurationSaved = false;
      let refusedInEditor = false;
      try {
        const [freshAgent, freshConfig] = await Promise.all([
          readAgent(),
          readConfiguration(baseline.id),
        ]);
        if (!context.isCurrent()) {
          return;
        }
        assertReadableConfiguration(freshAgent);
        if (
          freshAgent.configurationId !== baseline.id ||
          freshConfig.generation !== baseline.generation
        ) {
          // An alert before its text is written (finding 2010).
          setStatusTone(feedback, "danger");
          feedback.textContent = CONFIGURATION_CHANGED;
          feedbackLocked = true;
          reloadRequired = true;
          return;
        }
        mutationStarted = true;
        await saveConfigurationEdit(freshConfig, nextValues);
        configurationSaved = true;
        if (context.isCurrent()) {
          context.drafts.forget("configuration");
          await refreshDraftInPlace({
            saved: "Configuration saved.",
            focus: "Edit Configuration",
          });
        }
      } catch (error) {
        if (!context.isCurrent()) {
          return;
        }
        if (requestFailure(error).status === 401) {
          context.onExpired();
          return;
        }
        // Every refusal below is a danger block: an alert before its text is written.
        feedback.setAttribute("role", "alert");
        if (!configurationSaved) {
          refusedSave(error, "configuration", mutationStarted);
        }
        if (isStaleGeneration(error) && mutationStarted && !configurationSaved) {
          setStatusTone(feedback, "danger");
          feedback.textContent = CONFIGURATION_CHANGED;
          feedbackLocked = true;
          reloadRequired = true;
          return;
        }
        // The edited JSON holds the refused channel reference (finding 2319). Like invalid JSON,
        // it gets one message, under the editor, which takes focus (finding 2494). This editor
        // saves no Secret bindings, so a refusal that asks for one says where the console makes it.
        const channelRefusal = channelBindingRefusal(error);
        if (channelRefusal !== undefined) {
          editorError.show(
            channelRefusal.includes(" in secretBindings")
              ? `${channelRefusal} ${CHANNEL_BINDING_CONSOLE_REMEDY}`
              : channelRefusal,
          );
          setStatusTone(feedback, null);
          feedback.textContent = "";
          refusedInEditor = true;
        } else {
          setStatusTone(feedback, "danger");
          feedback.textContent =
            configurationConflictMessage(error, mutationStarted && !configurationSaved) ??
            rejectionMessage(error, mutationStarted);
        }
        feedbackLocked = true;
        outcomeUnknown =
          mutationStarted && !refusedWriteStatuses.includes(requestFailure(error).status);
      } finally {
        if (context.isCurrent()) {
          pending = false;
          updateState();
          render();
          const refused = feedback.dataset.tone === "danger";
          feedback.setAttribute("role", refused ? "alert" : "status");
          if (refusedInEditor && container.isConnected) {
            editor.focus({ preventScroll: true });
            editor.scrollIntoView({ block: "nearest" });
          } else if (container.isConnected && refused && !outcomeUnknown && !reloadRequired) {
            // A refusal Reload cannot fix (a 403, say) is an alert that takes focus and comes
            // into view; under the fold, nothing seemed to happen (finding 1991).
            revealStatus(feedback, container);
          } else if (container.isConnected) {
            // A conflict or failure leaves Reload draft (or Save again) as the next step
            // (finding 1481).
            focusSaveOutcome(container, [reload, save], feedback);
            if (refused && container.contains(document.activeElement)) {
              feedback.scrollIntoView({ block: "nearest" });
            }
          }
        }
      }
    }

    let shownReadOnly = false;
    function render() {
      shownReadOnly = !editing && configurationReadOnly();
      if (shownReadOnly) {
        // A reader views the saved JSON; no editor whose Save would answer 403 (finding 2421).
        container.replaceChildren(
          element("p", { className: "hint" }, configurationReadOnlyReason()),
          nativeDocument(values, "View native Configuration"),
          ...(feedback.textContent ? [feedback] : []),
        );
        return;
      }
      if (!editing) {
        container.replaceChildren(
          element(
            "p",
            { className: "hint" },
            usesGeneratedGatewayPassword
              ? gatewayPasswordRevision
                ? `Gateway password access is enabled in the saved Configuration and included in v${gatewayPasswordRevision.revision}.`
                : "Gateway password access is enabled in the saved Configuration. Deploy a new version to apply it."
              : "Use generated credentials for direct gateway password access. Enable access, save Configuration, then deploy a new version.",
          ),
          element(
            "div",
            { className: "form-actions" },
            edit,
            usesGeneratedGatewayPassword ? null : enableGatewayPassword,
          ),
          nativeDocument(values, "View native Configuration"),
          ...(feedback.textContent ? [feedback] : []),
        );
        return;
      }
      updateState();
      container.replaceChildren(
        element(
          "div",
          { className: "form-field" },
          element("label", { for: "configuration-json" }, "Configuration JSON"),
          editor,
          editorError.node,
          element(
            "p",
            { className: "hint", id: "configuration-json-hint" },
            "Edit native JSON values for future deployments. Secret bindings are preserved separately.",
          ),
        ),
        element(
          "div",
          { className: "form-actions" },
          save,
          cancel,
          outcomeUnknown || reloadRequired ? reload : null,
        ),
        feedback,
      );
    }

    render();
    // An answer that lands after this view changes whether it is read-only (finding 2421).
    followConfigurationAccess(() => {
      if (context.isCurrent() && !editing && configurationReadOnly() !== shownReadOnly) {
        render();
      }
    });
    return container;
  }

  view.append(dangerZone);
  context.setTabNavigation((next) => {
    const nextRevision = next.searchParams.get("revision") ?? agent.activeRevisionId ?? "draft";
    const requestedTab = next.searchParams.get("tab");
    const nextTab =
      requestedTab && tabsForSelection.has(requestedTab) ? requestedTab : "configuration";
    if (
      !context.isCurrent() ||
      deleting ||
      next.pathname !== url.pathname ||
      next.searchParams.get("namespace") !== namespaceId
    ) {
      return false;
    }
    if (nextRevision === selected && nextTab === selectedTab) {
      // The page's own reloads (a retry, a draft re-read) rebuild it: a share waits for them too.
      if (!sharingWrite) {
        return false;
      }
      showLeaveBlock();
      return true;
    }
    if (draftEditorBlocksNavigation()) {
      showLeaveBlock();
      // A recovery link refused here would look dead again: its refusal shows with the editor.
      if (takeLinkedVersionView(linkedKey(nextRevision, nextTab))) {
        openVersionDetail({ animate: true });
      }
      return "blocked";
    }
    if (nextRevision !== selected) {
      return false;
    }
    const linked = takeLinkedVersionView(linkedKey(nextRevision, nextTab));
    selectedTab = nextTab;
    // A Logs visit may have just been denied: the recovery stops offering its Logs link.
    if (!recovery.section.hidden) {
      renderLatestDeployment();
    }
    void renderTab({ activated: true });
    // Logs scrolls to its output once that has loaded.
    if (linked && nextTab !== "logs") {
      openVersionDetail({ animate: true, deploy: linked.deploy, edit: linked.edit });
    }
    return true;
  });
  if (selectedTab === "workspace") {
    void loadOverview();
  } else {
    details ??= loadDetails();
  }
  await renderTab();
  return agent;
}
