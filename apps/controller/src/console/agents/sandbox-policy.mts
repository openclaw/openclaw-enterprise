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
import { button, dismissOnBackdrop, element, mayReturnFocus } from "../dom.mjs";
import type { NamespacePageContext } from "../namespaces.mjs";
import {
  askForGrant,
  LOG_TEXT_GRANT,
  notIncluded,
  POLICY_EDITING_SETTING_REFUSED,
  SANDBOX_POLICY_READ_DENIED,
} from "./access-reasons.mjs";
import { namespacePath, rejectionMessage } from "./list.mjs";
import { recordRow, visibleText } from "./logs-view.mjs";

type Policy = SandboxPolicyViewWire["policy"];

const POLICY_READ_DENIED = SANDBOX_POLICY_READ_DENIED;
// What each refused request checks: Sandbox log text needs Agent read_logs (or administer) plus
// Agent read, which admit every version of the Agent; the policy and suggestions need
// SandboxPolicy read; validation, preview and save need Agent manage_policy and SandboxPolicy
// update. Live application also needs SandboxPolicy read: it admits and returns the saved
// rules (finding 2874), so a read revoked while the page is open refuses it.
const LOG_GRANT = `${LOG_TEXT_GRANT} on it`;
const POLICY_READ_GRANT = "SandboxPolicy read on it";
const POLICY_CHANGE_GRANT = "Agent manage_policy and SandboxPolicy update on it";
const POLICY_APPLY_GRANT = "Agent manage_policy and SandboxPolicy update and read on it";
// A draft of an Agent with no current version: never deployed, stopped, or first deployment
// still running. The copy fits each, and a reader who cannot deploy is not told to.
const NO_CURRENT_VERSION_DENIALS =
  "Policy denials come from deployed versions. This Agent has no current version.";
const NO_CURRENT_VERSION_SUGGESTIONS =
  "Suggestions come from deployed versions. This Agent has no current version.";
// A version that runs without a Sandbox has no Sandbox log, so there are no denials to read: the
// read would answer 400 "no such runtime log source" (finding 2484).
const NO_SANDBOX_DENIALS =
  "This Agent version runs without a Sandbox, so no policy denials are recorded for it.";
const NO_SANDBOX_SUGGESTIONS =
  "Suggestions come from policy denials. This Agent version runs without a Sandbox, so it has none.";
// OpenShell logs a placeholder address for a connection whose host its policy DNS mapped, and the
// host in a record just before it. Without that record nothing names the host (D771).
const PLACEHOLDER_DESTINATION =
  "OpenShell logged only a placeholder address for this connection, and the record that names its hostname is not in the loaded log, so this denial proposes no rule. Add a rule for the hostname in Manage rules.";
type LogLine = Extract<RuntimeLogRecord, { type: "line" }>;

// The tab's version was deployed with the saved policy version, so its Sandbox enforces those
// rules, and no live application was requested for it (D773). A pending or failed application
// to this revision, even of the same version, keeps its own status.
function deployedWithSavedPolicy(view: SandboxPolicyViewWire | undefined, revisionId: string) {
  return (
    view !== undefined &&
    view.defaultsRevisionId === revisionId &&
    view.deployedPolicyVersion === view.policy.version &&
    view.policy.application?.revisionId !== revisionId
  );
}

// A 403 names what the refused request does, the grant it checks and who gives it (findings 2539,
// D753).
function errorText(cause: unknown, task: string, grant: string) {
  const { status, serverMessage } = requestFailure(cause);
  if (status === 403) {
    return notIncluded(task, grant);
  }
  if (status === 409 && serverMessage) {
    return serverMessage;
  }
  return rejectionMessage(cause);
}

const applyErrorText = (cause: unknown) =>
  errorText(cause, "applying this Agent’s policy", POLICY_APPLY_GRANT);

function grantText(grant: SandboxNetworkGrant) {
  const ports = grant.ports
    .map(({ from, to }) => (from === to ? String(from) : `${from}–${to}`))
    .join(", ");
  return `${visibleText(grant.binary)} → ${visibleText(grant.host)}:${ports}`;
}

// What a failed live application's reason code (`worker/sandbox-policy.ts`) means and what to do
// next; the page showed the bare code (finding 2537). The worker repeats its checks on every pass,
// also after it sent the policy and the Sandbox reported it pending, so a failure does not mean the
// Sandbox runs none of it (finding 2570). Refresh policy reads only the stored record.
const NOT_SENT_AGAIN =
  "The controller does not send this policy again, and it did not confirm whether the Sandbox runs it.";
const APPLICATION_FAILURES: Readonly<Record<string, string>> = {
  SANDBOX_POLICY_REVISION_CHANGED: `The Agent’s current version changed, or the Agent stopped, before the policy was confirmed. ${NOT_SENT_AGAIN} Apply the saved policy to the current version again.`,
  AUTHORIZATION_DENIED: `The account that applied the policy no longer has Agent manage_policy and SandboxPolicy update. ${NOT_SENT_AGAIN} ${askForGrant("that access")} Then apply again.`,
  SANDBOX_POLICY_CEILING_CHANGED: `The Installation delegation ceiling changed and no longer covers every saved rule. ${NOT_SENT_AGAIN} Remove the rules outside the ceiling, save, then apply again.`,
  SANDBOX_POLICY_UNSUPPORTED: `The Sandbox Driver running this version cannot apply Agent network policy, or refused these rules. ${NOT_SENT_AGAIN} Check the rules with Review changes; if they pass, deploy a new version to put the saved policy into effect.`,
  SANDBOX_POLICY_PROTECTED_EXECUTION: `This version runs under protected execution, whose egress policy an Agent network policy cannot replace. ${NOT_SENT_AGAIN} Remove the saved rules so that they do not block the next deploy.`,
  SANDBOX_POLICY_VALIDATION_FAILED: `The Sandbox Driver’s settings refused the saved rules. ${NOT_SENT_AGAIN} Review changes shows each problem: correct the rules, save, then apply again.`,
  SANDBOX_POLICY_PLACEMENT_UNAVAILABLE:
    "The Installation’s Compute Driver changed since this version was deployed, so the controller cannot reach its Sandbox to apply or check the policy. Deploy a new version to put the saved policy into effect.",
  SANDBOX_POLICY_PROVIDER_FAILED:
    "The Sandbox reported that applying the policy failed. Refresh policy, then apply again; if it fails again, ask an operator to check the Sandbox gateway.",
};
const APPLICATION_UNCONFIRMED =
  "Application was not confirmed. The provider may have accepted part of the request; refresh and retry explicitly. No redeployment was started.";

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

// OpenShell's policy DNS answers lookups with placeholder addresses (198.18.0.0/15 and
// fd23:6f70:656e::/48) and logs the host each one stands for. Such an address names no
// destination a rule can allow (D771).
function placeholderAddress(host: string) {
  return /^198\.1[89]\.\d{1,3}\.\d{1,3}$/.test(host) || /^fd23:6f70:656e:/i.test(host);
}

// The destination a denial names: its host, or, when only OpenShell's placeholder address
// was logged, the address marked as naming no host.
function denialDestination(record: LogLine) {
  const host = record.decision?.host ?? record.fields?.dst_host;
  const placeholder = record.fields?.dst_placeholder_ip;
  const port = record.decision?.port ?? record.fields?.dst_port;
  const suffix = port ? `:${visibleText(port)}` : "";
  if (typeof host === "string" && host && !placeholderAddress(host)) {
    return { host, text: `${visibleText(host)}${suffix}`, placeholder: false };
  }
  const address = typeof placeholder === "string" ? placeholder : host;
  return typeof address === "string" && address
    ? {
        host: undefined,
        text: `Hostname not logged · ${visibleText(address)}${suffix}`,
        placeholder: true,
      }
    : { host: undefined, text: `Unknown destination${suffix}`, placeholder: false };
}

function denialGrant(record: LogLine): SandboxNetworkGrant | undefined {
  const binary = record.decision?.binary ?? record.fields?.binary;
  const { host } = denialDestination(record);
  const port = Number(record.decision?.port ?? record.fields?.dst_port);
  if (
    typeof binary !== "string" ||
    !binary.startsWith("/") ||
    host === undefined ||
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
    policyReadAllowed,
    sandboxLogSource,
  }: {
    agent: Pick<Agent, "id" | "namespaceId" | "activeRevisionId" | "desiredRuntimeState">;
    revisionId: string;
    descriptor?: DriverConfigurationDescriptor;
    // The caller's advisory sandbox policy read answer; undefined when it is unknown.
    policyReadAllowed?: Promise<boolean | undefined>;
    // Whether the viewed version has a Sandbox log source, from its snapshot; undefined when it
    // is unknown, which reads the log and lets its answer decide.
    sandboxLogSource?: Promise<boolean | undefined>;
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
      // After the redraw: a summary control that held focus is replaced, which drops it.
      if (mayReturnFocus(dialog)) {
        (dialogInvoker?.isConnected ? dialogInvoker : manageButton).focus();
      }
    }
  });
  let editorIndex: number | undefined;
  let editingRules = false;
  let reviewSummary = "";
  let stagedReview:
    | {
        selected: number;
        fresh: number;
        repeated: number;
        covered: number;
        requests: { grant: SandboxNetworkGrant; count: number; covered: boolean }[];
      }
    | undefined;
  let outcomeRequested = false;
  let failedApplicationInspected = false;
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
  const limitsTitle = element("h2", { id: "sandbox-network-limits-title" }, "Network limits");
  const limitsBody = element("div", { className: "dialog-body sandbox-network-limits-body" });
  const limitsDialog = element("dialog", {
    className: "dialog dialog--framed sandbox-network-limits-dialog",
    "aria-labelledby": limitsTitle.id,
  });
  let limitsInvoker: Element | null;
  limitsDialog.append(
    element(
      "div",
      { className: "dialog-header" },
      limitsTitle,
      button("×", () => limitsDialog.close(), {
        tone: "ghost",
        "aria-label": "Close network limits",
      }),
    ),
    limitsBody,
    element(
      "div",
      { className: "dialog-actions" },
      button("Done", () => limitsDialog.close()),
    ),
  );
  dismissOnBackdrop(limitsDialog);
  limitsDialog.addEventListener("close", () => {
    if (current() && mayReturnFocus(limitsDialog)) {
      const target = limitsInvoker?.isConnected
        ? limitsInvoker
        : policySummary.querySelector(".sandbox-network-limits-link");
      if (target instanceof HTMLElement) {
        target.focus();
      }
    }
  });
  function openNetworkLimits() {
    if (!view) {
      return;
    }
    limitsInvoker = document.activeElement;
    limitsBody.replaceChildren(
      element(
        "p",
        {},
        "The Installation ceiling defines the maximum additional network access you can request for this Agent. Ceiling entries do not grant access by themselves.",
      ),
      element(
        "div",
        { className: "sandbox-limits-heading" },
        element("h3", {}, "Installation ceiling"),
        element("span", { className: "badge" }, "Read-only"),
      ),
      element(
        "p",
        { className: "hint" },
        "These limits are set by Installation configuration. Turning policy editing on or off does not change them.",
      ),
      ...(view.ceiling.length
        ? [
            element(
              "p",
              { className: "hint" },
              `${view.ceiling.length} configured ${view.ceiling.length === 1 ? "entry" : "entries"} · Executable, destination and permitted ports`,
            ),
            ruleList(view.ceiling),
          ]
        : [
            element(
              "p",
              { className: "notice" },
              "No additional network access is delegated. Agent-specific network rules cannot be added. Installation defaults still apply.",
            ),
          ]),
      element(
        "p",
        { className: "hint" },
        "Policy changes must also meet Agent permissions and execution restrictions.",
      ),
    );
    limitsDialog.showModal();
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
  const selection = element("div", { className: "sandbox-selection", hidden: true });
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
  const logActions = element(
    "div",
    { className: "form-actions" },
    button("Refresh denials", () => void readLogs(true)),
    element("label", {}, follow, "Follow"),
  );
  const feedback = element("p", { role: "status", tabindex: "-1" });
  const suggestionStatus = element("p", { role: "status" }, "Loading policy suggestions…");
  const filter = element("input", {
    type: "search",
    placeholder: "Search executable, destination, or reason",
    "aria-label": "Filter loaded denials",
  });
  const filterField = element(
    "label",
    { className: "form-field" },
    "Filter the loaded window",
    filter,
  );
  const logToolbar = element(
    "div",
    { className: "sandbox-denials-toolbar" },
    filterField,
    logActions,
  );
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
  // Set once the viewed version is known to have no Sandbox log source.
  let noSandboxLog = false;
  async function sandboxLogMissing() {
    if (
      !noSandboxLog &&
      (await Promise.resolve(sandboxLogSource).catch(() => undefined)) === false
    ) {
      noSandboxLog = true;
    }
    return noSandboxLog;
  }
  // Without a Sandbox log, the denial window and its controls can show nothing, so only the reason
  // stays (finding 2497).
  function showNoSandboxDenials() {
    follow.checked = false;
    clearTimeout(logTimer);
    clearTimeout(suggestionTimer);
    records = [];
    logsLoaded = false;
    logStatus.hidden = false;
    logStatus.textContent = NO_SANDBOX_DENIALS;
    logRows.replaceChildren();
    // The empty rows block keeps its margins and a grid gap: hide it too (finding 2522).
    for (const node of [
      count,
      logToolbar,
      logRows,
      logPager,
      logNotices,
      logWarnings,
      newDenials,
      selection,
      windowDetails,
    ]) {
      node.hidden = true;
    }
  }
  // Set when the caller's permission answer denies sandbox policy read: the policy and its
  // suggestions are not read, so a reader meets no 403 and no refusal block (finding 2454).
  let policyReadDenied = false;
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
          // The API names the cause, such as an Installation with no Sandbox Driver (D774).
          view.unavailableReason ??
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
    selection.hidden = !editable();
    section.classList.toggle("sandbox-readonly", !editable());
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
    // A DNS refusal names the lookup only; the connection attempt after it names the
    // executable (D772).
    const executable =
      binary ?? (fields.activity === "NET:REFUSE" ? "DNS lookup" : "Unknown executable");
    const destination = denialDestination(record);
    const reason = decision?.reason ?? fields.reason;
    const checkbox = element("input", {
      type: "checkbox",
      checked: selected.has(record),
      disabled: !editable() || !grant,
      "aria-label": `Select denial ${visibleText(record.time ?? "time unknown")} ${visibleText(executable)} to ${destination.text}`,
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
        `Executable path: ${visibleText(executable)}${typeof fields.dst_placeholder_ip === "string" ? ` · OpenShell address: ${visibleText(fields.dst_placeholder_ip)}` : ""} · Enforcement: ${visibleText(decision?.enforcement ?? "unknown")} · Rule: ${visibleText(decision?.rule ?? fields.rule_name ?? "unknown")} · Engine: ${visibleText(decision?.engine ?? fields.rule_type ?? "unknown")} · Policy generation: ${visibleText(decision?.policyGeneration ?? fields.policy_generation ?? "unknown")}`,
      ),
      ...(destination.placeholder
        ? [element("p", { className: "hint" }, PLACEHOLDER_DESTINATION)]
        : []),
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
            title: visibleText(executable),
          },
          visibleText(typeof binary === "string" ? binary.split("/").at(-1) : executable),
        ),
        element("span", { className: "resource-id sandbox-denial-destination" }, destination.text),
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
    if (await sandboxLogMissing()) {
      if (current()) {
        showNoSandboxDenials();
      }
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
      if (requestFailure(error).code === "RUNTIME_LOGS_SOURCE_UNAVAILABLE") {
        // The snapshot could not say; the answer does, and it is the same for every read.
        noSandboxLog = true;
        showNoSandboxDenials();
        return;
      }
      follow.checked = false;
      logStatus.hidden = false;
      logStatus.textContent = errorText(error, "reading this Agent’s Sandbox logs", LOG_GRANT);
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
    stagedReview = batch
      ? {
          selected: grants.length,
          fresh: fresh.length,
          repeated: grants.length - distinct.length,
          covered: distinct.length - fresh.length,
          requests: distinct.map((grant) => ({
            grant,
            count: grants.filter((item) => grantKey(item) === grantKey(grant)).length,
            covered: grantCovered(grant, existing),
          })),
        }
      : undefined;
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

  function selectionReviewSummary() {
    if (stagedReview) {
      return element(
        "section",
        { className: "sandbox-bulk-summary" },
        element(
          "h3",
          {},
          `${stagedReview.selected} ${stagedReview.selected === 1 ? "denial" : "denials"} selected → ${stagedReview.fresh} new ${stagedReview.fresh === 1 ? "rule" : "rules"}`,
        ),
        element(
          "p",
          {},
          `${stagedReview.repeated} repeated ${stagedReview.repeated === 1 ? "denial" : "denials"} grouped · ${stagedReview.covered} distinct ${stagedReview.covered === 1 ? "request" : "requests"} already covered by saved or proposed rules.`,
        ),
        element(
          "p",
          { className: "hint" },
          "Review the executable, destination and ports below. Access changes only after saving and confirmed application, or deployment.",
        ),
        element(
          "details",
          { className: "sandbox-selection-breakdown" },
          element("summary", {}, "How the selection becomes rules"),
          ...stagedReview.requests.map((item) =>
            element(
              "p",
              { className: "resource-id" },
              `${grantText(item.grant)} · ${item.count} ${item.count === 1 ? "denial" : "denials"} → ${item.covered ? "already covered" : "1 new rule"}`,
            ),
          ),
        ),
      );
    }
    return reviewSummary ? element("p", { className: "hint" }, reviewSummary) : null;
  }

  function prefill(grant: SandboxNetworkGrant) {
    stageGrants([grant], false);
  }

  let suggestionsExpanded = false;
  let suggestionsShowAll = false;
  function renderSuggestions() {
    suggestions.hidden = recommendations.length === 0 && suggestionStatus.dataset.loaded === "true";
    suggestions.className = "sandbox-suggestions";
    suggestions.replaceChildren();
    const canReview = editable();
    const showCandidates = canReview || suggestionsExpanded;
    let suggestionHelp = "Inspect potential fixes. Changes require additional policy permissions.";
    if (!view?.editingEnabled) {
      suggestionHelp = "Inspect potential fixes. Policy editing must be on to make changes.";
    } else if (view.policy.application?.state === "pending" || mutation) {
      suggestionHelp = "Inspect potential fixes while the current update completes.";
    } else if (protectedExecution()) {
      suggestionHelp =
        "Inspect observed requests. Protected execution restricts network additions.";
    } else if (canReview) {
      suggestionHelp = "Review observed requests before adding network access.";
    }
    const summary = element(
      "div",
      { className: "sandbox-suggestions-copy" },
      element(
        "h3",
        {},
        recommendations.length
          ? `${recommendations.length} suggested ${recommendations.length === 1 ? "rule" : "rules"}`
          : "Policy suggestions",
      ),
      element("p", { className: "hint" }, suggestionHelp),
    );
    suggestions.append(
      element(
        "div",
        { className: "sandbox-suggestions-head" },
        summary,
        !canReview && recommendations.length
          ? button(
              suggestionsExpanded ? "Hide suggestions" : "View suggestions",
              () => {
                suggestionsExpanded = !suggestionsExpanded;
                renderSuggestions();
                suggestions
                  .querySelector<HTMLButtonElement>('[data-suggestions-toggle="visibility"]')
                  ?.focus();
              },
              {
                size: "sm",
                "aria-expanded": String(suggestionsExpanded),
                "data-suggestions-toggle": "visibility",
              },
            )
          : null,
      ),
    );
    if (suggestionStatus.dataset.loaded !== "true") {
      suggestions.append(suggestionStatus);
    }
    if (showCandidates) {
      for (const entry of suggestionsShowAll ? recommendations : recommendations.slice(0, 3)) {
        const grant = entry.grant;
        const ports = grant.ports
          .map(({ from, to }) => (from === to ? from : `${from}–${to}`))
          .join(", ");
        const path = element(
          "details",
          { className: "sandbox-executable-path" },
          element("summary", {}, "Full executable path"),
          element("p", { className: "resource-id" }, visibleText(grant.binary)),
        );
        suggestions.append(
          element(
            "div",
            { className: "sandbox-suggestion-row" },
            element(
              "div",
              { className: "sandbox-suggestion-target" },
              element(
                "div",
                { className: "sandbox-suggestion-label" },
                element(
                  "p",
                  { className: "resource-id" },
                  `${visibleText(grant.binary.split("/").at(-1))} → ${visibleText(grant.host)}:${ports}`,
                ),
                element(
                  "span",
                  { className: "sandbox-observations" },
                  Number.isInteger(entry.observations)
                    ? `Observed ${entry.observations} ${entry.observations === 1 ? "time" : "times"}`
                    : "Observation count unavailable",
                ),
              ),
              path,
            ),
            canReview ? button("Review suggestion", () => prefill(grant), { size: "sm" }) : null,
          ),
        );
      }
    }
    if (showCandidates && recommendations.length > 3) {
      suggestions.append(
        element(
          "div",
          { className: "sandbox-suggestions-footer" },
          element(
            "span",
            { className: "hint" },
            `Showing ${suggestionsShowAll ? recommendations.length : 3} of ${recommendations.length}`,
          ),
          button(
            suggestionsShowAll
              ? "Show fewer suggestions"
              : `Show all ${recommendations.length} suggestions`,
            () => {
              suggestionsShowAll = !suggestionsShowAll;
              renderSuggestions();
              suggestions
                .querySelector<HTMLButtonElement>('[data-suggestions-toggle="all"]')
                ?.focus();
            },
            {
              tone: "link",
              size: "sm",
              "aria-expanded": String(suggestionsShowAll),
              "data-suggestions-toggle": "all",
            },
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
      // A refusal gets the same answer again, and a version without a Sandbox has none to read,
      // nor does the draft (finding 2509).
      ...(suggestionsDenied || noSandboxLog || revisionId === "draft"
        ? []
        : [button("Refresh suggestions", () => void loadSuggestions())]),
    );
    if (canReview || suggestionsExpanded || !recommendations.length) {
      suggestions.append(details);
    }
  }

  async function loadSuggestions() {
    if (!current() || suggestionsReading) {
      return;
    }
    // The permission answer decides the first policy read. A reader it denies is not sent to
    // the current version for suggestions, which refuses them too.
    await firstPolicyRead;
    if (!current() || suggestionsReading) {
      return;
    }
    if (policyReadDenied) {
      // The network policy card says this reader cannot read the policy or its suggestions, so
      // the suggestions card would only repeat that sentence (finding 2522).
      suggestionsDenied = true;
      suggestions.hidden = true;
      return;
    }
    if (revisionId === "draft") {
      suggestionStatus.textContent = agent.activeRevisionId
        ? "Suggestions come from deployed versions. Open the current version to see them."
        : NO_CURRENT_VERSION_SUGGESTIONS;
      renderSuggestions();
      return;
    }
    if (!(await policySupported()) || suggestionsReading) {
      return;
    }
    if (await sandboxLogMissing()) {
      if (current()) {
        suggestionStatus.textContent = NO_SANDBOX_SUGGESTIONS;
        renderSuggestions();
      }
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
      suggestionStatus.textContent = errorText(
        error,
        "reading policy suggestions",
        POLICY_READ_GRANT,
      );
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
    failureMessage = (error: unknown) =>
      errorText(error, "changing this Agent’s policy", POLICY_CHANGE_GRANT),
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
    dialogTitle.textContent = view?.editingEnabled ? "Manage network rules" : "View network rules";
    if (editingRules) {
      dialogTitle.textContent = "Edit network rule";
    }
    dialogActions.replaceChildren(button("Done", closeDialog, { disabled: mutation }));
    policyPanel.replaceChildren(
      feedback,
      button("Refresh policy", () => void loadPolicy(true), { disabled: mutation }),
    );
    if (!view) {
      policyPanel.append(element("p", { role: "status" }, "Loading Agent policy…"));
      return;
    }
    const { configuration, editingEnabled, policy } = view;
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
    const pending = application?.state === "pending";
    const canApply = canApplySavedPolicy();
    const form = element("form", { className: "sandbox-policy-form" });
    form.id = "sandbox-network-policy-form";
    const reviewButton = element(
      "button",
      {
        type: "submit",
        form: form.id,
        className: "button button--primary",
      },
      "Review changes",
    );
    const footerStatus = element("span", {
      className: "sandbox-dialog-change-status",
      role: "status",
    });
    function updateDraftStatus() {
      const dirty = hasProposedChanges();
      let changes = 1;
      if (Array.isArray(additions)) {
        const addedOrChanged = additions.filter(
          (rule) => !policy.additions.some((saved) => sameValue(saved, rule)),
        ).length;
        const proposed = additions;
        const removed = policy.additions.filter(
          (saved) => !proposed.some((rule) => rule?.id === saved.id),
        ).length;
        changes = Math.max(1, addedOrChanged + removed);
      }
      const unapplied =
        (policy.applied?.revisionId !== revisionId ||
          policy.applied?.policyVersion !== policy.version) &&
        !deployedWithSavedPolicy(view, revisionId);
      const failed = application?.state === "failed";
      footerStatus.textContent = "No unsaved changes";
      if (dirty) {
        footerStatus.textContent = `${changes} rule ${changes === 1 ? "change" : "changes"} to review`;
      } else if (pending) {
        footerStatus.textContent = "Applying…";
      } else if (failed) {
        footerStatus.textContent = "Application unconfirmed";
      } else if (unapplied) {
        footerStatus.textContent = "Saved rules awaiting application";
      }
      const canReview =
        canEdit() &&
        (!protectedExecution() || (Array.isArray(additions) && additions.length === 0));
      reviewButton.disabled = mutation || !canReview || pending;
      dialogActions.replaceChildren(
        footerStatus,
        button("Done", closeDialog, { disabled: mutation }),
      );
      if (dirty && editingEnabled && canReview) {
        dialogActions.append(reviewButton);
      } else if (
        !dirty &&
        (unapplied || failed) &&
        !pending &&
        (!failed || failedApplicationInspected) &&
        canApply
      ) {
        dialogActions.append(
          button(
            failed ? "Retry application" : "Apply saved rules",
            () => void mutate(applySavedPolicy, true, applyErrorText),
            {
              tone: "primary",
              disabled: mutation,
            },
          ),
        );
      }
      const addRule = rulesOverview.querySelector(".sandbox-add-rule");
      addRule?.classList.toggle(
        "button--primary",
        !dirty && !(unapplied && !pending && (!failed || failedApplicationInspected) && canApply),
      );
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
            stagedReview = undefined;
            draftGeneration += 1;
            feedback.className = "";
            feedback.setAttribute("role", "status");
            feedback.textContent = "";
          },
        },
      ),
      ...(validationDetails.length ? [configurationErrors(validationDetails)] : []),
    );
    form.append(
      button("Back to rules", () => {
        editingRules = false;
        renderEditor();
      }),
    );
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
        feedback.textContent = `${errorText(error, "validating this Agent’s policy", POLICY_CHANGE_GRANT)} Your draft is retained. Reload policy to review a conflict.`;
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
            outcomeRequested = true;
            selected.clear();
            stagedReview = undefined;
            editingRules = false;
            dialog.close();
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
            // Once the save succeeded, the refusal came from application, which also needs read.
            return savedVersion === undefined
              ? errorText(error, "changing this Agent’s policy", POLICY_CHANGE_GRANT)
              : `Policy v${savedVersion} was saved, but application to the current revision was not confirmed. ${applyErrorText(error)}`;
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
        selectionReviewSummary(),
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
      form.replaceWith(review);
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
            stagedReview = undefined;
            renderEditor();
          },
          { tone: "primary", size: "sm", className: "sandbox-add-rule", disabled: !editable() },
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
                    stagedReview = undefined;
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
                    stagedReview = undefined;
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
      ...(validationDetails.length ? [configurationErrors(validationDetails)] : []),
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
    if (!editable() && !editingRules) {
      for (const action of rulesOverview.querySelectorAll<HTMLButtonElement>("button")) {
        if (["Add rule", "Review changes"].includes(action.textContent)) {
          action.hidden = true;
        }
      }
      for (const menu of rulesOverview.querySelectorAll<HTMLElement>(".sandbox-rule-actions")) {
        menu.hidden = true;
      }
      const hint = rulesOverview.querySelector(".hint");
      if (hint) {
        hint.textContent =
          "Existing rules still apply. Changes require enabled editing and policy permissions.";
      }
    }

    updateDraftStatus();
  }

  async function applySavedPolicy() {
    outcomeRequested = true;
    failedApplicationInspected = false;
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

  async function loadPolicy(inspectFailure = false) {
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
      failedApplicationInspected = inspectFailure && loaded.policy.application?.state === "failed";
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
        element(
          "p",
          { role: "alert" },
          errorText(error, "reading this Agent’s policy", POLICY_READ_GRANT),
        ),
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

  function policyEditingExplanation() {
    if (!view?.editingEnabled) {
      return [
        element(
          "p",
          { className: "hint sandbox-editing-explanation" },
          "Editing is off. Existing rules still apply. Turn on Policy editing above to review and allow requests. Changing this setting requires Installation and Agent administration.",
        ),
      ];
    }
    if (
      !editable() &&
      !mutation &&
      !unknownOutcome &&
      view.policy.application?.state !== "pending"
    ) {
      return [
        element(
          "p",
          { className: "hint" },
          "Policy changes require additional permission or may be restricted for this Agent.",
        ),
      ];
    }
    return [];
  }

  async function setPolicyEditing(enabled: boolean) {
    await mutate(
      async () => {
        await context.request(`${policyPath}/editing`, {
          method: "PATCH",
          body: { enabled: !enabled },
        });
        await loadPolicy();
      },
      false,
      (error) =>
        requestFailure(error).status === 403
          ? POLICY_EDITING_SETTING_REFUSED
          : errorText(error, "changing the editing setting", POLICY_CHANGE_GRANT),
    );
    if (current() && feedback.getAttribute("role") !== "alert") {
      policySummary.querySelector<HTMLButtonElement>(".sandbox-editing-switch, button")?.focus();
    }
  }

  function renderPolicy() {
    if (policyReadDenied) {
      policySummary.replaceChildren(
        element("h2", {}, "Network policy"),
        element("p", { className: "muted" }, POLICY_READ_DENIED),
      );
      return;
    }
    // Keep the failed read and its recovery action visible after a mutation finishes.
    if (policyReadUnavailable) {
      return;
    }
    manageButton.disabled = mutation || !view;
    manageButton.textContent = view?.editingEnabled ? "Manage rules" : "View rules";
    const controls = element("div", { className: "sandbox-policy-controls" });
    if (view) {
      const enabled = view.editingEnabled;
      const editing = button(enabled ? "On" : "Off", () => void setPolicyEditing(enabled), {
        className: "sandbox-editing-switch",
        role: "switch",
        "aria-label": "Policy editing",
        "aria-checked": String(enabled),
        disabled: mutation || unknownOutcome,
      });
      controls.append(
        element(
          "div",
          { className: "sandbox-editing-control" },
          element("span", {}, "Policy editing"),
          editing,
        ),
      );
    }
    controls.append(manageButton);
    policySummary.replaceChildren(
      element(
        "div",
        { className: "sandbox-policy-card-head sandbox-policy-header" },
        element("h2", {}, "Network policy"),
        controls,
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
        if (deployedWithSavedPolicy(view, revisionId)) {
          return { label: "Deployed", tone: "success" };
        }
        return {
          label: applied || policy.version > 1 ? "Saved for later" : "Application unconfirmed",
          tone: "warning",
        };
      }
      const presentation = policyStatus();
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
          "div",
          { className: "sandbox-policy-meta" },
          element(
            "div",
            { className: "sandbox-policy-rule-status" },
            element(
              "strong",
              {},
              `${policy.additions.length} explicit ${policy.additions.length === 1 ? "rule" : "rules"}`,
            ),
            element("span", { "aria-hidden": "true" }, "·"),
            element(
              "span",
              { className: "badge", "data-tone": presentation.tone, role: "status" },
              presentation.label,
            ),
          ),
          button("View network limits", openNetworkLimits, {
            tone: "link",
            size: "sm",
            className: "sandbox-network-limits-link",
            "aria-haspopup": "dialog",
          }),
          element(
            "details",
            { className: "sandbox-policy-versions" },
            element("summary", {}, "Policy details"),
            element(
              "details",
              {},
              element("summary", {}, "Read-only Installation defaults"),
              element(
                "p",
                { className: "hint" },
                view.defaultsRevisionId
                  ? `Admitted for running revision ${view.defaultsRevisionId}. Generated transport access is managed separately.`
                  : "Defaults from the selected Sandbox Driver. Generated transport access is managed separately.",
              ),
              element("pre", {}, visibleText(JSON.stringify(view.defaults, null, 2))),
            ),
            policy.application
              ? element(
                  "p",
                  { className: "hint" },
                  `Application: ${policy.application.state} · Revision ${policy.application.revisionId}${policy.application.reason ? ` · ${policy.application.reason}` : ""}`,
                )
              : null,

            element("p", { className: "hint" }, `Saved version: v${policy.version}`),
            element(
              "p",
              { className: "hint" },
              applied
                ? `Last confirmed live version: v${applied.policyVersion}`
                : deployedWithSavedPolicy(view, revisionId)
                  ? `Deployed with policy v${policy.version}; no live change requested.`
                  : "Live version unconfirmed",
            ),
          ),
        ),
        ...policyEditingExplanation(),
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
    const currentPolicy = view?.policy;
    const application = currentPolicy?.application;
    const confirmed =
      currentPolicy?.applied?.revisionId === revisionId &&
      currentPolicy.applied.policyVersion === currentPolicy.version;
    let outcome;
    if (unknownOutcome) {
      outcome = {
        tone: "warning",
        title: "Change outcome unknown",
        text: "Refresh status to check the saved policy before making another change.",
      };
    } else if (application?.state === "failed") {
      outcome = {
        tone: "warning",
        title: "Application unconfirmed",
        text:
          application.reason && Object.hasOwn(APPLICATION_FAILURES, application.reason)
            ? APPLICATION_FAILURES[application.reason]
            : APPLICATION_UNCONFIRMED,
      };
    } else if (application?.state === "pending") {
      outcome = {
        tone: "info",
        title: "Applying…",
        text: "Your rules are saved. Waiting for confirmation from the running Agent’s Sandbox.",
      };
    } else if (
      currentPolicy &&
      !confirmed &&
      !deployedWithSavedPolicy(view, revisionId) &&
      (currentPolicy.applied?.revisionId === revisionId ||
        currentPolicy.version > 1 ||
        outcomeRequested)
    ) {
      outcome = {
        tone: "info",
        title: "Saved for later",
        text:
          currentPolicy.applied?.revisionId === revisionId
            ? "Your rules are saved. The running Agent still uses its previously applied rules."
            : "Your rules are saved. Apply them explicitly or deploy a new version when ready.",
      };
    } else if (confirmed && (outcomeRequested || application?.state === "applied")) {
      outcome = {
        tone: "success",
        title: "Applied to the running Agent",
        text: "The Sandbox confirmed these rules are active. Earlier denials remain in the historical log.",
      };
    }
    if (outcome) {
      const actions = element("div", { className: "sandbox-outcome-actions" });
      if (outcome.title === "Saved for later" && !hasProposedChanges() && canApplySavedPolicy()) {
        actions.append(
          button("Apply saved rules", () => void mutate(applySavedPolicy, true, applyErrorText), {
            size: "sm",
            disabled: mutation,
          }),
        );
      }
      if (
        outcome.title === "Applying…" ||
        outcome.title === "Application unconfirmed" ||
        outcome.title === "Change outcome unknown"
      ) {
        actions.append(
          button("Refresh status", () => void loadPolicy(true), { size: "sm", disabled: mutation }),
        );
      }
      if (
        application?.state === "failed" &&
        failedApplicationInspected &&
        !hasProposedChanges() &&
        canApplySavedPolicy()
      ) {
        actions.append(
          button("Retry application", () => void mutate(applySavedPolicy, true, applyErrorText), {
            size: "sm",
            disabled: mutation,
          }),
        );
      }
      policySummary.append(
        element(
          "section",
          {
            className: "sandbox-application-feedback",
            "data-tone": outcome.tone,
            role: outcome.tone === "warning" ? "alert" : "status",
          },
          element("h3", {}, outcome.title),
          element("p", {}, outcome.text),
          actions,
        ),
      );
    }
    if (dialog.open) {
      renderEditor();
    } else if (feedback.textContent) {
      policySummary.append(feedback);
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
    logToolbar,
    logStatus,
    logWarnings,
    logNotices,
    newDenials,
    selection,
    logRows,
    logPager,
    windowDetails,
    dialog,
    limitsDialog,
  );
  renderPolicy();
  // A caller whose permission answer denies sandbox policy read is not sent the policy read; an
  // unknown answer still reads it.
  const firstPolicyRead = Promise.resolve(policyReadAllowed).then((allowed) => {
    if (allowed !== false) {
      return loadPolicy();
    }
    if (current()) {
      policyReadDenied = true;
      renderPolicy();
    }
  });
  if (revisionId === "draft") {
    // The draft has no deployment of its own; a deployed Agent's denials are on its versions.
    logStatus.textContent = agent.activeRevisionId
      ? "Policy denials come from deployed versions. Open the current version to see them."
      : NO_CURRENT_VERSION_DENIALS;
    // It reads no Sandbox log, so the window's count, controls and rows could only show nothing,
    // as on a version without a Sandbox (findings 2509, 2522).
    for (const node of [
      count,
      logToolbar,
      logRows,
      logPager,
      logNotices,
      logWarnings,
      newDenials,
      selection,
      windowDetails,
    ]) {
      node.hidden = true;
    }
  } else {
    void readLogs(true);
  }
  void loadSuggestions();
  return section;
}
