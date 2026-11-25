import { listManagedMcpToolNames } from "../../connections/mcp-tool-discovery.ts";
import { deployableManagedMcpToolNames } from "./managed-catalog.ts";

/** Return only upstream tool names the reviewed Plugin can deploy. */
export async function discoverManagedMcpToolNames(
  ...input: Parameters<typeof listManagedMcpToolNames>
): Promise<ReadonlySet<string>> {
  const names = await listManagedMcpToolNames(...input);
  return deployableManagedMcpToolNames(input[0], [...names]);
}
