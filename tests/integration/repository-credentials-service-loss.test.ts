import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { request } from "node:https";
import { startServiceProcessFixture } from "../fixtures/repository-credentials/service-process.mjs";
import { fixtureRepository } from "../fixtures/repository-credentials/github.mjs";

// The registry-backed broker must fail closed when its durable journal is absent.
test(
  "a broker restart cannot accept bound admissions without durable fencing",
  { timeout: 20000 },
  async (t) => {
    const fixture = await startServiceProcessFixture(t);
    const admissionId = fixture.admissionId();

    // An older caller does not advertise durable admission, and the new caller
    // cannot reserve authority while the worker's journal is unavailable.
    assert.deepEqual(await fixture.open(admissionId, true), { error: "invalid-request" });
    assert.deepEqual(await fixture.open(admissionId, false, true), { error: "unavailable" });
    await fixture.kill();
    await fixture.start();
    assert.deepEqual(await fixture.open(admissionId, false, true), { error: "unavailable" });
    assert.deepEqual(fixture.github.tokenState(), []);
    assert.deepEqual(fixture.github.trace, [], "denied admissions must not contact the provider");
    assert.deepEqual(fixture.github.errors, []);
  },
);

// The broker process logs each refusal of a request that carried credentials (finding 2411).
// Unauthenticated requests are Git's challenge round trip and stay silent.
test("the broker process logs one line per refused credentialed request", async (t) => {
  const fixture = await startServiceProcessFixture(t);
  const publicOrigin: unknown = fixture.config.gateway.publicOrigin;
  assert.ok(typeof publicOrigin === "string");
  const send = (authorization: string | undefined, host = new URL(publicOrigin).host) =>
    new Promise((resolve, reject) => {
      const port: unknown = fixture.generation().port;
      assert.ok(typeof port === "number");
      const outgoing = request(
        {
          hostname: "127.0.0.1",
          port,
          path: `/${fixtureRepository}.git/info/refs?service=git-upload-pack`,
          ca: fixture.tls.ca,
          agent: false,
          headers: {
            host,
            ...(authorization === undefined ? {} : { authorization }),
          },
        },
        (incoming) => {
          incoming.resume();
          incoming.once("end", () => resolve(incoming.statusCode));
        },
      );
      outgoing.setTimeout(10000, () => outgoing.destroy(new Error("request timeout")));
      outgoing.once("error", reject);
      outgoing.end();
    });
  const stderr = (): string => {
    const output: unknown = fixture.stderr();
    assert.ok(typeof output === "string");
    return output;
  };
  const records = () =>
    stderr()
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line): unknown => JSON.parse(line))
      .filter(
        (record) =>
          record !== null &&
          typeof record === "object" &&
          "event" in record &&
          record.event === "repository-credentials.denied",
      );

  assert.equal(await send(undefined), 401);
  // A bearer of the right shape that no open session issued.
  const bearer = randomBytes(32).toString("base64url");
  const basic = "Basic " + Buffer.from("gateway-session:" + bearer).toString("base64");
  // Finding 2429: a head refused before authentication (a wrong Host that the certificate
  // still names) is logged only when its credential names an open session, so neither of
  // these writes a line.
  assert.equal(await send(undefined, "localhost"), 400);
  assert.equal(await send(basic, "localhost"), 400);
  const status = await send(basic);
  assert.equal(status, 401);
  let logged: unknown[] | undefined;
  for (let i = 0; i < 100 && !(logged = records()).length; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(logged, [
    {
      event: "repository-credentials.denied",
      status: 401,
      reasonCode: "session-unavailable",
      reason: "session_unavailable",
    },
  ]);
  assert.ok(!stderr().includes(bearer), "the bearer is never logged");
});
