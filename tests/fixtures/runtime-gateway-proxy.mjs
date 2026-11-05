import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import https from "node:https";

const role = process.argv[2];
if (role === "origin") {
  https
    .createServer(
      { key: readFileSync("/proof/key.pem"), cert: readFileSync("/proof/cert.pem") },
      (_request, response) => response.end("allowed origin\n"),
    )
    .listen(443, "0.0.0.0", () => console.log("origin ready"));
} else if (role === "proxy") {
  const { createGatewayProxyServer } = await import("/proof/gateway-proxy.mjs");
  createGatewayProxyServer({ allowedHosts: ["allowed.proxy.test"] }).listen(3128, "0.0.0.0", () =>
    console.log("proxy ready"),
  );
} else if (role === "harness") {
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
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
  const lifecycleFile = files.find(
    (file) =>
      file.startsWith("proxy-lifecycle-") &&
      readFileSync(`/app/dist/${file}`, "utf8").includes("export { startProxy, stopProxy }"),
  );
  assert.ok(lifecycleFile, "packaged native proxy lifecycle must be available");
  const { startProxy, stopProxy } = await import(`/app/dist/${lifecycleFile}`);
  const transportFile = files.find((file) => file.startsWith("transport-websocket-"));
  assert.ok(transportFile, "packaged Codex WebSocket transport must be available");
  const transportExports = await import(`/app/dist/${transportFile}`);
  const createWebSocketTransport = Object.values(transportExports).find(
    (value) => typeof value === "function" && value.name === "createWebSocketTransport",
  );
  assert.ok(createWebSocketTransport);
  const { default: WebSocket } = await import("/app/node_modules/ws/wrapper.mjs");
  const token = readFileSync("/proof/token", "utf8").trim();
  const remoteUrl = "ws://proxy-harness:19000";

  async function initialize(url) {
    const transport = createWebSocketTransport({ url, transport: "websocket", authToken: token });
    // Subscribe before writing: a refused handshake can close immediately.
    const closed = new Promise((resolve) => transport.once("exit", resolve));
    try {
      return await new Promise((resolve) => {
        let buffer = "";
        const timer = setTimeout(() => finish(false), 7_000);
        const finish = (result) => {
          clearTimeout(timer);
          resolve(result);
        };
        transport.once("error", () => finish(false));
        transport.stdout.on("data", (chunk) => {
          buffer += chunk.toString();
          for (const line of buffer.split("\n").slice(0, -1)) {
            const message = JSON.parse(line);
            if (message.id === 1) {
              finish(Boolean(message.result));
            }
          }
        });
        transport.stdin.write(
          JSON.stringify({
            id: 1,
            method: "initialize",
            params: { clientInfo: { name: "oce-proxy-test", version: "1.0.0" } },
          }) + "\n",
        );
      });
    } finally {
      transport.kill("SIGKILL");
      await closed;
    }
  }

  function rawConnect() {
    return new Promise((resolve) => {
      const socket = new WebSocket(remoteUrl, {
        headers: { Authorization: `Bearer ${token}` },
        handshakeTimeout: 7_000,
      });
      socket.once("open", () => {
        socket.terminate();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
  }

  const fetchOrigin = () =>
    fetch("https://allowed.proxy.test/", { signal: AbortSignal.timeout(7_000) });
  let handle;
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
