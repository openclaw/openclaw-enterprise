export const AUTOMATION_MCP_MAX_ROUTES = 64;
export const AUTOMATION_MCP_MAX_EGRESS_ADDRESSES = 64;

export const DEDICATED_AUTOMATION_READ_ONLY_PATHS = Object.freeze([
  "/app/node_modules/openclaw",
  "/home/node/.codex/skills/.system",
] as const);
