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

type GatewayObserver = {
  start(): unknown;
  stop(): unknown;
  stopAndWait(): unknown;
  request(method: string, params: Record<string, unknown>, options: { timeoutMs: number }): unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  assert.ok(isRecord(value), `${label} must be an object`);
  return value;
}

function requireString(value: unknown, label: string): string {
  assert.ok(typeof value === "string", `${label} must be a string`);
  return value;
}

function requireObserver(value: unknown): asserts value is GatewayObserver {
  const observer = requireRecord(value, "GatewayClient instance");
  for (const method of ["start", "stop", "stopAndWait", "request"]) {
    assert.equal(typeof observer[method], "function", `GatewayClient must implement ${method}`);
  }
}

function requireNodes(value: unknown) {
  const result = requireRecord(value, "node.list response");
  assert.ok(Array.isArray(result.nodes), "node.list response must include nodes");
  return result.nodes.map((value: unknown) => {
    const node = requireRecord(value, "node.list entry");
    assert.ok(
      typeof node.connected === "boolean",
      "node.list entry must include a connection state",
    );
    return {
      nodeId: requireString(node.nodeId, "node.list entry ID"),
      connected: node.connected,
      displayName: node.displayName,
    };
  });
}

async function prepareState(state: string) {
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
  const runtimeModule: unknown = await import(pathToFileURL(runtime).href);
  const { GatewayClient } = requireRecord(runtimeModule, "Gateway runtime module");
  assert.ok(typeof GatewayClient === "function", `${runtime} must export GatewayClient`);
  return await new Promise<GatewayObserver>((resolve, reject) => {
    let settled = false;
    let client: GatewayObserver | undefined;
    const deadline = globalThis.setTimeout(
      () => settle(new Error("Gateway observer did not connect within 30 seconds.")),
      30_000,
    );
    function settle(error?: unknown) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      if (error) {
        reject(error);
        client?.stop();
      } else if (client) {
        resolve(client);
      } else {
        reject(new Error("Gateway observer connected before initialization."));
      }
    }
    try {
      const instance: unknown = Reflect.construct(GatewayClient, [
        {
          url: "ws://127.0.0.1:8080",
          password: process.env.OPENCLAW_GATEWAY_PASSWORD,
          role: "operator",
          scopes: ["operator.admin"],
          clientName: "cli",
          mode: "cli",
          deviceIdentity: null,
          onHelloOk: () => settle(),
          onConnectError: (error: unknown) => settle(error),
        },
      ]);
      requireObserver(instance);
      client = instance;
      client.start();
    } catch (error) {
      settle(error);
    }
  });
}

let gateway: GatewayObserver | undefined;
async function call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  assert.ok(gateway, "Gateway observer must be connected");
  // `openclaw gateway call` waits 10 s for a response by default.
  return await gateway.request(method, params, { timeoutMs: 10_000 });
}

// Simulate a Pod restart after the controller-minted setup code aged out.
function expireSetupCode(setupCode: string) {
  const parsed: unknown = JSON.parse(Buffer.from(setupCode, "base64url").toString("utf8"));
  const payload = requireRecord(parsed, "minted setup code payload");
  assert.equal(typeof payload.expiresAtMs, "number", "minted setup codes must carry an expiry");
  return Buffer.from(
    JSON.stringify({ ...payload, expiresAtMs: Date.now() - 60_000 }),
    "utf8",
  ).toString("base64url");
}

let child: ReturnType<typeof spawn> | undefined;
let childLog = "";
async function start(state: string, setupCode: string) {
  const environment = await prepareState(state);
  const targetFile = `${state}/connect-target`;
  await writeFile(targetFile, setupCode, { mode: 0o600 });
  childLog = "";
  const worker = spawn(
    process.execPath,
    [cli, "connect", "--target-file", targetFile, "--ephemeral", "--display-name", displayName],
    { env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  child = worker;
  worker.stdout.on("data", (data: Buffer) => {
    childLog += data.toString();
  });
  worker.stderr.on("data", (data: Buffer) => {
    childLog += data.toString();
  });
  return targetFile;
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const worker = child;
  const exited = once(worker, "exit");
  worker.kill("SIGTERM");
  const killTimer = globalThis.setTimeout(() => worker.kill("SIGKILL"), 5_000);
  await exited;
  clearTimeout(killTimer);
}
// Each wait below checks its deadline after a read, so the last read happens at or past it.
async function waitForNode(expectedId?: string) {
  assert.ok(child, "Native worker must be started");
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`Native worker exited: ${childLog}`);
    }
    const nodes = requireNodes(await call("node.list"));
    const node = nodes.find((item) => item.connected === true && item.displayName === displayName);
    if (node) {
      if (expectedId) {
        assert.equal(node.nodeId, expectedId);
      }
      return node.nodeId;
    }
    if (Date.now() >= deadline) {
      break;
    }
    await setTimeout(250);
  }
  throw new Error(`Native worker did not connect: ${childLog}`);
}
// The Gateway lists the node before it finishes the setup handoff: it registers the
// node, records the completion as delivery-uncertain, sends hello-ok, then marks it
// confirmed. Wait for that confirmation instead of reading the status the moment the
// node appears; until then the status is empty or delivery-uncertain.
async function waitForConfirmedSetup(setupId: string, nodeId: string) {
  const deadline = Date.now() + 20_000;
  let status: Record<string, unknown> | undefined;
  for (;;) {
    status = requireRecord(await call("device.pair.setupStatus", { setupId }), "setup status");
    if (status.completion) {
      const completion = requireRecord(status.completion, "setup completion");
      assert.equal(completion.deviceId, nodeId);
      return completion;
    }
    if (status.deliveryUncertain) {
      const deliveryUncertain = requireRecord(status.deliveryUncertain, "uncertain setup delivery");
      assert.equal(deliveryUncertain.deviceId, nodeId);
    }
    if (Date.now() >= deadline) {
      break;
    }
    await setTimeout(250);
  }
  throw new Error(`Setup completion was never confirmed: ${JSON.stringify(status)}`);
}
async function waitForDisconnect(nodeId: string) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const nodes = requireNodes(await call("node.list"));
    if (!nodes.some((item) => item.nodeId === nodeId && item.connected === true)) {
      return;
    }
    if (Date.now() >= deadline) {
      break;
    }
    await setTimeout(250);
  }
  throw new Error("Stopped native worker remained connected.");
}
async function waitForExit() {
  assert.ok(child, "Native worker must be started");
  if (child.exitCode === null && child.signalCode === null) {
    // Unlike a plain timer, AbortSignal.timeout does not hold the event loop
    // open after the worker exits, which kept this process alive for a minute.
    await once(child, "exit", { signal: AbortSignal.timeout(60_000) }).catch((error: unknown) => {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Native worker kept running with an expired code: ${childLog}`);
      }
      throw error;
    });
  }
  return child.exitCode;
}

try {
  gateway = await openGateway();
  const setup = requireRecord(
    await call("device.pair.setupCode", {
      publicUrl: "ws://127.0.0.1:8080",
      bootstrapProfile: "node",
      includeQr: false,
    }),
    "setup code response",
  );
  const setupCode = requireString(setup.setupCode, "setup code");
  const setupId = requireString(setup.setupId, "setup ID");
  const expiredSetupCode = expireSetupCode(setupCode);
  const state = "/home/node/native-worker-node";

  // First enrollment redeems the fresh code and consumes the private target file.
  const targetFile = await start(state, setupCode);
  const nodeId = await waitForNode();
  await assert.rejects(access(targetFile), { code: "ENOENT" });
  const completion = await waitForConfirmedSetup(setupId, nodeId);
  await stop();
  await waitForDisconnect(nodeId);

  // A restart replays the same, now expired, code. The saved device token must
  // reconnect the same identity without another bootstrap completion.
  await start(state, expiredSetupCode);
  await waitForNode(nodeId);
  const reconnected = requireRecord(
    await call("device.pair.setupStatus", { setupId }),
    "reconnected setup status",
  );
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
  await Promise.resolve(gateway?.stopAndWait()).catch((error: unknown) => console.error(error));
}
