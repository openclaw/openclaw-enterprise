import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRevision, EgressRoute } from "../../packages/contracts/src/index.ts";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { exerciseHarnessOverrides } from "../helpers/harness-overrides.ts";
import { postgresApp } from "../helpers/postgres-egress-app.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";

test(
  "PostgreSQL preserves Harness destinations across restart and default replacement",
  requiresPostgres,
  async (t) => {
    // This fixture uses Native IAM in the same PostgreSQL State, including its transactional
    // deployment grants; the shared HTTP fixture uses an independently stored policy instead.
    const { fixture, revisions } = await exerciseHarnessOverrides(
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
        assert.equal(compute.admitRevision(saved), original.admitRevision(saved));
        assert.ok(
          saved.egressPlan?.routes.every((route: EgressRoute) =>
            (route.origin + route.path).startsWith(
              expected.harness.configuration.modelProvider.baseUrl + "/",
            ),
          ),
        );
      }
    }
  },
);
