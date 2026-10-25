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
  const send = (authorization) =>
    new Promise((resolve, reject) => {
      const outgoing = request(
        {
          hostname: "127.0.0.1",
          port: fixture.generation().port,
          path: `/${fixtureRepository}.git/info/refs?service=git-upload-pack`,
          ca: fixture.tls.ca,
          agent: false,
          headers: {
            host: new URL(fixture.config.gateway.publicOrigin).host,
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
  const records = () =>
    fixture
      .stderr()
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line))
      .filter((record) => record.event === "repository-credentials.denied");

  assert.equal(await send(undefined), 401);
  // A bearer of the right shape that no open session issued.
  const bearer = randomBytes(32).toString("base64url");
  const status = await send("Basic " + Buffer.from("gateway-session:" + bearer).toString("base64"));
  assert.equal(status, 401);
  let logged;
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
  assert.ok(!fixture.stderr().includes(bearer), "the bearer is never logged");
});
