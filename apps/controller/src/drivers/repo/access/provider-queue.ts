import type { Clock } from "./backend-contracts.ts";

/** Scheduling operations used by a session lifecycle. */
export interface ProviderQueue {
  run<T>(
    signal: AbortSignal,
    task: () => Promise<T>,
    priority?: "foreground" | "cleanup",
  ): Promise<T>;
  whenAvailable(notify: () => void): void;
}

/** The running task owns this slot through settlement, including after abort. */
export function createProviderQueue(maximumQueued: number) {
  type Entry = {
    priority: "foreground" | "cleanup";
    run: () => Promise<void>;
    signal: AbortSignal;
    reject: () => void;
    detach: () => void;
  };
  const waiting: Entry[] = [];
  const capacityWaiters = new Set<() => void>();
  let active = false;
  let cleanupStreak = 0;
  function notifyCapacity() {
    if (waiting.length >= maximumQueued) {
      return;
    }
    const ready = [...capacityWaiters];
    capacityWaiters.clear();
    for (const notify of ready) {
      notify();
    }
  }
  function advance() {
    if (active) {
      return;
    }
    const foreground = waiting.findIndex((entry) => entry.priority === "foreground");
    const cleanup = waiting.findIndex((entry) => entry.priority === "cleanup");
    // Give cleanup priority while allowing an admitted request through after
    // two cleanup actions, even when cleanup continues to arrive.
    const selected = cleanup >= 0 && (cleanupStreak < 2 || foreground < 0) ? cleanup : foreground;
    const next = waiting.splice(selected >= 0 ? selected : 0, 1)[0];
    if (!next) {
      notifyCapacity();
      return;
    }
    next.detach();
    if (next.signal.aborted) {
      next.reject();
      advance();
      return;
    }
    cleanupStreak = next.priority === "cleanup" ? cleanupStreak + 1 : 0;
    active = true;
    void next.run().finally(() => {
      active = false;
      advance();
    });
    notifyCapacity();
  }
  return Object.freeze({
    get pending() {
      return waiting.length + Number(active);
    },
    // Lifecycle owners register at most once per admitted session.
    whenAvailable(notify: () => void) {
      if (waiting.length < maximumQueued) {
        notify();
      } else {
        capacityWaiters.add(notify);
      }
    },
    run<T>(
      signal: AbortSignal,
      task: () => Promise<T>,
      priority: "foreground" | "cleanup" = "foreground",
    ): Promise<T> {
      if (signal.aborted || waiting.length >= maximumQueued) {
        return Promise.reject(new Error("PROVIDER_UNAVAILABLE"));
      }
      return new Promise<T>((resolve, reject) => {
        const abort = () => {
          const index = waiting.indexOf(entry);
          if (index >= 0) {
            waiting.splice(index, 1);
            entry.detach();
            entry.reject();
            notifyCapacity();
          }
        };
        const entry: Entry = {
          priority,
          signal,
          reject: () => reject(new Error("PROVIDER_UNAVAILABLE")),
          detach: () => signal.removeEventListener("abort", abort),
          run: async () => {
            try {
              resolve(await task());
            } catch {
              reject(new Error("PROVIDER_FAILED"));
            }
          },
        };
        waiting.push(entry);
        signal.addEventListener("abort", abort, { once: true });
        advance();
      });
    },
  });
}

export function waitWithin<T>(
  work: Promise<T>,
  signal: AbortSignal,
  deadline: number,
  clock: Clock,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let ended = false;
    let cancelTimer = () => {};
    const finish = (run: () => void) => {
      if (ended) {
        return;
      }
      ended = true;
      cancelTimer();
      signal.removeEventListener("abort", abort);
      run();
    };
    const abort = () => finish(() => reject(new Error("CANCELLED")));
    signal.addEventListener("abort", abort, { once: true });
    cancelTimer = clock.schedule(Math.max(0, deadline - clock.monotonicNow()), abort);
    work.then(
      (value) => finish(() => resolve(value)),
      () => finish(() => reject(new Error("ACTION_FAILED"))),
    );
    if (signal.aborted || clock.monotonicNow() >= deadline) {
      abort();
    }
  });
}
