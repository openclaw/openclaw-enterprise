import type {
  AgentDeploymentDiagnosticsWire,
  AgentDeploymentStatusWire,
} from "@openclaw-enterprise/contracts";
import { requestFailure } from "../api-client.mjs";
import { button, element, focusSaveOutcome, patchChildren, statusBlock } from "../dom.mjs";
import type { DeploymentContext } from "./deployment-evidence.mjs";
import { displayDate, message, neutralDeploymentOutcome } from "./list.mjs";

// The console's delay for loading text (console.css .delayed-status): a diagnostics answer within
// it never shows the waiting line (finding 1714).
const DIAGNOSTICS_WAITING_DELAY_MS = 250;

export function createVersionDiagnostics(
  context: DeploymentContext,
  path: string,
  revisionId: string,
  recordedStatus: () => AgentDeploymentStatusWire | null,
  operateAllowed: Promise<boolean | undefined>,
) {
  const section = element("section", { className: "agent-card version-diagnostics" });
  let diagnostics: AgentDeploymentDiagnosticsWire | null = null;
  // Set when the caller's permission answer denies Agent operate, which diagnostics need: the
  // button is disabled with the reason (finding 1992).
  let operateDenied = false;
  let error: unknown = null;
  let loading = false;
  // Set once a run outlasts DIAGNOSTICS_WAITING_DELAY_MS: the waiting line replaces the last
  // result and the button disables itself.
  let waitingShown = false;
  // The id of the result that describes the button after a run. render() sets it on both: a
  // deployment poll re-renders the panel, and patchChildren drops attributes that render()
  // does not set (finding 1712).
  let outcomeId: string | null = null;

  async function run() {
    if (loading || operateDenied || !context.isCurrent()) {
      return;
    }
    loading = true;
    const runButton = section.querySelector<HTMLButtonElement>(".deployment-heading button");
    // Until the delay passes, the last result and the focused button stay as they are, so a fast
    // answer replaces the result directly: no waiting line is painted or announced, and focus
    // does not move (finding 1714). A second press meanwhile does nothing.
    let waitingLine: HTMLElement | null = null;
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
      waitingLine = section.querySelector<HTMLElement>(':scope > [role="status"]');
      if (onButton) {
        focusSaveOutcome(section, [], waitingLine);
      }
    }, DIAGNOSTICS_WAITING_DELAY_MS);
    let answer: AgentDeploymentDiagnosticsWire | null = null;
    let failure: unknown = null;
    try {
      answer = (await context.request(
        `${path}/deployments/${encodeURIComponent(revisionId)}/diagnostics`,
        { method: "POST", readOnly: true },
      )) as AgentDeploymentDiagnosticsWire;
    } catch (cause) {
      if (!context.isCurrent()) {
        return;
      }
      if (requestFailure(cause).status === 401) {
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
        if (waited && runButton) {
          const outcome = error
            ? section.querySelector<HTMLElement>('[role="alert"]')
            : section.querySelector<HTMLElement>(":scope > :last-child > :first-child");
          focusSaveOutcome(section, [runButton], outcome);
          outcomeId = runButton.getAttribute("aria-describedby") ? (outcome?.id ?? null) : null;
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
      ...scopeExplanations(diagnostics.checks),
    );
  }

  // The gateway checks cover only the Slack channel. Say what their results do
  // and do not mean, and keep a recorded deployment failure in view: nothing
  // here tests model credentials, so no check can confirm or clear it.
  function scopeExplanations(checks: AgentDeploymentDiagnosticsWire["checks"]) {
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
    const { status } = requestFailure(error);
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
      ...(error != null
        ? [
            statusBlock(
              "danger",
              null,
              status === 403
                ? "Diagnostics require Agent read and operate access plus read access to this version. Ask a Namespace administrator to confirm those grants."
                : status === 503
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
  void operateAllowed.then((permitted) => {
    if (permitted === false && context.isCurrent()) {
      operateDenied = true;
      render();
    }
  });
  return { section, render };
}
