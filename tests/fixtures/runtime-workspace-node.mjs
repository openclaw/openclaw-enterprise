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
    timeout: 60_000,
  },
);
async function call(method, params = {}) {
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
    { timeout: 30_000, maxBuffer: 1_000_000 },
  );
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
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await call("node.list");
    if (!result.nodes.some((item) => item.nodeId === nodeId && item.connected)) {
      return;
    }
    await setTimeout(500);
  }
  throw new Error("Stopped workspace node remained connected.");
}
async function waitForNode(expectedId) {
  for (let attempt = 0; attempt < 20; attempt++) {
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
  const completed = await call("device.pair.setupStatus", { setupId: setup.setupId });
  assert.equal(completed.completion?.deviceId, nodeId);
  assert.equal(completed.completion?.access, "node");
  await stop();
  await waitForDisconnect(nodeId);
  // Replay the already-redeemed setup code with the same durable node state.
  // Success requires saved-device authentication, not a fresh bootstrap grant.
  start();
  await waitForNode(nodeId);
  const reconnected = await call("device.pair.setupStatus", { setupId: setup.setupId });
  assert.deepEqual(reconnected.completion, completed.completion);
  console.log(
    JSON.stringify({ commands, sameIdentityAfterRestart: true, singleBootstrapCompletion: true }),
  );
} finally {
  await stop();
}
