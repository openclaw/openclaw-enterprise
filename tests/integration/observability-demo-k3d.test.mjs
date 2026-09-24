import assert from "node:assert/strict";
import test from "node:test";
import { installObservabilityControlPlane } from "../helpers/production-observability-k3d.mjs";

test(
  "demo Helm stack serves real OCC metrics and logs through Grafana",
  {
    skip:
      process.env.OCC_TEST_OBSERVABILITY_DEMO === "1"
        ? false
        : "Run pnpm test:observability --demo.",
    timeout: 600_000,
  },
  async (t) => {
    const f = await installObservabilityControlPlane(t, { demoStack: true });
    const demo = await f.installDemo();
    const request = await f.request("GET", "/installation");
    assert.equal(request.status, 200);
    assert.ok(request.requestId);
    // Query both provisioned data sources through Grafana. Ready Pods alone do
    // not prove discovery, scraping, ingestion, or Grafana's backend connections.
    await f.waitFor(
      "both OCC scrape targets in Grafana",
      async () =>
        (await demo.prometheus('up{job=~"occ-api|occ-worker"}')).filter(
          ({ value }) => Number(value[1]) === 1,
        ).length === 2,
    );
    await f.waitFor("OCC request metrics in Grafana", async () =>
      (await demo.prometheus('occ_http_requests_total{route="/installation"}')).some(
        ({ value }) => Number(value[1]) > 0,
      ),
    );
    await f.waitFor(
      "request-correlated OCC log in Grafana",
      async () =>
        (await demo.logs(`{service_name="occ-api"} | request_id = "${request.requestId}"`)).length >
        0,
    );
  },
);
