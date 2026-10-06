import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { composeConfiguration } from "../helpers/compose.mjs";
import {
  chartTooling,
  parseProductionChart as objects,
  productionCollectorValues as loggingValues,
  renderProductionChart as render,
} from "../helpers/production-chart.mjs";

function composeLoggingConfiguration(environment = {}) {
  return composeConfiguration(["compose.yaml", "compose.logging.yaml"], {
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:4318/v1/logs",
    ...environment,
  });
}

function hasLoopbackPort(service, target, published) {
  // Compare the same TCP binding in either provider's resolved representation.
  return service.ports.some((port) => {
    if (typeof port === "string") {
      return (
        port === `127.0.0.1:${published}:${target}` ||
        port === `127.0.0.1:${published}:${target}/tcp`
      );
    }
    return (
      (port.mode ?? "ingress") === "ingress" &&
      (port.protocol ?? "tcp") === "tcp" &&
      port.target === target &&
      String(port.published) === String(published) &&
      port.host_ip === "127.0.0.1"
    );
  });
}

function globExpression(pattern) {
  // filelog's `*` never crosses a path separator.
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*");
  return new RegExp(`^${escaped}$`);
}

// A Job's Pod gets `generateName: <job>-`; the API server cuts that prefix to
// 58 characters (names.MaxGeneratedNameLength) before adding 5 random ones.
function jobPodName(jobName) {
  return `${`${jobName}-`.slice(0, 58)}x7k2q`;
}

const helmTooling = await chartTooling();

test("development logging override routes only OCC-owned services through the private Collector", async () => {
  assert.equal(
    await readFile(new URL("../../deploy/logging/occ.yaml", import.meta.url), "utf8"),
    "logging:\n  level: info\n",
  );

  const configuration = composeLoggingConfiguration();
  const { bootstrap, collector, controller, migrate, postgres, worker } = configuration.services;

  assert.equal(
    collector.image,
    "docker.io/otel/opentelemetry-collector-contrib:0.159.0@sha256:1f2c54a30e713fac6b3ae77a1ec84010c2007e29ced8ec666214fc2f6739c1cc",
  );
  assert.ok(hasLoopbackPort(collector, 24224, 24224));
  assert.ok(hasLoopbackPort(collector, 8888, 8888));
  assert.equal(collector.logging.driver, "local");
  assert.ok(["402653184", "384m"].includes(String(collector.mem_limit)));
  assert.equal(collector.user, "0:0");
  assert.equal(collector.read_only, true);
  assert.deepEqual(collector.cap_drop, ["ALL"]);
  assert.deepEqual(collector.security_opt, ["no-new-privileges:true"]);
  assert.ok(Object.hasOwn(configuration.volumes, "occ_otelcol_data"));

  for (const service of [bootstrap, controller, migrate, worker]) {
    assert.equal(service.logging.driver, "fluentd");
    assert.equal(service.logging.options["fluentd-address"], "127.0.0.1:24224");
    assert.equal(service.logging.options["fluentd-async"], "true");
    assert.equal(service.logging.options["fluentd-buffer-limit"], "1024");
    assert.equal(service.logging.options.mode, "non-blocking");
    assert.equal(service.logging.options["max-buffer-size"], "1m");
    assert.equal(service.logging.options["cache-disabled"], "false");
    assert.equal(service.logging.options["cache-max-size"], "10m");
    assert.equal(service.logging.options["cache-max-file"], "2");
    assert.equal(service.logging.options["cache-compress"], "true");
    assert.match(service.logging.options.labels, /org\.openclaw\.enterprise\.managed/);
    assert.match(service.logging.options.labels, /org\.openclaw\.enterprise\.version/);
    assert.match(service.logging.options.labels, /com\.docker\.compose\.service/);
  }
  assert.equal(controller.environment.OCC_DOCKER_LOGGING_ADDRESS, "127.0.0.1:24224");
  assert.equal(worker.environment.OCC_DOCKER_LOGGING_ADDRESS, "127.0.0.1:24224");
  assert.equal(postgres.logging, undefined);

  const overridden = composeLoggingConfiguration({
    OCC_DOCKER_LOGGING_ADDRESS: "127.0.0.1:25224",
    OTEL_COLLECTOR_PORT: "25224",
    OTEL_COLLECTOR_METRICS_PORT: "18888",
  });
  assert.ok(hasLoopbackPort(overridden.services.collector, 24224, 25224));
  assert.ok(hasLoopbackPort(overridden.services.collector, 8888, 18888));
  assert.equal(overridden.services.worker.logging.options["fluentd-address"], "127.0.0.1:25224");
});

test(
  "production Helm logging Collector is opt-in and isolated from application credentials",
  helmTooling,
  async () => {
    const disabled = await render();
    assert.equal(disabled.stdout.includes("openclaw-enterprise-collector"), false);

    const { stdout } = await render(loggingValues);
    const rendered = await objects(stdout);
    const byKindAndComponent = (kind, component) =>
      rendered.find(
        (object) =>
          object.kind === kind &&
          object.metadata.labels?.["app.kubernetes.io/component"] === component,
      );
    const serviceAccount = byKindAndComponent("ServiceAccount", "collector");
    const daemonSet = byKindAndComponent("DaemonSet", "collector");
    const initialization = byKindAndComponent("Job", "initialization");
    const pod = daemonSet.spec.template.spec;
    const container = pod.containers[0];

    assert.equal(serviceAccount.automountServiceAccountToken, true);
    assert.equal(container.image, loggingValues["logging.collector.image"]);
    assert.deepEqual(container.envFrom, [{ secretRef: { name: "occ-otel-collector-exporter" } }]);
    assert.deepEqual(container.env, [
      { name: "K8S_NODE_NAME", valueFrom: { fieldRef: { fieldPath: "spec.nodeName" } } },
    ]);
    assert.deepEqual(container.ports, [{ name: "metrics", containerPort: 8888 }]);
    assert.equal(daemonSet.spec.template.spec.securityContext.runAsNonRoot, true);
    assert.deepEqual(daemonSet.spec.template.spec.securityContext.supplementalGroups, [0]);
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
    assert.deepEqual(pod.volumes.find(({ name }) => name === "pod-logs").hostPath, {
      path: "/var/log/pods",
      type: "Directory",
    });
    assert.deepEqual(pod.volumes.find(({ name }) => name === "collector-state").emptyDir, {
      sizeLimit: "128Mi",
    });

    const configVolume = pod.volumes.find(({ name }) => name === "collector-config");
    assert.equal(configVolume.secret.secretName, "occ-otel-collector-config");
    const kubernetesCollectorConfig = await readFile(
      new URL("../../deploy/logging/kubernetes.yaml", import.meta.url),
      "utf8",
    );
    assert.match(kubernetesCollectorConfig, /occ\.component.+initialization/);
    const [{ receivers }] = await objects(kubernetesCollectorConfig);
    const includes = receivers.filelog.include.map(globExpression);
    const excludes = receivers.filelog.exclude.map(globExpression);
    const collected = (path) =>
      includes.some((include) => include.test(path)) &&
      !excludes.some((exclude) => exclude.test(path));
    const initializationContainers = [
      ...initialization.spec.template.spec.initContainers,
      ...initialization.spec.template.spec.containers,
    ].map(({ name }) => name);
    assert.deepEqual(initializationContainers, ["migration", "bootstrap"]);
    const initializationLogs = (jobName) =>
      initializationContainers.map(
        (container) =>
          `/var/log/pods/openclaw-system_${jobPodName(jobName)}_0b5c7e1e-2f4a-4c1e-9d8b-3a6f5e4d2c10/${container}/0.log`,
      );
    for (const path of initializationLogs(initialization.metadata.name)) {
      assert.ok(collected(path), path);
    }
    // Helm allows release names up to 53 characters; past 42 the generated Pod
    // name loses part of `-initialization-`. The Job name is checked both as
    // rendered today and cut to 63 characters.
    for (let length = 1; length <= 53; length += 1) {
      const jobName = `${"r".repeat(length)}-initialization`;
      for (const name of new Set([jobName, jobName.slice(0, 63).replace(/-+$/, "")])) {
        for (const path of initializationLogs(name)) {
          assert.ok(collected(path), `release length ${length}: ${path}`);
        }
      }
    }
    const longRelease = await render(loggingValues, { release: "r".repeat(53) });
    const longInitialization = (await objects(longRelease.stdout)).find(
      (object) =>
        object.kind === "Job" &&
        object.metadata.labels?.["app.kubernetes.io/component"] === "initialization",
    );
    for (const path of initializationLogs(longInitialization.metadata.name.slice(0, 63))) {
      assert.ok(collected(path), path);
    }
    // Other workloads' containers stay out, and the Collector never reads itself.
    for (const path of [
      "/var/log/pods/openclaw-system_openclaw-enterprise-collector-x7k2q_uid/collector/0.log",
      "/var/log/pods/other_postgres-initdb-x7k2q_uid/postgres/0.log",
      "/var/log/pods/other_keycloak-7d9f_uid/bootstrap/0.log",
    ]) {
      assert.equal(collected(path), false, path);
    }

    const metadataRole = rendered.find(
      ({ kind, metadata }) =>
        kind === "ClusterRole" && metadata.name === "oce-openclaw-log-metadata",
    );
    assert.deepEqual(metadataRole.rules, [
      {
        apiGroups: [""],
        resources: ["pods"],
        verbs: ["get", "list", "watch"],
      },
    ]);
    assert.ok(!metadataRole.rules.some(({ resources }) => resources.includes("pods/log")));

    const egress = rendered.find(
      ({ kind, metadata }) =>
        kind === "NetworkPolicy" && metadata.name === "openclaw-enterprise-collector-egress",
    );
    assert.deepEqual(
      egress.spec.egress.find((rule) => rule.to?.[0]?.ipBlock?.cidr === "10.43.0.1/32"),
      {
        to: [{ ipBlock: { cidr: "10.43.0.1/32" } }],
        ports: [{ protocol: "TCP", port: 443 }],
      },
    );
    assert.deepEqual(
      egress.spec.egress.find((rule) => rule.to?.[0]?.ipBlock?.cidr === "203.0.113.10/32"),
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
    for (const [description, override] of [
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
      ["missing env Secret", { ...loggingValues, "logging.collector.envSecretName": "" }],
      [
        "shared GitHub sign-in Secret",
        {
          ...loggingValues,
          "auth.github.enabled": "true",
          "auth.recoveryUserId": "Xk3u9pQ2rT7vW1yZ",
          "logging.collector.envSecretName": "occ-github-login",
        },
      ],
    ]) {
      await assert.rejects(
        render(override),
        ({ code, stderr }) => code !== 0 && stderr.length > 0,
        description,
      );
    }
    // OCI SHA-256 digests are lowercase hex; containerd refuses uppercase at pull time.
    await assert.rejects(
      render({
        ...loggingValues,
        "logging.collector.image": `docker.io/otel/opentelemetry-collector-contrib:0.159.0@sha256:${"C".repeat(64)}`,
      }),
      ({ code, stderr }) =>
        code !== 0 &&
        stderr.includes(
          "logging.collector.image must be an approved immutable SHA-256 image reference",
        ),
      "uppercase Collector image digest",
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
    for (const [feature, secrets] of [
      [oidc, ["occ-oidc-login"]],
      [gatewayRouting, ["occ-gateway-api-key"]],
      [
        repositoryCredentials,
        ["repository-config", "repository-app-key", "repository-tls", "repository-public-ca"],
      ],
      [executionCluster, ["execution-api", "execution-worker"]],
    ]) {
      await render({ ...loggingValues, ...feature });
      for (const secret of secrets) {
        for (const field of ["configSecretName", "envSecretName"]) {
          await assert.rejects(
            render({ ...loggingValues, ...feature, [`logging.collector.${field}`]: secret }),
            ({ stderr }) => /logging\.collector Secrets must be dedicated/.test(stderr),
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
    const rendered = await objects((await render(selected)).stdout);
    const policy = (name) =>
      rendered.find((object) => object.kind === "NetworkPolicy" && object.metadata.name === name);
    assert.deepEqual(policy("openclaw-enterprise-collector-egress").spec.egress.at(-1), {
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
    const closed = await objects((await render(loggingValues)).stdout);
    assert.ok(
      !closed.some((object) => object.metadata.name === "openclaw-enterprise-collector-metrics"),
    );
    const disabled = await objects(
      (await render({ ...selected, "logging.collector.metrics.enabled": "false" })).stdout,
    );
    assert.ok(
      !disabled.some((object) => object.metadata.name === "openclaw-enterprise-collector-metrics"),
    );
    for (const override of [
      { "logging.collector.exporter.namespaceLabels": null },
      { "logging.collector.exporter.podLabels": null },
      { "logging.collector.exporter.cidr": "203.0.113.10/32" },
      { "logging.collector.metrics.scraperNamespaceLabels": null },
      { "logging.collector.metrics.scraperPodLabels": null },
      ...["0", "65536", "9.5"].map((port) => ({ "logging.collector.exporter.port": port })),
    ]) {
      await assert.rejects(render({ ...selected, ...override }), /logging.collector/);
    }
  },
);
