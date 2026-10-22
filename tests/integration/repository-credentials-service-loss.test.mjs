import test from "node:test";
import assert from "node:assert/strict";
import { startServiceProcessFixture } from "../fixtures/repository-credentials/service-process.mjs";
import { waitFor } from "../helpers/wait-for.mjs";

// Returns the session's status once its cleanup is recorded as uncertain.
function uncertainCleanup(fixture, sessionId) {
  return waitFor(
    "the session's cleanup to be recorded as uncertain",
    async () => {
      const status = await fixture.status(sessionId);
      return status.cleanup.uncertain === 1 ? status : undefined;
    },
    5000,
  );
}

function outstandingToken(fixture) {
  const tokens = fixture.github.tokenState();
  assert.equal(tokens.length, 1, "the provider accepted exactly one issuance");
  const [token] = tokens;
  assert.equal(token.index, 1);
  assert.equal(token.revoked, false, "service loss does not confirm provider retirement");
  assert.ok(token.expires > fixture.clock.wallNow(), "provider authority remains unexpired");
  assert.equal(fixture.github.issuesOfTokens.length, 1);
  assert.equal(
    fixture.github.trace.filter((entry) => entry.target.endsWith("/access_tokens")).length,
    1,
    "the original issuance was dispatched exactly once",
  );
  assert.equal(
    fixture.github.trace.filter((entry) => entry.method === "DELETE").length,
    0,
    "unknown or lost credentials cannot be reported as revoked",
  );
  assert.deepEqual(fixture.github.errors, []);
  return token;
}

async function assertStaleSessionDenied(fixture, opened) {
  assert.deepEqual(await fixture.status(opened.session.sessionId), { error: "not-found" });
  const before = fixture.github.authenticationAttempts.length;
  const denied = await fixture.request(opened);
  assert.equal(denied.status, 401);
  assert.deepEqual(JSON.parse(denied.body), { error: { code: "session-unavailable" } });
  assert.equal(fixture.github.authenticationAttempts.length, before);
  outstandingToken(fixture);
}

// These are current-behavior characterizations. The missing durable accounting
// boundary is deferred; neither stale-bearer denial nor provider state proves it.
test(
  "TEST-001: SIGKILL after confirmed GitHub issuance loses session inventory",
  { timeout: 20000 },
  async (t) => {
    const fixture = await startServiceProcessFixture(t);
    const opened = await fixture.open();
    const read = await fixture.request(opened);
    assert.equal(read.status, 200);
    assert.equal(JSON.parse(read.body).full_name, "fixture/repository");
    assert.equal(outstandingToken(fixture).uses, 1);
    assert.deepEqual(fixture.github.authenticationAttempts, [{ tokenIndex: 1, boundary: "api" }]);
    assert.equal((await fixture.status(opened.session.sessionId)).cleanup.active, 1);

    const first = fixture.generation();
    await fixture.kill();
    assert.equal(outstandingToken(fixture).uses, 1);
    const replacement = await fixture.start();
    assert.notEqual(replacement.pid, first.pid);
    await assertStaleSessionDenied(fixture, opened);
    t.diagnostic(
      "safety_pass; characterization_pass: old session absent while provider token remains valid; durable target deferred",
    );
  },
);

test(
  "TEST-002: lost GitHub issuance response stays charged while service survives",
  { timeout: 20000 },
  async (t) => {
    const fixture = await startServiceProcessFixture(t, { holdIssuance: true });
    const opened = await fixture.open();
    const [failed] = await Promise.all([
      fixture.request(opened),
      (async () => {
        await fixture.waitForIssuance();
        assert.equal(outstandingToken(fixture).uses, 0);
        fixture.loseIssuanceResponse();
      })(),
    ]);
    assert.equal(failed.status, 503);
    assert.deepEqual(JSON.parse(failed.body), { error: { code: "unavailable" } });
    const status = await fixture.status(opened.session.sessionId);
    assert.equal(status.cleanup.pending, 1);
    assert.equal(status.cleanup.uncertain, 1);
    assert.equal(status.cleanup.revoked, 0);
    assert.equal(status.cleanup.expired, 0);

    // A second caller request cannot retry the original uncertain mint.
    assert.equal((await fixture.request(opened)).status, 503);
    outstandingToken(fixture);
    await fixture.close(opened.session.sessionId);
    await fixture.advance(30001);
    const closed = await fixture.status(opened.session.sessionId);
    assert.equal(closed.state, "CLOSED");
    assert.equal(closed.cleanup.pending, 1);
    assert.equal(closed.cleanup.uncertain, 1);
    assert.equal(closed.cleanup.revoked, 0);
    assert.equal(closed.cleanup.expired, 0);
    assert.deepEqual(await fixture.open(), { error: "overloaded" });
    assert.equal(outstandingToken(fixture).uses, 0);
    assert.deepEqual(fixture.github.authenticationAttempts, []);
    t.diagnostic(
      "safety_pass; characterization_pass: uncertain issuance remains charged and CLOSED is not DISPOSED",
    );
  },
);

test(
  "TEST-002: SIGKILL before GitHub issuance response loses local reservation",
  { timeout: 20000 },
  async (t) => {
    const fixture = await startServiceProcessFixture(t, { holdIssuance: true });
    const opened = await fixture.open();
    const first = fixture.generation();
    await Promise.all([
      assert.rejects(fixture.request(opened), { code: "ECONNRESET" }),
      (async () => {
        await fixture.waitForIssuance();
        assert.equal(outstandingToken(fixture).uses, 0);
        await fixture.kill();
      })(),
    ]);
    fixture.loseIssuanceResponse();
    const replacement = await fixture.start();
    assert.notEqual(replacement.pid, first.pid);
    await assertStaleSessionDenied(fixture, opened);
    // Admission is observable again despite the surviving upstream obligation.
    // This documents process-local capacity loss, not a durable target acceptance.
    const fresh = await fixture.open();
    assert.equal(fresh.session.state, "OPEN");
    assert.notEqual(fresh.session.sessionId, opened.session.sessionId);
    assert.equal(fresh.session.cleanup.pending, 0);
    assert.equal(fresh.session.cleanup.uncertain, 0);
    assert.equal(outstandingToken(fixture).uses, 0);
    assert.deepEqual(fixture.github.authenticationAttempts, []);
    t.diagnostic(
      "safety_pass; characterization_pass: restart permits admission with missing local reservation and outstanding provider authority; durable target deferred",
    );
  },
);

test(
  "a lost revocation response is not proof of disposal across broker loss",
  { timeout: 20000 },
  async (t) => {
    const fixture = await startServiceProcessFixture(t);
    const opened = await fixture.open();
    assert.equal((await fixture.request(opened)).status, 200);
    assert.equal(outstandingToken(fixture).uses, 1);

    // The provider revokes the exact issued token, then loses the 204 response.
    // Broker cleanup must remain uncertain because it never observed that result.
    fixture.github.disconnectAfterMutation("DELETE", "/installation/token");
    await fixture.close(opened.session.sessionId);
    const status = await uncertainCleanup(fixture, opened.session.sessionId);
    assert.equal(status.state, "CLOSED");
    assert.equal(status.cleanup.uncertain, 1);
    assert.equal(status.cleanup.revoked, 0);
    assert.equal(fixture.github.tokenState()[0].revoked, true);
    const beforeRestart = fixture.github.trace.filter(
      (entry) => entry.method === "DELETE" && entry.target === "/installation/token",
    ).length;
    assert.equal(beforeRestart, 1);

    // After restart, the provider cannot confirm another retirement and no
    // cleanup lifetime has elapsed. Neither fact permits a disposal claim.
    await fixture.kill();
    fixture.github.setRevokeStatus(503);
    await fixture.start();
    const recovered = await fixture.status(opened.session.sessionId);
    if (recovered.error === undefined) {
      assert.equal(recovered.sessionId, opened.session.sessionId);
      assert.equal(recovered.state, "CLOSED");
    } else {
      assert.equal(recovered.error, "not-found");
    }
    assert.equal(fixture.github.tokenState()[0].revoked, true);
    assert.deepEqual(fixture.github.errors, []);
  },
);

test(
  "captured GitHub authority expires by elapsed time when revocation is unconfirmed",
  { timeout: 20000 },
  async (t) => {
    const fixture = await startServiceProcessFixture(t, { revokeStatus: 503 });
    const opened = await fixture.open();
    assert.equal((await fixture.request(opened)).status, 200);
    await fixture.close(opened.session.sessionId);

    // A provider error cannot be reported as a successful revocation.
    let status = await uncertainCleanup(fixture, opened.session.sessionId);
    assert.equal(status.state, "CLOSED");
    assert.equal(status.cleanup.uncertain, 1);
    assert.equal(status.cleanup.revoked, 0);
    assert.equal(fixture.github.tokenState()[0].revoked, false);

    // A forward wall-clock jump cannot settle cleanup without monotonic elapsed
    // time, even if the controlled provider already considers the token expired.
    await fixture.advance(0, 7200000);
    status = await fixture.status(opened.session.sessionId);
    assert.equal(status.state, "CLOSED");
    assert.equal(status.cleanup.expired, 0);

    // Only the captured token's full elapsed provider lifetime settles cleanup;
    // a revision deadline or unconfirmed DELETE would not establish that fact.
    await fixture.advance(3599999, 0);
    status = await fixture.status(opened.session.sessionId);
    assert.equal(status.state, "CLOSED");
    await fixture.advance(1, 0);
    status = await fixture.status(opened.session.sessionId);
    assert.equal(status.state, "DISPOSED");
    assert.equal(status.cleanup.revoked, 0);
    assert.equal(status.cleanup.expired, 1);
    assert.equal(fixture.github.tokenState()[0].revoked, false);
    assert.ok(fixture.github.tokenState()[0].expires <= fixture.clock.wallNow());
    assert.deepEqual(fixture.github.errors, []);
  },
);

// The registry-backed broker must fail closed when its durable journal is absent.
test(
  "a broker restart cannot accept bound admissions without durable fencing",
  { timeout: 20000 },
  async (t) => {
    const fixture = await startServiceProcessFixture(t, { bound: true });
    const admissionId = fixture.admissionId();

    // An older caller does not advertise durable admission, and the new caller
    // cannot reserve authority while the worker's journal is unavailable.
    assert.deepEqual(await fixture.open(admissionId, true), { error: "invalid-request" });
    assert.deepEqual(await fixture.open(admissionId, false, true), { error: "unavailable" });
    await fixture.kill();
    await fixture.start();
    assert.deepEqual(await fixture.open(admissionId, false, true), { error: "unavailable" });
    assert.deepEqual(fixture.github.tokenState(), []);
    assert.deepEqual(fixture.github.errors, []);
  },
);
