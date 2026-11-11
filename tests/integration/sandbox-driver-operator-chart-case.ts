import assert from "node:assert/strict";

import type { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { buildSandboxInstallation } from "./sandbox-driver-startup-installation-fixture.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

type GatewayEvent = Parameters<
  NonNullable<Parameters<typeof workspaceGatewayClient>[1]>["push"]
>[0];
type OperatorEvent =
  GatewayEvent | ["kubernetes", "patch" | "delete", "ServiceAccount", "openshell-sandbox", string];

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

export async function verifyOperatorWorkspaceChart(
  setup: (fixture: ReturnType<typeof operatorWorkspaceChartFixture>) => {
    namespaceName: Parameters<OpenShellSandboxDriver["ensureNamespace"]>[0]["namespace"]["name"];
    ensureNamespace: () => ReturnType<OpenShellSandboxDriver["ensureNamespace"]>;
    cleanup: () => ReturnType<OpenShellSandboxDriver["cleanup"]>;
  },
): Promise<void> {
  const fixture = operatorWorkspaceChartFixture();
  const { namespaceName, ensureNamespace, cleanup } = setup(fixture);

  // The Gateway must not observe a Workspace until its operator-mode RBAC and
  // ServiceAccount resources have converged in the Compute-owned namespace.
  await ensureNamespace();
  assert.deepEqual(fixture.events, [
    ["kubernetes", "patch", "ServiceAccount", "openshell-sandbox", namespaceName],
    ["gateway", "health"],
    ["gateway", "getWorkspace", namespaceName],
    ["gateway", "createWorkspace", namespaceName],
  ]);

  fixture.events.length = 0;
  await cleanup();
  assert.deepEqual(fixture.events, [
    ["gateway", "getWorkspace", namespaceName],
    ["gateway", "deleteWorkspace", namespaceName],
    ["gateway", "getWorkspace", namespaceName],
    ["kubernetes", "delete", "ServiceAccount", "openshell-sandbox", namespaceName],
  ]);
}
