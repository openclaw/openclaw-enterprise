import type {
  AgentDeletionAcceptedResponse,
  AgentDeletionStatusResponse,
} from "@openclaw-enterprise/contracts";
import { requestFailure, responseFields } from "../api-client.mjs";
import { button, element, replaceChildrenIfChanged, setHidden, setText } from "../dom.mjs";
import type { ConsolePageContext } from "../page-context.mjs";
import { displayDate, GENERIC_DENIAL, link, namespacePath } from "./list.mjs";

type Deletion = AgentDeletionStatusResponse["data"];
type StatusContext = Pick<
  ConsolePageContext,
  | "view"
  | "request"
  | "navigate"
  | "pageUrl"
  | "isCurrent"
  | "onExpired"
  | "setTitle"
  | "setLeaveGuard"
  | "setWriteInFlight"
> & { namespaceId: string };
type Identity = { namespaceId: string; id: string };

// Requests are tied to the signed-in session. The receipt identifies a request; it grants no access.
export const DELETION_POLL_MS = 3000;

// Let this tab reopen a deletion it requested from the Agents list. Never persist these links
// or remember a status result; session loss and account changes discard the entire collection.
const receipts = new Map<string, string>();
export function clearDeletionReceipts() {
  receipts.clear();
}

export function deletionStatusPage(agent: Identity, receiptId?: string) {
  const key = `${agent.namespaceId}/${agent.id}`;
  if (receiptId !== undefined) {
    receipts.set(key, receiptId);
    if (receipts.size > 16) {
      receipts.delete(receipts.keys().next().value!);
    }
  }
  const receipt = receipts.get(key);
  return `agents/${agent.id}/deletion${receipt ? `?receiptId=${encodeURIComponent(receipt)}` : ""}`;
}

export function isDeletionReceiptId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    /^aud_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)
  );
}

export async function requestAgentDeletion(
  context: Pick<StatusContext, "request">,
  path: string,
  agent: Identity,
) {
  const { data, meta } = (await context.request(path, {
    method: "DELETE",
    expectedStatus: 202,
    includeMeta: true,
  })) as AgentDeletionAcceptedResponse;
  if (
    data?.id !== agent.id ||
    data.namespaceId !== agent.namespaceId ||
    data.status !== "deleting" ||
    !isDeletionReceiptId(meta?.deletionReceiptId)
  ) {
    // The controller may already have accepted this write. Its caller reconciles with a read.
    throw new Error("The response did not identify this deletion request.");
  }
  return meta.deletionReceiptId;
}

const stages = {
  queued: [
    "Deletion queued",
    "The deletion request was accepted. Cleanup will start automatically.",
    "Queued",
  ],
  running: [
    "Deleting Agent",
    "Cleanup is in progress. You can leave this page while it runs.",
    "In progress",
  ],
  waiting: [
    "Waiting to retry cleanup",
    "Cleanup will continue automatically. You don’t need to request deletion again.",
    "Waiting to retry",
  ],
  failed: [
    "Cleanup needs attention",
    "Automatic attempts have stopped. Some data may already be removed. Ask an administrator to check what failed before retrying.",
    "Stopped",
  ],
  deleted: [
    "Agent deleted",
    "Deletion is complete. This Agent is no longer in the Namespace.",
    "Complete",
  ],
} satisfies Record<Deletion["status"], [string, string, string]>;

export function renderDeletionStatus(
  context: StatusContext,
  agentId: string,
  receiptId: string | null,
) {
  const { namespaceId, request, isCurrent } = context;
  const path = `${namespacePath(namespaceId)}/agents/${encodeURIComponent(agentId)}`;
  const statusPath =
    path +
    "/deletion-status" +
    (receiptId === null ? "" : `?receiptId=${encodeURIComponent(receiptId)}`);
  const readOptions = { expectedStatus: 200, revalidate: false } as const;
  // Only a changed result enters the live region. Quiet polls never replace a focused control.
  const heading = element("h2", { id: "deletion-status-title" }, "Checking deletion status…");
  const description = element("p", { className: "deletion-status-description" });
  const summary = element("div", { role: "status", "aria-atomic": "true" }, heading, description);
  const progress = element("ol", {
    className: "deletion-progress",
    "aria-label": "Deletion progress",
    hidden: "",
  });
  const note = element(
    "p",
    { className: "muted", hidden: "" },
    "The Configuration and Secrets stay in this Namespace. Repository cleanup runs separately.",
  );
  const back = link("Back to Agents", "agents", context);
  back.className = "button button--primary";
  const refresh = button("Refresh deletion status", () => void check({ manual: true }), {
    tone: "ghost",
    size: "sm",
  });
  const retry = button("Retry cleanup", openRetry, { hidden: "" });
  const actions = element("div", { className: "deletion-status-actions" }, back, refresh, retry);
  const card = element(
    "section",
    { className: "card deletion-status", "aria-labelledby": heading.id },
    summary,
    progress,
    actions,
    note,
  );
  let timer: number | undefined;
  let reading = false;
  let writing = false;
  let canRetry = false;
  let dialog: HTMLDialogElement | undefined;

  function show(title: string, detail: string, status?: Deletion["status"]) {
    setText(heading, title);
    setText(description, detail);
    const finished = status === "deleted";
    const focused = document.activeElement;
    setHidden(refresh, finished);
    setHidden(retry, status !== "failed" || !canRetry);
    setHidden(progress, !status);
    setHidden(note, !status);
    if ((finished && focused === refresh) || (retry.hidden && focused === retry)) {
      (finished ? back : refresh).focus({ preventScroll: true });
    }
    if (!status) {
      progress.replaceChildren();
      return;
    }
    const tone = status === "failed" ? "danger" : status === "waiting" ? "warning" : "info";
    replaceChildrenIfChanged(progress, [
      step("Deletion requested", "Accepted", "success"),
      step("Agent cleanup", stages[status][2], finished ? "success" : tone),
      step(
        "Deletion confirmed",
        finished ? "Complete" : "Pending",
        finished ? "success" : "pending",
      ),
    ]);
  }

  function step(label: string, detail: string, tone: string) {
    return element(
      "li",
      { className: "deletion-step", "data-tone": tone },
      element(
        "span",
        { className: "deletion-step-mark", "aria-hidden": "true" },
        tone === "success" ? "✓" : "",
      ),
      element("strong", {}, label),
      element("span", { className: "deletion-step-state" }, detail),
    );
  }

  async function read(): Promise<Deletion> {
    const data = (await request(statusPath, readOptions)) as Deletion;
    if (
      data?.agentId !== agentId ||
      data.namespaceId !== namespaceId ||
      data.receiptId !== (receiptId ?? undefined) ||
      !Object.hasOwn(stages, data.status) ||
      (data.status === "deleted" && !receiptId) ||
      (data.nextAttemptAt !== undefined &&
        (data.status !== "waiting" ||
          typeof data.nextAttemptAt !== "string" ||
          !Number.isFinite(Date.parse(data.nextAttemptAt))))
    ) {
      throw new Error("The response did not identify this deletion request.");
    }
    return data;
  }

  function showFailure(cause: unknown) {
    const { status, requestId } = requestFailure(cause);
    if (status === 401) {
      context.onExpired();
      return;
    }
    const detail =
      status === 403
        ? "Your current access doesn’t include this deletion status. We can’t confirm whether the Agent was deleted."
        : status === 404
          ? "This deletion status is no longer available to you. We can’t confirm whether the Agent was deleted."
          : "We couldn’t confirm the current status. Refresh to check again; this won’t send another deletion request.";
    show("Deletion status unavailable", detail + (requestId ? ` Request ID: ${requestId}` : ""));
  }

  async function permitted() {
    const permissions = responseFields(await request(path + "/permissions", readOptions));
    return permissions.delete === true;
  }

  async function check({ manual = false } = {}) {
    if (writing || dialog?.open || !isCurrent()) {
      return;
    }
    if (manual) {
      setText(refresh, "Checking status…");
      refresh.setAttribute("aria-busy", "true");
    }
    // A manual check can join the poll already in flight without interrupting keyboard focus.
    if (reading) {
      return;
    }
    clearTimeout(timer);
    reading = true;
    try {
      const data = await read();
      if (!isCurrent()) {
        return;
      }
      canRetry = false;
      const [title, detail] = stages[data.status];
      const description = data.nextAttemptAt
        ? `Cleanup can retry after ${displayDate(data.nextAttemptAt)}. The start time depends on worker availability.`
        : detail;
      show(title, description, data.status);
      if (data.status === "failed") {
        // Status access alone never offers a destructive action. The DELETE still enforces ownership.
        canRetry = await permitted().catch(() => false);
        if (isCurrent()) {
          setHidden(retry, !canRetry);
        }
      } else if (data.status !== "deleted") {
        timer = window.setTimeout(() => void check(), DELETION_POLL_MS);
      }
    } catch (error) {
      if (isCurrent()) {
        canRetry = false;
        showFailure(error);
      }
    } finally {
      reading = false;
      if (isCurrent() && refresh.hasAttribute("aria-busy")) {
        setText(refresh, "Refresh deletion status");
        refresh.removeAttribute("aria-busy");
      }
    }
  }

  function openRetry() {
    if (!canRetry || reading || writing || !isCurrent()) {
      return;
    }
    dialog = element("dialog", {
      className: "dialog agent-delete-dialog",
      "aria-labelledby": "retry-deletion-title",
      "aria-describedby": "retry-deletion-description",
    });
    const current = dialog;
    const cancel = button("Cancel", () => current.close());
    const confirm = button(
      "Retry cleanup",
      async () => {
        confirm.disabled = true;
        setText(confirm, "Checking status and access…");
        let sent = false;
        try {
          // The operator can still cancel while these reads run. Never turn an unavailable or
          // changed status or permission into a queued DELETE waiting to be sent.
          if ((await read()).status !== "failed" || !(await permitted())) {
            if (isCurrent() && current.open) {
              current.close();
              void check();
            }
            return;
          }
          if (!isCurrent() || !current.open) {
            return;
          }
          writing = true;
          sent = true;
          cancel.disabled = true;
          setText(confirm, "Requesting cleanup…");
          confirm.setAttribute("aria-busy", "true");
          const receipt = await requestAgentDeletion(context, path, { namespaceId, id: agentId });
          if (isCurrent()) {
            current.close();
            context.navigate(
              deletionStatusPage({ namespaceId, id: agentId }, receipt),
              namespaceId,
              true,
            );
          }
        } catch (cause) {
          if (!isCurrent() || !current.open) {
            return;
          }
          const { status, serverMessage, requestId } = requestFailure(cause);
          canRetry = false;
          current.close();
          const reference = requestId ? ` Request ID: ${requestId}` : "";
          if (!sent || status === 401) {
            showFailure(cause);
          } else if (status === 403) {
            const reason =
              serverMessage && serverMessage !== GENERIC_DENIAL
                ? serverMessage
                : "Your current access does not allow retrying cleanup.";
            show("Cleanup retry not allowed", reason + reference);
          } else {
            show(
              "Check whether cleanup resumed",
              "We couldn’t confirm the retry. Refresh to check its status before taking another action." +
                reference,
            );
          }
          refresh.focus({ preventScroll: true });
        } finally {
          writing = false;
        }
      },
      { className: "danger" },
    );
    current.append(
      element("h2", { id: "retry-deletion-title" }, "Retry Agent cleanup?"),
      element(
        "p",
        { id: "retry-deletion-description" },
        "Only retry after the cause of the failure is resolved. Data already removed can’t be restored.",
      ),
      element("div", { className: "dialog-actions" }, cancel, confirm),
    );
    current.addEventListener("cancel", (event) => {
      if (writing) {
        event.preventDefault();
      }
    });
    current.addEventListener(
      "close",
      () => {
        dialog = undefined;
        current.remove();
      },
      { once: true },
    );
    card.append(current);
    current.showModal();
    cancel.focus();
  }

  context.setTitle("Agent deletion");
  context.view.replaceChildren(card);
  context.setWriteInFlight(() => writing);
  context.setLeaveGuard(() => writing);
  if (receiptId !== null && !isDeletionReceiptId(receiptId)) {
    show("Deletion link unavailable", "Open the deletion status link from the original request.");
    setHidden(refresh, true);
  } else {
    void check();
  }
}
