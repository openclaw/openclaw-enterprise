import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import type { EventEmitter } from "node:events";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import type { Readable } from "node:stream";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";

interface WorkspaceNode {
  nodeId: string;
  displayName: string;
  connected: boolean;
  commands: string[];
}

interface SetupCompletion {
  deviceId: string;
  access: string;
}

export interface WorkspaceNodeGatewayReplies {
  "device.pair.setupCode": { setupId: string; setupCode: string };
  "node.list": { nodes: WorkspaceNode[] };
}

interface GatewayReplies extends WorkspaceNodeGatewayReplies {
  "device.pair.setupStatus": {
    completion?: SetupCompletion;
    deliveryUncertain?: { deviceId: string };
  };
}

interface SetupEnvelope {
  url: string;
  bootstrapToken: string;
  expiresAtMs: number;
}

type GatewayFrame =
  | {
      type: "req";
      id: string;
      method: string;
      params: { device?: { id: string }; auth?: { bootstrapToken?: string } };
    }
  | { type: "res"; id: string; ok: true; payload?: { auth?: { deviceToken?: string } } }
  | { type: "res"; id: string; ok: false; error?: { details?: { code?: string } } }
  | { type: "event" };

interface ProxySocket extends EventEmitter<{
  close: [];
  error: [Error];
  open: [];
  message: [Buffer];
}> {
  readyState: number;
  send(bytes: Buffer, options: { binary: boolean }): void;
  terminate(): void;
}

interface ProxyServer extends EventEmitter<{ connection: [ProxySocket] }> {
  address(): AddressInfo | string | null;
  clients: Set<ProxySocket>;
  close(callback: (error?: Error) => void): void;
}

interface WebSocketModule {
  WebSocket: { new (url: string): ProxySocket; OPEN: number; CONNECTING: number };
  WebSocketServer: new (options: { host: string; port: number }) => ProxyServer;
}

interface NodeObserver {
  start(): void;
  stop(): void;
  request(
    method: "node.describe",
    params: { nodeId: string },
    options: { timeoutMs: number },
  ): Promise<WorkspaceNode & { deviceTokenAuthenticated: boolean }>;
}

interface GatewayRuntime {
  GatewayClient: new (options: {
    url: string;
    password: string | undefined;
    clientName: string;
    mode: string;
    role: string;
    deviceIdentity: null;
    scopes: string[];
    requestTimeoutMs: number;
    onHelloOk: () => void;
    onConnectError: (error: Error) => void;
  }) => NodeObserver;
}

interface RejectedConnect {
  deviceId: string | undefined;
  usedBootstrapAuth: boolean;
  detailCode: string | undefined;
}

interface HeldHello {
  deviceId: string | undefined;
  release(): void;
}

interface SavedNodeCredentials {
  deviceId: string | undefined;
  tokenSha256: string | undefined;
  tokenCount: number;
  originTokenCount: number;
}

interface ReconnectReceipt {
  commands: string[];
  sameIdentityAfterRestart: boolean;
  sameIdentityAfterReplacementSetup: boolean;
  stableCompletionPerSetup: boolean;
  lostHelloConfirmedWithoutSavedToken: boolean;
  consumedSetupRetryRejected: boolean;
  sameIdentityAfterPairingRecovery: boolean;
  possessionEstablishedAfterRecovery: boolean;
  sameTokenAfterRedeploy: boolean;
  possessionClearedOnRetirementAndReplacement: boolean;
  slowestCallMs: number;
}

const execute = promisify(execFile);
const require = createRequire("/app/package.json");
const { WebSocket, WebSocketServer } = require("ws") as WebSocketModule;
const { GatewayClient } = (await import(
  require.resolve("openclaw/plugin-sdk/gateway-runtime")
)) as GatewayRuntime;
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
const gatewayPassword = process.env.OPENCLAW_GATEWAY_PASSWORD;
await mkdir(home, { recursive: true, mode: 0o700 });
let setupDelivery: "file" | "envelope" = "file";
// One deadline, set by the test from its own exec timeout, bounds the whole proof.
// Each CLI call and wait may use what is left of it. A `gateway call` boots the
// OpenClaw CLI beside the Gateway and the node's own boot, and on a CPU-contended CI
// runner one took over its former fixed 30 s (finding 2673). A hang still fails
// before the test's exec timeout, naming the call.
const budgetMs = Number(process.env.WORKSPACE_PROOF_BUDGET_MS);
assert.ok(Number.isSafeInteger(budgetMs) && budgetMs > 0, "WORKSPACE_PROOF_BUDGET_MS is required.");
const deadline = Date.now() + budgetMs;
let slowestCallMs = 0;
function remainingMs(step: string) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error(`The workspace node proof used its ${budgetMs} ms before ${step}.`);
  }
  return remaining;
}
async function call<Method extends keyof GatewayReplies>(
  method: Method,
  params: Record<string, unknown> = {},
): Promise<GatewayReplies[Method]> {
  assert.ok(gatewayPassword, "OPENCLAW_GATEWAY_PASSWORD is required.");
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
      gatewayPassword,
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
  ).catch((error: unknown) => {
    if (error instanceof Error && "killed" in error && error.killed) {
      throw new Error(`gateway call ${method} did not return within the ${timeout} ms left.`, {
        cause: error,
      });
    }
    throw error;
  });
  slowestCallMs = Math.max(slowestCallMs, Date.now() - startedAt);
  return JSON.parse(stdout) as GatewayReplies[Method];
}
let setup: WorkspaceNodeGatewayReplies["device.pair.setupCode"];
let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
let childLog = "";
let lostHelloDeviceId: string | undefined;
let holdNextBootstrapHello = false;
let heldHello: HeldHello | undefined;
let observer: NodeObserver | undefined;
function describeNode(nodeId: string) {
  assert.ok(observer);
  return observer.request("node.describe", { nodeId }, { timeoutMs: remainingMs("node.describe") });
}
const rejectedConnects: RejectedConnect[] = [];
const upstreamSockets = new Set<ProxySocket>();
// The proxy changes only delivery: the native node signs its own connect and
// the real Gateway consumes the setup and issues the credential-bearing hello.
const proxy = new WebSocketServer({ host: "127.0.0.1", port: 0 });
proxy.on("connection", (downstream) => {
  const upstream = new WebSocket("ws://127.0.0.1:8080");
  upstreamSockets.add(upstream);
  let deviceId: string | undefined;
  let connectId: string | undefined;
  let bootstrapConnect = false;
  const pending: Buffer[] = [];
  const close = () => {
    downstream.terminate();
    upstream.terminate();
  };
  downstream.on("error", close);
  upstream.on("error", close);
  downstream.on("close", () => upstream.terminate());
  upstream.on("close", () => {
    upstreamSockets.delete(upstream);
    downstream.terminate();
  });
  upstream.on("open", () => {
    for (const bytes of pending) {
      upstream.send(bytes, { binary: false });
    }
    pending.length = 0;
  });
  downstream.on("message", (bytes) => {
    const frame = JSON.parse(bytes.toString()) as GatewayFrame;
    if (frame.type === "req" && frame.method === "connect") {
      deviceId = frame.params.device?.id;
      connectId = frame.id;
      bootstrapConnect = Boolean(frame.params.auth?.bootstrapToken);
    }
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(bytes, { binary: false });
    } else if (upstream.readyState === WebSocket.CONNECTING) {
      pending.push(bytes);
    }
  });
  upstream.on("message", (bytes) => {
    const frame = JSON.parse(bytes.toString()) as GatewayFrame;
    if (frame.type === "res" && frame.id === connectId) {
      if (!lostHelloDeviceId && frame.ok && frame.payload?.auth?.deviceToken) {
        lostHelloDeviceId = deviceId;
        // Keep the transport open until setupStatus is read: dropping this
        // frame must not race a successful Gateway write against a TCP reset.
        return;
      }
      if (
        holdNextBootstrapHello &&
        bootstrapConnect &&
        frame.ok &&
        frame.payload?.auth?.deviceToken
      ) {
        holdNextBootstrapHello = false;
        heldHello = {
          deviceId,
          release() {
            assert.equal(
              downstream.readyState,
              WebSocket.OPEN,
              "Replacement closed before observation.",
            );
            downstream.send(bytes, { binary: false });
          },
        };
        return;
      }
      if (!frame.ok) {
        rejectedConnects.push({
          deviceId,
          usedBootstrapAuth: bootstrapConnect,
          detailCode: frame.error?.details?.code,
        });
      }
    }
    if (downstream.readyState === WebSocket.OPEN) {
      downstream.send(bytes, { binary: false });
    }
  });
});
await once(proxy, "listening");
const proxyAddress = proxy.address();
assert.ok(proxyAddress && typeof proxyAddress !== "string", "Expected a TCP proxy address.");
const setupGatewayUrl = `ws://127.0.0.1:${proxyAddress.port}`;
async function waitForTransportObservation<T>(observe: () => T | undefined, step: string) {
  assert.ok(child);
  let result = observe();
  while (!result) {
    remainingMs(step);
    if (child.exitCode !== null) {
      throw new Error(`Node exited before ${step}: ${childLog}`);
    }
    await setTimeout(100);
    result = observe();
  }
  return result;
}
function readSavedNodeCredentials(): SavedNodeCredentials {
  const db = new DatabaseSync(`${state}/client/credentials.sqlite`, { readOnly: true });
  try {
    const tokenRow = db
      .prepare("SELECT token FROM device_auth_tokens WHERE role = 'node'")
      .get() as { token: string } | undefined;
    const identityRow = db
      .prepare("SELECT device_id FROM device_identities WHERE identity_key = 'primary'")
      .get() as { device_id: string } | undefined;
    const tokenCount = db
      .prepare("SELECT count(*) AS count FROM device_auth_tokens WHERE role = 'node'")
      .get() as { count: number };
    const originTokenCount = db
      .prepare("SELECT count(*) AS count FROM gateway_origin_device_tokens WHERE role = 'node'")
      .get() as { count: number };
    return {
      deviceId: identityRow?.device_id,
      tokenSha256: tokenRow?.token
        ? createHash("sha256").update(tokenRow.token).digest("hex")
        : undefined,
      tokenCount: tokenCount.count,
      originTokenCount: originTokenCount.count,
    };
  } finally {
    db.close();
  }
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const runningChild = child;
  const exited = once(runningChild, "exit");
  runningChild.kill("SIGTERM");
  const killTimer = globalThis.setTimeout(() => runningChild.kill("SIGKILL"), 10_000);
  await exited;
  clearTimeout(killTimer);
}
async function waitForDisconnect(nodeId: string) {
  while (Date.now() < deadline) {
    const result = await call("node.list");
    if (!result.nodes.some((item) => item.nodeId === nodeId && item.connected)) {
      const retired = await describeNode(nodeId);
      assert.equal(retired.connected, false);
      assert.equal(retired.deviceTokenAuthenticated, false);
      return;
    }
    await setTimeout(500);
  }
  throw new Error("Stopped workspace node remained connected.");
}
// The Gateway lists the node before it finishes the setup handoff (registered, then
// delivery-uncertain, hello-ok, confirmed), so wait for the confirmation.
async function waitForConfirmedSetup(nodeId: string) {
  let status: GatewayReplies["device.pair.setupStatus"] | undefined;
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
async function waitForNode(expectedId: string) {
  assert.ok(child);
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
      assert.deepEqual([...node.commands].sort(), commands);
      if (expectedId) {
        assert.equal(node.nodeId, expectedId);
      }
      const current = await describeNode(node.nodeId);
      if (current.connected && current.deviceTokenAuthenticated === true) {
        assert.equal(current.nodeId, node.nodeId);
        assert.deepEqual([...current.commands].sort(), commands);
        return node.nodeId;
      }
    }
    await setTimeout(500);
  }
  throw new Error(`Restricted node did not connect: ${childLog}`);
}
function setupPayload(): SetupEnvelope {
  const encoded = setup.setupCode.replace(/^oc-pair:\/\//iu, "");
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SetupEnvelope;
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
  child.stdout.on("data", (data: Buffer) => {
    childLog += data;
  });
  child.stderr.on("data", (data: Buffer) => {
    childLog += data;
  });
}
try {
  // A persistent real operator connection lets us inspect the replacement while
  // its hello is withheld, without spending its handshake budget starting a CLI.
  const connected = Promise.withResolvers<void>();
  observer = new GatewayClient({
    url: "ws://127.0.0.1:8080",
    password: gatewayPassword,
    clientName: "gateway-client",
    mode: "backend",
    role: "operator",
    deviceIdentity: null,
    scopes: ["operator.admin"],
    requestTimeoutMs: remainingMs("operator observation"),
    onHelloOk: connected.resolve,
    onConnectError: connected.reject,
  });
  observer.start();
  const connectionTimer = globalThis.setTimeout(
    () =>
      connected.reject(new Error("The operator observer did not connect within the proof budget.")),
    remainingMs("operator connection"),
  );
  try {
    await connected.promise;
  } finally {
    clearTimeout(connectionTimer);
  }
  setup = await call("device.pair.setupCode", {
    publicUrl: setupGatewayUrl,
    bootstrapProfile: "node",
    includeQr: false,
  });
  await publishSetup();
  start();
  const lostDeviceId = await waitForTransportObservation(
    () => lostHelloDeviceId,
    "the dropped credential hello",
  );
  // A successful Gateway socket write is not a receipt from the node: the
  // proxy discarded this hello, but native setupStatus still reports completion.
  await waitForConfirmedSetup(lostDeviceId);
  // Even if the bootstrap socket is still registered, no connection has proved
  // possession of the issued token. A completion cannot supply that fact.
  const lostHelloNode = await describeNode(lostDeviceId);
  assert.equal(lostHelloNode.deviceTokenAuthenticated, false);
  await stop();
  await waitForDisconnect(lostDeviceId);
  const missingCredentials = {
    deviceId: lostDeviceId,
    tokenSha256: undefined,
    tokenCount: 0,
    originTokenCount: 0,
  };
  assert.deepEqual(readSavedNodeCredentials(), missingCredentials);

  // Retrying the consumed setup with the retained identity cannot manufacture
  // the lost token. Rate limiting or unrelated refusals must not satisfy this proof.
  rejectedConnects.length = 0;
  start();
  await waitForTransportObservation(
    () =>
      rejectedConnects.some(
        (attempt) =>
          attempt.deviceId === lostDeviceId &&
          attempt.usedBootstrapAuth &&
          attempt.detailCode === "AUTH_BOOTSTRAP_TOKEN_INVALID",
      ),
    "same-device consumed-setup rejection",
  );
  await stop();
  await waitForDisconnect(lostDeviceId);
  assert.deepEqual(readSavedNodeCredentials(), missingCredentials);

  // This is the runtime portion of operator recovery: stop the consumer before
  // replacing its setup projection, retaining its identity and workspace. The
  // controller's stop/delete-Secret/redeploy authorization is outside this proof.
  setup = await call("device.pair.setupCode", {
    publicUrl: setupGatewayUrl,
    bootstrapProfile: "node",
    includeQr: false,
  });
  // The production supervisor must enroll the packaged node with its restricted grant.
  await publishSetup();
  start();
  const nodeId = await waitForNode(lostDeviceId);
  const completion = await waitForConfirmedSetup(nodeId);
  assert.equal(completion.access, "node");
  await stop();
  await waitForDisconnect(nodeId);
  const savedCredentials = readSavedNodeCredentials();
  assert.equal(savedCredentials.deviceId, nodeId);
  assert.equal(savedCredentials.tokenCount, 1);
  // Replay the already-redeemed setup code with the same durable node state.
  // Success requires saved-device authentication, not a fresh bootstrap grant.
  start();
  await waitForNode(nodeId);
  // This node was already paired with the seven-command surface. Redeployment
  // must use the exact retained token and identity without capability approval.
  assert.deepEqual(readSavedNodeCredentials(), savedCredentials);
  const reconnected = await call("device.pair.setupStatus", { setupId: setup.setupId });
  assert.deepEqual(reconnected.completion, completion);

  // Publish a replacement while the old node remains healthy. The supervisor
  // must notice the file and renew enrollment without losing the native identity.
  setup = await call("device.pair.setupCode", {
    publicUrl: setupGatewayUrl,
    bootstrapProfile: "node",
    includeQr: false,
  });
  holdNextBootstrapHello = true;
  await publishSetup();
  const replacementHello = await waitForTransportObservation(
    () => heldHello,
    "the replacement bootstrap hello",
  );
  assert.equal(replacementHello.deviceId, nodeId);
  const replacement = await describeNode(nodeId);
  assert.equal(replacement.connected, true);
  assert.equal(replacement.deviceTokenAuthenticated, false);
  replacementHello.release();
  heldHello = undefined;
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
    publicUrl: setupGatewayUrl,
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
  const receipt: ReconnectReceipt = {
    commands,
    sameIdentityAfterRestart: true,
    sameIdentityAfterReplacementSetup: true,
    stableCompletionPerSetup: true,
    lostHelloConfirmedWithoutSavedToken: true,
    consumedSetupRetryRejected: true,
    sameIdentityAfterPairingRecovery: true,
    possessionEstablishedAfterRecovery: true,
    sameTokenAfterRedeploy: true,
    possessionClearedOnRetirementAndReplacement: true,
    slowestCallMs,
  };
  console.log(JSON.stringify(receipt));
} finally {
  try {
    await stop();
  } finally {
    observer?.stop();
    for (const socket of proxy.clients) {
      socket.terminate();
    }
    for (const socket of upstreamSockets) {
      socket.terminate();
    }
    await new Promise<void>((resolve, reject) =>
      proxy.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
