const command = "mcp.tools.call.v1";

function mode(config, nodeId, server, tool) {
  if (
    !config ||
    config.nodeId !== nodeId ||
    typeof server !== "string" ||
    typeof tool !== "string"
  ) {
    return undefined;
  }
  return Object.hasOwn(config.servers ?? {}, server) &&
    Object.hasOwn(config.servers[server] ?? {}, tool)
    ? config.servers[server][tool]
    : undefined;
}

function rejected(code, message) {
  return { ok: false, code, message };
}

export default {
  id: "oce-managed-mcp-policy",
  name: "Managed MCP policy",
  register(api) {
    api.registerNodeInvokePolicy({
      commands: [command],
      allowLocalMcpTool({ nodeId, server, tool, pluginConfig }) {
        return mode(pluginConfig, nodeId, server, tool) === "allow";
      },
      async handle(ctx) {
        const { server, tool } = ctx.params ?? {};
        const policy = mode(ctx.pluginConfig, ctx.nodeId, server, tool);
        if (policy !== "allow" && policy !== "ask") {
          return rejected("MCP_TOOL_DISABLED", "This MCP tool is not enabled for this Agent.");
        }
        if (policy === "ask") {
          if (!ctx.approvals) {
            return rejected("APPROVAL_UNAVAILABLE", "Human approval is unavailable.");
          }
          const approval = await ctx.approvals.request({
            title: `Run ${tool}?`,
            description: `Allow this Agent to invoke ${server}/${tool} once?`,
            severity: "warning",
            toolName: tool,
            allowedDecisions: ["allow-once", "deny"],
          });
          if (approval.decision !== "allow-once") {
            return rejected("APPROVAL_DENIED", "The MCP tool invocation was not approved.");
          }
        }
        return ctx.invokeNode();
      },
    });
  },
};
