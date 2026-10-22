import type { Agent, DriverConfigurationDescriptor } from "@openclaw-enterprise/contracts";
import type { NamespacePageContext } from "../namespaces.mjs";

// TODO: Remove this declaration when sandbox-policy.mjs is migrated to sandbox-policy.mts.
export function renderAgentSandboxPolicy(
  context: Pick<NamespacePageContext, "isCurrent" | "request">,
  options: {
    agent: Pick<Agent, "id" | "namespaceId" | "activeRevisionId" | "desiredRuntimeState">;
    revisionId: string;
    descriptor?: DriverConfigurationDescriptor;
  },
): HTMLElement;
