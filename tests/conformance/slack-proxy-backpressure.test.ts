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
const testOptions = { timeout: 10_000 };

// Hold actual Writable callbacks to model a full TCP send buffer without relying on
// kernel buffer sizes. The production CONNECT handler and native pipe/drain behavior run.
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
    t.mock.timers.tick(writeBudgetMs * 2);
    assert.equal(client.destroyed, false, "drain clears the old deadline");

    // A later blocked write gets a new budget; the first wait must not cut it short.
    await blockReply(client, peer, upstream);
    t.mock.timers.tick(writeBudgetMs - 1);
    assert.equal(client.destroyed, false);
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

test("client cancellation clears a pending CONNECT write wait", testOptions, async (t) => {
  const { client, peer, upstream } = await tunnel(t);
  await blockReply(client, peer, upstream);
  const closed = once(upstream, "close");
  client.destroy();
  await closed;
  t.mock.timers.tick(writeBudgetMs * 2);
  assert.equal(upstream.destroyed, true);
  assert.equal(client.reset, false, "the abandoned wait does not reset a closed client");
});
