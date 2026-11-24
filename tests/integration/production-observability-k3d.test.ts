import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { decodeOtlpLogs } from "../helpers/production-observability-collector.ts";
import {
  installObservabilityControlPlane,
  observabilitySelection,
  waitForObservabilityNamespaces,
} from "../helpers/production-observability-k3d.ts";
import {
  verifyInstalledWorkerRestarts,
  workerObserverCollectorBinary,
} from "../helpers/worker-termination-installed.ts";

let collectorDirectory: string | undefined;
let collectorBinary: Promise<string> | undefined;

async function extractCollectorBinary() {
  collectorDirectory ??= await mkdtemp(join(tmpdir(), "occ-worker-collector-"));
  // An unsuccessful extraction can leave a partial file. A retry gets a fresh path.
  const attempt = await mkdtemp(join(collectorDirectory, "attempt-"));
  return workerObserverCollectorBinary(attempt);
}

function getCollectorBinary() {
  collectorBinary ??= extractCollectorBinary().catch((error: unknown) => {
    collectorBinary = undefined;
    throw error;
  });
  return collectorBinary;
}

// Both tests' test Namespaces must be gone before the file passes.
after(async () => {
  const cleanup = [waitForObservabilityNamespaces()];
  if (collectorDirectory !== undefined) {
    cleanup.push(rm(collectorDirectory, { recursive: true, force: true }));
  }
  const results = await Promise.allSettled(cleanup);
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "observability fixture cleanup failed");
  }
});

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(isObject(value));
  return value;
}

function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

function string(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}

type LogAttributes = ReturnType<typeof decodeOtlpLogs>[number]["attributes"];

const attributes = (entries: LogAttributes) =>
  Object.fromEntries(entries.map(({ key, stringValue }) => [key, stringValue]));

test(
  "Helm defaults expose private OCC metrics and operational logs through real collection",
  observabilitySelection,
  async (t) => {
    const f = await installObservabilityControlPlane(t);
    const assertScrapes = async (checks: [string, string, string, number][]) => {
      const results = await Promise.allSettled(
        checks.map(async ([pod, namespace, url, status]) => {
          assert.equal((await f.scrape(pod, namespace, url)).status, status);
        }),
      );
      // Finish every bounded probe before a failure triggers namespace cleanup.
      for (const result of results) {
        if (result.status === "rejected") {
          const reason: unknown = result.reason;
          throw reason;
        }
      }
    };
    const unauthenticated = await f.request("GET", "/installation", undefined, false);
    try {
      assert.equal(unauthenticated.status, 401);
    } catch (error) {
      throw Object.assign(object(error), {
        openclawCiDiagnostic: {
          kind: "observability-installation-status",
          status: unauthenticated.status,
        },
      });
    }
    assert.ok(object(await f.api("GET", "/installation")).id);
    assert.equal(array(await f.kubernetes.resources("daemonsets", f.system)).length, 0);
    const listeners: string[] = [];
    for (const component of ["api", "worker"]) {
      const pod = object(await f.currentPod(component));
      const metadata = object(pod.metadata);
      const status = object(pod.status);
      const container = object(array(object(pod.spec).containers)[0]);
      const metricsEnabled = array(container.env).find(
        (entry) => object(entry).name === "OCC_METRICS_ENABLED",
      );
      assert.equal(metricsEnabled === undefined ? undefined : object(metricsEnabled).value, "true");
      const url = `http://${string(status.podIP)}:9464/metrics`;
      listeners.push(url);
      // Establish a live listener before testing default-deny Pod networking.
      const local = await f.node(
        string(metadata.name),
        f.system,
        `console.log(await (await fetch(${JSON.stringify(url)})).text())`,
      );
      assert.match(local, /occ_process_start_time_seconds\{[^\n]+\} [0-9.]+/);
      // worker.started is logged once at boot; a slow install can push it out of a short tail.
      const logs = await f.kubectl("-n", f.system, "logs", string(metadata.name));
      assert.match(logs, component === "api" ? /http.completed/ : /worker.started/);
    }
    await assertScrapes(listeners.map((url) => ["scraper", f.monitoring, url, 0]));
    await f.upgrade({ metrics: { ...f.selectors } });
    const request = await f.request("GET", "/installation");
    assert.ok(request.requestId);
    for (const url of listeners) {
      const metrics = await f.scrape("scraper", f.monitoring, url);
      assert.equal(metrics.status, 200);
      assert.match(string(metrics.text), /occ_process_start_time_seconds\{[^\n]+\} [0-9.]+/);
      if (url === listeners[0]) {
        assert.match(
          string(metrics.text),
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
    let found = { api: false, worker: false };
    const exporting = f.waitFor("attributed API and worker OTLP records", async () => {
      const payloads = await readLogs();
      const records = payloads.flatMap((payload) =>
        decodeOtlpLogs(payload).flatMap((resource) =>
          resource.records.map((record) => ({
            service: attributes(resource.attributes)["service.name"],
            attributes: attributes(record.attributes),
            body: record.body,
          })),
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
      found = { api: Boolean(api), worker: Boolean(worker) };
      return api && worker ? { payloads, api, worker } : false;
    });
    const exported = await exporting.catch((error: unknown) => {
      // CI results keep only allowlisted fields; name the source that never arrived.
      object(error).openclawCiDiagnostic = { kind: "observability-log-export", ...found };
      throw error;
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
        `http://${string(object(object(pod).status).podIP)}:8888/metrics`,
      );
      assert.equal(metrics.status, 200);
      assert.match(string(metrics.text), /otelcol_exporter_sent_log_records/);
    }
    f.record("Shipped Collector exported real attributed OCC logs to a minimal OTLP receiver");
    await verifyInstalledWorkerRestarts(f, readLogs, "container", getCollectorBinary);
  },
);

test(
  "worker observer retains two real restartable-init worker exits",
  observabilitySelection,
  async (t) => {
    const f = await installObservabilityControlPlane(t, { nativeRepository: true });
    const readLogs = await f.installLogReceiver();
    await verifyInstalledWorkerRestarts(f, readLogs, "restartable-init", getCollectorBinary);
    assert.ok(object(await f.api("GET", "/installation")).id);
  },
);
