import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import test from "node:test";
import { createServer as createTcpServer, connect } from "node:net";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID, createHash } from "node:crypto";
import {
  framed,
  relay,
  deliver,
  CHUNK,
  MAX_BUFFER,
  MAX_FRAME,
} from "../../deploy/runtime/strands-box/transport.mjs";
import { StrandsBoxSandboxDriver } from "../../apps/controller/src/drivers/sandbox/strands-box.ts";

async function tcpPair(t) {
  const server = createTcpServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const accepted = once(server, "connection");
  const client = connect({ host: "127.0.0.1", port: server.address().port });
  client.on("error", () => {}); // A bounded peer may deliberately reset it.
  const [socket] = await accepted;
  t.after(() => {
    socket.destroy();
    client.destroy();
    server.close();
  });
  return { client, socket };
}

test(
  "Strands slow downstream closes only its channel and retains the shared transport",
  { timeout: 15000 },
  async (t) => {
    const { socket } = await tcpPair(t); // Client deliberately never reads.
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    t.after(() => {
      input.destroy();
      output.destroy();
    });
    const slow = randomUUID();
    const healthy = randomUUID();
    let failures = 0;
    let healthyFrames = 0;
    framed(
      input,
      output,
      (message) => {
        if (message.id === slow && !socket.destroyed) {
          deliver(message, socket);
        }
        if (message.id === healthy) {
          healthyFrames++;
        }
      },
      () => failures++,
    );
    const chunk = Buffer.alloc(CHUNK, 7).toString("base64");
    for (let i = 0; i < 1024 && !socket.destroyed; i++) {
      input.write(JSON.stringify({ id: slow, type: "data", data: chunk }) + "\n");
    }
    input.write(JSON.stringify({ id: healthy, type: "close" }) + "\n");
    assert.ok(socket.destroyed, "a stalled channel must not retain unbounded data");
    assert.ok(socket.writableLength <= MAX_BUFFER);
    assert.equal(failures, 0, "one slow client must not stop the revision transport");
    assert.equal(healthyFrames, 1);
  },
);

test(
  "Strands large stream pauses for shared pipe pressure without truncation",
  { timeout: 15000 },
  async (t) => {
    const { client, socket } = await tcpPair(t);
    const pipe = new PassThrough({ highWaterMark: 64 * 1024 });
    const unused = new PassThrough();
    t.after(() => {
      pipe.destroy();
      unused.destroy();
    });
    const id = randomUUID();
    const payload = Buffer.alloc(8 * 1024 * 1024, 0x5a);
    const hash = createHash("sha256");
    let bytes = 0;
    let failures = 0;
    const send = framed(
      unused,
      pipe,
      () => {},
      () => failures++,
    );
    relay(socket, id, send, () => {});
    client.write(payload);
    // Let a real TCP sender encounter a temporarily blocked IPC reader.
    await delay(100);
    assert.ok(!socket.destroyed, "temporary shared-pipe pressure must pause the source");
    assert.ok(pipe.writableLength <= MAX_BUFFER);
    const sink = new PassThrough();
    t.after(() => sink.destroy());
    await new Promise((resolve, reject) => {
      framed(
        pipe,
        sink,
        (message) => {
          if (message.type !== "data") {
            return;
          }
          const data = Buffer.from(message.data, "base64");
          hash.update(data);
          bytes += data.length;
          if (bytes === payload.length) {
            resolve();
          }
        },
        () => reject(new Error("shared transport failed")),
      );
    });
    assert.equal(bytes, payload.length);
    assert.equal(hash.digest("hex"), createHash("sha256").update(payload).digest("hex"));
    assert.equal(failures, 0);
  },
);

test("Strands malformed or oversized IPC fails closed exactly once", async () => {
  for (const frame of [
    "not-json\n",
    JSON.stringify({ id: randomUUID(), type: "execute", command: "unapproved" }) + "\n",
    "x".repeat(MAX_FRAME + 1),
  ]) {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    let failures = 0;
    let accepted = 0;
    const send = framed(
      input,
      output,
      () => accepted++,
      () => failures++,
    );
    input.write(frame);
    input.end(JSON.stringify({ id: randomUUID(), type: "open" }) + "\n");
    input.destroy();
    output.destroy();
    await delay(0);
    assert.equal(failures, 1);
    assert.equal(accepted, 0);
    assert.throws(() => send({ id: randomUUID(), type: "open" }), /Transport stopped/u);
  }
});

test(
  "Strands disconnected channel releases its pending drain and a fresh channel works",
  { timeout: 15000 },
  async (t) => {
    const pipe = new PassThrough({ highWaterMark: 1024 });
    const unused = new PassThrough();
    t.after(() => {
      pipe.destroy();
      unused.destroy();
    });
    let failures = 0;
    const send = framed(
      unused,
      pipe,
      () => {},
      () => failures++,
    );
    const first = await tcpPair(t);
    let closed = 0;
    relay(first.socket, randomUUID(), send, () => closed++);
    first.client.write(Buffer.alloc(CHUNK, 1));
    await delay(30);
    assert.ok(first.socket.isPaused());
    const done = once(first.socket, "close");
    first.socket.destroy();
    await done;
    pipe.resume();
    await delay(30);
    assert.equal(closed, 1);
    assert.equal(failures, 0);
    const second = await tcpPair(t);
    const id = randomUUID();
    const marker = Buffer.from("new authenticated connection survives prior disconnect");
    const received = new Promise((resolve) =>
      pipe.on("data", (frame) => {
        for (const line of frame.toString().trim().split("\n")) {
          const message = JSON.parse(line);
          if (message.id === id && message.type === "data") {
            resolve(Buffer.from(message.data, "base64"));
          }
        }
      }),
    );
    relay(second.socket, id, send, () => closed++);
    second.client.write(marker);
    assert.deepEqual(await received, marker);
    assert.equal(failures, 0);
  },
);

test("Strands serving requires a fresh authenticated Codex initialize result", async (t) => {
  const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
  const { WebSocketServer } = createRequire(require.resolve("@kubernetes/client-node"))("ws");
  const http = createServer((_request, response) => response.writeHead(503).end());
  const server = new WebSocketServer({ noServer: true });
  const token = "synthetic-readiness-token";
  let behavior = "silent";
  const ids = new Set();
  http.on("upgrade", (request, stream, head) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      stream.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    server.handleUpgrade(request, stream, head, (socket) => {
      socket.once("message", (data) => {
        const request = JSON.parse(data);
        assert.equal(request.method, "initialize");
        assert.ok(!ids.has(request.id));
        ids.add(request.id);
        if (behavior === "silent") {
          return;
        }
        socket.send(
          JSON.stringify({
            id: request.id,
            ...(behavior === "error"
              ? { error: { code: -32603, message: "failed" } }
              : { result: { userAgent: "test-codex/1" } }),
          }),
        );
      });
    });
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  t.after(() => {
    for (const socket of server.clients) {
      socket.terminate();
    }
    server.close();
    http.close();
  });
  const url = `ws://127.0.0.1:${http.address().port}`;
  const status = (transportToken) =>
    StrandsBoxSandboxDriver.prototype.harnessStatus.call(
      { harnessEndpoint: async () => ({ url }) },
      { transportToken, signal: AbortSignal.timeout(15000) },
    );
  assert.deepEqual(await status(token), { state: "starting" });
  assert.equal(server.clients.size, 0);
  behavior = "error";
  assert.deepEqual(await status(token), { state: "starting" });
  behavior = "answer";
  assert.deepEqual(await status("wrong-tenant"), { state: "starting" });
  assert.deepEqual(await status(token), { state: "serving" });
  assert.equal(ids.size, 3);
});

test("Strands routing keeps explicit connection factories on the provider proxy", async (t) => {
  const observed = [];
  const proxy = createServer((request, response) => {
    observed.push(request.url);
    response.end("proxy reached");
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => proxy.close());
  const preload = new URL("../../deploy/runtime/strands-box/proxy-preload.mjs", import.meta.url);
  // ws supplies a connection factory; Node otherwise skips the global Agent
  // and attempts direct DNS. The deliberately unresolved target must reach
  // this actual HTTP proxy without opening a direct connection.
  const script = `
    import http from "node:http";
    import net from "node:net";
    await import(${JSON.stringify(preload.href)});
    for (const withUrl of [false, true]) {
      const body = await new Promise((resolve, reject) => {
        const options = { hostname: "unresolvable.invalid", path: "/", createConnection: net.connect };
        const callback = (response) => {
          let body = "";
          response.on("data", (chunk) => { body += chunk; });
          response.on("end", () => resolve(body));
        };
        const request = withUrl
          ? http.request(new URL("http://unresolvable.invalid/"), options, callback)
          : http.request(options, callback);
        request.setTimeout(3000, () => request.destroy(new Error("proxy timeout")));
        request.on("error", reject);
        request.end();
      });
      if (body !== "proxy reached") throw new Error("wrong response");
    }
    http.globalAgent.destroy();
  `;
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
    env: { HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`, NO_PROXY: "" },
    timeout: 10_000,
  });
  assert.deepEqual(observed, ["http://unresolvable.invalid/", "http://unresolvable.invalid/"]);
});

test("Strands revision containers retain Restricted security and keep readiness authentication outside the workload", async () => {
  const { strandsBoxResources } =
    await import("../../apps/controller/src/drivers/sandbox/strands-box-resources.ts");
  const { createHash } = await import("node:crypto");
  const transportToken = "synthetic-provider-readiness-secret";
  const hash = createHash("sha256").update(transportToken).digest("hex");
  const context = {
    namespace: { id: "ns_fixture", name: "tenant-fixture" },
    revision: { agentId: "agt_fixture", id: "rev_fixture" },
    transportToken,
    requirements: {
      loginMode: "api_key",
      image: "runtime:fixture",
      command: ["native-harness"],
      supervisedCommand: ["native-harness"],
      environment: [{ name: "APP_SERVER_PORT", value: "8787" }],
      files: [],
      credentialAttachments: [],
      labels: {},
      workspaceMounts: [
        {
          claimName: "workspace",
          subPath: "workspace",
          mountPath: "/home/node/workspace",
          readOnly: false,
        },
      ],
    },
  };
  const options = {
    kubernetes: {
      nodeSelector: { "kubernetes.io/arch": "arm64" },
      seccompProfile: "qualified/box.json",
      controlPlanePeer: { namespace: "control", podLabels: { app: "worker" } },
    },
    policy: { network: { endpoints: [] } },
  };
  const render = (value) =>
    strandsBoxResources(value, options, "revision", {}, "input-hash", hash, undefined, []);
  const resources = render(context);
  const secret = resources.find((resource) => resource.kind === "Secret");
  assert.equal(Buffer.from(secret.data.token, "base64").toString(), transportToken);
  assert.ok(
    resources
      .filter((resource) => resource.kind !== "Secret")
      .every((resource) => !JSON.stringify(resource).includes(transportToken)),
  );
  const pod = resources.find((resource) => resource.kind === "Deployment").spec.template.spec;
  assert.equal(pod.hostUsers, false);
  assert.equal(pod.shareProcessNamespace, false);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.securityContext.runAsNonRoot, true);
  assert.deepEqual(pod.securityContext.seccompProfile, { type: "RuntimeDefault" });
  const supervisor = pod.containers.find((container) => container.name === "agent");
  const workload = pod.containers.find((container) => container.name === "box-workload");
  for (const container of pod.containers) {
    assert.deepEqual(container.securityContext.capabilities, { drop: ["ALL"] });
    assert.equal(container.securityContext.allowPrivilegeEscalation, false);
    assert.equal(container.securityContext.readOnlyRootFilesystem, true);
    assert.equal(container.securityContext.procMount, undefined);
  }
  assert.ok(supervisor.volumeMounts.some((mount) => mount.name === "probe-auth" && mount.readOnly));
  assert.ok(!workload.volumeMounts.some((mount) => mount.name === "probe-auth"));
  assert.equal(workload.command[0], "/opt/strands-box/strands-box-contain-trampoline");
  assert.equal(workload.command[1], "--receive-container");
  assert.equal(workload.securityContext.seccompProfile.localhostProfile, "qualified/box.json");
  assert.ok(supervisor.readinessProbe.exec.command.includes("/opt/oce/strands-box/readiness.mjs"));
  assert.throws(() => render({ ...context, transportToken: undefined }), {
    code: "SANDBOX_HARNESS_UNSUPPORTED",
  });
  assert.throws(() => render({ ...context, transportToken: "another-revision" }), {
    code: "SANDBOX_HARNESS_UNSUPPORTED",
  });
  assert.throws(
    () =>
      render({
        ...context,
        requirements: { ...context.requirements, supervisedCommand: undefined },
      }),
    { code: "SANDBOX_HARNESS_UNSUPPORTED" },
  );
});
