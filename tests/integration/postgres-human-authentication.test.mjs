import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import {
  PostgresHumanAuthentication,
  PostgresPlatformState,
} from "../../packages/occ/src/index.ts";
import {
  betterAuthIssuer,
  createPostgresControllerAuth,
} from "../../apps/controller/src/auth/index.ts";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

function sessionRecord(userId) {
  const createdAt = new Date();
  return {
    id: randomUUID(),
    token: randomBytes(32).toString("hex"),
    userId,
    createdAt,
    updatedAt: createdAt,
    expiresAt: new Date(createdAt.getTime() + 8 * 60 * 60 * 1000),
  };
}

// Faults affect the database transport only. All persistence and commit handling
// remains in the real PostgresPlatformState implementation against PostgreSQL.
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
  "PostgreSQL human authentication preserves exact identity and transactional currentness",
  requiresPostgres,
  async (context) => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
    context.after(() => pool.end());
    const state = new PostgresPlatformState(pool);
    const suffix = randomUUID();
    const recoveryEmail = `recovery-${suffix}@example.test`;
    const password = "local-authentication-test-password";
    const secret = "local-human-authentication-test-secret-32-characters";
    await ensureDevelopmentBootstrap(context, {
      databaseUrl,
      email: recoveryEmail,
      password,
      authSecret: secret,
      installationName: "Human authentication persistence",
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
    const roleId = iam.bindings.find(
      (binding) => binding.subjectId === recoveryPrincipal.id,
    ).roleId;
    const person = await auth.createAccount({ email: `person-${suffix}@example.test`, password });
    const seed = auth.principalSeed(person, { roleId });
    await state.appendNativeIAMPrincipal(seed);
    const providerId = `external-${suffix}`;
    // The external provider instance this suite attaches is the configured one.
    const configured = { externalProviderIds: [providerId] };
    const persistence = new PostgresHumanAuthentication(state, installation.id, issuer, configured);
    const peer = new PostgresHumanAuthentication(
      new PostgresPlatformState(pool),
      installation.id,
      issuer,
      configured,
    );
    const subject = "immutable-subject";
    const legacySession = sessionRecord(person.id);
    await pool.query(
      `INSERT INTO occ.session (id, token, user_id, created_at, updated_at, expires_at)
    VALUES ($1,$2,$3,$4,$4,$5)`,
      [
        legacySession.id,
        legacySession.token,
        person.id,
        legacySession.createdAt,
        legacySession.expiresAt,
      ],
    );

    let admin;
    let adminSession;
    async function signInAdmin() {
      const snapshot = await persistence.snapshotPassword(recoveryEmail);
      adminSession = await persistence.issueSession(snapshot.proof, sessionRecord(recoveryUser.id));
      admin = {
        userId: recoveryUser.id,
        sessionId: adminSession.id,
        principalId: recoveryPrincipal.id,
      };
    }
    async function changeAccount(userId, operation, store = persistence) {
      const target = await persistence.readAccount(userId, admin);
      return store.changeAccount(userId, operation, admin, target.version);
    }

    const authContext = await auth.auth.$context;
    async function preparedAccount(label) {
      return {
        id: randomUUID(),
        email: `${label}-${suffix}@example.test`,
        name: label,
        passwordHash: await authContext.password.hash(password),
        credentialId: randomUUID(),
      };
    }
    async function rowCounts(userId, principalId) {
      const { rows } = await pool.query(
        `SELECT (SELECT count(*) FROM occ."user" WHERE id=$1)::int AS users,
          (SELECT count(*) FROM occ.account WHERE user_id=$1)::int AS methods,
          (SELECT count(*) FROM occ.iam_identities WHERE id=$2)::int AS principals,
          (SELECT count(*) FROM occ.iam_access_bindings WHERE identity_subject_id=$2)::int AS bindings,
          (SELECT count(*) FROM occ.human_authentication_accounts WHERE user_id=$1)::int AS enrolled`,
        [userId, principalId],
      );
      return rows[0];
    }
    // A password user without a Principal, as an interrupted legacy creation leaves.
    const orphan = await auth.createAccount({ email: `orphan-${suffix}@example.test`, password });
    const early = await preparedAccount("early");
    const earlySeed = auth.principalSeed(early, { roleId });

    await context.test(
      "provisioning before activation writes the account and its enrolment together",
      async () => {
        await persistence.provisionPasswordAccount(early, earlySeed);
        assert.deepEqual(await rowCounts(early.id, earlySeed.principal.id), {
          users: 1,
          methods: 1,
          principals: 1,
          bindings: 1,
          enrolled: 1,
        });
        assert.equal((await persistence.snapshotPassword(early.email)).user.id, early.id);
      },
    );

    const fenceMessage =
      /Human sign-in is activated; sessions require a controller that enforces authentication bindings/;
    async function insertUnboundSession(userId) {
      const record = sessionRecord(userId);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // The deferred fence admits the statement and decides at COMMIT.
        await client.query(
          `INSERT INTO occ.session (id, token, user_id, created_at, updated_at, expires_at)
           VALUES ($1,$2,$3,$4,$4,$5)`,
          [record.id, record.token, userId, record.createdAt, record.expiresAt],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      return record;
    }
    async function sessionCount(userId) {
      return (
        await pool.query("SELECT count(*)::int AS count FROM occ.session WHERE user_id=$1", [
          userId,
        ])
      ).rows[0].count;
    }

    await context.test("unbound application sessions commit before activation", async () => {
      const unbound = await insertUnboundSession(person.id);
      assert.equal(
        (await pool.query("SELECT id FROM occ.session WHERE id=$1", [unbound.id])).rowCount,
        1,
      );
      // The same unguarded composition used after activation below signs in here.
      const before = await sessionCount(person.id);
      await auth.auth.api.signInEmail({ body: { email: person.email, password } });
      assert.equal(await sessionCount(person.id), before + 1);
    });

    await context.test(
      "activation is fixed and removes legacy sessions; recovery remains usable",
      async () => {
        assert.deepEqual(
          await persistence.activateRecovery(recoveryUser.id, recoveryPrincipal.id),
          { skipped: [orphan.id] },
        );
        assert.deepEqual(await peer.activateRecovery(recoveryUser.id, recoveryPrincipal.id), {
          skipped: [],
        });
        assert.equal(
          (await pool.query("SELECT count(*)::int AS count FROM occ.human_authentication_accounts"))
            .rows[0].count,
          3,
        );
        const activation = (await state.transact((unit) => unit.audit.list())).find(
          (event) => event.action === "authentication.recovery.activate",
        );
        assert.deepEqual(activation.details.skipped, [orphan.id]);
        // The skipped account stays unenrolled and is refused like a bad password.
        assert.equal(await persistence.snapshotPassword(orphan.email), undefined);
        assert.equal((await persistence.snapshotPassword(early.email)).user.id, early.id);
        await signInAdmin();
        assert.deepEqual(await persistence.recoveryDesignation(), {
          userId: recoveryUser.id,
          principalId: recoveryPrincipal.id,
          email: recoveryEmail,
        });
        assert.equal(
          (await pool.query("SELECT id FROM occ.session WHERE id=$1", [legacySession.id])).rowCount,
          0,
        );
        await assert.rejects(
          persistence.activateRecovery(person.id, seed.principal.id),
          /designation cannot be changed/,
        );
        await assert.rejects(changeAccount(recoveryUser.id, "disable"), {
          name: "ResourceStateConflictError",
          message: /recovery account cannot be disabled/,
        });
        await assert.rejects(pool.query('DELETE FROM occ."user" WHERE id=$1', [recoveryUser.id]), {
          code: "23001",
        });
        await assert.rejects(
          pool.query("UPDATE occ.account SET password=NULL WHERE user_id=$1", [recoveryUser.id]),
          /recovery credential cannot be removed/,
        );
        await changeAccount(recoveryUser.id, "revoke");
        await signInAdmin();
        const snapshot = await persistence.snapshotPassword(recoveryEmail);
        assert.ok(snapshot);
        const session = await persistence.issueSession(
          snapshot.proof,
          sessionRecord(recoveryUser.id),
        );
        assert.equal((await peer.currentSession(session.token)).user.id, recoveryUser.id);
        await peer.revokeSession(session.token);
        assert.equal(await persistence.currentSession(session.token), undefined);
      },
    );

    await context.test(
      "after activation unbound sessions fail at COMMIT and bound issuance still commits",
      async () => {
        const before = await sessionCount(person.id);
        await assert.rejects(insertUnboundSession(person.id), fenceMessage);
        assert.equal(await sessionCount(person.id), before);
        const snapshot = await persistence.snapshotPassword(person.email);
        const issued = await persistence.issueSession(snapshot.proof, sessionRecord(person.id));
        assert.equal(await sessionCount(person.id), before + 1);
        assert.equal(
          (
            await pool.query(
              "SELECT 1 FROM occ.human_authentication_sessions WHERE session_id=$1 AND user_id=$2",
              [issued.id, person.id],
            )
          ).rowCount,
          1,
        );
        assert.equal((await peer.currentSession(issued.token)).user.id, person.id);
        await peer.revokeSession(issued.token);
      },
    );

    await context.test("an older controller image cannot sign in after activation", async () => {
      // The unguarded composition is what a pre-activation image runs: plain
      // Better Auth sessions over the same database, with no binding rows.
      const before = await sessionCount(person.id);
      // The session insert reaches the database fence, which Drizzle wraps.
      await assert.rejects(
        auth.auth.api.signInEmail({ body: { email: person.email, password } }),
        (error) => fenceMessage.test(error.cause?.message),
      );
      assert.equal(await sessionCount(person.id), before);
    });

    await context.test(
      "provisioning after activation is atomic, enrolled and rejects duplicate email",
      async () => {
        const created = await preparedAccount("provisioned");
        const createdSeed = auth.principalSeed(created, { roleId });
        await peer.provisionPasswordAccount(created, createdSeed);
        assert.deepEqual(await rowCounts(created.id, createdSeed.principal.id), {
          users: 1,
          methods: 1,
          principals: 1,
          bindings: 1,
          enrolled: 1,
        });
        const snapshot = await persistence.snapshotPassword(created.email);
        assert.equal(snapshot.proof.principalId, createdSeed.principal.id);
        const session = await persistence.issueSession(snapshot.proof, sessionRecord(created.id));
        assert.equal((await peer.currentSession(session.token)).user.id, created.id);
        assert.equal((await persistence.readAccount(created.id, admin)).version, 1);

        const duplicate = { ...(await preparedAccount("duplicate")), email: created.email };
        await assert.rejects(
          persistence.provisionPasswordAccount(
            duplicate,
            auth.principalSeed(duplicate, { roleId }),
          ),
          { name: "UserAlreadyExistsError" },
        );

        const failing = await preparedAccount("failing");
        const failingSeed = auth.principalSeed(failing, { roleId });
        const failingState = new PostgresPlatformState(
          transportPool(pool, async (client, sql, parameters) => {
            if (sql.includes("INSERT INTO occ.human_authentication_accounts")) {
              throw Object.assign(new Error("Simulated enrolment failure"), { code: "08006" });
            }
            return client.query(sql, parameters);
          }),
        );
        await assert.rejects(
          new PostgresHumanAuthentication(
            failingState,
            installation.id,
            issuer,
          ).provisionPasswordAccount(failing, failingSeed),
          {
            name: "DependencyUnavailableError",
            message: "The platform persistence repository is unavailable.",
          },
        );
        assert.deepEqual(await rowCounts(failing.id, failingSeed.principal.id), {
          users: 0,
          methods: 0,
          principals: 0,
          bindings: 0,
          enrolled: 0,
        });

        // A lost COMMIT reply reports an unknown outcome, never a rollback. The
        // login and its Principal share the transaction, so they cannot diverge.
        const uncertain = await preparedAccount("uncertain");
        const uncertainSeed = auth.principalSeed(uncertain, { roleId });
        let commits = 0;
        const lostAckState = new PostgresPlatformState(
          transportPool(pool, async (client, sql, parameters) => {
            const result = await client.query(sql, parameters);
            if (sql === "COMMIT") {
              commits++;
              throw new Error("Simulated lost provisioning commit acknowledgement");
            }
            return result;
          }),
        );
        await assert.rejects(
          new PostgresHumanAuthentication(
            lostAckState,
            installation.id,
            issuer,
          ).provisionPasswordAccount(uncertain, uncertainSeed),
          { name: "PostgresCommitOutcomeUnknownError" },
        );
        assert.equal(commits, 1, "an uncertain provisioning is never replayed");
        assert.deepEqual(await rowCounts(uncertain.id, uncertainSeed.principal.id), {
          users: 1,
          methods: 1,
          principals: 1,
          bindings: 1,
          enrolled: 1,
        });
        // Retrying the same email converges on the committed account.
        const retry = { ...(await preparedAccount("uncertain-retry")), email: uncertain.email };
        await assert.rejects(
          persistence.provisionPasswordAccount(retry, auth.principalSeed(retry, { roleId })),
          { name: "UserAlreadyExistsError" },
        );
        assert.equal((await persistence.snapshotPassword(uncertain.email)).user.id, uncertain.id);
      },
    );

    await context.test(
      "attachment uses the existing Principal and retains no provider credential",
      async () => {
        const before = await state.loadNativeIAMState(installation.id);
        const passwordProof = (await persistence.snapshotPassword(person.email)).proof;
        const oldSession = await persistence.issueSession(passwordProof, sessionRecord(person.id));
        const target = await persistence.readAccount(person.id, admin);
        const attachment = await persistence.attachExternal(
          person.id,
          providerId,
          subject,
          admin,
          target.version,
        );
        assert.equal(await peer.currentSession(oldSession.token), undefined);
        // Attach deletes the account's sessions; the version bump alone leaves stale rows.
        assert.equal(
          (await pool.query("SELECT 1 FROM occ.session WHERE id = $1", [oldSession.id])).rowCount,
          0,
        );
        await assert.rejects(
          persistence.issueSession(passwordProof, sessionRecord(person.id)),
          /no longer current/,
        );
        const attached = await peer.readAccount(person.id, admin);
        assert.equal(attached.version, target.version + 1);
        assert.equal(attached.principalId, seed.principal.id);
        assert.ok(
          attached.methods.some(
            (method) => method.providerId === providerId && method.subject === subject,
          ),
        );
        await assert.rejects(
          peer.attachExternal(person.id, providerId, subject, admin, target.version),
          { name: "ResourceStateConflictError" },
        );
        assert.equal(attachment.created, true);
        assert.deepEqual(
          await peer.attachExternal(person.id, providerId, subject, admin, attached.version),
          { ...attachment, created: false },
        );
        await assert.rejects(
          peer.attachExternal(
            recoveryUser.id,
            providerId,
            subject,
            admin,
            (await peer.readAccount(recoveryUser.id, admin)).version,
          ),
          /already assigned/,
        );
        assert.deepEqual(await state.loadNativeIAMState(installation.id), before);
        const method = (
          await pool.query("SELECT * FROM occ.account WHERE id=$1", [attachment.methodId])
        ).rows[0];
        for (const field of [
          "access_token",
          "refresh_token",
          "id_token",
          "access_token_expires_at",
          "refresh_token_expires_at",
          "scope",
          "password",
        ]) {
          assert.equal(method[field], null);
        }
        await assert.rejects(
          pool.query("UPDATE occ.account SET access_token=$2 WHERE id=$1", [
            attachment.methodId,
            "test-only-token",
          ]),
          { code: "23514" },
        );
        const external = await persistence.snapshotExternal(providerId, subject);
        assert.equal(external.proof.principalId, seed.principal.id);
        assert.equal(external.user.email, person.email);
        assert.equal(external.proof.passwordHash, undefined);
        assert.equal(await persistence.snapshotExternal(providerId, "missing"), undefined);
      },
    );

    await context.test("an external subject resolves only under its own provider", async () => {
      // attachExternal and snapshotExternal do not consult the configured provider list;
      // only issuance and session reads do, so an unconfigured second provider is enough here.
      const secondProvider = `second-${suffix}`;
      await persistence.attachExternal(
        early.id,
        secondProvider,
        subject,
        admin,
        (await persistence.readAccount(early.id, admin)).version,
      );
      assert.equal((await persistence.snapshotExternal(providerId, subject))?.user.id, person.id);
      assert.equal(
        (await persistence.snapshotExternal(secondProvider, subject))?.user.id,
        early.id,
      );
    });

    await context.test(
      "attempts require the exact browser and destination and are consumed once across controllers",
      async () => {
        const attempt = {
          stateHash: randomBytes(32).toString("hex"),
          browserHash: randomBytes(32).toString("hex"),
          providerId,
          callbackURL: "https://console.example.test/auth/external/callback",
          codeVerifier: randomBytes(48).toString("base64url"),
        };
        const created = await persistence.createAttempt(attempt);
        assert.equal(created.expiresAt.getTime() - created.createdAt.getTime(), 5 * 60 * 1000);
        assert.equal(
          await peer.consumeAttempt({ ...attempt, browserHash: randomBytes(32).toString("hex") }),
          undefined,
        );
        assert.equal(await peer.consumeAttempt({ ...attempt, providerId: "different" }), undefined);
        assert.equal(
          await peer.consumeAttempt({
            ...attempt,
            callbackURL: "https://other.example.test/callback",
          }),
          undefined,
        );
        const consumed = await Promise.all([
          persistence.consumeAttempt(attempt),
          peer.consumeAttempt(attempt),
        ]);
        assert.equal(consumed.filter(Boolean).length, 1);
        const winner = consumed.find(Boolean);
        assert.equal(winner.codeVerifier, attempt.codeVerifier);
        assert.ok(await persistence.snapshotExternal(providerId, subject, winner.createdAt));
        await changeAccount(person.id, "revoke");
        assert.equal(
          await persistence.snapshotExternal(providerId, subject, winner.createdAt),
          undefined,
        );
        const expired = { ...attempt, stateHash: randomBytes(32).toString("hex") };
        await persistence.createAttempt(expired);
        // The application role cannot edit attempt deadlines. Reinsert only this
        // owned fixture row with aged timestamps, then exercise the real reader.
        await pool.query(
          `WITH aged AS (DELETE FROM occ.human_authentication_attempts WHERE state_hash=$1 RETURNING *)
          INSERT INTO occ.human_authentication_attempts SELECT state_hash,browser_hash,installation_id,provider_id,callback_url,code_verifier,
          timestamptz '2000-01-01 00:00:00Z', timestamptz '2000-01-01 00:05:00Z' FROM aged`,
          [expired.stateHash],
        );
        assert.equal(await peer.consumeAttempt(expired), undefined);
      },
    );

    await context.test(
      "a full pending attempt table evicts the oldest attempts and expired cleanup has a finite batch",
      async () => {
        const attempt = {
          stateHash: randomBytes(32).toString("hex"),
          browserHash: randomBytes(32).toString("hex"),
          providerId,
          callbackURL: "https://console.example.test/api/auth/providers/github/callback",
          codeVerifier: randomBytes(48).toString("base64url"),
        };
        // Fill genuine State-owned rows, leaving one slot for competing creators.
        await pool.query("DELETE FROM occ.human_authentication_attempts WHERE installation_id=$1", [
          installation.id,
        ]);
        const oldest = { ...attempt, stateHash: randomBytes(32).toString("hex") };
        await persistence.createAttempt(oldest);
        const secondOldest = { ...attempt, stateHash: randomBytes(32).toString("hex") };
        await persistence.createAttempt(secondOldest);
        for (let i = 0; i < 997; i++) {
          await persistence.createAttempt({
            ...attempt,
            stateHash: randomBytes(32).toString("hex"),
          });
        }
        // A full table must not refuse new starts: anyone can create attempts, so a refusal
        // would let one client block every provider sign-in. The oldest pending attempt goes.
        const competitor = { ...attempt, stateHash: randomBytes(32).toString("hex") };
        const results = await Promise.allSettled([
          persistence.createAttempt(attempt),
          peer.createAttempt(competitor),
        ]);
        assert.deepEqual(
          results.map((result) => result.status),
          ["fulfilled", "fulfilled"],
        );
        assert.equal(await peer.consumeAttempt(oldest), undefined);
        assert.ok(await peer.consumeAttempt(competitor));
        assert.ok(await peer.consumeAttempt(attempt));
        assert.ok(await peer.consumeAttempt(secondOldest));
        await persistence.createAttempt(attempt);
        await persistence.createAttempt(competitor);
        await persistence.createAttempt(secondOldest);
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS count FROM occ.human_authentication_attempts WHERE installation_id=$1",
              [installation.id],
            )
          ).rows[0].count,
          1000,
        );
        await pool.query(
          `WITH aged AS (DELETE FROM occ.human_authentication_attempts WHERE installation_id=$1 RETURNING *)
        INSERT INTO occ.human_authentication_attempts SELECT state_hash,browser_hash,installation_id,provider_id,callback_url,code_verifier,
        timestamptz '2000-01-01 00:00:00Z', timestamptz '2000-01-01 00:05:00Z' FROM aged`,
          [installation.id],
        );
        await persistence.createAttempt({ ...attempt, stateHash: randomBytes(32).toString("hex") });
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS count FROM occ.human_authentication_attempts WHERE installation_id=$1",
              [installation.id],
            )
          ).rows[0].count,
          901,
          "one start cleans at most 100 expired rows and adds one attempt",
        );
        await pool.query("DELETE FROM occ.human_authentication_attempts WHERE installation_id=$1", [
          installation.id,
        ]);
      },
    );

    await context.test("password and external proofs share account-wide revocation", async () => {
      const passwordSnapshot = await persistence.snapshotPassword(person.email);
      const externalSnapshot = await persistence.snapshotExternal(providerId, subject);
      const passwordSession = await persistence.issueSession(
        passwordSnapshot.proof,
        sessionRecord(person.id),
      );
      const externalSession = await peer.issueSession(
        externalSnapshot.proof,
        sessionRecord(person.id),
      );
      assert.equal((await persistence.currentSession(passwordSession.token)).user.id, person.id);
      assert.equal(
        await new PostgresHumanAuthentication(
          state,
          installation.id,
          "wrong-issuer",
        ).currentSession(passwordSession.token),
        undefined,
      );
      assert.equal((await peer.currentSession(externalSession.token)).user.id, person.id);
      await changeAccount(person.id, "revoke", peer);
      assert.equal(await persistence.currentSession(passwordSession.token), undefined);
      assert.equal(await persistence.currentSession(externalSession.token), undefined);
      await assert.rejects(
        persistence.issueSession(passwordSnapshot.proof, sessionRecord(person.id)),
        /no longer current/,
      );
      await assert.rejects(
        persistence.issueSession(externalSnapshot.proof, sessionRecord(person.id)),
        /no longer current/,
      );
      const fresh = await peer.snapshotPassword(person.email);
      const session = await peer.issueSession(fresh.proof, sessionRecord(person.id));
      assert.ok(await persistence.currentSession(session.token));
      await pool.query("UPDATE occ.account SET password=$2 WHERE id=$1", [
        fresh.proof.methodId,
        await (await auth.auth.$context).password.hash("replacement-password-for-currentness"),
      ]);
      assert.equal(await persistence.currentSession(session.token), undefined);
      await assert.rejects(
        persistence.issueSession(fresh.proof, sessionRecord(person.id)),
        /no longer current/,
      );
      await pool.query("UPDATE occ.account SET password=$2 WHERE id=$1", [
        fresh.proof.methodId,
        fresh.proof.passwordHash,
      ]);
      // The original hash is back, but under a new method version: the proof stays stale.
      await assert.rejects(
        persistence.issueSession(fresh.proof, sessionRecord(person.id)),
        /no longer current/,
      );
    });

    await context.test("the shared user lock serializes issuance before revocation", async () => {
      const proof = (await persistence.snapshotExternal(providerId, subject)).proof;
      const inserted = Promise.withResolvers();
      const release = Promise.withResolvers();
      const heldPool = transportPool(pool, async (client, sql, parameters) => {
        const result = await client.query(sql, parameters);
        if (sql.includes("INSERT INTO occ.session")) {
          inserted.resolve();
          await release.promise;
        }
        return result;
      });
      const held = new PostgresHumanAuthentication(
        new PostgresPlatformState(heldPool),
        installation.id,
        issuer,
        configured,
      );
      const record = sessionRecord(person.id);
      const issuing = held.issueSession(proof, record);
      await inserted.promise;
      try {
        const boundedPool = transportPool(pool, async (client, sql, parameters) => {
          if (sql.startsWith("SELECT") && sql.includes("FOR UPDATE")) {
            await client.query("SET LOCAL lock_timeout = '100ms'");
          }
          return client.query(sql, parameters);
        });
        const bounded = new PostgresHumanAuthentication(
          new PostgresPlatformState(boundedPool),
          installation.id,
          issuer,
          configured,
        );
        // A lock timeout (55P03) is retryable contention, not an internal error.
        await assert.rejects(changeAccount(person.id, "revoke", bounded), {
          name: "DependencyUnavailableError",
          message: /lock timeout/,
        });
      } finally {
        release.resolve();
      }
      await issuing;
      await changeAccount(person.id, "revoke", peer);
      assert.equal(await persistence.currentSession(record.token), undefined);
    });

    await context.test(
      "State owns absolute session deadlines and expires persisted sessions",
      async () => {
        const proof = (await persistence.snapshotPassword(person.email)).proof;
        const proposed = sessionRecord(person.id);
        proposed.createdAt = new Date("2099-01-01T00:00:00Z");
        proposed.updatedAt = proposed.createdAt;
        proposed.expiresAt = new Date("2100-01-01T00:00:00Z");
        const issued = await persistence.issueSession(proof, proposed);
        assert.equal(issued.expiresAt.getTime() - issued.createdAt.getTime(), 8 * 60 * 60 * 1000);
        assert.ok(issued.createdAt.getTime() < proposed.createdAt.getTime());
        await pool.query(
          "UPDATE occ.session SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [issued.id],
        );
        assert.equal(await peer.currentSession(issued.token), undefined);
      },
    );

    for (const invalidation of ["logout", "revoke"]) {
      await context.test(
        `actor ${invalidation} serializes before target administration and rejects its stale authority`,
        async () => {
          await signInAdmin();
          const oldActor = admin;
          const oldSession = adminSession;
          const target = await persistence.readAccount(person.id, oldActor);
          const actorTarget = await persistence.readAccount(recoveryUser.id, oldActor);
          const invalidated = Promise.withResolvers();
          const release = Promise.withResolvers();
          const requested = Promise.withResolvers();
          const holding = new PostgresHumanAuthentication(
            new PostgresPlatformState(
              transportPool(pool, async (client, sql, parameters) => {
                const result = await client.query(sql, parameters);
                if (sql.includes("DELETE FROM occ.session")) {
                  invalidated.resolve();
                  await release.promise;
                }
                return result;
              }),
            ),
            installation.id,
            issuer,
            configured,
          );
          const contending = new PostgresHumanAuthentication(
            new PostgresPlatformState(
              transportPool(pool, async (client, sql, parameters) => {
                if (sql.includes("FOR UPDATE")) {
                  requested.resolve();
                }
                return client.query(sql, parameters);
              }),
            ),
            installation.id,
            issuer,
            configured,
          );
          const invalidating =
            invalidation === "logout"
              ? holding.revokeSession(oldSession.token)
              : holding.changeAccount(recoveryUser.id, "revoke", oldActor, actorTarget.version);
          await invalidated.promise;
          // Start the real mutation while revocation owns the actor lock. It must
          // observe the revoked session after that transaction commits.
          const denied = assert.rejects(
            contending.changeAccount(person.id, "revoke", oldActor, target.version),
            { name: "AuthorizationDeniedError" },
          );
          try {
            await requested.promise;
          } finally {
            release.resolve();
          }
          await invalidating;
          await denied;
          await assert.rejects(peer.readAccount(person.id, oldActor), {
            name: "AuthorizationDeniedError",
          });
          await signInAdmin();
          assert.deepEqual(await persistence.readAccount(person.id, admin), target);
        },
      );
    }

    await context.test(
      "administrative audit failure rolls back and unknown commit requires a separately guarded read",
      async () => {
        const target = await persistence.readAccount(person.id, admin);
        const rejectAuditPool = transportPool(pool, async (client, sql, parameters) => {
          if (sql.includes("INSERT INTO occ.audit_events")) {
            return client.query(sql, ["invalid-audit-id", ...parameters.slice(1)]);
          }
          return client.query(sql, parameters);
        });
        const rejecting = new PostgresHumanAuthentication(
          new PostgresPlatformState(rejectAuditPool),
          installation.id,
          issuer,
          configured,
        );
        await assert.rejects(rejecting.changeAccount(person.id, "revoke", admin, target.version), {
          name: "ScopeViolationError",
        });
        assert.deepEqual(await peer.readAccount(person.id, admin), target);
        let commits = 0;
        const lostAckPool = transportPool(pool, async (client, sql, parameters) => {
          const result = await client.query(sql, parameters);
          if (sql === "COMMIT") {
            commits++;
            throw new Error("Simulated lost administrative commit acknowledgement");
          }
          return result;
        });
        const uncertain = new PostgresHumanAuthentication(
          new PostgresPlatformState(lostAckPool),
          installation.id,
          issuer,
          configured,
        );
        await assert.rejects(uncertain.changeAccount(person.id, "revoke", admin, target.version), {
          name: "PostgresCommitOutcomeUnknownError",
        });
        assert.equal(commits, 1, "an uncertain mutation is never replayed");
        // This is current state, not a receipt attributing the effect to a request.
        assert.equal((await peer.readAccount(person.id, admin)).version, target.version + 1);
        await assert.rejects(peer.changeAccount(person.id, "revoke", admin, target.version), {
          name: "ResourceStateConflictError",
        });
      },
    );

    await context.test(
      "disable invalidates both methods and cannot issue a stale proof",
      async () => {
        const proof = (await persistence.snapshotExternal(providerId, subject)).proof;
        const record = await persistence.issueSession(proof, sessionRecord(person.id));
        await changeAccount(person.id, "disable", peer);
        assert.equal(await persistence.currentSession(record.token), undefined);
        assert.equal(await persistence.snapshotPassword(person.email), undefined);
        assert.equal(await persistence.snapshotExternal(providerId, subject), undefined);
        await assert.rejects(
          persistence.issueSession(proof, sessionRecord(person.id)),
          /no longer current/,
        );
        // A disabled target is a state conflict (409), not an unknown account (404).
        const disabledTarget = await persistence.readAccount(person.id, admin);
        await assert.rejects(
          persistence.attachExternal(person.id, providerId, "99", admin, disabledTarget.version),
          { name: "ResourceStateConflictError", message: /account is disabled/ },
        );
        assert.deepEqual(await persistence.readAccount(person.id, admin), disabledTarget);
        const audits = await state.transact((unit) => unit.audit.list());
        assert.ok(
          audits.some(
            (event) =>
              event.action === "authentication.login" && event.actorId === seed.principal.id,
          ),
        );
        assert.ok(
          audits.some(
            (event) =>
              event.action === "authentication.account.disable" &&
              event.actorId === recoveryPrincipal.id,
          ),
        );
      },
    );

    await context.test(
      "repair enrolment admits only a provisioned single-password account",
      async () => {
        const orphan = await auth.createAccount({
          email: `repair-orphan-${suffix}@example.test`,
          password,
        });
        await assert.rejects(persistence.enrolAccount(orphan.id, admin), {
          name: "ScopeViolationError",
        });
        assert.equal(
          (
            await pool.query("SELECT 1 FROM occ.human_authentication_accounts WHERE user_id=$1", [
              orphan.id,
            ])
          ).rowCount,
          0,
        );
        await pool.query('DELETE FROM occ."user" WHERE id=$1', [orphan.id]);
        const stale = { ...admin, sessionId: randomUUID() };
        await assert.rejects(persistence.enrolAccount(recoveryUser.id, stale), {
          name: "AuthorizationDeniedError",
        });
        const again = await persistence.enrolAccount(person.id, admin);
        assert.equal(again.created, false);
        assert.equal(again.principalId, seed.principal.id);
      },
    );

    await context.test(
      "recovery replacement moves the one designation and the credential guard with it",
      async () => {
        await signInAdmin();
        const successor = await auth.createAccount({
          email: `successor-${suffix}@example.test`,
          password,
        });
        const successorSeed = auth.principalSeed(successor, { roleId });
        await state.appendNativeIAMPrincipal(successorSeed);
        const successorPrincipal = successorSeed.principal.id;
        assert.deepEqual(await persistence.readRecovery(admin), {
          userId: recoveryUser.id,
          principalId: recoveryPrincipal.id,
          methodId: (
            await pool.query(
              "SELECT id FROM occ.account WHERE user_id=$1 AND provider_id='credential'",
              [recoveryUser.id],
            )
          ).rows[0].id,
        });
        // An unenrolled account cannot hold the designation until it is repaired.
        await assert.rejects(
          persistence.replaceRecovery(successor.id, successorPrincipal, recoveryUser.id, admin, 1),
          { name: "ScopeViolationError" },
        );
        const enrolled = await persistence.enrolAccount(successor.id, admin);
        assert.deepEqual(enrolled, { principalId: successorPrincipal, version: 1, created: true });
        const disabled = await persistence.readAccount(person.id, admin);
        assert.equal(disabled.disabled, true);
        await assert.rejects(
          persistence.replaceRecovery(
            person.id,
            seed.principal.id,
            recoveryUser.id,
            admin,
            disabled.version,
          ),
          { name: "ResourceStateConflictError", message: /account is disabled/ },
        );
        await assert.rejects(
          persistence.replaceRecovery(successor.id, successorPrincipal, successor.id, admin, 1),
          { name: "ResourceStateConflictError" },
        );
        await assert.rejects(
          persistence.replaceRecovery(successor.id, successorPrincipal, recoveryUser.id, admin, 2),
          { name: "ResourceStateConflictError" },
        );
        await assert.rejects(
          persistence.replaceRecovery(successor.id, seed.principal.id, recoveryUser.id, admin, 1),
          /recovery account is unavailable/,
        );
        await assert.rejects(
          persistence.replaceRecovery(
            successor.id,
            successorPrincipal,
            recoveryUser.id,
            { ...admin, sessionId: randomUUID() },
            1,
          ),
          { name: "AuthorizationDeniedError" },
        );
        const results = await Promise.allSettled([
          persistence.replaceRecovery(successor.id, successorPrincipal, recoveryUser.id, admin, 1),
          peer.replaceRecovery(successor.id, successorPrincipal, recoveryUser.id, admin, 1),
        ]);
        const replaced = results.filter((result) => result.status === "fulfilled");
        assert.equal(replaced.length, 1, "the expected current designation admits one replacement");
        assert.equal(replaced[0].value.changed, true);
        // The committed holder's email is what the controller moves the reserved lane to.
        assert.equal(replaced[0].value.email, `successor-${suffix}@example.test`);
        assert.equal(
          results.find((result) => result.status === "rejected").reason.name,
          "ResourceStateConflictError",
        );
        const designations = (
          await pool.query(
            "SELECT r.user_id, r.principal_id, m.user_id AS method_user FROM occ.human_authentication_recovery r JOIN occ.account m ON m.id = r.method_id",
          )
        ).rows;
        assert.deepEqual(designations, [
          { user_id: successor.id, principal_id: successorPrincipal, method_user: successor.id },
        ]);
        const moved = await persistence.recoveryDesignation();
        assert.equal(moved.userId, successor.id);
        assert.equal(moved.principalId, successorPrincipal);
        const current = await persistence.readAccount(successor.id, admin);
        assert.equal(
          (
            await persistence.replaceRecovery(
              successor.id,
              successorPrincipal,
              successor.id,
              admin,
              current.version,
            )
          ).changed,
          false,
        );
        // The trigger guard follows the designation to the new password.
        await assert.rejects(
          pool.query("UPDATE occ.account SET password=NULL WHERE user_id=$1", [successor.id]),
          /recovery credential cannot be removed/,
        );
        await assert.rejects(pool.query('DELETE FROM occ."user" WHERE id=$1', [successor.id]), {
          code: "23001",
        });
        const previousHash = (
          await pool.query(
            "SELECT password FROM occ.account WHERE user_id=$1 AND provider_id='credential'",
            [recoveryUser.id],
          )
        ).rows[0].password;
        await pool.query(
          "UPDATE occ.account SET password=NULL WHERE user_id=$1 AND provider_id='credential'",
          [recoveryUser.id],
        );
        await pool.query(
          "UPDATE occ.account SET password=$2 WHERE user_id=$1 AND provider_id='credential'",
          [recoveryUser.id, previousHash],
        );
        await signInAdmin();
        await assert.rejects(changeAccount(successor.id, "disable"), {
          name: "ResourceStateConflictError",
          message: /recovery account cannot be disabled/,
        });
        // The application role cannot delete the designation, only move it.
        await assert.rejects(
          pool.query("DELETE FROM occ.human_authentication_recovery WHERE installation_id=$1", [
            installation.id,
          ]),
          { code: "42501" },
        );
        await assert.rejects(
          persistence.activateRecovery(recoveryUser.id, recoveryPrincipal.id),
          /designation cannot be changed/,
        );
        const audits = await state.transact((unit) => unit.audit.list());
        const audit = audits.find((event) => event.action === "authentication.recovery.replace");
        assert.equal(audit.actorId, recoveryPrincipal.id);
        assert.deepEqual(audit.details, {
          userId: successor.id,
          principalId: successorPrincipal,
          previousUserId: recoveryUser.id,
          previousPrincipalId: recoveryPrincipal.id,
        });
        assert.ok(
          audits.some(
            (event) =>
              event.action === "authentication.account.enrol" &&
              event.details?.userId === successor.id,
          ),
        );
        // Replace back so the original recovery account holds the guard again.
        const original = await persistence.readAccount(recoveryUser.id, admin);
        await persistence.replaceRecovery(
          recoveryUser.id,
          recoveryPrincipal.id,
          successor.id,
          admin,
          original.version,
        );
        await changeAccount(successor.id, "disable");
        assert.equal((await persistence.recoveryDesignation()).userId, recoveryUser.id);
      },
    );

    await context.test("enable restores a disabled account under a new version", async () => {
      const disabled = await persistence.readAccount(person.id, admin);
      assert.equal(disabled.disabled, true);
      await persistence.changeAccount(person.id, "enable", admin, disabled.version);
      const enabled = await peer.readAccount(person.id, admin);
      assert.equal(enabled.disabled, false);
      assert.equal(enabled.version, disabled.version + 1);
      assert.ok(await persistence.snapshotPassword(person.email));
      await assert.rejects(peer.changeAccount(person.id, "enable", admin, enabled.version), {
        name: "ResourceStateConflictError",
      });
      await assert.rejects(peer.changeAccount(person.id, "enable", admin, disabled.version), {
        name: "ResourceStateConflictError",
      });
    });

    await context.test(
      "an external session authenticates only while its provider instance is configured",
      async () => {
        const external = await persistence.snapshotExternal(providerId, subject);
        const password = await persistence.snapshotPassword(person.email);
        const externalSession = await persistence.issueSession(
          external.proof,
          sessionRecord(person.id),
        );
        const passwordSession = await persistence.issueSession(
          password.proof,
          sessionRecord(person.id),
        );
        const elsewhere = new PostgresHumanAuthentication(state, installation.id, issuer, {
          externalProviderIds: [`other-${suffix}`],
        });
        const passwordOnly = new PostgresHumanAuthentication(state, installation.id, issuer);
        assert.throws(
          () =>
            new PostgresHumanAuthentication(state, installation.id, issuer, {
              externalProviderIds: ["credential"],
            }),
          { name: "ScopeViolationError" },
        );
        for (const store of [elsewhere, passwordOnly]) {
          await assert.rejects(
            store.issueSession(external.proof, sessionRecord(person.id)),
            /no longer current/,
          );
          assert.equal((await store.currentSession(passwordSession.token)).user.id, person.id);
        }
        // The in-transaction actor re-check follows the same configuration.
        const actor = {
          userId: person.id,
          sessionId: externalSession.id,
          principalId: external.proof.principalId,
        };
        await assert.rejects(elsewhere.readAccount(person.id, actor), {
          name: "AuthorizationDeniedError",
        });
        assert.equal((await persistence.readAccount(person.id, actor)).userId, person.id);
        assert.equal((await peer.currentSession(externalSession.token)).user.id, person.id);

        const endings = async () =>
          (await state.transact((unit) => unit.audit.list())).filter(
            (event) =>
              event.action === "authentication.session.end" &&
              event.details.methodId === external.proof.methodId,
          );
        assert.deepEqual(await endings(), []);
        assert.equal(await elsewhere.currentSession(externalSession.token), undefined);
        assert.equal(await passwordOnly.currentSession(externalSession.token), undefined);
        // Ended, not just hidden: the configured store no longer sees it either.
        assert.equal(await persistence.currentSession(externalSession.token), undefined);
        assert.equal(
          (await pool.query("SELECT 1 FROM occ.session WHERE id = $1", [externalSession.id]))
            .rowCount,
          0,
        );
        const [ending, ...extra] = await endings();
        assert.deepEqual(extra, []);
        assert.equal(ending.actorId, external.proof.principalId);
        assert.deepEqual(ending.details, {
          userId: person.id,
          methodId: external.proof.methodId,
          providerId,
          reason: "PROVIDER_NOT_CONFIGURED",
        });
        assert.equal((await persistence.currentSession(passwordSession.token)).user.id, person.id);
      },
    );

    await context.test(
      "detach removes only an external identity and invalidates its sessions",
      async () => {
        const external = await persistence.snapshotExternal(providerId, subject);
        const session = await persistence.issueSession(external.proof, sessionRecord(person.id));
        const target = await persistence.readAccount(person.id, admin);
        const credential = target.methods.find((method) => method.providerId === "credential");
        const recoveryCredential = (await persistence.readAccount(recoveryUser.id, admin))
          .methods[0];
        for (const [userId, methodId] of [
          [person.id, credential.methodId],
          [recoveryUser.id, recoveryCredential.methodId],
          [recoveryUser.id, external.proof.methodId],
        ]) {
          const version = (await persistence.readAccount(userId, admin)).version;
          await assert.rejects(persistence.detachExternal(userId, methodId, admin, version), {
            name: "ResourceStateConflictError",
          });
        }
        await assert.rejects(
          persistence.detachExternal(person.id, external.proof.methodId, admin, target.version - 1),
          { name: "ResourceStateConflictError" },
        );
        assert.deepEqual(
          await peer.detachExternal(person.id, external.proof.methodId, admin, target.version),
          { methodId: external.proof.methodId, providerId },
        );
        const detached = await persistence.readAccount(person.id, admin);
        assert.equal(detached.version, target.version + 1);
        assert.deepEqual(
          detached.methods.map((method) => method.methodId),
          [credential.methodId],
        );
        assert.equal(await persistence.currentSession(session.token), undefined);
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS count FROM occ.human_authentication_sessions WHERE method_id=$1",
              [external.proof.methodId],
            )
          ).rows[0].count,
          0,
        );
        assert.equal(await persistence.snapshotExternal(providerId, subject), undefined);
        await assert.rejects(
          persistence.issueSession(external.proof, sessionRecord(person.id)),
          /no longer current/,
        );
        assert.ok(await persistence.snapshotPassword(person.email));
        const audits = await state.transact((unit) => unit.audit.list());
        assert.ok(
          audits.some(
            (event) =>
              event.action === "authentication.method.detach" &&
              event.details.methodId === external.proof.methodId,
          ),
        );
      },
    );
  },
);
