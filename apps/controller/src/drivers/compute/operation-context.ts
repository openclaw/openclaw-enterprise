import { AsyncLocalStorage } from "node:async_hooks";

import { DependencyUnavailableError } from "@openclaw-enterprise/occ";

const operationSignals = new AsyncLocalStorage<AbortSignal>();
const workWaitingChecks = new AsyncLocalStorage<() => Promise<boolean>>();
const yieldingStops = new AsyncLocalStorage<true>();

export function currentComputeAbortSignal(): AbortSignal | undefined {
  return operationSignals.getStore();
}

export async function withComputeAbortSignal<Result>(
  signal: AbortSignal,
  operation: () => Promise<Result>,
): Promise<Result> {
  signal.throwIfAborted();
  return operationSignals.run(signal, operation);
}

/**
 * Runs a worker operation that can tell Compute whether other Work is waiting
 * for the worker that runs it.
 */
export async function withComputeWorkWaiting<Result>(
  check: () => Promise<boolean>,
  operation: () => Promise<Result>,
): Promise<Result> {
  return workWaitingChecks.run(check, operation);
}

/**
 * Whether other Work is waiting for the worker running this operation. The
 * worker is serial, so a Compute wait that is only an optimization (it saves a
 * later pass) ends early when this is true: the pass ends pending and is
 * requeued, and the waiting Work runs now instead of after the wait (D221).
 * Outside a worker operation, or when the check fails, nothing is waiting, so
 * the caller keeps its normal bounded wait.
 */
export async function computeWorkWaiting(): Promise<boolean> {
  const check = workWaitingChecks.getStore();
  if (check === undefined) {
    return false;
  }
  try {
    return (await check()) === true;
  } catch {
    return false;
  }
}

/**
 * Runs a stop whose workload termination waits may end early when other Work is
 * waiting: the caller retries the whole stop later (a refused candidate's stop).
 * Such a stop deletes the runtime before it waits for the Gateway to drain, so a
 * wait that ends leaves only later steps, such as artifact cleanup, to that retry.
 * Other stops keep their order and their full bounded wait.
 */
export async function withYieldingComputeStop<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  return yieldingStops.run(true, operation);
}

/** Whether this operation is a yielding (refused-candidate) stop. */
export function isYieldingComputeStop(): boolean {
  return yieldingStops.getStore() === true;
}

/** Whether a stop's termination wait should end now because other Work is waiting. */
export async function computeStopShouldYield(): Promise<boolean> {
  return yieldingStops.getStore() === true && (await computeWorkWaiting());
}

/**
 * A yielding stop ended its termination wait because other Work is waiting. The caller retries
 * the stop; unlike a failed stop, a yield does not lengthen the next one's backoff.
 */
export class ComputeStopYieldedError extends DependencyUnavailableError {
  constructor(message: string) {
    super(message);
    this.name = "ComputeStopYieldedError";
  }
}
