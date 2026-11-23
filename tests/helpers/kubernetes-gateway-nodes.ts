import { asRecord } from "../../packages/utils/src/index.ts";

// Kubernetes Compute denies the node command that runs a Claude Code turn on a paired node in
// every Gateway it renders, whatever runtime the Configuration selects: an authorized sender can
// switch a session to the runtime at chat time.
export const NODE_CLAUDE_CODE_RUN_COMMAND = "agent.cli.claude.run.v1";

// The gateway.nodes Compute renders for a submitted one: the Configuration's own entries stay,
// and commands.deny gains the Claude Code node command once.
export function renderedGatewayNodes(nodes?: unknown): Record<string, unknown> {
  const submitted = asRecord(nodes) ?? {};
  const commands = asRecord(submitted.commands) ?? {};
  const deny = Array.isArray(commands.deny) ? commands.deny : [];
  return {
    ...submitted,
    commands: { ...commands, deny: [...new Set([...deny, NODE_CLAUDE_CODE_RUN_COMMAND])] },
  };
}

// A copy of an expected Gateway document with gateway.nodes as Compute renders it.
export function withRenderedGatewayNodes<T extends Record<string, unknown>>(document: T): T {
  const gateway = asRecord(document.gateway) ?? {};
  return { ...document, gateway: { ...gateway, nodes: renderedGatewayNodes(gateway.nodes) } };
}
