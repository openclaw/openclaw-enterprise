import { element } from "../dom.mjs";
import { displayDate } from "./list.mjs";

export const SOURCE_LABELS = {
  gateway: "Gateway",
  agent: "Agent (Harness)",
  sandbox: "Sandbox (policy decisions)",
};
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

export function visibleText(value) {
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

export function podCard(pod) {
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

export function recordRow(record) {
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
  const content = element(
    "span",
    { className: "log-content" },
    element("span", { className: "log-message" }, visibleText(record.message)),
    // A failure code is the point of the line; keep it visible without expanding.
    record.fields?.code === undefined
      ? null
      : element("span", { className: "log-code" }, `code=${visibleText(record.fields.code)}`),
  );
  const summary = element(
    "span",
    { className: "log-line" },
    element("span", { className: "log-time" }, record.time ? displayDate(record.time) : "—"),
    element("span", { className: `log-level log-level-${record.level}` }, record.level),
    element(
      "span",
      { className: "log-origin" },
      element("span", { className: "log-kind" }, record.kind),
      record.subsystem
        ? element("span", { className: "log-subsystem" }, visibleText(record.subsystem))
        : null,
    ),
    content,
  );
  const provenance = record.kind === "sandbox" ? policyProvenance(record.fields) : null;
  if (provenance !== null) {
    content.append(
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
