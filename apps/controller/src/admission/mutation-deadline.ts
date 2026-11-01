import { AsyncLocalStorage } from "node:async_hooks";

/**
 * How long an API write's Configuration and Secret backend calls may take in all. A Kubernetes
 * save chains up to five calls, each allowed 10 seconds, so without a shared bound it could
 * commit after an ingress already answered 504; Envoy Gateway's default route timeout is 15
 * seconds (finding 3106). The rest of the 15 seconds is for IAM, PostgreSQL and the commit.
 */
export const MUTATION_BACKEND_BUDGET_MS = 12_000;

// The absolute time (Date.now) by which the enclosing API write's backend calls must end.
const mutationDeadlines = new AsyncLocalStorage<number>();

/**
 * Runs an API write whose backend calls must end by `deadline` (a Date.now time; an enclosing
 * deadline that is earlier wins). Callers run only the forward path under it: compensations
 * that undo a failed write run after it, with their own per-call timeouts, so an expired budget
 * never stops a rollback.
 */
export function withMutationDeadline<T>(deadline: number, operation: () => Promise<T>): Promise<T> {
  const enclosing = mutationDeadlines.getStore();
  return mutationDeadlines.run(Math.min(deadline, enclosing ?? Infinity), operation);
}

/** Runs cleanup of a failed write outside the deadline, which may already have passed. */
export function withoutMutationDeadline<T>(operation: () => Promise<T>): Promise<T> {
  return mutationDeadlines.exit(operation);
}

/** The enclosing API write's deadline, if any. */
export function currentMutationDeadline(): number | undefined {
  return mutationDeadlines.getStore();
}
