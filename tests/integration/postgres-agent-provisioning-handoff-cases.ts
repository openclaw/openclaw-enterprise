import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import {
  AgentDeploymentStatusResponse,
  AgentProvisioningStatusResponse,
  AgentReadResponse,
  AgentResponse,
  AgentRevisionResponse,
} from "../../packages/contracts/src/api/resources.ts";
import type { ProvisionAgentBody } from "../../packages/contracts/src/index.ts";
import type { AgentProvisioningRecord, ControllerWorkState } from "../../packages/occ/src/index.ts";
import { provisioningConfigurationId } from "./postgres-agent-provisioning-retry-cases.ts";
import type {
  Fixture,
  ProvisioningPhase,
  WorkerEvent,
} from "./postgres-agent-provisioning-setup.ts";
import { handedOff, readPendingEffect, required } from "./postgres-agent-provisioning-setup.ts";

import { currentComputeAbortSignal } from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { waitForLockWaiter, withNamespaceLockHeld } from "../helpers/postgres-locks.ts";
import { waitFor } from "../helpers/wait-for.ts";
import {
  createRuntimeComputeDriver,
  failingTransportDriver,
  heldTransportDriver,
  provisioningEffectState,
} from "./postgres-agent-provisioning-transport-fixture.ts";

import {
  admitProvisioning,
  createFixture,
  createProvisioningSecrets,
  identifier,
  namespaceLockStatement,
  provisioningError,
  requestAcceptedProvisioning,
} from "./postgres-agent-provisioning-setup.ts";

export async function createFailedPreHandoffAgent(
  fixture: Fixture,
  overrides: Partial<ProvisionAgentBody> = {},
) {
  const namespace = await fixture.bootstrapNamespace();
  const secrets = await createProvisioningSecrets(fixture, namespace.id);
  const admitted = await requestAcceptedProvisioning(fixture, namespace.id, secrets, overrides);

  await fixture.startWorker();
  const observedFailure = await waitFor("Agent provisioning to fail before handoff", async () => {
    const observed = await fixture.requestChecked(
      AgentProvisioningStatusResponse,
      "GET",
      admitted.data.provisioning.url,
    );
    assert.equal(observed.status, 200, JSON.stringify(observed.body));
    return observed.data.status === "failed" ? observed.data : undefined;
  });
  await fixture.stopWorker();
  const failed = { ...observedFailure, agentId: required(observedFailure.agentId) };
  assert.match(failed.agentId, identifier("agt"));
  assert.equal(failed.revisionId, undefined);
  const pending = await fixture.pool.query<{ pending_effect: unknown }>(
    "SELECT progress->'pendingEffect' AS pending_effect FROM occ.agent_provisioning_work WHERE work_id = $1",
    [admitted.data.provisioning.workId],
  );
  assert.equal(pending.rowCount, 1);
  const effect = readPendingEffect(required(pending.rows[0]).pending_effect);
  assert.deepEqual(effect.kind, "transport");
  assert.deepEqual(effect.targetId, failed.agentId);
  return { namespace, admitted, failed, pendingEffect: effect };
}

async function settleLateTransport(
  fixture: Fixture,
  target: Awaited<ReturnType<typeof createFailedPreHandoffAgent>>,
) {
  const settled = await fixture.state.transact((unit) =>
    unit.provisioning.settleEffect(target.admitted.data.provisioning.workId, {
      kind: "transport",
      owner: required(target.pendingEffect.owner),
      targetId: target.pendingEffect.targetId,
    }),
  );
  assert.equal(settled.status, "cancelled");
  const revisions = await fixture.pool.query<{ id: string }>(
    "SELECT id FROM occ.agent_revisions WHERE namespace_id = $1 AND agent_id = $2",
    [target.namespace.id, target.failed.agentId],
  );
  assert.equal(revisions.rowCount, 0, "late settlement must not deploy by itself");
  return settled;
}

async function assertCancellationAudit(
  fixture: Fixture,
  target: Awaited<ReturnType<typeof createFailedPreHandoffAgent>>,
  trigger: "stop" | "delete",
  requestId: string,
) {
  const workId = target.admitted.data.provisioning.workId;
  const audit = await fixture.pool.query<{
    actor_id: string | null;
    kind: string;
    outcome: string;
    resource_kind: string;
    resource_id: string;
    namespace_id: string | null;
    source: string | null;
    request_id: string | null;
    details: unknown;
  }>(
    `SELECT actor_id, kind, outcome, resource_kind, resource_id, namespace_id,
            details->'__occAuditMetadata'->>'source' AS source,
            details->'__occAuditMetadata'->>'requestId' AS request_id,
            details - '__occAuditMetadata' AS details
     FROM occ.audit_events
     WHERE action = 'openclaw.agents.provision.cancelled' AND details->>'workId' = $1`,
    [workId],
  );
  assert.deepEqual(audit.rows, [
    {
      actor_id: await fixture.administratorPrincipalId(),
      kind: "mutation",
      outcome: "success",
      resource_kind: "agent",
      resource_id: target.failed.agentId,
      namespace_id: target.namespace.id,
      source: "occ",
      request_id: requestId,
      details: { reasonCode: "PROVISIONING_CANCELLED", workId, trigger },
    },
  ]);
}

// Admits provisioning and starts the worker, then waits until it is inside its first runtime
// credential write, so a worker holds the job's claim with a pending transport effect.
async function provisionUntilTransportWrite(fixture: Fixture, isWriting: () => boolean) {
  const namespace = await fixture.bootstrapNamespace();
  const secrets = await createProvisioningSecrets(fixture, namespace.id);
  const admitted = await requestAcceptedProvisioning(fixture, namespace.id, secrets);
  await fixture.startWorker();
  await waitFor("the worker to begin the runtime-credential write", async () =>
    isWriting() ? true : undefined,
  );
  const pending = await fixture.pool.query<{
    agent_id: string | null;
    status: AgentProvisioningRecord["status"];
    pending_effect: unknown;
  }>(
    `SELECT agent_id, status, progress -> 'pendingEffect' AS pending_effect
     FROM occ.agent_provisioning_work WHERE work_id = $1`,
    [admitted.data.provisioning.workId],
  );
  assert.equal(pending.rowCount, 1);
  const row = required(pending.rows[0]);
  const effect = readPendingEffect(row.pending_effect);
  assert.equal(row.status, "running");
  assert.equal(effect.kind, "transport");
  assert.equal(effect.targetId, row.agent_id);
  return {
    namespace,
    admitted,
    agentId: required(row.agent_id),
    pendingEffect: effect,
  };
}

async function provisioningJob(pool: pg.Pool, workId: string) {
  const result = await pool.query<{
    agent_id: string | null;
    status: AgentProvisioningRecord["status"];
    completed_phase: ProvisioningPhase;
    revision_id: string | null;
    work_state: ControllerWorkState;
    reason_code: string | null;
  }>(
    `SELECT provisioning.agent_id, provisioning.status, provisioning.completed_phase,
            provisioning.revision_id, work.state AS work_state, work.reason_code
     FROM occ.agent_provisioning_work AS provisioning
     JOIN occ.controller_work AS work ON work.idempotency_key = provisioning.work_id
     WHERE provisioning.work_id = $1`,
    [workId],
  );
  assert.equal(result.rowCount, 1);
  return required(result.rows[0]);
}

async function handoffCheckpoints(pool: pg.Pool, workId: string) {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT 1 FROM occ.audit_events
     WHERE action = 'openclaw.agents.provision.checkpoint'
       AND details->>'workId' = $1
       AND details->>'phase' = 'handoff'`,
    [workId],
  );
  return result.rowCount;
}

export function registerStopAndDeleteCases() {
  test(
    "Stop and Delete cancel failed pre-handoff provisioning Agents without deployment resurrection",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      let reportStoredCredentials = false;
      const stopFixture = await createFixture(context, {
        computeDriver: failingTransportDriver(() => reportStoredCredentials),
      });
      const stopTarget = await createFailedPreHandoffAgent(stopFixture);
      const stopped = await stopFixture.requestChecked(
        AgentResponse,
        "POST",
        `/namespaces/${stopTarget.namespace.id}/agents/${stopTarget.failed.agentId}/stop`,
      );
      assert.equal(stopped.status, 202, JSON.stringify(stopped.body));
      assert.equal(stopped.data.desiredRuntimeState, "stopped");
      const stoppedProvisioning = await stopFixture.requestChecked(
        AgentProvisioningStatusResponse,
        "GET",
        stopTarget.admitted.data.provisioning.url,
      );
      assert.equal(stoppedProvisioning.status, 200, JSON.stringify(stoppedProvisioning.body));
      assert.equal(stoppedProvisioning.data.status, "failed");
      assert.equal(stoppedProvisioning.data.error?.code, "PROVISIONING_CANCELLED");
      // The status names the Stop: the stopped Agent keeps its name, so it must not say to
      // create a new Agent (finding 1376).
      assert.equal(
        stoppedProvisioning.data.error?.message,
        "Provisioning was cancelled because the Agent was stopped.",
      );
      await assertCancellationAudit(stopFixture, stopTarget, "stop", stopped.body.meta.requestId);

      await settleLateTransport(stopFixture, stopTarget);
      reportStoredCredentials = true;
      const deployed = await stopFixture.requestChecked(
        AgentRevisionResponse,
        "POST",
        `/namespaces/${stopTarget.namespace.id}/agents/${stopTarget.failed.agentId}/deploy`,
      );
      assert.equal(deployed.status, 202, JSON.stringify(deployed.body));
      assert.equal(deployed.data.id?.startsWith("rev_"), true);
      stopFixture.cancelProvisioningAtTeardown(stopTarget.namespace.id, stopTarget.failed.agentId);

      const deleteFixture = await createFixture(context, {
        computeDriver: failingTransportDriver(),
      });
      const deleteTarget = await createFailedPreHandoffAgent(deleteFixture);
      const deleting = await deleteFixture.requestChecked(
        AgentResponse,
        "DELETE",
        `/namespaces/${deleteTarget.namespace.id}/agents/${deleteTarget.failed.agentId}`,
      );
      assert.equal(deleting.status, 202, JSON.stringify(deleting.body));
      assert.equal(deleting.data.status, "deleting");
      const deletedProvisioning = await deleteFixture.requestChecked(
        AgentProvisioningStatusResponse,
        "GET",
        deleteTarget.admitted.data.provisioning.url,
      );
      assert.equal(deletedProvisioning.status, 200, JSON.stringify(deletedProvisioning.body));
      assert.equal(deletedProvisioning.data.status, "failed");
      assert.equal(deletedProvisioning.data.error?.code, "PROVISIONING_CANCELLED");
      assert.equal(
        deletedProvisioning.data.error?.message,
        "Provisioning was cancelled because the Agent was deleted.",
      );
      await assertCancellationAudit(
        deleteFixture,
        deleteTarget,
        "delete",
        deleting.body.meta.requestId,
      );

      await settleLateTransport(deleteFixture, deleteTarget);
      const deletedAgent = await deleteFixture.requestChecked(
        AgentReadResponse,
        "GET",
        `/namespaces/${deleteTarget.namespace.id}/agents/${deleteTarget.failed.agentId}`,
      );
      assert.equal(deletedAgent.status, 200, JSON.stringify(deletedAgent.body));
      assert.equal(deletedAgent.data.status, "deleting");
      const blockedDeploy = await deleteFixture.request(
        "POST",
        `/namespaces/${deleteTarget.namespace.id}/agents/${deleteTarget.failed.agentId}/deploy`,
      );
      assert.equal(blockedDeploy.status, 409, JSON.stringify(blockedDeploy.body));
    },
  );

  test(
    "Delete finishes after failed pre-handoff provisioning leaves its effect unsettled",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const computeDriver = failingTransportDriver();
      const fixture = await createFixture(context, { computeDriver, leaseDurationMs: 3_000 });
      const target = await createFailedPreHandoffAgent(fixture);
      const agentPath = `/namespaces/${target.namespace.id}/agents/${target.failed.agentId}`;
      const deleting = await fixture.request("DELETE", agentPath);
      assert.equal(deleting.status, 202, JSON.stringify(deleting.body));

      // Nothing settles a cancelled effect, so deletion itself must resolve it,
      // but only after a lease has passed since the cancellation.
      await fixture.startWorker();
      try {
        await waitFor("the Agent deletion to wait out the provisioning lease", async () => {
          const deferred = await fixture.pool.query<Record<string, unknown>>(
            `SELECT 1 FROM occ.audit_events
             WHERE action = 'reconcile' AND resource_kind = 'agent' AND resource_id = $1
               AND details->>'reasonCode' = 'PROVISIONING_EFFECT_PENDING'`,
            [target.failed.agentId],
          );
          return (deferred.rowCount ?? 0) > 0 ? true : undefined;
        });
        assert.equal(
          computeDriver.calls.some(
            ({ operation, agentId }) =>
              operation === "deleteAgentRuntimeCredentials" && agentId === target.failed.agentId,
          ),
          false,
        );
        await waitFor(
          "the Agent deletion to finish",
          async () => {
            const observed = await fixture.request("GET", agentPath);
            if (observed.status === 404) {
              return true;
            }
            assert.equal(observed.status, 200, JSON.stringify(observed.body));
            const work = await fixture.pool.query<{
              state: ControllerWorkState;
              reason_code: string | null;
            }>(
              `SELECT state, reason_code FROM occ.controller_work
               WHERE namespace_id = $1 AND agent_id = $2 AND agent_target = 'deleted'`,
              [target.namespace.id, target.failed.agentId],
            );
            assert.notEqual(work.rows[0]?.state, "failed_permanent", JSON.stringify(work.rows));
            return undefined;
          },
          20_000,
        );
      } finally {
        await fixture.stopWorker();
      }
      // The shared database may hold other tests' deleting Agents; count only this one.
      assert.equal(
        computeDriver.calls.filter(
          ({ operation, agentId }) =>
            operation === "deleteAgentRuntimeCredentials" && agentId === target.failed.agentId,
        ).length,
        1,
      );
      const provisioning = await fixture.pool.query<Record<string, unknown>>(
        "SELECT 1 FROM occ.agent_provisioning_work WHERE work_id = $1",
        [target.admitted.data.provisioning.workId],
      );
      assert.equal(provisioning.rowCount, 0);
      const agents = await fixture.pool.query<Record<string, unknown>>(
        "SELECT 1 FROM occ.agents WHERE namespace_id = $1",
        [target.namespace.id],
      );
      assert.equal(agents.rowCount, 0, "no Agent may keep the Namespace non-empty");
    },
  );
}

export function registerTransportCases() {
  const cancelledWriteMessage =
    "The Agent's cancelled provisioning may still be writing its runtime credentials. Try again in a few seconds, or delete the Agent.";

  test(
    "Stop during an interrupted runtime-credential write lets the Agent deploy once the claim's lease ends",
    { ...requiresPostgres, timeout: 90_000 },
    async (context) => {
      let writing = false;
      let interrupted = false;
      // The write ends only when the worker aborts it: after Stop its heartbeat finds the claim
      // gone. Like a crash or an exhausted unknown outcome, it never confirms, so no receipt exists.
      const computeDriver = heldTransportDriver(async () => {
        writing = true;
        const signal = currentComputeAbortSignal();
        assert.ok(signal, "the worker must run the write under its claim's abort signal");
        if (!signal.aborted) {
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        }
        interrupted = true;
        throw new Error("synthetic runtime-credential write interrupted by claim loss");
      });
      const fixture = await createFixture(context, { computeDriver, leaseDurationMs: 3_000 });
      let target: Awaited<ReturnType<typeof provisionUntilTransportWrite>> | undefined;
      let agentPath: string;
      try {
        target = await provisionUntilTransportWrite(fixture, () => writing);
        agentPath = `/namespaces/${target.namespace.id}/agents/${target.agentId}`;
        const stopped = await fixture.requestChecked(AgentResponse, "POST", `${agentPath}/stop`);
        assert.equal(stopped.status, 202, JSON.stringify(stopped.body));

        // Until the cancelled claim's lease runs out its write may still land, so Deploy is
        // refused. The text says to wait or delete: a cancelled job cannot be retried.
        const early = await fixture.request("POST", `${agentPath}/deploy`);
        assert.equal(early.status, 409, JSON.stringify(early.body));
        assert.equal(provisioningError(early).message, cancelledWriteMessage);
        await waitFor("the worker to abort the write after losing its claim", async () =>
          interrupted ? true : undefined,
        );
      } finally {
        await fixture.stopWorker();
      }
      const { workId, url } = target.admitted.data.provisioning;
      assert.equal(required(await provisioningEffectState(fixture.pool, workId)).receipt, null);

      // Nothing else will settle the write (finding 1384). Once the lease has passed, Deploy
      // settles it itself and admits the first revision, with no worker and no manual repair.
      const deployed = await waitFor(
        "Deploy to settle the abandoned write after the claim's lease",
        async () => {
          const attempt = await fixture.request("POST", `${agentPath}/deploy`);
          if (attempt.status === 409) {
            assert.equal(provisioningError(attempt).message, cancelledWriteMessage);
            return undefined;
          }
          return fixture.readResponse(AgentRevisionResponse, attempt);
        },
        20_000,
      );
      assert.equal(deployed.status, 202, JSON.stringify(deployed.body));
      assert.equal(deployed.data.id?.startsWith("rev_"), true);
      fixture.cancelProvisioningAtTeardown(target.namespace.id, target.agentId);

      // The interrupted write stored nothing; deploy admission created the runtime credentials.
      assert.equal(
        computeDriver.calls.filter(
          ({ operation, agentId }) =>
            operation === "provisionAgentRuntimeCredentials" && agentId === target.agentId,
        ).length,
        1,
      );
      assert.deepEqual(
        await computeDriver.getAgentRuntimeCredentialStatus({
          namespace: required(
            await fixture.state.read((view) => view.namespaces.findNamespace(target.namespace.id)),
          ),
          agent: required(
            await fixture.state.read((view) =>
              view.agents.findAgent(target.namespace.id, target.agentId),
            ),
          ),
        }),
        { transportConfigured: true },
      );
      // The job stays cancelled and never hands off; its receipt names the exact abandoned write.
      const settled = required(await provisioningEffectState(fixture.pool, workId));
      assert.equal(settled.status, "cancelled");
      assert.equal(settled.revision_id, null);
      assert.deepEqual(settled.receipt, {
        kind: "transport",
        owner: required(target.pendingEffect.owner),
        targetId: target.agentId,
      });
      const status = await fixture.requestChecked(AgentProvisioningStatusResponse, "GET", url);
      assert.equal(status.status, 200, JSON.stringify(status.body));
      assert.equal(status.data.status, "failed");
      assert.equal(status.data.error?.code, "PROVISIONING_CANCELLED");
    },
  );

  test(
    "Stop after failed provisioning left its runtime-credential write unsettled lets the Agent deploy",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      let reportStoredCredentials = false;
      // The default 30 s lease: no wait is needed, because no worker held the failed job's claim.
      const fixture = await createFixture(context, {
        computeDriver: failingTransportDriver(() => reportStoredCredentials),
      });
      const target = await createFailedPreHandoffAgent(fixture);
      const agentPath = `/namespaces/${target.namespace.id}/agents/${target.failed.agentId}`;
      const stopped = await fixture.requestChecked(AgentResponse, "POST", `${agentPath}/stop`);
      assert.equal(stopped.status, 202, JSON.stringify(stopped.body));

      // Every attempt's write had ended before the job failed, so Deploy settles the pending
      // write at once instead of refusing with 409 forever (finding 1384). The failed write had
      // stored the credentials, and deploy admission now observes them.
      reportStoredCredentials = true;
      const deployed = await fixture.requestChecked(
        AgentRevisionResponse,
        "POST",
        `${agentPath}/deploy`,
      );
      assert.equal(deployed.status, 202, JSON.stringify(deployed.body));
      assert.equal(deployed.data.id?.startsWith("rev_"), true);
      fixture.cancelProvisioningAtTeardown(target.namespace.id, target.failed.agentId);
      const settled = required(
        await provisioningEffectState(fixture.pool, target.admitted.data.provisioning.workId),
      );
      assert.equal(settled.status, "cancelled");
      assert.equal(settled.revision_id, null);
      assert.deepEqual(settled.receipt, {
        kind: "transport",
        owner: required(target.pendingEffect.owner),
        targetId: target.failed.agentId,
      });
    },
  );

  test(
    "Stop before admission cancels provisioning while a worker holds its claim, and a Deploy right after waits for the write",
    { ...requiresPostgres, timeout: 90_000 },
    async (context) => {
      let writing = false;
      const { promise: writeReleased, resolve: releaseWrite } = Promise.withResolvers<void>();
      const computeDriver = heldTransportDriver(async () => {
        writing = true;
        await writeReleased;
      });
      // The default 30 s lease keeps the cancelled claim's write window open for the whole test.
      const fixture = await createFixture(context, { computeDriver });
      let target: Awaited<ReturnType<typeof provisionUntilTransportWrite>> | undefined;
      let revisionId: string | undefined;
      try {
        target = await provisionUntilTransportWrite(fixture, () => writing);
        const { workId, url } = target.admitted.data.provisioning;
        const agentPath = `/namespaces/${target.namespace.id}/agents/${target.agentId}`;
        const stopped = await fixture.requestChecked(AgentResponse, "POST", `${agentPath}/stop`);
        assert.equal(stopped.status, 202, JSON.stringify(stopped.body));
        assert.equal(stopped.data.desiredRuntimeState, "stopped");
        // Stop cancels the job at once, though the worker is still inside its attempt.
        const cancelled = await fixture.requestChecked(AgentProvisioningStatusResponse, "GET", url);
        assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
        assert.equal(cancelled.data.status, "failed");
        assert.equal(cancelled.data.error?.code, "PROVISIONING_CANCELLED");
        assert.equal(cancelled.data.revisionId, undefined);

        // Stop names the in-flight attempt, even though the external write has yet to finish.
        const linked = await fixture.pool.query<{ resource_id: string; request_id: string | null }>(
          `SELECT cancellation.resource_id, cancellation.details->'__occAuditMetadata'->>'requestId' AS request_id
           FROM occ.audit_events AS cancellation
           JOIN occ.audit_events AS claim ON claim.id = cancellation.details->>'attemptId'
           WHERE cancellation.action = 'openclaw.agents.provision.cancelled'
             AND cancellation.details->>'workId' = $1 AND claim.details->>'workId' = $1
             AND claim.action = 'openclaw.controller_work.claimed'`,
          [workId],
        );
        assert.deepEqual(linked.rows, [
          { resource_id: target.agentId, request_id: stopped.body.meta.requestId },
        ]);

        // A Deploy right after the Stop, while the live worker's write is in flight, is refused:
        // the write's outcome is still unknown.
        const early = await fixture.request("POST", `${agentPath}/deploy`);
        assert.equal(early.status, 409, JSON.stringify(early.body));

        // The write completes and records its receipt without the claim. The worker's next
        // fence then fails, so it cannot hand off a deployment for the stopped Agent.
        releaseWrite();
        await waitFor("the late write to record its receipt", async () => {
          const state = required(await provisioningEffectState(fixture.pool, workId));
          return state.receipt === null ? undefined : state;
        });
        const deployed = await fixture.requestChecked(
          AgentRevisionResponse,
          "POST",
          `${agentPath}/deploy`,
        );
        assert.equal(deployed.status, 202, JSON.stringify(deployed.body));
        revisionId = deployed.data.id;
        fixture.cancelProvisioningAtTeardown(target.namespace.id, target.agentId);
      } finally {
        releaseWrite();
        // Waits for the worker's pass, so its stale attempt has ended before the checks below.
        await fixture.stopWorker();
      }

      // The owner's Deploy admitted the only revision; the cancelled job never reached handoff.
      const revisions = await fixture.state.read((view) =>
        view.revisions.listRevisions(target.namespace.id, target.agentId),
      );
      assert.deepEqual(
        revisions.map(({ id }) => id),
        [revisionId],
      );
      const job = required(
        await provisioningEffectState(fixture.pool, target.admitted.data.provisioning.workId),
      );
      assert.equal(job.status, "cancelled");
      assert.equal(job.revision_id, null);
      assert.equal(job.completed_phase, "configuration");
      // The late write stored the credentials, so deploy admission did not write them again.
      assert.equal(
        computeDriver.calls.filter(
          ({ operation, agentId }) =>
            operation === "provisionAgentRuntimeCredentials" && agentId === target.agentId,
        ).length,
        1,
      );
    },
  );

  test(
    "Delete after the first deployment's admission waits for provisioning to finish, then removes it",
    { ...requiresPostgres, timeout: 90_000 },
    async (context) => {
      let firstRevisionId: string | undefined;
      const computeDriver = createRuntimeComputeDriver();
      const prepareRevision = computeDriver.prepareRevision.bind(computeDriver);
      // Keep the first revision unready, so provisioning is still watching it when Delete arrives.
      computeDriver.prepareRevision = async (revision, operationContext) => ({
        ...(await prepareRevision(revision, operationContext)),
        ready: firstRevisionId !== undefined && revision.id !== firstRevisionId,
      });
      const fixture = await createFixture(context, { computeDriver });
      const namespace = await fixture.bootstrapNamespace();
      const secrets = await createProvisioningSecrets(fixture, namespace.id);
      const admitted = await requestAcceptedProvisioning(fixture, namespace.id, secrets);
      const { workId, url } = admitted.data.provisioning;
      let handoff: ReturnType<typeof handedOff>;
      await fixture.startWorker();
      try {
        handoff = await waitFor("the first deployment to be admitted", async () => {
          const observed = await fixture.requestChecked(
            AgentProvisioningStatusResponse,
            "GET",
            url,
          );
          assert.equal(observed.status, 200, JSON.stringify(observed.body));
          return observed.data.revisionId !== undefined ? handedOff(observed.data) : undefined;
        });
        firstRevisionId = handoff.revisionId;
        const agentPath = `/namespaces/${namespace.id}/agents/${handoff.agentId}`;
        const deleting = await fixture.requestChecked(AgentResponse, "DELETE", agentPath);
        assert.equal(deleting.status, 202, JSON.stringify(deleting.body));
        assert.equal(deleting.data.status, "deleting");

        // Deletion stops the first rollout. The deletion finalizer refuses while the job is still
        // running, so the Agent goes away only after provisioning records its own outcome.
        await waitFor(
          "the Agent deletion to finish",
          async () => {
            const observed = await fixture.request("GET", agentPath);
            if (observed.status === 404) {
              return true;
            }
            assert.equal(observed.status, 200, JSON.stringify(observed.body));
            assert.equal(fixture.readResponse(AgentReadResponse, observed).data.status, "deleting");
            return undefined;
          },
          45_000,
        );
      } finally {
        await fixture.stopWorker();
      }

      // The job recorded the stopped rollout's outcome. Its failure audit commits only with the
      // job's own row, so the job finished before deletion removed it with the Agent.
      const outcomes = await fixture.pool.query<{
        action: string;
        code: string | null;
        reason_code: string | null;
      }>(
        `SELECT action, details->>'code' AS code, details->>'reasonCode' AS reason_code
         FROM occ.audit_events
         WHERE namespace_id = $1
           AND (
             (action = 'openclaw.agents.provision.failure' AND details->>'workId' = $2)
             OR (
               action = 'openclaw.agents.lifecycle.delete'
               AND resource_id = $3
               AND outcome = 'success'
             )
           )
         ORDER BY action`,
        [namespace.id, workId, handoff.agentId],
      );
      assert.deepEqual(
        outcomes.rows.map(({ action, code, reason_code: reasonCode }) => [
          action,
          code ?? reasonCode,
        ]),
        [
          ["openclaw.agents.lifecycle.delete", "AGENT_DELETED"],
          ["openclaw.agents.provision.failure", "REVISION_STOPPED"],
        ],
      );
      const remaining = await fixture.pool.query<{ jobs: number; work: number; revisions: number }>(
        `SELECT
           (SELECT count(*) FROM occ.agent_provisioning_work WHERE work_id = $1)::int AS jobs,
           (SELECT count(*) FROM occ.controller_work WHERE idempotency_key = $1)::int AS work,
           (SELECT count(*) FROM occ.agent_revisions
             WHERE namespace_id = $2 AND agent_id = $3)::int AS revisions`,
        [workId, namespace.id, handoff.agentId],
      );
      assert.deepEqual(remaining.rows, [{ jobs: 0, work: 0, revisions: 0 }]);
      assert.equal(
        computeDriver.calls.some(
          ({ operation, agentId }) =>
            operation === "deleteAgentRuntimeCredentials" && agentId === handoff.agentId,
        ),
        true,
      );
    },
  );
}

export function registerDeploymentHandoffCases() {
  test(
    "a provisioning handoff that takes the Namespace lock before Stop admits its deployment, which Stop then ends",
    { ...requiresPostgres, timeout: 90_000 },
    async (context) => {
      // Namespace bootstrap starts the worker before this test has admitted a provisioning job.
      const observed: { target?: Awaited<ReturnType<typeof admitProvisioning>> } = {};
      let handoffPid: number | undefined;
      let admitting = false;
      const { promise: admissionReleased, resolve: releaseAdmission } =
        Promise.withResolvers<void>();
      const computeDriver = createRuntimeComputeDriver();
      const prepareRevision = computeDriver.prepareRevision.bind(computeDriver);
      // The first deployment never becomes ready, so only the Stop can end it.
      computeDriver.prepareRevision = async (revision, operationContext) => ({
        ...(await prepareRevision(revision, operationContext)),
        ready: false,
      });
      // The handoff's deploy admission checks the runtime credentials while its transaction holds
      // the Namespace and Agent locks. Holding that check holds the handoff with its locks.
      const getRuntimeCredentialStatus = computeDriver.getAgentRuntimeCredentialStatus;
      computeDriver.getAgentRuntimeCredentialStatus = async (binding) => {
        if (!admitting && binding.namespace.id === observed.target?.namespace.id) {
          admitting = true;
          await admissionReleased;
        }
        return getRuntimeCredentialStatus(binding);
      };
      const fixture = await createFixture(context, {
        computeDriver,
        // The worker is serial, so its latest Namespace lock is the held handoff's own.
        beforeWorkerStatement: (statement, values, backendPid) => {
          const target = observed.target;
          if (
            target !== undefined &&
            values?.[0] === target.namespace.id &&
            namespaceLockStatement.test(statement)
          ) {
            handoffPid = backendPid;
          }
        },
      });
      const target = await admitProvisioning(fixture);
      observed.target = target;
      const { namespace, provisioning } = target;
      const { workId, url } = provisioning;
      let stopping:
        Promise<{ status: number; body: unknown; data: AgentResponse["data"] }> | undefined;
      await fixture.startWorker();
      try {
        await waitFor("the handoff to hold its deploy admission", async () =>
          admitting ? true : undefined,
        );
        assert.ok(handoffPid, "the handoff must have taken the Namespace lock");
        const job = await provisioningJob(fixture.pool, workId);
        assert.equal(job.completed_phase, "transport");
        assert.equal(job.revision_id, null);
        fixture.cancelProvisioningAtTeardown(namespace.id, required(job.agent_id));
        const agentPath = `/namespaces/${namespace.id}/agents/${job.agent_id}`;
        stopping = fixture.requestChecked(AgentResponse, "POST", `${agentPath}/stop`);
        // Surface an early failure through the await below instead of an unhandled rejection.
        stopping.catch(() => {});
        await waitForLockWaiter(
          fixture.pool,
          handoffPid,
          "Stop to wait on the handoff's Namespace lock",
        );
        releaseAdmission();
        const stopped = await required(stopping);
        assert.equal(stopped.status, 202, JSON.stringify(stopped.body));
        assert.equal(stopped.data.desiredRuntimeState, "stopped");

        // The handoff committed first, so Stop's cancellation skipped the job, which now has a
        // revision. Stop ends that first deployment instead, and the job records the outcome.
        const settled = await waitFor(
          "initial provisioning to settle",
          async () => {
            const observed = await fixture.requestChecked(
              AgentProvisioningStatusResponse,
              "GET",
              url,
            );
            assert.equal(observed.status, 200, JSON.stringify(observed.body));
            return ["succeeded", "failed"].includes(observed.data.status)
              ? observed.data
              : undefined;
          },
          30_000,
        );
        assert.equal(settled.status, "failed", JSON.stringify(settled));
        assert.equal(settled.agentId, job.agent_id);
        assert.equal(settled.revisionId?.startsWith("rev_"), true, JSON.stringify(settled));
        assert.deepEqual(settled.error, {
          code: "REVISION_STOPPED",
          message: "The Agent was stopped before its first deployment finished.",
        });
        const first = await fixture.requestChecked(
          AgentDeploymentStatusResponse,
          "GET",
          `${agentPath}/deployments/${settled.revisionId}`,
        );
        assert.equal(first.status, 200, JSON.stringify(first.body));
        assert.equal(first.data.error?.code, "REVISION_STOPPED");
        const finished = await provisioningJob(fixture.pool, workId);
        assert.deepEqual(
          [finished.status, finished.revision_id, finished.work_state, finished.reason_code],
          ["failed", settled.revisionId, "failed_permanent", "REVISION_STOPPED"],
        );
        assert.equal(await handoffCheckpoints(fixture.pool, workId), 1);
        const revisions = await fixture.state.read((view) =>
          view.revisions.listRevisions(namespace.id, required(job.agent_id)),
        );
        assert.deepEqual(
          revisions.map(({ id }) => id),
          [settled.revisionId],
        );
      } finally {
        releaseAdmission();
        await stopping?.catch(() => {});
        await fixture.stopWorker();
      }
    },
  );

  test(
    "Stop that takes the Namespace lock before a waiting provisioning handoff rolls the whole handoff back",
    { ...requiresPostgres, timeout: 90_000 },
    async (context) => {
      // Namespace bootstrap starts the worker before this test has admitted a provisioning job.
      const observed: { target?: Awaited<ReturnType<typeof admitProvisioning>> } = {};
      let handoffPid: number | undefined;
      const { promise: handoffReleased, resolve: releaseHandoff } = Promise.withResolvers<void>();
      const events: WorkerEvent[] = [];
      const fixture = await createFixture(context, {
        onWorkerEvent: (event) => events.push(event),
        // Pause the handoff transaction just before it locks the Namespace: the first attempt's
        // first Namespace lock once the transport checkpoint has committed. By then the
        // transaction has already read the job as running.
        beforeWorkerStatement: async (statement, values, backendPid) => {
          const target = observed.target;
          if (
            handoffPid !== undefined ||
            target === undefined ||
            values?.[0] !== target.namespace.id ||
            !namespaceLockStatement.test(statement) ||
            events.some(
              (event) =>
                event.event === "worker.completed" && event.workId === target.provisioning.workId,
            )
          ) {
            return;
          }
          const job = await fixture.pool.query<{ completed_phase: ProvisioningPhase }>(
            "SELECT completed_phase FROM occ.agent_provisioning_work WHERE work_id = $1",
            [target.provisioning.workId],
          );
          if (job.rows[0]?.completed_phase !== "transport") {
            return;
          }
          handoffPid = backendPid;
          await handoffReleased;
        },
      });
      const target = await admitProvisioning(fixture);
      observed.target = target;
      const { namespace, provisioning } = target;
      const { workId, url } = provisioning;
      const stop: {
        pending?: Promise<{ status: number; body: unknown; data: AgentResponse["data"] }>;
      } = {};
      await fixture.startWorker();
      try {
        await waitFor("the handoff to reach its Namespace lock", async () => handoffPid);
        const job = await provisioningJob(fixture.pool, workId);
        assert.deepEqual(
          [job.status, job.completed_phase, job.revision_id],
          ["running", "transport", null],
        );
        const agentPath = `/namespaces/${namespace.id}/agents/${job.agent_id}`;
        // A lock held from a test connection orders the two waiters: Stop queues first, then the
        // handoff. PostgreSQL grants a row lock to its waiters in the order they queued.
        await withNamespaceLockHeld(fixture.pool, namespace.id, async (lock) => {
          stop.pending = fixture.requestChecked(AgentResponse, "POST", `${agentPath}/stop`);
          // Surface an early failure through the await below instead of an unhandled rejection.
          stop.pending.catch(() => {});
          await lock.waitForBlocked("Stop to wait on the Namespace lock");
          releaseHandoff();
          await waitFor("the handoff to queue behind Stop for the Namespace lock", async () => {
            const backend = await fixture.pool.query<{ wait_event_type: string | null }>(
              "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
              [handoffPid],
            );
            return backend.rows[0]?.wait_event_type === "Lock" ? true : undefined;
          });
        });
        const stopped = await required(stop.pending);
        assert.equal(stopped.status, 202, JSON.stringify(stopped.body));
        assert.equal(stopped.data.desiredRuntimeState, "stopped");
        // Stop cancelled the job before the handoff got the lock, so the handoff's checkpoint
        // refuses the cancelled job and its pass ends without a deployment.
        await waitFor("the handoff's pass to end cancelled", async () =>
          events.some(
            (event) =>
              event.event === "worker.completed" &&
              event.workId === workId &&
              event.code === "PROVISIONING_CANCELLED",
          )
            ? true
            : undefined,
        );
      } finally {
        releaseHandoff();
        await stop.pending?.catch(() => {});
        await fixture.stopWorker();
      }

      // The whole handoff rolled back: no revision, no handoff checkpoint, and the job stays
      // cancelled at the transport phase it had completed.
      const finished = await provisioningJob(fixture.pool, workId);
      assert.deepEqual(
        [
          finished.status,
          finished.completed_phase,
          finished.revision_id,
          finished.work_state,
          finished.reason_code,
        ],
        ["cancelled", "transport", null, "failed_permanent", "PROVISIONING_CANCELLED"],
      );
      assert.equal(await handoffCheckpoints(fixture.pool, workId), 0);
      const revisions = await fixture.state.read((view) =>
        view.revisions.listRevisions(namespace.id, required(finished.agent_id)),
      );
      assert.deepEqual(revisions, []);
      const status = await fixture.requestChecked(AgentProvisioningStatusResponse, "GET", url);
      assert.equal(status.status, 200, JSON.stringify(status.body));
      assert.equal(status.data.status, "failed");
      assert.equal(status.data.error?.code, "PROVISIONING_CANCELLED");
      assert.equal(status.data.revisionId, undefined);
    },
  );

  test(
    "Delete before admission cancels provisioning while a worker holds its claim, and finishes without a deployment",
    { ...requiresPostgres, timeout: 90_000 },
    async (context) => {
      let writing = false;
      const { promise: writeReleased, resolve: releaseWrite } = Promise.withResolvers<void>();
      const computeDriver = heldTransportDriver(async () => {
        writing = true;
        await writeReleased;
      });
      const fixture = await createFixture(context, { computeDriver });
      let target: Awaited<ReturnType<typeof provisionUntilTransportWrite>> | undefined;
      let configurationId: string | null | undefined;
      try {
        target = await provisionUntilTransportWrite(fixture, () => writing);
        const { workId, url } = target.admitted.data.provisioning;
        configurationId = await provisioningConfigurationId(fixture.pool, workId);
        const agentPath = `/namespaces/${target.namespace.id}/agents/${target.agentId}`;
        // Turn collection off in the API while the original worker still holds the audited claim.
        await fixture.restartApi({
          controlPlaneAuditEnabled: false,
          openShellRuntimeAuditAdmission: () => undefined,
        });
        // Sender configuration alone cannot expose the runtime audit route.
        const auditOff = await fixture.request("POST", "/internal/runtime-audit", {});
        assert.equal(auditOff.status, 404, JSON.stringify(auditOff.body));
        const deleting = await fixture.requestChecked(AgentResponse, "DELETE", agentPath);
        assert.equal(deleting.status, 202, JSON.stringify(deleting.body));
        assert.equal(deleting.data.status, "deleting");
        // Delete cancels the job at once, though the worker is still inside its attempt.
        const cancelled = await fixture.requestChecked(AgentProvisioningStatusResponse, "GET", url);
        assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
        assert.equal(cancelled.data.status, "failed");
        assert.deepEqual(cancelled.data.error, {
          code: "PROVISIONING_CANCELLED",
          message: "Provisioning was cancelled because the Agent was deleted.",
        });
        assert.equal(cancelled.data.revisionId, undefined);

        // The Delete request emits no request audit rows. It still closes the recorded claim.
        const requestAudit = await fixture.pool.query<{ action: string }>(
          `SELECT action FROM occ.audit_events
           WHERE action IN ('openclaw.api.request.admitted', 'openclaw.api.request.result')
             AND details->'__occAuditMetadata'->>'requestId' = $1`,
          [deleting.body.meta.requestId],
        );
        assert.equal(requestAudit.rowCount, 0);
        const linked = await fixture.pool.query<{ resource_id: string; request_id: string | null }>(
          `SELECT cancellation.resource_id, cancellation.details->'__occAuditMetadata'->>'requestId' AS request_id
           FROM occ.audit_events AS cancellation
           JOIN occ.audit_events AS claim ON claim.id = cancellation.details->>'attemptId'
           WHERE cancellation.action = 'openclaw.agents.provision.cancelled'
             AND cancellation.details->>'workId' = $1 AND claim.details->>'workId' = $1
             AND claim.action = 'openclaw.controller_work.claimed'`,
          [workId],
        );
        assert.deepEqual(linked.rows, [{ resource_id: target.agentId, request_id: null }]);

        // The write completes and records its receipt without the claim. The worker's next fence
        // finds the Agent deleting, so its pass ends before handoff; deletion then finishes.
        releaseWrite();
        await waitFor(
          "the Agent deletion to finish",
          async () => {
            const observed = await fixture.request("GET", agentPath);
            if (observed.status === 404) {
              return true;
            }
            assert.equal(observed.status, 200, JSON.stringify(observed.body));
            assert.equal(fixture.readResponse(AgentReadResponse, observed).data.status, "deleting");
            return undefined;
          },
          45_000,
        );
      } finally {
        releaseWrite();
        await fixture.stopWorker();
      }

      // No deployment was ever admitted for the deleting Agent: the job never checkpointed a
      // handoff, and Compute never prepared a revision for it.
      const { workId } = target.admitted.data.provisioning;
      assert.equal(await handoffCheckpoints(fixture.pool, workId), 0);
      assert.equal(
        computeDriver.calls.some(
          ({ operation, agentId }) => operation === "prepareRevision" && agentId === target.agentId,
        ),
        false,
      );
      // Deletion removed the job, its work and the runtime credentials the write stored.
      const remaining = await fixture.pool.query<{ jobs: number; work: number; revisions: number }>(
        `SELECT
           (SELECT count(*) FROM occ.agent_provisioning_work WHERE work_id = $1)::int AS jobs,
           (SELECT count(*) FROM occ.controller_work WHERE idempotency_key = $1)::int AS work,
           (SELECT count(*) FROM occ.agent_revisions
             WHERE namespace_id = $2 AND agent_id = $3)::int AS revisions`,
        [workId, target.namespace.id, target.agentId],
      );
      assert.deepEqual(remaining.rows, [{ jobs: 0, work: 0, revisions: 0 }]);
      assert.equal(
        computeDriver.calls.filter(
          ({ operation, agentId }) =>
            operation === "deleteAgentRuntimeCredentials" && agentId === target.agentId,
        ).length,
        1,
      );
      // The job's Configuration is no longer reserved, so it deletes like any other.
      const configurationPath = `/namespaces/${target.namespace.id}/configurations/${configurationId}`;
      const removed = await fixture.request("DELETE", configurationPath);
      assert.equal(removed.status, 204, JSON.stringify(removed.body));
      const gone = await fixture.request("GET", configurationPath);
      assert.equal(gone.status, 404, JSON.stringify(gone.body));
    },
  );
}
