import assert from "node:assert/strict";
import test from "node:test";
import {
  knownDeviceCookieName,
  knownDeviceFromCookieHeader,
  verifyKnownDevice,
} from "../../apps/controller/src/auth/known-device.ts";
import { SIGN_IN_RATE_LIMITED_MINUTE } from "../helpers/refusal-text.mjs";
import {
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
import type { OperationalEvent } from "./password-sign-in-audit-fixture.ts";
import { registerPasswordSignInEmailCases } from "./password-sign-in-audit-email-cases.ts";
import { registerPasswordSignInOutcomeCases } from "./password-sign-in-audit-outcome-cases.ts";

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

registerPasswordSignInOutcomeCases();

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
