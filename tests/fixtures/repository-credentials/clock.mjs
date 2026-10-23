export function createControlledClock(wallMs = Date.now()) {
  let wall = wallMs;
  let mono = 0;
  let sequence = 0;
  const scheduled = new Map();
  return Object.freeze({
    wallNow: () => wall,
    monotonicNow: () => mono,
    schedule(delayMs, callback) {
      if (!Number.isFinite(delayMs) || delayMs < 0) {
        throw new Error("invalid fixture timer");
      }
      const id = ++sequence;
      scheduled.set(id, { at: mono + delayMs, callback });
      return () => scheduled.delete(id);
    },
    async advance(milliseconds, wallDelta = milliseconds) {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) {
        throw new Error("invalid clock advance");
      }
      wall += wallDelta;
      mono += milliseconds;
      for (let round = 0; round < 1000; round++) {
        const ready = [...scheduled.entries()].filter(([, timer]) => timer.at <= mono);
        if (!ready.length) {
          await new Promise((resolve) => setImmediate(resolve));
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
        await new Promise((resolve) => setImmediate(resolve));
      }
      throw new Error("fixture timer loop did not settle");
    },
    pendingTimers: () => scheduled.size,
    deadlines: () => [...scheduled.values()].map((timer) => timer.at),
  });
}
