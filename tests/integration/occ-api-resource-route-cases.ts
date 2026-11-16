import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Check } from "typebox/value";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import {
  type AgentWire,
  ErrorResponse,
  type InstallationWire,
  type NamespaceWire,
  type Permission,
} from "../../packages/contracts/src/index.ts";
import { assertApiError } from "../helpers/api-error.mjs";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { assertSameAnswer } from "../helpers/refusal-answers.ts";
import {
  type createInjectedControllerFixture,
  createServiceAccount,
  identifier,
  injectedRequest,
} from "./occ-api-injected-fixture.ts";

type Fixture = Awaited<ReturnType<typeof createInjectedControllerFixture>>;

interface Controller {
  fixture: Fixture;
  request(
    method: string,
    pathname: string,
    options?: Parameters<typeof injectedRequest>[3],
  ): ReturnType<typeof injectedRequest>;
}

interface ControllerSetup {
  configuredController(): Promise<Controller>;
  bootstrap(controller: Controller, name?: string): Promise<InstallationWire>;
  createNamespace(controller: Controller, name: string): Promise<NamespaceWire>;
  createAgent(controller: Controller, namespaceId: string, name: string): Promise<AgentWire>;
  missingRevisionId: string;
}

function resourceId(data: unknown): string {
  assert(data !== null && typeof data === "object" && "id" in data && typeof data.id === "string");
  return data.id;
}

export async function runResourceRoutes({
  configuredController,
  bootstrap,
  defaultNamespace,
  createNamespace,
  createAgent,
  missingRevisionId,
  missingAgentId,
}: ControllerSetup & {
  defaultNamespace(controller: Controller): Promise<NamespaceWire>;
  missingAgentId: string;
}) {
  const controller = await configuredController();
  // Before bootstrap a Preset write, whose grant check runs before its body is read, answers
  // the same not-found as the handler would.
  for (const [method, path] of [
    ["POST", `/namespaces/ns_${randomUUID()}/presets`],
    ["PATCH", `/namespaces/ns_${randomUUID()}/presets/pre_${randomUUID()}`],
  ] as const) {
    const early = await controller.request(method, path, { body: { name: "early", template: {} } });
    assertApiError(early, 404, "NOT_FOUND", method);
  }
  const installation = await bootstrap(controller);

  const singleton = await controller.request("GET", "/installation");
  assert.equal(singleton.status, 200);
  // No Sandbox Driver is selected: Embedded OpenClaw is the one mode admission accepts (#2670).
  assert.deepStrictEqual(singleton.data, {
    ...installation,
    capabilities: { openclaw: { executionModes: ["embedded"] } },
  });
  const bootstrappedDefault = await defaultNamespace(controller);

  const namespace = await createNamespace(controller, "research");
  assert.equal(Object.hasOwn(namespace, "installationId"), false);

  const namespaces = await controller.request("GET", "/namespaces");
  assert.equal(namespaces.status, 200);
  assert.deepEqual(namespaces.data, [bootstrappedDefault, namespace]);

  const namespaceDetail = await controller.request("GET", `/namespaces/${namespace.id}`);
  assert.equal(namespaceDetail.status, 200);
  assert.deepEqual(namespaceDetail.data, namespace);

  const agent = await createAgent(controller, namespace.id, "research-agent");
  assert.equal(Object.hasOwn(agent, "installationId"), false);

  const account = await createServiceAccount(controller.request, namespace.id, "research-account");
  const serviceAccounts = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/service-accounts`,
  );
  assert.equal(serviceAccounts.status, 200);
  assert.deepEqual(serviceAccounts.data, [account]);

  const agents = await controller.request("GET", `/namespaces/${namespace.id}/agents`);
  assert.equal(agents.status, 200);
  assert.deepEqual(agents.data, [agent]);

  const agentDetail = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}`,
  );
  assert.equal(agentDetail.status, 200);
  assert.deepEqual(agentDetail.data, agent);

  const stopped = await controller.request(
    "POST",
    `/namespaces/${namespace.id}/agents/${agent.id}/stop`,
  );
  assert.equal(stopped.status, 202);
  assert(stopped.data !== null && typeof stopped.data === "object");
  assert("desiredRuntimeState" in stopped.data);
  assert.equal(stopped.data.desiredRuntimeState, "stopped");
  assert.equal(resourceId(stopped.data), agent.id);
  const { auditSink } = controller.fixture;
  assert(auditSink instanceof InMemoryAuditSink);
  const stopAudit = auditSink.events
    .filter((event) => event.action === "openclaw.agents.stop")
    .at(-1);
  assert.deepEqual(
    [stopAudit?.kind, stopAudit?.outcome, stopAudit?.resource.id],
    ["mutation", "success", agent.id],
  );

  const deployment = await controller.request(
    "POST",
    `/namespaces/${namespace.id}/agents/${agent.id}/deploy`,
  );
  assertApiError(deployment, 409, "NAMESPACE_NOT_READY");

  const secondDeployment = await controller.request(
    "POST",
    `/namespaces/${namespace.id}/agents/${agent.id}/deploy`,
  );
  assertApiError(secondDeployment, 409, "NAMESPACE_NOT_READY");

  const revisions = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/revisions`,
  );
  assert.equal(revisions.status, 200);
  assert.deepEqual(revisions.data, []);

  const revisionDetail = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/revisions/${missingRevisionId}`,
  );
  assertApiError(revisionDetail, 404, "NOT_FOUND");

  // Deletion is asynchronous: the route admits the request, moves the Agent to
  // deleting and queues teardown. It answers 202 rather than 204 because the
  // Agent and its revisions still exist until the worker finishes.
  assert.equal(agent.status, "active");
  const missingDeletion = await controller.request(
    "DELETE",
    `/namespaces/${namespace.id}/agents/${missingAgentId}`,
  );
  assertApiError(missingDeletion, 404, "NOT_FOUND");

  const deletion = await controller.request(
    "DELETE",
    `/namespaces/${namespace.id}/agents/${agent.id}`,
  );
  assert.equal(deletion.status, 202);
  assert.deepEqual(deletion.data, { ...agent, status: "deleting" });

  // Reads keep returning a deleting Agent, so an operator can observe teardown
  // in progress instead of seeing it vanish before its resources are gone.
  const deletingDetail = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}`,
  );
  assert.equal(deletingDetail.status, 200);
  assert(
    deletingDetail.data !== null &&
      typeof deletingDetail.data === "object" &&
      "status" in deletingDetail.data,
  );
  assert.equal(deletingDetail.data.status, "deleting");

  // A repeated request converges on the in-flight teardown rather than
  // conflicting, so a client retry after a lost response is safe.
  const repeatedDeletion = await controller.request(
    "DELETE",
    `/namespaces/${namespace.id}/agents/${agent.id}`,
  );
  assert.equal(repeatedDeletion.status, 202);
  assert.deepEqual(repeatedDeletion.data, deletion.data);

  // The Agent row survives until teardown completes, so its Namespace is still
  // occupied. Offboarding becomes possible only once the row is removed.
  const stillOccupied = await controller.request("DELETE", `/namespaces/${namespace.id}`);
  assertApiError(stillOccupied, 409, "NAMESPACE_NOT_EMPTY");

  const secondBootstrap = await controller.request("POST", "/installation/bootstrap", {
    body: { name: "another installation" },
  });
  assertApiError(secondBootstrap, 409, "INSTALLATION_EXISTS");

  const installationCollection = await controller.request("POST", "/installations", {
    body: { name: "forbidden collection" },
  });
  assert.equal(installationCollection.status, 404);

  const auditEndpoint = await controller.request("GET", "/audit");
  assert.equal(auditEndpoint.status, 404);

  const unchanged = await controller.request("GET", "/installation");
  assert.deepEqual(unchanged.data, { ...installation, capabilities: singleton.data.capabilities });
}

export async function runBodylessRoutes({
  configuredController,
  bootstrap,
  createNamespace,
  createAgent,
  missingRevisionId,
}: ControllerSetup) {
  const controller = await configuredController();
  const { fixture } = controller;
  await bootstrap(controller, "Bodyless-route installation");
  const { id: namespaceId } = await createNamespace(controller, "bodyless-route-namespace");
  const { id: agentId } = await createAgent(controller, namespaceId, "bodyless-route-agent");

  const { auditSink } = fixture;
  assert(auditSink instanceof InMemoryAuditSink);
  const originalLookup = fixture.iamDriver.lookupIdentity;
  const originalAuthorize = fixture.iamDriver.authorize;
  let identityLookups = 0;
  let authorizationChecks = 0;
  fixture.iamDriver.lookupIdentity = async (...args) => {
    identityLookups += 1;
    return originalLookup.apply(fixture.iamDriver, args);
  };
  fixture.iamDriver.authorize = async (...args) => {
    authorizationChecks += 1;
    return originalAuthorize.apply(fixture.iamDriver, args);
  };
  const auditCount = auditSink.events.length;
  const app = fixture.createApp(fixture.principal, createFastifyApp);

  try {
    const session = app.defaultSession;
    assert.ok(session);
    const headers = authenticatedHeaders(session);
    for (const [method, url] of [
      ["GET", "/installation"],
      ["GET", "/namespaces"],
      ["GET", `/namespaces/${namespaceId}`],
      ["GET", `/namespaces/${namespaceId}/service-accounts`],
      ["GET", `/namespaces/${namespaceId}/agents`],
      ["GET", `/namespaces/${namespaceId}/agents/${agentId}`],
      ["GET", `/namespaces/${namespaceId}/agents/${agentId}/revisions`],
      ["GET", `/namespaces/${namespaceId}/agents/${agentId}/revisions/${missingRevisionId}`],
      ["POST", `/namespaces/${namespaceId}/agents/${agentId}/deploy`],
      ["POST", `/namespaces/${namespaceId}/agents/${agentId}/stop`],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: {
          ...headers,
          "content-type": "application/json",
          host: "console.oce.localhost",
        },
        payload: JSON.stringify({ unexpected: "request body" }),
        remoteAddress: "127.0.0.1",
      });
      const body = response.json<ErrorResponse>();

      assert.equal(response.statusCode, 400, url);
      assert.equal(body.error.code, "INVALID_REQUEST", url);
      assert.match(body.meta.requestId, identifier("req"));
      assert.equal(identityLookups, 0, url);
      assert.equal(authorizationChecks, 0, url);
      assert.equal(auditSink.events.length, auditCount, url);
    }
  } finally {
    fixture.iamDriver.lookupIdentity = originalLookup;
    fixture.iamDriver.authorize = originalAuthorize;
    await app.close();
  }
}

function assertReadError(
  response: Awaited<ReturnType<typeof injectedRequest>>,
  status: number,
  code: ErrorResponse["error"]["code"],
  label: string,
): ErrorResponse {
  assert.equal(response.status, status, label);
  assert.ok(Check(ErrorResponse, response.body), `${label} must return an error envelope`);
  assert.equal(response.body.error.code, code, label);
  assert.equal(response.body.meta.requestId, response.headers.get("x-request-id"), label);
  return response.body;
}

export async function runNamespaceIsolation({
  configuredController,
  bootstrap,
  createNamespace,
  createAgent,
  missingRevisionId,
}: ControllerSetup) {
  const controller = await configuredController();
  await bootstrap(controller);

  const namespaceA = await createNamespace(controller, "namespace-a");
  const namespaceB = await createNamespace(controller, "namespace-b");
  const agentA = await createAgent(controller, namespaceA.id, "private-agent-a");
  const agentB = await createAgent(controller, namespaceB.id, "private-agent-b");

  const listedA = await controller.request("GET", `/namespaces/${namespaceA.id}/agents`);
  const listedB = await controller.request("GET", `/namespaces/${namespaceB.id}/agents`);
  assert.deepEqual(listedA.data, [agentA]);
  assert.deepEqual(listedB.data, [agentB]);

  for (const [method, path, options] of [
    ["GET", `/namespaces/${namespaceB.id}/agents/${agentA.id}`],
    ["POST", `/namespaces/${namespaceB.id}/agents/${agentA.id}/deploy`],
    ["POST", `/namespaces/${namespaceB.id}/agents/${agentA.id}/stop`],
    [
      "PATCH",
      `/namespaces/${namespaceB.id}/agents/${agentA.id}`,
      { body: { configurationId: agentB.configurationId } },
    ],
    ["GET", `/namespaces/${namespaceB.id}/agents/${agentA.id}/revisions`],
    ["GET", `/namespaces/${namespaceB.id}/agents/${agentA.id}/revisions/${missingRevisionId}`],
    ["GET", `/namespaces/${namespaceB.id}/agents/${agentB.id}/revisions/${missingRevisionId}`],
  ] as const) {
    const response = await controller.request(method, path, options);
    assert.ok(
      [403, 404].includes(response.status),
      `${method} ${path} must not expose cross-Namespace resources`,
    );
    const serialized = JSON.stringify(response.body);
    assert.ok(!serialized.includes("private-agent-a"));
    assert.ok(!serialized.includes("namespace-a-only"));
  }

  const original = await controller.request(
    "GET",
    `/namespaces/${namespaceA.id}/agents/${agentA.id}/revisions`,
  );
  assert.deepEqual(original.data, []);

  const scopedController = await configuredController();
  const { fixture } = scopedController;
  await bootstrap(scopedController, "IAM-scoped installation");
  const initialNamespaces = await injectedRequest(fixture.app, "GET", "/namespaces");
  assert.equal(initialNamespaces.status, 200);
  assert(Array.isArray(initialNamespaces.data));
  assert.equal(initialNamespaces.data.length, 1);

  const tenantA = await createNamespace(scopedController, "tenant-a");
  const tenantB = await createNamespace(scopedController, "tenant-b");
  const { id: tenantAId } = tenantA;
  const { id: tenantBId } = tenantB;

  const completeNamespaces = await injectedRequest(fixture.app, "GET", "/namespaces");
  assert.equal(completeNamespaces.status, 200);
  assert.deepEqual(completeNamespaces.data, [...initialNamespaces.data, tenantA, tenantB]);

  // A failed later IAM decision must discard the already-authorized part of the list.
  // Delegate to Native IAM first so a refusal before the list cannot satisfy this control.
  const originalAuthorize = fixture.iamDriver.authorize;
  for (const failureMode of ["exception", "invalid-decision"] as const) {
    const authorizedNamespaceIds: string[] = [];
    const failedNamespaceIds: string[] = [];
    fixture.iamDriver.authorize = async (request) => {
      const decision = await originalAuthorize.call(fixture.iamDriver, request);
      if (
        request.principalId === fixture.principal.id &&
        request.action === "read" &&
        request.resource.kind === "namespace"
      ) {
        if (
          authorizedNamespaceIds.length > 0 &&
          !authorizedNamespaceIds.includes(request.resource.id)
        ) {
          failedNamespaceIds.push(request.resource.id);
          if (failureMode === "exception") {
            throw new Error("Injected Namespace-read failure");
          }
          return { ...decision, driverId: "" };
        }
        if (decision.allowed) {
          authorizedNamespaceIds.push(request.resource.id);
        }
      }
      return decision;
    };
    try {
      const unavailable = await injectedRequest(fixture.app, "GET", "/namespaces");
      assert.equal(authorizedNamespaceIds.length, 1, failureMode);
      assert.equal(failedNamespaceIds.length, 1, failureMode);
      assert.notEqual(failedNamespaceIds[0], authorizedNamespaceIds[0], failureMode);
      const body = assertReadError(unavailable, 503, "DEPENDENCY_UNAVAILABLE", failureMode);
      assert.deepEqual(body.error, {
        code: "DEPENDENCY_UNAVAILABLE",
        message: "A required platform dependency is unavailable.",
      });
    } finally {
      fixture.iamDriver.authorize = originalAuthorize;
    }
    const restoredNamespaces = await injectedRequest(fixture.app, "GET", "/namespaces");
    assert.equal(restoredNamespaces.status, 200, failureMode);
    assert.deepEqual(restoredNamespaces.data, completeNamespaces.data, failureMode);
  }

  const { id: ownAgentId, configurationId } = await createAgent(
    scopedController,
    tenantBId,
    "tenant-b-agent",
  );

  const { principal: reader } = await fixture.createAuthPrincipal("tenant-b-reader");
  fixture.state.identities.push(reader);
  fixture.state.roles.push({
    id: "role-tenant-b-reader",
    namespaceId: tenantBId,
    permissions: [
      { action: "read", resourceKind: "namespace" },
      { action: "read", resourceKind: "agent" },
      { action: "read", resourceKind: "agent_revision" },
    ],
  });
  fixture.state.bindings.push({
    id: "binding-tenant-b-reader",
    namespaceId: tenantBId,
    subjectKind: "identity",
    subjectId: reader.id,
    roleId: "role-tenant-b-reader",
  });
  const readerApp = fixture.createApp(reader);

  const visibleNamespaces = await injectedRequest(readerApp, "GET", "/namespaces");
  assert.equal(visibleNamespaces.status, 200);
  assert(Array.isArray(visibleNamespaces.data));
  assert.deepEqual(visibleNamespaces.data.map(resourceId), [tenantBId]);

  const installationDenied = await injectedRequest(readerApp, "GET", "/installation");
  assertReadError(installationDenied, 403, "FORBIDDEN", "Namespace reader's Installation read");

  const visibleAgent = await injectedRequest(
    readerApp,
    "GET",
    `/namespaces/${tenantBId}/agents/${ownAgentId}`,
  );
  assert.equal(visibleAgent.status, 200);

  const { principal: revisionReader } = await fixture.createAuthPrincipal("revision-only-reader");
  fixture.state.identities.push(revisionReader);
  const revisionReaderPermissions: Permission[] = [
    { action: "read", resourceKind: "agent_revision" },
  ];
  fixture.state.roles.push({
    id: "role-revision-only-reader",
    namespaceId: tenantBId,
    permissions: revisionReaderPermissions,
  });
  fixture.state.bindings.push({
    id: "binding-revision-only-reader",
    namespaceId: tenantBId,
    subjectKind: "identity",
    subjectId: revisionReader.id,
    roleId: "role-revision-only-reader",
  });
  const revisionReaderApp = fixture.createApp(revisionReader);
  const ownRevisionPath = `/namespaces/${tenantBId}/agents/${ownAgentId}/revisions/${missingRevisionId}`;

  // A revision grant lets the reader request a revision without exposing its parent Agent.
  await assertSameAnswer(
    async (agentId) => {
      const path = `/namespaces/${tenantBId}/agents/${agentId}`;
      const denied = await injectedRequest(revisionReaderApp, "GET", path);
      assertReadError(denied, 403, "FORBIDDEN", path);
      return denied;
    },
    [ownAgentId, `agt_${randomUUID()}`],
    { label: "Agent detail for a revision-only reader" },
  );

  const exactRevision = await injectedRequest(revisionReaderApp, "GET", ownRevisionPath);
  assertReadError(exactRevision, 404, "NOT_FOUND", "authorized missing revision");

  // The reader holds no grant in tenant A, so the misplaced parent is refused before any
  // lookup, as getAgent does; a 404 here would confirm which Agents tenant A lacks.
  const wrongParent = await injectedRequest(
    revisionReaderApp,
    "GET",
    `/namespaces/${tenantAId}/agents/${ownAgentId}/revisions/${missingRevisionId}`,
  );
  assertReadError(wrongParent, 403, "FORBIDDEN", "revision under another Namespace");

  revisionReaderPermissions.length = 0;
  const deniedRevisionApp = fixture.createApp(revisionReader);
  const deniedRevision = await injectedRequest(deniedRevisionApp, "GET", ownRevisionPath);
  assertReadError(deniedRevision, 403, "FORBIDDEN", "revision read after revocation");
  const { auditSink } = fixture;
  assert(auditSink instanceof InMemoryAuditSink);
  const denialEvent = auditSink.events.at(-1);
  assert(denialEvent);
  assert.equal(denialEvent.kind, "authorization_denial");
  assert.equal(denialEvent.actorId, revisionReader.id);
  assert.equal(denialEvent.action, "openclaw.agent_revisions.read");
  assert.deepEqual(denialEvent.resource, {
    kind: "agent_revision",
    id: missingRevisionId,
    namespaceId: tenantBId,
  });
  assert.deepEqual(denialEvent.authorization, {
    principalId: revisionReader.id,
    action: "read",
    resource: denialEvent.resource,
  });

  const refreshedReaderApp = fixture.createApp(reader);
  const absentNamespaceId = `ns_${randomUUID()}`;
  // An unreadable Namespace must not reveal whether its exact ID exists.
  await assertSameAnswer(
    async (namespaceId) => {
      const path = `/namespaces/${namespaceId}`;
      const denied = await injectedRequest(refreshedReaderApp, "GET", path);
      assertReadError(denied, 403, "FORBIDDEN", path);
      return denied;
    },
    [tenantAId, absentNamespaceId],
    { label: "Namespace detail outside the reader's grant" },
  );

  for (const [method, pathname, options] of [
    ["GET", `/namespaces/${tenantAId}/agents`],
    [
      "POST",
      `/namespaces/${tenantAId}/agents`,
      { body: { name: "unauthorized-agent", configurationId } },
    ],
  ] as const) {
    const denied = await injectedRequest(refreshedReaderApp, method, pathname, options);
    assertReadError(denied, 403, "FORBIDDEN", `${method} ${pathname}`);
  }
  // The administrator can authorize that same absent ID and reach the real lookup.
  const authorizedAbsent = await injectedRequest(
    fixture.app,
    "GET",
    `/namespaces/${absentNamespaceId}`,
  );
  assertReadError(authorizedAbsent, 404, "NOT_FOUND", "authorized missing Namespace");
}
