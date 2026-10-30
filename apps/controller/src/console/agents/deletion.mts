import type { AgentRead } from "@openclaw-enterprise/contracts";
import { requestFailure, responseFields } from "../api-client.mjs";
import {
  button,
  element,
  replaceChildrenIfChanged,
  setHidden,
  setText,
  setUnavailable,
  statusBlock,
  requestIdLine,
} from "../dom.mjs";
import {
  type AgentLifecycleContext,
  DELETE_CONFIRMATION,
  type LifecycleError,
  grantRefusal,
  keptResources,
} from "./lifecycle-confirmation.mjs";
import { AGENT_DELETE_DENIED, deleteRefused } from "./access-reasons.mjs";
import { AGENT_STATUS_READ_NEED, describeFailure } from "./list.mjs";

// Deletion finishes in the background; poll until the Agent is gone, then return to the list.
export const DELETION_POLL_MS = 3000;

export function createAgentDeletion(
  context: AgentLifecycleContext,
  path: string,
  agent: AgentRead,
  onDeleting: () => void,
  allowed?: Promise<boolean | undefined>,
  permissionReadsStarted: () => number = () => 0,
) {
  // One row of the Agent page's danger zone (UX spec 3.9); the confirmation carries the detail.
  const section = element("section", {
    className: "danger-zone-row deletion-note",
    "aria-labelledby": "agent-deletion-title",
  });
  const permissionNotice = AGENT_DELETE_DENIED;
  let restrictConfirmation: (() => void) | undefined;
  // The count of the page's permission reads started before the last refused Delete. Only a read
  // started after it can lift the refusal (finding 2966).
  let refusedAfterReads = 0;
  const feedback = element("div", { className: "danger-zone-feedback" });
  const actions = element("div", { className: "danger-zone-actions" });
  const remove = button("Delete Agent", openConfirmation, { className: "danger" });
  const refresh = button("Refresh deletion status", () => void refreshStatus(), {
    tone: "ghost",
    size: "sm",
  });
  const state: {
    deleting: boolean;
    pending: boolean;
    polling: boolean;
    forbidden: boolean;
    needsRefresh: boolean;
    accessEnded: boolean;
    notice: string;
    error: LifecycleError | null;
    used: boolean;
  } = {
    deleting: agent.status === "deleting",
    pending: false,
    // A background poll's read, which the page does not show as a check.
    polling: false,
    forbidden: false,
    needsRefresh: false,
    // Finishing the deletion removes the bindings that target this Agent, so a deleter whose
    // only grants came from them can no longer read it.
    accessEnded: false,
    notice: "",
    error: null,
    // Set once this viewer opens the confirmation, so the row never vanishes under them.
    used: false,
  };
  let pollTimer: number | undefined;
  // A repeat confirmed while a quiet poll reads. Reads and writes stay serialized, so it is sent
  // when that read ends instead of being dropped (finding 1975).
  let queuedDelete: {
    dialog: HTMLDialogElement;
    cancel: HTMLButtonElement;
    confirm: HTMLButtonElement;
  } | null = null;
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

  function render() {
    // A background poll is quiet: its button keeps its label and the notices are rebuilt only
    // when their text changes, so each 3 s poll neither flashes "Checking…" nor re-announces
    // the status (finding 1409).
    const checking = state.pending && !state.polling;
    const status = state.accessEnded
      ? "Deletion was accepted. You can no longer read this Agent’s status, so this page cannot tell whether cleanup has finished."
      : state.deleting
        ? "Deletion was requested. The Agent cannot be edited or deployed. If cleanup has stopped after a failure, fix the cause and request deletion again."
        : state.notice;
    replaceChildrenIfChanged(feedback, [
      ...(status ? [statusBlock("info", null, status)] : []),
      ...(state.forbidden && !state.accessEnded
        ? [statusBlock("info", null, permissionNotice, [], { id: "agent-deletion-refused" })]
        : []),
      ...(state.error
        ? [
            element(
              "div",
              {
                className: "status",
                "data-tone": "danger",
                role: "alert",
                id: "agent-deletion-error",
              },
              element("p", { className: "status-body" }, state.error.text),
              state.error.requestId ? requestIdLine(state.error.requestId) : null,
            ),
          ]
        : []),
    ]);
    setText(remove, state.deleting ? "Request deletion again" : "Delete Agent");
    // A refused Delete, or one that waits for Refresh after a failure, stays in the Tab order,
    // described by the note or alert that says why (finding 2935). The shown nodes are read back:
    // an unchanged render keeps the earlier ones. While checking it stays natively disabled.
    // A permission refusal keeps it unavailable, described by its alert, until a newer
    // permission answer allows delete (finding 2951).
    const removeUnavailable =
      checking || state.needsRefresh || state.forbidden || state.error?.refused === true;
    const removeReason = checking
      ? null
      : feedback.querySelector<HTMLElement>(
          state.forbidden ? "#agent-deletion-refused" : "#agent-deletion-error",
        );
    setUnavailable(remove, removeUnavailable && removeReason !== null, removeReason);
    if (removeUnavailable && removeReason === null) {
      remove.disabled = true;
    }
    refresh.disabled = checking;
    setText(refresh, checking ? "Checking…" : "Refresh deletion status");
    // A viewer whose permission answer denies Agent delete has no row (UX spec 3.9). A missing
    // answer keeps it, and the API still decides. A deleting Agent keeps it: the row is the
    // page's only report of the cleanup.
    setHidden(section, state.forbidden && !state.used && !state.deleting);
    const shown = state.accessEnded
      ? []
      : state.deleting || state.needsRefresh
        ? [remove, refresh]
        : [remove];
    // Reinserting the same buttons would drop focus from them.
    if (
      actions.children.length !== shown.length ||
      shown.some((node, index) => actions.children[index] !== node)
    ) {
      actions.replaceChildren(...shown);
    }
  }

  function setDeleting({ notifyPage = true } = {}) {
    state.deleting = true;
    state.needsRefresh = false;
    state.notice = "";
    schedulePoll();
    if (notifyPage) {
      onDeleting();
    }
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => {
      if (context.isCurrent() && state.deleting && !state.accessEnded) {
        void refreshStatus({ poll: true });
      }
    }, DELETION_POLL_MS);
  }

  // Whether the running check returns focus to this section when it ends.
  let focusedHere = false;
  const focusIsHere = () =>
    section.contains(document.activeElement) || document.activeElement === document.body;

  async function refreshStatus({ poll = false } = {}) {
    if (!poll && state.polling && context.isCurrent()) {
      // Refresh during a quiet poll shows that poll as the requested check.
      focusedHere = focusIsHere();
      state.polling = false;
      render();
      return;
    }
    if (state.pending || !context.isCurrent()) {
      if (poll && state.deleting && context.isCurrent()) {
        schedulePoll();
      }
      return;
    }
    // Disabling or detaching Refresh can drop focus to body without leaving the check.
    // A new focus outside the section relinquishes that return, even if later blurred.
    focusedHere = focusIsHere();
    const trackFocus = ({ target }: FocusEvent) => {
      if (target instanceof Node && target !== document.body && !section.contains(target)) {
        focusedHere = false;
      }
    };
    state.pending = true;
    state.polling = poll;
    state.error = null;
    render();
    document.addEventListener("focusin", trackFocus, true);
    try {
      const current = responseFields(await context.request(path, { expectedStatus: 200 }));
      if (!context.isCurrent()) {
        return;
      }
      if (current.id !== agent.id || current.namespaceId !== agent.namespaceId) {
        throw new Error("Deletion status did not identify this Agent");
      }
      if (current.status === "deleting") {
        if (state.deleting) {
          // A confirmed deleting read settles an uncertain repeat request, too.
          state.needsRefresh = false;
          state.notice = "";
          schedulePoll();
        } else {
          setDeleting();
        }
      } else if (current.status === "active" && !state.deleting) {
        state.needsRefresh = false;
        state.notice = "The Agent is still active. You can try deleting it again.";
      } else {
        throw new Error("Invalid deletion status");
      }
    } catch (cause) {
      if (!context.isCurrent()) {
        return;
      }
      const error = requestFailure(cause);
      if (error.status === 401) {
        context.onExpired();
      } else if (error.status === 404) {
        context.navigate("agents");
      } else if (error.status === 403 && state.deleting) {
        // Cleanup can remove this reader’s grants; access can also end before cleanup finishes.
        // Stop following the deletion without treating this denial as a not-found response.
        state.accessEnded = true;
        clearTimeout(pollTimer);
      } else {
        state.error = {
          text: `Could not refresh deletion status. ${describeFailure(cause, { need: AGENT_STATUS_READ_NEED })}`,
          requestId: error.requestId,
        };
        // Stop polling on errors; the reader can retry with Refresh deletion status.
      }
    } finally {
      document.removeEventListener("focusin", trackFocus, true);
      const queued = queuedDelete;
      queuedDelete = null;
      if (context.isCurrent()) {
        const quiet = state.polling;
        state.pending = false;
        state.polling = false;
        render();
        // The reader may still be deciding in the repeat dialog, or may have confirmed a repeat
        // we have not sent. Close either before returning focus; the modal makes the page inert.
        const dropQueued = state.accessEnded || state.forbidden || state.needsRefresh;
        if (state.accessEnded || (queued && dropQueued)) {
          section.querySelector<HTMLDialogElement>("dialog[open]")?.close();
        }
        if (state.accessEnded) {
          // Refresh is gone, so keep focus in this section on its heading.
          if (focusedHere) {
            heading.focus({ preventScroll: true });
          }
        } else if (!quiet && focusedHere) {
          (state.deleting || state.needsRefresh ? refresh : remove).focus({ preventScroll: true });
        }
        if (queued && !dropQueued) {
          // Sent even after a failed read: the reader confirmed it, and its outcome replaces
          // the read's error.
          void deleteAgent(queued.dialog, queued.cancel, queued.confirm);
        }
      }
    }
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
    if (state.accessEnded || state.forbidden || state.needsRefresh || !context.isCurrent()) {
      return;
    }
    if (state.pending) {
      // A quiet poll is reading: show the repeat as sent and send it when the read ends.
      if (state.polling && !queuedDelete) {
        queuedDelete = { dialog, cancel, confirm };
        showSending(cancel, confirm);
      }
      return;
    }
    state.pending = true;
    state.error = null;
    state.notice = "";
    showSending(cancel, confirm);
    render();
    try {
      const current = responseFields(
        await context.request(path, { method: "DELETE", expectedStatus: 202 }),
      );
      if (!context.isCurrent()) {
        return;
      }
      if (
        current.id !== agent.id ||
        current.namespaceId !== agent.namespaceId ||
        current.status !== "deleting"
      ) {
        throw new Error("Invalid deletion response");
      }
      dialog.close();
      setDeleting();
    } catch (cause) {
      if (!context.isCurrent()) {
        return;
      }
      // The pending guard serializes status reads and writes. Cancel any poll rearmed
      // while this repeat was pending, so only a manual read can clear its failure.
      if (state.deleting) {
        clearTimeout(pollTimer);
      }
      const error = requestFailure(cause);
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      dialog.close();
      let text;
      let refused = false;
      if (error.status === 403) {
        // The API's named denial (finding 2534) names the grant by Agent ID; the console's
        // sentence names the same grant and who gives it, with the Agent's name, as Stop and the
        // Agents list do (finding 2951). Another refusal shows as written. The request ID stays
        // below either. A refused repeat that is not about grants, such as another actor's
        // deletion, can change without this viewer's access changing, so only it stays available.
        const grant = grantRefusal(cause);
        text = (!grant && error.serverMessage) || deleteRefused(agent.name);
        refused = grant || !state.deleting;
        refusedAfterReads = permissionReadsStarted();
      } else if (error.status === 404) {
        state.needsRefresh = true;
        text =
          "This Agent is no longer available for deletion. Refresh its status to return to the Agents list if it is gone.";
      } else if (error.status === 400 || error.status === 409 || error.status === 429) {
        // The API's own reason for a 400 or 409, such as a lifecycle change during deletion.
        state.needsRefresh = error.status === 409;
        text = describeFailure(cause, {
          mutation: true,
          conflict: "This Agent could not be deleted in its current state.",
          next: "Refresh deletion status before trying again.",
        });
      } else {
        state.needsRefresh = true;
        text =
          "Outcome unknown. Deletion may have started. Refresh deletion status before trying again.";
      }
      state.error = { text, requestId: error.requestId, refused };
    } finally {
      if (context.isCurrent()) {
        state.pending = false;
        render();
        (state.deleting || state.needsRefresh ? refresh : remove).focus();
      }
    }
  }

  function openConfirmation() {
    if (
      state.accessEnded ||
      state.forbidden ||
      (state.pending && !state.polling) ||
      state.needsRefresh
    ) {
      return;
    }
    const retry = state.deleting;
    state.used = true;
    const dialog = element("dialog", {
      className: "dialog agent-delete-dialog",
      "aria-labelledby": "agent-delete-confirm-title",
      "aria-describedby": "agent-delete-confirm-description agent-delete-confirm-kept",
    });
    const cancel = button("Cancel", () => dialog.close());
    const confirm = button(
      retry ? "Request deletion again" : "Permanently delete Agent",
      () => void deleteAgent(dialog, cancel, confirm),
      {
        className: "danger",
      },
    );
    const description = element(
      "p",
      { id: "agent-delete-confirm-description", "aria-live": "polite" },
      retry
        ? "Request cleanup again for this Agent already marked for deletion. Cleanup that is queued or running continues unchanged. Removed data cannot be restored."
        : DELETE_CONFIRMATION,
    );
    const showRestriction = () => {
      // A late answer cannot undo a request already sent.
      if (!dialog.open || (state.pending && !state.polling)) {
        return;
      }
      if (queuedDelete?.dialog === dialog) {
        // The waiting repeat was never sent: drop it with its dialog.
        queuedDelete = null;
        dialog.close();
        return;
      }
      description.textContent = permissionNotice;
      // The confirmation stays in the Tab order, described by the refusal (finding 2935).
      setUnavailable(confirm, true, description);
      cancel.focus();
    };
    restrictConfirmation = showRestriction;
    const kept = keptResources(agent);
    dialog.append(
      element(
        "h2",
        { id: "agent-delete-confirm-title" },
        retry ? `Request deletion again for ${agent.name}?` : `Delete ${agent.name}?`,
      ),
      description,
      kept.summary,
      kept.commands,
      element("div", { className: "dialog-actions" }, cancel, confirm),
    );
    dialog.addEventListener("cancel", (event) => {
      if ((state.pending && !state.polling) || queuedDelete?.dialog === dialog) {
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
        // The close event comes after a sent request has already placed focus on its outcome
        // (finding 1421: it moved back to "Request deletion again"), and after Cancel the browser
        // returns focus to the invoker. Only take focus that was dropped to the page.
        if (
          context.isCurrent() &&
          !(state.pending && !state.polling) &&
          document.activeElement === document.body
        ) {
          (state.forbidden || state.accessEnded
            ? heading
            : state.needsRefresh
              ? refresh
              : remove
          ).focus();
        }
      },
      { once: true },
    );
    section.append(dialog);
    dialog.showModal();
    cancel.focus();
  }

  // The row follows the newest permission answer: a page that reads it again, such as after its
  // Installation administration ended, hides or restores the row without a reload (finding D795).
  // A refused Delete stays unavailable until an answer read after it allows Agent delete
  // (findings 2951, 2966): `read` is the page's count of permission reads when this answer's read
  // started.
  function applyDelete(permitted: boolean | undefined, read: number) {
    if (!context.isCurrent()) {
      return;
    }
    const regranted =
      permitted === true && state.error?.refused === true && read > refusedAfterReads;
    const forbidden = permitted === false;
    if (forbidden === state.forbidden && !regranted) {
      return;
    }
    state.forbidden = forbidden;
    if (forbidden) {
      restrictConfirmation?.();
    } else if (regranted) {
      // The refusal no longer describes this viewer's access.
      state.error = null;
    }
    render();
  }
  // Once the page has passed a newer answer, a late first answer must not replace it.
  let deleteAnswered = false;

  render();
  if (state.deleting) {
    schedulePoll();
  }
  void allowed?.then((permitted) => {
    // The first answer was requested before any Delete, so it never lifts a refusal.
    if (!deleteAnswered && permitted === false) {
      applyDelete(permitted, 0);
    }
  });
  return {
    section,
    applyDelete(permitted: boolean | undefined, read: number) {
      deleteAnswered = true;
      applyDelete(permitted, read);
    },
    // The page found the Agent deleting through another read and now shows only this row.
    showOnPage({ focus = false } = {}) {
      if (!state.deleting) {
        setDeleting({ notifyPage: false });
      }
      render();
      if (focus) {
        refresh.focus();
      }
    },
  };
}
