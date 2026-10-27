import assert from "node:assert/strict";
import test from "node:test";
import { custodyOriginWire } from "../fixtures/egress-custody-origin-wire.mjs";
import { staticEgressFixture } from "../helpers/static-egress.mjs";

// Two authorized sinks multiplexed on the real TLS gRPC client connection. We own
// only this synthetic peer and downstream. The installed lane separately holds two
// real executions' replies; it does not extract or replace a supervisor's private key.
test("authorized wrong sink presents copied opening first and splices a pending real reply", async (t) => {
  const f = await staticEgressFixture(t, { providerServer: custodyOriginWire });
  const origin = () => f.provider.wireCount();
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
  const complete = await sendAllowed(a, captureA, readyA);
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
  const f = await staticEgressFixture(t, { providerServer: custodyOriginWire });
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
  assert.equal(f.provider.wireCount(), 0);
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
  assert.equal(f.provider.wireCount(), 0, "neither crossed dispatch reached the pre-parse origin");
  async function open() {
    const exchange = await f.beginExchange();
    const capture = f.capture();
    exchange.stream.write(exchange.opening(capture));
    const { resolved } = await exchange.next();
    assert.ok(resolved.ready);
    return { ...exchange, capture, ready: resolved.ready };
  }
});
