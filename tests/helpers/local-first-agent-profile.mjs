export function recordFirstAgentPodTiming(context, stage, role, pod, requestedAt) {
  const created = Date.parse(pod.metadata.creationTimestamp);
  const sinceCreated = (value) =>
    Number.isFinite(Date.parse(value)) ? Date.parse(value) - created : null;
  const condition = (type) =>
    sinceCreated(
      pod.status.conditions?.find((item) => item.type === type && item.status === "True")
        ?.lastTransitionTime,
    );
  const containers = pod.status.containerStatuses ?? [];
  context.diagnostic(
    "openclaw-ci-measurement " +
      JSON.stringify({
        kind: "local-first-agent-pod",
        stage,
        role,
        createdAfterRequestMs: created - requestedAt,
        scheduledMs: condition("PodScheduled"),
        initializedMs: condition("Initialized"),
        runningMs: containers.length
          ? Math.max(...containers.map((item) => sinceCreated(item.state?.running?.startedAt) ?? 0))
          : null,
        readyMs: condition("Ready"),
        observedMs: Date.now() - created,
        restarts: containers.reduce((total, item) => total + (item.restartCount ?? 0), 0),
      }),
  );
}
