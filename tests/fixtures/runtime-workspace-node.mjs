import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
const cli = "/app/openclaw.mjs";
const commands = [
  "file.fetch",
  "file.stat",
  "file.write",
  "file.create",
  "dir.list",
  "workspace.memory",
  "workspace.skills",
].sort();
const state = "/home/node/workspace-node";
const config = `${state}/openclaw.json`;
await mkdir(state, { recursive: true, mode: 0o700 });
await writeFile(
  config,
  JSON.stringify({
    agents: { defaults: { workspace: "/home/node/workspace" } },
    plugins: {
      allow: ["file-transfer"],
      slots: { memory: "none" },
      entries: { "file-transfer": { enabled: true } },
    },
  }),
  { mode: 0o600 },
);
// One deadline, set by the test from its own exec timeout, bounds the whole proof.
// Each CLI call and wait may use what is left of it. A `gateway call` boots the
// OpenClaw CLI beside the Gateway and the node's own boot, and on a CPU-contended CI
// runner one took over its former fixed 30 s (finding 2673). A hang still fails
// before the test's exec timeout, naming the call.
const budgetMs = Number(process.env.WORKSPACE_PROOF_BUDGET_MS);
assert.ok(Number.isSafeInteger(budgetMs) && budgetMs > 0, "WORKSPACE_PROOF_BUDGET_MS is required.");
const deadline = Date.now() + budgetMs;
let slowestCallMs = 0;
function remainingMs(step) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error(`The workspace node proof used its ${budgetMs} ms before ${step}.`);
  }
  return remaining;
}
const nodeEnvironment = {
  PATH: process.env.PATH,
  HOME: "/home/node",
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: config,
};
await execute(
  process.execPath,
  [cli, "setup", "--baseline", "--workspace", "/home/node/workspace", "--json"],
  {
    env: nodeEnvironment,
    timeout: remainingMs("setup"),
  },
);
async function call(method, params = {}) {
  const startedAt = Date.now();
  const timeout = remainingMs(method);
  const { stdout } = await execute(
    process.execPath,
    [
      cli,
      "gateway",
      "call",
      method,
      "--url",
      "ws://127.0.0.1:8080",
      "--password",
      process.env.OPENCLAW_GATEWAY_PASSWORD,
      "--params",
      JSON.stringify(params),
      "--json",
    ],
    { timeout, maxBuffer: 1_000_000 },
  ).catch((error) => {
    if (error.killed) {
      throw new Error(`gateway call ${method} did not return within the ${timeout} ms left.`, {
        cause: error,
      });
    }
    throw error;
  });
  slowestCallMs = Math.max(slowestCallMs, Date.now() - startedAt);
  return JSON.parse(stdout);
}
const setup = await call("device.pair.setupCode", {
  publicUrl: "ws://127.0.0.1:8080",
  bootstrapProfile: "node",
  includeQr: false,
});
let child;
let childLog = "";
async function stop() {
  if (!child || child.exitCode !== null) {
    return;
  }
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const killTimer = globalThis.setTimeout(() => child.kill("SIGKILL"), 5_000);
  await exited;
  clearTimeout(killTimer);
}
async function waitForDisconnect(nodeId) {
  while (Date.now() < deadline) {
    const result = await call("node.list");
    if (!result.nodes.some((item) => item.nodeId === nodeId && item.connected)) {
      return;
    }
    await setTimeout(500);
  }
  throw new Error("Stopped workspace node remained connected.");
}
// The Gateway lists the node before it finishes the setup handoff (registered, then
// delivery-uncertain, hello-ok, confirmed), so wait for the confirmation.
async function waitForConfirmedSetup(nodeId) {
  let status;
  while (Date.now() < deadline) {
    status = await call("device.pair.setupStatus", { setupId: setup.setupId });
    if (status.completion) {
      assert.equal(status.completion.deviceId, nodeId);
      return status.completion;
    }
    if (status.deliveryUncertain) {
      assert.equal(status.deliveryUncertain.deviceId, nodeId);
    }
    await setTimeout(500);
  }
  throw new Error(`Setup completion was never confirmed: ${JSON.stringify(status)}`);
}
async function waitForNode(expectedId) {
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Node exited: ${childLog}`);
    }
    const result = await call("node.list");
    const node = result.nodes.find(
      (item) => item.connected && item.displayName === "runtime-workspace-proof",
    );
    if (node) {
      assert.deepEqual(node.commands.toSorted(), commands);
      if (expectedId) {
        assert.equal(node.nodeId, expectedId);
      }
      return node.nodeId;
    }
    await setTimeout(500);
  }
  throw new Error(`Restricted node did not connect: ${childLog}`);
}
function start() {
  child = spawn(
    process.execPath,
    [
      cli,
      "node",
      "run",
      "--pair-if-needed",
      setup.setupCode,
      "--display-name",
      "runtime-workspace-proof",
      "--commands",
      commands.join(","),
    ],
    {
      env: nodeEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (data) => {
    childLog += data;
  });
  child.stderr.on("data", (data) => {
    childLog += data;
  });
}
try {
  // The packaged CLI must enroll with exactly the production command surface.
  start();
  const nodeId = await waitForNode();
  const completion = await waitForConfirmedSetup(nodeId);
  assert.equal(completion.access, "node");
  await stop();
  await waitForDisconnect(nodeId);
  // Replay the already-redeemed setup code with the same durable node state.
  // Success requires saved-device authentication, not a fresh bootstrap grant.
  start();
  await waitForNode(nodeId);
  const reconnected = await call("device.pair.setupStatus", { setupId: setup.setupId });
  assert.deepEqual(reconnected.completion, completion);
  console.log(
    JSON.stringify({
      commands,
      sameIdentityAfterRestart: true,
      singleBootstrapCompletion: true,
      slowestCallMs,
    }),
  );
} finally {
  await stop();
}
