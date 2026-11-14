import assert from "node:assert/strict";
import test from "node:test";
import type { PasswordSlowLaneFloors } from "../../apps/controller/src/auth/index.ts";
import type { HumanAuthenticationRecovery } from "../../packages/occ/src/index.ts";
import { cookieHeaderFromSetCookie } from "../../packages/utils/src/http.ts";
import { assertApiError } from "../helpers/api-error.mjs";
import {
  assertProviderAttached,
  assertReservedLane,
  clientAddresses,
  consoleOrigin as origin,
  oidcUpgradeSettings,
  memoryLogger,
} from "../helpers/production-sign-in.mjs";
import {
  authOperation,
  changeAccount,
  first,
  oidcSignIn,
  onboarded,
  parseAuthResponse,
  passwordSignIn,
  readAccount,
  record,
  recordData,
  signedInHeaders,
  text,
  type FixtureAccount,
  type SignInApp,
} from "../helpers/postgres-sign-in-test-boundaries.ts";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { preparePostgresSignInInstallation } from "../helpers/postgres-sign-in-installation.mjs";

const secondSubject = "9200002";
// The production slow lane with shorter floors (250 ms doubling to a 500 ms cap instead of
// 1 s doubling to 8 s). This suite spends password budgets but does not measure pacing, and
// each reserved-lane check waits about 5 s of real floors otherwise.
const slowLane: PasswordSlowLaneFloors = { floorMs: 250, maxFloorMs: 500 };

type QueryRecoveryRow = { user_id: unknown; principal_id: unknown; method_id: unknown };

type RecoveryReplacement = {
  userId: string;
  expectedCurrentUserId: string;
  expectedVersion: number;
};

function recoveryDesignation(data: Record<string, unknown>): HumanAuthenticationRecovery {
  return {
    userId: text(data.userId),
    principalId: text(data.principalId),
    methodId: text(data.methodId),
  };
}

// Online recovery replacement (#520): the reserved password lane follows the stored
// designation at once, and a controller restarted with the original
// OCC_AUTH_RECOVERY_USER_ID keeps that designation instead of the seed.
test(
  "online recovery replacement moves the reserved lane and survives a restart with the original seed",
  requiresPostgres,
  async (t) => {
    let app: SignInApp | undefined;
    const { pool, state, oidc, onboard, composeApp } = await preparePostgresSignInInstallation(
      t,
      () => [app],
      {
        oidc: true,
        email: "replacement-recovery@example.test",
        password: "replacement-member-password",
        secrets: {
          "occ-auth/secret": "replacement-auth-test-secret-at-least-32-bytes",
          "occ-oidc-login/client-id": "replacement-client-id",
          "occ-oidc-login/client-secret": "replacement-client-secret",
        },
      },
    );
    assert.ok(oidc);
    const address = clientAddresses();
    const activeApp = () => {
      assert.ok(app, "the controller is running");
      return app;
    };
    const {
      admin,
      accounts: { second, third, member },
    } = onboarded(
      await authOperation("onboard accounts", () =>
        onboard({
          remoteAddress: address(),
          accounts: {
            second: { email: "replacement-second@example.test", role: "admin" },
            third: { email: "replacement-third@example.test", role: "admin" },
            member: { email: "replacement-member@example.test" },
          },
        }),
      ),
      ["second", "third", "member"],
    );
    const settings = oidcUpgradeSettings(admin.id);
    const recoveryOnly = {
      ...settings,
      OCC_AUTH_PASSWORD_SIGN_IN: "recovery-only",
    };
    app = await composeApp(settings, { passwordSlowLaneFloors: slowLane });
    const adminHeaders = await authOperation("sign in the initial holder", () =>
      signedInHeaders(activeApp(), origin, admin, address()),
    );
    const readRecovery = async (headers: Record<string, string>) => {
      const response = await activeApp().inject({ url: "/api/auth/recovery", headers });
      assert.equal(response.statusCode, 200);
      return recoveryDesignation(recordData(parseAuthResponse("recovery read", response)));
    };
    const replace = (headers: Record<string, string>, body: RecoveryReplacement) =>
      activeApp().inject({ method: "POST", url: "/api/auth/recovery", headers, payload: body });
    const designations = async () => {
      const { rows } = await pool.query<QueryRecoveryRow>(
        "SELECT user_id, principal_id, method_id FROM occ.human_authentication_recovery",
      );
      return rows.map(({ user_id, principal_id, method_id }) =>
        recoveryDesignation({ userId: user_id, principalId: principal_id, methodId: method_id }),
      );
    };

    // Keep the initial holder's session for administration after the password designation moves.
    // The delegated administrator signs in through its attached OIDC identity.
    await authOperation("attach the delegated administrator", () =>
      assertProviderAttached(activeApp(), adminHeaders, second.id, "oidc", secondSubject),
    );
    const { callback } = await authOperation("sign in the delegated administrator", () =>
      oidcSignIn(activeApp(), origin, oidc, { subject: secondSubject }, address()),
    );
    assert.equal(callback.headers.location, "/console/");
    const cookie = cookieHeaderFromSetCookie(callback.headers["set-cookie"]);
    assert.ok(cookie.length > 0, "OIDC issues a session cookie");
    const secondHeaders = { cookie, origin };
    const original = await readRecovery(adminHeaders);
    assert.equal(original.userId, admin.id);

    let holder: FixtureAccount | undefined;
    const currentHolder = () => {
      assert.ok(holder, "a replacement committed");
      return holder;
    };
    const flood = (label: string) =>
      authOperation("spend the password budgets", () =>
        assertReservedLane(activeApp(), { origin, holder: currentHolder(), former: admin, label }),
      );
    const restart = async (passwordPolicy: typeof settings) => {
      const log = memoryLogger();
      await activeApp().close();
      app = undefined;
      app = await composeApp(passwordPolicy, {
        logger: log.logger,
        passwordSlowLaneFloors: slowLane,
      });
      const logged: readonly unknown[] = log.events;
      return logged
        .map((entry) => text(record(entry).event))
        .filter((event) => event.startsWith("authentication."));
    };
    await t.test(
      "guarded replacement refuses stale, unauthorized and non-admin moves",
      async () => {
        assert.equal((await readRecovery(secondHeaders)).userId, admin.id);
        const version = (await readAccount(activeApp(), adminHeaders, third.id)).version;
        const body = {
          userId: third.id,
          expectedCurrentUserId: admin.id,
          expectedVersion: version,
        };
        assert.equal((await replace({ cookie: secondHeaders.cookie }, body)).statusCode, 403);
        const taken = await replace(secondHeaders, body);
        assertApiError(taken, 403, "FORBIDDEN", "a narrower administrator cannot take it");
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
        const readerVersion = (await readAccount(activeApp(), adminHeaders, member.id)).version;
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
        assert.deepEqual(await designations(), [original]);
      },
    );

    await t.test("of two concurrent replacements exactly one commits", async () => {
      // Read both versions before either write so the requests compete from the same snapshot.
      const [secondAccount, thirdAccount] = await Promise.all([
        readAccount(activeApp(), adminHeaders, second.id),
        readAccount(activeApp(), adminHeaders, third.id),
      ]);
      const [toSecond, toThird] = await Promise.all([
        replace(adminHeaders, {
          userId: second.id,
          expectedCurrentUserId: admin.id,
          expectedVersion: secondAccount.version,
        }),
        replace(adminHeaders, {
          userId: third.id,
          expectedCurrentUserId: admin.id,
          expectedVersion: thirdAccount.version,
        }),
      ]);
      assert.deepEqual(
        [toSecond.statusCode, toThird.statusCode].sort((a, b) => a - b),
        [200, 409],
      );
      const secondWon = toSecond.statusCode === 200;
      const winner = secondWon ? secondAccount : thirdAccount;
      const result = recordData(
        parseAuthResponse("recovery replacement", secondWon ? toSecond : toThird),
      );
      assert.equal(result.changed, true);
      const designation = recoveryDesignation(result);
      assert.equal(designation.userId, winner.userId);
      assert.equal(designation.principalId, winner.principalId);
      holder = secondWon ? second : third;
      assert.deepEqual(await designations(), [designation]);
      assert.deepEqual(await readRecovery(adminHeaders), designation);

      const audits = (await state.transact((unit) => unit.audit.list())).filter(
        ({ action }) => action === "authentication.recovery.replace",
      );
      assert.equal(audits.length, 1);
      const audit = first(audits);
      assert.equal(audit.outcome, "success");
      assert.equal(audit.actorId, original.principalId);
      assert.deepEqual(audit.details, {
        userId: designation.userId,
        principalId: designation.principalId,
        previousUserId: original.userId,
        previousPrincipalId: original.principalId,
      });
    });

    await t.test("a created administrator moves it between accounts it covers", async () => {
      // With all passwords enabled, the former holder retains its administrator reservation.
      assert.deepEqual(await flood("online-all"), { fresh: 429, former: 200, holder: 200 });
      // Apply recovery-only before the delegated move so its new password designation
      // must take effect on the running controller.
      await restart(recoveryOnly);
      const previous = currentHolder();
      const next = previous === second ? third : second;
      const moved = await replace(secondHeaders, {
        userId: next.id,
        expectedCurrentUserId: previous.id,
        expectedVersion: (await readAccount(activeApp(), adminHeaders, next.id)).version,
      });
      assert.equal(moved.statusCode, 200);
      const designation = recoveryDesignation(
        recordData(parseAuthResponse("delegated move", moved)),
      );
      assert.equal(designation.userId, next.id);
      assert.deepEqual(await designations(), [designation]);
      holder = next;
    });

    await t.test(
      "the new holder keeps a checkable password when strangers spend its email",
      async () => {
        const current = currentHolder();
        // The former holder still administers the Installation. Recovery-only checks that
        // only the newly designated account keeps a usable password after the move.
        const other = await passwordSignIn(activeApp(), origin, admin, address());
        const lane = await flood("online-recovery-only");
        assert.equal(lane.holder, 200, "the current holder can sign in after the flood");
        assert.equal(other.statusCode, 401, "the former holder's password is refused");
        assert.equal(lane.fresh, 429);
        assert.equal(lane.former, 429);
        const disabled = await changeAccount(activeApp(), adminHeaders, current.id, "disable");
        assert.equal(
          disabled.statusCode,
          409,
          "the new holder is protected like the recovery account",
        );
        // Enable answers 409 too for an account that is not disabled; only the recovery guard
        // names the recovery account.
        assert.equal(
          record(record(parseAuthResponse("disable recovery holder", disabled)).error).message,
          "The recovery account cannot be disabled.",
        );
      },
    );

    await t.test(
      "a restart with the original seed keeps the stored designation and warns",
      async () => {
        const current = currentHolder();
        const before = await readRecovery(adminHeaders);
        assert.equal(before.userId, current.id);
        const restartWarnings = [
          "authentication.recovery-seed-warning",
          "authentication.sign-in-limit-warning",
        ];
        assert.deepEqual(await restart(settings), restartWarnings);
        const formerHeaders = await authOperation("sign in the former holder after restart", () =>
          signedInHeaders(activeApp(), origin, admin, address()),
        );
        assert.deepEqual(await readRecovery(formerHeaders), before);
        assert.deepEqual(await flood("restarted-all"), { fresh: 429, former: 200, holder: 200 });
        // Recovery-only also reports accounts without an attached external identity.
        assert.deepEqual(await restart(recoveryOnly), [
          ...restartWarnings,
          "authentication.password-sign-in-warning",
        ]);
        assert.deepEqual(await designations(), [before]);
        const holderHeaders = await authOperation("sign in the stored holder after restart", () =>
          signedInHeaders(activeApp(), origin, current, address()),
        );
        assert.deepEqual(await readRecovery(holderHeaders), before);
        const lane = await flood("restarted-recovery-only");
        assert.deepEqual(lane, { fresh: 429, former: 429, holder: 200 });
      },
    );
  },
);
