import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { createServer as createTcpServer, connect, type Server, type Socket } from "node:net";
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
import { connect as tlsConnect } from "node:tls";
import { harnessTlsFixture } from "../helpers/harness-tls.ts";
import { serveHarness } from "../../deploy/runtime/strands-box/supervisor.mjs";

type Frame =
  | { id: string; type: "open" | "opened" | "probe" | "close" | "abort" }
  | { id: string; type: "data"; data: string };

function assertFrame(value: unknown): asserts value is Frame {
  assert.ok(value !== null && typeof value === "object");
  assert.ok("id" in value && typeof value.id === "string");
  assert.ok("type" in value);
  if (value.type === "data") {
    assert.ok("data" in value && typeof value.data === "string");
  } else {
    assert.ok(
      value.type === "open" ||
        value.type === "opened" ||
        value.type === "probe" ||
        value.type === "close" ||
        value.type === "abort",
    );
  }
}

function parseFrame(line: string): Frame {
  const value: unknown = JSON.parse(line);
  assertFrame(value);
  return value;
}

function tcpPort(server: Pick<Server, "address">): number {
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return address.port;
}

async function supervisor(t: TestContext) {
  const reservation = createTcpServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = tcpPort(reservation);
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const reader = new PassThrough();
  const writer = new PassThrough();
  const token = randomUUID();
  const frames: Frame[] = [];
  writer.on("data", (data: unknown) => {
    assert.ok(Buffer.isBuffer(data));
    frames.push(...data.toString().trim().split("\n").map(parseFrame));
  });
  const gateway = createTcpServer((socket) => {
    gateway.connections++;
    socket.destroy();
  });
  gateway.connections = 0;
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const tls = await harnessTlsFixture(t);
  const probePath = join(tls.directory, "probe.sock");
  const serving = serveHarness(
    {
      port,
      statusPort: 0,
      revisionId: "test-revision",
      transportHash: createHash("sha256").update(token).digest("hex"),
      gateway: { host: "127.0.0.1", port: tcpPort(gateway) },
    },
    {
      reader,
      writer,
      tls,
      probePath,
      status: async () => ({ state: "starting" }),
      terminate() {},
    },
  );
  await once(serving.server, "listening");
  t.after(() => {
    serving.stop();
    reader.destroy();
    writer.destroy();
    gateway.close();
  });
  async function client(local = false) {
    const accepted = once(
      local ? serving.probeServer : serving.server,
      local ? "connection" : "secureConnection",
    );
    const tlsOptions = {
      port,
      host: "127.0.0.1",
      servername: "localhost",
      ca: tls.caBundle,
      allowHalfOpen: true,
    };
    const socket = local ? connect(probePath) : tlsConnect(tlsOptions);
    socket.on("error", () => {});
    t.after(() => socket.destroy());
    await accepted;
    return socket;
  }
  return { ...serving, client, token, reader, frames, gateway, tls };
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
    assert.deepEqual([...harness.frames], [], "rejection must precede contained Harness I/O");
    const client = await harness.client();
    client.write(`GET / HTTP/1.1\r\nAuthorization: Bearer ${harness.token}\r\n\r\n`);
    for (let i = 0; harness.frames.length < 2 && i < 100; i++) {
      await delay(10);
    }
    assert.equal(harness.frames[0]?.type, "open");
    assert.equal(harness.frames[1]?.type, "data");
    assert.equal(
      Buffer.from(harness.frames[1].data, "base64").toString().includes(harness.token),
      false,
    );
  },
);

test("the worker port allows readiness but refuses native upgrades with the same valid bearer", async (t) => {
  const { diagnostics, tls, token, frames } = await supervisor(t);
  const read = async (path: string) => {
    const socket = tlsConnect({
      host: "127.0.0.1",
      port: tcpPort(diagnostics),
      servername: "localhost",
      ca: tls.caBundle,
    });
    socket.write(
      `GET ${path} HTTP/1.1\r\nAuthorization: Bearer ${token}\r\nConnection: upgrade\r\nUpgrade: websocket\r\n\r\n`,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of socket) {
      assert.ok(Buffer.isBuffer(chunk));
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString();
  };
  assert.match(await read("/revisions/test-revision/readiness"), /200 OK[\s\S]*starting/u);
  assert.match(await read("/"), /404 Not Found/u);
  assert.equal(frames.length, 0);
});

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

async function tcpPair(t: TestContext) {
  const server = createTcpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const accepted = new Promise<Socket>((resolve) => server.once("connection", resolve));
  const client = connect({ host: "127.0.0.1", port: tcpPort(server) });
  client.on("error", () => {}); // A bounded peer may deliberately reset it.
  const socket = await accepted;
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
    const firstClient = clients[0];
    const firstAdmitted = admitted[0];
    assert.ok(firstClient);
    assert.ok(firstAdmitted);
    const received: Promise<unknown[]> = once(firstClient, "data");
    harness.reader.write(
      JSON.stringify({
        id: firstAdmitted.id,
        type: "data",
        data: Buffer.from("still connected").toString("base64"),
      }) + "\n",
    );
    const [chunk] = await received;
    assert.ok(Buffer.isBuffer(chunk));
    assert.equal(chunk.toString(), "still connected");
    // Duplicate live IDs remain protocol corruption, even when the table is full.
    harness.reader.write(JSON.stringify({ id: firstAdmitted.id, type: "open" }) + "\n");
    assert.equal(harness.server.listening, false);
  },
);

test(
  "Strands contained receiver refuses capacity overflow and retains native connections",
  { timeout: 10000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "strands-channel-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const sockets: Socket[] = [];
    const native = createTcpServer((socket) => {
      sockets.push(socket);
      socket.on("error", () => {});
      socket.pipe(socket);
    });
    await new Promise<void>((resolve) => native.listen(0, "127.0.0.1", resolve));
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
        port: tcpPort(native),
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
    const frames: Frame[] = [];
    const output = new PassThrough();
    output.resume();
    framed(
      inner.stdout,
      output,
      (frame: unknown) => {
        assertFrame(frame);
        frames.push(frame);
      },
      () => {},
    );
    const send = (frame: Frame) => inner.stdin.write(JSON.stringify(frame) + "\n");
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
    const firstId = ids[0];
    assert.ok(firstId);
    send({
      id: firstId,
      type: "data",
      data: Buffer.from("native survives").toString("base64"),
    });
    const echoed = () =>
      Buffer.concat(
        frames
          .filter(
            (frame): frame is Extract<Frame, { type: "data" }> =>
              frame.id === firstId && frame.type === "data",
          )
          .map((frame) => Buffer.from(frame.data, "base64")),
      ).toString();
    for (
      let i = 0;
      i < 100 &&
      (!echoed().includes("native survives") ||
        !frames.some((frame) => frame.id === racing && frame.type === "close"));
      i++
    ) {
      await delay(10);
    }
    assert.ok(frames.some((frame) => frame.id === racing && frame.type === "close"));
    assert.match(
      echoed(),
      /^GET \/ HTTP\/1\.1\r\nAuthorization: Bearer [0-9a-f]{64}\r\nnative survives$/u,
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
      (message: unknown) => {
        assertFrame(message);
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
    await new Promise<void>((resolve, reject) => {
      framed(
        pipe,
        sink,
        (message: unknown) => {
          assertFrame(message);
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
    JSON.stringify({
      id: randomUUID(),
      type: "execute",
      command: "unapproved",
    }) + "\n",
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
    const received = new Promise<Buffer>((resolve) =>
      pipe.on("data", (frame: unknown) => {
        assert.ok(Buffer.isBuffer(frame));
        for (const line of frame.toString().trim().split("\n")) {
          const message = parseFrame(line);
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
  const observed: Array<string | undefined> = [];
  const proxy = createServer((request, response) => {
    observed.push(request.url);
    response.end("proxy reached");
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
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
    env: { HTTP_PROXY: `http://127.0.0.1:${tcpPort(proxy)}`, NO_PROXY: "" },
    timeout: 10_000,
  });
  assert.deepEqual(observed, ["http://unresolvable.invalid/", "http://unresolvable.invalid/"]);
});

test(
  "a loopback readiness probe retains capacity when all session channels are busy",
  { timeout: 10000 },
  async (t) => {
    const h = await supervisor(t);
    for (let i = 0; i < MAX_CHANNELS; i++) {
      const socket = await h.client();
      socket.write(`GET / HTTP/1.1\r\nAuthorization: Bearer ${h.token}\r\n\r\n`);
    }
    const probe = await h.client(true);
    probe.write(`GET / HTTP/1.1\r\nAuthorization: Bearer ${h.token}\r\nx-oce-readiness: 1\r\n\r\n`);
    for (let i = 0; i < 100 && !h.frames.some((f) => f.type === "probe"); i++) {
      await delay(10);
    }
    assert.equal(h.frames.filter((f) => f.type === "open").length, MAX_CHANNELS);
    assert.equal(h.frames.filter((f) => f.type === "probe").length, 1);
  },
);

test("a terminal frame flushes queued TCP output", { timeout: 10000 }, async (t) => {
  const { client, socket } = await tcpPair(t);
  const chunks: Buffer[] = [];
  client.on("data", (chunk) => {
    assert.ok(Buffer.isBuffer(chunk));
    chunks.push(chunk);
  });
  const end = once(client, "end");
  const body = Buffer.alloc(CHUNK, 97);
  // Corking leaves writes in the real socket queue when the terminal frame arrives.
  socket.cork();
  deliver({ type: "data", data: body.toString("base64") }, socket);
  deliver({ type: "close" }, socket);
  socket.uncork();
  await end;
  assert.deepEqual(Buffer.concat(chunks), body);
});

test(
  "the policy proxy delivers the complete response to a slow reader at EOF",
  { timeout: 15000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "strands-policy-eof-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const payload = Buffer.alloc(5 * 1024 * 1024 + 17, 0x4f);
    const upstream = createTcpServer((socket) => {
      socket.once("data", () => socket.end(payload));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    t.after(() => upstream.close());
    const client = join(directory, "read-response.cjs");
    // The synthetic native command speaks TCP through the proxy inherited from inner.mjs.
    await writeFile(
      client,
      `
    const net=require("node:net"), crypto=require("node:crypto");
    const proxy=new URL(process.env.HTTP_PROXY);
    const socket=net.connect(Number(proxy.port),proxy.hostname);
    const hash=crypto.createHash("sha256");
    socket.on("connect",()=>{
      socket.write("GET http://example.invalid/ HTTP/1.1\\r\\nHost: example.invalid\\r\\n\\r\\n");
      socket.pause();setTimeout(()=>socket.resume(),250);
    });
    socket.on("data",bytes=>hash.update(bytes));
    socket.on("end",()=>console.error("digest="+hash.digest("hex")));
  `,
    );
    const manifest = join(directory, "manifest.json");
    await writeFile(
      manifest,
      JSON.stringify({
        command: ["/bin/sh", "-c", 'unset NODE_OPTIONS; exec "$0" "$1"', process.execPath, client],
        environment: {},
        workspace: directory,
        port: 1,
      }),
    );
    const inner = spawn(
      process.execPath,
      [new URL("../../deploy/runtime/strands-box/inner.mjs", import.meta.url).pathname, manifest],
      {
        env: {
          ...process.env,
          HTTPS_PROXY: "http://127.0.0.1:" + tcpPort(upstream),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    t.after(() => inner.kill());
    let result = "";
    inner.stderr.setEncoding("utf8").on("data", (chunk: unknown) => {
      assert.ok(typeof chunk === "string");
      result += chunk;
    });
    const [code]: unknown[] = await once(inner, "exit");
    assert.equal(code, 0, result);
    assert.ok(
      result.includes("digest=" + createHash("sha256").update(payload).digest("hex")),
      result,
    );
  },
);

test(
  "policy proxy connections release capacity after upstream EOF with half-open clients",
  { timeout: 15000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "strands-policy-capacity-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const request = "CONNECT example.invalid:443 HTTP/1.1\r\nHost: example.invalid:443\r\n\r\n";
    const refusal = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    let requests = 0;
    const upstream = createTcpServer((socket) => {
      socket.on("error", () => socket.destroy());
      socket.once("data", () => {
        requests++;
        socket.end(refusal);
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    t.after(() => upstream.close());

    const manifest = join(directory, "manifest.json");
    await writeFile(
      manifest,
      JSON.stringify({
        command: ["/bin/sh", "-c", 'printf "%s\\n" "$HTTP_PROXY" >&2; exec /bin/sleep 15'],
        environment: {},
        workspace: directory,
        port: 1,
      }),
    );
    const inner = spawn(
      process.execPath,
      [new URL("../../deploy/runtime/strands-box/inner.mjs", import.meta.url).pathname, manifest],
      {
        env: { HTTPS_PROXY: "http://127.0.0.1:" + tcpPort(upstream) },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    t.after(() => inner.kill());
    const output = createInterface({ input: inner.stderr });
    t.after(() => output.close());
    const [proxyUrl]: unknown[] = await once(output, "line");
    assert.ok(typeof proxyUrl === "string");
    const proxy = new URL(proxyUrl);

    const attempts = MAX_CHANNELS * 2 + 4;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const client = connect({
        host: proxy.hostname,
        port: Number(proxy.port),
        allowHalfOpen: true,
      });
      // Keep the write half open after the proxy sends EOF, until all attempts complete.
      t.after(() => client.destroy());
      client.setEncoding("utf8");
      let response = "";
      client.on("data", (chunk: string) => {
        response += chunk;
      });
      client.setTimeout(3000, () => client.destroy(new Error("Timed out waiting for proxy EOF")));
      const ended = once(client, "end");
      client.write(request);
      await ended;
      client.setTimeout(0);
      assert.equal(response, refusal, `request ${attempt}`);
    }
    assert.equal(requests, attempts);
  },
);

test("the model preview launches with the Box placeholder only", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "strands-model-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "workload.json");
  const phantom = "strands_box_" + "1".repeat(64);
  async function launch(key: string, overrides: Record<string, unknown> = {}) {
    await writeFile(
      file,
      JSON.stringify({
        proxyOpenAiModelCredential: true,
        command: [
          "/bin/sh",
          "-c",
          'test "$OPENAI_API_KEY" = "$1" && echo started',
          "test",
          phantom,
        ],
        port: 1,
        workspace: directory,
        environment: {},
        ...overrides,
      }),
    );
    const child = spawn(
      process.execPath,
      [new URL("../../deploy/runtime/strands-box/inner.mjs", import.meta.url).pathname, file],
      {
        env: { OPENAI_API_KEY: key, HTTPS_PROXY: "http://127.0.0.1:1" },
        timeout: 5000,
      },
    );
    let output = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
    const [code] = await once(child, "close");
    return { code, output };
  }
  assert.deepEqual(await launch(phantom), { code: 0, output: "started\n" });
  for (const result of [
    await launch(""),
    await launch("invented-key"),
    await launch(phantom, { environment: { OPENAI_API_KEY: "invented-key" } }),
    await launch(phantom, { secretEnvironment: { OPENAI_API_KEY: "/missing-file" } }),
  ]) {
    assert.equal(result.code, 1);
    assert.match(result.output, /model placeholder is missing or overridden/u);
    assert.doesNotMatch(result.output, /started|invented-key|missing-file/u);
  }
});
