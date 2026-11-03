import assert from "node:assert/strict";
import test from "node:test";
import {
  assertProviderAttached,
  assertSessionUser,
  authRowCounts,
  clientAddresses,
  consoleOrigin as origin,
  githubSignIn,
  githubUpgradeSettings,
  signedInHeaders,
  type composeProductionSignIn,
} from "../helpers/production-sign-in.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { preparePostgresSignInInstallation } from "../helpers/postgres-sign-in-installation.mjs";

const memberSubject = 7_200_001;
const otherSubject = 7_200_002;
const managedLogin = "mona-cat_octo";
const oldLogin = "former-login";
const roster = "/organizations/123/team/456/members";
const pages = Array.from({ length: 10 }, (_, index) => `${roster}?per_page=30&page=${index + 1}`);
const [pageOne, pageTwo] = [pages[0]!, pages[1]!];
const oldTeamList = "/user/teams?per_page=10&page=1";
const renamedTeam = { id: 456, slug: "new-team-name", organization: { id: 123, login: "new-org" } };

type Page = { entries: readonly unknown[]; link?: string };
type Answer = number | "active" | "pending" | Page;

test(
  "GitHub sign-in checks pinned team IDs for the authenticated attached user",
  requiresPostgres,
  async (t) => {
    const running: { app?: Awaited<ReturnType<typeof composeProductionSignIn>> } = {};
    const {
      pool,
      state,
      github: fakeGitHub,
      onboard,
      composeApp,
    } = await preparePostgresSignInInstallation(t, () => [running.app], {
      email: "pinned-team-recovery@example.test",
      password: "pinned-team-password",
      secrets: {
        "occ-auth/secret": "pinned-team-auth-secret-at-least-32-bytes",
        "occ-github-login/client-id": "pinned-team-client-id",
        "occ-github-login/client-secret": "pinned-team-client-secret",
      },
    });
    assert.ok(fakeGitHub);
    const github = fakeGitHub;
    const { admin, accounts } = await onboard({
      accounts: { member: { email: "pinned-team-member@example.test" } },
    });
    const { member } = accounts;
    assert.ok(member);
    const application = await composeApp({
      ...githubUpgradeSettings(admin.id),
      OCC_AUTH_GITHUB_ALLOWED_TEAMS: "id:123/456",
    });
    running.app = application;
    const adminHeaders = await signedInHeaders(application, origin, admin);
    await assertProviderAttached(
      application,
      adminHeaders,
      member.id,
      "github",
      String(memberSubject),
    );
    const nextAddress = clientAddresses();
    async function signIn(
      answers: ReadonlyMap<string, Answer>,
      subject = memberSubject,
      login = managedLogin,
    ) {
      const before = github.paths.length;
      github.login = () => login;
      github.membership = (path, authenticatedSubject) =>
        authenticatedSubject === subject ? (answers.get(path) ?? 404) : 403;
      const { callback, attemptId } = await githubSignIn(
        application,
        origin,
        subject,
        nextAddress(),
      );
      assert.equal(callback.statusCode, 302);
      return { callback, attemptId, paths: github.paths.slice(before) };
    }

    await t.test(
      "an active managed user signs in from the renamed team's next roster page",
      async () => {
        const { callback, paths, attemptId } = await signIn(
          new Map<string, Answer>([
            [oldTeamList, { entries: [renamedTeam] }],
            [
              pageOne,
              {
                entries: [{ id: otherSubject, login: "someone-else" }],
                link: '<https://api.github.com/untrusted-next-target>; rel="next"',
              },
            ],
            [pageTwo, { entries: [{ id: memberSubject, login: managedLogin, role: "member" }] }],
          ]),
        );
        assert.equal(callback.headers.location, "/console/");
        // A short page may have a successor. GitHub's supplied target is never fetched.
        assert.deepEqual(paths, ["/login/oauth/access_token", "/user", pageOne, pageTwo]);
        await assertSessionUser(application, callback, member.id);
        const events = await state.transact((unit) => unit.audit.list());
        const event = events.find((entry) => entry.details?.attemptId === attemptId);
        assert.equal(event?.action, "authentication.login");
        assert.equal(event?.details?.subject, String(memberSubject));
        assert.equal(event?.details?.login, managedLogin);
      },
    );

    function fullRoster(continues: boolean): [string, Page][] {
      return pages.map((path, pageIndex) => {
        const entries = Array.from({ length: 30 }, (_, index) => ({
          id: 10_000 + pageIndex * 30 + index,
        }));
        const next =
          pages[pageIndex + 1] ?? (continues ? `${roster}?per_page=30&page=11` : undefined);
        return [
          path,
          {
            entries,
            link: next
              ? `<https://api.github.com${next}>; rel="next"`
              : `<https://api.github.com${pages[pageIndex - 1]}>; rel="prev"`,
          },
        ];
      });
    }

    const scenarios: readonly {
      name: string;
      answers: readonly (readonly [string, Answer])[];
      expectedPaths: readonly string[];
      reason?: "membership" | "membership-unavailable";
      auditCode: "MEMBERSHIP_REQUIRED" | "MEMBERSHIP_UNAVAILABLE" | "EXTERNAL_IDENTITY_REJECTED";
      subject?: number;
      login?: string;
    }[] = [
      {
        name: "a reassigned login cannot transfer B's active membership to the removed account A",
        // The superseded protocol saw A's stale team list and an active answer for A's former
        // login, which now belongs to B. The current roster contains only B's distinct user ID.
        answers: [
          [oldTeamList, { entries: [renamedTeam] }],
          [`/organizations/123/team/456/memberships/${oldLogin}`, "active"],
          [pageOne, { entries: [{ id: otherSubject, login: oldLogin, role: "member" }] }],
        ],
        expectedPaths: [pageOne],
        reason: "membership",
        auditCode: "MEMBERSHIP_REQUIRED",
        login: oldLogin,
      },
      {
        name: "a pending managed user absent from the active roster cannot start a session",
        answers: [
          [oldTeamList, { entries: [renamedTeam] }],
          [`/organizations/123/team/456/memberships/${managedLogin}`, "pending"],
          [pageOne, { entries: [{ id: otherSubject, login: "another-active-user" }] }],
        ],
        expectedPaths: [pageOne],
        reason: "membership",
        auditCode: "MEMBERSHIP_REQUIRED",
      },
      {
        name: "only the roster for the exact configured organization and team can admit a member",
        answers: [
          [
            "/organizations/123/team/457/members?per_page=30&page=1",
            { entries: [{ id: memberSubject }] },
          ],
          [
            "/organizations/124/team/456/members?per_page=30&page=1",
            { entries: [{ id: memberSubject }] },
          ],
          [pageOne, { entries: [] }],
        ],
        expectedPaths: [pageOne],
        reason: "membership",
        auditCode: "MEMBERSHIP_REQUIRED",
      },
      {
        name: "a full last roster page without a next link is a definite denial",
        answers: fullRoster(false),
        expectedPaths: pages,
        reason: "membership",
        auditCode: "MEMBERSHIP_REQUIRED",
      },
      {
        name: "a next link at the scan limit is unavailability",
        answers: fullRoster(true),
        expectedPaths: pages,
        reason: "membership-unavailable",
        auditCode: "MEMBERSHIP_UNAVAILABLE",
      },
      {
        name: "a malformed member ID is unavailability",
        answers: [[pageOne, { entries: [{ id: "0001" }] }]],
        expectedPaths: [pageOne],
        reason: "membership-unavailable",
        auditCode: "MEMBERSHIP_UNAVAILABLE",
      },
      {
        name: "a roster refused to the user token is unavailability",
        answers: [[pageOne, 403]],
        expectedPaths: [pageOne],
        reason: "membership-unavailable",
        auditCode: "MEMBERSHIP_UNAVAILABLE",
      },
      {
        name: "a verified team member cannot sign in without an attached account",
        answers: [[pageOne, { entries: [{ id: otherSubject }] }]],
        expectedPaths: [pageOne],
        auditCode: "EXTERNAL_IDENTITY_REJECTED",
        subject: otherSubject,
        login: "unattached-account",
      },
    ];
    for (const {
      name,
      answers,
      expectedPaths,
      reason,
      auditCode,
      subject = memberSubject,
      login = managedLogin,
    } of scenarios) {
      await t.test(name, async () => {
        const before = await authRowCounts(pool);
        const { callback, paths, attemptId } = await signIn(new Map(answers), subject, login);
        const reasonParameter = reason === undefined ? "" : `&authReason=${reason}`;
        assert.equal(callback.headers.location, `/console/?authError=github${reasonParameter}`);
        assert.equal(callback.headers["set-cookie"], undefined);
        assert.deepEqual(await authRowCounts(pool), before);
        assert.deepEqual(paths, ["/login/oauth/access_token", "/user", ...expectedPaths]);
        const events = await state.transact((unit) => unit.audit.list());
        const event = events.find((entry) => entry.details?.attemptId === attemptId);
        assert.equal(event?.reasonCode, auditCode);
        assert.equal(event?.details?.subject, String(subject));
        assert.equal(event?.details?.login, login);
      });
    }
  },
);
