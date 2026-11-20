import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { GitHubProfile } from "../../apps/controller/src/drivers/repo/github/access/types.ts";
import {
  AgentDeploymentStatusResponse,
  AgentProvisioningResponse,
  AgentProvisioningStatusResponse,
  AgentReadResponse,
  AgentResponse,
  AgentRevisionReadResponse,
} from "../../packages/contracts/src/api/resources.ts";
import type { ProvisionAgentBody, SandboxDriver } from "../../packages/contracts/src/index.ts";
import type { ControllerWorkState } from "../../packages/occ/src/index.ts";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import { createFailedPreHandoffAgent } from "./postgres-agent-provisioning-handoff-cases.ts";
import {
  type Fixture,
  type FixtureOptions,
  handedOff,
  type ProvisioningSecrets,
  required,
} from "./postgres-agent-provisioning-setup.ts";

import { GitHubRepositoryPolicy } from "../../apps/controller/src/drivers/repo/github/policy.ts";
import { assertApiError } from "../helpers/api-error.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { assertProvisioningRepositoryStatus } from "../helpers/provisioning-repository-status.ts";
import {
  BROKER_PROXY_DISABLED,
  COMPUTE_REPOSITORY_UNSUPPORTED,
  COMPUTE_TOPOLOGY_REPOSITORY_UNSUPPORTED,
  CREDENTIAL_PROXY_INSTALLATION_ACCESS,
  PROVISIONING_NOT_COMPLETED,
  SAVED_REPOSITORY_SELECTION_NOT_APPROVED,
} from "../helpers/refusal-text.mjs";
import { waitFor } from "../helpers/wait-for.ts";
import { failingTransportDriver } from "./postgres-agent-provisioning-transport-fixture.ts";

import {
  assertProvisionedSecretAccess,
  createFixture,
  createProvisioningSecrets,
  identifier,
  provisioningBody,
  provisioningError,
  provisioningRow,
} from "./postgres-agent-provisioning-setup.ts";

// The GitHub repository policy the provisioning tests compose: one repository, `project`,
// approved in `namespaceId` for `profiles`.
// `installationAccess` also offers the Namespace installation-wide access, as `installation`.
function provisioningRepositoryPolicy(
  namespaceId: string,
  profiles: readonly GitHubProfile[],
  installationAccess = false,
) {
  return new GitHubRepositoryPolicy(
    {
      driverId: "provisioning-repo",
      backendId: "provisioning-repositories",
    },
    {
      ...(installationAccess && {
        installationAccess: {
          repositoryRef: "installation",
          namespaces: [{ namespaceId, accessMode: "installation" }],
        },
      }),
      version: 1,
      backendId: "provisioning-repositories",
      providerInstanceId: "provisioning-github",
      appId: "123",
      githubInstallationId: "456",
      maximumDurationSeconds: 3600,
      repositories: [
        {
          repositoryRef: "project",
          repositoryId: "789",
          repository: "example/project",
          namespaces: [{ namespaceId, profiles }],
        },
      ],
    },
    { sessionDurationSeconds: 600 },
  );
}

// A fresh Namespace with its provisioning Secrets, and a fixture that exercises real repository
// policy for `project` (approved for `profiles`; with `installationAccess`, also installation-wide
// access) and Kubernetes topology admission (`topologyId`, with the Sandbox Driver in `options`,
// if any) without contacting either external system. `compose` opens another app on the same
// Drivers, as after a change of the Installation's selection.
async function repositoryProvisioningFixture(
  context: TestContext,
  topologyId: string,
  {
    profiles = ["git-read"],
    installationAccess = false,
    ...options
  }: FixtureOptions & {
    profiles?: GitHubProfile[];
    installationAccess?: boolean;
  } = {},
) {
  const initial = await createFixture(context);
  const namespace = await initial.bootstrapNamespace();
  const repoDriver = provisioningRepositoryPolicy(namespace.id, profiles, installationAccess);
  const topology = createTestKubernetesComputeDriver(topologyId, {
    repositoryCredentials: true,
    ...(options.sandboxDriver === undefined ? {} : { sandboxDriver: options.sandboxDriver }),
  });
  // Reuse the established runtime fixture with the topology's repository admission.
  const computeDriver = initial.computeDriver;
  computeDriver.validateRepositoryCredentials =
    topology.validateRepositoryCredentials.bind(topology);
  const compose = (composeOptions: FixtureOptions = {}) =>
    createFixture(context, {
      computeDriver,
      configurationDriver: initial.configurationDriver,
      secretDriver: initial.secretDriver,
      repoDriver,
      ...composeOptions,
    });
  const fixture = await compose(options);
  const secrets = await createProvisioningSecrets(fixture, namespace.id);
  return {
    namespace,
    repoDriver,
    computeDriver,
    fixture,
    secrets,
    compose,
    secretDriver: initial.secretDriver,
  };
}

// A provisioning request for `project` at git-read, with no Plugin approvers.
function repositoryProvisioningBody(
  namespaceId: string,
  secrets: ProvisioningSecrets,
  overrides: Partial<ProvisionAgentBody> = {},
) {
  return {
    ...provisioningBody(namespaceId, secrets, overrides),
    repositoryAccess: {
      defaultProfile: "git-read",
      repositories: [{ repositoryRef: "project" }],
    },
    ...overrides,
    pluginApprovers: [],
  };
}

// Runs the worker until the provisioning job records an error, then returns its row.
async function workerFailure(
  fixture: Fixture,
  namespaceId: string,
  requestId: string,
  change: string,
) {
  await fixture.startWorker();
  try {
    return await waitFor(`the worker to refuse the provisioning job (${change})`, async () => {
      const row = await provisioningRow(fixture.pool, namespaceId, requestId);
      return row.progress.error === undefined ? undefined : row;
    });
  } finally {
    await fixture.stopWorker();
  }
}

export function registerRepositoryCases() {
  test(
    "provisioning worker creates Configuration and Agent from existing Secrets, then hands off one revision",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const { namespace, repoDriver, computeDriver, secretDriver, fixture, secrets } =
        await repositoryProvisioningFixture(context, "provisioning-topology", {
          profiles: ["git-read", "git-write"],
          stopAfterProvisioning: true,
        });
      const repositoryBindings = [{ repositoryRef: "project", profile: "git-read" }];
      const secretCreateCallCount = secretDriver.calls.filter(
        ({ operation }) => operation === "create",
      ).length;
      const body = repositoryProvisioningBody(namespace.id, secrets, { gatewayManagedMode: false });
      const { repositoryAccess } = body;
      const bound = context.mock.method(repoDriver, "resolveBindings");
      const legacy = context.mock.method(repoDriver, "resolve");
      const admitted = await fixture.requestChecked(
        AgentProvisioningResponse,
        "POST",
        `/namespaces/${namespace.id}/agents/provision`,
        {
          body,
        },
      );
      assert.equal(admitted.status, 202, JSON.stringify(admitted.body));

      assert.equal(bound.mock.callCount(), 1, "fresh planning uses the bound policy exactly once");
      assert.equal(legacy.mock.callCount(), 0, "fresh planning bypasses the legacy resolver");
      assert.deepEqual(bound.mock.calls[0]?.arguments, [
        { namespaceId: namespace.id, bindings: repositoryBindings },
      ]);
      const queued = await provisioningRow(fixture.pool, namespace.id, body.requestId);
      assert.deepEqual(queued.plan.repositoryBindings, repositoryBindings);
      assert.deepEqual(queued.plan.repositoryAccess, repositoryAccess);
      assert.deepEqual(queued.plan.pluginApprovers, []);
      assert.equal(queued.agent_id, null);
      assert.equal(Object.hasOwn(queued.plan, "reservedAgentId"), false);
      // Ordinary admission retains the pre-opt-in plan shape. Reopen the API before
      // a new worker consumes it, without rewriting persisted work or signing in again.
      await fixture.restartApi();
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
      assert.deepEqual(
        (await provisioningRow(fixture.pool, namespace.id, body.requestId)).plan,
        queued.plan,
      );
      assert.equal(bound.mock.callCount(), 1, "replay does not repeat repository planning");
      assert.equal(legacy.mock.callCount(), 0, "replay does not use the legacy resolver");
      const changed = await fixture.request(
        "POST",
        `/namespaces/${namespace.id}/agents/provision`,
        {
          body: { ...body, repositoryAccess: { ...repositoryAccess, defaultProfile: "git-write" } },
        },
      );
      assert.equal(changed.status, 409, JSON.stringify(changed.body));

      const boundCallsBeforeWorker = bound.mock.callCount();
      const legacyCallsBeforeWorker = legacy.mock.callCount();
      await fixture.startWorker();
      const status = await waitFor(
        "Agent provisioning to queue its initial deployment wait",
        async () => {
          const observed = await fixture.requestChecked(
            AgentProvisioningStatusResponse,
            "GET",
            admitted.data.provisioning.url,
          );
          assert.equal(observed.status, 200, JSON.stringify(observed.body));
          assert.notEqual(observed.data.status, "failed", JSON.stringify(observed.body));
          // Admission publishes revisionId before the worker queues its activation
          // wait. Inspect the handoff only after that deferral has committed.
          return observed.data.revisionId !== undefined && observed.data.status === "queued"
            ? handedOff(observed.data)
            : undefined;
        },
      );
      await fixture.stopWorker();
      const workerBoundCalls = bound.mock.calls.slice(boundCallsBeforeWorker);
      assert.ok(
        workerBoundCalls.length > 0,
        "Worker directly resolves the bound repository policy",
      );
      for (const call of workerBoundCalls) {
        assert.equal(call.this, repoDriver);
        assert.deepEqual(call.arguments, [
          { namespaceId: namespace.id, bindings: queued.plan.repositoryBindings },
        ]);
      }
      assert.equal(
        legacy.mock.callCount() - legacyCallsBeforeWorker,
        0,
        "Worker bypasses the legacy resolver even when it delegates to resolveBindings",
      );
      bound.mock.restore();
      legacy.mock.restore();
      assert.equal(status.status, "queued");
      assert.match(status.agentId, identifier("agt"));
      assert.match(status.configurationId, identifier("cfg"));
      // Handoff is done; the deployment has not reported a wait, so the job names its own deferral
      // rather than reading like one never claimed (finding 1634).
      assert.equal(status.attemptCount, 0);
      const firstDeployment = await fixture.requestChecked(
        AgentDeploymentStatusResponse,
        "GET",
        `/namespaces/${namespace.id}/agents/${status.agentId}/deployments/${status.revisionId}`,
      );
      assert.equal(firstDeployment.status, 200, JSON.stringify(firstDeployment.body));
      const deploymentWait = firstDeployment.data.progress?.lastAttempt;
      assert.deepEqual(
        status.progress,
        deploymentWait == null || deploymentWait.code === "RECONCILIATION_PENDING"
          ? {
              phase: "deployment",
              lastAttempt: {
                at: status.updatedAt,
                code: "PROVISIONING_DEPLOYMENT_PENDING",
                message: "Waiting for the initial deployment to complete.",
              },
            }
          : { phase: "deployment", lastAttempt: deploymentWait },
      );

      await assertProvisionedSecretAccess(
        { ...fixture, secretDriver },
        namespace,
        status,
        secretCreateCallCount,
      );
      const revisions = await fixture.state.read((view) =>
        view.revisions.listRevisions(namespace.id, status.agentId),
      );
      assert.equal(revisions.length, 1);
      assert.equal(required(revisions[0]).id, status.revisionId);
      assert.equal(required(revisions[0]).configurationGeneration, 1);
      await fixture.restartApi();
      const restartedReplay = await fixture.requestChecked(
        AgentProvisioningResponse,
        "POST",
        `/namespaces/${namespace.id}/agents/provision`,
        { body },
      );
      assert.equal(restartedReplay.status, 202, JSON.stringify(restartedReplay.body));
      assert.equal(restartedReplay.data.provisioning.agentId, status.agentId);
      assert.equal(restartedReplay.data.provisioning.revisionId, status.revisionId);
      assert.deepEqual(required(revisions[0]).pluginApprovers, []);
      const agentPath = `/namespaces/${namespace.id}/agents/${status.agentId}`;
      const agent = await fixture.requestChecked(AgentReadResponse, "GET", agentPath);
      assert.equal(agent.status, 200, JSON.stringify(agent.body));
      assert.ok("repositoryAccess" in agent.data);
      assert.equal(agent.data.gatewayManagedMode, false);
      assert.deepEqual(agent.data.repositoryBindings, repositoryBindings);
      assert.deepEqual(agent.data.repositoryAccess, repositoryAccess);
      assert.deepEqual(agent.data.pluginApprovers, []);
      const revisionPath = `${agentPath}/revisions/${status.revisionId}`;
      const revision = await fixture.requestChecked(AgentRevisionReadResponse, "GET", revisionPath);
      assert.equal(revision.status, 200, JSON.stringify(revision.body));
      assert.ok("repositoryCredentials" in revision.data);
      assert.equal(revision.data.gatewayManagedMode, false);
      assert.deepEqual(required(revision.data.repositoryCredentials).bindings, repositoryBindings);
      assert.equal(
        required(required(required(revisions[0]).repositoryCredentials).bindings[0]).grant
          .repositoryId,
        "789",
      );
      // Persist explicit intent even when equal to the default, then change only that default.
      const custom = { defaultProfile: "git-write", repositories: repositoryBindings };
      const customized = await fixture.requestChecked(AgentResponse, "PATCH", agentPath, {
        body: { configurationId: status.configurationId, repositoryAccess: custom },
      });
      assert.equal(customized.status, 200, JSON.stringify(customized.body));
      const customizedRead = await fixture.requestChecked(AgentReadResponse, "GET", agentPath);
      assert.ok("repositoryAccess" in customizedRead.data);
      assert.deepEqual(customizedRead.data.repositoryAccess, custom);
      assert.deepEqual(customized.data.repositoryBindings, repositoryBindings);
      // Database constraints enforce consistency even when an application writer is bypassed.
      for (const invalid of [
        { defaultProfile: "git-write", repositories: [{ repositoryRef: "project" }] },
        { ...custom, extra: true },
        { ...custom, repositories: [...repositoryBindings, ...repositoryBindings] },
        { ...custom, repositories: [{ repositoryRef: "project", profile: null }] },
      ]) {
        await assert.rejects(
          fixture.pool.query<Record<string, unknown>>(
            "UPDATE occ.agents SET repository_access = $1::jsonb WHERE namespace_id = $2 AND id = $3",
            [JSON.stringify(invalid), namespace.id, status.agentId],
          ),
          { code: "23514" },
        );
      }
      const cleared = await fixture.requestChecked(AgentResponse, "PATCH", agentPath, {
        body: { configurationId: status.configurationId, repositoryBindings: [] },
      });
      assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
      assert.equal(Object.hasOwn(cleared.data, "repositoryBindings"), false);
      assert.equal(Object.hasOwn(cleared.data, "repositoryAccess"), false);
      const historical = await fixture.requestChecked(
        AgentRevisionReadResponse,
        "GET",
        revisionPath,
      );
      assert.equal(historical.status, 200, JSON.stringify(historical.body));
      assert.ok("repositoryCredentials" in historical.data);
      assert.deepEqual(historical.data.repositoryCredentials, revision.data.repositoryCredentials);
      assert.equal(required(revisions[0]).harnessAuth.method, "api_key");
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
      assert.equal(required(work.rows[0]).state, "queued");
    },
  );

  // Accepted work whose repository access the Installation can no longer deliver fails before it
  // creates its Agent: the worker rechecks what the request checked. Each case changes one thing
  // after admission. Finding 2536: when the Compute Driver lost repository credentials, or the
  // repository policy no longer approves the saved selection (a 409 about saved state, not the
  // request's 400), the status names the refusal in fixed text that names no repository. Finding
  // 1145: a Compute topology refusal keeps the fixed status text, and retry answers Agent create's
  // 409.
  test(
    "a provisioning job whose saved repository access can no longer be delivered fails before its Agent",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const { namespace, repoDriver, computeDriver, fixture, secrets } =
        await repositoryProvisioningFixture(context, "provisioning-saved-access");
      const validateRepositoryCredentials = required(computeDriver.validateRepositoryCredentials);
      let policyRefusal: { mock: { restore(): void } } | undefined;
      for (const { change, refuse, message, retry } of [
        {
          change: "compute",
          // The Installation now selects a Compute Driver without repository credentials.
          refuse: () => delete computeDriver.validateRepositoryCredentials,
          message: COMPUTE_REPOSITORY_UNSUPPORTED,
        },
        {
          change: "policy",
          // An Installation administrator withdrew the approval after the request was accepted.
          // The policy refuses the selection as the Driver contract allows: without a reason.
          refuse: () => {
            policyRefusal = context.mock.method(repoDriver, "resolveBindings", () => {
              throw new Error("synthetic withdrawn approval");
            });
          },
          message: SAVED_REPOSITORY_SELECTION_NOT_APPROVED,
        },
        {
          change: "topology",
          // The topology now cannot deliver repository credentials (as with a Sandbox selected).
          refuse: () => {
            computeDriver.validateRepositoryCredentials = () => {
              throw new Error("synthetic topology refusal");
            };
          },
          message: PROVISIONING_NOT_COMPLETED,
          retry: COMPUTE_TOPOLOGY_REPOSITORY_UNSUPPORTED,
        },
      ]) {
        // Each case starts from an Installation that delivers the access.
        computeDriver.validateRepositoryCredentials = validateRepositoryCredentials;
        const body = repositoryProvisioningBody(namespace.id, secrets);
        const admitted = await fixture.requestChecked(
          AgentProvisioningResponse,
          "POST",
          `/namespaces/${namespace.id}/agents/provision`,
          { body },
        );
        assert.equal(admitted.status, 202, `${change}: ${JSON.stringify(admitted.body)}`);
        try {
          refuse();
          const failed = await workerFailure(fixture, namespace.id, body.requestId, change);
          assert.equal(failed.status, "failed", change);
          assert.deepEqual(
            failed.progress.error,
            { code: "PROVISIONING_REJECTED", message },
            change,
          );
          assert.equal(
            failed.agent_id,
            null,
            `${change}: refused before the work creates its Agent`,
          );
          assert.equal(
            failed.revision_id,
            null,
            `${change}: refused before the work creates a revision`,
          );
          const status = await fixture.requestChecked(
            AgentProvisioningStatusResponse,
            "GET",
            admitted.data.provisioning.url,
          );
          assert.equal(status.status, 200, `${change}: ${JSON.stringify(status.body)}`);
          assert.deepEqual(status.data.error, { code: "PROVISIONING_REJECTED", message }, change);
          if (retry !== undefined) {
            const retried = await fixture.request(
              "POST",
              `${admitted.data.provisioning.url}/retry`,
            );
            assertApiError(retried, 409, "RESOURCE_CONFLICT");
            assert.equal(provisioningError(retried).message, retry);
          }
        } finally {
          policyRefusal?.mock.restore();
          policyRefusal = undefined;
          computeDriver.validateRepositoryCredentials = validateRepositoryCredentials;
        }
      }
    },
  );

  // Finding 2536 (review-3732): installation-wide repository access needs a Credential Proxy, and
  // this Installation selects none. The request names one repository at an approved profile, so it
  // is accepted; the worker's deploy step refuses it, and every attempt would. The job fails at once
  // and its status names the refusal in fixed text, not "could not complete".
  test(
    "a provisioning job whose installation-wide access needs a Credential Proxy names the refusal in its status",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const { namespace, fixture, secrets } = await repositoryProvisioningFixture(
        context,
        "provisioning-installation-access",
        { installationAccess: true },
      );
      const { repositoryAccess: ignored, ...body } = repositoryProvisioningBody(
        namespace.id,
        secrets,
        {
          repositoryBindings: [{ repositoryRef: "installation", profile: "github-installation" }],
        },
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
      const failed = await workerFailure(fixture, namespace.id, body.requestId, "installation");
      const error = {
        code: "PROVISIONING_REJECTED",
        message: CREDENTIAL_PROXY_INSTALLATION_ACCESS,
      };
      assert.equal(failed.status, "failed");
      assert.deepEqual(failed.progress.error, error);
      const status = await fixture.requestChecked(
        AgentProvisioningStatusResponse,
        "GET",
        admitted.data.provisioning.url,
      );
      assert.equal(status.status, 200, JSON.stringify(status.body));
      assert.deepEqual(status.data.error, error);
    },
  );

  // Finding 2350: a Codex network proxy setting that blocks the repository credential broker is
  // refused at the provisioning request, and the worker and retry repeat the check for the stored
  // record. A Sandbox Driver with its own repository path carries the broker traffic instead, so
  // the request is accepted while one is selected; when the Installation then drops that Sandbox
  // Driver, the stored record would send it through the blocking proxy and is refused.
  test(
    "a stored provisioning record whose Codex proxy blocks the repository broker is refused after its Sandbox repository path goes away",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      // This case ends before the worker reaches the Sandbox: only that it has a repository path
      // matters, so every Sandbox operation fails the test.
      const unused = () => assert.fail("this case ends before repository delivery");
      const sandboxDriver: SandboxDriver = {
        id: "sandbox-repository-path",
        capability: "sandbox",
        implementation: "test-provisioning",
        supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
        facets: ["networking", "filesystem", "process"],
        repositoryAccess: {
          verifyExecution: unused,
          retireExpired: unused,
          routeReadiness: unused,
          materialSettledAt: unused,
          isRouteBlockedError: unused,
        },
        async provisionHarness() {
          assert.fail("this case ends before provisioning effects");
        },
        async cleanup() {},
      };
      const { namespace, computeDriver, fixture, secrets, compose } =
        await repositoryProvisioningFixture(context, "provisioning-sandbox-repositories", {
          sandboxDriver,
        });
      const withoutSandbox = createTestKubernetesComputeDriver("provisioning-proxy-repositories", {
        repositoryCredentials: true,
      });
      const { agents, models } = createHarnessConfiguration("codex", "gpt-6-astra");
      const body = repositoryProvisioningBody(namespace.id, secrets, {
        configuration: {
          kind: "agent",
          values: {
            agents,
            models,
            plugins: {
              entries: {
                codex: {
                  enabled: true,
                  config: { appServer: { networkProxy: { enabled: false } } },
                },
              },
            },
          },
        },
      });
      const admitted = await fixture.requestChecked(
        AgentProvisioningResponse,
        "POST",
        `/namespaces/${namespace.id}/agents/provision`,
        {
          body,
        },
      );
      assert.equal(admitted.status, 202, JSON.stringify(admitted.body));

      // The Installation now has no Sandbox Driver: the Codex network proxy carries the broker
      // traffic, and the stored setting blocks it.
      computeDriver.validateRepositoryCredentials =
        withoutSandbox.validateRepositoryCredentials.bind(withoutSandbox);
      const switched = await compose();
      const failed = await workerFailure(switched, namespace.id, body.requestId, "Codex proxy");
      assert.equal(failed.status, "failed");
      assert.equal(failed.agent_id, null, "the refusal comes before the work creates its Agent");
      // Retry names the setting, as Agent save and the request do.
      const retried = await switched.request("POST", `${admitted.data.provisioning.url}/retry`);
      assertApiError(retried, 400, "INVALID_REQUEST");
      assert.equal(provisioningError(retried).message, BROKER_PROXY_DISABLED);
    },
  );
}

export function registerRepositoryStatusCase() {
  test(
    "existing Agent provisioning status survives repository policy refusal while retry and IAM remain enforced",
    { ...requiresPostgres, timeout: 60_000 },
    (context) =>
      assertProvisioningRepositoryStatus(failingTransportDriver(), async (options, overrides) => {
        const fixture = await createFixture(context, options);
        return { fixture, ...(await createFailedPreHandoffAgent(fixture, overrides)) };
      }),
  );
}
