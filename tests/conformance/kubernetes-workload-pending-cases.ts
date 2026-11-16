import assert from "node:assert/strict";
import { inspect } from "node:util";
import { withComputeAbortSignal } from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { RUNTIME_STATUS_PATH } from "../../apps/controller/src/drivers/compute/kubernetes/private-status-proxy.ts";
import {
  type AgentRevision,
  type ComputePendingReason,
  type ComputeReadiness,
  type SandboxDriver,
} from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import {
  nativeHarnessResource,
  nativeSandboxIdentity,
  type createDedicatedDeployKubernetesFixture,
} from "./kubernetes-dedicated-deploy-fixture.ts";

type Transport = ReturnType<typeof createDedicatedDeployKubernetesFixture>;
type Pod = Awaited<
  ReturnType<NonNullable<Transport["clients"]["core"]["listNamespacedPod"]>>
>["items"][number];
type PodStatus = Pod["status"];
type ContainerStatus = NonNullable<PodStatus["containerStatuses"]>[number];
type DeploymentRead = NonNullable<Transport["clients"]["apps"]["readNamespacedDeployment"]>;
type QuotaRead = NonNullable<Transport["clients"]["core"]["readNamespacedResourceQuota"]>;
type WorkloadRole = NonNullable<TransportState["terminatingRole"]>;
type TransportState = Parameters<typeof createDedicatedDeployKubernetesFixture>[0]["state"];
type PodStatuses = NonNullable<TransportState["podStatuses"]>;
type RevisionOverrides = {
  harness: Pick<AgentRevision["harness"], "id" | "mode" | "version">;
  configuration: AgentRevision["configuration"];
  plugins: undefined;
  sandboxDriverId?: AgentRevision["sandboxDriverId"];
};
type SandboxProvisioner = Pick<
  SandboxDriver,
  | "id"
  | "implementation"
  | "capability"
  | "facets"
  | "supportsHarnessExecutionMode"
  | "workspaceNodePeerLabels"
  | "provisionHarness"
>;
type CreateFixture = (options: {
  clock: { now: number };
  revision?: RevisionOverrides;
  sandboxDriver?: SandboxProvisioner;
  splitCluster?: true;
}) => Transport & {
  state: TransportState & { connected: boolean };
  namespace: string;
  gatewayNamespace: string;
  gatewayName: string;
  gateway: Transport;
  agentName: string;
  prepare: () => Promise<ComputeReadiness>;
  markWorkloadsReady: () => void;
};

function openClawRevision(mode: AgentRevision["harness"]["mode"]): RevisionOverrides {
  return {
    harness: { id: "openclaw", version: "1.0.0", mode },
    configuration: createHarnessConfiguration("openclaw", "gpt-5"),
    plugins: undefined,
  };
}

// A deploy whose Pods cannot be placed says so instead of a generic wait (D224),
// and one whose workloads are ready says it waits only for its node (D222).
export async function checkPendingScheduling(createFixture: CreateFixture) {
  const clock = { now: 0 };
  const { state, prepare, markWorkloadsReady } = createFixture({
    clock,
  });
  state.unschedulableRole = "agent";
  const unschedulable = await prepare();
  assert.equal(unschedulable.ready, false);
  assert.equal(unschedulable.pendingReason, "WORKLOAD_UNSCHEDULABLE");
  state.unschedulableRole = undefined;
  const starting = await prepare();
  assert.equal(starting.ready, false);
  assert.equal(starting.pendingReason, undefined);
  markWorkloadsReady();
  const unpaired = await prepare();
  assert.equal(unpaired.ready, false);
  assert.equal(unpaired.pendingReason, "WORKSPACE_NODE_PENDING");
  state.connected = true;
  const ready = await prepare();
  assert.equal(ready.ready, true);
  assert.equal(ready.pendingReason, undefined);
}

// A deploy whose container image the kubelet cannot pull names that wait instead of a
// bare one (finding 1762); a Pod the scheduler cannot place still leads, and a Pod being
// deleted names no wait (finding 1880).
export async function checkImagePullFailure(createFixture: CreateFixture) {
  const { state, prepare } = createFixture({ clock: { now: 0 } });
  for (const [role, statuses, reason, expected] of [
    ["agent", "containerStatuses", "ImagePullBackOff", "WORKLOAD_IMAGE_PULL_FAILED"],
    ["gateway", "containerStatuses", "ErrImagePull", "WORKLOAD_IMAGE_PULL_FAILED"],
    ["agent", "initContainerStatuses", "ImagePullBackOff", "WORKLOAD_IMAGE_PULL_FAILED"],
    ["agent", "containerStatuses", "ContainerCreating", undefined],
    ["agent", "containerStatuses", "CrashLoopBackOff", undefined],
  ] as const satisfies readonly (readonly [
    WorkloadRole,
    NonNullable<TransportState["waitingStatuses"]>,
    string,
    ComputePendingReason | undefined,
  ])[]) {
    state.waitingRole = role;
    state.waitingStatuses = statuses;
    state.waitingReason = reason;
    const pending = await prepare();
    assert.equal(pending.ready, false);
    assert.equal(pending.pendingReason, expected, `${role} ${statuses} ${reason}`);
  }
  state.waitingRole = "agent";
  state.waitingStatuses = "containerStatuses";
  state.waitingReason = "ImagePullBackOff";
  state.unschedulableRole = "gateway";
  assert.equal((await prepare()).pendingReason, "WORKLOAD_UNSCHEDULABLE");
  // A Pod being deleted names no wait (finding 1880): with the unschedulable Gateway Pod
  // being deleted, the Harness's image pull leads.
  state.terminatingRole = "gateway";
  assert.equal((await prepare()).pendingReason, "WORKLOAD_IMAGE_PULL_FAILED");
  state.waitingRole = undefined;
  state.unschedulableRole = undefined;
  for (const [role, wait] of [
    [
      "agent",
      {
        waitingRole: "agent",
        waitingStatuses: "containerStatuses",
        waitingReason: "ImagePullBackOff",
      },
    ],
    ["gateway", { unschedulableRole: "gateway" }],
  ] as const satisfies readonly (readonly [WorkloadRole, Partial<TransportState>])[]) {
    Object.assign(state, { terminatingRole: role, ...wait });
    assert.equal((await prepare()).pendingReason, undefined, `terminating ${role}`);
    state.waitingRole = undefined;
    state.unschedulableRole = undefined;
  }
  state.terminatingRole = undefined;
  assert.equal((await prepare()).pendingReason, undefined);
}

// A Gateway or Harness container that exits at every start fails startup once the kubelet
// backs off after its third consecutive unexplained exit, instead of waiting for the
// convergence deadline (finding 3041). Only the role's own container on a live Pod of the
// revision counts. The Gateway wrapper states the count in its termination message, and its
// deliberate restart (exit 75, or its message) never counts; without a count the restart
// count plus one stands in, as the kubelet counts a restart only once it starts it.
export async function checkCrashLoopFailure(createFixture: CreateFixture, embedded: boolean) {
  const { state, clients, prepare } = createFixture({
    clock: { now: 0 },
    ...(embedded ? { revision: openClawRevision("embedded") } : {}),
  });
  const finishedAt = "2026-11-10T00:00:00Z";
  const container = (
    name: string,
    {
      exitCode = 1,
      restartCount = 3,
      waiting = "CrashLoopBackOff",
      message,
    }: {
      exitCode?: number;
      restartCount?: number;
      waiting?: string | null;
      message?: string;
    } = {},
  ): ContainerStatus => ({
    name,
    ready: false,
    restartCount,
    state:
      waiting === null
        ? { running: { startedAt: finishedAt } }
        : { waiting: { reason: waiting, message: "back-off 40s restarting failed container" } },
    lastState: {
      terminated: { exitCode, reason: "Error", finishedAt, ...(message ? { message } : {}) },
    },
  });
  const runtimePodStatus = (
    name: string,
    options?: Parameters<typeof container>[1],
  ): PodStatus => ({
    containerStatuses: [container(name, options)],
  });
  const exits = (count: number) => `consecutive unexplained exits: ${count}`;
  const runtimeFailureWith = async (statuses: PodStatuses) => {
    state.podStatuses = statuses;
    try {
      const pass = await prepare();
      assert.equal(pass.ready, false);
      return pass;
    } finally {
      state.podStatuses = undefined;
    }
  };
  const roles: WorkloadRole[] = embedded ? ["gateway"] : ["gateway", "agent"];
  for (const role of roles) {
    // An unexplained exit, or an out-of-memory kill, at every start. The Gateway's third
    // consecutive one fails it even after earlier deliberate restarts; a Harness never
    // restarts on purpose, so an exit 75 counts too.
    for (const options of [
      { exitCode: 1 },
      { exitCode: 137 },
      // Three exits: in backoff the kubelet has restarted the container twice.
      { restartCount: 2 },
      ...(role === "gateway"
        ? [{ restartCount: 5, message: exits(3) }]
        : [{ exitCode: 75 }, { message: exits(1) }]),
    ]) {
      const failed = await runtimeFailureWith({
        [role]: runtimePodStatus(role, options),
      });
      assert.deepEqual(failed.runtimeFailure, {
        component: role,
        check: "crash-loop",
        code: "UNAVAILABLE",
        checkedAt: finishedAt,
      });
      assert.equal(Object.hasOwn(failed, "pendingReason"), false, JSON.stringify(options));
    }
    for (const [scenario, statuses] of [
      ...(role === "gateway"
        ? ([
            // The wrapper stops its container on purpose, as for a changed Harness peer.
            ["deliberate restarts", runtimePodStatus(role, { exitCode: 75 })],
            // A deliberate restart killed while it stops exits with another status.
            [
              "a killed deliberate restart",
              runtimePodStatus(role, {
                exitCode: 137,
                restartCount: 5,
                message: "deliberate restart: harness-peer-changed",
              }),
            ],
            // Two deliberate restarts, then two unexplained exits.
            [
              "two consecutive unexplained exits",
              runtimePodStatus(role, { restartCount: 4, message: exits(2) }),
            ],
          ] satisfies [string, PodStatus][])
        : []),
      ["two exits", runtimePodStatus(role, { restartCount: 1 })],
      ["a running restart", runtimePodStatus(role, { waiting: null })],
      ["a pull back-off", runtimePodStatus(role, { waiting: "ImagePullBackOff" })],
      [
        "an init container or sidecar",
        {
          initContainerStatuses: [container(role), container("prepare-private-state")],
          containerStatuses: [container("workspace-node"), container(role, { waiting: null })],
        },
      ],
    ] satisfies [string, PodStatus][]) {
      const pass = await runtimeFailureWith({ [role]: statuses });
      assert.equal(pass.runtimeFailure, undefined, `${role}: ${scenario}`);
    }
    // A Pod being deleted, as an old revision's during a rollout, never counts.
    state.terminatingRole = role;
    const terminating = await runtimeFailureWith({
      [role]: runtimePodStatus(role),
    });
    state.terminatingRole = undefined;
    assert.equal(terminating.runtimeFailure, undefined, `${role}: terminating`);
  }
  // A crash-looping container serves no runtime status: a refused status read still
  // reports the crash loop.
  const connect = clients.core.connectGetNamespacedPodProxyWithPath;
  assert.ok(connect);
  const refused: string[] = [];
  clients.core.connectGetNamespacedPodProxyWithPath = async ({ name, path }) => {
    if (path === RUNTIME_STATUS_PATH.slice(1)) {
      refused.push(name.split(":")[0] ?? name);
    }
    throw Object.assign(new Error("container is not running"), { statusCode: 400 });
  };
  const unread = await runtimeFailureWith({
    gateway: runtimePodStatus("gateway"),
  });
  clients.core.connectGetNamespacedPodProxyWithPath = connect;
  assert.ok(refused.includes(embedded ? "gateway-pod" : "agent-pod"));
  assert.equal(unread.runtimeFailure?.component, "gateway");
  assert.equal(unread.runtimeFailure?.check, "crash-loop");
}

type DeploymentObject = Awaited<ReturnType<DeploymentRead>>;
type DeploymentCondition = NonNullable<
  NonNullable<DeploymentObject["status"]>["conditions"]
>[number];
type QuotaObject = Awaited<ReturnType<QuotaRead>>;
type QuotaAmounts = NonNullable<QuotaObject["status"]>["used"];
type DeployTarget = Pick<Transport, "save" | "read">;
const quotaName = "openclaw-quota";
const quotaExceeded = "NAMESPACE_POD_QUOTA_EXCEEDED";

function setConditions(target: DeployTarget, name: string, conditions: DeploymentCondition[]) {
  const object = target.read("Deployment", name);
  target.save({ ...object, status: { ...asRecord(object.status), conditions } });
}

// The quota's status as the quota controller last recorded it.
function setQuota(
  target: Pick<Transport, "save">,
  namespace: string,
  used: QuotaAmounts,
  hard: QuotaAmounts = used,
  name = quotaName,
) {
  const quota: QuotaObject = {
    apiVersion: "v1",
    kind: "ResourceQuota",
    metadata: { name, namespace },
    status: { hard, used },
  };
  target.save(quota);
}

function refusal(
  workload: string,
  requested = "pods=1",
  used = "pods=10",
  limited = "pods=10",
  name = quotaName,
) {
  return `pods "${workload}-5d8f7c9b4-x2k9q" is forbidden: exceeded quota: ${name}, requested: ${requested}, used: ${used}, limited: ${limited}`;
}

function replicaFailure(
  message?: string,
  overrides?: Partial<DeploymentCondition>,
): DeploymentCondition {
  return {
    type: "ReplicaFailure",
    status: "True",
    reason: "FailedCreate",
    ...(message === undefined ? {} : { message }),
    ...overrides,
  };
}

function refusedPod(workload: string, name = quotaName) {
  return [replicaFailure(refusal(workload, "pods=1", "pods=10", "pods=10", name))];
}

function trackQuotaReads({ core }: Transport["clients"]) {
  const read = core.readNamespacedResourceQuota;
  assert.ok(read);
  const requests: Parameters<QuotaRead>[0][] = [];
  core.readNamespacedResourceQuota = (request) => {
    requests.push(request);
    return read(request);
  };
  return {
    requests,
    restore: () => {
      core.readNamespacedResourceQuota = read;
    },
  };
}

// A scheduler refusal or image-pull wait can only be considered once the current
// ReplicaFailure conditions have been checked against the named quotas.
export async function checkFullNamespacePodQuota(createFixture: CreateFixture) {
  const fixture = createFixture({ clock: { now: 0 } });
  const {
    state,
    namespace,
    gatewayName,
    agentName,
    objects,
    clients,
    prepare,
    markWorkloadsReady,
  } = fixture;
  assert.equal((await prepare()).pendingReason, undefined);
  const pendingReasonWith = async (name: string, conditions: DeploymentCondition[]) => {
    setConditions(fixture, name, conditions);
    try {
      const observed = await prepare();
      assert.equal(observed.ready, false);
      return observed.pendingReason;
    } finally {
      setConditions(fixture, name, []);
    }
  };
  const namespaceQuota = (used: QuotaAmounts, hard = used, name = quotaName) =>
    setQuota(fixture, namespace, used, hard, name);

  namespaceQuota({ pods: "10", "count/pods": "10", "requests.cpu": "4" });
  for (const name of [agentName, gatewayName]) {
    assert.equal(await pendingReasonWith(name, refusedPod(name)), quotaExceeded, name);
  }
  assert.equal(
    await pendingReasonWith(agentName, [
      { type: "Available", status: "False", reason: "MinimumReplicasUnavailable" },
      replicaFailure(
        refusal(
          agentName,
          "pods=1,requests.cpu=500m",
          "pods=10,requests.cpu=4",
          "pods=10,requests.cpu=4",
        ),
      ),
    ]),
    quotaExceeded,
  );
  assert.equal(
    await pendingReasonWith(agentName, [
      replicaFailure(refusal(agentName, "count/pods=1", "count/pods=10", "count/pods=10")),
    ]),
    quotaExceeded,
  );
  // Only a FailedCreate refusal for want of Pods can explain a full Pod quota.
  for (const conditions of [
    [
      replicaFailure(
        refusal(agentName, "requests.cpu=500m", "pods=4,requests.cpu=4", "pods=10,requests.cpu=4"),
      ),
    ],
    [replicaFailure(refusal(agentName), { status: "False" })],
    [replicaFailure(refusal(agentName), { reason: "FailedDelete" })],
    [replicaFailure(refusal(agentName), { type: "Progressing" })],
    [
      replicaFailure(
        `pods "${agentName}-5d8f7c9b4-x2k9q" is forbidden: error looking up service account`,
      ),
    ],
    [replicaFailure()],
  ]) {
    assert.equal(await pendingReasonWith(agentName, conditions), undefined, inspect(conditions));
  }
  // A Deployment can retain its first refusal even after a quota has capacity.
  const podRefusal = refusedPod(agentName);
  for (const [label, used, hard] of [
    ["a Pod freed", { pods: "9" }, { pods: "10" }],
    ["the limit raised", { pods: "10" }, { pods: "11" }],
    ["only CPU used up", { pods: "4", "requests.cpu": "4" }, { pods: "10", "requests.cpu": "4" }],
    ["no Pod limit left", { pods: "4", "requests.cpu": "4" }, { "requests.cpu": "4" }],
    ["an unparsable count", { pods: "ten" }, { pods: "10" }],
  ] as const satisfies readonly (readonly [string, QuotaAmounts, QuotaAmounts])[]) {
    namespaceQuota(used, hard);
    assert.equal(await pendingReasonWith(agentName, podRefusal), undefined, label);
  }
  namespaceQuota({ "count/pods": "10" });
  assert.equal(await pendingReasonWith(agentName, podRefusal), quotaExceeded);
  namespaceQuota({ pods: "11" }, { pods: "1e1" });
  assert.equal(await pendingReasonWith(agentName, podRefusal), quotaExceeded);

  // Both Deployments' stale refusals name the same quota. The API sees one read.
  const deduplicated = trackQuotaReads(clients);
  namespaceQuota({ pods: "9" }, { pods: "10" });
  setConditions(fixture, gatewayName, refusedPod(gatewayName));
  assert.equal(await pendingReasonWith(agentName, podRefusal), undefined);
  assert.deepEqual(deduplicated.requests, [{ name: quotaName, namespace }]);
  setConditions(fixture, gatewayName, []);
  deduplicated.restore();

  // A quota can belong to an administrator. Read the exact name in the refusal.
  namespaceQuota({ pods: "3" }, { pods: "10" });
  namespaceQuota({ pods: "2" }, { pods: "2" }, "team-pods");
  const admin = trackQuotaReads(clients);
  const adminRefusal = [
    replicaFailure(refusal(agentName, "pods=1", "pods=2", "pods=2", "team-pods")),
  ];
  assert.equal(await pendingReasonWith(agentName, adminRefusal), quotaExceeded);
  assert.deepEqual(admin.requests, [{ name: "team-pods", namespace }]);
  admin.restore();
  assert.equal(await pendingReasonWith(agentName, podRefusal), undefined);
  objects.delete(fixture.key("ResourceQuota", "team-pods"));
  assert.equal(await pendingReasonWith(agentName, adminRefusal), undefined);

  namespaceQuota({ pods: "10" });
  state.waitingRole = "gateway";
  state.waitingStatuses = "containerStatuses";
  state.waitingReason = "ImagePullBackOff";
  assert.equal(await pendingReasonWith(agentName, podRefusal), quotaExceeded);
  assert.equal((await prepare()).pendingReason, "WORKLOAD_IMAGE_PULL_FAILED");
  state.waitingRole = undefined;
  state.unreadableKind = "ResourceQuota";
  assert.equal(await pendingReasonWith(agentName, podRefusal), undefined);
  state.unreadableKind = undefined;
  assert.equal(await pendingReasonWith(agentName, podRefusal), quotaExceeded);

  // A forbidden read of the Harness's quota still permits observing the Gateway's quota.
  const readQuota = clients.core.readNamespacedResourceQuota;
  assert.ok(readQuota);
  const quotaReads: Parameters<QuotaRead>[0][] = [];
  clients.core.readNamespacedResourceQuota = async (request) => {
    quotaReads.push(request);
    if (request.name === "broken-quota") {
      throw forbiddenRead();
    }
    return readQuota(request);
  };
  setConditions(fixture, gatewayName, refusedPod(gatewayName));
  assert.equal(
    await pendingReasonWith(agentName, refusedPod(agentName, "broken-quota")),
    quotaExceeded,
  );
  assert.deepEqual(quotaReads, [
    { name: "broken-quota", namespace },
    { name: quotaName, namespace },
  ]);
  setConditions(fixture, gatewayName, []);
  clients.core.readNamespacedResourceQuota = readQuota;

  // A held runtime failure supersedes the quota refusal.
  const held = {
    component: "gateway",
    check: "peer-bridge-record",
    checkedAt: "2026-09-19T11:59:00.000Z",
    code: "UNAVAILABLE",
  };
  state.gatewayRuntimeFailure = held;
  setConditions(fixture, agentName, podRefusal);
  const failed = await prepare();
  assert.equal(failed.pendingReason, undefined);
  assert.deepEqual(failed.runtimeFailure, held);
  setConditions(fixture, agentName, []);
  state.gatewayRuntimeFailure = undefined;

  state.unschedulableRole = "gateway";
  assert.equal(await pendingReasonWith(agentName, podRefusal), quotaExceeded);
  assert.equal((await prepare()).pendingReason, "WORKLOAD_UNSCHEDULABLE");
  state.unschedulableRole = undefined;

  await checkDeploymentObservationRefusals(fixture);
  await checkQuotaCancellation(fixture);
  await checkSplitClusterQuotas(createFixture);

  // Ready workloads waiting for pairing report that reason even with a stale refusal.
  markWorkloadsReady();
  setConditions(fixture, agentName, podRefusal);
  assert.equal((await prepare()).pendingReason, "WORKSPACE_NODE_PENDING");
  setConditions(fixture, agentName, []);
  state.connected = true;
  const ready = await prepare();
  assert.equal(ready.ready, true);
  assert.equal(ready.pendingReason, undefined);
}

function forbiddenRead() {
  return Object.assign(new Error("forbidden"), { statusCode: 403 });
}

type WorkloadRead =
  | { kind: "deployment"; request: Parameters<DeploymentRead>[0] }
  | { kind: "quota"; request: Parameters<QuotaRead>[0] };

function observeWorkloadReads(
  { apps, core }: Transport["clients"],
  observations: WorkloadRead[],
  {
    deployment,
    quota,
  }: {
    deployment?: (
      request: Parameters<DeploymentRead>[0],
      read: DeploymentRead,
    ) => ReturnType<DeploymentRead>;
    quota?: (request: Parameters<QuotaRead>[0], read: QuotaRead) => ReturnType<QuotaRead>;
  } = {},
) {
  const readDeployment = apps.readNamespacedDeployment;
  const readQuota = core.readNamespacedResourceQuota;
  assert.ok(readDeployment && readQuota);
  apps.readNamespacedDeployment = (request) => {
    observations.push({ kind: "deployment", request });
    return deployment === undefined ? readDeployment(request) : deployment(request, readDeployment);
  };
  core.readNamespacedResourceQuota = (request) => {
    observations.push({ kind: "quota", request });
    return quota === undefined ? readQuota(request) : quota(request, readQuota);
  };
  return () => {
    apps.readNamespacedDeployment = readDeployment;
    core.readNamespacedResourceQuota = readQuota;
  };
}

// Refusals start after preparation has checked the Deployment for reconciliation
// and readiness. A runtime-status read marks the handoff to the diagnostics.
function afterRuntimeReadback({ core }: Transport["clients"]) {
  const proxy = core.connectGetNamespacedPodProxyWithPath;
  assert.ok(proxy);
  let observed = false;
  core.connectGetNamespacedPodProxyWithPath = (request) => {
    if (request.path === RUNTIME_STATUS_PATH.slice(1)) {
      observed = true;
    }
    return proxy(request);
  };
  return {
    reached: () => observed,
    reset: () => {
      observed = false;
    },
    restore: () => {
      core.connectGetNamespacedPodProxyWithPath = proxy;
    },
  };
}

async function checkDeploymentObservationRefusals(fixture: ReturnType<CreateFixture>) {
  const { namespace, agentName, gatewayName, prepare, clients } = fixture;
  const status = afterRuntimeReadback(clients);
  const observations: WorkloadRead[] = [];
  const agent = { name: agentName, namespace };
  const gateway = { name: gatewayName, namespace };
  const gatewayQuota = { name: quotaName, namespace };
  const foreignQuota = "foreign-pods";
  setQuota(fixture, namespace, { pods: "10" }, undefined, foreignQuota);
  setConditions(fixture, agentName, refusedPod(agentName, foreignQuota));

  // A read can fail, or a Deployment can change owners after reconciliation.
  // Only the Gateway's own refusal is usable in either case.
  for (const failure of ["forbidden", "foreign"] as const) {
    let refused = false;
    const restore = observeWorkloadReads(clients, observations, {
      async deployment(request, read) {
        if (!status.reached() || request.name !== agentName) {
          return read(request);
        }
        refused = true;
        if (failure === "forbidden") {
          throw forbiddenRead();
        }
        const object = await read(request);
        return {
          ...object,
          metadata: {
            ...object.metadata,
            labels: {
              ...asRecord(object.metadata.labels),
              "openclaw.dev/revision": "other-revision",
            },
          },
        };
      },
    });
    setConditions(fixture, gatewayName, refusedPod(gatewayName));
    const pending = await prepare();
    assert.equal(refused, true, failure);
    assert.equal(pending.pendingReason, quotaExceeded, failure);
    assert.deepEqual(observations.slice(-3), [
      { kind: "deployment", request: agent },
      { kind: "deployment", request: gateway },
      { kind: "quota", request: gatewayQuota },
    ]);
    assert.deepEqual(
      observations.filter(({ kind }) => kind === "quota"),
      [{ kind: "quota", request: gatewayQuota }],
    );

    observations.length = 0;
    status.reset();
    refused = false;
    setConditions(fixture, gatewayName, []);
    assert.equal((await prepare()).pendingReason, undefined, failure);
    assert.equal(refused, true, failure);
    assert.deepEqual(observations.slice(-2), [
      { kind: "deployment", request: agent },
      { kind: "deployment", request: gateway },
    ]);
    assert.ok(observations.every(({ kind }) => kind !== "quota"));
    observations.length = 0;
    status.reset();
    restore();
  }
  status.restore();
  setConditions(fixture, agentName, []);
}

async function checkQuotaCancellation(fixture: ReturnType<CreateFixture>) {
  const { namespace, agentName, gatewayName, prepare, clients } = fixture;
  const status = afterRuntimeReadback(clients);
  const agent = { kind: "deployment", request: { name: agentName, namespace } };
  const gateway = { kind: "deployment", request: { name: gatewayName, namespace } };
  const quota = { kind: "quota", request: { name: quotaName, namespace } };
  setConditions(fixture, gatewayName, refusedPod(gatewayName));
  for (const location of ["deployment", "quota"] as const) {
    const owner = new AbortController();
    const cancellation = new Error("revision pass cancelled");
    const abort = () => {
      owner.abort(cancellation);
      throw forbiddenRead();
    };
    const observations: WorkloadRead[] = [];
    const restore = observeWorkloadReads(clients, observations, {
      async deployment(request, read) {
        if (location === "deployment" && status.reached() && request.name === agentName) {
          abort();
        }
        return read(request);
      },
      async quota(request, read) {
        if (location === "quota") {
          abort();
        }
        return read(request);
      },
    });
    await assert.rejects(
      withComputeAbortSignal(owner.signal, prepare),
      (error) => error === cancellation,
    );
    assert.equal(status.reached(), true);
    assert.deepEqual(
      observations.slice(location === "deployment" ? -1 : -3),
      location === "deployment" ? [agent] : [agent, gateway, quota],
    );
    assert.deepEqual(
      observations.filter(({ kind }) => kind === "quota"),
      location === "deployment" ? [] : [quota],
    );
    status.reset();
    restore();
  }
  status.restore();
  setConditions(fixture, gatewayName, []);
}

async function checkSplitClusterQuotas(createFixture: CreateFixture) {
  const fixture = createFixture({ clock: { now: 0 }, splitCluster: true });
  const { namespace, gatewayNamespace, agentName, gatewayName, gateway, prepare, clients } =
    fixture;
  const initial = await prepare();
  assert.equal(initial.ready, false);
  assert.equal(initial.pendingReason, undefined);
  assert.notEqual(namespace, gatewayNamespace);

  setQuota(fixture, namespace, { pods: "9" }, { pods: "10" });
  setQuota(gateway, gatewayNamespace, { pods: "10" });
  setConditions(fixture, agentName, refusedPod(agentName));
  setConditions(gateway, gatewayName, refusedPod(gatewayName));
  const control = trackQuotaReads(gateway.clients);
  const execution = trackQuotaReads(clients);
  const pending = await prepare();
  assert.equal(pending.ready, false);
  assert.equal(pending.pendingReason, quotaExceeded);
  assert.deepEqual(execution.requests, [{ name: quotaName, namespace }]);
  assert.deepEqual(control.requests, [{ name: quotaName, namespace: gatewayNamespace }]);
  setQuota(gateway, gatewayNamespace, { pods: "9" }, { pods: "10" });
  assert.equal((await prepare()).pendingReason, undefined);
  control.restore();
  execution.restore();
}

export async function checkQuotaWorkloadTopology(createFixture: CreateFixture) {
  const sandboxDriver = {
    ...nativeSandboxIdentity(),
    async workspaceNodePeerLabels() {
      return undefined;
    },
    async provisionHarness(context) {
      return nativeHarnessResource(context);
    },
  } satisfies SandboxProvisioner;

  for (const [label, options, roles] of [
    ["dedicated Codex", {}, ["agent", "gateway"]],
    ["Embedded OpenClaw", { revision: openClawRevision("embedded") }, ["gateway"]],
    [
      "SandboxDriver-provisioned OpenClaw",
      {
        sandboxDriver,
        revision: { ...openClawRevision("dedicated"), sandboxDriverId: sandboxDriver.id },
      },
      ["gateway"],
    ],
  ] as const satisfies readonly (readonly [
    string,
    Partial<Parameters<CreateFixture>[0]>,
    readonly WorkloadRole[],
  ])[]) {
    const fixture = createFixture({ ...options, clock: { now: 0 } });
    const { namespace, gatewayName, agentName, prepare, clients } = fixture;
    assert.equal((await prepare()).ready, false, label);

    // Separate quotas make each Deployment's diagnosis visible. The Harness
    // quota has capacity, so it cannot end the observation before the Gateway read.
    const names: Record<WorkloadRole, string> = { agent: agentName, gateway: gatewayName };
    for (const role of roles) {
      const name = names[role];
      setConditions(fixture, name, refusedPod(name, `${role}-pods`));
      setQuota(
        fixture,
        namespace,
        { pods: role === "agent" ? "9" : "10" },
        { pods: "10" },
        `${role}-pods`,
      );
    }

    const observations: WorkloadRead[] = [];
    const restore = observeWorkloadReads(clients, observations);
    const pending = await prepare();
    assert.equal(pending.ready, false, label);
    assert.equal(pending.pendingReason, quotaExceeded, label);
    const expected = roles.flatMap((role): WorkloadRead[] => [
      { kind: "deployment", request: { name: names[role], namespace } },
      { kind: "quota", request: { name: `${role}-pods`, namespace } },
    ]);
    assert.deepEqual(observations.slice(-expected.length), expected, label);
    if (!roles.some((role: WorkloadRole) => role === "agent")) {
      assert.ok(
        observations.every(({ request }) => request.name !== agentName),
        label,
      );
    }
    restore();
  }
}
