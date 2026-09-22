import { button, element } from "../dom.mjs";
import { message } from "./list.mjs";

export function createAgentDeletion(context, path, agent, onDeleting) {
  const section = element("section", {
    className: "agent-card deletion-note",
    "aria-labelledby": "agent-deletion-title",
  });
  const feedback = element("div");
  const actions = element("div", { className: "form-actions" });
  const remove = button("Delete Agent", openConfirmation, { className: "danger" });
  const refresh = button("Refresh deletion status", () => void refreshStatus());
  const state = {
    deleting: agent.status === "deleting",
    pending: false,
    needsRefresh: false,
    notice: "",
    error: null,
  };

  section.append(
    element("h2", { id: "agent-deletion-title" }, "Delete Agent"),
    element(
      "p",
      { className: "muted" },
      "Permanently delete this Agent, its revision history, and its workspace data. Namespace-owned Configurations and Secrets are kept. This cannot be undone.",
    ),
    feedback,
    actions,
  );

  function render() {
    const status = state.deleting
      ? "Deletion in progress. Cleanup runs in the background; this Agent cannot be edited or deployed."
      : state.notice;
    feedback.replaceChildren(
      ...(status ? [element("p", { className: "notice", role: "status" }, status)] : []),
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
    remove.disabled = state.pending || state.needsRefresh;
    refresh.disabled = state.pending;
    refresh.textContent = state.pending ? "Checking…" : "Refresh deletion status";
    if (state.deleting) {
      actions.replaceChildren(refresh);
    } else if (state.needsRefresh) {
      actions.replaceChildren(remove, refresh);
    } else {
      actions.replaceChildren(remove);
    }
  }

  function setDeleting() {
    state.deleting = true;
    state.needsRefresh = false;
    state.notice = "";
    onDeleting();
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
        setDeleting();
      } else if (current?.status === "active" && !state.deleting) {
        state.needsRefresh = false;
        state.notice = "The Agent is still active. You can try deleting it again.";
      } else {
        throw new Error("Invalid deletion status");
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
          text: `Could not refresh deletion status. ${message(error)}`,
          requestId: error.requestId,
        };
      }
    } finally {
      if (context.isCurrent()) {
        state.pending = false;
        render();
        (state.deleting || state.needsRefresh ? refresh : remove).focus();
      }
    }
  }

  async function deleteAgent(dialog, cancel, confirm) {
    if (state.pending || state.needsRefresh || !context.isCurrent()) {
      return;
    }
    state.pending = true;
    state.error = null;
    state.notice = "";
    cancel.disabled = true;
    confirm.disabled = true;
    confirm.textContent = "Deleting…";
    render();
    try {
      const current = await context.request(path, { method: "DELETE" });
      if (!context.isCurrent()) {
        return;
      }
      if (current?.status !== "deleting") {
        throw new Error("Invalid deletion response");
      }
      dialog.close();
      setDeleting();
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
          "You do not have permission to delete this Agent. Ask an administrator for Agent delete access.";
      } else if (error.status === 404) {
        state.needsRefresh = true;
        text =
          "This Agent is no longer available for deletion. Refresh its status to return to the Agents list if it is gone.";
      } else if (error.status === 409) {
        state.needsRefresh = true;
        text =
          "This Agent could not be deleted in its current state. Refresh its status before trying again.";
      } else if ([400, 429].includes(error.status)) {
        text = message(error);
      } else {
        state.needsRefresh = true;
        text =
          "Outcome unknown. Deletion may have started. Refresh deletion status before trying again.";
      }
      state.error = { text, requestId: error.requestId };
    } finally {
      if (context.isCurrent()) {
        state.pending = false;
        render();
        (state.deleting || state.needsRefresh ? refresh : remove).focus();
      }
    }
  }

  function openConfirmation() {
    if (state.pending || state.deleting || state.needsRefresh) {
      return;
    }
    const dialog = element("dialog", {
      className: "agent-delete-dialog",
      "aria-labelledby": "agent-delete-confirm-title",
      "aria-describedby": "agent-delete-confirm-description",
    });
    const cancel = button("Cancel", () => dialog.close());
    const confirm = button(
      "Permanently delete Agent",
      () => void deleteAgent(dialog, cancel, confirm),
      {
        className: "danger",
      },
    );
    dialog.append(
      element("h2", { id: "agent-delete-confirm-title" }, `Delete ${agent.name}?`),
      element(
        "p",
        { id: "agent-delete-confirm-description" },
        "This permanently deletes the Agent, its revision history, and its workspace data. This cannot be undone.",
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
        if (context.isCurrent() && !state.pending) {
          (state.deleting || state.needsRefresh ? refresh : remove).focus();
        }
      },
      { once: true },
    );
    section.append(dialog);
    dialog.showModal();
    cancel.focus();
  }

  render();
  return section;
}
