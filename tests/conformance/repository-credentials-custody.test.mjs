import assert from "node:assert/strict";
import test from "node:test";
import { createCustody } from "../../apps/controller/src/drivers/repo/credentials/custody.ts";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import { custodyLimits } from "../fixtures/repository-credentials/builders.mjs";

function setup() {
  const clock = createControlledClock(1700000000000);
  let admitted = true;
  let changes = 0;
  const custody = createCustody({
    clock,
    ...custodyLimits,
    admitted: () => admitted,
    changed() {
      changes++;
    },
  });
  const attempt = Object.freeze({
    id: "original-attempt",
    authority: Object.freeze({
      sessionId: "session",
      providerInstanceId: "instance",
      repositoryId: "opaque",
      grantId: "grant",
    }),
    action: "acquire",
    signal: new AbortController().signal,
    deadlineMonoMs: 30000,
    assertAdmitted() {},
    observeDispatch() {},
  });
  custody.register(attempt);
  const reservation = custody.reserve(attempt);
  const capture = (
    observation = {
      observedWallMs: clock.wallNow(),
      expiresAtWallMs: clock.wallNow() + 90000,
    },
  ) => custody.driver.capture(attempt, Buffer.from("owned-material"), observation);
  return {
    clock,
    custody,
    attempt,
    reservation,
    capture,
    changes: () => changes,
    close: () => {
      admitted = false;
    },
  };
}

test("custody rejects copied attempts and handles and wipes callback-scoped byte copies", async () => {
  const { custody, attempt, capture, reservation } = setup();
  assert.throws(() => custody.driver.assertAttempt({ ...attempt }, "acquire"), /FOREIGN_ATTEMPT/);
  const ref = capture();
  assert.throws(() => custody.lookup({ ...ref }), /FOREIGN_CREDENTIAL/);
  const record = custody.lookup(ref);
  record.accepted = true;
  record.useDeadlineMonoMs = 90000;
  record.uses++;
  let retained;
  await custody.driver.withAccess(ref, "authenticate", async (bytes) => {
    retained = bytes;
    assert.equal(Buffer.from(bytes).toString(), "owned-material");
  });
  assert.ok(retained.every((value) => value === 0));
  record.uses--;
  record.disposition = "revoked";
  assert.throws(() => custody.release(record), /CREDENTIAL_BUSY/);
  custody.settle(reservation);
  custody.release(record);
  await assert.rejects(
    custody.driver.withAccess(ref, "retire", async () => {}),
    /FOREIGN_CREDENTIAL/,
  );
});

test("late capture survives local closure while original settlement ends capture authority", async () => {
  const { custody, attempt, close, capture, reservation, clock } = setup();
  const observation = {
    observedWallMs: clock.wallNow(),
    expiresAtWallMs: clock.wallNow() + 90000,
  };
  // A wall adjustment between provider observation and capture is not proof
  // that the provider credential expired and must not release cleanup custody.
  await clock.advance(0, 120000);
  close();
  const ref = capture(observation);
  assert.equal(custody.lookup(ref).deadlineMonoMs, 90000);
  assert.equal(custody.records.size, 1);
  custody.settle(reservation);
  assert.throws(
    () =>
      custody.driver.capture(attempt, Buffer.from("late"), {
        observedWallMs: clock.wallNow(),
        expiresAtWallMs: clock.wallNow() + 1000,
      }),
    /FOREIGN_ATTEMPT/,
  );
  const record = custody.lookup(ref);
  record.disposition = "revoked";
  custody.release(record);
  assert.equal(custody.reservations.size, 0);
});

test("access slot reclamation retains independent renewal bytes through finalization drain", async (t) => {
  const { custody, capture, reservation, close } = setup();
  const renewal = custody.driver.retainRenewal(Buffer.from("renewal-authority"));
  const ref = capture();
  const record = custody.lookup(ref);
  record.disposition = "expired";
  custody.settle(reservation);
  custody.release(record);
  close();
  assert.equal(custody.records.size, 0);
  const renewalRead = Promise.withResolvers();
  let bytes;
  const read = custody.driver.withRenewal(renewal, async (value) => {
    bytes = value;
    await renewalRead.promise;
  });
  let disposed = false;
  const dispose = custody.driver.disposeRenewal(renewal).then(() => {
    disposed = true;
  });
  t.after(async () => {
    renewalRead.resolve();
    await Promise.all([read, dispose]);
  });
  await Promise.resolve();
  assert.equal(disposed, false);
  assert.equal(custody.renewalCount, 1);
  renewalRead.resolve();
  await read;
  await dispose;
  assert.equal(custody.renewalCount, 0);
  assert.ok(bytes.every((value) => value === 0));
});

test("custody limits admit exactly their maximum and refuse one more", async (t) => {
  const { custody, attempt, capture, reservation } = setup();
  const { maximumSlots, maximumAccessBytes, maximumRenewalBytes, maximumCallbacks } = custodyLimits;
  const second = Object.freeze({ ...attempt, id: "second-attempt" });
  custody.register(second);
  custody.reserve(second);
  assert.equal(custody.reservations.size, maximumSlots);
  assert.throws(() => custody.reserve({ ...attempt, id: "third" }), /CREDENTIAL_CAPACITY/);
  const ref = custody.driver.capture(attempt, Buffer.alloc(maximumAccessBytes, 1), {
    observedWallMs: 0,
    expiresAtWallMs: 1,
  });
  assert.throws(() => capture(), /CAPTURE_LIMIT/);
  assert.equal(reservation.unknown, true);
  const retain = (bytes) => custody.driver.retainRenewal(Buffer.alloc(bytes, 1));
  const full = [retain(maximumRenewalBytes - 1), retain(1)];
  await Promise.all(full.map((renewal) => custody.driver.disposeRenewal(renewal)));
  const renewals = [retain(1), retain(1)];
  assert.equal(custody.renewalCount, maximumSlots);
  assert.throws(() => retain(1), /RENEWAL_LIMIT/);
  const held = Promise.withResolvers();
  t.after(() => held.resolve());
  const pending = [];
  for (let index = 0; index < maximumCallbacks; index++) {
    pending.push(custody.driver.withAccess(ref, "retire", () => held.promise));
    pending.push(custody.driver.withRenewal(renewals[0], () => held.promise));
  }
  await assert.rejects(
    custody.driver.withAccess(ref, "retire", async () => {}),
    /CALLBACK_CAPACITY/,
  );
  await assert.rejects(
    custody.driver.withRenewal(renewals[0], async () => {}),
    /CALLBACK_CAPACITY/,
  );
  held.resolve();
  await Promise.all(pending);
});

test("custody checks the attempt action, signals capture and closes access with admission", async () => {
  const { custody, attempt, capture, changes, close } = setup();
  custody.driver.assertAttempt(attempt, "acquire");
  assert.throws(() => custody.driver.assertAttempt(attempt, "retire"), /FOREIGN_ATTEMPT/);
  const before = changes();
  const ref = capture();
  assert.equal(changes(), before + 1);
  const record = custody.lookup(ref);
  record.accepted = true;
  record.useDeadlineMonoMs = 90000;
  record.uses++;
  close();
  await assert.rejects(
    custody.driver.withAccess(ref, "authenticate", async () => {}),
    /CREDENTIAL_CLOSED/,
  );
});
