import assert from "node:assert/strict";
import test from "node:test";
import {
  scryptPasswordHasher,
  type PasswordHasher,
  type PasswordSlowLaneFloors,
} from "../../apps/controller/src/auth/index.ts";
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
  parseAuthResponse,
  passwordSignIn,
  readAccount,
  record,
  recordData,
  signedInHeaders,
  text,
  type FixtureAccount,
  type InjectedResponse,
  type SignInApp,
} from "../helpers/postgres-sign-in-test-boundaries.ts";
import { databaseUrl, requiresPostgres, testPool } from "../helpers/postgres-database.mjs";
import { waitForLockWaiter } from "../helpers/postgres-locks.ts";
import { within } from "../helpers/wait-for.ts";
import { commitAckProxy } from "../fixtures/postgres-commit-ack-proxy.mjs";
import { preparePostgresSignInInstallation } from "../helpers/postgres-sign-in-installation.ts";

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

function passwordVerificationPauses() {
  type Gate = ReturnType<typeof Promise.withResolvers<void>>;
  let pause: { verified: Gate; resume: Gate } | undefined;
  const hasher: PasswordHasher = {
    hash: (password) => scryptPasswordHasher.hash(password),
    async verify(input) {
      const accepted = await scryptPasswordHasher.verify(input);
      const current = pause;
      if (accepted && current !== undefined) {
        pause = undefined;
        current.verified.resolve();
        await current.resume.promise;
      }
      return accepted;
    },
  };
  return {
    hasher,
    next() {
      assert.equal(pause, undefined, "only one password verification is paused");
      const current = {
        verified: Promise.withResolvers<void>(),
        resume: Promise.withResolvers<void>(),
      };
      pause = current;
      return {
        verified: current.verified.promise,
        resume() {
          if (pause === current) {
            pause = undefined;
          }
          current.resume.resolve();
        },
      };
    },
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
    let peerApp: SignInApp | undefined;
    const { pool, state, oidc, onboard, composeApp } = await preparePostgresSignInInstallation(
      t,
      () => [app, peerApp],
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
    } = await authOperation("onboard accounts", () =>
      onboard({
        remoteAddress: address(),
        passwordHasher: scryptPasswordHasher,
        accounts: {
          second: { email: "replacement-second@example.test", role: "admin" },
          third: { email: "replacement-third@example.test", role: "admin" },
          member: { email: "replacement-member@example.test" },
        },
      }),
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

    await t.test("recovery-only orders password sessions against online replacement", async (t) => {
      assert.ok(databaseUrl);
      const installation = await state.loadInstallation();
      assert.ok(installation);
      const databaseRole = await pool.query<{
        rolsuper: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolbypassrls: boolean;
        can_create_objects: boolean;
      }>(
        `SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls,
         has_schema_privilege(current_user, 'occ', 'CREATE') AS can_create_objects
         FROM pg_roles WHERE rolname=current_user`,
      );
      assert.deepEqual(databaseRole.rows, [
        {
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolbypassrls: false,
          can_create_objects: false,
        },
      ]);
      const replacementBody = async (target: FixtureAccount, expectedCurrentUserId: string) => ({
        userId: target.id,
        expectedCurrentUserId,
        expectedVersion: (await readAccount(activeApp(), adminHeaders, target.id)).version,
      });
      const moveTo = async (target: FixtureAccount) => {
        const before = await readRecovery(adminHeaders);
        if (before.userId === target.id) {
          return before;
        }
        const moved = await replace(adminHeaders, await replacementBody(target, before.userId));
        assert.equal(moved.statusCode, 200, "the genuine recovery route commits the move");
        const current = recoveryDesignation(recordData(parseAuthResponse("recovery move", moved)));
        assert.equal(current.userId, target.id);
        assert.deepEqual(await designations(), [current]);
        return current;
      };
      await moveTo(admin);
      await activeApp().close();
      app = undefined;

      // The serving instances share an Installation and policy. PostgreSQL's
      // connection default is deliberately repeatable read: waiting for a lock
      // alone must not leave the session writer with a stale transaction snapshot.
      const repeated = new URL(databaseUrl);
      const priorOptions = repeated.searchParams.get("options");
      repeated.searchParams.set(
        "options",
        [priorOptions, "-c default_transaction_isolation=repeatable\\ read"]
          .filter(Boolean)
          .join(" "),
      );
      const repeatableUrl = repeated.toString();
      const defaultProbe = testPool(t, { connectionString: repeatableUrl, max: 1 });
      const isolation = await defaultProbe.query<{ default_transaction_isolation: string }>(
        "SHOW default_transaction_isolation",
      );
      assert.equal(first(isolation.rows).default_transaction_isolation, "repeatable read");

      const pauses = passwordVerificationPauses();
      app = await composeApp(recoveryOnly, {
        databaseUrl: repeatableUrl,
        passwordHasher: pauses.hasher,
        passwordSlowLaneFloors: slowLane,
      });
      peerApp = await composeApp(recoveryOnly, {
        databaseUrl: repeatableUrl,
        passwordHasher: scryptPasswordHasher,
        passwordSlowLaneFloors: slowLane,
      });
      const peer = peerApp;
      const effects = async (userId: string) => {
        const sessions = await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM occ.human_authentication_sessions WHERE user_id = $1",
          [userId],
        );
        const audits = await state.transact((unit) => unit.audit.list());
        return {
          sessions: first(sessions.rows).count,
          successes: audits.filter(
            (event) =>
              event.action === "authentication.login" &&
              event.outcome === "success" &&
              event.details?.userId === userId,
          ).length,
          denials: audits.filter(
            (event) =>
              event.action === "authentication.login" &&
              event.outcome === "denied" &&
              event.reasonCode === "INVALID_CREDENTIALS",
          ).length,
        };
      };
      const refused = async (
        result: InjectedResponse,
        before: Awaited<ReturnType<typeof effects>>,
      ) => {
        const after = await effects(admin.id);
        // The old-source witness must prove a committed session, not just a different status.
        if (result.statusCode === 200) {
          assert.deepEqual(
            after,
            {
              sessions: before.sessions + 1,
              successes: before.successes + 1,
              denials: before.denials,
            },
            "an accepted former-holder login committed its session and audit",
          );
          assert.fail("the former recovery holder received a committed password session");
        }
        assertApiError(result, 401, "UNAUTHENTICATED");
        assert.equal(result.headers["set-cookie"], undefined, "no session or known-device cookie");
        assert.equal(record(parseAuthResponse("refused password", result)).data, undefined);
        assert.deepEqual(after, { ...before, denials: before.denials + 1 });
      };
      const retainSession = async (headers: Record<string, string>) => {
        const session = await peer.inject({ url: "/api/auth/session", headers });
        assert.equal(session.statusCode, 200);
        const data = recordData(parseAuthResponse("retained session", session));
        assert.equal(record(data.user).id, admin.id);
        assert.equal((await peer.inject({ url: "/installation", headers })).statusCode, 200);
      };
      const replaceFromPeer = (body: RecoveryReplacement) =>
        peer.inject({
          method: "POST",
          url: "/api/auth/recovery",
          headers: adminHeaders,
          payload: body,
        });
      const advisory = "SELECT pg_advisory_xact_lock(1868785005, hashtext($1))";
      const advisoryQuery = "%pg_advisory_xact_lock(1868785005%";

      await t.test("a stale peer refuses the former holder and admits the successor", async () => {
        await moveTo(second);
        const before = await effects(admin.id);
        await refused(await passwordSignIn(peer, origin, admin, address()), before);
        for (const serving of [activeApp(), peer]) {
          assert.equal((await passwordSignIn(serving, origin, second, address())).statusCode, 200);
        }
        await retainSession(adminHeaders);
        const control = await composeApp(settings, { passwordHasher: scryptPasswordHasher });
        try {
          for (const account of [admin, second, member]) {
            assert.equal(
              (await passwordSignIn(control, origin, account, address())).statusCode,
              200,
            );
          }
        } finally {
          await control.close();
        }
        assert.deepEqual(
          await assertReservedLane(peer, {
            origin,
            holder: second,
            former: admin,
            label: "peer-recovery-only",
          }),
          { fresh: 429, former: 429, holder: 200 },
          "the peer reserves the durable successor after its email budget is spent",
        );
      });

      await t.test("a password verified before replacement cannot commit afterward", async () => {
        await moveTo(admin);
        const body = await replacementBody(second, admin.id);
        const before = await effects(admin.id);
        const gate = pauses.next();
        const signing = passwordSignIn(activeApp(), origin, admin, address());
        try {
          await within(gate.verified, "the real old-holder password verification");
          // The same serving controller can commit a move while its verifier waits.
          const moved = await replace(adminHeaders, body);
          assert.equal(moved.statusCode, 200);
          assert.equal(first(await designations()).userId, second.id);
        } finally {
          gate.resume();
        }
        await refused(await signing, before);
      });

      await t.test("a queued replacement commits before the waiting session decision", async () => {
        await moveTo(admin);
        const body = await replacementBody(second, admin.id);
        const before = await effects(admin.id);
        const gate = pauses.next();
        const pending: Promise<unknown>[] = [];
        const signing = passwordSignIn(activeApp(), origin, admin, address());
        pending.push(signing);
        const holder = await pool.connect();
        try {
          await within(gate.verified, "password verification before lock ordering");
          await holder.query("BEGIN");
          const backend = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          const pid = first(backend.rows).pid;
          await holder.query(advisory, [installation.id]);
          const moving = replaceFromPeer(body);
          pending.push(moving);
          const replacementPid = await waitForLockWaiter(
            pool,
            pid,
            "replacement behind recovery lock",
            { queryLike: advisoryQuery, timeoutMs: 2000 },
          );
          gate.resume();
          await waitForLockWaiter(pool, replacementPid, "issuance behind queued replacement", {
            queryLike: advisoryQuery,
            timeoutMs: 2000,
          });
          await holder.query("COMMIT");
          assert.equal((await moving).statusCode, 200);
          assert.equal(first(await designations()).userId, second.id);
          await refused(await signing, before);
        } finally {
          gate.resume();
          let discard = false;
          await holder.query("ROLLBACK").catch(() => {
            discard = true;
          });
          holder.release(discard);
          await Promise.allSettled(pending);
        }
      });

      await t.test("a session committed before replacement remains usable", async () => {
        await moveTo(admin);
        const body = await replacementBody(second, admin.id);
        const before = await effects(admin.id);
        const pending: Promise<unknown>[] = [];
        const holder = await pool.connect();
        try {
          await holder.query("BEGIN");
          const backend = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          const pid = first(backend.rows).pid;
          await holder.query("LOCK TABLE occ.session IN SHARE MODE");
          const signing = passwordSignIn(activeApp(), origin, admin, address());
          pending.push(signing);
          const issuancePid = await waitForLockWaiter(
            pool,
            pid,
            "session INSERT behind table lock",
            { queryLike: "%INSERT INTO occ.session%", timeoutMs: 2000 },
          );
          const moving = replaceFromPeer(body);
          pending.push(moving);
          await waitForLockWaiter(pool, issuancePid, "replacement behind issuing session", {
            queryLike: advisoryQuery,
            timeoutMs: 2000,
          });
          await holder.query("COMMIT");
          const accepted = await signing;
          assert.equal(accepted.statusCode, 200);
          assert.equal((await moving).statusCode, 200);
          assert.equal(first(await designations()).userId, second.id);
          const after = await effects(admin.id);
          assert.deepEqual(after, {
            sessions: before.sessions + 1,
            successes: before.successes + 1,
            denials: before.denials,
          });
          const cookie = cookieHeaderFromSetCookie(accepted.headers["set-cookie"]);
          assert.ok(cookie);
          await retainSession({ cookie, origin });
        } finally {
          let discard = false;
          await holder.query("ROLLBACK").catch(() => {
            discard = true;
          });
          holder.release(discard);
          await Promise.allSettled(pending);
        }
      });

      await t.test("recovery-lock timeout is unavailable rather than bad credentials", async () => {
        await moveTo(admin);
        const before = await effects(admin.id);
        const pending: Promise<unknown>[] = [];
        const holder = await pool.connect();
        try {
          await holder.query("BEGIN");
          const backend = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          const pid = first(backend.rows).pid;
          await holder.query(advisory, [installation.id]);
          const signing = passwordSignIn(activeApp(), origin, admin, address());
          pending.push(signing);
          await waitForLockWaiter(pool, pid, "issuance waiting for the recovery lock", {
            queryLike: advisoryQuery,
            timeoutMs: 2000,
          });
          const unavailable = await within(signing, "the bounded recovery lock refusal", 7000);
          assertApiError(unavailable, 503, "DEPENDENCY_UNAVAILABLE");
          assert.equal(unavailable.headers["set-cookie"], undefined);
          assert.equal(
            record(parseAuthResponse("unavailable password", unavailable)).data,
            undefined,
          );
          assert.deepEqual(await effects(admin.id), before);
        } finally {
          let discard = false;
          await holder.query("ROLLBACK").catch(() => {
            discard = true;
          });
          holder.release(discard);
          await Promise.allSettled(pending);
        }
      });

      await t.test(
        "an uncertain denial audit still spends the former holder's budget",
        async () => {
          await moveTo(admin);
          const body = await replacementBody(second, admin.id);
          const before = await effects(admin.id);
          // Match the real audit INSERT so earlier reads and the refused session's
          // ROLLBACK cannot consume this single-use transport fault.
          const transactionStatement = `INSERT INTO occ.audit_events
               (id, occurred_at, kind, actor_id, action, namespace_id, resource_kind, resource_id,
                outcome, details)
               SELECT $1, $2::timestamptz, $3, $4, $5, $6, $7, $8, $9, $10::jsonb
               WHERE NOT EXISTS (SELECT 1 FROM occ.audit_events WHERE id = $1)
               ON CONFLICT (id) DO NOTHING`;
          const proxy = await commitAckProxy(repeatableUrl, { transactionStatement });
          const denialPauses = passwordVerificationPauses();
          let denialApp: SignInApp | undefined;
          let gate: ReturnType<typeof denialPauses.next> | undefined;
          let signing: Promise<InjectedResponse> | undefined;
          try {
            denialApp = await composeApp(recoveryOnly, {
              databaseUrl: proxy.url,
              passwordHasher: denialPauses.hasher,
              passwordSlowLaneFloors: slowLane,
            });
            gate = denialPauses.next();
            signing = passwordSignIn(denialApp, origin, admin, address());
            await within(gate.verified, "password verification before the failed denial audit");
            assert.equal((await replaceFromPeer(body)).statusCode, 200);
            assert.equal(first(await designations()).userId, second.id);
            proxy.arm();
            gate.resume();

            const unavailable = await signing;
            assert.equal(proxy.observedCommit, true, "the real denial audit committed");
            assertApiError(unavailable, 503, "DEPENDENCY_UNAVAILABLE");
            assert.equal(unavailable.headers["set-cookie"], undefined);
            assert.equal(
              record(parseAuthResponse("uncertain denial audit", unavailable)).data,
              undefined,
            );
            assert.deepEqual(await effects(admin.id), { ...before, denials: before.denials + 1 });
            for (let attempt = 0; attempt < 9; attempt += 1) {
              const denied = await passwordSignIn(denialApp, origin, admin, address());
              assertApiError(denied, 401, "UNAUTHENTICATED");
              assert.equal(denied.headers["set-cookie"], undefined);
            }
            const limited = await passwordSignIn(denialApp, origin, admin, address());
            assertApiError(limited, 429, "RATE_LIMITED");
            assert.equal(limited.headers["set-cookie"], undefined);
            assert.deepEqual(await effects(admin.id), { ...before, denials: before.denials + 10 });
          } finally {
            gate?.resume();
            await Promise.allSettled(signing === undefined ? [] : [signing]);
            try {
              await denialApp?.close();
            } finally {
              await proxy.close();
            }
          }
        },
      );

      await t.test("a lost session COMMIT acknowledgement releases no credentials", async () => {
        await moveTo(admin);
        const before = await effects(admin.id);
        const idsBefore = await pool.query<{ session_id: string }>(
          "SELECT session_id FROM occ.human_authentication_sessions WHERE user_id = $1",
          [admin.id],
        );
        const knownIds = new Set(idsBefore.rows.map(({ session_id }) => session_id));
        const proxy = await commitAckProxy(repeatableUrl, { transactionStatement: advisory });
        let uncertain: SignInApp | undefined;
        try {
          uncertain = await composeApp(recoveryOnly, {
            databaseUrl: proxy.url,
            passwordHasher: scryptPasswordHasher,
          });
          proxy.arm();
          const result = await passwordSignIn(uncertain, origin, admin, address());
          assert.equal(proxy.observedCommit, true, "the real session COMMIT completed");
          assertApiError(result, 503, "DEPENDENCY_UNAVAILABLE");
          assert.equal(result.headers["set-cookie"], undefined);
          assert.equal(record(parseAuthResponse("uncertain password", result)).data, undefined);
          const idsAfter = await pool.query<{ session_id: string }>(
            "SELECT session_id FROM occ.human_authentication_sessions WHERE user_id = $1",
            [admin.id],
          );
          assert.equal(
            idsAfter.rows.filter(({ session_id }) => !knownIds.has(session_id)).length,
            1,
            "exactly one session committed without replay or compensation",
          );
          assert.deepEqual(await effects(admin.id), {
            sessions: before.sessions + 1,
            successes: before.successes + 1,
            denials: before.denials,
          });
        } finally {
          try {
            await uncertain?.close();
          } finally {
            await proxy.close();
          }
        }
      });

      await t.test(
        "a lost replacement COMMIT acknowledgement does not replay the move",
        async () => {
          const original = await moveTo(admin);
          const body = await replacementBody(second, admin.id);
          const before = (await state.transact((unit) => unit.audit.list())).filter(
            ({ action }) => action === "authentication.recovery.replace",
          ).length;
          const proxy = await commitAckProxy(repeatableUrl, { transactionStatement: advisory });
          let uncertain: SignInApp | undefined;
          try {
            uncertain = await composeApp(recoveryOnly, {
              databaseUrl: proxy.url,
              passwordHasher: scryptPasswordHasher,
            });
            proxy.arm();
            const result = await uncertain.inject({
              method: "POST",
              url: "/api/auth/recovery",
              headers: adminHeaders,
              payload: body,
            });
            assert.equal(proxy.observedCommit, true, "the real replacement COMMIT completed");
            assertApiError(result, 503, "DEPENDENCY_UNAVAILABLE");
            assert.equal(result.headers["set-cookie"], undefined);
            const current = first(await designations());
            assert.equal(current.userId, second.id);
            const audits = (await state.transact((unit) => unit.audit.list())).filter(
              ({ action }) => action === "authentication.recovery.replace",
            );
            assert.equal(audits.length, before + 1, "one committed move without replay");
            assert.ok(
              audits.some(
                ({ details }) =>
                  details?.userId === current.userId &&
                  details.principalId === current.principalId &&
                  details.previousUserId === original.userId &&
                  details.previousPrincipalId === original.principalId,
              ),
            );
            // The wire receipt proves this test's COMMIT; a current-state read
            // alone would not reconcile an uncertain administrative operation.
          } finally {
            try {
              await uncertain?.close();
            } finally {
              await proxy.close();
            }
          }
        },
      );
    });
  },
);
