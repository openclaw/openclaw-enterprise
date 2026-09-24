import assert from "node:assert/strict";
import test from "node:test";
import {
  installObservabilityControlPlane,
  observabilitySelection,
} from "../helpers/production-observability-k3d.mjs";

test(
  "Helm defaults expose private OCC metrics and operational logs through real collection",
  observabilitySelection,
  async (t) => {
    const f = await installObservabilityControlPlane(t);
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
      // A running listener is the positive control; port-forwarding would bypass
      // NetworkPolicy and cannot establish the denied Pod-to-Pod path.
      const local = await f.node(
        pod.metadata.name,
        f.system,
        `console.log(await (await fetch(${JSON.stringify(url)})).text())`,
      );
      assert.match(local, /occ_process_start_time_seconds/);
      assert.equal((await f.scrape("scraper", f.monitoring, url)).status, 0);
      const logs = await f.kubectl("-n", f.system, "logs", pod.metadata.name, "--tail=100");
      assert.match(logs, component === "api" ? /http.completed/ : /worker.started/);
    }
    await f.upgrade({ metrics: { ...f.selectors } });
    for (const url of listeners) {
      assert.equal((await f.scrape("scraper", f.monitoring, url)).status, 200);
      assert.equal((await f.scrape("wrong-pod", f.monitoring, url)).status, 0);
      assert.equal((await f.scrape("wrong-namespace", f.foreign, url)).status, 0);
      assert.equal((await f.scrape("scraper", f.monitoring, url)).status, 200);
    }
    f.record("Default listeners and paired scraper NetworkPolicies verified");

    const demo = await f.installDemo();
    const sum = async (expression) =>
      Number((await demo.prometheus(`sum(${expression})`))[0]?.value[1] ?? 0);
    await f.waitFor(
      "all API and worker scrape targets",
      async () =>
        (await demo.prometheus('up{job=~"occ-api|occ-worker"}')).filter(
          ({ value }) => Number(value[1]) === 1,
        ).length === 2,
    );
    const beforeRequests = await sum("occ_http_requests_total");
    const beforeWork = await sum("occ_reconciliation_attempts_total");
    const workflow = await f.createAgent();
    await f.waitFor(
      "draft inventory",
      async () => (await sum('occ_agents{lifecycle_state="draft"}')) === 1,
    );
    const revision = await workflow.deploy();
    await f.waitFor(
      "running inventory and completed deploy observation",
      async () =>
        (await sum('occ_agents{lifecycle_state="running"}')) === 1 &&
        (await sum('occ_agent_operation_duration_seconds_count{operation="deploy"}')) >= 1,
    );
    await workflow.stop();
    await f.waitFor(
      "stopped inventory and stop observation",
      async () =>
        (await sum('occ_agents{lifecycle_state="stopped"}')) === 1 &&
        (await sum('occ_agent_operation_duration_seconds_count{operation="stop"}')) >= 1,
    );
    assert.ok((await sum("occ_http_requests_total")) > beforeRequests);
    assert.ok((await sum("occ_reconciliation_attempts_total")) > beforeWork);
    assert.ok((await sum("occ_reconciliation_attempt_duration_seconds_count")) > 0);
    const request = await f.request("GET", "/installation");
    assert.ok(request.requestId);
    const matching = `{service_name="occ-api"} | request_id = "${request.requestId}"`;
    const records = await f.waitFor("request-correlated exported API log", async () => {
      const rows = await demo.logs(matching);
      return rows.length ? rows : false;
    });
    assert.equal(
      records.flatMap(({ values }) => values).length,
      1,
      "one collector owns each healthy stream",
    );
    const workerLogs = await f.waitFor("revision-correlated worker logs", async () => {
      const rows = await demo.logs(
        `{service_name="occ-worker"} | occ_revision_id = "${revision.id}"`,
      );
      return rows.length ? rows : false;
    });
    for (const value of [...f.secrets, ...workflow.forbidden]) {
      assert.ok(
        !JSON.stringify([...records, ...workerLogs]).includes(value),
        "exported records contain private content",
      );
    }
    const collectors = await f.pods("collector");
    assert.equal(collectors.length, 2, "one chart Collector per k3d node");
    for (const pod of collectors) {
      assert.equal(
        (await f.scrape("wrong-pod", f.monitoring, `http://${pod.status.podIP}:8888/metrics`))
          .status,
        0,
      );
    }
    await f.waitFor(
      "Collector discovery",
      async () =>
        (await demo.prometheus('up{job="collector"}')).filter(({ value }) => Number(value[1]) === 1)
          .length === 2,
    );
    // Verify effective exporter egress with a process subject to all Collector
    // policies; the real Collector's Loki receipt above is the positive export proof.
    await f.probePod("export-probe", f.system, {
      "app.kubernetes.io/name": "openclaw-enterprise",
      "app.kubernetes.io/instance": f.release,
      "app.kubernetes.io/component": "collector",
    });
    const wrong = await f.get("pod", "wrong-pod", f.monitoring);
    const foreign = await f.get("pod", "wrong-namespace", f.foreign);
    for (const pod of [wrong, foreign]) {
      const url = `http://${pod.status.podIP}:3100/`;
      assert.equal((await f.scrape("scraper", f.monitoring, url)).status, 200);
      assert.equal((await f.scrape("export-probe", f.system, url)).status, 0);
    }
    assert.equal(
      (
        await f.scrape(
          "export-probe",
          f.system,
          `http://${f.demoRelease}-loki.${f.monitoring}.svc:3100/ready`,
        )
      ).status,
      200,
    );
    await f.kubectl("-n", f.system, "delete", "pod", "export-probe", "--wait=true");
    const collectorMetrics = structuredClone(f.values.logging.collector.metrics);
    await f.upgrade({
      logging: {
        collector: {
          ...f.values.logging.collector,
          metrics: { scraperNamespaceLabels: {}, scraperPodLabels: {} },
        },
      },
    });
    for (const pod of collectors) {
      assert.equal(
        (await f.scrape("scraper", f.monitoring, `http://${pod.status.podIP}:8888/metrics`)).status,
        0,
      );
    }
    await f.upgrade({
      logging: { collector: { ...f.values.logging.collector, metrics: { ...f.selectors } } },
    });
    for (const pod of collectors) {
      assert.equal(
        (await f.scrape("scraper", f.monitoring, `http://${pod.status.podIP}:8888/metrics`)).status,
        200,
      );
      assert.equal(
        (await f.scrape("wrong-namespace", f.foreign, `http://${pod.status.podIP}:8888/metrics`))
          .status,
        0,
      );
    }
    await f.upgrade({
      logging: { collector: { ...f.values.logging.collector, metrics: collectorMetrics } },
    });
    f.record(
      "Real Agent lifecycle metrics and attributed API/worker logs collected without model credentials",
    );

    const previous = await f.currentPod("api");
    await f.kubectl("-n", f.system, "delete", "pod", previous.metadata.name, "--wait=true");
    const replacement = await f.currentPod("api");
    assert.notEqual(replacement.metadata.uid, previous.metadata.uid);
    await f.request("GET", "/installation");
    await f.waitFor("replacement API target with fresh samples", async () => {
      const rows = await demo.prometheus(
        `occ_http_requests_total{instance="${replacement.status.podIP}:9464"}`,
      );
      return rows.some(
        ({ value }) => Number(value[0]) > Date.now() / 1000 - 20 && Number(value[1]) >= 1,
      );
    });
    const queueBefore = await sum('otelcol_exporter_queue_size{exporter="otlp_http"}');
    await f.kubectl(
      "-n",
      f.monitoring,
      "scale",
      `deployment/${f.demoRelease}-loki`,
      "--replicas=0",
    );
    await f.request("GET", "/installation");
    await f.waitFor(
      "Collector queue grows during receiver outage",
      async () => (await sum('otelcol_exporter_queue_size{exporter="otlp_http"}')) > queueBefore,
    );
    // The pinned Collector exposes queue pressure and local retry-exhaustion
    // errors. Verify those real signals before restoring the destination.
    await f.waitFor("Collector reports exhausted exporter retries", async () => {
      const logs = await Promise.all(
        collectors.map((pod) => f.kubectl("-n", f.system, "logs", pod.metadata.name, "--since=3m")),
      );
      return logs.some((value) => value.includes("Exporting failed. Dropping data."));
    });
    assert.ok((await f.api("GET", workflow.path)).id, "log backend outage must not stop OCC");
    await f.kubectl(
      "-n",
      f.monitoring,
      "scale",
      `deployment/${f.demoRelease}-loki`,
      "--replicas=1",
    );
    await f.kubectl(
      "-n",
      f.monitoring,
      "rollout",
      "status",
      `deployment/${f.demoRelease}-loki`,
      "--timeout=180s",
    );
    const recovered = await f.request("GET", "/installation");
    await f.waitFor(
      "export recovers",
      async () =>
        (await demo.logs(`{service_name="occ-api"} | request_id = "${recovered.requestId}"`))
          .length > 0,
    );
    // Hand off the same shipped configuration to an independently managed
    // Collector only after Helm has removed its owner. Historical rereads are not
    // an exactly-once guarantee; a fresh healthy event must have one owner.
    const external = [];
    for (const [kind, name, namespace] of [
      ["daemonset", "openclaw-enterprise-collector", f.system],
      ["serviceaccount", "openclaw-enterprise-collector", f.system],
      ["clusterrole", `${f.release}-openclaw-log-metadata`, undefined],
      ["clusterrolebinding", `${f.release}-openclaw-log-metadata`, undefined],
      ["networkpolicy", "openclaw-enterprise-collector-egress", f.system],
      ["networkpolicy", "openclaw-enterprise-collector-metrics", f.system],
    ]) {
      const object =
        namespace === undefined
          ? JSON.parse(await f.kubectl("get", kind, name, "-o", "json"))
          : await f.get(kind, name, namespace);
      object.metadata = { name, ...(namespace ? { namespace } : {}) };
      delete object.status;
      external.push(object);
    }
    await f.upgrade({ logging: { collector: { enabled: false } } });
    await f.waitFor(
      "previous Collector owner stopped",
      async () => (await f.pods("collector")).length === 0,
    );
    for (const object of external) {
      await f.apply(object);
    }
    t.after(async () => {
      for (const kind of ["clusterrolebinding", "clusterrole"]) {
        await f.kubectl("delete", kind, `${f.release}-openclaw-log-metadata`, "--ignore-not-found");
      }
    });
    await f.kubectl(
      "-n",
      f.system,
      "rollout",
      "status",
      "daemonset/openclaw-enterprise-collector",
      "--timeout=180s",
    );
    assert.equal((await f.kubernetes.resources("daemonsets", f.system)).length, 1);
    const handedOff = await f.request("GET", "/installation");
    const handoffLogs = await f.waitFor("existing Collector receipt", async () => {
      const rows = await demo.logs(
        `{service_name="occ-api"} | request_id = "${handedOff.requestId}"`,
      );
      return rows.length ? rows : false;
    });
    assert.equal(handoffLogs.flatMap(({ values }) => values).length, 1);
    await f.upgrade({ metrics: { enabled: false } });
    for (const component of ["api", "worker"]) {
      const pod = await f.currentPod(component);
      assert.ok(!pod.spec.containers[0].ports?.some(({ name }) => name === "metrics"));
      assert.equal(
        (await f.scrape("scraper", f.monitoring, `http://${pod.status.podIP}:9464/metrics`)).status,
        0,
      );
    }
    assert.ok((await f.api("GET", workflow.path)).id);
    await f.kubectl(
      "-n",
      f.system,
      "delete",
      "daemonset",
      "openclaw-enterprise-collector",
      "--wait=true",
    );
    await f.removeDemo();
    assert.ok((await f.api("GET", workflow.path)).id);
    f.record(
      "Pod replacement, exporter outage/recovery, metrics opt-out and scoped demo removal verified",
    );
  },
);
