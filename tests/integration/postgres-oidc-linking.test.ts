import assert from "node:assert/strict";
import test from "node:test";
import { oidcProviderId } from "../../apps/controller/src/auth/oidc.ts";
import { cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { preparePostgresSignInInstallation } from "../helpers/postgres-sign-in-installation.mjs";
import {
  accountPrincipalId,
  assertConsoleSignIn,
  assertProviderAttached,
  authRowCounts,
  clientAddresses,
  consoleOrigin as origin,
  currentSession,
  fakeOidc,
  fixtureOidcIssuer,
  oidcUpgradeSettings,
  signedInHeaders,
} from "../helpers/production-sign-in.mjs";
import { waitForResult } from "../helpers/wait-for.mjs";

test(
  "named OIDC providers enforce separate policies and preserve exact identities",
  requiresPostgres,
  async (t) => {
    const runningApps: Awaited<
      ReturnType<Awaited<ReturnType<typeof preparePostgresSignInInstallation>>["composeApp"]>
    >[] = [];
    const address = clientAddresses("198.20");
    const { pool, state, onboard, composeApp } = await preparePostgresSignInInstallation(
      t,
      () => runningApps,
      {
        email: "link-recovery@example.test",
        password: "link-recovery-password",
        secrets: { "occ-auth/secret": "named-oidc-link-auth-secret-at-least-32-bytes" },
      },
    );
    const { admin, roles, accounts } = (await onboard({
      accounts: { existing: { email: "attached-reader@example.test" } },
      remoteAddress: address(),
    })) as Awaited<ReturnType<typeof onboard>> & {
      admin: { id: string };
      accounts: { existing: { id: string } };
    };
    const okta = fakeOidc(t, { clientId: "okta-client", clientSecret: "okta-fixture-secret" });
    const keycloak = fakeOidc(t, {
      clientId: "keycloak-client",
      clientSecret: "keycloak-fixture-secret",
      issuer: Object.fromEntries(
        Object.entries(fixtureOidcIssuer).map(([key, value]) => [
          key,
          value.replace("tenant.idp", "keycloak.idp"),
        ]),
      ) as typeof fixtureOidcIssuer,
    });
    const providers = {
      okta: { idp: okta, route: "oidc", clientId: "okta-client" },
      keycloak: { idp: keycloak, route: "oidc/keycloak", clientId: "keycloak-client" },
    };
    const oktaGroupId = "oidc-employees";
    const keycloakGroupId = "oidc-partners";
    // The two Installation Groups exist before OIDC is enabled. Sign-in must add
    // membership only to the Group selected by that provider's policy.
    await pool.query("INSERT INTO occ.iam_groups (id, name) VALUES ($1, $2), ($3, $4)", [
      oktaGroupId,
      "Employees",
      keycloakGroupId,
      "Partners",
    ]);
    const oktaEnrollment = {
      admission: { groupsClaim: "groups", anyOf: ["employees"] },
      createAccount: { enabled: true, role: { id: roles.reader.id, scope: "installation" } },
      groupIds: [oktaGroupId],
    };
    const keycloakEnrollment = {
      admission: { groupsClaim: "teams", anyOf: ["partners"] },
      createAccount: { enabled: true, role: { id: roles.admin.id, scope: "installation" } },
      groupIds: [keycloakGroupId],
    };
    const settings = Object.fromEntries(
      Object.entries(oidcUpgradeSettings(admin.id)).filter(
        ([name]) => !name.startsWith("OCC_AUTH_OIDC_"),
      ),
    );
    const namedSettings = {
      ...settings,
      OCC_AUTH_OIDC_PROVIDERS: "okta,keycloak",
      OCC_AUTH_OIDC_OKTA_ISSUER: okta.issuer.issuer,
      OCC_AUTH_OIDC_OKTA_AUTHORIZATION_URL: okta.issuer.authorizationUrl,
      OCC_AUTH_OIDC_OKTA_TOKEN_URL: okta.issuer.tokenUrl,
      OCC_AUTH_OIDC_OKTA_JWKS_URL: okta.issuer.jwksUrl,
      OCC_AUTH_OIDC_OKTA_CLIENT_ID: "okta-client",
      OCC_AUTH_OIDC_OKTA_CLIENT_SECRET: "okta-fixture-secret",
      OCC_AUTH_OIDC_OKTA_DISPLAY_NAME: "Okta",
      OCC_AUTH_OIDC_KEYCLOAK_ISSUER: keycloak.issuer.issuer,
      OCC_AUTH_OIDC_KEYCLOAK_AUTHORIZATION_URL: keycloak.issuer.authorizationUrl,
      OCC_AUTH_OIDC_KEYCLOAK_TOKEN_URL: keycloak.issuer.tokenUrl,
      OCC_AUTH_OIDC_KEYCLOAK_JWKS_URL: keycloak.issuer.jwksUrl,
      OCC_AUTH_OIDC_KEYCLOAK_CLIENT_ID: "keycloak-client",
      OCC_AUTH_OIDC_KEYCLOAK_CLIENT_SECRET: "keycloak-fixture-secret",
      OCC_AUTH_OIDC_KEYCLOAK_DISPLAY_NAME: "Keycloak",
    };
    const enrollmentSettings = {
      OCC_AUTH_OIDC_OKTA_ENROLLMENT: JSON.stringify(oktaEnrollment),
      OCC_AUTH_OIDC_KEYCLOAK_ENROLLMENT: JSON.stringify(keycloakEnrollment),
    };
    let app = await composeApp({
      ...namedSettings,
      ...enrollmentSettings,
      OCC_AUTH_OIDC_OKTA_LEGACY_CALLBACK: "true",
      OCC_AUTH_OIDC_OKTA_ALLOW_SELF_LINK: "true",
      OCC_AUTH_OIDC_KEYCLOAK_ALLOW_SELF_LINK: "true",
    });
    runningApps.push(app);
    const discovered = await app.inject({ url: "/api/auth/providers" });
    assert.equal(discovered.statusCode, 200, discovered.body);
    const removed = await app.inject({ url: "/api/auth/providers/oidc/removed/callback" });
    assert.equal(removed.statusCode, 302);
    assert.equal(removed.headers.location, "/console/?authError=oidc/removed");
    assert.deepEqual(discovered.json().data.oidcProviders, [
      {
        key: "okta",
        route: "oidc",
        label: "Okta",
        authorizationUrl: okta.issuer.authorizationUrl,
        allowSelfLink: true,
      },
      {
        key: "keycloak",
        route: "oidc/keycloak",
        label: "Keycloak",
        authorizationUrl: keycloak.issuer.authorizationUrl,
        allowSelfLink: true,
      },
    ]);
    const grants = async (principalId: string) =>
      (
        await pool.query(
          "SELECT * FROM occ.iam_access_bindings WHERE identity_subject_id = $1 ORDER BY id",
          [principalId],
        )
      ).rows;
    const methods = async (userId: string) =>
      (
        await pool.query(
          "SELECT provider_id, account_id FROM occ.account WHERE user_id = $1 AND identity_only ORDER BY account_id",
          [userId],
        )
      ).rows;

    async function signIn(
      key: keyof typeof providers,
      subject: string,
      claims: Record<string, unknown> = {},
      link?: { attemptId: string; cookie: string },
    ) {
      const { route, idp, clientId } = providers[key];
      const remoteAddress = address();
      const prefix = `/api/auth/providers/${route}`;
      const start = await app.inject({
        method: "POST",
        url: `${prefix}/start`,
        headers: { origin, ...(link === undefined ? {} : { cookie: link.cookie }) },
        remoteAddress,
        ...(link === undefined ? {} : { payload: { linkAttemptId: link.attemptId } }),
      });
      assert.equal(start.statusCode, 200, start.body);
      const { url, attemptId } = start.json().data;
      const authorization = new URL(url);
      assert.equal(authorization.searchParams.get("redirect_uri"), `${origin}${prefix}/callback`);
      assert.equal(authorization.searchParams.get("client_id"), clientId);
      if (link !== undefined) {
        assert.equal(authorization.searchParams.get("prompt"), "login");
        assert.equal(authorization.searchParams.get("max_age"), "0");
      }
      const code = idp.authorize(url, {
        subject,
        claims: {
          ...claims,
          ...(link === undefined ? {} : { auth_time: Math.floor(Date.now() / 1000) }),
        },
      });
      const binding = cookieHeaderFromSetCookie(start.headers["set-cookie"]);
      const callback = await app.inject({
        url: `${prefix}/callback?state=${authorization.searchParams.get("state")}&code=${code}`,
        headers: { cookie: link === undefined ? binding : `${binding}; ${link.cookie}` },
        remoteAddress,
      });
      return { callback, attemptId };
    }

    const oktaClaims = { groups: ["employees"] };
    const keycloakClaims = { teams: ["partners"] };
    const method = (key: keyof typeof providers, subject: string) => ({
      provider_id: oidcProviderId({
        issuer: providers[key].idp.issuer.issuer,
        clientId: providers[key].clientId,
      }),
      account_id: subject,
    });
    const groups = async (principalId: string) =>
      (
        await pool.query(
          "SELECT group_id FROM occ.iam_group_memberships WHERE principal_id = $1 ORDER BY group_id",
          [principalId],
        )
      ).rows.map(({ group_id }) => group_id);

    await t.test(
      "each provider checks its own claims and creates a distinct account with its own grants",
      async () => {
        // The two issuers legitimately assigned the same subject to different people.
        const subject = "member-001";
        const alex = { email: "alex@example.test", email_verified: true };
        const ren = { email: "ren@example.test", email_verified: true };
        const before = await authRowCounts(pool);
        const refusedOkta = await signIn("okta", subject, { ...alex, ...keycloakClaims });
        assert.equal(refusedOkta.callback.headers.location, "/console/?authError=oidc");
        const refusedKeycloak = await signIn("keycloak", subject, { ...ren, ...oktaClaims });
        assert.equal(
          refusedKeycloak.callback.headers.location,
          "/console/?authError=oidc/keycloak",
        );
        assert.deepEqual(await authRowCounts(pool), before);

        const alexLogin = await signIn("okta", subject, { ...alex, ...oktaClaims });
        const renLogin = await signIn("keycloak", subject, { ...ren, ...keycloakClaims });
        const alexCookie = cookieHeaderFromSetCookie(alexLogin.callback.headers["set-cookie"]);
        const renCookie = cookieHeaderFromSetCookie(renLogin.callback.headers["set-cookie"]);
        const alexSession = await currentSession(app, alexCookie);
        const renSession = await currentSession(app, renCookie);
        assert.equal(alexSession?.user.email, alex.email, alexLogin.callback.body);
        assert.equal(renSession?.user.email, ren.email, renLogin.callback.body);
        assert.notEqual(alexSession.user.id, renSession.user.id);
        const alexPrincipal = await accountPrincipalId(pool, alexSession.user.id);
        const renPrincipal = await accountPrincipalId(pool, renSession.user.id);
        assert.notEqual(alexPrincipal, renPrincipal);
        assert.deepEqual(await methods(alexSession.user.id), [method("okta", subject)]);
        assert.deepEqual(await methods(renSession.user.id), [method("keycloak", subject)]);
        assert.deepEqual(
          (await grants(alexPrincipal)).map(({ role_id }) => role_id),
          [roles.reader.id],
        );
        assert.deepEqual(
          (await grants(renPrincipal)).map(({ role_id }) => role_id),
          [roles.admin.id],
        );
        assert.deepEqual(await groups(alexPrincipal), [oktaGroupId]);
        assert.deepEqual(await groups(renPrincipal), [keycloakGroupId]);
      },
    );

    await t.test("Maya proves the existing login before adding Keycloak", async () => {
      const profile = { email: "maya@example.test", email_verified: true, name: "Maya" };
      const first = await signIn("okta", "okta-maya", { ...profile, ...oktaClaims });
      const oldCookie = cookieHeaderFromSetCookie(first.callback.headers["set-cookie"]);
      const firstSession = await currentSession(app, oldCookie);
      assert.equal(firstSession?.user.email, profile.email, first.callback.body);
      const userId = firstSession.user.id;
      const principalId = await accountPrincipalId(pool, userId);
      const counts = await authRowCounts(pool);
      const priorGrants = await grants(principalId);
      const oktaMethod = method("okta", "okta-maya");

      // The second provider reports Maya's email. OCE waits for proof of the existing login
      // before it writes a sign-in method or grants another session.
      const pending = await signIn("keycloak", "keycloak-maya", { ...profile, ...keycloakClaims });
      assert.equal(pending.callback.headers.location, "/console/?authLink=oidc/keycloak");
      const linkCookie = cookieHeaderFromSetCookie(pending.callback.headers["set-cookie"])
        .split("; ")
        .find((part) => part.startsWith("__Host-occ_login_link="));
      assert.ok(linkCookie);
      assert.deepEqual(await methods(userId), [oktaMethod]);
      assert.deepEqual(await authRowCounts(pool), counts);

      const proof = await signIn("okta", "okta-maya", oktaClaims, {
        attemptId: pending.attemptId,
        cookie: linkCookie,
      });
      const cookie = await assertConsoleSignIn(app, proof.callback, userId);
      const result = await app.inject({
        method: "POST",
        url: "/api/auth/providers/oidc/result",
        headers: { origin, cookie },
        payload: { attemptId: proof.attemptId },
      });
      assert.equal(result.statusCode, 200, result.body);
      assert.equal(result.json().data.sessionKey, (await currentSession(app, cookie)).sessionKey);
      assert.deepEqual(await methods(userId), [method("keycloak", "keycloak-maya"), oktaMethod]);
      assert.equal((await authRowCounts(pool)).users, counts.users);
      assert.equal(await currentSession(app, oldCookie), null);
      const events = await state.transact((unit) => unit.audit.list());
      assert.ok(
        events.some(
          (event) => event.action === "authentication.method.link" && event.actorId === principalId,
        ),
      );

      await assertConsoleSignIn(
        app,
        (await signIn("keycloak", "keycloak-maya", keycloakClaims)).callback,
        userId,
      );
      assert.equal(await accountPrincipalId(pool, userId), principalId);
      // The second provider's initial Role applies only to a new account.
      assert.deepEqual(await grants(principalId), priorGrants);
    });

    // Keep both providers active, but require explicit attachment for unknown Keycloak users.
    await runningApps.pop()?.close();
    app = await composeApp({
      ...namedSettings,
      ...enrollmentSettings,
      OCC_AUTH_OIDC_OKTA_LEGACY_CALLBACK: "true",
      OCC_AUTH_OIDC_OKTA_ALLOW_SELF_LINK: "true",
      OCC_AUTH_PASSWORD_SIGN_IN: "recovery-only",
      OCC_AUTH_OIDC_KEYCLOAK_ENROLLMENT: JSON.stringify({
        admission: keycloakEnrollment.admission,
        groupIds: keycloakEnrollment.groupIds,
      }),
    });
    runningApps.push(app);
    await t.test("one provider's opt-in leaves self-service linking unavailable", async () => {
      const discovery = await app.inject({ url: "/api/auth/providers" });
      assert.equal(discovery.statusCode, 200, discovery.body);
      assert.deepEqual(
        discovery
          .json()
          .data.oidcProviders.map(
            ({ key, allowSelfLink }: { key: string; allowSelfLink: boolean }) => [
              key,
              allowSelfLink,
            ],
          ),
        [
          ["okta", true],
          ["keycloak", false],
        ],
      );
      const refused = await app.inject({
        method: "POST",
        url: "/api/auth/providers/oidc/start",
        headers: { origin },
        remoteAddress: address(),
        payload: { linkExisting: true },
      });
      assert.equal(refused.statusCode, 401, refused.body);
      assert.equal(refused.headers["set-cookie"], undefined);
    });

    await t.test("account creation can be enabled for just one provider", async () => {
      const profile = { email: "new-member@example.test", email_verified: true };
      const before = await authRowCounts(pool);
      const keycloakLogin = await signIn("keycloak", "new-member", {
        ...profile,
        ...keycloakClaims,
      });
      assert.equal(keycloakLogin.callback.headers.location, "/console/?authError=oidc/keycloak");
      assert.deepEqual(await authRowCounts(pool), before);

      const oktaLogin = await signIn("okta", "new-member", { ...profile, ...oktaClaims });
      assert.equal(oktaLogin.callback.headers.location, "/console/", oktaLogin.callback.body);
      const cookie = cookieHeaderFromSetCookie(oktaLogin.callback.headers["set-cookie"]);
      assert.equal((await currentSession(app, cookie))?.user.email, profile.email);
      assert.equal((await authRowCounts(pool)).users, before.users + 1);
    });

    await t.test("an administrator can attach both providers to an existing account", async () => {
      const adminHeaders = await signedInHeaders(app, origin, admin, address());
      const userId = accounts.existing.id;
      const principalId = await accountPrincipalId(pool, userId);
      const priorGrants = await grants(principalId);
      const counts = await authRowCounts(pool);
      await assertProviderAttached(app, adminHeaders, userId, "oidc/okta", "attached-okta");
      await assertProviderAttached(app, adminHeaders, userId, "oidc/keycloak", "attached-keycloak");

      for (const [key, subject, claims] of [
        ["okta", "attached-okta", oktaClaims],
        ["keycloak", "attached-keycloak", keycloakClaims],
      ] as const) {
        const { callback } = await signIn(key, subject, claims);
        const cookie = await assertConsoleSignIn(app, callback, userId);
        const { sessionKey } = await currentSession(app, cookie);
        const headers = { cookie, origin, "x-occ-session-key": sessionKey };
        // Both methods keep the reader's access to the Installation and do not grant creation.
        const read = await app.inject({ url: "/installation", headers });
        assert.equal(read.statusCode, 200, read.body);
        const denied = await app.inject({
          method: "POST",
          url: "/namespaces",
          headers,
          payload: { name: "Outside the reader's permissions" },
        });
        assert.equal(denied.statusCode, 403, denied.body);
      }
      assert.deepEqual(await methods(userId), [
        method("keycloak", "attached-keycloak"),
        method("okta", "attached-okta"),
      ]);
      assert.equal((await authRowCounts(pool)).users, counts.users);
      assert.equal(await accountPrincipalId(pool, userId), principalId);
      assert.deepEqual(await grants(principalId), priorGrants);
    });

    await t.test(
      "a slow provider leaves the other provider and password recovery available",
      async () => {
        keycloak.mode = "hang";
        const priorRequests = keycloak.requests;
        let callbackFinished = false;
        const pending = signIn("keycloak", "attached-keycloak", keycloakClaims).finally(() => {
          callbackFinished = true;
        });
        void pending.catch(() => {});
        try {
          // Confirm the slow provider is already processing its token request when the other
          // two sign-ins start. Both must work before that request reaches its deadline.
          await waitForResult("Keycloak token request", () => keycloak.requests > priorRequests);
          const oktaLogin = await signIn("okta", "attached-okta", oktaClaims);
          await assertConsoleSignIn(app, oktaLogin.callback, accounts.existing.id);
          const recovery = await signedInHeaders(app, origin, admin, address());
          assert.equal((await currentSession(app, recovery.cookie))?.user.id, admin.id);
          assert.equal(callbackFinished, false);
          const { callback } = await pending;
          assert.equal(
            callback.headers.location,
            "/console/?authError=oidc/keycloak&authReason=provider-unavailable",
          );
          assert.equal(callback.headers["set-cookie"], undefined);
        } finally {
          keycloak.mode = "up";
          await pending;
        }
      },
    );

    await t.test("named OIDC alone supports native Agent host-only sessions", async () => {
      // Native Agent access must start even when neither provider uses the legacy callback.
      await runningApps.pop()?.close();
      providers.okta.route = "oidc/okta";
      app = await composeApp({
        ...namedSettings,
        OCC_AUTH_PASSWORD_SIGN_IN: "recovery-only",
        OCC_AGENT_NATIVE_ADMIN_ENABLED: "true",
        OCC_AGENT_NATIVE_ADMIN_SESSION_MODE: "host-only-exchange",
      });
      runningApps.push(app);
      const discovery = await app.inject({ url: "/api/auth/providers" });
      assert.equal(discovery.statusCode, 200, discovery.body);
      assert.equal(discovery.json().data.oidc, false);
      assert.deepEqual(
        discovery.json().data.oidcProviders.map(({ route }: { route: string }) => route),
        ["oidc/okta", "oidc/keycloak"],
      );

      for (const [key, subject] of [
        ["okta", "attached-okta"],
        ["keycloak", "attached-keycloak"],
      ] as const) {
        const { callback } = await signIn(key, subject);
        await assertConsoleSignIn(app, callback, accounts.existing.id);
        const headers = callback.headers["set-cookie"];
        const cookies = Array.isArray(headers) ? headers : [headers];
        const session = cookies.find((cookie) =>
          cookie?.startsWith("__Host-openclaw_occ.session_token="),
        );
        assert.ok(
          session && /;\s*secure(?:;|$)/i.test(session) && !/;\s*domain=/i.test(session),
          "the Console session cookie must stay on the Console host",
        );
      }
    });
  },
);
