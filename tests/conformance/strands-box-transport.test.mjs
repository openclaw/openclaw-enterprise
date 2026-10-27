import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
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
  MAX_CHANNELS,
} from "../../deploy/runtime/strands-box/transport.mjs";
import { serveHarness } from "../../deploy/runtime/strands-box/supervisor.mjs";

async function supervisor(t) {
  const reservation = createTcpServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const reader = new PassThrough();
  const writer = new PassThrough();
  const token = randomUUID();
  const frames = [];
  writer.on("data", (data) => frames.push(...data.toString().trim().split("\n").map(JSON.parse)));
  const gateway = createTcpServer((socket) => {
    gateway.connections++;
    socket.destroy();
  });
  gateway.connections = 0;
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const serving = serveHarness(
    {
      port,
      transportHash: createHash("sha256").update(token).digest("hex"),
      gateway: { host: "127.0.0.1", port: gateway.address().port },
    },
    { reader, writer, terminate() {} },
  );
  await once(serving.server, "listening");
  t.after(() => {
    serving.stop();
    reader.destroy();
    writer.destroy();
    gateway.close();
  });
  async function client() {
    const accepted = once(serving.server, "connection");
    const socket = connect({ port, host: "127.0.0.1", allowHalfOpen: true });
    socket.on("error", () => {});
    t.after(() => socket.destroy());
    await accepted;
    return socket;
  }
  return { ...serving, client, token, reader, frames, gateway };
}

test(
  "Strands rejected half-open clients release listener capacity without Harness I/O",
  { timeout: 15000 },
  async (t) => {
    const harness = await supervisor(t);
    for (const path of ["/", "/unknown"]) {
      for (let i = 0; i < MAX_CHANNELS; i++) {
        const client = await harness.client();
        const ended = once(client, "end");
        let response = "";
        client.on("data", (data) => (response += data));
        client.write(`GET ${path} HTTP/1.1\r\nAuthorization: Bearer invalid\r\n\r\n`);
        await ended; // Deliberately leave the client's write half open.
        assert.match(response, path === "/" ? /401 Unauthorized/u : /404 Not Found/u);
      }
    }
    assert.deepEqual(harness.frames, [], "rejection must precede contained Harness I/O");
    const client = await harness.client();
    client.write(`GET / HTTP/1.1\r\nAuthorization: Bearer ${harness.token}\r\n\r\n`);
    for (let i = 0; harness.frames.length < 2 && i < 100; i++) {
      await delay(10);
    }
    assert.equal(harness.frames[0]?.type, "open");
    assert.equal(harness.frames[1]?.type, "data");
  },
);

test(
  "Strands shutdown closes clients still reading headers and refuses queued Gateway opens",
  { timeout: 5000 },
  async (t) => {
    const harness = await supervisor(t);
    const client = await harness.client();
    const closed = new Promise((resolve) => client.once("close", resolve));
    const terminated = new Promise((resolve) => {
      client.once("end", resolve);
      client.once("close", resolve);
    });
    client.write("GET / HTTP/1.1\r\n");
    harness.stop();
    // A valid frame may already be queued when the supervisor receives SIGTERM.
    harness.reader.write(JSON.stringify({ id: randomUUID(), type: "open" }) + "\n");
    client.resume();
    await terminated; // The server must close before the client supplies FIN.
    client.end();
    await closed;
    await delay(50);
    assert.equal(harness.gateway.connections, 0, "no Gateway connect after shutdown");
  },
);

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
  "Strands supervisor refuses a racing channel without disconnecting admitted clients",
  { timeout: 10000 },
  async (t) => {
    const harness = await supervisor(t);
    const clients = [];
    for (let i = 0; i < MAX_CHANNELS; i++) {
      const client = await harness.client();
      clients.push(client);
      client.write(`GET / HTTP/1.1\r\nAuthorization: Bearer ${harness.token}\r\n\r\n`);
    }
    for (
      let i = 0;
      harness.frames.filter((frame) => frame.type === "open").length < MAX_CHANNELS && i < 100;
      i++
    ) {
      await delay(10);
    }
    const admitted = harness.frames.filter((frame) => frame.type === "open");
    assert.equal(admitted.length, MAX_CHANNELS);
    // The peer can have allocated its final slot before seeing our last open.
    const racing = randomUUID();
    harness.reader.write(JSON.stringify({ id: racing, type: "open" }) + "\n");
    assert.deepEqual(harness.frames.at(-1), { id: racing, type: "close" });
    assert.ok(harness.server.listening);
    assert.equal(harness.gateway.connections, 0);
    const received = once(clients[0], "data");
    harness.reader.write(
      JSON.stringify({
        id: admitted[0].id,
        type: "data",
        data: Buffer.from("still connected").toString("base64"),
      }) + "\n",
    );
    assert.equal((await received)[0].toString(), "still connected");
    // Duplicate live IDs remain protocol corruption, even when the table is full.
    harness.reader.write(JSON.stringify({ id: admitted[0].id, type: "open" }) + "\n");
    assert.equal(harness.server.listening, false);
  },
);

test(
  "Strands contained receiver refuses capacity overflow and retains native connections",
  { timeout: 10000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "strands-channel-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const sockets = [];
    const native = createTcpServer((socket) => {
      sockets.push(socket);
      socket.on("error", () => {});
      socket.pipe(socket);
    });
    await new Promise((resolve) => native.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      for (const socket of sockets) {
        socket.destroy();
      }
      native.close();
    });
    const manifest = join(directory, "manifest.json");
    await writeFile(
      manifest,
      JSON.stringify({
        port: native.address().port,
        // A non-Node lifetime fixture does not load the image-only proxy preload.
        command: ["/bin/sleep", "60"],
        environment: {},
        workspace: directory,
      }),
    );
    const inner = spawn(
      process.execPath,
      [new URL("../../deploy/runtime/strands-box/inner.mjs", import.meta.url).pathname, manifest],
      {
        // The proxy route is not used by these native incoming channels.
        env: { ...process.env, HTTPS_PROXY: "http://127.0.0.1:9" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    t.after(async () => {
      if (inner.exitCode === null) {
        const ended = once(inner, "exit");
        inner.kill("SIGTERM");
        await ended;
      }
    });
    const frames = [];
    const output = new PassThrough();
    output.resume();
    framed(
      inner.stdout,
      output,
      (frame) => frames.push(frame),
      () => {},
    );
    const send = (frame) => inner.stdin.write(JSON.stringify(frame) + "\n");
    const ids = Array.from({ length: MAX_CHANNELS }, () => randomUUID());
    for (const id of ids) {
      send({ id, type: "open" });
    }
    for (let i = 0; sockets.length < MAX_CHANNELS && i < 100; i++) {
      await delay(10);
    }
    assert.equal(sockets.length, MAX_CHANNELS);
    const racing = randomUUID();
    send({ id: racing, type: "open" });
    send({ id: ids[0], type: "data", data: Buffer.from("native survives").toString("base64") });
    for (
      let i = 0;
      !frames.some((frame) => frame.id === ids[0] && frame.type === "data") && i < 100;
      i++
    ) {
      await delay(10);
    }
    assert.ok(frames.some((frame) => frame.id === racing && frame.type === "close"));
    assert.equal(
      Buffer.from(
        frames.find((frame) => frame.id === ids[0] && frame.type === "data").data,
        "base64",
      ).toString(),
      "native survives",
    );
    assert.equal(inner.exitCode, null);
    assert.equal(sockets.length, MAX_CHANNELS);
  },
);

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
