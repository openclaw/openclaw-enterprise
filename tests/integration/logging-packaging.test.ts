import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Type, { type Static } from "typebox";
import { Check } from "typebox/value";

import { asRecord } from "../../packages/utils/src/index.ts";
import { composeConfiguration } from "../helpers/compose.ts";
import { namedChartResource } from "../helpers/production-chart-resource.ts";
import {
  chartTooling,
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

function helmRefusal(error: unknown): error is Error & { code: unknown; stderr: string } {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code !== 0 &&
    "stderr" in error &&
    typeof error.stderr === "string"
  );
}

function composeRecord(value: unknown, field: string): Record<string, unknown> {
  const record = asRecord(value);
  assert.ok(record, `Expected Compose to render ${field}`);
  return record;
}

function composeLoggingConfiguration(environment: NodeJS.ProcessEnv = {}) {
  const { services, volumes } = composeConfiguration(["compose.yaml", "compose.logging.yaml"], {
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:4318/v1/logs",
    ...environment,
  });
  assert.ok(services, "Expected Compose to render services");
  assert.ok(volumes, "Expected Compose to render volumes");
  return {
    service: (name: string) => composeRecord(services[name], `service ${name}`),
    volumes,
  };
}

function hasLoopbackPort(ports: unknown, target: number, published: number) {
  assert.ok(Array.isArray(ports), "Expected Compose to render Collector ports");
  const bindings: readonly unknown[] = ports;
  // Compare the same TCP binding in either provider's resolved representation.
  return bindings.some((port) => {
    if (typeof port === "string") {
      return (
        port === `127.0.0.1:${published}:${target}` ||
        port === `127.0.0.1:${published}:${target}/tcp`
      );
    }
    const binding = composeRecord(port, "Collector port binding");
    return (
      (binding.mode ?? "ingress") === "ingress" &&
      (binding.protocol ?? "tcp") === "tcp" &&
      binding.target === target &&
      (binding.published === published || binding.published === String(published)) &&
      binding.host_ip === "127.0.0.1"
    );
  });
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

const helmTooling = await chartTooling();

test("development logging override routes only OCC-owned services through the private Collector", async () => {
  assert.equal(
    await readFile(new URL("../../deploy/logging/occ.yaml", import.meta.url), "utf8"),
    "logging:\n  level: info\n",
  );

  const { service, volumes } = composeLoggingConfiguration();
  const collector = service("collector");

  assert.equal(
    collector.image,
    "docker.io/otel/opentelemetry-collector-contrib:0.159.0@sha256:1f2c54a30e713fac6b3ae77a1ec84010c2007e29ced8ec666214fc2f6739c1cc",
  );
  assert.ok(hasLoopbackPort(collector.ports, 24224, 24224));
  assert.ok(hasLoopbackPort(collector.ports, 8888, 8888));
  assert.equal(composeRecord(collector.logging, "collector.logging").driver, "local");
  assert.ok(["402653184", "384m"].includes(String(collector.mem_limit)));
  assert.equal(collector.user, "0:0");
  assert.equal(collector.read_only, true);
  assert.deepEqual(collector.cap_drop, ["ALL"]);
  assert.deepEqual(collector.security_opt, ["no-new-privileges:true"]);
  assert.ok(Object.hasOwn(volumes, "occ_otelcol_data"));

  for (const name of ["bootstrap", "controller", "migrate", "worker"]) {
    const logging = composeRecord(service(name).logging, `${name}.logging`);
    assert.equal(logging.driver, "fluentd");
    const options = composeRecord(logging.options, `${name}.logging.options`);
    assert.equal(options["fluentd-address"], "127.0.0.1:24224");
    assert.equal(options["fluentd-async"], "true");
    assert.equal(options["fluentd-buffer-limit"], "1024");
    assert.equal(options.mode, "non-blocking");
    assert.equal(options["max-buffer-size"], "1m");
    assert.equal(options["cache-disabled"], "false");
    assert.equal(options["cache-max-size"], "10m");
    assert.equal(options["cache-max-file"], "2");
    assert.equal(options["cache-compress"], "true");
    assert.ok(typeof options.labels === "string");
    const { labels } = options;
    assert.match(labels, /org\.openclaw\.enterprise\.managed/);
    assert.match(labels, /org\.openclaw\.enterprise\.version/);
    assert.match(labels, /com\.docker\.compose\.service/);
  }
  for (const name of ["controller", "worker"]) {
    const environment = composeRecord(service(name).environment, `${name}.environment`);
    assert.equal(environment.OCC_DOCKER_LOGGING_ADDRESS, "127.0.0.1:24224");
  }
  assert.equal(service("postgres").logging, undefined);

  const overridden = composeLoggingConfiguration({
    OCC_DOCKER_LOGGING_ADDRESS: "127.0.0.1:25224",
    OTEL_COLLECTOR_PORT: "25224",
    OTEL_COLLECTOR_METRICS_PORT: "18888",
  });
  const overriddenPorts = overridden.service("collector").ports;
  assert.ok(hasLoopbackPort(overriddenPorts, 24224, 25224));
  assert.ok(hasLoopbackPort(overriddenPorts, 8888, 18888));
  const workerLogging = composeRecord(overridden.service("worker").logging, "worker.logging");
  const workerOptions = composeRecord(workerLogging.options, "worker.logging.options");
  assert.equal(workerOptions["fluentd-address"], "127.0.0.1:25224");
});

test(
  "production Helm logging Collector is opt-in and isolated from application credentials",
  helmTooling,
  async () => {
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
    assert.ok(
      Check(collectorConfig, config),
      "Expected Collector filelog include and exclude globs",
    );
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
  },
);

test(
  "production Helm logging rejects mutable images, broad egress, and shared application Secrets",
  helmTooling,
  async () => {
    const refusals: Array<[string, ChartValues]> = [
      [
        "mutable Collector image",
        {
          ...loggingValues,
          "logging.collector.image": "docker.io/otel/opentelemetry-collector-contrib:0.159.0",
        },
      ],
      [
        "shared config Secret",
        { ...loggingValues, "logging.collector.configSecretName": "occ-auth" },
      ],
      [
        "shared env Secret",
        { ...loggingValues, "logging.collector.envSecretName": "occ-database" },
      ],
      [
        "broad exporter egress",
        { ...loggingValues, "logging.collector.exporter.cidr": "0.0.0.0/0" },
      ],
      [
        "exporter host that is not an IPv4 address",
        { ...loggingValues, "logging.collector.exporter.cidr": "999.1.2.3/32" },
      ],
      [
        "exporter host with a leading-zero octet",
        { ...loggingValues, "logging.collector.exporter.cidr": "01.2.3.4/32" },
      ],
      ["missing env Secret", { ...loggingValues, "logging.collector.envSecretName": "" }],
      [
        "shared Google sign-in Secret",
        {
          ...loggingValues,
          "auth.google.enabled": "true",
          "auth.recoveryUserId": "Xk3u9pQ2rT7vW1yZ",
          "logging.collector.envSecretName": "occ-google-login",
        },
      ],
    ];
    for (const [description, override] of refusals) {
      await assert.rejects(
        render(override),
        (error: unknown) => helmRefusal(error) && error.stderr.length > 0,
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
  },
);

test(
  "production Collector requires paired private metrics and exporter selectors",
  helmTooling,
  async () => {
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
  },
);
