import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import {
  bootstrapProductionInstallation,
  composeProductionSignIn,
  consoleOrigin as origin,
  currentSession,
  defaultInstallSettings,
  passwordSignIn,
} from "../helpers/production-sign-in.mjs";
import { cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const adminEmail = "password-default-admin@example.test";
const memberEmail = "password-default-member@example.test";
const memberPassword = "password-default-member-password";
const authSecret = "password-default-auth-test-secret-at-least-32-bytes";

// The default production install: the chart's initialization Job bootstraps the
// administrator's generated password, and the API Pod receives the example values'
// settings, with no OCC_AUTH_GITHUB_* or trusted-proxy names. No provider is reachable.
test(
  "a password-only install without GitHub onboards, signs in and out, and refuses GitHub routes",
  { skip: databaseUrl ? false : "Set OCC_TEST_DATABASE_URL for real PostgreSQL proof." },
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    let app;
    t.after(async () => {
      await app?.close();
      await pool.end();
    });
    const adminPassword = await bootstrapProductionInstallation(t, {
      databaseUrl,
      email: adminEmail,
      authSecret,
    });
    app = await composeProductionSignIn(t, {
      databaseUrl,
      settings: defaultInstallSettings,
      secrets: { "occ-auth/secret": authSecret },
    });
    await app.ready();

    const providers = await app.inject({ url: "/api/auth/providers" });
    assert.equal(providers.statusCode, 200);
    assert.deepEqual(providers.json().data, {
      github: false,
      google: false,
      sessionBinding: false,
    });

    const signIn = (email, password, remoteAddress) =>
      passwordSignIn(app, origin, { email, password }, remoteAddress);
    const sessionOf = (cookie) => currentSession(app, cookie);

    await t.test("the bootstrap administrator signs in with the generated password", async () => {
      const response = await signIn(adminEmail, adminPassword);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().data.authenticated, true);
      const cookie = cookieHeaderFromSetCookie(response.headers["set-cookie"]);
      assert.equal((await sessionOf(cookie)).user.email, adminEmail);
    });

    let member;
    await t.test("the administrator creates a password account with the exact Origin", async () => {
      const admin = await signIn(adminEmail, adminPassword);
      const headers = { cookie: cookieHeaderFromSetCookie(admin.headers["set-cookie"]), origin };
      const installation = await new PostgresPlatformState(pool).loadInstallation();
      const policy = await new PostgresPlatformState(pool).loadNativeIAMState(installation.id);
      const role = policy.roles.find((candidate) =>
        candidate.permissions.some(
          (permission) =>
            permission.action === "read" && permission.resourceKind === "installation",
        ),
      );
      assert.ok(role);
      const payload = { email: memberEmail, password: memberPassword, roleId: role.id };
      for (const refused of [
        { cookie: headers.cookie },
        { cookie: headers.cookie, origin: "https://attacker.example.test" },
      ]) {
        const response = await app.inject({
          method: "POST",
          url: "/api/auth/accounts",
          headers: refused,
          payload,
        });
        assert.equal(response.statusCode, 403, response.body);
      }
      const created = await app.inject({
        method: "POST",
        url: "/api/auth/accounts",
        headers,
        payload,
      });
      assert.equal(created.statusCode, 201, created.body);
      member = created.json().data;
      assert.equal(member.email, memberEmail);
      const withGitHub = await app.inject({
        method: "POST",
        url: "/api/auth/accounts",
        headers,
        payload: {
          email: "password-default-github@example.test",
          password: memberPassword,
          roleId: role.id,
          github: { subject: "55555555" },
        },
      });
      assert.equal(withGitHub.statusCode, 409, "a GitHub subject needs GitHub sign-in");
    });

    await t.test("the new account signs in and signs out only with the exact Origin", async () => {
      const response = await signIn(memberEmail, memberPassword);
      assert.equal(response.statusCode, 200, response.body);
      const cookie = cookieHeaderFromSetCookie(response.headers["set-cookie"]);
      assert.equal((await sessionOf(cookie)).user.id, member.id);
      for (const headers of [{ cookie }, { cookie, origin: "https://attacker.example.test" }]) {
        const refused = await app.inject({ method: "POST", url: "/api/auth/sign-out", headers });
        assert.equal(refused.statusCode, 403, refused.body);
        assert.equal(refused.headers["set-cookie"], undefined);
        assert.equal((await sessionOf(cookie)).user.id, member.id, "the session stays current");
      }
      const signedOut = await app.inject({
        method: "POST",
        url: "/api/auth/sign-out",
        headers: { cookie, origin },
      });
      assert.equal(signedOut.statusCode, 200, signedOut.body);
      assert.equal(await sessionOf(cookie), null);
    });

    await t.test("GitHub and Google routes refuse without contacting a provider", async () => {
      let providerCalls = 0;
      const originalFetch = globalThis.fetch;
      t.mock.method(globalThis, "fetch", (input, init) => {
        providerCalls += 1;
        return originalFetch(input, init);
      });
      const admin = await signIn(adminEmail, adminPassword);
      const cookie = cookieHeaderFromSetCookie(admin.headers["set-cookie"]);
      for (const provider of ["github", "google"]) {
        const start = await app.inject({
          method: "POST",
          url: `/api/auth/providers/${provider}/start`,
          headers: { origin },
        });
        assert.equal(start.statusCode, 403, start.body);
        assert.equal(start.headers["set-cookie"], undefined);
        const callback = await app.inject({
          url: `/api/auth/providers/${provider}/callback?state=unconfigured&code=unconfigured`,
        });
        assert.equal(callback.statusCode, 302);
        assert.equal(callback.headers.location, `/console/?authError=${provider}`);
        assert.equal(callback.headers["set-cookie"], undefined);
        const result = await app.inject({
          method: "POST",
          url: `/api/auth/providers/${provider}/result`,
          headers: { cookie, origin },
          payload: { attemptId: "A".repeat(43) },
        });
        assert.equal(result.statusCode, 403, result.body);
      }
      assert.equal(providerCalls, 0);
      assert.equal(
        (await pool.query("SELECT count(*)::int AS count FROM occ.human_authentication_recovery"))
          .rows[0].count,
        0,
        "the password-only profile never activates GitHub sign-in",
      );
    });

    await t.test("wrong passwords are refused without locking out the administrator", async () => {
      const guesser = "198.51.100.7";
      const statuses = [];
      for (let index = 0; index < 11; index += 1) {
        statuses.push(
          (await signIn(`guess-${index}@example.test`, "wrong-guess-password", guesser)).statusCode,
        );
      }
      assert.deepEqual(statuses, Array(11).fill(401));
      assert.equal(
        (await signIn(adminEmail, "wrong-admin-password", guesser)).statusCode,
        401,
        "a wrong administrator password is refused",
      );
      // These failures stay under the password-only profile's limits
      // (postgres-password-sign-in-limit.test.mjs); what it must never do is lock the only
      // administrator out.
      const admin = await signIn(adminEmail, adminPassword, guesser);
      assert.equal(admin.statusCode, 200, admin.body);
      const other = await signIn(adminEmail, adminPassword, "203.0.113.20");
      assert.equal(other.statusCode, 200, other.body);
      assert.equal((await signIn(memberEmail, memberPassword, "203.0.113.21")).statusCode, 200);
    });
  },
);
