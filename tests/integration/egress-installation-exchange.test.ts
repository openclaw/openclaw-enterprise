import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { isRecord } from "../helpers/egress-observation-values.ts";
import { grpc, type Grpc } from "../helpers/openshell-grpc-sdk.ts";
import { loadExchangeDefinition, type Exchange } from "../helpers/static-egress-exchange.ts";
import { decodeResolution } from "../helpers/static-egress-exchange-wire.ts";
import { protectedMetadataFixture } from "../helpers/static-egress.mjs";
import { captureMetadata } from "../helpers/github-metadata-exchange.mjs";
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
  const fixture = await protectedMetadataFixture(t);
  const f = fixture.exchange;
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

// The signed exchange exercises the selected metadata Source and exact peer binding over real TLS.
// OpenShell's installed policy observation comes from the controlled fixture.
test("installation exchange rejects stolen bearer, changed request and swapped stream before material", async (t) => {
  const fixture = await protectedMetadataFixture(t);
  const { exchange: f, clients } = fixture;
  const foreign = generateKeyPairSync("ed25519");
  const baselineReads = f.secretReads;
  const captured = captureMetadata(fixture);
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
    signed.open.resolve_request = x.opening(captureMetadata(fixture)).open.resolve_request;
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
      captureMetadata(fixture),
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

test("signed custody must be present, unique to this live exchange and unchanged in the proof", async (t) => {
  const fixture = await protectedMetadataFixture(t);
  const f = fixture.exchange;
  const captured = captureMetadata(fixture);
  assert.ok((await f.resolve(captured)).ready_without_material);
  const before = f.secretReads;
  for (const hash of ["", "ab".repeat(32)]) {
    const withheld = await f.resolve({
      ...captureMetadata(fixture),
      verified_execution_policy_hash: hash,
    });
    assert.ok(withheld.refused, "a signed opening must name the actual enforced execution policy");
  }
  const denied = { code: grpc.status.PERMISSION_DENIED };
  await assert.rejects(
    f.resolve({ ...captureMetadata(fixture), response_custody: captured.response_custody }),
    denied,
  );
  const { response_custody: _omitted, ...missingCustody } = captureMetadata(fixture);
  const missing = await f.beginExchange();
  try {
    missing.stream.write(missing.openingWithoutCustody(missingCustody));
    await assert.rejects(missing.next(), denied);
  } finally {
    missing.stream.cancel();
  }
  await assert.rejects(
    f.resolve({ ...captureMetadata(fixture), response_custody: Buffer.alloc(31) }),
    denied,
  );
  const changed = await f.beginExchange();
  const packet = changed.opening(captured);
  const replacement = { ...captured, response_custody: captureMetadata(fixture).response_custody };
  packet.open.resolve_request = changed.opening(replacement).open.resolve_request;
  changed.stream.write(packet);
  await assert.rejects(changed.next(), denied);
  assert.equal(f.secretReads, before);
  assert.equal(f.providerRequests.length, 0);
});

test("current installation replacement revokes captured A without reassigning its request", async (t) => {
  const fixture = await protectedMetadataFixture(t);
  const { exchange: f, observed } = fixture;
  const captured = captureMetadata(fixture);
  const a = await f.beginExchange();
  a.stream.write(a.opening(captured));
  const reply = await a.next();
  assert.equal(reply.event, "resolved");
  assert.equal(reply.resolved.result, "ready_without_material");
  const { ready_without_material: ready } = reply.resolved;
  const reads = f.secretReads;
  // The authoritative status wire now reports a different installed supervisor.
  assert.ok("evidence" in observed && isRecord(observed.evidence));
  assert.equal(typeof observed.evidence.instance_id, "string");
  observed.evidence.instance_id = "00000000-0000-4000-8000-000000000001";
  a.stream.write({ authorize: f.permitRequest(captured, ready, { noMaterial: true }) });
  const authorization = await a.next();
  assert.equal(authorization.event, "authorized");
  assert.equal(authorization.authorized.result, "refused");
  assert.equal(f.secretReads, reads);
  assert.equal(f.providerRequests.length, 0);
  assert.equal(a.received.filter((message) => message.event === "response").length, 0);
});

test("a second gateway-issued key for the same admitted instance cannot inherit its authority", async (t) => {
  const fixture = await protectedMetadataFixture(t);
  const { exchange: f, observed } = fixture;
  const before = f.secretReads;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const exchange_key = { profile: "openshell-exchange-v1", ...publicKey.export({ format: "jwk" }) };
  const b = await f.beginExchange(f.metadata({ exchange_key }));
  b.stream.write(b.opening(captureMetadata(fixture), privateKey));
  const reply = await b.next();
  assert.equal(reply.event, "resolved");
  assert.equal(reply.resolved.result, "refused");
  assert.equal(f.secretReads, before);
  assert.equal(f.providerRequests.length, 0);

  const c = captureMetadata(fixture);
  const { ready_without_material: ready } = await f.resolve(c);
  assert.ok(ready);
  const afterA = f.secretReads;
  // A reconnect may keep the instance UUID but must not replace the pinned key.
  assert.ok("observation" in observed && isRecord(observed.observation));
  assert.ok(Buffer.isBuffer(observed.observation.registered_exchange_public_key));
  assert.ok(typeof exchange_key.x === "string" && exchange_key.x.length > 0);
  observed.observation.registered_exchange_public_key = Buffer.from(exchange_key.x, "base64url");
  assert.ok((await f.authorize(f.permitRequest(c, ready, { noMaterial: true }))).refused);
  assert.equal(f.secretReads, afterA);
  assert.equal(f.providerRequests.length, 0);
});
