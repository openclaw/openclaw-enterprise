import { button, element } from "../dom.mjs";
import { message } from "./list.mjs";

// Deletion finishes in the background; poll until the Agent is gone, then return to the list.
export const DELETION_POLL_MS = 3000;

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
    // Finishing the deletion removes the bindings that target this Agent, so a deleter whose
    // only grants came from them can no longer read it.
    accessEnded: false,
    notice: "",
    error: null,
  };
  let pollTimer;
  const heading = element("h2", { id: "agent-deletion-title", tabindex: "-1" }, "Delete Agent");

  section.append(
    heading,
    element(
      "p",
      { className: "muted" },
      "Permanently delete this Agent, its version history, and its workspace data. Namespace-owned Configurations and Secrets are kept. This cannot be undone.",
    ),
    feedback,
    actions,
  );

  function render() {
    const status = state.accessEnded
      ? "Deletion was accepted. Your access to this Agent ended with it, so this page cannot follow the cleanup."
      : state.deleting
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
    if (state.accessEnded) {
      actions.replaceChildren();
    } else if (state.deleting) {
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
    schedulePoll();
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => {
      if (context.isCurrent() && state.deleting && !state.accessEnded) {
        void refreshStatus({ poll: true });
      }
    }, DELETION_POLL_MS);
  }

  async function refreshStatus({ poll = false } = {}) {
    if (state.pending || !context.isCurrent()) {
      if (poll && state.deleting && context.isCurrent()) {
        schedulePoll();
      }
      return;
    }
    // Disabling Refresh while it checks drops its focus, so remember where focus was first.
    const focusedHere =
      section.contains(document.activeElement) || document.activeElement === document.body;
    state.pending = true;
    state.error = null;
    render();
    try {
      const current = await context.request(path);
      if (!context.isCurrent()) {
        return;
      }
      if (current?.status === "deleting") {
        if (state.deleting) {
          schedulePoll();
        } else {
          setDeleting();
        }
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
      } else if (error.status === 403 && state.deleting) {
        // Most likely the finished deletion removed the bindings that target this Agent, so a
        // reader with only those grants can no longer follow it. Stop polling instead of
        // showing a denial.
        state.accessEnded = true;
        clearTimeout(pollTimer);
      } else {
        state.error = {
          text: `Could not refresh deletion status. ${message(error)}`,
          requestId: error.requestId,
        };
        // Stop polling on errors; the reader can retry with Refresh deletion status.
      }
    } finally {
      if (context.isCurrent()) {
        state.pending = false;
        render();
        if (state.accessEnded) {
          // Refresh is gone, so keep focus in this section on its heading.
          if (focusedHere) {
            heading.focus({ preventScroll: true });
          }
        } else if (!poll) {
          (state.deleting || state.needsRefresh ? refresh : remove).focus();
        }
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

  // Agent deletion keeps the Configuration and model credential Secret, even ones Create Agent made
  // for this Agent, and the console cannot list or delete them, so name them and the commands.
  function keptResourcesText() {
    const source = agent.harnessAuth?.source;
    if (source?.kind !== "secret") {
      return `Its Configuration is kept, even if it was created with this Agent. Once nothing else uses it, delete it with occ configuration delete ${agent.configurationId}.`;
    }
    return `Its Configuration and model credential Secret are kept, even if they were created with this Agent. Once nothing else uses them, delete them with occ configuration delete ${agent.configurationId} and occ secret delete ${source.id}.`;
  }

  function openConfirmation() {
    if (state.pending || state.deleting || state.needsRefresh) {
      return;
    }
    const dialog = element("dialog", {
      className: "agent-delete-dialog",
      "aria-labelledby": "agent-delete-confirm-title",
      "aria-describedby": "agent-delete-confirm-description agent-delete-confirm-kept",
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
        "This permanently deletes the Agent, its version history, and its workspace data. This cannot be undone.",
      ),
      element("p", { id: "agent-delete-confirm-kept" }, keptResourcesText()),
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
  if (state.deleting) {
    schedulePoll();
  }
  return section;
}
