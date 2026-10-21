import type { Agent, DriverConfigurationDescriptor } from "@openclaw-enterprise/contracts";
import type { NamespacePageContext } from "../namespaces.mjs";

// Driver discovery calls this owner while its implementation is still JavaScript.
export function renderAgentSandboxPolicy(
  context: Pick<NamespacePageContext, "isCurrent" | "request">,
  options: {
    agent: Pick<Agent, "id" | "namespaceId" | "activeRevisionId" | "desiredRuntimeState">;
    revisionId: string;
    descriptor?: DriverConfigurationDescriptor;
  },
): HTMLElement;
