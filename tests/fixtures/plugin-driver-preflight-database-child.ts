import assert from "node:assert/strict";
import * as credentialFixtures from "./synthetic-credential-url.mjs";

type Scenario = (typeof scenarios)[number];
type CreateDatabasePreflightFixture = (
  context: Record<string, never>,
  options: {
    scenario: Scenario;
    pluginDriverId: "occ-plugin" | "codex-plugin";
    databaseUrl: string | undefined;
    codexCredential: undefined;
  },
) => Promise<unknown>;
type SyntheticDatabaseUrl = (options: {
  protocol: "postgresql";
  username: string;
  password: string;
  host: string;
  port: number;
  pathname: string;
}) => string;

const syntheticCredentialUrl: SyntheticDatabaseUrl = credentialFixtures.syntheticCredentialUrl;

// The parent selects the full proof in the child environment before this import.
// Database selection rejects before the fixture needs the Node test context.
const {
  createPluginDriverRealFixture,
}: { createPluginDriverRealFixture: CreateDatabasePreflightFixture } =
  await import("../helpers/plugin-driver-real.mjs");

const scenarios = ["openclaw", "codex_linear", "codex_failure"] as const;
const credential = "database-fixture-password";
const credentialMaterial = /database-fixture-password|fixture-(?:other-)?user|postgresql:\/\//;
const key = (scenario: Scenario) => `OCC_TEST_PLUGIN_DRIVER_${scenario.toUpperCase()}_DATABASE_URL`;

function databaseUrl(scenario: Scenario, username: string): string {
  return syntheticCredentialUrl({
    protocol: "postgresql",
    username,
    password: credential,
    host: "127.0.0.1",
    port: 5432,
    pathname: `/${scenario}`,
  });
}

function resetDatabases() {
  for (const scenario of scenarios) {
    process.env[key(scenario)] = databaseUrl(scenario, "fixture-user");
  }
}

function create(scenario: Scenario): Promise<unknown> {
  return createPluginDriverRealFixture(
    {},
    {
      scenario,
      pluginDriverId: scenario === "openclaw" ? "occ-plugin" : "codex-plugin",
      databaseUrl: process.env[key(scenario)],
      codexCredential: undefined,
    },
  );
}

for (const [index, first] of scenarios.entries()) {
  for (const second of scenarios.slice(index + 1)) {
    resetDatabases();
    // Different credentials must not disguise the same underlying database.
    process.env[key(second)] = databaseUrl(first, "fixture-other-user");
    for (const scenario of [first, second]) {
      await assert.rejects(create(scenario), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /must use separate dedicated databases/);
        assert.doesNotMatch(error.message, credentialMaterial);
        return true;
      });
    }
  }
}
for (const scenario of scenarios) {
  resetDatabases();
  delete process.env[key(scenario)];
  await assert.rejects(create("openclaw"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, new RegExp(key(scenario)));
    assert.doesNotMatch(error.message, credentialMaterial);
    return true;
  });
}
