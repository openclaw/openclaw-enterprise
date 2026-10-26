import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const helm = process.env.OCC_HELM_BIN ?? "helm";

/**
 * The environment for the short-lived Helm and yq (Go) processes the chart tests start, often
 * hundreds per file. With GOGC=off they skip garbage collection: Helm collects five times
 * during startup alone, and one render peaks at about 55 MB either way.
 */
export function goToolEnvironment() {
  return { ...process.env, GOGC: "off" };
}
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

// `helm template` without a cluster is deterministic (the chart uses no random or time
// functions, and `lookup` finds nothing), so equal arguments and values-file contents give
// the same result. Many cases render the same values more than once; they share one render.
const renders = new Map();

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
  for (const file of options.valuesFiles ?? []) {
    args.push("--values", file);
  }
  // `omit` drops a --set (a default or an override) so a values file can supply that key,
  // such as an empty list.
  for (const [key, value] of Object.entries({ ...productionValues, ...overrides })) {
    if (options.omit?.includes(key)) {
      continue;
    }
    args.push("--set", `${key}=${value}`);
  }
  for (const [key, value] of Object.entries(options.strings ?? {})) {
    args.push("--set-string", `${key}=${value}`);
  }
  let key;
  try {
    key = JSON.stringify([
      args,
      (options.valuesFiles ?? []).map((file) => readFileSync(resolve(repository, file), "utf8")),
    ]);
  } catch {
    // An unreadable values file: let Helm report it, uncached.
  }
  let render = key === undefined ? undefined : renders.get(key);
  if (render === undefined) {
    render = execute(helm, args, {
      cwd: repository,
      env: goToolEnvironment(),
      maxBuffer: 2_000_000,
    }).then((result) => Object.freeze(result));
    if (key !== undefined) {
      renders.set(key, render);
    }
  }
  return render;
}

/**
 * Synchronous `helm template` of the chart with a rendered Installation profile's
 * `values.yaml` (`output.directory`), then `extraValueFiles`, then `extraArgs`. Returns the
 * manifests; a refused render throws execFileSync's error, with Helm's stderr.
 */
export function helmTemplate(output, extraValueFiles = [], releaseName = "oce", extraArgs = []) {
  return execFileSync(
    helm,
    [
      "template",
      releaseName,
      "deploy/helm/openclaw-enterprise",
      "--namespace",
      "openclaw-system",
      "--values",
      join(output.directory, "values.yaml"),
      ...extraValueFiles.flatMap((path) => ["--values", path]),
      ...extraArgs,
    ],
    {
      cwd: repository,
      env: goToolEnvironment(),
      encoding: "utf8",
      maxBuffer: 2_000_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

export async function parseProductionChart(manifests) {
  const parsed = await new Promise((resolve, reject) => {
    const child = execFile(
      "yq",
      ["eval-all", "-o=json", "-I=0", ".", "-"],
      { cwd: repository, env: goToolEnvironment(), maxBuffer: 2_000_000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin.end(manifests);
  });
  return parsed.trim().split("\n").map(JSON.parse);
}

/**
 * `helm template` of the openclaw-execution chart with the routing values it requires, then
 * `extraArgs` (such as "--set", "dns.namespace=true"). A refused render rejects with Helm's stderr.
 */
export function renderExecutionChart(...extraArgs) {
  return execute(
    helm,
    [
      "template",
      "oce",
      "deploy/helm/openclaw-execution",
      "--set",
      "routing.hostname=agents.example.invalid",
      "--set",
      "routing.gatewayClassName=private-envoy-gateway",
      "--set",
      "routing.tlsSecretName=agents-tls",
      "--set-json",
      'routing.controlPlaneCidrs=["198.51.100.0/24"]',
      ...extraArgs,
    ],
    { cwd: repository, env: goToolEnvironment(), maxBuffer: 2_000_000 },
  );
}
