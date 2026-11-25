import assert from "node:assert/strict";
import test from "node:test";
import type { CredentialProviderDefinition } from "../../packages/contracts/src/index.ts";
import { CredentialProxy } from "../../packages/occ/src/credential-proxy.ts";
import { EgressSendReceipts } from "../../packages/occ/src/egress-send-receipts.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { syntheticDispatchFixture } from "../helpers/static-egress-dispatch.ts";

test("classification diagnostics reject contradictory reports and preserve audit-write refusal", async (t) => {
  // This checks the shared registry's provider and audit ports. The PostgreSQL
  // egress case separately proves signed transport and persisted attribution.
  const f = await syntheticDispatchFixture(t, new EgressSendReceipts(new InMemoryPlatformState()));
  const ports = f.ports;
  const peer = await ports.exchangeOwner.verify("synthetic-peer");
  assert.ok(peer);
  const installed = await ports.installation(peer);
  assert.ok(installed);
  const route = installed.plan.routes[0]!;
  const original = ports.provider(route);
  assert.ok(original && original !== "ambiguous");
  const scenarios = [
    { name: "single report", reports: [[4]], audit: true },
    { name: "zero", reports: [[0]] },
    { name: "above range", reports: [[256]] },
    { name: "noninteger", reports: [[1.5]] },
    { name: "nonfinite", reports: [[NaN]] },
    { name: "repeated", reports: [[4, 4]] },
    { name: "two reporters", reports: [[4], [4]] },
    { name: "competing repeated reporter", reports: [[4], [4, 4]] },
    { name: "competing invalid reporter", reports: [[4], [0]] },
    { name: "report and accept", reports: [[4]], accept: true },
    { name: "audit unavailable", reports: [[4]], audit: true, writeFails: true },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const routes = scenario.reports.map((_, index) => ({
        ...route,
        route: { ...route.route, id: `route-${index}` },
      }));
      const provider: CredentialProviderDefinition = {
        ...original,
        classify(candidate, request, refused) {
          for (const rule of scenario.reports[routes.indexOf(candidate)]!) {
            refused?.(rule);
          }
          return original.classify(candidate, request);
        },
      };
      const observed: { id: string; rule: number }[] = [];
      const proxy = new CredentialProxy({
        ...ports,
        installation: async () => ({ ...installed, plan: { ...installed.plan, routes } }),
        provider: () => provider,
        classificationRefused: async (use, rule) => {
          observed.push({ id: use.id, rule });
          if (scenario.writeFails) {
            throw new Error("Synthetic audit port unavailable");
          }
        },
      });
      const request = {
        ...f.request,
        body: Buffer.from(
          JSON.stringify({ model: "fixture-model", input: "hello", store: !scenario.accept }),
        ),
      };
      const reads = f.reads;
      const result = await proxy.resolve(
        "synthetic-peer",
        peer.sandboxId,
        request,
        AbortSignal.timeout(5_000),
      );
      assert.deepEqual(observed, scenario.audit ? [{ id: request.id, rule: 4 }] : []);
      if (scenario.accept) {
        assert.equal(result.kind, "ready");
        assert.equal(f.reads, reads + 1);
      } else {
        assert.deepEqual(result, {
          kind: "refused",
          error: scenario.writeFails
            ? { kind: "unavailable", code: "authority" }
            : { kind: "denied", code: "unsupported_operation" },
        });
        assert.equal(f.reads, reads);
      }
      assert.equal(f.arrivals, 0);
    });
  }
});
