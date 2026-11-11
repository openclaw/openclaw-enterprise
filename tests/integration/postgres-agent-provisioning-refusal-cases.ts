import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type {
  AgentProvisioningResponse,
  AgentProvisioningStatusWire,
  ProvisionAgentBody,
  SecretWire,
} from "@openclaw-enterprise/contracts";
import type {
  AgentProvisioningProgress,
  AgentProvisioningRecord,
  ProvisioningEffectReceipt,
} from "../../packages/occ/src/index.ts";
import type { createTestConfigurationDriver } from "../helpers/configuration-driver.ts";
import { occLogLine } from "../helpers/occ-log-line.ts";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { expireWorkLease } from "../helpers/postgres-worker-revision-support.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import type { createProvisioningFixture } from "./postgres-agent-provisioning-fixture.ts";
import { createRuntimeComputeDriver } from "./postgres-agent-provisioning-transport-fixture.ts";

type Fixture = Awaited<ReturnType<typeof createProvisioningFixture>>;
type FixtureOptions = Pick<
  Parameters<typeof createProvisioningFixture>[1],
  "computeDriver" | "configurationDriver" | "onWorkerEvent"
>;
type RuntimeComputeDriver = ReturnType<typeof createRuntimeComputeDriver>;
type ProvisioningSecrets = Record<
  "modelKey" | "slackBotToken" | "slackSigningSecret" | "externalServiceToken",
  SecretWire
>;

interface ProvisioningRow {
  status: AgentProvisioningRecord["status"];
  completed_phase: AgentProvisioningRecord["completedPhase"];
  agent_id: string | null;
  progress: {
    error?: AgentProvisioningProgress["error"];
    pendingEffect?: { owner?: string };
    effectReceipt?: ProvisioningEffectReceipt;
    unrecordedConfigurationId?: string;
  };
}

interface RefusalDependencies {
  createFixture: (context: TestContext, options: FixtureOptions) => Promise<Fixture>;
  createProvisioningConfigurationDriver: (options: {
    id: string;
  }) => ReturnType<typeof createTestConfigurationDriver>;
  createProvisioningSecrets: (
    fixture: Pick<Fixture, "request">,
    namespaceId: string,
  ) => Promise<ProvisioningSecrets>;
  provisioningBody: (
    namespaceId: string,
    secrets: ProvisioningSecrets,
  ) => ProvisionAgentBody & { requestId: string };
  provisioningRow: (
    pool: Fixture["pool"],
    namespaceId: string,
    requestId: string,
  ) => Promise<ProvisioningRow>;
  refuseProvisioningWithoutGatewayRouting: (driver: RuntimeComputeDriver) => void;
}

export function registerProvisioningRefusalCases({
  createFixture,
  createProvisioningConfigurationDriver,
  createProvisioningSecrets,
  provisioningBody,
  provisioningRow,
  refuseProvisioningWithoutGatewayRouting,
}: RefusalDependencies): void {
  async function createRefusalFixture(
    context: TestContext,
    drivers: Omit<FixtureOptions, "onWorkerEvent">,
  ) {
    const completed: Readonly<Record<string, unknown>>[] = [];
    const fixture = await createFixture(context, {
      ...drivers,
      onWorkerEvent: (event) => {
        if (event.event === "worker.completed") {
          completed.push(event);
        }
      },
    });
    return { fixture, completed };
  }

  async function admitProvisioning(fixture: Fixture) {
    const namespace = await fixture.bootstrapNamespace();
    const secrets = await createProvisioningSecrets(fixture, namespace.id);
    const body = provisioningBody(namespace.id, secrets);
    const admitted = await fixture.request<AgentProvisioningResponse["data"]>(
      "POST",
      `/namespaces/${namespace.id}/agents/provision`,
      { body },
    );
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    assert.ok(admitted.data);
    return { namespace, requestId: body.requestId, provisioning: admitted.data.provisioning };
  }

  test(
    "a permanent refusal after an unfinished Configuration write settles the write and rejects the work",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const computeDriver = createRuntimeComputeDriver();
      const configurationDriver = createProvisioningConfigurationDriver({
        id: "configuration-provisioning-unsettled-refusal",
      });
      const createExact = configurationDriver.createExact;
      assert.ok(createExact);
      const created: string[] = [];
      configurationDriver.createExact = async (configuration) => {
        const stored = await createExact(configuration);
        created.push(configuration.id);
        if (created.length === 1) {
          // The write lands but its receipt is lost, and before the next attempt the
          // Installation's Compute Driver starts refusing the stored plan (no gateway routing).
          refuseProvisioningWithoutGatewayRouting(computeDriver);
          throw new Error("synthetic Configuration receipt loss");
        }
        return stored;
      };
      const { fixture, completed } = await createRefusalFixture(context, {
        computeDriver,
        configurationDriver,
      });
      const { namespace, requestId, provisioning } = await admitProvisioning(fixture);

      // The next attempt inspects the unfinished write before its fence, records the receipt,
      // and then fails the work on the refusal instead of retrying an unknown outcome. The job
      // never recorded that Configuration, so the refusal deletes it and forgets the write.
      await fixture.startWorker();
      const failed = await waitFor("the provisioning work to fail", async () => {
        const row = await provisioningRow(fixture.pool, namespace.id, requestId);
        return row.status === "failed" ? row : undefined;
      });
      await fixture.stopWorker();
      const workId = provisioning.workId;
      assert.deepEqual(
        completed
          .filter((event) => event.workId === workId)
          .map(({ attempt, outcome, code }) => ({ attempt, outcome, code })),
        [
          { attempt: 1, outcome: "retry", code: "PROVISIONING_OUTCOME_UNKNOWN" },
          { attempt: 2, outcome: "permanent", code: "PROVISIONING_REJECTED" },
        ],
      );
      assert.deepEqual(failed.progress.error, {
        code: "PROVISIONING_REJECTED",
        message:
          "The Compute Driver cannot provision this execution mode or gateway configuration.",
      });
      assert.equal(failed.progress.pendingEffect, undefined);
      assert.equal(failed.progress.effectReceipt, undefined);
      assert.equal(created.length, 1, "recovery never writes the Configuration again");
      assert.ok(created[0]);
      assert.equal(
        configurationDriver.stored({ namespaceId: namespace.id, id: created[0] }),
        undefined,
        "the refusal deletes the Configuration the job wrote but never recorded",
      );
      assert.equal(failed.agent_id, null, "the refusal comes before the work creates its Agent");
      const work = await fixture.pool.query(
        "SELECT state, reason_code, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
        [workId],
      );
      assert.deepEqual(work.rows, [
        { state: "failed_permanent", reason_code: "PROVISIONING_REJECTED", attempt_count: 2 },
      ]);
    },
  );

  test(
    "a refusal whose Configuration delete fails names the orphaned Configuration, and its retry deletes it",
    { ...requiresPostgres, timeout: 90_000 },
    async (context) => {
      const computeDriver = createRuntimeComputeDriver();
      const validateAgentProvisioning = computeDriver.validateAgentProvisioning;
      assert.ok(validateAgentProvisioning);
      const configurationDriver = createProvisioningConfigurationDriver({
        id: "configuration-provisioning-delete-outage",
      });
      const createExact = configurationDriver.createExact;
      assert.ok(createExact);
      const created: string[] = [];
      configurationDriver.createExact = async (configuration) => {
        const stored = await createExact(configuration);
        created.push(configuration.id);
        if (created.length === 1) {
          // The first write lands, then the Compute Driver starts refusing the stored plan, so
          // the fence of the transaction that would record the Configuration rejects the work.
          refuseProvisioningWithoutGatewayRouting(computeDriver);
        }
        return stored;
      };
      const deleteConfiguration = configurationDriver.delete;
      const deleted: string[] = [];
      let deleteOutage = true;
      configurationDriver.delete = async (reference) => {
        if (deleteOutage) {
          throw new Error("synthetic Configuration delete outage");
        }
        deleted.push(reference.id);
        return deleteConfiguration(reference);
      };
      const { fixture, completed } = await createRefusalFixture(context, {
        computeDriver,
        configurationDriver,
      });
      const { namespace, requestId, provisioning } = await admitProvisioning(fixture);
      const workId = provisioning.workId;

      await fixture.startWorker();
      await waitFor("the refused provisioning to report its outcome", async () =>
        completed.some((event) => event.workId === workId) ? true : undefined,
      );
      await fixture.stopWorker();

      // The failed delete does not change the refusal: the job still forgets the write, so a
      // retry never trusts it, and the operator log names the document left behind. The job
      // also keeps it marked for deletion, so the leftover is not only a log line (finding 1399).
      // The line is the one the worker log keeps (finding 2245).
      assert.equal(created.length, 1);
      assert.ok(created[0]);
      assert.deepEqual(
        completed
          .filter((event) => event.workId === workId)
          .map(occLogLine)
          .map(({ outcome, code, orphanedConfigurationId }) => ({
            outcome,
            code,
            orphanedConfigurationId,
          })),
        [
          {
            outcome: "permanent",
            code: "PROVISIONING_REJECTED",
            orphanedConfigurationId: created[0],
          },
        ],
      );
      const failed = await provisioningRow(fixture.pool, namespace.id, requestId);
      assert.equal(failed.status, "failed");
      assert.equal(failed.completed_phase, "admitted");
      assert.equal(failed.progress.error?.code, "PROVISIONING_REJECTED");
      assert.equal(failed.progress.pendingEffect, undefined);
      assert.equal(failed.progress.effectReceipt, undefined);
      assert.equal(failed.progress.unrecordedConfigurationId, created[0]);
      const orphaned = { namespaceId: namespace.id, id: created[0] };
      assert.notEqual(configurationDriver.stored(orphaned), undefined);
      const work = await fixture.pool.query(
        "SELECT state, reason_code, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
        [workId],
      );
      assert.deepEqual(work.rows, [
        { state: "failed_permanent", reason_code: "PROVISIONING_REJECTED", attempt_count: 1 },
      ]);

      // Once the Driver can delete again and the plan is accepted again, the retry deletes the
      // marked Configuration before it writes a new one, and provisioning completes.
      deleteOutage = false;
      computeDriver.validateAgentProvisioning = validateAgentProvisioning;
      const retried = await fixture.request("POST", `${provisioning.url}/retry`);
      assert.equal(retried.status, 202, JSON.stringify(retried.body));
      await fixture.startWorker();
      const succeeded = await waitFor("the retried provisioning to succeed", async () => {
        const observed = await fixture.request<AgentProvisioningStatusWire>(
          "GET",
          provisioning.url,
        );
        assert.equal(observed.status, 200, JSON.stringify(observed.body));
        assert.ok(observed.data);
        assert.notEqual(observed.data.status, "failed", JSON.stringify(observed.body));
        return observed.data.status === "succeeded" ? observed.data : undefined;
      });
      assert.ok(succeeded.agentId);
      fixture.cancelProvisioningAtTeardown(namespace.id, succeeded.agentId);
      assert.deepEqual(deleted, [created[0]]);
      assert.equal(configurationDriver.stored(orphaned), undefined);
      assert.equal(created.length, 2);
      assert.equal(succeeded.configurationId, created[1]);
      assert.ok(succeeded.configurationId);
      assert.notEqual(
        configurationDriver.stored({ namespaceId: namespace.id, id: succeeded.configurationId }),
        undefined,
      );
      const retriedRow = await provisioningRow(fixture.pool, namespace.id, requestId);
      assert.equal(retriedRow.progress.unrecordedConfigurationId, undefined);
    },
  );

  test(
    "the Configuration a refusal could not delete before losing its claim is deleted by the next refusing attempt",
    { ...requiresPostgres, timeout: 90_000 },
    async (context) => {
      const computeDriver = createRuntimeComputeDriver();
      const configurationDriver = createProvisioningConfigurationDriver({
        id: "configuration-provisioning-delete-claim-lost",
      });
      const createExact = configurationDriver.createExact;
      assert.ok(createExact);
      const created: string[] = [];
      configurationDriver.createExact = async (configuration) => {
        const stored = await createExact(configuration);
        created.push(configuration.id);
        // The write lands, then the Compute Driver refuses the stored plan for good, so this
        // attempt's fence and every later one reject the work, and `/retry` would refuse too.
        refuseProvisioningWithoutGatewayRouting(computeDriver);
        return stored;
      };
      const deleteConfiguration = configurationDriver.delete;
      const deleted: string[] = [];
      let stalled = false;
      configurationDriver.delete = async (reference) => {
        if (!stalled) {
          // The worker stalls before its delete until its database lease has run out, as a
          // stopped or partitioned worker would, and the delete never reaches the Driver.
          stalled = true;
          await expireWorkLease(fixture.pool, { key: workId, state: "claimed" });
          throw new Error("synthetic worker stall before the Configuration delete");
        }
        deleted.push(reference.id);
        return deleteConfiguration(reference);
      };
      const { fixture, completed } = await createRefusalFixture(context, {
        computeDriver,
        configurationDriver,
      });
      const { namespace, requestId, provisioning } = await admitProvisioning(fixture);
      const workId = provisioning.workId;

      // The stalled attempt cannot record its refusal. Recovery requeues the job, which still
      // names the write only through its mark, and the next attempt's fence refuses it again.
      // That refusal deletes the marked document, then forgets the mark (finding 1399).
      await fixture.startWorker();
      try {
        await waitFor(
          "the requeued attempt to refuse the work",
          async () => (completed.some((event) => event.workId === workId) ? true : undefined),
          30_000,
        );
      } finally {
        await fixture.stopWorker();
      }
      assert.equal(stalled, true);
      assert.equal(created.length, 1, "no attempt writes the Configuration again");
      assert.ok(created[0]);
      assert.deepEqual(deleted, [created[0]]);
      assert.equal(
        configurationDriver.stored({ namespaceId: namespace.id, id: created[0] }),
        undefined,
      );
      assert.deepEqual(
        completed
          .filter((event) => event.workId === workId)
          .map(({ outcome, code, orphanedConfigurationId }) => ({
            outcome,
            code,
            orphanedConfigurationId,
          })),
        [
          {
            outcome: "permanent",
            code: "PROVISIONING_REJECTED",
            orphanedConfigurationId: undefined,
          },
        ],
      );
      const failed = await provisioningRow(fixture.pool, namespace.id, requestId);
      assert.equal(failed.status, "failed");
      assert.equal(failed.progress.error?.code, "PROVISIONING_REJECTED");
      assert.equal(failed.progress.pendingEffect, undefined);
      assert.equal(failed.progress.effectReceipt, undefined);
      assert.equal(failed.progress.unrecordedConfigurationId, undefined);
    },
  );

  test(
    "a lost authority after an unfinished transport write settles the write and rejects the work",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const computeDriver = createRuntimeComputeDriver();
      const provisionRuntimeCredentials = computeDriver.provisionAgentRuntimeCredentials;
      let provisioned = 0;
      computeDriver.provisionAgentRuntimeCredentials = async (...args) => {
        const status = await provisionRuntimeCredentials(...args);
        provisioned += 1;
        if (provisioned === 1) {
          // The credentials land but their receipt is lost, and the initiating administrator
          // loses the provisioning grants before the next attempt.
          await fixture.revokeCurrentPrincipal();
          throw new Error("synthetic transport receipt loss");
        }
        return status;
      };
      const { fixture, completed } = await createRefusalFixture(context, {
        computeDriver,
      });
      const { namespace, requestId, provisioning } = await admitProvisioning(fixture);

      await fixture.startWorker();
      const failed = await waitFor("the provisioning work to fail", async () => {
        const row = await provisioningRow(fixture.pool, namespace.id, requestId);
        return row.status === "failed" ? row : undefined;
      });
      await fixture.stopWorker();
      assert.ok(failed.agent_id);
      fixture.cancelProvisioningAtTeardown(namespace.id, failed.agent_id);
      const workId = provisioning.workId;
      assert.deepEqual(
        completed
          .filter((event) => event.workId === workId)
          .map(({ attempt, outcome, code }) => ({ attempt, outcome, code })),
        [
          { attempt: 1, outcome: "retry", code: "PROVISIONING_OUTCOME_UNKNOWN" },
          { attempt: 2, outcome: "permanent", code: "PROVISIONING_REJECTED" },
        ],
      );
      assert.equal(failed.progress.error?.code, "PROVISIONING_REJECTED");
      const { pendingEffect, effectReceipt } = failed.progress;
      assert.deepEqual(
        {
          kind: effectReceipt?.kind,
          owner: effectReceipt?.owner,
          targetId: effectReceipt?.targetId,
        },
        { kind: "transport", owner: pendingEffect?.owner, targetId: failed.agent_id },
      );
      assert.equal(provisioned, 1, "recovery never provisions the credentials again");
      const work = await fixture.pool.query(
        "SELECT state, reason_code, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
        [workId],
      );
      assert.deepEqual(work.rows, [
        { state: "failed_permanent", reason_code: "PROVISIONING_REJECTED", attempt_count: 2 },
      ]);
      // One failure audit per attempt: the unknown outcome, then the authorization denial.
      const audit = await fixture.pool.query(
        `SELECT kind, outcome FROM occ.audit_events
         WHERE namespace_id = $1
           AND action = 'openclaw.agents.provision.failure'
           AND details->>'workId' = $2
         ORDER BY kind`,
        [namespace.id, workId],
      );
      assert.deepEqual(audit.rows, [
        { kind: "authorization_denial", outcome: "denied" },
        { kind: "mutation", outcome: "failure" },
      ]);
      const revisions = await fixture.pool.query(
        "SELECT id FROM occ.agent_revisions WHERE namespace_id = $1",
        [namespace.id],
      );
      assert.equal(revisions.rowCount, 0);
    },
  );
}
