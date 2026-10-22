import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

// Polls `read` until it returns a value other than undefined and returns that value. The
// deadline is checked after each read, so the last read happens at or past the deadline.
// The third argument is the timeout in milliseconds or { timeoutMs, intervalMs }: use a
// longer interval when each read is costly (a subprocess or a cluster API call). An error
// thrown by `read` fails at once; catch the ones that mean "not yet" inside `read`.
// `description` may be a function, called once at the deadline, so the failure can report
// the state that was still wrong.
export async function waitFor(description, read, options = {}) {
  const { timeoutMs = 10_000, intervalMs = 20 } =
    typeof options === "number" ? { timeoutMs: options } : (options ?? {});
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() >= deadline) {
      const text = typeof description === "function" ? description() : description;
      assert.fail(`Timed out waiting for ${text}.`);
    }
    await delay(intervalMs);
  }
}

// Polls `check` until it returns a truthy value, with the same deadline, options and failure
// as waitFor.
export async function waitUntil(description, check, options) {
  await waitFor(description, async () => ((await check()) ? true : undefined), options);
}
