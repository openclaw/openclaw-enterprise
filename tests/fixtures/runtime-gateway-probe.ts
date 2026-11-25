import type { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";

export type GatewayProbeInvocation = [fixture: "fixture", pluginRuntimeHelpers: string];

type GatewayRequest = { id: string; method: string };
type ProbeResult = { ok: true; value: unknown } | { ok: false; code: string };
interface ProbeSocket {
  on(event: "message", listener: (raw: Buffer) => void): void;
  send(data: string): void;
  terminate(): void;
}
interface ProbeServer extends EventEmitter {
  on(event: "connection", listener: (socket: ProbeSocket) => void): this;
  address(): AddressInfo | string | null;
  clients: Set<ProbeSocket>;
  close(callback: (error?: Error) => void): void;
}
type WebSocketModule = {
  WebSocketServer: new (options: { host: string; port: number }) => ProbeServer;
};

const assert: typeof import("node:assert/strict") = process.getBuiltinModule("node:assert/strict");
const { once } = process.getBuiltinModule("node:events");
const { mkdtempSync, writeFileSync, readFileSync } = process.getBuiltinModule("node:fs");
const requireModule: (name: string) => unknown = process
  .getBuiltinModule("node:module")
  .createRequire(process.cwd() + "/[eval]");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireWebSocketModule(value: unknown): asserts value is WebSocketModule {
  assert.ok(typeof value === "function" || isRecord(value), "ws must export a module");
  assert.equal(typeof Reflect.get(value, "WebSocketServer"), "function");
}

function requireGatewayRequest(value: unknown): GatewayRequest {
  assert.ok(isRecord(value), "Gateway request must be an object");
  assert.ok(typeof value.id === "string", "Gateway request ID must be a string");
  assert.ok(typeof value.method === "string", "Gateway request method must be a string");
  return { id: value.id, method: value.method };
}

function assertProbeResult(value: unknown): asserts value is ProbeResult {
  assert.ok(isRecord(value), "probe result must be an object");
  if (value.ok === true) {
    assert.ok("value" in value, "successful probe must return a value");
    return;
  }
  assert.ok(value.ok === false, "failed probe must report ok=false");
  assert.ok(typeof value.code === "string", "failed probe must report a code");
}

const webSocketModule = requireModule("ws");
requireWebSocketModule(webSocketModule);
const { WebSocketServer } = webSocketModule;

// The real packaged SDK talks to a silent peer, then a responsive peer. There
// are no model credentials, external network, or mocked SDK timeout semantics.
(async () => {
  const root = mkdtempSync("/tmp/oce-gateway-probe-");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string", "Gateway peer must listen on TCP");
  process.env.OPENCLAW_CONFIG_PATH = root + "/openclaw.json";
  process.env.OPENCLAW_STATE_DIR = root;
  writeFileSync(
    process.env.OPENCLAW_CONFIG_PATH,
    JSON.stringify({
      gateway: {
        mode: "local",
        port: address.port,
        auth: { mode: "password", password: "synthetic-probe-password" },
      },
    }),
  );
  let hold = false;
  let failRequest = false;
  let received = 0;
  server.on("connection", (socket) => {
    socket.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "fixture-nonce", ts: Date.now() },
      }),
    );
    socket.on("message", (raw) => {
      const parsed: unknown = JSON.parse(raw.toString("utf8"));
      const request = requireGatewayRequest(parsed);
      if (request.method === "connect") {
        socket.send(
          JSON.stringify({
            type: "res",
            id: request.id,
            ok: true,
            payload: {
              type: "hello-ok",
              protocol: 4,
              server: { version: "test", connId: "probe-fixture" },
              features: { methods: ["plugins.list"], events: [] },
              snapshot: {},
              policy: { maxPayload: 1048576, maxBufferedBytes: 1048576, tickIntervalMs: 30000 },
            },
          }),
        );
      } else {
        received += 1;
        if (!hold) {
          socket.send(
            JSON.stringify({
              type: "res",
              id: request.id,
              ok: !failRequest,
              ...(failRequest
                ? { error: { code: "UNAVAILABLE", message: "RPC handler failed" } }
                : { payload: { generation: 2, plugins: [] } }),
            }),
          );
        }
      }
    });
  });
  // Load the exact generated helper, including its public-SDK resolution path.
  const helpers = process.argv[2];
  assert.ok(typeof helpers === "string", "generated Gateway helper source is required");
  const loaded: unknown = new Function("require", helpers + "\nreturn callNativeGateway;")(
    requireModule,
  );
  assert.ok(typeof loaded === "function", "generated helper must expose callNativeGateway");
  const callNativeGateway = loaded;
  async function probe(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<ProbeResult> {
    const result: unknown = await callNativeGateway(method, params, timeoutMs);
    assertProbeResult(result);
    return result;
  }
  try {
    assert.equal((await probe("plugins.list", {}, 10000)).ok, true);
    hold = true;
    const began = Date.now();
    assert.deepEqual(await probe("plugins.list", {}, 300), { ok: false, code: "UNAVAILABLE" });
    assert.ok(Date.now() - began < 3000, "timeout settles without peer cooperation");
    // The server sees the SDK's close a round trip later: wait for it, bounded, then read once
    // more at the deadline.
    const closedBy = Date.now() + 3000;
    while (server.clients.size > 0 && Date.now() < closedBy) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(server.clients.size, 0, "the timed-out SDK connection closes");
    hold = false;
    assert.equal((await probe("plugins.list", {}, 3000)).ok, true);
    failRequest = true;
    assert.deepEqual(await probe("plugins.list", {}, 3000), { ok: false, code: "PROBE_FAILED" });
    assert.equal(received, 4);
    for (const socket of server.clients) {
      socket.terminate();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.deepEqual(await probe("plugins.list", {}, 3000), { ok: false, code: "UNAVAILABLE" });
    assert.equal(
      readFileSync(`/proc/self/task/${process.pid}/children`, "utf8").trim(),
      "",
      "probes do not start CLI descendants",
    );
    console.log("GATEWAY_PROBE_RECOVERY_PASSED");
  } finally {
    for (const socket of server.clients) {
      socket.terminate();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
