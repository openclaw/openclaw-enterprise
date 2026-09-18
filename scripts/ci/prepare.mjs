#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { cleanupResourceIds } from "./cleanup.mjs";
import { prepareGatewayRouting } from "./routing.mjs";
import { prepareLogging } from "./logging.mjs";
import { prepareCodexSeccompProfile } from "./codex-seccomp.mjs";
import {
  prepareOpenShell,
  prepareOpenShellClusterBootstrap,
  prepareOpenShellPodSecurityAdmission,
} from "./openshell.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const composePostgresFile = join(repositoryRoot, "compose.postgres.yaml");
const runtimeDockerfile = join(repositoryRoot, "deploy/runtime/Dockerfile");
const fixtureDockerContext = join(repositoryRoot, "tests/fixtures/kubernetes");
const testSuitesManifestPath = join(repositoryRoot, "scripts/ci/test-suites.json");
const defaultStatePath = join(
  process.env.RUNNER_TEMP ?? tmpdir(),
  "openclaw-enterprise-ci-state.json",
);
const laneDefinitions = JSON.parse(readFileSync(testSuitesManifestPath, "utf8")).lanes ?? {};
const allowedLanes = new Set(Object.keys(laneDefinitions));

function laneDefinition(name) {
  return laneDefinitions[name] ?? {};
}

function lanePrepare(name) {
  return laneDefinition(name).prepare ?? {};
}

function applyLaneEnv(name, env) {
  Object.assign(env, laneDefinition(name).env ?? {});
  for (const [envName, defaultValue] of Object.entries(lanePrepare(name).defaultEnv ?? {})) {
    env[envName] = process.env[envName] || env[envName] || defaultValue;
  }
}

function effectiveLaneEnv(name, env = {}) {
  const effective = { ...process.env, ...env };
  applyLaneEnv(name, effective);
  return effective;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const name = arg.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      args[name] = "1";
    } else {
      args[name] = value;
      index += 1;
    }
  }
  return args;
}

function randomSuffix(bytes = 6) {
  return randomUUID()
    .replaceAll("-", "")
    .slice(0, bytes * 2);
}

function slug(value, separator = "-") {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, separator)
    .replace(new RegExp(`${separator}+`, "g"), separator)
    .replace(new RegExp(`^${separator}|${separator}$`, "g"), "");
}

function ownedName(prefix, label, { maxLength = 63, separator = "-" } = {}) {
  const suffix = randomSuffix();
  const normalizedPrefix = slug(prefix, separator);
  const normalizedLabel = slug(label, separator) || "resource";
  const fixedLength = normalizedPrefix.length + suffix.length + 2;
  const labelLength = Math.max(1, maxLength - fixedLength);
  return [normalizedPrefix, normalizedLabel.slice(0, labelLength), suffix].join(separator);
}

function databaseName(kind, label) {
  const prefix =
    kind === "failures" ? "openclaw_failures" : kind === "k8s" ? "openclaw_k8s" : "openclaw_ci";
  return ownedName(prefix, label, { maxLength: 63, separator: "_" });
}

function laneName(lane) {
  if (typeof lane === "string") {
    return lane;
  }
  if (typeof lane?.name === "string") {
    return lane.name;
  }
  throw new Error("CI lane must be a string or an object with a name.");
}

function filePath(file) {
  if (typeof file === "string") {
    return file;
  }
  if (typeof file?.path === "string") {
    return file.path;
  }
  throw new Error("CI file must be a string or an object with a path.");
}

function assertLane(lane) {
  const name = laneName(lane);
  if (!allowedLanes.has(name)) {
    throw new Error(`Unknown CI lane: ${name}`);
  }
  return name;
}

function requireEnv(names, env = process.env) {
  const missing = names.filter((name) => !env[name] || env[name].trim?.() === "");
  if (missing.length > 0) {
    throw new Error(`Missing required CI input(s): ${missing.join(", ")}`);
  }
}

function fileStem(file) {
  return slug(basename(file).replace(/\.test\.mjs$/, ""), "_") || "test_file";
}

function normalizeStatePath(statePath) {
  const path = resolve(statePath ?? defaultStatePath);
  if (!isAbsolute(path)) {
    throw new Error("CI state path must be absolute after resolution.");
  }
  return path;
}

function toRepositoryRelative(path) {
  const resolved = isAbsolute(path) ? resolve(path) : resolve(repositoryRoot, path);
  const relativePath = relative(repositoryRoot, resolved);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Path escapes repository root: ${path}`);
  }
  return relativePath.split(sep).join("/");
}

function runPrefix() {
  const runId = process.env.GITHUB_RUN_ID ?? `local-${process.pid}`;
  const attempt = process.env.GITHUB_RUN_ATTEMPT ?? "1";
  const job = process.env.GITHUB_JOB ?? "local";
  return ownedName("openclaw-ci", `${runId}-${attempt}-${job}`, { maxLength: 48 });
}

function baseState(lane, statePath) {
  return {
    version: 1,
    repositoryRoot,
    lane,
    prefix: runPrefix(),
    statePath,
    createdAt: new Date().toISOString(),
    resources: [],
  };
}

async function readState(path) {
  try {
    const state = JSON.parse(await readFile(path, "utf8"));
    if (state.version !== 1) {
      throw new Error(`Unsupported CI state version: ${state.version}`);
    }
    if (state.repositoryRoot !== repositoryRoot) {
      throw new Error(`CI state belongs to another repository root: ${state.repositoryRoot}`);
    }
    if (!state.prefix?.startsWith("openclaw-ci-")) {
      throw new Error("CI state prefix is not an OpenClaw Enterprise CI prefix.");
    }
    if (!Array.isArray(state.resources)) {
      throw new Error("CI state resources must be an array.");
    }
    return state;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    return undefined;
  }
}

async function writeState(path, state) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomSuffix()}.tmp`);
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
  await chmod(path, 0o600);
}

async function appendGithubEnv(path, env) {
  if (!path) {
    return;
  }
  const lines = Object.entries(env).map(([name, value]) => `${name}=${value}`);
  if (lines.length === 0) {
    return;
  }
  await writeFile(path, `${lines.join("\n")}\n`, { flag: "a", mode: 0o600 });
  await chmod(path, 0o600);
}

function addResource(state, kind, resource) {
  const entry = {
    id: `${kind}-${randomSuffix()}`,
    kind,
    owner: state.prefix,
    status: "planned",
    createdAt: new Date().toISOString(),
    ...resource,
  };
  state.resources.push(entry);
  return entry;
}

async function markResourceReady(statePath, state, resource) {
  resource.status = "ready";
  resource.readyAt = new Date().toISOString();
  await writeState(statePath, state);
}

function execFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let timedOut = false;
    let killTimer;
    let timeoutTimer;
    if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      }, options.timeoutMs);
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    function commandError(message, properties = {}) {
      const error = new Error(message);
      error.command = command;
      error.args = args;
      error.stdout = stdout;
      error.stderr = stderr;
      Object.assign(error, properties);
      return error;
    }
    function finish(callback) {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (killTimer) {
        clearTimeout(killTimer);
      }
      callback();
    }
    child.on("error", (error) =>
      finish(() => {
        error.command = command;
        error.args = args;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }),
    );
    child.on("exit", (code, signal) => {
      finish(() => {
        if (timedOut) {
          reject(
            commandError(`${command} ${args.join(" ")} timed out after ${options.timeoutMs}ms`, {
              exitCode: code,
              signal,
              timedOut: true,
            }),
          );
        } else if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          const message = stderr.trim() || stdout.trim() || signal || String(code);
          reject(
            commandError(`${command} ${args.join(" ")} failed: ${message}`, {
              exitCode: code,
              signal,
              timedOut: false,
            }),
          );
        }
      });
    });
  });
}

async function commandAvailable(command, args = ["--version"]) {
  try {
    await execFile(command, args);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Missing required command on PATH: ${command}`);
    }
    throw error;
  }
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  await new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
  if (!address || typeof address === "string") {
    throw new Error("Failed to reserve a loopback port.");
  }
  return address.port;
}

function dockerArgsForPostgres(resource, ...args) {
  return ["compose", "-f", resource.composeFile, "-p", resource.name, ...args];
}

function postgresUrl(role, password, port, database) {
  return `postgresql://${role}:${password}@127.0.0.1:${port}/${database}`;
}

function quoteIdentifier(value) {
  if (!/^[a-z0-9_]+$/.test(value)) {
    throw new Error(`Unsafe PostgreSQL identifier: ${value}`);
  }
  return `"${value.replaceAll('"', '""')}"`;
}

function postgresResource(state) {
  return state.resources.find((resource) => resource.kind === "compose-postgres");
}

async function ensurePostgresServer(statePath, state) {
  const existing = postgresResource(state);
  if (existing) {
    return existing;
  }
  await commandAvailable(process.env.OCC_DOCKER_BIN ?? "docker", [
    "version",
    "--format",
    "{{.Server.Version}}",
  ]);
  const port = await reserveLoopbackPort();
  if (port === 55432) {
    throw new Error("Refusing to use the developer PostgreSQL port 55432.");
  }
  const project = ownedName("openclaw-ci-pg", state.prefix, { maxLength: 63, separator: "_" });
  const resource = addResource(state, "compose-postgres", {
    name: project,
    composeFile: composePostgresFile,
    port,
  });
  await writeState(statePath, state);
  await execFile(
    process.env.OCC_DOCKER_BIN ?? "docker",
    dockerArgsForPostgres(resource, "up", "-d", "--wait"),
    { env: { OCC_POSTGRES_PORT: String(port) } },
  );
  await markResourceReady(statePath, state, resource);
  return resource;
}

async function postgresExec(resource, args) {
  await execFile(
    process.env.OCC_DOCKER_BIN ?? "docker",
    dockerArgsForPostgres(resource, "exec", "-T", "postgres", ...args),
    {
      env: { OCC_POSTGRES_PORT: String(resource.port) },
    },
  );
}

async function createAndMigrateDatabase(
  statePath,
  state,
  { kind = "ci", label, requireExistingServer = false },
) {
  const existingServer = postgresResource(state);
  if (requireExistingServer && !existingServer) {
    throw new Error(
      "prepareFile requires prepareLane to create the owned PostgreSQL server first.",
    );
  }
  const server = existingServer ?? (await ensurePostgresServer(statePath, state));
  const name = databaseName(kind, label);
  const resource = addResource(state, "postgres-database", {
    name,
    composeProject: server.name,
    port: server.port,
  });
  await writeState(statePath, state);

  await postgresExec(server, [
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-c",
    `CREATE DATABASE ${quoteIdentifier(name)}`,
  ]);
  await postgresExec(server, [
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "postgres",
    "-d",
    name,
    "-c",
    `GRANT CREATE ON DATABASE ${quoteIdentifier(name)} TO occ_migrator; CREATE SCHEMA occ AUTHORIZATION occ_migrator; CREATE SCHEMA drizzle AUTHORIZATION occ_migrator; REVOKE CREATE ON SCHEMA public FROM PUBLIC;`,
  ]);
  const migrationUrl = postgresUrl("occ_migrator", "occ-migrator-local", server.port, name);
  await execFile("corepack", ["pnpm", "db:migrate"], {
    env: { OCC_MIGRATION_DATABASE_URL: migrationUrl },
  });
  await markResourceReady(statePath, state, resource);
  return {
    name,
    appUrl: postgresUrl("occ_app", "occ-app-local", server.port, name),
    migrationUrl,
    resourceId: resource.id,
  };
}

async function requirePathMode0600(path, description) {
  const info = await stat(path);
  if (!info.isFile()) {
    throw new Error(`${description} must be a file: ${path}`);
  }
  if ((info.mode & 0o777) !== 0o600) {
    throw new Error(`${description} must have mode 0600: ${path}`);
  }
}

function assertImmutableImageReference(image, name) {
  if (!/^\S+@sha256:[a-f0-9]{64}$/i.test(image ?? "")) {
    throw new Error(`${name} must be an immutable image@sha256 reference.`);
  }
}

function assertNodeBaseImage(image) {
  assertImmutableImageReference(image, "NODE_BASE_IMAGE");
  if (!/(?:^|[/:])node:24[.-]/.test(image)) {
    throw new Error("NODE_BASE_IMAGE must select an approved Node 24 image.");
  }
}

function assertImmutableEnvImages(names, env = process.env) {
  for (const name of names) {
    assertImmutableImageReference(env[name], name);
  }
}

function assertImmutableOptionalEnvImages(names, env = process.env) {
  for (const name of names) {
    if (env[name]) {
      assertImmutableImageReference(env[name], name);
    }
  }
}

async function validateLaneInputsBeforeSideEffects(lane, env = {}) {
  const name = laneName(lane);
  const prepare = lanePrepare(name);
  const effectiveEnv = effectiveLaneEnv(name, env);
  requireEnv(prepare.requireEnv ?? [], effectiveEnv);
  if (prepare.nodeBaseImage) {
    assertNodeBaseImage(effectiveEnv.NODE_BASE_IMAGE);
  }
  assertImmutableEnvImages(prepare.immutableEnvImages ?? [], effectiveEnv);
  assertImmutableOptionalEnvImages(prepare.immutableOptionalEnvImages ?? [], effectiveEnv);
  if (prepare.mode0600Env) {
    await requirePathMode0600(
      effectiveEnv[prepare.mode0600Env],
      prepare.mode0600Description ?? prepare.mode0600Env,
    );
  }
}

async function buildRuntimeImages(
  statePath,
  state,
  { controller = false, runtime = false, nodeBaseImage = process.env.NODE_BASE_IMAGE } = {},
) {
  await commandAvailable(process.env.OCC_DOCKER_BIN ?? "docker", [
    "version",
    "--format",
    "{{.Server.Version}}",
  ]);
  const env = {};
  const resources = [];
  const tagBase = `localhost/${ownedName("openclaw-ci-image", state.prefix, { maxLength: 48 })}`;
  if (controller) {
    assertNodeBaseImage(nodeBaseImage);
    const tag = `${tagBase}/controller:local`;
    const resource = addResource(state, "image-tag", { name: tag, owner: state.prefix });
    resources.push(resource);
    await writeState(statePath, state);
    await execFile(process.env.OCC_DOCKER_BIN ?? "docker", [
      "build",
      "--pull=false",
      "--target",
      "runtime",
      "--build-arg",
      `NODE_BASE_IMAGE=${nodeBaseImage}`,
      "-t",
      tag,
      ".",
    ]);
    await markResourceReady(statePath, state, resource);
    env.OCC_TEST_PRODUCTION_IMAGE = tag;
    env.OCC_TEST_PRODUCTION_CONTROLLER_IMAGE = tag;
  }
  if (runtime) {
    const tag = `${tagBase}/runtime:local`;
    const resource = addResource(state, "image-tag", { name: tag, owner: state.prefix });
    resources.push(resource);
    await writeState(statePath, state);
    await execFile(process.env.OCC_DOCKER_BIN ?? "docker", [
      "build",
      "--pull=false",
      "-f",
      runtimeDockerfile,
      "-t",
      tag,
      join(repositoryRoot, "deploy/runtime"),
    ]);
    await markResourceReady(statePath, state, resource);
    env.OCC_TEST_RUNTIME_IMAGE = tag;
    env.OCC_DOCKER_RUNTIME_IMAGE = tag;
    env.OCC_DOCKER_GATEWAY_IMAGE = tag;
    env.OCC_DOCKER_AGENT_IMAGE = tag;
    env.OCC_TEST_KUBERNETES_RUNTIME_IMAGE = tag;
  }
  return { env, resourceIds: resources.map((resource) => resource.id) };
}

async function ensureK3dCluster(statePath, state) {
  const existing = state.resources.find((resource) => resource.kind === "k3d-cluster");
  if (existing) {
    return existing;
  }
  await commandAvailable(process.env.OPENCLAW_CI_K3D_BIN ?? "k3d", ["version"]);
  const openShell = state.lane === "openshell";
  if (!openShell) {
    await commandAvailable(process.env.OCC_KUBECTL_BIN ?? "kubectl", ["version", "--client=true"]);
  }
  const cluster = ownedName("openclaw-k8s", state.prefix, { maxLength: 32 });
  const apiPort = await reserveLoopbackPort();
  const directory = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), `${cluster}-`));
  await chmod(directory, 0o700);
  const kubeconfig = join(directory, "kubeconfig");
  const resource = addResource(state, "k3d-cluster", {
    name: cluster,
    directory,
    kubeconfig,
    context: `k3d-${cluster}`,
    ...(!openShell ? { nodeImage: "+v1.35" } : {}),
  });
  await writeState(statePath, state);
  if (openShell) {
    const bootstrap = await prepareOpenShellClusterBootstrap({
      directory,
      execFile,
    });
    resource.nodeImage = bootstrap.k3sImage;
    resource.kubectl = bootstrap.kubectl;
    resource.runtimeClass = bootstrap.runtimeClass;
    resource.runtimeHandler = bootstrap.runtimeHandler;
    const podSecurityAdmission = await prepareOpenShellPodSecurityAdmission({
      directory,
      runtimeClass: bootstrap.runtimeClass,
    });
    resource.podSecurityAdmissionConfig = podSecurityAdmission.path;
    resource.podSecurityAdmissionContainerPath = podSecurityAdmission.containerPath;
    resource.podSecurityAdmissionK3dArgs = podSecurityAdmission.k3dArgs;
    await writeState(statePath, state);
  }
  await execFile(process.env.OPENCLAW_CI_K3D_BIN ?? "k3d", [
    "cluster",
    "create",
    cluster,
    ...(resource.nodeImage ? ["--image", resource.nodeImage] : []),
    ...(resource.podSecurityAdmissionK3dArgs ?? []),
    "--servers",
    "1",
    "--agents",
    "0",
    "--api-port",
    `127.0.0.1:${apiPort}`,
    "--kubeconfig-update-default=false",
    "--kubeconfig-switch-context=false",
  ]);
  const kubeconfigData = await execFile(process.env.OPENCLAW_CI_K3D_BIN ?? "k3d", [
    "kubeconfig",
    "get",
    cluster,
  ]);
  await writeFile(kubeconfig, kubeconfigData.stdout, { mode: 0o600 });
  await chmod(kubeconfig, 0o600);
  await validateLoopbackKubeconfig(kubeconfig, resource.context, resource.kubectl);
  await execFile(resource.kubectl ?? process.env.OCC_KUBECTL_BIN ?? "kubectl", [
    "--kubeconfig",
    kubeconfig,
    "--context",
    resource.context,
    "wait",
    "--for=condition=Ready",
    "nodes",
    "--all",
    "--timeout=120s",
  ]);
  if (!openShell) {
    const version = await execFile(process.env.OCC_KUBECTL_BIN ?? "kubectl", [
      "--kubeconfig",
      kubeconfig,
      "--context",
      resource.context,
      "version",
      "-o",
      "json",
    ]);
    const gitVersion = JSON.parse(version.stdout)?.serverVersion?.gitVersion;
    if (typeof gitVersion !== "string" || !/^v1\.35\./.test(gitVersion)) {
      throw new Error("The ordinary k3d test cluster must resolve to Kubernetes 1.35.x.");
    }
    resource.kubernetesVersion = gitVersion;
  }
  await markResourceReady(statePath, state, resource);
  return resource;
}

async function validateLoopbackKubeconfig(
  kubeconfig,
  context,
  kubectl = process.env.OCC_KUBECTL_BIN ?? "kubectl",
) {
  const result = await execFile(kubectl, [
    "--kubeconfig",
    kubeconfig,
    "--context",
    context,
    "config",
    "view",
    "--minify",
    "--flatten",
    "-o",
    "json",
  ]);
  const configuration = JSON.parse(result.stdout);
  const endpoint = new URL(configuration.clusters?.[0]?.cluster?.server);
  if (endpoint.protocol !== "https:") {
    throw new Error("k3d API server must use HTTPS.");
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) {
    throw new Error(`Refusing non-loopback Kubernetes API server: ${endpoint.hostname}`);
  }
  if (!endpoint.port || Number(endpoint.port) === 0) {
    throw new Error("k3d API server must expose an explicit loopback port.");
  }
}

async function prepareFixtureImage(statePath, state, cluster) {
  await commandAvailable(process.env.OCC_DOCKER_BIN ?? "docker", [
    "version",
    "--format",
    "{{.Server.Version}}",
  ]);
  const image = `localhost/${cluster.name}/fixture:local`;
  const resource = addResource(state, "image-tag", { name: image, owner: state.prefix });
  await writeState(statePath, state);
  await execFile(process.env.OCC_DOCKER_BIN ?? "docker", [
    "build",
    "--pull=false",
    "-t",
    image,
    fixtureDockerContext,
  ]);
  await markResourceReady(statePath, state, resource);
  const registered = await registerImageInK3d(
    statePath,
    state,
    cluster,
    image,
    "OCC_TEST_KUBERNETES_IMAGE",
  );
  return { image: registered.reference, resourceId: resource.id };
}

function immutableDigest(image) {
  return image.match(/@sha256:([a-f0-9]{64})$/i)?.[1]?.toLowerCase();
}

function stateOwnsImageTag(state, image) {
  return state.resources.some(
    (resource) =>
      resource.kind === "image-tag" && resource.owner === state.prefix && resource.name === image,
  );
}

function localImportTag(cluster, envName) {
  return `localhost/${cluster.name}/${slug(envName)}-${randomSuffix()}:local`;
}

async function dockerImageHasRepoDigest(image) {
  const expected = immutableDigest(image);
  if (!expected) {
    return false;
  }
  const inspected = await execFile(process.env.OCC_DOCKER_BIN ?? "docker", [
    "image",
    "inspect",
    "--format",
    "{{json .RepoDigests}}",
    image,
  ]);
  const repoDigests = JSON.parse(inspected.stdout.trim() || "[]");
  if (!Array.isArray(repoDigests)) {
    return false;
  }
  return repoDigests.some((reference) => reference.toLowerCase().endsWith(`@sha256:${expected}`));
}

async function dockerImageId(image) {
  const inspected = await execFile(process.env.OCC_DOCKER_BIN ?? "docker", [
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    image,
  ]);
  const id = inspected.stdout.trim();
  assertDockerImageId(id, `Docker image ${image}`);
  return id;
}

function assertDockerImageId(id, description) {
  if (!/^sha256:[a-f0-9]{64}$/i.test(id)) {
    throw new Error(`${description} did not resolve to an immutable local image ID.`);
  }
}

async function ensureDockerSourceImage(state, image, envName) {
  if (stateOwnsImageTag(state, image)) {
    await execFile(process.env.OCC_DOCKER_BIN ?? "docker", ["image", "inspect", image]);
    return dockerImageId(image);
  }
  assertImmutableImageReference(image, envName);
  await execFile(process.env.OCC_DOCKER_BIN ?? "docker", ["pull", image]);
  if (!(await dockerImageHasRepoDigest(image))) {
    throw new Error(`${envName} pull did not materialize the requested registry digest.`);
  }
  return dockerImageId(image);
}

async function assertK3dImageReference(cluster, reference, envName) {
  const listed = await execFile(process.env.OCC_DOCKER_BIN ?? "docker", [
    "exec",
    `k3d-${cluster.name}-server-0`,
    "ctr",
    "-n",
    "k8s.io",
    "images",
    "list",
  ]);
  const found = listed.stdout.split(/\r?\n/).some((entry) => entry.split(/\s+/)[0] === reference);
  if (!found) {
    throw new Error(`Unable to find imported ${envName} reference ${reference}.`);
  }
  await execFile(process.env.OCC_DOCKER_BIN ?? "docker", [
    "exec",
    `k3d-${cluster.name}-server-0`,
    "crictl",
    "inspecti",
    reference,
  ]);
}

async function registerImageInK3d(statePath, state, cluster, image, envName) {
  const existing = state.resources.find(
    (resource) =>
      resource.kind === "k3d-image" &&
      resource.cluster === cluster.name &&
      resource.status === "ready" &&
      (resource.sourceImage === image || resource.name === image || resource.reference === image),
  );
  if (existing) {
    if (!existing.hostImageId && existing.sourceImage) {
      existing.hostImageId = await ensureDockerSourceImage(state, existing.sourceImage, envName);
      await writeState(statePath, state);
    }
    assertDockerImageId(existing.hostImageId, envName);
    await assertK3dImageReference(cluster, existing.reference, envName);
    return existing;
  }

  const hostImageId = await ensureDockerSourceImage(state, image, envName);
  let importReference = image;
  if (!stateOwnsImageTag(state, image)) {
    importReference = localImportTag(cluster, envName);
    const tagResource = addResource(state, "image-tag", { name: importReference });
    await writeState(statePath, state);
    await execFile(process.env.OCC_DOCKER_BIN ?? "docker", ["tag", image, importReference]);
    await markResourceReady(statePath, state, tagResource);
  }

  const resource = addResource(state, "k3d-image", {
    name: importReference,
    sourceImage: image,
    hostImageId,
    cluster: cluster.name,
    envName,
  });
  await writeState(statePath, state);
  const inspected = await execFile(process.env.OCC_DOCKER_BIN ?? "docker", [
    "image",
    "inspect",
    "--format",
    "{{.Os}}/{{.Architecture}}",
    importReference,
  ]);
  const platform = inspected.stdout.trim();
  if (!platform.startsWith("linux/")) {
    throw new Error(`${envName} must contain a Linux image.`);
  }
  const archive = join(cluster.directory, `image-import-${randomSuffix()}.tar`);
  try {
    // k3d can exit successfully after containerd rejects missing index content.
    // Export only the platform pulled locally, then verify the imported reference.
    await execFile(process.env.OCC_DOCKER_BIN ?? "docker", [
      "image",
      "save",
      "--platform",
      platform,
      "--output",
      archive,
      importReference,
    ]);
    await execFile(process.env.OPENCLAW_CI_K3D_BIN ?? "k3d", [
      "image",
      "import",
      "--mode",
      "direct",
      archive,
      "-c",
      cluster.name,
    ]);
  } finally {
    await rm(archive, { force: true });
  }

  const listed = await execFile(process.env.OCC_DOCKER_BIN ?? "docker", [
    "exec",
    `k3d-${cluster.name}-server-0`,
    "ctr",
    "-n",
    "k8s.io",
    "images",
    "list",
  ]);
  const line = listed.stdout
    .split(/\r?\n/)
    .find((entry) => entry.split(/\s+/)[0] === importReference);
  const digest = line?.match(/sha256:[a-f0-9]{64}/i)?.[0];
  if (!digest) {
    throw new Error(`Unable to find imported OCI manifest digest for ${importReference}.`);
  }
  // Workloads use the actual imported platform manifest, not a registry index digest.
  // The approved source image remains recorded and was verified before transport.
  const runtimeReference = `${importReference.slice(0, importReference.lastIndexOf(":"))}@${digest}`;
  await execFile(process.env.OCC_DOCKER_BIN ?? "docker", [
    "exec",
    `k3d-${cluster.name}-server-0`,
    "ctr",
    "-n",
    "k8s.io",
    "images",
    "tag",
    importReference,
    runtimeReference,
  ]);
  await assertK3dImageReference(cluster, runtimeReference, envName);
  resource.reference = runtimeReference;
  await markResourceReady(statePath, state, resource);
  return resource;
}

async function prepareK3dRuntimeImages(
  statePath,
  state,
  cluster,
  env,
  { buildRuntime = false } = {},
) {
  if (
    buildRuntime &&
    (!process.env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE || !process.env.OCC_TEST_KUBERNETES_AGENT_IMAGE)
  ) {
    const built = await buildRuntimeImages(statePath, state, { runtime: true });
    Object.assign(env, built.env);
    env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE = built.env.OCC_TEST_KUBERNETES_RUNTIME_IMAGE;
    env.OCC_TEST_KUBERNETES_AGENT_IMAGE = built.env.OCC_TEST_KUBERNETES_RUNTIME_IMAGE;
  }
  const inputs = {
    OCC_TEST_KUBERNETES_GATEWAY_IMAGE:
      env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE ?? process.env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE,
    OCC_TEST_KUBERNETES_AGENT_IMAGE:
      env.OCC_TEST_KUBERNETES_AGENT_IMAGE ?? process.env.OCC_TEST_KUBERNETES_AGENT_IMAGE,
  };
  requireEnv(Object.keys(inputs), inputs);
  for (const [name, value] of Object.entries(inputs)) {
    const image = await registerImageInK3d(statePath, state, cluster, value, name);
    env[name] = image.reference;
    if (name === "OCC_TEST_KUBERNETES_GATEWAY_IMAGE") {
      env.OCC_TEST_KUBERNETES_GATEWAY_DOCKER_IMAGE = image.hostImageId;
    }
  }
  // Replace the build tag with its imported digest before publishing the next step's inputs.
  env.OCC_TEST_KUBERNETES_RUNTIME_IMAGE = env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE;
  if (lanePrepare(state.lane).codexSeccomp) {
    const seccomp = await prepareCodexSeccompProfile({
      cluster,
      image: env.OCC_TEST_KUBERNETES_AGENT_IMAGE,
      execFile,
      kubectl: cluster.kubectl ?? process.env.OCC_KUBECTL_BIN ?? "kubectl",
      codexVersion:
        env.OCC_TEST_KUBERNETES_CODEX_VERSION ??
        process.env.OCC_TEST_KUBERNETES_CODEX_VERSION ??
        "0.152.1",
    });
    env.OCC_TEST_KUBERNETES_CODEX_SECCOMP_PROFILE = seccomp.profileName;
    cluster.codexSeccompProfile = seccomp.profileName;
    cluster.codexSeccompProfiles = seccomp.nodes;
    await writeState(statePath, state);
  }
}

async function prepareProductionImages(statePath, state, cluster, env) {
  const built = await buildRuntimeImages(statePath, state, {
    controller: true,
    runtime: true,
    nodeBaseImage: effectiveLaneEnv(state.lane, env).NODE_BASE_IMAGE,
  });
  Object.assign(env, built.env);
  env.OCC_TEST_PRODUCTION_CONTROLLER_IMAGE = (
    await registerImageInK3d(
      statePath,
      state,
      cluster,
      env.OCC_TEST_PRODUCTION_CONTROLLER_IMAGE,
      "OCC_TEST_PRODUCTION_CONTROLLER_IMAGE",
    )
  ).reference;
  env.OCC_TEST_KUBERNETES_RUNTIME_IMAGE = (
    await registerImageInK3d(
      statePath,
      state,
      cluster,
      env.OCC_TEST_KUBERNETES_RUNTIME_IMAGE,
      "OCC_TEST_KUBERNETES_RUNTIME_IMAGE",
    )
  ).reference;
  requireEnv(["OCC_TEST_PRODUCTION_POSTGRES_IMAGE", "OCC_TEST_PRODUCTION_NODE_IMAGE"]);
  env.OCC_TEST_PRODUCTION_POSTGRES_IMAGE = (
    await registerImageInK3d(
      statePath,
      state,
      cluster,
      process.env.OCC_TEST_PRODUCTION_POSTGRES_IMAGE,
      "OCC_TEST_PRODUCTION_POSTGRES_IMAGE",
    )
  ).reference;
  env.OCC_TEST_PRODUCTION_NODE_IMAGE = (
    await registerImageInK3d(
      statePath,
      state,
      cluster,
      process.env.OCC_TEST_PRODUCTION_NODE_IMAGE,
      "OCC_TEST_PRODUCTION_NODE_IMAGE",
    )
  ).reference;
  for (const name of [
    "OCC_TEST_PRODUCTION_CONTROLLER_IMAGE",
    "OCC_TEST_KUBERNETES_RUNTIME_IMAGE",
    "OCC_TEST_PRODUCTION_POSTGRES_IMAGE",
    "OCC_TEST_PRODUCTION_NODE_IMAGE",
  ]) {
    assertImmutableImageReference(env[name], name);
  }
}

function baseEnv(statePath, state) {
  return {
    ...(state.env ?? {}),
    OPENCLAW_ENTERPRISE_CI_STATE: statePath,
    OPENCLAW_ENTERPRISE_CI_PREFIX: state.prefix,
  };
}

async function saveLaneEnv(statePath, state, env) {
  state.env = { ...env };
  await writeState(statePath, state);
}

async function prepareLaneLogging(statePath, state, env, cluster) {
  const logging = await prepareLogging({
    laneName: state.lane,
    cluster,
    execFile,
    registerResource: async (kind, details) => {
      const resource = addResource(state, kind, details);
      await writeState(statePath, state);
      return resource;
    },
  });
  Object.assign(env, logging.env);
  await markResourceReady(statePath, state, logging.resource);
}

async function prepareLane({ lane, statePath }) {
  const name = assertLane(lane);
  await validateLaneInputsBeforeSideEffects(name);
  const resolvedStatePath = normalizeStatePath(statePath);
  const existingState = await readState(resolvedStatePath);
  if (existingState) {
    throw new Error(
      `CI state already exists at ${resolvedStatePath}; run cleanup before preparing ${name}.`,
    );
  }
  const state = baseState(name, resolvedStatePath);
  const env = baseEnv(resolvedStatePath, state);
  await writeState(resolvedStatePath, state);

  switch (name) {
    case "postgres":
      await ensurePostgresServer(resolvedStatePath, state);
      break;
    case "images-packaging":
      await commandAvailable(process.env.OCC_HELM_BIN ?? "helm", ["version", "--short"]);
      await commandAvailable(process.env.OCC_YQ_BIN ?? "yq", ["--version"]);
      Object.assign(
        env,
        (
          await buildRuntimeImages(resolvedStatePath, state, {
            controller: true,
            runtime: true,
            nodeBaseImage: effectiveLaneEnv(name, env).NODE_BASE_IMAGE,
          })
        ).env,
      );
      break;
    case "k3d-fixture-configuration": {
      await ensurePostgresServer(resolvedStatePath, state);
      const cluster = await ensureK3dCluster(resolvedStatePath, state);
      const fixture = await prepareFixtureImage(resolvedStatePath, state, cluster);
      env.OCC_TEST_KUBERNETES_KUBECONFIG = cluster.kubeconfig;
      env.OCC_TEST_KUBERNETES_CONTEXT = cluster.context;
      env.OCC_TEST_KUBERNETES_IMAGE = fixture.image;
      break;
    }
    case "docker-model":
      Object.assign(
        env,
        (await buildRuntimeImages(resolvedStatePath, state, { runtime: true })).env,
      );
      await prepareLaneLogging(resolvedStatePath, state, env);
      break;
    case "k3d-model":
      await ensurePostgresServer(resolvedStatePath, state);
      await prepareK3dModelLane(resolvedStatePath, state, env, { buildRuntime: true });
      break;
    case "gateway-routing": {
      await commandAvailable(process.env.OCC_HELM_BIN ?? "helm", ["version", "--short"]);
      await ensurePostgresServer(resolvedStatePath, state);
      const cluster = await prepareK3dModelLane(resolvedStatePath, state, env, {
        buildRuntime: true,
      });
      const routing = await prepareGatewayRouting({ cluster, execFile });
      Object.assign(env, routing.env);
      break;
    }
    case "production-tui": {
      await commandAvailable(process.env.OCC_HELM_BIN ?? "helm", ["version", "--short"]);
      await ensurePostgresServer(resolvedStatePath, state);
      const cluster = await ensureK3dCluster(resolvedStatePath, state);
      env.OCC_TEST_KUBERNETES_KUBECONFIG = cluster.kubeconfig;
      env.OCC_TEST_KUBERNETES_CONTEXT = cluster.context;
      await prepareProductionImages(resolvedStatePath, state, cluster, env);
      await prepareLaneLogging(resolvedStatePath, state, env, cluster);
      break;
    }
    case "slack":
      await ensurePostgresServer(resolvedStatePath, state);
      await prepareK3dModelLane(resolvedStatePath, state, env, { buildRuntime: false });
      break;
    case "provider-account":
      await ensurePostgresServer(resolvedStatePath, state);
      await prepareK3dModelLane(resolvedStatePath, state, env, { buildRuntime: true });
      break;
    case "openshell": {
      await ensurePostgresServer(resolvedStatePath, state);
      const cluster = await prepareK3dModelLane(resolvedStatePath, state, env, {
        buildRuntime: true,
      });
      Object.assign(
        env,
        await prepareOpenShell({
          cluster,
          execFile,
          env: { ...process.env, ...env },
          registerImage: (image, name) =>
            registerImageInK3d(resolvedStatePath, state, cluster, image, name).then(
              (registered) => registered.reference,
            ),
        }),
      );
      break;
    }
    case "helper-timeout":
    case "logging-collector":
      break;
    case "k3d-otel": {
      await ensurePostgresServer(resolvedStatePath, state);
      const cluster = await prepareK3dModelLane(resolvedStatePath, state, env, {
        buildRuntime: true,
      });
      await prepareLaneLogging(resolvedStatePath, state, env, cluster);
      break;
    }
  }

  applyLaneEnv(name, env);
  await saveLaneEnv(resolvedStatePath, state, env);
  return { env, cleanup: async () => cleanupResourceIds(resolvedStatePath) };
}

async function prepareK3dModelLane(statePath, state, env, options) {
  const cluster = await ensureK3dCluster(statePath, state);
  env.OCC_TEST_KUBERNETES_KUBECONFIG = cluster.kubeconfig;
  env.OCC_TEST_KUBERNETES_CONTEXT = cluster.context;
  if (cluster.kubectl) {
    env.OCC_KUBECTL_BIN = cluster.kubectl;
  }
  if (cluster.runtimeClass) {
    env.OCC_TEST_OPENSHELL_RUNTIME_CLASS = cluster.runtimeClass;
  }
  if (cluster.runtimeHandler) {
    env.OCC_TEST_OPENSHELL_RUNTIME_HANDLER = cluster.runtimeHandler;
  }
  await prepareK3dRuntimeImages(statePath, state, cluster, env, options);
  return cluster;
}

async function prepareFile({ lane, file, statePath }) {
  const name = assertLane(lane);
  if (!file) {
    throw new Error("prepareFile requires a file.");
  }
  await validateLaneInputsBeforeSideEffects(name);
  const relativeFile = toRepositoryRelative(filePath(file));
  const resolvedStatePath = normalizeStatePath(statePath);
  const state = await readState(resolvedStatePath);
  const prepare = lanePrepare(name);
  if (!state && prepare.requiresPreparedStateForFile) {
    throw new Error(
      `prepareFile for ${name} requires a prior prepareLane call using the same state path.`,
    );
  }
  const effectiveState = state ?? baseState(name, resolvedStatePath);
  const env = baseEnv(resolvedStatePath, effectiveState);
  const resourceIds = [];

  if (prepare.postgres) {
    const dbKind = prepare.k3d ? "k8s" : "ci";
    const database = await createAndMigrateDatabase(resolvedStatePath, effectiveState, {
      kind: dbKind,
      label: fileStem(relativeFile),
      requireExistingServer: true,
    });
    resourceIds.push(database.resourceId);
    env.OCC_TEST_DATABASE_URL = database.appUrl;
  }

  if (relativeFile.endsWith("postgres-bootstrap-failures.test.mjs")) {
    const failures = await createAndMigrateDatabase(resolvedStatePath, effectiveState, {
      kind: "failures",
      label: fileStem(relativeFile),
      requireExistingServer: true,
    });
    resourceIds.push(failures.resourceId);
    env.OCC_BOOTSTRAP_FAILURE_DATABASE_URL = failures.appUrl;
    env.OCC_BOOTSTRAP_FAILURE_MIGRATION_DATABASE_URL = failures.migrationUrl;
  }

  if (relativeFile.endsWith("postgres-production-wireup.test.mjs")) {
    const production = await createAndMigrateDatabase(resolvedStatePath, effectiveState, {
      kind: "ci",
      label: `${fileStem(relativeFile)}_production`,
      requireExistingServer: true,
    });
    resourceIds.push(production.resourceId);
    env.OCC_PRODUCTION_WIREUP_DATABASE_URL = production.appUrl;
  }

  applyLaneEnv(name, env);

  if (state) {
    await writeState(resolvedStatePath, effectiveState);
  }
  return {
    env,
    cleanup: async () => cleanupResourceIds(resolvedStatePath, resourceIds),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.lane) {
    throw new Error("--lane is required.");
  }
  const result = args.file
    ? await prepareFile({ lane: args.lane, file: args.file, statePath: args.state })
    : await prepareLane({ lane: args.lane, statePath: args.state });
  await appendGithubEnv(args["github-env"] ?? process.env.GITHUB_ENV, result.env);
  process.stdout.write(
    `${JSON.stringify({ envNames: Object.keys(result.env).sort() }, null, 2)}\n`,
  );
}

export { prepareFile, prepareLane };

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
