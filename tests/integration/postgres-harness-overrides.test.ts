import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { AgentRevision } from "../../packages/contracts/src/index.ts";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import {
  assertHarnessInferenceRoutes,
  exerciseHarnessOverrides,
} from "../helpers/harness-overrides.ts";
import { postgresApp } from "../helpers/postgres-egress-app.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";

test(
  "PostgreSQL preserves Harness destinations across restart and default replacement",
  requiresPostgres,
  async (t) => {
    // This fixture uses Native IAM in the same PostgreSQL State, including its transactional
    // deployment grants; the shared HTTP fixture uses an independently stored policy instead.
    const { fixture, revisions, expectedInference } = await exerciseHarnessOverrides(
      t,
      { appFactory: postgresApp },
      true,
    );
    assert.ok("pool" in fixture);
    // A fresh State reader and Compute instance cannot reconstruct old routes from new defaults.
    const restarted = new PostgresPlatformState(fixture.pool);
    const original = createTestKubernetesComputeDriver("restarted-compute", {
      gatewayRuntime: true,
      modelProvider: { ...fixture.modelProvider, protocol: "openai-responses" },
    });
    for (const replacement of [
      undefined,
      {
        protocol: "openai-responses" as const,
        baseUrl: "https://replacement.example.test/v1",
        supportsStandaloneWebSearch: true,
      },
    ]) {
      const compute = createTestKubernetesComputeDriver("restarted-compute", {
        gatewayRuntime: true,
        ...(replacement ? { modelProvider: replacement } : {}),
      });
      for (const expected of revisions) {
        const saved: Readonly<AgentRevision> | undefined = await restarted.read(
          (unit): Promise<Readonly<AgentRevision> | undefined> =>
            unit.revisions.findRevision(fixture.namespace.id, expected.agentId, expected.id),
        );
        assert.ok(saved);
        assert.deepEqual(saved.harness, expected.harness);
        const inference = expectedInference.get(expected.id);
        assert.ok(inference);
        assertHarnessInferenceRoutes(saved, inference);
        // Pin the Driver token to the fixture's requested provider, independently of
        // either Compute instance and the persisted admission result.
        const providerHash = createHash("sha256")
          .update(JSON.stringify(["openai-responses", inference.baseUrl, false]))
          .digest("hex");
        const admission = `model-provider:v1:${providerHash}:protected-codex-no-connection-retry:v1`;
        assert.equal(original.admitRevision(saved), admission);
        assert.equal(compute.admitRevision(saved), admission);
      }
    }
  },
);
