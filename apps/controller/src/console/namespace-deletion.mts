import type { Namespace } from "@openclaw-enterprise/contracts";
import { requestFailure, responseFields, type ConsoleApiError } from "./api-client.mjs";
import {
  button,
  describeDisabled,
  dismissOnBackdrop,
  element,
  mayReturnFocus,
  replaceChildrenIfChanged,
  requestIdLine,
  statusBlock,
} from "./dom.mjs";
import type { NamespacePageContext } from "./namespaces.mjs";
import { resourceActionIcon } from "./resource-actions.mjs";
import { describeFailure } from "./agents/list.mjs";
import { NAMESPACE_DELETE_DENIED, namespaceDeleteDenied } from "./agents/access-reasons.mjs";

interface DeletionContext extends NamespacePageContext {
  /** `refocus`: a requested check found it removed while its Refresh held focus. */
  onRemoved(namespace: Namespace, refocus: boolean): void;
  onResume?(handler: () => void): void;
  statusChanged(status: Namespace["status"]): void;
}

const POLL_MS = 3000;

/** One exact Namespace owns its confirmation, request outcome, and teardown observation. */
export function createNamespaceDeletion(context: DeletionContext, namespace: Namespace) {
  const path = `/namespaces/${encodeURIComponent(namespace.id)}`;
  const actions = element("div", { className: "namespace-cell-actions resource-row-actions" });
  const feedback = element("div", {
    className: "namespace-row-feedback",
    id: `namespace-delete-feedback-${namespace.id}`,
  });
  let deleting = namespace.status === "deleting";
  let unknown = false;
  let pending = false;
  let reading = false;
  // Set while the running read is a background poll. A poll keeps the controls usable and the
  // shown status in place, so it neither drops keyboard focus from a button it would disable
  // nor announces the same status again every 3 s (finding 2797).
  let quiet = false;
  // Each deletion request bumps this, so a poll sent before it cannot report over its outcome.
  let generation = 0;
  // Set when a requested check disables the focused Refresh status, so focus returns to the row.
  let refocus = false;
  let denied = false;
  // Why delete is refused, from the last permission answer: an Installation administrator is
  // refused only by a Restriction (finding 2861).
  let deniedReason = NAMESPACE_DELETE_DENIED;
  let accessEnded = false;
  let removed = false;
  let poll: ReturnType<typeof setTimeout> | undefined;
  let confirmation: HTMLDialogElement | undefined;
  let message = "";
  let requestId: string | undefined;
  const remove = button(resourceActionIcon("delete"), () => openConfirmation(), {
    className: "icon-button",
    title: "Delete Namespace",
    "aria-label": `Delete ${namespace.name}`,
  });
  const refresh = button("Refresh status", () => void readStatus(), {
    tone: "ghost",
    size: "sm",
    "aria-label": `Refresh ${namespace.name} deletion status`,
  });
  const retry = button("Request deletion again", () => openConfirmation(), {
    tone: "link",
    size: "sm",
  });
  actions.append(remove, refresh, retry);

  function current() {
    return !removed && context.isCurrent() && context.view.isConnected;
  }

  function render() {
    remove.hidden = deleting || unknown;
    refresh.hidden = !deleting && !unknown;
    retry.hidden = !deleting || unknown;
    const checking = reading && !quiet;
    const busy = pending || checking || accessEnded;
    // A refused delete stays in the Tab order (aria-disabled, not disabled), so a keyboard user
    // reaches its reason (finding D788). openConfirmation ignores it.
    for (const control of [remove, retry]) {
      control.disabled = busy;
      if (denied && !busy) {
        control.setAttribute("aria-disabled", "true");
      } else {
        control.removeAttribute("aria-disabled");
      }
    }
    refresh.disabled = pending || checking;
    let text = message;
    if (!text && denied) {
      text = deniedReason;
    } else if (!text && deleting) {
      text =
        "Deletion started. Cleanup runs in the background. If it does not finish, ask an operator to check teardown before requesting deletion again.";
    }
    const support = requestId ? requestIdLine(requestId) : null;
    replaceChildrenIfChanged(feedback, [
      ...(text ? [statusBlock(unknown || accessEnded ? "warning" : "info", null, text)] : []),
      ...(support ? [support] : []),
    ]);
    // Each links the reason only while it is unavailable, disabled or aria-disabled.
    describeDisabled(remove, feedback);
    describeDisabled(retry, feedback);
  }

  function schedulePoll() {
    clearTimeout(poll);
    if (deleting && !unknown && !accessEnded && current()) {
      poll = setTimeout(() => void readStatus({ background: true }), POLL_MS);
    }
  }

  async function readPermissions() {
    try {
      const answer = responseFields(await context.request(`${path}/permissions`));
      if (!current()) {
        return;
      }
      denied = answer.delete === false;
      deniedReason = namespaceDeleteDenied(answer as { installation?: { administer?: boolean } });
      if (denied && confirmation?.open && !pending) {
        confirmation.close();
      }
      render();
    } catch {
      // An unavailable advisory answer leaves the real DELETE to authorize the operation.
    }
  }

  async function readStatus({ background = false } = {}) {
    if (!current() || pending) {
      return;
    }
    if (reading) {
      // Refresh during a background poll shows that poll as the requested check.
      if (!background && quiet) {
        refocus = document.activeElement === refresh;
        quiet = false;
        render();
      }
      return;
    }
    clearTimeout(poll);
    reading = true;
    quiet = background;
    refocus = !background && document.activeElement === refresh;
    const sent = generation;
    render();
    try {
      const result = responseFields(await context.request(path));
      if (!current() || sent !== generation) {
        return;
      }
      if (
        result.id !== namespace.id ||
        !["ready", "provisioning", "failed", "deleting"].includes(String(result.status))
      ) {
        throw new Error("Invalid Namespace status response");
      }
      if (quiet && deleting && result.status === "deleting") {
        // Cleanup is still running: a background poll leaves what the row shows, including a
        // refusal of the last request, until the status changes or the person refreshes.
        return;
      }
      deleting = result.status === "deleting";
      unknown = false;
      accessEnded = false;
      message = deleting
        ? ""
        : "This Namespace still exists. You can review it before deciding to delete again.";
      requestId = undefined;
      context.statusChanged(result.status as Namespace["status"]);
      await readPermissions();
    } catch (cause) {
      if (!current() || sent !== generation) {
        return;
      }
      const error = requestFailure(cause);
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      if (error.status === 404) {
        removed = true;
        // A confirmation opened while a background poll read has nothing left to delete.
        confirmation?.close();
        context.onRemoved(namespace, refocus);
        return;
      }
      accessEnded = error.status === 403;
      unknown = true;
      message = accessEnded
        ? "This Namespace is no longer readable. It may have been deleted or your access changed. Refresh Namespaces to check your access."
        : "Could not check deletion status. Select Refresh status to check again.";
      requestId = error.requestId;
    } finally {
      reading = false;
      quiet = false;
      if (current()) {
        render();
        schedulePoll();
        if (refocus && (!document.activeElement || document.activeElement === document.body)) {
          (refresh.hidden ? remove : refresh).focus();
        }
      }
      refocus = false;
    }
  }

  function showBlockers(dialog: HTMLDialogElement, cause: unknown) {
    const error = requestFailure(cause);
    const body = element(
      "div",
      {},
      element(
        "p",
        { id: "namespace-delete-description" },
        `${namespace.name} was not deleted. Remove its remaining resources, then try again.`,
      ),
    );
    const resources = (cause as ConsoleApiError).remainingResources ?? [];
    const list = element("ul", { className: "namespace-delete-blockers" });
    for (const resource of resources) {
      const heading = element(
        "div",
        { className: "namespace-delete-resource" },
        element(
          "strong",
          {},
          resource.count ? `${resource.kind} (${resource.count})` : resource.kind,
        ),
      );
      let page: "agents" | "secrets" | null = null;
      if (resource.kind === "Agents") {
        page = "agents";
      } else if (resource.kind === "Secrets") {
        page = "secrets";
      }
      if (page) {
        const destination = page;
        heading.append(
          button(
            `View ${resource.kind}`,
            () => {
              dialog.close();
              context.navigate(destination, namespace.id);
            },
            { tone: "link", size: "sm" },
          ),
        );
      }
      const item = element(
        "li",
        {},
        heading,
        ...resource.ids.map((id) => element("code", { className: "resource-id" }, id)),
      );
      const unlisted = resource.count - resource.ids.length;
      if (unlisted > 0) {
        // The API names at most 20 IDs per kind, and only those the caller can read (finding 2724).
        const lead = resource.ids.length ? `And ${unlisted} more not listed.` : "None listed.";
        item.append(
          element(
            "p",
            { className: "muted" },
            `${lead} The list shows up to 20 IDs that you can read; retry after cleanup to see more.`,
          ),
        );
      }
      if (resource.kind === "Configurations" && resource.ids.length) {
        item.append(
          element(
            "details",
            {},
            element("summary", {}, "Configuration cleanup commands"),
            element(
              "p",
              {},
              "After deleting their Agents, remove unused Configurations with the CLI:",
            ),
            ...resource.ids.map((id) =>
              element(
                "pre",
                {},
                element("code", {}, `occ --namespace ${namespace.id} configuration delete ${id}`),
              ),
            ),
          ),
        );
      }
      list.append(item);
    }
    body.append(
      resources.length
        ? list
        : element("p", {}, error.serverMessage ?? "The Namespace is not empty."),
      element(
        "p",
        { className: "muted" },
        "Agent and credential source cleanup must finish before the Namespace is empty.",
      ),
    );
    if (error.requestId) {
      body.append(requestIdLine(error.requestId));
    }
    dialog.replaceChildren(
      element("h2", { id: "namespace-delete-title" }, "Namespace still contains resources"),
      body,
      element(
        "div",
        { className: "dialog-actions" },
        button("Close", () => dialog.close()),
      ),
    );
    dialog.querySelector<HTMLButtonElement>("button")?.focus();
  }

  function openConfirmation() {
    if (!current() || pending || (reading && !quiet) || denied || accessEnded || unknown) {
      return;
    }
    const opener = document.activeElement;
    const repeating = deleting;
    const dialog = element("dialog", {
      className: "dialog namespace-delete-dialog",
      "aria-labelledby": "namespace-delete-title",
      "aria-describedby": "namespace-delete-description",
    });
    confirmation = dialog;
    const cancel = button("Cancel", () => dialog.close());
    const confirm = button(
      repeating ? "Request deletion again" : "Delete Namespace",
      () => void send(),
      { tone: "danger" },
    );
    dialog.append(
      element(
        "h2",
        { id: "namespace-delete-title" },
        repeating ? `Retry deletion of ${namespace.name}?` : `Delete ${namespace.name}?`,
      ),
      element(
        "p",
        { id: "namespace-delete-description" },
        repeating
          ? "Request cleanup again for this Namespace. Cleanup already in progress continues."
          : "The Namespace must be empty before it can be deleted.",
      ),
      element(
        "div",
        { className: "namespace-delete-identity" },
        element("strong", {}, namespace.name),
        element("span", { className: "resource-id" }, namespace.id),
      ),
      element(
        "p",
        { className: "namespace-delete-consequence" },
        "This cannot be undone. The name cannot be reused.",
      ),
      element(
        "p",
        { className: "muted" },
        "Cleanup runs in the background. The Namespace stays visible until cleanup finishes.",
      ),
      element(
        "details",
        {},
        element("summary", {}, "What happens to default Presets?"),
        element(
          "p",
          {},
          "Unchanged, automatically added Presets are removed with the Namespace. This also requires Preset delete permission. Other resources must be removed first.",
        ),
      ),
      element("div", { className: "dialog-actions" }, cancel, confirm),
    );
    dialog.addEventListener("cancel", (event) => {
      if (pending) {
        event.preventDefault();
      }
    });
    dialog.addEventListener(
      "close",
      () => {
        confirmation = undefined;
        dialog.remove();
        if (
          current() &&
          !pending &&
          opener instanceof HTMLElement &&
          opener.isConnected &&
          mayReturnFocus(dialog)
        ) {
          opener.focus();
        }
      },
      { once: true },
    );
    context.holdWhileWriting({
      writing: () => pending,
      held: () => {
        feedback.replaceChildren(
          statusBlock("info", null, "Wait for the deletion request to finish before leaving."),
        );
      },
      released: () => {
        clearTimeout(poll);
        if (dialog.open) {
          dialog.close();
        }
      },
    });
    context.view.append(dialog);
    dismissOnBackdrop(dialog);
    dialog.showModal();
    cancel.focus();

    async function send() {
      if (pending || denied || !current()) {
        return;
      }
      pending = true;
      generation += 1;
      clearTimeout(poll);
      cancel.disabled = true;
      confirm.disabled = true;
      confirm.textContent = "Deleting…";
      confirm.setAttribute("aria-busy", "true");
      render();
      try {
        const result = responseFields(
          await context.request(path, { method: "DELETE", expectedStatus: 202 }),
        );
        if (!current()) {
          return;
        }
        if (result.id !== namespace.id || result.status !== "deleting") {
          throw new Error("Invalid Namespace deletion response");
        }
        deleting = true;
        unknown = false;
        message = "";
        requestId = undefined;
        context.statusChanged("deleting");
        dialog.close();
      } catch (cause) {
        if (!current()) {
          return;
        }
        const error = requestFailure(cause);
        if (error.status === 401) {
          context.onExpired();
          return;
        }
        if (error.code === "NAMESPACE_NOT_EMPTY") {
          showBlockers(dialog, cause);
          return;
        }
        dialog.close();
        requestId = error.requestId;
        if (error.status === 403) {
          denied = true;
          message = error.serverMessage ?? deniedReason;
        } else if (error.status === 400 || error.status === 409 || error.status === 429) {
          message = describeFailure(cause, { mutation: true });
        } else {
          unknown = true;
          message =
            "Outcome unknown. Deletion may have started. Select Refresh status before deciding to try again.";
        }
      } finally {
        pending = false;
        if (current()) {
          render();
          schedulePoll();
          if (!dialog.open) {
            (deleting || unknown ? refresh : remove).focus();
          }
        }
      }
    }
  }

  render();
  void readPermissions();
  schedulePoll();
  // A return mounts this row only after replaying its reads, including the permission answer,
  // unchanged, so resuming only restarts the poll a detached view stopped (finding 2799).
  context.onResume?.(schedulePoll);
  return { actions, feedback };
}
