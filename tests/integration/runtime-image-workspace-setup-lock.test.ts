import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { DockerComputeDriver } from "../../apps/controller/src/drivers/compute/docker/index.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
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

// The Docker Compute Driver waits 120 s for its workspace setup container
// (STARTUP_TIMEOUT_MS in the Driver).
const driverSetupWaitMs = 120_000;
const timeoutMs = cpuScaledImageTimeoutMs(60_000);
// The first native run takes this long, so the second still holds the lock when
// the Driver's wait ends, well within that run's own 120 s bound.
const slowFirstRunMs = driverSetupWaitMs - 30_000;
// OpenClaw's state lock inside the Agent's retained state volume at the runtime
// image's pin (resolveGatewayLockPaths), for the runtime user 1000.
const stateLock = "/home/node/.openclaw/tmp/openclaw-1000/gateway.state.lock";

// Runs in the setup container as its runtime user and makes native setup slow.
// Setup runs OpenClaw's native setup twice, each run bounded by its own 120 s
// timeout. The first run stops (SIGSTOP: OpenClaw's launcher and the CLI it starts)
// once it holds the state lock and continues after `slow` ms. The second run stops
// once it holds the lock and stays stopped, so a live setup holds the lock when the
// Driver's wait ends, within each run's own bound.
const pauser = String.raw`
const fs = require("node:fs");
const [lock, slow, limit] = process.argv.slice(1);
const started = Date.now();
const deadline = started + Number(limit);
const pause = () => {
  const pids = fs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)).map(Number)
    .filter((pid) => pid !== 1 && pid !== process.pid);
  for (const pid of pids) {
    try { process.kill(pid, "SIGSTOP"); } catch {}
  }
  return pids;
};
let phase = "first";
const timer = setInterval(() => {
  const held = fs.existsSync(lock);
  if (phase === "first" && held) {
    phase = "slow";
    const pids = pause();
    setTimeout(() => {
      for (const pid of pids) {
        try { process.kill(pid, "SIGCONT"); } catch {}
      }
      phase = "released";
    }, Math.max(0, started + Number(slow) - Date.now()));
  } else if (phase === "released" && !held) {
    phase = "second";
  } else if (phase === "second" && held) {
    clearInterval(timer);
    console.log("SETUP_PAUSED " + pause().join(","));
  } else if (Date.now() > deadline) {
    clearInterval(timer);
    console.error("WATCHER_TIMEOUT " + phase);
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

test(
  "Docker Compute leaves a slow workspace setup its state lock until setup ends",
  { ...imageTestOptions, timeout: driverSetupWaitMs + 4 * timeoutMs },
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
    const driver = new DockerComputeDriver({ images: { gateway: image!, agent: image! } });
    const createdAt = new Date().toISOString();
    const namespace = {
      id: `ns-setup-lock-${randomUUID()}`,
      name: "Workspace setup lock proof",
      status: "ready" as const,
      createdAt,
    };
    const agentId = `agent-setup-lock-${randomUUID()}`;
    const revisionAt = (number: number) => ({
      id: `rev-setup-lock-${number}-${randomUUID()}`,
      namespaceId: namespace.id,
      agentId,
      revision: number,
      configurationId: `cfg-setup-lock-${randomUUID()}`,
      configurationKind: "agent" as const,
      configurationGeneration: 1,
      configuration: admitLoggingConfiguration(
        withStubbedProviderEndpoint(createHarnessConfiguration("openclaw", runtimeImageModel)),
        "info",
      ),
      harness: { id: "openclaw", version: "2026.9.1", mode: "embedded" as const },
      compute: { id: driver.id, implementation: driver.implementation },
      executionAdmission: { version: 2 as const, mode: "unprotected" as const },
      servicePrincipalId: `sp-setup-lock-${randomUUID()}`,
      createdAt,
    });
    // Initial workspace files: the setup container runs native setup with OpenClaw's
    // state on the Agent's retained state volume, which every later Gateway opens.
    const setup = {
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
    };
    t.after(async () => {
      const result = await driver.deleteNamespace(namespace);
      assert.equal(result.namespaceDeleted, true, "owned containers, volumes and network removed");
    });
    await driver.preflight();
    assert.equal((await driver.ensureNamespace(namespace)).namespaceReady, true);

    // Native setup is slow: it holds the state lock past the Driver's wait (finding 3109).
    const started = firstSetupStart(t, agentId);
    const first = assert.rejects(
      driver.prepareRevision(revisionAt(1), { workspaceSetup: setup }),
      /Workspace initialization timed out/,
    );
    const name = await started;
    const { stdout: pausedOutput } = await runDocker(
      [
        "exec",
        "--user",
        "1000:1000",
        name,
        "node",
        "-e",
        pauser,
        stateLock,
        String(slowFirstRunMs),
        String(driverSetupWaitMs + timeoutMs),
      ],
      { timeout: driverSetupWaitMs + timeoutMs + 30_000 },
    );
    const paused = /SETUP_PAUSED ([\d,]+)/.exec(pausedOutput)?.[1];
    assert.ok(paused, pausedOutput);
    await first;

    // The setup still runs and holds the lock: a stop would SIGKILL it (its PID 1
    // ignores SIGTERM) and leave the lock to a holder no later container can prove
    // stopped. While it runs, the next attempt refuses instead of starting a second
    // setup or a Gateway on that state.
    assert.equal(await setupState(name), "running", "the Driver left the running setup");
    assert.equal(await lockHeld(name), true, "native setup still holds the state lock");
    await assert.rejects(
      driver.prepareRevision(revisionAt(2), { workspaceSetup: setup }),
      /Workspace initialization is already running/,
    );

    // Setup resumes, finishes and releases the lock.
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

    // The next attempt reuses the completed setup, and the Gateway takes over the
    // state that setup released.
    assert.equal(
      (await driver.prepareRevision(revisionAt(3), { workspaceSetup: setup })).ready,
      true,
      "the Gateway must start on the state the finished setup released",
    );
  },
);
