import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { installObservabilityDemo } from "../helpers/observability-demo-k3d.mjs";

test(
  "demo Helm stack ingests fixture metrics and OTLP logs through Grafana",
  {
    skip:
      process.env.OCC_TEST_OBSERVABILITY_DEMO === "1"
        ? false
        : "Select k3d-observability-demo with the CI runner; see docs/testing/metrics.md.",
    timeout: 600_000,
  },
  async (t) => {
    const demo = await installObservabilityDemo(t);
    const expression = 'demo_smoke_value{job=~"occ-api|occ-worker|collector"}';
    await demo.waitFor("all fixture metrics through Grafana's Prometheus connection", async () => {
      const rows = await demo.query(
        "prometheus",
        `/api/v1/query?query=${encodeURIComponent(expression)}`,
      );
      return (
        new Set(
          rows.filter(({ value }) => Number(value[1]) === 1).map(({ metric }) => metric.source),
        ).size === 3
      );
    });
    const marker = `demo-smoke-${randomUUID()}`;
    await demo.exportLog(marker);
    await demo.waitFor("OTLP log through Grafana's Loki connection", async () => {
      const expression = `{service_name="demo-smoke"} |= "${marker}"`;
      const rows = await demo.query(
        "loki",
        `/loki/api/v1/query_range?query=${encodeURIComponent(expression)}&since=5m`,
      );
      return rows.some(({ values }) => values.some(([, line]) => line === marker));
    });
    for (const uid of ["occ-development", "occ-logs"]) {
      const response = await demo.grafana(`/api/dashboards/uid/${uid}`);
      assert.equal(response.status, 200);
      assert.ok(JSON.parse(response.text).dashboard.panels.length > 0);
    }
  },
);
