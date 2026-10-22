import type {
  Agent,
  AgentRuntimeLogPageWire,
  DriverConfigurationDescriptor,
  JSONSchema,
  RuntimeLogRecord,
  SandboxNetworkGrant,
  SandboxPolicyRecommendations,
  SandboxPolicyViewWire,
} from "@openclaw-enterprise/contracts";
import { requestErrorDetails, requestFailure, responseFields } from "../api-client.mjs";
import { sameValue } from "../carry.mjs";
import {
  configurationFields,
  configurationErrors,
  configurationAction,
} from "../configuration-fields.mjs";
import { button, dismissOnBackdrop, element } from "../dom.mjs";
import type { NamespacePageContext } from "../namespaces.mjs";
import { namespacePath, rejectionMessage } from "./list.mjs";
import { recordRow, visibleText } from "./logs-view.mjs";

type Policy = SandboxPolicyViewWire["policy"];
type LogLine = Extract<RuntimeLogRecord, { type: "line" }>;

function errorText(cause: unknown, subject: string) {
  const { status, serverMessage } = requestFailure(cause);
  if (status === 403) {
    return `You do not have permission to ${subject}.`;
  }
  if (status === 409 && serverMessage) {
    return serverMessage;
  }
  return rejectionMessage(cause);
}

function grantText(grant: SandboxNetworkGrant) {
  const ports = grant.ports
    .map(({ from, to }) => (from === to ? String(from) : `${from}–${to}`))
    .join(", ");
  return `${visibleText(grant.binary)} → ${visibleText(grant.host)}:${ports}`;
}

// Review the rules returned by validation, including any normalization. The controller owns admission.
function readableRules(value: unknown): value is SandboxNetworkGrant[] {
  return (
    Array.isArray(value) &&
    value.every((item: unknown) => {
      const { id, binary, host, ports } = responseFields(item);
      return (
        typeof id === "string" &&
        typeof binary === "string" &&
        typeof host === "string" &&
        Array.isArray(ports) &&
        ports.length > 0 &&
        ports.every((port: unknown) => {
          const { from, to } = responseFields(port);
          return Number.isSafeInteger(from) && Number.isSafeInteger(to);
        })
      );
    })
  );
}

function denialGrant(record: LogLine): SandboxNetworkGrant | undefined {
  const binary = record.decision?.binary ?? record.fields?.binary;
  const host = record.decision?.host ?? record.fields?.dst_host;
  const port = Number(record.decision?.port ?? record.fields?.dst_port);
  if (
    typeof binary !== "string" ||
    !binary.startsWith("/") ||
    typeof host !== "string" ||
    !host ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    return undefined;
  }
  return { id: `network-${crypto.randomUUID()}`, binary, host, ports: [{ from: port, to: port }] };
}

function grantKey(grant: SandboxNetworkGrant) {
  return JSON.stringify([
    grant.binary,
    grant.host,
    [...grant.ports].sort((a, b) => a.from - b.from || a.to - b.to),
  ]);
}

function grantCovered(grant: SandboxNetworkGrant, existing: readonly SandboxNetworkGrant[]) {
  return existing.some(
    (rule) =>
      rule.binary === grant.binary &&
      rule.host === grant.host &&
      grant.ports.every((port) =>
        rule.ports.some((range) => range.from <= port.from && range.to >= port.to),
      ),
  );
}

function pagination(total: number, page: number, size: number, change: (page: number) => void) {
  const pages = Math.max(1, Math.ceil(total / size));
  return element(
    "nav",
    { className: "sandbox-pagination", "aria-label": "Pages" },
    element(
      "span",
      { className: "muted" },
      total ? `${(page - 1) * size + 1}–${Math.min(page * size, total)} of ${total}` : "0 results",
    ),
    element(
      "div",
      { className: "sandbox-page-actions" },
      button("Previous", () => change(page - 1), { size: "sm", disabled: page <= 1 }),
      element("span", {}, `Page ${page} of ${pages}`),
      button("Next", () => change(page + 1), { size: "sm", disabled: page >= pages }),
    ),
  );
}

function ruleList(rules: readonly unknown[], actions?: (index: number) => Node) {
  const root = element("div", { className: "sandbox-rule-collection" });
  let page = 1;
  const search = element("input", {
    type: "search",
    "aria-label": "Search network rules",
    placeholder: "Search executable or destination",
  });
  const rows = element("div", { className: "sandbox-rule-table" });
  const pager = element("div");
  function render() {
    const query = search.value.trim().toLowerCase();
    const filtered = rules
      .map((value, index) => {
        const fields = responseFields(value);
        const rule = {
          id: typeof fields.id === "string" ? fields.id : "",
          binary: typeof fields.binary === "string" ? fields.binary : "Executable not set",
          host: typeof fields.host === "string" ? fields.host : "Destination not set",
          ports: Array.isArray(fields.ports)
            ? fields.ports.filter(
                (port): port is { from: number; to: number } =>
                  typeof port === "object" &&
                  port !== null &&
                  Number.isSafeInteger(port.from) &&
                  Number.isSafeInteger(port.to),
              )
            : [],
        };
        return { rule, index };
      })
      .filter(({ rule }) => grantText(rule).toLowerCase().includes(query));
    page = Math.max(1, Math.min(page, Math.ceil(filtered.length / 5)));
    rows.replaceChildren(
      element(
        "div",
        { className: "sandbox-rule-row sandbox-table-heading", "aria-hidden": "true" },
        element("span", {}, "Executable"),
        element("span", {}, "Destination"),
        element("span"),
      ),
      ...filtered
        .slice((page - 1) * 5, page * 5)
        .map(({ rule, index }) =>
          element(
            "div",
            { className: "sandbox-rule-row" },
            element("span", { className: "resource-id" }, visibleText(rule.binary)),
            element(
              "span",
              { className: "resource-id" },
              visibleText(rule.host) +
                ":" +
                rule.ports
                  .map(({ from, to }) => (from === to ? String(from) : `${from}–${to}`))
                  .join(", "),
            ),
            actions?.(index),
          ),
        ),
      ...(filtered.length
        ? []
        : [
            element(
              "p",
              { className: "muted" },
              query ? "No network rules match this search." : "No explicit network rules yet.",
            ),
          ]),
    );
    pager.replaceChildren(
      pagination(filtered.length, page, 5, (next) => {
        page = next;
        render();
      }),
    );
  }
  search.addEventListener("input", () => {
    page = 1;
    render();
  });
  root.append(search, rows, pager);
  render();
  return root;
}

/** Logs, recommendations, and policy editing keep independent permissions and availability. */
export function renderAgentSandboxPolicy(
  context: Pick<NamespacePageContext, "request" | "isCurrent">,
  {
    agent,
    revisionId,
    descriptor,
  }: {
    agent: Pick<Agent, "id" | "namespaceId" | "activeRevisionId" | "desiredRuntimeState">;
    revisionId: string;
    descriptor?: DriverConfigurationDescriptor;
  },
) {
  const path = `${namespacePath(agent.namespaceId)}/agents/${encodeURIComponent(agent.id)}`;
  // Discovery can omit an unreadable or unsupported owner. This read still establishes
  // capability or its permission refusal; logs and suggestions keep their own authority.
  const policyPath = descriptor
    ? configurationAction(descriptor, "read").href
    : `${path}/sandbox-policy/networking`;
  const section = element("section", { className: "sandbox-policy" });
  const policyCard = element("section", { className: "agent-card sandbox-network-card" });
  const policySummary = element("div");
  const policyPanel = element("section", { className: "sandbox-policy-editor" });
  const dialogTitle = element("h2", { id: "sandbox-policy-dialog-title" }, "Manage network rules");
  const dialog = element("dialog", {
    className: "dialog dialog--wide dialog--framed sandbox-policy-dialog",
    "aria-labelledby": dialogTitle.id,
  });
  const dialogBody = element("div", { className: "dialog-body" }, policyPanel);
  let dialogInvoker: HTMLElement | undefined;
  const closeDialog = () => {
    if (!mutation) {
      dialog.close();
    }
  };
  const dialogActions = element("div", { className: "dialog-actions" });
  dialog.append(
    element(
      "div",
      { className: "dialog-header" },
      dialogTitle,
      button("×", closeDialog, { tone: "ghost", "aria-label": "Close network rules" }),
    ),
    dialogBody,
    dialogActions,
  );
  dismissOnBackdrop(dialog);
  dialog.addEventListener("cancel", (event) => {
    if (mutation) {
      event.preventDefault();
    }
  });
  dialog.addEventListener("close", () => {
    if (current()) {
      renderPolicy();
      (dialogInvoker?.isConnected ? dialogInvoker : manageButton).focus();
    }
  });
  let editorIndex: number | undefined;
  let editingRules = false;
  let reviewSummary = "";
  const manageButton = button("Manage rules", () => openPolicyDialog());
  function openPolicyDialog(index?: number) {
    dialogInvoker =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    editorIndex = index;
    editingRules = index !== undefined;
    renderEditor();
    if (!dialog.open) {
      dialog.showModal();
    }
  }
  const suggestions = element("section", { className: "agent-card" });
  const logStatus = element("p", { role: "status" }, "Loading policy denials…");
  const logWindowStatus = element("p", { className: "hint" });
  const logWarnings = element("p", { className: "notice", role: "status", hidden: true });
  let withheldRecords = 0;
  let truncatedWindow = false;
  const logRows = element("div", { className: "sandbox-decisions" });
  const logNotices = element("div", { className: "sandbox-log-notices" });
  const logPager = element("div");
  const selection = element("div", { className: "sandbox-selection" });
  const selected = new Set<LogLine>();
  const expanded = new Set<LogLine>();
  let visibleDenials: LogLine[] = [];
  let displayedRecords: RuntimeLogRecord[] = [];
  let logPage = 1;
  let logPageSize = 5;
  const selectionCount = element("span", { role: "status" });
  const selectPage = element("input", { type: "checkbox", "aria-label": "Select page" });
  const selectPageText = element("span", {}, "Select page");
  const allowSelected = button(
    "Allow selected",
    () => {
      const grants = [...selected].map(denialGrant).filter((grant) => grant !== undefined);
      stageGrants(grants, true);
    },
    { tone: "primary", size: "sm" },
  );
  const selectionActions = element(
    "div",
    { className: "sandbox-selection-actions", hidden: true },
    selectionCount,
    button(
      "Clear",
      () => {
        selected.clear();
        renderLogs();
      },
      { tone: "link", size: "sm" },
    ),
    allowSelected,
  );
  selectPage.addEventListener("change", () => {
    for (const record of visibleDenials) {
      if (denialGrant(record)) {
        if (selectPage.checked) {
          selected.add(record);
        } else {
          selected.delete(record);
        }
      }
    }
    renderLogs();
  });
  selection.append(element("label", {}, selectPage, selectPageText), selectionActions);
  const newDenials = button(
    "Show newest",
    () => {
      displayedRecords = [...records];
      for (const record of selected) {
        if (!displayedRecords.includes(record)) {
          selected.delete(record);
        }
      }
      logPage = 1;
      filter.value = "";
      renderLogs();
      updateNewDenials();
    },
    { className: "sandbox-new-denials", hidden: true },
  );
  const count = element("p", { className: "sandbox-denial-count" }, "— in loaded window");
  const follow = element("input", { type: "checkbox", "aria-label": "Follow policy denials" });
  const feedback = element("p", { role: "status", tabindex: "-1" });
  const suggestionStatus = element("p", { role: "status" }, "Loading policy suggestions…");
  const filter = element("input", {
    type: "search",
    placeholder: "Search executable, destination, or reason",
    "aria-label": "Filter loaded denials",
  });
  let view: SandboxPolicyViewWire | undefined;
  let validationDetails: Readonly<ReturnType<typeof requestErrorDetails>> = [];
  let draftGeneration = 0;
  let previewSequence = 0;
  let policyReadSequence = 0;
  let records: RuntimeLogRecord[] = [];
  let cursor: AgentRuntimeLogPageWire["cursor"] = null;
  let reading = false;
  let logsLoaded = false;
  let mutation = false;
  let unknownOutcome = false;
  let editDenied = false;
  let policyReadUnavailable = false;
  // The schema editor can produce an incomplete or invalid draft. The policy owner validates it.
  let additions: unknown = [];
  let recommendations: SandboxPolicyRecommendations["recommendations"] = [];
  let suggestionsReading = false;
  // A permission refusal is not retried from here: the same request gets the same answer.
  let suggestionsDenied = false;
  // The first policy read says whether the Sandbox Driver supports per-Agent network policy.
  // Without it there is no Sandbox log source and no suggestions, so the tab says so once instead
  // of reading both, showing their refusals and offering an editor (finding 2060). A refused or
  // failed policy read leaves the logs and suggestions to their own permissions.
  async function policySupported() {
    await firstPolicyRead;
    if (!current()) {
      return false;
    }
    if (view?.capability === null) {
      section.replaceChildren(
        element("h2", {}, "Policy denials"),
        element(
          "p",
          { role: "status" },
          "This Sandbox Driver does not support per-Agent network policy. Policy denials, suggestions and Agent network rules are not available for this Agent.",
        ),
      );
      return false;
    }
    return true;
  }
  let logTimer: number | undefined;
  let suggestionTimer: number | undefined;
  let policyTimer: number | undefined;
  const current = () => context.isCurrent();
  const protectedExecution = () => view?.protectedExecution === true;
  const hasEditAuthority = () =>
    view?.configuration?.actions?.save?.available &&
    view?.editingEnabled &&
    view.capability &&
    view.policy.application?.state !== "pending" &&
    !editDenied &&
    !policyReadUnavailable &&
    !unknownOutcome;
  const canEdit = () => !mutation && hasEditAuthority();
  const editable = () => canEdit() && !protectedExecution();
  // Save-then-apply owns an active mutation, but must recheck all policy authority.
  const canApplySavedPolicy = () =>
    current() &&
    hasEditAuthority() &&
    !protectedExecution() &&
    view?.configuration?.actions.apply?.available &&
    view.capability?.live &&
    agent.activeRevisionId === revisionId &&
    agent.desiredRuntimeState === "running";

  function denied(record: RuntimeLogRecord): record is LogLine {
    return (
      record.type === "line" &&
      (record.decision?.decision === "denied" || record.fields?.action === "DENIED")
    );
  }

  function updateNewDenials() {
    const pending = records.filter((record) => !displayedRecords.includes(record));
    newDenials.hidden = pending.length === 0;
    const denials = pending.filter(denied).length;
    newDenials.textContent = denials
      ? `${denials} new denials · Show newest`
      : "New log notices · Show newest";
  }

  function renderSelection() {
    const selectable = visibleDenials.filter((record) => denialGrant(record));
    const checked = selectable.filter((record) => selected.has(record)).length;
    selectPage.checked = selectable.length > 0 && checked === selectable.length;
    selectPage.indeterminate = checked > 0 && checked < selectable.length;
    selectPage.disabled = !editable() || selectable.length === 0;
    selectPageText.textContent = `Select page (${selectable.length})`;
    selectionActions.hidden = selected.size === 0;
    const elsewhere = [...selected].filter((record) => !visibleDenials.includes(record)).length;
    selectionCount.textContent = `${selected.size} selected${elsewhere ? ` · ${elsewhere} outside this page` : ""}`;
    allowSelected.textContent = `Allow selected (${selected.size})`;
    allowSelected.disabled = !editable();
  }

  function decisionRow(record: LogLine) {
    const grant = denialGrant(record);
    const decision = record.decision;
    const fields = record.fields ?? {};
    const binary = decision?.binary ?? fields.binary;
    const host = decision?.host ?? fields.dst_host;
    const port = decision?.port ?? fields.dst_port;
    const reason = decision?.reason ?? fields.reason;
    const checkbox = element("input", {
      type: "checkbox",
      checked: selected.has(record),
      disabled: !editable() || !grant,
      "aria-label": `Select denial ${visibleText(record.time ?? "time unknown")} ${visibleText(binary ?? "unknown executable")} to ${visibleText(host ?? "unknown destination")}${port ? `:${visibleText(port)}` : ""}`,
    });
    const row = element("article", { className: "sandbox-decision" });
    row.classList.toggle("is-selected", selected.has(record));
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        selected.add(record);
      } else {
        selected.delete(record);
      }
      row.classList.toggle("is-selected", checkbox.checked);
      renderSelection();
    });
    const details = element(
      "section",
      { className: "sandbox-decision-details", hidden: !expanded.has(record) },
      element(
        "p",
        { className: "muted" },
        `Executable path: ${visibleText(binary ?? "Unknown executable")} · Enforcement: ${visibleText(decision?.enforcement ?? "unknown")} · Rule: ${visibleText(decision?.rule ?? fields.rule_name ?? "unknown")} · Engine: ${visibleText(decision?.engine ?? fields.rule_type ?? "unknown")} · Policy generation: ${visibleText(decision?.policyGeneration ?? fields.policy_generation ?? "unknown")}`,
      ),
      element("details", {}, element("summary", {}, "Sanitized Sandbox log"), recordRow(record)),
    );
    const toggle = button(
      "›",
      () => {
        details.hidden = !details.hidden;
        toggle.setAttribute("aria-expanded", String(!details.hidden));
        if (details.hidden) {
          expanded.delete(record);
        } else {
          expanded.add(record);
        }
      },
      {
        className: "sandbox-decision-toggle",
        "aria-label": "Show denial details",
        "aria-expanded": String(expanded.has(record)),
      },
    );
    const time =
      record.time && !Number.isNaN(Date.parse(record.time))
        ? new Date(record.time).toLocaleTimeString()
        : "Unknown";
    row.append(
      element(
        "div",
        { className: "sandbox-denial-row" },
        element("label", { className: "sandbox-denial-select" }, checkbox),
        toggle,
        element(
          "span",
          { className: "sandbox-denial-time", title: record.time ?? "Time not reported" },
          time,
        ),
        element(
          "span",
          {
            className: "resource-id sandbox-denial-binary",
            title: visibleText(binary ?? "Unknown executable"),
          },
          visibleText(typeof binary === "string" ? binary.split("/").at(-1) : "Unknown executable"),
        ),
        element(
          "span",
          { className: "resource-id sandbox-denial-destination" },
          `${visibleText(host ?? "Unknown destination")}${port ? `:${visibleText(port)}` : ""}`,
        ),
        element(
          "span",
          { className: "sandbox-denial-reason" },
          visibleText(reason ?? "Reason not reported"),
        ),
        editable() && grant
          ? button("Allow this", () => prefill(grant), { tone: "link", size: "sm" })
          : element("span"),
      ),
      details,
    );
    return row;
  }

  function renderLogs() {
    if (!logsLoaded) {
      return;
    }
    const denials = displayedRecords.filter(denied).reverse();
    count.textContent = `${denials.length} in loaded window`;
    const query = filter.value.trim().toLowerCase();
    const shown = query
      ? denials.filter((record) =>
          JSON.stringify([record.message, record.decision, record.fields])
            .toLowerCase()
            .includes(query),
        )
      : denials;
    logPage = Math.max(1, Math.min(logPage, Math.ceil(shown.length / logPageSize)));
    visibleDenials = shown.slice((logPage - 1) * logPageSize, logPage * logPageSize);
    const unclassified = displayedRecords.filter(
      (record) =>
        record.type === "line" &&
        record.decision === undefined &&
        record.fields?.action === undefined,
    ).length;
    logNotices.replaceChildren(
      ...displayedRecords.filter((record) => record.type !== "line").map(recordRow),
      ...(unclassified
        ? [
            element(
              "p",
              { className: "muted" },
              `${unclassified} other records have no decision metadata. Inspect Sandbox logs for additional context.`,
            ),
          ]
        : []),
    );
    logRows.replaceChildren(
      element(
        "div",
        { className: "sandbox-denial-row sandbox-table-heading", "aria-hidden": "true" },
        element("span"),
        element("span"),
        element("span", {}, "Time"),
        element("span", {}, "Executable"),
        element("span", {}, "Destination"),
        element("span", {}, "Reason"),
        element("span"),
      ),
      ...visibleDenials.map(decisionRow),
      ...(shown.length
        ? []
        : [
            element(
              "p",
              { className: "muted" },
              denials.length ? "No denials match this filter." : "No denials in this window.",
            ),
          ]),
    );
    const size = element(
      "select",
      { "aria-label": "Rows per page" },
      ...[5, 20, 50].map((value) =>
        element("option", { value, selected: value === logPageSize }, String(value)),
      ),
    );
    size.addEventListener("change", () => {
      logPageSize = Number(size.value);
      logPage = 1;
      renderLogs();
    });
    const pager = pagination(shown.length, logPage, logPageSize, (page) => {
      logPage = page;
      renderLogs();
    });
    pager
      .querySelector("span")
      ?.append(document.createTextNode(query ? " matching denials" : " loaded denials"));
    pager.insertBefore(element("label", {}, "Rows per page", size), pager.lastChild);
    logPager.replaceChildren(pager);
    renderSelection();
  }

  async function readLogs(restart = false) {
    if (!current() || reading || revisionId === "draft") {
      return;
    }
    if (!(await policySupported()) || reading) {
      return;
    }
    clearTimeout(logTimer);
    reading = true;
    if (restart) {
      // Keep the inspected window until the fresh read succeeds.
      logStatus.hidden = false;
      logStatus.textContent = "Loading policy denials…";
    }
    try {
      const query = new URLSearchParams({
        source: "sandbox",
        tailLines: "1000",
        ...(!restart && cursor ? { cursor } : {}),
      });
      const page = (await context.request(
        `${path}/deployments/${encodeURIComponent(revisionId)}/runtime/logs?${query}`,
      )) as AgentRuntimeLogPageWire;
      if (!current()) {
        return;
      }
      const firstRead = !logsLoaded;
      logsLoaded = true;
      records = [...(restart ? [] : records), ...page.records].slice(-1000);
      if (restart || firstRead) {
        displayedRecords = [...records];
        selected.clear();
        expanded.clear();
        logPage = 1;
      }
      cursor = page.cursor;
      withheldRecords = (restart ? 0 : withheldRecords) + page.withheld;
      truncatedWindow = (restart ? false : truncatedWindow) || page.truncated;
      logWarnings.hidden = withheldRecords === 0 && !truncatedWindow;
      logWarnings.textContent = [
        withheldRecords ? `${withheldRecords} records withheld since the last refresh.` : "",
        truncatedWindow ? "Some log output was truncated. This window is incomplete." : "",
      ]
        .filter(Boolean)
        .join(" ");
      logStatus.hidden = true;
      logWindowStatus.textContent = `Loaded ${records.filter(({ type }) => type === "line").length} records. One action may produce several denial records. Log retention and gaps limit this window.${page.withheld ? ` ${page.withheld} records withheld in the latest read.` : ""}${page.truncated ? " The latest read was truncated." : ""}`;
      if (restart || firstRead) {
        renderLogs();
      }
      updateNewDenials();
    } catch (error) {
      if (!current()) {
        return;
      }
      follow.checked = false;
      logStatus.hidden = false;
      logStatus.textContent = errorText(error, "read this Agent’s Sandbox logs");
      if (records.length === 0) {
        count.textContent = "Denials in the loaded window: unavailable";
        logRows.replaceChildren();
      }
    } finally {
      reading = false;
      if (current() && follow.checked) {
        logTimer = setTimeout(() => {
          if (follow.checked) {
            void readLogs();
          }
        }, 3000);
      }
    }
  }

  function hasProposedChanges() {
    return JSON.stringify(additions) !== JSON.stringify(view?.policy.additions);
  }

  function stageGrants(grants: SandboxNetworkGrant[], batch: boolean) {
    if (!editable()) {
      return;
    }
    if (!readableRules(additions)) {
      openPolicyDialog();
      feedback.textContent =
        "Finish or remove the incomplete draft rules, then allow these denials.";
      feedback.className = "error";
      feedback.setAttribute("role", "alert");
      feedback.focus({ preventScroll: true });
      return;
    }
    const distinct = [...new Map(grants.map((grant) => [grantKey(grant), grant])).values()];
    const existing = additions;
    const fresh = distinct.filter((grant) => !grantCovered(grant, existing));
    reviewSummary = `${grants.length} selected denial${grants.length === 1 ? "" : "s"} · ${distinct.length} distinct request${distinct.length === 1 ? "" : "s"} · ${fresh.length} new rule${fresh.length === 1 ? "" : "s"}`;
    const index = additions.length;
    additions.push(...structuredClone(fresh));
    draftGeneration += 1;
    validationDetails = [];
    openPolicyDialog(!batch && fresh.length ? index : undefined);
    feedback.className = "";
    feedback.setAttribute("role", "status");
    feedback.textContent = fresh.length
      ? "Rules added to your proposal. Review and save to persist changes."
      : "These requests are already covered by saved or proposed rules. Check the policy status before retrying.";
    if (batch && fresh.length) {
      policyPanel.querySelector<HTMLFormElement>("form")?.requestSubmit();
    }
  }

  function prefill(grant: SandboxNetworkGrant) {
    stageGrants([grant], false);
  }

  function renderSuggestions() {
    suggestions.hidden = recommendations.length === 0 && suggestionStatus.dataset.loaded === "true";
    suggestions.className = "sandbox-suggestions";
    suggestions.replaceChildren();
    if (recommendations.length === 1 && editable()) {
      const entry = recommendations[0]!;
      suggestions.append(
        element(
          "div",
          {},
          element("strong", {}, "1 suggested rule"),
          element("p", { className: "resource-id" }, grantText(entry.grant)),
        ),
        button("Review suggestion", () => prefill(entry.grant), { size: "sm" }),
      );
    } else {
      suggestions.append(
        element(
          "h3",
          {},
          recommendations.length
            ? `${recommendations.length} suggested rules`
            : "Policy suggestions",
        ),
        suggestionStatus,
        ...recommendations.map((entry) =>
          element(
            "div",
            { className: "sandbox-suggestion-row" },
            element("p", { className: "resource-id" }, grantText(entry.grant)),
            editable()
              ? button("Review suggestion", () => prefill(entry.grant), { size: "sm" })
              : null,
          ),
        ),
      );
    }
    const details = element(
      "details",
      { className: "sandbox-suggestion-details" },
      element("summary", {}, "About suggestions"),
      element(
        "p",
        { className: "hint" },
        "Provider suggestions are untrusted candidate grants. Observation counts are aggregates, separate from denial records.",
      ),
      ...recommendations.map((entry) =>
        element(
          "p",
          { className: "hint" },
          `${entry.status} · Provider observations: ${entry.observations ?? "unknown"}`,
        ),
      ),
      suggestionStatus.isConnected ? null : suggestionStatus,
      suggestionsDenied
        ? null
        : button("Refresh suggestions", () => void loadSuggestions(), { size: "sm" }),
    );
    suggestions.append(details);
  }

  async function loadSuggestions() {
    if (!current() || suggestionsReading) {
      return;
    }
    if (revisionId === "draft") {
      suggestionStatus.textContent = "Deploy an Agent to collect provider suggestions.";
      renderSuggestions();
      return;
    }
    if (!(await policySupported()) || suggestionsReading) {
      return;
    }
    clearTimeout(suggestionTimer);
    suggestionsReading = true;
    try {
      const result = (await context.request(
        `${path}/revisions/${encodeURIComponent(revisionId)}/sandbox-policy/networking/recommendations`,
      )) as SandboxPolicyRecommendations;
      if (!current()) {
        return;
      }
      recommendations = result.recommendations;
      suggestionStatus.dataset.loaded = "true";
      suggestionsDenied = false;
      suggestionStatus.textContent = `Suggestions loaded: ${recommendations.length}${result.providerVersion ? ` · Provider draft version ${result.providerVersion}` : ""}${result.truncated ? " · Some suggestions were omitted or exceed the read limit." : ""}`;
    } catch (error) {
      if (!current()) {
        return;
      }
      recommendations = [];
      suggestionStatus.dataset.loaded = "false";
      suggestionsDenied = requestFailure(error).status === 403;
      suggestionStatus.textContent = errorText(error, "read policy suggestions");
    }
    suggestionsReading = false;
    renderSuggestions();
    if (current() && follow.checked && !suggestionsDenied) {
      suggestionTimer = setTimeout(() => {
        if (follow.checked) {
          void loadSuggestions();
        }
      }, 5000);
    }
  }

  async function mutate(
    operation: () => Promise<void>,
    requiresEditAuthority = true,
    failureMessage = (error: unknown) => errorText(error, "change this Agent’s policy"),
  ) {
    if (mutation || unknownOutcome) {
      return;
    }
    let rejected = false;
    mutation = true;
    // A read started before this write cannot establish what the write changed.
    policyReadSequence += 1;
    clearTimeout(policyTimer);
    feedback.textContent = "";
    feedback.className = "";
    feedback.setAttribute("role", "status");
    renderPolicy();
    try {
      await operation();
    } catch (error) {
      if (!current()) {
        return;
      }
      rejected = true;
      const { status } = requestFailure(error);
      validationDetails = requestErrorDetails(error);
      feedback.textContent = failureMessage(error);
      feedback.className = "error";
      feedback.setAttribute("role", "alert");
      if (status === 403 && requiresEditAuthority) {
        editDenied = true;
      }
      if (!status || status < 400 || status >= 500) {
        unknownOutcome = true;
        feedback.textContent +=
          " Refresh policy to check the outcome before making another change.";
      }
    } finally {
      mutation = false;
      if (current()) {
        schedulePendingPolicyRead(2000);
        renderPolicy();
        renderSuggestions();
        renderLogs();
        if (rejected) {
          feedback.focus({ preventScroll: true });
          feedback.scrollIntoView({ block: "center" });
        }
      }
    }
  }

  function renderEditor() {
    dialogTitle.textContent = editingRules ? "Edit network rule" : "Manage network rules";
    dialogActions.replaceChildren(button("Done", closeDialog, { disabled: mutation }));
    policyPanel.replaceChildren(
      feedback,
      button("Refresh policy", () => void loadPolicy(), { disabled: mutation }),
    );
    if (!view) {
      policyPanel.append(element("p", { role: "status" }, "Loading Agent policy…"));
      return;
    }
    const { configuration, editingEnabled, policy } = view;
    const settings = element(
      "details",
      { className: "sandbox-policy-settings" },
      element("summary", {}, "Policy settings and Installation limits"),
    );
    if (unknownOutcome) {
      policyPanel.append(
        element(
          "p",
          { className: "hint" },
          `Last read: policy v${policy.version}. Refreshing keeps your proposal and shows the saved rules.`,
        ),
      );
      return;
    }
    const { application } = policy;
    settings.append(
      element(
        "p",
        {},
        view.capability
          ? `Policy v${policy.version} · Editing ${editingEnabled ? "enabled" : "disabled"}`
          : "This Sandbox Driver does not support per-Agent network policy.",
      ),
      element(
        "p",
        { className: "muted" },
        protectedExecution()
          ? "Defaults remain read-only. Saved network rules can only be removed while protected execution applies. Disabling editing preserves saved rules."
          : "Defaults remain read-only. Only the additions below are editable. Disabling editing preserves approved grants.",
      ),
      element(
        "details",
        {},
        element("summary", {}, "Read-only Installation defaults"),
        element(
          "p",
          { className: "muted" },
          view.defaultsRevisionId
            ? `Admitted for running version ${view.defaultsRevisionId}. Generated transport access is managed separately.`
            : protectedExecution()
              ? "Defaults from the selected Sandbox Driver. Protected versions use Credential Proxy routes instead."
              : "Defaults from the selected Sandbox Driver. Generated transport access is managed separately.",
        ),
        view.defaults === null
          ? element("p", {}, "No editable network-policy capability is available.")
          : element("pre", {}, visibleText(JSON.stringify(view.defaults, null, 2))),
      ),
      element(
        "details",
        {},
        element("summary", {}, "Installation delegation ceiling"),
        ...(view.ceiling.length
          ? view.ceiling.map((grant) => element("p", {}, grantText(grant)))
          : [element("p", {}, "No additions are delegated.")]),
      ),
      button(
        editingEnabled ? "Disable policy editing" : "Enable policy editing",
        () =>
          void mutate(async () => {
            await context.request(`${policyPath}/editing`, {
              method: "PATCH",
              body: { enabled: !editingEnabled },
            });
            await loadPolicy();
          }, false),
        { disabled: mutation },
      ),
      element(
        "p",
        { className: "hint" },
        "Changing the editing setting requires Installation and Agent administration. Editing additions requires separate Agent policy and SandboxPolicy permissions.",
      ),
    );
    if (policy.applied) {
      const applied = policy.applied;
      settings.append(
        element(
          "p",
          {},
          `Last confirmed live policy: v${applied.policyVersion} · Provider version ${applied.providerVersion} · Revision ${applied.revisionId}`,
        ),
      );
    }
    if (application) {
      settings.append(
        element(
          "p",
          { role: "status" },
          `Application: ${application.state}${application.providerVersion ? ` · Provider version ${application.providerVersion}` : ""}${application.reason ? ` · ${application.reason}` : ""} · Revision ${application.revisionId}`,
        ),
      );
      if (application.state === "failed") {
        settings.append(
          element(
            "p",
            { className: "notice" },
            "Application was not confirmed. The provider may have accepted part of the request; refresh and retry explicitly. No redeployment was started.",
          ),
        );
      }
    } else {
      settings.append(
        element(
          "p",
          { className: "muted" },
          "Saved policy changes take effect on explicit deployment or confirmed live application.",
        ),
      );
    }
    const pending = application?.state === "pending";
    const canApply = canApplySavedPolicy();
    const form = element("form", { className: "sandbox-policy-form" });
    const draftStatus = element("p", { role: "status", className: "hint" });
    const reviewButton = element("button", { type: "submit" }, "Review changes");
    const applyButton = button("Apply saved policy to current revision", () => {
      if (policyPanel.contains(applyButton)) {
        void mutate(applySavedPolicy);
      }
    });
    function updateDraftStatus() {
      const dirty = hasProposedChanges();
      draftStatus.textContent = dirty
        ? "Unsaved changes. Adding or removing a proposed rule does not save or apply it."
        : `Matches saved policy v${policy.version}. Editing rules only changes your proposal.`;
      reviewButton.disabled = !editable() || pending || !dirty;
      applyButton.disabled = !editable() || !canApply || pending || dirty;
    }
    if (!configuration) {
      return;
    }
    form.noValidate = true;
    const itemSchema = responseFields(
      responseFields(responseFields(configuration.configurationSchema).properties).additions,
    ).items;
    const single =
      editingRules &&
      editorIndex !== undefined &&
      Array.isArray(additions) &&
      typeof itemSchema === "object" &&
      itemSchema !== null &&
      !Array.isArray(itemSchema);
    const index = editorIndex ?? 0;
    form.append(
      draftStatus,
      configurationFields(
        single ? (itemSchema as JSONSchema) : configuration.configurationSchema,
        single && Array.isArray(additions) ? additions[index] : { additions },
        (candidate) => {
          if (single && Array.isArray(additions)) {
            additions[index] = candidate;
          } else {
            additions = responseFields(candidate).additions;
          }
          validationDetails = [];
          for (const error of form.querySelectorAll(".error")) {
            error.remove();
          }
          updateDraftStatus();
        },
        {
          disabled: !editable() || pending,
          details: single
            ? validationDetails.map((detail) => ({
                ...detail,
                path: detail.path.replace(new RegExp(`^/additions/${index}(?=/|$)`), ""),
              }))
            : validationDetails,
          onEdit: () => {
            reviewSummary = "";
            draftGeneration += 1;
            feedback.className = "";
            feedback.setAttribute("role", "status");
            feedback.textContent = "Draft changed. Review again before saving.";
          },
        },
      ),
      ...(validationDetails.length ? [configurationErrors(validationDetails)] : []),
    );
    form.append(
      reviewButton,
      button("Back to rules", () => {
        editingRules = false;
        renderEditor();
      }),
    );
    updateDraftStatus();
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (
        !current() ||
        !policyPanel.contains(form) ||
        !canEdit() ||
        (protectedExecution() && (!Array.isArray(additions) || additions.length !== 0))
      ) {
        return;
      }
      if ([...form.querySelectorAll("textarea")].some((input) => !input.reportValidity())) {
        return;
      }
      const expectedVersion = policy.version;
      const generation = draftGeneration;
      const sequence = ++previewSequence;
      const validation = configurationAction(configuration, "validate");
      feedback.textContent = "Validating proposed configuration…";
      let reviewedRules: SandboxNetworkGrant[];
      try {
        const { success, data, error } = responseFields(
          await context.request(validation.href, {
            method: validation.method,
            body: { expectedVersion, additions },
          }),
        );
        if (
          !current() ||
          !policyPanel.contains(form) ||
          !canEdit() ||
          sequence !== previewSequence ||
          generation !== draftGeneration ||
          expectedVersion !== view?.policy.version
        ) {
          return;
        }
        const rules = responseFields(data).additions;
        if (
          success !== true ||
          !readableRules(rules) ||
          (protectedExecution() && rules.length !== 0)
        ) {
          validationDetails = requestErrorDetails(error);
          feedback.textContent =
            (success === false
              ? "Review the configuration errors."
              : "The Console could not read the validated rules. Review your proposal again.") +
            " Your proposal has not been saved or applied.";
          feedback.className = "error";
          feedback.setAttribute("role", "alert");
          renderPolicy();
          feedback.focus({ preventScroll: true });
          feedback.scrollIntoView({ block: "center" });
          return;
        }
        reviewedRules = rules;
        feedback.className = "";
        feedback.setAttribute("role", "status");
        feedback.textContent =
          "Validation passed. Saving and applying each recheck current permissions and policy.";
      } catch (error) {
        if (
          !current() ||
          !policyPanel.contains(form) ||
          sequence !== previewSequence ||
          generation !== draftGeneration ||
          expectedVersion !== view?.policy.version
        ) {
          return;
        }
        validationDetails = requestErrorDetails(error);
        feedback.textContent = `${errorText(error, "validate this Agent’s policy")} Your draft is retained. Reload policy to review a conflict.`;
        feedback.className = "error";
        feedback.setAttribute("role", "alert");
        renderPolicy();
        feedback.focus({ preventScroll: true });
        feedback.scrollIntoView({ block: "center" });
        return;
      }

      function save(apply: boolean) {
        if (
          !current() ||
          !policyPanel.contains(review) ||
          !canEdit() ||
          generation !== draftGeneration ||
          expectedVersion !== view?.policy.version ||
          (protectedExecution() && (apply || reviewedRules.length !== 0))
        ) {
          return;
        }
        let savedVersion: number | undefined;
        const unconfirmedSave = new Error(
          "The Console could not confirm the saved rules. Live application was not requested.",
        );
        void mutate(
          async () => {
            if (!view?.configuration) {
              return;
            }
            const action = configurationAction(view.configuration, "save");
            const saved = (await context.request(action.href, {
              method: action.method,
              expectedStatus: 200,
              body: { expectedVersion, additions: reviewedRules },
            })) as Policy | null;
            if (
              saved?.id !== policy.id ||
              saved.agentId !== agent.id ||
              saved.namespaceId !== agent.namespaceId ||
              saved.version !== expectedVersion + 1 ||
              !sameValue(saved.additions, reviewedRules)
            ) {
              throw unconfirmedSave;
            }
            view.policy = saved;
            additions = structuredClone(saved.additions);
            savedVersion = saved.version;
            if (apply) {
              await applySavedPolicy();
            } else {
              feedback.textContent = protectedExecution()
                ? `Policy v${saved.version} saved without network rules. The current revision is unchanged. Deploy a new version when ready.`
                : `Policy v${saved.version} saved. The current revision is unchanged. Apply the saved policy or deploy a new version when ready.`;
            }
          },
          true,
          (error) => {
            if (error === unconfirmedSave) {
              return unconfirmedSave.message;
            }
            const reason = errorText(error, "change this Agent’s policy");
            return savedVersion === undefined
              ? reason
              : `Policy v${savedVersion} was saved, but application to the current revision was not confirmed. ${reason}`;
          },
        );
      }
      const changed = reviewedRules.filter(
        (rule) => !policy.additions.some((saved) => sameValue(saved, rule)),
      );
      const removed = policy.additions.filter(
        (saved) => !reviewedRules.some((rule) => rule.id === saved.id),
      );
      const unchanged = reviewedRules.length - changed.length;
      const review = element(
        "section",
        { className: "sandbox-policy-review" },
        reviewSummary ? element("p", { className: "hint" }, reviewSummary) : null,
        ...(changed.length
          ? [element("h3", {}, `Rules to add or update · ${changed.length}`), ruleList(changed)]
          : []),
        ...(removed.length
          ? [element("h3", {}, `Rules to remove · ${removed.length}`), ruleList(removed)]
          : []),
        element("p", { className: "hint" }, `${unchanged} existing rules unchanged.`),
        element(
          "details",
          {},
          element("summary", {}, `Previously saved rules · v${expectedVersion}`),
          policy.additions.length
            ? ruleList(policy.additions)
            : element("p", {}, "No Agent-specific rules saved."),
        ),
        element(
          "p",
          { className: "hint" },
          canApply
            ? "Save and apply requests live application to this running revision. Wait for provider confirmation before retrying. Save for later keeps the current revision’s network access unchanged."
            : "Save for later keeps the current revision’s network access unchanged. Live application requires the current running revision and a supporting Sandbox Driver.",
        ),
      );
      dialogActions.replaceChildren(
        button("Back to editing", renderPolicy),
        button("Save for later", () => save(false)),
        button("Save and apply to current revision", () => save(true), {
          tone: "primary",
          disabled: !canApply,
        }),
      );
      dialogTitle.textContent = "Review policy changes";
      rulesOverview.hidden = true;
      settings.hidden = true;
      form.replaceWith(review);
      applyButton.hidden = true;
    });
    const rulesOverview = element(
      "section",
      { className: "sandbox-rules-overview" },
      element(
        "div",
        { className: "sandbox-policy-card-head" },
        element(
          "h3",
          {},
          `Agent-specific rules · ${Array.isArray(additions) ? additions.length : "invalid draft"}`,
        ),
        button(
          "Add rule",
          () => {
            if (!editable() || !Array.isArray(additions)) {
              return;
            }
            additions.push({
              id: `network-${crypto.randomUUID()}`,
              binary: "",
              host: "",
              ports: [],
            });
            draftGeneration += 1;
            editorIndex = additions.length - 1;
            editingRules = true;
            reviewSummary = "";
            renderEditor();
          },
          { tone: "primary", size: "sm", disabled: !editable() },
        ),
      ),
      element(
        "p",
        { className: "hint" },
        "Read-only Installation defaults also apply. Draft changes require review and an explicit save.",
      ),
      Array.isArray(additions)
        ? ruleList(additions, (index) => {
            const menu = element("details", { className: "sandbox-rule-actions" });
            menu.append(
              element("summary", { "aria-label": `Actions for network rule ${index + 1}` }, "⋯"),
              element(
                "div",
                {},
                button(
                  "Edit rule",
                  () => {
                    editorIndex = index;
                    editingRules = true;
                    reviewSummary = "";
                    renderEditor();
                  },
                  { disabled: !editable() },
                ),
                button(
                  "Remove rule",
                  () => {
                    if (!editable() || !Array.isArray(additions)) {
                      return;
                    }
                    additions.splice(index, 1);
                    reviewSummary = "";
                    draftGeneration += 1;
                    renderEditor();
                  },
                  { disabled: !editable() },
                ),
              ),
            );
            return menu;
          })
        : element(
            "p",
            { role: "alert" },
            "The draft contains incomplete rules. Edit the configuration to correct them.",
          ),
      ...(protectedExecution() && policy.additions.length > 0 && editingEnabled
        ? [
            button(
              "Remove saved network rules",
              () => {
                if (
                  !current() ||
                  !policyPanel.contains(form) ||
                  !canEdit() ||
                  !protectedExecution()
                ) {
                  return;
                }
                additions = [];
                draftGeneration += 1;
                validationDetails = [];
                form.requestSubmit();
              },
              { disabled: !canEdit() },
            ),
          ]
        : []),
      editingRules ? null : draftStatus,
      ...(validationDetails.length ? [configurationErrors(validationDetails)] : []),
      button("Review changes", () => form.requestSubmit(), {
        tone: "primary",
        disabled: !editable() || !hasProposedChanges(),
      }),
    );
    rulesOverview.hidden = editingRules;
    form.hidden = !editingRules;
    policyPanel.append(
      ...(protectedExecution()
        ? [
            element(
              "p",
              { role: "status", className: "sandbox-policy-protected" },
              "Protected execution uses Credential Proxy routes. You can remove saved network rules, but cannot add new ones. Saving does not change the running revision.",
            ),
            ...(policy.additions.length > 0 && !editingEnabled
              ? [
                  element(
                    "p",
                    { className: "hint" },
                    "Saved network rules block protected deploys. Enable policy editing to remove them.",
                  ),
                ]
              : []),
          ]
        : []),
      rulesOverview,
      form,
      applyButton,
      settings,
      ...(!view.capability?.live
        ? [
            element(
              "p",
              { className: "hint" },
              "Live application is unavailable. Use Deploy new version explicitly; deployment may interrupt the Agent and requires deploy permission.",
            ),
          ]
        : []),
    );
  }

  async function applySavedPolicy() {
    if (!view?.configuration || !canApplySavedPolicy() || hasProposedChanges()) {
      return;
    }
    const action = configurationAction(view.configuration, "apply");
    const applied = (await context.request(action.href, {
      method: action.method,
      body: { expectedVersion: view.policy.version, revisionId },
    })) as Policy;
    view.policy = applied;
    feedback.textContent = `Policy v${applied.version} saved. Application to the current revision is pending. Enforcement is confirmed only after the provider loads this policy.`;
  }

  function schedulePendingPolicyRead(delay = 3000) {
    clearTimeout(policyTimer);
    if (mutation || unknownOutcome || view?.policy.application?.state !== "pending") {
      return;
    }
    policyTimer = setTimeout(() => {
      if (current()) {
        void loadPolicy();
      }
    }, delay);
  }

  async function loadPolicy() {
    clearTimeout(policyTimer);
    const sequence = ++policyReadSequence;
    const generation = draftGeneration;
    const keepDraft = view !== undefined && hasProposedChanges();
    let readFailed = false;
    try {
      const loaded = (await context.request(policyPath)) as SandboxPolicyViewWire;
      if (!current() || sequence !== policyReadSequence || generation !== draftGeneration) {
        return;
      }
      const wasPending = view?.policy.application?.state === "pending";
      view = loaded;
      if (view.capability === null) {
        // The draft tab reads no logs or suggestions, so the unsupported state is shown from here too.
        void policySupported();
        return;
      }
      if (wasPending && view.policy.application?.state !== "pending") {
        feedback.textContent = "Policy refreshed.";
        if (view.policy.application?.state === "applied") {
          feedback.textContent = "Policy application confirmed by the Sandbox provider.";
        } else if (view.policy.application?.state === "failed") {
          feedback.textContent =
            "Policy application was not confirmed. Inspect the application status before retrying.";
        }
      }
      if (keepDraft) {
        feedback.textContent = `Policy v${view.policy.version} reloaded. Your draft is retained; review it against the saved policy before saving.`;
      } else {
        additions = structuredClone(view.policy.additions);
      }
      validationDetails = [];
      unknownOutcome = false;
      editDenied = false;
      policyReadUnavailable = false;
      renderPolicy();
      renderSuggestions();
      renderLogs();
      draftGeneration += 1;
    } catch (error) {
      if (!current() || sequence !== policyReadSequence || generation !== draftGeneration) {
        return;
      }
      readFailed = true;
      policyReadUnavailable = true;
      if (dialog.open) {
        renderEditor();
      }
      renderLogs();
      renderSuggestions();
      policySummary.replaceChildren(
        element("h2", {}, "Agent network policy"),
        element("p", { role: "alert" }, errorText(error, "read this Agent’s policy")),
        ...(requestFailure(error).status === 403
          ? []
          : [button("Retry policy read", () => void loadPolicy())]),
      );
    } finally {
      if (current() && sequence === policyReadSequence && !readFailed) {
        schedulePendingPolicyRead();
      }
    }
  }

  function renderPolicy() {
    policySummary.replaceChildren(
      element(
        "div",
        { className: "sandbox-policy-card-head" },
        element("h2", {}, "Network policy"),
        manageButton,
      ),
    );
    if (!view) {
      policySummary.append(element("p", { role: "status" }, "Loading network policy…"));
    }
    if (view) {
      const { policy } = view;
      const applied = policy.applied?.revisionId === revisionId ? policy.applied : undefined;
      function policyStatus() {
        if (policy.application?.state === "pending") {
          return { label: "Applying…", tone: "info" };
        }
        if (policy.application?.state === "failed") {
          return { label: "Application unconfirmed", tone: "warning" };
        }
        if (applied?.policyVersion === policy.version) {
          return { label: "Applied", tone: "success" };
        }
        return {
          label: applied ? "Changes not applied" : "Application unconfirmed",
          tone: "warning",
        };
      }
      const presentation = policyStatus();
      policySummary
        .querySelector("h2")
        ?.append(
          element(
            "span",
            { className: "badge", "data-tone": presentation.tone },
            presentation.label,
          ),
        );
      policySummary.append(
        ...(hasProposedChanges()
          ? [
              element(
                "p",
                { className: "hint" },
                "Unsaved rule changes · Open Manage rules to continue your proposal.",
              ),
            ]
          : []),
        element(
          "p",
          { className: "hint" },
          `${policy.additions.length} explicit rules · Saved v${policy.version} · ${applied ? `Last confirmed live v${applied.policyVersion}` : "Live version unconfirmed"}`,
        ),
        ...(unknownOutcome
          ? [
              element(
                "p",
                { role: "alert" },
                "The last change could not be confirmed. Open Manage rules and refresh policy before changing access.",
              ),
            ]
          : []),
      );
    }
    if (dialog.open) {
      renderEditor();
    }
  }

  filter.addEventListener("input", () => {
    logPage = 1;
    renderLogs();
  });
  follow.addEventListener("change", () => {
    clearTimeout(logTimer);
    clearTimeout(suggestionTimer);
    if (follow.checked) {
      void readLogs();
      void loadSuggestions();
    }
  });
  policyCard.append(policySummary, suggestions);
  const windowDetails = element(
    "details",
    { className: "sandbox-window-details" },
    element("summary", {}, "About this window"),
    logWindowStatus,
    element(
      "p",
      { className: "hint" },
      "Counts are retained records for this version, not unique requests or lifetime denials. One action can produce multiple records. Following keeps this view in place until you choose Show newest.",
    ),
  );
  section.append(
    policyCard,
    element("div", { className: "sandbox-denials-heading" }, element("h2", {}, "Denials"), count),
    element(
      "div",
      { className: "sandbox-denials-toolbar" },
      filter,
      element(
        "div",
        { className: "form-actions" },
        button("Refresh denials", () => void readLogs(true), { tone: "ghost", size: "sm" }),
        element("label", {}, follow, "Follow"),
      ),
    ),
    logStatus,
    logWarnings,
    logNotices,
    newDenials,
    selection,
    logRows,
    logPager,
    windowDetails,
    dialog,
  );
  renderPolicy();
  const firstPolicyRead = loadPolicy();
  if (revisionId === "draft") {
    logStatus.textContent = "Deploy an Agent to load Sandbox policy decisions.";
  } else {
    void readLogs(true);
  }
  void loadSuggestions();
  return section;
}
