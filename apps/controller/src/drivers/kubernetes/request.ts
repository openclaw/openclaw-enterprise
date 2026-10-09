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

/** What a driver throws when a request ends without an answer it can use. */
export interface KubernetesRequestFailures {
  /** The owner cancelled the operation; `reason` is its abort reason. */
  readonly cancelled: (reason: unknown) => unknown;
  /** The request ran past KUBERNETES_REQUEST_TIMEOUT_MS. */
  readonly timedOut: () => unknown;
  /** Any other failure, once no retry is left or allowed. */
  readonly failed: (error: unknown) => unknown;
}

/**
 * Runs one Kubernetes API call under KUBERNETES_REQUEST_TIMEOUT_MS and the
 * owner's cancellation (the current compute abort signal). A read is retried on
 * the READ_RETRY_DELAYS_MS schedule. A write (`mutating`) is sent once: a write
 * that failed may still have been applied (finding 909).
 */
export async function kubernetesRequest<T>(
  operation: () => Promise<T>,
  failures: KubernetesRequestFailures,
  options: { readonly mutating?: boolean } = {},
): Promise<T> {
  const ownerSignal = currentComputeAbortSignal();
  for (let attempt = 1; ; attempt += 1) {
    ownerSignal?.throwIfAborted();
    const deadline = AbortSignal.timeout(KUBERNETES_REQUEST_TIMEOUT_MS);
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
      if (!retryable || options.mutating === true || pauseMs === undefined) {
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
