const command = "mcp.tools.call.v1";
const recorder = Symbol.for("oce.runtime-audit.managed-mcp");

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

function requiresAudit(config) {
  const plugins = config?.plugins;
  const id = "oce-runtime-audit";
  return (
    plugins?.entries?.[id]?.enabled === true &&
    plugins.enabled !== false &&
    !plugins.deny?.some((name) => name.trim().toLowerCase() === id)
  );
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
          // Refused names can be arbitrary caller input. Record the registered command only.
          await globalThis[recorder]?.(command).decide("deny");
          return rejected("MCP_TOOL_DISABLED", "This MCP tool is not enabled for this Agent.");
        }
        const audit = globalThis[recorder]?.(`${server}_${tool}`);
        if (!audit && requiresAudit(ctx.config)) {
          return rejected("AUDIT_UNAVAILABLE", "The managed tool audit recorder is unavailable.");
        }
        await audit?.decide(policy === "ask" ? "require_approval" : "allow");
        if (policy === "ask") {
          if (!ctx.approvals) {
            return rejected("APPROVAL_UNAVAILABLE", "Human approval is unavailable.");
          }
          const openReview = () =>
            ctx.approvals.request({
              title: `Run ${tool}?`,
              description: `Allow this Agent to invoke ${server}/${tool} once?`,
              severity: "warning",
              toolName: tool,
              allowedDecisions: ["allow-once", "deny"],
            });
          const approval = await (audit ? audit.review(openReview) : openReview());
          if (approval.decision !== "allow-once") {
            return rejected("APPROVAL_DENIED", "The MCP tool invocation was not approved.");
          }
        }
        return audit ? audit.dispatch(() => ctx.invokeNode()) : ctx.invokeNode();
      },
    });
  },
};
