import { setTimeout as delay } from "node:timers/promises";

type WaitOptions = {
  describe?: () => unknown;
  interval?: number;
  now?: () => number;
};

// The caller can describe the last state it observed when the wait times out.
export async function waitFor<Result>(
  description: string,
  observe: () => Result | false | null | undefined | PromiseLike<Result | false | null | undefined>,
  timeout = 300_000,
  { describe, interval = 1000, now = () => Date.now() }: WaitOptions = {},
): Promise<Result> {
  const deadline = now() + timeout;
  // The deadline is checked after each observation, so the last one happens at or past it.
  for (;;) {
    const result = await observe();
    if (result) {
      return result;
    }
    if (now() >= deadline) {
      break;
    }
    await delay(interval);
  }
  let detail = "";
  if (describe) {
    try {
      detail = `; last observation: ${describe()}`;
    } catch (error) {
      const message =
        ((typeof error === "object" && error !== null) || typeof error === "function") &&
        "message" in error
          ? (error.message ?? error)
          : error;
      detail = `; last observation unavailable (${message})`;
    }
  }
  throw new Error(`Timed out: ${description}${detail}`);
}
