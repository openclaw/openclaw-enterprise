import type {
  AgentRuntimeDescription,
  AgentRuntimeLogPageWire,
  AgentRuntimeLogSource,
  RuntimeLogLevel,
  RuntimeLogRecord,
  RuntimeLogSourceId,
  RuntimeLogStream,
} from "@openclaw-enterprise/contracts";
import { type RequestOptions, requestFailure } from "../api-client.mjs";
import { button, element, replaceChildrenIfChanged, setText, statusBlock } from "../dom.mjs";
import { displayDate, namespacePath } from "./list.mjs";
import { fitLogTimeColumn, SOURCE_LABELS, podCard, recordRow, visibleText } from "./logs-view.mjs";

interface AgentLogsContext {
  namespaceId: string;
  operatorId?: string | null;
  view?: Element;
  isCurrent(): boolean;
  onExpired(): void;
  onResume?(resume: () => void): void;
  onRevalidate?(check: () => Promise<void>): () => void;
  request(path: string, options: RuntimeReadOptions): Promise<unknown>;
}

type RuntimeReadOptions = Pick<RequestOptions, "responseType"> & { revalidate?: false };
type RequestFailure = Partial<ReturnType<typeof requestFailure>>;
type LogViewIdentity = Pick<AgentLogsContext, "namespaceId" | "operatorId">;
type SourcePod = AgentRuntimeLogSource["pods"][number];

interface AgentLogsOptions {
  agent: { id: string };
  revisionId: string;
  shown?: Promise<void>;
  permissions?(options?: { fresh: boolean }): Promise<{ operate: boolean } | null>;
  onLogsDenied?(): void;
}

// A reader without operate can read logs without observing a Pod or status timestamp.
type ViewDescription = Pick<AgentRuntimeDescription, "pods" | "sources"> & {
  observedAt: string | null;
};

const STATUS_POLL_MS = 10_000;
const FOLLOW_POLL_MS = 2_000;
const MAX_ROWS = 5_000;
const TAIL_LINES = 200;
// The longest the Logs view keeps its strip and output back for their first reads.
const FIRST_VIEW_WAIT_MS = 2_000;
// A 403 is audited; remember it for this sign-in instead of re-asking every poll or every
// time the Logs tab reopens. A status denial also keeps whether the caller's permission answer
// allowed operate when it was last shown (null until an answer is compared): once a later
// answer allows operate where it did not, the view asks once more. The answer has no read_logs
// bit, so a log text denial lasts until sign-out.
const deniedLogViews = new Set<string>();
const deniedStatusViews = new Map<string, boolean | null>();
// Denials are per signed-in operator: another user signing in on this tab asks again.
const logViewKey = (context: LogViewIdentity, agentId: string) =>
  JSON.stringify([context.operatorId ?? null, context.namespaceId, agentId]);

/** Whether this page session already saw the Agent's log text read denied. */
export function logTextDenied(context: LogViewIdentity, agentId: string) {
  return deniedLogViews.has(logViewKey(context, agentId));
}

/** Forgets every remembered runtime denial: sign-out calls this, so a new sign-in asks again. */
export function clearRuntimeDenials() {
  deniedLogViews.clear();
  deniedStatusViews.clear();
}

const LEVELS = ["error", "warn", "info", "debug", "unknown"] satisfies RuntimeLogLevel[];

function runtimeErrorText(
  error: RequestFailure,
  tier: "logs" | "status",
  source?: RuntimeLogSourceId,
  manualRead = false,
) {
  if (error.status === 403) {
    // Name both grants: without status the Logs section never says what log text needs.
    return tier === "logs"
      ? "Log text requires Agent read_logs (or administer) and read access."
      : "Runtime status requires Agent operate and read access plus read access to this version. Log text needs Agent read_logs (or administer) and read access.";
  }
  if (error.status === 501) {
    return "This Compute Driver does not expose runtime status or logs, or an operator turned them off.";
  }
  if (error.code === "RUNTIME_LOGS_CLUSTER_RBAC" && source === "sandbox") {
    return "OpenShell denied the sandbox log read. Ask your platform operator to grant the OpenClaw Enterprise gateway identity the sandbox:read scope (see the Agent logs guide).";
  }
  if (error.code === "RUNTIME_LOGS_SANDBOX_NOT_FOUND") {
    return "OpenShell reports no such sandbox: it is not provisioned yet or was removed, or the OpenClaw Enterprise gateway identity is not a member of its Workspace (see the Agent logs guide).";
  }
  if (error.code === "RUNTIME_LOGS_CLUSTER_RBAC") {
    return "The cluster denied the read. Ask your platform operator to enable agentRuntimeLogs in the Helm chart (see the Agent logs guide).";
  }
  if (error.status === 429) {
    if (!manualRead) {
      return "Too many requests. Waiting before the next read.";
    }
    const seconds = error.retryAfterSeconds;
    return seconds === undefined
      ? "Too many requests. Try again shortly."
      : `Too many requests. Try again in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`;
  }
  if (error.status === 504) {
    return "The read timed out. Try again.";
  }
  if (error.code === "RUNTIME_LOGS_SOURCE_UNAVAILABLE") {
    return `This version has no ${source ?? "such"} log source.`;
  }
  if (error.code === "RUNTIME_LOGS_AUDIT_UNAVAILABLE") {
    return "The view could not be audited, so no output was read. Try again.";
  }
  if (error.status === 404) {
    return "This version is not available.";
  }
  return "Runtime status or logs are unavailable. Try again shortly.";
}

function withRequestId(text: string, error: RequestFailure) {
  return error.requestId ? `${text} Request ID: ${error.requestId}` : text;
}

/**
 * Runtime status needs Agent `operate`; log text needs only `read_logs`. Without status
 * the picker offers every source and names no Pod: OCC reads the source's current Pod
 * and a view's cursor keeps following it.
 */
function unobservedDescription(): ViewDescription {
  const sources: RuntimeLogSourceId[] = ["gateway", "agent", "sandbox"];
  return {
    observedAt: null,
    pods: [],
    sources: sources.map((id) => ({
      id,
      kind: id === "sandbox" ? "sandbox" : "container",
      pods: [],
      available: true,
      retention: "",
    })),
  };
}

function downloadFileName(
  agentId: string,
  revisionId: string,
  source: RuntimeLogSourceId,
  pod: string,
  previous: boolean,
) {
  const name = [agentId, revisionId, source, pod].join("-");
  const suffix = source !== "sandbox" && previous ? "-previous" : "";
  return `${name.replace(/[^A-Za-z0-9_.-]/g, "_")}${suffix}.log`;
}

/** Logs tab: runtime status strip, source picker, bounded log pane and follow. */
export function renderAgentLogs(
  context: AgentLogsContext,
  {
    agent,
    revisionId,
    shown = Promise.resolve(),
    // Returns the caller's newest permission answer; `{ fresh: true }` reads it again.
    permissions = () => Promise.resolve(null),
    onLogsDenied = () => {},
  }: AgentLogsOptions,
) {
  const base = `${namespacePath(context.namespaceId)}/agents/${encodeURIComponent(agent.id)}/deployments/${encodeURIComponent(revisionId)}/runtime`;
  const deniedKey = logViewKey(context, agent.id);
  const statusKey = JSON.stringify([
    context.operatorId ?? null,
    context.namespaceId,
    agent.id,
    revisionId,
  ]);
  // The status strip fills from the first status read and can be taller than a phone screen.
  // Until that read and the first log page settle (at most FIRST_VIEW_WAIT_MS), the strip and
  // log viewer stay back, so the view appears in one step instead of the strip pushing the
  // output down after the page scrolled to it (finding 1413).
  const section = element("section", { className: "agent-logs agent-logs-pending" });
  let firstLogRead: Promise<void> | null = null;
  let markFirstView: () => void;
  const firstView = new Promise<void>((resolve) => {
    markFirstView = resolve;
  });
  function showFirstView() {
    clearTimeout(firstViewTimer);
    if (section.classList.contains("agent-logs-pending")) {
      section.classList.remove("agent-logs-pending");
      // A hidden pane cannot scroll; open at the newest output as a shown one would. The page
      // holding the view can still be hidden (an Agent page waits for its overview), so scroll
      // once it shows. Scrolled to the top, the pane would read as scrolled up and Follow would
      // stay paused (finding 1536).
      void shown.then(() => {
        if (current()) {
          pane.scrollTop = pane.scrollHeight;
        }
      });
    }
    markFirstView();
  }
  const firstViewTimer = setTimeout(showFirstView, FIRST_VIEW_WAIT_MS);
  const strip = element("div", { className: "runtime-strip", "aria-live": "polite" });
  // One line: a status region for loading and errors, and the observed time beside it. The
  // time changes on every 10 s poll, so it sits outside the status region, and aria-live=off
  // keeps the page view's live region from announcing it; only loading and errors are
  // announced (finding 1425). The status region stays in the tree, empty when there is
  // nothing to say, so a later error is announced.
  const stripStatus = element("span", { role: "status" }, "Loading runtime status…");
  const stripObserved = element("span", { "aria-live": "off" });
  const stripLine = element("p", { className: "muted" }, stripStatus, stripObserved);
  function showStripStatus(text: string) {
    setText(stripObserved, "");
    stripStatus.textContent = text;
  }
  const sourceSelect = element("select", { id: "runtime-log-source", disabled: true });
  const podSelect = element("select", { id: "runtime-log-pod", hidden: true });
  const podLabel = element("label", { for: "runtime-log-pod", hidden: true }, "Pod / container");
  const podPicker = element(
    "div",
    { className: "log-picker log-pod-picker", hidden: true },
    podLabel,
    podSelect,
  );
  const previous = element("input", {
    type: "checkbox",
    id: "runtime-log-previous",
    disabled: true,
  });
  // Off by default: the server returns info and above (and lines of unknown level),
  // so debug span records do not crowd a page out.
  const includeDebug = element("input", {
    type: "checkbox",
    id: "runtime-log-debug",
    disabled: true,
  });
  const followButton = button("Follow", () => setFollow(!following), {
    "aria-pressed": "false",
    size: "sm",
    className: "log-follow",
    disabled: true,
  });
  const refreshButton = button("Refresh logs", () => void readLogs({ restart: true }), {
    tone: "ghost",
    size: "sm",
    disabled: true,
  });
  const downloadButton = button("Download", () => void download(), {
    size: "sm",
    disabled: true,
  });
  const hiddenLevels = new Set<string>();
  const levelChips = LEVELS.map((level) =>
    button(
      level,
      (event) => {
        const chip = event.currentTarget as HTMLButtonElement;
        if (hiddenLevels.has(level)) {
          hiddenLevels.delete(level);
        } else {
          hiddenLevels.add(level);
        }
        chip.setAttribute("aria-pressed", String(!hiddenLevels.has(level)));
        applyFilters();
      },
      { className: `log-chip log-level-${level}`, "aria-pressed": "true" },
    ),
  );
  const filterInput = element("input", {
    type: "search",
    id: "runtime-log-filter",
    placeholder: "Filter loaded lines",
    autocomplete: "off",
  });
  filterInput.addEventListener("input", () => applyFilters());
  const filterStatus = element("p", { className: "log-filter-status", role: "status" });
  const retention = element("p", { className: "log-retention" });
  const sourceHint = statusBlock("warning", null, null, [], {
    className: "log-source-hint",
    role: "note",
    hidden: true,
  });
  const logStatus = element("p", { className: "log-output-status", role: "status" });
  const logError = statusBlock("danger", null, null, [], { className: "log-error", hidden: true });
  const pane = element("div", {
    className: "log-pane",
    role: "log",
    tabindex: "0",
    "aria-label": "Runtime log output",
  });
  // The view is built before it is shown: size the time column once the pane is laid out.
  const timeColumn = new ResizeObserver(() => {
    if (fitLogTimeColumn(pane)) {
      timeColumn.disconnect();
    }
  });
  timeColumn.observe(pane);
  // Detaching the view for Back's cache resets the pane to the top; resume restores the
  // reader's last position so follow neither stalls as "scrolled up" nor jumps. A reader
  // at the bottom returns to the bottom, even if a late scroll event or resize moved it.
  let paneScrollTop = 0;
  let paneAtBottom = true;
  pane.addEventListener(
    "scroll",
    () => {
      if (pane.isConnected) {
        paneScrollTop = pane.scrollTop;
        paneAtBottom = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 24;
      }
    },
    { passive: true },
  );

  let description: ViewDescription | null = null;
  let cursor: string | null = null;
  let following = false;
  let followTimer: number | undefined;
  let statusTimer: number | undefined;
  let reading = false;
  // Counts status reads. A newer read supersedes one in flight: its answer, success or
  // failure, may predate a revocation the newer one sees.
  let statusRead = 0;
  // Set once a log read was allowed: a refusal after that is a revocation.
  let logsAllowed = false;
  // A source, Pod or instance change while a read is in flight restarts the view after it.
  let restartPending = false;
  let rows = 0;
  // The log query (source, Pod, instance, level floor) whose lines the pane shows, and the
  // status line its first page set.
  let shownSelection: string | null = null;
  let shownStatus = "";
  // Updates a manual read's "Try again in N seconds" once that wait has passed.
  let retryHintTimer: number | undefined;
  // Set when a read is refused after this view showed output; Back rebuilds such a view.
  let outputRefused = false;
  let logsDenied = deniedLogViews.has(deniedKey);
  // Set when runtime status is denied; the last page's stream stands in for the Pod list.
  let statusDenied = false;
  // Set once this view compared a status denial with a fresh permission answer, or had no
  // reason to; Back's check revalidates the page's answer after that.
  let permissionsAsked = false;
  let lastStream: RuntimeLogStream | null = null;

  const current = () => context.isCurrent();
  // Runtime reads are live and audited: a view restored by Back resumes them instead of
  // having the console replay every one of them to revalidate the cached view.
  // Answers Back's check already read, taken once by the resumed view's first reads.
  const checked = new Map<string, unknown>();
  const read = (path: string, options: RuntimeReadOptions = {}) => {
    if (checked.has(path)) {
      const answer = checked.get(path);
      checked.delete(path);
      return Promise.resolve(answer);
    }
    return context.request(path, { ...options, revalidate: false });
  };

  function selectedSource() {
    return description?.sources.find(({ id }) => id === sourceSelect.value);
  }

  function selectedPod() {
    const source = selectedSource();
    return (
      source?.pods.find(
        ({ name, container }) => JSON.stringify([name, container]) === podSelect.value,
      ) ?? source?.pods[0]
    );
  }

  // A sandbox source has no Pods: OCC derives the Sandbox from the revision.
  function readableSelection(source = selectedSource()) {
    return (
      source !== undefined && (source.kind === "sandbox" || statusDenied || Boolean(selectedPod()))
    );
  }

  // Compare the selected stream, not its Pod UID or restart count: the cursor handles those.
  function effectiveSelection() {
    const pod = selectedPod();
    return JSON.stringify([
      selectedSource()?.id,
      pod?.name,
      pod?.container,
      previous.checked,
      readableSelection(),
    ]);
  }

  function logQuery(source: AgentRuntimeLogSource, pod: SourcePod | undefined) {
    const query = new URLSearchParams({ source: source.id });
    if (source.kind !== "sandbox" && pod) {
      query.set("pod", pod.name);
      query.set("container", pod.container);
    }
    if (previous.checked) {
      query.set("previous", "true");
    }
    if (!includeDebug.checked) {
      query.set("minLevel", "info");
    }
    return query;
  }

  function clearShownLines() {
    cursor = null;
    pane.replaceChildren();
    rows = 0;
    shownSelection = null;
    applyFilters();
  }

  function showLogError(text: string | null) {
    clearTimeout(retryHintTimer);
    logError.hidden = text === null;
    logError.textContent = text ?? "";
  }

  function showLogReadError(
    error: RequestFailure,
    source: AgentRuntimeLogSource,
    { manualRead }: { manualRead: boolean },
  ) {
    if (logsDenied) {
      return;
    }
    showLogError(withRequestId(runtimeErrorText(error, "logs", source.id, manualRead), error));
    if (manualRead && error.status === 429 && error.retryAfterSeconds !== undefined) {
      // A later error or a successful read replaces the text and cancels this (finding 1715).
      // A view held for Back is updated too, so it never returns with a wait that has passed.
      retryHintTimer = setTimeout(() => {
        showLogError(withRequestId("Too many requests. You can try again now.", error));
      }, error.retryAfterSeconds * 1000);
    }
    if (error.status !== 403) {
      return;
    }
    // A refusal from either read clears the displayed output. A page or download already
    // authorized before that refusal can still arrive; neither may put its output back.
    logsDenied = true;
    deniedLogViews.add(deniedKey);
    outputRefused ||= rows > 0;
    restartPending = false;
    cursor = null;
    pane.replaceChildren();
    rows = 0;
    shownSelection = null;
    logStatus.textContent = "";
    applyFilters();
    setFollow(false);
    renderPickers();
    onLogsDenied();
    // One revoke often removes operate too: ask for status once now, so the Pod cards it showed
    // do not stay under the log refusal until the next status poll (finding 1597). This read
    // supersedes one in flight, which may have been authorized before the revoke. A first
    // read refused revokes nothing.
    if (logsAllowed && !statusDenied && description !== null) {
      void loadStatus();
    }
  }

  function renderStrip() {
    if (!description || description.observedAt === null) {
      return;
    }
    setText(stripStatus, "");
    setText(stripObserved, `Observed ${displayDate(description.observedAt)}`);
    // The strip is a live region and status polls every 10 s, so rebuild it only on a change.
    replaceChildrenIfChanged(
      strip,
      description.pods.length
        ? description.pods.map(podCard)
        : [
            element(
              "p",
              { className: "muted" },
              "This version has no running Pod. See Deployment activity.",
            ),
          ],
    );
  }

  function renderPickers() {
    if (!description) {
      return;
    }
    const chosen = sourceSelect.value;
    // Rebuilding identical options would reset an open picker and re-announce it.
    replaceChildrenIfChanged(
      sourceSelect,
      description.sources.map((source) =>
        element(
          "option",
          { value: source.id, disabled: !source.available },
          `${SOURCE_LABELS[source.id] ?? source.id}${source.available ? "" : " (no Pod)"}`,
        ),
      ),
    );
    const available = description.sources.find(({ available }) => available);
    sourceSelect.value = description.sources.some(({ id, available: ok }) => id === chosen && ok)
      ? chosen
      : (available?.id ?? description.sources[0]?.id ?? "");
    const source = selectedSource();
    const chosenPod = podSelect.value;
    replaceChildrenIfChanged(
      podSelect,
      (source?.pods ?? []).map((pod) =>
        element(
          "option",
          { value: JSON.stringify([pod.name, pod.container]) },
          `${pod.name} / ${pod.container}`,
        ),
      ),
    );
    podSelect.hidden = (source?.pods.length ?? 0) <= 1;
    podLabel.hidden = podSelect.hidden;
    podPicker.hidden = podSelect.hidden;
    if (
      source?.pods.some(({ name, container }) => JSON.stringify([name, container]) === chosenPod)
    ) {
      podSelect.value = chosenPod;
    }
    setText(retention, source?.retention ?? "");
    // A dedicated Gateway logs connection errors to a Harness that never came up; its
    // own source holds the cause (for example a failed model probe).
    // Only a revision with a dedicated Harness lists an "agent" source; the hint fires
    // when no Harness Pod is ready (none created yet, or every one unready), not while a
    // ready replacement serves beside an old Pod during a rollout. Without status the
    // Pod list is unknown, so there is no hint.
    const harnessPods = description.pods.filter(({ role }) => role === "agent");
    const harnessDown =
      !statusDenied &&
      source?.id === "gateway" &&
      description.sources.some(({ id }) => id === "agent") &&
      !harnessPods.some(({ ready }) => ready);
    sourceHint.hidden = !harnessDown;
    setText(
      sourceHint,
      !harnessDown
        ? ""
        : harnessPods.length === 0
          ? "The Agent (Harness) has no Pod yet. Gateway errors that fail to reach it, such as ECONNREFUSED, are a symptom: see Deployment activity for why it has not started."
          : "The Agent (Harness) Pod is not ready. Gateway errors that fail to reach it, such as ECONNREFUSED, are a symptom: read the Agent (Harness) source for the cause.",
    );
    const pod = selectedPod();
    const restarts = pod
      ? pod.restartCount
      : statusDenied && lastStream !== null && lastStream.source === source?.id
        ? lastStream.restartCount
        : 0;
    previous.disabled = logsDenied || restarts === 0;
    if (previous.disabled) {
      previous.checked = false;
    }
    const readable = !logsDenied && readableSelection();
    sourceSelect.disabled = logsDenied || description.sources.length === 0;
    includeDebug.disabled = logsDenied || description.sources.length === 0;
    refreshButton.disabled = !readable;
    downloadButton.disabled = !readable;
    followButton.disabled = !readable || previous.checked;
  }

  // A later status denial clears the Pod details, not an independently authorized log cursor.
  function offerLogsWithoutStatus() {
    if (statusDenied) {
      return;
    }
    const first = description === null;
    statusDenied = true;
    description = unobservedDescription();
    strip.replaceChildren();
    renderPickers();
    if (first && !logsDenied) {
      firstLogRead = readLogs({ restart: true });
    }
  }

  async function loadStatus() {
    clearTimeout(statusTimer);
    if (!current()) {
      return;
    }
    // Taken before any wait, so even a load that reads nothing (hidden page, remembered
    // refusal) supersedes a read in flight.
    const ticket = ++statusRead;
    const superseded = () => ticket !== statusRead;
    if (deniedStatusViews.has(statusKey)) {
      // A rebuilt view compares the denial with a fresh answer, so an operate grant since
      // shows on the next visit to Logs (finding 1579). Back's check already compared a
      // retained view's answer; its resumed loads take the newest one.
      const fresh = !permissionsAsked;
      permissionsAsked = true;
      const operate = (await permissions({ fresh }))?.operate === true;
      // Another status load may have taken the denial while this one waited.
      if (!current() || !deniedStatusViews.has(statusKey)) {
        return;
      }
      if (operate && deniedStatusViews.get(statusKey) === false) {
        // Operate is granted again since the denial: ask once more, never on a timer.
        deniedStatusViews.delete(statusKey);
      } else {
        deniedStatusViews.set(statusKey, operate);
        showStripStatus(runtimeErrorText({ status: 403 }, "status"));
        offerLogsWithoutStatus();
        return;
      }
    }
    if (!document.hidden) {
      try {
        const first = description === null;
        const answer = (await read(base)) as AgentRuntimeDescription;
        // A superseded first answer still opens the view, unless a refusal has taken its place.
        if (!current() || (superseded() && description !== null)) {
          return;
        }
        const selection = effectiveSelection();
        description = answer;
        statusDenied = false;
        renderStrip();
        renderPickers();
        if (first && !logsDenied) {
          firstLogRead = readLogs({ restart: true });
        } else if (!logsDenied && selection !== effectiveSelection()) {
          // A restart normally clears the old view. Do that now if it must wait for an
          // in-flight read (whose denial still wins), or there is no readable replacement.
          if (reading || !readableSelection()) {
            cursor = null;
            pane.replaceChildren();
            rows = 0;
            logStatus.textContent = "";
            applyFilters();
          }
          showLogError(null);
          void readLogs({ restart: true });
        }
        if (superseded()) {
          // The newer load schedules the next poll.
          return;
        }
      } catch (cause) {
        const error = requestFailure(cause);
        if (!current() || superseded()) {
          return;
        }
        if (error.status === 401) {
          context.onExpired();
          return;
        }
        showStripStatus(withRequestId(runtimeErrorText(error, "status"), error));
        if (error.status === 403) {
          offerLogsWithoutStatus();
        }
        // Authorization and support failures do not change on their own.
        if (error.status === 403 || error.status === 404 || error.status === 501) {
          if (error.status === 403) {
            deniedStatusViews.set(statusKey, null);
            // An answer that allows operate may predate a revocation: once per view, compare
            // the refusal with a fresh one, so a later grant is not taken as unchanged.
            const fresh = !permissionsAsked;
            permissionsAsked = true;
            void permissions()
              .then((answer) =>
                answer?.operate === true && fresh ? permissions({ fresh }) : answer,
              )
              .then((answer) => {
                if (deniedStatusViews.get(statusKey) === null) {
                  deniedStatusViews.set(statusKey, answer?.operate === true);
                }
              });
          }
          return;
        }
      }
    }
    statusTimer = setTimeout(() => void loadStatus(), STATUS_POLL_MS);
  }

  function rowVisible(row: HTMLElement) {
    if (row.dataset.level === undefined) {
      return true;
    }
    // Rows hold escaped text, so a pasted line with an invisible character still matches.
    const text = visibleText(filterInput.value.trim()).toLowerCase();
    return (
      !hiddenLevels.has(row.dataset.level) &&
      (text === "" || row.dataset.search?.includes(text) === true)
    );
  }

  // Client-side only: filters narrow the rows already loaded, never the server read.
  function applyFilters() {
    let lines = 0;
    let shown = 0;
    for (const row of pane.children as HTMLCollectionOf<HTMLElement>) {
      row.hidden = !rowVisible(row);
      if (row.dataset.level !== undefined) {
        lines += 1;
        shown += row.hidden ? 0 : 1;
      }
    }
    const filtering = hiddenLevels.size > 0 || filterInput.value.trim() !== "";
    filterStatus.textContent = filtering
      ? `Showing ${shown} of ${lines} loaded lines. Filters search only the lines loaded in this view, not the whole container log.`
      : "Filters search only the lines loaded in this view, not the whole container log.";
  }

  function appendRecords(records: readonly RuntimeLogRecord[]) {
    const atBottom = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 24;
    for (const record of records) {
      const row = recordRow(record);
      row.hidden = !rowVisible(row);
      pane.append(row);
      rows += 1;
    }
    while (rows > MAX_ROWS && pane.firstChild) {
      pane.firstChild.remove();
      rows -= 1;
    }
    applyFilters();
    if (atBottom) {
      pane.scrollTop = pane.scrollHeight;
    }
  }

  // A fresh download can name a different Pod, or report that no Pod remains.
  // Only downloads without production metadata fall back to the loaded page.
  function downloadPodName(
    text: string,
    source: AgentRuntimeLogSource,
    pod: SourcePod | undefined,
  ) {
    if (pod) {
      return pod.name;
    }
    const header = text.slice(0, Math.max(0, text.indexOf("\n")));
    const served = header.startsWith("# ") ? / pod=(\S+)/.exec(header)?.[1] : undefined;
    const prefix = `# agent=${agent.id} revision=${revisionId} source=${source.id} `;
    if (
      source.kind === "container" &&
      header.startsWith(prefix) &&
      / observedAt=\S+ withheld=\d+$/.test(header)
    ) {
      return served ?? "no-pod";
    }
    return (
      served ??
      (statusDenied && lastStream?.source === source.id ? lastStream.pod : null) ??
      source.id
    );
  }

  // A download is its own audited read of the last 1000 lines through the session.
  async function download() {
    const source = selectedSource();
    const pod = selectedPod();
    if (!current() || logsDenied || !source || !readableSelection(source)) {
      return;
    }
    const query = logQuery(source, pod);
    query.set("download", "true");
    downloadButton.disabled = true;
    try {
      const text = await read(`${base}/logs?${query}`, { responseType: "text" });
      if (!current() || logsDenied) {
        return;
      }
      if (typeof text !== "string") {
        // Never save a JSON envelope (or "[object Object]") as the log file.
        throw new Error("The log download did not return text.");
      }
      showLogError(null);
      logsAllowed = true;
      const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
      const link = element("a", {
        href: url,
        download: downloadFileName(
          agent.id,
          revisionId,
          source.id,
          downloadPodName(text, source, pod),
          query.get("previous") === "true",
        ),
        hidden: true,
      });
      section.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (cause) {
      const error = requestFailure(cause);
      if (!current()) {
        return;
      }
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      showLogReadError(error, source, { manualRead: true });
    } finally {
      downloadButton.disabled = logsDenied || !readableSelection();
    }
  }

  function setFollow(next: boolean) {
    following = next && !logsDenied && !previous.checked;
    followButton.setAttribute("aria-pressed", String(following));
    followButton.textContent = following ? "Following" : "Follow";
    clearTimeout(followTimer);
    if (following) {
      scheduleFollow(FOLLOW_POLL_MS);
    }
  }

  function scheduleFollow(delay: number) {
    clearTimeout(followTimer);
    followTimer = setTimeout(() => {
      if (!current() || !following) {
        return;
      }
      // Pause while hidden or while the reader scrolled up; resume on the next tick.
      const scrolledUp = pane.scrollTop + pane.clientHeight < pane.scrollHeight - 24;
      if (document.hidden || scrolledUp) {
        scheduleFollow(FOLLOW_POLL_MS);
        return;
      }
      void readLogs({ restart: false });
    }, delay);
  }

  async function readLogs({ restart }: { restart: boolean }) {
    const source = selectedSource();
    const pod = selectedPod();
    if (reading && restart) {
      restartPending = true;
      // Lines kept for a refresh still in flight must not stay under another selection's
      // picker while that read finishes: clear them now, as a restart for it would.
      if (
        shownSelection !== null &&
        (!source || logQuery(source, pod).toString() !== shownSelection)
      ) {
        clearShownLines();
        logStatus.textContent = "Reading output…";
      }
      return;
    }
    if (!current() || reading || logsDenied || !source || !readableSelection(source)) {
      if (source && !readableSelection(source)) {
        logStatus.textContent = "This version has no running Pod for this source.";
      }
      return;
    }
    reading = true;
    const query = logQuery(source, pod);
    const selection = query.toString();
    // Refreshing the lines shown keeps them until the new page arrives, so a failed or
    // rate-limited refresh leaves them in place (finding 1715). A refusal still clears them in
    // showLogReadError, and another selection clears them here: they belong to the old one. So
    // do lines without a cursor (rejected, say): nothing could read on from them.
    const keepShown = restart && cursor !== null && selection === shownSelection;
    // A refresh that ends without a page puts back the status line of the lines still shown.
    const restoreShownStatus = () => {
      if (keepShown && selection === shownSelection) {
        logStatus.textContent = shownStatus;
      }
    };
    if (restart) {
      if (!keepShown) {
        clearShownLines();
      }
      logStatus.textContent = "Reading output…";
      query.set("tailLines", String(TAIL_LINES));
    } else if (cursor) {
      query.set("cursor", cursor);
    }
    let retryAfter = FOLLOW_POLL_MS;
    try {
      const page = (await read(`${base}/logs?${query}`)) as AgentRuntimeLogPageWire;
      if (!current() || restartPending || logsDenied) {
        restoreShownStatus();
        return;
      }
      showLogError(null);
      logsAllowed = true;
      if (restart) {
        pane.replaceChildren();
        rows = 0;
        shownSelection = selection;
      }
      cursor = page.cursor;
      appendRecords(page.records);
      if (statusDenied) {
        // A page with no running Pod clears the last Pod, so nothing names it.
        lastStream = page.stream;
        renderPickers();
      }
      const lines = page.records.filter(({ type }) => type === "line").length;
      if (restart) {
        logStatus.textContent =
          page.stream === null
            ? "This version has no running Pod for this source."
            : lines === 0 && page.withheld > 0
              ? `Only withheld output in the last ${TAIL_LINES} lines.`
              : lines === 0
                ? `No ${includeDebug.checked ? "" : "info-or-higher "}output in the last ${TAIL_LINES} lines.`
                : source.kind === "sandbox"
                  ? `Showing policy decisions and supervisor output of sandbox ${page.stream.sandbox ?? ""}.`
                  : `Showing ${previous.checked ? "the previous instance of " : ""}${page.stream.container} in ${page.stream.pod}.`;
        shownStatus = logStatus.textContent;
      }
    } catch (cause) {
      const error = requestFailure(cause);
      if (!current() || (restartPending && error.status !== 401 && error.status !== 403)) {
        restoreShownStatus();
        return;
      }
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      if (error.code === "RUNTIME_LOGS_CURSOR_INVALID") {
        // A new audited view replaces a rejected cursor. It starts in `finally`, after
        // this read releases `reading`, so the new read keeps its own guard.
        cursor = null;
        restartPending = true;
        return;
      }
      if (restart) {
        logStatus.textContent = "";
        restoreShownStatus();
      }
      showLogReadError(error, source, { manualRead: !following });
      if (error.status === 501) {
        setFollow(false);
      } else if (!logsDenied) {
        retryAfter = Math.max(FOLLOW_POLL_MS, (error.retryAfterSeconds ?? 10) * 1000);
      }
    } finally {
      reading = false;
      if (restartPending && current()) {
        // The page just read belongs to the previous selection; start the new view.
        restartPending = false;
        void readLogs({ restart: true });
      }
    }
    if (following && current()) {
      scheduleFollow(retryAfter);
    }
  }

  sourceSelect.addEventListener("change", () => {
    podSelect.value = "";
    renderPickers();
    void readLogs({ restart: true });
  });
  podSelect.addEventListener("change", () => {
    renderPickers();
    void readLogs({ restart: true });
  });
  // The level floor is part of every read; changing it starts a new view.
  includeDebug.addEventListener("change", () => void readLogs({ restart: true }));
  previous.addEventListener("change", () => {
    if (previous.checked) {
      setFollow(false);
    }
    renderPickers();
    void readLogs({ restart: true });
  });

  section.append(
    element("h3", {}, "Runtime"),
    stripLine,
    strip,
    element(
      "div",
      { className: "log-viewer" },
      element(
        "div",
        { className: "log-viewer-header" },
        element("h3", {}, "Logs"),
        element(
          "p",
          { className: "log-safety" },
          "Only operational output and sandbox policy decisions. Credential-shaped text is masked; structured payloads, prompts and protocol traffic are withheld. Nothing here is stored.",
        ),
      ),
      element(
        "div",
        { className: "log-controls" },
        element(
          "div",
          { className: "log-toolbar" },
          element(
            "div",
            { className: "log-picker" },
            element("label", { for: "runtime-log-source" }, "Source"),
            sourceSelect,
          ),
          podPicker,
          element(
            "div",
            { className: "log-options" },
            element("label", { className: "log-option" }, previous, " Previous instance"),
            element("label", { className: "log-option" }, includeDebug, " Include debug"),
          ),
          element("div", { className: "log-actions" }, followButton, refreshButton, downloadButton),
        ),
        element(
          "div",
          { className: "log-filters", role: "group", "aria-label": "Log filters" },
          element(
            "div",
            { className: "log-levels" },
            element("span", { className: "log-filter-label" }, "Levels"),
            ...levelChips,
          ),
          element(
            "div",
            { className: "log-search" },
            element("label", { for: "runtime-log-filter" }, "Filter"),
            filterInput,
          ),
        ),
        filterStatus,
      ),
      sourceHint,
      logError,
      logStatus,
      pane,
      retention,
    ),
  );
  if (logsDenied) {
    showLogError(runtimeErrorText({ status: 403 }, "logs"));
  }
  // Back reuses this view only while what it shows is still readable: the check reads on from
  // where the view stopped, as its polls would, and a refusal rebuilds the page instead
  // (finding 1553). The resumed view takes those answers rather than asking again.
  const logsPath = `${base}/logs?`;
  const forgetCheck = context.onRevalidate?.(async () => {
    checked.clear();
    // A Logs view left for another tab is no longer part of the page.
    if (!context.view?.contains(section)) {
      forgetCheck?.();
      return;
    }
    const reads: string[] = [];
    if (description !== null && !statusDenied) {
      reads.push(base);
    }
    const source = selectedSource();
    if (cursor && !logsDenied && source && readableSelection(source)) {
      const query = logQuery(source, selectedPod());
      query.set("cursor", cursor);
      reads.push(`${logsPath}${query}`);
    }
    // Output that cannot be read on from (no cursor, no readable source, or denied since it
    // showed) is not shown again from the cache.
    if ((rows > 0 || outputRefused) && !reads.some((path) => path.startsWith(logsPath))) {
      throw new Error("The shown output cannot be checked.");
    }
    const answers = await Promise.all(
      reads.map((path) =>
        context.request(path, { revalidate: false }).catch((error: unknown) => {
          // Each refusal is audited: the rebuilt view takes it as known instead of asking again.
          if (requestFailure(error).status === 403) {
            if (path === base) {
              // Not yet compared with a permission answer: the rebuilt view takes its answer.
              deniedStatusViews.set(statusKey, null);
            } else {
              deniedLogViews.add(deniedKey);
            }
          }
          throw error;
        }),
      ),
    );
    reads.forEach((path, index) => checked.set(path, answers[index]));
  });
  // Timers that fired while Back's cache held this view stopped; pick both polls up again.
  // The page Back's check read is shown, followed or not: it is an audited view (finding 1564).
  context.onResume?.(() => {
    if (current()) {
      pane.scrollTop = paneAtBottom ? pane.scrollHeight : paneScrollTop;
      void loadStatus();
      if ([...checked.keys()].some((path) => path.startsWith(logsPath))) {
        void readLogs({ restart: false });
      } else if (following) {
        scheduleFollow(0);
      }
    }
    checked.clear();
  });
  applyFilters();
  void loadStatus()
    .then(() => firstLogRead)
    .catch(() => {})
    .finally(showFirstView);
  return { section, firstView };
}
