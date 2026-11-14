import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { privateBootstrapDirectory } from "../helpers/bootstrap-installation.mjs";
import { withPool } from "../helpers/postgres-database.mjs";
import {
  assertProviderAttached,
  clientAddresses,
  composeProductionSignIn,
  consoleOrigin as origin,
  currentSession,
  defaultInstallSettings,
  fakeOidc,
  oidcUpgradeSettings,
  onboardPasswordAccounts,
} from "../helpers/production-sign-in.mjs";
import {
  authOperation,
  onboarded,
  oidcSignIn,
  parseAuthResponse,
  passwordSignIn,
  record,
  recordData,
  signedInHeaders,
  text,
  type SignInApp,
} from "../helpers/postgres-sign-in-test-boundaries.ts";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const migrationUrl = process.env.OCC_AUTH_MAINTAIN_MIGRATION_DATABASE_URL;
const adminEmail = "break-glass-recovery@example.test";
const password = "break-glass-member-password";
const replacement = "break-glass-replacement-password";
const authSecret = "break-glass-auth-test-secret-at-least-32-bytes";
const secrets = {
  "occ-auth/secret": authSecret,
  "occ-oidc-login/client-id": "break-glass-client-id",
  "occ-oidc-login/client-secret": "break-glass-client-secret",
};
const memberSubject = "9300001";

// The documented one-off maintenance command, run as the migration role.
async function runMaintenance(migrationUrl: string, args: readonly string[]) {
  const { code, stdout } = await new Promise<{ code: number; stdout: string }>(
    (resolve, reject) => {
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
          encoding: "utf8",
          timeout: 30_000,
        },
        (error, stdout) => {
          const code = error ? error.code : 0;
          if (typeof code !== "number" || error?.killed || error?.signal) {
            reject(
              new Error(`Maintenance process failed for ${args[0]} (${error?.signal ?? code})`),
            );
            return;
          }
          resolve({ code, stdout });
        },
      );
    },
  );
  const line = stdout.split("\n").find((entry) => entry.startsWith("{"));
  let output: unknown;
  if (line !== undefined) {
    try {
      output = JSON.parse(line);
    } catch {
      throw new Error(`Maintenance command ${args[0]} returned invalid JSON`);
    }
  }
  return { code, output };
}

// Idle clients expire after 10 s. /readyz runs SELECT 1 on the controller's own pool,
// so these probes keep its connection visible to the stopped-writer guard.
async function whileControllerConnected(app: SignInApp, work: () => Promise<void>) {
  const probe = async () => {
    const ready = await app.inject({ url: "/readyz" });
    assert.equal(ready.statusCode, 200, ready.body);
  };
  await probe();
  let failure: unknown;
  let running: Promise<void> | undefined;
  const timer = setInterval(() => {
    running ??= probe()
      .catch((error: unknown) => {
        failure ??= error;
      })
      .finally(() => {
        running = undefined;
      });
  }, 500);
  try {
    await work();
  } finally {
    clearInterval(timer);
    await running;
  }
  if (failure !== undefined) {
    throw failure;
  }
}

async function sessionUserId(app: SignInApp, cookie: string): Promise<string | null> {
  const session = await authOperation<unknown>("Session lookup", () => currentSession(app, cookie));
  return session === null ? null : text(record(record(session).user).id);
}

// Break-glass when the recovery password is lost: with the API stopped, auth:maintain
// resets it (OIDC may be down), and deactivation returns the Installation to the
// password-only default, which then starts without any OIDC configuration.
test(
  "stopped-maintenance break-glass resets the recovery password and returns to the password profile",
  {
    skip:
      databaseUrl && migrationUrl
        ? false
        : "Set OCC_TEST_DATABASE_URL and OCC_AUTH_MAINTAIN_MIGRATION_DATABASE_URL for the same fresh database.",
  },
  async (t) => {
    assert.ok(databaseUrl && migrationUrl);
    const maintain = (args: readonly string[]) => runMaintenance(migrationUrl, args);
    let app: SignInApp | undefined;
    async function stopController() {
      await app?.close();
      app = undefined;
    }
    t.after(stopController);
    const oidc = fakeOidc(t, {
      clientId: secrets["occ-oidc-login/client-id"],
      clientSecret: secrets["occ-oidc-login/client-secret"],
    });
    const address = clientAddresses();
    const controllerOptions = { databaseUrl, secrets, passwordHasher: undefined };
    const directory = await privateBootstrapDirectory(t, "openclaw-break-glass-");
    // Every mutating command refuses while any other client is connected, so the suite
    // opens a pool only for each short read and closes it before the next command.
    const setup: unknown = await withPool(
      databaseUrl,
      (pool: Pool) =>
        onboardPasswordAccounts(t, {
          ...controllerOptions,
          state: new PostgresPlatformState(pool),
          pool,
          email: adminEmail,
          authSecret,
          password,
          passwordSlowLaneFloors: undefined,
          remoteAddress: address(),
          accounts: { member: { email: "break-glass-member@example.test" } },
        }),
      { max: 2 },
    );
    const {
      admin,
      accounts: { member },
    } = onboarded(setup, ["member"]);
    const guardedSettings = oidcUpgradeSettings(admin.id);
    const guardedApp = (app = await composeProductionSignIn(t, {
      ...controllerOptions,
      settings: guardedSettings,
    }));
    const adminHeaders = await signedInHeaders(guardedApp, origin, admin, address());
    await assertProviderAttached(guardedApp, adminHeaders, member.id, "oidc", memberSubject);
    const signInMemberWithOidc = (controller: SignInApp) =>
      oidcSignIn(controller, origin, oidc, { subject: memberSubject }, address());
    const { callback } = await signInMemberWithOidc(guardedApp);
    assert.ok(callback.headers.location === "/console/", "OIDC sign-in redirects to the Console");
    const passwordFile = join(directory, "recovery-password");
    await writeFile(passwordFile, `${replacement}\n`, { mode: 0o600 });
    const resetArgs = [
      "reset-recovery-password",
      "--password-file",
      passwordFile,
      "--writers-stopped",
    ];
    const deactivateArgs = ["deactivate", "--writers-stopped"];
    const recoveryAccount = { email: adminEmail, password: replacement };

    await t.test("maintenance refuses while the controller is connected", async () => {
      const status = await maintain(["status"]);
      assert.equal(status.code, 0, "read guarded status");
      const guarded = record(status.output);
      assert.equal(guarded.profile, "guarded");
      assert.equal(record(guarded.designation).userId, admin.id);
      await whileControllerConnected(guardedApp, async () => {
        for (const args of [resetArgs, deactivateArgs]) {
          const refused = await maintain(args);
          assert.equal(refused.code, 2, `${args[0]} refuses while the controller is connected`);
          const { event, backends } = record(refused.output);
          assert.equal(event, "auth-maintain.writers-running");
          assert.ok(Array.isArray(backends));
          const backendRows: unknown[] = backends;
          const backendUsers = backendRows.map((backend) => {
            const { user } = record(backend);
            return user === null ? null : text(user);
          });
          assert.ok(backendUsers.includes("occ_app"));
        }
      });
      assert.equal(
        await sessionUserId(guardedApp, adminHeaders.cookie),
        admin.id,
        "a refused command preserves the existing session",
      );
      assert.equal((await passwordSignIn(guardedApp, origin, admin, address())).statusCode, 200);
    });

    await t.test(
      "with the controller stopped, a reset password signs the recovery administrator in while OIDC is down",
      async () => {
        await stopController();
        const reset = await maintain(resetArgs);
        assert.equal(reset.code, 0, "reset the recovery password");
        assert.deepEqual(reset.output, {
          event: "auth-maintain.reset-recovery-password",
          userId: admin.id,
        });
        oidc.mode = "error";
        const recoveredApp = (app = await composeProductionSignIn(t, {
          ...controllerOptions,
          settings: guardedSettings,
        }));
        assert.equal(
          await sessionUserId(recoveredApp, adminHeaders.cookie),
          null,
          "old sessions ended",
        );
        assert.equal(
          (await passwordSignIn(recoveredApp, origin, admin, address())).statusCode,
          401,
        );
        const signedIn = await signedInHeaders(recoveredApp, origin, recoveryAccount, address());
        assert.equal(await sessionUserId(recoveredApp, signedIn.cookie), admin.id);
        const { callback } = await signInMemberWithOidc(recoveredApp);
        assert.ok(
          callback.headers.location === "/console/?authError=oidc&authReason=provider-unavailable",
          "OIDC sign-in redirects with the provider-unavailable error",
        );
        assert.equal(
          (await passwordSignIn(recoveredApp, origin, member, address())).statusCode,
          200,
        );
        await stopController();
      },
    );

    await t.test(
      "deactivation returns to the password profile, which starts without OIDC configuration",
      async () => {
        await assert.rejects(
          composeProductionSignIn(t, { ...controllerOptions, settings: defaultInstallSettings }),
          /requires a configured external sign-in provider/,
          "an activated Installation refuses to start without OIDC",
        );
        const deactivated = await maintain(deactivateArgs);
        assert.equal(deactivated.code, 0, "deactivate the guarded profile");
        const status = await maintain(["status"]);
        const legacy = record(status.output);
        assert.equal(legacy.profile, "legacy");
        assert.equal(legacy.sessions, 0);

        const legacyApp = (app = await composeProductionSignIn(t, {
          ...controllerOptions,
          settings: defaultInstallSettings,
        }));
        const providers = await legacyApp.inject({ url: "/api/auth/providers" });
        assert.deepEqual(recordData(parseAuthResponse("Provider discovery", providers)), {
          google: false,
          oidc: false,
          password: true,
          sessionBinding: false,
        });
        const signedIn = await signedInHeaders(legacyApp, origin, recoveryAccount, address());
        assert.equal(await sessionUserId(legacyApp, signedIn.cookie), admin.id);
        assert.equal((await passwordSignIn(legacyApp, origin, member, address())).statusCode, 200);
        const start = await legacyApp.inject({
          method: "POST",
          url: "/api/auth/providers/oidc/start",
          remoteAddress: address(),
          headers: { origin },
        });
        assert.equal(start.statusCode, 403, start.body);
        await stopController();
      },
    );

    await t.test("maintenance changes are audited to the migration role", async () => {
      await withPool(databaseUrl, async (pool: Pool) => {
        const audit = await pool.query<{ action: unknown }>(
          `SELECT action FROM occ.audit_events WHERE actor_id LIKE 'maintenance:%'
           ORDER BY occurred_at, action`,
        );
        assert.deepEqual(
          audit.rows.map(({ action }) => text(action)),
          ["authentication.recovery.password-reset", "authentication.recovery.deactivate"],
        );
        const identities = await pool.query<{ user_id: unknown; account_id: unknown }>(
          "SELECT user_id, account_id FROM occ.account WHERE identity_only",
        );
        assert.deepEqual(
          identities.rows,
          [{ user_id: member.id, account_id: memberSubject }],
          "deactivation leaves attached OIDC identities in place",
        );
      });
    });
  },
);
