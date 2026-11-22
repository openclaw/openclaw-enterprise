import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

type Description = string | (() => string);
type PollingOptions =
  | number
  | null
  | {
      timeoutMs?: number;
      intervalMs?: number;
      retryErrors?: boolean;
    };

// Polls `read` until it returns a value other than undefined and returns that value. The
// deadline is checked after each read, so the last read happens at or past the deadline.
// The third argument is the timeout in milliseconds or { timeoutMs, intervalMs }: use a
// longer interval when each read is costly (a subprocess or a cluster API call). An error
// thrown by `read` fails at once; catch the ones that mean "not yet" inside `read`, or pass
// `retryErrors: true` to treat every error as "not yet": the timeout then reports the most
// recent error from any read (even if later reads returned undefined) and keeps it as `cause`.
// `description` may be a function, called once at the deadline, so the failure can report
// the state that was still wrong.
export async function waitFor<T>(
  description: Description,
  read: () => T | undefined | PromiseLike<T | undefined>,
  options: PollingOptions = {},
): Promise<T> {
  const {
    timeoutMs = 10_000,
    intervalMs = 20,
    retryErrors = false,
  } = typeof options === "number" ? { timeoutMs: options } : (options ?? {});
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    let value: T | undefined;
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
export async function waitUntil(
  description: Description,
  check: () => unknown,
  options?: PollingOptions,
): Promise<void> {
  await waitFor(description, async () => ((await check()) ? true : undefined), options);
}

// Polls `read` like waitFor (same options, passed through), except that `false` also
// means "not yet": for reads that answer false until they can return the awaited value.
// Unlike waitUntil, other falsy results (null, 0, "") end the wait and are returned.
export function waitForResult<T>(
  description: Description,
  read: () => T | false | undefined | PromiseLike<T | false | undefined>,
  options?: PollingOptions,
): Promise<T> {
  return waitFor<T>(
    description,
    async () => {
      const value = await read();
      return value === false ? undefined : value;
    },
    options,
  );
}

/**
 * Returns `promise`'s outcome, or rejects with `Timed out after <timeoutMs> ms: <message>` if
 * it has not settled by then, so a stalled step fails with its own message instead of running
 * into the test timeout. The timer is cleared as soon as `promise` settles. `message` may be a
 * function, called at the deadline, to report state gathered while waiting.
 */
export async function within<T>(
  promise: PromiseLike<T>,
  message: Description,
  timeoutMs = 10_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject: (reason: Error) => void) => {
        timer = setTimeout(() => {
          const text = typeof message === "function" ? message() : message;
          reject(new Error(`Timed out after ${timeoutMs} ms: ${text}`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A gate that a callback the test does not call itself (a Playwright route handler, a server
 * hook, an exposed function) resolves for the test to await. A plain gate stays pending forever
 * when that callback never runs (its request was not sent, or another route took it) or throws
 * before resolving it, and a route handler's throw is not reported to the waiting test: the file
 * then hangs silently until the runner kills it. `run(work)` runs the callback's work; a throw
 * while the gate is pending rejects the gate with that error (a throw after it settled propagates
 * as before). `reached()` awaits the gate with `within`'s deadline, naming `description`.
 */
export function callbackGate<T = void>(description: Description, timeoutMs = 10_000) {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  promise.catch(() => {});
  let pending = true;
  return {
    resolve(value: T) {
      pending = false;
      resolve(value);
    },
    async run(work: () => unknown): Promise<void> {
      try {
        await work();
      } catch (error) {
        if (!pending) {
          throw error;
        }
        pending = false;
        reject(error);
      }
    },
    reached: () => within(promise, () => `waiting for ${text(description)}`, timeoutMs),
  };
}

function text(description: Description): string {
  return typeof description === "function" ? description() : description;
}
