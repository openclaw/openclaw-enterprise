import type { AgentRead } from "@openclaw-enterprise/contracts";
import {
  type createApiClient,
  GENERIC_DENIAL,
  namedDenial,
  requestFailure,
} from "../api-client.mjs";
import { button, element, statusBlock } from "../dom.mjs";
import type { AgentNavigation } from "./list.mjs";

/** Stop and Delete follow the selected Agent until the operator leaves its detail page. */
export interface AgentLifecycleContext extends Pick<AgentNavigation, "navigate"> {
  request: ReturnType<typeof createApiClient>;
  isCurrent(): boolean;
  onExpired(): void;
}

export interface LifecycleError {
  text: string;
  requestId: string | undefined;
  /** The API refused this viewer's Stop or Delete (403): it stays unavailable (finding 2955). */
  refused?: boolean;
}

/**
 * Whether a 403 is about the caller's grants: the API's named denial (finding 2534), an older
 * API's generic one, or none. The console words those with the Agent's name. Any other 403, such
 * as one about the caller's own account or another actor's deletion, is written for the caller
 * and shows as written.
 */
export function grantRefusal(cause: unknown) {
  const { serverMessage } = requestFailure(cause);
  return (
    namedDenial(cause) !== undefined ||
    serverMessage === undefined ||
    serverMessage === GENERIC_DENIAL
  );
}

/**
 * Stop cancels a first deployment only when the Agent is requested to run, no version is
 * selected, and the latest deployment this viewer read is queued or in progress. A completed stop
 * also clears the selected version, but its desired state is already stopped.
 */
export function cancelsFirstDeployment(
  agent: Pick<AgentRead, "activeRevisionId" | "desiredRuntimeState">,
  latestDeployment: string | null | undefined,
) {
  return (
    agent.desiredRuntimeState === "running" &&
    !agent.activeRevisionId &&
    (latestDeployment === "queued" || latestDeployment === "running")
  );
}

/**
 * The list and detail views explain the same Stop action. A completed deployment may be
 * newer than the Agent read, and a missing deployment status may hide a running version.
 */
export function stopConfirmation(
  id: string,
  agent: Pick<AgentRead, "activeRevisionId" | "desiredRuntimeState">,
  latestDeployment: string | null | undefined,
) {
  const repeat = agent.desiredRuntimeState === "stopped";
  const firstDeployment = cancelsFirstDeployment(agent, latestDeployment);
  let effect = "The Agent goes offline.";
  if (repeat) {
    effect = "This sends another stop request. Use it if the first one hasn’t finished.";
  } else if (firstDeployment) {
    effect = "This cancels the pending deployment.";
  } else if (!agent.activeRevisionId && latestDeployment !== "succeeded") {
    effect = "This cancels any pending deployment. If the Agent is running, it goes offline.";
  }

  return element(
    "div",
    { id, className: "dialog-body", "aria-live": "polite" },
    element(
      "dl",
      { className: "agent-stop-effects" },
      element("dt", {}, repeat ? "When you retry" : "When you stop"),
      element("dd", {}, effect),
      element("dt", {}, "When you deploy again"),
      element(
        "dd",
        {},
        firstDeployment
          ? "The Agent starts with a new version."
          : "It starts and may resume unfinished work.",
      ),
      element("dt", {}, "What the Agent keeps"),
      element("dd", {}, "Configuration, versions, credentials, and workspace data."),
    ),
    firstDeployment || repeat
      ? null
      : statusBlock(
          "info",
          null,
          [
            "To cancel a reply, select ",
            element("strong", {}, "Stop"),
            " in chat first. Otherwise an open chat can keep showing the reply as in progress.",
          ],
          [],
          { role: null },
        ),
  );
}

export const DELETE_CONFIRMATION =
  "This permanently deletes the Agent, its version history, and its workspace data. This cannot be undone.";

// Say what stays in the confirmation itself. The commands are a separate, optional task:
// opening or copying one must never delete a resource or confirm the Agent deletion.
export function keptResources(agent: AgentRead) {
  const auth = "harnessAuth" in agent ? agent.harnessAuth : null;
  const source = auth && "source" in auth ? auth.source : undefined;
  const secret = source?.kind === "secret" ? source : null;
  const summary = element(
    "p",
    { id: "agent-delete-confirm-kept" },
    secret
      ? "The Configuration and model credential Secret stay in this Namespace."
      : "The Configuration stays in this Namespace.",
  );
  const copyState: CleanupCopyState = { current: null };
  const commands = element(
    "details",
    { className: "disclosure agent-kept-resources" },
    element("summary", {}, "View separate cleanup commands"),
    element(
      "p",
      {},
      secret
        ? "Delete these resources only after confirming that nothing else uses them."
        : "Delete this Configuration only after confirming that nothing else uses it.",
    ),
    cleanupCommand("Configuration", agent.namespaceId, agent.configurationId, copyState),
    secret ? cleanupCommand("Secret", secret.namespaceId, secret.id, copyState) : null,
  );
  return { summary, commands };
}

interface CleanupCopyAttempt {
  feedback: HTMLElement;
  observer: MutationObserver;
}

interface CleanupCopyState {
  current: CleanupCopyAttempt | null;
}

function cleanupCommand(
  kind: "Configuration" | "Secret",
  namespaceId: string,
  id: string,
  copyState: CleanupCopyState,
) {
  const text = `occ --namespace ${namespaceId} ${kind.toLowerCase()} delete ${id}`;
  const command = element("code", {}, text);
  const feedback = element("span", { className: "muted", role: "status" });
  const copy = button(
    `Copy ${kind} command`,
    async () => {
      const disclosure = command.closest("details");
      const dialog = command.closest("dialog");
      if (!disclosure?.open || !dialog?.open || !command.isConnected) {
        return;
      }

      // The two rows share one document selection and one current status.
      if (copyState.current) {
        copyState.current.feedback.textContent = "";
        copyState.current.observer.disconnect();
      }
      function invalidateOnClose(records: MutationRecord[]) {
        // Remember a close even if the disclosure or dialog reopens before the write settles.
        if (copyState.current === attempt && records.some((record) => record.oldValue !== null)) {
          feedback.textContent = "";
          observer.disconnect();
          copyState.current = null;
        }
      }
      const observer = new MutationObserver(invalidateOnClose);
      const attempt = { feedback, observer };
      copyState.current = attempt;
      const options = { attributes: true, attributeFilter: ["open"], attributeOldValue: true };
      observer.observe(disclosure, options);
      observer.observe(dialog, options);

      let copied = false;
      try {
        if (typeof navigator.clipboard?.writeText === "function") {
          await navigator.clipboard.writeText(text);
          copied = true;
        }
      } catch {
        // Fall back to manual copying when the browser rejects the write.
      }
      // The write can settle before the observer delivers a close and reopen.
      invalidateOnClose(observer.takeRecords());
      if (
        copyState.current !== attempt ||
        !command.isConnected ||
        !disclosure.open ||
        !dialog.open
      ) {
        return;
      }
      if (copied) {
        feedback.textContent = "Command copied.";
      } else {
        document.getSelection()?.selectAllChildren(command);
        feedback.textContent = "Command selected. Use your copy shortcut to copy it.";
      }
    },
    { tone: "link", size: "sm" },
  );
  return element("div", { className: "agent-kept-command" }, command, copy, feedback);
}
