import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { keyedAdmission } from "../../apps/controller/src/auth/admission.ts";
import {
  KNOWN_DEVICE_LIFETIME_SECONDS,
  issueKnownDevice,
  knownDeviceCookieName,
  knownDeviceFromCookieHeader,
  knownDeviceSetCookie,
  verifyKnownDevice,
} from "../../apps/controller/src/auth/known-device.ts";

const secret = "known-device-test-secret-at-least-32-bytes";
const email = "member@example.test";
const now = Date.UTC(2026, 8, 30, 12);
// Opaque to the cookie; shaped like the password-only profile's state.
const stateOf = (userId, methodVersion) =>
  ["password", userId, "method-1", methodVersion].join("\0");
const accountState = stateOf("user-1", 1);

// Account state by email, recording every read so tests can prove when it is consulted.
function accounts(states = {}) {
  const reads = [];
  const lookup = async (address) => {
    reads.push(address);
    return Object.hasOwn(states, address) ? states[address] : accountState;
  };
  return { lookup, reads };
}
const current = accounts().lookup;
const verify = (value, at = now, target = email, lookup = current, key = secret) =>
  verifyKnownDevice(key, target, value, at, lookup);
const issue = (target, at, existing, state = accountState, key = secret) =>
  issueKnownDevice(key, target, state, at, existing);

test("an issued entry verifies only for its own email and secret", async () => {
  const value = issue(email, now);
  const device = await verify(value, now + 1000);
  assert.ok(device, "the issuing account's email verifies");
  assert.match(device.deviceKey, /^[A-Za-z0-9_-]{43}$/);
  assert.match(
    value,
    /^v2\.[A-Za-z0-9_-]{8}\.[1-9][0-9]*\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/,
  );
  // Emails are normalized the same way sign-in normalizes them.
  assert.deepEqual(await verify(value, now, " Member@Example.TEST "), device);
  // The cookie is bound to its account: it grants nothing to an attempt at another email.
  assert.equal(await verify(value, now, "other@example.test"), undefined);
  // The entry carries neither the email nor the account state.
  assert.equal(value.includes("member"), false);
  assert.equal(value.includes("user-1"), false);
  // Rotating the auth secret invalidates every entry issued under the old one.
  const rotated = "rotated-known-device-secret-at-least-32-bytes";
  assert.equal(await verify(value, now, email, current, rotated), undefined);
});

test("a password change, disable, or recreated account revokes the entry", async () => {
  const value = issue(email, now);
  assert.ok(await verify(value, now + 1000));
  // A password reset bumps the method's authentication version.
  const reset = accounts({ [email]: stateOf("user-1", 2) });
  assert.equal(await verify(value, now + 1000, email, reset.lookup), undefined);
  // A disabled (or deleted, or password-less) account has no state at all.
  const disabled = accounts({ [email]: undefined });
  assert.equal(await verify(value, now + 1000, email, disabled.lookup), undefined);
  // An account deleted and recreated under the same email is a different user.
  const recreated = accounts({ [email]: stateOf("user-2", 1) });
  assert.equal(await verify(value, now + 1000, email, recreated.lookup), undefined);
  // After a reset, only a new sign-in issues an entry for the new state; it replaces the
  // stale one. (Disabling is not a revocation: re-enabling restores the same state.)
  const renewed = issue(email, now + 2000, value, stateOf("user-1", 2));
  assert.equal(renewed.split("~").length, 1, "the stale entry is replaced");
  assert.ok(await verify(renewed, now + 3000, email, reset.lookup));
  assert.equal(await verify(renewed, now + 3000), undefined, "the new entry needs the new state");
});

test("the account is read only for an entry issued for the attempted email", async () => {
  const value = issue(email, now);
  const [version, keyId, issuedAt, nonce, mac, binding] = value.split(".");
  const flipped = (part) => `${part.slice(0, -1)}${part.endsWith("A") ? "B" : "A"}`;
  const { lookup, reads } = accounts();
  for (const candidate of [
    `${version}.${keyId}.${issuedAt}.${nonce}.${flipped(mac)}.${binding}`,
    issue("other@example.test", now),
    `v1.${keyId}.${issuedAt}.${nonce}.${mac}`,
    `v2.AAAAAAAA.${issuedAt}.${"A".repeat(16)}.${"A".repeat(43)}.${"A".repeat(43)}`,
    undefined,
  ]) {
    assert.equal(await verify(candidate, now, email, lookup), undefined, String(candidate));
  }
  // Forged and foreign entries never reach the account, so they add no timing signal
  // about whether an email exists.
  assert.deepEqual(reads, []);
  // A tampered binding reads the account once and still verifies nothing.
  const tampered = `${version}.${keyId}.${issuedAt}.${nonce}.${mac}.${flipped(binding)}`;
  assert.equal(await verify(tampered, now, email, lookup), undefined);
  assert.deepEqual(reads, [email]);
  // Several entries for the email read the account once.
  reads.length = 0;
  assert.ok(await verify(`${tampered}~${value}`, now, email, lookup));
  assert.deepEqual(reads, [email]);
});

test("a failed account read fails safe to the shared lane", async () => {
  const value = issue(email, now);
  const failing = async () => {
    throw new Error("database unavailable");
  };
  assert.equal(await verify(value, now, email, failing), undefined);
});

test("tampered, malformed, expired and future entries do not verify", async () => {
  const value = issue(email, now);
  const [version, keyId, issuedAt, nonce, mac, binding] = value.split(".");
  const flipped = `${mac.slice(0, -1)}${mac.endsWith("A") ? "B" : "A"}`;
  const otherNonce = `${nonce.slice(0, -1)}${nonce.endsWith("A") ? "B" : "A"}`;
  for (const candidate of [
    `${version}.${keyId}.${issuedAt}.${nonce}.${flipped}.${binding}`,
    // Moving the issue time forward would extend the lifetime; the MAC covers it.
    `${version}.${keyId}.${Number(issuedAt) + 1}.${nonce}.${mac}.${binding}`,
    // The nonce is signed too, so it cannot be changed to mint another lane.
    `${version}.${keyId}.${issuedAt}.${otherNonce}.${mac}.${binding}`,
    `v3.${keyId}.${issuedAt}.${nonce}.${mac}.${binding}`,
    `${version}.${keyId}.${issuedAt}.${nonce}.${mac}`,
    `${version}.${keyId}.${issuedAt}.${mac}.${binding}`,
    "",
    undefined,
    `${value}~${"x".repeat(600)}`,
  ]) {
    assert.equal(await verify(candidate), undefined, String(candidate));
  }
  const lifetime = KNOWN_DEVICE_LIFETIME_SECONDS * 1000;
  assert.ok(await verify(value, now + lifetime - 1000));
  assert.equal(await verify(value, now + lifetime), undefined);
  // An entry issued well ahead of this controller's clock is not accepted.
  const ahead = issue(email, now + 3_600_000);
  assert.equal(await verify(ahead), undefined);
});

test("two browsers signing in to one account in the same second get distinct lanes", async () => {
  const first = issue(email, now);
  const second = issue(email, now + 999);
  assert.equal(first.split(".")[2], second.split(".")[2], "same issue second");
  assert.notEqual(first, second);
  const a = await verify(first, now + 1000);
  const b = await verify(second, now + 1000);
  assert.ok(a && b);
  assert.notEqual(a.deviceKey, b.deviceKey);
});

test("a cookie holding several entries for one email selects one lane per request", async () => {
  // A legitimate browser never holds two entries for one email (issuing replaces them);
  // a crafted cookie that does still selects exactly one lane, the first matching entry.
  // Each captured entry is its own bounded lane, never a session.
  const snapshots = [0, 1, 2].map((index) => issue(email, now + index * 1000));
  const lanes = await Promise.all(snapshots.map((value) => verify(value, now + 5000)));
  assert.equal(new Set(lanes.map((lane) => lane.deviceKey)).size, 3);
  assert.deepEqual(await verify(snapshots.join("~"), now + 5000), lanes[0]);
  assert.deepEqual(await verify([...snapshots].reverse().join("~"), now + 5000), lanes[2]);
  // Issuing from such a cookie collapses it back to the one fresh entry for this email.
  const reissued = issue(email, now + 6000, snapshots.join("~"));
  assert.equal(reissued.split("~").length, 1);
});

test("a browser keeps entries for its three most recent accounts", async () => {
  let value;
  const accountEmails = ["a@example.test", "b@example.test", "c@example.test", "d@example.test"];
  for (const [index, account] of accountEmails.entries()) {
    value = issue(account, now + index * 1000, value);
  }
  assert.equal(value.split("~").length, 3);
  assert.equal(await verify(value, now + 5000, "a@example.test"), undefined);
  for (const account of accountEmails.slice(1)) {
    assert.ok(await verify(value, now + 5000, account), account);
  }
  // Signing in again replaces the account's entry instead of adding a duplicate, and the
  // new entry is a new device lane.
  const before = await verify(value, now + 5000, "c@example.test");
  const again = issue("c@example.test", now + 10_000, value);
  assert.equal(again.split("~").length, 3);
  const after = await verify(again, now + 10_000, "c@example.test");
  assert.notEqual(after.deviceKey, before.deviceKey);
  assert.ok(await verify(again, now + 10_000, "b@example.test"));
  // A sign-in after secret rotation drops the entries the old secret signed.
  const rotated = "rotated-known-device-secret-at-least-32-bytes";
  const fresh = issue("b@example.test", now + 20_000, again, accountState, rotated);
  assert.equal(fresh.split("~").length, 1);
  assert.ok(await verify(fresh, now + 20_000, "b@example.test", current, rotated));
});

test("three entries fit the cookie", async () => {
  let value;
  for (const [index, account] of ["a@example.test", "b@example.test", "c@example.test"].entries()) {
    value = issue(account, now + index * 1000, value, "x".repeat(200));
  }
  assert.ok(value.length <= 512, `length ${value.length}`);
  assert.equal(knownDeviceFromCookieHeader(`__Host-occ_known_device=${value}`, true), value);
});

test("the cookie is host-only, HttpOnly, SameSite=Strict and read only when unambiguous", () => {
  const value = issue(email, now);
  assert.equal(knownDeviceCookieName(true), "__Host-occ_known_device");
  const secure = knownDeviceSetCookie(true, value);
  assert.equal(
    secure,
    `__Host-occ_known_device=${value}; Max-Age=${KNOWN_DEVICE_LIFETIME_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Strict`,
  );
  assert.equal(secure.includes("Domain"), false);
  assert.equal(knownDeviceSetCookie(false, value).includes("Secure"), false);

  assert.equal(
    knownDeviceFromCookieHeader(`a=1; __Host-occ_known_device=${value}; b=2`, true),
    value,
  );
  // The non-prefixed name, which a sibling host could plant, is ignored on HTTPS.
  assert.equal(knownDeviceFromCookieHeader(`occ_known_device=${value}`, true), undefined);
  // Two cookies of the same name are ambiguous and read as none.
  assert.equal(
    knownDeviceFromCookieHeader(
      `__Host-occ_known_device=${value}; __Host-occ_known_device=${value}`,
      true,
    ),
    undefined,
  );
  assert.equal(knownDeviceFromCookieHeader(undefined, true), undefined);
});

function limitedVerifier() {
  const budget = keyedAdmission(
    { perMinute: 30, concurrent: 2 },
    { perMinute: 600, concurrent: 16 },
  );
  return (value, lookup = current, target = email) =>
    verifyKnownDevice(secret, target, value, now, lookup, (keys, read) => budget.admit(keys, read));
}

test("known-device proof reads have a per-entry rate limit even when reads finish quickly", async () => {
  const bounded = limitedVerifier();
  const value = issue(email, now);
  let reads = 0;
  const lookup = async () => {
    reads += 1;
    return accountState;
  };
  for (let index = 0; index < 30; index += 1) {
    assert.ok(await bounded(value, lookup));
  }
  for (let index = 0; index < 20; index += 1) {
    assert.equal(await bounded(value, lookup), undefined);
  }
  assert.equal(reads, 30);
  assert.ok(await bounded(issue(email, now), lookup), "another signed entry keeps its own budget");
  assert.equal(reads, 31);
});

test("signed-cookie churn cannot exceed the total pre-lookup rate", async () => {
  const bounded = limitedVerifier();
  let reads = 0;
  const lookup = async () => {
    reads += 1;
    return accountState;
  };
  for (let index = 0; index < 600; index += 1) {
    assert.ok(await bounded(issue(email, now), lookup));
  }
  for (let index = 0; index < 50; index += 1) {
    assert.equal(await bounded(issue(email, now), lookup), undefined);
  }
  assert.equal(reads, 600);
});

test("known-device proof read concurrency is bounded and failures release slots", async () => {
  const bounded = limitedVerifier();
  const entry = issue(email, now);
  const release = Promise.withResolvers();
  let reads = 0;
  const lookup = async () => {
    reads += 1;
    await release.promise;
    return accountState;
  };
  const pending = Array.from({ length: 12 }, () => bounded(entry, lookup));
  const other = bounded(issue(email, now), lookup);
  const before = reads;
  release.resolve();
  const results = await Promise.all(pending);
  assert.ok(await other);
  assert.equal(before, 3);
  assert.equal(results.filter(Boolean).length, 2);
  const failed = await Promise.all([
    bounded(entry, async () => {
      throw new Error("unavailable");
    }),
    bounded(entry, async () => {
      throw new Error("unavailable");
    }),
  ]);
  assert.deepEqual(failed, [undefined, undefined]);
  assert.ok(await bounded(entry), "failed lookups release capacity without caching state");
  assert.equal(
    await bounded(entry, async () => undefined),
    undefined,
    "a later disable still removes the exemption",
  );
});

test("distinct signed entries share a finite active-read bound", async () => {
  const bounded = limitedVerifier();
  const release = Promise.withResolvers();
  let reads = 0;
  const lookup = async () => {
    reads += 1;
    await release.promise;
    return accountState;
  };
  const pending = Array.from({ length: 40 }, () => bounded(issue(email, now), lookup));
  const before = reads;
  release.resolve();
  const results = await Promise.all(pending);
  assert.equal(before, 16);
  assert.equal(results.filter(Boolean).length, 16);
  assert.ok(await bounded(issue(email, now)), "settled work releases the total capacity");
});

test(
  "a saturated device lookup enters the shared admission lane before blocked reads finish",
  { timeout: 15_000 },
  async (t) => {
    const require = createRequire(
      new URL("../../apps/controller/src/auth/index.ts", import.meta.url),
    );
    const Fastify = require("fastify");
    const { passwordFailureAdmission } =
      await import("../../apps/controller/src/auth/admission.ts");
    const { createControllerAuth } = await import("../../apps/controller/src/auth/index.ts");
    const origin = "http://127.0.0.1";
    const authSecret = `test-secret-${randomUUID()}-${randomUUID()}`;
    const address = `route-${randomUUID()}@example.test`;
    const password = `password-${randomUUID()}`;
    const state = "synthetic-account-state";
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let signal;
    const observed = new Promise((resolve) => {
      signal = resolve;
    });
    let released = false;
    let reads = 0;
    const admissions = [];
    const actualAdmission = passwordFailureAdmission({
      perAddress: 20,
      perEmail: 10,
      slow: {
        floorMs: 20,
        maxFloorMs: 80,
        concurrentPerEmail: 2,
        waitingPerEmail: 16,
        occupancy: 1024,
        evaluating: 16,
      },
      isReserved: async () => false,
      countsAsFailure: () => true,
    });
    const auth = createControllerAuth({
      mode: "development",
      installationId: `ins_${randomUUID()}`,
      baseURL: origin,
      secret: authSecret,
      secureCookies: false,
      memoryDatabase: { user: [], account: [], session: [], verification: [], apikey: [] },
      knownDeviceState: async () => {
        reads += 1;
        if (reads === 3) {
          signal("third-read");
        }
        await gate;
        return state;
      },
      passwordAdmission: {
        admit(attempt, work) {
          admissions.push({ beforeRelease: !released, device: attempt.knownDevice !== undefined });
          if (!released) {
            signal("admission");
          }
          return actualAdmission.admit(attempt, work);
        },
      },
    });
    await auth.createAccount({ email: address, password, name: "Synthetic member" });
    const value = issueKnownDevice(authSecret, address, state, Date.now());
    const app = Fastify();
    app.post("/api/auth/sign-in/email", auth.signInEmail);
    const requests = Array.from({ length: 3 }, () =>
      app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { host: "127.0.0.1", origin, cookie: `occ_known_device=${value}` },
        payload: { email: address, password: "synthetic-wrong-password" },
      }),
    );
    t.after(async () => {
      released = true;
      release();
      await Promise.allSettled(requests);
      await app.close();
    });
    let timer;
    let first;
    let before;
    try {
      first = await Promise.race([
        observed,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("route did not reach either boundary")), 8_000);
        }),
      ]);
      before = { reads, admissions: admissions.filter((entry) => entry.beforeRelease) };
    } finally {
      clearTimeout(timer);
      released = true;
      release();
    }
    const responses = await Promise.all(requests);
    assert.equal(first, "admission");
    assert.equal(before.reads, 3, "two proof reads plus one already-admitted issuance-state read");
    assert.deepEqual(before.admissions, [{ beforeRelease: true, device: false }]);
    assert.deepEqual(
      responses.map((response) => response.statusCode),
      [401, 401, 401],
    );
    assert.equal(admissions.filter((entry) => entry.device).length, 2);
  },
);
test(
  "the sign-in handler bounds sequential state reads after device admission is exhausted",
  { timeout: 15_000 },
  async (t) => {
    const require = createRequire(
      new URL("../../apps/controller/src/auth/index.ts", import.meta.url),
    );
    const Fastify = require("fastify");
    const origin = "http://127.0.0.1";
    const secret = `synthetic-secret-${randomUUID()}-${randomUUID()}`;
    const email = `synthetic-${randomUUID()}@example.test`;
    const password = `synthetic-password-${randomUUID()}`;
    const state = "synthetic-account-state";
    let reads = 0;
    const { passwordFailureAdmission } =
      await import("../../apps/controller/src/auth/admission.ts");
    const { createControllerAuth } = await import("../../apps/controller/src/auth/index.ts");
    const admission = passwordFailureAdmission({
      perAddress: 1,
      perEmail: 1,
      slow: {
        floorMs: 5,
        maxFloorMs: 8,
        concurrentPerEmail: 1,
        waitingPerEmail: 8,
        occupancy: 64,
        evaluating: 8,
      },
      isReserved: async () => false,
      countsAsFailure: () => true,
    });
    const auth = createControllerAuth({
      mode: "development",
      installationId: `ins_${randomUUID()}`,
      baseURL: origin,
      secret,
      secureCookies: false,
      memoryDatabase: { user: [], account: [], session: [], verification: [], apikey: [] },
      knownDeviceState: async () => {
        reads += 1;
        return state;
      },
      passwordAdmission: admission,
    });
    await auth.createAccount({ email, password, name: "Synthetic member" });
    const cookie = issueKnownDevice(secret, email, state, Date.now());
    const app = Fastify();
    t.after(() => app.close());
    app.post("/api/auth/sign-in/email", auth.signInEmail);
    const statuses = [];
    for (let index = 0; index < 40; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { host: "127.0.0.1", origin, cookie: `occ_known_device=${cookie}` },
        payload: { email, password: "synthetic-wrong-password" },
      });
      statuses.push(response.statusCode);
    }
    assert.equal(statuses[0], 401);
    assert.ok(statuses.slice(1, 30).every((value) => value === 429));
    assert.equal(statuses[30], 429, "proof saturation cannot reopen the spent device allowance");
    assert.ok(
      statuses.slice(30).every((code) => code === 429),
      "refused proofs stay in the spent allowance",
    );
    assert.equal(reads, 31, "thirty proof reads plus the first admitted issuance-state read");
  },
);

// These controls exercise createControllerAuth's own proof limiter. Stale, genuinely
// signed entries still require an account read but cannot select a device exemption.
// Spending the shared lane first isolates proof reads from issuance-state reads and
// password hashing; the downstream admission is real, with only its pacing shortened.
async function globalProofHandler(lookup) {
  const require = createRequire(
    new URL("../../apps/controller/src/auth/index.ts", import.meta.url),
  );
  const Fastify = require("fastify");
  const { createControllerAuth } = await import("../../apps/controller/src/auth/index.ts");
  const { passwordFailureAdmission } = await import("../../apps/controller/src/auth/admission.ts");
  const origin = "http://127.0.0.1";
  const address = `global-proof-${randomUUID()}@example.test`;
  const key = `global-proof-secret-${randomUUID()}-${randomUUID()}`;
  const admission = passwordFailureAdmission({
    perAddress: 20,
    perEmail: 1,
    slow: {
      floorMs: 1,
      maxFloorMs: 1,
      concurrentPerEmail: 2,
      waitingPerEmail: 32,
      occupancy: 1024,
      evaluating: 16,
    },
    isReserved: async () => false,
    countsAsFailure: () => true,
  });
  const auth = createControllerAuth({
    mode: "development",
    installationId: `ins_${randomUUID()}`,
    baseURL: origin,
    secret: key,
    secureCookies: false,
    memoryDatabase: { user: [], account: [], session: [], verification: [], apikey: [] },
    knownDeviceState: lookup,
    passwordAdmission: admission,
  });
  const app = Fastify();
  app.post("/api/auth/sign-in/email", auth.signInEmail);
  const pending = [];
  const request = (cookie) => {
    const result = Promise.resolve(
      app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: {
          host: "127.0.0.1",
          origin,
          ...(cookie === undefined ? {} : { cookie: `occ_known_device=${cookie}` }),
        },
        payload: { email: address, password: "global-proof-wrong-password" },
      }),
    ).then(
      (response) => ({ kind: "response", response }),
      (error) => ({ kind: "request-error", error }),
    );
    pending.push(result);
    return result;
  };
  const close = async () => {
    try {
      await Promise.all(pending);
    } finally {
      await app.close();
    }
  };
  try {
    await auth.createAccount({
      email: address,
      password: `password-${randomUUID()}`,
      name: "Global proof member",
    });
    const seeded = await request();
    if (seeded.kind === "request-error") {
      throw seeded.error;
    }
    assert.equal(seeded.response.statusCode, 401, seeded.response.body);
    return {
      request,
      // Every call creates a new signed nonce/key. The old binding models a password
      // change; the real handler must read current state before discovering it is stale.
      cookie: () => issueKnownDevice(key, address, "old-password-state", Date.now()),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function assertProofRefusal(result) {
  if (result.kind === "request-error") {
    throw result.error;
  }
  assert.equal(result.kind, "response");
  assert.equal(result.response.statusCode, 429, result.response.body);
  assert.equal(result.response.headers["set-cookie"], undefined, "refusal issues no cookie");
}

test(
  "the sign-in handler enforces 600 proof reads across distinct signed entries",
  { timeout: 20_000 },
  async (t) => {
    // Freeze the real limiter's existing clock dependency: machine speed cannot roll its
    // minute while 601 distinct entries are checked. Timers remain real and bounded.
    const fixedNow = performance.now();
    const clock = t.mock.method(performance, "now", () => fixedNow);
    let fixture;
    let reads = 0;
    try {
      fixture = await globalProofHandler(async () => {
        reads += 1;
        return "current-password-state";
      });
      reads = 0; // Exclude the seeded request's separate issuance-state read.
      const cookies = Array.from({ length: 601 }, () => fixture.cookie());
      assert.equal(new Set(cookies).size, 601, "per-entry caps cannot mask the global rate cap");
      for (let index = 0; index < 600; index += 1) {
        assertProofRefusal(await fixture.request(cookies[index]));
        assert.equal(reads, index + 1, "each admitted distinct entry reads current state once");
      }
      assertProofRefusal(await fixture.request(cookies[600]));
      assert.equal(reads, 600, "the controller-wide rate cap refuses before read 601");
    } finally {
      try {
        await fixture?.close();
      } finally {
        clock.mock.restore();
      }
    }
  },
);

test(
  "the sign-in handler enforces 16 active reads across distinct signed entries",
  { timeout: 15_000 },
  async () => {
    const release = Promise.withResolvers();
    const sixteenReads = Promise.withResolvers();
    const seventeenthRead = Promise.withResolvers();
    let holding = false;
    let reads = 0;
    let fixture;
    let timer;
    const requests = [];
    try {
      fixture = await globalProofHandler(async () => {
        if (holding) {
          reads += 1;
          if (reads === 16) {
            sixteenReads.resolve({ kind: "sixteen-reads" });
          } else if (reads > 16) {
            seventeenthRead.resolve({ kind: "seventeenth-read" });
          }
          await release.promise;
        }
        return "current-password-state";
      });
      const cookies = Array.from({ length: 17 }, () => fixture.cookie());
      assert.equal(new Set(cookies).size, 17, "each held request uses a different signed entry");
      const deadline = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ kind: "deadline" }), 8_000);
      });
      holding = true;
      requests.push(...cookies.slice(0, 16).map((cookie) => fixture.request(cookie)));
      const started = await Promise.race([sixteenReads.promise, ...requests, deadline]);
      if (started.kind === "request-error") {
        throw started.error;
      }
      assert.equal(started.kind, "sixteen-reads", "all 16 distinct readers must be held");
      const overflow = fixture.request(cookies[16]);
      requests.push(overflow);
      const refused = await Promise.race([seventeenthRead.promise, overflow, deadline]);
      if (refused.kind === "request-error") {
        throw refused.error;
      }
      assert.equal(
        refused.kind,
        "response",
        "the controller-wide active cap must refuse before a seventeenth read",
      );
      assertProofRefusal(refused);
      assert.equal(reads, 16);
    } finally {
      clearTimeout(timer);
      release.resolve();
      // Join every response even when the explicit extra-reader negative oracle fails.
      await Promise.all(requests);
      await fixture?.close();
    }
    for (const response of await Promise.all(requests)) {
      assertProofRefusal(response);
    }
    assert.equal(reads, 16, "settling held work must not start a refused read");
  },
);
