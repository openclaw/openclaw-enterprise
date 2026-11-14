import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import type { ExternalProviderName } from "../../apps/controller/src/auth/human-login.ts";
import { isBindingValue } from "../../apps/controller/src/auth/session-binding.ts";
import { cookieHeaderFromSetCookie } from "../../packages/utils/src/http.ts";
import {
  assertExternalSignInRefused,
  attachProvider,
  clientAddresses,
  consoleOrigin as origin,
  currentSession,
  fakeGoogle,
  fakeOidc,
  fixtureOidcIssuer,
  googleSignIn as googleSignInFixture,
  googleUpgradeSettings,
  loginDenialCount,
  memoryLogger,
  oidcSignIn as oidcSignInFixture,
  oidcUpgradeSettings,
} from "../helpers/production-sign-in.mjs";
import {
  accountPrincipalId,
  authOperation,
  changeAccount,
  events,
  first,
  injectLocalhost,
  integer,
  onboarded,
  parseAuthResponse,
  passwordSignIn,
  readAccount,
  record,
  recordData,
  response,
  signedInHeaders,
  text,
  type InjectedResponse,
  type SessionHeaders,
  type SignInApp,
} from "../helpers/postgres-sign-in-test-boundaries.ts";
import { providerInstanceId } from "../helpers/human-login-transport.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { preparePostgresSignInInstallation } from "../helpers/postgres-sign-in-installation.mjs";

const authSecret = "oidc-sign-in-auth-test-secret-at-least-32-bytes";
const clientId = "fixture-oidc-client";
const clientSecret = "fixture-oidc-client-secret";
const googleClientId = "oidc-suite.apps.googleusercontent.com";
const googleClientSecret = "oidc-suite-google-client-secret";
const secrets = {
  "occ-auth/secret": authSecret,
  "occ-oidc-login/client-id": clientId,
  "occ-oidc-login/client-secret": clientSecret,
  "occ-google-login/client-id": googleClientId,
  "occ-google-login/client-secret": googleClientSecret,
};
const instance = ({ issuer }: { issuer: string }) =>
  providerInstanceId("oidc", { issuer, clientId });
const oidcProviderId = instance(fixtureOidcIssuer);
const googleProviderId = providerInstanceId("google", {
  clientId: googleClientId,
  issuer: undefined,
});
// An issuer change on the same host: a new provider instance.
const movedIssuer = Object.freeze({
  ...fixtureOidcIssuer,
  issuer: "https://tenant.idp.example.test/v2/",
});
const memberSubject = "auth0|6500000000000000000000a1";
const strangerSubject = "auth0|6500000000000000000000a2";
const disabledSubject = "auth0|6500000000000000000000a3";
const bothSubject = "auth0|6500000000000000000000a4";
const bothGoogleSubject = "110000000000000000044";

const recoveryOnly = (settings: ReturnType<typeof oidcUpgradeSettings>) =>
  Object.freeze({ ...settings, OCC_AUTH_PASSWORD_SIGN_IN: "recovery-only" });
const coverageWarnings = (log: ReturnType<typeof memoryLogger>) =>
  events(log.events).filter(({ event }) => event === "authentication.password-sign-in-warning");

type OidcAuthorizationOptions = {
  claims?: Record<string, unknown>;
  codeLength?: number;
  key?: "published" | "foreign";
};
type OidcAuthorization = { subject: string } & OidcAuthorizationOptions;

function signInResult(value: unknown) {
  const result = record(value);
  const { attemptId } = result;
  assert.ok(isBindingValue(attemptId), "sign-in returns a valid attempt identifier");
  return { start: response(result.start), callback: response(result.callback), attemptId };
}

function setCookieValues(response: InjectedResponse): string[] {
  return [response.headers["set-cookie"] ?? []].flat();
}

function sessionCookie(callback: InjectedResponse): string {
  const cookie = cookieHeaderFromSetCookie(callback.headers["set-cookie"]);
  assert.ok(cookie.length > 0, "the callback issues session cookies");
  return cookie;
}

function responseData(label: string, response: Pick<InjectedResponse, "json">) {
  return recordData(parseAuthResponse(label, response));
}

function warningUserIds(warning: Record<string, unknown>): string[] {
  const { skippedUserIds } = warning;
  assert.ok(Array.isArray(skippedUserIds), "the coverage warning lists account IDs");
  return skippedUserIds.map(text);
}

function receiptFields(encoded: string) {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("Login receipt payload is not JSON");
  }
  const fields = record(decoded);
  assert.equal(fields.v, 3);
  const { a } = fields;
  assert.ok(isBindingValue(a), "receipt binds a valid attempt identifier");
  return { v: fields.v, p: text(fields.p), s: text(fields.s), a, e: integer(fields.e) };
}

function sessionKey(data: Record<string, unknown>) {
  const { sessionKey } = data;
  assert.ok(isBindingValue(sessionKey), "the session has a binding key");
  return sessionKey;
}

// The IdP fixture replaces only the issuer's token and JWKS URLs. State, audit, IAM, Better
// Auth, the guarded human-login profile and Fastify are production code.
test(
  "PostgreSQL OIDC sign-in admits only attached (issuer, subject) pairs",
  requiresPostgres,
  async (t) => {
    let app: SignInApp | undefined;
    const activeApp = () => {
      assert.ok(app, "the controller is running");
      return app;
    };
    const { pool, state, onboard, composeApp } = await preparePostgresSignInInstallation(
      t,
      () => [app],
      {
        email: "oidc-recovery@example.test",
        password: "oidc-member-password",
        secrets,
      },
    );
    const idp = fakeOidc(t, { clientId, clientSecret });
    const address = clientAddresses("198.20");
    // Password onboarding on the default install, before OIDC is configured.
    const {
      admin,
      accounts: { member, disabled, both, stranded },
    } = onboarded(
      await authOperation("onboard accounts", () =>
        onboard({
          remoteAddress: address(),
          accounts: {
            member: { email: "oidc-member@example.test" },
            disabled: { email: "oidc-disabled@example.test" },
            both: { email: "oidc-both@example.test" },
            stranded: { email: "oidc-stranded@example.test" },
          },
        }),
      ),
      ["member", "disabled", "both", "stranded"],
    );
    let adminHeaders: SessionHeaders | undefined;
    const adminSession = () => {
      assert.ok(adminHeaders, "the administrator has signed in");
      return adminHeaders;
    };

    const signInAdmin = (app: SignInApp) =>
      authOperation("sign in the administrator", () =>
        signedInHeaders(app, origin, admin, address()),
      );
    const denials = (reason: string) => loginDenialCount(state, reason, "oidc");
    const attach = async (
      userId: string,
      subject: string,
      provider: ExternalProviderName = "oidc",
    ) =>
      response(
        await authOperation("attach external identity", () =>
          attachProvider(activeApp(), adminSession(), userId, provider, subject),
        ),
      );
    const signIn = (authorization: OidcAuthorization) =>
      authOperation("OIDC sign-in", async () =>
        signInResult(await oidcSignInFixture(activeApp(), origin, idp, authorization, address())),
      );
    const assertRefused = async (
      authorization: OidcAuthorization,
      message: string,
      reason?: string,
      consoleReason?: string,
    ) =>
      authOperation(message, async () => {
        // The JavaScript helper infers its optional console reason as undefined.
        const attemptId: unknown = await Reflect.apply(assertExternalSignInRefused, undefined, [
          { pool, provider: "oidc", denials, signIn: () => signIn(authorization) },
          message,
          reason,
          consoleReason,
        ]);
        return text(attemptId);
      });
    const session = async (cookie: string): Promise<unknown> =>
      authOperation("read the session", () => currentSession(activeApp(), cookie));
    async function assertSignIn(
      subject: string,
      userId: string,
      options?: OidcAuthorizationOptions,
    ) {
      const signInAttempt = await signIn({ subject, ...options });
      assert.equal(signInAttempt.callback.headers.location, "/console/");
      const cookie = sessionCookie(signInAttempt.callback);
      assert.equal(text(record(record(await session(cookie)).user).id), userId);
      return { ...signInAttempt, cookie };
    }
    const assertReceiptExchange = async (exchange: InjectedResponse, cookie: string) => {
      assert.equal(exchange.statusCode, 200);
      assert.equal(
        sessionKey(responseData("provider receipt exchange", exchange)),
        sessionKey(record(await session(cookie))),
      );
    };
    const startSignIn = (provider: ExternalProviderName = "oidc") =>
      injectLocalhost(activeApp(), "POST", `/api/auth/providers/${provider}/start`, {
        remoteAddress: address(),
        headers: { origin },
      });
    await t.test(
      "recovery-only OIDC activates the guarded profile and reports uncovered accounts",
      async () => {
        const log = memoryLogger();
        app = await composeApp(
          recoveryOnly(
            oidcUpgradeSettings(admin.id, fixtureOidcIssuer, { displayName: "Acme SSO" }),
          ),
          { logger: log.logger },
        );
        const [warning, ...rest] = coverageWarnings(log);
        assert.deepEqual(rest, []);
        assert.ok(warning);
        assert.equal(warning.code, "EXTERNAL_IDENTITY_MISSING");
        assert.deepEqual(
          warningUserIds(warning).sort(),
          [member.id, disabled.id, both.id, stranded.id].sort(),
        );
        assert.deepEqual(
          responseData("provider discovery", await app.inject({ url: "/api/auth/providers" })),
          {
            google: false,
            oidc: true,
            oidcSignIn: { label: "Acme SSO", authorizationUrl: fixtureOidcIssuer.authorizationUrl },
            password: false,
            sessionBinding: true,
          },
        );
        assert.deepEqual(
          (
            await pool.query<{ user_id: unknown }>(
              "SELECT user_id FROM occ.human_authentication_recovery",
            )
          ).rows.map(({ user_id }) => text(user_id)),
          [admin.id],
        );
        // Ordinary passwords are refused; the recovery account's still signs in.
        assert.equal((await passwordSignIn(app, origin, member, address())).statusCode, 401);
        adminHeaders = await signInAdmin(app);
        assert.equal((await startSignIn("google")).statusCode, 403, "Google stays unconfigured");
        const start = await startSignIn();
        assert.equal(start.statusCode, 200);
        const authorize = new URL(text(responseData("OIDC start", start).url));
        assert.equal(
          `${authorize.origin}${authorize.pathname}`,
          fixtureOidcIssuer.authorizationUrl,
        );
        assert.equal(authorize.searchParams.get("scope"), "openid");
        assert.equal(authorize.searchParams.get("client_id"), clientId);
        assert.equal(
          authorize.searchParams.get("redirect_uri"),
          `${origin}/api/auth/providers/oidc/callback`,
        );
      },
    );

    await t.test("an attached identity signs in, binds its tab and is audited", async () => {
      const requestsBefore = idp.requests;
      const attached = await attach(member.id, memberSubject);
      assert.equal(attached.statusCode, 200);
      assert.equal(idp.requests, requestsBefore, "attaching never contacts the IdP");
      const account = await readAccount(activeApp(), adminSession(), member.id);
      assert.deepEqual(
        account.methods
          .filter(({ providerId }) => providerId !== "credential")
          .map(({ providerId, subject }) => [providerId, subject]),
        [[oidcProviderId, memberSubject]],
      );
      // A subject attached elsewhere is refused for another account, as a named conflict.
      const taken = await attach(both.id, memberSubject);
      assert.equal(taken.statusCode, 409);
      assert.deepEqual(record(parseAuthResponse("attach conflict", taken)).error, {
        code: "RESOURCE_CONFLICT",
        message: "The external identity is already assigned.",
      });

      const signIn = await assertSignIn(memberSubject, member.id);
      const setCookies = setCookieValues(signIn.callback);
      const sessionCookie = setCookies.find(
        (cookie) =>
          cookie.startsWith("__Secure-openclaw_occ_shared.session_token=") &&
          !/Max-Age=0(?:;|$)/i.test(cookie),
      );
      assert.ok(sessionCookie, "OIDC issues the shared OCE session cookie");
      assert.match(sessionCookie, /; Domain=oce\.example\.internal(?:;|$)/i);
      // Provider bindings and device hints stay on the Console origin, never Agent hosts.
      const startCookies = setCookieValues(signIn.start);
      for (const [cookies, name] of [
        [startCookies, "__Host-occ_login_attempt"],
        [setCookies, "__Host-occ_login_receipt"],
        [setCookies, "__Host-occ_known_device"],
      ] as const) {
        const cookie = cookies.find(
          (value) => value.startsWith(`${name}=`) && !/Max-Age=0(?:;|$)/i.test(value),
        );
        assert.ok(cookie, name);
        assert.doesNotMatch(cookie, /; Domain=/i);
      }
      const exchanged = await injectLocalhost(
        activeApp(),
        "POST",
        "/api/auth/providers/oidc/result",
        {
          remoteAddress: address(),
          session: { cookie: signIn.cookie, origin },
          body: { attemptId: signIn.attemptId },
        },
      );
      await assertReceiptExchange(exchanged, signIn.cookie);

      const principalId = await accountPrincipalId(pool, member.id);
      const audits = (await state.transact((unit) => unit.audit.list())).filter(
        ({ action, outcome, details }) =>
          outcome !== "denied" &&
          details?.userId === member.id &&
          /^authentication\.(login|method\.attach)$/.test(action),
      );
      const login = audits.at(-1);
      assert.ok(login);
      assert.equal(login.action, "authentication.login");
      assert.equal(login.actorId, principalId);
      assert.ok(audits.some(({ action }) => action === "authentication.method.attach"));
      // No IdP token or code reaches storage or audit.
      const stored = (
        await Promise.all(
          ["occ.audit_events", "occ.session", "occ.account"].map((table) =>
            pool.query<{ value: unknown }>(
              `SELECT row_to_json(entry)::text AS value FROM ${table} entry`,
            ),
          ),
        )
      )
        .flatMap(({ rows }) => rows.map(({ value }) => text(value)))
        .join("\n");
      assert.equal(stored.includes("fixture-oidc-code-"), false);
      assert.equal(stored.includes("fixture-oidc-access-"), false);
    });

    await t.test("a 4,000-character authorization code signs in", async () => {
      await assertSignIn(memberSubject, member.id, { codeLength: 4000 });
    });

    await t.test("unattached subjects and invalid ID tokens are refused", async () => {
      await assertRefused({ subject: strangerSubject }, "unattached subject");
      const now = Math.floor(Date.now() / 1000);
      for (const [message, authorization] of [
        [
          "issuer without its trailing slash",
          { claims: { iss: "https://tenant.idp.example.test" } },
        ],
        ["another issuer", { claims: { iss: movedIssuer.issuer } }],
        ["wrong aud", { claims: { aud: "other-client" } }],
        ["wrong azp", { claims: { azp: "other-client" } }],
        ["an extra untrusted aud", { claims: { aud: [clientId, "other-client"], azp: clientId } }],
        ["wrong nonce", { claims: { nonce: "A".repeat(43) } }],
        ["expired", { claims: { iat: now - 3000, exp: now - 60 } }],
        ["not yet valid", { claims: { nbf: now + 600 } }],
        ["unpublished key", { key: "foreign" }],
      ] satisfies [string, OidcAuthorizationOptions][]) {
        await assertRefused({ subject: memberSubject, ...authorization }, message);
      }
      await assertSignIn(memberSubject, member.id);
    });

    await t.test("a rotated signing key verifies on the next callback", async () => {
      // An authorization issued under the old key fails once that key is withdrawn.
      const start = await startSignIn();
      assert.equal(start.statusCode, 200);
      const url = text(responseData("OIDC start", start).url);
      const state = new URL(url).searchParams.get("state");
      assert.ok(isBindingValue(state), "OIDC sends a valid authorization state");
      const code = text(idp.authorize(url, { subject: memberSubject }));
      idp.rotate();
      const stale = await activeApp().inject({
        url: `/api/auth/providers/oidc/callback?state=${state}&code=${code}`,
        remoteAddress: address(),
        headers: { cookie: cookieHeaderFromSetCookie(start.headers["set-cookie"]) },
      });
      assert.equal(stale.headers.location, "/console/?authError=oidc");
      // The JWKS is read for every callback, so the new key works without a restart.
      await assertSignIn(memberSubject, member.id);
    });

    await t.test("an IdP outage fails OIDC closed and leaves recovery working", async () => {
      idp.mode = "error";
      try {
        // The Console says the IdP is unavailable, not to get attached (finding 1193).
        await assertRefused(
          { subject: memberSubject },
          "IdP outage",
          "PROVIDER_UNAVAILABLE",
          "provider-unavailable",
        );
        assert.equal((await passwordSignIn(activeApp(), origin, admin, address())).statusCode, 200);
      } finally {
        idp.mode = "up";
      }
    });

    await t.test("disabling an account ends its session and refuses OIDC", async () => {
      assert.equal((await attach(disabled.id, disabledSubject)).statusCode, 200);
      const { cookie } = await assertSignIn(disabledSubject, disabled.id);
      const disable = await changeAccount(activeApp(), adminSession(), disabled.id, "disable");
      assert.equal(disable.statusCode, 200);
      assert.equal(await session(cookie), null);
      // The IdP proved this identity, and it is attached: the person is told the account is
      // disabled rather than to retry or ask for an attach. Only their own browser gets this.
      const attemptId = await assertRefused(
        { subject: disabledSubject },
        "disabled account",
        "ACCOUNT_DISABLED",
        "account-disabled",
      );
      // The denial names the disabled account, so an administrator can tell whose sign-in it was.
      const refusals = (await state.transact((unit) => unit.audit.list())).filter(
        ({ reasonCode }) => reasonCode === "ACCOUNT_DISABLED",
      );
      const refusal = refusals.at(-1);
      assert.ok(refusal);
      assert.deepEqual(refusal.details, {
        provider: "oidc",
        userId: disabled.id,
        subject: disabledSubject,
        attemptId,
      });
    });

    await t.test("the coverage report drops accounts once their identity is attached", async () => {
      await activeApp().close();
      app = undefined;
      const log = memoryLogger();
      app = await composeApp(recoveryOnly(oidcUpgradeSettings(admin.id)), {
        logger: log.logger,
      });
      const warning = first(coverageWarnings(log));
      assert.deepEqual(warningUserIds(warning).sort(), [both.id, stranded.id].sort());
      adminHeaders = await signInAdmin(app);
    });

    await t.test("an issuer change ends old sessions and needs a new attach", async () => {
      const { cookie: before } = await assertSignIn(memberSubject, member.id);
      await activeApp().close();
      app = undefined;
      idp.issuer = movedIssuer;
      idp.tokenAuth = "client_secret_basic";
      app = await composeApp({
        ...oidcUpgradeSettings(admin.id, fixtureOidcIssuer, { tokenAuth: "client_secret_basic" }),
        OCC_AUTH_OIDC_ISSUER: movedIssuer.issuer,
      });
      adminHeaders = await signInAdmin(app);
      // The old instance is no longer configured, so its session ends at once.
      assert.equal(await session(before), null, "the issuer change ends it");
      await assertRefused({ subject: memberSubject }, "subject under the new issuer");
      assert.equal((await attach(member.id, memberSubject)).statusCode, 200);
      const { cookie: after } = await assertSignIn(memberSubject, member.id);
      const tokenRequest: unknown = idp.tokens.at(-1);
      assert.equal(record(tokenRequest).client_secret, undefined, "client_secret_basic");
      const account = await readAccount(activeApp(), adminSession(), member.id);
      const providers = account.methods
        .filter(({ providerId }) => providerId !== "credential")
        .map(({ providerId }) => providerId)
        .sort();
      assert.deepEqual(providers, [oidcProviderId, instance(movedIssuer)].sort());
      const stale = account.methods.find(({ providerId }) => providerId === oidcProviderId);
      assert.ok(stale, "the former issuer's method is still attached");
      const detached = await app.inject({
        method: "POST",
        url: `/api/auth/accounts/${member.id}/methods/${stale.methodId}/detach`,
        headers: adminSession(),
        payload: { expectedVersion: account.version },
      });
      assert.equal(detached.statusCode, 200);
      assert.equal(await session(after), null, "detach ends sessions");
      await assertSignIn(memberSubject, member.id);
    });

    await t.test("Google and OIDC sign in side by side with distinct instances", async () => {
      await activeApp().close();
      app = undefined;
      idp.issuer = fixtureOidcIssuer;
      idp.tokenAuth = "client_secret_post";
      const google = fakeGoogle(t, {
        clientId: googleClientId,
        clientSecret: googleClientSecret,
      });
      app = await composeApp({
        ...googleUpgradeSettings(admin.id),
        ...oidcUpgradeSettings(admin.id),
      });
      adminHeaders = await signInAdmin(app);
      const discovery = responseData(
        "provider discovery",
        await app.inject({ url: "/api/auth/providers" }),
      );
      assert.deepEqual([discovery.google, discovery.oidc, discovery.password], [true, true, true]);
      for (const [subject, provider] of [
        [bothSubject, "oidc"],
        [bothGoogleSubject, "google"],
      ] as const) {
        const attached = await attach(both.id, subject, provider);
        assert.equal(attached.statusCode, 200);
      }
      const viaOidc = await assertSignIn(bothSubject, both.id);
      const googleSignIn = (subject: string) =>
        authOperation("Google sign-in", async () =>
          signInResult(
            await googleSignInFixture(activeApp(), origin, google, { subject }, address()),
          ),
        );
      const viaGoogle = await googleSignIn(bothGoogleSubject);
      assert.equal(viaGoogle.callback.headers.location, "/console/");
      for (const [provider, other, providerId, attemptId, cookie] of [
        ["oidc", "google", oidcProviderId, viaOidc.attemptId, viaOidc.cookie],
        [
          "google",
          "oidc",
          googleProviderId,
          viaGoogle.attemptId,
          sessionCookie(viaGoogle.callback),
        ],
      ] as const) {
        const confirm = (
          name: ExternalProviderName,
          headers: Record<string, string> = {},
          payload = { attemptId },
        ) =>
          injectLocalhost(activeApp(), "POST", `/api/auth/providers/${name}/result`, {
            remoteAddress: address(),
            headers: { origin, cookie, ...headers },
            body: payload,
          });
        // The wrong route refuses the receipt without consuming it. The correct route
        // must still accept it after the invalid requests below.
        const refused = await confirm(other);
        assert.equal(refused.statusCode, 401, `${provider} receipt at ${other}`);
        assert.equal(refused.headers["set-cookie"], undefined, "refusal preserves the receipt");
        assert.equal(
          (await confirm(provider, { origin: "https://other.example.test" })).statusCode,
          403,
        );
        assert.equal((await confirm(provider, {}, { attemptId: "x".repeat(43) })).statusCode, 401);

        const receiptName = "__Host-occ_login_receipt=";
        const part = cookie.split("; ").find((value) => value.startsWith(receiptName));
        assert.ok(part !== undefined, "the callback issues a receipt cookie");
        const receipt = part.slice(receiptName.length);
        const [encoded, signature, extra] = receipt.split(".");
        assert.ok(
          encoded && isBindingValue(signature) && extra === undefined,
          "valid receipt encoding",
        );
        const fields = receiptFields(encoded);
        assert.equal(fields.a, attemptId);
        assert.equal(fields.p, providerId);
        const receiptCookie = (value: string) => cookie.replace(part, `${receiptName}${value}`);
        // Correctly authenticated legacy or mismatched fields must still fail.
        // These deliberately malformed inputs isolate validation from MAC failure.
        const signed = (value: Record<string, unknown>) => {
          const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
          const signature = createHmac("sha256", authSecret)
            .update(`occ-login-receipt\0${payload}`)
            .digest("base64url");
          return `${payload}.${signature}`;
        };
        for (const invalid of [
          { s: fields.s, a: fields.a, e: fields.e },
          { ...fields, v: 1 },
          { ...fields, p: "" },
          { ...fields, p: null },
          { ...fields, p: `${provider}:${"0".repeat(64)}` },
          { ...fields, e: Date.now() - 1 },
        ]) {
          assert.equal(
            (await confirm(provider, { cookie: receiptCookie(signed(invalid)) })).statusCode,
            401,
          );
        }
        const tampered = `${encoded}.${"x".repeat(43)}`;
        assert.equal(
          (await confirm(provider, { cookie: receiptCookie(tampered) })).statusCode,
          401,
        );
        // A valid receipt cannot use a different live cookie session either.
        assert.equal(
          (
            await confirm(provider, {
              cookie: `${adminSession().cookie}; __Host-occ_login_receipt=${receipt}`,
            })
          ).statusCode,
          401,
        );
        await assertReceiptExchange(await confirm(provider), cookie);
        assert.equal((await confirm(provider)).statusCode, 401, "a receipt exchanges only once");
      }
      const methods = (
        await pool.query<{ provider_id: unknown }>(
          `SELECT provider_id FROM occ.account
             WHERE user_id = $1 AND identity_only ORDER BY provider_id`,
          [both.id],
        )
      ).rows.map(({ provider_id: providerId }) => text(providerId));
      assert.deepEqual(methods, [googleProviderId, oidcProviderId]);
      // An OIDC subject never signs in through Google, nor the reverse.
      const crossed = await googleSignIn(bothSubject);
      assert.equal(crossed.callback.headers.location, "/console/?authError=google");
      await assertRefused({ subject: bothGoogleSubject }, "Google subject at OIDC");
    });
  },
);
