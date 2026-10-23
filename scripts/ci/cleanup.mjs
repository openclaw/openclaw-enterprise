#!/usr/bin/env node
import { cleanupLogging, ciOtelBackendResourceKind } from "./logging.mjs";
import { cleanupKeycloak, keycloakResourceKind } from "./keycloak.mjs";
import { laneImagesResourceKind, restoreLaneImages } from "./lane-images.mjs";
import { fork, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withStateLock } from "./state-lock.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const composePostgresFile = join(repositoryRoot, "compose.postgres.yaml");
const activeCommands = new Set();

// A caller that is about to hard-kill its descendant processes must stop these
// groups first: killing a supervisor alone prevents its IPC-disconnect cleanup.
function stopCleanupCommands() {
  for (const stop of activeCommands) {
    stop();
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    args[arg.slice(2)] = value;
    index += 1;
  }
  return args;
}

// Every container engine and k3d command has a limit, so one that never returns cannot hold
// the job's Cleanup lane step, or a test's database drop, until the job timeout. Past it the
// command gets SIGTERM, then SIGKILL after a grace period. Tests shorten both.
function positiveEnvMs(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function commandTimeoutMs() {
  return positiveEnvMs("OPENCLAW_CI_CLEANUP_COMMAND_TIMEOUT_MS", 5 * 60_000);
}

// DROP DATABASE ... WITH (FORCE) ends the database's sessions and returns in seconds.
function databaseDropTimeoutMs() {
  return Math.min(60_000, commandTimeoutMs());
}

function execFile(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const processGroup = process.platform !== "win32";
    const spawnOptions = {
      cwd: options.cwd ?? repositoryRoot,
      env: { ...process.env, ...(options.env ?? {}) },
    };
    // The supervisor remains the group leader until command and pipes settle.
    // It also owns termination when this caller exits without running JS hooks.
    const child = processGroup
      ? fork(new URL("./cleanup-command.mjs", import.meta.url), [], {
          ...spawnOptions,
          detached: true,
          execArgv: [],
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        })
      : spawn(command, args, { ...spawnOptions, stdio: ["ignore", "pipe", "pipe"] });
    let commandResult;
    if (processGroup) {
      child.on("message", (result) => {
        commandResult = result;
      });
    }
    let signalError;
    let killSent = false;
    const signalCommand = (signal) => {
      if (signal === "SIGKILL") {
        killSent = true;
      }
      try {
        if (processGroup) {
          // A live supervisor anchors the numeric group ID. Once it exits,
          // never signal an ID that another process could have reused.
          if (child.pid > 1 && child.exitCode === null && child.signalCode === null) {
            process.kill(-child.pid, signal);
          }
        } else {
          child.kill(signal);
        }
      } catch (error) {
        if (error.code !== "ESRCH") {
          signalError ??= error;
        }
      }
    };
    const stop = () => signalCommand("SIGKILL");
    activeCommands.add(stop);
    const timeoutMs = options.timeoutMs ?? commandTimeoutMs();
    const graceMs = positiveEnvMs("OPENCLAW_CI_COMMAND_KILL_GRACE_MS", 5_000);
    let timedOut = false;
    let settled = false;
    let killTimer;
    let abandonTimer;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      signalCommand("SIGTERM");
      killTimer = setTimeout(() => {
        signalCommand("SIGKILL");
        // A descendant can escape the group while retaining these pipes. Bound
        // their lifetime without signalling processes outside our owned group.
        abandonTimer = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
          finish(child.exitCode, child.signalCode);
        }, graceMs);
      }, graceMs);
    }, timeoutMs);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    function finish(code, signal, spawnError) {
      if (settled) {
        return;
      }
      settled = true;
      activeCommands.delete(stop);
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      clearTimeout(abandonTimer);
      // Close can precede the grace timer if surviving descendants closed their
      // output. They still belong to the timed-out command and must be stopped.
      if (timedOut && !killSent) {
        signalCommand("SIGKILL");
      }
      let error = spawnError;
      if (processGroup && !error) {
        if (commandResult) {
          ({ code, signal } = commandResult);
          if (commandResult.error) {
            error = Object.assign(new Error(commandResult.error.message), commandResult.error);
          }
        } else {
          error = new Error(
            `Cleanup command supervisor exited before reporting a result (${signal ?? code})`,
          );
        }
      }
      if (timedOut) {
        error = new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs} ms`);
      } else if (!error && code !== 0) {
        const message = stderr.trim() || stdout.trim() || signal || String(code);
        error = new Error(`${command} ${args.join(" ")} failed: ${message}`);
      }
      if (error) {
        Object.assign(error, { stdout, stderr });
        if (signalError) {
          error.cause = signalError;
        }
        reject(error);
      } else {
        resolvePromise({ stdout, stderr });
      }
    }
    child.on("error", (error) => {
      if (child.pid === undefined) {
        finish(null, null, error);
      } else {
        // A failed kill is not a failed spawn: keep the pipe-abandonment bound.
        signalError ??= error;
      }
    });
    // Exit precedes pipe drain. Keep the deadline and escalation alive until
    // close, even when the wrapper has exited but its descendants have not.
    child.on("close", (code, signal) => finish(code, signal));
    if (processGroup) {
      child.send({ command, args });
    }
  });
}

async function readState(path) {
  const state = JSON.parse(await readFile(path, "utf8"));
  if (state.version !== 1) {
    throw new Error(`Unsupported cleanup state version: ${state.version}`);
  }
  if (state.repositoryRoot !== repositoryRoot) {
    throw new Error(`Cleanup state belongs to another repository root: ${state.repositoryRoot}`);
  }
  if (!state.prefix?.startsWith("openclaw-ci-")) {
    throw new Error("Cleanup state prefix is not an OpenClaw Enterprise CI prefix.");
  }
  if (!Array.isArray(state.resources)) {
    throw new Error("Cleanup state resources must be an array.");
  }
  return state;
}

async function writeState(path, state) {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
  await chmod(path, 0o600);
}

function assertString(value, description) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${description} is missing.`);
  }
}

function assertOwnedName(prefix, value, description) {
  assertString(value, description);
  if (!value.startsWith(prefix)) {
    throw new Error(`Refusing to clean unowned ${description}: ${value}`);
  }
}

function assertResourceOwner(resource, state) {
  if (resource.owner !== state.prefix) {
    throw new Error(`Refusing to clean resource owned by another prefix: ${resource.owner}`);
  }
}

function assertOwnedImage(resource, state) {
  assertResourceOwner(resource, state);
  assertString(resource.name, "image name");
  if (!/^localhost\/(?:openclaw-ci-image-|openclaw-k8s-)/.test(resource.name)) {
    throw new Error(`Refusing to remove unowned image: ${resource.name}`);
  }
}

function assertOwnedK3dImage(resource, state) {
  assertResourceOwner(resource, state);
  assertOwnedName("openclaw-k8s-", resource.cluster, "k3d cluster");
  assertString(resource.name, "k3d image name");
}

function assertOwnedDatabase(value) {
  if (!/^(?:openclaw_ci|openclaw_failures|openclaw_k8s)_[a-z0-9_]+$/.test(value ?? "")) {
    throw new Error(`Refusing to drop unowned database: ${value}`);
  }
}

function assertOwnedK3dFilesystem(resource) {
  assertString(resource.directory, "k3d directory");
  if (!basename(resource.directory).startsWith(`${resource.name}-`)) {
    throw new Error(
      `Refusing to clean k3d directory outside cluster ownership: ${resource.directory}`,
    );
  }
  const expectedKubeconfig = join(resource.directory, "kubeconfig");
  if (resource.kubeconfig !== expectedKubeconfig) {
    throw new Error(
      `Refusing to clean k3d kubeconfig outside exact owned path: ${resource.kubeconfig}`,
    );
  }
}

function composeArgs(resource, state, ...args) {
  assertResourceOwner(resource, state);
  if (resource.composeFile !== composePostgresFile) {
    throw new Error(`Refusing cleanup with unexpected Compose file: ${resource.composeFile}`);
  }
  assertOwnedName("openclaw_ci_pg_", resource.name, "Compose PostgreSQL project");
  if (Number(resource.port) === 55432) {
    throw new Error("Refusing to clean developer PostgreSQL port 55432.");
  }
  return ["compose", "-f", resource.composeFile, "-p", resource.name, ...args];
}

function quoteIdentifier(value) {
  if (!/^[a-z0-9_]+$/.test(value)) {
    throw new Error(`Unsafe PostgreSQL identifier: ${value}`);
  }
  return `"${value.replaceAll('"', '""')}"`;
}

async function cleanupComposePostgres(resource, state) {
  await execFile(
    process.env.OCC_DOCKER_BIN ?? "docker",
    composeArgs(resource, state, "down", "--volumes", "--remove-orphans"),
    {
      env: { OCC_POSTGRES_PORT: String(resource.port) },
    },
  );
}

async function cleanupDatabase(resource, state) {
  assertResourceOwner(resource, state);
  assertOwnedDatabase(resource.name);
  const compose = state.resources.find(
    (candidate) =>
      candidate.kind === "compose-postgres" && candidate.name === resource.composeProject,
  );
  if (!compose) {
    return;
  }
  await execFile(
    process.env.OCC_DOCKER_BIN ?? "docker",
    [
      ...composeArgs(compose, state, "exec", "-T", "postgres"),
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-c",
      `DROP DATABASE IF EXISTS ${quoteIdentifier(resource.name)} WITH (FORCE)`,
    ],
    { env: { OCC_POSTGRES_PORT: String(compose.port) }, timeoutMs: databaseDropTimeoutMs() },
  );
}

async function cleanupK3dCluster(resource, state) {
  assertResourceOwner(resource, state);
  assertOwnedK3dFilesystem(resource);
  await deleteOwnedK3dCluster(resource);
  await rm(resource.directory, { recursive: true, force: true });
}

// Delete an owned cluster and its exact cluster-labelled Docker resources, and
// verify none remain. Preparation also calls this to discard a cluster whose
// create timed out before it retries; it keeps the cluster's directory.
async function deleteOwnedK3dCluster(resource, { execFile: run = execFile } = {}) {
  assertOwnedName("openclaw-k8s-", resource.name, "k3d cluster");
  const k3d = process.env.OPENCLAW_CI_K3D_BIN ?? "k3d";
  const listClusters = async () => {
    const result = await run(k3d, ["cluster", "list", "-o", "json"]);
    const clusters = JSON.parse(result.stdout);
    if (
      !Array.isArray(clusters) ||
      clusters.some((cluster) => typeof cluster?.name !== "string" || cluster.name.length === 0)
    ) {
      throw new Error("Cannot verify k3d cleanup from an invalid cluster inventory.");
    }
    return clusters;
  };
  if ((await listClusters()).some((cluster) => cluster.name === resource.name)) {
    await run(k3d, ["cluster", "delete", resource.name]);
  }
  if ((await listClusters()).some((cluster) => cluster.name === resource.name)) {
    throw new Error(`Owned k3d cluster remains after deletion: ${resource.name}`);
  }
  // k3d can leave Docker resources before a cluster appears in its inventory.
  // Only exact cluster-labelled resources are safe to remove automatically.
  const docker = process.env.OCC_DOCKER_BIN ?? "docker";
  for (const [kind, command, remove, format] of [
    ["containers", ["ps", "-a"], ["rm", "-f", "-v"], "{{.Names}}"],
    ["networks", ["network", "ls"], ["network", "rm"], "{{.Name}}"],
    ["volumes", ["volume", "ls"], ["volume", "rm"], "{{.Name}}"],
  ]) {
    const list = async (filter) =>
      (await run(docker, [...command, "--filter", filter, "--format", format])).stdout
        .split(/\r?\n/)
        .filter(Boolean);
    const labelled = await list(`label=k3d.cluster=${resource.name}`);
    if (
      labelled.length > 1000 ||
      labelled.some((value) => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value))
    ) {
      throw new Error(`Invalid k3d ${kind} inventory: ${resource.name}`);
    }
    if (labelled.length) {
      await run(docker, [...remove, ...labelled]);
    }
    if (
      (await list(`label=k3d.cluster=${resource.name}`)).length ||
      (await list(`name=k3d-${resource.name}`)).length
    ) {
      throw new Error(`Possible owned k3d ${kind} remain after deletion: ${resource.name}`);
    }
  }
}

async function cleanupImageTag(resource, state) {
  assertOwnedImage(resource, state);
  await execFile(process.env.OCC_DOCKER_BIN ?? "docker", [
    "image",
    "rm",
    "-f",
    resource.name,
  ]).catch((error) => {
    if (/No such image|image is referenced in multiple repositories/i.test(error.message)) {
      return;
    }
    throw error;
  });
}

async function cleanupK3dImage(resource, state) {
  assertOwnedK3dImage(resource, state);
  const references = [...new Set([resource.reference, resource.name].filter(Boolean))];
  for (const reference of references) {
    await execFile(process.env.OCC_DOCKER_BIN ?? "docker", [
      "exec",
      `k3d-${resource.cluster}-server-0`,
      "ctr",
      "-n",
      "k8s.io",
      "images",
      "rm",
      reference,
    ]).catch((error) => {
      if (/not found|No such container/i.test(error.message)) {
        return;
      }
      throw error;
    });
  }
}

async function cleanupResource(resource, state) {
  switch (resource.kind) {
    case ciOtelBackendResourceKind:
      assertResourceOwner(resource, state);
      await cleanupLogging(resource, { execFile });
      break;
    case "postgres-database":
      await cleanupDatabase(resource, state);
      break;
    case "compose-postgres":
      await cleanupComposePostgres(resource, state);
      break;
    case "k3d-image":
      await cleanupK3dImage(resource, state);
      break;
    case "k3d-cluster":
      await cleanupK3dCluster(resource, state);
      break;
    case "image-tag":
      await cleanupImageTag(resource, state);
      break;
    case keycloakResourceKind:
      assertResourceOwner(resource, state);
      await cleanupKeycloak(resource, { execFile, docker: process.env.OCC_DOCKER_BIN ?? "docker" });
      break;
    case laneImagesResourceKind:
      assertResourceOwner(resource, state);
      await restoreLaneImages(resource, {
        execFile,
        docker: process.env.OCC_DOCKER_BIN ?? "docker",
      });
      break;
    default:
      throw new Error(`Unknown cleanup resource kind: ${resource.kind}`);
  }
}

// lockTimeoutMs limits the wait for the CI state lock (state-lock.mjs's default otherwise), so a
// caller that has its own limit, such as a test fixture's database drop, stops waiting with it.
// The selected databases are dropped before that wait, each within databaseDropTimeoutMs.
async function cleanupResourceIds(statePath, resourceIds, { lockTimeoutMs } = {}) {
  const path = resolve(statePath);
  if (!isAbsolute(path)) {
    throw new Error("Cleanup state path must resolve to an absolute path.");
  }
  if (!(await stateExists(path))) {
    return;
  }
  const dropped = resourceIds === undefined ? undefined : await dropDatabases(path, resourceIds);
  // A test may prepare and clean databases from its own process beside the runner.
  await withStateLock(path, () => cleanupLockedResourceIds(path, resourceIds, dropped), {
    timeoutMs: lockTimeoutMs,
  });
}

// DROP DATABASE requests an immediate checkpoint, which writes out every dirty buffer on
// the server: about 0.25 s on an idle server, and 3-5 s while a lane's other files write.
// Each test's copy is dropped this way, and under the CI state lock every other copy and
// drop waited for it (finding 2180). The lock guards the state file, not the server, so
// the selected databases are dropped first, from a state snapshot (writes replace the
// file whole), and only their entries are removed under the lock. An entry stays until
// its drop succeeds, so a crash in between leaves it for lane cleanup, as before. A lane
// template stays on the locked path: prepareFile finds it through the state and copies it.
async function dropDatabases(path, resourceIds) {
  const results = new Map();
  let state;
  try {
    state = await readState(path);
  } catch (error) {
    // Another cleanup removed the emptied state; the locked pass returns as before.
    if (error.code === "ENOENT") {
      return results;
    }
    throw error;
  }
  for (const resource of [...state.resources].reverse()) {
    if (
      resource.kind === "postgres-database" &&
      resource.laneTemplate === undefined &&
      resourceIds.includes(resource.id)
    ) {
      results.set(
        resource.id,
        await cleanupDatabase(resource, state).then(
          () => ({}),
          (error) => ({ error }),
        ),
      );
    }
  }
  return results;
}

async function stateExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

// `dropped` maps the ids of databases dropped before the lock to {}, or to { error }.
async function cleanupLockedResourceIds(path, resourceIds, dropped = new Map()) {
  if (!(await stateExists(path))) {
    return;
  }
  const state = await readState(path);
  const selected = new Set(resourceIds ?? state.resources.map((resource) => resource.id));
  const failures = [];

  for (const resource of [...state.resources].reverse()) {
    if (!selected.has(resource.id)) {
      continue;
    }
    try {
      if (!dropped.has(resource.id)) {
        await cleanupResource(resource, state);
      } else if ("error" in dropped.get(resource.id)) {
        throw dropped.get(resource.id).error;
      }
      state.resources = state.resources.filter((candidate) => candidate.id !== resource.id);
      await writeState(path, state);
    } catch (error) {
      failures.push(`${resource.kind}:${resource.name ?? resource.id}:${error.message}`);
    }
  }

  if (failures.length > 0) {
    await writeState(path, state);
    throw new Error(`Cleanup failed for ${failures.join(", ")}`);
  }
  if (state.resources.length === 0) {
    await rm(path, { force: true });
  }
}

async function cleanupState(statePath) {
  await cleanupResourceIds(statePath);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.state) {
    throw new Error("--state is required.");
  }
  await cleanupState(args.state);
}

export { cleanupResourceIds, cleanupState, deleteOwnedK3dCluster, stopCleanupCommands };

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
