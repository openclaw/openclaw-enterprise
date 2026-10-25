import type {
  Agent,
  AgentRuntimeLogPageWire,
  DriverConfigurationDescriptor,
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
import { button, element } from "../dom.mjs";
import type { NamespacePageContext } from "../namespaces.mjs";
import { namespacePath, rejectionMessage } from "./list.mjs";
import { recordRow, visibleText } from "./logs-view.mjs";

type Policy = SandboxPolicyViewWire["policy"];

const POLICY_READ_DENIED =
  "Your access does not include reading this Agent’s network policy or its suggestions.";
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

function decisionRow(record: LogLine, review?: (grant: SandboxNetworkGrant) => void) {
  const decision = record.decision;
  const fields = record.fields ?? {};
  const binary = decision?.binary ?? fields.binary;
  const host = decision?.host ?? fields.dst_host;
  const port = decision?.port ?? fields.dst_port;
  const reason = decision?.reason ?? fields.reason;
  const executable = typeof binary === "string" ? binary.split("/").at(-1) : undefined;
  const row = element(
    "article",
    { className: "sandbox-decision" },
    element(
      "h3",
      {},
      `Denied · ${visibleText(executable ?? "Unknown executable")} → ${visibleText(host ?? "Unknown destination")}${port ? `:${visibleText(port)}` : ""}`,
    ),
    decision?.enforcement === "blocked"
      ? element("span", { className: "status-badge status-failed" }, "Blocked")
      : null,
    reason
      ? element("p", {}, visibleText(reason))
      : element("p", { className: "muted" }, "Reason not reported"),
    element(
      "p",
      { className: "muted" },
      `Rule: ${visibleText(decision?.rule ?? fields.rule_name ?? "unknown")} · Engine: ${visibleText(decision?.engine ?? fields.rule_type ?? "unknown")} · Policy generation: ${visibleText(decision?.policyGeneration ?? fields.policy_generation ?? "unknown")}`,
    ),
    element(
      "details",
      {},
      element("summary", {}, "Decision details and sanitized log"),
      recordRow(record),
    ),
  );
  if (
    review &&
    typeof binary === "string" &&
    binary.startsWith("/") &&
    typeof host === "string" &&
    host &&
    Number(port) > 0
  ) {
    row.append(
      button("Review policy addition", () =>
        review({
          id: `network-${Date.now().toString(36)}`,
          binary,
          host,
          ports: [{ from: Number(port), to: Number(port) }],
        }),
      ),
    );
  }
  return row;
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
  const policyPanel = element("section", { className: "agent-card" });
  const suggestions = element("section", { className: "agent-card" });
  const logStatus = element("p", { role: "status" }, "Loading policy denials…");
  const logRows = element("div", { className: "sandbox-decisions" });
  const count = element(
    "p",
    { className: "sandbox-denial-count" },
    "Denials in the loaded window: —",
  );
  const follow = element("input", { type: "checkbox", "aria-label": "Follow policy denials" });
  const feedback = element("p", { role: "status", tabindex: "-1" });
  const suggestionStatus = element("p", { role: "status" }, "Loading policy suggestions…");
  const filter = element("input", {
    type: "search",
    placeholder: "Filter loaded denials",
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
  function showNoSandboxDenials() {
    follow.checked = false;
    clearTimeout(logTimer);
    records = [];
    logsLoaded = false;
    count.textContent = "Denials in the loaded window: none recorded";
    logStatus.textContent = NO_SANDBOX_DENIALS;
    logRows.replaceChildren();
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

  function renderLogs() {
    if (!logsLoaded) {
      return;
    }
    const denials = records.filter(
      (record): record is LogLine =>
        record.type === "line" &&
        (record.decision?.decision === "denied" || record.fields?.action === "DENIED"),
    );
    count.textContent = `Denials in the loaded window: ${denials.length}`;
    const query = filter.value.trim().toLowerCase();
    const shown = query
      ? denials.filter((record) =>
          JSON.stringify([record.message, record.decision, record.fields])
            .toLowerCase()
            .includes(query),
        )
      : denials;
    const gaps = records.filter((record) => record.type !== "line");
    const unclassified = records.filter(
      (record) =>
        record.type === "line" &&
        record.decision === undefined &&
        record.fields?.action === undefined,
    ).length;
    logRows.replaceChildren(
      ...gaps.map(recordRow),
      ...(shown.length
        ? shown.map((record) => decisionRow(record, editable() ? prefill : undefined))
        : [
            element(
              "p",
              {},
              denials.length ? "No denials match this filter." : "No denials in this window.",
            ),
          ]),
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
      logsLoaded = false;
      cursor = null;
      records = [];
      logStatus.textContent = "Loading policy denials…";
    }
    try {
      const query = new URLSearchParams({
        source: "sandbox",
        tailLines: "1000",
        ...(cursor ? { cursor } : {}),
      });
      const page = (await context.request(
        `${path}/deployments/${encodeURIComponent(revisionId)}/runtime/logs?${query}`,
      )) as AgentRuntimeLogPageWire;
      if (!current()) {
        return;
      }
      logsLoaded = true;
      records = [...records, ...page.records].slice(-1000);
      cursor = page.cursor;
      logStatus.textContent = `Loaded ${records.filter(({ type }) => type === "line").length} records. One action may produce several denial records. Log retention and gaps limit this window.`;
      renderLogs();
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

  function prefill(grant: SandboxNetworkGrant) {
    if (!editable() || !Array.isArray(additions)) {
      return;
    }
    additions.push(structuredClone(grant));
    draftGeneration += 1;
    validationDetails = [];
    renderPolicy();
    feedback.className = "";
    feedback.setAttribute("role", "status");
    feedback.textContent = "Rule added to your proposal. Review and save to persist changes.";
    policyPanel
      .querySelector<HTMLInputElement>(`[aria-label="Executable path ${additions.length}"]`)
      ?.focus();
  }

  function renderSuggestions() {
    suggestions.replaceChildren(
      element("h2", {}, "Policy suggestions"),
      suggestionStatus,
      element(
        "p",
        { className: "muted" },
        "Provider suggestions are untrusted candidate grants. Observation counts are aggregates, separate from denial records.",
      ),
      ...recommendations.map((entry) =>
        element(
          "article",
          { className: "sandbox-decision" },
          element("h3", {}, grantText(entry.grant)),
          element("p", {}, `${entry.status} · Observations: ${entry.observations ?? "unknown"}`),
          editable() ? button("Review suggestion", () => prefill(entry.grant)) : null,
        ),
      ),
      ...(suggestionsDenied ? [] : [button("Refresh suggestions", () => void loadSuggestions())]),
    );
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
      suggestionsDenied = true;
      suggestionStatus.textContent = POLICY_READ_DENIED;
      renderSuggestions();
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
      suggestionsDenied = false;
      suggestionStatus.textContent = `Suggestions loaded: ${recommendations.length}${result.providerVersion ? ` · Provider draft version ${result.providerVersion}` : ""}${result.truncated ? " · Some suggestions were omitted or exceed the read limit." : ""}`;
    } catch (error) {
      if (!current()) {
        return;
      }
      recommendations = [];
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

  function renderPolicy() {
    if (policyReadDenied) {
      policyPanel.replaceChildren(
        element("h2", {}, "Agent network policy"),
        element("p", { className: "muted" }, POLICY_READ_DENIED),
      );
      return;
    }
    policyPanel.replaceChildren(
      element("h2", {}, "Agent network policy"),
      feedback,
      button("Refresh policy", () => void loadPolicy(), { disabled: mutation }),
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
    policyPanel.append(
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
      policyPanel.append(
        element(
          "p",
          {},
          `Last confirmed live policy: v${applied.policyVersion} · Provider version ${applied.providerVersion} · Revision ${applied.revisionId}`,
        ),
      );
    }
    if (application) {
      policyPanel.append(
        element(
          "p",
          { role: "status" },
          `Application: ${application.state}${application.providerVersion ? ` · Provider version ${application.providerVersion}` : ""}${application.reason ? ` · ${application.reason}` : ""} · Revision ${application.revisionId}`,
        ),
      );
      if (application.state === "failed") {
        policyPanel.append(
          element(
            "p",
            { className: "notice" },
            "Application was not confirmed. The provider may have accepted part of the request; refresh and retry explicitly. No redeployment was started.",
          ),
        );
      }
    } else {
      policyPanel.append(
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
    form.append(
      draftStatus,
      configurationFields(
        configuration.configurationSchema,
        { additions },
        (candidate) => {
          additions = responseFields(candidate).additions;
          validationDetails = [];
          for (const error of form.querySelectorAll(".error")) {
            error.remove();
          }
          updateDraftStatus();
        },
        {
          disabled: !editable() || pending,
          details: validationDetails,
          onEdit: () => {
            draftGeneration += 1;
            feedback.className = "";
            feedback.setAttribute("role", "status");
            feedback.textContent = "Draft changed. Review again before saving.";
          },
        },
      ),
      ...(validationDetails.length ? [configurationErrors(validationDetails)] : []),
    );
    form.append(reviewButton);
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
      const review = element(
        "section",
        { className: "notice sandbox-policy-review" },
        element("h3", {}, "Review policy changes"),
        element("h4", {}, `Currently saved rules · v${expectedVersion}`),
        ...(policy.additions.length
          ? policy.additions.map((grant) => element("p", {}, grantText(grant)))
          : [element("p", {}, "No Agent-specific rules saved.")]),
        element("h4", {}, "Proposed rules"),
        ...(reviewedRules.length
          ? reviewedRules.map((grant) => element("p", {}, grantText(grant)))
          : [element("p", {}, "Remove all Agent-specific rules.")]),
        element(
          "div",
          { className: "sandbox-policy-save-option" },
          button("Save and apply to current revision", () => save(true), {
            className: "primary",
            disabled: !canApply,
          }),
          element(
            "p",
            { className: "hint" },
            canApply
              ? "Save these rules, then request live application to this running revision. Wait for provider confirmation before retrying the tool."
              : "Live application requires the current running revision and a supporting Sandbox Driver.",
          ),
        ),
        element(
          "div",
          { className: "sandbox-policy-save-option" },
          button("Save", () => save(false)),
          element(
            "p",
            { className: "hint" },
            "Save these rules for later application or deployment. The current revision’s network access stays unchanged.",
          ),
        ),
        button("Back to editing", renderPolicy),
      );
      form.replaceWith(review);
      applyButton.hidden = true;
    });
    form.prepend(
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
    );
    policyPanel.append(
      form,
      applyButton,
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
      renderPolicy();
      renderSuggestions();
      renderLogs();
      draftGeneration += 1;
    } catch (error) {
      if (!current() || sequence !== policyReadSequence || generation !== draftGeneration) {
        return;
      }
      readFailed = true;
      policyPanel.replaceChildren(
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

  filter.addEventListener("input", renderLogs);
  follow.addEventListener("change", () => {
    clearTimeout(logTimer);
    clearTimeout(suggestionTimer);
    if (follow.checked) {
      void readLogs();
      void loadSuggestions();
    }
  });
  section.append(
    element("h2", {}, "Policy denials"),
    count,
    element(
      "div",
      { className: "form-actions" },
      button("Refresh denials", () => void readLogs(true)),
      element("label", {}, follow, "Follow"),
    ),
    logStatus,
    element("label", { className: "form-field" }, "Filter the loaded window", filter),
    logRows,
    suggestions,
    policyPanel,
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
  } else {
    void readLogs(true);
  }
  void loadSuggestions();
  return section;
}
