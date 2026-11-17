import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  AGENT_READINESS_ENTRYPOINT,
  COMPUTE_AGENT_RUNTIME_ENTRYPOINT as AGENT_RUNTIME_ENTRYPOINT,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";

const image = process.env.OCC_TEST_RUNTIME_IMAGE;
const docker = process.env.OCC_DOCKER_BIN ?? "docker";

// Run the production probe against the image's real Codex server, then real
// WebSocket peers that exercise its RPC completion boundary. No provider or model is involved.
const scenario = String.raw`
(async () => {
const assert = require("node:assert/strict");
const { spawn, execFile } = require("node:child_process");
const { createHash, randomBytes } = require("node:crypto");
const { once } = require("node:events");
const { mkdirSync, readFileSync } = require("node:fs");
const residentProgram = JSON.parse(readFileSync(0, "utf8")).residentProgram;
const { connect } = require("node:net");
const { promisify } = require("node:util");
const execute = promisify(execFile);
const { WebSocket, WebSocketServer } = require("ws");
const token = randomBytes(32).toString("hex");
const env = { PATH: process.env.PATH, HOME: "/tmp/readiness", CODEX_HOME: "/tmp/readiness/codex", RUST_LOG: "info,codex_otel=off", LOG_FORMAT: "json" };
mkdirSync(env.CODEX_HOME, { recursive: true, mode: 0o700 });
async function probe(port, auth = token) {
  try {
    const result = await execute(process.execPath, ["-e", process.env.READINESS_PROGRAM], {
      env: { ...env, APP_SERVER_PORT: String(port), APP_SERVER_TOKEN: auth }, timeout: 5000,
    });
    return { code: 0, output: result.stdout + result.stderr };
  } catch (error) {
    assert.equal(typeof error.code, "number", "probe must exit within its own deadline");
    return { code: error.code, output: error.stdout + error.stderr };
  }
}
// Execute the real generated HTTP listener and readiness callback. Stop the
// program before login/model startup: this is HTTP component proof, not startup proof.
async function probeHttp(port, auth = token) {
  const child = spawn(process.execPath, [], {
    env: { ...env, APP_SERVER_PORT: String(port), APP_SERVER_TOKEN: auth,
      OPENCLAW_RUNTIME_STATUS_PORT: "18992" }, stdio: ["pipe", "ignore", "pipe"],
  });
  const exited = once(child, "exit");
  child.stdin.end(residentProgram);
  try {
    const deadline = Date.now() + 3000;
    for (;;) {
      try {
        const response = await fetch("http://127.0.0.1:18992/readyz", { signal: AbortSignal.timeout(3000) });
        await response.text();
        return response.status;
      } catch (error) {
        assert.equal(error.cause?.code, "ECONNREFUSED");
        assert.ok(Date.now() < deadline, "resident readiness listener must start");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
  } finally {
    child.kill("SIGTERM");
    await exited;
  }
}
async function identity(name) {
  const socket = new WebSocket("ws://127.0.0.1:18991", {
    headers: { Authorization: "Bearer " + token }, perMessageDeflate: false,
  });
  let userAgent;
  const deadline = setTimeout(() => socket.terminate(), 2000);
  socket.on("open", () => socket.send(JSON.stringify({
    id: 1, method: "initialize", params: { clientInfo: { name, version: "1.0.0" } },
  })));
  socket.on("message", data => {
    const response = JSON.parse(String(data));
    if (response.id === 1) {
      assert.equal(response.error, undefined);
      userAgent = response.result.userAgent;
      socket.close(1000);
    }
  });
  await once(socket, "close");
  clearTimeout(deadline);
  assert.equal(typeof userAgent, "string");
  return userAgent;
}
let serverLog = "";
const server = spawn("codex", ["-c", 'otel.exporter="none"', "app-server", "--listen", "ws://127.0.0.1:18991",
  "--ws-auth", "capability-token", "--ws-token-sha256", createHash("sha256").update(token).digest("hex")],
  { env, stdio: ["ignore", "ignore", "pipe"] });
server.stderr.on("data", data => { serverLog += data; });
const serverExit = once(server, "exit");
try {
  const deadline = Date.now() + 10000;
  for (;;) {
    assert.equal(server.exitCode, null, "real Codex server must stay alive");
    const listening = await new Promise(resolve => {
      const socket = connect(18991, "127.0.0.1");
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    if (listening) break;
    assert.ok(Date.now() < deadline, "real Codex server must listen");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  // Probing before the first ordinary client must not claim its originator.
  assert.deepEqual(await probe(18991), { code: 0, output: "" });
  assert.equal(await probeHttp(18991), 200);
  const ordinaryIdentity = await identity("ordinary-client");
  assert.match(ordinaryIdentity, /^ordinary-client\//);
  // Later polling must also preserve that client's process-wide user-agent suffix.
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.deepEqual(await probe(18991), { code: 0, output: "" });
    assert.equal(await probeHttp(18991), 200);
    assert.equal(await identity("codex_app_server_daemon"), ordinaryIdentity);
  }
  assert.match(serverLog, /"level":"INFO"/, "the log capture must observe production INFO output");
  assert.doesNotMatch(serverLog, /notification[^\n]*initialized/, "default logging must not add an initialized event per poll");
  assert.equal((await probe(18991, "wrong-capability-token")).code, 1);
  assert.equal(await probeHttp(18991, "wrong-capability-token"), 503);
} finally {
  server.kill("SIGTERM");
  const kill = setTimeout(() => server.kill("SIGKILL"), 2000);
  await serverExit;
  clearTimeout(kill);
}
const cases = ["silent", "wrong-id", "rejected", "invalid-json", "missing-identity", "closed", "abrupt-after-result"];
for (const mode of cases) {
  const peer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(peer, "listening");
  const requests = [];
  peer.on("connection", socket => {
    socket.on("message", data => {
      const request = JSON.parse(String(data));
      requests.push(request.method);
      if (mode === "wrong-id") socket.send(JSON.stringify({ id: request.id + 1, result: { userAgent: "codex/test" } }));
      if (mode === "rejected") socket.send(JSON.stringify({ id: request.id, error: { code: -32600, message: "private-error-canary" } }));
      if (mode === "invalid-json") socket.send("private-error-canary");
      if (mode === "missing-identity") socket.send(JSON.stringify({ id: request.id, result: {} }));
      if (mode === "closed") socket.close();
      if (mode === "abrupt-after-result") socket.send(
        JSON.stringify({ id: request.id, result: { userAgent: "codex/test" } }),
        () => socket.terminate(),
      );
    });
  });
  try {
    const result = await probe(peer.address().port);
    // A complete result is authoritative even if the server drops the transport
    // afterward, as the packaged Codex server does during normal client closure.
    assert.equal(result.code, mode === "abrupt-after-result" ? 0 : 1, mode);
    assert.equal(await probeHttp(peer.address().port), mode === "abrupt-after-result" ? 200 : 503, mode);
    assert.deepEqual(requests, ["initialize", "initialize"], "readiness must make no thread or turn request");
    if (mode !== "abrupt-after-result") assert.match(result.output, /Codex app-server/);
    assert.ok(!result.output.includes("private-error-canary"), "probe output must omit peer content");
  } finally {
    for (const client of peer.clients) client.terminate();
    await new Promise(resolve => peer.close(resolve));
  }
}
console.log(JSON.stringify({ repeatedInitialization: true, peerCases: cases.length }));
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

test(
  "runtime image Codex readiness requires a successful initialization RPC",
  {
    skip: image === undefined ? "Set OCC_TEST_RUNTIME_IMAGE to a local runtime image." : false,
    timeout: 60000,
  },
  async (t) => {
    assert.ok(image);
    const { runDockerCommand } = await import("../helpers/runtime-image-startup.mjs");
    const name = `oce-codex-readiness-${randomBytes(6).toString("hex")}`;
    t.after(() =>
      runDockerCommand(docker, ["rm", "--force", name], { timeout: 10000 }).catch(() => {}),
    );
    const parts = AGENT_RUNTIME_ENTRYPOINT.split(
      "\nconst loginMode = process.env.CODEX_LOGIN_MODE;",
    );
    assert.equal(parts.length, 2, "select the generated resident listener before model startup");
    const result = await runDockerCommand(
      docker,
      [
        "run",
        "-i",
        "--name",
        name,
        "--network",
        "none",
        "--read-only",
        "--user",
        "1000:1000",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--tmpfs",
        "/tmp:uid=1000,gid=1000,mode=700",
        "-e",
        `READINESS_PROGRAM=${AGENT_READINESS_ENTRYPOINT}`,
        "--entrypoint",
        "node",
        image,
        "-e",
        scenario,
      ],
      { timeout: 55000, maxBuffer: 65536 },
      JSON.stringify({ residentProgram: parts[0] }),
    );
    assert.deepEqual(JSON.parse(result.stdout), { repeatedInitialization: true, peerCases: 7 });
  },
);
