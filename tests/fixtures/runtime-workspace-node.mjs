import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, rename, writeFile } from "node:fs/promises";
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
const home = "/home/node/workspace-node-home";
const setupPath = "/tmp/workspace-node-setup";
await mkdir(home, { recursive: true, mode: 0o700 });
let setupDelivery = "file";
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
      // The CLI's own RPC timer defaults to 10 s and covers the connect, handshake
      // and reply, so it must share the deadline too (main run 40714481715: node.list
      // reported "gateway timeout after 10000ms" with 88 s of the budget left).
      "--timeout",
      String(timeout),
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
let setup = await call("device.pair.setupCode", {
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
  const killTimer = globalThis.setTimeout(() => child.kill("SIGKILL"), 10_000);
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
    try {
      status = await call("device.pair.setupStatus", { setupId: setup.setupId });
    } catch (error) {
      throw new Error(
        `Setup was not confirmed for the connected device; last status: ${JSON.stringify(status)}`,
        { cause: error },
      );
    }
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
      // This fresh Gateway belongs only to this fixture. Renewal and reconnect
      // must not leave another identity, even as a disconnected node record.
      assert.equal(result.nodes.length, 1, "Expected exactly one workspace node identity.");
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
function setupPayload() {
  const encoded = setup.setupCode.replace(/^oc-pair:\/\//iu, "");
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
}
async function publishSetup() {
  const contents = setupDelivery === "file" ? setup.setupCode : JSON.stringify(setupPayload());
  // Match the atomic replacement provided by projected Secret/provider files.
  await writeFile(`${setupPath}.next`, contents, { mode: 0o600 });
  await rename(`${setupPath}.next`, setupPath);
}
function start() {
  child = spawn(process.execPath, ["/tmp/workspace-node-supervisor.cjs"], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      OPENCLAW_NODE_STATE_DIR: state,
      OPENCLAW_WORKSPACE_DIR: "/home/node/workspace",
      OPENCLAW_NODE_DISPLAY_NAME: "runtime-workspace-proof",
      ...(setupDelivery === "file"
        ? { OPENCLAW_NODE_SETUP_PATH: setupPath }
        : { OPENCLAW_NODE_SETUP_ENVELOPE: setupPath }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (data) => {
    childLog += data;
  });
  child.stderr.on("data", (data) => {
    childLog += data;
  });
}
try {
  // The production supervisor must enroll the packaged node with its restricted grant.
  await publishSetup();
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

  // Publish a replacement while the old node remains healthy. The supervisor
  // must notice the file and renew enrollment without losing the native identity.
  setup = await call("device.pair.setupCode", {
    publicUrl: "ws://127.0.0.1:8080",
    bootstrapProfile: "node",
    includeQr: false,
  });
  await publishSetup();
  const replacementCompletion = await waitForConfirmedSetup(nodeId);
  assert.equal(replacementCompletion.access, "node");
  await waitForNode(nodeId);
  await stop();
  await waitForDisconnect(nodeId);
  // A provider envelope uses the same retained identity after process replacement.
  setupDelivery = "envelope";
  await publishSetup();
  start();
  await waitForNode(nodeId);
  const replacementReconnect = await call("device.pair.setupStatus", {
    setupId: setup.setupId,
  });
  assert.deepEqual(replacementReconnect.completion, replacementCompletion);

  // Provider projections must also refresh a running node, not only its next start.
  setup = await call("device.pair.setupCode", {
    publicUrl: "ws://127.0.0.1:8080",
    bootstrapProfile: "node",
    includeQr: false,
  });
  await publishSetup();
  const providerCompletion = await waitForConfirmedSetup(nodeId);
  await waitForNode(nodeId);
  await stop();
  await waitForDisconnect(nodeId);
  // Expiry of an already-consumed code must not invalidate the saved device grant.
  setup.setupCode = Buffer.from(JSON.stringify({ ...setupPayload(), expiresAtMs: 1 })).toString(
    "base64url",
  );
  await publishSetup();
  start();
  await waitForNode(nodeId);
  const expiredReconnect = await call("device.pair.setupStatus", { setupId: setup.setupId });
  assert.deepEqual(expiredReconnect.completion, providerCompletion);
  console.log(
    JSON.stringify({
      commands,
      sameIdentityAfterRestart: true,
      sameIdentityAfterReplacementSetup: true,
      stableCompletionPerSetup: true,
      slowestCallMs,
    }),
  );
} finally {
  await stop();
}
