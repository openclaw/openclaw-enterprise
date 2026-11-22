import assert from "node:assert/strict";

import type { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { buildSandboxInstallation } from "./sandbox-driver-startup-installation-fixture.ts";
import type {
  kubernetesObjectClient as makeKubernetesObjectClient,
  KubernetesMutation,
} from "./sandbox-driver-startup-orchestration.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

type GatewayEvent = Parameters<
  NonNullable<Parameters<typeof workspaceGatewayClient>[1]>["push"]
>[0];
type OperatorEvent = GatewayEvent | KubernetesMutation;
type NamespaceContext = Parameters<OpenShellSandboxDriver["ensureNamespace"]>[0];
type OperatorFixture = ReturnType<typeof operatorWorkspaceChartFixture>;

function operatorWorkspaceChartFixture() {
  const events: OperatorEvent[] = [];
  const baseConfiguration = buildSandboxInstallation().drivers.sandbox.configuration;
  const configuration = {
    ...baseConfiguration,
    gateway: {
      ...baseConfiguration.gateway,
      operatorWorkspaceResources: [
        { apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "openshell-sandbox" } },
      ],
    },
  };
  const gatewayClient = workspaceGatewayClient([], events);
  return { gatewayClient, configuration, events };
}

export async function verifyOperatorWorkspaceChart({
  openShellDriver,
  namespaceContext,
  kubernetesObjectClient,
}: {
  openShellDriver: (
    gatewayClient: OperatorFixture["gatewayClient"],
    configuration: OperatorFixture["configuration"],
  ) => Pick<OpenShellSandboxDriver, "ensureNamespace" | "cleanup">;
  namespaceContext: () => Omit<NamespaceContext, "kubernetes"> & {
    kubernetes: NamespaceContext["kubernetes"];
  };
  kubernetesObjectClient: typeof makeKubernetesObjectClient;
}): Promise<void> {
  const fixture = operatorWorkspaceChartFixture();
  const driver = openShellDriver(fixture.gatewayClient, fixture.configuration);
  const context = namespaceContext();
  context.kubernetes = kubernetesObjectClient(fixture.events);
  const namespaceName = context.namespace.name;

  // The Gateway must not observe a Workspace until its operator-mode RBAC and
  // ServiceAccount resources have converged in the Compute-owned namespace.
  await driver.ensureNamespace(context);
  assert.deepEqual(fixture.events, [
    ["kubernetes", "patch", "ServiceAccount", "openshell-sandbox", namespaceName],
    ["gateway", "health"],
    ["gateway", "getWorkspace", namespaceName],
    ["gateway", "createWorkspace", namespaceName],
  ]);

  fixture.events.length = 0;
  await driver.cleanup(context);
  assert.deepEqual(fixture.events, [
    ["gateway", "getWorkspace", namespaceName],
    ["gateway", "deleteWorkspace", namespaceName],
    ["gateway", "getWorkspace", namespaceName],
    ["kubernetes", "delete", "ServiceAccount", "openshell-sandbox", namespaceName],
  ]);
}

export function buildOperatorIngressManifests() {
  // The stock OpenShell workspace chart's SSH policy as occ dev renders it, in wire form.
  const sshIngress = {
    from: [
      {
        namespaceSelector: {
          matchLabels: { "kubernetes.io/metadata.name": "openshell-system" },
        },
        podSelector: { matchLabels: { "app.kubernetes.io/instance": "openshell-gateway" } },
      },
    ],
    ports: [{ protocol: "TCP", port: 2222 }],
  };
  const ingress = [sshIngress];
  const policy = (name: string) => ({
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name },
    spec: {
      podSelector: { matchLabels: { "openshell.ai/managed-by": "openshell" } },
      policyTypes: ["Ingress"],
      ingress: structuredClone(ingress),
    },
  });
  // A provider CRD that is also named NetworkPolicy has no SDK model: the client sends it as
  // written, so renaming its `from` would make the API server drop the field.
  const crdIngress = [{ action: "Allow", ...structuredClone(sshIngress) }];
  const crdPolicy = {
    apiVersion: "crd.antrea.io/v1beta1",
    kind: "NetworkPolicy",
    metadata: { name: "provider-crd-ingress" },
    spec: {
      appliedTo: [{ podSelector: { matchLabels: { "openshell.ai/managed-by": "openshell" } } }],
      ingress: structuredClone(crdIngress),
    },
  };
  return { ingress, policy, crdIngress, crdPolicy };
}
