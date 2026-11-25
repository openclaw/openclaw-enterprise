import { availableParallelism, freemem, loadavg, totalmem } from "node:os";
import type { TestContext } from "node:test";

type MeasurementContext = Pick<TestContext, "diagnostic">;

type PodTimingObservation = {
  metadata: { creationTimestamp: string };
  status: {
    conditions?: readonly { type: string; status: string; lastTransitionTime?: string }[];
    containerStatuses?: readonly {
      state?: { running?: { startedAt?: string } };
      restartCount?: number;
    }[];
  };
};

export function recordFirstAgentPodTiming(
  context: MeasurementContext,
  stage: "native-initial" | "native-replacement",
  role: "harness" | "gateway",
  pod: PodTimingObservation,
  requestedAt: number,
): void {
  const created = Date.parse(pod.metadata.creationTimestamp);
  const sinceCreated = (value: string | undefined) => {
    if (value === undefined) {
      return null;
    }
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp - created : null;
  };
  const condition = (type: "PodScheduled" | "Initialized" | "Ready") =>
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
export function sampleFirstAgentCapacity(context: MeasurementContext): () => void {
  const samples: { free: number; load: number }[] = [];
  const sample = () => samples.push({ free: freemem(), load: loadavg()[0] ?? Number.NaN });
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
