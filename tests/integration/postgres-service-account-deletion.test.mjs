import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  OpenClawController,
  ResourceConflictError,
  ServiceAccountDriverNotConfiguredError,
} from "../../packages/occ/src/index.ts";
import { PostgresWorkQueue } from "../../packages/occ/src/state/postgres-work-queue.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import {
  createAccessTokenServiceAccount,
  createBackendFixture,
  backendDefinition,
  backendId,
  requiresPostgres,
  seedBackendBinding,
  serviceAccountDriverId,
  workspaceId,
} from "../helpers/postgres-backend-state.mjs";

test(
  "ServiceAccount deletion protects draft, queued, claimed, and active references before Driver effects",
  requiresPostgres,
  async (context) => {
    const fixture = await createBackendFixture(context);
    const { state, pool, actor } = fixture;
    const controller = new OpenClawController(fixture.installation, {
      state,
      backends: [backendDefinition()],
    });
    const deletedAccounts = [];
    for (const driver of [
      new NativeIAMDriver(state, { id: "service-account-deletion-iam" }),
      createDevelopmentComputeDriver(),
      createTestConfigurationDriver(),
      {
        id: serviceAccountDriverId,
        backendId,
        capability: "service_account",
        implementation: "deletion-observer",
        async create() {
          assert.fail("This fixture seeds backend bindings.");
        },
        async createCredential() {
          assert.fail("This fixture seeds credential references.");
        },
        async delete(account) {
          deletedAccounts.push(account.id);
        },
      },
    ]) {
      controller.registerDriver(driver);
      controller.selectDriver(driver.capability, driver.id);
    }
    const namespace = fixture.track(
      await state.transact((unit) =>
        unit.namespaces.createNamespace({
          id: `ns_${randomUUID()}`,
          name: `account-deletion-${randomUUID()}`,
          status: "ready",
          createdAt: new Date().toISOString(),
        }),
      ),
    );
    const account = await createAccessTokenServiceAccount(state, namespace.id, "deletion");
    await seedBackendBinding(pool, account);
    const configuration = await controller.createConfiguration(actor.id, {
      namespaceId: namespace.id,
      kind: "agent",
      values: createHarnessConfiguration("codex", "gpt-5.6-sol"),
    });
    const agent = await controller.createAgent(actor.id, {
      namespaceId: namespace.id,
      name: "account-consumer",
      configurationId: configuration.id,
      harnessAuth: {
        method: "codex_pat",
        source: { kind: "service_account", namespaceId: account.namespaceId, id: account.id },
      },
      backendId,
      executionMode: "dedicated",
    });
    const target = { namespaceId: namespace.id, agentId: agent.id };
    // Direct SQL proves the canonical source discriminator drives the real ownership FK,
    // independently of OCC's input validation and authorization.
    assert.deepEqual(
      (
        await pool.query(
          "SELECT harness_auth_secret_id, harness_auth_service_account_id FROM occ.agents WHERE id = $1",
          [agent.id],
        )
      ).rows,
      [{ harness_auth_secret_id: null, harness_auth_service_account_id: account.id }],
    );
    for (const [source, code] of [
      [{ ...agent.harnessAuth.source, id: `sa_${randomUUID()}` }, "23503"],
      [{ ...agent.harnessAuth.source, namespaceId: `ns_${randomUUID()}` }, "23514"],
      [{ ...agent.harnessAuth.source, kind: "secret" }, "23514"],
    ]) {
      await assert.rejects(
        pool.query("UPDATE occ.agents SET harness_auth = $1::jsonb WHERE id = $2", [
          JSON.stringify({ method: "codex_pat", source }),
          agent.id,
        ]),
        { code },
      );
    }
    async function claimRevision() {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Other suites retain work in this database. Temporarily lock those rows so the
        // real queue's SKIP LOCKED claim selects only this fixture without mutating peers.
        await client.query(
          "SELECT idempotency_key FROM occ.controller_work WHERE namespace_id <> $1 FOR UPDATE SKIP LOCKED",
          [namespace.id],
        );
        // Claim on another connection: PostgreSQL does not skip a transaction's own locks.
        const claim = await new PostgresWorkQueue(pool).claim();
        await client.query("COMMIT");
        return claim;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    // A draft binding alone protects the source before any deployment exists.
    await assertProtected();
    const revision = await controller.deployAgent(actor.id, target, resolveApprovedHarness);
    await controller.updateAgent(actor.id, {
      ...target,
      configurationId: configuration.id,
      harnessAuth: null,
    });

    async function assertProtected() {
      await assert.rejects(
        controller.deleteServiceAccount(actor.id, namespace.id, account.id),
        ResourceConflictError,
      );
      assert.deepEqual(
        deletedAccounts,
        [],
        "Rejection must precede the credential-revoking Driver call.",
      );
      assert.deepEqual(
        await controller.getServiceAccount(actor.id, namespace.id, account.id),
        account,
      );
    }

    // Admission persists work even when the mutable draft no longer selects this account.
    await assertProtected();
    const claim = await claimRevision();
    assert.equal(claim?.revisionId, revision.id);
    await assertProtected();

    // Model the worker's persisted cutover and completion; this is PostgreSQL lifecycle proof,
    // not a live provider or Compute integration. The active pointer must protect a completed job.
    await state.transactWithQueue(async (unit, queue) => {
      assert.ok(
        await unit.agents.compareAndSetActiveRevision(
          namespace.id,
          agent.id,
          undefined,
          revision.id,
        ),
      );
      await queue.complete(claim);
    });
    await assertProtected();

    const replacementAccount = await createAccessTokenServiceAccount(
      state,
      namespace.id,
      "replacement",
    );
    await seedBackendBinding(pool, replacementAccount);
    await controller.updateAgent(actor.id, {
      ...target,
      configurationId: configuration.id,
      harnessAuth: {
        method: "codex_pat",
        source: {
          kind: "service_account",
          namespaceId: replacementAccount.namespaceId,
          id: replacementAccount.id,
        },
      },
    });
    const replacement = await controller.deployAgent(actor.id, target, resolveApprovedHarness);
    const next = await claimRevision();
    assert.equal(next?.revisionId, replacement.id);
    await state.transactWithQueue(async (unit, queue) => {
      assert.ok(
        await unit.agents.compareAndSetActiveRevision(
          namespace.id,
          agent.id,
          revision.id,
          replacement.id,
        ),
      );
      await queue.complete(next);
    });

    // A retained historical snapshot is no longer a live credential consumer after cutover.
    await controller.deleteServiceAccount(actor.id, namespace.id, account.id);
    assert.deepEqual(deletedAccounts, [account.id]);
    assert.equal(
      await state.read((unit) => unit.serviceAccounts.findServiceAccount(namespace.id, account.id)),
      undefined,
    );
    assert.deepEqual(
      (await state.read((unit) => unit.revisions.findRevision(namespace.id, agent.id, revision.id)))
        .harnessAuth,
      revision.harnessAuth,
    );

    // A deployment that fails permanently without becoming active releases its account reference.
    const failedAccount = await createAccessTokenServiceAccount(
      state,
      namespace.id,
      "failed-deletion",
    );
    await seedBackendBinding(pool, failedAccount);
    await controller.updateAgent(actor.id, {
      ...target,
      configurationId: configuration.id,
      harnessAuth: {
        method: "codex_pat",
        source: {
          kind: "service_account",
          namespaceId: failedAccount.namespaceId,
          id: failedAccount.id,
        },
      },
    });
    const failedRevision = await controller.deployAgent(actor.id, target, resolveApprovedHarness);
    await controller.updateAgent(actor.id, {
      ...target,
      configurationId: configuration.id,
      harnessAuth: null,
    });
    const failedClaim = await claimRevision();
    assert.equal(failedClaim?.revisionId, failedRevision.id);
    await state.transactWithQueue(async (_unit, queue) => {
      await queue.fail(failedClaim, { code: "INVALID_DRIVER_OBSERVATION" });
    });
    await controller.deleteServiceAccount(actor.id, namespace.id, failedAccount.id);
    assert.deepEqual(deletedAccounts, [account.id, failedAccount.id]);
  },
);

test(
  "a forced ServiceAccount delete without a Driver audits the unrevoked credential and decides on the locked account",
  requiresPostgres,
  async (context) => {
    const fixture = await createBackendFixture(context);
    const { state, pool, actor } = fixture;
    // This API process selects no ServiceAccount Driver: the ChatGPT Backend is gone.
    const controller = new OpenClawController(fixture.installation, { state });
    const deletedSecrets = [];
    for (const driver of [
      new NativeIAMDriver(state, { id: "service-account-force-iam" }),
      {
        ...createDevelopmentComputeDriver(),
        async deleteServiceAccountCredential(input) {
          deletedSecrets.push(input);
        },
      },
      createTestConfigurationDriver(),
    ]) {
      controller.registerDriver(driver);
      controller.selectDriver(driver.capability, driver.id);
    }
    const namespace = fixture.track(
      await state.transact((unit) =>
        unit.namespaces.createNamespace({
          id: `ns_${randomUUID()}`,
          name: `account-force-${randomUUID()}`,
          status: "ready",
          createdAt: new Date().toISOString(),
        }),
      ),
    );
    const bindingOf = async (account) =>
      (
        await pool.query(
          `SELECT backend_id, workspace_id, external_account_id, external_credential_id
           FROM occ.service_account_driver_bindings WHERE service_account_id = $1`,
          [account.id],
        )
      ).rows[0];

    const account = await createAccessTokenServiceAccount(state, namespace.id, "forced");
    await seedBackendBinding(pool, account);
    const binding = await bindingOf(account);
    await assert.rejects(
      controller.deleteServiceAccount(actor.id, namespace.id, account.id),
      ServiceAccountDriverNotConfiguredError,
    );
    assert.deepEqual(
      await controller.deleteServiceAccount(actor.id, namespace.id, account.id, { force: true }),
      {
        removedAccessBindings: [],
        unrevokedCredential: {
          backendId,
          workspaceId,
          externalAccountId: binding.external_account_id,
          credentialId: binding.external_credential_id,
        },
      },
    );
    assert.deepEqual(deletedSecrets, [
      {
        namespaceId: namespace.id,
        serviceAccountId: account.id,
        secretRef: account.credential.secretRef,
      },
    ]);
    // The account and its private binding are gone together.
    assert.equal(await bindingOf(account), undefined);
    assert.equal(
      await state.read((unit) => unit.serviceAccounts.findServiceAccount(namespace.id, account.id)),
      undefined,
    );

    // A token issued while the forced delete waits for the account row lock is seen and
    // reported, never deleted unnoticed: the decision reads the locked row.
    const racing = await state.transact((unit) =>
      unit.serviceAccounts.createServiceAccount({
        id: `sa_${randomUUID()}`,
        namespaceId: namespace.id,
        name: `racing-${randomUUID()}`,
      }),
    );
    await seedBackendBinding(pool, racing, { credentialIssued: false });
    const racingBinding = await bindingOf(racing);
    const issuer = await pool.connect();
    let forced;
    try {
      await issuer.query("BEGIN");
      const [{ pid }] = (await issuer.query("SELECT pg_backend_pid() AS pid")).rows;
      await issuer.query("SELECT id FROM occ.service_accounts WHERE id = $1 FOR UPDATE", [
        racing.id,
      ]);
      forced = controller.deleteServiceAccount(actor.id, namespace.id, racing.id, {
        force: true,
      });
      forced.catch(() => {});
      const deadline = Date.now() + 15_000;
      for (;;) {
        const [{ blocked }] = (
          await pool.query(
            "SELECT count(*)::int AS blocked FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
            [pid],
          )
        ).rows;
        if (blocked > 0) {
          break;
        }
        assert.ok(Date.now() < deadline, "the forced delete never waited for the account lock");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await issuer.query("UPDATE occ.service_accounts SET credential = $2::jsonb WHERE id = $1", [
        racing.id,
        JSON.stringify({
          kind: "access_token",
          secretRef: { name: `service-account-${racing.id.slice(3, 35)}`, key: "token" },
        }),
      ]);
      await issuer.query(
        `UPDATE occ.service_account_driver_bindings SET external_credential_id = $2
         WHERE service_account_id = $1`,
        [racing.id, "external-credential-raced"],
      );
      await issuer.query("COMMIT");
    } catch (error) {
      await issuer.query("ROLLBACK");
      throw error;
    } finally {
      issuer.release();
    }
    assert.deepEqual((await forced).unrevokedCredential, {
      backendId,
      workspaceId,
      externalAccountId: racingBinding.external_account_id,
      credentialId: "external-credential-raced",
    });
    assert.equal(deletedSecrets.length, 2);
  },
);
