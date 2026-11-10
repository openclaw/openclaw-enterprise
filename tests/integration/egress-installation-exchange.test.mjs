import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { staticEgressFixture, unary } from "../helpers/static-egress.mjs";

test("the TLS exchange refuses missing, invalid, expired and gateway identity before challenge", async (t) => {
  const f = await staticEgressFixture(t);
  const baselineReads = f.secretReads;
  const missing = f.metadata();
  missing.remove("authorization");
  const invalid = f.metadata();
  invalid.set("authorization", "Bearer invalid");
  const expired = f.metadata({ iat: 1, exp: 2 });
  const gateway = f.metadata({
    caller_kind: "gateway",
    sub: "https://gateway.example.test",
    sandbox_id: undefined,
    instance_id: undefined,
    exchange_key: undefined,
  });
  for (const peer of [missing, invalid, expired, gateway]) {
    const stream = f.clients.HttpInstallationExchange.Exchange(peer, {
      deadline: Date.now() + 5000,
    });
    const received = [];
    stream.on("data", (message) => received.push(message));
    const failure = await new Promise((resolve) => stream.on("error", resolve));
    assert.equal(failure.code, 7);
    assert.deepEqual(received, [], "no challenge or other reply is disclosed");
  }
  assert.equal(f.secretReads, baselineReads);
  assert.deepEqual(f.providerRequests, []);
  const admitted = await f.beginExchange();
  assert.equal(admitted.challenge.length, 32);
  admitted.stream.cancel();
});

test("pending openings are bounded per Sandbox and per authority, and slots follow stream lifecycle", async (t) => {
  const f = await staticEgressFixture(t);
  // A genuine signed exchange supplies the signing helper. The remainder exercises
  // the actual registered handler without opening 1,024 network connections.
  const signer = await f.beginExchange();
  signer.stream.write(signer.opening({ ...f.capture(), audience: "wrong" }));
  assert.ok((await signer.next()).resolved.refused);

  const handler = f.authority.handlers.get(
    "/openshell.middleware.v1.HttpInstallationExchange/Exchange",
  ).func;
  class Call extends EventEmitter {
    constructor(metadata) {
      super();
      this.metadata = metadata;
      this.replies = [];
      this.on("error", (error) => {
        this.failure = error;
      });
    }
    write(reply) {
      this.replies.push(reply);
    }
    end() {
      this.ended = true;
    }
  }
  // Every opening presents a fresh bearer (new jti), as a supervisor that renews its
  // token does. All Sandboxes share the fixture's instance ID, so only the Sandbox ID
  // tells them apart. `a` is the fixture's own Sandbox, whose openings `signer` can sign.
  const sandbox =
    (sandboxId, claims = {}) =>
    () =>
      f.metadata(
        sandboxId === undefined
          ? claims
          : { sandbox_id: sandboxId, sub: `spiffe://openshell/sandbox/${sandboxId}`, ...claims },
      );
  const [a, b, c, d, e] = [undefined, "sandbox-b", "sandbox-c", "sandbox-d", "sandbox-e"].map(
    (id) => sandbox(id),
  );
  const open = (peer) => {
    const call = new Call(peer());
    handler(call);
    return call;
  };
  const admitted = (call) => call.replies[0]?.challenge?.length === 32;
  const assertRefused = (call, message) => {
    // Same refusal as an exhausted pool: RESOURCE_EXHAUSTED and no challenge.
    assert.equal(call.failure?.code, 8, message);
    assert.equal(call.failure?.message, "Installation exchange unavailable.", message);
    assert.deepEqual(call.replies, [], message);
  };
  const pool = 1024;
  // A quarter of the pool, like the Credential Proxy's per-Sandbox shares.
  const share = pool / 4;
  t.mock.timers.enable({ apis: ["setTimeout"] });

  // Tenant isolation: one Sandbox opening as many exchanges as it can must leave
  // pending openings for every other Sandbox on this authority.
  const flood = Array.from({ length: pool }, () => open(a));
  const firstOfB = open(b);
  assert.ok(admitted(firstOfB), "one Sandbox's pending openings must not refuse another Sandbox");
  const pending = flood.filter(admitted);
  assert.equal(pending.length, share);
  for (const call of flood.filter((call) => !admitted(call))) {
    assertRefused(call, "openings beyond the Sandbox share");
  }
  // The share follows the Sandbox, not one instance or token of it.
  assertRefused(open(sandbox(undefined, { instance_id: randomUUID() })), "another instance");
  pending.push(firstOfB);
  for (const [peer, count] of [
    [b, share - 1],
    [c, share],
    [d, share],
  ]) {
    const calls = Array.from({ length: count }, () => open(peer));
    assert.ok(calls.every(admitted));
    pending.push(...calls);
  }
  // Four full shares fill the pool; a Sandbox with no openings is refused too.
  const assertFull = () => {
    assertRefused(open(a), "Sandbox share");
    assertRefused(open(e), "authority pool");
  };
  assertFull();
  for (const event of ["cancelled", "error", "end", "invalid", "accepted"]) {
    // Each exit path must return both the Sandbox's slot and the pool's slot.
    const call = pending.shift();
    if (event === "invalid") {
      call.emit("data", {
        open: { resolve_request: Buffer.alloc(0), signature: Buffer.alloc(64) },
      });
      assert.equal(call.failure?.code, 7, "invalid proof must be refused");
    } else if (event === "accepted") {
      call.emit(
        "data",
        signer.opening({ ...f.capture(), audience: "wrong" }, undefined, call.replies[0].challenge),
      );
      assert.equal(
        call.failure,
        undefined,
        "signed opening must be accepted before releasing its slot",
      );
    } else {
      call.emit(event, ...(event === "error" ? [new Error("transport closed")] : []));
    }
    const replacement = open(a);
    assert.ok(admitted(replacement), `${event} must release a slot`);
    pending.unshift(replacement);
    // Duplicate terminal events must not release a second stream's slot.
    call.emit("cancelled");
    assertFull();
  }
  t.mock.timers.tick(30_000);
  assert.ok(pending.every((call) => call.failure?.code === 7));
  // The timeout returns every slot: the Sandbox can again hold its whole share.
  const afterTimeout = Array.from({ length: share }, () => open(a));
  assert.ok(afterTimeout.every(admitted), "the timeout must release the Sandbox's slots");
  assertRefused(open(a), "Sandbox share after timeout");
  const other = open(e);
  assert.ok(admitted(other));
  for (const call of [...afterTimeout, other]) {
    call.emit("cancelled");
  }
  // Duplicate terminal events must not return a second Sandbox slot while the pool has room.
  const again = Array.from({ length: share }, () => open(a));
  const closed = again.pop();
  closed.emit("cancelled");
  closed.emit("cancelled");
  again.push(open(a));
  assert.ok(admitted(again.at(-1)));
  assertRefused(open(a), "duplicate terminal events");
  for (const call of again) {
    call.emit("cancelled");
  }
  t.mock.timers.reset();
});

// Real TLS gRPC, issuer/possession verification, OCC capture, IAM, material read,
// synthetic HTTPS origin, and actual gRPC reply stream. Installed policy is a
// fixture; this does not prove supervisor downstream custody or network fencing.
test("installation exchange rejects stolen bearer, changed request and swapped stream before material", async (t) => {
  const f = await staticEgressFixture(t);
  const foreign = generateKeyPairSync("ed25519");
  const baselineReads = f.secretReads;
  const captured = f.capture();
  const rejectOpening = async (name, makeOpening, peer) => {
    const exchange = await f.beginExchange(peer);
    exchange.stream.write(makeOpening(exchange));
    await assert.rejects(exchange.next(), /Installation exchange refused/, name);
    assert.deepEqual(
      exchange.received.map((message) => message.event),
      ["challenge"],
      name,
    );
    assert.equal(f.secretReads, baselineReads, name);
    assert.equal(f.providerRequests.length, 0, name);
  };
  await rejectOpening("stolen bearer", (x) => x.opening(captured, foreign.privateKey));
  const original = await f.beginExchange();
  await rejectOpening("swapped stream", () => original.opening(captured));
  original.stream.cancel();
  await rejectOpening("changed request", (x) => {
    const signed = x.opening(captured);
    signed.open.resolve_request = x.opening(f.capture()).open.resolve_request;
    return signed;
  });
  // A key in an exchange is never enrollment; a legacy issuer token is insufficient.
  await rejectOpening(
    "no issuer-bound key",
    (x) => x.opening(captured),
    f.metadata({ exchange_key: undefined }),
  );
  const legacy = await unary(f.clients.HttpCredentialAccess, "Resolve", f.capture(), f.metadata());
  assert.ok(legacy.refused);
  await assert.rejects(
    unary(
      f.clients.SupervisorMiddleware,
      "Describe",
      {
        gateway: {
          protocol_version: { major: 1, minor: 0 },
          supported_capabilities: [
            "openshell.supervisor-middleware.contract",
            "openshell.supervisor-middleware.http-credential-access.v1",
            "openshell.supervisor-middleware.http-credential-verified-connector.v1",
          ],
        },
      },
      f.metadata(),
    ),
    /unavailable/,
  );
  assert.equal(f.secretReads, baselineReads);
});

test("A resolves, authorizes and receives the protected actual reply on its accepted stream", async (t) => {
  const f = await staticEgressFixture(t);
  const baselineReads = f.secretReads;
  const captured = f.capture();
  const a = await f.beginExchange();
  a.stream.write(a.opening(captured));
  const { resolved } = await a.next();
  assert.ok(resolved.ready);
  assert.equal(f.secretReads, baselineReads + 1);

  // Another authenticated A stream cannot substitute its handle or reply association.
  const other = await f.beginExchange();
  const otherCapture = f.capture();
  other.stream.write(other.opening(otherCapture));
  assert.ok((await other.next()).resolved.ready);
  other.stream.write({ authorize: f.permitRequest(captured, resolved.ready) });
  assert.ok((await other.next()).authorized.refused);
  assert.equal(f.providerRequests.length, 0);

  a.stream.write({ authorize: f.permitRequest(captured, resolved.ready) });
  const permit = (await a.next()).authorized.allowed;
  assert.deepEqual(permit.response_custody, captured.response_custody);
  const response = await f.send(captured, resolved.ready);
  assert.equal(f.providerRequests.length, 1);
  a.stream.write({ response });
  const returned = await a.next();
  assert.ok(returned.response.body.length > 0);
  assert.equal(returned.response.status, 200);
  assert.equal(returned.response.response_complete, true);
  assert.doesNotMatch(returned.response.body.toString(), /Bearer/);
});

// The supervisor reports stream progress on the same exchange; the lease carries the
// permitted operation past the 20-second fixture deadline until the complete response.
test("a permitted response stream renews its lease on progress across the operation deadline", async (t) => {
  let elapsed = 0;
  const f = await staticEgressFixture(t, { now: () => new Date(Date.now() + elapsed) });
  const peer = f.metadata({ exp: Math.floor(Date.now() / 1000) + 3600 });
  const captured = f.capture();
  const { ready } = await f.resolve(captured, peer);
  assert.ok(ready);
  assert.ok((await f.authorize(f.permitRequest(captured, ready))).allowed);
  const deadline = Number(captured.deadline.seconds) * 1000;
  elapsed = 15_000;
  const before = Date.now();
  const first = await f.progress(captured, { head_received: true, body_bytes: "0" });
  const after = Date.now();
  const renewBy = Number(first.renew_by.seconds) * 1000 + Number(first.renew_by.nanos) / 1e6;
  assert.ok(
    before + elapsed + 300_000 <= renewBy && renewBy <= after + elapsed + 300_000,
    "the lease renews on the idle horizon",
  );
  assert.ok(renewBy > deadline, "the lease outlives the operation deadline");
  elapsed = 60_000;
  assert.ok(Date.now() + elapsed > deadline);
  const second = await f.progress(captured, { head_received: true, body_bytes: "2048" });
  assert.ok(Number(second.renew_by.seconds) * 1000 > renewBy, "new bytes extend the lease");
  assert.equal(second.expires_at.seconds, first.expires_at.seconds, "the ceiling is fixed");
  elapsed = 120_000;
  const returned = await f.protect(captured, await f.send(captured, ready));
  assert.equal(returned.response_complete, true);
  assert.equal(returned.body.toString(), JSON.stringify({ output: "fixture answer" }));
  assert.equal(f.providerRequests.length, 1);
});

test("without progress the operation deadline still bounds the first response byte", async (t) => {
  let elapsed = 0;
  const f = await staticEgressFixture(t, { now: () => new Date(Date.now() + elapsed) });
  const peer = f.metadata({ exp: Math.floor(Date.now() / 1000) + 3600 });
  const late = f.capture();
  const { ready } = await f.resolve(late, peer);
  assert.ok((await f.authorize(f.permitRequest(late, ready))).allowed);
  elapsed = 25_000;
  assert.deepEqual(
    await f.progress(late, { head_received: true, body_bytes: "1" }),
    { refused: true },
    "a first progress frame after the deadline is refused",
  );
  elapsed = 0;
  const early = f.capture();
  const resolved = (await f.resolve(early)).ready;
  assert.ok(resolved);
  assert.deepEqual(
    await f.progress(early, { head_received: true, body_bytes: "1" }),
    { refused: true },
    "progress before the send permit is refused",
  );
  assert.equal(f.providerRequests.length, 0);
});

test("a real credentialed selection cannot be changed into a credential-free send", async (t) => {
  const f = await staticEgressFixture(t);
  const captured = f.capture();
  const selected = await f.resolve(captured);
  assert.ok(selected.ready && !selected.ready_without_material);
  const fake = f.permitRequest(captured, selected.ready, { noMaterial: true });
  assert.ok(
    (await f.authorize(fake)).refused,
    "the empty injection and explicit no-material flag cannot change the selection",
  );
  assert.deepEqual(f.providerRequests, []);
});

test("signed custody must be present, unique to this live exchange and unchanged in the proof", async (t) => {
  const f = await staticEgressFixture(t);
  const captured = f.capture();
  assert.ok((await f.resolve(captured)).ready);
  const before = f.secretReads;
  for (const hash of ["", "ab".repeat(32)]) {
    const withheld = await f.resolve({ ...f.capture(), verified_execution_policy_hash: hash });
    assert.ok(withheld.refused, "a signed opening must name the actual enforced execution policy");
  }
  for (const custody of [captured.response_custody, undefined, Buffer.alloc(31)]) {
    await assert.rejects(f.resolve({ ...f.capture(), response_custody: custody }), { code: 7 });
  }
  const changed = await f.beginExchange();
  const packet = changed.opening(captured);
  const replacement = { ...captured, response_custody: f.capture().response_custody };
  packet.open.resolve_request = changed.opening(replacement).open.resolve_request;
  changed.stream.write(packet);
  await assert.rejects(changed.next(), { code: 7 });
  assert.equal(f.secretReads, before);
  assert.equal(f.providerRequests.length, 0);
});

test("the last forbidden trailer reaches the complete response policy; no head or body is released", async (t) => {
  const f = await staticEgressFixture(t);
  const captured = f.capture();
  const { ready } = await f.resolve(captured);
  assert.ok((await f.authorize(f.permitRequest(captured, ready))).allowed);
  const trailer = { name: "x-forbidden-last", value: "synthetic-private" };
  f.setResponse({
    status: 200,
    body: { output: "otherwise safe body" },
    trailers: { [trailer.name]: trailer.value },
  });
  const response = await f.send(captured, ready);
  assert.equal(response.response_complete, true);
  assert.deepEqual(response.trailers, [trailer]);
  // protect observes the entire gRPC stream and rejects even a response head before refusal.
  assert.deepEqual(await f.protect(captured, response), { blocked: true });
  assert.equal(f.providerRequests.length, 1, "the origin had already executed once");
});

test("current installation replacement revokes captured A without reassigning its request", async (t) => {
  const f = await staticEgressFixture(t);
  const captured = f.capture();
  const a = await f.beginExchange();
  a.stream.write(a.opening(captured));
  const { resolved } = await a.next();
  assert.ok(resolved.ready);
  const reads = f.secretReads;
  // The authoritative status wire now reports a different installed supervisor.
  f.observed.evidence.instance_id = "00000000-0000-4000-8000-000000000001";
  a.stream.write({ authorize: f.permitRequest(captured, resolved.ready) });
  assert.ok((await a.next()).authorized.refused);
  assert.equal(f.secretReads, reads);
  assert.equal(f.providerRequests.length, 0);
  assert.equal(a.received.filter((message) => message.response).length, 0);
});

test("a second gateway-issued key for the same admitted instance cannot inherit its authority", async (t) => {
  const f = await staticEgressFixture(t);
  const before = f.secretReads;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const exchange_key = { profile: "openshell-exchange-v1", ...publicKey.export({ format: "jwk" }) };
  const b = await f.beginExchange(f.metadata({ exchange_key }));
  b.stream.write(b.opening(f.capture(), privateKey));
  assert.ok((await b.next()).resolved.refused);
  assert.equal(f.secretReads, before);
  assert.equal(f.providerRequests.length, 0);

  const c = f.capture();
  const { ready } = await f.resolve(c);
  assert.ok(ready);
  const afterA = f.secretReads;
  // A reconnect may keep the instance UUID but must not replace the pinned key.
  f.observed.observation.registered_exchange_public_key = Buffer.from(exchange_key.x, "base64url");
  assert.ok((await f.authorize(f.permitRequest(c, ready))).refused);
  assert.equal(f.secretReads, afterA);
  assert.equal(f.providerRequests.length, 0);
});
