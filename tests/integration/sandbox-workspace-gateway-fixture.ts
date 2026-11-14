import assert from "node:assert/strict";
import {
  GrpcOpenShellGatewayClient,
  type OpenShellGatewayClient,
  type OpenShellProviderCreateRequest,
  type OpenShellProviderProfile,
  type OpenShellProviderResponse,
  type OpenShellSandboxResponse,
  type OpenShellStoredProviderProfile,
  type OpenShellWorkspaceResponse,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";

type StringValues = Readonly<Record<string, string>>;

type WorkspaceProfile = Omit<OpenShellStoredProviderProfile, "annotations" | "definition"> & {
  annotations: OpenShellStoredProviderProfile["annotations"];
  definition?: NonNullable<OpenShellStoredProviderProfile["definition"]>;
  profile?: OpenShellProviderProfile;
};
type WorkspaceObservation = Omit<OpenShellWorkspaceResponse, "phase"> & {
  phase?: NonNullable<OpenShellWorkspaceResponse["phase"]>;
};

type WorkspaceGatewayCall =
  | ["health"]
  | ["getWorkspace" | "deleteWorkspace" | "deleteProvider", string]
  | ["createWorkspace" | "updateProviderCredentials", string, StringValues]
  | ["createProvider", OpenShellProviderCreateRequest]
  | ["updateProviderConfig", string, StringValues, string];

export type WorkspaceGatewayEvent =
  | ["gateway", "health"]
  | ["gateway", "getWorkspace" | "createWorkspace" | "deleteWorkspace", string];

function unexpectedRpc(operation: keyof OpenShellGatewayClient) {
  return async (): Promise<never> => {
    throw new Error(`Unexpected OpenShell fixture operation: ${operation}`);
  };
}

// Required RPCs fail closed until a scenario supplies their observation. Optional RPCs
// stay absent so a fixture cannot inadvertently enable a capability under test.
const unconfiguredGateway = {
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

type WorkspaceGateway = Omit<OpenShellGatewayClient, "getWorkspace"> & {
  getWorkspace: (name: string, signal?: AbortSignal) => Promise<WorkspaceObservation | undefined>;
  calls: WorkspaceGatewayCall[];
  profiles: Map<string, WorkspaceProfile>;
  providers: Map<string, OpenShellProviderResponse>;
  sandboxes: Map<string, OpenShellSandboxResponse>;
  workspaces: Map<string, WorkspaceObservation>;
};

/** The gRPC FAILED_PRECONDITION error OpenShell answers a delete that members still block. */
function failedPrecondition(details: string) {
  return Object.assign(new Error(`9 FAILED_PRECONDITION: ${details}`), { code: 9, details });
}

export function workspaceGatewayClient(
  seed: readonly WorkspaceObservation[] = [],
  events: Pick<WorkspaceGatewayEvent[], "push"> = [],
): WorkspaceGateway {
  const workspaces = new Map(seed.map((workspace) => [workspace.name, structuredClone(workspace)]));
  const profiles = new Map<string, WorkspaceProfile>();
  const providers = new Map<string, OpenShellProviderResponse>();
  const sandboxes = new Map<string, OpenShellSandboxResponse>();
  const calls: WorkspaceGatewayCall[] = [];
  const storeProfile = (profile: OpenShellProviderProfile, resourceVersion: string) =>
    profiles.set(profile.id, {
      id: profile.id,
      resourceVersion,
      annotations: structuredClone(profile.annotations),
      profile: structuredClone(profile),
    });
  return {
    ...unconfiguredGateway,
    calls,
    profiles,
    providers,
    sandboxes,
    workspaces,
    async health() {
      calls.push(["health"]);
      events.push(["gateway", "health"]);
    },
    async getWorkspace(name: string) {
      calls.push(["getWorkspace", name]);
      events.push(["gateway", "getWorkspace", name]);
      return workspaces.get(name);
    },
    async createWorkspace(name: string, labels: StringValues) {
      calls.push(["createWorkspace", name, structuredClone(labels)]);
      events.push(["gateway", "createWorkspace", name]);
      const workspace = { name, labels: structuredClone(labels), phase: "WORKSPACE_PHASE_ACTIVE" };
      workspaces.set(name, workspace);
      return workspace;
    },
    async deleteWorkspace(name: string) {
      calls.push(["deleteWorkspace", name]);
      events.push(["gateway", "deleteWorkspace", name]);
      // As OpenShell 0.1.4 (grpc/workspace.rs): a Workspace that still holds Sandboxes,
      // providers or provider profiles stays, and the delete is refused. Every scenario on this
      // fake has one Workspace, so its maps hold that Workspace's members.
      const blocking = [
        ...(sandboxes.size > 0 ? ["sandbox"] : []),
        ...(providers.size > 0 ? ["provider"] : []),
        ...(profiles.size > 0 ? ["provider profile"] : []),
      ];
      if (workspaces.has(name) && blocking.length > 0) {
        throw failedPrecondition(
          `workspace '${name}' still contains resources: ${blocking.join(", ")}`,
        );
      }
      workspaces.delete(name);
    },
    async createSandbox() {
      throw new Error("Sandbox creation is outside this Namespace lifecycle scenario.");
    },
    async getSandbox({ name }) {
      return sandboxes.get(name);
    },
    async getService() {
      return undefined;
    },
    async deleteSandbox({ name }) {
      sandboxes.delete(name);
    },
    async getProviderProfile(_workspace: string | null, id: string) {
      return profiles.get(id);
    },
    async listProviderProfiles() {
      // Every profile here was imported into the Workspace.
      return [...profiles.values()].map((profile) => ({
        ...profile,
        definition: { ...profile.definition, scope: "workspace" },
      }));
    },
    async importProviderProfile(_workspace: string, profile: OpenShellProviderProfile) {
      storeProfile(profile, "1");
    },
    async updateProviderProfile(_workspace: string, profile: OpenShellProviderProfile) {
      storeProfile(profile, "2");
    },
    async deleteProviderProfile(_workspace: string, id: string) {
      // OpenShell refuses to delete a profile a provider still uses.
      if ([...providers.values()].some((provider) => provider.type === id)) {
        throw failedPrecondition(`provider profile '${id}' is in use by providers`);
      }
      profiles.delete(id);
    },
    async createProvider(request: OpenShellProviderCreateRequest) {
      calls.push(["createProvider", structuredClone(request)]);
      if (providers.has(request.name)) {
        throw new Error(`Provider ${request.name} already exists.`);
      }
      const provider = {
        name: request.name,
        type: request.type,
        labels: structuredClone(request.labels),
        config: structuredClone(request.config ?? {}),
        resourceVersion: "1",
      };
      providers.set(request.name, provider);
      return provider;
    },
    async getProvider(_workspace: string, name: string) {
      return providers.get(name);
    },
    async listProviders() {
      return [...providers.values()];
    },
    async deleteProvider(_workspace: string, name: string) {
      calls.push(["deleteProvider", name]);
      // OpenShell refuses to delete a provider a Sandbox still attaches.
      if (
        [...sandboxes.values()].some((sandbox) => {
          const attached = sandbox.spec?.providers;
          return Array.isArray(attached) && attached.includes(name);
        })
      ) {
        throw failedPrecondition(`provider '${name}' is attached to sandbox(es)`);
      }
      providers.delete(name);
    },
    async updateProviderCredentials(_workspace: string, name: string, credentials: StringValues) {
      calls.push(["updateProviderCredentials", name, structuredClone(credentials)]);
    },
    async updateProviderConfig(
      _workspace: string,
      name: string,
      config: StringValues,
      expectedResourceVersion: string,
    ) {
      calls.push(["updateProviderConfig", name, structuredClone(config), expectedResourceVersion]);
      const provider = providers.get(name);
      assert.ok(provider, `Provider ${name} must exist before an update.`);
      assert.equal(provider.resourceVersion, expectedResourceVersion);
      const updated = {
        ...provider,
        config: { ...provider.config, ...structuredClone(config) },
        resourceVersion: String(Number(provider.resourceVersion) + 1),
      };
      providers.set(name, updated);
      return updated;
    },
    close() {},
  };
}
