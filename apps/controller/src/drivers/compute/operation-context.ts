import { AsyncLocalStorage } from "node:async_hooks";

import type { CredentialReadLifetime } from "@openclaw-enterprise/contracts";
import { DependencyUnavailableError } from "@openclaw-enterprise/occ";

/**
 * Which optional wait asks whether other Work is waiting: an ordinary stop's Gateway drain, or any
 * other wait (a refused candidate's stop, the workspace node binding ack or pairing, D221).
 */
export type ComputeWorkWait = "gateway-drain" | "optional";

interface ComputeOperationLifetime {
  readonly signal: AbortSignal;
  readonly deadline?: number;
}

const operationLifetimes = new AsyncLocalStorage<ComputeOperationLifetime>();
const workWaitingChecks = new AsyncLocalStorage<(wait: ComputeWorkWait) => Promise<boolean>>();
/**
 * How a stop's termination waits may yield: every wait of a refused candidate's stop, or only the
 * Gateway drain of an ordinary stop.
 */
type YieldingStop = "refused-candidate" | "gateway-drain";
const yieldingStops = new AsyncLocalStorage<YieldingStop>();

export function currentComputeAbortSignal(): AbortSignal | undefined {
  return currentComputeOperationLifetime()?.signal;
}

export function currentComputeOperationLifetime(): ComputeOperationLifetime | undefined {
  return operationLifetimes.getStore();
}

/** Bound credential I/O by its caller, enclosing cancellation and earliest absolute deadline. */
export async function withComputeOperationDeadline<Result>(
  lifetime: CredentialReadLifetime,
  operation: (effective: Required<ComputeOperationLifetime>) => Promise<Result>,
): Promise<Result> {
  const requestedDeadline = Date.parse(lifetime.deadlineAt);
  if (!Number.isFinite(requestedDeadline)) {
    throw new DOMException("The operation deadline is invalid.", "TimeoutError");
  }
  const parent = currentComputeOperationLifetime();
  const deadline = Math.min(requestedDeadline, parent?.deadline ?? Infinity);
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new DOMException("The operation deadline elapsed.", "TimeoutError");
  }
  const signal = AbortSignal.any([
    lifetime.signal,
    ...(parent ? [parent.signal] : []),
    AbortSignal.timeout(Math.min(Math.ceil(remaining), 2_147_483_647)),
  ]);
  signal.throwIfAborted();
  const effective = { signal, deadline };
  return operationLifetimes.run(effective, () => operation(effective));
}

export async function withComputeAbortSignal<Result>(
  signal: AbortSignal,
  operation: () => Promise<Result>,
): Promise<Result> {
  const parent = currentComputeOperationLifetime();
  if (parent?.deadline !== undefined) {
    const effective = {
      signal: AbortSignal.any([signal, parent.signal]),
      deadline: parent.deadline,
    };
    effective.signal.throwIfAborted();
    return operationLifetimes.run(effective, operation);
  }
  signal.throwIfAborted();
  return operationLifetimes.run({ signal }, operation);
}

/**
 * Runs a worker operation that can tell Compute whether other Work is waiting
 * for the worker that runs it. `check` learns which kind of wait asks.
 */
export async function withComputeWorkWaiting<Result>(
  check: (wait: ComputeWorkWait) => Promise<boolean>,
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
export async function computeWorkWaiting(wait: ComputeWorkWait = "optional"): Promise<boolean> {
  const check = workWaitingChecks.getStore();
  if (check === undefined) {
    return false;
  }
  try {
    return (await check(wait)) === true;
  } catch {
    return false;
  }
}

/**
 * Runs a stop whose workload termination waits may end early when other Work is
 * waiting: the caller retries the whole stop later (a refused candidate's stop).
 * Such a stop deletes the runtime before it waits for the Gateway to drain, so a
 * wait that ends leaves only later steps, such as artifact cleanup, to that retry.
 */
export async function withYieldingComputeStop<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  return yieldingStops.run("refused-candidate", operation);
}

/**
 * Runs an ordinary stop whose Gateway drain wait may end early when other Work is waiting: the
 * caller retries the whole stop later, repeating the idempotent deletes and the bounded wait
 * (finding 1088). The stop keeps its order: the Gateway drains into the running Harness, which
 * is deleted only once the Gateway's Pods are gone, and the Harness's own waits never yield.
 */
export async function withYieldingGatewayDrain<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  return yieldingStops.run("gateway-drain", operation);
}

/** Whether this operation is a refused candidate's stop, which deletes the Harness first. */
export function isYieldingComputeStop(): boolean {
  return yieldingStops.getStore() === "refused-candidate";
}

/**
 * Whether a stop's termination wait for `role`'s Pods should end now because other Work is
 * waiting. Other stops keep their full bounded waits.
 */
export async function computeStopShouldYield(role?: "agent" | "gateway"): Promise<boolean> {
  const mode = yieldingStops.getStore();
  if (mode === "gateway-drain") {
    return role === "gateway" && (await computeWorkWaiting("gateway-drain"));
  }
  return mode === "refused-candidate" && (await computeWorkWaiting("optional"));
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
