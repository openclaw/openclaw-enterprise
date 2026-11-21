import assert from "node:assert/strict";
import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  NODE_SETUP_POLL_MS,
  type GatewayNodeEnrollment,
  type NodeSetupObservation,
} from "../../apps/controller/src/gateway/node-enrollment-client.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import type {
  HarnessWorkloadRequirements,
  RevisionHarnessDescriptor,
  RuntimeFailureEvidence,
  SandboxDriver,
  SandboxHarnessContext,
  SandboxResourceRef,
} from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { supervisorPeerLabels } from "../fixtures/kubernetes-provider-readiness.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import { labelSelectorLabels, tenant } from "../helpers/kubernetes-routed-scenarios.mjs";
import {
  readyServiceEndpointSliceList,
  singleReplicaReadyDeploymentStatus,
} from "./kubernetes-gateway-readiness-fixture.ts";

const coreKinds = [
  "ConfigMap",
  "Secret",
  "Service",
  "ServiceAccount",
  "PersistentVolumeClaim",
] as const;

type OrdinaryNamespacedKind = (typeof coreKinds)[number] | "NetworkPolicy";

type FixtureObject = {
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    resourceVersion?: string;
    generation?: number;
    [field: string]: unknown;
  };
  spec?: unknown;
  status?: unknown;
  stringData?: Record<string, string>;
  data?: unknown;
  [field: string]: unknown;
};

type DeploymentCondition = {
  type: string;
  status: "True" | "False" | "Unknown";
  reason?: string;
  message?: string;
};
type DeploymentStatus = {
  observedGeneration?: number | undefined;
  replicas?: number;
  updatedReplicas?: number;
  readyReplicas?: number;
  conditions?: DeploymentCondition[];
};
type DeploymentObject = FixtureObject & {
  kind: "Deployment";
  spec: { template?: unknown };
  status?: DeploymentStatus | undefined;
};
type QuotaAmounts = Readonly<Record<string, string>>;
type QuotaObject = FixtureObject & {
  kind: "ResourceQuota";
  status?: { hard: QuotaAmounts; used: QuotaAmounts } | undefined;
};
type WorkspaceNodeBinding = FixtureObject & { data: { "workspace-node.json": string } };
type SetupPodPatch = { metadata: { annotations: Record<string, unknown> } };
type FixtureClock = { now: number };

type WorkloadRole = "agent" | "gateway";
type StatusBucket = "containerStatuses" | "initContainerStatuses";
type PodCondition = {
  type: string;
  status: "True" | "False" | "Unknown";
  reason?: string;
  message?: string;
};
type ContainerStatus = {
  name: string;
  ready?: boolean;
  restartCount?: number;
  state?: {
    waiting?: { reason?: string; message?: string };
    running?: { startedAt: string | Date };
  };
  lastState?: {
    terminated?: {
      exitCode: number;
      reason?: string;
      finishedAt?: string | Date;
      message?: string;
    };
  };
};
type PodStatus = Partial<Record<StatusBucket, ContainerStatus[]>> & {
  phase?: "Pending" | "Running";
  podIP?: string;
  conditions?: PodCondition[];
};
type FixturePod = {
  apiVersion: "v1";
  kind: "Pod";
  metadata: {
    name: string;
    namespace: string;
    uid?: string;
    labels: Readonly<Record<string, unknown>>;
    deletionTimestamp?: string;
  };
  status: PodStatus;
};
type FixtureState = {
  unreadableKind?: string | undefined;
  providerPod?: FixturePod;
  terminatingRole?: WorkloadRole | undefined;
  unschedulableRole?: WorkloadRole | undefined;
  waitingRole?: WorkloadRole | undefined;
  waitingStatuses?: StatusBucket;
  waitingReason?: string;
  podStatuses?: Partial<Record<WorkloadRole, PodStatus>> | undefined;
  pairAfterSetupMs?: number | undefined;
  pairAtMs?: number | undefined;
  gatewayAppliesBinding: boolean;
  gatewayWorkspaceNodeId?: unknown;
  gatewayWorkspaceNodeFailure?: unknown;
  gatewayRuntimeFailure?: RuntimeFailureEvidence | undefined;
};
type DedicatedDeployEnrollmentState = FixtureState & {
  setupCalls: number;
  connected: boolean;
  redeemedDeviceId: string | undefined;
  setupDelivery: NodeSetupObservation["delivery"];
  possessionAvailable: boolean | undefined;
  possessionDevices: string[];
  enrollmentAvailable: boolean;
  observeWaits: number[];
  failAtMs: number | undefined;
  stepObservations: boolean;
};
type FixtureSetupObservation = NodeSetupObservation & { connected: boolean };

type FixtureOptions = {
  namespace: string;
  gatewayName: string;
  state: FixtureState;
  revision: { id: string };
  sandboxDriver: unknown;
  clock: FixtureClock | undefined;
};

type NamespacedName = { name: string; namespace: string };
type SelectorRequest = { labelSelector?: string };
type WriteRequest = { body: FixtureObject };
type WriteObject = (
  request: WriteRequest,
  options?: { replace?: boolean },
) => Promise<FixtureObject>;

type NamespacedWrites<Kind extends string> = Partial<
  Record<`${"patch" | "create" | "replace"}Namespaced${Kind}`, WriteObject>
>;
type NamespacedClient<Kind extends string, Observed = FixtureObject> = NamespacedWrites<Kind> &
  Partial<Record<`readNamespaced${Kind}`, (request: NamespacedName) => Promise<Observed>>>;

type FixtureClients = {
  core: NamespacedClient<(typeof coreKinds)[number]> &
    NamespacedClient<"ResourceQuota", QuotaObject> & {
      listNamespace?: (request: SelectorRequest) => Promise<{ items: FixtureObject[] }>;
      readNamespace?: (request: { name: string }) => Promise<FixtureObject>;
      listNamespacedPod?: (request: {
        labelSelector: string;
        namespace: string;
      }) => Promise<{ items: FixturePod[] }>;
      patchNamespacedPod?: (request: {
        name: string;
        namespace?: string;
        body: unknown;
      }) => Promise<unknown>;
      connectGetNamespacedPodProxyWithPath?: (request: {
        name: string;
        path?: string;
      }) => Promise<unknown>;
    };
  apps: NamespacedClient<"Deployment", DeploymentObject>;
  networking: NamespacedClient<"NetworkPolicy">;
  objects: {
    read?: (object: FixtureObject) => Promise<FixtureObject>;
    patch?: (object: FixtureObject) => Promise<FixtureObject>;
  };
  discovery: {
    listNamespacedEndpointSlice?: () => Promise<unknown>;
  };
};

function verifyDeploymentReadback(object: FixtureObject): asserts object is DeploymentObject {
  assert.equal(object.kind, "Deployment");
  assert.ok(asRecord(object.spec), "expected Deployment spec");
  if (object.status === undefined) {
    return;
  }
  const status = asRecord(object.status);
  assert.ok(status, "expected Deployment status");
  for (const key of [
    "observedGeneration",
    "replicas",
    "updatedReplicas",
    "readyReplicas",
  ] as const) {
    const value: unknown = status[key];
    assert.ok(value === undefined || typeof value === "number", `invalid Deployment status ${key}`);
  }
  const conditions = status.conditions;
  if (conditions !== undefined) {
    assert.ok(Array.isArray(conditions), "expected Deployment conditions");
    for (const value of conditions as unknown[]) {
      const condition = asRecord(value);
      assert.ok(
        condition && typeof condition.type === "string",
        "expected Deployment condition type",
      );
      assert.ok(
        condition.status === "True" ||
          condition.status === "False" ||
          condition.status === "Unknown",
        "expected Deployment condition status",
      );
      assert.ok(condition.reason === undefined || typeof condition.reason === "string");
      assert.ok(condition.message === undefined || typeof condition.message === "string");
    }
  }
}

function verifyQuotaReadback(object: FixtureObject): asserts object is QuotaObject {
  assert.equal(object.kind, "ResourceQuota");
  if (object.status === undefined) {
    return;
  }
  const status = asRecord(object.status);
  const amounts = (value: unknown): value is QuotaAmounts => {
    const record = asRecord(value);
    return (
      record !== undefined && Object.values(record).every((count) => typeof count === "string")
    );
  };
  assert.ok(
    status && amounts(status.hard) && amounts(status.used),
    "expected ResourceQuota counts",
  );
}

const nativeHarnessName = "native-harness";

export function nativeSandboxIdentity(): Pick<
  SandboxDriver,
  "id" | "implementation" | "capability" | "supportsHarnessExecutionMode" | "facets"
> {
  return {
    id: "native-sandbox",
    implementation: "openshell",
    capability: "sandbox",
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    facets: ["networking", "filesystem", "process"],
  };
}

export function nativeSandboxRevision(sandboxDriverId: SandboxDriver["id"], loggingLevel?: "info") {
  const configuration = createHarnessConfiguration("openclaw", "gpt-5");
  return {
    harness: {
      id: "openclaw",
      version: "1.0.0",
      mode: "dedicated",
    } satisfies RevisionHarnessDescriptor,
    sandboxDriverId,
    configuration:
      loggingLevel === undefined
        ? configuration
        : admitLoggingConfiguration(configuration, loggingLevel),
    plugins: undefined,
  };
}

export function nativeHarnessResource(
  context: Pick<SandboxHarnessContext, "namespace" | "revision">,
): SandboxResourceRef {
  return {
    namespaceName: context.namespace.name,
    resourceName: nativeHarnessName,
    agentId: context.revision.agentId,
    revisionId: context.revision.id,
  };
}

export function recordingNativeSandbox(provisions: SandboxHarnessContext[]) {
  return {
    ...nativeSandboxIdentity(),
    async workspaceNodePeerLabels({ revision }) {
      return provisions.some((context) => context.revision.id === revision.id)
        ? supervisorPeerLabels(revision.id)
        : undefined;
    },
    async provisionHarness(context) {
      provisions.push(context);
      return nativeHarnessResource(context);
    },
    async harnessEndpoint() {
      return assert.fail("native OpenClaw has no inbound Harness endpoint");
    },
  } satisfies Pick<
    SandboxDriver,
    "workspaceNodePeerLabels" | "provisionHarness" | "harnessEndpoint"
  >;
}

export function readyNativeHarnessPod(
  namespace: string,
  labels: HarnessWorkloadRequirements["labels"],
): FixturePod {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: nativeHarnessName, namespace, labels },
    status: { conditions: [{ type: "Ready", status: "True" }] },
  };
}

export function createDedicatedDeployEnrollmentFixture(clock?: FixtureClock) {
  const state: DedicatedDeployEnrollmentState = {
    setupCalls: 0,
    connected: false,
    // A retained setup receipt can name a device that is currently disconnected.
    redeemedDeviceId: undefined,
    setupDelivery: "confirmed",
    // Registry presence does not imply a completed token-authenticated connection.
    possessionAvailable: undefined,
    possessionDevices: [],
    enrollmentAvailable: true,
    // The node OpenClaw reports applied through the wrapper's runtime status,
    // or the reason it has not.
    gatewayWorkspaceNodeId: undefined,
    gatewayWorkspaceNodeFailure: undefined,
    gatewayAppliesBinding: true,
    // With a fake clock: when set, the node host pairs this long after its setup
    // reaches the Harness.
    pairAfterSetupMs: undefined,
    // The wait each setup observation was given.
    observeWaits: [],
    // With a fake clock: when the node pairs, and when a waiting observation fails.
    pairAtMs: undefined,
    failAtMs: undefined,
    // With a fake clock: observe poll by poll, asking `stopWaiting` between reads.
    stepObservations: false,
  };

  function connectedObservation(): FixtureSetupObservation | undefined {
    return state.connected
      ? { deviceId: "node-1", connected: true, delivery: "confirmed" }
      : undefined;
  }

  const nodeEnrollment: GatewayNodeEnrollment = {
    async createSetup() {
      state.setupCalls++;
      return { setupId: "setup-1", setupCode: "setup-code", expiresAtMs: Date.now() + 60000 };
    },
    async observeSetup(
      _url,
      _setupId,
      signal,
      options,
    ): Promise<FixtureSetupObservation | undefined> {
      if (!state.enrollmentAvailable) {
        throw new Error("Gateway is restarting after the Harness replacement");
      }
      // Like the client: one connection, re-read until connected or the wait ends.
      state.observeWaits.push(options?.waitMs ?? 0);
      if (state.redeemedDeviceId !== undefined) {
        return {
          deviceId: state.redeemedDeviceId,
          connected: state.connected,
          delivery: state.setupDelivery,
        };
      }
      if (clock !== undefined && state.stepObservations) {
        // Like the client, poll by poll: read, then ask whether other Work
        // is waiting for the worker before the next read.
        const deadline = clock.now + (options?.waitMs ?? 0);
        for (;;) {
          if (state.pairAtMs !== undefined && state.pairAtMs <= clock.now) {
            state.connected = true;
          }
          if (
            state.connected ||
            clock.now + NODE_SETUP_POLL_MS > deadline ||
            (options?.stopWaiting !== undefined && (await options.stopWaiting()))
          ) {
            return connectedObservation();
          }
          clock.now += NODE_SETUP_POLL_MS;
        }
      }
      if (clock !== undefined) {
        const deadline = clock.now + (options?.waitMs ?? 0);
        if (state.failAtMs !== undefined && state.failAtMs <= deadline) {
          clock.now = Math.max(clock.now, state.failAtMs);
          throw new Error("Gateway connection closed");
        }
        if (!state.connected && state.pairAtMs !== undefined && state.pairAtMs <= deadline) {
          clock.now = Math.max(clock.now, state.pairAtMs);
          state.connected = true;
        } else if (!state.connected) {
          clock.now = deadline;
        }
        return connectedObservation();
      }
      const deadline = Date.now() + (options?.waitMs ?? 0);
      while (!state.connected && Date.now() < deadline) {
        if (options?.stopWaiting !== undefined && (await options.stopWaiting())) {
          break;
        }
        signal.throwIfAborted();
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
      }
      return connectedObservation();
    },
    async isConnected(_url, deviceId) {
      state.possessionDevices.push(deviceId);
      return state.possessionAvailable ?? state.connected;
    },
  };
  return { state, nodeEnrollment };
}

export function createDedicatedDeployKubernetesFixture(
  { namespace, gatewayName, state, revision, sandboxDriver, clock }: FixtureOptions,
  seed: (save: (object: FixtureObject) => void) => void,
) {
  const objects = new Map<string, FixtureObject>();
  const templates: Array<{ name: string; template: unknown }> = [];
  const key = (kind: string, name: string, target = namespace) =>
    `${kind}:${kind === "Namespace" ? "" : target}:${name}`;
  const save = (object: FixtureObject) =>
    objects.set(
      key(object.kind, object.metadata.name, object.metadata.namespace),
      structuredClone(object),
    );
  const read = (kind: string, name: string, target = namespace) => {
    const value = objects.get(key(kind, name, target));
    if (!value) {
      throw Object.assign(new Error("not found"), { statusCode: 404 });
    }
    return structuredClone(value);
  };

  seed(save);

  // Only transport observations are supplied. Startup order and readiness use
  // the real driver; successful writes do not make a Deployment ready.
  const clients: FixtureClients = {
    core: {},
    apps: {},
    networking: {},
    objects: {},
    discovery: {},
  };
  const readResource =
    (kind: OrdinaryNamespacedKind | "Deployment" | "ResourceQuota") =>
    async ({ name, namespace: target }: NamespacedName) => {
      if (state.unreadableKind === kind) {
        throw Object.assign(new Error("forbidden"), { statusCode: 403 });
      }
      return read(kind, name, target);
    };
  const readDeployment = readResource("Deployment");
  clients.apps.readNamespacedDeployment = async (request) => {
    const deployment = await readDeployment(request);
    verifyDeploymentReadback(deployment);
    return deployment;
  };
  const readQuota = readResource("ResourceQuota");
  clients.core.readNamespacedResourceQuota = async (request) => {
    const quota = await readQuota(request);
    verifyQuotaReadback(quota);
    return quota;
  };

  function setupWrites<Kind extends string>(api: NamespacedWrites<Kind>, kind: Kind) {
    const write: WriteObject = async ({ body }, { replace = false } = {}) => {
      const previous = objects.get(key(kind, body.metadata.name, body.metadata.namespace));
      // Like the API server: every write bumps resourceVersion, and a replace that names a
      // stale one is a 409 Conflict (finding 1678). Two writes with the metadata of one read,
      // as workspaceNodeReady once did (#2750 review), fail here as they do live.
      const current = previous?.metadata.resourceVersion;
      const named = body.metadata.resourceVersion;
      if (replace && previous !== undefined && named !== undefined && named !== current) {
        throw Object.assign(
          new Error(
            `Operation cannot be fulfilled on ${kind} ${body.metadata.name}: the object has been modified`,
          ),
          { statusCode: 409 },
        );
      }
      const changed =
        kind === "Deployment" && JSON.stringify(previous?.spec) !== JSON.stringify(body.spec);
      const value: FixtureObject = {
        ...previous,
        ...structuredClone(body),
        metadata: {
          ...previous?.metadata,
          ...body.metadata,
          uid: `${body.metadata.name}-uid`,
          resourceVersion: String(Number(current ?? "0") + 1),
        },
      };
      if (kind === "Deployment") {
        const spec = asRecord(body.spec);
        assert.ok(spec, "expected Deployment spec");
        const template = JSON.stringify(spec.template);
        if (template !== JSON.stringify(asRecord(previous?.spec)?.template)) {
          // Each new pod template is a workload start: both use Recreate.
          templates.push({
            name: body.metadata.name,
            template: structuredClone(spec.template),
          });
        }
        value.metadata.generation = (previous?.metadata.generation ?? 0) + Number(changed);
        if (changed) {
          delete value.status;
        }
      }
      if (body.stringData) {
        value.data = Object.fromEntries(
          Object.entries(body.stringData).map(([name, value]) => [
            name,
            Buffer.from(value).toString("base64"),
          ]),
        );
      }
      save(value);
      return value;
    };
    api[`patchNamespaced${kind}`] = write;
    api[`createNamespaced${kind}`] = write;
    api[`replaceNamespaced${kind}`] = (request: WriteRequest) => write(request, { replace: true });
  }
  for (const kind of coreKinds) {
    clients.core[`readNamespaced${kind}`] = readResource(kind);
    setupWrites(clients.core, kind);
  }
  setupWrites(clients.core, "ResourceQuota");
  setupWrites(clients.apps, "Deployment");
  setupWrites(clients.networking, "NetworkPolicy");
  clients.networking.readNamespacedNetworkPolicy = readResource("NetworkPolicy");
  clients.core.listNamespace = async ({ labelSelector }) => ({
    items:
      namespace !== kubernetesNamespaceName(tenant.id) &&
      labelSelector === `openclaw.dev/namespace=${tenant.id}`
        ? [read("Namespace", namespace)]
        : [],
  });
  clients.core.readNamespace = async ({ name }) => read("Namespace", name);
  clients.objects.read = async (object) =>
    read(object.kind, object.metadata.name, object.metadata.namespace);
  clients.objects.patch = async (object) => {
    save(object);
    return object;
  };
  clients.discovery.listNamespacedEndpointSlice = async () =>
    readyServiceEndpointSliceList(gatewayName);
  clients.core.listNamespacedPod = async ({ labelSelector, namespace: requestedNamespace }) => {
    const rawLabels: unknown = labelSelectorLabels(labelSelector);
    const labels = asRecord(rawLabels);
    const role = labels?.["openclaw.dev/workload-role"];
    assert.ok(labels && (role === "agent" || role === "gateway"), "expected a workload selector");
    if (role === "agent" && sandboxDriver !== undefined) {
      return { items: state.providerPod === undefined ? [] : [structuredClone(state.providerPod)] };
    }

    const status: PodStatus = { phase: "Running", podIP: "10.42.0.12" };
    if (state.unschedulableRole === role) {
      status.phase = "Pending";
      delete status.podIP;
      status.conditions = [
        {
          type: "PodScheduled",
          status: "False",
          reason: "Unschedulable",
          message: "0/1 nodes are available: 1 Insufficient memory.",
        },
      ];
    } else if (state.waitingRole === role) {
      status.phase = "Pending";
      delete status.podIP;
      status.conditions = [{ type: "PodScheduled", status: "True" }];
      status[state.waitingStatuses ?? "containerStatuses"] = [
        {
          name: role,
          state: {
            waiting: {
              ...(state.waitingReason === undefined ? {} : { reason: state.waitingReason }),
              message: "Back-off pulling image registry.invalid/runtime:missing",
            },
          },
        },
      ];
    }
    return {
      items: [
        {
          apiVersion: "v1",
          kind: "Pod",
          metadata: {
            name: `${role}-pod`,
            namespace: requestedNamespace,
            uid: `${role}-uid`,
            labels,
            // A Pod being deleted, as during a rollout or a scale-down.
            ...(state.terminatingRole === role
              ? { deletionTimestamp: "2026-08-25T00:00:00Z" }
              : {}),
          },
          status: { ...status, ...state.podStatuses?.[role] },
        },
      ],
    };
  };
  // Annotation patches on running Pods: the kubelet syncs a Pod on this update
  // event, which refreshes its optional setup Secret volume at once.
  const podPatches: Array<{ name: string; namespace: string | undefined; body: unknown }> = [];
  clients.core.patchNamespacedPod = async ({ name, namespace: target, body }) => {
    podPatches.push({ name, namespace: target, body: structuredClone(body) });
    if (
      name === "agent-pod" &&
      state.pairAfterSetupMs !== undefined &&
      (body as SetupPodPatch).metadata.annotations["openclaw.dev/workspace-node-setup"] !==
        undefined
    ) {
      // The setup file reaches the running Harness; its node host boots and pairs.
      assert.notEqual(clock, undefined, "pairAfterSetupMs needs the fake clock");
      state.pairAtMs = (clock as FixtureClock).now + state.pairAfterSetupMs;
    }
    const binding = objects.get(key("ConfigMap", `${gatewayName}-workspace-node`, namespace));
    if (name === "gateway-pod" && binding !== undefined && state.gatewayAppliesBinding) {
      // The kubelet refreshes the volume and the wrapper hot-applies the node.
      const { revisionId, deviceId } = JSON.parse(
        (binding as WorkspaceNodeBinding).data["workspace-node.json"],
      ) as { revisionId?: unknown; deviceId?: unknown };
      if (revisionId === revision.id) {
        state.gatewayWorkspaceNodeId = deviceId;
      }
    }
    return body;
  };
  clients.core.connectGetNamespacedPodProxyWithPath = async ({ name, path }) => {
    const role = name.startsWith("agent-") ? "agent" : "gateway";
    if (path === "openclaw/runtime/status") {
      return {
        revisionId: revision.id,
        container: role,
        podUid: `${role}-uid`,
        ...(role === "gateway" && state.gatewayWorkspaceNodeId !== undefined
          ? { workspaceNodeId: state.gatewayWorkspaceNodeId }
          : {}),
        ...(role === "gateway" && state.gatewayWorkspaceNodeFailure !== undefined
          ? { workspaceNodeFailure: state.gatewayWorkspaceNodeFailure }
          : {}),
        ...(role === "gateway" && state.gatewayRuntimeFailure !== undefined
          ? { runtimeFailure: state.gatewayRuntimeFailure }
          : {}),
      };
    }
    return {
      revisionId: revision.id,
      container: role,
      podUid: `${role}-uid`,
      startupId: `${role}-startup`,
      phase: "ready",
      successfulPluginIds: ["codex-plugin:example"],
      failures: [],
    };
  };

  const markReady = (name: string) => {
    const object = read("Deployment", name);
    object.status = singleReplicaReadyDeploymentStatus(object.metadata.generation);
    save(object);
  };

  return { objects, templates, key, save, read, clients, podPatches, markReady };
}
