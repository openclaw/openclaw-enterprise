import { performance } from "node:perf_hooks";
import type { Clock } from "./backend-contracts.ts";

/**
 * A deliberate copy of `MAX_TIMER_DELAY_MS` from `@openclaw-enterprise/utils`: files under
 * drivers/repo/credentials import a workspace package only through a reviewed import
 * (scripts/verify-repository-credentials-boundary.mjs). The utils conformance suite checks
 * that both copies agree.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function createSystemClock(): Clock {
  return Object.freeze({
    wallNow: () => Date.now(),
    monotonicNow: () => performance.now(),
    schedule(delayMs: number, callback: () => void) {
      if (!Number.isFinite(delayMs) || delayMs < 0) {
        throw new Error("invalid-clock-delay");
      }
      // Long admission deadlines must not overflow Node's signed 32-bit timer delay.
      let active = true;
      const deadline = performance.now() + delayMs;
      let timer: ReturnType<typeof setTimeout>;
      const tick = () => {
        if (!active) {
          return;
        }
        const remaining = deadline - performance.now();
        if (remaining > 0) {
          timer = setTimeout(tick, Math.min(remaining, MAX_TIMER_DELAY_MS));
          timer.unref();
        } else {
          active = false;
          callback();
        }
      };
      timer = setTimeout(tick, Math.min(delayMs, MAX_TIMER_DELAY_MS));
      timer.unref();
      return () => {
        active = false;
        clearTimeout(timer);
      };
    },
  });
}
