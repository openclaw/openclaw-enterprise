import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { isRecord } from "../helpers/egress-observation-values.ts";
import { grpc, type Grpc } from "../helpers/openshell-grpc-sdk.ts";
import { loadExchangeDefinition, type Exchange } from "../helpers/static-egress-exchange.ts";
import { decodeResolution } from "../helpers/static-egress-exchange-wire.ts";
import { staticEgressFixture, staticEgressWireFixture } from "../helpers/static-egress.mjs";
import { verifyPendingOpeningCapacity } from "./egress-installation-exchange-capacity.ts";

type UnaryRequests = {
  "HttpCredentialAccess/Resolve": Parameters<Exchange["opening"]>[0];
  "SupervisorMiddleware/Describe": {
    gateway: {
      protocol_version: { major: number; minor: number };
      supported_capabilities: string[];
    };
  };
};

function unary<Method extends keyof UnaryRequests>(
  client: Grpc.Client,
  method: Method,
  request: NoInfer<UnaryRequests[Method]>,
  metadata: Grpc.Metadata,
): Promise<unknown> {
  const [service, name] = method.split("/");
  assert.ok(service && name);
  const packageService = `openshell.middleware.v1.${service}`;
  const definition = loadExchangeDefinition()[packageService];
  assert.ok(definition && !("format" in definition), `Missing service descriptor for ${service}`);
  const descriptor = definition[name];
  assert.ok(
    descriptor?.path === `/${packageService}/${name}` &&
      !descriptor.requestStream &&
      !descriptor.responseStream &&
      typeof descriptor.requestSerialize === "function" &&
      typeof descriptor.responseDeserialize === "function",
    `Missing unary method descriptor for ${method}`,
  );
  const serialize: (value: UnaryRequests[Method]) => Buffer = descriptor.requestSerialize;
  const deserialize: (bytes: Buffer) => unknown = descriptor.responseDeserialize;
  return new Promise((resolve, reject: (error: Grpc.ServiceError) => void) => {
    client.makeUnaryRequest(
      descriptor.path,
      serialize,
      deserialize,
      request,
      metadata,
      { deadline: Date.now() + 5000 },
      (error, reply) => {
        if (error) {
          reject(error);
        } else {
          resolve(reply);
        }
      },
    );
  });
}

test("the TLS exchange refuses missing, invalid, expired and gateway identity before challenge", async (t) => {
  const f = await staticEgressWireFixture(t);
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
    const stream = f.openRawExchange(peer);
    const received: unknown[] = [];
    stream.on("data", (message: unknown) => {
      received.push(message);
    });
    const failure = await new Promise<Grpc.ServiceError>((resolve) =>
      stream.once("error", resolve),
    );
    assert.equal(failure.code, grpc.status.PERMISSION_DENIED);
    assert.deepEqual(received, [], "no challenge or other reply is disclosed");
  }
  assert.equal(f.secretReads, baselineReads);
  assert.deepEqual(f.providerRequests, []);
  const admitted = await f.beginExchange();
  assert.equal(admitted.challenge.length, 32);
  admitted.stream.cancel();
});

test(
  "pending openings are bounded per Sandbox and per authority, and slots follow stream lifecycle",
  verifyPendingOpeningCapacity,
);

// Real TLS gRPC, issuer/possession verification, OCC capture, IAM, material read,
// synthetic HTTPS origin, and actual gRPC reply stream. Installed policy is a
// fixture; this does not prove supervisor downstream custody or network fencing.
test("installation exchange rejects stolen bearer, changed request and swapped stream before material", async (t) => {
  const { exchange: f, clients } = await staticEgressFixture(t);
  const foreign = generateKeyPairSync("ed25519");
  const baselineReads = f.secretReads;
  const captured = f.capture();
  const rejectOpening = async (
    name: string,
    makeOpening: (exchange: Exchange) => ReturnType<Exchange["opening"]>,
    peer?: Grpc.Metadata,
  ) => {
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
  const legacy = decodeResolution(
    await unary(
      clients.HttpCredentialAccess,
      "HttpCredentialAccess/Resolve",
      f.capture(),
      f.metadata(),
    ),
  );
  assert.equal(legacy.result, "refused");
  assert.equal(legacy.refused.code, f.refusalCode("DENIED"));
  await assert.rejects(
    unary(
      clients.SupervisorMiddleware,
      "SupervisorMiddleware/Describe",
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
    { code: grpc.status.UNAVAILABLE, message: /unavailable/ },
  );
  assert.equal(f.secretReads, baselineReads);
});

test("A resolves, authorizes and receives the protected actual reply on its accepted stream", async (t) => {
  const f = await staticEgressWireFixture(t);
  const baselineReads = f.secretReads;
  const captured = f.capture();
  const a = await f.beginExchange();
  a.stream.write(a.opening(captured));
  const reply = await a.next();
  assert.equal(reply.event, "resolved");
  assert.equal(reply.resolved.result, "ready");
  const { ready } = reply.resolved;
  assert.equal(f.secretReads, baselineReads + 1);

  // Another authenticated A stream cannot substitute its handle or reply association.
  const other = await f.beginExchange();
  const otherCapture = f.capture();
  other.stream.write(other.opening(otherCapture));
  const otherReply = await other.next();
  assert.equal(otherReply.event, "resolved");
  assert.equal(otherReply.resolved.result, "ready");
  other.stream.write({ authorize: f.permitRequest(captured, ready) });
  const wrongStream = await other.next();
  assert.equal(wrongStream.event, "authorized");
  assert.equal(wrongStream.authorized.result, "refused");
  assert.equal(f.providerRequests.length, 0);

  a.stream.write({ authorize: f.permitRequest(captured, ready) });
  const authorization = await a.next();
  assert.equal(authorization.event, "authorized");
  assert.equal(authorization.authorized.result, "allowed");
  const permit = authorization.authorized.allowed;
  assert.deepEqual(permit.response_custody, captured.response_custody);
  const response = await f.send(captured, ready);
  assert.equal(f.providerRequests.length, 1);
  a.stream.write({ response });
  const returned = await a.next();
  assert.equal(returned.event, "response");
  assert.ok(returned.response.body.length > 0);
  assert.equal(returned.response.status, 200);
  assert.equal(returned.response.response_complete, true);
  assert.doesNotMatch(returned.response.body.toString(), /Bearer/);
});

// The supervisor reports stream progress on the same exchange; the lease carries the
// permitted operation past the 20-second fixture deadline until the complete response.
test("a permitted response stream renews its lease on progress across the operation deadline", async (t) => {
  let elapsed = 0;
  const f = await staticEgressWireFixture(t, { now: () => new Date(Date.now() + elapsed) });
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
  assert.ok("renew_by" in first);
  const renewBy = Number(first.renew_by.seconds) * 1000 + (first.renew_by.nanos ?? 0) / 1e6;
  assert.ok(
    before + elapsed + 300_000 <= renewBy && renewBy <= after + elapsed + 300_000,
    "the lease renews on the idle horizon",
  );
  assert.ok(renewBy > deadline, "the lease outlives the operation deadline");
  elapsed = 60_000;
  assert.ok(Date.now() + elapsed > deadline);
  const second = await f.progress(captured, { head_received: true, body_bytes: "2048" });
  assert.ok("renew_by" in second);
  assert.ok(Number(second.renew_by.seconds) * 1000 > renewBy, "new bytes extend the lease");
  assert.equal(second.expires_at.seconds, first.expires_at.seconds, "the ceiling is fixed");
  elapsed = 120_000;
  const returned = await f.protect(captured, await f.send(captured, ready));
  assert.ok("response_complete" in returned);
  assert.equal(returned.response_complete, true);
  assert.equal(returned.body.toString(), JSON.stringify({ output: "fixture answer" }));
  assert.equal(f.providerRequests.length, 1);
});

test("without progress the operation deadline still bounds the first response byte", async (t) => {
  let elapsed = 0;
  const f = await staticEgressWireFixture(t, { now: () => new Date(Date.now() + elapsed) });
  const peer = f.metadata({ exp: Math.floor(Date.now() / 1000) + 3600 });
  const late = f.capture();
  const { ready } = await f.resolve(late, peer);
  assert.ok(ready);
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
  const f = await staticEgressWireFixture(t);
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
  const f = await staticEgressWireFixture(t);
  const captured = f.capture();
  assert.ok((await f.resolve(captured)).ready);
  const before = f.secretReads;
  for (const hash of ["", "ab".repeat(32)]) {
    const withheld = await f.resolve({ ...f.capture(), verified_execution_policy_hash: hash });
    assert.ok(withheld.refused, "a signed opening must name the actual enforced execution policy");
  }
  const denied = { code: grpc.status.PERMISSION_DENIED };
  await assert.rejects(
    f.resolve({ ...f.capture(), response_custody: captured.response_custody }),
    denied,
  );
  const { response_custody: _omitted, ...missingCustody } = f.capture();
  const missing = await f.beginExchange();
  try {
    missing.stream.write(missing.openingWithoutCustody(missingCustody));
    await assert.rejects(missing.next(), denied);
  } finally {
    missing.stream.cancel();
  }
  await assert.rejects(f.resolve({ ...f.capture(), response_custody: Buffer.alloc(31) }), denied);
  const changed = await f.beginExchange();
  const packet = changed.opening(captured);
  const replacement = { ...captured, response_custody: f.capture().response_custody };
  packet.open.resolve_request = changed.opening(replacement).open.resolve_request;
  changed.stream.write(packet);
  await assert.rejects(changed.next(), denied);
  assert.equal(f.secretReads, before);
  assert.equal(f.providerRequests.length, 0);
});

test("the last forbidden trailer reaches the complete response policy; no head or body is released", async (t) => {
  const { exchange: f, setResponse } = await staticEgressFixture(t);
  const captured = f.capture();
  const { ready } = await f.resolve(captured);
  assert.ok(ready);
  assert.ok((await f.authorize(f.permitRequest(captured, ready))).allowed);
  const trailer = { name: "x-forbidden-last", value: "synthetic-private" };
  setResponse({
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
  const { exchange: f, observed } = await staticEgressFixture(t);
  const captured = f.capture();
  const a = await f.beginExchange();
  a.stream.write(a.opening(captured));
  const reply = await a.next();
  assert.equal(reply.event, "resolved");
  assert.equal(reply.resolved.result, "ready");
  const { ready } = reply.resolved;
  const reads = f.secretReads;
  // The authoritative status wire now reports a different installed supervisor.
  assert.ok("evidence" in observed && isRecord(observed.evidence));
  assert.equal(typeof observed.evidence.instance_id, "string");
  observed.evidence.instance_id = "00000000-0000-4000-8000-000000000001";
  a.stream.write({ authorize: f.permitRequest(captured, ready) });
  const authorization = await a.next();
  assert.equal(authorization.event, "authorized");
  assert.equal(authorization.authorized.result, "refused");
  assert.equal(f.secretReads, reads);
  assert.equal(f.providerRequests.length, 0);
  assert.equal(a.received.filter((message) => message.event === "response").length, 0);
});

test("a second gateway-issued key for the same admitted instance cannot inherit its authority", async (t) => {
  const { exchange: f, observed } = await staticEgressFixture(t);
  const before = f.secretReads;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const exchange_key = { profile: "openshell-exchange-v1", ...publicKey.export({ format: "jwk" }) };
  const b = await f.beginExchange(f.metadata({ exchange_key }));
  b.stream.write(b.opening(f.capture(), privateKey));
  const reply = await b.next();
  assert.equal(reply.event, "resolved");
  assert.equal(reply.resolved.result, "refused");
  assert.equal(f.secretReads, before);
  assert.equal(f.providerRequests.length, 0);

  const c = f.capture();
  const { ready } = await f.resolve(c);
  assert.ok(ready);
  const afterA = f.secretReads;
  // A reconnect may keep the instance UUID but must not replace the pinned key.
  assert.ok("observation" in observed && isRecord(observed.observation));
  assert.ok(Buffer.isBuffer(observed.observation.registered_exchange_public_key));
  assert.ok(typeof exchange_key.x === "string" && exchange_key.x.length > 0);
  observed.observation.registered_exchange_public_key = Buffer.from(exchange_key.x, "base64url");
  assert.ok((await f.authorize(f.permitRequest(c, ready))).refused);
  assert.equal(f.secretReads, afterA);
  assert.equal(f.providerRequests.length, 0);
});
