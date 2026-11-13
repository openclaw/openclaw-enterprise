import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import pg from "pg";
import {
  betterAuthIssuer,
  createPostgresControllerAuth,
  type AuthenticatedAccount,
} from "../../apps/controller/src/auth/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  PostgresHumanAuthentication,
  PostgresPlatformState,
  type HumanAuthenticationActor,
} from "../../packages/occ/src/index.ts";
import { administrativeActor } from "../helpers/administrative-actor.mjs";
import {
  ensureDevelopmentBootstrap,
  privateBootstrapDirectory,
} from "../helpers/bootstrap-installation.mjs";
import { withPool } from "../helpers/postgres-database.mjs";
import {
  authMaintainLogs,
  record,
  requiredOutput,
  type AuthMaintainRunner,
} from "./auth-maintain-command-cases.ts";

const createAdministrator: (
  state: PostgresPlatformState,
  installationId: string,
  actor: Pick<HumanAuthenticationActor, "userId" | "sessionId" | "principalId">,
) => HumanAuthenticationActor = administrativeActor;

function sessionRecord(userId: string) {
  return { id: randomUUID(), token: randomBytes(32).toString("hex"), userId };
}

function readRecords(value: unknown, message: string): Record<string, unknown>[] {
  assert.ok(Array.isArray(value), message);
  const records: unknown[] = value;
  return records.map((entry) => record(entry, message));
}

function recoveryDesignation(output: Record<string, unknown>) {
  return record(output.designation, "Expected the recovery designation in auth:maintain output");
}

export async function runAuthMaintenanceLifecycle(
  context: TestContext,
  databaseUrl: string,
  { maintain, maintainScript, waitForNewBackendsToClose }: AuthMaintainRunner,
) {
  const suffix = randomUUID();
  const recoveryEmail = `recovery-${suffix}@example.test`;
  const password = "auth-maintenance-test-password";
  const secret = "auth-maintenance-integration-secret-32-characters";
  const baseURL = "https://console.oce.localhost";
  const directory = await privateBootstrapDirectory(context, "openclaw-auth-maintain-");
  await waitForNewBackendsToClose(() =>
    ensureDevelopmentBootstrap(context, {
      databaseUrl,
      email: recoveryEmail,
      password,
      authSecret: secret,
      installationName: "Authentication maintenance",
      authBaseURL: baseURL,
      inProcess: true,
    }),
  );

  const authOptions = {
    mode: "development" as const,
    baseURL,
    agentDomain: "agents.oce.localhost",
    secret,
  };
  const withApplicationPool = <T>(work: (pool: pg.Pool) => Promise<T>): Promise<T> =>
    withPool(databaseUrl, work);

  // A pre-#305 style controller (no State) provisions accounts and Principals.
  const legacy = (pool: pg.Pool, installationId: string) =>
    createPostgresControllerAuth({ ...authOptions, installationId, pool });
  const { installationId, recoveryUserId, adminRoleId, disabledUser } = await withApplicationPool(
    async (pool) => {
      const state = new PostgresPlatformState(pool);
      const installation = await state.loadInstallation();
      assert.ok(installation, "Development bootstrap must create an Installation");
      const installationId = installation.id;
      const auth = await legacy(pool, installationId);
      const iam = await state.loadNativeIAMState(installationId);
      const {
        rows: [recoveryUser],
      } = await pool.query<{ id: unknown }>('SELECT id FROM occ."user" WHERE email = $1', [
        recoveryEmail,
      ]);
      assert.ok(typeof recoveryUser?.id === "string", "Expected the bootstrapped recovery user ID");
      const recoveryUserId = recoveryUser.id;
      const principal = iam.identities.find(
        (identity) => identity.kind === "principal" && identity.subject === recoveryUserId,
      );
      assert.ok(principal, "Expected the bootstrapped recovery Principal");
      const binding = iam.bindings.find((binding) => binding.subjectId === principal.id);
      assert.ok(binding, "Expected the recovery Principal's role binding");
      const adminRoleId = binding.roleId;
      const disabledUser = await auth.createAccount({
        email: `disabled-${suffix}@example.test`,
        password,
      });
      await state.appendNativeIAMPrincipal(
        auth.principalSeed(disabledUser, { roleId: adminRoleId }),
      );
      return { installationId, recoveryUserId, adminRoleId, disabledUser };
    },
  );

  await context.test(
    "status reports the legacy profile and refuses the application role",
    async () => {
      const status = await maintainScript(["status"]);
      assert.equal(status.code, 0, status.stderr);
      const output = requiredOutput(status);
      assert.equal(output.installationId, installationId);
      // The log line names the Installation too (finding 2245).
      assert.equal(
        authMaintainLogs(status.stderr).find(({ event }) => event === "auth-maintain.status")
          ?.installationId,
        installationId,
        status.stderr,
      );
      assert.equal(output.profile, "legacy");
      assert.equal(output.users, 2);
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
      const refused = await maintainScript([
        "activate",
        "--recovery-user",
        recoveryUserId,
        "--writers-stopped",
      ]);
      assert.equal(refused.code, 2, refused.stderr);
      const output = requiredOutput(refused);
      assert.equal(output.event, "auth-maintain.writers-running");
      const backends = readRecords(output.backends, "Expected PostgreSQL backends in the refusal");
      assert.ok(backends.some((backend) => backend.user === "occ_app"));
    } finally {
      await replica.end();
    }
    const status = await maintain(["status"]);
    assert.equal(requiredOutput(status).profile, "legacy");

    // A failed activation precondition is a refusal (exit 3), not a failure.
    const unknown = await maintainScript([
      "activate",
      "--recovery-user",
      "missing-user",
      "--writers-stopped",
    ]);
    assert.equal(unknown.code, 3, unknown.stderr);
    assert.equal(requiredOutput(unknown).reason, "ACTIVATION_REFUSED");
    assert.equal(requiredOutput(await maintain(["status"])).profile, "legacy");

    const activated = await maintain([
      "activate",
      "--recovery-user",
      recoveryUserId,
      "--writers-stopped",
    ]);
    assert.equal(activated.code, 0, activated.stderr);
    const activation = requiredOutput(activated);
    assert.equal(recoveryDesignation(activation).userId, recoveryUserId);
    assert.equal(activation.enrolled, 2);
    // Re-running for the designated account changes nothing and writes no audit.
    const repeated = await maintain([
      "activate",
      "--recovery-user",
      recoveryUserId,
      "--writers-stopped",
    ]);
    assert.equal(repeated.code, 0, repeated.stderr);
    assert.equal(recoveryDesignation(requiredOutput(repeated)).userId, recoveryUserId);
    // The activated profile now refuses a controller started without an external sign-in provider.
    await withApplicationPool(async (pool) => {
      await assert.rejects(
        createPostgresControllerAuth({
          ...authOptions,
          installationId,
          pool,
          state: new PostgresPlatformState(pool),
        }),
        /requires a configured external sign-in provider/,
      );
    });
    // Google alone is such a provider: it composes the guarded profile without OIDC.
    await withApplicationPool(async (pool) => {
      const state = new PostgresPlatformState(pool);
      const google = await createPostgresControllerAuth({
        ...authOptions,
        installationId,
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
      assert.equal(google.oidcEnabled, false);
      assert.ok(typeof google.googleProviderId === "string", "Expected the Google provider ID");
      assert.match(google.googleProviderId, /^google:[0-9a-f]{64}$/);
      assert.equal(typeof google.attachGoogle, "function");
    });
  });

  let orphan: AuthenticatedAccount | undefined;
  await context.test("enrol repairs an account an older controller created", async () => {
    const { repairable, unprovisioned } = await withApplicationPool(async (pool) => {
      const auth = await legacy(pool, installationId);
      const repairable = await auth.createAccount({
        email: `orphan-${suffix}@example.test`,
        password,
      });
      await new PostgresPlatformState(pool).appendNativeIAMPrincipal(
        auth.principalSeed(repairable, { roleId: adminRoleId }),
      );
      const unprovisioned = await auth.createAccount({
        email: `unprovisioned-${suffix}@example.test`,
        password,
      });
      const persistence = new PostgresHumanAuthentication(
        new PostgresPlatformState(pool),
        installationId,
        betterAuthIssuer(installationId),
      );
      // The guarded profile refuses unenrolled accounts like bad credentials until repaired.
      assert.equal(await persistence.snapshotPassword(repairable.email), undefined);
      return { repairable, unprovisioned };
    });
    orphan = repairable;
    const before = requiredOutput(await maintain(["status"]));
    const unenrolled = readRecords(before.unenrolled, "Expected unenrolled accounts in status");
    const unenrolledUserIds = unenrolled.map(({ userId }) => {
      assert.ok(typeof userId === "string", "Expected an unenrolled user ID");
      return userId;
    });
    assert.deepEqual(unenrolledUserIds.sort(), [repairable.id, unprovisioned.id].sort());

    const enrolled = await maintain(["enrol", repairable.id, "--writers-stopped"]);
    assert.equal(enrolled.code, 0, enrolled.stderr);
    assert.equal(requiredOutput(enrolled).userId, repairable.id);
    const repeated = await maintain(["enrol", repairable.id, "--writers-stopped"]);
    assert.equal(repeated.code, 3);
    assert.equal(requiredOutput(repeated).reason, "ALREADY_ENROLLED");
    const missing = await maintain(["enrol", unprovisioned.id, "--writers-stopped"]);
    assert.equal(missing.code, 3);
    assert.equal(requiredOutput(missing).reason, "PRINCIPAL_MISSING");

    await withApplicationPool(async (pool) => {
      const persistence = new PostgresHumanAuthentication(
        new PostgresPlatformState(pool),
        installationId,
        betterAuthIssuer(installationId),
      );
      const snapshot = await persistence.snapshotPassword(repairable.email);
      assert.ok(snapshot, "The repaired account must have a password snapshot");
      assert.equal(snapshot.user.id, repairable.id);
      await persistence.issueSession(snapshot.proof, sessionRecord(repairable.id));
    });
  });

  await context.test(
    "status and activate follow a designation moved by online replacement",
    async () => {
      const enrolled = orphan;
      assert.ok(enrolled, "The enrolment case must create the repaired account");
      const actor = await withApplicationPool(async (pool) => {
        const state = new PostgresPlatformState(pool);
        const persistence = new PostgresHumanAuthentication(
          state,
          installationId,
          betterAuthIssuer(installationId),
        );
        const snapshot = await persistence.snapshotPassword(recoveryEmail);
        assert.ok(snapshot, "Expected the recovery user's password snapshot");
        const session = await persistence.issueSession(
          snapshot.proof,
          sessionRecord(recoveryUserId),
        );
        const actor = {
          userId: recoveryUserId,
          sessionId: session.id,
          principalId: snapshot.proof.principalId,
        };
        const admin = createAdministrator(state, installationId, actor);
        const target = await persistence.readAccount(enrolled.id, admin);
        const moved = await persistence.replaceRecovery(
          enrolled.id,
          target.principalId,
          recoveryUserId,
          admin,
          target.version,
        );
        assert.equal(moved.changed, true);
        return actor;
      });
      const status = await maintain(["status"]);
      assert.equal(status.code, 0, status.stderr);
      const designation = recoveryDesignation(requiredOutput(status));
      assert.equal(designation.userId, enrolled.id);
      assert.equal(designation.email, enrolled.email);

      // The configured id only seeds first activation; the moved designation is kept.
      const seeded = await maintain([
        "activate",
        "--recovery-user",
        recoveryUserId,
        "--writers-stopped",
      ]);
      assert.equal(seeded.code, 0, seeded.stderr);
      const seedResult = requiredOutput(seeded);
      assert.equal(seedResult.seedIgnored, true);
      assert.equal(recoveryDesignation(seedResult).userId, enrolled.id);
      assert.match(seeded.stderr, /differs from the recorded recovery designation/);

      await withApplicationPool(async (pool) => {
        const state = new PostgresPlatformState(pool);
        const persistence = new PostgresHumanAuthentication(
          state,
          installationId,
          betterAuthIssuer(installationId),
        );
        const admin = createAdministrator(state, installationId, actor);
        const target = await persistence.readAccount(recoveryUserId, admin);
        await persistence.replaceRecovery(
          recoveryUserId,
          admin.principalId,
          enrolled.id,
          admin,
          target.version,
        );
      });
      assert.equal(
        recoveryDesignation(requiredOutput(await maintain(["status"]))).userId,
        recoveryUserId,
      );
    },
  );

  const replacement = "replacement-recovery-password";
  await context.test(
    "reset-recovery-password replaces the hash and ends recovery sessions",
    async () => {
      const adminToken = await withApplicationPool(async (pool) => {
        const state = new PostgresPlatformState(pool);
        const persistence = new PostgresHumanAuthentication(
          state,
          installationId,
          betterAuthIssuer(installationId),
        );
        const snapshot = await persistence.snapshotPassword(recoveryEmail);
        assert.ok(snapshot, "Expected the recovery user's password snapshot");
        const session = await persistence.issueSession(
          snapshot.proof,
          sessionRecord(recoveryUserId),
        );
        const admin = createAdministrator(state, installationId, {
          userId: recoveryUserId,
          sessionId: session.id,
          principalId: snapshot.proof.principalId,
        });
        // Use the guarded persistence operation so deactivation must account for a disabled user.
        const target = await persistence.readAccount(disabledUser.id, admin);
        await persistence.changeAccount(disabledUser.id, "disable", admin, target.version);
        return session.token;
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
      assert.deepEqual(requiredOutput(reset), {
        event: "auth-maintain.reset-recovery-password",
        userId: recoveryUserId,
      });
      await withApplicationPool(async (pool) => {
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
    const enrolled = orphan;
    assert.ok(enrolled, "The enrolment case must create the repaired account");
    const unknown = await maintain([
      "purge-sessions",
      "--user",
      "missing-user",
      "--writers-stopped",
    ]);
    assert.equal(unknown.code, 3);
    assert.equal(requiredOutput(unknown).reason, "USER_NOT_FOUND");
    const one = await maintain(["purge-sessions", "--user", enrolled.id, "--writers-stopped"]);
    assert.equal(one.code, 0, one.stderr);
    assert.equal(requiredOutput(one).deletedSessionCount, 1);
    const all = await maintain(["purge-sessions", "--writers-stopped"]);
    assert.equal(all.code, 0, all.stderr);
    assert.equal(requiredOutput(all).deletedSessionCount, 0);
  });

  await context.test("deactivation never re-admits a disabled account", async () => {
    const refused = await maintain(["deactivate", "--writers-stopped"]);
    assert.equal(refused.code, 3);
    const refusal = requiredOutput(refused);
    assert.equal(refusal.reason, "DISABLED_ACCOUNTS");
    assert.deepEqual(refusal.disabledUserIds, [disabledUser.id]);
    assert.equal(requiredOutput(await maintain(["status"])).profile, "guarded");

    const deactivated = await maintain(["deactivate", "--purge-disabled", "--writers-stopped"]);
    assert.equal(deactivated.code, 0, deactivated.stderr);
    assert.deepEqual(requiredOutput(deactivated).passwordRemovedUserIds, [disabledUser.id]);
    const status = requiredOutput(await maintain(["status"]));
    assert.equal(status.profile, "legacy");
    assert.equal(status.enrolled, 0);
    assert.equal(status.sessions, 0);
  });

  await context.test("the legacy profile starts and signs in with the reset password", async () => {
    const enrolled = orphan;
    assert.ok(enrolled, "The enrolment case must create the repaired account");
    await withApplicationPool(async (pool) => {
      const state = new PostgresPlatformState(pool);
      // Ordinary startup without OIDC configuration succeeds again.
      const auth = await createPostgresControllerAuth({
        ...authOptions,
        installationId,
        pool,
        state,
      });
      const signedIn = await auth.auth.api.signInEmail({
        body: { email: recoveryEmail, password: replacement },
      });
      assert.equal(signedIn.user.id, recoveryUserId);
      const orphanSignIn = await auth.auth.api.signInEmail({
        body: { email: enrolled.email, password },
      });
      assert.equal(orphanSignIn.user.id, enrolled.id);
      // The disabled account lost its password instead of regaining access.
      await assert.rejects(
        auth.auth.api.signInEmail({ body: { email: disabledUser.email, password } }),
        { status: "UNAUTHORIZED", message: "Invalid email or password" },
      );
      // Unbound legacy sessions commit: nothing in the database still fences them.
      const { rowCount } = await pool.query(
        `INSERT INTO occ.session (id, token, user_id, created_at, updated_at, expires_at)
         VALUES ($1, $2, $3, now(), now(), now() + interval '1 hour')`,
        [randomUUID(), randomBytes(32).toString("hex"), enrolled.id],
      );
      assert.equal(rowCount, 1);

      const audit = await pool.query<{ action: unknown; actor_id: unknown }>(
        `SELECT action, actor_id FROM occ.audit_events WHERE action IN
         ('authentication.recovery.activate', 'authentication.account.enrol',
          'authentication.recovery.password-reset', 'authentication.sessions.purge',
          'authentication.recovery.deactivate') ORDER BY occurred_at, action`,
      );
      const events = audit.rows.map(({ action, actor_id }) => {
        assert.ok(typeof action === "string", "Expected an audit action");
        assert.ok(typeof actor_id === "string", "Expected an audit actor ID");
        return { action, actorId: actor_id };
      });
      const maintenance = events.filter(({ actorId }) => actorId.startsWith("maintenance:"));
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
      const others = events.filter(({ actorId }) => !actorId.startsWith("maintenance:"));
      assert.deepEqual(
        others.map((row) => row.action),
        ["authentication.recovery.activate"],
      );
    });
  });
}
