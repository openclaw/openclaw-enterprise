import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import pg, { type Pool } from "pg";
import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";

import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { reconcileSandboxPolicy } from "../../apps/controller/src/worker/sandbox-policy.ts";
import {
  AgentId,
  ErrorResponse,
  NamespaceId,
  RevisionId,
  type ComputeDriver,
  type SandboxNetworkGrant,
  type SandboxPolicy,
} from "../../packages/contracts/src/index.ts";
import {
  SandboxPolicyResponse,
  SandboxPolicyViewResponse,
} from "../../packages/contracts/src/api/sandbox-policy.ts";
import {
  DriverConfigurationRegistry,
  type OpenClawController,
  type PostgresPlatformState,
  PostgresWorkQueue,
  ScopeViolationError,
} from "../../packages/occ/src/index.ts";
import { createDevelopmentComputeDriver } from "../helpers/development.ts";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";
import { expireWorkLease } from "../helpers/postgres-worker-revision-queue.ts";
import { waitFor } from "../helpers/wait-for.ts";

interface PolicyHttpResponse {
  statusCode: number;
  body: string;
  json(): unknown;
}

interface RecoveryFixture {
  pool: Pool;
  state: PostgresPlatformState;
  controller: OpenClawController;
  computeDriver: ComputeDriver;
  sandboxDriver: OpenShellSandboxDriver;
  grant: SandboxNetworkGrant;
  inject(
    method: "GET" | "PATCH" | "POST" | "PUT",
    url: string,
    body?: object,
  ): Promise<PolicyHttpResponse>;
  deployAgent(name: string): Promise<unknown>;
}

const deployedAgent = Type.Object({
  namespace: Type.Object({ id: NamespaceId }),
  agent: Type.Object({ id: AgentId }),
  revision: Type.Object({ id: RevisionId }),
});

type ProviderApplyRequest = Parameters<OpenShellSandboxDriver["applyNetworkPolicy"]>[1];
type PolicyWithApplication = SandboxPolicy & Required<Pick<SandboxPolicy, "application">>;

function readResponse<Schema extends TSchema>(response: PolicyHttpResponse, schema: Schema) {
  const result = response.json();
  assert.ok(Check(schema, result), response.body);
  return result;
}

export function registerSandboxPolicyWorkerRecovery(
  createPolicyApp: (t: TestContext, recordOperations: boolean) => Promise<RecoveryFixture>,
): void {
  test(
    "interrupted terminal policy recovery rolls back queue failure and a restarted worker finalizes it",
    requiresPostgres,
    async (t) => {
      const { pool, state, controller, computeDriver, sandboxDriver, inject, deployAgent, grant } =
        await createPolicyApp(t, true);
      const deployed = await deployAgent("Interrupted policy recovery");
      assert.ok(Check(deployedAgent, deployed));
      const { namespace, agent, revision } = deployed;
      const activated = await state.transact(async (unit) => {
        await unit.namespaces.lockNamespace(namespace.id);
        return unit.agents.compareAndSetActiveRevision(
          namespace.id,
          agent.id,
          undefined,
          revision.id,
        );
      });
      assert.equal(activated?.activeRevisionId, revision.id);

      const queue = new PostgresWorkQueue(pool, { maxAttempts: 1, leaseDurationMs: 50 });
      // Prior lifecycle work has completed; the active revision is the exact application target.
      for (let claim = await queue.claim(); claim !== undefined; claim = await queue.claim()) {
        await queue.complete(claim);
      }
      const path = `/namespaces/${namespace.id}/agents/${agent.id}/sandbox-policy/networking`;
      assert.equal((await inject("PATCH", `${path}/editing`, { enabled: true })).statusCode, 200);
      assert.equal(
        (await inject("PUT", path, { expectedVersion: 1, additions: [grant] })).statusCode,
        200,
      );
      const admitted = await inject("POST", `${path}/apply`, {
        expectedVersion: 2,
        revisionId: revision.id,
      });
      assert.equal(admitted.statusCode, 202, admitted.body);
      const admittedPolicy = readResponse(admitted, SandboxPolicyResponse).data;
      assert.ok(admittedPolicy.application);
      assert.equal(admittedPolicy.application.revisionId, revision.id);
      const applicationRole = await pool.query<{ role: string }>("SELECT current_user AS role");
      assert.equal(applicationRole.rows[0]?.role, "occ_app");

      const findPolicy = () =>
        state.read((view) => view.sandboxPolicies.find(namespace.id, agent.id));
      const readPolicy = async (): Promise<PolicyWithApplication> => {
        const policy = await findPolicy();
        assert.ok(policy?.application);
        return { ...policy, application: policy.application };
      };
      const readCustody = async (idempotencyKey: string) => {
        const policy = await pool.query<Record<string, unknown>>(
          "SELECT * FROM occ.sandbox_policies WHERE namespace_id=$1 AND agent_id=$2",
          [namespace.id, agent.id],
        );
        const work = await pool.query<Record<string, unknown>>(
          "SELECT * FROM occ.controller_work WHERE idempotency_key=$1",
          [idempotencyKey],
        );
        const audit = await pool.query<{ count: string }>(
          "SELECT count(*) AS count FROM occ.audit_events WHERE namespace_id=$1",
          [namespace.id],
        );
        assert.equal(policy.rowCount, 1);
        assert.equal(work.rowCount, 1);
        assert.equal(audit.rowCount, 1);
        return { policy: policy.rows[0], work: work.rows[0], auditCount: audit.rows[0]?.count };
      };
      const workKey = (applicationId: string) =>
        `agent:${agent.id}:reconcile:sandbox_policy:${applicationId}`;
      const rejectRemoval = async (label: string, applicationId: string): Promise<void> => {
        const { application, ...withoutApplication } = await readPolicy();
        assert.equal(application.id, applicationId);
        assert.equal(application.state, "pending");
        const key = workKey(application.id);
        const before = await readCustody(key);
        await t.test(`${label}: repository preserves pending application custody`, async () => {
          try {
            await assert.rejects(
              state.transact(async (unit) => {
                await unit.sandboxPolicies.save(withoutApplication, withoutApplication.version);
                // Roll back the attempted change even if the guard is missing.
                throw new Error("Rollback unexpected pending application removal");
              }),
              ScopeViolationError,
            );
          } finally {
            assert.deepEqual(await readCustody(key), before);
          }
        });
        await t.test(
          `${label}: application-role SQL preserves pending application custody`,
          async () => {
            const client = await pool.connect();
            try {
              await client.query("BEGIN");
              await assert.rejects(
                client.query(
                  "UPDATE occ.sandbox_policies SET document=document-'application' WHERE namespace_id=$1 AND agent_id=$2 AND version=$3",
                  [namespace.id, agent.id, withoutApplication.version],
                ),
                { code: "23514" },
              );
            } finally {
              try {
                await client.query("ROLLBACK");
              } finally {
                client.release();
              }
              assert.deepEqual(await readCustody(key), before);
            }
          },
        );
      };
      await rejectRemoval("admitted", admittedPolicy.application.id);
      // Neither a save nor a second application can replace policy version 2 while it is pending.
      const refusals = [
        {
          method: "PUT",
          url: path,
          body: { expectedVersion: 2, additions: [] },
          message: "The policy changed or an application is still pending. Reload before editing.",
        },
        {
          method: "POST",
          url: `${path}/apply`,
          body: { expectedVersion: 2, revisionId: revision.id },
          message: "A policy application is already pending.",
        },
      ] as const;
      for (const { method, url, body, message } of refusals) {
        const refused = await inject(method, url, body);
        assert.equal(refused.statusCode, 409, refused.body);
        assert.equal(readResponse(refused, ErrorResponse).error.message, message);
      }

      const claim = await queue.claim();
      assert.ok(claim);
      assert.equal(claim.agentTarget, "sandbox_policy");
      assert.equal(claim.idempotencyKey, workKey(admittedPolicy.application.id));
      assert.equal(claim.actorId, admittedPolicy.application.requestedBy);
      await expireWorkLease(pool, claim.idempotencyKey);

      const workers: ReturnType<typeof createControllerWorker>[] = [];
      const startWorker = async () => {
        const name = `policy-recovery-${randomUUID()}`;
        const worker = createControllerWorker({
          pool: new pg.Pool({ connectionString: databaseUrl, application_name: name }),
          computeDriver: createDevelopmentComputeDriver(),
          maxAttempts: 1,
          pollIntervalMs: 30_000,
          emit() {},
        });
        workers.push(worker);
        await worker.start();
        return { worker, name };
      };
      const readPolicyView = async () => {
        const response = await inject("GET", path);
        assert.equal(response.statusCode, 200, response.body);
        return readResponse(response, SandboxPolicyViewResponse).data.policy;
      };

      try {
        const blocker = await pool.connect();
        try {
          await blocker.query("BEGIN");
          const locked = await blocker.query<{ id: string }>(
            "SELECT id FROM occ.sandbox_policies WHERE namespace_id=$1 AND agent_id=$2 FOR UPDATE",
            [namespace.id, agent.id],
          );
          assert.equal(locked.rowCount, 1);
          const interrupted = await startWorker();
          // Hold finalization after the terminal queue UPDATE, then terminate the blocked
          // PostgreSQL session to interrupt the transaction between writes.
          const pid = await waitFor(
            "policy finalization blocked after queue recovery",
            async () => {
              const result = await pool.query<{ pid: number }>(
                "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE '%sandbox_policies%'",
                [interrupted.name],
              );
              return result.rows[0]?.pid;
            },
          );
          const terminated = await pool.query<{ terminated: boolean }>(
            "SELECT pg_terminate_backend($1) AS terminated",
            [pid],
          );
          assert.equal(terminated.rows[0]?.terminated, true);
          await interrupted.worker.stop();
          assert.equal(
            (await queue.findWork(claim.idempotencyKey))?.state,
            "claimed",
            "the interrupted transaction must preserve recoverable work",
          );
          assert.equal((await readPolicyView()).application?.state, "pending");
        } finally {
          try {
            await blocker.query("ROLLBACK");
          } finally {
            blocker.release();
          }
        }

        const recovered = await startWorker();
        await waitFor("restarted worker finalizes abandoned application", async () => {
          const policy = await readPolicyView();
          return policy.application?.state === "failed" ? policy : undefined;
        });
        await recovered.worker.stop();
        assert.equal((await queue.findWork(claim.idempotencyKey))?.state, "failed_permanent");
        const audit = await pool.query<{ actor_id: string }>(
          "SELECT actor_id FROM occ.audit_events WHERE action='openclaw.agents.sandbox_policy.application' AND resource_id=$1",
          [admittedPolicy.id],
        );
        assert.equal(audit.rowCount, 1, "terminal recovery emits one attributable policy failure");
        assert.equal(audit.rows[0]?.actor_id, claim.actorId);
      } finally {
        await Promise.all(workers.map((worker) => worker.stop()));
      }

      const next = await inject("PUT", path, { expectedVersion: 2, additions: [] });
      assert.equal(next.statusCode, 200, next.body);
      const applying = await inject("POST", `${path}/apply`, {
        expectedVersion: 3,
        revisionId: revision.id,
      });
      assert.equal(applying.statusCode, 202, applying.body);
      const applyingPolicy = readResponse(applying, SandboxPolicyResponse).data;
      const { application } = await readPolicy();
      assert.equal(application.id, applyingPolicy.application?.id);
      const configurations = new DriverConfigurationRegistry();
      configurations.register({
        capability: "sandbox",
        driverId: sandboxDriver.id,
        implementation: sandboxDriver.implementation,
        definition: OpenShellSandboxDriver,
      });

      const providerCas = "provider-cas-1";
      const providerCalls: { request: ProviderApplyRequest; persistedCas: string | undefined }[] =
        [];
      // The provider boundary is controlled. Reconciliation, IAM, state, queue and audit are real.
      sandboxDriver.observeNetworkPolicy = async () => ({
        resourceVersion: providerCas,
        policyVersion: providerCalls.length === 0 ? "provider-policy-1" : "provider-policy-2",
        state: "applied",
        matches: providerCalls.length !== 0,
      });
      sandboxDriver.applyNetworkPolicy = async (_context, request) => {
        const persisted = await findPolicy();
        providerCalls.push({
          request,
          persistedCas: persisted?.application?.expectedProviderVersion,
        });
      };
      const workOptions = {
        configurations,
        state,
        queueOptions: {},
        driver: sandboxDriver,
        compute: computeDriver,
        iam: controller.selectedDriver("iam"),
        installationId: controller.installation.id,
        ceiling: [grant],
        signal: new AbortController().signal,
        maxAttempts: 5,
        deadlineMs: 60_000,
        leaseDurationMs: 5_000,
      } satisfies Parameters<typeof reconcileSandboxPolicy>[0];
      const policyQueue = new PostgresWorkQueue(pool);
      const first = await policyQueue.claim();
      assert.ok(first);
      assert.equal(first.idempotencyKey, workKey(application.id));
      assert.equal(await reconcileSandboxPolicy(workOptions, first), "pending");
      assert.equal((await readPolicy()).application.expectedProviderVersion, providerCas);
      assert.equal(providerCalls.length, 0, "the first pass only persists the provider CAS");
      await rejectRemoval("provider CAS persisted", application.id);

      const second = await waitFor("deferred policy application is claimable", () =>
        policyQueue.claim(),
      );
      assert.equal(second.idempotencyKey, first.idempotencyKey);
      const outcome = await reconcileSandboxPolicy(workOptions, second);
      // Assert outside the provider callback so reconciliation cannot catch these failures.
      assert.deepEqual(providerCalls, [
        {
          request: {
            operationId: application.id,
            expectedProviderVersion: providerCas,
            snapshot: application.snapshot,
          },
          persistedCas: providerCas,
        },
      ]);
      assert.equal(outcome, "success");
      const completed = await readPolicy();
      assert.equal(completed.application.id, application.id);
      assert.equal(completed.application.state, "applied");
      assert.equal(completed.applied?.providerVersion, "provider-policy-2");
      assert.equal((await policyQueue.findWork(second.idempotencyKey))?.state, "succeeded");
      const afterApplied = await inject("PUT", path, { expectedVersion: 3, additions: [grant] });
      assert.equal(afterApplied.statusCode, 200, afterApplied.body);
      const saved = readResponse(afterApplied, SandboxPolicyResponse).data;
      assert.equal(saved.version, 4);
      assert.equal(saved.application, undefined);
    },
  );
}
