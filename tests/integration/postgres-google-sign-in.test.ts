import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import {
  assertConsoleSignIn,
  assertExternalSignInRefused,
  assertProviderAttached,
  assertReservedLane,
  clientAddresses,
  consoleOrigin as origin,
  currentSession,
  fakeGoogle,
  oidcUpgradeSettings,
  googleSignIn,
  googleUpgradeSettings,
  loginDenialCount,
  fakeOidc,
  fixtureOidcIssuer,
} from "../helpers/production-sign-in.mjs";
import {
  authOperation,
  changeAccount,
  injectLocalhost,
  oidcSignIn,
  onboarded,
  parseAuthResponse,
  passwordSignIn,
  readAccount,
  recordData,
  response,
  signedInHeaders,
  text,
  type SignInApp,
} from "../helpers/postgres-sign-in-test-boundaries.ts";
import {
  runGoogleGuardedProfileCases,
  type GoogleAuthorization,
  type GoogleSignIn,
} from "./postgres-google-guarded-profile-cases.ts";
import { providerInstanceId } from "../helpers/human-login-transport.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { preparePostgresSignInInstallation } from "../helpers/postgres-sign-in-installation.mjs";

const googleClientId = "fixture-oce.apps.googleusercontent.com";
const googleClientSecret = "fixture-google-client-secret";
const hostedDomain = "example.test";
const secrets = {
  "occ-auth/secret": "google-sign-in-auth-test-secret-at-least-32-bytes",
  "occ-google-login/client-id": googleClientId,
  "occ-google-login/client-secret": googleClientSecret,
  "occ-oidc-login/client-id": "google-suite-oidc-client-id",
  "occ-oidc-login/client-secret": "google-suite-oidc-client-secret",
};
// The production slow lane with shorter floors (250 ms doubling to a 500 ms cap instead of
// 1 s doubling to 8 s), as in postgres-password-sign-in-limit. This suite spends password
// budgets but does not measure pacing, and each paced attempt waits its floor in real time:
// the reserved-lane check and the admin sign-ins after it reach the 4 s and 8 s floors
// otherwise.
const slowLane = { floorMs: 250, maxFloorMs: 500 };

const googleProviderId = providerInstanceId("google", {
  clientId: googleClientId,
  issuer: undefined,
});
const oidcProviderId = providerInstanceId("oidc", {
  issuer: fixtureOidcIssuer.issuer,
  clientId: "google-suite-oidc-client-id",
});
const memberSubject = "110000000000000000001";
const strangerSubject = "110000000000000000002";
const disabledSubject = "110000000000000000003";
const bothSubject = "110000000000000000004";
const bothOidcSubject = "9500004";

// The Google provider fixture replaces only Google's token and key endpoints. State,
// audit, IAM, Better Auth, the guarded human-login profile and Fastify are production code.
test(
  "PostgreSQL Google sign-in admits only attached identities through the guarded profile",
  requiresPostgres,
  async (t) => {
    const apps: { app: SignInApp | undefined } = { app: undefined };
    const { pool, state, onboard, composeApp } = await preparePostgresSignInInstallation(
      t,
      () => [apps.app],
      {
        email: "google-recovery@example.test",
        password: "google-member-password",
        secrets,
        // The OIDC-and-Google subtest starts OIDC; until then no OIDC stand-in runs.
        oidc: false,
      },
    );
    const google = fakeGoogle(t, {
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      hd: hostedDomain,
    });
    const address = clientAddresses("198.19");
    // Password onboarding on the default install, before Google is configured.
    const { admin, accounts } = onboarded(
      await authOperation("onboard accounts", () =>
        onboard({
          passwordSlowLaneFloors: slowLane,
          remoteAddress: address(),
          accounts: {
            member: { email: `google-member@${hostedDomain}` },
            disabled: { email: `google-disabled@${hostedDomain}` },
            both: { email: `google-both@${hostedDomain}` },
          },
        }),
      ),
      ["member", "disabled", "both"],
    );
    const { member, disabled, both } = accounts;

    // A Google-only upgrade: no OCC_AUTH_GITHUB_CLIENT_*, hosted domain restricted.
    const app = (apps.app = await authOperation("compose the Google-only installation", () =>
      composeApp(googleUpgradeSettings(admin.id, [hostedDomain]), {
        passwordSlowLaneFloors: slowLane,
      }),
    ));
    const activeApp = () => {
      assert.ok(apps.app);
      return apps.app;
    };
    let adminHeaders = await authOperation("sign in administrator", () =>
      signedInHeaders(app, origin, admin, address()),
    );
    const denials = (reason: string) => loginDenialCount(state, reason, undefined);
    const attach = async (userId: string, provider: string, subject: string): Promise<void> => {
      await authOperation("attach provider", () =>
        assertProviderAttached(activeApp(), adminHeaders, userId, provider, subject),
      );
    };
    const assertGoogleRefused = async (
      authorization: GoogleAuthorization,
      message: string,
      reason?: string,
      consoleReason?: string,
    ): Promise<void> => {
      await authOperation(message, async () => {
        // The JavaScript helper infers its optional console reason as undefined only.
        const refusal: unknown = Reflect.apply(assertExternalSignInRefused, undefined, [
          {
            pool,
            provider: "google",
            denials,
            signIn: () => googleSignIn(activeApp(), origin, google, authorization, address()),
          },
          message,
          reason,
          consoleReason,
        ]);
        await refusal;
      });
    };
    async function assertGoogleSignIn(
      subject: string,
      userId: string,
      claims?: Record<string, unknown>,
    ): Promise<GoogleSignIn> {
      const signIn = await authOperation("Google sign-in", () =>
        googleSignIn(
          activeApp(),
          origin,
          google,
          { subject, ...(claims ? { claims } : {}) },
          address(),
        ),
      );
      const callback = response(signIn.callback);
      const cookie = text(
        await authOperation("confirm Google session", () =>
          assertConsoleSignIn(activeApp(), { ...callback, body: "" }, userId),
        ),
      );
      return {
        callback,
        cookie,
        attemptId: text(signIn.attemptId),
        url: text(signIn.url),
        state: text(signIn.state),
        bindingCookie: text(signIn.bindingCookie),
      };
    }

    await runGoogleGuardedProfileCases(t, {
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
    });

    await t.test("password sign-in and the recovery lane still work with Google", async () => {
      const passwordResponse = await passwordSignIn(app, origin, member, address());
      assert.equal(passwordResponse.statusCode, 200);
      const lane = await authOperation("reserved password lane", () =>
        assertReservedLane(app, {
          origin,
          holder: admin,
          former: member,
          label: "google",
        }),
      );
      // The member neither holds recovery nor administers, so its spent email refuses it.
      assert.deepEqual(lane, { fresh: 429, former: 429, holder: 200 });
      // A Google provider outage leaves password sign-in working.
      google.mode = "error";
      try {
        await assertGoogleRefused(
          { subject: memberSubject },
          "provider outage",
          "PROVIDER_UNAVAILABLE",
          "provider-unavailable",
        );
        assert.equal((await passwordSignIn(app, origin, admin, address())).statusCode, 200);
      } finally {
        google.mode = "up";
      }
      adminHeaders = await authOperation("sign in administrator", () =>
        signedInHeaders(app, origin, admin, address()),
      );
    });

    await t.test("detaching the Google identity revokes its sessions", async () => {
      const { cookie } = await assertGoogleSignIn(memberSubject, member.id);
      const account = await authOperation("read member account", () =>
        readAccount(app, adminHeaders, member.id),
      );
      const method = account.methods.find(({ providerId }) => providerId === googleProviderId);
      assert.ok(method);
      const detached = await app.inject({
        method: "POST",
        url: `/api/auth/accounts/${member.id}/methods/${method.methodId}/detach`,
        headers: adminHeaders,
        payload: { expectedVersion: account.version },
      });
      assert.equal(detached.statusCode, 200);
      const session = await authOperation<unknown>("read the revoked Google session", () =>
        currentSession(app, cookie),
      );
      assert.ok(session === null, "the Google session ends");
      await assertGoogleRefused({ subject: memberSubject }, "detached subject");
      // The reserved-lane check above spent the member's email budget. The browser's
      // known-device cookie from its Google sign-in keeps its own lane for password fallback.
      const fallback = await injectLocalhost(app, "POST", "/api/auth/sign-in/email", {
        remoteAddress: address(),
        session: { cookie, origin },
        body: { email: member.email, password: member.password },
      });
      assert.equal(fallback.statusCode, 200);
    });

    await t.test("a disabled account is refused Google sign-in", async () => {
      await attach(disabled.id, "google", disabledSubject);
      const { cookie } = await assertGoogleSignIn(disabledSubject, disabled.id);
      const disable = await authOperation("disable the Google account", () =>
        changeAccount(app, adminHeaders, disabled.id, "disable"),
      );
      assert.equal(disable.statusCode, 200);
      const session = await authOperation<unknown>("read the revoked Google session", () =>
        currentSession(app, cookie),
      );
      assert.ok(session === null);
      await assertGoogleRefused(
        { subject: disabledSubject },
        "disabled account",
        "ACCOUNT_DISABLED",
        "account-disabled",
      );
    });

    await t.test("OIDC and Google together both sign in with distinct provider ids", async () => {
      await app.close();
      apps.app = undefined;
      const oidc = fakeOidc(t, {
        clientId: secrets["occ-oidc-login/client-id"],
        clientSecret: secrets["occ-oidc-login/client-secret"],
      });
      const dualApp = (apps.app = await authOperation(
        "compose the dual-provider installation",
        () =>
          composeApp(
            {
              ...oidcUpgradeSettings(admin.id),
              ...googleUpgradeSettings(admin.id, [hostedDomain]),
            },
            { passwordSlowLaneFloors: slowLane },
          ),
      ));
      adminHeaders = await authOperation("sign in administrator", () =>
        signedInHeaders(dualApp, origin, admin, address()),
      );
      assert.ok(
        isDeepStrictEqual(
          recordData(
            parseAuthResponse(
              "read configured authentication providers",
              await dualApp.inject({ url: "/api/auth/providers" }),
            ),
          ),
          {
            oidc: true,
            google: true,
            oidcSignIn: {
              label: "single sign-on",
              authorizationUrl: fixtureOidcIssuer.authorizationUrl,
            },
            password: true,
            sessionBinding: true,
          },
        ),
      );
      await assertGoogleRefused(
        { subject: disabledSubject },
        "disabled after restart",
        "ACCOUNT_DISABLED",
        "account-disabled",
      );
      await attach(both.id, "google", bothSubject);
      await attach(both.id, "oidc", bothOidcSubject);
      await assertGoogleSignIn(bothSubject, both.id);
      const { callback } = await authOperation("OIDC sign-in", () =>
        oidcSignIn(dualApp, origin, oidc, { subject: String(bothOidcSubject) }, address()),
      );
      await authOperation("confirm OIDC session", () =>
        assertConsoleSignIn(dualApp, { ...callback, body: "" }, both.id),
      );
      const methods = (
        await pool.query<Record<string, unknown>>(
          `SELECT provider_id, account_id FROM occ.account
             WHERE user_id = $1 AND identity_only ORDER BY provider_id`,
          [both.id],
        )
      ).rows;
      assert.ok(
        isDeepStrictEqual(methods, [
          { provider_id: googleProviderId, account_id: bothSubject },
          { provider_id: oidcProviderId, account_id: bothOidcSubject },
        ]),
        "each provider keeps its own attached subject",
      );
      assert.notEqual(oidcProviderId, googleProviderId);
      // A Google subject never signs in through OIDC, nor the reverse.
      const crossed = await authOperation("crossed OIDC sign-in", () =>
        oidcSignIn(dualApp, origin, oidc, { subject: "9500099" }, address()),
      );
      assert.ok(crossed.callback.headers.location === "/console/?authError=oidc");
      await assertGoogleRefused({ subject: bothOidcSubject }, "OIDC subject at Google");
      const recovery = await dualApp.inject({ url: "/api/auth/recovery", headers: adminHeaders });
      assert.ok(
        recordData(parseAuthResponse("read the authentication recovery user", recovery)).userId ===
          admin.id,
      );
    });
  },
);
