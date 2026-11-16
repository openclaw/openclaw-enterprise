import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import {
  AgentProvisioningResponse,
  AgentProvisioningStatusResponse,
  AgentResponse,
  ConfigurationResponse,
  NamespaceResponse,
  SecretDetailResponse,
  ServiceAccountResponse,
} from "../../packages/contracts/src/api/resources.ts";
import type { SecretWire } from "../../packages/contracts/src/index.ts";
import type { AgentProvisioningRecord, ControllerWorkState } from "../../packages/occ/src/index.ts";
import {
  type Fixture,
  handedOff,
  type ProvisioningPhase,
  required,
} from "./postgres-agent-provisioning-setup.ts";

import { ServiceAccountDriverNotConfiguredError } from "../../packages/occ/src/index.ts";
import { assertApiError } from "../helpers/api-error.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { AGENT_NAME_CONFLICT } from "../helpers/refusal-text.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import { createRuntimeComputeDriver } from "./postgres-agent-provisioning-transport-fixture.ts";

import {
  agentDefaults,
  authAccountResponse,
  createFixture,
  createProvisioningConfigurationDriver,
  createProvisioningSecrets,
  identifier,
  provisioningBody,
  provisioningError,
  requestAcceptedProvisioning,
  secretRef,
  signInToControllerApp,
} from "./postgres-agent-provisioning-setup.ts";

// Provision Agents through the worker and return their settled provisioning views.
async function provisionAgents(fixture: Fixture, namespaceId: string, count = 1) {
  const secrets = await createProvisioningSecrets(fixture, namespaceId);
  const admitted: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const response = await fixture.requestChecked(
      AgentProvisioningResponse,
      "POST",
      `/namespaces/${namespaceId}/agents/provision`,
      {
        body: provisioningBody(namespaceId, secrets),
      },
    );
    assert.equal(response.status, 202, JSON.stringify(response.body));
    admitted.push(response.data.provisioning.url);
  }
  await fixture.startWorker();
  const created: ReturnType<typeof handedOff>[] = [];
  try {
    for (const url of admitted) {
      created.push(
        await waitFor("Agent provisioning to succeed", async () => {
          const observed = await fixture.requestChecked(
            AgentProvisioningStatusResponse,
            "GET",
            url,
          );
          assert.equal(observed.status, 200, JSON.stringify(observed.body));
          return observed.data.status === "succeeded" ? handedOff(observed.data) : undefined;
        }),
      );
    }
  } finally {
    await fixture.stopWorker();
  }
  for (const provisioned of created) {
    fixture.cancelProvisioningAtTeardown(namespaceId, provisioned.agentId);
  }
  return created;
}

function recordingConfigurationDriver() {
  const configurationDriver = createProvisioningConfigurationDriver({
    id: "configuration-provisioning",
  });
  const deleted: string[] = [];
  const deleteStored = configurationDriver.delete.bind(configurationDriver);
  configurationDriver.delete = async (reference) => {
    deleted.push(reference.id);
    return deleteStored(reference);
  };
  return { configurationDriver, deleted };
}

async function selectConfiguration(
  fixture: Fixture,
  namespaceId: string,
  agentId: string,
  configurationId: string,
) {
  const switched = await fixture.requestChecked(
    AgentResponse,
    "PATCH",
    `/namespaces/${namespaceId}/agents/${agentId}`,
    {
      body: { configurationId },
    },
  );
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  assert.equal(switched.data.configurationId, configurationId);
}

async function createAgentConfiguration(fixture: Fixture, namespaceId: string) {
  const created = await fixture.requestChecked(
    ConfigurationResponse,
    "POST",
    `/namespaces/${namespaceId}/configurations`,
    {
      body: { kind: "agent", values: { agents: { defaults: agentDefaults() } } },
    },
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.data.id;
}

export async function provisioningConfigurationId(pool: pg.Pool, workId: string) {
  const result = await pool.query<{ configuration_id: string | null }>(
    "SELECT configuration_id FROM occ.agent_provisioning_work WHERE work_id = $1",
    [workId],
  );
  assert.equal(result.rowCount, 1);
  return required(result.rows[0]).configuration_id;
}

async function assertConfigurationDeletionRefused(
  fixture: Fixture,
  namespaceId: string,
  configurationId: string,
  message: RegExp,
) {
  const path = `/namespaces/${namespaceId}/configurations/${configurationId}`;
  const refused = await fixture.request("DELETE", path);
  assertApiError(refused, 409, "RESOURCE_CONFLICT");
  assert.match(provisioningError(refused).message, message);
  const kept = await fixture.request("GET", path);
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
}

export function registerRetryCases() {
  test(
    "failed provisioning can retry through the API and resume without duplicating the Agent",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const computeDriver = createRuntimeComputeDriver();
      const configurationDriver = createProvisioningConfigurationDriver({
        id: "configuration-provisioning-retry",
      });
      const createExact = configurationDriver.createExact;
      const inspectExact = configurationDriver.inspectExact;
      let loseConfigurationReceipt = true;
      let allowConfigurationRecovery = false;
      configurationDriver.createExact = async (configuration) => {
        const created = await createExact(configuration);
        if (loseConfigurationReceipt) {
          loseConfigurationReceipt = false;
          throw new Error("synthetic Configuration receipt loss");
        }
        return created;
      };
      // Until recovery is allowed, the Configuration backend cannot answer the inspection either,
      // so the worker cannot observe the landed write and retries it as an unknown outcome.
      configurationDriver.inspectExact = async (configuration) => {
        if (!allowConfigurationRecovery) {
          throw new Error("synthetic Configuration read outage");
        }
        return inspectExact(configuration);
      };
      const fixture = await createFixture(context, { computeDriver, configurationDriver });
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

      await fixture.startWorker();
      const failed = await waitFor(
        "Agent provisioning to fail after losing the Configuration receipt",
        async () => {
          const observed = await fixture.requestChecked(
            AgentProvisioningStatusResponse,
            "GET",
            admitted.data.provisioning.url,
          );
          assert.equal(observed.status, 200, JSON.stringify(observed.body));
          return observed.data.status === "failed" ? observed.data : undefined;
        },
      );
      assert.equal(failed.phase, "admitted");
      assert.equal(failed.error?.code, "PROVISIONING_OUTCOME_UNKNOWN");
      assert.deepEqual(
        computeDriver.calls.map(({ operation }) => operation),
        [],
        "a pre-dispatch Configuration dependency failure must not reach transport effects",
      );
      const failedResources = await fixture.pool.query<{
        agents: number;
        configurations: number;
        revisions: number;
      }>(
        `SELECT
         (SELECT count(*)::integer FROM occ.agents WHERE namespace_id = $1) AS agents,
         (SELECT count(*)::integer FROM occ.configurations WHERE namespace_id = $1) AS configurations,
         (SELECT count(*)::integer FROM occ.agent_revisions WHERE namespace_id = $1) AS revisions`,
        [namespace.id],
      );
      assert.deepEqual(
        failedResources.rows[0],
        { agents: 0, configurations: 0, revisions: 0 },
        "Configuration backend creation must finish before the workflow creates an Agent",
      );
      await fixture.stopWorker();

      allowConfigurationRecovery = true;
      const retried = await fixture.requestChecked(
        AgentProvisioningStatusResponse,
        "POST",
        `${admitted.data.provisioning.url}/retry`,
      );
      assert.equal(retried.status, 202, JSON.stringify(retried.body));
      assert.equal(retried.data.status, "queued");
      assert.equal(retried.data.phase, "admitted");

      const workId = admitted.data.provisioning.workId;
      const requeued = await fixture.pool.query<{ request_id: string | null }>(
        `SELECT details->'__occAuditMetadata'->>'requestId' AS request_id
         FROM occ.audit_events WHERE action = 'openclaw.controller_work.queued'
           AND details->>'workId' = $1 ORDER BY occurred_at, id`,
        [workId],
      );
      assert.deepEqual(requeued.rows, [
        { request_id: admitted.body.meta.requestId },
        { request_id: retried.body.meta.requestId },
      ]);

      await fixture.startWorker();
      const succeeded = await waitFor("retried Agent provisioning to succeed", async () => {
        const observed = await fixture.requestChecked(
          AgentProvisioningStatusResponse,
          "GET",
          admitted.data.provisioning.url,
        );
        assert.equal(observed.status, 200, JSON.stringify(observed.body));
        return observed.data.status === "succeeded" ? handedOff(observed.data) : undefined;
      });
      assert.equal(succeeded.revisionId?.startsWith("rev_"), true);
      assert.match(succeeded.agentId, identifier("agt"));
      fixture.cancelProvisioningAtTeardown(namespace.id, succeeded.agentId);

      // Success names the persisted Agent and the worker claim that closed provisioning.
      const evidence = await fixture.pool.query<{
        resource_kind: string | null;
        resource_id: string | null;
        work_state: string | null;
      }>(
        `SELECT result.resource_kind, result.resource_id, result.details->>'workState' AS work_state
         FROM occ.audit_events AS result
         JOIN occ.audit_events AS claim ON claim.id = result.details->>'attemptId'
         WHERE result.action = 'openclaw.controller_work.completed'
           AND result.details->>'workId' = $1 AND claim.details->>'workId' = $1
           AND claim.action = 'openclaw.controller_work.claimed'`,
        [workId],
      );
      assert.deepEqual(evidence.rows, [
        { resource_kind: "agent", resource_id: succeeded.agentId, work_state: "succeeded" },
      ]);

      const agents = await fixture.pool.query<{ id: string }>(
        "SELECT id FROM occ.agents WHERE namespace_id = $1",
        [namespace.id],
      );
      assert.deepEqual(
        agents.rows.map(({ id }) => id),
        [succeeded.agentId],
        "retry must resume the accepted provisioning plan instead of creating a replacement Agent",
      );
      const revisions = await fixture.pool.query<{ id: string }>(
        "SELECT id FROM occ.agent_revisions WHERE namespace_id = $1 AND agent_id = $2",
        [namespace.id, succeeded.agentId],
      );
      assert.equal(revisions.rowCount, 1);
      assert.deepEqual(
        computeDriver.calls
          .filter(({ operation }) => operation === "provisionAgentRuntimeCredentials")
          .map(({ agentId }) => agentId),
        [succeeded.agentId],
      );
    },
  );
}

export function registerNameAndSecretCases() {
  test(
    "provisioning refuses a taken Agent name at admission; a same-name job admitted alongside fails permanently, says the name is taken and deletes the Configuration it wrote",
    { ...requiresPostgres, timeout: 120_000 },
    async (context) => {
      const configurationDriver = createProvisioningConfigurationDriver({
        id: "configuration-provisioning-duplicate-name",
      });
      const createExact = configurationDriver.createExact;
      const written: string[] = [];
      configurationDriver.createExact = async (configuration) => {
        written.push(configuration.id);
        return createExact(configuration);
      };
      const fixture = await createFixture(context, { configurationDriver });
      const namespace = await fixture.bootstrapNamespace();
      const secrets = await createProvisioningSecrets(fixture, namespace.id);
      const name = `Duplicate ${randomUUID().slice(0, 8)}`;
      const provisionPath = `/namespaces/${namespace.id}/agents/provision`;
      // Admission refuses a name an Agent already has (finding 2420), so only requests admitted
      // before either job creates its Agent reach the worker's Agent insert, where the unique
      // name constraint refuses the later one. That job must report the cause instead of the
      // generic failure text.
      const bodies: ReturnType<typeof provisioningBody>[] = [];
      const admitted: { data: AgentProvisioningResponse["data"] }[] = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const body = provisioningBody(namespace.id, secrets, { name });
        const response = await fixture.requestChecked(
          AgentProvisioningResponse,
          "POST",
          provisionPath,
          { body },
        );
        assert.equal(response.status, 202, JSON.stringify(response.body));
        bodies.push(body);
        admitted.push(response);
      }
      await fixture.startWorker();
      const outcomes = await waitFor("both same-name provisioning jobs to finish", async () => {
        const observed = await Promise.all(
          admitted.map((response) =>
            fixture.requestChecked(
              AgentProvisioningStatusResponse,
              "GET",
              response.data.provisioning.url,
            ),
          ),
        );
        for (const response of observed) {
          assert.equal(response.status, 200, JSON.stringify(response.body));
        }
        return observed.every(({ data }) => data.status === "succeeded" || data.status === "failed")
          ? observed.map(({ data }) => data)
          : undefined;
      });
      assert.deepEqual(outcomes.map(({ status }) => status).sort(), ["failed", "succeeded"]);
      const winner = outcomes.findIndex(({ status }) => status === "succeeded");
      const created = handedOff(required(outcomes[winner]));
      const duplicate = required(admitted[1 - winner]);
      fixture.cancelProvisioningAtTeardown(namespace.id, created.agentId);
      // The status read takes the job and the queue row in separate statements, so the
      // poll that first sees the failure can miss the recorded error. Read the settled job.
      const failed = await fixture.requestChecked(
        AgentProvisioningStatusResponse,
        "GET",
        duplicate.data.provisioning.url,
      );
      assert.equal(failed.status, 200, JSON.stringify(failed.body));
      assert.equal(failed.data.status, "failed");
      assert.deepEqual(failed.data.error, {
        code: "PROVISIONING_REJECTED",
        message: AGENT_NAME_CONFLICT,
      });

      // A resend of the admitted request returns its job before the name check, even though
      // that job's Agent now holds the name: a console whose first response was lost reads a
      // name 409 on retry as "never admitted" and would offer a fresh request for its own name.
      const resent = await fixture.requestChecked(
        AgentProvisioningResponse,
        "POST",
        provisionPath,
        { body: bodies[winner] },
      );
      assert.equal(resent.status, 202, JSON.stringify(resent.body));
      assert.equal(
        resent.data.provisioning.workId,
        required(admitted[winner]).data.provisioning.workId,
      );

      // Now that the Agent exists, admission answers Agent create's 409 and queues no job.
      const refused = await fixture.request("POST", provisionPath, {
        body: provisioningBody(namespace.id, secrets, { name }),
      });
      assert.equal(refused.status, 409, JSON.stringify(refused.body));
      assert.equal(provisioningError(refused).code, "RESOURCE_CONFLICT");
      assert.equal(provisioningError(refused).message, AGENT_NAME_CONFLICT);
      // The name check comes last, as in the preflight and Agent create: a taken name with a
      // Secret binding that names no Secret gets the binding's refusal, so a rename does not
      // uncover a second refusal.
      const unboundBody = provisioningBody(namespace.id, secrets, { name });
      unboundBody.configuration.secretBindings.EXTERNAL_SERVICE_TOKEN.source = secretRef(
        namespace.id,
        `sec_${randomUUID()}`,
      );
      const unbound = await fixture.request("POST", provisionPath, { body: unboundBody });
      assert.equal(unbound.status, 404, JSON.stringify(unbound.body));
      assert.equal(provisioningError(unbound).code, "NOT_FOUND");
      const jobs = await fixture.pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM occ.agent_provisioning_work WHERE namespace_id = $1",
        [namespace.id],
      );
      assert.equal(required(jobs.rows[0]).count, 2);
      const work = await fixture.pool.query<{
        state: ControllerWorkState;
        reason_code: string | null;
      }>(
        "SELECT state, reason_code FROM occ.controller_work WHERE work_kind = 'provisioning' AND namespace_id = $1 AND idempotency_key = $2",
        [namespace.id, duplicate.data.provisioning.workId],
      );
      assert.deepEqual(work.rows, [
        { state: "failed_permanent", reason_code: "PROVISIONING_REJECTED" },
      ]);
      const agents = await fixture.pool.query<{ id: string }>(
        "SELECT id FROM occ.agents WHERE namespace_id = $1",
        [namespace.id],
      );
      assert.deepEqual(
        agents.rows.map(({ id }) => id),
        [created.agentId],
      );

      // The worker wrote the duplicate's Configuration before the Agent insert refused it and
      // rolled back its record. The refusal deletes that unrecorded document (in Kubernetes, a
      // ConfigMap no Configuration answers for; finding 1395) and the job forgets it. The delete
      // runs before the refusal commits, so it is done once the job reads as failed.
      assert.equal(written.length, 2);
      assert.ok(written.includes(created.configurationId));
      const rejectedConfiguration = {
        namespaceId: namespace.id,
        id: required(written.find((id) => id !== created.configurationId)),
      };
      assert.equal(configurationDriver.stored(rejectedConfiguration), undefined);
      // The delete succeeded, so nothing stays marked for a later attempt to delete either.
      const rejectedRecord = await fixture.pool.query<{
        completed_phase: ProvisioningPhase;
        configuration_id: string | null;
        pending: boolean;
        receipt: boolean;
        marked: boolean;
      }>(
        `SELECT completed_phase, configuration_id, progress ? 'pendingEffect' AS pending,
                progress ? 'effectReceipt' AS receipt,
                progress ? 'unrecordedConfigurationId' AS marked
         FROM occ.agent_provisioning_work WHERE work_id = $1`,
        [duplicate.data.provisioning.workId],
      );
      assert.deepEqual(rejectedRecord.rows, [
        {
          completed_phase: "admitted",
          configuration_id: null,
          pending: false,
          receipt: false,
          marked: false,
        },
      ]);

      // The preflight probes the same name index: in this Namespace only, case as typed, and an
      // Agent being deleted keeps its name until it is gone. Another Namespace's names stay private.
      const preflight = (namespaceId: string, probe: unknown) =>
        fixture.request("POST", `/namespaces/${namespaceId}/agents/validate`, {
          body: { configuration: { kind: "agent", values: {} }, name: probe },
        });
      assert.equal((await preflight(namespace.id, name)).status, 409);
      assert.equal((await preflight(namespace.id, name.toLowerCase())).status, 204);
      await fixture.stopWorker();
      const other = await fixture.bootstrapNamespace();
      assert.equal((await preflight(other.id, name)).status, 204);

      // Once the name is free, a retry writes a new Configuration instead of trusting a receipt
      // for the deleted one, and provisioning completes with a readable Configuration.
      const agentPath = `/namespaces/${namespace.id}/agents/${created.agentId}`;
      const deleting = await fixture.request("DELETE", agentPath);
      assert.equal(deleting.status, 202, JSON.stringify(deleting.body));
      // With no worker running, the Agent stays deleting and its name stays taken.
      const whileDeleting = await preflight(namespace.id, name);
      assert.equal(whileDeleting.status, 409, JSON.stringify(whileDeleting.body));
      assert.equal(provisioningError(whileDeleting).message, AGENT_NAME_CONFLICT);
      await fixture.startWorker();
      await waitFor(
        "the first Agent deletion to finish",
        async () => {
          const observed = await fixture.request("GET", agentPath);
          return observed.status === 404 ? true : undefined;
        },
        30_000,
      );
      const retried = await fixture.requestChecked(
        AgentProvisioningStatusResponse,
        "POST",
        `${duplicate.data.provisioning.url}/retry`,
      );
      assert.equal(retried.status, 202, JSON.stringify(retried.body));
      const succeeded = await waitFor("the retried provisioning to succeed", async () => {
        const observed = await fixture.requestChecked(
          AgentProvisioningStatusResponse,
          "GET",
          duplicate.data.provisioning.url,
        );
        assert.equal(observed.status, 200, JSON.stringify(observed.body));
        assert.notEqual(observed.data.status, "failed", JSON.stringify(observed.body));
        return observed.data.status === "succeeded" ? handedOff(observed.data) : undefined;
      });
      fixture.cancelProvisioningAtTeardown(namespace.id, succeeded.agentId);
      assert.equal(written.length, 3);
      assert.equal(succeeded.configurationId, written[2]);
      assert.notEqual(succeeded.configurationId, rejectedConfiguration.id);
      assert.notEqual(
        configurationDriver.stored({ namespaceId: namespace.id, id: succeeded.configurationId }),
        undefined,
      );
      assert.equal(configurationDriver.stored(rejectedConfiguration), undefined);
    },
  );

  test(
    "pending provisioning blocks deleting its Secrets; a failed plan's retry names the deleted one",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const configurationDriver = createProvisioningConfigurationDriver({
        id: "configuration-provisioning-secret-delete",
      });
      let configurationOutage = true;
      const createExact = configurationDriver.createExact;
      const inspectExact = configurationDriver.inspectExact;
      // The outage answers no Configuration request, so the unknown create runs out of attempts.
      configurationDriver.createExact = async (configuration) => {
        if (configurationOutage) {
          throw new Error("synthetic Configuration outage");
        }
        return createExact(configuration);
      };
      configurationDriver.inspectExact = async (configuration) => {
        if (configurationOutage) {
          throw new Error("synthetic Configuration outage");
        }
        return inspectExact(configuration);
      };
      const fixture = await createFixture(context, { configurationDriver });
      const namespace = await fixture.bootstrapNamespace();
      const secrets = await createProvisioningSecrets(fixture, namespace.id);
      const admitted = await requestAcceptedProvisioning(fixture, namespace.id, secrets);
      const secretPath = (secret: SecretWire) => `/namespaces/${namespace.id}/secrets/${secret.id}`;

      // Queued: no Configuration or Agent names these Secrets yet, only the accepted plan. Its
      // actor, who holds the grants a status read checks, sees the request as a consumer.
      const { workId } = admitted.data.provisioning;
      for (const secret of [secrets.slackBotToken, secrets.modelKey]) {
        const refused = await fixture.request("DELETE", secretPath(secret));
        assert.equal(refused.status, 409, JSON.stringify(refused.body));
        assert.equal(
          provisioningError(refused).message,
          `The Secret is still referenced by pending Agent provisioning request ${workId}. Remove those references, or let provisioning finish, first.`,
        );
        const read = await fixture.requestChecked(SecretDetailResponse, "GET", secretPath(secret));
        assert.equal(read.status, 200, JSON.stringify(read.body));
        assert.deepEqual(read.data.consumers, {
          agents: [],
          configurations: [],
          credentialSources: [],
          provisioningRequests: [workId],
          unreadable: 0,
          truncated: false,
        });
      }

      await fixture.startWorker();
      const failed = await waitFor(
        "Agent provisioning to fail before its Configuration",
        async () => {
          const observed = await fixture.requestChecked(
            AgentProvisioningStatusResponse,
            "GET",
            admitted.data.provisioning.url,
          );
          assert.equal(observed.status, 200, JSON.stringify(observed.body));
          return observed.data.status === "failed" ? observed.data : undefined;
        },
      );
      await fixture.stopWorker();
      assert.equal(failed.phase, "admitted");

      // A failed plan has no owner that would ever remove it, so it does not block deletion.
      const deleted = await fixture.request("DELETE", secretPath(secrets.slackBotToken));
      assert.equal(deleted.status, 204, JSON.stringify(deleted.body));

      // The plan can never run again: reading or retrying it names the deleted Secret
      // instead of answering 404 for a job that exists.
      configurationOutage = false;
      const gone = `Secret ${secrets.slackBotToken.id}, which this provisioning request uses, was deleted. Submit a new Agent provisioning request.`;
      for (const [method, path] of [
        ["GET", admitted.data.provisioning.url],
        ["POST", `${admitted.data.provisioning.url}/retry`],
      ] as const) {
        const refused = await fixture.request(method, path);
        assertApiError(refused, 409, "RESOURCE_CONFLICT", method);
        assert.equal(provisioningError(refused).message, gone);
      }
      const work = await fixture.pool.query<{ state: ControllerWorkState }>(
        "SELECT state FROM occ.controller_work WHERE idempotency_key = $1",
        [admitted.data.provisioning.workId],
      );
      assert.deepEqual(
        work.rows,
        [{ state: "failed_permanent" }],
        "a refused retry queues nothing",
      );
    },
  );

  test(
    "a provisioning request its actor may no longer read is counted, never named, as a Secret consumer",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const fixture = await createFixture(context);
      const namespace = await fixture.bootstrapNamespace();
      const secrets = await createProvisioningSecrets(fixture, namespace.id);
      // No worker runs, so the request stays queued and keeps referencing both Secrets.
      const admitted = await requestAcceptedProvisioning(fixture, namespace.id, secrets);
      const { workId } = admitted.data.provisioning;
      const secretPath = `/namespaces/${namespace.id}/secrets/${secrets.modelKey.id}`;
      assert.deepEqual(
        (await fixture.requestChecked(SecretDetailResponse, "GET", secretPath)).data.consumers
          .provisioningRequests,
        [workId],
      );

      // A status read needs Agent create in the Namespace. Once a Restriction denies it, the
      // actor still reads and may delete the Secret, but no longer sees the request: it is only
      // counted, and the filtering is not itself a denied operation (no 403, no denial audit).
      await fixture.pool.query<Record<string, unknown>>(
        `INSERT INTO occ.iam_restrictions (id, namespace_id, action, resource_kind, resource_id)
         VALUES ($1, $2, 'create', 'agent', NULL)`,
        [`restriction_${randomUUID()}`, namespace.id],
      );
      const denials = async () =>
        (
          await fixture.pool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM occ.audit_events WHERE namespace_id = $1 AND outcome = 'denied'",
            [namespace.id],
          )
        ).rows[0]?.count;
      const denialsBefore = await denials();
      const read = await fixture.requestChecked(SecretDetailResponse, "GET", secretPath);
      assert.equal(read.status, 200, JSON.stringify(read.body));
      assert.deepEqual(read.data.consumers, {
        agents: [],
        configurations: [],
        credentialSources: [],
        provisioningRequests: [],
        unreadable: 1,
        truncated: false,
      });
      const refused = await fixture.request("DELETE", secretPath);
      assert.equal(refused.status, 409, JSON.stringify(refused.body));
      assert.equal(
        provisioningError(refused).message,
        "The Secret is still referenced by 1 resource you cannot read. Remove those references first.",
      );
      for (const body of [read.body, refused.body]) {
        assert.doesNotMatch(JSON.stringify(body), new RegExp(workId));
      }
      const denialsAfter = await denials();
      assert.equal(denialsAfter, denialsBefore);
    },
  );

  test(
    "another administrator's pending provisioning request is counted, never named, as a Secret consumer",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const fixture = await createFixture(context);
      const namespace = await fixture.bootstrapNamespace();
      const secrets = await createProvisioningSecrets(fixture, namespace.id);
      // No worker runs, so administrator A's request stays queued and keeps referencing both Secrets.
      const admitted = await requestAcceptedProvisioning(fixture, namespace.id, secrets);
      const { workId } = admitted.data.provisioning;

      // Administrator B holds A's Installation-wide administrator Role, so every grant a status
      // read checks passes; only the initiating-actor check keeps A's request from B.
      const bindings = await fixture.pool.query<{ role_id: string }>(
        `SELECT role_id FROM occ.iam_access_bindings
         WHERE identity_subject_id = $1 AND namespace_id IS NULL AND resource_kind IS NULL`,
        [await fixture.administratorPrincipalId()],
      );
      assert.equal(bindings.rows.length, 1, JSON.stringify(bindings.rows));
      const { role_id: administratorRoleId } = required(bindings.rows[0]);
      const second = {
        email: `postgres-agent-provisioning-second-${randomUUID()}@example.test`,
        password: `generated-password-${randomUUID()}`,
      };
      const created = await fixture.requestChecked(
        authAccountResponse,
        "POST",
        "/api/auth/accounts",
        {
          body: { ...second, name: "Second administrator", roleId: administratorRoleId },
        },
      );
      assert.equal(created.status, 201, JSON.stringify(created.body));
      // Account seeds scope their binding to the Installation resource; B also holds the Role
      // across the Installation, like the bootstrap administrator.
      await fixture.pool.query<Record<string, unknown>>(
        `INSERT INTO occ.iam_access_bindings (id, identity_subject_id, role_id) VALUES ($1, $2, $3)`,
        [`binding_second_admin_${randomUUID()}`, created.data.principalId, administratorRoleId],
      );
      const secondSession = await signInToControllerApp(fixture.app, second);
      const status = await fixture.request("GET", admitted.data.provisioning.url, {
        session: secondSession,
      });
      assert.equal(status.status, 403, JSON.stringify(status.body));
      assert.equal(
        provisioningError(status).message,
        "Only the initiating actor can read provisioning status.",
      );
      // A retry says what was refused (finding 2588).
      const retry = await fixture.request("POST", `${admitted.data.provisioning.url}/retry`, {
        session: secondSession,
      });
      assertApiError(retry, 403, "FORBIDDEN");
      assert.equal(
        provisioningError(retry).message,
        "Only the initiating actor can retry provisioning.",
      );

      const secretPath = `/namespaces/${namespace.id}/secrets/${secrets.modelKey.id}`;
      const own = await fixture.requestChecked(SecretDetailResponse, "GET", secretPath);
      assert.equal(own.status, 200, JSON.stringify(own.body));
      assert.deepEqual(own.data.consumers.provisioningRequests, [workId]);

      const read = await fixture.requestChecked(SecretDetailResponse, "GET", secretPath, {
        session: secondSession,
      });
      assert.equal(read.status, 200, JSON.stringify(read.body));
      assert.deepEqual(read.data.consumers, {
        agents: [],
        configurations: [],
        credentialSources: [],
        provisioningRequests: [],
        unreadable: 1,
        truncated: false,
      });
      const refused = await fixture.request("DELETE", secretPath, { session: secondSession });
      assert.equal(refused.status, 409, JSON.stringify(refused.body));
      assert.equal(
        provisioningError(refused).message,
        "The Secret is still referenced by 1 resource you cannot read. Remove those references first.",
      );
      for (const body of [read.body, refused.body]) {
        assert.doesNotMatch(JSON.stringify(body), new RegExp(workId));
      }
    },
  );
}

export function registerConfigurationAndAccountCases() {
  test(
    "pending provisioning blocks deleting its ServiceAccount; a failed plan's retry names the deleted one",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const fixture = await createFixture(context);
      const namespace = await fixture.bootstrapNamespace();
      const secrets = await createProvisioningSecrets(fixture, namespace.id);
      const created = await fixture.requestChecked(
        ServiceAccountResponse,
        "POST",
        `/namespaces/${namespace.id}/service-accounts`,
        {
          body: { name: `provisioning-account-${randomUUID().slice(0, 8)}` },
        },
      );
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const account = created.data;
      // Admission would reject this account, which has no Backend-issued credential, so store
      // the plan directly; the worker fails it for the same reason before any effect.
      // Omit Gateway managed mode as in plans accepted before that field existed.
      const actorId = await fixture.administratorPrincipalId();
      const body = provisioningBody(namespace.id, secrets);
      const workId = `agent-provisioning:${randomUUID().replaceAll("-", "")}`;
      await fixture.state.transact((unit) =>
        unit.provisioning.create({
          workId,
          namespaceId: namespace.id,
          actorId,
          requestId: body.requestId,
          requestFingerprint: "0".repeat(64),
          plan: {
            name: body.name,
            configuration: body.configuration,
            harnessAuth: {
              method: "codex_pat",
              source: { kind: "service_account", namespaceId: account.namespaceId, id: account.id },
            },
            executionMode: body.executionMode,
            drivers: {
              compute: fixture.computeDriver.id,
              configuration: fixture.configurationDriver.id,
              iam: "native-iam",
            },
          },
        }),
      );
      const provisioningUrl = `/namespaces/${namespace.id}/agents/provision/${workId}`;
      const accountPath = `/namespaces/${namespace.id}/service-accounts/${account.id}`;

      // Queued: no Agent names this account yet, only the accepted plan.
      const refused = await fixture.request("DELETE", accountPath);
      assert.equal(refused.status, 409, `DELETE ${JSON.stringify(refused.body)}`);
      assert.equal(
        provisioningError(refused).message,
        "An Agent draft, active revision, pending deployment, or pending Agent provisioning request still references the ServiceAccount. Remove those references, or let provisioning finish, first.",
      );

      // The account has no issued credential, so the worker fails the plan before any effect.
      await fixture.startWorker();
      await waitFor("Agent provisioning to fail before its Configuration", async () => {
        const { rows } = await fixture.pool.query<{ status: AgentProvisioningRecord["status"] }>(
          "SELECT status FROM occ.agent_provisioning_work WHERE work_id = $1",
          [workId],
        );
        return rows[0]?.status === "failed" ? true : undefined;
      });
      await fixture.stopWorker();
      // This Installation has no ChatGPT Backend, so the failure names it instead of the
      // generic text.
      const job = await fixture.pool.query<{ error: unknown }>(
        "SELECT progress->'error' AS error FROM occ.agent_provisioning_work WHERE work_id = $1",
        [workId],
      );
      assert.deepEqual(job.rows, [
        {
          error: {
            code: "PROVISIONING_REJECTED",
            message: new ServiceAccountDriverNotConfiguredError("deploy").message,
          },
        },
      ]);
      const workState = async () =>
        (
          await fixture.pool.query<{ state: ControllerWorkState }>(
            "SELECT state FROM occ.controller_work WHERE idempotency_key = $1",
            [workId],
          )
        ).rows;
      const failedWork = await workState();

      // A failed plan has no owner that would ever remove it, so it does not block deletion.
      const deleted = await fixture.request("DELETE", accountPath);
      assert.equal(deleted.status, 204, JSON.stringify(deleted.body));

      const gone = `ServiceAccount ${account.id}, which this provisioning request uses, was deleted. Submit a new Agent provisioning request.`;
      for (const [method, path] of [
        ["GET", provisioningUrl],
        ["POST", `${provisioningUrl}/retry`],
      ] as const) {
        const answered = await fixture.request(method, path);
        assertApiError(answered, 409, "RESOURCE_CONFLICT", method);
        assert.equal(provisioningError(answered).message, gone);
      }
      assert.deepEqual(await workState(), failedWork, "a refused retry queues nothing");
    },
  );

  test(
    "a pending provisioning request is named as a Secret consumer only while its actor may read its ServiceAccount",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const fixture = await createFixture(context);
      const namespace = await fixture.bootstrapNamespace();
      const secrets = await createProvisioningSecrets(fixture, namespace.id);
      const created = await fixture.requestChecked(
        ServiceAccountResponse,
        "POST",
        `/namespaces/${namespace.id}/service-accounts`,
        {
          body: { name: `consumer-account-${randomUUID().slice(0, 8)}` },
        },
      );
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const account = created.data;
      // Admission needs a Backend-issued account, which this fixture cannot issue, so the plan is
      // stored directly (as above). No worker runs: it stays queued and keeps referencing its Secrets.
      const actorId = await fixture.administratorPrincipalId();
      const body = provisioningBody(namespace.id, secrets);
      const workId = `agent-provisioning:${randomUUID().replaceAll("-", "")}`;
      await fixture.state.transact((unit) =>
        unit.provisioning.create({
          workId,
          namespaceId: namespace.id,
          actorId,
          requestId: body.requestId,
          requestFingerprint: "0".repeat(64),
          plan: {
            name: body.name,
            configuration: body.configuration,
            harnessAuth: {
              method: "codex_pat",
              source: { kind: "service_account", namespaceId: account.namespaceId, id: account.id },
            },
            executionMode: body.executionMode,
            gatewayManagedMode: true,
            drivers: {
              compute: fixture.computeDriver.id,
              configuration: fixture.configurationDriver.id,
              iam: "native-iam",
            },
          },
        }),
      );
      const secretPath = `/namespaces/${namespace.id}/secrets/${secrets.slackBotToken.id}`;
      const consumers = async () => {
        const read = await fixture.requestChecked(SecretDetailResponse, "GET", secretPath);
        assert.equal(read.status, 200, JSON.stringify(read.body));
        return read.data.consumers;
      };
      assert.deepEqual((await consumers()).provisioningRequests, [workId]);

      // The status read checks the plan's account read; once denied, the request is only counted.
      await fixture.pool.query<Record<string, unknown>>(
        `INSERT INTO occ.iam_restrictions (id, namespace_id, action, resource_kind, resource_id)
         VALUES ($1, $2, 'read', 'service_account', $3)`,
        [`restriction_${randomUUID()}`, namespace.id, account.id],
      );
      const hidden = await consumers();
      assert.deepEqual(hidden.provisioningRequests, []);
      assert.equal(hidden.unreadable, 1);
      assert.doesNotMatch(JSON.stringify(hidden), new RegExp(workId));
    },
  );

  test(
    "a provisioned Agent's first Configuration is deletable after the Agent switches away",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const { configurationDriver, deleted } = recordingConfigurationDriver();
      const fixture = await createFixture(context, { configurationDriver });
      const namespace = await fixture.bootstrapNamespace();
      const created = required((await provisionAgents(fixture, namespace.id))[0]);
      const replacement = await createAgentConfiguration(fixture, namespace.id);
      await selectConfiguration(fixture, namespace.id, created.agentId, replacement);

      // No Agent selects the first Configuration, so the succeeded provisioning record
      // releases it and the ordinary deletion proceeds.
      const configurationPath = `/namespaces/${namespace.id}/configurations/${created.configurationId}`;
      const removed = await fixture.request("DELETE", configurationPath);
      assert.equal(removed.status, 204, JSON.stringify(removed.body));
      assert.deepEqual(deleted, [created.configurationId]);
      const gone = await fixture.request("GET", configurationPath);
      assert.equal(gone.status, 404, JSON.stringify(gone.body));
      assert.equal(await provisioningConfigurationId(fixture.pool, created.workId), null);
      const status = await fixture.requestChecked(
        AgentProvisioningStatusResponse,
        "GET",
        created.url,
      );
      assert.equal(status.status, 200, JSON.stringify(status.body));
      assert.equal(status.data.status, "succeeded");
      assert.equal(status.data.agentId, created.agentId);
      assert.equal(status.data.configurationId, undefined);
    },
  );

  test(
    "a provisioned Agent's first Configuration stays held while the Agent selects it, including after switching back",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const { configurationDriver, deleted } = recordingConfigurationDriver();
      const fixture = await createFixture(context, { configurationDriver });
      const namespace = await fixture.bootstrapNamespace();
      const created = required((await provisionAgents(fixture, namespace.id))[0]);
      const agentReference = /An Agent still references the Configuration/;
      await assertConfigurationDeletionRefused(
        fixture,
        namespace.id,
        created.configurationId,
        agentReference,
      );
      // The database refuses a release while the provisioned Agent selects the Configuration.
      await assert.rejects(
        fixture.pool.query<Record<string, unknown>>(
          "UPDATE occ.agent_provisioning_work SET configuration_id = NULL WHERE work_id = $1",
          [created.workId],
        ),
        { code: "23514", message: /terminal agent provisioning work is immutable/ },
      );

      const replacement = await createAgentConfiguration(fixture, namespace.id);
      // A release may only clear the Configuration, never move the record to another one.
      await assert.rejects(
        fixture.pool.query<Record<string, unknown>>(
          "UPDATE occ.agent_provisioning_work SET configuration_id = $2 WHERE work_id = $1",
          [created.workId, replacement],
        ),
        { code: "23514" },
      );
      await selectConfiguration(fixture, namespace.id, created.agentId, replacement);
      await selectConfiguration(fixture, namespace.id, created.agentId, created.configurationId);
      await assertConfigurationDeletionRefused(
        fixture,
        namespace.id,
        created.configurationId,
        agentReference,
      );
      assert.equal(
        await provisioningConfigurationId(fixture.pool, created.workId),
        created.configurationId,
      );
      assert.deepEqual(deleted, []);

      await selectConfiguration(fixture, namespace.id, created.agentId, replacement);
      const removed = await fixture.request(
        "DELETE",
        `/namespaces/${namespace.id}/configurations/${created.configurationId}`,
      );
      assert.equal(removed.status, 204, JSON.stringify(removed.body));
      assert.deepEqual(deleted, [created.configurationId]);
    },
  );

  test(
    "a provisioned Configuration another Agent selects stays held after its own Agent switches away",
    { ...requiresPostgres, timeout: 90_000 },
    async (context) => {
      const { configurationDriver, deleted } = recordingConfigurationDriver();
      const fixture = await createFixture(context, { configurationDriver });
      const namespace = await fixture.bootstrapNamespace();
      const [first, second] = (await provisionAgents(fixture, namespace.id, 2)).map((agent) =>
        required(agent),
      );
      assert.ok(first && second);
      // Swap the two Agents' Configurations: each provisioned Configuration loses its own
      // Agent but is still selected by the other one.
      await selectConfiguration(fixture, namespace.id, first.agentId, second.configurationId);
      await selectConfiguration(fixture, namespace.id, second.agentId, first.configurationId);
      for (const provisioned of [first, second]) {
        await assertConfigurationDeletionRefused(
          fixture,
          namespace.id,
          provisioned.configurationId,
          /An Agent still references the Configuration/,
        );
        assert.equal(
          await provisioningConfigurationId(fixture.pool, provisioned.workId),
          provisioned.configurationId,
        );
      }
      assert.deepEqual(deleted, []);

      // Once the other Agent leaves too, the first provisioned Configuration is free.
      await selectConfiguration(fixture, namespace.id, second.agentId, second.configurationId);
      const removed = await fixture.request(
        "DELETE",
        `/namespaces/${namespace.id}/configurations/${first.configurationId}`,
      );
      assert.equal(removed.status, 204, JSON.stringify(removed.body));
      assert.deepEqual(deleted, [first.configurationId]);
      await assertConfigurationDeletionRefused(
        fixture,
        namespace.id,
        second.configurationId,
        /An Agent still references the Configuration/,
      );
    },
  );

  test(
    "a Namespace is deletable after a refused provisioning wrote and deleted its Configuration",
    { ...requiresPostgres, timeout: 90_000 },
    async (context) => {
      const fixture = await createFixture(context);
      const namespace = await fixture.bootstrapNamespace();
      const secrets = await createProvisioningSecrets(fixture, namespace.id);
      const name = `Duplicate ${randomUUID().slice(0, 8)}`;
      // Admission refuses a name an Agent already has (finding 2420), so both same-name requests
      // are admitted before the worker runs; the later Agent insert hits the name conflict.
      const admitted: { data: AgentProvisioningResponse["data"] }[] = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await fixture.requestChecked(
          AgentProvisioningResponse,
          "POST",
          `/namespaces/${namespace.id}/agents/provision`,
          { body: provisioningBody(namespace.id, secrets, { name }) },
        );
        assert.equal(response.status, 202, JSON.stringify(response.body));
        admitted.push(response);
      }
      await fixture.startWorker();
      try {
        const outcomes = await waitFor("both same-name provisioning jobs to finish", async () => {
          const observed = await Promise.all(
            admitted.map((response) =>
              fixture.requestChecked(
                AgentProvisioningStatusResponse,
                "GET",
                response.data.provisioning.url,
              ),
            ),
          );
          for (const response of observed) {
            assert.equal(response.status, 200, JSON.stringify(response.body));
          }
          return observed.every(
            ({ data }) => data.status === "succeeded" || data.status === "failed",
          )
            ? observed.map(({ data }) => data)
            : undefined;
        });
        assert.deepEqual(outcomes.map(({ status }) => status).sort(), ["failed", "succeeded"]);
        const winner = outcomes.findIndex(({ status }) => status === "succeeded");
        const created = handedOff(required(outcomes[winner]));
        const duplicate = required(admitted[1 - winner]);
        await waitFor("duplicate-name Agent provisioning to fail", async () => {
          const work = await fixture.pool.query<{ state: ControllerWorkState }>(
            "SELECT state FROM occ.controller_work WHERE idempotency_key = $1",
            [duplicate.data.provisioning.workId],
          );
          return work.rows[0]?.state === "failed_permanent" ? true : undefined;
        });

        // The worker wrote the Configuration through its Driver and recorded the receipt,
        // then the Agent insert hit the name conflict and rolled back the metadata. The
        // refusal deleted that write and the job forgot it, so nothing remains in flight.
        const failed = await fixture.pool.query<{
          status: AgentProvisioningRecord["status"];
          completed_phase: ProvisioningPhase;
          pending: boolean;
          receipt: boolean;
        }>(
          `SELECT status, completed_phase, progress ? 'pendingEffect' AS pending,
                  progress ? 'effectReceipt' AS receipt
           FROM occ.agent_provisioning_work WHERE work_id = $1`,
          [duplicate.data.provisioning.workId],
        );
        assert.deepEqual(failed.rows, [
          { status: "failed", completed_phase: "admitted", pending: false, receipt: false },
        ]);

        // Empty the Namespace of everything else, as an administrator would.
        const agentPath = `/namespaces/${namespace.id}/agents/${created.agentId}`;
        const deleting = await fixture.request("DELETE", agentPath);
        assert.equal(deleting.status, 202, JSON.stringify(deleting.body));
        await waitFor(
          "the first Agent deletion to finish",
          async () => {
            const observed = await fixture.request("GET", agentPath);
            return observed.status === 404 ? true : undefined;
          },
          30_000,
        );
        const configuration = await fixture.request(
          "DELETE",
          `/namespaces/${namespace.id}/configurations/${created.configurationId}`,
        );
        assert.ok(
          [200, 204, 404].includes(configuration.status),
          JSON.stringify(configuration.body),
        );
        for (const secret of Object.values(secrets)) {
          const removed = await fixture.request(
            "DELETE",
            `/namespaces/${namespace.id}/secrets/${secret.id}`,
          );
          assert.ok([200, 204].includes(removed.status), JSON.stringify(removed.body));
        }

        const deleted = await fixture.requestChecked(
          NamespaceResponse,
          "DELETE",
          `/namespaces/${namespace.id}`,
        );
        assert.equal(deleted.status, 202, JSON.stringify(deleted.body));
        assert.equal(deleted.data.status, "deleting");
      } finally {
        await fixture.stopWorker();
      }
    },
  );
}

export function registerRetainedPlanCase() {
  test(
    "failed provisioning keeps the accepted plan reserved until retry or deletion",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const computeDriver = createRuntimeComputeDriver();
      const provisionRuntimeCredentials = computeDriver.provisionAgentRuntimeCredentials;
      const getRuntimeCredentialStatus = computeDriver.getAgentRuntimeCredentialStatus;
      let failTransportSettlement = true;
      let reportTransportConfigured = false;
      computeDriver.provisionAgentRuntimeCredentials = async (...args) => {
        const status = await provisionRuntimeCredentials(...args);
        if (failTransportSettlement) {
          throw new Error("synthetic transport settlement failure");
        }
        return status;
      };
      computeDriver.getAgentRuntimeCredentialStatus = async (...args) =>
        reportTransportConfigured
          ? getRuntimeCredentialStatus(...args)
          : { transportConfigured: false };
      const fixture = await createFixture(context, { computeDriver });
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

      await fixture.startWorker();
      const failed = await waitFor(
        "Agent provisioning to fail after transport effect",
        async () => {
          const observed = await fixture.requestChecked(
            AgentProvisioningStatusResponse,
            "GET",
            admitted.data.provisioning.url,
          );
          assert.equal(observed.status, 200, JSON.stringify(observed.body));
          return observed.data.status === "failed" ? observed.data : undefined;
        },
      );
      assert.equal(failed.phase, "configuration");
      assert.equal(failed.error?.code, "PROVISIONING_OUTCOME_UNKNOWN");
      assert.match(required(failed.agentId), identifier("agt"));
      assert.match(required(failed.configurationId), identifier("cfg"));
      fixture.cancelProvisioningAtTeardown(namespace.id, required(failed.agentId));
      await fixture.stopWorker();

      const configuration = await fixture.requestChecked(
        ConfigurationResponse,
        "GET",
        `/namespaces/${namespace.id}/configurations/${failed.configurationId}`,
      );
      assert.equal(configuration.status, 200, JSON.stringify(configuration.body));

      // Another Agent cannot take over the reserved Configuration either.
      const otherConfiguration = await fixture.requestChecked(
        ConfigurationResponse,
        "POST",
        `/namespaces/${namespace.id}/configurations`,
        { body: { kind: "agent", values: {} } },
      );
      assert.equal(otherConfiguration.status, 201, JSON.stringify(otherConfiguration.body));
      const other = await fixture.requestChecked(
        AgentResponse,
        "POST",
        `/namespaces/${namespace.id}/agents`,
        {
          body: { name: "unreserved-agent", configurationId: otherConfiguration.data.id },
        },
      );
      assert.equal(other.status, 201, JSON.stringify(other.body));
      const borrowed = [
        await fixture.request("POST", `/namespaces/${namespace.id}/agents`, {
          body: { name: "borrowing-agent", configurationId: failed.configurationId },
        }),
        await fixture.request("PATCH", `/namespaces/${namespace.id}/agents/${other.data.id}`, {
          body: { configurationId: failed.configurationId },
        }),
      ];
      assert.deepEqual(
        borrowed.map((response) => [response.status, provisioningError(response).message]),
        [
          [
            409,
            "The Configuration is reserved for provisioning and is not available for this operation.",
          ],
          [
            409,
            "The Configuration is reserved for provisioning and is not available for this operation.",
          ],
        ],
      );

      const reserved = [
        await fixture.request(
          "POST",
          `/namespaces/${namespace.id}/agents/${failed.agentId}/runtime-credentials`,
          { body: {} },
        ),
        await fixture.request(
          "POST",
          `/namespaces/${namespace.id}/agents/${failed.agentId}/deploy`,
        ),
        await fixture.request("PATCH", `/namespaces/${namespace.id}/agents/${failed.agentId}`, {
          body: { configurationId: failed.configurationId },
        }),
        await fixture.request(
          "PATCH",
          `/namespaces/${namespace.id}/configurations/${failed.configurationId}`,
          {
            body: {
              values: configuration.data.values,
              secretBindings: configuration.data.secretBindings,
              expectedGeneration: configuration.data.generation,
            },
          },
        ),
      ];
      assert.deepEqual(
        reserved.map(({ status }) => status),
        [409, 409, 409, 409],
        "failed pre-handoff provisioning must reserve direct credential, deploy, Agent, and Configuration mutations",
      );
      const agentReserved =
        "The Agent is reserved for provisioning. Stop or delete it, or retry its failed provisioning request.";
      assert.deepEqual(
        reserved.map((response) => {
          const error = provisioningError(response);
          return [error.code, error.message];
        }),
        [
          ["RESOURCE_CONFLICT", agentReserved],
          ["RESOURCE_CONFLICT", agentReserved],
          ["RESOURCE_CONFLICT", agentReserved],
          [
            "RESOURCE_CONFLICT",
            "The Configuration is reserved for provisioning and is not available for this operation.",
          ],
        ],
        "each refusal names the provisioning reservation, not a duplicate",
      );
      // Without the stale-generation detail, the console shows this refusal instead of offering a
      // Reload draft that would meet it again (finding 1511).
      assert.equal(provisioningError(reserved[3]!).details, undefined);
      // The transport write has no receipt, so the failed job still counts as in flight.
      const occupied = await fixture.request("DELETE", `/namespaces/${namespace.id}`);
      assert.equal(occupied.status, 409, JSON.stringify(occupied.body));
      assert.match(provisioningError(occupied).message, /pending Agent provisioning\.$/);

      failTransportSettlement = false;
      reportTransportConfigured = true;
      const retried = await fixture.requestChecked(
        AgentProvisioningStatusResponse,
        "POST",
        `${admitted.data.provisioning.url}/retry`,
      );
      assert.equal(retried.status, 202, JSON.stringify(retried.body));
      assert.equal(retried.data.status, "queued");
      assert.equal(retried.data.error, undefined);

      await fixture.startWorker();
      const succeeded = await waitFor(
        "transport-recovered Agent provisioning to succeed",
        async () => {
          const observed = await fixture.requestChecked(
            AgentProvisioningStatusResponse,
            "GET",
            admitted.data.provisioning.url,
          );
          assert.equal(observed.status, 200, JSON.stringify(observed.body));
          return observed.data.status === "succeeded" ? handedOff(observed.data) : undefined;
        },
      );
      assert.equal(succeeded.revisionId?.startsWith("rev_"), true);

      const revisions = await fixture.pool.query<{ id: string }>(
        "SELECT id FROM occ.agent_revisions WHERE namespace_id = $1 AND agent_id = $2",
        [namespace.id, failed.agentId],
      );
      assert.equal(revisions.rowCount, 1);
    },
  );
}
