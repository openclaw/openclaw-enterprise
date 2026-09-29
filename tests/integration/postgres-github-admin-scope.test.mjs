import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import {
  bootstrapProductionInstallation,
  clientAddresses,
  composeProductionSignIn,
  consoleOrigin as origin,
  currentSession,
  defaultInstallSettings,
  githubSignIn,
  githubUpgradeSettings,
  installationRoles,
  readAccount,
  signedInHeaders,
  startFakeGitHub,
} from "../helpers/production-sign-in.mjs";
import { cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const adminEmail = "scope-recovery@example.test";
const password = "scope-limited-password";
const authSecret = "scope-admin-auth-test-secret-at-least-32-bytes";
const secrets = {
  "occ-auth/secret": authSecret,
  "occ-github-login/client-id": "scope-client-id",
  "occ-github-login/client-secret": "scope-client-secret",
};
const limitedSubject = "9200001";
const takeoverSubject = "9200002";

// Account management acts for the target's Principal: an administrator bound only to the exact
// Installation (as every created administrator is) must not manage an account that holds broader
// grants, such as the unscoped bootstrap administrator, or it could sign in as that account.
test(
  "an exact-scope Installation administrator cannot manage an account with broader grants",
  { skip: databaseUrl ? false : "Set OCC_TEST_DATABASE_URL for real PostgreSQL proof." },
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const state = new PostgresPlatformState(pool);
    let app;
    t.after(async () => {
      await app?.close();
      await pool.end();
    });
    await startFakeGitHub(t);
    const address = clientAddresses("198.19");
    const adminPassword = await bootstrapProductionInstallation(t, {
      databaseUrl,
      email: adminEmail,
      authSecret,
    });
    const admin = { email: adminEmail, password: adminPassword };
    const roles = await installationRoles(state, pool);

    app = await composeProductionSignIn(t, {
      databaseUrl,
      settings: defaultInstallSettings,
      secrets,
    });
    let adminHeaders = await signedInHeaders(app, origin, admin, address());
    admin.id = (await currentSession(app, adminHeaders.cookie)).user.id;
    const created = await app.inject({
      method: "POST",
      url: "/api/auth/accounts",
      headers: adminHeaders,
      payload: { email: "scope-limited@example.test", password, roleId: roles.admin.id },
    });
    assert.equal(created.statusCode, 201, created.body);
    const limited = { id: created.json().data.id, email: "scope-limited@example.test", password };
    await app.close();

    // Account creation binds the Role to the exact Installation only.
    const installation = await state.loadInstallation();
    const { rows: bindings } = await pool.query(
      `SELECT resource_kind, resource_id FROM occ.iam_access_bindings
       WHERE identity_subject_id = (SELECT principal_id FROM occ.human_authentication_accounts
                                     WHERE user_id = $1)`,
      [limited.id],
    );
    assert.deepEqual(bindings, [{ resource_kind: "installation", resource_id: installation.id }]);

    app = await composeProductionSignIn(t, {
      databaseUrl,
      settings: githubUpgradeSettings(admin.id),
      secrets,
    });
    adminHeaders = await signedInHeaders(app, origin, admin, address());
    const limitedHeaders = await signedInHeaders(app, origin, limited, address());
    const post = (headers, url, payload) => app.inject({ method: "POST", url, headers, payload });

    // The exact-scope binding still administers the Installation.
    const recovery = await app.inject({ url: "/api/auth/recovery", headers: limitedHeaders });
    assert.equal(recovery.statusCode, 200, recovery.body);
    assert.equal(recovery.json().data.userId, admin.id);
    const target = await readAccount(app, limitedHeaders, admin.id);

    const attached = await post(limitedHeaders, `/api/auth/accounts/${admin.id}/providers/github`, {
      subject: takeoverSubject,
      expectedVersion: target.version,
    });
    assert.equal(attached.statusCode, 403, attached.body);
    assert.equal(attached.json().error.code, "FORBIDDEN");
    const { callback } = await githubSignIn(app, origin, takeoverSubject, address());
    assert.equal(callback.headers.location, "/console/?authError=github", "no takeover sign-in");
    assert.equal(callback.headers["set-cookie"], undefined);

    const revoked = await post(limitedHeaders, `/api/auth/accounts/${admin.id}/revoke`, {
      expectedVersion: target.version,
    });
    assert.equal(revoked.statusCode, 403, revoked.body);
    assert.notEqual(await currentSession(app, adminHeaders.cookie), null, "admin stays signed in");

    const limitedAccount = await readAccount(app, limitedHeaders, limited.id);
    assert.deepEqual(await readAccount(app, adminHeaders, admin.id), target);

    // The unscoped administrator's grants cover the narrower account.
    const covered = await post(adminHeaders, `/api/auth/accounts/${limited.id}/providers/github`, {
      subject: limitedSubject,
      expectedVersion: limitedAccount.version,
    });
    assert.equal(covered.statusCode, 200, covered.body);
    const signedIn = await githubSignIn(app, origin, limitedSubject, address());
    assert.equal(signedIn.callback.headers.location, "/console/", signedIn.callback.body);
    const cookie = cookieHeaderFromSetCookie(signedIn.callback.headers["set-cookie"]);
    assert.equal((await currentSession(app, cookie)).user.id, limited.id);

    // Taking the recovery designation acts against its holder: disabling a holder returns 409,
    // so a narrower administrator must not move it onto itself and lock the broader one out.
    const recoveryHolder = async () =>
      (await app.inject({ url: "/api/auth/recovery", headers: adminHeaders })).json().data.userId;
    const moveRecovery = async (headers, userId, expectedCurrentUserId) =>
      post(headers, "/api/auth/recovery", {
        userId,
        expectedCurrentUserId,
        expectedVersion: (await readAccount(app, adminHeaders, userId)).version,
      });
    // Attaching GitHub revoked the earlier password session.
    let limitedAgain = await signedInHeaders(app, origin, limited, address());
    const taken = await moveRecovery(limitedAgain, limited.id, admin.id);
    assert.equal(taken.statusCode, 403, taken.body);
    assert.equal(taken.json().error.code, "FORBIDDEN");
    assert.equal(await recoveryHolder(), admin.id);
    const disabled = await post(adminHeaders, `/api/auth/accounts/${limited.id}/disable`, {
      expectedVersion: (await readAccount(app, adminHeaders, limited.id)).version,
    });
    assert.equal(disabled.statusCode, 200, disabled.body);
    const enabled = await post(adminHeaders, `/api/auth/accounts/${limited.id}/enable`, {
      expectedVersion: (await readAccount(app, adminHeaders, limited.id)).version,
    });
    assert.equal(enabled.statusCode, 200, enabled.body);

    // Among accounts it covers, the narrower administrator still moves the designation.
    const given = await moveRecovery(adminHeaders, limited.id, admin.id);
    assert.equal(given.statusCode, 200, given.body);
    limitedAgain = await signedInHeaders(app, origin, limited, address());
    const returned = await moveRecovery(limitedAgain, admin.id, limited.id);
    assert.equal(returned.statusCode, 200, returned.body);
    assert.equal(await recoveryHolder(), admin.id);
  },
);
