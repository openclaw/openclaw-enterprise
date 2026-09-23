/* global SSH_OPERATION */
const fs = require("node:fs");
const { join, resolve, isAbsolute, relative } = require("node:path");
const { createHash, randomBytes } = require("node:crypto");
const { execFile, spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

class OwnershipFailure extends Error {}
class ConfigurationFailure extends Error {}

const hash = (value) => createHash("sha256").update(value).digest("hex");
const temporary = (path) => `${path}.pending-${process.pid}-${randomBytes(8).toString("hex")}`;
let child;

function inspect(path) {
  try {
    return fs.lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function directory(path, create = false) {
  const info = inspect(path);
  if (info === undefined && create) {
    fs.mkdirSync(path, { recursive: true, mode: 0o755 });
    return;
  }
  if (!info?.isDirectory()) {
    throw new OwnershipFailure("Expected an owned directory.");
  }
}

function regular(path) {
  if (!inspect(path)?.isFile()) {
    throw new OwnershipFailure("Expected an owned regular file.");
  }
}

function readJson(path) {
  regular(path);
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    throw new OwnershipFailure("Invalid ownership marker.");
  }
}

function verify(marker, expected) {
  for (const [key, value] of Object.entries(expected)) {
    if (JSON.stringify(marker?.[key]) !== JSON.stringify(value)) {
      throw new OwnershipFailure("Host object ownership or immutable snapshot differs.");
    }
  }
  return marker;
}

function atomicWrite(path, contents, mode = 0o600, owner) {
  if (inspect(path) !== undefined) {
    regular(path);
  }
  const pending = temporary(path);
  try {
    fs.writeFileSync(pending, contents, { mode, flag: "wx" });
    if (owner !== undefined) {
      fs.chownSync(pending, owner.uid, owner.gid);
    }
    fs.renameSync(pending, path);
  } finally {
    fs.rmSync(pending, { force: true });
  }
}

function atomicDirectory(path, initialize) {
  const pending = temporary(path);
  fs.mkdirSync(pending, { mode: 0o755 });
  try {
    initialize(pending);
    fs.renameSync(pending, path);
  } finally {
    fs.rmSync(pending, { recursive: true, force: true });
  }
}

async function command(file, args, allowFailure = false) {
  return new Promise((resolve, reject) => {
    child = execFile(
      file,
      args,
      { encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        child = undefined;
        if (error && !allowFailure) {
          reject(new Error("Host command failed."));
        } else {
          resolve({ success: !error, stdout: stdout.trim() });
        }
      },
    );
  });
}

async function systemctl(...args) {
  return command("systemctl", args);
}

async function userOwner(user) {
  const uid = Number((await command("id", ["-u", user])).stdout);
  const gid = Number((await command("id", ["-g", user])).stdout);
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid)) {
    throw new ConfigurationFailure("Runtime user is unavailable.");
  }
  if (uid === 0) {
    throw new ConfigurationFailure("Runtime user must not resolve to uid 0.");
  }
  return { uid, gid };
}

async function probe(runtime) {
  await systemctl("--version");
  await command("sh", ["-c", "command -v flock"]);
  await command("sh", ["-c", "command -v runuser"]);
  await command("sh", ["-c", "command -v getent"]);
  await command("sh", ["-c", "command -v groupadd"]);
  await command("sh", ["-c", "command -v useradd"]);
  await command("sh", ["-c", "command -v userdel"]);
  await command("sh", ["-c", "command -v groupdel"]);
  fs.accessSync(runtime.nodePath, fs.constants.X_OK);
  fs.accessSync(runtime.openclawPath, fs.constants.R_OK);
  if (!/^(?!root$)[a-z_][a-z0-9_-]*$/.test(runtime.user)) {
    throw new ConfigurationFailure("Runtime user prefix is invalid.");
  }
}

const LOCK_NAME = ".compute-lock";
let lockHolder;

// Host-wide serialization uses a kernel flock(2) on <root>/.compute-lock held by
// a child whose stdin is this process. Whatever kills this helper (SSH drop,
// SIGKILL, deadline, host crash) closes that pipe, the child exits, and the
// kernel releases the lock; there is no stale-lock state to reclaim.
async function acquireLock(root) {
  directory(root, true);
  const path = join(root, LOCK_NAME);
  const holder = spawn("flock", ["-w", "30", path, "sh", "-c", "printf ok && read -r _"], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  await new Promise((resolve, reject) => {
    let acquired = false;
    holder.stdout.setEncoding("utf8").on("data", (chunk) => {
      if (chunk.includes("ok")) {
        acquired = true;
        resolve();
      }
    });
    holder.once("error", () => reject(new ConfigurationFailure("Host flock is unavailable.")));
    holder.once("exit", () => {
      if (!acquired) {
        reject(new Error("Host operation lock timed out."));
      }
    });
  });
  lockHolder = holder;
}

function releaseLock() {
  if (lockHolder !== undefined) {
    lockHolder.stdin.end();
    lockHolder.kill("SIGTERM");
    lockHolder = undefined;
  }
}

function ownership(input) {
  return {
    driverId: input.driverId,
    implementation: input.implementation,
    namespaceId: input.namespace.id,
    namespaceName: input.namespace.name,
  };
}

function agentOwnership(input) {
  return {
    ...ownership(input),
    agentId: input.revision.agentId,
    servicePrincipalId: input.revision.servicePrincipalId,
  };
}

function accountName(input) {
  return `${input.runtime.user.slice(0, 19)}-${hash(
    `${input.namespace.id}:${input.revision.agentId}`,
  ).slice(0, 12)}`;
}

function accountOwnership(input, name = accountName(input)) {
  return {
    ...agentOwnership(input),
    runtimeUser: name,
    runtimeGroup: name,
  };
}

function accountMarker(input, name = accountName(input)) {
  return join(input.runtime.root, "accounts", `${name}.json`);
}

function namespaceDirectory(input) {
  return join(input.runtime.root, "namespaces", hash(input.namespace.id).slice(0, 12));
}

function unitName(agentId) {
  return `openclaw-enterprise-gateway-${hash(agentId).slice(0, 12)}.service`;
}

function unitHeader(namespaceId, agentId) {
  return `# openclaw-enterprise namespace=${namespaceId} agent=${agentId}`;
}

function verifyUnit(input, agent) {
  const path = join(input.runtime.systemdUnitDirectory, unitName(agent.agentId));
  if (inspect(path) === undefined) {
    return undefined;
  }
  regular(path);
  const contents = fs.readFileSync(path, "utf8");
  if (!contents.split("\n").includes(unitHeader(agent.namespaceId, agent.agentId))) {
    throw new OwnershipFailure("Refusing an unowned systemd unit.");
  }
  return contents;
}

function verifyNamespace(input) {
  const path = namespaceDirectory(input);
  directory(join(input.runtime.root, "namespaces"));
  directory(path);
  verify(readJson(join(path, "namespace.json")), ownership(input));
}

function verifyAgent(input, path) {
  directory(path);
  const marker = verify(readJson(join(path, "agent.json")), agentOwnership(input));
  if (!Number.isSafeInteger(marker.port) || marker.port < 1024 || marker.port > 65535) {
    throw new OwnershipFailure("Invalid Agent port marker.");
  }
  if (marker.runtimeUser !== accountName(input) || marker.runtimeGroup !== marker.runtimeUser) {
    throw new OwnershipFailure("Invalid Agent runtime account marker.");
  }
  for (const name of ["home", "state", "revisions"]) {
    directory(join(path, name));
  }
  verifyUnit(input, marker);
  servedRevision(path);
  return marker;
}

// Written only after a restart reached readiness; a pointer flip alone never counts.
function servedRevision(agentDir) {
  const path = join(agentDir, "served.json");
  if (inspect(path) === undefined) {
    return undefined;
  }
  const marker = readJson(path);
  if (typeof marker.revisionId !== "string") {
    throw new OwnershipFailure("Invalid served marker.");
  }
  return marker.revisionId;
}

function snapshot(input, agentDir, revisionId, expected) {
  const path = join(agentDir, "revisions", hash(revisionId).slice(0, 12));
  directory(path);
  const marker = verify(readJson(join(path, "revision.json")), {
    ...agentOwnership(input),
    revisionId,
    ...expected,
  });
  regular(join(path, "openclaw.json"));
  if (
    marker.configurationHash !== hash(fs.readFileSync(join(path, "openclaw.json"), "utf8")) ||
    !Number.isSafeInteger(marker.revision) ||
    marker.revision < 1 ||
    marker.harness?.id !== "openclaw" ||
    marker.harness?.mode !== "embedded"
  ) {
    throw new OwnershipFailure("Immutable revision snapshot differs.");
  }
  return marker;
}

function currentSnapshot(input, agentDir) {
  const path = join(agentDir, "current");
  const info = inspect(path);
  if (info === undefined) {
    return undefined;
  }
  if (!info.isSymbolicLink()) {
    throw new OwnershipFailure("Current pointer is not a symlink.");
  }
  const target = fs.readlinkSync(path);
  if (!/^revisions\/[a-f0-9]{12}$/.test(target)) {
    throw new OwnershipFailure("Current pointer escapes Agent revisions.");
  }
  const marker = readJson(join(agentDir, target, "revision.json"));
  if (
    typeof marker.revisionId !== "string" ||
    target !== `revisions/${hash(marker.revisionId).slice(0, 12)}`
  ) {
    throw new OwnershipFailure("Current revision identity differs.");
  }
  return snapshot(input, agentDir, marker.revisionId);
}

function revisionMetadata(input) {
  return {
    ...agentOwnership(input),
    revisionId: input.revision.id,
    revision: input.revision.revision,
    configurationHash: input.configurationHash,
    harness: input.revision.harness,
  };
}

async function userExists(name) {
  return (await command("id", ["-u", name], true)).success;
}

async function groupExists(name) {
  return (await command("getent", ["group", name], true)).success;
}

async function groupGid(name) {
  const result = await command("getent", ["group", name]);
  const gid = Number(result.stdout.split(":")[2]);
  if (!Number.isSafeInteger(gid) || gid === 0) {
    throw new OwnershipFailure("Runtime group ownership marker differs.");
  }
  return gid;
}

async function ensureRuntimeIdentity(input) {
  const name = accountName(input);
  const accounts = join(input.runtime.root, "accounts");
  directory(input.runtime.root, true);
  directory(accounts, true);
  const markerPath = accountMarker(input, name);
  const marker = inspect(markerPath) === undefined ? undefined : readJson(markerPath);
  if (marker === undefined) {
    if ((await userExists(name)) || (await groupExists(name))) {
      throw new OwnershipFailure("Refusing to adopt an unowned runtime account.");
    }
    let groupCreated = false;
    let userCreated = false;
    try {
      await command("groupadd", ["--system", name]);
      groupCreated = true;
      await command("useradd", [
        "--system",
        "--gid",
        name,
        "--home-dir",
        join(
          namespaceDirectory(input),
          "agents",
          hash(input.revision.agentId).slice(0, 12),
          "home",
        ),
        "--shell",
        "/usr/sbin/nologin",
        "--no-create-home",
        name,
      ]);
      userCreated = true;
      const owner = await userOwner(name);
      atomicWrite(
        markerPath,
        JSON.stringify({ ...accountOwnership(input, name), uid: owner.uid, gid: owner.gid }),
      );
      return owner;
    } catch (error) {
      if (userCreated) {
        await command("userdel", [name], true);
      }
      if (groupCreated) {
        await command("groupdel", [name], true);
      }
      throw error;
    }
  }

  verify(marker, accountOwnership(input, name));
  const owner = await userOwner(name);
  if (marker.uid !== owner.uid || marker.gid !== owner.gid) {
    throw new OwnershipFailure("Runtime account ownership marker differs.");
  }
  return owner;
}

async function verifyRuntimeIdentity(input, agent) {
  const name = agent.runtimeUser;
  if (typeof name !== "string" || agent.runtimeGroup !== name || name !== accountName(input)) {
    throw new OwnershipFailure("Runtime account marker is invalid.");
  }
  const marker = readJson(accountMarker(input, name));
  verify(marker, accountOwnership(input, name));
  const owner = await userOwner(name);
  if (marker.uid !== owner.uid || marker.gid !== owner.gid) {
    throw new OwnershipFailure("Runtime account ownership marker differs.");
  }
  return owner;
}

async function removeRuntimeIdentity(input, agent) {
  const name = agent.runtimeUser;
  if (typeof name !== "string" || agent.runtimeGroup !== name) {
    throw new OwnershipFailure("Runtime account marker is invalid.");
  }
  const markerPath = accountMarker(input, name);
  const marker = readJson(markerPath);
  verify(marker, accountOwnership(input, name));
  if (await userExists(name)) {
    const owner = await userOwner(name);
    if (marker.uid !== owner.uid || marker.gid !== owner.gid) {
      throw new OwnershipFailure("Runtime account ownership marker differs.");
    }
    await command("userdel", [name]);
  }
  if (await groupExists(name)) {
    if (marker.gid !== (await groupGid(name))) {
      throw new OwnershipFailure("Runtime group ownership marker differs.");
    }
    await command("groupdel", [name]);
  }
  fs.unlinkSync(markerPath);
}

async function removeNamespaceRuntimeIdentities(input, knownAgents) {
  const agents = [...knownAgents];
  const accounts = join(input.runtime.root, "accounts");
  if (inspect(accounts) !== undefined) {
    for (const name of fs.readdirSync(accounts)) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const marker = readJson(join(accounts, name));
      if (
        marker.driverId === input.driverId &&
        marker.implementation === input.implementation &&
        marker.namespaceId === input.namespace.id &&
        marker.namespaceName === input.namespace.name &&
        typeof marker.agentId === "string" &&
        typeof marker.servicePrincipalId === "string"
      ) {
        agents.push(marker);
      }
    }
  }
  const seen = new Set();
  for (const agent of agents) {
    const name = agent.runtimeUser;
    if (typeof name !== "string" || seen.has(name)) {
      continue;
    }
    seen.add(name);
    await removeRuntimeIdentity({ ...input, revision: agent }, agent);
  }
}

function allocatedPorts(input) {
  const ports = new Set();
  const namespaces = join(input.runtime.root, "namespaces");
  directory(namespaces);
  for (const entry of fs.readdirSync(namespaces)) {
    const nsDir = join(namespaces, entry);
    directory(nsDir);
    const ns = readJson(join(nsDir, "namespace.json"));
    if (typeof ns.namespaceId !== "string" || entry !== hash(ns.namespaceId).slice(0, 12)) {
      throw new OwnershipFailure("Invalid host Namespace marker.");
    }
    const agents = join(nsDir, "agents");
    directory(agents);
    for (const name of fs.readdirSync(agents)) {
      const agentDir = join(agents, name);
      directory(agentDir);
      const agent = readJson(join(agentDir, "agent.json"));
      verify(agent, {
        driverId: ns.driverId,
        implementation: ns.implementation,
        namespaceId: ns.namespaceId,
        namespaceName: ns.namespaceName,
      });
      if (
        typeof agent.agentId !== "string" ||
        name !== hash(agent.agentId).slice(0, 12) ||
        !Number.isSafeInteger(agent.port) ||
        agent.port < 1024 ||
        agent.port > 65535 ||
        ports.has(agent.port)
      ) {
        throw new OwnershipFailure("Invalid or duplicate host Agent port.");
      }
      ports.add(agent.port);
    }
  }
  return ports;
}

const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const OPAQUE_PLACEHOLDER = /^opaque-[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RESERVED_ENVIRONMENT_NAME =
  /^(?:HOME|PATH|TMPDIR|CODEX_HOME|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|LOG_FORMAT|RUST_LOG|XDG_.*|OPENCLAW_.*|OTEL_.*|LD_.*|DYLD_.*)$/;

function launchEnvironment(input) {
  const environment = input.launchEnvironment ?? {};
  if (
    environment === null ||
    typeof environment !== "object" ||
    Array.isArray(environment) ||
    Object.getPrototypeOf(environment) !== Object.prototype
  ) {
    throw new ConfigurationFailure("Invalid workload launch environment.");
  }
  const entries = Object.entries(environment);
  if (
    entries.length > 64 ||
    entries.some(
      ([name, value]) =>
        !ENVIRONMENT_NAME.test(name) ||
        RESERVED_ENVIRONMENT_NAME.test(name) ||
        typeof value !== "string" ||
        !OPAQUE_PLACEHOLDER.test(value),
    )
  ) {
    throw new ConfigurationFailure("Invalid workload launch environment.");
  }
  return entries.map(([name, value]) => `Environment=${name}=${value}\n`).join("");
}

// Resolve only the native main workspace, within this Agent's durable directories.
function workspaceDirectory(input, agentDir) {
  const agents = input.revision.configuration.agents ?? {};
  if (
    (agents.entries !== undefined &&
      (typeof agents.entries !== "object" ||
        agents.entries === null ||
        Array.isArray(agents.entries) ||
        Object.keys(agents.entries).some((id) => id !== "main"))) ||
    agents.list !== undefined
  ) {
    throw new ConfigurationFailure("Workspace setup supports only the native main Agent.");
  }
  const configured =
    agents.entries?.main?.workspace ??
    agents.defaults?.workspace ??
    join(agentDir, "state", "workspace");
  if (
    typeof configured !== "string" ||
    !isAbsolute(configured) ||
    !/^\/[A-Za-z0-9_./:@+-]*$/.test(configured)
  ) {
    throw new ConfigurationFailure("Workspace setup requires a supported absolute workspace path.");
  }
  const workspace = resolve(configured);
  const managed = [join(agentDir, "state"), join(agentDir, "home")].find((root) =>
    workspace.startsWith(`${root}/`),
  );
  if (managed === undefined) {
    throw new ConfigurationFailure("Workspace setup requires this Agent's durable storage.");
  }
  let current = managed;
  directory(current);
  for (const component of relative(managed, workspace).split("/")) {
    current = join(current, component);
    if (inspect(current) !== undefined) {
      directory(current);
    }
  }
  return workspace;
}

async function initializeWorkspace(input, agentDir, owner) {
  const metadataPath = join(agentDir, "workspace-setup.json");
  const saved = inspect(metadataPath) === undefined ? undefined : readJson(metadataPath);
  if (input.workspaceSetup === undefined && saved === undefined) {
    return;
  }
  const setup = input.workspaceSetup ?? saved;
  if (setup.namespaceId !== input.namespace.id || setup.agentId !== input.revision.agentId) {
    throw new OwnershipFailure("Workspace setup belongs to another Agent.");
  }
  if (saved !== undefined) {
    verify(saved, {
      id: setup.id,
      namespaceId: setup.namespaceId,
      agentId: setup.agentId,
      defaultsId: setup.defaultsId,
      completed: true,
    });
  }
  const scriptPath = join(agentDir, "workspace-setup.cjs");
  if (input.workspaceSetupRuntime !== undefined) {
    atomicWrite(scriptPath, input.workspaceSetupRuntime, 0o640, {
      uid: process.getuid(),
      gid: owner.gid,
    });
  } else {
    regular(scriptPath);
  }
  const workspace = workspaceDirectory(input, agentDir);
  const configPath = join(
    agentDir,
    "revisions",
    hash(input.revision.id).slice(0, 12),
    "openclaw.json",
  );
  await new Promise((resolve, reject) => {
    child = execFile(
      "runuser",
      ["--user", accountName(input), "--", input.runtime.nodePath, scriptPath],
      {
        cwd: join(agentDir, "state"),
        env: {
          ...process.env,
          HOME: join(agentDir, "home"),
          OPENCLAW_STATE_DIR: join(agentDir, "state"),
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_EXECUTABLE: input.runtime.openclawPath,
          OPENCLAW_WORKSPACE_DIR: workspace,
          OPENCLAW_WORKSPACE_SETUP_PATH: undefined,
        },
        timeout: 60_000,
        maxBuffer: 64 * 1024,
      },
      (error) => {
        child = undefined;
        // Runtime diagnostics and output may include documents or config. Never forward them.
        if (error) {
          reject(new Error("Workspace initialization failed."));
        } else {
          resolve();
        }
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(saved ?? setup));
  });
  if (saved === undefined) {
    atomicWrite(
      metadataPath,
      JSON.stringify({
        id: setup.id,
        namespaceId: setup.namespaceId,
        agentId: setup.agentId,
        ...(setup.defaultsId === undefined ? {} : { defaultsId: setup.defaultsId }),
        completed: true,
      }),
      0o640,
      { uid: process.getuid(), gid: owner.gid },
    );
  }
}

function renderUnit(input, agentDir, port, runtimeUser) {
  const { runtime, revision } = input;
  const password = revision.configuration.gateway?.auth?.password !== undefined;
  const extraEnvironment = launchEnvironment(input);
  const setup =
    inspect(join(agentDir, "workspace-setup.json")) === undefined
      ? ""
      : `Environment=OPENCLAW_EXECUTABLE=${runtime.openclawPath}\n` +
        `Environment=OPENCLAW_WORKSPACE_DIR=${workspaceDirectory(input, agentDir)}\n` +
        `Environment=OPENCLAW_WORKSPACE_SETUP_PATH=${agentDir}/workspace-setup.json\n` +
        `ExecStartPre=${runtime.nodePath} ${agentDir}/workspace-setup.cjs\n`;
  return `[Unit]
Description=OpenClaw Enterprise gateway ${revision.agentId}
${unitHeader(revision.namespaceId, revision.agentId)}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${runtimeUser}
WorkingDirectory=${agentDir}/state
Environment=HOME=${agentDir}/home
Environment=OPENCLAW_STATE_DIR=${agentDir}/state
Environment=OPENCLAW_CONFIG_PATH=${agentDir}/current/openclaw.json
Environment=OPENCLAW_GATEWAY_PORT=${port}
${extraEnvironment}${password ? `EnvironmentFile=${agentDir}/gateway-password.env\n` : ""}EnvironmentFile=-${agentDir}/env
${setup}ExecStart=${runtime.nodePath} ${runtime.openclawPath} gateway --port ${port}
Restart=always
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
`;
}

async function active(unit) {
  return (await command("systemctl", ["is-active", "--quiet", unit], true)).success;
}

async function ready(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
      signal: AbortSignal.timeout(1_000),
      redirect: "error",
    });
    await response.body?.cancel();
    return response.status === 200;
  } catch {
    return false;
  }
}

async function waitReady(unit, port) {
  const deadline = Date.now() + 120_000;
  do {
    if (!(await active(unit))) {
      throw new Error("Gateway unit is inactive.");
    }
    if (await ready(port)) {
      return;
    }
    await delay(250);
  } while (Date.now() < deadline);
  throw new Error("Gateway readiness timed out.");
}

async function prepare(input, nsDir) {
  const revision = input.revision;
  if (revision.harness.id !== "openclaw" || revision.harness.mode !== "embedded") {
    throw new ConfigurationFailure("Only embedded OpenClaw is supported.");
  }
  if (input.configurationHash !== hash(JSON.stringify(revision.configuration))) {
    throw new OwnershipFailure("Admitted configuration hash differs.");
  }
  const agents = join(nsDir, "agents");
  directory(agents);
  const agentDir = join(agents, hash(revision.agentId).slice(0, 12));
  const expected = agentOwnership(input);
  const account = accountOwnership(input);
  const owner = await ensureRuntimeIdentity(input);
  if (inspect(agentDir) === undefined) {
    const used = allocatedPorts(input);
    const range = input.network.gatewayPortRange;
    let port = range.start;
    while (used.has(port) && port <= range.end) {
      port++;
    }
    if (port > range.end) {
      throw new ConfigurationFailure("Host gateway port range is exhausted.");
    }
    atomicDirectory(agentDir, (pending) => {
      fs.writeFileSync(join(pending, "agent.json"), JSON.stringify({ ...account, port }), {
        mode: 0o600,
      });
      for (const name of ["home", "state"]) {
        const path = join(pending, name);
        fs.mkdirSync(path, { mode: 0o700 });
        fs.chownSync(path, owner.uid, owner.gid);
      }
      fs.mkdirSync(join(pending, "revisions"), { mode: 0o755 });
    });
  }
  const agent = verifyAgent(input, agentDir);
  const current = currentSnapshot(input, agentDir);
  const revisionDir = join(agentDir, "revisions", hash(revision.id).slice(0, 12));
  const snapshotExists = inspect(revisionDir) !== undefined;
  if (snapshotExists) {
    snapshot(input, agentDir, revision.id, revisionMetadata(input));
  }
  // A late worker must not write snapshots, credentials, units, or pointers over a newer revision.
  if (current !== undefined && current.revision > revision.revision) {
    return { ready: false };
  }
  if (
    current !== undefined &&
    current.revision === revision.revision &&
    current.revisionId !== revision.id
  ) {
    throw new OwnershipFailure("Revision number belongs to another immutable revision.");
  }
  if (!snapshotExists) {
    atomicDirectory(revisionDir, (pending) => {
      // Controller-owned and group-readable: the runtime account can read but never
      // rewrite the admitted document, so a live gateway cannot bypass admission.
      atomicWrite(join(pending, "openclaw.json"), JSON.stringify(revision.configuration), 0o640, {
        uid: process.getuid(),
        gid: owner.gid,
      });
      atomicWrite(join(pending, "revision.json"), JSON.stringify(revisionMetadata(input)));
    });
  }
  if (revision.configuration.gateway?.auth?.password !== undefined) {
    const passwordFile = join(agentDir, "gateway-password.env");
    if (inspect(passwordFile) === undefined) {
      atomicWrite(passwordFile, `OPENCLAW_GATEWAY_PASSWORD=${randomBytes(32).toString("hex")}\n`);
    } else {
      regular(passwordFile);
    }
  }
  await initializeWorkspace(input, agentDir, owner);
  return { ready: true };
}

async function activate(input, agentDir, agent, current) {
  const revision = input.revision;
  if (current !== undefined && current.revision > revision.revision) {
    throw new OwnershipFailure("A newer revision is already current.");
  }
  if (
    current !== undefined &&
    current.revision === revision.revision &&
    current.revisionId !== revision.id
  ) {
    throw new OwnershipFailure("Revision number belongs to another immutable revision.");
  }
  await initializeWorkspace(input, agentDir, await verifyRuntimeIdentity(input, agent));
  directory(input.runtime.systemdUnitDirectory);
  const unit = unitName(revision.agentId);
  const unitPath = join(input.runtime.systemdUnitDirectory, unit);
  const existingUnit = verifyUnit(input, agent);
  const content = renderUnit(input, agentDir, agent.port, agent.runtimeUser);
  const changed = existingUnit !== content;
  if (changed) {
    atomicWrite(unitPath, content, 0o644);
  }
  await systemctl("daemon-reload");
  await systemctl("enable", unit);
  if (
    !changed &&
    current?.revisionId === revision.id &&
    servedRevision(agentDir) === revision.id &&
    (await active(unit)) &&
    (await ready(agent.port))
  ) {
    return { ready: true };
  }
  const pending = temporary(join(agentDir, "current"));
  try {
    fs.symlinkSync(`revisions/${hash(revision.id).slice(0, 12)}`, pending);
    fs.renameSync(pending, join(agentDir, "current"));
  } finally {
    fs.rmSync(pending, { force: true });
  }
  await systemctl("restart", unit);
  await waitReady(unit, agent.port);
  atomicWrite(join(agentDir, "served.json"), JSON.stringify({ revisionId: revision.id }));
  return {};
}

async function removeNamespace(input, nsDir) {
  const agentsDir = join(nsDir, "agents");
  directory(agentsDir);
  const agents = [];
  // Validate the complete deletion set before stopping any gateway.
  for (const name of fs.readdirSync(agentsDir)) {
    const agentDir = join(agentsDir, name);
    directory(agentDir);
    const agent = readJson(join(agentDir, "agent.json"));
    if (
      typeof agent.agentId !== "string" ||
      typeof agent.servicePrincipalId !== "string" ||
      name !== hash(agent.agentId).slice(0, 12)
    ) {
      throw new OwnershipFailure("Invalid Agent ownership marker.");
    }
    const scoped = { ...input, revision: agent };
    verifyAgent(scoped, agentDir);
    await verifyRuntimeIdentity(scoped, agent);
    currentSnapshot(scoped, agentDir);
    for (const revision of fs.readdirSync(join(agentDir, "revisions"))) {
      const marker = readJson(join(agentDir, "revisions", revision, "revision.json"));
      if (
        typeof marker.revisionId !== "string" ||
        revision !== hash(marker.revisionId).slice(0, 12)
      ) {
        throw new OwnershipFailure("Invalid revision ownership marker.");
      }
      snapshot(scoped, agentDir, marker.revisionId);
    }
    agents.push(agent);
  }
  for (const agent of agents) {
    if (verifyUnit(input, agent) !== undefined) {
      const unit = unitName(agent.agentId);
      await systemctl("stop", unit);
      await systemctl("disable", unit);
      fs.unlinkSync(join(input.runtime.systemdUnitDirectory, unit));
    }
  }
  await systemctl("daemon-reload");
  fs.rmSync(nsDir, { recursive: true });
  await removeNamespaceRuntimeIdentities(input, agents);
  return {};
}

async function run(input) {
  if (input.operation === "probe") {
    await probe(input.runtime);
    return {};
  }
  const nsDir = namespaceDirectory(input);
  await acquireLock(input.runtime.root);
  try {
    if (input.operation === "delete-namespace" && inspect(nsDir) === undefined) {
      await removeNamespaceRuntimeIdentities(input, []);
      return {};
    }
    if (input.operation === "ensure-namespace") {
      directory(join(input.runtime.root, "namespaces"), true);
      if (inspect(nsDir) === undefined) {
        atomicDirectory(nsDir, (pending) => {
          atomicWrite(join(pending, "namespace.json"), JSON.stringify(ownership(input)));
          fs.mkdirSync(join(pending, "agents"), { mode: 0o755 });
        });
      }
      verifyNamespace(input);
      return {};
    }
    verifyNamespace(input);
    if (input.operation === "delete-namespace") {
      return await removeNamespace(input, nsDir);
    }
    if (input.operation === "prepare-revision") {
      return await prepare(input, nsDir);
    }
    const revision = input.revision;
    const agentDir = join(nsDir, "agents", hash(revision.agentId).slice(0, 12));
    if (
      (input.operation === "stop-revision" || input.operation === "retire-revision") &&
      inspect(agentDir) === undefined
    ) {
      return {};
    }
    const agent = verifyAgent(input, agentDir);
    await verifyRuntimeIdentity(input, agent);
    const current = currentSnapshot(input, agentDir);
    const revisionDir = join(agentDir, "revisions", hash(revision.id).slice(0, 12));
    if (
      (input.operation === "stop-revision" || input.operation === "retire-revision") &&
      inspect(revisionDir) === undefined
    ) {
      return {};
    }
    snapshot(input, agentDir, revision.id, revisionMetadata(input));
    if (input.operation === "verify-revision") {
      return {};
    }
    if (input.operation === "activate-revision") {
      return await activate(input, agentDir, agent, current);
    }
    if (input.operation === "stop-revision" || input.operation === "retire-revision") {
      if (current?.revisionId === revision.id) {
        const unit = unitName(revision.agentId);
        if (verifyUnit(input, agent) !== undefined) {
          await systemctl("stop", unit);
          await systemctl("disable", unit);
        }
        fs.unlinkSync(join(agentDir, "current"));
        fs.rmSync(join(agentDir, "served.json"), { force: true });
      }
      if (input.operation === "stop-revision") {
        return {};
      }
      fs.rmSync(revisionDir, { recursive: true });
      return {};
    }
    throw new ConfigurationFailure("Unknown SSH helper operation.");
  } finally {
    releaseLock();
  }
}

function abandon() {
  child?.kill("SIGTERM");
  releaseLock();
  process.exit(1);
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, abandon);
}

// A cancelled SSH client does not signal this process (no PTY, stdin already
// consumed). The reliable loss signal is a failed write to the closed session
// pipe, so heartbeat every second and stop mutating as soon as one fails.
process.stdout.on("error", abandon);
const heartbeat = setInterval(() => {
  try {
    process.stdout.write("\n");
  } catch {
    abandon();
  }
}, 1_000);

function parseInput() {
  try {
    const input = JSON.parse(Buffer.from(SSH_OPERATION, "base64").toString("utf8"));
    if (Number.isSafeInteger(input.deadlineMs) && input.deadlineMs > 0) {
      return input;
    }
  } catch {
    /* Reported below as invalid input. */
  }
  return undefined;
}

const input = parseInput();
// Enforce a deadline below the transport timeout so a hung host step cannot
// outlive the controller operation that owns it.
const deadline = setTimeout(() => {
  process.stdout.write(`${JSON.stringify({ ok: false, failure: "retryable" })}\n`);
  process.stderr.write("Host operation deadline exceeded.\n");
  abandon();
}, input?.deadlineMs ?? 0);

Promise.resolve()
  .then(() => {
    if (input === undefined) {
      throw new ConfigurationFailure("Invalid helper operation input.");
    }
    return run(input);
  })
  .then((result) => {
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  })
  .catch((error) => {
    let failure = "retryable";
    let message = "SSH host operation failed or timed out.";
    if (error instanceof OwnershipFailure) {
      failure = "ownership";
      message = error.message;
    } else if (error instanceof ConfigurationFailure) {
      failure = "configuration";
      message = error.message;
    }
    process.stdout.write(`${JSON.stringify({ ok: false, failure })}\n`);
    process.stderr.write(`${message.replace(/[\r\n\x00-\x1f\x7f]/g, " ")}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    clearInterval(heartbeat);
    clearTimeout(deadline);
  });
