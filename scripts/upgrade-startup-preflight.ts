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
  const auth = drivers?.installation?.backend?.find(({ type }) => type === "openshell")?.configuration.auth;
  if (auth?.mode === "bearerTokenFile") {
    const { access, constants, stat } = await import("node:fs/promises");
    try {
      if (!(await stat(auth.path)).isFile()) throw new Error();
      await access(auth.path, constants.R_OK);
    } catch {
      throw new Error("OpenShell bearer token file must be readable in this Pod.");
    }
  }
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

type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue | undefined };
type Labels = Record<string, string | null>;
type AgentDraftIdentity = {
  namespaceId: JsonValue | undefined;
  agentId: JsonValue | undefined;
  name: JsonValue | undefined;
  configurationId: JsonValue | undefined;
};

type NamedReference = JsonObject & { name: string };
type KeyPath = JsonObject & { path: string };
type VolumeMount = NamedReference & { mountPath: string; readOnly?: boolean | null };
type Volume = NamedReference & {
  secret?: (JsonObject & { secretName?: string | null; items?: KeyPath[] | null }) | null;
};
type EnvironmentVariable = NamedReference & { value?: JsonValue };
type Container = NamedReference & {
  image?: string;
  workingDir?: JsonValue;
  command?: JsonValue;
  args?: JsonValue;
  env?: EnvironmentVariable[] | null;
  envFrom?: JsonValue[] | null;
  volumeMounts?: VolumeMount[] | null;
  securityContext?: JsonValue;
  resources?: JsonValue;
};
type PreflightPodSpec = Partial<Pick<JsonObject, (typeof podFields)[number]>> & {
  containers: [Container];
  initContainers?: Container[];
  volumes: Volume[];
  restartPolicy: "Never";
  activeDeadlineSeconds: number;
  enableServiceLinks: false;
};
type JobManifest = {
  apiVersion: "batch/v1";
  kind: "Job";
  metadata: { name: string; namespace: string; labels: Labels };
  spec: {
    backoffLimit: 0;
    completions: 1;
    parallelism: 1;
    activeDeadlineSeconds: number;
    template: { metadata: { labels: Labels | null | undefined }; spec: PreflightPodSpec };
  };
};

type OwnedPod = JsonObject & { metadata: JsonObject & { ownerReferences: JsonValue[] } };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function arrayOf<T>(value: unknown, item: (value: unknown) => value is T): value is T[] {
  return Array.isArray(value) && value.every(item);
}

function nullable<T>(
  value: unknown,
  check: (value: unknown) => value is T,
): value is T | null | undefined {
  return value == null || check(value);
}

function isNamedReference(value: unknown): value is NamedReference {
  return isObject(value) && isString(value.name);
}

function isKeyPath(value: unknown): value is KeyPath {
  return isObject(value) && isString(value.path);
}

function isSecretVolume(value: unknown): value is NonNullable<Volume["secret"]> {
  return (
    isObject(value) &&
    nullable(value.secretName, isString) &&
    nullable(value.items, (items) => arrayOf(items, isKeyPath))
  );
}

function isVolume(value: unknown): value is Volume {
  return isNamedReference(value) && nullable(value.secret, isSecretVolume);
}

function isVolumeMount(value: unknown): value is VolumeMount {
  return (
    isNamedReference(value) &&
    isString(value.mountPath) &&
    nullable(value.readOnly, (flag) => typeof flag === "boolean")
  );
}

function isContainer(value: unknown): value is Container {
  return (
    isNamedReference(value) &&
    (value.image === undefined || isString(value.image)) &&
    nullable(value.env, (env) => arrayOf(env, isNamedReference)) &&
    nullable(value.envFrom, Array.isArray) &&
    nullable(value.volumeMounts, (mounts) => arrayOf(mounts, isVolumeMount))
  );
}

function isLabelMap(value: unknown): value is Labels {
  // Kubernetes decodes null label values as empty strings.
  return (
    isObject(value) && Object.values(value).every((label) => label === null || isString(label))
  );
}

function podSpec(template: JsonObject | undefined): JsonObject {
  const spec = template?.spec ?? {};
  if (!isObject(spec)) {
    fail("the rendered chart contains an invalid preflight Pod spec.");
  }
  return spec;
}

// Find candidates by name before validating the fields that survive into the Job.
function namedReferences(value: JsonValue | undefined): NamedReference[] {
  if (!nullable(value, (items) => arrayOf(items, isNamedReference))) {
    fail("the rendered chart contains an invalid preflight Pod spec.");
  }
  return value ?? [];
}

function preflightContainer(container: NamedReference): Container {
  if (!isContainer(container)) {
    fail("the rendered chart contains an invalid preflight Pod spec.");
  }
  return container;
}

function mountedVolumes(volumes: NamedReference[], mounted: Set<string>): Volume[] {
  const selected = volumes.filter(({ name }) => mounted.has(name));
  if (!arrayOf(selected, isVolume)) {
    fail("the rendered chart contains an invalid preflight Pod spec.");
  }
  return selected;
}

function object(value: unknown): JsonObject | undefined {
  return isObject(value) ? value : undefined;
}

function conditions(value: JsonValue | undefined): JsonValue[] {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail("cannot read startup preflight conditions.");
  }
  return value;
}

function observedStatusEntry(value: JsonValue): JsonObject | undefined {
  // A null entry fails the observation when reached. Earlier terminal evidence may
  // short-circuit the read, as it did before the command used TypeScript.
  if (value === null) {
    fail("cannot read startup preflight status entry.");
  }
  return object(value);
}

function parseJson(source: string): JsonValue {
  try {
    // JSON.parse without a reviver yields only JSON values.
    return JSON.parse(source) as JsonValue;
  } catch {
    fail("cannot read startup preflight JSON.");
  }
}

function readObject(path: string): JsonObject {
  const value = parseJson(readFileSync(path, "utf8"));
  if (!isObject(value)) {
    fail("cannot read startup preflight JSON object.");
  }
  return value;
}

const labels = (release: string) => ({
  "app.kubernetes.io/name": "openclaw-enterprise",
  "app.kubernetes.io/instance": release,
  "app.kubernetes.io/component": "upgrade-preflight",
});

function fail(message: string): never {
  process.stderr.write(`upgrade-startup-preflight: ${message}\n`);
  process.exit(1);
}

// `yq -o=json -I=0 '.'` prints one compact JSON document per line.
function documents(path: string): JsonObject[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0 && line.trim() !== "---")
    .map(parseJson)
    .filter(isObject);
}

// Gathers the helper's per-Agent drafts (one JSON line each: the Agent, its name and its saved
// Configuration) into one gzipped document, each Configuration once. Exits 3 when it would not
// fit in the preflight Secret beside the candidate Installation.
function drafts([draftsPath, installationPath, outputPath]: [string, string, string]): number {
  const agents: AgentDraftIdentity[] = [];
  const configurations: JsonObject = {};
  for (const line of readFileSync(draftsPath, "utf8").split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    const draft = parseJson(line);
    if (draft == null) {
      fail("cannot read a recorded Agent draft.");
    }
    const { namespaceId, agentId, name, configurationId, values } = object(draft) ?? {};
    agents.push({ namespaceId, agentId, name, configurationId });
    configurations[String(configurationId)] = values;
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
function secret([installationPath, key, name, namespace, release, draftsPath]: [
  string,
  string,
  string,
  string,
  string,
  string,
]) {
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
function refusals([logPath]: [string]): string {
  const printable = (value: string) => value.replace(/[\p{Cc}\u2028\u2029]/gu, "?");
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.startsWith(`${draftRefusal} `))
    .map((line) => {
      const parsed = parseJson(line.slice(draftRefusal.length + 1));
      if (parsed == null) {
        fail("cannot read an Agent draft refusal.");
      }
      const agent = object(parsed) ?? {};
      const name =
        typeof agent.name === "string" ? JSON.stringify(agent.name) : "(name unavailable)";
      return printable(
        `  - Agent ${String(agent.agentId)} ${name} in Namespace ${String(agent.namespaceId)}: ${String(agent.message)}`,
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
] as const;
const containerFields = [
  "name",
  "image",
  "workingDir",
  "env",
  "envFrom",
  "volumeMounts",
  "securityContext",
  "resources",
] as const;

function selectFields<T extends object, K extends keyof T>(
  source: T,
  fields: readonly K[],
): Pick<T, K> {
  const selected = {} as Pick<T, K>;
  for (const field of fields) {
    if (field in source) {
      selected[field] = source[field];
    }
  }
  return selected;
}

// Only the chart-owned preload and CA assembler may survive replacing the server
// entrypoint. Never execute an arbitrary command from a rendered Deployment.
function connectionPlan(
  { initContainers, volumes }: { initContainers: NamedReference[]; volumes: NamedReference[] },
  container: Container,
  component: string,
  check: string,
): { args: string[]; initContainers: Container[] } {
  function refuse(): never {
    return fail("the rendered application connection prerequisites are unsupported.");
  }
  const same = (left: JsonValue | undefined, right: string[]) =>
    JSON.stringify(left) === JSON.stringify(right);
  const entrypoint = `apps/controller/src/${component === "api" ? "server" : "worker"}.mjs`;
  const assemblers = initContainers.filter(({ name }) => name === "assemble-api-ca");
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
  const source = (name: string) =>
    readFileSync(
      new URL(`../deploy/helm/openclaw-enterprise/files/${name}`, import.meta.url),
      "utf8",
    );
  const preload = `data:text/javascript;base64,${Buffer.from(source("check-api-database-ca.mjs")).toString("base64")}`;
  const args: JsonValue[] | string =
    Array.isArray(container.args) || typeof container.args === "string" ? container.args : [];
  const caPath = args[3];
  const [assemblerReference] = assemblers;
  const caMounts = (container.volumeMounts ?? []).filter(
    ({ name, mountPath, readOnly }) =>
      name === "database-ca" && readOnly === true && typeof mountPath === "string",
  );
  const [caMount] = caMounts;
  if (
    component !== "api" ||
    args.length !== 4 ||
    args[0] !== "--import" ||
    args[1] !== preload ||
    args[2] !== entrypoint ||
    typeof caPath !== "string" ||
    !caMount ||
    caMounts.length !== 1 ||
    !assemblerReference ||
    assemblers.length !== 1
  ) {
    refuse();
  }
  const assembler = preflightContainer(assemblerReference);
  const caVolume = volumes.find(({ name }) => name === caMount.name);
  const caDirectory = caMount.mountPath.replace(/\/$/, "");
  if (
    !isVolume(caVolume) ||
    !caVolume.secret?.items?.some(({ path }) => caPath === `${caDirectory}/${path}`)
  ) {
    refuse();
  }
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
    const [mount] = mounts;
    const volume = mount && mounts.length === 1 && volumes.find(({ name }) => name === mount.name);
    if (
      !volume ||
      (path === output ? !volume.emptyDir : !volume.secret || mount?.readOnly !== true)
    ) {
      refuse();
    }
  }
  const outputMount = assembler.volumeMounts?.find(({ mountPath }) =>
    output.startsWith(`${mountPath}/`),
  );
  if (
    !outputMount ||
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
    initContainers: [selectFields(assembler, [...containerFields, "command", "args"] as const)],
  };
}

// Reuse the initialization Job's database identity and mounted CA, but run only
// the candidate's read-only compatibility check. Never copy bootstrap or other
// init containers into a preflight that runs while the incumbent is serving.
function migrationJob(
  renderedPath: string,
  name: string,
  namespace: string,
  release: string,
  image: string,
  timeoutSeconds: number,
): JobManifest {
  const jobs = documents(renderedPath).filter((document) => {
    const labels = object(object(document.metadata)?.labels);
    return (
      document.kind === "Job" &&
      labels?.["app.kubernetes.io/instance"] === release &&
      labels["app.kubernetes.io/component"] === "initialization"
    );
  });
  const [job] = jobs;
  if (!job || jobs.length !== 1) {
    fail("the rendered chart must contain exactly one initialization Job.");
  }
  const template = object(object(job.spec)?.template);
  const spec = podSpec(template);
  const matches = namedReferences(spec.initContainers).filter(({ name }) => name === "migration");
  const [migration] = matches;
  if (!migration || matches.length !== 1 || migration.image !== image) {
    fail("the initialization Job must contain one migration container using the selected image.");
  }
  const jobLabels = object(job.metadata)?.labels;
  if (!isLabelMap(jobLabels)) {
    fail("the rendered initialization Job contains invalid labels.");
  }
  const templateMetadata = object(template?.metadata);
  if (!templateMetadata) {
    fail("the rendered initialization Job must contain Pod metadata.");
  }
  const podLabels = templateMetadata.labels;
  if (podLabels != null && !isLabelMap(podLabels)) {
    fail("the rendered initialization Job contains invalid Pod labels.");
  }
  const container: Container = selectFields(preflightContainer(migration), containerFields);
  container.command = ["node"];
  container.args = ["scripts/migrate-production.mjs", "--check"];
  const mounted = new Set((container.volumeMounts ?? []).map((mount) => mount.name));
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name, namespace, labels: jobLabels },
    spec: {
      backoffLimit: 0,
      completions: 1,
      parallelism: 1,
      activeDeadlineSeconds: timeoutSeconds,
      template: {
        metadata: { labels: podLabels },
        spec: {
          ...selectFields(spec, podFields),
          restartPolicy: "Never",
          activeDeadlineSeconds: timeoutSeconds,
          enableServiceLinks: false,
          containers: [container],
          volumes: mountedVolumes(namedReferences(spec.volumes), mounted),
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
type JobArguments = [
  renderedPath: string,
  component: string,
  name: string,
  namespace: string,
  release: string,
  installationSecret: string,
  candidateSecret: string,
  image: string,
  timeoutSeconds: number,
  storedInstallationPath: string,
  withDrafts: string,
];

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
  ]: JobArguments,
  check = startupCheck,
): JobManifest {
  if (component === "migration") {
    return migrationJob(renderedPath, name, namespace, release, image, timeoutSeconds);
  }
  const { name: storedName, id: storedId } = readObject(storedInstallationPath);
  if (typeof storedName !== "string") {
    fail("OCC did not return the stored Installation name.");
  }
  if (typeof storedId !== "string" || storedId.length === 0) {
    fail("OCC did not return the stored Installation ID.");
  }
  const deployments = documents(renderedPath).filter(
    (document) =>
      document.kind === "Deployment" &&
      object(document.metadata)?.name === `openclaw-enterprise-${component}`,
  );
  const [deployment] = deployments;
  if (!deployment || deployments.length !== 1) {
    fail(
      `the rendered chart must contain exactly one openclaw-enterprise-${component} Deployment.`,
    );
  }
  const spec = podSpec(object(object(deployment.spec)?.template));
  const initContainers = namedReferences(spec.initContainers);
  const matches = [...namedReferences(spec.containers), ...initContainers].filter(
    ({ name }) => name === component,
  );
  const [applicationReference] = matches;
  if (!applicationReference || matches.length !== 1) {
    fail(`the rendered ${component} Deployment must contain exactly one ${component} container.`);
  }
  if (applicationReference.image !== image) {
    fail(`the rendered ${component} container does not select the selected controller image.`);
  }
  const application = preflightContainer(applicationReference);
  const container: Container = selectFields(application, containerFields);
  // The image entrypoint is node; name it so a chart command cannot change the check.
  container.command = ["node"];
  const volumeReferences = namedReferences(spec.volumes);
  const plan = connectionPlan(
    { initContainers, volumes: volumeReferences },
    application,
    component,
    check,
  );
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
  const volumes = structuredClone(mountedVolumes(volumeReferences, mounted));
  const installation = volumes.filter((volume) => volume.secret?.secretName === installationSecret);
  const [installationVolume] = installation;
  if (!installationVolume?.secret || installation.length !== 1) {
    fail(`the rendered ${component} container must mount the Installation Secret once.`);
  }
  installationVolume.secret.secretName = candidateSecret;
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
      activeDeadlineSeconds: timeoutSeconds,
      template: {
        metadata: { labels: labels(release) },
        spec: {
          ...selectFields(spec, podFields),
          restartPolicy: "Never",
          activeDeadlineSeconds: timeoutSeconds,
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
function networkPolicy([renderedPath, name, namespace, release]: [string, string, string, string]) {
  const sources = documents(renderedPath).filter(
    (document) =>
      document.kind === "NetworkPolicy" &&
      (object(document.metadata)?.name === "openclaw-enterprise-dependency-egress" ||
        object(document.metadata)?.name === "openclaw-enterprise-execution-api-egress"),
  );
  if (
    !sources.some(
      (document) => object(document.metadata)?.name === "openclaw-enterprise-dependency-egress",
    )
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
      egress: structuredClone(sources.flatMap(({ spec }) => object(spec)?.egress ?? [])),
    },
  };
}

// Labels discover candidates; only the actual Job controller reference establishes ownership.
function isOwnedPod(value: unknown): value is OwnedPod {
  return (
    isObject(value) && isObject(value.metadata) && Array.isArray(value.metadata.ownerReferences)
  );
}

function jobControllerReference(owner: JsonValue, jobUid: string): owner is JsonObject {
  if (owner === null) {
    fail("startup preflight Pod labels do not match its controller ownership.");
  }
  return (
    isObject(owner) &&
    owner.apiVersion === "batch/v1" &&
    owner.kind === "Job" &&
    owner.controller === true &&
    owner.uid === jobUid
  );
}

function ownedPods(document: JsonObject, jobUid: string): OwnedPod[] {
  if (!Array.isArray(document.items)) {
    fail("cannot read startup preflight child Pods.");
  }
  const items: JsonValue[] = document.items;
  return items.map((pod) => {
    if (
      !isOwnedPod(pod) ||
      !pod.metadata.ownerReferences.some((owner) => jobControllerReference(owner, jobUid))
    ) {
      fail("startup preflight Pod labels do not match its controller ownership.");
    }
    return pod;
  });
}

function child([jobPath, jobUid, podsPath, previousUid]: [string, string, string, string]): string {
  const job = readObject(jobPath);
  const jobMetadata = object(job.metadata);
  if (jobMetadata?.uid !== jobUid) {
    fail("startup preflight Job identity changed.");
  }
  const pods = ownedPods(readObject(podsPath), jobUid);
  if (pods.length > 1) {
    fail("startup preflight Job created more than one child Pod.");
  }
  const [pod] = pods;
  if (!pod) {
    if (previousUid) {
      fail("startup preflight child Pod disappeared.");
    }
    if (
      conditions(object(job.status)?.conditions).some((condition) => {
        const entry = observedStatusEntry(condition);
        return (entry?.type === "Failed" || entry?.type === "Complete") && entry.status === "True";
      })
    ) {
      fail("startup preflight Job ended without its child Pod evidence.");
    }
    return "";
  }
  if (
    typeof pod.metadata.name !== "string" ||
    !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(pod.metadata.name) ||
    typeof pod.metadata.uid !== "string" ||
    !pod.metadata.uid ||
    /[\s\p{C}]/u.test(pod.metadata.uid) ||
    pod.metadata.namespace !== jobMetadata.namespace ||
    !pod.metadata.ownerReferences.some(
      (owner) => jobControllerReference(owner, jobUid) && owner.name === jobMetadata.name,
    ) ||
    (previousUid && pod.metadata.uid !== previousUid)
  ) {
    fail("startup preflight child Pod identity changed or is invalid.");
  }
  return JSON.stringify(pod);
}

function readConsumer(path: string): JsonValue | undefined {
  const text = readFileSync(path, "utf8").trim();
  return text ? parseJson(text) : undefined;
}

function consumerUid(consumer: JsonValue | undefined): JsonValue | undefined {
  return object(object(consumer)?.metadata)?.uid;
}

function remaining([jobPath, jobUid, podsPath, childPath, childUid]: [
  string,
  string,
  string,
  string,
  string,
]): string {
  const job = readConsumer(jobPath);
  const pod = readConsumer(childPath);
  const observedJobUid = consumerUid(job);
  const observedChildUid = consumerUid(pod);
  // A present replacement is not an absence receipt for the saved consumer.
  if ((job && observedJobUid !== jobUid) || (pod && observedChildUid !== childUid)) {
    fail("startup preflight consumer identity changed during cleanup.");
  }
  return String(
    observedJobUid === jobUid ||
      ownedPods(readObject(podsPath), jobUid).length > 0 ||
      (childUid !== "" && observedChildUid === childUid),
  );
}

// Prints Succeeded only after Job completion, Failed or JobFailed on failure,
// Stuck:<reason> when operator action is required, Pending:<reason> while the Pod
// cannot be scheduled (an autoscaler may add capacity), or Running.
function phase([statusPath, jobPath]: [string, string]): string {
  const status = object(readObject(statusPath).status);
  const jobStatus = object(readObject(jobPath).status);
  // Preserve failed-child diagnostics, but never let a successful child override its Job.
  if (status?.phase === "Failed") {
    return "Failed";
  }
  const jobConditions = conditions(jobStatus?.conditions);
  if (
    jobConditions.some((condition) => {
      const entry = observedStatusEntry(condition);
      return (
        (entry?.type === "Failed" || entry?.type === "FailureTarget") && entry.status === "True"
      );
    })
  ) {
    return "JobFailed";
  }
  if (status?.phase === "Succeeded") {
    return jobConditions.some((condition) => {
      const entry = observedStatusEntry(condition);
      return entry?.type === "Complete" && entry.status === "True";
    })
      ? "Succeeded"
      : "Running";
  }
  const containerStatuses = status?.containerStatuses ?? [];
  if (!Array.isArray(containerStatuses) && typeof containerStatuses !== "string") {
    fail("cannot read startup preflight container statuses.");
  }
  const containers: Iterable<JsonValue> = containerStatuses;
  for (const container of containers) {
    const reason = object(object(observedStatusEntry(container)?.state)?.waiting)?.reason;
    if (
      typeof reason === "string" &&
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
  const unscheduled = object(
    conditions(status?.conditions).find((condition) => {
      const entry = observedStatusEntry(condition);
      return entry?.type === "PodScheduled" && entry.status === "False";
    }),
  );
  if (unscheduled) {
    const message = String(unscheduled.message ?? "")
      .replace(/\s+/g, " ")
      .slice(0, 300);
    return `Pending:${String(unscheduled.reason ?? "Unschedulable")}: ${message}`;
  }
  return "Running";
}

type Command =
  | { action: "drafts"; input: Parameters<typeof drafts>[0] }
  | { action: "secret"; input: Parameters<typeof secret>[0] }
  | { action: "job" | "identity-job"; input: JobArguments }
  | { action: "child"; input: Parameters<typeof child>[0] }
  | { action: "remaining"; input: Parameters<typeof remaining>[0] }
  | { action: "refusals"; input: Parameters<typeof refusals>[0] }
  | { action: "networkpolicy"; input: Parameters<typeof networkPolicy>[0] }
  | { action: "phase"; input: Parameters<typeof phase>[0] };

function parseCommand([action, ...input]: string[]): Command {
  switch (action) {
    case "job":
    case "identity-job": {
      const [
        rendered,
        component,
        name,
        namespace,
        release,
        installation,
        candidate,
        image,
        timeout,
        stored,
        draftSelection,
      ] = argumentsOf(input, 11);
      return {
        action,
        input: [
          rendered,
          component,
          name,
          namespace,
          release,
          installation,
          candidate,
          image,
          Number(timeout),
          stored,
          draftSelection,
        ],
      };
    }
    case "drafts":
      return { action, input: argumentsOf(input, 3) };
    case "secret":
      return { action, input: argumentsOf(input, 6) };
    case "child":
      return { action, input: argumentsOf(input, 4) };
    case "remaining":
      return { action, input: argumentsOf(input, 5) };
    case "refusals":
      return { action, input: argumentsOf(input, 1) };
    case "networkpolicy":
      return { action, input: argumentsOf(input, 4) };
    case "phase":
      return { action, input: argumentsOf(input, 2) };
    default:
      return failUsage();
  }
}

function failUsage(): never {
  return fail(
    "expected drafts, secret, job, identity-job, child, remaining, refusals, networkpolicy, or phase with its arguments.",
  );
}

type ArgumentsOf<
  Length extends number,
  Result extends string[] = [],
> = Result["length"] extends Length ? Result : ArgumentsOf<Length, [...Result, string]>;

function argumentsOf<Length extends number>(input: string[], count: Length): ArgumentsOf<Length> {
  if (input.length !== count) {
    failUsage();
  }
  return input as ArgumentsOf<Length>;
}

function run(command: Command): string | number {
  switch (command.action) {
    case "drafts":
      return drafts(command.input);
    case "secret":
      return JSON.stringify(secret(command.input));
    case "job":
      return JSON.stringify(job(command.input));
    case "identity-job":
      return JSON.stringify(
        job(
          command.input,
          identityCheck + 'process.stdout.write("installation-startup-ready\\n");',
        ),
      );
    case "child":
      return child(command.input);
    case "remaining":
      return remaining(command.input);
    case "refusals":
      return refusals(command.input);
    case "networkpolicy":
      return JSON.stringify(networkPolicy(command.input));
    case "phase":
      return phase(command.input);
  }
}

process.stdout.write(`${run(parseCommand(process.argv.slice(2)))}\n`);
