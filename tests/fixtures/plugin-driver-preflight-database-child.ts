import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import type { PluginProofScenario } from "../helpers/plugin-driver-proof-inputs.ts";
import { createPluginDriverRealFixture } from "../helpers/plugin-driver-real.mjs";
import { syntheticCredentialUrl } from "./synthetic-credential-url.mjs";

const scenarios = ["openclaw", "codex_linear", "codex_failure"] as const;
const credential = "database-fixture-password";
const credentialMaterial = /database-fixture-password|fixture-(?:other-)?user|postgresql:\/\//;
const key = (scenario: PluginProofScenario) =>
  `OCC_TEST_PLUGIN_DRIVER_${scenario.toUpperCase()}_DATABASE_URL`;

function databaseUrl(scenario: PluginProofScenario, username: string, port = 5432): string {
  return syntheticCredentialUrl({
    protocol: "postgresql",
    username,
    password: credential,
    host: "127.0.0.1",
    port,
    pathname: `/${scenario}`,
  });
}

function resetDatabases() {
  for (const scenario of scenarios) {
    process.env[key(scenario)] = databaseUrl(scenario, "fixture-user");
  }
}

function create(scenario: PluginProofScenario): Promise<unknown> {
  return createPluginDriverRealFixture(
    { after },
    {
      scenario,
      pluginDriverId: scenario === "openclaw" ? "occ-plugin" : "codex-plugin",
      databaseUrl: process.env[key(scenario)],
    },
  );
}

// Inspect only this child's own files, including any directory left behind by a refusal.
const directory = await mkdtemp(join(tmpdir(), "occ-plugin-driver-preflight-"));
process.env.TMPDIR = directory;
try {
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
  assert.deepEqual(await readdir(directory), [], "database admission must leave TMPDIR empty");

  const invalidContext = { message: "a dedicated k3d-* context is required" };
  // Distinct databases pass admission and reach the actual context check before setup.
  resetDatabases();
  await assert.rejects(create("openclaw"), invalidContext);
  assert.deepEqual(await readdir(directory), [], "invalid context must leave TMPDIR empty");

  resetDatabases();
  process.env[key("codex_linear")] = databaseUrl("openclaw", "fixture-user", 5433);
  await assert.rejects(create("codex_linear"), invalidContext);
  assert.deepEqual(await readdir(directory), [], "invalid context must leave TMPDIR empty");
} finally {
  await rm(directory, { recursive: true, force: true });
}
