// Runs the real Driver and host helper. SSH and systemd are replaced by fixtures;
// only tests/integration/ssh-compute-real.test.mjs provides opt-in host proof.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  SshComputeDriver,
  createSshComputeDriver,
} from "../../apps/controller/src/drivers/compute/ssh/index.ts";
import { SystemSshCommandExecutor } from "../../apps/controller/src/drivers/compute/ssh/executor.ts";
import { withComputeAbortSignal } from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const { Check } = require("typebox/value");
const fixtureBin = fileURLToPath(new URL("../fixtures/ssh-compute/bin", import.meta.url));
const digest = (value) => createHash("sha256").update(value).digest("hex");
const tenant = {
  id: "ns-ssh-1",
  name: "stable",
  status: "ready",
  createdAt: "2026-09-05T00:00:00.000Z",
};

function options() {
  return {
    ssh: { identityFile: "/etc/ssh/identity", knownHostsFile: "/etc/ssh/known_hosts" },
    hosts: { stable: { address: "127.0.0.1", user: "root" } },
    runtime: {
      nodePath: process.execPath,
      openclawPath: "/opt/openclaw/current/dist/index.js",
      user: userInfo().username,
      root: "/var/lib/openclaw-enterprise",
    },
    network: { gatewayPortRange: { start: 18800, end: 18899 } },
  };
}

function revision(driver, number = 1, agentId = "agent-ssh-1", configuration = {}) {
  return {
    id: `${agentId}-rev-${number}`,
    namespaceId: tenant.id,
    agentId,
    revision: number,
    providerId: null,
    harnessAuth: { method: "runtime" },
    configurationId: `configuration-${agentId}`,
    configurationKind: "agent",
    configurationGeneration: number,
    configuration: admitLoggingConfiguration(
      {
        gateway: { mode: "local" },
        agents: {
          defaults: {
            skipBootstrap: true,
            model: "openai/gpt-5.6-sol",
            models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } } },
          },
        },
        ...configuration,
      },
      "info",
    ),
    harness: { id: "openclaw", version: "2026.7.1", mode: "embedded" },
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId: `${agentId}-principal`,
    createdAt: tenant.createdAt,
  };
}

function expectedRuntimeConfiguration(rev) {
  const gateway = rev.configuration.gateway ?? {};
  const auth = gateway.auth ?? {};
  if (auth.mode === "trusted-proxy") {
    return rev.configuration;
  }
  return {
    ...rev.configuration,
    gateway: {
      ...gateway,
      auth: {
        ...auth,
        mode: "password",
        password: {
          source: "env",
          provider: "default",
          id: "OPENCLAW_GATEWAY_PASSWORD",
        },
      },
    },
  };
}

function bind(driver, rev, namespace = tenant) {
  driver.bindAgent({
    namespace,
    agent: {
      id: rev.agentId,
      namespaceId: namespace.id,
      name: rev.agentId,
      configurationId: rev.configurationId,
      providerId: null,
      executionMode: "embedded",
      servicePrincipalId: rev.servicePrincipalId,
      createdAt: namespace.createdAt,
    },
  });
}

function runtimeAccountName(namespace, agentId, prefix) {
  return `${prefix.slice(0, 19)}-${digest(`${namespace.id}:${agentId}`).slice(0, 12)}`;
}

async function freePortRange() {
  // Reserve adjacent loopback ports together so the lowest-free-port assertion is meaningful.
  for (let attempt = 0; attempt < 100; attempt++) {
    const servers = [];
    try {
      let start;
      for (let offset = 0; offset < 3; offset++) {
        const server = createServer();
        servers.push(server);
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(offset === 0 ? 0 : start + offset, "127.0.0.1", resolve);
        });
        start ??= server.address().port;
      }
      return { start, end: start + 2 };
    } catch {
      // Another local process can hold the adjacent port; try a different ephemeral range.
    } finally {
      await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    }
  }
  throw new Error("Could not reserve a loopback port range.");
}

async function fixture(t, selection = {}) {
  const base = await mkdtemp(join(tmpdir(), "occ-ssh-"));
  const root = join(base, "root");
  const units = join(base, "units");
  const state = join(base, "fixture");
  await Promise.all([mkdir(root), mkdir(units), mkdir(state)]);
  const configured = options();
  configured.runtime = {
    ...configured.runtime,
    root,
    systemdUnitDirectory: units,
    openclawPath: join(base, "openclaw.cjs"),
  };
  configured.ssh = {
    identityFile: join(base, "identity"),
    knownHostsFile: join(base, "known_hosts"),
  };
  await Promise.all([
    writeFile(configured.runtime.openclawPath, "// readable fixture runtime\n"),
    writeFile(configured.ssh.identityFile, "fixture"),
    writeFile(configured.ssh.knownHostsFile, "fixture"),
  ]);
  configured.network.gatewayPortRange = await freePortRange();
  const children = [];
  const calls = [];
  const executor = {
    execute(command) {
      calls.push(command);
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["-"], {
          env: {
            ...process.env,
            PATH: `${fixtureBin}:${process.env.PATH}`,
            OCC_SSH_FIXTURE_STATE: state,
            OCC_SSH_FIXTURE_UNIT_DIRECTORY: units,
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        children.push(child);
        let stdout = "";
        let stderr = "";
        const terminate = () => child.kill("SIGTERM");
        const timer = setTimeout(terminate, command.timeoutMs);
        command.signal?.addEventListener("abort", terminate, { once: true });
        if (command.signal?.aborted) {
          terminate();
        }
        child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
        child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
        child.on("error", reject);
        child.stdin.on("error", () => {});
        child.on("close", (code) => {
          clearTimeout(timer);
          command.signal?.removeEventListener("abort", terminate);
          if (command.signal?.aborted) {
            reject(new Error("Local helper aborted"));
          } else {
            resolve({ code: code ?? 1, stdout, stderr });
          }
        });
        child.stdin.end(
          `const SSH_OPERATION = ${JSON.stringify(command.operation)};\n${command.helper}`,
        );
      });
    },
  };
  const driver = createSshComputeDriver(configured, { executor, ...selection });
  t.after(async () => {
    // Detached readiness listeners survive helper exit, as systemd services would.
    for (const name of await readdir(state)) {
      if (!name.endsWith(".pid")) {
        continue;
      }
      const pid = Number(await readFile(join(state, name), "utf8"));
      try {
        process.kill(pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") {
          throw error;
        }
      }
    }
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
    await rm(base, { recursive: true, force: true });
  });
  const nsDir = join(root, "namespaces", digest(tenant.id).slice(0, 12));
  return {
    base,
    root,
    units,
    state,
    configured,
    driver,
    children,
    calls,
    nsDir,
    agentDir: (rev) => join(nsDir, "agents", digest(rev.agentId).slice(0, 12)),
    revisionDir: (rev) =>
      join(
        nsDir,
        "agents",
        digest(rev.agentId).slice(0, 12),
        "revisions",
        digest(rev.id).slice(0, 12),
      ),
    unit: (rev) => `openclaw-enterprise-gateway-${digest(rev.agentId).slice(0, 12)}.service`,
  };
}

// Hold the host lock exactly as a live helper would: a flock(2) on <root>/.compute-lock
// owned by a child that exits when its stdin closes. Releasing always ends stdin first:
// the sh child inherits the stdio pipes, so killing only its parent would orphan it and
// keep the pipes (and this test process) alive.
async function holdLock(f) {
  const holder = spawn(
    "flock",
    ["-w", "30", join(f.root, ".compute-lock"), "sh", "-c", "printf ok && read -r _"],
    {
      env: { ...process.env, PATH: `${fixtureBin}:${process.env.PATH}` },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  holder.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => holder.once("exit", resolve));
  await new Promise((resolve, reject) => {
    holder.stdout.setEncoding("utf8").once("data", resolve);
    holder.once("exit", (code, signal) =>
      reject(
        new Error(`lock holder exited before acquiring (${code ?? signal}): ${stderr.trim()}`),
      ),
    );
  });
  const release = () => {
    holder.stdin.end();
  };
  return {
    pid: holder.pid,
    release,
    kill: () => {
      release();
      holder.kill("SIGKILL");
    },
    exited,
  };
}

async function stage(f, rev = revision(f.driver)) {
  assert.equal((await f.driver.ensureNamespace(tenant)).namespaceReady, true);
  bind(f.driver, rev);
  assert.equal((await f.driver.prepareRevision(rev, { secretEnvironment: [] })).ready, true);
  return rev;
}

async function prepare(f, rev = revision(f.driver)) {
  await stage(f, rev);
  await f.driver.activateRevision(rev, { secretEnvironment: [] });
  return rev;
}

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
async function missing(path) {
  await assert.rejects(access(path), { code: "ENOENT" });
}

function setOption(object, keys, value) {
  let target = object;
  for (const key of keys.slice(0, -1)) {
    target = target[key];
  }
  target[keys.at(-1)] = value;
}

test("SSH closed schema and semantic validation reject every invalid option", () => {
  const schema = SshComputeDriver.configurationSchema;
  assert.equal(schema.additionalProperties, false);
  assert.equal(Object.isFrozen(schema.properties.runtime), true);
  assert.equal(Check(schema, options()), true);
  const invalid = [
    [[], null],
    [["executor"], {}],
    [["ssh"], {}],
    [["hosts"], {}],
    [["runtime"], {}],
    [["network"], {}],
    [["ssh", "extra"], true],
    [["hosts", "stable", "extra"], true],
    [["runtime", "extra"], true],
    [["network", "extra"], true],
    [["network", "gatewayPortRange", "extra"], true],
    [["ssh", "connectTimeoutSeconds"], 0],
    [["ssh", "connectTimeoutSeconds"], 1.5],
    [["ssh", "connectTimeoutSeconds"], Number.MAX_SAFE_INTEGER + 1],
    [["hosts", "stable", "address"], ""],
    [["hosts", "stable", "address"], "-oProxyCommand=bad"],
    [["hosts", "stable", "address"], "host;false"],
    [["hosts", "stable", "user"], "nobody"],
    [["hosts", "stable", "port"], 0],
    [["hosts", "stable", "port"], 65536],
    [["hosts", "stable", "port"], 1.2],
    [["runtime", "user"], "root"],
    [["runtime", "user"], "bad user"],
    [["runtime", "user"], ""],
    [["network", "gatewayPortRange", "start"], 1023],
    [["network", "gatewayPortRange", "end"], 65536],
    [["network", "gatewayPortRange", "start"], 1.1],
  ];
  const paths = [
    ["ssh", "identityFile"],
    ["ssh", "knownHostsFile"],
    ["runtime", "nodePath"],
    ["runtime", "openclawPath"],
    ["runtime", "root"],
    ["runtime", "systemdUnitDirectory"],
    ["hosts", "stable", "nodePath"],
    ["hosts", "stable", "openclawPath"],
  ];
  for (const key of paths) {
    for (const value of [
      "relative",
      "",
      "/has space",
      "/quote'",
      '/quote"',
      "/control\n",
      "/control\u0000",
      "/shell$(bad)",
      "/systemd%u",
    ]) {
      invalid.push([key, value]);
    }
  }
  for (const [keys, value] of invalid) {
    let candidate = options();
    if (keys.length === 0) {
      candidate = value;
    } else {
      setOption(candidate, keys, value);
    }
    assert.equal(Check(schema, candidate), false, keys.join("."));
    assert.throws(
      () => SshComputeDriver.validateConfiguration(candidate),
      undefined,
      keys.join("."),
    );
    assert.throws(() => new SshComputeDriver(candidate));
  }
  const reversed = options();
  reversed.network.gatewayPortRange = { start: 2000, end: 1999 };
  assert.throws(
    () => SshComputeDriver.validateConfiguration(reversed),
    /start must not exceed end/,
  );
  const optional = options();
  optional.ssh.connectTimeoutSeconds = 2;
  optional.hosts.stable = {
    address: "::1",
    port: 2222,
    user: "root",
    nodePath: "/usr/bin/node",
    openclawPath: "/opt/openclaw.mjs",
  };
  assert.doesNotThrow(() => new SshComputeDriver(optional));
});

test("SSH preflight probes configured hosts, names failures, and checks local files", async (t) => {
  const f = await fixture(t);
  await f.driver.preflight();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].port, 22);
  assert.equal(f.calls[0].connectTimeoutSeconds, 10);
  assert.equal(JSON.parse(Buffer.from(f.calls[0].operation, "base64")).operation, "probe");
  await rm(f.configured.runtime.openclawPath);
  await assert.rejects(f.driver.preflight(), /host stable \(127\.0\.0\.1\)/);
  await rm(f.configured.ssh.identityFile);
  await assert.rejects(f.driver.preflight(), /identityFile.*existing local file/);
});

test("SSH Namespace preparation creates exact ownership, rejects adoption, and classifies failures", async (t) => {
  const hooks = [];
  const f = await fixture(t, {
    lifecycleDrivers: [
      {
        id: "hooks",
        implementation: "test",
        capability: "configuration",
        computeLifecycleHooks: {
          async afterNamespacePrepared(ns) {
            hooks.push(ns.id);
          },
        },
      },
    ],
  });
  assert.deepEqual(await f.driver.ensureNamespace({ ...tenant, name: "unmapped" }), {
    namespaceId: tenant.id,
    namespaceReady: false,
    failure: "permanent",
  });
  assert.deepEqual(await f.driver.ensureNamespace({ ...tenant, existingNamespace: "adopt" }), {
    namespaceId: tenant.id,
    namespaceReady: false,
    failure: "permanent",
  });
  assert.equal(f.calls.length, 0);
  assert.equal((await f.driver.ensureNamespace(tenant)).namespaceReady, true);
  const marker = join(f.nsDir, "namespace.json");
  assert.deepEqual(await json(marker), {
    driverId: "compute-ssh",
    implementation: "occ/ssh",
    namespaceId: tenant.id,
    namespaceName: tenant.name,
  });
  assert.equal((await stat(marker)).mode & 0o777, 0o600);
  assert.deepEqual(hooks, [tenant.id]);
  assert.throws(() => f.driver.setLifecycleDrivers([]), /cannot change/);
  for (const key of ["driverId", "implementation", "namespaceId", "namespaceName"]) {
    const original = await json(marker);
    await writeFile(marker, JSON.stringify({ ...original, [key]: "foreign" }));
    assert.equal((await f.driver.ensureNamespace(tenant)).failure, "permanent");
    assert.equal((await f.driver.deleteNamespace(tenant)).failure, "permanent");
    assert.equal((await json(marker))[key], "foreign");
    await writeFile(marker, JSON.stringify(original));
  }
  await rm(marker);
  assert.equal((await f.driver.ensureNamespace(tenant)).failure, "permanent");
  await writeFile(
    marker,
    JSON.stringify({
      driverId: "compute-ssh",
      implementation: "occ/ssh",
      namespaceId: tenant.id,
      namespaceName: tenant.name,
    }),
  );
  const unowned = revision(f.driver, 1, "agent-ssh-unowned");
  const account = runtimeAccountName(tenant, unowned.agentId, f.configured.runtime.user);
  await Promise.all([
    mkdir(join(f.state, "accounts", "users"), { recursive: true }),
    mkdir(join(f.state, "accounts", "groups"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(f.state, "accounts", "users", account),
      `${process.getuid()}\n${process.getgid()}\n`,
    ),
    writeFile(join(f.state, "accounts", "groups", account), `${process.getgid()}\n`),
  ]);
  bind(f.driver, unowned);
  await assert.rejects(f.driver.prepareRevision(unowned), /foreign ownership|snapshot/);
  const transport = createSshComputeDriver(options(), {
    executor: {
      execute: async () => {
        throw new Error("transport unavailable");
      },
    },
  });
  assert.equal((await transport.ensureNamespace(tenant)).failure, "retryable");
});

test("SSH embedded revisions stop without deleting snapshots or persistent Agent state", async (t) => {
  const f = await fixture(t);
  const rev = await stage(f);
  const dir = f.agentDir(rev);
  const port = f.configured.network.gatewayPortRange.start;
  const agent = await json(join(dir, "agent.json"));
  assert.equal(agent.port, port);
  assert.equal(agent.servicePrincipalId, rev.servicePrincipalId);
  assert.match(agent.runtimeUser, /^.+-[a-f0-9]{12}$/);
  assert.equal(agent.runtimeGroup, agent.runtimeUser);
  for (const name of ["home", "state"]) {
    const info = await stat(join(dir, name));
    assert.equal(info.mode & 0o777, 0o700);
    assert.equal(info.uid, process.getuid());
  }
  for (const path of [
    join(dir, "agent.json"),
    join(dir, "gateway-password.env"),
    join(f.revisionDir(rev), "revision.json"),
  ]) {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
  // The admitted document is controller-owned and only group-readable by the
  // Agent runtime account, so a live gateway cannot rewrite it and bypass admission.
  const snapshot = await stat(join(f.revisionDir(rev), "openclaw.json"));
  assert.equal(snapshot.mode & 0o777, 0o640);
  assert.equal(snapshot.uid, process.getuid());
  assert.deepEqual(
    await json(join(f.revisionDir(rev), "openclaw.json")),
    expectedRuntimeConfiguration(rev),
  );
  assert.equal(
    (await json(join(f.revisionDir(rev), "revision.json"))).configurationHash,
    digest(JSON.stringify(expectedRuntimeConfiguration(rev))),
  );
  await missing(join(dir, "current"));
  await missing(join(dir, "served.json"));
  await missing(join(f.units, f.unit(rev)));
  await missing(join(f.state, "systemctl.log"));
  // Runtime auth is operator-owned. Even an invalid key must not gate process readiness.
  const operatorEnv = join(dir, "env");
  const operatorContents = "OPENAI_API_KEY=invalid-operator-key\n";
  await writeFile(operatorEnv, operatorContents, { mode: 0o600 });
  const operatorBefore = await stat(operatorEnv);
  await f.driver.activateRevision(rev, { secretEnvironment: [] });
  assert.equal((await stat(join(dir, "served.json"))).mode & 0o777, 0o600);
  assert.deepEqual(await json(join(dir, "served.json")), { revisionId: rev.id });
  assert.equal(await readlink(join(dir, "current")), `revisions/${digest(rev.id).slice(0, 12)}`);
  assert.match(
    await readFile(join(dir, "gateway-password.env"), "utf8"),
    /^OPENCLAW_GATEWAY_PASSWORD=[a-f0-9]{64}\n$/,
  );
  assert.equal(await readFile(operatorEnv, "utf8"), operatorContents);
  assert.equal(
    await readFile(join(f.units, f.unit(rev)), "utf8"),
    `[Unit]
Description=OpenClaw Enterprise gateway ${rev.agentId}
# openclaw-enterprise namespace=${tenant.id} agent=${rev.agentId}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${agent.runtimeUser}
WorkingDirectory=${dir}/state
Environment=HOME=${dir}/home
Environment=OPENCLAW_STATE_DIR=${dir}/state
Environment=OPENCLAW_CONFIG_PATH=${dir}/current/openclaw.json
Environment=OPENCLAW_GATEWAY_PORT=${port}
EnvironmentFile=${dir}/gateway-password.env
EnvironmentFile=-${dir}/env
ExecStart=${process.execPath} ${f.configured.runtime.openclawPath} gateway --port ${port}
Restart=always
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
`,
  );
  assert.match(await readFile(join(f.state, "readyz.log"), "utf8"), /GET \/readyz/);
  await f.driver.activateRevision(rev);
  await f.driver.activateRevision(rev);
  await f.driver.deactivateRevision(rev);
  assert.equal((await f.driver.prepareRevision(rev)).ready, true);
  assert.equal(
    (await readFile(join(f.state, "systemctl.log"), "utf8"))
      .split("\n")
      .filter((line) => line.startsWith("restart ")).length,
    1,
  );
  await writeFile(join(dir, "state", "retained-after-stop"), "persistent");
  await f.driver.stopRevision(rev);
  await f.driver.stopRevision(rev);
  await missing(join(dir, "current"));
  await missing(join(dir, "served.json"));
  assert.equal((await stat(f.revisionDir(rev))).isDirectory(), true);
  assert.equal(await readFile(join(dir, "state", "retained-after-stop"), "utf8"), "persistent");
  await f.driver.activateRevision(rev);
  const replacement = revision(f.driver, 2);
  assert.equal((await f.driver.prepareRevision(replacement)).ready, true);
  await f.driver.activateRevision(replacement);
  await f.driver.retireRevision(rev);
  await f.driver.stopRevision(replacement);
  const operatorAfter = await stat(operatorEnv);
  assert.equal(await readFile(operatorEnv, "utf8"), operatorContents);
  assert.equal(operatorAfter.ino, operatorBefore.ino);
  assert.equal(operatorAfter.mode, operatorBefore.mode);
  assert.equal(operatorAfter.mtimeMs, operatorBefore.mtimeMs);
  assert.ok(
    (await readFile(join(f.state, "readyz.log"), "utf8"))
      .trim()
      .split("\n")
      .every((line) => line === "GET /readyz"),
  );
});

test("SSH trusted-proxy omits gateway.env, and allocation spans Agents and Namespaces on a host", async (t) => {
  const f = await fixture(t);
  const first = await prepare(f);
  const second = revision(f.driver, 1, "agent-ssh-2", {
    gateway: { auth: { mode: "trusted-proxy", trustedProxy: { userHeader: "x-user" } } },
  });
  bind(f.driver, second);
  assert.equal((await f.driver.prepareRevision(second)).ready, true);
  await f.driver.activateRevision(second);
  assert.equal(
    (await json(join(f.agentDir(second), "agent.json"))).port,
    f.configured.network.gatewayPortRange.start + 1,
  );
  assert.notEqual(
    (await json(join(f.agentDir(second), "agent.json"))).runtimeUser,
    (await json(join(f.agentDir(first), "agent.json"))).runtimeUser,
  );
  const secondUnit = await readFile(join(f.units, f.unit(second)), "utf8");
  assert.doesNotMatch(
    secondUnit,
    /EnvironmentFile=.*gateway(?:-password)?\.env|OPENCLAW_GATEWAY_PASSWORD|OPENCLAW_LOG_LEVEL/,
  );
  await missing(join(f.agentDir(second), "gateway.env"));
  await missing(join(f.agentDir(second), "gateway-password.env"));
  assert.equal(
    (await json(join(f.agentDir(first), "agent.json"))).port,
    f.configured.network.gatewayPortRange.start,
  );
  // A second Namespace shares the physical root and must share its port allocation.
  const other = { ...tenant, id: "ns-ssh-other" };
  const third = { ...revision(f.driver, 1, "agent-ssh-3"), namespaceId: other.id };
  assert.equal((await f.driver.ensureNamespace(other)).namespaceReady, true);
  bind(f.driver, third, other);
  assert.equal((await f.driver.prepareRevision(third)).ready, true);
  const otherDir = join(f.root, "namespaces", digest(other.id).slice(0, 12));
  assert.equal(
    (await json(join(otherDir, "agents", digest(third.agentId).slice(0, 12), "agent.json"))).port,
    f.configured.network.gatewayPortRange.start + 2,
  );
  assert.notEqual(
    (await json(join(otherDir, "agents", digest(third.agentId).slice(0, 12), "agent.json")))
      .runtimeGroup,
    (await json(join(f.agentDir(second), "agent.json"))).runtimeGroup,
  );
  const exhausted = revision(f.driver, 1, "agent-ssh-4");
  bind(f.driver, exhausted);
  await assert.rejects(f.driver.prepareRevision(exhausted), /configuration/);
  assert.equal((await f.driver.deleteNamespace(tenant)).namespaceDeleted, true);
  assert.equal((await stat(otherDir)).isDirectory(), true);
  await f.driver.activateRevision(third);
  assert.equal((await f.driver.deleteNamespace(other)).namespaceDeleted, true);
});

test("SSH trusted-proxy can opt into direct loopback password authentication", async (t) => {
  const f = await fixture(t);
  const password = revision(f.driver, 1, "agent-ssh-string-password", {
    gateway: { auth: { password: "${OPENCLAW_GATEWAY_PASSWORD}" } },
  });
  await prepare(f, password);
  assert.match(
    await readFile(join(f.agentDir(password), "gateway-password.env"), "utf8"),
    /^OPENCLAW_GATEWAY_PASSWORD=[a-f0-9]{64}\n$/,
  );
  assert.deepEqual(
    await json(join(f.revisionDir(password), "openclaw.json")),
    expectedRuntimeConfiguration(password),
  );

  const rev = revision(f.driver, 1, "agent-ssh-proxy-password", {
    gateway: {
      auth: {
        mode: "trusted-proxy",
        password: "${OPENCLAW_GATEWAY_PASSWORD}",
        trustedProxy: { userHeader: "x-user" },
      },
    },
  });
  await prepare(f, rev);
  assert.match(
    await readFile(join(f.agentDir(rev), "gateway-password.env"), "utf8"),
    /^OPENCLAW_GATEWAY_PASSWORD=[a-f0-9]{64}\n$/,
  );
  assert.match(
    await readFile(join(f.units, f.unit(rev)), "utf8"),
    new RegExp(`^EnvironmentFile=${join(f.agentDir(rev), "gateway-password.env")}$`, "m"),
  );
  assert.doesNotMatch(await readFile(join(f.units, f.unit(rev)), "utf8"), /gateway\.env/);
  await missing(join(f.agentDir(rev), "gateway.env"));
  assert.deepEqual(await json(join(f.revisionDir(rev), "openclaw.json")), rev.configuration);
});

test("SSH activation invokes lifecycle start hooks and cleans them up after activation failure", async (t) => {
  const hooks = [];
  const f = await fixture(t, {
    lifecycleDrivers: [
      {
        id: "hooks",
        implementation: "test",
        capability: "configuration",
        computeLifecycleHooks: {
          async beforeWorkloadStart(rev, launch) {
            hooks.push(`start:${rev.id}`);
            launch.environment.PLUGIN_TOKEN = "opaque-plugin-token";
          },
          async beforeWorkloadStop(rev) {
            hooks.push(`stop:${rev.id}`);
          },
        },
      },
    ],
  });
  const rev = await stage(f);
  assert.deepEqual(hooks, []);
  await f.driver.activateRevision(rev);
  assert.deepEqual(hooks, [`start:${rev.id}`]);
  assert.match(
    await readFile(join(f.units, f.unit(rev)), "utf8"),
    /^Environment=PLUGIN_TOKEN=opaque-plugin-token$/m,
  );
  await f.driver.retireRevision(rev);
  assert.deepEqual(hooks, [`start:${rev.id}`, `stop:${rev.id}`]);

  const failed = revision(f.driver, 2);
  await stage(f, failed);
  await writeFile(join(f.revisionDir(failed), "revision.json"), JSON.stringify({ broken: true }));
  await assert.rejects(f.driver.activateRevision(failed), /snapshot|ownership/i);
  assert.deepEqual(hooks, [
    `start:${rev.id}`,
    `stop:${rev.id}`,
    `start:${failed.id}`,
    `stop:${failed.id}`,
  ]);

  const beforeInvalidAuth = [...hooks];
  const invalidAuth = revision(f.driver, 3, "agent-ssh-invalid-auth", {
    gateway: { auth: { unsupportedField: true } },
  });
  bind(f.driver, invalidAuth);
  await assert.rejects(
    f.driver.activateRevision(invalidAuth),
    /unsupported field unsupportedField/,
  );
  assert.deepEqual(hooks, beforeInvalidAuth);
});

test("SSH revisions fail closed on unbound identities, unsupported topology, sandbox and Secret delivery", async (t) => {
  const f = await fixture(t);
  const rev = revision(f.driver);
  await assert.rejects(f.driver.prepareRevision(rev), /bound Namespace and Agent/);
  await f.driver.ensureNamespace(tenant);
  bind(f.driver, rev);
  for (const harnessAuth of [
    undefined,
    { method: "api_key" },
    { method: "chatgpt_service_account" },
    { method: "runtime", source: {} },
  ]) {
    await assert.rejects(f.driver.prepareRevision({ ...rev, harnessAuth }), /operator-managed/);
  }
  for (const harness of [
    { id: "codex", mode: "dedicated" },
    { id: "openclaw", mode: "dedicated" },
    { id: "other", mode: "embedded" },
  ]) {
    await assert.rejects(
      f.driver.prepareRevision({ ...rev, harness: { version: "1", ...harness } }),
      /only embedded OpenClaw/,
    );
  }
  await assert.rejects(
    f.driver.prepareRevision(rev, { secretEnvironment: [{ name: "MODEL_KEY" }] }),
    /operator-owned.*env/,
  );
  await assert.rejects(
    f.driver.prepareRevision({
      ...rev,
      secretBindings: {
        MODEL_KEY: { source: { kind: "secret", id: "secret-1", namespaceId: tenant.id } },
      },
    }),
    /operator-owned.*env/,
  );
  await assert.rejects(
    f.driver.prepareRevision({ ...rev, sandboxDriverId: "sandbox" }),
    /SandboxDriver/,
  );
  await assert.rejects(
    f.driver.prepareRevision({
      ...rev,
      plugins: {
        driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
        plugins: { "occ-plugin:diffs": { enabled: true, approvalMode: "always" } },
      },
    }),
    /PluginDriver installation/,
  );
  for (const configuration of [
    { gateway: { auth: { mode: "oauth" } } },
    { gateway: { auth: { unsupportedField: true } } },
    { gateway: { auth: { password: "plaintext" } } },
  ]) {
    await assert.rejects(
      f.driver.prepareRevision({
        ...rev,
        configuration: admitLoggingConfiguration(configuration, "info"),
      }),
      /gateway authentication|OPENCLAW_GATEWAY_PASSWORD/,
    );
  }
  for (const change of [
    { servicePrincipalId: "foreign" },
    { namespaceId: "foreign" },
    { compute: { id: "foreign", implementation: "occ/ssh" } },
  ]) {
    await assert.rejects(f.driver.prepareRevision({ ...rev, ...change }));
  }
  await missing(f.agentDir(rev));
});

test("SSH rejects foreign Agent, revision and unit ownership without mutating them", async (t) => {
  const f = await fixture(t);
  const rev = await prepare(f);
  const files = [
    [join(f.agentDir(rev), "agent.json"), "servicePrincipalId"],
    [join(f.revisionDir(rev), "revision.json"), "revisionId"],
    [join(f.revisionDir(rev), "revision.json"), "configurationHash"],
  ];
  for (const [path, key] of files) {
    const original = await readFile(path, "utf8");
    const foreign = JSON.stringify({ ...JSON.parse(original), [key]: "foreign" });
    await writeFile(path, foreign);
    await assert.rejects(f.driver.prepareRevision(rev), /ownership|snapshot/);
    await assert.rejects(f.driver.retireRevision(rev), /ownership|snapshot/);
    await assert.rejects(f.driver.stopRevision(rev), /ownership|snapshot/);
    assert.equal((await f.driver.deleteNamespace(tenant)).failure, "permanent");
    assert.equal(await readFile(path, "utf8"), foreign);
    await writeFile(path, original);
  }
  const unit = join(f.units, f.unit(rev));
  const originalUnit = await readFile(unit, "utf8");
  await writeFile(unit, "[Unit]\nDescription=foreign\n");
  const log = await readFile(join(f.state, "systemctl.log"), "utf8");
  await assert.rejects(f.driver.prepareRevision(rev), /ownership/);
  assert.equal((await f.driver.deleteNamespace(tenant)).failure, "permanent");
  assert.equal(await readFile(unit, "utf8"), "[Unit]\nDescription=foreign\n");
  assert.equal(await readFile(join(f.state, "systemctl.log"), "utf8"), log);
  await writeFile(unit, originalUnit);
  const agent = await json(join(f.agentDir(rev), "agent.json"));
  const account = join(f.root, "accounts", `${agent.runtimeUser}.json`);
  const originalAccount = await json(account);
  await writeFile(account, JSON.stringify({ ...originalAccount, uid: originalAccount.uid + 1 }));
  await assert.rejects(f.driver.activateRevision(rev), /foreign ownership|snapshot/);
  assert.equal((await f.driver.deleteNamespace(tenant)).failure, "permanent");
  assert.equal(await readFile(join(f.state, "systemctl.log"), "utf8"), log);
});

test("SSH immutable snapshots, supersession, cutover, retirement and deletion preserve exact ownership", async (t) => {
  const hooks = [];
  const f = await fixture(t, {
    lifecycleDrivers: [
      {
        id: "hooks",
        implementation: "test",
        capability: "configuration",
        computeLifecycleHooks: {
          async beforeWorkloadStop(rev) {
            hooks.push(`retire:${rev.id}`);
          },
          async beforeNamespaceDelete(ns) {
            hooks.push(`delete:${ns.id}`);
          },
        },
      },
    ],
  });
  const first = await prepare(f);
  const dir = f.agentDir(first);
  await writeFile(join(dir, "state", "persisted"), "state survives");
  await writeFile(join(dir, "env"), "OPERATOR_OWNED=unchanged\n", { mode: 0o600 });
  await assert.rejects(
    f.driver.prepareRevision({
      ...first,
      configuration: admitLoggingConfiguration(
        { agents: { defaults: { skipBootstrap: false } } },
        "info",
      ),
    }),
    /snapshot mismatch/,
  );
  const second = revision(f.driver, 2);
  assert.equal((await f.driver.prepareRevision(second)).ready, true);
  const log = await readFile(join(f.state, "systemctl.log"), "utf8");
  assert.equal((await f.driver.prepareRevision(first)).ready, true);
  assert.equal(await readFile(join(f.state, "systemctl.log"), "utf8"), log);
  assert.equal(await readFile(join(dir, "state", "persisted"), "utf8"), "state survives");
  await f.driver.activateRevision(second);
  await assert.rejects(f.driver.activateRevision(first), /ownership/);
  await f.driver.retireRevision(first);
  await f.driver.retireRevision(first);
  await missing(f.revisionDir(first));
  assert.equal((await stat(f.revisionDir(second))).isDirectory(), true);
  assert.equal(await readFile(join(dir, "env"), "utf8"), "OPERATOR_OWNED=unchanged\n");
  // A superseded candidate whose snapshot was retired must not recreate it.
  assert.equal((await f.driver.prepareRevision(first)).ready, false);
  await missing(f.revisionDir(first));
  await f.driver.retireRevision(second);
  await missing(join(dir, "current"));
  await missing(f.revisionDir(second));
  assert.equal(await readFile(join(dir, "state", "persisted"), "utf8"), "state survives");
  await writeFile(join(f.state, "groupdel.fail"), "once");
  assert.deepEqual(await f.driver.deleteNamespace(tenant), {
    namespaceId: tenant.id,
    namespaceDeleted: false,
    failure: "retryable",
  });
  await missing(f.nsDir);
  assert.equal((await f.driver.deleteNamespace(tenant)).namespaceDeleted, true);
  assert.deepEqual(await readdir(join(f.root, "accounts")), []);
  assert.equal((await f.driver.deleteNamespace(tenant)).namespaceDeleted, true);
  await missing(f.nsDir);
  await missing(join(f.units, f.unit(first)));
  await missing(join(f.state, `${f.unit(first)}.enabled`));
  await missing(join(f.state, `${f.unit(first)}.pid`));
  assert.ok(hooks.includes(`retire:${first.id}`));
  assert.ok(hooks.includes(`delete:${tenant.id}`));
  const commands = await readFile(join(f.state, "systemctl.log"), "utf8");
  assert.match(commands, /stop openclaw-enterprise-gateway-/);
  assert.match(commands, /disable openclaw-enterprise-gateway-/);
});

test("SSH local executor cancellation terminates the real helper waiting for the host lock", async (t) => {
  const f = await fixture(t);
  // Simulate a live concurrent host operation; this tests manual cancellation, not lease loss.
  const held = await holdLock(f);
  t.after(() => held.kill());
  const controller = new AbortController();
  const pending = withComputeAbortSignal(controller.signal, () => f.driver.ensureNamespace(tenant));
  while (f.children.length === 0) {
    await delay(10);
  }
  await delay(100);
  controller.abort();
  assert.equal((await pending).failure, "retryable");
  assert.notEqual(f.children[0].signalCode ?? f.children[0].exitCode, null);
  await missing(f.nsDir);
});

test("SSH activation repairs an interrupted cutover instead of accepting an unserved pointer", async (t) => {
  const f = await fixture(t);
  const first = await prepare(f);
  const second = revision(f.driver, 2);
  assert.equal((await f.driver.prepareRevision(second)).ready, true);
  const dir = f.agentDir(first);
  const restarts = async () =>
    (await readFile(join(f.state, "systemctl.log"), "utf8"))
      .split("\n")
      .filter((line) => line.startsWith("restart ")).length;
  const before = await restarts();
  assert.equal(await readlink(join(dir, "current")), `revisions/${digest(first.id).slice(0, 12)}`);
  assert.deepEqual(await json(join(dir, "served.json")), { revisionId: first.id });
  // Simulate a helper that died between replacing `current` and `systemctl restart`.
  await rm(join(dir, "current"));
  await symlink(`revisions/${digest(second.id).slice(0, 12)}`, join(dir, "current"));
  await f.driver.activateRevision(second);
  assert.equal(await restarts(), before + 1);
  assert.deepEqual(await json(join(dir, "served.json")), { revisionId: second.id });
  await f.driver.retireRevision(second);
  await missing(join(dir, "served.json"));
});

test("SSH helper stops mutating when its session pipe closes, without any signal", async (t) => {
  const f = await fixture(t);
  // The real transport cannot signal the remote helper; sshd only closes its pipes.
  const held = await holdLock(f);
  t.after(() => held.kill());
  const pending = f.driver.ensureNamespace(tenant);
  while (f.children.length === 0) {
    await delay(10);
  }
  const child = f.children[0];
  await delay(100);
  child.stdout.destroy();
  const started = Date.now();
  assert.equal((await pending).failure, "retryable");
  assert.notEqual(child.signalCode ?? child.exitCode, null);
  assert.ok(Date.now() - started < 5_000, "helper must exit on the next heartbeat write");
  await missing(f.nsDir);
  held.release();
  await held.exited;
  assert.equal((await f.driver.ensureNamespace(tenant)).namespaceReady, true);
});

test("SSH host lock excludes concurrent helpers and is released by the kernel when a holder dies", async (t) => {
  const f = await fixture(t);
  const held = await holdLock(f);
  t.after(() => held.kill());
  const pending = f.driver.ensureNamespace(tenant);
  while (f.children.length === 0) {
    await delay(10);
  }
  // While another helper holds the lock, this one must wait without mutating the host.
  await delay(1_500);
  await missing(f.nsDir);
  assert.equal(f.children[0].exitCode, null);
  // A holder killed without any cleanup (SIGKILL) releases the flock through the kernel;
  // the waiting helper proceeds immediately instead of waiting out a stale-lock deadline.
  held.kill();
  await held.exited;
  const released = Date.now();
  assert.equal((await pending).namespaceReady, true);
  assert.ok(Date.now() - released < 5_000, "kernel lock release must unblock the waiter");
  assert.equal((await stat(join(f.root, ".compute-lock"))).isFile(), true);
});

test("SSH setup failures withhold activation, preserve private input, and reject foreign workspaces", async (t) => {
  for (const scenario of [
    "foreign Agent",
    "foreign workspace",
    "unsupported roster",
    "native failure",
  ]) {
    await t.test(scenario, async (t) => {
      const f = await fixture(t);
      assert.equal((await f.driver.ensureNamespace(tenant)).namespaceReady, true);
      const configuration =
        scenario === "foreign workspace"
          ? { agents: { defaults: { workspace: "/tmp/foreign-workspace" } } }
          : scenario === "unsupported roster"
            ? { agents: { entries: { helper: {} } } }
            : {};
      const first = revision(f.driver, 1, "agent-ssh-setup", configuration);
      bind(f.driver, first);
      const content = "private-setup-content-must-not-leak";
      const context = {
        secretEnvironment: [],
        harnessAuth: { method: "runtime" },
        workspaceSetup: {
          id: "setup-ssh",
          namespaceId: tenant.id,
          agentId: scenario === "foreign Agent" ? "another-agent" : first.agentId,
          files: { "AGENTS.md": content },
          completed: false,
        },
      };
      assert.equal(f.driver.supportsWorkspaceSetup, true);
      await assert.rejects(f.driver.prepareRevision(first, context), (error) => {
        assert.equal(error.message.includes(content), false);
        return /SSH/.test(error.message);
      });
      await missing(join(f.agentDir(first), "workspace-setup.json"));
      await missing(join(f.agentDir(first), "current"));
      await missing(join(f.units, f.unit(first)));
      const snapshot = await readFile(join(f.revisionDir(first), "openclaw.json"), "utf8");
      assert.equal(snapshot.includes(content), false);
      const marker = await readFile(join(f.revisionDir(first), "revision.json"), "utf8");
      assert.equal(marker.includes(content), false);
    });
  }
});

test("system SSH executor sends exact argv and stdin and bounds cancellation and timeout", async (t) => {
  const f = await fixture(t);
  const bin = join(f.base, "bin");
  await mkdir(bin);
  // Transport-only stand-in records argv and runs the unchanged stdin program with Node.
  const ssh = join(bin, "ssh");
  await writeFile(
    ssh,
    `#!${process.execPath}\nconst fs = require('node:fs');\nconst { spawn } = require('node:child_process');\nfs.writeFileSync(${JSON.stringify(join(f.base, "argv.json"))}, JSON.stringify(process.argv.slice(2)));\nconst child = spawn(process.execPath, ['-'], { stdio: 'inherit' });\nprocess.on('SIGTERM', () => child.kill('SIGTERM'));\nchild.on('exit', (code) => process.exit(code ?? 1));\n`,
  );
  await chmod(ssh, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  t.after(() => {
    process.env.PATH = previousPath;
  });
  const executor = new SystemSshCommandExecutor();
  const command = {
    address: "127.0.0.1",
    port: 2222,
    user: "root",
    nodePath: "/usr/bin/node",
    identityFile: "/keys/id",
    knownHostsFile: "/keys/known_hosts",
    connectTimeoutSeconds: 7,
    helper: 'process.stdout.write(JSON.stringify({value: SSH_OPERATION}) + "\\n");',
    operation: "e30=",
    timeoutMs: 5000,
  };
  assert.deepEqual(await executor.execute(command), {
    code: 0,
    stdout: '{"value":"e30="}\n',
    stderr: "",
  });
  assert.deepEqual(await json(join(f.base, "argv.json")), [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "UserKnownHostsFile=/keys/known_hosts",
    "-o",
    "IdentitiesOnly=yes",
    "-i",
    "/keys/id",
    "-o",
    "ConnectTimeout=7",
    "-o",
    "LogLevel=ERROR",
    "-p",
    "2222",
    "-l",
    "root",
    "127.0.0.1",
    "--",
    "/usr/bin/node",
    "-",
  ]);
  const pidFile = join(f.base, "helper.pid");
  const waiting = {
    ...command,
    helper: `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
  };
  const controller = new AbortController();
  const pending = assert.rejects(
    withComputeAbortSignal(controller.signal, () => executor.execute(waiting)),
    /cancelled or timed out/,
  );
  for (let attempts = 0; attempts < 100; attempts++) {
    try {
      await access(pidFile);
      break;
    } catch {
      await delay(10);
    }
  }
  const pid = Number(await readFile(pidFile, "utf8"));
  controller.abort();
  await pending;
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await assert.rejects(executor.execute({ ...waiting, timeoutMs: 100 }), /cancelled or timed out/);
});
