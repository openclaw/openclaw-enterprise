import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const helm = process.env.OCC_HELM_BIN ?? "helm";
const { loadAllYaml }: { loadAllYaml: (yaml: string) => unknown[] } = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
)("@kubernetes/client-node");
const occValues = ["--set", "occ.namespace=openclaw-system", "--set", "occ.release=oce"];
const demoValues = [
  ...occValues,
  "--set",
  "cluster.cidrs[0]=10.43.0.1/32",
  "--set",
  "grafana.adminSecretName=grafana-admin",
];

async function helmAvailable() {
  try {
    await execute(helm, ["version", "--short"], { cwd: repository });
    return { skip: false };
  } catch {
    return { skip: "Install Helm, or set OCC_HELM_BIN, to verify the rendered demo chart." };
  }
}

function renderChart(release: string, args: readonly string[]) {
  return execute(helm, ["template", release, "deploy/helm/openclaw-observability-demo", ...args], {
    cwd: repository,
    maxBuffer: 2_000_000,
  });
}

function helmStderrIncludes(message: string) {
  return (error: unknown) =>
    error instanceof Error &&
    "stderr" in error &&
    typeof error.stderr === "string" &&
    error.stderr.includes(message);
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !isArray(value);
}

function record(value: unknown, field: string): Record<string, unknown> {
  assert.ok(isRecord(value), `Expected an object for ${field}`);
  return value;
}

function sequence(value: unknown, field: string): unknown[] {
  assert.ok(isArray(value), `Expected an array for ${field}`);
  return value;
}

function chartObjects(stdout: string) {
  return loadAllYaml(stdout).filter(isRecord);
}

function resourceName(object: Record<string, unknown>) {
  const { name } = record(object.metadata, "metadata");
  assert.ok(typeof name === "string", "Expected metadata.name to be a string");
  return name;
}

function podTemplate(deployment: Record<string, unknown>) {
  return record(record(deployment.spec, "Deployment spec").template, "Pod template");
}

test(
  "demo Grafana keeps its disposable SQLite database off node disk",
  await helmAvailable(),
  async () => {
    const { stdout } = await renderChart("demo", [
      "--namespace",
      "oce-observability-demo",
      ...demoValues,
      "--show-only",
      "templates/deployments.yaml",
    ]);
    const volumes = new Map<string, unknown>();
    for (const deployment of chartObjects(stdout).filter(
      (object) => object.kind === "Deployment",
    )) {
      const name = resourceName(deployment);
      const spec = record(podTemplate(deployment).spec, "Pod spec");
      const volume = sequence(spec.volumes, "Pod volumes")
        .filter(isRecord)
        .find((entry) => entry.name === "data");
      assert.ok(volume, `Missing data volume for ${name}`);
      // The Kubernetes decoder adds undefined fields to typed objects.
      const emptyDir: unknown = JSON.parse(JSON.stringify(volume.emptyDir));
      volumes.set(name, emptyDir);
    }
    // First start runs ~700 SQLite migrations. On node disk each one waits on
    // fsync, which took over two minutes on a local k3d node and overran the
    // documented install wait; in memory it takes about a second.
    assert.deepEqual(volumes.get("demo-grafana"), { medium: "Memory", sizeLimit: "64Mi" });
    // Prometheus and Loki data may exceed a memory budget, so they stay on disk.
    assert.deepEqual(volumes.get("demo-prometheus"), { sizeLimit: "1Gi" });
    assert.deepEqual(volumes.get("demo-loki"), { sizeLimit: "1Gi" });
  },
);

test(
  "demo Service names admit valid release shapes and keep Grafana URLs aligned",
  await helmAvailable(),
  async () => {
    const names = new Map<string, Record<string, string>>();
    const componentLabel = "app.kubernetes.io/component";
    const podLabels = (deployment: Record<string, unknown>) =>
      record(record(podTemplate(deployment).metadata, "Pod metadata").labels, "Pod labels");
    const longPrefix = "release-" + "a".repeat(44);
    for (const release of [
      "demo",
      "0",
      "1e3",
      "2026-demo",
      "demo-2026-demo",
      "team.qa",
      "team-qa",
      "team-qa-7bdce6278c69",
      "9.qa",
      "a".repeat(52),
      longPrefix + "a",
      longPrefix + "b",
    ]) {
      const { stdout } = await renderChart(release, demoValues);
      const objects = chartObjects(stdout);
      const services = objects.filter((object) => object.kind === "Service");
      const serviceNames: Record<string, string> = {};
      for (const service of services) {
        const name = resourceName(service);
        // This is Kubernetes' independent Service naming contract, not the chart's helper output.
        assert.ok(name.length <= 63, `${release}: ${name}`);
        assert.match(name, /^[a-z][a-z0-9-]*[a-z0-9]$/);
        const selector = record(record(service.spec, "Service spec").selector, "Service selector");
        const component = selector[componentLabel];
        assert.ok(typeof component === "string", `Missing component selector for ${name}`);
        serviceNames[component] = name;
        const deployment = objects.find(
          (object) =>
            object.kind === "Deployment" && podLabels(object)[componentLabel] === component,
        );
        assert.ok(deployment, `Missing Deployment for Service ${name}`);
        const labels = podLabels(deployment);
        for (const [key, value] of Object.entries(selector)) {
          assert.equal(labels[key], value);
        }
      }
      const grafana = objects.find(
        (object) =>
          object.kind === "ConfigMap" && isRecord(object.data) && object.data["datasources.yaml"],
      );
      assert.ok(grafana, "Missing Grafana datasource ConfigMap");
      const datasourceYaml = record(grafana.data, "Grafana ConfigMap data")["datasources.yaml"];
      assert.ok(typeof datasourceYaml === "string", "Expected datasources.yaml to be a string");
      const dataSources = sequence(
        record(loadAllYaml(datasourceYaml)[0], "Grafana datasource configuration").datasources,
        "Grafana datasources",
      ).filter(isRecord);
      assert.equal(
        dataSources.find((source) => source.type === "prometheus")?.url,
        `http://${serviceNames.prometheus}:9090`,
      );
      assert.equal(
        dataSources.find((source) => source.type === "loki")?.url,
        `http://${serviceNames.loki}:3100`,
      );
      names.set(release, serviceNames);
      if (["demo", "demo-2026-demo", "team-qa"].includes(release)) {
        for (const component of ["prometheus", "loki", "grafana"]) {
          assert.equal(serviceNames[component], `${release}-${component}`);
        }
      }
    }
    // Distinguish normalized aliases and names whose distinguishing tail is truncated.
    for (const [left, right] of [
      ["2026-demo", "demo-2026-demo"],
      ["team.qa", "team-qa"],
      ["team.qa", "team-qa-7bdce6278c69"],
      [longPrefix + "a", longPrefix + "b"],
    ] as const) {
      const leftNames = names.get(left);
      const rightNames = names.get(right);
      assert.ok(leftNames && rightNames, `Missing Service names for ${left} or ${right}`);
      assert.notEqual(leftNames.prometheus, rightNames.prometheus);
    }
  },
);

test(
  "demo chart refuses unusable image digest and repository spellings",
  await helmAvailable(),
  async () => {
    await renderChart("demo", demoValues);
    // OCI SHA-256 digests are `sha256` and lowercase hex; containerd refuses other
    // spellings at pull time, so the chart refuses them at render time. The uppercase
    // algorithm was already refused; uppercase hex was not.
    for (const name of ["prometheus", "grafana", "loki"]) {
      for (const digest of [`sha256:${"A".repeat(64)}`, `SHA256:${"a".repeat(64)}`]) {
        await assert.rejects(
          renderChart("demo", [
            ...demoValues,
            "--set",
            `images.${name}=registry.example.invalid/${name}@${digest}`,
          ]),
          helmStderrIncludes(`images.${name} must use an immutable SHA-256 reference`),
          `${name} ${digest.slice(0, 8)}`,
        );
      }
      const digest = `@sha256:${"a".repeat(64)}`;
      for (const image of [
        `docker.io/Team/${name}${digest}`,
        `Registry.Example.invalid/team/${name.toUpperCase()}:release_1${digest}`,
        `[FD00::1]:5000/team/${name.toUpperCase()}${digest}`,
        `${name.toUpperCase()}${digest}`,
      ]) {
        await assert.rejects(
          renderChart("demo", [...demoValues, "--set", `images.${name}=${image}`]),
          helmStderrIncludes(`images.${name} repository path must be lowercase`),
          image,
        );
      }
      for (const image of [
        `Registry.Example.invalid/team/${name}:RELEASE_1${digest}`,
        `[FD00::1]:5000/team/${name}:RELEASE_1${digest}`,
        `${name}:RELEASE_1${digest}`,
      ]) {
        const { stdout } = await renderChart("demo", [
          ...demoValues,
          "--set",
          `images.${name}=${image}`,
        ]);
        const deployment = chartObjects(stdout).find(
          (object) => object.kind === "Deployment" && resourceName(object) === `demo-${name}`,
        );
        assert.ok(deployment, `Missing Deployment demo-${name}`);
        const spec = record(podTemplate(deployment).spec, "Pod spec");
        const containers = sequence(spec.containers, "Pod containers");
        assert.equal(record(containers[0], "First Pod container").image, image);
      }
    }
  },
);

test("demo guide install can be rerun after a cold-cache wait timeout", async () => {
  const guide = await readFile(`${repository}docs/guides/observability/demo.md`, "utf8");
  // A cold image cache can overrun the wait and leave a failed release. Plain
  // `helm install` then refuses the reserved name; `upgrade --install` upgrades
  // the failed release in place, and still refuses one left pending by an
  // interrupted run.
  assert.match(
    guide,
    /helm upgrade --install demo deploy\/helm\/openclaw-observability-demo \\\n\s+-n oce-observability-demo -f "\$OBS_FILES\/demo\.yaml" --wait --timeout 10m\n/,
  );
  assert.doesNotMatch(guide, /helm install demo/);
});

for (const value of ["407", "true", "null", "1e3"]) {
  test(
    `demo Kubernetes identifiers remain strings for ${value}`,
    await helmAvailable(),
    async () => {
      const { stdout } = await renderChart(value, [
        "--namespace",
        value,
        "--set-string",
        `occ.namespace=${value},occ.release=${value},dns.namespace=${value},grafana.adminSecretName=${value},grafana.adminSecretKey=${value},grafana.clients[0].namespace=${value}`,
        "--set-string",
        "grafana.clients[0].podLabels.app=operator",
        "--set",
        "cluster.cidrs[0]=10.43.0.1/32",
      ]);
      let checked = 0;
      function check(object: unknown) {
        if (isArray(object)) {
          for (const entry of object) {
            check(entry);
          }
          return;
        }
        if (!isRecord(object)) {
          return;
        }
        for (const [key, field] of Object.entries(object)) {
          if (["name", "namespace", "key"].includes(key) && field !== undefined) {
            assert.equal(typeof field, "string", `${key} must be a string`);
            checked += 1;
          }
          if (["labels", "matchLabels"].includes(key)) {
            for (const label of Object.values(record(field, key))) {
              assert.equal(typeof label, "string", "label and selector values must be strings");
              checked += 1;
            }
          }
          check(field);
        }
      }
      for (const object of loadAllYaml(stdout)) {
        check(object);
      }
      assert.ok(
        checked > 50,
        "the rendered workloads, RBAC, Secret references and selectors were checked",
      );
    },
  );
}

test(
  "demo chart refuses selector namespaces that no Kubernetes Namespace can have",
  await helmAvailable(),
  async () => {
    const render = (override: string) =>
      renderChart("demo", [
        ...demoValues,
        "--set",
        "grafana.clients[0].namespace=operator-tools",
        "--set",
        "grafana.clients[0].podLabels.app=operator",
        "--set-string",
        override,
      ]);
    // NetworkPolicies select each of these on kubernetes.io/metadata.name, which holds a
    // Namespace name: a DNS label of at most 63 characters. Anything else selects nothing.
    for (const path of ["occ.namespace", "dns.namespace", "grafana.clients[0].namespace"]) {
      await render(`${path}=${"a".repeat(63)}`);
      for (const namespace of [
        "kube.system",
        "Kube-System",
        "a".repeat(64),
        "-system",
        "system-",
      ]) {
        await assert.rejects(
          render(`${path}=${namespace}`),
          helmStderrIncludes(
            `${path} must be a Kubernetes namespace name (a DNS label of at most 63 characters)`,
          ),
          `${path}=${namespace}`,
        );
      }
    }
  },
);

test(
  "demo chart refuses NetworkPolicy ports Kubernetes cannot use",
  await helmAvailable(),
  async () => {
    const render = (sets: readonly string[]) =>
      renderChart("demo", ["--namespace", "oce-observability-demo", ...demoValues, ...sets]);
    for (const path of ["cluster.port", "occ.metricsPort"]) {
      for (const port of ["0", "010", "65536", "99999999999999999999"]) {
        await assert.rejects(
          render(["--set-string", `${path}=${port}`]),
          helmStderrIncludes(`${path} must be an integer TCP port from 1 to 65535`),
          `${path}=${port}`,
        );
      }
    }
    const { stdout } = await render([
      "--set-string",
      "cluster.port=6443",
      "--set-string",
      "occ.metricsPort=9464",
    ]);
    assert.match(stdout, /port: 6443/);
    assert.match(stdout, /port: 9464/);
  },
);

test(
  "demo chart refuses cluster CIDRs that are not one IPv4 host",
  await helmAvailable(),
  async () => {
    const render = (cidr: string) =>
      renderChart("demo", [
        "--namespace",
        "oce-observability-demo",
        ...occValues,
        "--set",
        "grafana.adminSecretName=grafana-admin",
        "--set",
        `cluster.cidrs[0]=${cidr}`,
      ]);
    for (const cidr of ["999.1.2.3/32", "010.0.0.1/32", "10.43.0.1/24", "not-a-cidr"]) {
      await assert.rejects(
        render(cidr),
        helmStderrIncludes("cluster.cidrs requires exact IPv4 /32 endpoints"),
        cidr,
      );
    }
    const { stdout } = await render("10.43.0.1/32");
    assert.match(stdout, /cidr: 10\.43\.0\.1\/32/);
  },
);
