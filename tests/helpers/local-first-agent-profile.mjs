import { availableParallelism, freemem, loadavg, totalmem } from "node:os";

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

// Sample the owned hosted VM while both real Agents run; retain no process names.
export function sampleFirstAgentCapacity(context) {
  const samples = [];
  const sample = () => samples.push({ free: freemem(), load: loadavg()[0] });
  sample();
  const timer = setInterval(sample, 2000);
  timer.unref();
  let finished = false;
  return () => {
    if (finished) {
      return;
    }
    finished = true;
    clearInterval(timer);
    sample();
    context.diagnostic(
      "openclaw-ci-measurement " +
        JSON.stringify({
          kind: "local-first-agent-capacity",
          cpus: availableParallelism(),
          totalMiB: Math.round(totalmem() / 1024 ** 2),
          minimumFreeMiB: Math.round(Math.min(...samples.map(({ free }) => free)) / 1024 ** 2),
          maximumLoadHundredths: Math.round(Math.max(...samples.map(({ load }) => load)) * 100),
          samples: samples.length,
        }),
    );
  };
}
