/**
 * A Compute Driver operation failed, and so did the cleanup it ran before rethrowing. The
 * operation's own failure comes first: it says why the deployment failed, so the worker
 * classifies by it (a refusal stays permanent, an outage keeps waiting), and the cleanup
 * failures stay in the worker's log fields (finding 2268).
 */
export class ComputeCleanupFailedError extends AggregateError {
  /** The operation's own failure. */
  readonly primary: unknown;
  /** Each cleanup's failure, in the order the cleanups ran. */
  readonly cleanupFailures: readonly unknown[];

  constructor(primary: unknown, cleanupFailures: readonly unknown[], message: string) {
    super([primary, ...cleanupFailures], message);
    this.name = "ComputeCleanupFailedError";
    this.primary = primary;
    this.cleanupFailures = Object.freeze([...cleanupFailures]);
  }
}

/**
 * Runs every cleanup after `primary` failed, even when an earlier one fails, and returns what
 * to throw: `primary` itself when each cleanup succeeded, otherwise a
 * ComputeCleanupFailedError that keeps `primary` first. A cleanup failure never replaces it.
 */
export async function failureAfterCleanup(
  primary: unknown,
  message: string,
  cleanups: readonly (() => Promise<void>)[],
): Promise<unknown> {
  const failures: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures.length === 0
    ? primary
    : new ComputeCleanupFailedError(primary, failures, message);
}

/**
 * Maps a Driver failure, or only the primary failure inside a ComputeCleanupFailedError, so a
 * Driver's own classification (such as a transient API failure) reaches the worker either way.
 */
export function mapPrimaryFailure(error: unknown, map: (primary: unknown) => unknown): unknown {
  if (!(error instanceof ComputeCleanupFailedError)) {
    return map(error);
  }
  const primary = map(error.primary);
  return primary === error.primary
    ? error
    : new ComputeCleanupFailedError(primary, error.cleanupFailures, error.message);
}
