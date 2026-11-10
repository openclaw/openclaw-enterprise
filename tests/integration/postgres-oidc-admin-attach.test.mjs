import assert from "node:assert/strict";
import test from "node:test";
import { assertApiError } from "../helpers/api-error.mjs";
import {
  accountPrincipalId,
  assertConsoleSignIn,
  changeAccount,
  clientAddresses,
  consoleOrigin as origin,
  createAccount,
  currentSession,
  oidcSignIn,
  oidcUpgradeSettings,
  passwordSignIn,
  readAccount,
  signedInHeaders,
} from "../helpers/production-sign-in.mjs";
import { injectLocalhost } from "../helpers/inject-json.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { waitForLockWaiter } from "../helpers/postgres-lock-waits.mjs";
import { preparePostgresSignInInstallation } from "../helpers/postgres-sign-in-installation.mjs";

const password = "attach-member-password";
const adminSubject = "9100001";
const secondSubject = "9100002";

// After the documented OIDC upgrade, Installation administrators attach their own
// OIDC identities and manage other accounts' identities, all without contacting OIDC.
test(
  "Installation administrators attach, detach and re-attach OIDC identities and disable accounts",
  requiresPostgres,
  async (t) => {
    let app;
    const { pool, state, oidc, onboard, composeApp } = await preparePostgresSignInInstallation(
      t,
      () => [app],
      {
        oidc: true,
        email: "attach-recovery@example.test",
        password,
        secrets: {
          "occ-auth/secret": "attach-admin-auth-test-secret-at-least-32-bytes",
          "occ-oidc-login/client-id": "attach-client-id",
          "occ-oidc-login/client-secret": "attach-client-secret",
        },
      },
    );
    const address = clientAddresses();
    // Password onboarding on the default install: a second administrator and a reader.
    const {
      admin,
      roles,
      accounts: { second, member },
    } = await onboard({
      remoteAddress: address(),
      accounts: {
        second: { email: "attach-second@example.test", role: "admin" },
        member: { email: "attach-member@example.test" },
      },
    });
    let adminHeaders;
    app = await composeApp(oidcUpgradeSettings(admin.id));
    const attach = (headers, userId, subject, expectedVersion) =>
      injectLocalhost(app, "POST", `/api/auth/accounts/${userId}/providers/oidc`, {
        headers,
        body: { subject, expectedVersion },
      });
    const change = (userId, operation, expectedVersion) =>
      changeAccount(app, adminHeaders, userId, operation, expectedVersion);
    async function assertOIDCSignIn(subject, userId) {
      const { callback } = await oidcSignIn(
        app,
        origin,
        oidc,
        { subject: String(subject) },
        address(),
      );
      return assertConsoleSignIn(app, callback, userId);
    }
    async function assertOIDCRefused(subject, consoleReason) {
      const { callback } = await oidcSignIn(
        app,
        origin,
        oidc,
        { subject: String(subject) },
        address(),
      );
      assert.equal(
        callback.headers.location,
        consoleReason === undefined
          ? "/console/?authError=oidc"
          : `/console/?authError=oidc&authReason=${consoleReason}`,
      );
      assert.equal(callback.headers["set-cookie"], undefined);
    }

    await t.test("the recovery administrator attaches their own OIDC identity", async () => {
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
      const requestsBefore = oidc.requests;
      const attached = await attach(adminHeaders, admin.id, adminSubject, before.version);
      assert.equal(attached.statusCode, 200, attached.body);
      assert.equal(oidc.requests, requestsBefore, "attaching never contacts OIDC");
      assert.equal(
        await currentSession(app, adminHeaders.cookie),
        null,
        "attaching ends the account's existing sessions, including the actor's own",
      );
      const oidcCookie = await assertOIDCSignIn(adminSubject, admin.id);
      const after = await readAccount(app, { cookie: oidcCookie, origin }, admin.id);
      assert.equal(after.version, before.version + 1);
      assert.deepEqual(
        after.methods.filter(({ providerId }) => providerId !== "credential").map((m) => m.subject),
        [adminSubject],
      );
      // The recovery password keeps working next to the OIDC identity.
      adminHeaders = await signedInHeaders(app, origin, admin, address());
    });

    let secondOIDCCookie;
    await t.test(
      "a second administrator attaches their own identity; taken and unauthorized attaches are refused",
      async () => {
        const secondHeaders = await signedInHeaders(app, origin, second, address());
        const own = await readAccount(app, secondHeaders, second.id);
        const attached = await attach(secondHeaders, second.id, secondSubject, own.version);
        assert.equal(attached.statusCode, 200, attached.body);
        assert.equal(await currentSession(app, secondHeaders.cookie), null);
        secondOIDCCookie = await assertOIDCSignIn(secondSubject, second.id);
        // A OIDC session carries the account's Installation authority.
        assert.equal(
          (
            await injectLocalhost(app, "GET", "/api/auth/recovery", {
              session: { cookie: secondOIDCCookie, origin },
            })
          ).json().data.userId,
          admin.id,
        );

        const memberAccount = await readAccount(app, adminHeaders, member.id);
        const taken = await attach(adminHeaders, member.id, adminSubject, memberAccount.version);
        // One OIDC identity signs in to one account. The conflict is named: the caller is an
        // Installation administrator, who can already list every account's sign-in methods.
        assert.equal(taken.statusCode, 409, "one OIDC identity signs in to one account");
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
        await assertOIDCRefused("9100003");
      },
    );

    await t.test(
      "an administrator detaches and re-attaches another account's identity",
      async () => {
        const account = await readAccount(app, adminHeaders, second.id);
        const credential = account.methods.find(({ providerId }) => providerId === "credential");
        const external = account.methods.find(({ providerId }) => providerId !== "credential");
        const detach = (methodId, version) =>
          change(second.id, `methods/${methodId}/detach`, version);
        assert.equal(
          (await detach(credential.methodId, account.version)).statusCode,
          409,
          "the password is not an external identity",
        );
        assert.equal(
          (await detach(external.methodId, account.version - 1)).statusCode,
          409,
          "a stale version is refused",
        );
        const detached = await detach(external.methodId, account.version);
        assert.equal(detached.statusCode, 200, detached.body);
        assert.equal(await currentSession(app, secondOIDCCookie), null, "its sessions end");
        await assertOIDCRefused(secondSubject);
        const passwordAfterDetach = await passwordSignIn(app, origin, second, address());
        assert.equal(passwordAfterDetach.statusCode, 200, passwordAfterDetach.body);

        const reattached = await attach(
          adminHeaders,
          second.id,
          secondSubject,
          (await readAccount(app, adminHeaders, second.id)).version,
        );
        assert.equal(reattached.statusCode, 200, reattached.body);
        secondOIDCCookie = await assertOIDCSignIn(secondSubject, second.id);
      },
    );

    await t.test("disable ends every sign-in method; enable restores both", async () => {
      const recoveryAccount = await readAccount(app, adminHeaders, admin.id);
      assert.equal(
        (await change(admin.id, "disable", recoveryAccount.version)).statusCode,
        409,
        "the recovery account cannot be disabled",
      );
      const account = await readAccount(app, adminHeaders, second.id);
      const disabled = await change(second.id, "disable", account.version);
      assert.equal(disabled.statusCode, 200, disabled.body);
      assert.equal(await currentSession(app, secondOIDCCookie), null);
      assert.equal((await passwordSignIn(app, origin, second, address())).statusCode, 401);
      // The attached OIDC identity is told its account is disabled; the password is not.
      await assertOIDCRefused(secondSubject, "account-disabled");

      const disabledAccount = await readAccount(app, adminHeaders, second.id);
      assert.equal(disabledAccount.disabled, true);
      // A disabled target is a conflict with its state, not an unknown account.
      for (const refused of [
        await attach(adminHeaders, second.id, "424242", disabledAccount.version),
        await injectLocalhost(app, "POST", "/api/auth/recovery", {
          session: adminHeaders,
          body: {
            userId: second.id,
            expectedCurrentUserId: admin.id,
            expectedVersion: disabledAccount.version,
          },
        }),
      ]) {
        assertApiError(refused, 409, "RESOURCE_CONFLICT");
      }
      assert.deepEqual(await readAccount(app, adminHeaders, second.id), disabledAccount);
      assert.equal(
        (await change(second.id, "enable", disabledAccount.version - 1)).statusCode,
        409,
      );
      const enabled = await change(second.id, "enable", disabledAccount.version);
      assert.equal(enabled.statusCode, 200, enabled.body);
      assert.equal((await passwordSignIn(app, origin, second, address())).statusCode, 200);
      await assertOIDCSignIn(secondSubject, second.id);
    });

    await t.test("every change is audited to the acting administrator", async () => {
      const [adminPrincipal, secondPrincipal] = [
        await accountPrincipalId(pool, admin.id),
        await accountPrincipalId(pool, second.id),
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
            `/api/auth/accounts/${admin.id}/providers/oidc`,
            { subject: "9100005", expectedVersion: version },
          ],
          [
            "POST",
            `/api/auth/accounts/${member.id}/providers/oidc`,
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
          assertApiError(refused, 403, "FORBIDDEN", `${method} ${url}`);
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
        await assertOIDCRefused("9100005");
      },
    );

    await t.test(
      "concurrent OIDC attaches return retryable contention, then an identity conflict",
      async () => {
        const createReader = (email) =>
          createAccount(app, adminHeaders, { email, password, roleId: roles.reader.id });
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
        // Hold the first attach at the unique identity insert while it retains its
        // authorization fence. A second administrator must retry rather than queue behind it.
        const blocker = await pool.connect();
        let firstAttach;
        try {
          await blocker.query("BEGIN");
          const blockerPid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
          await blocker.query(
            `INSERT INTO occ.account (id, account_id, provider_id, user_id, created_at, updated_at, identity_only)
             VALUES ('race-blocker', $1, $2, $3, clock_timestamp(), clock_timestamp(), true)`,
            [racedSubject, providerId, bystander.id],
          );
          firstAttach = Promise.resolve(
            attach(adminHeaders, member.id, racedSubject, before[0].version),
          );
          await waitForLockWaiter(
            pool,
            blockerPid,
            "the first attach to reach the identity insert",
            {
              queryLike: "INSERT INTO occ.account %",
              timeoutMs: 10_000,
            },
          );
          const contended = await attach(secondHeaders, third.id, racedSubject, before[1].version);
          assertApiError(contended, 503, "DEPENDENCY_UNAVAILABLE");
        } finally {
          await blocker.query("ROLLBACK");
          blocker.release();
        }
        const attached = await firstAttach;
        assert.equal(attached.statusCode, 200, attached.body);
        // Once contention clears, the retry must observe the identity's committed owner.
        const conflict = await attach(secondHeaders, third.id, racedSubject, before[1].version);
        assert.equal(conflict.statusCode, 409, conflict.body);
        assert.deepEqual(conflict.json().error, {
          code: "RESOURCE_CONFLICT",
          message: "The external identity is already assigned.",
        });
        // The losing account is untouched: same version, no identity, sessions intact.
        assert.deepEqual(await readAccount(app, adminHeaders, third.id), before[1]);
        assert.ok(await currentSession(app, targetCookies[1]));
        assert.equal(await currentSession(app, targetCookies[0]), null);
        const owners = await pool.query(
          "SELECT user_id FROM occ.account WHERE provider_id = $1 AND account_id = $2",
          [providerId, racedSubject],
        );
        assert.deepEqual(owners.rows, [{ user_id: member.id }]);
        const raceAudits = (await state.transact((unit) => unit.audit.list())).filter(
          ({ action, details }) =>
            action === "authentication.method.attach" &&
            targets.some(({ id }) => id === details.userId),
        );
        assert.deepEqual(
          raceAudits.map(({ actorId, details }) => [actorId, details.userId]),
          [[await accountPrincipalId(pool, admin.id), member.id]],
        );
        await assertOIDCSignIn(racedSubject, member.id);
      },
    );
  },
);
