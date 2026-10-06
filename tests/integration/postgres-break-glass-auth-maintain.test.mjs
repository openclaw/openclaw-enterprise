import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { privateBootstrapDirectory } from "../helpers/bootstrap-installation.mjs";
import {
  assertProviderAttached,
  clientAddresses,
  composeProductionSignIn,
  consoleOrigin as origin,
  currentSession,
  defaultInstallSettings,
  githubSignIn,
  githubUpgradeSettings,
  onboardPasswordAccounts,
  passwordSignIn,
  signedInHeaders,
  startFakeGitHub,
} from "../helpers/production-sign-in.mjs";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const migrationUrl = process.env.OCC_AUTH_MAINTAIN_MIGRATION_DATABASE_URL;
const adminEmail = "break-glass-recovery@example.test";
const password = "break-glass-member-password";
const replacement = "break-glass-replacement-password";
const authSecret = "break-glass-auth-test-secret-at-least-32-bytes";
const secrets = {
  "occ-auth/secret": authSecret,
  "occ-github-login/client-id": "break-glass-client-id",
  "occ-github-login/client-secret": "break-glass-client-secret",
};
const memberSubject = "9300001";

// The documented one-off maintenance command, run as the migration role.
function maintain(args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["scripts/auth-maintain.mjs", ...args],
      {
        cwd: repository,
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "production",
          OCC_MIGRATION_DATABASE_URL: migrationUrl,
        },
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

// Every mutating command refuses while any other client is connected, so the suite
// opens a pool only for each short read and closes it before the next command.
async function withPool(work) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    return await work(pool, new PostgresPlatformState(pool));
  } finally {
    await pool.end();
  }
}

// A running controller that has run no query for 10 s holds no database connection:
// its pool closes idle clients (pg's default idleTimeoutMillis), and the maintenance
// guard, which lists connected clients, then cannot see it. /readyz runs SELECT 1 on
// the controller's own pool, so probing it keeps the controller connected however
// long each maintenance command takes. Returns a stop function.
async function keepControllerConnected(app) {
  const probe = async () => {
    const ready = await app.inject({ url: "/readyz" });
    assert.equal(ready.statusCode, 200, ready.body);
  };
  await probe();
  let failure;
  let running;
  const timer = setInterval(() => {
    running ??= probe()
      .catch((error) => {
        failure ??= error;
      })
      .finally(() => {
        running = undefined;
      });
  }, 500);
  return async () => {
    clearInterval(timer);
    await running;
    if (failure !== undefined) {
      throw failure;
    }
  };
}

// Break-glass when the recovery password is lost: with the API stopped, auth:maintain
// resets it (GitHub may be down), and deactivation returns the Installation to the
// password-only default, which then starts without any GitHub configuration.
test(
  "stopped-maintenance break-glass resets the recovery password and returns to the password profile",
  {
    skip:
      databaseUrl && migrationUrl
        ? false
        : "Set OCC_TEST_DATABASE_URL and OCC_AUTH_MAINTAIN_MIGRATION_DATABASE_URL for the same fresh database.",
  },
  async (t) => {
    let app;
    t.after(async () => {
      await app?.close();
    });
    const github = await startFakeGitHub(t);
    const address = clientAddresses();
    const directory = await privateBootstrapDirectory(t, "openclaw-break-glass-");
    const {
      admin,
      accounts: { member },
    } = await withPool((pool, state) =>
      onboardPasswordAccounts(t, {
        databaseUrl,
        state,
        pool,
        email: adminEmail,
        authSecret,
        secrets,
        password,
        remoteAddress: address(),
        accounts: { member: { email: "break-glass-member@example.test" } },
      }),
    );
    app = await composeProductionSignIn(t, {
      databaseUrl,
      settings: githubUpgradeSettings(admin.id),
      secrets,
    });
    const adminHeaders = await signedInHeaders(app, origin, admin, address());
    await assertProviderAttached(app, adminHeaders, member.id, "github", memberSubject);
    assert.equal(
      (await githubSignIn(app, origin, memberSubject, address())).callback.headers.location,
      "/console/",
    );
    const passwordFile = join(directory, "recovery-password");
    await writeFile(passwordFile, `${replacement}\n`, { mode: 0o600 });

    await t.test("maintenance refuses while the controller is connected", async () => {
      const status = await maintain(["status"]);
      assert.equal(status.code, 0, status.stderr);
      assert.equal(status.output.profile, "guarded");
      assert.equal(status.output.designation.userId, admin.id);
      const stopProbing = await keepControllerConnected(app);
      try {
        for (const args of [
          ["reset-recovery-password", "--password-file", passwordFile, "--writers-stopped"],
          ["deactivate", "--writers-stopped"],
        ]) {
          const refused = await maintain(args);
          assert.equal(refused.code, 2, `${args[0]}: ${refused.stderr}`);
          assert.equal(refused.output.event, "auth-maintain.writers-running");
          assert.ok(refused.output.backends.some(({ user }) => user === "occ_app"));
        }
      } finally {
        await stopProbing();
      }
      assert.equal(
        (await currentSession(app, adminHeaders.cookie)).user.id,
        admin.id,
        "a refused command changes nothing",
      );
      assert.equal((await passwordSignIn(app, origin, admin, address())).statusCode, 200);
    });

    await t.test(
      "with the controller stopped, a reset password signs the recovery administrator in while GitHub is down",
      async () => {
        await app.close();
        app = undefined;
        const reset = await maintain([
          "reset-recovery-password",
          "--password-file",
          passwordFile,
          "--writers-stopped",
        ]);
        assert.equal(reset.code, 0, reset.stderr);
        assert.deepEqual(reset.output, {
          event: "auth-maintain.reset-recovery-password",
          userId: admin.id,
        });
        github.mode = "error";
        app = await composeProductionSignIn(t, {
          databaseUrl,
          settings: githubUpgradeSettings(admin.id),
          secrets,
        });
        assert.equal(await currentSession(app, adminHeaders.cookie), null, "old sessions ended");
        assert.equal((await passwordSignIn(app, origin, admin, address())).statusCode, 401);
        const signedIn = await signedInHeaders(
          app,
          origin,
          { email: adminEmail, password: replacement },
          address(),
        );
        assert.equal((await currentSession(app, signedIn.cookie)).user.id, admin.id);
        const { callback } = await githubSignIn(app, origin, memberSubject, address());
        assert.equal(callback.headers.location, "/console/?authError=github");
        assert.equal((await passwordSignIn(app, origin, member, address())).statusCode, 200);
        await app.close();
        app = undefined;
      },
    );

    await t.test(
      "deactivation returns to the password profile, which starts without GitHub configuration",
      async () => {
        await assert.rejects(
          composeProductionSignIn(t, { databaseUrl, settings: defaultInstallSettings, secrets }),
          /requires a configured external sign-in provider/,
          "an activated Installation refuses to start without GitHub",
        );
        const deactivated = await maintain(["deactivate", "--writers-stopped"]);
        assert.equal(deactivated.code, 0, deactivated.stderr);
        const status = await maintain(["status"]);
        assert.equal(status.output.profile, "legacy");
        assert.equal(status.output.sessions, 0);

        app = await composeProductionSignIn(t, {
          databaseUrl,
          settings: defaultInstallSettings,
          secrets,
        });
        assert.deepEqual((await app.inject({ url: "/api/auth/providers" })).json().data, {
          github: false,
          google: false,
          oidc: false,
          password: true,
          sessionBinding: false,
        });
        const signedIn = await signedInHeaders(
          app,
          origin,
          { email: adminEmail, password: replacement },
          address(),
        );
        assert.equal((await currentSession(app, signedIn.cookie)).user.id, admin.id);
        assert.equal((await passwordSignIn(app, origin, member, address())).statusCode, 200);
        const start = await app.inject({
          method: "POST",
          url: "/api/auth/providers/github/start",
          remoteAddress: address(),
          headers: { origin },
        });
        assert.equal(start.statusCode, 403, start.body);
        await app.close();
        app = undefined;
      },
    );

    await t.test("maintenance changes are audited to the migration role", async () => {
      await withPool(async (pool) => {
        const audit = await pool.query(
          `SELECT action FROM occ.audit_events WHERE actor_id LIKE 'maintenance:%'
           ORDER BY occurred_at, action`,
        );
        assert.deepEqual(
          audit.rows.map(({ action }) => action),
          ["authentication.recovery.password-reset", "authentication.recovery.deactivate"],
        );
        const identities = await pool.query(
          "SELECT user_id, account_id FROM occ.account WHERE identity_only",
        );
        assert.deepEqual(
          identities.rows,
          [{ user_id: member.id, account_id: memberSubject }],
          "deactivation leaves attached GitHub identities in place",
        );
      });
    });
  },
);
