import type { PluginDesiredState } from "@openclaw-enterprise/contracts";
import { ConfigurationHarnessError } from "@openclaw-enterprise/occ";
import { supportsManagedPluginRuntime } from "../sandbox/openshell-plugin-runtime.ts";
import { managedCliCredentialBindings, managedMcpCredentialBindings } from "./managed-catalog.ts";

/** A package describes its tools; the selected runtime must implement their credential policy.
 * OpenShell is the currently qualified adapter pair. Generic network flags do not establish
 * request-level MCP or CLI authorization for another implementation. */
export function requireManagedCredentialRuntime(
  selections: PluginDesiredState | undefined,
  sandbox?: string,
  gateway?: string,
  requestTimeCredentials = false,
): void {
  const cli = managedCliCredentialBindings(selections);
  const mcp = managedMcpCredentialBindings(selections);
  if (
    (cli.length > 0 || mcp.length > 0) &&
    !supportsManagedPluginRuntime(sandbox, gateway, requestTimeCredentials)
  ) {
    throw new ConfigurationHarnessError(
      "Bound plugin credentials require a runtime that implements credential injection and managed request policies. Use the OpenShell Sandbox and Credential Gateway for attached sources, or the saved-account Credential Proxy for OAuth accounts.",
    );
  }
}
