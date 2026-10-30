import assert from "node:assert/strict";
import { ComputeCleanupFailedError } from "../../apps/controller/src/drivers/compute/cleanup-failure.ts";

/**
 * Asserts the failure a Compute Driver throws when an operation failed and so did the cleanup it
 * ran (finding 2268): the operation's own failure first, matching `primary` (the error itself or
 * a message pattern), then one cleanup failure per pattern in `cleanups`, in the order they ran.
 */
export function assertCleanupFailure(error, primary, cleanups) {
  assert.ok(
    error instanceof ComputeCleanupFailedError,
    `expected a ComputeCleanupFailedError, got ${error?.name}: ${error?.message}`,
  );
  assert.ok(error instanceof AggregateError);
  assert.equal(error.errors[0], error.primary, "the operation's own failure comes first");
  assert.deepEqual(error.errors.slice(1), [...error.cleanupFailures]);
  if (primary instanceof RegExp) {
    assert.match(String(error.primary?.message), primary);
  } else {
    assert.equal(error.primary, primary);
  }
  assert.equal(error.cleanupFailures.length, cleanups.length);
  cleanups.forEach((pattern, index) =>
    assert.match(String(error.cleanupFailures[index]?.message), pattern),
  );
}

/** `primary` as a Compute Driver throws it after its lifecycle cleanup failed too. */
export function withFailedCleanup(primary) {
  return new ComputeCleanupFailedError(
    primary,
    [new Error("Compute lifecycle hook beforeWorkloadStop failed for configuration:test")],
    "Agent workload preparation and cleanup failed.",
  );
}
