import type { AgentAutomationToolGrant, AgentRevision } from "@openclaw-enterprise/contracts";

/** The selected runtime owner derives unattended standing authority from an admitted revision. */
export type AgentAutomationPolicyEvaluator = (
  revision: Readonly<AgentRevision>,
) => Promise<Readonly<AgentAutomationToolGrant> | undefined>;

/** Mirrors the persisted grant constraint for the in-memory state adapter. */
export function validAgentAutomationToolGrant(grant: unknown): grant is AgentAutomationToolGrant {
  if (grant === null || typeof grant !== "object" || Array.isArray(grant)) {
    return false;
  }
  const record = grant as Record<string, unknown>;
  if (
    Object.keys(record).length !== 1 ||
    !Array.isArray(record.tools) ||
    record.tools.length > 64
  ) {
    return false;
  }
  let previous = "";
  for (const entry of record.tools) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }
    const tool = entry as Record<string, unknown>;
    if (
      Object.keys(tool).length !== 2 ||
      typeof tool.name !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(tool.name) ||
      typeof tool.binding !== "string" ||
      !/^[a-f0-9]{64}$/u.test(tool.binding) ||
      tool.name <= previous
    ) {
      return false;
    }
    previous = tool.name;
  }
  return true;
}

/** A successor must preserve every captured alias and its standing authority binding. */
export function agentAutomationGrantSupported(
  grant: Readonly<AgentAutomationToolGrant>,
  current: Readonly<AgentAutomationToolGrant> | undefined,
): boolean {
  if (!validAgentAutomationToolGrant(grant) || !validAgentAutomationToolGrant(current)) {
    return false;
  }
  const available = new Map(current.tools.map((tool) => [tool.name, tool.binding]));
  return grant.tools.every((tool) => available.get(tool.name) === tool.binding);
}
