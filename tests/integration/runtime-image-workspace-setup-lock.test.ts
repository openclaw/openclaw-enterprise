import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { DockerComputeDriver } from "../../apps/controller/src/drivers/compute/docker/index.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import type { AgentRevision, ComputeRevisionContext } from "../../packages/contracts/src/index.ts";
import {
  createHarnessConfiguration,
  withStubbedProviderEndpoint,
} from "../helpers/harness-configuration.mjs";
import { cpuScaledImageTimeoutMs } from "../helpers/image-smoke-timeout.mjs";
import {
  docker,
  image,
  imageTestOptions,
  runDocker,
  runtimeImageModel,
} from "../helpers/runtime-image-startup.mjs";

// A short setup wait for the Driver under test (the internal workspaceSetupWaitMs; the
// default is 120 s). The test holds the setup's start response until native setup is paused
// holding its lock, so this wait starts and ends while the lock is held.
const driverSetupWaitMs = 1_000;
// The Driver's default wait, which bounds the poll-failure attempt below.
const defaultSetupWaitMs = 120_000;
const timeoutMs = cpuScaledImageTimeoutMs(60_000);
// OpenClaw's state lock inside the Agent's retained state volume at the runtime
// image's pin (resolveGatewayLockPaths), for the runtime user 1000.
const stateLock = "/home/node/.openclaw/tmp/openclaw-1000/gateway.state.lock";

// Runs in the setup container as its runtime user and makes native setup slow: once the
// first native run holds the state lock, it stops that run (SIGSTOP: OpenClaw's launcher
// and the CLI it starts) and prints their PIDs. The run stays stopped until the test
// continues it, well within that run's own 120 s bound.
const pauser = String.raw`
const fs = require("node:fs");
const [lock, limit] = process.argv.slice(1);
const deadline = Date.now() + Number(limit);
const timer = setInterval(() => {
  if (fs.existsSync(lock)) {
    clearInterval(timer);
    const pids = fs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)).map(Number)
      .filter((pid) => pid !== 1 && pid !== process.pid);
    for (const pid of pids) {
      try { process.kill(pid, "SIGSTOP"); } catch {}
    }
    console.log("SETUP_PAUSED " + pids.join(","));
  } else if (Date.now() > deadline) {
    clearInterval(timer);
    console.error("WATCHER_TIMEOUT");
    process.exitCode = 1;
  }
}, 1);
`;

// Resolves with the name of this Agent's first workspace setup container to start.
// Docker replays events from `since`, so a start before the stream opens is kept.
function firstSetupStart(t: TestContext, agentId: string): Promise<string> {
  const events = spawn(docker, [
    "events",
    "--since",
    String(Math.floor(Date.now() / 1000) - 1),
    "--filter",
    "type=container",
    "--filter",
    "event=start",
    "--filter",
    `label=org.openclaw.enterprise.agent-id=${agentId}`,
    "--filter",
    "label=org.openclaw.enterprise.role=workspace-setup",
    "--format",
    "{{.Actor.Attributes.name}}",
  ]);
  t.after(() => {
    events.kill();
  });
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error("no workspace setup container started")),
      timeoutMs,
    );
    events.stdout.setEncoding("utf8");
    events.stdout.on("data", (chunk: string) => {
      output += chunk;
      const name = output.split("\n")[0]!;
      if (output.includes("\n") && name.length > 0) {
        clearTimeout(timer);
        resolve(name);
      }
    });
    events.once("error", reject);
  });
}

// The container's state ("running", "exited"), or "removed" once it is gone.
async function setupState(name: string) {
  const { stdout } = await runDocker([
    "container",
    "ls",
    "--all",
    "--filter",
    `name=^/${name}$`,
    "--format",
    "{{.State}}",
  ]);
  return stdout.trim() || "removed";
}

async function lockHeld(name: string) {
  const { stdout } = await runDocker([
    "exec",
    "--user",
    "1000:1000",
    name,
    "node",
    "-e",
    "console.log(require('node:fs').existsSync(process.argv[1]))",
    stateLock,
  ]);
  return stdout.trim() === "true";
}

// The Driver left this setup running, and its native run still holds the state lock.
async function assertSetupHoldsLock(name: string, when: string) {
  assert.equal(await setupState(name), "running", `${when}: the Driver left the running setup`);
  assert.equal(await lockHeld(name), true, `${when}: native setup still holds the state lock`);
}

// Stops the setup's first native run once it holds the state lock and resolves with the
// stopped PIDs.
async function pauseSetupHoldingLock(name: string) {
  const { stdout } = await runDocker(
    ["exec", "--user", "1000:1000", name, "node", "-e", pauser, stateLock, String(timeoutMs)],
    { timeout: timeoutMs + 30_000 },
  );
  const paused = /SETUP_PAUSED ([\d,]+)/.exec(stdout)?.[1];
  assert.ok(paused, stdout);
  return paused;
}

// Wraps the Driver's private Docker API request so that the next request the armed hook
// matches goes through the hook, which may send it to the engine (`send`), delay its
// response or fail it; every other request reaches the engine unchanged.
function interceptRequest(driver: DockerComputeDriver) {
  type Hook = {
    matches: (method: string, path: string) => boolean;
    run: (send: () => Promise<unknown>) => Promise<unknown>;
  };
  const internals = driver as unknown as {
    request: (method: string, path: string, ...rest: unknown[]) => Promise<unknown>;
  };
  const request = internals.request.bind(driver);
  let armed: Hook | undefined;
  internals.request = async (method, path, ...rest) => {
    const hook = armed;
    if (hook === undefined || !hook.matches(method, path)) {
      return request(method, path, ...rest);
    }
    armed = undefined;
    return hook.run(() => request(method, path, ...rest));
  };
  return (hook: Hook) => {
    armed = hook;
  };
}

// The error a Docker request that runs out of time fails with.
function requestTimeout() {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

// The setup container's start request; the setup container is the only one whose name
// ends in "-setup".
function setupStart(method: string, path: string) {
  return method === "POST" && path.endsWith("-setup/start");
}

// Continues the stopped native run and waits for setup to exit 0.
async function resumeSetup(name: string, paused: string) {
  await runDocker([
    "exec",
    "--user",
    "1000:1000",
    name,
    "node",
    "-e",
    "for (const pid of process.argv[1].split(',')) process.kill(Number(pid), 'SIGCONT')",
    paused,
  ]);
  const { stdout: exitCode } = await runDocker(["wait", name], { timeout: timeoutMs });
  assert.equal(exitCode.trim(), "0", "the resumed setup completed");
}

// While setup runs, the next attempt stays unready instead of starting a second setup or a
// Gateway on that state, and leaves setup running with its lock.
async function assertNextAttemptWaits(attempt: Promise<{ ready: boolean }>, name: string) {
  assert.equal((await attempt).ready, false, "the next attempt waits while setup runs");
  await assertSetupHoldsLock(name, "after the next attempt");
}

test(
  "Docker Compute leaves a slow workspace setup its state lock until setup ends",
  { ...imageTestOptions, timeout: defaultSetupWaitMs + 4 * timeoutMs },
  async (t) => {
    // The real Docker Compute Driver on the local engine with the image under test.
    // No model turn runs; the provider endpoint is a stub, so the synthetic key the
    // Driver requires never leaves the host.
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "synthetic-workspace-setup-key";
    t.after(() => {
      if (previousKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousKey;
      }
    });
    const images = { gateway: image!, agent: image! };
    const driver = new DockerComputeDriver({ images, workspaceSetupWaitMs: driverSetupWaitMs });
    const delaySetupStart = interceptRequest(driver);
    // Two more Drivers with the default wait, each of which fails one armed Docker request.
    const pollFailing = new DockerComputeDriver({ images });
    const failPollRequest = interceptRequest(pollFailing);
    const startFailing = new DockerComputeDriver({ images });
    const failStartRequest = interceptRequest(startFailing);
    const createdAt = new Date().toISOString();
    const namespace = {
      id: `ns-setup-lock-${randomUUID()}`,
      name: "Workspace setup lock proof",
      status: "ready" as const,
      createdAt,
    };
    // Docker Compute refuses Harness authentication bindings, so its revisions carry none.
    const revisionAt = (agentId: string, number: number) =>
      ({
        id: `rev-setup-lock-${number}-${randomUUID()}`,
        namespaceId: namespace.id,
        agentId,
        revision: number,
        backendId: null,
        configurationId: `cfg-setup-lock-${randomUUID()}`,
        configurationKind: "agent" as const,
        configurationGeneration: 1,
        gatewayManagedMode: false,
        configuration: admitLoggingConfiguration(
          withStubbedProviderEndpoint(createHarnessConfiguration("openclaw", runtimeImageModel)),
          "info",
        ),
        harness: { id: "openclaw", version: "2026.9.1", mode: "embedded" as const },
        compute: { id: driver.id, implementation: driver.implementation },
        executionAdmission: { version: 2 as const, mode: "unprotected" as const },
        servicePrincipalId: `sp-setup-lock-${randomUUID()}`,
        createdAt,
      }) as Omit<AgentRevision, "harnessAuth"> as AgentRevision;
    // Initial workspace files: the setup container runs native setup with OpenClaw's
    // state on the Agent's retained state volume, which every later Gateway opens.
    const contextFor = (agentId: string): ComputeRevisionContext => ({
      workspaceSetup: {
        id: `setup-${randomUUID()}`,
        namespaceId: namespace.id,
        agentId,
        completed: false,
        files: {
          "AGENTS.md": "# Setup lock proof\n",
          "SOUL.md": "",
          "IDENTITY.md": "",
          "USER.md": "",
        },
      },
      harnessAuth: { method: "runtime" },
      secretEnvironment: [],
    });
    t.after(async () => {
      const result = await driver.deleteNamespace(namespace);
      assert.equal(result.namespaceDeleted, true, "owned containers, volumes and network removed");
    });
    await driver.preflight();
    await pollFailing.preflight();
    await startFailing.preflight();
    assert.equal((await driver.ensureNamespace(namespace)).namespaceReady, true);

    // Native setup outlasts the Driver's wait while it holds the state lock (finding 3109).
    // A stop would SIGKILL it (its PID 1 ignores SIGTERM) and leave the lock to a holder no
    // later container can prove stopped. The Driver leaves it running and reports the
    // revision unready; while it runs, the next attempt stays unready instead of starting a
    // second setup or a Gateway on that state.
    const slowSetup = async () => {
      const agentId = `agent-setup-lock-${randomUUID()}`;
      const context = contextFor(agentId);
      // The Driver's wait starts when the start request returns: Docker starts setup, and
      // the response reaches the Driver once native setup is paused holding the lock.
      const { promise: setupPaused, resolve: releaseStartResponse } = Promise.withResolvers<void>();
      delaySetupStart({
        matches: setupStart,
        run: async (send) => {
          const response = await send();
          await setupPaused;
          return response;
        },
      });
      const first = driver.prepareRevision(revisionAt(agentId, 1), context);
      let name: string;
      let paused: string;
      try {
        name = await firstSetupStart(t, agentId);
        paused = await pauseSetupHoldingLock(name);
      } finally {
        // Also on a failed pause, so the held response never outlives this case.
        releaseStartResponse();
      }
      assert.equal((await first).ready, false, "the attempt waits for the running setup");
      await assertSetupHoldsLock(name, "after the wait");
      await assertNextAttemptWaits(driver.prepareRevision(revisionAt(agentId, 2), context), name);
      await resumeSetup(name, paused);
      // The next attempt reuses the completed setup, and the Gateway takes over the
      // state that setup released.
      assert.equal(
        (await driver.prepareRevision(revisionAt(agentId, 3), context)).ready,
        true,
        "the Gateway must start on the state the finished setup released",
      );
    };

    // A Docker API failure while the Driver polls setup (here one inspect that fails as a
    // request timeout would) fails the attempt but leaves the started setup running with
    // its lock, as the wait's end does (finding 3114).
    const failedPoll = async () => {
      const agentId = `agent-setup-poll-${randomUUID()}`;
      const context = contextFor(agentId);
      const first = assert.rejects(pollFailing.prepareRevision(revisionAt(agentId, 1), context), {
        name: "TimeoutError",
      });
      const name = await firstSetupStart(t, agentId);
      const paused = await pauseSetupHoldingLock(name);
      failPollRequest({
        matches: (method, path) =>
          method === "GET" && path === `/containers/${encodeURIComponent(name)}/json`,
        run: async () => {
          throw requestTimeout();
        },
      });
      await first;
      await assertSetupHoldsLock(name, "after a failed poll");
      await assertNextAttemptWaits(
        pollFailing.prepareRevision(revisionAt(agentId, 2), context),
        name,
      );
      await resumeSetup(name, paused);
    };

    // The start request's response is lost after Docker started setup (here the engine
    // completes the request and the Driver sees a request timeout). The attempt fails, but
    // the Driver inspects the container before removing it and leaves the running setup
    // with its lock (finding 3115).
    const lostStartResponse = async () => {
      const agentId = `agent-setup-start-${randomUUID()}`;
      const context = contextFor(agentId);
      failStartRequest({
        matches: setupStart,
        run: async (send) => {
          await send();
          throw requestTimeout();
        },
      });
      const first = assert.rejects(startFailing.prepareRevision(revisionAt(agentId, 1), context), {
        name: "TimeoutError",
      });
      const name = await firstSetupStart(t, agentId);
      const pause = pauseSetupHoldingLock(name);
      // Settled below; a removed setup fails the state assertion first.
      pause.catch(() => {});
      await first;
      assert.equal(await setupState(name), "running", "a lost start response left the setup");
      const paused = await pause;
      await assertSetupHoldsLock(name, "after a lost start response");
      await assertNextAttemptWaits(
        startFailing.prepareRevision(revisionAt(agentId, 2), context),
        name,
      );
      await resumeSetup(name, paused);
    };

    // Three Agents in one Namespace, side by side. Cleanup waits until every case settles,
    // so a failed case never deletes the Namespace under another case's next Docker step.
    const outcomes = await Promise.allSettled([slowSetup(), failedPoll(), lostStartResponse()]);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        throw outcome.reason;
      }
    }
  },
);
