import {
  ActivationFailedError,
  DependencyUnavailableError,
  TransientDependencyError,
} from "@openclaw-enterprise/occ";
import { ComputeCleanupFailedError } from "../drivers/compute/cleanup-failure.ts";

const LOGGED_ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
// A Kubernetes Status reason is one bare CamelCase word, such as Forbidden.
const LOGGED_STATUS_REASON = /^[A-Za-z]{1,64}$/u;

function loggedHttpStatus(error: unknown): number | undefined {
  const status =
    error !== null && typeof error === "object"
      ? (error as { readonly code?: unknown }).code
      : undefined;
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
}

/**
 * The HTTP status and Status reason on an error's `cause`. A Driver error that
 * replaces an SDK error, to keep private request data out of logs (a Kubernetes
 * private Secret write) or to classify it as transient, keeps them there.
 */
function causeStatusLogFields(error: object): {
  readonly status?: number;
  readonly reason?: string;
} {
  const cause = (error as { readonly cause?: unknown }).cause;
  const status = loggedHttpStatus(cause);
  if (status === undefined) {
    return {};
  }
  const reason = (cause as { readonly reason?: unknown }).reason;
  return {
    status,
    ...(typeof reason === "string" && LOGGED_STATUS_REASON.test(reason) ? { reason } : {}),
  };
}

/**
 * The cleanup failures a Compute Driver reported beside each primary failure the worker took out
 * of a ComputeCleanupFailedError, so the pass's log line still shows that cleanup failed.
 */
const computeCleanupFailures = new WeakMap<object, readonly unknown[]>();

/**
 * The failure a Compute Driver operation's outcome follows. A Driver whose cleanup also failed
 * reports both; the operation's own failure decides, so a refusal still fails at once and an
 * outage still waits, and the cleanup failure is kept for the log fields (finding 2268). A
 * primary failure that is not an object cannot carry that record, so its aggregate stays whole
 * and is classified as before. A Driver can throw one error object again (a memoized client
 * failure), so a failure without a failed cleanup clears any record it kept.
 */
export function primaryComputeFailure(error: unknown): unknown {
  if (!(error instanceof ComputeCleanupFailedError)) {
    if (error !== null && typeof error === "object") {
      computeCleanupFailures.delete(error);
    }
    return error;
  }
  const primary = error.primary;
  if (primary === null || typeof primary !== "object" || error.cleanupFailures.length === 0) {
    return error;
  }
  computeCleanupFailures.set(primary, error.cleanupFailures);
  return primary;
}

/** The error class a log line may name: its own name or constructor's, else `Error`. */
export function loggedErrorClass(error: unknown): string {
  const record = error !== null && typeof error === "object" ? error : undefined;
  return (
    (record === undefined
      ? undefined
      : [(record as { readonly name?: unknown }).name, record.constructor?.name].find(
          (candidate): candidate is string =>
            typeof candidate === "string" &&
            candidate !== "Error" &&
            LOGGED_ERROR_NAME.test(candidate),
        )) ?? "Error"
  );
}

/**
 * Log fields that say which dependency failed and why, without provider text:
 * a transient dependency names itself and a closed reason; any other failure
 * gives its error class and any fixed Driver request diagnostic. Other errors add
 * the HTTP status of an SDK error, its own or its cause's, and the Status reason a cause keeps.
 * A failure whose Compute cleanup also failed adds `cleanupCause`, the first cleanup failure's
 * class, so a failed cleanup never reads as a clean one (finding 2268).
 */
export function revisionFailureLogFields(
  error: unknown,
): ReturnType<typeof primaryFailureLogFields> & ReturnType<typeof computeCleanupLogFields> {
  return { ...primaryFailureLogFields(error), ...computeCleanupLogFields(error) };
}

/** `cleanupCause` when the Compute cleanup after this failure failed too, else nothing. */
export function computeCleanupLogFields(error: unknown): { readonly cleanupCause?: string } {
  if (error === null || typeof error !== "object") {
    return {};
  }
  // A Sandbox gateway outage reaches the log as the transient failure that wraps it.
  const cause = (error as { readonly cause?: unknown }).cause;
  const cleanup =
    computeCleanupFailures.get(error) ??
    (cause !== null && typeof cause === "object" ? computeCleanupFailures.get(cause) : undefined);
  return cleanup === undefined ? {} : { cleanupCause: loggedErrorClass(cleanup[0]) };
}

function primaryFailureLogFields(error: unknown): {
  readonly dependency?: string;
  readonly cause?: string;
  readonly failure?: string;
  readonly status?: number;
  readonly reason?: string;
  readonly method?: string;
  readonly grpcStatus?: number;
  readonly validationCategory?: string;
} {
  if (error instanceof TransientDependencyError) {
    return { dependency: error.dependency, cause: error.reason, ...causeStatusLogFields(error) };
  }
  const record = error !== null && typeof error === "object" ? error : undefined;
  const errorClass = loggedErrorClass(error);
  if (error instanceof ActivationFailedError && error.permissionDenials !== undefined) {
    return { cause: errorClass, failure: error.permissionDenials.join("_") };
  }
  if (error instanceof DependencyUnavailableError && error.requestDiagnostic !== undefined) {
    const { method, grpcStatus, validationCategory } = error.requestDiagnostic;
    return { cause: errorClass, method, grpcStatus, validationCategory };
  }
  // Kubernetes SDK errors carry the HTTP status in `code`.
  const status = loggedHttpStatus(record);
  if (status !== undefined) {
    return { cause: errorClass, status };
  }
  return record === undefined
    ? { cause: errorClass }
    : { cause: errorClass, ...causeStatusLogFields(record) };
}
