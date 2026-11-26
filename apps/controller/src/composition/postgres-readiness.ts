import type pg from "pg";

export function createPostgresReadinessCheck(pool: pg.Pool): () => Promise<void> {
  let inFlight: Promise<void> | undefined;
  return () => {
    if (inFlight === undefined) {
      // Only settlement of the database work releases admission. HTTP callers
      // can stop waiting without allowing another readiness query into the pool.
      inFlight = pool
        .query("SELECT 1")
        .then(() => undefined)
        .finally(() => {
          inFlight = undefined;
        });
    }
    return inFlight;
  };
}
