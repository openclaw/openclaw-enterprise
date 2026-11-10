import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { commitAckProxy } from "../fixtures/postgres-commit-ack-proxy.mjs";
import {
  consoleOrigin as origin,
  oidcUpgradeSettings,
  oidcSignIn,
  assertConsoleSignIn,
  signedInHeaders,
  changeAccount,
  currentSession,
} from "../helpers/production-sign-in.mjs";
import { cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";
import { preparePostgresSignInInstallation } from "../helpers/postgres-sign-in-installation.mjs";

test(
  "OIDC linking proves an existing owner before attaching an identity in PostgreSQL",
  requiresPostgres,
  async (t) => {
    const apps: Awaited<
      ReturnType<Awaited<ReturnType<typeof preparePostgresSignInInstallation>>["composeApp"]>
    >[] = [];
    const fixture = await preparePostgresSignInInstallation(t, () => apps, {
      email: "link-recovery@example.test",
      password: "linking-test-password",
      secrets: {
        "occ-auth/secret": "linking-test-auth-secret-at-least-32-bytes",
        "occ-oidc-login/client-id": "linking-client",
        "occ-oidc-login/client-secret": "linking-client-secret",
      },
      oidc: true,
    });
    const { admin, accounts } = (await fixture.onboard({
      accounts: {
        member: { email: "link-member@example.test" },
        other: { email: "link-other@example.test" },
      },
    })) as Awaited<ReturnType<typeof fixture.onboard>> & {
      admin: { id: string; email: string; password: string };
      accounts: Record<"member" | "other", { id: string; email: string; password: string }>;
    };
    const settings = { ...oidcUpgradeSettings(admin.id), OCC_AUTH_OIDC_LINKING_ENABLED: "true" };
    let app = await fixture.composeApp(settings);
    const second = await fixture.composeApp(settings);
    apps.push(app, second);
    const provider = fixture.oidc!;
    const member = accounts.member;
    const other = accounts.other;
    const adminHeaders = await signedInHeaders(app, origin, admin);
    const oldSession = await signedInHeaders(app, origin, member);
    const before = await fixture.pool.query(
      "SELECT id, user_id, provider_id FROM occ.account ORDER BY id",
    );
    const beforeGrants = await fixture.pool.query(
      "SELECT * FROM occ.iam_access_bindings ORDER BY id",
    );
    let cookie = "";
    const merge = (value: string | string[] | undefined) => {
      const values = new Map(
        cookie
          .split("; ")
          .filter(Boolean)
          .map((part) => {
            const split = part.indexOf("=");
            return [part.slice(0, split), part.slice(split + 1)];
          }),
      );
      for (const part of cookieHeaderFromSetCookie(value).split("; ").filter(Boolean)) {
        const split = part.indexOf("=");
        values.set(part.slice(0, split), part.slice(split + 1));
      }
      cookie = [...values].map(([key, value]) => `${key}=${value}`).join("; ");
    };
    const post = async (action: string, payload?: object, server = app) => {
      const response = await server.inject({
        method: "POST",
        url: `/api/auth/oidc/link/${action}`,
        headers: { origin, cookie },
        ...(payload ? { payload } : {}),
      });
      merge(response.headers["set-cookie"]);
      return response;
    };
    const start = async (owner = member) => {
      cookie = "";
      assert.equal((await post("start")).statusCode, 200);
      const password = await post("password", { email: owner.email, password: owner.password });
      assert.equal(password.statusCode, 200, password.body);
    };
    const external = async (
      purpose: "owner" | "candidate",
      subject: string,
      claims: Record<string, unknown> = { auth_time: Math.floor(Date.now() / 1000) },
      server = second,
    ) => {
      const started = await post(purpose);
      assert.equal(started.statusCode, 200, started.body);
      const url = started.json().data.url;
      assert.equal(new URL(url).searchParams.get("max_age"), "0");
      const code = provider.authorize(url, { subject, claims });
      const callback = await server.inject({
        url: `/api/auth/providers/oidc/callback?state=${new URL(url).searchParams.get("state")}&code=${code}`,
        headers: { cookie },
      });
      merge(callback.headers["set-cookie"]);
      return callback;
    };

    await t.test(
      "linking password refusals spend admission budget when their audit cannot be written",
      async (auditTest) => {
        const query = pg.Client.prototype.query;
        let refusedAudits = 0;
        auditTest.mock.method(
          pg.Client.prototype,
          "query",
          function (this: pg.Client, sql: unknown, ...args: unknown[]) {
            // Fail the real denial INSERT through its database constraint, after
            // credentials have been rejected. A dependency outage must not erase the guess.
            if (
              typeof sql === "string" &&
              sql.includes("INSERT INTO occ.audit_events") &&
              Array.isArray(args[0]) &&
              args[0][4] === "authentication.login" &&
              args[0][8] === "denied"
            ) {
              refusedAudits += 1;
              args[0] = ["invalid-audit-id", ...args[0].slice(1)];
            }
            return Reflect.apply(query, this, [sql, ...args]);
          },
        );
        const guess = { email: "link-guess@example.test", password: "wrong-linking-password" };
        for (let attempt = 0; attempt < 10; attempt += 1) {
          assert.equal((await post("start")).statusCode, 200);
          assert.equal((await post("password", guess)).statusCode, 503);
          assert.equal(
            (await fixture.pool.query("SELECT 1 FROM occ.human_authentication_links")).rowCount,
            0,
            "a rejected password consumes the linking attempt even when auditing fails",
          );
        }
        assert.equal((await post("start")).statusCode, 200);
        assert.equal((await post("password", guess)).statusCode, 429);
        assert.equal(
          refusedAudits,
          10,
          "exhausted admission does not attempt another denial write",
        );
        assert.equal((await post("cancel")).statusCode, 200);
      },
    );
    await t.test(
      "fresh proofs and explicit confirmation preserve the account and grants",
      async () => {
        await start();
        assert.equal((await post("confirm")).statusCode, 409, "one proof is insufficient");
        await start();
        assert.equal(
          (await external("candidate", "new-member")).headers.location,
          "/console/?link=1",
        );
        const status = await post("status", undefined, second);
        assert.equal(status.json().data.account.id, member.id);
        assert.equal(status.json().data.candidate.subject, "new-member");
        assert.deepEqual(
          (await fixture.pool.query("SELECT id, user_id, provider_id FROM occ.account ORDER BY id"))
            .rows,
          before.rows,
          "proof alone attaches nothing",
        );
        const confirmed = await post("confirm", undefined, second);
        assert.equal(confirmed.statusCode, 200, confirmed.body);
        assert.equal(confirmed.json().data.created, true);
        assert.equal((await post("confirm")).statusCode, 409, "confirmation is one use");
        assert.equal(await currentSession(app, oldSession.cookie), null);
        assert.deepEqual(
          (await fixture.pool.query("SELECT * FROM occ.iam_access_bindings ORDER BY id")).rows,
          beforeGrants.rows,
        );
        const signedIn = await oidcSignIn(app, origin, provider, { subject: "new-member" });
        await assertConsoleSignIn(app, signedIn.callback, member.id);
        const audit = await fixture.pool.query(
          "SELECT details FROM occ.audit_events WHERE action = 'authentication.method.attach'",
        );
        assert.equal(audit.rows.at(-1)?.details.source, "self-service");
      },
    );
    await t.test("signed freshness is required even with a matching verified email", async () => {
      for (const claims of [
        { email: other.email, email_verified: true },
        { auth_time: Math.floor(Date.now() / 1000) - 120 },
        { auth_time: Math.floor(Date.now() / 1000) + 120 },
      ]) {
        await start(other);
        const response = await external("candidate", "stale-identity", claims);
        assert.match(response.headers.location!, /authError=oidc/);
        assert.equal((await post("confirm")).statusCode, 409);
      }
      assert.equal(
        (await fixture.pool.query("SELECT 1 FROM occ.account WHERE account_id = 'stale-identity'"))
          .rowCount,
        0,
      );
    });
    await t.test(
      "another account cannot claim an attached identity and concurrent confirms cannot replay",
      async () => {
        await start(other);
        await external("candidate", "new-member");
        assert.equal((await post("confirm")).statusCode, 409);
        await start(other);
        await external("candidate", "other-identity");
        const results = await Promise.all([post("confirm"), post("confirm", undefined, second)]);
        assert.deepEqual(results.map((result) => result.statusCode).sort(), [200, 409]);
        assert.equal(
          (
            await fixture.pool.query(
              "SELECT 1 FROM occ.account WHERE account_id = 'other-identity'",
            )
          ).rowCount,
          1,
        );
      },
    );
    await t.test(
      "administrative invalidation and linking enforce both transaction orderings",
      async () => {
        for (const operation of ["disable", "revoke", "detach"] as const) {
          for (const administrativeFirst of [true, false]) {
            const ownerSubject = `owner-${operation}-${administrativeFirst}`;
            const candidateSubject = `candidate-${operation}-${administrativeFirst}`;
            await start();
            await external("candidate", ownerSubject);
            assert.equal((await post("confirm")).statusCode, 200);
            const session = await signedInHeaders(app, origin, member);
            const account = (
              await app.inject({ url: `/api/auth/accounts/${member.id}`, headers: adminHeaders })
            ).json().data;
            const method = account.methods.find(
              (value: { subject?: string }) => value.subject === ownerSubject,
            );
            assert.ok(method);
            const action = operation === "detach" ? `methods/${method.methodId}/detach` : operation;
            cookie = "";
            assert.equal((await post("start")).statusCode, 200);
            await external("owner", ownerSubject);
            await external("candidate", candidateSubject);

            // Exercise each serialized outcome. A stale administrator version cannot
            // overwrite a completed link; an earlier invalidation defeats its proof.
            if (administrativeFirst) {
              assert.equal(
                (await changeAccount(second, adminHeaders, member.id, action, account.version))
                  .statusCode,
                200,
              );
              assert.equal((await post("confirm")).statusCode, 409);
            } else {
              assert.equal((await post("confirm")).statusCode, 200);
              assert.equal(
                (await changeAccount(second, adminHeaders, member.id, action, account.version))
                  .statusCode,
                409,
              );
              assert.equal(
                (await changeAccount(second, adminHeaders, member.id, action)).statusCode,
                200,
              );
            }
            assert.equal(await currentSession(app, session.cookie), null);
            assert.equal(
              (
                await fixture.pool.query("SELECT 1 FROM occ.account WHERE account_id = $1", [
                  candidateSubject,
                ])
              ).rowCount,
              administrativeFirst ? 0 : 1,
            );
            if (operation === "disable") {
              // Disabling the owner does not make its external identity claimable.
              await start(other);
              await external("candidate", ownerSubject);
              assert.equal((await post("confirm")).statusCode, 409);
              assert.equal(
                (await changeAccount(second, adminHeaders, member.id, "enable")).statusCode,
                200,
              );
            }
          }
        }
      },
    );
    await t.test(
      "audit constraint failure rolls back attachment and session revocation",
      async (auditTest) => {
        await start();
        await external("candidate", "audit-failure-identity");
        const session = await signedInHeaders(app, origin, member);
        const before = (
          await fixture.pool.query(
            "SELECT version FROM occ.human_authentication_accounts WHERE user_id = $1",
            [member.id],
          )
        ).rows;
        const query = pg.Client.prototype.query;
        let corrupted = false;
        auditTest.mock.method(
          pg.Client.prototype,
          "query",
          function (this: pg.Client, sql: unknown, ...args: unknown[]) {
            // Reject the real final audit INSERT through its database constraint.
            if (
              !corrupted &&
              typeof sql === "string" &&
              sql.includes("INSERT INTO occ.audit_events") &&
              Array.isArray(args[0]) &&
              args[0][4] === "authentication.method.attach"
            ) {
              corrupted = true;
              args[0] = ["invalid-audit-id", ...args[0].slice(1)];
            }
            return Reflect.apply(query, this, [sql, ...args]);
          },
        );
        assert.equal((await post("confirm")).statusCode, 503);
        assert.equal(corrupted, true);
        assert.equal(
          (
            await fixture.pool.query(
              "SELECT 1 FROM occ.account WHERE account_id = 'audit-failure-identity'",
            )
          ).rowCount,
          0,
        );
        assert.deepEqual(
          (
            await fixture.pool.query(
              "SELECT version FROM occ.human_authentication_accounts WHERE user_id = $1",
              [member.id],
            )
          ).rows,
          before,
        );
        assert.equal((await currentSession(app, session.cookie)).user.id, member.id);
      },
    );
    await t.test(
      "lost COMMIT acknowledgement keeps one durable attachment and fresh restart is a no-op",
      async () => {
        const proxy = await commitAckProxy(databaseUrl);
        const uncertain = await fixture.composeApp(settings, { databaseUrl: proxy.url });
        try {
          await start();
          await external("candidate", "uncertain-identity");
          const before = (
            await fixture.pool.query(
              "SELECT version FROM occ.human_authentication_accounts WHERE user_id = $1",
              [member.id],
            )
          ).rows[0].version;
          proxy.arm();
          const result = await post("confirm", undefined, uncertain);
          assert.equal(proxy.observedCommit, true);
          assert.equal(result.statusCode, 503);
          assert.equal(result.headers["set-cookie"], undefined);
          assert.equal(
            (
              await fixture.pool.query(
                "SELECT 1 FROM occ.account WHERE account_id = 'uncertain-identity'",
              )
            ).rowCount,
            1,
          );
          const committed = (
            await fixture.pool.query(
              "SELECT version FROM occ.human_authentication_accounts WHERE user_id = $1",
              [member.id],
            )
          ).rows[0].version;
          assert.equal(committed, before + 1);
          // Recovery uses the original password through a new explicit flow, never JIT login.
          await start();
          await external("candidate", "uncertain-identity");
          const repeated = await post("confirm");
          assert.equal(repeated.statusCode, 200);
          assert.equal(repeated.json().data.created, false);
          assert.equal(
            (
              await fixture.pool.query(
                "SELECT version FROM occ.human_authentication_accounts WHERE user_id = $1",
                [member.id],
              )
            ).rows[0].version,
            committed,
          );
        } finally {
          await uncertain.close();
          await proxy.close();
        }
      },
    );
    await t.test("wrong browser, origin and cancellation fail closed", async () => {
      await start();
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/auth/oidc/link/confirm",
            headers: { origin },
          })
        ).statusCode,
        401,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/auth/oidc/link/password",
            headers: { cookie, origin: "https://foreign.example.test" },
            payload: { email: member.email, password: member.password },
          })
        ).statusCode,
        403,
      );
      assert.equal((await post("cancel")).statusCode, 200);
      assert.equal((await post("confirm")).statusCode, 409);
    });
    await t.test("proof expiry during an account lock wait rolls back confirmation", async () => {
      await start();
      await external("candidate", "expired-during-lock");
      // Retain a valid, short proof and hold the real account lock past its deadline.
      await fixture.pool.query(
        "UPDATE occ.human_authentication_links SET owner_expires_at = clock_timestamp() + interval '1 second' WHERE owner_user_id = $1",
        [member.id],
      );
      const blocker = await fixture.pool.connect();
      let confirmation: ReturnType<typeof post> | undefined;
      try {
        await blocker.query("BEGIN");
        await blocker.query('SELECT id FROM occ."user" WHERE id = $1 FOR UPDATE', [member.id]);
        confirmation = post("confirm", undefined, second);
        await blocker.query("SELECT pg_sleep(1.2)");
        await blocker.query("COMMIT");
        assert.equal((await confirmation).statusCode, 409);
        assert.equal(
          (
            await fixture.pool.query(
              "SELECT 1 FROM occ.account WHERE account_id = 'expired-during-lock'",
            )
          ).rowCount,
          0,
        );
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
        await confirmation;
      }
    });
    await t.test("two accounts racing for one identity produce one attachment", async () => {
      await start(member);
      await external("candidate", "contested-identity");
      const firstCookie = cookie;
      await start(other);
      await external("candidate", "contested-identity");
      const secondCookie = cookie;
      const results = await Promise.all(
        [firstCookie, secondCookie].map((bound, index) =>
          (index === 0 ? app : second).inject({
            method: "POST",
            url: "/api/auth/oidc/link/confirm",
            headers: { origin, cookie: bound },
          }),
        ),
      );
      assert.deepEqual(results.map((result) => result.statusCode).sort(), [200, 409]);
      assert.equal(
        (
          await fixture.pool.query(
            "SELECT 1 FROM occ.account WHERE account_id = 'contested-identity'",
          )
        ).rowCount,
        1,
      );
    });
    await t.test(
      "linking is independent of JIT creation and never copies email or grants",
      async () => {
        app = await fixture.composeApp({
          ...settings,
          OCC_AUTH_OIDC_ENROLLMENT: JSON.stringify({
            admission: { groupsClaim: "groups", anyOf: ["allowed"] },
            createAccount: { enabled: true, role: null },
            groupIds: [],
          }),
        });
        apps.push(app);
        const users = (
          await fixture.pool.query('SELECT id, email, name FROM occ."user" ORDER BY id')
        ).rows;
        const grants = (
          await fixture.pool.query("SELECT * FROM occ.iam_access_bindings ORDER BY id")
        ).rows;
        await start();
        await external(
          "candidate",
          "jit-link-no-email",
          { groups: ["allowed"], auth_time: Math.floor(Date.now() / 1000) },
          app,
        );
        assert.equal((await post("confirm")).statusCode, 200);
        assert.deepEqual(
          (await fixture.pool.query('SELECT id, email, name FROM occ."user" ORDER BY id')).rows,
          users,
        );
        assert.deepEqual(
          (await fixture.pool.query("SELECT * FROM occ.iam_access_bindings ORDER BY id")).rows,
          grants,
        );
        await start();
        await external(
          "candidate",
          "jit-denied",
          { auth_time: Math.floor(Date.now() / 1000), email: member.email, email_verified: true },
          app,
        );
        assert.equal((await post("confirm")).statusCode, 409);
        assert.equal(
          (await fixture.pool.query("SELECT 1 FROM occ.account WHERE account_id='jit-denied'"))
            .rowCount,
          0,
        );
      },
    );
    await t.test(
      "policy changes, wrong proof order and recovery-only passwords are refused",
      async () => {
        await start();
        assert.equal(
          (await post("status", undefined, second)).statusCode,
          409,
          "a differently configured controller cannot accept the proofs",
        );
        app = await fixture.composeApp({ ...settings, OCC_AUTH_PASSWORD_SIGN_IN: "recovery-only" });
        apps.push(app);
        cookie = "";
        assert.equal((await post("start")).statusCode, 200);
        assert.equal(
          (await post("candidate")).statusCode,
          409,
          "candidate proof cannot precede the owner",
        );
        assert.equal((await post("start")).statusCode, 200);
        assert.equal(
          (await post("password", { email: member.email, password: member.password })).statusCode,
          401,
        );
        assert.equal((await post("status")).statusCode, 409);
        const disabled = await fixture.composeApp(oidcUpgradeSettings(admin.id));
        apps.push(disabled);
        assert.equal((await post("start", undefined, disabled)).statusCode, 403);
        assert.equal(
          (await disabled.inject({ url: "/api/auth/providers" })).json().data.oidcLinking,
          undefined,
        );
      },
    );
  },
);
