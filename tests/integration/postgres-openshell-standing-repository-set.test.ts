import test from "node:test";
import assert from "node:assert/strict";

import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { repositorySetJourney } from "../helpers/postgres-repository-set-journey.ts";

// Check before requiresPostgres can skip this canonical conversation qualification.
if (process.env.OCC_TEST_REQUIRE_STANDING_GIT_CONVERSATION === "1") {
  assert.ok(
    process.env.OCC_TEST_DATABASE_URL,
    "conversation qualification requires an owned PostgreSQL database",
  );
  assert.ok(
    process.env.OCC_TEST_STANDING_GIT_CODEX,
    "conversation qualification requires the shipped Codex executable",
  );
}

// The ordinary run covers selected repository access. Opt-in uses the shipped Codex
// executable with the same selected route and a controlled model endpoint.
test(
  "one deployed OpenShell Agent pushes A and B with one repository-scoped token and cannot push C",
  { ...requiresPostgres, timeout: process.env.OCC_TEST_STANDING_GIT_CODEX ? 240000 : 120000 },
  repositorySetJourney,
);
