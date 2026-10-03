import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import {
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
  memoryLogger,
  passwordSignIn,
  readAccount,
  signedInHeaders,
  startFakeGitHub,
} from "../helpers/production-sign-in.mjs";
import { cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

const adminEmail = "recovery-only-admin@example.test";
const password = "recovery-only-member-password";
const authSecret = "recovery-only-auth-test-secret-at-least-32-bytes";
const googleClientId = "recovery-only.apps.googleusercontent.com";
const googleClientSecret = "recovery-only-google-client-secret";
const secrets = {
  "occ-auth/secret": authSecret,
  "occ-github-login/client-id": "recovery-only-github-client-id",
  "occ-github-login/client-secret": "recovery-only-github-client-secret",
  "occ-google-login/client-id": googleClientId,
  "occ-google-login/client-secret": googleClientSecret,
};
const memberSubject = 8_100_001;
const strandedSubject = 8_100_002;
const googleMemberSubject = "118100000000000000001";

const recoveryOnly = (settings) =>
  Object.freeze({ ...settings, OCC_AUTH_PASSWORD_SIGN_IN: "recovery-only" });
const providers = async (app) => (await app.inject({ url: "/api/auth/providers" })).json().data;
const warnings = (log) =>
  log.events.filter(({ event }) => event === "authentication.password-sign-in-warning");

// OCC_AUTH_PASSWORD_SIGN_IN=recovery-only in the guarded profile: only the recovery account
// signs in with a password; every other account uses its external identity. The provider
// fixtures replace only remote HTTP; State, audit, IAM, Better Auth and Fastify are real.
test(
  "recovery-only password sign-in admits only the recovery account's password",
  requiresPostgres,
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const state = new PostgresPlatformState(pool);
    let app;
    t.after(async () => {
      await app?.close();
      await pool.end();
    });
    await startFakeGitHub(t);
    const google = fakeGoogle(t, { clientId: googleClientId, clientSecret: googleClientSecret });
    const address = clientAddresses("198.20");
    const adminPassword = await bootstrapProductionInstallation(t, {
      databaseUrl,
      email: adminEmail,
      authSecret,
    });
    const admin = { email: adminEmail, password: adminPassword };
    const { reader } = await installationRoles(state, pool);

    // Password onboarding on the default install.
    app = await composeProductionSignIn(t, {
      databaseUrl,
      settings: defaultInstallSettings,
      secrets,
    });
    let adminHeaders = await signedInHeaders(app, origin, admin, address());
    admin.id = (await currentSession(app, adminHeaders.cookie)).user.id;
    const accounts = {};
    for (const name of ["member", "stranded", "disabled"]) {
      const email = `recovery-only-${name}@example.test`;
      const created = await app.inject({
        method: "POST",
        url: "/api/auth/accounts",
        headers: adminHeaders,
        payload: { email, password, roleId: reader.id },
      });
      assert.equal(created.statusCode, 201, created.body);
      accounts[name] = { id: created.json().data.id, email, password };
    }
    const { member, stranded, disabled } = accounts;
    await app.close();
    app = undefined;

    async function attach(provider, account, subject) {
      const current = await readAccount(app, adminHeaders, account.id);
      const attached = await app.inject({
        method: "POST",
        url: `/api/auth/accounts/${account.id}/providers/${provider}`,
        headers: adminHeaders,
        payload: { subject: String(subject), expectedVersion: current.version },
      });
      assert.equal(attached.statusCode, 200, attached.body);
    }

    await t.test("the default setting keeps every enrolled account's password", async () => {
      const log = memoryLogger();
      app = await composeProductionSignIn(t, {
        databaseUrl,
        settings: githubUpgradeSettings(admin.id),
        secrets,
        logger: log.logger,
      });
      assert.deepEqual(await providers(app), {
        github: true,
        google: false,
        oidc: false,
        password: true,
        sessionBinding: true,
      });
      adminHeaders = await signedInHeaders(app, origin, admin, address());
      const signedIn = await passwordSignIn(app, origin, member, address());
      assert.equal(signedIn.statusCode, 200, signedIn.body);
      assert.deepEqual(warnings(log), [], "no warning without recovery-only");
      // Only the member gets a GitHub identity; the disabled account is switched off.
      await attach("github", member, memberSubject);
      const current = await readAccount(app, adminHeaders, disabled.id);
      const changed = await app.inject({
        method: "POST",
        url: `/api/auth/accounts/${disabled.id}/disable`,
        headers: adminHeaders,
        payload: { expectedVersion: current.version },
      });
      assert.equal(changed.statusCode, 200, changed.body);
      await app.close();
      app = undefined;
    });

    let log;
    await t.test("startup warns about enabled accounts without an external identity", async () => {
      log = memoryLogger();
      app = await composeProductionSignIn(t, {
        databaseUrl,
        settings: recoveryOnly(githubUpgradeSettings(admin.id)),
        secrets,
        logger: log.logger,
      });
      // The recovery account, the member with GitHub and the disabled account are not listed.
      const [warning, ...rest] = warnings(log);
      assert.deepEqual(rest, []);
      assert.equal(warning.severity, "WARN");
      assert.equal(warning.code, "EXTERNAL_IDENTITY_MISSING");
      assert.deepEqual(warning.skippedUserIds, [stranded.id]);
      assert.equal(warning.skippedUserCount, 1);
      assert.deepEqual(await providers(app), {
        github: true,
        google: false,
        oidc: false,
        password: false,
        sessionBinding: true,
      });
    });

    await t.test("ordinary passwords get the bad-credential answer", async () => {
      const denials = async () =>
        (await state.transact((unit) => unit.audit.list())).filter(
          ({ action, outcome, reasonCode }) =>
            action === "authentication.login" &&
            outcome === "denied" &&
            reasonCode === "INVALID_CREDENTIALS",
        ).length;
      const before = await denials();
      const unknown = { email: "recovery-only-nobody@example.test", password };
      const bodies = [];
      for (const account of [member, stranded, unknown, { ...member, password: "x".repeat(20) }]) {
        const refused = await passwordSignIn(app, origin, account, address());
        assert.equal(refused.statusCode, 401, account.email);
        assert.equal(refused.headers["set-cookie"], undefined);
        const { error } = refused.json();
        bodies.push({ code: error.code, message: error.message });
      }
      // No answer distinguishes an existing account, or a right password, from anything else.
      assert.equal(new Set(bodies.map((body) => JSON.stringify(body))).size, 1);
      assert.equal((await denials()) - before, 4, "each refusal is audited as a denied login");
    });

    await t.test("the recovery account still signs in with its password", async () => {
      const signedIn = await passwordSignIn(app, origin, admin, address());
      assert.equal(signedIn.statusCode, 200, signedIn.body);
      const cookie = cookieHeaderFromSetCookie(signedIn.headers["set-cookie"]);
      assert.equal((await currentSession(app, cookie)).user.id, admin.id);
      assert.equal(
        (await passwordSignIn(app, origin, { ...admin, password: "x".repeat(20) }, address()))
          .statusCode,
        401,
      );
      adminHeaders = { cookie, origin };
    });

    await t.test("an ordinary account signs in with its GitHub identity", async () => {
      const { callback } = await githubSignIn(app, origin, memberSubject, address());
      assert.equal(callback.headers.location, "/console/", callback.body);
      const cookie = cookieHeaderFromSetCookie(callback.headers["set-cookie"]);
      assert.equal((await currentSession(app, cookie)).user.id, member.id);
    });

    await t.test("attaching an identity unstrands an account without a restart", async () => {
      const { callback } = await githubSignIn(app, origin, strandedSubject, address());
      assert.equal(callback.headers.location, "/console/?authError=github");
      await attach("github", stranded, strandedSubject);
      const retried = await githubSignIn(app, origin, strandedSubject, address());
      assert.equal(retried.callback.headers.location, "/console/", retried.callback.body);
      assert.equal(
        (await passwordSignIn(app, origin, stranded, address())).statusCode,
        401,
        "the password stays refused",
      );
      await app.close();
      app = undefined;
      const restarted = memoryLogger();
      app = await composeProductionSignIn(t, {
        databaseUrl,
        settings: recoveryOnly(githubUpgradeSettings(admin.id)),
        secrets,
        logger: restarted.logger,
      });
      assert.deepEqual(warnings(restarted), [], "every enabled account has an identity");
      await app.close();
      app = undefined;
    });

    await t.test("only identities of the configured providers count", async () => {
      // Google alone: GitHub identities cannot sign in, so every ordinary account is stranded.
      const googleLog = memoryLogger();
      app = await composeProductionSignIn(t, {
        databaseUrl,
        settings: recoveryOnly(googleUpgradeSettings(admin.id)),
        secrets,
        logger: googleLog.logger,
      });
      const [warning] = warnings(googleLog);
      // State orders ids by database collation, which need not match JavaScript's sort.
      assert.deepEqual([...warning.skippedUserIds].sort(), [member.id, stranded.id].sort());
      assert.deepEqual(await providers(app), {
        github: false,
        google: true,
        oidc: false,
        password: false,
        sessionBinding: true,
      });
      assert.equal((await passwordSignIn(app, origin, member, address())).statusCode, 401);
      adminHeaders = await signedInHeaders(app, origin, admin, address());
      await attach("google", member, googleMemberSubject);
      const { callback } = await googleSignIn(
        app,
        origin,
        google,
        { subject: googleMemberSubject },
        address(),
      );
      assert.equal(callback.headers.location, "/console/", callback.body);
      const cookie = cookieHeaderFromSetCookie(callback.headers["set-cookie"]);
      assert.equal((await currentSession(app, cookie)).user.id, member.id);
    });
  },
);
