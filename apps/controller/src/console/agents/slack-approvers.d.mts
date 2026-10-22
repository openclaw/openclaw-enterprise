import type { PluginDiscoveryContext } from "./plugin-discovery.mjs";
import type { ApproverFieldOptions } from "./plugin-fields.mjs";

// Remove this declaration when the Slack approver and directory fields move to TypeScript.
export function createSlackApproverField(
  options: ApproverFieldOptions & {
    context: PluginDiscoveryContext;
    agentId?: string;
    getSecretId(): string | null;
    allowInherit?: boolean;
  },
): HTMLDivElement & {
  refreshValue(): void;
  refreshNames(): void;
  pauseNames(): void;
};
