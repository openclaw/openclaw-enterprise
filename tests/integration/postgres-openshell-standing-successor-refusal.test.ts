import test from "node:test";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { repositorySetJourney } from "../helpers/postgres-repository-set-journey.ts";

// The issuer replaces process-global HTTPS transport. Keep refusal cases serial
// within this file, isolated from renewal while their real expiry waits overlap.
for (const change of ["recipient", "approval"] as const) {
  test(
    `an expired acknowledged launch refuses a pending successor after ${change} changes`,
    { ...requiresPostgres, timeout: 180_000 },
    (t) => repositorySetJourney(t, import.meta.url, true, change),
  );
}
