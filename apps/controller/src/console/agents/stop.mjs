import { button, element } from "../dom.mjs";
import { message, shortId } from "./list.mjs";

export function createAgentStop(context, path, agent, onDeleting, onAgentChanged = () => {}) {
  const section = element("section", {
    className: "agent-card stop-note",
    "aria-labelledby": "agent-stop-title",
  });
  const feedback = element("div");
  const actions = element("div", { className: "form-actions" });
  const stop = button("Stop Agent", openConfirmation, { className: "danger" });
  const refresh = button("Refresh stop status", () => void refreshStatus());
  const repeat = button("Request Stop again", openConfirmation, { className: "danger" });
  const state = {
    agent,
    pending: false,
    needsRefresh: false,
    notice: "",
    error: null,
  };

  section.append(
    element("h2", { id: "agent-stop-title" }, "Stop Agent"),
    element(
      "p",
      { className: "muted" },
      "Stop interrupts the current runtime gateway. Configuration, versions, Credentials, and workspace data are retained.",
    ),
    feedback,
    actions,
  );

  function render() {
    const requested = state.agent.desiredRuntimeState === "stopped";
    feedback.replaceChildren(
      element(
        "dl",
        { className: "credential-status-list" },
        element("dt", {}, "Requested runtime state"),
        element("dd", {}, requested ? "Stopped" : "Running"),
        element("dt", {}, "Current version"),
        element(
          "dd",
          {},
          state.agent.activeRevisionId
            ? `Version ${shortId(state.agent.activeRevisionId)}`
            : "No current version",
        ),
      ),
      ...(requested
        ? [
            element(
              "p",
              { className: "notice", role: "status" },
              // Initial drafts and completed stops both have no selected revision.
              state.agent.activeRevisionId
                ? "Stop requested. OCC will not start this Agent again until you deploy a new version. Runtime shutdown completion is not exposed in Console."
                : "No version is selected. Deploy a new version to start this Agent.",
            ),
          ]
        : []),
      ...(state.notice
        ? [element("p", { className: "notice", role: "status" }, state.notice)]
        : []),
      ...(state.error
        ? [
            element(
              "div",
              { className: "error", role: "alert" },
              element("p", {}, state.error.text),
              state.error.requestId
                ? element("p", { className: "request-id" }, `Request ID: ${state.error.requestId}`)
                : null,
            ),
          ]
        : []),
    );
    stop.disabled = requested || state.pending || state.needsRefresh;
    repeat.disabled = state.pending || state.needsRefresh;
    refresh.disabled = state.pending;
    refresh.textContent = state.pending ? "Checking…" : "Refresh stop status";
    if (requested || state.needsRefresh) {
      actions.replaceChildren(stop, ...(requested ? [repeat] : []), refresh);
    } else {
      actions.replaceChildren(stop);
    }
  }

  function setAgent(next) {
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
    state.pending = true;
    state.error = null;
    render();
    try {
      const current = await context.request(path);
      if (!context.isCurrent()) {
        return;
      }
      if (current?.status === "deleting") {
        onDeleting();
        return;
      }
      if (current?.status === "active") {
        setAgent(current);
      } else {
        throw new Error("Invalid Agent stop status");
      }
    } catch (error) {
      if (!context.isCurrent()) {
        return;
      }
      if (error.status === 401) {
        context.onExpired();
      } else if (error.status === 404) {
        context.navigate("agents");
      } else {
        state.error = {
          text: `Could not refresh stop status. ${message(error)}`,
          requestId: error.requestId,
        };
      }
    } finally {
      if (context.isCurrent()) {
        state.pending = false;
        render();
        (state.needsRefresh || state.agent.desiredRuntimeState === "stopped"
          ? refresh
          : stop
        ).focus();
      }
    }
  }

  async function stopAgent(dialog, cancel, confirm) {
    if (state.pending || state.needsRefresh) {
      return;
    }
    state.pending = true;
    state.error = null;
    state.notice = "";
    cancel.disabled = true;
    confirm.disabled = true;
    confirm.textContent = "Stopping…";
    render();
    try {
      const stopped = await context.request(`${path}/stop`, { method: "POST" });
      if (!context.isCurrent()) {
        return;
      }
      if (stopped?.status === "deleting") {
        dialog.close();
        onDeleting();
        return;
      }
      if (stopped?.status !== "active" || stopped?.desiredRuntimeState !== "stopped") {
        throw new Error("Invalid Agent stop response");
      }
      dialog.close();
      setAgent(stopped);
    } catch (error) {
      if (!context.isCurrent()) {
        return;
      }
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      dialog.close();
      let text;
      if (error.status === 403) {
        text =
          "You do not have permission to stop this Agent. Ask an administrator for Agent operate access.";
      } else if (error.status === 404) {
        state.needsRefresh = true;
        text =
          "This Agent is no longer available for stopping. Refresh stop status to return to the Agents list if it is gone.";
      } else if (error.status === 409) {
        state.needsRefresh = true;
        text =
          "This Agent lifecycle changed while stopping. Refresh stop status before trying again.";
      } else if ([400, 429].includes(error.status)) {
        text = message(error, true);
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
        (state.needsRefresh || state.agent.desiredRuntimeState === "stopped"
          ? refresh
          : stop
        ).focus();
      }
    }
  }

  function openConfirmation(event) {
    if (state.pending || state.needsRefresh) {
      return;
    }
    const invoker = event.currentTarget;
    let submitted = false;
    const dialog = element("dialog", {
      className: "agent-stop-dialog",
      "aria-labelledby": "agent-stop-confirm-title",
      "aria-describedby": "agent-stop-confirm-description",
    });
    const cancel = button("Cancel", () => dialog.close());
    const confirm = button(
      "Stop Agent",
      () => {
        submitted = true;
        void stopAgent(dialog, cancel, confirm);
      },
      { className: "danger" },
    );
    dialog.append(
      element("h2", { id: "agent-stop-confirm-title" }, `Stop ${state.agent.name}?`),
      element(
        "p",
        { id: "agent-stop-confirm-description" },
        "This interrupts the current runtime gateway and ends any reply in progress; open chats can keep showing it as responding. Configuration, versions, Credentials, and workspace data are retained. Deploy a new version to start the Agent again.",
      ),
      element("div", { className: "form-actions" }, cancel, confirm),
    );
    dialog.addEventListener("cancel", (event) => {
      if (state.pending) {
        event.preventDefault();
      }
    });
    dialog.addEventListener(
      "close",
      () => {
        dialog.remove();
        if (context.isCurrent() && !state.pending && !submitted) {
          if (invoker.isConnected && !invoker.disabled) {
            invoker.focus();
          } else {
            (state.needsRefresh || state.agent.desiredRuntimeState === "stopped"
              ? refresh
              : stop
            ).focus();
          }
        }
      },
      { once: true },
    );
    section.append(dialog);
    dialog.showModal();
    cancel.focus();
  }

  render();
  return {
    section,
    updateAgent(next) {
      if (state.pending) {
        return;
      }
      state.agent = next;
      state.needsRefresh = false;
      state.notice = "";
      render();
    },
  };
}
