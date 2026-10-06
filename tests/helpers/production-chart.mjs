import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const helm = process.env.OCC_HELM_BIN ?? "helm";
/** `test` options: skip unless Helm and yq can render the production chart. */
export async function chartTooling() {
  try {
    await execute(helm, ["version", "--short"], { cwd: repository });
    await execute("yq", ["--version"], { cwd: repository });
    return { skip: false };
  } catch {
    return { skip: "Install Helm and yq, or set OCC_HELM_BIN, to render the production chart." };
  }
}

export const productionValues = {
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

export const productionCollectorValues = {
  "logging.collector.enabled": "true",
  "logging.collector.image":
    "docker.io/otel/opentelemetry-collector-contrib:0.159.0@sha256:1f2c54a30e713fac6b3ae77a1ec84010c2007e29ced8ec666214fc2f6739c1cc",
  "logging.collector.configSecretName": "occ-otel-collector-config",
  "logging.collector.envSecretName": "occ-otel-collector-exporter",
  "logging.collector.exporter.cidr": "203.0.113.10/32",
};

export async function renderProductionChart(overrides = {}, options = {}) {
  const args = [
    "template",
    options.release ?? "oce",
    "deploy/helm/openclaw-enterprise",
    "--namespace",
    options.namespace ?? "openclaw-system",
  ];
  if (options.isUpgrade) {
    args.push("--is-upgrade");
  }
  for (const [key, value] of Object.entries({ ...productionValues, ...overrides })) {
    args.push("--set", `${key}=${value}`);
  }
  for (const [key, value] of Object.entries(options.strings ?? {})) {
    args.push("--set-string", `${key}=${value}`);
  }
  return execute(helm, args, { cwd: repository, maxBuffer: 2_000_000 });
}

export async function parseProductionChart(manifests) {
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
