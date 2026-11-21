import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { TestContext } from "node:test";
import { inspect } from "node:util";
import {
  createKubernetesComputeDriver,
  KubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  currentComputeAbortSignal,
  withComputeAbortSignal,
} from "../../apps/controller/src/drivers/compute/operation-context.ts";
import type {
  Agent,
  AgentRevision,
  ComputeRevisionContext,
  Namespace,
  SandboxDriver,
} from "../../packages/contracts/src/index.ts";
import {
  DependencyUnavailableError,
  KubernetesSecretWriteForbiddenError,
  RuntimeDiagnosticsTransportError,
  TransientDependencyError,
} from "../../packages/occ/src/index.ts";
import type { createKubernetesClientConfiguration } from "../../apps/controller/src/drivers/kubernetes/client.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import {
  labelSelectorLabels,
  options,
  routedOptions,
  routedRevision,
  tenant,
} from "../helpers/kubernetes-routed-scenarios.mjs";
import { workspaceSetupFixture } from "../helpers/kubernetes-workspace-setup.ts";

type KubernetesSdk = Awaited<ReturnType<typeof createKubernetesClientConfiguration>>["sdk"];
type CoreV1Api = InstanceType<KubernetesSdk["CoreV1Api"]>;
type PodRole = "agent" | "gateway";
type PodStatus = {
  phase?: string;
  podIP?: string;
  containerStatuses: { name: PodRole; containerID: string }[];
};
type PrivateRuntimePodFields = {
  name: string;
  namespace: string;
  uid: string;
  deletionTimestamp?: string;
  status: PodStatus;
};
type PodProxyRequest = Parameters<CoreV1Api["connectGetNamespacedPodProxyWithPath"]>[0];
type DiagnosticCore = Pick<CoreV1Api, "listNamespace" | "readNamespace"> & {
  listNamespacedPod(
    request: Parameters<CoreV1Api["listNamespacedPod"]>[0],
  ): Promise<ReturnType<typeof privateRuntimePodList>>;
  connectGetNamespacedPodProxyWithPath(request: PodProxyRequest): Promise<unknown>;
};

function privateRuntimeReadbackDriver() {
  return createKubernetesComputeDriver(
    options({
      runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
    }),
  );
}

function privateRuntimePod(
  revision: AgentRevision,
  role: PodRole,
  { status, ...metadata }: PrivateRuntimePodFields,
) {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      ...metadata,
      labels: {
        "openclaw.dev/agent": revision.agentId,
        "openclaw.dev/revision": revision.id,
        "openclaw.dev/workload-role": role,
      },
    },
    status,
  };
}

function privateRuntimePodList(items: ReturnType<typeof privateRuntimePod>[]) {
  return { apiVersion: "v1", kind: "PodList", items };
}

export async function checkPrivateRuntimeDiagnostics(context: TestContext) {
  const driver = privateRuntimeReadbackDriver();
  const namespaceName = kubernetesNamespaceName(tenant.id);
  const gatewayNamespaceName = kubernetesNamespaceName(tenant.id);
  const agent: Agent = {
    id: "agent-runtime-diagnostics",
    namespaceId: tenant.id,
    name: "Runtime diagnostics Agent",
    configurationId: "cfg_runtime_diagnostics",
    backendId: null,
    harnessAuth: null,
    gatewayManagedMode: true,
    desiredRuntimeState: "running",
    status: "active",
    executionMode: "dedicated",
    servicePrincipalId: "service-principal-runtime-diagnostics",
    createdAt: tenant.createdAt,
  };
  const revision = routedRevision(driver, {
    id: "revision-runtime-diagnostics",
    agentId: agent.id,
    configurationId: agent.configurationId,
    servicePrincipalId: agent.servicePrincipalId,
  });
  const pod = (role: PodRole) =>
    privateRuntimePod(revision, role, {
      name: `${role}-runtime-diagnostics-pod`,
      namespace: role === "gateway" ? gatewayNamespaceName : namespaceName,
      uid: `${role}-runtime-diagnostics-uid`,
      status: {
        phase: "Running",
        podIP: "10.42.0.10",
        containerStatuses: [{ name: role, containerID: `${role}-container-1` }],
      },
    });
  const pods = { agent: pod("agent"), gateway: pod("gateway") };
  const proxyReads: PodProxyRequest[] = [];
  const podListReads: PodRole[] = [];
  // A healthy runtime reports no held startup failure on its status path.
  type RuntimeStatusReport = {
    revisionId: string;
    container: PodRole;
    podUid: string;
    runtimeFailure?: {
      component: string;
      check: string;
      checkedAt: string;
      code: string;
      cause?: unknown;
    };
  };
  const healthyStatus = (role: PodRole): RuntimeStatusReport => ({
    revisionId: revision.id,
    container: role,
    podUid: pods[role].metadata.uid,
  });
  let runtimeStatus: (role: PodRole) => RuntimeStatusReport | Promise<never> = healthyStatus;
  let diagnosticsServing = true;
  let gatewayTransportFailure = false;
  let privateProxyRead: ((role: PodRole, path: string) => Promise<unknown>) | undefined;
  let namespaceDiscoveryDeadline: AbortController | undefined;
  const discovery: { signal?: AbortSignal } = {};
  // Unrun channel checks the Gateway adds to its one socket check (a status report may carry at
  // most 32 checks).
  let extraGatewayChecks = 0;
  const core: DiagnosticCore = {
    async listNamespace(request) {
      assert.equal(request?.labelSelector, `openclaw.dev/namespace=${tenant.id}`);
      if (namespaceDiscoveryDeadline !== undefined) {
        const discoverySignal = currentComputeAbortSignal();
        assert.ok(discoverySignal);
        discovery.signal = discoverySignal;
        namespaceDiscoveryDeadline.abort(
          new DOMException("private discovery detail", "TimeoutError"),
        );
        discoverySignal.throwIfAborted();
      }
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
    async readNamespace({ name }) {
      assert.equal(name, namespaceName);
      return {
        ...driver["manifest"]("v1", "Namespace", namespaceName, { namespaceId: tenant.id }),
        status: { phase: "Active" },
      };
    },
    async listNamespacedPod({ namespace, labelSelector }) {
      const role = labelSelector?.includes("openclaw.dev/workload-role=agent")
        ? "agent"
        : "gateway";
      assert.equal(namespace, role === "gateway" ? gatewayNamespaceName : namespaceName);
      assert.deepEqual(labelSelectorLabels(labelSelector), {
        "openclaw.dev/agent": revision.agentId,
        "openclaw.dev/revision": revision.id,
        "openclaw.dev/workload-role": role,
      });
      podListReads.push(role);
      return privateRuntimePodList([structuredClone(pods[role])]);
    },
    async connectGetNamespacedPodProxyWithPath({ name, namespace, path }) {
      proxyReads.push({ name, namespace, path });
      const role = name.startsWith("agent-") ? "agent" : "gateway";
      assert.equal(namespace, role === "gateway" ? gatewayNamespaceName : namespaceName);
      assert.equal(name, `${pods[role].metadata.name}:18791`);
      if (privateProxyRead !== undefined) {
        return privateProxyRead(role, path);
      }
      if (path === "openclaw/runtime/status") {
        return runtimeStatus(role);
      }
      assert.equal(path, "openclaw/runtime/diagnostics");
      if (role === "gateway" && gatewayTransportFailure) {
        throw Object.assign(new Error("private upstream response detail"), { statusCode: 403 });
      }
      if (!diagnosticsServing) {
        throw Object.assign(new Error("status port not serving"), { code: 503, headers: {} });
      }
      return {
        revisionId: revision.id,
        container: role,
        podUid: pods[role].metadata.uid,
        observedAt: "2026-09-19T12:00:00.000Z",
        checks: [
          {
            component: role,
            check: role === "agent" ? "auth" : "socket",
            state: role === "agent" ? "succeeded" : "unknown",
            checkedAt: role === "agent" ? "2026-09-19T12:00:00.000Z" : null,
          },
          ...Array.from({ length: role === "gateway" ? extraGatewayChecks : 0 }, (_, index) => ({
            component: "gateway",
            check: `channel-${index}`,
            state: "unknown",
            checkedAt: null,
          })),
        ],
      };
    },
  };
  Object.assign(driver, { apiClients: Promise.resolve({ core }) });

  const namespace: Namespace = { ...tenant, status: "ready" };
  const binding = { namespace, agent, revision };
  const diagnostics = await driver.diagnoseAgentDeployment(binding);

  assert.equal(diagnostics.revisionId, revision.id);
  assert.deepEqual(
    diagnostics.checks.map(({ component, check, state }) => ({ component, check, state })),
    [
      { component: "agent", check: "auth", state: "succeeded" },
      { component: "gateway", check: "socket", state: "unknown" },
    ],
  );
  assert.equal(diagnostics.checks.find((check) => check.component === "gateway")?.checkedAt, null);
  const reads = (path: string) =>
    proxyReads
      .filter((read) => read.path === path)
      .sort((left, right) => left.name.localeCompare(right.name));
  for (const path of ["openclaw/runtime/diagnostics", "openclaw/runtime/status"]) {
    assert.deepEqual(reads(path), [
      { name: "agent-runtime-diagnostics-pod:18791", namespace: namespaceName, path },
      { name: "gateway-runtime-diagnostics-pod:18791", namespace: gatewayNamespaceName, path },
    ]);
  }
  // Each private read lists the Pod before and after the proxy call.
  assert.equal(podListReads.filter((role) => role === "agent").length, 4);
  assert.equal(podListReads.filter((role) => role === "gateway").length, 4);

  // A Gateway holding a startup failure still answers diagnostics, with channel
  // checks it could not run. The failure it holds on the status path leads the
  // observation (ahead of the 32-check cap) as a failed check named after the
  // startup step.
  const heldFailure = {
    component: "gateway",
    check: "peer-bridge-record",
    checkedAt: "2026-09-19T11:59:00.000Z",
    code: "UNAVAILABLE",
  };
  const gatewayHeld = (role: PodRole): RuntimeStatusReport => ({
    revisionId: revision.id,
    container: role,
    podUid: pods[role].metadata.uid,
    ...(role === "gateway" ? { runtimeFailure: heldFailure } : {}),
  });
  runtimeStatus = gatewayHeld;
  assert.deepEqual(
    (await driver.diagnoseAgentDeployment(binding)).checks.map(
      ({ component, check, state, code }) => ({ component, check, state, code }),
    ),
    [
      { component: "gateway", check: "peer-bridge-record", state: "failed", code: "UNAVAILABLE" },
      { component: "agent", check: "auth", state: "succeeded", code: undefined },
      { component: "gateway", check: "socket", state: "unknown", code: undefined },
    ],
  );
  // When the diagnostics endpoint does not answer, the held failure still says why.
  diagnosticsServing = false;
  const notServing = (component: PodRole) => ({
    component,
    check: "runtime-status",
    state: "unknown",
    checkedAt: null,
    code: "UNAVAILABLE",
  });
  assert.deepEqual((await driver.diagnoseAgentDeployment(binding)).checks, [
    { ...heldFailure, state: "failed" },
    notServing("agent"),
    notServing("gateway"),
  ]);
  diagnosticsServing = true;

  // An Agent holding a failed model check reports it as well, without its cause and at
  // millisecond precision. Held failures lead, and the 32-check cap drops diagnostics checks.
  runtimeStatus = (role) =>
    role === "gateway"
      ? gatewayHeld(role)
      : {
          ...gatewayHeld(role),
          runtimeFailure: {
            component: "agent",
            check: "model-probe",
            checkedAt: "2026-09-19T11:58:00Z",
            code: "MODEL_PROBE_FAILED",
            cause: { kind: "PROBE_STATUS", detail: "format" },
          },
        };
  extraGatewayChecks = 31;
  const capped = (await driver.diagnoseAgentDeployment(binding)).checks;
  assert.equal(capped.length, 32);
  assert.deepEqual(capped.slice(0, 3), [
    {
      component: "agent",
      check: "model-probe",
      state: "failed",
      checkedAt: "2026-09-19T11:58:00.000Z",
      code: "MODEL_PROBE_FAILED",
    },
    { ...heldFailure, state: "failed" },
    {
      component: "agent",
      check: "auth",
      state: "succeeded",
      checkedAt: "2026-09-19T12:00:00.000Z",
    },
  ]);
  assert.equal(capped.at(-1)?.check, "channel-27");
  extraGatewayChecks = 0;
  runtimeStatus = gatewayHeld;

  // A rejected Gateway diagnostics read names only the transport stage. It does not
  // report a channel failure or retain the upstream error text or cause.
  gatewayTransportFailure = true;
  await assert.rejects(driver.diagnoseAgentDeployment(binding), (error) => {
    assert.ok(error instanceof RuntimeDiagnosticsTransportError);
    assert.equal(error.message, "The private Gateway diagnostics transport is unavailable.");
    assert.equal(error.cause, undefined);
    return true;
  });
  gatewayTransportFailure = false;

  // All four private reads expire at the shared deadline. The Agent reads and
  // supplementary Gateway read reject first; the Gateway diagnostics failure
  // still determines the safe transport category.
  let collectionDeadline = new AbortController();
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  const timeout = context.mock.method(AbortSignal, "timeout", realTimeout);
  // Only the collection owns this signal. Each Kubernetes request keeps its own deadline.
  timeout.mock.mockImplementationOnce(() => collectionDeadline.signal);
  const pendingProxyReads = new Map<string, (reason: unknown) => void>();
  const gatewayDiagnostics = "gateway:openclaw/runtime/diagnostics";
  privateProxyRead = (role, path) =>
    new Promise((_resolve, reject) => {
      pendingProxyReads.set(`${role}:${path}`, reject);
      if (pendingProxyReads.size === 4) {
        collectionDeadline.abort(new DOMException("private timeout detail", "TimeoutError"));
        for (const [key, rejectRead] of pendingProxyReads) {
          if (key !== gatewayDiagnostics) {
            rejectRead(collectionDeadline.signal.reason);
          }
        }
        const rejectGateway = pendingProxyReads.get(gatewayDiagnostics);
        assert.ok(rejectGateway);
        setImmediate(() => rejectGateway(collectionDeadline.signal.reason));
      }
    });
  try {
    await assert.rejects(driver.diagnoseAgentDeployment(binding), RuntimeDiagnosticsTransportError);

    // The same shared deadline during Namespace discovery has no Gateway proxy to classify.
    privateProxyRead = undefined;
    collectionDeadline = new AbortController();
    namespaceDiscoveryDeadline = collectionDeadline;
    timeout.mock.mockImplementationOnce(() => collectionDeadline.signal);
    const previousProxyReads = proxyReads.length;
    await assert.rejects(driver.diagnoseAgentDeployment(binding), {
      name: "DependencyUnavailableError",
      message: "Runtime diagnostics timed out.",
    });
    const { signal: discoverySignal } = discovery;
    assert.ok(discoverySignal?.aborted);
    assert.equal(discoverySignal.reason, collectionDeadline.signal.reason);
    assert.equal(proxyReads.length, previousProxyReads);
  } finally {
    timeout.mock.restore();
    privateProxyRead = undefined;
    namespaceDiscoveryDeadline = undefined;
  }

  // A status read that is refused or returns another Pod's report adds nothing;
  // the diagnostics read alone decides the observation.
  const failingStatuses: ((role: PodRole) => RuntimeStatusReport)[] = [
    () => {
      throw Object.assign(new Error("pods/proxy denied"), { code: 403, headers: {} });
    },
    (role) => ({ ...gatewayHeld(role), podUid: "replaced-pod-uid" }),
    (role) => ({ ...gatewayHeld(role), runtimeFailure: { ...heldFailure, code: "not a code" } }),
    // Date.parse accepts this impossible date and normalizes it to March 2. The
    // private runtime boundary must not turn it into different failure evidence.
    (role) => ({
      ...gatewayHeld(role),
      runtimeFailure: { ...heldFailure, checkedAt: "2026-02-30T11:59:00.000Z" },
    }),
    // Parseable, but outside the timestamps OCC accepts.
    (role) => ({
      ...gatewayHeld(role),
      runtimeFailure: { ...heldFailure, checkedAt: "+010000-01-01T00:00:00.000Z" },
    }),
  ];
  for (const failingStatus of failingStatuses) {
    runtimeStatus = failingStatus;
    assert.deepEqual(
      (await driver.diagnoseAgentDeployment(binding)).checks.map(({ check }) => check),
      ["auth", "socket"],
    );
  }

  // Tolerating a failed status read never swallows the caller's cancellation.
  const owner = new AbortController();
  const cancelled = new Error("diagnostics caller went away");
  runtimeStatus = async () => {
    // Let the in-memory diagnostics reads finish before cancelling the pending status read.
    await new Promise((resolve) => setImmediate(resolve));
    owner.abort(cancelled);
    throw Object.assign(new Error("pods/proxy denied"), { code: 403, headers: {} });
  };
  await assert.rejects(
    withComputeAbortSignal(owner.signal, () => driver.diagnoseAgentDeployment(binding)),
    (error) => error === cancelled,
  );
}

export async function checkRuntimeDiagnosticTimestampsAndPodRace() {
  const driver = privateRuntimeReadbackDriver();
  const namespaceName = kubernetesNamespaceName(tenant.id);
  const revision = routedRevision(driver, {
    id: "revision-runtime-readback-race",
    agentId: "agent-runtime-readback-race",
    configurationId: "cfg_runtime_readback_race",
    servicePrincipalId: "service-principal-runtime-readback-race",
  });
  const pod = privateRuntimePod(revision, "agent", {
    name: "agent-runtime-readback-race-pod",
    namespace: namespaceName,
    uid: "agent-runtime-readback-race-uid",
    status: {
      phase: "Running",
      podIP: "10.42.0.11",
      containerStatuses: [{ name: "agent", containerID: "agent-container-1" }],
    },
  });
  let podLists = 0;
  let racing = false;
  const core: Pick<DiagnosticCore, "listNamespacedPod" | "connectGetNamespacedPodProxyWithPath"> = {
    async listNamespacedPod() {
      podLists += 1;
      if (!racing || podLists === 1) {
        return privateRuntimePodList([structuredClone(pod)]);
      }
      return privateRuntimePodList([
        structuredClone(pod),
        {
          ...structuredClone(pod),
          metadata: {
            ...pod.metadata,
            name: "agent-runtime-readback-race-pod-2",
            uid: "agent-runtime-readback-race-uid-2",
          },
        },
      ]);
    },
    async connectGetNamespacedPodProxyWithPath() {
      return {
        revisionId: revision.id,
        container: "agent",
        podUid: pod.metadata.uid,
        observedAt: "2026-09-19T12:00:00.000Z",
        checks: [
          {
            component: "agent",
            check: "auth",
            ...(racing
              ? { state: "unknown", checkedAt: "2026-09-19T12:00:00.000Z" }
              : { state: "failed" }),
          },
        ],
      };
    },
  };
  Object.assign(driver, { apiClients: Promise.resolve({ core }) });

  const namespace = { name: namespaceName, plane: "execution" } as const;
  await assert.rejects(
    driver["runtimeDiagnosticChecks"](revision, namespace, "agent"),
    /invalid diagnostic data/,
  );
  assert.equal(podLists, 2, "the malformed answer reaches validation after a stable Pod readback");

  racing = true;
  podLists = 0;
  assert.equal(
    await driver["privateStatusReadback"](
      revision,
      { name: namespaceName, plane: "execution" },
      "agent",
      "/openclaw/runtime/status",
    ),
    undefined,
  );
  // The proxy answered; the re-list after it saw the second Pod.
  assert.equal(podLists, 2);

  // A status port that is not serving yet (503) is an answer, read once and not retried.
  podLists = 0;
  let proxied = 0;
  const waits: number[] = [];
  const waitBeforeRetry = async (ms: number) => {
    waits.push(ms);
  };
  Object.assign(driver, { waitBeforeRetry });
  core.connectGetNamespacedPodProxyWithPath = async () => {
    proxied += 1;
    throw Object.assign(new Error("status port not serving"), { code: 503, headers: {} });
  };
  assert.equal(
    await driver["privateStatusReadback"](
      revision,
      { name: namespaceName, plane: "execution" },
      "agent",
      "/openclaw/runtime/status",
    ),
    undefined,
  );
  assert.equal(proxied, 1);
  assert.deepEqual(waits, []);
}

// f1103: a deleted Gateway Pod's replacement is Pending with no IP while the
// Deployment still counts the old one ready. The apiserver refuses to proxy to
// it (400 "address not allowed"), so the readback must not try.
export async function checkRuntimeStatusReplacementPod() {
  const driver = privateRuntimeReadbackDriver();
  const namespace = { name: kubernetesNamespaceName(tenant.id), plane: "execution" } as const;
  const revision = routedRevision(driver, {
    id: "revision-runtime-readback-replacement",
    agentId: "agent-runtime-readback-replacement",
    configurationId: "cfg_runtime_readback_replacement",
    servicePrincipalId: "service-principal-runtime-readback-replacement",
  });
  const pod = (
    name: string,
    status: Omit<PodStatus, "containerStatuses">,
    deletionTimestamp?: string,
  ) =>
    privateRuntimePod(revision, "agent", {
      name,
      namespace: namespace.name,
      uid: `${name}-uid`,
      ...(deletionTimestamp === undefined ? {} : { deletionTimestamp }),
      status: { ...status, containerStatuses: [{ name: "agent", containerID: `${name}-c` }] },
    });
  const terminating = pod(
    "agent-terminating",
    { phase: "Running", podIP: "10.42.0.40" },
    "2026-10-11T10:18:57Z",
  );
  let items: ReturnType<typeof privateRuntimePod>[] = [];
  const proxied: string[] = [];
  const core: Pick<DiagnosticCore, "listNamespacedPod" | "connectGetNamespacedPodProxyWithPath"> = {
    async listNamespacedPod() {
      return privateRuntimePodList(structuredClone(items));
    },
    async connectGetNamespacedPodProxyWithPath({ name }) {
      proxied.push(name);
      const target = items.find((candidate) => `${candidate.metadata.name}:18791` === name);
      if (!target?.status?.podIP) {
        throw Object.assign(new Error("address not allowed"), { code: 400, headers: {} });
      }
      return { revisionId: revision.id, container: "agent", podUid: target.metadata.uid };
    },
  };
  Object.assign(driver, { apiClients: Promise.resolve({ core }) });
  const read = () =>
    driver["privateStatusReadback"](revision, namespace, "agent", "/openclaw/runtime/status");

  for (const status of [
    { phase: "Pending" },
    { phase: "Pending", podIP: "10.42.0.41" },
    { phase: "Running" },
    { phase: "Running", podIP: "" },
    { phase: "Succeeded", podIP: "10.42.0.41" },
    {},
  ]) {
    items = [terminating, pod("agent-replacement", status)];
    assert.equal(await read(), undefined, JSON.stringify(status));
  }
  assert.deepEqual(proxied, []);

  // Once the replacement runs with an IP, the readback reaches exactly that Pod.
  items = [terminating, pod("agent-replacement", { phase: "Running", podIP: "10.42.0.41" })];
  assert.deepEqual(await read(), {
    status: {
      revisionId: revision.id,
      container: "agent",
      podUid: "agent-replacement-uid",
    },
    podUid: "agent-replacement-uid",
    containerId: "agent-replacement-c",
  });
  assert.deepEqual(proxied, ["agent-replacement:18791"]);
}

export function checkDiagnosticsIngressWithoutPlugins() {
  const cidr = "10.42.0.0/16";
  const tenantNamespace = kubernetesNamespaceName(tenant.id);
  for (const mode of ["embedded", "dedicated"]) {
    const driver = createKubernetesComputeDriver(
      options({
        network: { ...options().network, pluginStatusProxySourceCidrs: [cidr] },
        runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
      }),
    );
    const revision = routedRevision(driver, {
      harness: { id: mode === "embedded" ? "openclaw" : "codex", version: "1.0.0", mode },
      plugins: { plugins: {} },
    });
    const policies = driver["pluginStatusNetworkPolicies"](revision, {
      name: tenantNamespace,
      plane: "execution",
    });
    assert.equal(policies.length, 1);
    const [target] = policies;
    assert.ok(target);
    const policy = target.resource;
    assert.equal(policy.metadata.namespace, tenantNamespace);
    assert.ok(policy.metadata.name?.startsWith("allow-plugin-status-proxy-"));
    const ingress = asRecord(policy.spec)?.ingress;
    assert.ok(Array.isArray(ingress));
    const from = asRecord(ingress[0])?.from;
    assert.ok(Array.isArray(from));
    assert.ok(from.some((peer: unknown) => asRecord(asRecord(peer)?.ipBlock)?.cidr === cidr));
  }
}

export async function checkCachedRuntimeFailureObservation() {
  const revision = routedRevision(createKubernetesComputeDriver(options()), {
    id: "revision-runtime-failure-evidence",
    agentId: "agent-runtime-failure-evidence",
    configurationId: "cfg_runtime_failure_evidence",
    servicePrincipalId: "service-principal-runtime-failure-evidence",
  });
  const namespace = kubernetesNamespaceName(tenant.id);
  const nonNative = createKubernetesComputeDriver(options());
  let attemptedProxy = false;
  Object.assign(nonNative, {
    apiClients: Promise.resolve({
      core: {
        async listNamespacedPod() {
          attemptedProxy = true;
          throw Object.assign(new Error("pods/proxy denied"), { statusCode: 403 });
        },
      },
    }),
  });

  assert.equal(
    await nonNative["safeRuntimeFailureObservation"](revision, {
      name: namespace,
      plane: "execution",
    }),
    undefined,
  );
  assert.equal(attemptedProxy, false);

  const native = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
      },
    }),
  );
  const nativeRevision = {
    ...revision,
    compute: { id: native.id, implementation: native.implementation },
  };
  let nativeReads = 0;
  Object.assign(native, {
    apiClients: Promise.resolve({
      core: {
        async listNamespacedPod() {
          nativeReads += 1;
          throw Object.assign(new Error("pods/proxy denied"), { statusCode: 403 });
        },
      },
    }),
  });
  assert.equal(
    await native["safeRuntimeFailureObservation"](nativeRevision, {
      name: namespace,
      plane: "execution",
    }),
    undefined,
  );

  assert.equal(nativeReads, 2, "both native containers reach the refused Pod lookup");

  const cancellation = new Error("runtime evidence cancelled");
  const owner = new AbortController();
  owner.abort(cancellation);
  await assert.rejects(
    withComputeAbortSignal(owner.signal, () =>
      native["safeRuntimeFailureObservation"](nativeRevision, {
        name: namespace,
        plane: "execution",
      }),
    ),
    (error) => error === cancellation,
  );
}

// A provider-fenced Harness admits only its Gateway's transport: the status proxy policy
// selects ordinary Pods and the provider's fence denies the API server. No Pod proxy read can
// answer, so Compute sends none to the Harness and keeps reading the Gateway (bughunt F4).
export async function checkProviderFencedRuntimeStatus() {
  const sandboxDriver: SandboxDriver = {
    id: "sandbox-provider",
    capability: "sandbox",
    implementation: "openshell",
    facets: ["networking"],
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    async provisionHarness() {
      assert.fail("status readback must not provision a Harness");
    },
    async cleanup() {
      assert.fail("status readback must not clean up a Harness");
    },
  };
  const driver = new KubernetesComputeDriver(
    routedOptions({
      network: { pluginStatusProxySourceCidrs: ["192.0.2.20/32"] },
      runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
      servicePrincipalCredentials: {
        mode: "projectedServiceAccountToken",
        audience: "openclaw-controller",
        expirationSeconds: 900,
      },
    }),
    { sandboxDriver },
  );
  const ordinary = routedRevision(driver, { id: "revision-fenced-status" });
  const fenced = { ...ordinary, sandboxDriverId: "sandbox-provider" };
  const namespace = { name: kubernetesNamespaceName(tenant.id), plane: "execution" } as const;
  const proxyReads: string[] = [];
  const core: Pick<DiagnosticCore, "listNamespacedPod" | "connectGetNamespacedPodProxyWithPath"> = {
    async listNamespacedPod({ labelSelector }) {
      const role = labelSelector?.includes("openclaw.dev/workload-role=agent")
        ? "agent"
        : "gateway";
      return {
        apiVersion: "v1",
        kind: "PodList",
        items: [
          {
            apiVersion: "v1",
            kind: "Pod",
            metadata: {
              name: `${role}-fenced-status-pod`,
              namespace: namespace.name,
              uid: `${role}-fenced-status-uid`,
              labels: {
                "openclaw.dev/agent": ordinary.agentId,
                "openclaw.dev/revision": ordinary.id,
                "openclaw.dev/workload-role": role,
              },
            },
            status: {
              phase: "Running",
              podIP: "10.42.0.10",
              containerStatuses: [{ name: role, containerID: `${role}-container` }],
            },
          },
        ],
      };
    },
    async connectGetNamespacedPodProxyWithPath({ name, path }) {
      const role = name.startsWith("agent-") ? "agent" : "gateway";
      proxyReads.push(`${role} ${path}`);
      return {
        revisionId: ordinary.id,
        container: role,
        podUid: `${role}-fenced-status-uid`,
        startupId: `${role}-startup`,
        phase: "ready",
        successfulPluginIds: [],
        failures: [],
        observedAt: "2026-10-11T12:00:00.000Z",
        checks: [],
      };
    },
  };
  Object.assign(driver, { apiClients: Promise.resolve({ core }) });
  const observe = async (revision: AgentRevision) => {
    proxyReads.length = 0;
    await driver["safeRuntimeFailureObservation"](revision, namespace);
    const agentStatus = await driver["pluginRuntimeStatus"](revision, namespace, "agent");
    const gatewayStatus = await driver["pluginRuntimeStatus"](revision, namespace, "gateway");
    const agentChecks = await driver["runtimeDiagnosticChecks"](revision, namespace, "agent");
    return { reads: [...proxyReads], agentStatus, gatewayStatus, agentChecks };
  };

  const fencedObservation = await observe(fenced);
  assert.deepEqual(fencedObservation.reads, [
    "gateway openclaw/runtime/status",
    "gateway openclaw/plugin-runtime/status",
  ]);
  assert.equal(fencedObservation.agentStatus, undefined);
  assert.equal(fencedObservation.agentChecks, undefined);
  assert.notEqual(fencedObservation.gatewayStatus, undefined);

  // The same revision without the provider's Harness still reads both containers.
  const ordinaryObservation = await observe(ordinary);
  assert.deepEqual(ordinaryObservation.reads, [
    "agent openclaw/runtime/status",
    "gateway openclaw/runtime/status",
    "agent openclaw/plugin-runtime/status",
    "gateway openclaw/plugin-runtime/status",
    "agent openclaw/runtime/diagnostics",
  ]);
  assert.notEqual(ordinaryObservation.agentStatus, undefined);
}

// A private Secret write that the API server answers with 429 or 5xx clears by itself, so it
// must surface as a transient Kubernetes API failure: the worker then waits within the
// convergence deadline instead of spending its attempt budget. A 403 never clears by itself
// (an RBAC grant, admission policy or quota refuses it), so it surfaces as the refusal the
// worker fails at once (finding 1770). Other answers keep the redacted delivery error. Each
// way the status and Status reason stay visible to diagnostics, while the client error, whose
// message and body echo the submitted Secret, stays behind. A Secret that already exists is
// replaced instead of created; that write is classified the same way. The execution release
// key Secret is immutable, so it is only ever created (finding 2266).
function apiExceptionConstructor(): KubernetesSdk["ApiException"] {
  const requireSdk = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
  const sdk: unknown = requireSdk("@kubernetes/client-node");
  assert.ok(typeof sdk === "object" && sdk !== null && "ApiException" in sdk);
  assert.equal(typeof sdk.ApiException, "function");
  return sdk.ApiException as KubernetesSdk["ApiException"];
}

type WorkspaceFixture = ReturnType<typeof workspaceSetupFixture>;
type SecretWriteRequest = Parameters<
  WorkspaceFixture["clients"]["batch"]["createNamespacedJob"]
>[0];
type SecretWriteMethod = "createNamespacedSecret" | "replaceNamespacedSecret";

function replaceSecretWrite(
  core: WorkspaceFixture["clients"]["core"],
  method: SecretWriteMethod,
  replace: (
    request: SecretWriteRequest,
    send: WorkspaceFixture["clients"]["batch"]["createNamespacedJob"],
  ) => ReturnType<WorkspaceFixture["clients"]["batch"]["createNamespacedJob"]>,
) {
  // The workspace fixture adds these methods to core dynamically with the same writer it
  // uses for Jobs. Keep the original method for every Secret outside the target pattern.
  const send: unknown = Reflect.get(core, method);
  assert.equal(typeof send, "function");
  Object.assign(core, {
    [method]: (request: SecretWriteRequest) =>
      replace(request, send as WorkspaceFixture["clients"]["batch"]["createNamespacedJob"]),
  });
}

function prepareWorkspace({ driver, revision, context }: WorkspaceFixture) {
  const input: ComputeRevisionContext = { ...context, secretEnvironment: [] };
  return driver.prepareRevision(revision, input);
}

export async function checkPrivateSecretWriteApiAnswers(embedded: boolean) {
  const ApiException = apiExceptionConstructor();
  const targets = [
    {
      name: /^(harness|gateway)-secrets-/u,
      message: "Runtime credential delivery is unavailable.",
      stage: "harness_auth",
      writes: ["create", "replace"] as const,
      run: prepareWorkspace,
    },
    {
      name: /^workspace-setup-/u,
      message: "Workspace setup private delivery is unavailable.",
      stage: "workspace_setup",
      writes: ["create", "replace"] as const,
      run: prepareWorkspace,
    },
    {
      // Only a protected execution's preparation reads its release key, outside any named
      // stage (tests/conformance/kubernetes-provider-harness.test.mjs walks that path), so
      // this case writes it directly where the Driver does: the control namespace.
      name: /^compute-release-/u,
      message: "Compute execution release key is unavailable.",
      stage: "prepare_revision",
      writes: ["create"] as const,
      run: async ({ driver, revision }: WorkspaceFixture) => {
        const compute: unknown = driver;
        assert.ok(compute instanceof KubernetesComputeDriver);
        return compute["executionReleaseKey"](
          revision,
          await compute["controlNamespace"](revision.namespaceId),
        );
      },
    },
  ];
  const apiAnswers = [
    {
      status: 503,
      reason: "ServiceUnavailable",
      transient: true,
      keptReason: "ServiceUnavailable",
    },
    { status: 429, reason: "TooManyRequests", transient: true, keptReason: "TooManyRequests" },
    { status: 403, reason: "Forbidden", transient: false, keptReason: "Forbidden" },
    // An admission webhook can supply free text. The diagnostic retains only a single word.
    { status: 422, reason: "Invalid: CANARY_REASON", transient: false, keptReason: undefined },
  ];
  const attempts = targets.flatMap((target) =>
    target.writes.flatMap((write) => apiAnswers.map((answer) => ({ target, write, ...answer }))),
  );
  for (const { target, write, status, reason, transient, keptReason } of attempts) {
    const fixture = workspaceSetupFixture(embedded);
    const clients = await fixture.driver.apiClients;
    if (write === "replace") {
      // A first pass creates every Secret. Then the runtime Secret's stored data differs
      // from the admitted credentials (as after a rotation), and the workspace setup is
      // completed while the stored payload is not (as after a lost ready acknowledgement),
      // so the next pass replaces the target.
      await prepareWorkspace(fixture);
      for (const object of fixture.objects.values()) {
        if (object.kind === "Secret" && /^(harness|gateway)-secrets-/u.test(object.metadata.name)) {
          object.data = {};
        }
      }
      fixture.context.workspaceSetup.completed = true;
    }
    const method = `${write}NamespacedSecret` as const;
    let rejected = 0;
    const written: string[] = [];
    replaceSecretWrite(clients.core, method, async (request, send) => {
      if (target.name.test(request.body.metadata.name)) {
        rejected += 1;
        assert.ok(request.body.data);
        written.push(...Object.values(request.body.data));
        // The client's own error keeps the answer as JSON text and echoes it in its
        // message; this answer also echoes the submitted Secret.
        const answer = { kind: "Status", code: status, reason, message: request.body };
        throw new ApiException(status, "Unknown API Status Code!", JSON.stringify(answer), {});
      }
      return send(request);
    });
    const error = await target.run(fixture).then<never, unknown>(
      () => assert.fail("the private Secret write must fail"),
      (failure) => failure,
    );
    assert.equal(rejected, 1, "a mutating write is never retried inside the pass");
    assert.ok(error instanceof Error);
    if (transient) {
      assert.ok(error instanceof TransientDependencyError);
      assert.equal(error.name, "TransientDependencyError");
      assert.equal(error.code, "KUBERNETES_API_UNAVAILABLE");
      assert.equal(error.reason, "unavailable");
      assert.equal(error.message, `The Kubernetes API answered HTTP ${status}.`);
    } else if (status === 403) {
      assert.ok(error instanceof KubernetesSecretWriteForbiddenError);
      assert.equal(error.name, "KubernetesSecretWriteForbiddenError");
      // It is still an unavailable dependency for callers outside the revision worker.
      assert.ok(error instanceof DependencyUnavailableError);
      assert.equal(error.code, "KUBERNETES_SECRET_WRITE_FORBIDDEN");
      assert.equal(
        error.message,
        "The Kubernetes API refused a private Secret write with HTTP 403.",
      );
    } else {
      assert.equal(error.name, "DependencyUnavailableError");
      assert.equal(error.message, target.message);
    }
    const cause = error.cause;
    assert.ok(cause instanceof Error && "code" in cause);
    assert.equal(cause.code, status);
    assert.equal("reason" in cause ? cause.reason : undefined, keptReason);
    assert.equal(cause.cause, undefined);
    assert.deepEqual(fixture.driver.describePrepareRevisionFailure(error), {
      code: transient ? "KUBERNETES_API_UNAVAILABLE" : "KUBERNETES_API_REJECTED",
      stage: target.stage,
      errorClass: "KubernetesApiError",
      message: "The Kubernetes API rejected revision preparation.",
      status,
    });
    const evidence = inspect(error, { depth: 8 });
    assert.ok(written.length > 0);
    for (const secret of [
      ...written,
      "fixture-model-key",
      "private-create-documents",
      "CANARY_REASON",
    ]) {
      assert.equal(evidence.includes(secret), false);
    }
  }
}

// More ways a private Secret write can end. A connection that breaks while the write is
// sent (EPIPE, or ECONNABORTED for a socket the local kernel aborted) never got an answer
// from the API server, so it is transient like a refused connection. A write still unanswered
// at the request deadline is transient too, and diagnostics name the timeout. An owner that
// cancels the pass while the write is in flight gets its own cancellation back, as from every
// other Kubernetes call, not the delivery error that would read as an unavailable dependency.
export async function checkPrivateSecretWriteTransportFailures(
  context: TestContext,
  embedded: boolean,
) {
  const targets = [
    { name: /^(harness|gateway)-secrets-/u, stage: "harness_auth" },
    { name: /^workspace-setup-/u, stage: "workspace_setup" },
  ];
  for (const target of targets) {
    for (const code of ["EPIPE", "ECONNABORTED"]) {
      const fixture = workspaceSetupFixture(embedded);
      const clients = await fixture.driver.apiClients;
      replaceSecretWrite(clients.core, "createNamespacedSecret", async (request, create) => {
        if (target.name.test(request.body.metadata.name)) {
          // The client's fetch rejects with the socket error as its cause.
          throw new TypeError("fetch failed", {
            cause: Object.assign(new Error(`write ${code}`), { code, syscall: "write" }),
          });
        }
        return create(request);
      });
      const error = await prepareWorkspace(fixture).then<never, unknown>(
        () => assert.fail("the private Secret write must fail"),
        (failure) => failure,
      );
      assert.ok(error instanceof TransientDependencyError);
      assert.equal(error.name, "TransientDependencyError");
      assert.equal(error.code, "KUBERNETES_API_UNAVAILABLE");
      assert.equal(error.reason, "unreachable");
      const cause = error.cause;
      assert.ok(cause instanceof Error && "code" in cause);
      assert.equal(cause.code, code);
      assert.equal(cause.cause, undefined);
      assert.deepEqual(fixture.driver.describePrepareRevisionFailure(error), {
        code: "KUBERNETES_API_UNAVAILABLE",
        stage: target.stage,
        errorClass: "KubernetesApiUnavailableError",
        message: "The Kubernetes API server is unreachable.",
      });
    }

    {
      const fixture = workspaceSetupFixture(embedded);
      const clients = await fixture.driver.apiClients;
      // request() makes its deadline right before it calls the write, so the latest
      // AbortSignal.timeout is this write's deadline; the write lets it lapse while in flight.
      let deadline: AbortController | undefined;
      const timeout = context.mock.method(AbortSignal, "timeout", () => {
        deadline = new AbortController();
        return deadline.signal;
      });
      replaceSecretWrite(clients.core, "createNamespacedSecret", async (request, create) => {
        if (!target.name.test(request.body.metadata.name)) {
          return create(request);
        }
        assert.ok(deadline);
        deadline.abort(new DOMException("The operation timed out.", "TimeoutError"));
        throw deadline.signal.reason;
      });
      const error = await prepareWorkspace(fixture).then<never, unknown>(
        () => assert.fail("the private Secret write must fail"),
        (failure) => failure,
      );
      timeout.mock.restore();
      assert.ok(error instanceof TransientDependencyError);
      assert.equal(error.name, "TransientDependencyError");
      assert.equal(error.code, "KUBERNETES_API_UNAVAILABLE");
      assert.equal(error.reason, "timeout");
      assert.ok(error.cause instanceof Error);
      assert.equal(error.cause.cause, undefined);
      assert.deepEqual(fixture.driver.describePrepareRevisionFailure(error), {
        code: "KUBERNETES_API_TIMEOUT",
        stage: target.stage,
        errorClass: "KubernetesRequestTimeout",
        message: "Kubernetes API request timed out.",
      });
    }

    const fixture = workspaceSetupFixture(embedded);
    const clients = await fixture.driver.apiClients;
    const owner = new AbortController();
    const cancellation = new Error("revision pass cancelled");
    replaceSecretWrite(clients.core, "createNamespacedSecret", async (request, create) => {
      if (!target.name.test(request.body.metadata.name)) {
        return create(request);
      }
      // The owner cancels while the write is in flight, and the client rejects with the
      // reason of the request's signal, which follows the owner's.
      const signal = currentComputeAbortSignal();
      assert.ok(signal);
      owner.abort(cancellation);
      throw signal.reason;
    });
    await assert.rejects(
      withComputeAbortSignal(owner.signal, () => prepareWorkspace(fixture)),
      (error) => error === cancellation,
    );
  }
}

// A request timeout outside any preparation stage names the timeout, not its cause: the
// deadline's DOMException carries TIMEOUT_ERR (code 23), which once read as an HTTP status and
// logged KUBERNETES_API_REJECTED status 23 (finding 1386). A real API refusal keeps its status.
export async function checkPreparationTimeoutAndApiStatuses(context: TestContext) {
  const ApiException = apiExceptionConstructor();
  {
    const fixture = workspaceSetupFixture(true);
    const clients = await fixture.driver.apiClients;
    // request() makes its deadline right before it calls the read, so the latest
    // AbortSignal.timeout is this read's deadline; the read lets it lapse while in flight.
    let deadline: AbortController | undefined;
    const timeout = context.mock.method(AbortSignal, "timeout", () => {
      deadline = new AbortController();
      return deadline.signal;
    });
    clients.core.listNamespace = async () => {
      assert.ok(deadline);
      deadline.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
      throw deadline.signal.reason;
    };
    const error = await prepareWorkspace(fixture).then<never, unknown>(
      () => assert.fail("the Namespace read must time out"),
      (failure) => failure,
    );
    timeout.mock.restore();
    assert.ok(error instanceof TransientDependencyError);
    assert.equal(error.name, "TransientDependencyError");
    assert.equal(error.reason, "timeout");
    assert.deepEqual(fixture.driver.describePrepareRevisionFailure(error), {
      code: "KUBERNETES_API_TIMEOUT",
      stage: "prepare_revision",
      errorClass: "KubernetesRequestTimeout",
      message: "Kubernetes API request timed out.",
    });
  }
  // A 403 stays the raw ApiException. A 500 reaches the worker as the Kubernetes API's own
  // TransientDependencyError, and the diagnostic walks past it to the answer, so it keeps the
  // status (from 500 up, unavailable).
  for (const [status, code] of [
    [403, "KUBERNETES_API_REJECTED"],
    [500, "KUBERNETES_API_UNAVAILABLE"],
  ] as const) {
    const fixture = workspaceSetupFixture(true);
    Object.assign(fixture.driver, { waitBeforeRetry: async () => {} });
    const clients = await fixture.driver.apiClients;
    clients.core.listNamespace = async () => {
      throw new ApiException(
        status,
        "Refused",
        JSON.stringify({ kind: "Status", code: status }),
        {},
      );
    };
    const error = await prepareWorkspace(fixture).then<never, unknown>(
      () => assert.fail("the Namespace read must be refused"),
      (failure) => failure,
    );
    assert.equal(error instanceof TransientDependencyError, status === 500);
    assert.deepEqual(fixture.driver.describePrepareRevisionFailure(error), {
      code,
      stage: "prepare_revision",
      errorClass: "KubernetesApiError",
      message: "The Kubernetes API rejected revision preparation.",
      status,
    });
  }
  // An abort that is no Kubernetes answer never reads as an HTTP status.
  const fixture = workspaceSetupFixture(true);
  for (const name of ["TimeoutError", "AbortError"]) {
    const diagnostic = fixture.driver.describePrepareRevisionFailure(
      new DOMException("The operation was aborted.", name),
    );
    assert.equal(diagnostic.code, "KUBERNETES_PREPARATION_FAILED", name);
    assert.equal(Object.hasOwn(diagnostic, "status"), false, name);
  }
}

// The Agent Gateway's transient failure is classified already, and its cause is the Gateway's
// socket error: the diagnostic names the Gateway instead of walking on to that cause, which
// once logged KUBERNETES_API_UNAVAILABLE "The Kubernetes API server is unreachable." for a
// refused Gateway route (finding 1391). The pass still rethrows the same error, so the worker
// keeps retrying it within the deadline.
export async function checkPreparationGatewayFailure() {
  const refused = Object.assign(new Error("connect ECONNREFUSED 10.43.0.10:18789"), {
    code: "ECONNREFUSED",
  });
  for (const [failure, message] of [
    [
      new TransientDependencyError(
        "agent_gateway",
        "unreachable",
        "The Agent Gateway route was unreachable (ECONNREFUSED).",
        { cause: refused },
      ),
      "The Agent Gateway route was unreachable (ECONNREFUSED).",
    ],
    [
      new TransientDependencyError(
        "agent_gateway",
        "timeout",
        "The Agent Gateway did not answer within its connection budget.",
        { cause: new DOMException("The operation was aborted due to timeout", "TimeoutError") },
      ),
      "The Agent Gateway did not answer within its connection budget.",
    ],
  ]) {
    const fixture = workspaceSetupFixture(false);
    fixture.state.ready = true;
    // The Deployment-backed Codex Harness enrolls its workspace node after the Gateway starts,
    // outside any tagged preparation stage; enrollment throws what the Gateway client throws.
    fixture.driver.nodeEnrollment.createSetup = async () => {
      throw failure;
    };
    const error = await prepareWorkspace(fixture).then<never, unknown>(
      () => assert.fail("workspace node enrollment must fail"),
      (rejected) => rejected,
    );
    assert.equal(error, failure);
    assert.deepEqual(fixture.driver.describePrepareRevisionFailure(error), {
      code: "AGENT_GATEWAY_UNAVAILABLE",
      stage: "prepare_revision",
      errorClass: "TransientDependencyError",
      message,
    });
  }
  // OpenShell's admission limit names itself too. Its message exceeds the worker's 256-character
  // bound, so the diagnostic leaves it out rather than have the worker drop the whole line.
  const { OpenShellAdmissionLimitError } =
    await import("../../apps/controller/src/drivers/sandbox/openshell-gateway-errors.ts");
  assert.deepEqual(
    workspaceSetupFixture(false).driver.describePrepareRevisionFailure(
      new OpenShellAdmissionLimitError("CreateSandbox", Object.assign(new Error("8"), { code: 8 })),
    ),
    {
      code: "SANDBOX_ADMISSION_LIMIT_REACHED",
      stage: "prepare_revision",
      errorClass: "TransientDependencyError",
    },
  );
  // The bound is the worker's own: 256 printable characters pass, and one more character or
  // any control character leaves the message out.
  for (const [message, kept] of [
    ["x".repeat(256), true],
    ["x".repeat(257), false],
    ["The Agent Gateway route was unreachable\n(ECONNREFUSED).", false],
  ] as const) {
    const diagnostic = workspaceSetupFixture(false).driver.describePrepareRevisionFailure(
      new TransientDependencyError("agent_gateway", "unreachable", message),
    );
    assert.equal(diagnostic.code, "AGENT_GATEWAY_UNAVAILABLE");
    assert.equal(diagnostic.message, kept ? message : undefined, JSON.stringify(message));
  }
}
