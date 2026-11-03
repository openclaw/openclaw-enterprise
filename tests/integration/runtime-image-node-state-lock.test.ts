import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { TestContext } from "node:test";
import {
  AGENT_WITH_NODE_ENTRYPOINT,
  RUNTIME_WRAPPER_COMMAND,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import { followContainer } from "../helpers/docker-follow.mjs";
import { cpuScaledImageTimeoutMs } from "../helpers/image-smoke-timeout.mjs";
import { image, imageTestOptions, runDocker } from "../helpers/runtime-image-startup.mjs";

// Each container stands in for one Harness Pod of a dedicated Agent: the Kubernetes
// container command (tini with the runtime wrapper) runs OCE's whole Harness launcher
// with the packaged OpenClaw. A Docker volume at HOME stands in for the Agent's
// workspace claim, which holds the workspace and the workspace node's state
// (NODE_STATE_PATH in the Kubernetes Compute Driver) for every revision. Each
// container has its own PID namespace, as each Pod has. Native setup and Doctor run
// for real; only the long-lived node and Codex children after setup are replaced.
// This proves the launcher's lock custody, not node enrollment or Kubernetes Pod
// deletion itself.
const home = "/home/node";
const nodeState = `${home}/.openclaw-node`;
const workspace = `${home}/workspace`;
// OpenClaw's state lock inside the node state at the runtime image's pin
// (resolveGatewayLockPaths), for the runtime user 1000.
const stateLock = `${nodeState}/tmp/openclaw-1000/gateway.state.lock`;
const timeoutMs = cpuScaledImageTimeoutMs(60_000);

// Acts on native setup as soon as it holds the state lock. "stop" sends SIGTERM to the
// container's PID 1, as the kubelet does when the Pod is deleted. "pause" stops every
// setup process (SIGSTOP: OpenClaw's launcher and the CLI it starts), so the lock stays
// held by a live process.
const watcher = String.raw`
const fs = require("node:fs");
const [lock, action, limit] = process.argv.slice(1);
const deadline = Date.now() + Number(limit);
const timer = setInterval(() => {
  if (!fs.existsSync(lock)) {
    if (Date.now() > deadline) {
      clearInterval(timer);
      console.error("WATCHER_TIMEOUT");
    }
    return;
  }
  clearInterval(timer);
  if (action === "stop") {
    process.kill(1, "SIGTERM");
    return;
  }
  const paused = [];
  for (const pid of fs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry))) {
    let command;
    try { command = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\0"); }
    catch { continue; }
    if (command.includes("setup") && command.includes("--baseline")) {
      process.kill(Number(pid), "SIGSTOP");
      paused.push(pid);
    }
  }
  console.error(paused.length > 0 ? "SETUP_PAUSED " + paused.join(",") : "SETUP_NOT_FOUND");
}, 1);
`;

function harnessProgram(action?: "stop" | "pause"): string {
  return [
    'const cp = require("node:child_process");',
    "const realSpawn = cp.spawn;",
    'cp.spawn = (command, args, options) => ["doctor", "setup"].includes(args?.[1])',
    "  ? realSpawn(command, args, options)",
    '  : new (require("node:events").EventEmitter)();',
    `require("node:fs").mkdirSync(${JSON.stringify(workspace)}, { recursive: true });`,
    ...(action === undefined
      ? []
      : [
          `realSpawn(process.execPath, ["-e", ${JSON.stringify(watcher)}, ${JSON.stringify(stateLock)}, ${JSON.stringify(action)}, ${JSON.stringify(String(timeoutMs))}], { stdio: "inherit" }).unref();`,
        ]),
    AGENT_WITH_NODE_ENTRYPOINT,
  ].join("\n");
}

type WorkspaceClaim = { volume: string; pods: string[] };

async function startHarnessPod(t: TestContext, claim: WorkspaceClaim, action?: "stop" | "pause") {
  const name = `oce-node-state-lock-${randomUUID()}`;
  claim.pods.push(name);
  await runDocker([
    "run",
    "--detach",
    "--name",
    name,
    "--user",
    "1000:1000",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--network",
    "none",
    "--tmpfs",
    "/tmp:size=64m,mode=1777",
    "--volume",
    `${claim.volume}:${home}`,
    "--env",
    `HOME=${home}`,
    "--env",
    `OPENCLAW_NODE_STATE_DIR=${nodeState}`,
    "--env",
    "OPENCLAW_NODE_SETUP_CODE=synthetic-setup",
    "--env",
    `OPENCLAW_WORKSPACE_DIR=${workspace}`,
    "--env",
    `OPENCLAW_WORKSPACE_BOOTSTRAP=${JSON.stringify({ workspace })}`,
    "--entrypoint",
    RUNTIME_WRAPPER_COMMAND[0]!,
    image!,
    ...RUNTIME_WRAPPER_COMMAND.slice(1),
    ...nodeProgramArguments(harnessProgram(action)),
  ]);
  return { name, follower: followContainer(t, name) };
}

// Waits until `predicate` accepts the Pod's output, failing once the Pod exits without it.
async function waitForOutput(
  pod: { name: string; follower: ReturnType<typeof followContainer> },
  description: string,
  predicate: (output: string, running: boolean) => boolean,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const version = pod.follower.changes.version;
    const observed = pod.follower.read();
    const output = observed.stdout + observed.stderr;
    if (predicate(output, observed.running)) {
      return { output, exitCode: observed.exitCode, running: observed.running };
    }
    const remaining = deadline - Date.now();
    if (!observed.running || remaining <= 0) {
      assert.fail(`${description} (${pod.name}):\n${output.slice(-4000)}`);
    }
    await pod.follower.changes.wait(version, remaining);
  }
}

// The Pod's workspace-baseline startup phase outcomes, in order.
function baselineOutcomes(output: string): string[] {
  return output.split("\n").flatMap((line) => {
    try {
      const event = JSON.parse(line);
      return event.event === "runtime.startup_phase" && event.phase === "workspace-baseline"
        ? [event.outcome]
        : [];
    } catch {
      return [];
    }
  });
}

// One cleanup removes the Pods, then the claim they mount. It is registered before the
// Pods' log followers, whose own cleanup then finds their containers gone.
async function workspaceClaim(t: TestContext): Promise<WorkspaceClaim> {
  const claim: WorkspaceClaim = { volume: `oce-node-state-lock-${randomUUID()}`, pods: [] };
  await runDocker(["volume", "create", claim.volume]);
  t.after(async () => {
    if (claim.pods.length > 0) {
      await runDocker(["rm", "-f", ...claim.pods]);
    }
    await runDocker(["volume", "rm", "-f", claim.volume]);
  });
  return claim;
}

test(
  "a Harness Pod stopped during native setup leaves the node state to the next Pod",
  { ...imageTestOptions, timeout: 4 * timeoutMs + 60_000 },
  async (t) => {
    const claim = await workspaceClaim(t);
    // A revision stopped or superseded while its Harness runs native setup (finding 3104).
    const stopped = await startHarnessPod(t, claim, "stop");
    const stop = await waitForOutput(stopped, "stopped Pod exited", (_, running) => !running);
    // tini reports the stopped wrapper as exit 0, so the Pod ends Succeeded.
    assert.equal(stop.exitCode, 0, stop.output);
    assert.doesNotMatch(stop.output, /WATCHER_TIMEOUT/);
    // The stop landed while setup held the lock, before setup reported its outcome.
    assert.deepEqual(baselineOutcomes(stop.output), [], stop.output);

    // The next revision's Pod starts in another PID namespace on the same claim. Setup
    // there must not meet a lock left by a holder no later process can prove stopped.
    const next = await startHarnessPod(t, claim);
    const started = await waitForOutput(
      next,
      "next Pod finished native setup",
      (output) => baselineOutcomes(output).length > 0,
    );
    assert.deepEqual(baselineOutcomes(started.output), ["ok"], started.output);
    assert.doesNotMatch(started.output, /cannot verify Gateway ownership/);
  },
);

test(
  "a Harness Pod whose native setup still holds the node state keeps the next Pod out",
  { ...imageTestOptions, timeout: 3 * timeoutMs + 60_000 },
  async (t) => {
    const claim = await workspaceClaim(t);
    // A live holder in another Pod: its setup process is paused while it holds the lock.
    const holder = await startHarnessPod(t, claim, "pause");
    await waitForOutput(holder, "setup paused while holding the lock", (output) =>
      /SETUP_PAUSED \d/.test(output),
    );
    // Mutual exclusion stays: the other Pod's setup refuses the state, and the
    // Harness holds the failure instead of starting Codex.
    const other = await startHarnessPod(t, claim);
    const refused = await waitForOutput(
      other,
      "other Pod finished native setup",
      (output) => baselineOutcomes(output).length > 0,
    );
    assert.deepEqual(baselineOutcomes(refused.output), ["failed"], refused.output);
    assert.match(refused.output, /cannot verify Gateway ownership/);
    assert.equal(refused.running, true, refused.output);
  },
);
