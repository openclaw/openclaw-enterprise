import assert from "node:assert/strict";
import {
  KubernetesObjectApi,
  V1Deployment,
} from "../../apps/controller/node_modules/@kubernetes/client-node/dist/index.js";
import { ObjectSerializer } from "../../apps/controller/node_modules/@kubernetes/client-node/dist/serializer.js";
import { RUNTIME_WRAPPER_COMMAND } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import type { OpenShellServiceResponse } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type { Namespace } from "../../packages/contracts/src/index.ts";
import { storedSandbox } from "./sandbox-driver-gateway-response-fixture.ts";
import { makeStructuralRefusal } from "./sandbox-driver-installation-fixture.ts";
import type { SandboxFixtureRevision } from "./sandbox-driver-revision-fixture.ts";
import { createSandboxDriverWorkloadFixtures } from "./sandbox-driver-workload-fixture.ts";

export { KubernetesObjectApi, V1Deployment };
export type KubernetesObject = Parameters<KubernetesObjectApi["create"]>[0];
export type ResourceReference = Parameters<KubernetesObjectApi["read"]>[0];

export type NamespaceContext = {
  namespace: Namespace;
  kubernetes: object;
  signal: AbortSignal;
};

export function harnessRuntimeCommand(program: string): string[] {
  return [...RUNTIME_WRAPPER_COMMAND, ...nodeProgramArguments(program)];
}

export type KubernetesMutation = [
  "kubernetes",
  "patch" | "delete",
  string,
  string,
  string | undefined,
];
type KubernetesMutationResource = {
  kind: string;
  metadata: { name: string; namespace?: string | undefined };
};

export function kubernetesObjectClient(
  events: [] | { push: (event: KubernetesMutation) => number },
) {
  const mutations: Pick<KubernetesMutation[], "push"> = events;
  const client = {
    async patch<Resource extends KubernetesMutationResource>(resource: Resource) {
      mutations.push([
        "kubernetes",
        "patch",
        resource.kind,
        resource.metadata.name,
        resource.metadata.namespace,
      ]);
      return resource;
    },
    async delete(resource: KubernetesMutationResource) {
      mutations.push([
        "kubernetes",
        "delete",
        resource.kind,
        resource.metadata.name,
        resource.metadata.namespace,
      ]);
    },
  };
  Object.setPrototypeOf(client, KubernetesObjectApi.prototype);
  return client;
}

/** A dedicated Codex revision on `driver`; `n` is the 12-digit tail of its ids. */
export function dedicatedRevision(
  driver: { readonly id: string },
  context: Pick<NamespaceContext, "namespace">,
  n: string,
): SandboxFixtureRevision {
  return {
    id: `rev_00000000-0000-4000-8000-${n}`,
    namespaceId: context.namespace.id,
    agentId: `agt_00000000-0000-4000-8000-${n}`,
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    sandboxDriverId: driver.id,
  };
}

/** A Workspace labelled as the one OCC owns for `namespaceId`. */
export function ownedWorkspace(name: string, namespaceId: string) {
  const labels = {
    "app.kubernetes.io/managed-by": "openclaw-enterprise",
    "openclaw.dev/namespace-id": namespaceId,
  };
  return { name, labels, phase: "WORKSPACE_PHASE_ACTIVE" };
}

/** A live Sandbox record by name, as GetSandbox reports one without its Harness service. */
export function sandboxRecord(name: string, workspace: string) {
  return storedSandbox(
    { name, workspace, labels: {}, annotations: {}, spec: {} },
    { serviceUrls: {} },
  );
}

/** The Codex Harness's bearer-passthrough service at `url`, or none. */
export function harnessService(
  sandbox: string,
  name: string,
  url: string | undefined,
): OpenShellServiceResponse | undefined {
  return url === undefined
    ? undefined
    : { sandbox, name, targetPort: 8080, authorizationMode: 2, advertisedUrl: url, url };
}

export function structuralRefusal(
  path: string,
  keyword: string,
  code: Parameters<typeof makeStructuralRefusal>[2] = "INVALID_VALUE",
) {
  return makeStructuralRefusal(path, keyword, code);
}

export function namespaceContext(name = "oce-123456789012345"): NamespaceContext {
  return {
    namespace: {
      id: "ns_00000000-0000-4000-8000-000000000001",
      name,
      status: "ready",
      createdAt: "2026-09-23T00:00:00.000Z",
    },
    kubernetes: {},
    signal: new AbortController().signal,
  };
}

function deserializeDeployment(deployment: KubernetesObject): V1Deployment {
  const wire: unknown = JSON.parse(JSON.stringify(deployment));
  const decoded: unknown = ObjectSerializer.deserialize(wire, "V1Deployment");
  assert.ok(decoded instanceof V1Deployment);
  return decoded;
}

// Controlled Kubernetes transport: verifies the production preparation manifest and
// ordering only. The real k3d case must prove filesystem effects and Pod termination.
function nativePreparationClient(reader: {
  read(resource: ResourceReference): Promise<KubernetesObject>;
}) {
  const prepared: KubernetesObject[] = [];
  let deployment: (KubernetesObject & { status: V1Deployment["status"] }) | undefined;
  const read = reader.read.bind(reader);
  const client = {
    async read(resource: ResourceReference) {
      if (resource.kind === "Namespace") {
        return { ...resource };
      }
      if (resource.kind === "Deployment") {
        if (deployment === undefined) {
          throw { code: 404 };
        }
        // Use the same decoder as KubernetesObjectApi.read, including nested SDK models.
        return deserializeDeployment(deployment);
      }
      return read(resource);
    },
    async create(resource: KubernetesObject) {
      prepared.push(structuredClone(resource));
      deployment = {
        ...resource,
        metadata: { ...resource.metadata, uid: "preparation-uid", generation: 1 },
        status: { availableReplicas: 1, observedGeneration: 1 },
      };
      return deserializeDeployment(deployment);
    },
    async delete(
      ...[resource, , , , , propagation, body]: Parameters<KubernetesObjectApi["delete"]>
    ) {
      assert.equal(resource.kind, "Deployment");
      assert.equal(propagation, "Foreground");
      assert.equal(body?.preconditions?.uid, "preparation-uid");
      deployment = undefined;
    },
    async list(): Promise<{ items: KubernetesObject[] }> {
      return { items: [] };
    },
  };
  Object.setPrototypeOf(client, KubernetesObjectApi.prototype);
  return { client, prepared };
}

export const { codexRequirements, runtimeSandboxFixture } = createSandboxDriverWorkloadFixtures({
  kubernetesPrototype: KubernetesObjectApi.prototype,
  harnessRuntimeCommand,
  namespaceContext,
  prepareNative: nativePreparationClient,
});
