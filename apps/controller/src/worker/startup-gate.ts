import { numericErrorStatus } from "@openclaw-enterprise/utils";
import { setTimeout as delay } from "node:timers/promises";

export type StartupDependencyStatus = "ready" | "pending" | "identity-unavailable" | "forbidden";
export interface WorkerStartupDependency {
  readonly check: (signal: AbortSignal) => Promise<StartupDependencyStatus>;
}

/** No recovery, claims or provider effects run until these independent reads succeed. */
export async function waitForStartupDependency(options: {
  readonly dependency: WorkerStartupDependency;
  readonly signal: AbortSignal;
  readonly pollIntervalMs: number;
  readonly verifyIdentity: () => Promise<void>;
  readonly workAge: () => Promise<"current" | "old" | "unknown">;
  readonly progress: () => void;
  readonly report: (status: StartupDependencyStatus | "work-too-old" | "work-age-unknown") => void;
}): Promise<void> {
  let previous: string | undefined;
  for (;;) {
    options.signal.throwIfAborted();
    options.progress();
    let status: StartupDependencyStatus | "work-too-old" | "work-age-unknown";
    try {
      await options.verifyIdentity();
      status = await options.dependency.check(options.signal);
      if (status === "ready") {
        await options.verifyIdentity();
      }
    } catch (error) {
      options.signal.throwIfAborted();
      status = numericErrorStatus(error) === 403 ? "forbidden" : "identity-unavailable";
    }
    if (status === "ready") {
      const age = await options.workAge().catch(() => "unknown" as const);
      if (age === "unknown") {
        status = "work-age-unknown";
      } else if (age === "old") {
        status = "work-too-old";
      }
    }
    options.signal.throwIfAborted();
    if (status !== previous) {
      options.report(status);
      previous = status;
    }
    if (status === "ready" || status === "work-too-old") {
      return;
    }
    await delay(options.pollIntervalMs, undefined, { signal: options.signal });
  }
}
