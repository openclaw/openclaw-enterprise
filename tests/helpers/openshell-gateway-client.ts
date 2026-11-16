import {
  GrpcOpenShellGatewayClient,
  type OpenShellGatewayClient,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";

function unexpectedRpc(operation: keyof OpenShellGatewayClient) {
  return async (): Promise<never> => {
    throw new Error(`Unexpected OpenShell fixture operation: ${operation}`);
  };
}

// Required RPCs fail closed until a scenario supplies their observation. Optional RPCs
// stay absent so a fixture cannot inadvertently enable a capability under test.
export const unconfiguredGateway = {
  health: unexpectedRpc("health"),
  getWorkspace: unexpectedRpc("getWorkspace"),
  createWorkspace: unexpectedRpc("createWorkspace"),
  deleteWorkspace: unexpectedRpc("deleteWorkspace"),
  createSandbox: unexpectedRpc("createSandbox"),
  getSandbox: unexpectedRpc("getSandbox"),
  getServiceUrl: unexpectedRpc("getServiceUrl"),
  getService: unexpectedRpc("getService"),
  deleteService: unexpectedRpc("deleteService"),
  deleteSandbox: unexpectedRpc("deleteSandbox"),
  execSandbox: unexpectedRpc("execSandbox"),
  getServiceDocument: unexpectedRpc("getServiceDocument"),
  postServiceDocument: unexpectedRpc("postServiceDocument"),
  serviceWebSocketHandshake: unexpectedRpc("serviceWebSocketHandshake"),
  serviceCodexReadinessStatus: unexpectedRpc("serviceCodexReadinessStatus"),
  getSandboxLogs: unexpectedRpc("getSandboxLogs"),
  getProviderProfile: unexpectedRpc("getProviderProfile"),
  importProviderProfile: unexpectedRpc("importProviderProfile"),
  updateProviderProfile: unexpectedRpc("updateProviderProfile"),
  listProviderProfiles: unexpectedRpc("listProviderProfiles"),
  deleteProviderProfile: unexpectedRpc("deleteProviderProfile"),
  createProvider: unexpectedRpc("createProvider"),
  getProvider: unexpectedRpc("getProvider"),
  listProviders: unexpectedRpc("listProviders"),
  deleteProvider: unexpectedRpc("deleteProvider"),
  updateProviderCredentials: unexpectedRpc("updateProviderCredentials"),
  updateProviderConfig: unexpectedRpc("updateProviderConfig"),
  getProviderCredential: unexpectedRpc("getProviderCredential"),
  detachSandboxProvider: unexpectedRpc("detachSandboxProvider"),
  getSandboxProviderStatus: unexpectedRpc("getSandboxProviderStatus"),
  configureProviderRefresh: unexpectedRpc("configureProviderRefresh"),
  rotateProviderCredential: unexpectedRpc("rotateProviderCredential"),
  getProviderRefreshStatus: unexpectedRpc("getProviderRefreshStatus"),
  deleteProviderRefresh: unexpectedRpc("deleteProviderRefresh"),
  close() {},
} satisfies OpenShellGatewayClient;

/** Preserve later observation changes and method receivers on injected scenario clients. */
export function completeOpenShellGatewayClient(
  client: Partial<OpenShellGatewayClient>,
): OpenShellGatewayClient {
  if (client instanceof GrpcOpenShellGatewayClient) {
    return client;
  }
  return new Proxy<OpenShellGatewayClient>(
    { ...unconfiguredGateway },
    {
      get(defaults, property): unknown {
        if (property in client) {
          const member: unknown = Reflect.get(client, property);
          return typeof member === "function" ? member.bind(client) : member;
        }
        return Reflect.get(defaults, property);
      },
      set(_defaults, property, member: unknown) {
        return Reflect.set(client, property, member);
      },
    },
  );
}
