import assert from "node:assert/strict";
import test from "node:test";
import {
  installObservabilityControlPlane,
  observabilitySelection,
} from "../helpers/production-observability-k3d.mjs";
import { verifyInstalledWorkerRestarts } from "../helpers/worker-termination-installed.mjs";

type Fixture = {
  system: string;
  monitoring: string;
  foreign: string;
  secrets: string[];
  selectors: Record<string, unknown>;
  kubernetes: { resources: (kind: string, namespace: string) => Promise<unknown> };
  scrape: (pod: string, namespace: string, url: string) => Promise<unknown>;
  request: (
    method: string,
    path: string,
    body?: undefined,
    authenticated?: boolean,
  ) => Promise<unknown>;
  api: (method: string, path: string) => Promise<unknown>;
  currentPod: (component: string) => Promise<unknown>;
  node: (pod: string, namespace: string, script: string) => Promise<unknown>;
  kubectl: (...args: string[]) => Promise<unknown>;
  upgrade: (patch: Record<string, unknown>) => Promise<unknown>;
  installLogReceiver: () => Promise<unknown>;
  waitFor: (description: string, probe: () => Promise<unknown>) => Promise<unknown>;
  pods: (component: string) => Promise<unknown>;
  record: (message: string) => void;
};

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

function optionalString(value: unknown): string | null | undefined {
  assert.ok(value == null || typeof value === "string");
  return value;
}

function fixture(value: unknown): asserts value is Fixture {
  const f = object(value);
  for (const key of ["system", "monitoring", "foreign"]) {
    string(f[key]);
  }
  for (const secret of array(f.secrets)) {
    string(secret);
  }
  object(f.selectors);
  assert.equal(typeof object(f.kubernetes).resources, "function");
  for (const key of [
    "scrape",
    "request",
    "api",
    "currentPod",
    "node",
    "kubectl",
    "upgrade",
    "installLogReceiver",
    "waitFor",
    "pods",
    "record",
  ]) {
    assert.equal(typeof f[key], "function");
  }
}

function logReader(value: unknown): asserts value is () => Promise<unknown> {
  assert.equal(typeof value, "function");
}

const attributes = (entries: unknown = []) =>
  Object.fromEntries(
    array(entries).map((entry): [string, unknown] => {
      const { key, value } = object(entry);
      return [string(key), object(value).stringValue];
    }),
  );

test(
  "Helm defaults expose private OCC metrics and operational logs through real collection",
  observabilitySelection,
  async (t) => {
    const f: unknown = await installObservabilityControlPlane(t);
    fixture(f);
    const assertScrapes = async (checks: [string, string, string, number][]) => {
      const results = await Promise.allSettled(
        checks.map(async ([pod, namespace, url, status]) => {
          assert.equal(object(await f.scrape(pod, namespace, url)).status, status);
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
    const unauthenticated = object(await f.request("GET", "/installation", undefined, false));
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
    const listeners = [];
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
      assert.match(string(local), /occ_process_start_time_seconds\{[^\n]+\} [0-9.]+/);
      // worker.started is logged once at boot; a slow install can push it out of a short tail.
      const logs = await f.kubectl("-n", f.system, "logs", string(metadata.name));
      assert.match(string(logs), component === "api" ? /http.completed/ : /worker.started/);
    }
    await assertScrapes(listeners.map((url) => ["scraper", f.monitoring, url, 0]));
    await f.upgrade({ metrics: { ...f.selectors } });
    const request = object(await f.request("GET", "/installation"));
    assert.ok(request.requestId);
    for (const url of listeners) {
      const metrics = object(await f.scrape("scraper", f.monitoring, url));
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
    logReader(readLogs);
    const fresh = object(await f.request("GET", "/installation"));
    assert.ok(fresh.requestId);
    // Inspect actual OTLP exports from the shipped chart Collector. Neither a
    // query backend nor a synthetic log emission stands in for OCC here.
    let found = { api: false, worker: false };
    const exporting = f.waitFor("attributed API and worker OTLP records", async () => {
      const payloads = array(await readLogs());
      const records = payloads.flatMap((payload) => {
        const { resourceLogs = [] } = object(payload);
        return array(resourceLogs).flatMap((resourceValue) => {
          const resource = object(resourceValue);
          return array(resource.scopeLogs ?? []).flatMap((scope) => {
            const { logRecords = [] } = object(scope);
            return array(logRecords).map((recordValue) => {
              const record = object(recordValue);
              return {
                service: attributes(
                  resource.resource == null ? undefined : object(resource.resource).attributes,
                )["service.name"],
                attributes: attributes(record.attributes),
                body: optionalString(
                  record.body == null ? undefined : object(record.body).stringValue,
                ),
              };
            });
          });
        });
      });
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
        !JSON.stringify(object(exported).payloads).includes(value),
        "OTLP export contains a credential",
      );
    }
    for (const pod of array(await f.pods("collector"))) {
      const metrics = object(
        await f.scrape(
          "scraper",
          f.monitoring,
          `http://${string(object(object(pod).status).podIP)}:8888/metrics`,
        ),
      );
      assert.equal(metrics.status, 200);
      assert.match(string(metrics.text), /otelcol_exporter_sent_log_records/);
    }
    f.record("Shipped Collector exported real attributed OCC logs to a minimal OTLP receiver");
    await verifyInstalledWorkerRestarts(f, readLogs, "container");
  },
);

test(
  "worker observer retains two real restartable-init worker exits",
  observabilitySelection,
  async (t) => {
    const f: unknown = await installObservabilityControlPlane(t, { nativeRepository: true });
    fixture(f);
    const readLogs = await f.installLogReceiver();
    logReader(readLogs);
    await verifyInstalledWorkerRestarts(f, readLogs, "restartable-init");
    assert.ok(object(await f.api("GET", "/installation")).id);
  },
);
