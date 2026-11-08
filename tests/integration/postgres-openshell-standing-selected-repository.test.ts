import test from "node:test";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { repositorySetJourney } from "../helpers/postgres-repository-set-journey.ts";

// Real PostgreSQL, worker, prepared issuer and online authority; the OpenShell
// supervisor and GitHub origin remain controlled protocol fixtures.
test(
  "one selected repository renews beyond its original session without replacing the execution and denies withdrawn approval",
  { ...requiresPostgres, timeout: 180_000 },
  (t) => repositorySetJourney(t, true),
);

for (const change of ["recipient", "approval"] as const) {
  test(
    `an expired acknowledged launch refuses a pending successor after ${change} changes`,
    { ...requiresPostgres, timeout: 180_000 },
    (t) => repositorySetJourney(t, true, change),
  );
}

// A worker-loop restart keeps the in-memory launch acknowledgment. A real process
// restart must instead recover durable route ownership and withdraw this Git grant.
test(
  "a cold worker persists redeploy-required standing Git status without renewing it",
  { ...requiresPostgres, timeout: 180_000 },
  (t) => repositorySetJourney(t, true, "cold-worker"),
);

// Keep approval active while a real session deadline passes with the worker stopped.
// Kubernetes records are controlled; their validation and witness come from the real Sandbox Driver.
for (const outcome of ["expired-original-pods", "expired-replaced-supervisor"] as const) {
  test(
    `a cold worker after session expiry checks ${outcome}`,
    { ...requiresPostgres, timeout: 180_000 },
    (t) => repositorySetJourney(t, true, outcome),
  );
}
