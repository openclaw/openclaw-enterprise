import { AsyncLocalStorage } from "node:async_hooks";

import { numericErrorStatus } from "@openclaw-enterprise/utils";
import { unreachableSocketFailure } from "../compute/kubernetes/index.ts";
import { currentComputeAbortSignal, withComputeAbortSignal } from "../compute/operation-context.ts";

/** How long one Kubernetes API request may take before its outcome counts as unknown. */
const KUBERNETES_REQUEST_TIMEOUT_MS = 10_000;

// Pauses before each retry of a read whose connection never got an answer, or
// that the API server answered with 429 or 5xx. A load balancer in front of the
// API server can refuse new connections for a second or more (finding 682), so
// the pauses span about four seconds. Writes are never retried.
const READ_RETRY_DELAYS_MS: readonly number[] = [100, 250, 500, 1_000, 2_000];

/**
 * How long an API mutation's Configuration and Secret Kubernetes calls may take in all. A save
 * chains up to five calls, each allowed KUBERNETES_REQUEST_TIMEOUT_MS, so without a shared bound
 * it could commit after an ingress already answered 504; Envoy Gateway's default route timeout
 * is 15 seconds (finding 3106). The rest of the 15 seconds is for IAM, PostgreSQL and the commit.
 */
export const KUBERNETES_MUTATION_BUDGET_MS = 12_000;

// The absolute time (Date.now) by which the enclosing API mutation's calls must end.
const mutationDeadlines = new AsyncLocalStorage<number>();

/** What a driver throws when a request ends without an answer it can use. */
export interface KubernetesRequestFailures {
  /** The owner cancelled the operation; `reason` is its abort reason. */
  readonly cancelled: (reason: unknown) => unknown;
  /** The request ran past KUBERNETES_REQUEST_TIMEOUT_MS or the mutation's deadline. */
  readonly timedOut: () => unknown;
  /** The mutation's deadline passed before the request was sent, so it was not sent. */
  readonly deadlineElapsed: () => unknown;
  /** Any other failure, once no retry is left or allowed. */
  readonly failed: (error: unknown) => unknown;
}

/**
 * Runs an API mutation whose Configuration and Secret Kubernetes calls must end by `deadline`
 * (a Date.now time; an enclosing deadline that is earlier wins). Callers run only the forward
 * path under it: compensations that undo a failed mutation run after it, with their own
 * per-call timeouts, so an expired budget never stops a rollback.
 */
export function withKubernetesMutationDeadline<T>(
  deadline: number,
  operation: () => Promise<T>,
): Promise<T> {
  const enclosing = mutationDeadlines.getStore();
  return mutationDeadlines.run(Math.min(deadline, enclosing ?? Infinity), operation);
}

/**
 * Runs cleanup of a failed write outside the mutation's deadline, which may already have
 * passed: each call keeps its own KUBERNETES_REQUEST_TIMEOUT_MS.
 */
export function withoutKubernetesMutationDeadline<T>(operation: () => Promise<T>): Promise<T> {
  return mutationDeadlines.exit(operation);
}

/**
 * Runs one Kubernetes API call under KUBERNETES_REQUEST_TIMEOUT_MS, the enclosing
 * mutation's deadline, and the owner's cancellation (the current compute abort
 * signal). A read is retried on the READ_RETRY_DELAYS_MS schedule while the
 * deadline leaves room for the pause. A write (`mutating`) is sent once: a write
 * that failed may still have been applied (finding 909). Past the mutation's
 * deadline nothing more is sent.
 */
export async function kubernetesRequest<T>(
  operation: () => Promise<T>,
  failures: KubernetesRequestFailures,
  options: { readonly mutating?: boolean } = {},
): Promise<T> {
  const ownerSignal = currentComputeAbortSignal();
  const mutationDeadline = mutationDeadlines.getStore();
  for (let attempt = 1; ; attempt += 1) {
    ownerSignal?.throwIfAborted();
    const timeoutMs = Math.min(
      KUBERNETES_REQUEST_TIMEOUT_MS,
      (mutationDeadline ?? Infinity) - Date.now(),
    );
    if (timeoutMs <= 0) {
      throw failures.deadlineElapsed();
    }
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = ownerSignal === undefined ? deadline : AbortSignal.any([ownerSignal, deadline]);
    try {
      return await withComputeAbortSignal(signal, operation);
    } catch (error) {
      if (ownerSignal?.aborted) {
        throw failures.cancelled(ownerSignal.reason);
      }
      if (deadline.aborted) {
        throw failures.timedOut();
      }
      const status = numericErrorStatus(error);
      const retryable =
        status === 429 ||
        (status !== undefined && status >= 500) ||
        (status === undefined && unreachableSocketFailure(error));
      const pauseMs = READ_RETRY_DELAYS_MS[attempt - 1];
      if (
        !retryable ||
        options.mutating === true ||
        pauseMs === undefined ||
        Date.now() + pauseMs >= (mutationDeadline ?? Infinity)
      ) {
        throw failures.failed(error);
      }
      if (!(await retryPause(pauseMs, ownerSignal))) {
        throw failures.cancelled(ownerSignal?.reason);
      }
    }
  }
}

/** Waits before a read retry; false when the owner cancelled the operation meanwhile. */
function retryPause(delayMs: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const cancelled = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", cancelled);
      resolve(true);
    }, delayMs);
    signal?.addEventListener("abort", cancelled, { once: true });
  });
}
