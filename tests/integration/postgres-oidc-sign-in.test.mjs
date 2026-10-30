import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  assertConsoleSignIn,
  assertExternalSignInRefused,
  attachProvider,
  changeAccount,
  clientAddresses,
  consoleOrigin as origin,
  currentSession,
  fakeGoogle,
  fakeOidc,
  fixtureOidcIssuer,
  githubSignIn,
  githubUpgradeSettings,
  googleSignIn,
  googleUpgradeSettings,
  loginDenialCount,
  memoryLogger,
  oidcSignIn,
  oidcUpgradeSettings,
  passwordSignIn,
  readAccount,
  signedInHeaders,
  startFakeGitHub,
} from "../helpers/production-sign-in.mjs";
import { cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";
import { injectLocalhost } from "../helpers/inject-json.mjs";
import { providerInstanceId } from "../helpers/human-login-transport.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { preparePostgresSignInInstallation } from "../helpers/postgres-sign-in-installation.mjs";

const authSecret = "oidc-sign-in-auth-test-secret-at-least-32-bytes";
const clientId = "fixture-oidc-client";
const clientSecret = "fixture-oidc-client-secret";
const googleClientId = "oidc-suite.apps.googleusercontent.com";
const secrets = {
  "occ-auth/secret": authSecret,
  "occ-oidc-login/client-id": clientId,
  "occ-oidc-login/client-secret": clientSecret,
  "occ-google-login/client-id": googleClientId,
  "occ-google-login/client-secret": "oidc-suite-google-client-secret",
  "occ-github-login/client-id": "oidc-suite-github-client-id",
  "occ-github-login/client-secret": "oidc-suite-github-client-secret",
};
const instance = (issuer) => providerInstanceId("oidc", { issuer: issuer.issuer, clientId });
const oidcProviderId = instance(fixtureOidcIssuer);
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
const bothGithubSubject = "9600004";

const recoveryOnly = (settings) =>
  Object.freeze({ ...settings, OCC_AUTH_PASSWORD_SIGN_IN: "recovery-only" });
const coverageWarnings = (log) =>
  log.events.filter(({ event }) => event === "authentication.password-sign-in-warning");

// The IdP fixture replaces only the issuer's token and JWKS URLs. State, audit, IAM, Better
// Auth, the guarded human-login profile and Fastify are production code.
test(
  "PostgreSQL OIDC sign-in admits only attached (issuer, subject) pairs",
  requiresPostgres,
  async (t) => {
    let app;
    const { pool, state, onboard, composeApp } = await preparePostgresSignInInstallation(
      t,
      () => [app],
      {
        email: "oidc-recovery@example.test",
        password: "oidc-member-password",
        secrets,
        // The side-by-side subtest starts GitHub; until then no GitHub stand-in runs.
        github: false,
      },
    );
    const idp = fakeOidc(t, { clientId, clientSecret });
    const address = clientAddresses("198.20");
    // Password onboarding on the default install, before OIDC is configured.
    const { admin, accounts } = await onboard({
      remoteAddress: address(),
      accounts: Object.fromEntries(
        ["member", "disabled", "both", "stranded"].map((name) => [
          name,
          { email: `oidc-${name}@example.test` },
        ]),
      ),
    });
    const { member, disabled, both, stranded } = accounts;
    let adminHeaders;

    const denials = (reason) => loginDenialCount(state, reason, "oidc");
    const attach = (userId, subject, provider = "oidc") =>
      attachProvider(app, adminHeaders, userId, provider, subject);
    const assertRefused = (authorization, message, reason, consoleReason) =>
      assertExternalSignInRefused(
        {
          pool,
          provider: "oidc",
          denials,
          signIn: () => oidcSignIn(app, origin, idp, authorization, address()),
        },
        message,
        reason,
        consoleReason,
      );
    async function assertSignIn(subject, userId, extra = {}) {
      const signIn = await oidcSignIn(app, origin, idp, { subject, ...extra }, address());
      const cookie = await assertConsoleSignIn(app, signIn.callback, userId);
      return { ...signIn, cookie };
    }
    // A console browser at a fresh client address starts sign-in with `provider`.
    const startSignIn = (provider = "oidc") =>
      injectLocalhost(app, "POST", `/api/auth/providers/${provider}/start`, {
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
        assert.equal(warning.code, "EXTERNAL_IDENTITY_MISSING");
        assert.deepEqual(
          [...warning.skippedUserIds].sort(),
          [member.id, disabled.id, both.id, stranded.id].sort(),
        );
        assert.deepEqual((await app.inject({ url: "/api/auth/providers" })).json().data, {
          github: false,
          google: false,
          oidc: true,
          oidcSignIn: { label: "Acme SSO", authorizationUrl: fixtureOidcIssuer.authorizationUrl },
          password: false,
          sessionBinding: true,
        });
        assert.deepEqual(
          (await pool.query("SELECT user_id FROM occ.human_authentication_recovery")).rows,
          [{ user_id: admin.id }],
        );
        // Ordinary passwords are refused; the recovery account's still signs in.
        assert.equal((await passwordSignIn(app, origin, member, address())).statusCode, 401);
        adminHeaders = await signedInHeaders(app, origin, admin, address());
        for (const provider of ["github", "google"]) {
          const start = await startSignIn(provider);
          assert.equal(start.statusCode, 403, `${provider} stays unconfigured`);
        }
        const start = await startSignIn();
        assert.equal(start.statusCode, 200, start.body);
        const authorize = new URL(start.json().data.url);
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
      assert.equal(attached.statusCode, 200, attached.body);
      assert.equal(idp.requests, requestsBefore, "attaching never contacts the IdP");
      const account = await readAccount(app, adminHeaders, member.id);
      assert.deepEqual(
        account.methods
          .filter(({ providerId }) => providerId !== "credential")
          .map(({ providerId, subject }) => [providerId, subject]),
        [[oidcProviderId, memberSubject]],
      );
      // A subject attached elsewhere is refused for another account, as a named conflict.
      const taken = await attach(both.id, memberSubject);
      assert.equal(taken.statusCode, 409, taken.body);
      assert.deepEqual(taken.json().error, {
        code: "RESOURCE_CONFLICT",
        message: "The external identity is already assigned.",
      });

      const signIn = await assertSignIn(memberSubject, member.id);
      const setCookies = [signIn.callback.headers["set-cookie"]].flat();
      assert.ok(setCookies.some((cookie) => cookie.startsWith("__Host-occ_login_receipt=")));
      const exchanged = await injectLocalhost(app, "POST", "/api/auth/providers/oidc/result", {
        remoteAddress: address(),
        session: { cookie: signIn.cookie, origin },
        body: { attemptId: signIn.attemptId },
      });
      assert.equal(exchanged.statusCode, 200, exchanged.body);
      assert.equal(
        (await currentSession(app, signIn.cookie)).sessionKey,
        exchanged.json().data.sessionKey,
      );

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
      assert.equal(audits.at(-1)[0], "authentication.login");
      assert.equal(audits.at(-1)[1], principalId);
      assert.ok(audits.some(([action]) => action === "authentication.method.attach"));
      // No IdP token or code reaches storage or audit.
      const stored = JSON.stringify([
        (await pool.query("SELECT row_to_json(a)::text AS value FROM occ.audit_events a")).rows,
        (await pool.query("SELECT row_to_json(s)::text AS value FROM occ.session s")).rows,
        (await pool.query("SELECT row_to_json(m)::text AS value FROM occ.account m")).rows,
      ]);
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
      ]) {
        await assertRefused({ subject: memberSubject, ...authorization }, message);
      }
      await assertSignIn(memberSubject, member.id);
    });

    await t.test("a rotated signing key verifies on the next callback", async () => {
      // An authorization issued under the old key fails once that key is withdrawn.
      const start = await startSignIn();
      const { url } = start.json().data;
      const code = idp.authorize(url, { subject: memberSubject });
      idp.rotate();
      const stale = await app.inject({
        url: `/api/auth/providers/oidc/callback?state=${new URL(url).searchParams.get("state")}&code=${code}`,
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
        assert.equal((await passwordSignIn(app, origin, admin, address())).statusCode, 200);
      } finally {
        idp.mode = "up";
      }
    });

    await t.test("disabling an account ends its session and refuses OIDC", async () => {
      assert.equal((await attach(disabled.id, disabledSubject)).statusCode, 200);
      const { cookie } = await assertSignIn(disabledSubject, disabled.id);
      const disable = await changeAccount(app, adminHeaders, disabled.id, "disable");
      assert.equal(disable.statusCode, 200, disable.body);
      assert.equal(await currentSession(app, cookie), null);
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
      assert.deepEqual(refusals.at(-1).details, {
        provider: "oidc",
        userId: disabled.id,
        attemptId,
      });
    });

    await t.test("the coverage report drops accounts once their identity is attached", async () => {
      await app.close();
      app = undefined;
      const log = memoryLogger();
      app = await composeApp(recoveryOnly(oidcUpgradeSettings(admin.id)), {
        logger: log.logger,
      });
      const [warning] = coverageWarnings(log);
      assert.deepEqual([...warning.skippedUserIds].sort(), [both.id, stranded.id].sort());
      adminHeaders = await signedInHeaders(app, origin, admin, address());
    });

    await t.test("an issuer change ends old sessions and needs a new attach", async () => {
      const { cookie: before } = await assertSignIn(memberSubject, member.id);
      await app.close();
      app = undefined;
      idp.issuer = movedIssuer;
      idp.tokenAuth = "client_secret_basic";
      app = await composeApp(
        oidcUpgradeSettings(admin.id, movedIssuer, { tokenAuth: "client_secret_basic" }),
      );
      adminHeaders = await signedInHeaders(app, origin, admin, address());
      // The old instance is no longer configured, so its session ends at once.
      assert.equal(await currentSession(app, before), null, "the issuer change ends it");
      await assertRefused({ subject: memberSubject }, "subject under the new issuer");
      assert.equal((await attach(member.id, memberSubject)).statusCode, 200);
      const { cookie: after } = await assertSignIn(memberSubject, member.id);
      assert.equal(idp.tokens.at(-1).client_secret, undefined, "client_secret_basic");
      const account = await readAccount(app, adminHeaders, member.id);
      const providers = account.methods
        .filter(({ providerId }) => providerId !== "credential")
        .map(({ providerId }) => providerId)
        .sort();
      assert.deepEqual(providers, [oidcProviderId, instance(movedIssuer)].sort());
      const stale = account.methods.find(({ providerId }) => providerId === oidcProviderId);
      const detached = await app.inject({
        method: "POST",
        url: `/api/auth/accounts/${member.id}/methods/${stale.methodId}/detach`,
        headers: adminHeaders,
        payload: { expectedVersion: account.version },
      });
      assert.equal(detached.statusCode, 200, detached.body);
      assert.equal(await currentSession(app, after), null, "detach ends sessions");
      await assertSignIn(memberSubject, member.id);
    });

    await t.test(
      "GitHub, Google and OIDC sign in side by side with distinct instances",
      async () => {
        await app.close();
        app = undefined;
        idp.issuer = fixtureOidcIssuer;
        idp.tokenAuth = "client_secret_post";
        await startFakeGitHub(t);
        const google = fakeGoogle(t, {
          clientId: googleClientId,
          clientSecret: "oidc-suite-google-client-secret",
        });
        app = await composeApp({
          ...githubUpgradeSettings(admin.id),
          ...googleUpgradeSettings(admin.id),
          ...oidcUpgradeSettings(admin.id),
        });
        adminHeaders = await signedInHeaders(app, origin, admin, address());
        const discovery = (await app.inject({ url: "/api/auth/providers" })).json().data;
        assert.deepEqual(
          [discovery.github, discovery.google, discovery.oidc, discovery.password],
          [true, true, true, true],
        );
        for (const [subject, provider] of [
          [bothSubject, "oidc"],
          [bothGoogleSubject, "google"],
          [bothGithubSubject, "github"],
        ]) {
          const attached = await attach(both.id, subject, provider);
          assert.equal(attached.statusCode, 200, attached.body);
        }
        const viaOidc = await assertSignIn(bothSubject, both.id);
        const viaGoogle = await googleSignIn(
          app,
          origin,
          google,
          { subject: bothGoogleSubject },
          address(),
        );
        assert.equal(viaGoogle.callback.headers.location, "/console/", viaGoogle.callback.body);
        const viaGithub = await githubSignIn(app, origin, bothGithubSubject, address());
        assert.equal(viaGithub.callback.headers.location, "/console/", viaGithub.callback.body);
        for (const [provider, signIn] of [
          ["oidc", viaOidc],
          ["google", viaGoogle],
          ["github", viaGithub],
        ]) {
          const cookie = cookieHeaderFromSetCookie(signIn.callback.headers["set-cookie"]);
          const confirm = (name, headers = {}, payload = { attemptId: signIn.attemptId }) =>
            injectLocalhost(app, "POST", `/api/auth/providers/${name}/result`, {
              remoteAddress: address(),
              headers: { origin, cookie, ...headers },
              body: payload,
            });
          // All providers are configured and the session/attempt are valid. Only
          // the callback's provider may exchange this receipt, without consuming
          // it on a refusal and denying the correct route its subsequent exchange.
          for (const other of ["github", "google", "oidc"].filter((name) => name !== provider)) {
            const refused = await confirm(other);
            assert.equal(
              refused.statusCode,
              401,
              `${provider} receipt at ${other}: ${refused.body}`,
            );
            assert.equal(refused.headers["set-cookie"], undefined, "refusal preserves the receipt");
          }
          assert.equal(
            (await confirm(provider, { origin: "https://other.example.test" })).statusCode,
            403,
          );
          assert.equal(
            (await confirm(provider, {}, { attemptId: "x".repeat(43) })).statusCode,
            401,
          );

          const receipt = cookie
            .split("; ")
            .find((part) => part.startsWith("__Host-occ_login_receipt="))
            .slice("__Host-occ_login_receipt=".length);
          const [encoded] = receipt.split(".");
          const fields = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
          const receiptCookie = (value) =>
            cookie.replace(
              `__Host-occ_login_receipt=${receipt}`,
              `__Host-occ_login_receipt=${value}`,
            );
          // Correctly authenticated legacy or mismatched fields must still fail.
          // These deliberately malformed inputs isolate validation from MAC failure.
          const signed = (value) => {
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
                cookie: `${adminHeaders.cookie}; __Host-occ_login_receipt=${receipt}`,
              })
            ).statusCode,
            401,
          );
          const exchanged = await confirm(provider);
          assert.equal(exchanged.statusCode, 200, exchanged.body);
          assert.equal(
            exchanged.json().data.sessionKey,
            (await currentSession(app, cookie)).sessionKey,
          );
          assert.equal((await confirm(provider)).statusCode, 401, "a receipt exchanges only once");
        }
        const methods = (
          await pool.query(
            `SELECT provider_id FROM occ.account
             WHERE user_id = $1 AND identity_only ORDER BY provider_id`,
            [both.id],
          )
        ).rows.map(({ provider_id: providerId }) => providerId.split(":")[0]);
        assert.deepEqual(methods, ["github", "google", "oidc"]);
        // An OIDC subject never signs in through Google, nor the reverse.
        const crossed = await googleSignIn(
          app,
          origin,
          google,
          { subject: bothSubject },
          address(),
        );
        assert.equal(crossed.callback.headers.location, "/console/?authError=google");
        await assertRefused({ subject: bothGoogleSubject }, "Google subject at OIDC");
      },
    );
  },
);
