import assert from "node:assert/strict";
import test from "node:test";
import {
  assertApplicationConnections,
  observeGrantedSend,
  singleRequestTlsOrigin,
} from "../helpers/controlled-tls-origin-scenario.ts";
import { staticEgressFixture } from "../helpers/static-egress.mjs";

type FixtureResult = Awaited<
  ReturnType<typeof staticEgressFixture<ReturnType<typeof singleRequestTlsOrigin>>>
>;
type Fixture = Extract<FixtureResult, { beginExchange: unknown }> & {
  provider: ReturnType<typeof singleRequestTlsOrigin>;
};
type Exchange = Awaited<ReturnType<Fixture["beginExchange"]>>;
type Capture = ReturnType<Fixture["capture"]>;

// Two authorized sinks multiplexed on the real TLS gRPC client connection. We own
// only this synthetic peer and downstream. The installed lane separately holds two
// real executions' replies; it does not extract or replace a supervisor's private key.
test("authorized wrong sink presents copied opening first and splices a pending real reply", async (t) => {
  const fixture = await staticEgressFixture(t, { providerServer: singleRequestTlsOrigin });
  assertObservedFixture(fixture);
  const f = fixture;
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
  const complete = await sendAllowed(a, captureA, readyA, 0);
  assertApplicationConnections(origin(), 1);
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
  await expectActualReply(freshB, await sendAllowed(freshB, captureB, readyB, sentBytes));
  assertApplicationConnections(origin(), 2);
  assert.ok(origin().decryptedBytes > sentBytes);
  assert.equal(origin().completeRequests, 2);
  assert.equal(f.providerRequests.length, 2);
  assert.ok(
    f.providerRequests.every(
      ({ authorization }) => authorization === "Bearer synthetic-key-initial",
    ),
  );

  async function sendAllowed(
    exchange: Exchange,
    capture: Capture,
    ready: unknown,
    expectedBytes: number,
  ) {
    return observeGrantedSend(
      f.provider,
      expectedBytes,
      async () => {
        exchange.stream.write({ authorize: f.permitRequest(capture, ready) });
        const { authorized } = await exchange.next();
        assert.deepEqual(authorized.allowed.response_custody, capture.response_custody);
      },
      () => f.send(capture, ready),
    );
  }
  async function expectActualReply(exchange: Exchange, completeReply: unknown) {
    assert.ok(
      completeReply && typeof completeReply === "object" && "response_complete" in completeReply,
    );
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
  const fixture = await staticEgressFixture(t, { providerServer: singleRequestTlsOrigin });
  assertObservedFixture(fixture);
  const f = fixture;
  const before = f.secretReads;
  // Cross both signed openings *before* either is presented to the proper sink.
  // Check authority refusals and material access. Origin counters also detect
  // unexpected background traffic; this case does not invoke an outbound sender.
  const [left, right] = await Promise.all([f.beginExchange(), f.beginExchange()]);
  const swapped: [Exchange, ReturnType<Exchange["opening"]>][] = [
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
  ] satisfies [typeof a, typeof a][]) {
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

async function expectStreamRefused(
  exchange: Exchange,
  message: ReturnType<Exchange["opening"]> | { response: unknown },
) {
  exchange.stream.write(message);
  await assert.rejects(exchange.next(), { code: 7, details: "Installation exchange refused." });
  assert.deepEqual(
    exchange.received.map(({ event }) => event),
    ["challenge"],
  );
}

async function openExchange(f: Fixture, metadata?: unknown) {
  const exchange = await f.beginExchange(metadata);
  const capture = f.capture();
  exchange.stream.write(exchange.opening(capture));
  const { resolved } = await exchange.next();
  assert.ok(resolved.ready);
  return { exchange, capture, ready: resolved.ready };
}

function assertObservedFixture(fixture: FixtureResult): asserts fixture is Fixture {
  assert.ok("beginExchange" in fixture);
  assert.ok("snapshot" in fixture.provider);
}
