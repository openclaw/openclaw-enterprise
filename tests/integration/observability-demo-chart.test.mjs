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
const { loadAllYaml } = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
)("@kubernetes/client-node");

async function helmAvailable() {
  try {
    await execute(helm, ["version", "--short"], { cwd: repository });
    return { skip: false };
  } catch {
    return { skip: "Install Helm, or set OCC_HELM_BIN, to verify the rendered demo chart." };
  }
}

test(
  "demo Grafana keeps its disposable SQLite database off node disk",
  await helmAvailable(),
  async () => {
    const { stdout } = await execute(
      helm,
      [
        "template",
        "demo",
        "deploy/helm/openclaw-observability-demo",
        "--namespace",
        "oce-observability-demo",
        "--set",
        "occ.namespace=openclaw-system",
        "--set",
        "occ.release=oce",
        "--set",
        "cluster.cidrs[0]=10.43.0.1/32",
        "--set",
        "grafana.adminSecretName=grafana-admin",
        "--show-only",
        "templates/deployments.yaml",
      ],
      { cwd: repository, maxBuffer: 2_000_000 },
    );
    const volumes = Object.fromEntries(
      loadAllYaml(stdout)
        .filter((object) => object?.kind === "Deployment")
        .map((deployment) => [
          deployment.metadata.name,
          JSON.parse(
            JSON.stringify(
              deployment.spec.template.spec.volumes.find(({ name }) => name === "data").emptyDir,
            ),
          ),
        ]),
    );
    // First start runs ~700 SQLite migrations. On node disk each one waits on
    // fsync, which took over two minutes on a local k3d node and overran the
    // documented install wait; in memory it takes about a second.
    assert.deepEqual(volumes["demo-grafana"], { medium: "Memory", sizeLimit: "64Mi" });
    // Prometheus and Loki data may exceed a memory budget, so they stay on disk.
    assert.deepEqual(volumes["demo-prometheus"], { sizeLimit: "1Gi" });
    assert.deepEqual(volumes["demo-loki"], { sizeLimit: "1Gi" });
  },
);

test(
  "demo Service names admit valid release shapes and keep Grafana URLs aligned",
  await helmAvailable(),
  async () => {
    const render = async (release) => {
      const { stdout } = await execute(
        helm,
        [
          "template",
          release,
          "deploy/helm/openclaw-observability-demo",
          "--set",
          "occ.namespace=openclaw-system",
          "--set",
          "occ.release=oce",
          "--set",
          "cluster.cidrs[0]=10.43.0.1/32",
          "--set",
          "grafana.adminSecretName=grafana-admin",
        ],
        { cwd: repository, maxBuffer: 2_000_000 },
      );
      return loadAllYaml(stdout);
    };
    const names = new Map();
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
      const objects = await render(release);
      const services = objects.filter((object) => object?.kind === "Service");
      const serviceNames = {};
      for (const service of services) {
        // This is Kubernetes' independent Service naming contract, not the chart's helper output.
        assert.ok(service.metadata.name.length <= 63, `${release}: ${service.metadata.name}`);
        assert.match(service.metadata.name, /^[a-z][a-z0-9-]*[a-z0-9]$/);
        const component = service.spec.selector["app.kubernetes.io/component"];
        serviceNames[component] = service.metadata.name;
        const deployment = objects.find(
          (object) =>
            object?.kind === "Deployment" &&
            object.spec.template.metadata.labels["app.kubernetes.io/component"] === component,
        );
        for (const [key, value] of Object.entries(service.spec.selector)) {
          assert.equal(deployment.spec.template.metadata.labels[key], value);
        }
      }
      const grafana = objects.find(
        (object) => object?.kind === "ConfigMap" && object.data?.["datasources.yaml"],
      );
      const dataSources = loadAllYaml(grafana.data["datasources.yaml"])[0].datasources;
      assert.equal(
        dataSources.find((source) => source.type === "prometheus").url,
        `http://${serviceNames.prometheus}:9090`,
      );
      assert.equal(
        dataSources.find((source) => source.type === "loki").url,
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
    ]) {
      assert.notEqual(names.get(left).prometheus, names.get(right).prometheus);
    }
  },
);

test(
  "demo chart refuses unusable image digest and repository spellings",
  await helmAvailable(),
  async () => {
    const render = (overrides) =>
      execute(
        helm,
        [
          "template",
          "demo",
          "deploy/helm/openclaw-observability-demo",
          ...[
            "occ.namespace=openclaw-system",
            "occ.release=oce",
            "cluster.cidrs[0]=10.43.0.1/32",
            "grafana.adminSecretName=grafana-admin",
            ...overrides,
          ].flatMap((value) => ["--set", value]),
        ],
        { cwd: repository, maxBuffer: 2_000_000 },
      );
    await render([]);
    // OCI SHA-256 digests are `sha256` and lowercase hex; containerd refuses other
    // spellings at pull time, so the chart refuses them at render time. The uppercase
    // algorithm was already refused; uppercase hex was not.
    for (const name of ["prometheus", "grafana", "loki"]) {
      for (const digest of [`sha256:${"A".repeat(64)}`, `SHA256:${"a".repeat(64)}`]) {
        await assert.rejects(
          render([`images.${name}=registry.example.invalid/${name}@${digest}`]),
          ({ stderr }) => stderr.includes(`images.${name} must use an immutable SHA-256 reference`),
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
          render([`images.${name}=${image}`]),
          ({ stderr }) => stderr.includes(`images.${name} repository path must be lowercase`),
          image,
        );
      }
      for (const image of [
        `Registry.Example.invalid/team/${name}:RELEASE_1${digest}`,
        `[FD00::1]:5000/team/${name}:RELEASE_1${digest}`,
        `${name}:RELEASE_1${digest}`,
      ]) {
        const { stdout } = await render([`images.${name}=${image}`]);
        const deployment = loadAllYaml(stdout).find(
          (object) => object?.kind === "Deployment" && object.metadata.name === `demo-${name}`,
        );
        assert.equal(deployment.spec.template.spec.containers[0].image, image);
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
      const { stdout } = await execute(
        helm,
        [
          "template",
          value,
          "deploy/helm/openclaw-observability-demo",
          "--namespace",
          value,
          "--set-string",
          `occ.namespace=${value},occ.release=${value},dns.namespace=${value},grafana.adminSecretName=${value},grafana.adminSecretKey=${value},grafana.clients[0].namespace=${value}`,
          "--set-string",
          "grafana.clients[0].podLabels.app=operator",
          "--set",
          "cluster.cidrs[0]=10.43.0.1/32",
        ],
        { cwd: repository, maxBuffer: 2_000_000 },
      );
      let checked = 0;
      function check(object) {
        if (Array.isArray(object)) {
          for (const entry of object) {
            check(entry);
          }
          return;
        }
        if (!object || typeof object !== "object") {
          return;
        }
        for (const [key, field] of Object.entries(object)) {
          if (["name", "namespace", "key"].includes(key) && field !== undefined) {
            assert.equal(typeof field, "string", `${key} must be a string`);
            checked += 1;
          }
          if (["labels", "matchLabels"].includes(key)) {
            for (const label of Object.values(field)) {
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
    const render = (overrides) =>
      execute(
        helm,
        [
          "template",
          "demo",
          "deploy/helm/openclaw-observability-demo",
          ...[
            "occ.namespace=openclaw-system",
            "occ.release=oce",
            "cluster.cidrs[0]=10.43.0.1/32",
            "grafana.adminSecretName=grafana-admin",
            "grafana.clients[0].namespace=operator-tools",
            "grafana.clients[0].podLabels.app=operator",
          ].flatMap((value) => ["--set", value]),
          ...overrides.flatMap((value) => ["--set-string", value]),
        ],
        { cwd: repository, maxBuffer: 2_000_000 },
      );
    // NetworkPolicies select each of these on kubernetes.io/metadata.name, which holds a
    // Namespace name: a DNS label of at most 63 characters. Anything else selects nothing.
    for (const path of ["occ.namespace", "dns.namespace", "grafana.clients[0].namespace"]) {
      await render([`${path}=${"a".repeat(63)}`]);
      for (const namespace of [
        "kube.system",
        "Kube-System",
        "a".repeat(64),
        "-system",
        "system-",
      ]) {
        await assert.rejects(
          render([`${path}=${namespace}`]),
          ({ stderr }) =>
            stderr.includes(
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
    const render = (sets) =>
      execute(
        helm,
        [
          "template",
          "demo",
          "deploy/helm/openclaw-observability-demo",
          "--namespace",
          "oce-observability-demo",
          ...[
            "occ.namespace=openclaw-system",
            "occ.release=oce",
            "cluster.cidrs[0]=10.43.0.1/32",
            "grafana.adminSecretName=grafana-admin",
          ].flatMap((value) => ["--set", value]),
          ...sets,
        ],
        { cwd: repository, maxBuffer: 2_000_000 },
      );
    for (const path of ["cluster.port", "occ.metricsPort"]) {
      for (const port of ["0", "010", "65536", "99999999999999999999"]) {
        await assert.rejects(
          render(["--set-string", `${path}=${port}`]),
          ({ stderr }) => stderr.includes(`${path} must be an integer TCP port from 1 to 65535`),
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
    const render = (cidr) =>
      execute(
        helm,
        [
          "template",
          "demo",
          "deploy/helm/openclaw-observability-demo",
          "--namespace",
          "oce-observability-demo",
          "--set",
          "occ.namespace=openclaw-system",
          "--set",
          "occ.release=oce",
          "--set",
          "grafana.adminSecretName=grafana-admin",
          "--set",
          `cluster.cidrs[0]=${cidr}`,
        ],
        { cwd: repository, maxBuffer: 2_000_000 },
      );
    for (const cidr of ["999.1.2.3/32", "010.0.0.1/32", "10.43.0.1/24", "not-a-cidr"]) {
      await assert.rejects(
        render(cidr),
        ({ stderr }) => stderr.includes("cluster.cidrs requires exact IPv4 /32 endpoints"),
        cidr,
      );
    }
    const { stdout } = await render("10.43.0.1/32");
    assert.match(stdout, /cidr: 10\.43\.0\.1\/32/);
  },
);
