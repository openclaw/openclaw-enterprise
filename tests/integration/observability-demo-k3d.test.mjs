import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  installObservabilityControlPlane,
  observabilitySelection,
} from "../helpers/production-observability-k3d.mjs";

test(
  "demo Grafana queries fresh OCC metrics and operational logs on k3d",
  observabilitySelection,
  async (t) => {
    const f = await installObservabilityControlPlane(t);
    const demo = await f.installDemo();
    const workflow = await f.createAgent();
    await workflow.deploy();
    await workflow.stop();
    // First establish a scraped histogram baseline, then produce another cycle.
    // Rate-based panels need observed counter growth, not a nonempty NaN series.
    await f.waitFor("first lifecycle histogram samples", async () => {
      const rows = await demo.prometheus("occ_agent_operation_duration_seconds_count");
      return ["deploy", "stop"].every((operation) =>
        rows.some(({ metric, value }) => metric.operation === operation && Number(value[1]) >= 1),
      );
    });
    await workflow.deploy();
    await workflow.stop();
    const request = await f.request("GET", "/installation");
    await f.waitFor(
      "Grafana Prometheus data source",
      async () =>
        (await demo.prometheus('up{job=~"occ-api|occ-worker"}')).filter(
          ({ value }) => Number(value[1]) === 1,
        ).length === 2,
    );
    await f.waitFor(
      "Grafana Loki data source",
      async () =>
        (await demo.logs(`{service_name="occ-api"} | request_id = "${request.requestId}"`)).length >
        0,
    );
    await f.waitFor(
      "Grafana worker log view",
      async () => (await demo.logs('{service_name="occ-worker"}')).length > 0,
    );
    // Execute the provisioned queries against actual traffic, not a duplicated list
    // of sample results. Each panel must return usable series through Grafana.
    const dashboard = JSON.parse(
      await readFile("deploy/helm/openclaw-observability-demo/files/dashboard.json", "utf8"),
    );
    for (const panel of dashboard.panels) {
      for (const target of panel.targets ?? []) {
        await f.waitFor(`dashboard panel ${panel.title}`, async () => {
          const rows = await demo.prometheus(target.expr);
          return rows.some(({ value }) => Number.isFinite(Number(value[1])));
        });
      }
    }
    await f.removeDemo();
    assert.equal((await f.api("GET", workflow.path)).id, workflow.agent.id);
    f.record(
      "Provisioned Grafana data sources and dashboard queries returned real metrics/logs; OCC survived demo removal",
    );
  },
);
