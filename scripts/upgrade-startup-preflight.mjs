#!/usr/bin/env node
// Builds and reads the one-shot Jobs that scripts/upgrade-production-images runs
// before it stops OCC: the selected controller image loads the candidate
// Installation and runs the bundled Kubernetes Compute preflight exactly as the
// API and worker do at startup, and checks migration compatibility against the database.
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
const idVariable = "OCC_UPGRADE_PREFLIGHT_INSTALLATION_ID";
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

const identityCheck = `
// Use the candidate's connection owner, including its TLS and credential handling.
// This module predates the upgrade helper. Do not bootstrap or construct State:
// this check must also work before the candidate's migrations have been applied.
let identityPool;
let identityClient;
let identityMismatch = false;
const identityFailure = () => {
  process.stderr.write(identityMismatch
    ? "Candidate application database does not identify the incumbent Installation.\\n"
    : "Candidate application database Installation identity could not be verified.\\n");
  process.exit(1);
};
// Older pool helpers do not honor every timeout option. Bound the whole operation,
// including authentication and cleanup, independently of that historical ABI.
const identityDeadline = setTimeout(identityFailure, 15000);
try {
  const expectedId = JSON.parse(process.env.${idVariable});
  if (typeof expectedId !== "string" || expectedId.length === 0 ||
      typeof process.env.OCC_DATABASE_URL !== "string" || !process.env.OCC_DATABASE_URL.trim()) {
    throw new Error();
  }
  if (!["postgres:", "postgresql:"].includes(new URL(process.env.OCC_DATABASE_URL).protocol)) {
    throw new Error();
  }
  const { createPostgresPool } = await import("/app/packages/occ/src/state/postgres-pool.ts");
  identityPool = await createPostgresPool(process.env.OCC_DATABASE_URL, { max: 1 });
  identityClient = await identityPool.connect();
  identityClient.on("error", identityFailure);
  // BEGIN precedes all reads, even if the supplied role normally has write access.
  await identityClient.query("BEGIN READ ONLY");
  await identityClient.query("SET LOCAL statement_timeout = '5s'");
  await identityClient.query("SET LOCAL lock_timeout = '5s'");
  const { rows } = await identityClient.query("SELECT id FROM occ.installation LIMIT 2");
  if (rows.length !== 1 || rows[0].id !== expectedId) {
    identityMismatch = true;
    throw new Error();
  }
  await identityClient.query("ROLLBACK");
  identityClient.release(true);
  identityClient = undefined;
  await identityPool.end();
} catch {
  // Never include connection details, database rows, or internal error messages.
  try { identityClient?.release(true); } catch {}
  identityFailure();
}
clearTimeout(identityDeadline);
`;

// Runs inside the controller image. It reads OCC_CONFIG_PATH and the chart's
// environment, loads Drivers and Preset files, and reads the database identity.
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
// resolver and values-only rules on the stored Configuration, so a
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
    // The resolver predates the shared settings rules. A missing or broken resolver in an
    // image with those rules is an incomplete check, not the older-image absence path.
    let resolveConfiguredHarnessId;
    try {
      ({ resolveConfiguredHarnessId } = await import("/app/packages/occ/src/configured-harness.ts"));
      if (typeof resolveConfiguredHarnessId !== "function") {
        throw new Error("missing resolver");
      }
    } catch {
      process.stderr.write("Agent draft check could not load the configured Harness resolver.\\n");
      process.exit(1);
    }
    let refused = false;
    for (const agent of drafts.agents) {
      try {
        resolveConfiguredHarnessId(drafts.configurations[agent.configurationId]);
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
${identityCheck}
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

// Only the chart-owned preload and CA assembler may survive replacing the server
// entrypoint. Never execute an arbitrary command from a rendered Deployment.
function connectionPlan(spec, container, component, check) {
  const refuse = () => fail("the rendered application connection prerequisites are unsupported.");
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const entrypoint = `apps/controller/src/${component === "api" ? "server" : "worker"}.mjs`;
  const assemblers = (spec.initContainers ?? []).filter(({ name }) => name === "assemble-api-ca");
  if (container.command !== undefined && !same(container.command, ["node"])) {
    refuse();
  }
  const plainArgs = ["--input-type=module", "-e", check];
  if (same(container.args, [entrypoint])) {
    if (assemblers.length || container.env?.some(({ name }) => name === "OCC_DATABASE_CA_SOURCE")) {
      refuse();
    }
    return { args: plainArgs, initContainers: [] };
  }
  const source = (name) =>
    readFileSync(
      new URL(`../deploy/helm/openclaw-enterprise/files/${name}`, import.meta.url),
      "utf8",
    );
  const preload = `data:text/javascript;base64,${Buffer.from(source("check-api-database-ca.mjs")).toString("base64")}`;
  const args = container.args ?? [];
  const caPath = args[3];
  const caMounts = (container.volumeMounts ?? []).filter(
    ({ name, mountPath, readOnly }) =>
      name === "database-ca" && readOnly === true && typeof mountPath === "string",
  );
  if (
    component !== "api" ||
    args.length !== 4 ||
    args[0] !== "--import" ||
    args[1] !== preload ||
    args[2] !== entrypoint ||
    caMounts.length !== 1 ||
    assemblers.length !== 1
  ) {
    refuse();
  }
  const caVolume = (spec.volumes ?? []).find(({ name }) => name === caMounts[0].name);
  const caDirectory = caMounts[0].mountPath.replace(/\/$/, "");
  if (!caVolume?.secret?.items?.some(({ path }) => caPath === `${caDirectory}/${path}`)) {
    refuse();
  }
  const assembler = assemblers[0];
  const output = "/etc/openclaw/api-extra-ca/ca.crt";
  const inputs = ["/etc/openclaw/oidc-ca/ca.crt"];
  if (assembler.volumeMounts?.some(({ name }) => name === "gateway-ca")) {
    inputs.push("/etc/openclaw/gateway-ca/ca.crt");
  }
  if (
    assembler.image !== container.image ||
    !same(assembler.command, ["node"]) ||
    !same(assembler.args, [
      "--input-type=module",
      "-e",
      source("assemble-api-ca.mjs"),
      output,
      ...inputs,
    ]) ||
    assembler.volumeMounts?.length !== inputs.length + 1 ||
    assembler.envFrom?.length ||
    assembler.env?.some(
      ({ name, value }) => name !== "OCC_CA_SOURCES" || typeof value !== "string",
    ) ||
    !container.env?.some(({ name, value }) => name === "NODE_EXTRA_CA_CERTS" && value === output)
  ) {
    refuse();
  }
  for (const path of [output, ...inputs]) {
    const mounts = (assembler.volumeMounts ?? []).filter(({ mountPath }) =>
      path.startsWith(`${mountPath}/`),
    );
    const volume =
      mounts.length === 1 && (spec.volumes ?? []).find(({ name }) => name === mounts[0].name);
    if (
      !volume ||
      (path === output ? !volume.emptyDir : !volume.secret || mounts[0].readOnly !== true)
    ) {
      refuse();
    }
  }
  const outputMount = assembler.volumeMounts.find(({ mountPath }) =>
    output.startsWith(`${mountPath}/`),
  );
  if (
    !container.volumeMounts?.some(
      ({ name, mountPath, readOnly }) =>
        name === outputMount.name && mountPath === outputMount.mountPath && readOnly === true,
    )
  ) {
    refuse();
  }
  // With -e, argv[1] is the first trailing argument. Keep the chart's CA at
  // argv[2], exactly where its preload reads it before this program executes.
  return {
    args: ["--import", preload, ...plainArgs, "--", entrypoint, caPath],
    initContainers: [
      Object.fromEntries(
        [...containerFields, "command", "args"]
          .filter((field) => field in assembler)
          .map((field) => [field, assembler[field]]),
      ),
    ],
  };
}

// Reuse the initialization Job's database identity and mounted CA, but run only
// the candidate's read-only compatibility check. Never copy bootstrap or other
// init containers into a preflight that runs while the incumbent is serving.
function migrationJob(renderedPath, name, namespace, release, image, timeoutSeconds) {
  const jobs = documents(renderedPath).filter(
    (document) =>
      document.kind === "Job" &&
      document.metadata?.labels?.["app.kubernetes.io/instance"] === release &&
      document.metadata?.labels?.["app.kubernetes.io/component"] === "initialization",
  );
  if (jobs.length !== 1) {
    fail("the rendered chart must contain exactly one initialization Job.");
  }
  const template = jobs[0].spec?.template;
  const spec = template?.spec ?? {};
  const matches = (spec.initContainers ?? []).filter((container) => container.name === "migration");
  if (matches.length !== 1 || matches[0].image !== image) {
    fail("the initialization Job must contain one migration container using the selected image.");
  }
  const container = Object.fromEntries(
    containerFields
      .filter((field) => field in matches[0])
      .map((field) => [field, matches[0][field]]),
  );
  container.command = ["node"];
  container.args = ["scripts/migrate-production.mjs", "--check"];
  const mounted = new Set((container.volumeMounts ?? []).map((mount) => mount.name));
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name, namespace, labels: jobs[0].metadata.labels },
    spec: {
      backoffLimit: 0,
      completions: 1,
      parallelism: 1,
      activeDeadlineSeconds: Number(timeoutSeconds),
      template: {
        metadata: { labels: template.metadata.labels },
        spec: {
          ...Object.fromEntries(
            podFields.filter((field) => field in spec).map((field) => [field, spec[field]]),
          ),
          restartPolicy: "Never",
          activeDeadlineSeconds: Number(timeoutSeconds),
          enableServiceLinks: false,
          containers: [container],
          volumes: (spec.volumes ?? []).filter((volume) => mounted.has(volume.name)),
        },
      },
    },
  };
}

// One Job per component uses the rendered Deployment's image, environment, mounts,
// service account and placement, with the Installation
// volume pointed at the temporary candidate Secret. Probes, ports and the chart's
// other containers are left out; the Pod runs the startup check once. The stored
// Installation name and ID come from the helper's `occ installation get` output.
function job(
  [
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
  ],
  check = startupCheck,
) {
  if (component === "migration") {
    return migrationJob(renderedPath, name, namespace, release, image, timeoutSeconds);
  }
  const { name: storedName, id: storedId } = JSON.parse(
    readFileSync(storedInstallationPath, "utf8"),
  );
  if (typeof storedName !== "string") {
    fail("OCC did not return the stored Installation name.");
  }
  if (typeof storedId !== "string" || storedId.length === 0) {
    fail("OCC did not return the stored Installation ID.");
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
  const plan = connectionPlan(spec, matches[0], component, check);
  container.args = plan.args;
  // JSON keeps any control character in the name intact through the environment.
  // Kubernetes expands $(VAR) and turns $$ into $ in env values; doubling every $
  // makes it deliver the name unchanged.
  container.env = [
    ...(container.env ?? []).filter(
      (variable) =>
        ![nameVariable, idVariable, componentVariable, draftsVariable].includes(variable.name),
    ),
    { name: nameVariable, value: JSON.stringify(storedName).replaceAll("$", () => "$$") },
    { name: idVariable, value: JSON.stringify(storedId).replaceAll("$", () => "$$") },
    { name: componentVariable, value: component },
  ];
  const mounted = new Set(
    [container, ...plan.initContainers].flatMap((item) =>
      (item.volumeMounts ?? []).map((mount) => mount.name),
    ),
  );
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
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name, namespace, labels: labels(release) },
    spec: {
      backoffLimit: 0,
      completions: 1,
      parallelism: 1,
      activeDeadlineSeconds: Number(timeoutSeconds),
      template: {
        metadata: { labels: labels(release) },
        spec: {
          ...Object.fromEntries(
            podFields.filter((field) => field in spec).map((field) => [field, spec[field]]),
          ),
          restartPolicy: "Never",
          activeDeadlineSeconds: Number(timeoutSeconds),
          enableServiceLinks: false,
          containers: [container],
          ...(plan.initContainers.length ? { initContainers: plan.initContainers } : {}),
          volumes,
        },
      },
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

// Labels discover candidates; only the actual Job controller reference establishes ownership.
function ownedPods(document, jobUid) {
  if (!Array.isArray(document.items)) {
    fail("cannot read startup preflight child Pods.");
  }
  const pods = document.items.filter(
    (pod) =>
      Array.isArray(pod.metadata?.ownerReferences) &&
      pod.metadata.ownerReferences.some(
        (owner) =>
          owner.apiVersion === "batch/v1" &&
          owner.kind === "Job" &&
          owner.controller === true &&
          owner.uid === jobUid,
      ),
  );
  if (pods.length !== document.items.length) {
    fail("startup preflight Pod labels do not match its controller ownership.");
  }
  return pods;
}

function child([jobPath, jobUid, podsPath, previousUid]) {
  const job = JSON.parse(readFileSync(jobPath, "utf8"));
  if (job.metadata?.uid !== jobUid) {
    fail("startup preflight Job identity changed.");
  }
  const pods = ownedPods(JSON.parse(readFileSync(podsPath, "utf8")), jobUid);
  if (pods.length > 1) {
    fail("startup preflight Job created more than one child Pod.");
  }
  if (pods.length === 0) {
    if (previousUid) {
      fail("startup preflight child Pod disappeared.");
    }
    if (
      job.status?.conditions?.some(
        (condition) =>
          ["Failed", "Complete"].includes(condition.type) && condition.status === "True",
      )
    ) {
      fail("startup preflight Job ended without its child Pod evidence.");
    }
    return "";
  }
  const pod = pods[0];
  if (
    typeof pod.metadata.name !== "string" ||
    !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(pod.metadata.name) ||
    typeof pod.metadata.uid !== "string" ||
    !pod.metadata.uid ||
    /[\s\p{C}]/u.test(pod.metadata.uid) ||
    pod.metadata.namespace !== job.metadata.namespace ||
    !pod.metadata.ownerReferences.some(
      (owner) =>
        owner.apiVersion === "batch/v1" &&
        owner.kind === "Job" &&
        owner.controller === true &&
        owner.uid === jobUid &&
        owner.name === job.metadata.name,
    ) ||
    (previousUid && pod.metadata.uid !== previousUid)
  ) {
    fail("startup preflight child Pod identity changed or is invalid.");
  }
  return JSON.stringify(pod);
}

function remaining([jobPath, jobUid, podsPath, childPath, childUid]) {
  const jobText = readFileSync(jobPath, "utf8").trim();
  const job = jobText ? JSON.parse(jobText) : undefined;
  const childText = readFileSync(childPath, "utf8").trim();
  const pod = childText ? JSON.parse(childText) : undefined;
  // A present replacement is not an absence receipt for the saved consumer.
  if ((job && job.metadata?.uid !== jobUid) || (pod && pod.metadata?.uid !== childUid)) {
    fail("startup preflight consumer identity changed during cleanup.");
  }
  return String(
    Boolean(
      job?.metadata?.uid === jobUid ||
      ownedPods(JSON.parse(readFileSync(podsPath, "utf8")), jobUid).length ||
      (childUid && pod?.metadata?.uid === childUid),
    ),
  );
}

// Prints Succeeded only after Job completion, Failed or JobFailed on failure,
// Stuck:<reason> when operator action is required, Pending:<reason> while the Pod
// cannot be scheduled (an autoscaler may add capacity), or Running.
function phase([statusPath, jobPath]) {
  const status = JSON.parse(readFileSync(statusPath, "utf8")).status ?? {};
  const conditions = JSON.parse(readFileSync(jobPath, "utf8")).status?.conditions ?? [];
  // Preserve failed-child diagnostics, but never let a successful child override its Job.
  if (status.phase === "Failed") {
    return "Failed";
  }
  if (
    conditions.some(
      (condition) =>
        ["Failed", "FailureTarget"].includes(condition.type) && condition.status === "True",
    )
  ) {
    return "JobFailed";
  }
  if (status.phase === "Succeeded") {
    return conditions.some(
      (condition) => condition.type === "Complete" && condition.status === "True",
    )
      ? "Succeeded"
      : "Running";
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
  job: [11, (values) => JSON.stringify(job(values))],
  "identity-job": [
    11,
    (values) =>
      JSON.stringify(
        job(values, identityCheck + 'process.stdout.write("installation-startup-ready\\n");'),
      ),
  ],
  child: [4, child],
  remaining: [5, remaining],
  refusals: [1, refusals],
  networkpolicy: [4, (values) => JSON.stringify(networkPolicy(values))],
  phase: [2, phase],
};
if (!(action in actions) || input.length !== actions[action][0]) {
  fail(
    "expected drafts, secret, job, identity-job, child, remaining, refusals, networkpolicy, or phase with its arguments.",
  );
}
process.stdout.write(`${actions[action][1](input)}\n`);
