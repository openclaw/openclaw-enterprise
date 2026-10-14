import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import pg from "pg";
import {
  CLI_SESSIONS_PER_PARENT,
  PostgresCliSessions,
  PostgresHumanAuthentication,
  PostgresPlatformState,
} from "../../packages/occ/src/index.ts";
import {
  betterAuthIssuer,
  createPostgresControllerAuth,
} from "../../apps/controller/src/auth/index.ts";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const MAX_LIFETIME = 8 * 60 * 60;

function sessionRecord(userId, lifetimeMs = 8 * 60 * 60 * 1000) {
  const createdAt = new Date();
  return {
    id: randomUUID(),
    token: randomBytes(32).toString("hex"),
    userId,
    createdAt,
    updatedAt: createdAt,
    expiresAt: new Date(createdAt.getTime() + lifetimeMs),
  };
}

// Faults affect the database transport only; PostgresPlatformState and PostgreSQL are real.
function transportPool(pool, query) {
  return {
    async connect() {
      const client = await pool.connect();
      return {
        query: (sql, parameters) => query(client, sql, parameters),
        release: (discard) => client.release(discard),
        on: (event, listener) => client.on(event, listener),
        removeListener: (event, listener) => client.removeListener(event, listener),
      };
    },
    end: async () => {},
  };
}

test(
  "PostgreSQL CLI sessions are children of the approving browser session",
  requiresPostgres,
  async (context) => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 12 });
    context.after(() => pool.end());
    const state = new PostgresPlatformState(pool);
    const suffix = randomUUID();
    const recoveryEmail = `recovery-${suffix}@example.test`;
    const password = "local-cli-session-test-password";
    const secret = "local-cli-session-test-secret-32-characters-long";
    await ensureDevelopmentBootstrap(context, {
      databaseUrl,
      email: recoveryEmail,
      password,
      authSecret: secret,
      installationName: "CLI session persistence",
      authBaseURL: "http://127.0.0.1",
    });
    const installation = await state.loadInstallation();
    assert.ok(installation);
    const issuer = betterAuthIssuer(installation.id);
    const auth = await createPostgresControllerAuth({
      mode: "development",
      installationId: installation.id,
      baseURL: "http://127.0.0.1",
      secret,
      pool,
    });
    const iam = await state.loadNativeIAMState(installation.id);
    const recoveryUser = (
      await pool.query('SELECT id FROM occ."user" WHERE email = $1', [recoveryEmail])
    ).rows[0];
    const recoveryPrincipal = iam.identities.find(
      (p) => p.kind === "principal" && p.issuer === issuer && p.subject === recoveryUser.id,
    );
    assert.ok(recoveryPrincipal);
    const roleId = iam.bindings.find((b) => b.subjectId === recoveryPrincipal.id).roleId;
    const person = await auth.createAccount({ email: `person-${suffix}@example.test`, password });
    await state.appendNativeIAMPrincipal(auth.principalSeed(person, { roleId }));
    const other = await auth.createAccount({ email: `other-${suffix}@example.test`, password });
    await state.appendNativeIAMPrincipal(auth.principalSeed(other, { roleId }));

    const store = new PostgresCliSessions(state, installation.id, issuer, { guarded: false });

    async function insertSession(userId, lifetimeMs) {
      const record = sessionRecord(userId, lifetimeMs);
      await pool.query(
        `INSERT INTO occ.session (id, token, user_id, created_at, updated_at, expires_at)
         VALUES ($1,$2,$3,$4,$4,$5)`,
        [record.id, record.token, userId, record.createdAt, record.expiresAt],
      );
      return record;
    }
    async function approved(cli, parent, { namespaceId } = {}) {
      const deviceCode = randomUUID();
      const userCode = randomUUID();
      await cli.start({
        deviceCodeHash: hash(deviceCode),
        userCodeHash: hash(userCode),
        clientLabel: "occ on test host",
        requesterAddress: "127.0.0.1",
        ...(namespaceId === undefined ? {} : { namespaceId }),
      });
      const decided = await cli.decide(hash(userCode), "approve", {
        userId: parent.userId,
        sessionId: parent.id,
      });
      assert.ok(decided);
      return { deviceCode, userCode, authorizationId: decided.id };
    }
    async function issue(cli, parent, options) {
      const { deviceCode } = await approved(cli, parent, options);
      const token = `occcli_${randomBytes(32).toString("base64url")}`;
      const result = await cli.exchange(hash(deviceCode), {
        tokenHash: hash(token),
        maxLifetimeSeconds: MAX_LIFETIME,
      });
      assert.equal(result.status, "issued");
      return { token, session: result.session };
    }
    async function cliRows(where, parameters) {
      return (await pool.query(`SELECT * FROM occ.cli_sessions WHERE ${where}`, parameters)).rows;
    }
    async function audits(action) {
      return (await state.transact((unit) => unit.audit.list())).filter(
        (event) => event.action === action,
      );
    }

    await context.test(
      "a pending code is refused, a denial is final, and lookup hides both",
      async () => {
        const deviceCode = randomUUID();
        const userCode = randomUUID();
        await store.start({
          deviceCodeHash: hash(deviceCode),
          userCodeHash: hash(userCode),
          clientLabel: "occ on test host",
          requesterAddress: "192.0.2.10",
        });
        const issueWith = { tokenHash: hash(randomUUID()), maxLifetimeSeconds: MAX_LIFETIME };
        assert.deepEqual(await store.exchange(hash(deviceCode), issueWith), { status: "pending" });
        const pending = await store.lookup(hash(userCode));
        assert.equal(pending.requesterAddress, "192.0.2.10");
        assert.equal(await store.lookup(hash("wrong")), undefined);
        const parent = await insertSession(person.id);
        const denied = await store.decide(hash(userCode), "deny", {
          userId: person.id,
          sessionId: parent.id,
        });
        assert.equal(denied.id, pending.id);
        assert.deepEqual(await store.exchange(hash(deviceCode), issueWith), { status: "denied" });
        assert.equal(await store.lookup(hash(userCode)), undefined);
        assert.equal(
          await store.decide(hash(userCode), "approve", {
            userId: person.id,
            sessionId: parent.id,
          }),
          undefined,
        );
        const stored = (
          await pool.query("SELECT * FROM occ.cli_device_authorizations WHERE id=$1", [pending.id])
        ).rows[0];
        assert.equal(stored.state, "denied");
        assert.equal(stored.parent_session_id, null);
        assert.notEqual(stored.user_code_hash, userCode);
        assert.equal((await audits("openclaw.auth.cli-sessions.deny")).length, 1);
      },
    );

    await context.test(
      "concurrent pollers consume an approval once and the session ends with its parent",
      async () => {
        const parent = await insertSession(person.id, 60 * 60 * 1000);
        const { deviceCode, authorizationId } = await approved(store, parent);
        const tokens = Array.from(
          { length: 6 },
          () => `occcli_${randomBytes(32).toString("base64url")}`,
        );
        const results = await Promise.all(
          tokens.map((token) =>
            store.exchange(hash(deviceCode), {
              tokenHash: hash(token),
              maxLifetimeSeconds: MAX_LIFETIME,
            }),
          ),
        );
        const issued = results.filter((result) => result.status === "issued");
        assert.equal(issued.length, 1);
        assert.ok(results.every((r) => r.status === "issued" || r.status === "expired"));
        const session = issued[0].session;
        // The eight-hour maximum is capped at the parent's one-hour expiry.
        assert.equal(session.expiresAt.getTime(), parent.expiresAt.getTime());
        assert.equal(session.parentSessionId, parent.id);
        assert.equal(session.userId, person.id);
        const rows = await cliRows("authorization_id = $1", [authorizationId]);
        assert.equal(rows.length, 1);
        assert.ok(tokens.every((token) => rows[0].token_hash !== token));
        const winner = tokens[results.indexOf(issued[0])];
        assert.equal((await store.verify(hash(winner))).id, session.id);
        assert.equal(await store.verify(hash(tokens.find((t) => t !== winner))), undefined);
        // Consumed: a replay of the device code is expired.
        assert.deepEqual(
          await store.exchange(hash(deviceCode), {
            tokenHash: hash(randomUUID()),
            maxLifetimeSeconds: MAX_LIFETIME,
          }),
          { status: "expired" },
        );
        const issueAudit = (await audits("openclaw.auth.cli-sessions.issue")).find(
          (event) => event.details.cliSessionId === session.id,
        );
        assert.equal(issueAudit.details.authorizationId, authorizationId);
        assert.ok(!JSON.stringify(issueAudit).includes(winner));

        // Signing the browser session out deletes the CLI session.
        await pool.query("DELETE FROM occ.session WHERE id=$1", [parent.id]);
        assert.equal(await store.verify(hash(winner)), undefined);
        assert.equal((await cliRows("id = $1", [session.id])).length, 0);
      },
    );

    await context.test("an expired parent stops authenticating its CLI session", async () => {
      const parent = await insertSession(person.id, 60 * 60 * 1000);
      const { token, session } = await issue(store, parent);
      assert.ok(await store.verify(hash(token)));
      await pool.query("UPDATE occ.session SET expires_at = clock_timestamp() WHERE id=$1", [
        parent.id,
      ]);
      assert.equal(await store.verify(hash(token)), undefined);
      // An approval whose parent expired before the exchange issues nothing.
      const next = await insertSession(person.id, 60 * 60 * 1000);
      const { deviceCode } = await approved(store, next);
      await pool.query("UPDATE occ.session SET expires_at = clock_timestamp() WHERE id=$1", [
        next.id,
      ]);
      assert.deepEqual(
        await store.exchange(hash(deviceCode), {
          tokenHash: hash(randomUUID()),
          maxLifetimeSeconds: MAX_LIFETIME,
        }),
        { status: "expired" },
      );
      assert.equal((await cliRows("parent_session_id = $1", [next.id])).length, 0);
      assert.equal((await cliRows("id = $1", [session.id])).length, 1);
    });

    await context.test(
      "the database refuses a CLI session that outlives or crosses its parent",
      async () => {
        const parent = await insertSession(person.id, 60 * 60 * 1000);
        const { authorizationId } = await approved(store, parent);
        const base = [
          `cls_${randomUUID()}`,
          hash(randomUUID()),
          authorizationId,
          person.id,
          parent.id,
        ];
        const insert = (values, expiresAt, binding = [null, null, null]) =>
          pool.query(
            `INSERT INTO occ.cli_sessions (id, token_hash, authorization_id, user_id, parent_session_id,
             client_label, method_id, version, method_version, expires_at)
           VALUES ($1,$2,$3,$4,$5,'occ on test host',$6,$7,$8,$9)`,
            [...values, ...binding, expiresAt],
          );
        const refused = /must belong to an unexpired parent session and end no later than it/;
        await assert.rejects(insert(base, new Date(parent.expiresAt.getTime() + 1000)), refused);
        await assert.rejects(
          insert([base[0], base[1], base[2], other.id, parent.id], parent.expiresAt),
          refused,
        );
        const method = (
          await pool.query("SELECT id FROM occ.account WHERE user_id=$1", [person.id])
        ).rows[0];
        // An unbound parent admits no binding.
        await assert.rejects(insert(base, parent.expiresAt, [method.id, 1, 1]), /binding/);
        await assert.rejects(
          pool.query(
            `UPDATE occ.cli_device_authorizations SET client_label='changed' WHERE id=$1`,
            [authorizationId],
          ),
          { code: "42501" },
        );
      },
    );

    await context.test(
      `one browser session holds at most ${CLI_SESSIONS_PER_PARENT} CLI sessions`,
      async () => {
        const parent = await insertSession(person.id);
        const issued = [];
        for (let index = 0; index < CLI_SESSIONS_PER_PARENT; index += 1) {
          issued.push(await issue(store, parent));
        }
        const { deviceCode, authorizationId } = await approved(store, parent);
        const issueWith = { tokenHash: hash(randomUUID()), maxLifetimeSeconds: MAX_LIFETIME };
        assert.deepEqual(await store.exchange(hash(deviceCode), issueWith), { status: "limit" });
        // The trigger holds the cap even for a writer that skips the store's count.
        await assert.rejects(
          pool.query(
            `INSERT INTO occ.cli_sessions (id, token_hash, authorization_id, user_id, parent_session_id,
             client_label, expires_at)
           VALUES ($1,$2,$3,$4,$5,'occ on test host',$6)`,
            [
              `cls_${randomUUID()}`,
              hash(randomUUID()),
              authorizationId,
              person.id,
              parent.id,
              parent.expiresAt,
            ],
          ),
          /maximum number of CLI sessions/,
        );
        // Revoking one frees a slot; the approval is still usable.
        assert.equal(await store.revoke(other.id, issued[0].session.id, "console"), false);
        assert.equal(await store.revoke(person.id, issued[0].session.id, "console"), true);
        assert.equal(await store.verify(hash(issued[0].token)), undefined);
        assert.equal((await store.exchange(hash(deviceCode), issueWith)).status, "issued");
        const listed = await store.list(person.id);
        assert.ok(listed.every((session) => session.userId === person.id));
        assert.equal(listed.filter((s) => s.parentSessionId === parent.id).length, 10);
        assert.equal((await store.list(other.id)).length, 0);
        const revoke = (await audits("openclaw.auth.cli-sessions.revoke")).find(
          (event) => event.details.cliSessionId === issued[0].session.id,
        );
        assert.equal(revoke.details.reason, "console");
      },
    );

    await context.test(
      "an audit failure leaves the authorization approved and issues nothing",
      async () => {
        const parent = await insertSession(person.id);
        const { deviceCode, authorizationId } = await approved(store, parent);
        let failAudit = true;
        const faulty = new PostgresCliSessions(
          new PostgresPlatformState(
            transportPool(pool, (client, sql, parameters) => {
              if (failAudit && /INSERT INTO occ\.audit_events/i.test(sql)) {
                throw Object.assign(new Error("audit store unavailable"), { code: "08006" });
              }
              return client.query(sql, parameters);
            }),
          ),
          installation.id,
          issuer,
          { guarded: false },
        );
        const tokenHash = hash(randomUUID());
        await assert.rejects(
          faulty.exchange(hash(deviceCode), { tokenHash, maxLifetimeSeconds: MAX_LIFETIME }),
        );
        const row = (
          await pool.query("SELECT state FROM occ.cli_device_authorizations WHERE id=$1", [
            authorizationId,
          ])
        ).rows[0];
        assert.equal(row.state, "approved");
        assert.equal((await cliRows("authorization_id = $1", [authorizationId])).length, 0);
        // A decision with a failed audit is not recorded either.
        const userCode = randomUUID();
        await store.start({
          deviceCodeHash: hash(randomUUID()),
          userCodeHash: hash(userCode),
          clientLabel: "occ on test host",
          requesterAddress: "127.0.0.1",
        });
        await assert.rejects(
          faulty.decide(hash(userCode), "approve", { userId: person.id, sessionId: parent.id }),
        );
        assert.ok(await store.lookup(hash(userCode)));
        failAudit = false;
        assert.equal(
          (await faulty.exchange(hash(deviceCode), { tokenHash, maxLifetimeSeconds: MAX_LIFETIME }))
            .status,
          "issued",
        );
      },
    );

    await context.test("the sweep removes expired authorizations and sessions only", async () => {
      const parent = await insertSession(person.id, 2000);
      const { token, session } = await issue(store, parent);
      const live = await issue(store, await insertSession(person.id));
      const stale = `cda_${randomUUID()}`;
      await pool.query(
        `INSERT INTO occ.cli_device_authorizations
           (id, device_code_hash, user_code_hash, client_label, requester_address, created_at, expires_at)
         VALUES ($1,$2,$3,'occ on test host','127.0.0.1',
           clock_timestamp() - interval '5 minutes', clock_timestamp() - interval '1 minute')`,
        [stale, hash(randomUUID()), hash(randomUUID())],
      );
      await delay(2500);
      assert.equal(await store.verify(hash(token)), undefined);
      const swept = await store.sweep(1000);
      assert.ok(swept.sessions >= 1 && swept.authorizations >= 1);
      assert.equal((await cliRows("id = $1", [session.id])).length, 0);
      assert.equal(
        (await pool.query("SELECT id FROM occ.cli_device_authorizations WHERE id=$1", [stale]))
          .rowCount,
        0,
      );
      assert.ok(await store.verify(hash(live.token)));
      await assert.rejects(store.sweep(0), /sweep limit/);
    });

    await context.test("pending authorizations are capped; the oldest are evicted", async () => {
      const bounded = new PostgresCliSessions(state, installation.id, issuer, {
        guarded: false,
        maxPending: 3,
      });
      const codes = [];
      for (let index = 0; index < 5; index += 1) {
        const userCode = randomUUID();
        await bounded.start({
          deviceCodeHash: hash(randomUUID()),
          userCodeHash: hash(userCode),
          clientLabel: "occ on test host",
          requesterAddress: "127.0.0.1",
        });
        codes.push(userCode);
      }
      const pending = await pool.query(
        "SELECT count(*)::int AS count FROM occ.cli_device_authorizations WHERE state='pending'",
      );
      assert.equal(pending.rows[0].count, 3);
      assert.equal(await bounded.lookup(hash(codes[0])), undefined);
      assert.ok(await bounded.lookup(hash(codes[4])));
    });

    // From here on the installation is in the guarded profile: sessions carry bindings.
    const persistence = new PostgresHumanAuthentication(state, installation.id, issuer, {
      externalProviderIds: [],
    });
    const guarded = new PostgresCliSessions(state, installation.id, issuer, {
      guarded: true,
      externalProviderIds: [],
    });

    await context.test(
      "in the guarded profile, version changes, disable and revoke end CLI sessions",
      async () => {
        const unbound = await insertSession(person.id);
        const { deviceCode: unboundCode } = await approved(store, unbound);
        await persistence.activateRecovery(recoveryUser.id, recoveryPrincipal.id);
        const adminSnapshot = await persistence.snapshotPassword(recoveryEmail);
        const adminSession = await persistence.issueSession(
          adminSnapshot.proof,
          sessionRecord(recoveryUser.id),
        );
        const admin = {
          userId: recoveryUser.id,
          sessionId: adminSession.id,
          principalId: recoveryPrincipal.id,
        };
        async function changeAccount(userId, operation) {
          const target = await persistence.readAccount(userId, admin);
          await persistence.changeAccount(userId, operation, admin, target.version);
        }
        async function signIn() {
          const snapshot = await persistence.snapshotPassword(person.email);
          return persistence.issueSession(snapshot.proof, sessionRecord(person.id));
        }
        // Activation removed the unbound parent, and with it the approval.
        assert.deepEqual(
          await guarded.exchange(hash(unboundCode), {
            tokenHash: hash(randomUUID()),
            maxLifetimeSeconds: MAX_LIFETIME,
          }),
          { status: "expired" },
        );

        let parent = await signIn();
        let cli = await issue(guarded, parent);
        const row = (await cliRows("id = $1", [cli.session.id]))[0];
        const binding = (
          await pool.query(
            "SELECT method_id, version, method_version FROM occ.human_authentication_sessions WHERE session_id=$1",
            [parent.id],
          )
        ).rows[0];
        assert.deepEqual(
          { method_id: row.method_id, version: row.version, method_version: row.method_version },
          binding,
        );
        assert.equal((await guarded.verify(hash(cli.token))).id, cli.session.id);
        // A copied binding that does not match the parent's is refused.
        const { authorizationId } = await approved(guarded, parent);
        await assert.rejects(
          pool.query(
            `INSERT INTO occ.cli_sessions (id, token_hash, authorization_id, user_id, parent_session_id,
               client_label, method_id, version, method_version, expires_at)
             VALUES ($1,$2,$3,$4,$5,'occ on test host',$6,$7,$8,$9)`,
            [
              `cls_${randomUUID()}`,
              hash(randomUUID()),
              authorizationId,
              person.id,
              parent.id,
              binding.method_id,
              binding.version + 1,
              binding.method_version,
              new Date(Date.now() + 60_000),
            ],
          ),
          /binding/,
        );

        // A password change bumps the method version: the parent row stays, but neither
        // the browser session nor its CLI session authenticates.
        const hashed = (
          await pool.query("SELECT password FROM occ.account WHERE id=$1", [binding.method_id])
        ).rows[0].password;
        await pool.query("UPDATE occ.account SET password=$2 WHERE id=$1", [
          binding.method_id,
          await (await auth.auth.$context).password.hash("replacement-cli-session-password"),
        ]);
        assert.equal(await persistence.currentSession(parent.token), undefined);
        assert.equal(await guarded.verify(hash(cli.token)), undefined);
        assert.equal((await cliRows("id = $1", [cli.session.id])).length, 1);
        await pool.query("UPDATE occ.account SET password=$2 WHERE id=$1", [
          binding.method_id,
          hashed,
        ]);
        assert.equal(await guarded.verify(hash(cli.token)), undefined);

        for (const operation of ["disable", "revoke"]) {
          parent = await signIn();
          cli = await issue(guarded, parent);
          assert.ok(await guarded.verify(hash(cli.token)));
          await changeAccount(person.id, operation);
          assert.equal(await guarded.verify(hash(cli.token)), undefined);
          assert.equal((await cliRows("id = $1", [cli.session.id])).length, 0);
          if (operation === "disable") {
            await changeAccount(person.id, "enable");
          }
        }
      },
    );
  },
);
