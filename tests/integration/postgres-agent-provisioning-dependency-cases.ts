import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Check } from "typebox/value";

import {
  ErrorResponse,
  type AgentProvisioningResponse,
  type AgentProvisioningStatusWire,
  type AuditEvent,
  type ConfigurationDriver,
  type InstallationWire,
  type OpenClawConfigurationDocument,
  type ProvisionAgentBody,
  type SandboxDriver,
  type SecretWire,
} from "../../packages/contracts/src/index.ts";
import {
  CodexPluginDriver,
  OCCPluginDriver,
} from "../../apps/controller/src/drivers/plugin/index.ts";
import {
  ProvisioningSecretDriverError,
  type AgentProvisioningProgress,
  type AgentProvisioningRecord,
  type ControllerWorkState,
  type ProvisioningPendingEffect,
  type WorkClaim,
} from "../../packages/occ/src/index.ts";
import { assertApiError } from "../helpers/api-error.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { openShellSandbox } from "../helpers/openshell-sandbox.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import {
  CODEX_MODEL_ONLY,
  codexRuntimeOffProvider,
  DEPENDENCY_UNAVAILABLE,
  DEDICATED_STORAGE_ROUTING_REQUIRED,
  dedicatedOpenClawSandboxRefusal,
  keepRuntime,
  PROVISIONING_NOT_COMPLETED,
  runtimeIdRequired,
  runtimePoliciesConflict,
  selectablePrimaryRuntimeRequired,
} from "../helpers/refusal-text.mjs";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import { createTestSecretDriver } from "../helpers/secret-driver.ts";
import { waitFor } from "../helpers/wait-for.mjs";
import type { createProvisioningFixture } from "./postgres-agent-provisioning-fixture.ts";
import { createRuntimeComputeDriver } from "./postgres-agent-provisioning-transport-fixture.ts";

type Fixture = Awaited<ReturnType<typeof createProvisioningFixture>>;
type FixtureOptions = Parameters<typeof createProvisioningFixture>[1];
type StopWorkerAfter = NonNullable<FixtureOptions["stopWorkerAfter"]>;
type WorkerEvent = Parameters<StopWorkerAfter>[0];
type RuntimeComputeDriver = ReturnType<typeof createRuntimeComputeDriver>;
type ExactConfigurationDriver = ConfigurationDriver &
  Required<Pick<ConfigurationDriver, "createExact" | "inspectExact">>;
type ProvisioningSecrets = Record<
  "modelKey" | "slackBotToken" | "slackSigningSecret" | "externalServiceToken",
  SecretWire
>;
type ProvisioningBody = ProvisionAgentBody & {
  configuration: {
    values: {
      agents: { defaults: OpenClawConfigurationDocument };
      models?: OpenClawConfigurationDocument;
      gateway?: OpenClawConfigurationDocument;
    };
  };
};

type RuntimePolicyCase = [
  defaults: OpenClawConfigurationDocument,
  providers: OpenClawConfigurationDocument | undefined,
  status: 400 | 409,
  message: string,
];

interface ProvisioningRow {
  status: AgentProvisioningRecord["status"];
  completed_phase: AgentProvisioningRecord["completedPhase"];
  agent_id: string | null;
  configuration_id: string | null;
  progress: {
    error?: AgentProvisioningProgress["error"];
    pendingEffect?: ProvisioningPendingEffect;
  };
}

interface ControllerWorkRow {
  state: ControllerWorkState;
  reason_code: string | null;
  attempt_count: number;
}

interface ProvisioningDependencies {
  createFixture: (context: TestContext, options: FixtureOptions) => Promise<Fixture>;
  createProvisioningSecrets: (
    fixture: Fixture,
    namespaceId: string,
  ) => Promise<ProvisioningSecrets>;
  provisioningBody: (namespaceId: string, secrets: ProvisioningSecrets) => ProvisioningBody;
  createProvisioningConfigurationDriver: (options: { id: string }) => ExactConfigurationDriver;
  provisioningRow: (
    pool: Fixture["pool"],
    namespaceId: string,
    requestId: string,
  ) => Promise<ProvisioningRow>;
}

interface DependencyCases extends ProvisioningDependencies {
  storedProvisioningCounts: (
    pool: Fixture["pool"],
    namespaceId: string,
  ) => Promise<{ jobs: number; agents: number }>;
  claimProvisioningWork: (pool: Fixture["pool"], workId: string) => Promise<WorkClaim>;
}

interface ComputeGatewayDependencies extends ProvisioningDependencies {
  refuseProvisioningWithoutGatewayRouting: (driver: RuntimeComputeDriver) => void;
}

const missingCodexPluginCatalog =
  "No Plugin Driver is enabled for the codex Harness. Remove the Agent's plugins or enable its catalog.";

function dedicatedOpenClawDefaults() {
  return {
    model: "openai/gpt-5",
    models: { "openai/gpt-5": { agentRuntime: { id: "openclaw" } } },
  };
}

function provisioningError(response: { body: unknown }): ErrorResponse["error"] {
  assert.ok(Check(ErrorResponse, response.body), JSON.stringify(response.body));
  return response.body.error;
}

function observeProvisioningRetry() {
  let workId: string | undefined;
  const completed: WorkerEvent[] = [];

  // The retry can be due at once. Stop in the same pass as the matching completion (finding 1610).
  // Until the provisioning work ID is known, this allows Namespace bootstrap to run normally.
  const stopWorkerAfter: StopWorkerAfter = (event) => {
    if (workId === undefined || event.event !== "worker.completed" || event.workId !== workId) {
      return false;
    }
    completed.push(event);
    return true;
  };

  async function expectQueuedRetry(fixture: Fixture, targetWorkId: string) {
    workId = targetWorkId;
    await fixture.startWorker();
    await waitFor("the worker to finish its first provisioning attempt", async () => completed[0]);
    await fixture.stopWorker();
    assert.deepEqual(
      completed.map(({ attempt, outcome, code }) => ({ attempt, outcome, code })),
      [{ attempt: 1, outcome: "retry", code: "PROVISIONING_DEPENDENCY_UNAVAILABLE" }],
    );
    const work = await fixture.pool.query<ControllerWorkRow>(
      "SELECT state, reason_code, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
      [workId],
    );
    assert.deepEqual(work.rows, [{ state: "queued", reason_code: null, attempt_count: 1 }]);
  }

  return { stopWorkerAfter, expectQueuedRetry };
}

export function registerProvisioningDependencyCases({
  createFixture,
  createProvisioningSecrets,
  provisioningBody,
  createProvisioningConfigurationDriver,
  storedProvisioningCounts,
  provisioningRow,
  claimProvisioningWork,
}: DependencyCases): void {
  async function admitPlan(fixture: Fixture, configure?: (body: ProvisioningBody) => void) {
    const { id: namespaceId } = await fixture.bootstrapNamespace();
    const secrets = await createProvisioningSecrets(fixture, namespaceId);
    const body = provisioningBody(namespaceId, secrets);
    configure?.(body);
    const provisionPath = `/namespaces/${namespaceId}/agents/provision`;
    const admitted = await fixture.request<AgentProvisioningResponse["data"]>(
      "POST",
      provisionPath,
      { body },
    );
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    assert.ok(admitted.data);
    const { workId, url } = admitted.data.provisioning;
    return { namespaceId, body, provisionPath, workId, url };
  }

  async function preparePluginSwitch(
    context: TestContext,
    configurationDriver: ConfigurationDriver,
  ) {
    const drivers = {
      computeDriver: createRuntimeComputeDriver(),
      configurationDriver,
      secretDriver: createTestSecretDriver({ id: "secret-provisioning" }),
    };
    const fixture = await createFixture(context, {
      ...drivers,
      pluginDriver: new CodexPluginDriver(),
    });
    const admitted = await admitPlan(fixture, (body) => {
      body.plugins = { "codex-plugin:linear@openai-curated-remote": { enabled: true } };
    });
    return {
      ...admitted,
      fixture,
      switchPluginDriver: () =>
        createFixture(context, { ...drivers, pluginDriver: new OCCPluginDriver() }),
    };
  }

  test(
    "a Plugin Driver switch leaves the provisioning status readable; retry still refuses the plan",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const configurationDriver = createProvisioningConfigurationDriver({
        id: "configuration-provisioning-plugin-switch",
      });
      const createExact = configurationDriver.createExact;
      const inspectExact = configurationDriver.inspectExact;
      let configurationOutage = true;
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
      const { fixture, body, provisionPath, workId, url, switchPluginDriver } =
        await preparePluginSwitch(context, configurationDriver);
      await fixture.startWorker();
      const failed = await waitFor(
        "Agent provisioning to fail before its Configuration",
        async () => {
          const observed = await fixture.request<AgentProvisioningStatusWire>("GET", url);
          assert.equal(observed.status, 200, JSON.stringify(observed.body));
          assert.ok(observed.data);
          return observed.data.status === "failed" ? observed.data : undefined;
        },
      );
      await fixture.stopWorker();
      // Rule out the Configuration outage as the cause of the retry refusal below.
      configurationOutage = false;

      // Restart with only the OpenClaw catalog. Status still returns the persisted failure.
      const switched = await switchPluginDriver();
      const status = await switched.request<AgentProvisioningStatusWire>("GET", url);
      assert.equal(status.status, 200, JSON.stringify(status.body));
      assert.ok(status.data);
      assert.deepEqual(status.data, failed);

      // Retry must resolve the plan's Codex Harness catalog before validating any plugin ID.
      const retried = await switched.request("POST", `${url}/retry`);
      assertApiError(retried, 400, "INVALID_REQUEST");
      const retryError = provisioningError(retried);
      assert.equal(retryError.message, missingCodexPluginCatalog);
      assert.equal(Object.hasOwn(retryError, "details"), false);
      // A replay of the original request rechecks the stored plan, so it is refused the same way
      // and returns no progress.
      const replayed = await switched.request("POST", provisionPath, { body });
      assert.equal(replayed.status, 400, JSON.stringify(replayed.body));
      assert.deepEqual(provisioningError(replayed), retryError);
      const work = await switched.pool.query<Pick<ControllerWorkRow, "state">>(
        "SELECT state FROM occ.controller_work WHERE idempotency_key = $1",
        [workId],
      );
      assert.deepEqual(
        work.rows,
        [{ state: "failed_permanent" }],
        "a refused retry or replay queues nothing",
      );
    },
  );

  test(
    "a Plugin Driver switch before the worker runs rejects the provisioning work without retrying",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const configurationDriver = createProvisioningConfigurationDriver({
        id: "configuration-provisioning-plugin-switch-worker",
      });
      const { workId, url, switchPluginDriver } = await preparePluginSwitch(
        context,
        configurationDriver,
      );

      // The plan was admitted for Codex. A worker with only OpenClaw must refuse it on its first attempt.
      const switched = await switchPluginDriver();
      await switched.startWorker();
      await waitFor("the switched worker to reject the provisioning work", async () => {
        const observed = await switched.request<AgentProvisioningStatusWire>("GET", url);
        assert.equal(observed.status, 200, JSON.stringify(observed.body));
        assert.ok(observed.data);
        return observed.data.status === "failed" ? observed.data : undefined;
      });
      await switched.stopWorker();
      const failed = await switched.request<AgentProvisioningStatusWire>("GET", url);
      assert.equal(failed.status, 200, JSON.stringify(failed.body));
      assert.ok(failed.data);
      assert.ok(failed.data.error);
      assert.equal(failed.data.error.code, "PROVISIONING_REJECTED");
      assert.equal(failed.data.error.message, missingCodexPluginCatalog);
      const work = await switched.pool.query<ControllerWorkRow>(
        "SELECT state, reason_code, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
        [workId],
      );
      assert.deepEqual(work.rows, [
        { state: "failed_permanent", reason_code: "PROVISIONING_REJECTED", attempt_count: 1 },
      ]);
    },
  );

  test(
    "a new dedicated OpenClaw request without a provisioning Sandbox Driver is refused with a 409 naming it",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const fixture = await createFixture(context, {
        computeDriver: createRuntimeComputeDriver(),
        configurationDriver: createProvisioningConfigurationDriver({
          id: "configuration-provisioning-no-sandbox",
        }),
        secretDriver: createTestSecretDriver({ id: "secret-provisioning" }),
      });
      const namespace = await fixture.bootstrapNamespace();
      // The Installation cannot admit dedicated OpenClaw, so it does not report native workers.
      const installation = await fixture.request<InstallationWire>("GET", "/installation");
      assert.equal(installation.status, 200, JSON.stringify(installation.body));
      assert.ok(installation.data);
      assert.equal(installation.data.capabilities?.nativeWorkers, undefined);
      const secrets = await createProvisioningSecrets(fixture, namespace.id);
      const body = provisioningBody(namespace.id, secrets);
      body.configuration.values.agents.defaults = dedicatedOpenClawDefaults();
      // A fixed Installation shape refuses every attempt the same way: a 409 with the reason and
      // the next step, not a 503 the Console reads as an unknown outcome (findings 1609, 3036).
      // Codex does not run this openai model without its plugin, so it offers a Codex model.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const refused = await fixture.request(
          "POST",
          `/namespaces/${namespace.id}/agents/provision`,
          { body },
        );
        assert.equal(refused.status, 409, JSON.stringify(refused.body));
        assert.deepEqual(provisioningError(refused), {
          code: "RESOURCE_CONFLICT",
          message: dedicatedOpenClawSandboxRefusal(false),
        });
      }
      // D832: this dedicated Agent cannot run OpenClaw here, so a refusal for a model Codex runs
      // offers codex alone, at the request's Configuration rules and its admission alike. openclaw
      // would only reach the 409, which then names codex (finding 3036).
      const model = "codex/gpt-5.1";
      const policy = `agents.defaults.models["${model}"]`;
      const provider = "models.providers.codex";
      const runtimePolicies: RuntimePolicyCase[] = [
        [{ model }, undefined, 400, runtimeIdRequired(policy, "codex")],
        [
          { model, models: { [`${model}-mini`]: {} } },
          undefined,
          400,
          selectablePrimaryRuntimeRequired(policy, "codex"),
        ],
        [
          { model, models: { [model]: { agentRuntime: { id: "openclaw" } } } },
          { codex: { agentRuntime: { id: "codex" } } },
          400,
          runtimePoliciesConflict(
            policy,
            "openclaw",
            provider,
            "codex",
            keepRuntime("codex", "openclaw"),
          ),
        ],
        [
          { model, models: { [model]: { agentRuntime: { id: "openclaw" } } } },
          undefined,
          409,
          dedicatedOpenClawSandboxRefusal(true),
        ],
        // Codex on an openai model without the Codex plugin: the next step is a codex/<model>
        // model alone, as openclaw would only reach the 409.
        [
          { model: "openai/gpt-5", models: { "openai/gpt-5": { agentRuntime: { id: "codex" } } } },
          undefined,
          400,
          codexRuntimeOffProvider('agents.defaults.models["openai/gpt-5"]', CODEX_MODEL_ONLY),
        ],
      ];
      for (const [defaults, providers, status, message] of runtimePolicies) {
        const codexBody = provisioningBody(namespace.id, secrets);
        codexBody.configuration.values.agents.defaults = defaults;
        if (providers !== undefined) {
          codexBody.configuration.values.models = { providers };
        }
        const refused = await fixture.request(
          "POST",
          `/namespaces/${namespace.id}/agents/provision`,
          { body: codexBody },
        );
        assert.equal(refused.status, status, JSON.stringify(refused.body));
        assert.equal(provisioningError(refused).message, message);
      }
      // The refusals stored nothing: no provisioning job or Agent.
      assert.deepEqual(await storedProvisioningCounts(fixture.pool, namespace.id), {
        jobs: 0,
        agents: 0,
      });
    },
  );

  test(
    "OpenShell refuses dedicated OpenClaw at provisioning admission unless user namespaces are off, and status reads still report stored work",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      // Native OpenClaw's private workspace preparation needs kubernetes.userNamespaces: false
      // and runs only after a deploy stopped its predecessors (finding 2334). Provisioning admits
      // the plan through the OpenShell Sandbox view, so a request is refused before it is stored.
      const drivers = {
        computeDriver: createRuntimeComputeDriver(),
        configurationDriver: createProvisioningConfigurationDriver({
          id: "configuration-provisioning-openshell-openclaw",
        }),
        secretDriver: createTestSecretDriver({ id: "secret-provisioning" }),
      };
      const compose = (userNamespaces: boolean) => {
        const sandbox = openShellSandbox(context, { userNamespaces }).sandboxDriver;
        // Use the real constructed support declaration and transform. This persistence fixture
        // ends before provider work and does not compose editable Sandbox network policy.
        return createFixture(context, {
          ...drivers,
          sandboxDriver: {
            id: sandbox.id,
            capability: sandbox.capability,
            implementation: sandbox.implementation,
            facets: sandbox.facets,
            supportsHarnessExecutionMode: sandbox.supportsHarnessExecutionMode,
            configureAgent: sandbox.configureAgent.bind(sandbox),
            async provisionHarness() {
              assert.fail("this case ends at provisioning handoff");
            },
            async cleanup() {},
          },
        });
      };
      let fixture = await compose(true);
      const namespace = await fixture.bootstrapNamespace();
      const secrets = await createProvisioningSecrets(fixture, namespace.id);
      const provision = () => {
        const body = provisioningBody(namespace.id, secrets);
        body.configuration.values.agents.defaults = dedicatedOpenClawDefaults();
        return fixture.request<AgentProvisioningResponse["data"]>(
          "POST",
          `/namespaces/${namespace.id}/agents/provision`,
          { body },
        );
      };

      const refused = await provision();
      assert.equal(refused.status, 400, JSON.stringify(refused.body));
      assert.deepEqual(provisioningError(refused), {
        code: "INVALID_REQUEST",
        message:
          "Dedicated OpenClaw needs kubernetes.userNamespaces: false in the OpenShell Sandbox Driver configuration. Select Codex, or ask an operator to set it.",
      });
      assert.deepEqual(await storedProvisioningCounts(fixture.pool, namespace.id), {
        jobs: 0,
        agents: 0,
      });

      // Admitted while the setting is off. After an operator turns it back on, a status read
      // still reports the stored work; only writes go through the Sandbox view again.
      fixture = await compose(false);
      const admitted = await provision();
      assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
      assert.ok(admitted.data);
      // No worker runs here; a later test's worker must not run this job with its Drivers.
      fixture.cancelQueuedWorkAtTeardown(
        admitted.data.provisioning.workId,
        "OpenShell admission case ends at the status read",
      );
      fixture = await compose(true);
      const status = await fixture.request<AgentProvisioningStatusWire>(
        "GET",
        admitted.data.provisioning.url,
      );
      assert.equal(status.status, 200, JSON.stringify(status.body));
      assert.ok(status.data);
      assert.equal(status.data.workId, admitted.data.provisioning.workId);
    },
  );

  test(
    "losing native Sandbox containment before the worker runs leaves provisioning retryable without effects",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const drivers = {
        computeDriver: createRuntimeComputeDriver(),
        configurationDriver: createProvisioningConfigurationDriver({
          id: "configuration-provisioning-native-containment",
        }),
        secretDriver: createTestSecretDriver({ id: "secret-provisioning" }),
        sandboxDriver: {
          id: "sandbox-provisioning",
          capability: "sandbox",
          implementation: "openshell",
          supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
          facets: ["networking", "filesystem", "process"],
          async provisionHarness() {
            assert.fail("a refused plan never reaches the Sandbox");
          },
          async cleanup() {},
        } satisfies SandboxDriver,
      };
      const fixture = await createFixture(context, drivers);
      const { namespaceId, body, provisionPath, workId, url } = await admitPlan(fixture, (body) => {
        body.configuration.values.agents.defaults = dedicatedOpenClawDefaults();
      });

      // The selected Driver has lost process containment since admission. The worker must
      // revalidate the complete Sandbox contract before creating any provisioning resources.
      const retry = observeProvisioningRetry();
      const switched = await createFixture(context, {
        ...drivers,
        sandboxDriver: { ...drivers.sandboxDriver, facets: ["networking", "filesystem"] },
        stopWorkerAfter: retry.stopWorkerAfter,
      });
      await retry.expectQueuedRetry(switched, workId);
      const row = await provisioningRow(switched.pool, namespaceId, body.requestId);
      assert.equal(row.status, "running");
      assert.equal(row.completed_phase, "admitted");
      assert.equal(row.agent_id, null);
      assert.equal(row.configuration_id, null);
      assert.equal(row.progress.pendingEffect, undefined);
      assert.deepEqual(row.progress.error, {
        code: "PROVISIONING_DEPENDENCY_UNAVAILABLE",
        message: PROVISIONING_NOT_COMPLETED,
      });
      const resources = await switched.pool.query<{
        agents: number;
        configurations: number;
        revisions: number;
      }>(
        `SELECT
         (SELECT count(*)::integer FROM occ.agents WHERE namespace_id = $1) AS agents,
         (SELECT count(*)::integer FROM occ.configurations WHERE namespace_id = $1) AS configurations,
         (SELECT count(*)::integer FROM occ.agent_revisions WHERE namespace_id = $1) AS revisions`,
        [namespaceId],
      );
      assert.deepEqual(resources.rows[0], { agents: 0, configurations: 0, revisions: 0 });
      assert.deepEqual(drivers.computeDriver.calls, []);

      // Status and retry both require the current Sandbox contract. Restoring the complete
      // Driver makes the queued status readable and the existing attempt eligible again.
      const message = DEPENDENCY_UNAVAILABLE;
      const status = await switched.request("GET", url);
      assert.equal(status.status, 503, JSON.stringify(status.body));
      assert.equal(provisioningError(status).message, message);
      const retried = await switched.request("POST", `${url}/retry`);
      assert.equal(retried.status, 503, JSON.stringify(retried.body));
      assert.equal(provisioningError(retried).message, message);
      // Replaying the accepted request ID reads the stored work too: the same retryable 503, not
      // the 409 a new request gets for the fixed Installation shape (finding 1614).
      const replayed = await switched.request("POST", provisionPath, { body });
      assert.equal(replayed.status, 503, JSON.stringify(replayed.body));
      assert.equal(provisioningError(replayed).message, message);
      const restoredStatus = await fixture.request<AgentProvisioningStatusWire>("GET", url);
      assert.equal(restoredStatus.status, 200, JSON.stringify(restoredStatus.body));
      assert.ok(restoredStatus.data);
      assert.equal(restoredStatus.data.status, "queued");
      assert.equal(restoredStatus.data.attemptCount, 1);
      assert.equal(restoredStatus.data.error, undefined);
      const restoredRetry = await fixture.request<AgentProvisioningStatusWire>(
        "POST",
        `${url}/retry`,
      );
      assert.equal(restoredRetry.status, 202, JSON.stringify(restoredRetry.body));
      assert.ok(restoredRetry.data);
      assert.equal(restoredRetry.data.workId, workId);

      const cleanupClaim = await claimProvisioningWork(fixture.pool, workId);
      await fixture.state.transact((unit) =>
        unit.provisioning.cancel(cleanupClaim, {
          code: "PROVISIONING_CANCELLED",
          message: "containment revalidation test completed without worker dispatch",
        }),
      );
    },
  );

  test(
    "a Secret Driver switch before the worker runs rejects the provisioning work with the fixed message",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const computeDriver = createRuntimeComputeDriver();
      const configurationDriver = createProvisioningConfigurationDriver({
        id: "configuration-provisioning-secret-switch",
      });
      const fixture = await createFixture(context, {
        computeDriver,
        configurationDriver,
        secretDriver: createTestSecretDriver({ id: "secret-provisioning" }),
      });
      const { namespaceId, body, workId, url } = await admitPlan(fixture);

      // The Installation now selects another Secret Driver, which does not own the Secrets the
      // accepted work binds. Every attempt would refuse them the same way, so the worker fails the
      // work on the first one with the fixed message that names the fix, as status and retry do.
      const replacementSecretDriver = createTestSecretDriver({
        id: "secret-provisioning-replaced",
      });
      const switched = await createFixture(context, {
        computeDriver,
        configurationDriver,
        secretDriver: replacementSecretDriver,
      });
      await switched.startWorker();
      const failed = await waitFor(
        "the switched worker to refuse the provisioning work",
        async () => {
          const row = await provisioningRow(switched.pool, namespaceId, body.requestId);
          return row.progress.error === undefined ? undefined : row;
        },
      );
      await switched.stopWorker();
      const message = new ProvisioningSecretDriverError().message;
      assert.equal(failed.status, "failed");
      assert.deepEqual(failed.progress.error, { code: "PROVISIONING_REJECTED", message });
      assert.equal(failed.agent_id, null, "the refusal comes before the work creates its Agent");
      const work = await switched.pool.query<ControllerWorkRow>(
        "SELECT state, reason_code, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
        [workId],
      );
      assert.deepEqual(work.rows, [
        { state: "failed_permanent", reason_code: "PROVISIONING_REJECTED", attempt_count: 1 },
      ]);
      const audit = await switched.pool.query<
        Pick<AuditEvent, "kind" | "outcome"> & {
          code: string | null;
        }
      >(
        `SELECT kind, outcome, details->>'code' AS code
         FROM occ.audit_events
         WHERE namespace_id = $1
           AND action = 'openclaw.agents.provision.failure'
           AND details->>'workId' = $2`,
        [namespaceId, workId],
      );
      assert.deepEqual(audit.rows, [
        { kind: "mutation", outcome: "failure", code: "PROVISIONING_REJECTED" },
      ]);
      assert.deepEqual(
        replacementSecretDriver.calls,
        [],
        "the replacement driver never serves a Secret it does not own",
      );

      // Status and retry answer the same fixed message, so Console says the same thing either way.
      const status = await switched.request("GET", url);
      assert.equal(status.status, 503, JSON.stringify(status.body));
      assert.equal(provisioningError(status).message, message);
      const retried = await switched.request("POST", `${url}/retry`);
      assert.equal(retried.status, 503, JSON.stringify(retried.body));
      assert.equal(provisioningError(retried).message, message);
    },
  );

  test(
    "an unusable Secret Driver leaves the provisioning work retryable",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const secretDriver = createTestSecretDriver({ id: "secret-provisioning" });
      const implementation = secretDriver.implementation;
      let breakSecretDriver = false;
      const retry = observeProvisioningRetry();
      const fixture = await createFixture(context, {
        configurationDriver: createProvisioningConfigurationDriver({
          id: "configuration-provisioning-secret-outage",
        }),
        secretDriver,
        // The worker registers its Drivers at start; changing the selected Secret Driver's
        // identity afterwards makes it unusable to the worker, as an outage would.
        onWorkerEvent: (event) => {
          if (breakSecretDriver && event.event === "worker.started") {
            secretDriver.implementation = `${implementation}-unavailable`;
          }
        },
        stopWorkerAfter: retry.stopWorkerAfter,
      });
      context.after(() => {
        secretDriver.implementation = implementation;
      });
      const { namespaceId, body, workId } = await admitPlan(fixture);

      // No usable Secret Driver is an outage, not an ownership refusal: the worker keeps the
      // generic message and retries the work.
      breakSecretDriver = true;
      fixture.cancelQueuedWorkAtTeardown(
        workId,
        "Secret Driver outage test completed after its first attempt",
      );
      await retry.expectQueuedRetry(fixture, workId);
      const row = await provisioningRow(fixture.pool, namespaceId, body.requestId);
      assert.deepEqual(row.progress.error, {
        code: "PROVISIONING_DEPENDENCY_UNAVAILABLE",
        message: PROVISIONING_NOT_COMPLETED,
      });
    },
  );
}

export function registerProvisioningComputeGatewayCase({
  createFixture,
  createProvisioningSecrets,
  provisioningBody,
  createProvisioningConfigurationDriver,
  provisioningRow,
  refuseProvisioningWithoutGatewayRouting,
}: ComputeGatewayDependencies): void {
  test(
    "a Compute gateway change before the worker runs rejects the provisioning work without retrying",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const computeDriver = createRuntimeComputeDriver();
      const workerEvents: WorkerEvent[] = [];
      const fixture = await createFixture(context, {
        computeDriver,
        onWorkerEvent: (event) => workerEvents.push(event),
        configurationDriver: createProvisioningConfigurationDriver({
          id: "configuration-provisioning-compute-refusal",
        }),
        secretDriver: createTestSecretDriver({ id: "secret-provisioning" }),
      });
      const namespace = await fixture.bootstrapNamespace();
      const secrets = await createProvisioningSecrets(fixture, namespace.id);
      const body = provisioningBody(namespace.id, secrets);
      const admitted = await fixture.request<AgentProvisioningResponse["data"]>(
        "POST",
        `/namespaces/${namespace.id}/agents/provision`,
        {
          body,
        },
      );
      assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
      assert.ok(admitted.data);

      // The Installation now enables dedicated runtime storage without gateway routing, so the
      // Kubernetes Compute Driver refuses the stored plan with its own error class. Every attempt
      // would refuse it the same way, so the worker fails it on the first one and says why.
      refuseProvisioningWithoutGatewayRouting(computeDriver);
      await fixture.startWorker();
      const failed = await waitFor("the worker to refuse the provisioning work", async () => {
        const row = await provisioningRow(fixture.pool, namespace.id, body.requestId);
        return row.progress.error === undefined ? undefined : row;
      });
      await fixture.stopWorker();
      const message =
        "The Compute Driver cannot provision this execution mode or gateway configuration.";
      assert.equal(failed.status, "failed");
      assert.deepEqual(failed.progress.error, { code: "PROVISIONING_REJECTED", message });
      const work = await fixture.pool.query<ControllerWorkRow>(
        "SELECT state, reason_code, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
        [admitted.data.provisioning.workId],
      );
      assert.deepEqual(work.rows, [
        { state: "failed_permanent", reason_code: "PROVISIONING_REJECTED", attempt_count: 1 },
      ]);
      // The status keeps fixed text; the worker's log line names the Driver's reason.
      const completed = workerEvents.filter(
        (event) => event.event === "worker.completed" && event.code === "PROVISIONING_REJECTED",
      );
      assert.deepEqual(
        completed.map(({ outcome, reason }) => ({ outcome, reason })),
        [
          {
            outcome: "permanent",
            reason: DEDICATED_STORAGE_ROUTING_REQUIRED,
          },
        ],
      );

      // Reading status reports the stored failure rather than a 500 or a fresh refusal.
      const status = await fixture.request<AgentProvisioningStatusWire>(
        "GET",
        admitted.data.provisioning.url,
      );
      assert.equal(status.status, 200, JSON.stringify(status.body));
      assert.ok(status.data);
      assert.equal(status.data.status, "failed");
      assert.deepEqual(status.data.error, failed.progress.error);
      // Retry runs the plan again, so it is refused as a conflict; the driver's text stays local.
      const retried = await fixture.request("POST", `${admitted.data.provisioning.url}/retry`);
      assertApiError(retried, 409, "RESOURCE_CONFLICT");
      assert.equal(provisioningError(retried).message, message);
      assert.doesNotMatch(JSON.stringify(retried.body), /node enrollment/);

      // A gateway setting in the caller's own plan that the Installation no longer accepts (its
      // trusted proxy CIDRs changed) is the caller's to fix, so status and retry name it.
      const proxied = provisioningBody(namespace.id, secrets);
      proxied.configuration.values.gateway = { trustedProxies: ["127.0.0.1/32"] };
      const matching = createTestKubernetesComputeDriver("compute-provisioning-loopback-proxy");
      computeDriver.validateAgentProvisioning = (input) =>
        matching.validateAgentProvisioning(input);
      const admittedProxy = await fixture.request<AgentProvisioningResponse["data"]>(
        "POST",
        `/namespaces/${namespace.id}/agents/provision`,
        { body: proxied },
      );
      assert.equal(admittedProxy.status, 202, JSON.stringify(admittedProxy.body));
      assert.ok(admittedProxy.data);
      const moved = createTestKubernetesComputeDriver("compute-provisioning-moved-proxy", {
        gatewayTrustedProxyCidrs: ["10.42.0.0/16"],
      });
      computeDriver.validateAgentProvisioning = (input) => moved.validateAgentProvisioning(input);
      await fixture.startWorker();
      const proxyFailed = await waitFor(
        "the worker to refuse the stale gateway setting",
        async () => {
          const row = await provisioningRow(fixture.pool, namespace.id, proxied.requestId);
          return row.progress.error === undefined ? undefined : row;
        },
      );
      await fixture.stopWorker();
      const settingMessage =
        "Configuration setting gateway.trustedProxies must be omitted or match the Installation's network.gatewayTrustedProxyCidrs.";
      assert.deepEqual(proxyFailed.progress.error, {
        code: "PROVISIONING_REJECTED",
        message: settingMessage,
      });
      const proxyWork = await fixture.pool.query<
        Pick<ControllerWorkRow, "state" | "attempt_count">
      >("SELECT state, attempt_count FROM occ.controller_work WHERE idempotency_key = $1", [
        admittedProxy.data.provisioning.workId,
      ]);
      assert.deepEqual(proxyWork.rows, [{ state: "failed_permanent", attempt_count: 1 }]);
      const proxyRetried = await fixture.request(
        "POST",
        `${admittedProxy.data.provisioning.url}/retry`,
      );
      assert.equal(proxyRetried.status, 409, JSON.stringify(proxyRetried.body));
      const { code, message: proxyRetryMessage } = provisioningError(proxyRetried);
      assert.deepEqual(
        { code, message: proxyRetryMessage },
        { code: "RESOURCE_CONFLICT", message: settingMessage },
      );
    },
  );
}
