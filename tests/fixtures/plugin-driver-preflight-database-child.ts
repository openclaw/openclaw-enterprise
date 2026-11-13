import assert from "node:assert/strict";
import { syntheticCredentialUrl } from "./synthetic-credential-url.mjs";

// The parent selects the full proof in the child environment before this import.
const { createPluginDriverRealFixture } = await import("../helpers/plugin-driver-real.mjs");
const scenarios = ["openclaw", "codex_linear", "codex_failure"] as const;
type Scenario = (typeof scenarios)[number];

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
