import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  PostgresHumanAuthentication,
  PostgresPlatformState,
} from "../../packages/occ/src/index.ts";
import {
  betterAuthIssuer,
  createPostgresControllerAuth,
} from "../../apps/controller/src/auth/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { parseAuthMaintainArguments } from "../../scripts/lib/auth-maintain-arguments.mjs";
import {
  ensureDevelopmentBootstrap,
  privateBootstrapDirectory,
} from "../helpers/bootstrap-installation.mjs";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const migrationUrl = process.env.OCC_AUTH_MAINTAIN_MIGRATION_DATABASE_URL;
const requiresPostgres = {
  skip:
    databaseUrl && migrationUrl
      ? false
      : "Set OCC_TEST_DATABASE_URL and OCC_AUTH_MAINTAIN_MIGRATION_DATABASE_URL for the same fresh database.",
};

test("auth:maintain requires an explicit writers-stopped claim for every change", () => {
  // The claim is also verified against the database; parsing only refuses to start without it.
  for (const args of [
    ["activate", "--recovery-user", "u1"],
    ["enrol", "u1"],
    ["reset-recovery-password", "--password-file", "/secret"],
    ["purge-sessions"],
    ["deactivate", "--purge-disabled"],
  ]) {
    assert.throws(() => parseAuthMaintainArguments(args), /--writers-stopped/);
  }
  assert.throws(() => parseAuthMaintainArguments(["status", "--writers-stopped"]), /Unsupported/);
  assert.throws(() => parseAuthMaintainArguments(["enrol", "--writers-stopped"]), /one user id/);
  assert.throws(
    () => parseAuthMaintainArguments(["activate", "--writers-stopped", "--recovery-user"]),
    /requires a value/,
  );
  assert.throws(() => parseAuthMaintainArguments(["drop-everything"]), /Unknown command/);
  assert.deepEqual(
    parseAuthMaintainArguments(["--", "purge-sessions", "--user", "u2", "--writers-stopped"]),
    {
      command: "purge-sessions",
      mutating: true,
      userId: "u2",
    },
  );
  assert.deepEqual(
    parseAuthMaintainArguments(["deactivate", "--writers-stopped", "--purge-disabled"]),
    {
      command: "deactivate",
      mutating: true,
      purgeDisabled: true,
    },
  );
});

function maintain(args, url = migrationUrl) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["scripts/auth-maintain.mjs", ...args],
      {
        cwd: repository,
        env: { ...process.env, NODE_ENV: "development", OCC_MIGRATION_DATABASE_URL: url },
        timeout: 30_000,
      },
      (error, stdout, stderr) => {
        const line = stdout.split("\n").find((entry) => entry.startsWith("{"));
        resolve({
          code: error ? error.code : 0,
          output: line ? JSON.parse(line) : undefined,
          stderr,
        });
      },
    );
  });
}

// Short-lived pools: every mutating command refuses while any other client is connected.
async function withPool(url, work) {
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  try {
    return await work(pool);
  } finally {
    await pool.end();
  }
}

function sessionRecord(userId) {
  return { id: randomUUID(), token: randomBytes(32).toString("hex"), userId };
}

test(
  "stopped maintenance activates, repairs, resets, purges and returns to the legacy profile",
  requiresPostgres,
  async (context) => {
    const suffix = randomUUID();
    const recoveryEmail = `recovery-${suffix}@example.test`;
    const password = "auth-maintenance-test-password";
    const secret = "auth-maintenance-integration-secret-32-characters";
    const baseURL = "http://127.0.0.1";
    const directory = await privateBootstrapDirectory(context, "openclaw-auth-maintain-");
    await ensureDevelopmentBootstrap(context, {
      databaseUrl,
      email: recoveryEmail,
      password,
      authSecret: secret,
      installationName: "Authentication maintenance",
      authBaseURL: baseURL,
    });

    // A pre-#305 style controller (no State) provisions accounts and Principals.
    const legacy = (pool) =>
      createPostgresControllerAuth({
        mode: "development",
        installationId,
        baseURL,
        secret,
        pool,
      });
    let installationId;
    let recoveryUserId;
    let adminRoleId;
    let disabledUser;
    await withPool(databaseUrl, async (pool) => {
      const state = new PostgresPlatformState(pool);
      installationId = (await state.loadInstallation()).id;
      const auth = await legacy(pool);
      const iam = await state.loadNativeIAMState(installationId);
      recoveryUserId = (
        await pool.query('SELECT id FROM occ."user" WHERE email = $1', [recoveryEmail])
      ).rows[0].id;
      const principal = iam.identities.find(
        (identity) => identity.kind === "principal" && identity.subject === recoveryUserId,
      );
      adminRoleId = iam.bindings.find((binding) => binding.subjectId === principal.id).roleId;
      disabledUser = await auth.createAccount({
        email: `disabled-${suffix}@example.test`,
        password,
      });
      await state.appendNativeIAMPrincipal(
        auth.principalSeed(disabledUser, { roleId: adminRoleId }),
      );
    });

    await context.test(
      "status reports the legacy profile and refuses the application role",
      async () => {
        const status = await maintain(["status"]);
        assert.equal(status.code, 0, status.stderr);
        assert.equal(status.output.installationId, installationId);
        assert.equal(status.output.profile, "legacy");
        assert.equal(status.output.users, 2);
        const denied = await maintain(["status"], databaseUrl);
        assert.equal(denied.code, 1);
        assert.match(denied.stderr, /migration role/);
      },
    );

    await context.test("activation refuses while another client is connected", async () => {
      // A connected occ_app client stands in for a running API replica.
      const replica = new pg.Client({ connectionString: databaseUrl });
      await replica.connect();
      try {
        const refused = await maintain([
          "activate",
          "--recovery-user",
          recoveryUserId,
          "--writers-stopped",
        ]);
        assert.equal(refused.code, 2, refused.stderr);
        assert.equal(refused.output.event, "auth-maintain.writers-running");
        assert.ok(refused.output.backends.some((backend) => backend.user === "occ_app"));
      } finally {
        await replica.end();
      }
      const status = await maintain(["status"]);
      assert.equal(status.output.profile, "legacy");

      // A failed activation precondition is a refusal (exit 3), not a failure.
      const unknown = await maintain([
        "activate",
        "--recovery-user",
        "missing-user",
        "--writers-stopped",
      ]);
      assert.equal(unknown.code, 3, unknown.stderr);
      assert.equal(unknown.output.reason, "ACTIVATION_REFUSED");
      assert.equal((await maintain(["status"])).output.profile, "legacy");

      const activated = await maintain([
        "activate",
        "--recovery-user",
        recoveryUserId,
        "--writers-stopped",
      ]);
      assert.equal(activated.code, 0, activated.stderr);
      assert.equal(activated.output.designation.userId, recoveryUserId);
      assert.equal(activated.output.enrolled, 2);
      // Re-running for the designated account changes nothing and writes no audit.
      const repeated = await maintain([
        "activate",
        "--recovery-user",
        recoveryUserId,
        "--writers-stopped",
      ]);
      assert.equal(repeated.code, 0, repeated.stderr);
      assert.equal(repeated.output.designation.userId, recoveryUserId);
      // The activated profile now refuses a controller started without an external sign-in provider.
      await withPool(databaseUrl, async (pool) => {
        await assert.rejects(
          createPostgresControllerAuth({
            mode: "development",
            installationId,
            baseURL,
            secret,
            pool,
            state: new PostgresPlatformState(pool),
          }),
          /requires a configured external sign-in provider/,
        );
      });
      // Google alone is such a provider: it composes the guarded profile without GitHub.
      await withPool(databaseUrl, async (pool) => {
        const state = new PostgresPlatformState(pool);
        const google = await createPostgresControllerAuth({
          mode: "development",
          installationId,
          baseURL,
          secret,
          pool,
          state,
          iamDriver: new NativeIAMDriver(state, { id: "native-iam", implementation: "native" }),
          google: {
            clientId: "google-client",
            clientSecret: "google-secret",
            allowedDomains: [],
            recoveryUserId,
          },
        });
        assert.equal(google.humanProfile, "guarded");
        assert.equal(google.googleEnabled, true);
        assert.equal(google.githubEnabled, false);
        assert.match(google.googleProviderId, /^google:[0-9a-f]{64}$/);
        assert.equal(google.attachGitHub, undefined);
        assert.equal(typeof google.attachGoogle, "function");
      });
    });

    let orphan;
    let unprovisioned;
    await context.test("enrol repairs an account an older controller created", async () => {
      await withPool(databaseUrl, async (pool) => {
        const auth = await legacy(pool);
        orphan = await auth.createAccount({ email: `orphan-${suffix}@example.test`, password });
        await new PostgresPlatformState(pool).appendNativeIAMPrincipal(
          auth.principalSeed(orphan, { roleId: adminRoleId }),
        );
        unprovisioned = await auth.createAccount({
          email: `unprovisioned-${suffix}@example.test`,
          password,
        });
        const persistence = new PostgresHumanAuthentication(
          new PostgresPlatformState(pool),
          installationId,
          betterAuthIssuer(installationId),
        );
        // The guarded profile refuses unenrolled accounts like bad credentials until repaired.
        assert.equal(await persistence.snapshotPassword(orphan.email), undefined);
      });
      const before = await maintain(["status"]);
      assert.deepEqual(
        before.output.unenrolled.map((account) => account.userId).sort(),
        [orphan.id, unprovisioned.id].sort(),
      );

      const enrolled = await maintain(["enrol", orphan.id, "--writers-stopped"]);
      assert.equal(enrolled.code, 0, enrolled.stderr);
      assert.equal(enrolled.output.userId, orphan.id);
      const repeated = await maintain(["enrol", orphan.id, "--writers-stopped"]);
      assert.equal(repeated.code, 3);
      assert.equal(repeated.output.reason, "ALREADY_ENROLLED");
      const missing = await maintain(["enrol", unprovisioned.id, "--writers-stopped"]);
      assert.equal(missing.code, 3);
      assert.equal(missing.output.reason, "PRINCIPAL_MISSING");

      await withPool(databaseUrl, async (pool) => {
        const persistence = new PostgresHumanAuthentication(
          new PostgresPlatformState(pool),
          installationId,
          betterAuthIssuer(installationId),
        );
        const snapshot = await persistence.snapshotPassword(orphan.email);
        assert.equal(snapshot.user.id, orphan.id);
        await persistence.issueSession(snapshot.proof, sessionRecord(orphan.id));
      });
    });

    await context.test(
      "status and activate follow a designation moved by online replacement",
      async () => {
        let admin;
        let persistence;
        await withPool(databaseUrl, async (pool) => {
          persistence = new PostgresHumanAuthentication(
            new PostgresPlatformState(pool),
            installationId,
            betterAuthIssuer(installationId),
          );
          const snapshot = await persistence.snapshotPassword(recoveryEmail);
          const session = await persistence.issueSession(
            snapshot.proof,
            sessionRecord(recoveryUserId),
          );
          admin = {
            userId: recoveryUserId,
            sessionId: session.id,
            principalId: snapshot.proof.principalId,
          };
          const target = await persistence.readAccount(orphan.id, admin);
          const moved = await persistence.replaceRecovery(
            orphan.id,
            target.principalId,
            recoveryUserId,
            admin,
            target.version,
          );
          assert.equal(moved.changed, true);
        });
        const status = await maintain(["status"]);
        assert.equal(status.code, 0, status.stderr);
        assert.equal(status.output.designation.userId, orphan.id);
        assert.equal(status.output.designation.email, orphan.email);

        // The configured id only seeds first activation; the moved designation is kept.
        const seeded = await maintain([
          "activate",
          "--recovery-user",
          recoveryUserId,
          "--writers-stopped",
        ]);
        assert.equal(seeded.code, 0, seeded.stderr);
        assert.equal(seeded.output.seedIgnored, true);
        assert.equal(seeded.output.designation.userId, orphan.id);
        assert.match(seeded.stderr, /differs from the recorded recovery designation/);

        await withPool(databaseUrl, async (pool) => {
          persistence = new PostgresHumanAuthentication(
            new PostgresPlatformState(pool),
            installationId,
            betterAuthIssuer(installationId),
          );
          const target = await persistence.readAccount(recoveryUserId, admin);
          await persistence.replaceRecovery(
            recoveryUserId,
            admin.principalId,
            orphan.id,
            admin,
            target.version,
          );
        });
        assert.equal((await maintain(["status"])).output.designation.userId, recoveryUserId);
      },
    );

    const replacement = "replacement-recovery-password";
    let adminToken;
    await context.test(
      "reset-recovery-password replaces the hash and ends recovery sessions",
      async () => {
        await withPool(databaseUrl, async (pool) => {
          const persistence = new PostgresHumanAuthentication(
            new PostgresPlatformState(pool),
            installationId,
            betterAuthIssuer(installationId),
          );
          const snapshot = await persistence.snapshotPassword(recoveryEmail);
          const session = await persistence.issueSession(
            snapshot.proof,
            sessionRecord(recoveryUserId),
          );
          adminToken = session.token;
          const admin = {
            userId: recoveryUserId,
            sessionId: session.id,
            principalId: snapshot.proof.principalId,
          };
          // Disable an account through the online API so deactivation must account for it.
          const target = await persistence.readAccount(disabledUser.id, admin);
          await persistence.changeAccount(disabledUser.id, "disable", admin, target.version);
        });
        const passwordFile = join(directory, "recovery-password");
        await writeFile(passwordFile, `${replacement}\n`, { mode: 0o600 });
        const short = join(directory, "short-password");
        await writeFile(short, "short\n", { mode: 0o600 });
        const refused = await maintain([
          "reset-recovery-password",
          "--password-file",
          short,
          "--writers-stopped",
        ]);
        assert.equal(refused.code, 1);
        assert.match(refused.stderr, /12 to 128 characters/);

        const reset = await maintain([
          "reset-recovery-password",
          "--password-file",
          passwordFile,
          "--writers-stopped",
        ]);
        assert.equal(reset.code, 0, reset.stderr);
        assert.deepEqual(reset.output, {
          event: "auth-maintain.reset-recovery-password",
          userId: recoveryUserId,
        });
        await withPool(databaseUrl, async (pool) => {
          const persistence = new PostgresHumanAuthentication(
            new PostgresPlatformState(pool),
            installationId,
            betterAuthIssuer(installationId),
          );
          assert.equal(await persistence.currentSession(adminToken), undefined);
        });
      },
    );

    await context.test("purge-sessions removes one account's or every session", async () => {
      const unknown = await maintain([
        "purge-sessions",
        "--user",
        "missing-user",
        "--writers-stopped",
      ]);
      assert.equal(unknown.code, 3);
      assert.equal(unknown.output.reason, "USER_NOT_FOUND");
      const one = await maintain(["purge-sessions", "--user", orphan.id, "--writers-stopped"]);
      assert.equal(one.code, 0, one.stderr);
      assert.equal(one.output.deletedSessionCount, 1);
      const all = await maintain(["purge-sessions", "--writers-stopped"]);
      assert.equal(all.code, 0, all.stderr);
      assert.equal(all.output.deletedSessionCount, 0);
    });

    await context.test("deactivation never re-admits a disabled account", async () => {
      const refused = await maintain(["deactivate", "--writers-stopped"]);
      assert.equal(refused.code, 3);
      assert.equal(refused.output.reason, "DISABLED_ACCOUNTS");
      assert.deepEqual(refused.output.disabledUserIds, [disabledUser.id]);
      assert.equal((await maintain(["status"])).output.profile, "guarded");

      const deactivated = await maintain(["deactivate", "--purge-disabled", "--writers-stopped"]);
      assert.equal(deactivated.code, 0, deactivated.stderr);
      assert.deepEqual(deactivated.output.passwordRemovedUserIds, [disabledUser.id]);
      const status = await maintain(["status"]);
      assert.equal(status.output.profile, "legacy");
      assert.equal(status.output.enrolled, 0);
      assert.equal(status.output.sessions, 0);
    });

    await context.test(
      "the legacy profile starts and signs in with the reset password",
      async () => {
        await withPool(databaseUrl, async (pool) => {
          const state = new PostgresPlatformState(pool);
          // Ordinary startup without GitHub configuration succeeds again.
          const auth = await createPostgresControllerAuth({
            mode: "development",
            installationId,
            baseURL,
            secret,
            pool,
            state,
          });
          const signedIn = await auth.auth.api.signInEmail({
            body: { email: recoveryEmail, password: replacement },
          });
          assert.equal(signedIn.user.id, recoveryUserId);
          const orphanSignIn = await auth.auth.api.signInEmail({
            body: { email: orphan.email, password },
          });
          assert.equal(orphanSignIn.user.id, orphan.id);
          // The disabled account lost its password instead of regaining access.
          await assert.rejects(
            auth.auth.api.signInEmail({ body: { email: disabledUser.email, password } }),
            { status: "UNAUTHORIZED", message: "Invalid email or password" },
          );
          // Unbound legacy sessions commit: nothing in the database still fences them.
          const { rowCount } = await pool.query(
            `INSERT INTO occ.session (id, token, user_id, created_at, updated_at, expires_at)
           VALUES ($1, $2, $3, now(), now(), now() + interval '1 hour')`,
            [randomUUID(), randomBytes(32).toString("hex"), orphan.id],
          );
          assert.equal(rowCount, 1);

          const audit = await pool.query(
            `SELECT action, actor_id FROM occ.audit_events WHERE action IN
           ('authentication.recovery.activate', 'authentication.account.enrol',
            'authentication.recovery.password-reset', 'authentication.sessions.purge',
            'authentication.recovery.deactivate') ORDER BY occurred_at, action`,
          );
          const maintenance = audit.rows.filter((row) => row.actor_id.startsWith("maintenance:"));
          assert.deepEqual(
            maintenance.map((row) => row.action),
            [
              "authentication.recovery.activate",
              "authentication.account.enrol",
              "authentication.recovery.password-reset",
              "authentication.sessions.purge",
              "authentication.sessions.purge",
              "authentication.recovery.deactivate",
            ],
          );
          // Activation also records startup's own event, attributed to the recovery Principal.
          const others = audit.rows.filter((row) => !row.actor_id.startsWith("maintenance:"));
          assert.deepEqual(
            others.map((row) => row.action),
            ["authentication.recovery.activate"],
          );
        });
      },
    );
  },
);
