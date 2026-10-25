import type { AgentRead } from "@openclaw-enterprise/contracts";
import { requestFailure, responseFields } from "../api-client.mjs";
import { button, element, setHidden, setText, statusBlock } from "../dom.mjs";
import {
  type AgentLifecycleContext,
  DELETE_CONFIRMATION,
  keptResources,
} from "./lifecycle-confirmation.mjs";
import { message } from "./list.mjs";
import { requestAgentDeletion } from "./deletion-status.mjs";

export function createAgentDeletion(
  context: AgentLifecycleContext,
  path: string,
  agent: AgentRead,
  onDeleting: (options?: { receiptId?: string }) => void,
  allowed?: Promise<boolean | undefined>,
) {
  // One row of the Agent page's danger zone (UX spec 3.9); the confirmation carries the detail.
  const section = element("section", {
    className: "danger-zone-row deletion-note",
    "aria-labelledby": "agent-deletion-title",
  });
  const permissionNotice = "Your access does not include deleting this Agent.";
  let restrictConfirmation: (() => void) | undefined;
  const feedback = element("div", { className: "danger-zone-feedback" });
  const actions = element("div", { className: "danger-zone-actions" });
  const remove = button("Delete Agent", openConfirmation, { className: "danger" });
  const refresh = button("Refresh deletion status", () => void refreshStatus(), {
    tone: "ghost",
    size: "sm",
  });
  const state = { pending: false, forbidden: false, needsRefresh: false, used: false };
  const heading = element("h3", { id: "agent-deletion-title", tabindex: "-1" }, "Delete Agent");

  section.append(
    element(
      "div",
      { className: "danger-zone-text" },
      heading,
      element(
        "p",
        { className: "muted" },
        "Permanently deletes this Agent, its versions and its workspace data. Cannot be undone.",
      ),
    ),
    actions,
    feedback,
  );

  // Only an uncertain or conflicting initial write needs to reread the Agent itself. If it
  // did enter deletion, follow the status endpoint without inventing the receipt we did not get.
  async function refreshStatus() {
    if (state.pending || !context.isCurrent()) {
      return;
    }
    state.pending = true;
    setText(refresh, "Checking…");
    try {
      const current = responseFields(await context.request(path, { expectedStatus: 200 }));
      if (!context.isCurrent()) {
        return;
      }
      if (current.id !== agent.id || current.namespaceId !== agent.namespaceId) {
        throw new Error("The response did not identify this Agent.");
      }
      if (current.status === "deleting") {
        onDeleting();
      } else if (current.status === "active") {
        state.needsRefresh = false;
        state.pending = false;
        render("The Agent is still active. You can try deleting it again.", "info");
        if (document.activeElement === document.body) {
          remove.focus();
        }
      } else {
        throw new Error("The response did not identify this Agent’s status.");
      }
    } catch (cause) {
      if (!context.isCurrent()) {
        return;
      }
      const { status } = requestFailure(cause);
      if (status === 401) {
        context.onExpired();
      } else if (status === 403 || status === 404) {
        onDeleting();
      } else {
        render("Could not refresh deletion status. " + message(cause), "danger");
      }
    } finally {
      state.pending = false;
      setText(refresh, "Refresh deletion status");
    }
  }

  function render(text?: string, tone: "info" | "danger" = "info") {
    if (text) {
      feedback.replaceChildren(statusBlock(tone, null, text));
    }
    remove.disabled = state.needsRefresh || state.forbidden || state.pending;
    setHidden(refresh, !state.needsRefresh);
    setHidden(section, state.forbidden && !state.used);
  }

  function showSending(cancel: HTMLButtonElement, confirm: HTMLButtonElement) {
    cancel.disabled = true;
    confirm.disabled = true;
    confirm.textContent = "Deleting…";
    // Busy, not merely disabled: the progress cursor, and "working" for assistive technology.
    confirm.setAttribute("aria-busy", "true");
  }

  async function deleteAgent(
    dialog: HTMLDialogElement,
    cancel: HTMLButtonElement,
    confirm: HTMLButtonElement,
  ) {
    if (state.pending || state.forbidden || state.needsRefresh || !context.isCurrent()) {
      return;
    }
    state.pending = true;
    showSending(cancel, confirm);
    render();
    try {
      const receiptId = await requestAgentDeletion(context, path, agent);
      if (context.isCurrent()) {
        dialog.close();
        onDeleting({ receiptId });
      }
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
        text =
          "You do not have permission to delete this Agent. Ask an administrator for Agent delete access.";
      } else if (error.status === 404) {
        state.needsRefresh = true;
        text =
          "This Agent is no longer available for deletion. Refresh its status to check what happened.";
      } else if (error.status === 409) {
        state.needsRefresh = true;
        text =
          "This Agent could not be deleted in its current state. Refresh its status before trying again.";
      } else if (error.status === 400 || error.status === 429) {
        text = message(cause);
      } else {
        state.needsRefresh = true;
        text =
          "Outcome unknown. Deletion may have started. Refresh deletion status before trying again.";
      }
      render(error.requestId ? text + " Request ID: " + error.requestId : text, "danger");
    } finally {
      if (context.isCurrent()) {
        state.pending = false;
        render();
        (state.needsRefresh ? refresh : remove).focus();
      }
    }
  }

  function openConfirmation() {
    if (state.forbidden || state.pending || state.needsRefresh) {
      return;
    }
    state.used = true;
    const dialog = element("dialog", {
      className: "dialog agent-delete-dialog",
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
    const description = element(
      "p",
      { id: "agent-delete-confirm-description", "aria-live": "polite" },
      DELETE_CONFIRMATION,
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
    const kept = keptResources(agent);
    dialog.append(
      element("h2", { id: "agent-delete-confirm-title" }, `Delete ${agent.name}?`),
      description,
      kept.summary,
      kept.commands,
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
        // After Cancel the browser returns focus to the invoker. A sent request may already
        // have focused its outcome or opened the deletion status page.
        if (context.isCurrent() && !state.pending && document.activeElement === document.body) {
          (state.forbidden ? heading : state.needsRefresh ? refresh : remove).focus();
        }
      },
      { once: true },
    );
    section.append(dialog);
    dialog.showModal();
    cancel.focus();
  }

  actions.append(remove, refresh);
  render();
  void allowed?.then((permitted) => {
    if (permitted === false && context.isCurrent()) {
      state.forbidden = true;
      restrictConfirmation?.();
      render(state.used ? permissionNotice : undefined);
    }
  });
  return { section };
}
