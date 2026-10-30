import type { AgentRead } from "@openclaw-enterprise/contracts";
import {
  type createApiClient,
  GENERIC_DENIAL,
  namedDenial,
  requestFailure,
} from "../api-client.mjs";
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

// Agent list and detail use the same confirmation and explain which resources deletion keeps.
export const STOP_CONFIRMATION =
  "This interrupts the current runtime gateway and ends any reply in progress; open chats can keep showing it as responding. Configuration, versions, Credentials, and workspace data are retained. Deploy a new version to start the Agent again.";

// A first deployment that is queued or in progress, with no version selected yet: Stop only
// cancels it, because no gateway runs yet to interrupt (finding D691).
export const STOP_FIRST_DEPLOYMENT_CONFIRMATION =
  "No version is serving yet, so this cancels the deployment in progress. Configuration, versions, Credentials, and workspace data are retained. Deploy a new version to start the Agent again.";

// No version is selected and this viewer cannot read the latest deployment's outcome, so the
// console cannot say whether Stop cancels a deployment or interrupts a gateway that started.
export const STOP_UNKNOWN_DEPLOYMENT_CONFIRMATION =
  "This cancels a deployment in progress or, if a version already started, interrupts its runtime gateway and ends any reply in progress. Configuration, versions, Credentials, and workspace data are retained. Deploy a new version to start the Agent again.";

// Request Stop again on an Agent already requested to stop: no gateway runs that this would
// interrupt, so the confirmation says it only repeats the request (finding D815).
export const STOP_REPEAT_CONFIRMATION =
  "This Agent is already requested to stop. This sends the stop request again; use it if an earlier stop did not finish. Configuration, versions, Credentials, and workspace data are retained. Deploy a new version to start the Agent again.";

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
 * `latestDeployment` is the status of the latest deployment this viewer read, or null/undefined
 * when it is unknown (unreadable, failed read, or still reading).
 */
export function stopConfirmation(
  agent: Pick<AgentRead, "activeRevisionId" | "desiredRuntimeState">,
  latestDeployment: string | null | undefined,
) {
  if (agent.desiredRuntimeState === "stopped") {
    return STOP_REPEAT_CONFIRMATION;
  }
  if (cancelsFirstDeployment(agent, latestDeployment)) {
    return STOP_FIRST_DEPLOYMENT_CONFIRMATION;
  }
  // A succeeded deployment read against an older Agent read means a version runs.
  if (
    agent.desiredRuntimeState === "running" &&
    !agent.activeRevisionId &&
    latestDeployment !== "succeeded"
  ) {
    return STOP_UNKNOWN_DEPLOYMENT_CONFIRMATION;
  }
  return STOP_CONFIRMATION;
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
