// Agent runtime ids the Console reads too: no imports, so the Console can serve this file as is.

/**
 * OpenClaw's Claude Code CLI backend. It is a model-scoped agent runtime of the embedded
 * OpenClaw Harness, not a Harness of its own: the Gateway process spawns the Claude Code
 * binary for each turn. Upstream calls it `claude-cli`.
 */
export const CLAUDE_CLI_AGENT_RUNTIME_ID = "claude-cli";

/** The Harness that executes a configured agent runtime. */
export function harnessIdForAgentRuntime(agentRuntimeId: string): string {
  return agentRuntimeId === CLAUDE_CLI_AGENT_RUNTIME_ID ? "openclaw" : agentRuntimeId;
}

/**
 * Whether the Claude Code agent runtime can run a model of this provider: upstream routes only
 * `anthropic/<model>` through its Claude Code CLI backend, and no other provider has such a
 * backend.
 */
export function claudeCodeRuntimeRunsProvider(providerId: string): boolean {
  return providerId === "anthropic";
}
