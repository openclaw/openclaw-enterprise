import type { AgentDeletionStatusResponse, AgentResponse } from "@openclaw-enterprise/contracts";
import { requestFailure, responseFields } from "../api-client.mjs";
import { button, element, replaceChildrenIfChanged, setHidden, setText } from "../dom.mjs";
import type { ConsolePageContext } from "../page-context.mjs";
import { displayDate, GENERIC_DENIAL, link, namespacePath } from "./list.mjs";
import { grantRefusal } from "./lifecycle-confirmation.mjs";

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

// Status follows the Agent: the controller answers only while the caller can still read it, and
// reports completion only to a caller it can confirm finished the deletion or reads every Agent in
// the Namespace. A denial never means the Agent was deleted.
export const DELETION_POLL_MS = 3000;

export const NOT_VISIBLE_TITLE = "Agent not visible";
export const NOT_VISIBLE_DETAIL =
  "This Agent is no longer visible to you. It may have been deleted, or your access may have changed.";

export function deletionStatusPage(agent: Identity) {
  return `agents/${encodeURIComponent(agent.id)}/deletion`;
}

export async function requestAgentDeletion(
  context: Pick<StatusContext, "request">,
  path: string,
  agent: Identity,
) {
  const data = (await context.request(path, {
    method: "DELETE",
    expectedStatus: 202,
  })) as AgentResponse["data"];
  if (
    data?.id !== agent.id ||
    data.namespaceId !== agent.namespaceId ||
    data.status !== "deleting"
  ) {
    // The controller may already have accepted this write. Its caller reconciles with a read.
    throw new Error("The response did not identify this deletion request.");
  }
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

export function renderDeletionStatus(context: StatusContext, agentId: string) {
  const { namespaceId, request, isCurrent } = context;
  const path = `${namespacePath(namespaceId)}/agents/${encodeURIComponent(agentId)}`;
  const statusPath = `${path}/deletion-status`;
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
    id: "deletion-status-refresh",
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
      !Object.hasOwn(stages, data.status) ||
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
    const reference = requestId ? ` Request ID: ${requestId}` : "";
    // A denial and a missing deletion record look the same. Never infer "Deleted" from either.
    if (status === 403 || status === 404) {
      show(NOT_VISIBLE_TITLE, NOT_VISIBLE_DETAIL + reference);
      return;
    }
    show(
      "Deletion status unavailable",
      "We couldn’t confirm the current status. Refresh to check again; this won’t send another deletion request." +
        reference,
    );
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
          await requestAgentDeletion(context, path, { namespaceId, id: agentId });
          if (isCurrent()) {
            current.close();
            context.navigate(deletionStatusPage({ namespaceId, id: agentId }), namespaceId, true);
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
              !grantRefusal(cause) && serverMessage && serverMessage !== GENERIC_DENIAL
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
  void check();
}
