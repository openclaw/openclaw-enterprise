import { once } from "node:events";
import { connect } from "node:tls";
import { harnessTlsFixture } from "../helpers/harness-tls.mjs";
import { listen } from "../helpers/listen.mjs";

import assert from "node:assert/strict";
import test from "node:test";
import { controlledTlsOrigin } from "../helpers/controlled-tls-origin.ts";
import { staticEgressFixture } from "../helpers/static-egress.mjs";

// Two authorized sinks multiplexed on the real TLS gRPC client connection. We own
// only this synthetic peer and downstream. The installed lane separately holds two
// real executions' replies; it does not extract or replace a supervisor's private key.
test("authorized wrong sink presents copied opening first and splices a pending real reply", async (t) => {
  const f = await staticEgressFixture(t, { providerServer: controlledTlsOrigin });
  const origin = () => f.provider.snapshot().completeRequests;
  const before = f.secretReads;
  const lostBearer = f.metadata();
  const a = await f.beginExchange(lostBearer);
  const b = await f.beginExchange(lostBearer);
  const captureA = f.capture();
  const copiedOpening = a.opening(captureA);
  assert.notDeepEqual(a.challenge, b.challenge);

  // Present the exact signed bytes on B *before* A opens, not a replay after
  // consumption. B got a challenge, but no access, material, permit or response.
  b.stream.write(copiedOpening);
  await assert.rejects(b.next(), { code: 7, details: "Installation exchange refused." });
  assert.deepEqual(
    b.received.map(({ event }) => event),
    ["challenge"],
  );
  assert.deepEqual(
    a.received.map(({ event }) => event),
    ["challenge"],
  );
  assert.equal(f.secretReads, before);
  assert.equal(origin(), 0);

  // Same bytes on their original sink succeed. We now hold the complete real
  // provider reply, not an invented result, and put it on another B stream first.
  a.stream.write(copiedOpening);
  const readyA = (await a.next()).resolved.ready;
  assert.ok(readyA);
  assert.equal(f.secretReads, before + 1);
  const allowedWindow = f.provider.mark();
  const complete = await sendAllowed(a, captureA, readyA);
  assert.equal(f.provider.since(allowedWindow).completeRequests, 1);
  assert.ok(f.provider.since(allowedWindow).decryptedBytes > 0);
  const thief = await f.beginExchange(lostBearer);
  thief.stream.write({ response: complete });
  await assert.rejects(thief.next(), { code: 7, details: "Installation exchange refused." });
  assert.deepEqual(
    thief.received.map(({ event }) => event),
    ["challenge"],
  );
  assert.equal(a.received.filter(({ response }) => response).length, 0);
  assert.equal(f.secretReads, before + 1);
  assert.equal(origin(), 1);

  // Deliver the held response to A, then prove B with the same authenticated
  // identity, on this very connection and with its own opening, is authorized.
  await expectActualReply(a, complete);
  const freshB = await f.beginExchange(lostBearer);
  const captureB = f.capture();
  freshB.stream.write(freshB.opening(captureB));
  const readyB = (await freshB.next()).resolved.ready;
  assert.ok(readyB);
  assert.equal(f.secretReads, before + 2);
  await expectActualReply(freshB, await sendAllowed(freshB, captureB, readyB));
  assert.equal(origin(), 2);
  assert.equal(f.providerRequests.length, 2);
  assert.ok(
    f.providerRequests.every(
      ({ authorization }) => authorization === "Bearer synthetic-key-initial",
    ),
  );

  async function sendAllowed(exchange, capture, ready) {
    exchange.stream.write({ authorize: f.permitRequest(capture, ready) });
    const { authorized } = await exchange.next();
    assert.deepEqual(authorized.allowed.response_custody, capture.response_custody);
    return f.send(capture, ready);
  }
  async function expectActualReply(exchange, completeReply) {
    assert.equal(completeReply.response_complete, true);
    exchange.stream.write({ response: completeReply });
    const { response } = await exchange.next();
    assert.equal(response.status, 200);
    assert.equal(response.response_complete, true);
    assert.deepEqual(JSON.parse(response.body), { output: "fixture answer" });
    assert.deepEqual(
      exchange.received.map(({ event }) => event),
      ["challenge", "resolved", "authorized", "response"],
    );
  }
});

test("two live authorized streams cannot cross their resolved dispatch handles", async (t) => {
  const f = await staticEgressFixture(t, { providerServer: controlledTlsOrigin });
  const before = f.secretReads;
  // Cross both signed openings *before* either is presented to the proper sink.
  // Two explicit refusals, no access/material or send permits and no provider bytes.
  const [left, right] = await Promise.all([f.beginExchange(), f.beginExchange()]);
  const swapped = [
    [left, right.opening(f.capture())],
    [right, left.opening(f.capture())],
  ];
  for (const [sink, wrongOpening] of swapped) {
    sink.stream.write(wrongOpening);
    await assert.rejects(sink.next(), { code: 7, details: "Installation exchange refused." });
    assert.deepEqual(
      sink.received.map(({ event }) => event),
      ["challenge"],
    );
  }
  assert.equal(f.secretReads, before);
  assert.equal(f.provider.snapshot().completeRequests, 0);
  const [a, b] = await Promise.all([open(), open()]);
  assert.equal(f.secretReads, before + 2, "two actual authorized material reads before the splice");
  assert.notDeepEqual(a.capture.response_custody, b.capture.response_custody);
  for (const [wrong, original] of [
    [b, a],
    [a, b],
  ]) {
    wrong.stream.write({ authorize: f.permitRequest(original.capture, original.ready) });
    const { authorized } = await wrong.next();
    assert.ok(authorized.refused);
    assert.deepEqual(
      wrong.received.map(({ event }) => event),
      ["challenge", "resolved", "authorized"],
    );
  }
  assert.equal(f.secretReads, before + 2, "splicing released no further material");
  assert.equal(f.provider.snapshot().completeRequests, 0);
  assert.equal(
    f.provider.snapshot().decryptedBytes,
    0,
    "neither crossed dispatch sent TLS application bytes",
  );
  async function open() {
    const exchange = await f.beginExchange();
    const capture = f.capture();
    exchange.stream.write(exchange.opening(capture));
    const { resolved } = await exchange.next();
    assert.ok(resolved.ready);
    return { ...exchange, capture, ready: resolved.ready };
  }
});

// Observer qualification uses real loopback TLS, independently of the authority fixture.
const request = "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\nok";

async function fixture(t) {
  const tls = await harnessTlsFixture(t);
  const origin = controlledTlsOrigin(tls, (req, res) => {
    req.on("end", () => res.end("ok"));
  });
  const port = await listen(t, origin);
  return {
    origin,
    async client() {
      const socket = connect({
        host: "127.0.0.1",
        port,
        servername: "localhost",
        ca: tls.caBundle,
      });
      t.after(() => socket.destroy());
      await once(socket, "secureConnect");
      assert.equal(socket.authorized, true);
      return socket;
    },
  };
}

// Register before an action; the condition is checked again at each real server
// event. Timeouts fail with content-free counters, never wire data or TLS errors.
function observed(origin, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      origin.off("observation", check);
      reject(new Error(`Origin observation timed out: ${JSON.stringify(origin.snapshot())}`));
    }, 3000);
    function check() {
      const value = origin.snapshot();
      if (!predicate(value)) return;
      clearTimeout(timer);
      origin.off("observation", check);
      resolve(value);
    }
    origin.on("observation", check);
    check();
  });
}

async function completedReply(socket) {
  let received = "";
  for await (const chunk of socket.iterator({ destroyOnReturn: false })) {
    received += chunk.toString();
    if (received.endsWith("\r\n\r\nok")) return;
  }
  throw new Error("Origin reply ended before completion.");
}

for (const partial of [
  "POST / HTTP/1.1\r\nAuthorization: synthetic",
  "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 20\r\n\r\npartial",
]) {
  test(
    `TLS origin counts partial ${partial.endsWith("partial") ? "body" : "headers"} after a drained reusable connection barrier`,
    { timeout: 10000 },
    async (t) => {
      const { origin, client } = await fixture(t);
      const socket = await client();
      const reply = completedReply(socket);
      socket.write(request);
      await reply;
      assert.equal(origin.snapshot().completeRequests, 1);
      assert.equal(origin.snapshot().decryptedBytes, Buffer.byteLength(request));
      const socketId = origin.snapshot().connections[0].socketId;
      // The complete reply acknowledges consumption of the first request. The
      // sender now waits at our explicit barrier; only the release sends more.
      const release = Promise.withResolvers();
      const sent = release.promise.then(() => socket.write(partial));
      const mark = origin.mark();
      assert.equal(origin.since(mark).decryptedBytes, 0);
      const bytes = observed(
        origin,
        (s) => s.decryptedBytes === Buffer.byteLength(request + partial),
      );
      release.resolve();
      await sent;
      await bytes;
      assert.deepEqual(origin.since(mark), {
        decryptedBytes: Buffer.byteLength(partial),
        completeRequests: 0,
        connections: [
          { socketId, decryptedBytes: Buffer.byteLength(partial), completeRequests: 0 },
        ],
      });
      assert.equal(
        origin.snapshot().connections.length,
        1,
        "the partial request reused the authenticated socket",
      );
      const closed = once(socket, "close");
      socket.destroy();
      await closed;
      assert.equal(origin.since(mark).decryptedBytes, Buffer.byteLength(partial));
    },
  );
}

test(
  "TLS origin counts complete requests across sockets and rejects a duplicate positive oracle",
  { timeout: 10000 },
  async (t) => {
    const { origin, client } = await fixture(t);
    const first = await client();
    const mark = origin.mark();
    let reply = completedReply(first);
    first.write(request);
    await reply;
    assert.equal(origin.since(mark).completeRequests, 1);
    assert.equal(origin.since(mark).decryptedBytes, Buffer.byteLength(request));
    const second = await client();
    reply = completedReply(second);
    second.write(request);
    await reply;
    assert.equal(
      origin.since(mark).completeRequests,
      2,
      "a second socket must not hide a duplicate",
    );
    assert.equal(origin.since(mark).decryptedBytes, 2 * Buffer.byteLength(request));
    assert.deepEqual(
      origin.snapshot().connections.map((row) => row.completeRequests),
      [1, 1],
    );
    reply = completedReply(first);
    first.write(request);
    await reply;
    assert.equal(
      origin.since(mark).completeRequests,
      3,
      "a reused socket must not hide a duplicate",
    );
  },
);

test(
  "TLS handshake alone has zero application bytes; a new connection's partial request is counted",
  { timeout: 10000 },
  async (t) => {
    const { origin, client } = await fixture(t);
    const mark = origin.mark();
    const socket = await client();
    await observed(origin, (s) => s.connections.length === 1);
    assert.equal(origin.since(mark).decryptedBytes, 0);
    assert.equal(origin.since(mark).completeRequests, 0);
    const partial = "GET /";
    const bytes = observed(origin, (s) => s.decryptedBytes === Buffer.byteLength(partial));
    socket.write(partial);
    await bytes;
    assert.equal(origin.since(mark).decryptedBytes, Buffer.byteLength(partial));
    assert.equal(origin.since(mark).completeRequests, 0);
  },
);

test(
  "TLS origin does not count headers as a completed request and counts pipelined requests separately",
  { timeout: 10000 },
  async (t) => {
    const { origin, client } = await fixture(t);
    const socket = await client();
    const headers = request.slice(0, -2);
    const headersSeen = observed(origin, (s) => s.decryptedBytes === Buffer.byteLength(headers));
    socket.write(headers);
    await headersSeen;
    assert.equal(origin.snapshot().completeRequests, 0);
    const completed = observed(origin, (s) => s.completeRequests === 2);
    socket.write("ok" + request);
    await completed;
    assert.equal(origin.snapshot().decryptedBytes, 2 * Buffer.byteLength(request));
    assert.deepEqual(
      origin.snapshot().connections.map((row) => row.completeRequests),
      [2],
    );
  },
);

test("withdrawal acknowledged after resolution refuses send with zero additional origin bytes", async (t) => {
  const f = await staticEgressFixture(t, { providerServer: controlledTlsOrigin });
  const first = f.capture();
  const initial = await f.resolve(first);
  assert.ok(initial.ready);
  assert.ok((await f.authorize(f.permitRequest(first, initial.ready))).allowed);
  await f.send(first, initial.ready);
  assert.equal(f.provider.snapshot().completeRequests, 1);

  const next = f.capture();
  const reads = f.secretReads;
  const resolved = await f.resolve(next);
  assert.ok(resolved.ready);
  assert.equal(f.secretReads, reads + 1);
  // Awaited resolution is the deterministic pre-authorization barrier in this
  // component fixture. This is not a claim about an installed sender's barrier.
  const mark = f.provider.mark();
  await f.revoke();
  assert.ok((await f.authorize(f.permitRequest(next, resolved.ready))).refused);
  assert.equal(f.provider.since(mark).completeRequests, 0);
  assert.equal(f.provider.since(mark).decryptedBytes, 0);
});
