import assert from "node:assert/strict";
import type { TSchema } from "typebox";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import {
  AgentListResponse,
  AgentReadResponse,
  AgentResponse,
  AgentRevisionReadResponse,
  AgentRevisionResponse,
  ErrorResponse,
} from "../../packages/contracts/src/index.ts";
import { assertApiError } from "../helpers/api-error.ts";
import {
  bindHarnessKey,
  bootstrapInstallation,
  checkedInjectedBody,
  createConfiguration,
  type createInjectedControllerFixture,
  createNamespace,
  type FixtureRequest,
  injectedRequest,
} from "./occ-api-injected-fixture.ts";

type Controller = {
  fixture: Awaited<ReturnType<typeof createInjectedControllerFixture>>;
  request: FixtureRequest;
};
type ConfigureController = (
  options: Parameters<typeof createInjectedControllerFixture>[0],
) => Promise<Controller>;

async function bootstrapChatGptBackend(configure: ConfigureController, id: string) {
  const controller = await configure({
    backends: [
      {
        id,
        type: "chatgpt",
        configuration: {
          workspaceId: "11111111-1111-4111-8111-111111111111",
          apiKeyPath: "/unused-in-api-contract-test",
        },
        drivers: { service_account: "chatgpt-service-accounts" },
      },
    ],
    backendSummaries: [{ id, type: "chatgpt" }],
  });
  await bootstrapInstallation(controller);
  return controller;
}

async function checked<Schema extends TSchema>(
  response: ReturnType<FixtureRequest>,
  status: number,
  schema: Schema,
) {
  return checkedInjectedBody(await response, status, schema);
}

async function prepareAgentCollection(controller: Controller, name: string) {
  const { id: namespaceId } = await createNamespace(controller, name);
  const { id: configurationId } = await createConfiguration(controller, namespaceId);
  const collection = `/namespaces/${namespaceId}/agents`;
  const listAgents = async () =>
    (await checked(controller.request("GET", collection), 200, AgentListResponse)).data;
  const readAgent = async (id: string) =>
    (await checked(controller.request("GET", `${collection}/${id}`), 200, AgentReadResponse)).data;
  return { ...controller, namespaceId, configurationId, collection, listAgents, readAgent };
}

type AgentCollection = Awaited<ReturnType<typeof prepareAgentCollection>>;

function assertCreateDenial(
  auditSink: InMemoryAuditSink,
  requestId: string,
  memberId: string,
  namespaceId: string,
) {
  const events: InMemoryAuditSink["events"] = auditSink.events.filter(
    (event) => event.requestId === requestId,
  );
  assert.equal(events.length, 1, "the denied request emits no success mutation");
  const target = { kind: "agent", id: namespaceId, namespaceId };
  assert.partialDeepStrictEqual(events[0], {
    kind: "authorization_denial",
    action: "openclaw.agents.create",
    actorId: memberId,
    actor: { principalId: memberId },
    outcome: "denied",
    reasonCode: "AUTHORIZATION_DENIED",
    iamDriverId: "iam-integration",
    details: { iamEvidence: { identityId: memberId } },
  });
  assert.deepEqual(events[0]?.resource, target);
  assert.deepEqual(events[0]?.authorization, {
    principalId: memberId,
    action: "create",
    resource: target,
  });
}

async function exerciseMemberSelection({
  fixture,
  namespaceId,
  configurationId,
  collection,
  listAgents,
  readAgent,
}: AgentCollection) {
  const { principal: member } = await fixture.createAuthPrincipal("backend-selector");
  fixture.state.identities.push(member);
  const memberApp = fixture.createApp(member);
  const memberCreate = (name: string, backendId: string) =>
    injectedRequest(memberApp, "POST", collection, { body: { name, configurationId, backendId } });

  assertApiError(await injectedRequest(memberApp, "GET", "/backends"), 403, "FORBIDDEN");
  const beforeDeniedCreates = await listAgents();
  const { platformState, auditSink } = fixture;
  assert(platformState);
  assert(auditSink instanceof InMemoryAuditSink);
  const readCreateState = () =>
    platformState.read(async (unit) => ({
      agents: await unit.agents.listAgents(namespaceId),
      configuration: await unit.configurations.findConfiguration(namespaceId, configurationId),
      roles: await unit.iamPolicy.listRoles(namespaceId),
      accessBindings: await unit.iamPolicy.listAccessBindings(namespaceId),
      servicePrincipals: await unit.iamPolicy.listServicePrincipals(namespaceId),
      operations: await unit.operations.list(),
    }));
  const beforeDeniedState = await readCreateState();
  assert.equal(beforeDeniedState.configuration?.id, configurationId);
  assert.equal(beforeDeniedState.configuration?.namespaceId, namespaceId);

  // Backend existence must not be observable before the caller's exact Agent-create check.
  let firstDenial: ErrorResponse["error"] | undefined;
  const denialRequestIds = new Set<string>();
  for (const backendId of ["openai", "unknown"]) {
    const denied = await memberCreate("denied-backend", backendId);
    const body = checkedInjectedBody(denied, 403, ErrorResponse);
    const {
      error,
      meta: { requestId },
    } = body;
    assert.equal(error.code, "FORBIDDEN", `${backendId}: ${JSON.stringify(body)}`);
    assert.deepEqual(Object.keys(body).sort(), ["error", "meta"]);
    assert.equal(denied.data, undefined);
    if (firstDenial === undefined) {
      firstDenial = error;
    } else {
      assert.deepEqual(error, firstDenial);
    }
    assert.equal(denialRequestIds.has(requestId), false);
    denialRequestIds.add(requestId);

    assertCreateDenial(auditSink, requestId, member.id, namespaceId);
    // A refusal may append its audit event, but cannot change application or IAM State.
    assert.deepEqual(await readCreateState(), beforeDeniedState, backendId);
  }
  assert.deepEqual(await listAgents(), beforeDeniedCreates);

  // Agent creation can select a Backend without permission to list the Installation catalog.
  fixture.state.roles.push({
    id: "role-backend-agent-creator",
    namespaceId,
    permissions: [
      { action: "create", resourceKind: "agent" },
      { action: "read", resourceKind: "configuration" },
    ],
  });
  fixture.state.bindings.push({
    id: "binding-backend-agent-creator",
    namespaceId,
    subjectKind: "identity",
    subjectId: member.id,
    roleId: "role-backend-agent-creator",
  });
  assertApiError(await injectedRequest(memberApp, "GET", "/backends"), 403, "FORBIDDEN");
  const { data: created } = await checked(
    memberCreate("member-selected", "openai"),
    201,
    AgentResponse,
  );
  assert.equal(created.backendId, "openai");
  assert.equal((await readAgent(created.id)).backendId, "openai");

  const beforeUnknownCreate = await listAgents();
  assertApiError(await memberCreate("member-unknown", "unknown"), 404, "NOT_FOUND");
  assert.deepEqual(await listAgents(), beforeUnknownCreate);
}

async function exerciseDraftAndRevisionAssociations({
  fixture,
  request,
  namespaceId,
  configurationId,
  collection,
  listAgents,
  readAgent,
}: AgentCollection) {
  // Read back each draft through the authenticated API to verify that its Backend choice persisted.
  for (const [name, association] of [
    ["omitted", {}],
    ["null", { backendId: null }],
    ["selected", { backendId: "openai" }],
  ] as const) {
    const expected = "backendId" in association ? association.backendId : null;
    const { data: created } = await checked(
      request("POST", collection, {
        body: { name, configurationId, ...association },
      }),
      201,
      AgentResponse,
    );
    assert.equal(created.backendId, expected);
    assert.equal((await readAgent(created.id)).backendId, expected);
  }

  const selected = (await listAgents()).find((agent) => agent.name === "selected");
  assert(selected);
  const target = `${collection}/${selected.id}`;
  const patch = (association: { backendId?: string | null }) =>
    checked(
      request("PATCH", target, { body: { configurationId, ...association } }),
      200,
      AgentResponse,
    );
  const deploy = () => checked(request("POST", `${target}/deploy`), 202, AgentRevisionResponse);

  assert.equal((await patch({})).data.backendId, "openai");
  await fixture.markNamespaceReady(namespaceId);
  await bindHarnessKey(fixture, namespaceId, selected);
  const { data: revision } = await deploy();
  assert.equal(revision.backendId, "openai");
  assert.equal((await patch({ backendId: null })).data.backendId, null);
  const { data: prior } = await checked(
    request("GET", `${target}/revisions/${revision.id}`),
    200,
    AgentRevisionReadResponse,
  );
  assert.equal(prior.backendId, "openai", "draft changes cannot rewrite admitted revisions");
  assert.equal((await deploy()).data.backendId, null);

  for (const backendId of ["", " ", "unknown", 42, [], {}]) {
    const expectedStatus = backendId === "unknown" ? 404 : 400;
    const invalid = await request("POST", collection, {
      body: { name: "invalid-provider", configurationId, backendId },
    });
    assert.equal(invalid.status, expectedStatus, JSON.stringify(invalid.body));
    const invalidPatch = await request("PATCH", target, { body: { configurationId, backendId } });
    assert.equal(invalidPatch.status, expectedStatus, JSON.stringify(invalidPatch.body));
  }
  assert.equal((await readAgent(selected.id)).backendId, null);
  assert.equal((await patch({ backendId: "openai" })).data.backendId, "openai");
}

export async function runBackendAssociations(configure: ConfigureController) {
  const controller = await bootstrapChatGptBackend(configure, "openai");
  const backends = await controller.request("GET", "/backends");
  assert.equal(backends.status, 200);
  assert.deepEqual(backends.data, [{ id: "openai", type: "chatgpt" }]);
  assert.doesNotMatch(JSON.stringify(backends.body), /apiKey|workspaceId|credential|drivers|path/i);

  const agents = await prepareAgentCollection(controller, "provider-api");
  await exerciseMemberSelection(agents);
  await exerciseDraftAndRevisionAssociations(agents);
}

export async function runBackendIdCharacterRule(configure: ConfigureController) {
  // 200 code points (395 UTF-16 units) with interior whitespace: the API schema accepts it,
  // so OCC must accept it as configuration and the state store must save it.
  const id = `open\u00a0${"😀".repeat(195)}`;
  const controller = await bootstrapChatGptBackend(configure, id);
  const { request, collection, configurationId, readAgent } = await prepareAgentCollection(
    controller,
    "backend-id-rule",
  );
  const create = (name: string, backendId: string) =>
    request("POST", collection, { body: { name, configurationId, backendId } });
  const created = checkedInjectedBody(await create("long-backend-id", id), 201, AgentResponse);
  assert.equal(created.data.backendId, id);
  const saved = await readAgent(created.data.id);
  assert.equal(saved.backendId, id);

  // 201 code points; DEL and C1 controls (PostgreSQL's [[:cntrl:]] refuses both); line and
  // paragraph separators.
  for (const backendId of [
    "😀".repeat(201),
    "open\u007fai",
    "open\u0085ai",
    "open\u2028ai",
    "open\u2029ai",
  ]) {
    assertApiError(await create("invalid-backend-id", backendId), 400, "INVALID_REQUEST");
  }
}
