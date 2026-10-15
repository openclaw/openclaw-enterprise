import assert from "node:assert/strict";
import test from "node:test";
import {
  assertConsoleSignIn,
  clientAddresses,
  composeProductionSignIn,
  consoleOrigin as origin,
  currentSession,
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

const adminEmail = "attach-recovery@example.test";
const password = "attach-member-password";
const authSecret = "attach-admin-auth-test-secret-at-least-32-bytes";
const secrets = {
  "occ-auth/secret": authSecret,
  "occ-github-login/client-id": "attach-client-id",
  "occ-github-login/client-secret": "attach-client-secret",
};
const adminSubject = "9100001";
const secondSubject = "9100002";

// After the documented GitHub upgrade, Installation administrators attach their own
// GitHub identities and manage other accounts' identities, all without contacting GitHub.
test(
  "Installation administrators attach, detach and re-attach GitHub identities and disable accounts",
  requiresPostgres,
  async (t) => {
    let app;
    const { pool, state } = postgresSignInState(t, () => [app]);
    const github = await startFakeGitHub(t);
    const address = clientAddresses();
    // Password onboarding on the default install: a second administrator and a reader.
    const {
      admin,
      roles,
      accounts: { second, member },
    } = await onboardPasswordAccounts(t, {
      databaseUrl,
      state,
      pool,
      email: adminEmail,
      authSecret,
      secrets,
      password,
      remoteAddress: address(),
      accounts: {
        second: { email: "attach-second@example.test", role: "admin" },
        member: { email: "attach-member@example.test" },
      },
    });
    let adminHeaders;
    app = await composeProductionSignIn(t, {
      databaseUrl,
      settings: githubUpgradeSettings(admin.id),
      secrets,
    });
    const attach = (headers, userId, subject, expectedVersion) =>
      app.inject({
        method: "POST",
        url: `/api/auth/accounts/${userId}/providers/github`,
        headers,
        payload: { subject, expectedVersion },
      });
    const change = (headers, path, expectedVersion) =>
      app.inject({ method: "POST", url: path, headers, payload: { expectedVersion } });
    async function assertGitHubSignIn(subject, userId) {
      const { callback } = await githubSignIn(app, origin, subject, address());
      return assertConsoleSignIn(app, callback, userId);
    }
    async function assertGitHubRefused(subject, consoleReason) {
      const { callback } = await githubSignIn(app, origin, subject, address());
      assert.equal(
        callback.headers.location,
        consoleReason === undefined
          ? "/console/?authError=github"
          : `/console/?authError=github&authReason=${consoleReason}`,
      );
      assert.equal(callback.headers["set-cookie"], undefined);
    }

    await t.test("the recovery administrator attaches their own GitHub identity", async () => {
      adminHeaders = await signedInHeaders(app, origin, admin, address());
      const before = await readAccount(app, adminHeaders, admin.id);
      assert.equal(before.methods.length, 1, "only the password before attaching");
      assert.equal(
        (await attach({ cookie: adminHeaders.cookie }, admin.id, adminSubject, before.version))
          .statusCode,
        403,
        "attaching needs the exact Origin",
      );
      assert.equal(
        (
          await attach(
            { ...adminHeaders, origin: "https://evil.example.test" },
            admin.id,
            adminSubject,
            before.version,
          )
        ).statusCode,
        403,
      );
      const requestsBefore = github.requests;
      const attached = await attach(adminHeaders, admin.id, adminSubject, before.version);
      assert.equal(attached.statusCode, 200, attached.body);
      assert.equal(github.requests, requestsBefore, "attaching never contacts GitHub");
      assert.equal(
        await currentSession(app, adminHeaders.cookie),
        null,
        "attaching ends the account's existing sessions, including the actor's own",
      );
      const githubCookie = await assertGitHubSignIn(adminSubject, admin.id);
      const after = await readAccount(app, { cookie: githubCookie, origin }, admin.id);
      assert.equal(after.version, before.version + 1);
      assert.deepEqual(
        after.methods.filter(({ providerId }) => providerId !== "credential").map((m) => m.subject),
        [adminSubject],
      );
      // The recovery password keeps working next to the GitHub identity.
      adminHeaders = await signedInHeaders(app, origin, admin, address());
    });

    let secondGitHubCookie;
    await t.test(
      "a second administrator attaches their own identity; taken and unauthorized attaches are refused",
      async () => {
        const secondHeaders = await signedInHeaders(app, origin, second, address());
        const own = await readAccount(app, secondHeaders, second.id);
        const attached = await attach(secondHeaders, second.id, secondSubject, own.version);
        assert.equal(attached.statusCode, 200, attached.body);
        assert.equal(await currentSession(app, secondHeaders.cookie), null);
        secondGitHubCookie = await assertGitHubSignIn(secondSubject, second.id);
        // A GitHub session carries the account's Installation authority.
        assert.equal(
          (
            await app.inject({
              url: "/api/auth/recovery",
              headers: { cookie: secondGitHubCookie, origin },
            })
          ).json().data.userId,
          admin.id,
        );

        const memberAccount = await readAccount(app, adminHeaders, member.id);
        const taken = await attach(adminHeaders, member.id, adminSubject, memberAccount.version);
        // One GitHub identity signs in to one account. The conflict is named: the caller is an
        // Installation administrator, who can already list every account's sign-in methods.
        assert.equal(taken.statusCode, 409, "one GitHub identity signs in to one account");
        assert.deepEqual(taken.json().error, {
          code: "RESOURCE_CONFLICT",
          message: "The external identity is already assigned.",
        });
        const memberHeaders = await signedInHeaders(app, origin, member, address());
        const unauthorized = await attach(
          memberHeaders,
          member.id,
          "9100003",
          memberAccount.version,
        );
        assert.equal(unauthorized.statusCode, 403, "a reader cannot attach, even to itself");
        assert.deepEqual(await readAccount(app, adminHeaders, member.id), memberAccount);
        await assertGitHubRefused("9100003");
      },
    );

    await t.test(
      "an administrator detaches and re-attaches another account's identity",
      async () => {
        const account = await readAccount(app, adminHeaders, second.id);
        const credential = account.methods.find(({ providerId }) => providerId === "credential");
        const external = account.methods.find(({ providerId }) => providerId !== "credential");
        const detachPath = (methodId) =>
          `/api/auth/accounts/${second.id}/methods/${methodId}/detach`;
        assert.equal(
          (await change(adminHeaders, detachPath(credential.methodId), account.version)).statusCode,
          409,
          "the password is not an external identity",
        );
        assert.equal(
          (await change(adminHeaders, detachPath(external.methodId), account.version - 1))
            .statusCode,
          409,
          "a stale version is refused",
        );
        const detached = await change(adminHeaders, detachPath(external.methodId), account.version);
        assert.equal(detached.statusCode, 200, detached.body);
        assert.equal(await currentSession(app, secondGitHubCookie), null, "its sessions end");
        await assertGitHubRefused(secondSubject);
        const passwordAfterDetach = await passwordSignIn(app, origin, second, address());
        assert.equal(passwordAfterDetach.statusCode, 200, passwordAfterDetach.body);

        const reattached = await attach(
          adminHeaders,
          second.id,
          secondSubject,
          (await readAccount(app, adminHeaders, second.id)).version,
        );
        assert.equal(reattached.statusCode, 200, reattached.body);
        secondGitHubCookie = await assertGitHubSignIn(secondSubject, second.id);
      },
    );

    await t.test("disable ends every sign-in method; enable restores both", async () => {
      const recoveryAccount = await readAccount(app, adminHeaders, admin.id);
      assert.equal(
        (
          await change(
            adminHeaders,
            `/api/auth/accounts/${admin.id}/disable`,
            recoveryAccount.version,
          )
        ).statusCode,
        409,
        "the recovery account cannot be disabled",
      );
      const account = await readAccount(app, adminHeaders, second.id);
      const disabled = await change(
        adminHeaders,
        `/api/auth/accounts/${second.id}/disable`,
        account.version,
      );
      assert.equal(disabled.statusCode, 200, disabled.body);
      assert.equal(await currentSession(app, secondGitHubCookie), null);
      assert.equal((await passwordSignIn(app, origin, second, address())).statusCode, 401);
      // The attached GitHub identity is told its account is disabled; the password is not.
      await assertGitHubRefused(secondSubject, "account-disabled");

      const disabledAccount = await readAccount(app, adminHeaders, second.id);
      assert.equal(disabledAccount.disabled, true);
      // A disabled target is a conflict with its state, not an unknown account.
      for (const refused of [
        await attach(adminHeaders, second.id, "424242", disabledAccount.version),
        await app.inject({
          method: "POST",
          url: "/api/auth/recovery",
          headers: adminHeaders,
          payload: {
            userId: second.id,
            expectedCurrentUserId: admin.id,
            expectedVersion: disabledAccount.version,
          },
        }),
      ]) {
        assert.equal(refused.statusCode, 409, refused.body);
        assert.equal(refused.json().error.code, "RESOURCE_CONFLICT");
      }
      assert.deepEqual(await readAccount(app, adminHeaders, second.id), disabledAccount);
      assert.equal(
        (
          await change(
            adminHeaders,
            `/api/auth/accounts/${second.id}/enable`,
            disabledAccount.version - 1,
          )
        ).statusCode,
        409,
      );
      const enabled = await change(
        adminHeaders,
        `/api/auth/accounts/${second.id}/enable`,
        disabledAccount.version,
      );
      assert.equal(enabled.statusCode, 200, enabled.body);
      assert.equal((await passwordSignIn(app, origin, second, address())).statusCode, 200);
      await assertGitHubSignIn(secondSubject, second.id);
    });

    await t.test("every change is audited to the acting administrator", async () => {
      const principalOf = async (userId) =>
        (
          await pool.query(
            "SELECT principal_id FROM occ.human_authentication_accounts WHERE user_id = $1",
            [userId],
          )
        ).rows[0].principal_id;
      const [adminPrincipal, secondPrincipal] = [
        await principalOf(admin.id),
        await principalOf(second.id),
      ];
      const audits = (await state.transact((unit) => unit.audit.list()))
        .filter(({ action }) =>
          /^authentication\.(method\.(attach|detach)|account\.(disable|enable))$/.test(action),
        )
        .map(({ action, actorId, details }) => [action, actorId, details.userId]);
      assert.deepEqual(audits, [
        ["authentication.method.attach", adminPrincipal, admin.id],
        ["authentication.method.attach", secondPrincipal, second.id],
        ["authentication.method.detach", adminPrincipal, second.id],
        ["authentication.method.attach", adminPrincipal, second.id],
        ["authentication.account.disable", adminPrincipal, second.id],
        ["authentication.account.enable", adminPrincipal, second.id],
      ]);
    });

    await t.test(
      "a current session without Installation administer is refused by every account route",
      async () => {
        const memberHeaders = await signedInHeaders(app, origin, member, address());
        const adminAccount = await readAccount(app, adminHeaders, admin.id);
        const memberAccount = await readAccount(app, adminHeaders, member.id);
        const external = adminAccount.methods.find(({ providerId }) => providerId !== "credential");
        assert.ok(external);
        const users = async () =>
          (await pool.query('SELECT count(*)::int AS count FROM occ."user"')).rows[0].count;
        const usersBefore = await users();
        const recoveryBefore = (
          await app.inject({ url: "/api/auth/recovery", headers: adminHeaders })
        ).json().data;
        const version = adminAccount.version;
        const requests = [
          ["GET", `/api/auth/accounts/${admin.id}`],
          ["GET", `/api/auth/accounts/${member.id}`],
          [
            "POST",
            "/api/auth/accounts",
            { email: "refused@example.test", password, roleId: roles.admin.id },
          ],
          [
            "POST",
            `/api/auth/accounts/${admin.id}/providers/github`,
            { subject: "9100005", expectedVersion: version },
          ],
          [
            "POST",
            `/api/auth/accounts/${member.id}/providers/github`,
            { subject: "9100005", expectedVersion: memberAccount.version },
          ],
          [
            "POST",
            `/api/auth/accounts/${admin.id}/providers/google`,
            { subject: "refused-google", expectedVersion: version },
          ],
          [
            "POST",
            `/api/auth/accounts/${admin.id}/methods/${external.methodId}/detach`,
            { expectedVersion: version },
          ],
          ["POST", `/api/auth/accounts/${admin.id}/disable`, { expectedVersion: version }],
          ["POST", `/api/auth/accounts/${admin.id}/enable`, { expectedVersion: version }],
          ["POST", `/api/auth/accounts/${admin.id}/revoke`, { expectedVersion: version }],
          ["POST", `/api/auth/accounts/${member.id}/enrol`],
          ["GET", "/api/auth/recovery"],
          [
            "POST",
            "/api/auth/recovery",
            {
              userId: member.id,
              expectedCurrentUserId: admin.id,
              expectedVersion: memberAccount.version,
            },
          ],
        ];
        for (const [method, url, payload] of requests) {
          const refused = await app.inject({ method, url, headers: memberHeaders, payload });
          assert.equal(refused.statusCode, 403, `${method} ${url}: ${refused.body}`);
          assert.equal(refused.json().error.code, "FORBIDDEN", `${method} ${url}`);
        }
        assert.deepEqual(await readAccount(app, adminHeaders, admin.id), adminAccount);
        assert.deepEqual(await readAccount(app, adminHeaders, member.id), memberAccount);
        assert.equal(await users(), usersBefore);
        assert.deepEqual(
          (await app.inject({ url: "/api/auth/recovery", headers: adminHeaders })).json().data,
          recoveryBefore,
        );
        assert.ok(
          await currentSession(app, adminHeaders.cookie),
          "the administrator stays signed in",
        );
        assert.ok(await currentSession(app, memberHeaders.cookie), "a refusal changes no session");
        await assertGitHubRefused("9100005");
      },
    );

    await t.test(
      "two administrators attaching one GitHub identity to two accounts at once: one wins, one conflicts",
      async () => {
        const createReader = async (email) => {
          const created = await app.inject({
            method: "POST",
            url: "/api/auth/accounts",
            headers: adminHeaders,
            payload: { email, password, roleId: roles.reader.id },
          });
          assert.equal(created.statusCode, 201, created.body);
          return { id: created.json().data.id, email, password };
        };
        const third = await createReader("attach-third@example.test");
        // The blocking row's owner is locked by neither attach: its foreign key share
        // lock would otherwise hold an actor's own row lock instead of the identity insert.
        const bystander = await createReader("attach-bystander@example.test");
        const secondHeaders = await signedInHeaders(app, origin, second, address());
        const racedSubject = "9100004";
        const { providerId } = (await readAccount(app, adminHeaders, admin.id)).methods.find(
          (method) => method.subject === adminSubject,
        );
        const targets = [member, third];
        const before = await Promise.all(
          targets.map((target) => readAccount(app, adminHeaders, target.id)),
        );
        const targetCookies = await Promise.all(
          targets.map(
            async (target) => (await signedInHeaders(app, origin, target, address())).cookie,
          ),
        );
        // An uncommitted row for the same identity hides from both existence checks and
        // holds both inserts on the unique index, so the two attaches really overlap.
        const blocker = await pool.connect();
        let attaches;
        try {
          await blocker.query("BEGIN");
          const blockerPid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
          await blocker.query(
            `INSERT INTO occ.account (id, account_id, provider_id, user_id, created_at, updated_at, identity_only)
             VALUES ('race-blocker', $1, $2, $3, clock_timestamp(), clock_timestamp(), true)`,
            [racedSubject, providerId, bystander.id],
          );
          attaches = Promise.all([
            attach(adminHeaders, member.id, racedSubject, before[0].version),
            attach(secondHeaders, third.id, racedSubject, before[1].version),
          ]);
          const deadline = performance.now() + 10_000;
          for (;;) {
            const { rows } = await pool.query(
              `SELECT count(*)::int AS count FROM pg_stat_activity
               WHERE $1 = ANY(pg_blocking_pids(pid)) AND query LIKE 'INSERT INTO occ.account %'`,
              [blockerPid],
            );
            if (rows[0].count === 2) {
              break;
            }
            assert.ok(performance.now() < deadline, "both attaches reach the identity insert");
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        } finally {
          await blocker.query("ROLLBACK");
          blocker.release();
        }
        const responses = await attaches;
        const winner = responses.findIndex(({ statusCode }) => statusCode === 200);
        assert.notEqual(winner, -1, responses.map(({ body }) => body).join("\n"));
        const loser = 1 - winner;
        assert.equal(responses[loser].statusCode, 409, responses[loser].body);
        assert.deepEqual(responses[loser].json().error, {
          code: "RESOURCE_CONFLICT",
          message: "The external identity is already assigned.",
        });
        // The losing account is untouched: same version, no identity, sessions intact.
        assert.deepEqual(await readAccount(app, adminHeaders, targets[loser].id), before[loser]);
        assert.ok(await currentSession(app, targetCookies[loser]));
        assert.equal(await currentSession(app, targetCookies[winner]), null);
        const owners = await pool.query(
          "SELECT user_id FROM occ.account WHERE provider_id = $1 AND account_id = $2",
          [providerId, racedSubject],
        );
        assert.deepEqual(owners.rows, [{ user_id: targets[winner].id }]);
        const raceAudits = (await state.transact((unit) => unit.audit.list())).filter(
          ({ action, details }) =>
            action === "authentication.method.attach" &&
            targets.some(({ id }) => id === details.userId),
        );
        assert.deepEqual(
          raceAudits.map(({ details }) => details.userId),
          [targets[winner].id],
        );
        await assertGitHubSignIn(racedSubject, targets[winner].id);
      },
    );
  },
);
