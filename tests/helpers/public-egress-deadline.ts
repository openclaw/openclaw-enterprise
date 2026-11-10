import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const publicEgressBudget = { totalMs: 3_600_000, cleanupMs: 360_000 };
export const publicEgressWatchdogMs = publicEgressBudget.totalMs + 30_000;

export type RunWindow = {
  signal: AbortSignal;
  endsAt: string;
  require(ms: number): void;
  limit(ms: number): AbortSignal;
  wait(
    description: string,
    poll: (signal: AbortSignal) => Promise<boolean>,
    ms: number,
  ): Promise<void>;
};

function windowUntil(deadline: number, signal: AbortSignal): RunWindow {
  const remaining = () => Math.ceil(deadline - performance.now());
  function requireTime(ms: number) {
    signal.throwIfAborted();
    if (Math.max(1, ms) > remaining()) {
      throw new Error("Insufficient time before the public egress deadline");
    }
  }
  function limit(ms: number) {
    requireTime(0);
    return AbortSignal.any([signal, AbortSignal.timeout(Math.max(0, Math.min(ms, remaining())))]);
  }
  return {
    signal,
    endsAt: new Date(Date.now() + remaining()).toISOString(),
    require: requireTime,
    limit,
    async wait(description, poll, ms) {
      const waiting = limit(ms);
      try {
        for (;;) {
          waiting.throwIfAborted();
          const ready = await poll(waiting);
          waiting.throwIfAborted();
          if (ready) {
            return;
          }
          await delay(750, undefined, { signal: waiting });
        }
      } catch (error) {
        if (waiting.aborted) {
          throw new Error(`Timed out or cancelled waiting for ${description}`, { cause: error });
        }
        throw error;
      }
    },
  };
}

type Cleanup = (window: RunWindow) => unknown;

// The caller joins the scenario before cleanup begins. Each remote action must
// use the appropriate window so a cancelled write is reconciled, never replayed.
export async function withPublicEgressRun<T>(
  parent: AbortSignal,
  run: (window: RunWindow, after: (cleanup: Cleanup) => void) => Promise<T>,
  budget = publicEgressBudget,
): Promise<T> {
  const start = performance.now();
  const deadline = start + budget.totalMs;
  const workMs = budget.totalMs - budget.cleanupMs;
  const work = windowUntil(start + workMs, AbortSignal.any([parent, AbortSignal.timeout(workMs)]));
  const cleanups: Cleanup[] = [];
  let result: { value: T } | undefined;
  const failures: unknown[] = [];
  try {
    result = { value: await run(work, (cleanup) => cleanups.push(cleanup)) };
    work.signal.throwIfAborted();
  } catch (error) {
    failures.push(error);
  }
  // Parent cancellation and the scenario deadline cannot interrupt retirement.
  const remaining = Math.max(0, Math.ceil(deadline - performance.now()));
  const cleanup = windowUntil(deadline, AbortSignal.timeout(remaining));
  for (const dispose of cleanups.reverse()) {
    try {
      await dispose(cleanup);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "Public egress run and cleanup reported failures", {
      cause: failures[0],
    });
  }
  if (!result) {
    throw new Error("Public egress run produced no outcome");
  }
  return result.value;
}

export async function awaitPublicEgressPreparation(
  directory: string,
  window: RunWindow,
  file: string,
  expected: Record<string, string>,
  timeout: number,
) {
  await window.wait(
    file,
    async (signal) => {
      let receipt: Record<string, unknown>;
      try {
        receipt = JSON.parse(
          await readFile(join(directory, file + ".json"), { encoding: "utf8", signal }),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return false;
        }
        throw error;
      }
      for (const [key, wanted] of Object.entries(expected)) {
        assert.equal(receipt[key], wanted);
      }
      return true;
    },
    timeout,
  );
}
