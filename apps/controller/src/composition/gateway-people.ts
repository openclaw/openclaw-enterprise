import type { ComputeDriver } from "@openclaw-enterprise/contracts";
import { createNativeGatewayPeopleAccess } from "../gateway/people-client.ts";
import { readWorkspaceFilesApiKey, validateGatewayApiKeyPath } from "./workspace-files.ts";

export function createGatewayPeopleAccess(computeDriver: ComputeDriver, apiKeyPath: string) {
  validateGatewayApiKeyPath(apiKeyPath);
  return createNativeGatewayPeopleAccess(async ({ revision }) => {
    if (
      revision.compute.id !== computeDriver.id ||
      revision.compute.implementation !== computeDriver.implementation
    ) {
      return undefined;
    }
    const endpoint = computeDriver.getGatewayEndpoint?.(revision);
    if (endpoint === undefined) {
      return undefined;
    }
    const url = new URL(endpoint);
    if (url.protocol !== "wss:" || url.username || url.password || url.search || url.hash) {
      return undefined;
    }
    return { url: url.toString(), apiKey: await readWorkspaceFilesApiKey(apiKeyPath) };
  });
}
