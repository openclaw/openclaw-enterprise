import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { privateBootstrapDirectory } from "../helpers/bootstrap-installation.mjs";
import { providerInstanceId } from "../helpers/human-login-transport.ts";
import { databaseUrl, withPool } from "../helpers/postgres-database.mjs";
import { onboardPasswordAccounts } from "../helpers/postgres-sign-in-installation.ts";
import { signedInHeaders } from "../helpers/postgres-sign-in-test-boundaries.ts";
import {
  assertConsoleSignIn,
  clientAddresses,
  composeProductionSignIn,
  consoleOrigin,
  currentSession,
  fakeOidc,
  fixtureOidcIssuer,
  oidcSignIn,
  oidcUpgradeSettings,
} from "../helpers/production-sign-in.mjs";
import {
  createAuthMaintainRunner,
  requiredOutput,
  runAuthMaintainScript,
} from "./auth-maintain-command-cases.ts";

const migrationUrl = process.env.OCC_AUTH_MAINTAIN_MIGRATION_DATABASE_URL;
const authSecret = "fixture-oidc-import-auth-secret-at-least-32-bytes";
const clientId = "fixture OIDC import client";
const clientSecret = "fixture-oidc-import-client-secret";
const oidcIssuer: string = fixtureOidcIssuer.issuer;
const oidcProviderId = providerInstanceId("oidc", { issuer: oidcIssuer, clientId });
const sourceProviderId = "previous-provider:fixture-instance";
const auditAction = "authentication.methods.link-oidc";
const secrets = {
  "occ-auth/secret": authSecret,
  "occ-oidc-login/client-id": clientId,
  "occ-oidc-login/client-secret": clientSecret,
};

function snapshot(url: string) {
  return withPool(url, async (pool) => {
    const [accounts, methods, sessions, grants, recovery, audit] = await Promise.all([
      pool.query<{ user_id: string; principal_id: string; version: number }>(
        `SELECT user_id, principal_id, version FROM occ.human_authentication_accounts
         ORDER BY user_id`,
      ),
      pool.query<{
        id: string;
        user_id: string;
        provider_id: string;
        account_id: string;
        identity_only: boolean;
        has_material: boolean;
      }>(
        `SELECT id, user_id, provider_id, account_id, identity_only,
                (password IS NOT NULL OR access_token IS NOT NULL OR refresh_token IS NOT NULL
                 OR id_token IS NOT NULL OR access_token_expires_at IS NOT NULL
                 OR refresh_token_expires_at IS NOT NULL OR scope IS NOT NULL) AS has_material
         FROM occ.account ORDER BY id`,
      ),
      pool.query<{ id: string; user_id: string }>(
        "SELECT id, user_id FROM occ.session ORDER BY id",
      ),
      pool.query("SELECT * FROM occ.iam_access_bindings ORDER BY id"),
      pool.query("SELECT * FROM occ.human_authentication_recovery ORDER BY installation_id"),
      new PostgresPlatformState(pool).transact((unit) => unit.audit.list()),
    ]);
    return {
      accounts: accounts.rows,
      methods: methods.rows,
      sessions: sessions.rows,
      grants: grants.rows,
      recovery: recovery.rows,
      audit: audit.filter(({ action }) => action === auditAction),
    };
  });
}

test(
  "offline OIDC identity import preserves account ownership and refuses unsafe writes",
  {
    skip:
      databaseUrl && migrationUrl
        ? false
        : "Set OCC_TEST_DATABASE_URL and OCC_AUTH_MAINTAIN_MIGRATION_DATABASE_URL for the same fresh database.",
  },
  async (t) => {
    assert.ok(databaseUrl && migrationUrl);
    const directory = await privateBootstrapDirectory(t, "openclaw-oidc-import-");
    const mappingFile = join(directory, "mapping.json");
    const address = clientAddresses();
    const controllerOptions = { databaseUrl, secrets };
    const {
      installationId,
      admin,
      accounts: { first, second },
    } = await withPool(databaseUrl, async (pool) => {
      const state = new PostgresPlatformState(pool);
      const onboarded = await onboardPasswordAccounts(t, {
        ...controllerOptions,
        state,
        pool,
        authSecret,
        email: "oidc-import-admin@example.test",
        password: "oidc-import-fixture-password",
        remoteAddress: address(),
        accounts: {
          first: { email: "oidc-import-first@example.test" },
          second: { email: "oidc-import-second@example.test" },
        },
      });
      const installation = await state.loadInstallation();
      assert.ok(installation);
      return { installationId: installation.id, ...onboarded };
    });
    const settings = oidcUpgradeSettings(admin.id);
    const app = await composeProductionSignIn(t, { ...controllerOptions, settings });
    const [adminHeaders, firstHeaders, secondHeaders] = await (async () => {
      try {
        return [
          await signedInHeaders(app, consoleOrigin, admin, address()),
          await signedInHeaders(app, consoleOrigin, first, address()),
          await signedInHeaders(app, consoleOrigin, second, address()),
        ];
      } finally {
        await app.close();
      }
    })();

    const firstLink = {
      userId: first.id,
      sourceSubject: "Directory:member|Équipe",
      oidcSubject: "member|one",
    };
    const secondLink = {
      userId: second.id,
      sourceSubject: "Directory:member|Other",
      oidcSubject: "member|two",
    };
    const claimedSubject = "staff|already-claimed";
    // Seed token-free methods from the retired provider and an independent OIDC method
    // on the administrator to exercise a real destination collision.
    await withPool(databaseUrl, async (pool) => {
      for (const [userId, providerId, subject] of [
        [first.id, sourceProviderId, firstLink.sourceSubject],
        [second.id, sourceProviderId, secondLink.sourceSubject],
        [admin.id, oidcProviderId, claimedSubject],
      ]) {
        await pool.query(
          `INSERT INTO occ.account
             (id, user_id, provider_id, account_id, identity_only, created_at, updated_at)
           VALUES ($1, $2, $3, $4, true, clock_timestamp(), clock_timestamp())`,
          [randomUUID(), userId, providerId, subject],
        );
      }
    });
    const before = await snapshot(databaseUrl);
    assert.deepEqual(
      before.sessions.map(({ user_id }) => user_id).sort(),
      [admin.id, first.id, second.id].sort(),
      "each account has a guarded session before maintenance",
    );
    const entries = [firstLink, secondLink].map(({ userId, sourceSubject, oidcSubject }) => {
      const account = before.accounts.find(({ user_id }) => user_id === userId);
      assert.ok(account, "the legacy identity belongs to an enrolled account");
      return { sourceSubject, oidcIssuer, oidcSubject, expectedVersion: account.version };
    });
    const [firstEntry, secondEntry] = entries;
    assert.ok(firstEntry && secondEntry);
    const operationId = randomUUID();
    const writeMapping = (
      links = entries,
      providerId = sourceProviderId,
      targetClientId = clientId,
    ) =>
      writeFile(
        mappingFile,
        JSON.stringify({
          operationId,
          installationId,
          sourceProviderId: providerId,
          oidcIssuer,
          oidcClientId: targetClientId,
          entries: links,
        }),
        { mode: 0o600 },
      );
    const { waitForNewBackendsToClose } = createAuthMaintainRunner(migrationUrl);
    const maintain = (flag: "--dry-run" | "--writers-stopped", url = migrationUrl) =>
      waitForNewBackendsToClose(() =>
        runAuthMaintainScript(["link-oidc", "--mapping-file", mappingFile, flag], {
          PATH: process.env.PATH,
          NODE_ENV: "production",
          OCC_MIGRATION_DATABASE_URL: url,
          OCC_AUTH_OIDC_ISSUER: oidcIssuer,
          OCC_AUTH_OIDC_CLIENT_ID: clientId,
        }),
      );

    await writeMapping();
    const applicationRole = await maintain("--dry-run", databaseUrl);
    assert.equal(applicationRole.code, 1, applicationRole.stderr);
    assert.match(applicationRole.stderr, /requires the migration role/);
    await withPool(databaseUrl, async (pool) => {
      const writer = await pool.connect();
      try {
        const preview = await maintain("--dry-run");
        assert.equal(preview.code, 0, preview.stderr);
        assert.deepEqual(preview.output, {
          event: "auth-maintain.link-oidc",
          status: "ready",
          accountCount: 2,
        });
        const guarded = await maintain("--writers-stopped");
        assert.equal(guarded.code, 2, guarded.stderr);
        assert.equal(requiredOutput(guarded).event, "auth-maintain.writers-running");
      } finally {
        writer.release();
      }
    });
    assert.deepEqual(
      await snapshot(databaseUrl),
      before,
      "preview and refused apply are read-only",
    );

    // A refusal on a later entry must preserve the first account and its session.
    for (const { entry, reason } of [
      {
        entry: { ...secondEntry, expectedVersion: secondEntry.expectedVersion + 1 },
        reason: "OIDC_VERSION_CHANGED",
      },
      { entry: { ...secondEntry, oidcSubject: claimedSubject }, reason: "OIDC_TARGET_CONFLICT" },
      {
        entry: { ...secondEntry, sourceSubject: secondEntry.sourceSubject.toLowerCase() },
        reason: "OIDC_SOURCE_UNAVAILABLE",
      },
      {
        entry: { ...secondEntry, sourceSubject: firstEntry.sourceSubject },
        reason: "OIDC_MAPPING_INVALID",
      },
      {
        entry: { ...secondEntry, oidcSubject: firstEntry.oidcSubject },
        reason: "OIDC_MAPPING_INVALID",
      },
      {
        entry: { ...secondEntry, sourceSubject: "\ud800" },
        reason: "OIDC_MAPPING_INVALID",
      },
      {
        entry: { ...secondEntry, oidcIssuer: "https://other-issuer.example.test" },
        reason: "OIDC_MAPPING_INVALID",
      },
    ]) {
      await writeMapping([firstEntry, entry]);
      const refused = await maintain("--writers-stopped");
      assert.equal(refused.code, 3, refused.stderr);
      assert.deepEqual(refused.output, { event: "auth-maintain.refused", reason });
      assert.deepEqual(
        await snapshot(databaseUrl),
        before,
        `${reason} leaves the whole batch unchanged`,
      );
    }

    for (const [providerId, targetClientId, reason] of [
      ["credential", clientId, "OIDC_MAPPING_INVALID"],
      ["previous-provider:other-instance", clientId, "OIDC_SOURCE_UNAVAILABLE"],
      [sourceProviderId, "other-oidc-client", "OIDC_MAPPING_INVALID"],
    ] as const) {
      await writeMapping(entries, providerId, targetClientId);
      const refused = await maintain("--dry-run");
      assert.equal(refused.code, 3, refused.stderr);
      assert.deepEqual(refused.output, { event: "auth-maintain.refused", reason });
    }
    assert.deepEqual(await snapshot(databaseUrl), before);

    await writeMapping();
    const mappingJson = await readFile(mappingFile, "utf8");
    await writeFile(
      mappingFile,
      mappingJson.replace(
        '"oidcSubject":',
        String.raw`"\u006fidcSubject":"another-subject","oidcSubject":`,
      ),
    );
    const repeatedField = await maintain("--writers-stopped");
    assert.equal(repeatedField.code, 3, repeatedField.stderr);
    assert.deepEqual(repeatedField.output, {
      event: "auth-maintain.refused",
      reason: "OIDC_MAPPING_INVALID",
    });
    assert.deepEqual(await snapshot(databaseUrl), before);

    await writeMapping();
    // Reject the receipt after all account writes to prove the whole transaction rolls back.
    await withPool(migrationUrl, (pool) =>
      pool.query(
        `ALTER TABLE occ.audit_events ADD CONSTRAINT oidc_import_fixture_refuses_receipt
         CHECK (action <> 'authentication.methods.link-oidc')`,
      ),
    );
    try {
      const auditFailure = await maintain("--writers-stopped");
      assert.equal(auditFailure.code, 1, auditFailure.stderr);
      assert.match(auditFailure.stderr, /The platform audit write failed/);
      assert.deepEqual(
        await snapshot(databaseUrl),
        before,
        "an audit failure rolls back the batch",
      );
    } finally {
      await withPool(migrationUrl, (pool) =>
        pool.query(
          "ALTER TABLE occ.audit_events DROP CONSTRAINT oidc_import_fixture_refuses_receipt",
        ),
      );
    }

    const applied = await maintain("--writers-stopped");
    assert.equal(applied.code, 0, applied.stderr);
    const { mappingDigest } = requiredOutput(applied);
    assert.ok(typeof mappingDigest === "string");
    assert.match(mappingDigest, /^[0-9a-f]{64}$/);
    const receipt = { operationId, mappingDigest, accountCount: 2 };
    assert.deepEqual(applied.output, {
      event: "auth-maintain.link-oidc",
      status: "applied",
      ...receipt,
    });

    const affected = new Set([first.id, second.id]);
    const after = await snapshot(databaseUrl);
    const previousMethods = new Set(before.methods.map(({ id }) => id));
    assert.deepEqual(
      after.methods.filter(({ id }) => previousMethods.has(id)),
      before.methods,
    );
    assert.deepEqual(
      after.methods
        .filter(({ id }) => !previousMethods.has(id))
        .map(({ id: _methodId, ...method }) => method)
        .sort((left, right) => left.account_id.localeCompare(right.account_id)),
      [firstLink, secondLink].map(({ userId, oidcSubject }) => ({
        user_id: userId,
        account_id: oidcSubject,
        provider_id: oidcProviderId,
        identity_only: true,
        has_material: false,
      })),
    );
    assert.deepEqual(after.grants, before.grants);
    assert.deepEqual(after.recovery, before.recovery);
    assert.deepEqual(
      after.accounts,
      before.accounts.map((account) => ({
        ...account,
        version: account.version + Number(affected.has(account.user_id)),
      })),
    );
    assert.deepEqual(
      after.sessions,
      before.sessions.filter(({ user_id }) => !affected.has(user_id)),
    );
    assert.deepEqual(
      after.audit.map(({ actorId, kind, resource, outcome, details }) => ({
        actorId,
        kind,
        resource,
        outcome,
        details,
      })),
      [
        {
          actorId: "maintenance:occ_migrator",
          kind: "mutation",
          resource: { kind: "installation", id: installationId },
          outcome: "success",
          details: { source: "auth-maintain", ...receipt },
        },
      ],
    );

    // Reordering the same mapping is safe after an uncertain outcome. Changing its content
    // cannot reuse the receipt, even when the original account versions have since advanced.
    await writeMapping([secondEntry, firstEntry]);
    const replay = await maintain("--writers-stopped");
    assert.equal(replay.code, 0, replay.stderr);
    assert.deepEqual(replay.output, {
      event: "auth-maintain.link-oidc",
      status: "already-applied",
      ...receipt,
    });
    await writeMapping([
      firstEntry,
      { ...secondEntry, sourceSubject: "Directory:member|different" },
    ]);
    const changed = await maintain("--writers-stopped");
    assert.equal(changed.code, 3, changed.stderr);
    assert.deepEqual(changed.output, {
      event: "auth-maintain.refused",
      reason: "OIDC_OPERATION_CONFLICT",
    });
    assert.deepEqual(await snapshot(databaseUrl), after, "retries do not repeat any state change");

    const groupId = "oidc-import-members";
    await withPool(databaseUrl, (pool) =>
      pool.query("INSERT INTO occ.iam_groups (id, name) VALUES ($1, $2)", [
        groupId,
        "OIDC import members",
      ]),
    );
    const idp = fakeOidc(t, { clientId, clientSecret });
    const restarted = await composeProductionSignIn(t, {
      ...controllerOptions,
      settings: {
        ...settings,
        OCC_AUTH_OIDC_ENROLLMENT: JSON.stringify({
          admission: { groupsClaim: "groups", anyOf: ["members"] },
          createAccount: { enabled: false },
          groupIds: [groupId],
        }),
      },
    });
    try {
      assert.equal(await currentSession(restarted, firstHeaders.cookie), null);
      assert.equal(await currentSession(restarted, secondHeaders.cookie), null);
      assert.equal((await currentSession(restarted, adminHeaders.cookie)).user.id, admin.id);
      // The fixture token has no email claim. The imported subject resolves the existing user.
      const { callback } = await oidcSignIn(
        restarted,
        consoleOrigin,
        idp,
        { subject: firstLink.oidcSubject, claims: { groups: ["members"] } },
        address(),
      );
      await assertConsoleSignIn(restarted, callback, first.id);
      const firstPrincipal = before.accounts.find(({ user_id }) => user_id === first.id);
      assert.ok(firstPrincipal);
      const members = await withPool(databaseUrl, (pool) =>
        pool.query<{ principal_id: string }>(
          "SELECT principal_id FROM occ.iam_group_memberships WHERE group_id = $1",
          [groupId],
        ),
      );
      assert.deepEqual(members.rows, [{ principal_id: firstPrincipal.principal_id }]);
    } finally {
      await restarted.close();
    }
  },
);
