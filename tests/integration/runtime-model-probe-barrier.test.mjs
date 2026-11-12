import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { request } from "node:https";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { startModelProbeEndpoint } from "../fixtures/runtime-model-probe-endpoint.mjs";
import { harnessTlsFixture } from "../helpers/harness-tls.mjs";

const controller = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const { WebSocket, WebSocketServer } = createRequire(controller.resolve("@kubernetes/client-node"))(
  "ws",
);
const marker = "OCC-API-HELD-6e4afe32-c214-4b11-91ca-303a223f3370";
const token = "synthetic-model-fixture-key";
const user = (text) => ({ role: "user", content: [{ type: "input_text", text }] });

async function fixture(t, overrides = {}) {
  const tls = await harnessTlsFixture(t);
  const directory = await mkdtemp(join(tmpdir(), "model-barrier-"));
  const socketPath = join(directory, "control.sock");
  let endpoint;
  t.after(async () => {
    await endpoint?.close();
    await rm(directory, { recursive: true, force: true });
  });
  endpoint = await startModelProbeEndpoint({
    tls,
    WebSocketServer,
    port: 0,
    env: {
      PROBE_ENDPOINT_MODE: "answer",
      PROBE_ENDPOINT_CONTROL_SOCKET: socketPath,
      PROBE_ENDPOINT_ECHO_PATTERN: "OCC-API-HELD-[a-f0-9-]+",
      PROBE_ENDPOINT_CREDENTIAL_DIGESTS: JSON.stringify({
        fixture: createHash("sha256").update(token).digest("hex"),
      }),
      ...overrides,
    },
  });
  const control = (value) =>
    new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      let data = "";
      socket.setTimeout(5_000, () => socket.destroy(new Error("Control deadline")));
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        data += chunk;
      });
      socket.once("error", reject);
      socket.once("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(error);
        }
      });
      socket.once("connect", () => socket.end(`${JSON.stringify(value)}\n`));
    });
  const until = async (gateId, state) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await control({ op: "status", gateId });
      if (result.state === state) {
        return result;
      }
      await delay(10);
    }
    assert.fail(`Barrier did not become ${state}`);
  };
  const http = (input, authorization = token, withModel = true) => {
    let headersReceived = false;
    let req;
    const result = new Promise((resolve) => {
      req = request(
        {
          hostname: "127.0.0.1",
          servername: "localhost",
          port: endpoint.port,
          ca: tls.caBundle,
          method: "POST",
          path: "/v1/responses",
          headers: { authorization: `Bearer ${authorization}`, "content-type": "application/json" },
        },
        (response) => {
          headersReceived = true;
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.once("error", () => resolve({ error: true }));
          response.once("end", () => resolve({ status: response.statusCode, body }));
        },
      );
      req.setTimeout(5_000, () => req.destroy(new Error("Model deadline")));
      req.once("error", () => resolve({ error: true }));
      req.end(JSON.stringify({ ...(withModel ? { model: "fixture" } : {}), input }));
    });
    return { result, abort: () => req.destroy(), headersReceived: () => headersReceived };
  };
  const ws = async () => {
    const socket = new WebSocket(`wss://127.0.0.1:${endpoint.port}/v1/responses`, {
      ca: tls.caBundle,
      servername: "localhost",
      headers: { authorization: `Bearer ${token}` },
    });
    const events = [];
    socket.on("message", (data) => events.push(JSON.parse(String(data))));
    await once(socket, "open");
    t.after(() => socket.terminate());
    return { socket, events };
  };
  return { endpoint, socketPath, control, until, http, ws };
}

test(
  "model barrier holds one authenticated HTTPS response and refuses replay while allowing continuation",
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    assert.equal((await lstat(f.socketPath)).mode & 0o777, 0o600);
    assert.equal((await f.http([user(marker)], "wrong-key").result).status, 401);
    assert.equal((await f.http([], token, false).result).status, 400);
    assert.equal((await f.control({ op: "release", gateId: "unknown" })).error, "unknown-gate");
    assert.equal((await f.control({ op: "arm", marker, timeoutMs: 300_001 })).error, "invalid-arm");
    const armed = await f.control({ op: "arm", marker, timeoutMs: 10_000 });
    assert.equal(armed.state, "armed");
    assert.equal((await f.control({ op: "release", gateId: armed.gateId })).error, "not-held");
    const pending = f.http([user(`Return ${marker} exactly.`)]);
    assert.equal((await f.until(armed.gateId, "held")).matchingRequests, 1);
    // The control acknowledgement is independent of the still-open TLS response.
    assert.equal(pending.headersReceived(), false);
    assert.equal((await f.http([user("unrelated")]).result).status, 200);
    const released = await f.control({ op: "release", gateId: armed.gateId });
    assert.equal(released.state, "completed");
    assert.equal(released.completedResponses, 1);
    const response = await pending.result;
    assert.equal(response.status, 200);
    assert.equal(response.body.match(/event: response.completed\n/g)?.length, 1);
    assert.ok(response.body.includes(marker));
    assert.equal((await f.control({ op: "release", gateId: armed.gateId })).error, "not-held");
    // Native continuation carries old user history; it must not consume the gate again.
    assert.equal((await f.http([user(marker), user("continue")]).result).status, 200);
    assert.equal((await f.http([user(marker)]).result).error, true);
    const duplicate = await f.control({ op: "status", gateId: armed.gateId });
    assert.equal(duplicate.reason, "duplicate-request");
    assert.equal(duplicate.matchingRequests, 2);
    assert.equal(duplicate.completedResponses, 1);
  },
);

test(
  "model barrier preserves WebSocket prewarm and releases one held Responses stream",
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    const { socket, events } = await f.ws();
    const armed = await f.control({ op: "arm", marker, timeoutMs: 10_000 });
    const prewarm = once(socket, "message");
    socket.send(
      JSON.stringify({
        type: "response.create",
        model: "fixture",
        generate: false,
        input: [user(marker)],
      }),
    );
    await prewarm;
    // A subsequent control round trip need not drain WS frames: filter actual response identity.
    assert.equal((await f.control({ op: "status", gateId: armed.gateId })).matchingRequests, 0);
    socket.send(
      JSON.stringify({ type: "response.create", model: "fixture", input: [user(marker)] }),
    );
    await f.until(armed.gateId, "held");
    assert.equal(events.filter((event) => event.response?.id === "resp_runtime_probe").length, 0);
    const completed = new Promise((resolve) =>
      socket.on("message", (data) => {
        const event = JSON.parse(String(data));
        if (event.type === "response.completed" && event.response.id === "resp_runtime_probe") {
          resolve(event);
        }
      }),
    );
    assert.equal((await f.control({ op: "release", gateId: armed.gateId })).completedResponses, 1);
    assert.equal((await completed).response.output[0].content[0].text, marker);
    assert.equal(
      events.filter(
        (event) =>
          event.type === "response.completed" && event.response.id === "resp_runtime_probe",
      ).length,
      1,
    );
    const disconnected = once(socket, "close");
    socket.close();
    await disconnected;
  },
);

test(
  "expired, aborted and shutdown holds never become completed model responses",
  { timeout: 20_000 },
  async (t) => {
    for (const reason of ["timeout", "aborted", "shutdown", "duplicate-request"]) {
      await t.test(reason, async (t) => {
        const f = await fixture(t);
        const armed = await f.control({
          op: "arm",
          marker,
          timeoutMs: reason === "timeout" ? 3_000 : 10_000,
        });
        const pending = f.http([user(marker)]);
        await f.until(armed.gateId, "held");
        if (reason === "aborted") {
          pending.abort();
        }
        if (reason === "duplicate-request") {
          assert.equal((await f.http([user(marker)]).result).error, true);
        }
        if (reason === "shutdown") {
          assert.equal((await f.control({ op: "shutdown" })).ok, true);
          await f.endpoint.close();
          await assert.rejects(lstat(f.socketPath), { code: "ENOENT" });
        } else {
          const failed = await f.until(armed.gateId, "failed");
          assert.equal(failed.reason, reason);
          assert.equal(failed.completedResponses, 0);
          assert.equal((await f.control({ op: "release", gateId: armed.gateId })).ok, false);
        }
        assert.equal((await pending.result).error, true);
      });
    }
  },
);

// The control mechanism is opt-in; existing fixture modes retain their HTTP behavior.
test(
  "model endpoint answers and rejects normally without a control socket",
  { timeout: 10_000 },
  async (t) => {
    for (const mode of ["answer", "reject"]) {
      await t.test(mode, async (t) => {
        const f = await fixture(t, {
          PROBE_ENDPOINT_CONTROL_SOCKET: undefined,
          PROBE_ENDPOINT_MODE: mode,
        });
        await assert.rejects(lstat(f.socketPath), { code: "ENOENT" });
        const result = await f.http([user("ordinary readiness")]).result;
        assert.equal(result.status, mode === "answer" ? 200 : 401);
        if (mode === "answer") {
          assert.ok(result.body.includes("READY"));
        }
      });
    }
  },
);
