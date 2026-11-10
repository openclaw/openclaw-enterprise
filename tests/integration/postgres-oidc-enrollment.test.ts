import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import {
  accountPrincipalId,
  assertConsoleSignIn,
  assertProviderAttached,
  authRowCounts,
  changeAccount,
  clientAddresses,
  consoleOrigin as origin,
  currentSession,
  defaultInstallSettings,
  fakeOidc,
  oidcSignIn,
  oidcUpgradeSettings,
  signedInHeaders,
} from "../helpers/production-sign-in.mjs";
import { cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { preparePostgresSignInInstallation } from "../helpers/postgres-sign-in-installation.mjs";

// Only upstream HTTP and passive Compute are fixtures. The callback, account
// transaction, native IAM, audit, session and Agent operations are production code.
test(
  "OIDC enrollment creates scoped accounts and preserves explicit identity links",
  requiresPostgres,
  async (t) => {
    let app: Awaited<
      ReturnType<Awaited<ReturnType<typeof preparePostgresSignInInstallation>>["composeApp"]>
    >;
    const password = "enrollment-user-password";
    const searchPath = "/api/auth/sharing-recipients/search";
    const clientId = "enrollment-client";
    const clientSecret = "enrollment-client-secret";
    const { pool, state, onboard, composeApp } = await preparePostgresSignInInstallation(
      t,
      () => [app],
      {
        email: "enrollment-recovery@example.test",
        password,
        secrets: {
          "occ-auth/secret": "oidc-enrollment-auth-secret-at-least-32-bytes",
          "occ-oidc-login/client-id": clientId,
          "occ-oidc-login/client-secret": clientSecret,
        },
        oidc: false,
      },
    );
    const idp = fakeOidc(t, { clientId, clientSecret });
    const address = clientAddresses("198.19");
    const { admin, roles, accounts } = (await onboard({
      accounts: {
        existing: { email: "existing-enrollment@example.test" },
        secondAdmin: { email: "second-enrollment-admin@example.test", role: "admin" },
      },
      remoteAddress: address(),
    })) as Awaited<ReturnType<typeof onboard>> & {
      admin: { id: string; email: string; password: string };
      accounts: Record<"existing" | "secondAdmin", { id: string; email: string }>;
    };
    await t.test(
      "password-only recipient search finds a provisioned Installation Principal",
      async () => {
        app = await composeApp(defaultInstallSettings);
        try {
          const headers = await signedInHeaders(app, origin, admin, address());
          const { existing } = accounts;
          const principal = (await state.loadNativeIAMState()).identities.find(
            (identity) => identity.kind === "principal" && identity.subject === existing.id,
          );
          assert.ok(principal);
          const sessionVersion = async () =>
            (
              await pool.query(
                "SELECT id, xmin::text AS version FROM occ.session WHERE user_id = $1 ORDER BY id",
                [admin.id],
              )
            ).rows;
          const before = await sessionVersion();
          assert.ok(before.length > 0);
          const result = await app.inject({
            method: "POST",
            url: searchPath,
            headers,
            payload: { prefix: "existing-enrollment" },
          });
          assert.equal(result.statusCode, 200, result.body);
          assert.equal(result.headers["cache-control"], "no-store");
          assert.deepEqual(
            await sessionVersion(),
            before,
            "search must leave the session row alone",
          );
          assert.deepEqual(result.json().data, [
            {
              principalId: principal.id,
              name: existing.email,
              email: existing.email,
            },
          ]);
          const reader = await signedInHeaders(app, origin, { ...existing, password }, address());
          const denied = await app.inject({
            method: "POST",
            url: searchPath,
            headers: reader,
            payload: { prefix: "existing-enrollment" },
          });
          assert.equal(denied.statusCode, 403, denied.body);
        } finally {
          await app.close();
        }
      },
    );
    const settings = oidcUpgradeSettings(admin.id);
    app = await composeApp(settings);
    let adminHeaders = await signedInHeaders(app, origin, admin, address());
    const namespace = await app.inject({
      method: "POST",
      url: "/namespaces",
      headers: adminHeaders,
      payload: { name: "Enrollment scope" },
    });
    assert.equal(namespace.statusCode, 201, namespace.body);
    const namespaceId = namespace.json().data.id;
    await t.test(
      "recipient search overlaps another administrator and a Namespace IAM write",
      async (lookup) => {
        const secondAdmin = accounts.secondAdmin;
        const secondHeaders = await signedInHeaders(
          app,
          origin,
          { ...secondAdmin, password },
          address(),
        );
        const search = (headers: typeof adminHeaders, prefix: string) =>
          app.inject({ method: "POST", url: searchPath, headers, payload: { prefix } });

        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let beforeSnapshot: (() => Promise<void>) | undefined;
        const query = pg.Client.prototype.query;
        lookup.mock.method(
          pg.Client.prototype,
          "query",
          function (this: pg.Client, sql: unknown, ...args: unknown[]) {
            const result: unknown = Reflect.apply(query, this, [sql, ...args]);
            if (beforeSnapshot && sql === "SET LOCAL statement_timeout = '2s'") {
              const change = beforeSnapshot;
              beforeSnapshot = undefined;
              return Promise.resolve(result).then(async (response) => {
                await change();
                return response;
              });
            }
            if (
              typeof sql === "string" &&
              sql.startsWith("SELECT p.id AS principal_id, u.name,") &&
              Array.isArray(args[0]) &&
              args[0][2] === "existing-enrollment"
            ) {
              return Promise.resolve(result).then(async (response) => {
                entered.resolve();
                await release.promise;
                return response;
              });
            }
            return result;
          },
        );

        function within<T>(operation: PromiseLike<T>): Promise<T> {
          const deadline = AbortSignal.timeout(5_000);
          return Promise.race([
            operation,
            new Promise<never>((_, reject) => {
              deadline.addEventListener("abort", () => reject(new Error("IAM overlap timed out")), {
                once: true,
              });
            }),
          ]);
        }

        const first = Promise.resolve(search(adminHeaders, "existing-enrollment"));
        try {
          await within(
            Promise.race([
              entered.promise,
              first.then(({ statusCode }) => {
                throw new Error(
                  `First search returned ${statusCode} before reaching the candidate read`,
                );
              }),
            ]),
          );
          const second = await within(search(secondHeaders, "second-enrollment"));
          assert.equal(second.statusCode, 200, second.body);
          assert.equal(second.json().data.length, 1);
          const unrelated = await within(
            app.inject({
              method: "POST",
              url: `/namespaces/${namespaceId}/iam/roles`,
              headers: adminHeaders,
              payload: { permissions: [{ action: "read", resourceKind: "namespace" }] },
            }),
          );
          assert.equal(unrelated.statusCode, 201, unrelated.body);
        } finally {
          release.resolve();
          const finished = await first;
          assert.equal(finished.statusCode, 200, finished.body);
        }

        const secondPrincipal = await accountPrincipalId(pool, secondAdmin.id);
        // Commit the fixture's Installation binding removal after admission, before the
        // first snapshot SELECT. The regular Namespace write above uses the public API.
        beforeSnapshot = async () => {
          const removed = await pool.query(
            `DELETE FROM occ.iam_access_bindings
             WHERE identity_subject_id = $1 AND role_id = $2 AND resource_kind = 'installation'`,
            [secondPrincipal, roles.admin.id],
          );
          assert.equal(removed.rowCount, 1);
        };
        const revokedDuringAdmission = await search(secondHeaders, "second-enrollment");
        assert.equal(revokedDuringAdmission.statusCode, 403, revokedDuringAdmission.body);
        assert.equal(beforeSnapshot, undefined);
        assert.equal((await currentSession(app, secondHeaders.cookie)).user.id, secondAdmin.id);
        const permissionRevoked = await search(secondHeaders, "second-enrollment");
        assert.equal(permissionRevoked.statusCode, 403, permissionRevoked.body);

        const signOut = await app.inject({
          method: "POST",
          url: "/api/auth/sign-out",
          headers: secondHeaders,
        });
        assert.equal(signOut.statusCode, 200, signOut.body);
        const sessionRevoked = await search(secondHeaders, "second-enrollment");
        assert.equal(sessionRevoked.statusCode, 401, sessionRevoked.body);
      },
    );
    const groupId = "oidc-enrollment-members";
    await pool.query("INSERT INTO occ.iam_groups (id, name) VALUES ($1, $2)", [
      groupId,
      "OIDC enrollment members",
    ]);
    const policy = {
      admission: { groupsClaim: "groups", anyOf: ["members"] },
      createAccount: { enabled: true, role: { id: roles.admin.id, scope: { namespaceId } } },
      groupIds: [groupId],
    };
    await app.close();
    app = await composeApp({ ...settings, OCC_AUTH_OIDC_ENROLLMENT: JSON.stringify(policy) });
    adminHeaders = await signedInHeaders(app, origin, admin, address());
    const login = (subject: string, claims: Record<string, unknown> = {}) =>
      oidcSignIn(
        app,
        origin,
        idp,
        { subject, claims: { groups: ["members"], ...claims } },
        address(),
      );
    const grants = async (id: string) =>
      (
        await pool.query(
          "SELECT role_id, namespace_id, resource_kind, resource_id FROM occ.iam_access_bindings WHERE identity_subject_id = $1 ORDER BY id",
          [id],
        )
      ).rows;

    let memberId: string;
    let principalId: string;
    await t.test(
      "first login creates one account with a Namespace-scoped grant usable through Agent APIs",
      async () => {
        const before = await authRowCounts(pool);
        const { callback } = await login("new-member", {
          email: "new-enrollment@example.test",
          email_verified: true,
          name: "New member",
        });
        assert.equal(callback.headers.location, "/console/", callback.body);
        assert.equal(idp.authorizations.at(-1)?.scope, "openid email profile");
        const cookie = cookieHeaderFromSetCookie(callback.headers["set-cookie"]);
        const session = await currentSession(app, cookie);
        memberId = session.user.id;
        await assertConsoleSignIn(app, callback, memberId);
        principalId = await accountPrincipalId(pool, memberId);
        assert.deepEqual(await grants(principalId), [
          {
            role_id: roles.admin.id,
            namespace_id: namespaceId,
            resource_kind: null,
            resource_id: null,
          },
        ]);
        assert.equal((await authRowCounts(pool)).users, before.users + 1);
        const headers = { cookie, origin, "x-occ-session-key": session.sessionKey };
        const configuration = await app.inject({
          method: "POST",
          url: `/namespaces/${namespaceId}/configurations`,
          headers,
          payload: { kind: "agent", values: {} },
        });
        assert.equal(configuration.statusCode, 201, configuration.body);
        const agent = await app.inject({
          method: "POST",
          url: `/namespaces/${namespaceId}/agents`,
          headers,
          payload: {
            name: "Enrolled member Agent",
            configurationId: configuration.json().data.id,
            harnessAuth: null,
          },
        });
        assert.equal(agent.statusCode, 201, agent.body);
        const denied = await app.inject({
          method: "POST",
          url: "/namespaces",
          headers,
          payload: { name: "Outside the enrollment grant" },
        });
        assert.equal(denied.statusCode, 403, denied.body);
        const events = await state.transact((unit) => unit.audit.list());
        assert.ok(
          events.some(
            (event) =>
              event.action === "authentication.account.enrol" &&
              event.details?.userId === memberId &&
              event.details?.policyId,
          ),
        );
      },
    );
    await t.test(
      "repeat login needs no profile and neither duplicates nor restores initial grants",
      async () => {
        const before = await authRowCounts(pool);
        await pool.query(
          "DELETE FROM occ.iam_access_bindings WHERE identity_subject_id = $1 AND role_id = $2",
          [principalId, roles.admin.id],
        );
        const priorGrants = await grants(principalId);
        await assertConsoleSignIn(app, (await login("new-member")).callback, memberId);
        assert.equal((await authRowCounts(pool)).users, before.users);
        assert.deepEqual(await grants(principalId), priorGrants);
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM occ.iam_group_memberships WHERE principal_id = $1 AND group_id = $2",
              [principalId, groupId],
            )
          ).rows[0].n,
          1,
        );
      },
    );
    await t.test(
      "explicit attachment preserves the existing account and refuses missing admission",
      async () => {
        await assertProviderAttached(
          app,
          adminHeaders,
          accounts.existing.id,
          "oidc",
          "existing-member",
        );
        const principal = await accountPrincipalId(pool, accounts.existing.id);
        const before = await grants(principal);
        await assertConsoleSignIn(
          app,
          (await login("existing-member")).callback,
          accounts.existing.id,
        );
        assert.deepEqual(await grants(principal), before);
        const result = await login("existing-member", { groups: [] });
        assert.equal(result.callback.statusCode, 302);
        assert.match(result.callback.headers.location, /authError=oidc/);
      },
    );
    await t.test("invalid profiles and email collisions write no accounts", async () => {
      for (const claims of [
        { email: "unverified@example.test", email_verified: false },
        { email: "missing-verification@example.test" },
        { email: accounts.existing.email, email_verified: true },
        { alternate_email: "alternate@example.test", email_verified: true },
      ]) {
        const before = await authRowCounts(pool);
        const result = await login("conflicting-member", claims);
        assert.match(result.callback.headers.location, /authError=oidc/);
        assert.deepEqual(await authRowCounts(pool), before);
      }
    });
    await t.test("disabled linked accounts remain disabled", async () => {
      const search = (prefix: string) =>
        app.inject({
          method: "POST",
          url: searchPath,
          headers: adminHeaders,
          payload: { prefix },
        });
      const enabled = await search("new member");
      assert.equal(enabled.statusCode, 200, enabled.body);
      assert.deepEqual(enabled.json().data, [
        {
          principalId,
          name: "New member",
          email: "new-enrollment@example.test",
        },
      ]);
      assert.equal((await changeAccount(app, adminHeaders, memberId, "disable")).statusCode, 200);
      const disabled = await search("new-enrollment");
      assert.equal(disabled.statusCode, 200, disabled.body);
      assert.deepEqual(disabled.json().data, []);
      const disabledByName = await search("new member");
      assert.equal(disabledByName.statusCode, 200, disabledByName.body);
      assert.deepEqual(disabledByName.json().data, []);
      const result = await login("new-member", {
        email: "replacement@example.test",
        email_verified: true,
      });
      assert.match(result.callback.headers.location, /account-disabled/);
    });
    await t.test("concurrent first logins create one identity and one initial grant", async () => {
      const results = await Promise.all([
        login("concurrent-member", { email: "concurrent@example.test", email_verified: true }),
        login("concurrent-member", { email: "concurrent@example.test", email_verified: true }),
      ]);
      assert.ok(results.some(({ callback }) => !callback.headers.location.includes("authError")));
      const { rows } = await pool.query('SELECT id FROM occ."user" WHERE email = $1', [
        "concurrent@example.test",
      ]);
      assert.equal(rows.length, 1);
      assert.equal((await grants(await accountPrincipalId(pool, rows[0].id))).length, 1);
    });
    await t.test(
      "a database audit failure rolls back the account, initial grant and membership",
      async (auditTest) => {
        const before = await authRowCounts(pool);
        const beforeBindings = (
          await pool.query("SELECT count(*)::int AS n FROM occ.iam_access_bindings")
        ).rows[0].n;
        const query = pg.Client.prototype.query;
        let corrupted = false;
        auditTest.mock.method(
          pg.Client.prototype,
          "query",
          function (this: pg.Client, sql: unknown, ...args: unknown[]) {
            // Cause the real audit constraint to reject the final enrollment write.
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
        const { callback } = await login("rollback-member", {
          email: "rollback@example.test",
          email_verified: true,
        });
        assert.equal(corrupted, true);
        assert.match(callback.headers.location ?? "", /authReason=unavailable/);
        assert.deepEqual(await authRowCounts(pool), before);
        assert.equal(
          (await pool.query("SELECT count(*)::int AS n FROM occ.iam_access_bindings")).rows[0].n,
          beforeBindings,
        );
      },
    );
    await t.test("an account change after the login start invalidates that attempt", async () => {
      const start = await app.inject({
        method: "POST",
        url: "/api/auth/providers/oidc/start",
        headers: { origin },
        remoteAddress: address(),
      });
      assert.equal(start.statusCode, 200);
      const url = start.json().data.url;
      const code = idp.authorize(url, {
        subject: "existing-member",
        claims: { groups: ["members"] },
      });
      assert.equal(
        (await changeAccount(app, adminHeaders, accounts.existing.id, "revoke")).statusCode,
        200,
      );
      const callback = await app.inject({
        url: `/api/auth/providers/oidc/callback?state=${new URL(url).searchParams.get("state")}&code=${code}`,
        headers: { cookie: cookieHeaderFromSetCookie(start.headers["set-cookie"]) },
        remoteAddress: address(),
      });
      assert.match(callback.headers.location ?? "", /authError=oidc/);
      await assertConsoleSignIn(
        app,
        (await login("existing-member")).callback,
        accounts.existing.id,
      );
    });
    await t.test("a policy change after the login start invalidates that attempt", async () => {
      const start = await app.inject({
        method: "POST",
        url: "/api/auth/providers/oidc/start",
        headers: { origin },
        remoteAddress: address(),
      });
      assert.equal(start.statusCode, 200);
      const url = start.json().data.url;
      const code = idp.authorize(url, {
        subject: "policy-member",
        claims: { groups: ["members"], email: "policy@example.test", email_verified: true },
      });
      const before = await authRowCounts(pool);
      await app.close();
      app = await composeApp({
        ...settings,
        OCC_AUTH_OIDC_ENROLLMENT: JSON.stringify({
          ...policy,
          createAccount: { enabled: true, role: null },
        }),
      });
      const callback = await app.inject({
        url: `/api/auth/providers/oidc/callback?state=${new URL(url).searchParams.get("state")}&code=${code}`,
        headers: { cookie: cookieHeaderFromSetCookie(start.headers["set-cookie"]) },
        remoteAddress: address(),
      });
      assert.match(callback.headers.location ?? "", /authError=oidc/);
      assert.equal((await authRowCounts(pool)).users, before.users);
      const created = await login("policy-member", {
        email: "policy@example.test",
        email_verified: true,
      });
      const session = await currentSession(
        app,
        cookieHeaderFromSetCookie(created.callback.headers["set-cookie"]),
      );
      assert.ok(session);
      assert.deepEqual(await grants(await accountPrincipalId(pool, session.user.id)), []);
    });
    await t.test(
      "admission-only policy refuses unknown identities and malformed claims",
      async () => {
        await app.close();
        app = await composeApp({
          ...settings,
          OCC_AUTH_OIDC_ENROLLMENT: JSON.stringify({ admission: policy.admission, groupIds: [] }),
        });
        const before = await authRowCounts(pool);
        for (const groups of [undefined, "members", ["members", 1], ["Members"], []]) {
          assert.match(
            (await login("existing-member", { groups })).callback.headers.location,
            /authError=oidc/,
          );
        }
        assert.match(
          (
            await login("creation-disabled", {
              email: "creation-disabled@example.test",
              email_verified: true,
            })
          ).callback.headers.location,
          /authError=oidc/,
        );
        assert.deepEqual(await authRowCounts(pool), before);
        await assertConsoleSignIn(
          app,
          (await login("existing-member")).callback,
          accounts.existing.id,
        );
      },
    );
    await t.test(
      "initial Role scopes distinguish exact Installation access from all resources",
      async () => {
        for (const scope of ["installation", "all"]) {
          await app.close();
          app = await composeApp({
            ...settings,
            OCC_AUTH_OIDC_ENROLLMENT: JSON.stringify({
              ...policy,
              groupIds: [],
              createAccount: { enabled: true, role: { id: roles.admin.id, scope } },
            }),
          });
          const { callback } = await login(`scope-${scope}`, {
            email: `scope-${scope}@example.test`,
            email_verified: true,
          });
          const cookie = cookieHeaderFromSetCookie(callback.headers["set-cookie"]);
          const session = await currentSession(app, cookie);
          assert.ok(session);
          const headers = { cookie, origin, "x-occ-session-key": session.sessionKey };
          assert.equal((await app.inject({ url: "/installation", headers })).statusCode, 200);
          const resource = await app.inject({ url: `/namespaces/${namespaceId}`, headers });
          assert.equal(resource.statusCode, scope === "all" ? 200 : 403, resource.body);
        }
      },
    );
    await t.test("omitted Groups inherit defaults while explicit Groups replace them", async () => {
      const iamConfiguration = {
        defaultUserGroups: ["enrollment-default"],
        roles: [],
        roleBindings: [],
      };
      for (const [suffix, groupIds, expected] of [
        ["inherited", undefined, ["group_config_enrollment-default"]],
        ["empty", [], []],
        ["explicit", [groupId], [groupId]],
      ] as const) {
        await app.close();
        app = await composeApp(
          {
            ...settings,
            OCC_AUTH_OIDC_ENROLLMENT: JSON.stringify({
              admission: policy.admission,
              createAccount: { enabled: true, role: null },
              ...(groupIds === undefined ? {} : { groupIds }),
            }),
          },
          { iamConfiguration },
        );
        const { callback } = await login(`groups-${suffix}`, {
          email: `groups-${suffix}@example.test`,
          email_verified: true,
        });
        const session = await currentSession(
          app,
          cookieHeaderFromSetCookie(callback.headers["set-cookie"]),
        );
        assert.ok(session);
        const principal = await accountPrincipalId(pool, session.user.id);
        const memberships = await pool.query(
          "SELECT group_id FROM occ.iam_group_memberships WHERE principal_id = $1 ORDER BY group_id",
          [principal],
        );
        assert.deepEqual(
          memberships.rows.map((row) => row.group_id),
          expected,
        );
        assert.deepEqual(await grants(principal), []);
      }
    });
    await t.test("activation rejects missing Role, Namespace and Group references", async () => {
      await app.close();
      for (const invalid of [
        { ...policy, groupIds: ["missing-group"] },
        { ...policy, createAccount: { enabled: true, role: { id: "missing-role", scope: "all" } } },
        {
          ...policy,
          createAccount: {
            enabled: true,
            role: { id: roles.admin.id, scope: { namespaceId: "missing-namespace" } },
          },
        },
      ]) {
        await assert.rejects(
          composeApp({ ...settings, OCC_AUTH_OIDC_ENROLLMENT: JSON.stringify(invalid) }),
          { name: "ScopeViolationError", message: /^Enrollment requires (?:an? )?existing / },
        );
      }
    });
  },
);
