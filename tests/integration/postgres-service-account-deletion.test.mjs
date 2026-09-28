import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { OpenClawController, ResourceConflictError } from "../../packages/occ/src/index.ts";
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
      harnessAuth: { method: "chatgpt_service_account", serviceAccountId: account.id },
      backendId,
      executionMode: "dedicated",
    });
    const target = { namespaceId: namespace.id, agentId: agent.id };
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
      harnessAuth: { method: "chatgpt_service_account", serviceAccountId: replacementAccount.id },
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
      harnessAuth: { method: "chatgpt_service_account", serviceAccountId: failedAccount.id },
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
