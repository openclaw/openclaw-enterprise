import assert from "node:assert/strict";
import {
  harnessAuthBindingFromSnapshot,
  type ComputeAgentRevisionBinding,
} from "../../packages/contracts/src/index.ts";
import {
  createKubernetesComputeDriver,
  kubernetesGatewayNamespaceName,
  kubernetesNamespaceName,
  type KubernetesComputeDriverOptions,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { gatewayRouting, routedRevision, tenant } from "../helpers/kubernetes-routed-scenarios.mjs";

type Role = "agent" | "gateway";
type Plane = "control" | "execution";
type RuntimeLogRequest = Parameters<
  ReturnType<typeof createKubernetesComputeDriver>["readAgentRuntimeLogs"]
>[1];
type BuildOptions = (
  overrides?: Pick<KubernetesComputeDriverOptions, "runtime" | "executionCluster">,
) => KubernetesComputeDriverOptions;

interface FixtureOptions {
  kubeconfigPath: string;
  contextName: string;
  twoCluster: boolean;
  options: BuildOptions;
  routedOptions: BuildOptions;
}

// The fixture supplies raw values for the driver's timestamp validation cases.
type FixtureTimestamp = Date | string | number | null;

interface FixtureContainerState {
  running?: { startedAt?: FixtureTimestamp };
  waiting?: { reason?: string };
  terminated?: { reason?: string; exitCode?: number; finishedAt?: FixtureTimestamp };
}

interface FixtureContainerStatus {
  name?: string;
  ready?: boolean;
  restartCount?: number;
  containerID?: string;
  state?: FixtureContainerState;
  lastState?: FixtureContainerState;
}

interface FixtureEvent {
  type: string;
  reason: string;
  message?: string;
  count?: number;
  series?: { count?: number; lastObservedTime?: FixtureTimestamp };
  eventTime?: FixtureTimestamp;
  lastTimestamp?: FixtureTimestamp;
  involvedObject?: { kind?: string; uid?: string; namespace?: string; fieldPath?: string };
}

interface EventQuery {
  namespace: string;
  fieldSelector: string;
  limit?: number | undefined;
  _continue?: string | undefined;
}

interface EventPage {
  items: FixtureEvent[];
  metadata?: { _continue?: string };
}

type LogQuery = Pick<
  RuntimeLogRequest,
  "previous" | "sinceSeconds" | "tailLines" | "limitBytes"
> & {
  namespace: string;
  name: string;
  container: Role;
  timestamps: boolean;
  follow: boolean;
};

type Call =
  | { plane: Plane; call: "listNamespace" }
  | { plane: Plane; call: "listNamespacedPod"; namespace: string; role: Role }
  | ({ plane: Plane; call: "listNamespacedEvent" } & EventQuery)
  | ({ plane: Plane; call: "readNamespacedPodLog" } & LogQuery);

interface FixtureState {
  restartCount: Record<Role, number>;
  foreignPod: boolean;
  foreignNamespacePod?: boolean;
  logs: Record<Role, string>;
  logError: unknown;
  eventError: unknown;
  eventPage: ((query: EventQuery) => EventPage | Promise<EventPage>) | undefined;
  nodeName: string | undefined;
  waitingReason: string | undefined;
  containerId: string | undefined;
  extraEvents: FixtureEvent[];
  containerStatus: FixtureContainerStatus | undefined;
  containerName?: string;
  initContainers?: { name: string }[];
  initContainerStatuses?: FixtureContainerStatus[];
  noMainStatus?: boolean;
  restartDuringRead?: boolean;
}

export function createRuntimeLogDriverFixture({
  kubeconfigPath,
  contextName,
  twoCluster,
  options,
  routedOptions,
}: FixtureOptions) {
  const namespaceName = kubernetesNamespaceName(tenant.id);
  const gatewayNamespaceName = twoCluster
    ? kubernetesGatewayNamespaceName(tenant.id)
    : namespaceName;
  const driver = createKubernetesComputeDriver(
    twoCluster
      ? routedOptions({
          runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
          executionCluster: {
            authentication: { mode: "kubeconfig", kubeconfigPath, context: contextName },
            harnessRouting: {
              ...gatewayRouting,
              gatewayName: "harnesses",
              hostname: "harness.example.test",
            },
            network: {
              dns: options().network.dns,
              harnessEndpointCidrs: ["192.0.2.2/32"],
              gatewayEndpointCidrs: ["192.0.2.1/32"],
              pluginStatusProxySourceCidrs: ["192.0.2.2/32"],
            },
          },
        })
      : options({
          runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
        }),
  );
  const revision = routedRevision(driver, {
    id: "revision-runtime-logs",
    agentId: "agent-runtime-logs",
    configurationId: "cfg_runtime_logs",
    servicePrincipalId: "service-principal-runtime-logs",
  });
  const binding: ComputeAgentRevisionBinding = {
    namespace: { ...tenant, status: "ready" },
    agent: {
      id: revision.agentId,
      namespaceId: revision.namespaceId,
      name: "Runtime logs Agent",
      desiredRuntimeState: "running",
      status: "active",
      configurationId: revision.configurationId,
      backendId: revision.backendId,
      harnessAuth: harnessAuthBindingFromSnapshot(revision.harnessAuth),
      executionMode: revision.harness.mode,
      gatewayManagedMode: revision.gatewayManagedMode,
      servicePrincipalId: revision.servicePrincipalId,
      createdAt: revision.createdAt,
    },
    revision,
  };
  const state: FixtureState = {
    restartCount: { agent: 0, gateway: 2 },
    foreignPod: false,
    logs: { agent: "", gateway: "" },
    logError: undefined,
    eventError: undefined,
    eventPage: undefined,
    nodeName: "runtime-logs-node",
    waitingReason: undefined,
    containerId: undefined,
    extraEvents: [],
    containerStatus: undefined,
  };
  const pod = (role: Role) => ({
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: `${role}-runtime-logs-pod`,
      namespace: role === "gateway" ? gatewayNamespaceName : namespaceName,
      uid: `${role}-runtime-logs-uid`,
      creationTimestamp: new Date("2026-09-30T10:00:00Z"),
      labels: {
        "openclaw.dev/agent": revision.agentId,
        "openclaw.dev/revision": revision.id,
        "openclaw.dev/workload-role": role,
      },
    },
    spec: {
      containers: [{ name: state.containerName ?? role }],
      initContainers: state.initContainers ?? [],
      ...(state.nodeName === undefined ? {} : { nodeName: state.nodeName }),
    },
    status: {
      phase:
        state.waitingReason === undefined || state.waitingReason === "CrashLoopBackOff"
          ? "Running"
          : "Pending",
      conditions: [{ type: "Ready", status: state.waitingReason === undefined ? "True" : "False" }],
      initContainerStatuses: state.initContainerStatuses ?? [],
      containerStatuses: state.noMainStatus
        ? []
        : [
            {
              name: state.containerName ?? role,
              ready: state.waitingReason === undefined,
              restartCount: state.restartCount[role],
              state:
                state.waitingReason === undefined
                  ? { running: { startedAt: new Date("2026-09-30T11:00:00Z") } }
                  : { waiting: { reason: state.waitingReason } },
              ...(state.containerId === undefined ? {} : { containerID: state.containerId }),
              ...(state.restartCount[role] === 0
                ? {}
                : {
                    lastState: {
                      terminated: {
                        reason: "OOMKilled",
                        exitCode: 137,
                        finishedAt: new Date("2026-09-30T10:59:00Z"),
                      },
                    },
                  }),
              ...state.containerStatus,
            },
          ],
    },
  });
  const calls: Call[] = [];
  const clientsFor = (plane: Plane) => ({
    core: {
      async listNamespace({ labelSelector }: { labelSelector: string }) {
        assert.equal(labelSelector, `openclaw.dev/namespace=${tenant.id}`);
        calls.push({ plane, call: "listNamespace" });
        return {
          apiVersion: "v1",
          kind: "NamespaceList",
          items: [
            {
              ...driver["manifest"]("v1", "Namespace", namespaceName, { namespaceId: tenant.id }),
              status: { phase: "Active" },
            },
          ],
        };
      },
      async readNamespace({ name }: { name: string }) {
        assert.equal(name, namespaceName);
        return {
          ...driver["manifest"]("v1", "Namespace", namespaceName, { namespaceId: tenant.id }),
          status: { phase: "Active" },
        };
      },
      async listNamespacedPod({
        namespace,
        labelSelector,
      }: {
        namespace: string;
        labelSelector: string;
      }) {
        const role = labelSelector.includes("openclaw.dev/workload-role=agent")
          ? "agent"
          : "gateway";
        calls.push({ plane, call: "listNamespacedPod", namespace, role });
        const items = [pod(role)];
        if (state.foreignPod) {
          // A Pod in the namespace that belongs to another Agent must never be accepted.
          const foreign = pod(role);
          foreign.metadata.name = "foreign-pod";
          foreign.metadata.labels["openclaw.dev/agent"] = "another-agent";
          items.push(foreign);
        }
        if (state.foreignNamespacePod) {
          // Nor a Pod whose metadata names another namespace, even with this Agent's labels.
          const foreign = pod(role);
          foreign.metadata.name = "foreign-namespace-pod";
          foreign.metadata.namespace = "another-namespace";
          items.push(foreign);
        }
        return { apiVersion: "v1", kind: "PodList", items };
      },
      async listNamespacedEvent({ namespace, fieldSelector, limit, _continue }: EventQuery) {
        calls.push({
          plane,
          call: "listNamespacedEvent",
          namespace,
          fieldSelector,
          limit,
          _continue,
        });
        if (state.eventPage !== undefined) {
          return state.eventPage({ namespace, fieldSelector, limit, _continue });
        }
        if (state.eventError !== undefined) {
          throw state.eventError;
        }
        const uid = fieldSelector.replace("involvedObject.uid=", "");
        return {
          items: [
            ...state.extraEvents.map((event) => ({
              ...event,
              involvedObject: { kind: "Pod", uid, namespace },
            })),
            {
              type: "Warning",
              reason: "BackOff",
              message: "Back-off restarting failed container",
              count: 4,
              lastTimestamp: new Date("2026-09-30T11:01:00Z"),
              involvedObject: {
                kind: "Pod",
                uid,
                namespace,
                fieldPath: "spec.containers{gateway}",
              },
            },
            {
              type: "Normal",
              reason: "Pulled",
              message: "Container image already present on machine",
              count: 1,
              lastTimestamp: new Date("2026-09-30T11:00:30Z"),
              involvedObject: {
                kind: "Pod",
                uid,
                namespace,
                fieldPath: "spec.initContainers{prepare-private-state}",
              },
            },
            {
              type: "Normal",
              reason: "Scheduled",
              message: "Successfully assigned",
              lastTimestamp: new Date("2026-09-30T11:00:00Z"),
              involvedObject: { kind: "Pod", uid, namespace },
            },
            // A field selector the server ignored must not leak another object's Events.
            {
              type: "Warning",
              reason: "Foreign",
              message: "another Pod",
              involvedObject: { kind: "Pod", uid: "someone-else", namespace },
            },
          ],
        };
      },
      async readNamespacedPodLog(request: LogQuery) {
        calls.push({ plane, call: "readNamespacedPodLog", ...request });
        if (state.logError !== undefined) {
          throw state.logError;
        }
        const role = request.container;
        state.restartCount[role] += state.restartDuringRead ? 1 : 0;
        return state.logs[role];
      },
    },
  });
  // Install only the private clients used by the runtime diagnostics cases.
  const clientFields = driver as unknown as {
    apiClients: Promise<ReturnType<typeof clientsFor>>;
    executionApiClients: Promise<ReturnType<typeof clientsFor>>;
  };
  clientFields.apiClients = Promise.resolve(clientsFor("control"));
  if (twoCluster) {
    clientFields.executionApiClients = Promise.resolve(clientsFor("execution"));
  }
  const request = (role: Role, overrides: Partial<RuntimeLogRequest> = {}): RuntimeLogRequest => ({
    source: role,
    pod: `${role}-runtime-logs-pod`,
    podUid: `${role}-runtime-logs-uid`,
    container: role,
    previous: false,
    tailLines: 200,
    limitBytes: 1024 * 1024,
    signal: new AbortController().signal,
    ...overrides,
  });
  return {
    describeAgentRuntime: driver.describeAgentRuntime.bind(driver, binding),
    readAgentRuntimeLogs: driver.readAgentRuntimeLogs.bind(driver, binding),
    binding,
    calls,
    state,
    request,
    namespaceName,
    gatewayNamespaceName,
  };
}
