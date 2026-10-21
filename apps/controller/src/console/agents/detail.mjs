import { renderAgentDriverConfigurations } from "../driver-configurations.mjs";
import {
  button,
  element,
  fieldError,
  focusSaveOutcome,
  jsonObjectProblem,
  patchChildren,
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
import { pluginWarningText, renderAgentPlugins } from "./plugins.mjs";
import { repositoryProfile, repositoryWriteAccessHelp } from "./repository-profiles.mjs";
import { createRepositoryFields } from "./repositories.mjs";
import { renderChannels } from "../channels.mjs";
import { carryDocument } from "../carry.mjs";
import { renderWorkspaceFiles } from "./workspace.mjs";
import { logTextDenied, renderAgentLogs } from "./logs.mjs";
import {
  displayDate,
  shortId,
  namespacePath,
  refusedSave,
  AGENT_UPDATE_DENIED,
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
  outcomeLabel,
  neutralDeploymentOutcome,
  preAdmissionRefusal,
} from "./list.mjs";
import {
  createChannelSecretsPanel,
  hasRequiredChannelCredentials,
  channelCredentialBlockReason,
} from "./credentials.mjs";
import { ensureCredentialOperateBinding } from "./credential-access.mjs";

// One page of revision summaries, newest first (finding 1323). Summaries carry no saved
// settings; read the exact revision for those.
async function readRevisionPage(request, path, cursor = null) {
  const page = await request(
    cursor ? `${path}/revisions?cursor=${encodeURIComponent(cursor)}` : `${path}/revisions`,
    { includeMeta: true },
  );
  return { revisions: page.data, nextCursor: page.meta?.nextCursor ?? null };
}

// The pending write of each status that announceAfterShown is waiting to fill.
const pendingAnnouncements = new WeakMap();

// Empties a status just inserted with `text` and writes it again once screen readers have seen
// it empty, so they announce it as a change. A timer, unlike a frame, also runs in a hidden tab.
// A newer call replaces the pending write, so the status is written once (finding 1976).
function announceAfterShown(status, text) {
  clearTimeout(pendingAnnouncements.get(status)?.timer);
  status.textContent = "";
  const pending = { text };
  pending.timer = setTimeout(() => {
    pendingAnnouncements.delete(status);
    status.textContent = pending.text;
  }, 100);
  pendingAnnouncements.set(status, pending);
}

// Sets a status's text, or, while announceAfterShown waits to fill it, the text it will write:
// writing now as well would make a screen reader speak it twice.
function setAnnouncedText(status, text) {
  const pending = pendingAnnouncements.get(status);
  if (pending) {
    pending.text = text;
  } else {
    status.textContent = text;
  }
}

// Drops a status's pending write, for a status taken off the page.
function cancelAnnouncement(status) {
  clearTimeout(pendingAnnouncements.get(status)?.timer);
  pendingAnnouncements.delete(status);
}

// A 503 the deploy request answered before admission: no version was created, so Deploy stays
// available. Create Agent treats the same codes the same way (finding 1638).
function deployRefusedBeforeAdmission(error) {
  return (
    error.code === "RUNTIME_CREDENTIALS_CLUSTER_RBAC" || preAdmissionRefusal(error) !== undefined
  );
}

function deployFailureText(error, submitted) {
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
    return rejectionMessage(error, submitted);
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
    ? "Deployment denied. Check Agent deploy permission and access to selected Secrets. First deployment also needs Agent read and operate permissions to create connection credentials. Ask a Namespace administrator to confirm the required grants."
    : "Deployment conflicts with the saved Agent state. Refresh this Agent to check for changed Configuration or missing connection credentials. If credentials are missing after an earlier version, ask an operator to restore them.";
}

function errorPanel(error, context, retry, { version = false } = {}) {
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
        : message(error),
    ),
    error.remembered
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

function summary(values, details) {
  const model = values?.agents?.defaults?.model;
  const primary = typeof model === "string" ? model : model?.primary;
  const list = element("dl", { className: "configuration-summary" });
  for (const [name, value] of [["Model", primary ?? "Not specified"], ...details]) {
    list.append(element("dt", {}, name), element("dd", {}, value ?? "None"));
  }
  return list;
}

function nativeDocument(values, label) {
  return element(
    "details",
    { className: "native-document" },
    element("summary", {}, label),
    element("pre", { tabindex: "0" }, JSON.stringify(values, null, 2)),
  );
}

// A save's reread or its PATCH found a newer Configuration generation than the page's.
const CONFIGURATION_CHANGED =
  "The saved Configuration changed while you were editing. Reload this draft before saving.";

// The page that holds the setting to change for failure codes whose cause the operator can
// act on directly. The API's error message already states the next step (finding 1393), so
// the console adds only the link.
const DEPLOYMENT_FAILURE_LINKS = {
  RUNTIME_AUTHENTICATION_FAILED: "credentials",
  RUNTIME_MODEL_PROBE_FAILED: "configuration",
  RUNTIME_MODEL_PROBE_TIMEOUT: "configuration",
  // Kubernetes Compute fails activation at once when the Gateway refuses its own in-Pod
  // CLI (#1128); the Configuration's gateway password reference is what lets it in.
  AGENT_GATEWAY_UNAUTHORIZED: "configuration",
};

// The runtime classifies a failed startup model check into one of these kinds and
// a fixed detail token such as exit-1, rate_limit or no-reply.
const RUNTIME_FAILURE_CAUSE_LABELS = {
  PROCESS_EXIT: "The check process exited with an error",
  PROBE_STATUS: "The model provider check reported a failure",
  INVALID_OUTPUT: "The check returned unexpected output",
  WRAPPER_ERROR: "The runtime could not run the check",
};

// Provider refusals the operator fixes at the provider account, not in the Configuration.
const PROBE_STATUS_DETAIL_TEXT = {
  rate_limit:
    "The model provider rejected the request: rate or usage limit reached (rate_limit). Wait for the provider's limit to reset or use an account with remaining quota, then deploy a new version.",
  billing:
    "The model provider rejected the request: billing or credit problem (billing). Check the provider account's plan and credits, then deploy a new version.",
};

// A Codex check retried once, after a timeout or a reliability failure, holds its second
// attempt's detail with this suffix; the advice is the same as for the bare token.
const RETRIED_DETAIL_SUFFIX = "-attempt2";

function runtimeFailureCauseText(cause) {
  const retried =
    typeof cause.detail === "string" &&
    cause.detail.length > RETRIED_DETAIL_SUFFIX.length &&
    cause.detail.endsWith(RETRIED_DETAIL_SUFFIX);
  const detail = retried ? cause.detail.slice(0, -RETRIED_DETAIL_SUFFIX.length) : cause.detail;
  const retry = retried ? " The check was retried once and failed again." : "";
  if (cause.kind === "PROBE_STATUS" && Object.hasOwn(PROBE_STATUS_DETAIL_TEXT, detail)) {
    return PROBE_STATUS_DETAIL_TEXT[detail] + retry;
  }
  const label = Object.hasOwn(RUNTIME_FAILURE_CAUSE_LABELS, cause.kind)
    ? RUNTIME_FAILURE_CAUSE_LABELS[cause.kind]
    : cause.kind;
  if (!detail) {
    return label;
  }
  return retried ? `${label} (${detail}).${retry}` : `${label} (${detail})`;
}

// The API's message for a failure that deploying the same Agent again can clear (an outage
// that outlasted every attempt, a lost worker claim, an approval or driver that changed since
// admission) starts a sentence with "Deploy again". The recovery offers Deploy again for those
// messages only, so it never contradicts the step the message names. A message that names no
// step at all (a deadline that passed, a Driver that cannot run this Harness) mentions none of
// deploy, ask or check, and the banner adds the generic advice to it.
const DEPLOY_AGAIN_STEP = /(?:^|[.;]\s)Deploy again\b/u;
const NAMED_STEP = /\b(?:deploy|ask|check)\b/iu;

/**
 * The next step a failed deployment's API message names: "deploy-again" when it says to deploy
 * again, "named" for any other step, and null for none.
 */
export function deploymentFailureStep(message) {
  if (typeof message !== "string" || message.length === 0) {
    return null;
  }
  if (DEPLOY_AGAIN_STEP.test(message)) {
    return "deploy-again";
  }
  return NAMED_STEP.test(message) ? "named" : null;
}

const DEPLOYMENT_FAILURE_LINK_LABELS = {
  credentials: "Open Credentials",
  configuration: "Open Configuration",
};

function deploymentFailure(error) {
  if (!error) {
    return element("p", { className: "muted" }, "No persisted startup failure.");
  }
  const runtimeFailure = error.data?.runtimeFailure;
  const preparation = error.data?.preparation;
  return element(
    "div",
    {},
    statusBlock("danger", null, `${error.code}: ${error.message}`),
    preparation
      ? element(
          "div",
          { className: "bootstrap-failure-evidence" },
          element("h4", {}, "Credential preparation evidence"),
          element(
            "p",
            {},
            `${preparation.workload.kind} ${preparation.workload.name} · ${preparation.workload.namespace} · ${preparation.reason}`,
          ),
          element(
            "p",
            { className: "muted" },
            `Observed ${displayDate(preparation.observedAt)}. This local file handoff does not verify provider login acceptance.`,
          ),
          element("p", { className: "resource-id" }, `Workload UID: ${preparation.workload.uid}`),
          element(
            "p",
            {},
            `Started: ${preparation.startedAt ? displayDate(preparation.startedAt) : "Unknown"} · Finished: ${preparation.finishedAt ? displayDate(preparation.finishedAt) : "Unknown"}`,
          ),
          ...preparation.pods.map((pod) =>
            element(
              "div",
              {},
              element("strong", {}, `${pod.name} · ${pod.phase} · scheduling ${pod.scheduling}`),
              element("p", { className: "resource-id" }, `Pod UID: ${pod.uid}`),
              ...pod.containers.map((container) =>
                element(
                  "p",
                  {},
                  `${container.kind} container ${container.name}: ${container.state}${container.reason ? ` · ${container.reason}` : ""}${container.exitCode === null ? "" : ` · exit ${container.exitCode}`}${container.startedAt ? ` · started ${displayDate(container.startedAt)}` : ""}${container.finishedAt ? ` · finished ${displayDate(container.finishedAt)}` : ""}`,
                ),
              ),
            ),
          ),
          element(
            "p",
            { className: "hint" },
            "For unschedulable Pods, check capacity and placement. For image or volume setup failures, check image access, mounts and private-volume permissions. Correct the cause and deploy a new version of this Agent.",
          ),
        )
      : null,
    runtimeFailure && typeof runtimeFailure === "object"
      ? element(
          "dl",
          { className: "credential-status-list" },
          element("dt", {}, "Runtime component"),
          element("dd", {}, runtimeFailure.component ?? "Unknown"),
          element("dt", {}, "Check"),
          element("dd", {}, runtimeFailure.check ?? "Unknown"),
          element("dt", {}, "Code"),
          element("dd", {}, runtimeFailure.code ?? "Unknown"),
          ...(runtimeFailure.cause && typeof runtimeFailure.cause === "object"
            ? [
                element("dt", {}, "Cause"),
                element("dd", {}, runtimeFailureCauseText(runtimeFailure.cause)),
              ]
            : []),
          element("dt", {}, "Checked"),
          element("dd", {}, displayDate(runtimeFailure.checkedAt)),
        )
      : null,
  );
}

// A recorded result: the failure, or a neutral note when a newer version superseded this one
// or the owner stopped the Agent during its deployment.
function deploymentResult(record) {
  const neutral = neutralDeploymentOutcome(record);
  if (neutral === "superseded") {
    return element(
      "p",
      { className: "muted deployment-superseded" },
      `${NEUTRAL_DEPLOYMENT_NOTES.superseded} before this one became current (${record.error.code}). This version did not fail; no action is needed.`,
    );
  }
  if (neutral === "stopped") {
    return element(
      "p",
      { className: "muted deployment-stopped" },
      `The Agent was stopped before this deployment finished (${record.error.code}). This version did not fail; deploy a new version when you want it running.`,
    );
  }
  return deploymentFailure(record.error);
}

function deploymentProgress(record) {
  const status = deploymentOutcome(record);
  const progress = record.progress;
  const workDescriptions = {
    queued: progress?.lastAttempt
      ? "Waiting to continue deployment."
      : "Waiting for a worker claim.",
    running: "A worker claim is active.",
    failed: "Deployment work failed; check the recorded error and current version.",
    superseded: "Deployment work stopped because a newer version superseded this one.",
    stopped: "Deployment work ended because the Agent was stopped.",
    succeeded: "Work completed or the version was already active.",
  };
  const stages = [
    ["Admitted", "An immutable version was created.", "complete"],
    [
      "Deployment work",
      workDescriptions[status],
      status === "queued"
        ? "waiting"
        : status === "running"
          ? "active"
          : status === "succeeded"
            ? "complete"
            : status === "superseded" || status === "stopped"
              ? status
              : "failed",
    ],
    [
      "Completion recorded",
      status === "succeeded"
        ? "This deployment completed activation or was already active."
        : status === "superseded"
          ? "Not needed: this version did not become current."
          : status === "stopped"
            ? "Not recorded: the Agent was stopped first. Deploy a new version when you want it running."
            : status === "failed"
              ? "Successful completion was not recorded for this deployment."
              : "Successful completion is not recorded yet.",
      status === "succeeded"
        ? "complete"
        : status === "superseded" || status === "stopped"
          ? status
          : "waiting",
    ],
  ];
  return element(
    "ol",
    { className: "deployment-progress", "aria-label": "Deployment progress" },
    ...stages.map(([name, description, state]) =>
      element(
        "li",
        { className: `deployment-step deployment-step-${state}` },
        element("span", { className: "deployment-step-marker", "aria-hidden": "true" }),
        element("div", {}, element("strong", {}, name), element("span", {}, description)),
      ),
    ),
  );
}

export const DEPLOYMENT_POLL_MS = 5000;
// Longest wait for Deployment activity's first read before the sections below it show. On a
// slow link that read lands over a second after the page, and a failed version's banner then
// pushed the shown overview down (finding 1489).
export const FIRST_ACTIVITY_WAIT_MS = 2000;
const PENDING_DEPLOYMENT_STATUSES = new Set(["queued", "running"]);
// The badge tone of a recorded deployment outcome in the Agent summary; superseded and stopped
// records stay neutral.
const DEPLOYMENT_OUTCOME_TONES = {
  queued: "info",
  running: "info",
  succeeded: "success",
  failed: "danger",
};

// A read failure that a later read can clear: no answer (a network error), a timeout, a rate
// limit or a server error. A refusal or a missing record is an answer, and polling stops on it.
function transientReadError(error) {
  const status = error?.status;
  return !(status >= 400 && status < 500) || status === 408 || status === 429;
}

// A recovery link opens a version tab far below the banner it sits in. Only the URL changed and
// the page stayed at the top, so the link looked dead (finding 1586). The page the link opens,
// switched in place, rebuilt or restored for Back, brings that tab into view and focuses it.
// Keyed by Namespace and target, so only the page the link names takes it, and by console load,
// so a load the link did not start (Back before it landed, a later visit) never takes it.
let linkedVersionView = null;
let consoleLoads = 0;

/** The console starts a page load (navigation, Back, refocus): earlier link requests lapse. */
export function noteConsoleLoad() {
  consoleLoads += 1;
  if (linkedVersionView?.load !== consoleLoads) {
    linkedVersionView = null;
  }
}

/** The link request for this page, if one names it: `{ deploy }` says how to open it. */
function takeLinkedVersionView(key) {
  const linked = linkedVersionView?.key === key ? linkedVersionView : null;
  if (linked) {
    linkedVersionView = null;
  }
  return linked;
}

function pendingAttempt(attempt) {
  const none = "Not recorded yet";
  return element(
    "dl",
    { className: "credential-status-list" },
    element("dt", {}, "Last recorded result"),
    element(
      "dd",
      attempt ? {} : { className: "muted" },
      attempt ? attempt.message : "No reconciliation result is available yet.",
    ),
    element("dt", {}, "Reason"),
    element("dd", attempt ? {} : { className: "muted" }, attempt ? attempt.code : none),
    element("dt", {}, "Since"),
    element("dd", attempt ? {} : { className: "muted" }, attempt ? displayDate(attempt.at) : none),
  );
}

// One Tab stop for a list of version buttons, as in the tab strip (UX plan C7): it sits on the
// viewed version (else the newest), Up/Down (and Home/End) move focus between versions, and
// Enter or Space opens one. A rail of 51 versions was 51 Tab stops (finding 2101).
// It returns a function that moves the Tab stop to an item and focuses it.
function rovingVersions(list, items) {
  const home = items.find((item) => item.getAttribute("aria-current") === "page") ?? items[0];
  const reset = () => {
    for (const item of items) {
      item.tabIndex = item === home ? 0 : -1;
    }
  };
  const focusItem = (target) => {
    for (const item of items) {
      item.tabIndex = item === target ? 0 : -1;
    }
    target.focus({ preventScroll: true });
  };
  reset();
  list.addEventListener("keydown", (event) => {
    const enabled = items.filter((item) => !item.disabled);
    const at = enabled.indexOf(document.activeElement);
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

function createDeploymentStatusPanel(context, path, revision, onAgentChange, onStatusChange) {
  const refresh = button(
    "Refresh deployment",
    () => {
      state.readerRefresh = true;
      if (state.loading && state.polling) {
        // A quiet poll is reading: refresh once it lands.
        state.refreshQueued = true;
        refresh.setAttribute("aria-disabled", "true");
        return;
      }
      void loadStatus(true);
    },
    { tone: "ghost", size: "sm" },
  );
  const content = element("div", { className: "deployment-evidence-content" });
  const details = element("details", {}, element("summary", {}, "Deployment details"), content);
  const section = element(
    "section",
    { className: "deployment-status deployment-evidence", "aria-label": "Deployment activity" },
    details,
    refresh,
  );
  let previousEvidence;
  const state = {
    loading: false,
    // A 5 s poll reads quietly: Refresh stays as it is unless pressed (finding 1598).
    polling: false,
    refreshQueued: false,
    // Set by Refresh until its own read (not a poll it waited for) lands.
    readerRefresh: false,
    status: null,
    error: null,
    overviewError: false,
  };
  // Tallest the details have been since a deploy was seen pending; see render().
  let reservedHeight = null;
  let pollTimer = null;
  // The last record read. A transient read failure (a network error, a timeout, a 5xx) does not
  // end a pending deploy, so polling goes on from it (finding 2085).
  let lastRecord = null;

  // A poll that fired while the view was retained stopped; restoring the view re-arms it.
  context.onResume?.(() => {
    if (section.isConnected) {
      schedulePoll();
    }
  });

  // Queued and running records are reread until they record a result or a read is refused.
  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = null;
    const record = state.error
      ? transientReadError(state.error)
        ? lastRecord
        : null
      : state.status;
    if (
      !PENDING_DEPLOYMENT_STATUSES.has(record?.status) &&
      !PENDING_DEPLOYMENT_STATUSES.has(record?.cleanup?.status)
    ) {
      return;
    }
    pollTimer = setTimeout(() => {
      pollTimer = null;
      // A newer deployment replaces this panel; a detached panel stops following.
      if (context.isCurrent() && section.isConnected) {
        void loadStatus(false, true);
      }
    }, DEPLOYMENT_POLL_MS);
  }

  async function loadStatus(refreshAgent = false, poll = false) {
    if (state.loading || !context.isCurrent()) {
      return;
    }
    clearTimeout(pollTimer);
    pollTimer = null;
    // After a failed read, the record before it.
    const previousStatus = lastRecord?.status ?? null;
    state.loading = true;
    state.polling = poll;
    state.error = null;
    state.overviewError = false;
    render();
    try {
      const [statusResult, agentResult, revisionsResult] = await Promise.allSettled([
        context.request(`${path}/deployments/${encodeURIComponent(revision.id)}`),
        refreshAgent ? context.request(path) : Promise.resolve(null),
        refreshAgent ? readRevisionPage(context.request, path) : Promise.resolve(null),
      ]);
      if (!context.isCurrent()) {
        return;
      }
      if (
        [statusResult, agentResult, revisionsResult].some(
          (result) => result.status === "rejected" && result.reason.status === 401,
        )
      ) {
        context.onExpired();
        return;
      }
      if (statusResult.status === "fulfilled") {
        state.status = statusResult.value;
        lastRecord = statusResult.value;
      } else {
        state.status = null;
        state.error = statusResult.reason;
      }
      if (refreshAgent) {
        if (agentResult.status === "fulfilled" && revisionsResult.status === "fulfilled") {
          onAgentChange(agentResult.value, revisionsResult.value);
        } else {
          state.overviewError = true;
        }
      }
    } catch (error) {
      if (!context.isCurrent()) {
        return;
      }
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      state.error = error;
      state.status = null;
    } finally {
      if (context.isCurrent()) {
        state.loading = false;
        render();
        // A Refresh pressed during a poll is answered by the read queued after it.
        if (!poll) {
          state.readerRefresh = false;
        }
        onStatusChange(
          state.status ? deploymentOutcome(state.status) : null,
          state.error !== null,
          state.status?.error?.code ?? null,
          state.status,
          state.overviewError,
          state.error !== null && transientReadError(state.error),
        );
        if (
          state.refreshQueued ||
          (poll &&
            PENDING_DEPLOYMENT_STATUSES.has(previousStatus) &&
            !state.error &&
            !PENDING_DEPLOYMENT_STATUSES.has(state.status?.status))
        ) {
          // A recorded result can change the current version; reread it once.
          state.refreshQueued = false;
          void loadStatus(true);
        } else {
          schedulePoll();
        }
      }
    }
  }

  function renderStatus() {
    if (state.error) {
      return statusBlock("danger", null, message(state.error));
    }
    if (!state.status) {
      return element("p", { className: "muted" }, "Deployment status has not loaded.");
    }
    return element(
      "div",
      {},
      deploymentProgress(state.status),
      state.status.cleanup
        ? element(
            "p",
            { role: "status", className: "deployment-cleanup" },
            {
              // One retire cleanup per version: OAuth bootstrap or repository credential resources.
              queued:
                "Revision cleanup pending. This version's resources have not been confirmed removed; the controller will retry.",
              running:
                "Revision cleanup is running. This version's resources have not been confirmed removed.",
              succeeded: "Revision cleanup completed for this version.",
              failed:
                "Revision cleanup failed. Ask an operator to inspect the retained cleanup obligation.",
            }[state.status.cleanup.status],
          )
        : null,
      state.status.progress
        ? element(
            "div",
            { className: "deployment-pending-progress" },
            // The list keeps its rows before the first attempt is recorded, so that result
            // fills them in place instead of pushing the cards below down (finding 1598).
            pendingAttempt(state.status.progress.lastAttempt),
            state.status.progress.nextAttemptAt
              ? element(
                  "p",
                  { className: "muted" },
                  `Eligible for next attempt: ${displayDate(state.status.progress.nextAttemptAt)}. Start time depends on worker availability.`,
                )
              : null,
          )
        : null,
      element(
        "p",
        { className: "deployment-outcome" },
        `Recorded status: ${outcomeLabel(deploymentOutcome(state.status))}`,
      ),
      state.status.error ? deploymentResult(state.status) : null,
      state.status.warnings?.length
        ? statusBlock(
            "warning",
            element("h3", {}, "Startup warnings"),
            element(
              "ul",
              {},
              ...state.status.warnings.map((warning) =>
                element("li", {}, pluginWarningText(warning)),
              ),
            ),
            [],
            { role: null },
          )
        : null,
    );
  }

  function render() {
    // Keep both controls mounted during reads. Only a routine completed record starts folded;
    // a new outcome, read error, cleanup or startup warning is visible without opening details.
    const busy = String((state.loading && !state.polling) || state.refreshQueued);
    if (refresh.getAttribute("aria-disabled") !== busy) {
      refresh.setAttribute("aria-disabled", busy);
    }
    if (state.loading) {
      return;
    }
    const outcome = state.status ? deploymentOutcome(state.status) : null;
    const { cleanup, warnings } = state.status ?? {};
    const evidence = [outcome, cleanup?.status, warnings?.length, state.overviewError].join("/");
    if (evidence !== previousEvidence) {
      details.open = Boolean(
        previousEvidence !== undefined ||
        outcome !== "succeeded" ||
        state.overviewError ||
        cleanup ||
        warnings?.length,
      );
      previousEvidence = evidence;
    }
    const changed = patchChildren(content, [
      element(
        "p",
        { className: "muted" },
        `Most recent visible deployment · v${revision.revision}`,
      ),
      renderStatus(),
      ...(state.overviewError
        ? [
            statusBlock(
              "danger",
              null,
              "Current version and version history could not be refreshed. Use the page Refresh control to retry.",
            ),
          ]
        : []),
    ]);
    reserveHeight(changed);
  }

  // A deploy's details grow when its first attempt is recorded and shrink when it settles, and
  // each change moved the cards below, Share Agent then among them (finding 1598). Once a deploy is
  // seen pending, the details keep the tallest height they have shown, until the reader's own
  // Refresh after the deploy gives the space back.
  function reserveHeight(changed) {
    const pending =
      PENDING_DEPLOYMENT_STATUSES.has(state.status?.status) ||
      PENDING_DEPLOYMENT_STATUSES.has(state.status?.cleanup?.status);
    if (pending) {
      reservedHeight ??= 0;
    } else if (state.readerRefresh && !state.polling && reservedHeight !== null) {
      reservedHeight = null;
      content.style.removeProperty("min-height");
      return;
    }
    if (reservedHeight === null || !changed) {
      return;
    }
    content.style.removeProperty("min-height");
    reservedHeight = Math.max(reservedHeight, content.getBoundingClientRect().height);
    content.style.minHeight = `${reservedHeight}px`;
  }

  void loadStatus();
  return section;
}

// With shared, Deployment activity is reading this version's record, so the panel waits for
// show() instead of reading it again; release() reads here if that read fails (finding 1417).
function createVersionDeploymentRecord(
  context,
  path,
  revisionId,
  onChange = () => {},
  { shared = false } = {},
) {
  const section = element("section", { className: "agent-card version-deployment-record" });
  let status = null;
  let error = null;
  let loading = false;
  let awaitingShared = shared;
  // A shared read that never settles must not leave this panel loading.
  let sharedTimer = shared ? setTimeout(() => release(), DEPLOYMENT_POLL_MS) : null;
  // Bumped whenever a newer record arrives from elsewhere so a slower read cannot overwrite it.
  let generation = 0;

  async function load() {
    if (loading || !context.isCurrent()) {
      return;
    }
    awaitingShared = false;
    clearTimeout(sharedTimer);
    loading = true;
    error = null;
    const started = generation;
    render();
    try {
      const next = await context.request(`${path}/deployments/${encodeURIComponent(revisionId)}`);
      if (started === generation) {
        status = next;
      }
    } catch (cause) {
      if (!context.isCurrent()) {
        return;
      }
      if (cause.status === 401) {
        context.onExpired();
        return;
      }
      if (started === generation) {
        status = null;
        error = cause;
      }
    } finally {
      if (context.isCurrent()) {
        loading = false;
        render();
        onChange(status);
      }
    }
  }

  // Deployment activity already read this version's record; show it instead of a stale one.
  function show(next) {
    if (!context.isCurrent() || !next) {
      return;
    }
    awaitingShared = false;
    clearTimeout(sharedTimer);
    generation += 1;
    status = next;
    error = null;
    render();
    onChange(status);
  }

  // Deployment activity hands each 5 s poll's record to show(): rewrite only what changed
  // (finding 1598).
  function render() {
    patchChildren(section, [
      element(
        "div",
        { className: "deployment-heading" },
        element("h3", {}, "This version’s deployment record"),
        button(loading ? "Refreshing…" : "Refresh record", () => void load(), {
          tone: "ghost",
          size: "sm",
          disabled: loading,
        }),
      ),
      error
        ? statusBlock("danger", null, message(error))
        : status
          ? element(
              "div",
              {},
              element("p", {}, `Recorded outcome: ${outcomeLabel(deploymentOutcome(status))}`),
              deploymentResult(status),
              status.warnings?.length
                ? element(
                    "div",
                    { className: "hint" },
                    element("p", {}, "Startup warnings:"),
                    element(
                      "ul",
                      {},
                      ...status.warnings.map((warning) =>
                        element("li", {}, pluginWarningText(warning)),
                      ),
                    ),
                  )
                : null,
            )
          : element("p", { className: "muted" }, "Loading this version’s recorded outcome…"),
    ]);
  }

  function release() {
    if (awaitingShared) {
      void load();
    }
  }

  render();
  if (!shared) {
    void load();
  }
  return { section, show, release, current: () => status };
}

// The console's delay for loading text (console.css .delayed-status): a diagnostics answer within
// it never shows the waiting line (finding 1714).
const DIAGNOSTICS_WAITING_DELAY_MS = 250;

function createVersionDiagnosticsPanel(
  context,
  path,
  revisionId,
  recordedStatus = () => null,
  operateAllowed = null,
) {
  const section = element("section", { className: "agent-card version-diagnostics" });
  let diagnostics = null;
  // Set when the caller's permission answer denies Agent operate, which diagnostics need: the
  // button is disabled with the reason (finding 1992).
  let operateDenied = false;
  let error = null;
  let loading = false;
  // Set once a run outlasts DIAGNOSTICS_WAITING_DELAY_MS: the waiting line replaces the last
  // result and the button disables itself.
  let waitingShown = false;
  // The id of the result that describes the button after a run. render() sets it on both: a
  // deployment poll re-renders the panel, and patchChildren drops attributes that render()
  // does not set (finding 1712).
  let outcomeId = null;

  async function run() {
    if (loading || !context.isCurrent()) {
      return;
    }
    loading = true;
    const runButton = section.querySelector(".deployment-heading button");
    // Until the delay passes, the last result and the focused button stay as they are, so a fast
    // answer replaces the result directly: no waiting line is painted or announced, and focus
    // does not move (finding 1714). A second press meanwhile does nothing.
    let waitingLine = null;
    const waitingTimer = setTimeout(() => {
      if (!loading || !context.isCurrent()) {
        return;
      }
      // Only a reader still on the button follows it to the waiting line; one who moved on, even
      // to the page itself, stays where they are.
      const onButton = document.activeElement === runButton;
      waitingShown = true;
      error = null;
      diagnostics = null;
      outcomeId = null;
      render();
      // The button disables itself while it waits: move focus to the waiting line, as Deploy
      // does, so a keyboard reader is not dropped to the page (finding 1705).
      waitingLine = section.lastElementChild;
      if (onButton) {
        focusSaveOutcome(section, [], waitingLine);
      }
    }, DIAGNOSTICS_WAITING_DELAY_MS);
    let answer = null;
    let failure = null;
    try {
      answer = await context.request(
        `${path}/deployments/${encodeURIComponent(revisionId)}/diagnostics`,
        { method: "POST", readOnly: true },
      );
    } catch (cause) {
      if (!context.isCurrent()) {
        return;
      }
      if (cause.status === 401) {
        context.onExpired();
        return;
      }
      failure = cause;
    } finally {
      clearTimeout(waitingTimer);
      if (context.isCurrent()) {
        const active = document.activeElement;
        const waited = active === runButton || (waitingLine !== null && active === waitingLine);
        if (!waitingShown) {
          // With no waiting line in between, patching would keep a result identical to the last
          // one in place, and nothing would be announced: insert it anew instead.
          for (const node of [section.querySelector('[role="alert"]'), section.lastElementChild]) {
            node?.remove();
          }
        }
        loading = false;
        waitingShown = false;
        diagnostics = answer;
        error = failure;
        outcomeId = null;
        render();
        // The result replaces the waiting line (or the last result): focus returns to, or stays
        // on, the button, described by the alert or the "Observed" line (not the whole check
        // list, which the view's live region already reads), unless the reader has moved on.
        if (waited) {
          const outcome = error
            ? section.querySelector('[role="alert"]')
            : section.lastElementChild.firstElementChild;
          focusSaveOutcome(section, [runButton], outcome);
          outcomeId = runButton.getAttribute("aria-describedby") ? outcome.id : null;
          // Focus stays on the button; a refusal below it still comes into view (finding 1992).
          if (error) {
            outcome?.scrollIntoView({ block: "nearest" });
          }
        }
      }
    }
  }

  function renderChecks() {
    if (waitingShown) {
      // Focusable here, not only by focusSaveOutcome: a deployment poll re-renders the panel,
      // and patchChildren drops attributes that render() does not set.
      return element(
        "p",
        { className: "muted", role: "status", tabindex: "-1" },
        "Waiting for diagnostic results…",
      );
    }
    if (!diagnostics) {
      return element(
        "p",
        { className: "muted" },
        error
          ? "No observation was returned from this attempt."
          : "No current observation has been requested for this version.",
      );
    }
    const checks = element("dl", { className: "credential-status-list" });
    for (const check of diagnostics.checks) {
      checks.append(
        element("dt", {}, `${check.component} / ${check.check}`),
        element(
          "dd",
          {},
          `${check.state}${check.code ? ` (${check.code})` : ""} · ${check.checkedAt ? displayDate(check.checkedAt) : "No check time"}`,
        ),
      );
    }
    return element(
      "div",
      {},
      element(
        "p",
        { className: "muted", ...describedOutcome() },
        `Observed ${displayDate(diagnostics.observedAt)}`,
      ),
      diagnostics.checks.length
        ? checks
        : element("p", { className: "muted" }, "No diagnostic checks were returned."),
      ...scopeExplanations(),
    );
  }

  // The gateway checks cover only the Slack channel. Say what their results do
  // and do not mean, and keep a recorded deployment failure in view: nothing
  // here tests model credentials, so no check can confirm or clear it.
  function scopeExplanations() {
    const checks = diagnostics.checks;
    const unreachable =
      checks.length > 0 &&
      checks.every((check) => check.state === "unknown" && check.code === "UNAVAILABLE");
    const slackNotConfigured = checks.some(
      (check) =>
        check.component === "gateway" &&
        check.check === "configuration" &&
        check.state === "failed" &&
        check.code === "NOT_CONFIGURED",
    );
    const recorded = recordedStatus();
    const failure =
      recorded?.status === "failed" && !neutralDeploymentOutcome(recorded) ? recorded.error : null;
    const hints = [];
    if (unreachable) {
      hints.push(
        "UNAVAILABLE means the runtime did not answer, so these checks could not run. The gateway is usually stopped, still starting, or failed to start.",
      );
    }
    if (slackNotConfigured) {
      hints.push(
        "NOT_CONFIGURED means this version has no Slack channel, so Slack authentication and connectivity were not checked. An Agent that does not use Slack always reports this; it is not a model or deployment error.",
      );
    }
    if (failure?.code) {
      hints.push(
        `This version's recorded deployment failed with ${failure.code}; resolve that first. These checks do not test model credentials, so they cannot confirm or clear that failure.`,
      );
    } else if (unreachable) {
      hints.push(
        "Check this version's recorded outcome and its Logs tab for Pod status and container output.",
      );
    }
    return hints.length
      ? [element("p", { className: "hint", role: "status" }, hints.join(" "))]
      : [];
  }

  function describedOutcome() {
    return outcomeId ? { id: outcomeId } : {};
  }

  // The version's record calls this on every deployment poll: rewrite only what changed.
  function render() {
    patchChildren(section, [
      element(
        "div",
        { className: "deployment-heading" },
        element("h3", {}, "Current observations"),
        // The button keeps its label while it waits, as Deploy and Save do: the status line
        // below is the one announcement, and a changed label inside the Agent view's live
        // region was announced as well (finding 1698).
        button("Run diagnostics for this version", () => void run(), {
          disabled: waitingShown || operateDenied,
          ...(outcomeId ? { "aria-describedby": outcomeId } : {}),
        }),
      ),
      ...(operateDenied
        ? [
            statusBlock(
              "info",
              null,
              "Your access does not include running diagnostics for this Agent.",
            ),
          ]
        : []),
      element(
        "p",
        { className: "muted" },
        "Checks run on demand against this exact version. Results are timestamped and do not change its recorded deployment outcome.",
      ),
      element(
        "p",
        { className: "muted" },
        "For Kubernetes Compute, gateway checks cover only the Slack channel: its configuration, authentication, and connectivity. They do not test model credentials or run a model turn. Pod status, restarts, Events and container output are on this version's Logs tab.",
      ),
      ...(error
        ? [
            statusBlock(
              "danger",
              null,
              error.status === 403
                ? "Diagnostics require Agent read and operate access plus read access to this version. Ask a Namespace administrator to confirm those grants."
                : error.status === 503
                  ? "Current-runtime diagnostics are unavailable. This Compute Driver may not support them, or the runtime may be unreachable. Check the runtime and try again."
                  : message(error),
              [],
              describedOutcome(),
            ),
          ]
        : []),
      renderChecks(),
    ]);
  }

  render();
  void operateAllowed?.then((permitted) => {
    if (permitted === false && context.isCurrent()) {
      operateDenied = true;
      render();
    }
  });
  return { section, render };
}

export async function renderAgentDetail(context, { agent: preloadedAgent = null } = {}) {
  const { view, namespaceId, agentId, request, url } = context;
  const path = `${namespacePath(namespaceId)}/agents/${encodeURIComponent(agentId)}`;
  // Saving the authentication source replaces it with the saved Agent (finding 1445).
  let agent = preloadedAgent ?? (await request(path));
  if (!context.isCurrent()) {
    return;
  }
  context.setTitle(agent.name);
  // A missing summary leaves each control on its usual path, except failed-version
  // recovery, which waits for a positive answer before offering a draft link.
  let callerPermissions = null;
  let callerPermissionsSettled = false;
  const callerPermissionsRead = request(`${path}/permissions`)
    .then(
      (permissions) => (callerPermissions = permissions),
      () => null,
    )
    .finally(() => {
      callerPermissionsSettled = true;
    });
  // Agent-side saves (plugins, authentication source, repository access) are Agent updates;
  // Configuration saves have no bit in this answer and stay enabled (finding 1530). A draft
  // refresh reads the answer again, so a grant applies without a page Refresh (finding 1538).
  let agentUpdateAllowed = callerPermissionsRead.then((permissions) => permissions?.update);
  // Only the latest reread's answer replaces the summary.
  let permissionsRereads = 0;
  // The newest permission read. Logs compares a remembered status denial with it, so an
  // operate grant read since the page was built applies (finding 1579).
  let latestPermissionsRead = callerPermissionsRead;
  let permissionsReadSettled = false;
  void callerPermissionsRead.then(() => {
    permissionsReadSettled = latestPermissionsRead === callerPermissionsRead;
  });
  let deleting = agent.status === "deleting";
  let currentRevisionId = agent.activeRevisionId;
  // The Agent as last read; Stop and finished deployments update it in place.
  let currentAgent = agent;
  let currentRuntimeState = agent.desiredRuntimeState;
  let visibleRevisions = [];
  // True once the readable version list loaded; until then nothing counts as hidden.
  let visibleRevisionsLoaded = false;
  const selected = url.searchParams.get("revision") ?? agent.activeRevisionId ?? "draft";
  const tab = url.searchParams.get("tab");
  // Sharing policy reads need Installation administration and a denial is audited, so the
  // Access tab is left out (not disabled) when the session probe already showed that access is
  // missing (spec 3.8). It is about the whole Agent, so every version's strip has it, last.
  const sharingTab = context.installationAdmin !== false;
  const tabsForSelection = [
    "configuration",
    "plugins",
    "channels",
    ...(selected === "draft" ? ["repositories", "credentials"] : []),
    "workspace",
    "policy",
    ...(selected === "draft" ? [] : ["logs"]),
    ...(sharingTab ? ["access"] : []),
  ];
  let selectedTab = tabsForSelection.includes(tab) ? tab : "configuration";
  let deployInFlight = false;
  // A share or binding removal in flight. Its writes belong to this page, so other versions and
  // pages wait for it (finding 2108); tabs do not, since the panel stays with the page.
  let sharingWrite = false;
  let authenticationSaveState = "idle";
  let activeCredentials = null;
  // Channel Secret choices that Reload draft carries into the rebuilt panel (finding 1512). The
  // draft store keeps them too, for the page a failed reread reloads (finding 1525).
  let carriedChannelSecrets = null;
  const target = (revision = selected, tab = selectedTab) =>
    `agents/${agentId}?revision=${encodeURIComponent(revision)}&tab=${tab}`;
  const linkedKey = (revision = selected, tab = selectedTab) =>
    JSON.stringify([namespaceId, target(revision, tab)]);
  // A link to one of this Agent's version tabs that brings the tab into view once it opens.
  // With `deploy`, a draft link brings that draft's Deploy new version into view instead.
  function versionLink(label, revision, tab, { deploy = false } = {}) {
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
  const change = (revision, tab) => {
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
  const currentVersionValue = element("strong", { className: "stat-value" });
  const currentVersionNote = element("p", { className: "stat-help" });
  // The summary's loading text follows the 250 ms rule: a read that settles sooner never shows
  // it, and the version number shows at once (finding 1438).
  function setDelayedText(node, prefix, loading) {
    if (node.textContent !== prefix + loading || !node.querySelector(".delayed-status")) {
      node.replaceChildren(prefix, element("span", { className: "delayed-status" }, loading));
    }
  }
  const latestDeploymentValue = element("strong", { className: "stat-value" });
  const latestDeploymentNote = element("p", { className: "stat-help" });
  setDelayedText(latestDeploymentValue, "", "Loading…");
  setDelayedText(latestDeploymentNote, "", "Reading deployment history.");
  // A recorded outcome is the version and a status badge (spec 3.5). The separator stays in the
  // text for screen readers and text matching ("v7 · Failed"); the badge's gap shows it.
  function setDeploymentOutcome(node, version, label, tone) {
    const text = `${version} · ${label}`;
    const badge = node.querySelector(":scope > .badge");
    if (node.textContent === text && badge && (badge.dataset.tone ?? "") === (tone ?? "")) {
      return;
    }
    node.replaceChildren(
      version,
      element("span", { className: "visually-hidden" }, " · "),
      element("span", { className: "badge", ...(tone ? { "data-tone": tone } : {}) }, label),
    );
  }
  const liveServingValue = element(
    "strong",
    { className: "stat-value" },
    element("span", { className: "badge" }, "Not verified"),
  );
  function setLiveServing(mayBeOffline) {
    const badge = liveServingValue.firstElementChild;
    setText(badge, mayBeOffline ? "May be offline" : "Not verified");
    if (mayBeOffline) {
      if (badge.dataset.tone !== "warning") {
        badge.dataset.tone = "warning";
      }
    } else if (badge.dataset.tone) {
      delete badge.dataset.tone;
    }
  }
  // A requested stop belongs in the summary, not only in the Stop row at the bottom (finding
  // 1899). It is attached only once the Agent has a version: an Agent is created stopped.
  const runtimeNote = element("p", { className: "stat-help" });
  const stat = (label, ...children) =>
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
    stat("Live serving", liveServingValue),
  );
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
  function revisionHidden(revisionId) {
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
  const deploymentStatus = element("section", { className: "agent-card deployment-status" });
  deploymentStatus.append(
    element("h2", {}, "Deployment activity"),
    element("p", { className: "muted" }, "Loading the most recent visible deployment…"),
  );
  const tabControls = new Map();
  const revisionControls = new Map();
  let draftEditorNavigationBlock = null;
  // Whether a draft editor's write is in flight (its block names the save to wait for).
  let draftEditorSaving = false;
  // A refused leave says why beside the control whose request holds the page (finding 1962).
  // The configuration, channels and repositories editors write their block into their own
  // feedback; every other hold writes it here.
  const leaveNote = statusBlock("info", null, null);
  let leaveNoteText = null;
  // The authentication form, whose save holds the page from the Credentials tab.
  let authenticationLeaveAnchor = null;
  function showLeaveNote(anchor, text, place) {
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
    if (!draftEditorBlocksNavigation()) {
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
  function draftWriteInFlight() {
    return (
      selected === "draft" &&
      (deployInFlight ||
        refreshingDraft ||
        authenticationSaveState === "saving" ||
        activeCredentials?.isSaving() ||
        (["configuration", "plugins", "repositories", "channels"].includes(selectedTab) &&
          draftEditorSaving))
    );
  }
  function trackRevisionControl(control) {
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
  for (const [id, label] of [
    ["configuration", "Configuration"],
    ["plugins", "Plugins"],
    ["channels", "Channels"],
    ...(selected === "draft"
      ? [
          ["repositories", "Repositories"],
          ["credentials", "Credentials"],
        ]
      : []),
    ["workspace", "Workspace files"],
    ["policy", "Policy denials"],
    ...(selected === "draft" ? [] : [["logs", "Logs"]]),
    ...(sharingTab ? [["access", "Access"]] : []),
  ]) {
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
    const at = enabled.indexOf(document.activeElement);
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
  const nativeAdmin = renderNativeAdminAccess(context, path);
  const recoveryTitle = element("h2");
  // A danger status block (spec 3.4): the failed version in the label, the code at the end of
  // the message's first sentence, and one primary action. Each part is its own node, so a poll
  // that reads back the same failure writes nothing.
  const recoveryLabel = element("p", { className: "status-label" });
  const recoveryLead = document.createTextNode("");
  const recoveryCode = element("code", { hidden: true });
  const recoveryRest = document.createTextNode("");
  const recoveryMessage = element(
    "p",
    { className: "status-body" },
    recoveryLead,
    recoveryCode,
    recoveryRest,
  );
  const recoveryActions = element("div", {
    className: "status-actions deployment-recovery-actions",
  });
  const recovery = element(
    "section",
    {
      className: "status deployment-recovery",
      "data-tone": "danger",
      hidden: true,
      "aria-label": "Deployment needs attention",
    },
    recoveryLabel,
    recoveryTitle,
    recoveryMessage,
    recoveryActions,
  );
  let recoveryTarget;
  // The failed version whose Deployment details the card has folded; see renderLatestDeployment.
  let recoveryFolded = null;
  const overviewStatus = element(
    "div",
    { className: "agent-overview-status" },
    statCard,
    statusLine,
    deploymentStatus,
  );
  view.replaceChildren(recovery, nativeAdmin.section, overviewStatus, versionLayout);
  // Recovery or native administration can appear above the facts. Keep the Agent heading and
  // controls in place, then reveal the overview once its first deployment reads settle.
  // The bounded wait still exposes loading, refresh and the version controls on a slow read.
  view.classList.add("agent-detail-pending");
  let revealTimer = null;
  let markRevealed;
  const revealed = new Promise((resolve) => {
    markRevealed = resolve;
  });
  // A Logs entry that scrolls to its output also waits for that output (within the same bound)
  // and scrolls in the frame that reveals the page, never at the top first (finding 1552).
  let revealHold = null;
  let scrollOnReveal = null;
  // Brings the version's detail (tab strip and open tab) to the top of the window; the heading
  // and record sit above it beside the Versions rail (UX spec 3.7). A
  // click in the shown page scrolls smoothly unless the reader asked for reduced motion; a page
  // about to show scrolls at once, so it never paints at the top first (findings 1552, 1586).
  function scrollToVersionDetail({ animate = false } = {}, node = detailPane) {
    const smooth = animate && !globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    node.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "instant" });
  }
  function openVersionDetail({ deploy = false, edit = false, ...options } = {}) {
    // Edit current Configuration opens the draft with its Configuration editor open, in view and
    // focused. It switched to the draft at the top of the page, and the editor still needed an
    // Edit Configuration click far below (finding 2061).
    // A draft restored with unsaved edits is already in the editor; otherwise its Edit
    // Configuration button opens it.
    const editorTarget = () =>
      detailPane.querySelector("#configuration-json") ??
      detailPane.querySelector('button[data-opens="configuration-editor"]');
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
          below >= 0 && below + 160 <= window.innerHeight ? notice : field,
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
    const deployButton = actions?.querySelector("button.primary");
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
  revealTimer = setTimeout(showDetail, FIRST_ACTIVITY_WAIT_MS);
  function revealSelectedTab() {
    const strip = tabs.getBoundingClientRect();
    // A tab that has focus (moved there with the arrows) stays in view over the selected one.
    const shown = tabs.contains(document.activeElement)
      ? document.activeElement
      : tabControls.get(selectedTab);
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
  let details;
  // The details read that has settled, so a tab rebuilt from it shows no loading text.
  let settledDetails = null;
  const retainedTabs = new Map();
  let mountedTab = null;
  // The Access tab's sharing panel, built the first time the tab opens.
  let accessPanel = null;
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
  // Set while a saved draft refreshes in place; tab and version changes wait for it.
  let refreshingDraft = false;
  let activityPanel = deploymentStatus;
  let activityRevisionId;
  let viewedSnapshot = null;
  // The Configuration ID this page has read successfully, and the one recovery is checking. Deploy
  // again opens a draft that builds Deploy new version only from a readable Configuration, and
  // "not yet denied" is not readable (finding 1931).
  let readableConfigurationId = null;
  let configurationCheckId = null;
  let detailLoadFinished = false;
  let latestRevisionResult = null;
  let latestDeploymentStatus = null;
  let latestDeploymentError = false;
  let latestDeploymentErrorCode = null;
  let latestDeploymentErrorMessage = null;
  let latestDeploymentRecord = null;
  // Whether the newest version's panel last failed to refresh the Agent or its versions.
  let latestOverviewUnavailable = false;
  // The newest version's status from its last record read; a failed read keeps it, so one
  // failure does not relabel a deploying version Historical (finding 2085).
  let latestRecordedStatus = null;
  // Set when the Agent reread after a completed deployment failed, until an Agent read lands.
  let agentRereadFailed = false;
  let versionRecord = null;
  const revisionsPromise = readRevisionPage(request, path);
  // Every revision summary listed so far, from the newest page and from older pages the viewer
  // asked for. Summaries never change, and a revision appears once however pages shift.
  const listedRevisions = new Map();
  // Whether an older page was loaded, and the cursor for the next one (null once complete).
  let olderPageLoaded = false;
  let olderCursor = null;
  let olderLoading = false;
  let olderError = null;
  // The newest revision with its saved settings, read only when a check needs them.
  let latestRevisionDetail = null;
  let latestRevisionDetailReading = null;

  function versionNotice() {
    return selected === "draft"
      ? selectedTab === "plugins"
        ? "Plugin changes to this Agent appear in the next deployment. Existing versions stay unchanged."
        : "New version. Changes affect future deployments using this Configuration. Admitted versions stay unchanged."
      : selected === currentRevisionId
        ? "Current version · read-only admitted snapshot."
        : deployingRevision()?.id === selected
          ? "Deploying version · read-only admitted snapshot. It becomes the current version only if its deployment completes."
          : deployedRevision()?.id === selected
            ? "Deployed version · read-only admitted snapshot. Its deployment completed, but the current version could not be refreshed."
            : "Historical version · read-only admitted snapshot. Browsing it does not change the current version.";
  }

  // The newest version while its deployment is queued or running and it is not yet current. Right
  // after Deploy new version it was called "Historical" beside "Selected version v1" (finding 2065).
  function deployingRevision() {
    const latest = visibleRevisions[0];
    return latest &&
      latest.id !== currentRevisionId &&
      activityRevisionId === latest.id &&
      PENDING_DEPLOYMENT_STATUSES.has(latestRecordedStatus)
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
          : snapshot
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
      if (!snapshot.configurationReadError) {
        heading.append(
          element(
            "p",
            { className: "muted" },
            `${selected === "draft" ? "Configuration" : "Source Configuration"} ${selected === "draft" ? snapshot.id : snapshot.configurationId} · generation ${selected === "draft" ? snapshot.generation : snapshot.configurationGeneration}`,
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
        ? [button("View current version", () => change(currentRevisionId, "configuration"))]
        : []),
    );
  }

  // The rail's version buttons by revision ID, for the outcome badge the latest one carries.
  const versionControls = new Map();
  // Each rail control's key (a revision ID, "new", "older" or "chooser"), so a rebuild of the
  // rail gives focus back to the same control instead of dropping it to the page (finding 2115).
  let railFocusKeys = new Map();
  // The revisions the rail last listed, not counting a viewed version shown on its own below
  // them: where the loaded pages ended.
  let listedRevisionIds = new Set();
  // A version's own deployment outcome beside its number (finding 2095): the rail knows the
  // latest version's record, so a failed or deploying latest version is marked; the others have
  // no record read here and stay plain. The rail may show before that record is read, so the
  // badge is set in place.
  function markVersionOutcomes() {
    // The badge uses the page's outcome words (finding 2093).
    const tone = { queued: "info", running: "info", failed: "danger" }[latestDeploymentStatus];
    const outcome = tone && [outcomeLabel(latestDeploymentStatus), tone];
    for (const [id, { control, line, label }] of versionControls) {
      const [text, tone] = (id === activityRevisionId && outcome) || [];
      const shown = line.querySelector(".version-outcome");
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
  function renderVersions(revisions, snapshot, historyError = null) {
    const focusKey = railFocusKeys.get(document.activeElement);
    const listedBefore = listedRevisionIds;
    listedRevisionIds = new Set(revisions.map((revision) => revision.id));
    // The rebuilt list keeps the reader's scroll position.
    const listScroll = selector.querySelector(".version-list")?.scrollTop ?? 0;
    railFocusKeys = new Map();
    revisionControls.clear();
    versionControls.clear();
    // Opening the draft is navigation. Saving a Configuration and deploying have their own permissions.
    const newVersion = button(
      callerPermissions?.update === false ? "Open version draft" : "Create new version",
      () => change("draft", "configuration"),
      {
        className: "revision-create",
        ...(selected === "draft" ? { "aria-current": "page" } : {}),
      },
    );
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
      if (snapshot) {
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
      element("option", { value: "draft" }, "New version · editable Configuration"),
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
          snapshot ? `v${snapshot.revision} · Viewed version` : "Viewed version unavailable",
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
      ].filter(Boolean),
    );
    updateNavigationControls();
    list.scrollTop = listScroll;
    // A rebuild while the reader is in the rail (a poll that lands an outcome, or older versions
    // loading) keeps focus on the same control. Once every older version is shown, focus goes to
    // the first one that just loaded, below those listed before (a poll may add a newer one
    // meanwhile; the viewed version shown on its own does not count), else the last version. A version no longer listed gives focus to the list's
    // Tab stop.
    if (focusKey !== undefined && !selector.contains(document.activeElement)) {
      const usable = items.filter((item) => !item.disabled);
      const lastShown = usable.findLastIndex((item) => listedBefore.has(railFocusKeys.get(item)));
      const target =
        [...railFocusKeys].find(([control, key]) => key === focusKey && !control.disabled)?.[0] ??
        (focusKey === "older"
          ? (usable.find(
              (item, index) => index > lastShown && !listedBefore.has(railFocusKeys.get(item)),
            ) ?? usable.at(-1))
          : ["new", "chooser"].includes(focusKey)
            ? undefined
            : (usable.find((item) => item.tabIndex === 0) ?? usable[0]));
      if (items.includes(target)) {
        focusVersion(target);
        target.scrollIntoView({ block: "nearest" });
      } else {
        target?.focus({ preventScroll: true });
      }
    }
  }

  // Without a version list yet (still loading), its first render shows the new state.
  function updateCurrentAgent(freshAgent, revisionResult, snapshot) {
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
  }

  function renderLatestDeployment() {
    markVersionOutcomes();
    const latest = visibleRevisions[0];
    if (!latest) {
      setHidden(recovery, true);
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
      return;
    }
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
        `You cannot read the current version. v${latest.revision} (${outcomeLabel(latestDeploymentStatus)}) is older.`,
      );
    } else if (!latestDeploymentStatus && !latestDeploymentError) {
      setDelayedText(latestDeploymentValue, `v${latest.revision} · `, "Loading…");
      setDelayedText(latestDeploymentNote, "", "Reading recorded deployment status.");
    } else {
      setDeploymentOutcome(
        latestDeploymentValue,
        `v${latest.revision}`,
        label ?? (latestDeploymentError ? "Unavailable" : "Loading…"),
        DEPLOYMENT_OUTCOME_TONES[latestDeploymentStatus],
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
            ? `The current version, ${shortId(currentRevisionId)}, is one you cannot read; v${latest.revision} is an older version.`
            : null,
          failureBehindHidden
            ? `The current version, ${shortId(currentRevisionId)}, is one you cannot read, so this page cannot tell whether the failed v${latest.revision} deployment affects it.`
            : null,
          failureBehindUnknown
            ? `The current version, ${shortId(currentRevisionId)}, is not among the versions listed, so this page cannot tell whether the failed v${latest.revision} deployment affects it.${olderCursor ? " Show older versions to check." : ""}`
            : null,
          successBehindUnknown
            ? `The current version, ${shortId(currentRevisionId)}, is not among the versions listed, so this page cannot tell whether it is newer than v${latest.revision}.${olderCursor ? " Show older versions to check." : ""}`
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
    // A failure that lands while the page shows (a deploy the reader is watching) leads the
    // page as it does on a load: below the open Deployment details it sat below the fold and
    // repeated their error (finding 2094, which reverses 1655's placement). The card now carries
    // that error and its next step, so the details fold once for each failed version it shows;
    // the reader can open them again. The card says nothing of a cleanup, startup warnings or a
    // refresh that could not reread the Agent, so a panel showing any of them stays open, and
    // evidence the panel records later opens it as it does without a card.
    if (recovery.hidden && !hideRecovery && recoveryFolded !== latest.id) {
      recoveryFolded = latest.id;
      const record =
        latestDeploymentRecord?.revisionId === latest.id ? latestDeploymentRecord.status : null;
      const details = activityPanel.querySelector?.(":scope > details");
      if (
        details?.open &&
        !record?.cleanup &&
        !record?.warnings?.length &&
        !latestOverviewUnavailable
      ) {
        details.open = false;
      }
    }
    setHidden(recovery, hideRecovery);
    if (!recovery.hidden) {
      const version = `v${latest.revision}`;
      const code = latestDeploymentErrorCode;
      const modelCheck = ["RUNTIME_MODEL_PROBE_FAILED", "RUNTIME_MODEL_PROBE_TIMEOUT"].includes(
        code,
      );
      setText(recoveryLabel, `Deployment failed · ${version}`);
      setText(
        recoveryTitle,
        mayBeOffline ? "This Agent may be offline" : `${version} deployment failed`,
      );
      const failure = modelCheck
        ? `${version} failed its startup model check`
        : `${version} did not deploy successfully`;
      // Offer only links the caller's permission answer and this tab's remembered denials
      // allow; the API still authorizes each page they open (finding 1458).
      const logsAllowed =
        !logTextDenied(context, agentId) &&
        !context.deniedReads?.has(`${path}/revisions/${encodeURIComponent(latest.id)}`);
      // Agent permissions can support opening a draft; they do not grant Configuration access.
      const configurationId = currentAgent.configurationId;
      const configurationAvailable =
        typeof configurationId === "string" &&
        configurationId.length > 0 &&
        !currentAgent.configurationReadError &&
        !context.deniedReads?.has(
          `${namespacePath(namespaceId)}/configurations/${encodeURIComponent(configurationId)}`,
        );
      // The API's message states this failure's own next step (finding 1393); the banner leads
      // with it, so that step is in view rather than only in Deployment details below the fold
      // (finding 1898). The generic advice stays for a record without one.
      const errorMessage = latestDeploymentErrorMessage;
      const step = deploymentFailureStep(errorMessage);
      const generic = logsAllowed
        ? "Check the failed version’s logs before deploying a new version."
        : "Ask someone with log access to check the failed version’s logs before deploying a new version.";
      let impact = errorMessage ? (step ? errorMessage : `${errorMessage} ${generic}`) : generic;
      if (replacementFailed) {
        impact = `${currentLabel} is still selected, but its runtime was probably stopped for this deployment.${errorMessage ? ` ${errorMessage}` : ""}`;
      } else if (selectedFailed) {
        impact = `${currentLabel} is still selected, but its runtime replaced the previous version before deployment finished.${errorMessage ? ` ${errorMessage}` : ""}`;
      }
      if ((replacementFailed || selectedFailed || step) && !logsAllowed) {
        // Without the Logs link this is the reader's only way to the logs (finding 1484).
        impact += " Ask someone with log access to check the failed version’s logs.";
      }
      // The code ends the first sentence, so the reader can match it to Logs and to occ.
      setText(recoveryLead, code ? `${failure} (` : `${failure}.`);
      setText(recoveryCode, code ?? "");
      setHidden(recoveryCode, !code);
      setText(recoveryRest, code ? `). ${impact}` : ` ${impact}`);
      // Deploying again is the whole next step only where the API's message says so. The draft
      // it opens builds Deploy new version only from a readable Configuration, so the link waits
      // for a successful read of it (finding 1931).
      const deployAgainAllowed =
        step === "deploy-again" && callerPermissions?.deploy === true && configurationAvailable;
      const deployAgain = deployAgainAllowed && readableConfigurationId === configurationId;
      const guidance = Object.hasOwn(DEPLOYMENT_FAILURE_LINKS, code)
        ? DEPLOYMENT_FAILURE_LINKS[code]
        : null;
      // Without update, the draft's only step is Deploy new version, which it builds only from a
      // readable Configuration, so "Open version draft" waits for the same read (finding 1944).
      const openDraftAllowed =
        guidance === "configuration" &&
        configurationAvailable &&
        callerPermissions?.update !== true &&
        callerPermissions?.deploy === true;
      if ((deployAgainAllowed || openDraftAllowed) && readableConfigurationId !== configurationId) {
        checkConfigurationReadable(configurationId);
      }
      const canOpenConfiguration =
        guidance === "configuration" &&
        configurationAvailable &&
        (callerPermissions?.update === true ||
          (openDraftAllowed && readableConfigurationId === configurationId));
      const canOpenCredentials =
        guidance === "credentials" &&
        callerPermissions?.update === true &&
        currentAgent.harnessAuth?.method !== "runtime";
      const tab = canOpenConfiguration || canOpenCredentials ? guidance : null;
      const nextLabel =
        canOpenConfiguration && callerPermissions?.update !== true
          ? "Open version draft"
          : DEPLOYMENT_FAILURE_LINK_LABELS[tab];
      const actionsFor = `${latest.id}/${tab}/${nextLabel}/${logsAllowed}/${deployAgain}`;
      if (recoveryTarget !== actionsFor) {
        recoveryTarget = actionsFor;
        const again = deployAgain
          ? versionLink("Deploy again", "draft", "configuration", { deploy: true })
          : null;
        const logs = logsAllowed ? versionLink(`Open ${version} Logs`, latest.id, "logs") : null;
        const next = tab ? versionLink(nextLabel, "draft", tab) : null;
        // The first action is the one primary on the page: Deploy again where the message says
        // to, else the failed version's Logs. The others are secondary buttons.
        const actions = [again, logs, next].filter(Boolean);
        actions.forEach((action, index) => {
          action.className = index === 0 ? "button button--primary" : "button";
        });
        recoveryActions.replaceChildren(...actions);
        recoveryActions.hidden = actions.length === 0;
      }
    }
  }

  // Another version's tabs have no reason to read the Configuration, so recovery reads it once
  // before offering Deploy again or Open version draft. A denial is remembered like the draft's;
  // any other failure leaves the links hidden for this page view. The draft's own read decides
  // there.
  function checkConfigurationReadable(configurationId) {
    if (selected === "draft" || configurationCheckId === configurationId) {
      return;
    }
    configurationCheckId = configurationId;
    const configurationPath = `${namespacePath(namespaceId)}/configurations/${encodeURIComponent(configurationId)}`;
    void request(configurationPath).then(
      () => {
        // A late answer for a Configuration the Agent has since replaced decides nothing.
        if (!context.isCurrent() || deleting || configurationCheckId !== configurationId) {
          return;
        }
        readableConfigurationId = configurationId;
        renderLatestDeployment();
      },
      (error) => {
        if (error.status === 403) {
          context.deniedReads?.remember(configurationPath);
          if (context.isCurrent() && !deleting) {
            renderLatestDeployment();
          }
        } else if (!context.isCurrent() && configurationCheckId === configurationId) {
          // Cut short by leaving the page: a view Back restores asks again.
          configurationCheckId = null;
        }
      },
    );
  }

  // List summaries omit the credential binding a revision was admitted with, so the
  // rejected-credential hint reads the newest revision once.
  async function readLatestRevisionDetail(revision) {
    if (latestRevisionDetail?.id === revision.id || latestRevisionDetailReading === revision.id) {
      return;
    }
    latestRevisionDetailReading = revision.id;
    try {
      const detail =
        viewedSnapshot?.id === revision.id
          ? viewedSnapshot
          : await request(`${path}/revisions/${encodeURIComponent(revision.id)}`);
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
    renderOverview(latestRevisionResult, viewedSnapshot);
    try {
      const page = await readRevisionPage(request, path, olderCursor);
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
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      olderError = error;
    } finally {
      olderLoading = false;
    }
    renderOverview(latestRevisionResult, viewedSnapshot);
    renderDetailHeading();
  }

  function renderOverview(revisionResult, snapshot) {
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
      latestDeploymentError = false;
      latestDeploymentErrorCode = null;
      latestDeploymentErrorMessage = null;
      // On first load the newest version's panel replaces the loading placeholder once its
      // first status read settles, in the same frame as the summary and status line, so the
      // page below moves once instead of once for an empty panel and again for the status.
      // A newer version found later replaces the shown (older) panel at once.
      const firstLoad = activityPanel === deploymentStatus;
      // A failed version's banner also waits for the caller's permission answer (finding
      // 1478), so the overview waits for it too rather than move when the banner lands.
      const showPanel = (panel, failed = false) => {
        if (activityPanel !== panel) {
          activityPanel.replaceWith(panel);
          activityPanel = panel;
        }
        void Promise.all([nativeAdmin.ready, failed ? callerPermissionsRead : null]).then(
          revealDetail,
        );
      };
      const nextPanel = mostRecent
        ? createDeploymentStatusPanel(
            context,
            path,
            mostRecent,
            (freshAgent, freshRevisions) =>
              updateCurrentAgent(
                freshAgent,
                { status: "fulfilled", value: freshRevisions },
                snapshot,
              ),
            (status, unavailable, errorCode, record, overviewUnavailable, transientFailure) => {
              if (activityRevisionId !== mostRecent.id) {
                return;
              }
              showPanel(nextPanel, status === "failed");
              latestDeploymentStatus = status;
              // A refused or missing record ends the wait, so it no longer labels the version.
              if (record || !transientFailure) {
                latestRecordedStatus = status;
              }
              if (overviewUnavailable) {
                agentRereadFailed = true;
              }
              latestOverviewUnavailable = Boolean(overviewUnavailable);
              latestDeploymentError = unavailable;
              latestDeploymentErrorCode = errorCode;
              latestDeploymentErrorMessage = record?.error?.message || null;
              if (errorCode === "RUNTIME_AUTHENTICATION_FAILED") {
                void readLatestRevisionDetail(mostRecent);
              }
              latestDeploymentRecord = record
                ? { revisionId: mostRecent.id, status: record }
                : null;
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
    if (permissions.update === false) {
      // This opens the draft; Configuration update and Agent deploy are independent grants.
      if (headerNewVersion) {
        headerNewVersion.textContent = "Open version draft";
      }
      for (const control of selector.querySelectorAll(".revision-create")) {
        control.textContent = "Open version draft";
      }
    }
    refreshDeployControls();
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
      return await request(snapshotPath);
    } catch (error) {
      if (error.status === 403) {
        context.deniedReads?.remember(snapshotPath);
      }
      throw error;
    }
  }

  async function loadDetails() {
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
    let snapshot = results[1].status === "fulfilled" ? results[1].value : null;
    if (selected === "draft") {
      // The draft's own read is the Configuration read; recovery waits for it.
      readableConfigurationId = snapshot?.id ?? null;
    }
    detailLoadFinished = true;
    viewedSnapshot = snapshot;
    renderOverview(revisionResult, snapshot);
    renderDetailHeading();
    const configurationReadError =
      selected === "draft" ? agent.configurationReadError : snapshot?.configurationReadError;
    if (configurationReadError) {
      return { error: configurationReadError };
    }
    if (!snapshot) {
      return { error: results[1].reason };
    }
    const draft = selected === "draft";
    let values = draft ? snapshot.values : snapshot.configuration;
    const executionMode = draft ? agent.executionMode : snapshot.harness.mode;
    if (!draft) {
      let diagnosticsPanel = null;
      versionRecord = createVersionDeploymentRecord(
        context,
        path,
        selected,
        () => diagnosticsPanel?.render(),
        { shared: activityRevisionId === selected && !latestDeploymentError },
      );
      diagnosticsPanel = createVersionDiagnosticsPanel(
        context,
        path,
        selected,
        () => versionRecord.current(),
        callerPermissionsRead.then((permissions) => permissions?.operate),
      );
      versionEvidence.append(versionRecord.section, diagnosticsPanel.section);
      if (latestDeploymentRecord?.revisionId === selected) {
        versionRecord.show(latestDeploymentRecord.status);
      }
      return { snapshot, values, draft, executionMode, credentials: null };
    }
    let deploy;
    let deployPending = false;
    let deployReloadMessage = "";
    let deployFeedback;
    let deployStatus;
    let authenticationForm;
    const retainedAuthentication = context.drafts.get("authentication");
    let authenticationPending = Boolean(
      retainedAuthentication?.outcomeUnknown || retainedAuthentication?.savedAuthentication,
    );
    // Authentication edits staged in Credentials but not yet saved.
    let authenticationUnsaved = false;
    const retainedEditor = context.drafts.get("configuration");
    const draftEditorState = {
      dirty: Boolean(retainedEditor && retainedEditor.text !== retainedEditor.initialText),
      saving: false,
      outcomeUnknown: retainedEditor?.outcomeUnknown ?? false,
      reloadRequired: retainedEditor?.reloadRequired ?? false,
    };
    const retainedPlugins = context.drafts.get("plugins");
    const pluginEditorState = {
      dirty: Boolean(retainedPlugins?.dirty),
      saving: false,
      outcomeUnknown: retainedPlugins?.outcomeUnknown ?? false,
      reloadRequired: retainedPlugins?.reloadRequired ?? false,
    };
    const runtimeAuth = agent.harnessAuth?.method === "runtime";
    // The carried choices apply once, to the panel built from the reread.
    const carriedSecrets = carriedChannelSecrets ?? context.drafts.get("channelSecrets") ?? null;
    carriedChannelSecrets = null;
    context.drafts.forget("channelSecrets");
    const credentials =
      draft && !runtimeAuth
        ? createChannelSecretsPanel({
            context,
            path,
            agent,
            configuration: snapshot,
            values,
            revisionsLoaded: revisionResult.status === "fulfilled",
            carried: carriedSecrets,
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
                focus: "Save channel Secrets",
              });
            },
          })
        : null;
    // Operator-managed credentials build no channel Secrets panel to say so (finding 1525).
    const channelSecretsNote =
      draft && runtimeAuth && carriedSecrets
        ? "Your channel Secret choices were not reapplied: this Agent now uses operator-managed credentials."
        : "";
    activeCredentials = credentials;
    function editedSubject() {
      if (selectedTab === "repositories") {
        return "repository access";
      }
      return selectedTab === "channels" ? "channel settings" : "Configuration";
    }
    function retainedConfigurationState() {
      const retained = selectedTab === "configuration" ? null : context.drafts.get("configuration");
      return {
        dirty: Boolean(retained && retained.text !== retained.initialText),
        reloadRequired: Boolean(retained?.outcomeUnknown || retained?.reloadRequired),
      };
    }
    const setupCredentials =
      draft && !runtimeAuth
        ? button("Set up credentials", () => change("draft", "credentials"))
        : null;
    function deployIsDisabled() {
      const retainedConfiguration = retainedConfigurationState();
      return (
        deployPending ||
        callerPermissions?.deploy === false ||
        authenticationSaveState !== "idle" ||
        Boolean(deployReloadMessage) ||
        authenticationPending ||
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
      if (!deploy || !deployStatus) {
        return;
      }
      const retainedConfiguration = retainedConfigurationState();
      deploy.disabled = deployIsDisabled();
      if (setupCredentials) {
        setupCredentials.hidden =
          selectedTab === "credentials" ||
          revisionResult.status !== "fulfilled" ||
          channelCredentialBlockReason(values) !== null ||
          (Boolean(agent.harnessAuth) && !authenticationPending && credentials.canDeploy());
        setupCredentials.disabled = deployPending || Boolean(draftEditorNavigationBlock);
      }
      if (!deployPending) {
        if (callerPermissions?.deploy === false) {
          deployStatus.textContent = "Your access does not include deploying this Agent.";
        } else if (deployReloadMessage) {
          deployStatus.textContent = deployReloadMessage;
        } else if (authenticationSaveState === "saving") {
          deployStatus.textContent = "Wait for the authentication save to finish before deploying.";
        } else if (authenticationSaveState === "uncertain") {
          deployStatus.textContent =
            "Authentication may have been saved. Reload this draft before deploying.";
        } else if (authenticationPending) {
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
          const gate = credentials.deployGateMessage();
          // Secret values can be updated in place, so a rejected credential warns instead of
          // blocking. It never reads "Ready to deploy.": deploying again does not fix it.
          const rejected =
            "The last deployment's model credential was rejected; update or replace it in Credentials before deploying again.";
          deployStatus.textContent = !credentialRejected()
            ? gate
            : gate === "Ready to deploy."
              ? rejected
              : `${gate} ${rejected}`;
        }
      }
      updateChecklist();
    }
    // The last deployment's model credential was rejected and the draft still uses it.
    function credentialRejected() {
      return (
        latestDeploymentErrorCode === "RUNTIME_AUTHENTICATION_FAILED" &&
        latestRevisionDetail !== null &&
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
    function setStep(step, done, detail) {
      const value = done ? "done" : "pending";
      if (step.item.dataset.state !== value) {
        step.item.dataset.state = value;
        step.state.textContent = done ? "Done: " : "Not done: ";
      }
      setText(step.detail, detail);
    }
    function updateChecklist() {
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
    deployStatus = element("p", { className: "muted", role: "status" });
    deployFeedback = statusBlock("danger", null, null);
    deploy = button(
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
          const freshAgent = await request(path);
          if (!context.isCurrent()) {
            return;
          }
          assertReadableConfiguration(freshAgent);
          if (!freshAgent.harnessAuth) {
            deployFeedback.textContent =
              "Select a harness authentication source in Credentials before deployment.";
            return;
          }
          const freshConfig = await request(
            `${namespacePath(namespaceId)}/configurations/${encodeURIComponent(freshAgent.configurationId)}`,
          );
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
          const revision = await request(`${path}/deploy`, { method: "POST" });
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
          if (error.status === 401) {
            context.onExpired();
            return;
          }
          deployFeedback.textContent = deployFailureText(error, submitted);
          if (
            !submitted ||
            deployRefusedBeforeAdmission(error) ||
            [400, 403, 404, 409, 429].includes(error.status)
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
    const draftActions = element(
      "section",
      { className: "card agent-draft-actions" },
      element("h2", {}, "Prepare this version"),
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
      draft,
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
      get authenticationSaveState() {
        return authenticationSaveState;
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
  async function refreshDraftInPlace({ agent: freshAgent = null, saved = "", focus = null } = {}) {
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
  async function reloadDraftInPlace(tabContext, options) {
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
      fresh = await tabContext.request(path);
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
    if (fresh) {
      await refreshDraftInPlace({ agent: fresh, ...options });
    } else {
      context.navigate(target("draft", selectedTab), namespaceId, true);
    }
  }

  // Reads the caller's permission answer again; a failed read keeps the last answer.
  function rereadPermissions() {
    const previous = latestPermissionsRead;
    const reread = ++permissionsRereads;
    const read = request(`${path}/permissions`).then(
      (permissions) => {
        if (context.isCurrent() && reread === permissionsRereads) {
          callerPermissions = permissions;
          if (latestDeploymentStatus === "failed" && !deleting) {
            renderLatestDeployment();
          }
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

  async function refreshDraft(freshAgent, saved, focus) {
    if (freshAgent) {
      agent = freshAgent;
      updateCurrentAgent(freshAgent, latestRevisionResult, viewedSnapshot);
    }
    // The rebuilt editors take the fresh answer.
    agentUpdateAllowed = rereadPermissions().then((permissions) => permissions?.update);
    const next = loadDetails();
    const data = await next;
    if (!context.isCurrent() || deleting || !data) {
      return;
    }
    settledDetails = next;
    if (data.error) {
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
    const shrunk = versionLayout.getBoundingClientRect().bottom - bottomBefore;
    if (anchorBelow && shrunk < 0) {
      globalThis.scrollBy({ top: shrunk, behavior: "instant" });
    }
    // `focus` may list fallbacks; the first enabled match in the tab takes focus.
    const named = [...content.querySelectorAll("button")].find(
      (candidate) => [focus].flat().includes(candidate.textContent) && !candidate.disabled,
    );
    const status = saved
      ? [...content.querySelectorAll('[role="status"]')].find((node) => node.textContent === saved)
      : null;
    let control = named ?? tabControls.get(selectedTab);
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
      control.setAttribute("aria-describedby", status.id);
    } else if (status) {
      // A save that leaves nothing to save disables its own button; the status takes focus
      // instead of the tab bar above, which would scroll the reader away.
      status.tabIndex = -1;
      control = status;
    }
    if (!focusMoved) {
      control.focus();
    }
  }

  async function renderTab({ activated = false } = {}) {
    // A Logs view left before it showed no longer holds the cards below it back.
    view.classList.remove("agent-logs-opening");
    const resumeDrafts = context.suspendDrafts();
    if (mountedTab) {
      mountedTab.resumeDrafts = resumeDrafts;
      for (const input of content.querySelectorAll('input[type="password"]')) {
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
    for (const [index, id] of tabsForSelection.entries()) {
      const control = tabs.children[index];
      control.setAttribute("aria-selected", String(id === tab));
      control.tabIndex = id === tab ? 0 : -1;
    }
    content.setAttribute("aria-labelledby", `${tabIds}-${tab}`);
    // History can select another tab while focus is in the strip; focus follows the selection,
    // so the focused tab is the one revealed and the Tab stop.
    if (focusInStrip && document.activeElement !== tabControls.get(tab)) {
      tabControls.get(tab).focus({ preventScroll: true });
    }
    revealSelectedTab();
    fadeTabEdges();
    refreshDeployControls();
    const retained = retainedTabs.get(tab);
    retainedTabs.delete(tab);
    if (retained && retained.mutations === context.mutationVersion()) {
      mountedTab = retained;
      showDraftEditorNavigationBlock = retained.showBlock;
      content.replaceChildren(...retained.nodes);
      // The deployment may have settled while this tab was parked.
      renderVersionNotice();
      retained.resumeDrafts();
      return;
    }
    showDraftEditorNavigationBlock = showBlockInPanel;
    const state = {
      id: tab,
      reusable: true,
      loading: true,
      pending: 0,
      mutations: context.mutationVersion(),
    };
    mountedTab = state;
    const tabContext = {
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
      const workspace = renderWorkspaceFiles(tabContext, currentAgent, path);
      state.refresh = workspace.refresh;
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
          const focused = document.activeElement === control;
          control.hidden = true;
          leaveDeniedAccess({ refocus: focused });
        },
      });
      if (tabControls.get("access").hidden) {
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
      content.append(renderAgentDriverConfigurations(tabContext, { agent, revisionId: selected }));
      state.loading = false;
      content.style.minHeight = "";
      return;
    }
    if (tab === "logs") {
      // The version heading still comes from the snapshot read.
      details ??= loadDetails();
      // Polling views are rebuilt on every visit instead of being retained.
      state.reusable = false;
      const logs = renderAgentLogs(tabContext, {
        agent,
        revisionId: selected,
        shown: revealed,
        // A rebuilt view asks for a fresh answer when it remembers a status denial; a read
        // still in flight is that answer.
        permissions: ({ fresh = false } = {}) =>
          fresh && permissionsReadSettled ? rereadPermissions() : latestPermissionsRead,
        // The failed-version recovery stops offering Logs as soon as they are denied.
        onLogsDenied: () => {
          if (tabContext.isCurrent() && !recovery.hidden) {
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
          tabControls.get("logs").focus({ preventScroll: true });
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
    if (data?.error) {
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

  function renderConfigurationTab(context, selectedTab, data) {
    const { snapshot, values, draft, executionMode, credentials, channelSecretsNote } = data;
    content.append(
      statusBlock("info", null, versionNotice(), [], { className: "version-selection-notice" }),
    );
    if (selectedTab === "repositories" && draft) {
      content.append(renderRepositoryEditor(context, data));
    } else if (selectedTab === "plugins") {
      const plugins = renderAgentPlugins(context, {
        agent,
        snapshot,
        draft,
        path,
        onState: data.setPluginEditorState,
        savedNotice,
        updateAllowed: agentUpdateAllowed,
        // Saves and reloads rebuild the tab in place (finding 1445's rest).
        onSaved: (savedAgent) =>
          refreshDraftInPlace({ agent: savedAgent, saved: "Plugin selections saved." }),
        onReload: () => {
          context.drafts.forget("plugins");
          return reloadDraftInPlace(context, { saved: "Plugin selections reloaded." });
        },
      });
      // Plugin blocks had no note of their own: the sidebar and Back refused in silence.
      showDraftEditorNavigationBlock = () =>
        showLeaveNote(plugins, draftEditorNavigationBlock, "after");
      content.append(plugins);
    } else if (selectedTab === "channels") {
      const channels = renderChannels({
        values,
        executionMode,
        readOnly: !draft,
        // Every deployment needs a model authentication source, so the drawer asks for one only
        // while the Agent has none; a deployed Agent with its key bound was told to set
        // credentials "before first deploy" (finding 2063).
        copy: {
          drawerNotice: `New version. Changes affect future deployments using this Configuration.${
            agent.harnessAuth
              ? ""
              : " Configure model credentials in the Credentials tab before deploying."
          }`,
        },
        drawerContext: {
          drafts: context.drafts,
          baseline: JSON.stringify([snapshot.id, snapshot.generation]),
          operatorId: context.operatorId,
          namespaceId,
          request,
          agentName: agent.name,
          configurationId: snapshot.id,
          secretBindings: snapshot.secretBindings,
          isCurrent: context.isCurrent,
          onExpired: context.onExpired,
          credentialsHref: context.pageUrl(
            `agents/${agent.id}?revision=draft&tab=credentials`,
            namespaceId,
          ),
        },
        onSave: async (updatedValues, options = {}) => {
          let mutationStarted = false;
          let configurationSaved = false;
          try {
            const [freshAgent, freshConfig] = await Promise.all([
              request(path),
              request(
                `${namespacePath(namespaceId)}/configurations/${encodeURIComponent(snapshot.id)}`,
              ),
            ]);
            if (!context.isCurrent()) {
              throw new Error("This view has changed. Reopen the Configuration before saving.");
            }
            assertReadableConfiguration(freshAgent);
            if (
              freshAgent.configurationId !== snapshot.id ||
              freshConfig.generation !== snapshot.generation
            ) {
              // The section offers Reload draft; reopening the editor kept failing against
              // the page's old generation until a browser reload (finding 1480).
              throw Object.assign(new Error(CONFIGURATION_CHANGED), { reloadRequired: true });
            }
            mutationStarted = true;
            const nextSecretBindings = options.secretBindings;
            await request(
              `${namespacePath(namespaceId)}/configurations/${encodeURIComponent(snapshot.id)}`,
              {
                method: "PATCH",
                body: {
                  values: updatedValues,
                  ...(nextSecretBindings === undefined
                    ? {}
                    : { secretBindings: nextSecretBindings }),
                  // A save from another browser after the reread above is refused, not
                  // overwritten (finding 1505).
                  expectedGeneration: snapshot.generation,
                },
              },
            );
            configurationSaved = true;
            details = null;
            try {
              if (options.changedSecrets !== undefined) {
                for (const secret of options.changedSecrets) {
                  await ensureCredentialOperateBinding(context, freshAgent, secret);
                }
              }
            } catch (error) {
              error.message =
                "Configuration saved, but Secret access grants could not be confirmed. Reload the draft, inspect saved bindings in Agent Credentials, then ask a Namespace administrator to grant this Agent access to the saved Secret.";
              error.outcomeUnknown = true;
              throw error;
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
              refusedSave(error, "configuration", mutationStarted);
            }
            if (error.status === 401) {
              context.onExpired();
              throw new Error("Your session has expired.");
            }
            if (isStaleGeneration(error) && mutationStarted && !configurationSaved) {
              // The PATCH found a newer generation than the reread: the same recovery applies.
              throw Object.assign(new Error(CONFIGURATION_CHANGED), { reloadRequired: true });
            }
            if (
              error.status !== undefined ||
              error.name === "TimeoutError" ||
              error.name === "TypeError"
            ) {
              if (!configurationSaved) {
                error.message =
                  configurationConflictMessage(error, mutationStarted) ??
                  rejectionMessage(error, mutationStarted);
              }
            }
            error.outcomeUnknown =
              error.outcomeUnknown ??
              (mutationStarted && ![400, 403, 404, 409, 429].includes(error.status));
            throw error;
          }
        },
        onStateChange: ({ pending, outcomeUnknown, reloadRequired = false }) => {
          if (context.isCurrent()) {
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
        onSaved: (focus) => refreshDraftInPlace({ saved: "Channels saved.", focus }),
        // The section forgets its editor draft first unless a save conflict carried it.
        onReload: () => reloadDraftInPlace(context, { saved: "Draft reloaded." }),
      });
      const navigationFeedback = element("p", { className: "hint", role: "status" });
      showDraftEditorNavigationBlock = () => {
        navigationFeedback.textContent = draftEditorNavigationBlock;
      };
      content.append(channels, navigationFeedback);
    } else if (selectedTab === "credentials" && draft) {
      const retained = context.drafts.get("authentication");
      const baseline = retained?.baseline ?? {
        configurationId: agent.configurationId,
        harnessAuth: agent.harnessAuth,
      };
      let syncUnsavedAuthentication = () => {};
      const auth = createHarnessAuthFields(
        context,
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
      const say = (text, tone = null) => {
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
          fresh = await context.request(path);
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
        save,
        reload,
        feedback,
      );
      data.setAuthenticationForm(form);
      authenticationLeaveAnchor = form;
      let outcomeUnknown = retained?.outcomeUnknown ?? false;
      let pending = false;
      // Set when the caller's permission answer denies Agent update (finding 1530).
      let updateDenied = false;
      void agentUpdateAllowed.then((allowed) => {
        if (allowed === false && context.isCurrent()) {
          // Retry credential access only rechecks the Secret grant; it is not an Agent update.
          if (savedAuthentication) {
            return;
          }
          updateDenied = true;
          updateNote.textContent = AGENT_UPDATE_DENIED;
          updateNote.hidden = false;
          save.disabled = true;
          // An edit that cannot be saved would only block Deploy (finding 1539).
          auth.setDisabled(true);
        }
      });
      let savedAuthentication = retained?.savedAuthentication ?? null;
      const originalFields = retained?.originalFields ?? auth.capture();
      const bindingFields = ({ method, secretSource, credentialSource, account }) =>
        JSON.stringify({ method, secretSource, credentialSource, account });
      syncUnsavedAuthentication = () => {
        // Pending and saved states already gate deployment with their own messages.
        data.setAuthenticationUnsaved(
          !pending &&
            !outcomeUnknown &&
            !savedAuthentication &&
            bindingFields(auth.capture()) !== bindingFields(originalFields),
        );
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
            }
          : undefined;
      });
      if (savedAuthentication) {
        save.textContent = "Retry credential access";
        auth.setDisabled(true);
        setStatusTone(feedback, "warning");
        feedback.textContent =
          "Authentication source saved. Retry credential access to confirm this Agent can use the selected Secret.";
      }
      if (outcomeUnknown) {
        save.disabled = true;
        auth.setDisabled(true);
        setStatusTone(feedback, "danger");
        feedback.textContent = "Outcome unknown. Reload authentication source before saving again.";
      }
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        // The console's own errors under each field, not the browser's bubble (UX plan C3).
        if (!validateFields([...form.elements]) || save.disabled) {
          return;
        }
        let harnessAuth;
        try {
          harnessAuth = savedAuthentication?.harnessAuth ?? (await auth.readBinding());
        } catch (error) {
          // Incomplete fields (no Secret, unfinished ChatGPT sign-in) say what to do next.
          say(error.message, "danger");
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
        try {
          const current = await request(path);
          if (!context.isCurrent()) {
            return;
          }
          assertReadableConfiguration(current);
          // The Agent as saved: this PATCH's response, or the fresh read on a retry.
          let savedAgent = current;
          const expected = savedAuthentication ?? baseline;
          if (
            current.configurationId !== expected.configurationId ||
            JSON.stringify(current.harnessAuth) !== JSON.stringify(expected.harnessAuth)
          ) {
            say("The Configuration changed. Reload authentication source before saving.", "danger");
            outcomeUnknown = true;
            return;
          }
          if (!savedAuthentication) {
            const credentialSources = (current.credentialSources ?? []).filter(
              (source) =>
                current.harnessAuth?.method !== "credential_source" ||
                current.harnessAuth.sourceId === harnessAuth?.sourceId ||
                source.sourceId !== current.harnessAuth.sourceId,
            );
            if (
              harnessAuth?.method === "credential_source" &&
              !credentialSources.some((source) => source.sourceId === harnessAuth.sourceId)
            ) {
              credentialSources.push({ sourceId: harnessAuth.sourceId });
            }
            mutationStarted = true;
            savedAuthentication = await request(path, {
              method: "PATCH",
              body: { configurationId: agent.configurationId, harnessAuth, credentialSources },
            });
            savedAgent = savedAuthentication;
            details = null;
          }
          if (harnessAuth?.method === "credential_source") {
            say("Authentication saved. Checking credential source access…");
            await ensureCredentialOperateBinding(context, current, {
              kind: "credential_source",
              namespaceId: context.namespaceId,
              id: harnessAuth.sourceId,
            });
          } else if (harnessAuth?.source?.kind === "secret") {
            say("Authentication saved. Checking Secret access…");
            await ensureCredentialOperateBinding(context, current, harnessAuth.source);
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
          if (error.status === 401) {
            context.onExpired();
          } else if (savedAuthentication) {
            say(
              savedAuthentication.harnessAuth?.method === "credential_source"
                ? `Authentication source saved, but this Agent's credential source access could not be confirmed. ${message(error)} Ask a Namespace administrator to grant this Agent operate access to the selected credential source, then retry credential access. Deployment readiness is not confirmed.`
                : `Authentication source saved, but this Agent's Secret access could not be confirmed. ${message(error)} Ask a Namespace administrator to grant this Agent secret:operate on the selected Secret, then retry credential access. Deployment readiness is not confirmed.`,
              "warning",
            );
          } else {
            outcomeUnknown =
              error.outcomeUnknown ??
              (mutationStarted && ![400, 403, 404, 409, 429].includes(error.status));
            say(
              error.outcomeUnknown
                ? error.message
                : rejectionMessage(refusedSave(error, "agent", mutationStarted), mutationStarted),
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
      const details = [
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
                element(
                  "div",
                  { className: "form-actions" },
                  button("Edit current Configuration", () => {
                    // The draft this navigation opens takes it with its editor open. Saving
                    // patches the Configuration, which the API authorizes on its own.
                    linkedVersionView = {
                      key: linkedKey("draft", "configuration"),
                      load: consoleLoads + 1,
                      edit: true,
                    };
                    context.navigate(target("draft", "configuration"));
                  }),
                ),
                nativeDocument(values, "View admitted native configuration"),
              ),
        ),
      );
    }
  }

  function renderRepositoryEditor(context, data) {
    let fields;
    let saveState = "idle";
    // Set when the caller's permission answer denies Agent update (finding 1530).
    let updateDenied = false;
    const updateNote = element("p", { className: "muted", role: "status", hidden: true });
    const feedback = element("p", { className: "hint", role: "status" }, savedNotice);
    // A refused save is a danger block that takes focus; other notes stay a hint (finding 1966).
    const refuse = (text) => {
      setStatusTone(feedback, "danger");
      feedback.textContent = text;
      revealStatus(feedback, feedback.closest("section") ?? undefined);
    };
    // Reload and Cancel reread the Agent and rebuild this tab in place (finding 1445's rest).
    // Set once Reload or Cancel starts rereading; this editor is about to be replaced.
    let reloading = false;
    function rebuild(saved, focus) {
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
      save.disabled =
        updateDenied || locked || !dirty || !fields?.isSettled() || fields.blocksCreate();
      if (save.getAttribute("aria-busy") !== String(pending)) {
        save.setAttribute("aria-busy", String(pending));
      }
      cancel.disabled = locked;
      reload.hidden = !outcomeUnknown && !reloadRequired;
      // An edit that cannot be saved would only block leaving the tab (finding 1539).
      fields?.setDisabled(locked || updateDenied);
    }
    fields = createRepositoryFields(
      context,
      (changed) => {
        if (changed) {
          setStatusTone(feedback, null);
          feedback.textContent = fields.isDirty()
            ? "Save or cancel repository changes before deploying."
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
        : "Save or cancel repository changes before leaving this tab.";
    };
    async function submit() {
      if (save.disabled || !fields.validate()) {
        return;
      }
      saveState = "saving";
      update();
      let mutationStarted = false;
      let saved = false;
      try {
        const fresh = await request(path);
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
        const savedAgent = await request(path, {
          method: "PATCH",
          body: {
            configurationId: agent.configurationId,
            repositoryAccess: fields.access(),
          },
        });
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
        if (error.status === 401) {
          context.onExpired();
        } else {
          refuse(
            rejectionMessage(
              saved ? error : refusedSave(error, "agent", mutationStarted),
              mutationStarted,
            ),
          );
          if (mutationStarted && ![400, 403, 404, 409, 429].includes(error.status)) {
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
    void agentUpdateAllowed.then((allowed) => {
      if (allowed === false && context.isCurrent()) {
        updateDenied = true;
        updateNote.textContent = AGENT_UPDATE_DENIED;
        updateNote.hidden = false;
        update();
      }
    });
    return element(
      "section",
      { className: "agent-card" },
      fields.section,
      updateNote,
      element("div", { className: "form-actions" }, save, cancel, reload),
      feedback,
    );
  }

  // Edits carried through a save conflict, merged over the Configuration Reload draft reread
  // (finding 1512). Returns the editor draft to open and a note on what was applied.
  function carriedConfigurationDraft(context, snapshot, values) {
    const retained = context.drafts.get("configuration");
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
    const shown = (value) => {
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

  function renderDraftConfigurationEditor(context, data) {
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
    context.drafts.unsavedWhen(
      "configuration",
      (draft) => draft !== undefined && (draft.text !== draft.initialText || draft.outcomeUnknown),
    );
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
    const password = values.gateway?.auth?.password;
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
            ...values.gateway,
            auth: {
              ...values.gateway?.auth,
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
        return JSON.parse(editor.value);
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
      try {
        const [freshAgent, freshConfig] = await Promise.all([
          request(path),
          request(
            `${namespacePath(namespaceId)}/configurations/${encodeURIComponent(baseline.id)}`,
          ),
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
        await request(
          `${namespacePath(namespaceId)}/configurations/${encodeURIComponent(baseline.id)}`,
          {
            method: "PATCH",
            // A save from another browser after the reread above is refused (finding 1505).
            body: { values: nextValues, expectedGeneration: baseline.generation },
          },
        );
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
        if (error.status === 401) {
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
        setStatusTone(feedback, "danger");
        feedback.textContent =
          configurationConflictMessage(error, mutationStarted && !configurationSaved) ??
          rejectionMessage(error, mutationStarted);
        feedbackLocked = true;
        outcomeUnknown = mutationStarted && ![400, 403, 404, 409, 429].includes(error.status);
      } finally {
        if (context.isCurrent()) {
          pending = false;
          updateState();
          render();
          const refused = feedback.dataset.tone === "danger";
          feedback.setAttribute("role", refused ? "alert" : "status");
          if (container.isConnected && refused && !outcomeUnknown && !reloadRequired) {
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

    function render() {
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
    return container;
  }

  view.append(dangerZone);
  context.setTabNavigation((next) => {
    const nextRevision = next.searchParams.get("revision") ?? agent.activeRevisionId ?? "draft";
    const nextTab = tabsForSelection.includes(next.searchParams.get("tab"))
      ? next.searchParams.get("tab")
      : "configuration";
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
    if (!recovery.hidden) {
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
