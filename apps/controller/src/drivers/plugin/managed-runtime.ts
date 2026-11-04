import type { PluginDesiredState } from "@openclaw-enterprise/contracts";
import { ConfigurationHarnessError } from "@openclaw-enterprise/occ";
import { supportsManagedPluginRuntime } from "../sandbox/openshell-plugin-runtime.ts";
import { managedCredentialBinding, managedMcpCredentialBinding } from "./managed-catalog.ts";

/** A package describes its tools; the selected runtime must implement their credential policy.
 * OpenShell is the currently qualified adapter pair. Generic network flags do not establish
 * request-level MCP or CLI authorization for another implementation. */
export function requireManagedCredentialRuntime(
  selections: PluginDesiredState | undefined,
  sandbox?: string,
  gateway?: string,
): void {
  if (
    (managedCredentialBinding(selections) || managedMcpCredentialBinding(selections)) &&
    !supportsManagedPluginRuntime(sandbox, gateway)
  ) {
    throw new ConfigurationHarnessError(
      "Bound plugin credentials require a runtime that implements credential injection and managed request policies. The currently supported pair is the OpenShell Sandbox and Credential Gateway.",
    );
  }
}
