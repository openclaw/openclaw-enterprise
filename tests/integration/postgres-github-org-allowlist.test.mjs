import assert from "node:assert/strict";
import test from "node:test";
import {
  assertProviderAttached,
  assertSessionUser,
  authRowCounts,
  composeProductionSignIn,
  consoleOrigin as origin,
  githubSignIn,
  githubUpgradeSettings,
  onboardPasswordAccounts,
  passwordSignIn,
  postgresSignInState,
  readAccount,
  signedInHeaders,
  startFakeGitHub,
} from "../helpers/production-sign-in.mjs";
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
    let app;
    const { pool, state } = postgresSignInState(t, () => [app]);
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
    await assertProviderAttached(app, adminHeaders, member.id, "github", String(memberSubject));

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
      const { callback, attemptId } = await githubSignIn(app, origin, subject);
      return { callback, attemptId, paths: github.paths.slice(before) };
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
        [
          auditCode,
          {
            provider: "github",
            subject: String(subject),
            login: `fixture-${subject}`,
            attemptId: refused.attemptId,
          },
        ],
      ]);
    }

    await t.test("an active organization member signs in", async () => {
      memberships = { [acme]: () => "active" };
      const { callback, paths, attemptId } = await signIn(memberSubject);
      assert.equal(callback.headers.location, "/console/", callback.body);
      const events = await state.transact((unit) => unit.audit.list());
      const event = events.find(
        (entry) =>
          entry.action === "authentication.login" && entry.details?.attemptId === attemptId,
      );
      assert.equal(event?.outcome, "success");
      assert.equal(event.details.provider, "github");
      assert.equal(event.details.subject, String(memberSubject));
      assert.equal(event.details.login, `fixture-${memberSubject}`);
      assert.deepEqual(paths, ["/login/oauth/access_token", "/user", acme]);
      await assertSessionUser(app, callback, member.id);
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
        const { callback, attemptId } = await signIn(strangerSubject);
        assert.equal(callback.headers.location, "/console/?authError=github");
        assert.deepEqual((await loginDenials()).at(-1), [
          "EXTERNAL_IDENTITY_REJECTED",
          {
            provider: "github",
            subject: String(strangerSubject),
            login: `fixture-${strangerSubject}`,
            attemptId,
          },
        ]);
      },
    );

    await t.test(
      "a disabled attached account retains its verified identity in the denial",
      async () => {
        memberships = { [acme]: () => "active" };
        const account = await readAccount(app, adminHeaders, member.id);
        const disable = await app.inject({
          method: "POST",
          url: `/api/auth/accounts/${member.id}/disable`,
          headers: adminHeaders,
          payload: { expectedVersion: account.version },
        });
        assert.equal(disable.statusCode, 200, disable.body);
        const { callback, attemptId } = await signIn(memberSubject);
        assert.equal(
          callback.headers.location,
          "/console/?authError=github&authReason=account-disabled",
        );
        assert.deepEqual((await loginDenials()).at(-1), [
          "ACCOUNT_DISABLED",
          {
            provider: "github",
            userId: member.id,
            subject: String(memberSubject),
            login: `fixture-${memberSubject}`,
            attemptId,
          },
        ]);
        const disabled = await readAccount(app, adminHeaders, member.id);
        const enable = await app.inject({
          method: "POST",
          url: `/api/auth/accounts/${member.id}/enable`,
          headers: adminHeaders,
          payload: { expectedVersion: disabled.version },
        });
        assert.equal(enable.statusCode, 200, enable.body);
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
