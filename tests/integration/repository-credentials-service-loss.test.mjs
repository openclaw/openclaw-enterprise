import test from "node:test";
import assert from "node:assert/strict";
import { startServiceProcessFixture } from "../fixtures/repository-credentials/service-process.mjs";

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
