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
