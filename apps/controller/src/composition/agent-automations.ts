import { AGENT_AUTOMATIONS_OPENCLAW_SOURCE } from "../gateway/agent-automations-runtime.ts";
import type { ComputeDriver } from "@openclaw-enterprise/contracts";

import { createNativeAgentAutomationsAccess } from "../gateway/agent-automations-client.ts";
import { readWorkspaceFilesApiKey, validateGatewayApiKeyPath } from "./workspace-files.ts";

export function createAgentAutomationsAccess(compute: ComputeDriver, apiKeyPath: string) {
  validateGatewayApiKeyPath(apiKeyPath);
  return createNativeAgentAutomationsAccess(async (revision) => {
    if (
      compute.id !== revision.compute.id ||
      compute.implementation !== revision.compute.implementation
    ) {
      return undefined;
    }
    const images = await compute.getRuntimeImages?.(revision);
    const roles = revision.harness.mode === "dedicated" ? ["gateway", "agent"] : ["gateway"];
    if (
      !images ||
      roles.some((role) => {
        const selected = images.filter((image) => image.container === role);
        return (
          selected.length !== 1 ||
          !selected[0]?.imageId ||
          selected[0].openclawCommit !== AGENT_AUTOMATIONS_OPENCLAW_SOURCE
        );
      })
    ) {
      return undefined;
    }
    const url = compute.getGatewayEndpoint?.(revision);
    return url === undefined
      ? undefined
      : { url, apiKey: await readWorkspaceFilesApiKey(apiKeyPath) };
  });
}
