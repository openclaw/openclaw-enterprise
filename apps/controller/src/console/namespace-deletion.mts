import type { Namespace } from "@openclaw-enterprise/contracts";
import { requestFailure, responseFields, type ConsoleApiError } from "./api-client.mjs";
import {
  button,
  describeDisabled,
  dismissOnBackdrop,
  element,
  requestIdLine,
  statusBlock,
} from "./dom.mjs";
import type { NamespacePageContext } from "./namespaces.mjs";
import { resourceActionIcon } from "./resource-actions.mjs";
import { describeFailure } from "./agents/list.mjs";
import { askForGrant } from "./agents/access-reasons.mjs";

interface DeletionContext extends NamespacePageContext {
  onRemoved(namespace: Namespace): void;
  onResume?(handler: () => void): void;
  statusChanged(status: Namespace["status"]): void;
}

const POLL_MS = 3000;
const DENIED = `You do not have permission to delete this Namespace. ${askForGrant("Namespace delete on it")}`;

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
  let denied = false;
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
    remove.disabled = pending || reading || denied || accessEnded;
    retry.disabled = pending || reading || denied || accessEnded;
    refresh.disabled = pending || reading;
    let text = message;
    if (!text && denied) {
      text = DENIED;
    } else if (!text && deleting) {
      text =
        "Deletion started. Cleanup runs in the background. If it does not finish, ask an operator to check teardown before requesting deletion again.";
    }
    const support = requestId ? requestIdLine(requestId) : null;
    feedback.replaceChildren(
      ...(text ? [statusBlock(unknown || accessEnded ? "warning" : "info", null, text)] : []),
      ...(support ? [support] : []),
    );
    describeDisabled(remove, remove.disabled ? feedback : null);
    describeDisabled(retry, retry.disabled ? feedback : null);
  }

  function schedulePoll() {
    clearTimeout(poll);
    if (deleting && !unknown && !accessEnded && current()) {
      poll = setTimeout(() => void readStatus(), POLL_MS);
    }
  }

  async function readPermissions() {
    try {
      const answer = responseFields(await context.request(`${path}/permissions`));
      if (!current()) {
        return;
      }
      denied = answer.delete === false;
      if (denied && confirmation?.open && !pending) {
        confirmation.close();
      }
      render();
    } catch {
      // An unavailable advisory answer leaves the real DELETE to authorize the operation.
    }
  }

  async function readStatus() {
    if (!current() || pending || reading) {
      return;
    }
    clearTimeout(poll);
    reading = true;
    render();
    try {
      const result = responseFields(await context.request(path));
      if (!current()) {
        return;
      }
      if (
        result.id !== namespace.id ||
        !["ready", "provisioning", "failed", "deleting"].includes(String(result.status))
      ) {
        throw new Error("Invalid Namespace status response");
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
      if (!current()) {
        return;
      }
      const error = requestFailure(cause);
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      if (error.status === 404) {
        removed = true;
        context.onRemoved(namespace);
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
      if (current()) {
        render();
        schedulePoll();
      }
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
      if (resource.count > resource.ids.length) {
        item.append(
          element(
            "p",
            { className: "muted" },
            `And ${resource.count - resource.ids.length} more. Retry after cleanup to see remaining IDs.`,
          ),
        );
      }
      if (resource.kind === "Configurations") {
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
    if (!current() || pending || reading || denied || accessEnded || unknown) {
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
        if (current() && !pending && opener instanceof HTMLElement && opener.isConnected) {
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
          message = error.serverMessage ?? DENIED;
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
  context.onResume?.(() => {
    void readPermissions();
    schedulePoll();
  });
  return { actions, feedback };
}
