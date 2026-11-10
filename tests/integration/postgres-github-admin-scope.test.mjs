import assert from "node:assert/strict";
import test from "node:test";
import { waitForLockWaiter } from "../helpers/postgres-lock-waits.mjs";
import { assertApiError } from "../helpers/api-error.mjs";
import {
  assertConsoleSignIn,
  changeAccount,
  clientAddresses,
  consoleOrigin as origin,
  currentSession,
  githubSignIn,
  githubUpgradeSettings,
  readAccount,
  signedInHeaders,
} from "../helpers/production-sign-in.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { preparePostgresSignInInstallation } from "../helpers/postgres-sign-in-installation.mjs";

const limitedSubject = "9200001";
const takeoverSubject = "9200002";

// Account management acts for the target's Principal: an administrator bound only to the exact
// Installation (as every created administrator is) must not manage an account that holds broader
// grants, such as the unscoped bootstrap administrator, or it could sign in as that account.
test(
  "an exact-scope Installation administrator cannot manage an account with broader grants",
  requiresPostgres,
  async (t) => {
    let app;
    const { pool, state, onboard, composeApp } = await preparePostgresSignInInstallation(
      t,
      () => [app],
      {
        email: "scope-recovery@example.test",
        password: "scope-limited-password",
        secrets: {
          "occ-auth/secret": "scope-admin-auth-test-secret-at-least-32-bytes",
          "occ-github-login/client-id": "scope-client-id",
          "occ-github-login/client-secret": "scope-client-secret",
        },
      },
    );
    const address = clientAddresses("198.19");
    const {
      admin,
      accounts: { limited, member },
    } = await onboard({
      remoteAddress: address(),
      accounts: {
        limited: { email: "scope-limited@example.test", role: "admin" },
        member: { email: "scope-member@example.test" },
      },
    });

    // Account creation binds the Role to the exact Installation only.
    const installation = await state.loadInstallation();
    const { rows: bindings } = await pool.query(
      `SELECT resource_kind, resource_id FROM occ.iam_access_bindings
       WHERE identity_subject_id = (SELECT principal_id FROM occ.human_authentication_accounts
                                     WHERE user_id = $1)`,
      [limited.id],
    );
    assert.deepEqual(bindings, [{ resource_kind: "installation", resource_id: installation.id }]);

    app = await composeApp(githubUpgradeSettings(admin.id));
    const adminHeaders = await signedInHeaders(app, origin, admin, address());
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
    assertApiError(attached, 403, "FORBIDDEN");
    const { callback } = await githubSignIn(app, origin, takeoverSubject, address());
    assert.equal(callback.headers.location, "/console/?authError=github", "no takeover sign-in");
    assert.equal(callback.headers["set-cookie"], undefined);

    const revoked = await changeAccount(app, limitedHeaders, admin.id, "revoke", target.version);
    assert.equal(revoked.statusCode, 403, revoked.body);
    assert.notEqual(await currentSession(app, adminHeaders.cookie), null, "admin stays signed in");

    // Each refusal is audited against the account it targeted, with the coverage reason, so an
    // investigator can tell a blocked takeover of this account from any other denial.
    const coverageDenials = async (actions) =>
      (await state.transact((unit) => unit.audit.list())).filter(
        (event) => event.kind === "authorization_denial" && actions.includes(event.action),
      );
    const assertCoverageDenials = (events, count) => {
      assert.equal(events.length, count);
      for (const denied of events) {
        assert.equal(denied.outcome, "denied");
        assert.equal(denied.resource.kind, "installation");
        assert.equal(denied.reasonCode, "ACCOUNT_PRINCIPAL_GRANTS_NOT_COVERED");
        assert.match(denied.decisionReason, /every grant of the target account's Principal/);
        assert.equal(denied.details.userId, admin.id);
        assert.equal(denied.details.principalId, target.principalId);
      }
    };
    assertCoverageDenials(
      await coverageDenials(["openclaw.auth.accounts.github", "openclaw.auth.accounts.revoke"]),
      2,
    );

    const limitedAccount = await readAccount(app, limitedHeaders, limited.id);
    assert.deepEqual(await readAccount(app, adminHeaders, admin.id), target);

    // The unscoped administrator's grants cover the narrower account.
    const covered = await post(adminHeaders, `/api/auth/accounts/${limited.id}/providers/github`, {
      subject: limitedSubject,
      expectedVersion: limitedAccount.version,
    });
    assert.equal(covered.statusCode, 200, covered.body);
    const signedIn = await githubSignIn(app, origin, limitedSubject, address());
    await assertConsoleSignIn(app, signedIn.callback, limited.id);

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
    assertApiError(taken, 403, "FORBIDDEN");
    assert.equal(await recoveryHolder(), admin.id);
    // A refused move is audited against the current holder, whose grants were not covered.
    assertCoverageDenials(await coverageDenials(["openclaw.auth.recovery.replace"]), 1);
    // The version read before the GitHub attach is stale, so the API refuses the change.
    const stale = await changeAccount(
      app,
      adminHeaders,
      limited.id,
      "disable",
      limitedAccount.version,
    );
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(
      stale.json().error.message,
      "The authentication account version changed. Read its current state before a new action.",
    );
    const disabled = await changeAccount(app, adminHeaders, limited.id, "disable");
    assert.equal(disabled.statusCode, 200, disabled.body);
    const enabled = await changeAccount(app, adminHeaders, limited.id, "enable");
    assert.equal(enabled.statusCode, 200, enabled.body);

    // Among accounts it covers, the narrower administrator still moves the designation.
    const given = await moveRecovery(adminHeaders, limited.id, admin.id);
    assert.equal(given.statusCode, 200, given.body);
    limitedAgain = await signedInHeaders(app, origin, limited, address());
    const returned = await moveRecovery(limitedAgain, admin.id, limited.id);
    assert.equal(returned.statusCode, 200, returned.body);
    assert.equal(await recoveryHolder(), admin.id);
    await t.test(
      "account mutation rechecks target grants after waiting for its account lock",
      (child) =>
        assertAccountMutationFence(child, {
          app,
          pool,
          state,
          adminHeaders,
          operatorHeaders: limitedAgain,
          member,
        }),
    );
    await t.test("a recovery successor losing eligibility returns a conflict", async () => {
      const target = await readAccount(app, adminHeaders, limited.id);
      const before = await recoveryHolder();
      const auditsBefore = await state.transact((unit) => unit.audit.list());
      const locker = await pool.connect();
      let pending;
      try {
        await locker.query("BEGIN");
        const held = (
          await locker.query(
            'SELECT pg_backend_pid() AS pid FROM occ."user" WHERE id=$1 FOR UPDATE',
            [limited.id],
          )
        ).rows[0];
        pending = fetch(`http://127.0.0.1:${app.server.address().port}/api/auth/recovery`, {
          method: "POST",
          headers: { ...adminHeaders, "content-type": "application/json" },
          body: JSON.stringify({
            userId: limited.id,
            expectedCurrentUserId: before,
            expectedVersion: target.version,
          }),
        });
        await waitForLockWaiter(pool, held.pid, "recovery replacement reached the successor lock", {
          timeoutMs: 3000,
        });
        // A database policy writer removes only the successor's grant after the
        // real HTTP preflight. The initiating administrator remains authorized.
        const removed = await pool.query(
          "DELETE FROM occ.iam_access_bindings WHERE identity_subject_id=$1 RETURNING id",
          [target.principalId],
        );
        assert.equal(removed.rowCount, 1);
      } finally {
        await locker.query("ROLLBACK");
        locker.release();
      }
      const response = await pending;
      assert.equal(response.status, 409, await response.text());
      assert.equal(await recoveryHolder(), before);
      // Ineligible successor is a resource conflict, not a false denial of
      // the initiating administrator's authority or a successful replacement.
      assert.deepEqual(await state.transact((unit) => unit.audit.list()), auditsBefore);
    });
  },
);

async function assertAccountMutationFence(
  t,
  { app, pool, state, adminHeaders, operatorHeaders, member },
) {
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const before = await readAccount(app, adminHeaders, member.id);
  const namespace = (await pool.query("SELECT id FROM occ.namespaces WHERE name='default'")).rows[0]
    .id;
  // The sign-in fixture uses passive Compute; finish the real Namespace prerequisite.
  await state.transact((unit) =>
    unit.namespaces.transitionNamespaceStatus(namespace, "provisioning", "ready"),
  );
  async function request(headers, path, body) {
    const response = await fetch(address + path, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  const role = await request(adminHeaders, `/namespaces/${namespace}/iam/roles`, {
    name: "Namespace reader",
    permissions: [{ action: "read", resourceKind: "namespace" }],
  });
  assert.equal(role.status, 201, JSON.stringify(role.body));
  // Block only the target account. PostgreSQL's lock graph establishes that
  // the real HTTP mutation passed its initial administrator and coverage checks.
  const locker = await pool.connect();
  let released = false;
  const release = async () => {
    if (!released) {
      await locker.query("ROLLBACK");
      locker.release();
      released = true;
    }
  };
  t.after(release);
  await locker.query("BEGIN");
  const held = (
    await locker.query('SELECT pg_backend_pid() AS pid FROM occ."user" WHERE id=$1 FOR UPDATE', [
      member.id,
    ])
  ).rows[0];
  let pending;
  try {
    pending = request(operatorHeaders, `/api/auth/accounts/${member.id}/disable`, {
      expectedVersion: before.version,
    });
    await waitForLockWaiter(pool, held.pid, "account mutation reached target row", {
      timeoutMs: 3000,
    });
    // Grant new authority through the supported IAM API while the target row is held.
    // The exact-Installation administrator cannot cover this Namespace grant.
    const grant = await request(adminHeaders, `/namespaces/${namespace}/iam/access-bindings`, {
      subjectKind: "identity",
      subjectId: before.principalId,
      roleId: role.body.data.id,
      resourceKind: "namespace",
      resourceId: namespace,
    });
    assert.equal(grant.status, 201, JSON.stringify(grant.body));
  } finally {
    await release();
  }
  const result = await pending;
  const after = await readAccount(app, adminHeaders, member.id);
  t.diagnostic(
    JSON.stringify({
      result,
      before: { version: before.version, disabled: before.disabled },
      after: { version: after.version, disabled: after.disabled },
    }),
  );
  assert.equal(
    result.status,
    403,
    "a waiting mutation cannot act with stale target-grant coverage",
  );
  assert.deepEqual(after, before, "refusal preserves account version, methods and enabled state");
  const events = await state.transact((unit) => unit.audit.list());
  const denied = events.filter(
    (event) => event.kind === "authorization_denial" && event.details?.userId === member.id,
  );
  assert.equal(denied.length, 1, "the rolled-back request has exactly one attributable denial");
  assert.equal(denied[0].reasonCode, "ACCOUNT_PRINCIPAL_GRANTS_NOT_COVERED");
  assert.ok(
    !events.some(
      (event) =>
        event.action === "authentication.account.disable" && event.details?.userId === member.id,
    ),
  );
  // The recovery administrator still covers the new grant and can perform the same operation.
  const allowed = await request(adminHeaders, `/api/auth/accounts/${member.id}/disable`, {
    expectedVersion: before.version,
  });
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  assert.equal((await readAccount(app, adminHeaders, member.id)).disabled, true);
}
