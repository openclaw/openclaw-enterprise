// Local resource ownership only. Remote writes keep their existing reconciliation obligations.
export function createResourceScope({ cleanupTimeoutMs = 10000 } = {}) {
  if (!Number.isFinite(cleanupTimeoutMs) || cleanupTimeoutMs <= 0) {
    throw new Error("invalid fixture cleanup timeout");
  }
  const cleanups = [];
  let closing;
  return Object.freeze({
    after(cleanup) {
      if (closing) {
        throw new Error("fixture scope already closing");
      }
      cleanups.push(cleanup);
    },
    close(primaryError) {
      const hasPrimaryError = arguments.length > 0;
      closing ??= Promise.resolve().then(async () => {
        const failures = [];
        if (hasPrimaryError) {
          failures.push(primaryError);
        }
        for (const cleanup of cleanups.reverse()) {
          let timer;
          try {
            // Owners still perform termination and joins; a deadline reports failure,
            // never successful disposal, and late rejection remains observed.
            await Promise.race([
              Promise.resolve().then(cleanup),
              new Promise((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error("fixture resource cleanup timed out")),
                  cleanupTimeoutMs,
                );
              }),
            ]);
          } catch (error) {
            failures.push(error);
          } finally {
            clearTimeout(timer);
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
export function createTestResourceScope(t, options) {
  const resources = createResourceScope(options);
  t.after(() => resources.close());
  return resources;
}
