import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import {
  attachProvider,
  authRowCounts,
  composeProductionSignIn,
  consoleOrigin as origin,
  currentSession,
  githubSignIn,
  githubUpgradeSettings,
  onboardPasswordAccounts,
  passwordSignIn,
  signedInHeaders,
  startFakeGitHub,
} from "../helpers/production-sign-in.mjs";
import { cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

const adminEmail = "allowlist-recovery@example.test";
const password = "allowlist-member-password";
const authSecret = "allowlist-auth-test-secret-at-least-32-bytes";
const secrets = {
  "occ-auth/secret": authSecret,
  "occ-github-login/client-id": "allowlist-client-id",
  "occ-github-login/client-secret": "allowlist-client-secret",
};
const memberSubject = 7_100_001;
const strangerSubject = 7_100_002;
const acme = "/user/memberships/orgs/acme";
const other = "/user/memberships/orgs/other";
const team = (subject) => `/orgs/other/teams/platform/memberships/fixture-${subject}`;

// RFC-0061 through the production composition: the rendered allowlist settings, the real
// callback route, State's audit and the Console redirect. Only remote GitHub HTTP is faked.
test(
  "a GitHub org and team allowlist refuses non-members before the account lookup and fails closed when GitHub cannot answer",
  requiresPostgres,
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const state = new PostgresPlatformState(pool);
    let app;
    t.after(async () => {
      await app?.close();
      await pool.end();
    });
    const github = await startFakeGitHub(t);
    let memberships = {};
    // Compare with the fixed paths; never select a handler by the request's own key.
    github.membership = (path, subject) =>
      Object.entries(memberships).find(([listed]) => listed === path)?.[1](subject) ?? 404;

    const { admin, accounts } = await onboardPasswordAccounts(t, {
      databaseUrl,
      state,
      pool,
      email: adminEmail,
      authSecret,
      secrets,
      password,
      accounts: { member: { email: "allowlist-member@example.test" } },
    });
    const { member } = accounts;
    app = await composeProductionSignIn(t, {
      databaseUrl,
      settings: {
        ...githubUpgradeSettings(admin.id),
        OCC_AUTH_GITHUB_ALLOWED_ORGS: "Acme",
        OCC_AUTH_GITHUB_ALLOWED_TEAMS: "other/platform",
      },
      secrets,
    });
    const adminHeaders = await signedInHeaders(app, origin, admin);
    const attached = await attachProvider(
      app,
      adminHeaders,
      member.id,
      "github",
      String(memberSubject),
    );
    assert.equal(attached.statusCode, 200, attached.body);

    const sessionCount = async () => (await authRowCounts(pool)).sessions;
    const loginDenials = async () =>
      (await state.transact((unit) => unit.audit.list()))
        .filter(
          (event) =>
            event.kind === "authorization_denial" && event.action === "authentication.login",
        )
        .map(({ reasonCode, details }) => [reasonCode, details]);
    async function signIn(subject) {
      const before = github.paths.length;
      const { callback } = await githubSignIn(app, origin, subject);
      return { callback, paths: github.paths.slice(before) };
    }
    async function expectRefused(subject, reason, auditCode, paths) {
      const sessions = await sessionCount();
      const denials = (await loginDenials()).length;
      const refused = await signIn(subject);
      assert.equal(refused.callback.statusCode, 302);
      assert.equal(
        refused.callback.headers.location,
        `/console/?authError=github&authReason=${reason}`,
      );
      assert.equal(refused.callback.headers["set-cookie"], undefined);
      assert.equal(await sessionCount(), sessions, "no session is issued");
      assert.deepEqual(refused.paths, ["/login/oauth/access_token", "/user", ...paths]);
      assert.deepEqual((await loginDenials()).slice(denials), [
        [auditCode, { provider: "github", subject: String(subject) }],
      ]);
    }

    await t.test("an active organization member signs in", async () => {
      memberships = { [acme]: () => "active" };
      const { callback, paths } = await signIn(memberSubject);
      assert.equal(callback.headers.location, "/console/", callback.body);
      assert.deepEqual(paths, ["/login/oauth/access_token", "/user", acme]);
      const cookie = cookieHeaderFromSetCookie(callback.headers["set-cookie"]);
      assert.equal((await currentSession(app, cookie)).user.id, member.id);
    });

    await t.test("an active member of the listed team signs in", async () => {
      memberships = { [other]: () => "active", [team(memberSubject)]: () => "active" };
      const { callback, paths } = await signIn(memberSubject);
      assert.equal(callback.headers.location, "/console/", callback.body);
      assert.deepEqual(paths, [
        "/login/oauth/access_token",
        "/user",
        acme,
        other,
        team(memberSubject),
      ]);
    });

    await t.test("an attached identity outside every entry is refused and audited", async () => {
      memberships = { [acme]: () => "pending", [other]: () => "active" };
      await expectRefused(memberSubject, "membership", "MEMBERSHIP_REQUIRED", [
        acme,
        other,
        team(memberSubject),
      ]);
    });

    await t.test(
      "an unattached identity gets the same membership refusal, before any account lookup",
      async () => {
        memberships = {};
        await expectRefused(strangerSubject, "membership", "MEMBERSHIP_REQUIRED", [acme, other]);
        // A listed member without an OCE account still gets the ordinary rejection.
        memberships = { [acme]: () => "active" };
        const { callback } = await signIn(strangerSubject);
        assert.equal(callback.headers.location, "/console/?authError=github");
        assert.equal((await loginDenials()).at(-1)[0], "EXTERNAL_IDENTITY_REJECTED");
      },
    );

    await t.test(
      "a membership lookup GitHub cannot answer fails closed; passwords keep working",
      async () => {
        memberships = { [acme]: () => 503, [other]: () => 403 };
        await expectRefused(memberSubject, "membership-unavailable", "MEMBERSHIP_UNAVAILABLE", [
          acme,
          other,
        ]);
        const signedIn = await passwordSignIn(app, origin, member);
        assert.equal(signedIn.statusCode, 200, signedIn.body);
      },
    );
  },
);
