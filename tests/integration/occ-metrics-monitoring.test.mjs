import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import test from "node:test";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createOccMetrics } from "../../apps/controller/src/metrics/index.ts";
import { startMetricsListener } from "../../apps/controller/src/metrics/listener.ts";

const run = promisify(execFile);
const engine = process.env.OCC_METRICS_TEST_ENGINE ?? "docker";
const prometheusImage =
  "docker.io/prom/prometheus@sha256:5ce7540c3c00ef4ab0c9d2c995c6a5b9c421f44b4a115d97a2c7af3b1c21cbb0";
const grafanaImage =
  "docker.io/grafana/grafana@sha256:ac461fb352abc50da10a51c7d02462e9c05488f11f53f14b3ad79a8145f638a0";

async function port() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}

async function waitFor(read) {
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    try {
      if (await read()) {
        return;
      }
    } catch {
      // Monitoring services can reject requests while their listeners start.
    }
    await delay(500);
  }
  assert.fail("Monitoring did not become ready within 60 seconds.");
}

test(
  "Prometheus remote write records real OCC traffic and Grafana provisions its dashboard",
  {
    skip:
      process.env.OCC_TEST_METRICS_MONITORING !== "1"
        ? "Set OCC_TEST_METRICS_MONITORING=1 with a Linux container runtime."
        : false,
    timeout: 180_000,
  },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "occ-metrics-monitoring-"));
    const names = [];
    t.after(async () => {
      for (const name of names.reverse()) {
        if (!t.passed) {
          const logs = await run(engine, ["logs", "--tail=20", name]).catch(() => ({
            stdout: "",
            stderr: "",
          }));
          t.diagnostic(`${name}: ${logs.stdout}${logs.stderr}`);
        }
        await run(engine, ["rm", "-f", "-v", name]);
      }
      await rm(directory, { recursive: true, force: true });
    });
    const metrics = createOccMetrics("api");
    const fixture = await createConsoleAppFixture(t, { metrics });
    const listener = await startMetricsListener(metrics, { host: "127.0.0.1", port: 0 });
    t.after(() => listener.close());
    await fixture.bootstrap();
    const promPort = await port();
    const grafanaPort = await port();
    const agentPort = await port();
    const promURL = `http://127.0.0.1:${promPort}`;
    await writeFile(
      join(directory, "prometheus.yaml"),
      await readFile("deploy/metrics/development/prometheus.yaml"),
    );
    const agentConfig = (await readFile("deploy/metrics/development/api.yaml", "utf8"))
      .replace("127.0.0.1:9464", listener.url.slice(7))
      .replace("http://prometheus:9090", promURL);
    await writeFile(join(directory, "agent.yaml"), agentConfig);
    await mkdir(join(directory, "provisioning", "datasources"), { recursive: true });
    await mkdir(join(directory, "provisioning", "dashboards"), { recursive: true });
    await mkdir(join(directory, "dashboards"));
    await writeFile(
      join(directory, "provisioning", "datasources", "occ.yaml"),
      (await readFile("deploy/metrics/development/grafana/datasources/occ.yaml", "utf8")).replace(
        "http://prometheus:9090",
        promURL,
      ),
    );
    await writeFile(
      join(directory, "provisioning", "dashboards", "occ.yaml"),
      (await readFile("deploy/metrics/development/grafana/dashboards/occ.yaml", "utf8")).replace(
        "/etc/occ-dashboard",
        "/etc/occ-test/dashboards",
      ),
    );
    await writeFile(
      join(directory, "dashboards", "occ.json"),
      await readFile("deploy/helm/openclaw-observability-demo/files/dashboard.json"),
    );

    async function container(role, image, args, extra = []) {
      const name = `occ-metrics-${role}-${randomUUID().slice(0, 8)}`;
      names.push(name);
      await run(
        engine,
        [
          "run",
          "-d",
          "--name",
          name,
          "--network",
          "host",
          ...(engine === "podman" ? ["--userns=keep-id"] : []),
          "--user",
          `${process.getuid()}:${process.getgid()}`,
          "--security-opt",
          "label=disable",
          "-v",
          `${directory}:/etc/occ-test:ro`,
          ...extra,
          image,
          ...args,
        ],
        { timeout: 60_000 },
      );
    }
    // Containers use host networking solely to reach this test's real loopback
    // listener. The checked-in Compose overlay instead shares OCC namespaces.
    await container(
      "server",
      prometheusImage,
      [
        "--config.file=/etc/occ-test/prometheus.yaml",
        "--web.enable-remote-write-receiver",
        `--web.listen-address=127.0.0.1:${promPort}`,
        "--storage.tsdb.path=/tmp/prometheus",
      ],
      ["--tmpfs", "/tmp:rw,mode=1777"],
    );
    await container(
      "agent",
      prometheusImage,
      [
        "--agent",
        "--config.file=/etc/occ-test/agent.yaml",
        `--web.listen-address=127.0.0.1:${agentPort}`,
        "--storage.agent.path=/tmp/agent",
      ],
      ["--tmpfs", "/tmp:rw,mode=1777"],
    );
    const query = async (expression) => {
      const response = await fetch(
        `${promURL}/api/v1/query?query=${encodeURIComponent(expression)}`,
      );
      const body = await response.json();
      assert.equal(body.status, "success");
      return body.data.result;
    };
    await waitFor(async () =>
      (await query('up{job="occ-api"}')).some((series) => series.value[1] === "1"),
    );
    await fixture.request("GET", "/installation");
    await waitFor(async () =>
      (await query('sum(occ_http_requests_total{route="/installation",method="GET"})')).some(
        (series) => Number(series.value[1]) >= 1,
      ),
    );
    const dashboard = JSON.parse(
      await readFile("deploy/helm/openclaw-observability-demo/files/dashboard.json", "utf8"),
    );
    // Every shipped panel must be valid PromQL, even when a quiet/absent worker
    // has no samples. A real server, not a string matcher, checks the queries.
    for (const panel of dashboard.panels) {
      await query(panel.targets[0].expr);
    }

    await container(
      "grafana",
      grafanaImage,
      [],
      [
        "--tmpfs",
        "/var/lib/grafana:rw,noexec,mode=1777",
        "--tmpfs",
        "/var/log/grafana:rw,mode=1777",
        "-e",
        "GF_PATHS_PROVISIONING=/etc/occ-test/provisioning",
        "-e",
        "GF_SERVER_HTTP_ADDR=127.0.0.1",
        "-e",
        `GF_SERVER_HTTP_PORT=${grafanaPort}`,
        "-e",
        "GF_AUTH_ANONYMOUS_ENABLED=true",
        "-e",
        "GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer",
        "-e",
        "GF_ANALYTICS_REPORTING_ENABLED=false",
        "-e",
        "GF_ANALYTICS_CHECK_FOR_UPDATES=false",
        // Keep the image's bundled plugins. Background updates replace running
        // backends with downloads that cannot execute from the data tmpfs.
        "-e",
        "GF_PLUGINS_PREINSTALL_DISABLED=true",
      ],
    );
    await waitFor(async () => (await fetch(`http://127.0.0.1:${grafanaPort}/api/health`)).ok);
    const provisioned = await fetch(
      `http://127.0.0.1:${grafanaPort}/api/dashboards/uid/occ-development`,
    ).then((response) => response.json());
    assert.equal(provisioned.dashboard.uid, "occ-development");
    assert.deepEqual(provisioned.dashboard.panels, dashboard.panels);
    // Grafana's HTTP listener can be ready before its datasource backend. Wait
    // for the actual Grafana-to-Prometheus query to succeed within the same bound.
    await waitFor(async () => {
      const response = await fetch(
        `http://127.0.0.1:${grafanaPort}/api/datasources/uid/occ-prometheus/health`,
      );
      const datasource = await response.json();
      return response.ok && datasource.status === "OK";
    });
  },
);
