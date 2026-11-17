import { KubernetesObjectApi } from "../../apps/controller/node_modules/@kubernetes/client-node/dist/index.js";
import type {
  OpenShellGatewayClient,
  OpenShellWorkspaceResponse,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";

/** The object-client boundary for fixtures that apply operator Workspace manifests. */
export function openShellNamespaceObjects(): Pick<KubernetesObjectApi, "patch"> {
  const objects: Pick<KubernetesObjectApi, "patch"> = {
    async patch(resource) {
      return structuredClone(resource);
    },
  };
  // OpenShell admits the native SDK client by prototype. The fixture only intercepts patch.
  Object.setPrototypeOf(objects, KubernetesObjectApi.prototype);
  return objects;
}

type WorkspaceProtocol = Pick<
  OpenShellGatewayClient,
  "health" | "getWorkspace" | "createWorkspace" | "deleteWorkspace" | "close"
>;

/**
 * Simulates the provider's Workspace RPCs while OCC and the selected Driver run
 * Namespace setup. This fixture does not establish gateway or Kubernetes readiness.
 */
export function openShellWorkspaceProtocol(): WorkspaceProtocol {
  const workspaces = new Map<string, OpenShellWorkspaceResponse>();
  return {
    async health() {},
    async getWorkspace(name) {
      return workspaces.get(name);
    },
    async createWorkspace(name, labels) {
      const workspace: OpenShellWorkspaceResponse = {
        name,
        labels: structuredClone(labels),
        phase: "WORKSPACE_PHASE_ACTIVE",
      };
      workspaces.set(name, workspace);
      return workspace;
    },
    async deleteWorkspace(name) {
      workspaces.delete(name);
    },
    close() {},
  };
}
