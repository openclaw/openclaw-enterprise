import assert from "node:assert/strict";
import type {
  OpenShellGatewayClient,
  OpenShellSandboxCreateRequest,
  OpenShellSandboxResponse,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

type GatewayMethods = Pick<OpenShellGatewayClient, "createSandbox" | "getSandbox">;
type RevisionGateway = Omit<ReturnType<typeof workspaceGatewayClient>, keyof GatewayMethods> &
  GatewayMethods;
type ProvisionDependencies = {
  openShellDriver: (gatewayClient: RevisionGateway) => OpenShellSandboxDriver;
  prepareProvision: (
    driver: OpenShellSandboxDriver,
  ) => () => ReturnType<OpenShellSandboxDriver["provisionHarness"]>;
};

export async function verifyRevisionProviderRetention({
  openShellDriver,
  prepareProvision,
  storedSandbox,
  callCount,
}: ProvisionDependencies & {
  storedSandbox: (
    request: OpenShellSandboxCreateRequest,
    fields: Pick<OpenShellSandboxResponse, "serviceUrls">,
  ) => OpenShellSandboxResponse;
  callCount: (
    gatewayClient: Pick<RevisionGateway, "calls">,
    operation: "createProvider" | "updateProviderCredentials",
  ) => number;
}) {
  let sandboxCreates = 0;
  const gatewayClient: RevisionGateway = workspaceGatewayClient();
  gatewayClient.createSandbox = async (request) => {
    sandboxCreates++;
    if (sandboxCreates === 1) {
      throw new Error("CreateSandbox deadline exceeded");
    }
    return storedSandbox(request, { serviceUrls: { "": "http://codex.example.test" } });
  };
  const provision = prepareProvision(openShellDriver(gatewayClient));

  await assert.rejects(provision(), /deadline exceeded/);
  const [runtimeProvider] = [...gatewayClient.providers.keys()];
  assert.ok(runtimeProvider);
  assert.match(runtimeProvider, /^oce-runtime-/);

  await provision();

  assert.equal(sandboxCreates, 2);
  assert.equal(callCount(gatewayClient, "createProvider"), 1);
  assert.equal(callCount(gatewayClient, "updateProviderCredentials"), 0);
  assert.equal(gatewayClient.providers.has(runtimeProvider), true);
}

export async function verifyForeignSandboxAnnotations({
  openShellDriver,
  prepareProvision,
}: ProvisionDependencies) {
  let storedSandbox: OpenShellSandboxResponse | undefined;
  const gatewayClient: RevisionGateway = workspaceGatewayClient();
  gatewayClient.createSandbox = async (request) => {
    storedSandbox = {
      name: request.name,
      workspace: request.workspace,
      labels: structuredClone(request.labels),
      annotations: {
        ...structuredClone(request.annotations),
        "example.test/foreign-owner": "foreign",
      },
      spec: structuredClone(request.spec),
      serviceUrls: {},
    };
    return { ...storedSandbox, serviceUrls: { "": "http://codex.example.test" } };
  };
  gatewayClient.getSandbox = async () => storedSandbox;
  const provision = prepareProvision(openShellDriver(gatewayClient));

  await provision();
  await assert.rejects(provision(), /without exact AgentRevision ownership and content/);
}
