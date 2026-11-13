import assert from "node:assert/strict";
import { asRecord } from "../../packages/utils/src/index.ts";

export type KubernetesReader = {
  read: (request: { kind?: string }) => Promise<unknown>;
};

export function overrideWorkspaceSetupSecretRead(
  kubernetes: KubernetesReader,
  data: { setupCode: string; deviceId?: string },
  {
    overrideNonSecretReads = false,
    rewriteMetadata,
  }: {
    overrideNonSecretReads?: boolean;
    rewriteMetadata?: (metadata: unknown) => Record<string, unknown>;
  } = {},
): void {
  const originalRead = kubernetes.read;
  kubernetes.read = async (request) => {
    const resource = await originalRead(request);
    if (!overrideNonSecretReads && request.kind !== "Secret") {
      return resource;
    }
    const secret = asRecord(resource);
    assert.ok(secret);
    return {
      ...secret,
      ...(rewriteMetadata ? { metadata: rewriteMetadata(secret.metadata) } : {}),
      data: { ...data },
    };
  };
}
