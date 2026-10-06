import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

// Polls `read` until it returns a value other than undefined and returns that value. The
// deadline is checked after each read, so the last read happens at or past the deadline.
export async function waitFor(description, read, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() >= deadline) {
      assert.fail(`Timed out waiting for ${description}.`);
    }
    await delay(20);
  }
}
