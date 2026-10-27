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
// together, a JWT-shaped claim name, and a printable claim value.
test("OIDC trust-claim configuration is both-or-neither with a valid name and value", () => {
  assert.equal(oidcLoginConfiguration(environment)?.trustClaim, undefined);
  assert.deepEqual(
    oidcLoginConfiguration({
      ...environment,
      OCC_AUTH_OIDC_TRUST_CLAIM: "occ_access",
      OCC_AUTH_OIDC_TRUST_VALUE: "granted",
    })?.trustClaim,
    { name: "occ_access", value: "granted" },
  );
  for (const partial of [
    { OCC_AUTH_OIDC_TRUST_CLAIM: "occ_access" },
    { OCC_AUTH_OIDC_TRUST_VALUE: "granted" },
    // A blank value counts as absent, so the claim name alone is still partial.
    { OCC_AUTH_OIDC_TRUST_CLAIM: "occ_access", OCC_AUTH_OIDC_TRUST_VALUE: " " },
  ]) {
    assert.throws(
      () => oidcLoginConfiguration({ ...environment, ...partial }),
      /must be configured together/,
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
    // One onboarding account to attach and later disable; every other subject in this
    // suite is unknown to the platform until a trusted claim enrolls it.
    const { admin, accounts } = await onboardPasswordAccounts(t, {
      databaseUrl,
      state,
      pool,
      email: adminEmail,
      authSecret,
      secrets,
      password,
      remoteAddress: address(),
      accounts: { attached: { email: "oidc-trust-attached@example.test" } },
    });
    const { attached } = accounts;
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
    async function assertTrustedSignIn(subject) {
      const signIn = await oidcSignIn(app, origin, idp, { subject, claims: claim }, address());
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
