import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";

// Runs inside a runtime image Gateway container. It drives the same
// `connect --target-file --ephemeral` contract as the dedicated native worker.
const cli = "/app/openclaw.mjs";
const displayName = "runtime-native-worker-proof";

async function prepareState(state) {
  await mkdir(state, { recursive: true, mode: 0o700 });
  const config = `${state}/openclaw.json`;
  await writeFile(
    config,
    JSON.stringify({
      agents: { defaults: { workspace: "/home/node/workspace" } },
      plugins: {
        allow: ["file-transfer"],
        slots: { memory: "none" },
        entries: { "file-transfer": { enabled: true } },
      },
      nodeHost: {
        workerRuns: { enabled: true, capacity: 1, isolation: "none" },
        skills: { enabled: false },
      },
    }),
    { mode: 0o600 },
  );
  return {
    PATH: process.env.PATH,
    HOME: "/home/node",
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: config,
    OPENCLAW_NO_AUTO_UPDATE: "1",
  };
}

// The observer is the client `openclaw gateway call --url --password` builds
// for each invocation (loopback shared-password operator, no device identity),
// opened once: a CLI process per poll cost about 0.7 s. Only the native worker
// below has to be the real CLI.
async function openGateway() {
  const runtime = createRequire(cli).resolve("openclaw/plugin-sdk/gateway-runtime");
  const { GatewayClient } = await import(pathToFileURL(runtime).href);
  assert.equal(typeof GatewayClient, "function", `${runtime} must export GatewayClient`);
  return await new Promise((resolve, reject) => {
    let settled = false;
    let deadline;
    const settle = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      if (error) {
        reject(error);
        client.stop();
      } else {
        resolve(client);
      }
    };
    const client = new GatewayClient({
      url: "ws://127.0.0.1:8080",
      password: process.env.OPENCLAW_GATEWAY_PASSWORD,
      role: "operator",
      scopes: ["operator.admin"],
      clientName: "cli",
      mode: "cli",
      deviceIdentity: null,
      onHelloOk: () => settle(),
      onConnectError: (error) => settle(error),
    });
    deadline = globalThis.setTimeout(
      () => settle(new Error("Gateway observer did not connect within 30 seconds.")),
      30_000,
    );
    try {
      client.start();
    } catch (error) {
      settle(error);
    }
  });
}

let gateway;
async function call(method, params = {}) {
  // `openclaw gateway call` waits 10 s for a response by default.
  return await gateway.request(method, params, { timeoutMs: 10_000 });
}

// Simulate a Pod restart after the controller-minted setup code aged out.
function expireSetupCode(setupCode) {
  const payload = JSON.parse(Buffer.from(setupCode, "base64url").toString("utf8"));
  assert.equal(typeof payload.expiresAtMs, "number", "minted setup codes must carry an expiry");
  return Buffer.from(
    JSON.stringify({ ...payload, expiresAtMs: Date.now() - 60_000 }),
    "utf8",
  ).toString("base64url");
}

let child;
let childLog = "";
async function start(state, setupCode) {
  const environment = await prepareState(state);
  const targetFile = `${state}/connect-target`;
  await writeFile(targetFile, setupCode, { mode: 0o600 });
  childLog = "";
  child = spawn(
    process.execPath,
    [cli, "connect", "--target-file", targetFile, "--ephemeral", "--display-name", displayName],
    { env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (data) => {
    childLog += data;
  });
  child.stderr.on("data", (data) => {
    childLog += data;
  });
  return targetFile;
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const killTimer = globalThis.setTimeout(() => child.kill("SIGKILL"), 5_000);
  await exited;
  clearTimeout(killTimer);
}
async function waitForNode(expectedId) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Native worker exited: ${childLog}`);
    }
    const result = await call("node.list");
    const node = result.nodes.find((item) => item.connected && item.displayName === displayName);
    if (node) {
      if (expectedId) {
        assert.equal(node.nodeId, expectedId);
      }
      return node.nodeId;
    }
    await setTimeout(250);
  }
  throw new Error(`Native worker did not connect: ${childLog}`);
}
// The Gateway lists the node before it finishes the setup handoff: it registers the
// node, records the completion as delivery-uncertain, sends hello-ok, then marks it
// confirmed. Wait for that confirmation instead of reading the status the moment the
// node appears; until then the status is empty or delivery-uncertain.
async function waitForConfirmedSetup(setupId, nodeId) {
  const deadline = Date.now() + 20_000;
  let status;
  while (Date.now() < deadline) {
    status = await call("device.pair.setupStatus", { setupId });
    if (status.completion) {
      assert.equal(status.completion.deviceId, nodeId);
      return status.completion;
    }
    if (status.deliveryUncertain) {
      assert.equal(status.deliveryUncertain.deviceId, nodeId);
    }
    await setTimeout(250);
  }
  throw new Error(`Setup completion was never confirmed: ${JSON.stringify(status)}`);
}
async function waitForDisconnect(nodeId) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const result = await call("node.list");
    if (!result.nodes.some((item) => item.nodeId === nodeId && item.connected)) {
      return;
    }
    await setTimeout(250);
  }
  throw new Error("Stopped native worker remained connected.");
}
async function waitForExit() {
  if (child.exitCode === null && child.signalCode === null) {
    // Unlike a plain timer, AbortSignal.timeout does not hold the event loop
    // open after the worker exits, which kept this process alive for a minute.
    await once(child, "exit", { signal: AbortSignal.timeout(60_000) }).catch((error) => {
      if (error.name === "AbortError") {
        throw new Error(`Native worker kept running with an expired code: ${childLog}`);
      }
      throw error;
    });
  }
  return child.exitCode;
}

try {
  gateway = await openGateway();
  const setup = await call("device.pair.setupCode", {
    publicUrl: "ws://127.0.0.1:8080",
    bootstrapProfile: "node",
    includeQr: false,
  });
  const expiredSetupCode = expireSetupCode(setup.setupCode);
  const state = "/home/node/native-worker-node";

  // First enrollment redeems the fresh code and consumes the private target file.
  const targetFile = await start(state, setup.setupCode);
  const nodeId = await waitForNode();
  await assert.rejects(access(targetFile), { code: "ENOENT" });
  const completion = await waitForConfirmedSetup(setup.setupId, nodeId);
  await stop();
  await waitForDisconnect(nodeId);

  // A restart replays the same, now expired, code. The saved device token must
  // reconnect the same identity without another bootstrap completion.
  await start(state, expiredSetupCode);
  await waitForNode(nodeId);
  const reconnected = await call("device.pair.setupStatus", { setupId: setup.setupId });
  assert.deepEqual(reconnected.completion, completion);
  assert.equal(childLog.includes("Pairing setup code has expired."), false);
  await stop();
  await waitForDisconnect(nodeId);

  // Without saved node credentials, the expired code is still refused.
  await start("/home/node/native-worker-unpaired", expiredSetupCode);
  const exitCode = await waitForExit();
  assert.notEqual(exitCode, 0);
  assert.match(childLog, /Pairing setup code has expired\./);

  console.log(
    JSON.stringify({
      sameIdentityAfterExpiredReplay: true,
      singleBootstrapCompletion: true,
      unpairedExpiredRejected: true,
    }),
  );
} finally {
  await stop();
  // Report a failed teardown on stderr without replacing the proof's own error.
  await gateway?.stopAndWait().catch((error) => console.error(error));
}
