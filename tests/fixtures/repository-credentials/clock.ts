import { setImmediate } from "node:timers/promises";

export function createControlledClock(wallMs = Date.now()) {
  let wall = wallMs;
  let mono = 0;
  let sequence = 0;
  const scheduled = new Map<number, { at: number; callback: () => void }>();
  return Object.freeze({
    wallNow: () => wall,
    monotonicNow: () => mono,
    schedule(delayMs: number, callback: () => void) {
      if (!Number.isFinite(delayMs) || delayMs < 0) {
        throw new Error("invalid fixture timer");
      }
      const id = ++sequence;
      scheduled.set(id, { at: mono + delayMs, callback });
      return () => scheduled.delete(id);
    },
    async advance(milliseconds: number, wallDelta = milliseconds) {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) {
        throw new Error("invalid clock advance");
      }
      wall += wallDelta;
      mono += milliseconds;
      for (let round = 0; round < 1000; round++) {
        const ready = [...scheduled.entries()].filter(([, timer]) => timer.at <= mono);
        if (!ready.length) {
          await setImmediate();
          if (![...scheduled.values()].some((timer) => timer.at <= mono)) {
            return;
          }
          continue;
        }
        for (const [id, timer] of ready) {
          if (scheduled.delete(id)) {
            timer.callback();
          }
        }
        await setImmediate();
      }
      throw new Error("fixture timer loop did not settle");
    },
    pendingTimers: () => scheduled.size,
    deadlines: () => [...scheduled.values()].map((timer) => timer.at),
  });
}
