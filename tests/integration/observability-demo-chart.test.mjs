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
