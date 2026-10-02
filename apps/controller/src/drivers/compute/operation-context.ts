import { AsyncLocalStorage } from "node:async_hooks";

const operationSignals = new AsyncLocalStorage<AbortSignal>();
const workWaitingChecks = new AsyncLocalStorage<() => Promise<boolean>>();

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
