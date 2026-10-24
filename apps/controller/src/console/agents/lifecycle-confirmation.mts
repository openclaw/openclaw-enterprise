import type { AgentRead } from "@openclaw-enterprise/contracts";
import type { createApiClient } from "../api-client.mjs";
import { button, element } from "../dom.mjs";
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
}

// Agent list and detail use the same confirmation and explain which resources deletion keeps.
export const STOP_CONFIRMATION =
  "This interrupts the current runtime gateway and ends any reply in progress; open chats can keep showing it as responding. Configuration, versions, Credentials, and workspace data are retained. Deploy a new version to start the Agent again.";

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
    cleanupCommand("Configuration", agent.namespaceId, agent.configurationId),
    secret ? cleanupCommand("Secret", secret.namespaceId, secret.id) : null,
  );
  return { summary, commands };
}

function cleanupCommand(kind: "Configuration" | "Secret", namespaceId: string, id: string) {
  const text = `occ --namespace ${namespaceId} ${kind.toLowerCase()} delete ${id}`;
  const command = element("code", {}, text);
  const feedback = element("span", { className: "muted", role: "status" });
  const copy = button(
    `Copy ${kind} command`,
    async () => {
      try {
        await navigator.clipboard.writeText(text);
        feedback.textContent = "Command copied.";
      } catch {
        document.getSelection()?.selectAllChildren(command);
        feedback.textContent = "Command selected. Use your copy shortcut to copy it.";
      }
    },
    { tone: "link", size: "sm" },
  );
  return element("div", { className: "agent-kept-command" }, command, copy, feedback);
}
