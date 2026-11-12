import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { isDeepStrictEqual } from "node:util";
import type { Pool } from "pg";
import { cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";
import {
  authRowCounts,
  currentSession,
  sessionCookieName,
  type fakeGoogle,
} from "../helpers/production-sign-in.mjs";
import {
  authOperation,
  accountPrincipalId,
  first,
  injectLocalhost,
  integer,
  parseAuthResponse,
  readAccount,
  record,
  recordData,
  text,
  type FixtureAccount,
  type InjectedResponse,
  type SessionHeaders,
  type SignInApp,
} from "../helpers/postgres-sign-in-test-boundaries.ts";
import type { preparePostgresSignInInstallation } from "../helpers/postgres-sign-in-installation.mjs";

export type GoogleAuthorization = {
  subject: string;
  claims?: Record<string, unknown>;
  key?: string;
};
export type GoogleSignIn = {
  callback: InjectedResponse;
  attemptId: string;
  url: string;
  state: string;
  bindingCookie: string;
  cookie: string;
};

type GuardedProfileContext = {
  app: SignInApp;
  pool: Pool;
  state: Awaited<ReturnType<typeof preparePostgresSignInInstallation>>["state"];
  google: ReturnType<typeof fakeGoogle>;
  admin: FixtureAccount;
  member: FixtureAccount;
  adminHeaders: SessionHeaders;
  address: () => string;
  origin: string;
  googleClientId: string;
  googleProviderId: string;
  hostedDomain: string;
  memberSubject: string;
  strangerSubject: string;
  attach: (userId: string, provider: string, subject: string) => Promise<void>;
  assertGoogleRefused: (
    authorization: GoogleAuthorization,
    message: string,
    reason?: string,
    consoleReason?: string,
  ) => Promise<void>;
  assertGoogleSignIn: (
    subject: string,
    userId: string,
    claims?: Record<string, unknown>,
  ) => Promise<GoogleSignIn>;
};

function authorizationUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error("Invalid authorization URL");
  }
}

export async function runGoogleGuardedProfileCases(
  t: TestContext,
  context: GuardedProfileContext,
): Promise<void> {
  const {
    app,
    pool,
    state,
    google,
    admin,
    member,
    adminHeaders,
    address,
    origin,
    googleClientId,
    googleProviderId,
    hostedDomain,
    memberSubject,
    strangerSubject,
    attach,
    assertGoogleRefused,
    assertGoogleSignIn,
  } = context;
  // A browser at a fresh client address starts Google sign-in, from the console by default.
  const startGoogle = (headers: Record<string, string> = { origin }) =>
    injectLocalhost(app, "POST", "/api/auth/providers/google/start", {
      remoteAddress: address(),
      headers,
    });
  // Google sends the member back to the callback for attempt `state` (authorized at `url`).
  const googleCallback = (attemptState: string, url: string, headers?: Record<string, string>) =>
    injectLocalhost(
      app,
      "GET",
      `/api/auth/providers/google/callback?state=${attemptState}&code=${google.authorize(url, { subject: memberSubject })}`,
      { remoteAddress: address(), ...(headers === undefined ? {} : { headers }) },
    );
  const counts = async () => {
    const value = record(await authRowCounts(pool));
    return {
      users: integer(value.users),
      methods: integer(value.methods),
      sessions: integer(value.sessions),
    };
  };
  await t.test(
    "a Google-only install activates the guarded profile and recovery from the recovery user",
    async () => {
      const providers = await app.inject({ url: "/api/auth/providers" });
      assert.ok(
        isDeepStrictEqual(
          recordData(parseAuthResponse("read configured authentication providers", providers)),
          {
            google: true,
            oidc: false,
            password: true,
            sessionBinding: true,
          },
        ),
      );
      assert.deepEqual(
        (
          await pool.query<Record<string, unknown>>(
            "SELECT user_id FROM occ.human_authentication_recovery",
          )
        ).rows,
        [{ user_id: admin.id }],
      );
      const recovery = await app.inject({ url: "/api/auth/recovery", headers: adminHeaders });
      assert.equal(recovery.statusCode, 200);
      assert.ok(
        recordData(parseAuthResponse("read the authentication recovery user", recovery)).userId ===
          admin.id,
      );
      // OIDC stays unconfigured on a Google-only install.
      const oidcStart = await injectLocalhost(app, "POST", "/api/auth/providers/oidc/start", {
        remoteAddress: address(),
        headers: { origin },
      });
      assert.equal(oidcStart.statusCode, 403);
      // The controller's fixed endpoints are the ones Google's discovery document names.
      const start = await startGoogle();
      assert.equal(start.statusCode, 200);
      const authorize = authorizationUrl(
        text(recordData(parseAuthResponse("start Google authorization", start)).url),
      );
      // Compare the authorization URL without printing provider-supplied values on failure.
      assert.ok(
        `${authorize.origin}${authorize.pathname}` === google.discovery.authorization_endpoint,
        "Google authorization endpoint matches discovery",
      );
      assert.ok(
        isDeepStrictEqual([...authorize.searchParams.keys()].sort(), [
          "client_id",
          "code_challenge",
          "code_challenge_method",
          "nonce",
          "redirect_uri",
          "response_type",
          "scope",
          "state",
        ]),
        "Google authorization query has the expected parameter names",
      );
      assert.ok(
        authorize.searchParams.get("client_id") === googleClientId,
        "Google authorization uses the configured client ID",
      );
      assert.ok(
        authorize.searchParams.get("response_type") === "code",
        "Google authorization requests a code",
      );
      assert.ok(
        authorize.searchParams.get("scope") === "openid email",
        "Google authorization requests the sign-in scopes",
      );
      assert.ok(
        authorize.searchParams.get("code_challenge_method") === "S256",
        "Google authorization uses the S256 challenge method",
      );
      assert.ok(
        authorize.searchParams.get("redirect_uri") ===
          `${origin}/api/auth/providers/google/callback`,
        "Google authorization uses the expected callback URI",
      );
      assert.ok(
        /^__Host-occ_login_attempt=/.test(cookieHeaderFromSetCookie(start.headers["set-cookie"])),
      );
    },
  );

  await t.test("an attached Google identity signs in, binds its tab and is audited", async () => {
    const requestsBefore = google.requests;
    await attach(member.id, "google", memberSubject);
    assert.equal(google.requests, requestsBefore, "attaching never contacts Google");
    const account = await authOperation("read member account", () =>
      readAccount(app, adminHeaders, member.id),
    );
    assert.ok(
      isDeepStrictEqual(
        account.methods
          .filter(({ providerId }) => providerId !== "credential")
          .map(({ providerId, subject }) => [providerId, subject]),
        [[googleProviderId, memberSubject]],
      ),
      "the member account has its attached Google identity",
    );

    const signIn = await assertGoogleSignIn(memberSubject, member.id);
    const setCookies = [signIn.callback.headers["set-cookie"] ?? []].flat();
    // Only an issued session proves shared scope; a cookie clearance cannot satisfy it.
    const sessionCookies = setCookies.filter((cookie) =>
      cookie.startsWith(`${sessionCookieName}=`),
    );
    assert.equal(sessionCookies.length, 1);
    const sessionCookie = first(sessionCookies);
    assert.ok(/^__Secure-openclaw_occ_shared\.session_token=[^;]+;/.test(sessionCookie));
    assert.ok(!/; Max-Age=0(?:;|$)/i.test(sessionCookie));
    assert.ok(/; Domain=oce\.example\.internal(?:;|$)/i.test(sessionCookie));
    assert.ok(/; Secure(?:;|$)/i.test(sessionCookie));
    assert.ok(/; HttpOnly(?:;|$)/i.test(sessionCookie));
    assert.ok(/; Path=\/(?:;|$)/i.test(sessionCookie));
    assert.ok(/; SameSite=Lax(?:;|$)/i.test(sessionCookie));
    const receipt = setCookies.find((cookie) => cookie.startsWith("__Host-occ_login_receipt="));
    assert.ok(receipt, "the callback issues a __Host- receipt");
    assert.ok(!/; Domain=/i.test(receipt));
    const token = record(google.tokens.at(-1));
    assert.ok(token.redirect_uri === `${origin}/api/auth/providers/google/callback`);
    assert.ok(token.grant_type === "authorization_code");

    const result = (headers: Record<string, string>, attemptId: string) =>
      injectLocalhost(app, "POST", "/api/auth/providers/google/result", {
        remoteAddress: address(),
        headers,
        body: { attemptId },
      });
    const cookie = signIn.cookie;
    assert.equal((await result({ cookie }, signIn.attemptId)).statusCode, 403, "Origin");
    assert.equal(
      (await result({ cookie, origin }, "A".repeat(43))).statusCode,
      401,
      "another attempt's id is refused",
    );
    const exchanged = await result({ cookie, origin }, signIn.attemptId);
    assert.equal(exchanged.statusCode, 200);
    const sessionKey = text(
      recordData(parseAuthResponse("exchange the Google login receipt", exchanged)).sessionKey,
    );
    const session = await authOperation<unknown>("read the exchanged Google session", () =>
      currentSession(app, cookie),
    );
    assert.ok(text(record(session).sessionKey) === sessionKey);
    const replay = await result({ cookie, origin }, signIn.attemptId);
    assert.equal(replay.statusCode, 401, "the receipt is one-use");

    const principalId = await accountPrincipalId(pool, member.id);
    const audits = (await state.transact((unit) => unit.audit.list()))
      .filter(
        ({ action, outcome, details }) =>
          outcome !== "denied" &&
          details?.userId === member.id &&
          /^authentication\.(login|method\.attach)$/.test(action),
      )
      .map(({ action, actorId }) => [action, actorId]);
    assert.deepEqual(audits, [
      ["authentication.method.attach", await accountPrincipalId(pool, admin.id)],
      ["authentication.login", principalId],
    ]);
    // No Google token, code or email reaches storage or audit.
    const methods = await pool.query<Record<string, unknown>>(
      `SELECT access_token,refresh_token,id_token,access_token_expires_at,
                  refresh_token_expires_at,scope,password FROM occ.account WHERE identity_only`,
    );
    assert.ok(methods.rows.every((row) => Object.values(row).every((value) => value === null)));
    const stored = JSON.stringify([
      (
        await pool.query<Record<string, unknown>>(
          "SELECT row_to_json(a)::text AS value FROM occ.audit_events a",
        )
      ).rows,
      (
        await pool.query<Record<string, unknown>>(
          "SELECT row_to_json(s)::text AS value FROM occ.session s",
        )
      ).rows,
    ]);
    assert.equal(stored.includes("fixture-google-code-"), false);
    assert.equal(stored.includes("ya29."), false);
    assert.equal(stored.includes(`${memberSubject}@${hostedDomain}`), false);
  });

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
    ] as const) {
      await assertGoogleRefused({ subject: memberSubject, ...authorization }, message);
    }
    // The same identity still signs in with a valid token afterwards.
    await assertGoogleSignIn(memberSubject, member.id);
  });

  await t.test("a replayed state and a missing binding cookie are refused", async () => {
    const signIn = await assertGoogleSignIn(memberSubject, member.id);
    const before = await counts();
    const replay = await googleCallback(signIn.state, signIn.url, {
      cookie: signIn.bindingCookie,
    });
    assert.ok(replay.headers.location === "/console/?authError=google");
    assert.deepEqual(await counts(), before);

    const start = await startGoogle();
    const url = text(recordData(parseAuthResponse("start Google authorization", start)).url);
    const attemptState = text(authorizationUrl(url).searchParams.get("state"));
    const tokensBefore = google.tokens.length;
    const unbound = await googleCallback(attemptState, url);
    assert.ok(unbound.headers.location === "/console/?authError=google");
    assert.equal(google.tokens.length, tokensBefore, "no code exchange without the browser");
    assert.deepEqual(await counts(), before);
    // Another browser's binding cookie does not complete this attempt either.
    const other = await startGoogle();
    const foreign = await googleCallback(attemptState, url, {
      cookie: cookieHeaderFromSetCookie(other.headers["set-cookie"]),
    });
    assert.ok(foreign.headers.location === "/console/?authError=google");
    assert.deepEqual(await counts(), before);
    // Starting needs the exact Origin.
    const crossOrigin = await startGoogle({ origin: "https://evil.example.test" });
    assert.equal(crossOrigin.statusCode, 403);
    // Like sign-out, a supplied Sec-Fetch-Site must be same-origin.
    const sameSite = await startGoogle({ origin, "sec-fetch-site": "same-site" });
    assert.equal(sameSite.statusCode, 403);
    assert.ok(sameSite.headers["set-cookie"] === undefined);
  });
}
