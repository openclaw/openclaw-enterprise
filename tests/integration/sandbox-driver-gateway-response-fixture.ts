import type {
  OpenShellSandboxCreateRequest,
  OpenShellSandboxResponse,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

/** The gateway's record of a created Sandbox, serving its Harness at a per-Sandbox URL. */
export function storedSandbox(
  request: Pick<
    OpenShellSandboxCreateRequest,
    "name" | "workspace" | "labels" | "annotations" | "spec"
  >,
  fields: Partial<OpenShellSandboxResponse> = {},
): OpenShellSandboxResponse & Pick<OpenShellSandboxCreateRequest, "spec"> {
  const url = `http://${request.workspace}--${request.name}.openshell.test/`;
  return {
    name: request.name,
    workspace: request.workspace,
    labels: request.labels,
    annotations: request.annotations,
    spec: request.spec,
    serviceUrls: { "": url },
    ...fields,
  };
}

export function callCount(
  gatewayClient: Pick<ReturnType<typeof workspaceGatewayClient>, "calls">,
  operation: string,
): number {
  return gatewayClient.calls.filter(([called]) => called === operation).length;
}
