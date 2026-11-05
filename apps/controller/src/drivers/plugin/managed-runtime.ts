import { importedPluginDigest, type PluginDesiredState } from "@openclaw-enterprise/contracts";
import { asRecord } from "@openclaw-enterprise/utils";
import { ConfigurationHarnessError } from "@openclaw-enterprise/occ";
import { supportsManagedPluginRuntime } from "../sandbox/openshell-plugin-runtime.ts";
import {
  type ManagedMcpInstall,
  managedCliCredentialBindings,
  managedMcpCredentialBindings,
} from "./managed-catalog.ts";

/** A package describes its tools; the selected runtime must implement their credential policy.
 * OpenShell is the currently qualified adapter pair. Generic network flags do not establish
 * request-level MCP or CLI authorization for another implementation. */
export function requireManagedCredentialRuntime(
  selections: PluginDesiredState | undefined,
  sandbox?: string,
  gateway?: string,
  installs?: readonly ManagedMcpInstall[],
): void {
  const cli = managedCliCredentialBindings(selections);
  const mcp = managedMcpCredentialBindings(selections, installs);
  const importedBinding = Object.entries(selections ?? {}).some(
    ([id, selection]) =>
      importedPluginDigest(id) &&
      selection.enabled &&
      Object.keys(asRecord(selection.driverPolicy?.servers) ?? {}).length > 0,
  );
  if (
    (cli.length > 0 || mcp.length > 0 || importedBinding) &&
    !supportsManagedPluginRuntime(sandbox, gateway)
  ) {
    throw new ConfigurationHarnessError(
      "Bound plugin credentials require a runtime that implements credential injection and managed request policies. The currently supported pair is the OpenShell Sandbox and Credential Gateway.",
    );
  }
}
