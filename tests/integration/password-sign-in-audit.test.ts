import assert from "node:assert/strict";
import test from "node:test";
import {
  knownDeviceCookieName,
  knownDeviceFromCookieHeader,
  verifyKnownDevice,
} from "../../apps/controller/src/auth/known-device.ts";
import { SIGN_IN_RATE_LIMITED_MINUTE } from "../helpers/refusal-text.mjs";
import {
  APIError,
  REFUSED,
  assertLimited,
  assertUnavailable,
  baseURL,
  controller,
  email,
  errorOf,
  guardedController,
  password,
  secret,
  send,
  signIn,
} from "./password-sign-in-audit-fixture.ts";
import type { OperationalEvent, Outcome } from "./password-sign-in-audit-fixture.ts";
import { registerPasswordSignInEmailCases } from "./password-sign-in-audit-email-cases.ts";

function controllerWithRecordedOutcomes() {
  const outcomes: Outcome[] = [];
  const { auth, memoryDatabase } = controller({
    accepted: async (userId) => {
      outcomes.push(["accepted", userId]);
    },
    refused: async () => {
      outcomes.push(["refused"]);
    },
  });
  return { auth, memoryDatabase, outcomes };
}

async function assertDenialAuditFailureSpendsBudget(
  auth: Parameters<typeof signIn>[0],
  denialCount: () => number,
  events: OperationalEvent[],
) {
  // The audit outage is reported, never hidden behind a 401.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    assertUnavailable(await signIn(auth, { email, password: "wrong-password-guess" }));
  }
  assert.equal(denialCount(), 10);
  // Every failed guess counted: the next attempt is refused before the password is checked.
  assertLimited(await signIn(auth, { email, password: "wrong-password-guess" }));
  assert.equal(denialCount(), 10);
  assert.deepEqual(
    events.map(({ event, lane }) => [event, lane]),
    [["authentication.sign-in-limited", "email"]],
  );
}

test("a password-only sign-in reports its outcome to the audit seam", async () => {
  const { auth, memoryDatabase, outcomes } = controllerWithRecordedOutcomes();
  const account = await auth.createAccount({ email, password });
  assert.equal((await signIn(auth, { email, password })).status, 200);
  // A wrong password and an unknown email get the same answer, so it names no account.
  for (const guess of [email, "nobody@example.test"]) {
    const refused = await signIn(auth, { email: guess, password: "wrong-password-guess" });
    assert.equal(refused.status, 401);
    assert.deepEqual(errorOf(refused), { code: "UNAUTHENTICATED", message: REFUSED });
  }
  assert.deepEqual(outcomes, [["accepted", account.id], ["refused"], ["refused"]]);
  assert.equal(memoryDatabase.session.length, 1);
});

test("a sign-in that fails on its dependency is 503, not an audited or counted refusal", async () => {
  const { auth, memoryDatabase, outcomes } = controllerWithRecordedOutcomes();
  await auth.createAccount({ email, password });
  // Every account read now fails, as it would with the database down.
  Object.defineProperty(memoryDatabase, "user", {
    get() {
      throw new Error("database unavailable");
    },
  });
  // Nothing was refused, so nothing is audited as a refusal and no budget is spent: the
  // email lane admits ten failures, so the eleventh attempt would be 429 if these counted.
  for (let attempt = 0; attempt < 11; attempt += 1) {
    assertUnavailable(await signIn(auth, { email, password: "wrong-password-guess" }));
  }
  assert.deepEqual(outcomes, []);
});

test("a sign-in whose audit cannot be written is refused and its session revoked", async () => {
  const { auth, memoryDatabase } = controller({
    accepted: async () => {
      throw new Error("audit unavailable");
    },
    refused: async () => {},
  });
  await auth.createAccount({ email, password });
  const response = await signIn(auth, { email, password });
  assert.equal(response.status, 503, JSON.stringify(response.payload));
  assert.equal(response.headers["set-cookie"], undefined);
  assert.equal(memoryDatabase.session.length, 0);
});

for (const status of [500, 503, 599]) {
  test(`a dependency APIError ${status} is unavailable without spending the password budget`, async () => {
    const { auth, memoryDatabase, outcomes } = controllerWithRecordedOutcomes();
    const account = await auth.createAccount({ email, password });
    const users = memoryDatabase.user;
    let unavailable = true;
    Object.defineProperty(memoryDatabase, "user", {
      get() {
        if (unavailable) {
          throw new APIError(status, { message: "synthetic dependency failure" });
        }
        return users;
      },
    });
    // Eleven admitted failures distinguish an outage from the ten-failure email budget.
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await signIn(auth, { email, password });
      assert.equal(response.status, 503);
      assert.equal(errorOf(response).code, "DEPENDENCY_UNAVAILABLE");
      assert.equal(response.headers["set-cookie"], undefined);
    }
    assert.deepEqual(outcomes, []);
    assert.equal(memoryDatabase.session.length, 0);
    unavailable = false;
    assert.equal((await signIn(auth, { email, password })).status, 200);
    assert.deepEqual(outcomes, [["accepted", account.id]]);
  });
}

for (const [status, expectedStatus, expectedCode] of [
  [400, 400, "FORBIDDEN"],
  [401, 401, "UNAUTHENTICATED"],
  [409, 409, "RESOURCE_CONFLICT"],
  [429, 429, "RATE_LIMITED"],
  [499, 499, "FORBIDDEN"],
  [399, 401, "UNAUTHENTICATED"],
  [600, 401, "UNAUTHENTICATED"],
  [500.5, 401, "UNAUTHENTICATED"],
  ["500", 401, "UNAUTHENTICATED"],
] as const) {
  test(`dependency APIError ${JSON.stringify(status)} preserves its non-5xx classification`, async () => {
    let refusals = 0;
    const { auth, memoryDatabase } = controller({
      accepted: async () => assert.fail("a failed dependency cannot sign in"),
      refused: async () => {
        refusals += 1;
      },
    });
    await auth.createAccount({ email, password });
    Object.defineProperty(memoryDatabase, "user", {
      get() {
        throw new APIError(status, { message: "synthetic dependency failure" });
      },
    });
    const response = await signIn(auth, { email, password });
    assert.equal(response.status, expectedStatus);
    assert.equal(errorOf(response).code, expectedCode);
    assert.equal(response.headers["set-cookie"], undefined);
    assert.equal(refusals, 1);
    assert.equal(memoryDatabase.session.length, 0);
  });
}

test("a wrong password whose denial audit fails is 503 and still spends the budget", async () => {
  let refusals = 0;
  const events: OperationalEvent[] = [];
  const { auth } = controller(
    {
      accepted: async () => {},
      refused: async () => {
        refusals += 1;
        throw new Error("audit unavailable");
      },
    },
    { onOperationalEvent: (event) => events.push(event) },
  );
  await auth.createAccount({ email, password });
  await assertDenialAuditFailureSpendsBudget(auth, () => refusals, events);
});

test("guarded profile: a wrong password whose denial audit fails is 503 and still spends the budget", async () => {
  let denials = 0;
  const events: OperationalEvent[] = [];
  const auth = guardedController({
    installationId: "ins_sign_in_audit_guarded",
    state: {
      // The exhausted budget reads the durable designation; only the denial audit is down.
      recoveryDesignation: async () => ({
        userId: "guarded-recovery",
        principalId: "prn_guarded_recovery",
        email: "recovery@example.test",
      }),
      recordDenied: async () => {
        denials += 1;
        throw new Error("audit unavailable");
      },
    },
    onOperationalEvent: (event) => events.push(event),
  });
  await assertDenialAuditFailureSpendsBudget(auth, () => denials, events);
});

// The external sign-in budgets refill each minute and set no Retry-After, so the answer says to
// wait a minute; only the password limiter names a wait (findings 2535, 2555). The console shows
// this text's meaning from the status alone, so the API text is pinned here.
test("guarded profile: a spent provider result budget says to wait a minute, with no Retry-After", async () => {
  const auth = guardedController({ installationId: "ins_sign_in_audit_provider_limit" });
  const result = () =>
    send(auth.googleResult, {
      id: "req_provider_limit",
      ip: "127.0.0.1",
      method: "POST",
      url: "/api/auth/providers/google/result",
      headers: { origin: baseURL },
      body: { attemptId: "a".repeat(43) },
    });
  // Without a receipt every exchange is refused, and each one spends the browser's budget of
  // 30 a minute.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const refused = await result();
    assert.equal(refused.status, 401, JSON.stringify(refused.payload));
    assert.equal(errorOf(refused).message, "Google sign-in could not be confirmed.");
  }
  const limited = await result();
  assert.equal(limited.status, 429, JSON.stringify(limited.payload));
  assert.equal(limited.headers["retry-after"], undefined);
  assert.deepEqual(errorOf(limited), {
    code: "RATE_LIMITED",
    message: SIGN_IN_RATE_LIMITED_MINUTE,
  });
});

test("a password reset during a sign-in revokes the known-device entry that sign-in sets", async () => {
  // The audit hook runs after the password check, the latest point a reset can commit
  // before the entry is issued. The entry must be bound to the state the old password
  // was checked against, so the reset revokes it.
  let version = 1;
  const reads: string[] = [];
  const knownDeviceState = async (address: string) => {
    reads.push(address);
    return `password\0user-1\0method-1\0${version}`;
  };
  const { auth } = controller(
    {
      accepted: async () => {
        version += 1;
      },
      refused: async () => {},
    },
    { knownDeviceState },
  );
  await auth.createAccount({ email, password });
  const response = await signIn(auth, { email, password });
  assert.equal(response.status, 200, JSON.stringify(response.payload));
  const cookies = [response.headers["set-cookie"]]
    .flat()
    .filter((value): value is string => typeof value === "string");
  const name = knownDeviceCookieName(true);
  const entry = cookies.find((value) => value.startsWith(`${name}=`));
  assert.ok(entry, "a successful sign-in marks the browser");
  const value = knownDeviceFromCookieHeader(entry.split(";", 1)[0], true);
  assert.deepEqual(reads, [email], "the state is read once per attempt");
  assert.equal(
    await verifyKnownDevice(secret, email, value, Date.now(), knownDeviceState),
    undefined,
    "the entry does not verify against the reset state",
  );
  // Without a concurrent reset, the entry verifies against the current state.
  const current = async () => `password\0user-1\0method-1\0${version - 1}`;
  assert.ok(await verifyKnownDevice(secret, email, value, Date.now(), current));
});

registerPasswordSignInEmailCases();
