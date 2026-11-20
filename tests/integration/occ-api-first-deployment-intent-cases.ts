import assert from "node:assert/strict";
import type { TestContext } from "node:test";

import type { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import {
  AgentRevisionResponse,
  ConfigurationResponse,
  FirstDeploymentReceiptResponse,
  type FirstDeploymentIntent,
} from "../../packages/contracts/src/index.ts";
import { InMemoryPlatformState, type ScopeViolationError } from "../../packages/occ/src/index.ts";
import { assertApiError } from "../helpers/api-error.ts";
import { firstDeploymentFixture } from "./occ-api-first-deployment-fixture.ts";
import {
  bindHarnessKey,
  checkedInjectedBody,
  createAgent,
  type FixtureRequest,
} from "./occ-api-injected-fixture.ts";

type Deployment = Awaited<ReturnType<typeof firstDeploymentFixture>>;
type FixtureResponse = Awaited<ReturnType<FixtureRequest>>;
type Fixture = Parameters<typeof bindHarnessKey>[0];
type Target = { namespaceId: string; agentId: string };
type HostileIdentity = { toJSON(): never };
type MalformedTarget = {
  namespaceId: string | HostileIdentity;
  agentId: string | HostileIdentity;
};
type MalformedIntent =
  | undefined
  | null
  | FirstDeploymentIntent
  | Omit<FirstDeploymentIntent, "key">
  | (Omit<FirstDeploymentIntent, "key"> & { key: null | number })
  | (Omit<FirstDeploymentIntent, "expectedConfigurationId"> & {
      expectedConfigurationId: HostileIdentity;
    });
type InvalidCase = [string, MalformedIntent, MalformedTarget?, string?];
type DirectMethod = "deployAgentFirst" | "recoverAgentFirstDeployment";
type CaptureChange = "stateful key" | "immediate target and generation mutation";

export async function runUnreadyNamespace() {
  const { controller, agent, path, intent, work, secretDriver, providerCalls } =
    await firstDeploymentFixture({ ready: false });
  const before = controller.fixture.auditSink.events.length;
  const result = await controller.request("POST", `${path}/deploy-first`, { body: intent });
  assertApiError(result, 409, "NAMESPACE_NOT_READY");
  const events = controller.fixture.auditSink.events.slice(before);
  assert.equal(events.length, 1);
  assert.deepEqual(
    events.map(({ action, kind, outcome, reasonCode, resource }) => [
      action,
      kind,
      outcome,
      reasonCode,
      resource.id,
    ]),
    [["openclaw.agents.deploy", "mutation", "failure", "NAMESPACE_NOT_READY", agent.id]],
  );
  assert.equal(work().length, 0);
  assert.equal(secretDriver.calls.length, 0);
  assert.equal(providerCalls(), 0);
}

export function malformedIntents(input: Target, intent: FirstDeploymentIntent): InvalidCase[] {
  const { key: _key, ...missingKey } = intent;
  const nonPrimitiveIdentity: HostileIdentity = {
    toJSON() {
      assert.fail("A non-string identity reached digest serialization");
    },
  };
  return [
    ["absent intent", undefined],
    ["null intent", null],
    ["absent key", missingKey],
    ["null key", { ...intent, key: null }],
    ["numeric key", { ...intent, key: 123 }],
    [
      "non-string Agent",
      intent,
      { ...input, agentId: nonPrimitiveIdentity },
      "The exact Agent identity is missing.",
    ],
    [
      "non-string Namespace",
      intent,
      { ...input, namespaceId: nonPrimitiveIdentity },
      "The exact Namespace identity is missing.",
    ],
    [
      "non-string Configuration",
      { ...intent, expectedConfigurationId: nonPrimitiveIdentity },
      input,
      "The exact Configuration identity is missing.",
    ],
  ];
}

export async function expectMalformedRejection(
  t: TestContext,
  prepared: Deployment,
  options: {
    method: DirectMethod;
    target: MalformedTarget;
    malformed: MalformedIntent;
    message: string;
    beforeAudit: number;
  },
  resolveHarness: typeof resolveApprovedHarness,
  ErrorClass: typeof ScopeViolationError,
) {
  const { controller, work, secretDriver, providerCalls } = prepared;
  const { fixture } = controller;
  const state = fixture.platformState;
  const boundaries = [
    t.mock.method(state, "read", () => assert.fail("Invalid intent reached state.read")),
    t.mock.method(state, "transact", () => assert.fail("Invalid intent reached state.transact")),
  ];
  const audit =
    options.method === "deployAgentFirst"
      ? t.mock.fn(() => assert.fail("Invalid intent reached audit"))
      : undefined;
  // These calls deliberately cross the untyped JavaScript boundary with invalid
  // values. Recovery has exactly its three supported arguments; only deploy takes audit.
  const argumentsForCall =
    options.method === "deployAgentFirst"
      ? [fixture.principal.id, options.target, options.malformed, resolveHarness, audit]
      : [fixture.principal.id, options.target, options.malformed];
  const pending: unknown = Reflect.apply(
    fixture.controller[options.method],
    fixture.controller,
    argumentsForCall,
  );
  assert(pending instanceof Promise, "a direct controller call must return a Promise");
  await assert.rejects(pending, (error: unknown) => {
    assert(error instanceof ErrorClass);
    assert.equal(error.message, options.message);
    return true;
  });
  for (const boundary of boundaries) {
    assert.equal(boundary.mock.callCount(), 0);
  }
  if (audit) {
    assert.equal(audit.mock.callCount(), 0);
  }
  assert.equal(secretDriver.calls.length, 0);
  assert.equal(providerCalls(), 0);
  assert.equal(fixture.auditSink.events.length, options.beforeAudit);
  assert.equal(work().length, 0);
}

export async function verifyValidAdmission(
  prepared: Deployment,
  resolveHarness: typeof resolveApprovedHarness,
) {
  const { controller, namespace, agent, intent, listRevisions, work } = prepared;
  const { fixture } = controller;
  const input = { namespaceId: namespace.id, agentId: agent.id };
  const admitted = await fixture.controller.deployAgentFirst(
    fixture.principal.id,
    input,
    intent,
    resolveHarness,
  );
  const revisions = await listRevisions();
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0]?.id, admitted.revisionId);
  assert.equal(work().length, 1);
  assert.deepEqual(
    await fixture.controller.recoverAgentFirstDeployment(fixture.principal.id, input, intent),
    admitted,
  );
  assert.equal(work().length, 1);
}

export function installScalarCapture(
  t: TestContext,
  change: CaptureChange,
  prepared: Deployment,
  missingAgentId: string,
) {
  const { controller, intent } = prepared;
  const occ = controller.fixture.controller;
  const deploy = occ.deployAgentFirst.bind(occ);
  let keyReads = 0;
  // The authenticated handler supplies its normal audit factory. Forward it
  // unchanged while exercising the genuine controller's mutable JS boundary.
  t.mock.method(occ, "deployAgentFirst", (...args: Parameters<typeof deploy>) => {
    const [, input, body] = args;
    if (change === "stateful key") {
      Object.defineProperty(body, "key", {
        get: () => (++keyReads === 1 ? intent.key : 123),
      });
    }
    const pending = deploy(...args);
    if (change !== "stateful key") {
      Reflect.set(input, "agentId", missingAgentId);
      Reflect.set(input, "harnessOverrides", { unsupported: true });
      Reflect.set(body, "expectedGeneration", 2);
    }
    return pending;
  });
  return () => keyReads;
}

export async function assertCapturedAdmission(
  prepared: Deployment,
  response: FixtureResponse,
  beforeAudit: number,
) {
  const { controller, namespace, agent, intent, listRevisions, work } = prepared;
  const { fixture } = controller;
  const actorId = fixture.principal.id;
  const admitted = checkedInjectedBody(response, 202, FirstDeploymentReceiptResponse).data;
  const revisions = await listRevisions();
  assert.equal(revisions.length, 1);
  const revision = revisions[0];
  assert(revision);
  assert.equal(revision.revision, 1);
  assert.deepEqual(admitted, {
    revisionId: revision.id,
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: intent.expectedConfigurationId,
    configurationGeneration: intent.expectedGeneration,
    createdAt: revision.createdAt,
  });
  const queued = work();
  assert.equal(queued.length, 1);
  assert.equal(queued[0]?.resourceId, revision.id);
  assert.equal(queued[0]?.namespaceId, namespace.id);
  assert.equal(queued[0]?.actorId, actorId);
  assert.equal(queued[0]?.action, "reconcile");
  const events = fixture.auditSink.events.slice(beforeAudit);
  assert.equal(events.length, 1);
  const event = events[0];
  assert(event);
  assert.equal(event.actorId, actorId);
  assert(event.actor);
  assert.equal(event.actor.principalId, actorId);
  assert.equal(event.outcome, "success");
  assert.deepEqual(event.resource, {
    kind: "agent_revision",
    id: revision.id,
    namespaceId: namespace.id,
  });
  assert.deepEqual(event.authorization, {
    principalId: actorId,
    action: "deploy",
    resource: { kind: "agent", id: agent.id, namespaceId: namespace.id },
  });
  return { revisions, events };
}

export async function assertFirstDeploymentRecoveryUnchanged(
  prepared: Deployment,
  snapshot: Awaited<ReturnType<typeof assertCapturedAdmission>> & { beforeAudit: number },
) {
  assert.deepEqual(await prepared.listRevisions(), snapshot.revisions);
  assert.equal(prepared.work().length, 1);
  assert.deepEqual(
    prepared.controller.fixture.auditSink.events.slice(snapshot.beforeAudit),
    snapshot.events,
  );
}

export async function runStockDeployRetry(
  controller: { request: FixtureRequest },
  fixture: Fixture,
  namespace: { id: string },
) {
  const agent = await createAgent(controller, namespace.id, "retry-baseline");
  await bindHarnessKey(fixture, namespace.id, agent);
  const state = fixture.platformState;
  assert(state instanceof InMemoryPlatformState, "bootstrap must create in-memory state");
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const revisions = () =>
    state.read((unit) => unit.revisions.listRevisions(namespace.id, agent.id));
  const work = () =>
    state
      .pendingOperations()
      .filter(
        (operation) => operation.kind === "agent_revision" && operation.action === "reconcile",
      );
  assert.equal((await revisions()).length, 0);
  // Discard the response. Inspect the owning store as the test observer, not as the client.
  await controller.request("POST", `${agentPath}/deploy`);
  const [first] = await revisions();
  assert(first, "the first request must commit before its reply is discarded");
  assert.equal(first.revision, 1);
  assert.equal(work().length, 1);
  assert.equal(work()[0]?.resourceId, first.id);
  const retry = checkedInjectedBody(
    await controller.request("POST", `${agentPath}/deploy`),
    202,
    AgentRevisionResponse,
  ).data;
  assert.equal(retry.revision, 2);
  assert.notEqual(retry.id, first.id);
  assert.deepEqual((await revisions())[0], first);
  assert.deepEqual(
    new Set(work().map((operation) => operation.resourceId)),
    new Set([first.id, retry.id]),
  );
  assert.equal(work().length, 2);
}

export async function verifyOrdinaryDeploy(
  prepared: {
    controller: { request: FixtureRequest };
    fixture: Fixture;
    namespace: { id: string };
    agent: { id: string };
    agentPath: string;
  },
  reviewedResponse: FixtureResponse,
  updatedResponse: FixtureResponse,
) {
  const { controller, fixture, namespace, agent, agentPath } = prepared;
  const reviewed = checkedInjectedBody(reviewedResponse, 200, ConfigurationResponse).data;
  const updated = checkedInjectedBody(updatedResponse, 200, ConfigurationResponse).data;
  const state = fixture.platformState;
  assert(state instanceof InMemoryPlatformState, "bootstrap must create in-memory state");
  const rejected = await controller.request("POST", `${agentPath}/deploy`, {
    body: { expectedConfigurationId: reviewed.id, expectedGeneration: reviewed.generation },
  });
  assertApiError(rejected, 400, "INVALID_REQUEST");
  assert.equal(
    (await state.read((unit) => unit.revisions.listRevisions(namespace.id, agent.id))).length,
    0,
  );
  assert.equal(
    state.pendingOperations().filter((operation) => operation.kind === "agent_revision").length,
    0,
  );
  const deployed = checkedInjectedBody(
    await controller.request("POST", `${agentPath}/deploy`),
    202,
    AgentRevisionResponse,
  ).data;
  assert.equal(deployed.configurationId, reviewed.id);
  assert.equal(deployed.configurationGeneration, updated.generation);
  assert.equal(deployed.revision, 1);
  assert("temperature" in deployed.configuration);
  assert.equal(deployed.configuration.temperature, "1");
}
