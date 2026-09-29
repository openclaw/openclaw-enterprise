import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import {
  assertReservedLane,
  bootstrapProductionInstallation,
  clientAddresses,
  composeProductionSignIn,
  consoleOrigin as origin,
  currentSession,
  defaultInstallSettings,
  fakeGoogle,
  githubSignIn,
  githubUpgradeSettings,
  googleSignIn,
  googleUpgradeSettings,
  installationRoles,
  passwordSignIn,
  readAccount,
  signedInHeaders,
  startFakeGitHub,
} from "../helpers/production-sign-in.mjs";
import { cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const adminEmail = "google-recovery@example.test";
const password = "google-member-password";
const authSecret = "google-sign-in-auth-test-secret-at-least-32-bytes";
const googleClientId = "fixture-oce.apps.googleusercontent.com";
const googleClientSecret = "fixture-google-client-secret";
const hostedDomain = "example.test";
const secrets = {
  "occ-auth/secret": authSecret,
  "occ-google-login/client-id": googleClientId,
  "occ-google-login/client-secret": googleClientSecret,
  "occ-github-login/client-id": "google-suite-github-client-id",
  "occ-github-login/client-secret": "google-suite-github-client-secret",
};
const digest = (value) => createHash("sha256").update(value).digest("hex");
const googleProviderId = `google:${digest(googleClientId)}`;
const githubProviderId = `github:${digest("google-suite-github-client-id")}`;
const memberSubject = "110000000000000000001";
const strangerSubject = "110000000000000000002";
const disabledSubject = "110000000000000000003";
const bothSubject = "110000000000000000004";
const bothGithubSubject = "9500004";
const sessionCookieName = "__Host-openclaw_occ.session_token";

// The Google provider fixture replaces only Google's token and key endpoints. State,
// audit, IAM, Better Auth, the guarded human-login profile and Fastify are production code.
test(
  "PostgreSQL Google sign-in admits only attached identities through the guarded profile",
  { skip: databaseUrl ? false : "Set OCC_TEST_DATABASE_URL for real PostgreSQL proof." },
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const state = new PostgresPlatformState(pool);
    let app;
    t.after(async () => {
      await app?.close();
      await pool.end();
    });
    const google = fakeGoogle(t, {
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      hd: hostedDomain,
    });
    const address = clientAddresses("198.19");
    const adminPassword = await bootstrapProductionInstallation(t, {
      databaseUrl,
      email: adminEmail,
      authSecret,
    });
    const admin = { email: adminEmail, password: adminPassword };
    const roles = await installationRoles(state, pool);

    // Password onboarding on the default install, before Google is configured.
    app = await composeProductionSignIn(t, {
      databaseUrl,
      settings: defaultInstallSettings,
      secrets,
    });
    let adminHeaders = await signedInHeaders(app, origin, admin, address());
    admin.id = (await currentSession(app, adminHeaders.cookie)).user.id;
    const accounts = {};
    for (const [name, role] of [
      ["member", roles.reader],
      ["disabled", roles.reader],
      ["both", roles.reader],
    ]) {
      const email = `google-${name}@${hostedDomain}`;
      const created = await app.inject({
        method: "POST",
        url: "/api/auth/accounts",
        headers: adminHeaders,
        payload: { email, password, roleId: role.id },
      });
      assert.equal(created.statusCode, 201, created.body);
      accounts[name] = { id: created.json().data.id, email, password };
    }
    const { member, disabled, both } = accounts;
    await app.close();

    // A Google-only upgrade: no OCC_AUTH_GITHUB_CLIENT_*, hosted domain restricted.
    app = await composeProductionSignIn(t, {
      databaseUrl,
      settings: googleUpgradeSettings(admin.id, [hostedDomain]),
      secrets,
    });
    adminHeaders = await signedInHeaders(app, origin, admin, address());

    const counts = async () =>
      (
        await pool.query(
          `SELECT (SELECT count(*)::int FROM occ."user") AS users,
                  (SELECT count(*)::int FROM occ.account) AS methods,
                  (SELECT count(*)::int FROM occ.session) AS sessions`,
        )
      ).rows[0];
    const denials = async (reason) =>
      (await state.transact((unit) => unit.audit.list())).filter(
        ({ action, outcome, reasonCode }) =>
          action === "authentication.login" && outcome === "denied" && reasonCode === reason,
      ).length;
    const attach = async (userId, provider, subject) => {
      const response = await app.inject({
        method: "POST",
        url: `/api/auth/accounts/${userId}/providers/${provider}`,
        headers: adminHeaders,
        payload: {
          subject,
          expectedVersion: (await readAccount(app, adminHeaders, userId)).version,
        },
      });
      assert.equal(response.statusCode, 200, response.body);
      return response;
    };
    async function assertGoogleRefused(
      authorization,
      message,
      reason = "EXTERNAL_IDENTITY_REJECTED",
    ) {
      const before = await counts();
      const deniedBefore = await denials(reason);
      const { callback } = await googleSignIn(app, origin, google, authorization, address());
      assert.equal(callback.statusCode, 302, message);
      assert.equal(callback.headers.location, "/console/?authError=google", message);
      assert.equal(
        String(callback.headers["set-cookie"] ?? "").includes(sessionCookieName),
        false,
        `${message}: no session cookie`,
      );
      assert.deepEqual(await counts(), before, `${message}: no user, method or session`);
      assert.equal(await denials(reason), deniedBefore + 1, `${message}: the denial is audited`);
    }
    async function assertGoogleSignIn(subject, userId, claims) {
      const signIn = await googleSignIn(
        app,
        origin,
        google,
        { subject, ...(claims ? { claims } : {}) },
        address(),
      );
      assert.equal(signIn.callback.headers.location, "/console/", signIn.callback.body);
      const cookie = cookieHeaderFromSetCookie(signIn.callback.headers["set-cookie"]);
      assert.equal((await currentSession(app, cookie)).user.id, userId);
      return { ...signIn, cookie };
    }

    await t.test(
      "a Google-only install activates the guarded profile and recovery from the recovery user",
      async () => {
        const providers = await app.inject({ url: "/api/auth/providers" });
        assert.deepEqual(providers.json().data, {
          github: false,
          google: true,
          sessionBinding: true,
        });
        assert.deepEqual(
          (await pool.query("SELECT user_id FROM occ.human_authentication_recovery")).rows,
          [{ user_id: admin.id }],
        );
        const recovery = await app.inject({ url: "/api/auth/recovery", headers: adminHeaders });
        assert.equal(recovery.statusCode, 200, recovery.body);
        assert.equal(recovery.json().data.userId, admin.id);
        // GitHub stays unconfigured on a Google-only install.
        const githubStart = await app.inject({
          method: "POST",
          url: "/api/auth/providers/github/start",
          remoteAddress: address(),
          headers: { origin },
        });
        assert.equal(githubStart.statusCode, 403, githubStart.body);
        // The controller's fixed endpoints are the ones Google's discovery document names.
        const start = await app.inject({
          method: "POST",
          url: "/api/auth/providers/google/start",
          remoteAddress: address(),
          headers: { origin },
        });
        assert.equal(start.statusCode, 200, start.body);
        const authorize = new URL(start.json().data.url);
        assert.equal(
          `${authorize.origin}${authorize.pathname}`,
          google.discovery.authorization_endpoint,
        );
        assert.deepEqual([...authorize.searchParams.keys()].sort(), [
          "client_id",
          "code_challenge",
          "code_challenge_method",
          "nonce",
          "redirect_uri",
          "response_type",
          "scope",
          "state",
        ]);
        assert.equal(authorize.searchParams.get("client_id"), googleClientId);
        assert.equal(authorize.searchParams.get("response_type"), "code");
        assert.equal(authorize.searchParams.get("scope"), "openid email");
        assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
        assert.equal(
          authorize.searchParams.get("redirect_uri"),
          `${origin}/api/auth/providers/google/callback`,
        );
        assert.match(
          cookieHeaderFromSetCookie(start.headers["set-cookie"]),
          /^__Host-occ_login_attempt=/,
        );
      },
    );

    await t.test("an attached Google identity signs in, binds its tab and is audited", async () => {
      const requestsBefore = google.requests;
      await attach(member.id, "google", memberSubject);
      assert.equal(google.requests, requestsBefore, "attaching never contacts Google");
      const account = await readAccount(app, adminHeaders, member.id);
      assert.deepEqual(
        account.methods
          .filter(({ providerId }) => providerId !== "credential")
          .map(({ providerId, subject }) => [providerId, subject]),
        [[googleProviderId, memberSubject]],
      );

      const signIn = await assertGoogleSignIn(memberSubject, member.id);
      const setCookies = [signIn.callback.headers["set-cookie"]].flat();
      assert.ok(
        setCookies.some(
          (cookie) =>
            cookie.startsWith(`${sessionCookieName}=`) &&
            /; Secure/i.test(cookie) &&
            /; HttpOnly/i.test(cookie) &&
            /; Path=\//i.test(cookie) &&
            !/; Domain=/i.test(cookie),
        ),
        "the session cookie is a host-only __Host- cookie",
      );
      const receipt = setCookies.find((cookie) => cookie.startsWith("__Host-occ_login_receipt="));
      assert.ok(receipt, "the callback issues a __Host- receipt");
      const token = google.tokens.at(-1);
      assert.equal(token.redirect_uri, `${origin}/api/auth/providers/google/callback`);
      assert.equal(token.grant_type, "authorization_code");

      const result = (headers, attemptId) =>
        app.inject({
          method: "POST",
          url: "/api/auth/providers/google/result",
          remoteAddress: address(),
          headers,
          payload: { attemptId },
        });
      const cookie = signIn.cookie;
      assert.equal((await result({ cookie }, signIn.attemptId)).statusCode, 403, "Origin");
      assert.equal(
        (await result({ cookie, origin }, "A".repeat(43))).statusCode,
        401,
        "another attempt's id is refused",
      );
      const exchanged = await result({ cookie, origin }, signIn.attemptId);
      assert.equal(exchanged.statusCode, 200, exchanged.body);
      const { sessionKey } = exchanged.json().data;
      assert.equal((await currentSession(app, cookie)).sessionKey, sessionKey);
      const replay = await result({ cookie, origin }, signIn.attemptId);
      assert.equal(replay.statusCode, 401, "the receipt is one-use");

      const principalId = (
        await pool.query(
          "SELECT principal_id FROM occ.human_authentication_accounts WHERE user_id = $1",
          [member.id],
        )
      ).rows[0].principal_id;
      const audits = (await state.transact((unit) => unit.audit.list()))
        .filter(
          ({ action, outcome, details }) =>
            outcome !== "denied" &&
            details?.userId === member.id &&
            /^authentication\.(login|method\.attach)$/.test(action),
        )
        .map(({ action, actorId }) => [action, actorId]);
      assert.deepEqual(audits, [
        ["authentication.method.attach", (await readRecoveryPrincipal()).principalId],
        ["authentication.login", principalId],
      ]);
      // No Google token, code or email reaches storage or audit.
      const methods = await pool.query(
        `SELECT access_token,refresh_token,id_token,access_token_expires_at,
                  refresh_token_expires_at,scope,password FROM occ.account WHERE identity_only`,
      );
      assert.ok(methods.rows.every((row) => Object.values(row).every((value) => value === null)));
      const stored = JSON.stringify([
        (await pool.query("SELECT row_to_json(a)::text AS value FROM occ.audit_events a")).rows,
        (await pool.query("SELECT row_to_json(s)::text AS value FROM occ.session s")).rows,
      ]);
      assert.equal(stored.includes("fixture-google-code-"), false);
      assert.equal(stored.includes("ya29."), false);
      assert.equal(stored.includes(`${memberSubject}@${hostedDomain}`), false);
    });

    async function readRecoveryPrincipal() {
      return (
        await pool.query(
          'SELECT principal_id AS "principalId" FROM occ.human_authentication_accounts WHERE user_id = $1',
          [admin.id],
        )
      ).rows[0];
    }

    await t.test(
      "an unattached Google identity is refused even with an existing account's email",
      async () => {
        await assertGoogleRefused(
          { subject: strangerSubject, claims: { email: member.email } },
          "unattached subject",
        );
        await assertGoogleRefused(
          { subject: strangerSubject, claims: { email: admin.email } },
          "unattached subject with the recovery email",
        );
      },
    );

    await t.test("invalid ID tokens are refused without a session", async () => {
      const now = Math.floor(Date.now() / 1000);
      for (const [message, authorization] of [
        ["wrong aud", { claims: { aud: "other.apps.googleusercontent.com" } }],
        ["wrong azp", { claims: { azp: "other.apps.googleusercontent.com" } }],
        ["wrong iss", { claims: { iss: "https://accounts.example.test" } }],
        ["wrong nonce", { claims: { nonce: "A".repeat(43) } }],
        ["missing nonce", { claims: { nonce: undefined } }],
        ["expired", { claims: { iat: now - 3000, exp: now - 60 } }],
        ["bad signature", { key: "foreign" }],
        ["hd not allowed", { claims: { hd: "other.example" } }],
        ["hd missing", { claims: { hd: undefined } }],
        ["email not verified", { claims: { email_verified: false } }],
      ]) {
        await assertGoogleRefused({ subject: memberSubject, ...authorization }, message);
      }
      // The same identity still signs in with a valid token afterwards.
      await assertGoogleSignIn(memberSubject, member.id);
    });

    await t.test("a replayed state and a missing binding cookie are refused", async () => {
      const signIn = await assertGoogleSignIn(memberSubject, member.id);
      const before = await counts();
      const replay = await app.inject({
        url: `/api/auth/providers/google/callback?state=${signIn.state}&code=${google.authorize(
          signIn.url,
          { subject: memberSubject },
        )}`,
        remoteAddress: address(),
        headers: { cookie: signIn.bindingCookie },
      });
      assert.equal(replay.headers.location, "/console/?authError=google");
      assert.deepEqual(await counts(), before);

      const start = await app.inject({
        method: "POST",
        url: "/api/auth/providers/google/start",
        remoteAddress: address(),
        headers: { origin },
      });
      const url = start.json().data.url;
      const state = new URL(url).searchParams.get("state");
      const tokensBefore = google.tokens.length;
      const unbound = await app.inject({
        url: `/api/auth/providers/google/callback?state=${state}&code=${google.authorize(url, {
          subject: memberSubject,
        })}`,
        remoteAddress: address(),
      });
      assert.equal(unbound.headers.location, "/console/?authError=google");
      assert.equal(google.tokens.length, tokensBefore, "no code exchange without the browser");
      assert.deepEqual(await counts(), before);
      // Another browser's binding cookie does not complete this attempt either.
      const other = await app.inject({
        method: "POST",
        url: "/api/auth/providers/google/start",
        remoteAddress: address(),
        headers: { origin },
      });
      const foreign = await app.inject({
        url: `/api/auth/providers/google/callback?state=${state}&code=${google.authorize(url, {
          subject: memberSubject,
        })}`,
        remoteAddress: address(),
        headers: { cookie: cookieHeaderFromSetCookie(other.headers["set-cookie"]) },
      });
      assert.equal(foreign.headers.location, "/console/?authError=google");
      assert.deepEqual(await counts(), before);
      // Starting needs the exact Origin.
      const crossOrigin = await app.inject({
        method: "POST",
        url: "/api/auth/providers/google/start",
        remoteAddress: address(),
        headers: { origin: "https://evil.example.test" },
      });
      assert.equal(crossOrigin.statusCode, 403);
      // Like sign-out, a supplied Sec-Fetch-Site must be same-origin.
      const sameSite = await app.inject({
        method: "POST",
        url: "/api/auth/providers/google/start",
        remoteAddress: address(),
        headers: { origin, "sec-fetch-site": "same-site" },
      });
      assert.equal(sameSite.statusCode, 403, sameSite.body);
      assert.equal(sameSite.headers["set-cookie"], undefined);
    });

    await t.test("password sign-in and the recovery lane still work with Google", async () => {
      const passwordResponse = await passwordSignIn(app, origin, member, address());
      assert.equal(passwordResponse.statusCode, 200, passwordResponse.body);
      const lane = await assertReservedLane(app, pool, {
        origin,
        holder: admin,
        former: member,
        label: "google",
      });
      assert.deepEqual(lane, { fresh: 429, former: 429, holder: 200, held: [401, 401, 401, 401] });
      // A Google provider outage leaves password sign-in working.
      google.mode = "error";
      try {
        await assertGoogleRefused(
          { subject: memberSubject },
          "provider outage",
          "PROVIDER_UNAVAILABLE",
        );
        assert.equal((await passwordSignIn(app, origin, admin, address())).statusCode, 200);
      } finally {
        google.mode = "up";
      }
      adminHeaders = await signedInHeaders(app, origin, admin, address());
    });

    await t.test("detaching the Google identity revokes its sessions", async () => {
      const { cookie } = await assertGoogleSignIn(memberSubject, member.id);
      const account = await readAccount(app, adminHeaders, member.id);
      const method = account.methods.find(({ providerId }) => providerId === googleProviderId);
      const detached = await app.inject({
        method: "POST",
        url: `/api/auth/accounts/${member.id}/methods/${method.methodId}/detach`,
        headers: adminHeaders,
        payload: { expectedVersion: account.version },
      });
      assert.equal(detached.statusCode, 200, detached.body);
      assert.equal(await currentSession(app, cookie), null, "the Google session ends");
      await assertGoogleRefused({ subject: memberSubject }, "detached subject");
      assert.equal((await passwordSignIn(app, origin, member, address())).statusCode, 200);
    });

    await t.test("a disabled account is refused Google sign-in", async () => {
      await attach(disabled.id, "google", disabledSubject);
      const { cookie } = await assertGoogleSignIn(disabledSubject, disabled.id);
      const disable = await app.inject({
        method: "POST",
        url: `/api/auth/accounts/${disabled.id}/disable`,
        headers: adminHeaders,
        payload: { expectedVersion: (await readAccount(app, adminHeaders, disabled.id)).version },
      });
      assert.equal(disable.statusCode, 200, disable.body);
      assert.equal(await currentSession(app, cookie), null);
      await assertGoogleRefused({ subject: disabledSubject }, "disabled account");
    });

    await t.test("GitHub and Google together both sign in with distinct provider ids", async () => {
      await app.close();
      app = undefined;
      await startFakeGitHub(t);
      app = await composeProductionSignIn(t, {
        databaseUrl,
        settings: {
          ...githubUpgradeSettings(admin.id),
          ...googleUpgradeSettings(admin.id, [hostedDomain]),
        },
        secrets,
      });
      adminHeaders = await signedInHeaders(app, origin, admin, address());
      assert.deepEqual((await app.inject({ url: "/api/auth/providers" })).json().data, {
        github: true,
        google: true,
        sessionBinding: true,
      });
      await assertGoogleRefused({ subject: disabledSubject }, "disabled after restart");
      await attach(both.id, "google", bothSubject);
      await attach(both.id, "github", bothGithubSubject);
      await assertGoogleSignIn(bothSubject, both.id);
      const { callback } = await githubSignIn(app, origin, bothGithubSubject, address());
      assert.equal(callback.headers.location, "/console/", callback.body);
      const githubCookie = cookieHeaderFromSetCookie(callback.headers["set-cookie"]);
      assert.equal((await currentSession(app, githubCookie)).user.id, both.id);
      const methods = (
        await pool.query(
          `SELECT provider_id, account_id FROM occ.account
             WHERE user_id = $1 AND identity_only ORDER BY provider_id`,
          [both.id],
        )
      ).rows;
      assert.deepEqual(methods, [
        { provider_id: githubProviderId, account_id: bothGithubSubject },
        { provider_id: googleProviderId, account_id: bothSubject },
      ]);
      assert.notEqual(githubProviderId, googleProviderId);
      // A Google subject never signs in through GitHub, nor the reverse.
      const crossed = await githubSignIn(app, origin, "9500099", address());
      assert.equal(crossed.callback.headers.location, "/console/?authError=github");
      await assertGoogleRefused({ subject: bothGithubSubject }, "GitHub subject at Google");
      const recovery = await app.inject({ url: "/api/auth/recovery", headers: adminHeaders });
      assert.equal(recovery.json().data.userId, admin.id);
    });
  },
);
