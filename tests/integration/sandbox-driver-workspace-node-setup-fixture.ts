import assert from "node:assert/strict";
import type { createKubernetesClientConfiguration } from "../../apps/controller/src/drivers/kubernetes/client.ts";
import { asRecord } from "../../packages/utils/src/index.ts";

/** The Kubernetes Secret stores a base64url-encoded setup envelope. */
function workspaceNodeSetupCode(setup: object): string {
  return Buffer.from(JSON.stringify(setup)).toString("base64url");
}

// Keep the wire encoding independent of admission. Rejection cases also send invalid envelopes.
export function workspaceNodeSetupSecretData(setup: object): { setupCode: string } {
  return { setupCode: Buffer.from(workspaceNodeSetupCode(setup)).toString("base64") };
}

export function workspaceNodeSetupSecret<Data extends Readonly<Record<string, string>>>(
  metadata: { name: string; namespace?: string },
  namespaceId: string,
  agentId: string,
  data: Data,
) {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      ...metadata,
      labels: { "openclaw.dev/namespace": namespaceId, "openclaw.dev/agent": agentId },
    },
    data: { ...data },
  };
}

type KubernetesSdk = Awaited<ReturnType<typeof createKubernetesClientConfiguration>>["sdk"];
type KubernetesApi = InstanceType<KubernetesSdk["KubernetesObjectApi"]>;

export type WorkspaceNodeSecretReference = Parameters<KubernetesApi["read"]>[0];

export type KubernetesReader = {
  read: (request: WorkspaceNodeSecretReference) => Promise<unknown>;
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
