import type { ComputeReadiness } from "@openclaw-enterprise/contracts";

interface DeployTiming {
  passes: number;
  passStartedAt: number;
  prepareMs: number;
  firstUnreadyAt: number | undefined;
  readinessWaitMs: number | undefined;
  readyAt: number | undefined;
}

const MAX_DEPLOY_TIMINGS = 256;

function readinessWait(timing: DeployTiming, now: number): number | undefined {
  return (
    timing.readinessWaitMs ??
    (timing.firstUnreadyAt === undefined ? undefined : now - timing.firstUnreadyAt)
  );
}

/** Phase timings for deployment passes this worker has observed. Restart or eviction resets them. */
export class DeploymentTimings {
  private readonly timings = new Map<string, DeployTiming>();

  beginPass(key: string): void {
    let timing = this.timings.get(key);
    if (timing === undefined) {
      if (this.timings.size >= MAX_DEPLOY_TIMINGS) {
        this.timings.delete(this.timings.keys().next().value!);
      }
      timing = {
        passes: 0,
        passStartedAt: 0,
        prepareMs: 0,
        firstUnreadyAt: undefined,
        readinessWaitMs: undefined,
        readyAt: undefined,
      };
      this.timings.set(key, timing);
    }
    timing.passes += 1;
    timing.passStartedAt = Date.now();
    timing.readyAt = undefined;
  }

  beginPreparation(key: string) {
    // Keep the same record across async preparation, even if newer work evicts it.
    const timing = this.timings.get(key);
    const started = Date.now();
    if (timing === undefined) {
      return undefined;
    }
    return {
      observeReadiness(observation: ComputeReadiness): void {
        const now = Date.now();
        if (!observation.ready) {
          timing.firstUnreadyAt ??= now;
        } else {
          timing.readyAt = now;
          timing.readinessWaitMs = readinessWait(timing, now);
        }
      },
      finish(): void {
        timing.prepareMs += Date.now() - started;
      },
    };
  }

  completionFields(
    key: string,
    terminal: boolean,
    workAgeMs: () => number,
  ): Readonly<Record<string, number>> {
    const timing = this.timings.get(key);
    if (timing === undefined) {
      return {};
    }
    const now = Date.now();
    if (terminal) {
      this.timings.delete(key);
    }
    return {
      durationMs: now - timing.passStartedAt,
      deployPasses: timing.passes,
      prepareMs: timing.prepareMs,
      readinessWaitMs: readinessWait(timing, now) ?? 0,
      ...(timing.readyAt === undefined ? {} : { activationMs: now - timing.readyAt }),
      elapsedMs: workAgeMs(),
    };
  }
}
