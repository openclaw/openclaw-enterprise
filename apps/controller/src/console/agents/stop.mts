import type { AgentRead } from "@openclaw-enterprise/contracts";
import { requestFailure, responseFields } from "../api-client.mjs";
import {
  button,
  element,
  mayReturnFocus,
  setHidden,
  setText,
  statusBlock,
  requestIdLine,
} from "../dom.mjs";
import {
  type AgentLifecycleContext,
  type LifecycleError,
  cancelsFirstDeployment,
  stopConfirmation,
} from "./lifecycle-confirmation.mjs";
import { AGENT_STOP_DENIED, stopRefused } from "./access-reasons.mjs";
import { AGENT_STATUS_READ_NEED, describeFailure, shortId } from "./list.mjs";

export function createAgentStop(
  context: AgentLifecycleContext,
  path: string,
  agent: AgentRead,
  onDeleting: (options: { focus: boolean }) => void,
  onAgentChanged: (next: AgentRead) => void,
  allowed?: Promise<boolean | undefined>,
) {
  // One row of the Agent page's danger zone (UX spec 3.9); the confirmation carries the detail.
  const section = element("section", {
    className: "danger-zone-row stop-note",
    "aria-labelledby": "agent-stop-title",
  });
  const permissionNotice = AGENT_STOP_DENIED;
  const STOP_REFUSED = stopRefused("this Agent");
  let restrictConfirmation: (() => void) | undefined;
  const feedback = element("div", { className: "danger-zone-feedback" });
  const actions = element("div", { className: "danger-zone-actions" });
  const stop = button("Stop Agent", openConfirmation, { className: "danger" });
  const refresh = button("Refresh stop status", () => void refreshStatus(), {
    tone: "ghost",
    size: "sm",
  });
  const repeat = button("Request Stop again", openConfirmation, { className: "danger" });
  const state: {
    agent: AgentRead;
    pending: boolean;
    forbidden: boolean;
    needsRefresh: boolean;
    notice: string;
    error: LifecycleError | null;
    /** Undefined while the list loads, null if it failed. */
    noReadableVersions: boolean | null | undefined;
    versionLabel(id: string): string | undefined;
    used: boolean;
    /**
     * The status of the latest deployment the detail page read, or null when this viewer cannot
     * read it (no readable version, or a failed read). Undefined until the page knows.
     */
    latestDeployment: string | null | undefined;
    /** This viewer's Stop cancelled a first deployment, before any version was selected. */
    cancelledFirstDeployment: boolean;
  } = {
    agent,
    pending: false,
    forbidden: false,
    needsRefresh: false,
    notice: "",
    error: null,
    noReadableVersions: undefined,
    // The page's "vN" label for a version id, once its version list loads.
    versionLabel: () => undefined,
    // Set once this viewer opens Stop or refreshes here, so the row never vanishes under them.
    used: false,
    latestDeployment: undefined,
    cancelledFirstDeployment: false,
  };

  // Focus lands here when the control that would take it is not rendered.
  const title = element("h3", { id: "agent-stop-title", tabindex: "-1" }, "Stop Agent");
  const summary = element("p", { className: "muted" });
  section.append(
    element("div", { className: "danger-zone-text" }, title, summary),
    actions,
    feedback,
  );

  function render() {
    const requested = state.agent.desiredRuntimeState === "stopped";
    // A first deployment that failed leaves the Agent requested to run with no version selected:
    // Stop would change nothing, so the row is hidden, as on the Agents list (findings 2385,
    // D691). Only a failure this page read decides it. A succeeded deployment read against an
    // older Agent read, an unreadable deployment, or a failed read keeps Stop, and the API answers
    // if nothing runs.
    const idle = !requested && !state.agent.activeRevisionId && state.latestDeployment === "failed";
    setText(
      summary,
      cancelsFirstDeployment(state.agent, state.latestDeployment)
        ? "Cancels the deployment in progress. The Agent stays and can be deployed again."
        : "Stops the running version. The Agent stays and can be deployed again.",
    );
    // A running Agent's row is the title, its sentence and Stop; the overview already shows the
    // current version. After a stop request the row reports what Refresh reads back.
    feedback.replaceChildren(
      ...(requested
        ? [
            element(
              "dl",
              { className: "credential-status-list" },
              element("dt", {}, "Requested runtime state"),
              element("dd", {}, "Stopped"),
              element("dt", {}, "Current version"),
              element(
                "dd",
                {},
                state.agent.activeRevisionId
                  ? (state.versionLabel(state.agent.activeRevisionId) ??
                      `Version ${shortId(state.agent.activeRevisionId)}`)
                  : "No current version",
              ),
            ),
            statusBlock(
              "info",
              null,
              // Initial drafts and completed stops both have no selected revision.
              state.agent.activeRevisionId
                ? "Stop requested. This Agent will not start again until you deploy a new version. The console does not show when its runtime finishes shutting down."
                : state.cancelledFirstDeployment
                  ? "Stop requested. The deployment in progress is cancelled, and this Agent will not start until you deploy a new version."
                  : "No version is selected. Deploy a new version to start this Agent.",
            ),
          ]
        : []),
      ...(idle && !state.forbidden
        ? [
            statusBlock(
              "info",
              null,
              "No version is running, so there is nothing to stop. Deploy a new version to start this Agent.",
            ),
          ]
        : []),
      ...(state.forbidden ? [statusBlock("info", null, permissionNotice)] : []),
      ...(state.notice ? [statusBlock("info", null, state.notice)] : []),
      ...(state.error
        ? [
            element(
              "div",
              { className: "status", "data-tone": "danger", role: "alert" },
              element("p", { className: "status-body" }, state.error.text),
              state.error.requestId ? requestIdLine(state.error.requestId) : null,
            ),
          ]
        : []),
    );
    stop.disabled = requested || state.pending || state.needsRefresh || state.forbidden || idle;
    repeat.disabled = state.pending || state.needsRefresh || state.forbidden;
    refresh.disabled = state.pending;
    refresh.textContent = state.pending ? "Checking…" : "Refresh stop status";
    // An Agent created through the API starts stopped and has no version until its first
    // deploy, so there is nothing to stop or to check (finding 1394), and the row is hidden
    // (finding 1899). Only what this viewer can read decides it: a member who reads no version
    // of a deployed Agent sees the same. While the version list loads, the row stays hidden.
    const neverStarted =
      requested &&
      !state.agent.activeRevisionId &&
      (state.noReadableVersions === true || state.noReadableVersions === undefined) &&
      !state.pending &&
      !state.needsRefresh;
    // A viewer whose permission answer denies Agent operate has no row either (UX spec 3.9).
    // A missing answer keeps it, and the API still decides. An answer that lands while this
    // viewer has the confirmation open keeps the row, so the reason stays where they were.
    setHidden(section, (neverStarted || idle || state.forbidden) && !state.used);
    // After a request, a disabled Stop beside Request Stop again only adds noise, and an
    // uncertain outcome offers only Refresh (finding 1899).
    if (neverStarted || (idle && !state.used)) {
      actions.replaceChildren();
    } else if (state.needsRefresh) {
      actions.replaceChildren(refresh);
    } else if (requested) {
      actions.replaceChildren(repeat, refresh);
    } else {
      actions.replaceChildren(stop);
    }
  }

  function focusStatusControl() {
    const target =
      state.needsRefresh || state.agent.desiredRuntimeState === "stopped" ? refresh : stop;
    (target.isConnected && !target.disabled ? target : title).focus();
  }

  function readStopStatus(value: unknown): AgentRead | { status: "deleting" } {
    const { id, namespaceId, status, desiredRuntimeState, activeRevisionId } =
      responseFields(value);
    if (id !== agent.id || namespaceId !== agent.namespaceId) {
      throw new Error("Stop status did not identify this Agent");
    }
    if (status === "deleting") {
      return { status };
    }
    if (
      status !== "active" ||
      (desiredRuntimeState !== "running" && desiredRuntimeState !== "stopped") ||
      (activeRevisionId !== undefined &&
        (typeof activeRevisionId !== "string" || !activeRevisionId))
    ) {
      throw new Error("Invalid Agent stop status");
    }
    // Stop updates only these lifecycle fields. Keep the detail page's known Agent metadata.
    const { activeRevisionId: _previousRevision, ...previous } = state.agent;
    return {
      ...previous,
      status,
      desiredRuntimeState,
      ...(activeRevisionId === undefined ? {} : { activeRevisionId }),
    };
  }

  function setAgent(next: AgentRead) {
    const lifecycleChanged =
      state.agent.desiredRuntimeState !== next.desiredRuntimeState ||
      state.agent.activeRevisionId !== next.activeRevisionId;
    state.agent = next;
    state.needsRefresh = false;
    state.notice =
      next.desiredRuntimeState === "stopped" ? "" : "The Agent is still requested to run.";
    if (lifecycleChanged) {
      onAgentChanged(next);
    }
  }

  async function refreshStatus() {
    if (state.pending || !context.isCurrent()) {
      return;
    }
    // Disabling Refresh can drop focus to the page. Return it only if the operator stayed here.
    let returnFocus = document.activeElement === refresh;
    const focusMoved = () => {
      returnFocus = false;
    };
    state.pending = true;
    state.used = true;
    state.error = null;
    render();
    document.addEventListener("focusin", focusMoved, { once: true });
    try {
      const response = await context.request(path, { expectedStatus: 200 });
      if (!context.isCurrent()) {
        return;
      }
      const current = readStopStatus(response);
      if (current.status === "deleting") {
        onDeleting({ focus: returnFocus });
        return;
      }
      setAgent(current);
    } catch (cause) {
      if (!context.isCurrent()) {
        return;
      }
      const error = requestFailure(cause);
      if (error.status === 401) {
        context.onExpired();
      } else if (error.status === 404) {
        context.navigate("agents");
      } else {
        state.error = {
          text: `Could not refresh stop status. ${describeFailure(cause, { need: AGENT_STATUS_READ_NEED })}`,
          requestId: error.requestId,
        };
      }
    } finally {
      document.removeEventListener("focusin", focusMoved);
      if (context.isCurrent()) {
        state.pending = false;
        render();
        if (returnFocus) {
          focusStatusControl();
        }
      }
    }
  }

  async function stopAgent(
    dialog: HTMLDialogElement,
    cancel: HTMLButtonElement,
    confirm: HTMLButtonElement,
  ) {
    if (state.forbidden || state.pending || state.needsRefresh || !context.isCurrent()) {
      return;
    }
    state.pending = true;
    state.used = true;
    state.error = null;
    state.notice = "";
    cancel.disabled = true;
    confirm.disabled = true;
    confirm.textContent = "Stopping…";
    // Busy, not merely disabled: the progress cursor, and "working" for assistive technology.
    confirm.setAttribute("aria-busy", "true");
    render();
    try {
      const response = await context.request(`${path}/stop`, {
        method: "POST",
        expectedStatus: 202,
      });
      if (!context.isCurrent()) {
        return;
      }
      const stopped = readStopStatus(response);
      if (stopped.status === "deleting") {
        dialog.close();
        onDeleting({ focus: true });
        return;
      }
      if (stopped.desiredRuntimeState !== "stopped") {
        throw new Error("Invalid Agent stop response");
      }
      // Only a stop whose dialog said it cancels a deployment in progress reports that it did.
      state.cancelledFirstDeployment =
        cancelsFirstDeployment(state.agent, state.latestDeployment) && !stopped.activeRevisionId;
      dialog.close();
      setAgent(stopped);
    } catch (cause) {
      if (!context.isCurrent()) {
        return;
      }
      const error = requestFailure(cause);
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      dialog.close();
      let text;
      if (error.status === 403) {
        text = STOP_REFUSED;
      } else if (error.status === 404) {
        state.needsRefresh = true;
        text =
          "This Agent is no longer available for stopping. Refresh stop status to return to the Agents list if it is gone.";
      } else if (error.status === 400 || error.status === 409 || error.status === 429) {
        // The API's own reason for a 400 or 409, such as a lifecycle change during the stop.
        state.needsRefresh = error.status === 409;
        text = describeFailure(cause, {
          mutation: true,
          conflict: "This Agent lifecycle changed while stopping.",
          next: "Refresh stop status before trying again.",
        });
      } else {
        state.needsRefresh = true;
        text =
          "Outcome unknown. Stop may have been accepted. Refresh stop status before trying again.";
      }
      state.error = { text, requestId: error.requestId };
    } finally {
      if (context.isCurrent()) {
        state.pending = false;
        render();
        focusStatusControl();
      }
    }
  }

  function openConfirmation(event: MouseEvent) {
    if (state.forbidden || state.pending || state.needsRefresh) {
      return;
    }
    const invoker = event.currentTarget;
    // The dialog lives in this card, so the card must not hide while it is open.
    state.used = true;
    let submitted = false;
    const dialog = element("dialog", {
      className: "dialog agent-stop-dialog",
      "aria-labelledby": "agent-stop-confirm-title",
      "aria-describedby": "agent-stop-confirm-target agent-stop-confirm-description",
    });
    const cancel = button("Cancel", () => dialog.close());
    const confirm = button(
      "Stop Agent",
      () => {
        if (state.forbidden) {
          return;
        }
        submitted = true;
        void stopAgent(dialog, cancel, confirm);
      },
      { className: "danger" },
    );
    const description = element(
      "p",
      { id: "agent-stop-confirm-description", "aria-live": "polite" },
      stopConfirmation(state.agent, state.latestDeployment),
    );
    const showRestriction = () => {
      // A late answer cannot undo a request already sent.
      if (!dialog.open || state.pending) {
        return;
      }
      confirm.disabled = true;
      description.textContent = permissionNotice;
      cancel.focus();
    };
    restrictConfirmation = showRestriction;
    dialog.append(
      element("h2", { id: "agent-stop-confirm-title" }, "Stop this Agent?"),
      // The short title no longer names the Agent, so the dialog does, as text.
      element(
        "p",
        { id: "agent-stop-confirm-target" },
        "Agent: ",
        element("strong", {}, state.agent.name),
      ),
      description,
      element("div", { className: "dialog-actions" }, cancel, confirm),
    );
    dialog.addEventListener("cancel", (event) => {
      if (state.pending) {
        event.preventDefault();
      }
    });
    dialog.addEventListener(
      "close",
      () => {
        if (restrictConfirmation === showRestriction) {
          restrictConfirmation = undefined;
        }
        dialog.remove();
        if (context.isCurrent() && !state.pending && !submitted && mayReturnFocus(dialog)) {
          if (invoker instanceof HTMLButtonElement && invoker.isConnected && !invoker.disabled) {
            invoker.focus();
          } else {
            focusStatusControl();
          }
        }
      },
      { once: true },
    );
    section.append(dialog);
    dialog.showModal();
    cancel.focus();
  }

  // The page passes each newer Agent operate answer it reads, so a grant or revocation seen by
  // Logs applies without a reload (finding 2328). Only a denial hides the row; a missing answer
  // keeps it, and the API still decides.
  function applyOperate(permitted: boolean | undefined) {
    const forbidden = permitted === false;
    if (forbidden === state.forbidden || !context.isCurrent()) {
      return;
    }
    state.forbidden = forbidden;
    if (forbidden) {
      restrictConfirmation?.();
    } else if (state.error?.text === STOP_REFUSED) {
      // An earlier refusal no longer describes this viewer's access.
      state.error = null;
    }
    render();
  }
  // Once the page has passed a newer answer, a late first answer must not replace it.
  let operateAnswered = false;

  render();
  void allowed?.then((permitted) => {
    if (!operateAnswered) {
      applyOperate(permitted);
    }
  });
  return {
    section,
    applyOperate(permitted: boolean | undefined) {
      operateAnswered = true;
      applyOperate(permitted);
    },
    // The detail page reports whether its version list loaded empty (true), loaded with
    // versions (false), or failed (null).
    setNoReadableVersions(value: boolean | null) {
      if (state.noReadableVersions === value) {
        return;
      }
      state.noReadableVersions = value;
      render();
    },
    // The detail page reports the latest deployment's status, or null when this viewer cannot
    // read it.
    setLatestDeployment(value: string | null) {
      if (state.latestDeployment === value) {
        return;
      }
      state.latestDeployment = value;
      render();
    },
    // `label(id)` names a version as the page does ("v3"), or is undefined when unlisted. Only a
    // changed label rerenders, so polls do not rewrite the status region.
    setVersionLabel(label: typeof state.versionLabel) {
      const id = state.agent.activeRevisionId;
      const before = id ? state.versionLabel(id) : undefined;
      state.versionLabel = label;
      if (id && label(id) !== before) {
        render();
      }
    },
    updateAgent(next: AgentRead) {
      // Only Refresh stop status settles an uncertain write, not an unrelated detail-page read.
      if (
        state.pending ||
        state.needsRefresh ||
        next.id !== agent.id ||
        next.namespaceId !== agent.namespaceId
      ) {
        return;
      }
      state.agent = next;
      state.notice = "";
      render();
    },
  };
}
