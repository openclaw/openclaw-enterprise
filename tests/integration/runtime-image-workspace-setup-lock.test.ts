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
// default is 120 s), so the wait ends while native setup is paused holding its lock.
const driverSetupWaitMs = cpuScaledImageTimeoutMs(15_000);
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

// Stops this Agent's first native setup run once it holds the state lock and resolves
// with the setup container's name and the stopped PIDs.
async function pauseSetupHoldingLock(t: TestContext, agentId: string) {
  const name = await firstSetupStart(t, agentId);
  const { stdout } = await runDocker(
    ["exec", "--user", "1000:1000", name, "node", "-e", pauser, stateLock, String(timeoutMs)],
    { timeout: timeoutMs + 30_000 },
  );
  const paused = /SETUP_PAUSED ([\d,]+)/.exec(stdout)?.[1];
  assert.ok(paused, stdout);
  return { name, paused };
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
    // A second Driver with the default wait, whose Docker API fails one inspect on request.
    const pollFailing = new DockerComputeDriver({ images });
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
    assert.equal((await driver.ensureNamespace(namespace)).namespaceReady, true);

    // Native setup outlasts the Driver's wait while it holds the state lock (finding 3109).
    // A stop would SIGKILL it (its PID 1 ignores SIGTERM) and leave the lock to a holder no
    // later container can prove stopped. The Driver leaves it running and reports the
    // revision unready; while it runs, the next attempt stays unready instead of starting a
    // second setup or a Gateway on that state.
    const slowSetup = async () => {
      const agentId = `agent-setup-lock-${randomUUID()}`;
      const context = contextFor(agentId);
      const first = driver.prepareRevision(revisionAt(agentId, 1), context);
      const { name, paused } = await pauseSetupHoldingLock(t, agentId);
      assert.equal((await first).ready, false, "the attempt waits for the running setup");
      assert.equal(await setupState(name), "running", "the Driver left the running setup");
      assert.equal(await lockHeld(name), true, "native setup still holds the state lock");
      assert.equal(
        (await driver.prepareRevision(revisionAt(agentId, 2), context)).ready,
        false,
        "the next attempt waits while setup runs",
      );
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
    // request timeout would; every other request reaches the engine) fails the attempt but
    // leaves the started setup running with its lock, as the wait's end does (finding 3114).
    const failedPoll = async () => {
      const agentId = `agent-setup-poll-${randomUUID()}`;
      const context = contextFor(agentId);
      const internals = pollFailing as unknown as {
        request: (method: string, path: string, ...rest: unknown[]) => Promise<unknown>;
      };
      const request = internals.request.bind(pollFailing);
      let failInspectOf: string | undefined;
      internals.request = async (method, path, ...rest) => {
        if (
          failInspectOf !== undefined &&
          method === "GET" &&
          path === `/containers/${failInspectOf}/json`
        ) {
          failInspectOf = undefined;
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        }
        return request(method, path, ...rest);
      };
      const first = assert.rejects(pollFailing.prepareRevision(revisionAt(agentId, 1), context), {
        name: "TimeoutError",
      });
      const { name, paused } = await pauseSetupHoldingLock(t, agentId);
      failInspectOf = encodeURIComponent(name);
      await first;
      assert.equal(await setupState(name), "running", "a failed poll left the running setup");
      assert.equal(await lockHeld(name), true, "native setup still holds the state lock");
      assert.equal(
        (await pollFailing.prepareRevision(revisionAt(agentId, 2), context)).ready,
        false,
        "the next attempt waits while setup runs",
      );
      await resumeSetup(name, paused);
    };

    // Two Agents in one Namespace, side by side.
    await Promise.all([slowSetup(), failedPoll()]);
  },
);
