import test from "node:test";

import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { repositorySetJourney } from "../helpers/postgres-repository-set-journey.ts";

// The same production worker/issuer and authenticated Gateway fixtures as the standing
// installation transfer also cover finite selections. This case does not wait for any
// expiry, so it runs as its own file beside that long one.
test(
  "one deployed OpenShell Agent pushes A and B with one repository-scoped token and cannot push C",
  { ...requiresPostgres, timeout: 90000 },
  repositorySetJourney,
);
