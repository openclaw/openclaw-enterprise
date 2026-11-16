import { within } from "../../helpers/wait-for.mjs";

type Cleanup = () => void | Promise<void>;
export type FixtureOwner = { after(cleanup: Cleanup): void };

type ScopeOptions = { cleanupTimeoutMs?: number };
type ResourceScope = FixtureOwner & { close(...error: [] | [unknown]): Promise<void> };

// Local resource ownership only. Remote writes keep their existing reconciliation obligations.
export function createResourceScope({
  cleanupTimeoutMs = 10000,
}: ScopeOptions = {}): ResourceScope {
  if (!Number.isFinite(cleanupTimeoutMs) || cleanupTimeoutMs <= 0) {
    throw new Error("invalid fixture cleanup timeout");
  }
  const cleanups: Cleanup[] = [];
  let closing: Promise<void> | undefined;
  return Object.freeze({
    after(cleanup) {
      if (closing) {
        throw new Error("fixture scope already closing");
      }
      cleanups.push(cleanup);
    },
    close(...errors) {
      const [primaryError] = errors;
      const hasPrimaryError = errors.length > 0;
      closing ??= Promise.resolve().then(async () => {
        const failures: unknown[] = [];
        if (hasPrimaryError) {
          failures.push(primaryError);
        }
        for (const cleanup of cleanups.reverse()) {
          try {
            // Owners still perform termination and joins; a deadline reports failure,
            // never successful disposal, and late rejection remains observed.
            await within(
              Promise.resolve().then(cleanup),
              "fixture resource cleanup timed out",
              cleanupTimeoutMs,
            );
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length === 1 && hasPrimaryError) {
          throw primaryError;
        }
        if (failures.length) {
          throw new AggregateError(failures, "credential fixture cleanup failed", {
            cause: primaryError,
          });
        }
      });
      return closing;
    },
  });
}

/** A resource scope that closes after the test `t`. */
export function createTestResourceScope(t: FixtureOwner, options?: ScopeOptions) {
  const resources = createResourceScope(options);
  t.after(() => resources.close());
  return resources;
}
