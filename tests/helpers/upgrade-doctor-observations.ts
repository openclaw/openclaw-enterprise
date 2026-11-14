type DoctorPodOptions = {
  containerName?: "gateway" | "agent";
  name?: string;
  uid?: string;
  phase?: "Running" | "Failed" | "Succeeded";
  ready?: boolean;
  reason?: "Evicted";
  restartCount?: number;
  lastTerminationReason?: string | undefined;
};

export function createDoctorPodFixture(image: string) {
  return function doctorPod({
    containerName = "gateway",
    name = containerName,
    uid = `${containerName}-uid`,
    phase = "Running",
    ready = true,
    reason,
    restartCount = 0,
    lastTerminationReason,
  }: DoctorPodOptions = {}) {
    return {
      metadata: { namespace: "tenant", name, uid },
      spec: { containers: [{ name: containerName, image }] },
      status: {
        phase,
        ...(reason === undefined ? {} : { reason }),
        conditions: [{ type: "Ready", status: ready ? "True" : "False" }],
        containerStatuses: [
          {
            name: containerName,
            restartCount,
            lastState:
              lastTerminationReason === undefined
                ? {}
                : { terminated: { reason: lastTerminationReason } },
          },
        ],
      },
    };
  };
}

export function embeddedDoctorNamespace(...agentIds: string[]) {
  return {
    id: "ns_test",
    status: "ready",
    agents: agentIds.map((id) => ({
      id,
      status: "active",
      desiredRuntimeState: "running",
      executionMode: "embedded",
      activeRevisionId: "rev_old",
      deploymentInProgress: false,
    })),
  };
}
