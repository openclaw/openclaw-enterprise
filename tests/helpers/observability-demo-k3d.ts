import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { Browser } from "playwright";
import { asRecord } from "../../packages/utils/src/index.ts";
import { run as runProcess } from "../fixtures/repository-credentials/process.mjs";
import {
  createKubernetesClient,
  createRealKubernetesFixture,
  kubectlArguments,
  validateExplicitK3dLoopbackContext,
} from "./kubernetes-real.mjs";

type CommandResult = { code: number | null; stdout: string; stderr: string };
type CommandOptions = { timeout?: number; input?: string };
type PortForward = { url: unknown; stop: () => Promise<void> };
type HttpResult = { status: number; text: string | undefined };
type PrometheusSample = { value: [unknown, string | number]; metric: { source: string } };
type LokiStream = { values: [unknown, string][] };

const severityNumbers: Readonly<Record<string, number>> = {
  INFO: 9,
  WARN: 13,
  ERROR: 17,
  FATAL: 21,
};

// The JavaScript helper infers its default environment's exact allowlist.
const runCommand = runProcess as (
  command: string,
  args: string[],
  options: CommandOptions & { env: NodeJS.ProcessEnv; allowFailure: boolean },
) => Promise<CommandResult>;

export type DemoLogOptions = {
  service?: string | undefined;
  severity?: string | undefined;
  attributes?: Record<string, string | number>;
};

function readArray(value: unknown, label: string): unknown[] {
  assert.ok(Array.isArray(value), `Expected ${label} array`);
  return value;
}

function readEndpoint(value: unknown): { ip: string; port: number } {
  const endpoint = asRecord(readArray(asRecord(value)?.subsets, "Kubernetes Endpoint subsets")[0]);
  const ip = asRecord(readArray(endpoint?.addresses, "Kubernetes Endpoint addresses")[0])?.ip;
  const port = asRecord(readArray(endpoint?.ports, "Kubernetes Endpoint ports")[0])?.port;
  assert.ok(typeof ip === "string", "Expected Kubernetes Endpoint IP");
  assert.ok(typeof port === "number", "Expected Kubernetes Endpoint port");
  return { ip, port };
}

function readPrometheusSample(row: unknown): PrometheusSample {
  const sample = asRecord(row);
  const [timestamp, value] = readArray(sample?.value, "Prometheus sample");
  const source = asRecord(sample?.metric)?.source;
  assert.ok(typeof value === "string" || typeof value === "number", "Expected Prometheus value");
  assert.ok(typeof source === "string", "Expected Prometheus source label");
  return { value: [timestamp, value], metric: { source } };
}

function readLokiStream(row: unknown): LokiStream {
  const values = readArray(asRecord(row)?.values, "Loki stream values");
  return {
    values: values.map((entry): [unknown, string] => {
      const [timestamp, line] = readArray(entry, "Loki stream entry");
      assert.ok(typeof line === "string", "Expected Loki log line");
      return [timestamp, line];
    }),
  };
}

export async function installObservabilityDemo(t: TestContext) {
  const selection = {
    kubeconfigPath: process.env.OCC_TEST_KUBERNETES_KUBECONFIG,
    kubernetesContext: process.env.OCC_TEST_KUBERNETES_CONTEXT,
  };
  await validateExplicitK3dLoopbackContext(selection);
  const { kubeconfigPath, kubernetesContext } = selection;
  assert.ok(kubeconfigPath && kubernetesContext);
  function importedImage(variable: string): string {
    const image = process.env[variable] ?? "";
    assert.match(image, /^\S+@sha256:[a-f0-9]{64}$/, `${variable} must be imported`);
    return image;
  }
  const images = {
    node: importedImage("OCC_TEST_PRODUCTION_NODE_IMAGE"),
    prometheus: importedImage("OCC_TEST_OBSERVABILITY_PROMETHEUS_IMAGE"),
    grafana: importedImage("OCC_TEST_OBSERVABILITY_GRAFANA_IMAGE"),
    loki: importedImage("OCC_TEST_OBSERVABILITY_LOKI_IMAGE"),
  };
  const suffix = randomBytes(6).toString("hex");
  const sources = `demo-sources-${suffix}`;
  const monitoring = `demo-monitor-${suffix}`;
  const release = `demo-${suffix}`;
  const sourceRelease = `fixture-${suffix}`;
  const directory = await mkdtemp(join(tmpdir(), "oce-demo-smoke-"));
  const artifacts = join(process.env.RUNNER_TEMP ?? directory, "observability-demo");
  let browser: Browser | undefined;
  let forwarding: PortForward | undefined;
  const password = randomBytes(32).toString("hex");
  const authorization = `Basic ${Buffer.from(`admin:${password}`).toString("base64")}`;
  const redact = (value: string | undefined) =>
    String(value).replaceAll(password, "[redacted]").replaceAll(authorization, "[redacted]");
  const run = async (command: "helm" | "kubectl", args: string[], options: CommandOptions = {}) => {
    const executable =
      { helm: process.env.OCC_HELM_BIN, kubectl: process.env.OCC_KUBECTL_BIN }[command] ?? command;
    const result = await runCommand(executable, args, {
      env: process.env,
      timeout: 180_000,
      ...options,
      allowFailure: true,
    });
    assert.equal(result.code, 0, redact(result.stderr));
    return result.stdout;
  };
  const kubectl = (...args: string[]) => run("kubectl", kubectlArguments(selection, args));
  const helm = (...args: string[]) =>
    run("helm", [...args, "--kubeconfig", kubeconfigPath, "--kube-context", kubernetesContext], {
      timeout: 330_000,
    });
  const kubernetes = createKubernetesClient({
    selection,
    kubectl,
    waitTimeoutMs: 120_000,
    waitIntervalMs: 1_000,
  });
  const apply = (object: object) =>
    run("kubectl", kubectlArguments(selection, ["apply", "-f", "-"]), {
      input: JSON.stringify(object),
    });
  // Register ownership before creating resources; cleanup is part of acceptance.
  t.after(async () => {
    const errors: unknown[] = [];
    for (const close of [() => browser?.close(), () => forwarding?.stop()]) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await helm(
        "uninstall",
        release,
        "-n",
        monitoring,
        "--ignore-not-found",
        "--wait",
        "--timeout",
        "120s",
      );
    } catch (error) {
      errors.push(error);
    }
    try {
      await kubectl(
        "delete",
        "namespace",
        sources,
        monitoring,
        "--ignore-not-found",
        "--wait=true",
        "--timeout=120s",
      );
    } catch (error) {
      errors.push(error);
    }
    await rm(directory, { recursive: true, force: true });
    if (errors.length) {
      throw new AggregateError(errors, "Demo smoke cleanup failed");
    }
  });
  for (const name of [sources, monitoring]) {
    await apply({ apiVersion: "v1", kind: "Namespace", metadata: { name } });
  }
  // These are protocol fixtures, not OCC processes. They publish a dedicated
  // test metric under the chart's discovery labels, exercising its real RBAC,
  // Kubernetes discovery, NetworkPolicies, scraping, and Grafana data sources.
  for (const component of ["api", "worker", "collector"]) {
    const port = component === "collector" ? 8888 : 9464;
    await apply({
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: component,
        namespace: sources,
        labels: {
          "app.kubernetes.io/name": "openclaw-enterprise",
          "app.kubernetes.io/instance": sourceRelease,
          "app.kubernetes.io/component": component,
        },
      },
      spec: {
        automountServiceAccountToken: false,
        terminationGracePeriodSeconds: 1,
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          runAsGroup: 1000,
          seccompProfile: { type: "RuntimeDefault" },
        },
        containers: [
          {
            name: "source",
            image: images.node,
            securityContext: {
              readOnlyRootFilesystem: true,
              allowPrivilegeEscalation: false,
              capabilities: { drop: ["ALL"] },
            },
            command: [
              "node",
              "-e",
              `require('node:http').createServer((q,r)=>{r.setHeader('Content-Type','text/plain; version=0.0.4');r.end('# TYPE demo_smoke_value gauge\\ndemo_smoke_value{source="${component}"} 1\\n')}).listen(${port},'0.0.0.0')`,
            ],
            ports: [{ name: "metrics", containerPort: port }],
            readinessProbe: { httpGet: { path: "/metrics", port: "metrics" }, periodSeconds: 1 },
            resources: {
              requests: { cpu: "10m", memory: "32Mi" },
              limits: { cpu: "500m", memory: "128Mi" },
            },
          },
        ],
      },
    });
  }
  await kubectl("-n", sources, "wait", "--for=condition=Ready", "pods", "--all", "--timeout=180s");
  await apply({
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "grafana-admin", namespace: monitoring },
    stringData: { password },
  });
  const endpoints: unknown = await kubernetes.resource("endpoints", "kubernetes", "default");
  const endpoint = readEndpoint(endpoints);
  const values = {
    images: { prometheus: images.prometheus, grafana: images.grafana, loki: images.loki },
    occ: { namespace: sources, release: sourceRelease, metricsPort: 9464 },
    cluster: { cidrs: [`${endpoint.ip}/32`], port: endpoint.port },
    grafana: {
      adminSecretName: "grafana-admin",
      clients: [{ namespace: sources, podLabels: { "app.kubernetes.io/component": "collector" } }],
    },
  };
  const valuesFile = join(directory, "values.json");
  await writeFile(valuesFile, JSON.stringify(values), { mode: 0o600 });
  await helm(
    "upgrade",
    "--install",
    release,
    "deploy/helm/openclaw-observability-demo",
    "-n",
    monitoring,
    "-f",
    valuesFile,
    "--wait",
    "--timeout",
    "300s",
  );
  const request = async (url: string, options: RequestInit = {}): Promise<HttpResult> => {
    const stdout = await run(
      "kubectl",
      kubectlArguments(selection, [
        "-n",
        sources,
        "exec",
        "-i",
        "collector",
        "--",
        "node",
        "--input-type=module",
        "-e",
        `
      import fs from 'node:fs';
      const {url,options}=JSON.parse(fs.readFileSync(0,'utf8'));
      try { const r=await fetch(url,{...options,signal:AbortSignal.timeout(10000)}); console.log(JSON.stringify({status:r.status,text:await r.text()})); }
      catch { console.log(JSON.stringify({status:0})); }
    `,
      ]),
      { input: JSON.stringify({ url, options }) },
    );
    const result = asRecord(JSON.parse(stdout));
    const status = result?.status;
    const text = result?.text;
    assert.ok(typeof status === "number", "Expected in-Pod HTTP status");
    assert.ok(text === undefined || typeof text === "string", "Expected in-Pod HTTP response text");
    return { status, text };
  };
  const grafana = (path: string) =>
    request(`http://${release}-grafana.${monitoring}.svc:3000${path}`, {
      headers: { authorization },
    });
  async function query(source: "prometheus", path: string): Promise<PrometheusSample[]>;
  async function query(source: "loki", path: string): Promise<LokiStream[]>;
  async function query(source: "prometheus" | "loki", path: string) {
    const result = await grafana(`/api/datasources/proxy/uid/occ-${source}${path}`);
    assert.equal(result.status, 200, redact(result.text));
    assert.ok(result.text !== undefined, "Expected Grafana datasource response text");
    const data = asRecord(asRecord(JSON.parse(result.text))?.data);
    const rows = readArray(data?.result, `${source} results`);
    return source === "prometheus" ? rows.map(readPrometheusSample) : rows.map(readLokiStream);
  }
  const waitFor: (
    description: string,
    operation: () => unknown,
    timeoutMs?: number,
  ) => Promise<unknown> = kubernetes.waitFor;
  return {
    waitFor,
    grafana,
    artifacts,
    async openBrowser() {
      // Reuse the native loopback-only forward and its bounded process cleanup.
      forwarding = await createRealKubernetesFixture({
        ...selection,
        gatewayImage: undefined,
        codexImage: undefined,
        databaseUrl: undefined,
      }).startPortForwardTarget(monitoring, `service/${release}-grafana`, "0:3000");
      const { url } = forwarding;
      assert.ok(typeof url === "string", "Expected Grafana port-forward URL");
      const { chromium } = await import("playwright");
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
      const login = await context.request.post(`${url}/login`, {
        data: { user: "admin", password },
      });
      assert.equal(login.status(), 200, "Grafana browser login failed");
      await mkdir(artifacts, { recursive: true });
      return { page: await context.newPage(), url };
    },
    query,
    async exportLog(
      body: string,
      { service = "demo-smoke", severity = "INFO", attributes = {} }: DemoLogOptions = {},
    ) {
      // Exercise Loki's actual OTLP endpoint; no Collector build or OCC lifecycle
      // is needed to prove this chart's ingestion and Grafana query connections.
      const result = await request(`http://${release}-loki.${monitoring}.svc:3100/otlp/v1/logs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resourceLogs: [
            {
              resource: {
                attributes: [{ key: "service.name", value: { stringValue: service } }],
              },
              scopeLogs: [
                {
                  scope: { name: "demo-smoke" },
                  logRecords: [
                    {
                      timeUnixNano: `${BigInt(Date.now()) * 1_000_000n}`,
                      severityNumber: severityNumbers[severity],
                      severityText: severity,
                      body: { stringValue: body },
                      attributes: Object.entries(attributes).map(([key, value]) => ({
                        key,
                        value:
                          typeof value === "number"
                            ? { doubleValue: value }
                            : { stringValue: value },
                      })),
                    },
                  ],
                },
              ],
            },
          ],
        }),
      });
      assert.equal(result.status, 204, redact(result.text));
    },
  };
}
