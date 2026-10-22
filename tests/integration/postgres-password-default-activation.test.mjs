import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createPostgresControllerAuth } from "../helpers/password-hasher.mjs";
import {
  composeProductionSignIn,
  consoleOrigin as origin,
  createAccount,
  currentSession,
  defaultInstallSettings,
  githubUpgradeSettings,
  memoryLogger,
  onboardPasswordAccounts,
  passwordSignIn,
  postgresSignInState,
  signedInHeaders,
} from "../helpers/production-sign-in.mjs";
import { cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";
import { waitForLockWaiter } from "../helpers/postgres-lock-waits.mjs";

const adminEmail = "activation-admin@example.test";
const password = "activation-member-password";
const authSecret = "activation-default-auth-test-secret-at-least-32-bytes";
const secrets = {
  "occ-auth/secret": authSecret,
  "occ-github-login/client-id": "activation-client-id",
  "occ-github-login/client-secret": "activation-client-secret",
};

// Password onboarding is the default: accounts made before GitHub is enabled keep
// signing in after the two-phase upgrade in production-installation.md, and
// administrators keep creating password accounts afterwards.
test(
  "password accounts from before GitHub activation keep signing in, and creation continues after it",
  requiresPostgres,
  async (t) => {
    let app;
    const { pool, state } = postgresSignInState(t, () => [app]);
    // Phase 0: the default install, no GitHub configuration.
    const {
      admin,
      roles: { reader: readerRole },
      accounts: { member },
    } = await onboardPasswordAccounts(t, {
      databaseUrl,
      state,
      pool,
      email: adminEmail,
      authSecret,
      secrets,
      password,
      accounts: { member: { email: "activation-provisioned@example.test" } },
    });
    const installation = await state.loadInstallation();
    app = await composeProductionSignIn(t, {
      databaseUrl,
      settings: defaultInstallSettings,
      secrets,
    });
    let adminHeaders = await signedInHeaders(app, origin, admin);
    // Accounts an older controller wrote: one with its Principal, one without.
    const olderController = await createPostgresControllerAuth({
      mode: "production",
      installationId: installation.id,
      baseURL: origin,
      secret: authSecret,
      pool,
    });
    const older = await olderController.createAccount({
      email: "activation-older@example.test",
      password,
    });
    await state.appendNativeIAMPrincipal(
      olderController.principalSeed(older, { roleId: readerRole.id }),
    );
    const unprovisioned = await olderController.createAccount({
      email: "activation-unprovisioned@example.test",
      password,
    });
    for (const account of [member, older, unprovisioned]) {
      assert.equal(
        (await passwordSignIn(app, origin, { email: account.email, password })).statusCode,
        200,
        `${account.email} signs in before activation`,
      );
    }
    const preActivationCookie = adminHeaders.cookie;
    await app.close();
    app = undefined;

    // Phase 1: helm upgrade with auth.github and the recovery user from GET /api/auth/session.
    const log = memoryLogger();
    app = await composeProductionSignIn(t, {
      databaseUrl,
      settings: githubUpgradeSettings(admin.id),
      secrets,
      logger: log.logger,
    });
    assert.deepEqual((await app.inject({ url: "/api/auth/providers" })).json().data, {
      github: true,
      google: false,
      oidc: false,
      password: true,
      sessionBinding: true,
    });

    await t.test("the guarded profile warns at startup when no trusted proxy is set", () => {
      const warnings = log.events.filter(
        ({ event }) => event === "authentication.sign-in-limit-warning",
      );
      assert.deepEqual(
        warnings.map(({ code, severity }) => ({ code, severity })),
        [{ code: "TRUSTED_PROXY_NOT_CONFIGURED", severity: "WARN" }],
      );
    });

    await t.test("activation enrols qualifying accounts and reports the rest", async () => {
      const warnings = log.events.filter(
        ({ event }) => event === "authentication.activation-warning",
      );
      assert.equal(warnings.length, 1);
      assert.deepEqual(warnings[0].skippedUserIds, [unprovisioned.id]);
      assert.equal(warnings[0].skippedUserCount, 1);
      assert.equal(warnings[0].skippedUserIdsTruncated, false);
      const enrolled = (
        await pool.query("SELECT user_id FROM occ.human_authentication_accounts")
      ).rows
        .map(({ user_id }) => user_id)
        .sort();
      assert.deepEqual(enrolled, [admin.id, member.id, older.id].sort());
      assert.equal(
        (await pool.query("SELECT user_id FROM occ.human_authentication_recovery")).rows[0].user_id,
        admin.id,
      );
      assert.equal(await currentSession(app, preActivationCookie), null, "unbound sessions end");
    });

    await t.test(
      "enrolled accounts keep password sign-in; the skipped one is refused",
      async () => {
        adminHeaders = await signedInHeaders(app, origin, admin);
        for (const account of [member, older]) {
          const response = await passwordSignIn(app, origin, { email: account.email, password });
          assert.equal(response.statusCode, 200, `${account.email}: ${response.body}`);
        }
        const skipped = await passwordSignIn(app, origin, {
          email: unprovisioned.email,
          password,
        });
        assert.equal(skipped.statusCode, 401, "refused like bad credentials");
      },
    );

    await t.test("administrators still create password accounts after activation", async () => {
      const created = await createAccount(app, adminHeaders, {
        email: "activation-after@example.test",
        password,
        roleId: readerRole.id,
      });
      const signedIn = await passwordSignIn(app, origin, created);
      assert.equal(signedIn.statusCode, 200, signedIn.body);
      assert.equal(
        (await currentSession(app, cookieHeaderFromSetCookie(signedIn.headers["set-cookie"]))).user
          .id,
        created.id,
      );
    });

    await t.test("a skipped account signs in once repaired and enrolled online", async () => {
      const enrol = () =>
        app.inject({
          method: "POST",
          url: `/api/auth/accounts/${unprovisioned.id}/enrol`,
          headers: adminHeaders,
        });
      assert.equal((await enrol()).statusCode, 404, "no Principal yet");
      await state.appendNativeIAMPrincipal(
        olderController.principalSeed(unprovisioned, { roleId: readerRole.id }),
      );
      const enrolled = await enrol();
      assert.equal(enrolled.statusCode, 200, enrolled.body);
      assert.equal(enrolled.json().data.created, true);
      const repeated = await enrol();
      assert.equal(repeated.statusCode, 200, repeated.body);
      assert.equal(repeated.json().data.created, false);
      const signedIn = await passwordSignIn(app, origin, { email: unprovisioned.email, password });
      assert.equal(signedIn.statusCode, 200, signedIn.body);
    });

    await t.test("guarded account revocation waits for an authenticated IAM commit", async () => {
      const assigning = await signedInHeaders(app, origin, admin);
      const revoking = await signedInHeaders(app, origin, admin);
      const account = await app.inject({
        url: `/api/auth/accounts/${admin.id}`,
        headers: revoking,
      });
      assert.equal(account.statusCode, 200, account.body);
      const createdNamespace = await app.inject({
        method: "POST",
        url: "/namespaces",
        headers: assigning,
        payload: { name: "Guarded IAM commit" },
      });
      assert.equal(createdNamespace.statusCode, 201, createdNamespace.body);
      const namespaceId = createdNamespace.json().data.id;
      const independentNamespace = await app.inject({
        method: "POST",
        url: "/namespaces",
        headers: revoking,
        payload: { name: "Independent guarded IAM commit" },
      });
      assert.equal(independentNamespace.statusCode, 201, independentNamespace.body);
      const independentId = independentNamespace.json().data.id;
      const blocker = await pool.connect();
      let released = false;
      let policy;
      let settledPolicy;
      let revoke;
      try {
        await blocker.query("BEGIN");
        const {
          rows: [{ pid }],
        } = await blocker.query("SELECT pg_backend_pid() AS pid");
        await blocker.query("SELECT id FROM occ.namespaces WHERE id=$1 FOR UPDATE", [namespaceId]);
        policy = app
          .inject({
            method: "POST",
            url: `/namespaces/${namespaceId}/iam/roles`,
            headers: assigning,
            payload: {
              name: "Guarded commit",
              permissions: [{ action: "read", resourceKind: "agent" }],
            },
          })
          .then((response) => {
            settledPolicy = response;
            return response;
          });
        const protectedPid = await waitForLockWaiter(
          pool,
          pid,
          "the guarded policy transaction waiting for its Namespace",
        );
        // The retained session must not impose authentication's five-second
        // lock limit on an otherwise valid Namespace policy transaction.
        await delay(5_500);
        assert.equal(settledPolicy?.statusCode, undefined, settledPolicy?.body);
        // A different session of the same person can write another Namespace.
        // Both user shares still exclude account/method revocation.
        const independent = await app.inject({
          method: "POST",
          url: `/namespaces/${independentId}/iam/roles`,
          headers: revoking,
          payload: {
            name: "Independent commit",
            permissions: [{ action: "read", resourceKind: "agent" }],
          },
        });
        assert.equal(independent.statusCode, 201, independent.body);
        // The account owner validates method/account versions and locks the same
        // user. Revocation must not invalidate either admitted session mid-commit.
        revoke = app.inject({
          method: "POST",
          url: `/api/auth/accounts/${admin.id}/revoke`,
          headers: revoking,
          payload: { expectedVersion: account.json().data.version },
        });
        await waitForLockWaiter(
          pool,
          protectedPid,
          "guarded account revocation waiting for the policy holder",
        );
        await blocker.query("COMMIT");
        released = true;
        const committed = await policy;
        assert.equal(committed.statusCode, 201, committed.body);
        const revoked = await revoke;
        assert.equal(revoked.statusCode, 200, revoked.body);
        assert.equal(
          (await app.inject({ url: `/namespaces/${namespaceId}/iam/roles`, headers: assigning }))
            .statusCode,
          401,
        );
        adminHeaders = await signedInHeaders(app, origin, admin);
        const removed = await app.inject({
          method: "DELETE",
          url: `/namespaces/${namespaceId}/iam/roles/${committed.json().data.id}`,
          headers: adminHeaders,
        });
        assert.equal(removed.statusCode, 204, removed.body);
        assert.equal(
          (
            await app.inject({
              method: "DELETE",
              url: `/namespaces/${independentId}/iam/roles/${independent.json().data.id}`,
              headers: adminHeaders,
            })
          ).statusCode,
          204,
        );
        t.diagnostic(
          JSON.stringify({
            scenario: "guarded-retention",
            namespaceWaitMs: 5500,
            independentSessionWrite: independent.statusCode,
            policyCommit: committed.statusCode,
            accountRevocation: revoked.statusCode,
          }),
        );
      } finally {
        if (!released) {
          await blocker.query("ROLLBACK");
        }
        blocker.release();
        await Promise.allSettled([policy, revoke]);
      }
    });
  },
);
