import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { ChatGPTServiceAccountDriver } from "../../apps/controller/src/drivers/service-account/chatgpt.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  OpenClawController,
  PostgresCommitOutcomeUnknownError,
  PostgresPlatformState,
  ServiceAccountCredentialSecretExistsError,
} from "../../packages/occ/src/index.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import {
  authorizedPrincipal,
  backendDefinition,
  backendId,
  createBackendFixture,
  databaseUrl,
  requiresPostgres,
  seedBackendBinding,
  serviceAccountDriverId,
  workspaceId,
} from "../helpers/postgres-backend-state.mjs";
import { waitForLockHolder } from "../helpers/postgres-lock-waits.mjs";

/**
 * Finding 1397: an issuance whose token Secret was stored but whose transaction never committed
 * (a crash, or an unknown COMMIT that failed) skips its compensations. These cases run the real
 * OCC operations over PostgreSQL, so the account row lock, the Driver's binding reads on the
 * caller's transaction connection, and the rollback are real. The ChatGPT Driver is the
 * production class. The provider and the Secret store are in-memory stand-ins for its two
 * dependencies: the provider's HTTP handling and the Kubernetes Secret semantics (ownership,
 * uid and resourceVersion preconditions, the credential-ID annotation) are proved in
 * service-account-driver and kubernetes-compute conformance. No live provider or cluster runs.
 */
function dependencies() {
  const provider = { live: new Set(), revoked: [], deletedAccounts: [], issued: 0 };
  const client = {
    workspaceId,
    async createCredential() {
      provider.issued += 1;
      const id = `cred-${provider.issued}`;
      provider.live.add(id);
      return { id, accessToken: `synthetic-token-${provider.issued}` };
    },
    async deleteCredential({ credentialId }) {
      provider.revoked.push(credentialId);
      provider.live.delete(credentialId);
    },
    async deleteServiceAccount(accountId) {
      provider.deletedAccounts.push(accountId);
    },
  };
  // One token Secret per account under its deterministic name, recording its credential ID.
  const secrets = new Map();
  const secretName = (serviceAccountId) =>
    `service-account-${createHash("sha256").update(serviceAccountId).digest("hex").slice(0, 32)}`;
  const storage = {
    async storeServiceAccountCredential({ serviceAccountId, credentialId, accessToken }) {
      const name = secretName(serviceAccountId);
      if (secrets.has(serviceAccountId)) {
        throw new ServiceAccountCredentialSecretExistsError("oce-control", name);
      }
      secrets.set(serviceAccountId, { credentialId, accessToken });
      return { name, key: "token" };
    },
    async findServiceAccountCredential({ serviceAccountId }) {
      const stored = secrets.get(serviceAccountId);
      return stored === undefined
        ? undefined
        : {
            secretNamespace: "oce-control",
            secretRef: { name: secretName(serviceAccountId), key: "token" },
            credentialId: stored.credentialId,
          };
    },
    async deleteServiceAccountCredential({ serviceAccountId, accessToken, credentialId }) {
      const stored = secrets.get(serviceAccountId);
      if (
        stored === undefined ||
        (accessToken !== undefined && stored.accessToken !== accessToken) ||
        (credentialId !== undefined && stored.credentialId !== credentialId)
      ) {
        return;
      }
      secrets.delete(serviceAccountId);
    },
  };
  return { client, provider, secrets, storage };
}

/** An OCC API controller over `state` with the production ChatGPT ServiceAccount Driver. */
function apiController(fixture, state, { client, storage }) {
  const controller = new OpenClawController(fixture.installation, {
    state,
    backends: [backendDefinition()],
  });
  const driver = new ChatGPTServiceAccountDriver(
    { id: backendId, drivers: { service_account: serviceAccountDriverId }, client },
    controller,
    state,
    storage,
  );
  for (const selected of [
    new NativeIAMDriver(state, { id: `issuance-recovery-iam-${randomUUID()}` }),
    createDevelopmentComputeDriver(),
    createTestConfigurationDriver(),
    driver,
  ]) {
    controller.registerDriver(selected);
    controller.selectDriver(selected.capability, selected.id);
  }
  return controller;
}

async function issuanceFixture(context) {
  const fixture = await createBackendFixture(context);
  const { state, pool } = fixture;
  const actor = authorizedPrincipal(await state.loadNativeIAMState(), [
    ["read", "service_account"],
    ["update", "service_account"],
    ["delete", "service_account"],
  ]);
  assert.ok(actor, "persisted IAM must contain an unrestricted ServiceAccount Principal");
  const used = dependencies();
  const controller = apiController(fixture, state, used);
  const namespace = fixture.track(
    await state.transact((unit) =>
      unit.namespaces.createNamespace({
        id: `ns_${randomUUID()}`,
        name: `issuance-recovery-${randomUUID()}`,
        status: "ready",
        createdAt: new Date().toISOString(),
      }),
    ),
  );
  const account = await state.transact((unit) =>
    unit.serviceAccounts.createServiceAccount({
      id: `sa_${randomUUID()}`,
      namespaceId: namespace.id,
      name: `issuance-recovery-${randomUUID()}`,
    }),
  );
  await seedBackendBinding(pool, account, { credentialIssued: false });
  const recordedCredentialId = async () =>
    (
      await pool.query(
        "SELECT external_credential_id FROM occ.service_account_driver_bindings WHERE service_account_id = $1",
        [account.id],
      )
    ).rows[0]?.external_credential_id;
  const issue = () => controller.createServiceAccountCredential(actor.id, namespace.id, account.id);
  // The issuance runs to the end of its Driver call; then its COMMIT outcome is unknown and it
  // really failed. PostgreSQL rolls the transaction back and OCC runs no compensation, exactly
  // as for a crash after the Secret was stored.
  const abandonIssuance = async () => {
    await assert.rejects(
      controller.transact(async () => {
        await issue();
        throw new PostgresCommitOutcomeUnknownError();
      }),
      PostgresCommitOutcomeUnknownError,
    );
  };
  return {
    ...used,
    account,
    actor,
    controller,
    fixture,
    issue,
    abandonIssuance,
    namespace,
    recordedCredentialId,
  };
}

test(
  "an issuance that never committed is reclaimed by the next issuance under the account lock",
  requiresPostgres,
  async (context) => {
    const {
      abandonIssuance,
      account,
      actor,
      controller,
      issue,
      namespace,
      provider,
      recordedCredentialId,
      secrets,
    } = await issuanceFixture(context);
    await abandonIssuance();
    // The live credential and its Secret stayed, but nothing recorded them.
    assert.deepEqual([...provider.live], ["cred-1"]);
    assert.equal(secrets.get(account.id).credentialId, "cred-1");
    assert.equal(await recordedCredentialId(), null);
    assert.equal(
      (await controller.getServiceAccount(actor.id, namespace.id, account.id)).credential,
      undefined,
    );

    // Before finding 1397 this answered the leftover Secret's 409 until an operator deleted it.
    const issued = await issue();
    assert.equal(issued.credential.kind, "access_token");
    assert.deepEqual(provider.revoked, ["cred-1"]);
    assert.deepEqual([...provider.live], ["cred-2"]);
    assert.equal(secrets.get(account.id).credentialId, "cred-2");
    assert.equal(await recordedCredentialId(), "cred-2");
  },
);

test(
  "deleting an account after an issuance that never committed revokes its credential and removes its Secret",
  requiresPostgres,
  async (context) => {
    const { abandonIssuance, account, actor, controller, namespace, provider, secrets } =
      await issuanceFixture(context);
    await abandonIssuance();

    // No credential is recorded, so the delete used to skip the Secret, which then outlived the
    // account holding a live token.
    await controller.deleteServiceAccount(actor.id, namespace.id, account.id);
    assert.deepEqual(provider.revoked, ["cred-1"]);
    assert.equal(provider.live.size, 0);
    assert.equal(secrets.has(account.id), false);
    assert.equal(provider.deletedAccounts.length, 1);
  },
);

test(
  "a reclaim whose PostgreSQL session ends during the Secret read leaves a later issuance intact",
  requiresPostgres,
  async (context) => {
    const issuing = await issuanceFixture(context);
    const { account, actor, fixture, issue, namespace, provider, recordedCredentialId, secrets } =
      issuing;
    const { pool } = fixture;
    // A second API process over its own pool: the later issuance must not share this request's
    // transaction context.
    const otherPool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    context.after(() => otherPool.end());
    const other = apiController(fixture, new PostgresPlatformState(otherPool), issuing);

    const find = issuing.storage.findServiceAccountCredential;
    let intercept = true;
    issuing.storage.findServiceAccountCredential = async (input) => {
      if (!intercept) {
        return find(input);
      }
      intercept = false;
      // This request holds the account row lock. Find its backend through a probe that waits
      // for that lock, then end the session: PostgreSQL releases the lock.
      const probe = await pool.connect();
      try {
        await probe.query("BEGIN");
        const [{ pid: probePid }] = (await probe.query("SELECT pg_backend_pid() AS pid")).rows;
        const waiting = probe.query(
          "SELECT id FROM occ.service_accounts WHERE id = $1 FOR UPDATE",
          [account.id],
        );
        waiting.catch(() => {});
        const holder = await waitForLockHolder(
          pool,
          probePid,
          "the probe to wait for the account lock",
          { timeoutMs: 15_000, intervalMs: 50 },
        );
        await pool.query("SELECT pg_terminate_backend($1)", [holder]);
        await waiting;
        await probe.query("ROLLBACK");
      } finally {
        probe.release();
      }
      // While this request still runs, a later issuance takes the released lock and commits
      // its credential and Secret.
      await other.createServiceAccountCredential(actor.id, namespace.id, account.id);
      // The Secret read returns that committed Secret.
      return find(input);
    };

    // The binding reread after the Secret read runs on the ended session, so this request fails
    // before it can revoke the later issuance's credential or delete its Secret.
    await assert.rejects(issue(), {
      name: "DependencyUnavailableError",
      message: "The selected ServiceAccount Driver is unavailable.",
    });
    assert.equal(intercept, false);
    assert.deepEqual(provider.revoked, []);
    assert.deepEqual([...provider.live], ["cred-1"]);
    assert.equal(secrets.get(account.id).credentialId, "cred-1");
    assert.equal(await recordedCredentialId(), "cred-1");
  },
);
