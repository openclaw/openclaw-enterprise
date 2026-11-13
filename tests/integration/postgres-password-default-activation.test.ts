import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createPostgresControllerAuth } from "../helpers/password-hasher.mjs";
import {
  consoleOrigin as origin,
  currentSession,
  defaultInstallSettings,
  oidcUpgradeSettings,
  fixtureOidcIssuer,
  memoryLogger,
} from "../helpers/production-sign-in.mjs";
import { cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { waitForLockWaiter } from "../helpers/postgres-lock-waits.mjs";
import { preparePostgresSignInInstallation } from "../helpers/postgres-sign-in-installation.mjs";
import {
  onboarded,
  readAccount,
  type SignInApp,
  changeAccount,
  createAccount,
  passwordSignIn,
  signedInHeaders,
  injectLocalhost,
  recordData,
  record,
  text,
  integer,
  type InjectedResponse,
} from "../helpers/postgres-sign-in-test-boundaries.ts";

const password = "activation-member-password";
const authSecret = "activation-default-auth-test-secret-at-least-32-bytes";
const secrets = {
  "occ-auth/secret": authSecret,
  "occ-oidc-login/client-id": "activation-client-id",
  "occ-oidc-login/client-secret": "activation-client-secret",
};

// Password onboarding is the default: accounts made before OIDC is enabled keep
// signing in after the two-phase upgrade in production-installation.md, and
// administrators keep creating password accounts afterwards.
test(
  "password accounts from before OIDC activation keep signing in, and creation continues after it",
  requiresPostgres,
  async (t) => {
    let app: SignInApp | undefined;
    const { pool, state, onboard, composeApp } = await preparePostgresSignInInstallation(
      t,
      () => [app],
      { email: "activation-admin@example.test", password, secrets, oidc: true },
    );
    // Phase 0: the default install, no OIDC configuration.
    const {
      admin,
      roles: { reader: readerRole },
      accounts: { member },
    } = onboarded(
      await onboard({ accounts: { member: { email: "activation-provisioned@example.test" } } }),
      ["member"],
    );
    const installation = await state.loadInstallation();
    assert.ok(installation);
    app = await composeApp(defaultInstallSettings);
    let adminHeaders = await signedInHeaders(app, origin, admin);
    // Accounts an older controller wrote: one with its Principal, one without.
    const olderController = await createPostgresControllerAuth({
      mode: "production",
      installationId: installation.id,
      baseURL: origin,
      agentDomain: "agents.oce.example.internal",
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

    // Phase 1: helm upgrade with auth.oidc and the recovery user from GET /api/auth/session.
    const log = memoryLogger();
    app = await composeApp(oidcUpgradeSettings(admin.id), { logger: log.logger });
    const activeApp = app;
    assert.deepEqual(
      recordData((await activeApp.inject({ url: "/api/auth/providers" })).json<unknown>()),
      {
        google: false,
        oidc: true,
        oidcSignIn: {
          label: "single sign-on",
          authorizationUrl: fixtureOidcIssuer.authorizationUrl,
        },
        password: true,
        sessionBinding: true,
      },
    );

    await t.test("the guarded profile warns at startup when no trusted proxy is set", () => {
      const warnings = log.events
        .map((entry: unknown) => record(entry))
        .filter(({ event }) => event === "authentication.sign-in-limit-warning");
      assert.deepEqual(
        warnings.map(({ code, severity }) => ({ code, severity })),
        [{ code: "TRUSTED_PROXY_NOT_CONFIGURED", severity: "WARN" }],
      );
    });

    await t.test("activation enrols qualifying accounts and reports the rest", async () => {
      const warnings = log.events
        .map((entry: unknown) => record(entry))
        .filter(({ event }) => event === "authentication.activation-warning");
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0]);
      assert.deepEqual(warnings[0].skippedUserIds, [unprovisioned.id]);
      assert.equal(warnings[0].skippedUserCount, 1);
      assert.equal(warnings[0].skippedUserIdsTruncated, false);
      const enrolled = (
        await pool.query<{ user_id: unknown }>(
          "SELECT user_id FROM occ.human_authentication_accounts",
        )
      ).rows
        .map(({ user_id }) => text(user_id))
        .sort();
      assert.deepEqual(enrolled, [admin.id, member.id, older.id].sort());
      assert.equal(
        (
          await pool.query<{ user_id: unknown }>(
            "SELECT user_id FROM occ.human_authentication_recovery",
          )
        ).rows[0]?.user_id,
        admin.id,
      );
      assert.equal(
        await currentSession(activeApp, preActivationCookie),
        null,
        "unbound sessions end",
      );
    });

    await t.test(
      "enrolled accounts keep password sign-in; the skipped one is refused",
      async () => {
        adminHeaders = await signedInHeaders(activeApp, origin, admin);
        for (const account of [member, older]) {
          const response = await passwordSignIn(activeApp, origin, {
            email: account.email,
            password,
          });
          assert.equal(response.statusCode, 200, `${account.email}: ${response.body}`);
        }
        const skipped = await passwordSignIn(activeApp, origin, {
          email: unprovisioned.email,
          password,
        });
        assert.equal(skipped.statusCode, 401, "refused like bad credentials");
      },
    );

    await t.test("administrators still create password accounts after activation", async () => {
      const created = await createAccount(activeApp, adminHeaders, {
        email: "activation-after@example.test",
        password,
        roleId: readerRole.id,
      });
      const signedIn = await passwordSignIn(activeApp, origin, created);
      assert.equal(signedIn.statusCode, 200, signedIn.body);
      assert.equal(
        record(
          record(
            await currentSession(
              activeApp,
              cookieHeaderFromSetCookie(signedIn.headers["set-cookie"]),
            ),
          ).user,
        ).id,
        created.id,
      );
    });

    await t.test("a skipped account signs in once repaired and enrolled online", async () => {
      const enrol = () =>
        injectLocalhost(activeApp, "POST", `/api/auth/accounts/${unprovisioned.id}/enrol`, {
          session: adminHeaders,
        });
      assert.equal((await enrol()).statusCode, 404, "no Principal yet");
      await state.appendNativeIAMPrincipal(
        olderController.principalSeed(unprovisioned, { roleId: readerRole.id }),
      );
      const enrolled = await enrol();
      assert.equal(enrolled.statusCode, 200, enrolled.body);
      assert.equal(recordData(enrolled.json()).created, true);
      const repeated = await enrol();
      assert.equal(repeated.statusCode, 200, repeated.body);
      assert.equal(recordData(repeated.json()).created, false);
      const signedIn = await passwordSignIn(activeApp, origin, {
        email: unprovisioned.email,
        password,
      });
      assert.equal(signedIn.statusCode, 200, signedIn.body);
    });

    await t.test("guarded account revocation waits for an authenticated IAM commit", async () => {
      const assigning = await signedInHeaders(activeApp, origin, admin);
      const revoking = await signedInHeaders(activeApp, origin, admin);
      const account = await readAccount(activeApp, revoking, admin.id);
      const createdNamespace = await injectLocalhost(activeApp, "POST", "/namespaces", {
        session: assigning,
        body: { name: "Guarded IAM commit" },
      });
      assert.equal(createdNamespace.statusCode, 201, createdNamespace.body);
      const namespaceId = text(recordData(createdNamespace.json()).id);
      const independentNamespace = await injectLocalhost(activeApp, "POST", "/namespaces", {
        session: revoking,
        body: { name: "Independent guarded IAM commit" },
      });
      assert.equal(independentNamespace.statusCode, 201, independentNamespace.body);
      const independentId = text(recordData(independentNamespace.json()).id);
      const blocker = await pool.connect();
      let released = false;
      let policy: Promise<InjectedResponse> | undefined;
      const settledPolicy: { response?: InjectedResponse } = {};
      let revoke: Promise<InjectedResponse> | undefined;
      try {
        await blocker.query("BEGIN");
        const pid = integer(
          (await blocker.query<{ pid: unknown }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid,
        );
        await blocker.query("SELECT id FROM occ.namespaces WHERE id=$1 FOR UPDATE", [namespaceId]);
        policy = injectLocalhost(activeApp, "POST", `/namespaces/${namespaceId}/iam/roles`, {
          session: assigning,
          body: {
            name: "Guarded commit",
            permissions: [{ action: "read", resourceKind: "agent" }],
          },
        }).then((response) => {
          settledPolicy.response = response;
          return response;
        });
        const protectedPid = integer(
          await waitForLockWaiter(
            pool,
            pid,
            "the guarded policy transaction waiting for its Namespace",
          ),
        );
        // The retained session must not impose authentication's five-second
        // lock limit on an otherwise valid Namespace policy transaction.
        await delay(5_500);
        assert.equal(
          settledPolicy.response?.statusCode,
          undefined,
          settledPolicy.response?.body ?? "policy remains blocked",
        );
        // A different session of the same person can write another Namespace.
        // Both user shares still exclude account/method revocation.
        const independent = await activeApp.inject({
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
        revoke = changeAccount(activeApp, revoking, admin.id, "revoke", account.version);
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
          (
            await activeApp.inject({
              url: `/namespaces/${namespaceId}/iam/roles`,
              headers: assigning,
            })
          ).statusCode,
          401,
        );
        adminHeaders = await signedInHeaders(activeApp, origin, admin);
        const removed = await activeApp.inject({
          method: "DELETE",
          url: `/namespaces/${namespaceId}/iam/roles/${text(recordData(committed.json()).id)}`,
          headers: adminHeaders,
        });
        assert.equal(removed.statusCode, 204, removed.body);
        assert.equal(
          (
            await activeApp.inject({
              method: "DELETE",
              url: `/namespaces/${independentId}/iam/roles/${text(recordData(independent.json<unknown>()).id)}`,
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
