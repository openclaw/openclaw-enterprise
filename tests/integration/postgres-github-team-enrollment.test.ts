import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import {
  accountPrincipalId,
  assertConsoleSignIn,
  assertProviderAttached,
  changeAccount,
  clientAddresses,
  consoleOrigin as origin,
  currentSession,
  githubSignIn,
  githubUpgradeSettings,
  sessionCookieName,
  signedInHeaders,
} from "../helpers/production-sign-in.mjs";
import { cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { preparePostgresSignInInstallation } from "../helpers/postgres-sign-in-installation.mjs";

type SignInInstallation = Awaited<ReturnType<typeof preparePostgresSignInInstallation>>;
type App = Awaited<ReturnType<SignInInstallation["composeApp"]>>;
type SignInResponse = Awaited<ReturnType<App["inject"]>>;
type Account = { id: string; email: string; password: string };
type GitHubFixture = {
  paths: string[];
  membership: ((path: string, subject: number) => string | number) | undefined;
  emails: ((subject: number) => unknown) | undefined;
  profile: ((subject: number) => { id: number; login: string }) | undefined;
};

const groupId = "team.platform";
const firstSubject = 8_100_001;
const existingSubject = 8_100_002;
const concurrentSubject = 8_100_003;
const primaryEmail = (email: string) => [
  { email, primary: true, verified: true, visibility: null },
];
const subjectEmail = (subject: number) => `team-${subject}@example.test`;

// Only the upstream GitHub HTTP responses and passive Compute are fixtures. Production
// Fastify, PostgreSQL, session issuance, IAM and the ordinary Agent API own the outcome.
test(
  "GitHub team enrollment creates one account with configured Group access and refuses unsafe enrollment",
  requiresPostgres,
  async (t) => {
    let app: App;
    const {
      pool,
      state,
      github: fixture,
      onboard,
      composeApp,
    } = await preparePostgresSignInInstallation(t, () => [app], {
      email: "team-enrollment-recovery@example.test",
      password: "team-enrollment-member-password",
      secrets: {
        "occ-auth/secret": "team-enrollment-auth-secret-at-least-32-bytes",
        "occ-github-login/client-id": "team-enrollment-client-id",
        "occ-github-login/client-secret": "team-enrollment-client-secret",
      },
    });
    assert.ok(fixture);
    const github: GitHubFixture = fixture;
    const address = clientAddresses("198.19");
    const { admin, roles, accounts } = (await onboard({
      remoteAddress: address(),
      accounts: {
        existing: { email: "team-existing@example.test" },
        disabled: { email: "team-disabled@example.test" },
        stale: { email: "team-stale@example.test" },
      },
    })) as Awaited<ReturnType<typeof onboard>> & {
      admin: Account;
      accounts: Record<"existing" | "disabled" | "stale", Account>;
    };
    // Groups have no management API yet. Seed an existing operator-managed Group using
    // the application's real INSERT privileges; enrollment must not create its grants.
    await pool.query("INSERT INTO occ.iam_groups (id, name) VALUES ($1, $2)", [
      groupId,
      "GitHub team administrators",
    ]);
    await pool.query(
      `INSERT INTO occ.iam_access_bindings (id, group_subject_id, role_id)
       VALUES ('binding_github_team_enrollment', $1, $2)`,
      [groupId, roles.admin.id],
    );
    const settings = {
      ...githubUpgradeSettings(admin.id),
      OCC_AUTH_GITHUB_ALLOWED_TEAMS: "example/maintainers",
      OCC_AUTH_GITHUB_AUTO_ENROLL_GROUP_ID: groupId,
    };
    let teamMembership: string | number = "active";
    github.membership = (path, subject) => {
      if (path === "/user/memberships/orgs/example") {
        return "active";
      }
      if (path === `/orgs/example/teams/maintainers/memberships/fixture-${subject}`) {
        return teamMembership;
      }
      return 404;
    };
    const ordinaryEmails = (subject: number) => primaryEmail(subjectEmail(subject));
    github.emails = ordinaryEmails;
    app = await composeApp(settings);
    const adminHeaders = await signedInHeaders(app, origin, admin, address());
    const signIn = (subject: number) => githubSignIn(app, origin, subject, address());
    const rowCounts = async () =>
      (
        await pool.query(`SELECT
          (SELECT count(*)::int FROM occ."user") AS users,
          (SELECT count(*)::int FROM occ.account) AS methods,
          (SELECT count(*)::int FROM occ.human_authentication_accounts) AS accounts,
          (SELECT count(*)::int FROM occ.iam_identities) AS principals,
          (SELECT count(*)::int FROM occ.iam_group_memberships) AS memberships,
          (SELECT count(*)::int FROM occ.session) AS sessions`)
      ).rows[0];
    const assertNoCookie = (callback: SignInResponse) =>
      assert.equal(String(callback.headers["set-cookie"] ?? "").includes(sessionCookieName), false);
    async function refused(subject: number, expectedLocation?: string) {
      const before = await rowCounts();
      const { callback } = await signIn(subject);
      assert.equal(callback.statusCode, 302, callback.body);
      if (expectedLocation !== undefined) {
        assert.equal(callback.headers.location, expectedLocation);
      } else {
        assert.match(callback.headers.location, /^\/console\/\?authError=github/);
      }
      assertNoCookie(callback);
      assert.deepEqual(await rowCounts(), before, "no partial account, grant, or session");
    }
    let member: Pick<Account, "id" | "email">;
    let memberHeaders: { cookie: string; origin: string };
    await t.test(
      "a first login receives Group access through the ordinary Agent workflow",
      async () => {
        const before = await rowCounts();
        const firstRequest = github.paths.length;
        const { callback, attemptId } = await signIn(firstSubject);
        assert.equal(callback.headers.location, "/console/", callback.body);
        assert.deepEqual(github.paths.slice(firstRequest), [
          "/login/oauth/access_token",
          "/user",
          "/user/memberships/orgs/example",
          `/orgs/example/teams/maintainers/memberships/fixture-${firstSubject}`,
          "/user",
          "/user/emails?per_page=100",
        ]);
        memberHeaders = {
          cookie: cookieHeaderFromSetCookie(callback.headers["set-cookie"]),
          origin,
        };
        member = (await currentSession(app, memberHeaders.cookie)).user;
        assert.equal(member.email, subjectEmail(firstSubject));
        const principal = await accountPrincipalId(pool, member.id);
        const after = await rowCounts();
        assert.deepEqual(after, {
          users: before.users + 1,
          methods: before.methods + 2,
          accounts: before.accounts + 1,
          principals: before.principals + 1,
          memberships: before.memberships + 1,
          sessions: before.sessions + 1,
        });
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS count FROM occ.iam_access_bindings WHERE identity_subject_id = $1",
              [principal],
            )
          ).rows[0].count,
          0,
          "the new Principal has no direct grant",
        );
        const namespace = await app.inject({
          method: "POST",
          url: "/namespaces",
          headers: memberHeaders,
          payload: { name: "Team enrollment workflow" },
        });
        assert.equal(namespace.statusCode, 201, namespace.body);
        const base = `/namespaces/${namespace.json().data.id}`;
        const configuration = await app.inject({
          method: "POST",
          url: `${base}/configurations`,
          headers: memberHeaders,
          payload: { kind: "agent", values: {} },
        });
        assert.equal(configuration.statusCode, 201, configuration.body);
        const agent = await app.inject({
          method: "POST",
          url: `${base}/agents`,
          headers: memberHeaders,
          payload: {
            name: "Team member Agent",
            configurationId: configuration.json().data.id,
            harnessAuth: null,
          },
        });
        assert.equal(agent.statusCode, 201, agent.body);
        assert.equal(
          (
            await app.inject({
              url: `${base}/agents/${agent.json().data.id}`,
              headers: memberHeaders,
            })
          ).statusCode,
          200,
        );
        const events = await state.transact((unit) => unit.audit.list());
        assert.ok(
          events.some(
            (event) =>
              event.action === "authentication.login" &&
              event.outcome === "success" &&
              event.details?.attemptId === attemptId,
          ),
        );
        assert.ok(
          events.some(
            (event) =>
              event.action === "authentication.account.enrol" &&
              event.details?.userId === member.id,
          ),
        );
      },
    );
    await t.test(
      "repeat login preserves the account and grants when email permission is absent",
      async () => {
        const before = await rowCounts();
        const start = github.paths.length;
        github.emails = () => 403;
        try {
          const { callback } = await signIn(firstSubject);
          await assertConsoleSignIn(app, callback, member.id);
          assert.deepEqual(await rowCounts(), { ...before, sessions: before.sessions + 1 });
          assert.equal(github.paths.slice(start).filter((path) => path === "/user").length, 2);
          assert.equal(github.paths.slice(start).includes("/user/emails?per_page=100"), false);
        } finally {
          github.emails = ordinaryEmails;
        }
      },
    );
    await t.test("an attached account joins the Group without replacing its email", async () => {
      await assertProviderAttached(
        app,
        adminHeaders,
        accounts.existing.id,
        "github",
        String(existingSubject),
      );
      const before = await rowCounts();
      github.emails = () => 403;
      try {
        const { callback } = await signIn(existingSubject);
        const cookie = await assertConsoleSignIn(app, callback, accounts.existing.id);
        assert.equal((await currentSession(app, cookie)).user.email, accounts.existing.email);
        assert.deepEqual(await rowCounts(), {
          ...before,
          memberships: before.memberships + 1,
          sessions: before.sessions + 1,
        });
        assert.equal(
          (
            await app.inject({
              method: "POST",
              url: "/namespaces",
              headers: { origin, cookie },
              payload: { name: "Existing member workspace" },
            })
          ).statusCode,
          201,
        );
      } finally {
        github.emails = ordinaryEmails;
      }
    });
    await t.test("a disabled attached account cannot acquire a Group membership", async () => {
      const subject = 8_100_004;
      await assertProviderAttached(
        app,
        adminHeaders,
        accounts.disabled.id,
        "github",
        String(subject),
      );
      const disabled = await changeAccount(app, adminHeaders, accounts.disabled.id, "disable");
      assert.equal(disabled.statusCode, 200, disabled.body);
      await refused(subject, "/console/?authError=github&authReason=account-disabled");
      const principal = await accountPrincipalId(pool, accounts.disabled.id);
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM occ.iam_group_memberships WHERE principal_id = $1",
            [principal],
          )
        ).rows[0].count,
        0,
      );
    });
    await t.test(
      "an identity attached after login started is refused without fetching email",
      async () => {
        const subject = 8_100_017;
        const remoteAddress = address();
        const start = await app.inject({
          method: "POST",
          url: "/api/auth/providers/github/start",
          remoteAddress,
          headers: { origin },
        });
        assert.equal(start.statusCode, 200, start.body);
        const stateValue = new URL(start.json().data.url).searchParams.get("state");
        // The administrator attaches the identity while its older browser attempt is
        // outstanding. A stale snapshot must not be mistaken for a new, unenrolled person.
        await assertProviderAttached(
          app,
          adminHeaders,
          accounts.stale.id,
          "github",
          String(subject),
        );
        const before = await rowCounts();
        const firstRequest = github.paths.length;
        github.emails = () => 403;
        try {
          const callback = await app.inject({
            url: `/api/auth/providers/github/callback?state=${stateValue}&code=subject-${subject}`,
            remoteAddress,
            headers: { cookie: cookieHeaderFromSetCookie(start.headers["set-cookie"]) },
          });
          assert.equal(callback.statusCode, 302, callback.body);
          assert.equal(callback.headers.location, "/console/?authError=github");
          assertNoCookie(callback);
          assert.equal(
            github.paths.slice(firstRequest).includes("/user/emails?per_page=100"),
            false,
          );
          assert.deepEqual(await rowCounts(), before);
        } finally {
          github.emails = ordinaryEmails;
        }
      },
    );
    await t.test(
      "organization membership alone and pending team membership cannot enroll",
      async () => {
        try {
          for (const membership of [404, "pending"]) {
            teamMembership = membership;
            await refused(8_100_010, "/console/?authError=github&authReason=membership");
          }
        } finally {
          teamMembership = "active";
        }
      },
    );
    await t.test(
      "missing, unverified, ambiguous, and unavailable email cannot create an account",
      async () => {
        try {
          for (const response of [
            [],
            { email: "wrong-shape@example.test", primary: true, verified: true },
            [{ email: 42, primary: true, verified: true }],
            [{ email: "not-an-email", primary: true, verified: true }],
            [{ email: "unverified@example.test", primary: true, verified: false }],
            [...primaryEmail("first@example.test"), ...primaryEmail("second@example.test")],
            [{ ...primaryEmail("oversized@example.test")[0], padding: "x".repeat(65 * 1024) }],
            403,
            503,
          ]) {
            github.emails = () => response;
            await refused(8_100_011);
          }
        } finally {
          github.emails = ordinaryEmails;
        }
      },
    );
    await t.test("a profile changed during team verification cannot enroll", async () => {
      // Team lookup uses a mutable login. A fresh authenticated profile must still
      // identify the same person after that lookup, even when the team answer is active.
      for (const [subject, changed] of [
        [8_100_015, { id: 8_100_099, login: "fixture-8100015" }],
        [8_100_016, { id: 8_100_016, login: "renamed-member" }],
      ] as const) {
        let reads = 0;
        github.profile = (authenticatedSubject) => {
          assert.equal(authenticatedSubject, subject, "both profiles use the same access token");
          reads += 1;
          return reads === 1 ? { id: subject, login: `fixture-${subject}` } : changed;
        };
        try {
          await refused(subject, "/console/?authError=github");
          assert.equal(reads, 2);
        } finally {
          github.profile = undefined;
        }
      }
    });
    await t.test("matching email cannot attach another GitHub identity", async () => {
      github.emails = () => primaryEmail(accounts.existing.email);
      try {
        await refused(8_100_012);
      } finally {
        github.emails = ordinaryEmails;
      }
    });
    await t.test(
      "overlapping first logins converge on one account and retain the attempt fence",
      async () => {
        const before = await rowCounts();
        const bothArrived = Promise.withResolvers<void>();
        let arrivals = 0;
        github.emails = async (subject) => {
          if (subject === concurrentSubject) {
            arrivals += 1;
            if (arrivals === 2) {
              bothArrived.resolve();
            }
            await bothArrived.promise;
          }
          return ordinaryEmails(subject);
        };
        let results;
        try {
          results = await Promise.all([signIn(concurrentSubject), signIn(concurrentSubject)]);
        } finally {
          bothArrived.resolve();
          github.emails = ordinaryEmails;
        }
        assert.equal(arrivals, 2, "both verified attempts preceded the account write");
        const successful = results.filter(
          ({ callback }) => callback.headers.location === "/console/",
        );
        assert.equal(
          successful.length,
          1,
          "the older competing attempt must retry after attachment",
        );
        const refusedResult = results.find(
          ({ callback }) => callback.headers.location !== "/console/",
        );
        assert.ok(refusedResult);
        assertNoCookie(refusedResult.callback);
        const successfulResult = successful[0];
        assert.ok(successfulResult);
        const after = await rowCounts();
        assert.deepEqual(after, {
          users: before.users + 1,
          methods: before.methods + 2,
          accounts: before.accounts + 1,
          principals: before.principals + 1,
          memberships: before.memberships + 1,
          sessions: before.sessions + 1,
        });
        const concurrentUser = (
          await currentSession(
            app,
            cookieHeaderFromSetCookie(successfulResult.callback.headers["set-cookie"]),
          )
        ).user;
        await assertConsoleSignIn(
          app,
          (await signIn(concurrentSubject)).callback,
          concurrentUser.id,
        );
      },
    );
    await t.test(
      "a real audit constraint failure rolls back enrollment and Group membership",
      async (auditTest) => {
        const before = await rowCounts();
        const auditCount = async () =>
          (await pool.query("SELECT count(*)::int AS count FROM occ.audit_events")).rows[0].count;
        const beforeAudit = await auditCount();
        const query = pg.Client.prototype.query;
        let corrupted = false;
        auditTest.mock.method(
          pg.Client.prototype,
          "query",
          function (this: pg.Client, sql: unknown, ...args: unknown[]) {
            // Reject the membership audit after the account and membership writes. The
            // real database constraint must undo both writes and the earlier account audit.
            if (
              !corrupted &&
              typeof sql === "string" &&
              sql.includes("INSERT INTO occ.audit_events") &&
              Array.isArray(args[0]) &&
              args[0][4] === "authentication.group.enrol"
            ) {
              corrupted = true;
              args[0] = ["invalid-audit-id", ...args[0].slice(1)];
            }
            return Reflect.apply(query, this, [sql, ...args]);
          },
        );
        const { callback } = await signIn(8_100_013);
        assert.equal(corrupted, true);
        assertNoCookie(callback);
        assert.deepEqual(await rowCounts(), before);
        assert.equal(await auditCount(), beforeAudit);
      },
    );
    await t.test(
      "account disable revokes current sessions and prevents fresh Group login",
      async () => {
        const disabled = await changeAccount(app, adminHeaders, member.id, "disable");
        assert.equal(disabled.statusCode, 200, disabled.body);
        assert.equal(await currentSession(app, memberHeaders.cookie), null);
        await refused(firstSubject, "/console/?authError=github&authReason=account-disabled");
      },
    );
    await t.test("missing or namespace-scoped configured Groups cannot enroll", async () => {
      const namespaces = await app.inject({ url: "/namespaces", headers: adminHeaders });
      const namespaceId = namespaces.json().data[0].id;
      const scopedGroup = "group_scoped_team_enrollment";
      await pool.query("INSERT INTO occ.iam_groups (id, namespace_id, name) VALUES ($1, $2, $3)", [
        scopedGroup,
        namespaceId,
        "Scoped enrollment",
      ]);
      for (const selected of ["group_absent_team_enrollment", scopedGroup]) {
        await app.close();
        app = await composeApp({ ...settings, OCC_AUTH_GITHUB_AUTO_ENROLL_GROUP_ID: selected });
        await refused(8_100_014);
      }
    });
  },
);
