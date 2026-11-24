import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Type, { type Static } from "typebox";
import { Check } from "typebox/value";

import { namedChartResource } from "../helpers/production-chart-resource.ts";
import {
  parseProductionChart,
  productionCollectorValues as loggingValues,
  renderProductionChart as render,
  type ChartValues,
} from "../helpers/production-chart.ts";

const chartResource = Type.Intersect([
  namedChartResource,
  Type.Object({
    metadata: Type.Object({ labels: Type.Optional(Type.Record(Type.String(), Type.String())) }),
  }),
]);

const collectorPod = Type.Object({
  containers: Type.Array(
    Type.Object({
      image: Type.String(),
      envFrom: Type.Optional(Type.Unknown()),
      env: Type.Optional(Type.Unknown()),
      ports: Type.Optional(Type.Unknown()),
      securityContext: Type.Object({
        allowPrivilegeEscalation: Type.Optional(Type.Boolean()),
        readOnlyRootFilesystem: Type.Optional(Type.Boolean()),
        capabilities: Type.Object({ drop: Type.Optional(Type.Array(Type.String())) }),
      }),
      resources: Type.Optional(Type.Unknown()),
      volumeMounts: Type.Array(Type.Object({ name: Type.String(), mountPath: Type.String() })),
    }),
  ),
  securityContext: Type.Object({
    runAsNonRoot: Type.Optional(Type.Boolean()),
    supplementalGroups: Type.Optional(Type.Array(Type.Number())),
  }),
  volumes: Type.Array(
    Type.Object({
      name: Type.String(),
      hostPath: Type.Optional(Type.Unknown()),
      emptyDir: Type.Optional(Type.Unknown()),
      secret: Type.Optional(Type.Object({ secretName: Type.String() })),
    }),
  ),
});
const namedContainers = Type.Array(Type.Object({ name: Type.String() }));
const resourceShapes = {
  ServiceAccount: Type.Object({ automountServiceAccountToken: Type.Optional(Type.Boolean()) }),
  DaemonSet: Type.Object({ spec: Type.Object({ template: Type.Object({ spec: collectorPod }) }) }),
  Job: Type.Object({
    spec: Type.Object({
      template: Type.Object({
        spec: Type.Object({ initContainers: namedContainers, containers: namedContainers }),
      }),
    }),
  }),
  ClusterRole: Type.Object({
    rules: Type.Array(Type.Object({ resources: Type.Optional(Type.Array(Type.String())) })),
  }),
  NetworkPolicy: Type.Object({
    spec: Type.Object({
      egress: Type.Optional(
        Type.Array(
          Type.Object({
            to: Type.Optional(
              Type.Array(
                Type.Object({ ipBlock: Type.Optional(Type.Object({ cidr: Type.String() })) }),
              ),
            ),
          }),
        ),
      ),
      ingress: Type.Optional(Type.Unknown()),
    }),
  }),
};
const collectorConfig = Type.Object({
  receivers: Type.Object({
    filelog: Type.Object({
      include: Type.Array(Type.String()),
      exclude: Type.Array(Type.String()),
    }),
  }),
});
type ChartResource = Static<typeof chartResource>;

async function chartResources(manifests: string): Promise<ChartResource[]> {
  const documents = await parseProductionChart(manifests);
  assert.ok(Check(Type.Array(chartResource), documents), "Expected named Helm resources");
  return documents;
}

function findResource<Kind extends keyof typeof resourceShapes>(
  resources: readonly ChartResource[],
  kind: Kind,
  matches: (object: ChartResource) => boolean,
): ChartResource & Static<(typeof resourceShapes)[Kind]> {
  const resource = resources.find((object) => object.kind === kind && matches(object));
  assert.ok(Check(resourceShapes[kind], resource), `Expected chart to render a ${kind}`);
  return resource;
}

function hasComponent(component: string) {
  return ({ metadata }: ChartResource) =>
    metadata.labels?.["app.kubernetes.io/component"] === component;
}

function helmRefusal(error: unknown): error is Error & { code: number; stderr: string } {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "number" &&
    error.code !== 0 &&
    "stderr" in error &&
    typeof error.stderr === "string"
  );
}

function globExpression(pattern: string) {
  // filelog's `*` never crosses a path separator.
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*");
  return new RegExp(`^${escaped}$`);
}

// A Job's Pod gets `generateName: <job>-`; the API server cuts that prefix to
// 58 characters (names.MaxGeneratedNameLength) before adding 5 random ones.
function jobPodName(jobName: string) {
  return `${`${jobName}-`.slice(0, 58)}x7k2q`;
}

type HelmRefusalCase = Readonly<{
  description: string;
  values: ChartValues;
  expectedDiagnostic: string;
}>;

export async function productionHelmLoggingCollector() {
  const disabled = await render();
  assert.equal(disabled.stdout.includes("openclaw-enterprise-collector"), false);

  const { stdout } = await render(loggingValues);
  const rendered = await chartResources(stdout);
  const serviceAccount = findResource(rendered, "ServiceAccount", hasComponent("collector"));
  const daemonSet = findResource(rendered, "DaemonSet", hasComponent("collector"));
  const initialization = findResource(rendered, "Job", hasComponent("initialization"));
  const pod = daemonSet.spec.template.spec;
  const container = pod.containers[0];
  assert.ok(container);

  assert.equal(serviceAccount.automountServiceAccountToken, true);
  assert.equal(container.image, loggingValues["logging.collector.image"]);
  assert.deepEqual(container.envFrom, [{ secretRef: { name: "occ-otel-collector-exporter" } }]);
  assert.deepEqual(container.env, [
    { name: "K8S_NODE_NAME", valueFrom: { fieldRef: { fieldPath: "spec.nodeName" } } },
  ]);
  assert.deepEqual(container.ports, [{ name: "metrics", containerPort: 8888 }]);
  assert.equal(pod.securityContext.runAsNonRoot, true);
  assert.deepEqual(pod.securityContext.supplementalGroups, [0]);
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(container.securityContext.capabilities.drop, ["ALL"]);
  assert.deepEqual(container.resources, {
    requests: { cpu: "100m", memory: "128Mi" },
    limits: { cpu: "500m", memory: "384Mi" },
  });
  assert.deepEqual(
    container.volumeMounts.find(({ name }) => name === "pod-logs"),
    {
      name: "pod-logs",
      mountPath: "/var/log/pods",
      readOnly: true,
    },
  );
  assert.equal(
    container.volumeMounts.some(({ name }) => name === "container-logs"),
    false,
  );
  assert.equal(
    container.volumeMounts.some(({ name }) => name === "docker-containers"),
    false,
  );
  assert.ok(
    container.volumeMounts.some(({ name, mountPath }) => {
      return name === "collector-state" && mountPath === "/var/lib/otelcol";
    }),
  );
  assert.deepEqual(pod.volumes.find(({ name }) => name === "pod-logs")?.hostPath, {
    path: "/var/log/pods",
    type: "Directory",
  });
  assert.deepEqual(pod.volumes.find(({ name }) => name === "collector-state")?.emptyDir, {
    sizeLimit: "128Mi",
  });

  const configVolume = pod.volumes.find(({ name }) => name === "collector-config");
  assert.equal(configVolume?.secret?.secretName, "occ-otel-collector-config");
  const kubernetesCollectorConfig = await readFile(
    new URL("../../deploy/logging/kubernetes.yaml", import.meta.url),
    "utf8",
  );
  assert.match(kubernetesCollectorConfig, /occ\.component.+initialization/);
  const [config] = await parseProductionChart(kubernetesCollectorConfig);
  assert.ok(Check(collectorConfig, config), "Expected Collector filelog include and exclude globs");
  const { receivers } = config;
  const includes = receivers.filelog.include.map(globExpression);
  const excludes = receivers.filelog.exclude.map(globExpression);
  const collected = (path: string) =>
    includes.some((include) => include.test(path)) &&
    !excludes.some((exclude) => exclude.test(path));
  const upgrade = await render(loggingValues, { isUpgrade: true });
  const upgradeJob = findResource(
    await chartResources(upgrade.stdout),
    "Job",
    hasComponent("initialization"),
  );
  // The initialization-specific CRI globs collect structured migration and bootstrap events.
  // The startup check writes a plain-text result for the operator.
  const checkInitializationLogs = (jobName: string) => {
    const path = (container: string) =>
      `/var/log/pods/openclaw-system_${jobPodName(jobName)}_0b5c7e1e-2f4a-4c1e-9d8b-3a6f5e4d2c10/${container}/0.log`;
    for (const container of ["migration", "bootstrap"]) {
      assert.ok(collected(path(container)), path(container));
    }
    assert.equal(collected(path("installation-check")), false, path("installation-check"));
  };
  for (const job of [initialization, upgradeJob]) {
    const { initContainers, containers } = job.spec.template.spec;
    assert.deepEqual(
      initContainers.map(({ name }) => name),
      ["installation-check", "migration"],
    );
    assert.deepEqual(
      containers.map(({ name }) => name),
      ["bootstrap"],
    );
    checkInitializationLogs(job.metadata.name);
  }
  // Helm allows release names up to 53 characters; past 42 the generated Pod
  // name loses part of `-initialization-`. The Job name is checked both as
  // rendered today and cut to 63 characters.
  for (let length = 1; length <= 53; length += 1) {
    const jobName = `${"r".repeat(length)}-initialization`;
    for (const name of new Set([jobName, jobName.slice(0, 63).replace(/-+$/, "")])) {
      checkInitializationLogs(name);
    }
  }
  const longRelease = await render(loggingValues, { release: "r".repeat(53) });
  const longInitialization = findResource(
    await chartResources(longRelease.stdout),
    "Job",
    hasComponent("initialization"),
  );
  checkInitializationLogs(longInitialization.metadata.name.slice(0, 63));
  // Other workloads' containers stay out, and the Collector never reads itself.
  for (const path of [
    "/var/log/pods/openclaw-system_openclaw-enterprise-collector-x7k2q_uid/collector/0.log",
    "/var/log/pods/other_postgres-initdb-x7k2q_uid/postgres/0.log",
    "/var/log/pods/other_postgres-initdb-x7k2q_uid/installation-check/0.log",
    "/var/log/pods/other_keycloak-7d9f_uid/bootstrap/0.log",
  ]) {
    assert.equal(collected(path), false, path);
  }

  const metadataRole = findResource(
    rendered,
    "ClusterRole",
    ({ metadata }) => metadata.name === "oce-openclaw-log-metadata",
  );
  assert.deepEqual(metadataRole.rules, [
    {
      apiGroups: [""],
      resources: ["pods"],
      verbs: ["get", "list", "watch"],
    },
  ]);
  assert.ok(!metadataRole.rules.some(({ resources }) => resources?.includes("pods/log")));

  const egress = findResource(
    rendered,
    "NetworkPolicy",
    ({ metadata }) => metadata.name === "openclaw-enterprise-collector-egress",
  );
  assert.deepEqual(
    egress.spec.egress?.find((rule) => rule.to?.[0]?.ipBlock?.cidr === "10.43.0.1/32"),
    {
      to: [{ ipBlock: { cidr: "10.43.0.1/32" } }],
      ports: [{ protocol: "TCP", port: 443 }],
    },
  );
  assert.deepEqual(
    egress.spec.egress?.find((rule) => rule.to?.[0]?.ipBlock?.cidr === "203.0.113.10/32"),
    {
      to: [{ ipBlock: { cidr: "203.0.113.10/32" } }],
      ports: [{ protocol: "TCP", port: 443 }],
    },
  );
}

export async function productionHelmLoggingRefusals() {
  const refusals: readonly HelmRefusalCase[] = [
    {
      description: "mutable Collector image",
      values: {
        ...loggingValues,
        "logging.collector.image": "docker.io/otel/opentelemetry-collector-contrib:0.159.0",
      },
      expectedDiagnostic:
        "logging.collector.image must be an approved immutable SHA-256 image reference",
    },
    {
      description: "shared config Secret",
      values: { ...loggingValues, "logging.collector.configSecretName": "occ-auth" },
      expectedDiagnostic:
        "logging.collector.configSecretName must name a dedicated Secret; occ-auth is also auth.secretName",
    },
    {
      description: "shared env Secret",
      values: { ...loggingValues, "logging.collector.envSecretName": "occ-database" },
      expectedDiagnostic:
        "logging.collector.envSecretName must name a dedicated Secret; occ-database is also database.secretName",
    },
    {
      description: "broad exporter egress",
      values: { ...loggingValues, "logging.collector.exporter.cidr": "0.0.0.0/0" },
      expectedDiagnostic:
        "logging.collector.exporter.cidr must identify exactly one approved IPv4 exporter or proxy host with /32",
    },
    {
      description: "exporter host that is not an IPv4 address",
      values: { ...loggingValues, "logging.collector.exporter.cidr": "999.1.2.3/32" },
      expectedDiagnostic:
        "logging.collector.exporter.cidr must identify exactly one approved IPv4 exporter or proxy host with /32",
    },
    {
      description: "exporter host with a leading-zero octet",
      values: { ...loggingValues, "logging.collector.exporter.cidr": "01.2.3.4/32" },
      expectedDiagnostic:
        "logging.collector.exporter.cidr must identify exactly one approved IPv4 exporter or proxy host with /32",
    },
    {
      description: "missing env Secret",
      values: { ...loggingValues, "logging.collector.envSecretName": "" },
      expectedDiagnostic:
        "logging.collector requires dedicated operator-created config and environment Secrets",
    },
    {
      description: "shared Google sign-in Secret",
      values: {
        ...loggingValues,
        "auth.google.enabled": "true",
        "auth.recoveryUserId": "Xk3u9pQ2rT7vW1yZ",
        "logging.collector.envSecretName": "occ-google-login",
      },
      expectedDiagnostic:
        "logging.collector.envSecretName must name a dedicated Secret; occ-google-login is also auth.google.secretName",
    },
  ];
  for (const { description, values, expectedDiagnostic } of refusals) {
    await assert.rejects(
      render(values),
      (error: unknown) => helmRefusal(error) && error.stderr.includes(expectedDiagnostic),
      description,
    );
  }
  // OCI SHA-256 digests are lowercase hex; containerd refuses uppercase at pull time.
  await assert.rejects(
    render({
      ...loggingValues,
      "logging.collector.image": `docker.io/otel/opentelemetry-collector-contrib:0.159.0@sha256:${"C".repeat(64)}`,
    }),
    (error: unknown) =>
      helmRefusal(error) &&
      error.stderr.includes(
        "logging.collector.image must be an approved immutable SHA-256 image reference",
      ),
    "uppercase Collector image digest",
  );
  // Kubernetes refuses to pull an image whose repository path has an uppercase letter.
  await assert.rejects(
    render({
      ...loggingValues,
      "logging.collector.image": `docker.io/Otel/opentelemetry-collector-contrib:0.159.0@sha256:${"c".repeat(64)}`,
    }),
    (error: unknown) =>
      helmRefusal(error) &&
      error.stderr.includes(
        "logging.collector.image repository path must be lowercase; Kubernetes refuses to pull an uppercase one",
      ),
    "uppercase Collector repository path",
  );
  const oidc = {
    "auth.oidc.enabled": "true",
    "auth.recoveryUserId": "Xk3u9pQ2rT7vW1yZ",
    "auth.oidc.issuer": "https://idp.example.invalid/realms/occ",
    "auth.oidc.authorizationUrl": "https://idp.example.invalid/realms/occ/auth",
    "auth.oidc.tokenUrl": "https://idp.example.invalid/realms/occ/token",
    "auth.oidc.jwksUrl": "https://idp.example.invalid/realms/occ/certs",
  };
  const gatewayRouting = {
    "gatewayRouting.enabled": "true",
    "gatewayRouting.gatewayClassName": "private-envoy-gateway",
    "gatewayRouting.apiKeySecretName": "occ-gateway-api-key",
  };
  const repositoryCredentials = {
    "repositoryCredentials.enabled": "true",
    "repositoryCredentials.authority": "prepared-git",
    "repositoryCredentials.preparedCustodySecretName": "repository-custody",
    "repositoryCredentials.image": `registry.example.invalid/repository-credentials@sha256:${"b".repeat(64)}`,
    "repositoryCredentials.backendId": "github-primary",
    "repositoryCredentials.registryConfigMapName": "repository-registry-v1",
    "repositoryCredentials.serviceConfigSecretName": "repository-config",
    "repositoryCredentials.appKeySecretName": "repository-app-key",
    "repositoryCredentials.tlsSecretName": "repository-tls",
    "repositoryCredentials.publicCaSecretName": "repository-public-ca",
    "repositoryCredentials.upstreamCidrs[0]": "198.51.100.0/24",
  };
  const executionCluster = {
    "executionCluster.enabled": "true",
    "executionCluster.apiKubeconfigSecretName": "execution-api",
    "executionCluster.workerKubeconfigSecretName": "execution-worker",
    "executionCluster.apiCidrs[0]": "10.44.0.2/32",
  };
  const enabledFeatures: Array<[ChartValues, string[]]> = [
    [oidc, ["occ-oidc-login"]],
    [gatewayRouting, ["occ-gateway-api-key"]],
    [
      repositoryCredentials,
      [
        "repository-config",
        "repository-app-key",
        "repository-custody",
        "repository-tls",
        "repository-public-ca",
      ],
    ],
    [executionCluster, ["execution-api", "execution-worker"]],
  ];
  for (const [feature, secrets] of enabledFeatures) {
    await render({ ...loggingValues, ...feature });
    for (const secret of secrets) {
      for (const field of ["configSecretName", "envSecretName"]) {
        await assert.rejects(
          render({ ...loggingValues, ...feature, [`logging.collector.${field}`]: secret }),
          (error: unknown) =>
            helmRefusal(error) &&
            error.stderr.includes(
              `logging.collector.${field} must name a dedicated Secret; ${secret}`,
            ),
          `${field}=${secret}`,
        );
      }
    }
  }
}

export async function productionCollectorSelectors() {
  const selected = {
    ...loggingValues,
    "logging.collector.exporter.cidr": "",
    "logging.collector.exporter.namespaceLabels.kubernetes\\.io/metadata\\.name": "monitoring",
    "logging.collector.exporter.podLabels.app": "loki",
    "logging.collector.exporter.port": "3100",
    "logging.collector.metrics.scraperNamespaceLabels.kubernetes\\.io/metadata\\.name":
      "monitoring",
    "logging.collector.metrics.scraperPodLabels.app": "prometheus",
  };
  const rendered = await chartResources((await render(selected)).stdout);
  const policy = (name: string) =>
    findResource(rendered, "NetworkPolicy", ({ metadata }) => metadata.name === name);
  assert.deepEqual(policy("openclaw-enterprise-collector-egress").spec.egress?.at(-1), {
    to: [
      {
        namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "monitoring" } },
        podSelector: { matchLabels: { app: "loki" } },
      },
    ],
    ports: [{ protocol: "TCP", port: 3100 }],
  });
  assert.deepEqual(policy("openclaw-enterprise-collector-metrics").spec.ingress, [
    {
      from: [
        {
          namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "monitoring" } },
          podSelector: { matchLabels: { app: "prometheus" } },
        },
      ],
      ports: [{ protocol: "TCP", port: 8888 }],
    },
  ]);
  const closed = await chartResources((await render(loggingValues)).stdout);
  assert.ok(
    !closed.some((object) => object.metadata.name === "openclaw-enterprise-collector-metrics"),
  );
  const disabled = await chartResources(
    (await render({ ...selected, "logging.collector.metrics.enabled": "false" })).stdout,
  );
  assert.ok(
    !disabled.some((object) => object.metadata.name === "openclaw-enterprise-collector-metrics"),
  );
  const overrides: ChartValues[] = [
    { "logging.collector.exporter.namespaceLabels": null },
    { "logging.collector.exporter.podLabels": null },
    { "logging.collector.exporter.cidr": "203.0.113.10/32" },
    { "logging.collector.metrics.scraperNamespaceLabels": null },
    { "logging.collector.metrics.scraperPodLabels": null },
    ...["0", "65536", "9.5"].map((port): ChartValues => ({
      "logging.collector.exporter.port": port,
    })),
  ];
  for (const override of overrides) {
    await assert.rejects(render({ ...selected, ...override }), /logging.collector/);
  }
}
