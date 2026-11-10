import type { AgentWire } from "../../packages/contracts/src/api/resources.ts";
import type {
  AgentRuntimeContainerStatus,
  AgentRuntimeDescription,
  AgentRuntimeLogSource,
  AgentRuntimePodStatus,
} from "../../packages/contracts/src/runtime-logs.ts";

type PodReference = AgentRuntimeLogSource["pods"][number];

type ContinuityPod = Omit<AgentRuntimePodStatus, "containers"> & {
  containers: AgentRuntimeContainerStatus[];
};

type ContinuitySource = Omit<AgentRuntimeLogSource, "pods"> & {
  pods: PodReference[];
};

type ContinuityRuntime = Omit<AgentRuntimeDescription, "pods" | "sources" | "harness"> & {
  pods: ContinuityPod[];
  sources: ContinuitySource[];
  harness?: AgentRuntimeDescription["harness"];
};

interface ContinuityObservation {
  agent: Omit<AgentWire, "activeRevisionId"> & {
    activeRevisionId?: AgentWire["activeRevisionId"] | null;
  };
  runtime: ContinuityRuntime;
  agentError?: string;
  runtimeError?: string;
  changeRevisionAfterRuntime?: string;
  changeHelmRevisionAfterRuntime?: boolean;
}

export function continuityPodReference(
  pod: Pick<AgentRuntimePodStatus, "name" | "uid">,
  container = "runtime",
): PodReference {
  return { name: pod.name, uid: pod.uid, container, restartCount: 0 };
}

export const continuityNamespace = "ns_00000000-0000-4000-8000-000000000001";
export const continuityAgent = "agt_00000000-0000-4000-8000-000000000002";
export const continuityRevision = "rev_00000000-0000-4000-8000-000000000003";
export const continuityFlags = [
  "--verify-agent",
  continuityAgent,
  "--verify-agent-namespace",
  continuityNamespace,
] as const;
export function continuityObservation(suffix = "before"): ContinuityObservation {
  const observedAt = "2026-11-07T00:00:00Z";
  const roles: AgentRuntimePodStatus["role"][] = ["agent", "gateway"];
  const pods = roles.map<ContinuityPod>((role) => ({
    role,
    cluster: "control",
    name: `${role}-${suffix}`,
    uid: `${role}-${suffix}-uid`,
    phase: "Running",
    ready: true,
    createdAt: observedAt,
    // Provider-backed workloads need not use the Compute container name.
    containers: [
      {
        name: "runtime",
        state: "running",
        reason: null,
        ready: true,
        restartCount: 0,
        startedAt: observedAt,
        lastTermination: null,
      },
    ],
    events: [],
  }));
  return {
    agent: {
      id: continuityAgent,
      namespaceId: continuityNamespace,
      name: "Continuity check",
      servicePrincipalId: "spn_00000000-0000-4000-8000-000000000004",
      configurationId: "cfg_00000000-0000-4000-8000-000000000005",
      backendId: "backend",
      // The draft was edited to embedded; the running immutable revision is dedicated.
      executionMode: "embedded",
      gatewayManagedMode: true,
      sandboxPolicyEditing: false,
      activeRevisionId: continuityRevision,
      desiredRuntimeState: "running",
      status: "active",
      harnessAuth: null,
      createdAt: observedAt,
    },
    runtime: {
      revisionId: continuityRevision,
      observedAt,
      pods,
      sources: pods.map((pod) => ({
        id: pod.role,
        kind: "container",
        available: true,
        retention: "Available while the Pod is retained.",
        pods: [continuityPodReference(pod)],
      })),
      harness: { state: "running" },
    },
  };
}
export function continuityFixture() {
  return { before: continuityObservation(), after: continuityObservation("replacement") };
}
