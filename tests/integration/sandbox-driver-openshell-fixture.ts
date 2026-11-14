import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import type { OpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import {
  OpenShellSandboxDriver,
  type OpenShellSandboxDriverOptions,
  type OpenShellSandboxDriverSelection,
} from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { buildSandboxInstallation } from "./sandbox-driver-startup-installation-fixture.ts";
import { completeOpenShellGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

export function backendFor(
  gatewayClient: Partial<OpenShellGatewayClient>,
): OpenShellSandboxDriverSelection["backend"] {
  return {
    id: "openshell",
    drivers: { sandbox: "openshell-sandbox", credential_gateway: "openshell-credentials" },
    client: new OpenShellGateway(
      { serviceName: "openshell-gateway" },
      { gatewayClient: completeOpenShellGatewayClient(gatewayClient) },
    ),
  };
}

export function openShellDriver(
  gatewayClient: Partial<OpenShellGatewayClient>,
  configuration?: OpenShellSandboxDriverOptions | null,
): OpenShellSandboxDriver {
  return new OpenShellSandboxDriver(
    configuration ?? buildSandboxInstallation().drivers.sandbox.configuration,
    { id: "openshell-sandbox", implementation: "openshell", backend: backendFor(gatewayClient) },
  );
}
