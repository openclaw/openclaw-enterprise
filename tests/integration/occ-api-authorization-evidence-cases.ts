import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import {
  AgentReadResponse,
  type AgentWire,
  type AuditEvent,
  type NamespaceWire,
  AgentRevisionListResponse,
  AgentRevisionResponse,
  ErrorResponse,
  type AuthorizationRequest,
  type FirstDeploymentReceipt,
} from "../../packages/contracts/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  bindHarnessKey,
  bootstrapInstallation,
  checkedInjectedBody,
  createAgent,
  createNamespace,
  createProvisioningCapableComputeDriver,
  createReadyNamespace,
  injectedRequest,
  identifier,
  type createInjectedControllerFixture,
  type FixtureRequest,
} from "./occ-api-injected-fixture.ts";

type Fixture = Awaited<ReturnType<typeof createInjectedControllerFixture>>;
type ControllerOptions = Pick<
  Parameters<typeof createInjectedControllerFixture>[0],
  "computeDriver" | "recordOperations"
>;
type ConfigureController = (
  options?: ControllerOptions,
) => Promise<{ fixture: Fixture; request: FixtureRequest }>;

const stringifyEvidence: (value: readonly AuditEvent[] | ErrorResponse) => string = JSON.stringify;

function assertDependencyUnavailable(response: Awaited<ReturnType<FixtureRequest>>) {
  const body = checkedInjectedBody(response, 503, ErrorResponse);
  assert.equal(body.error.code, "DEPENDENCY_UNAVAILABLE");
  return body;
}

export function registerBootstrapAuthorizationEvidenceCase(createFixture: () => Promise<Fixture>) {
  test("bootstrap fails closed when IAM omits structured authorization evidence", async (t) => {
    const fixture = await createFixture();
    const { app, iamDriver, auditSink } = fixture;
    assert(auditSink instanceof InMemoryAuditSink);
    // Bootstrap must reject the Driver's malformed reply even when it grants access.
    const untrustedDriver: { authorize(request: AuthorizationRequest): Promise<unknown> } =
      iamDriver;
    t.mock.method(untrustedDriver, "authorize", async () => ({
      allowed: true,
      reason: "Allowed",
      driverId: iamDriver.id,
    }));

    const response = await injectedRequest(app, "POST", "/installation/bootstrap", {
      body: { name: "Must not initialize" },
    });

    assertDependencyUnavailable(response);
    assert.equal(fixture.controller, undefined);
    assert.deepEqual(auditSink.events, []);
  });
}

export function registerAuthorizationDecisionCases(configureController: ConfigureController) {
  test("authorization accepts getter-backed decisions and unrelated function properties", async () => {
    for (const kind of ["getters", "function"]) {
      const controller = await configureController();
      await bootstrapInstallation(controller, "Decision compatibility");
      const { iamDriver } = controller.fixture;
      const originalAuthorize = iamDriver.authorize.bind(iamDriver);
      iamDriver.authorize = async (request) => {
        const decision = await originalAuthorize(request);
        if (kind === "function") {
          return { ...decision, extra: () => {} };
        }

        // The Driver contract allows the decision properties to live on a prototype.
        return new (class {
          get allowed() {
            return decision.allowed;
          }
          get reason() {
            return decision.reason;
          }
          get driverId() {
            return decision.driverId;
          }
          get evidence() {
            return decision.evidence;
          }
        })();
      };
      const namespace = await createNamespace(controller, `decision-compatibility-${kind}`);
      assert.ok(namespace.id);
    }
  });

  test("authorization rejects sparse decision evidence", async () => {
    const controller = await configureController();
    await bootstrapInstallation(controller, "Sparse decision evidence");
    const { iamDriver } = controller.fixture;
    const originalAuthorize = iamDriver.authorize.bind(iamDriver);
    iamDriver.authorize = async (request) => {
      const decision = await originalAuthorize(request);
      if (request.action !== "create") {
        return decision;
      }
      // Sparse arrays can pass checks that visit only occupied entries.
      return { ...decision, evidence: { ...decision.evidence, groupIds: new Array<string>(1) } };
    };
    const response = await controller.request("POST", "/namespaces", {
      body: { name: "sparse-evidence" },
    });
    assertDependencyUnavailable(response);
  });
}

export function registerDeploymentAuthorizationEvidenceCase(
  configureController: ConfigureController,
) {
  test("deploy audit preserves its authorization decision and rolls back with append failure", async () => {
    const computeDriver = createProvisioningCapableComputeDriver();
    const controller = await configureController({ computeDriver, recordOperations: true });
    const { fixture, request } = controller;
    await bootstrapInstallation(controller, "Deploy audit provenance");
    const { controller: occ, iamDriver, auditSink } = fixture;
    assert(occ, "bootstrap must create the controller");
    assert(auditSink instanceof InMemoryAuditSink);
    const namespace = await createReadyNamespace(controller, "deploy-audit-provenance");
    const agent = await createAgent(controller, namespace.id, "decision-bound-agent");
    await bindHarnessKey(fixture, namespace.id, agent);

    const laterIAMDriver = new NativeIAMDriver(
      { loadNativeIAMState: async () => fixture.state },
      { id: "iam-selected-after-deploy-decision" },
    );
    const sharedEvidence = ["matching-restriction"];
    sharedEvidence[Symbol.iterator] = () => ["forged-iterator-value"].values();
    const authorizingDriverId = iamDriver.id;
    const originalAuthorize = iamDriver.authorize.bind(iamDriver);
    iamDriver.authorize = async (request) => {
      const decision = await originalAuthorize(request);
      if (request.action !== "deploy") {
        return decision;
      }
      return {
        ...decision,
        evidence: {
          ...decision.evidence,
          groupIds: sharedEvidence,
          restrictionIds: sharedEvidence,
        },
      };
    };
    const auditCount = auditSink.events.length;

    // Harness validation runs after OCC has checked deploy authorization. Changing
    // Driver selection here proves the audit uses that completed decision.
    computeDriver.validateHarnessAuth = () => {
      if (occ.selectedDriver("iam").id === laterIAMDriver.id) {
        return;
      }
      sharedEvidence.push("mutated-after-authorization");
      occ.registerDriver(laterIAMDriver);
      occ.selectDriver("iam", laterIAMDriver.id);
    };
    const deployed = await request("POST", `/namespaces/${namespace.id}/agents/${agent.id}/deploy`);
    const { data: revision } = checkedInjectedBody(deployed, 202, AgentRevisionResponse);
    assert.equal(sharedEvidence.length, 2);
    assert.equal(sharedEvidence[0], "matching-restriction");
    assert.equal(sharedEvidence[1], "mutated-after-authorization");
    assert.equal(occ.selectedDriver("iam").id, laterIAMDriver.id);
    const deployEvents = auditSink.events
      .slice(auditCount)
      .filter(
        (event) => event.resource.kind === "agent_revision" && event.resource.id === revision.id,
      );
    assert.equal(deployEvents.length, 1);
    const [deployEvent] = deployEvents;
    assert(deployEvent);
    assert.equal(deployEvent.iamDriverId, authorizingDriverId);
    assert.equal(deployEvent.outcome, "success");
    assert.equal(deployEvent.decisionReason, undefined);
    assert.deepEqual(deployEvent.authorization, {
      principalId: fixture.principal.id,
      action: "deploy",
      resource: { kind: "agent", id: agent.id, namespaceId: namespace.id },
    });
    const [adminRole] = fixture.state.roles;
    assert(adminRole);
    assert.deepEqual(deployEvent.details?.iamEvidence, {
      identityId: fixture.principal.id,
      groupIds: ["matching-restriction"],
      bindingIds: ["binding-admin"],
      roleIds: [adminRole.id],
      restrictionIds: ["matching-restriction"],
    });

    const failedAgent = await createAgent(controller, namespace.id, "audit-failure-agent");
    await bindHarnessKey(fixture, namespace.id, failedAgent);
    const failedAgentPath = `/namespaces/${namespace.id}/agents/${failedAgent.id}`;
    const revisionsPath = `${failedAgentPath}/revisions`;
    const revisionsBefore = await request("GET", revisionsPath);
    assert.deepEqual(checkedInjectedBody(revisionsBefore, 200, AgentRevisionListResponse).data, []);
    const workCount = occ.pendingOperations().length;
    const failureAuditCount = auditSink.events.length;
    const originalAppend = auditSink.append;
    const target = { namespaceId: namespace.id, agentId: failedAgent.id };
    const intent = {
      key: "audit-rollback",
      expectedConfigurationId: failedAgent.configurationId,
      expectedGeneration: 1,
    };

    // An audit failure must roll back every write for either deployment operation.
    for (const route of ["deploy", "deploy-first"]) {
      auditSink.append = async () => {
        throw new Error("deploy audit unavailable");
      };
      try {
        const failedDeploy = await request(
          "POST",
          `${failedAgentPath}/${route}`,
          route === "deploy-first" ? { body: intent } : {},
        );
        assertDependencyUnavailable(failedDeploy);
      } finally {
        auditSink.append = originalAppend;
      }

      const recovered: Readonly<FirstDeploymentReceipt> | null =
        await occ.recoverAgentFirstDeployment(fixture.principal.id, target, intent);
      assert.equal(recovered, null, "an audit failure must roll back the guarded receipt");
      const unchangedRevisions = await request("GET", revisionsPath);
      assert.deepEqual(
        checkedInjectedBody(unchangedRevisions, 200, AgentRevisionListResponse).data,
        [],
      );
      const unchangedAgent = await request("GET", failedAgentPath);
      assert.equal(
        checkedInjectedBody(unchangedAgent, 200, AgentReadResponse).data.desiredRuntimeState,
        "stopped",
      );
      assert.equal(occ.pendingOperations().length, workCount);
      assert.equal(auditSink.events.length, failureAuditCount);
    }
  });
}

export async function prepareAuditMutations(configureController: ConfigureController) {
  const controller = await configureController();
  const { fixture, request } = controller;
  const { auditSink, principal, installationId } = fixture;
  assert(auditSink instanceof InMemoryAuditSink);
  const memoryAuditSink: InMemoryAuditSink = auditSink;
  const originalIAMDriverId = fixture.iamDriver.id;
  await bootstrapInstallation(controller, "Audited installation");
  const namespace = await createNamespace(controller, "audited-namespace");
  const agent = await createAgent(controller, namespace.id, "audited-agent");
  // Beginning deletion is an audited mutation in its own right: it is the
  // record that attributes the teardown to the principal who requested it,
  // and it must exist before any resource is destroyed.
  const deletion = await request("DELETE", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.equal(checkedInjectedBody(deletion, 202, AgentReadResponse).data.status, "deleting");
  const expectedAuditEvents = auditSink.events.length;
  assert.equal((await request("GET", "/installation", { identity: false })).status, 401);
  assert.equal(auditSink.events.length, expectedAuditEvents);

  async function verifyDeniedRequests(targetNamespace: NamespaceWire, targetAgent: AgentWire) {
    const denialApp = fixture.createApp();
    const unauthorized = await injectedRequest(denialApp, "POST", "/namespaces", {
      body: { name: "never-log-this-request-body" },
    });
    assert.equal(unauthorized.status, 403);
    const deletionDenied = await injectedRequest(
      denialApp,
      "DELETE",
      `/namespaces/${targetNamespace.id}/agents/${targetAgent.id}`,
    );
    assert.equal(deletionDenied.status, 403);
  }

  function verifyAttributableAudit(
    driverId: string,
    targetNamespace: NamespaceWire,
    targetAgent: AgentWire,
    mutationEvents: readonly AuditEvent[],
  ) {
    assert.deepEqual(
      mutationEvents.map((event) => [event.kind, event.resource.kind]),
      [
        ["bootstrap", "installation"],
        ["mutation", "namespace"],
        ["mutation", "configuration"],
        ["mutation", "agent"],
        ["mutation", "agent"],
      ],
    );
    for (const event of mutationEvents) {
      assert.equal(event.outcome, "success");
      assert.equal(event.installationId, installationId);
      assert.equal(event.actorId, principal.id);
      assert.equal(event.actor?.principalId, principal.id);
      assert.equal(event.actor?.issuer, principal.issuer);
      assert.equal(event.actor?.subject, principal.subject);
      assert(event.requestId);
      assert.match(event.requestId, identifier("req"));
      assert.equal(typeof event.admissionDecisionId, "string");
      assert.equal(event.source, "occ");
      assert.equal(event.iamDriverId, driverId);
    }
    const expected = (
      action: AuthorizationRequest["action"],
      resource: AuthorizationRequest["resource"],
    ) => ({ principalId: principal.id, action, resource });
    const scoped = (kind: "configuration" | "agent", id: string) => ({
      kind,
      id,
      namespaceId: targetNamespace.id,
    });
    assert.deepEqual(
      mutationEvents.map((event) => event.authorization),
      [
        expected("administer", { kind: "installation", id: installationId }),
        expected("create", { kind: "namespace", id: installationId }),
        expected("create", scoped("configuration", targetNamespace.id)),
        expected("create", scoped("agent", targetNamespace.id)),
        expected("delete", scoped("agent", targetAgent.id)),
      ],
    );
    // Both refusals are audited, so a denied destructive request leaves evidence
    // naming the principal who attempted it.
    const denials = memoryAuditSink.events.filter((event) => event.kind === "authorization_denial");
    assert.equal(denials.length, 2);
    for (const denial of denials) {
      assert.equal(denial.outcome, "denied");
      assert.equal(denial.actor?.principalId, principal.id);
      assert.equal(denial.installationId, installationId);
      assert.equal(denial.reasonCode, "AUTHORIZATION_DENIED");
    }
    assert.deepEqual(
      denials.map((denial) => [denial.authorization?.action, denial.authorization?.resource.kind]),
      [
        ["create", "namespace"],
        ["delete", "agent"],
      ],
    );
    assert.equal(denials[1]?.authorization?.resource.id, targetAgent.id);
    const recorded = stringifyEvidence(memoryAuditSink.events);
    assert.equal(recorded.includes(fixture.session.cookie), false);
    assert.equal(recorded.includes("never-log-this-request-body"), false);
  }
  return {
    fixture,
    originalIAMDriverId,
    namespace,
    agent,
    verifyDeniedRequests,
    verifyAttributableAudit,
  };
}

export async function verifyBootstrapRecovery(
  fixture: Fixture,
  failedBootstrap: Awaited<ReturnType<typeof injectedRequest>>,
) {
  const { auditSink } = fixture;
  assert(auditSink instanceof InMemoryAuditSink);
  assertDependencyUnavailable(failedBootstrap);
  assert.deepEqual(auditSink.events, []);
  assert.equal((await injectedRequest(fixture.app, "GET", "/installation")).status, 404);
  const recoveredBootstrap = await injectedRequest(fixture.app, "POST", "/installation/bootstrap", {
    body: { name: "recovered installation" },
  });
  assert.equal(recoveredBootstrap.status, 201);
}

export async function verifyDependencyFailure(fixture: Fixture, dependency: "audit" | "iam") {
  if (dependency === "audit") {
    const bootstrapResult = await injectedRequest(fixture.app, "POST", "/installation/bootstrap", {
      body: { name: "Failure-injection installation" },
    });
    assert.equal(bootstrapResult.status, 201);
  }
  const audit = dependency === "audit";
  const name = audit ? "must-never-become-visible" : "must-never-be-authorized";
  const prefix = `sk-${dependency}-provider`;
  const originalAppend = fixture.auditSink.append;
  const originalAuthorize = fixture.iamDriver.authorize;
  const fail = async () => {
    throw new Error(`${prefix}-credential-123456789`);
  };
  if (audit) {
    fixture.auditSink.append = fail;
  } else {
    fixture.iamDriver.authorize = fail;
  }
  let response: Awaited<ReturnType<typeof injectedRequest>>;
  try {
    response = await injectedRequest(fixture.app, "POST", "/namespaces", { body: { name } });
  } finally {
    if (audit) {
      fixture.auditSink.append = originalAppend;
    } else {
      fixture.iamDriver.authorize = originalAuthorize;
    }
  }
  const body = assertDependencyUnavailable(response);
  assert.equal(stringifyEvidence(body).includes(prefix), false);
}
