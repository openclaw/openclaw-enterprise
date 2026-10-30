import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { oidcLoginConfiguration } from "../../apps/controller/src/auth/oidc.ts";
import {
  assertExternalSignInRefused,
  attachProvider,
  authRowCounts,
  clientAddresses,
  composeProductionSignIn,
  consoleOrigin as origin,
  currentSession,
  fakeOidc,
  fixtureOidcIssuer,
  loginDenialCount,
  oidcSignIn,
  oidcUpgradeSettings,
  onboardPasswordAccounts,
  postgresSignInState,
  readAccount,
  sessionCookieName,
  signedInHeaders,
} from "../helpers/production-sign-in.mjs";
import { cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

const adminEmail = "oidc-trust-recovery@example.test";
const password = "oidc-trust-member-password";
const authSecret = "oidc-trust-claim-test-secret-at-least-32-bytes";
const clientId = "fixture-oidc-client";
const clientSecret = "fixture-oidc-client-secret";
const secrets = {
  "occ-auth/secret": authSecret,
  "occ-oidc-login/client-id": clientId,
  "occ-oidc-login/client-secret": clientSecret,
};
const digest = (value) => createHash("sha256").update(value).digest("hex");
const providerId = `oidc:${digest(`${fixtureOidcIssuer.issuer}\0${clientId}`)}`;
// The trust claim this suite's IdP issues into verified ID tokens, with and without the
// exact value the operator configured.
const claim = { occ_access: "granted" };
const trustedSubject = "auth0|65f0c1d2e3a4b5c6d7e8f9b1";
const unclaimedSubject = "auth0|65f0c1d2e3a4b5c6d7e8f9b2";
const wrongValueSubject = "auth0|65f0c1d2e3a4b5c6d7e8f9b3";
const attachedSubject = "auth0|65f0c1d2e3a4b5c6d7e8f9b4";
const verifiedEmailSubject = "auth0|65f0c1d2e3a4b5c6d7e8f9b5";
const unverifiedEmailSubject = "auth0|65f0c1d2e3a4b5c6d7e8f9b6";
const malformedEmailSubject = "auth0|65f0c1d2e3a4b5c6d7e8f9b7";
const takenEmailSubject = "auth0|65f0c1d2e3a4b5c6d7e8f9b8";
const customClaimSubject = "auth0|65f0c1d2e3a4b5c6d7e8f9b9";
const staleAttemptSubject = "auth0|65f0c1d2e3a4b5c6d7e8f9ba";
const racingSubject = "auth0|65f0c1d2e3a4b5c6d7e8f9bb";
// The deterministic enrolment address: a digest of the exact provider instance and subject,
// so the same identity always maps to the same non-deliverable placeholder.
const placeholderEmail = (subject) =>
  `oidc.${digest(`${providerId}\0${subject}`)}@users.openclaw.invalid`;
const environment = {
  OCC_AUTH_OIDC_ISSUER: fixtureOidcIssuer.issuer,
  OCC_AUTH_OIDC_AUTHORIZATION_URL: fixtureOidcIssuer.authorizationUrl,
  OCC_AUTH_OIDC_TOKEN_URL: fixtureOidcIssuer.tokenUrl,
  OCC_AUTH_OIDC_JWKS_URL: fixtureOidcIssuer.jwksUrl,
  OCC_AUTH_OIDC_CLIENT_ID: clientId,
  OCC_AUTH_OIDC_CLIENT_SECRET: clientSecret,
};

// The trust claim is validated at startup, before any sign-in can rely on it: both parts
// together, a JWT-shaped claim name, and a printable claim value. The email claim rides
// along with the trust claim and defaults to `email`.
test("OIDC trust-claim configuration is both-or-neither with a valid name and value", () => {
  assert.equal(oidcLoginConfiguration(environment)?.trustClaim, undefined);
  assert.deepEqual(
    oidcLoginConfiguration({
      ...environment,
      OCC_AUTH_OIDC_TRUST_CLAIM: "occ_access",
      OCC_AUTH_OIDC_TRUST_VALUE: "granted",
    })?.trustClaim,
    { name: "occ_access", value: "granted", emailClaim: "email" },
  );
  assert.deepEqual(
    oidcLoginConfiguration({
      ...environment,
      OCC_AUTH_OIDC_TRUST_CLAIM: "occ_access",
      OCC_AUTH_OIDC_TRUST_VALUE: "granted",
      OCC_AUTH_OIDC_TRUST_EMAIL_CLAIM: "mail",
    })?.trustClaim,
    { name: "occ_access", value: "granted", emailClaim: "mail" },
  );
  for (const partial of [
    { OCC_AUTH_OIDC_TRUST_CLAIM: "occ_access" },
    { OCC_AUTH_OIDC_TRUST_VALUE: "granted" },
    // A blank value counts as absent, so the claim name alone is still partial.
    { OCC_AUTH_OIDC_TRUST_CLAIM: "occ_access", OCC_AUTH_OIDC_TRUST_VALUE: " " },
    // The email claim is meaningless without the trust claim it feeds.
    { OCC_AUTH_OIDC_TRUST_EMAIL_CLAIM: "mail" },
  ]) {
    assert.throws(
      () => oidcLoginConfiguration({ ...environment, ...partial }),
      /must be configured together|requires OCC_AUTH_OIDC_TRUST_CLAIM/,
      JSON.stringify(partial),
    );
  }
  for (const value of ["1bad name", "occ access", "-leading", "x".repeat(65)]) {
    assert.throws(
      () =>
        oidcLoginConfiguration({
          ...environment,
          OCC_AUTH_OIDC_TRUST_CLAIM: value,
          OCC_AUTH_OIDC_TRUST_VALUE: "granted",
        }),
      /OCC_AUTH_OIDC_TRUST_CLAIM must be a claim name/,
      value,
    );
    assert.throws(
      () =>
        oidcLoginConfiguration({
          ...environment,
          OCC_AUTH_OIDC_TRUST_CLAIM: "occ_access",
          OCC_AUTH_OIDC_TRUST_VALUE: "granted",
          OCC_AUTH_OIDC_TRUST_EMAIL_CLAIM: value,
        }),
      /OCC_AUTH_OIDC_TRUST_EMAIL_CLAIM must be a claim name/,
      value,
    );
  }
  assert.throws(
    () =>
      oidcLoginConfiguration({
        ...environment,
        OCC_AUTH_OIDC_TRUST_CLAIM: "occ_access",
        OCC_AUTH_OIDC_TRUST_VALUE: "grant ed",
      }),
    /OCC_AUTH_OIDC_TRUST_VALUE must be 1 to 256 printable characters/,
  );
});

// The IdP fixture replaces only the issuer's token and JWKS URLs. State, audit, IAM, Better
// Auth, the guarded human-login profile and Fastify are production code, so trust-claim
// enrolment is proved against real persistence, audit and authorization.
test(
  "PostgreSQL OIDC trust-claim sign-in enrolls unknown claimed identities with no grants",
  requiresPostgres,
  async (t) => {
    let app;
    const { pool, state } = postgresSignInState(t, () => [app]);
    const idp = fakeOidc(t, { clientId, clientSecret });
    const address = clientAddresses("198.21");
    // One onboarding account to attach and later disable, and one whose email address a
    // later trusted token carries; every other subject in this suite is unknown to the
    // platform until a trusted claim enrolls it.
    const { admin, accounts } = await onboardPasswordAccounts(t, {
      databaseUrl,
      state,
      pool,
      email: adminEmail,
      authSecret,
      secrets,
      password,
      remoteAddress: address(),
      accounts: {
        attached: { email: "oidc-trust-attached@example.test" },
        taken: { email: "oidc-trust-taken@example.test" },
        stale: { email: "oidc-trust-stale@example.test" },
      },
    });
    const { attached, stale } = accounts;
    let adminHeaders;
    let trustedUserId;

    const denials = (reason) => loginDenialCount(state, reason, "oidc");
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
    async function assertTrustedSignIn(subject, extraClaims = {}) {
      const signIn = await oidcSignIn(
        app,
        origin,
        idp,
        { subject, claims: { ...claim, ...extraClaims } },
        address(),
      );
      assert.equal(signIn.callback.headers.location, "/console/", signIn.callback.body);
      const cookie = cookieHeaderFromSetCookie(signIn.callback.headers["set-cookie"]);
      return { cookie, session: await currentSession(app, cookie) };
    }

    await t.test("without trust configured, a claimed subject is still refused", async () => {
      app = await composeProductionSignIn(t, {
        databaseUrl,
        settings: oidcUpgradeSettings(admin.id),
        secrets,
      });
      // The IdP issues the claim, but the operator has not configured trust: the default
      // attached-only posture is unchanged and nothing is provisioned.
      await assertRefused({ subject: trustedSubject, claims: claim }, "no trust configured");
    });

    await t.test("a claimed unknown subject is enrolled with no grant", async () => {
      await app.close();
      app = await composeProductionSignIn(t, {
        databaseUrl,
        // The chart does not render the trust claim yet; the two variables reach the API
        // directly as environment configuration.
        settings: Object.freeze({
          ...oidcUpgradeSettings(admin.id),
          OCC_AUTH_OIDC_TRUST_CLAIM: "occ_access",
          OCC_AUTH_OIDC_TRUST_VALUE: "granted",
        }),
        secrets,
      });
      adminHeaders = await signedInHeaders(app, origin, admin, address());

      const { cookie, session } = await assertTrustedSignIn(trustedSubject);
      trustedUserId = session.user.id;
      assert.equal(session.user.email, placeholderEmail(trustedSubject));
      assert.equal(session.user.name, "OIDC member");

      // The enrolment grants nothing: the fresh Principal holds no Role or AccessBinding, so
      // even the Installation read is refused and authorization stays required.
      assert.equal(
        (await app.inject({ url: "/installation", headers: { cookie } })).statusCode,
        403,
      );

      // Exactly one user, one identity-only method, one Principal and one enrolment row,
      // with the deterministic placeholder address and no password.
      const [user] = (
        await pool.query(`SELECT name, email, email_verified FROM occ."user" WHERE id = $1`, [
          trustedUserId,
        ])
      ).rows;
      assert.deepEqual(user, {
        name: "OIDC member",
        email: placeholderEmail(trustedSubject),
        email_verified: false,
      });
      assert.deepEqual(
        (
          await pool.query(
            `SELECT user_id FROM occ.account
             WHERE provider_id = $1 AND account_id = $2 AND identity_only`,
            [providerId, trustedSubject],
          )
        ).rows,
        [{ user_id: trustedUserId }],
      );
      const [principal] = (
        await pool.query(
          `SELECT p.id, p.kind FROM occ.iam_identities p
           JOIN occ.human_authentication_accounts h ON h.principal_id = p.id
           WHERE h.user_id = $1`,
          [trustedUserId],
        )
      ).rows;
      assert.equal(principal.kind, "principal");
      assert.equal(
        (
          await pool.query(
            `SELECT count(*)::int AS n FROM occ.iam_access_bindings WHERE identity_subject_id = $1`,
            [principal.id],
          )
        ).rows[0].n,
        0,
        "no bindings for the enrolled Principal",
      );

      // The enrolment and the login are both audited, in that order, for this account.
      const audits = (await state.transact((unit) => unit.audit.list()))
        .filter(({ details }) => details?.userId === trustedUserId)
        .map(({ action }) => action);
      assert.deepEqual(audits, ["authentication.account.self-enrol", "authentication.login"]);
    });

    await t.test("a second sign-in of the same subject reuses the account", async () => {
      const before = await authRowCounts(pool);
      const { session } = await assertTrustedSignIn(trustedSubject);
      assert.equal(session.user.id, trustedUserId);
      const after = await authRowCounts(pool);
      assert.equal(after.users, before.users, "no second account");
      assert.equal(after.methods, before.methods, "no second method");
      assert.equal(after.sessions, before.sessions + 1);
    });

    await t.test("tokens without the claim or with a wrong value are refused", async () => {
      await assertRefused({ subject: unclaimedSubject }, "token without the claim");
      await assertRefused(
        { subject: wrongValueSubject, claims: { occ_access: "denied" } },
        "token with a wrong claim value",
      );
      // Neither refusal provisioned anything: only the trusted subject's account exists.
      assert.equal(
        (
          await pool.query(
            `SELECT count(*)::int AS n FROM occ."user"
             WHERE email LIKE 'oidc.%@users.openclaw.invalid'`,
          )
        ).rows[0].n,
        1,
      );
    });

    await t.test("a trusted token's email claim becomes the account email", async () => {
      // A verified IdP email is stored as issued except for the database's normalization:
      // trimmed and lower-cased, matching every other account email.
      const { session } = await assertTrustedSignIn(verifiedEmailSubject, {
        email: "  Mira@IdP.Example.Test ",
        email_verified: true,
      });
      assert.equal(session.user.email, "mira@idp.example.test");
      assert.deepEqual(
        (
          await pool.query(`SELECT email, email_verified FROM occ."user" WHERE id = $1`, [
            session.user.id,
          ])
        ).rows,
        [{ email: "mira@idp.example.test", email_verified: true }],
      );
      // Without the token asserting email_verified, the address is stored unverified.
      const unverified = await assertTrustedSignIn(unverifiedEmailSubject, {
        email: "sam@idp.example.test",
      });
      assert.equal(unverified.session.user.email, "sam@idp.example.test");
      assert.equal(
        (
          await pool.query(`SELECT email_verified FROM occ."user" WHERE id = $1`, [
            unverified.session.user.id,
          ])
        ).rows[0].email_verified,
        false,
      );
      // A claim value that is not a usable address enrols with the placeholder instead.
      const malformed = await assertTrustedSignIn(malformedEmailSubject, {
        email: "not an address",
      });
      assert.equal(
        malformed.session.user.email,
        placeholderEmail(malformedEmailSubject),
        "an unusable email claim falls back to the placeholder",
      );
    });

    await t.test("an email another account already holds is refused", async () => {
      // Accounts are never matched or linked by email, so a trusted token carrying an
      // address an unrelated account already owns fails closed rather than enrolling
      // onto or beside it; attaching the identity to that account remains the way in.
      await assertRefused(
        {
          subject: takenEmailSubject,
          claims: { email: "oidc-trust-taken@example.test" },
        },
        "email held by another account",
      );
      assert.equal(
        (
          await pool.query(`SELECT count(*)::int AS n FROM occ."user" WHERE email = $1`, [
            "oidc-trust-taken@example.test",
          ])
        ).rows[0].n,
        1,
        "the existing account is untouched",
      );
    });

    await t.test(
      "an account revoked mid-attempt is refused, not served by the fallback",
      async () => {
        // Regression: with trust enabled, a pending attempt for an attached account whose
        // sessions were revoked before its callback must refuse exactly like the attached-only
        // posture. The enrolment fallback must not resolve the existing identity without the
        // attempt's currentness check and hand out a session (with the account's grants).
        assert.equal(
          (await attachProvider(app, adminHeaders, stale.id, "oidc", staleAttemptSubject))
            .statusCode,
          200,
        );
        await assertExternalSignInRefused(
          {
            pool,
            provider: "oidc",
            denials,
            // Split the flow so the revocation lands between the attempt's creation and its
            // callback.
            signIn: async () => {
              const start = await app.inject({
                method: "POST",
                url: "/api/auth/providers/oidc/start",
                remoteAddress: address(),
                headers: { origin },
              });
              assert.equal(start.statusCode, 200, start.body);
              const { url, attemptId } = start.json().data;
              const oidcState = new URL(url).searchParams.get("state");
              const code = idp.authorize(url, { subject: staleAttemptSubject, claims: claim });
              const bindingCookie = cookieHeaderFromSetCookie(start.headers["set-cookie"]);
              const revoke = await app.inject({
                method: "POST",
                url: `/api/auth/accounts/${stale.id}/revoke`,
                headers: adminHeaders,
                payload: {
                  expectedVersion: (await readAccount(app, adminHeaders, stale.id)).version,
                },
              });
              assert.equal(revoke.statusCode, 200, revoke.body);
              const callback = await app.inject({
                url: `/api/auth/providers/oidc/callback?state=${oidcState}&code=${code}`,
                remoteAddress: address(),
                headers: { cookie: bindingCookie },
              });
              return { callback, attemptId };
            },
          },
          "account revoked between attempt and callback",
        );
      },
    );

    await t.test(
      "simultaneous trusted callbacks for one subject enroll exactly one account",
      async () => {
        // Regression: two first sign-ins for the same subject can both observe no attached
        // identity before either enrolment commits. Both attempts start first, so whichever
        // callback loses the race must refuse (its attempt predates the winner's account)
        // instead of failing on the aborted transaction or serving the winner's account.
        const attempts = [];
        for (let i = 0; i < 2; i += 1) {
          const start = await app.inject({
            method: "POST",
            url: "/api/auth/providers/oidc/start",
            remoteAddress: address(),
            headers: { origin },
          });
          assert.equal(start.statusCode, 200, start.body);
          const { url, attemptId } = start.json().data;
          attempts.push({
            oidcState: new URL(url).searchParams.get("state"),
            code: idp.authorize(url, { subject: racingSubject, claims: claim }),
            cookie: cookieHeaderFromSetCookie(start.headers["set-cookie"]),
            attemptId,
          });
        }
        const deniedBefore = await denials("EXTERNAL_IDENTITY_REJECTED");
        const callbacks = await Promise.all(
          attempts.map((attempt) =>
            app.inject({
              url: `/api/auth/providers/oidc/callback?state=${attempt.oidcState}&code=${attempt.code}`,
              remoteAddress: address(),
              headers: { cookie: attempt.cookie },
            }),
          ),
        );
        const signedIn = callbacks.filter((callback) => callback.headers.location === "/console/");
        const refused = callbacks.filter((callback) => callback.headers.location !== "/console/");
        assert.equal(signedIn.length, 1, "exactly one of the two callbacks signs in");
        assert.equal(refused.length, 1, "the losing callback is refused, not crashed");
        assert.equal(refused[0].headers.location, "/console/?authError=oidc", refused[0].body);
        assert.equal(
          String(refused[0].headers["set-cookie"] ?? "").includes(sessionCookieName),
          false,
          "the refused callback sets no session cookie",
        );
        assert.equal(
          await denials("EXTERNAL_IDENTITY_REJECTED"),
          deniedBefore + 1,
          "the losing callback's refusal is audited",
        );
        // Exactly one enrolled account exists for the subject: one user, one method, one
        // enrolment.
        const [user] = (
          await pool.query(`SELECT id, email FROM occ."user" WHERE email = $1`, [
            placeholderEmail(racingSubject),
          ])
        ).rows;
        assert.notEqual(user, undefined, "the winner's account exists");
        assert.deepEqual(
          (
            await pool.query(
              `SELECT count(*)::int AS n FROM occ.account WHERE provider_id = $1 AND account_id = $2`,
              [providerId, racingSubject],
            )
          ).rows[0].n,
          1,
          "exactly one sign-in method",
        );
        assert.deepEqual(
          (
            await pool.query(
              `SELECT count(*)::int AS n FROM occ.human_authentication_accounts WHERE user_id = $1`,
              [user.id],
            )
          ).rows[0].n,
          1,
          "exactly one enrolment",
        );
      },
    );

    await t.test("a configured email claim name is honored", async () => {
      await app.close();
      app = await composeProductionSignIn(t, {
        databaseUrl,
        settings: Object.freeze({
          ...oidcUpgradeSettings(admin.id),
          OCC_AUTH_OIDC_TRUST_CLAIM: "occ_access",
          OCC_AUTH_OIDC_TRUST_VALUE: "granted",
          OCC_AUTH_OIDC_TRUST_EMAIL_CLAIM: "mail",
        }),
        secrets,
      });
      adminHeaders = await signedInHeaders(app, origin, admin, address());
      // No standard email claim: only the configured name carries the address.
      const { session } = await assertTrustedSignIn(customClaimSubject, {
        mail: "custom@idp.example.test",
      });
      assert.equal(session.user.email, "custom@idp.example.test");
    });

    await t.test("a disabled attached account is refused even with the claim", async () => {
      // The claim enrolls unknown identities; it never overrides account disablement.
      assert.equal(
        (await attachProvider(app, adminHeaders, attached.id, "oidc", attachedSubject)).statusCode,
        200,
      );
      const disable = await app.inject({
        method: "POST",
        url: `/api/auth/accounts/${attached.id}/disable`,
        headers: adminHeaders,
        payload: { expectedVersion: (await readAccount(app, adminHeaders, attached.id)).version },
      });
      assert.equal(disable.statusCode, 200, disable.body);
      await assertRefused(
        { subject: attachedSubject, claims: claim },
        "disabled account",
        "ACCOUNT_DISABLED",
        "account-disabled",
      );
    });
  },
);
