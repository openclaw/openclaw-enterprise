import type { PluginDesiredState } from "@openclaw-enterprise/contracts";
import { ConfigurationHarnessError } from "@openclaw-enterprise/occ";
import { managedCliCredentialBindings, managedMcpCredentialBindings } from "./managed-catalog.ts";

/** Managed Plugin bindings must be admitted into the staged deployment. */
export function requireManagedCredentialRuntime(
  selections: PluginDesiredState | undefined,
  stagedPluginIds?: ReadonlySet<string>,
): void {
  const cli = managedCliCredentialBindings(selections);
  const mcp = managedMcpCredentialBindings(selections);
  const unadmitted = [...cli, ...mcp].some(({ install }) => !stagedPluginIds?.has(install.id));
  if (unadmitted) {
    throw new ConfigurationHarnessError(
      "Bound Plugin credentials require TokenService Sources and staged credential delivery.",
    );
  }
}
