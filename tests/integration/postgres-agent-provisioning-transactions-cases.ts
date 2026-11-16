import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import pg from "pg";
import { AgentProvisioningStatusResponse } from "../../packages/contracts/src/api/resources.ts";
import type { AgentProvisioningStatusWire } from "../../packages/contracts/src/index.ts";
import type { PlatformUnitOfWork } from "../../packages/occ/src/index.ts";
import { required } from "./postgres-agent-provisioning-setup.ts";

import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { waitForLockWaiter, withNamespaceLockHeld } from "../helpers/postgres-locks.ts";
import { PROVISIONING_NOT_COMPLETED } from "../helpers/refusal-text.mjs";
import { waitFor } from "../helpers/wait-for.mjs";

import {
  claimProvisioningWork,
  createFixture,
  createProvisioningSecrets,
  requestAcceptedProvisioning,
} from "./postgres-agent-provisioning-setup.ts";

async function preparePermanentProvisioningFailure(context: TestContext) {
  const fixture = await createFixture(context);
  const namespace = await fixture.bootstrapNamespace();
  const secrets = await createProvisioningSecrets(fixture, namespace.id);
  const admitted = await requestAcceptedProvisioning(fixture, namespace.id, secrets);
  const { workId, url } = admitted.data.provisioning;
  const claim = await claimProvisioningWork(fixture.pool, workId);
  const failure = {
    code: "PROVISIONING_REJECTED",
    message: PROVISIONING_NOT_COMPLETED,
  };
  async function recordFailure(unit: PlatformUnitOfWork) {
    const current = await unit.provisioning.findByWorkId(workId);
    assert.ok(current);
    await unit.provisioning.recordFailure(
      claim,
      {
        completedPhase: current.completedPhase,
        progress: { ...current.progress, error: failure },
      },
      { disposition: "permanent", ...failure },
    );
  }
  return { fixture, namespaceId: namespace.id, workId, url, failure, recordFailure };
}

export function registerTransactionCases() {
  test(
    "provisioning status never pairs a job with a queue row from a later commit",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const { fixture, workId, url, failure, recordFailure } =
        await preparePermanentProvisioningFailure(context);

      // Stage the worker's permanent failure the way the worker writes it (job and queue row in
      // one transaction) and hold its commit open.
      const { promise: commitGate, resolve: releaseCommit } = Promise.withResolvers<void>();
      const { promise: failureStaged, resolve: staged } = Promise.withResolvers<void>();
      const committed = fixture.state.transact(async (unit) => {
        await recordFailure(unit);
        staged();
        await commitGate;
      });
      await failureStaged;

      // Commit the failure right after the status read's first statement on this job returns.
      // The hook only delays that result; the controller's own queries produce the response.
      // Reading the job and queue row in separate statements would now see a failed queue row
      // next to the pre-failure job and report a generic failure.
      let interleaved = false;
      // The runtime accepts several overloads. Preserve their complete argument list,
      // and hold only the Promise returned by the matching Promise-style SQL call.
      type Query = (this: pg.Client, ...args: unknown[]) => unknown;
      const query: Query = pg.Client.prototype.query as Query;
      const hook = context.mock.method(pg.Client.prototype, "query", function (
        this: pg.Client,
        ...args: unknown[]
      ) {
        const [config, values] = args;
        const result = query.apply(this, args);
        if (
          !interleaved &&
          typeof config === "string" &&
          config.includes("occ.agent_provisioning_work") &&
          Array.isArray(values) &&
          (values as readonly unknown[])[0] === workId &&
          result instanceof Promise
        ) {
          interleaved = true;
          return result.then(async (rows: unknown) => {
            releaseCommit();
            await committed;
            return rows;
          });
        }
        return result;
      } as typeof pg.Client.prototype.query);

      let during: { status: number; body: unknown; data: AgentProvisioningStatusWire };
      try {
        during = await fixture.requestChecked(AgentProvisioningStatusResponse, "GET", url);
      } finally {
        // Never leave the staged transaction open, even when the read fails.
        hook.mock.restore();
        releaseCommit();
        await committed;
      }
      assert.equal(interleaved, true, "the failure must commit inside the status read");
      assert.equal(during.status, 200, JSON.stringify(during.body));
      assert.deepEqual(
        { status: during.data.status, error: during.data.error },
        { status: "running", error: undefined },
        "a status read that started before the failure commit reports the state before it",
      );

      const after = await fixture.requestChecked(AgentProvisioningStatusResponse, "GET", url);
      assert.equal(after.status, 200, JSON.stringify(after.body));
      assert.equal(after.data.status, "failed");
      assert.deepEqual(after.data.error, failure);
    },
  );

  test(
    "a provisioning failure takes the Namespace lock before its claimed work row",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const { fixture, namespaceId, workId, url, failure, recordFailure } =
        await preparePermanentProvisioningFailure(context);

      // Stopping or deleting a provisioned Agent locks the Namespace, then the Agent, then this
      // claimed work row (cancelByAgent). Hold the Namespace until the worker's permanent failure
      // waits on it; the waiting failure must not hold the work row yet, or the two deadlock.
      let committed: Promise<void> | undefined;
      try {
        await withNamespaceLockHeld(fixture.pool, namespaceId, async (lock) => {
          committed = fixture.state.transact(recordFailure);
          // Surface an early failure through the await below instead of an unhandled rejection.
          committed.catch(() => {});
          // No worker runs here, so the only backend that can wait on this lock is the failure's.
          await lock.waitForBlocked("the failure's real wait on the Namespace lock");
          await lock.assertNotHeld(
            "SELECT state FROM occ.controller_work WHERE idempotency_key = $1 FOR UPDATE NOWAIT",
            [workId],
            "a failure waiting for the Namespace must not already hold its work row",
          );
        });
        await committed;
      } finally {
        await committed?.catch(() => {});
      }

      const after = await fixture.requestChecked(AgentProvisioningStatusResponse, "GET", url);
      assert.equal(after.status, 200, JSON.stringify(after.body));
      assert.equal(after.data.status, "failed");
      assert.deepEqual(after.data.error, failure);
    },
  );

  test(
    "provisioning takes the IAM configuration lock before the Namespace lock",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const fixture = await createFixture(context, { stopAfterProvisioning: true });
      const namespace = await fixture.bootstrapNamespace();
      const secrets = await createProvisioningSecrets(fixture, namespace.id);
      const admitted = await requestAcceptedProvisioning(fixture, namespace.id, secrets);

      // Applying the iam configuration at API or worker startup holds this advisory lock
      // exclusively (the key is IAM_CONFIGURATION_LOCK_KEY in postgres-state.ts), then locks each
      // Namespace it writes a configured binding into. Hold the lock until the provisioning worker
      // waits on it: that wait must not already hold the Namespace, or a startup that overlaps
      // provisioning deadlocks and PostgreSQL aborts one of them.
      const holder = await fixture.pool.connect();
      let failed = false;
      try {
        await holder.query<Record<string, unknown>>("BEGIN");
        const backend = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        await holder.query<Record<string, unknown>>(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          ["occ:iam-configuration"],
        );
        await fixture.startWorker();
        await waitForLockWaiter(
          fixture.pool,
          backend.rows[0]!.pid,
          "the provisioning worker's wait on the IAM configuration lock",
        );
        await assert.doesNotReject(
          holder.query<Record<string, unknown>>(
            "SELECT id FROM occ.namespaces WHERE id = $1 FOR UPDATE NOWAIT",
            [namespace.id],
          ),
          "provisioning waiting for the IAM configuration must not already hold its Namespace",
        );
        await holder.query<Record<string, unknown>>("COMMIT");
      } catch (error) {
        failed = true;
        await holder.query<Record<string, unknown>>("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        holder.release(failed);
      }

      // Once the configuration change commits, the same provisioning attempt goes on to create
      // its Agent.
      try {
        const created = await waitFor("provisioning to create its Agent", async () => {
          const observed = await fixture.requestChecked(
            AgentProvisioningStatusResponse,
            "GET",
            admitted.data.provisioning.url,
          );
          assert.equal(observed.status, 200, JSON.stringify(observed.body));
          assert.notEqual(observed.data.status, "failed", JSON.stringify(observed.body));
          return observed.data.agentId === undefined ? undefined : observed.data;
        });
        fixture.cancelProvisioningAtTeardown(namespace.id, required(created.agentId));
      } finally {
        await fixture.stopWorker();
      }
    },
  );
}
