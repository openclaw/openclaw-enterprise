import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import {
  assertReservedLane,
  attachProvider,
  clientAddresses,
  composeProductionSignIn,
  consoleOrigin as origin,
  githubSignIn,
  githubUpgradeSettings,
  memoryLogger,
  onboardPasswordAccounts,
  readAccount,
  signedInHeaders,
  startFakeGitHub,
} from "../helpers/production-sign-in.mjs";
import { cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

const adminEmail = "replacement-recovery@example.test";
const password = "replacement-member-password";
const authSecret = "replacement-auth-test-secret-at-least-32-bytes";
const secrets = {
  "occ-auth/secret": authSecret,
  "occ-github-login/client-id": "replacement-client-id",
  "occ-github-login/client-secret": "replacement-client-secret",
};
const secondSubject = "9200002";

// Online recovery replacement (#520): the reserved password lane follows the stored
// designation at once, and a controller restarted with the original
// OCC_AUTH_GITHUB_RECOVERY_USER_ID keeps that designation instead of the seed.
test(
  "online recovery replacement moves the reserved lane and survives a restart with the original seed",
  requiresPostgres,
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const state = new PostgresPlatformState(pool);
    let app;
    t.after(async () => {
      await app?.close();
      await pool.end();
    });
    await startFakeGitHub(t);
    const address = clientAddresses();
    const {
      admin,
      accounts: { second, third, member },
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
        second: { email: "replacement-second@example.test", role: "admin" },
        third: { email: "replacement-third@example.test", role: "admin" },
        member: { email: "replacement-member@example.test" },
      },
    });
    app = await composeProductionSignIn(t, {
      databaseUrl,
      settings: githubUpgradeSettings(admin.id),
      secrets,
    });
    let adminHeaders = await signedInHeaders(app, origin, admin, address());
    const readRecovery = async (headers) => {
      const response = await app.inject({ url: "/api/auth/recovery", headers });
      assert.equal(response.statusCode, 200, response.body);
      return response.json().data;
    };
    const replace = (headers, body) =>
      app.inject({ method: "POST", url: "/api/auth/recovery", headers, payload: body });
    const designations = async () =>
      (await pool.query("SELECT user_id FROM occ.human_authentication_recovery")).rows.map(
        ({ user_id }) => user_id,
      );

    // The second administrator works through GitHub while it is up.
    const attached = await attachProvider(app, adminHeaders, second.id, "github", secondSubject);
    assert.equal(attached.statusCode, 200, attached.body);
    const { callback } = await githubSignIn(app, origin, secondSubject, address());
    assert.equal(callback.headers.location, "/console/", callback.body);
    const secondHeaders = {
      cookie: cookieHeaderFromSetCookie(callback.headers["set-cookie"]),
      origin,
    };

    let holder;
    await t.test(
      "guarded replacement refuses stale, unauthorized and non-admin moves",
      async () => {
        assert.equal((await readRecovery(secondHeaders)).userId, admin.id);
        const version = (await readAccount(app, adminHeaders, third.id)).version;
        const body = {
          userId: third.id,
          expectedCurrentUserId: admin.id,
          expectedVersion: version,
        };
        assert.equal((await replace({ cookie: secondHeaders.cookie }, body)).statusCode, 403);
        const taken = await replace(secondHeaders, body);
        assert.equal(taken.statusCode, 403, "a narrower administrator cannot take it");
        assert.equal(taken.json().error.code, "FORBIDDEN");
        assert.equal(
          (await replace(secondHeaders, { ...body, expectedCurrentUserId: second.id })).statusCode,
          409,
          "a stale expected holder is refused",
        );
        assert.equal(
          (await replace(adminHeaders, { ...body, expectedVersion: version + 1 })).statusCode,
          409,
          "a stale target version is refused",
        );
        const readerVersion = (await readAccount(app, adminHeaders, member.id)).version;
        assert.equal(
          (
            await replace(adminHeaders, {
              userId: member.id,
              expectedCurrentUserId: admin.id,
              expectedVersion: readerVersion,
            })
          ).statusCode,
          409,
          "the holder must administer the Installation",
        );
        assert.deepEqual(await designations(), [admin.id]);
      },
    );

    await t.test("of two concurrent replacements exactly one commits", async () => {
      const [toSecond, toThird] = await Promise.all([
        replace(adminHeaders, {
          userId: second.id,
          expectedCurrentUserId: admin.id,
          expectedVersion: (await readAccount(app, adminHeaders, second.id)).version,
        }),
        replace(adminHeaders, {
          userId: third.id,
          expectedCurrentUserId: admin.id,
          expectedVersion: (await readAccount(app, adminHeaders, third.id)).version,
        }),
      ]);
      const statuses = [toSecond.statusCode, toThird.statusCode].sort();
      assert.deepEqual(statuses, [200, 409], `${toSecond.body} ${toThird.body}`);
      holder = toSecond.statusCode === 200 ? second : third;
      assert.equal((toSecond.statusCode === 200 ? toSecond : toThird).json().data.changed, true);
      assert.deepEqual(await designations(), [holder.id]);
      assert.equal((await readRecovery(adminHeaders)).userId, holder.id);
      const audits = (await state.transact((unit) => unit.audit.list())).filter(
        ({ action }) => action === "authentication.recovery.replace",
      );
      assert.equal(audits.length, 1);
    });

    await t.test("a created administrator moves it between accounts it covers", async () => {
      const next = holder === second ? third : second;
      const moved = await replace(secondHeaders, {
        userId: next.id,
        expectedCurrentUserId: holder.id,
        expectedVersion: (await readAccount(app, adminHeaders, next.id)).version,
      });
      assert.equal(moved.statusCode, 200, moved.body);
      holder = next;
      assert.deepEqual(await designations(), [holder.id]);
    });

    await t.test(
      "the new holder keeps a checkable password when strangers spend its email",
      async () => {
        const lane = await assertReservedLane(app, {
          origin,
          holder,
          former: admin,
          label: "online",
        });
        // The former holder still administers the Installation, so it stays reserved too.
        assert.deepEqual(lane, { fresh: 429, former: 200, holder: 200 });
        assert.equal(
          (
            await app.inject({
              method: "POST",
              url: `/api/auth/accounts/${holder.id}/disable`,
              headers: adminHeaders,
              payload: {
                expectedVersion: (await readAccount(app, adminHeaders, holder.id)).version,
              },
            })
          ).statusCode,
          409,
          "the new holder is protected like the recovery account",
        );
      },
    );

    await t.test(
      "a restart with the original seed keeps the stored designation and warns",
      async () => {
        await app.close();
        app = undefined;
        const log = memoryLogger();
        app = await composeProductionSignIn(t, {
          databaseUrl,
          settings: githubUpgradeSettings(admin.id),
          secrets,
          logger: log.logger,
        });
        assert.deepEqual(
          log.events
            .filter(({ event }) => event.startsWith("authentication."))
            .map(({ event }) => event),
          // The fixture sets no trusted proxy, so startup also warns about the shared address.
          ["authentication.recovery-seed-warning", "authentication.sign-in-limit-warning"],
        );
        assert.deepEqual(await designations(), [holder.id]);
        adminHeaders = await signedInHeaders(app, origin, admin, address());
        assert.equal((await readRecovery(adminHeaders)).userId, holder.id);
        const lane = await assertReservedLane(app, {
          origin,
          holder,
          former: admin,
          label: "restarted",
        });
        assert.deepEqual(lane, { fresh: 429, former: 200, holder: 200 });
      },
    );
  },
);
