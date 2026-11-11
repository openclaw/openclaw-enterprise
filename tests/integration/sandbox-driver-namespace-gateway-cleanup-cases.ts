import assert from "node:assert/strict";
import test from "node:test";
import type { createKubernetesClientConfiguration } from "../../apps/controller/src/drivers/kubernetes/client.ts";
import type { OpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type {
  OpenShellSandboxDriver,
  OpenShellSandboxDriverOptions,
} from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type { SandboxNamespaceContext } from "../../packages/contracts/src/index.ts";

type KubernetesSdk = Awaited<ReturnType<typeof createKubernetesClientConfiguration>>["sdk"];
type KubernetesApi = InstanceType<KubernetesSdk["KubernetesObjectApi"]>;
type Configuration = Omit<OpenShellSandboxDriverOptions, "gateway"> & {
  gateway: {
    -readonly [
      Key in keyof OpenShellSandboxDriverOptions["gateway"]
    ]: OpenShellSandboxDriverOptions["gateway"][Key];
  };
};
type Fixtures = {
  KubernetesObjectApi: KubernetesSdk["KubernetesObjectApi"];
  sandboxInstallation: () => { drivers: { sandbox: { configuration: Configuration } } };
  openShellDriver: (
    gateway: Pick<OpenShellGatewayClient, "getWorkspace">,
    configuration: Configuration,
  ) => OpenShellSandboxDriver;
};

export function registerSandboxDriverNamespaceGatewayCleanupCases({
  KubernetesObjectApi,
  sandboxInstallation,
  openShellDriver,
}: Fixtures): void {
  test("managed Namespace cleanup removes unreachable owned gateways but preserves provider refusals", async () => {
    const { OpenShellGatewayUnavailableError } =
      await import("../../apps/controller/src/drivers/sandbox/openshell-gateway-errors.ts");
    for (const scenario of ["no-ready-pod", "transport-unavailable", "provider-denied"]) {
      const namespace: SandboxNamespaceContext["namespace"] = {
        id: "ns_cleanup",
        name: "cleanup-test",
        status: "deleting",
        createdAt: "2026-11-10T00:00:00Z",
      };
      const serviceName = "openshell-gateway";
      const manifests = [
        {
          apiVersion: "v1",
          kind: "Service",
          metadata: { name: serviceName },
          spec: { selector: { app: "gateway" }, ports: [{ port: 50051 }] },
        },
        {
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: { name: serviceName },
          spec: {
            selector: { matchLabels: { app: "gateway" } },
            template: {
              metadata: { labels: { app: "gateway" } },
              spec: { containers: [{ name: "gateway", image: "gateway:fixture" }] },
            },
          },
        },
      ];
      const objects = new Map(
        [
          ...manifests,
          { apiVersion: "v1", kind: "Secret", metadata: { name: `${serviceName}-jwt-keys` } },
        ].map((resource) => {
          const observed = {
            ...resource,
            metadata: {
              ...resource.metadata,
              namespace: namespace.name,
              uid: `${resource.kind}-uid`,
              resourceVersion: "1",
              labels: {
                "openclaw.dev/namespace": namespace.id,
                "app.kubernetes.io/managed-by": "openclaw-enterprise",
                "openclaw.dev/namespace-gateway": "true",
              },
              annotations: { "openclaw.dev/namespace-id": namespace.id },
            },
          };
          return [`${resource.kind}/${resource.metadata.name}`, observed];
        }),
      );
      const client = {
        read: async (resource: Parameters<KubernetesApi["read"]>[0]) => {
          if (resource.kind === "Namespace") {
            return { metadata: { name: namespace.name } };
          }
          const observed = objects.get(`${resource.kind}/${resource.metadata?.name}`);
          if (observed === undefined) {
            throw Object.assign(new Error("not found"), { code: 404 });
          }
          return observed;
        },
        list: async () => ({
          items:
            scenario === "no-ready-pod"
              ? []
              : [{ status: { conditions: [{ type: "Ready", status: "True" }] } }],
        }),
        delete: async (...[resource, , , , , , options]: Parameters<KubernetesApi["delete"]>) => {
          const key = `${resource.kind}/${resource.metadata?.name}`;
          const observed = objects.get(key);
          assert.ok(observed);
          assert.equal(options?.preconditions?.uid, observed.metadata.uid);
          objects.delete(key);
        },
      };
      Object.setPrototypeOf(client, KubernetesObjectApi.prototype);
      const configuration = sandboxInstallation().drivers.sandbox.configuration;
      configuration.gateway.readiness = {
        serviceName,
        podSelector: { app: "gateway" },
        timeoutMs: 10,
      };
      configuration.gateway.namespaceGatewayResources = manifests;
      let workspaceReads = 0;
      const driver = openShellDriver(
        {
          async getWorkspace() {
            workspaceReads += 1;
            assert.notEqual(scenario, "no-ready-pod", "Do not send RPCs to an absent backend.");
            if (scenario === "provider-denied") {
              throw Object.assign(new Error("permission denied"), {
                code: 7,
                details: "permission denied",
              });
            }
            throw new OpenShellGatewayUnavailableError("unreachable gateway", 14);
          },
        },
        configuration,
      );
      const context = { namespace, kubernetes: client, signal: new AbortController().signal };
      if (scenario === "provider-denied") {
        await assert.rejects(driver.cleanup(context), { name: "SandboxNamespaceRefusedError" });
        assert.equal(objects.size, 3, "Provider refusal preserves all owned resources.");
      } else {
        // Deletion is observed on a later pass, as with the Kubernetes API.
        await assert.rejects(driver.cleanup(context), { name: "SandboxNamespacePendingError" });
        assert.equal(objects.size, 0);
        await driver.cleanup(context);
      }
      assert.equal(workspaceReads, scenario === "no-ready-pod" ? 0 : 1);
    }
  });
}
