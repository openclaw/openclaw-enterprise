import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { removeImageFileContainer } from "../lib/image-file.mjs";
import { cleanupLogging, ciOtelBackendResourceKind } from "./logging.ts";
import { cleanupKeycloak, keycloakResourceKind } from "./keycloak.mjs";
import { laneImagesResourceKind, restoreLaneImages } from "./lane-images.ts";
import { fork, spawn } from "node:child_process";
import { constants, type Dirent } from "node:fs";
import {
  access,
  chmod,
  lstat,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withStateLock } from "./state-lock.ts";
import { runPostgresAdmin } from "./postgres-admin.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const composePostgresFile = join(repositoryRoot, "compose.postgres.yaml");
type CleanupResource = Record<string, unknown>;
type K3dCleanupIdentity = {
  cluster: string;
  serverID: string;
  networkID: string;
  volumes: { name: string; createdAt: string }[];
};
type CleanupAuthority = {
  expectedStateSha256?: string;
  k3dIdentity?: K3dCleanupIdentity;
};

type CleanupState = Record<string, unknown> & {
  prefix: string;
  resources: unknown[];
};

type CommandResult = { stdout: string; stderr: string };
type CommandOptions = { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number };
type CommandRunner = (
  command: string,
  args: string[],
  options?: CommandOptions,
) => Promise<{ stdout: string }>;
type SupervisorResult = {
  code: number | null;
  signal: string | null;
  error?: { message: string; code?: string };
};
type DropResult = { error?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function resourceFields(value: unknown): CleanupResource {
  if (!isRecord(value)) {
    throw new TypeError("Cleanup state resource must be an object.");
  }
  return value;
}

function errorCode(error: unknown): unknown {
  return isRecord(error) ? error.code : undefined;
}

function errorMessage(error: unknown): unknown {
  return isRecord(error) ? error.message : undefined;
}

function isSupervisorResult(value: unknown): value is SupervisorResult {
  return (
    isRecord(value) &&
    (value.code === null || typeof value.code === "number") &&
    (value.signal === null || typeof value.signal === "string") &&
    (value.error === undefined ||
      (isRecord(value.error) &&
        typeof value.error.message === "string" &&
        (value.error.code === undefined || typeof value.error.code === "string")))
  );
}

const activeCommands = new Set<() => void>();

// A caller that is about to hard-kill its descendant processes must stop these
// groups first: killing a supervisor alone prevents its IPC-disconnect cleanup.
function stopCleanupCommands() {
  for (const stop of activeCommands) {
    stop();
  }
}

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined || !arg.startsWith("--")) {
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
// the job's Cleanup lane step until the job timeout. Past it the command gets SIGTERM, then
// SIGKILL after a grace period. Tests shorten both. A test's database drop, a direct
// connection to the lane's server, has the shorter limit below.
function positiveEnvMs(name: string, fallback: number) {
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

function execFile(
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
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
    if (processGroup && process.env.OPENCLAW_CI_COMPLETE_PHASE === "1" && process.send) {
      process.send({ type: "ci-lifecycle-group", id: child.pid });
    }
    let commandResult: SupervisorResult | undefined;
    if (processGroup) {
      child.on("message", (result) => {
        if (isSupervisorResult(result)) {
          commandResult = result;
        }
      });
    }
    let signalError: unknown;
    let killSent = false;
    const signalCommand = (signal: NodeJS.Signals) => {
      if (signal === "SIGKILL") {
        killSent = true;
      }
      try {
        if (processGroup) {
          // A live supervisor anchors the numeric group ID. Once it exits,
          // never signal an ID that another process could have reused.
          if (
            child.pid !== undefined &&
            child.pid > 1 &&
            child.exitCode === null &&
            child.signalCode === null
          ) {
            process.kill(-child.pid, signal);
          }
        } else {
          child.kill(signal);
        }
      } catch (error) {
        if (errorCode(error) !== "ESRCH") {
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
    let killTimer: NodeJS.Timeout | undefined;
    let abandonTimer: NodeJS.Timeout | undefined;
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
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    function finish(code: number | null, signal: string | null, spawnError?: Error) {
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

function assertCleanupState(state: unknown): asserts state is CleanupState {
  if (!isRecord(state)) {
    throw new Error("Cleanup state must be an object.");
  }
  if (state.version !== 1) {
    throw new Error(`Unsupported cleanup state version: ${state.version}`);
  }
  if (state.repositoryRoot !== repositoryRoot) {
    throw new Error(`Cleanup state belongs to another repository root: ${state.repositoryRoot}`);
  }
  if (typeof state.prefix !== "string" || !state.prefix.startsWith("openclaw-ci-")) {
    throw new Error("Cleanup state prefix is not an OpenClaw Enterprise CI prefix.");
  }
  if (!Array.isArray(state.resources)) {
    throw new Error("Cleanup state resources must be an array.");
  }
}

async function readState(path: string, expectedHash?: string): Promise<CleanupState> {
  const bytes = await readFile(path);
  if (expectedHash !== undefined) {
    assert.match(expectedHash, /^[a-f0-9]{64}$/);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      expectedHash,
      "cleanup state changed after preparation",
    );
  }
  const state: unknown = JSON.parse(bytes.toString("utf8"));
  assertCleanupState(state);
  return state;
}

async function writeState(path: string, state: CleanupState) {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
  await chmod(path, 0o600);
}

function assertString(value: unknown, description: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${description} is missing.`);
  }
}

function assertOwnedName(
  prefix: string,
  value: unknown,
  description: string,
): asserts value is string {
  assertString(value, description);
  if (!value.startsWith(prefix)) {
    throw new Error(`Refusing to clean unowned ${description}: ${value}`);
  }
}

function assertResourceOwner(resource: CleanupResource, state: CleanupState) {
  if (resource.owner !== state.prefix) {
    throw new Error(`Refusing to clean resource owned by another prefix: ${resource.owner}`);
  }
}

function assertOwnedImage(
  resource: CleanupResource,
  state: CleanupState,
): asserts resource is CleanupResource & { name: string } {
  assertResourceOwner(resource, state);
  assertString(resource.name, "image name");
  if (!/^localhost\/(?:openclaw-ci-image-|openclaw-k8s-)/.test(resource.name)) {
    throw new Error(`Refusing to remove unowned image: ${resource.name}`);
  }
}

function assertOwnedK3dImage(
  resource: CleanupResource,
  state: CleanupState,
): asserts resource is CleanupResource & { name: string; cluster: string } {
  assertResourceOwner(resource, state);
  assertOwnedName("openclaw-k8s-", resource.cluster, "k3d cluster");
  assertString(resource.name, "k3d image name");
}

function assertOwnedDatabase(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^(?:openclaw_ci|openclaw_failures|openclaw_k8s)_[a-z0-9_]+$/.test(value)
  ) {
    throw new Error(`Refusing to drop unowned database: ${value}`);
  }
}

function assertOwnedK3dFilesystem(
  resource: CleanupResource,
): asserts resource is CleanupResource & { directory: string } {
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

function composeArgs(resource: CleanupResource, state: CleanupState, ...args: string[]) {
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

function quoteIdentifier(value: string) {
  if (!/^[a-z0-9_]+$/.test(value)) {
    throw new Error(`Unsafe PostgreSQL identifier: ${value}`);
  }
  return `"${value.replaceAll('"', '""')}"`;
}

async function cleanupComposePostgres(
  resource: CleanupResource,
  state: CleanupState,
  statePath: string,
) {
  if (
    resource.directory !== undefined &&
    resource.directory !== join(dirname(statePath), `${resource.name}-bootstrap`)
  ) {
    throw new Error(
      `Refusing cleanup outside the owned PostgreSQL directory: ${resource.directory}`,
    );
  }
  const args = composeArgs(resource, state, "down", "--volumes", "--remove-orphans");
  if (resource.directory !== undefined && resource.directoryCreated !== true) {
    if (resource.directoryCreated === false) {
      try {
        await lstat(resource.directory);
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          return;
        }
        throw error;
      }
    }
    throw new Error(`Refusing unconfirmed PostgreSQL bootstrap ownership: ${resource.directory}`);
  }
  if (resource.directory !== undefined && resource.initSqlCreated !== true) {
    if (resource.initSqlCreated === false) {
      try {
        // Only an empty owned directory is safe before SQL creation is confirmed.
        await rmdir(resource.directory);
        return;
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          return;
        }
        if (errorCode(error) !== "ENOTEMPTY" && errorCode(error) !== "EEXIST") {
          throw error;
        }
      }
    }
    throw new Error(
      `Refusing unconfirmed PostgreSQL bootstrap SQL ownership: ${resource.directory}`,
    );
  }
  await execFile(process.env.OCC_DOCKER_BIN ?? "docker", args, {
    env: {
      OCC_POSTGRES_PORT: String(resource.port),
      ...(resource.directory === undefined
        ? {}
        : { OPENCLAW_CI_POSTGRES_INIT_SQL: join(resource.directory, "init-local.sql") }),
    },
  });
  if (resource.directory !== undefined) {
    let entries: Dirent<string>[];
    try {
      if (!(await lstat(resource.directory)).isDirectory()) {
        throw new Error(`Refusing unexpected PostgreSQL bootstrap contents: ${resource.directory}`);
      }
      entries = await readdir(resource.directory, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return;
      }
      throw error;
    }
    if (entries.some((entry) => entry.name !== "init-local.sql" || !entry.isFile())) {
      throw new Error(`Refusing unexpected PostgreSQL bootstrap contents: ${resource.directory}`);
    }
    await rm(join(resource.directory, "init-local.sql"), { force: true });
    await rmdir(resource.directory);
  }
}

async function cleanupDatabase(resource: CleanupResource, state: CleanupState) {
  assertResourceOwner(resource, state);
  assertOwnedDatabase(resource.name);
  const composeEntry = state.resources.find((entry) => {
    const candidate = resourceFields(entry);
    return candidate.kind === "compose-postgres" && candidate.name === resource.composeProject;
  });
  if (!composeEntry) {
    return;
  }
  const compose = resourceFields(composeEntry);
  // Checks the server is this state's owned lane server before connecting to its port.
  composeArgs(compose, state);
  // FORCE ends the database's remaining sessions first.
  await runPostgresAdmin({
    port: compose.port,
    statements: [`DROP DATABASE IF EXISTS ${quoteIdentifier(resource.name)} WITH (FORCE)`],
    timeoutMs: databaseDropTimeoutMs(),
  });
}

async function cleanupK3dCluster(
  resource: CleanupResource,
  state: CleanupState,
  identity?: K3dCleanupIdentity,
) {
  assertResourceOwner(resource, state);
  assertOwnedK3dFilesystem(resource);
  await deleteOwnedK3dCluster(resource, identity ? { identity } : {});
  await emptyK3dSharedStorage(resource);
  await rm(resource.directory, { recursive: true, force: true });
}

// The fixture lanes bind <directory>/storage into every node as local-path's storage
// (prepare.mjs). local-path creates each claim's volume directory as root and removes it with a
// helper Pod only after the claim is deleted, so volumes of namespaces that tests deleted without
// waiting leave directories the runner user cannot remove. The cluster is gone by now, so nothing
// writes there again: empty the storage as root from the cluster's own node image, which is
// already present (never pulled here), with no network.
async function emptyK3dSharedStorage(resource: CleanupResource & { directory: string }) {
  const storage = join(resource.directory, "storage");
  let entries: string[];
  try {
    entries = await readdir(storage);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return;
    }
    throw error;
  }
  if (entries.length === 0) {
    return;
  }
  assertString(resource.nodeImage, "k3d node image");
  if (resource.nodeImage.startsWith("-")) {
    throw new Error(`Refusing an invalid k3d node image: ${resource.nodeImage}`);
  }
  await execFile(process.env.OCC_DOCKER_BIN ?? "docker", [
    "run",
    "--rm",
    "--pull=never",
    "--network=none",
    "--user=0",
    // The k3d nodes are privileged; this container is not, so SELinux hosts would deny it the
    // unlabelled bind mount.
    "--security-opt=label=disable",
    "--entrypoint=find",
    "--volume",
    `${storage}:/storage`,
    resource.nodeImage,
    "/storage",
    "-mindepth",
    "1",
    "-delete",
  ]);
}

// Delete an owned cluster and its exact cluster-labelled Docker resources, and
// verify none remain. Preparation also calls this to discard a cluster whose
// create timed out before it retries; it keeps the cluster's directory.
async function deleteOwnedK3dCluster(
  resource: CleanupResource,
  {
    execFile: run = execFile,
    identity,
  }: { execFile?: CommandRunner; identity?: K3dCleanupIdentity } = {},
) {
  assertOwnedName("openclaw-k8s-", resource.name, "k3d cluster");
  if (identity) {
    return deleteBoundK3dCluster(resource, identity, run);
  }
  const k3d = process.env.OPENCLAW_CI_K3D_BIN ?? "k3d";
  const listClusters = async () => {
    const result = await run(k3d, ["cluster", "list", "-o", "json"]);
    const clusters: unknown = JSON.parse(result.stdout);
    if (
      !Array.isArray(clusters) ||
      !clusters.every(
        (cluster: unknown): cluster is { name: string } =>
          isRecord(cluster) && typeof cluster.name === "string" && cluster.name.length > 0,
      )
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
  ] as const) {
    const list = async (filter: string) =>
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
    let remaining = false;
    // An empty labelled list already shows none remain: list them again only after a removal.
    // The name check catches an unlabelled leftover either way.
    if (labelled.length) {
      await run(docker, [...remove, ...labelled]);
      remaining = (await list(`label=k3d.cluster=${resource.name}`)).length > 0;
    }
    if (remaining || (await list(`name=k3d-${resource.name}`)).length) {
      throw new Error(`Possible owned k3d ${kind} remain after deletion: ${resource.name}`);
    }
  }
}

// Staged cleanup carries captured custody into the destructive owner. Never
// resolve a replacement by cluster name or use k3d's label-wide deletion here.
async function deleteBoundK3dCluster(
  resource: CleanupResource,
  identity: K3dCleanupIdentity,
  run: CommandRunner,
) {
  assert.equal(identity.cluster, resource.name);
  assert.match(identity.serverID, /^[a-f0-9]{64}$/);
  assert.match(identity.networkID, /^[a-f0-9]{64}$/);
  assert.ok(identity.volumes.length > 0);
  assert.equal(new Set(identity.volumes.map((v) => v.name)).size, identity.volumes.length);
  for (const volume of identity.volumes) {
    assert.match(volume.name, /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);
    assert.ok(volume.createdAt.length > 0);
  }
  const docker = process.env.OCC_DOCKER_BIN ?? "docker";
  const text = async (...args: string[]) => (await run(docker, args)).stdout;
  const lines = async (...args: string[]) =>
    (await text(...args)).trim().split(/\r?\n/u).filter(Boolean).sort();
  const label = `label=k3d.cluster=${identity.cluster}`;
  assert.deepEqual(
    await lines("ps", "-aq", "--no-trunc", "--filter", label),
    [identity.serverID],
    "bound k3d server identity changed",
  );
  const networkName = `k3d-${identity.cluster}`;
  const attachments: unknown = JSON.parse(
    await text(
      "container",
      "inspect",
      "--format",
      "{{json .NetworkSettings.Networks}}",
      identity.serverID,
    ),
  );
  assert.ok(isRecord(attachments));
  assert.deepEqual(Object.keys(attachments), [networkName]);
  const attachment = attachments[networkName];
  assert.ok(isRecord(attachment));
  assert.equal(attachment.NetworkID, identity.networkID, "bound k3d network identity changed");
  assert.equal(
    (await text("network", "inspect", "--format", "{{.Name}}", identity.networkID)).trim(),
    networkName,
  );
  const network: unknown = JSON.parse(
    await text("network", "inspect", "--format", "{{json .Containers}}", identity.networkID),
  );
  assert.ok(isRecord(network));
  assert.deepEqual(Object.keys(network), [identity.serverID], "bound k3d network is shared");
  const mounted = await lines(
    "container",
    "inspect",
    "--format",
    '{{range .Mounts}}{{if eq .Type "volume"}}{{println .Name}}{{end}}{{end}}',
    identity.serverID,
  );
  assert.deepEqual(
    mounted,
    identity.volumes.map((v) => v.name).sort(),
    "bound k3d volume membership changed",
  );
  const checkVolume = async (
    volume: K3dCleanupIdentity["volumes"][number],
    consumers: string[],
  ) => {
    const info: unknown = JSON.parse(
      await text("volume", "inspect", "--format", "{{json .}}", volume.name),
    );
    assert.ok(isRecord(info));
    assert.equal(info.Name, volume.name);
    assert.equal(info.CreatedAt, volume.createdAt, "bound k3d volume was replaced");
    assert.equal(info.Driver, "local");
    assert.equal(info.Scope, "local");
    assert.deepEqual(
      await lines("ps", "-aq", "--no-trunc", "--filter", `volume=${volume.name}`),
      consumers,
      "bound k3d volume is shared",
    );
  };
  for (const volume of identity.volumes) {
    await checkVolume(volume, [identity.serverID]);
  }
  // Keep volumes until their post-container consumer check. Non-forced volume
  // removal also lets Docker reject an attachment racing that final check.
  await text("rm", "-f", identity.serverID);
  await text("network", "rm", identity.networkID);
  for (const volume of identity.volumes) {
    // Docker volumes have names, not immutable deletion IDs. This recheck does
    // not claim atomic protection against a privileged daemon-side recreation.
    await checkVolume(volume, []);
    await text("volume", "rm", volume.name);
  }
  assert.deepEqual(
    await lines("ps", "-aq", "--no-trunc", "--filter", label),
    [],
    "k3d server remains or was replaced during cleanup",
  );
  assert.ok(
    !(await lines("network", "ls", "--format", "{{.Name}}")).includes(networkName),
    "k3d network remains or was replaced during cleanup",
  );
  const volumes = await lines("volume", "ls", "-q");
  assert.ok(
    identity.volumes.every((v) => !volumes.includes(v.name)),
    "bound k3d volume remains",
  );
}

async function cleanupImageTag(resource: CleanupResource, state: CleanupState) {
  assertOwnedImage(resource, state);
  await execFile(process.env.OCC_DOCKER_BIN ?? "docker", [
    "image",
    "rm",
    "-f",
    resource.name,
  ]).catch((error: unknown) => {
    if (
      /No such image|image is referenced in multiple repositories/i.test(
        String(errorMessage(error)),
      )
    ) {
      return;
    }
    throw error;
  });
}

async function cleanupK3dImage(resource: CleanupResource, state: CleanupState) {
  assertOwnedK3dImage(resource, state);
  if (resource.reference) {
    assertString(resource.reference, "k3d image reference");
  }
  const references = [
    ...new Set(
      [resource.reference, resource.name].filter(
        (reference): reference is string => typeof reference === "string" && Boolean(reference),
      ),
    ),
  ];
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
    ]).catch((error: unknown) => {
      if (/not found|No such container/i.test(String(errorMessage(error)))) {
        return;
      }
      throw error;
    });
  }
}

async function cleanupFirstAgentImages(resource: CleanupResource, state: CleanupState) {
  assertResourceOwner(resource, state);
  assertOwnedName("openclaw-ci-first-images-", resource.name, "first-Agent registry");
  if (
    typeof resource.port !== "number" ||
    !Number.isInteger(resource.port) ||
    resource.port < 1 ||
    resource.port > 65535
  ) {
    throw new Error("Invalid first-Agent image registry receipt.");
  }
  if (resource.controllerImage !== undefined) {
    const prefix = `127.0.0.1:${resource.port}/${resource.name}/controller@`;
    if (
      typeof resource.controllerImage !== "string" ||
      !resource.controllerImage.startsWith(prefix) ||
      !/^sha256:[a-f0-9]{64}$/.test(resource.controllerImage.slice(prefix.length))
    ) {
      throw new Error("Refusing to remove an unowned first-Agent controller image.");
    }
  }
  const docker = process.env.OCC_DOCKER_BIN ?? "docker";
  const inspect = async (kind: string, name: string): Promise<unknown> => {
    try {
      const inventory: unknown = JSON.parse(
        (await execFile(docker, [kind, "inspect", name])).stdout,
      );
      if (!isRecord(inventory)) {
        throw new Error("Invalid Docker inspection result.");
      }
      return inventory["0"];
    } catch (error) {
      if (/No such (?:image|object|container)/i.test(String(errorMessage(error)))) {
        return undefined;
      }
      throw error;
    }
  };
  const container = await inspect("container", resource.name);
  if (container) {
    if (
      !isRecord(container) ||
      !isRecord(container.Config) ||
      !isRecord(container.Config.Labels) ||
      container.Config.Labels["openclaw.dev/ci-owner"] !== state.prefix ||
      typeof container.Id !== "string" ||
      !/^[a-f0-9]{64}$/.test(container.Id ?? "") ||
      (resource.containerId !== undefined && container.Id !== resource.containerId)
    ) {
      throw new Error("First-Agent registry changed ownership.");
    }
  }
  if (
    typeof resource.controllerImage === "string" &&
    resource.controllerImage &&
    (await inspect("image", resource.controllerImage))
  ) {
    // Remove the exact owned reference, without forcing removal from live readers.
    await execFile(docker, ["image", "rm", resource.controllerImage]);
  }
  if (isRecord(container) && typeof container.Id === "string") {
    await execFile(docker, ["container", "rm", "--force", "--volumes", container.Id]);
  }
}

async function cleanupResource(
  resource: CleanupResource,
  state: CleanupState,
  statePath: string,
  identity?: K3dCleanupIdentity,
) {
  switch (resource.kind) {
    case "image-file":
      if (resource.owner !== state.prefix) {
        throw new Error("Refusing to clean an image extraction container owned by another prefix.");
      }
      if (
        typeof resource.name !== "string" ||
        !resource.name.startsWith(`${state.prefix}-provenance-`) ||
        !/^openclaw-ci-[a-z0-9-]+-provenance-[a-f0-9]{12}$/.test(resource.name)
      ) {
        throw new Error("Refusing to remove an unowned image extraction container.");
      }
      await removeImageFileContainer({
        resource,
        persist: () => writeState(statePath, state),
        command: async (_docker: string, args: string[], options: { timeout?: number } = {}) => {
          try {
            return (
              await execFile(process.env.OCC_DOCKER_BIN ?? "docker", args, {
                timeoutMs: options.timeout ?? 30_000,
              })
            ).stdout;
          } catch {
            throw new Error("Runtime provenance image cleanup command failed.");
          }
        },
      });
      break;
    case "first-agent-image-registry":
      await cleanupFirstAgentImages(resource, state);
      break;
    case ciOtelBackendResourceKind: {
      assertResourceOwner(resource, state);
      const loggingOptions = { env: process.env, execFile };
      await cleanupLogging(resource, loggingOptions);
      break;
    }
    case "postgres-database":
      await cleanupDatabase(resource, state);
      break;
    case "compose-postgres":
      await cleanupComposePostgres(resource, state, statePath);
      break;
    case "k3d-image":
      await cleanupK3dImage(resource, state);
      break;
    case "k3d-cluster":
      await cleanupK3dCluster(resource, state, identity);
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
      await restoreLaneImages(
        { name: String(resource.name), images: resource.images },
        {
          execFile,
          docker: process.env.OCC_DOCKER_BIN ?? "docker",
        },
      );
      break;
    default:
      throw new Error(`Unknown cleanup resource kind: ${resource.kind}`);
  }
}

// lockTimeoutMs limits the wait for the CI state lock (state-lock.ts's default otherwise), so a
// caller that has its own limit, such as a test fixture's database drop, stops waiting with it.
// The selected databases are dropped before that wait, each within databaseDropTimeoutMs.
async function cleanupResourceIds(
  statePath: string,
  resourceIds?: readonly unknown[],
  { lockTimeoutMs, ...authority }: { lockTimeoutMs?: number } & CleanupAuthority = {},
) {
  assert.equal(
    authority.expectedStateSha256 !== undefined,
    authority.k3dIdentity !== undefined,
    "bound cleanup requires both state digest and resource custody",
  );
  if (authority.k3dIdentity) {
    assert.equal(resourceIds, undefined, "bound cleanup requires the complete prepared state");
  }
  const path = resolve(statePath);
  if (!isAbsolute(path)) {
    throw new Error("Cleanup state path must resolve to an absolute path.");
  }
  if (!(await stateExists(path))) {
    assert.equal(authority.expectedStateSha256, undefined, "bound cleanup state is missing");
    return false;
  }
  const dropped = resourceIds === undefined ? undefined : await dropDatabases(path, resourceIds);
  // A test may prepare and clean databases from its own process beside the runner.
  return withStateLock(
    path,
    () => cleanupLockedResourceIds(path, resourceIds, dropped, authority),
    {
      timeoutMs: lockTimeoutMs,
    },
  );
}

// DROP DATABASE requests an immediate checkpoint, which writes out every dirty buffer on
// the server: about 0.25 s on an idle server, and 3-5 s while a lane's other files write.
// Each test's copy is dropped this way, and under the CI state lock every other copy and
// drop waited for it (finding 2180). The lock guards the state file, not the server, so
// the selected databases are dropped first, from a state snapshot (writes replace the
// file whole), and only their entries are removed under the lock. An entry stays until
// its drop succeeds, so a crash in between leaves it for lane cleanup, as before. A lane
// template stays on the locked path: prepareFile finds it through the state and copies it.
async function dropDatabases(path: string, resourceIds: readonly unknown[]) {
  const results = new Map<unknown, DropResult>();
  let state: CleanupState;
  try {
    state = await readState(path);
  } catch (error) {
    // Another cleanup removed the emptied state; the locked pass returns as before.
    if (errorCode(error) === "ENOENT") {
      return results;
    }
    throw error;
  }
  for (const entry of [...state.resources].reverse()) {
    const resource = resourceFields(entry);
    if (
      resource.kind === "postgres-database" &&
      resource.laneTemplate === undefined &&
      resourceIds.includes(resource.id)
    ) {
      results.set(
        resource.id,
        await cleanupDatabase(resource, state).then(
          () => ({}),
          (error: unknown) => ({ error }),
        ),
      );
    }
  }
  return results;
}

async function stateExists(path: string) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

// `dropped` maps the ids of databases dropped before the lock to {}, or to { error }.
async function cleanupLockedResourceIds(
  path: string,
  resourceIds?: readonly unknown[],
  dropped: Map<unknown, DropResult> = new Map(),
  authority: CleanupAuthority = {},
) {
  if (!(await stateExists(path))) {
    assert.equal(authority.expectedStateSha256, undefined, "bound cleanup state is missing");
    return false;
  }
  const state = await readState(path, authority.expectedStateSha256);
  if (authority.k3dIdentity) {
    assert.equal(state.resources.length, 1, "bound cleanup requires exactly one cluster resource");
    const resource = resourceFields(state.resources[0]);
    assert.equal(resource.kind, "k3d-cluster");
    assert.equal(resource.name, authority.k3dIdentity.cluster);
  }
  const selected = new Set(
    resourceIds ?? state.resources.map((resource) => resourceFields(resource).id),
  );
  const failures = [];

  for (const entry of [...state.resources].reverse()) {
    const resource = resourceFields(entry);
    if (!selected.has(resource.id)) {
      continue;
    }
    try {
      if (!dropped.has(resource.id)) {
        await cleanupResource(resource, state, path, authority.k3dIdentity);
      } else {
        const result = dropped.get(resource.id);
        if (result && "error" in result) {
          throw result.error;
        }
      }
      state.resources = state.resources.filter(
        (candidate) => resourceFields(candidate).id !== resource.id,
      );
      await writeState(path, state);
    } catch (error) {
      failures.push(
        resource.kind === "image-file"
          ? "image-file:Runtime provenance cleanup failed; private resource receipt retained."
          : `${resource.kind}:${resource.name ?? resource.id}:${errorMessage(error)}`,
      );
    }
  }

  if (failures.length > 0) {
    await writeState(path, state);
    throw new Error(`Cleanup failed for ${failures.join(", ")}`);
  }
  if (state.resources.length === 0) {
    await rm(path, { force: true });
  }
  return true;
}

async function cleanupState(statePath: string, authority: CleanupAuthority = {}) {
  return cleanupResourceIds(statePath, undefined, authority);
}

// Final job cleanup runs after the runner wrote its file-level evidence.
async function recordLaneCleanup(
  path: string,
  status: "passed" | "failed",
  processedState = false,
) {
  if (!(await stateExists(path))) {
    return; // Setup may have failed before a lane result existed.
  }
  const result: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(result) || result.version !== 1 || result.command !== "run") {
    throw new Error("Cannot record cleanup on an invalid lane result.");
  }
  if (
    status === "passed" &&
    !processedState &&
    isRecord(result.cleanup) &&
    result.cleanup.status === "failed"
  ) {
    throw new Error("Cannot verify failed cleanup without resource state.");
  }
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ ...result, cleanup: { status } }, null, 2), {
    mode: 0o600,
  });
  await rename(temporary, path);
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.state) {
    throw new Error("--state is required.");
  }
  let processedState: boolean;
  try {
    processedState = await cleanupState(args.state);
  } catch (error) {
    if (args.results) {
      await recordLaneCleanup(args.results, "failed");
    }
    throw error;
  }
  if (args.results) {
    await recordLaneCleanup(args.results, "passed", processedState);
  }
}

export { cleanupResourceIds, cleanupState, deleteOwnedK3dCluster, stopCleanupCommands };
