import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  AgentDeploymentStatusResponse,
  AgentProvisioningResponse,
  AgentProvisioningStatusResponse,
  AgentRevisionListResponse,
  SecretDetailResponse,
} from "../../packages/contracts/src/api/resources.ts";
import type { ControllerWorkState } from "../../packages/occ/src/index.ts";
import { handedOff, required } from "./postgres-agent-provisioning-setup.ts";

import { provisioningProgress } from "../../packages/occ/src/agent-provisioning.ts";
import { assertApiError } from "../helpers/api-error.ts";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.ts";
import { waitFor } from "../helpers/wait-for.ts";
import { createRuntimeComputeDriver } from "./postgres-agent-provisioning-transport-fixture.ts";

import {
  assertProvisionedSecretAccess,
  claimProvisioningWork,
  createFixture,
  createProvisioningSecrets,
  identifier,
  provisioningBody,
  provisioningError,
  provisioningRow,
  requestAcceptedProvisioning,
  requestId,
  secretRef,
} from "./postgres-agent-provisioning-setup.ts";

export function registerAdmissionCases() {
  test(
    "provisioning API queues one job with existing Secret references and replays only the exact same request",
    requiresPostgres,
    async (context) => {
      const fixture = await createFixture(context);
      const namespace = await fixture.bootstrapNamespace();
      const secrets = await createProvisioningSecrets(fixture, namespace.id);
      const body = provisioningBody(namespace.id, secrets);

      const nativeAdminRefused = await fixture.request(
        "POST",
        `/namespaces/${namespace.id}/agents/provision`,
        {
          body: { ...body, nativeAdmin: true },
        },
      );
      assert.equal(
        nativeAdminRefused.status,
        400,
        "disabled installation refuses native admin opt-in",
      );
      const admitted = await fixture.requestChecked(
        AgentProvisioningResponse,
        "POST",
        `/namespaces/${namespace.id}/agents/provision`,
        {
          body,
        },
      );
      assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
      assert.deepEqual(Object.keys(admitted.data).sort(), ["provisioning"]);
      assert.match(admitted.data.provisioning.workId, /^agent-provisioning:/);
      assert.deepEqual(admitted.data.provisioning, {
        requestId: body.requestId,
        workId: admitted.data.provisioning.workId,
        status: "queued",
        phase: "admitted",
        attemptCount: 0,
        updatedAt: admitted.data.provisioning.updatedAt,
        url: `/namespaces/${namespace.id}/agents/provision/${encodeURIComponent(admitted.data.provisioning.workId)}`,
      });
      assert.equal(Number.isNaN(Date.parse(admitted.data.provisioning.updatedAt)), false);
      const status = await fixture.requestChecked(
        AgentProvisioningStatusResponse,
        "GET",
        `/namespaces/${namespace.id}/agents/provision/${encodeURIComponent(admitted.data.provisioning.workId)}`,
      );
      assert.equal(status.status, 200, JSON.stringify(status.body));
      assert.deepEqual(status.data, admitted.data.provisioning);
      assert.equal(JSON.stringify(admitted.body).includes("model-api-key"), false);
      const audit = await fixture.pool.query<{ action: string; outcome: string; details: unknown }>(
        `SELECT action, outcome, details
         FROM occ.audit_events
         WHERE namespace_id = $1
           AND resource_kind = 'agent'
           AND resource_id = $1
         ORDER BY occurred_at, id`,
        [namespace.id],
      );
      assert.ok(
        (audit.rowCount ?? 0) > 0,
        "provisioning admission must append durable audit evidence",
      );
      // The HTTP request is audited too, keyed by the accepted work item.
      const requestAudit = await fixture.pool.query<{ action: string; outcome: string }>(
        `SELECT action, outcome
         FROM occ.audit_events
         WHERE namespace_id = $1 AND resource_kind = 'agent' AND resource_id = $2`,
        [namespace.id, admitted.data.provisioning.workId],
      );
      assert.deepEqual(requestAudit.rows, [
        { action: "openclaw.agents.provision", outcome: "success" },
      ]);

      const row = await provisioningRow(fixture.pool, namespace.id, body.requestId);
      assert.equal(row.work_id, admitted.data.provisioning.workId);
      assert.equal(row.agent_id, null);
      assert.equal(row.configuration_id, null);
      assert.equal(row.status, "queued");
      assert.equal(row.completed_phase, "admitted");
      assert.equal(row.plan.gatewayManagedMode, true);
      assert.equal(JSON.stringify(row).includes("model-api-key"), false);

      const resources = await fixture.pool.query<{
        agents: number;
        configurations: number;
        secrets: number;
      }>(
        `SELECT
         (SELECT count(*)::integer FROM occ.agents WHERE namespace_id = $1) AS agents,
         (SELECT count(*)::integer FROM occ.configurations WHERE namespace_id = $1) AS configurations,
         (SELECT count(*)::integer FROM occ.secrets WHERE namespace_id = $1) AS secrets`,
        [namespace.id],
      );
      assert.deepEqual(resources.rows[0], {
        agents: 0,
        configurations: 0,
        secrets: 4,
      });

      const replay = await fixture.requestChecked(
        AgentProvisioningResponse,
        "POST",
        `/namespaces/${namespace.id}/agents/provision`,
        {
          body,
        },
      );
      assert.equal(replay.status, 202, JSON.stringify(replay.body));
      assert.equal(replay.data.provisioning.workId, admitted.data.provisioning.workId);

      // Replaying the caller's provisioning key does not enqueue or audit a second job.
      // The queue record identifies the original HTTP request, not the caller's key.
      const queueAudit = await fixture.pool.query<{
        resource_kind: string | null;
        resource_id: string | null;
        request_id: string | null;
      }>(
        `SELECT resource_kind, resource_id, details->'__occAuditMetadata'->>'requestId' AS request_id
         FROM occ.audit_events WHERE action = 'openclaw.controller_work.queued'
           AND details->>'workId' = $1`,
        [admitted.data.provisioning.workId],
      );
      assert.notEqual(admitted.body.meta.requestId, body.requestId);
      assert.deepEqual(queueAudit.rows, [
        {
          resource_kind: "namespace",
          resource_id: namespace.id,
          request_id: admitted.body.meta.requestId,
        },
      ]);

      assert.equal(replay.data.provisioning.requestId, body.requestId);
      // The same actor may submit the same plan twice. Each job reports the request that admitted it.
      const otherId = requestId();
      const other = await fixture.requestChecked(
        AgentProvisioningResponse,
        "POST",
        `/namespaces/${namespace.id}/agents/provision`,
        {
          body: { ...body, requestId: otherId },
        },
      );
      assert.equal(other.status, 202);
      const otherJob = other.data.provisioning;
      fixture.cancelQueuedWorkAtTeardown(otherJob.workId, "Finished the request identity check.");
      assert.equal(otherJob.requestId, otherId);
      assert.notEqual(otherJob.workId, admitted.data.provisioning.workId);
      const otherStatus = await fixture.requestChecked(
        AgentProvisioningStatusResponse,
        "GET",
        otherJob.url,
      );
      assert.equal(otherStatus.status, 200);
      assert.deepEqual(otherStatus.data, otherJob);

      const changed = {
        ...body,
        configuration: {
          ...body.configuration,
          values: { ...body.configuration.values, changed: randomUUID() },
        },
      };
      const rejected = await fixture.request(
        "POST",
        `/namespaces/${namespace.id}/agents/provision`,
        {
          body: changed,
        },
      );
      assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
      assert.equal(provisioningError(rejected).code, "RESOURCE_CONFLICT");

      const cleanupClaim = await claimProvisioningWork(
        fixture.pool,
        admitted.data.provisioning.workId,
      );
      const cancelled = await fixture.state.transact((unit) =>
        unit.provisioning.cancel(cleanupClaim, {
          code: "PROVISIONING_CANCELLED",
          message: "admission-only test completed without worker dispatch",
        }),
      );
      assert.equal(cancelled.status, "cancelled");
    },
  );

  test(
    "provisioning status judges claim liveness by the database clock, not the controller clock",
    requiresPostgres,
    async (context) => {
      const fixture = await createFixture(context);
      const namespace = await fixture.bootstrapNamespace();
      const secrets = await createProvisioningSecrets(fixture, namespace.id);
      const admitted = await requestAcceptedProvisioning(fixture, namespace.id, secrets);
      const { workId } = admitted.data.provisioning;
      const statusPath = `/namespaces/${namespace.id}/agents/provision/${encodeURIComponent(workId)}`;
      const apiStatus = async () => {
        const observed = await fixture.requestChecked(
          AgentProvisioningStatusResponse,
          "GET",
          statusPath,
        );
        assert.equal(observed.status, 200, JSON.stringify(observed.body));
        return observed.data.status;
      };
      // The real State read and status derivation with a controller clock skewed far from
      // PostgreSQL's; the controller route above runs with the real clock (the composed app
      // takes no clock option).
      const statusAt = (instant: string) =>
        fixture.state.read(async (state) => {
          const found = await state.provisioning.findWithWork(workId);
          assert.notEqual(found?.work, undefined, "the provisioning job must join its queue row");
          return provisioningProgress(
            required(found).record,
            required(found).work,
            new Date(instant),
          ).status;
        });
      const setLease = async (interval: string) => {
        const updated = await fixture.pool.query<Record<string, unknown>>(
          `UPDATE occ.controller_work
           SET lease_expires_at = clock_timestamp() + $2::interval
           WHERE idempotency_key = $1 AND state = 'claimed'`,
          [workId, interval],
        );
        assert.equal(updated.rowCount, 1, "test must move the exact claimed lease");
      };

      const claim = await claimProvisioningWork(fixture.pool, workId);
      try {
        assert.equal(await apiStatus(), "running");
        // A controller clock ahead of the lease still reports the live claim.
        assert.equal(await statusAt("2999-01-01T00:00:00Z"), "running");

        // An expired claim is waiting for a new worker, not running.
        await setLease("-1 second");
        assert.equal(await apiStatus(), "queued");
        // A controller clock behind the lease still reports the expired claim as waiting.
        assert.equal(await statusAt("1970-01-01T00:00:00Z"), "queued");
      } finally {
        // Cancel under a live lease so no later worker in this database recovers the job.
        await setLease("10 minutes");
        const cancelled = await fixture.state.transact((unit) =>
          unit.provisioning.cancel(claim, {
            code: "PROVISIONING_CANCELLED",
            message: "lease liveness test completed without worker dispatch",
          }),
        );
        assert.equal(cancelled.status, "cancelled");
      }
    },
  );
}

export function registerHandoffAdmissionCases() {
  for (const authMethod of ["api_key", "codex_pat"] as const) {
    test(
      `${authMethod} provisioning grants existing Secret access and hands off one revision`,
      { ...requiresPostgres, timeout: 60_000 },
      async (context) => {
        let deploymentReady = false;
        const computeDriver = createRuntimeComputeDriver();
        const prepareRevision = computeDriver.prepareRevision.bind(computeDriver);
        computeDriver.prepareRevision = async (...args) => ({
          ...(await prepareRevision(...args)),
          ready: deploymentReady,
        });
        const fixture = await createFixture(context, { computeDriver });
        const namespace = await fixture.bootstrapNamespace();
        const secrets = await createProvisioningSecrets(fixture, namespace.id);
        const secretCreateCallCount = fixture.secretDriver.calls.filter(
          ({ operation }) => operation === "create",
        ).length;
        const body = {
          ...provisioningBody(namespace.id, secrets),
          harnessAuth: { method: authMethod, source: secretRef(namespace.id, secrets.modelKey.id) },
        };
        // Model-only references must obey the same Namespace boundary as channel Secrets.
        const foreign = structuredClone(body);
        foreign.harnessAuth.source.namespaceId = `ns_${randomUUID()}`;
        const denied = await fixture.request(
          "POST",
          `/namespaces/${namespace.id}/agents/provision`,
          {
            body: foreign,
          },
        );
        assertApiError(denied, 400, "INVALID_REQUEST");
        assert.equal(
          provisioningError(denied).message,
          "Secret references cannot cross Namespaces.",
        );
        const jobs = await fixture.pool.query<Record<string, unknown>>(
          "SELECT work_id FROM occ.agent_provisioning_work WHERE namespace_id = $1",
          [namespace.id],
        );
        assert.equal(jobs.rowCount, 0, "foreign model references must not admit provisioning work");
        const admitted = await fixture.requestChecked(
          AgentProvisioningResponse,
          "POST",
          `/namespaces/${namespace.id}/agents/provision`,
          {
            body,
          },
        );
        assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
        // Until the worker runs, the queued plan is a consumer of its Harness Secret, whichever
        // Secret-backed method it uses.
        const pending = await fixture.requestChecked(
          SecretDetailResponse,
          "GET",
          `/namespaces/${namespace.id}/secrets/${secrets.modelKey.id}`,
        );
        assert.equal(pending.status, 200, JSON.stringify(pending.body));
        assert.deepEqual(pending.data.consumers.provisioningRequests, [
          admitted.data.provisioning.workId,
        ]);

        await fixture.startWorker();
        // This suite proves the real API, worker and PostgreSQL lifecycle with its
        // existing development Compute fixture, not Kubernetes or model execution.
        const handoff = await waitFor("initial deployment to remain pending", async () => {
          const observed = await fixture.requestChecked(
            AgentProvisioningStatusResponse,
            "GET",
            admitted.data.provisioning.url,
          );
          assert.equal(observed.status, 200, JSON.stringify(observed.body));
          return observed.data.revisionId !== undefined ? handedOff(observed.data) : undefined;
        });
        assert.notEqual(handoff.status, "succeeded");
        deploymentReady = true;
        const status = await waitFor("Agent provisioning to succeed", async () => {
          const observed = await fixture.requestChecked(
            AgentProvisioningStatusResponse,
            "GET",
            admitted.data.provisioning.url,
          );
          assert.equal(observed.status, 200, JSON.stringify(observed.body));
          if (observed.data.revisionId !== undefined) {
            const deployment = await fixture.requestChecked(
              AgentDeploymentStatusResponse,
              "GET",
              `/namespaces/${namespace.id}/agents/${observed.data.agentId}/deployments/${observed.data.revisionId}`,
            );
            assert.notEqual(deployment.data.status, "failed", JSON.stringify(deployment.body));
          }
          return observed.data.status === "succeeded" ? handedOff(observed.data) : undefined;
        });
        assert.equal(status.status, "succeeded");
        assert.equal(status.agentId, handoff.agentId);
        assert.equal(status.revisionId, handoff.revisionId);
        assert.match(status.agentId, identifier("agt"));
        assert.match(status.configurationId, identifier("cfg"));
        fixture.cancelProvisioningAtTeardown(namespace.id, status.agentId);
        await assertProvisionedSecretAccess(fixture, namespace, status, secretCreateCallCount);
        const revisions = await fixture.state.read((view) =>
          view.revisions.listRevisions(namespace.id, status.agentId),
        );
        assert.equal(revisions.length, 1);
        assert.equal(required(revisions[0]).id, status.revisionId);
        assert.equal(required(revisions[0]).configurationGeneration, 1);
        assert.equal(required(revisions[0]).harnessAuth.method, authMethod);
        const savedAuth = required(revisions[0]).harnessAuth;
        assert.ok("source" in savedAuth);
        assert.deepEqual(savedAuth.source, body.harnessAuth.source);
        assert.deepEqual(
          computeDriver.calls
            .filter(({ operation }) => operation === "provisionAgentRuntimeCredentials")
            .map(({ agentId }) => agentId),
          [status.agentId],
        );

        const work = await fixture.pool.query<{ state: ControllerWorkState }>(
          "SELECT state FROM occ.controller_work WHERE work_kind = 'provisioning' AND namespace_id = $1 AND idempotency_key = $2",
          [namespace.id, admitted.data.provisioning.workId],
        );
        assert.equal(work.rowCount, 1);
        assert.equal(required(work.rows[0]).state, "succeeded");
      },
    );
  }

  test(
    "a provisioning status past handoff names its deployment's wait only to a reader of that deployment",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      // Finding 1634: past handoff the job defers without a lease or spent attempts while its
      // first deployment converges, so status and attemptCount alone read like a job never claimed.
      const computeDriver = createRuntimeComputeDriver();
      const prepareRevision = computeDriver.prepareRevision.bind(computeDriver);
      computeDriver.prepareRevision = async (...args) => ({
        ...(await prepareRevision(...args)),
        ready: false,
      });
      const fixture = await createFixture(context, { computeDriver });
      const namespace = await fixture.bootstrapNamespace();
      const secrets = await createProvisioningSecrets(fixture, namespace.id);
      const admitted = await requestAcceptedProvisioning(fixture, namespace.id, secrets);
      await fixture.startWorker();
      let handoff: ReturnType<typeof handedOff>;
      try {
        // The unready runtime keeps the deployment pending with its own named wait.
        handoff = await waitFor("the first deployment to name its wait", async () => {
          const observed = await fixture.requestChecked(
            AgentProvisioningStatusResponse,
            "GET",
            admitted.data.provisioning.url,
          );
          assert.equal(observed.status, 200, JSON.stringify(observed.body));
          return observed.data.revisionId !== undefined &&
            observed.data.progress?.lastAttempt?.code === "REVISION_INCOMPLETE"
            ? handedOff(observed.data)
            : undefined;
        });
      } finally {
        await fixture.stopWorker();
      }
      fixture.cancelProvisioningAtTeardown(namespace.id, handoff.agentId);
      assert.notEqual(handoff.status, "succeeded");
      assert.equal(required(handoff.progress).phase, "deployment");
      assert.equal(
        required(required(handoff.progress).lastAttempt).message,
        "Waiting for the runtime to become ready.",
      );

      // The deployment's wait needs agent_revision read, which the provisioning read does not
      // check. Without it the job still reads, but names only its own deferral.
      await fixture.pool.query<Record<string, unknown>>(
        `INSERT INTO occ.iam_restrictions (id, namespace_id, action, resource_kind, resource_id)
         VALUES ($1, $2, 'read', 'agent_revision', $3)`,
        [`restriction_${randomUUID()}`, namespace.id, handoff.revisionId],
      );
      const deploymentPath = `/namespaces/${namespace.id}/agents/${handoff.agentId}/deployments/${handoff.revisionId}`;
      assert.equal((await fixture.request("GET", deploymentPath)).status, 403);
      const restricted = await fixture.requestChecked(
        AgentProvisioningStatusResponse,
        "GET",
        admitted.data.provisioning.url,
      );
      assert.equal(restricted.status, 200, JSON.stringify(restricted.body));
      assert.equal(restricted.data.revisionId, handoff.revisionId);
      assert.deepEqual(restricted.data.progress, {
        phase: "deployment",
        lastAttempt: {
          // The job's own deferral is stamped by its last checkpoint.
          at: restricted.data.updatedAt,
          code: "PROVISIONING_DEPLOYMENT_PENDING",
          message: "Waiting for the initial deployment to complete.",
        },
      });

      // Settle the job so no queued work outlives this test in the shared database.
      const stopped = await fixture.request(
        "POST",
        `/namespaces/${namespace.id}/agents/${handoff.agentId}/stop`,
      );
      assert.equal(stopped.status, 202, JSON.stringify(stopped.body));
      await fixture.startWorker();
      try {
        const settled = await waitFor("the stopped provisioning job to settle", async () => {
          const observed = await fixture.requestChecked(
            AgentProvisioningStatusResponse,
            "GET",
            admitted.data.provisioning.url,
          );
          assert.equal(observed.status, 200, JSON.stringify(observed.body));
          return ["succeeded", "failed"].includes(observed.data.status)
            ? handedOff(observed.data)
            : undefined;
        });
        assert.equal(settled.error?.code, "REVISION_STOPPED", JSON.stringify(settled));
        assert.equal(Object.hasOwn(settled, "progress"), false);
      } finally {
        await fixture.stopWorker();
      }
    },
  );

  test(
    "initial provisioning settles when a stop interrupts its first deployment",
    { ...requiresPostgres, timeout: 90_000 },
    async (context) => {
      let firstRevisionId: string | undefined;
      const computeDriver = createRuntimeComputeDriver();
      const prepareRevision = computeDriver.prepareRevision.bind(computeDriver);
      // Keep the first revision unready until the owner stops the Agent.
      computeDriver.prepareRevision = async (revision, operationContext) => ({
        ...(await prepareRevision(revision, operationContext)),
        ready: firstRevisionId !== undefined && revision.id !== firstRevisionId,
      });
      const fixture = await createFixture(context, { computeDriver });
      const namespace = await fixture.bootstrapNamespace();
      const secrets = await createProvisioningSecrets(fixture, namespace.id);
      const admitted = await requestAcceptedProvisioning(fixture, namespace.id, secrets);
      await fixture.startWorker();
      try {
        const handoff = await waitFor("the first deployment to be admitted", async () => {
          const observed = await fixture.requestChecked(
            AgentProvisioningStatusResponse,
            "GET",
            admitted.data.provisioning.url,
          );
          assert.equal(observed.status, 200, JSON.stringify(observed.body));
          return observed.data.revisionId !== undefined ? handedOff(observed.data) : undefined;
        });
        firstRevisionId = handoff.revisionId;
        fixture.cancelProvisioningAtTeardown(namespace.id, handoff.agentId);
        const agentPath = `/namespaces/${namespace.id}/agents/${handoff.agentId}`;
        const stopped = await fixture.request("POST", `${agentPath}/stop`);
        assert.equal(stopped.status, 202, JSON.stringify(stopped.body));

        const settled = await waitFor("initial provisioning to settle", async () => {
          const observed = await fixture.requestChecked(
            AgentProvisioningStatusResponse,
            "GET",
            admitted.data.provisioning.url,
          );
          assert.equal(observed.status, 200, JSON.stringify(observed.body));
          return ["succeeded", "failed"].includes(observed.data.status)
            ? handedOff(observed.data)
            : undefined;
        });
        const first = await fixture.requestChecked(
          AgentDeploymentStatusResponse,
          "GET",
          `${agentPath}/deployments/${handoff.revisionId}`,
        );
        assert.equal(first.status, 200, JSON.stringify(first.body));
        assert.equal(first.data.error?.code, "REVISION_STOPPED");
        assert.equal(first.data.status, "failed");
        // The Versions list carries that outcome with the record's code. A Stop ended the version;
        // it did not fail, so the console shows no Failed mark on it after a reload (finding 2422).
        const listed = await fixture.requestChecked(
          AgentRevisionListResponse,
          "GET",
          `${agentPath}/revisions`,
        );
        assert.equal(listed.status, 200, JSON.stringify(listed.body));
        assert.deepEqual(
          listed.data.map(({ id, deploymentStatus, deploymentErrorCode }) => [
            id,
            deploymentStatus,
            deploymentErrorCode,
          ]),
          [[handoff.revisionId, "failed", "REVISION_STOPPED"]],
        );
        assert.equal(settled.status, "failed", JSON.stringify(settled));
        assert.equal(settled.agentId, handoff.agentId);
        assert.equal(settled.revisionId, handoff.revisionId);
        assert.deepEqual(settled.error, {
          code: "REVISION_STOPPED",
          message: "The Agent was stopped before its first deployment finished.",
        });

        // Stop remains a permanent audited failure of the original provisioning request.
        const work = await fixture.pool.query<{
          state: ControllerWorkState;
          reason_code: string | null;
        }>("SELECT state, reason_code FROM occ.controller_work WHERE idempotency_key = $1", [
          admitted.data.provisioning.workId,
        ]);
        assert.deepEqual(work.rows, [
          { state: "failed_permanent", reason_code: "REVISION_STOPPED" },
        ]);
        const audit = await fixture.pool.query<{
          kind: string;
          outcome: string;
          code: string | null;
        }>(
          `SELECT kind, outcome, details->>'code' AS code
           FROM occ.audit_events
           WHERE namespace_id = $1
             AND action = 'openclaw.agents.provision.failure'
             AND details->>'workId' = $2`,
          [namespace.id, admitted.data.provisioning.workId],
        );
        assert.deepEqual(audit.rows, [
          { kind: "mutation", outcome: "failure", code: "REVISION_STOPPED" },
        ]);
        const retried = await fixture.request("POST", `${admitted.data.provisioning.url}/retry`);
        assert.equal(retried.status, 409, JSON.stringify(retried.body));
        const revisions = await fixture.state.read((view) =>
          view.revisions.listRevisions(namespace.id, handoff.agentId),
        );
        assert.deepEqual(
          revisions.map(({ id }) => id),
          [handoff.revisionId],
        );
      } finally {
        await fixture.stopWorker();
      }
    },
  );

  test(
    "queued provisioning leaves existing Secrets but creates no Agent or Configuration before a worker runs",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const secretDriver = createTestSecretDriver({ id: "secret-provisioning-cancel" });
      const fixture = await createFixture(context, { secretDriver });
      const namespace = await fixture.bootstrapNamespace();
      const secrets = await createProvisioningSecrets(fixture, namespace.id);
      const body = provisioningBody(namespace.id, secrets);
      const admitted = await fixture.requestChecked(
        AgentProvisioningResponse,
        "POST",
        `/namespaces/${namespace.id}/agents/provision`,
        {
          body,
        },
      );
      assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
      assert.deepEqual(
        secretDriver.calls.map(({ operation }) => operation),
        ["create", "create", "create", "create", "withValue"],
        "admission validates the existing Slack Secret without creating provisioning resources",
      );
      const resources = await fixture.pool.query<{
        agents: number;
        configurations: number;
        revisions: number;
        secrets: number;
      }>(
        `SELECT
         (SELECT count(*)::integer FROM occ.agents WHERE namespace_id = $1) AS agents,
         (SELECT count(*)::integer FROM occ.configurations WHERE namespace_id = $1) AS configurations,
         (SELECT count(*)::integer FROM occ.agent_revisions WHERE namespace_id = $1) AS revisions,
         (SELECT count(*)::integer FROM occ.secrets WHERE namespace_id = $1) AS secrets`,
        [namespace.id],
      );
      assert.deepEqual(resources.rows[0], {
        agents: 0,
        configurations: 0,
        revisions: 0,
        secrets: 4,
      });
      const status = await fixture.requestChecked(
        AgentProvisioningStatusResponse,
        "GET",
        admitted.data.provisioning.url,
      );
      assert.equal(status.status, 200, JSON.stringify(status.body));
      assert.equal(status.data.status, "queued");
      assert.equal(status.data.agentId, undefined);
      assert.equal(status.data.configurationId, undefined);
      const work = await fixture.pool.query<{ state: ControllerWorkState }>(
        "SELECT state FROM occ.controller_work WHERE work_kind = 'provisioning' AND namespace_id = $1 AND idempotency_key = $2",
        [namespace.id, admitted.data.provisioning.workId],
      );
      assert.deepEqual(work.rows, [{ state: "queued" }]);
    },
  );
}
