#!/usr/bin/env node
// Builds and reads the one-shot Pods that scripts/upgrade-production-images runs
// before it stops OCC: the selected controller image loads the candidate
// Installation and runs the bundled Kubernetes Compute preflight exactly as the
// API and worker do at startup, without a database.
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

// Printed before the image's own message when Compute preflight stops startup:
// a refusal is the Driver's ConfigurationFailure (such as split-layout storage);
// anything else, such as a denied or unreachable Kubernetes API, is incomplete.
const computeRefusal = "Kubernetes Compute startup preflight refused the candidate release:";
const computeIncomplete = "Kubernetes Compute startup preflight could not complete:";
// Printed when the stored Installation name breaks the image's Name rule; the
// controller's own startup refusal uses the same words.
const nameRefusal = "The stored Installation name breaks the Name rule:";
const nameVariable = "OCC_UPGRADE_PREFLIGHT_INSTALLATION_NAME";
// Names the component (api or worker) whose credentials and grants the Pod checks.
const componentVariable = "OCC_UPGRADE_PREFLIGHT_COMPONENT";
// The saved draft of each Agent the upgrade deploys (finding 2809): the API Pod reads it from
// the temporary Secret, gzipped, under this key and path.
const draftsKey = "agent-drafts.json.gz";
const draftsDirectory = "/var/run/openclaw/upgrade-preflight";
const draftsVariable = "OCC_UPGRADE_PREFLIGHT_AGENT_DRAFTS";
// Printed before each Agent whose draft the image's deploy admission would refuse, with the
// Agent and OCC's message as one JSON object.
const draftRefusal = "Agent draft refused:";
// Kubernetes refuses a Secret whose values exceed 1 MiB in total. The preflight Secret holds the
// candidate Installation and the drafts, so the drafts get what the Installation leaves.
const secretLimitBytes = 1024 * 1024;

// Runs inside the controller image. It reads OCC_CONFIG_PATH and the chart's
// environment, loads Drivers and Preset files, and never opens the database.
// With the bundled Kubernetes Compute Driver it then runs that Driver's startup
// preflight, which reads the Kubernetes version and Namespaces with the Pod's
// service account; it refuses, for example, single-cluster split-layout storage.
// Other Compute Drivers keep the load-only check.
const startupCheck = `
let drivers;
let formatConfigurationFailure;
try {
  ({ formatStartupConfigurationFailure: formatConfigurationFailure } = await import(
    "/app/apps/controller/src/startup-failure.ts"
  ));
  if (process.env.${componentVariable} === "api" && process.env.OCC_CONSOLE_THEME_DIR !== undefined) {
    const { loadConsoleTheme } = await import("/app/apps/controller/src/composition/console-theme.ts");
    await loadConsoleTheme(process.env.OCC_CONSOLE_THEME_DIR);
  }
  const { loadInstallationConfiguration, loadStartupConfigurationSnapshot } = await import(
    "/app/apps/controller/src/composition/installation-config.ts"
  );
  const startupConfiguration = await loadStartupConfigurationSnapshot({ mode: "production" });
  drivers = await loadInstallationConfiguration({ mode: "production", startupConfiguration });
} catch (error) {
  process.stderr.write((formatConfigurationFailure?.(error) ?? (error instanceof Error ? error.message : String(error))) + "\\n");
  process.exit(1);
}
try {
  const { KubernetesComputeDriver } = await import(
    "/app/apps/controller/src/drivers/compute/kubernetes/index.ts"
  );
  if (drivers?.computeDriver instanceof KubernetesComputeDriver) {
    await drivers.computeDriver.preflight();
    // Two-cluster profile: the component's tenant grants in the execution cluster,
    // which a separate openclaw-execution release owns. Older images skip it.
    if (typeof drivers.computeDriver.verifyExecutionTenantGrants === "function") {
      await drivers.computeDriver.verifyExecutionTenantGrants(
        process.env.${componentVariable},
        { runtimeLogs: process.env.OCC_AGENT_RUNTIME_LOGS_ENABLED !== "false" },
      );
    }
    process.stdout.write("kubernetes-compute-preflight-passed\\n");
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const refused = error?.constructor?.name === "ConfigurationFailure";
  process.stderr.write(
    (refused ? ${JSON.stringify(computeRefusal)} : ${JSON.stringify(computeIncomplete)}) +
      " " +
      message +
      "\\n",
  );
  process.exit(1);
}
// The stored Installation name, read through OCC before the preflight. The API and
// worker load it from the database and refuse to start when it breaks this image's
// Name rule (INSTALLATION_NAME_INVALID). An image without the rule skips the check.
let contracts;
try {
  contracts = await import("/app/packages/contracts/src/index.ts");
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\\n");
  process.exit(1);
}
let storedName;
try {
  storedName = JSON.parse(process.env.${nameVariable});
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\\n");
  process.exit(1);
}
if (typeof contracts.isName === "function" && !contracts.isName(storedName)) {
  process.stderr.write(
    ${JSON.stringify(nameRefusal)} + " " + contracts.NAME_RULE + ".\\n",
  );
  process.exit(1);
}
// Each Agent the upgrade deploys, with its saved Configuration. Deploy admission runs these
// values-only rules on the stored Configuration (refuseUndeployableConfigurationValues), so a
// draft saved before one of this image's rules would stop the fleet deploy after the controller
// moved. Every refused Agent is printed. An image without the shared rules skips the check.
if (process.env.${draftsVariable} !== undefined) {
  let drafts;
  let settings;
  try {
    const { readFileSync } = await import("node:fs");
    const { gunzipSync } = await import("node:zlib");
    drafts = JSON.parse(gunzipSync(readFileSync(process.env.${draftsVariable})).toString("utf8"));
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\\n");
    process.exit(1);
  }
  try {
    settings = await import("/app/packages/occ/src/configuration-settings.ts");
  } catch {
    settings = {};
  }
  if (typeof settings.refuseUndeployableConfigurationValues !== "function") {
    process.stdout.write("agent-draft-check-unavailable\\n");
  } else {
    let refused = false;
    for (const agent of drafts.agents) {
      try {
        settings.refuseUndeployableConfigurationValues(
          drafts.configurations[agent.configurationId],
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stdout.write(
          ${JSON.stringify(draftRefusal)} + " " + JSON.stringify({ ...agent, message }) + "\\n",
        );
        refused = true;
      }
    }
    if (refused) {
      process.exit(1);
    }
    process.stdout.write("agent-drafts-accepted\\n");
  }
}
process.stdout.write("installation-startup-ready\\n");
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

// Gathers the helper's per-Agent drafts (one JSON line each: the Agent, its name and its saved
// Configuration) into one gzipped document, each Configuration once. Exits 3 when it would not
// fit in the preflight Secret beside the candidate Installation.
function drafts([draftsPath, installationPath, outputPath]) {
  const agents = [];
  const configurations = {};
  for (const line of readFileSync(draftsPath, "utf8").split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    const { namespaceId, agentId, name, configurationId, values } = JSON.parse(line);
    agents.push({ namespaceId, agentId, name, configurationId });
    configurations[configurationId] = values;
  }
  const document = gzipSync(JSON.stringify({ agents, configurations }));
  const installationBytes = readFileSync(installationPath).length;
  if (document.length + installationBytes > secretLimitBytes) {
    process.stderr.write(
      `upgrade-startup-preflight: ${agents.length} Agent drafts take ${document.length} bytes gzipped; with the ${installationBytes}-byte candidate Installation that is over the ${secretLimitBytes}-byte Secret limit.\n`,
    );
    process.exit(3);
  }
  writeFileSync(outputPath, document, { mode: 0o600 });
  return agents.length;
}

// The Secret holds the candidate Installation, under the chart's key, and the gzipped Agent
// drafts when the helper passes them (an empty path passes none).
function secret([installationPath, key, name, namespace, release, draftsPath]) {
  if (draftsPath !== "" && key === draftsKey) {
    fail(`the Installation key ${draftsKey} is reserved for the Agent drafts.`);
  }
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name, namespace, labels: labels(release) },
    type: "Opaque",
    data: {
      [key]: readFileSync(installationPath).toString("base64"),
      ...(draftsPath === "" ? {} : { [draftsKey]: readFileSync(draftsPath).toString("base64") }),
    },
  };
}

// The refused drafts in a failed API preflight log, one line each for the operator. Names and
// messages come from OCC; control characters are replaced so they cannot forge lines or
// terminal sequences.
function refusals([logPath]) {
  const printable = (value) => String(value).replace(/[\p{Cc}\u2028\u2029]/gu, "?");
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.startsWith(`${draftRefusal} `))
    .map((line) => {
      const agent = JSON.parse(line.slice(draftRefusal.length + 1));
      const name =
        typeof agent.name === "string" ? JSON.stringify(agent.name) : "(name unavailable)";
      return printable(
        `  - Agent ${agent.agentId} ${name} in Namespace ${agent.namespaceId}: ${agent.message}`,
      ).slice(0, 800);
    })
    .join("\n");
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
// other containers are left out; the Pod runs the startup check once. The stored
// Installation name comes from the helper's `occ installation get` output.
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
  storedInstallationPath,
  withDrafts,
]) {
  const storedName = JSON.parse(readFileSync(storedInstallationPath, "utf8")).name;
  if (typeof storedName !== "string") {
    fail("OCC did not return the stored Installation name.");
  }
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
  // JSON keeps any control character in the name intact through the environment.
  // Kubernetes expands $(VAR) and turns $$ into $ in env values; doubling every $
  // makes it deliver the name unchanged.
  container.env = [
    ...(container.env ?? []).filter(
      (variable) => ![nameVariable, componentVariable, draftsVariable].includes(variable.name),
    ),
    { name: nameVariable, value: JSON.stringify(storedName).replaceAll("$", () => "$$") },
    { name: componentVariable, value: component },
  ];
  const mounted = new Set((container.volumeMounts ?? []).map((mount) => mount.name));
  const volumes = structuredClone(
    (spec.volumes ?? []).filter((volume) => mounted.has(volume.name)),
  );
  const installation = volumes.filter((volume) => volume.secret?.secretName === installationSecret);
  if (installation.length !== 1) {
    fail(`the rendered ${component} container must mount the Installation Secret once.`);
  }
  installation[0].secret.secretName = candidateSecret;
  // The API Pod alone checks the Agent drafts: the worker would print the same refusals.
  if (withDrafts === "drafts" && component === "api") {
    const volume = "upgrade-preflight-agent-drafts";
    if (volumes.some((item) => item.name === volume)) {
      fail(`the rendered ${component} Deployment already has a ${volume} volume.`);
    }
    volumes.push({
      name: volume,
      secret: { secretName: candidateSecret, items: [{ key: draftsKey, path: draftsKey }] },
    });
    container.volumeMounts = [
      ...(container.volumeMounts ?? []),
      { name: volume, mountPath: draftsDirectory, readOnly: true },
    ];
    container.env.push({ name: draftsVariable, value: `${draftsDirectory}/${draftsKey}` });
  }
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

// The chart's default-deny policy also selects the preflight Pods. To reach the
// Kubernetes API for Compute preflight they get the egress the rendered candidate
// grants the API and worker for their dependencies (DNS, PostgreSQL, Kubernetes
// API, and the execution cluster API when enabled). The chart renders that policy
// beside its default-deny policy; prints null for a render without it.
function networkPolicy([renderedPath, name, namespace, release]) {
  const sources = documents(renderedPath).filter(
    (document) =>
      document.kind === "NetworkPolicy" &&
      [
        "openclaw-enterprise-dependency-egress",
        "openclaw-enterprise-execution-api-egress",
      ].includes(document.metadata?.name),
  );
  if (
    !sources.some((document) => document.metadata.name === "openclaw-enterprise-dependency-egress")
  ) {
    return null;
  }
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name, namespace, labels: labels(release) },
    spec: {
      podSelector: { matchLabels: labels(release) },
      policyTypes: ["Egress"],
      egress: structuredClone(sources.flatMap((document) => document.spec?.egress ?? [])),
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
  drafts: [3, drafts],
  secret: [6, (values) => JSON.stringify(secret(values))],
  pod: [11, (values) => JSON.stringify(pod(values))],
  refusals: [1, refusals],
  networkpolicy: [4, (values) => JSON.stringify(networkPolicy(values))],
  phase: [1, phase],
};
if (!(action in actions) || input.length !== actions[action][0]) {
  fail("expected drafts, secret, pod, refusals, networkpolicy, or phase with its arguments.");
}
process.stdout.write(`${actions[action][1](input)}\n`);
