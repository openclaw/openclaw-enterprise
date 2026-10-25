import type {
  AgentDeploymentStatusWire,
  AgentReadWire,
  AgentRevisionListResponse,
  AgentRevisionSummaryWire,
  RuntimeFailureCause,
  RuntimeFailureEvidence,
} from "@openclaw-enterprise/contracts";
import { type RequestOptions, requestFailure } from "../api-client.mjs";
import { button, element, patchChildren, statusBlock } from "../dom.mjs";
import { createVersionDiagnostics } from "./deployment-diagnostics.mjs";
import {
  NEUTRAL_DEPLOYMENT_NOTES,
  deploymentOutcome,
  displayDate,
  message,
  neutralDeploymentOutcome,
  outcomeLabel,
} from "./list.mjs";
import { pluginWarningText } from "./plugins.mjs";

type Deployment = AgentDeploymentStatusWire;
type Outcome = ReturnType<typeof deploymentOutcome>;

export interface DeploymentContext {
  request(path: string, options?: RequestOptions & { readOnly?: true }): Promise<unknown>;
  isCurrent(): boolean;
  onExpired(): void;
  onResume?(resume: () => void): void;
}

// One page of revision summaries, newest first (finding 1323). Summaries carry no saved
// settings; read the exact revision for those.
export async function readRevisionPage(
  request: DeploymentContext["request"],
  path: string,
  cursor: string | null = null,
) {
  const page = (await request(
    cursor ? `${path}/revisions?cursor=${encodeURIComponent(cursor)}` : `${path}/revisions`,
    { includeMeta: true },
  )) as AgentRevisionListResponse;
  return { revisions: page.data, nextCursor: page.meta?.nextCursor ?? null };
}

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

function runtimeFailureCauseText(cause: RuntimeFailureCause) {
  const retried =
    typeof cause.detail === "string" &&
    cause.detail.length > RETRIED_DETAIL_SUFFIX.length &&
    cause.detail.endsWith(RETRIED_DETAIL_SUFFIX);
  const detail = retried ? cause.detail?.slice(0, -RETRIED_DETAIL_SUFFIX.length) : cause.detail;
  const retry = retried ? " The check was retried once and failed again." : "";
  if (cause.kind === "PROBE_STATUS" && (detail === "rate_limit" || detail === "billing")) {
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

function deploymentFailure(error: Deployment["error"]) {
  if (!error) {
    return element("p", { className: "muted" }, "No persisted startup failure.");
  }
  const { data } = error;
  const runtimeFailure: RuntimeFailureEvidence | undefined =
    data && "runtimeFailure" in data ? data.runtimeFailure : undefined;
  const preparation = data && "preparation" in data ? data.preparation : undefined;
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
          ...(runtimeFailure.cause
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
function deploymentResult(record: Deployment) {
  const neutral = neutralDeploymentOutcome(record);
  if (neutral === "superseded") {
    return element(
      "p",
      { className: "muted deployment-superseded" },
      `${NEUTRAL_DEPLOYMENT_NOTES.superseded} before this one became current (${record.error?.code}). This version did not fail; no action is needed.`,
    );
  }
  if (neutral === "stopped") {
    return element(
      "p",
      { className: "muted deployment-stopped" },
      `The Agent was stopped before this deployment finished (${record.error?.code}). This version did not fail; deploy a new version when you want it running.`,
    );
  }
  return deploymentFailure(record.error);
}

function deploymentProgress(record: Deployment) {
  const status = deploymentOutcome(record);
  const progress = record.progress;
  const workDescriptions = {
    queued: "Waiting for a worker claim.",
    // A started deploy stays running between its attempts (finding 2456).
    running: progress?.nextAttemptAt
      ? "Deployment work started; waiting for the next attempt."
      : "A worker claim is active.",
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

// A read failure that a later read can clear: no answer (a network error), a timeout, a rate
// limit or a server error. A refusal or a missing record is an answer, and polling stops on it.
function transientReadError(error: unknown) {
  const { status } = requestFailure(error);
  return status === undefined || status < 400 || status >= 500 || status === 408 || status === 429;
}

export function deploymentPending(status: string | null | undefined) {
  return status === "queued" || status === "running";
}

function pendingAttempt(attempt: NonNullable<Deployment["progress"]>["lastAttempt"]) {
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

interface DeploymentActivity {
  outcome: Outcome | null;
  record: Deployment | null;
  readFailed: boolean;
  transientFailure: boolean;
  overviewUnavailable: boolean;
}

export function createDeploymentStatusPanel(
  context: DeploymentContext,
  path: string,
  revision: Pick<AgentRevisionSummaryWire, "id" | "revision">,
  onAgentChange: (
    agent: AgentReadWire,
    revisions: Awaited<ReturnType<typeof readRevisionPage>>,
  ) => void,
  onStatusChange: (activity: DeploymentActivity) => void,
  // Only the first panel replaces a loading placeholder on an already visible page.
  pageShown = () => false,
) {
  const refresh = button(
    "Refresh deployment",
    () => {
      if (loading && polling) {
        // A quiet poll is reading: refresh once it lands.
        refreshQueued = true;
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
  let previousEvidence: string | undefined;
  let loading = false;
  // A quiet poll leaves Refresh alone, unless the reader presses it during the poll.
  let polling = false;
  let refreshQueued = false;
  let record: Deployment | null = null;
  let error: unknown = null;
  let overviewUnavailable = false;
  // Tallest the details have been since a deploy was seen pending; see reserveHeight().
  let reservedHeight: number | null = null;
  const heightObserver =
    typeof ResizeObserver === "function" ? new ResizeObserver(() => holdHeight()) : null;
  let pollTimer: number | undefined;
  // The last record read. A transient read failure (a network error, a timeout, a 5xx) does not
  // end a pending deploy, so polling goes on from it (finding 2085).
  let lastRecord: Deployment | null = null;

  // A poll that fired while the view was retained stopped; restoring the view re-arms it.
  context.onResume?.(() => {
    if (section.isConnected) {
      schedulePoll();
    }
  });

  // Queued and running records are reread until they record a result or a read is refused.
  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = undefined;
    const pending = error ? (transientReadError(error) ? lastRecord : null) : record;
    if (!deploymentPending(pending?.status) && !deploymentPending(pending?.cleanup?.status)) {
      return;
    }
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      // A newer deployment replaces this panel; a detached panel stops following.
      if (context.isCurrent() && section.isConnected) {
        void loadStatus(false, true);
      }
    }, DEPLOYMENT_POLL_MS);
  }

  async function loadStatus(refreshAgent = false, poll = false) {
    if (loading || !context.isCurrent()) {
      return;
    }
    clearTimeout(pollTimer);
    pollTimer = undefined;
    // After a failed read, the record before it.
    const previousStatus = lastRecord?.status ?? null;
    loading = true;
    polling = poll;
    error = null;
    overviewUnavailable = false;
    render();
    try {
      const [statusResult, agentResult, revisionsResult] = await Promise.allSettled([
        readDeployment(context, path, revision.id),
        refreshAgent ? (context.request(path) as Promise<AgentReadWire>) : null,
        refreshAgent ? readRevisionPage(context.request, path) : null,
      ]);
      if (!context.isCurrent()) {
        return;
      }
      if (
        [statusResult, agentResult, revisionsResult].some(
          (result) => result.status === "rejected" && requestFailure(result.reason).status === 401,
        )
      ) {
        context.onExpired();
        return;
      }
      if (statusResult.status === "fulfilled") {
        record = statusResult.value;
        lastRecord = statusResult.value;
      } else {
        record = null;
        error = statusResult.reason;
      }
      if (refreshAgent) {
        if (
          agentResult.status === "fulfilled" &&
          agentResult.value &&
          revisionsResult.status === "fulfilled" &&
          revisionsResult.value
        ) {
          try {
            onAgentChange(agentResult.value, revisionsResult.value);
          } catch {
            // An overview that does not identify this Agent cannot invalidate its deployment record.
            overviewUnavailable = true;
          }
        } else {
          overviewUnavailable = true;
        }
      }
    } catch (cause) {
      if (!context.isCurrent()) {
        return;
      }
      if (requestFailure(cause).status === 401) {
        context.onExpired();
        return;
      }
      error = cause;
      record = null;
    } finally {
      if (context.isCurrent()) {
        loading = false;
        render();
        onStatusChange({
          outcome: record ? deploymentOutcome(record) : null,
          record,
          readFailed: error !== null,
          transientFailure: error !== null && transientReadError(error),
          overviewUnavailable,
        });
        if (
          refreshQueued ||
          (poll &&
            deploymentPending(previousStatus) &&
            !error &&
            !deploymentPending(record?.status))
        ) {
          // A recorded result can change the current version; reread it once.
          refreshQueued = false;
          void loadStatus(true);
        } else {
          schedulePoll();
        }
      }
    }
  }

  function renderStatus() {
    if (error) {
      return statusBlock("danger", null, message(error));
    }
    if (!record) {
      return element("p", { className: "muted" }, "Deployment status has not loaded.");
    }
    return element(
      "div",
      {},
      deploymentProgress(record),
      record.cleanup
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
            }[record.cleanup.status],
          )
        : null,
      record.progress
        ? element(
            "div",
            { className: "deployment-pending-progress" },
            // The list keeps its rows before the first attempt is recorded, so that result
            // fills them in place instead of pushing the cards below down (finding 1598).
            pendingAttempt(record.progress.lastAttempt),
            record.progress.nextAttemptAt
              ? element(
                  "p",
                  { className: "muted" },
                  `Eligible for next attempt: ${displayDate(record.progress.nextAttemptAt)}. Start time depends on worker availability.`,
                )
              : null,
          )
        : null,
      element(
        "p",
        { className: "deployment-outcome" },
        `Recorded status: ${outcomeLabel(deploymentOutcome(record))}`,
      ),
      record.error ? deploymentResult(record) : null,
      record.warnings?.length
        ? statusBlock(
            "warning",
            element("h3", {}, "Startup warnings"),
            element(
              "ul",
              {},
              ...record.warnings.map((warning) => element("li", {}, pluginWarningText(warning))),
            ),
            [],
            { role: null },
          )
        : null,
    );
  }

  function render() {
    // Keep both controls mounted during reads. Fold routine completion and a first outcome
    // that arrives after the page is visible; the summary above already shows that outcome.
    const busy = String((loading && !polling) || refreshQueued);
    if (refresh.getAttribute("aria-disabled") !== busy) {
      refresh.setAttribute("aria-disabled", busy);
    }
    if (loading) {
      return;
    }
    const outcome = record ? deploymentOutcome(record) : null;
    const { cleanup, warnings } = record ?? {};
    const evidence = [outcome, cleanup?.status, warnings?.length, overviewUnavailable].join("/");
    if (evidence !== previousEvidence) {
      const late = previousEvidence === undefined && pageShown();
      details.open = Boolean(
        previousEvidence !== undefined ||
        (outcome !== "succeeded" && !late) ||
        overviewUnavailable ||
        cleanup ||
        warnings?.length,
      );
      previousEvidence = evidence;
    }
    patchChildren(content, [
      element(
        "p",
        { className: "muted" },
        `Most recent visible deployment · v${revision.revision}`,
      ),
      renderStatus(),
      ...(overviewUnavailable
        ? [
            statusBlock(
              "danger",
              null,
              "Current version and version history could not be refreshed. Use the page Refresh control to retry.",
            ),
          ]
        : []),
    ]);
    reserveHeight();
  }

  // A deploy's details grow and shrink as its attempts are recorded, and each change moved the
  // cards below, Share Agent then among them (finding 1598). While a deploy is seen pending, the
  // details keep the tallest height they have shown. Once it settles the space is given back in
  // the same render as the outcome, so a finished deploy leaves no empty card (finding 2369).
  function reserveHeight() {
    const pending = deploymentPending(record?.status) || deploymentPending(record?.cleanup?.status);
    if (pending) {
      if (reservedHeight === null) {
        reservedHeight = 0;
        heightObserver?.observe(content);
      }
      holdHeight();
    } else if (reservedHeight !== null) {
      reservedHeight = null;
      heightObserver?.disconnect();
      content.style.removeProperty("min-height");
    }
  }

  // The first load renders the panel before the page shows it, where it measures 0, so a height
  // taken only on a render lost the first Queued height and the details shrank for In progress
  // (finding 2456). The observer also measures once the panel is shown, before that frame paints.
  function holdHeight() {
    if (reservedHeight === null) {
      return;
    }
    const height = content.getBoundingClientRect().height;
    if (height > reservedHeight) {
      reservedHeight = height;
      content.style.minHeight = `${height}px`;
    }
  }

  void loadStatus();
  return section;
}

// With shared, Deployment activity is reading this version's record, so the panel waits for
// show() instead of reading it again; release() reads here if that read fails (finding 1417).
export function createVersionDeploymentEvidence(
  context: DeploymentContext,
  path: string,
  revisionId: string,
  {
    shared,
    operateAllowed,
    isCurrentVersion,
    onRecord,
  }: {
    shared: boolean;
    operateAllowed: Promise<boolean | undefined>;
    isCurrentVersion: () => boolean;
    // Each record this panel shows, read here or handed over by the page.
    onRecord: (record: Deployment) => void;
  },
) {
  const section = element("section", { className: "agent-card version-deployment-record" });
  let status: Deployment | null = null;
  let error: unknown = null;
  let loading = false;
  let awaitingShared = shared;
  // Set while the page's failed-deployment block leads with this version's failure, so the
  // record names its outcome without repeating the error text (finding 2368).
  let failureShownAbove = false;
  // A shared read that never settles must not leave this panel loading.
  const sharedTimer = shared ? setTimeout(release, DEPLOYMENT_POLL_MS) : undefined;
  const diagnostics = createVersionDiagnostics(
    context,
    path,
    revisionId,
    () => status,
    operateAllowed,
    isCurrentVersion,
  );
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
      const next = await readDeployment(context, path, revisionId);
      if (started === generation) {
        status = next;
      }
    } catch (cause) {
      if (!context.isCurrent()) {
        return;
      }
      if (requestFailure(cause).status === 401) {
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
        diagnostics.render();
        if (status) {
          onRecord(status);
        }
      }
    }
  }

  // Deployment activity already read this version's record; show it instead of a stale one.
  function show(next: Deployment) {
    if (!context.isCurrent() || !next) {
      return;
    }
    awaitingShared = false;
    clearTimeout(sharedTimer);
    generation += 1;
    status = next;
    error = null;
    render();
    diagnostics.render();
    onRecord(next);
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
              failureShownAbove && deploymentOutcome(status) === "failed"
                ? element(
                    "p",
                    { className: "muted deployment-failure-above" },
                    "The error and its next step are at the top of this page.",
                  )
                : deploymentResult(status),
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
          : // Reserve both rows so the first record does not move the version tabs below.
            element(
              "div",
              {},
              element("p", {}, "Recorded outcome: Loading…"),
              element("p", { className: "muted" }, "Reading this version’s deployment record."),
            ),
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
  function setFailureShownAbove(shown: boolean) {
    if (failureShownAbove !== shown) {
      failureShownAbove = shown;
      render();
    }
  }

  return {
    panels: [section, diagnostics.section],
    show,
    release,
    setFailureShownAbove,
    // The page calls this when its current version changes.
    renderDiagnostics: diagnostics.render,
    applyOperate: diagnostics.applyOperate,
  };
}

function readDeployment(context: DeploymentContext, path: string, revisionId: string) {
  return context.request(
    `${path}/deployments/${encodeURIComponent(revisionId)}`,
  ) as Promise<Deployment>;
}
