import assert from "node:assert/strict";
import { once } from "node:events";
import { Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer } from "node:https";
import { buffer } from "node:stream/consumers";
import test from "node:test";
import type { TLSSocket } from "node:tls";
import {
  assertApplicationConnections,
  assertSingleRequestWindow,
  controlledTlsOriginScenario,
  observeGrantedSend,
  singleRequestTlsOrigin,
  tlsOriginPeer,
  writeAndDrain,
} from "../helpers/controlled-tls-origin-scenario.ts";
import { controlledTlsOrigin } from "../helpers/controlled-tls-origin.ts";

// TODO: The sender integration owner must qualify denied-send acceptance with
// an actual product sender. f.send is test-owned transport, so skipping it after
// an authority refusal cannot prove that a sender suppresses outbound bytes.
// These controls qualify only the observer using real loopback TLS.
const request = "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\nok";
const incomplete = "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\nx";
const servers = {
  ordinary: createServer,
  observer: controlledTlsOrigin,
  capped: singleRequestTlsOrigin,
} as const;

for (const size of [14, 256 * 1024]) {
  for (const kind of ["ordinary", "observer"] as const) {
    test(
      `TLS ${kind} preserves ${size} bytes for a delayed consumer`,
      { timeout: 5000 },
      async (t) => {
        const entered = Promise.withResolvers<void>();
        const proceed = Promise.withResolvers<void>();
        const consumed = Promise.withResolvers<Buffer>();
        const peer = await tlsOriginPeer(t, (tls) =>
          servers[kind](tls, async (incoming, response) => {
            incoming.pause();
            entered.resolve();
            await proceed.promise;
            try {
              consumed.resolve(await buffer(incoming));
              response.end("ok");
            } catch (error) {
              consumed.reject(error);
            }
          }),
        );
        const client = await peer.connect();
        const body = Buffer.alloc(size, "x");
        const headers = `POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${body.length}\r\n\r\n`;
        client.write(Buffer.concat([Buffer.from(headers), body]));
        await entered.promise;
        // Let queued stream work run before the handler consumes; the larger body exercises backpressure.
        await new Promise<void>((resolve) => setImmediate(resolve));
        proceed.resolve();
        assert.deepEqual(await consumed.promise, body);
        if ("snapshot" in peer.origin) {
          assert.equal(peer.origin.snapshot().completeRequests, 1);
          assert.equal(peer.origin.snapshot().decryptedBytes, Buffer.byteLength(headers) + size);
        }
      },
    );
  }
}

for (const [part, partial] of [
  ["headers", "POST / HTTP/1.1\r\nAuthorization: synthetic"],
  ["body", "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 20\r\n\r\npartial"],
] as const) {
  test(`TLS observer counts partial ${part} on a reused socket`, { timeout: 5000 }, async (t) => {
    const peer = await controlledTlsOriginScenario(t);
    const client = await peer.connect();
    await writeAndDrain(client, request);
    const initial = peer.origin.snapshot();
    assert.equal(initial.completeRequests, 1);
    assert.equal(initial.decryptedBytes, Buffer.byteLength(request));
    // The drained reply acknowledges the first request before the test-owned next write.
    const mark = peer.origin.mark();
    await peer.writeAndObserve(
      client,
      partial,
      (s) => s.decryptedBytes === initial.decryptedBytes + Buffer.byteLength(partial),
    );
    const delta = peer.origin.since(mark);
    assert.equal(delta.decryptedBytes, Buffer.byteLength(partial));
    assert.equal(delta.completeRequests, 0);
    assert.equal(delta.droppedRequests, 0);
    assert.deepEqual(delta.connections, [
      {
        socketId: initial.connections[0]?.socketId,
        decryptedBytes: Buffer.byteLength(partial),
        completeRequests: 0,
        droppedRequests: 0,
      },
    ]);
    const closed = once(client, "close");
    client.destroy();
    await closed;
    assert.equal(peer.origin.since(mark).decryptedBytes, delta.decryptedBytes);
  });
}

test(
  "TLS allowed-send distinguishes handshake, single send, and a second socket fragment",
  { timeout: 5000 },
  async (t) => {
    const peer = await controlledTlsOriginScenario(t);
    const complete = await peer.connect();
    const fragment = await peer.connect();
    await peer.observe((s) => s.connections.length === 2);
    assert.equal(peer.origin.snapshot().decryptedBytes, 0);
    const positive = peer.origin.mark();
    await writeAndDrain(complete, request);
    assertSingleRequestWindow(peer.origin.since(positive));
    const mixed = peer.origin.mark();
    const before = peer.origin.snapshot().decryptedBytes;
    await peer.writeAndObserve(fragment, "GET /", (s) => s.decryptedBytes === before + 5);
    await writeAndDrain(complete, request);
    const observation = peer.origin.since(mixed);
    assert.equal(observation.completeRequests, 1);
    assert.deepEqual(
      observation.connections.map(({ completeRequests }) => completeRequests),
      [1, 0],
    );
    assert.equal(observation.connections[1]?.decryptedBytes, 5);
    assert.throws(
      () => assertSingleRequestWindow(observation),
      /one application-bearing connection/,
    );
    await writeAndDrain(fragment, " HTTP/1.1\r\nHost: localhost\r\n\r\n");
    assert.deepEqual(
      peer.origin.snapshot().connections.map(({ completeRequests }) => completeRequests),
      [2, 1],
    );
  },
);

for (const kind of ["ordinary", "observer"] as const) {
  test(`TLS ${kind} delivers an incomplete request timeout`, { timeout: 3000 }, async (t) => {
    let callbacks = 0;
    const peer = await tlsOriginPeer(t, (tls) =>
      servers[kind](tls, (incoming) => {
        incoming.setTimeout(30, () => {
          callbacks++;
          incoming.destroy();
        });
        incoming.resume();
      }),
    );
    const client = await peer.connect();
    const closed = once(client, "close");
    client.write(incomplete);
    await closed;
    assert.equal(callbacks, 1, "the HTTP timeout, not teardown, closes the incomplete request");
    if ("snapshot" in peer.origin) {
      assert.equal(peer.origin.snapshot().completeRequests, 0);
    }
  });
}

test(
  "TLS observer socket timeout retains receiver and once semantics",
  { timeout: 3000 },
  async (t) => {
    let callbacks = 0;
    let events = 0;
    const peer = await tlsOriginPeer(t, (tls) =>
      controlledTlsOrigin(tls, (incoming) => {
        const socket = incoming.socket;
        // Keep HTTP from closing on the first expiry so a second real event proves callback-once behavior.
        incoming.on("timeout", () => {});
        socket.setTimeout(30, function (this: typeof socket) {
          assert.equal(this, socket);
          callbacks++;
        });
        socket.on("timeout", () => {
          if (++events === 1) {
            socket.setTimeout(30);
          } else {
            socket.destroy();
          }
        });
        incoming.resume();
      }),
    );
    const client = await peer.connect();
    const closed = once(client, "close");
    client.write(incomplete);
    await closed;
    assert.equal(events, 2);
    assert.equal(callbacks, 1);
  },
);

test("TLS observer closes idle keep-alive through HTTP timeout", { timeout: 10000 }, async (t) => {
  const peer = await controlledTlsOriginScenario(t);
  const client = await peer.connect();
  const closed = once(client, "close");
  await writeAndDrain(client, request);
  client.resume();
  await closed;
  assert.equal(peer.origin.snapshot().completeRequests, 1);
});

test(
  "TLS fixture acknowledgement rejects wrong status and incomplete reply",
  { timeout: 5000 },
  async (t) => {
    for (const [status, length, expected] of [
      [503, 2, /fixture reply status/],
      [200, 3, /fixture reply Content-Length/],
    ] as const) {
      const peer = await tlsOriginPeer(t, (tls) =>
        createServer(tls, (incoming, response) => {
          incoming.resume();
          response.writeHead(status, { "Content-Length": length, Connection: "close" });
          response.end("ok");
        }),
      );
      await assert.rejects(writeAndDrain(await peer.connect(), request), expected);
    }
  },
);

for (const [priorSend, phase] of [
  [false, "before request"],
  [true, "awaiting grant"],
  [false, "after grant"],
  [true, "after grant"],
] as const) {
  test(
    `TLS granted send ${phase} with ${priorSend ? "acknowledged" : "zero"} baseline`,
    { timeout: 5000 },
    async (t) => {
      const peer = await controlledTlsOriginScenario(t);
      if (priorSend) {
        await writeAndDrain(await peer.connect(), request);
      }
      const baseline = peer.origin.snapshot().decryptedBytes;
      const client = await peer.connect();
      const earlyBytes = () =>
        peer.writeAndObserve(client, "\r\n", (s) => s.decryptedBytes === baseline + 2);
      if (phase === "before request") {
        await earlyBytes();
      }
      const grant = Promise.withResolvers<void>();
      const requested = Promise.withResolvers<void>();
      let sends = 0;
      // The gate controls test-owned grant delivery, not IAM behavior.
      const pending = observeGrantedSend(
        peer.origin,
        baseline,
        async () => {
          requested.resolve();
          await grant.promise;
        },
        () => {
          sends++;
          return writeAndDrain(client, request);
        },
      );
      await requested.promise;
      if (phase === "awaiting grant") {
        await earlyBytes();
      }
      const result =
        phase === "after grant"
          ? pending.then((acknowledgement) => assert.equal(acknowledgement, "ok"))
          : assert.rejects(pending, /origin bytes changed before granted send/);
      grant.resolve();
      await result;
      assert.equal(sends, phase === "after grant" ? 1 : 0);
      assert.equal(peer.origin.snapshot().completeRequests, Number(priorSend) + sends);
      if (sends === 0) {
        assert.equal(peer.origin.snapshot().decryptedBytes, baseline + 2);
      }
    },
  );
}

async function pipeline(client: TLSSocket): Promise<string[]> {
  // Both requests reach the parser in one write, before either reply.
  client.write(
    "GET /ok HTTP/1.1\r\nHost: localhost\r\n\r\nGET /unexpected HTTP/1.1\r\nHost: localhost\r\n\r\n",
  );
  let reply = "";
  for await (const chunk of client.iterator({ destroyOnReturn: false })) {
    reply += chunk.toString();
    const statuses = [...reply.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((match) => match[1]!);
    if (statuses.length === 2) {
      assert.match(reply, /^HTTP\/1\.1 200[^\r]*\r\n(?:[^\r]*\r\n)*\r\nokHTTP\/1\.1 /);
      return statuses;
    }
  }
  throw new Error("Pipeline ended before two replies.");
}

for (const [kind, statuses, dispatched, drops] of [
  ["observer", ["200", "200"], ["/ok", "/unexpected"], 0],
  ["capped", ["200", "503"], ["/ok"], 1],
] as const) {
  test(`TLS ${kind} accounts for a pipelined pair`, { timeout: 5000 }, async (t) => {
    const handled: string[] = [];
    const peer = await tlsOriginPeer(t, (tls) =>
      servers[kind](tls, (incoming, response) => {
        handled.push(incoming.url ?? "");
        incoming.resume();
        response.end("ok");
      }),
    );
    const client = await peer.connect();
    const mark = peer.origin.mark();
    let replies: string[] = [];
    const send = async () => {
      replies = await pipeline(client);
    };
    if (drops) {
      await assert.rejects(
        observeGrantedSend(peer.origin, 0, async () => {}, send),
        /no native parser drops/,
      );
    } else {
      await send();
    }
    assert.deepEqual(replies, statuses);
    assert.deepEqual(handled, dispatched);
    assert.equal(peer.origin.snapshot().completeRequests, dispatched.length);
    assert.equal(peer.origin.snapshot().droppedRequests, drops);
    assert.equal(peer.origin.since(mark).droppedRequests, drops);
    if (drops) {
      const closed = once(client, "close");
      client.destroy();
      await closed;
      const afterDrop = peer.origin.mark();
      await writeAndDrain(await peer.connect(), request);
      assertSingleRequestWindow(peer.origin.since(afterDrop));
      assert.throws(
        () => assertApplicationConnections(peer.origin.snapshot(), 2),
        /no native parser drops/,
      );
      assert.deepEqual(
        peer.origin.snapshot().connections.map(({ droppedRequests }) => droppedRequests),
        [1, 0],
      );
    }
  });
}

for (const [kind, behavior] of [
  ["ordinary", "answer"],
  ["observer", "answer"],
  ["capped", "answer"],
  ["observer", "consume"],
] as const) {
  test(
    `TLS ${kind} ${behavior} listener retains receiver and registration`,
    { timeout: 5000 },
    async (t) => {
      const receivers: HttpServer[] = [];
      let registrations = 0;
      const chunks: Buffer[] = [];
      function handle(this: HttpServer, incoming: IncomingMessage, response: ServerResponse) {
        receivers.push(this);
        registrations = this.listeners("request").filter((listener) => listener === handle).length;
        if (behavior === "consume") {
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
          incoming.on("end", () => response.end("ok"));
        } else {
          response.end("ok");
        }
      }
      const peer = await tlsOriginPeer(t, (tls) => servers[kind](tls, handle));
      await writeAndDrain(await peer.connect(), request);
      assert.equal(registrations, 1);
      const receiver = receivers[0];
      if (kind === "ordinary") {
        assert.equal(receiver, peer.origin);
      } else {
        assert.ok(receiver instanceof HttpServer);
        assert.equal(receiver.maxRequestsPerSocket, kind === "capped" ? 1 : 0);
        assert.ok("snapshot" in peer.origin);
        assert.equal(peer.origin.snapshot().completeRequests, 1);
      }
      if (behavior === "consume") {
        assert.equal(Buffer.concat(chunks).toString(), "ok");
      }
    },
  );
}
