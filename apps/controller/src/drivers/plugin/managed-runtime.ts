import type { PluginDesiredState } from "@openclaw-enterprise/contracts";
import { ConfigurationHarnessError } from "@openclaw-enterprise/occ";
import { supportsManagedPluginRuntime } from "../sandbox/openshell-plugin-runtime.ts";
import { managedCliCredentialBindings, managedMcpCredentialBindings } from "./managed-catalog.ts";

/** Staged bindings use OCC's whole-revision qualifier; legacy bindings require the OpenShell pair. */
export function requireManagedCredentialRuntime(
  selections: PluginDesiredState | undefined,
  sandbox?: string,
  gateway?: string,
  stagedPluginIds?: ReadonlySet<string>,
): void {
  const cli = managedCliCredentialBindings(selections);
  const mcp = managedMcpCredentialBindings(selections);
  const legacy = [...cli, ...mcp].some(({ install }) => !stagedPluginIds?.has(install.id));
  if (legacy && !supportsManagedPluginRuntime(sandbox, gateway)) {
    throw new ConfigurationHarnessError(
      "Bound plugin credentials require a runtime that implements credential injection and managed request policies. The currently supported pair is the OpenShell Sandbox and Credential Gateway.",
    );
  }
}
