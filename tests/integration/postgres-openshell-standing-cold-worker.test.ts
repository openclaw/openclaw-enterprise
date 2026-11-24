import test from "node:test";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { repositorySetJourney } from "../helpers/postgres-repository-set-journey.ts";

// A worker-loop restart keeps the in-memory launch acknowledgment. A real process
// restart must instead recover durable route ownership and withdraw this Git grant.
test(
  "a cold worker persists redeploy-required standing Git status without renewing it",
  { ...requiresPostgres, timeout: 180_000 },
  (t) => repositorySetJourney(t, import.meta.url, true, "cold-worker"),
);

// Keep approval active while a real session deadline passes with the worker stopped.
// The gateway fixture supplies execution identities and the Sandbox Driver validates their continuity.
for (const outcome of ["expired-original-execution", "expired-replaced-supervisor"] as const) {
  test(
    `a cold worker after session expiry checks ${outcome}`,
    { ...requiresPostgres, timeout: 180_000 },
    (t) => repositorySetJourney(t, import.meta.url, true, outcome),
  );
}
