// Bookkeeping for stops whose Gateway drain yielded to other Work (AGENT_STOP_YIELDED,
// PREDECESSOR_STOP_YIELDED).

import {
  ComputeStopYieldedError,
  type ComputeWorkWait,
  withYieldingGatewayDrain,
} from "../drivers/compute/operation-context.ts";

const STOP_YIELD_RECHECK_MIN_MS = 1_000;
const STOP_YIELD_RECHECK_MAX_MS = 5_000;
// The recheck reaches its 5 s cap 50 s into the stop. A Kubernetes Gateway drains active work
// for up to 315 s (the stop waits at most about 340 s), so most of a long drain is rechecked
// every 5 s, and a finished drain is noticed within 5 s (finding 1093).
const STOP_YIELD_RECHECK_AGE_DIVISOR = 10;
/** A yielded stop's `worker.completed` line is written at most this often (finding 1094). */
export const STOP_YIELD_LOG_INTERVAL_MS = 60_000;
// A yielded stop this worker has not run again for this long is forgotten: it counts as due
// Work once more, and its next yield is logged. Longer than any wait between two passes of a
// draining stop (a recheck of at most 5 s behind another pass of at most about 340 s).
const STOP_YIELD_FORGET_MS = 600_000;

/** When work whose stop yielded runs again: 1 s, growing with its age to 5 s at 50 s. */
export function stopYieldRecheckMs(ageMs: number): number {
  return Math.min(
    STOP_YIELD_RECHECK_MAX_MS,
    Math.max(STOP_YIELD_RECHECK_MIN_MS, Math.round(ageMs / STOP_YIELD_RECHECK_AGE_DIVISOR)),
  );
}

/** The pending code of a pass whose stop yielded during a Gateway drain. */
export type StopYieldedCode = "AGENT_STOP_YIELDED" | "PREDECESSOR_STOP_YIELDED";

interface YieldedStop {
  readonly code: StopYieldedCode;
  readonly loggedAt: number;
  readonly yields: number;
  readonly yieldedAt: number;
}

/**
 * The work items whose latest pass in this worker yielded its stop. Two uses (findings 1093,
 * 1094, 1108):
 * - A draining stop does not yield to these: they are draining stops too. Several stops draining
 *   at once would otherwise yield to each other and repeat their passes back to back for the
 *   whole drain.
 * - Other optional waits do not end for a stopped Agent's yielded stop, whose next pass only
 *   rechecks its drain. They do end for a deployment whose predecessor stop yielded: once that
 *   drain is over, its next pass deletes the predecessor's Harness and deploys.
 * - Their `worker.completed` lines are throttled: the first yield is logged, then at most one
 *   a minute, each with the work's yield count so far, which the work's next other line
 *   (usually its completion) carries too.
 *
 * The record is this worker's own: after a restart, or for another worker's stops, the first
 * yield counts as due Work and is logged, as before.
 */
export class StopYields {
  private readonly stops = new Map<string, YieldedStop>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /**
   * Records that `key`'s pass yielded its stop, deferring as `code`. Returns the yield count when
   * it should be logged.
   */
  yielded(key: string, code: StopYieldedCode): number | undefined {
    const now = this.now();
    this.prune(now);
    const previous = this.stops.get(key);
    const yields = (previous?.yields ?? 0) + 1;
    if (previous !== undefined && now - previous.loggedAt < STOP_YIELD_LOG_INTERVAL_MS) {
      this.stops.set(key, { code, loggedAt: previous.loggedAt, yields, yieldedAt: now });
      return undefined;
    }
    this.stops.set(key, { code, loggedAt: now, yields, yieldedAt: now });
    return yields;
  }

  /** How many yields this worker recorded for `key` since it last settled, if any. */
  count(key: string): number | undefined {
    return this.stops.get(key)?.yields;
  }

  /** `key`'s pass ended without yielding its stop: it is no longer a yielded stop. */
  settled(key: string): void {
    this.stops.delete(key);
  }

  /**
   * The keys of yielded stops that `wait` does not end for: every one for a Gateway drain, only a
   * stopped Agent's (AGENT_STOP_YIELDED) for any other wait.
   */
  waiting(wait: ComputeWorkWait): string[] {
    this.prune(this.now());
    return [...this.stops]
      .filter(([, stop]) => wait === "gateway-drain" || stop.code === "AGENT_STOP_YIELDED")
      .map(([key]) => key);
  }

  private prune(now: number): void {
    for (const [key, stop] of this.stops) {
      if (now - stop.yieldedAt >= STOP_YIELD_FORGET_MS) {
        this.stops.delete(key);
      }
    }
  }
}

/**
 * Exclusive replacement's stop of a predecessor yielded during its Gateway drain: the pass ends
 * pending as `PREDECESSOR_STOP_YIELDED` before the candidate is prepared (finding 1090).
 */
export class PredecessorStopYieldedError extends ComputeStopYieldedError {
  constructor(cause: ComputeStopYieldedError) {
    super(cause.message);
    this.name = "PredecessorStopYieldedError";
  }
}

/** Whether `code` is the pending code of revision work whose stop yielded during a drain. */
export function isStopYieldedCode(code: string): code is StopYieldedCode {
  return code === "AGENT_STOP_YIELDED" || code === "PREDECESSOR_STOP_YIELDED";
}

/** The pending code of a pass whose stop yielded with `error`, if it did. */
export function stopYieldedCode(error: unknown): StopYieldedCode | undefined {
  if (error instanceof PredecessorStopYieldedError) {
    return "PREDECESSOR_STOP_YIELDED";
  }
  return error instanceof ComputeStopYieldedError ? "AGENT_STOP_YIELDED" : undefined;
}

/**
 * Runs a Compute stop for work `ageMs` old. Before the convergence deadline its Gateway drain
 * wait ends once other Work is due (ComputeStopYieldedError), and the caller defers the work to
 * repeat the stop; the Harness's own waits never yield, so the Harness is deleted only after the
 * Gateway's Pods are gone. From the deadline on, the stop keeps its full bounded wait, so a drain
 * that never ends cannot defer the work forever (finding 1088).
 */
export function stopWithDrainYield<Result>(
  ageMs: number,
  convergenceTimeoutMs: number,
  stop: () => Promise<Result>,
): Promise<Result> {
  return ageMs < convergenceTimeoutMs ? withYieldingGatewayDrain(stop) : stop();
}
