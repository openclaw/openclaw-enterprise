import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ComputeDriver } from "@openclaw-enterprise/contracts";
import type { ControllerWorkspaceFilesAccess } from "../gateway/contracts.ts";
import { createNativeWorkspaceFilesAccess } from "../gateway/workspace-files-client.ts";
import { DEVELOPMENT_HARNESS_DESCRIPTOR } from "./production-harness.ts";

const NATIVE_AGENT_ID = "main";
const GATEWAY_API_KEY_MAX_BYTES = 4 * 1024;
const PRINTABLE_NON_SPACE_ASCII = /^[!-~]+$/;

function validateUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("workspace-files endpoint url must be a valid absolute URL.");
  }
  if (
    parsed.protocol !== "wss:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error(
      "workspace-files endpoint url must be a wss URL without credentials, query, or fragment.",
    );
  }
  return parsed.toString();
}

export function createWorkspaceFilesAccess(
  computeDriver: ComputeDriver,
  apiKeyPath: string,
): ControllerWorkspaceFilesAccess {
  validateGatewayApiKeyPath(apiKeyPath);
  return createNativeWorkspaceFilesAccess(async (request) => {
    const endpoint = computeDriver.getGatewayEndpoint?.(request.revision);
    if (endpoint === undefined) {
      return undefined;
    }
    return {
      url: validateUrl(endpoint),
      nativeAgentId: NATIVE_AGENT_ID,
      ...(request.revision.harness.id === DEVELOPMENT_HARNESS_DESCRIPTOR.id &&
      request.revision.harness.mode === "embedded"
        ? { preferSoleNativeAgent: true as const }
        : {}),
      apiKey: await readWorkspaceFilesApiKey(apiKeyPath),
    };
  });
}

export function validateGatewayApiKeyPath(path: string): void {
  if (!isAbsolute(path)) {
    throw new Error("OCC_GATEWAY_API_KEY_PATH must identify an absolute mounted-file path.");
  }
}

export async function readWorkspaceFilesApiKey(path: string): Promise<string> {
  validateGatewayApiKeyPath(path);
  const metadata = await stat(path);
  if (!metadata.isFile()) {
    throw new Error("The configured gateway API key file is invalid.");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile()) {
      throw new Error("The configured gateway API key file is invalid.");
    }
    const buffer = Buffer.alloc(GATEWAY_API_KEY_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > GATEWAY_API_KEY_MAX_BYTES) {
      throw new Error("The configured gateway API key file is invalid.");
    }
    const key = buffer.subarray(0, bytesRead).toString("utf8");
    if (!PRINTABLE_NON_SPACE_ASCII.test(key)) {
      throw new Error("The configured gateway API key file is invalid.");
    }
    return key;
  } finally {
    await handle.close();
  }
}

export async function validateWorkspaceFilesApiKeyPath(path: string): Promise<void> {
  try {
    await readWorkspaceFilesApiKey(path);
  } catch {
    throw new Error("The configured gateway API key file is unavailable or invalid.");
  }
}
