import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import { Duplex } from "node:stream";
import test, { type TestContext } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createSlackProxyServer } from "../../apps/controller/src/slack-proxy.mjs";
import { listen } from "../helpers/listen.ts";

const writeBudgetMs = 100;
const reply = Buffer.alloc(4_096, "r");
const smallReply = Buffer.from("small-body");
const testOptions = { timeout: 10_000 };

// Hold actual Writable callbacks to model a pending TCP write without relying on
// kernel buffer sizes. The production CONNECT handler and Writable backpressure run.
class HeldClient extends Duplex {
  holdWrites = false;
  reset = false;
  readonly received: Buffer[] = [];
  readonly pending: { chunk: Buffer; callback: (error?: Error | null) => void }[] = [];

  constructor() {
    super({ writableHighWaterMark: 1_024 });
  }

  override _read(): void {}

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.holdWrites) {
      this.pending.push({ chunk: Buffer.from(chunk), callback });
      this.emit("held");
      return;
    }
    this.received.push(Buffer.from(chunk));
    callback();
  }

  resetAndDestroy(): this {
    this.reset = true;
    return this.destroy();
  }

  release(): void {
    this.holdWrites = false;
    for (const { chunk, callback } of this.pending.splice(0)) {
      this.received.push(chunk);
      callback();
    }
  }

  body(): Buffer {
    const bytes = Buffer.concat(this.received);
    return bytes.subarray(bytes.indexOf("\r\n\r\n") + 4);
  }
}

async function tunnel(t: TestContext) {
  let resolvePeer!: (socket: net.Socket) => void;
  const peerReady = new Promise<net.Socket>((resolve) => {
    resolvePeer = resolve;
  });
  const upstreamServer = net.createServer((socket) => {
    socket.on("error", () => {});
    t.after(() => socket.destroy());
    resolvePeer(socket);
  });
  const upstreamPort = await listen(t, upstreamServer);
  const connect = net.connect;
  let upstream!: net.Socket;
  t.mock.method(net, "connect", (options: net.NetConnectOpts) => {
    assert.deepEqual(options, { host: "slack.com", port: 443 });
    upstream = connect({ host: "127.0.0.1", port: upstreamPort });
    return upstream;
  });
  const client = new HeldClient();
  client.on("error", () => {});
  t.after(() => client.destroy());
  const server = createSlackProxyServer({ clientDrainTimeoutMs: writeBudgetMs });
  server.emit("connect", { url: "slack.com:443" }, client, Buffer.alloc(0));
  await Promise.all([peerReady, once(upstream, "connect")]);
  assert.match(Buffer.concat(client.received).toString(), /^HTTP\/1\.1 200 Connection Established/);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const peer = await peerReady;
  return { client, peer, upstream };
}

async function blockReply(client: HeldClient, peer: net.Socket, upstream: net.Socket) {
  client.holdWrites = true;
  const paused = once(upstream, "pause");
  peer.write(reply);
  await paused;
  assert.equal(client.writableNeedDrain, true);
  assert.ok(client.writableLength > 0);
  assert.equal(upstream.readableEnded, false, "the reply has not reached upstream EOF");
  assert.equal(upstream.destroyed, false, "the upstream is still open");
}

async function holdSmallReply(client: HeldClient, peer: net.Socket, upstream: net.Socket) {
  client.holdWrites = true;
  const held = once(client, "held");
  peer.write(smallReply);
  await held;
  assert.equal(client.writableLength, 10);
  assert.equal(client.writableNeedDrain, false, "the write is below the high-water mark");
  assert.equal(upstream.readableEnded, false);
  assert.equal(upstream.destroyed, false, "the upstream stays open without sending more bytes");
}

test(
  "an active CONNECT client that cannot drain is reset at the write budget",
  testOptions,
  async (t) => {
    const { client, peer, upstream } = await tunnel(t);
    await blockReply(client, peer, upstream);
    t.mock.timers.tick(writeBudgetMs - 1);
    assert.equal(client.destroyed, false, "the client gets its whole write budget");
    t.mock.timers.tick(1);
    assert.equal(client.destroyed, true, "active blocked output expires without upstream EOF");
    assert.equal(client.reset, true, "a cut reply must not look complete");
    assert.equal(client.writableFinished, false);
    assert.equal(upstream.destroyed, true, "expiry closes both sides");
  },
);

test(
  "small pending CONNECT writes get a fresh write budget after completion",
  testOptions,
  async (t) => {
    const { client, peer, upstream } = await tunnel(t);
    await holdSmallReply(client, peer, upstream);
    t.mock.timers.tick(writeBudgetMs - 1);
    client.release();
    await nextTurn();
    assert.deepEqual(client.body(), smallReply);

    // Completion must clear the deadline even though this write never emitted drain.
    await holdSmallReply(client, peer, upstream);
    t.mock.timers.tick(1);
    assert.equal(client.destroyed, false, "the completed write cannot shorten the next budget");
    t.mock.timers.tick(writeBudgetMs - 2);
    assert.equal(client.destroyed, false, "the client gets its whole new write budget");
    t.mock.timers.tick(1);
    assert.equal(client.destroyed, true, "a pending write expires without a drain event");
    assert.equal(client.reset, true, "a cut reply must not look complete");
    assert.equal(client.writableFinished, false);
    assert.equal(upstream.destroyed, true, "expiry closes both sides");
  },
);

test(
  "a CONNECT client that resumes within the write budget receives the complete reply",
  testOptions,
  async (t) => {
    const { client, peer, upstream } = await tunnel(t);
    t.mock.timers.tick(writeBudgetMs * 2);
    assert.equal(client.destroyed, false, "a quiet Socket Mode tunnel has no write deadline");
    await blockReply(client, peer, upstream);
    t.mock.timers.tick(writeBudgetMs - 1);
    const drained = once(client, "drain");
    client.release();
    await drained;

    // Start again before the first deadline, so a stale timer would cut this reply short.
    await blockReply(client, peer, upstream);
    t.mock.timers.tick(1);
    assert.equal(client.destroyed, false, "the first deadline cannot cut the second wait");
    t.mock.timers.tick(writeBudgetMs - 2);
    assert.equal(client.destroyed, false, "the second wait gets its whole write budget");
    const drainedAgain = once(client, "drain");
    client.release();
    await drainedAgain;
    const finished = once(client, "finish");
    peer.end("tail");
    await finished;
    assert.deepEqual(client.body(), Buffer.concat([reply, reply, Buffer.from("tail")]));
    assert.equal(client.reset, false);
    client.push(null);
    await nextTurn();
    t.mock.timers.tick(writeBudgetMs * 2);
    assert.equal(client.reset, false, "completed output never acquires a stale reset");
  },
);

test(
  "upstream EOF gives a pending CONNECT write a separate drain budget",
  testOptions,
  async (t) => {
    const { client, peer, upstream } = await tunnel(t);
    await holdSmallReply(client, peer, upstream);
    t.mock.timers.tick(writeBudgetMs - 1);
    const closed = once(upstream, "close");
    peer.end();
    await closed;
    assert.equal(client.writableEnded, true, "upstream EOF ends client output");
    assert.equal(client.writableLength, 10, "the complete reply is still queued");
    t.mock.timers.tick(writeBudgetMs - 1);
    assert.equal(client.destroyed, false, "the post-EOF drain has its own full budget");
    const finished = once(client, "finish");
    client.release();
    await finished;
    assert.deepEqual(client.body(), smallReply);
    const clientClosed = once(client, "close");
    client.push(null);
    await clientClosed;
    t.mock.timers.tick(writeBudgetMs * 2);
    assert.equal(client.reset, false, "completed output closes without a stale reset");
  },
);
