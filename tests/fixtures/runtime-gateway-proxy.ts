import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import https from "node:https";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

const role = process.argv[2];
if (role === "origin") {
  https
    .createServer(
      { key: readFileSync("/proof/key.pem"), cert: readFileSync("/proof/cert.pem") },
      (_request, response) => response.end("allowed origin\n"),
    )
    .listen(443, "0.0.0.0", () => console.log("origin ready"));
} else if (role === "proxy") {
  const proxyModulePath = "/proof/gateway-proxy.mjs";
  const { createGatewayProxyServer }: typeof import("../../apps/controller/src/gateway-proxy.ts") =
    await import(proxyModulePath);
  createGatewayProxyServer({ allowedHosts: ["allowed.proxy.test"] }).listen(3128, "0.0.0.0", () =>
    console.log("proxy ready"),
  );
} else if (role === "harness") {
  const codexHome = process.env.CODEX_HOME;
  assert.ok(codexHome);
  mkdirSync(codexHome, { recursive: true });
  const child = spawn(
    "codex",
    [
      "app-server",
      "--listen",
      "ws://0.0.0.0:19000",
      "--ws-auth",
      "capability-token",
      "--ws-token-file",
      "/proof/token",
    ],
    { stdio: "inherit" },
  );
  child.on("exit", (code) => process.exit(code ?? 1));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
} else if (role === "client") {
  await provePackagedProxy();
} else {
  throw new Error(`Unknown proxy fixture role: ${role}`);
}

async function provePackagedProxy() {
  // Use the image's genuine bundled OC lifecycle and Codex transport. Hashed
  // filenames are build outputs, not a new production API added for this test.
  const files = readdirSync("/app/dist");
  let lifecycle:
    | {
        startProxy(options: { proxyUrl: string }): Promise<unknown>;
        stopProxy(handle: unknown): Promise<unknown>;
      }
    | undefined;
  for (const file of files.filter((file) => file.startsWith("proxy-lifecycle-"))) {
    const candidate: unknown = await import(`/app/dist/${file}`);
    // Bundlers can re-export the public names from an aliased implementation.
    if (
      isRecord(candidate) &&
      typeof candidate.startProxy === "function" &&
      typeof candidate.stopProxy === "function"
    ) {
      const { startProxy, stopProxy } = candidate;
      lifecycle = {
        async startProxy(options) {
          return Reflect.apply(startProxy, candidate, [options]);
        },
        async stopProxy(handle) {
          return Reflect.apply(stopProxy, candidate, [handle]);
        },
      };
      break;
    }
  }
  assert.ok(lifecycle, "packaged native proxy lifecycle must be available");
  const { startProxy, stopProxy } = lifecycle;
  const transportFile = files.find((file) => file.startsWith("transport-websocket-"));
  assert.ok(transportFile, "packaged Codex WebSocket transport must be available");
  const transportExports: unknown = await import(`/app/dist/${transportFile}`);
  assert.ok(isRecord(transportExports));
  const createWebSocketTransport = Object.values(transportExports).find(
    (value) => typeof value === "function" && value.name === "createWebSocketTransport",
  );
  assert.ok(typeof createWebSocketTransport === "function");
  const makeTransport = createWebSocketTransport;
  const websocketPath = "/app/node_modules/ws/wrapper.mjs";
  const websocketExports: unknown = await import(websocketPath);
  assert.ok(isRecord(websocketExports) && typeof websocketExports.default === "function");
  const WebSocket = websocketExports.default;
  const token = readFileSync("/proof/token", "utf8").trim();
  const remoteUrl = "ws://proxy-harness:19000";

  async function initialize(url: string) {
    const transport: unknown = Reflect.apply(makeTransport, undefined, [
      { url, transport: "websocket", authToken: token },
    ]);
    assert.ok(
      transport instanceof EventEmitter &&
        "stdout" in transport &&
        transport.stdout instanceof Readable &&
        "stdin" in transport &&
        transport.stdin instanceof Writable &&
        "kill" in transport &&
        typeof transport.kill === "function",
    );
    const { stdout, stdin, kill } = transport;
    // Subscribe before writing: a refused handshake can close immediately.
    const closed = new Promise<void>((resolve) => transport.once("exit", () => resolve()));
    try {
      return await new Promise<boolean>((resolve) => {
        let buffer = "";
        const timer = setTimeout(() => finish(false), 7_000);
        const finish = (result: boolean) => {
          clearTimeout(timer);
          resolve(result);
        };
        transport.once("error", () => finish(false));
        stdout.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          for (const line of buffer.split("\n").slice(0, -1)) {
            const message: unknown = JSON.parse(line);
            if (isRecord(message) && message.id === 1) {
              finish(Boolean(message.result));
            }
          }
        });
        stdin.write(
          JSON.stringify({
            id: 1,
            method: "initialize",
            params: { clientInfo: { name: "oce-proxy-test", version: "1.0.0" } },
          }) + "\n",
        );
      });
    } finally {
      Reflect.apply(kill, transport, ["SIGKILL"]);
      await closed;
    }
  }

  function rawConnect() {
    return new Promise<boolean>((resolve) => {
      const socket: unknown = Reflect.construct(WebSocket, [
        remoteUrl,
        {
          headers: { Authorization: `Bearer ${token}` },
          handshakeTimeout: 7_000,
        },
      ]);
      assert.ok(
        socket instanceof EventEmitter &&
          "terminate" in socket &&
          typeof socket.terminate === "function",
      );
      const terminate = socket.terminate;
      socket.once("open", () => {
        Reflect.apply(terminate, socket, []);
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
  }

  const fetchOrigin = () =>
    fetch("https://allowed.proxy.test/", { signal: AbortSignal.timeout(7_000) });
  let handle: unknown;
  try {
    assert.equal(await initialize(remoteUrl), true, "direct authenticated baseline");
    handle = await startProxy({ proxyUrl: "http://selected-proxy:3128" });
    assert.equal(await initialize(remoteUrl), false, "unprovisioned internal socket is proxied");
    process.env.OPENCLAW_INTERNAL_TRANSPORT_URL = remoteUrl;
    assert.equal(await initialize(remoteUrl), true, "provisioned internal transport connects");
    assert.equal(await rawConnect(), false, "transport closure revokes the exact bypass");
    assert.equal(await initialize(`${remoteUrl}/other`), false, "another path is not exempt");
    assert.equal(await initialize(remoteUrl), true, "reconnect reacquires its bypass");
    assert.equal(await (await fetchOrigin()).text(), "allowed origin\n");
    // Same reachable TLS origin, different DNS alias: denial must come from the
    // proxy host policy, not an unreachable destination or a certificate error.
    await assert.rejects(
      fetch("https://denied.proxy.test/", { signal: AbortSignal.timeout(7_000) }),
      { name: "TypeError", message: "fetch failed" },
    );
    await stopProxy(handle);
    handle = await startProxy({ proxyUrl: "http://selected-proxy:9" });
    await assert.rejects(
      fetchOrigin(),
      { name: "TypeError", message: "fetch failed" },
      "proxy failure must not fall back to the origin",
    );
    await stopProxy(handle);
    handle = undefined;
    assert.equal(await rawConnect(), true, "stopping native routing restores direct sockets");
    assert.equal(
      await (await fetchOrigin()).text(),
      "allowed origin\n",
      "origin remains reachable",
    );
    console.log("packaged proxy routing and transport lifecycle passed");
  } finally {
    if (handle) {
      await stopProxy(handle);
    }
  }
}
