import assert from "node:assert/strict";
import test from "node:test";
import {
  installObservabilityControlPlane,
  observabilitySelection,
} from "../helpers/production-observability-k3d.mjs";

const attributes = (entries = []) =>
  Object.fromEntries(entries.map(({ key, value }) => [key, value.stringValue]));

test(
  "Helm defaults expose private OCC metrics and operational logs through real collection",
  observabilitySelection,
  async (t) => {
    const f = await installObservabilityControlPlane(t);
    const assertScrapes = async (checks) => {
      const results = await Promise.allSettled(
        checks.map(async ([pod, namespace, url, status]) => {
          assert.equal((await f.scrape(pod, namespace, url)).status, status);
        }),
      );
      // Finish every bounded probe before a failure triggers namespace cleanup.
      for (const result of results) {
        if (result.status === "rejected") {
          throw result.reason;
        }
      }
    };
    assert.equal((await f.request("GET", "/installation", undefined, false)).status, 401);
    assert.ok((await f.api("GET", "/installation")).id);
    assert.equal((await f.kubernetes.resources("daemonsets", f.system)).length, 0);
    const listeners = [];
    for (const component of ["api", "worker"]) {
      const pod = await f.currentPod(component);
      assert.equal(
        pod.spec.containers[0].env.find(({ name }) => name === "OCC_METRICS_ENABLED")?.value,
        "true",
      );
      const url = `http://${pod.status.podIP}:9464/metrics`;
      listeners.push(url);
      // Establish a live listener before testing default-deny Pod networking.
      const local = await f.node(
        pod.metadata.name,
        f.system,
        `console.log(await (await fetch(${JSON.stringify(url)})).text())`,
      );
      assert.match(local, /occ_process_start_time_seconds\{[^\n]+\} [0-9.]+/);
      const logs = await f.kubectl("-n", f.system, "logs", pod.metadata.name, "--tail=100");
      assert.match(logs, component === "api" ? /http.completed/ : /worker.started/);
    }
    await assertScrapes(listeners.map((url) => ["scraper", f.monitoring, url, 0]));
    await f.upgrade({ metrics: { ...f.selectors } });
    const request = await f.request("GET", "/installation");
    assert.ok(request.requestId);
    for (const url of listeners) {
      const metrics = await f.scrape("scraper", f.monitoring, url);
      assert.equal(metrics.status, 200);
      assert.match(metrics.text, /occ_process_start_time_seconds\{[^\n]+\} [0-9.]+/);
      if (url === listeners[0]) {
        assert.match(
          metrics.text,
          /occ_http_requests_total\{[^\n]*route="\/installation"[^\n]*\} [1-9][0-9]*/,
        );
      }
    }
    await assertScrapes(
      listeners.flatMap((url) => [
        ["wrong-pod", f.monitoring, url, 0],
        ["wrong-namespace", f.foreign, url, 0],
      ]),
    );
    await assertScrapes(listeners.map((url) => ["scraper", f.monitoring, url, 200]));
    f.record("Default metrics listeners and paired scraper NetworkPolicies verified with raw HTTP");

    const readLogs = await f.installLogReceiver();
    const fresh = await f.request("GET", "/installation");
    assert.ok(fresh.requestId);
    // Inspect actual OTLP exports from the shipped chart Collector. Neither a
    // query backend nor a synthetic log emission stands in for OCC here.
    const exported = await f.waitFor("attributed API and worker OTLP records", async () => {
      const payloads = await readLogs();
      const records = payloads.flatMap(({ resourceLogs = [] }) =>
        resourceLogs.flatMap((resource) =>
          (resource.scopeLogs ?? []).flatMap(({ logRecords = [] }) =>
            logRecords.map((record) => ({
              service: attributes(resource.resource?.attributes)["service.name"],
              attributes: attributes(record.attributes),
              body: record.body?.stringValue,
            })),
          ),
        ),
      );
      const api = records.find(
        (record) =>
          record.service === "occ-api" &&
          record.attributes["request.id"] === fresh.requestId &&
          record.body === "http.completed",
      );
      // Collection may start after worker startup; any real attributed worker
      // operational event establishes the source without requiring a replay.
      const worker = records.find(
        (record) =>
          record.service === "occ-worker" &&
          record.body?.startsWith("worker.") &&
          record.body === record.attributes["event.name"],
      );
      return api && worker ? { payloads, api, worker } : false;
    });
    for (const value of f.secrets) {
      assert.ok(
        !JSON.stringify(exported.payloads).includes(value),
        "OTLP export contains a credential",
      );
    }
    for (const pod of await f.pods("collector")) {
      const metrics = await f.scrape(
        "scraper",
        f.monitoring,
        `http://${pod.status.podIP}:8888/metrics`,
      );
      assert.equal(metrics.status, 200);
      assert.match(metrics.text, /otelcol_exporter_sent_log_records/);
    }
    f.record("Shipped Collector exported real attributed OCC logs to a minimal OTLP receiver");
  },
);
