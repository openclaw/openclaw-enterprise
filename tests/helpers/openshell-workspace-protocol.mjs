import { createRequire } from "node:module";

const { KubernetesObjectApi } = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
)("@kubernetes/client-node");

/** The object-client boundary for fixtures that apply operator Workspace manifests. */
export function openShellNamespaceObjects() {
  return Object.assign(Object.create(KubernetesObjectApi.prototype), {
    async patch(resource) {
      return structuredClone(resource);
    },
  });
}

/**
 * Namespace RPC state for admission and log fixtures. Only the provider boundary is
 * simulated; OCC and the selected OpenShell Driver still perform Namespace setup.
 * These fixtures do not establish real gateway or Kubernetes readiness.
 * @returns {any}
 */
export function openShellWorkspaceProtocol() {
  const workspaces = new Map();
  const operations = {
    async health() {},
    async getWorkspace(name) {
      return workspaces.get(name);
    },
    async createWorkspace(name, labels) {
      const workspace = { name, labels: structuredClone(labels), phase: "WORKSPACE_PHASE_ACTIVE" };
      workspaces.set(name, workspace);
      return workspace;
    },
    async deleteWorkspace(name) {
      workspaces.delete(name);
    },
    close() {},
  };
  return operations;
}
