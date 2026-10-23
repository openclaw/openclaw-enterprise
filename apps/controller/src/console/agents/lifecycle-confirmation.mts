import type { AgentRead } from "@openclaw-enterprise/contracts";
import type { createApiClient } from "../api-client.mjs";
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

// Agent deletion keeps Namespace-owned Configuration and Secret records, including ones created
// with this Agent. Keep their exact IDs and CLI cleanup commands beside the destructive action.
export function keptResourcesText(agent: AgentRead) {
  const auth = "harnessAuth" in agent ? agent.harnessAuth : null;
  const source = auth && "source" in auth ? auth.source : undefined;
  if (source?.kind !== "secret") {
    return `Its Configuration is kept, even if it was created with this Agent. Once nothing else uses it, delete it with occ configuration delete ${agent.configurationId}.`;
  }
  return `Its Configuration and model credential Secret are kept, even if they were created with this Agent. Once nothing else uses them, delete them with occ configuration delete ${agent.configurationId} and occ secret delete ${source.id}.`;
}
