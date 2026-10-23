import { mock } from "node:test";

// Runs an operation with mocked timers, firing each retry pause as soon as it is
// scheduled, and appends each pause's length to `pauses` (the mocked clock moves
// by exactly the pending pause). Request deadlines use AbortSignal.timeout, which
// stays real, and the loop spins until the operation settles: keep operations that
// wait for a real deadline out of it. Not reentrant.
export async function withRetryTimers(operation, pauses = []) {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    let settled = false;
    const result = operation();
    result.then(
      () => (settled = true),
      () => (settled = true),
    );
    while (!settled) {
      await new Promise((resolve) => setImmediate(resolve));
      const before = Date.now();
      mock.timers.runAll();
      if (Date.now() > before) {
        pauses.push(Date.now() - before);
      }
    }
    return await result;
  } finally {
    mock.timers.reset();
  }
}

// A copy of READ_RETRY_DELAYS_MS (apps/controller/src/drivers/kubernetes/request.ts),
// as a pin: five pauses, about four seconds in all. A change to the schedule
// updates both.
export const READ_RETRY_PAUSES_MS = [100, 250, 500, 1_000, 2_000];
