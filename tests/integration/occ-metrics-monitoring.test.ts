import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import test from "node:test";
import { createOccMetrics } from "../../apps/controller/src/metrics/index.ts";
import { startMetricsListener } from "../../apps/controller/src/metrics/listener.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { failureSecrets, redactOutputLines } from "../../scripts/ci/failure-redaction.ts";
import { metricsMonitoringImages } from "../../scripts/ci/metrics-monitoring-images.ts";
import { availablePort } from "../helpers/available-port.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  checkGrafanaDatasource,
  containerLogTail,
  distinctPorts,
  portClash,
  queryPrometheus,
  waitForMonitoring,
} from "../helpers/metrics-monitoring-readiness.ts";

const run = promisify(execFile);
const engine = process.env.OCC_METRICS_TEST_ENGINE ?? "docker";
const { prometheus: prometheusImage, grafana: grafanaImage } = metricsMonitoringImages;

type ContainerRole = "server" | "agent" | "grafana";
type Container = [role: ContainerRole, name: string];
type QueryStage = "prometheus-up" | "occ-request";

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

async function containerState(name: string) {
  const { stdout } = await run(engine, ["inspect", "--format", "{{json .State}}", name], {
    timeout: 30_000,
  });
  const parsed: unknown = JSON.parse(stdout);
  const state = asRecord(parsed);
  assert(state !== undefined, "Container inspect must return a state object");
  const { Running, ExitCode } = state;
  assert(typeof Running === "boolean", "Container state must have a boolean Running field");
  assert(
    typeof ExitCode === "number" && Number.isInteger(ExitCode) && ExitCode >= 0 && ExitCode <= 255,
    "Container state must have a valid ExitCode",
  );
  return { Running, ExitCode };
}

async function readContainerLogTail(name: string, tail = 15) {
  const logs = await run(engine, ["logs", `--tail=${tail}`, name], { timeout: 30_000 }).catch(
    () => ({
      stdout: "",
      stderr: "",
    }),
  );
  const lines: unknown = containerLogTail(`${logs.stdout}${logs.stderr}`, tail);
  assert(
    isUnknownArray(lines) && lines.every((line) => typeof line === "string"),
    "Container log tail must contain only strings",
  );
  return lines;
}

function dashboardPanels(value: unknown, uid: string) {
  const dashboard = asRecord(value);
  assert(dashboard?.uid === uid, `Expected dashboard ${uid}`);
  assert(isUnknownArray(dashboard.panels), `Expected an array of panels in dashboard ${uid}`);
  return dashboard.panels;
}

function dashboardQueries(panels: readonly unknown[]) {
  return panels.flatMap((value, panelIndex) => {
    const targets = asRecord(value)?.targets;
    assert(
      isUnknownArray(targets) && targets.length > 0,
      `Expected targets in panel ${panelIndex + 1}`,
    );
    return targets.map((target, targetIndex) => {
      const expr = asRecord(target)?.expr;
      assert(
        typeof expr === "string" && expr.trim() !== "",
        `Expected PromQL in panel ${panelIndex + 1}, target ${targetIndex + 1}`,
      );
      return expr;
    });
  });
}

async function readGrafanaDashboard(origin: string, uid: string) {
  const response = await fetch(`${origin}/api/dashboards/uid/${uid}`, {
    signal: AbortSignal.timeout(3_000),
  });
  assert(response.ok, `Grafana dashboard ${uid} returned HTTP ${response.status}`);
  const body: unknown = await response.json();
  return dashboardPanels(asRecord(body)?.dashboard, uid);
}

async function querySampleValues(origin: string, stage: QueryStage, expression: string) {
  const result: unknown = await queryPrometheus(origin, stage, expression);
  assert(isUnknownArray(result), "Prometheus query must return a vector");
  return result.map((series) => {
    const sample = asRecord(series)?.value;
    assert(isUnknownArray(sample) && sample.length === 2, "Expected a Prometheus sample pair");
    const [timestamp, value] = sample;
    assert(
      typeof timestamp === "number" && Number.isFinite(timestamp) && typeof value === "string",
      "Expected a numeric timestamp and a string value in the Prometheus sample",
    );
    return value;
  });
}

// A host-network Prometheus whose port was taken exits at once; a new pair of
// ports is retried this many times in all.
const prometheusStartAttempts = 3;

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
    const names = new Map<string, ContainerRole>();
    async function removeContainer(name: string) {
      await run(engine, ["rm", "-f", "-v", name], { timeout: 60_000 });
      names.delete(name);
    }

    t.after(async () => {
      const failures: Error[] = [];
      const secrets = failureSecrets([process.env]);
      for (const [name, role] of [...names].reverse()) {
        if (!t.passed) {
          // Keep each recent line separate so the reporter retains the exit reason.
          const tail = await readContainerLogTail(name);
          for (const line of redactOutputLines(tail, secrets, process.cwd(), 1_000)) {
            if (line !== "") {
              t.diagnostic(`${role}: ${line}`);
            }
          }
        }
        try {
          await removeContainer(name);
        } catch {
          failures.push(new Error(`Could not remove ${role} container ${name}`));
        }
      }
      try {
        await rm(directory, { recursive: true, force: true });
      } catch {
        failures.push(new Error("Could not remove the monitoring configuration directory"));
      }
      if (failures.length > 0) {
        // A test body error can hide the after hook error in the reporter.
        for (const failure of failures) {
          t.diagnostic(failure.message);
        }
        throw new AggregateError(failures, "Monitoring cleanup failed");
      }
    });
    const metrics = createOccMetrics("api");
    const fixture = await createConsoleAppFixture(t, { metrics });
    const listener = await startMetricsListener(metrics, { host: "127.0.0.1", port: 0 });
    t.after(() => listener.close());
    await fixture.bootstrap();
    await writeFile(
      join(directory, "prometheus.yaml"),
      await readFile("deploy/metrics/development/prometheus.yaml"),
    );
    await mkdir(join(directory, "provisioning", "datasources"), { recursive: true });
    await mkdir(join(directory, "provisioning", "dashboards"), { recursive: true });
    await mkdir(join(directory, "dashboards"));
    // The agent and Grafana configs name the server's port; each start attempt writes them.
    async function writePrometheusConfigs(promURL: string) {
      const agentConfig = (await readFile("deploy/metrics/development/api.yaml", "utf8"))
        .replace("127.0.0.1:9464", listener.url.slice(7))
        .replace("http://prometheus:9090", promURL);
      await writeFile(join(directory, "agent.yaml"), agentConfig);
      await writeFile(
        join(directory, "provisioning", "datasources", "occ.yaml"),
        (await readFile("deploy/metrics/development/grafana/datasources/occ.yaml", "utf8")).replace(
          "http://prometheus:9090",
          promURL,
        ),
      );
    }
    await writeFile(
      join(directory, "provisioning", "dashboards", "occ.yaml"),
      (await readFile("deploy/metrics/development/grafana/dashboards/occ.yaml", "utf8")).replace(
        "/etc/occ-dashboard",
        "/etc/occ-test/dashboards",
      ),
    );
    const dashboardBytes = await readFile(
      "deploy/helm/openclaw-observability-demo/files/dashboard.json",
    );
    const dashboard: unknown = JSON.parse(dashboardBytes.toString("utf8"));
    const packagedPanels = dashboardPanels(dashboard, "occ-development");
    const expressions = dashboardQueries(packagedPanels);
    await writeFile(join(directory, "dashboards", "occ.json"), dashboardBytes);
    await writeFile(
      join(directory, "dashboards", "overview.json"),
      await readFile("deploy/metrics/development/grafana/overview-dashboard.json"),
    );

    const uid = process.getuid?.();
    const gid = process.getgid?.();
    assert(uid !== undefined && gid !== undefined, "Monitoring containers require a Unix host");
    async function container(
      role: ContainerRole,
      image: string,
      args: string[],
      extra: string[] = [],
    ) {
      const name = `occ-metrics-${role}-${randomUUID().slice(0, 8)}`;
      names.set(name, role);
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
          `${uid}:${gid}`,
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
      return name;
    }
    // Containers use host networking solely to reach this test's real loopback
    // listener. The checked-in Compose overlay instead shares OCC namespaces.
    // Both ports are picked before either container starts, so the agent's cannot
    // be one the server has not bound yet. Docker still owns the final bind, and
    // another process can take a port before then (finding 1667); the retry
    // handles that: a container that exits on "address already in use" is
    // restarted with new ports, bounded.
    async function startPrometheus() {
      for (let attempt = 1; ; attempt += 1) {
        const ports: unknown = await distinctPorts(2, availablePort);
        assert(isUnknownArray(ports), "Expected a list of Prometheus ports");
        const [promPort, agentPort] = ports;
        assert(
          typeof promPort === "number" && typeof agentPort === "number",
          "Expected two Prometheus ports",
        );
        const promURL = `http://127.0.0.1:${promPort}`;
        await writePrometheusConfigs(promURL);
        const server = await container(
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
        const agent = await container(
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
        const containers: [Container, Container] = [
          ["server", server],
          ["agent", agent],
        ];
        try {
          await waitForMonitoring(
            "prometheus-up",
            async () =>
              (await querySampleValues(promURL, "prometheus-up", 'up{job="occ-api"}')).includes(
                "1",
              ),
            containers,
            containerState,
          );
          return { promURL, containers };
        } catch (error) {
          const diagnostic = asRecord(asRecord(error)?.openclawCiDiagnostic);
          const role = diagnostic?.container;
          if (
            attempt >= prometheusStartAttempts ||
            diagnostic?.kind !== "metrics-monitoring" ||
            diagnostic.stage !== "prometheus-up" ||
            diagnostic.reason !== "container-exited" ||
            (role !== "server" && role !== "agent")
          ) {
            throw error;
          }
          const exited = role === "server" ? server : agent;
          if (!(await readContainerLogTail(exited, 50)).some(portClash)) {
            throw error;
          }
          t.diagnostic(
            `${role} could not bind its port (attempt ${attempt}): address already in use`,
          );
          await removeContainer(agent);
          await removeContainer(server);
        }
      }
    }
    const { promURL, containers } = await startPrometheus();
    const status: unknown = (await fixture.request("GET", "/installation")).status;
    assert(status === 200, "Expected the authenticated Installation request to succeed");
    await waitForMonitoring(
      "occ-request",
      async () =>
        (
          await querySampleValues(
            promURL,
            "occ-request",
            'sum(occ_http_requests_total{route="/installation",method="GET"})',
          )
        ).some((value) => Number(value) >= 1),
      containers,
      containerState,
    );
    // Prometheus validates every target, including expressions that return
    // scalars, range vectors, or histogram samples.
    for (const expression of expressions) {
      await queryPrometheus(promURL, "occ-request", expression);
    }

    const grafanaPort = await availablePort();
    const grafana = await container(
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
    const grafanaURL = `http://127.0.0.1:${grafanaPort}`;
    await waitForMonitoring(
      "grafana-health",
      async () => {
        const response = await fetch(`${grafanaURL}/api/health`, {
          signal: AbortSignal.timeout(3_000),
        });
        if (!response.ok) {
          throw Object.assign(new Error(`Grafana health returned HTTP ${response.status}`), {
            httpStatus: response.status,
          });
        }
        const body: unknown = await response.json();
        const database = asRecord(body)?.database;
        assert(typeof database === "string", "Expected Grafana health to report database status");
        return database === "ok";
      },
      [["grafana", grafana]],
      containerState,
    );
    const provisionedPanels = await readGrafanaDashboard(grafanaURL, "occ-development");
    assert(
      isDeepStrictEqual(provisionedPanels, packagedPanels),
      "Grafana must provision the packaged metrics panels",
    );
    const overviewPanels = await readGrafanaDashboard(grafanaURL, "occ-observability");
    const overview = asRecord(overviewPanels[0]);
    assert(overview?.type === "text", "Expected the Grafana overview to start with a text panel");
    const content = asRecord(overview.options)?.content;
    assert(typeof content === "string", "Expected text in the Grafana overview panel");
    assert(
      /\[Metrics\]\(\.\/d\/occ-development\)/.test(content),
      "Expected an overview link to metrics",
    );
    assert(!/occ-logs/.test(content), "The development overview must omit the logs dashboard link");
    // Grafana's HTTP listener can be ready before its datasource backend. Wait
    // for the actual Grafana-to-Prometheus query to succeed within the same bound.
    await waitForMonitoring(
      "grafana-datasource",
      () => checkGrafanaDatasource(grafanaURL),
      [["grafana", grafana], containers[0]],
      containerState,
    );
  },
);
