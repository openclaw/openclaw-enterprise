import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as runProcess } from "../fixtures/repository-credentials/process.mjs";
import { installProductionHelmControlPlane } from "./production-helm-real.mjs";
import { createHarnessConfiguration } from "./harness-configuration.mjs";
import {
  createKubernetesClient,
  createKubernetesInstallationConfiguration,
  kubectlArguments,
  validateExplicitK3dLoopbackContext,
} from "./kubernetes-real.mjs";

export const observabilitySelection = {
  skip:
    process.env.OCC_TEST_PRODUCTION_OBSERVABILITY === "1"
      ? false
      : "Select k3d-observability with the CI runner; see docs/testing/metrics.md.",
  timeout: 1_200_000,
};

// Own only test resources. API calls, lifecycle, telemetry and policy enforcement
// all use the installed production implementations, with a credential-free runtime fixture.
export async function installObservabilityControlPlane(t, { modelTurns = false } = {}) {
  if (modelTurns) {
    for (const name of ["OPENAI_API_KEY", "OCC_TEST_OPENAI_MODEL"]) {
      assert.ok(process.env[name], `${name} is required for explicit model-turn validation`);
    }
  }
  const selection = {
    kubeconfigPath: process.env.OCC_TEST_KUBERNETES_KUBECONFIG,
    kubernetesContext: process.env.OCC_TEST_KUBERNETES_CONTEXT,
  };
  await validateExplicitK3dLoopbackContext(selection);
  const images = Object.fromEntries(
    [
      ["controller", "OCC_TEST_PRODUCTION_CONTROLLER_IMAGE"],
      ["postgres", "OCC_TEST_PRODUCTION_POSTGRES_IMAGE"],
      ["node", "OCC_TEST_PRODUCTION_NODE_IMAGE"],
      ...(modelTurns
        ? [
            ["runtime", "OCC_TEST_KUBERNETES_GATEWAY_IMAGE"],
            ["codex", "OCC_TEST_KUBERNETES_AGENT_IMAGE"],
          ]
        : [
            ["runtime", "OCC_TEST_KUBERNETES_IMAGE"],
            ["collector", "OCC_TEST_OBSERVABILITY_COLLECTOR_IMAGE"],
          ]),
    ].map(([name, variable]) => {
      assert.match(
        process.env[variable] ?? "",
        /^\S+@sha256:[a-f0-9]{64}$/,
        `${variable} requires an imported immutable image`,
      );
      return [name, process.env[variable]];
    }),
  );
  const suffix = randomBytes(4).toString("hex");
  const system = `oce-observe-${suffix}`;
  const monitoring = `oce-monitor-${suffix}`;
  const foreign = `oce-other-${suffix}`;
  const release = `obs-${suffix}`;
  const directory = await mkdtemp(join(tmpdir(), "oce-observability-"));
  const secrets = modelTurns ? [process.env.OPENAI_API_KEY] : [];
  const secret = () => {
    const value = randomBytes(32).toString("hex");
    secrets.push(value);
    return value;
  };
  const redact = (value) =>
    secrets.reduce((text, item) => text.replaceAll(item, "[redacted]"), String(value));
  const run = async (command, args, options = {}) => {
    const executable =
      { helm: process.env.OCC_HELM_BIN, kubectl: process.env.OCC_KUBECTL_BIN }[command] ?? command;
    const result = await runProcess(executable, args, {
      env: process.env,
      timeout: 180_000,
      ...options,
      allowFailure: true,
    });
    assert.equal(result.code, 0, redact(`${command}: ${result.stderr}`));
    return result.stdout;
  };
  const kubectl = (...args) => run("kubectl", kubectlArguments(selection, args));
  const kubernetes = createKubernetesClient({
    selection,
    kubectl,
    waitTimeoutMs: 180_000,
    waitIntervalMs: 1_000,
  });
  const { waitFor } = kubernetes;
  const namespaces = [system, monitoring, foreign];
  const metadata = (name, namespace = system, labels = {}) => ({
    name,
    namespace,
    labels: { "oce-test": suffix, ...labels },
  });
  const apply = (object) =>
    run("kubectl", kubectlArguments(selection, ["apply", "-f", "-"]), {
      input: JSON.stringify(object),
    });
  const get = (kind, name, namespace = system) => kubernetes.resource(kind, name, namespace);
  const record = (message) => t.diagnostic(message);
  t.after(async () => {
    // Register ownership before creation; cleanup failures must fail acceptance.
    const errors = [];
    try {
      await run("helm", [
        "uninstall",
        release,
        "-n",
        system,
        "--kubeconfig",
        selection.kubeconfigPath,
        "--kube-context",
        selection.kubernetesContext,
        "--ignore-not-found",
        "--wait",
        "--timeout",
        "120s",
      ]);
    } catch (error) {
      errors.push(error);
    }
    try {
      await kubectl(
        "delete",
        "namespace",
        ...namespaces,
        "--ignore-not-found",
        "--wait=true",
        "--timeout=120s",
      );
    } catch (error) {
      errors.push(error);
    }
    await rm(directory, { recursive: true, force: true });
    if (errors.length) {
      throw new AggregateError(errors, "observability resource cleanup failed");
    }
  });
  for (const name of namespaces) {
    await apply({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name, labels: { "oce-test": suffix } },
    });
  }
  const configuration = createKubernetesInstallationConfiguration({
    authentication: { mode: "inCluster" },
    platformNamespace: system,
    gatewayImage: images.runtime,
    codexImage: images.codex ?? images.runtime,
    ...(modelTurns
      ? { codexSeccompProfile: process.env.OCC_TEST_KUBERNETES_CODEX_SECCOMP_PROFILE }
      : {}),
    cluster: `observability-${suffix}`,
  });
  await installProductionHelmControlPlane({
    selection,
    images,
    namespace: system,
    release,
    directory,
    suffix,
    configuration,
    authBaseURL: "https://observability.example.invalid",
    installationName: "Observability acceptance",
    databaseName: `openclaw_k8s_observability_${suffix}`,
    apiClients: [{ namespace: system, podLabels: { app: "operator" } }],
    run,
    kubernetes,
    createSecretValue: secret,
    record,
  });
  const values = JSON.parse(await readFile(join(directory, "values.json"), "utf8"));
  async function upgrade(patch) {
    Object.assign(values, patch);
    await writeFile(join(directory, "values.json"), JSON.stringify(values), { mode: 0o600 });
    await run(
      "helm",
      [
        "upgrade",
        release,
        "deploy/helm/openclaw-enterprise",
        "-n",
        system,
        "--kubeconfig",
        selection.kubeconfigPath,
        "--kube-context",
        selection.kubernetesContext,
        "-f",
        join(directory, "values.json"),
        "--wait",
        "--timeout",
        "300s",
      ],
      { timeout: 330_000 },
    );
  }
  const securityContext = {
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
    readOnlyRootFilesystem: true,
  };
  async function probePod(name, namespace, labels, bootstrap = false) {
    await apply({
      apiVersion: "v1",
      kind: "Pod",
      metadata: metadata(name, namespace, labels),
      spec: {
        automountServiceAccountToken: false,
        terminationGracePeriodSeconds: 1,
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          runAsGroup: 1000,
          fsGroup: 1000,
          seccompProfile: { type: "RuntimeDefault" },
        },
        containers: [
          {
            name: "node",
            image: images.node,
            securityContext,
            command: [
              "node",
              "-e",
              "require('node:http').createServer((q,r)=>r.end('probe')).listen(3100,'0.0.0.0')",
            ],
            resources: {
              requests: { cpu: "10m", memory: "32Mi" },
              limits: { cpu: "500m", memory: "128Mi" },
            },
            ...(bootstrap
              ? { volumeMounts: [{ name: "bootstrap", mountPath: "/bootstrap", readOnly: true }] }
              : {}),
          },
        ],
        ...(bootstrap
          ? {
              volumes: [
                { name: "bootstrap", persistentVolumeClaim: { claimName: "bootstrap-password" } },
              ],
            }
          : {}),
      },
    });
    await kubectl(
      "-n",
      namespace,
      "wait",
      "--for=condition=Ready",
      `pod/${name}`,
      "--timeout=180s",
    );
  }
  // Independent probe Pods can become ready together; settle all creation before
  // a failure triggers namespace cleanup.
  const probes = await Promise.allSettled([
    probePod(
      "operator",
      system,
      { app: "operator", "app.kubernetes.io/name": "approved-gateway-client" },
      true,
    ),
    probePod("scraper", monitoring, { app: "scraper" }),
    probePod("wrong-pod", monitoring, { app: "wrong" }),
    probePod("wrong-namespace", foreign, { app: "scraper" }),
  ]);
  for (const result of probes) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }
  async function node(pod, namespace, script, input) {
    return run(
      "kubectl",
      kubectlArguments(selection, [
        "-n",
        namespace,
        "exec",
        "-i",
        pod,
        "--",
        "node",
        "--input-type=module",
        "-e",
        script,
      ]),
      { input: JSON.stringify(input) },
    );
  }
  async function request(method, path, body, authenticated = true) {
    const result = JSON.parse(
      await node(
        "operator",
        system,
        `
      import fs from 'node:fs';
      const input=JSON.parse(fs.readFileSync(0,'utf8'));
      const headers=input.body===undefined?{}:{'content-type':'application/json'};
      if(input.authenticated)headers['x-api-key']=JSON.parse(fs.readFileSync('/bootstrap/initial-admin-service-key.json','utf8')).data.key;
      const r=await fetch(input.url,{method:input.method,headers,body:input.body===undefined?undefined:JSON.stringify(input.body),signal:AbortSignal.timeout(15000)});
      console.log(JSON.stringify({status:r.status,requestId:r.headers.get('x-request-id'),body:await r.json()}));
    `,
        {
          url: `http://openclaw-enterprise-api.${system}.svc:8080${path}`,
          method,
          body,
          authenticated,
        },
      ),
    );
    for (const value of secrets) {
      assert.ok(!JSON.stringify(result).includes(value), "API response contains private input");
    }
    return result;
  }
  const api = async (method, path, body, status = 200) => {
    const result = await request(method, path, body);
    assert.equal(result.status, status, redact(JSON.stringify(result.body)));
    return result.body.data;
  };
  const scrape = async (pod, namespace, url, headers = {}) =>
    JSON.parse(
      await node(
        pod,
        namespace,
        `
    import fs from 'node:fs';const input=JSON.parse(fs.readFileSync(0,'utf8'));
    try { const r=await fetch(input.url,{headers:input.headers,signal:AbortSignal.timeout(3000)});console.log(JSON.stringify({status:r.status,text:await r.text()})); }
    catch { console.log(JSON.stringify({status:0})); }
  `,
        { url, headers },
      ),
    );
  const pods = (component) =>
    kubernetes.resources(
      "pods",
      system,
      "-l",
      `app.kubernetes.io/instance=${release},app.kubernetes.io/component=${component}`,
    );
  const currentPod = async (component) =>
    waitFor(`${component} ready`, async () =>
      (await pods(component)).find(
        (pod) =>
          !pod.metadata.deletionTimestamp &&
          pod.status.conditions?.some(
            (condition) => condition.type === "Ready" && condition.status === "True",
          ),
      ),
    );
  const selectors = {
    scraperNamespaceLabels: { "kubernetes.io/metadata.name": monitoring },
    scraperPodLabels: { app: "scraper" },
  };
  async function createAgent(executionMode = "embedded") {
    const namespace = await api("POST", "/namespaces", { name: `Observability ${suffix}` }, 201);
    const placements = [];
    // Namespace readiness now requires scoped grants in both managed targets,
    // even when this scenario uses an embedded runtime in the data namespace.
    for (const label of ["openclaw.dev/namespace", "openclaw.dev/gateway-namespace"]) {
      const target = await waitFor(
        `backing namespace for ${label}`,
        async () =>
          JSON.parse(
            await kubectl("get", "namespaces", "-l", `${label}=${namespace.id}`, "-o", "json"),
          ).items[0]?.metadata.name,
      );
      namespaces.push(target);
      placements.push(target);
      for (const [name, role, account] of [
        ["worker", "worker", "worker"],
        ["configuration", "configuration", "api"],
        ["secrets", "api", "api"],
      ]) {
        await apply({
          apiVersion: "rbac.authorization.k8s.io/v1",
          kind: "RoleBinding",
          metadata: metadata(name, target),
          roleRef: {
            apiGroup: "rbac.authorization.k8s.io",
            kind: "ClusterRole",
            name: `${release}-openclaw-tenant-${role}`,
          },
          subjects: [
            { kind: "ServiceAccount", name: `openclaw-enterprise-${account}`, namespace: system },
          ],
        });
      }
    }
    const [tenant, gatewayRuntimeNamespace] = placements;
    const gatewayPlacement = executionMode === "dedicated" ? gatewayRuntimeNamespace : tenant;
    await waitFor(
      "Namespace ready",
      async () => (await api("GET", `/namespaces/${namespace.id}`)).status === "ready",
    );
    const sentinel = modelTurns ? process.env.OPENAI_API_KEY : `fixture-only-${secret()}`;
    secrets.push(sentinel);
    const credential = await api(
      "POST",
      `/namespaces/${namespace.id}/secrets`,
      { name: "Fixture credential", value: sentinel },
      201,
    );
    const native = createHarnessConfiguration(
      executionMode === "dedicated" ? "codex" : "openclaw",
      modelTurns ? process.env.OCC_TEST_OPENAI_MODEL.replace(/^(?:openai|codex)\//, "") : "gpt-4.1",
    );
    native.agents.defaults.skipBootstrap = true;
    const config = await api(
      "POST",
      `/namespaces/${namespace.id}/configurations`,
      { kind: "agent", values: native },
      201,
    );
    const agent = await api(
      "POST",
      `/namespaces/${namespace.id}/agents`,
      {
        name: `Private content ${suffix}`,
        configurationId: config.id,
        executionMode,
        harnessAuth: {
          method: "api_key",
          source: { kind: "secret", namespaceId: namespace.id, id: credential.id },
        },
      },
      201,
    );
    const role = await api(
      "POST",
      `/namespaces/${namespace.id}/iam/roles`,
      {
        name: "Fixture model access",
        permissions: [{ action: "operate", resourceKind: "secret" }],
      },
      201,
    );
    await api(
      "POST",
      `/namespaces/${namespace.id}/iam/access-bindings`,
      {
        subjectKind: "identity",
        subjectId: agent.servicePrincipalId,
        roleId: role.id,
        resourceKind: "secret",
        resourceId: credential.id,
      },
      201,
    );
    const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
    // The regular manual Agent workflow provisions platform-owned transport
    // credentials before admitting the first revision.
    await api("POST", `${path}/runtime-credentials`, {});
    const deploy = async () => {
      const revision = await api("POST", `${path}/deploy`, undefined, 202);
      await waitFor(
        "Agent revision active",
        async () => (await api("GET", path)).activeRevisionId === revision.id,
      );
      return revision;
    };
    const stop = async () => {
      await api("POST", `${path}/stop`, undefined, 202);
      await waitFor("Agent stopped", async () => !(await api("GET", path)).activeRevisionId);
    };
    return {
      namespace,
      tenant,
      gatewayPlacement,
      agent,
      path,
      deploy,
      stop,
      forbidden: [sentinel, agent.name],
    };
  }
  const createSecret = (name, stringData, namespace = system) =>
    apply({ apiVersion: "v1", kind: "Secret", metadata: metadata(name, namespace), stringData });
  async function configureCollector(exporter, endpoint, scraperSelectors = selectors) {
    const data = {};
    for (const name of ["collector.yaml", "kubernetes.yaml", "exporter.yaml"]) {
      data[name] = await readFile(`deploy/logging/${name}`, "utf8");
    }
    await createSecret("occ-otel-collector-config", data);
    await createSecret("occ-otel-collector-exporter", {
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: endpoint,
    });
    await upgrade({
      metrics: { ...scraperSelectors },
      logging: {
        collector: {
          enabled: true,
          image: images.collector,
          exporter,
          metrics: { enabled: true, ...scraperSelectors },
        },
      },
    });
    await kubectl(
      "-n",
      system,
      "rollout",
      "status",
      "daemonset/openclaw-enterprise-collector",
      "--timeout=180s",
    );
  }
  async function installLogReceiver() {
    // Use the already-imported Collector as a real OTLP receiver. Its file
    // exporter exposes decoded records without installing a storage/query stack.
    await apply({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: metadata("otlp-receiver", monitoring),
      data: {
        "receiver.yaml": `receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  file:
    path: /records/logs.jsonl
service:
  telemetry:
    logs:
      level: error
  pipelines:
    logs:
      receivers: [otlp]
      exporters: [file]
`,
      },
    });
    await apply({
      apiVersion: "v1",
      kind: "Pod",
      metadata: metadata("otlp-receiver", monitoring, { app: "otlp-receiver" }),
      spec: {
        automountServiceAccountToken: false,
        terminationGracePeriodSeconds: 1,
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          runAsGroup: 1000,
          fsGroup: 1000,
          seccompProfile: { type: "RuntimeDefault" },
        },
        containers: [
          {
            name: "reader",
            image: images.node,
            securityContext,
            command: ["node", "-e", "setInterval(()=>{},1000)"],
            resources: {
              requests: { cpu: "10m", memory: "32Mi" },
              limits: { cpu: "500m", memory: "128Mi" },
            },
            volumeMounts: [{ name: "records", mountPath: "/records", readOnly: true }],
          },
          {
            name: "receiver",
            image: images.collector,
            securityContext,
            args: ["--config=/config/receiver.yaml"],
            readinessProbe: { tcpSocket: { port: 4318 }, periodSeconds: 1 },
            resources: {
              requests: { cpu: "50m", memory: "64Mi" },
              limits: { cpu: "500m", memory: "256Mi" },
            },
            volumeMounts: [
              { name: "config", mountPath: "/config", readOnly: true },
              { name: "records", mountPath: "/records" },
            ],
          },
        ],
        volumes: [
          { name: "config", configMap: { name: "otlp-receiver" } },
          { name: "records", emptyDir: { sizeLimit: "32Mi" } },
        ],
      },
    });
    await apply({
      apiVersion: "v1",
      kind: "Service",
      metadata: metadata("otlp-receiver", monitoring),
      spec: { selector: { app: "otlp-receiver" }, ports: [{ port: 4318, targetPort: 4318 }] },
    });
    await kubectl(
      "-n",
      monitoring,
      "wait",
      "--for=condition=Ready",
      "pod/otlp-receiver",
      "--timeout=180s",
    );
    await configureCollector(
      {
        cidr: "",
        namespaceLabels: { "kubernetes.io/metadata.name": monitoring },
        podLabels: { app: "otlp-receiver" },
        port: 4318,
      },
      `http://otlp-receiver.${monitoring}.svc:4318/v1/logs`,
    );
    return async () =>
      JSON.parse(
        await node(
          "otlp-receiver",
          monitoring,
          `
      import fs from 'node:fs';
      const text=fs.existsSync('/records/logs.jsonl')?fs.readFileSync('/records/logs.jsonl','utf8'):'';
      // Only complete lines are records; a concurrent exporter write may be partial.
      console.log(JSON.stringify(text.split('\\n').slice(0,-1).filter(Boolean).map(JSON.parse)));
    `,
        ),
      );
  }
  return {
    selection,
    images,
    suffix,
    system,
    monitoring,
    foreign,
    release,
    directory,
    secrets,
    run,
    kubectl,
    kubernetes,
    waitFor,
    metadata,
    apply,
    get,
    upgrade,
    values,
    node,
    request,
    api,
    scrape,
    pods,
    currentPod,
    probePod,
    selectors,
    createAgent,
    createSecret,
    configureCollector,
    installLogReceiver,
    record,
  };
}
