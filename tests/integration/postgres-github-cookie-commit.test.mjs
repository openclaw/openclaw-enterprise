import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import {
  PostgresHumanAuthentication,
  PostgresPlatformState,
} from "../../packages/occ/src/index.ts";
import { betterAuthIssuer } from "../../apps/controller/src/auth/index.ts";
import { composePostgresDevelopment } from "../../apps/controller/src/composition/development-postgres.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import { cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";
import { commitAckProxy } from "../fixtures/postgres-commit-ack-proxy.mjs";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;

test(
  "opted-in HTTP login and logout preserve cookies until real State commit acknowledgement",
  {
    skip: databaseUrl ? false : "Set OCC_TEST_DATABASE_URL for real PostgreSQL proof.",
  },
  async (t) => {
    const email = "commit-recovery@example.test";
    const password = "commit-recovery-long-password";
    const authSecret = "commit-cookie-test-secret-at-least-32-bytes";
    const origin = "http://127.0.0.1";
    await ensureDevelopmentBootstrap(t, {
      databaseUrl,
      email,
      password,
      authSecret,
      authBaseURL: origin,
      installationName: "Cookie commit proof",
    });
    const observer = new pg.Pool({ connectionString: databaseUrl });
    const loggedErrors = [];
    t.mock.method(console, "error", (...values) => loggedErrors.push(values));
    const apps = [];
    const proxies = [];
    t.after(async () => {
      for (const app of apps.reverse()) {
        await app.close();
      }
      for (const proxy of proxies) {
        await proxy.close();
      }
      await observer.end();
    });
    const recoveryUserId = (
      await observer.query('SELECT id FROM occ."user" WHERE email=$1', [email])
    ).rows[0].id;
    const config = {
      mode: "development",
      host: "127.0.0.1",
      authSecret,
      authBaseURL: origin,
      github: { clientId: "commit-client", clientSecret: "commit-secret", recoveryUserId },
    };
    const drivers = () => ({
      computeDriver: createDevelopmentComputeDriver(),
      configurationDriver: createTestConfigurationDriver(),
    });
    const proxy = await commitAckProxy(databaseUrl);
    proxies.push(proxy);
    const app = await composePostgresDevelopment({ ...config, databaseUrl: proxy.url }, drivers());
    apps.push(app);
    await app.ready();
    // The first commit acknowledges the credential snapshot. Drop only the real
    // session+audit COMMIT reply, after PostgreSQL has committed those rows.
    proxy.arm({ skipCommits: 1 });
    const unknown = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email, password },
    });
    assert.equal(proxy.observedCommit, true);
    assert.equal(unknown.statusCode, 503, unknown.body);
    assert.equal(unknown.headers["set-cookie"], undefined);
    assert.equal(
      (await observer.query("SELECT count(*)::int AS count FROM occ.session")).rows[0].count,
      1,
    );
    assert.equal(
      (
        await observer.query(
          "SELECT count(*)::int AS count FROM occ.audit_events WHERE action='authentication.login'",
        )
      ).rows[0].count,
      1,
    );
    assert.equal(unknown.json().data, undefined);
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
    const committed = (
      await observer.query("SELECT token FROM occ.session WHERE user_id=$1", [recoveryUserId])
    ).rows[0];
    assert.equal((await persistence.currentSession(committed.token)).user.id, recoveryUserId);
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
        const beforeSessions = (
          await observer.query("SELECT count(*)::int AS count FROM occ.session")
        ).rows[0].count;
        const beforeAudit = (
          await observer.query(
            "SELECT count(*)::int AS count FROM occ.audit_events WHERE action='authentication.login'",
          )
        ).rows[0].count;
        const query = pg.Client.prototype.query;
        let corrupted = false;
        // Alter only the audit transport parameter. PostgreSQL enforces its real
        // constraint; original State owns rollback of the preceding session write.
        auditTest.mock.method(pg.Client.prototype, "query", function (sql, ...args) {
          if (
            !corrupted &&
            typeof sql === "string" &&
            sql.includes("INSERT INTO occ.audit_events")
          ) {
            corrupted = true;
            args[0] = ["invalid-audit-id", ...args[0].slice(1)];
          }
          return query.call(this, sql, ...args);
        });
        const rejected = await ordinary.inject({
          method: "POST",
          url: "/api/auth/sign-in/email",
          payload: { email, password },
        });
        assert.equal(corrupted, true);
        assert.equal(rejected.statusCode, 503, rejected.body);
        assert.equal(rejected.headers["set-cookie"], undefined);
        assert.equal(
          (await observer.query("SELECT count(*)::int AS count FROM occ.session")).rows[0].count,
          beforeSessions,
        );
        assert.equal(
          (
            await observer.query(
              "SELECT count(*)::int AS count FROM occ.audit_events WHERE action='authentication.login'",
            )
          ).rows[0].count,
          beforeAudit,
        );
      },
    );
    const signedIn = await ordinary.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email, password },
    });
    assert.equal(signedIn.statusCode, 200, signedIn.body);
    const cookie = cookieHeaderFromSetCookie(signedIn.headers["set-cookie"]);
    const cookieName = cookie.slice(0, cookie.indexOf("="));
    const ambiguousLogout = await ordinary.inject({
      method: "POST",
      url: "/api/auth/sign-out",
      headers: { cookie: `${cookieName}=malformed; ${cookie}`, origin },
    });
    assert.equal(ambiguousLogout.statusCode, 401, ambiguousLogout.body);
    assert.equal(ambiguousLogout.headers["set-cookie"], undefined);
    assert.equal(
      (await ordinary.inject({ url: "/api/auth/session", headers: { cookie } })).json().data.user
        .id,
      recoveryUserId,
      "rejected ambiguous logout leaves the original session current",
    );
    // A tab pinned to another session cannot end the one this cookie now carries.
    const otherTab = await ordinary.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email, password },
    });
    const otherTabKey = otherTab.json().data.sessionKey;
    const mismatchedLogout = await ordinary.inject({
      method: "POST",
      url: "/api/auth/sign-out",
      headers: { cookie, origin, "x-occ-session-key": otherTabKey },
    });
    assert.equal(mismatchedLogout.statusCode, 401, mismatchedLogout.body);
    assert.equal(mismatchedLogout.headers["set-cookie"], undefined);
    assert.equal(
      (await ordinary.inject({ url: "/api/auth/session", headers: { cookie } })).json().data.user
        .id,
      recoveryUserId,
      "a mismatched session key neither revokes nor clears the current session",
    );
    // The pinned tab can still end its own session.
    const otherTabCookie = cookieHeaderFromSetCookie(otherTab.headers["set-cookie"]);
    const ownLogout = await ordinary.inject({
      method: "POST",
      url: "/api/auth/sign-out",
      headers: { cookie: otherTabCookie, origin, "x-occ-session-key": otherTabKey },
    });
    assert.equal(ownLogout.statusCode, 200, ownLogout.body);
    assert.equal(
      (
        await ordinary.inject({ url: "/api/auth/session", headers: { cookie: otherTabCookie } })
      ).json().data,
      null,
    );
    const logoutProxy = await commitAckProxy(databaseUrl);
    proxies.push(logoutProxy);
    const logout = await composePostgresDevelopment(
      { ...config, databaseUrl: logoutProxy.url },
      drivers(),
    );
    apps.push(logout);
    await logout.ready();
    logoutProxy.arm();
    const unknownLogout = await logout.inject({
      method: "POST",
      url: "/api/auth/sign-out",
      headers: { cookie, origin },
    });
    assert.equal(logoutProxy.observedCommit, true);
    assert.equal(unknownLogout.statusCode, 503, unknownLogout.body);
    assert.equal(
      unknownLogout.headers["set-cookie"],
      undefined,
      "failed acknowledgement must not clear the browser cookie",
    );
    assert.equal(
      (await ordinary.inject({ url: "/api/auth/session", headers: { cookie } })).json().data,
      null,
    );
    assert.equal(
      (
        await observer.query(
          "SELECT count(*)::int AS count FROM occ.audit_events WHERE action='authentication.logout'",
        )
      ).rows[0].count,
      // The pinned tab's own logout above, then this committed-but-unacknowledged one.
      2,
    );

    // Headerless (CLI) sign-out is rejected: sign-out is a cookie mutation and
    // requires the exact configured browser Origin (requireSessionMutationOrigin)
    // before the humanLogin profile's private endpoint runs. Only password
    // sign-in keeps the Origin synthesis for command-line clients.
    const headerlessLogin = await ordinary.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email, password },
    });
    assert.equal(headerlessLogin.statusCode, 200, headerlessLogin.body);
    const headerlessCookie = cookieHeaderFromSetCookie(headerlessLogin.headers["set-cookie"]);
    const headerlessLogout = await ordinary.inject({
      method: "POST",
      url: "/api/auth/sign-out",
      headers: { cookie: headerlessCookie },
    });
    assert.equal(headerlessLogout.statusCode, 403, headerlessLogout.body);
    assert.equal(
      headerlessLogout.headers["set-cookie"],
      undefined,
      "rejected headerless logout must not clear the browser cookie",
    );
    assert.equal(
      (
        await ordinary.inject({ url: "/api/auth/session", headers: { cookie: headerlessCookie } })
      ).json().data.user.id,
      recoveryUserId,
      "rejected headerless logout leaves the session current",
    );
    assert.equal(
      (
        await observer.query(
          "SELECT count(*)::int AS count FROM occ.audit_events WHERE action='authentication.logout'",
        )
      ).rows[0].count,
      // Still only the pinned tab's logout and the unacknowledged one above.
      2,
      "rejected headerless logout writes no logout audit",
    );

    const adminLogin = await ordinary.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email, password },
    });
    assert.equal(adminLogin.statusCode, 200, adminLogin.body);
    const adminHeaders = {
      cookie: cookieHeaderFromSetCookie(adminLogin.headers["set-cookie"]),
      origin,
    };
    const account = await ordinary.inject({
      url: `/api/auth/accounts/${recoveryUserId}`,
      headers: adminHeaders,
    });
    assert.equal(account.statusCode, 200, account.body);
    const expectedVersion = account.json().data.version;
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
    assert.match(unknownAdministration.json().error.message, /outcome is unknown/i);
    assert.equal(unknownAdministration.headers["set-cookie"], undefined);
    assert.equal(
      (
        await observer.query(
          "SELECT count(*)::int AS count FROM occ.audit_events WHERE action='authentication.account.revoke'",
        )
      ).rows[0].count,
      1,
    );
    assert.equal(
      (await ordinary.inject({ url: "/api/auth/session", headers: adminHeaders })).json().data,
      null,
    );

    // A new recovery login can inspect present state. It does not turn the lost
    // response into a receipt or authorize an automatic replay of the old write.
    const recoveryLogin = await ordinary.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email, password },
    });
    assert.equal(recoveryLogin.statusCode, 200, recoveryLogin.body);
    const recoveredHeaders = {
      cookie: cookieHeaderFromSetCookie(recoveryLogin.headers["set-cookie"]),
      origin,
    };
    const observed = await ordinary.inject({
      url: `/api/auth/accounts/${recoveryUserId}`,
      headers: recoveredHeaders,
    });
    assert.equal(observed.statusCode, 200, observed.body);
    assert.equal(observed.headers["cache-control"], "no-store");
    assert.equal(observed.json().data.version, expectedVersion + 1);
    const stale = await ordinary.inject({
      method: "POST",
      url: `/api/auth/accounts/${recoveryUserId}/revoke`,
      headers: recoveredHeaders,
      payload: { expectedVersion },
    });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(
      (
        await observer.query(
          "SELECT count(*)::int AS count FROM occ.audit_events WHERE action='authentication.account.revoke'",
        )
      ).rows[0].count,
      1,
    );

    await t.test(
      "a lost GitHub session COMMIT reply preserves the committed login without identity denial",
      async (callbackTest) => {
        const attached = await ordinary.inject({
          method: "POST",
          url: `/api/auth/accounts/${recoveryUserId}/providers/github`,
          headers: recoveredHeaders,
          payload: {
            subject: "12345678",
            expectedVersion: observed.json().data.version,
          },
        });
        assert.equal(attached.statusCode, 200, attached.body);
        const originalFetch = globalThis.fetch;
        let exchanges = 0;
        callbackTest.mock.method(globalThis, "fetch", async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : input);
          if (url.href === "https://github.com/login/oauth/access_token") {
            exchanges += 1;
            return Response.json({
              access_token: "fixture-provider-token",
              token_type: "bearer",
              scope: "read:user",
            });
          }
          if (url.href === "https://api.github.com/user") {
            return Response.json({ id: 12345678 });
          }
          return originalFetch(input, init);
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
          url: "/api/auth/providers/github/start",
          headers: { origin },
        });
        assert.equal(started.statusCode, 200, started.body);
        const state = new URL(started.json().data.url).searchParams.get("state");
        async function counts() {
          return (
            await observer.query(`SELECT
              (SELECT count(*)::int FROM occ.session) AS sessions,
              (SELECT count(*)::int FROM occ.audit_events
                WHERE action='authentication.login' AND outcome='success') AS logins,
              (SELECT count(*)::int FROM occ.audit_events
                WHERE action='authentication.login' AND outcome='denied') AS denials`)
          ).rows[0];
        }
        const before = await counts();
        // Consume the attempt and capture the enrolled method first. The third
        // real COMMIT writes the session, method binding and successful audit.
        callbackProxy.arm({ skipCommits: 2 });
        const unknownCallback = await callbackApp.inject({
          url: `/api/auth/providers/github/callback?state=${state}&code=fixture-code`,
          headers: { cookie: cookieHeaderFromSetCookie(started.headers["set-cookie"]) },
        });
        assert.equal(callbackProxy.observedCommit, true);
        assert.equal(unknownCallback.statusCode, 302);
        assert.equal(unknownCallback.headers.location, "/console/?authError=github");
        assert.equal(unknownCallback.headers["set-cookie"], undefined);
        assert.equal(exchanges, 1, "the uncertain operation is not replayed");
        assert.deepEqual(await counts(), {
          sessions: before.sessions + 1,
          logins: before.logins + 1,
          denials: before.denials,
        });
      },
    );
  },
);
