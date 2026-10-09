#!/usr/bin/env node
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, isIPv4 } from "node:net";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { loadTestSuites } from "./test-suites.mjs";
import { cleanupResourceIds, deleteOwnedK3dCluster } from "./cleanup.mjs";
import { withStateLock } from "./state-lock.mjs";
import { captureK3dDiagnostics, k3dHostMetrics } from "./k3d-diagnostics.mjs";
import { prepareGatewayRouting } from "./routing.mjs";
import { prepareLogging, readDefaultCollectorImage } from "./logging.mjs";
import { pullImage } from "./image-pull.mjs";
import { keycloakResourceKind, prepareKeycloak } from "./keycloak.mjs";
import { metricsMonitoringImages } from "./metrics-monitoring-images.mjs";
import {
  prepareRepositoryCredentials,
  prepareRepositoryCredentialsFile,
} from "./repository-credentials.mjs";
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
const laneDefinitions = loadTestSuites(testSuitesManifestPath).lanes ?? {};
const allowedLanes = new Set(Object.keys(laneDefinitions));
const fixtureLanes = new Set([
  "k3d-fixture-configuration",
  "k3d-fixture-state",
  "k3d-fixture-plugins",
]);
// Ordinary k3d lanes pin the K3s node image by digest so cluster creation
// never depends on k3d's online release-channel lookup (update.k3s.io). Bump
// it deliberately to a newer v1.35 patch; OPENCLAW_CI_K3S_IMAGE still
// overrides it with another immutable reference.
const defaultK3sImage =
  "docker.io/rancher/k3s:v1.35.9-k3s1@sha256:ec9868c6a38d4e8c1869832fb5fd1eb8473c39794a0b44d2b952e7ba911951bc";
const nativeIAMBarrierFile = "tests/integration/postgres-native-iam-policy-barrier.test.mjs";
const productionUpgradeImages = {
  OCC_TEST_PRODUCTION_UPGRADE_CONTROLLER_IMAGE: "OCC_TEST_PRODUCTION_CONTROLLER_IMAGE",
  OCC_TEST_PRODUCTION_UPGRADE_RUNTIME_IMAGE: "OCC_TEST_KUBERNETES_RUNTIME_IMAGE",
};

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

function progress(lane, message) {
  process.stderr.write(`[prepare:${laneName(lane)}] ${message}\n`);
}

async function timedPreparation(lane, phase, operation) {
  const started = performance.now();
  try {
    return await operation();
  } finally {
    const elapsedMs = Math.round(performance.now() - started);
    // Labels are fixed by the runner; never include commands, paths, or credentials.
    process.stderr.write(`[ci-timing] lane=${lane} phase=${phase} duration_ms=${elapsedMs}\n`);
  }
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
  const state = {
    version: 1,
    repositoryRoot,
    lane,
    prefix: runPrefix(),
    statePath,
    createdAt: new Date().toISOString(),
    resources: [],
  };
  if (
    lane === "images-packaging" &&
    (process.env.GITHUB_RUN_ID || process.env.GITHUB_RUN_ATTEMPT)
  ) {
    const id = process.env.GITHUB_RUN_ID;
    const attempt = process.env.GITHUB_RUN_ATTEMPT;
    if (!/^[1-9][0-9]*$/.test(id ?? "") || !/^[1-9][0-9]*$/.test(attempt ?? "")) {
      throw new Error("Image CI state requires a valid run ID and attempt.");
    }
    state.ciRun = { id, attempt };
  }
  return state;
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

const stateWrites = new Map();

// The Codex version the runtime image pins; seccomp preparation verifies the
// image's `codex --version` against it, so it must not drift from the Dockerfile.
async function kubernetesCodexVersion(env) {
  const override =
    env.OCC_TEST_KUBERNETES_CODEX_VERSION ?? process.env.OCC_TEST_KUBERNETES_CODEX_VERSION;
  if (override) {
    return override;
  }
  const dockerfile = await readFile(runtimeDockerfile, "utf8");
  const match = /^ENV OPENAI_CODEX_VERSION=(\S+)$/m.exec(dockerfile);
  if (!match) {
    throw new Error(`${runtimeDockerfile} does not pin OPENAI_CODEX_VERSION.`);
  }
  return match[1];
}

async function writeState(path, state) {
  // Concurrent preparation must never publish an older cleanup inventory after
  // a newer one. A failed write still lets subsequent cleanup record its state.
  const pending = (stateWrites.get(path) ?? Promise.resolve())
    .catch(() => {})
    .then(() => persistState(path, state));
  stateWrites.set(path, pending);
  try {
    await pending;
  } finally {
    if (stateWrites.get(path) === pending) {
      stateWrites.delete(path);
    }
  }
}

async function persistState(path, state) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomSuffix()}.tmp`);
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
  await chmod(path, 0o600);
}

async function prepareTogether(operations, concurrency = operations.length) {
  const remaining = operations.entries();
  const results = [];
  const workers = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, operations.length) }, async () => {
      for (const [index, operation] of remaining) {
        results[index] = await operation();
      }
    }),
  );
  // Wait for every in-flight command before cleanup can remove its resources.
  for (const worker of workers) {
    if (worker.status === "rejected") {
      throw worker.reason;
    }
  }
  return results;
}

// The Actions runner refuses NODE_OPTIONS in $GITHUB_ENV, compared without case, and logs an
// ##[error] for it. A lane's own env, such as the checks lanes' heap limit, needs no export:
// run-tests.mjs sets it on each test process.
const GITHUB_ENV_REFUSED = new Set(["NODE_OPTIONS"]);

async function appendGithubEnv(path, env) {
  if (!path) {
    return;
  }
  const lines = Object.entries(env)
    .filter(([name]) => !GITHUB_ENV_REFUSED.has(name.toUpperCase()))
    .map(([name, value]) => `${name}=${value}`);
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
      stdio: options.stdio ?? [options.input ? "pipe" : "ignore", "pipe", "pipe"],
      // Its own process group lets a timeout reach every descendant, not only
      // the direct child (finding 840).
      detached: options.processGroup === true,
    });
    const signalCommand = (signal) => {
      if (options.processGroup === true && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // The group is gone; signal the child alone.
        }
      }
      child.kill(signal);
    };
    // A separate group no longer receives the terminal's or runner's signals.
    // Pass them on while the command runs, then let the default action stop us.
    // Each such command adds one listener per signal; only k3d create uses it.
    const forwardSignal = (signal) => {
      stopForwardingSignals();
      signalCommand(signal);
      process.kill(process.pid, signal);
    };
    const forwardedSignals = options.processGroup === true ? ["SIGINT", "SIGTERM"] : [];
    const stopForwardingSignals = () => {
      for (const signal of forwardedSignals) {
        process.removeListener(signal, forwardSignal);
      }
    };
    for (const signal of forwardedSignals) {
      process.once(signal, forwardSignal);
    }
    if (options.input) {
      // A consumer that exits early reports its own status; never crash on EPIPE.
      child.stdin.on("error", () => {});
      options.input.pipe(child.stdin);
    }
    // A streamed stdout belongs to the caller and is never buffered here.
    options.onSpawn?.(child);
    let settled = false;
    let timedOut = false;
    let killTimer;
    let timeoutTimer;
    let abandonTimer;
    if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        signalCommand("SIGTERM");
        killTimer = setTimeout(() => {
          signalCommand("SIGKILL");
          // A descendant outside the child's group can hold its output pipes
          // open, and "close" waits for them. Stop waiting after a grace period.
          // A streamed stdout is only unpiped here; its consumer's own timeout
          // bounds the consumer.
          abandonTimer = setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            finish(() => reject(timedOutError(child.exitCode, child.signalCode)));
          }, 5_000);
        }, 5_000);
      }, options.timeoutMs);
    }
    let stdout = "";
    let stderr = "";
    if (!options.streamStdout) {
      child.stdout?.on("data", (chunk) => {
        stdout = (stdout + chunk.toString()).slice(-(options.maxOutputChars ?? Infinity));
      });
    }
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-(options.maxOutputChars ?? Infinity));
    });
    function commandError(message, properties = {}) {
      const error = new Error(message);
      error.command = command;
      error.args = args;
      error.stdout = stdout;
      error.stderr = stderr;
      Object.assign(error, properties);
      return preparationError(error, timedOut ? "timeout" : properties.signal ? "signal" : "exit");
    }
    function preparationError(error, failure) {
      if (["database-create", "database-schema", "database-migrate"].includes(options.stage)) {
        error.code = "CI_PREPARATION_COMMAND_FAILED";
        error.stage = options.stage;
        error.failure = failure;
      }
      return error;
    }
    function finish(callback) {
      if (settled) {
        return;
      }
      settled = true;
      stopForwardingSignals();
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      clearTimeout(abandonTimer);
      callback();
    }
    function timedOutError(exitCode, signal) {
      return commandError(`${command} ${args.join(" ")} timed out after ${options.timeoutMs}ms`, {
        exitCode,
        signal,
        timedOut: true,
      });
    }
    child.on("error", (error) =>
      finish(() => {
        error.command = command;
        error.args = args;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(preparationError(error, "spawn"));
      }),
    );
    // Exit can precede pipe drain; callers need complete diagnostics to classify failures.
    child.on("close", (code, signal) => {
      finish(() => {
        if (timedOut) {
          reject(timedOutError(code, signal));
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

// Ports this process has handed out. PostgreSQL and k3d now reserve theirs
// concurrently and release the probe listener before binding, so the kernel could
// return the same free port to both; never hand one out twice.
const reservedLoopbackPorts = new Set();

async function reserveLoopbackPort() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
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
    if (!reservedLoopbackPorts.has(address.port)) {
      reservedLoopbackPorts.add(address.port);
      return address.port;
    }
  }
  throw new Error("Failed to reserve an unused loopback port.");
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

async function postgresExec(resource, args, stage) {
  await execFile(
    process.env.OCC_DOCKER_BIN ?? "docker",
    dockerArgsForPostgres(resource, "exec", "-T", "postgres", ...args),
    {
      env: { OCC_POSTGRES_PORT: String(resource.port) },
      stage,
    },
  );
}

// A template must be a ready database this state owns on the same server. Nothing may
// stay connected to it: PostgreSQL refuses to copy a database that has other sessions.
function templateDatabase(state, server, templateUrl) {
  let name;
  try {
    name = new URL(templateUrl).pathname.slice(1);
  } catch {
    throw new Error("The template must be a PostgreSQL URL that prepareFile returned.");
  }
  const template = state.resources.find(
    (resource) =>
      resource.kind === "postgres-database" &&
      resource.name === name &&
      resource.owner === state.prefix &&
      resource.status === "ready" &&
      resource.composeProject === server.name &&
      resource.port === server.port,
  );
  if (!template) {
    throw new Error("The template must be a ready database prepared in this state.");
  }
  return template.name;
}

async function createAndMigrateDatabase(
  statePath,
  state,
  { kind = "ci", label, requireExistingServer = false, template },
) {
  const existingServer = postgresResource(state);
  if (requireExistingServer && !existingServer) {
    throw new Error(
      "prepareFile requires prepareLane to create the owned PostgreSQL server first.",
    );
  }
  const server = existingServer ?? (await ensurePostgresServer(statePath, state));
  const source = template === undefined ? undefined : templateDatabase(state, server, template);
  const name = databaseName(kind, label);
  const resource = addResource(state, "postgres-database", {
    name,
    composeProject: server.name,
    port: server.port,
  });
  await writeState(statePath, state);

  await postgresExec(
    server,
    [
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-c",
      `CREATE DATABASE ${quoteIdentifier(name)}${source === undefined ? "" : ` TEMPLATE ${quoteIdentifier(source)}`}`,
    ],
    "database-create",
  );
  // A copy carries the template's schemas, their ACLs and every migration, but not the
  // database-level grant, which lives in pg_database.
  await postgresExec(
    server,
    [
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      name,
      "-c",
      `GRANT CREATE ON DATABASE ${quoteIdentifier(name)} TO occ_migrator;${source === undefined ? " CREATE SCHEMA occ AUTHORIZATION occ_migrator; CREATE SCHEMA drizzle AUTHORIZATION occ_migrator; REVOKE CREATE ON SCHEMA public FROM PUBLIC;" : ""}`,
    ],
    "database-schema",
  );
  const migrationUrl = postgresUrl("occ_migrator", "occ-migrator-local", server.port, name);
  if (source === undefined) {
    await execFile(process.env.OPENCLAW_CI_COREPACK_BIN ?? "corepack", ["pnpm", "db:migrate"], {
      env: { OCC_MIGRATION_DATABASE_URL: migrationUrl },
      stage: "database-migrate",
    });
  }
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
  // TODO: Remove this refusal once installed repository qualification can remove its
  // remote branch and pull request only while they still match what the run created.
  // Refuse before prerequisite checks so operators do not provision inputs for it. When
  // removing it, restore the input-validation cases this refusal replaced in ci-prepare.test.mjs.
  if (name === "repository-credentials-installed") {
    throw new Error(
      "Installed repository qualification is temporarily unavailable until safe remote cleanup is supported.",
    );
  }
  const prepare = lanePrepare(name);
  const effectiveEnv = effectiveLaneEnv(name, env);
  if (prepare.k3d && name !== "openshell" && effectiveEnv.OPENCLAW_CI_K3S_IMAGE) {
    assertImmutableImageReference(effectiveEnv.OPENCLAW_CI_K3S_IMAGE, "OPENCLAW_CI_K3S_IMAGE");
  }
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
  if (name === "production-tui") {
    const candidates = Object.keys(productionUpgradeImages);
    if (candidates.some((variable) => effectiveEnv[variable])) {
      const baselines = Object.values(productionUpgradeImages);
      assertImmutableEnvImages([...baselines, ...candidates], effectiveEnv);
      for (let index = 0; index < baselines.length; index++) {
        if (
          effectiveEnv[baselines[index]].split(/@sha256:/i)[1].toLowerCase() ===
          effectiveEnv[candidates[index]].split(/@sha256:/i)[1].toLowerCase()
        ) {
          throw new Error(
            `${candidates[index]} must select a different digest from ${baselines[index]}.`,
          );
        }
      }
    } else {
      assertNodeBaseImage(effectiveEnv.NODE_BASE_IMAGE);
    }
  }
  if (name === "repository-credentials-installed") {
    const imageMode = effectiveEnv.OCC_TEST_REPOSITORY_CREDENTIALS_IMAGE_MODE || "source";
    if (imageMode === "release") {
      assertImmutableEnvImages(
        ["OCC_TEST_PRODUCTION_CONTROLLER_IMAGE", "OCC_TEST_KUBERNETES_RUNTIME_IMAGE"],
        effectiveEnv,
      );
    } else if (imageMode === "source") {
      assertNodeBaseImage(effectiveEnv.NODE_BASE_IMAGE);
    } else {
      throw new Error("OCC_TEST_REPOSITORY_CREDENTIALS_IMAGE_MODE must be source or release.");
    }
    if (effectiveEnv.OCC_TEST_REPOSITORY_CREDENTIALS_AUTHORIZED !== "1") {
      throw new Error(
        "Installed repository qualification requires explicit write and cleanup authorization.",
      );
    }
    if (
      !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(
        effectiveEnv.OCC_TEST_REPOSITORY_CREDENTIALS_REPOSITORY,
      )
    ) {
      throw new Error(
        "OCC_TEST_REPOSITORY_CREDENTIALS_REPOSITORY must select one owner/repository.",
      );
    }
    for (const input of ["APP_CONFIG_FILE", "APP_KEY_FILE"]) {
      const variable = `OCC_TEST_REPOSITORY_CREDENTIALS_${input}`;
      const path = effectiveEnv[variable];
      if (!isAbsolute(path)) {
        throw new Error(`${variable} must be an absolute protected file.`);
      }
      const info = await lstat(path);
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        (info.uid !== process.getuid() && info.uid !== 0) ||
        info.size === 0 ||
        info.size > 262144
      ) {
        throw new Error(`${variable} must be a bounded regular private file with a trusted owner.`);
      }
      if ((info.mode & 0o777) !== 0o600) {
        throw new Error(`${variable} must have mode 0600.`);
      }
    }
    const cidrs = effectiveEnv.OCC_TEST_REPOSITORY_CREDENTIALS_UPSTREAM_CIDRS.split(",");
    if (
      cidrs.length > 64 ||
      cidrs.some((cidr) => {
        const [address, prefix, extra] = cidr.split("/");
        return (
          extra !== undefined ||
          prefix !== "32" ||
          !isIPv4(address) ||
          /^(?:0\.|10\.|127\.|169\.254\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(address)
        );
      })
    ) {
      throw new Error(
        "OCC_TEST_REPOSITORY_CREDENTIALS_UPSTREAM_CIDRS must select approved public IPv4 /32 addresses.",
      );
    }
    const gh = effectiveEnv.OCC_TEST_REPOSITORY_CREDENTIALS_GH_BINARY;
    if (gh && !isAbsolute(gh)) {
      throw new Error("OCC_TEST_REPOSITORY_CREDENTIALS_GH_BINARY must be absolute when supplied.");
    }
  }
}

// Lanes that may restore the hosted BuildKit cache. Only images-packaging
// exports it, on main pushes, and the main-only warm job (ci-image-cache.yml)
// builds with that lane's state. The repository platform lane loads its
// runtime image into the Docker engine so a default-builder fixture build can
// derive from it.
const imageCacheLanes = new Map([
  ["images-packaging", { localStore: false }],
  ["images-model-probes", { localStore: false }],
  ["images-runtime-startup", { localStore: false }],
  ["images-runtime-startup-2", { localStore: false }],
  ["repository-credentials-platform", { localStore: true }],
]);

function imageBuildArgs(state, role, localStore, cacheWarm = false) {
  if (process.env.OCC_CI_IMAGE_CACHE === "1") {
    if (
      process.env.GITHUB_ACTIONS !== "true" ||
      imageCacheLanes.get(state.lane)?.localStore !== localStore ||
      !process.env.ACTIONS_RUNTIME_TOKEN ||
      !process.env.ACTIONS_RESULTS_URL
    ) {
      throw new Error("Image caching requires the hosted image lane and its cache credentials.");
    }
    const cache = `type=gha,version=2,scope=oce-ci-${role}-${process.platform}-${process.arch}-v1`;
    return [
      "buildx",
      "build",
      "--load",
      // An image ID covers each history entry's creation time. A fixed epoch lets
      // builders that write the same layers agree on the ID, so reuseEngineImage
      // can match an image another job built. It sets the config and history
      // timestamps and WORKDIR directory mtimes; RUN steps do not see it.
      "--build-arg",
      "SOURCE_DATE_EPOCH=0",
      "--cache-from",
      `${cache},timeout=60s`,
      // One writer per image among the parallel image lanes; on main the warm job
      // writes the same scope too (the last index wins). The warm job exists to
      // export, so each cache transfer may take longer and a failed export fails
      // the job instead of being ignored. Pull request runs only restore: their
      // export cost Images and Packaging about 40 s and filled only their own
      // merge ref's scope. Main pushes keep the lane's export as a backstop.
      ...(state.lane === "images-packaging" &&
      (cacheWarm || process.env.GITHUB_EVENT_NAME === "push")
        ? [
            "--cache-to",
            cacheWarm
              ? `${cache},mode=max,timeout=10m`
              : `${cache},mode=max,ignore-error=true,timeout=60s`,
          ]
        : []),
    ];
  }
  return [
    "build",
    ...(localStore && basename(process.env.OCC_DOCKER_BIN ?? "docker") !== "podman"
      ? ["--builder", "default", "--load"]
      : []),
  ];
}

// A restored build otherwise downloads every cached layer (about 20 s for the
// runtime image) only to load an image the engine often already holds: the
// hosted runners' Docker data comes from a shared image cache. Resolve the
// image from the BuildKit cache without exporting its layers, then tag the
// engine's image if it has the same ID. The ID is the digest of a config that
// names every layer's content digest, so the tagged image is the one the build
// would load. Lanes that export the cache, and any probe failure (a timeout, an
// engine error, unreadable metadata, a failed tag), build as before. The log
// says "absent" only when the engine reports no such image, "different" when it
// holds another image under that reference, and "probe-failed" otherwise.
async function reuseEngineImage(state, role, args, tag) {
  if (args[0] !== "buildx" || !args.includes("--load") || args.includes("--cache-to")) {
    return false;
  }
  const docker = process.env.OCC_DOCKER_BIN ?? "docker";
  const started = performance.now();
  let directory;
  let outcome = "unresolved";
  let image;
  try {
    directory = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "oce-image-probe-"));
    const metadata = join(directory, "metadata.json");
    await execFile(
      docker,
      [
        "buildx",
        "build",
        "--output",
        "type=image,push=false,store=false",
        "--provenance=false",
        "--metadata-file",
        metadata,
        ...args.slice(2).filter((arg) => arg !== "--load"),
      ],
      // A cache miss builds the image here; the build below then reuses those
      // steps from the same builder and only exports and loads.
      { timeoutMs: 20 * 60_000 },
    );
    const id = JSON.parse(await readFile(metadata, "utf8"))["containerimage.config.digest"];
    if (!/^sha256:[a-f0-9]{64}$/u.test(id ?? "")) {
      return false;
    }
    image = id;
    // Under Docker's containerd image store the engine reports a manifest
    // digest here instead, so the comparison fails safe, the log says
    // "different", and the lane builds.
    let held;
    try {
      held = (
        await boundedImageCommand(["image", "inspect", "--format", "{{.Id}}", id])
      ).stdout.trim();
    } catch (error) {
      if (!/No such (?:image|object)|image not known/i.test(error.stderr ?? "")) {
        throw error;
      }
      outcome = "absent";
      return false;
    }
    if (held !== id) {
      outcome = "different";
      return false;
    }
    await boundedImageCommand(["tag", id, tag]);
    outcome = "reused";
    return true;
  } catch {
    outcome = "probe-failed";
    return false;
  } finally {
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
    progress(
      state.lane,
      JSON.stringify({
        stage: `${role}-image-reuse`,
        outcome,
        ...(image ? { image } : {}),
        elapsedMs: Math.round(performance.now() - started),
      }),
    );
  }
}

async function buildRuntimeImages(
  statePath,
  state,
  {
    controller = false,
    runtime = false,
    nodeBaseImage = process.env.NODE_BASE_IMAGE,
    localStore = false,
    cacheWarm = false,
  } = {},
) {
  // Plain BuildKit progress shows each step's cache hit or duration. The warm job
  // prints it per image once the build ends (parallel builds stay readable), also
  // when the build fails or overruns its own deadline inside the job's.
  const progress = cacheWarm ? ["--progress=plain"] : [];
  const build = async (role, args) => {
    if (!cacheWarm) {
      return execFile(process.env.OCC_DOCKER_BIN ?? "docker", args);
    }
    let output = "";
    try {
      const built = await execFile(process.env.OCC_DOCKER_BIN ?? "docker", args, {
        timeoutMs: 20 * 60_000,
      });
      output = built.stderr;
      return built;
    } catch (error) {
      output = error.stderr ?? "";
      throw error;
    } finally {
      process.stderr.write(`[image-cache-warm] ${role} build\n${output}\n`);
    }
  };
  await commandAvailable(process.env.OCC_DOCKER_BIN ?? "docker", [
    "version",
    "--format",
    "{{.Server.Version}}",
  ]);
  const env = {};
  const resources = [];
  const label =
    state.lane === "images-packaging" && state.ciRun
      ? createHash("sha256")
          .update(JSON.stringify([state.ciRun.id, state.ciRun.attempt, state.prefix]))
          .digest("hex")
          .slice(0, 17)
      : state.prefix;
  const tagBase = `localhost/${ownedName("openclaw-ci-image", label, { maxLength: 48 })}`;
  const openclawSource = runtime ? process.env.OCC_K3D_OPENCLAW_SOURCE : undefined;
  if (controller) {
    assertNodeBaseImage(nodeBaseImage);
  }
  if (openclawSource !== undefined) {
    if (!isAbsolute(openclawSource) || !(await stat(join(openclawSource, "Dockerfile"))).isFile()) {
      throw new Error("OCC_K3D_OPENCLAW_SOURCE must select an absolute OpenClaw source checkout");
    }
    if (!/^[a-f0-9]{40,64}$/u.test(process.env.OCC_K3D_OPENCLAW_COMMIT ?? "")) {
      throw new Error("OCC_K3D_OPENCLAW_COMMIT must identify the selected OpenClaw source");
    }
  }
  const builds = [];
  if (controller) {
    const tag = `${tagBase}/controller:local`;
    builds.push({
      role: "controller",
      tag,
      args: [
        ...imageBuildArgs(state, "controller", localStore, cacheWarm),
        ...progress,
        "--pull=false",
        "--target",
        "runtime",
        "--build-arg",
        `NODE_BASE_IMAGE=${nodeBaseImage}`,
        "-t",
        tag,
        ".",
      ],
      env: { OCC_TEST_PRODUCTION_IMAGE: tag, OCC_TEST_PRODUCTION_CONTROLLER_IMAGE: tag },
    });
  }
  if (runtime) {
    const tag = `${tagBase}/runtime:local`;
    builds.push({
      role: "runtime",
      tag,
      args:
        openclawSource === undefined
          ? [
              ...imageBuildArgs(state, "runtime", localStore, cacheWarm),
              ...progress,
              "--pull=false",
              "-f",
              runtimeDockerfile,
              "-t",
              tag,
              repositoryRoot,
            ]
          : [
              "build",
              ...(localStore && basename(process.env.OCC_DOCKER_BIN ?? "docker") !== "podman"
                ? ["--builder", "default", "--load"]
                : []),
              "--build-arg",
              "OPENCLAW_DOCKER_BUILD_SKIP_DTS=1",
              "-t",
              tag,
              openclawSource,
            ],
      env: {
        OCC_TEST_RUNTIME_IMAGE: tag,
        OCC_DOCKER_RUNTIME_IMAGE: tag,
        OCC_DOCKER_GATEWAY_IMAGE: tag,
        OCC_DOCKER_AGENT_IMAGE: tag,
        OCC_TEST_KUBERNETES_RUNTIME_IMAGE: tag,
        ...(openclawSource === undefined
          ? {}
          : { OCC_K3D_OPENCLAW_COMMIT: process.env.OCC_K3D_OPENCLAW_COMMIT }),
      },
    });
  }
  // Record every tag before any build starts. The builds are independent, so
  // they run together and take as long as the slower one instead of their sum.
  for (const entry of builds) {
    entry.resource = addResource(state, "image-tag", { name: entry.tag, owner: state.prefix });
    resources.push(entry.resource);
  }
  await writeState(statePath, state);
  await prepareTogether(
    builds.map((entry) => async () => {
      if (!(await reuseEngineImage(state, entry.role, entry.args, entry.tag))) {
        await build(entry.role, entry.args);
      }
      await markResourceReady(statePath, state, entry.resource);
    }),
  );
  for (const entry of builds) {
    Object.assign(env, entry.env);
  }
  return { env, resourceIds: resources.map((resource) => resource.id) };
}

async function k3dStage(state, stage, run) {
  const started = performance.now();
  progress(state.lane, JSON.stringify({ stage, status: "started" }));
  let status = "failed";
  try {
    const result = await run();
    status = "passed";
    return result;
  } finally {
    progress(
      state.lane,
      JSON.stringify({ stage, status, elapsedMs: Math.round(performance.now() - started) }),
    );
  }
}

async function logK3dHost(state, directory, stage) {
  try {
    progress(state.lane, JSON.stringify({ stage, ...(await k3dHostMetrics(directory)) }));
  } catch {
    progress(state.lane, JSON.stringify({ stage, status: "unavailable" }));
  }
}

async function ensureK3dCluster(statePath, state) {
  const existing = state.resources.find((resource) => resource.kind === "k3d-cluster");
  if (existing) {
    return existing;
  }
  await commandAvailable(process.env.OPENCLAW_CI_K3D_BIN ?? "k3d", ["version"]);
  const openShell = state.lane === "openshell";
  const crossNodePluginStatus = fixtureLanes.has(state.lane);
  if (!openShell) {
    await commandAvailable(process.env.OCC_KUBECTL_BIN ?? "kubectl", ["version", "--client=true"]);
  }
  const cluster = ownedName("openclaw-k8s", state.prefix, { maxLength: 32 });
  const apiPort = await reserveLoopbackPort();
  const directory = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), `${cluster}-`));
  await chmod(directory, 0o700);
  const kubeconfig = join(directory, "kubeconfig");
  const sharedStorage = crossNodePluginStatus ? join(directory, "storage") : undefined;
  if (sharedStorage) {
    await mkdir(sharedStorage, { mode: 0o700 });
  }
  const resource = addResource(state, "k3d-cluster", {
    name: cluster,
    directory,
    kubeconfig,
    context: `k3d-${cluster}`,
    nodes: [
      `k3d-${cluster}-server-0`,
      ...(crossNodePluginStatus ? [`k3d-${cluster}-agent-0`] : []),
    ],
    // A digest-pinned image bypasses k3d's online release-channel lookup. The
    // running API server must still satisfy the ordinary Kubernetes 1.35 gate.
    ...(!openShell ? { nodeImage: process.env.OPENCLAW_CI_K3S_IMAGE || defaultK3sImage } : {}),
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
  try {
    if (crossNodePluginStatus) {
      await logK3dHost(state, directory, "k3d-host-before");
    }
    await createK3dCluster(statePath, state, resource, [
      "cluster",
      "create",
      cluster,
      ...(resource.nodeImage ? ["--image", resource.nodeImage] : []),
      ...(resource.podSecurityAdmissionK3dArgs ?? []),
      "--servers",
      "1",
      "--agents",
      crossNodePluginStatus ? "1" : "0",
      ...(sharedStorage ? ["--volume", `${sharedStorage}:/var/lib/rancher/k3s/storage@all`] : []),
      "--api-port",
      `127.0.0.1:${apiPort}`,
      "--kubeconfig-update-default=false",
      "--kubeconfig-switch-context=false",
      "--lb-config-override",
      `settings.workerConnections=${k3dLoadBalancerWorkerConnections}`,
      // Keep failed fixture containers for diagnostics; registered cleanup
      // owns their deletion after collection, including partial creation.
      ...(crossNodePluginStatus ? ["--no-rollback"] : []),
    ]);
    await k3dStage(state, "k3d-kubeconfig", async () => {
      const kubeconfigData = await execFile(process.env.OPENCLAW_CI_K3D_BIN ?? "k3d", [
        "kubeconfig",
        "get",
        cluster,
      ]);
      await writeFile(kubeconfig, kubeconfigData.stdout, { mode: 0o600 });
      await chmod(kubeconfig, 0o600);
      await validateLoopbackKubeconfig(kubeconfig, resource.context, resource.kubectl);
    });
    await k3dStage(state, "k3d-nodes-ready", () =>
      execFile(resource.kubectl ?? process.env.OCC_KUBECTL_BIN ?? "kubectl", [
        "--kubeconfig",
        kubeconfig,
        "--context",
        resource.context,
        "wait",
        "--for=condition=Ready",
        "nodes",
        "--all",
        "--timeout=120s",
      ]),
    );
    if (!openShell) {
      resource.kubernetesVersion = await k3dStage(state, "k3d-version", async () => {
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
        return gitVersion;
      });
    }
    if (crossNodePluginStatus) {
      resource.pluginStatusProxyCidrs = await k3dStage(state, "k3d-overlay", async () => {
        const worker = await execFile(process.env.OCC_KUBECTL_BIN ?? "kubectl", [
          "--kubeconfig",
          kubeconfig,
          "--context",
          resource.context,
          "get",
          "node",
          `k3d-${cluster}-agent-0`,
          "-o",
          "json",
        ]);
        const podCidr = JSON.parse(worker.stdout)?.spec?.podCIDR;
        const destination = typeof podCidr === "string" ? podCidr.split("/")[0] : undefined;
        if (!isIPv4(destination ?? "")) {
          throw new Error("The plugin status worker must have an IPv4 Pod CIDR.");
        }
        return waitForPluginStatusProxySource(cluster, destination);
      });
      await k3dStage(state, "k3d-storage", () => verifyFixtureStorage(resource));
    }
    if (crossNodePluginStatus) {
      await logK3dHost(state, directory, "k3d-host-after");
    }
  } catch (error) {
    if (crossNodePluginStatus && !error.k3dDiagnosticsCaptured) {
      await captureK3dDiagnostics({
        execFile,
        cluster: resource,
        lane: state.lane,
        statePath,
      }).catch(() => progress(state.lane, "k3d diagnostics unavailable"));
    }
    throw error;
  }
  await markResourceReady(statePath, state, resource);
  return resource;
}

// k3d's serverlb (nginx) in front of the API server allows 1024 connections per
// worker, and each proxied API connection counts twice. The connections appear to
// land on one worker: drops started once the serverlb held about 1,024. The k3d
// Fixture and Configuration lane peaked at 1,050-1,080 on the 32vcpu runner
// (530-760 on ubuntu-22.04), and kubectl reported "Unable to connect to the
// server: EOF" (finding 682). With this limit it peaks at about 2,000.
const k3dLoadBalancerWorkerConnections = 8192;

// Hosted CI creates a cluster, node image pull included, in 26-48 s (284 runs,
// 2026-10-08: p50 27 s, p99 44 s). A create that never returns once held a lane
// for 44 minutes until the job timeout (finding 840).
const k3dCreateTimeoutMs =
  Number(process.env.OPENCLAW_CI_K3D_CREATE_TIMEOUT_MS) > 0
    ? Number(process.env.OPENCLAW_CI_K3D_CREATE_TIMEOUT_MS)
    : 5 * 60_000;
const k3dCreateAttempts = 2;

// Bound each create. After a timeout, keep diagnostics, delete what the
// attempt created, and try once more with the same owned name and directory.
// The final failure leaves the planned resource for registered cleanup.
async function createK3dCluster(statePath, state, resource, args) {
  const k3d = process.env.OPENCLAW_CI_K3D_BIN ?? "k3d";
  for (let attempt = 1; ; attempt += 1) {
    try {
      await k3dStage(state, "k3d-create", () =>
        execFile(k3d, args, { timeoutMs: k3dCreateTimeoutMs, processGroup: true }),
      );
      return;
    } catch (error) {
      if (error.timedOut !== true) {
        throw error;
      }
      const summary =
        `k3d cluster create ${resource.name} did not finish within ${k3dCreateTimeoutMs} ms ` +
        `(attempt ${attempt} of ${k3dCreateAttempts})`;
      progress(state.lane, summary);
      await captureK3dDiagnostics({
        execFile,
        cluster: resource,
        lane: state.lane,
        statePath,
        failure: summary,
      }).catch(() => progress(state.lane, "k3d diagnostics unavailable"));
      if (attempt >= k3dCreateAttempts) {
        const failure = new Error(
          `${summary}; giving up. Diagnostics are in ${statePath}.diagnostics.json, and ` +
            "cleanup removes the partial cluster.",
          { cause: error },
        );
        failure.k3dDiagnosticsCaptured = true;
        throw failure;
      }
      try {
        await k3dStage(state, "k3d-create-discard", () =>
          deleteOwnedK3dCluster(resource, {
            execFile: (command, commandArgs) =>
              execFile(command, commandArgs, { timeoutMs: 2 * 60_000 }),
          }),
        );
      } catch (discardError) {
        // Keep the report that names the timeout; cleanup retries the deletion.
        discardError.message = `${summary}; deleting the partial cluster failed: ${discardError.message}`;
        discardError.k3dDiagnosticsCaptured = true;
        throw discardError;
      }
    }
  }
}

async function waitForPluginStatusProxySource(cluster, destination) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const route = await execFile(
      process.env.OCC_DOCKER_BIN ?? "docker",
      ["exec", `k3d-${cluster}-server-0`, "ip", "route", "get", destination],
      { timeoutMs: Math.min(15_000, deadline - Date.now()) },
    );
    // These owned clusters use K3s's default Flannel VXLAN backend. Node Ready
    // can precede its cross-node route; an earlier lookup uses eth0's default
    // route and would permanently admit the wrong source in NetworkPolicies.
    if (!/\bdev\s+flannel\.1(?:\s|$)/.test(route.stdout)) {
      await delay(500);
      continue;
    }
    const sources = [...route.stdout.matchAll(/\bsrc\s+(\S+)/g)].map((match) => match[1]);
    if (
      sources.length !== 1 ||
      !isIPv4(sources[0]) ||
      sources[0] === "0.0.0.0" ||
      sources[0].startsWith("127.")
    ) {
      throw new Error(
        "Unable to determine the cross-node plugin status proxy source IPv4 address.",
      );
    }
    return `${sources[0]}/32`;
  }
  throw new Error("Timed out waiting for the cross-node plugin status proxy route on flannel.1.");
}

async function verifyFixtureStorage(cluster, timeoutSeconds = 120) {
  const kubectl = process.env.OCC_KUBECTL_BIN ?? "kubectl";
  const scope = [
    "--kubeconfig",
    cluster.kubeconfig,
    "--context",
    cluster.context,
    "--namespace",
    "kube-system",
  ];
  try {
    await execFile(
      kubectl,
      [
        ...scope,
        "rollout",
        "status",
        "deployment/local-path-provisioner",
        `--timeout=${timeoutSeconds}s`,
      ],
      { timeoutMs: (timeoutSeconds + 10) * 1_000 },
    );
  } catch {
    // This fixture lane has no provider credentials. Limit diagnostics to its
    // storage controller; never serialize arbitrary Pod specs or tenant logs.
    const observations = await Promise.allSettled([
      execFile(
        kubectl,
        [...scope, "get", "pods", "--selector=app=local-path-provisioner", "-o", "json"],
        { timeoutMs: 10_000 },
      ),
      ...[false, true].map((previous) =>
        execFile(
          kubectl,
          [
            ...scope,
            "logs",
            "deployment/local-path-provisioner",
            "--tail=30",
            ...(previous ? ["--previous"] : []),
          ],
          { timeoutMs: 10_000 },
        ),
      ),
      execFile(kubectl, [...scope.slice(0, 4), "get", "nodes", "-o", "json"], {
        timeoutMs: 10_000,
      }),
    ]);
    let pods = [];
    if (observations[0].status === "fulfilled") {
      try {
        pods = (JSON.parse(observations[0].value.stdout).items ?? []).map((pod) => ({
          name: pod.metadata?.name,
          node: pod.spec?.nodeName,
          nodeSelector: pod.spec?.nodeSelector,
          phase: pod.status?.phase,
          conditions: (pod.status?.conditions ?? []).map(({ type, status, reason, message }) => ({
            type,
            status,
            reason,
            message,
          })),
          containers: (pod.status?.containerStatuses ?? []).map((container) => ({
            name: container.name,
            image: container.image,
            ready: container.ready,
            restarts: container.restartCount,
            waiting: container.state?.waiting,
            terminated: container.state?.terminated?.reason,
          })),
        }));
      } catch {
        // Preserve the storage failure even when Kubernetes diagnostics are incomplete.
      }
    }
    let nodes = [];
    if (observations[3].status === "fulfilled") {
      try {
        nodes = (JSON.parse(observations[3].value.stdout).items ?? []).map((node) => ({
          name: node.metadata?.name,
          unschedulable: node.spec?.unschedulable,
          taints: node.spec?.taints,
          conditions: (node.status?.conditions ?? [])
            .filter(({ type }) =>
              ["Ready", "DiskPressure", "MemoryPressure", "PIDPressure"].includes(type),
            )
            .map(({ type, status, reason, message }) => ({ type, status, reason, message })),
        }));
      } catch {
        // Do not replace the storage failure with a diagnostic parsing failure.
      }
    }
    const logs = observations
      .slice(1, 3)
      .map((result) =>
        result.status === "fulfilled" ? result.value.stdout.slice(-4_000) : "unavailable",
      );
    throw new Error(
      `CI fixture storage controller is not ready: ${JSON.stringify({ kubernetesVersion: cluster.kubernetesVersion, pods, nodes, logs })}`,
    );
  }
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

// The fixture build needs no cluster, so lanes can overlap it with k3d creation.
async function buildFixtureImage(statePath, state) {
  await commandAvailable(process.env.OCC_DOCKER_BIN ?? "docker", [
    "version",
    "--format",
    "{{.Server.Version}}",
  ]);
  const image = `localhost/${ownedName("openclaw-ci-image", state.prefix, { maxLength: 48 })}/fixture:local`;
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
  return { image, resourceId: resource.id };
}

async function importFixtureImage(statePath, state, cluster, built) {
  const registered = await registerImageInK3d(
    statePath,
    state,
    cluster,
    built.image,
    "OCC_TEST_KUBERNETES_IMAGE",
  );
  return { image: registered.reference, resourceId: built.resourceId };
}

async function pinFixtureImageInK3d(cluster, image) {
  const name = "openclaw-ci-fixture-image-pin";
  const manifestPath = join(cluster.directory, `${name}.json`);
  const manifest = {
    apiVersion: "apps/v1",
    kind: "DaemonSet",
    metadata: { name, namespace: "kube-system" },
    spec: {
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { app: name } },
        spec: {
          automountServiceAccountToken: false,
          nodeSelector: { "kubernetes.io/os": "linux" },
          tolerations: [{ operator: "Exists" }],
          containers: [
            {
              name: "pin",
              image,
              imagePullPolicy: "Never",
              command: ["node", "-e", "setInterval(() => {}, 2147483647)"],
              resources: {
                requests: { cpu: "1m", memory: "8Mi" },
                limits: { cpu: "25m", memory: "128Mi" },
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
                readOnlyRootFilesystem: true,
                runAsNonRoot: true,
                runAsUser: 1000,
                seccompProfile: { type: "RuntimeDefault" },
              },
            },
          ],
        },
      },
    },
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await execFile(process.env.OCC_KUBECTL_BIN ?? "kubectl", [
    "--kubeconfig",
    cluster.kubeconfig,
    "--context",
    cluster.context,
    "--namespace",
    "kube-system",
    "apply",
    "-f",
    manifestPath,
  ]);
  await execFile(
    process.env.OCC_KUBECTL_BIN ?? "kubectl",
    [
      "--kubeconfig",
      cluster.kubeconfig,
      "--context",
      cluster.context,
      "--namespace",
      "kube-system",
      "rollout",
      "status",
      `daemonset/${name}`,
      "--timeout=120s",
    ],
    { timeoutMs: 130_000 },
  );
}

// The platform image needs no cluster, so the lane overlaps it with k3d creation.
async function buildRepositoryPlatformImage(statePath, state) {
  const runtime = await timedPreparation(state.lane, "runtime-image-build", () =>
    buildRuntimeImages(statePath, state, { runtime: true, localStore: true }),
  );
  const image = `localhost/${ownedName("openclaw-ci-image", state.prefix, { maxLength: 48 })}/repository-platform:local`;
  const resource = addResource(state, "image-tag", { name: image, owner: state.prefix });
  await writeState(statePath, state);
  // Derive the controlled Harness from the delivered runtime so its Git/gh
  // clients and credential material entrypoint remain the production ones.
  await timedPreparation(state.lane, "platform-fixture-build", () =>
    execFile(process.env.OCC_DOCKER_BIN ?? "docker", [
      "build",
      "--builder",
      "default",
      "--load",
      "--pull=false",
      "--build-arg",
      `RUNTIME_IMAGE=${runtime.env.OCC_TEST_RUNTIME_IMAGE}`,
      "-f",
      join(repositoryRoot, "tests/fixtures/repository-credentials/Dockerfile.platform-fixture"),
      "-t",
      image,
      join(repositoryRoot, "tests/fixtures/repository-credentials"),
    ]),
  );
  await markResourceReady(statePath, state, resource);
  return image;
}

async function repositoryPlatformHostAddress(cluster) {
  const result = await execFile(process.env.OCC_DOCKER_BIN ?? "docker", [
    "inspect",
    "--format",
    "{{json .NetworkSettings.Networks}}",
    `k3d-${cluster.name}-server-0`,
  ]);
  const address = JSON.parse(result.stdout)[`k3d-${cluster.name}`]?.Gateway;
  if (
    !isIPv4(address ?? "") ||
    !/^(?:10\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(address)
  ) {
    throw new Error("The owned k3d network must expose a private IPv4 Docker host gateway.");
  }
  return address;
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

// Each image inspect or tag on the host engine, and each check or tag on a k3d node, is
// one short command; a hung one (an unresponsive node or engine) fails the step with a
// clear message instead of stalling it until the job timeout. A timeout is never read as
// an absent image: its error carries no engine output, so nothing pulls or retries it.
// Despite its name, the variable also bounds the source image inspects of lanes without
// k3d, such as Images and Packaging and Logging Collector.
const imageCommandTimeoutMs =
  Number(process.env.OPENCLAW_CI_K3D_IMAGE_CHECK_TIMEOUT_MS) > 0
    ? Number(process.env.OPENCLAW_CI_K3D_IMAGE_CHECK_TIMEOUT_MS)
    : 30_000;

async function boundedImageCommand(
  args,
  what = "The container engine",
  shown = args,
  docker = process.env.OCC_DOCKER_BIN ?? "docker",
) {
  try {
    return await execFile(docker, args, {
      timeoutMs: imageCommandTimeoutMs,
    });
  } catch (error) {
    if (error.timedOut === true) {
      throw new Error(
        `${what} did not answer within ${imageCommandTimeoutMs} ms (${shown.join(" ")}).`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function dockerImageHasRepoDigest(image, docker) {
  const expected = immutableDigest(image);
  if (!expected) {
    return false;
  }
  const args = ["image", "inspect", "--format", "{{json .RepoDigests}}", image];
  const inspected = await boundedImageCommand(args, "The container engine", args, docker);
  const repoDigests = JSON.parse(inspected.stdout.trim() || "[]");
  if (!Array.isArray(repoDigests)) {
    return false;
  }
  return repoDigests.some((reference) => reference.toLowerCase().endsWith(`@sha256:${expected}`));
}

async function dockerImageId(image, docker) {
  const args = ["image", "inspect", "--format", "{{.Id}}", image];
  const inspected = await boundedImageCommand(args, "The container engine", args, docker);
  const value = inspected.stdout.trim();
  const id = /^[a-f0-9]{64}$/i.test(value) ? `sha256:${value}` : value;
  assertDockerImageId(id, `Docker image ${image}`);
  return id;
}

function assertDockerImageId(id, description) {
  if (!/^sha256:[a-f0-9]{64}$/i.test(id)) {
    throw new Error(`${description} did not resolve to an immutable local image ID.`);
  }
}

async function ensureDockerSourceImage(
  state,
  image,
  envName,
  docker = process.env.OCC_DOCKER_BIN ?? "docker",
) {
  if (stateOwnsImageTag(state, image)) {
    const args = ["image", "inspect", image];
    await boundedImageCommand(args, "The container engine", args, docker);
    return dockerImageId(image, docker);
  }
  assertImmutableImageReference(image, envName);
  try {
    if (await dockerImageHasRepoDigest(image, docker)) {
      return await dockerImageId(image, docker);
    }
  } catch (error) {
    // A locally built immutable image may have no reachable registry. Reuse
    // only its verified repository digest; other Docker failures stay visible.
    if (!/No such (?:image|object)|image not known/i.test(error.stderr ?? "")) {
      throw error;
    }
  }
  await pullImage(image, { execFile, docker });
  if (!(await dockerImageHasRepoDigest(image, docker))) {
    throw new Error(`${envName} pull did not materialize the requested registry digest.`);
  }
  return dockerImageId(image, docker);
}

// This deliberately unrelated release exercises the launcher's source-revision guard.
// Registry images remain in the engine cache; preparation owns no tag or cluster.
export const devUpUnrelatedImage =
  "rancher/k3s:v1.36.4-k3s1@sha256:edad48e12bf81c3a09ac1c05c0c0ffaaa22145980b989d6fae84543a76b83657";

export async function prepareDevUpImage(
  docker = process.env.OCC_TEST_DEV_UP_CONTAINER_ENGINE || "docker",
) {
  await ensureDockerSourceImage(
    { resources: [] },
    devUpUnrelatedImage,
    "Dev-up rejection image",
    docker,
  );
}

// containerd's CRI plugin answers `crictl inspecti` only from its in-memory image
// cache, which its serial event monitor fills from containerd ImageCreate events.
// A reference that `ctr images tag` just created is in containerd's image store
// (and `ctr images list`) before that event is handled, so CRI can briefly report
// "no such image". Wait a bounded time for that one answer; any other failure is final.
const criImageCacheWaitMs = 5_000;

// Each check or tag on a node after the import is one short exec. The timeout stops the
// engine CLI; a process it started inside the node may keep running until the cluster is
// removed.
async function k3dNodeImageCheck(node, args, what) {
  return boundedImageCommand(["exec", node, ...args], `${what} on ${node}`, args);
}

async function inspectK3dCriImage(lane, node, reference, envName) {
  const deadline = performance.now() + criImageCacheWaitMs;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await k3dNodeImageCheck(node, ["crictl", "inspecti", reference], "CRI");
    } catch (error) {
      const remainingMs = deadline - performance.now();
      if (!/\bno such image\b/i.test(error.stderr ?? "") || remainingMs <= 0) {
        throw error;
      }
      progress(
        lane,
        `CRI on ${node} does not list the imported ${envName} reference yet (attempt ${attempt}); retrying.`,
      );
      await delay(Math.min(250 * attempt, 1_000, remainingMs));
    }
  }
}

async function assertK3dImageReference(lane, cluster, reference, envName) {
  for (const node of cluster.nodes) {
    const listed = await k3dNodeImageCheck(
      node,
      ["ctr", "-n", "k8s.io", "images", "list"],
      "containerd",
    );
    const found = listed.stdout.split(/\r?\n/).some((entry) => entry.split(/\s+/)[0] === reference);
    if (!found) {
      throw new Error(`Unable to find imported ${envName} reference ${reference}.`);
    }
    await inspectK3dCriImage(lane, node, reference, envName);
  }
}

// Stream one image export into every owned node's containerd at once. No
// archive touches the host or node disks. The export and every node import
// must exit 0; the caller then verifies the imported reference on each node.
async function streamImageIntoK3dNodes(cluster, saveArgs) {
  const containerEngine = process.env.OCC_DOCKER_BIN ?? "docker";
  let save;
  const saved = execFile(containerEngine, saveArgs, {
    timeoutMs: 600_000,
    streamStdout: true,
    onSpawn: (child) => {
      save = child;
    },
  });
  // Settled below, after the imports; never let an early failure go unhandled.
  saved.catch(() => {});
  let stoppedExport = false;
  let firstImportError;
  const imports = cluster.nodes.map((node) =>
    execFile(
      containerEngine,
      ["exec", "-i", node, "ctr", "-n", "k8s.io", "images", "import", "--all-platforms", "-"],
      { timeoutMs: 600_000, input: save.stdout },
    ).catch((error) => {
      // The first node failure is the cause; later ones may follow from it.
      firstImportError ??= error;
      // A failed node stops reading. Stop a still-running export so it cannot
      // block on a full pipe until its timeout. Once the export's output has
      // ended, no node can have stopped it, so the export's own exit decides
      // whether it failed, even if that exit is not seen yet: a node that reads
      // a truncated stream to its end can report its failure first.
      if (!save.stdout.readableEnded && save.exitCode === null && save.signalCode === null) {
        stoppedExport = true;
        save.kill("SIGTERM");
      }
      throw error;
    }),
  );
  await Promise.allSettled(imports);
  // An importer may stop before the archive's trailing padding; discard the
  // rest so the export can exit instead of blocking on a full pipe.
  save.stdout.resume();
  const [exported] = await Promise.allSettled([saved]);
  // An export failure truncates every import stream, so report it first unless
  // a node failure is what stopped the export.
  if (exported.status === "rejected" && !stoppedExport) {
    throw exported.reason;
  }
  if (firstImportError) {
    throw firstImportError;
  }
  if (exported.status === "rejected") {
    throw exported.reason;
  }
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
    await assertK3dImageReference(state.lane, cluster, existing.reference, envName);
    return existing;
  }

  const hostImageId = await ensureDockerSourceImage(state, image, envName);
  let importReference = image;
  if (!stateOwnsImageTag(state, image)) {
    importReference = localImportTag(cluster, envName);
    const tagResource = addResource(state, "image-tag", { name: importReference });
    await writeState(statePath, state);
    await boundedImageCommand(["tag", image, importReference]);
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
  const inspected = await boundedImageCommand([
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
  // k3d can exit successfully after containerd rejects missing index content.
  // Export only the platform pulled locally, then verify the imported reference.
  const containerEngine = process.env.OCC_DOCKER_BIN ?? "docker";
  await timedPreparation(state.lane, "image-stream-import", () =>
    // k3d tools-node mode can exit successfully after a per-node import
    // failure, so stream the export into each owned node's containerd directly
    // and propagate both export and node-local containerd errors.
    streamImageIntoK3dNodes(cluster, [
      "image",
      "save",
      ...(basename(containerEngine) === "podman" ? [] : ["--platform", platform]),
      importReference,
    ]),
  );

  const listed = await k3dNodeImageCheck(
    `k3d-${cluster.name}-server-0`,
    ["ctr", "-n", "k8s.io", "images", "list"],
    "containerd",
  );
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
  for (const node of cluster.nodes) {
    await k3dNodeImageCheck(
      node,
      ["ctr", "-n", "k8s.io", "images", "tag", importReference, runtimeReference],
      "containerd",
    );
  }
  await assertK3dImageReference(state.lane, cluster, runtimeReference, envName);
  resource.reference = runtimeReference;
  await markResourceReady(statePath, state, resource);
  return resource;
}

async function prepareK3dRuntimeImages(
  statePath,
  state,
  cluster,
  env,
  { buildController = false, buildRuntime = false } = {},
) {
  const needsController = buildController && !process.env.OCC_TEST_PRODUCTION_CONTROLLER_IMAGE;
  const needsRuntime =
    buildRuntime &&
    (!process.env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE ||
      !process.env.OCC_TEST_KUBERNETES_AGENT_IMAGE);
  if (needsController || needsRuntime) {
    const images = [
      needsController ? "controller" : undefined,
      needsRuntime
        ? process.env.OCC_K3D_OPENCLAW_SOURCE === undefined
          ? "gateway and Codex runtime"
          : "gateway and native OpenClaw runtime"
        : undefined,
    ]
      .filter(Boolean)
      .join(", ");
    progress(
      state.lane,
      `Building the current ${images} image${needsController && needsRuntime ? "s" : ""}.`,
    );
    const built = await buildRuntimeImages(statePath, state, {
      controller: needsController,
      runtime: needsRuntime,
      nodeBaseImage: effectiveLaneEnv(state.lane, env).NODE_BASE_IMAGE,
    });
    Object.assign(env, built.env);
    if (needsRuntime) {
      env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE = built.env.OCC_TEST_KUBERNETES_RUNTIME_IMAGE;
      env.OCC_TEST_KUBERNETES_AGENT_IMAGE = built.env.OCC_TEST_KUBERNETES_RUNTIME_IMAGE;
    }
  }
  const inputs = {
    OCC_TEST_KUBERNETES_GATEWAY_IMAGE:
      env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE ?? process.env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE,
    OCC_TEST_KUBERNETES_AGENT_IMAGE:
      env.OCC_TEST_KUBERNETES_AGENT_IMAGE ?? process.env.OCC_TEST_KUBERNETES_AGENT_IMAGE,
  };
  requireEnv(Object.keys(inputs), inputs);
  progress(
    state.lane,
    process.env.OCC_K3D_OPENCLAW_SOURCE === undefined
      ? "Importing the gateway and Codex runtime images into k3d."
      : "Importing the native OpenClaw runtime image into k3d.",
  );
  for (const [name, value] of Object.entries(inputs)) {
    const image = await registerImageInK3d(statePath, state, cluster, value, name);
    env[name] = image.reference;
  }
  if (buildController) {
    const controller = await registerImageInK3d(
      statePath,
      state,
      cluster,
      env.OCC_TEST_PRODUCTION_CONTROLLER_IMAGE ?? process.env.OCC_TEST_PRODUCTION_CONTROLLER_IMAGE,
      "OCC_TEST_PRODUCTION_CONTROLLER_IMAGE",
    );
    env.OCC_TEST_PRODUCTION_CONTROLLER_IMAGE = controller.reference;
  }
  // Replace the build tag with its imported digest before publishing the next step's inputs.
  env.OCC_TEST_KUBERNETES_RUNTIME_IMAGE = env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE;
  if (lanePrepare(state.lane).codexSeccomp && process.env.OCC_K3D_OPENCLAW_SOURCE === undefined) {
    progress(state.lane, "Deriving and installing the dedicated Codex seccomp profile.");
    const seccomp = await prepareCodexSeccompProfile({
      cluster,
      image: env.OCC_TEST_KUBERNETES_AGENT_IMAGE,
      execFile,
      kubectl: cluster.kubectl ?? process.env.OCC_KUBECTL_BIN ?? "kubectl",
      codexVersion: await kubernetesCodexVersion(env),
    });
    env.OCC_TEST_KUBERNETES_CODEX_SECCOMP_PROFILE = seccomp.profileName;
    cluster.codexSeccompProfile = seccomp.profileName;
    cluster.codexSeccompProfiles = seccomp.nodes;
    await writeState(statePath, state);
  }
}

// The CI lane passes a cluster it created alongside the runtime image build.
async function prepareRuntimeSmokeCodexSeccompProfile(statePath, state, env, created) {
  const cluster =
    created ??
    (await timedPreparation(state.lane, "k3d-create", () => ensureK3dCluster(statePath, state)));
  const runtimeImage = await timedPreparation(state.lane, "runtime-image-import", () =>
    registerImageInK3d(
      statePath,
      state,
      cluster,
      env.OCC_TEST_KUBERNETES_RUNTIME_IMAGE,
      "OCC_TEST_KUBERNETES_RUNTIME_IMAGE",
    ),
  );
  progress(
    state.lane,
    "Deriving the reviewed Codex seccomp profile for native runtime image smoke tests.",
  );
  const codexVersion = await kubernetesCodexVersion(env);
  const seccomp = await timedPreparation(state.lane, "codex-seccomp-profile", () =>
    prepareCodexSeccompProfile({
      cluster,
      image: runtimeImage.reference,
      execFile,
      kubectl: cluster.kubectl ?? process.env.OCC_KUBECTL_BIN ?? "kubectl",
      codexVersion,
    }),
  );
  if (!seccomp.dockerProfilePath || !isAbsolute(seccomp.dockerProfilePath)) {
    throw new Error("Codex seccomp preparation did not publish an absolute Docker profile path.");
  }
  env.OCC_TEST_CODEX_SECCOMP_PROFILE = seccomp.dockerProfilePath;
  env.OCC_TEST_KUBERNETES_CODEX_SECCOMP_PROFILE = seccomp.profileName;
  cluster.codexSeccompProfile = seccomp.profileName;
  cluster.codexSeccompProfiles = seccomp.nodes;
  cluster.codexDockerSeccompProfile = {
    path: seccomp.dockerProfilePath,
    sha256: seccomp.profileSha256,
  };
  await writeState(statePath, state);
}

export async function prepareRuntimeImageSmoke({ image, statePath }) {
  assertDockerImageId(image, "Runtime smoke image");
  const path = normalizeStatePath(statePath);
  if (await readState(path)) {
    throw new Error(`CI state already exists at ${path}; run cleanup before runtime smoke.`);
  }
  const state = baseState("images-packaging", path);
  const tag = `localhost/${ownedName("openclaw-ci-image", state.prefix, { maxLength: 48 })}/runtime-smoke:local`;
  const env = { ...baseEnv(path, state), OCC_TEST_KUBERNETES_RUNTIME_IMAGE: tag };
  const resource = addResource(state, "image-tag", { name: tag });
  await writeState(path, state);
  try {
    // Import the caller's exact loaded config ID without rebuilding or pulling.
    await execFile(process.env.OCC_DOCKER_BIN ?? "docker", ["tag", image, tag]);
    await markResourceReady(path, state, resource);
    await prepareRuntimeSmokeCodexSeccompProfile(path, state, env);
    await saveLaneEnv(path, state, env);
    return { env, cleanup: () => cleanupResourceIds(path) };
  } catch (error) {
    await cleanupResourceIds(path);
    throw error;
  }
}

async function prepareProductionImages(
  statePath,
  state,
  cluster,
  env,
  { localStore = false, sourceImages } = {},
) {
  if (sourceImages) {
    Object.assign(env, sourceImages);
  } else {
    const built = await buildRuntimeImages(statePath, state, {
      controller: true,
      runtime: true,
      nodeBaseImage: effectiveLaneEnv(state.lane, env).NODE_BASE_IMAGE,
      localStore,
    });
    Object.assign(env, built.env);
  }
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
    case "postgres-application":
    case "postgres-auth":
    case "postgres-platform":
      await ensurePostgresServer(resolvedStatePath, state);
      break;
    case "runtime-image-fixture":
      // The test builds and owns its own unique image on the job's engine.
      // Do not register it with generic force-removal cleanup.
      env.OCC_RUNTIME_IMAGE_RECEIPT = join(
        dirname(resolvedStatePath),
        "runtime-image-fixture-receipt.json",
      );
      break;
    case "images-model-probes":
      Object.assign(
        env,
        (
          await timedPreparation(name, "runtime-image-build", () =>
            buildRuntimeImages(resolvedStatePath, state, { runtime: true }),
          )
        ).env,
      );
      break;
    case "images-runtime-startup":
    case "images-runtime-startup-2": {
      // Runtime image smoke tests run apart from packaging, in two lanes, to
      // shorten CI wall time. Only the lane whose tests run the Codex sandbox
      // sets codexSeccomp; the other skips the k3d cluster it needs. The
      // cluster needs no image, so it is created while the image builds.
      const codexSeccomp = lanePrepare(name).codexSeccomp;
      const [built, cluster] = await timedPreparation(name, "runtime-image-build-cluster", () =>
        prepareTogether([
          () =>
            timedPreparation(name, "runtime-image-build", () =>
              buildRuntimeImages(resolvedStatePath, state, { runtime: true }),
            ),
          ...(codexSeccomp
            ? [
                () =>
                  timedPreparation(name, "k3d-create", () =>
                    ensureK3dCluster(resolvedStatePath, state),
                  ),
              ]
            : []),
        ]),
      );
      Object.assign(env, built.env);
      if (codexSeccomp) {
        await prepareRuntimeSmokeCodexSeccompProfile(resolvedStatePath, state, env, cluster);
      }
      break;
    }
    case "images-packaging":
      await commandAvailable(process.env.OCC_HELM_BIN ?? "helm", ["version", "--short"]);
      await commandAvailable(process.env.OCC_YQ_BIN ?? "yq", ["--version"]);
      Object.assign(
        env,
        (
          await timedPreparation(name, "controller-runtime-image-build", () =>
            buildRuntimeImages(resolvedStatePath, state, {
              controller: true,
              runtime: true,
              nodeBaseImage: effectiveLaneEnv(name, env).NODE_BASE_IMAGE,
            }),
          )
        ).env,
      );
      // BuildKit's base-image cache is not Docker's runnable image store.
      env.OCC_TEST_CODEX_PROBE_IMAGE = await ensureDockerSourceImage(
        state,
        effectiveLaneEnv(name, env).NODE_BASE_IMAGE,
        "NODE_BASE_IMAGE",
      );
      break;
    case "repository-credentials-container":
      Object.assign(
        env,
        await prepareRepositoryCredentials({
          repositoryRoot,
          imagePrefix: `localhost/${ownedName("openclaw-ci-image", state.prefix, { maxLength: 48 })}`,
          receiptPath: join(dirname(resolvedStatePath), "repository-credentials-images.json"),
          execFile,
          registerImage: async (tag) => {
            const resource = addResource(state, "image-tag", { name: tag });
            await writeState(resolvedStatePath, state);
            return resource;
          },
          markImageReady: async (resource, imageId) => {
            resource.imageId = imageId;
            await markResourceReady(resolvedStatePath, state, resource);
          },
        }),
      );
      break;
    case "k3d-fixture-configuration":
    case "k3d-fixture-state":
    case "k3d-fixture-plugins": {
      // PostgreSQL, the cluster and the fixture build are independent; the
      // fixture is imported only after the cluster passed its readiness gates.
      const [, cluster, built] = await timedPreparation(
        name,
        "postgres-cluster-fixture-build",
        () =>
          prepareTogether([
            () =>
              timedPreparation(name, "postgres-start", () =>
                ensurePostgresServer(resolvedStatePath, state),
              ),
            () =>
              timedPreparation(name, "k3d-create", () =>
                ensureK3dCluster(resolvedStatePath, state),
              ),
            () =>
              timedPreparation(name, "fixture-image-build", () =>
                buildFixtureImage(resolvedStatePath, state),
              ),
          ]),
      );
      const fixture = await timedPreparation(name, "fixture-image-import", () =>
        importFixtureImage(resolvedStatePath, state, cluster, built),
      );
      // Fixture suites use the same local-only image. Keep it active on
      // every node so kubelet image garbage collection cannot remove it.
      await timedPreparation(name, "fixture-image-pin", () =>
        pinFixtureImageInK3d(cluster, fixture.image),
      );
      // The suites restart this controller when enabling shared storage. Verify
      // replacement scheduling after image imports consume the runner's disk.
      await execFile(
        process.env.OCC_KUBECTL_BIN ?? "kubectl",
        [
          "--kubeconfig",
          cluster.kubeconfig,
          "--context",
          cluster.context,
          "--namespace",
          "kube-system",
          "rollout",
          "restart",
          "deployment/local-path-provisioner",
        ],
        { timeoutMs: 10_000 },
      );
      await timedPreparation(name, "fixture-storage-verify", () => verifyFixtureStorage(cluster));
      env.OCC_TEST_KUBERNETES_KUBECONFIG = cluster.kubeconfig;
      env.OCC_TEST_KUBERNETES_CONTEXT = cluster.context;
      env.OCC_TEST_KUBERNETES_IMAGE = fixture.image;
      env.OCC_TEST_KUBERNETES_PLUGIN_STATUS_PROXY_CIDRS = cluster.pluginStatusProxyCidrs;
      break;
    }
    case "k3d-observability": {
      await commandAvailable(process.env.OCC_HELM_BIN ?? "helm", ["version", "--short"]);
      const inputs = effectiveLaneEnv(name, env);
      const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
      const { loadYaml } = require("@kubernetes/client-node");
      const production = loadYaml(
        await readFile(join(repositoryRoot, "deploy/helm/openclaw-enterprise/values.yaml"), "utf8"),
      );
      const externalImages = {
        OCC_TEST_PRODUCTION_NODE_IMAGE: inputs.NODE_BASE_IMAGE,
        OCC_TEST_PRODUCTION_POSTGRES_IMAGE: inputs.OCC_TEST_PRODUCTION_POSTGRES_IMAGE,
        OCC_TEST_OBSERVABILITY_COLLECTOR_IMAGE: production.logging.collector.image,
      };
      const [cluster, built, , fixture] = await timedPreparation(name, "cluster-build-pull", () =>
        prepareTogether([
          () => ensureK3dCluster(resolvedStatePath, state),
          async () => {
            await ensureDockerSourceImage(state, inputs.NODE_BASE_IMAGE, "NODE_BASE_IMAGE");
            return buildRuntimeImages(resolvedStatePath, state, {
              controller: true,
              nodeBaseImage: inputs.NODE_BASE_IMAGE,
              localStore: true,
            });
          },
          () =>
            prepareTogether(
              Object.entries(externalImages)
                .filter(([, image]) => image !== inputs.NODE_BASE_IMAGE)
                .map(
                  ([variable, image]) =>
                    () =>
                      ensureDockerSourceImage(state, image, variable),
                ),
              2,
            ),
          () => buildFixtureImage(resolvedStatePath, state),
        ]),
      );
      env.OCC_TEST_KUBERNETES_KUBECONFIG = cluster.kubeconfig;
      env.OCC_TEST_KUBERNETES_CONTEXT = cluster.context;
      // Keep imports into this cluster serial: images that share layers may
      // contend for the same containerd content. The pulls and
      // builds above overlap. Each import still verifies the immutable
      // reference through CRI on every node.
      await timedPreparation(name, "workload-image-imports", () =>
        prepareTogether(
          [
            async () => {
              env.OCC_TEST_KUBERNETES_IMAGE = (
                await importFixtureImage(resolvedStatePath, state, cluster, fixture)
              ).image;
              await pinFixtureImageInK3d(cluster, env.OCC_TEST_KUBERNETES_IMAGE);
            },
            ...Object.entries({
              OCC_TEST_PRODUCTION_CONTROLLER_IMAGE: built.env.OCC_TEST_PRODUCTION_CONTROLLER_IMAGE,
              ...externalImages,
            }).map(([variable, image]) => async () => {
              progress(name, `Importing ${variable}.`);
              env[variable] = (
                await registerImageInK3d(resolvedStatePath, state, cluster, image, variable)
              ).reference;
            }),
          ],
          1,
        ),
      );
      break;
    }
    case "k3d-observability-demo": {
      await commandAvailable(process.env.OCC_HELM_BIN ?? "helm", ["version", "--short"]);
      const inputs = effectiveLaneEnv(name, env);
      const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
      const { loadYaml } = require("@kubernetes/client-node");
      const demo = loadYaml(
        await readFile(
          join(repositoryRoot, "deploy/helm/openclaw-observability-demo/values.yaml"),
          "utf8",
        ),
      );
      const images = {
        // Start the larger service first; pulls still overlap before imports run serially.
        OCC_TEST_OBSERVABILITY_GRAFANA_IMAGE: demo.images.grafana,
        OCC_TEST_OBSERVABILITY_PROMETHEUS_IMAGE: demo.images.prometheus,
        OCC_TEST_OBSERVABILITY_LOKI_IMAGE: demo.images.loki,
        OCC_TEST_PRODUCTION_NODE_IMAGE: inputs.NODE_BASE_IMAGE,
      };
      const [cluster] = await timedPreparation(name, "cluster-and-pulls", () =>
        prepareTogether([
          () => ensureK3dCluster(resolvedStatePath, state),
          () =>
            prepareTogether(
              Object.entries(images).map(
                ([variable, image]) =>
                  () =>
                    ensureDockerSourceImage(state, image, variable),
              ),
              2,
            ),
        ]),
      );
      env.OCC_TEST_KUBERNETES_KUBECONFIG = cluster.kubeconfig;
      env.OCC_TEST_KUBERNETES_CONTEXT = cluster.context;
      // Keep imports into this cluster serial (shared layers may contend for
      // the same containerd content) even though the pulls above overlap.
      await timedPreparation(name, "demo-image-imports", () =>
        prepareTogether(
          Object.entries(images).map(([variable, image]) => async () => {
            progress(name, `Importing ${variable}.`);
            env[variable] = (
              await registerImageInK3d(resolvedStatePath, state, cluster, image, variable)
            ).reference;
          }),
          1,
        ),
      );
      break;
    }
    case "repository-credentials-platform": {
      // PostgreSQL, the cluster and the image builds are independent. The
      // gateway check runs as soon as the cluster exists, and nothing is
      // imported into a cluster that failed it.
      const [, { cluster, hostAddress }, platformImage] = await timedPreparation(
        name,
        "postgres-cluster-image-build",
        () =>
          prepareTogether([
            () =>
              timedPreparation(name, "postgres-start", () =>
                ensurePostgresServer(resolvedStatePath, state),
              ),
            async () => {
              const cluster = await timedPreparation(name, "k3d-create", () =>
                ensureK3dCluster(resolvedStatePath, state),
              );
              return { cluster, hostAddress: await repositoryPlatformHostAddress(cluster) };
            },
            () => buildRepositoryPlatformImage(resolvedStatePath, state),
          ]),
      );
      env.OCC_TEST_KUBERNETES_KUBECONFIG = cluster.kubeconfig;
      env.OCC_TEST_KUBERNETES_CONTEXT = cluster.context;
      env.OCC_TEST_REPOSITORY_CREDENTIALS_HOST_ADDRESS = hostAddress;
      env.OCC_TEST_REPOSITORY_CREDENTIALS_PLATFORM_IMAGE = (
        await timedPreparation(name, "platform-image-import", () =>
          registerImageInK3d(
            resolvedStatePath,
            state,
            cluster,
            platformImage,
            "OCC_TEST_REPOSITORY_CREDENTIALS_PLATFORM_IMAGE",
          ),
        )
      ).reference;
      break;
    }
    case "repository-credentials-installed": {
      await commandAvailable(process.env.OCC_HELM_BIN ?? "helm", ["version", "--short"]);
      const cluster = await ensureK3dCluster(resolvedStatePath, state);
      const routing = await prepareGatewayRouting({ cluster, execFile });
      Object.assign(env, routing.env);
      env.OCC_TEST_KUBERNETES_KUBECONFIG = cluster.kubeconfig;
      env.OCC_TEST_KUBERNETES_CONTEXT = cluster.context;
      const inputs = effectiveLaneEnv(name, env);
      const sourceImages =
        inputs.OCC_TEST_REPOSITORY_CREDENTIALS_IMAGE_MODE === "release"
          ? {
              OCC_TEST_PRODUCTION_CONTROLLER_IMAGE: inputs.OCC_TEST_PRODUCTION_CONTROLLER_IMAGE,
              OCC_TEST_KUBERNETES_RUNTIME_IMAGE: inputs.OCC_TEST_KUBERNETES_RUNTIME_IMAGE,
            }
          : undefined;
      await prepareProductionImages(resolvedStatePath, state, cluster, env, {
        localStore: true,
        sourceImages,
      });
      env.OCC_TEST_REPOSITORY_CREDENTIALS_IMAGE = (
        await registerImageInK3d(
          resolvedStatePath,
          state,
          cluster,
          process.env.OCC_TEST_REPOSITORY_CREDENTIALS_IMAGE,
          "OCC_TEST_REPOSITORY_CREDENTIALS_IMAGE",
        )
      ).reference;
      progress(name, "Deriving and installing the dedicated Codex seccomp profile.");
      const seccomp = await prepareCodexSeccompProfile({
        cluster,
        image: env.OCC_TEST_KUBERNETES_RUNTIME_IMAGE,
        execFile,
        kubectl: cluster.kubectl ?? process.env.OCC_KUBECTL_BIN ?? "kubectl",
        codexVersion: await kubernetesCodexVersion(env),
      });
      env.OCC_TEST_KUBERNETES_CODEX_SECCOMP_PROFILE = seccomp.profileName;
      cluster.codexSeccompProfile = seccomp.profileName;
      cluster.codexSeccompProfiles = seccomp.nodes;
      await writeState(resolvedStatePath, state);
      if (process.env.OCC_TEST_REPOSITORY_CREDENTIALS_GH_BINARY) {
        env.OCC_TEST_REPOSITORY_CREDENTIALS_GH_BINARY =
          process.env.OCC_TEST_REPOSITORY_CREDENTIALS_GH_BINARY;
      }
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
    case "slack":
    case "k3d-otel":
    case "gateway-routing": {
      await commandAvailable(process.env.OCC_HELM_BIN ?? "helm", ["version", "--short"]);
      await ensurePostgresServer(resolvedStatePath, state);
      const cluster = await prepareK3dModelLane(resolvedStatePath, state, env, {
        buildController: true,
        buildRuntime: name !== "slack",
      });
      const routing = await prepareGatewayRouting({ cluster, execFile });
      Object.assign(env, routing.env);
      if (name === "k3d-otel") {
        await prepareLaneLogging(resolvedStatePath, state, env, cluster);
      }
      break;
    }
    case "production-tui": {
      await commandAvailable(process.env.OCC_HELM_BIN ?? "helm", ["version", "--short"]);
      await ensurePostgresServer(resolvedStatePath, state);
      const cluster = await ensureK3dCluster(resolvedStatePath, state);
      env.OCC_TEST_KUBERNETES_KUBECONFIG = cluster.kubeconfig;
      env.OCC_TEST_KUBERNETES_CONTEXT = cluster.context;
      const inputs = effectiveLaneEnv(name, env);
      const upgradeSelected = Object.keys(productionUpgradeImages).some(
        (variable) => inputs[variable],
      );
      const sourceImages = upgradeSelected
        ? {
            OCC_TEST_PRODUCTION_CONTROLLER_IMAGE: inputs.OCC_TEST_PRODUCTION_CONTROLLER_IMAGE,
            OCC_TEST_KUBERNETES_RUNTIME_IMAGE: inputs.OCC_TEST_KUBERNETES_RUNTIME_IMAGE,
          }
        : undefined;
      await prepareProductionImages(resolvedStatePath, state, cluster, env, { sourceImages });
      if (upgradeSelected) {
        for (const [variable, baseline] of Object.entries(productionUpgradeImages)) {
          const imported = await registerImageInK3d(
            resolvedStatePath,
            state,
            cluster,
            inputs[variable],
            variable,
          );
          const baselineImage = state.resources.find(
            (resource) => resource.kind === "k3d-image" && resource.reference === env[baseline],
          );
          if (!baselineImage || imported.hostImageId === baselineImage.hostImageId) {
            throw new Error(`${variable} must contain a different image from ${baseline}.`);
          }
          env[variable] = imported.reference;
        }
      }
      await prepareLaneLogging(resolvedStatePath, state, env, cluster);
      break;
    }
    case "provider-account":
      await ensurePostgresServer(resolvedStatePath, state);
      await prepareK3dModelLane(resolvedStatePath, state, env, { buildRuntime: true });
      break;
    case "openshell": {
      await commandAvailable(process.env.OCC_HELM_BIN ?? "helm", ["version", "--short"]);
      await ensurePostgresServer(resolvedStatePath, state);
      const cluster = await prepareK3dModelLane(resolvedStatePath, state, env, {
        buildController: true,
        buildRuntime: true,
      });
      const routing = await prepareGatewayRouting({ cluster, execFile });
      Object.assign(env, routing.env);
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
    case "logging-collector": {
      // The tests start these containers themselves under 60–120 s command
      // timeout, so pull the pinned images here, where a slow or failed pull
      // is retried. An unpinned local override is still pulled by the test.
      const images = {
        OCC_TEST_LOGGING_COLLECTOR_IMAGE: await readDefaultCollectorImage(),
        OCC_TEST_LOGGING_NODE_IMAGE: effectiveLaneEnv(name, env).OCC_TEST_LOGGING_NODE_IMAGE,
        ...metricsMonitoringImages,
      };
      await timedPreparation(name, "image-pulls", () =>
        prepareTogether(
          Object.entries(images)
            .filter(([, image]) => immutableDigest(image))
            .map(
              ([variable, image]) =>
                () =>
                  ensureDockerSourceImage(state, image, variable),
            ),
          2,
        ),
      );
      break;
    }
    case "helper-timeout":
      break;
  }

  if (lanePrepare(name).keycloak) {
    const keycloak = await timedPreparation(name, "keycloak-start", () =>
      prepareKeycloak({
        stateDirectory: dirname(resolvedStatePath),
        name: ownedName("openclaw-ci-kc", state.prefix, { maxLength: 63 }),
        execFile,
        docker: process.env.OCC_DOCKER_BIN ?? "docker",
        ensureImage: (image) => ensureDockerSourceImage(state, image, "Keycloak image"),
        reservePort: reserveLoopbackPort,
        registerResource: async (details) => {
          const resource = addResource(state, keycloakResourceKind, details);
          await writeState(resolvedStatePath, state);
          return resource;
        },
        saveState: () => writeState(resolvedStatePath, state),
      }),
    );
    Object.assign(env, keycloak.env);
    await markResourceReady(resolvedStatePath, state, keycloak.resource);
  }

  applyLaneEnv(name, env);
  await saveLaneEnv(resolvedStatePath, state, env);
  return { env, cleanup: async () => cleanupResourceIds(resolvedStatePath) };
}

async function prepareK3dModelLane(statePath, state, env, options) {
  const cluster = await ensureK3dCluster(statePath, state);
  env.OCC_TEST_KUBERNETES_KUBECONFIG = cluster.kubeconfig;
  env.OCC_TEST_KUBERNETES_CONTEXT = cluster.context;
  if (cluster.pluginStatusProxyCidrs !== undefined) {
    env.OCC_TEST_KUBERNETES_PLUGIN_STATUS_PROXY_CIDRS = cluster.pluginStatusProxyCidrs;
  }
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

// `template` (optional) is an OCC_TEST_DATABASE_URL that an earlier prepareFile call
// returned for this state. The file's database is then a copy of that database
// (CREATE DATABASE ... TEMPLATE) instead of a freshly migrated one. A suite that
// prepares a database per test uses it to migrate once per file.
async function prepareFile({ lane, file, statePath, template }) {
  const name = assertLane(lane);
  if (!file) {
    throw new Error("prepareFile requires a file.");
  }
  await validateLaneInputsBeforeSideEffects(name);
  const relativeFile = toRepositoryRelative(filePath(file));
  const resolvedStatePath = normalizeStatePath(statePath);
  // A test may prepare databases from its own process while the runner prepares and
  // cleans other files. The lock keeps either side from writing back a stale state.
  return withStateLock(resolvedStatePath, () =>
    prepareFileWithState({ name, relativeFile, resolvedStatePath, template }),
  );
}

async function prepareFileWithState({ name, relativeFile, resolvedStatePath, template }) {
  const state = await readState(resolvedStatePath);
  const prepare = lanePrepare(name);
  if (!state && prepare.requiresPreparedStateForFile) {
    throw new Error(
      `prepareFile for ${name} requires a prior prepareLane call using the same state path.`,
    );
  }
  if (template !== undefined && (!prepare.postgres || !state)) {
    throw new Error("A template database requires a prepared PostgreSQL lane state.");
  }
  const effectiveState = state ?? baseState(name, resolvedStatePath);
  const env = baseEnv(resolvedStatePath, effectiveState);
  const resourceIds = [];

  if (name === "production-tui" && state) {
    const inputs = effectiveLaneEnv(name);
    const variables = Object.keys(productionUpgradeImages);
    const selected = variables.some((variable) => inputs[variable]);
    const prepared = variables.some((variable) => state.env?.[variable]);
    if (state.lane !== name || selected !== prepared) {
      throw new Error("Production upgrade inputs must match the prepared lane state.");
    }
    if (selected) {
      for (const variable of [...Object.values(productionUpgradeImages), ...variables]) {
        if (
          !state.resources.some(
            (resource) =>
              resource.kind === "k3d-image" &&
              resource.sourceImage === inputs[variable] &&
              resource.reference === state.env[variable] &&
              resource.status === "ready",
          )
        ) {
          throw new Error(`${variable} must match the prepared lane state.`);
        }
      }
    }
  }

  if (name === "repository-credentials-container") {
    if (state?.lane !== name) {
      throw new Error("Repository credential images require their own lane state.");
    }
    applyLaneEnv(name, env);
    const prepared = await prepareRepositoryCredentialsFile({
      clientImage: env.REPOSITORY_CREDENTIALS_CLIENT_IMAGE,
      execFile,
    });
    return { env: { ...env, ...prepared.env }, cleanup: prepared.cleanup };
  }

  if (prepare.postgres) {
    const dbKind = prepare.k3d ? "k8s" : "ci";
    const database = await createAndMigrateDatabase(resolvedStatePath, effectiveState, {
      kind: dbKind,
      label: fileStem(relativeFile),
      requireExistingServer: true,
      template,
    });
    resourceIds.push(database.resourceId);
    env.OCC_TEST_DATABASE_URL = database.appUrl;
    if (name === "postgres-application" && relativeFile === nativeIAMBarrierFile) {
      env.OCC_TEST_NATIVE_IAM_BARRIER_CI = "1";
      env.OCC_TEST_NATIVE_IAM_BARRIER_DATABASE = database.name;
      env.OCC_TEST_NATIVE_IAM_BARRIER_MIGRATION_DATABASE_URL = database.migrationUrl;
    }
    if (relativeFile.endsWith("occ-metrics.test.mjs")) {
      env.OCC_METRICS_TEST_MIGRATION_DATABASE_URL = database.migrationUrl;
    }
    if (relativeFile.endsWith("auth-maintain.test.mjs")) {
      env.OCC_AUTH_MAINTAIN_MIGRATION_DATABASE_URL = database.migrationUrl;
    }
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

  if (name === "dev-up-k3d") {
    await prepareDevUpImage(env.OCC_TEST_DEV_UP_CONTAINER_ENGINE);
  }

  if (state) {
    await writeState(resolvedStatePath, effectiveState);
  }
  return {
    env,
    cleanup: async () => {
      try {
        if (fixtureLanes.has(name)) {
          const cluster = effectiveState.resources.find(
            (resource) => resource.kind === "k3d-cluster",
          );
          // Suites restart the storage controller after selecting shared storage.
          // Run this in the runner parent so sanitized child reports cannot hide
          // infrastructure diagnostics after that configuration change.
          try {
            await verifyFixtureStorage(cluster, 5);
          } catch (error) {
            console.error(error.message);
            throw error;
          }
        }
      } finally {
        await cleanupResourceIds(resolvedStatePath, resourceIds);
      }
    },
  };
}

// Builds the Images and Packaging controller and runtime images only to write
// main's hosted BuildKit cache (ci-image-cache.yml). It uses that lane's state,
// inputs and build arguments, so the cache keys are the ones the CI image lanes
// restore. GitHub scopes cache writes to the run's ref; only main may warm.
async function warmImageCache({ statePath }) {
  if (
    process.env.GITHUB_REF !== "refs/heads/main" ||
    !["push", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME)
  ) {
    throw new Error("Only a push or dispatch on main may warm the image cache.");
  }
  const lane = "images-packaging";
  await validateLaneInputsBeforeSideEffects(lane);
  const resolvedStatePath = normalizeStatePath(statePath);
  if (await readState(resolvedStatePath)) {
    throw new Error(`CI state already exists at ${resolvedStatePath}; run cleanup first.`);
  }
  const state = baseState(lane, resolvedStatePath);
  await writeState(resolvedStatePath, state);
  const nodeBaseImage = effectiveLaneEnv(lane).NODE_BASE_IMAGE;
  // The two builds are independent; in parallel their exports land sooner.
  await timedPreparation("image-cache-warm", "controller-runtime-image-build", () =>
    prepareTogether([
      () =>
        buildRuntimeImages(resolvedStatePath, state, {
          controller: true,
          nodeBaseImage,
          cacheWarm: true,
        }),
      () => buildRuntimeImages(resolvedStatePath, state, { runtime: true, cacheWarm: true }),
    ]),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args["warm-image-cache"]) {
    if (args.lane || args.file || args["github-env"]) {
      throw new Error("--warm-image-cache takes only --state.");
    }
    await warmImageCache({ statePath: args.state });
    return;
  }
  if (!args.lane) {
    throw new Error("--lane is required.");
  }
  if (
    args.file &&
    toRepositoryRelative(args.file) === nativeIAMBarrierFile &&
    (args["github-env"] || process.env.GITHUB_ENV)
  ) {
    throw new Error(
      "The selected private PostgreSQL fixture must be prepared within the test runner.",
    );
  }
  const result = args.file
    ? await prepareFile({ lane: args.lane, file: args.file, statePath: args.state })
    : await prepareLane({ lane: args.lane, statePath: args.state });
  await appendGithubEnv(args["github-env"] ?? process.env.GITHUB_ENV, result.env);
  process.stdout.write(
    `${JSON.stringify({ envNames: Object.keys(result.env).sort() }, null, 2)}\n`,
  );
}

export { defaultK3sImage, prepareFile, prepareLane };

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
