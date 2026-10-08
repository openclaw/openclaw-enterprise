#!/usr/bin/env node
import { cleanupLogging, ciOtelBackendResourceKind } from "./logging.mjs";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withStateLock } from "./state-lock.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const composePostgresFile = join(repositoryRoot, "compose.postgres.yaml");

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

function execFile(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        const message = stderr.trim() || stdout.trim() || signal || String(code);
        reject(new Error(`${command} ${args.join(" ")} failed: ${message}`));
      }
    });
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
    { env: { OCC_POSTGRES_PORT: String(compose.port) } },
  );
}

async function cleanupK3dCluster(resource, state) {
  assertResourceOwner(resource, state);
  assertOwnedName("openclaw-k8s-", resource.name, "k3d cluster");
  assertOwnedK3dFilesystem(resource);
  const k3d = process.env.OPENCLAW_CI_K3D_BIN ?? "k3d";
  const listClusters = async () => {
    const result = await execFile(k3d, ["cluster", "list", "-o", "json"]);
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
    await execFile(k3d, ["cluster", "delete", resource.name]);
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
      (await execFile(docker, [...command, "--filter", filter, "--format", format])).stdout
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
      await execFile(docker, [...remove, ...labelled]);
    }
    if (
      (await list(`label=k3d.cluster=${resource.name}`)).length ||
      (await list(`name=k3d-${resource.name}`)).length
    ) {
      throw new Error(`Possible owned k3d ${kind} remain after deletion: ${resource.name}`);
    }
  }
  await rm(resource.directory, { recursive: true, force: true });
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
    default:
      throw new Error(`Unknown cleanup resource kind: ${resource.kind}`);
  }
}

async function cleanupResourceIds(statePath, resourceIds) {
  const path = resolve(statePath);
  if (!isAbsolute(path)) {
    throw new Error("Cleanup state path must resolve to an absolute path.");
  }
  if (!(await stateExists(path))) {
    return;
  }
  // A test may prepare and clean databases from its own process beside the runner.
  await withStateLock(path, () => cleanupLockedResourceIds(path, resourceIds));
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

async function cleanupLockedResourceIds(path, resourceIds) {
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
      await cleanupResource(resource, state);
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

export { cleanupResourceIds, cleanupState };

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
