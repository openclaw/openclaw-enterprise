#!/usr/bin/env node
// Builds and reads the one-shot Pods that scripts/upgrade-production-images runs
// before it stops OCC: the selected controller image loads the candidate
// Installation exactly as the API and worker do at startup, without a database.
import { readFileSync } from "node:fs";

// Runs inside the controller image. It reads OCC_CONFIG_PATH and the chart's
// environment, loads Drivers and Preset files, and never opens the database.
const startupCheck = `
try {
  const { loadInstallationConfiguration, loadStartupConfigurationSnapshot } = await import(
    "/app/apps/controller/src/composition/installation-config.ts"
  );
  const startupConfiguration = await loadStartupConfigurationSnapshot({ mode: "production" });
  await loadInstallationConfiguration({ mode: "production", startupConfiguration });
  process.stdout.write("installation-startup-ready\\n");
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\\n");
  process.exit(1);
}
`;

const labels = (release) => ({
  "app.kubernetes.io/name": "openclaw-enterprise",
  "app.kubernetes.io/instance": release,
  "app.kubernetes.io/component": "upgrade-preflight",
});

function fail(message) {
  process.stderr.write(`upgrade-startup-preflight: ${message}\n`);
  process.exit(1);
}

// `yq -o=json -I=0 '.'` prints one compact JSON document per line.
function documents(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0 && line.trim() !== "---")
    .map((line) => JSON.parse(line))
    .filter((document) => document !== null && typeof document === "object");
}

// The Secret holds only the candidate Installation, under the chart's key.
function secret([installationPath, key, name, namespace, release]) {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name, namespace, labels: labels(release) },
    type: "Opaque",
    data: { [key]: readFileSync(installationPath).toString("base64") },
  };
}

const podFields = [
  "serviceAccountName",
  "automountServiceAccountToken",
  "securityContext",
  "nodeSelector",
  "tolerations",
  "affinity",
  "imagePullSecrets",
  "hostAliases",
  "dnsPolicy",
  "dnsConfig",
];
const containerFields = [
  "name",
  "image",
  "workingDir",
  "env",
  "envFrom",
  "volumeMounts",
  "securityContext",
  "resources",
];

// One Pod per component, copied from the rendered candidate Deployment: the same
// image, environment, mounts, service account and placement, with the Installation
// volume pointed at the temporary candidate Secret. Probes, ports and the chart's
// other containers are left out; the Pod runs the startup check once.
function pod([
  renderedPath,
  component,
  name,
  namespace,
  release,
  installationSecret,
  candidateSecret,
  image,
  timeoutSeconds,
]) {
  const deployments = documents(renderedPath).filter(
    (document) =>
      document.kind === "Deployment" &&
      document.metadata?.name === `openclaw-enterprise-${component}`,
  );
  if (deployments.length !== 1) {
    fail(
      `the rendered chart must contain exactly one openclaw-enterprise-${component} Deployment.`,
    );
  }
  const spec = deployments[0].spec?.template?.spec ?? {};
  const matches = [...(spec.containers ?? []), ...(spec.initContainers ?? [])].filter(
    (container) => container.name === component,
  );
  if (matches.length !== 1) {
    fail(`the rendered ${component} Deployment must contain exactly one ${component} container.`);
  }
  if (matches[0].image !== image) {
    fail(`the rendered ${component} container does not select the selected controller image.`);
  }
  const container = Object.fromEntries(
    containerFields
      .filter((field) => field in matches[0])
      .map((field) => [field, matches[0][field]]),
  );
  // The image entrypoint is node; name it so a chart command cannot change the check.
  container.command = ["node"];
  container.args = ["--input-type=module", "-e", startupCheck];
  const mounted = new Set((container.volumeMounts ?? []).map((mount) => mount.name));
  const volumes = structuredClone(
    (spec.volumes ?? []).filter((volume) => mounted.has(volume.name)),
  );
  const installation = volumes.filter((volume) => volume.secret?.secretName === installationSecret);
  if (installation.length !== 1) {
    fail(`the rendered ${component} container must mount the Installation Secret once.`);
  }
  installation[0].secret.secretName = candidateSecret;
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name, namespace, labels: labels(release) },
    spec: {
      ...Object.fromEntries(
        podFields.filter((field) => field in spec).map((field) => [field, spec[field]]),
      ),
      restartPolicy: "Never",
      activeDeadlineSeconds: Number(timeoutSeconds),
      enableServiceLinks: false,
      containers: [container],
      volumes,
    },
  };
}

// Prints Succeeded, Failed, Stuck:<reason> for a waiting state that never resolves
// without operator action, Pending:<reason> while the Pod cannot be scheduled (an
// autoscaler may still add capacity), or Running.
function phase([statusPath]) {
  const status = JSON.parse(readFileSync(statusPath, "utf8")).status ?? {};
  if (status.phase === "Succeeded" || status.phase === "Failed") {
    return status.phase;
  }
  for (const container of status.containerStatuses ?? []) {
    const reason = container.state?.waiting?.reason;
    if (
      [
        "ErrImagePull",
        "ImagePullBackOff",
        "InvalidImageName",
        "CreateContainerConfigError",
        "CreateContainerError",
      ].includes(reason)
    ) {
      return `Stuck:${reason}`;
    }
  }
  const unscheduled = (status.conditions ?? []).find(
    (condition) => condition.type === "PodScheduled" && condition.status === "False",
  );
  if (unscheduled !== undefined) {
    const message = String(unscheduled.message ?? "")
      .replace(/\s+/g, " ")
      .slice(0, 300);
    return `Pending:${unscheduled.reason ?? "Unschedulable"}: ${message}`;
  }
  return "Running";
}

const [action, ...input] = process.argv.slice(2);
const actions = {
  secret: [5, (values) => JSON.stringify(secret(values))],
  pod: [9, (values) => JSON.stringify(pod(values))],
  phase: [1, phase],
};
if (!(action in actions) || input.length !== actions[action][0]) {
  fail("expected secret, pod, or phase with its arguments.");
}
process.stdout.write(`${actions[action][1](input)}\n`);
