import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

// Polls `read` until it returns a value other than undefined and returns that value. The
// deadline is checked after each read, so the last read happens at or past the deadline.
// The third argument is the timeout in milliseconds or { timeoutMs, intervalMs }: use a
// longer interval when each read is costly (a subprocess or a cluster API call). An error
// thrown by `read` fails at once; catch the ones that mean "not yet" inside `read`, or pass
// `retryErrors: true` to treat every error as "not yet": the timeout then reports the most
// recent error from any read (even if later reads returned undefined) and keeps it as `cause`.
// `description` may be a function, called once at the deadline, so the failure can report
// the state that was still wrong.
export async function waitFor(description, read, options = {}) {
  const {
    timeoutMs = 10_000,
    intervalMs = 20,
    retryErrors = false,
  } = typeof options === "number" ? { timeoutMs: options } : (options ?? {});
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (;;) {
    let value;
    try {
      value = await read();
    } catch (error) {
      if (!retryErrors) {
        throw error;
      }
      lastError = error;
    }
    if (value !== undefined) {
      return value;
    }
    if (Date.now() >= deadline) {
      const text = typeof description === "function" ? description() : description;
      if (lastError === undefined) {
        assert.fail(`Timed out waiting for ${text}.`);
      }
      const last = lastError instanceof Error ? lastError.message : String(lastError);
      throw Object.assign(
        new assert.AssertionError({
          message: `Timed out waiting for ${text}. Last error: ${last}`,
        }),
        { cause: lastError },
      );
    }
    await delay(intervalMs);
  }
}

// Polls `check` until it returns a truthy value, with the same deadline, options and failure
// as waitFor.
export async function waitUntil(description, check, options) {
  await waitFor(description, async () => ((await check()) ? true : undefined), options);
}

// Polls `read` like waitFor (same options, passed through), except that `false` also
// means "not yet": for reads that answer false until they can return the awaited value.
// Unlike waitUntil, other falsy results (null, 0, "") end the wait and are returned.
export function waitForResult(description, read, options) {
  return waitFor(
    description,
    async () => {
      const value = await read();
      return value === false ? undefined : value;
    },
    options,
  );
}
