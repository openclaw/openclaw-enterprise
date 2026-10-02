const assert = require("node:assert/strict");
const { once } = require("node:events");
const { mkdtempSync, writeFileSync, readFileSync } = require("node:fs");
const { WebSocketServer } = require("ws");

// The real packaged SDK talks to a silent peer, then a responsive peer. There
// are no model credentials, external network, or mocked SDK timeout semantics.
(async () => {
  const root = mkdtempSync("/tmp/oce-gateway-probe-");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  process.env.OPENCLAW_CONFIG_PATH = root + "/openclaw.json";
  process.env.OPENCLAW_STATE_DIR = root;
  writeFileSync(
    process.env.OPENCLAW_CONFIG_PATH,
    JSON.stringify({
      gateway: {
        mode: "local",
        port: server.address().port,
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
      const request = JSON.parse(raw);
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
  const probe = new Function("require", process.argv[2] + "\nreturn callNativeGateway;")(require);
  try {
    assert.equal((await probe("plugins.list", {}, 10000)).ok, true);
    hold = true;
    const began = Date.now();
    assert.deepEqual(await probe("plugins.list", {}, 300), { ok: false, code: "UNAVAILABLE" });
    assert.ok(Date.now() - began < 3000, "timeout settles without peer cooperation");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(server.clients.size, 0, "the timed-out SDK connection closes");
    hold = false;
    assert.equal((await probe("plugins.list", {}, 3000)).ok, true);
    failRequest = true;
    assert.deepEqual(await probe("plugins.list", {}, 3000), { ok: false, code: "PROBE_FAILED" });
    assert.equal(received, 4);
    for (const socket of server.clients) {
      socket.terminate();
    }
    await new Promise((resolve) => server.close(resolve));
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
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
