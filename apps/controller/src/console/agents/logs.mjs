import { element, button } from "../dom.mjs";
import { displayDate, namespacePath } from "./list.mjs";

const STATUS_POLL_MS = 10_000;
const FOLLOW_POLL_MS = 2_000;
const MAX_ROWS = 5_000;
const TAIL_LINES = 200;
// A 403 is audited; remember it for this page session instead of re-asking every poll
// or every time the Logs tab reopens.
const deniedLogViews = new Set();
const deniedStatusViews = new Set();

const SOURCE_LABELS = {
  gateway: "Gateway",
  agent: "Agent (Harness)",
  sandbox: "Sandbox (policy decisions)",
};
const LEVELS = ["error", "warn", "info", "debug", "unknown"];
const GAP_LABELS = {
  stream_replaced: "Container restarted",
  window_exceeded: "Lines skipped",
  cursor_expired: "View resumed",
  truncated: "Page limit reached",
  buffer_lost: "Sandbox buffer lost lines",
};
// What each withheld reason means, followed by the API's reason code as `occ agent logs`
// prints it. `malformed` is mostly a pretty-printed JSON value split across lines (normal
// Codex output), so the text never calls it corrupt.
const WITHHELD_LABELS = {
  unrecognised_structured: "structured output",
  oversized: "oversized",
  malformed: "multi-line, unparseable or deeply nested JSON",
};

// Agent output is attacker-influenced. A bidirectional override (U+202E) would display the
// rest of a line reversed, and zero-width or other invisible characters hide text, so every
// character that is not graphic (the characters `occ agent logs` escapes) shows as an escape.
const HIDDEN_CHARACTER = /[^\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}]/gu;

function visibleText(value) {
  return String(value).replace(HIDDEN_CHARACTER, (character) => {
    const code = character.codePointAt(0);
    return code > 0xffff
      ? `\\U${code.toString(16).padStart(8, "0")}`
      : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

function withheldText({ count, reason }) {
  const label = WITHHELD_LABELS[reason];
  const lines = count === 1 ? "line" : "lines";
  return `${count} ${label ? `${label} ${lines}` : lines} withheld (${reason})`;
}

function runtimeErrorText(error, tier, source) {
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
    return "Too many requests. Waiting before the next read.";
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

function withRequestId(text, error) {
  return error.requestId ? `${text} Request ID: ${error.requestId}` : text;
}

function age(timestamp) {
  const started = Date.parse(timestamp ?? "");
  if (!Number.isFinite(started)) {
    return "Unknown age";
  }
  const minutes = Math.max(0, Math.round((Date.now() - started) / 60_000));
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}

function podCard(pod) {
  const container = pod.containers.find(({ name }) => name === pod.role) ?? pod.containers[0];
  const termination = container?.lastTermination;
  const details = element("dl", { className: "credential-status-list" });
  const add = (name, value) => details.append(element("dt", {}, name), element("dd", {}, value));
  add("Phase", pod.phase);
  add("Ready", pod.ready ? "Yes" : "No");
  add("Restarts", String(container?.restartCount ?? 0));
  if (container && container.state !== "running") {
    add("State", `${container.state}${container.reason ? ` · ${container.reason}` : ""}`);
  }
  if (termination) {
    add(
      "Last termination",
      [
        termination.reason ?? "Unknown reason",
        termination.exitCode === null ? null : `exit ${termination.exitCode}`,
        termination.finishedAt ? displayDate(termination.finishedAt) : null,
      ]
        .filter(Boolean)
        .join(" · "),
    );
  }
  add("Age", age(pod.createdAt));
  const warnings = pod.events.filter(({ type }) => type === "Warning").slice(0, 5);
  // A Ready Pod whose containers are ready and never restarted has recovered from its
  // warnings (typically startup readiness probes or a scheduling retry). Show them as
  // history so a healthy first deploy does not read as a fault.
  const settled =
    pod.ready && pod.containers.every(({ ready, restartCount }) => ready && restartCount === 0);
  return element(
    "article",
    { className: "runtime-pod", "aria-label": `${SOURCE_LABELS[pod.role]} Pod ${pod.name}` },
    element(
      "h4",
      {},
      `${SOURCE_LABELS[pod.role] ?? pod.role}${pod.cluster === "execution" ? " · execution cluster" : ""}`,
    ),
    element("p", { className: "muted" }, pod.name),
    details,
    warnings.length && settled
      ? element(
          "p",
          { className: "muted runtime-events-note" },
          "Earlier warnings. The Pod is Ready now and has not restarted.",
        )
      : null,
    warnings.length
      ? element(
          "ul",
          {
            className: settled ? "runtime-events runtime-events-settled" : "runtime-events",
            "aria-label": settled ? "Earlier warning Events" : "Recent warning Events",
          },
          ...warnings.map((event) =>
            element(
              "li",
              {},
              visibleText(
                `${event.container ? `${event.container} · ` : ""}${event.reason}${event.count > 1 ? ` ×${event.count}` : ""}: ${event.message}`,
              ),
            ),
          ),
        )
      : null,
  );
}

/**
 * Which rule decided a sandbox policy decision (AL3). OpenShell names the rule and its
 * engine on every decision; the policy generation is missing on most paths, so a missing
 * value reads "unknown", never blank. `-` is OpenShell's name for "no rule matched".
 */
function policyProvenance(fields = {}) {
  const decision =
    fields.action !== undefined || fields.rule_name !== undefined || fields.rule_type !== undefined;
  if (!decision) {
    return null;
  }
  const value = (name) =>
    fields[name] === undefined || String(fields[name]) === "" ? "unknown" : String(fields[name]);
  const rule = fields.rule_name === "-" ? "no matching rule" : value("rule_name");
  return `rule ${rule} · engine ${value("rule_type")} · policy generation ${value("policy_generation")}`;
}

// OpenShell records no Agent turn, request or session id, so a sandbox decision can only
// be related to Gateway or Harness lines by time. Never present that as exact (AL6).
const INFERRED_JOIN_LABEL = "Gateway lines: inferred (time window)";
const INFERRED_JOIN_TITLE =
  "OpenShell does not record which Agent turn made this request. Gateway or Harness lines near this time may be related; clocks on different nodes can differ.";

function recordRow(record) {
  if (record.type === "gap") {
    return element(
      "div",
      { className: "log-row log-row-gap", role: "note" },
      element(
        "strong",
        {},
        record.reason === "stream_replaced" && record.stream?.source === "sandbox"
          ? "Sandbox recreated"
          : (GAP_LABELS[record.reason] ?? record.reason),
      ),
      element("span", {}, ` ${record.remedy}`),
    );
  }
  if (record.type === "withheld") {
    return element(
      "div",
      { className: "log-row log-row-withheld", role: "note" },
      withheldText(record),
    );
  }
  const summary = element(
    "span",
    { className: "log-line" },
    element("span", { className: "log-time" }, record.time ? displayDate(record.time) : "—"),
    element("span", { className: `log-level log-level-${record.level}` }, record.level),
    element("span", { className: "log-kind" }, record.kind),
    record.subsystem
      ? element("span", { className: "log-subsystem" }, visibleText(record.subsystem))
      : null,
    element("span", { className: "log-message" }, visibleText(record.message)),
    // A failure code is the point of the line; keep it visible without expanding.
    record.fields?.code === undefined
      ? null
      : element("span", { className: "log-code" }, `code=${visibleText(record.fields.code)}`),
  );
  const provenance = record.kind === "sandbox" ? policyProvenance(record.fields) : null;
  if (provenance !== null) {
    summary.append(
      element("span", { className: "log-provenance" }, visibleText(provenance)),
      element("span", { className: "log-join", title: INFERRED_JOIN_TITLE }, INFERRED_JOIN_LABEL),
    );
  }
  let row;
  if (!record.fields || Object.keys(record.fields).length === 0) {
    row = element("div", { className: "log-row" }, summary);
  } else {
    const fields = element("dl", { className: "log-fields" });
    for (const [name, value] of Object.entries(record.fields)) {
      fields.append(element("dt", {}, visibleText(name)), element("dd", {}, visibleText(value)));
    }
    row = element("details", { className: "log-row" }, element("summary", {}, summary), fields);
  }
  // Filters match only lines; gap and withheld rows always stay visible.
  row.dataset.level = record.level;
  row.dataset.search = visibleText(
    [
      record.kind,
      record.subsystem ?? "",
      record.message,
      ...Object.entries(record.fields ?? {}).map(([name, value]) => `${name}=${value}`),
    ].join(" "),
  ).toLowerCase();
  return row;
}

/**
 * Runtime status needs Agent `operate`; log text needs only `read_logs`. Without status
 * the picker offers every source and names no Pod: OCC reads the source's current Pod
 * and a view's cursor keeps following it.
 */
function unobservedDescription() {
  return {
    observedAt: null,
    pods: [],
    sources: ["gateway", "agent", "sandbox"].map((id) => ({
      id,
      kind: id === "sandbox" ? "sandbox" : "container",
      pods: [],
      available: true,
      retention: "",
    })),
  };
}

function downloadFileName(agentId, revisionId, source, pod) {
  return `${[agentId, revisionId, source, pod].join("-").replace(/[^A-Za-z0-9_.-]/g, "_")}.log`;
}

/** Logs tab: runtime status strip, source picker, bounded log pane and follow. */
export function renderAgentLogs(context, { agent, revisionId }) {
  const base = `${namespacePath(context.namespaceId)}/agents/${encodeURIComponent(agent.id)}/deployments/${encodeURIComponent(revisionId)}/runtime`;
  // Denials are per signed-in operator: another user signing in on this tab asks again.
  const deniedKey = JSON.stringify([context.operatorId ?? null, context.namespaceId, agent.id]);
  const statusKey = JSON.stringify([
    context.operatorId ?? null,
    context.namespaceId,
    agent.id,
    revisionId,
  ]);
  const section = element("section", { className: "agent-logs" });
  const strip = element("div", { className: "runtime-strip", "aria-live": "polite" });
  const stripStatus = element(
    "p",
    { className: "muted", role: "status" },
    "Loading runtime status…",
  );
  const sourceSelect = element("select", { id: "runtime-log-source", disabled: true });
  const podSelect = element("select", { id: "runtime-log-pod", hidden: true });
  const podLabel = element("label", { for: "runtime-log-pod", hidden: true }, "Pod");
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
    disabled: true,
  });
  const refreshButton = button("Refresh logs", () => void readLogs({ restart: true }), {
    disabled: true,
  });
  const downloadButton = button("Download", () => void download(), { disabled: true });
  const hiddenLevels = new Set();
  const levelChips = LEVELS.map((level) =>
    button(
      level,
      (event) => {
        const chip = event.currentTarget;
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
  const filterStatus = element("p", { className: "hint", role: "status" });
  const retention = element("p", { className: "hint" });
  const sourceHint = element("p", { className: "hint", role: "note", hidden: true });
  const logStatus = element("p", { className: "muted", role: "status" });
  const logError = element("p", { className: "error", role: "alert", hidden: true });
  const pane = element("div", {
    className: "log-pane",
    role: "log",
    tabindex: "0",
    "aria-label": "Runtime log output",
  });
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

  let description = null;
  let cursor = null;
  let following = false;
  let followTimer;
  let statusTimer;
  let reading = false;
  // A source, Pod or instance change while a read is in flight restarts the view after it.
  let restartPending = false;
  let rows = 0;
  let logsDenied = deniedLogViews.has(deniedKey);
  // Set when runtime status is denied; the last page's stream stands in for the Pod list.
  let statusDenied = false;
  let lastStream = null;

  const current = () => context.isCurrent();
  // Runtime reads are live and audited: a view restored by Back resumes them instead of
  // having the console replay every one of them to revalidate the cached view.
  const read = (path, options = {}) => context.request(path, { ...options, revalidate: false });

  function selectedSource() {
    return description?.sources.find(({ id }) => id === sourceSelect.value);
  }

  function selectedPod() {
    const source = selectedSource();
    return source?.pods.find(({ name }) => name === podSelect.value) ?? source?.pods[0];
  }

  // A sandbox source has no Pods: OCC derives the Sandbox from the revision.
  function readableSelection() {
    const source = selectedSource();
    return Boolean(source) && (source.kind === "sandbox" || statusDenied || Boolean(selectedPod()));
  }

  function logQuery(source, pod) {
    const query = new URLSearchParams({ source: source.id });
    if (source.kind !== "sandbox" && pod) {
      query.set("pod", pod.name);
    }
    if (previous.checked) {
      query.set("previous", "true");
    }
    if (!includeDebug.checked) {
      query.set("minLevel", "info");
    }
    return query;
  }

  function showLogError(text) {
    logError.hidden = text === null;
    logError.textContent = text ?? "";
  }

  function renderStrip() {
    if (!description) {
      return;
    }
    stripStatus.textContent = `Observed ${displayDate(description.observedAt)}`;
    strip.replaceChildren(
      ...(description.pods.length
        ? description.pods.map(podCard)
        : [
            element(
              "p",
              { className: "muted" },
              "This version has no running Pod. See Deployment activity.",
            ),
          ]),
    );
  }

  function renderPickers() {
    const chosen = sourceSelect.value;
    sourceSelect.replaceChildren(
      ...description.sources.map((source) =>
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
    podSelect.replaceChildren(
      ...(source?.pods ?? []).map((pod) => element("option", { value: pod.name }, pod.name)),
    );
    podSelect.hidden = (source?.pods.length ?? 0) <= 1;
    podLabel.hidden = podSelect.hidden;
    if (source?.pods.some(({ name }) => name === chosenPod)) {
      podSelect.value = chosenPod;
    }
    retention.textContent = source?.retention ?? "";
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
    sourceHint.textContent = !harnessDown
      ? ""
      : harnessPods.length === 0
        ? "The Agent (Harness) has no Pod yet. Gateway errors that fail to reach it, such as ECONNREFUSED, are a symptom: see Deployment activity for why it has not started."
        : "The Agent (Harness) Pod is not ready. Gateway errors that fail to reach it, such as ECONNREFUSED, are a symptom: read the Agent (Harness) source for the cause.";
    const pod = selectedPod();
    const restarts = pod
      ? pod.restartCount
      : statusDenied && lastStream?.source === source?.id
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

  // Status is denied, but log text has its own grant: offer the log reads anyway.
  function offerLogsWithoutStatus() {
    if (description !== null) {
      return;
    }
    statusDenied = true;
    description = unobservedDescription();
    renderPickers();
    if (!logsDenied) {
      void readLogs({ restart: true });
    }
  }

  async function loadStatus() {
    clearTimeout(statusTimer);
    if (!current()) {
      return;
    }
    if (deniedStatusViews.has(statusKey)) {
      stripStatus.textContent = runtimeErrorText({ status: 403 }, "status");
      offerLogsWithoutStatus();
      return;
    }
    if (!document.hidden) {
      try {
        const first = description === null;
        description = await read(base);
        if (!current()) {
          return;
        }
        renderStrip();
        renderPickers();
        if (first && !logsDenied) {
          void readLogs({ restart: true });
        }
      } catch (error) {
        if (!current()) {
          return;
        }
        if (error.status === 401) {
          context.onExpired();
          return;
        }
        stripStatus.textContent = withRequestId(runtimeErrorText(error, "status"), error);
        if (error.status === 403) {
          offerLogsWithoutStatus();
        }
        // Authorization and support failures do not change on their own.
        if ([403, 404, 501].includes(error.status)) {
          if (error.status === 403) {
            deniedStatusViews.add(statusKey);
          }
          return;
        }
      }
    }
    statusTimer = setTimeout(() => void loadStatus(), STATUS_POLL_MS);
  }

  function rowVisible(row) {
    if (row.dataset.level === undefined) {
      return true;
    }
    // Rows hold escaped text, so a pasted line with an invisible character still matches.
    const text = visibleText(filterInput.value.trim()).toLowerCase();
    return (
      !hiddenLevels.has(row.dataset.level) && (text === "" || row.dataset.search.includes(text))
    );
  }

  // Client-side only: filters narrow the rows already loaded, never the server read.
  function applyFilters() {
    let lines = 0;
    let shown = 0;
    for (const row of pane.children) {
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

  function appendRecords(records) {
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

  // A download is its own audited read of the last 1000 lines through the session.
  async function download() {
    const source = selectedSource();
    const pod = selectedPod();
    if (!current() || logsDenied || !readableSelection()) {
      return;
    }
    const query = logQuery(source, pod);
    query.set("download", "true");
    downloadButton.disabled = true;
    try {
      const text = await read(`${base}/logs?${query}`, { responseType: "text" });
      if (!current()) {
        return;
      }
      if (typeof text !== "string") {
        // Never save a JSON envelope (or "[object Object]") as the log file.
        throw new Error("The log download did not return text.");
      }
      showLogError(null);
      const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
      const link = element("a", {
        href: url,
        download: downloadFileName(agent.id, revisionId, source.id, pod?.name ?? source.id),
        hidden: true,
      });
      section.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      if (!current()) {
        return;
      }
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      showLogError(withRequestId(runtimeErrorText(error, "logs", source.id), error));
    } finally {
      downloadButton.disabled = logsDenied || !readableSelection();
    }
  }

  function setFollow(next) {
    following = next && !logsDenied && !previous.checked;
    followButton.setAttribute("aria-pressed", String(following));
    followButton.textContent = following ? "Following" : "Follow";
    clearTimeout(followTimer);
    if (following) {
      scheduleFollow(FOLLOW_POLL_MS);
    }
  }

  function scheduleFollow(delay) {
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

  async function readLogs({ restart }) {
    const source = selectedSource();
    const pod = selectedPod();
    if (reading && restart) {
      restartPending = true;
      return;
    }
    if (!current() || reading || logsDenied || !readableSelection()) {
      if (source && !readableSelection()) {
        logStatus.textContent = "This version has no running Pod for this source.";
      }
      return;
    }
    reading = true;
    if (restart) {
      cursor = null;
      pane.replaceChildren();
      rows = 0;
      logStatus.textContent = "Reading output…";
    }
    const query = logQuery(source, pod);
    if (restart) {
      query.set("tailLines", String(TAIL_LINES));
    }
    if (cursor) {
      query.set("cursor", cursor);
    }
    let retryAfter = FOLLOW_POLL_MS;
    try {
      const page = await read(`${base}/logs?${query}`);
      if (!current() || restartPending) {
        return;
      }
      showLogError(null);
      cursor = page.cursor;
      appendRecords(page.records);
      if (statusDenied && page.stream) {
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
      }
    } catch (error) {
      if (!current() || (restartPending && error.status !== 401)) {
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
      }
      showLogError(withRequestId(runtimeErrorText(error, "logs", source.id), error));
      if (error.status === 403) {
        // Never re-poll after a denial; the view needs new grants.
        logsDenied = true;
        deniedLogViews.add(deniedKey);
        setFollow(false);
        renderPickers();
      } else if (error.status === 501) {
        setFollow(false);
      } else {
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
    stripStatus,
    strip,
    element("h3", {}, "Logs"),
    element(
      "p",
      { className: "muted" },
      "Operational output and sandbox policy decisions only: credential-shaped text is masked and structured payloads, prompts and protocol traffic are withheld. Nothing here is stored.",
    ),
    element(
      "div",
      { className: "log-toolbar" },
      element("label", { for: "runtime-log-source" }, "Source"),
      sourceSelect,
      podLabel,
      podSelect,
      element("label", { className: "checkbox" }, previous, " Previous instance"),
      element("label", { className: "checkbox" }, includeDebug, " Include debug"),
      followButton,
      refreshButton,
      downloadButton,
    ),
    element(
      "div",
      { className: "log-toolbar", role: "group", "aria-label": "Log filters" },
      element("span", { className: "muted" }, "Levels"),
      ...levelChips,
      element("label", { for: "runtime-log-filter" }, "Filter"),
      filterInput,
    ),
    filterStatus,
    retention,
    sourceHint,
    logStatus,
    logError,
    pane,
  );
  if (logsDenied) {
    showLogError(runtimeErrorText({ status: 403 }, "logs"));
  }
  // Timers that fired while Back's cache held this view stopped; pick both polls up again.
  context.onResume?.(() => {
    if (current()) {
      pane.scrollTop = paneAtBottom ? pane.scrollHeight : paneScrollTop;
      void loadStatus();
      if (following) {
        scheduleFollow(0);
      }
    }
  });
  applyFilters();
  void loadStatus();
  return section;
}
