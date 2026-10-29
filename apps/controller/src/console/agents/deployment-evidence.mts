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
  readFailureReason,
} from "./list.mjs";
import { pluginWarningText } from "./plugins.mjs";

type Deployment = AgentDeploymentStatusWire;
type Outcome = ReturnType<typeof deploymentOutcome>;

export interface DeploymentContext {
  request(path: string, options?: RequestOptions & { readOnly?: true }): Promise<unknown>;
  isCurrent(): boolean;
  onExpired(): void;
  onResume?(resume: () => void): void;
  /**
   * The page's own words for a recorded failure, if any, in place of the API's message: the API
   * words one next step for everyone (finding D752). `settled` says the failure asks for nothing
   * more, so it is not an alert.
   */
  failureText?(error: RecordedError): { text: string; settled?: boolean } | undefined;
}
type RecordedError = NonNullable<Deployment["error"]>;

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
  // A kind this console does not know gets a sentence, not its raw code (finding 2538).
  const label = Object.hasOwn(RUNTIME_FAILURE_CAUSE_LABELS, cause.kind)
    ? RUNTIME_FAILURE_CAUSE_LABELS[cause.kind]
    : "The runtime check failed";
  if (!detail) {
    return label;
  }
  return retried ? `${label} (${detail}).${retry}` : `${label} (${detail})`;
}

function deploymentFailure(error: Deployment["error"], context: DeploymentContext) {
  if (!error) {
    return element("p", { className: "muted" }, "No persisted startup failure.");
  }
  const worded = context.failureText?.(error);
  const { data } = error;
  const runtimeFailure: RuntimeFailureEvidence | undefined =
    data && "runtimeFailure" in data ? data.runtimeFailure : undefined;
  const preparation = data && "preparation" in data ? data.preparation : undefined;
  return element(
    "div",
    {},
    worded?.settled
      ? element("p", { className: "muted" }, `${error.code}: ${worded.text}`)
      : statusBlock("danger", null, `${error.code}: ${worded?.text ?? error.message}`),
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
function deploymentResult(record: Deployment, context: DeploymentContext) {
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
  return deploymentFailure(record.error, context);
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
  readError: unknown;
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
        // A quiet read is in flight: refresh once it lands.
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
  // The settled facts of the last record read: its outcome once final, whether its cleanup is
  // pending or how it ended, and its warning count.
  let previousSettled: string | undefined;
  let loading = false;
  let readingOverview = false;
  let generation = 0;
  let recordGeneration = 0;
  // Quiet polls and their overview rereads leave Refresh alone until the reader presses it.
  let polling = false;
  let refreshQueued = false;
  let record: Deployment | null = null;
  let error: unknown = null;
  let overviewUnavailable = false;
  // This records reconciliation, not a cached deployment; refusals reset it.
  let terminalOverview: "unread" | "reading" | "ready" | "failed" = "unread";
  // The refused or failed overview read, when one was, so its text says why (finding 2538).
  let overviewError: unknown = null;
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

  function finishRecord(overviewRead = false, retryOverview = false) {
    if (refreshQueued) {
      refreshQueued = false;
      void loadStatus(true);
    } else if (
      !overviewRead &&
      (terminalOverview === "unread" || (retryOverview && terminalOverview === "failed")) &&
      !error &&
      record &&
      !deploymentPending(record.status)
    ) {
      // Either reader can discover completion. Reuse that verified record while
      // refreshing current-version information, without another deployment GET.
      terminalOverview = "reading";
      void loadStatus(true, true, record);
    } else {
      schedulePoll();
    }
  }

  async function loadStatus(refreshAgent = false, poll = false, verifiedRecord?: Deployment) {
    if (loading || !context.isCurrent()) {
      return;
    }
    clearTimeout(pollTimer);
    pollTimer = undefined;
    const started = generation;
    const startedRecord = recordGeneration;
    readingOverview = refreshAgent;
    // A failed background check does not change recorded progress. A definitive refusal
    // clears both copies so a later transient failure cannot restore revoked evidence.
    loading = true;
    polling = poll;
    error = null;
    if (refreshAgent) {
      overviewUnavailable = false;
      overviewError = null;
    }
    render();
    try {
      const [statusResult, agentResult, revisionsResult] = await Promise.allSettled([
        verifiedRecord ?? readDeployment(context, path, revision.id),
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
      if (started !== generation) {
        // A fresh selected read can supersede this work, but not a definitive refusal.
        if (statusResult.status === "rejected" && !transientReadError(statusResult.reason)) {
          invalidate(statusResult.reason);
        }
        return;
      }
      if (statusResult.status === "fulfilled") {
        if (!verifiedRecord && startedRecord === recordGeneration) {
          if (
            lastRecord?.status !== statusResult.value.status ||
            deploymentPending(statusResult.value.status)
          ) {
            terminalOverview = "unread";
          }
          record = statusResult.value;
          lastRecord = statusResult.value;
        }
      } else if (!transientReadError(statusResult.reason)) {
        // A definitive refusal also cancels the accompanying overview. Publish it
        // before a newer revision could replace this panel and hide the refusal.
        invalidate(statusResult.reason);
        return;
      } else if (startedRecord === recordGeneration) {
        error = statusResult.reason;
        record = poll ? lastRecord : null;
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
          overviewError =
            [agentResult, revisionsResult].find(
              (result): result is PromiseRejectedResult => result.status === "rejected",
            )?.reason ?? null;
        }
        if (!error && record && !deploymentPending(record.status)) {
          terminalOverview = overviewUnavailable ? "failed" : "ready";
        }
      }
    } catch (cause) {
      if (!context.isCurrent() || started !== generation) {
        return;
      }
      if (requestFailure(cause).status === 401) {
        context.onExpired();
        return;
      }
      error = cause;
      record = poll && transientReadError(error) ? lastRecord : null;
      if (verifiedRecord) {
        terminalOverview = "failed";
      }
      if (!transientReadError(error)) {
        lastRecord = null;
        terminalOverview = "unread";
      }
    } finally {
      if (context.isCurrent() && started === generation) {
        loading = false;
        readingOverview = false;
        publish(poll);
        finishRecord(refreshAgent);
      }
    }
  }

  function publish(poll: boolean, freshRecord = false) {
    // Revealing a final refusal can push the next focused control off screen.
    // Keep it visible only if the reader could see it before the poll completed.
    const focused = document.activeElement;
    const position =
      poll &&
      error &&
      !transientReadError(error) &&
      !details.open &&
      focused instanceof HTMLElement &&
      section.parentElement?.contains(focused)
        ? focused.getBoundingClientRect()
        : null;
    render(freshRecord);
    onStatusChange({
      outcome: record ? deploymentOutcome(record) : null,
      record,
      readFailed: error !== null,
      readError: error,
      transientFailure: error !== null && transientReadError(error),
      overviewUnavailable,
    });
    if (
      position &&
      position.height > 0 &&
      position.top >= 0 &&
      position.bottom <= window.innerHeight &&
      details.open &&
      focused instanceof HTMLElement &&
      document.activeElement === focused
    ) {
      focused.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    }
  }

  function renderStatus() {
    if (error && !record) {
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
                "Revision cleanup pending. This version's resources have not been confirmed removed.",
              // A started cleanup stays running between its attempts (finding 2466).
              running: record.cleanup.nextAttemptAt
                ? "Revision cleanup started. This version's resources have not been confirmed removed; the controller will retry."
                : "Revision cleanup is running. This version's resources have not been confirmed removed.",
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
      record.error ? deploymentResult(record, context) : null,
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

  function render(freshRecord = false) {
    // Keep both controls mounted during reads. Fold routine completion and a first outcome
    // that arrives after the page is visible; the summary above already shows that outcome.
    const busy = String((loading && !polling) || refreshQueued);
    if (refresh.getAttribute("aria-disabled") !== busy) {
      refresh.setAttribute("aria-disabled", busy);
    }
    if (loading && !freshRecord) {
      return;
    }
    const outcome = record ? deploymentOutcome(record) : null;
    const { cleanup, warnings } = record ?? {};
    const readState = error ? (transientReadError(error) ? "transient" : "refused") : "read";
    const evidence = [
      outcome,
      cleanup?.status,
      warnings?.length,
      overviewUnavailable,
      readState,
    ].join("/");
    const settled = error
      ? undefined
      : [
          deploymentPending(outcome) ? "pending" : outcome,
          deploymentPending(cleanup?.status) ? "pending" : cleanup?.status,
          warnings?.length,
        ].join("/");
    const readerRefresh = !polling;
    if (evidence !== previousEvidence || (readerRefresh && error)) {
      const late = previousEvidence === undefined && pageShown();
      // Routine polls preserve the reader's disclosure choice, including recovery from a
      // failed read and a pending cleanup's progress after a final outcome. A terminal result
      // or explicit failed refresh still reveals its notice.
      const quietProgress =
        previousEvidence !== undefined &&
        polling &&
        !overviewUnavailable &&
        (error
          ? readState === "transient"
          : (deploymentPending(outcome) && cleanup?.status !== "failed" && !warnings?.length) ||
            settled === previousSettled);
      if (!quietProgress) {
        if (readState === "refused" && !details.open) {
          reservedHeight = null;
          heightObserver?.disconnect();
          content.style.removeProperty("min-height");
        }
        details.open = Boolean(
          previousEvidence !== undefined ||
          (outcome !== "succeeded" && !late) ||
          overviewUnavailable ||
          cleanup ||
          warnings?.length,
        );
      }
      previousEvidence = evidence;
    }
    if (settled !== undefined) {
      previousSettled = settled;
    }
    patchChildren(content, [
      element(
        "p",
        { className: "muted" },
        `Most recent visible deployment · v${revision.revision}`,
      ),
      ...(record
        ? [
            element(
              "p",
              { className: "muted" },
              error ? "Update delayed · last known status" : "Latest update received",
            ),
          ]
        : []),
      renderStatus(),
      ...(overviewUnavailable
        ? [
            statusBlock(
              "danger",
              null,
              `Current version and version history could not be refreshed. ${
                overviewError === null
                  ? "Use the page Refresh control to retry."
                  : readFailureReason(overviewError)
              }`,
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
    const pendingRecord = error && transientReadError(error) ? lastRecord : record;
    const pending =
      deploymentPending(pendingRecord?.status) || deploymentPending(pendingRecord?.cleanup?.status);
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
    if (reservedHeight === null || !section.isConnected || !details.open) {
      return;
    }
    const height = content.getBoundingClientRect().height;
    if (height > reservedHeight) {
      reservedHeight = height;
      content.style.minHeight = `${height}px`;
    }
  }

  // A matching refusal revokes cached evidence and older reads together.
  function invalidate(cause: unknown) {
    if (!context.isCurrent()) {
      return;
    }
    terminalOverview = "unread";
    generation += 1;
    clearTimeout(pollTimer);
    pollTimer = undefined;
    loading = false;
    readingOverview = false;
    refreshQueued = false;
    record = null;
    lastRecord = null;
    error = cause;
    overviewUnavailable = false;
    overviewError = null;
    publish(true);
  }

  void loadStatus();
  // New permission or binding information can change a recorded failure's wording.
  // It is not a user refresh of an unsuccessful read.
  return Object.assign(section, {
    invalidate,
    // Called only for a fresh independent GET, never for a stale shared fallback.
    accept(next: Deployment) {
      if (!context.isCurrent() || next.deploymentId !== revision.id) {
        return;
      }
      const sameTerminal = !deploymentPending(next.status) && lastRecord?.status === next.status;
      recordGeneration += 1;
      if (sameTerminal && loading && readingOverview) {
        // A matching record shares explicit as well as automatic overview reads.
        // Its generation keeps the older status payload from replacing this one.
        record = next;
        lastRecord = next;
        error = null;
        // Only a freshly accepted matching record may render during this read.
        publish(true, true);
        return;
      }
      if (!sameTerminal) {
        terminalOverview = "unread";
      }
      generation += 1;
      loading = false;
      record = next;
      lastRecord = next;
      error = null;
      publish(true);
      finishRecord(false, true);
    },
    rerender() {
      if (record?.error) {
        render();
      }
    },
  });
}

// With shared, Deployment activity is reading this version's record, so the panel waits for
// show() instead of reading it again; an initial transient failure can fall back to its own read.
export function createVersionDeploymentEvidence(
  context: DeploymentContext,
  path: string,
  revisionId: string,
  {
    shared,
    operateAllowed,
    isCurrentVersion,
    onRecord,
    onRefused,
    onFreshRecord,
    hasVisibleReadError = () => false,
  }: {
    shared: boolean;
    operateAllowed: Promise<boolean | undefined>;
    isCurrentVersion: () => boolean;
    hasVisibleReadError?: (cause: unknown) => boolean;
    // Each record this panel shows, read here or handed over by the page.
    onRecord: (record: Deployment) => void;
    onRefused: (cause: unknown) => void;
    onFreshRecord: (record: Deployment) => void;
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
    let fresh: Deployment | null = null;
    render();
    try {
      const next = await readDeployment(context, path, revisionId);
      if (context.isCurrent() && started === generation) {
        status = next;
        fresh = next;
      }
    } catch (cause) {
      if (!context.isCurrent()) {
        return;
      }
      if (requestFailure(cause).status === 401) {
        context.onExpired();
        return;
      }
      if (!transientReadError(cause)) {
        // A shared success can render while this read is pending. Its generation
        // must not suppress a definitive refusal for the same immutable revision.
        fail(cause);
        onRefused(cause);
      } else if (started === generation) {
        status = null;
        error = cause;
      }
    } finally {
      if (context.isCurrent() && started === generation) {
        loading = false;
        render();
        diagnostics.render();
        if (status) {
          onRecord(status);
          if (fresh) {
            onFreshRecord(fresh);
          }
        }
      }
    }
  }

  // Deployment activity already read this version's record; show it instead of a stale one.
  function show(next: Deployment, readError: unknown = null) {
    if (!context.isCurrent() || !next) {
      return;
    }
    awaitingShared = false;
    clearTimeout(sharedTimer);
    generation += 1;
    loading = false;
    status = next;
    error = readError;
    render();
    diagnostics.render();
    onRecord(next);
  }

  // A shared failure supersedes older successes, including an in-flight manual read.
  function fail(cause: unknown) {
    if (!context.isCurrent()) {
      return;
    }
    if (requestFailure(cause).status === 401) {
      context.onExpired();
      return;
    }
    const fallback = awaitingShared && transientReadError(cause);
    awaitingShared = false;
    clearTimeout(sharedTimer);
    generation += 1;
    status = null;
    error = cause;
    const reading = loading;
    loading = false;
    render();
    diagnostics.render();
    if (fallback && !reading) {
      void load();
    }
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
          ...(loading ? { "aria-disabled": "true" } : {}),
        }),
      ),
      element(
        "div",
        { className: "version-deployment-result" },
        element(
          "div",
          {},
          error && !status
            ? statusBlock("danger", null, message(error), [], {
                role: hasVisibleReadError(error) ? null : "alert",
              })
            : status
              ? element(
                  "div",
                  {},
                  element(
                    "p",
                    {},
                    `Recorded outcome: ${outcomeLabel(deploymentOutcome(status))}${error ? " · update delayed" : ""}`,
                  ),
                  failureShownAbove && deploymentOutcome(status) === "failed"
                    ? element(
                        "p",
                        { className: "muted deployment-failure-above" },
                        "The error and its next step are at the top of this page.",
                      )
                    : deploymentResult(status, context),
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
        ),
        // Reserve wrapped error space without duplicating accessible text or alerts.
        ...[403, 404, 503].map((status) =>
          element(
            "div",
            { className: "version-deployment-error-size", "aria-hidden": "true" },
            statusBlock(
              "danger",
              null,
              element("span", { "data-message": message({ status }) }),
              [],
              { role: null },
            ),
          ),
        ),
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
    fail,
    render,
    release,
    setFailureShownAbove,
    // The page calls this when what its failureText answers changes.
    rerender: render,
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
