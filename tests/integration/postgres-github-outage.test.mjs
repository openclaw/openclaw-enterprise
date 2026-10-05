import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import {
  PostgresHumanAuthentication,
  PostgresPlatformState,
} from "../../packages/occ/src/index.ts";
import {
  attachProvider,
  authRowCounts,
  composeProductionSignIn,
  consoleOrigin as origin,
  currentSession,
  githubSignIn,
  githubUpgradeSettings,
  onboardPasswordAccounts,
  passwordSignIn,
  signedInHeaders,
  startFakeGitHub,
} from "../helpers/production-sign-in.mjs";
import { cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";
import { hashLocalPassword } from "../../apps/controller/src/auth/index.ts";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";
import { assertSpentDeviceProofRefusal } from "../helpers/password-proof-refusal.mjs";

const adminEmail = "outage-recovery@example.test";
const password = "outage-member-password";
const authSecret = "outage-auth-test-secret-at-least-32-bytes";
const secrets = {
  "occ-auth/secret": authSecret,
  "occ-github-login/client-id": "outage-client-id",
  "occ-github-login/client-secret": "outage-client-secret",
};
const memberSubject = 7_000_001;

// GitHub is optional: when it errors or stalls, GitHub sign-in fails closed and password
// sign-in keeps working; strangers can slow the recovery administrator's password but never
// refuse it.
// The provider fixture replaces only remote HTTP to github.com and api.github.com.
test(
  "a GitHub outage fails GitHub sign-in closed while password sign-in keeps working",
  requiresPostgres,
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const state = new PostgresPlatformState(pool);
    let app;
    t.after(async () => {
      await app?.close();
      await pool.end();
    });
    // In "hang" mode the provider never answers; the controller's shared provider deadline
    // must end the wait.
    const provider = await startFakeGitHub(t);

    // Password onboarding on the default install, then the GitHub upgrade. Members read the
    // Installation but do not administer it, so a spent email refuses them.
    const { admin, accounts } = await onboardPasswordAccounts(t, {
      databaseUrl,
      state,
      pool,
      email: adminEmail,
      authSecret,
      secrets,
      password,
      accounts: {
        member: { email: "outage-member@example.test" },
        other: { email: "outage-other@example.test" },
        resetMember: { email: "outage-reset@example.test" },
        disabledMember: { email: "outage-disabled@example.test" },
      },
    });
    const { member, other, resetMember, disabledMember } = accounts;
    app = await composeProductionSignIn(t, {
      databaseUrl,
      settings: githubUpgradeSettings(admin.id),
      secrets,
    });
    const adminHeaders = await signedInHeaders(app, origin, admin);
    const attached = await attachProvider(
      app,
      adminHeaders,
      member.id,
      "github",
      String(memberSubject),
    );
    assert.equal(attached.statusCode, 200, attached.body);

    const memberGitHubSignIn = async (remoteAddress) =>
      (await githubSignIn(app, origin, memberSubject, remoteAddress)).callback;
    const sessionCount = async () => (await authRowCounts(pool)).sessions;
    async function assertFailedClosed(callback, sessionsBefore) {
      assert.equal(callback.statusCode, 302);
      assert.equal(callback.headers.location, "/console/?authError=github");
      assert.equal(callback.headers["set-cookie"], undefined);
      assert.equal(await sessionCount(), sessionsBefore, "no session is issued");
    }

    await t.test("the fixture provider signs the attached account in while up", async () => {
      const callback = await memberGitHubSignIn();
      assert.equal(callback.headers.location, "/console/", callback.body);
      const cookie = cookieHeaderFromSetCookie(callback.headers["set-cookie"]);
      assert.equal((await currentSession(app, cookie)).user.id, member.id);
    });

    await t.test("provider 5xx fails closed; password sign-in keeps working", async () => {
      provider.mode = "error";
      const before = await sessionCount();
      await assertFailedClosed(await memberGitHubSignIn(), before);
      const signedIn = await passwordSignIn(app, origin, member);
      assert.equal(signedIn.statusCode, 200, signedIn.body);
      const cookie = cookieHeaderFromSetCookie(signedIn.headers["set-cookie"]);
      assert.equal((await currentSession(app, cookie)).user.id, member.id);
      const signedOut = await app.inject({
        method: "POST",
        url: "/api/auth/sign-out",
        headers: { cookie, origin },
      });
      assert.equal(signedOut.statusCode, 200, signedOut.body);
      assert.equal(await currentSession(app, cookie), null);
    });

    await t.test(
      "a hung provider fails closed at the deadline without blocking passwords",
      async () => {
        provider.mode = "hang";
        const before = await sessionCount();
        const started = performance.now();
        const pending = memberGitHubSignIn();
        // Password sign-in proceeds while the provider exchange is stalled.
        const signedIn = await passwordSignIn(app, origin, member, "192.0.2.51");
        assert.equal(signedIn.statusCode, 200, signedIn.body);
        const callback = await pending;
        const elapsed = performance.now() - started;
        assert.ok(elapsed >= 9_000 && elapsed < 20_000, `deadline elapsed ${elapsed} ms`);
        await assertFailedClosed(callback, before + 1);
      },
    );

    const wrong = "outage-wrong-password";

    await t.test("successful password sign-ins spend no budget during an outage", async () => {
      provider.mode = "error";
      // Only failed sign-ins count: more successes in one minute than the ten-failure budget
      // from one address all sign in.
      for (let index = 0; index < 12; index += 1) {
        const signedIn = await passwordSignIn(app, origin, other, "198.51.100.1");
        assert.equal(signedIn.statusCode, 200, signedIn.body);
      }
      assert.equal(
        (await memberGitHubSignIn("203.0.113.10")).headers.location,
        "/console/?authError=github",
      );
    });

    await t.test(
      "without a trusted proxy, one ingress address is never an Installation-wide budget",
      async () => {
        // The fixture sets no trusted proxy, so every browser reaches the API from one
        // address. Failures there for many emails spend only those emails' budgets.
        const ingress = "198.51.100.1";
        for (let index = 0; index < 25; index += 1) {
          const response = await passwordSignIn(
            app,
            origin,
            { email: `outage-guess-${index}@example.test`, password: wrong },
            ingress,
          );
          assert.equal(response.statusCode, 401, response.body);
        }
        const signedIn = await passwordSignIn(app, origin, member, ingress);
        assert.equal(signedIn.statusCode, 200, signedIn.body);
        // External start has no per-minute budget to spend, and junk callbacks without the
        // browser's attempt cookie spend only their own key, never a real browser's.
        provider.mode = "up";
        for (let index = 0; index < 35; index += 1) {
          const start = await app.inject({
            method: "POST",
            url: "/api/auth/providers/github/start",
            remoteAddress: ingress,
            headers: { origin },
          });
          assert.equal(start.statusCode, 200, start.body);
        }
        for (let index = 0; index < 35; index += 1) {
          const junk = await app.inject({
            url: `/api/auth/providers/github/callback?state=${"j".repeat(43)}&code=junk`,
            remoteAddress: ingress,
          });
          assert.equal(junk.headers.location, "/console/?authError=github");
        }
        const callback = await memberGitHubSignIn(ingress);
        assert.equal(callback.headers.location, "/console/", callback.body);
      },
    );

    await t.test("GitHub sign-in recovers without a restart", async () => {
      provider.mode = "up";
      const callback = await memberGitHubSignIn("192.0.2.60");
      assert.equal(callback.headers.location, "/console/", callback.body);
    });

    // Known-device cookie in the guarded profile: a browser that signed in to an account
    // before spends its own lane instead of the email's (or the shared recovery lane), so a
    // stranger who knows the email cannot keep that browser out. The cookie never signs in.
    const knownDeviceOf = (response) =>
      [response.headers["set-cookie"] ?? []]
        .flat()
        .find((value) => value.startsWith("__Host-occ_known_device="))
        ?.split(";", 1)[0];
    const signInWith = (cookie, account, remoteAddress) =>
      app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        remoteAddress,
        headers: { origin, cookie },
        payload: { email: account.email, password: account.password },
      });
    await t.test("a GitHub sign-in marks the browser for password fallback", async () => {
      provider.mode = "up";
      const callback = await memberGitHubSignIn("192.0.2.61");
      assert.equal(callback.headers.location, "/console/", callback.body);
      const setCookie = [callback.headers["set-cookie"]]
        .flat()
        .find((value) => value.startsWith("__Host-occ_known_device="));
      assert.match(setCookie, /HttpOnly/i);
      assert.match(setCookie, /Secure/i);
      assert.match(setCookie, /SameSite=Strict/i);
      assert.match(setCookie, /Path=\//);
      assert.doesNotMatch(setCookie, /Domain=/i);
      const refused = await passwordSignIn(
        app,
        origin,
        { ...member, password: wrong },
        "192.0.2.61",
      );
      assert.equal(refused.statusCode, 401);
      assert.equal(knownDeviceOf(refused), undefined, "a failure marks nothing");
    });

    await t.test(
      "a known browser keeps signing in while strangers spend the member's email",
      async () => {
        const signedIn = await passwordSignIn(app, origin, member, "192.0.2.62");
        assert.equal(signedIn.statusCode, 200, signedIn.body);
        const device = knownDeviceOf(signedIn);
        assert.ok(device, "a password sign-in marks the browser");
        // Strangers from many addresses spend the member's email key.
        let refusedAt;
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
            assert.equal(response.statusCode, 401, response.body);
          }
        }
        assert.notEqual(refusedAt, undefined, "the email key is spent");
        assert.equal(
          (await passwordSignIn(app, origin, member, "192.0.2.63")).statusCode,
          429,
          "a new browser is refused",
        );
        const known = await signInWith(device, member, "192.0.2.62");
        assert.equal(known.statusCode, 200, known.body);
        const cookie = cookieHeaderFromSetCookie(known.headers["set-cookie"]);
        assert.equal((await currentSession(app, cookie)).user.id, member.id);
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
        assert.equal(signedIn.statusCode, 200, signedIn.body);
        const cookie = knownDeviceOf(signedIn);
        assert.ok(cookie);
        // The same controller/verifier/admission path serves the external-provider profile.
        // No request after its device budget is spent may gain another credential check.
        for (let index = 0; index < 10; index += 1) {
          const response = await signInWith(cookie, { ...other, password: wrong }, "192.0.2.80");
          assert.equal(response.statusCode, 401, `attempt ${index}: ${response.body}`);
        }
        await assertSpentDeviceProofRefusal({
          installReader(holdRead) {
            const readState = PostgresHumanAuthentication.prototype.knownDeviceState;
            return t.mock.method(
              PostgresHumanAuthentication.prototype,
              "knownDeviceState",
              function (email) {
                if (email === other.email) {
                  return holdRead(() => readState.call(this, email));
                }
                return readState.call(this, email);
              },
            );
          },
          signIn: () => signInWith(cookie, { ...other, password: wrong }, "192.0.2.80"),
          knownDeviceOf,
        });
      },
    );

    await t.test("strangers spending the recovery email slow it but never refuse it", async () => {
      const signedIn = await passwordSignIn(app, origin, admin, "192.0.2.64");
      assert.equal(signedIn.statusCode, 200, signedIn.body);
      const device = knownDeviceOf(signedIn);
      assert.ok(device, "a password sign-in marks the browser");
      // Anyone who knows the recovery email can spend its budget.
      let refused;
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
          assert.equal(response.statusCode, 401, response.body);
        }
      }
      assert.ok(refused, "the recovery email's budget is spent");
      assert.ok(Number(refused.headers["retry-after"]) >= 1, "refusals carry Retry-After");
      // A new browser's correct recovery password is still checked, after the slowed floor.
      const started = performance.now();
      const slowed = await passwordSignIn(app, origin, admin, "192.0.2.65");
      assert.equal(slowed.statusCode, 200, slowed.body);
      assert.ok(performance.now() - started >= 1_000, "the attempt was slowed");
      assert.equal(
        (await currentSession(app, cookieHeaderFromSetCookie(slowed.headers["set-cookie"]))).user
          .id,
        admin.id,
      );
      // The browser that signed in before spends its own lane instead.
      const known = await signInWith(device, admin, "192.0.2.64");
      assert.equal(known.statusCode, 200, known.body);
      const cookie = cookieHeaderFromSetCookie(known.headers["set-cookie"]);
      assert.equal((await currentSession(app, cookie)).user.id, admin.id);
    });

    // A known-device entry is bound to the account's password and enabled state: a password
    // reset revokes every entry issued before it, and a disabled account's entries verify
    // nothing. A revoked entry is simply ignored: the attempt spends the shared lane like a
    // new browser, with the same answer.
    const spendEmail = async (account, prefix) => {
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
        assert.equal(response.statusCode, 401, response.body);
      }
      assert.fail("the email key is spent");
    };
    const accountVersion = async (userId) => {
      const read = await app.inject({ url: `/api/auth/accounts/${userId}`, headers: adminHeaders });
      assert.equal(read.statusCode, 200, read.body);
      return read.json().data.version;
    };
    const changeAccount = async (userId, operation) => {
      const response = await app.inject({
        method: "POST",
        url: `/api/auth/accounts/${userId}/${operation}`,
        headers: adminHeaders,
        payload: { expectedVersion: await accountVersion(userId) },
      });
      assert.equal(response.statusCode, 200, response.body);
    };

    await t.test("a password reset revokes the browser's known-device exemption", async () => {
      const before = await passwordSignIn(app, origin, resetMember, "192.0.2.70");
      assert.equal(before.statusCode, 200, before.body);
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
      assert.equal(after.statusCode, 200, after.body);
      const currentDevice = knownDeviceOf(after);
      await spendEmail(reset, "203.0.113.20");
      // The entry from before the reset is ignored: same answer as a new browser.
      const stale = await signInWith(staleDevice, reset, "192.0.2.70");
      const fresh = await passwordSignIn(app, origin, reset, "192.0.2.72");
      assert.equal(stale.statusCode, 429, stale.body);
      assert.equal(fresh.statusCode, 429, fresh.body);
      assert.equal(knownDeviceOf(stale), undefined);
      // The entry issued after the reset still keeps its own lane.
      const known = await signInWith(currentDevice, reset, "192.0.2.71");
      assert.equal(known.statusCode, 200, known.body);
    });

    await t.test("a disabled account's known-device entries verify nothing", async () => {
      const signedIn = await passwordSignIn(app, origin, disabledMember, "192.0.2.80");
      assert.equal(signedIn.statusCode, 200, signedIn.body);
      const device = knownDeviceOf(signedIn);
      assert.ok(device);
      await changeAccount(disabledMember.id, "disable");
      // With the email's budget left, the correct password is refused exactly like a wrong
      // one, with or without the cookie.
      const withCookie = await signInWith(device, disabledMember, "192.0.2.80");
      const withoutCookie = await passwordSignIn(app, origin, disabledMember, "192.0.2.81");
      assert.equal(withCookie.statusCode, 401, withCookie.body);
      assert.equal(withoutCookie.statusCode, 401, withoutCookie.body);
      const bodyOf = (response) => ({ ...response.json(), meta: undefined });
      assert.deepEqual(bodyOf(withCookie), bodyOf(withoutCookie));
      // Once strangers spend the email, the cookie no longer buys its own lane: the attempt
      // is refused like a new browser's, never answered as a credential check.
      await spendEmail(disabledMember, "203.0.113.30");
      const stale = await signInWith(device, disabledMember, "192.0.2.80");
      const fresh = await passwordSignIn(app, origin, disabledMember, "192.0.2.83");
      assert.equal(stale.statusCode, 429, stale.body);
      assert.equal(fresh.statusCode, 429, fresh.body);
      assert.deepEqual(bodyOf(stale), bodyOf(fresh));
      // Enabling the account again restores entries issued under the unchanged password;
      // resetting the password is what revokes them for good.
      await changeAccount(disabledMember.id, "enable");
      const restored = await signInWith(device, disabledMember, "192.0.2.80");
      assert.equal(restored.statusCode, 200, restored.body);
    });
  },
);
