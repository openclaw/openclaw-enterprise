import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { composeConfiguration } from "../helpers/compose.mjs";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const helm = process.env.OCC_HELM_BIN ?? "helm";
const collectorImage =
  "docker.io/otel/opentelemetry-collector-contrib:0.159.0@sha256:1f2c54a30e713fac6b3ae77a1ec84010c2007e29ced8ec666214fc2f6739c1cc";
const commonValues = {
  "images.controller": `registry.example.invalid/controller@sha256:${"a".repeat(64)}`,
  "auth.baseUrl": "https://occ.example.invalid",
  "auth.secretName": "occ-auth",
  "auth.secretKey": "secret",
  "bootstrap.adminEmail": "admin@example.invalid",
  "bootstrap.password.claimName": "occ-bootstrap-admin-password",
  "api.clients[0].namespace": "operator-tools",
  "api.clients[0].podLabels.app": "operator",
  "database.cidrs[0]": "10.45.0.12/32",
  "cluster.cidrs[0]": "10.43.0.1/32",
};
const loggingValues = {
  "logging.collector.enabled": "true",
  "logging.collector.image": collectorImage,
  "logging.collector.configSecretName": "occ-otel-collector-config",
  "logging.collector.envSecretName": "occ-otel-collector-exporter",
  "logging.collector.exporter.cidr": "203.0.113.10/32",
};

async function helmAvailable() {
  try {
    await execute(helm, ["version", "--short"], { cwd: repository });
    await execute("yq", ["--version"], { cwd: repository });
    return { skip: false };
  } catch {
    return {
      skip: "Install Helm and yq, or set OCC_HELM_BIN, to verify rendered logging packaging.",
    };
  }
}

async function render(overrides = {}) {
  const args = [
    "template",
    "oce",
    "deploy/helm/openclaw-enterprise",
    "--namespace",
    "openclaw-system",
  ];
  for (const [key, value] of Object.entries({ ...commonValues, ...overrides })) {
    args.push("--set", `${key}=${value}`);
  }
  return execute(helm, args, { cwd: repository, maxBuffer: 2_000_000 });
}

async function objects(manifests) {
  const parsed = await new Promise((resolve, reject) => {
    const child = execFile(
      "yq",
      ["eval-all", "-o=json", "-I=0", ".", "-"],
      { cwd: repository, maxBuffer: 2_000_000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin.end(manifests);
  });
  return parsed.trim().split("\n").map(JSON.parse);
}

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
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`);
}

const helmTooling = await helmAvailable();

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
    assert.equal(container.image, collectorImage);
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
    const initializerGlob = "/var/log/pods/*_*-initialization-*_*/*/*.log";
    assert.match(kubernetesCollectorConfig, /occ\.component.+initialization/);
    assert.ok(kubernetesCollectorConfig.includes(`      - ${initializerGlob}`));
    assert.ok(
      globExpression(initializerGlob).test(
        `/var/log/pods/openclaw-system_${initialization.metadata.name}-abcde_fixture/bootstrap/0.log`,
      ),
    );

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
    ]) {
      await assert.rejects(
        render(override),
        ({ code, stderr }) => code !== 0 && stderr.length > 0,
        description,
      );
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
