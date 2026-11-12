import assert from "node:assert/strict";
import test from "node:test";
import { assertApiError } from "../helpers/api-error.mjs";
import {
  assertConsoleSignIn,
  assertProviderAttached,
  assertSessionUser,
  changeAccount,
  clientAddresses,
  consoleOrigin as origin,
  createAccount,
  fakeGoogle,
  oidcSignIn,
  oidcUpgradeSettings,
  fixtureOidcIssuer,
  googleSignIn,
  googleUpgradeSettings,
  loginDenialCount,
  memoryLogger,
  readAccount,
  signedInHeaders,
} from "../helpers/production-sign-in.mjs";
import { cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";
import {
  account,
  responseData,
  events,
  first,
  injectLocalhost,
  number,
  passwordSignIn,
  record,
  response,
  text,
  type App,
} from "../helpers/postgres-sign-in-test-boundaries.ts";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { preparePostgresSignInInstallation } from "../helpers/postgres-sign-in-installation.mjs";

const password = "recovery-only-member-password";
const googleClientId = "recovery-only.apps.googleusercontent.com";
const googleClientSecret = "recovery-only-google-client-secret";
const memberSubject = 8_100_001;
const strandedSubject = 8_100_002;
const operatorSubject = 8_100_003;
const googleMemberSubject = "118100000000000000001";

const recoveryOnly = (settings: Record<string, unknown>) =>
  Object.freeze({ ...settings, OCC_AUTH_PASSWORD_SIGN_IN: "recovery-only" });
const providers = async (app: App) =>
  responseData(await app.inject({ url: "/api/auth/providers" }));
function stringArray(value: unknown): string[] {
  assert.ok(Array.isArray(value));
  return value.map((item: unknown) => text(item));
}

const warnings = (log: ReturnType<typeof memoryLogger>) =>
  events(log.events).filter(({ event }) => event === "authentication.password-sign-in-warning");

// OCC_AUTH_PASSWORD_SIGN_IN=recovery-only in the guarded profile: only the recovery account
// signs in with a password; every other account uses its external identity. The provider
// fixtures replace only remote HTTP; State, audit, IAM, Better Auth and Fastify are real.
test(
  "recovery-only password sign-in admits only the recovery account's password",
  requiresPostgres,
  async (t) => {
    let app: App | undefined;
    const activeApp = () => {
      assert.ok(app);
      return app;
    };
    const { pool, state, oidc, onboard, composeApp } = await preparePostgresSignInInstallation(
      t,
      () => [app],
      {
        oidc: true,
        email: "recovery-only-admin@example.test",
        password,
        secrets: {
          "occ-auth/secret": "recovery-only-auth-test-secret-at-least-32-bytes",
          "occ-oidc-login/client-id": "recovery-only-oidc-client-id",
          "occ-oidc-login/client-secret": "recovery-only-oidc-client-secret",
          "occ-google-login/client-id": googleClientId,
          "occ-google-login/client-secret": googleClientSecret,
        },
      },
    );
    const google = fakeGoogle(t, { clientId: googleClientId, clientSecret: googleClientSecret });
    const address = clientAddresses("198.20");
    // Password onboarding on the default install.
    const onboarded = await onboard({
      remoteAddress: address(),
      accounts: Object.fromEntries(
        ["member", "stranded", "disabled", "operator"].map((name) => [
          name,
          {
            email: `recovery-only-${name}@example.test`,
            // An administrator other than the recovery account, with a OIDC identity.
            ...(name === "operator" ? { role: "admin" } : {}),
          },
        ]),
      ),
    });
    const admin = account(onboarded.admin);
    const { roles } = onboarded;
    const accounts = record(onboarded.accounts);
    const member = account(accounts.member);
    const stranded = account(accounts.stranded);
    const disabled = account(accounts.disabled);
    const operator = account(accounts.operator);
    let adminHeaders: { cookie: string; origin: string };

    async function attach(provider: string, account: { id: string }, subject: string | number) {
      await assertProviderAttached(
        activeApp(),
        adminHeaders,
        account.id,
        provider,
        String(subject),
      );
    }

    await t.test("the default setting keeps every enrolled account's password", async () => {
      const log = memoryLogger();
      app = await composeApp(oidcUpgradeSettings(admin.id), {
        logger: log.logger,
      });
      assert.deepEqual(await providers(activeApp()), {
        oidc: true,
        oidcSignIn: {
          label: "single sign-on",
          authorizationUrl: fixtureOidcIssuer.authorizationUrl,
        },
        google: false,
        password: true,
        sessionBinding: true,
      });
      adminHeaders = await signedInHeaders(activeApp(), origin, admin, address());
      const signedIn = await passwordSignIn(activeApp(), origin, member, address());
      assert.equal(signedIn.statusCode, 200, signedIn.body);
      assert.deepEqual(warnings(log), [], "no warning without recovery-only");
      // The member and the operator get OIDC identities; the disabled account is switched off.
      await attach("oidc", member, memberSubject);
      await attach("oidc", operator, operatorSubject);
      const changed = response(
        await changeAccount(activeApp(), adminHeaders, disabled.id, "disable"),
      );
      assert.equal(changed.statusCode, 200, changed.body);
      await activeApp().close();
      app = undefined;
    });

    let log: ReturnType<typeof memoryLogger>;
    await t.test("startup warns about enabled accounts without an external identity", async () => {
      log = memoryLogger();
      app = await composeApp(recoveryOnly(oidcUpgradeSettings(admin.id)), {
        logger: log.logger,
      });
      // The recovery account, the member and operator with OIDC and the disabled account
      // are not listed.
      const [warning, ...rest] = warnings(log);
      assert.deepEqual(rest, []);
      assert.ok(warning);
      assert.equal(warning.severity, "WARN");
      assert.equal(warning.code, "EXTERNAL_IDENTITY_MISSING");
      assert.deepEqual(warning.skippedUserIds, [stranded.id]);
      assert.equal(warning.skippedUserCount, 1);
      assert.deepEqual(await providers(activeApp()), {
        oidc: true,
        oidcSignIn: {
          label: "single sign-on",
          authorizationUrl: fixtureOidcIssuer.authorizationUrl,
        },
        google: false,
        password: false,
        sessionBinding: true,
      });
    });

    const denials = async () => number(await loginDenialCount(state, "INVALID_CREDENTIALS"));
    await t.test("ordinary passwords get the bad-credential answer", async () => {
      const before = await denials();
      const unknown = { email: "recovery-only-nobody@example.test", password };
      const bodies = [];
      for (const account of [member, stranded, unknown, { ...member, password: "x".repeat(20) }]) {
        const refused = await passwordSignIn(activeApp(), origin, account, address());
        assert.equal(refused.statusCode, 401, account.email);
        assert.equal(refused.headers["set-cookie"], undefined);
        const error = record(record(refused.json()).error);
        bodies.push({ code: error.code, message: error.message });
      }
      // No answer distinguishes an existing account, or a right password, from anything else.
      assert.equal(new Set(bodies.map((body) => JSON.stringify(body))).size, 1);
      assert.equal((await denials()) - before, 4, "each refusal is audited as a denied login");
    });

    await t.test("a spent administrator lane is refused without reading the password", async () => {
      // Recovery-only reserves the recovery account alone, so once another administrator's
      // email budget is spent its attempts are refused unread: the email lane admits ten
      // audited failures, and the eleventh never reaches the password endpoint.
      const before = await denials();
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const refused = await passwordSignIn(activeApp(), origin, operator, address());
        assert.equal(refused.statusCode, 401, refused.body);
      }
      const limited = await passwordSignIn(activeApp(), origin, operator, address());
      assert.equal(limited.statusCode, 429, limited.body);
      assert.equal(
        (await denials()) - before,
        10,
        "the refused attempt never reached the password endpoint",
      );
    });

    await t.test("the recovery account still signs in with its password", async () => {
      const signedIn = await passwordSignIn(activeApp(), origin, admin, address());
      assert.equal(signedIn.statusCode, 200, signedIn.body);
      const cookie = text(await assertSessionUser(activeApp(), signedIn, admin.id));
      assert.equal(
        (
          await passwordSignIn(
            activeApp(),
            origin,
            { ...admin, password: "x".repeat(20) },
            address(),
          )
        ).statusCode,
        401,
      );
      adminHeaders = { cookie, origin };
    });

    await t.test("an ordinary account signs in with its OIDC identity", async () => {
      const login = await oidcSignIn(
        activeApp(),
        origin,
        oidc,
        { subject: String(memberSubject) },
        address(),
      );
      const callback = response(login.callback);
      await assertConsoleSignIn(activeApp(), callback, member.id);
    });

    await t.test("attaching an identity unstrands an account without a restart", async () => {
      const login = await oidcSignIn(
        activeApp(),
        origin,
        oidc,
        { subject: String(strandedSubject) },
        address(),
      );
      const callback = response(login.callback);
      assert.equal(callback.headers.location, "/console/?authError=oidc");
      await attach("oidc", stranded, strandedSubject);
      const retried = await oidcSignIn(
        activeApp(),
        origin,
        oidc,
        { subject: String(strandedSubject) },
        address(),
      );
      const retriedCallback = response(retried.callback);
      assert.equal(retriedCallback.headers.location, "/console/", retriedCallback.body);
      assert.equal(
        (await passwordSignIn(activeApp(), origin, stranded, address())).statusCode,
        401,
        "the password stays refused",
      );
      await activeApp().close();
      app = undefined;
      const restarted = memoryLogger();
      app = await composeApp(recoveryOnly(oidcUpgradeSettings(admin.id)), {
        logger: restarted.logger,
      });
      assert.deepEqual(warnings(restarted), [], "every enabled account has an identity");
      await activeApp().close();
      app = undefined;
    });

    await t.test("only identities of the configured providers count", async () => {
      // Google alone: OIDC identities cannot sign in, so every ordinary account is stranded.
      const googleLog = memoryLogger();
      app = await composeApp(recoveryOnly(googleUpgradeSettings(admin.id)), {
        logger: googleLog.logger,
      });
      const [warning] = warnings(googleLog);
      assert.ok(warning);
      // State orders ids by database collation, which need not match JavaScript's sort.
      assert.deepEqual(
        Array.from(stringArray(warning.skippedUserIds)).sort(),
        [member.id, stranded.id, operator.id].sort(),
      );
      assert.deepEqual(await providers(activeApp()), {
        oidc: false,
        google: true,
        password: false,
        sessionBinding: true,
      });
      assert.equal((await passwordSignIn(activeApp(), origin, member, address())).statusCode, 401);
      adminHeaders = await signedInHeaders(activeApp(), origin, admin, address());
      await attach("google", member, googleMemberSubject);
      const login = await googleSignIn(
        activeApp(),
        origin,
        google,
        { subject: googleMemberSubject },
        address(),
      );
      const callback = response(login.callback);
      await assertConsoleSignIn(activeApp(), callback, member.id);
    });
    await t.test(
      "guarded and recovery-only expose unsupported stored email and preserve password and denial behavior",
      async () => {
        const legacyEmail = "legacy-recovery-\ud800@example.test";
        const storedEmail = "legacy-recovery-\ufffd@example.test";
        const supportedEmail = "supported-legacy-recovery@example.test";
        const legacyPassword = "legacy-password-\u0000-\ud800-\ufffd";
        const headers = await signedInHeaders(activeApp(), origin, admin, address());
        const userId = text(
          (
            await createAccount(activeApp(), headers, {
              email: supportedEmail,
              password: legacyPassword,
              roleId: roles.admin.id,
            })
          ).id,
        );
        const target = record(await readAccount(activeApp(), headers, userId));
        const recovery = await activeApp().inject({ url: "/api/auth/recovery", headers });
        assert.equal(recovery.statusCode, 200, recovery.body);
        const replaced = await injectLocalhost(activeApp(), "POST", "/api/auth/recovery", {
          session: headers,
          body: {
            userId,
            expectedCurrentUserId: record(responseData(recovery)).userId,
            expectedVersion: target.version,
          },
        });
        assert.equal(replaced.statusCode, 200, replaced.body);
        await activeApp().close();
        app = undefined;
        // Seed the historical text encoding through PostgreSQL, keeping the API-created
        // recovery identity and password method. Authentication and audit remain production code.
        await pool.query('UPDATE occ."user" SET email = $1 WHERE id = $2', [legacyEmail, userId]);

        const stored = await pool.query<{ email: string }>(
          'SELECT email FROM occ."user" WHERE id = $1',
          [userId],
        );
        assert.equal(first(stored.rows).email, storedEmail);
        for (const settings of [
          oidcUpgradeSettings(userId),
          recoveryOnly(oidcUpgradeSettings(userId)),
        ]) {
          app = await composeApp(settings);
          const sessionsBefore = await pool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM occ.session WHERE user_id = $1",
            [userId],
          );
          const accepted = await passwordSignIn(
            activeApp(),
            origin,
            { email: storedEmail, password: legacyPassword },
            address(),
          );
          assert.equal(accepted.statusCode, 200, accepted.body);
          const cookie = cookieHeaderFromSetCookie(accepted.headers["set-cookie"]);
          assert.ok(cookie, "the guarded credential endpoint issued a session cookie");
          const sessionsAfter = await pool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM occ.session WHERE user_id = $1",
            [userId],
          );
          assert.equal(first(sessionsAfter.rows).count, first(sessionsBefore.rows).count + 1);
          // Credential admission is not usable Console access: the existing session
          // response contract rejects this unsupported stored email spelling.
          const unsupportedSession = await injectLocalhost(
            activeApp(),
            "GET",
            "/api/auth/session",
            {
              headers: { cookie },
            },
          );
          assertApiError(unsupportedSession, 500, "INTERNAL_ERROR");
          assert.equal(responseData(unsupportedSession), undefined);
          const before = await denials();
          for (const email of [legacyEmail, "recovery-nul\u0000@example.test"]) {
            const refused = await injectLocalhost(activeApp(), "POST", "/api/auth/sign-in/email", {
              remoteAddress: address(),
              session: { cookie, origin },
              body: { email, password: legacyPassword },
            });
            assertApiError(refused, 400, "INVALID_REQUEST");
            assert.equal(refused.headers["set-cookie"], undefined);
          }
          assert.equal(await denials(), before + 2);
          await activeApp().close();
          app = undefined;
          // This direct SQL change is fixture preparation, not a supported account
          // repair operation. Prove the identical password on a supported address.
          await pool.query('UPDATE occ."user" SET email = $1 WHERE id = $2', [
            supportedEmail,
            userId,
          ]);
          app = await composeApp(settings);
          const ordinary = await passwordSignIn(
            activeApp(),
            origin,
            { email: supportedEmail, password: legacyPassword },
            address(),
          );
          assert.equal(ordinary.statusCode, 200, ordinary.body);
          await assertSessionUser(activeApp(), ordinary, userId);
          await activeApp().close();
          app = undefined;
          await pool.query('UPDATE occ."user" SET email = $1 WHERE id = $2', [storedEmail, userId]);
        }
      },
    );
  },
);
