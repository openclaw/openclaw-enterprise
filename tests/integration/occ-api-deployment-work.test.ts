import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import {
  AgentDeploymentStatusResponse,
  AgentResponse,
  AgentRevisionResponse,
  ErrorResponse,
  InstallationDeploymentInventoryResponse,
  type ComputeDriver,
  type ErrorCode,
  type Restriction,
} from "../../packages/contracts/src/index.ts";
import {
  type ClaimedWork,
  type ControllerWork,
  type ControllerWorkState,
  type PlatformReadView,
  type PlatformStateStore,
} from "../../packages/occ/src/index.ts";
import { DEPLOYMENT_FAILED, MODEL_CREDENTIAL_REJECTED_RECORDED } from "../helpers/refusal-text.mjs";
import {
  bindHarnessKey,
  bootstrapInstallation as bootstrap,
  checkedInjectedBody,
  createAgent,
  createInjectedControllerFixture,
  createNamespace,
  injectedRequest,
  type FixtureRequest,
} from "./occ-api-injected-fixture.ts";

type InjectedReply = Awaited<ReturnType<FixtureRequest>>;

function assertApiError(reply: InjectedReply, status: number, code: ErrorCode, label?: string) {
  const message =
    label === undefined ? JSON.stringify(reply.body) : `${label}: ${JSON.stringify(reply.body)}`;
  const { error } = checkedInjectedBody(reply, status, ErrorResponse);
  assert.equal(error.code, code, message);
}

function runtimeFailureOf(status: AgentDeploymentStatusResponse["data"]) {
  const data = status.error?.data;
  return data && "runtimeFailure" in data ? data.runtimeFailure : undefined;
}

const missingRevisionId = "rev_3dd29693-ce8b-4b4c-97c4-14b4c68c6e9c";

async function waitForRequestBarrier(barrier: Promise<void>, pending: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Request did not reach the expected barrier")), 5000);
  });
  try {
    await Promise.race([
      barrier,
      pending.then(() => {
        throw new Error("Request completed before reaching the expected barrier");
      }),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function configuredController({
  deploymentWorks,
  recordOperations,
}: {
  readonly deploymentWorks?: DeploymentWorkOverrides;
  readonly recordOperations?: boolean | undefined;
} = {}) {
  const fixture = await createInjectedControllerFixture(
    { recordOperations },
    {
      wrapPlatformState(state) {
        return deploymentWorks === undefined
          ? state
          : stateWithDeploymentWork(state, deploymentWorks);
      },
      invokeApplication(factory, { backendSummaries, ...options }) {
        return factory(backendSummaries === undefined ? options : { ...options, backendSummaries });
      },
    },
  );
  const request: FixtureRequest = (method, pathname, options) =>
    injectedRequest(fixture.app, method, pathname, options);
  return { fixture, request };
}

type DeploymentWorkOverrides = Map<string, Readonly<ControllerWork> | undefined>;

function stateWithDeploymentWork(
  state: PlatformStateStore,
  deploymentWorks: DeploymentWorkOverrides,
): PlatformStateStore {
  function withWork<View extends PlatformReadView>(view: View): View {
    return {
      ...view,
      operations: {
        ...view.operations,
        async findWork(key) {
          if (!deploymentWorks.has(key)) {
            return view.operations.findWork(key);
          }
          const work = deploymentWorks.get(key);
          return work === undefined ? undefined : Object.freeze({ ...work });
        },
        async findWorkByKeys(keys) {
          const result = await view.operations.findWorkByKeys(keys);
          return {
            get(key) {
              if (!deploymentWorks.has(key)) {
                return result.get(key);
              }
              const work = deploymentWorks.get(key);
              return work === undefined ? undefined : Object.freeze({ ...work });
            },
          };
        },
      },
    };
  }
  return {
    read: (operation) => state.read((view) => operation(withWork(view))),
    transact: (operation) => state.transact((view) => operation(withWork(view))),
  };
}

async function admittedDeploymentFixture(
  namespaceName: string,
  agentName: string,
  { recordOperations }: { readonly recordOperations?: boolean | undefined } = {},
) {
  const deploymentWorks: DeploymentWorkOverrides = new Map();
  const controller = await configuredController({ deploymentWorks, recordOperations });
  const { fixture } = controller;
  await bootstrap(controller);
  const namespace = await createNamespace(controller, namespaceName);
  const agent = await createAgent(controller, namespace.id, agentName);
  await fixture.markNamespaceReady(namespace.id);
  await bindHarnessKey(fixture, namespace.id, agent);
  const response = await controller.request(
    "POST",
    `/namespaces/${namespace.id}/agents/${agent.id}/deploy`,
  );
  const body = checkedInjectedBody(response, 202, AgentRevisionResponse);
  const admitted = { ...response, body, data: body.data };
  const key = `agent_revision:${body.data.id}:reconcile`;
  const work = {
    key,
    record(
      state: ControllerWorkState,
      completedAt: string | number | Date,
      outcome: Partial<Pick<ControllerWork, "reasonCode" | "resultData">> = {},
    ): ControllerWork {
      return {
        kind: "lifecycle",
        idempotencyKey: key,
        namespaceId: namespace.id,
        agentId: agent.id,
        revisionId: body.data.id,
        actorId: fixture.principal.id,
        state,
        availableAt: new Date(0),
        attemptCount: 1,
        completedAt: new Date(completedAt),
        ...outcome,
        createdAt: new Date(0),
        updatedAt: new Date(completedAt),
      };
    },
  };
  return { controller, fixture, namespace, agent, admitted, deploymentWorks, work };
}

test("OCC Fastify rejects unsafe guarded Agent stop requests", async () => {
  const { controller, fixture, namespace, agent, admitted, deploymentWorks, work } =
    await admittedDeploymentFixture("guarded-stop", "guarded-stop-agent", {
      recordOperations: true,
    });
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const stopPath = `${agentPath}/stop`;
  const expected = `expectedActiveRevisionId=${admitted.data.id}`;
  const stop = (query: string) => controller.request("POST", `${stopPath}?${query}`);

  const state = fixture.platformState;
  assert(state);
  await state.transact((unit) =>
    unit.agents.compareAndSetActiveRevision(namespace.id, agent.id, undefined, admitted.data.id),
  );
  const before = checkedInjectedBody(
    await controller.request("GET", agentPath),
    200,
    AgentResponse,
  ).data;
  const operations = () => state.read((view) => view.operations.list());
  const queued = await operations();
  assert.equal(before.activeRevisionId, admitted.data.id);
  assert.equal(before.desiredRuntimeState, "running");
  assertApiError(await stop(expected), 409, "RESOURCE_CONFLICT", "queued deployment");

  // A persisted terminal work result can report completion without activation.
  deploymentWorks.set(
    work.key,
    work.record("succeeded", "2026-09-19T20:31:00.000Z", { reasonCode: "REVISION_STOPPED" }),
  );
  const deployment = await controller.request(
    "GET",
    `${agentPath}/deployments/${admitted.data.id}`,
  );
  assert.equal(
    checkedInjectedBody(deployment, 200, AgentDeploymentStatusResponse).data.status,
    "failed",
  );
  assertApiError(await stop(expected), 409, "RESOURCE_CONFLICT", "completed without activation");

  for (const query of [
    "expectedActiveRevisionId=",
    "expectedActiveRevisionId=invalid",
    "unexpectedRevisionId=invalid",
    `${expected}&${expected}`,
  ]) {
    assertApiError(await stop(query), 400, "INVALID_REQUEST", query);
  }

  assert.deepEqual(
    checkedInjectedBody(await controller.request("GET", agentPath), 200, AgentResponse).data,
    before,
  );
  assert.deepEqual(await operations(), queued);
  assert(fixture.auditSink instanceof InMemoryAuditSink);
  assert.equal(
    fixture.auditSink.events.some(
      (event) => event.kind === "mutation" && event.action === "openclaw.agents.stop",
    ),
    false,
  );
});

test("Agent deployment status polls the admitted revision work with exact read authorization", async () => {
  const { controller, fixture, namespace, agent, admitted, deploymentWorks, work } =
    await admittedDeploymentFixture("deployment-status", "status-agent", {
      recordOperations: true,
    });
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/deployments/${admitted.data.id}`;

  const status = await controller.request("GET", path);
  const statusData = checkedInjectedBody(status, 200, AgentDeploymentStatusResponse).data;
  assert.deepEqual(statusData, {
    deploymentId: admitted.data.id,
    namespaceId: namespace.id,
    agentId: agent.id,
    status: "queued",
    cleanup: null,
    error: null,
    warnings: [],
    progress: { lastAttempt: null, nextAttemptAt: new Date(0).toISOString() },
  });
  // A provider-owned Harness serves its failure evidence from inside the Sandbox, so Agent code
  // can answer in its place. Values outside the runtime's own vocabulary read back as
  // UNRECOGNIZED, so the status and the Console never show what it wrote.
  const servedRuntimeFailure = {
    component: "sidecar",
    check: "see.evil.example:443",
    checkedAt: "2026-09-19T20:30:00.000Z",
    code: "STARTUP_FAILED",
  };
  const runtimeFailure = {
    ...servedRuntimeFailure,
    component: "UNRECOGNIZED",
    check: "UNRECOGNIZED",
    code: "UNRECOGNIZED",
  };
  deploymentWorks.set(
    work.key,
    work.record("failed_permanent", "2026-09-19T20:31:00.000Z", {
      reasonCode: "CONVERGENCE_DEADLINE_EXCEEDED",
      resultData: { timeoutMs: 900_000, runtimeFailure: servedRuntimeFailure },
    }),
  );
  const failedStatus = await controller.request("GET", path);
  const failedStatusData = checkedInjectedBody(
    failedStatus,
    200,
    AgentDeploymentStatusResponse,
  ).data;
  assert.deepEqual(failedStatusData, {
    deploymentId: admitted.data.id,
    namespaceId: namespace.id,
    agentId: agent.id,
    status: "failed",
    cleanup: null,
    error: {
      code: "CONVERGENCE_DEADLINE_EXCEEDED",
      // occ and HTTP clients print this message as is, so it names the next step.
      message:
        "Deployment convergence deadline exceeded: the version did not become ready in time. Check its logs and runtime diagnostics, correct the cause if there is one, then deploy a new version.",
      data: { timeoutMs: 900_000, runtimeFailure },
    },
    warnings: [],
    progress: null,
  });

  const missing = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/deployments/${missingRevisionId}`,
  );
  assertApiError(missing, 404, "NOT_FOUND");

  const { principal: revisionReader } = await fixture.createAuthPrincipal(
    "deployment-status-reader",
  );
  fixture.state.identities.push(revisionReader);
  fixture.state.roles.push({
    id: "role-deployment-status-reader",
    namespaceId: namespace.id,
    permissions: [{ action: "read", resourceKind: "agent_revision" }],
  });
  fixture.state.bindings.push({
    id: "binding-deployment-status-reader",
    namespaceId: namespace.id,
    subjectKind: "identity",
    subjectId: revisionReader.id,
    roleId: "role-deployment-status-reader",
  });
  const readerApp = fixture.createApp(revisionReader);
  const parentDenied = await injectedRequest(
    readerApp,
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}`,
  );
  assert.equal(parentDenied.status, 403);
  const readableDeployment = await injectedRequest(readerApp, "GET", path);
  const readableDeploymentData = checkedInjectedBody(
    readableDeployment,
    200,
    AgentDeploymentStatusResponse,
  ).data;
  assert.equal(readableDeploymentData.status, "failed");
  assert.deepEqual(runtimeFailureOf(readableDeploymentData), runtimeFailure);
  // Evidence in the runtime's own vocabulary reads back as recorded.
  const knownRuntimeFailure = {
    component: "agent",
    check: "model-probe",
    checkedAt: "2026-09-19T20:30:00.000Z",
    code: "NOT_CONFIGURED",
  };
  const deploymentWork = deploymentWorks.get(work.key);
  assert(deploymentWork);
  deploymentWorks.set(work.key, {
    ...deploymentWork,
    resultData: { timeoutMs: 900_000, runtimeFailure: knownRuntimeFailure },
  });
  const knownDeployment = await injectedRequest(readerApp, "GET", path);
  const knownDeploymentData = checkedInjectedBody(
    knownDeployment,
    200,
    AgentDeploymentStatusResponse,
  ).data;
  assert.deepEqual(runtimeFailureOf(knownDeploymentData), knownRuntimeFailure);
  // So does the evidence Kubernetes Compute builds from a failed initialize-workspace init
  // container, whose code docs/flows/workspace-files.md names.
  const workspaceSetupFailure = {
    component: "agent",
    check: "workspace-setup",
    checkedAt: "2026-09-19T20:30:00.000Z",
    code: "WORKSPACE_SETUP_FAILED",
  };
  deploymentWorks.set(work.key, {
    ...deploymentWork,
    resultData: { timeoutMs: 900_000, runtimeFailure: workspaceSetupFailure },
  });
  const workspaceSetupDeployment = await injectedRequest(readerApp, "GET", path);
  const workspaceSetupDeploymentData = checkedInjectedBody(
    workspaceSetupDeployment,
    200,
    AgentDeploymentStatusResponse,
  ).data;
  assert.deepEqual(runtimeFailureOf(workspaceSetupDeploymentData), workspaceSetupFailure);

  // A deployment whose revision was already active completes like one that activated it; any
  // other completion without activation ended the deployment without serving it.
  for (const [reasonCode, expected, error] of [
    ["REVISION_ACTIVATED", "succeeded", null],
    ["REVISION_ALREADY_ACTIVE", "succeeded", null],
    [
      "REVISION_SUPERSEDED",
      "failed",
      { code: "REVISION_SUPERSEDED", message: "Deployment was superseded by a newer revision." },
    ],
  ] satisfies ReadonlyArray<
    readonly [string, "succeeded" | "failed", { code: string; message: string } | null]
  >) {
    const { resultData: _resultData, ...completedWork } = deploymentWork;
    deploymentWorks.set(work.key, {
      ...completedWork,
      state: "succeeded",
      reasonCode,
    });
    const completed = await controller.request("GET", path);
    const completedData = checkedInjectedBody(completed, 200, AgentDeploymentStatusResponse).data;
    assert.equal(completedData.status, expected, reasonCode);
    assert.deepEqual(completedData.error, error, reasonCode);
  }

  const readerRoleIndex = fixture.state.roles.findIndex(
    (role) => role.id === "role-deployment-status-reader",
  );
  assert.notEqual(readerRoleIndex, -1);
  const readerRole = fixture.state.roles[readerRoleIndex];
  assert(readerRole);
  fixture.state.roles[readerRoleIndex] = { ...readerRole, permissions: [] };
  const deniedApp = fixture.createApp(revisionReader);
  const denied = await injectedRequest(deniedApp, "GET", path);
  assert.equal(denied.status, 403);
});

test("a refused deployment's status names its cause and remedy without naming principals", async () => {
  // These refusals used to fall through to "Deployment reconciliation failed.",
  // so a member whose deploy permission was revoked mid-rollout saw no cause or remedy.
  const { controller, fixture, namespace, agent, admitted, deploymentWorks, work } =
    await admittedDeploymentFixture("deployment-refusals", "refused-agent");
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/deployments/${admitted.data.id}`;
  const messages = {
    AUTHORIZATION_DENIED: DEPLOYMENT_FAILED.AUTHORIZATION_DENIED,
    ACTOR_REVOKED:
      "The account that requested this deployment is no longer an active account in the Installation. Deploy again from an account with deploy access to the Agent.",
    HARNESS_AUTH_REQUIRED:
      "This revision has no Harness authentication method. Set one on the Agent, then deploy again.",
    BACKEND_UNAVAILABLE: DEPLOYMENT_FAILED.BACKEND_UNAVAILABLE,
    HARNESS_AUTH_SOURCE_CHANGED:
      "The ServiceAccount this revision authenticates with is missing, has no access token, or its credential changed since admission. Bind an available ServiceAccount, or deploy again to admit a revision with its current credential.",
    SECRET_BINDING_UNAVAILABLE:
      "A Secret this revision binds is missing or no longer belongs to the selected Secret Driver. Bind available Secrets, then deploy again.",
    NAMESPACE_NOT_READY:
      "The Agent's Namespace was not ready when the controller ran this deployment, for example while it is being deleted. Deploy again once the Namespace is ready.",
    WORKSPACE_SETUP_UNSUPPORTED: DEPLOYMENT_FAILED.WORKSPACE_SETUP_UNSUPPORTED,
    REPOSITORY_REVISION_STOPPED:
      "Deployment ended because the Agent was stopped or its Namespace is no longer ready. To run the Agent, deploy again once its Namespace is ready.",
    REPOSITORY_REVISION_SUPERSEDED: "Deployment was superseded by a newer revision.",
    // Repository credential refusals name cause and remedy, never the repository.
    REPOSITORY_RUNTIME_UNSUPPORTED: DEPLOYMENT_FAILED.REPOSITORY_RUNTIME_UNSUPPORTED,
    REPOSITORY_BINDING_UNAVAILABLE: DEPLOYMENT_FAILED.REPOSITORY_BINDING_UNAVAILABLE,
    REPOSITORY_BINDING_CHANGED:
      "The approval behind a repository this revision binds changed since admission, for example the access levels or push rules approved for the Agent's Namespace. Deploy again to admit a revision with the current approval.",
    REPOSITORY_DRIVER_MISMATCH: DEPLOYMENT_FAILED.REPOSITORY_DRIVER_MISMATCH,
    REPOSITORY_CREDENTIAL_DEADLINE_EXCEEDED:
      "This revision's repository access deadline, fixed when the revision was admitted, has passed. Deploy again to admit a revision with a new deadline.",
    DEPENDENCY_UNAVAILABLE: DEPLOYMENT_FAILED.DEPENDENCY_UNAVAILABLE,
    LEASE_EXPIRED:
      "The controller worker stopped or lost its claim during this deployment's last attempt. Deploy again.",
    // Held runtime failures name the next step too, so occ and HTTP clients get
    // the guidance the console used to add on its own.
    RUNTIME_AUTHENTICATION_FAILED: MODEL_CREDENTIAL_REJECTED_RECORDED,
    RUNTIME_CPU_STARVED: DEPLOYMENT_FAILED.RUNTIME_CPU_STARVED,
    RUNTIME_MODEL_PROBE_TIMEOUT:
      "The startup model check got no reply from the provider in time. With OpenClaw this includes an unreachable provider (refused connection or unknown host). Check egress, proxy or a custom baseUrl and that the provider responds, then deploy a new version.",
    RUNTIME_LOGIN_FAILED:
      "Deployment runtime could not sign in to the model provider. Check the Agent's model credential (for an OAuth login, sign in again) and that the runtime can reach the provider, then deploy a new version.",
    RUNTIME_CODEX_REQUIREMENTS_TOO_LARGE:
      "The Codex runtime’s managed requirements reply exceeds OCE’s 1 MiB limit. Ask the policy owner to reduce the requirements document, then deploy a new version.",
    RUNTIME_CODEX_PERMISSION_POLICY_INCOMPATIBLE:
      "This Codex runtime’s managed permission policy does not allow the sandbox mode, named profile or human reviewer required by OpenShell. Ask the policy owner to verify compatibility, then deploy a new version.",
    RUNTIME_STARTUP_FAILED:
      "Deployment runtime failed a startup check. Check this version's logs for the failed check and correct its cause, then deploy a new version.",
    RUNTIME_STATE_LOCK_UNVERIFIED: `Startup check gateway-state-lock failed: the runtime cannot verify that its state lock holder stopped. See it with 'occ agent logs ${agent.id} --source gateway' (Harness: --source agent), then follow the troubleshooting guide.`,
    // These fell through to "Deployment reconciliation failed.", which named no
    // step. A version stored inconsistently sends the reader to an administrator, not to
    // runtime logs that do not exist.
    INVALID_REVISION_OWNER:
      "The stored records for this version are inconsistent with its Agent or Namespace, so the controller did not start it and it has no runtime logs. Ask an Installation administrator to check the controller worker log for this deployment.",
    INVALID_HARNESS_AUTH:
      "This version's Harness authentication cannot be used: its Secret or ServiceAccount is outside the Agent's Namespace, or its method is not supported. Choose the Harness authentication again in the Agent's Credentials, then deploy a new version.",
    EXECUTION_ADMISSION_UNAVAILABLE:
      "This version was admitted for protected execution that the Installation can no longer provide, for example after its Credential Proxy changed. Deploy again; if the deploy is refused, ask an Installation administrator to check the Credential Proxy.",
    REPOSITORY_PROXY_ADMISSION_MISMATCH:
      "This version's repository access no longer matches the Credential Proxy delivery it was admitted with. Deploy again to admit a version with the current repository access.",
  };
  for (const [reasonCode, message] of Object.entries(messages)) {
    deploymentWorks.set(
      work.key,
      work.record("failed_permanent", "2026-10-10T18:03:32.000Z", { reasonCode }),
    );
    const status = await controller.request("GET", path);
    const statusData = checkedInjectedBody(status, 200, AgentDeploymentStatusResponse).data;
    assert.equal(statusData.status, "failed", reasonCode);
    assert.deepEqual(statusData.error, { code: reasonCode, message }, reasonCode);
    assert.equal(JSON.stringify(status.body).includes(fixture.principal.id), false, reasonCode);
  }
});

test("a deletion retry by another delete holder names the initiator condition and audits it", async () => {
  const deploymentWorks: DeploymentWorkOverrides = new Map();
  const controller = await configuredController({ deploymentWorks, recordOperations: true });
  const { fixture } = controller;
  await bootstrap(controller);
  const namespace = await createNamespace(controller, "deletion-takeover");
  const agent = await createAgent(controller, namespace.id, "takeover-agent");
  await fixture.markNamespaceReady(namespace.id);
  const started = await controller.request(
    "DELETE",
    `/namespaces/${namespace.id}/agents/${agent.id}`,
  );
  assert.equal(started.status, 202, JSON.stringify(started.body));
  // The administrator's teardown failed permanently; it still holds delete.
  deploymentWorks.set(`agent:${agent.id}:reconcile:deleted`, {
    kind: "lifecycle",
    idempotencyKey: `agent:${agent.id}:reconcile:deleted`,
    namespaceId: namespace.id,
    agentId: agent.id,
    actorId: fixture.principal.id,
    state: "failed_permanent",
    availableAt: new Date(0),
    attemptCount: 1,
    completedAt: new Date(1),
    reasonCode: "AUTHORIZATION_DENIED",
    createdAt: new Date(0),
    updatedAt: new Date(1),
  });

  const { principal: other } = await fixture.createAuthPrincipal("deletion-takeover-other");
  fixture.state.identities.push(other);
  fixture.state.roles.push({
    id: "role-deletion-takeover",
    namespaceId: namespace.id,
    permissions: [{ action: "delete", resourceKind: "agent" }],
  });
  fixture.state.bindings.push({
    id: "binding-deletion-takeover",
    namespaceId: namespace.id,
    subjectKind: "identity",
    subjectId: other.id,
    roleId: "role-deletion-takeover",
    resourceKind: "agent",
    resourceId: agent.id,
  });
  const refused = await injectedRequest(
    fixture.createApp(other),
    "DELETE",
    `/namespaces/${namespace.id}/agents/${agent.id}`,
  );
  assertApiError(refused, 403, "FORBIDDEN");
  const refusedError = checkedInjectedBody(refused, 403, ErrorResponse).error;
  assert.match(refusedError.message, /Only the actor that started this deletion/);
  assert.match(refusedError.message, /remove its delete permission first/);
  assert.equal(JSON.stringify(refused.body).includes(fixture.principal.id), false);

  assert(fixture.auditSink instanceof InMemoryAuditSink);
  const denial = fixture.auditSink.events.findLast(
    (event) => event.kind === "authorization_denial" && event.actorId === other.id,
  );
  assert.ok(denial, "the refusal must be audited");
  assert.equal(denial.authorization?.action, "delete");
  assert.deepEqual(denial.authorization?.resource, {
    kind: "agent",
    id: agent.id,
    namespaceId: namespace.id,
  });
  assert.match(denial.decisionReason ?? "", /initiating actor/);
  assert.equal(denial.details?.initiatingActorId, fixture.principal.id);
});

test("Installation deployment inventory fails closed on incomplete authorization and reports in-flight work", async () => {
  const { controller, fixture, namespace, agent, admitted, deploymentWorks, work } =
    await admittedDeploymentFixture("deployment-inventory", "inventory-agent", {
      recordOperations: true,
    });
  const completedWork = work.record("succeeded", 1);
  assert(fixture.platformState);
  deploymentWorks.set(work.key, completedWork);
  await fixture.platformState.transact((unit) =>
    unit.agents.compareAndSetActiveRevision(namespace.id, agent.id, undefined, admitted.data.id),
  );

  const inventoryPath = "/installation/deployment-inventory";
  const inventory = await controller.request("GET", inventoryPath);
  const inventoryData = checkedInjectedBody(
    inventory,
    200,
    InstallationDeploymentInventoryResponse,
  ).data;
  assert.equal(inventoryData.installationId, fixture.installationId);
  assert.equal(inventoryData.namespaces.length, 2);
  assert.deepEqual(
    inventoryData.namespaces.find((candidate) => candidate.id === namespace.id),
    {
      id: namespace.id,
      status: "ready",
      agents: [
        {
          id: agent.id,
          status: "active",
          desiredRuntimeState: "running",
          executionMode: "embedded",
          activeRevisionId: admitted.data.id,
          deploymentInProgress: false,
          repositoryWorkerRestart: "unknown",
        },
      ],
    },
  );

  // Hold only the external read boundary: the real API and State must detect a new Agent
  // and reauthorize after observation. These checks do not qualify a Driver's disposition.
  const computeDriver: ComputeDriver = fixture.computeDriver;
  const originalDisposition = computeDriver.repositoryWorkerRestartDisposition;
  for (const change of ["new-agent", "authority"]) {
    const observing = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    computeDriver.repositoryWorkerRestartDisposition = async () => {
      observing.resolve();
      await resume.promise;
      return "unknown";
    };
    const pending = controller.request("GET", inventoryPath);
    let restricted = false;
    try {
      await waitForRequestBarrier(observing.promise, pending);
      if (change === "new-agent") {
        await createAgent(controller, namespace.id, "inventory-arrival");
      } else {
        restricted = true;
        fixture.state.restrictions.push({
          id: "deny-inventory-during-observation",
          resourceKind: "installation",
          resourceId: fixture.installationId,
          action: "administer",
          effect: "deny",
        });
      }
      resume.resolve();
      const changed = await pending;
      assert.equal(changed.status, change === "new-agent" ? 503 : 403);
      assert.equal(
        checkedInjectedBody(changed, change === "new-agent" ? 503 : 403, ErrorResponse).error.code,
        change === "new-agent" ? "DEPENDENCY_UNAVAILABLE" : "FORBIDDEN",
      );
    } finally {
      resume.resolve();
      await pending.catch(() => {});
      if (restricted) {
        fixture.state.restrictions.pop();
      }
      if (originalDisposition === undefined) {
        delete computeDriver.repositoryWorkerRestartDisposition;
      } else {
        computeDriver.repositoryWorkerRestartDisposition = originalDisposition;
      }
    }
  }

  // The inventory needs Installation administer, and a complete fleet response must not turn
  // any exact-resource denial into omission.
  for (const restriction of [
    {
      id: "deny-inventory-installation-administer",
      resourceKind: "installation",
      resourceId: fixture.installationId,
      action: "administer",
      effect: "deny",
    },
    {
      id: "deny-inventory-namespace-read",
      namespaceId: namespace.id,
      resourceKind: "namespace",
      resourceId: namespace.id,
      action: "read",
      effect: "deny",
    },
    {
      id: "deny-inventory-agent-read",
      namespaceId: namespace.id,
      resourceKind: "agent",
      resourceId: agent.id,
      action: "read",
      effect: "deny",
    },
    {
      id: "deny-inventory-agent-deploy",
      namespaceId: namespace.id,
      resourceKind: "agent",
      resourceId: agent.id,
      action: "deploy",
      effect: "deny",
    },
    {
      id: "deny-inventory-revision-read",
      namespaceId: namespace.id,
      resourceKind: "agent_revision",
      resourceId: admitted.data.id,
      action: "read",
      effect: "deny",
    },
  ] satisfies Restriction[]) {
    fixture.state.restrictions.push(restriction);
    const denied = await controller.request("GET", inventoryPath);
    assert.equal(denied.status, 403, restriction.id);
    fixture.state.restrictions.pop();
  }

  const { completedAt: _completedAt, ...unfinishedWork } = completedWork;
  const claimedWork = {
    ...unfinishedWork,
    state: "claimed",
    claimToken: "fixture-claim",
    leaseExpiresAt: new Date("2100-01-01T00:00:00.000Z"),
    leaseActive: true,
    ageMs: Date.now() - unfinishedWork.createdAt.getTime(),
  } satisfies ClaimedWork;
  deploymentWorks.set(work.key, claimedWork);
  const inProgress = await controller.request("GET", inventoryPath);
  const inProgressData = checkedInjectedBody(
    inProgress,
    200,
    InstallationDeploymentInventoryResponse,
  ).data;
  const inProgressAgent = inProgressData.namespaces
    .find((candidate) => candidate.id === namespace.id)
    ?.agents.find((candidate) => candidate.id === agent.id);
  assert.equal(inProgressAgent?.deploymentInProgress, true);

  // Work belonging to a different Namespace cannot establish this deployment's state.
  const otherNamespace = inventoryData.namespaces.find(
    (candidate) => candidate.id !== namespace.id,
  );
  assert.ok(otherNamespace);
  deploymentWorks.set(work.key, { ...completedWork, namespaceId: otherNamespace.id });
  const wrongOwner = await controller.request("GET", inventoryPath);
  assertApiError(wrongOwner, 503, "DEPENDENCY_UNAVAILABLE", "wrong-owner deployment work");

  // Missing durable work makes completeness unknowable and must fail the whole operation.
  deploymentWorks.set(work.key, undefined);
  const incomplete = await controller.request("GET", inventoryPath);
  assertApiError(incomplete, 503, "DEPENDENCY_UNAVAILABLE", "missing deployment work");
  assert.deepEqual(Object.keys(checkedInjectedBody(incomplete, 503, ErrorResponse)).sort(), [
    "error",
    "meta",
  ]);
});

test("Installation deployment inventory refuses a revision owned by a different Namespace tuple", async () => {
  const { controller, fixture, namespace, agent, admitted } = await admittedDeploymentFixture(
    "deployment-inventory-tuple",
    "inventory-tuple-agent",
    { recordOperations: true },
  );
  assert(fixture.platformState);
  const revision = await fixture.platformState.read((view) =>
    view.revisions.findRevision(namespace.id, agent.id, admitted.data.id),
  );
  assert.ok(revision);

  // Corrupt in-memory history must not let an orphan operation borrow another
  // Namespace's Agent through an ambiguous serialized owner key.
  await fixture.platformState.transact(async ({ revisions, operations }) => {
    await revisions.createRevision({
      ...revision,
      id: "b\u0000r",
      revision: revision.revision + 1,
    });
    await operations.append({
      kind: "agent_revision",
      action: "reconcile",
      namespaceId: `${namespace.id}\u0000b`,
      resourceId: "r",
      actorId: fixture.principal.id,
    });
  });

  const inventory = await controller.request("GET", "/installation/deployment-inventory");
  assertApiError(inventory, 503, "DEPENDENCY_UNAVAILABLE", "orphan deployment operation");
});
