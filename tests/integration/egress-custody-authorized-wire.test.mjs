import { once } from "node:events";
import assert from "node:assert/strict";
import test from "node:test";
import { controlledTlsOrigin } from "../helpers/controlled-tls-origin.ts";
import { controlledTlsOriginScenario } from "../helpers/controlled-tls-origin-scenario.ts";
import { staticEgressFixture } from "../helpers/static-egress.mjs";

// Two authorized sinks multiplexed on the real TLS gRPC client connection. We own
// only this synthetic peer and downstream. The installed lane separately holds two
// real executions' replies; it does not extract or replace a supervisor's private key.
test("authorized wrong sink presents copied opening first and splices a pending real reply", async (t) => {
  const f = await staticEgressFixture(t, { providerServer: controlledTlsOrigin });
  const origin = () => f.provider.snapshot();
  const before = f.secretReads;
  const lostBearer = f.metadata();
  const a = await f.beginExchange(lostBearer);
  const b = await f.beginExchange(lostBearer);
  const captureA = f.capture();
  const copiedOpening = a.opening(captureA);
  assert.notDeepEqual(a.challenge, b.challenge);

  // Present the exact signed bytes on B *before* A opens, not a replay after
  // consumption. B got a challenge, but no access, material, permit or response.
  await expectStreamRefused(b, copiedOpening);
  assert.deepEqual(
    a.received.map(({ event }) => event),
    ["challenge"],
  );
  assert.equal(f.secretReads, before);
  assert.equal(origin().decryptedBytes, 0);

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
  const sentBytes = origin().decryptedBytes;
  const thief = await f.beginExchange(lostBearer);
  await expectStreamRefused(thief, { response: complete });
  assert.equal(a.received.filter(({ response }) => response).length, 0);
  assert.equal(f.secretReads, before + 1);
  assert.equal(origin().decryptedBytes, sentBytes);
  assert.equal(origin().completeRequests, 1);

  // Deliver the held response to A, then prove B with the same authenticated
  // identity, on this very connection and with its own opening, is authorized.
  await expectActualReply(a, complete);
  const { exchange: freshB, capture: captureB, ready: readyB } = await openExchange(f, lostBearer);
  assert.equal(f.secretReads, before + 2);
  assert.equal(origin().decryptedBytes, sentBytes);
  await expectActualReply(freshB, await sendAllowed(freshB, captureB, readyB));
  assert.ok(origin().decryptedBytes > sentBytes);
  assert.equal(origin().completeRequests, 2);
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
  // Check authority refusals and material access. Origin counters also detect
  // unexpected background traffic; this case does not invoke an outbound sender.
  const [left, right] = await Promise.all([f.beginExchange(), f.beginExchange()]);
  const swapped = [
    [left, right.opening(f.capture())],
    [right, left.opening(f.capture())],
  ];
  for (const [sink, wrongOpening] of swapped) {
    await expectStreamRefused(sink, wrongOpening);
  }
  assert.equal(f.secretReads, before);
  assert.equal(f.provider.snapshot().decryptedBytes, 0);
  const [a, b] = await Promise.all([openExchange(f), openExchange(f)]);
  assert.equal(f.secretReads, before + 2, "two actual authorized material reads before the splice");
  assert.notDeepEqual(a.capture.response_custody, b.capture.response_custody);
  for (const [wrong, original] of [
    [b, a],
    [a, b],
  ]) {
    wrong.exchange.stream.write({ authorize: f.permitRequest(original.capture, original.ready) });
    const { authorized } = await wrong.exchange.next();
    assert.ok(authorized.refused);
    assert.deepEqual(
      wrong.exchange.received.map(({ event }) => event),
      ["challenge", "resolved", "authorized"],
    );
  }
  assert.equal(f.secretReads, before + 2, "splicing released no further material");
  assert.equal(f.provider.snapshot().decryptedBytes, 0, "unexpected origin traffic");
});

async function expectStreamRefused(exchange, message) {
  exchange.stream.write(message);
  await assert.rejects(exchange.next(), { code: 7, details: "Installation exchange refused." });
  assert.deepEqual(
    exchange.received.map(({ event }) => event),
    ["challenge"],
  );
}

async function openExchange(f, metadata) {
  const exchange = await f.beginExchange(metadata);
  const capture = f.capture();
  exchange.stream.write(exchange.opening(capture));
  const { resolved } = await exchange.next();
  assert.ok(resolved.ready);
  return { exchange, capture, ready: resolved.ready };
}

// TODO: The sender integration owner must qualify denied-send acceptance with
// an actual product sender. f.send is test-owned transport, so skipping it after
// an authority refusal cannot prove that a sender suppresses outbound bytes.
// The following controls qualify only the observer using real loopback TLS.
const request = "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\nok";

for (const [part, partial] of [
  ["headers", "POST / HTTP/1.1\r\nAuthorization: synthetic"],
  ["body", "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 20\r\n\r\npartial"],
]) {
  test(
    `TLS origin counts partial ${part} after a drained reusable connection barrier`,
    { timeout: 10000 },
    async (t) => {
      const scenario = await controlledTlsOriginScenario(t);
      const { origin } = scenario;
      const socket = await scenario.connect();
      await scenario.writeAndDrain(socket, request);
      assert.equal(origin.snapshot().completeRequests, 1);
      assert.equal(origin.snapshot().decryptedBytes, Buffer.byteLength(request));
      const socketId = origin.snapshot().connections[0].socketId;
      // The complete reply acknowledges the first request. This test owns the
      // next write, so marking before it is a deterministic instrument barrier.
      const mark = origin.mark();
      assert.equal(origin.since(mark).decryptedBytes, 0);
      await scenario.writeAndObserve(
        socket,
        partial,
        (s) => s.decryptedBytes === Buffer.byteLength(request + partial),
      );
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
  "TLS observer counts duplicate complete requests on new and reused sockets",
  { timeout: 10000 },
  async (t) => {
    const scenario = await controlledTlsOriginScenario(t);
    const { origin } = scenario;
    const first = await scenario.connect();
    const mark = origin.mark();
    await scenario.writeAndDrain(first, request);
    assert.equal(origin.since(mark).completeRequests, 1);
    assert.equal(origin.since(mark).decryptedBytes, Buffer.byteLength(request));
    const second = await scenario.connect();
    await scenario.writeAndDrain(second, request);
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
    await scenario.writeAndDrain(first, request);
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
    const scenario = await controlledTlsOriginScenario(t);
    const { origin } = scenario;
    const mark = origin.mark();
    const socket = await scenario.connect();
    await scenario.observe((s) => s.connections.length === 1);
    assert.equal(origin.since(mark).decryptedBytes, 0);
    assert.equal(origin.since(mark).completeRequests, 0);
    const partial = "GET /";
    await scenario.writeAndObserve(
      socket,
      partial,
      (s) => s.decryptedBytes === Buffer.byteLength(partial),
    );
    assert.equal(origin.since(mark).decryptedBytes, Buffer.byteLength(partial));
    assert.equal(origin.since(mark).completeRequests, 0);
  },
);

test(
  "TLS origin does not count headers as a completed request and counts pipelined requests separately",
  { timeout: 10000 },
  async (t) => {
    const scenario = await controlledTlsOriginScenario(t);
    const { origin } = scenario;
    const socket = await scenario.connect();
    const headers = request.slice(0, -2);
    await scenario.writeAndObserve(
      socket,
      headers,
      (s) => s.decryptedBytes === Buffer.byteLength(headers),
    );
    assert.equal(origin.snapshot().completeRequests, 0);
    await scenario.writeAndObserve(socket, "ok" + request, (s) => s.completeRequests === 2);
    assert.equal(origin.snapshot().decryptedBytes, 2 * Buffer.byteLength(request));
    assert.deepEqual(
      origin.snapshot().connections.map((row) => row.completeRequests),
      [2],
    );
  },
);
