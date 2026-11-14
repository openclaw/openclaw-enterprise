import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createSshComputeDriver,
  type SshComputeDriver,
  type SshComputeDriverOptions,
  type SshComputeHost,
} from "../../apps/controller/src/drivers/compute/ssh/index.ts";
import type {
  SshCommand,
  SshCommandExecutor,
} from "../../apps/controller/src/drivers/compute/ssh/executor.ts";
import {
  admitLoggingConfiguration,
  type AgentRevision,
  type ComputeAgentBinding,
  type ComputeRevisionContext,
  type Namespace,
  type OpenClawConfigurationDocument,
  type OpenClawConfigurationValue,
} from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { waitFor } from "../helpers/wait-for.mjs";

export const fixtureBin = fileURLToPath(new URL("../fixtures/ssh-compute/bin", import.meta.url));
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const tenant: Namespace = {
  id: "ns-ssh-1",
  name: "stable",
  status: "ready",
  createdAt: "2026-09-05T00:00:00.000Z",
};

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

export function options(): {
  ssh: Mutable<SshComputeDriverOptions["ssh"]>;
  hosts: { stable: Mutable<SshComputeHost> };
  runtime: Mutable<SshComputeDriverOptions["runtime"]>;
  network: { gatewayPortRange: Mutable<SshComputeDriverOptions["network"]["gatewayPortRange"]> };
} {
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

export function revision(
  driver: SshComputeDriver,
  number = 1,
  agentId = "agent-ssh-1",
  configuration: OpenClawConfigurationDocument = {},
): AgentRevision {
  return {
    id: `${agentId}-rev-${number}`,
    namespaceId: tenant.id,
    agentId,
    revision: number,
    gatewayManagedMode: false,
    backendId: null,
    harnessAuth: { method: "runtime" },
    configurationId: `configuration-${agentId}`,
    configurationKind: "agent",
    configurationGeneration: number,
    executionAdmission: { version: 2, mode: "unprotected" },
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
    harness: {
      id: "openclaw",
      version: "2026.7.1",
      mode: "embedded",
      overrides: {},
      configuration: {},
    },
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId: `${agentId}-principal`,
    createdAt: tenant.createdAt,
  };
}

function configurationObject(
  value: OpenClawConfigurationValue | undefined,
): OpenClawConfigurationDocument {
  if (value == null) {
    return {};
  }
  assert.ok(asRecord(value), "the fixture's gateway and auth settings must be objects");
  // A configuration value that is an object and not an array is a configuration document.
  return value as OpenClawConfigurationDocument;
}

export function expectedRuntimeConfiguration(rev: AgentRevision): OpenClawConfigurationDocument {
  const gateway = configurationObject(rev.configuration.gateway);
  const auth = configurationObject(gateway.auth);
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

export function agentBinding(rev: AgentRevision, namespace = tenant): ComputeAgentBinding {
  return {
    namespace,
    agent: {
      id: rev.agentId,
      namespaceId: namespace.id,
      name: rev.agentId,
      configurationId: rev.configurationId,
      backendId: null,
      desiredRuntimeState: "running",
      status: "active",
      harnessAuth: null,
      gatewayManagedMode: false,
      executionMode: "embedded",
      servicePrincipalId: rev.servicePrincipalId,
      createdAt: namespace.createdAt,
    },
  };
}

export function bind(driver: SshComputeDriver, rev: AgentRevision, namespace = tenant) {
  driver.bindAgent(agentBinding(rev, namespace));
}

export function runtimeAccountName(namespace: Namespace, agentId: string, prefix: string) {
  return `${prefix.slice(0, 19)}-${digest(`${namespace.id}:${agentId}`).slice(0, 12)}`;
}

// The fixture owns its gateway port range for its whole life. Reserving free ports,
// releasing them, and letting each fake gateway bind its port later raced every other
// local process, including outgoing connections that take ephemeral ports (finding 1160).
// Instead each port answers as the gateway of the one live unit configured for it, and
// otherwise resets the connection, which the helper treats like a closed port.
async function gatewayPortRange(t: TestContext, units: string, state: string) {
  const portLine = (gatewayPort: number) => `Environment=OPENCLAW_GATEWAY_PORT=${gatewayPort}`;
  async function served(gatewayPort: number) {
    let live = 0;
    for (const name of await readdir(units)) {
      const unit = await readFile(join(units, name), "utf8").catch(() => "");
      if (!unit.split("\n").includes(portLine(gatewayPort))) {
        continue;
      }
      const pid = Number(await readFile(join(state, `${name}.pid`), "utf8").catch(() => ""));
      try {
        // Same liveness rule as the fixture systemctl: kill -0 on the unit's pid.
        if (Number.isSafeInteger(pid) && pid > 0 && process.kill(pid, 0)) {
          live++;
        }
      } catch {
        // ESRCH: the unit's process has exited.
      }
    }
    // Two live units on one port would have failed to bind on a real host. The fixture
    // systemctl already refuses to start the second; this check is a backstop.
    return live === 1;
  }
  // Reserve adjacent loopback ports together so the lowest-free-port assertion is meaningful.
  for (let attempt = 0; attempt < 100; attempt++) {
    const servers: Server[] = [];
    try {
      let start = 0;
      for (let offset = 0; offset < 3; offset++) {
        let gatewayPort = 0;
        const server = createHttpServer(async (request, response) => {
          try {
            if (!(await served(gatewayPort))) {
              request.socket.destroy();
              return;
            }
            const readyz = request.method === "GET" && request.url === "/readyz";
            // Log a fixed line, never request data: the tests assert only readiness probes arrive.
            await appendFile(
              join(state, "readyz.log"),
              `${readyz ? "GET /readyz" : "unexpected"}\n`,
            );
            response.writeHead(readyz ? 200 : 404);
            response.end();
          } catch {
            request.socket.destroy();
          }
        });
        servers.push(server);
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(offset === 0 ? 0 : start + offset, "127.0.0.1", resolve);
        });
        const address = server.address();
        assert.ok(address !== null && typeof address === "object");
        gatewayPort = address.port;
        if (offset === 0) {
          start = gatewayPort;
        }
      }
      t.after(() => Promise.all(servers.map(closeServer)));
      return { start, end: start + 2 };
    } catch {
      // Another local process can hold the adjacent port; try a different ephemeral range.
      await Promise.all(servers.map(closeServer));
    }
  }
  throw new Error("Could not reserve a loopback port range.");
}

function closeServer(server: Server) {
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

// Startup refuses a runtime.root (and Node or OpenClaw path) under /tmp or /var/tmp, which the
// unit's PrivateTmp hides, and tmpdir() is /tmp on CI runners. Fixture hosts live in the
// gitignored test-results directory instead.
const fixtureHosts = fileURLToPath(new URL("../../test-results/ssh-compute/", import.meta.url));

export async function stopFixtureUnits(state: string) {
  // Detached unit processes survive helper exit, as systemd services would.
  for (const name of await readdir(state)) {
    if (!name.endsWith(".pid")) {
      continue;
    }
    const pid = Number(await readFile(join(state, name), "utf8").catch(() => ""));
    // A pid file read between create and write is empty (0): kill(0) would signal
    // this runner's own process group. A removed file reads as empty too.
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      continue;
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (asRecord(error)?.code !== "ESRCH") {
        throw error;
      }
    }
  }
}

export async function fixture(
  t: TestContext,
  selection: Parameters<typeof createSshComputeDriver>[1] = {},
  childPath = process.env.PATH,
) {
  await mkdir(fixtureHosts, { recursive: true });
  const base = await mkdtemp(join(fixtureHosts, "occ-ssh-"));
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
  configured.network.gatewayPortRange = await gatewayPortRange(t, units, state);
  const children: ChildProcessWithoutNullStreams[] = [];
  const calls: SshCommand[] = [];
  const executor: SshCommandExecutor = {
    execute(command) {
      calls.push(command);
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["-"], {
          env: {
            ...process.env,
            PATH: `${fixtureBin}:${childPath}`,
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
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
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
        // Clear the helper child's umask so the permission checks observe every
        // bit the helper requested, including unintended group or other access.
        child.stdin.end(
          `process.umask(0);\nconst SSH_OPERATION = ${JSON.stringify(command.operation)};\n${command.helper}`,
        );
      });
    },
  };
  const driver = createSshComputeDriver(configured, { executor, ...selection });
  t.after(async () => {
    await stopFixtureUnits(state);
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
    // A cancelled helper's flock(1) waiter outlives it and keeps logging attempts into
    // the fixture state until the lock frees. Retry when one lands mid-removal: a failing
    // hook skips later after hooks, such as the one that ends a test's lock holder, whose
    // pipes then keep this file running until its runner timeout.
    await rm(base, { recursive: true, force: true, maxRetries: 10 });
  });
  const nsDir = join(root, "namespaces", digest(tenant.id).slice(0, 12));
  return {
    root,
    units,
    state,
    configured,
    driver,
    children,
    calls,
    nsDir,
    agentDir: (rev: Pick<AgentRevision, "agentId">) =>
      join(nsDir, "agents", digest(rev.agentId).slice(0, 12)),
    revisionDir: (rev: Pick<AgentRevision, "agentId" | "id">) =>
      join(
        nsDir,
        "agents",
        digest(rev.agentId).slice(0, 12),
        "revisions",
        digest(rev.id).slice(0, 12),
      ),
    unit: (rev: Pick<AgentRevision, "agentId">) =>
      `openclaw-enterprise-gateway-${digest(rev.agentId).slice(0, 12)}.service`,
  };
}

// The fixture flock(1) logs each attempt (about 50 ms apart) that finds the host
// lock held, so a test can act while a helper is waiting for the lock.
export function waitForLockWait(f: Pick<SshFixture, "state">, attempts = 1) {
  return waitFor(`the helper to find the host lock held ${attempts} times`, async () => {
    const log = await readFile(join(f.state, "flock-waiting"), "utf8").catch(() => "");
    return log.split("\n").length - 1 >= attempts ? true : undefined;
  });
}

// Hold the host lock exactly as a live helper would: a flock(2) on <root>/.compute-lock
// owned by a child that exits when its stdin closes. Releasing always ends stdin first:
// the sh child inherits the stdio pipes, so killing only its parent would orphan it and
// keep the pipes (and this test process) alive.
export async function holdLock(f: Pick<SshFixture, "root">) {
  const holder = spawn(
    "flock",
    ["-w", "30", join(f.root, ".compute-lock"), "sh", "-c", "printf ok && read -r _"],
    {
      env: { ...process.env, PATH: `${fixtureBin}:${process.env.PATH}` },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  holder.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const exited = new Promise<void>((resolve) => holder.once("exit", () => resolve()));
  await new Promise<void>((resolve, reject) => {
    holder.stdout.setEncoding("utf8").once("data", () => resolve());
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
    release,
    kill: () => {
      release();
      holder.kill("SIGKILL");
    },
    exited,
  };
}

export type SshFixture = Awaited<ReturnType<typeof fixture>>;

export const runtimeContext: ComputeRevisionContext = {
  harnessAuth: { method: "runtime" },
  secretEnvironment: [],
};

// Seed snapshots whose original admission rules are no longer available. The Driver's
// private method is runtime-accessible and must keep its receiver so it uses the real
// command envelope and runs the real helper.
export async function seedHistoricalSnapshot(
  f: SshFixture,
  rev: AgentRevision,
  configuration = rev.configuration,
) {
  type HistoricalPreparation = {
    operation: "prepare-revision";
    namespace: Namespace;
    revision: AgentRevision;
    configurationHash: string;
  };
  const receiver: object = f.driver;
  assert.ok("execute" in receiver && typeof receiver.execute === "function");
  const execute = receiver.execute as (
    this: SshComputeDriver,
    host: SshComputeHost,
    operation: HistoricalPreparation,
  ) => Promise<unknown>;
  await execute.call(f.driver, f.configured.hosts.stable, {
    operation: "prepare-revision",
    namespace: tenant,
    revision: { ...rev, configuration },
    configurationHash: digest(JSON.stringify(configuration)),
  });
}

export async function stage(f: SshFixture, rev = revision(f.driver)) {
  assert.equal((await f.driver.ensureNamespace(tenant)).namespaceReady, true);
  bind(f.driver, rev);
  assert.equal((await f.driver.prepareRevision(rev, runtimeContext)).ready, true);
  return rev;
}

export async function prepare(f: SshFixture, rev = revision(f.driver)) {
  await stage(f, rev);
  await f.driver.activateRevision(rev, runtimeContext);
  return rev;
}

export const parseJson: (text: string) => unknown = JSON.parse;

export async function json(path: string): Promise<unknown> {
  return parseJson(await readFile(path, "utf8"));
}

export function parseRecord(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  assert.ok(record, "the fixture expected a JSON object");
  return record;
}

export async function readRecord(path: string): Promise<Record<string, unknown>> {
  return parseRecord(await json(path));
}
export async function missing(path: string) {
  await assert.rejects(access(path), { code: "ENOENT" });
}

export function fixtureUserId(): number {
  assert.ok(process.getuid);
  return process.getuid();
}

export function fixtureGroupId(): number {
  assert.ok(process.getgid);
  return process.getgid();
}
