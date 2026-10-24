// The worker process's numeric environment settings, and the bound for those that feed
// Node.js timers.

import { isPositiveSafeInteger } from "@openclaw-enterprise/utils";

/**
 * The longest delay a Node.js timer honours. A longer delay (up to 2^53 passes the safe-integer
 * check) fires after 1 ms instead: a claim-lapse timer would abort every claim and the poll loop
 * would spin (finding 2303). The chart's worker timing validator uses the same bound.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** A positive integer number of milliseconds that a Node.js timer can wait for. */
export function timerDelayMs(value: number, name: string): number {
  if (!isPositiveSafeInteger(value)) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  if (value > MAX_TIMER_DELAY_MS) {
    throw new Error(`${name} must be at most ${MAX_TIMER_DELAY_MS} milliseconds.`);
  }
  return value;
}

/** A positive safe integer from the environment, or `fallback` when the variable is unset. */
function positiveEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !isPositiveSafeInteger(value)) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

/** Like `positiveEnvironment`, for a variable whose value a Node.js timer waits for. */
function timerEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number {
  return timerDelayMs(positiveEnvironment(env, name, fallback), name);
}

/**
 * The worker process's timing settings. The poll interval, claim lease and database timeout
 * feed timers; the convergence timeout is only compared with work age, so it keeps the
 * safe-integer bound.
 */
export function workerEnvironmentSettings(env: Readonly<Record<string, string | undefined>>) {
  return {
    pollIntervalMs: timerEnvironment(env, "OCC_WORKER_POLL_INTERVAL_MS", 250),
    leaseDurationMs: timerEnvironment(env, "OCC_WORKER_LEASE_DURATION_MS", 5_000),
    maxAttempts: positiveEnvironment(env, "OCC_WORKER_MAX_ATTEMPTS", 5),
    convergenceTimeoutMs: positiveEnvironment(env, "OCC_WORKER_CONVERGENCE_TIMEOUT_MS", 900_000),
    databaseTimeoutMs: timerEnvironment(env, "OCC_WORKER_DATABASE_TIMEOUT_MS", 60_000),
  };
}
