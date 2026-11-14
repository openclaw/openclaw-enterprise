import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import {
  PostgresHumanAuthentication,
  PostgresPlatformState,
} from "../../packages/occ/src/index.ts";
import { betterAuthIssuer } from "../../apps/controller/src/auth/index.ts";
import { oidcLoginConfiguration } from "../../apps/controller/src/auth/oidc.ts";
import type { PostgresDevelopmentConfig } from "../../apps/controller/src/composition/development-postgres.ts";
import { composePostgresDevelopment } from "../helpers/password-hasher.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.ts";
import { createDevelopmentComputeDriver } from "../helpers/development.ts";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import { cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";
import {
  first,
  injectLocalhost as injectRequest,
  integer,
  record,
  recordData,
  signedInHeaders,
  text,
} from "../helpers/postgres-sign-in-test-boundaries.ts";
import {
  assertProviderAttached,
  fakeOidc,
  fixtureOidcIssuer,
  authRowCounts,
  currentSession,
  readAccount,
} from "../helpers/production-sign-in.mjs";
import { commitAckProxy } from "../fixtures/postgres-commit-ack-proxy.mjs";
import {
  databaseUrl as selectedDatabaseUrl,
  requiresPostgres,
} from "../helpers/postgres-database.mjs";

type App = Awaited<ReturnType<typeof composePostgresDevelopment>>;
type CommitAckProxy = Awaited<ReturnType<typeof commitAckProxy>>;
type RequestOptions = Parameters<typeof injectRequest>[3];

test(
  "opted-in HTTP login and logout preserve cookies until real State commit acknowledgement",
  requiresPostgres,
  async (t) => {
    const email = "commit-recovery@example.test";
    const password = "commit-recovery-long-password";
    const authSecret = "commit-cookie-test-secret-at-least-32-bytes";
    const origin = "https://console.oce.localhost";
    const databaseUrl = selectedDatabaseUrl;
    assert.ok(databaseUrl);
    function injectLocalhost(
      target: App,
      method: string,
      path: string,
      options: RequestOptions = {},
    ) {
      return injectRequest(target, method, path, { host: new URL(origin).host, ...options });
    }
    await ensureDevelopmentBootstrap(t, {
      databaseUrl,
      email,
      password,
      authSecret,
      authBaseURL: origin,
      agentDomain: "agents.oce.localhost",
      installationName: "Cookie commit proof",
    });
    const observer = new pg.Pool({ connectionString: databaseUrl });
    const loggedErrors: unknown[][] = [];
    t.mock.method(console, "error", (...values: unknown[]) => loggedErrors.push(values));
    const apps: App[] = [];
    const proxies: CommitAckProxy[] = [];
    t.after(async () => {
      for (const app of apps.reverse()) {
        await app.close();
      }
      for (const proxy of proxies) {
        await proxy.close();
      }
      await observer.end();
    });
    const recoveryUser = await observer.query<{ id: string }>(
      'SELECT id FROM occ."user" WHERE email=$1',
      [email],
    );
    const recoveryUserId = first(recoveryUser.rows).id;
    const oidc = oidcLoginConfiguration({
      OCC_AUTH_OIDC_ISSUER: fixtureOidcIssuer.issuer,
      OCC_AUTH_OIDC_AUTHORIZATION_URL: fixtureOidcIssuer.authorizationUrl,
      OCC_AUTH_OIDC_TOKEN_URL: fixtureOidcIssuer.tokenUrl,
      OCC_AUTH_OIDC_JWKS_URL: fixtureOidcIssuer.jwksUrl,
      OCC_AUTH_OIDC_TOKEN_AUTH: "client_secret_post",
      OCC_AUTH_OIDC_DISPLAY_NAME: "single sign-on",
      OCC_AUTH_OIDC_CLIENT_ID: "commit-client",
      OCC_AUTH_OIDC_CLIENT_SECRET: "commit-secret",
    });
    assert.ok(oidc);
    const config = {
      mode: "development",
      host: "127.0.0.1",
      authSecret,
      authBaseURL: origin,
      nativeAdmin: { enabled: false, domain: "agents.oce.localhost" },
      oidc: { ...oidc, recoveryUserId },
    } satisfies Omit<PostgresDevelopmentConfig, "databaseUrl">;
    const drivers = () => ({
      computeDriver: createDevelopmentComputeDriver(),
      configurationDriver: createTestConfigurationDriver(),
    });
    // Headerless, as a command-line client signs in: the controller synthesizes the Origin.
    const signIn = (target: App) =>
      injectLocalhost(target, "POST", "/api/auth/sign-in/email", { body: { email, password } });
    const signOut = (target: App, headers: Record<string, string>) =>
      injectLocalhost(target, "POST", "/api/auth/sign-out", { headers });
    const sessionCount = async () => integer(record(await authRowCounts(observer)).sessions);
    const auditCount = async (action: string) => {
      const result = await observer.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM occ.audit_events WHERE action=$1",
        [action],
      );
      return first(result.rows).count;
    };
    const proxy = await commitAckProxy(databaseUrl);
    proxies.push(proxy);
    const app = await composePostgresDevelopment({ ...config, databaseUrl: proxy.url }, drivers());
    apps.push(app);
    await app.ready();
    // The first commit acknowledges the credential snapshot. Drop only the real
    // session+audit COMMIT reply, after PostgreSQL has committed those rows.
    proxy.arm({ skipCommits: 1 });
    const unknown = await signIn(app);
    assert.equal(proxy.observedCommit, true);
    assert.equal(unknown.statusCode, 503, unknown.body);
    assert.equal(unknown.headers["set-cookie"], undefined);
    assert.equal(await sessionCount(), 1);
    assert.equal(await auditCount("authentication.login"), 1);
    assert.equal(record(unknown.json()).data, undefined);
    // The original State owner can observe the committed session even though
    // the failed acknowledgement prevented its cookie from reaching the browser.
    const state = new PostgresPlatformState(observer);
    const installation = await state.loadInstallation();
    assert.ok(installation);
    const persistence = new PostgresHumanAuthentication(
      state,
      installation.id,
      betterAuthIssuer(installation.id),
    );
    const committed = await observer.query<{ token: string }>(
      "SELECT token FROM occ.session WHERE user_id=$1",
      [recoveryUserId],
    );
    const session = await persistence.currentSession(first(committed.rows).token);
    assert.ok(session);
    assert.equal(session.user.id, recoveryUserId);
    assert.deepEqual(
      loggedErrors,
      [],
      "unclassified dependency errors must not reach library console logging",
    );

    const ordinary = await composePostgresDevelopment({ ...config, databaseUrl }, drivers());
    apps.push(ordinary);
    await t.test(
      "a real audit constraint rejection rolls back HTTP login without releasing a cookie",
      async (auditTest) => {
        const beforeSessions = await sessionCount();
        const beforeAudit = await auditCount("authentication.login");
        const query = pg.Client.prototype.query;
        let corrupted = false;
        // Alter only the audit transport parameter. PostgreSQL enforces its real
        // constraint; original State owns rollback of the preceding session write.
        auditTest.mock.method(
          pg.Client.prototype,
          "query",
          function (this: pg.Client, sql: unknown, ...args: unknown[]) {
            if (
              !corrupted &&
              typeof sql === "string" &&
              sql.includes("INSERT INTO occ.audit_events")
            ) {
              const parameters = args[0];
              assert.ok(Array.isArray(parameters));
              const values: unknown[] = parameters;
              corrupted = true;
              args[0] = ["invalid-audit-id", ...values.slice(1)];
            }
            const result: unknown = Reflect.apply(query, this, [sql, ...args]);
            return result;
          },
        );
        const rejected = await signIn(ordinary);
        assert.equal(corrupted, true);
        assert.equal(rejected.statusCode, 503, rejected.body);
        assert.equal(rejected.headers["set-cookie"], undefined);
        assert.equal(await sessionCount(), beforeSessions);
        assert.equal(await auditCount("authentication.login"), beforeAudit);
      },
    );
    const signedIn = await signIn(ordinary);
    assert.equal(signedIn.statusCode, 200, signedIn.body);
    const cookie = cookieHeaderFromSetCookie(signedIn.headers["set-cookie"]);
    const sessionUserId = async (cookie: string) => {
      const session = record(await currentSession(ordinary, cookie));
      return text(record(session.user).id);
    };
    const cookieName = cookie.slice(0, cookie.indexOf("="));
    const ambiguousLogout = await signOut(ordinary, {
      cookie: `${cookieName}=malformed; ${cookie}`,
      origin,
    });
    assert.equal(ambiguousLogout.statusCode, 401, ambiguousLogout.body);
    assert.equal(ambiguousLogout.headers["set-cookie"], undefined);
    assert.equal(
      await sessionUserId(cookie),
      recoveryUserId,
      "rejected ambiguous logout leaves the original session current",
    );
    // A tab pinned to another session cannot end the one this cookie now carries.
    const otherTab = await signIn(ordinary);
    const otherTabKey = text(recordData(otherTab.json()).sessionKey);
    const mismatchedLogout = await signOut(ordinary, {
      cookie,
      origin,
      "x-occ-session-key": otherTabKey,
    });
    assert.equal(mismatchedLogout.statusCode, 401, mismatchedLogout.body);
    assert.equal(mismatchedLogout.headers["set-cookie"], undefined);
    assert.equal(
      await sessionUserId(cookie),
      recoveryUserId,
      "a mismatched session key neither revokes nor clears the current session",
    );
    // The pinned tab can still end its own session.
    const otherTabCookie = cookieHeaderFromSetCookie(otherTab.headers["set-cookie"]);
    const ownLogout = await signOut(ordinary, {
      cookie: otherTabCookie,
      origin,
      "x-occ-session-key": otherTabKey,
    });
    assert.equal(ownLogout.statusCode, 200, ownLogout.body);
    assert.equal(await currentSession(ordinary, otherTabCookie), null);
    const logoutProxy = await commitAckProxy(databaseUrl);
    proxies.push(logoutProxy);
    const logout = await composePostgresDevelopment(
      { ...config, databaseUrl: logoutProxy.url },
      drivers(),
    );
    apps.push(logout);
    await logout.ready();
    logoutProxy.arm();
    const unknownLogout = await signOut(logout, { cookie, origin });
    assert.equal(logoutProxy.observedCommit, true);
    assert.equal(unknownLogout.statusCode, 503, unknownLogout.body);
    assert.equal(
      unknownLogout.headers["set-cookie"],
      undefined,
      "failed acknowledgement must not clear the browser cookie",
    );
    assert.equal(await currentSession(ordinary, cookie), null);
    assert.equal(
      await auditCount("authentication.logout"),
      // The pinned tab's own logout above, then this committed-but-unacknowledged one.
      2,
    );

    // Headerless (CLI) sign-out is rejected: sign-out is a cookie mutation and
    // requires the exact configured browser Origin (requireSessionMutationOrigin)
    // before the humanLogin profile's private endpoint runs. Only password
    // sign-in keeps the Origin synthesis for command-line clients.
    const headerlessLogin = await signIn(ordinary);
    assert.equal(headerlessLogin.statusCode, 200, headerlessLogin.body);
    const headerlessCookie = cookieHeaderFromSetCookie(headerlessLogin.headers["set-cookie"]);
    const headerlessLogout = await signOut(ordinary, { cookie: headerlessCookie });
    assert.equal(headerlessLogout.statusCode, 403, headerlessLogout.body);
    assert.equal(
      headerlessLogout.headers["set-cookie"],
      undefined,
      "rejected headerless logout must not clear the browser cookie",
    );
    assert.equal(
      await sessionUserId(headerlessCookie),
      recoveryUserId,
      "rejected headerless logout leaves the session current",
    );
    assert.equal(
      await auditCount("authentication.logout"),
      // Still only the pinned tab's logout and the unacknowledged one above.
      2,
      "rejected headerless logout writes no logout audit",
    );

    // Browser-style sign-ins from here on: only their cookies matter.
    const adminHeaders = await signedInHeaders(ordinary, origin, { email, password });
    const expectedVersion = integer(
      record(await readAccount(ordinary, adminHeaders, recoveryUserId)).version,
    );
    const administrationProxy = await commitAckProxy(databaseUrl);
    proxies.push(administrationProxy);
    const administration = await composePostgresDevelopment(
      { ...config, databaseUrl: administrationProxy.url },
      drivers(),
    );
    apps.push(administration);
    await administration.ready();
    // Admission, Native IAM identity lookup, authorization, the target Principal
    // lookup and its grant coverage each finish their read transaction first.
    // Drop the following account+audit mutation COMMIT.
    administrationProxy.arm({ skipCommits: 5 });
    const unknownAdministration = await administration.inject({
      method: "POST",
      url: `/api/auth/accounts/${recoveryUserId}/revoke`,
      headers: adminHeaders,
      payload: { expectedVersion },
    });
    assert.equal(administrationProxy.observedCommit, true);
    assert.equal(unknownAdministration.statusCode, 503, unknownAdministration.body);
    assert.match(
      text(record(record(unknownAdministration.json<unknown>()).error).message),
      /outcome is unknown/i,
    );
    assert.equal(unknownAdministration.headers["set-cookie"], undefined);
    assert.equal(await auditCount("authentication.account.revoke"), 1);
    assert.equal(await currentSession(ordinary, adminHeaders.cookie), null);

    // A new recovery login can inspect present state. It does not turn the lost
    // response into a receipt or authorize an automatic replay of the old write.
    const recoveredHeaders = await signedInHeaders(ordinary, origin, { email, password });
    const observed = await ordinary.inject({
      url: `/api/auth/accounts/${recoveryUserId}`,
      headers: recoveredHeaders,
    });
    assert.equal(observed.statusCode, 200, observed.body);
    assert.equal(observed.headers["cache-control"], "no-store");
    assert.equal(integer(recordData(observed.json<unknown>()).version), expectedVersion + 1);
    const stale = await ordinary.inject({
      method: "POST",
      url: `/api/auth/accounts/${recoveryUserId}/revoke`,
      headers: recoveredHeaders,
      payload: { expectedVersion },
    });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(await auditCount("authentication.account.revoke"), 1);
    assert.equal(
      integer(record(await readAccount(ordinary, recoveredHeaders, recoveryUserId)).version),
      expectedVersion + 1,
      "a refused stale revoke writes nothing",
    );

    await t.test(
      "a lost OIDC session COMMIT reply preserves the committed login without identity denial",
      async (callbackTest) => {
        await assertProviderAttached(
          ordinary,
          recoveredHeaders,
          recoveryUserId,
          "oidc",
          "12345678",
        );
        const idp = fakeOidc(callbackTest, {
          clientId: oidc.clientId,
          clientSecret: oidc.clientSecret,
        });
        const callbackProxy = await commitAckProxy(databaseUrl);
        proxies.push(callbackProxy);
        const callbackApp = await composePostgresDevelopment(
          { ...config, databaseUrl: callbackProxy.url },
          drivers(),
        );
        apps.push(callbackApp);
        await callbackApp.ready();
        const started = await callbackApp.inject({
          method: "POST",
          url: "/api/auth/providers/oidc/start",
          headers: { host: new URL(origin).host, origin },
        });
        assert.equal(started.statusCode, 200, started.body);
        const authorizationUrl = text(recordData(started.json<unknown>()).url);
        const state = new URL(authorizationUrl).searchParams.get("state");
        assert.ok(state);
        const code = idp.authorize(authorizationUrl, { subject: "12345678" });
        async function counts() {
          const result = await observer.query<{
            sessions: number;
            logins: number;
            denials: number;
          }>(
            `SELECT
              (SELECT count(*)::int FROM occ.session) AS sessions,
              (SELECT count(*)::int FROM occ.audit_events
                WHERE action='authentication.login' AND outcome='success') AS logins,
              (SELECT count(*)::int FROM occ.audit_events
                WHERE action='authentication.login' AND outcome='denied') AS denials`,
          );
          return first(result.rows);
        }
        const before = await counts();
        // Consume the attempt and capture the enrolled method first. The third
        // real COMMIT writes the session, method binding and successful audit.
        callbackProxy.arm({ skipCommits: 2 });
        const unknownCallback = await callbackApp.inject({
          url: `/api/auth/providers/oidc/callback?state=${state}&code=${code}`,
          headers: { cookie: cookieHeaderFromSetCookie(started.headers["set-cookie"]) },
        });
        assert.equal(callbackProxy.observedCommit, true);
        assert.equal(unknownCallback.statusCode, 302);
        // The outcome is unknown inside OCE, so the Console reports an outage, not a refusal.
        assert.equal(
          unknownCallback.headers.location,
          "/console/?authError=oidc&authReason=unavailable",
        );
        assert.equal(unknownCallback.headers["set-cookie"], undefined);
        assert.equal(idp.tokens.length, 1, "the uncertain operation is not replayed");
        assert.deepEqual(await counts(), {
          sessions: before.sessions + 1,
          logins: before.logins + 1,
          denials: before.denials,
        });
      },
    );
  },
);
