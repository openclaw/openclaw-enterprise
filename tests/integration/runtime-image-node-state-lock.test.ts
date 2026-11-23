import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { TestContext } from "node:test";
import {
  AGENT_WITH_NODE_ENTRYPOINT,
  RUNTIME_WRAPPER_COMMAND,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import { followContainer } from "../helpers/docker-follow.ts";
import { cpuScaledImageTimeoutMs } from "../helpers/image-smoke-timeout.ts";
import { runDocker } from "../helpers/runtime-image-docker.ts";
import { image, imageTestOptions } from "../helpers/runtime-image-startup.ts";

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
// A full Doctor pass, which the Harness runs before native setup while maintenance is
// pending: about 30 s on 8 idle CPUs, up to 60 s on 8 loaded ones (52.5 s on a hosted
// runner whose setup budget it used up). It gets its own budget, twice that worst case.
const doctorMs = cpuScaledImageTimeoutMs(120_000);
// Doctor waits this long for a holder it cannot verify ("Waiting up to 95 seconds for the
// previous Gateway to release state") before it gives up on maintenance.
const unverifiableHolderWaitMs = 95_000;

// Acts on the first OpenClaw process that holds the state lock: native setup, or Doctor
// when maintenance is pending. "stop" sends SIGTERM to the container's PID 1, as the
// kubelet does when the Pod is deleted. "pause" stops (SIGSTOP) the process the lock
// names, so the lock stays held by a live process: that is native setup's CLI, which
// retitles itself, not the launcher that started it. It says SETUP_PAUSED only once that
// process is stopped and the lock still names it. "report" only says that the lock is
// taken, for the test to kill the whole container.
const watcher = String.raw`
const fs = require("node:fs");
const [lock, action, limit] = process.argv.slice(1);
const deadline = Date.now() + Number(limit);
const holder = () => {
  try { return JSON.parse(fs.readFileSync(lock, "utf8")).pid; }
  catch { return undefined; }
};
const stopped = (pid) => {
  try {
    const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    return stat[stat.lastIndexOf(")") + 2] === "T";
  } catch { return false; }
};
const pause = (pid) => {
  try { process.kill(pid, "SIGSTOP"); }
  catch { return console.error("SETUP_RELEASED " + pid); }
  const until = Date.now() + 500;
  const check = setInterval(() => {
    if (!stopped(pid) && Date.now() < until) return;
    clearInterval(check);
    const held = stopped(pid) && holder() === pid;
    console.error((held ? "SETUP_PAUSED " : "SETUP_RELEASED ") + pid);
  }, 1);
};
const timer = setInterval(() => {
  const pid = holder();
  if (action === "pause" ? pid === undefined : !fs.existsSync(lock)) {
    if (Date.now() > deadline) {
      clearInterval(timer);
      console.error("WATCHER_TIMEOUT");
    }
    return;
  }
  clearInterval(timer);
  if (action === "pause") {
    pause(pid);
    return;
  }
  if (action === "report") {
    console.error("LOCK_TAKEN");
    return;
  }
  process.kill(1, "SIGTERM");
}, 1);
`;

type LockAction = "stop" | "pause" | "report";
// Maintenance a run left unfinished: the Harness runs Doctor before native setup.
const maintenanceMarker = `${nodeState}/state/.oce-maintenance-pending`;

function harnessProgram(action?: LockAction, maintenance = false): string {
  return [
    'const cp = require("node:child_process");',
    "const realSpawn = cp.spawn;",
    'cp.spawn = (command, args, options) => ["doctor", "setup"].includes(args?.[1])',
    "  ? realSpawn(command, args, options)",
    '  : new (require("node:events").EventEmitter)();',
    `require("node:fs").mkdirSync(${JSON.stringify(workspace)}, { recursive: true });`,
    ...(maintenance
      ? [
          `require("node:fs").mkdirSync(${JSON.stringify(`${nodeState}/state`)}, { recursive: true, mode: 0o700 });`,
          `require("node:fs").writeFileSync(${JSON.stringify(maintenanceMarker)}, "", { mode: 0o600 });`,
        ]
      : []),
    ...(action === undefined
      ? []
      : [
          `realSpawn(process.execPath, ["-e", ${JSON.stringify(watcher)}, ${JSON.stringify(stateLock)}, ${JSON.stringify(action)}, ${JSON.stringify(String(timeoutMs))}], { stdio: "inherit" }).unref();`,
        ]),
    AGENT_WITH_NODE_ENTRYPOINT,
  ].join("\n");
}

type WorkspaceClaim = { volume: string; pods: string[] };

async function startHarnessPod(
  t: TestContext,
  claim: WorkspaceClaim,
  action?: LockAction,
  maintenance = false,
) {
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
    ...nodeProgramArguments(harnessProgram(action, maintenance)),
  ]);
  return { name, follower: followContainer(t, name) };
}

// Waits until `predicate` accepts the Pod's output, failing once the Pod exits without it.
async function waitForOutput(
  pod: { name: string; follower: ReturnType<typeof followContainer> },
  description: string,
  predicate: (output: string, running: boolean) => boolean,
  limitMs = timeoutMs,
) {
  const deadline = Date.now() + limitMs;
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

// The Pod's outcomes of one startup phase, in order.
function phaseOutcomes(output: string, phase: string): string[] {
  return output.split("\n").flatMap((line) => {
    try {
      const event = JSON.parse(line);
      return event.event === "runtime.startup_phase" && event.phase === phase
        ? [event.outcome]
        : [];
    } catch {
      return [];
    }
  });
}
function baselineOutcomes(output: string): string[] {
  return phaseOutcomes(output, "workspace-baseline");
}

// A first Pod initializes the node state on the claim, so a later Pod with pending
// maintenance runs Doctor on state that native setup created. Once setup has finished no
// OpenClaw process holds the lock, so ending the Pod, if its stand-in children have not
// already, leaves none.
async function initializedClaim(t: TestContext) {
  const claim = await workspaceClaim(t);
  const first = await startHarnessPod(t, claim);
  await waitForOutput(first, "first Pod finished native setup", (output) =>
    baselineOutcomes(output).includes("ok"),
  );
  await runDocker(["stop", "--time", "0", first.name]);
  return claim;
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
    const paused = await waitForOutput(holder, "setup paused while holding the lock", (output) =>
      /SETUP_(PAUSED|RELEASED) \d/.test(output),
    );
    assert.match(paused.output, /SETUP_PAUSED \d/);
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

test(
  "a Harness Pod stopped during Doctor leaves the node state to the next Pod",
  { ...imageTestOptions, timeout: 6 * timeoutMs + 60_000 },
  async (t) => {
    const claim = await initializedClaim(t);
    // A revision stopped or superseded while its Harness runs Doctor, as a rolled old
    // revision's Pod does on an upgrade that moves the state schema (finding 3345).
    // OpenClaw's launchers exit about 2 s after the forwarded stop; the Doctor CLI outlives
    // them while it cleans up, and the wrapper waits for it.
    const stopped = await startHarnessPod(t, claim, "stop", true);
    const stop = await waitForOutput(stopped, "stopped Pod exited", (_, running) => !running);
    assert.equal(stop.exitCode, 0, stop.output);
    assert.doesNotMatch(stop.output, /WATCHER_TIMEOUT/);
    assert.deepEqual(phaseOutcomes(stop.output, "state-migration"), [], stop.output);
    assert.doesNotMatch(stop.output, /OpenClaw kept the exited process's state locks/);

    // Its maintenance is still pending, so the next Pod runs Doctor again, in another PID
    // namespace on the same claim, and must not meet a lock no later process can verify.
    // Doctor and then native setup each report their outcome, and each gets its own budget.
    const next = await startHarnessPod(t, claim);
    const migrated = await waitForOutput(
      next,
      "next Pod finished Doctor",
      (output) => phaseOutcomes(output, "state-migration").length > 0,
      doctorMs,
    );
    assert.deepEqual(phaseOutcomes(migrated.output, "state-migration"), ["ok"], migrated.output);
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
  "a Harness Pod killed during Doctor holds the next Pod on the named state lock",
  { ...imageTestOptions, timeout: 6 * timeoutMs + unverifiableHolderWaitMs + 60_000 },
  async (t) => {
    const claim = await initializedClaim(t);
    // The whole Pod is killed while Doctor holds the lock (node loss, a forced delete):
    // nothing in it can release that lock.
    const killed = await startHarnessPod(t, claim, "report", true);
    await waitForOutput(killed, "Doctor took the lock", (output) => /LOCK_TAKEN/.test(output));
    await runDocker(["kill", killed.name]);

    // The next Pod's Doctor refuses the holder it cannot verify stopped. The Harness holds
    // the named check's line with OpenClaw's holders instead of only the failed migration.
    const next = await startHarnessPod(t, claim);
    const held = await waitForOutput(
      next,
      "next Pod held the state lock",
      (output) => /The Harness cannot start/.test(output),
      timeoutMs + unverifiableHolderWaitMs,
    );
    assert.deepEqual(phaseOutcomes(held.output, "state-migration"), ["failed"], held.output);
    assert.match(
      held.output,
      /The Harness cannot start: this container cannot verify that the holder of the workspace node's state lock stopped; .* OpenClaw reported: \S+\/tmp\/openclaw-1000\/state\.[0-9a-f]+\.lock: holder \d+ at [^ ]+\/pid-ns \d+/,
    );
    assert.deepEqual(baselineOutcomes(held.output), [], held.output);
    assert.equal(held.running, true, held.output);
  },
);
