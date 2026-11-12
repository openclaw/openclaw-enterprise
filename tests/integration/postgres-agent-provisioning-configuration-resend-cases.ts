import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import type {
  AgentProvisioningResponse,
  AgentProvisioningStatusWire,
  AgentReadWire,
  Configuration,
  ConfigurationDriver,
  ProvisionAgentBody,
  SecretWire,
} from "@openclaw-enterprise/contracts";
import { ConfigurationConflictError } from "../../apps/controller/src/drivers/configuration/kubernetes/index.ts";
import type { ControllerWorkState } from "../../packages/occ/src/index.ts";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { makeWorkDue } from "../helpers/postgres-worker-revision-support.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import type { createProvisioningFixture } from "./postgres-agent-provisioning-fixture.ts";
import { createRuntimeComputeDriver } from "./postgres-agent-provisioning-transport-fixture.ts";

type Fixture = Awaited<ReturnType<typeof createProvisioningFixture>>;
type ResendFixture = Pick<
  Fixture,
  | "bootstrapNamespace"
  | "cancelProvisioningAtTeardown"
  | "pool"
  | "request"
  | "revokeCurrentPrincipal"
  | "startWorker"
  | "stopWorker"
>;
type ProvisioningSecrets = Record<
  "modelKey" | "slackBotToken" | "slackSigningSecret" | "externalServiceToken",
  SecretWire
>;

interface ResendDependencies {
  createFixture: (
    context: TestContext,
    options: { configurationDriver: ConfigurationDriver; computeDriver?: Fixture["computeDriver"] },
  ) => Promise<ResendFixture>;
  createProvisioningConfigurationDriver: (options: { id: string }) => ConfigurationDriver;
  createProvisioningSecrets: (
    fixture: Pick<Fixture, "request">,
    namespaceId: string,
  ) => Promise<ProvisioningSecrets>;
  requestAcceptedProvisioning: (
    fixture: Pick<Fixture, "request">,
    namespaceId: string,
    secrets: ProvisioningSecrets,
    overrides?: Pick<ProvisionAgentBody, "name">,
  ) => Promise<{ data: AgentProvisioningResponse["data"] | undefined }>;
}

function timeoutBeforeFirstCreate(driver: ConfigurationDriver): Configuration[] {
  const createExact = driver.createExact;
  assert.ok(createExact);
  const sent: Configuration[] = [];
  driver.createExact = async (configuration) => {
    sent.push(structuredClone(configuration));
    if (sent.length === 1) {
      // The write deadline passes before the API server receives the create: nothing is
      // stored, and the worker cannot tell that from a create that landed (finding 911).
      throw new Error("synthetic Configuration create timeout before the API server");
    }
    return createExact(configuration);
  };
  return sent;
}

// Stands in for the controller's 90 s Configuration settle window passing: the pending create's
// database-clock start moves 91 s back, and its deferred work becomes claimable now. The
// effect's owner and target stay exactly as the worker recorded them.
async function elapseConfigurationSettleWindow(fixture: Pick<Fixture, "pool">, workId: string) {
  const aged = await fixture.pool.query(
    `UPDATE occ.agent_provisioning_work
     SET progress = jsonb_set(
       progress,
       '{pendingEffect,startedAt}',
       to_jsonb(to_char((clock_timestamp() - interval '91 seconds') AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
     )
     WHERE work_id = $1
       AND progress -> 'pendingEffect' ->> 'kind' = 'configuration'
       AND progress -> 'pendingEffect' ? 'startedAt'`,
    [workId],
  );
  assert.equal(aged.rowCount, 1, "the pending Configuration create must record its start");
  const woken = await makeWorkDue(fixture.pool, { key: workId, state: "queued" });
  assert.equal(woken.rowCount, 1, "the provisioning work must be queued");
}

// Runs the worker until the first Configuration create has failed with an unknown outcome and
// the next attempt has deferred inside the settle window, then stops it.
async function provisionUntilConfigurationSettling(
  fixture: Pick<Fixture, "pool" | "request" | "startWorker" | "stopWorker">,
  { url, workId }: AgentProvisioningStatusWire,
  sent: readonly Configuration[],
) {
  await fixture.startWorker();
  const deferred = await waitFor(
    "the absent Configuration create to wait out its settle window",
    async () => {
      const observed = await fixture.request<AgentProvisioningStatusWire>("GET", url);
      assert.equal(observed.status, 200, JSON.stringify(observed.body));
      assert.ok(observed.data);
      assert.notEqual(observed.data.status, "failed", JSON.stringify(observed.body));
      const work = await fixture.pool.query<{
        state: ControllerWorkState;
        attempt_count: number;
        deferred: boolean;
      }>(
        `SELECT state, attempt_count,
           available_at > clock_timestamp() + interval '30 seconds' AS deferred
         FROM occ.controller_work WHERE idempotency_key = $1`,
        [workId],
      );
      const [row] = work.rows;
      return row?.state === "queued" && row.deferred ? row : undefined;
    },
  );
  await fixture.stopWorker();
  // Only the attempt that sent the create spent an attempt; nothing was sent again yet.
  assert.equal(deferred.attempt_count, 1);
  assert.equal(sent.length, 1);
  const record = await fixture.pool.query<{ code: string | null }>(
    "SELECT progress -> 'error' ->> 'code' AS code FROM occ.agent_provisioning_work WHERE work_id = $1",
    [workId],
  );
  assert.deepEqual(record.rows, [{ code: "PROVISIONING_OUTCOME_UNKNOWN" }]);
}

export function registerConfigurationResendCases({
  createFixture,
  createProvisioningConfigurationDriver,
  createProvisioningSecrets,
  requestAcceptedProvisioning,
}: ResendDependencies): void {
  test(
    "a Configuration create that never reached the API server is sent again after its settle window",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const computeDriver = createRuntimeComputeDriver();
      const configurationDriver = createProvisioningConfigurationDriver({
        id: "configuration-provisioning-resend",
      });
      const sent = timeoutBeforeFirstCreate(configurationDriver);
      const fixture = await createFixture(context, { computeDriver, configurationDriver });
      const namespace = await fixture.bootstrapNamespace();
      const secrets = await createProvisioningSecrets(fixture, namespace.id);
      const admitted = await requestAcceptedProvisioning(fixture, namespace.id, secrets);

      // Inside the window an absent Configuration may still be a late create, so the worker
      // neither resends it nor spends the fixture's three attempts waiting.
      assert.ok(admitted.data);
      const admittedProvisioning = admitted.data.provisioning;
      await provisionUntilConfigurationSettling(fixture, admittedProvisioning, sent);

      await elapseConfigurationSettleWindow(fixture, admittedProvisioning.workId);
      await fixture.startWorker();
      const succeeded = await waitFor(
        "Agent provisioning to succeed after the resend",
        async () => {
          const observed = await fixture.request<AgentProvisioningStatusWire>(
            "GET",
            admittedProvisioning.url,
          );
          assert.equal(observed.status, 200, JSON.stringify(observed.body));
          assert.ok(observed.data);
          assert.notEqual(observed.data.status, "failed", JSON.stringify(observed.body));
          return observed.data.status === "succeeded" ? observed.data : undefined;
        },
      );
      assert.ok(succeeded.agentId);
      fixture.cancelProvisioningAtTeardown(namespace.id, succeeded.agentId);
      await fixture.stopWorker();

      // The resend writes the same Configuration under the same identity, once.
      assert.equal(sent.length, 2);
      const [firstSend] = sent;
      assert.ok(firstSend);
      assert.deepEqual(sent[1], firstSend);
      const agent = await fixture.request<AgentReadWire>(
        "GET",
        `/namespaces/${namespace.id}/agents/${succeeded.agentId}`,
      );
      assert.equal(agent.status, 200, JSON.stringify(agent.body));
      assert.ok(agent.data);
      assert.equal(agent.data.configurationId, firstSend.id);
      assert.deepEqual(
        await configurationDriver.read({ id: firstSend.id, namespaceId: namespace.id }),
        firstSend,
      );
    },
  );

  test(
    "a resent Configuration create that meets a late original settles only an exact match",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const computeDriver = createRuntimeComputeDriver();
      const configurationDriver = createProvisioningConfigurationDriver({
        id: "configuration-provisioning-resend-conflict",
      });
      const createExact = configurationDriver.createExact;
      assert.ok(createExact);
      const sent: Configuration[] = [];
      let lateOriginal: (configuration: Configuration) => Promise<Configuration>;
      configurationDriver.createExact = async (configuration) => {
        sent.push(structuredClone(configuration));
        if (sent.length === 1) {
          throw new Error("synthetic Configuration create timeout");
        }
        // The first create lands just before the resend reaches the API server, which answers
        // that resend and any later one with AlreadyExists, as the Kubernetes Driver reports it.
        if (sent.length === 2) {
          await lateOriginal(configuration);
        }
        throw new ConfigurationConflictError("The Kubernetes ConfigMap create conflicted.");
      };
      const fixture = await createFixture(context, { computeDriver, configurationDriver });
      const namespace = await fixture.bootstrapNamespace();
      const secrets = await createProvisioningSecrets(fixture, namespace.id);
      const provision = () =>
        requestAcceptedProvisioning(fixture, namespace.id, secrets, {
          name: `Resend ${randomUUID().slice(0, 8)}`,
        });

      // The late original is the exact Configuration: the conflict proves it landed, and the
      // exact inspection settles it.
      lateOriginal = (configuration) => createExact(configuration);
      const exact = await provision();
      assert.ok(exact.data);
      const exactProvisioning = exact.data.provisioning;
      await provisionUntilConfigurationSettling(fixture, exactProvisioning, sent);
      await elapseConfigurationSettleWindow(fixture, exactProvisioning.workId);
      await fixture.startWorker();
      const succeeded = await waitFor(
        "Agent provisioning to settle the late original",
        async () => {
          const observed = await fixture.request<AgentProvisioningStatusWire>(
            "GET",
            exactProvisioning.url,
          );
          assert.equal(observed.status, 200, JSON.stringify(observed.body));
          assert.ok(observed.data);
          assert.notEqual(observed.data.status, "failed", JSON.stringify(observed.body));
          return observed.data.status === "succeeded" ? observed.data : undefined;
        },
      );
      assert.ok(succeeded.agentId);
      fixture.cancelProvisioningAtTeardown(namespace.id, succeeded.agentId);
      await fixture.stopWorker();
      assert.equal(sent.length, 2);
      const [firstExactSend] = sent;
      assert.ok(firstExactSend);
      assert.deepEqual(
        await configurationDriver.read({ id: firstExactSend.id, namespaceId: namespace.id }),
        firstExactSend,
      );

      // A different Configuration under the same name is never taken as this request's write:
      // the work is not settled and runs out of attempts, and the stored document is untouched.
      // (This test Driver's inspection answers not found for a mismatch; the Kubernetes one
      // reports a conflict, which fails the attempt the same way.)
      sent.length = 0;
      const foreign = { model: "foreign-configuration" };
      lateOriginal = (configuration) =>
        configurationDriver.create({ ...configuration, values: foreign });
      const mismatched = await provision();
      assert.ok(mismatched.data);
      const mismatchedProvisioning = mismatched.data.provisioning;
      await provisionUntilConfigurationSettling(fixture, mismatchedProvisioning, sent);
      await elapseConfigurationSettleWindow(fixture, mismatchedProvisioning.workId);
      await fixture.startWorker();
      const failed = await waitFor(
        "Agent provisioning to refuse the foreign Configuration",
        async () => {
          const observed = await fixture.request<AgentProvisioningStatusWire>(
            "GET",
            mismatchedProvisioning.url,
          );
          assert.equal(observed.status, 200, JSON.stringify(observed.body));
          assert.ok(observed.data);
          assert.notEqual(observed.data.status, "succeeded", JSON.stringify(observed.body));
          return observed.data.status === "failed" ? observed.data : undefined;
        },
      );
      await fixture.stopWorker();
      assert.equal(failed.error?.code, "PROVISIONING_OUTCOME_UNKNOWN");
      assert.equal(failed.agentId, undefined);
      const [firstMismatchedSend] = sent;
      assert.ok(firstMismatchedSend);
      const stored = await configurationDriver.read({
        id: firstMismatchedSend.id,
        namespaceId: namespace.id,
      });
      assert.deepEqual(stored.values, foreign);
      const metadata = await fixture.pool.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM occ.configurations WHERE namespace_id = $1 AND id = $2",
        [namespace.id, firstMismatchedSend.id],
      );
      assert.equal(metadata.rows[0]?.count, 0);
    },
  );

  test(
    "a Configuration resend follows a fresh authority check and sends nothing once authority is revoked",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const configurationDriver = createProvisioningConfigurationDriver({
        id: "configuration-provisioning-resend-revoked",
      });
      const sent = timeoutBeforeFirstCreate(configurationDriver);
      const inspectExact = configurationDriver.inspectExact;
      assert.ok(inspectExact);
      let inspectionsUntilRevocation = 0;
      configurationDriver.inspectExact = async (configuration) => {
        const inspected = await inspectExact(configuration);
        if (inspectionsUntilRevocation > 0) {
          inspectionsUntilRevocation -= 1;
          if (inspectionsUntilRevocation === 0) {
            await fixture.revokeCurrentPrincipal();
          }
        }
        return inspected;
      };
      const fixture = await createFixture(context, { configurationDriver });
      const namespace = await fixture.bootstrapNamespace();
      const secrets = await createProvisioningSecrets(fixture, namespace.id);
      const admitted = await requestAcceptedProvisioning(fixture, namespace.id, secrets);
      assert.ok(admitted.data);
      const admittedProvisioning = admitted.data.provisioning;
      const { workId } = admittedProvisioning;
      await provisionUntilConfigurationSettling(fixture, admittedProvisioning, sent);
      await elapseConfigurationSettleWindow(fixture, workId);

      // The actor loses authority after the attempt's first checks passed, while the worker is
      // inspecting the absent Configuration, so only the check just before the resend sees it.
      // Revoked authority must send nothing: the create stays an unknown outcome and the work
      // runs out of attempts.
      inspectionsUntilRevocation = 2;
      await fixture.startWorker();
      const work = await waitFor(
        "the revoked provisioning work to run out of attempts",
        async () => {
          const observed = await fixture.pool.query<{
            state: ControllerWorkState;
            reason_code: string | null;
          }>("SELECT state, reason_code FROM occ.controller_work WHERE idempotency_key = $1", [
            workId,
          ]);
          const [row] = observed.rows;
          return row?.state === "failed_permanent" ? row : undefined;
        },
      );
      await fixture.stopWorker();
      assert.equal(work.reason_code, "PROVISIONING_OUTCOME_UNKNOWN");
      assert.equal(sent.length, 1, "revoked authority must not resend the Configuration create");
      const [firstSend] = sent;
      assert.ok(firstSend);
      await assert.rejects(
        configurationDriver.read({ id: firstSend.id, namespaceId: namespace.id }),
        /does not exist/,
      );
    },
  );
}
