import type {
  AgentRevision,
  HarnessWorkloadRequirements,
  SandboxHarnessContext,
} from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import type {
  OpenShellGatewayClient,
  OpenShellProviderResponse,
  OpenShellStoredProviderProfile,
  OpenShellSandboxCreateRequest,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import assert from "node:assert/strict";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import {
  KubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { routedOptions, authContext, tenant } from "./kubernetes-routed-scenarios.mjs";

export function launchCompute(Driver: typeof KubernetesComputeDriver = KubernetesComputeDriver) {
  const options = routedOptions({
    runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
  });
  return new Driver(
    {
      ...options,
      servicePrincipalCredentials: { mode: "disabled" },
      authentication: { ...options.authentication, mode: "kubeconfig" },
    },
    { id: "compute-launch-compat" },
  );
}

// The preparation path's real snapshot, Deployment, node wrapper and Sandbox requirements builders.
export function launchRequirements(
  driver: KubernetesComputeDriver,
  revision: AgentRevision,
  node = false,
) {
  const namespace: { name: string; plane: "execution" } = {
    name: kubernetesNamespaceName(revision.namespaceId),
    plane: "execution",
  };
  const snapshot = driver["pluginRuntimeSnapshot"](revision);
  assert.ok(snapshot);
  const deployment = driver["deployment"](
    "agent-launch",
    {
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      servicePrincipalId: revision.servicePrincipalId,
      revisionId: revision.id,
    },
    namespace,
    "agent:local",
    "agent-launch",
    "agent",
    {},
    "info",
    undefined,
    false,
    undefined,
    driver["harnessAuthForRevision"](revision, authContext(revision, namespace.name), namespace),
    [],
    [],
    snapshot,
  );
  if (node) {
    driver["addWorkspaceNode"](
      deployment,
      "workspace-node-000000000001-000000000002",
      undefined,
      revision,
      true,
      undefined,
      snapshot.workspaceEntrypoint,
    );
  }
  const requirements = driver["harnessRequirementsFromDeployment"](
    deployment,
    "api_key",
    node,
    [],
    driver["sandboxWorkloadFiles"](snapshot),
  );
  const containers = asRecord(asRecord(deployment.spec?.template)?.spec)?.containers;
  assert.ok(Array.isArray(containers));
  const container = asRecord(containers[0]);
  const command = container?.command;
  const args = container?.args;
  assert.ok(
    Array.isArray(command) && command.every((item): item is string => typeof item === "string"),
  );
  assert.ok(Array.isArray(args) && args.every((item): item is string => typeof item === "string"));
  return { requirements, command, args };
}

// The peer retains one live record across worker replacement. All comparison,
// wrapping and adoption decisions belong to the production Sandbox Driver.
export function sandboxPeer() {
  const profiles = new Map<string, OpenShellStoredProviderProfile>();
  const providers = new Map<string, OpenShellProviderResponse>();
  type LiveSandbox = OpenShellSandboxCreateRequest & {
    id: string;
    phase: string;
    serviceUrls: Record<string, string>;
  };
  const sandboxes = new Map<string, LiveSandbox>();
  let creates = 0;
  const unexpected = (): never => assert.fail("unexpected Gateway operation");
  const client: OpenShellGatewayClient = {
    health: unexpected,
    getWorkspace: unexpected,
    createWorkspace: unexpected,
    deleteWorkspace: unexpected,
    getServiceUrl: unexpected,
    deleteService: unexpected,
    deleteSandbox: unexpected,
    execSandbox: unexpected,
    getServiceDocument: unexpected,
    postServiceDocument: unexpected,
    serviceWebSocketHandshake: unexpected,
    updateProviderProfile: unexpected,
    listProviderProfiles: unexpected,
    deleteProviderProfile: unexpected,
    listProviders: unexpected,
    deleteProvider: unexpected,
    updateProviderCredentials: unexpected,
    updateProviderConfig: unexpected,
    getProviderCredential: unexpected,
    detachSandboxProvider: unexpected,
    getSandboxProviderStatus: unexpected,
    configureProviderRefresh: unexpected,
    rotateProviderCredential: unexpected,
    getProviderRefreshStatus: unexpected,
    deleteProviderRefresh: unexpected,
    getSandboxLogs: unexpected,
    close: unexpected,

    async getProviderProfile(_workspace, id) {
      return profiles.get(id);
    },
    async importProviderProfile(_workspace, profile) {
      profiles.set(profile.id, {
        id: profile.id,
        resourceVersion: "1",
        annotations: structuredClone(profile.annotations),
        definition: { ...structuredClone(profile) },
      });
    },
    async getProvider(_workspace, name) {
      return providers.get(name);
    },
    async createProvider(request) {
      const p = { ...structuredClone(request), config: request.config ?? {}, resourceVersion: "1" };
      providers.set(p.name, p);
      return p;
    },
    async getSandbox({ name }) {
      return sandboxes.get(name);
    },
    async createSandbox(request) {
      creates++;
      assert.equal(
        sandboxes.has(request.name),
        false,
        "an existing Sandbox must never be replayed",
      );
      const record = {
        ...structuredClone(request),
        id: "sandbox-" + creates,
        phase: "SANDBOX_PHASE_READY",
        serviceUrls: { "": "https://127.0.0.1:4444" },
      };
      sandboxes.set(request.name, record);
      return record;
    },
    async getService(_workspace, name) {
      const sandbox = sandboxes.get(name);
      assert.ok(sandbox);
      const url = sandbox.serviceUrls[""];
      const exposure = sandbox.serviceExposures[0];
      assert.ok(url && exposure);
      return {
        sandbox: name,
        name: "",
        advertisedUrl: url,
        url,
        targetPort: exposure.targetPort,
        authorizationMode: 2,
      };
    },
  };
  const driver = () =>
    new OpenShellSandboxDriver(
      {
        gateway: { workspaceMode: "operator" },
        kubernetes: {
          runtimeClassName: "synthetic",
          serviceAccount: { mode: "gatewayConfigured" },
          sandboxDataMount: {
            mountPath: "/sandbox/workspace",
            subPath: "workspace",
            readOnly: false,
          },
        },
        policy: {
          process: { runAsUser: "1000", runAsGroup: "1000" },
          networkPolicies: [
            {
              name: "synthetic-loopback",
              binaries: [{ path: "/usr/local/bin/node" }],
              endpoints: [{ host: "127.0.0.1", ports: [4444] }],
            },
          ],
        },
      },
      {
        id: "sandbox-compat",
        backend: {
          id: "backend-compat",
          drivers: { sandbox: "sandbox-compat" },
          client: new OpenShellGateway(
            { endpoint: "https://127.0.0.1:4444" },
            { gatewayClient: client },
          ),
        },
      },
    );
  return {
    driver,
    sandboxes,
    get creates() {
      return creates;
    },
  };
}

export function sandboxContext(
  revision: AgentRevision,
  requirements: HarnessWorkloadRequirements,
): SandboxHarnessContext {
  // Closed synthetic credential delivery; no Secret or provider lookup is performed.
  const environment = requirements.environment.filter(
    (v) => !["APP_SERVER_TOKEN", "OPENAI_API_KEY"].includes(v.name),
  );
  environment.push(
    { name: "APP_TOKEN_SHA", value: "a".repeat(64) },
    { name: "OPENAI_API_KEY", value: "synthetic-local-key" },
  );
  return {
    namespace: { ...tenant, id: revision.namespaceId, name: "compat-local", status: "ready" },
    revision,
    kubernetes: undefined,
    requirements: { ...requirements, environment },
    signal: new AbortController().signal,
  };
}
