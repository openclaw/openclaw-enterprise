import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as runProcess } from "../fixtures/repository-credentials/process.mjs";
import {
  createKubernetesClient,
  kubectlArguments,
  validateExplicitK3dLoopbackContext,
} from "./kubernetes-real.mjs";

export async function installObservabilityDemo(t) {
  const selection = {
    kubeconfigPath: process.env.OCC_TEST_KUBERNETES_KUBECONFIG,
    kubernetesContext: process.env.OCC_TEST_KUBERNETES_CONTEXT,
  };
  await validateExplicitK3dLoopbackContext(selection);
  const images = Object.fromEntries(
    [
      ["node", "OCC_TEST_PRODUCTION_NODE_IMAGE"],
      ["prometheus", "OCC_TEST_OBSERVABILITY_PROMETHEUS_IMAGE"],
      ["grafana", "OCC_TEST_OBSERVABILITY_GRAFANA_IMAGE"],
      ["loki", "OCC_TEST_OBSERVABILITY_LOKI_IMAGE"],
    ].map(([role, variable]) => {
      assert.match(
        process.env[variable] ?? "",
        /^\S+@sha256:[a-f0-9]{64}$/,
        `${variable} must be imported`,
      );
      return [role, process.env[variable]];
    }),
  );
  const suffix = randomBytes(6).toString("hex");
  const sources = `demo-sources-${suffix}`;
  const monitoring = `demo-monitor-${suffix}`;
  const release = `demo-${suffix}`;
  const sourceRelease = `fixture-${suffix}`;
  const directory = await mkdtemp(join(tmpdir(), "oce-demo-smoke-"));
  const password = randomBytes(32).toString("hex");
  const authorization = `Basic ${Buffer.from(`admin:${password}`).toString("base64")}`;
  const redact = (value) =>
    String(value).replaceAll(password, "[redacted]").replaceAll(authorization, "[redacted]");
  const run = async (command, args, options = {}) => {
    const executable =
      { helm: process.env.OCC_HELM_BIN, kubectl: process.env.OCC_KUBECTL_BIN }[command] ?? command;
    const result = await runProcess(executable, args, {
      env: process.env,
      timeout: 180_000,
      ...options,
      allowFailure: true,
    });
    assert.equal(result.code, 0, redact(result.stderr));
    return result.stdout;
  };
  const kubectl = (...args) => run("kubectl", kubectlArguments(selection, args));
  const helm = (...args) =>
    run(
      "helm",
      [
        ...args,
        "--kubeconfig",
        selection.kubeconfigPath,
        "--kube-context",
        selection.kubernetesContext,
      ],
      { timeout: 330_000 },
    );
  const kubernetes = createKubernetesClient({
    selection,
    kubectl,
    waitTimeoutMs: 120_000,
    waitIntervalMs: 1_000,
  });
  const apply = (object) =>
    run("kubectl", kubectlArguments(selection, ["apply", "-f", "-"]), {
      input: JSON.stringify(object),
    });
  // Register ownership before creating resources; cleanup is part of acceptance.
  t.after(async () => {
    const errors = [];
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
  const endpoint = (await kubernetes.resource("endpoints", "kubernetes", "default")).subsets[0];
  const values = {
    images: { prometheus: images.prometheus, grafana: images.grafana, loki: images.loki },
    occ: { namespace: sources, release: sourceRelease, metricsPort: 9464 },
    cluster: { cidrs: [`${endpoint.addresses[0].ip}/32`], port: endpoint.ports[0].port },
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
  const request = async (url, options = {}) =>
    JSON.parse(
      await run(
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
      ),
    );
  const grafana = (path) =>
    request(`http://${release}-grafana.${monitoring}.svc:3000${path}`, {
      headers: { authorization },
    });
  return {
    waitFor: kubernetes.waitFor,
    grafana,
    async query(source, path) {
      const result = await grafana(`/api/datasources/proxy/uid/occ-${source}${path}`);
      assert.equal(result.status, 200, redact(result.text));
      return JSON.parse(result.text).data.result;
    },
    async exportLog(body) {
      // Exercise Loki's actual OTLP endpoint; no Collector build or OCC lifecycle
      // is needed to prove this chart's ingestion and Grafana query connections.
      const result = await request(`http://${release}-loki.${monitoring}.svc:3100/otlp/v1/logs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resourceLogs: [
            {
              resource: {
                attributes: [{ key: "service.name", value: { stringValue: "demo-smoke" } }],
              },
              scopeLogs: [
                {
                  scope: { name: "demo-smoke" },
                  logRecords: [
                    {
                      timeUnixNano: `${BigInt(Date.now()) * 1_000_000n}`,
                      severityNumber: 9,
                      severityText: "INFO",
                      body: { stringValue: body },
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
