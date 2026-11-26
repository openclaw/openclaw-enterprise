import assert from "node:assert/strict";
import test from "node:test";
import {
  assertApplicationConnections,
  observeGrantedSend,
  singleRequestTlsOrigin,
} from "../helpers/controlled-tls-origin-scenario.ts";
import { protectedMetadataFixture } from "../helpers/static-egress.mjs";
import { captureMetadata } from "../helpers/github-metadata-exchange.mjs";
import type { createStaticEgressExchange, Exchange } from "../helpers/static-egress-exchange.ts";
import type { Resolution, ResponseFrame } from "../helpers/static-egress-exchange-wire.ts";
import { parseJson } from "../helpers/egress-observation-values.ts";

type Fixture = ReturnType<typeof createStaticEgressExchange>;
type MetadataPermit = NonNullable<Resolution["ready_without_material"]>;
type Capture = ReturnType<Fixture["capture"]>;

// Two authorized sinks multiplexed on the real TLS gRPC client connection. We own
// only this synthetic peer and downstream. The installed lane separately holds two
// real executions' replies; it does not extract or replace a supervisor's private key.
test("authorized wrong sink presents copied opening first and splices a pending real reply", async (t) => {
  const fixture = await protectedMetadataFixture(t, { providerServer: singleRequestTlsOrigin });
  const f = fixture.exchange;
  assert.ok("snapshot" in f.provider);
  const { provider } = f;
  const origin = () => provider.snapshot();
  const before = f.secretReads;
  const lostBearer = f.metadata();
  const a = await f.beginExchange(lostBearer);
  const b = await f.beginExchange(lostBearer);
  fixture.setResponse({ status: 200, body: { id: 7311, full_name: "fixture/credential-free" } });
  const captureA = captureMetadata(fixture);
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
  const resolvedA = await a.next();
  assert.equal(resolvedA.event, "resolved");
  const readyA = resolvedA.resolved.ready_without_material;
  assert.ok(readyA);
  assert.equal(f.secretReads, before);
  const complete = await sendAllowed(a, captureA, readyA, 0);
  assertApplicationConnections(origin(), 1);
  const sentBytes = origin().decryptedBytes;
  const thief = await f.beginExchange(lostBearer);
  await expectStreamRefused(thief, { response: complete });
  assert.equal(a.received.filter(({ event }) => event === "response").length, 0);
  assert.equal(f.secretReads, before);
  assert.equal(origin().decryptedBytes, sentBytes);
  assert.equal(origin().completeRequests, 1);

  // Deliver the held response to A, then prove B with the same authenticated
  // identity, on this very connection and with its own opening, is authorized.
  await expectActualReply(a, complete);
  const {
    exchange: freshB,
    capture: captureB,
    ready: readyB,
  } = await openExchange(f, captureMetadata(fixture), lostBearer);
  assert.equal(f.secretReads, before);
  assert.equal(origin().decryptedBytes, sentBytes);
  await expectActualReply(freshB, await sendAllowed(freshB, captureB, readyB, sentBytes));
  assertApplicationConnections(origin(), 2);
  assert.ok(origin().decryptedBytes > sentBytes);
  assert.equal(origin().completeRequests, 2);
  assert.equal(f.providerRequests.length, 2);
  assert.ok(f.providerRequests.every(({ authorization }) => authorization === undefined));

  async function sendAllowed(
    exchange: Exchange,
    capture: Capture,
    ready: MetadataPermit,
    expectedBytes: number,
  ) {
    return observeGrantedSend(
      provider,
      expectedBytes,
      async () => {
        const permit = f.permitRequest(capture, ready, { noMaterial: true });
        exchange.stream.write({ authorize: permit });
        const reply = await exchange.next();
        assert.equal(reply.event, "authorized");
        const { allowed } = reply.authorized;
        assert.ok(allowed);
        assert.deepEqual(allowed.response_custody, capture.response_custody);
        assert.deepEqual(allowed.credential_headers_sha256, permit.credential_headers_sha256);
      },
      () => f.send(capture, { credential_headers: [] }),
    );
  }
  async function expectActualReply(exchange: Exchange, completeReply: ResponseFrame) {
    assert.equal(completeReply.response_complete, true);
    exchange.stream.write({ response: completeReply });
    const reply = await exchange.next();
    assert.equal(reply.event, "response");
    const { response } = reply;
    assert.equal(response.status, 200);
    assert.equal(response.response_complete, true);
    assert.deepEqual(parseJson(response.body.toString("utf8")), {
      id: 7311,
      full_name: "fixture/credential-free",
    });
    assert.deepEqual(response.headers, [
      { name: "content-type", value: "application/json" },
      { name: "cache-control", value: "no-store" },
    ]);
    assert.equal(response.trailers, undefined);
    assert.deepEqual(
      exchange.received.map(({ event }) => event),
      ["challenge", "resolved", "authorized", "response"],
    );
  }
});

test("two live authorized streams cannot cross their resolved dispatch handles", async (t) => {
  const fixture = await protectedMetadataFixture(t, { providerServer: singleRequestTlsOrigin });
  const f = fixture.exchange;
  assert.ok("snapshot" in f.provider);
  const { provider } = f;
  const before = f.secretReads;
  // Cross both signed openings *before* either is presented to the proper sink.
  // Check authority refusals and material access. Origin counters also detect
  // unexpected background traffic; this case does not invoke an outbound sender.
  const [left, right] = await Promise.all([f.beginExchange(), f.beginExchange()]);
  const swapped: [Exchange, ReturnType<Exchange["opening"]>][] = [
    [left, right.opening(captureMetadata(fixture))],
    [right, left.opening(captureMetadata(fixture))],
  ];
  for (const [sink, wrongOpening] of swapped) {
    await expectStreamRefused(sink, wrongOpening);
  }
  assert.equal(f.secretReads, before);
  assert.equal(provider.snapshot().decryptedBytes, 0);
  const [a, b] = await Promise.all([
    openExchange(f, captureMetadata(fixture)),
    openExchange(f, captureMetadata(fixture)),
  ]);
  assert.equal(f.secretReads, before, "metadata resolution reads no Secret before the splice");
  assert.notDeepEqual(a.capture.response_custody, b.capture.response_custody);
  for (const [wrong, original] of [
    [b, a],
    [a, b],
  ] satisfies [typeof a, typeof a][]) {
    wrong.exchange.stream.write({
      authorize: f.permitRequest(original.capture, original.ready, { noMaterial: true }),
    });
    const reply = await wrong.exchange.next();
    assert.equal(reply.event, "authorized");
    assert.ok(reply.authorized.refused);
    assert.deepEqual(
      wrong.exchange.received.map(({ event }) => event),
      ["challenge", "resolved", "authorized"],
    );
  }
  assert.equal(f.secretReads, before, "splicing released no further material");
  assert.equal(provider.snapshot().decryptedBytes, 0, "unexpected origin traffic");
});

async function expectStreamRefused(
  exchange: Exchange,
  message: ReturnType<Exchange["opening"]> | { response: ResponseFrame },
) {
  exchange.stream.write(message);
  await assert.rejects(exchange.next(), { code: 7, details: "Installation exchange refused." });
  assert.deepEqual(
    exchange.received.map(({ event }) => event),
    ["challenge"],
  );
}

async function openExchange(
  f: Fixture,
  capture: Capture,
  metadata?: ReturnType<Fixture["metadata"]>,
) {
  const exchange = await f.beginExchange(metadata);
  exchange.stream.write(exchange.opening(capture));
  const reply = await exchange.next();
  assert.equal(reply.event, "resolved");
  assert.ok(reply.resolved.ready_without_material);
  return { exchange, capture, ready: reply.resolved.ready_without_material };
}
