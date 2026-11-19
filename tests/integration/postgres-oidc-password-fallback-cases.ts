import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import type { TestContext } from "node:test";
import type { Pool } from "pg";
import { hashLocalPassword } from "../../apps/controller/src/auth/index.ts";
import { PostgresHumanAuthentication } from "../../packages/occ/src/index.ts";
import { assertSessionUser, consoleOrigin as origin } from "../helpers/production-sign-in.mjs";
import { assertSpentDeviceProofRefusal } from "../helpers/password-proof-refusal.ts";
import { signInRateLimited } from "../helpers/refusal-text.mjs";
import {
  authOperation,
  changeAccount,
  injectLocalhost,
  parseAuthResponse,
  passwordSignIn,
  record,
  text,
  type Credentials,
  type FixtureAccount,
  type InjectedResponse,
  type SessionHeaders,
  type SignInApp,
} from "../helpers/postgres-sign-in-test-boundaries.ts";

type PasswordFallbackContext = {
  app: SignInApp;
  pool: Pool;
  provider: { mode: string };
  admin: FixtureAccount;
  member: FixtureAccount;
  other: FixtureAccount;
  resetMember: FixtureAccount;
  disabledMember: FixtureAccount;
  adminHeaders: SessionHeaders;
  memberOIDCSignIn: (remoteAddress?: string) => Promise<InjectedResponse>;
  wrong: string;
  slowLane: { maxFloorMs: number };
};

export async function runPasswordFallbackCases(t: TestContext, context: PasswordFallbackContext) {
  const {
    app,
    pool,
    provider,
    admin,
    member,
    other,
    resetMember,
    disabledMember,
    adminHeaders,
    memberOIDCSignIn,
    wrong,
    slowLane,
  } = context;
  // Known-device cookie in the guarded profile: a browser that signed in to an account
  // before spends its own lane instead of the email's (or the shared recovery lane), so a
  // stranger who knows the email cannot keep that browser out. The cookie never signs in.
  const knownDeviceOf = (response: Pick<InjectedResponse, "headers">) =>
    [response.headers["set-cookie"] ?? []]
      .flat()
      .find((value) => value.startsWith("__Host-occ_known_device="))
      ?.split(";", 1)[0];
  const signInWith = (cookie: string, account: Credentials, remoteAddress: string) =>
    injectLocalhost(app, "POST", "/api/auth/sign-in/email", {
      remoteAddress,
      headers: { origin, cookie },
      body: { email: account.email, password: account.password },
    });
  await t.test("a OIDC sign-in marks the browser for password fallback", async () => {
    provider.mode = "up";
    const callback = await memberOIDCSignIn("192.0.2.61");
    assert.ok(callback.headers.location === "/console/", "OIDC sign-in redirects to the Console");
    const setCookie = [callback.headers["set-cookie"] ?? []]
      .flat()
      .find((value) => value.startsWith("__Host-occ_known_device="));
    assert.ok(setCookie, "OIDC sign-in marks the browser");
    assert.ok(/HttpOnly/i.test(setCookie), "known-device cookie is HTTP-only");
    assert.ok(/Secure/i.test(setCookie), "known-device cookie is secure");
    assert.ok(
      /SameSite=Strict/i.test(setCookie),
      "known-device cookie uses strict same-site policy",
    );
    assert.ok(/Path=\//.test(setCookie), "known-device cookie covers the root path");
    assert.ok(!/Domain=/i.test(setCookie), "known-device cookie is host-only");
    const refused = await passwordSignIn(app, origin, { ...member, password: wrong }, "192.0.2.61");
    assert.equal(refused.statusCode, 401);
    assert.ok(knownDeviceOf(refused) === undefined, "a failure marks nothing");
  });

  await t.test(
    "a known browser keeps signing in while strangers spend the member's email",
    async () => {
      const signedIn = await passwordSignIn(app, origin, member, "192.0.2.62");
      assert.equal(signedIn.statusCode, 200);
      const device = knownDeviceOf(signedIn);
      assert.ok(device, "a password sign-in marks the browser");
      // Strangers from many addresses spend the member's email key.
      let refusedAt: number | undefined;
      for (let index = 0; index < 12 && refusedAt === undefined; index += 1) {
        const response = await passwordSignIn(
          app,
          origin,
          { ...member, password: wrong },
          `203.0.113.${140 + index}`,
        );
        if (response.statusCode === 429) {
          refusedAt = index;
        } else {
          assert.equal(response.statusCode, 401);
        }
      }
      assert.notEqual(refusedAt, undefined, "the email key is spent");
      assert.equal(
        (await passwordSignIn(app, origin, member, "192.0.2.63")).statusCode,
        429,
        "a new browser is refused",
      );
      const known = await signInWith(device, member, "192.0.2.62");
      assert.equal(known.statusCode, 200);
      await authOperation("verify the password fallback session", () =>
        assertSessionUser(app, known, member.id),
      );
      // The cookie is bound to its account and grants nothing for another email.
      const foreign = await signInWith(device, { ...other, password: wrong }, "192.0.2.62");
      assert.equal(foreign.statusCode, 401);
      // A valid cookie never authenticates a wrong password.
      const guessed = await signInWith(device, { ...member, password: wrong }, "192.0.2.62");
      assert.equal(guessed.statusCode, 401);
    },
  );

  await t.test(
    "guarded password admission retains a spent device when its proof budget is full",
    async (t) => {
      const signedIn = await passwordSignIn(app, origin, other, "192.0.2.80");
      assert.equal(signedIn.statusCode, 200);
      const cookie = knownDeviceOf(signedIn);
      assert.ok(cookie);
      // The same controller/verifier/admission path serves the external-provider profile.
      // No request after its device budget is spent may gain another credential check.
      for (let index = 0; index < 10; index += 1) {
        const response = await signInWith(cookie, { ...other, password: wrong }, "192.0.2.80");
        assert.equal(response.statusCode, 401, `attempt ${index}`);
      }
      await assertSpentDeviceProofRefusal({
        installReader(holdRead) {
          const readState = PostgresHumanAuthentication.prototype.knownDeviceState;
          return t.mock.method(
            PostgresHumanAuthentication.prototype,
            "knownDeviceState",
            function (this: PostgresHumanAuthentication, email: string) {
              if (email === other.email) {
                return holdRead(() => readState.call(this, email));
              }
              return readState.call(this, email);
            },
          );
        },
        signIn: async () => {
          const result = await signInWith(cookie, { ...other, password: wrong }, "192.0.2.80");
          return {
            statusCode: result.statusCode,
            headers: result.headers,
            body: "authentication response omitted",
          };
        },
        knownDeviceOf: (result) => (knownDeviceOf(result) === undefined ? undefined : "present"),
      });
    },
  );

  await t.test("strangers spending the recovery email slow it but never refuse it", async () => {
    const signedIn = await passwordSignIn(app, origin, admin, "192.0.2.64");
    assert.equal(signedIn.statusCode, 200);
    const device = knownDeviceOf(signedIn);
    assert.ok(device, "a password sign-in marks the browser");
    // Anyone who knows the recovery email can spend its budget.
    let refused: InjectedResponse | undefined;
    for (let index = 0; index < 12 && refused === undefined; index += 1) {
      const response = await passwordSignIn(
        app,
        origin,
        { ...admin, password: wrong },
        `203.0.113.${170 + index}`,
      );
      if (response.statusCode === 429) {
        refused = response;
      } else {
        assert.equal(response.statusCode, 401);
      }
    }
    assert.ok(refused, "the recovery email's budget is spent");
    assert.ok(Number(refused.headers["retry-after"]) >= 1, "refusals carry Retry-After");
    // A new browser's correct recovery password is still checked, after the slowed floor
    // (the email's second paced attempt, so the 500 ms cap).
    const started = performance.now();
    const slowed = await passwordSignIn(app, origin, admin, "192.0.2.65");
    assert.equal(slowed.statusCode, 200);
    assert.ok(performance.now() - started >= slowLane.maxFloorMs - 10, "the attempt was slowed");
    await authOperation("verify the password fallback session", () =>
      assertSessionUser(app, slowed, admin.id),
    );
    // The browser that signed in before spends its own lane instead.
    const known = await signInWith(device, admin, "192.0.2.64");
    assert.equal(known.statusCode, 200);
    await authOperation("verify the password fallback session", () =>
      assertSessionUser(app, known, admin.id),
    );
  });

  // A known-device entry is bound to the account's password and enabled state: a password
  // reset revokes every entry issued before it, and a disabled account's entries verify
  // nothing. A revoked entry is simply ignored: the attempt spends the shared lane like a
  // new browser, with the same answer.
  const spendEmail = async (account: Credentials, prefix: string) => {
    for (let index = 0; index < 12; index += 1) {
      const response = await passwordSignIn(
        app,
        origin,
        { ...account, password: wrong },
        `${prefix}.${index + 1}`,
      );
      if (response.statusCode === 429) {
        return;
      }
      assert.equal(response.statusCode, 401);
    }
    assert.fail("the email key is spent");
  };
  const assertAccountChanged = async (userId: string, operation: string) => {
    const response = await authOperation(`apply the password fallback account ${operation}`, () =>
      changeAccount(app, adminHeaders, userId, operation),
    );
    assert.equal(response.statusCode, 200);
  };

  await t.test("a password reset revokes the browser's known-device exemption", async () => {
    const before = await passwordSignIn(app, origin, resetMember, "192.0.2.70");
    assert.equal(before.statusCode, 200);
    const staleDevice = knownDeviceOf(before);
    assert.ok(staleDevice);
    // An operator resets the password; the database bumps the method's version.
    const newPassword = "outage-reset-new-password";
    const { rowCount } = await pool.query(
      `UPDATE occ.account SET password = $1 WHERE provider_id = 'credential'
     AND user_id = $2`,
      [await hashLocalPassword(newPassword), resetMember.id],
    );
    assert.equal(rowCount, 1);
    const reset = { ...resetMember, password: newPassword };
    // A sign-in with the new password marks another browser under the new state.
    const after = await passwordSignIn(app, origin, reset, "192.0.2.71");
    assert.equal(after.statusCode, 200);
    const currentDevice = knownDeviceOf(after);
    assert.ok(currentDevice, "the reset password marks the browser");
    await spendEmail(reset, "203.0.113.20");
    // The entry from before the reset is ignored: same answer as a new browser.
    const stale = await signInWith(staleDevice, reset, "192.0.2.70");
    const fresh = await passwordSignIn(app, origin, reset, "192.0.2.72");
    assert.equal(stale.statusCode, 429);
    assert.equal(fresh.statusCode, 429);
    assert.ok(knownDeviceOf(stale) === undefined, "a stale device receives no replacement");
    // The entry issued after the reset still keeps its own lane.
    const known = await signInWith(currentDevice, reset, "192.0.2.71");
    assert.equal(known.statusCode, 200);
  });

  await t.test("a disabled account's known-device entries verify nothing", async () => {
    const signedIn = await passwordSignIn(app, origin, disabledMember, "192.0.2.80");
    assert.equal(signedIn.statusCode, 200);
    const device = knownDeviceOf(signedIn);
    assert.ok(device);
    await assertAccountChanged(disabledMember.id, "disable");
    // With the email's budget left, the correct password is refused exactly like a wrong
    // one, with or without the cookie.
    const withCookie = await signInWith(device, disabledMember, "192.0.2.80");
    const withoutCookie = await passwordSignIn(app, origin, disabledMember, "192.0.2.81");
    assert.equal(withCookie.statusCode, 401);
    assert.equal(withoutCookie.statusCode, 401);
    const bodyOf = (response: InjectedResponse): Record<string, unknown> => ({
      ...record(parseAuthResponse("read the password refusal", response)),
      meta: undefined,
    });
    assert.ok(
      isDeepStrictEqual(bodyOf(withCookie), bodyOf(withoutCookie)),
      "disabled account refusals match",
    );
    // Once strangers spend the email, the cookie no longer buys its own lane: the attempt
    // is refused like a new browser's, never answered as a credential check.
    await spendEmail(disabledMember, "203.0.113.30");
    const stale = await signInWith(device, disabledMember, "192.0.2.80");
    const fresh = await passwordSignIn(app, origin, disabledMember, "192.0.2.83");
    assert.equal(stale.statusCode, 429);
    assert.equal(fresh.statusCode, 429);
    // Each refusal names its own wait, which counts down between the two requests (finding
    // 2608: 60 vs 59 across a second boundary). Check each message against its own Retry-After,
    // then require the rest of the two answers to match.
    const limitedBodyOf = (response: InjectedResponse) => {
      const body = bodyOf(response);
      const error = record(body.error);
      assert.ok(
        text(error.message) === signInRateLimited(Number(response.headers["retry-after"])),
        "rate-limit message matches Retry-After",
      );
      return { ...body, error: { ...error, message: undefined } };
    };
    assert.ok(
      isDeepStrictEqual(limitedBodyOf(stale), limitedBodyOf(fresh)),
      "rate-limit refusals match",
    );
    // Enabling the account again restores entries issued under the unchanged password;
    // resetting the password is what revokes them for good.
    await assertAccountChanged(disabledMember.id, "enable");
    const restored = await signInWith(device, disabledMember, "192.0.2.80");
    assert.equal(restored.statusCode, 200);
  });
}
