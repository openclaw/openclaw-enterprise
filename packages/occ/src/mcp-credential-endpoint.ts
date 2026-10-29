import { isIP } from "node:net";
import type { ConnectionEndpoint } from "@openclaw-enterprise/contracts";
import { BrowserAuthorizationError } from "./errors.ts";

export function mcpHttpsEndpoint(value: string | URL): URL {
  const url = new URL(value);
  // The management path supports DNS names. A literal IP would bypass the socket lookup hook.
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.href.includes("#") ||
    url.port === "0" ||
    url.hostname.includes("*") ||
    !url.hostname.includes(".") ||
    isIP(url.hostname) ||
    url.hostname.startsWith("[")
  ) {
    throw new BrowserAuthorizationError("invalid_mcp_endpoint", "fix_configuration");
  }
  return url;
}

/** The MCP transport URL determines where a worker may present a credential. */
export function mcpCredentialEndpoint(serverUrl: string | URL): ConnectionEndpoint {
  const server = mcpHttpsEndpoint(serverUrl);
  // OpenShell represents the path as a glob without a query. It must match literally.
  if (server.href.includes("?") || !/^\/[A-Za-z0-9/._~-]{0,255}$/u.test(server.pathname)) {
    throw new BrowserAuthorizationError("invalid_mcp_server_path", "fix_configuration");
  }
  return { host: server.hostname, port: Number(server.port || 443), path: server.pathname };
}
