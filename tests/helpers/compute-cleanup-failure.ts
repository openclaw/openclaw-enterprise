import assert from "node:assert/strict";
import { ComputeCleanupFailedError } from "../../apps/controller/src/drivers/compute/cleanup-failure.ts";

function failureProperty(failure: unknown, key: "name" | "message"): string {
  if (failure === null || (typeof failure !== "object" && typeof failure !== "function")) {
    return "undefined";
  }
  if (key === "name") {
    return String("name" in failure ? failure.name : undefined);
  }
  return String("message" in failure ? failure.message : undefined);
}

/**
 * Asserts the failure a Compute Driver throws when an operation failed and so did the cleanup it
 * ran (finding 2268): the operation's own failure first, matching `primary` (the error itself or
 * a message pattern), then one cleanup failure per pattern in `cleanups`, in the order they ran.
 */
export function assertCleanupFailure(
  error: unknown,
  primary: Error | RegExp,
  cleanups: readonly RegExp[],
): asserts error is ComputeCleanupFailedError {
  assert.ok(
    error instanceof ComputeCleanupFailedError,
    `expected a ComputeCleanupFailedError, got ${failureProperty(error, "name")}: ${failureProperty(error, "message")}`,
  );
  assert.ok(error instanceof AggregateError);
  const errors: readonly unknown[] = error.errors;
  assert.equal(errors[0], error.primary, "the operation's own failure comes first");
  assert.deepEqual(errors.slice(1), [...error.cleanupFailures]);
  if (primary instanceof RegExp) {
    assert.match(failureProperty(error.primary, "message"), primary);
  } else {
    assert.equal(error.primary, primary);
  }
  assert.equal(error.cleanupFailures.length, cleanups.length);
  cleanups.forEach((pattern, index) =>
    assert.match(failureProperty(error.cleanupFailures[index], "message"), pattern),
  );
}

/** `primary` as a Compute Driver throws it after its lifecycle cleanup failed too. */
export function withFailedCleanup(primary: unknown): ComputeCleanupFailedError {
  return new ComputeCleanupFailedError(
    primary,
    [new Error("Compute lifecycle hook beforeWorkloadStop failed for configuration:test")],
    "Agent workload preparation and cleanup failed.",
  );
}
