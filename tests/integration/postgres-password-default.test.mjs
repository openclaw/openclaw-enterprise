import assert from "node:assert/strict";
import test from "node:test";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import {
  bootstrapProductionInstallation,
  composeProductionSignIn,
  consoleOrigin as origin,
  currentSession,
  defaultInstallSettings,
  installationRoles,
  passwordSignIn,
  postgresSignInState,
  signedInHeaders,
} from "../helpers/production-sign-in.mjs";
import { cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

const adminEmail = "password-default-admin@example.test";
const memberEmail = "password-default-member@example.test";
const memberPassword = "password-default-member-password";
const authSecret = "password-default-auth-test-secret-at-least-32-bytes";

// The default production install: the chart's initialization Job bootstraps the
// administrator's generated password, and the API Pod receives the example values'
// settings, with no OCC_AUTH_GITHUB_* or trusted-proxy names. No provider is reachable.
test(
  "a password-only install without GitHub onboards, signs in and out, and refuses GitHub routes",
  requiresPostgres,
  async (t) => {
    let app;
    const { pool } = postgresSignInState(t, () => [app]);
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
      oidc: false,
      password: true,
      sessionBinding: false,
    });

    const signIn = (email, password, remoteAddress) =>
      passwordSignIn(app, origin, { email, password }, remoteAddress);
    const sessionOf = (cookie) => currentSession(app, cookie);
    const adminHeaders = () =>
      signedInHeaders(app, origin, { email: adminEmail, password: adminPassword });

    await t.test("the bootstrap administrator signs in with the generated password", async () => {
      const response = await signIn(adminEmail, adminPassword);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().data.authenticated, true);
      const cookie = cookieHeaderFromSetCookie(response.headers["set-cookie"]);
      assert.equal((await sessionOf(cookie)).user.email, adminEmail);
    });

    let member;
    await t.test("the administrator creates a password account with the exact Origin", async () => {
      const headers = await adminHeaders();
      const { reader: role } = await installationRoles(new PostgresPlatformState(pool), pool);
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

    await t.test("password sign-ins are audited, and a failure names no account", async (t) => {
      // The audit record replaces the library's unstructured console warning.
      const warn = t.mock.method(console, "warn", () => {});
      const state = new PostgresPlatformState(pool);
      const logins = async () =>
        (await state.transact((unit) => unit.audit.list())).filter(
          ({ action }) => action === "authentication.login",
        );
      const before = (await logins()).length;
      const accepted = await signIn(memberEmail, memberPassword);
      assert.equal(accepted.statusCode, 200, accepted.body);
      const refused = await signIn(memberEmail, "wrong-member-password");
      assert.equal(refused.statusCode, 401, refused.body);
      const unknown = await signIn("nobody@example.test", "wrong-member-password");
      assert.equal(unknown.statusCode, 401, unknown.body);
      const recorded = (await logins()).slice(before);
      const installation = await state.loadInstallation();
      const principal = (await state.loadNativeIAMState(installation.id)).identities.find(
        (identity) => identity.kind === "principal" && identity.subject === member.id,
      );
      assert.ok(principal);
      assert.deepEqual(
        recorded.map(({ kind, actorId, outcome, reasonCode, details }) => ({
          kind,
          actorId,
          outcome,
          reasonCode,
          details,
        })),
        [
          {
            kind: "mutation",
            actorId: principal.id,
            outcome: "success",
            reasonCode: undefined,
            details: { userId: member.id },
          },
          ...Array(2).fill({
            kind: "authorization_denial",
            actorId: "unresolved",
            outcome: "denied",
            reasonCode: "INVALID_CREDENTIALS",
            details: undefined,
          }),
        ],
      );
      // Neither the attempted email nor the password reaches the audit record.
      const stored = JSON.stringify(recorded);
      assert.ok(!stored.includes("nobody@example.test"));
      assert.ok(!stored.includes("wrong-member-password"));
      assert.deepEqual(
        warn.mock.calls.filter(({ arguments: [message] }) =>
          String(message).includes("[Better Auth]"),
        ),
        [],
      );
    });

    await t.test(
      "account controls refuse with a specific conflict, not a dependency failure",
      async () => {
        const headers = await adminHeaders();
        const memberSession = cookieHeaderFromSetCookie(
          (await signIn(memberEmail, memberPassword)).headers["set-cookie"],
        );
        const requests = [
          { method: "GET", url: `/api/auth/accounts/${member.id}` },
          ...["disable", "enable", "revoke"].map((operation) => ({
            method: "POST",
            url: `/api/auth/accounts/${member.id}/${operation}`,
            payload: { expectedVersion: 1 },
          })),
          { method: "POST", url: `/api/auth/accounts/${member.id}/enrol` },
          { method: "GET", url: "/api/auth/recovery" },
          {
            method: "POST",
            url: "/api/auth/recovery",
            payload: { userId: member.id, expectedCurrentUserId: member.id, expectedVersion: 1 },
          },
        ];
        for (const request of requests) {
          const response = await app.inject({ ...request, headers });
          assert.equal(response.statusCode, 409, `${request.url}: ${response.body}`);
          assert.equal(response.json().error.code, "RESOURCE_CONFLICT");
          assert.match(response.json().error.message, /password-only/);
          const untrusted = await app.inject({ ...request, headers: { cookie: headers.cookie } });
          assert.equal(untrusted.statusCode, 403, "the Origin check still precedes the profile");
        }
        assert.equal((await sessionOf(memberSession)).user.id, member.id, "nothing was revoked");
      },
    );

    await t.test("GitHub and Google routes refuse without contacting a provider", async () => {
      let providerCalls = 0;
      const originalFetch = globalThis.fetch;
      t.mock.method(globalThis, "fetch", (input, init) => {
        providerCalls += 1;
        return originalFetch(input, init);
      });
      const { cookie } = await adminHeaders();
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
    await t.test(
      "password-only refuses unsupported stored email while preserving unusual passwords and denial audits",
      async () => {
        const legacyEmail = "legacy-default-\ud800@example.test";
        const storedEmail = "legacy-default-\ufffd@example.test";
        const legacyPassword = "legacy-password-\u0000-\ud800-\ufffd";
        // Reproduce a previously accepted account's encoding with the real PostgreSQL
        // parameter path; the API now rejects malformed input before it reaches State.
        const headers = await adminHeaders();
        const created = await app.inject({
          method: "POST",
          url: "/api/auth/accounts",
          headers,
          payload: { email: "supported-legacy-default@example.test", password: legacyPassword },
        });
        assert.equal(created.statusCode, 201, created.body);
        const userId = created.json().data.id;
        await pool.query('UPDATE occ."user" SET email = $1 WHERE id = $2', [legacyEmail, userId]);

        const stored = await pool.query('SELECT email FROM occ."user" WHERE id = $1', [userId]);
        assert.equal(stored.rows[0].email, storedEmail);
        // Better Auth's existing password-only validator rejects this stored spelling.
        // The SQL assertion above proves encoding, not successful account access.
        const unsupported = await signIn(storedEmail, legacyPassword);
        assert.equal(unsupported.statusCode, 400, unsupported.body);
        assert.equal(unsupported.json().error.code, "FORBIDDEN");
        assert.equal(unsupported.headers["set-cookie"], undefined);
        const sessions = await pool.query(
          "SELECT count(*)::int AS count FROM occ.session WHERE user_id = $1",
          [userId],
        );
        assert.equal(sessions.rows[0].count, 0);

        // The identical unusual password remains usable with a supported email address.
        const ordinaryEmail = "ordinary-unusual-default@example.test";
        const ordinary = await app.inject({
          method: "POST",
          url: "/api/auth/accounts",
          headers,
          payload: { email: ordinaryEmail, password: legacyPassword },
        });
        assert.equal(ordinary.statusCode, 201, ordinary.body);
        const ordinaryId = ordinary.json().data.id;

        const accepted = await signIn(ordinaryEmail, legacyPassword);
        assert.equal(accepted.statusCode, 200, accepted.body);
        const cookie = cookieHeaderFromSetCookie(accepted.headers["set-cookie"]);
        assert.equal((await sessionOf(cookie)).user.id, ordinaryId);
        const state = new PostgresPlatformState(pool);
        const denials = async () =>
          (await state.transact((unit) => unit.audit.list())).filter(
            ({ action, reasonCode }) =>
              action === "authentication.login" && reasonCode === "INVALID_CREDENTIALS",
          );
        const before = (await denials()).length;
        for (const email of [legacyEmail, "legacy-nul\u0000@example.test"]) {
          const refused = await app.inject({
            method: "POST",
            url: "/api/auth/sign-in/email",
            headers: { origin, cookie },
            payload: { email, password: legacyPassword },
          });
          assert.equal(refused.statusCode, 400, refused.body);
          assert.equal(refused.json().error.code, "INVALID_REQUEST");
          assert.equal(refused.headers["set-cookie"], undefined);
        }
        assert.equal((await denials()).length, before + 2);
      },
    );
  },
);
