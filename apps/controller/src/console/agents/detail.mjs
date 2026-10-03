import { element, button } from "../dom.mjs";
import {
  configuredHarnessId,
  createHarnessAuthFields,
  renderHarnessAuthSummary,
} from "./harness-auth.mjs";
import { renderAgentAccess } from "./access.mjs";
import { renderRuntimeAccess } from "./runtime-access.mjs";
import { createAgentDeletion } from "./deletion.mjs";
import { createAgentStop } from "./stop.mjs";
import { pluginWarningText, renderAgentPlugins } from "./plugins.mjs";
import { repositoryProfile, repositoryWriteAccessHelp } from "./repository-profiles.mjs";
import { createRepositoryFields } from "./repositories.mjs";
import { renderChannels } from "../channels.mjs";
import { renderWorkspaceFiles } from "./workspace.mjs";
import { renderAgentLogs } from "./logs.mjs";
import {
  displayDate,
  shortId,
  namespacePath,
  link,
  message,
  rejectionMessage,
  assertReadableConfiguration,
} from "./list.mjs";
import {
  createChannelSecretsPanel,
  hasRequiredChannelCredentials,
  channelCredentialBlockReason,
} from "./credentials.mjs";
import { ensureSecretOperateBinding } from "./secret-access.mjs";

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

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Next steps for failure codes whose cause the operator can act on directly, and the
// page that holds the setting to change. Model-probe codes come from the runtime
// wrapper's startup model check (`runtime-entrypoints.ts`). OpenClaw classifies
// transport errors (refused connection, DNS failure, "fetch failed") as a timeout, so
// there an unreachable provider reports RUNTIME_MODEL_PROBE_TIMEOUT; Codex reports the
// same failure as RUNTIME_MODEL_PROBE_FAILED unless the connection hangs until its cap.
const DEPLOYMENT_FAILURE_GUIDANCE = {
  RUNTIME_AUTHENTICATION_FAILED: {
    text: "The model provider rejected this version's credential (HTTP 401 or 403). Check that the key is valid and can use the selected model, update or replace the model credential Secret, then deploy a new version.",
    link: "credentials",
  },
  RUNTIME_MODEL_PROBE_FAILED: {
    text: "The startup model check failed for a reason other than a rejected credential, such as an unknown model, invalid provider settings, a provider or TLS error, a rate limit or quota, or, with Codex, a provider the runtime cannot reach. Check the model and its provider settings (such as baseUrl and api) in the Configuration, the provider account, and that the runtime can reach the provider, then deploy a new version.",
    link: "configuration",
  },
  RUNTIME_MODEL_PROBE_TIMEOUT: {
    text: "The startup model check did not get a reply from the model provider in time. With OpenClaw this includes a provider the runtime cannot reach (refused connection or unknown host). Check that the runtime can reach the provider (network egress, proxy, or a custom baseUrl in the Configuration) and that the provider is responding, then deploy a new version.",
    link: "configuration",
  },
};

const DEPLOYMENT_FAILURE_LINK_LABELS = {
  credentials: "Open Credentials",
  configuration: "Open Configuration",
};

function deploymentFailure(error, hrefs = {}, logs = null) {
  if (!error) {
    return element("p", { className: "muted" }, "No persisted startup failure.");
  }
  const runtimeFailure = error.data?.runtimeFailure;
  const guidance = Object.hasOwn(DEPLOYMENT_FAILURE_GUIDANCE, error.code)
    ? DEPLOYMENT_FAILURE_GUIDANCE[error.code]
    : null;
  const guidanceHref = guidance ? (hrefs[guidance.link] ?? null) : null;
  return element(
    "div",
    {},
    element("p", { className: "error", role: "alert" }, `${error.code}: ${error.message}`),
    guidance
      ? element(
          "p",
          { className: "hint deployment-failure-guidance" },
          guidance.text,
          guidanceHref ? " " : null,
          guidanceHref
            ? element("a", { href: guidanceHref }, DEPLOYMENT_FAILURE_LINK_LABELS[guidance.link])
            : null,
        )
      : null,
    // A failed version may never become current, so link its output directly.
    logs
      ? element(
          "p",
          { className: "hint" },
          element("a", { href: logs.href }, `Open v${logs.revision} Logs`),
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
          element("dt", {}, "Checked"),
          element("dd", {}, displayDate(runtimeFailure.checkedAt)),
        )
      : null,
  );
}

function deploymentProgress(status, progress) {
  const workDescriptions = {
    queued: progress?.lastAttempt
      ? "Waiting to continue deployment."
      : "Waiting for a worker claim.",
    running: "A worker claim is active.",
    failed: "Deployment work failed; check the recorded error and current version.",
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
            : "failed",
    ],
    [
      "Completion recorded",
      status === "succeeded"
        ? "This deployment completed activation or was already active."
        : status === "failed"
          ? "Successful completion was not recorded for this deployment."
          : "Successful completion is not recorded yet.",
      status === "succeeded" ? "complete" : "waiting",
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
const PENDING_DEPLOYMENT_STATUSES = new Set(["queued", "running"]);

function createDeploymentStatusPanel(
  context,
  path,
  revision,
  onAgentChange,
  onStatusChange,
  credentialsHref = null,
  logsHref = null,
  configurationHref = null,
) {
  const section = element("section", { className: "agent-card deployment-status" });
  const state = { loading: false, status: null, error: null, overviewError: false };
  let pollTimer = null;

  // A poll that fired while the view was retained stopped; restoring the view re-arms it.
  context.onResume?.(() => {
    if (section.isConnected) {
      schedulePoll();
    }
  });

  // Queued and running records are reread until they record a result or a read fails.
  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = null;
    if (state.error || !PENDING_DEPLOYMENT_STATUSES.has(state.status?.status)) {
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
    const previousStatus = state.status?.status ?? null;
    state.loading = true;
    state.error = null;
    state.overviewError = false;
    render();
    try {
      const [statusResult, agentResult, revisionsResult] = await Promise.allSettled([
        context.request(`${path}/deployments/${encodeURIComponent(revision.id)}`),
        refreshAgent ? context.request(path) : Promise.resolve(null),
        refreshAgent ? context.request(`${path}/revisions`) : Promise.resolve(null),
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
        onStatusChange(
          state.status?.status ?? null,
          state.error !== null,
          state.status?.error?.code ?? null,
          state.status,
        );
        if (
          poll &&
          PENDING_DEPLOYMENT_STATUSES.has(previousStatus) &&
          !state.error &&
          !PENDING_DEPLOYMENT_STATUSES.has(state.status?.status)
        ) {
          // A recorded result can change the current version; reread it once.
          void loadStatus(true);
        } else {
          schedulePoll();
        }
      }
    }
  }

  function renderStatus() {
    if (state.error) {
      return element("p", { className: "error", role: "alert" }, message(state.error));
    }
    if (!state.status) {
      return element("p", { className: "muted" }, "Deployment status has not loaded.");
    }
    return element(
      "div",
      {},
      deploymentProgress(state.status.status, state.status.progress),
      state.status.progress
        ? element(
            "div",
            { className: "deployment-pending-progress" },
            state.status.progress.lastAttempt
              ? element(
                  "dl",
                  { className: "credential-status-list" },
                  element("dt", {}, "Last recorded result"),
                  element("dd", {}, state.status.progress.lastAttempt.message),
                  element("dt", {}, "Reason"),
                  element("dd", {}, state.status.progress.lastAttempt.code),
                  element("dt", {}, "Since"),
                  element("dd", {}, displayDate(state.status.progress.lastAttempt.at)),
                )
              : element("p", { className: "muted" }, "No reconciliation result is available yet."),
            state.status.progress.nextAttemptAt
              ? element(
                  "p",
                  { className: "muted" },
                  `Eligible for next attempt: ${displayDate(state.status.progress.nextAttemptAt)}. Start time depends on worker availability.`,
                )
              : null,
          )
        : null,
      element("p", { className: "deployment-outcome" }, `Recorded status: ${state.status.status}`),
      deploymentFailure(
        state.status.error,
        { credentials: credentialsHref, configuration: configurationHref },
        logsHref ? { href: logsHref, revision: revision.revision } : null,
      ),
      state.status.warnings?.length
        ? element(
            "div",
            { className: "deployment-warnings" },
            element("h3", {}, "Startup warnings"),
            element(
              "ul",
              {},
              ...state.status.warnings.map((warning) =>
                element("li", {}, pluginWarningText(warning)),
              ),
            ),
          )
        : null,
    );
  }

  function render() {
    section.replaceChildren(
      element(
        "div",
        { className: "deployment-heading" },
        element(
          "div",
          {},
          element("h2", {}, "Deployment activity"),
          element(
            "p",
            { className: "muted" },
            `Most recent visible deployment · v${revision.revision}`,
          ),
        ),
        button(
          state.loading ? "Refreshing..." : "Refresh deployment",
          () => void loadStatus(true),
          {
            disabled: state.loading,
          },
        ),
      ),
      element(
        "p",
        { className: "muted" },
        "Progress comes from the persisted deployment record. It does not check live serving or model access.",
      ),
      renderStatus(),
      ...(state.overviewError
        ? [
            element(
              "p",
              { className: "error", role: "alert" },
              "Current version and version history could not be refreshed. Use the page Refresh control to retry.",
            ),
          ]
        : []),
    );
  }

  render();
  void loadStatus();
  return section;
}

function createVersionDeploymentRecord(context, path, revisionId, onChange = () => {}) {
  const section = element("section", { className: "agent-card version-deployment-record" });
  let status = null;
  let error = null;
  let loading = false;
  // Bumped whenever a newer record arrives from elsewhere so a slower read cannot overwrite it.
  let generation = 0;

  async function load() {
    if (loading || !context.isCurrent()) {
      return;
    }
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
    generation += 1;
    status = next;
    error = null;
    render();
    onChange(status);
  }

  function render() {
    section.replaceChildren(
      element(
        "div",
        { className: "deployment-heading" },
        element("h3", {}, "This version’s deployment record"),
        button(loading ? "Refreshing..." : "Refresh record", () => void load(), {
          disabled: loading,
        }),
      ),
      error
        ? element("p", { className: "error", role: "alert" }, message(error))
        : status
          ? element(
              "div",
              {},
              element("p", {}, `Recorded outcome: ${status.status}`),
              deploymentFailure(status.error),
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
    );
  }

  render();
  void load();
  return { section, show, current: () => status };
}

function createVersionDiagnosticsPanel(context, path, revisionId, recordedStatus = () => null) {
  const section = element("section", { className: "agent-card version-diagnostics" });
  let diagnostics = null;
  let error = null;
  let loading = false;

  async function run() {
    if (loading || !context.isCurrent()) {
      return;
    }
    loading = true;
    error = null;
    diagnostics = null;
    render();
    try {
      diagnostics = await context.request(
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
      error = cause;
    } finally {
      if (context.isCurrent()) {
        loading = false;
        render();
      }
    }
  }

  function renderChecks() {
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
      element("p", { className: "muted" }, `Observed ${displayDate(diagnostics.observedAt)}`),
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
    const failure = recorded?.status === "failed" ? recorded.error : null;
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

  function render() {
    section.replaceChildren(
      element(
        "div",
        { className: "deployment-heading" },
        element("h3", {}, "Current observations"),
        button(
          loading ? "Running diagnostics..." : "Run diagnostics for this version",
          () => void run(),
          {
            disabled: loading,
          },
        ),
      ),
      element(
        "p",
        { className: "muted" },
        "Checks run on demand against this exact version. Results are timestamped and do not change its recorded deployment outcome.",
      ),
      element(
        "p",
        { className: "muted" },
        "For Kubernetes Compute, Gateway checks cover only the Slack channel: its configuration, authentication, and connectivity. They do not test model credentials or run a model turn. Pod status, restarts, Events and container output are on this version's Logs tab.",
      ),
      ...(error
        ? [
            element(
              "p",
              { className: "error", role: "alert" },
              error.status === 403
                ? "Diagnostics require Agent read and operate access plus read access to this version. Ask a Namespace administrator to confirm those grants."
                : error.status === 503
                  ? "Current-runtime diagnostics are unavailable. This Compute Driver may not support them, or the runtime may be unreachable. Check the runtime and try again."
                  : message(error),
            ),
          ]
        : []),
      renderChecks(),
    );
  }

  render();
  return { section, render };
}

export async function renderAgentDetail(context, { agent: preloadedAgent = null } = {}) {
  const { view, namespaceId, agentId, request, url } = context;
  const path = `${namespacePath(namespaceId)}/agents/${encodeURIComponent(agentId)}`;
  const agent = preloadedAgent ?? (await request(path));
  if (!context.isCurrent()) {
    return;
  }
  context.setTitle(agent.name);
  let deleting = agent.status === "deleting";
  let currentRevisionId = agent.activeRevisionId;
  let currentRuntimeState = agent.desiredRuntimeState;
  let visibleRevisions = [];
  // True once the readable version list loaded; until then nothing counts as hidden.
  let visibleRevisionsLoaded = false;
  const selected = url.searchParams.get("revision") ?? agent.activeRevisionId ?? "draft";
  const tab = url.searchParams.get("tab");
  const tabsForSelection = [
    "configuration",
    "plugins",
    "channels",
    ...(selected === "draft" ? ["repositories", "credentials"] : []),
    "workspace",
    ...(selected === "draft" ? [] : ["logs"]),
  ];
  let selectedTab = tabsForSelection.includes(tab) ? tab : "configuration";
  let deployInFlight = false;
  let authenticationSaveState = "idle";
  let activeCredentials = null;
  const target = (revision = selected, tab = selectedTab) =>
    `agents/${agentId}?revision=${encodeURIComponent(revision)}&tab=${tab}`;
  const change = (revision, tab) => {
    if (draftEditorBlocksNavigation()) {
      showDraftEditorNavigationBlock();
      return;
    }
    context.navigate(target(revision, tab));
  };
  const headerActions = element(
    "div",
    { className: "agent-toolbar-actions" },
    selected !== "draft"
      ? button("Create new version", () => change("draft", "configuration"), {
          className: "primary",
        })
      : null,
  );
  const header = element(
    "div",
    { className: "agent-toolbar" },
    link("← Agents", "agents", context),
    headerActions,
  );
  const currentVersionValue = element("strong");
  const currentVersionNote = element("p", { className: "muted" });
  const latestDeploymentValue = element("strong", {}, "Loading…");
  const latestDeploymentNote = element("p", { className: "muted" }, "Reading deployment history.");
  const liveServingValue = element("strong", {}, "Not verified");
  const liveServingNote = element("p", { className: "muted" });
  const currentSummary = element(
    "section",
    { className: "agent-current-summary", "aria-label": "Agent state at a glance" },
    element(
      "div",
      {},
      element("span", { className: "eyebrow" }, "Current version"),
      currentVersionValue,
      currentVersionNote,
    ),
    element(
      "div",
      {},
      element("span", { className: "eyebrow" }, "Latest visible deployment"),
      latestDeploymentValue,
      latestDeploymentNote,
    ),
    element(
      "div",
      {},
      element("span", { className: "eyebrow" }, "Live serving"),
      liveServingValue,
      liveServingNote,
    ),
  );
  const statusLine = element("p", { className: "agent-status-line", hidden: true });
  // Revision read is granted per version, so someone who may deploy can still be
  // unable to read the version that is now current, or the one they just requested.
  function revisionHidden(revisionId) {
    return (
      visibleRevisionsLoaded &&
      Boolean(revisionId) &&
      revisionId !== "draft" &&
      !visibleRevisions.some((revision) => revision.id === revisionId)
    );
  }
  const readAccessHint =
    "Ask an Agent administrator for read access to new versions, or check the Agent's chat or native admin UI.";
  function renderCurrentVersion() {
    const current = visibleRevisions.find((revision) => revision.id === currentRevisionId);
    const version = current
      ? `v${current.revision}`
      : currentRevisionId
        ? shortId(currentRevisionId)
        : "None";
    currentVersionValue.textContent = version;
    currentVersionNote.textContent = !currentRevisionId
      ? "No version is currently selected for service."
      : revisionHidden(currentRevisionId)
        ? "Selected for service · you cannot read this version"
        : "Selected for service · live serving unverified";
  }
  renderCurrentVersion();
  const identity = element("p", { className: "resource-id" }, agent.id);
  const stopPanel = createAgentStop(context, path, agent, showDeleting, () =>
    context.navigate(target(selected, selectedTab), namespaceId, true),
  );
  const deletion = createAgentDeletion(context, path, agent, showDeleting);
  function showDeleting() {
    deleting = true;
    headerActions.replaceChildren(element("span", { className: "badge" }, "Deleting"));
    view.replaceChildren(header, identity, deletion);
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
  const versionLayout = element("div", { className: "agent-version-layout" }, selector, detailPane);
  const deploymentStatus = element("section", { className: "agent-card deployment-status" });
  deploymentStatus.append(
    element("h2", {}, "Deployment activity"),
    element("p", { className: "muted" }, "Loading the most recent visible deployment…"),
  );
  const tabControls = new Map();
  const revisionControls = new Map();
  let draftEditorNavigationBlock = null;
  let showDraftEditorNavigationBlock = () => {};
  function draftEditorBlocksNavigation() {
    return (
      selected === "draft" &&
      (deployInFlight ||
        authenticationSaveState === "saving" ||
        activeCredentials?.isSaving() ||
        (["configuration", "plugins", "repositories", "channels"].includes(selectedTab) &&
          draftEditorNavigationBlock))
    );
  }
  function trackRevisionControl(control) {
    revisionControls.set(control, control.disabled);
  }
  function updateNavigationControls() {
    const blocked = Boolean(draftEditorBlocksNavigation());
    for (const [id, control] of tabControls) {
      control.disabled = blocked && id !== selectedTab;
    }
    for (const [control, originallyDisabled] of revisionControls) {
      control.disabled = blocked || originallyDisabled;
    }
  }
  const tabs = element("nav", {
    className: "agent-tabs",
    "aria-label": "Agent configuration views",
  });
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
    ...(selected === "draft" ? [] : [["logs", "Logs"]]),
  ]) {
    const control = button(
      label,
      () => {
        if (id === selectedTab) {
          return;
        }
        if (draftEditorBlocksNavigation()) {
          showDraftEditorNavigationBlock();
          return;
        }
        change(selected, id);
      },
      {
        ...(id === selectedTab ? { "aria-current": "page" } : {}),
      },
    );
    tabControls.set(id, control);
    tabs.append(control);
  }
  detailPane.append(detailHeading, versionEvidence, tabs, content);
  const runtimeAccess = renderRuntimeAccess(context, path);
  view.replaceChildren(
    header,
    identity,
    currentSummary,
    statusLine,
    deploymentStatus,
    runtimeAccess.section,
    // Sharing policy reads need Installation administration and a denial is audited, so
    // skip the panel when the session probe already showed that access is missing.
    ...(context.installationAdmin === false ? [] : [renderAgentAccess(context, agent)]),
    versionLayout,
  );
  let details;
  const retainedTabs = new Map();
  let mountedTab = null;
  let activityPanel = deploymentStatus;
  let activityRevisionId;
  let viewedSnapshot = null;
  let detailLoadFinished = false;
  let latestRevisionResult = null;
  let latestDeploymentStatus = null;
  let latestDeploymentError = false;
  let latestDeploymentErrorCode = null;
  let latestDeploymentRecord = null;
  let versionRecord = null;
  const revisionsPromise = request(`${path}/revisions`);

  function versionNotice() {
    return selected === "draft"
      ? selectedTab === "plugins"
        ? "Plugin changes to this Agent appear in the next deployment. Existing versions stay unchanged."
        : "New version. Changes affect future deployments using this Configuration. Admitted versions stay unchanged."
      : selected === currentRevisionId
        ? "Current version · read-only admitted snapshot. Selection does not confirm that this version is serving."
        : "Historical version · read-only admitted snapshot. Browsing it does not change the current version.";
  }

  function renderDetailHeading() {
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
        {},
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

  function renderVersions(revisions, snapshot, historyError = null) {
    revisionControls.clear();
    const newVersion = button("Create new version", () => change("draft", "configuration"), {
      className: "revision-create",
      ...(selected === "draft" ? { "aria-current": "page" } : {}),
    });
    trackRevisionControl(newVersion);
    const list = element("div", { className: "version-list" });
    for (const revision of revisions) {
      const control = button("", () => change(revision.id, "configuration"), {
        className: "version-item",
        "aria-label": `View version v${revision.revision}${revision.id === currentRevisionId ? ", current version" : ""}`,
        ...(selected === revision.id ? { "aria-current": "page" } : {}),
      });
      control.append(
        element("strong", {}, `v${revision.revision}`),
        element("small", {}, displayDate(revision.createdAt)),
      );
      if (revision.id === currentRevisionId) {
        control.append(element("span", { className: "version-current" }, "Current version"));
      }
      if (revision.configurationReadError) {
        control.append(element("small", {}, "Saved configuration unreadable"));
      }
      trackRevisionControl(control);
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
        trackRevisionControl(control);
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
    chooser.addEventListener("change", () => {
      const nextRevision = chooser.value;
      if (draftEditorBlocksNavigation()) {
        chooser.value = selected;
        showDraftEditorNavigationBlock();
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
        revisions.length || selected !== "draft"
          ? element("label", { for: "revision-selector" }, "Available versions")
          : null,
        revisions.length || selected !== "draft" ? chooser : null,
        historyError
          ? element(
              "p",
              { className: "error", role: "alert" },
              `Version history unavailable. ${message(historyError)}`,
            )
          : null,
        !historyError && !revisions.length
          ? element(
              "p",
              { className: "muted" },
              "No readable versions. Creating an Agent alone does not create a version.",
            )
          : null,
      ].filter(Boolean),
    );
    updateNavigationControls();
  }

  function updateCurrentAgent(freshAgent, revisions, snapshot) {
    if (freshAgent.status === "deleting") {
      showDeleting();
      return;
    }
    const servingChanged =
      freshAgent.activeRevisionId !== currentRevisionId ||
      freshAgent.desiredRuntimeState !== currentRuntimeState;
    currentRevisionId = freshAgent.activeRevisionId;
    currentRuntimeState = freshAgent.desiredRuntimeState;
    stopPanel.updateAgent(freshAgent);
    if (servingChanged) {
      // OpenClaw access depends on the serving version, so a finished deployment rereads it.
      runtimeAccess.refresh();
    }
    renderOverview({ status: "fulfilled", value: revisions }, snapshot);
    renderDetailHeading();
    const notice = content.querySelector(".version-selection-notice");
    if (notice) {
      notice.textContent = versionNotice();
    }
  }

  function renderLatestDeployment() {
    const latest = visibleRevisions[0];
    if (!latest) {
      latestDeploymentValue.textContent =
        latestRevisionResult?.status === "rejected"
          ? "Unavailable"
          : latestRevisionResult
            ? "None"
            : "Loading…";
      latestDeploymentNote.textContent =
        latestRevisionResult?.status === "rejected"
          ? "Version history could not be read."
          : latestRevisionResult
            ? "No readable deployments."
            : "Reading deployment history.";
      const hidden = [selected, currentRevisionId].find(revisionHidden);
      statusLine.hidden = hidden === undefined;
      statusLine.textContent = hidden
        ? `You cannot read version ${shortId(hidden)}, so its progress and outcome are not shown here. ${readAccessHint}`
        : "";
      liveServingValue.textContent = "Not verified";
      liveServingNote.textContent = "Serving version and model access are unknown.";
      return;
    }
    const label = {
      queued: "Queued",
      running: "In progress",
      succeeded: "Succeeded",
      failed: "Failed",
    }[latestDeploymentStatus];
    latestDeploymentValue.textContent = `v${latest.revision} · ${label ?? (latestDeploymentError ? "Unavailable" : "Loading…")}`;
    latestDeploymentNote.textContent = latestDeploymentStatus
      ? `Recorded status: ${latestDeploymentStatus}`
      : latestDeploymentError
        ? "Recorded deployment status could not be read."
        : "Reading recorded deployment status.";
    const current = visibleRevisions.find((revision) => revision.id === currentRevisionId);
    const currentLabel = current ? `v${current.revision}` : shortId(currentRevisionId ?? "");
    // A succeeded deployment becomes current, so a different current version is newer.
    const newerHidden =
      latestDeploymentStatus === "succeeded" &&
      currentRevisionId !== latest.id &&
      revisionHidden(currentRevisionId);
    const requestedHidden = selected !== currentRevisionId && revisionHidden(selected);
    // Deploying a dedicated Agent stops the previous version's workload before the new
    // one starts, so a failed newer deployment usually leaves nothing serving.
    const replacementFailed =
      latestDeploymentStatus === "failed" &&
      current !== undefined &&
      current.revision < latest.revision &&
      latest.harness?.mode === "dedicated";
    // Embedded activation selects the new version before its gateway is ready, and that
    // gateway replaces the previous one, so a failed selected version is the only one left.
    const selectedFailed =
      latestDeploymentStatus === "failed" && current !== undefined && current.id === latest.id;
    if (newerHidden) {
      latestDeploymentValue.textContent = "Newer version hidden";
      latestDeploymentNote.textContent = `You cannot read the current version. v${latest.revision} (${latestDeploymentStatus}) is older.`;
    }
    if (replacementFailed) {
      liveServingValue.textContent = "Probably down";
      liveServingNote.textContent = `v${latest.revision} failed; ${currentLabel} was probably stopped for it.`;
    } else if (selectedFailed) {
      liveServingValue.textContent = "Probably down";
      liveServingNote.textContent = `${currentLabel} is selected and its deployment failed.`;
    } else {
      liveServingValue.textContent = "Not verified";
      liveServingNote.textContent = "Serving version and model access are unknown.";
    }
    statusLine.hidden = !latestDeploymentStatus && !requestedHidden;
    if (requestedHidden || newerHidden) {
      statusLine.textContent = [
        requestedHidden
          ? `Version ${shortId(selected)} was requested, but you cannot read it, so its progress and outcome are not shown here.`
          : null,
        newerHidden
          ? `The current version, ${shortId(currentRevisionId)}, is one you cannot read; v${latest.revision} is an older version.`
          : null,
        readAccessHint,
      ]
        .filter(Boolean)
        .join(" ");
    } else if (replacementFailed) {
      statusLine.textContent = `v${latest.revision} deployment failed. ${currentLabel} is still recorded as current, but deploying a dedicated Agent stops the previous version first, so this Agent is probably not serving: chat and the native admin UI fail until a new version deploys. Fix the failure, then deploy a new version.`;
    } else if (selectedFailed) {
      statusLine.textContent = `${currentLabel} deployment failed. ${currentLabel} is still selected because its runtime already replaced the previous version, so this Agent is probably not serving: chat and the native admin UI fail until a new version deploys. Fix the failure, then deploy a new version.`;
    } else if (latestDeploymentStatus) {
      const selection = currentRevisionId
        ? `${currentLabel} is selected.`
        : "No version is selected.";
      statusLine.textContent = `v${latest.revision} deployment is recorded as ${latestDeploymentStatus}. ${selection} Live serving is unverified.`;
    }
  }

  function renderOverview(revisionResult, snapshot) {
    latestRevisionResult = revisionResult;
    const revisions =
      revisionResult.status === "fulfilled"
        ? [...revisionResult.value].sort((a, b) => b.revision - a.revision)
        : [];
    visibleRevisions = revisions;
    visibleRevisionsLoaded = revisionResult.status === "fulfilled";
    renderCurrentVersion();
    renderVersions(
      revisions,
      snapshot,
      revisionResult.status === "rejected" ? revisionResult.reason : null,
    );
    const mostRecent = revisions[0];
    if (activityRevisionId !== (mostRecent?.id ?? null)) {
      latestDeploymentStatus = null;
      latestDeploymentRecord = null;
      latestDeploymentError = false;
      latestDeploymentErrorCode = null;
      const nextPanel = mostRecent
        ? createDeploymentStatusPanel(
            context,
            path,
            mostRecent,
            (freshAgent, freshRevisions) =>
              updateCurrentAgent(freshAgent, freshRevisions, snapshot),
            (status, unavailable, errorCode, record) => {
              if (activityRevisionId !== mostRecent.id) {
                return;
              }
              latestDeploymentStatus = status;
              latestDeploymentError = unavailable;
              latestDeploymentErrorCode = errorCode;
              latestDeploymentRecord = record
                ? { revisionId: mostRecent.id, status: record }
                : null;
              if (record && mostRecent.id === selected) {
                versionRecord?.show(record);
              }
              renderLatestDeployment();
              refreshDeployControls();
            },
            agent.harnessAuth?.method === "runtime"
              ? null
              : context.pageUrl(`agents/${agent.id}?revision=draft&tab=credentials`, namespaceId),
            context.pageUrl(
              `agents/${agent.id}?revision=${encodeURIComponent(mostRecent.id)}&tab=logs`,
              namespaceId,
            ),
            context.pageUrl(`agents/${agent.id}?revision=draft&tab=configuration`, namespaceId),
          )
        : element(
            "section",
            { className: "agent-card deployment-status" },
            element("h2", {}, "Deployment activity"),
            element(
              "p",
              { className: "muted" },
              revisionResult.status === "rejected"
                ? "Version history is unavailable."
                : "No readable deployment records.",
            ),
          );
      activityPanel.replaceWith(nextPanel);
      activityPanel = nextPanel;
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
      versionRecord = createVersionDeploymentRecord(context, path, selected, () =>
        diagnosticsPanel?.render(),
      );
      diagnosticsPanel = createVersionDiagnosticsPanel(context, path, selected, () =>
        versionRecord.current(),
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
    const credentials =
      draft && !runtimeAuth
        ? createChannelSecretsPanel({
            context,
            path,
            agent,
            configuration: snapshot,
            values,
            revisionsLoaded: revisionResult.status === "fulfilled",
            onChange() {
              updateNavigationControls();
              updateDeployControls();
            },
            onConfigurationChange(configuration) {
              snapshot = configuration;
              values = configuration.values;
              viewedSnapshot = configuration;
              renderDetailHeading();
            },
            onReload: () => context.navigate(target("draft", "credentials"), namespaceId, true),
          })
        : null;
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
        if (deployReloadMessage) {
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
          deployStatus.textContent =
            "Configured on the runtime host; not validated by OCC. Gateway readiness does not confirm model access.";
        } else {
          const gate = credentials.deployGateMessage();
          // Secret values can be updated in place, so a rejected credential warns instead of blocking.
          deployStatus.textContent =
            latestDeploymentErrorCode === "RUNTIME_AUTHENTICATION_FAILED" &&
            JSON.stringify(visibleRevisions[0]?.harnessAuth) === JSON.stringify(agent.harnessAuth)
              ? `${gate} The last deployment's model credential was rejected; update or replace it in Credentials before deploying again.`
              : gate;
        }
      }
    }
    refreshDeployControls = updateDeployControls;
    deployStatus = element("p", { className: "muted", role: "status" });
    deployFeedback = element("p", { className: "error", role: "alert" });
    deploy = button(
      "Deploy new version",
      async () => {
        deployFeedback.textContent = "";
        deploy.disabled = true;
        deployPending = true;
        deployInFlight = true;
        content.toggleAttribute("inert", true);
        updateNavigationControls();
        deployStatus.textContent = "Checking Configuration…";
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
          deployStatus.textContent = "Requesting deployment…";
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
          deployFeedback.textContent =
            error.status === 403
              ? "Deployment denied. Check Agent deploy permission and access to selected Secrets. First deployment also needs Agent read and operate permissions to create connection credentials. Ask a Namespace administrator to confirm the required grants."
              : error.status === 409
                ? "Deployment conflicts with the saved Agent state. Refresh this Agent to check for changed Configuration or missing connection credentials. If credentials are missing after an earlier version, ask an operator to restore them."
                : rejectionMessage(error, submitted);
          if (!submitted || [400, 403, 404, 409, 429].includes(error.status)) {
            deployPending = false;
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
          }
        }
      },
      { className: "primary" },
    );
    updateDeployControls();
    const draftActions = element(
      "section",
      { className: "agent-card agent-draft-actions" },
      element("h3", {}, "Prepare this version"),
      element(
        "ol",
        { className: "draft-steps" },
        element("li", {}, "Edit and save Configuration, plugins, or Channels"),
        element("li", {}, "Check authentication and credentials"),
        element("li", {}, "Deploy the saved draft"),
      ),
      element(
        "p",
        { className: "muted" },
        "Deployment creates an immutable version from the saved Configuration and plugin selections. Connection credentials are generated automatically on first deployment when needed. A successful request means work was admitted; readiness is tracked above.",
      ),
      draft ? element("div", { className: "form-actions" }, deploy, setupCredentials) : deploy,
      deployStatus,
      deployFeedback,
    );
    detailPane.insertBefore(draftActions, tabs);
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

  async function renderTab() {
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
        retainedTabs.set(mountedTab.id, mountedTab);
      }
      mountedTab = null;
    }
    renderDetailHeading();
    versionEvidence.hidden = selectedTab === "workspace" || selectedTab === "logs";
    const tab = selectedTab;
    for (const [index, id] of tabsForSelection.entries()) {
      const control = tabs.children[index];
      if (id === tab) {
        control.setAttribute("aria-current", "page");
      } else {
        control.removeAttribute("aria-current");
      }
    }
    refreshDeployControls();
    const retained = retainedTabs.get(tab);
    retainedTabs.delete(tab);
    if (retained && retained.mutations === context.mutationVersion()) {
      mountedTab = retained;
      content.replaceChildren(...retained.nodes);
      retained.resumeDrafts();
      return;
    }
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
      content.append(renderWorkspaceFiles(tabContext, agent, path));
      state.loading = false;
      content.style.minHeight = "";
      return;
    }
    if (tab === "logs") {
      // The version heading still comes from the snapshot read.
      details ??= loadDetails();
      // Polling views are rebuilt on every visit instead of being retained.
      state.reusable = false;
      content.append(renderAgentLogs(tabContext, { agent, revisionId: selected }));
      state.loading = false;
      content.style.minHeight = "";
      return;
    }
    content.append(element("p", { role: "status" }, "Loading configuration…"));
    const data = await (details ??= loadDetails());
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
    const { snapshot, values, draft, executionMode, credentials } = data;
    content.append(
      element(
        "p",
        { className: "notice version-selection-notice", role: "status" },
        versionNotice(),
      ),
    );
    if (selectedTab === "repositories" && draft) {
      content.append(renderRepositoryEditor(context, data));
    } else if (selectedTab === "plugins") {
      content.append(
        renderAgentPlugins(context, {
          agent,
          snapshot,
          draft,
          path,
          onState: data.setPluginEditorState,
          onSaved: () => change("draft", "plugins"),
          onReload: () => {
            context.drafts.forget("plugins");
            context.navigate(target("draft", "plugins"), namespaceId, true);
          },
        }),
      );
    } else if (selectedTab === "channels") {
      const channels = renderChannels({
        values,
        executionMode,
        readOnly: !draft,
        drawerContext: {
          drafts: context.drafts,
          baseline: JSON.stringify([snapshot.id, snapshot.generation]),
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
              throw new Error(
                "The saved Configuration changed while you were editing. Close this editor and refresh before saving.",
              );
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
                },
              },
            );
            configurationSaved = true;
            details = null;
            try {
              if (options.changedSecrets !== undefined) {
                for (const secret of options.changedSecrets) {
                  await ensureSecretOperateBinding(context, freshAgent, secret);
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
              change("draft", "channels");
            }
          } catch (error) {
            if (!context.isCurrent()) {
              throw error;
            }
            if (error.status === 401) {
              context.onExpired();
              throw new Error("Your session has expired.");
            }
            if (
              error.status !== undefined ||
              error.name === "TimeoutError" ||
              error.name === "TypeError"
            ) {
              if (!configurationSaved) {
                error.message = rejectionMessage(error, mutationStarted);
              }
            }
            error.outcomeUnknown =
              error.outcomeUnknown ??
              (mutationStarted && ![400, 403, 404, 409, 429].includes(error.status));
            throw error;
          }
        },
        onStateChange: ({ pending, outcomeUnknown }) => {
          if (context.isCurrent()) {
            data.setDraftEditorState({ dirty: false, saving: pending, outcomeUnknown });
          }
        },
        onReload: () => {
          context.drafts.forget("channels");
          context.navigate(target("draft", "channels"), namespaceId, true);
        },
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
      const feedback = element("p", { role: "status", className: "hint" });
      const save = element(
        "button",
        { type: "submit", className: "primary" },
        "Save authentication source",
      );
      const reload = button("Reload authentication source", () => {
        context.drafts.forget("authentication");
        data.setAuthenticationSaveState("idle");
        data.setAuthenticationPending(false);
        context.navigate(target("draft", "credentials"), namespaceId, true);
      });
      const form = element(
        "form",
        { className: "agent-card" },
        auth.section,
        save,
        reload,
        feedback,
      );
      data.setAuthenticationForm(form);
      let outcomeUnknown = retained?.outcomeUnknown ?? false;
      let pending = false;
      let savedAuthentication = retained?.savedAuthentication ?? null;
      const originalFields = retained?.originalFields ?? auth.capture();
      const bindingFields = ({ method, secretSource, account }) =>
        JSON.stringify({ method, secretSource, account });
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
        feedback.textContent =
          "Authentication source saved. Retry credential access to confirm this Agent can use the selected Secret.";
      }
      if (outcomeUnknown) {
        save.disabled = true;
        auth.setDisabled(true);
        feedback.textContent = "Outcome unknown. Reload authentication source before saving again.";
      }
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!form.reportValidity() || save.disabled) {
          return;
        }
        let harnessAuth;
        try {
          harnessAuth = savedAuthentication?.harnessAuth ?? (await auth.readBinding());
        } catch (error) {
          // Incomplete fields (no Secret, unfinished ChatGPT sign-in) say what to do next.
          feedback.textContent = error.message;
          return;
        }
        save.disabled = true;
        pending = true;
        reload.disabled = true;
        auth.setDisabled(true);
        data.setAuthenticationSaveState("saving");
        data.setAuthenticationPending(true);
        feedback.textContent = savedAuthentication
          ? "Checking Secret access…"
          : "Saving authentication…";
        let mutationStarted = false;
        try {
          const current = await request(path);
          if (!context.isCurrent()) {
            return;
          }
          assertReadableConfiguration(current);
          const expected = savedAuthentication ?? baseline;
          if (
            current.configurationId !== expected.configurationId ||
            JSON.stringify(current.harnessAuth) !== JSON.stringify(expected.harnessAuth)
          ) {
            feedback.textContent =
              "The Configuration changed. Reload authentication source before saving.";
            outcomeUnknown = true;
            return;
          }
          if (!savedAuthentication) {
            mutationStarted = true;
            savedAuthentication = await request(path, {
              method: "PATCH",
              body: { configurationId: agent.configurationId, harnessAuth },
            });
            details = null;
          }
          if (harnessAuth?.source?.kind === "secret") {
            feedback.textContent = "Authentication saved. Checking Secret access…";
            await ensureSecretOperateBinding(context, current, harnessAuth.source);
          }
          data.setAuthenticationPending(false);
          if (context.isCurrent()) {
            data.setAuthenticationSaveState("idle");
            context.drafts.forget("authentication");
            change("draft", "credentials");
          }
        } catch (error) {
          if (!context.isCurrent()) {
            return;
          }
          if (error.status === 401) {
            context.onExpired();
          } else if (savedAuthentication) {
            feedback.textContent = `Authentication source saved, but this Agent's Secret access could not be confirmed. ${message(error)} Ask a Namespace administrator to grant this Agent secret:operate on the selected Secret, then retry credential access. Deployment readiness is not confirmed.`;
          } else {
            outcomeUnknown =
              error.outcomeUnknown ??
              (mutationStarted && ![400, 403, 404, 409, 429].includes(error.status));
            feedback.textContent = error.outcomeUnknown
              ? error.message
              : rejectionMessage(error, mutationStarted);
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
            save.disabled = outcomeUnknown;
            auth.setDisabled(outcomeUnknown || savedAuthentication !== null);
            syncUnsavedAuthentication();
          }
        }
      });
      content.append(form);
      if (credentials?.section) {
        content.append(credentials.section);
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
                  button("Edit current Configuration", () => change("draft", "configuration")),
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
    const feedback = element("p", { className: "hint", role: "status" });
    const reload = button("Reload draft", () =>
      context.navigate(target("draft", "repositories"), namespaceId, true),
    );
    const save = button("Save repository access", () => void submit(), {
      className: "primary",
      disabled: true,
    });
    const cancel = button("Cancel", () => {
      data.setDraftEditorState({
        dirty: false,
        saving: false,
        outcomeUnknown: false,
        reloadRequired: false,
      });
      context.navigate(target("draft", "repositories"), namespaceId, true);
    });
    function update() {
      const dirty = fields?.isDirty() ?? false;
      const pending = saveState === "saving";
      const outcomeUnknown = saveState === "uncertain";
      const reloadRequired = saveState === "conflict";
      const locked = saveState !== "idle";
      data.setDraftEditorState({ dirty, saving: pending, outcomeUnknown, reloadRequired });
      save.disabled = locked || !dirty || !fields?.isSettled() || fields.blocksCreate();
      cancel.disabled = locked;
      reload.hidden = !outcomeUnknown && !reloadRequired;
      fields?.setDisabled(locked);
    }
    fields = createRepositoryFields(
      context,
      (changed) => {
        if (changed) {
          feedback.textContent = fields.isDirty()
            ? "Save or cancel repository changes before deploying."
            : "No repository changes to save.";
        }
        update();
      },
      { ...agent, agentId: agent.id },
    );
    showDraftEditorNavigationBlock = () => {
      feedback.textContent = "Save or cancel repository changes before leaving this tab.";
    };
    async function submit() {
      if (save.disabled || !fields.validate()) {
        return;
      }
      saveState = "saving";
      update();
      let mutationStarted = false;
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
          feedback.textContent =
            "Repository access changed while you were editing. Reload this draft before saving.";
          return;
        }
        // TODO: enforce an expected Agent version in PATCH when draft concurrency
        // is implemented; this preflight cannot prevent a write between requests.
        mutationStarted = true;
        await request(path, {
          method: "PATCH",
          body: {
            configurationId: agent.configurationId,
            repositoryAccess: fields.access(),
          },
        });
        fields.recordSuccessfulSave();
        if (context.isCurrent()) {
          data.setDraftEditorState({ dirty: false, saving: false });
          context.navigate(target("draft", "repositories"), namespaceId, true);
        }
      } catch (error) {
        if (!context.isCurrent()) {
          return;
        }
        if (error.status === 401) {
          context.onExpired();
        } else {
          feedback.textContent = rejectionMessage(error, mutationStarted);
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
    return element(
      "section",
      { className: "agent-card" },
      fields.section,
      element("div", { className: "form-actions" }, save, cancel, reload),
      feedback,
    );
  }

  function renderDraftConfigurationEditor(context, data) {
    const { snapshot, values, setDraftEditorState } = data;
    const container = element("div", { className: "configuration-draft-editor" });
    const retained = context.drafts.get("configuration");
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
    const feedback = element("p", { className: "hint", role: "status" });
    let feedbackLocked = false;
    const edit = button("Edit Configuration", () => {
      editing = true;
      render();
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
    const enableGatewayPassword = button("Enable Gateway password access", () => {
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
      editing = true;
      render();
    });
    const save = button("Save Configuration", () => void saveConfiguration(), {
      className: "primary",
    });
    const cancel = button("Cancel", () => {
      baseline = { id: snapshot.id, generation: snapshot.generation };
      initialText = JSON.stringify(values, null, 2);
      editing = false;
      editor.value = initialText;
      editor.setCustomValidity("");
      feedback.textContent = "";
      reloadRequired = false;
      setDraftEditorState({
        dirty: false,
        saving: false,
        outcomeUnknown: false,
        reloadRequired: false,
      });
      render();
    });
    const reload = button("Reload draft", () => {
      context.drafts.forget("configuration");
      context.navigate(target("draft", "configuration"), namespaceId, true);
    });

    function currentDirty() {
      return editor.value !== initialText;
    }

    function parseEditor(reportInvalid = false) {
      try {
        const parsed = JSON.parse(editor.value);
        if (!isPlainObject(parsed)) {
          throw new Error();
        }
        return parsed;
      } catch {
        if (reportInvalid) {
          editor.setCustomValidity("Enter a valid JSON object.");
          editor.reportValidity();
          feedback.textContent = "Enter a valid Configuration JSON object.";
          feedbackLocked = true;
        }
        return undefined;
      }
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
      cancel.disabled = pending || outcomeUnknown || reloadRequired;
      edit.disabled = pending || outcomeUnknown;
      enableGatewayPassword.disabled = pending || outcomeUnknown || reloadRequired;
      editor.readOnly = pending || outcomeUnknown || reloadRequired;
      if (outcomeUnknown) {
        feedback.textContent =
          "Outcome unknown. Configuration may have been saved. Reload this draft before saving again.";
        feedbackLocked = true;
      } else if (reloadRequired) {
        if (!feedbackLocked) {
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
      editor.setCustomValidity("");
      feedback.textContent = "";
      feedbackLocked = false;
      reloadRequired = false;
      updateState();
    });
    showDraftEditorNavigationBlock = () => {
      if (draftEditorNavigationBlock) {
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
      feedback.textContent = "Checking Configuration…";
      feedbackLocked = true;
      updateState();
      let mutationStarted = false;
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
          feedback.textContent =
            "The saved Configuration changed while you were editing. Reload this draft before saving.";
          feedbackLocked = true;
          reloadRequired = true;
          return;
        }
        mutationStarted = true;
        await request(
          `${namespacePath(namespaceId)}/configurations/${encodeURIComponent(baseline.id)}`,
          {
            method: "PATCH",
            body: { values: nextValues },
          },
        );
        if (context.isCurrent()) {
          context.drafts.forget("configuration");
          context.navigate(target("draft", "configuration"), namespaceId, true);
        }
      } catch (error) {
        if (!context.isCurrent()) {
          return;
        }
        if (error.status === 401) {
          context.onExpired();
          return;
        }
        feedback.textContent = rejectionMessage(error, mutationStarted);
        feedbackLocked = true;
        outcomeUnknown = mutationStarted && ![400, 403, 404, 409, 429].includes(error.status);
      } finally {
        if (context.isCurrent()) {
          pending = false;
          updateState();
          render();
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
              : "Use generated credentials for direct Gateway password access. Enable access, save Configuration, then deploy a new version.",
          ),
          element(
            "div",
            { className: "form-actions" },
            edit,
            usesGeneratedGatewayPassword ? null : enableGatewayPassword,
          ),
          nativeDocument(values, "View native Configuration"),
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

  view.append(stopPanel.section, deletion);
  context.setTabNavigation((next) => {
    const nextRevision = next.searchParams.get("revision") ?? agent.activeRevisionId ?? "draft";
    const nextTab = tabsForSelection.includes(next.searchParams.get("tab"))
      ? next.searchParams.get("tab")
      : "configuration";
    if (
      !context.isCurrent() ||
      deleting ||
      next.pathname !== url.pathname ||
      next.searchParams.get("namespace") !== namespaceId ||
      (nextRevision === selected && nextTab === selectedTab)
    ) {
      return false;
    }
    if (draftEditorBlocksNavigation()) {
      history.replaceState(
        history.state,
        "",
        context.pageUrl(target(selected, selectedTab), namespaceId),
      );
      showDraftEditorNavigationBlock();
      return true;
    }
    if (nextRevision !== selected) {
      return false;
    }
    selectedTab = nextTab;
    void renderTab();
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
